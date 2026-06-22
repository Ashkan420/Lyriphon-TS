import { describe, expect, it } from "vitest";
import { escapeMd } from "../src/utils/escapeMd";
import { isValidUrl, isValidImageUrl, safeLink } from "../src/utils/urlValidation";

describe("utils", () => {
  it("escapes MarkdownV2 characters", () => {
    expect(escapeMd("hello*world_(test)")).toBe("hello\\*world\\_\\(test\\)");
  });

  it("validates normal urls", () => {
    expect(isValidUrl("https://example.com/page")).toBe(true);
    expect(isValidUrl("http://example.com")).toBe(true);
  });

  it("rejects invalid or private urls", () => {
    expect(isValidUrl("ftp://example.com")).toBe(false);
    expect(isValidUrl("http://localhost")).toBe(false);
    expect(isValidUrl("http://127.0.0.1")).toBe(false);
  });

  it("validates image urls", () => {
    expect(isValidImageUrl("https://example.com/image.jpg")).toBe(true);
    expect(isValidImageUrl("https://example.com/image.gif")).toBe(false);
  });

  it("builds safe link nodes", () => {
    const link = safeLink("Hello", "https://example.com");
    expect(link).toEqual({ tag: "a", attrs: { href: "https://example.com" }, children: ["Hello"] });
  });

  it("returns plain text when no url", () => {
    expect(safeLink("Hello", "")).toBe("Hello");
    expect(safeLink("Hello")).toBe("Hello");
  });
});
