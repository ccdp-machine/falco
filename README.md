# 🔊 Web Screen Reader

A browser-based screen reader that reads things out loud using the Web Speech
API. It combines four reading modes in one app:

| Mode | What it does | How |
|---|---|---|
| **Text** | Reads typed/pasted text, your clipboard, or a text file, highlighting each word as it's spoken | Web Speech API + Clipboard API |
| **Web Page** | Fetches any URL, extracts the readable article, and reads it | Node proxy + Mozilla Readability |
| **Navigator** | Element-by-element navigation of loaded pages, announcing roles ("heading level 2: …") like NVDA/VoiceOver — keyboard or touch toolbar | DOM walker + TTS |
| **Screen OCR** | Captures your screen/window/tab (desktop), or a photo/screenshot you pick (any device), recognizes the text locally, and reads it | `getDisplayMedia` or file input + Tesseract.js |

It's also installable as a PWA and works from a bookmarklet — see below.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Requires Node 18+. Use a Chromium-based browser or Firefox for best results
(speech synthesis voices and screen capture support vary by browser/OS).

## Keyboard reference

Global: `Esc` stop · `p` pause/resume.

In the web page navigator (focus the article first):

| Key | Action |
|---|---|
| `↓` / `↑` | Next / previous element |
| `h` / `Shift+h` | Next / previous heading |
| `k` / `Shift+k` | Next / previous link |
| `Home` / `End` | First / last element |
| `Enter` | Open current link |
| `Space` | Repeat current element |

A touch toolbar under the article (⏮ First · ◀ Prev · Next ▶ · ◀ H · H ▶ · 🔁 Repeat) drives the
same moves for touchscreens without a physical keyboard.

## iPhone / Chrome on iOS

Chrome on iOS is WebKit under the hood: it has **no extension support** and **no
`getDisplayMedia`** (screen capture), so the desktop workflow doesn't fully carry over. Two
things fill the gap:

- **Install it as a PWA.** Open the site in Safari or Chrome, tap **Share → Add to Home Screen**.
  It launches full-screen with its own icon, using `public/manifest.webmanifest` and
  `public/sw.js` (a service worker that precaches the app shell for fast/offline loads).
- **Use the bookmarklet.** Visit [`/bookmarklet.html`](public/bookmarklet.html) for a
  self-contained "Read Aloud" bookmark you can install via Share → Add Bookmark. Since Chrome iOS
  has no extensions, this is the closest thing to a "plugin" — tapping it injects a floating,
  shadow-DOM reader widget into whatever page you're on (works in Safari too).

Mode notes on iPhone:

- **Screen OCR** works from a **photo or screenshot** instead of live capture: use "📷 Read a
  photo or screenshot" in the OCR tab. Live screen capture stays desktop-only (the capture button
  is hidden, not just disabled, when `getDisplayMedia` isn't available).
- **Web Page** navigation works via the touch toolbar described above.
- **Text** and the bookmarklet's reader both work identically to desktop.

## Architecture

```
server.js            Express: serves /public, /api/page fetches a URL and
                     extracts readable content with Readability (CORS proxy)
public/
  index.html         Single page, three tab panels
  bookmarklet.html    Explains + builds the "Read Aloud" bookmarklet from reader.js
  reader.js           Self-contained bookmarklet reader (no ES modules, no deps)
  manifest.webmanifest, sw.js, icons/   PWA support
  js/speech.js       TTS engine: voice/rate/pitch, sentence chunking,
                     word-boundary highlighting, pause/resume
  js/navigator.js    Screen-reader-style navigation of loaded content
                     (keyboard + public methods for the touch toolbar)
  js/ocr.js          Screen capture (getDisplayMedia) + Tesseract.js OCR
  js/main.js         UI wiring, tabs, sanitization of fetched HTML, SW registration
```

Notes:

- OCR runs entirely in your browser; captured frames/photos are never uploaded.
  Tesseract.js is lazy-loaded from a CDN on first use.
- Fetched page HTML is sanitized client-side (scripts, styles, event
  handlers, and `javascript:` URLs are stripped) before being rendered.
- Long texts are spoken in sentence chunks to work around browsers cutting
  off long utterances.
