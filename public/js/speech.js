// Text-to-speech engine built on the Web Speech API.
//
// Long texts are split into sentence chunks because several browsers
// (notably Chrome) silently cut off long utterances. Word boundary events
// are forwarded so the UI can highlight the word being spoken.

export class SpeechEngine {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voices = [];
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.chunks = [];
    this.chunkIndex = 0;
    this.speaking = false;
    this.onWord = null; // (charIndexInFullText, word) => void
    this.onStateChange = null; // ('speaking'|'paused'|'stopped') => void

    this.#loadVoices();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.addEventListener('voiceschanged', () => this.#loadVoices());
    }
  }

  static isSupported() {
    return 'speechSynthesis' in window;
  }

  #loadVoices() {
    this.voices = this.synth.getVoices();
    if (!this.voice && this.voices.length) {
      this.voice =
        this.voices.find((v) => v.default) ||
        this.voices.find((v) => v.lang.startsWith(navigator.language)) ||
        this.voices[0];
    }
    document.dispatchEvent(new CustomEvent('voicesloaded', { detail: this.voices }));
  }

  setVoice(voiceURI) {
    this.voice = this.voices.find((v) => v.voiceURI === voiceURI) || this.voice;
  }

  // Splits text into sentence-sized chunks, tracking each chunk's offset in
  // the full text so boundary events can be mapped back for highlighting.
  #chunkText(text) {
    const chunks = [];
    const re = /[^.!?\n]+[.!?]*[\s\n]*/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0].trim()) {
        chunks.push({ text: match[0], offset: match.index });
      }
    }
    return chunks.length ? chunks : [{ text, offset: 0 }];
  }

  speak(text, { onWord, onEnd } = {}) {
    this.stop();
    if (!text || !text.trim()) return;
    this.onWord = onWord || null;
    this.onEnd = onEnd || null;
    this.chunks = this.#chunkText(text);
    this.chunkIndex = 0;
    this.speaking = true;
    this.#speakNextChunk();
    this.#notify('speaking');
  }

  // Speaks a short phrase immediately (used for announcements). Does not
  // disturb chunk-based reading state beyond cancelling current audio.
  announce(text) {
    if (!text) return;
    this.synth.cancel();
    this.speaking = false;
    const u = new SpeechSynthesisUtterance(text);
    this.#applySettings(u);
    this.synth.speak(u);
  }

  #applySettings(utterance) {
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
  }

  #speakNextChunk() {
    if (!this.speaking || this.chunkIndex >= this.chunks.length) {
      this.speaking = false;
      this.#notify('stopped');
      if (this.onEnd) this.onEnd();
      return;
    }
    const chunk = this.chunks[this.chunkIndex];
    const u = new SpeechSynthesisUtterance(chunk.text);
    this.#applySettings(u);
    u.onboundary = (e) => {
      if (e.name === 'word' && this.onWord) {
        const word = chunk.text.slice(e.charIndex).match(/^\S+/)?.[0] || '';
        this.onWord(chunk.offset + e.charIndex, word);
      }
    };
    u.onend = () => {
      this.chunkIndex += 1;
      this.#speakNextChunk();
    };
    u.onerror = (e) => {
      // 'interrupted'/'canceled' fire on normal stop; anything else, move on.
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        this.chunkIndex += 1;
        this.#speakNextChunk();
      }
    };
    this.synth.speak(u);
  }

  pause() {
    if (this.synth.speaking && !this.synth.paused) {
      this.synth.pause();
      this.#notify('paused');
    }
  }

  resume() {
    if (this.synth.paused) {
      this.synth.resume();
      this.#notify('speaking');
    }
  }

  togglePause() {
    if (this.synth.paused) this.resume();
    else this.pause();
  }

  stop() {
    this.speaking = false;
    this.chunks = [];
    this.chunkIndex = 0;
    this.synth.cancel();
    this.#notify('stopped');
  }

  #notify(state) {
    if (this.onStateChange) this.onStateChange(state);
  }
}
