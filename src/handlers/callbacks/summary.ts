import { Context } from "grammy";
import { safeAnswer } from "../../utils/telegram";
import { Env } from "../../env";
import { SessionData } from "../../session/types";
import { getDisplayLyrics, tryEditSongPage } from "./index";

// Cocoon's AI summary resets on any Telegraph change; this touch re-triggers
// it with an edit that is invisible to the eye (zero-width spaces on the
// generated "Lyrics" heading — see editSongPage in services/telegraph.ts).
export async function handleRefreshSummaryCallback(ctx: Context, session: SessionData, env: Env) {
  const lastData = session.telegraph.data as { path?: string } | undefined;
  if (!lastData?.path) {
    await safeAnswer(ctx, "No active Telegraph page");
    return;
  }

  // Rebuild with what the page currently shows (a translation, if active)
  // so the refresh doesn't revert anything; the heading touch alone is the
  // content change.
  const lyrics = getDisplayLyrics(session) ?? session.telegraph.originalLyrics ?? "";

  session.telegraph.summaryRefreshCount = (session.telegraph.summaryRefreshCount ?? 0) + 1;
  const ok = await tryEditSongPage(
    env,
    lastData as any,
    lyrics,
    "ai summary refresh",
    { summaryZwsCount: session.telegraph.summaryRefreshCount },
  );

  if (ok) {
    try {
      await ctx.answerCallbackQuery({ text: "✨ AI summary refreshed" });
    } catch {}
  } else {
    await safeAnswer(ctx, "❌ Failed to refresh AI summary");
  }
}
