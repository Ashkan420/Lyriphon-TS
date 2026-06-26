import { afterEach, describe, expect, it, vi } from "vitest";
import { debug, isDebug, setDebug } from "../src/utils/logger";

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
});
