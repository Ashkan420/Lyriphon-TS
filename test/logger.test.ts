import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debug,
  isDebug,
  previewText,
  setDebug,
  runWithLogScope,
  log,
  getRecentLogs,
  formatLogPage,
} from "../src/utils/logger";

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

  it("keeps buffers and debug flags separate per scope", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWithLogScope("user-a", async () => {
      setDebug(true);
      log("scope-test-from-a");
      expect(isDebug()).toBe(true);
      expect(getRecentLogs().some((e) => e.text === "scope-test-from-a")).toBe(true);
    });
    await runWithLogScope("user-b", async () => {
      expect(isDebug()).toBe(false); // not affected by user-a
      log("scope-test-from-b");
      expect(getRecentLogs().some((e) => e.text === "scope-test-from-a")).toBe(false);
    });
    spy.mockRestore();
  });

  describe("formatLogPage", () => {
    // Overflow the 120-entry buffer with unique markers so assertions are
    // deterministic: pre-existing entries get evicted and the surviving
    // window is mark-031 … mark-150 (stable sort keeps insertion order for
    // identical Date.now() timestamps).
    const FIRST = 31;
    const LAST = 150;
    const fill = () => {
      for (let i = 1; i <= 150; i++) {
        log(`mark-${String(i).padStart(3, "0")} padding-padding-padding`);
      }
    };

    it("defaults to the newest page (y/y) with the latest entry at the bottom", () => {
      fill();
      const pg = formatLogPage();
      expect(pg.page).toBe(pg.totalPages - 1);
      expect(pg.text).toContain(`page ${pg.totalPages}/${pg.totalPages}`);
      expect(
        pg.text.trimEnd().endsWith(`mark-${String(LAST).padStart(3, "0")} padding-padding-padding`),
      ).toBe(true);
    });

    it("page 0 is the oldest page, oldest → newest within a page", () => {
      fill();
      const pg = formatLogPage(0);
      expect(pg.text).toContain("page 1/");
      expect(pg.text).toContain(`mark-${String(FIRST).padStart(3, "0")}`);
      expect(pg.text).not.toContain(`mark-${String(LAST).padStart(3, "0")}`);
      const first = pg.text.indexOf(`mark-${String(FIRST).padStart(3, "0")}`);
      const second = pg.text.indexOf(`mark-${String(FIRST + 1).padStart(3, "0")}`);
      expect(first).toBeLessThan(second);
    });
  });
});
