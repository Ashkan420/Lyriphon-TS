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

// Reserve for the per-page header so header + body never exceeds LOG_CHUNK_MAX.
const LOG_HEADER_RESERVE = 80;
const LOG_PAGE_CONTENT_MAX = LOG_CHUNK_MAX - LOG_HEADER_RESERVE;

export type LogPage = { text: string; page: number; totalPages: number };

export function formatLogPage(page = 0): LogPage {
  const logs = allLogs();
  if (logs.length === 0) {
    return { text: "📋 No logs yet.", page: 0, totalPages: 1 };
  }

  // Newest-first so page 0 (what /logs opens on) shows recent activity.
  // Fragments from a single oversized entry stay contiguous after the reverse.
  const reversed = [...logs].reverse();
  const fragments: string[] = [];
  for (const entry of reversed) {
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
    const levelTag = entry.level === "debug" ? "DBG" : entry.level.toUpperCase();
    let entryStr = `${time} [${levelTag}] ${entry.text}\n`;
    if (entryStr.length <= LOG_PAGE_CONTENT_MAX) {
      fragments.push(entryStr);
    } else {
      while (entryStr.length > LOG_PAGE_CONTENT_MAX) {
        fragments.push(entryStr.slice(0, LOG_PAGE_CONTENT_MAX));
        entryStr = entryStr.slice(LOG_PAGE_CONTENT_MAX);
      }
      if (entryStr.length) {
        fragments.push(entryStr);
      }
    }
  }

  // Pack fragments into pages at entry/fragment boundaries.
  const pages: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const frag of fragments) {
    if (curLen + frag.length <= LOG_PAGE_CONTENT_MAX) {
      cur.push(frag);
      curLen += frag.length;
    } else {
      if (cur.length) {
        pages.push(cur);
      }
      cur = [frag];
      curLen = frag.length;
    }
  }
  if (cur.length) {
    pages.push(cur);
  }

  const totalPages = pages.length || 1;
  let p = Math.floor(page);
  if (!Number.isFinite(p) || p < 0) {
    p = 0;
  }
  if (p >= totalPages) {
    p = totalPages - 1;
  }

  const header = `📋 Logs — page ${p + 1}/${totalPages} · ${logs.length} entries\n`;
  const body = pages[p] ? pages[p].join("") : "";
  return { text: header + body, page: p, totalPages };
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
