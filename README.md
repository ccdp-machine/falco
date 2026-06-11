# Chromatic Tuner

A chromatic instrument tuner for iPhone, built with SwiftUI and AVAudioEngine.

## Features

- **Live pitch detection** from the microphone using the YIN algorithm
  (accurate for guitar, bass, violin, voice, brass, woodwinds — anything
  from A0 up to ~C7).
- **Note + octave display** with a needle gauge showing deviation from
  −50 to +50 cents. The display turns green when you're within ±5 cents.
- **Frequency readout** in Hz and cents offset.
- **A4 calibration** adjustable from 415–466 Hz (default 440 Hz).
- Exponential smoothing keeps the needle steady without feeling laggy.

## Requirements

- Xcode 16 or later (the project uses Xcode's synchronized folder format)
- iOS 16.0+ (works great on an iPhone 13)

## Running on your iPhone

1. Open `ChromaticTuner.xcodeproj` in Xcode.
2. In the target's **Signing & Capabilities** tab, select your development
   team and (if needed) change the bundle identifier
   `com.example.ChromaticTuner` to something unique.
3. Connect your iPhone, select it as the run destination, and press **Run**.
4. On first launch, allow microphone access when prompted.

> Note: pitch detection needs a real microphone, so run on a physical
> device rather than the simulator for actual tuning.

## Project layout

| File | Purpose |
| --- | --- |
| `ChromaticTuner/PitchDetector.swift` | YIN fundamental-frequency estimation |
| `ChromaticTuner/TunerEngine.swift` | Microphone capture, smoothing, note/cents mapping |
| `ChromaticTuner/ContentView.swift` | Tuner UI: note display, cents gauge, calibration |
| `ChromaticTuner/ChromaticTunerApp.swift` | App entry point |
