# mid4Q

A dependency-free, single-page medical lecture app for GitHub Pages. No build step, API key, backend, or paid service is required by the app.

## Run locally

From this directory, run `python3 -m http.server 8080` and visit `http://localhost:8080/`. Opening index.html with a file:// URL will not work with fetch or PWA installation.

## Add your videos

The two catalog entries are example data: search and layout work immediately, but the example Drive IDs do not point to playable videos. Replace their driveFileId values and thumbnail IDs with your own files.

1. Upload each lecture to Google Drive and wait for video processing to finish.
2. In Share, choose General access → Anyone with the link → Viewer.
3. Keep downloads enabled if students should download the lecture.
4. Copy the ID between `/d/` and the next `/` in its Drive URL.
5. Set a unique id and a title in catalog.json. Keep driveFileId to the file ID only.
6. Set thumbnailUrl to `https://drive.google.com/thumbnail?id=FILE_ID&sz=w640` or another public HTTPS image URL. Invalid or unavailable thumbnails get a built-in fallback.

Verify your real videos using an incognito browser so viewers can open them without signing in.

## Publish free on GitHub Pages

1. Create a public GitHub repository, for example mid4Q.
2. Upload the contents of this folder to the repository root, including icons/, manifest.webmanifest, sw.js, and .nojekyll. index.html must be at the root of the selected publishing folder.
3. Open Settings → Pages → Build and deployment.
4. Choose Deploy from a branch, select main and /(root), then Save.
5. Open the HTTPS URL shown by GitHub Pages after deployment finishes.

All paths are relative, so both username.github.io/mid4Q/ and a custom domain work. Free GitHub Pages requires a public repository. Keep the large video files on Drive rather than committing them to GitHub.

## Search and performance

Search requires every query token to match a title word, regardless of order. Prefix matching lets “pharma renal 1” find “Pharmacology - Renal Drugs Lecture 1”. A bounded Levenshtein comparison allows one edit for query words up to six characters, and two for longer words. Numeric tokens match exactly to keep lecture numbers distinct. Accents, punctuation, case, and repeated query words are normalized.

Titles are indexed once per catalog refresh in a trie, so words sharing a prefix reuse the same Levenshtein work. Repeated token matches are cached. Rendering is coalesced with requestAnimationFrame, thumbnails load lazily, and cards are added in batches of 48. The Show more lectures button works without IntersectionObserver; supported browsers also append cards automatically near the end of the feed.

## PWA and offline behavior

The manifest and 192/512 PNG icons support installation in compatible browsers. An Install app button appears when the browser offers an install prompt; otherwise use the browser's installation or Add to Home Screen menu.

After a successful online visit and service-worker installation, the shell and last successfully validated catalog can open offline. Drive video playback needs internet. The download link opens Google's download flow in a new tab; it does not automatically save videos into the PWA or cache them for playback. Open completed video downloads with a local player.

Catalog requests always attempt the network with HTTP caching disabled. A network failure can fall back to the saved catalog. A failed refresh preserves the current catalog. Caching is optional: the app still works online if browser storage is disabled or unavailable.

When changing index.html, style.css, app.js, the manifest, or icons, increment VERSION in sw.js and commit it with the changed files. The waiting worker activates after all existing app tabs/windows close, keeping HTML and scripts on the same shell version. Catalog-only edits need no service-worker version change; use Refresh after Pages has deployed them.

## Drive behavior

The player embeds only `https://drive.google.com/file/d/FILE_ID/preview`. There is no HTML5 video element or attempt to bypass Google's virus-scan confirmation. Downloads use `https://drive.google.com/uc?export=download&id=FILE_ID`.

Drive controls file processing, playback availability, sharing permissions, download confirmation, and traffic limits. An iframe loading does not prove that a video can play, so the modal includes an Open in Google Drive fallback. Because the embedded player is cross-origin, the app cannot inspect its playback state or persist its watch position.

The native dialog supports keyboard focus containment, Escape dismissal, focus restoration, backdrop dismissal, and immediate iframe removal on close. Buttons have accessible labels, reduced-motion preferences are respected, and all catalog text is inserted with textContent.

## Verification

JavaScript syntax, fuzzy-search distance comparisons and catalog validation, rendering batches, refresh failure preservation, modal cleanup and links, manifest assets, and offline cache routing were checked locally. Real Drive playback still needs real public file IDs. No account or deployment was created by generating this package.
