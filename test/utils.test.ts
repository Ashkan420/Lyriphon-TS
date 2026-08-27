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

  describe("urlValidation edge cases", () => {
    it("rejects private IPv4 ranges", () => {
      expect(isValidUrl("http://10.0.0.1/x")).toBe(false);
      expect(isValidUrl("http://172.16.0.1/x")).toBe(false);
      expect(isValidUrl("http://172.31.255.255/x")).toBe(false);
      expect(isValidUrl("http://192.168.1.1/x")).toBe(false);
      expect(isValidUrl("http://169.254.1.1/x")).toBe(false);
      expect(isValidUrl("http://0.0.0.0/x")).toBe(false);
      expect(isValidUrl("http://224.0.0.1/x")).toBe(false);
    });

    it("allows public IPv4 and public-range 172.x", () => {
      expect(isValidUrl("http://8.8.8.8/x")).toBe(true);
      expect(isValidUrl("http://172.32.0.1/x")).toBe(true);
    });

    it("rejects IPv6 loopback and unique-local", () => {
      expect(isValidUrl("http://[::1]/x")).toBe(false);
      expect(isValidUrl("http://[fc00::1]/x")).toBe(false);
      expect(isValidUrl("http://[fd12::1]/x")).toBe(false);
    });

    it("rejects local/internal hostname suffixes and allows trailing dots", () => {
      expect(isValidUrl("http://box.local/x")).toBe(false);
      expect(isValidUrl("http://svc.internal/x")).toBe(false);
      expect(isValidUrl("http://my.localhost/x")).toBe(false);
      expect(isValidUrl("http://example.com./x")).toBe(true);
    });
  });
});
