// TCP transport for teleproto on Cloudflare Workers.
//
// Implements the exact surface of teleproto's PromisedNetSockets
// (extensions/PromisedNetSockets.js) that Connection/PacketCodec rely on:
//   connect(port, ip), write(data), read(n), readExactly(n), readAll(),
//   close(), and the chunk-buffer + resolveRead backpressure pattern.
// Injected via the TelegramClient `networkSocket` param, backed by
// `cloudflare:sockets` connect() (raw TCP — MTProto needs it, DOs allow
// outbound sockets).

// `cloudflare:sockets` has no bundled type declarations; declare the minimal
// surface we use. Resolved at runtime by workerd.
declare module "cloudflare:sockets" {
  export function connect(
    address: string | { hostname: string; port: number },
  ): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    close(): Promise<void>;
  }>;
}

import { connect } from "cloudflare:sockets";
import { Buffer } from "node:buffer";

const DEFAULT_KEEP_ALIVE_INTERVAL = 30000;

export class WorkersTcpSocket {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private chunks: Buffer[] = [];
  private headOffset = 0;
  private available = 0;
  private closed = true;
  private canRead: Promise<boolean> = Promise.resolve(false);
  private resolveRead: ((v: boolean) => void) | undefined;
  private keepAliveInterval: number;

  constructor(_proxy: unknown, keepAliveInterval?: number) {
    // Proxy support intentionally dropped: MTProto over workers connects
    // directly. The constructor signature must stay compatible with
    // teleproto's Connection which passes (proxy, keepAliveInterval).
    this.keepAliveInterval = keepAliveInterval ?? DEFAULT_KEEP_ALIVE_INTERVAL;
  }

  async connect(port: number, ip: string): Promise<void> {
    this.chunks = [];
    this.headOffset = 0;
    this.available = 0;
    this.closed = false;
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    const sock = await connect({ hostname: ip, port });
    this.reader = sock.readable.getReader();
    this.writer = sock.writable.getWriter();

    // Pump socket → chunk buffer in the background; resolves pending reads.
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    try {
      for (;;) {
        if (!this.reader) return;
        const { done, value } = await this.reader.read();
        if (done || !value) {
          this.markClosed();
          return;
        }
        // teleproto's codecs call Buffer methods (readInt32LE, slice(-4),
        // crc32 over Buffer.concat) on everything the socket returns — the
        // boundary MUST hand over Buffers, not plain Uint8Arrays.
        this.chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        this.available += value.length;
        this.resolveRead?.(true);
      }
    } catch {
      this.markClosed();
    }
  }

  private markClosed(): void {
    this.closed = true;
    this.resolveRead?.(false);
  }

  async read(number: number): Promise<Buffer> {
    if (this.closed) throw new Error("Socket was closed");
    const ok = await this.canRead;
    if (this.closed || !ok) throw new Error("Socket was closed");
    const out = this.consume(Math.min(number, this.available));
    if (this.available === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }
    return out;
  }

  async readExactly(number: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let need = number;
    while (need > 0) {
      const part = await this.read(need);
      parts.push(part);
      need -= part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  async readAll(): Promise<Buffer> {
    if (this.closed || !(await this.canRead)) throw new Error("Socket was closed");
    const out = this.consume(this.available);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    return out;
  }

  private consume(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length - this.headOffset, n - written);
      out.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      if (this.headOffset === head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    this.available -= n;
    return out;
  }

  write(data: Uint8Array | Buffer): void {
    if (this.closed || !this.writer) throw new Error("Socket write while closed");
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Fire-and-forget mirrors teleproto's socket.write; ordering is preserved
    // by the stream. A rejected write surfaces via the pump loop / send path.
    this.writer.write(buf).catch(() => this.markClosed());
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      await this.writer?.close();
    } catch {}
    this.reader = undefined;
    this.writer = undefined;
  }

  toString(): string {
    return "WorkersTcpSocket";
  }
}

export default WorkersTcpSocket;
