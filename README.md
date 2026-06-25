# Lyriphon Workers port

This repository is being migrated to a Cloudflare Workers + grammY TypeScript project at the repository root.

- `src/` contains the Cloudflare Worker source.
- `python/` contains the legacy Python bot runtime and tests for reference.
- D1 is the current storage target for the root project.

---

## Root project layout

```
.
├── package.json
├── tsconfig.json
├── wrangler.toml
├── schema.sql
├── src/
├── test/
├── python/
└── .dev.vars.example
```

---

## Root setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure local vars:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Create and migrate the D1 database:

   ```bash
   npx wrangler d1 create lyriphon_d1
   npx wrangler d1 execute lyriphon_d1 --file=schema.sql
   ```

4. Add secrets:

   ```bash
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put TELEGRAPH_ACCESS_TOKEN
   npx wrangler secret put WEBHOOK_SECRET_TOKEN
   ```

5. Run locally:

   ```bash
   npx wrangler dev
   ```

6. Deploy:

   ```bash
   npx wrangler deploy
   ```

7. Set the Telegram webhook:

   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook&secret_token=<SECRET>"
   ```

---

## Features

- **Two ways to start** — search with `/song <track name>`, or **just send an audio file** and the bot reads the title/artist from the file's tags (or filename) and searches automatically.
- **Song search** — `/song <track name>` searches Deezer and returns a paginated list of matches.
- **Automatic lyrics pages** — generates a [Telegraph](https://telegra.ph) page with cover art, metadata, and lyrics fetched from LRCLIB.
- **Attach to audio** — send a music file and the bot attaches an inline **Lyrics** button linking to the Telegraph page.
- **Send to channels** — forward the tagged file to any channel where the bot is an admin; the bot tracks your channels automatically.
- **Inline mode** — type `@your_bot_name <query>` in any chat to search and share without opening a DM.
- **Metadata & lyrics editing** — edit individual fields (title, artist, album, links, cover) or rewrite lyrics across multiple messages, then re-publish the page.
- **Per-user sessions** — each user has an independent finite-state session, with versioning to guard against stale async updates.

---

## How it works

There are two entry points that converge on the same flow:

```
  /song <query> ─────────────┐
                             ▼
  send audio file ─► Deezer search ─► pick track ─► LRCLIB lyrics ─► Telegraph page
  (reads tags/filename)                                                  │
                              attach "Lyrics" button to the audio ◄───────┘
                                       │
                              send to your channel(s)
```

When you send an audio file:
- If there's **no active Telegraph page**, the bot parses the title/artist from the file's metadata (falling back to the filename, splitting on `Artist - Title`) and runs a Deezer search right away.
- If a Telegraph page is **already in progress**, it asks what to do: **attach** the file to the current page, **search** using this file instead, or **cancel**.

External services:
- **Deezer API** — track / album / artist metadata (`src/services/deezer.ts`)
- **LRCLIB API** — plain & synced lyrics, with retry/backoff (`src/services/lrclib.ts`)
- **Telegraph API** — page creation & editing (`src/services/telegraph.ts`)
- **Cloudflare D1** — stores which channels each user manages

---

## Project structure

```
Lyriphon-TS/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── schema.sql
├── .dev.vars.example
├── src/
│   ├── index.ts              Worker entry; webhook routing
│   ├── bot.ts                grammY bot setup & handler registration
│   ├── do.ts                 SessionDO Durable Object
│   ├── env.ts                Env interface (bindings + secrets)
│   ├── config.ts             Constants
│   ├── session/              Session state machine (types, flows, transitions)
│   ├── handlers/             Bot command & callback handlers
│   ├── services/             External API clients (Deezer, LRCLIB, Telegraph)
│   ├── utils/                Helpers (retry, URL validation, Telegram utils)
│   └── db/                   D1 CRUD (channels)
├── test/                     vitest suite
└── python/                   Legacy Python runtime (reference only)
```

---

## Testing

```bash
npm test
```

---

## Configuration notes

- Secrets (`BOT_TOKEN`, `TELEGRAPH_ACCESS_TOKEN`, `WEBHOOK_SECRET_TOKEN`) are set via `wrangler secret put`.
- `CHANNEL_LINK` and `DEEZLOAD_BOT` are in `src/config.ts` — update them if you fork.
