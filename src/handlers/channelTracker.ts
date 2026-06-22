import { Context } from "grammy";
import { D1Database } from "@cloudflare/workers-types";
import { addChannel, getUsersByChannel, removeChannel } from "../db/channels";

export async function trackChannels(ctx: Context, db: D1Database) {
  const chat = ctx.chat;
  const myChatMember = ctx.myChatMember;
  if (!chat || !myChatMember) {
    return;
  }

  const status = myChatMember.new_chat_member?.status;
  if (!status || (chat.type !== "channel" && chat.type !== "supergroup")) {
    return;
  }

  const chatId = String(chat.id);
  const actorId = String(ctx.from?.id ?? "");

  if (status === "administrator" || status === "creator") {
    try {
      await addChannel(db, actorId, chatId, chat.title);
    } catch (error) {
      console.warn("Failed to add channel", chatId, actorId, error);
    }
  } else if (status === "left" || status === "kicked") {
    try {
      const userIds = await getUsersByChannel(db, chatId);
      for (const userId of userIds) {
        await removeChannel(db, userId, chatId);
      }
    } catch (error) {
      console.warn("Failed to remove channel", chatId, error);
    }
  }
}
