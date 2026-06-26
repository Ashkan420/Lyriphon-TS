// Lightweight logger wrapping console.* with a consistent prefix.
//
// `debug(...)` only emits when the module-level `debugEnabled` flag is on.
// The flag is per-DO (per-user): each Durable Object isolate handles one user
// single-threaded under blockConcurrencyWhile, and there is no shared global
// state across isolates. So toggling /debug enables verbose logs only for that
// admin's own DO — exactly the scope that's useful when debugging their own
// interactions. `setDebug` is called at the start of each DO fetch (after
// loadSession, before handleUpdate), so the flag is set before any handler runs.

const PREFIX = "[lyriphon]";

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

export function log(...args: unknown[]): void {
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

export function debug(...args: unknown[]): void {
  if (debugEnabled) {
    console.log(PREFIX, "[debug]", ...args);
  }
}
