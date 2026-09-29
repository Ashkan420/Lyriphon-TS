// Error classification for the /migrate history scan.
//
// Deliberately a leaf module with no imports: it sits next to the MTProto
// client, but the client pulls in `cloudflare:sockets`, which unit tests
// cannot resolve. Keeping these two predicates here means they are testable
// without dragging the whole transport into the test graph.

// FLOOD_WAIT arrives as a typed error carrying `.seconds`. Nothing else in
// this repo handles it because nothing else does bulk reads — structural
// detection keeps us from depending on a deep import path that has moved
// between teleproto releases.
//
// Returns the number of seconds to wait, or null when this is not a flood.
export function floodWaitSeconds(error: unknown): number | null {
  const err = error as any;
  if (!err) return null;
  const name = String(err.constructor?.name ?? err.name ?? "");
  const message = String(err.message ?? "");
  const isFlood = name.includes("FloodWait") || /FLOOD_WAIT/i.test(message);
  if (!isFlood) return null;
  return typeof err.seconds === "number" && err.seconds > 0 ? err.seconds : 1;
}

// Errors that mean "this account cannot read that channel" rather than "try
// again later". Telegram reports the same condition several ways depending on
// how the channel was reached, so match on the documented message codes.
//
// This is what turns a raw teleproto stack trace into something the admin can
// act on — the plain message being that the signed-in account must be added to
// the channel.
export function unreadableReason(error: unknown): string | null {
  const err = error as any;
  const text = String(err?.errorMessage ?? err?.message ?? err ?? "");
  // teleproto's own wording when a numeric id resolves to nothing — the
  // "Could not find the input entity for {PeerChannel}" that surfaced on the
  // first live run, before the dialog priming was added. Still the same
  // condition: the account cannot reach that channel.
  const membership =
    /CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|CHAT_ADMIN_REQUIRED|PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID|NOT_ADMIN|USER_BANNED_IN_CHANNEL|Could not find the input entity/i;
  if (!membership.test(text)) return null;
  return "the signed-in Telegram account can't read this channel — it needs to be added to it as a member";
}
