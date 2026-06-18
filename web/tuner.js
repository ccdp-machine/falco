"use strict";
/* DSP for the Chromatic Tuner web app.
   Loaded by index.html in the browser; also require()-able from Node
   so the detection logic can be tested without a microphone. */

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/* ---------------- single-note pitch: YIN ----------------
   Same algorithm as ChromaticTuner/PitchDetector.swift. */
function detectPitch(buffer, sampleRate, threshold = 0.15, minFreq = 27.5, maxFreq = 2200) {
  const n = buffer.length;
  const maxLag = Math.min(Math.floor(sampleRate / minFreq), n >> 1);
  const minLag = Math.max(Math.floor(sampleRate / maxFreq), 2);
  if (maxLag <= minLag) return null;

  let power = 0;
  for (let i = 0; i < n; i++) power += buffer[i] * buffer[i];
  if (power / n <= 1e-6) return null;

  const diff = new Float32Array(maxLag + 1);
  const windowLen = n - maxLag;
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < windowLen; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float32Array(maxLag + 1).fill(1);
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += diff[tau];
    if (runningSum > 0) cmndf[tau] = diff[tau] * tau / runningSum;
  }

  let tauEstimate = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate < 0) return null;

  let betterTau = tauEstimate;
  if (tauEstimate > minLag && tauEstimate < maxLag) {
    const s0 = cmndf[tauEstimate - 1], s1 = cmndf[tauEstimate], s2 = cmndf[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau += (s2 - s0) / denom;
  }

  const freq = sampleRate / betterTau;
  return (freq >= minFreq && freq <= maxFreq) ? freq : null;
}

function makeReading(frequency, referenceA4) {
  const semitonesFromA4 = 12 * Math.log2(frequency / referenceA4);
  const midi = Math.round(semitonesFromA4 + 69);
  const nearest = referenceA4 * Math.pow(2, (midi - 69) / 12);
  return {
    frequency,
    cents: 1200 * Math.log2(frequency / nearest),
    noteName: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
  };
}

/* ---------------- chord detection ----------------
   FFT magnitudes -> spectral peaks -> 12-bin chroma -> template match. */

const CHORD_TEMPLATES = [
  { suffix: "",     intervals: [0, 4, 7] },
  { suffix: "m",    intervals: [0, 3, 7] },
  { suffix: "7",    intervals: [0, 4, 7, 10] },
  { suffix: "maj7", intervals: [0, 4, 7, 11] },
  { suffix: "m7",   intervals: [0, 3, 7, 10] },
  { suffix: "sus2", intervals: [0, 2, 7] },
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "dim",  intervals: [0, 3, 6] },
  { suffix: "aug",  intervals: [0, 4, 8] },
  { suffix: "5",    intervals: [0, 7] },
];

/* Tuning knobs shared with the Swift port (ChordDetector.swift) —
   keep the two in sync if you change them. */
const CHORD_MAG_EXPONENT = 0.8;   // compresses peak magnitudes into chroma
const CHORD_ROOT_WEIGHT = 1.2;    // template emphasis on the root
const CHORD_BASS_BONUS = 0.03;    // bonus when lowest peak matches the root
const CHORD_SCORE_THRESHOLD = 0.78;
const CHORD_HARMONIC_DAMP = 0.25;  // attenuation for peaks at integer multiples of stronger lower peaks
const CHORD_ACTIVE_FRACTION = 0.2; // pitch class counts as present above this share of the max

function pitchClass(freq, referenceA4) {
  const midi = Math.round(12 * Math.log2(freq / referenceA4) + 69);
  return ((midi % 12) + 12) % 12;
}

/* Local maxima of the magnitude spectrum within the note band,
   with parabolic interpolation for the peak frequency. */
function findSpectralPeaks(magnitudes, sampleRate, fftSize, minFreq = 55, maxFreq = 1250) {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(2, Math.ceil(minFreq / binHz));
  const hi = Math.min(magnitudes.length - 2, Math.floor(maxFreq / binHz));
  let maxMag = 0;
  for (let i = lo; i <= hi; i++) maxMag = Math.max(maxMag, magnitudes[i]);
  if (maxMag <= 0) return [];

  const floor = maxMag * 0.04;
  const peaks = [];
  for (let i = lo; i <= hi; i++) {
    const m = magnitudes[i];
    if (m > floor && m > magnitudes[i - 1] && m >= magnitudes[i + 1]) {
      const l = Math.log(magnitudes[i - 1] + 1e-12);
      const c = Math.log(m + 1e-12);
      const r = Math.log(magnitudes[i + 1] + 1e-12);
      const denom = l - 2 * c + r;
      const delta = denom !== 0 ? 0.5 * (l - r) / denom : 0;
      peaks.push({ freq: (i + delta) * binHz, mag: m });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, 20);
}

function detectChord(peaks, referenceA4) {
  if (peaks.length < 2) return null;

  const chroma = new Array(12).fill(0);
  for (const p of peaks) {
    // Damp peaks that sit at an integer multiple of a stronger, lower
    // peak — they are most likely harmonics, not played notes. Played
    // notes usually still register through their own octave doublings.
    let weight = Math.pow(p.mag, CHORD_MAG_EXPONENT);
    for (const q of peaks) {
      if (q.freq < p.freq && q.mag > p.mag) {
        const ratio = p.freq / q.freq;
        const harmonic = Math.round(ratio);
        if (harmonic >= 2 && harmonic <= 8 && Math.abs(ratio / harmonic - 1) < 0.02) {
          weight *= CHORD_HARMONIC_DAMP;
          break;
        }
      }
    }
    chroma[pitchClass(p.freq, referenceA4)] += weight;
  }
  const chromaMax = Math.max(...chroma);
  const norm = Math.hypot(...chroma);
  if (!norm || chromaMax <= 0) return null;
  const unit = chroma.map(v => v / norm);

  const activeClasses = [];
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] > CHORD_ACTIVE_FRACTION * chromaMax) activeClasses.push(pc);
  }
  if (activeClasses.length < 2) return null;
  const activeSet = new Set(activeClasses);

  // Lowest reasonably-strong peak suggests the bass note (likely root).
  const strong = peaks.filter(p => p.mag > 0.1 * peaks[0].mag);
  const bassPc = pitchClass(strong.reduce((a, b) => (a.freq < b.freq ? a : b)).freq, referenceA4);

  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const t of CHORD_TEMPLATES) {
      // Every chord tone must be genuinely present — keeps harmonic
      // ghosts (e.g. the 3rd harmonic of a doubled E adding a faint B)
      // from promoting a triad to a 7th chord.
      if (!t.intervals.every(iv => activeSet.has((root + iv) % 12))) continue;
      let dot = 0, normSq = 0;
      for (let k = 0; k < t.intervals.length; k++) {
        const w = k === 0 ? CHORD_ROOT_WEIGHT : 1;
        dot += w * unit[(root + t.intervals[k]) % 12];
        normSq += w * w;
      }
      let score = dot / Math.sqrt(normSq);
      if (bassPc === root) score += CHORD_BASS_BONUS;
      if (!best || score > best.score) best = { root, suffix: t.suffix, score };
    }
  }
  if (!best || best.score < CHORD_SCORE_THRESHOLD) return null;

  // Notes for display: root first, then remaining detected classes upward.
  const ordered = activeClasses
    .map(pc => ({ pc, offset: ((pc - best.root) % 12 + 12) % 12 }))
    .sort((a, b) => a.offset - b.offset)
    .map(x => NOTE_NAMES[x.pc]);

  return {
    name: NOTE_NAMES[best.root] + best.suffix,
    root: best.root,
    suffix: best.suffix,
    score: best.score,
    notes: ordered,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NOTE_NAMES, CHORD_TEMPLATES,
    detectPitch, makeReading, pitchClass,
    findSpectralPeaks, detectChord,
  };
}
