// Background script — token interception + passive data capture

const state = {
  spotifyToken: null,
  tidalToken: null,
  exporting: false,
  capturing: false,
  capturePaused: false,
};

let resumeResolver = null;
function waitForResume() {
  return new Promise((resolve) => { resumeResolver = resolve; });
}

// ── Strip CSP so our content script can inject the fetch interceptor ────────

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    return {
      responseHeaders: details.responseHeaders.map((h) => {
        if (h.name.toLowerCase() === "content-security-policy") {
          // Only relax script-src to allow our inline fetch interceptor
          h.value = h.value.replace(
            /script-src\s+([^;]*)/i,
            (match, policies) => {
              if (policies.includes("'unsafe-inline'")) return match;
              return `script-src ${policies} 'unsafe-inline'`;
            }
          );
        }
        return h;
      }),
    };
  },
  { urls: ["*://open.spotify.com/*"], types: ["main_frame", "sub_frame"] },
  ["blocking", "responseHeaders"]
);

// ── Token interception ──────────────────────────────────────────────────────

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    for (const header of details.requestHeaders) {
      if (header.name.toLowerCase() === "authorization") {
        const match = header.value.match(/^Bearer\s+(.+)$/i);
        if (match && match[1] !== state.spotifyToken) {
          state.spotifyToken = match[1];
          persistTokens();
        }
        break;
      }
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
        break;
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

async function persistTokens() {
  await Storage.saveTokens({
    spotify: state.spotifyToken,
    tidal: state.tidalToken,
  });
}

(async () => {
  const saved = await Storage.getTokens();
  if (saved.spotify && !state.spotifyToken) state.spotifyToken = saved.spotify;
  if (saved.tidal && !state.tidalToken) state.tidalToken = saved.tidal;
})();

// ── Message handling ────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "GET_STATUS":
      handleGetStatus().then(sendResponse);
      return true;

    case "EXPORT_TIDAL":
      handleExportTidal(msg.options).then(sendResponse);
      return true;

    case "CAPTURE_ALL":
      handleCaptureAll().then(sendResponse);
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
      Storage.clearLibrary().then(() => sendResponse({ ok: true }));
      return true;

    case "OPEN_TAB":
      browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") });
      sendResponse({ ok: true });
      return false;

    case "SPOTIFY_FETCH_INTERCEPTED":
      handleInterceptedFetch(msg);
      sendResponse({ ok: true });
      return false;

    case "SCRAPED_TRACKS":
      handleScrapedTracks(msg);
      sendResponse({ ok: true });
      return false;

    case "SPOTIFY_READY":
    case "TIDAL_READY":
      sendResponse({ ok: true });
      return false;

    case "PAUSE_CAPTURE":
      state.capturePaused = true;
      // Abort the current scroll in the content tab
      browser.tabs.query({ url: "*://open.spotify.com/*" }).then((tabs) => {
        if (tabs.length > 0) {
          browser.tabs.sendMessage(tabs[0].id, { action: "ABORT_SCROLL" }).catch(() => {});
        }
      });
      sendResponse({ ok: true });
      return false;

    case "RESUME_CAPTURE":
      state.capturePaused = false;
      resumeResolver?.();
      resumeResolver = null;
      sendResponse({ ok: true });
      return false;

    case "SCROLL_DONE":
      sendResponse({ ok: true });
      return false;
  }
});

// ── Intercepted fetch handler ───────────────────────────────────────────────

function handleInterceptedFetch(msg) {
  const { url, status, body } = msg;
  if (status !== 200) return;

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return;
  }

  const before = SpotifyCapture.getStats();
  SpotifyCapture.processResponse(url, data);
  const after = SpotifyCapture.getStats();

  const diff = {
    tracks: after.tracks - before.tracks,
    playlists: after.playlists - before.playlists,
    albums: after.albums - before.albums,
    artists: after.artists - before.artists,
  };
  // Notify popup if anything new was captured
  if (diff.tracks || diff.playlists || diff.albums || diff.artists) {
    browser.runtime.sendMessage({
      action: "CAPTURE_UPDATE",
      stats: after,
    }).catch(() => {});
  }
}

// ── Scraped tracks from DOM ─────────────────────────────────────────────────

function handleScrapedTracks(msg) {
  const { tracks, playlistId } = msg;
  if (!Array.isArray(tracks) || tracks.length === 0) return;

  if (playlistId) {
    // Known page (liked songs or specific playlist) — store under that ID
    SpotifyCapture.playlistTracks[playlistId] = tracks;
  } else {
    // Unknown page (album, artist, etc.) — add to generic "other" tracks
    const before = SpotifyCapture.tracks.length;
    for (const t of tracks) {
      if (t.spotifyId && !SpotifyCapture.seenTrackIds.has(t.spotifyId)) {
        SpotifyCapture.seenTrackIds.add(t.spotifyId);
        SpotifyCapture.tracks.push(t);
      }
    }
    if (SpotifyCapture.tracks.length === before) return;
  }

  // Auto-save to storage (debounced via microtask to avoid hammering)
  if (!handleScrapedTracks._saving) {
    handleScrapedTracks._saving = true;
    setTimeout(() => {
      handleScrapedTracks._saving = false;
      autoSaveLibrary();
    }, 500);
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

async function handleGetStatus() {
  const library = await Storage.getLibrary();
  const exportState = await Storage.getExportState();
  const captured = SpotifyCapture.getStats();

  let libraryStats = null;
  let libraryPlaylists = [];
  if (library) {
    const liked = (library.playlists || []).find((p) => p.isLikedSongs);
    const regular = (library.playlists || []).filter((p) => !p.isLikedSongs);
    libraryStats = {
      tracks: liked ? liked.tracks.length : 0,
      albums: (library.albums || []).length,
      playlists: regular.length,
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

  return {
    spotifyConnected: !!state.spotifyToken,
    tidalConnected: !!state.tidalToken,
    captured,
    hasLibrary: !!library,
    libraryStats,
    libraryPlaylists,
    exportState,
    exporting: state.exporting,
    capturing: state.capturing,
  };
}

// ── Auto-save captured data to storage ──────────────────────────────────────

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

  // Notify popup
  browser.runtime.sendMessage({
    action: "CAPTURE_UPDATE",
    stats: SpotifyCapture.getStats(),
  }).catch(() => {});
}

// ── Capture All — automatic playlist navigation + scrolling ─────────────────

async function handleCaptureAll() {
  if (state.capturing) return { error: "Capture already in progress" };

  const tabs = await browser.tabs.query({ url: "*://open.spotify.com/*" });
  if (tabs.length === 0) {
    return { error: "Open Spotify first (open.spotify.com)" };
  }
  const tabId = tabs[0].id;
  state.capturing = true;
  state.capturePaused = false;
  resumeResolver = null;

  try {
    // Step 1: Discover playlists by scrolling the sidebar
    sendCaptureProgress("Discovering playlists...", 0, 0);
    const sidebarPlaylists = await scrollSidebarAndWait(tabId);
    sendLog(`Discovered ${sidebarPlaylists.length} playlists from sidebar`);

    // Also pick up any playlists the API interceptor already found (skip radios)
    for (const pl of SpotifyCapture.playlists) {
      if (!sidebarPlaylists.some((s) => s.spotifyId === pl.spotifyId)) {
        if (/\bradio\b/i.test(pl.name)) continue;
        sidebarPlaylists.push({ spotifyId: pl.spotifyId, name: pl.name });
      }
    }

    // Build capture targets: liked songs + all discovered playlists
    const targets = [
      { url: "https://open.spotify.com/collection/tracks", name: "Liked Songs" },
    ];
    for (const pl of sidebarPlaylists) {
      targets.push({
        url: `https://open.spotify.com/playlist/${pl.spotifyId}`,
        name: pl.name,
      });
    }

    // Step 2: Navigate to each target, scroll, and verify
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      sendCaptureProgress(target.name, i + 1, targets.length);

      await navigateTab(tabId, target.url);
      await sleep(2000);

      const result = await scrollTabAndWait(tabId);
      if (result) {
        const { scrapedCount, expectedCount } = result;
        if (expectedCount > 0) {
          sendLog(`${target.name}: ${scrapedCount}/${expectedCount} tracks`);
        } else if (scrapedCount > 0) {
          sendLog(`${target.name}: ${scrapedCount} tracks`);
        }
      }

      // Auto-save this playlist to storage immediately
      await autoSaveLibrary();

      // Check for pause between playlists
      if (state.capturePaused) {
        sendCaptureProgress("Paused", i + 1, targets.length);
        await waitForResume();
      }
    }

    state.capturing = false;
    state.capturePaused = false;
    resumeResolver = null;
    browser.runtime.sendMessage({ action: "CAPTURE_DONE" }).catch(() => {});
    return { ok: true, stats: SpotifyCapture.getStats() };
  } catch (e) {
    state.capturing = false;
    state.capturePaused = false;
    resumeResolver = null;
    return { error: e.message };
  }
}

function sendCaptureProgress(name, current, total) {
  browser.runtime.sendMessage({
    action: "CAPTURE_PROGRESS",
    name, current, total,
  }).catch(() => {});
}

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
    browser.tabs.update(tabId, { url });
  });
}

async function scrollTabAndWait(tabId) {
  let done = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const cleanup = (result) => {
    if (!done) {
      done = true;
      browser.runtime.onMessage.removeListener(onMsg);
      resolvePromise(result || null);
    }
  };

  const onMsg = (msg, sender) => {
    if (msg.action === "SCROLL_DONE" && sender.tab?.id === tabId) {
      cleanup({ scrapedCount: msg.scrapedCount || 0, expectedCount: msg.expectedCount || 0 });
    }
  };
  browser.runtime.onMessage.addListener(onMsg);

  // Timeout after 2 minutes
  setTimeout(() => cleanup(null), 120000);

  // Try sending AUTO_SCROLL with retries (content script may not be ready yet)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await browser.tabs.sendMessage(tabId, { action: "AUTO_SCROLL" });
      return promise; // Sent successfully, now wait for SCROLL_DONE
    } catch {
      await sleep(1000);
    }
  }
  cleanup(null); // Failed after all retries
  return promise;
}

async function scrollSidebarAndWait(tabId) {
  let done = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const cleanup = (result) => {
    if (!done) {
      done = true;
      browser.runtime.onMessage.removeListener(onMsg);
      resolvePromise(result || []);
    }
  };

  const onMsg = (msg, sender) => {
    if (msg.action === "SIDEBAR_DONE" && sender.tab?.id === tabId) {
      cleanup(msg.playlists || []);
    }
  };
  browser.runtime.onMessage.addListener(onMsg);

  // Timeout after 30 seconds
  setTimeout(() => cleanup([]), 30000);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await browser.tabs.sendMessage(tabId, { action: "SCROLL_SIDEBAR" });
      return promise;
    } catch {
      await sleep(1000);
    }
  }
  cleanup([]);
  return promise;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Playlist Merge ──────────────────────────────────────────────────────────

async function handleMergePlaylists(sourceId, targetId) {
  const library = await Storage.getLibrary();
  if (!library || !library.playlists) return { error: "No library" };

  const sourceIdx = library.playlists.findIndex((p) => p.spotifyId === sourceId);
  const targetIdx = library.playlists.findIndex((p) => p.spotifyId === targetId);
  if (sourceIdx < 0 || targetIdx < 0) return { error: "Playlist not found" };

  const source = library.playlists[sourceIdx];
  const target = library.playlists[targetIdx];

  // Merge tracks (union — deduplicate by spotifyId)
  const seen = new Set((target.tracks || []).map((t) => t.spotifyId));
  for (const track of source.tracks || []) {
    if (!seen.has(track.spotifyId)) {
      target.tracks.push(track);
      seen.add(track.spotifyId);
    }
  }
  target.trackCount = target.tracks.length;

  // Remove source playlist
  library.playlists.splice(sourceIdx, 1);
  await Storage.saveLibrary(library);
  return { ok: true };
}

// ── Tidal Export ────────────────────────────────────────────────────────────

async function handleExportTidal(options = {}) {
  if (state.exporting) return { error: "Export already in progress" };
  if (!state.tidalToken) return { error: "No Tidal token — open Tidal and browse around" };

  const library = await Storage.getLibrary();
  if (!library) return { error: "No library data — save your captured Spotify data first" };

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
        // Liked Songs → add to Tidal favorites
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
        // Regular playlist → find existing or create on Tidal, then add tracks
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function sendProgress(action, data) {
  browser.runtime.sendMessage({ action, ...data }).catch(() => {});
}

function sendLog(text) {
  console.log("[Munchy]", text);
  browser.runtime.sendMessage({ action: "LOG", text }).catch(() => {});
}
