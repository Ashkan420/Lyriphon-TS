import { describe, expect, it } from "vitest";
import { createSession, resetSession, snapshot, inMode } from "../src/session/index";
import { SessionMode } from "../src/session/types";

describe("Session API", () => {
  it("creates a fresh session", () => {
    const session = createSession();
    expect(session.mode).toBe(SessionMode.IDLE);
    expect(session.version).toBe(0);
  });

  it("resets session state", () => {
    const session = createSession();
    session.version = 5;
    const next = resetSession();
    expect(next).not.toBe(session);
    expect(next.version).toBe(0);
  });

  it("snapshots session fields", () => {
    const session = createSession();
    const snap = snapshot(session);
    expect(snap.mode).toBe("idle");
    expect(snap.version).toBe(0);
    expect(snap.audio).toBeDefined();
    expect(snap.search).toBeDefined();
  });

  it("supports inMode checks", () => {
    const session = createSession();
    expect(inMode(session, SessionMode.IDLE)).toBe(true);
    expect(inMode(session, SessionMode.SEARCH)).toBe(false);
  });
});
