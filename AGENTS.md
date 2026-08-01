# AGENTS.md — Lyriphon-TS

Guidance for coding agents working in this repo. Prefer this over guessing; `README.md` is user-facing and partly stale on layout.

## What this is

Telegram music/lyrics bot on **Cloudflare Workers + Durable Objects + D1 + grammY (TypeScript)**.

Flow: `/song` or audio → Deezer search → LRCLIB lyrics → Telegraph page → optional Gemini translation → send to channel.

Repo: https://github.com/Ashkan420/Lyriphon-TS · License: **AGPL-3.0**

## Stack & commands

| Command | Purpose |
| --- | --- |
| `npm install` | deps |
| `npx wrangler dev` | local worker |
| `npx wrangler deploy` | production |
| `npx tsc -p . --noEmit` | **typecheck gate** |
| `npx vitest run` | **test gate** (prefer `run`, not watch) |
| `npm test` | vitest (watch by default) |

No vitest config file — defaults. After a `tsc` build, `rm -rf dist` before tests if you see duplicate/stale suites (compiled `dist/` twins get picked up).

**Gates after non-trivial changes:** both `npx tsc -p . --noEmit` and `npx vitest run` must pass. Ignore isolated tool `tsc` lint noise that can't resolve vitest/worker types — real gate is project `tsc -p .`.

## Architecture (read before behavior changes)

```
Telegram POST /webhook
  → src/index.ts (secret token, extract userId)
  → SESSION_DO.idFromName(userId) → SessionDO.fetch
       blockConcurrencyWhile: load → bot.handleUpdate → persist
  → src/bot.ts (grammY wiring)
  → handlers / session / services / db
```

| Path | Role |
| --- | --- |
| `src/index.ts` | Worker entry, webhook auth, DO routing |
| `src/do.ts` | `SessionDO` — session storage, alarm cleanup, debug flag |
| `src/bot.ts` | Command/callback/message registration; `bot.catch` swallows handler errors |
| `src/env.ts` | `Env` bindings + secrets |
| `src/config.ts` | Constants (timeouts, channel link, etc.) |
| `src/handlers/` | User-facing handlers |
| `src/handlers/callbacks/` | Package: track pick, edit, translate, channel send, logs |
| `src/session/` | FSM: `types`, `flows`, `transitions` (`VALID_TRANSITIONS`, version bump) |
| `src/services/` | Deezer, LRCLIB, Telegraph, translation/ |
| `src/db/` | D1: `channels`, `transliterations`, `lyrics` |
| `src/utils/` | retry, fetch, logger, telegram helpers, URL validation |
| `test/` | vitest unit tests |

### Callbacks package (public API)

`bot.ts` imports from `./handlers/callbacks` (directory barrel). Keep stable:

- `handleCallbackQuery`
- `processTextMessage`

Layout:

- `dispatcher.ts` — router + text capture entry
- `search.ts` — Deezer → LRCLIB → Telegraph → attach
- `audio.ts` — audio decision + send to channel
- `edit.ts` — field/lyrics edit (`MessageBuffer` on `session.lyrics`)
- `translate.ts` — Gemini translate + rate-limit UI
- `logs.ts` — owner log UI callbacks
- `index.ts` — re-exports + shared helpers

Do **not** reintroduce a monolith `handlers/callbacks.ts`.

## Non-negotiable runtime rules

1. **Never re-throw from `SessionDO.fetch`.** A 500 makes Telegram retry the same update forever. Log and return 200. `bot.catch` already swallows handler errors — keep it that way.
2. **Session versioning:** async work must respect `captureVersion` / `isStale` (or equivalent). Don't apply stale results after a newer transition.
3. **Mode transitions** go through `transition()` in `session/transitions.ts`. Don't assign `session.mode` ad hoc unless you know why.
4. **`strictNullChecks` is on** (`strict: true`). Coerce at call sites: `string | null` → `string` with `?? ""` when downstream requires `string` (e.g. lyrics → Telegraph).
5. **Gemini models** in `src/services/translation/gemini.ts`:
   ```ts
   const MODELS = [
     "gemini-3.1-flash-lite",  // active primary — not a typo
     "gemini-2.5-flash",       // documented fallback
     "gemini-flash-latest",    // documented fallback
   ];
   ```
   Do **not** reorder, prune, or "fix" names. User confirmed primary is real.
6. **D1 lyrics cache** (`src/db/lyrics.ts`): key = Deezer `track_id`. Cache **only when lyrics found**. Never cache empty/"not found".
7. **Translation combine** (`combine.ts`): returns `CombineResult | null` (`{ combined, mismatch }`). Mismatch degrades to original + separator + translation; `translate.ts` may retry once. Don't revert to hard-null-on-mismatch.
8. **Owner commands** gated by `BOT_OWNER_ID`: `/admin` (settings panel with debug/multilingual toggles + logs), `/session`, `/debug`, `/logs`, `/multilingual` (and related callbacks).
9. **Optional Gemini:** missing `GEMINI_API_KEY` → translation/Finglish degrade gracefully, don't crash.

## Env / secrets

From `.dev.vars.example` / `Env`:

| Name | Required | Notes |
| --- | :---: | --- |
| `BOT_TOKEN` | yes | Telegram |
| `TELEGRAPH_ACCESS_TOKEN` | yes | pages |
| `WEBHOOK_SECRET_TOKEN` | yes | header check |
| `BOT_OWNER_ID` | no | owner cmds |
| `WEBHOOK_PATH` | no | default `webhook` |
| `TRANSLATION_PROVIDER` | no | only `gemini` |
| `GEMINI_API_KEY` | no | translation + Finglish |
| `DB` | binding | D1 |
| `SESSION_DO` | binding | DO namespace |

Bindings live in `wrangler.toml`. Prod secrets: `wrangler secret put …`.

## Edit flow facts (easy to get wrong)

- `EditFlowData` has only `locked`, `field`, `promptId` — **no** `newValue` / `messageId`.
- Lyrics edits use `session.lyrics.buffer: string[]` + `session.lyrics.messageIds: number[]`.
- Scalar field writes go to `session.telegraph.data` via explicit field handling in `edit.ts` (track/artist/album/date/author + URL fields with `isValidUrl` / `"none"`).

## Translation pipeline

`language-analyzer.ts` (script + franc → single/bilingual/multilingual)
→ prompts (`prompts/base` + sources + targets)
→ `gemini.ts` (model chain, 429 backoff, permanent 400/401/403 bail)
→ `combine.ts` (line-aligned interleave / mismatch fallback)

`franc` is in-memory (~ms). "Fetching lyrics…" delay is **network** (LRCLIB/Telegraph/Deezer), not language detection.

## Testing conventions

- Tests: `test/*.test.ts`, import from `../src/...`.
- Prefer pure-function tests for `combine`, `language-analyzer`, session transitions, utils.
- One small focused test when adding non-trivial logic; don't add CI unless asked (CI was declined).

## Style / change discipline

- Smallest diff that fixes the root cause; reuse existing helpers (`utils/`, `session/flows`, db patterns).
- No new dependencies if a few lines or an existing package works (`grammy`, `franc` only in runtime deps).
- Match local patterns: lazy `ensureTable` in db modules, `warn`/`debug` from `utils/logger`, graceful external-API failure messages.
- Type-only imports where needed (`import type { … } from "@grammyjs/types"` for Telegram types — not always re-exported from `grammy`).
- `findLanguage` / `SUPPORTED_LANGUAGES` / `LanguageCode` live in `services/translation/types.ts`, not `language-analyzer.ts`.

## Out of scope / don't propose unless asked

- GitHub Actions CI
- Reordering/pruning Gemini `MODELS`
- Rewriting the session DO concurrency model
- New translation providers beyond Gemini

## Quick "where do I change X?"

| Goal | Start here |
| --- | --- |
| Webhook / routing | `src/index.ts` |
| New command | `src/bot.ts` + `src/handlers/` |
| Callback button | `src/handlers/callbacks/dispatcher.ts` + domain file |
| Session shape / modes | `src/session/types.ts`, `transitions.ts`, `flows.ts` |
| Deezer / lyrics / page | `services/deezer.ts`, `lrclib.ts`, `telegraph.ts` |
| Translate / Finglish | `services/translation/*` |
| D1 cache/tables | `src/db/*` |
| Timeouts / constants | `src/config.ts` |
| Owner admin panel | `src/handlers/admin.ts` (`/admin`) |
