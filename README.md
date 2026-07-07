# Lyriphon

A Telegram music bot that turns any song into a shareable **Telegraph** lyrics page — built on **Cloudflare Workers + Durable Objects + D1** with **grammY** (TypeScript).

Search by name, or just send an audio file and let the bot figure out the track. It fetches metadata from **Deezer**, lyrics from **LRCLIB**, and can even **translate** the lyrics into English or Persian (Farsi) on demand using **Gemini**.

---

## Features

### Core flow
- **Two ways to start** — search with `/song <track name>`, or **just send an audio file** and the bot reads the title/artist from the file's tags (or filename) and searches automatically.
- **Song search** — `/song <track name>` searches Deezer and returns a paginated list of matches (5 per page, Previous/Next navigation).
- **Automatic lyrics pages** — generates a [Telegraph](https://telegra.ph) page with cover art, metadata, and lyrics fetched from LRCLIB.
- **Attach to audio** — send a music file and the bot attaches an inline **Lyrics** button linking to the Telegraph page.
- **Send to channels** — forward the tagged file to any channel where the bot is an admin; the bot tracks your channels automatically (via `my_chat_member` updates).
- **Inline mode** — type `@your_bot_name <query>` in any chat to search and share without opening a DM.
- **Metadata & lyrics editing** — edit individual fields (track, artist, album, release date, author, cover URL, track/artist/album links) or rewrite lyrics across multiple messages, then re-publish the page.

### Translation (new — powered by Gemini)
- **In-chat lyric translation** — the **🌐 Translate Lyrics** button opens a language picker (🇬🇧 English / 🇮🇷 فارسی). The bot translates the page and re-publishes it on Telegraph.
- **Smart language detection** — lyrics are analyzed with the [`franc`](https://github.com/wooorm/franc) library plus script-range heuristics (Cyrillic, Arabic, Japanese kana, Korean Hangul, Devanagari, CJK). The bot classifies each song as *single*, *bilingual*, or *multilingual* and warns you if you try to translate into a language the lyrics are already in.
- **Line-aligned output** — translations preserve the exact line count, blank lines, and section labels (`[Verse]`, `[Chorus]`, …) of the original, so the translated page lines up perfectly.
- **Modular translation prompts** — a base set of formatting/philosophy rules is composed with source-language and target-language specific fragments (currently source fragments for Japanese, German, Korean, Spanish, French, Persian; target fragments for English and Farsi).
- **Caching & rate-limit handling** — successful translations are cached per (language + lyrics hash) for the session, and Gemini 429s surface a friendly cooldown countdown with a **Retry** button.
- **Restore original** — a one-tap button reverts the Telegraph page back to the original-language lyrics.

### Farsi → Finglish search (new)
- Persian song titles don't match Deezer's Latin-script index. When you search with `/song`, in inline mode, or type a Farsi query, the bot **transliterates it to Finglish** (phonetic Latin) via Gemini and searches with that, falling back to the original text if there are no results. Finglish results are cached in D1 so repeat searches are free.

### Reliability & operations
- **Owner-only commands** (gated by `BOT_OWNER_ID`):
  - `/session` — dump the current session mode + version.
  - `/debug on|off` — toggle verbose debug logging for the calling user's session.
  - `/multilingual on|off` — toggle whether multilingual songs get extra source-language hints during translation.
- **Per-user sessions via Durable Objects** — each user gets an isolated finite-state session, with versioning to guard against stale async updates. A global error boundary plus `bot.catch` prevents a single failing handler from 500-ing and triggering Telegram retry storms.
- **Scheduled message cleanup** — the Durable Object's alarm deletes transient prompt messages after a delay, keeping chats tidy.
- **Resilient external calls** — LRCLIB and Gemini both use retry/backoff with timeouts; Deezer failures degrade gracefully to "try again later" rather than crashing.

> **License:** AGPL-3.0. Because the bot runs as a network service, the Affero clause requires you to publish the source of any modified version you deploy. See `LICENSE`.

---

## Architecture

```
Telegram ──► Worker fetch (webhook + secret-token check)
                │
                └─► SessionDO (Durable Object, 1 per user)
                       ├─ load/persist session state
                       ├─ scheduleDelete / alarm (cleanup)
                       └─ grammY bot.handleUpdate()
                              ├─ handlers/   (commands, callbacks, audio, inline, channel tracking)
                              ├─ session/    (finite-state machine: types, flows, transitions)
                              ├─ services/
                              │    ├─ deezer.ts        (track/album metadata)
                              │    ├─ lrclib.ts        (plain + retry)
                              │    ├─ telegraph.ts     (page create/edit)
                              │    └─ translation/     (Gemini translation + Finglish + language analysis)
                              ├─ db/         (D1: channels + transliterations)
                              └─ utils/      (retry, URL validation, telegram helpers, logging, md escaping)
```

Webhook routing lives in `src/index.ts`; the bot wiring (commands, callbacks, message/inline/chat-member handlers) lives in `src/bot.ts`; per-user state and the alarm live in `src/do.ts`.

---

## Project structure

```
Lyriphon-TS/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── schema.sql                 # legacy/reference D1 schema (tables are also auto-created at runtime)
├── migrations/
│   └── 0001_channels.sql      # D1 migration: channels table
├── .dev.vars.example          # local dev secrets template
├── src/
│   ├── index.ts               Worker entry; webhook routing + secret check + DO dispatch
│   ├── bot.ts                 grammY bot setup & handler registration
│   ├── do.ts                  SessionDO Durable Object (state, alarm, debug flag)
│   ├── env.ts                 Env interface (bindings + secrets)
│   ├── config.ts              Constants (CHANNEL_LINK, DEEZLOAD_BOT, default webhook path)
│   ├── handlers/              Bot command & callback handlers
│   │    ├── start.ts          /start, /help
│   │    ├── songSearch.ts     /song + pagination
│   │    ├── musicFile.ts      audio-file intake + filename parsing
│   │    ├── callbacks.ts      track pick, edit, channel send, translate
│   │    ├── inlineSearch.ts   @bot inline queries
│   │    └── channelTracker.ts my_chat_member → channel registry
│   ├── services/              External API clients
│   │    ├── deezer.ts
│   │    ├── lrclib.ts
│   │    ├── telegraph.ts
│   │    ├── lyricsFormatter.ts
│   │    └── translation/      Gemini translation engine
│   │         ├── index.ts          translateLyrics() entry
│   │         ├── gemini.ts         Gemini client (model fallback, retry, rate-limit)
│   │         ├── finglish.ts       Farsi→Finglish transliteration + D1 cache
│   │         ├── detect.ts         language flag map
│   │         ├── language-analyzer.ts  franc + script detection → single/bilingual/multilingual
│   │         ├── combine.ts        interleave original + translation line-by-line
│   │         ├── types.ts          supported languages (en, fa)
│   │         └── prompts/          modular base/source/target prompt fragments
│   ├── session/               Session state machine (types, flows, transitions, index)
│   ├── db/                    D1 CRUD (channels, transliterations)
│   └── utils/                 Helpers (retry, urlValidation, telegram, logger, escapeMd)
└── test/                      vitest suite (deezer, finglish, flows, logger, retry, session, transitions, utils)
```

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org) (LTS) and npm
- A [Cloudflare](https://cloudflare.com) account with Workers + D1 + Durable Objects enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Telegraph](https://telegra.ph) access token (create one via the Telegraph API or a helper bot)
- A [Gemini](https://aistudio.google.com/apikey) API key (only required for translation + Finglish)

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
| `BOT_OWNER_ID` | ⬜ | Your Telegram user ID — unlocks `/session`, `/debug`, `/multilingual` |
| `WEBHOOK_PATH` | ⬜ | Webhook route (default `webhook`) |
| `TRANSLATION_PROVIDER` | ⬜ | Translation backend — currently only `gemini` (default) |
| `GEMINI_API_KEY` | ⬜ | Gemini key — enables translation + Farsi→Finglish search |

> Secrets via `wrangler secret put` (below) override `.dev.vars` in production. The translation features simply no-op with a warning if `GEMINI_API_KEY` is absent.

### 3. Create and migrate the D1 database
```bash
npx wrangler d1 create lyriphon_d1
npx wrangler d1 execute lyriphon_d1 --file=schema.sql
```
> Note: `src/db/channels.ts` and `src/db/transliterations.ts` also create their tables lazily at runtime (`CREATE TABLE IF NOT EXISTS`), so the bot works even before `schema.sql` is applied. `migrations/0001_channels.sql` is the D1 migration for the `channels` table.

### 4. Add secrets (production)
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TELEGRAPH_ACCESS_TOKEN
npx wrangler secret put WEBHOOK_SECRET_TOKEN
npx wrangler secret put GEMINI_API_KEY        # if you want translation / Finglish in prod
npx wrangler secret put BOT_OWNER_ID          # if you want owner debug commands in prod
```

### 5. Run locally
```bash
npx wrangler dev
```

### 6. Deploy
```bash
npx wrangler deploy
```

### 7. Set the Telegram webhook
```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook&secret_token=<SECRET>"
```

---

## How it works

There are two entry points that converge on the same flow:

```
  /song <query> ─────────────┐
                             ▼
  send audio file ─► Deezer search ─► pick track ─► LRCLIB lyrics ─► Telegraph page
  (reads tags/filename)                                                   │
                              attach "Lyrics" button to the audio ◄───────┘
                                       │
                              send to your channel(s)
```

When you send an audio file:
- If there's **no active Telegraph page**, the bot parses the title/artist from the file's metadata (falling back to the filename, splitting on `Artist - Title`, `Artist – Title`, or `Artist_-_Title`) and runs a Deezer search right away.
- If a Telegraph page is **already in progress**, it asks what to do: **attach** the file to the current page, **search** using this file instead, or **cancel**.

### Translation flow
1. After a page is created, the bot runs language analysis on the lyrics and stores it in the session.
2. Tap **🌐 Translate Lyrics** → pick 🇬🇧 English or 🇮🇷 فارسی.
3. Gemini translates with strict line-alignment rules; the result is interleaved with the original and re-published to Telegraph.
4. The translation is cached for the session; tap the **Original** button to revert.

External services:
- **Deezer API** — track / album / artist metadata (`src/services/deezer.ts`)
- **LRCLIB API** — plain lyrics, with retry/backoff (`src/services/lrclib.ts`)
- **Telegraph API** — page creation & editing (`src/services/telegraph.ts`)
- **Gemini API** — lyric translation + Farsi→Finglish transliteration (`src/services/translation/`)
- **Cloudflare D1** — channel registry + Finglish translation cache (`src/db/`)

---

## Commands

| Command | Who | Description |
| --- | --- | --- |
| `/start` | all | Welcome message + reset session |
| `/help` | all | List of commands + usage |
| `/song <name>` | all | Search Deezer and build a lyrics page (Farsi titles auto-transliterate to Finglish) |
| `/done` | all | In lyrics-edit mode, finalize (the **Done** button is the canonical path) |
| `/cancel` | all | Cancel an in-progress edit, or clear pending audio state |
| `/session` | owner | Show current session mode + version |
| `/debug on|off` | owner | Toggle verbose debug logging for your session |
| `/multilingual on|off` | owner | Toggle multilingual source hints during translation |

Inline mode (`@your_bot_name <query>`) works in any chat.

---

## Testing

```bash
npm test          # vitest
```
The `test/` directory covers Deezer client, Finglish transliteration, the session finite-state machine (flows + transitions), logging, retry/backoff, and translation utilities.

---

## License

Released under the **GNU Affero General Public License v3.0** (see `LICENSE`). If you self-host a modified version, the AGPL requires you to make its source available to your users.

---

## Configuration notes

- Secrets (`BOT_TOKEN`, `TELEGRAPH_ACCESS_TOKEN`, `WEBHOOK_SECRET_TOKEN`, `GEMINI_API_KEY`, `BOT_OWNER_ID`) are set via `wrangler secret put` (prod) or `.dev.vars` (local).
- `CHANNEL_LINK` and `DEEZLOAD_BOT` are hardcoded constants in `src/config.ts` — update them if you fork.
- `TRANSLATION_PROVIDER` selects the translation backend; only `gemini` is implemented. Without `GEMINI_API_KEY`, translation and Finglish search are skipped gracefully.
- The Durable Object class is named `SessionDO` (see `wrangler.toml`); the D1 binding is `DB` and the DO namespace is `SESSION_DO`.
