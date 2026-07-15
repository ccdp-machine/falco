// Accessibility navigator: keyboard-driven element-by-element navigation of
// loaded content, announcing each element with its role — the way a desktop
// screen reader (NVDA, Orca, VoiceOver) walks a page.
//
// Keys (while the reading panel has focus):
//   ↓ / ↑        next / previous element
//   h / Shift+h  next / previous heading
//   k / Shift+k  next / previous link
//   Home / End   first / last element
//   Enter        activate current link
//   Space        re-read current element
//
// The same moves are exposed as public methods (next/prev/nextHeading/
// prevHeading/first/repeat) so a touch toolbar can drive the navigator
// identically to the keyboard.

const NAVIGABLE_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, li, a[href], img[alt], blockquote, figcaption, th, td, pre';

const isHeading = (el) => /^H[1-6]$/.test(el.tagName);
const isLink = (el) => el.tagName === 'A';

export class ContentNavigator {
  constructor(container, speech, statusCallback) {
    this.container = container;
    this.speech = speech;
    this.status = statusCallback || (() => {});
    this.elements = [];
    this.index = -1;

    this.container.addEventListener('keydown', (e) => this.#onKeydown(e));
  }

  // Re-scan the container after new content is loaded.
  refresh() {
    this.elements = [...this.container.querySelectorAll(NAVIGABLE_SELECTOR)].filter(
      (el) => this.#describe(el).text || el.tagName === 'IMG'
    );
    this.index = -1;
  }

  // ------------------------------------------------------- public moves

  next() {
    this.#move(1);
  }

  prev() {
    this.#move(-1);
  }

  nextHeading() {
    this.#move(1, isHeading);
  }

  prevHeading() {
    this.#move(-1, isHeading);
  }

  first() {
    this.#jumpTo(0);
  }

  repeat() {
    if (this.index >= 0) this.#announce(this.elements[this.index]);
  }

  #describe(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return { role: `heading level ${tag[1]}`, text: el.textContent.trim() };
    }
    switch (tag) {
      case 'a':
        return { role: 'link', text: el.textContent.trim() || el.href };
      case 'img':
        return { role: 'image', text: el.getAttribute('alt') || 'no description' };
      case 'li':
        return { role: 'list item', text: el.textContent.trim() };
      case 'blockquote':
        return { role: 'quote', text: el.textContent.trim() };
      case 'figcaption':
        return { role: 'caption', text: el.textContent.trim() };
      case 'pre':
        return { role: 'code block', text: el.textContent.trim() };
      case 'th':
        return { role: 'column header', text: el.textContent.trim() };
      case 'td':
        return { role: 'table cell', text: el.textContent.trim() };
      default:
        return { role: '', text: el.textContent.trim() };
    }
  }

  #announce(el) {
    const { role, text } = this.#describe(el);
    const message = role ? `${role}: ${text}` : text;
    this.status(message);
    this.speech.announce(message);

    this.container
      .querySelectorAll('.nav-current')
      .forEach((n) => n.classList.remove('nav-current'));
    el.classList.add('nav-current');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  #move(step, predicate = null) {
    if (!this.elements.length) {
      this.speech.announce('No content loaded.');
      return;
    }
    let i = this.index;
    for (let n = 0; n < this.elements.length; n += 1) {
      i += step;
      if (i < 0 || i >= this.elements.length) {
        this.speech.announce(step > 0 ? 'End of content.' : 'Start of content.');
        return;
      }
      if (!predicate || predicate(this.elements[i])) {
        this.index = i;
        this.#announce(this.elements[i]);
        return;
      }
    }
  }

  #jumpTo(index) {
    if (!this.elements.length) return;
    this.index = index;
    this.#announce(this.elements[this.index]);
  }

  #onKeydown(e) {
    const actions = {
      ArrowDown: () => this.next(),
      ArrowUp: () => this.prev(),
      h: () => (e.shiftKey ? this.prevHeading() : this.nextHeading()),
      H: () => (e.shiftKey ? this.prevHeading() : this.nextHeading()),
      k: () => this.#move(e.shiftKey ? -1 : 1, isLink),
      K: () => this.#move(e.shiftKey ? -1 : 1, isLink),
      Home: () => this.first(),
      End: () => this.#jumpTo(this.elements.length - 1),
      Enter: () => this.#activate(),
      ' ': () => this.repeat(),
    };

    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  }

  #activate() {
    const el = this.elements[this.index];
    if (el && el.tagName === 'A' && el.href) {
      this.speech.announce(`Opening link: ${el.textContent.trim()}`);
      window.open(el.href, '_blank', 'noopener');
    }
  }
}
