// Library accumulator — populated by the background replay drivers and by
// the filterResponseData listener observing live pathfinder traffic.
//
// Track extraction (liked songs and per-playlist tracks) is owned by the
// replay drivers in background.js, which write directly into
// `playlistTracks[id]`. This module only handles entity-level extraction
// (playlists, albums, artists) from libraryV3 responses, plus the
// normalization helpers shared by the drivers.

const SpotifyCapture = {
  playlists: [],
  albums: [],
  artists: [],
  playlistTracks: {},  // playlistId -> tracks[]; "__liked__" for Liked Songs
  seenPlaylistIds: new Set(),
  seenAlbumIds: new Set(),
  seenArtistIds: new Set(),

  clear() {
    this.playlists = [];
    this.albums = [];
    this.artists = [];
    this.playlistTracks = {};
    this.seenPlaylistIds = new Set();
    this.seenAlbumIds = new Set();
    this.seenArtistIds = new Set();
  },

  // Walk a libraryV3 response and add each item as the right entity type.
  // Tracks are not extracted here — the replay drivers handle those directly.
  processResponse(data) {
    const lib = data?.data?.me?.libraryV3 || data?.data?.libraryV3;
    if (!lib) return;
    for (const item of lib.items || []) {
      const inner = item.item?.data || item;
      const uri = inner.uri || "";
      if (uri.includes(":playlist:")) this._addPlaylist(inner);
      else if (uri.includes(":album:")) this._addAlbum(inner);
      else if (uri.includes(":artist:")) this._addArtist(inner);
    }
  },

  _addPlaylist(data) {
    const uri = data.uri || "";
    const id = uri.split(":").pop() || data.id || "";
    if (!id || this.seenPlaylistIds.has(id)) return;

    const format = data.format || data.attributes?.formatAttributes?.format || "";
    if (format.toLowerCase() === "radio") return;
    const name = data.name || data.title || "";
    if (this._isRadioPlaylist(name)) return;
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

  _isRadioPlaylist(name) {
    return /\bradio\b/.test((name || "").toLowerCase());
  },

  _isEpisodeCollection(name, uri) {
    const lower = (name || "").toLowerCase();
    if (/^(your episodes|deine episoden|tus episodios|tes épisodes|i tuoi episodi|je afleveringen)$/.test(lower)) return true;
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
    if (data.trackMetadata) return this._normalizeTrack(data.trackMetadata, addedAt);
    if (!(data.name || data.title)) return null;

    const uri = data.uri || "";
    const id = uri.split(":").pop() || data.id || "";
    if (!id) return null;

    // Spotify dropped ISRCs from web responses around 2024 — kept as a
    // best-effort lookup in case any path still carries them.
    const isrc = data.externalId?.isrc
      || data.external_ids?.isrc
      || data.externalIds?.isrc
      || data.playability?.playable?.externalId?.isrc
      || "";

    const durationMs =
      data.trackDuration?.totalMilliseconds
      || data.duration?.totalMilliseconds
      || data.duration_ms
      || data.durationMs
      || 0;

    return {
      name: data.name || data.title || "",
      artists: this._extractArtists(data),
      album: data.albumOfTrack?.name || data.album?.name || "",
      isrc,
      spotifyUri: uri,
      spotifyId: id,
      durationMs,
      addedAt: this._normalizeDate(addedAt),
      explicit: data.contentRating?.label === "EXPLICIT",
      trackNumber: data.trackNumber || 0,
      discNumber: data.discNumber || 0,
    };
  },

  // Spotify ships dates either as ISO strings or as `{ isoString }` wrappers
  // (same shape it uses for `albumOfTrack.date`).
  _normalizeDate(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") return value.isoString || value.iso_string || "";
    return "";
  },

  _extractArtists(data) {
    if (data.artists?.items) {
      return data.artists.items.map((a) => a.profile?.name || a.name || "");
    }
    if (Array.isArray(data.artists)) {
      return data.artists.map((a) => a.name || a.profile?.name || "");
    }
    if (data.firstArtist) return [data.firstArtist.name || ""];
    return [];
  },

  getStats() {
    return {
      likedSongs: (this.playlistTracks["__liked__"] || []).length,
      playlists: this.playlists.length,
      albums: this.albums.length,
      artists: this.artists.length,
      playlistsWithTracks: Object.keys(this.playlistTracks).length,
    };
  },
};
