// Web Screen Reader bookmarklet: a self-contained, dependency-free reader
// that can be injected into ANY page (e.g. via a bookmarklet on Chrome for
// iPhone, which supports neither extensions nor screen capture). It has its
// own minimal copies of the sentence-chunked speech logic and element
// navigation used by the main app, plus a floating shadow-DOM widget.
//
// Not an ES module on purpose: it is meant to be eval()'d from a
// javascript: bookmarklet URL, so it must run as a plain classic script.
(function () {
  'use strict';

  // Running it twice (clicking the bookmark again) toggles the widget off.
  if (window.__wsrInjected) {
    window.__wsrInjected = false;
    var already = document.getElementById('__wsr-host');
    if (already) already.remove();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    return;
  }
  window.__wsrInjected = true;

  var synth = window.speechSynthesis;
  var rate = 1.0;
  var state = 'stopped'; // 'stopped' | 'speaking' | 'paused'
  var elements = [];
  var queue = [];
  var queueIndex = 0;
  var index = -1;
  var prevOutlineEl = null;
  var prevOutlineValue = null;

  var NAV_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, a[href], img[alt], blockquote, pre, td, th';

  // ------------------------------------------------------------- widget

  var host = document.createElement('div');
  host.id = '__wsr-host';
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.right = '0';
  host.style.bottom = '0';
  host.style.zIndex = '2147483647';
  document.documentElement.appendChild(host);

  // Shadow DOM keeps the host page's CSS from leaking in (or our styles
  // from leaking out).
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent =
    ':host { all: initial; }' +
    '.bar { all: initial; box-sizing: border-box; display: flex; flex-wrap: wrap;' +
    ' align-items: center; justify-content: center; gap: 6px; width: 100%;' +
    ' padding: 8px; font-family: -apple-system, system-ui, sans-serif;' +
    ' background: #0f1419; border-top: 1px solid #34404f;' +
    ' box-shadow: 0 -2px 14px rgba(0,0,0,.45); }' +
    'button { all: initial; box-sizing: border-box; font-family: inherit; font-size: 14px;' +
    ' color: #e6edf3; background: #232d3a; border: 1px solid #34404f; border-radius: 6px;' +
    ' padding: 8px 10px; min-height: 40px; cursor: pointer; text-align: center; }' +
    'button:active { background: #2c3947; }' +
    '.speed { color: #9aa7b4; font-size: 13px; min-width: 40px; text-align: center;' +
    ' font-family: inherit; }';
  root.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 'bar';
  root.appendChild(bar);

  function makeButton(label, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    bar.appendChild(b);
    return b;
  }

  var readBtn = makeButton('▶ Read page', 'Read from here (or the whole page)');
  var pauseBtn = makeButton('⏸', 'Pause / resume');
  var stopBtn = makeButton('⏹', 'Stop');
  var prevBtn = makeButton('◀', 'Previous element');
  var nextBtn = makeButton('▶', 'Next element');
  var prevHBtn = makeButton('H-', 'Previous heading');
  var nextHBtn = makeButton('H+', 'Next heading');
  var slowerBtn = makeButton('speed −', 'Slower');
  var speedLabel = document.createElement('span');
  speedLabel.className = 'speed';
  bar.appendChild(speedLabel);
  var fasterBtn = makeButton('speed +', 'Faster');
  var closeBtn = makeButton('✕', 'Close reader');

  function updateSpeedLabel() {
    speedLabel.textContent = rate.toFixed(1) + '×';
  }
  function updateButtons() {
    pauseBtn.textContent = state === 'paused' ? '▶' : '⏸';
  }
  updateSpeedLabel();
  updateButtons();

  // ------------------------------------------------------- element list

  function isVisible(el) {
    // offsetParent is null for display:none / detached elements; fixed-
    // position elements are the one case that's still visible with a null
    // offsetParent, so they get a pass too.
    return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  }

  function buildElements() {
    var container = document.querySelector('article') || document.querySelector('main') || document.body;
    var found = container.querySelectorAll(NAV_SELECTOR);
    elements = [];
    for (var i = 0; i < found.length; i += 1) {
      var el = found[i];
      if (host.contains(el)) continue;
      if (!isVisible(el)) continue;
      elements.push(el);
    }
  }

  function elementText(el) {
    return (el.textContent || '').trim();
  }

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return { role: 'heading level ' + tag[1], text: elementText(el) };
    switch (tag) {
      case 'a':
        return { role: 'link', text: elementText(el) || el.href };
      case 'img':
        return { role: 'image', text: el.getAttribute('alt') || 'no description' };
      case 'li':
        return { role: 'list item', text: elementText(el) };
      case 'blockquote':
        return { role: 'quote', text: elementText(el) };
      case 'pre':
        return { role: 'code block', text: elementText(el) };
      case 'th':
        return { role: 'column header', text: elementText(el) };
      case 'td':
        return { role: 'table cell', text: elementText(el) };
      default:
        return { role: '', text: elementText(el) };
    }
  }

  function isHeadingEl(el) {
    return /^H[1-6]$/.test(el.tagName);
  }

  function highlight(el) {
    if (prevOutlineEl) {
      if (prevOutlineValue) prevOutlineEl.style.outline = prevOutlineValue;
      else prevOutlineEl.style.removeProperty('outline');
      prevOutlineEl.style.removeProperty('outline-offset');
    }
    prevOutlineEl = el;
    prevOutlineValue = el.style.outline || '';
    el.style.outline = '3px solid #ffd54d';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ------------------------------------------------------------- speech

  function announceMessage(el, onEnd) {
    var d = describe(el);
    var msg = d.role ? d.role + ': ' + d.text : d.text;
    highlight(el);
    synth.cancel();
    var u = new SpeechSynthesisUtterance(msg || '(empty)');
    u.rate = rate;
    u.onend = onEnd || null;
    synth.speak(u);
  }

  function announceCurrent() {
    if (index < 0 || index >= elements.length) return;
    state = 'speaking';
    updateButtons();
    announceMessage(elements[index], function () {
      state = 'stopped';
      updateButtons();
    });
  }

  function move(step, predicate) {
    if (!elements.length) return;
    var i = index;
    for (var n = 0; n < elements.length; n += 1) {
      i += step;
      if (i < 0 || i >= elements.length) return;
      if (!predicate || predicate(elements[i])) {
        index = i;
        announceCurrent();
        return;
      }
    }
  }

  // "Read page": speaks the remaining elements (from the current position,
  // or the whole page if nothing is selected yet) as a chunked queue,
  // highlighting and advancing one element per utterance.
  function readPage() {
    buildElements();
    if (!elements.length) return;
    var start = index >= 0 ? index : 0;
    queue = elements.slice(start);
    queueIndex = 0;
    index = start - 1;
    state = 'speaking';
    updateButtons();
    playQueue();
  }

  function playQueue() {
    if (state !== 'speaking' || queueIndex >= queue.length) {
      state = queueIndex >= queue.length ? 'stopped' : state;
      updateButtons();
      return;
    }
    index += 1;
    var el = queue[queueIndex];
    var d = describe(el);
    var msg = d.role ? d.role + ': ' + d.text : d.text;
    highlight(el);
    var u = new SpeechSynthesisUtterance(msg || '(empty)');
    u.rate = rate;
    u.onend = function () {
      if (state !== 'speaking') return; // stopped/paused mid-queue
      queueIndex += 1;
      playQueue();
    };
    synth.speak(u);
  }

  function stopAll() {
    synth.cancel();
    state = 'stopped';
    queue = [];
    queueIndex = 0;
    updateButtons();
  }

  function togglePause() {
    if (state === 'speaking') {
      synth.pause();
      state = 'paused';
    } else if (state === 'paused') {
      synth.resume();
      state = 'speaking';
    }
    updateButtons();
  }

  // --------------------------------------------------------- interaction

  // Handlers call speechSynthesis synchronously (no awaited work first) so
  // the very first utterance still counts as triggered by the user gesture,
  // which iOS requires.
  readBtn.addEventListener('click', readPage);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopAll);
  prevBtn.addEventListener('click', function () {
    if (!elements.length) buildElements();
    move(-1);
  });
  nextBtn.addEventListener('click', function () {
    if (!elements.length) buildElements();
    move(1);
  });
  prevHBtn.addEventListener('click', function () {
    if (!elements.length) buildElements();
    move(-1, isHeadingEl);
  });
  nextHBtn.addEventListener('click', function () {
    if (!elements.length) buildElements();
    move(1, isHeadingEl);
  });
  slowerBtn.addEventListener('click', function () {
    rate = Math.max(0.5, Math.round((rate - 0.1) * 10) / 10);
    updateSpeedLabel();
  });
  fasterBtn.addEventListener('click', function () {
    rate = Math.min(3, Math.round((rate + 0.1) * 10) / 10);
    updateSpeedLabel();
  });
  closeBtn.addEventListener('click', function () {
    synth.cancel();
    if (prevOutlineEl) {
      if (prevOutlineValue) prevOutlineEl.style.outline = prevOutlineValue;
      else prevOutlineEl.style.removeProperty('outline');
      prevOutlineEl.style.removeProperty('outline-offset');
    }
    host.remove();
    window.__wsrInjected = false;
  });

  buildElements();
})();
