// ABOUTME: Minimal host app for the audio-tap spike: registers the screensaver extension and runs its own tap.
// ABOUTME: Lets a person grant system-audio permission from the app, then compare what the extension receives.

import AppKit

@main
final class HostApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let status = NSTextField(wrappingLabelWithString: "idle")
    private lazy var probe = AudioTapProbe(role: "host") { [weak self] line in
        self?.status.stringValue = line
    }

    static func main() {
        let app = NSApplication.shared
        let delegate = HostApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let buttons = NSStackView(views: [
            NSButton(title: "Start host tap", target: self, action: #selector(startTap)),
            NSButton(title: "Stop host tap", target: self, action: #selector(stopTap)),
            NSButton(title: "Register extension", target: self, action: #selector(registerExtension)),
            NSButton(title: "Open Screen Saver settings", target: self, action: #selector(openSettings)),
        ])
        status.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        let stack = NSStackView(views: [buttons, status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 200),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Punch Spike"
        window.contentView = stack
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @objc private func startTap() { probe.start() }

    @objc private func stopTap() { probe.stop() }

    @objc private func registerExtension() {
        guard let plugIns = Bundle.main.builtInPlugInsURL else { return }
        let appex = plugIns.appendingPathComponent("PunchSpikeSaver.appex")
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
        process.arguments = ["-a", appex.path]
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            probe.rung("pluginkitRegister", "exit=\(process.terminationStatus) \(output)")
        } catch {
            probe.rung("FAILED", "pluginkit \(error)")
        }
    }

    @objc private func openSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.ScreenSaver-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }
}
