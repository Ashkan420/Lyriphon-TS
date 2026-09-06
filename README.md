# Lyriphon

A Telegram music bot that turns any song into a shareable **Telegraph** lyrics page — built entirely on **Cloudflare Workers + Durable Objects + D1** with **grammY** (TypeScript).

Search by name, or just send an audio file and let the bot figure out the track. It fetches metadata from **Deezer**, lyrics from **LRCLIB**, can **translate** the lyrics into English or Persian (Farsi) using **Gemini**, and — with the auto-fetch bridge enabled — **delivers the actual audio file** to the requesting chat, fetched through @deezload2bot by a userbot that runs *inside* the same Worker deployment.

---

## Features

### Core flow
- **Two ways to start** — search with `/song <track name>`, **just type the track name** in a DM (plain text behaves like `/song`), or **just send an audio file** and the bot reads the title/artist from the file's tags (or filename) and searches automatically.
- **Song search** — `/song <track name>` searches Deezer and returns a paginated list of matches (5 per page, Previous/Next navigation).
- **Automatic lyrics pages** — generates a [Telegraph](https://telegra.ph) page with cover art, metadata, and lyrics fetched from LRCLIB.
- **Attach to audio** — send a music file and the bot attaches an inline **Lyrics** button linking to the Telegraph page.
- **Track memory** — every song the bot has seen is stored in D1 (`tracks`: title, artist, `file_id`, lyrics). Picking a song the bot already has re-sends the audio **instantly** — no search round-trip, no deezload. If you attach a different file, it becomes the stored one.
- **Send to channels** — forward the tagged file to any channel where the bot is an admin; the bot tracks your channels automatically (via `my_chat_member` updates). This works after both manual attaches *and* auto-fetch deliveries.
- **Inline mode** — type `@your_bot_name <query>` in any chat to search and share without opening a DM.
- **Metadata & lyrics editing** — edit individual fields (track, artist, album, release date, author, cover URL, track/artist/album links) or rewrite lyrics across multiple messages, then re-publish the page.
- **🔄 Refresh AI Summary** — every page edit resets Telegram's AI summary for the page; this button re-triggers it with an invisible touch (no visible change to the page).

### Auto-fetch bridge (deezload, optional)
- **Zero-effort files** — with auto-fetch enabled, picking a track queues a fetch job immediately; the audio arrives in your chat with the Lyrics button attached, ready to forward to a channel.
- **Runs 100% on Cloudflare** — a [teleproto](https://github.com/sanyok12345/teleproto) userbot client lives inside a Durable Object (`BridgeDO`) and talks to @deezload2bot over MTProto. Nothing to host elsewhere. Media never passes through the Worker: the userbot *forwards* deezload's audio and the bot re-sends it by `file_id`.
- **In-Telegram login** — the owner signs the userbot in from the chat itself: `/bridge_auth <phone>` → `/bridge_code <code>` → `/bridge_pass <password>` (2FA). The session persists in DO storage.
- **Fair, serial queue** — jobs run one at a time (that's how the right file gets matched to the right request); concurrent picks queue with a reported position instead of being dropped, with a per-user cap and TTL. The "🎧 Auto-fetch queued" notice deletes itself once the file arrives (or the job fails with a deezload fallback link).
- **Fail-safe by default** — three switches stack: the admin's global toggle (`/admin`), each user's own `/settings` preference, and the `BRIDGE_CHAT_ID` secret being configured at all. Any of them off = no auto-fetch.
- **Already-fetched songs skip the bridge entirely** — the track store serves the file instantly.

### User settings (`/settings`)
- **🎧 Auto-get music files** — opt-out of automatic audio delivery per user (defaults on).
- **🔗 Link previews** — show or hide the preview card under lyrics-page links (defaults on).
- Green/red toggle buttons, plain-language wording. When the admin switch is off globally, the panel says so and the toggle does nothing.

### Translation (powered by Gemini)
- **In-chat lyric translation** — the **🌐 Translate Lyrics** button opens a language picker (🇬🇧 English / 🇮🇷 فارسی). The bot translates the page and re-publishes it on Telegraph.
- **Smart language detection** — lyrics are analyzed with the [`tinyld`](https://github.com/komodev-team/tinyld) language model plus script-range heuristics (Cyrillic, Arabic, Persian markers, Japanese kana, Korean Hangul, Devanagari, CJK, Gurmukhi) and subset-projection second passes for mixed songs. When translating, the target language is excluded from the source analysis, so its text passes through untranslated and the remaining languages drive the prompt. The bot classifies each song as *single*, *bilingual*, or *multilingual* and warns you only if no translatable language remains. No-op responses (the model echoing the lyrics back) are detected and retried automatically with a stronger instruction.
- **Line-aligned output** — translations preserve the exact line count, blank lines, and section labels (`[Verse]`, `[Chorus]`, …) of the original, so the translated page lines up perfectly.
- **Modular translation prompts** — a base set of formatting/philosophy rules is composed with source-language and target-language specific fragments (25+ source languages, targets for English and Farsi).
- **Caching & rate-limit handling** — successful translations are cached per (language + lyrics hash) for the session, and Gemini 429s surface a friendly cooldown countdown with a **Retry** button; generic failures keep a Retry/Cancel keyboard on the message.
- **Restore original** — a one-tap button reverts the Telegraph page back to the original-language lyrics.

### Farsi → Finglish search
- Persian song titles don't match Deezer's Latin-script index. Farsi queries are **transliterated to Finglish** (phonetic Latin) via Gemini and searched with that, falling back to the original text if there are no results. Transliterations are cached in D1 so repeat searches are free.

### Reliability & operations
- **Per-user sessions via Durable Objects** — each user gets an isolated finite-state session, with versioning to guard against stale async updates. A global error boundary prevents a single failing handler from 500-ing and triggering Telegram retry storms.
- **Scheduled message cleanup** — the Durable Object's alarm deletes transient prompt messages after a delay, keeping chats tidy.
- **Resilient external calls** — LRCLIB and Gemini use retry/backoff with timeouts; Deezer failures degrade gracefully to "try again later" rather than crashing.
- **Owner-only tooling** (gated by `BOT_OWNER_ID`, fail-closed): `/admin` settings panel, `/logs`, `/debug`, `/session`, `/multilingual`, plus the bridge login/reset commands.

> **License:** AGPL-3.0. Because the bot runs as a network service, the Affero clause requires you to publish the source of any modified version you deploy. See `LICENSE`.

---

## Architecture

```
Telegram POST /webhook
  ──► Worker fetch (src/index.ts)  — secret-token check
        │
        ├─ bridge chat (userbot account) ──► src/handlers/bridge.ts   (session-free delivery)
        │
        └─ per-user SessionDO (src/do.ts)
              ├─ load/persist session state, alarm cleanup
              └─ grammY bot.handleUpdate()
                     ├─ handlers/   (commands, callbacks, audio, inline, settings, channel tracking)
                     ├─ session/    (finite-state machine)
                     ├─ services/   (deezer, lrclib, telegraph, translation)
                     └─ db/         (D1: tracks, channels, transliterations, settings, audio_requests)

  track pick ──► BridgeDO (src/doBridge.ts, singleton)
                   ├─ teleproto userbot session (persisted in DO storage)
                   ├─ serial FIFO job queue + alarm watchdog
                   └─ MTProto: /start deezerttrack<id> → forward audio → tag it
                         └─► bot webhook delivers file_id + Lyrics button to the requester
```

Webhook routing lives in `src/index.ts` (including the bridge-chat interception, which happens *before* per-user routing); bot wiring lives in `src/bot.ts`; per-user state and the alarm live in `src/do.ts`; the bridge userbot lives in `src/doBridge.ts` + `src/bridge/`. See [bridge/README.md](bridge/README.md) for the bridge's full setup guide.

---

## Project structure

```
Lyriphon-TS/
├── wrangler.toml               # Worker config: bindings, DO migrations, node-builtin aliases
├── schema.sql                  # reference D1 schema (tables are also auto-created at runtime)
├── migrations/                 # applied with `wrangler d1 execute … --file …`
│   ├── 0001_channels.sql
│   ├── 0002_audio_requests_settings.sql
│   ├── 0003_tracks_queued_msg.sql
│   └── 0004_drop_lyrics_cache.sql
├── .dev.vars.example           # local dev secrets template
├── src/
│   ├── index.ts                # Worker entry: webhook auth, bridge interception, DO routing
│   ├── bot.ts                  # grammY setup: commands, callbacks, messages, inline
│   ├── do.ts                   # SessionDO — per-user session, alarm, debug flag
│   ├── doBridge.ts             # BridgeDO — teleproto userbot, job queue, watchdog
│   ├── bridge/                 # teleproto integration
│   │   ├── socket.ts           #   TCP transport over cloudflare:sockets
│   │   ├── client.ts           #   client + auth state machine + deezload jobs
│   │   └── node_shims.ts       #   stubs for node builtins teleproto doesn't use here
│   ├── env.ts                  # Env bindings + secrets
│   ├── config.ts               # Constants (links, timeouts, autofetch limits)
│   ├── handlers/
│   │   ├── start.ts            # /start, /help
│   │   ├── songSearch.ts       # /song + pagination
│   │   ├── musicFile.ts        # audio-file intake + attach/replace/search decision
│   │   ├── settings.ts         # /settings panel (user prefs)
│   │   ├── admin.ts            # /admin panel (owner)
│   │   ├── bridge.ts           # bridge-chat webhook delivery (session-free)
│   │   ├── inlineSearch.ts     # @bot inline queries
│   │   ├── channelTracker.ts   # my_chat_member → channel registry
│   │   └── callbacks/          # dispatcher + track pick, edit, translate, audio, logs
│   ├── services/               # deezer, lrclib, telegraph, lyricsFormatter, translation/
│   ├── session/                # FSM: types, flows, transitions
│   ├── db/                     # D1 CRUD: tracks, channels, transliterations, settings, audioRequests
│   └── utils/                  # retry, fetch, logger, telegram helpers, urlValidation, escapeMd
├── bridge/README.md            # bridge setup & operations guide
└── test/                       # vitest suite
```

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org) (LTS) and npm
- A [Cloudflare](https://cloudflare.com) account with **Workers Paid not required** — free plan works; D1 + Durable Objects enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Telegraph](https://telegra.ph) access token (create one via the Telegraph API or a helper bot)
- A [Gemini](https://aistudio.google.com/apikey) API key (only required for translation + Finglish)
- *(Auto-fetch bridge only)* a spare Telegram **user account** + [my.telegram.org](https://my.telegram.org) API credentials

### 1. Install dependencies
```bash
npm install
```

### 2. Configure local vars
```bash
cp .dev.vars.example .dev.vars
```
Then fill in `.dev.vars`:

| Variable | Required | Purpose |
| :--- | :---: | :--- |
| `BOT_TOKEN` | ✅ | Telegram bot token from BotFather |
| `TELEGRAPH_ACCESS_TOKEN` | ✅ | Telegraph page API token |
| `WEBHOOK_SECRET_TOKEN` | ✅ | Shared secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token` |
| `BOT_OWNER_ID` | ⬜ | Your Telegram user ID — unlocks `/admin` and owner commands |
| `WEBHOOK_PATH` | ⬜ | Webhook route (default `webhook`) |
| `TRANSLATION_PROVIDER` | ⬜ | Translation backend — currently only `gemini` (default) |
| `GEMINI_API_KEY` | ⬜ | Gemini key — enables translation + Farsi→Finglish search |
| `BRIDGE_CHAT_ID` | ⬜ | Auto-fetch bridge: the userbot account's numeric Telegram id |
| `TELEGRAM_API_ID` | ⬜ | Auto-fetch bridge: my.telegram.org API id |
| `TELEGRAM_API_HASH` | ⬜ | Auto-fetch bridge: my.telegram.org API hash |

> Missing optional vars degrade gracefully: no `GEMINI_API_KEY` → translation/Finglish skip with a warning; no bridge vars → auto-fetch is simply unavailable.

### 3. Create and migrate the D1 database
```bash
npx wrangler d1 create lyriphon_d1
npx wrangler d1 execute lyriphon_d1 --remote --file migrations/0001_channels.sql
npx wrangler d1 execute lyriphon_d1 --remote --file migrations/0002_audio_requests_settings.sql
npx wrangler d1 execute lyriphon_d1 --remote --file migrations/0003_tracks_queued_msg.sql
npx wrangler d1 execute lyriphon_d1 --remote --file migrations/0004_drop_lyrics_cache.sql
```
> Most tables are also created lazily at runtime (`CREATE TABLE IF NOT EXISTS`), so the bot tolerates a partially-migrated database — but apply the migrations for the indexes and the one-time lyrics backfill.

### 4. Add secrets (production)
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TELEGRAPH_ACCESS_TOKEN
npx wrangler secret put WEBHOOK_SECRET_TOKEN
npx wrangler secret put GEMINI_API_KEY          # translation / Finglish
npx wrangler secret put BOT_OWNER_ID            # owner commands
# auto-fetch bridge (all three required for it to activate):
npx wrangler secret put BRIDGE_CHAT_ID
npx wrangler secret put TELEGRAM_API_ID
npx wrangler secret put TELEGRAM_API_HASH
```

### 5. Deploy
```bash
npx wrangler deploy
```
The Durable Object migrations (`v1` SessionDO, `v2` BridgeDO) are declared in `wrangler.toml` and apply automatically on deploy.

### 6. Set the Telegram webhook
```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook&secret_token=<SECRET>"
```

### 7. (Optional) Bring up the auto-fetch bridge
Full walkthrough in [bridge/README.md](bridge/README.md). Short version:
1. From the spare account, DM the bot once (so the chat exists) and get the account's numeric id (e.g. from @userinfobot) — that's `BRIDGE_CHAT_ID`.
2. Deploy with the three bridge secrets, then in Telegram as owner: `/bridge_auth <phone>` → `/bridge_code <code>` → `/bridge_pass <password>` until `/bridge_status` shows the session stored.
3. `/admin` → **🎧 Auto-fetch: ON**.

### Local development
```bash
npx wrangler dev
```

---

## How it works

### Core flow
```
  /song <query> ─────────────┐
                             ▼
  send audio file ─► Deezer search ─► pick track ─► LRCLIB lyrics ─► Telegraph page
  (reads tags/filename)                                                   │
                              attach "Lyrics" button to the audio ◄───────┘
                                       │
                              send to your channel(s)
```

- With **auto-fetch on** (and no stored file), the pick also queues a bridge job; the audio arrives shortly after the Telegraph result.
- With a **stored file** for that track, the audio is re-sent immediately from the track store.
- Sending an audio file while a page is active asks what to do: **attach/replace** it on the current page, **search** using this file instead, or **cancel**.

### Auto-fetch flow
```
pick track ─► D1 audio_requests row ─► BridgeDO queue
    BridgeDO: teleproto sends /start deezerttrack<id> to @deezload2bot
    deezload: detail image (skipped) → one audio
    BridgeDO: forwards the audio into the bridge DM + tags it with the job token
    bot webhook: pairs tag ↔ audio, re-sends by file_id with caption + Lyrics button,
                 prompts "Send to which channel?"
```
The serial queue is what guarantees the right file lands with the right request. Failures notify the requester with a `t.me/deezload2bot?start=deezerttrack<id>` fallback link.

### Translation flow
1. After a page is created, the bot runs language analysis on the lyrics and stores it in the session.
2. Tap **🌐 Translate Lyrics** → pick 🇬🇧 English or 🇮🇷 فارسی.
3. Gemini translates with strict line-alignment rules; the result is interleaved with the original and re-published to Telegraph.
4. The translation is cached for the session; tap **Original** to revert.

External services: **Deezer** (metadata), **LRCLIB** (lyrics), **Telegraph** (pages), **Gemini** (translation + Finglish), **Cloudflare D1** (tracks store, channels, settings, request queue, Finglish cache).

---

## Commands

| Command | Who | Description |
| --- | --- | --- |
| `/start` | all | Welcome message + reset session |
| `/help` | all | List of commands + usage |
| `/song <name>` | all | Search Deezer and build a lyrics page (Farsi titles auto-transliterate to Finglish) |
| `/settings` | all | Your preferences: auto-get music files, link previews |
| `/done` | all | In lyrics-edit mode, finalize (the **Done** button is the canonical path) |
| `/cancel` | all | Cancel an in-progress edit, or clear pending audio state |
| `/admin` | owner | Settings panel: debug, multilingual, auto-fetch toggles + logs |
| `/session` | owner | Show current session mode + version |
| `/debug on\|off` | owner | Toggle verbose debug logging for your session |
| `/logs` | owner | Dump recent logs (while debug is on) |
| `/multilingual on\|off` | owner | Toggle multilingual source hints during translation |
| `/bridge_auth <phone>` | owner | Start bridge userbot login |
| `/bridge_code <code>` | owner | Complete login with the code Telegram sent |
| `/bridge_pass <password>` | owner | Complete login when 2FA is enabled |
| `/bridge_status` | owner | Bridge session/queue status |
| `/bridge_reset` | owner | Reset bridge auth + expire pending fetch requests |

Inline mode (`@your_bot_name <query>`) works in any chat.

---

## Testing

```bash
npm test          # vitest (watch)
npx vitest run    # single run — used as the CI-style gate
npx tsc -p . --noEmit   # typecheck gate
```
The `test/` suite covers the Deezer/LRCLIB clients, Finglish, the session FSM, bridge delivery + BridgeDO queue/watchdog, the tracks store, user settings, translation combine, retry/backoff, and utils.

---

## Configuration notes

- Secrets are set via `wrangler secret put` (prod) or `.dev.vars` (local). Owner commands are **disabled for everyone** when `BOT_OWNER_ID` is unset (fail closed).
- The auto-fetch bridge activates only when **all three** of `BRIDGE_CHAT_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` are set *and* the admin toggle is on. See [bridge/README.md](bridge/README.md).
- `CHANNEL_LINK` and `DEEZLOAD_BOT` are hardcoded constants in `src/config.ts` — update them if you fork.
- `TRANSLATION_PROVIDER` selects the translation backend; only `gemini` is implemented.
- `schema.sql` mirrors the D1 tables (`tracks`, `channels`, `transliterations`, `settings`, `audio_requests`); the db modules also create their tables lazily at runtime.
- Durable Object classes: `SessionDO` (per-user sessions) and `BridgeDO` (bridge userbot); bindings `SESSION_DO`, `BRIDGE_DO`, D1 binding `DB` — all in `wrangler.toml`. `wrangler.toml [alias]` maps node builtins teleproto doesn't use to `src/bridge/node_shims.ts`; `crypto`/`zlib` stay native.

---

## License

Released under the **GNU Affero General Public License v3.0** (see `LICENSE`). If you self-host a modified version, the AGPL requires you to make its source available to your users.
