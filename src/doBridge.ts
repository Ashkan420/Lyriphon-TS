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
} from "./bridge/client";
import { AUTOFETCH_JOB_TIMEOUT_MS, AUTOFETCH_MAX_QUEUE } from "./config";

const DO_STORAGE_SESSION = "bridge:session";
const DO_STORAGE_JOB = "bridge:currentJob";
const DO_STORAGE_QUEUE = "bridge:queue";

type CurrentJob = {
  token: string;
  trackId: number;
  chatId: number;
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
    const body = (await request.json()) as { token: string; trackId: number; chatId: number };
    if (!body?.token || !body?.trackId || !body?.chatId) {
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
      startedAt: Date.now(),
    };
    queue.push(job);
    await this.persistQueue();

    // position = jobs ahead in queue + (1 if something is running now) + 1
    const position = queue.length + (this.processing ? 1 : 0);
    log("BridgeDO: job queued", JSON.stringify({ token: body.token, trackId: body.trackId, position }));

    this.state.waitUntil(this.pump());
    return Response.json({ ok: true, position });
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
      const peer = await this.bridgePeer();
      await this.jobs.fetchTrack(job.trackId, peer, job.token);
      log("BridgeDO: job forwarded", JSON.stringify({ token: job.token }));
    } catch (error: any) {
      const reason = String(error?.message ?? error).slice(0, 200);
      warn("BridgeDO: job failed", JSON.stringify({ token: job.token, reason }));
      // Fail the D1 row and notify the requester directly — no MTProto
      // round-trip (the bridge may be exactly what's broken).
      await this.failRequestDirectly(job.token, reason);
    } finally {
      this.processing = false;
      await this.state.storage.delete(DO_STORAGE_JOB);
      await this.disarmWatchdog();
      // Serial pipeline: kick off the next queued job.
      this.state.waitUntil(this.pump());
    }
  }

  // Mark the audio_requests row failed and tell the requester, via Bot API.
  private async failRequestDirectly(token: string, reason: string): Promise<void> {
    try {
      const { getRequestByToken, isRequestExpired, setRequestStatus } = await import("./db/audioRequests");
      const row = await getRequestByToken(this.env.DB, token);
      if (!row || row.status !== "pending" || isRequestExpired(row)) return;
      await setRequestStatus(this.env.DB, token, "failed");
      if (row.queued_msg_id) {
        try {
          const api = await this.botApi();
          await api.deleteMessage(row.chat_id, row.queued_msg_id);
        } catch (deleteError) {
          warn("BridgeDO: failed to delete queued notice", deleteError);
        }
      }
      const api = await this.botApi();
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
      await (this.state as any).setAlarm(job.startedAt + AUTOFETCH_JOB_TIMEOUT_MS);
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
