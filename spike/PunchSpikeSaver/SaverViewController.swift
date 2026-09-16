// ABOUTME: Screensaver view controller for the spike: starts an audio tap once its view reaches a window.
// ABOUTME: Shows the latest checkpoint on screen so a person can read the result without a log stream.

import AppKit
import ScreenSaver

@objc(PunchSpikeSaverViewController)
class PunchSpikeSaverViewController: ScreenSaverViewController {
    override func loadView() {
        let frame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
        let view = ProbeView(frame: frame)
        view.probe.rung("loadView", "frame=\(Int(frame.width))x\(Int(frame.height))")
        self.view = view
    }
}

final class ProbeView: NSView {
    private let label = NSTextField(wrappingLabelWithString: "loaded")
    private var started = false
    private(set) lazy var probe = AudioTapProbe(role: "saver") { [weak self] line in
        self?.label.stringValue = line
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        label.font = .monospacedSystemFont(ofSize: 28, weight: .medium)
        label.textColor = .white
        label.frame = bounds.insetBy(dx: 40, dy: 40)
        label.autoresizingMask = [.width, .height]
        addSubview(label)

        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screensaverWillStop),
            name: NSNotification.Name("com.apple.screensaver.willstop"),
            object: nil
        )
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, !started {
            started = true
            probe.rung("viewInWindow")
            probe.start()
        } else if window == nil, started {
            started = false
            probe.stop()
        }
    }

    @objc private func screensaverWillStop() {
        guard started else { return }
        started = false
        probe.stop()
    }
}
