/*!
 * mid4Q: medical lecture streaming PWA.
 * Dependency-free static single-page app, built for GitHub Pages.
 *
 * Videos play through Google Drive's /preview player (an iframe) rather than a
 * <video> tag: direct Drive streams of files over 100 MB are intercepted by
 * Google's virus-scan page, while the preview player is not.
 */
(() => {
  'use strict';

  /* =========================================================================
   * 1. Configuration & small helpers
   * ======================================================================= */

  const CONFIG = Object.freeze({
    catalogUrl: 'catalog.json',     // relative, so it works under user.github.io/<repo>/
    catalogTimeoutMs: 15000,        // give up on a stalled request so Refresh works again
    // Last good catalog, for an instant start-up. Scoped by path because all of a user's
    // GitHub Pages project sites (user.github.io/<repo>/) share one origin and one localStorage.
    storageKey: `mid4q.catalog.v1:${new URL('./', document.baseURI).pathname}`,
    batchSize: 48,                  // cards per render chunk (a multiple of 1, 2, 3 and 4)
    eagerThumbnails: 4,             // the first row skips lazy-loading for a faster first paint
    staleAfterMs: 15 * 60 * 1000,   // refetch the catalog when the app regains focus after this
    pullThreshold: 72,              // px of pull needed to trigger a refresh
    pullMax: 120,
  });

  const drive = Object.freeze({
    preview: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`,
    view: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
    download: (id) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
    thumbnail: (id) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w640`,
  });

  const BASE_TITLE = document.title;
  const NO_RANGES = Object.freeze([]);
  const $ = (selector, root = document) => root.querySelector(selector);
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function lectureCount(count) {
    return `${count.toLocaleString()} ${count === 1 ? 'lecture' : 'lectures'}`;
  }

  function isModifiedClick(event) {
    return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function isEditable(element) {
    return element instanceof HTMLElement &&
      (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
  }

  /* =========================================================================
   * 2. Fuzzy token search (pure functions, no DOM access)
   * -------------------------------------------------------------------------
   *  - Titles and queries are folded (lowercased, accents and diacritics
   *    stripped) and split into word and number tokens: "Renal1" -> renal, 1.
   *  - Every query token must match some title token (AND), in any order.
   *  - One query token vs. one title word, best match wins:
   *      exact > prefix ("pharma" -> "pharmacology") > inner part
   *      ("nephritis" -> "glomerulonephritis") > whole word with typos
   *      > prefix with typos ("glomerolo" -> "glomerulonephritis").
   *  - Typo budget (Levenshtein distance, also counting a swap of two
   *    neighbouring letters as one edit): 1 typo for words up to 6 chars,
   *    2 typos for longer words.
   *  - Deliberate guards on top of that rule: 1–2 character tokens never use
   *    typos, and numbers must match exactly. Otherwise "renal 1" would also
   *    match "renal 2" and "renal 10".
   *  - Common stop words ("of", "the", …) are optional, so natural phrasing
   *    like "anatomy of the heart" still finds "Heart Anatomy". They only add
   *    to the score when they appear as whole words.
   *  - Per-word match results are computed once over the catalog's unique
   *    vocabulary and memoised, so each keystroke only re-scores the word
   *    being typed.
   * ======================================================================= */

  const SearchEngine = (() => {
    const TOKEN_RE = /[\p{L}\p{M}]+(?:['’ʼ][\p{L}\p{M}]+)*|\p{N}+/gu;
    const MARKS_RE = /\p{M}+/gu;
    const APOSTROPHES_RE = /['’ʼ]/g;
    const DIGITS_RE = /^\d+$/;
    const STOP_WORDS = new Set([
      'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'vs', 'with',
    ]);

    const MIN_TYPO_LENGTH = 3;        // shorter tokens must match exactly or as a prefix
    const MIN_TYPO_PREFIX_LENGTH = 4; // a typo inside a half-typed word needs some context
    const MIN_INFIX_LENGTH = 4;       // "nephritis" inside "glomerulonephritis"
    const MATCH_CACHE_LIMIT = 256;

    const SCORE = Object.freeze({
      exact: 1,
      prefix: 0.8,       // + up to 0.1 for how much of the word is covered
      infix: 0.6,        // + up to 0.1
      typo: 0.55,        // 1 typo; each extra typo costs `perExtraTypo`
      typoPrefix: 0.45,
      perExtraTypo: 0.12,
    });

    /** Lowercase; strip accents and diacritics (incl. Arabic harakat); unify a few letter variants. */
    function fold(text) {
      return text
        .normalize('NFD')
        .replace(MARKS_RE, '')
        .toLowerCase()
        .replace(APOSTROPHES_RE, '')
        .replace(/ـ/g, '')          // Arabic tatweel
        .replace(/ى/g, 'ي')    // alef maqsura -> yeh
        .replace(/ة/g, 'ه')    // teh marbuta -> heh
        .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0));
    }

    /** Split text into folded tokens, keeping [start, end) offsets into the original string. */
    function tokenize(text) {
      const tokens = [];
      for (const match of String(text).matchAll(TOKEN_RE)) {
        let norm = fold(match[0]);
        if (!norm) continue;
        const isNumber = DIGITS_RE.test(norm);
        if (isNumber) norm = norm.replace(/^0+(?=\d)/, ''); // "01" and "1" are the same lecture number
        tokens.push({ norm, isNumber, start: match.index, end: match.index + match[0].length });
      }
      return tokens;
    }

    function typoBudget(length) {
      if (length < MIN_TYPO_LENGTH) return 0;
      return length <= 6 ? 1 : 2;
    }

    // Reusable dynamic-programming rows (tokens are short; grown on demand).
    let rowA = new Int32Array(64);
    let rowB = new Int32Array(64);
    let rowC = new Int32Array(64);
    let lastPrefixEnd = 0;

    /**
     * Bounded Levenshtein distance that also counts a swap of two neighbouring
     * characters as one edit (optimal string alignment).
     * prefixMode: distance from `a` to the closest *prefix* of `b`; the matched
     * prefix length is left in `lastPrefixEnd`.
     * Returns max + 1 as soon as the distance is known to exceed `max`.
     */
    function editDistance(a, b, max, prefixMode) {
      const m = a.length;
      const n = prefixMode ? Math.min(b.length, m + max) : b.length;
      if (rowA.length <= n) {
        const size = n + 32;
        rowA = new Int32Array(size);
        rowB = new Int32Array(size);
        rowC = new Int32Array(size);
      }
      let older = rowA; // row i - 2 (for swaps)
      let prev = rowB;  // row i - 1
      let cur = rowC;   // row i
      for (let j = 0; j <= n; j++) prev[j] = j;

      for (let i = 1; i <= m; i++) {
        const ca = a.charCodeAt(i - 1);
        const caBefore = i > 1 ? a.charCodeAt(i - 2) : -1;
        cur[0] = i;
        let rowMin = i;
        for (let j = 1; j <= n; j++) {
          const cb = b.charCodeAt(j - 1);
          let value = prev[j - 1] + (ca === cb ? 0 : 1);       // match / substitution
          if (prev[j] + 1 < value) value = prev[j] + 1;         // deletion
          if (cur[j - 1] + 1 < value) value = cur[j - 1] + 1;   // insertion
          if (j > 1 && caBefore === cb && ca === b.charCodeAt(j - 2) && older[j - 2] + 1 < value) {
            value = older[j - 2] + 1;                           // neighbour swap
          }
          cur[j] = value;
          if (value < rowMin) rowMin = value;
        }
        if (rowMin > max) return max + 1; // every path already costs too much
        const recycled = older;
        older = prev;
        prev = cur;
        cur = recycled;
      }

      if (!prefixMode) return prev[n];
      let best = max + 1;
      for (let j = Math.max(1, m - max); j <= n; j++) {
        if (prev[j] < best) {
          best = prev[j];
          lastPrefixEnd = j;
        }
      }
      return best;
    }

    /** Scores one folded query word against every vocabulary word (memoised per index). */
    function matchWord(index, query) {
      const cached = index.matchCache.get(query);
      if (cached) return cached;

      const { words, numeric } = index;
      const size = words.length;
      const scores = new Float32Array(size);
      const from = new Uint16Array(size); // highlighted part of the word, in folded characters
      const to = new Uint16Array(size);
      const queryLength = query.length;
      const queryIsNumber = DIGITS_RE.test(query);
      const budget = queryIsNumber ? 0 : typoBudget(queryLength);

      for (let i = 0; i < size; i++) {
        const word = words[i];
        const wordLength = word.length;

        if (word === query) {
          scores[i] = SCORE.exact;
          to[i] = wordLength;
          continue;
        }
        if (queryIsNumber || numeric[i]) continue; // numbers only ever match numbers exactly

        if (wordLength > queryLength && word.startsWith(query)) {
          scores[i] = SCORE.prefix + 0.1 * (queryLength / wordLength);
          to[i] = queryLength;
          continue;
        }

        if (queryLength >= MIN_INFIX_LENGTH && wordLength > queryLength) {
          const at = word.indexOf(query, 1);
          if (at > 0) {
            scores[i] = SCORE.infix + 0.1 * (queryLength / wordLength);
            from[i] = at;
            to[i] = at + queryLength;
            continue;
          }
        }

        if (!budget) continue;

        if (Math.abs(wordLength - queryLength) <= budget) {
          const distance = editDistance(query, word, budget, false);
          if (distance <= budget) {
            scores[i] = SCORE.typo - SCORE.perExtraTypo * (distance - 1);
            to[i] = wordLength;
            if (distance === 1) continue; // a typo-prefix match cannot beat this
          }
        }

        if (queryLength >= MIN_TYPO_PREFIX_LENGTH && wordLength > queryLength - budget) {
          const distance = editDistance(query, word, budget, true);
          if (distance <= budget) {
            const score = SCORE.typoPrefix - SCORE.perExtraTypo * (distance - 1);
            if (score > scores[i]) {
              scores[i] = score;
              from[i] = 0;
              to[i] = lastPrefixEnd;
            }
          }
        }
      }

      const result = { scores, from, to };
      if (index.matchCache.size >= MATCH_CACHE_LIMIT) index.matchCache.clear();
      index.matchCache.set(query, result);
      return result;
    }

    /** Pre-tokenises every item once; tokens point into a shared vocabulary. */
    function buildIndex(items, getText) {
      const vocabulary = new Map();
      const words = [];
      const numeric = [];
      const entries = items.map((item, order) => {
        const text = getText(item);
        const tokens = tokenize(text).map(({ norm, isNumber, start, end }) => {
          let id = vocabulary.get(norm);
          if (id === undefined) {
            id = words.length;
            vocabulary.set(norm, id);
            words.push(norm);
            numeric.push(isNumber);
          }
          return { id, start, end };
        });
        // Space-padded folded title, used for the "words typed in sequence" bonus.
        const folded = ` ${tokens.map((token) => words[token.id]).join(' ')} `;
        return { item, order, text, tokens, folded };
      });
      return { entries, words, numeric, matchCache: new Map() };
    }

    /**
     * Returns ranked results [{ entry, score, hits }] or null for an empty query.
     */
    function search(index, rawQuery) {
      const parsed = tokenize(rawQuery);
      if (!parsed.length) return null;

      const words = [];
      for (const token of parsed) {
        if (!words.includes(token.norm)) words.push(token.norm);
      }
      const onlyStopWords = words.every((word) => STOP_WORDS.has(word));
      // The last word may still be half-typed ("heart the" → "therapy"), so an optional stop word
      // there may also match as a prefix; elsewhere it only counts when it appears as a whole word.
      const lastWord = /\s$/.test(rawQuery) ? null : parsed[parsed.length - 1].norm;
      const terms = words.map((word) => {
        const required = onlyStopWords || !STOP_WORDS.has(word);
        const floor = required ? 0 : word === lastWord ? SCORE.prefix : SCORE.exact;
        return { required, floor, match: matchWord(index, word) };
      });
      const phrase = parsed.length > 1 ? ` ${parsed.map((token) => token.norm).join(' ')}` : '';

      const results = [];
      for (const entry of index.entries) {
        const { tokens } = entry;
        const hits = [];
        let score = 0;
        let previous = -1;
        let inOrder = true;
        let atStart = false;
        let rejected = false;

        for (const term of terms) {
          let best = 0;
          let bestAt = -1;
          for (let k = 0; k < tokens.length; k++) {
            const value = term.match.scores[tokens[k].id];
            if (value > best && value >= term.floor) {
              best = value;
              bestAt = k;
            }
          }
          if (best === 0) {
            if (term.required) {
              rejected = true;
              break;
            }
            continue;
          }
          score += best;
          hits.push({ match: term.match, at: bestAt });
          if (bestAt < previous) inOrder = false;
          if (bestAt === 0) atStart = true;
          previous = bestAt;
        }

        if (rejected || hits.length === 0) continue;
        if (hits.length > 1 && inOrder) score += 0.15;          // typed in title order
        if (phrase && entry.folded.includes(phrase)) score += 0.35; // typed as a contiguous phrase
        if (atStart) score += 0.1;                               // title starts with a query word
        score -= tokens.length * 0.004;                          // prefer concise titles
        results.push({ entry, score, hits });
      }

      results.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order);
      return results;
    }

    /** Maps a [from, to) range of folded characters back onto the original text. */
    function mapFoldedRange(text, start, end, from, to) {
      let folded = 0;
      let rangeStart = start;
      let rangeEnd = end;
      let foundStart = false;
      for (let i = start; i < end;) {
        const char = String.fromCodePoint(text.codePointAt(i));
        const width = fold(char).length;
        if (!foundStart && folded + width > from) {
          rangeStart = i;
          foundStart = true;
        }
        folded += width;
        i += char.length;
        if (folded >= to) {
          rangeEnd = i;
          break;
        }
      }
      // Keep trailing combining marks (and Arabic tatweel) attached to the highlighted letter.
      while (rangeEnd < end) {
        const char = String.fromCodePoint(text.codePointAt(rangeEnd));
        if (!/^[\p{M}\u0640]+$/u.test(char)) break;
        rangeEnd += char.length;
      }
      return [rangeStart, rangeEnd];
    }

    function mergeRanges(ranges) {
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [start, end] of ranges) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      return merged;
    }

    /** Character ranges of the original title to highlight for a search result. */
    function highlight(index, result) {
      if (!result || !result.hits) return NO_RANGES;
      const { entry } = result;
      const ranges = result.hits.map(({ match, at }) => {
        const token = entry.tokens[at];
        const from = match.from[token.id];
        const to = match.to[token.id];
        return from === 0 && to >= index.words[token.id].length
          ? [token.start, token.end]
          : mapFoldedRange(entry.text, token.start, token.end, from, to);
      });
      return mergeRanges(ranges);
    }

    return { buildIndex, search, highlight, tokenize, fold };
  })();
  /* END SearchEngine */

  /* =========================================================================
   * 3. Catalog: validation & normalisation
   * ======================================================================= */

  class CatalogError extends Error {}
  class OfflineError extends Error {}

  const DRIVE_ID_RE = /^[\w-]{10,200}$/;
  const TITLE_SEPARATOR_RE = /\s+[-–—|·]\s+|:\s+/;

  /** Accepts a bare Drive file ID or a pasted share link and returns the ID. */
  function extractDriveId(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (DRIVE_ID_RE.test(raw)) return raw;
    const match = raw.match(/\/d\/([\w-]{10,200})/) || raw.match(/[?&]id=([\w-]{10,200})/);
    return match ? match[1] : null;
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), document.baseURI);
      if (url.protocol === 'http:' && window.location.protocol === 'https:') url.protocol = 'https:';
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
      if (url.protocol === 'data:' && /^data:image\//i.test(url.href)) return url.href;
    } catch {
      /* not a URL */
    }
    return null;
  }

  function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /** Replaces unpaired UTF-16 surrogates, which would make encodeURIComponent() throw. */
  function wellFormed(text) {
    return typeof text.toWellFormed === 'function' ? text.toWellFormed() : text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  }

  /** "Renal Pathology - Glomerulonephritis" → eyebrow "Renal Pathology" + title "Glomerulonephritis". */
  function splitTitle(title) {
    const match = TITLE_SEPARATOR_RE.exec(title);
    if (match && match.index >= 2 && match.index <= 48) {
      const mainStart = match.index + match[0].length;
      if (title.length - mainStart >= 3) {
        return {
          eyebrow: { text: title.slice(0, match.index), start: 0 },
          main: { text: title.slice(mainStart), start: mainStart },
        };
      }
    }
    return { eyebrow: null, main: { text: title, start: 0 } };
  }

  function normalizeCatalog(data) {
    const list = Array.isArray(data) ? data : data && Array.isArray(data.videos) ? data.videos : null;
    if (!list) throw new CatalogError('catalog.json must contain a JSON array of lectures.');

    const items = [];
    const usedIds = new Set();
    let skipped = 0;

    for (const raw of list) {
      const driveFileId = raw && typeof raw === 'object' ? extractDriveId(raw.driveFileId) : null;
      if (!driveFileId) {
        skipped += 1;
        continue;
      }
      const title = cleanText(raw.title) || 'Untitled lecture';
      const baseId = wellFormed(cleanText(raw.id) || driveFileId);
      let id = baseId;
      for (let n = 2; usedIds.has(id); n++) id = `${baseId}-${n}`;
      usedIds.add(id);

      items.push({
        id,
        title,
        driveFileId,
        thumbnailUrl: safeImageUrl(raw.thumbnailUrl) || drive.thumbnail(driveFileId),
        order: items.length,
        parts: splitTitle(title),
      });
    }
    return { items, skipped };
  }

  function parseCatalog(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new CatalogError(`catalog.json is not valid JSON (${error.message}).`);
    }
    return normalizeCatalog(data);
  }

  const savedCatalog = {
    read() {
      try {
        return window.localStorage.getItem(CONFIG.storageKey);
      } catch {
        return null;
      }
    },
    write(text) {
      try {
        window.localStorage.setItem(CONFIG.storageKey, text);
      } catch {
        /* storage full or unavailable (private mode): not critical */
      }
    },
    clear() {
      try {
        window.localStorage.removeItem(CONFIG.storageKey);
      } catch {
        /* ignore */
      }
    },
  };

  /* =========================================================================
   * 4. State & DOM references
   * ======================================================================= */

  const state = {
    items: null,          // normalised catalog items (null until the first load)
    byId: new Map(),
    index: null,          // search index
    catalogText: null,    // raw JSON of the catalog on screen (change detection)
    results: [],          // [{ entry, hits }] in display order
    rendered: 0,          // how many results are in the DOM
    query: '',
    searching: false,
    loading: null,        // in-flight load promise (de-duplicates refreshes)
    loadedAt: 0,
    showingSavedCopy: false, // network failed; the list on screen is the saved copy
  };

  const dom = {
    topbar: $('#topbar'),
    brand: $('.brand'),
    searchForm: $('#search-form'),
    search: $('#search-input'),
    clear: $('#search-clear'),
    refresh: $('#refresh-btn'),
    install: $('#install-btn'),
    main: $('#main'),
    title: $('#results-title'),
    meta: $('#results-meta'),
    grid: $('#grid'),
    sentinel: $('#sentinel'),
    empty: $('#empty-state'),
    emptyIcon: $('#empty-icon'),
    emptyTitle: $('#empty-title'),
    emptyText: $('#empty-text'),
    emptyAction: $('#empty-action'),
    error: $('#error-state'),
    errorText: $('#error-text'),
    retry: $('#retry-btn'),
    live: $('#live-region'),
    toasts: $('#toasts'),
    ptr: $('#ptr'),
    template: $('#card-template'),
    dialog: $('#player'),
    playerToasts: $('#player-toasts'),
  };

  const skeletonNodes = Array.from(dom.grid.children, (node) => node.cloneNode(true));

  /* =========================================================================
   * 5. Toasts & screen-reader announcements
   * ======================================================================= */

  function toast(message, { tone = 'info', duration = 3600 } = {}) {
    // A modal dialog makes the rest of the page inert, so toasts move inside it while it is open.
    const region = dom.dialog.hasAttribute('open') ? dom.playerToasts : dom.toasts;
    const element = document.createElement('div');
    element.className = `toast toast--${tone}`;
    element.textContent = message;
    region.append(element);
    while (region.children.length > 3) region.firstElementChild.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => element.classList.add('is-visible')));
    setTimeout(() => {
      element.classList.remove('is-visible');
      setTimeout(() => element.remove(), 400);
    }, duration);
  }

  function announce(message) {
    dom.live.textContent = '';
    setTimeout(() => {
      dom.live.textContent = message;
    }, 60);
  }

  const announceResults = debounce(() => {
    if (!state.items) return;
    if (!state.searching) {
      announce(`Showing all ${lectureCount(state.results.length)}`);
      return;
    }
    const count = state.results.length;
    announce(count ? `${lectureCount(count)} found` : 'No lectures found');
  }, 500);

  /* =========================================================================
   * 6. Player modal (Google Drive /preview iframe)
   * ======================================================================= */

  function getWatchId() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const value = new URLSearchParams(hash).get('watch');
    return value && value.trim() ? value : null;
  }

  function urlWithoutHash() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function watchUrl(id) {
    const url = new URL(window.location.href);
    url.hash = `watch=${encodeURIComponent(id)}`;
    return url.href;
  }

  async function copyText(text, container) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall back below */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden';
      container.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  const Player = (() => {
    const dialog = dom.dialog;
    const frame = $('#player-frame');
    const titleEl = $('#player-title');
    const eyebrowEl = $('#player-eyebrow');
    const closeBtn = $('#player-close');
    const downloadLink = $('#player-download');
    const driveLink = $('#player-drive');
    const shareBtn = $('#player-share');
    const shareLabel = $('#player-share-label');
    const offlineNote = $('#player-offline');
    const supportsModal = typeof dialog.showModal === 'function';
    const canNativeShare = typeof navigator.share === 'function' && coarsePointer.matches;

    let current = null;
    let returnFocusTo = null;
    let awaitingPop = false;   // history.back() was called; waiting for popstate to close
    let popTimer = 0;
    let pressStartedOnBackdrop = false;
    let openedAt = 0;

    shareLabel.textContent = canNativeShare ? 'Share' : 'Copy link';

    const isOpen = () => dialog.hasAttribute('open'); // `dialog.open` is undefined without native <dialog>
    const ownsHistoryEntry = () => Boolean(window.history.state && window.history.state.mid4q === 'player');

    function mountIframe(item) {
      unmountIframe();
      const iframe = document.createElement('iframe');
      iframe.className = 'player__iframe';
      iframe.title = `Video player: ${item.title}`;
      // Fullscreen comes from `allowfullscreen` (honoured by every browser); listing it in
      // `allow` as well only makes Chrome log a "takes precedence" warning.
      iframe.allow = 'autoplay; picture-in-picture; encrypted-media';
      iframe.setAttribute('allowfullscreen', '');
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.addEventListener('load', () => frame.classList.add('is-ready'), { once: true });
      iframe.src = drive.preview(item.driveFileId);
      frame.append(iframe);
    }

    function unmountIframe() {
      frame.classList.remove('is-ready');
      // Removing the iframe destroys its document, which reliably stops playback.
      frame.querySelectorAll('iframe').forEach((iframe) => iframe.remove());
    }

    function renderDetails(item) {
      const { eyebrow, main } = item.parts;
      eyebrowEl.textContent = eyebrow ? eyebrow.text : '';
      eyebrowEl.hidden = !eyebrow;
      titleEl.textContent = main.text;
      downloadLink.href = drive.download(item.driveFileId);
      downloadLink.setAttribute('aria-label', `Download “${item.title}” from Google Drive`);
      driveLink.href = drive.view(item.driveFileId);
      offlineNote.hidden = navigator.onLine !== false;
      document.title = `${item.title} · mid4Q`;
    }

    /** Shows `item` without touching history (used by URL sync and by open()). */
    function show(item, trigger = null) {
      if (isOpen() && current && current.id === item.id && current.driveFileId === item.driveFileId) {
        current = item; // same video (e.g. after a catalog refresh): update the text, keep playing
        renderDetails(item);
        return;
      }
      if (!isOpen()) {
        returnFocusTo = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        awaitingPop = false;
        openedAt = performance.now();
      }
      current = item;
      renderDetails(item);
      mountIframe(item);

      if (!isOpen()) {
        if (supportsModal) dialog.showModal();
        else dialog.setAttribute('open', '');
        document.documentElement.classList.add('has-modal');
      }
      closeBtn.focus({ preventScroll: true });
    }

    /** Opens from a user action: adds a history entry so Back (e.g. Android) closes the player. */
    function open(item, trigger) {
      if (isOpen()) {
        show(item, trigger);
        return;
      }
      window.history.pushState({ mid4q: 'player', id: item.id }, '', `#watch=${encodeURIComponent(item.id)}`);
      show(item, trigger);
    }

    function hide() {
      if (!isOpen()) return;
      if (supportsModal) {
        dialog.close(); // fires "close" → onClosed()
      } else {
        dialog.removeAttribute('open');
        onClosed();
      }
    }

    /** Close requested by the user (button, Esc, backdrop click). */
    function requestClose() {
      if (!isOpen() || awaitingPop) return;
      if (getWatchId() && ownsHistoryEntry()) {
        awaitingPop = true;
        window.history.back(); // popstate → syncPlayerWithUrl() → hide()
        clearTimeout(popTimer);
        popTimer = setTimeout(() => {
          if (awaitingPop) hide(); // safety net if popstate never arrives
        }, 700);
        return;
      }
      if (getWatchId()) window.history.replaceState(null, '', urlWithoutHash()); // deep-linked: don't leave the site
      hide();
    }

    function onClosed() {
      clearTimeout(popTimer);
      unmountIframe();
      document.documentElement.classList.remove('has-modal');
      document.title = BASE_TITLE;
      current = null;
      const target = returnFocusTo;
      returnFocusTo = null;
      if (target && target.isConnected) target.focus({ preventScroll: true });
      // The browser may close the dialog by itself (e.g. Esc pressed twice); keep the URL in sync.
      if (!awaitingPop && getWatchId()) {
        if (ownsHistoryEntry()) {
          awaitingPop = true;
          window.history.back();
        } else {
          window.history.replaceState(null, '', urlWithoutHash());
        }
      }
    }

    function onPopState() {
      awaitingPop = false;
      clearTimeout(popTimer);
    }

    function setOffline(offline) {
      if (isOpen()) offlineNote.hidden = !offline;
    }

    // The second click of a double-click (or double-tap) on a card lands on the dialog that the
    // first click just opened: on the backdrop, the × or a link now under the pointer. Swallow
    // pointer clicks right after opening (keyboard activation has detail 0 and is never blocked).
    dialog.addEventListener('click', (event) => {
      const sinceOpen = performance.now() - openedAt;
      if (event.detail > 0 && (sinceOpen < 450 || (event.detail > 1 && sinceOpen < 1000))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    dialog.addEventListener('close', onClosed);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault(); // route Esc through requestClose() so history stays consistent
      requestClose();
    });
    closeBtn.addEventListener('click', requestClose);

    // The dialog element covers the viewport and the panel sits inside it,
    // so a press that starts *and* ends on the dialog itself is a backdrop click.
    dialog.addEventListener('pointerdown', (event) => {
      pressStartedOnBackdrop = event.target === dialog;
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && pressStartedOnBackdrop) requestClose();
      pressStartedOnBackdrop = false;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen() && !event.defaultPrevented) {
        event.preventDefault();
        requestClose();
      }
    });

    shareBtn.addEventListener('click', async () => {
      if (!current) return;
      const item = current;
      const url = watchUrl(item.id);
      if (canNativeShare) {
        try {
          await navigator.share({ title: item.title, url });
          return;
        } catch (error) {
          if (error && error.name === 'AbortError') return; // user dismissed the share sheet
        }
      }
      const copied = await copyText(url, dialog);
      toast(copied ? 'Link copied to clipboard.' : 'Couldn’t copy the link.', { tone: copied ? 'success' : 'error' });
    });

    return {
      open,
      show,
      hide,
      isOpen,
      onPopState,
      setOffline,
      get currentId() {
        return current ? current.id : null;
      },
    };
  })();

  /**
   * Makes the player match the URL hash (#watch=<id>): deep links, Back/Forward.
   * `final`: whether a missing id really means "not in the catalog". Only a catalog that came
   * from the network can say that; a saved copy may simply predate the lecture.
   */
  function syncPlayerWithUrl({ final = state.loadedAt > 0 && !state.showingSavedCopy } = {}) {
    const id = getWatchId();
    if (!id) {
      Player.hide();
      return;
    }
    if (!state.items) return; // catalog not loaded yet; called again after loading
    const item = state.byId.get(id);
    if (item) {
      Player.show(item);
      return;
    }
    if (Player.currentId === id) return; // removed by a refresh while playing: let it keep playing
    if (!final) return; // a saved (possibly older) catalog may simply not list it yet
    window.history.replaceState(null, '', urlWithoutHash());
    Player.hide();
    toast('That lecture isn’t in the catalog anymore.', { tone: 'warn' });
  }

  /* =========================================================================
   * 7. Rendering: cards, highlights, incremental batches, states
   * ======================================================================= */

  const cardCache = new Map(); // id → { root, eyebrow, title, signature, marked }

  const signatureOf = (item) => `${item.title}\u0000${item.driveFileId}\u0000${item.thumbnailUrl}`;

  /** Writes `text` into `element`, wrapping highlighted ranges in <mark> (no innerHTML). */
  function writeHighlighted(element, text, offset, ranges) {
    if (!ranges.length) {
      element.textContent = text;
      return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [rangeStart, rangeEnd] of ranges) {
      const start = Math.max(rangeStart - offset, cursor);
      const end = Math.min(rangeEnd - offset, text.length);
      if (end <= start) continue;
      if (start > cursor) fragment.append(text.slice(cursor, start));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    element.replaceChildren(fragment);
  }

  function paintCardText(card, item, ranges) {
    const { eyebrow, main } = item.parts;
    if (eyebrow) writeHighlighted(card.eyebrow, eyebrow.text, eyebrow.start, ranges);
    card.eyebrow.hidden = !eyebrow;
    writeHighlighted(card.title, main.text, main.start, ranges);
    card.marked = ranges.length > 0;
  }

  function createCard(item) {
    const root = dom.template.content.firstElementChild.cloneNode(true);
    const link = $('.card__link', root);
    const thumb = $('.card__thumb', root);
    const img = $('.card__img', root);
    const card = {
      root,
      eyebrow: $('.card__eyebrow', root),
      title: $('.card__title', root),
      signature: signatureOf(item),
      marked: false,
    };

    link.href = `#watch=${encodeURIComponent(item.id)}`;
    link.dataset.id = item.id;

    // `loading` must be set before `src`; the first row loads eagerly for a faster first paint.
    const eager = item.order < CONFIG.eagerThumbnails;
    img.loading = eager ? 'eager' : 'lazy';
    if (eager && 'fetchPriority' in img) img.fetchPriority = 'high';
    img.addEventListener('load', () => thumb.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => thumb.classList.add('is-error'), { once: true });
    img.src = item.thumbnailUrl;

    paintCardText(card, item, NO_RANGES);
    return card;
  }

  /** Reuses one DOM node per lecture, so thumbnails never reload while filtering. */
  function cardFor(result) {
    const { item } = result.entry;
    let card = cardCache.get(item.id);
    if (!card) {
      card = createCard(item);
      cardCache.set(item.id, card);
    }
    const ranges = result.hits ? SearchEngine.highlight(state.index, result) : NO_RANGES;
    if (ranges.length || card.marked) paintCardText(card, item, ranges);
    return card.root;
  }

  const sentinelObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderMore();
    }, { rootMargin: '0px 0px 900px 0px' })
    : null;

  function renderGrid({ keep = 0 } = {}) {
    const total = state.results.length;
    const count = sentinelObserver ? Math.min(total, Math.max(CONFIG.batchSize, keep)) : total;
    const focused = dom.grid.contains(document.activeElement) ? document.activeElement : null;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) fragment.append(cardFor(state.results[i]));
    dom.grid.replaceChildren(fragment);
    // Moving a focused card out and back in blurs it; keep keyboard users where they were.
    if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    state.rendered = count;
    updateViewState();
    fillViewport();
  }

  function renderMore() {
    const total = state.results.length;
    if (state.rendered >= total) return;
    const end = Math.min(total, state.rendered + CONFIG.batchSize);
    const fragment = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) fragment.append(cardFor(state.results[i]));
    dom.grid.append(fragment);
    state.rendered = end;
    dom.sentinel.hidden = state.rendered >= total;
    fillViewport();
  }

  /** IntersectionObserver won't fire again if the sentinel is still in range after a render. */
  function fillViewport() {
    if (state.rendered >= state.results.length) return;
    requestAnimationFrame(() => {
      if (state.rendered >= state.results.length || dom.sentinel.hidden) return;
      if (dom.sentinel.getBoundingClientRect().top < window.innerHeight + 900) renderMore();
    });
  }

  function showEmptyState(kind) {
    if (kind === 'search') {
      dom.emptyIcon.setAttribute('href', '#i-search-x');
      dom.emptyTitle.textContent = 'No lectures found';
      dom.emptyText.textContent = `Nothing matches “${dom.search.value.trim()}”. Check the spelling or try fewer words.`;
      dom.emptyAction.textContent = 'Clear search';
      dom.emptyAction.dataset.action = 'clear';
    } else {
      dom.emptyIcon.setAttribute('href', '#i-inbox');
      dom.emptyTitle.textContent = 'No lectures yet';
      dom.emptyText.textContent = 'catalog.json loaded, but it doesn’t list any videos with a valid driveFileId.';
      dom.emptyAction.textContent = 'Reload';
      dom.emptyAction.dataset.action = 'reload';
    }
    dom.empty.hidden = false;
  }

  function updateViewState() {
    const total = state.results.length;
    dom.sentinel.hidden = state.rendered >= total;
    dom.grid.hidden = total === 0;
    if (!state.items) return;
    if (state.items.length === 0) showEmptyState('catalog');
    else if (total === 0) showEmptyState('search');
    else dom.empty.hidden = true;
  }

  function updateSummary() {
    if (!state.items) return;
    const total = state.items.length;
    if (state.searching) {
      dom.title.textContent = 'Search results';
      dom.meta.textContent = `${state.results.length.toLocaleString()} of ${lectureCount(total)}`;
    } else {
      dom.title.textContent = 'All lectures';
      dom.meta.textContent = `${lectureCount(total)}${state.showingSavedCopy ? ' · saved copy' : ''}`;
    }
  }

  function showLoading() {
    dom.error.hidden = true;
    dom.empty.hidden = true;
    dom.sentinel.hidden = true;
    dom.grid.hidden = false;
    dom.grid.setAttribute('aria-busy', 'true');
    dom.grid.replaceChildren(...skeletonNodes.map((node) => node.cloneNode(true)));
    dom.meta.textContent = 'Loading lectures…';
  }

  function showError(error) {
    dom.grid.replaceChildren();
    dom.grid.hidden = true;
    dom.grid.removeAttribute('aria-busy');
    dom.empty.hidden = true;
    dom.sentinel.hidden = true;
    let message = error instanceof CatalogError ? error.message : 'Check your connection and try again.';
    if (window.location.protocol === 'file:') {
      message = 'Browsers block fetch() for pages opened straight from disk (file://). Serve this folder with a local web server, for example “python3 -m http.server”, then open http://localhost:8000.';
    } else if (navigator.onLine === false) {
      message = 'You appear to be offline. Connect to the internet and try again.';
    }
    dom.errorText.textContent = message;
    dom.error.hidden = false;
    dom.title.textContent = 'All lectures';
    dom.meta.textContent = 'Lecture list unavailable';
  }

  /** If the results moved under the sticky header while typing, bring them back into view. */
  function revealResultsTop() {
    const headerBottom = dom.topbar.getBoundingClientRect().bottom;
    const mainTop = dom.main.getBoundingClientRect().top;
    if (mainTop < headerBottom) window.scrollTo({ top: Math.max(0, window.scrollY + mainTop - headerBottom) });
  }

  /* =========================================================================
   * 8. Search wiring (instant, on every keystroke, coalesced per frame)
   * ======================================================================= */

  function runSearch({ force = false, keepRendered = false } = {}) {
    if (!state.index) return;
    const query = dom.search.value;
    const changed = query !== state.query;
    if (!changed && !force) return;
    state.query = query;

    const ranked = SearchEngine.search(state.index, query);
    state.searching = ranked !== null;
    state.results = ranked || state.index.entries.map((entry) => ({ entry, hits: null }));
    renderGrid({ keep: keepRendered ? state.rendered : 0 });
    updateSummary();
    dom.clear.hidden = !query;
    if (changed) {
      revealResultsTop();
      announceResults();
    }
  }

  let searchFrame = 0;
  function scheduleSearch() {
    if (searchFrame) return;
    searchFrame = requestAnimationFrame(() => {
      searchFrame = 0;
      runSearch();
    });
  }

  function clearSearch({ focus = false } = {}) {
    dom.search.value = '';
    runSearch();
    if (focus) dom.search.focus();
  }

  function initSearch() {
    // Search on every input event, including IME composition: Android keyboards compose each
    // word until a space, so skipping composition would stop live filtering on most phones.
    dom.search.addEventListener('input', () => {
      dom.clear.hidden = !dom.search.value;
      scheduleSearch();
    });
    dom.search.addEventListener('compositionend', scheduleSearch);
    dom.search.addEventListener('keydown', (event) => {
      // Esc during IME composition cancels the conversion; it must not wipe the query.
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      if (dom.search.value) {
        event.preventDefault();
        clearSearch({ focus: true });
      } else {
        dom.search.blur();
      }
    });
    dom.searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runSearch();
      if (coarsePointer.matches) dom.search.blur(); // hide the on-screen keyboard to reveal results
    });
    dom.clear.addEventListener('click', () => clearSearch({ focus: true }));

    // "/" or Ctrl/⌘+K focuses search.
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || Player.isOpen()) return;
      const slash = event.key === '/' && !isEditable(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey;
      const commandK = (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey);
      if (slash || commandK) {
        event.preventDefault();
        dom.search.focus();
        dom.search.select();
      }
    });

    dom.brand.addEventListener('click', (event) => {
      if (isModifiedClick(event)) return;
      event.preventDefault();
      if (dom.search.value) clearSearch();
      window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });

    dom.emptyAction.addEventListener('click', () => {
      if (dom.emptyAction.dataset.action === 'reload') loadCatalog({ userInitiated: true });
      else clearSearch({ focus: true });
    });
  }

  function initGrid() {
    if (sentinelObserver) sentinelObserver.observe(dom.sentinel);
    dom.grid.addEventListener('click', (event) => {
      const link = event.target.closest('.card__link');
      if (!link || event.defaultPrevented || isModifiedClick(event)) return; // let new-tab clicks through
      const item = state.byId.get(link.dataset.id);
      if (!item) return;
      event.preventDefault();
      Player.open(item, link);
    });
  }

  /* =========================================================================
   * 9. Catalog loading (network first, saved copy for instant start-up)
   * ======================================================================= */

  function applyCatalog({ items, skipped }, text, { fromSavedCopy = false } = {}) {
    state.items = items;
    state.byId = new Map(items.map((item) => [item.id, item]));
    state.index = SearchEngine.buildIndex(items, (item) => item.title);

    for (const [id, card] of cardCache) {
      const item = state.byId.get(id);
      if (!item || card.signature !== signatureOf(item)) cardCache.delete(id);
    }
    if (skipped) {
      console.warn(`[mid4Q] Skipped ${skipped} catalog ${skipped === 1 ? 'entry' : 'entries'} without a valid driveFileId.`);
    }

    dom.error.hidden = true;
    dom.grid.removeAttribute('aria-busy');
    runSearch({ force: true, keepRendered: true });
    syncPlayerWithUrl({ final: !fromSavedCopy });
    state.catalogText = text; // set last, so a failed apply is retried by the next load
  }

  async function fetchCatalogText() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), CONFIG.catalogTimeoutMs) : 0;
    try {
      // "no-cache" revalidates with the server, so a refresh always sees the latest catalog.json.
      const response = await fetch(CONFIG.catalogUrl, {
        cache: 'no-cache',
        credentials: 'same-origin',
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        throw new CatalogError(`catalog.json could not be loaded (HTTP ${response.status}). Make sure it sits next to index.html.`);
      }
      const text = await response.text(); // inside the timeout, so a stalled body read is bounded too
      // sw.js sets this header when it had to answer with its cached copy ("offline" or an HTTP status).
      return { text, fallback: response.headers.get('X-Mid4Q-Fallback') };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new CatalogError('Loading catalog.json timed out. Check your connection and try again.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function savedCopyMessage(error) {
    if (error instanceof OfflineError || navigator.onLine === false) return 'You’re offline. Showing your saved lecture list.';
    const detail = error instanceof CatalogError ? `${error.message} ` : '';
    return `${detail}Showing the last saved lecture list.`;
  }

  function setBusy(busy) {
    dom.refresh.classList.toggle('is-busy', busy);
    dom.refresh.setAttribute('aria-busy', String(busy));
    dom.refresh.setAttribute('aria-label', busy ? 'Refreshing lecture list…' : 'Refresh lecture list');
  }

  function loadCatalog({ userInitiated = false } = {}) {
    if (state.loading) return state.loading;
    setBusy(true);
    state.loading = (async () => {
      try {
        const { text, fallback } = await fetchCatalogText();
        if (fallback) {
          // The service worker answered with its cached copy. Show it only if nothing is on screen
          // yet, then take the saved-copy path below (label, toast, refetch once back online).
          if (!state.items) applyCatalog(parseCatalog(text), text, { fromSavedCopy: true });
          throw fallback === 'offline'
            ? new OfflineError('Offline: the service worker answered with its cached catalog.json.')
            : new CatalogError(`catalog.json could not be loaded (HTTP ${fallback}).`);
        }
        const changed = text !== state.catalogText;
        if (changed) {
          applyCatalog(parseCatalog(text), text); // throws on bad JSON → keeps current list
          savedCatalog.write(text);
        }
        state.loadedAt = Date.now();
        state.showingSavedCopy = false;
        updateSummary();
        if (userInitiated) {
          toast(changed ? `Lecture list updated · ${lectureCount(state.items.length)}` : 'You’re up to date.', { tone: 'success' });
        }
      } catch (error) {
        if (!(error instanceof OfflineError) && navigator.onLine !== false) {
          console.warn('[mid4Q] Could not load catalog.json:', error); // offline is expected, not logged
        }
        if (state.items) {
          state.showingSavedCopy = true;
          updateSummary();
          if (userInitiated || !state.loadedAt) toast(savedCopyMessage(error), { tone: 'warn', duration: 5000 });
        } else {
          showError(error);
        }
      } finally {
        setBusy(false);
        state.loading = null;
        if (state.items) syncPlayerWithUrl(); // judges #watch links only once a network catalog is on screen
      }
    })();
    return state.loading;
  }

  /* =========================================================================
   * 10. Pull to refresh (touch devices, at the top of the page)
   * ======================================================================= */

  function initPullToRefresh() {
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
    const indicator = dom.ptr;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let pulling = false;
    let distance = 0;

    const atTop = () => (window.scrollY || document.documentElement.scrollTop) <= 0;

    function setPull(px) {
      distance = px;
      indicator.style.setProperty('--ptr-y', `${px}px`);
      indicator.style.setProperty('--ptr-p', Math.min(1, px / CONFIG.pullThreshold).toFixed(3));
      indicator.classList.toggle('is-armed', px >= CONFIG.pullThreshold);
    }

    function reset() {
      tracking = false;
      pulling = false;
      indicator.classList.remove('is-pulling', 'is-armed', 'is-refreshing');
      setPull(0);
    }

    window.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1 || !atTop() || state.loading || Player.isOpen() || isEditable(event.target)) {
        tracking = false;
        return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
      pulling = false;
    }, { passive: true });

    window.addEventListener('touchmove', (event) => {
      if (!tracking) return;
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (!pulling) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Only a mostly-vertical downward drag that starts at the very top counts.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) {
          tracking = false;
          return;
        }
        pulling = true;
        indicator.classList.add('is-pulling');
      }
      if (!atTop()) {
        reset();
        return;
      }
      setPull(Math.min(CONFIG.pullMax, Math.max(0, dy) * 0.5));
    }, { passive: true });

    window.addEventListener('touchend', async () => {
      if (!pulling) {
        tracking = false;
        return;
      }
      const triggered = distance >= CONFIG.pullThreshold;
      tracking = false;
      pulling = false;
      indicator.classList.remove('is-pulling');
      if (!triggered) {
        reset();
        return;
      }
      indicator.classList.add('is-refreshing');
      setPull(CONFIG.pullThreshold * 0.85);
      try {
        await loadCatalog({ userInitiated: true });
      } finally {
        reset();
      }
    }, { passive: true });

    window.addEventListener('touchcancel', reset, { passive: true });
  }

  /* =========================================================================
   * 11. PWA: service worker, install button, connectivity, header metrics
   * ======================================================================= */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const register = () => {
      navigator.serviceWorker.register('sw.js').catch((error) => {
        console.warn('[mid4Q] Service worker registration failed:', error);
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  function initInstallPrompt() {
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); // show our own Install button instead of the mini-infobar
      deferredPrompt = event;
      dom.install.hidden = false;
    });
    dom.install.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      dom.install.hidden = true;
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch (error) {
        console.warn('[mid4Q] Install prompt failed:', error);
      }
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      dom.install.hidden = true;
      toast('mid4Q is installed. Open it from your home screen or app list.', { tone: 'success' });
    });
  }

  function initConnectivity() {
    window.addEventListener('offline', () => {
      Player.setOffline(true);
      toast('You’re offline. The lecture list stays available, but videos need a connection.', { tone: 'warn', duration: 5000 });
    });
    window.addEventListener('online', () => {
      Player.setOffline(false);
      toast('Back online.', { tone: 'success' });
      if (!state.items || state.showingSavedCopy) loadCatalog();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.items && Date.now() - state.loadedAt > CONFIG.staleAfterMs) {
        loadCatalog();
      }
    });
  }

  function trackHeaderHeight() {
    const update = () => document.documentElement.style.setProperty('--header-h', `${dom.topbar.offsetHeight}px`);
    update();
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(dom.topbar);
    else window.addEventListener('resize', update);
  }

  /* =========================================================================
   * 12. Boot
   * ======================================================================= */

  function init() {
    trackHeaderHeight();
    initSearch();
    initGrid();
    initPullToRefresh();
    initInstallPrompt();
    initConnectivity();
    registerServiceWorker();

    window.addEventListener('popstate', () => {
      Player.onPopState();
      syncPlayerWithUrl();
    });
    window.addEventListener('hashchange', () => syncPlayerWithUrl());

    dom.refresh.addEventListener('click', () => loadCatalog({ userInitiated: true }));
    dom.retry.addEventListener('click', () => {
      showLoading();
      loadCatalog();
    });

    // Instant start-up: paint the last saved catalog right away, then refresh from the network.
    const saved = savedCatalog.read();
    if (saved) {
      try {
        applyCatalog(parseCatalog(saved), saved, { fromSavedCopy: true });
      } catch {
        savedCatalog.clear();
      }
    }
    loadCatalog();
  }

  init();
})();
