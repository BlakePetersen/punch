// ABOUTME: Principal class for the spike's com.apple.screensaver extension; exists only to prove it was loaded.
// ABOUTME: Mirrors AppexSaverMinimal's empty ScreenSaverExtension subclass (MIT, see THIRD_PARTY_NOTICES.md).

import Foundation
import os
import ScreenSaver

@objc(PunchSpikeSaverExtension)
class PunchSpikeSaverExtension: ScreenSaverExtension {
    @objc override init() {
        let pid = ProcessInfo.processInfo.processIdentifier
        Logger(subsystem: "io.blakepetersen.punch.spike", category: "ladder")
            .info("RUNG extensionInit role=saver pid=\(pid, privacy: .public)")
        super.init()
    }
}
