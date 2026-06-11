import AVFoundation
import Foundation

/// Result of analyzing one audio frame: the detected frequency mapped to the
/// nearest chromatic note and the deviation from it in cents.
struct TunerReading: Equatable {
    let frequency: Double
    let noteName: String
    let octave: Int
    let cents: Double

    static let noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]

    init(frequency: Double, referenceA4: Double) {
        self.frequency = frequency
        // Semitones above/below A4, then offset so 0 == C-1 (MIDI note 0).
        let semitonesFromA4 = 12 * log2(frequency / referenceA4)
        let midiNote = Int((semitonesFromA4 + 69).rounded())
        let nearestNoteFrequency = referenceA4 * pow(2, Double(midiNote - 69) / 12)
        self.cents = 1200 * log2(frequency / nearestNoteFrequency)
        self.noteName = Self.noteNames[((midiNote % 12) + 12) % 12]
        self.octave = midiNote / 12 - 1
    }
}

enum TunerMode: String, CaseIterable, Identifiable {
    case tuner = "Tuner"
    case chord = "Chord"
    var id: String { rawValue }
}

/// Captures microphone audio with AVAudioEngine and continuously publishes
/// pitch readings for the UI.
@MainActor
final class TunerEngine: ObservableObject {
    @Published private(set) var reading: TunerReading?
    @Published private(set) var chord: ChordResult?
    @Published private(set) var isRunning = false
    @Published private(set) var permissionDenied = false

    @Published var mode: TunerMode = .tuner {
        didSet {
            reading = nil
            chord = nil
            smoothedFrequency = nil
            sampleBuffer.removeAll()
            recentChordNames.removeAll()
            emptyChordFrames = 0
        }
    }

    /// Calibration: frequency of A4 in Hz, adjustable in the UI.
    @Published var referenceA4: Double = 440 {
        didSet {
            if let current = reading {
                reading = TunerReading(frequency: current.frequency, referenceA4: referenceA4)
            }
        }
    }

    private let engine = AVAudioEngine()
    private let detector = PitchDetector()
    private let chordDetector = ChordDetector()
    private let pitchAnalysisSize = 4096
    private var sampleBuffer: [Float] = []
    private var smoothedFrequency: Double?
    private var recentChordNames: [String] = []
    private var emptyChordFrames = 0

    private var analysisSize: Int {
        mode == .chord ? ChordDetector.fftSize : pitchAnalysisSize
    }

    func start() {
        guard !isRunning else { return }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                if granted {
                    self.permissionDenied = false
                    self.startEngine()
                } else {
                    self.permissionDenied = true
                }
            }
        }
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
        reading = nil
        chord = nil
        smoothedFrequency = nil
        sampleBuffer.removeAll()
        recentChordNames.removeAll()
        emptyChordFrames = 0
    }

    private func startEngine() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { return }

            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                guard let self, let channelData = buffer.floatChannelData else { return }
                let samples = Array(UnsafeBufferPointer(start: channelData[0], count: Int(buffer.frameLength)))
                let sampleRate = Float(format.sampleRate)
                Task { @MainActor in
                    self.process(samples: samples, sampleRate: sampleRate)
                }
            }

            engine.prepare()
            try engine.start()
            isRunning = true
        } catch {
            isRunning = false
        }
    }

    private func process(samples: [Float], sampleRate: Float) {
        sampleBuffer.append(contentsOf: samples)
        guard sampleBuffer.count >= analysisSize else { return }
        let frame = Array(sampleBuffer.suffix(analysisSize))
        // Keep up to one analysis window of history so windows overlap.
        if sampleBuffer.count > analysisSize {
            sampleBuffer.removeFirst(sampleBuffer.count - analysisSize)
        }

        if mode == .chord {
            processChord(frame: frame, sampleRate: sampleRate)
            return
        }

        guard let frequency = detector.detectPitch(in: frame, sampleRate: sampleRate) else {
            // Let the displayed reading linger briefly via smoothing reset.
            smoothedFrequency = nil
            reading = nil
            return
        }

        // Exponential smoothing keeps the needle stable without feeling laggy.
        // Snap instead of smoothing when the pitch jumps to a different note.
        if let previous = smoothedFrequency, abs(1200 * log2(Double(frequency) / previous)) < 80 {
            smoothedFrequency = previous * 0.7 + Double(frequency) * 0.3
        } else {
            smoothedFrequency = Double(frequency)
        }
        reading = TunerReading(frequency: smoothedFrequency!, referenceA4: referenceA4)
    }

    /// Show a chord once it wins 2 of the last 3 frames; clear only after a
    /// few empty frames so strums don't flicker.
    private func processChord(frame: [Float], sampleRate: Float) {
        let detected = chordDetector.analyze(frame, sampleRate: sampleRate,
                                             referenceA4: Float(referenceA4))
        if let detected {
            emptyChordFrames = 0
            recentChordNames.append(detected.name)
            if recentChordNames.count > 3 { recentChordNames.removeFirst() }
            let wins = recentChordNames.filter { $0 == detected.name }.count
            if wins >= 2 || chord == nil {
                chord = detected
            }
        } else {
            recentChordNames.removeAll()
            emptyChordFrames += 1
            if emptyChordFrames >= 4 {
                chord = nil
            }
        }
    }
}
