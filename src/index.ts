import { DEFAULT_WEBHOOK_PATH } from "./config";
import { Env } from "./env";
import { isBridgeChat, handleBridgeUpdate } from "./handlers/bridge";
import { handleInlineQueryUpdate } from "./handlers/inlineSearch";
import { handleChosenInlineResult } from "./handlers/inlinePipeline";
export { SessionDO } from "./do";
export { BridgeDO } from "./doBridge";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, "");
    const webhookPath = env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;

    if (request.method !== "POST" || path !== webhookPath) {
      return new Response("Not found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const clone = request.clone();
    const update: any = await clone.json();

    // Bridge chat traffic (Telethon relaying deezload files) must never enter
    // the account's per-user session DO — handle it session-free, then stop.
    if (isBridgeChat(env, update)) {
      await handleBridgeUpdate(env, update);
      return new Response(null, { status: 200 });
    }

    // Inline queries are handled session-free: one inline_query per keystroke
    // would serialize through the user's SessionDO and the queued queries
    // would expire ("query is too old") before being answered. chosen_inline_result
    // (requires BotFather Inline Feedback) auto-starts the lyrics pipeline —
    // same session-free reasoning, and it must never block on a session.
    if (update.inline_query) {
      await handleInlineQueryUpdate(env, update.inline_query);
      return new Response(null, { status: 200 });
    }
    if (update.chosen_inline_result) {
      await handleChosenInlineResult(env, update.chosen_inline_result);
      return new Response(null, { status: 200 });
    }

    const userId = extractUserId(update);
    if (!userId) {
      return new Response("OK", { status: 200 });
    }

    const id = env.SESSION_DO.idFromName(String(userId));
    const obj = env.SESSION_DO.get(id);
    const doRequest = new Request(request.url, {
      method: "POST",
      headers: new Headers({ "x-lyriphon-user-id": String(userId) }),
      body: await request.text(),
    });
    return await obj.fetch(doRequest);
  },
};

function extractUserId(update: any): string | null {
  return update.message?.from?.id?.toString()
    || update.callback_query?.from?.id?.toString()
    || update.inline_query?.from?.id?.toString()
    || update.my_chat_member?.from?.id?.toString()
    || null;
}
