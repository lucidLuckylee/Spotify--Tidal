// Tidal API wrapper

const TidalAPI = {
  BASE: "https://api.tidal.com/v1",
  RATE_DELAY: 150, // ms between requests
  countryCode: "US",

  async _fetch(token, url, options = {}, _retries = 5) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = url.startsWith("http")
      ? url
      : `${this.BASE}${url}${sep}countryCode=${this.countryCode}`;

    const res = await fetch(fullUrl, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
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

    const text = await res.text();
    if (!text) return { success: true };
    try {
      return JSON.parse(text);
    } catch {
      return { success: true };
    }
  },

  async _fetchRaw(token, url, options = {}, _retries = 5) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = url.startsWith("http")
      ? url
      : `${this.BASE}${url}${sep}countryCode=${this.countryCode}`;

    const res = await fetch(fullUrl, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (res.status === 429) {
      if (_retries <= 0) throw new Error("Tidal API rate limit — max retries exceeded");
      const retryAfter = parseInt(res.headers.get("Retry-After") || "3", 10);
      await this._sleep(retryAfter * 1000);
      return this._fetchRaw(token, url, options, _retries - 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tidal API ${res.status}: ${res.statusText} — ${body}`);
    }

    return res;
  },

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  async getUserId(token) {
    const data = await this._fetch(token, "/sessions");
    this.countryCode = data.countryCode || "US";
    return data.userId;
  },

  async searchByISRC(token, isrc) {
    if (!isrc) return null;
    const url = `${this.BASE}/tracks?isrc=${encodeURIComponent(isrc)}&countryCode=${this.countryCode}&limit=1`;
    try {
      const data = await this._fetch(token, url);
      if (data.items && data.items.length > 0) {
        return data.items[0];
      }
      // Fallback: use search endpoint with ISRC
      return this._searchISRCFallback(token, isrc);
    } catch {
      return this._searchISRCFallback(token, isrc);
    }
  },

  async _searchISRCFallback(token, isrc) {
    const url = `${this.BASE}/search?query=${encodeURIComponent(isrc)}&types=TRACKS&countryCode=${this.countryCode}&limit=1`;
    try {
      const data = await this._fetch(token, url);
      if (data.tracks && data.tracks.items && data.tracks.items.length > 0) {
        const match = data.tracks.items[0];
        if (match.isrc === isrc) return match;
      }
    } catch {
      // fall through
    }
    return null;
  },

  async searchByName(token, name, artist) {
    const query = `${name} ${artist}`.trim();
    const url = `${this.BASE}/search?query=${encodeURIComponent(query)}&types=TRACKS&countryCode=${this.countryCode}&limit=5`;
    const data = await this._fetch(token, url);
    if (data.tracks && data.tracks.items && data.tracks.items.length > 0) {
      return this._bestNameMatch(data.tracks.items, name, artist);
    }
    return null;
  },

  _bestNameMatch(items, name, artist) {
    const normName = name.toLowerCase().trim();
    const normArtist = artist.toLowerCase().trim();

    // Prefer exact name + artist match
    for (const item of items) {
      const itemName = (item.title || "").toLowerCase().trim();
      const itemArtist = (item.artist ? item.artist.name : "").toLowerCase().trim();
      if (itemName === normName && itemArtist.includes(normArtist)) {
        return item;
      }
    }

    // Relax: name match, partial artist
    for (const item of items) {
      const itemName = (item.title || "").toLowerCase().trim();
      const itemArtists = (item.artists || []).map((a) => a.name.toLowerCase());
      if (
        itemName === normName &&
        itemArtists.some((a) => a.includes(normArtist) || normArtist.includes(a))
      ) {
        return item;
      }
    }

    // Fall back to first result
    return items[0];
  },

  async matchTrack(token, track) {
    // 1. Try ISRC first
    if (track.isrc) {
      const match = await this.searchByISRC(token, track.isrc);
      if (match) return { tidalId: match.id, matchMethod: "isrc", title: match.title };
    }

    // 2. Fallback to name + artist search
    const artistStr = (track.artists || []).join(" ");
    if (track.name && artistStr) {
      const match = await this.searchByName(token, track.name, artistStr);
      if (match) return { tidalId: match.id, matchMethod: "name", title: match.title };
    }

    return null;
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
    const res = await this._fetchRaw(token, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(name)}&description=${encodeURIComponent(description || "")}`,
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
      const res = await this._fetchRaw(token, url);

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
    const url = `${this.BASE}/users/${userId}/playlists?countryCode=${this.countryCode}&limit=50`;
    const data = await this._fetch(token, url);
    return data.items || [];
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
