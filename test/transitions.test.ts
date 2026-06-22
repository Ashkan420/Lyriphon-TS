import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session/index";
import { captureVersion, isStale, transition, VALID_TRANSITIONS, onExitMode } from "../src/session/transitions";
import { SessionMode } from "../src/session/types";

describe("Session transitions", () => {
  it("changes mode and increments version", async () => {
    const session = createSession();
    const before = session.version;
    const result = await transition(session, SessionMode.SEARCH);
    expect(result).toBe(true);
    expect(session.mode).toBe(SessionMode.SEARCH);
    expect(session.version).toBe(before + 1);
  });

  it("no-ops when transitioning to the same mode", async () => {
    const session = createSession();
    const before = session.version;
    const result = await transition(session, SessionMode.IDLE);
    expect(result).toBe(true);
    expect(session.version).toBe(before);
  });

  it("captures version and detects staleness", () => {
    const session = createSession();
    const captured = captureVersion(session);
    session.version += 1;
    expect(isStale(session, captured)).toBe(true);
  });

  it("allows idle from any mode", async () => {
    const session = createSession();
    session.mode = SessionMode.SEARCH;
    const result = await transition(session, SessionMode.IDLE);
    expect(result).toBe(true);
    expect(session.mode).toBe(SessionMode.IDLE);
  });

  it("respects valid transition map", () => {
    expect(VALID_TRANSITIONS[SessionMode.IDLE]).toBeNull();
    expect(VALID_TRANSITIONS[SessionMode.SEARCH]).toContain(SessionMode.IDLE);
    expect(VALID_TRANSITIONS[SessionMode.EDIT_FIELD]).toContain(SessionMode.IDLE);
  });

  it("runs cleanup hooks when leaving a mode", async () => {
    const session = createSession();
    session.mode = SessionMode.EDIT_FIELD;
    session.edit.promptId = 123;

    const bot = { deleteMessage: vi.fn().mockResolvedValue(undefined) };
    await transition(session, SessionMode.IDLE, bot, 456);

    expect(bot.deleteMessage).toHaveBeenCalledWith(456, 123);
  });
});
