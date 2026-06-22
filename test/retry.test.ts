import { describe, expect, it, vi } from "vitest";
import { retryAsync } from "../src/utils/retry";

describe("retryAsync", () => {
  it("returns the result on first attempt", async () => {
    const result = await retryAsync(async () => "ok", 2, 0.01);
    expect(result).toBe("ok");
  });

  it("retries on failure and eventually returns null", async () => {
    let count = 0;
    const result = await retryAsync(async () => {
      count += 1;
      throw new Error("fail");
    }, 1, 0.01);
    expect(result).toBeNull();
    expect(count).toBe(2);
  });
});
