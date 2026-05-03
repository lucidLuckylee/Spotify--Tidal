import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "../lib/track-match.js"), "utf-8");
const factory = new Function(`${src}; return TrackMatch;`);

let TrackMatch;
beforeEach(() => { TrackMatch = factory(); });

const t = (name, artists, opts = {}) => ({
  name,
  artists,
  album: opts.album || "",
  durationMs: opts.durationMs || 0,
});

const cand = (id, title, artists, opts = {}) => ({
  id,
  title,
  artists: artists.map((a) => ({ name: a })),
  artist: { name: artists[0] },
  duration: opts.duration || 0,
  album: opts.album ? { title: opts.album } : undefined,
});

describe("simplifyTitle", () => {
  it("strips parenthetical and bracket suffixes", () => {
    expect(TrackMatch.simplifyTitle("Cafe (feat. Friend)")).toBe("cafe");
    expect(TrackMatch.simplifyTitle("Song [Bonus Track]")).toBe("song");
  });
  it("strips ' - …' suffixes", () => {
    expect(TrackMatch.simplifyTitle("Lose Yourself - Radio Edit")).toBe("lose yourself");
    expect(TrackMatch.simplifyTitle("Bohemian Rhapsody - Remastered 2011")).toBe("bohemian rhapsody");
  });
  it("strips trailing feat./ft./featuring clauses", () => {
    expect(TrackMatch.simplifyTitle("Track feat. Other")).toBe("track");
    expect(TrackMatch.simplifyTitle("Track ft. Other")).toBe("track");
  });
  it("folds diacritics", () => {
    expect(TrackMatch.simplifyTitle("Café")).toBe("cafe");
  });
});

describe("extractQualifiers", () => {
  it("picks up version qualifiers", () => {
    expect([...TrackMatch.extractQualifiers("Song (Live at Wembley)")]).toContain("live");
    expect([...TrackMatch.extractQualifiers("Song - Acoustic")]).toContain("acoustic");
    expect([...TrackMatch.extractQualifiers("Song (Remix)")]).toContain("remix");
  });
  it("ignores remastered (treated as same recording)", () => {
    expect([...TrackMatch.extractQualifiers("Song - Remastered 2011")]).toEqual([]);
  });
  it("ignores 'Original Mix' / 'Album Mix' / 'Stereo Mix' (same recording)", () => {
    expect([...TrackMatch.extractQualifiers("Say It Ain't So - Original Mix")]).toEqual([]);
    expect([...TrackMatch.extractQualifiers("Song (Album Mix)")]).toEqual([]);
    expect([...TrackMatch.extractQualifiers("Song - Stereo Mix")]).toEqual([]);
  });
  it("still flags genuine remix / club mix qualifiers", () => {
    expect([...TrackMatch.extractQualifiers("Song (Club Mix)")]).toContain("club mix");
    expect([...TrackMatch.extractQualifiers("Song - Remix")]).toContain("remix");
  });
});

describe("splitArtists", () => {
  it("splits on comma, ampersand, feat., and 'and'", () => {
    expect(TrackMatch.splitArtists("A, B & C feat. D and E")).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("accepts arrays", () => {
    expect(TrackMatch.splitArtists(["A", "B"])).toEqual(["a", "b"]);
  });
});

describe("scoreCandidate — qualifier hard-reject (the remix-collapse bug)", () => {
  it("scores zero when source has 'remix' but candidate does not", () => {
    const src = t("Song - Remix", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Song", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBe(0);
  });
  it("scores zero when candidate has 'live' but source does not", () => {
    const src = t("Song", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Song (Live at Wembley)", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBe(0);
  });
  it("scores normally when qualifiers match on both sides", () => {
    const src = t("Song - Live", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Song (Live)", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("scores normally when neither side has qualifiers", () => {
    const src = t("Song", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Song", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("accepts asymmetric 'remastered' (treated as same recording)", () => {
    const src = t("Bohemian Rhapsody - Remastered 2011", ["Queen"], { durationMs: 354000 });
    const c = cand(1, "Bohemian Rhapsody", ["Queen"], { duration: 354 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("accepts 'Original Mix' against plain title (treated as same recording)", () => {
    const src = t("Say It Ain't So - Original Mix", ["Weezer"], { durationMs: 258000, album: "Weezer" });
    const c = cand(1, "Say It Ain't So", ["Weezer"], { duration: 258, album: "Weezer" });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("matches '(Acoustic Version)' to ' - Acoustic Version' (paren vs dash form)", () => {
    const src = t("Ricochet (Acoustic Version)", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Ricochet - Acoustic Version", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("matches '- Acoustic Version' to '(Acoustic Version)' (dash vs paren form)", () => {
    const src = t("Ricochet - Acoustic Version", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Ricochet (Acoustic Version)", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("accepts asymmetric 'radio edit' when duration matches tightly", () => {
    // Tidal often ships the radio edit as the unlabeled canonical track —
    // e.g. Spotify "Rainbow In The Sky - Radio Edit" 207.9s vs Tidal plain
    // "Rainbow in the Sky" 208s. Same recording.
    const src = t("Rainbow In The Sky - Radio Edit", ["Paul Elstak"], { durationMs: 207933 });
    const c = cand(1, "Rainbow in the Sky", ["Paul Elstak"], { duration: 208 });
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
  it("rejects asymmetric 'radio edit' when duration differs (real edit vs album cut)", () => {
    // 3:30 radio edit vs 5:00 album version — actually different recordings.
    const src = t("Big Song - Radio Edit", ["Artist"], { durationMs: 210000 });
    const c = cand(1, "Big Song", ["Artist"], { duration: 300 });
    expect(TrackMatch.scoreCandidate(src, c)).toBe(0);
  });
  it("rejects 'radio edit' vs 'remix' even when durations match", () => {
    // symDiff isn't a subset of permissive set → still hard-reject.
    const src = t("Song - Radio Edit", ["Artist"], { durationMs: 200000 });
    const c = cand(1, "Song (Remix)", ["Artist"], { duration: 200 });
    expect(TrackMatch.scoreCandidate(src, c)).toBe(0);
  });
  it("reads Tidal's separate `version` field for qualifier extraction", () => {
    // STARSET's acoustic "Ricochet" comes back as `title: "Ricochet"`,
    // `version: "Acoustic Version"`. Without reading `version`, the
    // qualifier-reject would zero this out.
    const src = t("Ricochet - Acoustic Version", ["STARSET"], { durationMs: 292493, album: "Vessels 2.0" });
    const c = {
      id: 95471084,
      title: "Ricochet",
      version: "Acoustic Version",
      artists: [{ name: "STARSET" }],
      duration: 292,
      album: { title: "Vessels 2.0" },
    };
    expect(TrackMatch.scoreCandidate(src, c)).toBeGreaterThan(0.9);
  });
});

describe("durationScore", () => {
  it("is 1 for exact duration", () => {
    expect(TrackMatch.durationScore(200, 200)).toBe(1);
  });
  it("is 0 at or beyond the 5s window", () => {
    expect(TrackMatch.durationScore(200, 205)).toBe(0);
    expect(TrackMatch.durationScore(200, 230)).toBe(0);
  });
  it("scales linearly within the window", () => {
    expect(TrackMatch.durationScore(200, 202.5)).toBeCloseTo(0.5, 5);
  });
  it("returns 0.5 (neutral) when either is missing", () => {
    expect(TrackMatch.durationScore(0, 200)).toBe(0.5);
    expect(TrackMatch.durationScore(200, 0)).toBe(0.5);
  });
});

describe("pickBest", () => {
  it("returns null on empty candidates", () => {
    const src = t("Song", ["Artist"]);
    expect(TrackMatch.pickBest(src, [])).toBeNull();
  });

  it("rejects below threshold (no items[0] fallback)", () => {
    // Title totally different, artist different — should reject.
    const src = t("Lose Yourself", ["Eminem"], { durationMs: 326000 });
    const candidates = [cand(1, "Stan", ["Eminem"], { duration: 404 })];
    expect(TrackMatch.pickBest(src, candidates)).toBeNull();
  });

  it("picks the version-matching candidate over the generic top hit", () => {
    // Simulates the bug: search returns the album version first, but the
    // user wants the radio edit. The matcher should reject the album version
    // and (in this test) return null because no remix-version candidate exists.
    const src = t("Lose Yourself - Radio Edit", ["Eminem"], { durationMs: 320000 });
    const candidates = [
      cand(1, "Lose Yourself", ["Eminem"], { duration: 326 }),
      cand(2, "Lose Yourself - Live", ["Eminem"], { duration: 340 }),
    ];
    expect(TrackMatch.pickBest(src, candidates)).toBeNull();
  });

  it("accepts a clear match above threshold", () => {
    const src = t("Hey Jude", ["The Beatles"], { durationMs: 431000 });
    const candidates = [
      cand(1, "Hey Jude", ["The Beatles"], { duration: 431, album: "1" }),
      cand(2, "Yesterday", ["The Beatles"], { duration: 125 }),
    ];
    const result = TrackMatch.pickBest(src, candidates);
    expect(result).not.toBeNull();
    expect(result.item.id).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it("picks the radio-edit candidate when one is present", () => {
    const src = t("Lose Yourself - Radio Edit", ["Eminem"], { durationMs: 254000 });
    const candidates = [
      cand(1, "Lose Yourself", ["Eminem"], { duration: 326 }),       // qualifier mismatch → 0
      cand(2, "Lose Yourself - Radio Edit", ["Eminem"], { duration: 254 }),
    ];
    const result = TrackMatch.pickBest(src, candidates);
    expect(result).not.toBeNull();
    expect(result.item.id).toBe(2);
  });

  it("handles multi-artist tracks with different orderings", () => {
    const src = t("Song", ["A", "B"], { durationMs: 200000 });
    const candidates = [cand(1, "Song", ["B", "A"], { duration: 200 })];
    const result = TrackMatch.pickBest(src, candidates);
    expect(result).not.toBeNull();
    expect(result.score).toBeGreaterThan(0.9);
  });
});
