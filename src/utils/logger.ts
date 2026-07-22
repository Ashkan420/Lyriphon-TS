// Lightweight logger wrapping console.* with a consistent prefix.
//
// `debug(...)` only emits when the module-level `debugEnabled` flag is on.
// The flag is per-DO (per-user): each Durable Object isolate handles one user
// single-threaded under blockConcurrencyWhile, and there is no shared global
// state across isolates. So toggling /debug enables verbose logs only for that
// admin's own DO — exactly the scope that's useful when debugging their own
// interactions. `setDebug` is called at the start of each DO fetch (after
// loadSession, before handleUpdate), so the flag is set before any handler runs.

import { LOG_BUFFER_SIZE } from "../config";

const PREFIX = "[lyriphon]";

type LogLevel = "log" | "warn" | "error" | "debug";
type LogEntry = { ts: number; level: LogLevel; text: string };

const buffer: LogEntry[] = [];
const MAX = LOG_BUFFER_SIZE;

let debugEnabled = false;

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.message;
  }
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function push(level: LogLevel, args: unknown[]): void {
  const text = args.map(stringifyArg).join(" ");
  buffer.push({ ts: Date.now(), level, text });
  if (buffer.length > MAX) {
    buffer.splice(0, buffer.length - MAX);
  }
}

export function getRecentLogs(limit = MAX): LogEntry[] {
  return buffer.slice(-limit);
}

export function formatLogsForTelegram(limit = 40): string {
  const logs = getRecentLogs(limit);
  if (logs.length === 0) {
    return "📋 No logs yet.";
  }

  const lines = logs.map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
    const levelTag = entry.level === "debug" ? "DBG" : entry.level.toUpperCase();
    return `${time} [${levelTag}] ${entry.text}`;
  });

  const header = `📋 Recent logs (${logs.length})\n`;
  const body = lines.join("\n");

  // Telegram message limit is 4096 characters
  if (header.length + body.length <= 4096) {
    return header + body;
  }

  // Truncate from the top, keep newest
  let truncated = header;
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = truncated + lines[i] + "\n";
    if (candidate.length > 4000) {
      truncated += `\n... (${lines.length - i} older entries truncated)`;
      break;
    }
    truncated = candidate;
  }
  return truncated;
}

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

export function log(...args: unknown[]): void {
  push("log", args);
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  push("warn", args);
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  push("error", args);
  console.error(PREFIX, ...args);
}

export function debug(...args: unknown[]): void {
  if (debugEnabled) {
    push("debug", args);
    console.log(PREFIX, "[debug]", ...args);
  }
}
