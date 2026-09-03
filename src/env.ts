export interface Env {
  BOT_TOKEN: string;
  TELEGRAPH_ACCESS_TOKEN: string;
  WEBHOOK_SECRET_TOKEN: string;
  BOT_OWNER_ID?: string;
  WEBHOOK_PATH?: string;
  TRANSLATION_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  BRIDGE_CHAT_ID?: string;
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
  DB: D1Database;
  SESSION_DO: DurableObjectNamespace;
  BRIDGE_DO: DurableObjectNamespace;
}
