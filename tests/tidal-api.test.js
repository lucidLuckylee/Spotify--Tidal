import { describe, it, expect, vi, beforeEach } from "vitest";

// Load the TidalAPI module by evaluating it (it's a plain script, not ESM)
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "../lib/tidal-api.js"), "utf-8");
// Wrap in a function that returns TidalAPI
const factory = new Function(`${src}; return TidalAPI;`);

let TidalAPI;

beforeEach(() => {
  TidalAPI = factory();
  vi.restoreAllMocks();
});

describe("_fetch", () => {
  it("succeeds on first try when 200", async () => {
    const mockRes = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"data": 1}',
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes);

    const result = await TidalAPI._fetch("tok", "/test");
    expect(result).toEqual({ data: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    const rateLimitRes = {
      ok: false,
      status: 429,
      headers: { get: () => "0" },
    };
    const okRes = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"ok": true}',
    };
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(rateLimitRes)
      .mockResolvedValueOnce(okRes);

    TidalAPI._sleep = vi.fn().mockResolvedValue();

    const result = await TidalAPI._fetch("tok", "/test");
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries on repeated 429", async () => {
    const rateLimitRes = {
      ok: false,
      status: 429,
      headers: { get: () => "0" },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitRes);
    TidalAPI._sleep = vi.fn().mockResolvedValue();

    await expect(TidalAPI._fetch("tok", "/test", {}, 3)).rejects.toThrow(
      "max retries exceeded"
    );
    // Initial call + 3 retries = 4 calls total
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("retries exactly N times on 429 then throws", async () => {
    const rateLimitRes = {
      ok: false,
      status: 429,
      headers: { get: () => "0" },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitRes);
    TidalAPI._sleep = vi.fn().mockResolvedValue();

    await expect(TidalAPI._fetch("tok", "/test", {}, 0)).rejects.toThrow(
      "max retries exceeded"
    );
    // With _retries=0, first 429 immediately throws
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("getUserPlaylists pagination", () => {
  function jsonRes(body) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  }

  it("returns a single page when total fits within the limit", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ uuid: `p${i}`, title: `P${i}` }));
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonRes({ items, totalNumberOfItems: 3 }));

    const result = await TidalAPI.getUserPlaylists("tok", "uid");
    expect(result).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("concatenates multiple pages until totalNumberOfItems is reached", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ uuid: `a${i}`, title: `A${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ uuid: `b${i}`, title: `B${i}` }));
    const page3 = Array.from({ length: 20 }, (_, i) => ({ uuid: `c${i}`, title: `C${i}` }));

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonRes({ items: page1, totalNumberOfItems: 120 }))
      .mockResolvedValueOnce(jsonRes({ items: page2, totalNumberOfItems: 120 }))
      .mockResolvedValueOnce(jsonRes({ items: page3, totalNumberOfItems: 120 }));

    const result = await TidalAPI.getUserPlaylists("tok", "uid");
    expect(result).toHaveLength(120);
    expect(fetch).toHaveBeenCalledTimes(3);
    // verify offset=0, 50, 100 in the requested URLs
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain("offset=0");
    expect(urls[1]).toContain("offset=50");
    expect(urls[2]).toContain("offset=100");
  });

  it("findPlaylistByName matches a playlist on a later page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ uuid: `a${i}`, title: `A${i}` }));
    const page2 = [
      ...Array.from({ length: 49 }, (_, i) => ({ uuid: `b${i}`, title: `B${i}` })),
      { uuid: "target-uuid", title: "Imported from Spotify" },
    ];

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonRes({ items: page1, totalNumberOfItems: 100 }))
      .mockResolvedValueOnce(jsonRes({ items: page2, totalNumberOfItems: 100 }));

    const found = await TidalAPI.findPlaylistByName("tok", "uid", "Imported from Spotify");
    expect(found).toEqual({ uuid: "target-uuid", title: "Imported from Spotify" });
  });
});
