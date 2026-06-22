import { DEFAULT_WEBHOOK_PATH } from "./config";
import { Env } from "./env";
export { SessionDO } from "./do";

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
    const update = await clone.json();
    const userId = extractUserId(update);
    if (!userId) {
      return new Response("OK", { status: 200 });
    }

    const id = env.SESSION_DO.idFromName(String(userId));
    const obj = env.SESSION_DO.get(id);
    return await obj.fetch(request);
  },
};

function extractUserId(update: any): string | null {
  return update.message?.from?.id?.toString()
    || update.callback_query?.from?.id?.toString()
    || update.inline_query?.from?.id?.toString()
    || update.my_chat_member?.from?.id?.toString()
    || null;
}
