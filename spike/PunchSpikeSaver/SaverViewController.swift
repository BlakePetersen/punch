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
    private let groupLabel = NSTextField(wrappingLabelWithString: "group: waiting")
    private var started = false
    private(set) lazy var probe = AudioTapProbe(role: "saver") { [weak self] line in
        self?.label.stringValue = line
    }
    private lazy var group = GroupProbe(role: "saver") { [weak self] line in
        self?.groupLabel.stringValue = "group: \(line)"
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
        groupLabel.font = .monospacedSystemFont(ofSize: 22, weight: .regular)
        groupLabel.textColor = NSColor(calibratedRed: 1, green: 0.71, blue: 0.33, alpha: 1)
        groupLabel.frame = NSRect(x: 40, y: 40, width: bounds.width - 80, height: 120)
        groupLabel.autoresizingMask = [.width, .maxYMargin]
        addSubview(groupLabel)

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
            group.locate()
            group.observe()
        } else if window == nil, started {
            started = false
            probe.stop()
            group.stop()
        }
    }

    @objc private func screensaverWillStop() {
        guard started else { return }
        started = false
        probe.stop()
        group.stop()
    }
}
