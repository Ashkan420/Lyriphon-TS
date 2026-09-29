// Normalizing one channel message for the /migrate classifier.
//
// Leaf module with no imports, for the same reason as ./scanErrors: the real
// reader lives next to the MTProto transport, which pulls in
// `cloudflare:sockets` and cannot be unit-tested. Keeping the shape-reading
// here means a field-path mistake is caught by a test instead of by a live
// run silently reporting every keyed post as buttonless.

// One channel message, reduced to what the classifier needs. Deliberately
// free of teleproto types so it can be built from plain objects in tests.
export type HistoryMessage = {
  messageId: number;
  kind: "audio" | "other";
  // Media-group id — non-null means the post is part of an album, which is
  // never a single music file (FR-012).
  groupId: number | null;
  // False for a post the run's own admin did not make (FR-011).
  fromSelf: boolean;
  // True when the post is a FORWARD. Telegram refuses to edit a forwarded
  // message ("message can't be edited") no matter who has admin rights, so
  // these are never actionable and must never be offered.
  forwarded: boolean;
  caption?: string;
  buttons?: Array<{ text: string; url?: string }>;
  audio?: { title?: string; performer?: string; fileName?: string } | null;
};

// Who may be credited with a channel post. `userId` is authoritative when
// Telegram reports one; `username`/`name` are only a fallback for posts where
// the reporter identifies by display name.
export type PosterIdentity = { userId?: number; username?: string; name?: string };

// Decide whether a channel post was made by this bot (FR-011).
//
// Telegram does not always name the poster of a channel post: `fromId` is
// often absent and only `post_author` (a display name) is left. So:
//   - a numeric id that differs from ours  → not ours, ignore
//   - a name/username that differs         → not ours, ignore
//   - nothing to compare against           → treat as ours
// The last case is a deliberate fail-open: in the admin's own lyrics channel
// the song posts are the bot's, and failing closed would silently offer zero
// candidates on the commonest message shape.
export function isOwnPoster(msg: any, poster?: PosterIdentity): boolean {
  const fromId = msg?.fromId ?? msg?.postAuthorId;
  const theirs = typeof fromId === "object" && fromId !== null ? fromId.userId : undefined;
  if (typeof theirs === "number") {
    return poster?.userId === undefined ? true : theirs === poster.userId;
  }

  const author: string | undefined = msg?.postAuthor ?? undefined;
  if (author) {
    const mine = [poster?.username, poster?.name].filter(Boolean) as string[];
    if (mine.length) {
      const normalized = author.trim().toLowerCase().replace(/^@/, "");
      return mine.some((m) => m.trim().toLowerCase().replace(/^@/, "") === normalized);
    }
  }
  return true;
}

// Flatten the inline keyboard of a channel message, if it has one.
//
// THE URL IS NOT ON THE BUTTON. teleproto's markup is:
//
//   ReplyInlineMarkup      { rows }
//     → KeyboardInlineButtonRow { buttons }
//       → KeyboardInlineButton  { text, type }    ← type carries the URL
//         → InlineButtonTypeUrl { url }
//
// Reading `button.url` yields nothing at all, which silently made every keyed
// post look buttonless: it was then offered again (FR-013 broken), and
// existing_markup came back null so attaching replaced whatever was there
// instead of merging (FR-013a broken).
//
// Callback-only buttons have no url and are dropped — they cannot be a Lyrics
// link, and keeping them out means `existing_markup` stays an accurate record
// of what can actually be re-attached.
export function extractHistoryButtons(msg: any): Array<{ text: string; url?: string }> {
  const rows: any[] = msg?.replyMarkup?.rows ?? [];
  const out: Array<{ text: string; url?: string }> = [];
  for (const row of rows) {
    for (const button of row?.buttons ?? []) {
      const url = button?.type?.url;
      if (typeof url === "string" && url) {
        out.push({ text: String(button.text ?? ""), url });
      }
    }
  }
  return out;
}

export function normalizeHistoryMessage(msg: any, poster?: PosterIdentity): HistoryMessage {
  const doc = msg?.media?.document;
  const mimeType: string = String(doc?.mimeType ?? "");
  const isAudio =
    mimeType.startsWith("audio/") ||
    mimeType === "application/ogg" ||
    // Telegram marks voice notes as audio documents too; a song posted by this
    // bot arrives as a plain audio document.
    (typeof msg?.voice === "boolean" && msg.voice);

  const attrs: any[] = doc?.attributes ?? [];
  const titleAttr = attrs.find((a) => a?.className === "DocumentAttributeAudio");
  const filenameAttr = attrs.find((a) => a?.className === "DocumentAttributeFilename");

  return {
    messageId: msg.id,
    kind: isAudio ? "audio" : "other",
    groupId: msg?.groupedId ?? null,
    fromSelf: isOwnPoster(msg, poster),
    // fwdFrom is set on every forwarded message, however it was produced —
    // that is the one signal that predicts "message can't be edited".
    forwarded: Boolean(msg?.fwdFrom),
    caption: typeof msg?.message === "string" && msg.message ? msg.message : undefined,
    buttons: extractHistoryButtons(msg),
    audio: isAudio
      ? {
          title: titleAttr?.title ?? undefined,
          performer: titleAttr?.performer ?? undefined,
          fileName: filenameAttr?.fileName ?? undefined,
        }
      : null,
  };
}
