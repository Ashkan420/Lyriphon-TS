import { Bot, Context } from "grammy";
import { Env } from "./env";
import { createSessionData } from "./session/flows";
import { SessionData } from "./session/types";
import { createBot } from "./bot";

const STORAGE_KEY = "session";

export class SessionDO {
  state: DurableObjectState;
  env: Env;
  sessionData: SessionData;
  bot: Bot<Context>;
  deleteQueue: Array<{ chatId: number; messageId: number; deleteAt: number }> = [];
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessionData = createSessionData();
    this.bot = createBot(env, this);
    console.log("DO created, bot constructed");
  }

  async ensureBotInit() {
    if (!this.bot) throw new Error("Bot not constructed");
    if (!this.initPromise) {
      this.initPromise = this.bot.init().catch((err) => {
        console.error("grammY init failed:", err);
        this.initPromise = null;
      });
    }
    await this.initPromise;
    console.log("grammY init completed (safe to handle updates)");
  }

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const update = await request.json();
    if (!update || typeof update !== "object") {
      return new Response(null, { status: 400 });
    }

    console.log("Update received");
    try {
      await this.state.blockConcurrencyWhile(async () => {
        await this.loadSession();
        await this.ensureBotInit();
        await this.bot.handleUpdate(update as any);
        await this.persistSession();
      });
    } catch (error: any) {
      if (error?.message?.includes("blockConcurrencyWhile")) {
        console.warn("DO concurrency timeout — session will persist on next request");
      } else {
        throw error;
      }
    }

    return new Response(null, { status: 200 });
  }

  async alarm() {
    await this.loadSession();
    const now = Date.now();
    const due = this.deleteQueue.filter((item) => item.deleteAt <= now);
    this.deleteQueue = this.deleteQueue.filter((item) => item.deleteAt > now);

    for (const item of due) {
      try {
        await this.bot.api.deleteMessage(item.chatId, item.messageId);
      } catch (error) {
        console.warn("Alarm delete failed", error);
      }
    }

    await this.persistSession();
  }

  async loadSession() {
    const stored = await this.state.storage.get<SessionData>(STORAGE_KEY);
    this.sessionData = stored ?? createSessionData();
    const queue = await this.state.storage.get<Array<{ chatId: number; messageId: number; deleteAt: number }>>("deleteQueue");
    this.deleteQueue = queue ?? [];
  }

  async persistSession() {
    await this.state.storage.put(STORAGE_KEY, this.sessionData);
    await this.state.storage.put("deleteQueue", this.deleteQueue);
  }

  scheduleDelete(chatId: number, messageId: number, delayMs: number) {
    const deleteAt = Date.now() + delayMs;
    this.deleteQueue.push({ chatId, messageId, deleteAt });
    const next = Math.min(...this.deleteQueue.map((item) => item.deleteAt));

    this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.put("deleteQueue", this.deleteQueue);
      if (typeof (this.state as any).setAlarm === "function") {
        await (this.state as any).setAlarm(next);
      }
    });
  }
}
