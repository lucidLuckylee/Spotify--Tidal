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
