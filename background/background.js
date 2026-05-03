// Background script — passive Spotify capture + Tidal export.
//
// We never inject into the page or scroll its DOM. Instead we observe XHR
// traffic with webRequest.filterResponseData to:
//   1. Capture pathfinder operation templates (operationName + sha256Hash +
//      example variables) plus the request headers needed to replay them.
//   2. Read response bodies to opportunistically populate the library.
//
// Once we have enough templates + headers, we replay them ourselves to
// paginate the user's full library — playlists, liked songs, each playlist's
// tracks. This kicks off automatically (debounced) as the user uses Spotify
// and is rate-limited by a sync cooldown.

const SYNC_COOLDOWN_MS = 60 * 60 * 1000;       // throttle auto-syncs
const AUTO_SYNC_DEBOUNCE_MS = 8_000;           // settle period after captures
const REQUIRED_TEMPLATES = ["libraryV3", "fetchLibraryTracks", "fetchPlaylistContents"];

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
  syncStatus: "",
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
  { urls: ["*://*.spotify.com/*"], types: ["xmlhttprequest"] },
  ["requestBody"]
);

// Pathfinder GraphQL operation template capture. Both v1 (POST body) and v2
// (GET URL params) carry operationName + variables + extensions; we save the
// template so we can replay it ourselves with our own variables.
function captureSpotifyTemplate(details) {
  if (!details.url.includes("/pathfinder/")) return;
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
  notifyStatus("Listing playlists...");
  try {
    const playlists = await listAllPlaylistsViaApi();
    notifyStatus(`Liked Songs (1/${playlists.length + 1})`);
    try { await fetchLikedSongsViaApi(); }
    catch (e) { console.warn("[Munchy] liked songs:", e.message); }

    for (let i = 0; i < playlists.length; i++) {
      const pl = playlists[i];
      notifyStatus(`${pl.name} (${i + 2}/${playlists.length + 1})`);
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
    notifyStatus("");
    browser.runtime.sendMessage({ action: "SYNC_DONE" }).catch(() => {});
  }
}

async function listAllPlaylistsViaApi() {
  const playlists = [];
  let offset = 0, total = Infinity;
  const limit = 50;
  while (offset < total) {
    const res = await spotifyReplay("libraryV3", { offset, limit });
    const lib = res?.data?.me?.libraryV3;
    if (!lib) break;
    const items = lib.items || [];
    total = typeof lib.totalCount === "number" ? lib.totalCount : (offset + items.length);
    for (const item of items) {
      const inner = item.item?.data || item;
      const uri = inner.uri || "";
      if (uri.includes(":playlist:")) {
        SpotifyCapture._addPlaylist(inner);
        playlists.push({ uri, name: inner.name || uri });
      } else if (uri.includes(":album:")) {
        SpotifyCapture._addAlbum(inner);
      } else if (uri.includes(":artist:")) {
        SpotifyCapture._addArtist(inner);
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
  const looksLikeTrack =
    (item.name || item.title) &&
    (item.__typename === "Track" ||
     (typeof uri === "string" && uri.startsWith("spotify:track:")) ||
     item.trackDuration || item.duration || item.duration_ms);
  if (looksLikeTrack) return { node: item, uri };
  for (const key of ["track", "data", "itemV2", "item", "node"]) {
    if (item[key]) {
      const found = findTrackNode(item[key], depth + 1, uri);
      if (found) return found;
    }
  }
  return null;
}

async function fetchLikedSongsViaApi() {
  let offset = 0, total = Infinity;
  const limit = 100;
  const tracks = [];
  while (offset < total) {
    const res = await spotifyReplay("fetchLibraryTracks", { offset, limit });
    if (res?.errors) {
      console.warn("[Munchy] fetchLibraryTracks GraphQL errors:", res.errors);
      break;
    }
    const data = res?.data;
    const node =
      data?.me?.libraryV3?.tracks
      || data?.me?.library?.tracks
      || data?.me?.tracks
      || null;
    const items = node?.items || [];
    total = typeof node?.totalCount === "number" ? node.totalCount : (offset + items.length);
    for (const item of items) {
      const found = findTrackNode(item);
      if (!found) continue;
      // Backfill uri from the wrapper if the Track itself didn't carry one.
      const trackData = found.node.uri ? found.node : { ...found.node, uri: found.uri };
      const t = SpotifyCapture._normalizeTrack(trackData, item.addedAt || item.added_at);
      if (t) tracks.push(t);
    }
    if (items.length === 0) break;
    offset += items.length;
  }
  console.log("[Munchy] liked songs:", tracks.length, "/", total);
  SpotifyCapture.playlistTracks["__liked__"] = tracks;
}

async function fetchPlaylistTracksViaApi(uri) {
  // fetchPlaylistContents responses don't echo the playlist URI, so we bind
  // tracks to the playlist ourselves rather than relying on the parser.
  const id = uri.split(":").pop();
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
      const t = SpotifyCapture._normalizeTrack(trackData, item.addedAt);
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
    // Only mirror headers from pathfinder calls — other Spotify endpoints
    // (telemetry, page assets) use different content-type/accept values and
    // would clobber the ones our replay needs.
    const isPathfinder = details.url.includes("/pathfinder/");
    let changed = false;
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (isPathfinder && SPOTIFY_REPLAY_HEADERS.has(name) && state.spotifyHeaders[name] !== header.value) {
        state.spotifyHeaders[name] = header.value;
        changed = true;
      }
    }
    if (changed) {
      schedulePersistAuth();
      scheduleAutoSync();
    }
    return {};
  },
  { urls: ["*://*.spotify.com/*"] },
  ["requestHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    for (const header of details.requestHeaders) {
      if (header.name.toLowerCase() === "authorization") {
        const match = header.value.match(/^Bearer\s+(.+)$/i);
        if (match && match[1] !== state.tidalToken) {
          state.tidalToken = match[1];
          persistTokens();
        }
      }
    }
    return {};
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

function notifyStatus(msg) {
  state.syncStatus = msg;
  browser.runtime.sendMessage({ action: "SYNC_STATUS", status: msg }).catch(() => {});
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

    case "GET_EXPORT_STATE":
      Storage.getExportState().then(sendResponse);
      return true;

    case "MERGE_PLAYLISTS":
      handleMergePlaylists(msg.sourceId, msg.targetId).then(sendResponse);
      return true;

    case "CLEAR_LIBRARY":
      SpotifyCapture.clear();
      state.lastSyncedAt = 0;
      schedulePersistAuth();
      Storage.clearLibrary().then(() => sendResponse({ ok: true }));
      return true;

    case "OPEN_TAB":
      browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") });
      sendResponse({ ok: true });
      return false;
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

  return {
    spotifyConnected: !!state.spotifyHeaders.authorization,
    tidalConnected: !!state.tidalToken,
    hasLibrary: !!library,
    libraryStats,
    libraryPlaylists,
    exportState,
    exporting: state.exporting,
    syncing: state.syncing,
    syncStatus: state.syncStatus,
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
  browser.runtime.sendMessage({
    action: "CAPTURE_UPDATE",
    stats: SpotifyCapture.getStats(),
  }).catch(() => {});
}

// ── Playlist merge ─────────────────────────────────────────────────────────

async function handleMergePlaylists(sourceId, targetId) {
  const library = await Storage.getLibrary();
  if (!library || !library.playlists) return { error: "No library" };

  const sourceIdx = library.playlists.findIndex((p) => p.spotifyId === sourceId);
  const targetIdx = library.playlists.findIndex((p) => p.spotifyId === targetId);
  if (sourceIdx < 0 || targetIdx < 0) return { error: "Playlist not found" };

  const source = library.playlists[sourceIdx];
  const target = library.playlists[targetIdx];

  const seen = new Set((target.tracks || []).map((t) => t.spotifyId));
  for (const track of source.tracks || []) {
    if (!seen.has(track.spotifyId)) {
      target.tracks.push(track);
      seen.add(track.spotifyId);
    }
  }
  target.trackCount = target.tracks.length;

  library.playlists.splice(sourceIdx, 1);
  await Storage.saveLibrary(library);
  return { ok: true };
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
  let userId;

  try {
    sendLog("Getting Tidal user info...");
    userId = await TidalAPI.getUserId(state.tidalToken);
  } catch (e) {
    state.exporting = false;
    return { error: `Failed to get Tidal user: ${e.message}` };
  }

  const CONCURRENCY = 10;

  async function processInParallel(items, handler) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(handler));
    }
  }

  try {
    const selectedPlaylists = (library.playlists || []).filter((p) => selectedIds.has(p.spotifyId));

    for (const pl of selectedPlaylists) {
      if (pl.isLikedSongs) {
        const alreadyExported = await Storage.getExportedIds();
        const toExport = pl.tracks.filter((t) => !alreadyExported.has(t.spotifyId));
        const skipped = pl.tracks.length - toExport.length;
        if (skipped > 0) sendLog(`Liked Songs: skipping ${skipped} already-exported`);

        const total = toExport.length;
        let done = 0;
        const batchExportedIds = [];

        await processInParallel(toExport, async (track) => {
          const desc = `${track.name} — ${(track.artists || []).join(", ")}`;
          try {
            const match = await TidalAPI.matchTrack(state.tidalToken, track);
            if (match) {
              await TidalAPI.addTrackToFavorites(state.tidalToken, userId, match.tidalId);
              matched.push({ ...track, tidalId: match.tidalId, matchMethod: match.matchMethod });
              batchExportedIds.push(track.spotifyId);
            } else {
              failed.push({ ...track, reason: "No match found" });
            }
          } catch (e) {
            failed.push({ ...track, reason: e.message });
          }
          done++;
          if (done % CONCURRENCY === 0 || done === total) {
            sendProgress("EXPORT_PROGRESS", { phase: "Liked Songs", current: done, total, name: desc });
          }
        });
        if (batchExportedIds.length > 0) {
          await Storage.addExportedIds(batchExportedIds);
        }
        sendLog(`Liked Songs: ${matched.length} matched, ${failed.length} unmatched` + (skipped ? `, ${skipped} skipped` : ""));
      } else {
        sendProgress("EXPORT_PROGRESS", { phase: pl.name, current: 0, total: pl.tracks.length, name: "Finding/creating playlist..." });
        try {
          const { uuid: playlistId, etag: initialEtag, existed } = await TidalAPI.getOrCreatePlaylist(state.tidalToken, userId, pl.name, pl.description || "Imported from Spotify");
          sendLog(existed ? `Found existing playlist: ${pl.name}` : `Created playlist: ${pl.name}`);

          const trackIds = [];
          let done = 0;
          const total = pl.tracks.length;
          let plMatched = 0;
          let plFailed = 0;
          await processInParallel(pl.tracks, async (track) => {
            const desc = `${track.name} — ${(track.artists || []).join(", ")}`;
            try {
              const match = await TidalAPI.matchTrack(state.tidalToken, track);
              if (match) {
                trackIds.push(match.tidalId);
                matched.push({ ...track, tidalId: match.tidalId, matchMethod: match.matchMethod });
                plMatched++;
              } else {
                failed.push({ ...track, reason: "No match found", playlist: pl.name });
                plFailed++;
              }
            } catch (e) {
              failed.push({ ...track, reason: e.message, playlist: pl.name });
              plFailed++;
            }
            done++;
            if (done % CONCURRENCY === 0 || done === total) {
              sendProgress("EXPORT_PROGRESS", { phase: pl.name, current: done, total, name: desc });
            }
          });
          const uniqueTrackIds = [...new Set(trackIds)];
          if (uniqueTrackIds.length > 0) {
            await TidalAPI.addTracksToPlaylist(state.tidalToken, playlistId, uniqueTrackIds, initialEtag);
          }
          sendLog(`${pl.name}: ${plMatched} matched, ${plFailed} unmatched`);
        } catch (e) {
          sendLog(`${pl.name}: failed — ${e.message}`);
        }
      }
    }

    if (exportAlbums && library.albums && library.albums.length > 0) {
      let done = 0;
      const total = library.albums.length;
      await processInParallel(library.albums, async (album) => {
        done++;
        const desc = `${album.name} — ${(album.artists || []).join(", ")}`;
        sendProgress("EXPORT_PROGRESS", { phase: "Albums", current: done, total, name: desc });
        try {
          const artistStr = (album.artists || []).join(" ");
          const match = await TidalAPI.searchAlbumByName(state.tidalToken, album.name, artistStr);
          if (match) {
            await TidalAPI.addAlbumToFavorites(state.tidalToken, userId, match.id);
          }
        } catch { /* best effort */ }
      });
      sendLog(`Albums: ${library.albums.length} processed`);
    }

    if (exportArtists && library.artists && library.artists.length > 0) {
      let done = 0;
      const total = library.artists.length;
      await processInParallel(library.artists, async (artist) => {
        done++;
        sendProgress("EXPORT_PROGRESS", { phase: "Artists", current: done, total, name: artist.name });
        try {
          const match = await TidalAPI.searchArtistByName(state.tidalToken, artist.name);
          if (match) {
            await TidalAPI.addArtistToFavorites(state.tidalToken, userId, match.id);
          }
        } catch { /* best effort */ }
      });
      sendLog(`Artists: ${library.artists.length} processed`);
    }

    const exportState = {
      tidalMatched: matched,
      tidalFailed: failed,
      progress: { current: matched.length + failed.length, total: matched.length + failed.length },
      completedAt: new Date().toISOString(),
    };
    await Storage.updateExportState(exportState);
    state.exporting = false;
    return { ok: true, stats: { matched: matched.length, failed: failed.length } };
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
