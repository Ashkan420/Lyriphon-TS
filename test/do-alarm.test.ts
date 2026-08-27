import { describe, expect, it } from "vitest";
import { nextAlarmTime } from "../src/do";

describe("nextAlarmTime", () => {
  it("returns null for an empty queue", () => {
    expect(nextAlarmTime([])).toBeNull();
  });

  it("returns the earliest deleteAt", () => {
    expect(nextAlarmTime([{ deleteAt: 500 }, { deleteAt: 100 }, { deleteAt: 300 }])).toBe(100);
  });
});
