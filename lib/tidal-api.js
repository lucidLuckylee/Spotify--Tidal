// Tidal API wrapper

const TidalAPI = {
  BASE: "https://api.tidal.com/v1",
  RATE_DELAY: 150, // ms between requests
  countryCode: "US",

  async _fetch(token, url, options = {}, _retries = 5) {
    const { raw = false, ...fetchOptions } = options;
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = url.startsWith("http")
      ? url
      : `${this.BASE}${url}${sep}countryCode=${this.countryCode}`;

    const res = await fetch(fullUrl, {
      ...fetchOptions,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });

    if (res.status === 429) {
      if (_retries <= 0) throw new Error("Tidal API rate limit — max retries exceeded");
      const retryAfter = parseInt(res.headers.get("Retry-After") || "3", 10);
      await this._sleep(retryAfter * 1000);
      return this._fetch(token, url, options, _retries - 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tidal API ${res.status}: ${res.statusText} — ${body}`);
    }

    if (raw) return res;

    const text = await res.text();
    if (!text) return { success: true };
    try {
      return JSON.parse(text);
    } catch {
      return { success: true };
    }
  },


  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  async getUserId(token) {
    const data = await this._fetch(token, "/sessions");
    this.countryCode = data.countryCode || "US";
    return data.userId;
  },

  async _searchTracks(token, query) {
    if (!query) return { query, url: null, raw: null, items: [] };
    const url = `${this.BASE}/search?query=${encodeURIComponent(query)}&types=TRACKS&countryCode=${this.countryCode}&limit=25`;
    const raw = await this._fetch(token, url);
    return { query, url, raw, items: raw?.tracks?.items || [] };
  },

  async searchByName(token, source) {
    const artistStr = (source.artists || []).join(" ");
    const fullQuery = `${source.name} ${artistStr}`.trim();
    if (!fullQuery) return null;

    // Tidal's `/v1/search` ranks queries with `(parens)` or ` - ` separators
    // poorly — e.g. `Ricochet - Acoustic Version STARSET` returns the studio
    // `Ricochet`, missing the catalogue's `Ricochet (Acoustic Version)` cut
    // entirely. Same for `Der Rest meines Lebens (Live aus der Wuhlheide)`.
    // The fallback query replaces `()`, `[]`, and `-` with spaces — keeping
    // the qualifier *words* (which Tidal needs to find the right version)
    // while dropping the punctuation that confuses ranking.
    const cleanedName = source.name.replace(/[()[\]\-]/g, " ").replace(/\s+/g, " ").trim();
    const cleanedQuery = cleanedName ? `${cleanedName} ${artistStr}`.trim() : "";

    const seen = new Set();
    const candidates = [];
    const collect = (items) => {
      for (const it of items) {
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        candidates.push(it);
      }
    };

    const queries = (cleanedQuery && cleanedQuery !== fullQuery)
      ? [fullQuery, cleanedQuery]
      : [fullQuery];
    const results = await Promise.all(queries.map((q) => this._searchTracks(token, q)));
    for (const r of results) collect(r.items);

    // Fallback: Spotify often credits featured artists that Tidal doesn't list
    // in track metadata (e.g. "ONLY 4 LIFE" by [Rubi, FABE BROWN] on Spotify
    // is just "Rubi" on Tidal — full-artist queries return 0). When we have
    // nothing and the source has multiple artists, retry with just the
    // primary artist; downstream Jaccard scoring still penalises the missing
    // featured credits without rejecting outright.
    const allArtists = source.artists || [];
    if (candidates.length === 0 && allArtists.length > 1) {
      const primary = allArtists[0];
      const primaryFull = `${source.name} ${primary}`.trim();
      const primaryCleaned = cleanedName ? `${cleanedName} ${primary}`.trim() : "";
      const fallbackQueries = [primaryFull, primaryCleaned]
        .filter((q) => q && !queries.includes(q));
      if (fallbackQueries.length) {
        const fallbackResults = await Promise.all(
          fallbackQueries.map((q) => this._searchTracks(token, q))
        );
        for (const r of fallbackResults) collect(r.items);
        results.push(...fallbackResults);
      }
    }

    const sourceInfo = {
      name: source.name,
      artists: source.artists,
      album: source.album,
      durationMs: source.durationMs,
      spotifyUri: source.spotifyUri,
    };

    // Firefox's console truncates long messages with `…`, so we split the
    // diagnostic into one source line + one line per request + one per
    // candidate. Each is right-click → Copy Message friendly.
    const logRequest = (r) => {
      const trimmed = (r.raw?.tracks?.items || []).map((it) => ({
        id: it.id,
        title: it.title,
        version: it.version,
        artists: (it.artists || []).map((a) => a.name).filter(Boolean),
        duration: it.duration,
        album: it.album?.title,
      }));
      const total = r.raw?.tracks?.totalNumberOfItems;
      console.warn(
        `[Munchy] request: ${r.query}\nurl: ${r.url}\ntotal: ${total}\nitems: ` +
          JSON.stringify(trimmed, null, 2)
      );
    };

    if (candidates.length === 0) {
      console.warn("[Munchy] no Tidal match — search returned 0 candidates\nsource: " + JSON.stringify(sourceInfo, null, 2));
      results.forEach(logRequest);
      return null;
    }

    const picked = TrackMatch.pickBest(source, candidates);
    if (!picked) {
      const scored = candidates
        .map((c) => {
          const breakdown = TrackMatch.scoreBreakdown(source, c);
          return {
            id: c.id,
            title: c.title,
            version: c.version,
            artists: (c.artists || []).map((a) => a.name).filter(Boolean),
            duration: c.duration,
            album: c.album?.title,
            score: breakdown.score,
            qualifierReject: breakdown.qualifierReject,
            sub: breakdown.sub,
            qualifiers: breakdown.qualifiers,
          };
        })
        .sort((a, b) => b.score - a.score);
      console.warn(
        `[Munchy] no Tidal match — best candidate scored below threshold (${TrackMatch.THRESHOLD})\nsource: ` +
          JSON.stringify(sourceInfo, null, 2)
      );
      results.forEach(logRequest);
      for (const c of scored) {
        console.warn("[Munchy] candidate: " + JSON.stringify(c, null, 2));
      }
      return null;
    }
    return picked.item;
  },

  async matchTrack(token, track) {
    if (!track.name || !(track.artists || []).length) return null;
    const match = await this.searchByName(token, track);
    return match ? { tidalId: match.id, title: match.title } : null;
  },

  async addTrackToFavorites(token, userId, trackId) {
    const url = `${this.BASE}/users/${userId}/favorites/tracks?countryCode=${this.countryCode}`;
    await this._fetch(token, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `trackId=${trackId}`,
    });
  },

  async createPlaylist(token, userId, name, description) {
    const url = `${this.BASE}/users/${userId}/playlists?countryCode=${this.countryCode}`;
    const res = await this._fetch(token, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(name)}&description=${encodeURIComponent(description || "")}`,
      raw: true,
    });

    const headerEtag = res.headers.get("ETag");
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}

    // Try header first, then body fields
    const etag = headerEtag || data.eTag || data.etag || (data.lastUpdated ? String(data.lastUpdated) : null);
    return { uuid: data.uuid || data.id, etag };
  },

  async addTracksToPlaylist(token, playlistId, trackIds, initialEtag) {
    const BATCH = 100;
    let etag = initialEtag || null;

    for (let i = 0; i < trackIds.length; i += BATCH) {
      const batch = trackIds.slice(i, i + BATCH);
      const url = `${this.BASE}/playlists/${playlistId}/items?countryCode=${this.countryCode}`;

      // Fetch fresh ETag if we don't have one (or after the first batch modified it)
      if (!etag || i > 0) {
        etag = await this._getPlaylistEtag(token, playlistId);
        if (!etag) {
          await this._sleep(1000);
          etag = await this._getPlaylistEtag(token, playlistId);
        }
      }

      console.log(`[Tidal] addTracks batch ${i / BATCH + 1}: etag=${etag}`);
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (etag) headers["If-None-Match"] = etag;

      await this._fetch(token, url, {
        method: "POST",
        headers,
        body: `trackIds=${batch.map(String).join(",")}&onDupes=SKIP`,
      });

      // ETag changed after modification, will refetch on next iteration
      etag = null;

      if (i + BATCH < trackIds.length) {
        await this._sleep(this.RATE_DELAY);
      }
    }
  },

  async _getPlaylistEtag(token, playlistId) {
    try {
      const url = `${this.BASE}/playlists/${playlistId}?countryCode=${this.countryCode}`;
      const res = await this._fetch(token, url, { raw: true });

      // Try header first
      const headerEtag = res.headers.get("ETag") || res.headers.get("etag");
      if (headerEtag) return headerEtag;

      // Fallback: Tidal often returns the ETag in the response body
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        if (data.eTag) return data.eTag;
        if (data.etag) return data.etag;
        if (data.lastUpdated) return String(data.lastUpdated);
      } catch {}

      return null;
    } catch {
      return null;
    }
  },

  async searchAlbumByName(token, name, artist) {
    const query = `${name} ${artist}`.trim();
    const url = `${this.BASE}/search?query=${encodeURIComponent(query)}&types=ALBUMS&countryCode=${this.countryCode}&limit=5`;
    const data = await this._fetch(token, url);
    if (data.albums && data.albums.items && data.albums.items.length > 0) {
      return data.albums.items[0];
    }
    return null;
  },

  async addAlbumToFavorites(token, userId, albumId) {
    const url = `${this.BASE}/users/${userId}/favorites/albums?countryCode=${this.countryCode}`;
    await this._fetch(token, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `albumId=${albumId}`,
    });
  },

  async searchArtistByName(token, name) {
    const url = `${this.BASE}/search?query=${encodeURIComponent(name)}&types=ARTISTS&countryCode=${this.countryCode}&limit=5`;
    const data = await this._fetch(token, url);
    if (data.artists && data.artists.items && data.artists.items.length > 0) {
      // Prefer exact name match
      const exact = data.artists.items.find(
        (a) => a.name.toLowerCase() === name.toLowerCase()
      );
      return exact || data.artists.items[0];
    }
    return null;
  },

  async getUserPlaylists(token, userId) {
    const limit = 50;
    const all = [];
    let offset = 0;
    while (true) {
      const url = `${this.BASE}/users/${userId}/playlists?countryCode=${this.countryCode}&limit=${limit}&offset=${offset}`;
      const data = await this._fetch(token, url);
      const items = data.items || [];
      all.push(...items);
      const total = data.totalNumberOfItems;
      offset += items.length;
      if (items.length < limit) break;
      if (typeof total === "number" && offset >= total) break;
      if (items.length === 0) break;
    }
    return all;
  },

  async findPlaylistByName(token, userId, name) {
    const playlists = await this.getUserPlaylists(token, userId);
    const normName = name.toLowerCase().trim();
    return playlists.find((p) => (p.title || "").toLowerCase().trim() === normName) || null;
  },

  async getOrCreatePlaylist(token, userId, name, description) {
    // Try to find an existing playlist with the same name
    const existing = await this.findPlaylistByName(token, userId, name);
    if (existing) {
      const uuid = existing.uuid || existing.id;
      const etag = await this._getPlaylistEtag(token, uuid);
      return { uuid, etag, existed: true };
    }
    // Create a new one
    const result = await this.createPlaylist(token, userId, name, description);
    return { ...result, existed: false };
  },

  async addArtistToFavorites(token, userId, artistId) {
    const url = `${this.BASE}/users/${userId}/favorites/artists?countryCode=${this.countryCode}`;
    await this._fetch(token, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `artistId=${artistId}`,
    });
  },
};
