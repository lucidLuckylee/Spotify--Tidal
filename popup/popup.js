// Popup script

const $ = (sel) => document.querySelector(sel);

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  refreshStatus();
  setupListeners();
});

// ── Status refresh ──────────────────────────────────────────────────────────

async function refreshStatus() {
  const s = await browser.runtime.sendMessage({ action: "GET_STATUS" });

  // Spotify
  if (s.spotifyConnected) {
    $("#spotify-icon").classList.add("connected");
    $("#spotify-icon").title = "Spotify — Connected";
  } else {
    $("#spotify-icon").classList.remove("connected");
    $("#spotify-icon").title = "Spotify — Not connected";
  }

  // Tidal
  if (s.tidalConnected) {
    $("#tidal-icon").classList.add("connected");
    $("#tidal-icon").title = "Tidal — Connected";
  } else {
    $("#tidal-icon").classList.remove("connected");
    $("#tidal-icon").title = "Tidal — Not connected";
  }

  // Show onboarding if neither service is connected and no data
  const bothDisconnected = !s.spotifyConnected && !s.tidalConnected;
  if (bothDisconnected && !s.hasLibrary) {
    $("#onboarding").classList.remove("hidden");
    $("#main-section").classList.add("hidden");
  } else {
    $("#onboarding").classList.add("hidden");
    $("#main-section").classList.remove("hidden");
  }

  // Update onboarding badges
  $("#ob-spotify").className = s.spotifyConnected ? "ob-badge connected" : "ob-badge disconnected";
  $("#ob-tidal").className = s.tidalConnected ? "ob-badge connected" : "ob-badge disconnected";

  // Capture in progress
  if (s.capturing && captureState === "idle") {
    captureState = "capturing";
    const btn = $("#btn-capture-all");
    btn.disabled = false;
    btn.classList.add("capturing");
    btn.textContent = "Capturing...";
  }

  // Playlist list (auto-saved from capture)
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

  // Export state
  if (s.exporting) {
    $("#btn-export").disabled = true;
    $("#btn-export").textContent = "Exporting...";
    $("#export-progress").classList.remove("hidden");
  }
  if (s.exportState?.completedAt && (s.exportState.tidalMatched.length > 0 || s.exportState.tidalFailed.length > 0)) {
    showExportResults(s.exportState);
  }
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

let captureState = "idle"; // "idle" | "capturing" | "paused"
let captureProgressText = ""; // stored progress text for hover restore
let playlistData = []; // current playlist list (mutable for merges)

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

    // Toggle indicator
    const dot = document.createElement("span");
    dot.className = "toggle-dot on";
    item.appendChild(dot);

    // Info
    const info = document.createElement("div");
    info.className = "playlist-info";
    const name = document.createElement("div");
    name.className = "playlist-name";
    name.textContent = pl.name;
    const meta = document.createElement("div");
    meta.className = "playlist-meta";
    const mergedLabel = pl.mergedFrom ? ` (merged ${pl.mergedFrom.length + 1})` : "";
    meta.textContent = `${pl.trackCount.toLocaleString()} tracks${mergedLabel}`;
    info.appendChild(name);
    info.appendChild(meta);
    item.appendChild(info);

    // Badge
    const badge = document.createElement("span");
    badge.className = pl.isLikedSongs ? "playlist-badge favorites" : "playlist-badge";
    badge.textContent = pl.isLikedSongs ? "Favorites" : "Playlist";
    item.appendChild(badge);

    // Click to toggle
    item.addEventListener("click", (e) => {
      if (dragActive) return;
      const on = item.dataset.checked === "true";
      item.dataset.checked = on ? "false" : "true";
      item.classList.toggle("selected", !on);
      dot.classList.toggle("on", !on);
    });

    // Long press to start drag (not on liked songs)
    if (!pl.isLikedSongs) {
      setupLongPressDrag(item);
      item.addEventListener("dragover", onDragOver);
      item.addEventListener("dragleave", onDragLeave);
      item.addEventListener("drop", onDrop);
    }

    list.appendChild(item);
  }
}

// ── Long-press drag & drop merge ───────────────────────────────────────────

let dragSourceId = null;
let dragActive = false;
let longPressTimer = null;

function setupLongPressDrag(item) {
  item.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      dragActive = true;
      item.draggable = true;
      item.classList.add("drag-ready");
    }, 400);
  });

  item.addEventListener("mouseup", () => clearLongPress());
  item.addEventListener("mouseleave", () => clearLongPress());

  item.addEventListener("dragstart", (e) => {
    if (!dragActive) { e.preventDefault(); return; }
    dragSourceId = item.dataset.id;
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragSourceId);
  });

  item.addEventListener("dragend", () => {
    item.draggable = false;
    item.classList.remove("dragging", "drag-ready");
    dragActive = false;
    dragSourceId = null;
    document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  });
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function onDragOver(e) {
  e.preventDefault();
  const item = e.target.closest(".playlist-item");
  if (!item || item.dataset.id === dragSourceId) return;
  e.dataTransfer.dropEffect = "move";
  item.classList.add("drag-over");
}

function onDragLeave(e) {
  const item = e.target.closest(".playlist-item");
  if (item) item.classList.remove("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  const targetItem = e.target.closest(".playlist-item");
  if (!targetItem) return;
  targetItem.classList.remove("drag-over");

  const targetId = targetItem.dataset.id;
  if (!dragSourceId || dragSourceId === targetId) return;

  const sourceIdx = playlistData.findIndex((p) => p.spotifyId === dragSourceId);
  const targetIdx = playlistData.findIndex((p) => p.spotifyId === targetId);
  if (sourceIdx < 0 || targetIdx < 0) return;

  const source = playlistData[sourceIdx];
  const target = playlistData[targetIdx];

  // Merge: target keeps its name, track count is combined
  target.trackCount = (target.trackCount || 0) + (source.trackCount || 0);
  target.mergedFrom = [...(target.mergedFrom || []), source.spotifyId, ...(source.mergedFrom || [])];

  browser.runtime.sendMessage({
    action: "MERGE_PLAYLISTS",
    sourceId: source.spotifyId,
    targetId: target.spotifyId,
  }).catch(() => {});

  playlistData.splice(sourceIdx, 1);
  rebuildPlaylistList();
  dragSourceId = null;
  dragActive = false;
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
  $("#btn-capture-all").addEventListener("click", captureAll);

  // Hover effect: show "Pause" when capturing
  $("#btn-capture-all").addEventListener("mouseenter", () => {
    if (captureState === "capturing") {
      $("#btn-capture-all").textContent = "Pause";
    }
  });
  $("#btn-capture-all").addEventListener("mouseleave", () => {
    if (captureState === "capturing") {
      $("#btn-capture-all").textContent = captureProgressText || "Capturing...";
    }
  });
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
    if (msg.action === "CAPTURE_UPDATE") {
      refreshStatus();
    } else if (msg.action === "EXPORT_PROGRESS") {
      updateExportProgress(msg);
    } else if (msg.action === "LOG") {
      appendLog(msg.text);
    } else if (msg.action === "CAPTURE_PROGRESS") {
      const btn = $("#btn-capture-all");
      if (msg.name === "Paused") {
        captureState = "paused";
        btn.classList.remove("capturing");
        btn.classList.add("paused");
        btn.textContent = msg.total > 0 ? `Paused (${msg.current}/${msg.total})` : "Paused";
        captureProgressText = btn.textContent;
      } else {
        captureState = "capturing";
        btn.classList.remove("paused");
        btn.classList.add("capturing");
        captureProgressText = msg.total > 0 ? `${msg.name} (${msg.current}/${msg.total})` : msg.name;
        btn.textContent = captureProgressText;
      }
      btn.disabled = false;
    } else if (msg.action === "CAPTURE_DONE") {
      captureState = "idle";
      captureProgressText = "";
      const btn = $("#btn-capture-all");
      btn.textContent = "Capture All";
      btn.disabled = false;
      btn.classList.remove("capturing", "paused");
      refreshStatus();
    }
  });
}

// ── Capture All (auto-scroll Spotify tab) ──────────────────────────────────

async function captureAll() {
  const btn = $("#btn-capture-all");

  if (captureState === "capturing") {
    // Pause
    browser.runtime.sendMessage({ action: "PAUSE_CAPTURE" });
    return;
  }

  if (captureState === "paused") {
    // Resume
    captureState = "capturing";
    btn.classList.remove("paused");
    btn.classList.add("capturing");
    btn.textContent = captureProgressText || "Resuming...";
    browser.runtime.sendMessage({ action: "RESUME_CAPTURE" });
    return;
  }

  // Start new capture
  captureState = "capturing";
  btn.classList.add("capturing");
  btn.textContent = "Starting...";

  const result = await browser.runtime.sendMessage({ action: "CAPTURE_ALL" });

  if (result.error) {
    alert(result.error);
  }

  captureState = "idle";
  captureProgressText = "";
  btn.textContent = "Capture All";
  btn.disabled = false;
  btn.classList.remove("capturing", "paused");
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
  // Open in batches to avoid overwhelming the browser
  const MAX_TABS = 20;
  const toOpen = unmatchedTracks.slice(0, MAX_TABS);
  for (const t of toOpen) {
    browser.tabs.create({ url: tidalSearchUrl(t), active: false });
  }
  if (unmatchedTracks.length > MAX_TABS) {
    alert(`Opened first ${MAX_TABS} of ${unmatchedTracks.length}. Close some tabs and click again for the rest.`);
  }
}

