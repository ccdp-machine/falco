import { SpeechEngine } from './speech.js';
import { ContentNavigator } from './navigator.js';
import { isCaptureSupported, captureScreenFrame, recognizeText } from './ocr.js';

const $ = (sel) => document.querySelector(sel);

const speech = new SpeechEngine();
const statusEl = $('#status');

function setStatus(message) {
  statusEl.textContent = message;
}

// ---------------------------------------------------------------- toolbar

const voiceSelect = $('#voice');
document.addEventListener('voicesloaded', (e) => {
  voiceSelect.innerHTML = '';
  for (const voice of e.detail) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    option.selected = voice === speech.voice;
    voiceSelect.appendChild(option);
  }
});
voiceSelect.addEventListener('change', () => speech.setVoice(voiceSelect.value));

$('#rate').addEventListener('input', (e) => {
  speech.rate = parseFloat(e.target.value);
  $('#rate-value').textContent = `${speech.rate.toFixed(1)}×`;
});
$('#pitch').addEventListener('input', (e) => {
  speech.pitch = parseFloat(e.target.value);
  $('#pitch-value').textContent = speech.pitch.toFixed(1);
});

const playBtn = $('#play');
const pauseBtn = $('#pause');
const stopBtn = $('#stop');

speech.onStateChange = (state) => {
  playBtn.disabled = state === 'speaking';
  pauseBtn.disabled = state === 'stopped';
  pauseBtn.textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
  stopBtn.disabled = state === 'stopped';
};
speech.onStateChange('stopped');

pauseBtn.addEventListener('click', () => speech.togglePause());
stopBtn.addEventListener('click', () => speech.stop());
playBtn.addEventListener('click', () => readCurrentTab());

// ------------------------------------------------------------------ tabs

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
let activeTab = 'text';

function selectTab(name) {
  activeTab = name;
  speech.stop();
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (dir) {
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      next.focus();
      selectTab(next.dataset.tab);
    }
  });
});

// ----------------------------------------------------------- text reader

const textInput = $('#text-input');
const textDisplay = $('#text-display');

// Reads plain text, mirroring it into a display element where the word
// being spoken is highlighted.
function readPlainText(text) {
  if (!text.trim()) {
    setStatus('Nothing to read.');
    return;
  }
  textDisplay.textContent = '';
  textDisplay.hidden = false;
  textInput.hidden = true;

  const before = document.createTextNode('');
  const mark = document.createElement('mark');
  const after = document.createTextNode(text);
  textDisplay.append(before, mark, after);

  speech.speak(text, {
    onWord: (charIndex, word) => {
      before.textContent = text.slice(0, charIndex);
      mark.textContent = word;
      after.textContent = text.slice(charIndex + word.length);
    },
    onEnd: () => {
      textDisplay.hidden = true;
      textInput.hidden = false;
      setStatus('Finished reading.');
    },
  });
  setStatus('Reading…');
}

$('#read-text').addEventListener('click', () => readPlainText(textInput.value));

$('#paste-clipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus('Clipboard is empty.');
      return;
    }
    textInput.value = text;
    setStatus('Clipboard pasted. Press Read to listen.');
  } catch {
    setStatus('Clipboard access was denied. Paste manually with Ctrl+V.');
  }
});

$('#open-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then((text) => {
    textInput.value = text;
    setStatus(`Loaded ${file.name}. Press Read to listen.`);
  });
});

speech.onStateChange = ((original) => (state) => {
  original(state);
  if (state === 'stopped' && textDisplay && !textDisplay.hidden && !speech.speaking) {
    textDisplay.hidden = true;
    textInput.hidden = false;
  }
})(speech.onStateChange);

// ------------------------------------------------------- web page reader

const articleEl = $('#article');
const navigator_ = new ContentNavigator(articleEl, speech, setStatus);

// Strips scripts, styles, event handlers and javascript: URLs from
// server-extracted article HTML before inserting it into the page.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc
    .querySelectorAll('script, style, iframe, object, embed, link, meta, form')
    .forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if (
        (name === 'href' || name === 'src') &&
        attr.value.trim().toLowerCase().startsWith('javascript:')
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

let currentArticleText = '';

async function loadPage() {
  const url = $('#url-input').value.trim();
  if (!url) return;
  setStatus('Fetching page…');
  articleEl.innerHTML = '<p>Loading…</p>';

  try {
    const res = await fetch(`/api/page?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch page.');

    articleEl.innerHTML = '';
    const h1 = document.createElement('h1');
    h1.textContent = data.title;
    articleEl.appendChild(h1);
    if (data.byline) {
      const p = document.createElement('p');
      p.className = 'byline';
      p.textContent = data.byline;
      articleEl.appendChild(p);
    }
    const body = document.createElement('div');
    body.innerHTML = sanitizeHtml(data.content);
    articleEl.appendChild(body);

    currentArticleText = `${data.title}. ${data.byline ? data.byline + '. ' : ''}${data.textContent}`;
    navigator_.refresh();
    articleEl.focus();
    const wordCount = data.textContent.split(/\s+/).length;
    setStatus(
      `Loaded "${data.title}" (about ${wordCount} words). ` +
        'Use arrow keys to navigate, or press Play to read it all.'
    );
    speech.announce(`Loaded ${data.title}. Use arrow keys to navigate.`);
  } catch (err) {
    articleEl.innerHTML = '';
    currentArticleText = '';
    setStatus(err.message);
    speech.announce(err.message);
  }
}

$('#load-page').addEventListener('click', loadPage);
$('#url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadPage();
});

// Touch toolbar: same moves as the keyboard shortcuts, for devices without
// a physical keyboard (e.g. Chrome on iPhone). Re-focusing the article
// keeps keyboard navigation working seamlessly afterwards.
function wireTouchNav(id, action) {
  $(id).addEventListener('click', () => {
    articleEl.focus();
    action();
  });
}
wireTouchNav('#nav-first', () => navigator_.first());
wireTouchNav('#nav-prev', () => navigator_.prev());
wireTouchNav('#nav-next', () => navigator_.next());
wireTouchNav('#nav-prev-heading', () => navigator_.prevHeading());
wireTouchNav('#nav-next-heading', () => navigator_.nextHeading());
wireTouchNav('#nav-repeat', () => navigator_.repeat());

// --------------------------------------------------------------- screen OCR

const ocrOutput = $('#ocr-output');
const captureBtn = $('#capture');
const ocrUpload = $('#ocr-upload');
const ocrHint = $('#ocr-hint');

if (!isCaptureSupported()) {
  // Hidden, not disabled: iOS Chrome has no getDisplayMedia at all, so the
  // button would never work there — showing a photo/screenshot path instead.
  captureBtn.hidden = true;
  ocrHint.textContent =
    "Screen capture isn't available on this device. Use \"Read a photo or screenshot\" " +
    'below instead — take a screenshot or photo, then pick it to have the text read aloud.';
}

// Shared by both the screen-capture and photo-upload paths: runs OCR on an
// image source (canvas or <img>) and speaks the result.
async function runOcr(image) {
  try {
    setStatus('Recognizing text…');
    const text = await recognizeText(image, (p) => {
      setStatus(`Recognizing text… ${Math.round(p * 100)}%`);
    });
    if (!text) {
      setStatus('No text found in the image.');
      speech.announce('No text found.');
      return;
    }
    ocrOutput.value = text;
    setStatus('Text recognized. Reading…');
    speech.speak(text, { onEnd: () => setStatus('Finished reading.') });
  } catch (err) {
    setStatus(err.message || 'Text recognition failed.');
  }
}

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  try {
    setStatus('Choose a screen, window or tab to read…');
    const frame = await captureScreenFrame();
    await runOcr(frame);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      setStatus('Screen capture was cancelled.');
    } else {
      setStatus(err.message || 'Screen capture failed.');
    }
  } finally {
    captureBtn.disabled = false;
  }
});

ocrUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file next time
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    runOcr(img).finally(() => URL.revokeObjectURL(url));
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Could not load that image.');
  };
  img.src = url;
});

$('#read-ocr').addEventListener('click', () => {
  speech.speak(ocrOutput.value, { onEnd: () => setStatus('Finished reading.') });
});

// ------------------------------------------------------------- play action

function readCurrentTab() {
  if (activeTab === 'text') {
    readPlainText(textInput.value);
  } else if (activeTab === 'web') {
    if (!currentArticleText) {
      setStatus('Load a page first.');
      return;
    }
    speech.speak(currentArticleText, { onEnd: () => setStatus('Finished reading.') });
    setStatus('Reading page…');
  } else if (activeTab === 'ocr') {
    if (!ocrOutput.value.trim()) {
      setStatus('Capture the screen first.');
      return;
    }
    speech.speak(ocrOutput.value, { onEnd: () => setStatus('Finished reading.') });
    setStatus('Reading…');
  }
}

// ------------------------------------------------------- global shortcuts

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') speech.stop();
  if (e.key === 'p' && !e.ctrlKey && !e.metaKey) speech.togglePause();
});

if (!SpeechEngine.isSupported()) {
  setStatus('This browser does not support speech synthesis.');
  playBtn.disabled = true;
}

// ------------------------------------------------------------- deep links

// Lets the app be opened pre-loaded with shared content via query params:
//   ?url=https://…   load and read a page
//   ?text=…          read raw text
// This is the web-only bridge to the iOS share sheet: an iOS Shortcut named
// "Read Aloud" can take the shared page/text and open this app with it. iOS
// blocks speech from starting without a user gesture, so we pre-load and
// prompt for a single Play tap rather than promising true auto-play.
function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const sharedUrl = params.get('url');
  const sharedText = params.get('text');
  const tapHint = ' If you hear nothing, tap ▶ Play (iOS needs one tap to start audio).';

  if (sharedUrl) {
    selectTab('web');
    $('#url-input').value = sharedUrl;
    loadPage().then(() => {
      if (currentArticleText) {
        speech.speak(currentArticleText, { onEnd: () => setStatus('Finished reading.') });
        setStatus('Reading shared page…' + tapHint);
      }
    });
  } else if (sharedText) {
    selectTab('text');
    $('#text-input').value = sharedText;
    readPlainText(sharedText);
    setStatus('Reading shared text…' + tapHint);
  }
}

// --------------------------------------------------------------- PWA setup

// Registers the service worker so the app can be installed (Add to Home
// Screen) and opens instantly offline. Feature-detected because Safari/old
// browsers may lack it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

handleDeepLink();
