import { afterEach, describe, expect, it, vi } from "vitest";
import { debug, isDebug, previewText, setDebug } from "../src/utils/logger";

describe("logger", () => {
  afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
  });

  it("debug() is suppressed by default", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    debug("hello");
    expect(spy).not.toHaveBeenCalled();
    expect(isDebug()).toBe(false);
  });

  it("debug() emits once enabled via setDebug", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    setDebug(true);
    expect(isDebug()).toBe(true);
    debug("hello");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("setDebug(false) suppresses again", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    setDebug(true);
    setDebug(false);
    debug("hello");
    expect(spy).not.toHaveBeenCalled();
  });

  it("previewText joins first lines and notes remaining", () => {
    const text = "line one\nline two\nline three\nline four\nline five";
    const preview = previewText(text, 3, 180);
    expect(preview).toContain("line one | line two | line three");
    expect(preview).toContain("+2 more lines");
  });

  it("previewText handles empty and short text", () => {
    expect(previewText("")).toBe("(empty)");
    expect(previewText("  hello  ")).toBe("hello");
  });
});
