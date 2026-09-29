import { Context } from "grammy";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { safeAnswer, cancelEdit, buildAudioCaption, safeEditCaption } from "../../utils/telegram";
import { migrationOf, resetMigrationInput } from "../../session/flows";
import { captureVersion, isStale } from "../../session/index";
import { warn, log } from "../../utils/logger";
import { getUserChannels } from "../../db/channels";
import {
  applyOutcome,
  attachLyricsButton,
  buildPageForAudio,
  markFailed,
  nextCandidate,
  confirmationKeyboard,
  confirmationText,
  summaryText,
} from "../migrate";
import {
  countByOutcome,
  countByStatus,
  getScanRow,
  setExistingUrl,
} from "../../db/scanQueue";
import { buildTrackResultHtml } from "../../utils/richMessages";
import { searchTracks } from "../../services/deezer";
import { buildPageForTrack } from "../migrate";
import { formatDuration } from "../../utils/telegram";
import { buildEditMenu, adminToolsOpts } from "./index";
import { isBotOwner } from "../admin";
import type { ScanQueueRow } from "../../db/scanQueue";
import type { ScanButton } from "../migrate";

// /migrate callbacks: the channel picker, the confirmation's Yes / No / Edit,
// the return control on an Edit, cancel, and resuming after a scan page lands.
//
// Everything that decides WHICH post is next and HOW the button is attached
// lives in ../migrate (pure, unit-tested). This file is Telegram glue.

const SCAN_PAGE_LIMIT = 50;

// ── Bridge plumbing ─────────────────────────────────────────────────────────

// Ask BridgeDO for one page of channel history. Fire-and-forget by design: no
// DO route may await an MTProto round-trip (src/doBridge.ts header), so the
// result arrives later as a lyq:scan message in the bridge DM.
async function requestScanPage(
  env: Env,
  userId: string,
  channelId: string,
  offsetId: number,
): Promise<"ok" | "unauthorized" | "queue_full" | "error"> {
  try {
    const stub = env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));
    const res = await stub.fetch(
      offsetId > 0 ? "https://bridge/scanPage" : "https://bridge/scan",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, channelId, offsetId, limit: SCAN_PAGE_LIMIT }),
      },
    );
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body?.ok) return "ok";
    if (body?.error === "unauthorized") return "unauthorized";
    if (body?.error === "queue_full") return "queue_full";
    return "error";
  } catch (error) {
    warn("migrate: scan request failed", error);
    return "error";
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

// The confirmation (FR-015, FR-016, FR-017).
//
// copyMessage pulls the ORIGINAL channel message into the admin's private chat:
// a server-side copy, so no file is transferred and the caption — blockquote,
// backticks, em dash, hidden Telegraph link — arrives byte-identical rather
// than re-serialized. The keyboard carries the Lyrics button the post would
// gain plus exactly three choices.
//
// The copied message id is kept so the confirmation can be deleted on answer
// (FR-022) and so Edit knows what to replace.
async function renderConfirmation(
  ctx: Context,
  session: SessionData,
  env: Env,
  index: number,
  total: number,
  row: ScanQueueRow,
): Promise<"rendered" | "failed"> {
  const migration = migrationOf(session);
  const chatId = ctx.chat?.id;
  if (!chatId) return "failed";

  let url = row.existing_url;

  // FR-014: a post with no link gets one built before anything is shown — the
  // confirmation needs a link to offer. Stored first so a re-offer, an Edit or
  // a retry can never build a second page for the same song (FR-014c).
  if (!url) {
    const built = await buildPageForAudio(
      env,
      { title: row.title, artist: row.artist, fileName: row.file_name },
      // Credited to whoever is running the migration, not to the bot.
      ctx.from?.first_name || "Lyriphon",
    );
    if (!built?.url) {
      warn("migrate: could not build a page for candidate", row.id);
      return "failed";
    }
    await setExistingUrl(env.DB, row.id, built.url);
    row.existing_url = built.url;
    url = built.url;
  }

  const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [{ text: "Lyrics", url }],
    ...confirmationKeyboard(row.id),
  ];

  // ALWAYS the audio copy first. The Telegraph card only appears once Edit (or
  // Research) opens it, so the admin approves against the file itself rather
  // than against a page they have to read first. The copy is server-side, so
  // nothing is re-uploaded and the caption arrives byte-identical.
  try {
    const copied = await (ctx.api as any).copyMessage(
      chatId,
      Number(row.channel_id),
      row.message_id,
      { reply_markup: { inline_keyboard: rows } },
    );
    migration.cardMessageId = copied?.message_id;
    migration.phase = "pending";
    return "rendered";
  } catch (error) {
    warn("migrate: failed to render confirmation", error);
    migration.cardMessageId = undefined;
    await ctx.reply(
      `❌ Could not preview post ${index} of ${total}.

${confirmationText(row, index, total)}`,
    );
    return "rendered";
  }
}

// The Telegraph card: reached ONLY from Edit or Research, and always carrying a
// way back to the audio confirmation (FR-024a), which is where Yes/No are
// answered. The full field menu is shown directly rather than collapsed, so the
// card never has to re-render its keyboard and lose the controls around it.
async function sendPageCard(
  ctx: Context,
  session: SessionData,
  env: Env,
  row: ScanQueueRow,
): Promise<boolean> {
  const migration = migrationOf(session);
  const url = row.existing_url;
  if (!url) return false;

  let page;
  try {
    const telegraph = await import("../../services/telegraph");
    page = await telegraph.getTelegraphPage(env, pagePathFromUrl(url));
    if (!page.ok || !page.content.length) throw new Error("empty page");

    const parsed = telegraph.parseTelegraphPage(page as any);
    const { lyrics, ...pageData } = parsed;

    // Fill the same four slots /edit does, so every field handler downstream
    // runs unmodified — no parallel editing path (FR-023).
    session.telegraph.data = pageData;
    session.telegraph.url = (page as any).url || url;
    session.telegraph.path = (page as any).path || pagePathFromUrl(url);
    session.telegraph.originalLyrics = lyrics;

    const text = buildTrackResultHtml({
      trackName: pageData.track,
      artistName: pageData.artist,
      albumName: pageData.album,
      releaseDate: pageData.releaseDate,
      telegraphUrl: session.telegraph.url ?? url,
      authorName: pageData.authorName,
      hasAudio: false,
      fetched: true,
    });

    const menu = [
      [{ text: "Lyrics", url: session.telegraph.url ?? url }],
      [
        { text: "✅ Yes", callback_data: `mig_yes_${row.id}` },
        { text: "❌ No", callback_data: `mig_no_${row.id}` },
      ],
      ...buildEditMenu(true, {
        ...adminToolsOpts(pageData.trackId, isBotOwner(ctx, env)),
        extraRows: [[{ text: "↩️ Back to audio", callback_data: "mig_return" }]],
      }),
    ];

    const sent = await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: menu } as any,
    });

    migration.cardMessageId = sent.message_id;
    migration.phase = "editing";
    migration.returnArmed = true;
    return true;
  } catch (error) {
    warn("migrate: failed to send page card", error);
    return false;
  }
}

// Delete the confirmation that is on screen, if any (FR-022).
async function clearConfirmation(ctx: Context, session: SessionData): Promise<void> {
  const migration = migrationOf(session);
  if (migration.cardMessageId && ctx.chat?.id) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, migration.cardMessageId);
    } catch {
      // already gone — not worth failing the run over
    }
  }
  migration.cardMessageId = undefined;
}

// Present the next candidate, or close the run with its summary (FR-034).
async function advance(
  ctx: Context,
  session: SessionData,
  env: Env,
  version: number,
): Promise<void> {
  const migration = migrationOf(session);
  const chatId = ctx.chat?.id;
  const userId = String(ctx.from?.id ?? "");
  if (!chatId || !userId || !migration.channelId) return;

  const row = await nextCandidate(env.DB, userId, migration.channelId, migration);

  // Stale: the session moved on while we awaited.
  if (isStale(session, version)) return;

  if (row) {
    const { pending } = await countByStatus(env.DB, userId, migration.channelId);
    const index = (migration.added + migration.declined + migration.edited + migration.failed) + 1;
    const rendered = await renderConfirmation(
      ctx, session, env, index, index + Math.max(pending - 1, 0), row,
    );

    if (rendered === "failed") {
      // FR-054: page creation failed for this one — record it, report it, and
      // keep walking. markFailed takes it out of the pending set, so this
      // recursion always terminates.
      await markFailed(env.DB, row.id);
      migration.failed += 1;
      if (!isStale(session, version)) {
        await ctx.reply(`⚠️ Couldn't prepare a page for one post — skipping it.`);
        await advance(ctx, session, env, version);
      }
      return;
    }
    return;
  }

  // No pending rows. Either history still has more (fetch the next page and
  // wait for lyq:scan) or the walk is genuinely finished (FR-009b, FR-032).
  if (!migration.scanExhausted && migration.nextOffsetId !== undefined) {
    const outcome = await requestScanPage(
      env, userId, migration.channelId, migration.nextOffsetId,
    );
    if (outcome === "ok") {
      migration.phase = "pick_channel";
      await ctx.reply("⏳ Reading further back in this channel…");
      return;
    }
    await ctx.reply(scanErrorText(outcome));
    return;
  }

  await finishRun(ctx, session, env, chatId);
}

function scanErrorText(outcome: string): string {
  switch (outcome) {
    case "unauthorized":
      return "❌ The signed-in Telegram account is not ready. Finish /bridge_auth and try again.";
    case "queue_full":
      return "❌ The bridge queue is busy. Try again in a moment.";
    default:
      return "❌ Could not read that channel's history. Try again later.";
  }
}

async function finishRun(
  ctx: Context,
  session: SessionData,
  env: Env,
  chatId: number,
): Promise<void> {
  const migration = migrationOf(session);
  const userId = String(ctx.from?.id ?? "");
  if (!migration.channelId) return;

  const [status, outcomes] = await Promise.all([
    countByStatus(env.DB, userId, migration.channelId),
    countByOutcome(env.DB, userId, migration.channelId),
  ]);

  const text = summaryText(migration.channelId, {
    offered: status.handled + status.failed,
    added: outcomes.added,
    declined: outcomes.declined,
    edited: outcomes.edited,
    failed: status.failed,
  });

  migration.phase = "done";
  try {
    await ctx.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    await ctx.api.sendMessage(chatId, text.replace(/[*_`]/g, ""));
  }
  resetMigrationInput(migration);
}

// True when the candidate a button was built for is still the one on screen.
// Undefined means the button carried no id (older builds / a bare keyboard),
// which is accepted so nothing is stranded.
function isCurrentCandidate(session: SessionData, candidateId?: number): boolean {
  if (candidateId === undefined) return true;
  return migrationOf(session).cursorId === candidateId;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function handleMigrationCallback(
  ctx: Context,
  session: SessionData,
  env: Env,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("mig_")) return;

  const action = data.slice("mig_".length);

  // The channel picker needs its id, which rides in the callback data. It is
  // validated against the admin's registered list before use (FR-008).
  if (action.startsWith("pick_")) {
    await onPickChannel(ctx, session, env, action.slice("pick_".length));
    return;
  }

  // Research's Deezer match list: mig_track_<deezerId>. Kept off the `pick_`
  // prefix so it can never be read as a channel choice.
  const trackPick = /^track_(\d+)$/.exec(action);
  if (trackPick) {
    await onPickResearchTrack(ctx, session, env, Number(trackPick[1]));
    return;
  }

  await safeAnswer(ctx);

  // yes/no/edit carry the candidate they belong to as a suffix (mig_yes_42).
  // A tap whose id is no longer the one on screen is stale and is refused
  // rather than applied to whatever the cursor has since moved to.
  const withId = /^(yes|no|edit)(?:_(\d+))?$/.exec(action);
  if (withId) {
    const candidateId = withId[2] === undefined ? undefined : Number(withId[2]);
    if (!isCurrentCandidate(session, candidateId)) {
      await safeAnswer(ctx, "❌ This choice has expired.");
      return;
    }
    if (withId[1] === "yes") { await onYes(ctx, session, env); return; }
    if (withId[1] === "no") { await onNo(ctx, session, env); return; }
    if (withId[1] === "edit") { await onEdit(ctx, session, env); return; }
  }

  // Research buttons carry the candidate id (mig_research_1), so match on a
  // pattern — an exact `case "research"` would never fire for a real button.
  if (action === "research_cancel") {
    await cancelResearchFlow(ctx, session, env);
    return;
  }
  const researchTap = /^research(?:_(\d+))?$/.exec(action);
  if (researchTap) {
    const candidateId = researchTap[1] ? Number(researchTap[1]) : undefined;
    if (!isCurrentCandidate(session, candidateId)) {
      await safeAnswer(ctx, "❌ This choice has expired.");
      return;
    }
    await onResearch(ctx, session);
    return;
  }

  switch (action) {
    case "resume":
      await onResume(ctx, session, env);
      return;
    case "return":
      await onReturn(ctx, session, env);
      return;
    case "cancel":
      await onCancel(ctx, session, env);
      return;
    case "abandon":
      await onAbandon(ctx, session);
      return;
    default:
      await safeAnswer(ctx, "❌ This choice has expired.");
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

// FR-008: only channels already registered to this admin are reachable, even
// if someone hand-crafts a callback with another channel's id.
async function onPickChannel(
  ctx: Context,
  session: SessionData,
  env: Env,
  channelId: string,
): Promise<void> {
  const migration = migrationOf(session);
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return;

  let allowed: string[];
  try {
    allowed = (await getUserChannels(env.DB, userId)).map((c) => c.channel_id);
  } catch (error) {
    warn("migrate: channel lookup failed", error);
    allowed = [];
  }

  if (!allowed.includes(channelId)) {
    await safeAnswer(ctx, "❌ That channel isn't one of yours.");
    // The picker may already be gone; make sure a half-open run is not left.
    if (migration.phase === "pick_channel") resetMigrationInput(migration);
    return;
  }

  await safeAnswer(ctx);

  migration.channelId = channelId;
  migration.nextOffsetId = 0;
  migration.scanExhausted = false;
  migration.phase = "pick_channel";

  const outcome = await requestScanPage(env, userId, channelId, 0);
  if (outcome !== "ok") {
    await ctx.reply(scanErrorText(outcome));
    resetMigrationInput(migration);
    return;
  }

  const notice = await ctx.reply("⏳ Reading that channel's history…");
  migration.readingMessageId = notice.message_id;
}

// FR-027 (session versioning): capture before the first await, re-check after
// each one, and discard rather than apply a stale result.
async function onResume(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const version = captureVersion(session);
  const migration = migrationOf(session);
  if (migration.phase === "idle" || !migration.channelId) {
    await safeAnswer(ctx, "❌ This run has ended.");
    return;
  }

  // Clear the "Reading…" notice now that an answer arrived — leaving it is
  // what makes a run look wedged when it is actually just waiting on you.
  if (migration.readingMessageId && ctx.chat?.id) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, migration.readingMessageId);
    } catch {
      // already gone
    }
    migration.readingMessageId = undefined;
  }

  await advance(ctx, session, env, version);
}

// FR-020: the one channel write. Failure is recorded and the run continues.
async function onYes(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const migration = migrationOf(session);
  const version = captureVersion(session);
  const userId = String(ctx.from?.id ?? "");

  if (!migration.cursorId) {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  const row = await getScanRow(env.DB, migration.cursorId);
  if (!row || row.status !== "pending") {
    // Stale tap or double tap: nothing changes, nothing double-counts.
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  if (!row.existing_url) {
    await safeAnswer(ctx, "❌ No page to link to yet.");
    return;
  }

  const existingRows: ScanButton[][] = row.existing_markup
    ? (JSON.parse(row.existing_markup) as ScanButton[][])
    : [];

  // ORDER MATTERS, and getting it wrong is silent.
  //
  // `editMessageCaption` is called WITHOUT reply_markup, and Telegram treats an
  // omitted keyboard as "replace it with nothing". Attaching the button first
  // and then editing the caption therefore removed the button again — the live
  // symptom was exactly that: caption changed, no button, and no error logged
  // because both calls had succeeded.
  //
  // So the caption goes FIRST and the markup edit is the LAST thing to touch
  // the message. A caption failure is best-effort and never blocks the button;
  // the attach below is what decides the outcome (FR-027a, FR-020).
  await safeEditCaption(
    ctx.api,
    Number(row.channel_id),
    row.message_id,
    buildAudioCaption(
      row.title ?? "",
      row.artist ?? "",
      row.existing_url ?? "",
    ),
  );

  // Markup only — the audio and the post's position are never mentioned.
  const ok = await attachLyricsButton(
    ctx.api,
    Number(row.channel_id),
    row.message_id,
    row.existing_url,
    existingRows,
  );

  if (ok) {
    await applyOutcome(env.DB, row.id, "added");
    migration.added += 1;
  } else {
    // FR-029: record it, report it, and keep walking. No fallback method.
    await markFailed(env.DB, row.id);
    migration.failed += 1;
    if (!isStale(session, version)) {
      await ctx.reply(`⚠️ Couldn't add a button to one post (${row.message_id}) — skipping it and moving on.`);
    }
  }

  if (isStale(session, version)) return;
  await clearConfirmation(ctx, session);
  await advance(ctx, session, env, version);
}

// FR-021: nothing in the channel changes; just move on.
async function onNo(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const migration = migrationOf(session);
  const version = captureVersion(session);

  if (migration.cursorId) {
    const row = await getScanRow(env.DB, migration.cursorId);
    if (row && row.status === "pending") {
      await applyOutcome(env.DB, row.id, "declined");
      migration.declined += 1;
    }
  }

  if (isStale(session, version)) return;
  await clearConfirmation(ctx, session);
  await advance(ctx, session, env, version);
}

async function onCancel(ctx: Context, session: SessionData, _env: Env): Promise<void> {
  const migration = migrationOf(session);
  await clearConfirmation(ctx, session);
  // Nothing has been asked of the channel that we could undo: the run only
  // ever edits on a Yes, so cancelling simply stops offering candidates.
  resetMigrationInput(migration);
  await ctx.reply("❌ Migration cancelled. Nothing was changed.");
}

// Escape hatch for a run that is open but going nowhere — offered by /migrate
// when it refuses to start a second run. Drops the session state without
// touching the channel: rows already decided keep their outcomes, pending ones
// stay pending and can be picked up by the next run.
async function onAbandon(ctx: Context, session: SessionData): Promise<void> {
  const migration = migrationOf(session);
  await clearConfirmation(ctx, session);
  resetMigrationInput(migration);
  await ctx.reply(
    "❌ Run abandoned. Nothing was changed in the channel — already-added buttons stay as they are.",
  );
}

// ── Research ────────────────────────────────────────────────────────────────

// The confirmation's fourth choice. The automatic pick came from guessing at
// the file's tags; this is the escape when it guessed wrong.
//
// Nothing here moves the run: the candidate stays at cursorId the whole way,
// and the channel is only ever written by a Yes.
async function onResearch(ctx: Context, session: SessionData): Promise<void> {
  const migration = migrationOf(session);
  if (!migration.cursorId || migration.phase !== "pending") {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  await clearConfirmation(ctx, session);
  migration.phase = "researching";

  const prompt = await ctx.reply(
    "🔎 Send what to search on Deezer.\n\n" +
    "Send the track and artist, e.g. `Panchiko Laputa`.\n" +
    "Send /cancel to go back.",
  );
  migration.researchPromptId = prompt.message_id;
}

// Exported so /cancel can reach it: the Research prompt tells the admin to
// send /cancel, and bot.ts dispatches commands before any callback handling.
export async function cancelResearchFlow(
  ctx: Context,
  session: SessionData,
  env: Env,
): Promise<void> {
  const migration = migrationOf(session);
  const version = captureVersion(session);
  await clearResearchPrompt(ctx, session);
  migration.phase = "pending";
  migration.researchResults = undefined;
  if (isStale(session, version)) return;
  await reofferCurrentCandidate(ctx, session, env, version);
}

async function clearResearchPrompt(ctx: Context, session: SessionData): Promise<void> {
  const migration = migrationOf(session);
  if (migration.researchPromptId && ctx.chat?.id) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, migration.researchPromptId);
    } catch {}
    migration.researchPromptId = undefined;
  }
}

// Called from processTextMessage while phase === "researching": run the query
// and offer the matches. Exported so the dispatcher can reach it.
export async function handleResearchQuery(
  ctx: Context,
  session: SessionData,
): Promise<void> {
  const migration = migrationOf(session);
  const query = (ctx.message?.text ?? "").trim();
  // Guard, not just a caller convention: if the run is not waiting on a
  // query, say so rather than let the message fall back to a /song search.
  if (migration.phase !== "researching" || !migration.cursorId) {
    await ctx.reply("❌ No search in progress. Send /song to search normally.");
    return;
  }
  if (!query) return;

  const version = captureVersion(session);
  await clearResearchPrompt(ctx, session);

  const results = await searchTracks(query);
  if (isStale(session, version)) return;

  if (!results?.length) {
    await ctx.reply(`❌ No Deezer matches for: ${query}\n\nSend another search, or /cancel.`);
    migration.phase = "researching";
    const retry = await ctx.reply("🔎 Send what to search on Deezer:");
    migration.researchPromptId = retry.message_id;
    return;
  }

  // Kept in the session so a late tap can be matched back to this candidate,
  // and because the keyboard below is built from exactly this list.
  const picks: Array<{ id: number; title: string; artist: string; duration: number }> =
    results.slice(0, 8).map((r: any) => ({
    id: Number(r?.id),
    title: String(r?.title ?? "Unknown"),
    artist: String(r?.artist?.name ?? ""),
    duration: Number(r?.duration ?? 0),
  }));
  migration.researchResults = picks;

  const keyboard: Array<Array<{ text: string; callback_data: string }>> =
    picks.map((r) => [
      {
        text: `${r.title} - ${r.artist} (${formatDuration(r.duration)})`,
        callback_data: `mig_track_${r.id}`,
      },
    ]);
  keyboard.push([{ text: "↩️ Cancel", callback_data: "mig_research_cancel" }]);

  const sent = await ctx.reply("🎵 Pick the right track for this post:", {
    reply_markup: { inline_keyboard: keyboard },
  });
  migration.researchPromptId = sent.message_id;
}

async function onPickResearchTrack(
  ctx: Context,
  session: SessionData,
  env: Env,
  trackId: number,
): Promise<void> {
  await safeAnswer(ctx);
  const migration = migrationOf(session);
  const version = captureVersion(session);

  if (migration.phase !== "researching" || !migration.cursorId) {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  const row = await getScanRow(env.DB, migration.cursorId);
  if (!row || row.status !== "pending") {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  const built = await buildPageForTrack(
    env,
    trackId,
    ctx.from?.first_name || "Lyriphon",
    { title: row.title ?? undefined, artist: row.artist ?? undefined },
  );
  if (!built?.url) {
    warn("migrate: research page build failed", { trackId, candidate: row.id });
    await ctx.reply("❌ Could not build a page for that track. Try another search.");
    migration.phase = "researching";
    const retry = await ctx.reply("🔎 Send what to search on Deezer:");
    migration.researchPromptId = retry.message_id;
    return;
  }
  if (isStale(session, version)) return;

  // Replace this candidate's link — and only its link. Nothing else about the
  // post or the run's position changes.
  await setExistingUrl(env.DB, row.id, built.url);
  row.existing_url = built.url;

  await clearResearchPrompt(ctx, session);
  migration.researchResults = undefined;
  migration.phase = "pending";

  // Research's whole point is to look at a freshly built page, so show the
  // card — with the control that takes you back to the audio confirmation,
  // which is where Yes/No are answered.
  if (await sendPageCard(ctx, session, env, row)) return;

  const { pending } = await countByStatus(
    env.DB, String(ctx.from?.id ?? ""), row.channel_id,
  );
  const index = (migration.added + migration.declined + migration.edited + migration.failed) + 1;
  await renderConfirmation(ctx, session, env, index, index + Math.max(pending - 1, 0), row);
}

// Put the SAME candidate back on screen — used whenever Research is abandoned.
async function reofferCurrentCandidate(
  ctx: Context,
  session: SessionData,
  env: Env,
  version: number,
): Promise<void> {
  const migration = migrationOf(session);
  if (!migration.cursorId || !migration.channelId) return;

  const row = await getScanRow(env.DB, migration.cursorId);
  if (!row || row.status !== "pending") return;
  if (isStale(session, version)) return;

  const { pending } = await countByStatus(
    env.DB, String(ctx.from?.id ?? ""), migration.channelId,
  );
  const index = (migration.added + migration.declined + migration.edited + migration.failed) + 1;
  await renderConfirmation(ctx, session, env, index, index + Math.max(pending - 1, 0), row);
}

// ── Edit path (FR-023, FR-024) ─────────────────────────────────────────────

// Open the song's page with the FULL edit keyboard, exactly as /edit does —
// filling the same four session slots so every field handler downstream runs
// unmodified. The channel is not touched by this path at all.
async function onEdit(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const migration = migrationOf(session);
  const version = captureVersion(session);

  if (!migration.cursorId) {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  const row = await getScanRow(env.DB, migration.cursorId);
  if (!row || row.status !== "pending") {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  if (!row.existing_url) {
    await safeAnswer(ctx, "❌ There is no page for this post yet.");
    return;
  }

  // Drop the audio confirmation: the card takes its place, and it carries the
  // control that brings you back to it (FR-024a).
  await clearConfirmation(ctx, session);

  if (isStale(session, version)) return;

  if (!(await sendPageCard(ctx, session, env, row))) {
    migration.phase = "pending";
    await ctx.reply("❌ Could not open that page for editing.");
    return;
  }
}

function pagePathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

// FR-024 / FR-024a-c: end the editing session, remove the injected control,
// and re-offer THIS candidate — never advancing the cursor.
async function onReturn(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const migration = migrationOf(session);
  const version = captureVersion(session);

  if (migration.phase !== "editing") {
    await safeAnswer(ctx, "❌ This choice has expired.");
    return;
  }

  // Disarm FIRST so no later buildEditMenu can re-render the control.
  migration.returnArmed = false;

  await clearConfirmation(ctx, session);

  // The same teardown the ordinary Cancel button uses, so prompts and buffered
  // lyric messages are cleaned up identically.
  if (ctx.chat?.id) {
    await cancelEdit(ctx.api as any, ctx.chat.id, session);
  }

  if (isStale(session, version)) return;

  migration.phase = "pending";
  const userId = String(ctx.from?.id ?? "");
  if (!migration.cursorId || !migration.channelId) return;

  const row = await getScanRow(env.DB, migration.cursorId);
  if (!row || row.status !== "pending") {
    // Answered while editing — continue from wherever the queue is.
    await advance(ctx, session, env, version);
    return;
  }

  const { pending } = await countByStatus(env.DB, userId, migration.channelId);
  const index = (migration.added + migration.declined + migration.edited + migration.failed) + 1;
  const rendered = await renderConfirmation(
    ctx, session, env, index, index + Math.max(pending - 1, 0), row,
  );
  if (rendered === "failed") {
    await markFailed(env.DB, row.id);
    migration.failed += 1;
    if (!isStale(session, version)) {
      await advance(ctx, session, env, version);
    }
  }
}
