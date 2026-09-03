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
import { warn, formatLogsForTelegram } from "./utils/logger";
import { adminCommand, handleAdminCallback, isBotOwner } from "./handlers/admin";

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
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const mode = session.mode;
    const version = session.version;
    await ctx.reply(`Session mode: ${mode}\nVersion: ${version}`);
  });

  bot.command("admin", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const session = getSession(sessionDo.sessionData);
    await adminCommand(ctx, session, sessionDo, env);
  });

  bot.command("debug", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
    const enabled = arg === "on" || arg === "off"
      ? arg === "on"
      : !sessionDo.debugEnabled;
    await sessionDo.setDebugEnabled(enabled);
    await ctx.reply(`Debug logging ${enabled ? "enabled" : "disabled"}.`);
  });

  bot.command("logs", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const text = formatLogsForTelegram();
    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Refresh", callback_data: "logs_refresh", style: "primary" as const }],
          [{ text: "Close", callback_data: "logs_close", style: "danger" as const }],
        ],
      },
    });
  });

  bot.command("multilingual", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
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

  // ── Bridge (deezload auto-fetch) auth: owner-only, in-Telegram login ──────
  // All BridgeDO auth routes are fire-and-forget: the DO reports outcomes
  // via Bot API messages, so these handlers never await MTProto round-trips
  // (a blocked await inside the SessionDO's blockConcurrencyWhile would
  // reset the DO and freeze every command).

  const bridgeStub = () => env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));

  bot.command("bridge_auth", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      await ctx.reply("❌ TELEGRAM_API_ID / TELEGRAM_API_HASH are not configured.");
      return;
    }
    const phone = (typeof ctx.match === "string" ? ctx.match : "").trim();
    if (!phone) {
      await ctx.reply("Usage: /bridge_auth <phone number>");
      return;
    }
    try {
      const res = await bridgeStub().fetch("https://bridge/auth/start", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      const body = await res.json() as any;
      if (body.ok) {
        await ctx.reply("🎧 Signing in… you'll get a message here when the code is sent.");
      } else {
        await ctx.reply(`❌ ${body.error ?? "could not start sign-in"}`);
      }
    } catch (error) {
      warn("bridge_auth failed", error);
      await ctx.reply("❌ Bridge DO unreachable.");
    }
  });

  bot.command("bridge_code", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const code = (typeof ctx.match === "string" ? ctx.match : "").trim();
    if (!code) {
      await ctx.reply("Usage: /bridge_code <login code>");
      return;
    }
    try {
      const res = await bridgeStub().fetch("https://bridge/auth/code", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const body = await res.json() as any;
      if (body.ok) {
        await ctx.reply("📨 Code delivered — completing sign-in…");
      } else {
        await ctx.reply(`❌ ${body.error ?? "code rejected"}`);
      }
    } catch (error) {
      warn("bridge_code failed", error);
      await ctx.reply("❌ Bridge DO unreachable.");
    }
  });

  bot.command("bridge_pass", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    const password = (typeof ctx.match === "string" ? ctx.match : "").trim();
    if (!password) {
      await ctx.reply("Usage: /bridge_pass <2FA password>");
      return;
    }
    try {
      const res = await bridgeStub().fetch("https://bridge/auth/password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      const body = await res.json() as any;
      if (body.ok) {
        await ctx.reply("📨 Password delivered — completing sign-in…");
      } else {
        await ctx.reply(`❌ ${body.error ?? "password rejected"}`);
      }
    } catch (error) {
      warn("bridge_pass failed", error);
      await ctx.reply("❌ Bridge DO unreachable.");
    }
  });

  bot.command("bridge_reset", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    try {
      // Full reset: auth state + expire all pending audio_requests (the cap
      // escape hatch).
      const res = await bridgeStub().fetch("https://bridge/reset", { method: "POST" });
      const body = await res.json() as any;
      await ctx.reply(body.ok
        ? `♻️ Bridge reset — auth cleared, ${body.expiredRows ?? 0} pending request(s) expired. Run /bridge_auth <phone> if re-login is needed.`
        : "❌ Reset failed.");
    } catch (error) {
      warn("bridge_reset failed", error);
      await ctx.reply("❌ Bridge DO unreachable.");
    }
  });

  bot.command("bridge_status", async (ctx) => {
    if (!isBotOwner(ctx, env)) {
      return;
    }
    try {
      const res = await bridgeStub().fetch("https://bridge/status");
      const s = await res.json() as any;
      const bits = [
        `session stored: ${s.hasSession ? "yes" : "no"}`,
        s.flowRunning ? "sign-in in progress" : null,
        s.hasPhone ? "phone captured" : null,
        s.lastState ? `last auth state: ${s.lastState}` : null,
      ].filter(Boolean);
      await ctx.reply(`🎧 Bridge — ${bits.join(", ")}`);
    } catch (error) {
      warn("bridge_status failed", error);
      await ctx.reply("❌ Bridge DO unreachable.");
    }
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
    await handleMusicFile(ctx, session, env);
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

    if (data.startsWith("admin_")) {
      await handleAdminCallback(ctx, session, sessionDo, env);
      return;
    }

    await handleCallbackQuery(ctx, session, env);
  });

  return bot;
}
