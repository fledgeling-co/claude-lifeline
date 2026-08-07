// lifeline-menubar — the status window.
//
// A thin, native view over lifeline's two file contracts:
//   reads  ~/.lifeline/status.json          (written atomically by the daemon)
//   writes ~/.lifeline/intents/<ts>-<uuid>.json   (consumed by the daemon's next tick)
//
// It holds no state of its own and never touches ledgers or journals, so a wedged or
// killed menubar app can never corrupt recovery. Compiled at install time with swiftc;
// no dependencies. Design reference: design/menubar/mock.html.

import AppKit
import SwiftUI

// MARK: - Contracts (mirrors src/shared/types.ts; unknown strings render dimmed, never crash)

struct StatusSnapshot: Decodable {
    var updatedAt: Double
    var online: Bool
    var runs: [StatusRun]
}

struct StatusRun: Decodable, Identifiable {
    var runId: String
    var project: String
    var state: String   // running | completed | completed-with-failures | warning | recovering
    var agents: [StatusAgent]
    var durationMs: Double?
    var contextFrac: Double?
    var note: String?
    var cwd: String?
    var term: String?
    var tty: String?
    var callerTail: [String]?
    var id: String { runId }
}

struct StatusAgent: Decodable, Identifiable {
    var agentId: String?
    var item: String?
    var state: String   // retrying | stalled | paused-* | failed-terminal | done
    var attempts: Int
    var maxAttempts: Int
    var nextRetryAt: Double?
    var lastClass: String?
    var durationMs: Double?
    var contextFrac: Double?
    var stalledForMs: Double?
    var tail: [String]?
    var id: String { agentId ?? item ?? UUID().uuidString }
}

struct ControlIntent: Encodable {
    var id: String
    var kind: String            // retry | pause | resume
    var target: Target
    var createdAt: Double
    struct Target: Encodable {
        var runId: String
        var agentId: String?
    }
}

// MARK: - Paths + IO

enum Lifeline {
    static var home: URL {
        if let custom = ProcessInfo.processInfo.environment["LIFELINE_HOME"] {
            return URL(fileURLWithPath: custom)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".lifeline")
    }
    static var statusFile: URL { home.appendingPathComponent("status.json") }
    static var intentsDir: URL { home.appendingPathComponent("intents") }

    static func readSnapshot() -> (snapshot: StatusSnapshot?, fileAge: TimeInterval?) {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: statusFile.path),
              let mtime = attrs[.modificationDate] as? Date,
              let data = try? Data(contentsOf: statusFile),
              let snap = try? JSONDecoder().decode(StatusSnapshot.self, from: data)
        else { return (nil, nil) }
        return (snap, Date().timeIntervalSince(mtime))
    }

    /// Timestamp-first filename so the daemon drains intents in order (same as the CLI).
    static func writeIntent(kind: String, runId: String, agentId: String?) {
        let fm = FileManager.default
        try? fm.createDirectory(at: intentsDir, withIntermediateDirectories: true)
        let intent = ControlIntent(
            id: UUID().uuidString.lowercased(),
            kind: kind,
            target: .init(runId: runId, agentId: agentId),
            createdAt: Date().timeIntervalSince1970 * 1000
        )
        let ts = Int(intent.createdAt)
        let file = intentsDir.appendingPathComponent("\(ts)-\(intent.id).json")
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(intent) {
            // Write-then-rename so the daemon never reads a half-written intent.
            let tmp = intentsDir.appendingPathComponent(".\(intent.id).tmp")
            try? data.write(to: tmp)
            try? fm.moveItem(at: tmp, to: file)
        }
    }
}

// MARK: - Presentation helpers (vocabulary identical to the CLI renderer)

enum Vocab {
    static func agentLabel(_ a: StatusAgent, now: Date) -> String {
        switch a.state {
        case "retrying":
            if let at = a.nextRetryAt {
                let secs = max(0, Int((at / 1000) - now.timeIntervalSince1970))
                return "retrying (\(a.attempts)/\(a.maxAttempts), next in \(secs)s)"
            }
            return "retrying (\(a.attempts)/\(a.maxAttempts))"
        case "stalled":
            if let ms = a.stalledForMs { return "stalled \(short(ms))" }
            return "stalled"
        case "paused-offline": return "paused (offline)"
        case "paused-usage-limit": return "paused (usage limit)"
        case "paused-manual": return "paused"
        case "failed-terminal": return "failed"
        case "done": return "done"
        default: return a.state // forward-compatible: show, dimmed
        }
    }

    static func runChip(_ state: String) -> (text: String, color: Color) {
        switch state {
        case "warning": return ("warning", .orange)
        case "completed-with-failures": return ("completed with failures", .orange)
        case "recovering": return ("recovering", Palette.mint)
        case "completed": return ("completed", .green)
        case "running": return ("running", .green)
        default: return (state, .secondary)
        }
    }

    static func agentDot(_ state: String) -> Color {
        switch state {
        case "failed-terminal": return .red
        case "retrying": return Palette.mint
        case "stalled": return .orange
        case "paused-offline", "paused-usage-limit", "paused-manual": return .gray
        case "done": return .green
        default: return .green
        }
    }

    /** A compact "3m 20s" from milliseconds, for durations. */
    static func short(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        if s < 60 { return "\(s)s" }
        let m = s / 60, rem = s % 60
        if m < 60 { return rem == 0 ? "\(m)m" : "\(m)m \(rem)s" }
        let h = m / 60
        return "\(h)h \(m % 60)m"
    }
}

enum Palette {
    static let mint = Color(red: 0.0, green: 0.784, blue: 0.702) // #00C8B3, dark variant handled by system blending
}

// MARK: - Health rollup for the status-item tint

enum Health: Int { case ok = 0, recovering = 1, warning = 2, failed = 3 }

func overallHealth(_ snap: StatusSnapshot?) -> Health {
    guard let snap else { return .ok }
    var h = Health.ok
    for run in snap.runs {
        let runH: Health
        switch run.state {
        case "warning", "completed-with-failures": runH = .warning
        case "recovering": runH = .recovering
        default:
            runH = run.agents.contains { $0.state == "failed-terminal" || $0.state == "stalled" } ? .warning : .ok
        }
        // a run whose agents ALL failed is a real failure
        if !run.agents.isEmpty && run.agents.allSatisfy({ $0.state == "failed-terminal" }) {
            h = .failed
        }
        if runH.rawValue > h.rawValue { h = runH }
    }
    return h
}

// MARK: - Popover views

struct PopoverView: View {
    @ObservedObject var model: Model
    /// In the detached (torn-off) window the layout goes flexible; in the popover it is
    /// the fixed 360pt instrument. Same content either way — the model is shared.
    var inWindow: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.coreState != .installed {
                SetupView(model: model)
            } else {
                header
                Divider()
                if model.staleSeconds != nil && model.staleSeconds! > 30 {
                    staleBanner
                }
                content
                Divider()
                footer
            }
        }
        .frame(
            minWidth: 360,
            maxWidth: inWindow ? .infinity : 360,
            minHeight: inWindow ? 420 : nil,
            maxHeight: inWindow ? .infinity : nil,
            alignment: .topLeading
        )
        .font(.system(size: 13))
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                PulseGlyph(color: model.health == .ok ? Palette.mint : (model.health == .failed ? .red : .orange), flat: model.daemonQuiet)
                    .frame(width: 22, height: 14)
                Text("lifeline").fontWeight(.semibold)
                Spacer()
                Text(model.daemonQuiet ? "quiet" : (model.snapshot?.online == false ? "offline" : "online"))
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 8).padding(.vertical, 1.5)
                    .background((model.daemonQuiet || model.snapshot?.online == false ? Color.orange : Palette.mint).opacity(0.16))
                    .foregroundStyle(model.daemonQuiet || model.snapshot?.online == false ? Color.orange : Palette.mint)
                    .clipShape(Capsule())
            }
            Text(model.summaryLine).foregroundStyle(.secondary)
            healthStrip
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 10, trailing: 16))
    }

    var healthStrip: some View {
        GeometryReader { geo in
            let frac = model.healthyFraction
            HStack(spacing: 0) {
                Rectangle().fill(Palette.mint).frame(width: geo.size.width * frac)
                Rectangle().fill(Color.orange.opacity(0.9)).frame(width: geo.size.width * (1 - frac))
            }
        }
        .frame(height: 2)
        .clipShape(Capsule())
        .padding(.top, 8)
    }

    var staleBanner: some View {
        // Single interpolated Text (the `+` concatenation is deprecated on macOS 26).
        Text("**The watcher has gone quiet.** Its last update was \(model.staleDescription) ago, so what's below may be stale. Run `lifeline doctor` in a terminal to check on it.")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }

    @ViewBuilder var content: some View {
        if let snap = model.snapshot, !snap.runs.isEmpty {
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(snap.runs) { run in
                        RunRow(run: run, model: model)
                    }
                }
                .padding(.vertical, 4).padding(.horizontal, 8)
            }
            .frame(maxHeight: inWindow ? .infinity : 340)
            .opacity(model.daemonQuiet ? 0.55 : 1)
        } else {
            VStack(spacing: 4) {
                PulseGlyph(color: Color.secondary.opacity(0.5), flat: false)
                    .frame(width: 56, height: 32)
                    .padding(.bottom, 8)
                Text("No workflows tracked yet")
                Text("Start a workflow in Claude Code and it will appear here, watched.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(EdgeInsets(top: 34, leading: 24, bottom: 38, trailing: 24))
        }
    }

    var footer: some View {
        HStack {
            Text("Updated \(model.updatedAgo)").foregroundStyle(.secondary)
            Spacer()
            Button("Quit lifeline") { NSApp.terminate(nil) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .font(.system(size: 11))
        .padding(EdgeInsets(top: 9, leading: 16, bottom: 9, trailing: 16))
    }
}

/// Duration + a compact context-window meter that warms as the window fills.
struct MetaView: View {
    var durationMs: Double?
    var contextFrac: Double?
    var body: some View {
        HStack(spacing: 8) {
            if let d = durationMs { Text(Vocab.short(d)).font(.system(size: 11)).monospacedDigit().foregroundStyle(.tertiary) }
            if let c = contextFrac {
                let color: Color = c >= 0.85 ? Color(red: 0.88, green: 0.38, blue: 0.24)
                    : c >= 0.7 ? Color(red: 0.88, green: 0.64, blue: 0.24) : Color(red: 0.24, green: 0.61, blue: 0.56)
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.22)).frame(width: 26, height: 5)
                    Capsule().fill(color).frame(width: 26 * CGFloat(c), height: 5)
                }
                .help("Context window \(Int(c * 100))% full")
            }
        }
    }
}

struct RunRow: View {
    let run: StatusRun
    @ObservedObject var model: Model
    @State private var hovering = false

    var expanded: Bool { model.isRunExpanded(run.runId) }
    var hasFailures: Bool { run.agents.contains { $0.state == "failed-terminal" } }
    var isPaused: Bool { run.agents.contains { $0.state == "paused-manual" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9)).foregroundStyle(.secondary).frame(width: 10)
                Circle().fill(Vocab.runChip(run.state).color).frame(width: 8, height: 8)
                Text(run.project.split(separator: "-").last.map(String.init) ?? run.project)
                    .fontWeight(.semibold).lineLimit(1)
                let chip = Vocab.runChip(run.state)
                Text(chip.text)
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 7).padding(.vertical, 1.5)
                    .background(chip.color.opacity(0.16)).foregroundStyle(chip.color)
                    .clipShape(Capsule())
                Spacer()
                if run.tty != nil || run.cwd != nil {
                    Button { model.revealTerminal(run) } label: {
                        Image(systemName: "macwindow").font(.system(size: 11))
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .opacity(hovering ? 0.7 : 0)
                    .help("Open the terminal running this workflow")
                }
                MetaView(durationMs: run.durationMs ?? nil, contextFrac: run.contextFrac ?? nil)
            }
            .padding(.vertical, 5).padding(.horizontal, 8)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture { model.toggleRun(run.runId) }

            if let note = run.note, !note.isEmpty {
                Text(note).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
                    .padding(.leading, 34).padding(.trailing, 8).padding(.bottom, 3)
            }

            // The caller: the human's claude session that launched this run. Last line always
            // shown; tap to see the last couple. Distinct from the run's own narrator.
            if let caller = run.callerTail, !caller.isEmpty {
                let showAll = model.expandedAgents.contains("caller:" + run.runId)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 7) {
                        Text("your session").font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15)).clipShape(Capsule())
                            .foregroundStyle(.secondary)
                        Text(caller.last ?? "").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    if showAll {
                        ForEach(caller.dropLast(), id: \.self) { l in
                            Text(l).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.leading, 34).padding(.trailing, 8).padding(.bottom, 4)
                .contentShape(Rectangle())
                .onTapGesture { if caller.count > 1 { model.toggleAgent("caller:" + run.runId) } }
            }

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(run.agents) { agent in
                        AgentRow(agent: agent, runId: run.runId, model: model)
                    }
                }
                .padding(.leading, 26)

                HStack(spacing: 6) {
                    if hasFailures {
                        SmallButton(title: "Retry failed agents", prominent: false) {
                            model.send(kind: "retry", runId: run.runId, agentId: nil)
                        }
                    }
                    if isPaused {
                        SmallButton(title: "Resume run", prominent: false) {
                            model.send(kind: "resume", runId: run.runId, agentId: nil)
                        }
                    } else {
                        SmallButton(title: "Pause run", prominent: false) {
                            model.send(kind: "pause", runId: run.runId, agentId: nil)
                        }
                    }
                }
                .padding(EdgeInsets(top: 2, leading: 34, bottom: 8, trailing: 8))
            }
        }
    }
}

struct AgentRow: View {
    let agent: StatusAgent
    let runId: String
    @ObservedObject var model: Model

    var stateColor: Color {
        switch agent.state {
        case "failed-terminal": return Color(red: 0.85, green: 0.33, blue: 0.18)
        case "stalled": return .orange
        case "retrying": return Palette.mint
        default: return .secondary
        }
    }
    var isOpen: Bool { agent.agentId.map { model.expandedAgents.contains($0) } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(Vocab.agentDot(agent.state)).frame(width: 8, height: 8)
                Text(agent.item ?? String((agent.agentId ?? "agent").prefix(12))).lineLimit(1)
                Text(Vocab.agentLabel(agent, now: model.now)).font(.system(size: 11)).foregroundStyle(stateColor)
                Spacer()
                MetaView(durationMs: agent.durationMs ?? nil, contextFrac: agent.contextFrac ?? nil)
                if agent.state == "failed-terminal" || agent.state == "stalled" {
                    SmallButton(title: "Retry", prominent: true) {
                        model.send(kind: "retry", runId: runId, agentId: agent.agentId)
                    }
                } else if agent.state == "paused-manual" {
                    SmallButton(title: "Resume", prominent: false) {
                        model.send(kind: "resume", runId: runId, agentId: agent.agentId)
                    }
                }
            }
            .padding(.vertical, 3).padding(.horizontal, 8)
            .contentShape(Rectangle())
            .onTapGesture { if let id = agent.agentId { model.toggleAgent(id) } }

            if isOpen, let tail = agent.tail, !tail.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(tail.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(line.range(of: "API Error", options: .caseInsensitive) != nil
                                ? Color(red: 0.85, green: 0.33, blue: 0.18) : .secondary)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.22)).clipShape(RoundedRectangle(cornerRadius: 6))
                .padding(.horizontal, 8).padding(.bottom, 4)
            }
        }
    }
}

/// First-run consent + install narration. Copy from design/menubar/app-copy.md (Luke's voice).
struct SetupView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                PulseGlyph(color: Color.secondary.opacity(0.6), flat: model.coreState != .installing)
                    .frame(width: 22, height: 14)
                Text("lifeline").fontWeight(.semibold)
                Spacer()
                Text("not set up").font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 8).padding(.vertical, 1.5)
                    .background(Color.orange.opacity(0.18)).foregroundStyle(.orange).clipShape(Capsule())
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 12, trailing: 16))
            Divider()

            if model.coreState == .installing {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.installProgress >= 1 ? "Done" : "Setting up…").fontWeight(.semibold)
                    Text(model.installStep).font(.system(size: 12)).foregroundStyle(.secondary)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.secondary.opacity(0.2)).frame(height: 3)
                            Capsule().fill(Palette.mint).frame(width: geo.size.width * model.installProgress, height: 3)
                        }
                    }.frame(height: 3)
                }
                .padding(16)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("lifeline isn't set up yet").font(.system(size: 14, weight: .semibold))
                    Text("It sits next to Claude Code and brings back the workflow agents it quietly drops. Setting it up adds three background helpers that:")
                        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    ForEach([
                        "retry rate limits, overloads and dropped connections",
                        "bring back agents that fall over or stall, and wait out usage caps",
                        "re-check compatibility whenever Claude Code updates",
                    ], id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle().fill(Palette.mint).frame(width: 6, height: 6).padding(.top, 5)
                            Text(line).font(.system(size: 12))
                        }
                    }
                    if model.learnOpen {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Adds three background helpers (a gateway, a watcher, a version check).")
                            Text("Points your claude command through the gateway; claude stays the command.")
                            Text("Never modifies Anthropic's app.")
                            Text("Reversible: one command removes everything.")
                        }
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.black.opacity(0.2)).clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    HStack(spacing: 8) {
                        Button("Set up lifeline") { model.runInstall() }.buttonStyle(.borderedProminent).tint(Palette.mint)
                        Button(model.learnOpen ? "Hide details" : "What it changes") { model.learnOpen.toggle() }.buttonStyle(.bordered)
                    }.padding(.top, 4)
                }
                .padding(16)
            }
            Divider()
            HStack {
                Text(model.coreState == .installing ? "About a minute, and reversible any time." : "Nothing happens until you say so.")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Quit lifeline") { NSApp.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .font(.system(size: 11)).padding(EdgeInsets(top: 9, leading: 16, bottom: 9, trailing: 16))
        }
    }
}

struct SmallButton: View {
    let title: String
    let prominent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: prominent ? .semibold : .medium))
                .padding(.horizontal, 10).frame(height: 20)
                .background(prominent ? Palette.mint : Color.primary.opacity(0.07))
                .foregroundStyle(prominent ? Color.black.opacity(0.8) : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// The Recovery Pulse motif, drawn in code so it can serve as both the header glyph
/// and (as a template image) the status-item icon.
struct PulseGlyph: View {
    var color: Color
    var flat: Bool

    var body: some View {
        Canvas { ctx, size in
            var path = Path()
            let pts: [(CGFloat, CGFloat)] = flat
                ? [(0.05, 0.64), (0.95, 0.64)]
                : [(0.05, 0.64), (0.32, 0.64), (0.39, 0.72), (0.45, 0.64), (0.52, 0.64),
                   (0.61, 0.21), (0.70, 0.79), (0.77, 0.46), (0.95, 0.46)]
            path.move(to: CGPoint(x: pts[0].0 * size.width, y: pts[0].1 * size.height))
            for p in pts.dropFirst() {
                path.addLine(to: CGPoint(x: p.0 * size.width, y: p.1 * size.height))
            }
            ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: max(2, size.height * 0.16), lineCap: .round, lineJoin: .round))
        }
    }
}

// MARK: - Model

final class Model: ObservableObject {
    @Published var snapshot: StatusSnapshot?
    @Published var staleSeconds: TimeInterval?
    @Published var now = Date()
    @Published var expandedAgents: Set<String> = []
    /// Runs the user has collapsed. Persisted here (not local @State) so a 1.5s snapshot
    /// refresh never springs a collapsed run back open.
    @Published var collapsedRuns: Set<String> = []
    @Published var coreState: CoreState = .installed
    @Published var installStep: String = ""
    @Published var installProgress: Double = 0
    @Published var learnOpen = false

    enum CoreState: Equatable { case installed, notInstalled, installing }

    /// The core is present when its config exists and the daemon is (recently) writing status.
    func detectCore() {
        let home = Lifeline.home
        let hasConfig = FileManager.default.fileExists(atPath: home.appendingPathComponent("config.json").path)
        let daemonFresh = (staleSeconds ?? .infinity) < 120
        if coreState == .installing { return } // don't fight an in-progress install
        coreState = (hasConfig || daemonFresh) ? .installed : .notInstalled
    }

    /// Run the bundled/known installer, narrating progress. The core genuinely being required
    /// is why this is offered on launch; consent (the button) is why nothing runs unasked.
    func runInstall() {
        coreState = .installing
        installProgress = 0.08
        installStep = "Setting up…"
        let steps = [
            (0.22, "Starting the connection helper"),
            (0.46, "Starting the workflow watcher"),
            (0.70, "Routing claude through the helper (claude stays your command)"),
            (0.92, "Recording a compatibility fingerprint of your Claude Code"),
        ]
        // Drive the installer; stream a coarse narration. The real work is install.sh.
        let script = Self.installerPath()
        DispatchQueue.global().async {
            for (p, s) in steps {
                DispatchQueue.main.async { self.installProgress = p; self.installStep = s }
                Thread.sleep(forTimeInterval: 0.9)
            }
            var ok = false
            if let script {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/bin/bash")
                proc.arguments = [script]
                proc.standardOutput = Pipe(); proc.standardError = Pipe()
                do { try proc.run(); proc.waitUntilExit(); ok = proc.terminationStatus == 0 } catch { ok = false }
            }
            DispatchQueue.main.async {
                self.installProgress = 1
                self.installStep = ok ? "Set up. lifeline's watching." : "Set up couldn't finish. See a terminal."
                self.detectCore()
                if ok { self.coreState = .installed }
            }
        }
    }

    /// install.sh next to the app bundle (standalone), or the known checkout, or nil.
    static func installerPath() -> String? {
        let candidates = [
            Bundle.main.url(forResource: "install", withExtension: "sh")?.path,
            Lifeline.home.appendingPathComponent("app/install.sh").path,
        ].compactMap { $0 }
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    func toggleAgent(_ id: String) {
        if expandedAgents.contains(id) { expandedAgents.remove(id) } else { expandedAgents.insert(id) }
    }
    func toggleRun(_ id: String) {
        if collapsedRuns.contains(id) { collapsedRuns.remove(id) } else { collapsedRuns.insert(id) }
    }
    func isRunExpanded(_ id: String) -> Bool { !collapsedRuns.contains(id) }

    /// Best-effort: raise the terminal window/tab running this workflow's claude session.
    func revealTerminal(_ run: StatusRun) {
        TerminalRevealer.reveal(tty: run.tty, cwd: run.cwd, term: run.term)
    }

    var daemonQuiet: Bool { (staleSeconds ?? .infinity) > 30 }
    var health: Health { overallHealth(snapshot) }

    var summaryLine: String {
        guard let snap = snapshot, !snap.runs.isEmpty else { return "Nothing tracked" }
        let n = snap.runs.count
        let attention = snap.runs.filter {
            $0.state == "warning" || $0.state == "completed-with-failures"
                || $0.agents.contains { a in a.state == "failed-terminal" }
        }.count
        let word = n == 1 ? "workflow" : "workflows"
        return attention == 0
            ? "\(n) \(word) tracked · all healthy"
            : "\(n) \(word) tracked · \(attention) needs a look"
    }

    var healthyFraction: CGFloat {
        guard let snap = snapshot else { return 1 }
        let agents = snap.runs.flatMap(\.agents)
        guard !agents.isEmpty else { return 1 }
        let bad = agents.filter { $0.state == "failed-terminal" || $0.state.hasPrefix("paused") }.count
        return CGFloat(agents.count - bad) / CGFloat(agents.count)
    }

    var updatedAgo: String {
        guard let s = staleSeconds else { return "never" }
        if s < 5 { return "just now" }
        if s < 90 { return "\(Int(s))s ago" }
        return "\(Int(s / 60))m ago"
    }

    var staleDescription: String {
        guard let s = staleSeconds else { return "a while" }
        if s < 120 { return "\(Int(s)) seconds" }
        return "\(Int(s / 60)) minutes"
    }

    func refresh() {
        let (snap, age) = Lifeline.readSnapshot()
        snapshot = snap
        staleSeconds = age
        now = Date()
        detectCore()
    }

    func send(kind: String, runId: String, agentId: String?) {
        Lifeline.writeIntent(kind: kind, runId: runId, agentId: agentId)
        // No optimistic state mutation: the daemon is the single writer of truth and the
        // next poll reflects whatever it actually did.
    }
}

// MARK: - App delegate: status item + popover + polling

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let model = Model()
    private var timer: Timer?
    private var lastHealth: Health = .ok
    private var detachedWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = Self.pulseImage(flat: false)
            button.image?.isTemplate = true
            button.action = #selector(togglePopover(_:))
            button.target = self
        }

        popover.behavior = .transient // click-away and Esc both close it
        popover.delegate = self       // enables drag-to-detach (the system's own tear-off)
        popover.contentViewController = NSHostingController(rootView: PopoverView(model: model))

        model.refresh()
        applyHealthTint()

        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.model.refresh()
            self.applyHealthTint()
        }
    }

    // MARK: tear-off — drag the popover away and it becomes a real, resizable window.
    // AppKit animates the detach; we only supply the destination window. The window
    // hosts a SECOND view over the SAME model, so both surfaces stay live.

    func popoverShouldDetach(_ popover: NSPopover) -> Bool { true }

    func detachableWindow(for popover: NSPopover) -> NSWindow? {
        if let existing = detachedWindow { return existing }
        let hosting = NSHostingController(rootView: PopoverView(model: model, inWindow: true))
        let window = NSWindow(contentViewController: hosting)
        window.title = "lifeline"
        window.styleMask = [.titled, .closable, .resizable, .miniaturizable]
        window.contentMinSize = NSSize(width: 360, height: 420)
        window.setContentSize(NSSize(width: 520, height: 480))
        window.isReleasedWhenClosed = false // reused on the next tear-off
        detachedWindow = window
        return window
    }

    private func applyHealthTint() {
        guard let button = statusItem.button else { return }
        let health = model.daemonQuiet ? Health.ok : model.health
        // Template image handles default tinting; explicit tint only for attention states.
        switch health {
        case .warning:
            button.contentTintColor = .systemOrange
        case .failed:
            button.contentTintColor = .systemRed
        case .recovering:
            button.contentTintColor = NSColor(red: 0, green: 0.784, blue: 0.702, alpha: 1)
        case .ok:
            button.contentTintColor = model.daemonQuiet ? .tertiaryLabelColor : nil
        }
        button.toolTip = model.summaryLine
        lastHealth = health
    }

    @objc private func togglePopover(_ sender: Any?) {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            model.refresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    /// The pulse as an 18x12pt template image for the menu bar.
    static func pulseImage(flat: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 12)
        let img = NSImage(size: size, flipped: false) { rect in
            let pts: [(CGFloat, CGFloat)] = flat
                ? [(0.05, 0.36), (0.95, 0.36)]
                : [(0.05, 0.36), (0.32, 0.36), (0.39, 0.28), (0.45, 0.36), (0.52, 0.36),
                   (0.61, 0.79), (0.70, 0.21), (0.77, 0.54), (0.95, 0.54)]
            let path = NSBezierPath()
            path.lineWidth = 2
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            path.move(to: NSPoint(x: pts[0].0 * rect.width, y: pts[0].1 * rect.height))
            for p in pts.dropFirst() {
                path.line(to: NSPoint(x: p.0 * rect.width, y: p.1 * rect.height))
            }
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        img.isTemplate = true
        return img
    }
}

// MARK: - main

@main
enum LifelineMenubarApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        objc_setAssociatedObject(app, "lifelineDelegate", delegate, .OBJC_ASSOCIATION_RETAIN)
        app.run()
    }
}
