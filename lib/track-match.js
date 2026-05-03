// Track matching — see docs/matching.md for the spec and rationale.
//
// Loaded as a plain background script (non-ESM); exposes `TrackMatch`.

const TrackMatch = {
  WEIGHTS: { title: 0.45, artist: 0.25, duration: 0.20, album: 0.10 },
  THRESHOLD: 0.70,
  DURATION_WINDOW_S: 5,

  // Qualifiers that imply a distinct recording. `remastered` and `version`
  // are intentionally excluded — they appear asymmetrically across catalogs
  // for what is effectively the same track.
  QUALIFIER_RE: /\b(remix|live|acoustic|instrumental|acapella|demo|radio edit|edit|mix|extended|club mix|dub|karaoke|sped up|slowed)\b/gi,

  fold(s) {
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  },

  simplifyTitle(s) {
    let out = this.fold(s).trim();
    // strip from first " - ", "(", "["
    const cut = out.search(/\s-\s|\(|\[/);
    if (cut !== -1) out = out.slice(0, cut);
    out = out.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, "");
    return out.replace(/\s+/g, " ").trim();
  },

  // Phrases that describe the standard recording, not a distinct cut. Stripped
  // before qualifier extraction so the bare `mix` token in QUALIFIER_RE doesn't
  // hard-reject e.g. "Say It Ain't So - Original Mix" against plain
  // "Say It Ain't So". Cf. `remastered`/`version`, which are simply absent from
  // QUALIFIER_RE for the same reason.
  PERMISSIVE_PHRASE_RE: /\b(?:original|album|stereo)\s+mix\b/g,

  extractQualifiers(s) {
    const folded = this.fold(s).replace(this.PERMISSIVE_PHRASE_RE, "");
    const matches = folded.match(this.QUALIFIER_RE) || [];
    return new Set(matches.map((m) => m.toLowerCase()));
  },

  symDiffNonEmpty(a, b) {
    for (const x of a) if (!b.has(x)) return true;
    for (const x of b) if (!a.has(x)) return true;
    return false;
  },

  symDiff(a, b) {
    const out = new Set();
    for (const x of a) if (!b.has(x)) out.add(x);
    for (const x of b) if (!a.has(x)) out.add(x);
    return out;
  },

  // Qualifiers that may appear asymmetrically when the catalog labels the
  // canonical streaming cut without any version suffix (Tidal often does this
  // — e.g. Spotify's "Rainbow In The Sky - Radio Edit" vs. Tidal's plain
  // "Rainbow in the Sky" with the same duration). Permitted only when the
  // duration matches tightly, so genuine album-vs-edit cuts of different
  // lengths still hard-reject.
  DURATION_PERMISSIVE_QUALIFIERS: new Set(["radio edit", "edit"]),
  DURATION_PERMISSIVE_TOLERANCE_S: 2,

  splitArtists(s) {
    if (Array.isArray(s)) s = s.join(", ");
    if (!s) return [];
    // Normalize all separators to "|" then split. Trailing `\b` doesn't play
    // nicely with `feat.`/`ft.` (period is non-word), so we anchor on the
    // following whitespace instead.
    const normalized = this.fold(s)
      .replace(/\b(featuring|feat\.?|ft\.?)\s+/g, "|")
      .replace(/\s+(and|with)\s+/g, "|")
      .replace(/\s*[,&;]\s*/g, "|");
    return normalized.split("|").map((p) => p.trim()).filter(Boolean);
  },

  jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
  },

  // Levenshtein distance — iterative two-row variant.
  levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[b.length];
  },

  ratio(a, b) {
    a = a || "";
    b = b || "";
    if (!a && !b) return 1;
    const max = Math.max(a.length, b.length);
    if (max === 0) return 1;
    return 1 - this.levenshtein(a, b) / max;
  },

  durationScore(srcSec, candSec) {
    if (!srcSec || !candSec) return 0.5;
    const delta = Math.abs(srcSec - candSec);
    if (delta >= this.DURATION_WINDOW_S) return 0;
    return 1 - delta / this.DURATION_WINDOW_S;
  },

  candidateArtists(item) {
    if (Array.isArray(item.artists) && item.artists.length) {
      return item.artists.map((a) => a.name).filter(Boolean);
    }
    if (item.artist?.name) return [item.artist.name];
    return [];
  },

  // Tidal stores the version qualifier in a separate `version` field — e.g.
  // STARSET's acoustic "Ricochet" comes back as `title: "Ricochet"`,
  // `version: "Acoustic Version"`. Compose a full title so qualifier
  // extraction and title simplification see the qualifier. Spotify embeds
  // it in the title directly, so on the source side we always read `name`.
  candidateTitle(item) {
    const title = item.title || "";
    const version = item.version || "";
    return version ? `${title} (${version})` : title;
  },

  // Returns the per-component sub-scores plus the aggregate. Useful for
  // diagnostic logging when a track fails to match.
  scoreBreakdown(source, candidate) {
    const candTitle = this.candidateTitle(candidate);
    const srcQ = this.extractQualifiers(source.name);
    const candQ = this.extractQualifiers(candTitle);
    const diff = this.symDiff(srcQ, candQ);
    let qualifierReject = diff.size > 0;
    if (qualifierReject) {
      // `radio edit` / `edit` permissive when duration matches tightly:
      // Tidal frequently ships the radio edit as the unlabeled canonical
      // track (e.g. Spotify "Rainbow In The Sky - Radio Edit" 207.9s vs
      // Tidal "Rainbow in the Sky" 208s — same recording).
      const allPermissive = [...diff].every((q) =>
        this.DURATION_PERMISSIVE_QUALIFIERS.has(q),
      );
      if (allPermissive) {
        const srcSec = source.durationMs ? source.durationMs / 1000 : 0;
        const candSec = candidate.duration || 0;
        if (srcSec && candSec && Math.abs(srcSec - candSec) <= this.DURATION_PERMISSIVE_TOLERANCE_S) {
          qualifierReject = false;
        }
      }
    }

    const titleScore = this.ratio(
      this.simplifyTitle(source.name),
      this.simplifyTitle(candTitle),
    );

    const srcArtists = new Set(this.splitArtists(source.artists));
    const candArtists = new Set(this.splitArtists(this.candidateArtists(candidate)));
    const artistScore = this.jaccard(srcArtists, candArtists);

    const srcSec = source.durationMs ? source.durationMs / 1000 : 0;
    const durationScore = this.durationScore(srcSec, candidate.duration || 0);

    const albumScore = (source.album && candidate.album?.title)
      ? this.ratio(this.simplifyTitle(source.album), this.simplifyTitle(candidate.album.title))
      : 0.5;

    const w = this.WEIGHTS;
    const aggregate = w.title * titleScore
      + w.artist * artistScore
      + w.duration * durationScore
      + w.album * albumScore;

    return {
      score: qualifierReject ? 0 : aggregate,
      qualifierReject,
      sub: { title: titleScore, artist: artistScore, duration: durationScore, album: albumScore },
      qualifiers: { source: [...srcQ], candidate: [...candQ] },
    };
  },

  scoreCandidate(source, candidate) {
    return this.scoreBreakdown(source, candidate).score;
  },

  pickBest(source, candidates, threshold = this.THRESHOLD) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      const score = this.scoreCandidate(source, c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (bestScore < threshold) return null;
    return { item: best, score: bestScore };
  },
};

if (typeof module !== "undefined") module.exports = TrackMatch;
