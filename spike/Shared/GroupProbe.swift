// ABOUTME: Probes App Group sharing for #8: resolves the shared container, reads and writes one setting through
// ABOUTME: UserDefaults(suiteName:) and a file, and reports which change mechanism fires in the observing process.

import Foundation
import os

final class GroupProbe: NSObject {
    private let role: String
    private let log = Logger(subsystem: "io.blakepetersen.punch.spike", category: "ladder")
    private let onUpdate: (String) -> Void

    let groupID: String
    private let defaults: UserDefaults?
    private let containerURL: URL?
    private var fileURL: URL? { containerURL?.appendingPathComponent("settings.json") }

    private var lastSeen: Int?
    private var directorySource: DispatchSourceFileSystemObject?
    private var pollTimer: Timer?
    private var kvoContext = 0

    init(role: String, onUpdate: @escaping (String) -> Void) {
        self.role = role
        self.onUpdate = onUpdate
        let bundle = Bundle(for: GroupProbe.self)
        groupID = bundle.object(forInfoDictionaryKey: "PunchGroupID") as? String ?? "missing"
        defaults = UserDefaults(suiteName: groupID)
        containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID)
        super.init()
    }

    func rung(_ name: String, _ detail: String = "") {
        let pid = ProcessInfo.processInfo.processIdentifier
        log.info("RUNG \(name, privacy: .public) role=\(self.role, privacy: .public) pid=\(pid, privacy: .public) \(detail, privacy: .public)")
        let line = "\(name) \(detail)"
        DispatchQueue.main.async { self.onUpdate(line) }
    }

    // Reports where the container is and whether the sandbox lets this process see it.
    func locate() {
        guard let containerURL else {
            rung("FAILED", "groupContainer no URL for \(groupID)")
            return
        }
        let exists = FileManager.default.fileExists(atPath: containerURL.path)
        rung("groupContainer", "group=\(groupID) path=\(containerURL.path) exists=\(exists)")
    }

    func write(hue: Int) {
        defaults?.set(hue, forKey: "hue")
        defaults?.synchronize()
        guard let fileURL else { return }
        do {
            let payload = ["hue": hue, "at": Int(Date().timeIntervalSince1970)]
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: fileURL, options: .atomic)
            rung("groupWrite", "hue=\(hue) file=\(fileURL.lastPathComponent)")
        } catch {
            rung("FAILED", "groupWrite \(error)")
        }
    }

    @discardableResult
    func read(reason: String) -> (defaults: Int?, file: Int?) {
        let fromDefaults = defaults?.object(forKey: "hue") as? Int
        var fromFile: Int?
        var fileNote = "none"
        if let fileURL {
            do {
                let data = try Data(contentsOf: fileURL)
                fromFile = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["hue"] as? Int
                fileNote = fromFile.map(String.init) ?? "unparsed"
            } catch {
                fileNote = "error=\((error as NSError).code) \((error as NSError).domain)"
            }
        }
        rung("groupRead", "reason=\(reason) defaults=\(fromDefaults.map(String.init) ?? "nil") file=\(fileNote)")
        return (fromDefaults, fromFile)
    }

    // Three candidate live-update mechanisms run side by side so the log says which one fires, and how fast.
    func observe() {
        lastSeen = read(reason: "observeStart").defaults

        defaults?.addObserver(self, forKeyPath: "hue", options: [.new], context: &kvoContext)

        if let containerURL {
            let fd = open(containerURL.path, O_EVTONLY)
            if fd >= 0 {
                let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: .main)
                source.setEventHandler { [weak self] in
                    guard let self else { return }
                    let value = self.read(reason: "dirwatch").file
                    self.rung("groupLive", "mechanism=dirwatch hue=\(value.map(String.init) ?? "nil")")
                }
                source.setCancelHandler { close(fd) }
                source.resume()
                directorySource = source
            } else {
                rung("FAILED", "dirwatch open errno=\(errno)")
            }
        }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            let fromDefaults = self.defaults?.object(forKey: "hue") as? Int
            if fromDefaults != self.lastSeen {
                self.lastSeen = fromDefaults
                self.rung("groupLive", "mechanism=poll hue=\(fromDefaults.map(String.init) ?? "nil")")
            }
        }
    }

    func stop() {
        defaults?.removeObserver(self, forKeyPath: "hue", context: &kvoContext)
        directorySource?.cancel()
        directorySource = nil
        pollTimer?.invalidate()
        pollTimer = nil
    }

    override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        guard context == &kvoContext else {
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
            return
        }
        let value = change?[.newKey] as? Int
        lastSeen = value
        rung("groupLive", "mechanism=kvo hue=\(value.map(String.init) ?? "nil")")
    }
}
