// ABOUTME: Creates a global CoreAudio process tap and reports progress as a ladder of named checkpoints.
// ABOUTME: Shared by the spike host app and screensaver extension so each process's audio access can be compared.

import CoreAudio
import Foundation
import os

final class AudioTapProbe {
    private let role: String
    private let log = Logger(subsystem: "io.blakepetersen.punch.spike", category: "ladder")
    private let onUpdate: (String) -> Void
    private let queue = DispatchQueue(label: "io.blakepetersen.punch.spike.tap")

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    private var windowPeakRMS: Float = 0
    private var windowStart = Date()
    private var sawFirstBuffer = false
    private var sawNonSilentAudio = false

    init(role: String, onUpdate: @escaping (String) -> Void) {
        self.role = role
        self.onUpdate = onUpdate
    }

    func rung(_ name: String, _ detail: String = "") {
        let pid = ProcessInfo.processInfo.processIdentifier
        log.info("RUNG \(name, privacy: .public) role=\(self.role, privacy: .public) pid=\(pid, privacy: .public) \(detail, privacy: .public)")
        let line = "\(name) \(detail)"
        DispatchQueue.main.async { self.onUpdate(line) }
    }

    func start() {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard succeeded(status, "tapCreated", "tapID=\(tapID)") else { return }

        rung("tapFormat", formatDescription())

        guard let outputUID = defaultOutputDeviceUID() else {
            rung("FAILED", "no default output device UID")
            return
        }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Punch Spike Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard succeeded(status, "aggregateCreated", "aggregateID=\(aggregateID)") else { return }

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) { [weak self] _, input, _, _, _ in
            self?.meter(input)
        }
        guard succeeded(status, "ioProcCreated") else { return }

        status = AudioDeviceStart(aggregateID, ioProcID)
        _ = succeeded(status, "deviceStarted")
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, ioProcID)
            if let ioProcID { AudioDeviceDestroyIOProcID(aggregateID, ioProcID) }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        rung("stopped")
    }

    private func meter(_ input: UnsafePointer<AudioBufferList>) {
        if !sawFirstBuffer {
            sawFirstBuffer = true
            rung("firstBuffer")
        }

        var sumOfSquares: Float = 0
        var sampleCount = 0
        for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)) {
            guard let data = buffer.mData else { continue }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
            let samples = data.bindMemory(to: Float32.self, capacity: count)
            for index in 0..<count {
                sumOfSquares += samples[index] * samples[index]
            }
            sampleCount += count
        }
        guard sampleCount > 0 else { return }

        let rms = (sumOfSquares / Float(sampleCount)).squareRoot()
        windowPeakRMS = max(windowPeakRMS, rms)

        if !sawNonSilentAudio && rms > 0.0001 {
            sawNonSilentAudio = true
            rung("nonSilentAudio", String(format: "rms=%.5f", rms))
        }

        if Date().timeIntervalSince(windowStart) >= 1 {
            rung("meter", String(format: "peakRMS=%.5f", windowPeakRMS))
            windowPeakRMS = 0
            windowStart = Date()
        }
    }

    private func succeeded(_ status: OSStatus, _ name: String, _ detail: String = "") -> Bool {
        guard status == noErr else {
            rung("FAILED", "\(name) status=\(status) \(fourCharacterCode(status))")
            return false
        }
        rung(name, detail)
        return true
    }

    private func formatDescription() -> String {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format)
        guard status == noErr else { return "unreadable status=\(status)" }
        return "rate=\(format.mSampleRate) channels=\(format.mChannelsPerFrame) bits=\(format.mBitsPerChannel) flags=\(format.mFormatFlags)"
    }

    private func defaultOutputDeviceUID() -> String? {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr else {
            return nil
        }

        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid) == noErr, let uid else {
            return nil
        }
        return uid.takeRetainedValue() as String
    }

    private func fourCharacterCode(_ status: OSStatus) -> String {
        let bytes = withUnsafeBytes(of: UInt32(bitPattern: status).bigEndian, Array.init)
        guard bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) else { return "" }
        return "'" + String(decoding: bytes, as: UTF8.self) + "'"
    }
}
