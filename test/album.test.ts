import { describe, expect, it } from "vitest";
import { parseAlbumTarget, routeForSelection } from "../src/handlers/album";

describe("parseAlbumTarget", () => {
  it("extracts the album id from a deezload deep link", () => {
    expect(parseAlbumTarget("https://t.me/deezload2bot?start=deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("http://t.me/deezload2bot?start=deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("/start deezertalbum86994002")).toEqual({ albumId: 86994002 });
  });

  it("accepts a bare token and a bare id", () => {
    expect(parseAlbumTarget("deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("86994002")).toEqual({ albumId: 86994002 });
  });

  it("treats free text as a query", () => {
    expect(parseAlbumTarget("2001 dr dre")).toEqual({ query: "2001 dr dre" });
    // A track/deezer link with no album token is a query too.
    expect(parseAlbumTarget("https://t.me/deezload2bot?start=deezerttrack123")).toEqual({
      query: "https://t.me/deezload2bot?start=deezerttrack123",
    });
  });
});

describe("routeForSelection", () => {
  it("uses per-track jobs up to the threshold and one album job above it", () => {
    expect(routeForSelection(1)).toBe("tracks");
    expect(routeForSelection(5)).toBe("tracks");
    expect(routeForSelection(6)).toBe("album");
    expect(routeForSelection(20)).toBe("album");
  });

  it("honors a custom threshold", () => {
    expect(routeForSelection(3, 3)).toBe("tracks");
    expect(routeForSelection(4, 3)).toBe("album");
  });
});
