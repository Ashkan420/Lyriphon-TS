import { Context } from "grammy";
import { Env } from "../env";
import { SessionData } from "../session/types";
import { migrationOf, resetMigrationInput } from "../session/flows";
import { isBotOwner } from "./admin";
import { getUserChannels } from "../db/channels";
import { warn } from "../utils/logger";

// /migrate — the single entry point to the channel button backfill (FR-001).
//
// This file only opens a run: the private-chat and admin gates, the
// one-run-at-a-time rule, and the channel picker. Everything that happens once
// a channel is chosen lives in handlers/callbacks/migrate.ts, which the picker's
// mig_pick_ buttons route to.
//
// Three ordered gates, cheapest first, and all three fail closed:
//   1. private chat only      (FR-003) — a group must never trigger a walk
//   2. the owner gate         (FR-002) — isBotOwner rejects everyone when
//                                 BOT_OWNER_ID is unset, so an unconfigured
//                                 bot is more locked down, not less
//   3. no run already open    (FR-004) — a second run would interleave its
//                                 cursor with the first

export async function migrateCommandHandler(
  ctx: Context,
  session: SessionData,
  env: Env,
): Promise<void> {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Open this in a private chat with me.");
    return;
  }

  if (!isBotOwner(ctx, env)) {
    await ctx.reply("❌ Only the bot's admin can run this.");
    return;
  }

  const migration = migrationOf(session);

  // A run that is already open must not be silently destroyed — tell the admin
  // to finish or cancel it first (FR-004). Stale by definition: if the session
  // was reset underneath us, phase is back to idle and we fall through.
  // A run that is already open must not be silently destroyed (FR-004) — but
  // it must always be escapable. A refusal with no way out strands the admin
  // in a run whose confirmation may be long gone from their chat history, so
  // this reply carries the two exits: resume it, or throw it away.
  if (migration.phase !== "idle") {
    const where =
      migration.phase === "pick_channel"
        ? "⏳ Waiting for the channel scan to finish."
        : migration.phase === "pending"
          ? "✅ A post is waiting for your Yes / No."
          : migration.phase === "editing"
            ? "✏️ You're editing a song's page."
            : "A migration run is still open.";

    await ctx.reply(`${where}\n\nResume it, or abandon it to start over.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ Continue", callback_data: "mig_resume" }],
          [{ text: "❌ Abandon this run", callback_data: "mig_abandon" }],
        ],
      },
    });
    return;
  }

  const userId = String(ctx.from?.id ?? "");
  if (!userId) {
    await ctx.reply("❌ Could not identify you.");
    return;
  }

  let channels;
  try {
    channels = await getUserChannels(env.DB, userId);
  } catch (error) {
    warn("migrate: failed to read registered channels", error);
    await ctx.reply("❌ Could not read your channels. Try again later.");
    return;
  }

  // No registered channels is a terminal answer for this invocation: say so and
  // do NOT start a run (FR-007). Nothing is written, nothing is scanned.
  if (!channels.length) {
    await ctx.reply(
      "You have no registered channels yet.\n\n" +
        "Add the bot to a channel as an admin and it will show up here.",
    );
    return;
  }

  migration.phase = "pick_channel";
  migration.channelIdList = channels.map((row) => row.channel_id);

  const keyboard = channels.map((row) => [
    {
      text: row.title ?? row.channel_id,
      // Prefix carries the channel id so the callback resolves the pick
      // without a lookup; the handler re-validates against the registered list
      // before using it (FR-008).
      callback_data: `mig_pick_${row.channel_id}`,
    },
  ]);
  keyboard.push([{ text: "❌ Cancel", callback_data: "mig_cancel" }]);

  try {
    await ctx.reply("Which channel should I walk?", {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    // A failed picker send must not leave the run half-open.
    warn("migrate: failed to send channel picker", error);
    resetMigrationInput(migration);
    await ctx.reply("❌ Could not start a run. Try again.");
  }
}
