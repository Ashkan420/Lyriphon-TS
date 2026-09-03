# Deezload auto-fetch bridge

The bridge is **not a separate program** — it runs inside the same Cloudflare
Worker deployment as the bot: a Durable Object (`BridgeDO`, `src/doBridge.ts`)
hosts a teleproto userbot client (the maintained GramJS fork). Nothing to run
on your machine; no VPS.

## How it works

```
Worker (track tap) ──▶ BridgeDO (teleproto user session, serial job queue)
BridgeDO ──/start deezerttrack<id>──▶ @deezload2bot   (MTProto, raw TCP)
deezload ──detail image (skipped), then one audio──▶ BridgeDO
BridgeDO ──forward the audio into the bridge DM──▶ server-side copy (0 bytes through us)
BridgeDO ──reply to it: `lyq:file req=<token>`──▶ bridge DM
Bot webhook ──file_id from reply_to_message──▶ sendAudio(requester) + Lyrics button
```

- **Serial queue:** one deezload request in flight at a time is what
  guarantees the next audio belongs to the current job.
- **No downloads:** both media hops are server-side Telegram copies
  (`messages.forwardMessages` by the userbot, `sendAudio` by file_id from the
  bot), so no file crypto or cross-DC media connections in the Worker.
- **Alarm watchdog:** a DO alarm fails jobs orphaned by eviction after
  `AUTOFETCH_JOB_TIMEOUT_MS`.

## Setup order

1. **Apply the D1 migration** (creates `audio_requests` + `settings`):
   `npx wrangler d1 execute lyriphon_d1 --remote --file migrations/0002_audio_requests_settings.sql`
2. **Secrets** (all via `npx wrangler secret put <name>`):
   - `BRIDGE_CHAT_ID` — numeric Telegram user id of the account that will be
     logged in as the userbot (message @userinfobot from that account). This
     same account must have a DM with the bot (send it any message once).
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — from my.telegram.org → API
     development tools (MTProto app credentials).
3. **Deploy:** `npx wrangler deploy` (the v2 migration registers `BridgeDO`).
4. **Log in — entirely inside Telegram**, as the bot owner:
   - `/bridge_auth <phone>` → Telegram sends a login code
   - `/bridge_code <code>` → completes sign-in (or asks for 2FA)
   - `/bridge_pass <password>` → only if 2FA is enabled
   - `/bridge_status` → session stored / client connected
   The MTProto session string is persisted in the DO's storage and survives
   restarts; login is a one-time step.
5. **Enable:** `/admin` → toggle **🎧 Auto-fetch: ON** (users can opt out
   per-user via `/settings`).
6. **Test:** `/song <name>` → pick a track → the audio arrives in the
   requesting chat ~15–60 s later with the Lyrics button, followed by the
   channel-send prompt if the requester has registered channels.

## The bridge DM (BRIDGE_CHAT_ID)

This is the DM between the userbot account and @Lyriphon_bot. The Worker
intercepts **all** messages from that chat *before* session routing
(`src/index.ts`) and treats them as bridge traffic; only messages tagged with
a pending, unexpired `req_token` trigger delivery. Its id must match the
userbot account's own user id, because the DO logs in as that account and
forwards deezload's audio into its own DM with the bot.

## Notes

- Jobs run through a **persisted FIFO queue** (cap `AUTOFETCH_MAX_QUEUE`,
  default 10). When a job is running, new picks queue behind it and their
  "queued" notice reports the position; the queue-full case answers
  `queue_full` and the D1 row expires via its normal TTL.
- Auto-fetch is gated three ways: the admin global toggle (`/admin`), each
  user's own `/settings` preference (default on), and the three bridge
  secrets being configured. Tracks with a stored `file_id` skip the bridge
  entirely (instant re-send from the tracks store).
- The "🎧 Auto-fetch queued" notice deletes itself when the job reaches a
  terminal state (delivered or failed). Failures notify the requester with
  a `t.me/deezload2bot?start=deezerttrack<id>` fallback link.
- The userbot account should be a spare account: logging in from a
  datacenter IP can, in rare cases, trigger Telegram's security review.
- `wrangler.toml [alias]` maps node builtins teleproto never uses on this
  path (fs, path, os, net, events, util, node-localstorage) to
  `src/bridge/node_shims.ts`, which throws loudly if anything touches them.
  `crypto` and `zlib` are intentionally NOT aliased — workerd's native
  `node:crypto`/`node:zlib` are the real hot paths (AES/hashes; GZIPPacked's
  `unzipSync` for compressed MTProto responses).
- `/bridge_reset` is the escape hatch for a wedged pipeline: it clears the
  auth flow AND expires all pending `audio_requests` (freeing the per-user
  pending cap).
