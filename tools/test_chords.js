#!/usr/bin/env node
"use strict";
/* Tests for the chord detector in web/tuner.js.
   Synthesizes chords (harmonics + slight detuning + noise), computes a
   Hann-windowed DFT over the note band, and checks the detected name. */

const { findSpectralPeaks, detectChord, detectPitch } = require("../web/tuner.js");

const SAMPLE_RATE = 48000;
const FFT_SIZE = 16384;
const A4 = 440;

function noteFreq(midi) {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

// Plucked-string-ish tone: decaying harmonic series.
function addTone(samples, freq, amp, phase = 0) {
  const harmonics = [1.0, 0.55, 0.3, 0.15, 0.08];
  for (let h = 0; h < harmonics.length; h++) {
    const w = 2 * Math.PI * freq * (h + 1) / SAMPLE_RATE;
    for (let i = 0; i < samples.length; i++) {
      samples[i] += amp * harmonics[h] * Math.sin(w * i + phase * (h + 1));
    }
  }
}

function synthChord(midiNotes, { detuneCents = 3, noise = 0.002 } = {}) {
  const samples = new Float64Array(FFT_SIZE);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  midiNotes.forEach((midi, i) => {
    const detune = (rand() * 2 - 1) * detuneCents;
    const f = noteFreq(midi) * Math.pow(2, detune / 1200);
    addTone(samples, f, 0.8 + 0.4 * rand(), rand() * Math.PI);
  });
  for (let i = 0; i < samples.length; i++) samples[i] += (rand() * 2 - 1) * noise;
  return samples;
}

// Hann-windowed DFT magnitudes for bins covering ~50–1300 Hz only.
function spectrum(samples) {
  const n = samples.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    windowed[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const mags = new Float64Array(n / 2);
  const loBin = Math.floor(50 / (SAMPLE_RATE / n));
  const hiBin = Math.ceil(1300 / (SAMPLE_RATE / n));
  for (let k = loBin; k <= hiBin; k++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += windowed[i] * Math.cos(w * i);
      im -= windowed[i] * Math.sin(w * i);
    }
    mags[k] = Math.hypot(re, im);
  }
  return mags;
}

function detect(midiNotes, opts) {
  const mags = spectrum(synthChord(midiNotes, opts));
  const peaks = findSpectralPeaks(mags, SAMPLE_RATE, FFT_SIZE);
  return detectChord(peaks, A4);
}

// midi: C2=36, C3=48, C4=60
const CASES = [
  ["C major (close)",        [48, 52, 55],          "C"],
  ["C major (guitar C)",     [48, 52, 55, 60, 64],  "C"],
  ["A minor",                [45, 48, 52],          "Am"],
  ["A minor (guitar Am)",    [45, 52, 57, 60, 64],  "Am"],
  ["E minor (guitar Em)",    [40, 47, 52, 55, 59, 64], "Em"],
  ["G major (guitar G)",     [43, 47, 50, 55, 59, 67], "G"],
  ["G7",                     [43, 47, 50, 53],      "G7"],
  ["D major",                [50, 54, 57],          "D"],
  ["F major (barre F)",      [41, 48, 53, 57, 60, 65], "F"],
  ["A maj7",                 [45, 49, 52, 56],      "Amaj7"],
  ["D minor 7",              [50, 53, 57, 60],      "Dm7"],
  ["A sus4",                 [45, 50, 52],          "Asus4"],
  ["B dim",                  [47, 50, 53],          "Bdim"],
  ["E power chord (E5)",     [40, 47, 52],          "E5"],
];

let failures = 0;
for (const [label, notes, expected] of CASES) {
  const result = detect(notes);
  const got = result ? `${result.name} (score ${result.score.toFixed(3)})` : "null";
  const pass = result && result.name === expected;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label.padEnd(24)} expected ${expected.padEnd(6)} got ${got}`);
}

// Single notes should NOT be reported as chords.
for (const [label, midi] of [["single E2", 40], ["single A4", 69]]) {
  const result = detect([midi]);
  const pass = result === null;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label.padEnd(24)} expected null   got ${result ? result.name : "null"}`);
}

// Sanity: YIN still works through the same module.
{
  const t = new Float32Array(4096);
  for (let i = 0; i < t.length; i++) t[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  const f = detectPitch(t, SAMPLE_RATE);
  const pass = f && Math.abs(f - 440) < 1;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  YIN 440 Hz sine          expected ~440   got ${f ? f.toFixed(2) : "null"}`);
}

console.log(failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
