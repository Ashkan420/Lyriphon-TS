import { Bot, Context } from "grammy";
import { Env } from "./env";
import { SessionDO } from "./do";
import { startCommand, helpCommand } from "./handlers/start";
import { songSearchCommand, handleSearchPageCallback } from "./handlers/songSearch";
import { handleMusicFile } from "./handlers/musicFile";
import { inlineSearch } from "./handlers/inlineSearch";
import { trackChannels } from "./handlers/channelTracker";
import { handleCallbackQuery, processTextMessage } from "./handlers/callbacks";
import { getSession } from "./session/index";
import { SessionMode } from "./session/types";
import { inMode } from "./session/transitions";
import { safeDelete, cancelEdit } from "./utils/telegram";
import { clearAudioState } from "./session/flows";
import { warn } from "./utils/logger";

export function createBot(env: Env, sessionDo: SessionDO): Bot<Context> {
  const bot = new Bot<Context>(env.BOT_TOKEN);

  // Global error boundary: prevents a single failing handler from rejecting
  // handleUpdate (which would surface as a 500 and trigger Telegram retries).
  bot.catch((err) => {
    warn("Unhandled error in update handler", err.error);
  });

  bot.command("start", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    await startCommand(ctx, session);
  });

  bot.command("help", async (ctx) => {
    await helpCommand(ctx);
  });

  bot.command("song", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    await songSearchCommand(ctx, session, env);
  });

  bot.command("done", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    if (!inMode(session, SessionMode.EDIT_LYRICS)) {
      return;
    }
    if (ctx.chat?.id) {
      await safeDelete(ctx.api, ctx.chat.id, ctx.message!.message_id);
    }
    await ctx.reply("✅ Use the Done button to finalize lyrics.");
  });

  bot.command("cancel", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (inMode(session, SessionMode.EDIT_FIELD) || inMode(session, SessionMode.EDIT_LYRICS)) {
      await safeDelete(ctx.api, chatId, ctx.message!.message_id);
      await cancelEdit(ctx.api, chatId, session);
      await ctx.reply("❌ Edit cancelled");
    } else {
      clearAudioState(session);
    }
  });

  bot.command("session", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    if (env.BOT_OWNER_ID && String(ctx.from?.id) !== env.BOT_OWNER_ID) {
      return;
    }
    const mode = session.mode;
    const version = session.version;
    await ctx.reply(`Session mode: ${mode}\nVersion: ${version}`);
  });

  bot.command("debug", async (ctx) => {
    if (env.BOT_OWNER_ID && String(ctx.from?.id) !== env.BOT_OWNER_ID) {
      return;
    }
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
    const enabled = arg === "on" || arg === "off"
      ? arg === "on"
      : !sessionDo.debugEnabled;
    await sessionDo.setDebugEnabled(enabled);
    await ctx.reply(`Debug logging ${enabled ? "enabled" : "disabled"}.`);
  });

  bot.command("multilingual", async (ctx) => {
    if (env.BOT_OWNER_ID && String(ctx.from?.id) !== env.BOT_OWNER_ID) {
      return;
    }
    const current = sessionDo.sessionData.telegraph.multilingualEnabled ?? true;
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
    const enabled = arg === "on" || arg === "off"
      ? arg === "on"
      : !current;
    sessionDo.sessionData.telegraph.multilingualEnabled = enabled;
    await ctx.reply(`Multilingual mode ${enabled ? "enabled" : "disabled"}.`);
  });

  bot.on("message:text", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    if (session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS) {
      await processTextMessage(ctx, session, env);
      return;
    }

    return;
  });

  bot.on("message:audio", async (ctx) => {
    const session = getSession(sessionDo.sessionData);
    await handleMusicFile(ctx, session);
  });

  bot.on("inline_query", async (ctx) => {
    await inlineSearch(ctx, env);
  });

  bot.on("my_chat_member", async (ctx) => {
    await trackChannels(ctx, env.DB);
  });

  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) {
      return;
    }

    const session = getSession(sessionDo.sessionData);
    if (data.startsWith("search_page_")) {
      await handleSearchPageCallback(ctx, session);
      return;
    }

    await handleCallbackQuery(ctx, session, env);
  });

  return bot;
}
