import { describe, expect, it } from "vitest";
import { createAudioFlow, createSearchFlow, createEditFlow, createLyricsFlow, createTelegraphFlow } from "../src/session/flows";

describe("Flow state factories", () => {
  it("creates a fresh audio flow", () => {
    const flow = createAudioFlow();
    expect(flow.fileId).toBeUndefined();
    expect(flow.title).toBeUndefined();
    expect(flow.pendingDecision).toBeUndefined();
    expect(flow.locked).toBe(false);
  });

  it("creates a fresh search flow", () => {
    const flow = createSearchFlow();
    expect(flow.results).toBeUndefined();
    expect(flow.page).toBe(0);
  });

  it("creates a fresh edit flow", () => {
    const flow = createEditFlow();
    expect(flow.field).toBeUndefined();
    expect(flow.promptId).toBeUndefined();
  });

  it("creates a fresh lyrics flow", () => {
    const flow = createLyricsFlow();
    expect(flow.buffer).toEqual([]);
    expect(flow.messageIds).toEqual([]);
  });

  it("creates a fresh telegraph flow", () => {
    const flow = createTelegraphFlow();
    expect(flow.url).toBeUndefined();
    expect(flow.data).toBeUndefined();
  });
});
