const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

function isPrivateHost(hostname: string): boolean {
  if (!hostname) {
    return true;
  }

  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  const parsedIp = parseIpLiteral(host);
  if (!parsedIp) {
    return false;
  }

  return (
    parsedIp.isPrivate ||
    parsedIp.isLoopback ||
    parsedIp.isLinkLocal ||
    parsedIp.isReserved ||
    parsedIp.isUnspecified
  );
}

type IpInfo = {
  isPrivate: boolean;
  isLoopback: boolean;
  isLinkLocal: boolean;
  isReserved: boolean;
  isUnspecified: boolean;
};

function parseIpLiteral(host: string): IpInfo | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c, d] = host.split(".").map(Number);
    if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    return {
      isPrivate: a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
      isLoopback: a === 127,
      isLinkLocal: a === 169 && b === 254,
      isReserved: a >= 224,
      isUnspecified: a === 0,
    };
  }
  if (/^\[[0-9a-fA-F:.]+\]$/.test(host)) {
    const addr = host.slice(1, -1);
    const groups = addr.split(":").filter(Boolean);
    if (groups.length === 0) {
      return null;
    }
    const lower = addr.toLowerCase();
    return {
      isPrivate: lower.startsWith("fc") || lower.startsWith("fd"),
      isLoopback: lower === "::1",
      isLinkLocal: lower.startsWith("fe80"),
      isReserved: lower.startsWith("ff"),
      isUnspecified: lower === "::",
    };
  }
  return null;
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    return !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isValidImageUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  return /^https?:\/\/.*\.(jpg|jpeg|png|webp)$/i.test(url);
}

export function safeLink(text: string, url?: string): string {
  if (!url) {
    return escapeHtml(text);
  }
  const safeUrl = escapeHtml(url);
  return `<a href="${safeUrl}">${escapeHtml(text)}</a>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
