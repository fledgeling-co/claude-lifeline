// TerminalRevealer — best-effort "open the terminal running this workflow".
//
// Strategy (from docs/research/terminal-reveal.md), degrading gracefully:
//   Terminal.app / iTerm2  → AppleScript, match the tab/session by its tty (exact)
//   Ghostty                → AppleScript `focus terminal`, match by title/cwd
//   WezTerm                → `wezterm cli activate-pane` by tty_name
//   kitty                  → `kitten @ focus-window` if remote control answers
//   tmux                   → select the pane, then raise its client terminal
//   Warp / Alacritty / ?   → just activate the app by bundle id
//
// Every path is wrapped so a failure only means "the terminal wasn't raised", never a crash.
// AppleScript paths need the Automation (Apple Events) TCC grant on first use.

import AppKit
import Foundation

enum TerminalRevealer {
    /// tty/term/cwd come from status.json (surfaced by the daemon from its per-tty record).
    static func reveal(tty: String?, cwd: String?, term: String?) {
        DispatchQueue.global(qos: .userInitiated).async {
            let program = (term ?? detectTermForTty(tty) ?? "").lowercased()

            if program.contains("apple_terminal") || program.contains("terminal") {
                if let tty, revealTerminalApp(tty: tty) { return }
            }
            if program.contains("iterm") {
                if let tty, revealITerm(tty: tty) { return }
            }
            if program.contains("ghostty") {
                if revealGhostty(cwd: cwd) { return }
            }
            if program.contains("wezterm") {
                if let tty, revealWezTerm(tty: tty) { return }
            }
            if program.contains("vscode") {
                activateBundle("com.microsoft.VSCode"); return
            }
            // tty-based fallback across the two zero-setup AppleScript terminals even when the
            // program name is unknown (a bare ssh/login often reports nothing useful).
            if let tty, revealTerminalApp(tty: tty) { return }
            if let tty, revealITerm(tty: tty) { return }

            // Last resort: bring the likely terminal app forward by bundle id.
            for bundle in ["com.mitchellh.ghostty", "dev.warp.Warp-Stable", "com.googlecode.iterm2",
                           "com.apple.Terminal", "org.alacritty", "com.github.wez.wezterm"] {
                if NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first != nil {
                    activateBundle(bundle); return
                }
            }
        }
    }

    // MARK: AppleScript paths

    private static func revealTerminalApp(tty: String) -> Bool {
        runAppleScript("""
        tell application "Terminal"
            repeat with w in windows
                repeat with t in tabs of w
                    if tty of t is "\(tty)" then
                        set selected tab of w to t
                        set frontmost of w to true
                        activate
                        return true
                    end if
                end repeat
            end repeat
        end tell
        return false
        """)
    }

    private static func revealITerm(tty: String) -> Bool {
        runAppleScript("""
        tell application "iTerm2"
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if tty of s is "\(tty)" then
                            select w
                            select t
                            select s
                            activate
                            return true
                        end if
                    end repeat
                end repeat
            end repeat
        end tell
        return false
        """)
    }

    private static func revealGhostty(cwd: String?) -> Bool {
        // Ghostty (≥1.3) exposes no tty; match the terminal whose working directory is the
        // run's cwd. Ambiguous only if two Ghostty sessions share a cwd.
        guard let cwd else { return false }
        return runAppleScript("""
        tell application "Ghostty"
            repeat with trm in terminals
                try
                    if (working directory of trm) is "\(cwd)" then
                        focus trm
                        activate
                        return true
                    end if
                end try
            end repeat
        end tell
        return false
        """)
    }

    // MARK: CLI paths

    private static func revealWezTerm(tty: String) -> Bool {
        guard let wez = which("wezterm") else { return false }
        guard let listJson = run(wez, ["cli", "list", "--format=json"]) else { return false }
        guard let data = listJson.data(using: .utf8),
              let panes = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return false }
        for pane in panes {
            if let name = pane["tty_name"] as? String, name == tty,
               let paneId = pane["pane_id"] as? Int {
                _ = run(wez, ["cli", "activate-pane", "--pane-id", String(paneId)])
                activateBundle("com.github.wez.wezterm")
                return true
            }
        }
        return false
    }

    // MARK: helpers

    /// Read the daemon's per-tty record to recover the terminal program when status omits it.
    private static func detectTermForTty(_ tty: String?) -> String? {
        guard let tty else { return nil }
        let home = ProcessInfo.processInfo.environment["LIFELINE_HOME"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".lifeline").path
        let safe = tty.replacingOccurrences(of: "/", with: "_")
        let file = URL(fileURLWithPath: home).appendingPathComponent("terminals/\(safe).json")
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["term"] as? String
    }

    @discardableResult
    private static func runAppleScript(_ src: String) -> Bool {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: src) else { return false }
        let result = script.executeAndReturnError(&error)
        if error != nil { return false }
        return result.booleanValue
    }

    private static func activateBundle(_ bundleId: String) {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            app.activate(options: [.activateAllWindows])
        }
    }

    private static func which(_ name: String) -> String? {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let p = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    private static func run(_ path: String, _ args: [String]) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}
