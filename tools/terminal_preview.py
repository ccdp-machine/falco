#!/usr/bin/env python3
"""Terminal preview of the ChromaticTuner app.

Runs the same YIN pitch-detection algorithm as the Swift app
(ChromaticTuner/PitchDetector.swift) and renders the tuner display as ASCII.

Modes:
  demo (default)  Synthesizes guitar-string tones that drift into tune,
                  so you can watch the needle behave without a microphone.
  --mic           Live input from your microphone (requires `pip install
                  sounddevice`; run locally, not in a cloud container).
  --freq HZ       Analyze a single synthesized tone and print one frame.
  --no-anim       In demo mode, print one frame per step instead of
                  animating in place (useful for non-interactive logs).
"""

import argparse
import math
import sys
import time

import numpy as np

SAMPLE_RATE = 48000
ANALYSIS_SIZE = 4096
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
IN_TUNE_CENTS = 5.0

GREEN = "\033[32m"
ORANGE = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def detect_pitch(buffer: np.ndarray, sample_rate: float,
                 threshold: float = 0.15,
                 min_freq: float = 27.5, max_freq: float = 2200.0):
    """YIN — mirrors PitchDetector.swift step for step."""
    n = len(buffer)
    max_lag = min(int(sample_rate / min_freq), n // 2)
    min_lag = max(int(sample_rate / max_freq), 2)
    if max_lag <= min_lag:
        return None
    if float(np.mean(buffer ** 2)) <= 1e-6:
        return None

    # Difference function d(tau), vectorized over the window.
    window = buffer[: n - max_lag]
    diff = np.empty(max_lag + 1)
    diff[0] = 0.0
    for tau in range(1, max_lag + 1):
        delta = window - buffer[tau: tau + len(window)]
        diff[tau] = float(np.dot(delta, delta))

    # Cumulative mean normalized difference d'(tau).
    cumsum = np.cumsum(diff[1:])
    taus = np.arange(1, max_lag + 1)
    cmndf = np.ones(max_lag + 1)
    nonzero = cumsum > 0
    cmndf[1:][nonzero] = diff[1:][nonzero] * taus[nonzero] / cumsum[nonzero]

    # Absolute threshold: first dip below threshold, walk to local minimum.
    tau_estimate = -1
    tau = min_lag
    while tau <= max_lag:
        if cmndf[tau] < threshold:
            while tau + 1 <= max_lag and cmndf[tau + 1] < cmndf[tau]:
                tau += 1
            tau_estimate = tau
            break
        tau += 1
    if tau_estimate < 0:
        return None

    # Parabolic interpolation for sub-sample accuracy.
    better_tau = float(tau_estimate)
    if min_lag < tau_estimate < max_lag:
        s0, s1, s2 = cmndf[tau_estimate - 1], cmndf[tau_estimate], cmndf[tau_estimate + 1]
        denom = 2 * (2 * s1 - s2 - s0)
        if denom != 0:
            better_tau += (s2 - s0) / denom

    freq = sample_rate / better_tau
    if not (min_freq <= freq <= max_freq):
        return None
    return freq


def reading(frequency: float, reference_a4: float = 440.0):
    """Mirrors TunerReading in TunerEngine.swift."""
    semitones_from_a4 = 12 * math.log2(frequency / reference_a4)
    midi = round(semitones_from_a4 + 69)
    nearest = reference_a4 * 2 ** ((midi - 69) / 12)
    cents = 1200 * math.log2(frequency / nearest)
    return NOTE_NAMES[midi % 12], midi // 12 - 1, cents


def synth_tone(freq: float, duration: float = ANALYSIS_SIZE / SAMPLE_RATE,
               rng: np.random.Generator | None = None) -> np.ndarray:
    """Plucked-string-ish test tone: fundamental + decaying harmonics + noise."""
    t = np.arange(int(duration * SAMPLE_RATE)) / SAMPLE_RATE
    signal = np.zeros_like(t)
    for harmonic, amp in enumerate([1.0, 0.55, 0.3, 0.15, 0.08], start=1):
        signal += amp * np.sin(2 * np.pi * freq * harmonic * t)
    if rng is not None:
        signal += 0.02 * rng.standard_normal(len(t))
    return (signal / np.max(np.abs(signal)) * 0.5).astype(np.float64)


def render_frame(freq, width: int = 61) -> str:
    """ASCII version of the app's note display + cents gauge."""
    lines = []
    if freq is None:
        note_line = f"{DIM}--  Listening...{RESET}"
        cents = None
    else:
        note, octave, cents = reading(freq)
        in_tune = abs(cents) <= IN_TUNE_CENTS
        color = GREEN if in_tune else ORANGE
        status = "IN TUNE" if in_tune else ("FLAT" if cents < 0 else "SHARP")
        note_line = (f"{BOLD}{color}{note}{octave}{RESET}   "
                     f"{freq:7.1f} Hz   {color}{cents:+5.1f} cents  {status}{RESET}")
    lines.append(note_line)

    # Gauge: -50 .. +50 cents across `width` columns.
    center = width // 2
    scale = [" "] * width
    for c in range(-50, 51, 10):
        scale[center + c * center // 50] = "|" if c else "+"
    needle_row = [" "] * width
    if cents is not None:
        pos = center + int(round(max(-50.0, min(50.0, cents)) * center / 50))
        color = GREEN if abs(cents) <= IN_TUNE_CENTS else ORANGE
        needle_row[pos] = f"{BOLD}{color}#{RESET}"
    lines.append("".join(needle_row))
    lines.append("".join(scale))
    labels = [" "] * width
    for c, text in [(-50, "-50"), (0, "0"), (50, "+50")]:
        pos = center + c * center // 50
        start = max(0, min(width - len(text), pos - len(text) // 2))
        labels[start:start + len(text)] = list(text)
    lines.append(f"{DIM}{''.join(labels)}{RESET}")
    return "\n".join(lines)


def run_demo(animate: bool) -> None:
    rng = np.random.default_rng(11)
    # Each guitar string starts off-pitch and is "tuned" into place.
    strings = [
        ("low E", 82.41), ("A", 110.00), ("D", 146.83),
        ("G", 196.00), ("B", 246.94), ("high E", 329.63),
    ]
    frame_height = 6
    for name, target in strings:
        start = target * 2 ** (rng.uniform(-35, 35) / 1200)  # up to 35c off
        steps = 8
        for step in range(steps + 1):
            freq = start + (target - start) * (step / steps) ** 1.5
            detected = detect_pitch(synth_tone(freq, rng=rng), SAMPLE_RATE)
            frame = f"{DIM}Tuning {name} string -> {target:.2f} Hz{RESET}\n"
            frame += render_frame(detected) + "\n"
            if animate:
                sys.stdout.write(f"\033[{frame_height}A\033[J" if step or name != "low E" else "")
                sys.stdout.write(frame)
                sys.stdout.flush()
                time.sleep(0.25)
            elif step in (0, steps // 2, steps):
                print(frame)
        if animate:
            time.sleep(0.6)


def run_mic() -> None:
    try:
        import sounddevice as sd
    except ImportError:
        sys.exit("Live mode needs sounddevice: pip install sounddevice")
    buf = np.zeros(0)

    def callback(indata, frames, t, status):
        nonlocal buf
        buf = np.concatenate([buf, indata[:, 0]])[-ANALYSIS_SIZE:]

    print("Listening... play a note (Ctrl-C to quit)\n" + "\n" * 4)
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, callback=callback):
        try:
            while True:
                freq = detect_pitch(buf, SAMPLE_RATE) if len(buf) >= ANALYSIS_SIZE else None
                sys.stdout.write("\033[5A\033[J" + render_frame(freq) + "\n")
                sys.stdout.flush()
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mic", action="store_true", help="live microphone input")
    parser.add_argument("--freq", type=float, help="analyze one synthesized tone at HZ")
    parser.add_argument("--no-anim", action="store_true", help="print frames instead of animating")
    args = parser.parse_args()

    if args.mic:
        run_mic()
    elif args.freq:
        detected = detect_pitch(synth_tone(args.freq, rng=np.random.default_rng(0)), SAMPLE_RATE)
        print(f"{DIM}Synthesized {args.freq} Hz tone{RESET}")
        print(render_frame(detected))
    else:
        run_demo(animate=not args.no_anim and sys.stdout.isatty())


if __name__ == "__main__":
    main()
