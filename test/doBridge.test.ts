import { afterEach, describe, expect, it, vi } from "vitest";

// cloudflare:sockets is workerd-only; stub it before the DO module graph loads.
vi.mock("cloudflare:sockets", () => ({ connect: vi.fn(async () => {
  throw new Error("no sockets in tests");
}) }));

// Minimal fake DurableObjectState capturing storage + alarm + waitUntil.
function fakeState() {
  const store = new Map<string, any>();
  const waits: Promise<unknown>[] = [];
  return {
    storage: {
      get: vi.fn(async (key: string) => store.get(key)),
      put: vi.fn(async (key: string, value: any) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
    waitUntil: vi.fn((p: Promise<unknown>) => waits.push(p)),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
    waits,
    store,
  } as any;
}

function fakeEnv() {
  return {
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "hash",
    BRIDGE_CHAT_ID: "777",
    BOT_TOKEN: "t",
    TELEGRAPH_ACCESS_TOKEN: "x",
    WEBHOOK_SECRET_TOKEN: "s",
    DB: {} as any,
    SESSION_DO: {} as any,
    BRIDGE_DO: {} as any,
  } as any;
}

// Import AFTER fakes are defined is fine — the DO constructor only builds
// BridgeClient/BridgeAuth/BridgeJobs lazily; no teleproto connect happens.
import { BridgeDO } from "../src/doBridge";
import { AUTOFETCH_JOB_TIMEOUT_MS } from "../src/config";

function enqueueRequest(body: Record<string, unknown>) {
  return new Request("https://bridge/enqueue", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("BridgeDO", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a job when idle: persists it, arms the watchdog, returns ok", async () => {
    const state = fakeState();
    const env = fakeEnv();
    const dof = new BridgeDO(state, env);

    const res = await dof.fetch(enqueueRequest({ token: "tok-1", trackId: 42, chatId: 555 }));
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(state.storage.put).toHaveBeenCalledWith(
      "bridge:currentJob",
      expect.objectContaining({ token: "tok-1", trackId: 42, chatId: 555 }),
    );
    expect(state.setAlarm).toHaveBeenCalledWith(
      expect.any(Number),
    );
    const alarmAt = (state.setAlarm.mock.calls[0][0] as number) - Date.now();
    expect(alarmAt).toBeGreaterThan(AUTOFETCH_JOB_TIMEOUT_MS - 5000);
    expect(alarmAt).toBeLessThanOrEqual(AUTOFETCH_JOB_TIMEOUT_MS);
    expect(state.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("queues a second job while one is in flight, reporting position 2", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    // Block the first job's background run so processing stays true.
    const blocked = new Promise(() => {});
    const runJobSpy = vi.spyOn(dof as any, "runJob").mockReturnValue(blocked);

    const first = await dof.fetch(enqueueRequest({ token: "tok-1", trackId: 42, chatId: 555 }));
    const firstBody = await first.json() as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.position).toBe(1);

    const second = await dof.fetch(enqueueRequest({ token: "tok-2", trackId: 43, chatId: 556 }));
    const secondBody = await second.json() as any;
    expect(secondBody.ok).toBe(true);
    expect(secondBody.position).toBe(2);
    expect(state.storage.put).toHaveBeenCalledWith(
      "bridge:queue",
      expect.arrayContaining([expect.objectContaining({ token: "tok-2" })]),
    );
    runJobSpy.mockRestore();
  });

  it("rejects when the queue is full", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    // Pre-fill the queue past the cap.
    const { AUTOFETCH_MAX_QUEUE } = await import("../src/config");
    const full: any[] = [];
    for (let i = 0; i < AUTOFETCH_MAX_QUEUE; i++) {
      full.push({ token: `tok-${i}`, trackId: i, chatId: 1, startedAt: Date.now() });
    }
    state.store.set("bridge:queue", full);

    const res = await dof.fetch(enqueueRequest({ token: "tok-new", trackId: 99, chatId: 2 }));
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("queue_full");
  });

  it("rejects malformed enqueue payloads", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    const res = await dof.fetch(enqueueRequest({ token: "" }));
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(state.waitUntil).not.toHaveBeenCalled();
  });

  it("auth/start with a phone kicks off the flow without blocking (fire-and-forget)", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    const res = await dof.fetch(new Request("https://bridge/auth/start", {
      method: "POST",
      body: JSON.stringify({ phone: "+15551234567" }),
    }));
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.state).toBe("started");
    // The MTProto work is deferred — waitUntil used for the sign-in task.
    expect(state.waitUntil).toHaveBeenCalledTimes(1);

    // The background sign-in task is now running against fake socket state;
    // let it settle so its (expected) rejection doesn't leak past the test.
    await state.waits[0].catch(() => {});
  });

  it("auth/code without a pending flow reports an error quickly", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    const res = await dof.fetch(new Request("https://bridge/auth/code", {
      method: "POST",
      body: JSON.stringify({ code: "12345" }),
    }));
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("no sign-in flow");
  });

  it("watchdog alarm fails a persisted stuck job and clears it", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    const job = { token: "tok-9", trackId: 1, chatId: 2, startedAt: Date.now() - 300000 };
    state.store.set("bridge:currentJob", job);

    const sendBridgeText = vi.fn(async () => {});
    vi.doMock("../src/bridge/client", async (importOriginal) => {
      const actual = await importOriginal<any>();
      return { ...actual, sendBridgeText };
    });

    await dof.alarm();

    expect(state.storage.delete).toHaveBeenCalledWith("bridge:currentJob");
    vi.doUnmock("../src/bridge/client");
  });

  it("stale alarm after normal completion is a no-op", async () => {
    const state = fakeState();
    const dof = new BridgeDO(state, fakeEnv());

    await expect(dof.alarm()).resolves.toBeUndefined();
    expect(state.storage.delete).not.toHaveBeenCalled();
  });
});
