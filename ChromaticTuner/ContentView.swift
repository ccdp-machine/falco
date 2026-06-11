import SwiftUI

struct ContentView: View {
    @StateObject private var tuner = TunerEngine()
    @Environment(\.scenePhase) private var scenePhase

    /// A note counts as "in tune" within this many cents.
    private let inTuneTolerance = 5.0

    var body: some View {
        VStack(spacing: 24) {
            Picker("Mode", selection: $tuner.mode) {
                ForEach(TunerMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 280)

            Spacer()

            if tuner.mode == .tuner {
                noteDisplay

                GaugeView(cents: tuner.reading?.cents, tolerance: inTuneTolerance)
                    .frame(height: 180)
                    .padding(.horizontal)

                frequencyDisplay
            } else {
                chordDisplay
            }

            Spacer()

            calibrationControl
        }
        .padding()
        .background(Color(.systemBackground))
        .onAppear { tuner.start() }
        .onChange(of: scenePhase) { phase in
            // Release the microphone when backgrounded; resume when active.
            switch phase {
            case .active: tuner.start()
            case .background: tuner.stop()
            default: break
            }
        }
        .overlay {
            if tuner.permissionDenied {
                permissionDeniedView
            }
        }
    }

    private var noteDisplay: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(tuner.reading?.noteName ?? "–")
                .font(.system(size: 96, weight: .bold, design: .rounded))
                .foregroundStyle(isInTune ? Color.green : Color.primary)
                .contentTransition(.opacity)
            if let octave = tuner.reading?.octave {
                Text("\(octave)")
                    .font(.system(size: 40, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: 110)
        .animation(.easeOut(duration: 0.1), value: tuner.reading?.noteName)
    }

    private var chordDisplay: some View {
        VStack(spacing: 16) {
            Text(tuner.chord?.name ?? "–")
                .font(.system(size: 72, weight: .bold, design: .rounded))
                .foregroundStyle(tuner.chord == nil ? Color.primary : Color.green)
                .frame(height: 110)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.1), value: tuner.chord?.name)

            Text(tuner.chord.map { $0.notes.joined(separator: " · ") } ?? "Play a chord…")
                .font(.title3)
                .foregroundStyle(.secondary)

            Text(tuner.chord.map { $0.score > 0.92 ? "confident" : "probable" } ?? " ")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        }
    }

    private var frequencyDisplay: some View {
        VStack(spacing: 4) {
            Text(tuner.reading.map { String(format: "%.1f Hz", $0.frequency) } ?? "Listening…")
                .font(.title3.monospacedDigit())
                .foregroundStyle(.secondary)
            Text(tuner.reading.map { String(format: "%+.0f cents", $0.cents) } ?? " ")
                .font(.headline.monospacedDigit())
                .foregroundStyle(isInTune ? Color.green : Color.orange)
        }
    }

    private var calibrationControl: some View {
        HStack {
            Text("A4")
                .font(.headline)
            Stepper(
                value: $tuner.referenceA4,
                in: 415...466,
                step: 1
            ) {
                Text("\(Int(tuner.referenceA4)) Hz")
                    .font(.body.monospacedDigit())
            }
        }
        .padding(.horizontal, 32)
    }

    private var permissionDeniedView: some View {
        VStack(spacing: 12) {
            Image(systemName: "mic.slash.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.red)
            Text("Microphone access is required")
                .font(.headline)
            Text("Enable it in Settings → Privacy & Security → Microphone.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(32)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
    }

    private var isInTune: Bool {
        guard let cents = tuner.reading?.cents else { return false }
        return abs(cents) <= inTuneTolerance
    }
}

/// Semicircular gauge with a needle showing deviation from -50 to +50 cents.
struct GaugeView: View {
    let cents: Double?
    let tolerance: Double

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height
            let center = CGPoint(x: width / 2, y: height * 0.95)
            let radius = min(width / 2, height) * 0.9

            ZStack {
                // Tick marks every 10 cents, longer at -50/0/+50.
                ForEach(-5...5, id: \.self) { tick in
                    let angle = angleFor(cents: Double(tick) * 10)
                    let isMajor = tick == 0 || abs(tick) == 5
                    TickMark(center: center, radius: radius, angle: angle, length: isMajor ? 18 : 10)
                        .stroke(
                            tick == 0 ? Color.green : Color.secondary.opacity(0.5),
                            lineWidth: isMajor ? 3 : 1.5
                        )
                }

                // In-tune zone arc around 0.
                ArcSegment(center: center, radius: radius + 6,
                           from: angleFor(cents: -tolerance), to: angleFor(cents: tolerance))
                    .stroke(Color.green.opacity(0.35), style: StrokeStyle(lineWidth: 6, lineCap: .round))

                // Needle.
                if let cents {
                    Needle(center: center, radius: radius - 24, angle: angleFor(cents: cents.clamped(to: -50...50)))
                        .stroke(abs(cents) <= tolerance ? Color.green : Color.orange,
                                style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .animation(.interpolatingSpring(stiffness: 120, damping: 16), value: cents)
                }

                Circle()
                    .fill(Color.primary)
                    .frame(width: 12, height: 12)
                    .position(center)

                Text("♭")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .position(x: center.x - radius - 16, y: center.y - 8)
                Text("♯")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .position(x: center.x + radius + 16, y: center.y - 8)
            }
        }
    }

    /// Maps cents in [-50, 50] to a needle angle in radians.
    /// 0 cents points straight up; the sweep spans 120 degrees.
    private func angleFor(cents: Double) -> Double {
        let sweep = Double.pi * 2 / 3
        return -Double.pi / 2 + (cents / 50) * (sweep / 2)
    }
}

private struct Needle: Shape {
    let center: CGPoint
    let radius: CGFloat
    var angle: Double

    var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: center)
        path.addLine(to: CGPoint(
            x: center.x + radius * cos(angle),
            y: center.y + radius * sin(angle)
        ))
        return path
    }
}

private struct TickMark: Shape {
    let center: CGPoint
    let radius: CGFloat
    let angle: Double
    let length: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(
            x: center.x + (radius - length) * cos(angle),
            y: center.y + (radius - length) * sin(angle)
        ))
        path.addLine(to: CGPoint(
            x: center.x + radius * cos(angle),
            y: center.y + radius * sin(angle)
        ))
        return path
    }
}

private struct ArcSegment: Shape {
    let center: CGPoint
    let radius: CGFloat
    let from: Double
    let to: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addArc(center: center, radius: radius,
                    startAngle: .radians(from), endAngle: .radians(to), clockwise: false)
        return path
    }
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

#Preview {
    ContentView()
}
