import { describe, it, expect, vi, beforeEach } from "vitest";

// Load the TidalAPI module by evaluating it (it's a plain script, not ESM)
import { readFileSync } from "fs";
import { resolve } from "path";

const matchSrc = readFileSync(resolve(__dirname, "../lib/track-match.js"), "utf-8");
const apiSrc = readFileSync(resolve(__dirname, "../lib/tidal-api.js"), "utf-8");
// Wrap in a function that returns TidalAPI. track-match.js must load first
// because tidal-api.js calls into the global `TrackMatch`.
const factory = new Function(`${matchSrc}\n${apiSrc}; return TidalAPI;`);

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

describe("searchByName dual-query fallback", () => {
  const jsonRes = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });

  it("merges full-title and simplified-title search results when title has parens", async () => {
    // Full query (contains parens) returns only the studio version — the
    // qualifier hard-reject would zero it out and we'd return null. The
    // simplified-title fallback returns the live version, which scores high.
    const studio = {
      id: 100,
      title: "Der Rest meines Lebens",
      artists: [{ name: "Kummer" }, { name: "Henning May" }],
      duration: 230,
      album: { title: "Studio" },
    };
    const live = {
      id: 200,
      title: "Der Rest meines Lebens - Live aus der Wuhlheide",
      artists: [{ name: "KUMMER" }, { name: "Henning May" }],
      duration: 230,
      album: { title: "Live" },
    };

    const fetchMock = vi.fn();
    // Both queries fire in parallel; route by query-string content.
    fetchMock.mockImplementation(async (url) => {
      if (url.includes(encodeURIComponent("(Live aus der Wuhlheide)"))) {
        return jsonRes({ tracks: { items: [studio] } });
      }
      return jsonRes({ tracks: { items: [studio, live] } });
    });
    globalThis.fetch = fetchMock;

    const source = {
      name: "Der Rest meines Lebens (Live aus der Wuhlheide)",
      artists: ["Kummer", "Henning May"],
      durationMs: 230000,
    };
    const match = await TidalAPI.searchByName("tok", source);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(match).not.toBeNull();
    expect(match.id).toBe(200);
  });

  it("strips ' - ' separators in the fallback query (Ricochet/STARSET case)", async () => {
    // Full query "Ricochet - Acoustic Version STARSET" returns only the
    // studio cut; the dash-stripped fallback "Ricochet  Acoustic Version
    // STARSET" surfaces the catalogue's "(Acoustic Version)" entry.
    const studio = {
      id: 100,
      title: "Ricochet",
      artists: [{ name: "STARSET" }],
      duration: 226,
      album: { title: "Vessels" },
    };
    const acoustic = {
      id: 200,
      title: "Ricochet (Acoustic Version)",
      artists: [{ name: "STARSET" }],
      duration: 292,
      album: { title: "Vessels 2.0" },
    };

    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (url) => {
      // Cleaned query has no `-` (encoded as %20%20 from doubled spaces).
      if (url.includes(encodeURIComponent("Ricochet - Acoustic Version"))) {
        return jsonRes({ tracks: { items: [studio] } });
      }
      return jsonRes({ tracks: { items: [studio, acoustic] } });
    });
    globalThis.fetch = fetchMock;

    const source = {
      name: "Ricochet - Acoustic Version",
      artists: ["STARSET"],
      durationMs: 292493,
      album: "Vessels 2.0",
    };
    const match = await TidalAPI.searchByName("tok", source);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(match).not.toBeNull();
    expect(match.id).toBe(200);
  });

  it("retries with primary artist only when full-artist query returns 0 hits", async () => {
    // Spotify credits ["Rubi", "FABE BROWN"] but Tidal lists only "Rubi" —
    // the full-artist query returns nothing; primary-artist fallback finds it.
    const tidalTrack = {
      id: 999,
      title: "ONLY 4 LIFE",
      version: "Remix",
      artists: [{ name: "Rubi" }],
      duration: 148,
      album: { title: "ONLY 4 LIFE (Remix)" },
    };

    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("FABE")) return jsonRes({ tracks: { items: [] } });
      return jsonRes({ tracks: { items: [tidalTrack] } });
    });
    globalThis.fetch = fetchMock;

    const source = {
      name: "ONLY 4 LIFE - Remix",
      artists: ["Rubi", "FABE BROWN"],
      album: "ONLY 4 LIFE (Remix)",
      durationMs: 148800,
    };
    const match = await TidalAPI.searchByName("tok", source);
    // 2 initial queries (full + cleaned, both with FABE) + at least 1 fallback.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(match).not.toBeNull();
    expect(match.id).toBe(999);
  });

  it("skips the fallback search when title has no parens/dashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({
      tracks: { items: [{
        id: 1,
        title: "Hey Jude",
        artists: [{ name: "The Beatles" }],
        duration: 431,
      }] },
    }));
    globalThis.fetch = fetchMock;

    const source = { name: "Hey Jude", artists: ["The Beatles"], durationMs: 431000 };
    const match = await TidalAPI.searchByName("tok", source);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(match.id).toBe(1);
  });
});
