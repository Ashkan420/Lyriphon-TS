// Pure helpers for matching deezload's album view and its GET ALL button.
// Split from bridge/client.ts so they are unit-testable without teleproto or
// the workerd-only socket transport.

export type ViewButtonInfo = {
  text: string;
  data?: Uint8Array;
  url?: string;
  switchInline?: string;
  copyText?: string;
};

// Extract a button's action. teleproto (a fork with the Rich Messages
// schema) parses inline buttons as KeyboardInlineButton { text, type:
// InlineButtonType } — the action lives INSIDE the nested `type` object
// (InlineButtonTypeCallback.data / InlineButtonTypeUrl.url / …), NOT on the
// button. Upstream-shaped objects keep data/url directly on the button.
// className duck-typing keeps this pure and unit-testable.
export function extractButtonAction(btn: any): {
  data?: Uint8Array;
  url?: string;
  switchInline?: string;
  copyText?: string;
} {
  const t = btn?.type;
  if (t && typeof t.className === "string") {
    switch (t.className) {
      case "InlineButtonTypeCallback":
        return { data: t.data };
      case "InlineButtonTypeUrl":
        return { url: t.url };
      case "InlineButtonTypeSwitchInline":
        return { switchInline: t.query };
      case "InlineButtonTypeCopy":
        return { copyText: t.copyText };
    }
  }
  return {
    data: btn?.data,
    url: btn?.url,
    switchInline: btn?.query,
    copyText: btn?.copyText,
  };
}

// Callback data is TL bytes; compare against an ASCII prefix byte by byte.
export function bytesStartsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// Decode TL bytes to a printable ASCII string (non-printables → '?') — for
// logging what a button's callback data actually contains.
export function bytesToAscii(bytes: Uint8Array | undefined, max = 64): string {
  if (!bytes) return "";
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, max); i++) {
    const c = bytes[i];
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : "?";
  }
  return out;
}

function toHex(bytes: Uint8Array, max = 32): string {
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, max); i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return bytes.length > max ? `${out}…` : out;
}

// Find the GET ALL button on an album view, whichever way deezload renders
// it. Evidence from a real run: the track rows are URL buttons (deezer.com
// links) with NO callback data, so the action row can be deep links too — a
// data-only matcher can never press them. Preference order:
//   1. callback data starting with album/<id>/down (the original contract),
//   2. a URL containing album/<id>/down (deep-link button variant),
//   3. any button labeled GET ALL (last resort on a fresh keyboard).
export function findGetAllButton(
  buttons: ViewButtonInfo[],
  albumId: number,
): { button: ViewButtonInfo; how: "data" | "url" | "text" } | null {
  const token = `album/${albumId}/down`;
  for (const button of buttons) {
    if (button.data && bytesStartsWith(button.data, token)) {
      return { button, how: "data" };
    }
  }
  for (const button of buttons) {
    if (button.url && button.url.includes(token)) {
      return { button, how: "url" };
    }
  }
  for (const button of buttons) {
    if (/get\s*all/i.test(button.text)) {
      return { button, how: "text" };
    }
  }
  return null;
}

// Cross-sequence-safe freshness: message DATE (or edit date), not id — each
// private-chat participant has an independent id sequence in raw MTProto, so
// timestamps are the only order both sides agree on. One minute of slack for
// clock skew; accepts edits because deezload may re-render an existing view
// instead of posting a fresh one.
export function isFreshView(msg: any, startedAt: number): boolean {
  const date = typeof msg?.date === "number" ? msg.date : -Infinity;
  const edited = typeof msg?.editDate === "number" ? msg.editDate : -Infinity;
  return Math.max(date, edited) >= startedAt - 60;
}

// One-line description of a keyboard's buttons for diagnostics: text plus
// data (hex — the real bytes, never sliced away) and/or url / switch-inline
// query, so every button type a bot can render is identifiable.
export function describeButtons(buttons: ViewButtonInfo[]): string {
  if (!buttons.length) return "none";
  return buttons
    .map((b) => {
      let desc = `"${b.text}"`;
      if (b.data?.length) desc += `→data[${toHex(b.data)}]`;
      if (b.url) desc += `→url ${b.url.slice(0, 120)}`;
      if (b.switchInline) desc += `→switch ${b.switchInline.slice(0, 60)}`;
      if (!b.data?.length && !b.url && !b.switchInline) desc += "→(no action)";
      return desc;
    })
    .join(", ");
}

// Extract the /start param from a deezload deep-link button — the message a
// manual tap makes the Telegram client send. Handles t.me/telegram.me and
// tg://resolve forms; returns null for foreign links.
export function parseStartParamFor(url: string, username: string): string | null {
  const bare = username.replace(/^@/, "").toLowerCase();
  try {
    if (url.startsWith("tg://")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      if ((params.get("domain") ?? "").toLowerCase() !== bare) return null;
      return params.get("start") || null;
    }
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "t.me" && host !== "telegram.me") return null;
    if (parsed.pathname.replace(/^\//, "").toLowerCase() !== bare) return null;
    return parsed.searchParams.get("start") || null;
  } catch {
    return null;
  }
}
