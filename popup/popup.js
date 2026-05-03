// Popup script

const $ = (sel) => document.querySelector(sel);

document.addEventListener("DOMContentLoaded", () => {
  refreshStatus();
  setupListeners();
});

// ── Status refresh ──────────────────────────────────────────────────────────

async function refreshStatus() {
  const s = await browser.runtime.sendMessage({ action: "GET_STATUS" });

  // Service indicators
  setIcon("#spotify-icon", s.spotifyConnected, "Spotify");
  setIcon("#tidal-icon", s.tidalConnected, "Tidal");

  // Show onboarding if neither service is connected and no data
  const bothDisconnected = !s.spotifyConnected && !s.tidalConnected;
  if (bothDisconnected && !s.hasLibrary) {
    $("#onboarding").classList.remove("hidden");
    $("#main-section").classList.add("hidden");
  } else {
    $("#onboarding").classList.add("hidden");
    $("#main-section").classList.remove("hidden");
  }
  $("#ob-spotify").className = s.spotifyConnected ? "ob-badge connected" : "ob-badge disconnected";
  $("#ob-tidal").className = s.tidalConnected ? "ob-badge connected" : "ob-badge disconnected";

  // Sync status row
  updateSyncStatus(s);

  // Playlist list
  if (s.hasLibrary && s.libraryPlaylists && s.libraryPlaylists.length > 0) {
    renderPlaylistSelect(s.libraryPlaylists, s.libraryStats || {});
    const plCount = s.libraryPlaylists.length;
    const trackCount = s.libraryPlaylists.reduce((sum, p) => sum + (p.trackCount || 0), 0);
    $("#playlist-summary").textContent = `${plCount} playlists, ${trackCount.toLocaleString()} tracks`;
    $("#btn-export").disabled = !s.tidalConnected || s.exporting;
    $("#export-empty-hint").classList.add("hidden");
    $("#playlist-select").classList.remove("hidden");
  } else {
    $("#playlist-summary").textContent = "";
    $("#btn-export").disabled = true;
    $("#export-empty-hint").classList.remove("hidden");
    $("#playlist-select").classList.add("hidden");
  }

  if (s.exporting) {
    $("#btn-export").disabled = true;
    $("#btn-export").textContent = "Exporting...";
    $("#export-progress").classList.remove("hidden");
  }
  if (s.exportState?.completedAt && (s.exportState.tidalMatched.length > 0 || s.exportState.tidalFailed.length > 0)) {
    showExportResults(s.exportState);
  }
}

function setIcon(sel, connected, label) {
  const el = $(sel);
  if (connected) {
    el.classList.add("connected");
    el.title = `${label} — Connected`;
  } else {
    el.classList.remove("connected");
    el.title = `${label} — Not connected`;
  }
}

function updateSyncStatus(s) {
  const text = $("#sync-status-text");
  const btn = $("#btn-sync-now");

  if (s.syncing) {
    text.textContent = s.syncStatus || "Syncing…";
    btn.disabled = true;
    return;
  }
  if (!s.templatesReady) {
    text.textContent = "Waiting for Spotify session…";
    btn.disabled = true;
    return;
  }
  if (s.lastSyncedAt) {
    text.textContent = `Synced ${formatRelative(s.lastSyncedAt)}`;
  } else {
    text.textContent = "Ready — sync hasn't run yet";
  }
  btn.disabled = false;
}

function formatRelative(ts) {
  const ms = Date.now() - ts;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function showExportResults(exportState) {
  $("#export-results").classList.remove("hidden");
  const m = exportState.tidalMatched.length;
  const f = exportState.tidalFailed.length;

  const statsEl = $("#export-stats-text");
  statsEl.textContent = "";
  const matchedSpan = document.createElement("span");
  matchedSpan.style.color = "#1db954";
  matchedSpan.textContent = `${m} matched`;
  const sep = document.createTextNode(" \u00B7 ");
  const failedSpan = document.createElement("span");
  failedSpan.style.color = "#e74c3c";
  failedSpan.textContent = `${f} unmatched`;
  statsEl.appendChild(matchedSpan);
  statsEl.appendChild(sep);
  statsEl.appendChild(failedSpan);

  if (f > 0) $("#btn-view-unmatched").classList.remove("hidden");
}

// ── Playlist selection ────────────────────────────────────────────────────────

let playlistData = [];

function renderPlaylistSelect(playlists, stats) {
  playlistData = playlists.map((pl) => ({ ...pl }));
  rebuildPlaylistList();
  $("#album-count").textContent = stats.albums > 0 ? `${stats.albums}` : "";
  $("#artist-count").textContent = stats.artists > 0 ? `${stats.artists}` : "";
}

function rebuildPlaylistList() {
  const list = $("#playlist-list");
  list.innerHTML = "";

  for (const pl of playlistData) {
    const item = document.createElement("div");
    item.className = "playlist-item selected";
    item.dataset.id = pl.spotifyId;
    item.dataset.checked = "true";

    const dot = document.createElement("span");
    dot.className = "toggle-dot on";
    item.appendChild(dot);

    const info = document.createElement("div");
    info.className = "playlist-info";
    const name = document.createElement("div");
    name.className = "playlist-name";
    name.textContent = pl.name;
    const meta = document.createElement("div");
    meta.className = "playlist-meta";
    meta.textContent = `${pl.trackCount.toLocaleString()} tracks`;
    info.appendChild(name);
    info.appendChild(meta);
    item.appendChild(info);

    const badge = document.createElement("span");
    badge.className = pl.isLikedSongs ? "playlist-badge favorites" : "playlist-badge";
    badge.textContent = pl.isLikedSongs ? "Favorites" : "Playlist";
    item.appendChild(badge);

    item.addEventListener("click", () => {
      const on = item.dataset.checked === "true";
      item.dataset.checked = on ? "false" : "true";
      item.classList.toggle("selected", !on);
      dot.classList.toggle("on", !on);
    });

    list.appendChild(item);
  }
}

function getSelectedPlaylistIds() {
  const items = document.querySelectorAll("#playlist-list .playlist-item");
  return [...items].filter((el) => el.dataset.checked === "true").map((el) => el.dataset.id);
}

// ── Activity log ────────────────────────────────────────────────────────────

function appendLog(text) {
  const log = $("#export-log");
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 50) log.removeChild(log.firstChild);
}

// ── Event listeners ─────────────────────────────────────────────────────────

function setupListeners() {
  $("#btn-sync-now").addEventListener("click", syncNow);
  $("#btn-export").addEventListener("click", startExport);
  $("#btn-export-json").addEventListener("click", exportJson);
  $("#btn-clear").addEventListener("click", clearLibrary);
  $("#btn-view-unmatched").addEventListener("click", showUnmatched);
  $("#btn-search-all-tidal").addEventListener("click", openAllTidalSearches);
  $("#link-spotify").addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: "https://open.spotify.com" });
  });
  $("#link-tidal").addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: "https://listen.tidal.com" });
  });
  $("#select-all").addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll("#playlist-list .playlist-item").forEach((el) => {
      el.dataset.checked = "true";
      el.classList.add("selected");
      el.querySelector(".toggle-dot")?.classList.add("on");
    });
  });
  $("#select-none").addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll("#playlist-list .playlist-item").forEach((el) => {
      el.dataset.checked = "false";
      el.classList.remove("selected");
      el.querySelector(".toggle-dot")?.classList.remove("on");
    });
  });
  $("#btn-close-modal").addEventListener("click", () => {
    $("#unmatched-modal").classList.add("hidden");
  });
  $("#btn-open-tab").addEventListener("click", () => {
    browser.runtime.sendMessage({ action: "OPEN_TAB" });
    window.close();
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "CAPTURE_UPDATE" || msg.action === "SYNC_DONE" || msg.action === "SYNC_STATUS") {
      refreshStatus();
    } else if (msg.action === "EXPORT_PROGRESS") {
      updateExportProgress(msg);
    } else if (msg.action === "LOG") {
      appendLog(msg.text);
    }
  });
}

async function syncNow() {
  const btn = $("#btn-sync-now");
  btn.disabled = true;
  const result = await browser.runtime.sendMessage({ action: "SYNC_NOW" });
  if (result?.error) {
    $("#sync-status-text").textContent = result.error;
  }
  refreshStatus();
}

// ── Export ───────────────────────────────────────────────────────────────────

async function startExport() {
  $("#btn-export").disabled = true;
  $("#btn-export").textContent = "Exporting...";
  $("#export-progress").classList.remove("hidden");
  $("#export-fill").style.width = "0%";
  $("#export-text").textContent = "Starting...";
  $("#export-log").innerHTML = "";
  $("#export-results").classList.add("hidden");

  const options = {
    selectedPlaylists: getSelectedPlaylistIds(),
    albums: $("#exp-albums").checked,
    artists: $("#exp-artists").checked,
  };

  const result = await browser.runtime.sendMessage({ action: "EXPORT_TIDAL", options });

  if (result.error) {
    $("#export-text").textContent = `Error: ${result.error}`;
    $("#export-fill").style.width = "0%";
  } else {
    $("#export-text").textContent = `Done! ${result.stats.matched} matched, ${result.stats.failed} unmatched`;
    $("#export-fill").style.width = "100%";
    refreshStatus();
  }

  $("#btn-export").textContent = "Export to Tidal";
  $("#btn-export").disabled = false;
}

function updateExportProgress(msg) {
  const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
  $("#export-fill").style.width = `${pct}%`;
  const detail = msg.name ? ` — ${msg.name}` : "";
  $("#export-text").textContent = `${msg.phase}: ${msg.current}/${msg.total}${detail}`;
}

// ── JSON export ─────────────────────────────────────────────────────────────

async function exportJson() {
  const library = await browser.runtime.sendMessage({ action: "GET_LIBRARY" });
  if (!library) return;
  const blob = new Blob([JSON.stringify(library, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spotify-library-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Clear ───────────────────────────────────────────────────────────────────

function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-dialog");
    $("#confirm-message").textContent = message;
    overlay.classList.remove("hidden");

    function cleanup(result) {
      overlay.classList.add("hidden");
      $("#confirm-ok").removeEventListener("click", onOk);
      $("#confirm-cancel").removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    $("#confirm-ok").addEventListener("click", onOk);
    $("#confirm-cancel").addEventListener("click", onCancel);
  });
}

async function clearLibrary() {
  if (!(await showConfirm("Clear saved library?"))) return;
  await browser.runtime.sendMessage({ action: "CLEAR_LIBRARY" });
  refreshStatus();
  $("#export-results").classList.add("hidden");
}

// ── Unmatched modal ─────────────────────────────────────────────────────────

let unmatchedTracks = [];

async function showUnmatched() {
  const exportState = await browser.runtime.sendMessage({ action: "GET_EXPORT_STATE" });
  unmatchedTracks = exportState.tidalFailed || [];
  const listEl = $("#unmatched-list");
  listEl.textContent = "";

  if (unmatchedTracks.length === 0) {
    const p = document.createElement("p");
    p.style.color = "#888";
    p.textContent = "No unmatched tracks.";
    listEl.appendChild(p);
    $("#btn-search-all-tidal").classList.add("hidden");
  } else {
    $("#btn-search-all-tidal").classList.remove("hidden");
    unmatchedTracks.forEach((t, i) => {
      const item = document.createElement("div");
      item.className = "unmatched-item";
      item.dataset.index = i;
      item.title = "Click to search on Tidal";
      item.style.cursor = "pointer";

      const nameEl = document.createElement("div");
      nameEl.className = "track-name";
      nameEl.textContent = t.name;
      item.appendChild(nameEl);

      const artistEl = document.createElement("div");
      artistEl.className = "track-artist";
      artistEl.textContent = (t.artists || []).join(", ");
      item.appendChild(artistEl);

      const reasonEl = document.createElement("div");
      reasonEl.className = "track-reason";
      reasonEl.textContent = (t.playlist ? `${t.playlist} — ` : "") + (t.reason || "Unknown");
      item.appendChild(reasonEl);

      item.addEventListener("click", () => {
        if (t) openTidalSearch(t);
      });

      listEl.appendChild(item);
    });
  }
  $("#unmatched-modal").classList.remove("hidden");
}

function tidalSearchUrl(track) {
  const query = `${track.name} ${(track.artists || []).join(" ")}`.trim();
  return `https://listen.tidal.com/search?q=${encodeURIComponent(query)}`;
}

function openTidalSearch(track) {
  browser.tabs.create({ url: tidalSearchUrl(track) });
}

function openAllTidalSearches() {
  const MAX_TABS = 20;
  const toOpen = unmatchedTracks.slice(0, MAX_TABS);
  for (const t of toOpen) {
    browser.tabs.create({ url: tidalSearchUrl(t), active: false });
  }
  if (unmatchedTracks.length > MAX_TABS) {
    alert(`Opened first ${MAX_TABS} of ${unmatchedTracks.length}. Close some tabs and click again for the rest.`);
  }
}
