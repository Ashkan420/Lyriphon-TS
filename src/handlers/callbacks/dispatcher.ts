import { Context } from "grammy";
import { SessionData } from "../../session/types";
import { SessionMode } from "../../session/types";
import { Env } from "../../env";
import { handleTrackSelectionCallback } from "./search";
import { handleAudioDecisionCallback, handleSendToChannelCallback } from "./audio";
import {
  handleEditFieldCallback,
  handleCancelEditCallback,
  handleDoneLyricsCallback,
  handleNewFieldValue,
} from "./edit";
import { handleTranslateCallback } from "./translate";
import { handleLogsRefreshCallback, handleLogsCloseCallback } from "./logs";

// Single stable entry point. `bot.ts` imports handleCallbackQuery /
// processTextMessage from "../handlers/callbacks" — that barrel re-exports this,
// so callers never change. New callback prefixes are added here only.
export async function handleCallbackQuery(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return;
  }

  if (data.startsWith("track_")) {
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

  if (data.startsWith("send_channel_")) {
    await handleSendToChannelCallback(ctx, session);
    return;
  }

  if (data.startsWith("translate:")) {
    await handleTranslateCallback(ctx, session, env);
    return;
  }

  if (data === "logs_refresh") {
    await handleLogsRefreshCallback(ctx);
    return;
  }

  if (data === "logs_close") {
    await handleLogsCloseCallback(ctx);
    return;
  }
}

export async function processTextMessage(ctx: Context, session: SessionData, env: Env) {
  if (!session.edit.field || !(session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS)) {
    return;
  }

  await handleNewFieldValue(ctx, session, env);
}
