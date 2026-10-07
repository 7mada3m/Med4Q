# mid4Q

A fast, installable (PWA) lecture library that streams medical lecture videos from Google Drive. It is plain HTML, CSS and JavaScript with no build step and no dependencies, so it can be hosted free on GitHub Pages.

## Files

```
index.html            App shell: header, grid, player dialog, card template
style.css             Dark, mobile-first responsive UI
app.js                Catalog loading, fuzzy search, rendering, player, PWA wiring
catalog.json          Your lecture list (the only file you normally edit)
sw.js                 Service worker: offline app shell + last loaded catalog
manifest.webmanifest  PWA metadata (name, colours, icons)
icons/                App icons (SVG sources and rendered PNGs)
.nojekyll             Tells GitHub Pages to serve the files as-is
```

## Adding lectures

1. Upload the video to Google Drive, then **Share → General access → Anyone with the link (Viewer)**.
2. Copy the link. It looks like `https://drive.google.com/file/d/FILE_ID/view?usp=sharing`. The file ID is the part between `/d/` and `/view`.
3. Add an entry to `catalog.json`:

```json
{
  "id": "vid_03",
  "title": "Cardiology - Heart Failure Management",
  "driveFileId": "FILE_ID",
  "thumbnailUrl": "https://drive.google.com/thumbnail?id=FILE_ID&sz=w640"
}
```

- `id` should be unique. It becomes the shareable link `…/#watch=vid_03`.
- `thumbnailUrl` is optional. When it is missing, the Drive thumbnail is used.
- Pasting the full share link into `driveFileId` also works; the ID is extracted automatically.
- Titles written as `Subject - Topic` (or `Subject: Topic`) show the subject as a small label above the topic.

The two entries in the sample `catalog.json` use placeholder IDs. Their thumbnails show a fallback graphic, and the player shows Google's "file does not exist" page until you replace them with real file IDs.

## Run locally

Browsers block `fetch()` for pages opened straight from disk, so serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages (free)

1. Create a GitHub repository and push these files to the `main` branch, at the repository root.
2. In the repository, open **Settings → Pages → Build and deployment**. Set **Source: Deploy from a branch**, choose **main** and **/ (root)**, then click **Save**.
3. After about a minute the app is live at `https://<user>.github.io/<repo>/`.

To publish new lectures, edit `catalog.json` and push. Users get the new list the next time they open the app, or straight away with **Refresh** or pull-to-refresh. All paths are relative, so the app works from any repository name. If you change the file lists in `sw.js`, bump `CACHE_VERSION`.

## Search

- Every word must match, in any order: `pharma renal 1`.
- Partial words match: `glomer`.
- Typos are tolerated: 1 per word of up to 6 letters, 2 for longer words (`glomerulonefritis`). A swap of two neighbouring letters counts as one typo.
- Numbers must match exactly, and words of 1–2 characters never tolerate typos, so `renal 1` does not show `renal 10` or `renal 2`.
- Small words like "of" and "the" are optional: `anatomy of the heart` finds "Heart Anatomy".
- Accents and Arabic diacritics are ignored.
- Press `/` or `Ctrl`/`⌘`+`K` to focus the search box. `Esc` clears it.

## Notes and limitations

- **Esc in the player.** Esc closes the player unless keyboard focus is inside the Google Drive player. A cross-origin iframe receives its own key presses, which the page cannot intercept. The × button and clicking outside the video always work.
- **Large downloads.** For files over 100 MB, Google first shows a "can't scan this file for viruses" page. Choose **Download anyway**.
- **Drive limits.** Files must be shared publicly, or the player shows "You need access". Very popular files can temporarily hit Google's view or download quotas.
- **Thumbnails.** Drive generates thumbnails after a video finishes processing. Until then a placeholder graphic is shown.
