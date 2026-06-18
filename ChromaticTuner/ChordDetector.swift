import Accelerate
import Foundation

struct ChordResult: Equatable {
    let rootIndex: Int
    let suffix: String
    let score: Float
    /// Detected pitch-class names, root first, remaining tones upward.
    let notes: [String]

    var name: String { TunerReading.noteNames[rootIndex] + suffix }
}

/// Polyphonic chord detection: FFT magnitudes -> spectral peaks ->
/// 12-bin chroma -> chord-template matching. Mirrors the logic in
/// web/tuner.js — keep the tuning constants in sync between the two.
final class ChordDetector {
    static let fftSize = 16384

    static let templates: [(suffix: String, intervals: [Int])] = [
        ("",     [0, 4, 7]),
        ("m",    [0, 3, 7]),
        ("7",    [0, 4, 7, 10]),
        ("maj7", [0, 4, 7, 11]),
        ("m7",   [0, 3, 7, 10]),
        ("sus2", [0, 2, 7]),
        ("sus4", [0, 5, 7]),
        ("dim",  [0, 3, 6]),
        ("aug",  [0, 4, 8]),
        ("5",    [0, 7]),
    ]

    private static let magExponent: Float = 0.8
    private static let rootWeight: Float = 1.2
    private static let bassBonus: Float = 0.03
    private static let scoreThreshold: Float = 0.78
    private static let harmonicDamp: Float = 0.25
    private static let activeFraction: Float = 0.2

    private let fft: vDSP.FFT<DSPSplitComplex>?
    private let window: [Float]

    init() {
        let log2n = vDSP_Length(log2(Float(Self.fftSize)))
        fft = vDSP.FFT(log2n: log2n, radix: .radix2, ofType: DSPSplitComplex.self)
        window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized,
                             count: Self.fftSize, isHalfWindow: false)
    }

    func analyze(_ samples: [Float], sampleRate: Float, referenceA4: Float) -> ChordResult? {
        guard samples.count >= Self.fftSize, let fft else { return nil }
        let magnitudes = magnitudeSpectrum(Array(samples.suffix(Self.fftSize)), fft: fft)
        let peaks = Self.spectralPeaks(magnitudes, sampleRate: sampleRate, fftSize: Self.fftSize)
        return Self.matchChord(peaks: peaks, referenceA4: referenceA4)
    }

    // MARK: - FFT

    private func magnitudeSpectrum(_ samples: [Float], fft: vDSP.FFT<DSPSplitComplex>) -> [Float] {
        let n = Self.fftSize
        let half = n / 2
        let windowed = vDSP.multiply(samples, window)

        var realIn = [Float](repeating: 0, count: half)
        var imagIn = [Float](repeating: 0, count: half)
        var realOut = [Float](repeating: 0, count: half)
        var imagOut = [Float](repeating: 0, count: half)
        var magnitudes = [Float](repeating: 0, count: half)

        realIn.withUnsafeMutableBufferPointer { realInPtr in
            imagIn.withUnsafeMutableBufferPointer { imagInPtr in
                var input = DSPSplitComplex(realp: realInPtr.baseAddress!, imagp: imagInPtr.baseAddress!)
                windowed.withUnsafeBufferPointer { samplesPtr in
                    samplesPtr.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                        vDSP_ctoz($0, 2, &input, 1, vDSP_Length(half))
                    }
                }
                realOut.withUnsafeMutableBufferPointer { realOutPtr in
                    imagOut.withUnsafeMutableBufferPointer { imagOutPtr in
                        var output = DSPSplitComplex(realp: realOutPtr.baseAddress!, imagp: imagOutPtr.baseAddress!)
                        fft.forward(input: input, output: &output)
                        vDSP.squareMagnitudes(output, result: &magnitudes)
                    }
                }
            }
        }
        // Relative thresholds only, so the FFT's scaling constant is irrelevant;
        // take sqrt so peak weights match the linear magnitudes used on the web.
        return vForce.sqrt(magnitudes)
    }

    // MARK: - peak picking

    struct Peak {
        let frequency: Float
        let magnitude: Float
    }

    static func spectralPeaks(_ magnitudes: [Float], sampleRate: Float, fftSize: Int,
                              minFreq: Float = 55, maxFreq: Float = 1250) -> [Peak] {
        let binHz = sampleRate / Float(fftSize)
        let lo = max(2, Int((minFreq / binHz).rounded(.up)))
        let hi = min(magnitudes.count - 2, Int(maxFreq / binHz))
        guard hi > lo else { return [] }

        var maxMag: Float = 0
        for i in lo...hi { maxMag = max(maxMag, magnitudes[i]) }
        guard maxMag > 0 else { return [] }

        let floor = maxMag * 0.04
        var peaks: [Peak] = []
        for i in lo...hi {
            let m = magnitudes[i]
            guard m > floor, m > magnitudes[i - 1], m >= magnitudes[i + 1] else { continue }
            let l = log(magnitudes[i - 1] + 1e-12)
            let c = log(m + 1e-12)
            let r = log(magnitudes[i + 1] + 1e-12)
            let denom = l - 2 * c + r
            let delta = denom != 0 ? 0.5 * (l - r) / denom : 0
            peaks.append(Peak(frequency: (Float(i) + delta) * binHz, magnitude: m))
        }
        peaks.sort { $0.magnitude > $1.magnitude }
        return Array(peaks.prefix(20))
    }

    // MARK: - chroma + template matching

    private static func pitchClass(_ frequency: Float, referenceA4: Float) -> Int {
        let midi = Int((12 * log2(frequency / referenceA4) + 69).rounded())
        return ((midi % 12) + 12) % 12
    }

    static func matchChord(peaks: [Peak], referenceA4: Float) -> ChordResult? {
        guard peaks.count >= 2 else { return nil }

        var chroma = [Float](repeating: 0, count: 12)
        for peak in peaks {
            // Damp peaks at integer multiples of stronger, lower peaks —
            // they are most likely harmonics, not played notes.
            var weight = pow(peak.magnitude, magExponent)
            for other in peaks where other.frequency < peak.frequency && other.magnitude > peak.magnitude {
                let ratio = peak.frequency / other.frequency
                let harmonic = ratio.rounded()
                if harmonic >= 2, harmonic <= 8, abs(ratio / harmonic - 1) < 0.02 {
                    weight *= harmonicDamp
                    break
                }
            }
            chroma[pitchClass(peak.frequency, referenceA4: referenceA4)] += weight
        }

        guard let chromaMax = chroma.max(), chromaMax > 0 else { return nil }
        let norm = sqrt(chroma.reduce(0) { $0 + $1 * $1 })
        guard norm > 0 else { return nil }
        let unit = chroma.map { $0 / norm }

        let activeClasses = (0..<12).filter { chroma[$0] > activeFraction * chromaMax }
        guard activeClasses.count >= 2 else { return nil }
        let activeSet = Set(activeClasses)

        // Lowest reasonably-strong peak suggests the bass note (likely root).
        let strongest = peaks[0].magnitude
        let bass = peaks.filter { $0.magnitude > 0.1 * strongest }.min { $0.frequency < $1.frequency }!
        let bassPc = pitchClass(bass.frequency, referenceA4: referenceA4)

        var best: (root: Int, suffix: String, score: Float)?
        for root in 0..<12 {
            for template in templates {
                // Every chord tone must be genuinely present — keeps harmonic
                // ghosts from promoting a triad to a 7th chord.
                guard template.intervals.allSatisfy({ activeSet.contains((root + $0) % 12) }) else { continue }
                var dot: Float = 0
                var normSq: Float = 0
                for (k, interval) in template.intervals.enumerated() {
                    let w: Float = k == 0 ? rootWeight : 1
                    dot += w * unit[(root + interval) % 12]
                    normSq += w * w
                }
                var score = dot / sqrt(normSq)
                if bassPc == root { score += bassBonus }
                if best == nil || score > best!.score {
                    best = (root, template.suffix, score)
                }
            }
        }
        guard let best, best.score >= scoreThreshold else { return nil }

        let ordered = activeClasses
            .map { (pc: $0, offset: (($0 - best.root) % 12 + 12) % 12) }
            .sorted { $0.offset < $1.offset }
            .map { TunerReading.noteNames[$0.pc] }

        return ChordResult(rootIndex: best.root, suffix: best.suffix,
                           score: best.score, notes: ordered)
    }
}
