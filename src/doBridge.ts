// BridgeDO — the deezload auto-fetch worker, running teleproto (a userbot
// MTProto client) inside a Durable Object.
//
// Design rule that keeps the bot responsive: **no HTTP route here ever
// awaits an MTProto round-trip.** Everything slow (connect, handshake,
// sign-in, deezload jobs) runs inside state.waitUntil() and reports back via
// the Bot API directly. A blocked SessionDO (the bot's command handler
// awaiting this DO) gets reset by the runtime — that froze every command in
// the first design.
//
// fetch() routes:
//   POST /auth/start    {phone}            → kicks off signInUser flow
//   POST /auth/code     {code}             → resolves the pending code ask
//   POST /auth/password {password}         → resolves the pending password ask
//   GET  /status                           → cheap, storage-only snapshot
//   POST /enqueue      {token,trackId,chatId} → queue a fetch job
//
// Never throws out of fetch() — callers treat a 500 as "deliver later".

import { Env } from "./env";
import { warn, log } from "./utils/logger";
import {
  BridgeAuth,
  BridgeClient,
  BridgeJobs,
  AuthOutcome,
  isAuthorized,
  sendBridgeText,
} from "./bridge/client";
import { AUTOFETCH_JOB_TIMEOUT_MS, AUTOFETCH_MAX_QUEUE } from "./config";
import { classifyScannedMessage } from "./handlers/migrate";
import { countByStatus, insertScanCandidates, type ScanCandidateInput } from "./db/scanQueue";

// One /migrate history page per job. A whole-channel scan as a single job would
// hold the serial queue for its entire length and starve every music download;
// a page is trivially inside the watchdog budget.
const SCAN_PAGE_LIMIT = 50;

// One line, no whitespace runs: the lyq:scan message is parsed as a single
// line, and Telegram error text arrives with its own newlines and a long
// indented "Please read https://docs…" block that would otherwise truncate the
// reason down to its first word.
function sanitizeReason(reason: string): string {
  // \s+ already covers \r and \n — no separate newline pass needed.
  return String(reason)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const DO_STORAGE_SESSION = "bridge:session";
const DO_STORAGE_JOB = "bridge:currentJob";
const DO_STORAGE_QUEUE = "bridge:queue";

type CurrentJob = {
  token: string;
  trackId: number;
  chatId: number;
  // Set = album-stream job: one deezertalbum command, N audios tagged
  // lyq:albumfile back into the bridge DM.
  albumId?: number;
  // Album jobs only: how many audios deezload will stream (the album's
  // track count). The collector finishes the moment this count arrives
  // instead of waiting out the quiet-period backstop.
  expectedCount?: number;
  // Set = /migrate history-page job: read ONE page of a channel, classify it,
  // write scan_queue rows, and report back with lyq:scan. Distinguished by
  // `kind` rather than by an optional field being present, because the album
  // branch already infers its type from `albumId !== undefined` and a third
  // variant bolted onto that inference would be fragile.
  kind?: "scan";
  scan?: {
    userId: string;
    channelId: string;
    offsetId: number;
    limit: number;
    // How many times FLOOD_WAIT has slowed this page. Bounded so a throttled
    // channel cannot spin inside one job's watchdog budget.
    attempts: number;
  };
  startedAt: number;
};

export class BridgeDO {
  state: DurableObjectState;
  env: Env;
  private bridgeClient: BridgeClient;
  private auth: BridgeAuth;
  private jobs: BridgeJobs;
  private processing = false;
  private queue: CurrentJob[] = [];
  private queueLoaded = false;
  private botUsername: string | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    const apiId = Number(env.TELEGRAM_API_ID ?? 0);
    const apiHash = env.TELEGRAM_API_HASH ?? "";

    const loadSession = async () =>
      (await this.state.storage.get<string>(DO_STORAGE_SESSION)) ?? undefined;
    const saveSession = async (serialized: string) => {
      await this.state.storage.put(DO_STORAGE_SESSION, serialized);
    };

    this.bridgeClient = new BridgeClient(apiId, apiHash, loadSession, saveSession);
    this.auth = new BridgeAuth(this.bridgeClient, apiId, apiHash);
    this.jobs = new BridgeJobs(this.bridgeClient);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/enqueue") {
        return await this.handleEnqueue(request);
      }
      if (request.method === "POST" && url.pathname === "/scan") {
        return await this.handleScan(request, false);
      }
      if (request.method === "POST" && url.pathname === "/scanPage") {
        return await this.handleScan(request, true);
      }
      if (request.method === "POST" && url.pathname === "/auth/start") {
        return await this.handleAuthStart(request);
      }
      if (request.method === "POST" && url.pathname === "/auth/code") {
        return await this.handleAuthDeliver(request, "code");
      }
      if (request.method === "POST" && url.pathname === "/auth/password") {
        return await this.handleAuthDeliver(request, "password");
      }
      if (request.method === "POST" && url.pathname === "/auth/reset") {
        return this.handleAuthReset();
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        return await this.handleFullReset();
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return await this.handleStatus();
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      warn("BridgeDO: fetch error", error);
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    }
  }

  // ── Bot API helpers (the DO talks straight to Telegram) ───────────────────

  private async botApi(): Promise<any> {
    const api = new (await import("grammy")).Api(this.env.BOT_TOKEN);
    return api;
  }

  private async notifyOwnerText(text: string): Promise<void> {
    try {
      const api = await this.botApi();
      const ownerId = this.env.BOT_OWNER_ID;
      if (!ownerId) {
        warn("BridgeDO: BOT_OWNER_ID unset, cannot notify owner");
        return;
      }
      await api.sendMessage(Number(ownerId), text);
    } catch (error) {
      warn("BridgeDO: notifyOwner failed", error);
    }
  }

  // The MTProto side must address the bridge DM by the BOT's username —
  // sending to the account's own user id lands in Saved Messages. Resolved
  // once via getMe and cached for the DO's lifetime.
  private async bridgePeer(): Promise<string> {
    if (this.botUsername) return this.botUsername;
    try {
      const api = await this.botApi();
      const me = await api.getMe();
      this.botUsername = me.username
        ? `@${me.username}`
        : `bot${me.id}`; // bots without usernames use the bot<id> peer form
    } catch (error) {
      warn("BridgeDO: getMe failed, falling back to Lyriphon_Bot", error);
      this.botUsername = "@Lyriphon_bot";
    }
    return this.botUsername;
  }

  // ── Auth routes (fire-and-forget) ──────────────────────────────────────────

  private async handleAuthStart(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { phone?: string };
    const phone = (body.phone ?? "").trim();
    if (!phone) {
      return Response.json({ ok: false, error: "missing phone" });
    }
    if (this.auth.isFlowRunning()) {
      return Response.json({ ok: false, error: "auth flow already in progress" });
    }

    const task = this.auth.beginSignIn(phone, async (outcome) => {
      await this.notifyOwnerText(authOutcomeText(outcome));
    });
    // The connect + sendCode + sign-in round-trips happen in this background
    // task; the owner gets "code sent" / final outcome via Bot API messages.
    this.state.waitUntil(task);
    return Response.json({ ok: true, state: "started" });
  }

  private async handleAuthDeliver(request: Request, kind: "code" | "password"): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as any;
    const value = String(body[kind] ?? "").trim();
    if (!value) {
      return Response.json({ ok: false, error: `missing ${kind}` });
    }
    const delivered = kind === "code"
      ? this.auth.provideCode(value)
      : this.auth.providePassword(value);
    if (!delivered) {
      return Response.json({
        ok: false,
        error: `no ${kind === "code" ? "sign-in flow awaiting a code" : "flow awaiting a password"} — start with /bridge_auth <phone>`,
      });
    }
    return Response.json({ ok: true });
  }

  private handleAuthReset(): Response {
    const wasRunning = this.auth.isFlowRunning();
    this.auth.reset();
    log("BridgeDO: auth flow reset by owner", { wasRunning });
    return Response.json({ ok: true, wasRunning });
  }

  // Owner escape hatch for a wedged pipeline: clear auth state AND expire
  // every pending audio_request so the per-user cap frees up immediately
  // (they'd otherwise block for the full TTL).
  private async handleFullReset(): Promise<Response> {
    const wasRunning = this.auth.isFlowRunning();
    this.auth.reset();
    let expiredRows = 0;
    try {
      const { expireAllPending } = await import("./db/audioRequests");
      expiredRows = await expireAllPending(this.env.DB);
    } catch (error) {
      warn("BridgeDO: expireAllPending failed", error);
    }
    log("BridgeDO: full reset by owner", JSON.stringify({ wasRunning, expiredRows }));
    return Response.json({ ok: true, wasRunning, expiredRows });
  }

  private async handleStatus(): Promise<Response> {
    const session = await this.state.storage.get<string>(DO_STORAGE_SESSION);
    const snapshot = this.auth.snapshot();
    return Response.json({
      ok: true,
      hasSession: Boolean(session),
      flowRunning: snapshot.inFlight,
      hasPhone: snapshot.hasPhone,
      lastState: snapshot.lastState ?? null,
    });
  }

  // ── Job queue (bounded FIFO, persisted) ────────────────────────────────────

  private async loadQueue(): Promise<CurrentJob[]> {
    if (!this.queueLoaded) {
      this.queue = (await this.state.storage.get<CurrentJob[]>(DO_STORAGE_QUEUE)) ?? [];
      this.queueLoaded = true;
    }
    return this.queue;
  }

  private async persistQueue(): Promise<void> {
    await this.state.storage.put(DO_STORAGE_QUEUE, this.queue);
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      token: string;
      trackId: number;
      chatId: number;
      albumId?: number;
      expectedCount?: number;
    };
    // Type checks, not falsy checks: inline rows pass chatId 0 (chatless —
    // delivery edits the inline message instead of DM-sending). albumId set
    // (+ trackId 0) = one album-stream job instead of a single track.
    if (typeof body?.token !== "string" || !body.token
      || typeof body?.trackId !== "number" || !Number.isFinite(body.trackId)
      || typeof body?.chatId !== "number" || !Number.isFinite(body.chatId)) {
      return Response.json({ ok: false, error: "missing fields" });
    }

    const queue = await this.loadQueue();
    if (queue.length >= AUTOFETCH_MAX_QUEUE) {
      log("BridgeDO: queue full, rejecting job", body.token);
      return Response.json({ ok: false, error: "queue_full" });
    }

    const job: CurrentJob = {
      token: body.token,
      trackId: body.trackId,
      chatId: body.chatId,
      albumId: typeof body.albumId === "number" && Number.isFinite(body.albumId) ? body.albumId : undefined,
      expectedCount: typeof body.expectedCount === "number" && Number.isFinite(body.expectedCount) && body.expectedCount > 0
        ? Math.floor(body.expectedCount)
        : undefined,
      startedAt: Date.now(),
    };
    queue.push(job);
    await this.persistQueue();

    // position = jobs ahead in queue + (1 if something is running now) + 1
    const position = queue.length + (this.processing ? 1 : 0);
    log("BridgeDO: job queued", JSON.stringify({ token: body.token, trackId: body.trackId, albumId: job.albumId ?? null, position }));

    this.state.waitUntil(this.pump());
    return Response.json({ ok: true, position });
  }

  // POST /scan (from the beginning) and POST /scanPage (continues at
  // body.offsetId) — contracts/bridge-scan.md §1. Same envelope as /enqueue.
  //
  // `useBodyOffset` is false for /scan so a fresh run always restarts at the
  // newest message; /scanPage passes the resume point the previous page
  // reported back.
  private async handleScan(request: Request, useBodyOffset: boolean): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      userId?: string;
      channelId?: string;
      offsetId?: number;
      limit?: number;
    };
    const userId = typeof body.userId === "string" ? body.userId : "";
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    if (!userId || !channelId) {
      return Response.json({ ok: false, error: "missing fields" });
    }

    // Fail closed. Without a signed-in account the job would throw deep inside
    // MTProto with an opaque error; isAuthorized() already existed and was
    // never called anywhere until now.
    try {
      if (!(await isAuthorized(this.bridgeClient))) {
        return Response.json({ ok: false, error: "unauthorized" });
      }
    } catch (error) {
      warn("BridgeDO: authorization check failed", error);
      return Response.json({ ok: false, error: "unauthorized" });
    }

    const queue = await this.loadQueue();
    if (queue.length >= AUTOFETCH_MAX_QUEUE) {
      return Response.json({ ok: false, error: "queue_full" });
    }

    const limit = typeof body.limit === "number" && body.limit > 0
      ? Math.min(Math.floor(body.limit), SCAN_PAGE_LIMIT)
      : SCAN_PAGE_LIMIT;

    const job: CurrentJob = {
      // No D1 row backs this token — scan failures report via lyq:scan, not
      // failRequestDirectly() (which is entirely audio_requests-shaped).
      token: `scan:${channelId}:${Date.now()}`,
      trackId: 0,
      chatId: 0,
      kind: "scan",
      scan: {
        userId,
        channelId,
        offsetId: useBodyOffset && typeof body.offsetId === "number" && body.offsetId > 0
          ? body.offsetId
          : 0,
        limit,
        attempts: 0,
      },
      startedAt: Date.now(),
    };
    queue.push(job);
    await this.persistQueue();

    log("BridgeDO: scan queued", JSON.stringify({ channelId, offsetId: job.scan?.offsetId }));
    this.state.waitUntil(this.pump());
    return Response.json({ ok: true });
  }

  // Start the next queued job if nothing is running. Serial execution is
  // what keeps deezload's file↔token pairing correct.
  private async pump(): Promise<void> {
    if (this.processing) return;
    const queue = await this.loadQueue();
    const job = queue.shift();
    if (!job) return;
    await this.persistQueue();

    this.processing = true;
    await this.state.storage.put(DO_STORAGE_JOB, job);
    await this.armWatchdog(job);
    log("BridgeDO: job started", JSON.stringify({ token: job.token, trackId: job.trackId }));
    this.state.waitUntil(this.runJob(job));
  }

  private async runJob(job: CurrentJob): Promise<void> {
    try {
      if (job.kind === "scan") {
        // Reports its own outcome through lyq:scan — there is no D1 row for
        // failRequestDirectly() to mark.
        await this.runScanJob(job);
        return;
      }
      const peer = await this.bridgePeer();
      if (job.albumId !== undefined) {
        // Album job: one deezertalbum command; failures are reported per
        // file by the lyq:albumfile stream (an empty stream rejects here,
        // failing the single album row via failRequestDirectly → the album
        // failure path in bridge.ts).
        const count = await this.jobs.fetchAlbum(job.albumId, peer, job.token, job.expectedCount);
        log("BridgeDO: album forwarded", JSON.stringify({ token: job.token, albumId: job.albumId, count }));
      } else {
        await this.jobs.fetchTrack(job.trackId, peer, job.token);
        log("BridgeDO: job forwarded", JSON.stringify({ token: job.token }));
      }
    } catch (error: any) {
      const reason = String(error?.message ?? error).slice(0, 200);
      warn("BridgeDO: job failed", JSON.stringify({ token: job.token, reason }));
      if (job.kind === "scan") {
        await this.reportScan(job, "failed", 0, reason.slice(0, 120));
        return;
      }
      // Fail the D1 row and notify the requester directly — no MTProto
      // round-trip (the bridge may be exactly what's broken).
      await this.failRequestDirectly(job.token, reason);
      // The owner needs the failure visible outside any log viewer: the
      // album batch's own receipt truncates, and BridgeDO console output
      // doesn't reach live tail. Full reason (with diagnostics), capped for
      // the Telegram message limit.
      await this.notifyOwnerText(
        `⚠️ Bridge job failed\n\n` +
        `token: ${job.token}\n` +
        (job.albumId !== undefined ? `album: ${job.albumId}\n` : "") +
        `reason: ${String(error?.message ?? error).slice(0, 3500)}`,
      );
    } finally {
      this.processing = false;
      await this.state.storage.delete(DO_STORAGE_JOB);
      await this.disarmWatchdog();
      // Serial pipeline: kick off the next queued job.
      this.state.waitUntil(this.pump());
    }
  }

  // ── /migrate history page ──────────────────────────────────────────────────

  // Read ONE page of channel history, classify every message, write the
  // qualifying ones to scan_queue, and report back with lyq:scan (contracts §3).
  //
  // Nothing here sleeps or retries: a FLOOD_WAIT is reported instead, and the
  // next page is only requested once the admin has answered the current one —
  // the walk is paced by the admin, which is what FR-009b asks for. Rows are
  // INSERT OR IGNORE on (channel_id, message_id), so a retried page cannot
  // duplicate anything.
  private async runScanJob(job: CurrentJob): Promise<void> {
    const scan = job.scan;
    if (!scan) throw new Error("scan job without payload");

    const page = await this.jobs.fetchHistoryPage(
      scan.channelId,
      scan.offsetId,
      scan.limit,
    );

    if (page.unreachable) {
      log("BridgeDO: scan cannot read channel", JSON.stringify({
        channelId: scan.channelId, reason: page.unreachable,
      }));
      await this.reportScan(job, "failed", 0, page.unreachable);
      return;
    }

    if (page.floodWaitSeconds !== undefined) {
      log("BridgeDO: scan slowed by FLOOD_WAIT", JSON.stringify({
        channelId: scan.channelId,
        seconds: page.floodWaitSeconds,
      }));
      await this.reportScan(job, "failed", 0, `FLOOD_WAIT_${page.floodWaitSeconds}`);
      return;
    }

    const candidates: ScanCandidateInput[] = [];
    let ignored = 0;
    for (const message of page.messages) {
      const verdict = classifyScannedMessage(message);
      if (verdict.kind === "ignore") {
        // FR-011 / FR-012: another author's post, an album, a photo, a video
        // or plain text produces NO row — not even a skipped one.
        ignored += 1;
        continue;
      }
      candidates.push({
        channel_id: scan.channelId,
        user_id: scan.userId,
        message_id: message.messageId,
        has_lyrics_button: verdict.hasLyricsButton,
        existing_url: verdict.existingUrl,
        existing_markup: verdict.existingMarkup,
        title: verdict.title,
        artist: verdict.artist,
        file_name: verdict.fileName,
      });
    }

    await insertScanCandidates(this.env.DB, candidates);

    // Report what is actually LEFT to review, not what this page wrote.
    // `candidates` counts rows attempted, and INSERT OR IGNORE means most were
    // already present on a re-scan — which is why a re-run kept claiming the
    // same "N posts found" after posts had already been handled.
    const { pending } = await countByStatus(
      this.env.DB, scan.userId, scan.channelId,
    ).catch(() => ({ pending: candidates.length, handled: 0, failed: 0 }));

    // A short page means history is exhausted. `nextOffsetId` is null at the
    // end of history, so offset resumes from where this page stopped.
    const status: "done" | "partial" = page.nextOffsetId === null ? "done" : "partial";
    const offset = page.nextOffsetId ?? 0;

    log("BridgeDO: scan page done", JSON.stringify({
      channelId: scan.channelId,
      scanned: page.messages.length,
      recorded: candidates.length,
      pending,
      ignored,
      status,
    }));

    await this.reportScan(job, status, pending, undefined, offset);
  }

  // The one-way reply: a few bytes into the bridge DM. Counts and a resume
  // point only — the messages themselves stay in D1.
  private async reportScan(
    job: CurrentJob,
    status: "done" | "partial" | "failed",
    count: number,
    reason?: string,
    offset = 0,
  ): Promise<void> {
    const scan = job.scan;
    if (!scan) return;

    const text =
      `lyq:scan user=${scan.userId} channel=${scan.channelId}` +
      ` status=${status} count=${count} offset=${offset}` +
      // Collapsed to one line: the receiver parses this as a single line and
      // raw error text arrives with newlines of its own.
      (reason ? ` reason=${sanitizeReason(reason)}` : "");

    try {
      // Sent from the ACCOUNT over MTProto, not by the bot over the Bot API.
      //
      // The whole bridge protocol depends on that direction: a message the bot
      // sends generates no update for the bot, so `handleBridgeUpdate` never
      // runs and the result is delivered to nobody. Every other `lyq:` tag
      // (`lyq:file`, `lyq:albumdone`, `lyq:fail`) is written the same way —
      // account → bot — precisely so the webhook sees it.
      await sendBridgeText(this.bridgeClient, await this.bridgePeer(), text);
    } catch (error) {
      warn("BridgeDO: failed to report scan", error);
    }
  }

  // Mark the audio_requests row failed and tell the requester, via Bot API.
  private async failRequestDirectly(token: string, reason: string): Promise<void> {
    try {
      const { getRequestByToken, isRequestExpired, setRequestStatus } = await import("./db/audioRequests");
      const row = await getRequestByToken(this.env.DB, token);
      if (!row) {
        // Album jobs carry the BATCH token — no audio_requests row exists.
        // Fail the batch (its selected pending rows) and nudge the assembly,
        // which edits the run's status message with the failure receipt.
        const { getAlbumBatch } = await import("./db/albumBatches");
        const batch = await getAlbumBatch(this.env.DB, token);
        if (batch && batch.status === "pending") {
          const { failAlbumBatch } = await import("./handlers/album");
          await failAlbumBatch(this.env, token, reason);
          log("BridgeDO: album job failed, batch failed", JSON.stringify({ token, reason }));
        }
        return;
      }
      if (row.status !== "pending" || isRequestExpired(row)) return;
      await setRequestStatus(this.env.DB, token, "failed");
      // Fresh read for the notice id: it's persisted by the track pipeline
      // after enqueue and can land while this failure is being processed.
      const fresh = await getRequestByToken(this.env.DB, token);
      if (fresh?.queued_msg_id) {
        try {
          const api = await this.botApi();
          await api.deleteMessage(fresh.chat_id, fresh.queued_msg_id);
        } catch (deleteError) {
          warn("BridgeDO: failed to delete queued notice", deleteError);
        }
      }
      const api = await this.botApi();
      // Inline rows (chat_id 0) have no requester chat — surface the failure
      // on the inline message itself.
      if (row.inline_message_id) {
        try {
          await api.editMessageTextInline(
            row.inline_message_id,
            `❌ Couldn't fetch the music file (${reason}). Grab it from deezload: https://t.me/deezload2bot?start=deezerttrack${row.track_id}`,
            row.telegraph_url
              ? { reply_markup: { inline_keyboard: [[{ text: "Lyrics", url: row.telegraph_url }]] } }
              : undefined,
          );
        } catch (editError) {
          warn("BridgeDO: inline failure edit failed", editError);
        }
        return;
      }
      await api.sendMessage(
        row.chat_id,
        `❌ Couldn't fetch this track automatically (${reason}). Grab it from deezload: https://t.me/deezload2bot?start=deezerttrack${row.track_id}`,
      );
    } catch (error) {
      warn("BridgeDO: direct failure report failed", error);
    }
  }

  // ── Watchdog (DO eviction recovery) ─────────────────────────────────────────

  private async armWatchdog(job: CurrentJob): Promise<void> {
    if (typeof (this.state as any).setAlarm === "function") {
      // Album streams legitimately run long (N files, serial, with deezload
      // gaps) — give them a multiple of the per-track budget.
      const budget = job.albumId !== undefined ? AUTOFETCH_JOB_TIMEOUT_MS * 4 : AUTOFETCH_JOB_TIMEOUT_MS;
      await (this.state as any).setAlarm(job.startedAt + budget);
    }
  }

  private async disarmWatchdog(): Promise<void> {
    if (typeof (this.state as any).deleteAlarm === "function") {
      await (this.state as any).deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get<CurrentJob>(DO_STORAGE_JOB);
    if (!job) return; // stale alarm after normal completion
    warn("BridgeDO: watchdog fired for stuck job", JSON.stringify({ token: job.token }));
    this.processing = false;
    await this.state.storage.delete(DO_STORAGE_JOB);
    await this.failRequestDirectly(job.token, "job timeout");
    await this.notifyOwnerText(
      `⏱️ Bridge watchdog killed a stuck job\n\n` +
      `token: ${job.token}\n` +
      (job.albumId !== undefined ? `album: ${job.albumId}\n` : "") +
      `track: ${job.trackId}`,
    );
    // Keep the queue moving after a watchdog kill.
    this.state.waitUntil(this.pump());
  }
}

function authOutcomeText(outcome: AuthOutcome): string {
  switch (outcome.state) {
    case "authorized":
      return `✅ Bridge authorized (${outcome.user}). Auto-fetch can now be enabled in /admin.`;
    case "awaiting_code":
      return "📩 Login code sent. Continue with /bridge_code <code>.";
    case "awaiting_password":
      return "🔒 2FA enabled on this account. Continue with /bridge_pass <password>.";
    case "error":
      return `❌ Bridge auth error: ${outcome.message}`;
  }
}
