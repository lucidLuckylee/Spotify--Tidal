// Spotify data capture — processes intercepted web player API responses
// instead of making our own API calls (avoids rate limiting)

const SpotifyCapture = {
  // Accumulated data from intercepted responses
  tracks: [],
  playlists: [],
  playlistTracks: {},  // playlistId -> tracks[]
  albums: [],
  artists: [],
  seenTrackIds: new Set(),
  seenPlaylistIds: new Set(),
  seenAlbumIds: new Set(),
  seenArtistIds: new Set(),

  clear() {
    this.tracks = [];
    this.playlists = [];
    this.playlistTracks = {};
    this.albums = [];
    this.artists = [];
    this.seenTrackIds = new Set();
    this.seenPlaylistIds = new Set();
    this.seenAlbumIds = new Set();
    this.seenArtistIds = new Set();
  },

  processResponse(url, data) {
    this._extractFromGraphQL(url, data);
    this._extractFromItems(url, data);
    this._extractFromPlaylist(url, data);
  },

  _extractFromGraphQL(url, data) {
    // api-partner.spotify.com/pathfinder GraphQL responses
    if (!data.data) return;
    const d = data.data;

    // Library responses (fetchLibraryV3, etc.)
    const library = d.me?.libraryV3 || d.me?.library || d.libraryV3;
    if (library) {
      const items = library.items || [];
      for (const item of items) {
        const inner = item.item || item;
        const itemData = inner.data || inner;

        if (itemData.__typename === "Track" || itemData.uri?.includes(":track:")) {
          this._addTrack(itemData, item.addedAt);
        } else if (itemData.__typename === "Album" || itemData.uri?.includes(":album:")) {
          this._addAlbum(itemData);
        } else if (itemData.__typename === "Playlist" || itemData.uri?.includes(":playlist:")) {
          this._addPlaylist(itemData);
        } else if (itemData.__typename === "Artist" || itemData.uri?.includes(":artist:")) {
          this._addArtist(itemData);
        }
      }
    }

    // Liked songs / saved tracks — try many possible paths
    const likedSongs = d.me?.tracks || d.me?.savedTracks || d.me?.likedSongs
      || d.likedSongsTracks || d.me?.libraryV3?.items;
    // ^ libraryV3 already handled above, but we check me.tracks etc.
    if (likedSongs && likedSongs !== library?.items) {
      const items = likedSongs.items || likedSongs.edges || (Array.isArray(likedSongs) ? likedSongs : []);
      for (const item of items) {
        const track = item.node || item.track || item.item?.data || item;
        this._addTrack(track, item.addedAt);
      }
    }

    // Playlist contents
    const playlist = d.playlistV2 || d.playlist;
    if (playlist) {
      if (playlist.content) {
        const plId = (playlist.uri || "").split(":").pop();
        const contentItems = playlist.content.items || playlist.content.edges || [];
        const tracks = [];
        for (const item of contentItems) {
          const track = item.itemV2?.data || item.item?.data || item.node || item;
          const t = this._normalizeTrack(track);
          if (t) tracks.push(t);
        }
        if (plId && tracks.length) {
          this.playlistTracks[plId] = tracks;
        }
      }
    }

    // Handle "lookup" responses — Spotify uses these for entity data on display
    // lookup can be a single entity OR an array-like object with numeric keys
    if (d.lookup) {
      const lookupKeys = Object.keys(d.lookup);
      const isArray = lookupKeys.length > 0 && lookupKeys.every(k => /^\d+$/.test(k));
      if (isArray) {
        for (const key of lookupKeys) {
          this._extractFromLookup(d.lookup[key]);
        }
      } else {
        this._extractFromLookup(d.lookup);
      }
    }

    // Deep scan: walk all keys of d looking for anything with track-like items
    this._deepScanForTracks(d, "data.data", 0);
  },

  // Handle Spotify "lookup" GraphQL responses
  _extractFromLookup(lookup) {
    if (!lookup) return;
    const typename = lookup.__typename || "";
    const uri = lookup.uri || "";

    // Unwrap ResponseWrapper types (e.g. TrackResponseWrapper, AlbumResponseWrapper, etc.)
    if (typename.endsWith("ResponseWrapper") && lookup.data) {
      this._extractFromLookup(lookup.data);
      return;
    }

    // Skip minimal Track objects that only have isCurated (no actual track data)
    if (typename === "Track" && !lookup.uri && !lookup.name) {
      return;
    }

    // Single track
    if (typename === "Track" || uri.includes(":track:")) {
      this._addTrack(lookup);
      return;
    }

    // Album
    if (typename === "Album" || uri.includes(":album:")) {
      this._addAlbum(lookup);
      const tracks = lookup.tracks?.items || lookup.tracklist?.items || [];
      for (const t of tracks) {
        const track = t.track || t.data || t;
        this._addTrack(track);
      }
      return;
    }

    // Playlist
    if (typename === "Playlist" || uri.includes(":playlist:")) {
      this._addPlaylist(lookup);
      const plId = uri.split(":").pop();
      const content = lookup.content?.items || lookup.tracks?.items || [];
      const tracks = [];
      for (const item of content) {
        const track = item.itemV2?.data || item.item?.data || item.node || item;
        const t = this._normalizeTrack(track);
        if (t) tracks.push(t);
      }
      if (plId && tracks.length) {
        this.playlistTracks[plId] = tracks;
      }
      return;
    }

    // Artist
    if (typename === "Artist" || uri.includes(":artist:")) {
      this._addArtist(lookup);
      return;
    }

    // Unknown type — skip
  },

  // Recursively scan response for arrays containing track-like objects
  _deepScanForTracks(obj, path, depth) {
    if (depth > 4 || !obj || typeof obj !== "object") return;

    // Check if this object has items/edges that contain tracks
    const candidates = obj.items || obj.edges || obj.tracks?.items || obj.tracklist?.items;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0];
      const inner = first?.node || first?.track || first?.item?.data || first?.itemV2?.data || first;
      if (inner && (inner.__typename === "Track" || inner.uri?.includes(":track:") || (inner.name && inner.duration))) {
        for (const item of candidates) {
          const track = item.node || item.track || item.item?.data || item.itemV2?.data || item;
          this._addTrack(track, item.addedAt || item.added_at);
        }
        return;
      }
    }

    // Recurse into object properties (skip very large arrays)
    for (const key of Object.keys(obj)) {
      if (key.startsWith("_")) continue;
      const val = obj[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        this._deepScanForTracks(val, `${path}.${key}`, depth + 1);
      }
    }
  },

  _extractFromItems(url, data) {
    // Standard paginated responses with items array
    if (!data.items || !Array.isArray(data.items)) return;

    for (const item of data.items) {
      // Saved tracks format
      if (item.track) {
        this._addTrack(item.track, item.added_at);
        continue;
      }
      // Saved albums format
      if (item.album) {
        this._addAlbum(item.album);
        continue;
      }
      // Playlist list format
      if (item.type === "playlist" || item.uri?.includes(":playlist:")) {
        this._addPlaylist(item);
        continue;
      }
      // Artist format
      if (item.type === "artist" || item.uri?.includes(":artist:")) {
        this._addArtist(item);
        continue;
      }
      // Rootlist format (from spclient)
      if (item.uri?.includes(":playlist:") && item.attributes) {
        this._addPlaylist({
          uri: item.uri,
          name: item.attributes.name,
          description: item.attributes.description,
          format: item.attributes.formatAttributes?.format || "",
          length: item.length,
        });
        continue;
      }
    }
  },

  _extractFromPlaylist(url, data) {
    // Playlist detail responses
    if (data.contents && data.contents.items) {
      const plMatch = url.match(/playlist[:/]([a-zA-Z0-9]+)/);
      if (plMatch) {
        const plId = plMatch[1];
        const tracks = [];
        for (const item of data.contents.items) {
          const t = this._normalizeTrack(item);
          if (t) tracks.push(t);
        }
        if (tracks.length) {
          this.playlistTracks[plId] = tracks;
        }
      }
    }
  },

  _addTrack(data, addedAt) {
    const t = this._normalizeTrack(data, addedAt);
    if (!t) return;
    if (this.seenTrackIds.has(t.spotifyId)) return;
    this.seenTrackIds.add(t.spotifyId);
    this.tracks.push(t);
  },

  _addPlaylist(data) {
    const uri = data.uri || "";
    const id = uri.split(":").pop() || data.id || "";
    if (!id || this.seenPlaylistIds.has(id)) return;

    // Skip radio playlists
    const format = data.format || data.attributes?.formatAttributes?.format || "";
    if (format.toLowerCase() === "radio") return;
    const name = data.name || data.title || "";
    if (this._isRadioPlaylist(name, data)) return;

    // Skip podcast/episode collections
    if (this._isEpisodeCollection(name, uri)) return;

    this.seenPlaylistIds.add(id);
    const trackCount = data.trackCount || data.content?.totalCount || data.content?.total
      || data.tracks?.total || data.length || data.total || 0;
    this.playlists.push({
      name: name || uri,
      description: data.description || "",
      spotifyId: id,
      spotifyUri: uri,
      trackCount,
      owner: data.owner?.name || data.ownerV2?.data?.name || "",
      public: true,
      tracks: [],
    });
  },

  _isRadioPlaylist(name, data) {
    const lower = (name || "").toLowerCase();
    // Explicit radio naming
    if (/\bradio\b/.test(lower)) return true;
    // Spotify-generated radio playlists often have URIs starting with "spotify:playlist:37i9dQZF1"
    // and are owned by Spotify
    const owner = data.owner?.name || data.ownerV2?.data?.name || data.owner?.display_name || "";
    if (owner.toLowerCase() === "spotify" && /\b(mix|daily)\b/.test(lower)) return false; // Daily Mix etc. are playlist-like, keep them
    return false;
  },

  _isEpisodeCollection(name, uri) {
    const lower = (name || "").toLowerCase();
    // "Your Episodes" in multiple languages
    if (/^(your episodes|deine episoden|tus episodios|tes épisodes|i tuoi episodi|je afleveringen)$/.test(lower)) return true;
    // Spotify episode collection URIs
    if (uri && uri.includes(":collection:") && uri.includes("episode")) return true;
    return false;
  },

  _addAlbum(data) {
    const uri = data.uri || "";
    const id = uri.split(":").pop() || data.id || "";
    if (!id || this.seenAlbumIds.has(id)) return;
    this.seenAlbumIds.add(id);
    this.albums.push({
      name: data.name || "",
      artists: this._extractArtists(data),
      spotifyId: id,
      spotifyUri: uri,
      releaseDate: data.date?.isoString || data.release_date || "",
      totalTracks: data.totalTracks || data.total_tracks || 0,
      addedAt: "",
      tracks: [],
    });
  },

  _addArtist(data) {
    const uri = data.uri || "";
    const id = uri.split(":").pop() || data.id || "";
    if (!id || this.seenArtistIds.has(id)) return;
    this.seenArtistIds.add(id);
    this.artists.push({
      name: data.name || data.profile?.name || "",
      spotifyId: id,
      spotifyUri: uri,
      genres: data.genres || [],
    });
  },

  _normalizeTrack(data, addedAt) {
    if (!data) return null;

    // GraphQL format (from pathfinder)
    if (data.name || data.title) {
      const uri = data.uri || "";
      const id = uri.split(":").pop() || data.id || "";
      if (!id) return null;

      // Try many possible ISRC paths
      const isrc = data.externalId?.isrc
        || data.external_ids?.isrc
        || data.externalIds?.isrc
        || data.playability?.playable?.externalId?.isrc
        || "";

      return {
        name: data.name || data.title || "",
        artists: this._extractArtists(data),
        album: data.albumOfTrack?.name || data.album?.name || "",
        isrc,
        spotifyUri: uri,
        spotifyId: id,
        durationMs: data.duration?.totalMilliseconds || data.duration_ms || data.durationMs || 0,
        addedAt: addedAt || "",
      };
    }

    // Nested in trackMetadata (spclient format)
    if (data.trackMetadata) {
      return this._normalizeTrack(data.trackMetadata, addedAt);
    }

    return null;
  },

  _extractArtists(data) {
    // GraphQL format
    if (data.artists?.items) {
      return data.artists.items.map((a) => a.profile?.name || a.name || "");
    }
    // Standard format
    if (Array.isArray(data.artists)) {
      return data.artists.map((a) => a.name || a.profile?.name || "");
    }
    // First artist field
    if (data.firstArtist) {
      return [data.firstArtist.name || ""];
    }
    return [];
  },

  getStats() {
    const likedSongs = (this.playlistTracks["__liked__"] || []).length;
    return {
      tracks: likedSongs,
      playlists: this.playlists.length,
      albums: this.albums.length,
      artists: this.artists.length,
      playlistsWithTracks: Object.keys(this.playlistTracks).length,
      otherTracks: this.tracks.length,
    };
  },
};
