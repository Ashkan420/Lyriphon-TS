import { Context } from "grammy";
import { resetSessionData } from "../session/flows";
import { SessionData } from "../session/types";

export async function startCommand(ctx: Context, session: SessionData) {
  resetSessionData(session);

  const userName = ctx.from?.first_name ?? "there";
  const welcomeText = `Hello ${userName}!

I'm your Lyrics & Telegraph bot. Here's what I can do:
- Send song lyrics via /song
- Attach lyrics to music files automatically
- Create Telegraph pages for tracks

Type /help for a full list of commands.`;

  await ctx.reply(welcomeText);
}

export async function helpCommand(ctx: Context) {
  const helpText = `Lyriphon Bot Commands

/song - Search for a song and create a lyrics page
/help - Show this help message

How to use:
1. Search with /song
2. Pick a track from the results
3. Send a music file in this chat to attach the Lyrics button
4. Send it to any channel where I'm an admin

Inline mode:
Type @lyriphon_bot in any chat to search directly.`;

  await ctx.reply(helpText);
}
