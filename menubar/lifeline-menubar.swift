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
    var id: String { runId }
}

struct StatusAgent: Decodable, Identifiable {
    var agentId: String?
    var item: String?
    var state: String   // retrying | paused-offline | paused-usage-limit | paused-manual | failed-terminal | done
    var attempts: Int
    var maxAttempts: Int
    var nextRetryAt: Double?
    var lastClass: String?
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
        case "paused-offline", "paused-usage-limit", "paused-manual": return .gray
        case "done": return .green
        default: return .green
        }
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
            runH = run.agents.contains { $0.state == "failed-terminal" } ? .warning : .ok
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if model.staleSeconds != nil && model.staleSeconds! > 30 {
                staleBanner
            }
            content
            Divider()
            footer
        }
        .frame(width: 360)
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
        (Text("The watcher has gone quiet. ").fontWeight(.semibold)
            + Text("Its last update was \(model.staleDescription) ago, so what's below may be stale. Run ")
            + Text("lifeline doctor").font(.system(size: 11, design: .monospaced))
            + Text(" in a terminal to check on it."))
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
            .frame(maxHeight: 340)
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

struct RunRow: View {
    let run: StatusRun
    @ObservedObject var model: Model
    @State private var expanded = true

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
                Text(String(run.runId.prefix(11)))
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
                Spacer()
                let chip = Vocab.runChip(run.state)
                Text(chip.text)
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 7).padding(.vertical, 1.5)
                    .background(chip.color.opacity(0.16))
                    .foregroundStyle(chip.color)
                    .clipShape(Capsule())
            }
            .padding(.vertical, 5).padding(.horizontal, 8)
            .contentShape(Rectangle())
            .onTapGesture { expanded.toggle() }

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(run.agents) { agent in
                        AgentRow(agent: agent, runId: run.runId, model: model)
                    }
                }
                .padding(.leading, 26)

                HStack(spacing: 6) {
                    if hasFailures {
                        SmallButton(title: "Retry all failed", prominent: false) {
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

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Vocab.agentDot(agent.state)).frame(width: 8, height: 8)
            Text(agent.item ?? String((agent.agentId ?? "agent").prefix(12))).lineLimit(1)
            Spacer()
            Text(Vocab.agentLabel(agent, now: model.now))
                .font(.system(size: 11)).foregroundStyle(.secondary)
            if agent.state == "failed-terminal" {
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
    }

    func send(kind: String, runId: String, agentId: String?) {
        Lifeline.writeIntent(kind: kind, runId: runId, agentId: agentId)
        // No optimistic state mutation: the daemon is the single writer of truth and the
        // next poll reflects whatever it actually did.
    }
}

// MARK: - App delegate: status item + popover + polling

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let model = Model()
    private var timer: Timer?
    private var lastHealth: Health = .ok

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
        popover.contentViewController = NSHostingController(rootView: PopoverView(model: model))

        model.refresh()
        applyHealthTint()

        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.model.refresh()
            self.applyHealthTint()
        }
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
