// Node builtin shims for bundling teleproto into a Cloudflare Worker.
//
// teleproto's module graph pulls in node builtins it only uses on code paths
// a DO bridge never exercises (file uploads/downloads, fs-backed sessions,
// socks proxy internals). Wrangler [alias] entries redirect them here so the
// bundle resolves; any accidental runtime call throws loudly instead of
// failing obscurely.
//
// NOTE: `crypto` is deliberately NOT aliased — workerd's node:crypto is real
// and teleproto's AES/hashes (the hot path) must use the native OpenSSL.

class NotAvailableError extends Error {
  constructor(name: string) {
    super(`${name} is not available in the Workers bridge runtime`);
    this.name = "NotAvailableError";
  }
}

function thrower(name: string): any {
  return new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined; // plain value, not a thenable
      throw new NotAvailableError(`${name}.${String(prop)}`);
    },
    apply: () => {
      throw new NotAvailableError(name);
    },
  });
}

// ── fs / node:fs — downloads.js, uploads.js, StoreSession only ──────────────

export const promises = thrower("fs.promises");
export function existsSync(): boolean {
  throw new NotAvailableError("fs.existsSync");
}
export function lstatSync(): never {
  throw new NotAvailableError("fs.lstatSync");
}
export function readFileSync(): never {
  throw new NotAvailableError("fs.readFileSync");
}
export function writeFileSync(): never {
  throw new NotAvailableError("fs.writeFileSync");
}
export function createWriteStream(): never {
  throw new NotAvailableError("fs.createWriteStream");
}
export function createReadStream(): never {
  throw new NotAvailableError("fs.createReadStream");
}
const fsDefault = { promises, existsSync, lstatSync, readFileSync, writeFileSync, createWriteStream, createReadStream };
export default fsDefault;

// ── path — filename munging in uploads.js only ──────────────────────────────

export const sep = "/";
export const delimiter = ":";
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
export function dirname(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || ".";
}
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}
export function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}
export function resolve(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}
const pathDefault = { sep, delimiter, basename, dirname, extname, join, resolve };
export { pathDefault };

// ── os — InitConnection device metadata ─────────────────────────────────────

export function type(): string {
  return "Linux";
}
export function release(): string {
  return "workers";
}
export function platform(): string {
  return "linux";
}
export function hostname(): string {
  return "workers";
}
const osDefault = { type, release, platform, hostname };
export { osDefault };

// ── net — PromisedNetSockets is bypassed via networkSocket param ────────────

export function Socket(): never {
  throw new NotAvailableError("net.Socket");
}
const netDefault = { Socket };
export { netDefault };

// ── node-localstorage — StoreSession's disk backend; unused ─────────────────

export class LocalStorage {
  constructor() {
    throw new NotAvailableError("node-localstorage.LocalStorage");
  }
}
const lsDefault = { LocalStorage };
export { lsDefault };

// ── events — EventEmitter for socks internals; minimal real impl ────────────

export class EventEmitter {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(event: string, fn: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }
  off(event: string, fn: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  once(event: string, fn: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event);
    if (!set) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }
  removeListener(event: string, fn: (...args: any[]) => void): this {
    return this.off(event, fn);
  }
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
}
const eventsDefault = { EventEmitter };
export { eventsDefault };

// ── util — transitive via socks/smart-buffer ────────────────────────────────

export function inspect(): string {
  return "";
}
export function promisify(fn: any): any {
  return (...args: any[]) =>
    new Promise((resolve, reject) =>
      fn(...args, (err: any, out: any) => (err ? reject(err) : resolve(out))),
    );
}
export function inherits(ctor: any, superCtor: any): void {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}
export const deprecate = (fn: any) => fn;
const utilDefault = { inspect, promisify, inherits, deprecate };
export { utilDefault };
