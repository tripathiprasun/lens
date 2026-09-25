# LENS

LENS is a small, local file and image forensics utility that runs entirely in your browser. Drop a file in, and it reads the file's signature, hashes, entropy, and (for JPEGs) EXIF metadata — all without sending a single byte anywhere.

## Why it exists

Renamed extensions, stripped metadata, and mystery files are common enough that it's useful to have a quick, trustworthy way to look inside a file before opening it elsewhere. Most tools that do this ask you to upload the file to a server. LENS doesn't, because it doesn't need to — everything a modern browser needs (the File API, Web Crypto, `<canvas>`) is enough to do real inspection client-side.

## Features

- **Signature detection ("magic bytes")** — identifies JPEG, PNG, GIF, WebP, PDF, ZIP, RAR, 7z, GZIP, MP3, MP4, WebM, WAV, EXE/PE, and ELF from the actual file contents, not the extension.
- **Extension mismatch warning** — flags files whose extension doesn't match their detected signature (a common sign of a renamed or disguised file).
- **Hashing** — SHA-256, SHA-384, and SHA-512, computed with `crypto.subtle.digest`, each with a one-click copy button.
- **Shannon entropy** — an approximate randomness score (0–8 bits/byte) with a plain-language note on what it does and doesn't imply.
- **Image analysis** — dimensions, aspect ratio, a lightweight color survey (average color, grayscale/transparency detection), and a live preview.
- **EXIF metadata (JPEG)** — camera make/model, software, timestamp, orientation, exposure, ISO, focal length, and GPS coordinates, parsed directly from the file's TIFF/IFD structure. Metadata is split into a standard section and a "potentially sensitive" section (GPS, device info, timestamps), and GPS coordinates are called out explicitly since they reveal where a photo was taken.
- **Hex viewer** — the first 1024 bytes of the file as a classic offset / hex / ASCII dump, with a copy button.
- **Report export** — a structured `.json` report of everything above, generated and downloaded locally.

## Privacy model

Files are processed locally in your browser and are not uploaded. There is no backend, no database, no accounts, and nothing calling out to a remote API. The only network requests the page itself makes are for its own static assets and a webfont — never for your file. You can confirm this yourself by opening your browser's network tab while using it: nothing appears when you analyze a file.

## How it works

The app is split into two plain JavaScript files with no build step and no framework:

- **`lens-core.js`** — pure logic with no DOM access: signature matching, entropy calculation, hex formatting, and EXIF/TIFF parsing. Every function takes bytes/values in and returns plain data out, which is what makes it possible to unit-test in Node without a browser.
- **`app.js`** — the DOM layer. Reads the dropped/selected file via the File API, calls into `lens-core.js`, computes hashes via Web Crypto, and renders the results.

Large files are read once into an `ArrayBuffer` and that buffer is reused for hashing and entropy, rather than re-reading the file from disk for each. The hex viewer only ever reads the first 1024 bytes, regardless of file size.

## Supported analysis

| Category | What's shown |
|---|---|
| Basic info | name, extension, size, browser-reported MIME type, last modified, detected type |
| Signature | extension vs. detected type, with a match/mismatch/unknown status |
| Hashes | SHA-256, SHA-384, SHA-512 |
| Entropy | Shannon entropy (0–8) with a short explanation |
| Images | width, height, aspect ratio, average color, grayscale/transparency detection, preview |
| Metadata | EXIF fields for JPEGs, split into standard and potentially sensitive |
| Hex view | first 1024 bytes as offset/hex/ASCII |

## Limitations

- **Not a malware scanner.** LENS tells you what a file appears to be and gives you signals (entropy, mismatches) to reason about — it does not scan for known threats or make a safety determination.
- **Not a complete forensic suite.** Chain-of-custody, deep container parsing (e.g. full ZIP/PDF object trees), and format-specific edge cases beyond common ones aren't covered.
- **EXIF parsing is JPEG-only.** PNG (tEXt/eXIf chunks), WebP (EXIF chunk), and other containers can carry metadata too, but aren't parsed yet.
- **Signature detection is intentionally conservative.** If LENS doesn't recognize a format, it says so rather than guessing.
- **Very large files** depend on your browser's available memory, since hashing and entropy both need to read the full file into memory once.

## Running locally

No build step, no dependencies to install for the app itself. Any static file server works:

```bash
cd lens
python3 -m http.server 8080
# then open http://localhost:8080
```

Or just open `index.html` directly in a browser — everything works from the local filesystem too, with the one caveat that some browsers restrict Web Crypto to secure contexts (`https://` or `localhost`), so a local server is the more reliable option.

## Deploying to GitHub Pages

1. Push this `lens/` folder to a GitHub repository (as the repo root, or a subfolder — see below).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch."
4. Choose your default branch and the folder containing `index.html` (`/root` if these files are at the repo root, or `/docs` if you've placed them in a `docs/` folder).
5. Save. GitHub will publish the site at `https://tripathiprasun.github.io/lens/` within a minute or two.

No environment variables, secrets, or build pipeline are needed — it's a static site.

## Example workflow

1. Open LENS.
2. Drop a file.
3. Inspect the detected type and whether it matches the extension.
4. Review the hashes and metadata.
5. Export the report.

## Running the tests

The pure logic in `lens-core.js` has a Node-based test suite (no dependencies beyond Node's built-in `node:test` and `node:assert`):

```bash
node --test tests/lens-core.test.js
```

It covers known signatures, an unknown signature, extension/signature mismatches, hash-adjacent helpers, entropy at both extremes, hex-dump formatting, and malformed/truncated EXIF input.
