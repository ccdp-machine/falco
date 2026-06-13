# 🔊 Web Screen Reader

A browser-based screen reader that reads things out loud using the Web Speech
API. It combines four reading modes in one app:

| Mode | What it does | How |
|---|---|---|
| **Text** | Reads typed/pasted text, your clipboard, or a text file, highlighting each word as it's spoken | Web Speech API + Clipboard API |
| **Web Page** | Fetches any URL, extracts the readable article, and reads it | Node proxy + Mozilla Readability |
| **Navigator** | Keyboard-driven element-by-element navigation of loaded pages, announcing roles ("heading level 2: …") like NVDA/VoiceOver | DOM walker + TTS |
| **Screen OCR** | Captures your screen/window/tab, recognizes the text on it locally, and reads it | `getDisplayMedia` + Tesseract.js |

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

## Architecture

```
server.js            Express: serves /public, /api/page fetches a URL and
                     extracts readable content with Readability (CORS proxy)
public/
  index.html         Single page, three tab panels
  js/speech.js       TTS engine: voice/rate/pitch, sentence chunking,
                     word-boundary highlighting, pause/resume
  js/navigator.js    Screen-reader-style keyboard navigation of loaded content
  js/ocr.js          Screen capture (getDisplayMedia) + Tesseract.js OCR
  js/main.js         UI wiring, tabs, sanitization of fetched HTML
```

Notes:

- OCR runs entirely in your browser; captured frames are never uploaded.
  Tesseract.js is lazy-loaded from a CDN on first use.
- Fetched page HTML is sanitized client-side (scripts, styles, event
  handlers, and `javascript:` URLs are stripped) before being rendered.
- Long texts are spoken in sentence chunks to work around browsers cutting
  off long utterances.
