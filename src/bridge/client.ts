// Teleproto client wrapper for the BridgeDO.
//
// Wraps a TelegramClient wired for Workers:
//   - WorkersTcpSocket as the transport (networkSocket param)
//   - StringSession serialized into DO storage (save() hook persists it)
//   - ConnectionTCPFull over raw TCP (port 443; Workers outbound sockets)
//
// Auth is ONE interactive signInUser flow: the phone/code/password callbacks
// resolve when the owner's follow-up commands arrive at the DO (via
// resolver maps here). teleproto's signInUser sends the code itself —
// calling client.sendCode() separately would text TWO codes.
//
// Everything slow here is awaited by BridgeDO inside state.waitUntil(), never
// inside a bot command handler — see doBridge.ts for the fire-and-forget
// HTTP surface.

import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { ConnectionTCPFull } from "teleproto/network/connection";
import { Raw } from "teleproto/events/Raw";
import { WorkersTcpSocket } from "./socket";

export const DEEZLOAD_USERNAME = "deezload2bot";

const DEEZLOAD_AUDIO_TIMEOUT_MS = 180000;
// A hung TCP/handshake must fail loudly instead of wedging the DO forever.
const CONNECT_TIMEOUT_MS = 45000;
const SIGNIN_TOTAL_TIMEOUT_MS = 180000;

export type SessionLoader = () => Promise<string | undefined>;
export type SessionSaver = (serialized: string) => Promise<void>;

export type AuthOutcome =
  | { state: "authorized"; user: string }
  | { state: "awaiting_code" }
  | { state: "awaiting_password" }
  | { state: "error"; message: string };

// ── Client lifecycle ────────────────────────────────────────────────────────

export class BridgeClient {
  private client: TelegramClient | undefined;
  private connecting: Promise<TelegramClient> | undefined;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly loadSession: SessionLoader,
    private readonly saveSession: SessionSaver,
  ) {}

  async get(): Promise<TelegramClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const serialized = await this.loadSession();
      const session = new StringSession(serialized ?? "");
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connection: ConnectionTCPFull,
        networkSocket: WorkersTcpSocket as any,
        useIPV6: false,
        autoReconnect: true,
        connectionRetries: 3,
        requestRetries: 2,
        timeout: 10,
        deviceModel: "LyriphonBridge",
        systemVersion: "workers",
        appVersion: "1.0",
        floodSleepThreshold: 2,
      });

      // Persist the session whenever teleproto saves it (auth key change,
      // DC switch, sign-in). save() is sync in StringSession; forward the
      // serialized value to DO storage without blocking the caller.
      const sessionAny = session as any;
      const origSave = sessionAny.save.bind(session);
      sessionAny.save = () => {
        const out: string = origSave();
        void this.saveSession(out);
        return out;
      };

      client.setLogLevel?.("error" as any);
      // Bounded connect: a hung TCP/MTProto handshake must fail loudly
      // rather than hold the auth flow (and the DO's processing flag) open.
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "teleproto connect timed out");
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (e) {
      this.connecting = undefined;
      throw e;
    }
  }

  // Drop the handle so a subsequent get() reconnects with the fresh session.
  invalidate(): void {
    this.client = undefined;
    this.connecting = undefined;
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.disconnect();
    } catch {}
    this.invalidate();
  }
}

// ── timeout helper ──────────────────────────────────────────────────────────

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Interactive auth flow ───────────────────────────────────────────────────

type Resolver<T> = (value: T) => void;

// One sign-in flow at a time. The callbacks are promises resolved by
// provideCode()/providePassword() when the owner's commands reach the DO.
class AuthFlow {
  private phone?: string;
  private phoneCodeResolver?: Resolver<string>;
  private passwordResolver?: Resolver<string>;
  private phoneCodePromise?: Promise<string>;
  private passwordPromise?: Promise<string>;

  startPhone(phone: string): void {
    this.phone = phone;
  }

  getPhone(): string {
    if (!this.phone) throw new Error("no auth flow started");
    return this.phone;
  }

  takePhoneCodePromise(): Promise<string> {
    if (!this.phoneCodePromise) {
      this.phoneCodePromise = new Promise<string>((resolve) => {
        this.phoneCodeResolver = resolve;
      });
    }
    return this.phoneCodePromise;
  }

  takePasswordPromise(): Promise<string> {
    if (!this.passwordPromise) {
      this.passwordPromise = new Promise<string>((resolve) => {
        this.passwordResolver = resolve;
      });
    }
    return this.passwordPromise;
  }

  provideCode(code: string): boolean {
    if (this.phoneCodeResolver) {
      this.phoneCodeResolver(code);
      return true;
    }
    return false;
  }

  providePassword(password: string): boolean {
    if (this.passwordResolver) {
      this.passwordResolver(password);
      return true;
    }
    return false;
  }

  reset(): void {
    this.phone = undefined;
    this.phoneCodeResolver = undefined;
    this.passwordResolver = undefined;
    this.phoneCodePromise = undefined;
    this.passwordPromise = undefined;
  }
}

export class BridgeAuth {
  private flow = new AuthFlow();
  private flowRunning = false;
  private lastOutcome: AuthOutcome | undefined;
  private codeNotified = false;
  private passwordNotified = false;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {}

  snapshot(): { inFlight: boolean; hasPhone: boolean; lastState?: string } {
    return {
      inFlight: this.flowRunning,
      hasPhone: Boolean((this.flow as any).phone),
      lastState: this.lastOutcome?.state,
    };
  }

  getLastOutcome(): AuthOutcome | undefined {
    return this.lastOutcome;
  }

  /**
   * Kicks off the interactive signInUser flow in the background. teleproto
   * sends the login code itself. `notify` fires with "awaiting_code" the
   * moment teleproto asks for the code (i.e. after the code was sent) and
   * with "awaiting_password" when 2FA is detected; the final outcome
   * (authorized/error) arrives at flow end.
   *
   * Bounded by SIGNIN_TOTAL_TIMEOUT_MS so a hung attempt fails loudly and
   * frees the flow instead of wedging the DO in "in progress" forever.
   *
   * Returns the background task promise — the caller (BridgeDO) must hand it
   * to state.waitUntil() so the runtime keeps the DO alive for it.
   */
  beginSignIn(phone: string, notify: (outcome: AuthOutcome) => Promise<void>): Promise<void> {
    if (this.flowRunning) return Promise.resolve();
    this.flowRunning = true;
    this.codeNotified = false;
    this.passwordNotified = false;
    this.flow = new AuthFlow();
    this.flow.startPhone(phone);

    const task = (async () => {
      try {
        const client = await this.bridge.get();
        if (await client.checkAuthorization()) {
          const outcome: AuthOutcome = { state: "authorized", user: describeMe(client) };
          this.lastOutcome = outcome;
          this.flowRunning = false;
          await notify(outcome);
          return;
        }

        await withTimeout(
          client.signInUser(
            { apiId: this.apiId, apiHash: this.apiHash },
            {
              phoneNumber: () => Promise.resolve(this.flow.getPhone()),
              // First call = the code has just been sent; tell the owner.
              phoneCode: async () => {
                if (!this.codeNotified) {
                  this.codeNotified = true;
                  await notify({ state: "awaiting_code" });
                }
                return this.flow.takePhoneCodePromise();
              },
              password: async () => {
                if (!this.passwordNotified) {
                  this.passwordNotified = true;
                  await notify({ state: "awaiting_password" });
                }
                return this.flow.takePasswordPromise();
              },
              onError: async (_err: Error) => {
                // Returning true aborts the flow; false would retry the ask.
                return true;
              },
            } as any,
          ),
          SIGNIN_TOTAL_TIMEOUT_MS,
          "sign-in flow timed out",
        );

        const outcome: AuthOutcome = (await client.checkAuthorization())
          ? { state: "authorized", user: describeMe(client) }
          : { state: "error", message: "sign-in flow ended without authorization" };
        this.lastOutcome = outcome;
        this.flowRunning = false;
        await notify(outcome);
      } catch (e: any) {
        const outcome: AuthOutcome = { state: "error", message: String(e?.message ?? e) };
        this.lastOutcome = outcome;
        this.flowRunning = false;
        this.flow.reset();
        // A failed/hung connect poisons the cached client — drop it so the
        // next attempt starts fresh.
        this.bridge.invalidate();
        await notify(outcome);
      }
    })();
    return task;
  }

  /** Delivers a login code to the pending flow, if one is waiting. */
  provideCode(code: string): boolean {
    return this.flow.provideCode(code);
  }

  /** Delivers the 2FA password to the pending flow, if one is waiting. */
  providePassword(password: string): boolean {
    return this.flow.providePassword(password);
  }

  isFlowRunning(): boolean {
    return this.flowRunning;
  }

  /**
   * Force-clears a wedged auth flow (hung before its own timeout, e.g. a
   * socket that never resolves). The in-flight background task, if any, is
   * abandoned: its notify calls still fire but outcomes it reports are
   * ignored by the owner because /bridge_reset already confirmed the reset.
   */
  reset(): void {
    this.flowRunning = false;
    this.lastOutcome = { state: "error", message: "reset by owner" };
    this.flow.reset();
    this.bridge.invalidate();
  }
}

function describeMe(client: TelegramClient): string {
  try {
    const me: any = (client as any).session?.currentUser ?? null;
    const name = me?.firstName ?? me?.username;
    return typeof name === "string" && name ? name : "authorized";
  } catch {
    return "authorized";
  }
}

// ── Deezload job interaction ────────────────────────────────────────────────

export type ForwardedAudio = {
  forwardMessageId: number;
};

export class BridgeJobs {
  constructor(private readonly bridge: BridgeClient) {}

  /**
   * Runs one deezload fetch end-to-end. The token is passed explicitly —
   * no ambient state. `bridgePeer` is the BOT's entity/username: the DM
   * between the userbot account and the bot is addressed by the bot's peer
   * on the MTProto side (sending to the account's own id would land in
   * Saved Messages).
   */
  async fetchTrack(trackId: number, bridgePeer: string, token: string): Promise<ForwardedAudio> {
    const client = await this.bridge.get();
    const deezload = await client.getEntity(DEEZLOAD_USERNAME);

    // Equivalent to clicking the t.me/deezload2bot?start=deezerttrack<id>
    // deep link.
    await client.sendMessage(deezload, {
      message: `/start deezerttrack${trackId}`,
      linkPreview: false,
    });

    const audioMsg = await this.waitForAudio(client, trackId);

    // Server-side copy into the bridge DM (the bot's chat with the account).
    const forwarded = await client.forwardMessages(bridgePeer as any, {
      messages: [audioMsg.id],
      fromPeer: deezload,
      dropAuthor: false,
    });
    const forward = Array.isArray(forwarded) ? forwarded[0] : forwarded;

    // Token tag as a reply to the forward; the Bot API webhook reads the
    // forwarded audio's file_id from reply_to_message.
    await client.sendMessage(bridgePeer as any, {
      message: `lyq:file req=${token}`,
      replyTo: forward.id,
      linkPreview: false,
    });

    return { forwardMessageId: forward.id };
  }

  private waitForAudio(client: TelegramClient, trackId: number): Promise<Api.Message> {
    return new Promise<Api.Message>((resolve, reject) => {
      let settled = false;

      const handler = (update: any) => {
        if (settled) return;
        const msg = update?.message;
        if (!msg || typeof msg.id !== "number") return;
        const mime = String(msg.document?.mimeType ?? msg.audio?.mimeType ?? "");
        const isAudio = Boolean(msg.audio) || mime.startsWith("audio/");
        if (!isAudio) return; // photos / status text: skipped
        settled = true;
        cleanup();
        resolve(msg as Api.Message);
      };

      const raw = new Raw({});
      const cleanup = () => {
        clearTimeout(timer);
        client.removeEventHandler(handler, raw);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`no audio from deezload for track ${trackId} within timeout`));
      }, DEEZLOAD_AUDIO_TIMEOUT_MS);

      client.addEventHandler(handler, raw);
    });
  }
}

export async function isAuthorized(bridge: BridgeClient): Promise<boolean> {
  const client = await bridge.get();
  return client.checkAuthorization();
}

// Send plain text into the bridge DM (used for lyq:fail reports). Addressed
// by the BOT's username — same peer rule as fetchTrack.
export async function sendBridgeText(
  bridge: BridgeClient,
  bridgePeer: string,
  text: string,
): Promise<void> {
  const client = await bridge.get();
  await client.sendMessage(bridgePeer as any, {
    message: text,
    linkPreview: false,
  });
}
