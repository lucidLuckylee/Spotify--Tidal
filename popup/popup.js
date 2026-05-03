// Popup script — vanilla port of the React design prototype.

// ── DOM helpers ────────────────────────────────────────────────────────────

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

function rawSvg(markup) {
  // Build an SVG element from a string. Returns the root <svg> node.
  // DOMParser (vs template.innerHTML) keeps AMO's static analyzer happy —
  // markup here is always a hardcoded literal from the icon table below.
  const doc = new DOMParser().parseFromString(markup.trim(), "image/svg+xml");
  return document.importNode(doc.documentElement, true);
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// ── Status / readiness model ───────────────────────────────────────────────

const CHECKS = [
  {
    label: "Sign in to Spotify",
    url: "https://open.spotify.com",
    short: "open.spotify.com",
    isDone: (s) => s.spotifyConnected,
  },
  {
    label: "Open Your Library",
    url: "https://open.spotify.com/collection/playlists",
    short: "spotify.com/collection",
    isDone: (s) => !s.missingTemplates?.includes("libraryV3"),
  },
  {
    label: "Open Liked Songs",
    url: "https://open.spotify.com/collection/tracks",
    short: "collection/tracks",
    isDone: (s) => !s.missingTemplates?.includes("fetchLibraryTracks"),
  },
  {
    label: "Open any playlist",
    url: "https://open.spotify.com",
    short: "open.spotify.com",
    isDone: (s) => !s.missingTemplates?.includes("fetchPlaylistContents"),
  },
  {
    label: "Sign in to Tidal",
    url: "https://listen.tidal.com",
    short: "listen.tidal.com",
  isDone: (s) => s.tidalConnected,
  },
];

function deriveScreen(s) {
  const allReady = CHECKS.every((c) => c.isDone(s));
  if (!allReady) return "ready";
  if (s.exporting) return "exporting";
  if (s.exportState?.completedAt && (
    s.exportState.tidalMatched?.length
    || s.exportState.tidalFailed?.length
    || s.exportState.tidalDuplicates?.length
  )) {
    return "results";
  }
  if (s.syncing || !s.hasLibrary || !s.libraryPlaylists?.length) return "syncing";
  return "library";
}

// ── Header ─────────────────────────────────────────────────────────────────

function renderHeader(s) {
  return h("div", { class: "hdr" },
    h("div", { class: "hdr-title" },
      h("div", { class: "hdr-mark" }),
      h("span", null, "Spotify → Tidal"),
    ),
    h("div", { class: "svc-row" },
      h("span", { class: `svc-pill ${s.spotifyConnected ? "on" : ""}` }, h("span", { class: "dot" }), "spotify"),
      h("span", { class: `svc-pill ${s.tidalConnected ? "on" : ""}` }, h("span", { class: "dot" }), "tidal"),
    ),
  );
}

// ── Bottom nav ─────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { screen: "ready",     label: "1·Ready" },
  { screen: "syncing",   label: "2·Sync" },
  { screen: "library",   label: "3·Library" },
  { screen: "exporting", label: "4·Export" },
  { screen: "results",   label: "5·Review" },
];

function renderNav(active, onPick) {
  return h("div", { class: "popup-nav" },
    ...NAV_ITEMS.map((item) =>
      h("button", {
        class: item.screen === active ? "active" : "",
        onclick: () => onPick(item.screen),
      }, item.label),
    ),
  );
}

// ── Bored bot (Ready screen) ───────────────────────────────────────────────

const BB_SVG = `
<svg class="bb-svg" viewBox="0 0 60 70" width="60" height="70" xmlns="http://www.w3.org/2000/svg">
  <line x1="30" y1="6" x2="30" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <circle class="bb-antenna" cx="30" cy="5" r="2" fill="currentColor"/>
  <rect x="14" y="14" width="32" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <g class="bb-eyes">
    <circle cx="22" cy="25" r="2" fill="currentColor"/>
    <circle cx="38" cy="25" r="2" fill="currentColor"/>
  </g>
  <line class="bb-mouth bb-mouth-flat" x1="24" y1="32" x2="36" y2="32" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <path class="bb-mouth bb-mouth-smile" d="M 23 31 Q 30 36 37 31" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="30" y1="36" x2="30" y2="39" stroke="currentColor" stroke-width="1.5"/>
  <rect x="18" y="39" width="24" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <line class="bb-arm bb-arm-l" x1="18" y1="44" x2="12" y2="52" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line class="bb-arm bb-arm-r" x1="42" y1="44" x2="48" y2="52" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line class="bb-leg bb-leg-l" x1="24" y1="57" x2="24" y2="66" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line class="bb-leg bb-leg-r" x1="36" y1="57" x2="36" y2="66" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

function createBoredBot() {
  const walker = h("div", {
    class: "bb-walker mode-idle idle-look",
    style: { transform: "translateX(0px)", transition: "transform 0ms linear, opacity 140ms ease" },
  },
    h("div", { class: "bb-bob" }, rawSvg(BB_SVG)),
    h("div", { class: "bb-zzz", "aria-hidden": "true" },
      h("span", null, "z"), h("span", null, "z"), h("span", null, "Z"),
    ),
  );

  const root = h("div", { class: "bored-bot", "aria-hidden": "true" },
    h("div", { class: "bb-floor" }),
    walker,
  );

  let xVal = 0;
  const sequence = [];
  let frameIdx = 0;
  let timer = null;
  let cancelled = false;

  const between = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clampX = (n) => Math.max(-110, Math.min(110, n));

  function planNext() {
    const r = Math.random();
    if (r < 0.45) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const dist = between(40, 110);
      const target = clampX(xVal + dir * dist);
      const speed = between(36, 50);
      const travel = Math.abs(target - xVal);
      const dur = Math.max(700, (travel / speed) * 1000);
      sequence.push({ mode: "walk", x: target, dur });
    } else if (r < 0.72) {
      const gesture = pick(["look", "shimmy", "stretch", "yawn"]);
      const smileChance = gesture === "shimmy" || gesture === "stretch" ? 0.55
                        : gesture === "look" ? 0.15
                        : 0;
      const smile = Math.random() < smileChance;
      sequence.push({ mode: "idle", idle: gesture, x: xVal, dur: between(1600, 2400), smile });
    } else if (r < 0.88) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const dist = between(8, 22);
      const target = clampX(xVal + dir * dist);
      const dur = Math.max(500, (dist / 38) * 1000);
      sequence.push({ mode: "walk", x: target, dur });
      sequence.push({ mode: "idle", idle: "look", x: target, dur: between(800, 1300) });
    } else {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const off = dir === 1 ? 220 : -220;
      const exitTravel = Math.abs(off - xVal);
      const exitDur = Math.max(2000, (exitTravel / 42) * 1000);
      sequence.push({ mode: "walk", x: off, dur: exitDur });
      sequence.push({ mode: "offscreen", x: off, dur: between(900, 1700) });
      const returnTo = between(-80, 80) * (Math.random() < 0.5 ? -1 : 1);
      const returnTravel = Math.abs(returnTo - off);
      const returnDur = Math.max(2000, (returnTravel / 42) * 1000);
      const happyReturn = Math.random() < 0.6;
      sequence.push({ mode: "walk", x: returnTo, dur: returnDur, smile: happyReturn });
      if (happyReturn) {
        sequence.push({ mode: "idle", idle: "look", x: returnTo, dur: between(1100, 1700), smile: true });
      }
    }
  }

  function applyPose(p) {
    walker.className = `bb-walker mode-${p.mode}${p.idle ? ` idle-${p.idle}` : ""}${p.smile ? " smiling" : ""}`;
    const transitionDur = p.mode === "walk" ? `${p.dur}ms` : "0ms";
    walker.style.transform = `translateX(${p.x}px)`;
    walker.style.transition = `transform ${transitionDur} linear, opacity 140ms ease`;
  }

  function tick() {
    if (cancelled) return;
    if (frameIdx >= sequence.length) {
      sequence.length = 0;
      frameIdx = 0;
      planNext();
    }
    const f = sequence[frameIdx++];
    xVal = f.x;
    applyPose(f);
    timer = setTimeout(tick, Math.max(60, f.dur));
  }

  timer = setTimeout(tick, 400);

  root.cleanup = () => {
    cancelled = true;
    clearTimeout(timer);
  };
  return root;
}

// ── Ready screen ───────────────────────────────────────────────────────────

function renderReady(s) {
  const checklist = h("div", { class: "checklist" });
  for (const c of CHECKS) {
    const done = c.isDone(s);
    const row = h("div", { class: `check ${done ? "done" : ""}` },
      h("span", { class: "dot" }),
      h("span", { class: "label" }, c.label),
      h("span", { class: "arr" }, `${c.short} →`),
    );
    if (!done) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `${c.label} — open`);
      const open = () => browser.tabs.create({ url: c.url });
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    }
    checklist.appendChild(row);
  }

  const bot = createBoredBot();
  const root = h("div", { class: "body" }, bot, checklist);
  root.cleanup = () => bot.cleanup?.();
  return root;
}

// ── Sync screen ────────────────────────────────────────────────────────────

const SYNC_VERBS = ["GET", "GET", "GET", "PUL", "RIP"];
const SYNC_NAMES = [
  "Black Star — Radiohead",
  "Pyramids — Frank Ocean",
  "Alright — Kendrick Lamar",
  "Tessellate — alt-J",
  "Get Lucky — Daft Punk",
  "Royals — Lorde",
  "Bad Guy — Billie Eilish",
  "Redbone — Childish Gambino",
  "Borderline — Tame Impala",
  "Levitating — Dua Lipa",
  "Skinny Love — Bon Iver",
  "Cosmic Dust — Floating Points",
  "Tokyo Drift — Teriyaki Boyz",
  "Hyperballad — Björk",
];

function syncCounts(s) {
  // While syncing, the background surfaces in-progress counts via liveStats /
  // livePlaylists; once done, libraryStats / libraryPlaylists take over.
  const playlists = (s.syncing && s.livePlaylists) ? s.livePlaylists : (s.libraryPlaylists || []);
  const stats = (s.syncing && s.liveStats) ? s.liveStats : s.libraryStats;
  return {
    trackCount: playlists.reduce((sum, p) => sum + (p.trackCount || 0), 0),
    playlistCount: playlists.length,
    artistCount: stats?.artists || 0,
  };
}

function renderSync(s) {
  // Live counts come straight from the latest GET_STATUS (refreshed via the
  // SYNC_STATUS / CAPTURE_UPDATE broadcasts from the background).
  const { trackCount, playlistCount, artistCount } = syncCounts(s);
  const isDone = !s.syncing && s.hasLibrary && playlistCount > 0;

  const stream = h("div", { class: "exfil-stream" });
  const scan = h("div", { class: "exfil-scan" });
  const cursor = h("div", { class: "exfil-row exfil-cursor" },
    h("span", { class: "exfil-off" }, "····"),
    h("span", { class: "exfil-verb" }, "···"),
    h("span", { class: "exfil-text" }, h("span", { class: "caret" }, "▌")),
  );

  if (!isDone) {
    stream.appendChild(scan);
    stream.appendChild(cursor);
  }

  const recBadge = h("span", { class: `exfil-rec ${isDone ? "is-done" : ""}` }, isDone ? "STOPPED" : "REC");
  const restartBtn = h("button", {
    class: "exfil-restart",
    title: "Restart sync",
    onclick: async () => {
      restartBtn.disabled = true;
      try { await browser.runtime.sendMessage({ action: "SYNC_NOW" }); }
      finally { restartBtn.disabled = false; refreshStatus(); }
    },
  });
  restartBtn.appendChild(rawSvg(`
<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M3 12a9 9 0 1 0 3-6.7"/>
  <path d="M3 4v5h5"/>
</svg>`));

  const panel = h("div", { class: `exfil-panel ${isDone ? "is-done" : ""}` },
    h("div", { class: "exfil-hdr" },
      h("span", { class: "exfil-dot" }),
      h("span", { class: "exfil-host" }, "spotify.local"),
      h("span", { class: "exfil-arrow" }, "→"),
      h("span", { class: "exfil-host" }, "storage.local"),
      h("span", { class: "exfil-spacer" }),
      recBadge,
      restartBtn,
    ),
    stream,
  );

  // Streaming exfil log. Decorative — same shape as the prototype.
  let i = 0;
  let timer = null;
  function pushLine() {
    if (isDone) return;
    const offset = (0x4f00 + i * 0x18).toString(16).padStart(4, "0");
    const verb = SYNC_VERBS[Math.floor(Math.random() * SYNC_VERBS.length)];
    const name = SYNC_NAMES[Math.floor(Math.random() * SYNC_NAMES.length)];
    const cut = Math.floor(name.length * (0.55 + Math.random() * 0.4));
    const masked = name.slice(0, cut) + "·".repeat(Math.max(0, name.length - cut));
    i++;

    const row = h("div", { class: "exfil-row" },
      h("span", { class: "exfil-off" }, offset),
      h("span", { class: "exfil-verb" }, verb),
      h("span", { class: "exfil-text" }, masked),
    );
    // Insert before the trailing cursor so it stays at the bottom.
    if (cursor.parentNode === stream) stream.insertBefore(row, cursor);
    else stream.appendChild(row);
    // Keep at most 12 streaming rows (excluding the cursor).
    const maxRows = 12;
    const rows = stream.querySelectorAll(".exfil-row:not(.exfil-cursor)");
    if (rows.length > maxRows) {
      for (let k = 0; k < rows.length - maxRows; k++) rows[k].remove();
    }
  }
  if (!isDone) timer = setInterval(pushLine, 180);

  const trackNum = h("div", { class: "num" }, trackCount.toLocaleString());
  const playlistNum = h("div", { class: "num" }, playlistCount.toLocaleString());
  const artistNum = h("div", { class: "num" }, artistCount.toLocaleString());

  const counters = h("div", { class: "sync-counters" },
    h("div", { class: "sync-counter" }, trackNum, h("div", { class: "lab" }, "Tracks")),
    h("div", { class: "sync-counter" }, playlistNum, h("div", { class: "lab" }, "Playlists")),
    h("div", { class: "sync-counter" }, artistNum, h("div", { class: "lab" }, "Artists")),
  );

  const root = h("div", { class: "sync-block" }, panel, counters);

  // Background only broadcasts SYNC_STATUS at playlist boundaries; long
  // playlists can take many seconds to fetch. Poll while we're on this screen
  // so the counters move in something close to real time.
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { refreshStatus(); }, 700);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  if (s.syncing) startPolling();

  // Counters update in-place so the streaming animation isn't reset whenever
  // a new GET_STATUS arrives. The slider calls this whenever the screen's
  // fingerprint changes but the screen name stays "syncing".
  root.update = (next) => {
    const c = syncCounts(next);
    trackNum.textContent = c.trackCount.toLocaleString();
    playlistNum.textContent = c.playlistCount.toLocaleString();
    artistNum.textContent = c.artistCount.toLocaleString();
    if (next.syncing) startPolling(); else stopPolling();
    const wasDone = !next.syncing && next.hasLibrary && c.playlistCount > 0;
    recBadge.textContent = wasDone ? "STOPPED" : "REC";
    recBadge.classList.toggle("is-done", wasDone);
    panel.classList.toggle("is-done", wasDone);
    if (wasDone && timer) { clearInterval(timer); timer = null; }
    if (wasDone && stream.contains(scan)) stream.removeChild(scan);
    if (wasDone && stream.contains(cursor)) stream.removeChild(cursor);
  };

  root.cleanup = () => {
    if (timer) clearInterval(timer);
    if (pollTimer) clearInterval(pollTimer);
  };
  return root;
}

// ── Library screen ─────────────────────────────────────────────────────────

const selectedPlaylists = new Set();
let selectionInitialisedFor = null;
let exportAlbums = true;
let exportArtists = true;

function ensureSelectionDefault(s) {
  // Default to all-selected the first time we see this library snapshot.
  const key = (s.libraryPlaylists || []).map((p) => p.spotifyId).join("|");
  if (selectionInitialisedFor !== key) {
    selectedPlaylists.clear();
    for (const p of s.libraryPlaylists || []) selectedPlaylists.add(p.spotifyId);
    selectionInitialisedFor = key;
  }
}

function renderLibrary(s) {
  ensureSelectionDefault(s);

  const playlists = s.libraryPlaylists || [];
  const albumCount = s.libraryStats?.albums || 0;
  const artistCount = s.libraryStats?.artists || 0;

  const list = h("div", { class: "pl-list" });

  const refreshList = () => {
    clear(list);
    for (const p of playlists) {
      const on = selectedPlaylists.has(p.spotifyId);
      const item = h("div", { class: `pl-item ${on ? "on" : ""}` },
        h("span", { class: "tdot" }),
        h("div", { class: "pl-info" },
          h("div", { class: "pl-name" }, p.name),
          h("div", { class: "pl-meta" }, `${(p.trackCount || 0).toLocaleString()} tracks`),
        ),
        h("span", { class: `pl-badge ${p.isLikedSongs ? "fav" : ""}` }, p.isLikedSongs ? "Favorites" : "Playlist"),
      );
      item.addEventListener("click", () => {
        if (selectedPlaylists.has(p.spotifyId)) selectedPlaylists.delete(p.spotifyId);
        else selectedPlaylists.add(p.spotifyId);
        refreshHeadCount();
        refreshList();
      });
      list.appendChild(item);
    }
  };

  const headCount = h("span", { class: "sec-count" });
  const refreshHeadCount = () => {
    headCount.textContent = `${selectedPlaylists.size} of ${playlists.length}`;
  };

  const exportJsonBtn = h("button", { class: "icon-btn", title: "Export JSON", onclick: exportJson });
  exportJsonBtn.appendChild(rawSvg(`
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>
</svg>`));

  const clearBtn = h("button", { class: "icon-btn icon-btn-danger", title: "Clear library", onclick: clearLibrary });
  clearBtn.appendChild(rawSvg(`
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
</svg>`));

  const sectionHead = h("div", { class: "section-head" },
    h("span", { class: "label" }, "Select playlists"),
    h("span", { class: "actions" },
      headCount,
      h("a", { onclick: (e) => { e.preventDefault(); for (const p of playlists) selectedPlaylists.add(p.spotifyId); refreshHeadCount(); refreshList(); } }, "All"),
      h("a", { onclick: (e) => { e.preventDefault(); selectedPlaylists.clear(); refreshHeadCount(); refreshList(); } }, "None"),
      h("span", { class: "lib-icon-actions" }, exportJsonBtn, clearBtn),
    ),
  );

  refreshHeadCount();
  refreshList();

  const albumsRow = h("div", { class: `toggle-row ${exportAlbums ? "on" : ""}` },
    h("span", { class: "tswitch" }),
    h("span", null, "Save albums"),
    h("span", { class: "ct" }, albumCount > 0 ? String(albumCount) : ""),
  );
  albumsRow.addEventListener("click", () => {
    exportAlbums = !exportAlbums;
    albumsRow.classList.toggle("on", exportAlbums);
  });

  const artistsRow = h("div", { class: `toggle-row ${exportArtists ? "on" : ""}` },
    h("span", { class: "tswitch" }),
    h("span", null, "Follow artists"),
    h("span", { class: "ct" }, artistCount > 0 ? String(artistCount) : ""),
  );
  artistsRow.addEventListener("click", () => {
    exportArtists = !exportArtists;
    artistsRow.classList.toggle("on", exportArtists);
  });

  const txBtn = h("button", { class: "tx-btn", "aria-label": "Export to Tidal", onclick: startExport });
  txBtn.appendChild(h("span", { class: "tx-icon", "aria-hidden": "true" },
    rawSvg(`<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" xmlns="http://www.w3.org/2000/svg"><path d="M8 5.5v13c0 .8.9 1.3 1.6.9l11-6.5c.6-.4.6-1.3 0-1.7l-11-6.5C8.9 4.2 8 4.7 8 5.5z"/></svg>`),
  ));
  txBtn.appendChild(h("span", { class: "tx-scan", "aria-hidden": "true" }));

  // Wrapper holds the button + custom tooltip. The tooltip can't sit inside
  // .tx-btn because that element has overflow:hidden for the scan animation.
  const txWrap = h("div", { class: "tx-wrap" },
    txBtn,
    h("span", { class: "tx-tip", role: "tooltip" }, "Export to Tidal"),
  );

  return h("div", { class: "body" },
    h("div", { class: "section" },
      sectionHead,
      list,
      h("div", { class: "extras-row" },
        h("div", { class: "extras-toggles" }, albumsRow, artistsRow),
        txWrap,
      ),
    ),
  );
}

// ── Exporting screen ───────────────────────────────────────────────────────

function renderExporting(s) {
  const summary = h("span", { class: "summary mono" });
  const fill = h("div", { class: "progress-fill", style: { width: "0%" } });
  const pctEl = h("span", null, "0%");
  const phaseLabel = h("span", null, "matching");
  const log = h("div", { class: "activity-log" });

  const root = h("div", { class: "body" },
    h("div", { class: "row-between" },
      h("div", { class: "eyebrow" }, "Exporting"),
      summary,
    ),
    h("div", { class: "progress" },
      h("div", { class: "progress-bar" }, fill),
      h("div", { class: "progress-text" }, phaseLabel, pctEl),
      log,
    ),
  );

  function handleProgress(msg) {
    const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    pctEl.textContent = `${pct}%`;
    if (msg.phase) phaseLabel.textContent = msg.phase;
    summary.textContent = `${(msg.current || 0).toLocaleString()} / ${(msg.total || 0).toLocaleString()}`;
    if (msg.name) {
      // Optimistically prepend an "ok" line for visual flow; the background
      // also broadcasts LOG entries with summary stats.
      const line = h("div", { class: "log-line ok" },
        h("span", { class: "icn" }, "✓"),
        h("span", null, msg.name),
      );
      log.appendChild(line);
      while (log.children.length > 12) log.removeChild(log.firstChild);
    }
  }
  function handleLog(text) {
    const failish = /unmatched|fail|error|failed/i.test(text);
    const line = h("div", { class: `log-line ${failish ? "fail" : "ok"}` },
      h("span", { class: "icn" }, failish ? "✗" : "✓"),
      h("span", null, text),
    );
    log.appendChild(line);
    while (log.children.length > 12) log.removeChild(log.firstChild);
  }

  root.handlers = { progress: handleProgress, log: handleLog };
  return root;
}

// ── Results screen ─────────────────────────────────────────────────────────

// Persisted across popup open/close so the user can re-open the popup
// and pick up where they left off in the review list. Keyed by group name,
// so renames or new playlists fall back to the default (expanded).
const REVIEW_STATE_KEY = "munchy:reviewState";

function loadReviewState() {
  try {
    const raw = localStorage.getItem(REVIEW_STATE_KEY);
    if (!raw) return { collapsed: [], scroll: 0 };
    const p = JSON.parse(raw) || {};
    return {
      collapsed: Array.isArray(p.collapsed) ? p.collapsed : [],
      scroll: typeof p.scroll === "number" ? p.scroll : 0,
    };
  } catch {
    return { collapsed: [], scroll: 0 };
  }
}

function saveReviewState(patch) {
  try {
    localStorage.setItem(REVIEW_STATE_KEY, JSON.stringify({
      ...loadReviewState(),
      ...patch,
    }));
  } catch {}
}

function reasonClass(r) {
  if (!r) return "weak";
  const text = String(r);
  if (/no match|not on tidal/i.test(text)) return "miss";
  if (/region/i.test(text)) return "region";
  return "weak";
}

function renderResults(s) {
  const matched = s.exportState?.tidalMatched || [];
  const failed = s.exportState?.tidalFailed || [];
  const dupes = s.exportState?.tidalDuplicates || [];
  const matchedCt = matched.length;
  const failedCt = failed.length;
  const dupCt = dupes.length;
  const total = matchedCt + failedCt + dupCt || 1;

  const okBar = h("span", { class: "ok", style: { width: `${(matchedCt / total) * 100}%` } });
  const dupBar = h("span", { class: "dup", style: { width: `${(dupCt / total) * 100}%` } });
  const failBar = h("span", { class: "fail", style: { width: `${(failedCt / total) * 100}%` } });

  const groupsMap = new Map();
  for (const u of failed) {
    const key = u.playlist || "Liked Songs";
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(u);
  }
  // Duplicates surface in the same review list so the user can manually
  // investigate (the second Spotify row may be a distinct recording the
  // matcher collapsed onto the first). Tagged separately for color; the
  // "duplicate of" detail goes on the tooltip rather than the pill text.
  for (const u of dupes) {
    const key = u.playlist || "Liked Songs";
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    const dup = u.duplicateOf;
    const dupTitle = dup
      ? `Duplicate of "${dup.name}"${(dup.artists || []).length ? ` — ${(dup.artists || []).join(", ")}` : ""}`
      : "Duplicate";
    groupsMap.get(key).push({
      ...u,
      reason: "Duplicate",
      _isDup: true,
      _dupTitle: dupTitle,
    });
  }
  const groups = [...groupsMap.entries()].map(([name, tracks]) => ({ name, tracks }));
  const persisted = loadReviewState();
  const collapsedNames = new Set(persisted.collapsed);
  const open = new Set(groups.map((g) => g.name).filter((n) => !collapsedNames.has(n)));

  const persistCollapsed = () => {
    const collapsed = groups.map((g) => g.name).filter((n) => !open.has(n));
    saveReviewState({ collapsed });
  };

  const reviewList = h("div", { class: "review-list" });

  // Debounced scroll persistence — saves at most every 150 ms while scrolling.
  let scrollTimer = null;
  reviewList.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      saveReviewState({ scroll: reviewList.scrollTop });
    }, 150);
  });

  function renderGroups() {
    clear(reviewList);
    for (const g of groups) {
      const isOpen = open.has(g.name);
      const chev = h("span", { class: `um-chev ${isOpen ? "open" : ""}` });
      chev.appendChild(rawSvg(`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="m9 18 6-6-6-6"/></svg>`));

      const hdrBtn = h("button", {
        class: "um-group-hdr",
        "aria-expanded": isOpen ? "true" : "false",
        onclick: () => {
          if (open.has(g.name)) open.delete(g.name); else open.add(g.name);
          persistCollapsed();
          renderGroups();
        },
      },
        chev,
        h("span", { class: "um-group-name" }, g.name),
        h("span", { class: "um-group-count" }, String(g.tracks.length)),
      );

      const groupEl = h("div", { class: "um-group" }, hdrBtn);
      if (isOpen) {
        const body = h("div", { class: "um-group-body" });
        for (const u of g.tracks) {
          const item = h("a", {
            class: "um-item",
            href: "#",
            onclick: (e) => { e.preventDefault(); openTidalSearch(u); },
          },
            h("div", { class: "um-meta" },
              h("div", { class: "um-name" }, u.name),
              h("div", { class: "um-artist" }, (u.artists || []).join(", ")),
            ),
            h("div", { class: "um-tail" },
              h("span", {
                class: `um-tag ${u._isDup ? "tag-dup" : `tag-${reasonClass(u.reason)}`}`,
              },
                u.reason || "Unmatched",
                u._isDup && h("span", { class: "um-tag-tip" }, u._dupTitle),
              ),
              (() => {
                const span = h("span", { class: "um-go", title: "Search on Tidal" });
                span.appendChild(rawSvg(`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>`));
                return span;
              })(),
            ),
          );
          body.appendChild(item);
        }
        groupEl.appendChild(body);
      }
      reviewList.appendChild(groupEl);
    }
  }
  renderGroups();

  // Restore scroll once the reviewList is attached to the DOM (the slider
  // mounts the body after renderResults returns). rAF fires after layout.
  requestAnimationFrame(() => {
    if (reviewList.isConnected) reviewList.scrollTop = persisted.scroll || 0;
  });

  return h("div", { class: "body" },
    h("div", { class: "result-summary" },
      h("div", { class: "stats" },
        h("div", { class: "stat ok" },
          h("div", { class: "n" }, matchedCt.toLocaleString()),
          h("div", { class: "l" }, "Matched"),
        ),
        dupCt > 0 && h("div", { class: "stat dup" },
          h("div", { class: "n" }, dupCt.toLocaleString()),
          h("div", { class: "l" }, "Duplicates"),
        ),
        h("div", { class: "stat fail" },
          h("div", { class: "n" }, failedCt.toLocaleString()),
          h("div", { class: "l" }, "Unmatched"),
        ),
      ),
      h("div", { class: "result-bar" }, okBar, dupBar, failBar),
    ),
    (failedCt + dupCt) > 0 && h("div", { class: "review-hdr" },
      h("span", { class: "label" }, "Review unmatched"),
      h("span", { class: "hint" }, "Tap a track to search it on Tidal"),
    ),
    (failedCt + dupCt) > 0 && reviewList,
  );
}

// ── Screen slider ──────────────────────────────────────────────────────────

const SCREEN_ORDER = ["ready", "syncing", "library", "exporting", "results"];

// Per-screen fingerprint so we only rebuild a layer when the data it draws
// from has actually changed. The exporting screen returns a constant so its
// in-flight activity log isn't wiped on every status refresh.
function screenFingerprint(name, s) {
  if (name === "ready") {
    return CHECKS.map((c) => (c.isDone(s) ? "1" : "0")).join("");
  }
  if (name === "syncing") {
    const pls = (s.syncing && s.livePlaylists) ? s.livePlaylists : (s.libraryPlaylists || []);
    const stats = (s.syncing && s.liveStats) ? s.liveStats : s.libraryStats;
    const tracks = pls.reduce((sum, p) => sum + (p.trackCount || 0), 0);
    const playlists = pls.length;
    const artists = stats?.artists || 0;
    return `${s.syncing ? 1 : 0}|${tracks}|${playlists}|${artists}|${s.hasLibrary ? 1 : 0}`;
  }
  if (name === "library") {
    const ids = (s.libraryPlaylists || []).map((p) => `${p.spotifyId}:${p.trackCount}`).join(",");
    return `${s.libraryStats?.albums || 0}|${s.libraryStats?.artists || 0}|${ids}`;
  }
  if (name === "exporting") return "static";
  if (name === "results") {
    const m = s.exportState?.tidalMatched?.length || 0;
    const f = s.exportState?.tidalFailed?.length || 0;
    return `${m}|${f}|${s.exportState?.completedAt || ""}`;
  }
  return "";
}

function createScreenSlider(initialScreen, latestStatus) {
  const slider = h("div", { class: "screen-slider" });
  let current = initialScreen;
  let currentFp = screenFingerprint(initialScreen, latestStatus());
  let currentLayer = null;
  let firstPaint = true;
  let resizeObserver = null;
  let heightAnim = null;

  const HEIGHT_DURATION_MS = 280;
  // Cubic-bezier(0.22, 0.61, 0.36, 1) — easeOutCubic-ish; matches the prior CSS.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function buildScreen(name, status) {
    if (name === "ready")     return renderReady(status);
    if (name === "syncing")   return renderSync(status);
    if (name === "library")   return renderLibrary(status);
    if (name === "exporting") return renderExporting(status);
    if (name === "results")   return renderResults(status);
    return h("div");
  }

  function watchHeight(layer) {
    if (resizeObserver) resizeObserver.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(() => animateHeight(layer));
    resizeObserver.observe(layer);
  }

  function cancelHeightAnim() {
    if (heightAnim) {
      cancelAnimationFrame(heightAnim.raf);
      heightAnim = null;
    }
  }

  // JS-driven height animation. Drives slider.style.height per frame so
  // Firefox's popup window resize tracks the visual transition, instead of
  // snapping to the final height while the CSS transition is still
  // interpolating (which made the bottom nav arrive ahead of the slider).
  function animateHeight(layer) {
    const target = layer.offsetHeight;
    if (firstPaint) {
      slider.style.height = target + "px";
      firstPaint = false;
      return;
    }
    const cur = slider.getBoundingClientRect().height;
    if (Math.abs(cur - target) < 0.5) {
      cancelHeightAnim();
      slider.style.height = target + "px";
      return;
    }
    cancelHeightAnim();
    const start = performance.now();
    const from = cur;
    heightAnim = { raf: 0 };
    const step = (now) => {
      const t = Math.min(1, (now - start) / HEIGHT_DURATION_MS);
      const eased = easeOutCubic(t);
      slider.style.height = (from + (target - from) * eased) + "px";
      if (t < 1) {
        heightAnim.raf = requestAnimationFrame(step);
      } else {
        slider.style.height = target + "px";
        heightAnim = null;
      }
    };
    heightAnim.raf = requestAnimationFrame(step);
  }

  function cleanupLayer(layer) {
    const inner = layer.firstChild;
    if (inner && typeof inner.cleanup === "function") {
      try { inner.cleanup(); } catch {}
    }
  }

  function setScreen(name) {
    const status = latestStatus();
    const fp = screenFingerprint(name, status);

    if (name === current) {
      if (fp === currentFp) return; // nothing to redraw
      // Prefer in-place updates so transient animations (streaming exfil log,
      // walking dots, etc.) aren't reset every time a counter ticks.
      const inner = currentLayer?.firstChild;
      if (inner && typeof inner.update === "function") {
        inner.update(status);
        currentFp = fp;
        animateHeight(currentLayer);
        return;
      }
      const layer = h("div", { class: "screen-layer in" }, buildScreen(name, status));
      if (currentLayer) cleanupLayer(currentLayer);
      clear(slider);
      slider.appendChild(layer);
      currentLayer = layer;
      currentFp = fp;
      animateHeight(layer);
      watchHeight(layer);
      return;
    }

    const dir = SCREEN_ORDER.indexOf(name) >= SCREEN_ORDER.indexOf(current) ? "fwd" : "back";
    const newLayer = h("div", { class: `screen-layer in in-${dir}` }, buildScreen(name, status));
    const old = currentLayer;
    slider.appendChild(newLayer);
    if (old) {
      old.classList.remove("in", "in-fwd", "in-back");
      old.classList.add("out", `out-${dir}`);
      cleanupLayer(old);
      setTimeout(() => { if (old.parentNode === slider) slider.removeChild(old); }, 320);
    }
    current = name;
    currentFp = fp;
    currentLayer = newLayer;
    animateHeight(newLayer);
    watchHeight(newLayer);
  }

  function getCurrentScreenInner() {
    return currentLayer?.firstChild;
  }

  // Initial render.
  const firstLayer = h("div", { class: "screen-layer in" }, buildScreen(initialScreen, latestStatus()));
  slider.appendChild(firstLayer);
  currentLayer = firstLayer;
  animateHeight(firstLayer);
  watchHeight(firstLayer);

  return { el: slider, setScreen, getCurrentScreenInner };
}

// ── App state + wiring ─────────────────────────────────────────────────────

let lastStatus = {
  spotifyConnected: false,
  tidalConnected: false,
  hasLibrary: false,
  libraryPlaylists: [],
  libraryStats: null,
  exportState: null,
  exporting: false,
  syncing: false,
  syncStatus: "",
  missingTemplates: ["libraryV3", "fetchLibraryTracks", "fetchPlaylistContents"],
};

let headerEl = null;
let navEl = null;
let slider = null;
// User-selected screen override. Null means follow the auto-derived screen.
// Cleared by significant transitions (export start/end) so the popup can
// resume reflecting real state once an active workflow finishes.
let userScreen = null;
let prevDerivedScreen = null;

function rebuildHeader() {
  const next = renderHeader(lastStatus);
  if (headerEl?.parentNode) headerEl.parentNode.replaceChild(next, headerEl);
  headerEl = next;
}

function rebuildNav(active) {
  const next = renderNav(active, pickScreen);
  if (navEl?.parentNode) navEl.parentNode.replaceChild(next, navEl);
  navEl = next;
}

function pickScreen(name) {
  userScreen = name;
  if (slider) slider.setScreen(name);
  rebuildNav(name);
}

async function refreshStatus() {
  try {
    const s = await browser.runtime.sendMessage({ action: "GET_STATUS" });
    if (s) {
      lastStatus = s;
      const derived = deriveScreen(s);
      // Auto-transitions clear any manual override so the popup follows the
      // real workflow when the user kicks off an export from the library, or
      // an export naturally completes.
      if (prevDerivedScreen && derived !== prevDerivedScreen &&
          (derived === "exporting" || derived === "results")) {
        userScreen = null;
      }
      prevDerivedScreen = derived;
      const target = userScreen ?? derived;
      rebuildHeader();
      if (slider) slider.setScreen(target);
      rebuildNav(target);
    }
  } catch (e) {
    console.warn("[popup] refreshStatus failed:", e?.message || e);
  }
}

async function startExport() {
  // Optimistic UI: switch to the exporting screen immediately so the progress
  // panel is mounted before the first EXPORT_PROGRESS broadcast arrives.
  lastStatus = { ...lastStatus, exporting: true };
  userScreen = null;
  rebuildHeader();
  slider.setScreen("exporting");
  rebuildNav("exporting");

  const options = {
    selectedPlaylists: [...selectedPlaylists],
    albums: exportAlbums,
    artists: exportArtists,
  };

  try {
    const result = await browser.runtime.sendMessage({ action: "EXPORT_TIDAL", options });
    if (result?.error) {
      const inner = slider.getCurrentScreenInner();
      inner?.handlers?.log?.(`Error: ${result.error}`);
    }
  } catch (e) {
    console.warn("[popup] export failed:", e?.message || e);
  } finally {
    refreshStatus();
  }
}

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

async function clearLibrary() {
  await browser.runtime.sendMessage({ action: "CLEAR_LIBRARY" });
  selectionInitialisedFor = null;
  selectedPlaylists.clear();
  refreshStatus();
}

function openTidalSearch(track) {
  const query = `${track.name} ${(track.artists || []).join(" ")}`.trim();
  browser.tabs.create({ url: `https://listen.tidal.com/search?q=${encodeURIComponent(query)}` });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const root = document.getElementById("root");
  headerEl = renderHeader(lastStatus);
  root.appendChild(headerEl);

  const initial = deriveScreen(lastStatus);
  prevDerivedScreen = initial;
  slider = createScreenSlider(initial, () => lastStatus);
  root.appendChild(slider.el);

  navEl = renderNav(initial, pickScreen);
  root.appendChild(navEl);

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.action === "EXPORT_PROGRESS") {
      const inner = slider.getCurrentScreenInner();
      inner?.handlers?.progress?.(msg);
      return;
    }
    if (msg.action === "LOG") {
      const inner = slider.getCurrentScreenInner();
      inner?.handlers?.log?.(msg.text);
      return;
    }
    if (msg.action === "CAPTURE_UPDATE" || msg.action === "SYNC_DONE" || msg.action === "SYNC_STATUS") {
      refreshStatus();
    }
  });

  await refreshStatus();
});
