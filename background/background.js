// Background script — Spotify library sync via replayed pathfinder calls,
// plus Tidal export.
//
// We never inject into the page. Live Spotify XHR traffic is observed with
// webRequest listeners to capture two things:
//   1. Pathfinder operation templates (operationName + sha256Hash + sample
//      variables) — recorded by onBeforeRequest from the request URL/body.
//   2. The request headers needed to replay those operations (authorization,
//      client-token, app-platform, spotify-app-version, accept-language) —
//      recorded by onBeforeSendHeaders.
//
// Once the required templates and a valid authorization header are in hand,
// a debounced auto-sync replays the operations with our own pagination
// variables to walk the full library — playlists, albums, artists, liked
// songs, and each playlist's tracks. Auto-sync is rate-limited by a 1-hour
// cooldown; the popup's "Sync now" forces a run regardless.

const SYNC_COOLDOWN_MS = 60 * 60 * 1000;       // throttle auto-syncs
const AUTO_SYNC_DEBOUNCE_MS = 8_000;           // settle period after captures
const REQUIRED_TEMPLATES = ["libraryV3", "fetchPlaylistContents"];
// The web player pages Liked Songs as this constant playlist; Spotify answers
// with the caller's own liked songs.
const LIKED_SONGS_URI = "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ";

const SPOTIFY_REPLAY_HEADERS = new Set([
  "authorization",
  "client-token",
  "app-platform",
  "spotify-app-version",
  "accept-language",
]);

const state = {
  tidalToken: null,
  exporting: false,
  syncing: false,
  spotifyHeaders: {},
  spotifyTemplates: {},
  lastSyncedAt: 0,
};

// ── Restore persisted state on startup ─────────────────────────────────────

(async () => {
  const tokens = await Storage.getTokens();
  if (tokens.tidal) state.tidalToken = tokens.tidal;
  const auth = await Storage.getSpotifyAuth();
  if (auth.headers) state.spotifyHeaders = auth.headers;
  if (auth.templates) state.spotifyTemplates = auth.templates;
  if (auth.lastSyncedAt) state.lastSyncedAt = auth.lastSyncedAt;
})();

// ── Capture Spotify pathfinder operation templates ─────────────────────────

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    captureSpotifyTemplate(details);
  },
  { urls: ["*://*.spotify.com/pathfinder/*"], types: ["xmlhttprequest"] },
  ["requestBody"]
);

// Pathfinder GraphQL operation template capture. Both v1 (POST body) and v2
// (GET URL params) carry operationName + variables + extensions; we save the
// template so we can replay it ourselves with our own variables.
function captureSpotifyTemplate(details) {
  let parsed;
  try { parsed = new URL(details.url); } catch { return; }

  let op = parsed.searchParams.get("operationName");
  let variables = null, extensions = null;
  try { variables = JSON.parse(parsed.searchParams.get("variables") || "null"); } catch {}
  try { extensions = JSON.parse(parsed.searchParams.get("extensions") || "null"); } catch {}

  if (!op || !extensions) {
    const raw = details.requestBody?.raw?.[0]?.bytes;
    if (raw) {
      try {
        const body = JSON.parse(new TextDecoder("utf-8").decode(raw));
        op = op || body.operationName;
        variables = variables || body.variables || null;
        extensions = extensions || body.extensions || null;
      } catch {}
    }
  }

  if (!op || state.spotifyTemplates[op]) return;
  if (!extensions?.persistedQuery?.sha256Hash) return;

  state.spotifyTemplates[op] = {
    endpoint: parsed.origin + parsed.pathname,
    method: details.method || "POST",
    variables: variables || {},
    extensions,
  };
  console.log("[Munchy template]", op);
  schedulePersistAuth();
  scheduleAutoSync();
}

// ── Replay captured pathfinder operations ──────────────────────────────────

async function spotifyReplay(operationName, vars = {}) {
  const tpl = state.spotifyTemplates[operationName];
  if (!tpl) {
    throw new Error(`No template for "${operationName}" — open Spotify so the request can be observed`);
  }
  const variables = { ...tpl.variables, ...vars };
  const headers = { ...state.spotifyHeaders };
  // Pathfinder is strict about these; our captured values are not always trustworthy
  // (telemetry endpoints can leak in different content-types). Hardcode the safe set.
  headers["accept"] = "application/json";
  let url = tpl.endpoint;
  let init;
  if (tpl.method === "POST") {
    headers["content-type"] = "application/json;charset=UTF-8";
    init = {
      method: "POST",
      headers,
      body: JSON.stringify({ operationName, variables, extensions: tpl.extensions }),
      credentials: "include",
    };
  } else {
    const u = new URL(tpl.endpoint);
    u.searchParams.set("operationName", operationName);
    u.searchParams.set("variables", JSON.stringify(variables));
    u.searchParams.set("extensions", JSON.stringify(tpl.extensions));
    url = u.toString();
    delete headers["content-type"];
    init = { method: "GET", headers, credentials: "include" };
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Replay ${operationName} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

// ── Library sync (drives replays for full library) ─────────────────────────

async function syncLibrary({ force = false } = {}) {
  if (state.syncing) return { error: "Sync already in progress" };
  if (!force) {
    const since = Date.now() - state.lastSyncedAt;
    if (state.lastSyncedAt && since < SYNC_COOLDOWN_MS) {
      return { error: `Cooldown — last synced ${Math.round(since / 60000)}m ago` };
    }
  }
  for (const op of REQUIRED_TEMPLATES) {
    if (!state.spotifyTemplates[op]) {
      return { error: `Template "${op}" not captured yet — keep using Spotify` };
    }
  }
  if (!state.spotifyHeaders.authorization) {
    return { error: "No Spotify session captured yet" };
  }

  state.syncing = true;
  SpotifyCapture.clear();
  notifyStatus();
  try {
    const playlists = await listAllPlaylistsViaApi();
    notifyStatus();
    try { await fetchPlaylistTracksViaApi(LIKED_SONGS_URI, "__liked__"); }
    catch (e) { console.warn("[Munchy] liked songs:", e.message); }

    for (const pl of playlists) {
      notifyStatus();
      try { await fetchPlaylistTracksViaApi(pl.uri); }
      catch (e) { console.warn("[Munchy] playlist", pl.uri, e.message); }
    }
    await autoSaveLibrary();
    state.lastSyncedAt = Date.now();
    schedulePersistAuth();
    const stats = SpotifyCapture.getStats();
    console.log("[Munchy] sync done:", stats);
    return { ok: true, stats };
  } catch (e) {
    return { error: e.message };
  } finally {
    state.syncing = false;
    notifyStatus();
    browser.runtime.sendMessage({ action: "SYNC_DONE" }).catch(() => {});
  }
}

async function listAllPlaylistsViaApi() {
  const playlists = [];
  let offset = 0, total = Infinity;
  const limit = 50;
  while (offset < total) {
    // Override the sidebar's captured filter/folder variables so playlists
    // inside folders are listed too.
    const res = await spotifyReplay("libraryV3", {
      offset,
      limit,
      filters: [],
      textFilter: "",
      flatten: true,
      includeFoldersWhenFlattening: false,
      folderUri: null,
      expandedFolders: [],
    });
    const lib = res?.data?.me?.libraryV3;
    if (!lib) break;
    const items = lib.items || [];
    total = typeof lib.totalCount === "number" ? lib.totalCount : (offset + items.length);
    for (const item of items) {
      const inner = item.item?.data || item;
      const uri = inner.uri || "";
      if (uri.includes(":playlist:")) {
        SpotifyCapture.addPlaylist(inner);
        playlists.push({ uri });
      } else if (uri.includes(":album:")) {
        SpotifyCapture.addAlbum(inner);
      } else if (uri.includes(":artist:")) {
        SpotifyCapture.addArtist(inner);
      }
    }
    if (items.length === 0) break;
    offset += items.length;
  }
  return playlists;
}

// Walk a few levels of an item looking for an object that looks like a Track.
// Pathfinder responses sometimes wrap the Track under .data, .track, .itemV2,
// or several layers deep depending on the operation. Returns { node, uri } —
// the URI may come from a wrapper (sometimes shipped as `_uri`) when the
// Track itself doesn't carry one.
function findTrackNode(item, depth = 0, foundUri = "") {
  if (!item || typeof item !== "object" || depth > 4) return null;
  const uri = item.uri || item._uri || foundUri;
  // Episodes and local files also carry a name and duration; only real
  // tracks are matchable on Tidal.
  const looksLikeTrack =
    (item.name || item.title) &&
    (item.__typename === "Track" ||
     (typeof uri === "string" && uri.startsWith("spotify:track:")));
  if (looksLikeTrack) return { node: item, uri };
  for (const key of ["track", "data", "itemV2", "item", "node"]) {
    if (item[key]) {
      const found = findTrackNode(item[key], depth + 1, uri);
      if (found) return found;
    }
  }
  return null;
}

async function fetchPlaylistTracksViaApi(uri, id = uri.split(":").pop()) {
  // fetchPlaylistContents responses don't echo the playlist URI, so we bind
  // tracks to the playlist ourselves rather than relying on the parser.
  let offset = 0, total = Infinity;
  const limit = 100;
  const tracks = [];
  while (offset < total) {
    const res = await spotifyReplay("fetchPlaylistContents", { uri, offset, limit });
    const content = res?.data?.playlistV2?.content;
    if (!content) break;
    const items = content.items || [];
    total = typeof content.totalCount === "number" ? content.totalCount : (offset + items.length);
    for (const item of items) {
      const found = findTrackNode(item);
      if (!found) continue;
      const trackData = found.node.uri ? found.node : { ...found.node, uri: found.uri };
      const t = SpotifyCapture.normalizeTrack(trackData, item.addedAt);
      if (t) tracks.push(t);
    }
    if (items.length === 0) break;
    offset += items.length;
  }
  SpotifyCapture.playlistTracks[id] = tracks;
}

// ── Auto-sync debounce ─────────────────────────────────────────────────────

let autoSyncTimer = null;
function scheduleAutoSync() {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    if (state.syncing) return;
    if (!REQUIRED_TEMPLATES.every((op) => state.spotifyTemplates[op])) return;
    if (!state.spotifyHeaders.authorization) return;
    if (state.lastSyncedAt && Date.now() - state.lastSyncedAt < SYNC_COOLDOWN_MS) return;
    syncLibrary().catch((e) => console.warn("[Munchy] auto-sync:", e.message));
  }, AUTO_SYNC_DEBOUNCE_MS);
}

// ── Persistence ────────────────────────────────────────────────────────────

let persistTimer = null;
function schedulePersistAuth() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    Storage.saveSpotifyAuth({
      headers: state.spotifyHeaders,
      templates: state.spotifyTemplates,
      lastSyncedAt: state.lastSyncedAt,
    }).catch(() => {});
  }, 1000);
}

async function persistTokens() {
  await Storage.saveTokens({
    tidal: state.tidalToken,
  });
}

// ── Header capture ─────────────────────────────────────────────────────────

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    let changed = false;
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (SPOTIFY_REPLAY_HEADERS.has(name) && state.spotifyHeaders[name] !== header.value) {
        state.spotifyHeaders[name] = header.value;
        changed = true;
      }
    }
    if (changed) {
      schedulePersistAuth();
      scheduleAutoSync();
    }
  },
  // Only mirror headers from pathfinder calls — other Spotify endpoints
  // (telemetry, page assets) use different values and would clobber the ones
  // our replay needs.
  { urls: ["*://*.spotify.com/pathfinder/*"] },
  ["requestHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    for (const header of details.requestHeaders) {
      if (header.name.toLowerCase() === "authorization") {
        const match = header.value.match(/^Bearer\s+(.+)$/i);
        if (match && match[1] !== state.tidalToken) {
          state.tidalToken = match[1];
          persistTokens().catch(() => {});
        }
      }
    }
  },
  {
    urls: [
      "*://api.tidal.com/*",
      "*://*.tidal.com/v1/*",
      "*://*.tidal.com/v2/*",
    ],
  },
  ["requestHeaders"]
);

// ── Status broadcast ───────────────────────────────────────────────────────

function notifyStatus() {
  browser.runtime.sendMessage({ action: "SYNC_STATUS" }).catch(() => {});
}

// ── Message handling ───────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "GET_STATUS":
      handleGetStatus().then(sendResponse);
      return true;

    case "SYNC_NOW":
      syncLibrary({ force: true }).then(sendResponse);
      return true;

    case "EXPORT_TIDAL":
      handleExportTidal(msg.options).then(sendResponse);
      return true;

    case "GET_LIBRARY":
      Storage.getLibrary().then(sendResponse);
      return true;

    case "CLEAR_LIBRARY":
      SpotifyCapture.clear();
      state.lastSyncedAt = 0;
      schedulePersistAuth();
      Storage.clearLibrary().then(() => sendResponse({ ok: true }));
      return true;
  }
});

// ── Status ─────────────────────────────────────────────────────────────────

async function handleGetStatus() {
  const library = await Storage.getLibrary();
  const exportState = await Storage.getExportState();

  let libraryStats = null;
  let libraryPlaylists = [];
  if (library) {
    libraryStats = {
      albums: (library.albums || []).length,
      artists: (library.artists || []).length,
      importedAt: library.importedAt,
    };
    libraryPlaylists = (library.playlists || []).map((p) => ({
      spotifyId: p.spotifyId,
      name: p.name,
      trackCount: (p.tracks || []).length || p.trackCount || 0,
      isLikedSongs: !!p.isLikedSongs,
    }));
  }

  const templatesReady = REQUIRED_TEMPLATES.every((op) => !!state.spotifyTemplates[op]);

  // While a sync is running, surface in-progress counts straight from the
  // capture buffer so the popup can render real-time progress.
  let liveStats = null;
  let livePlaylists = null;
  if (state.syncing) {
    const cap = SpotifyCapture.getStats();
    liveStats = {
      albums: cap.albums,
      artists: cap.artists,
      likedSongs: cap.likedSongs,
    };
    livePlaylists = SpotifyCapture.playlists.map((p) => ({
      spotifyId: p.spotifyId,
      name: p.name,
      trackCount: (SpotifyCapture.playlistTracks[p.spotifyId] || []).length,
      isLikedSongs: false,
    }));
    const liked = SpotifyCapture.playlistTracks["__liked__"] || [];
    if (liked.length) {
      livePlaylists.unshift({
        spotifyId: "__liked__",
        name: "Liked Songs",
        trackCount: liked.length,
        isLikedSongs: true,
      });
    }
  }

  return {
    spotifyConnected: !!state.spotifyHeaders.authorization,
    tidalConnected: !!state.tidalToken,
    hasLibrary: !!library,
    libraryStats,
    libraryPlaylists,
    liveStats,
    livePlaylists,
    exportState,
    exporting: state.exporting,
    syncing: state.syncing,
    lastSyncedAt: state.lastSyncedAt,
    templatesReady,
    missingTemplates: REQUIRED_TEMPLATES.filter((op) => !state.spotifyTemplates[op]),
  };
}

// ── Auto-save captured data to storage ─────────────────────────────────────

async function autoSaveLibrary() {
  const playlists = [];
  const likedTracks = SpotifyCapture.playlistTracks["__liked__"] || [];

  if (likedTracks.length > 0) {
    playlists.push({
      name: "Liked Songs",
      description: "",
      spotifyId: "__liked__",
      spotifyUri: "",
      isLikedSongs: true,
      trackCount: likedTracks.length,
      tracks: likedTracks,
      owner: "",
    });
  }

  for (const pl of SpotifyCapture.playlists) {
    const tracks = SpotifyCapture.playlistTracks[pl.spotifyId] || [];
    playlists.push({
      ...pl,
      isLikedSongs: false,
      tracks,
      trackCount: tracks.length || pl.trackCount || 0,
    });
  }

  const library = {
    source: "spotify",
    playlists,
    albums: SpotifyCapture.albums,
    artists: SpotifyCapture.artists,
  };

  await Storage.saveLibrary(library);
  browser.runtime.sendMessage({ action: "CAPTURE_UPDATE" }).catch(() => {});
}

// ── Tidal export ───────────────────────────────────────────────────────────

async function handleExportTidal(options = {}) {
  if (state.exporting) return { error: "Export already in progress" };
  if (!state.tidalToken) return { error: "No Tidal token — open Tidal and browse around" };

  const library = await Storage.getLibrary();
  if (!library) return { error: "No library data — let Spotify sync first" };

  const selectedIds = new Set(options.selectedPlaylists || []);
  const exportAlbums = options.albums !== false;
  const exportArtists = options.artists !== false;

  if (selectedIds.size === 0 && !exportArtists && !exportAlbums) {
    return { error: "Nothing selected to export" };
  }

  state.exporting = true;
  const matched = [];
  const failed = [];
  const duplicates = [];
  let userId;

  try {
    sendLog("Getting Tidal user info...");
    userId = await TidalAPI.getUserId(state.tidalToken);
  } catch (e) {
    state.exporting = false;
    return { error: `Failed to get Tidal user: ${e.message}` };
  }

  // Each track can fan out to multiple Tidal calls (up to four name-search
  // variants). Keep the per-batch parallelism modest so we don't
  // trip rate limits.
  const CONCURRENCY = 4;

  async function processInParallel(items, handler) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(handler));
    }
  }

  // Two-phase match so results are deterministic and keep source order:
  //   1. Parallel match — store {track, match|error} indexed by source
  //      position, no shared mutable state inside the parallel callback.
  //   2. Sequential dedup walk in source order (firstHolder = lowest index,
  //      not first-to-complete).
  // Returns the surviving { track, tidalId } pairs in source order plus the
  // tracks that resolved to an already-seen Tidal ID.
  async function matchTracks(tracks, phase, playlist) {
    const tag = playlist ? { playlist } : {};
    const total = tracks.length;
    const matchResults = new Array(total);
    let done = 0;
    await processInParallel(
      tracks.map((track, idx) => ({ track, idx })),
      async ({ track, idx }) => {
        const desc = `${track.name} — ${(track.artists || []).join(", ")}`;
        try {
          matchResults[idx] = {
            track,
            match: await TidalAPI.matchTrack(state.tidalToken, track),
          };
        } catch (e) {
          matchResults[idx] = { track, error: e };
        }
        done++;
        if (done % CONCURRENCY === 0 || done === total) {
          sendProgress("EXPORT_PROGRESS", { phase, current: done, total, name: desc });
        }
      },
    );

    const seenTidalIds = new Map();
    const toAdd = [];
    const dupes = [];
    let failedCount = 0;
    for (const { track, match, error } of matchResults) {
      if (error || !match) {
        failed.push({ ...track, reason: error ? error.message : "No match found", ...tag });
        failedCount++;
        continue;
      }
      const firstHolder = seenTidalIds.get(match.tidalId);
      if (firstHolder) {
        console.warn("[Munchy] duplicate match — two Spotify tracks resolved to the same Tidal ID", {
          tidalId: match.tidalId,
          tidalTitle: match.title,
          playlist: phase,
          duplicate: { name: track.name, artists: track.artists, album: track.album, durationMs: track.durationMs, spotifyUri: track.spotifyUri },
          firstHolder: { name: firstHolder.name, artists: firstHolder.artists, album: firstHolder.album, durationMs: firstHolder.durationMs, spotifyUri: firstHolder.spotifyUri },
        });
        duplicates.push({
          ...track,
          tidalId: match.tidalId,
          ...tag,
          duplicateOf: { spotifyId: firstHolder.spotifyId, name: firstHolder.name, artists: firstHolder.artists },
        });
        dupes.push(track);
      } else {
        seenTidalIds.set(match.tidalId, track);
        toAdd.push({ track, tidalId: match.tidalId });
      }
    }
    return { toAdd, dupes, failedCount };
  }

  try {
    const selectedPlaylists = (library.playlists || []).filter((p) => selectedIds.has(p.spotifyId));

    for (const pl of selectedPlaylists) {
      if (pl.isLikedSongs) {
        const alreadyExported = await Storage.getExportedIds();
        const toExport = pl.tracks.filter((t) => !alreadyExported.has(t.spotifyId));
        const skipped = pl.tracks.length - toExport.length;
        if (skipped > 0) sendLog(`Liked Songs: skipping ${skipped} already-exported`);

        // Match, then sort the surviving matches by addedAt ASC and call
        // addTrackToFavorites strictly sequentially. Tidal favorites have no
        // manual position, only server-side timestamp ordering, and the
        // endpoint takes one trackId per request, so this is the only way to
        // control the order Tidal stamps them with.
        const { toAdd, dupes, failedCount } = await matchTracks(toExport, "Liked Songs");
        const batchExportedIds = dupes.map((t) => t.spotifyId);
        let lsMatched = 0;
        let lsFailed = failedCount;

        // Oldest first: the earliest-saved Spotify track gets the earliest
        // Tidal addedAt, so Tidal's "recently added" view matches Spotify's.
        // Empty addedAt sorts before populated values, which is fine.
        toAdd.sort((a, b) => {
          const ta = a.track.addedAt || "";
          const tb = b.track.addedAt || "";
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        let addDone = 0;
        for (const { track, tidalId } of toAdd) {
          const desc = `${track.name} — ${(track.artists || []).join(", ")}`;
          try {
            await TidalAPI.addTrackToFavorites(state.tidalToken, userId, tidalId);
            matched.push({ ...track, tidalId });
            batchExportedIds.push(track.spotifyId);
            lsMatched++;
          } catch (e) {
            failed.push({ ...track, reason: e.message });
            lsFailed++;
          }
          addDone++;
          sendProgress("EXPORT_PROGRESS", { phase: "Liked Songs (saving)", current: addDone, total: toAdd.length, name: desc });
        }

        if (batchExportedIds.length > 0) {
          await Storage.addExportedIds(batchExportedIds);
        }
        sendLog(`Liked Songs: ${lsMatched} matched`
          + (dupes.length ? `, ${dupes.length} duplicate` : "")
          + `, ${lsFailed} unmatched`
          + (skipped ? `, ${skipped} skipped` : ""));
      } else {
        sendProgress("EXPORT_PROGRESS", { phase: pl.name, current: 0, total: pl.tracks.length, name: "Finding/creating playlist..." });
        try {
          const { uuid: playlistId, etag: initialEtag, existed } = await TidalAPI.getOrCreatePlaylist(state.tidalToken, userId, pl.name, pl.description || "Imported from Spotify");
          sendLog(existed ? `Found existing playlist: ${pl.name}` : `Created playlist: ${pl.name}`);

          // toAdd keeps Spotify's playlist order.
          const { toAdd, dupes, failedCount } = await matchTracks(pl.tracks, pl.name, pl.name);
          const orderedTrackIds = toAdd.map((m) => m.tidalId);
          for (const { track, tidalId } of toAdd) matched.push({ ...track, tidalId });

          if (orderedTrackIds.length > 0) {
            await TidalAPI.addTracksToPlaylist(state.tidalToken, playlistId, orderedTrackIds, initialEtag);
          }
          sendLog(`${pl.name}: ${toAdd.length} matched`
            + (dupes.length ? `, ${dupes.length} duplicate` : "")
            + `, ${failedCount} unmatched`);
        } catch (e) {
          sendLog(`${pl.name}: failed — ${e.message}`);
        }
      }
    }

    if (exportAlbums && library.albums && library.albums.length > 0) {
      let done = 0;
      let added = 0;
      const total = library.albums.length;
      await processInParallel(library.albums, async (album) => {
        done++;
        const desc = `${album.name} — ${(album.artists || []).join(", ")}`;
        sendProgress("EXPORT_PROGRESS", { phase: "Albums", current: done, total, name: desc });
        try {
          const match = await TidalAPI.searchAlbumByName(state.tidalToken, album.name, album.artists || []);
          if (match) {
            await TidalAPI.addAlbumToFavorites(state.tidalToken, userId, match.id);
            added++;
          }
        } catch (e) {
          console.warn("[Munchy] album", desc, e.message);
        }
      });
      sendLog(`Albums: ${added} of ${total} added`);
    }

    if (exportArtists && library.artists && library.artists.length > 0) {
      let done = 0;
      let added = 0;
      const total = library.artists.length;
      await processInParallel(library.artists, async (artist) => {
        done++;
        sendProgress("EXPORT_PROGRESS", { phase: "Artists", current: done, total, name: artist.name });
        try {
          const match = await TidalAPI.searchArtistByName(state.tidalToken, artist.name);
          if (match) {
            await TidalAPI.addArtistToFavorites(state.tidalToken, userId, match.id);
            added++;
          }
        } catch (e) {
          console.warn("[Munchy] artist", artist.name, e.message);
        }
      });
      sendLog(`Artists: ${added} of ${total} added`);
    }

    const exportState = {
      tidalMatched: matched,
      tidalFailed: failed,
      tidalDuplicates: duplicates,
      completedAt: new Date().toISOString(),
    };
    await Storage.updateExportState(exportState);
    state.exporting = false;
    return { ok: true, stats: { matched: matched.length, duplicates: duplicates.length, failed: failed.length } };
  } catch (e) {
    state.exporting = false;
    return { error: e.message };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sendProgress(action, data) {
  browser.runtime.sendMessage({ action, ...data }).catch(() => {});
}

function sendLog(text) {
  console.log("[Munchy]", text);
  browser.runtime.sendMessage({ action: "LOG", text }).catch(() => {});
}
