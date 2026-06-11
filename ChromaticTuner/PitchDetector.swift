import Foundation

/// Pitch detection using the YIN algorithm (de Cheveigné & Kawahara, 2002).
/// Returns the fundamental frequency of a mono audio buffer, or nil when no
/// clear pitch is present (silence, noise, percussive transients).
struct PitchDetector {
    /// Confidence threshold for the cumulative mean normalized difference.
    /// Lower is stricter; 0.15 is a common default for instrument tuning.
    var threshold: Float = 0.15

    /// Minimum detectable frequency in Hz (below low B on a 5-string bass).
    var minFrequency: Float = 27.5
    /// Maximum detectable frequency in Hz (above the highest piano note's fundamental range we care about).
    var maxFrequency: Float = 2200.0

    func detectPitch(in buffer: [Float], sampleRate: Float) -> Float? {
        let maxLag = min(Int(sampleRate / minFrequency), buffer.count / 2)
        let minLag = max(Int(sampleRate / maxFrequency), 2)
        guard maxLag > minLag else { return nil }

        // Ignore buffers that are effectively silent.
        let power = buffer.reduce(0) { $0 + $1 * $1 } / Float(buffer.count)
        guard power > 1e-6 else { return nil }

        // Step 1–2: difference function d(tau).
        var diff = [Float](repeating: 0, count: maxLag + 1)
        for tau in 1...maxLag {
            var sum: Float = 0
            for i in 0..<(buffer.count - maxLag) {
                let delta = buffer[i] - buffer[i + tau]
                sum += delta * delta
            }
            diff[tau] = sum
        }

        // Step 3: cumulative mean normalized difference function d'(tau).
        var cmndf = [Float](repeating: 1, count: maxLag + 1)
        var runningSum: Float = 0
        for tau in 1...maxLag {
            runningSum += diff[tau]
            cmndf[tau] = runningSum > 0 ? diff[tau] * Float(tau) / runningSum : 1
        }

        // Step 4: absolute threshold — first dip below threshold, then walk to its local minimum.
        var tauEstimate = -1
        var tau = minLag
        while tau <= maxLag {
            if cmndf[tau] < threshold {
                while tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau] {
                    tau += 1
                }
                tauEstimate = tau
                break
            }
            tau += 1
        }
        guard tauEstimate > 0 else { return nil }

        // Step 5: parabolic interpolation around the minimum for sub-sample accuracy.
        let betterTau: Float
        if tauEstimate > minLag && tauEstimate < maxLag {
            let s0 = cmndf[tauEstimate - 1]
            let s1 = cmndf[tauEstimate]
            let s2 = cmndf[tauEstimate + 1]
            let denominator = 2 * (2 * s1 - s2 - s0)
            let adjustment = denominator != 0 ? (s2 - s0) / denominator : 0
            betterTau = Float(tauEstimate) + adjustment
        } else {
            betterTau = Float(tauEstimate)
        }

        let frequency = sampleRate / betterTau
        guard frequency >= minFrequency && frequency <= maxFrequency else { return nil }
        return frequency
    }
}
