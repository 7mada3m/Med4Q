"use strict";

(() => {
  const BASE = new URL("./", location.href);
  const CATALOG_URL = new URL("catalog.json", BASE).href;
  const CATALOG_CACHE = `mid4q-catalog:${BASE.pathname}`;
  const PAGE_SIZE = 48;
  const $ = (id) => document.getElementById(id);
  const ui = {
    search: $("search-input"), clear: $("clear-search"), form: document.querySelector(".search"),
    reload: $("reload-catalog"), install: $("install-app"), grid: $("lecture-grid"),
    count: $("result-count"), notice: $("notice"), loading: $("loading"),
    empty: $("empty-state"), emptyTitle: $("empty-title"), emptyText: $("empty-description"),
    emptyAction: $("empty-action"), more: $("show-more"), template: $("card-template"),
    dialog: $("player-dialog"), title: $("player-title"), mount: $("player-mount"),
    close: $("close-player"), download: $("download-video"), drive: $("open-drive")
  };
  let catalog = [], results = [], wordIndex = { children: new Map(), positions: null }, byId = new Map();
  let loaded = false, busy = false, loadError = false, rendered = 0, searchFrame = 0;
  let catalogNotice = "", installPrompt = null, opener = null, savedScroll = 0;
  const tokenCache = new Map();

  function tokenize(text) {
    return [...new Set(text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [])];
  }

  // One banded Levenshtein row, reused by all words sharing this prefix.
  function levenshteinRow(previous, row, character, query, depth, limit) {
    row.fill(limit + 1);
    row[0] = depth;
    let minimum = row[0];
    const start = Math.max(1, depth - limit), end = Math.min(query.length, depth + limit);
    for (let j = start; j <= end; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
        previous[j - 1] + (character === query[j - 1] ? 0 : 1));
      minimum = Math.min(minimum, row[j]);
    }
    return minimum;
  }

  function buildIndex(items) {
    const index = { children: new Map(), positions: null };
    items.forEach((item, position) => {
      for (const word of tokenize(item.title)) {
        let node = index;
        for (const character of word) {
          if (!node.children.has(character)) node.children.set(character, { children: new Map(), positions: null });
          node = node.children.get(character);
        }
        if (!node.positions) node.positions = new Set();
        node.positions.add(position);
      }
    });
    return index;
  }

  function matchesForToken(token) {
    if (tokenCache.has(token)) return tokenCache.get(token);
    const matches = new Set(), characters = Array.from(token);
    const limit = characters.length <= 6 ? 1 : 2;
    let prefix = wordIndex;
    for (const character of characters) prefix = prefix?.children.get(character);
    if (/^\p{N}+$/u.test(token)) {
      // Lecture numbers stay exact: searching for 1 must not match 2.
      if (prefix?.positions) for (const position of prefix.positions) matches.add(position);
    } else {
      // Prefixes let "pharma" find "pharmacology" while typing.
      const pending = prefix ? [prefix] : [];
      while (pending.length) {
        const node = pending.pop();
        if (node.positions) for (const position of node.positions) matches.add(position);
        for (const child of node.children.values()) pending.push(child);
      }
      const rows = [Uint16Array.from({ length: characters.length + 1 }, (_, i) => i)];
      function visit(parent, depth) {
        const row = rows[depth] || (rows[depth] = new Uint16Array(characters.length + 1));
        for (const [character, child] of parent.children) {
          if (child === prefix) continue; // This entire subtree was collected above.
          const minimum = levenshteinRow(rows[depth - 1], row, character, characters, depth, limit);
          if (minimum > limit) continue;
          if (row[characters.length] <= limit && child.positions) {
            for (const position of child.positions) matches.add(position);
          }
          if (depth < characters.length + limit) visit(child, depth + 1);
        }
      }
      visit(wordIndex, 1);
    }
    if (tokenCache.size >= 128) tokenCache.delete(tokenCache.keys().next().value);
    tokenCache.set(token, matches);
    return matches;
  }

  function findMatches(query) {
    const tokens = tokenize(query);
    if (!tokens.length) return catalog;
    const sets = tokens.map(matchesForToken).sort((a, b) => a.size - b.size);
    return [...sets[0]].filter((position) => sets.every((set) => set.has(position)))
      .sort((a, b) => a - b).map((position) => catalog[position]);
  }

  function validateCatalog(data) {
    if (!Array.isArray(data)) throw new Error("The catalog must be a JSON array.");
    const seen = new Set(), items = [];
    for (const row of data) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" ||
          !row.id.trim() || row.id.length > 120 || seen.has(row.id.trim()) ||
          typeof row.title !== "string" || !row.title.trim() || row.title.length > 500 ||
          typeof row.driveFileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(row.driveFileId)) continue;
      let thumbnailUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(row.driveFileId)}&sz=w640`;
      try {
        const url = new URL(row.thumbnailUrl);
        if (url.protocol === "https:" && !url.username && !url.password) thumbnailUrl = url.href;
      } catch { /* Use the Drive thumbnail when a supplied URL is invalid. */ }
      seen.add(row.id.trim());
      items.push({ id: row.id.trim(), title: row.title.trim(), driveFileId: row.driveFileId, thumbnailUrl });
    }
    if (data.length && !items.length) throw new Error("The catalog has no valid lecture entries.");
    return { items, skipped: data.length - items.length };
  }

  async function catalogCache() {
    try { return "caches" in window ? await caches.open(CATALOG_CACHE) : null; }
    catch { return null; }
  }

  function updateNotice() {
    const offline = navigator.onLine ? "" : "You're offline. Video playback and downloads need an internet connection.";
    ui.notice.textContent = [offline, catalogNotice].filter(Boolean).join(" ");
    ui.notice.hidden = !ui.notice.textContent;
  }

  async function loadCatalog() {
    if (busy) return;
    busy = true;
    ui.reload.disabled = true;
    ui.reload.setAttribute("aria-busy", "true");
    ui.grid.setAttribute("aria-busy", "true");
    ui.loading.hidden = loaded;
    if (!loaded) ui.empty.hidden = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      let response, fromCache = false;
      try {
        response = await fetch(CATALOG_URL, { cache: "no-store", signal: controller.signal });
      } catch (error) {
        const cache = await catalogCache();
        response = cache ? await cache.match(CATALOG_URL) : null;
        if (!response) throw error;
        fromCache = true;
      }
      if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
      const backup = fromCache ? null : response.clone();
      const { items, skipped } = validateCatalog(await response.json());
      catalog = items;
      byId = new Map(items.map((item) => [item.id, item]));
      wordIndex = buildIndex(items);
      tokenCache.clear();
      loaded = true;
      loadError = false;
      catalogNotice = fromCache ? "Showing your saved catalog. Refresh when connected to get updates." : "";
      if (skipped) catalogNotice += `${catalogNotice ? " " : ""}${skipped} invalid or duplicate ${skipped === 1 ? "entry was" : "entries were"} skipped.`;
      if (!fromCache) {
        const cache = await catalogCache();
        if (cache) await cache.put(CATALOG_URL, backup).catch(() => {});
      }
    } catch (error) {
      loadError = !loaded;
      catalogNotice = loaded ? "Could not refresh. Your last loaded lectures are still available." : "";
      console.warn("mid4Q: could not load catalog.", error);
    } finally {
      clearTimeout(timeout);
      busy = false;
      ui.reload.disabled = false;
      ui.reload.removeAttribute("aria-busy");
      ui.grid.setAttribute("aria-busy", "false");
      ui.loading.hidden = true;
      updateNotice();
      applySearch();
    }
  }

  function appendCards() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(rendered + PAGE_SIZE, results.length);
    for (; rendered < end; rendered++) {
      const item = results[rendered];
      const card = ui.template.content.cloneNode(true);
      const button = card.querySelector(".video-card"), image = card.querySelector("img");
      button.dataset.videoId = item.id;
      button.setAttribute("aria-label", `Watch ${item.title}`);
      card.querySelector(".video-title").textContent = item.title;
      image.addEventListener("error", () => { image.hidden = true; }, { once: true });
      image.src = item.thumbnailUrl;
      fragment.append(card);
    }
    ui.grid.append(fragment);
    ui.more.hidden = rendered >= results.length;
  }

  function applySearch() {
    searchFrame = 0;
    const query = ui.search.value.trim();
    ui.clear.hidden = !ui.search.value;
    // Input may arrive before the first request finishes.
    if (!loaded && busy) return;
    results = findMatches(query);
    rendered = 0;
    ui.grid.replaceChildren();
    appendCards();
    ui.empty.hidden = results.length > 0;
    ui.count.textContent = loaded ? (query ? `${results.length} of ${catalog.length} lectures` :
      `${catalog.length} ${catalog.length === 1 ? "lecture" : "lectures"}`) : "Catalog unavailable";
    if (loadError) {
      ui.emptyTitle.textContent = "Couldn't load your lectures";
      ui.emptyText.textContent = location.protocol === "file:" ?
        "Open this app on a web server or GitHub Pages to load the catalog." : "Check your connection, then try again.";
      ui.emptyAction.textContent = "Try again";
      ui.emptyAction.dataset.action = "reload";
    } else if (!catalog.length) {
      ui.emptyTitle.textContent = "No lectures yet";
      ui.emptyText.textContent = "New lectures will appear here. Refresh to check for updates.";
      ui.emptyAction.textContent = "Refresh lectures";
      ui.emptyAction.dataset.action = "reload";
    } else {
      ui.emptyTitle.textContent = "No matching lectures";
      ui.emptyText.textContent = "Try fewer words or another spelling.";
      ui.emptyAction.textContent = "Clear search";
      ui.emptyAction.dataset.action = "clear";
    }
  }

  function clearSearch() {
    if (searchFrame) cancelAnimationFrame(searchFrame);
    ui.search.value = "";
    applySearch();
    ui.search.focus({ preventScroll: true });
  }

  function openPlayer(item, button) {
    if (ui.dialog.open) return;
    const fileId = encodeURIComponent(item.driveFileId);
    const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
    if (typeof ui.dialog.showModal !== "function") {
      window.open(driveUrl, "_blank", "noopener,noreferrer");
      return;
    }
    opener = button;
    savedScroll = window.scrollY;
    ui.title.textContent = item.title;
    ui.download.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
    ui.drive.href = driveUrl;
    const frame = document.createElement("iframe");
    frame.title = `Google Drive player: ${item.title}`;
    frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = `https://drive.google.com/file/d/${fileId}/preview`;
    ui.mount.replaceChildren(frame);
    document.body.style.top = `-${savedScroll}px`;
    document.body.classList.add("modal-open");
    ui.dialog.showModal();
    ui.close.focus({ preventScroll: true });
  }

  function closePlayer() {
    if (!ui.dialog.open) return;
    // Removing the browsing context stops playback immediately.
    ui.mount.replaceChildren();
    ui.dialog.close();
  }

  function cleanupPlayer() {
    ui.mount.replaceChildren();
    ui.download.removeAttribute("href");
    ui.drive.removeAttribute("href");
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("top");
    window.scrollTo(0, savedScroll);
    (opener?.isConnected ? opener : ui.search).focus({ preventScroll: true });
    opener = null;
  }

  function init() {
    ui.form.addEventListener("submit", (event) => event.preventDefault());
    ui.search.addEventListener("input", () => {
      ui.clear.hidden = !ui.search.value;
      if (searchFrame) cancelAnimationFrame(searchFrame);
      searchFrame = requestAnimationFrame(applySearch);
    });
    ui.clear.addEventListener("click", clearSearch);
    ui.reload.addEventListener("click", loadCatalog);
    ui.emptyAction.addEventListener("click", () => ui.emptyAction.dataset.action === "reload" ? loadCatalog() : clearSearch());
    ui.more.addEventListener("click", appendCards);
    ui.grid.addEventListener("click", (event) => {
      const button = event.target.closest(".video-card");
      const item = button && byId.get(button.dataset.videoId);
      if (item) openPlayer(item, button);
    });
    ui.close.addEventListener("click", closePlayer);
    ui.dialog.addEventListener("cancel", (event) => { event.preventDefault(); closePlayer(); });
    ui.dialog.addEventListener("close", cleanupPlayer);
    ui.dialog.addEventListener("click", (event) => {
      const rect = ui.dialog.getBoundingClientRect();
      if (event.target === ui.dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) closePlayer();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ui.dialog.open) { event.preventDefault(); closePlayer(); }
    });
    window.addEventListener("online", updateNotice);
    window.addEventListener("offline", updateNotice);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !ui.more.hidden) appendCards();
      }, { rootMargin: "300px" }).observe(ui.more);
    }
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      ui.install.hidden = false;
    });
    ui.install.addEventListener("click", async () => {
      if (!installPrompt) return;
      const prompt = installPrompt;
      installPrompt = null;
      ui.install.hidden = true;
      try { await prompt.prompt(); await prompt.userChoice; }
      catch { /* The app continues normally if installation is dismissed. */ }
    });
    window.addEventListener("appinstalled", () => { installPrompt = null; ui.install.hidden = true; });
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register(new URL("sw.js", BASE), { scope: BASE.href, updateViaCache: "none" })
        .catch((error) => console.warn("mid4Q: offline shell is unavailable.", error));
    }
    updateNotice();
    loadCatalog();
  }

  init();
})();
