// Lightweight logger wrapping console.* with a consistent prefix.
//
// Scoping model: one Workers isolate can host MANY SessionDO instances (one per
// user) running concurrently — blockConcurrencyWhile only serializes a single
// DO's own updates, so module-level globals would mix users. Log buffers and
// the debug flag are therefore keyed by a per-request scope (the user id),
// established with AsyncLocalStorage via runWithLogScope() at the start of each
// DO fetch (src/do.ts). Entries logged outside any scope (e.g. alarm-driven
// deletes) land in the "_global" scope. /logs dumps the merged view across all
// scopes, newest last.

import { AsyncLocalStorage } from "node:async_hooks";
import { LOG_BUFFER_SIZE } from "../config";

const PREFIX = "[lyriphon]";

type LogLevel = "log" | "warn" | "error" | "debug";
type LogEntry = { ts: number; level: LogLevel; text: string };

const logScope = new AsyncLocalStorage<string>();
const GLOBAL_SCOPE = "_global";

export function runWithLogScope<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  return logScope.run(scope, fn);
}

function currentScope(): string {
  return logScope.getStore() ?? GLOBAL_SCOPE;
}

const buffers = new Map<string, LogEntry[]>();
const debugFlags = new Map<string, boolean>();
const MAX = LOG_BUFFER_SIZE;

function getBuffer(scope: string): LogEntry[] {
  let list = buffers.get(scope);
  if (!list) {
    list = [];
    buffers.set(scope, list);
  }
  return list;
}

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

/**
 * Compact multi-line preview for logs. Joins the first few lines with " | "
 * so Telegram /logs stays readable as single log rows.
 */
export function previewText(text: string, maxLines = 3, maxChars = 180): string {
  const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "(empty)";
  }

  const lines = normalized.split("\n");
  let preview = lines.slice(0, maxLines).join(" | ");
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars)}…`;
  }

  if (lines.length > maxLines) {
    return `${preview} (+${lines.length - maxLines} more lines, ${normalized.length} chars)`;
  }
  if (normalized.length > maxChars) {
    return `${preview} (${normalized.length} chars)`;
  }
  return preview;
}

function push(level: LogLevel, args: unknown[]): void {
  const text = args.map(stringifyArg).join(" ");
  const list = getBuffer(currentScope());
  list.push({ ts: Date.now(), level, text });
  if (list.length > MAX) {
    list.splice(0, list.length - MAX);
  }
}

export function getRecentLogs(limit = MAX): LogEntry[] {
  return getBuffer(currentScope()).slice(-limit);
}

// Merged view across every scope, oldest → newest (owner's /logs dump).
function allLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const list of buffers.values()) entries.push(...list);
  return entries.sort((a, b) => a.ts - b.ts);
}

// Telegram message limit is 4096 chars; stay under it so entries carrying
// full lyrics/translations survive intact instead of being truncated away.
const LOG_CHUNK_MAX = 3800;

export function formatLogsForTelegram(limit = 40): string[] {
  const logs = allLogs().slice(-limit);
  if (logs.length === 0) {
    return ["📋 No logs yet."];
  }

  const header = `📋 Recent logs (${logs.length})\n`;
  const lines = logs.map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
    const levelTag = entry.level === "debug" ? "DBG" : entry.level.toUpperCase();
    return `${time} [${levelTag}] ${entry.text}`;
  });

  // Pack entries into chunks at entry boundaries; a single entry larger than
  // a whole chunk (full lyrics dump) is hard-split so nothing is dropped.
  const chunks: string[] = [];
  let current = header;
  for (const line of lines) {
    let entry = line + "\n";
    if (current.length + entry.length <= LOG_CHUNK_MAX) {
      current += entry;
      continue;
    }
    if (current.trim()) {
      chunks.push(current);
    }
    while (entry.length > LOG_CHUNK_MAX) {
      chunks.push(entry.slice(0, LOG_CHUNK_MAX));
      entry = entry.slice(LOG_CHUNK_MAX);
    }
    current = entry;
  }
  if (current.trim()) {
    chunks.push(current);
  }
  return chunks;
}

export function setDebug(enabled: boolean): void {
  debugFlags.set(currentScope(), enabled);
}

export function isDebug(): boolean {
  return debugFlags.get(currentScope()) ?? false;
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
  if (isDebug()) {
    push("debug", args);
    console.log(PREFIX, "[debug]", ...args);
  }
}
