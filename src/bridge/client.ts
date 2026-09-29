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
import {
  describeButtons,
  extractButtonAction,
  findGetAllButton,
  isFreshView,
  parseStartParamFor,
  ViewButtonInfo,
} from "./viewMatch";
import { log, warn } from "../utils/logger";

export const DEEZLOAD_USERNAME = "deezload2bot";

const DEEZLOAD_AUDIO_TIMEOUT_MS = 180000;
// Album stream backstop: silence of this length after the last audio ends
// the stream even when the expected count never arrived (failed tracks,
// partial sends). NOT the normal finish path — the collector completes the
// moment the expected count arrives (deezload sends in fast groups, so
// waiting out a fixed quiet period adds ~30s of dead latency).
const DEEZLOAD_ALBUM_QUIET_MS = 30000;
// A hung TCP/handshake must fail loudly instead of wedging the DO forever.
const CONNECT_TIMEOUT_MS = 45000;
const SIGNIN_TOTAL_TIMEOUT_MS = 180000;

// ── /migrate history page ───────────────────────────────────────────────────

// The message-shape reading lives in ./historyNormalize: it is pure and
// unit-tested there, because this file pulls in `cloudflare:sockets` and
// cannot be imported by a test. Re-exported here so the client surface is
// unchanged.
export {
  type HistoryMessage,
  type PosterIdentity,
  isOwnPoster,
  extractHistoryButtons,
  normalizeHistoryMessage,
} from "./historyNormalize";

import { floodWaitSeconds, unreadableReason } from "./scanErrors";
import { normalizeHistoryMessage, type HistoryMessage } from "./historyNormalize";

export { floodWaitSeconds, unreadableReason };

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

  /**
   * Fetch a whole album with ONE deezload interaction, reproducing the
   * manual flow: `/start deezertalbum<id>` → deezload replies with the
   * album view (photo/text + one callback row per song + GET ALL) → click
   * GET ALL (`messages.GetBotCallbackAnswer` with the button's callback
   * data) → deezload streams the album's audios. Each audio is forwarded
   * into the bridge DM and tagged `lyq:albumfile req=<token> idx=<n>` so
   * the webhook can pair arrivals to batch rows; when the stream goes quiet
   * (inactivity timer reset by every arrival) it sends
   * `lyq:albumdone req=<token> count=<k>`. Serial job execution in BridgeDO
   * guarantees no other job interleaves with the stream. Returns the number
   * of audios forwarded.
   */
  async fetchAlbum(albumId: number, bridgePeer: string, token: string, expectedCount?: number): Promise<number> {
    const client = await this.bridge.get();
    const deezload = await client.getEntity(DEEZLOAD_USERNAME);

    // Freshness anchor: the view must be posted/edited at or after this
    // moment. NOT an id comparison — MTProto private chats keep a separate
    // id sequence per participant, so deezload's message ids mean nothing
    // against ours; timestamps are the only cross-sequence-safe order.
    const startedAt = Math.floor(Date.now() / 1000);

    // BOTH collectors armed BEFORE the /start send. Deezload's album view
    // is a fast cached reply — a listener registered after the send can
    // miss it entirely. Every promise here resolves (never rejects): the
    // view waiter resolves null on timeout, the audio collector resolves
    // an empty array — so no dangling-rejection bookkeeping either.
    const viewPromise = this.waitForAlbumView(client, deezload, albumId, startedAt);
    const audioPromise = this.collectAlbumAudio(client, albumId, expectedCount);

    await client.sendMessage(deezload, {
      message: `/start deezertalbum${albumId}`,
      linkPreview: false,
    });

    const found = await viewPromise;
    if (!found) {
      audioPromise.catch(() => {});
      const dump = await this.dumpRecentMessages(client, deezload, albumId);
      throw new Error(
        `no album view from deezload for album ${albumId} | ${dump.slice(0, 800)}`,
      );
    }
    const { msg: view, button: target, how } = found;

    // Press GET ALL however deezload renders it. Expected path: a callback
    // button (album/<id>/down bytes) answered via GetBotCallbackAnswer; the
    // other branches cover format variants — deep-link url, label-matched
    // callback, and (only if a button truly has no action) the reply-
    // keyboard-style text send.
    audioPromise.catch(() => {});
    if (how !== "data") {
      // Non-data press — dump the keyboard so the exact action shape is
      // visible in Workers Logs (and in the failure reason if 0 audios).
      log(
        `bridge: album ${albumId} GET ALL matched by ${how}; keyboard: ` +
        describeButtons(this.collectCallbackButtons(view)).slice(0, 1500),
      );
    }
    if (target.data) {
      // The button carries callback data (token-matched or label-matched on
      // a fresh view — the freshness guarantee makes the label authoritative).
      await this.pressCallbackAnswer(
        client,
        deezload,
        view.id,
        target.data,
        albumId,
        how === "data" ? "token-matched" : "label-matched",
      );
    } else {
      const startParam = target.url ? parseStartParamFor(target.url, DEEZLOAD_USERNAME) : null;
      if (startParam) {
        // Deep-link button: a manual tap sends /start <param>.
        await client.sendMessage(deezload, {
          message: `/start ${startParam}`,
          linkPreview: false,
        });
        log(`bridge: sent GET ALL deep link for album ${albumId} (/start ${startParam})`);
      } else if (target.text.trim()) {
        // No data, no usable url: last resort — send the button's text
        // verbatim (reply-keyboard-style tap). Deezload treats unrecognized
        // input as a search prompt, so this is genuinely last.
        await client.sendMessage(deezload, {
          message: target.text,
          linkPreview: false,
        });
        log(`bridge: sent GET ALL text for album ${albumId} ("${target.text}", matched by ${how})`);
      } else {
        // Degenerate: no actionable field at all. Best-effort fallback.
        await client.sendMessage(deezload, {
          message: `/start album/${albumId}/down`,
          linkPreview: false,
        });
        log(`bridge: sent fallback GET ALL /start for album ${albumId} (matched by ${how})`);
      }
    }

    const audios = await audioPromise;
    log(`bridge: album ${albumId} stream quiet, ${audios.length} audio(s)`);

    // Zero audios from a FRESH view = the press didn't take (a real run
    // showed deezload silently ignoring an unpressed view). Fail loudly —
    // "0 of 13 delivered" hides the real story otherwise.
    if (!audios.length) {
      const dump = await this.dumpRecentMessages(client, deezload, albumId);
      throw new Error(
        `deezload streamed 0 audios for album ${albumId} — GET ALL press ` +
        `(matched by ${how}) did not take | ${dump.slice(0, 800)}`,
      );
    }

    // Forward each audio into the bridge DM with its arrival-order tag.
    for (let i = 0; i < audios.length; i++) {
      const forwarded = await client.forwardMessages(bridgePeer as any, {
        messages: [audios[i].id],
        fromPeer: deezload,
        dropAuthor: false,
      });
      const forward = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      await client.sendMessage(bridgePeer as any, {
        message: `lyq:albumfile req=${token} idx=${i + 1}`,
        replyTo: forward.id,
        linkPreview: false,
      });
    }

    // Tell the webhook the stream is over.
    await client.sendMessage(bridgePeer as any, {
      message: `lyq:albumdone req=${token} count=${audios.length}`,
      linkPreview: false,
    });

    return audios.length;
  }

  // Answer a callback button, ONCE, best-effort: a slow bot answers the
  // click after the ~10s MTProto window (BOT_RESPONSE_TIMEOUT) — the press
  // itself has already landed. Retrying is a SECOND press: a real run
  // double-pressed this way and deezload streamed the whole album twice
  // (26 forwards for 13 tracks). Never retry; the audio stream is the
  // signal, and the 0-audio failure path catches a press that truly
  // didn't land.
  private async pressCallbackAnswer(
    client: TelegramClient,
    deezload: any,
    msgId: number,
    data: Uint8Array,
    albumId: number,
    label: string,
  ): Promise<void> {
    try {
      await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: deezload,
          msgId,
          // The button's data is already the exact TL bytes to echo back.
          data: data as any,
        }),
      );
      log(`bridge: pressed GET ALL for album ${albumId} (callback, ${label})`);
    } catch (error) {
      // Press landed or didn't — do NOT send another. The stream decides.
      warn(`bridge: GET ALL answer for album ${albumId} errored (press counted as landed)`, error);
    }
  }

  // The album view is the message whose keyboard actually contains the GET
  // ALL button for this album — matched by callback-data prefix, URL, or
  // label (see findGetAllButton) — NOT just any keyboard: deezload's DM keeps
  // stale views from earlier runs and menus, and a loose matcher
  // presses/waits on the wrong message. The live listener is armed BEFORE
  // the /start lands; a periodic getMessages poll is the backstop for
  // updates the live stream misses. Resolves null on timeout so the caller
  // can fail gracefully.
  private async waitForAlbumView(
    client: TelegramClient,
    deezload: any,
    albumId: number,
    startedAt: number,
  ): Promise<{ msg: Api.Message; button: ViewButtonInfo; how: "data" | "url" | "text" } | null> {
    const matchView = (msg: any) => {
      const buttons = this.collectCallbackButtons(msg as Api.Message);
      const found = findGetAllButton(buttons, albumId);
      return found ? { buttons, ...found } : null;
    };

    let sawKeyboardMsg = false;
    let updatesSeen = 0;
    let pollErrorLogged = false;

    return new Promise<{ msg: Api.Message; button: ViewButtonInfo; how: "data" | "url" | "text" } | null>((resolve) => {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearInterval(poll);
        clearTimeout(timer);
        client.removeEventHandler(handler, raw);
      };

      const handler = (update: any) => {
        if (settled) return;
        updatesSeen++;
        // New posts and edits both carry .message; deezload may edit its
        // existing view instead of posting a fresh one.
        const msg = update?.message;
        if (!msg || typeof msg.id !== "number") return;
        if (!isFreshView(msg, startedAt)) {
          return; // stale view / older menu — keep waiting
        }
        const found = matchView(msg);
        if (!found) {
          // A fresh keyboard that doesn't match is diagnostic gold — say so
          // once instead of failing silently for 180s.
          if (!sawKeyboardMsg && this.collectCallbackButtons(msg as Api.Message).length) {
            sawKeyboardMsg = true;
            warn(
              `bridge: album ${albumId} fresh keyboard seen but no GET ALL match ` +
              `(buttons: ${describeButtons(this.collectCallbackButtons(msg as Api.Message))})`,
            );
          }
          return;
        }
        settled = true;
        cleanup();
        log(`bridge: album ${albumId} view received (msg ${msg.id}, date ${msg.date}, matched ${found.how})`);
        resolve({ msg: msg as Api.Message, button: found.button, how: found.how });
      };

      const raw = new Raw({});
      client.addEventHandler(handler, raw);

      poll = setInterval(() => {
        void (async () => {
          if (settled) return;
          try {
            const msgs = await client.getMessages(deezload, { limit: 5 });
            for (const m of msgs) {
              if (settled) return;
              if (!isFreshView(m, startedAt)) continue;
              const found = matchView(m);
              if (found) {
                settled = true;
                cleanup();
                log(`bridge: album ${albumId} view found by poll (msg ${(m as any).id}, matched ${found.how})`);
                resolve({ msg: m as unknown as Api.Message, button: found.button, how: found.how });
                return;
              }
              // Same one-time diagnostic as the live handler.
              if (!sawKeyboardMsg && this.collectCallbackButtons(m as Api.Message).length) {
                sawKeyboardMsg = true;
                warn(
                  `bridge: album ${albumId} fresh keyboard seen (poll) but no GET ALL match ` +
                  `(buttons: ${describeButtons(this.collectCallbackButtons(m as Api.Message))})`,
                );
              }
            }
          } catch (error) {
            // Log once — a silently dead poll looks identical to a missing view.
            if (!pollErrorLogged) {
              pollErrorLogged = true;
              warn("bridge: album view poll getMessages failed", error);
            }
          }
        })();
      }, 4000);

      const describeTimeoutState = () =>
        `updates seen: ${updatesSeen}, fresh keyboard seen: ${sawKeyboardMsg}`;

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        log(`bridge: album ${albumId} view wait timed out (${describeTimeoutState()})`);
        resolve(null);
      }, DEEZLOAD_AUDIO_TIMEOUT_MS);
    });
  }

  // Flatten replyMarkup rows into {text, data, url, …} buttons. teleproto's
  // fork parses inline buttons as KeyboardInlineButton { text, type:
  // InlineButtonType{data|url|query} } — the action is nested inside `type`
  // (see extractButtonAction). Reading btn.data directly found nothing, so
  // every button looked inert and the GET ALL press never fired.
  private collectCallbackButtons(msg: Api.Message): ViewButtonInfo[] {
    const out: ViewButtonInfo[] = [];
    const rows = (msg.replyMarkup as any)?.rows ?? [];
    for (const row of rows) {
      for (const btn of row.buttons ?? []) {
        out.push({ text: String(btn.text ?? ""), ...extractButtonAction(btn) });
      }
    }
    return out;
  }

  // Collect streamed audios. Expected-count finish: when the collector knows
  // how many audios deezload will send, the nth arrival ends the stream
  // IMMEDIATELY (deezload sends in fast groups — waiting out a quiet period
  // adds dead latency). The quiet-period timer stays as the backstop for
  // under-delivery (failed tracks, partial sends). Never rejects: zero
  // audios within the track timeout resolves an empty array (the caller
  // decides that's fatal).
  private async collectAlbumAudio(
    client: TelegramClient,
    albumId: number,
    expectedCount?: number,
  ): Promise<Api.Message[]> {
    const countTarget = typeof expectedCount === "number" && Number.isFinite(expectedCount) && expectedCount > 0
      ? Math.floor(expectedCount)
      : undefined;
    return new Promise<Api.Message[]>((resolve) => {
      const audios: Api.Message[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(audios);
      };

      const handler = (update: any) => {
        if (settled) return;
        const msg = update?.message;
        if (!msg || typeof msg.id !== "number") return;
        const mime = String(msg.document?.mimeType ?? msg.audio?.mimeType ?? "");
        const isAudio = Boolean(msg.audio) || mime.startsWith("audio/");
        if (!isAudio) return; // cover photo / status text: skipped
        audios.push(msg as Api.Message);
        // The expected count arrived — nothing more is coming; finish now.
        if (countTarget !== undefined && audios.length >= countTarget) {
          finish();
          return;
        }
        // Each arrival resets the quiet-period timer (backstop only).
        clearTimeout(timer);
        timer = setTimeout(finish, DEEZLOAD_ALBUM_QUIET_MS);
      };

      const raw = new Raw({});
      const cleanup = () => {
        clearTimeout(timer);
        client.removeEventHandler(handler, raw);
      };

      timer = setTimeout(finish, DEEZLOAD_AUDIO_TIMEOUT_MS);

      client.addEventHandler(handler, raw);
    });
  }

  // Timeout diagnostic: log AND return what the recent deezload messages
  // actually look like (id, date, every button with its action) so a matcher
  // mismatch is visible in Workers Logs AND travels with the failure reason
  // into the batch status message and the owner DM.
  private async dumpRecentMessages(client: TelegramClient, deezload: any, albumId: number): Promise<string> {
    try {
      const msgs = await client.getMessages(deezload, { limit: 5 });
      const lines: string[] = [`recent deezload messages for album ${albumId}:`];
      for (const m of msgs) {
        const buttons = this.collectCallbackButtons(m as Api.Message);
        lines.push(
          `- id=${(m as any).id} date=${(m as any).date} buttons=${buttons.length}` +
          (buttons.length ? ` [${describeButtons(buttons)}]` : ""),
        );
      }
      const text = lines.join(" | ");
      log(`bridge: album ${albumId} view timeout — ${text}`);
      return text;
    } catch (error) {
      warn("bridge: album view dump failed", error);
      return "recent-message dump failed";
    }
  }

  /**
   * Read ONE page of a channel's history for a /migrate run (FR-009).
   *
   * Deliberately a single page per call: BridgeDO's queue is strictly serial
   * with a 240s watchdog (AUTOFETCH_JOB_TIMEOUT_MS) and existing jobs depend on
   * that serialization, so a whole-channel scan as one job would starve every
   * music download. The run fetches the next page only when the current one is
   * exhausted, which also makes the admin's own answering pace the rate limiter
   * against FLOOD_WAIT (FR-009b).
   *
   * `offsetId` is 0 for the newest page; pass the last message id seen to walk
   * further back. Returns `nextOffsetId: null` at the end of history.
   *
   * On FLOOD_WAIT this resolves rather than throwing (BridgeJobs collectors
   * never reject) and reports `floodWaitSeconds`, so the caller can pace and
   * retry instead of failing the job — there is no FloodWaitError handling
   * anywhere else in this repo, because nothing else does bulk reads.
   */
  async fetchHistoryPage(
    channelId: string,
    offsetId = 0,
    limit = 50,
  ): Promise<{
    messages: HistoryMessage[];
    nextOffsetId: number | null;
    floodWaitSeconds?: number;
    // Set when the channel cannot be read at all, with a message meant for a
    // human. Distinguished from a flood wait, which is retryable.
    unreachable?: string;
  }> {
    const client = await this.bridge.get();
    const channel = await this.resolveChannelEntity(client, channelId);
    if (!channel) {
      return {
        messages: [],
        nextOffsetId: offsetId || null,
        unreachable:
          "the signed-in Telegram account can't see this channel — it needs to be added to it",
      };
    }

    try {
      const messages = await client.getMessages(channel, {
        limit,
        offsetId,
      });

      const list = Array.isArray(messages) ? messages : [messages];
      const normalized = list
        .filter((m) => m && typeof (m as any).id === "number")
        .map((m) => normalizeHistoryMessage(m as any));

      // The oldest id in this page is where the next page continues. A short
      // page (fewer than `limit`) means history is exhausted.
      const oldest = normalized.reduce(
        (min, m) => (m.messageId < min ? m.messageId : min),
        Number.MAX_SAFE_INTEGER,
      );
      const exhausted = normalized.length < limit;

      return {
        messages: normalized,
        nextOffsetId: exhausted || !normalized.length ? null : oldest,
      };
    } catch (error) {
      const seconds = floodWaitSeconds(error);
      if (seconds !== null) {
        return { messages: [], nextOffsetId: offsetId || null, floodWaitSeconds: seconds };
      }
      const why = unreadableReason(error);
      if (why) {
        return { messages: [], nextOffsetId: offsetId || null, unreachable: why };
      }
      // Anything else is a real failure — surface it to runJob's catch, which
      // reports to the owner rather than hanging.
      throw error;
    }
  }

  /**
   * Resolve a bare "-100…" channel id to something getMessages can read.
   *
   * A numeric id carries NO access_hash, and StringSession persists none, so a
   * cold DO cannot resolve it directly: getInputEntity's only path for a
   * PeerChannel is `channels.getChannels` with `accessHash: 0`, which works
   * for bots but is rejected for a user account — and that rejection is
   * swallowed inside teleproto, resurfacing as a bare "Could not find the
   * input entity" with no hint about why.
   *
   * The access_hash only exists in the account's dialog list, so fetching
   * dialogs is what actually warms the cache. Tried before giving up.
   */
  private async resolveChannelEntity(client: any, channelId: string): Promise<any | null> {
    try {
      return await client.getEntity(channelId);
    } catch {
      // cold cache — fall through
    }

    try {
      log("bridge: priming entity cache via dialogs for", channelId);
      await client.getDialogs({ limit: 300 });
    } catch (error) {
      warn("bridge: failed to list dialogs while resolving channel", error);
      return null;
    }

    try {
      return await client.getEntity(channelId);
    } catch {
      return null;
    }
  }

  /**
   * Attach an inline keyboard to a channel post, in place (FR-020).
   *
   * Teleproto's editMessage with `buttons` is the MTProto equivalent of
   * editMessageReplyMarkup: it carries markup only, never media or caption, so
   * the audio, the caption and the post's position cannot be altered. There is
   * deliberately no "re-send with caption" fallback here either (FR-026).
   *
   * Returns false on failure so the caller can record the candidate as failed
   * (FR-029) instead of retrying with a destructive method.
   */
  async editChannelMessage(
    channelId: string,
    messageId: number,
    rows: Array<Array<{ text: string; url?: string }>>,
  ): Promise<boolean> {
    try {
      const client = await this.bridge.get();
      const channel = await this.resolveChannelEntity(client, channelId);
      if (!channel) {
        warn("bridge: cannot resolve channel to edit", { channelId, messageId });
        return false;
      }
      await (client as any).editMessage(channel, {
        message: messageId,
        buttons: rows.map((row) =>
          row.map((b) => ({ text: b.text, url: b.url ?? "", onClick: undefined })),
        ),
      });
      return true;
    } catch (error) {
      warn("bridge: failed to attach button to channel post", {
        channelId, messageId,
        reason: String((error as any)?.message ?? error).slice(0, 200),
      });
      return false;
    }
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
