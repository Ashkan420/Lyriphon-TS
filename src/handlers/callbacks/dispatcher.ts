import { Context } from "grammy";
import { SessionData } from "../../session/types";
import { migrationOf } from "../../session/flows";
import { SessionMode } from "../../session/types";
import { Env } from "../../env";
import { handleTrackSelectionCallback } from "./search";
import { handleInlineTrackButton } from "../inlinePipeline";
import { handleAudioDecisionCallback, handleSendToChannelCallback } from "./audio";
import {
  handleEditFieldCallback,
  handleCancelEditCallback,
  handleDoneLyricsCallback,
  handleNewFieldValue,
  handleApplyToD1,
} from "./edit";
import { handleMigrationCallback, handleResearchQuery } from "./migrate";
import { handleExpandEditMenu } from "./index";
import { handleTranslateCallback } from "./translate";
import { handleRefreshSummaryCallback } from "./summary";
import { handleLogsPageCallback, handleLogsCloseCallback } from "./logs";
import { handleSettingsCallback, handleRichStyleCallback } from "../settings";
import {
  handleAlbumPickCallback,
  handleAlbumSongToggle,
  handleAlbumGetAll,
  handleAlbumCancel,
  handleAlbumViewBack,
} from "../album";

// Single stable entry point. `bot.ts` imports handleCallbackQuery /
// processTextMessage from "../handlers/callbacks" — that barrel re-exports this,
// so callers never change. New callback prefixes are added here only.
export async function handleCallbackQuery(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return;
  }

  // Rich-delivery customizer + its back button: checked before the generic
  // settings_ prefix branch (settings_back collides with it).
  if (
    data.startsWith("rich") ||
    data === "settings_richstyles" ||
    data === "settings_back"
  ) {
    await handleRichStyleCallback(ctx, env);
    return;
  }

  if (data.startsWith("albumpick_")) {
    await handleAlbumPickCallback(ctx, env);
    return;
  }

  if (data.startsWith("albumsong_")) {
    await handleAlbumSongToggle(ctx, env);
    return;
  }

  if (data.startsWith("album/") && data.endsWith("/down")) {
    await handleAlbumGetAll(ctx, env);
    return;
  }

  if (data.startsWith("albumcancel_")) {
    await handleAlbumCancel(ctx, env);
    return;
  }

  if (data === "albumview_back") {
    await handleAlbumViewBack(ctx, env);
    return;
  }

  if (data.startsWith("track_")) {
    // Chatless = a sent inline message's 📄 Get Lyrics button: the session-
    // free inline pipeline (the DM handler needs ctx.chat for its session).
    if (!ctx.callbackQuery?.message && ctx.callbackQuery?.inline_message_id) {
      await handleInlineTrackButton(ctx, env);
      return;
    }
    await handleTrackSelectionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("audio_decision_")) {
    await handleAudioDecisionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("edit_field_")) {
    await handleEditFieldCallback(ctx, session);
    return;
  }

  if (data === "cancel_edit") {
    await handleCancelEditCallback(ctx, session);
    return;
  }

  if (data === "done_lyrics") {
    await handleDoneLyricsCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("applyd1_")) {
    await handleApplyToD1(ctx, session, env);
    return;
  }

  // /migrate: channel picker, confirmation Yes/No/Edit, and the Edit return
  // control. Its prefix collides with nothing (checked repo-wide), and it sits
  // with the edit family because it opens the same edit flow.
  if (data.startsWith("mig_")) {
    await handleMigrationCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("send_channel_")) {
    await handleSendToChannelCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("translate:")) {
    await handleTranslateCallback(ctx, session, env);
    return;
  }

  if (data === "refresh_summary") {
    await handleRefreshSummaryCallback(ctx, session, env);
    return;
  }

  if (data === "logs_refresh" || data.startsWith("logs_page_")) {
    await handleLogsPageCallback(ctx);
    return;
  }

  if (data === "logs_close") {
    await handleLogsCloseCallback(ctx);
    return;
  }

  if (data.startsWith("settings_")) {
    await handleSettingsCallback(ctx, env);
    return;
  }

  if (data === "expand_edit_menu") {
    await handleExpandEditMenu(ctx, session, env);
    return;
  }
}

export async function processTextMessage(ctx: Context, session: SessionData, env: Env) {
  // A /migrate Research query takes precedence over an open edit field: the
  // run owns the message it is waiting for, and there is no edit field open
  // while it is (phase is 'researching', not an edit mode).
  if (migrationOf(session).phase === "researching") {
    await handleResearchQuery(ctx, session);
    return;
  }

  if (!session.edit.field || !(session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS)) {
    return;
  }

  await handleNewFieldValue(ctx, session, env);
}
