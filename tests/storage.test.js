import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "../lib/storage.js"), "utf-8");
const factory = new Function(`${src}; return Storage;`);

let Storage;

beforeEach(() => {
  Storage = factory();
  browser.storage.local._clear();
});

describe("addExportedIds", () => {
  it("stores new IDs", async () => {
    await Storage.addExportedIds(["a", "b", "c"]);
    const ids = await Storage.getExportedIds();
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });

  it("accumulates IDs across calls", async () => {
    await Storage.addExportedIds(["a", "b"]);
    await Storage.addExportedIds(["c", "d"]);
    const ids = await Storage.getExportedIds();
    expect(ids).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("deduplicates IDs", async () => {
    await Storage.addExportedIds(["a", "b"]);
    await Storage.addExportedIds(["b", "c"]);
    const ids = await Storage.getExportedIds();
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });

  it("returns empty set when nothing stored", async () => {
    const ids = await Storage.getExportedIds();
    expect(ids).toEqual(new Set());
  });
});
