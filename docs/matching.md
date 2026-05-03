# Track matching: how Spotify tracks are mapped to Tidal tracks

## Goal

Given a Spotify track `{ name, artists[], album, durationMs }`, return the
Tidal track ID that represents the **same recording** — same version, same
mix, same edit. If no candidate is sufficiently confident, return `null` and
let the user resolve it manually via the per-track search link in the results
review screen.

(Spotify dropped ISRCs from its web GraphQL responses around 2024, so we have
no authoritative ID to look up — everything is a scored fuzzy match.)

The dominant failure mode we are designing against: Spotify rows for distinct
recordings (a remix, a live cut, a radio edit, a remaster) silently collapse
onto the original studio track because the search returns the studio version
first and a loose matcher accepts it. False positives are worse than false
negatives here — a missed match is a small UI nudge, but a wrong match
pollutes the destination playlist.

## Algorithm

Single pass: scored fuzzy match against Tidal search results.

1. Search Tidal twice in parallel, both with `types=TRACKS&limit=25`:
   - **Full query**: `"{name} {artists.join(' ')}"`
   - **Cleaned query**: same, with `(`, `)`, `[`, `]`, and `-` replaced by
     spaces — skipped when the cleaned form equals the original (nothing to
     strip).
   Tidal's `/v1/search` ranks queries with `(parens)` or ` - ` separators
   poorly. `"Der Rest meines Lebens (Live aus der Wuhlheide)"` buries the
   live cut, and `"Ricochet - Acoustic Version STARSET"` misses the
   catalogue's `Ricochet (Acoustic Version)` entirely. The cleaned query
   keeps the qualifier *words* (the disambiguator Tidal needs to find the
   right version) while dropping the punctuation that confuses ranking.
   Candidates are merged by `id`.

   **Primary-artist fallback**: if both queries return zero candidates *and*
   the source has multiple artists, retry with just the first artist (`name`
   + cleaned `name` × `artists[0]`). Spotify often credits featured artists
   that Tidal does not list in track metadata (e.g. `"ONLY 4 LIFE - Remix"`
   by `[Rubi, FABE BROWN]` on Spotify is just `"Rubi"` on Tidal — the
   full-artist query returns nothing). Downstream Jaccard scoring still
   penalises the missing featured credits, so this only relaxes the *search*
   step, not the *match* step.
2. For each candidate, compute four sub-scores in `[0, 1]`.
3. Combine. Apply qualifier hard-reject. Pick the highest. Reject below
   threshold.

#### Candidate title composition

Tidal stores the version qualifier in a separate `version` field. STARSET's
acoustic "Ricochet" comes back as `title: "Ricochet"`, `version: "Acoustic
Version"`. Spotify embeds the qualifier directly in the title (`"Ricochet -
Acoustic Version"`). Before scoring, compose the candidate's full title as
`{title} ({version})` when `version` is present; otherwise just `title`. The
source side always reads `name`. All downstream steps (simplification,
qualifier extraction) operate on this composed string.

#### Title score (weight `0.45`)

Compare the **simplified** titles using a normalized Levenshtein ratio:

```
ratio(a, b) = 1 - distance(a, b) / max(a.length, b.length)
```

Simplification — applied to both source and candidate titles:

1. NFD-normalize, drop combining marks (diacritic fold).
2. Lowercase, trim.
3. Drop everything from the first `-`, `(`, or `[` onward.
4. Drop trailing `feat. …` / `ft. …` / `featuring …` clauses.
5. Collapse whitespace.

Examples:

| Raw                                          | Simplified         |
| -------------------------------------------- | ------------------ |
| `Lose Yourself - Radio Edit`                 | `lose yourself`    |
| `Café (feat. Friend)`                        | `cafe`             |
| `Bohemian Rhapsody - Remastered 2011`        | `bohemian rhapsody`|

The qualifier portion is **not** discarded — pass 2's hard-reject (below) uses
the original strings.

#### Artist score (weight `0.25`)

Jaccard similarity over artist sets. Both sides are split on `,`, `&`, `and`,
`feat.`, `ft.`, `featuring`, `with`, `;` (case-insensitive), trimmed, lowercased,
diacritic-folded. Empty tokens dropped.

```
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

If both sets are empty, score = `1` (vacuously equal).

#### Duration score (weight `0.20`)

Hard window of 5 seconds, scoring within:

```
durationScore = max(0, 1 - |Δseconds| / 5)
```

Spotify gives `durationMs`; Tidal gives `duration` in seconds. If either is
missing, score = `0.5` (neutral — neither rewards nor punishes).

#### Album score (weight `0.10`)

Levenshtein ratio between source album name and candidate album name (both
simplified per the title rules). If either is missing, score = `0.5`.

#### Qualifier hard-reject

Build a qualifier set from each side's *original* (non-simplified) title by
matching the regex `\b(remix|live|acoustic|instrumental|acapella|remastered|demo|radio edit|edit|mix|version|extended|club mix|dub|karaoke|sped up|slowed)\b` (case-insensitive) and taking the unique tokens.

If the symmetric difference of the two sets is non-empty, the candidate is
rejected outright (final score = `0`). This is the load-bearing rule that
fixes the remix-collapse bug. A "remix" on the Spotify side cannot match a
candidate without "remix" on the Tidal side, and vice versa.

`remastered` is treated permissively — it appears asymmetrically all the time
(e.g. `Bohemian Rhapsody - Remastered 2011` vs. plain `Bohemian Rhapsody`) and
both refer to substantially the same recording. Implementation: `remastered`
is excluded from the qualifier set when collected. Same for `version` (too
generic — "Album Version" vs nothing is fine).

`radio edit` and `edit` are treated permissively **only when the duration
matches within 2 seconds**. Tidal often ships the radio edit as the unlabeled
canonical streaming track (Spotify `"Rainbow In The Sky - Radio Edit"`
207.9 s vs Tidal `"Rainbow in the Sky"` 208 s — same recording). The duration
gate keeps genuine radio-edit-vs-album-version cuts (different lengths) hard-rejecting.

`Original Mix` / `Album Mix` / `Stereo Mix` are likewise stripped before
qualifier extraction (e.g. `Say It Ain't So - Original Mix` vs. plain
`Say It Ain't So`). These phrases label the standard recording, not a
distinct cut. Without this, the bare `mix` token in the qualifier regex would
hard-reject the match. Genuine `remix` / `club mix` / `extended` / `dub`
remain qualifiers.

Punctuation around the qualifier suffix is **not** load-bearing. Both
`Ricochet (Acoustic Version)` and `Ricochet - Acoustic Version` simplify to
`ricochet` and yield the same qualifier set `{acoustic}`, so they match each
other. Catalogs use the two forms interchangeably.

#### Aggregation, threshold, fallback

```
score = 0.45·title + 0.25·artist + 0.20·duration + 0.10·album
```

If `score >= 0.70`, accept. Otherwise reject. **No `items[0]` fallback** —
the previous behaviour of returning the first search result when nothing
scored well is what produced the silent miscollapses, and is removed.

### Returned shape

```
{ tidalId, title }
```

## Calibration notes

Weights chosen by reading published configs and adjusting for the
two-platform-search domain (no rich metadata graph like beets has):

| Component | Weight | Source                                           |
| --------- | -----: | ------------------------------------------------ |
| title     |  0.45  | beets `track_title=3.0` (relative leader)        |
| artist    |  0.25  | beets `track_artist=2.0`                         |
| duration  |  0.20  | beets `track_length=2.0`; sigma67 weights x5     |
| album     |  0.10  | weak signal; Tidal often has different masters   |

Threshold `0.70` was picked to be slightly tighter than sigma67's lack of a
threshold (which is the source of their match-quality complaints), and looser
than spotify_to_tidal's all-three-must-pass boolean (which throws away
recoverable matches with cosmetic noise like `Remastered 2023`). Revisit once
we have a regression suite.

## Non-goals

- **Acoustic fingerprinting** (Chromaprint/AcoustID): overkill in a browser
  context and we do not have the audio.
- **MusicBrainz cross-reference**: would help disambiguate, but it adds a
  third API hop and rate-limit complexity; not now.
- **Per-user feedback loop**: the per-track Tidal search link in the results
  review screen is the manual escape hatch.

## References

- `https://github.com/spotify2tidal/spotify_to_tidal` — closest analog. Source
  of the qualifier exclusion idea.
- `https://github.com/sigma67/spotify_to_ytmusic/blob/master/spotify_to_ytmusic/utils/match.py`
  — scoring shape; the no-threshold / always-pick-argmax behaviour is the
  cautionary tale.
- `https://beets.readthedocs.io/en/stable/reference/config.html` — published
  weight calibration.
- `https://github.com/SilentVoid13/SyncDisBoi` — Levenshtein on title +
  album + duration; useful counterpoint that drops artist.

## Module layout

The algorithm lives in `lib/track-match.js` as a global `TrackMatch` object,
matching the existing background-script style (non-ESM, attached as a script
in `manifest.json`). `TidalAPI.matchTrack` calls `TrackMatch.pickBest` after
running its own ISRC pass.
