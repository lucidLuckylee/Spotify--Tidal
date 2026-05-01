// Content script for open.spotify.com
// Injects a fetch interceptor to capture Spotify's internal API responses

(function () {
  // Inject a script into the page context to intercept fetch calls
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        try {
          const url = typeof args[0] === "string" ? args[0] : (args[0] ? args[0].url : "");
          const isSpotify = url && (url.includes("spotify.com") || url.includes("spotify.co") || url.includes("scdn.co"));
          const isAPI = isSpotify && !url.match(/\\\\.(js|css|woff2?|png|jpe?g|svg|ico|json)([?#]|$)/i);
          if (isAPI) {
            const clone = response.clone();
            clone.text().then(body => {
              window.postMessage({ type: "__MUNCHY_FETCH__", url, status: response.status, body }, "*");
            }).catch(() => {});
          }
        } catch {}
        return response;
      };
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();

  // Listen for intercepted fetch data from the page context
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "__MUNCHY_FETCH__") {
      browser.runtime.sendMessage({
        action: "SPOTIFY_FETCH_INTERCEPTED",
        url: event.data.url,
        status: event.data.status,
        body: event.data.body,
      }).catch(() => {});
    }
  });

  // ── Auto-scroll to capture all items ────────────────────────────────────────

  let scrolling = false;
  let scrollAbort = false;
  const scrapedTracks = {};

  const IGNORE_PATHS = ["/collection/episodes", "/collection/podcasts"];

  function isIgnoredPage() {
    return IGNORE_PATHS.some((p) => window.location.pathname.startsWith(p));
  }

  function autoScroll() {
    if (isIgnoredPage()) return;
    if (scrolling) {
      scrollAbort = true;
      return;
    }
    scrolling = true;
    scrollAbort = false;

    // Clear tracks from previous playlist
    for (const key of Object.keys(scrapedTracks)) delete scrapedTracks[key];

    const scroller = findMainScroller();
    let expectedCount = 0;
    let lastSentCount = 0;
    let passes = 0;
    const MAX_PASSES = 10;

    waitForExpectedCount(() => {
      startPass();
    });

    function waitForExpectedCount(callback) {
      const start = Date.now();
      const POLL = 200;
      const TIMEOUT = 10000;

      function check() {
        expectedCount = getExpectedTrackCount();
        if (expectedCount > 0) {
          console.log(`[Munchy] Expected track count: ${expectedCount}`);
          callback();
          return;
        }
        if (Date.now() - start >= TIMEOUT) {
          console.log(`[Munchy] Could not read expected track count, proceeding without`);
          callback();
          return;
        }
        setTimeout(check, POLL);
      }
      check();
    }

    function startPass() {
      passes++;
      scroller.scrollTop = 0;
      // Re-read expected count each pass in case it wasn't available before
      expectedCount = getExpectedTrackCount() || expectedCount;
      console.log(`[Munchy] Pass ${passes}: expectedCount=${expectedCount}, scraped=${Object.keys(scrapedTracks).length}`);
      setTimeout(step, 300);
    }

    function step() {
      if (scrollAbort) { finish(); return; }

      // 1. Scrape what's visible
      scrapeVisibleTracks();
      const count = Object.keys(scrapedTracks).length;

      // Send incremental updates every 500 tracks
      if (count - lastSentCount >= 500) {
        sendScrapedTracks();
        lastSentCount = count;
      }

      // Check if we have everything
      if (expectedCount > 0 && count >= expectedCount) {
        finish();
        return;
      }

      // 2. Scroll down
      const scrollStep = getScrollStep(scroller);
      const prevTop = scroller.scrollTop;
      scroller.scrollTop += scrollStep;

      // 3. If scroll didn't move (bottom) or "Recommended" is visible — end of real content
      const atEnd = scroller.scrollTop === prevTop || isRecommendedVisible();
      if (atEnd) {
        scrapeVisibleTracks();
        const finalCount = Object.keys(scrapedTracks).length;

        if (expectedCount > 0 && finalCount < expectedCount && passes < MAX_PASSES) {
          startPass();
        } else {
          finish();
        }
        return;
      }

      // 4. Wait for new songs to appear before scrolling again
      const countBefore = count;
      waitForNewContent(countBefore, () => {
        step();
      });
    }

    function waitForNewContent(prevCount, callback) {
      const start = Date.now();
      const POLL = 50;
      const TIMEOUT = 1500;

      function check() {
        if (scrollAbort) { callback(); return; }

        scrapeVisibleTracks();
        if (Object.keys(scrapedTracks).length > prevCount) {
          // Got new songs — continue immediately
          callback();
          return;
        }
        if (Date.now() - start >= TIMEOUT) {
          // Nothing new after timeout — scroll anyway
          callback();
          return;
        }
        setTimeout(check, POLL);
      }
      check();
    }

    function finish() {
      scrolling = false;
      sendScrapedTracks();
      const scrapedCount = Object.keys(scrapedTracks).length;
      // Final re-read in case it wasn't available earlier
      expectedCount = getExpectedTrackCount() || expectedCount;
      browser.runtime.sendMessage({
        action: "SCROLL_DONE",
        scrapedCount,
        expectedCount,
      }).catch(() => {});
    }
  }

  function getRecommendedBoundary() {
    const headings = document.querySelectorAll('h2, h3, [data-testid="playlist-recommendations-header"], section[data-testid] > div > span');
    for (const el of headings) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text.startsWith("recommended") || text.startsWith("empfohlen")) {
        return el;
      }
    }
    return null;
  }

  function isRecommendedVisible() {
    const el = getRecommendedBoundary();
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight;
  }

  function findMainScroller() {
    const allViewports = [...document.querySelectorAll('[data-overlayscrollbars-viewport]')];
    if (allViewports.length > 0) {
      allViewports.sort((a, b) => b.clientWidth - a.clientWidth);
      return allViewports[0];
    }
    const main = document.querySelector('main');
    return (main && main.scrollHeight > main.clientHeight) ? main : (document.scrollingElement || document.documentElement);
  }

  // ── Optimal scroll distance calculation ─────────────────────────────────────

  function getScrollStep(scroller) {
    // Find a visible track row and measure its height
    const row = document.querySelector(
      '[data-testid="tracklist-row"], [role="row"]'
    );
    if (row) {
      const rowHeight = row.getBoundingClientRect().height;
      if (rowHeight > 0) {
        const viewportHeight = scroller.clientHeight;
        // Scroll almost a full viewport, minus one row for overlap so we don't skip any
        const rows = Math.floor(viewportHeight / rowHeight);
        return Math.max(rows - 1, 1) * rowHeight;
      }
    }
    // Fallback: generous default
    return 1500;
  }

  // ── Expected track count from page header ─────────────────────────────────

  function getExpectedTrackCount() {
    // Spotify shows "X songs" / "X liked songs" / "X Titel" etc.
    // Allow optional words between number and the keyword (e.g. "1,636 liked songs")
    const pattern = /([\d,\.]+)\s+(?:\w+\s+)?(songs?|tracks?|titel|titres?|canciones?|brani|liedjes)/i;

    // Only match on short text to avoid false positives from long descriptions
    function matchShortText(el) {
      const text = (el.textContent || "").trim();
      // Track count text is always short (e.g. "1,636 songs", "42 liked songs")
      if (text.length > 60) return null;
      const m = text.match(pattern);
      if (m) return parseInt(m[1].replace(/[,\.]/g, ""), 10);
      return null;
    }

    // Try focused selectors first, then broader ones
    const selectors = [
      '[data-testid="track-count"]',
      '[data-testid="playlist-page"] span',
      '[data-testid="playlist-page"] p',
      '[data-testid="entityTitle"] + span',
      '[data-testid="action-bar-row"] span',
      'section header span',
      'section header p',
      'main [class*="Header"] span',
      'main [class*="header"] span',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const count = matchShortText(el);
        if (count) return count;
      }
    }

    // Broadest fallback — scan leaf spans/p in main but only above the tracklist
    const main = document.querySelector('main');
    if (main) {
      const els = main.querySelectorAll('span, p');
      for (const el of els) {
        if (el.closest('[data-testid="tracklist-row"], [role="row"]')) break;
        // Skip elements that have child elements (we want leaf nodes only)
        if (el.querySelector('span, p, a, div')) continue;
        const count = matchShortText(el);
        if (count) return count;
      }
    }

    return 0;
  }

  // ── DOM scraping for track data ───────────────────────────────────────────

  function scrapeVisibleTracks() {
    const recommendedBoundary = getRecommendedBoundary();

    const rows = document.querySelectorAll(
      '[data-testid="tracklist-row"], [role="row"], [role="gridcell"]'
    );

    for (const row of rows) {
      // Skip rows that come after the "Recommended" section
      // If boundary precedes the row in document order, skip this row
      if (recommendedBoundary && (recommendedBoundary.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue;
      }

      const trackLink = row.querySelector('a[href*="/track/"]');
      if (!trackLink) continue;

      const href = trackLink.getAttribute("href") || "";
      const trackIdMatch = href.match(/\/track\/([a-zA-Z0-9]+)/);
      if (!trackIdMatch) continue;
      const trackId = trackIdMatch[1];

      if (scrapedTracks[trackId]) continue;

      const name = trackLink.textContent?.trim() || "";
      const artistLinks = row.querySelectorAll('a[href*="/artist/"]');
      const artists = [...artistLinks].map(a => a.textContent?.trim()).filter(Boolean);
      const albumLink = row.querySelector('a[href*="/album/"]');
      const album = albumLink?.textContent?.trim() || "";
      const durationEl = row.querySelector('[data-testid="tracklist-duration"]') ||
        row.querySelector('button[aria-label*="duration"]')?.parentElement;
      const durationText = durationEl?.textContent?.trim() || "";
      const durationMs = parseDuration(durationText);

      if (name) {
        scrapedTracks[trackId] = {
          name,
          artists,
          album,
          isrc: "",
          spotifyUri: "spotify:track:" + trackId,
          spotifyId: trackId,
          durationMs,
          addedAt: "",
        };
      }
    }
  }

  function parseDuration(text) {
    const parts = text.split(":").map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return (parts[0] * 60 + parts[1]) * 1000;
    }
    return 0;
  }

  function sendScrapedTracks() {
    if (isIgnoredPage()) return;
    const tracks = Object.values(scrapedTracks);
    if (tracks.length === 0) return;

    // Tag tracks by which page they came from
    const path = window.location.pathname;
    let playlistId = null;
    if (path.startsWith("/collection/tracks")) {
      playlistId = "__liked__";
    } else {
      const playlistMatch = path.match(/\/playlist\/([a-zA-Z0-9]+)/);
      if (playlistMatch) playlistId = playlistMatch[1];
    }

    browser.runtime.sendMessage({
      action: "SCRAPED_TRACKS",
      tracks,
      playlistId,
    }).catch(() => {});
  }

  // ── Sidebar scroll to discover all playlists ─────────────────────────────

  function scrollSidebar() {
    return new Promise((resolve) => {
      // Spotify's sidebar is the narrower scrollable viewport
      const allViewports = [...document.querySelectorAll('[data-overlayscrollbars-viewport]')];
      let sidebar = null;

      if (allViewports.length > 1) {
        // Sort by width ascending — sidebar is the narrowest
        allViewports.sort((a, b) => a.clientWidth - b.clientWidth);
        sidebar = allViewports[0];
      } else if (allViewports.length === 1) {
        sidebar = allViewports[0];
      }

      // Fallback: look for the nav/aside element
      if (!sidebar) {
        sidebar = document.querySelector('nav [style*="overflow"]')
          || document.querySelector('aside [style*="overflow"]')
          || document.querySelector('[data-testid="rootlist"]')?.closest('[style*="overflow"]');
      }

      if (!sidebar || sidebar.scrollHeight <= sidebar.clientHeight) {
        scrapePlaylistsFromSidebar();
        resolve({ playlistCount: scrapedPlaylists.length });
        return;
      }

      // Click the "Playlists" filter pill to hide albums
      clickPlaylistFilter();

      const scrollStep = Math.max(sidebar.clientHeight - 100, 300);
      let pass = 0;
      const PASSES = 2;

      function startPass() {
        pass++;
        sidebar.scrollTop = 0;
        // Wait for the top to render before scrolling
        setTimeout(scrollStep_, 500);
      }

      function scrollStep_() {
        scrapePlaylistsFromSidebar();

        const prevTop = sidebar.scrollTop;
        sidebar.scrollTop += scrollStep;

        if (sidebar.scrollTop === prevTop) {
          // At the bottom — do another pass or finish
          scrapePlaylistsFromSidebar();
          if (pass < PASSES) {
            startPass();
          } else {
            sidebar.scrollTop = 0;
            resolve({ playlistCount: scrapedPlaylists.length });
          }
          return;
        }

        setTimeout(scrollStep_, 300);
      }

      startPass();
    });
  }

  function clickPlaylistFilter() {
    // Look for filter chips/pills in the sidebar
    const buttons = document.querySelectorAll('button, [role="tab"], [role="option"], chip');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text === "playlists" || text === "wiedergabelisten") {
        btn.click();
        return;
      }
    }
  }

  const scrapedPlaylists = [];
  const seenPlaylistIds = new Set();

  function scrapePlaylistsFromSidebar() {
    // Find playlist links in the sidebar
    const links = document.querySelectorAll('a[href*="/playlist/"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/playlist\/([a-zA-Z0-9]+)/);
      if (!match) continue;
      const id = match[1];
      if (seenPlaylistIds.has(id)) continue;

      // Try to get the playlist name from the link or nearby text
      const name = link.textContent?.trim()
        || link.querySelector('[class*="Text"]')?.textContent?.trim()
        || link.getAttribute("aria-label")?.trim()
        || id;

      // Check for radio/podcast indicators in the sidebar item's metadata
      const container = link.closest('li, [role="listitem"], [data-testid]') || link.parentElement;
      const containerText = (container?.textContent || "").toLowerCase();
      const lower = name.toLowerCase();

      // Skip podcasts
      if (lower === "your episodes" || lower === "deine episoden") continue;

      // Skip radios — check subtitle text in the sidebar item
      if (isRadioItem(containerText)) continue;

      seenPlaylistIds.add(id);
      scrapedPlaylists.push({ spotifyId: id, name });
    }
  }

  function isRadioItem(text) {
    // Spotify sidebar items show type metadata like "Radio", "Playlist Radio", etc.
    // Match common radio indicators in multiple languages
    const radioPatterns = [
      /\bradio\b/,
      /\bradiosender\b/,    // German
      /\bstation\sradio\b/, // French
      /\bemisora\b/,        // Spanish
    ];
    for (const pat of radioPatterns) {
      if (pat.test(text)) return true;
    }
    return false;
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "PING") {
      return Promise.resolve({ pong: true, service: "spotify" });
    }
    if (msg.action === "AUTO_SCROLL") {
      autoScroll();
      return Promise.resolve({ ok: true });
    }
    if (msg.action === "ABORT_SCROLL") {
      scrollAbort = true;
      return Promise.resolve({ ok: true });
    }
    if (msg.action === "SCROLL_SIDEBAR") {
      scrollSidebar().then((result) => {
        browser.runtime.sendMessage({
          action: "SIDEBAR_DONE",
          playlists: scrapedPlaylists,
          playlistCount: result.playlistCount,
        }).catch(() => {});
      });
      return Promise.resolve({ ok: true });
    }
  });
})();
