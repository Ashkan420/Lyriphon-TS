export interface Env {
  BOT_TOKEN: string;
  TELEGRAPH_ACCESS_TOKEN: string;
  WEBHOOK_SECRET_TOKEN: string;
  BOT_OWNER_ID?: string;
  WEBHOOK_PATH?: string;
  DB: D1Database;
  SESSION_DO: DurableObjectNamespace;
}
