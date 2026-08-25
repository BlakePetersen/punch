# Can a screensaver capture system audio on macOS?

Research for [#2](https://github.com/BlakePetersen/punch/issues/2). Part of the map in [#1](https://github.com/BlakePetersen/punch/issues/1).

Investigated 2026-08-24.

---

## Verdict

**Conditionally yes — but not from a `.saver`.**

Three findings, in the order that matters:

1. **The API exists and is the right one.** CoreAudio process taps (`AudioHardwareCreateProcessTap` + `CATapDescription` + a tap-bearing aggregate device) are the current, Apple-documented, non-hacky way to capture system audio output. No virtual driver, no kext, no ScreenCaptureKit. Available since **macOS 14.2** by the header and Apple's own docs; **14.4** is the floor the field actually uses.

2. **A `.saver` cannot do it. This is not a permissions problem you can solve — it is a code-identity problem.** A `.saver` is a bundle loaded *into* Apple's `legacyScreenSaver.appex`. It is not a process. It has no code signature of its own at runtime, therefore no entitlements of its own and no TCC identity of its own. It inherits Apple's, and Apple's grants it nothing: I dumped `legacyScreenSaver.appex`'s entitlements on macOS 27 and there is **no audio entitlement of any kind**, no `NSAudioCaptureUsageDescription`, and no mechanism by which a user could grant one. A companion app *cannot* perform the grant on the saver's behalf, because there is no distinct subject to grant it to.

3. **The escape hatch is real, and someone is already shipping it.** Apple's screensaver extension point `com.apple.screensaver` accepts third-party `.appex` bundles. An `.appex` **is** its own process, with its own signature, its own entitlements, its own Info.plist, and its own TCC identity. The Aerial screensaver (v4, macOS 15+) ships exactly this way — notarized, third-party, holding its own sandbox entitlements and its own **TCC-gated Location grant**. The API is *private and undocumented*, which is the cost.

**Recommended path: build Punch's screensaver as a `com.apple.screensaver` `.appex` inside the companion app, not as a `.saver`.** This overturns map decision #1 and moves the OS floor to **macOS 15.0** (unchanged as a number, but for a new reason).

**The one thing I did not verify and cannot verify without code:** that `kTCCServiceAudioCapture` specifically is grantable to a screensaver `.appex`. Aerial proves *a* TCC permission (Location) works there. It does not prove *this* TCC permission works there. **That gap is exactly one prototype wide and should be the next ticket.** See [Open questions](#open-questions).

---

## Provenance

Everything marked VERIFIED-LOCAL was read off this machine:

```
ProductName:    macOS
ProductVersion: 27.0
BuildVersion:   26A5406e
Xcode:          26.6 (17F113)
SDK:            /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
```

Claims are tagged:

- **VERIFIED** — read from Apple's headers, Apple's docs, or a signed binary on this machine.
- **CORROBORATED** — multiple independent secondary sources agree, and it is consistent with primary evidence.
- **INFERRED** — my reasoning from verified facts. Could be wrong.
- **UNVERIFIED** — I could not establish this. Called out explicitly.

---

## Evidence

### 1. Which API is current in 2026

#### CoreAudio process taps — the answer

**VERIFIED.** From `CoreAudio.framework/Headers/AudioHardwareTapping.h` on this machine:

```c
extern OSStatus
AudioHardwareCreateProcessTap(CATapDescription* inDescription,
                              AudioObjectID*  outTapID)
    API_AVAILABLE(macos(14.2)) API_UNAVAILABLE(ios, watchos, tvos);
```

**VERIFIED.** Apple's documentation JSON agrees: `AudioHardwareCreateProcessTap(_:_:)` — *"Introduced: macOS 14.2"*.
<https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap(_:_:)>

**Note the discrepancy, it matters.** The header and Apple's API reference both say **14.2**. But Apple's own *sample-code article* says *"ensure that you're using macOS 14.2 or later"* while the community — including Guilherme Rambo's `AudioCap`, the most-cited reference implementation — states a floor of **macOS 14.4**. One write-up explains why: *"Earlier versions land in different TCC categories and the prompt copy diverges."* (UNVERIFIED as to the precise reason, but the 14.4 convention is consistent across sources.)

Practical read: **the API is 14.2; the API you can rely on is 14.4.** Punch's floor is macOS 15 anyway, so this is moot for us — but do not write `@available(macOS 14.2, *)` and assume it works on 14.2.

- Apple, *Capturing system audio with Core Audio taps*: <https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps>
- `insidegui/AudioCap` — *"Sample code for recording system audio on macOS 14.4+"*: <https://github.com/insidegui/AudioCap>

**VERIFIED.** `CATapDescription` itself is annotated `API_AVAILABLE(macos(12.0), ios(15.0))` — the *class* predates the create function by two major versions. It was unusable until 14.2 gave you a way to instantiate a tap. Do not let the 12.0 annotation mislead you into thinking taps work on Monterey.

**VERIFIED — new in macOS 26.** `CATapDescription` gained two properties this cycle:

```objc
@property (atomic, copy, readwrite) NSArray<NSString*>* bundleIDs
    API_AVAILABLE(macos(26.0));

@property (atomic, readwrite, getter=isProcessRestoreEnabled) BOOL processRestoreEnabled
    API_AVAILABLE(macos(26.0));
```

Tapping by **bundle ID** rather than by `AudioObjectID`, and having the system restore tapped processes across relaunch. For a visualizer this is genuinely useful later — "react to Spotify specifically" becomes a one-liner on macOS 26+ — but it is not needed for v1's global tap.

**VERIFIED.** The supporting aggregate-device machinery, all present in `AudioHardware.h`:

| Symbol | Value |
|---|---|
| `kAudioAggregateDeviceTapListKey` | `"taps"` |
| `kAudioAggregateDeviceTapAutoStartKey` | `"tapautostart"` |
| `kAudioSubTapUIDKey` | `"uid"` |
| `kAudioAggregateDevicePropertyTapList` | `'tap#'` |
| `kAudioAggregateDevicePropertySubTapList` | `'atap'` |
| `kAudioHardwarePropertyProcessObjectList` | `'prs#'` |
| `kAudioHardwarePropertyTranslatePIDToProcessObject` | `'id2p'` |
| `kAudioHardwarePropertyTapList` | `'tps#'` |
| `kAudioProcessPropertyBundleID` | `'pbid'` |
| `kAudioProcessPropertyIsRunningOutput` | `'piro'` |

#### ScreenCaptureKit audio — rejected, and why

`SCStream` can deliver system audio. It is the wrong tool here for a reason that has nothing to do with capability:

**CORROBORATED.** SCK audio capture is gated on the **Screen Recording** TCC permission (`kTCCServiceScreenCapture`) even when you want no video at all. That means: a scary permission prompt asking for screen access from a *screensaver*, a purple menu-bar recording indicator, and — on macOS 15 — Apple's re-authorization nags. For a screensaver whose entire job is to be ambient and unobtrusive, asking the user for screen-recording rights is a product failure even if it works.

Process taps sit in a **separate, narrower TCC bucket** — `kTCCServiceAudioCapture` — whose prompt says "record system audio", which is what we are actually doing. That is the honest ask.

- Apple Developer Forums, *Is it possible to get only audio from ScreenCaptureKit?*: <https://developer.apple.com/forums/thread/718279>
- On macOS 26 the panel was renamed **"Screen & System Audio Recording"**, consolidating the UI while keeping the services distinct.

#### Anything newer?

**UNVERIFIED / negative result.** I searched WWDC 2025 and 2026 material and Apple release notes for a successor API. WWDC25 session 251 (*Enhance your app's audio recording capabilities*) covers input-device selection, AirPods high-quality recording, and spatial audio — **not** a replacement for process taps. I found no evidence of a newer system-audio-output capture API. Process taps remain current as of macOS 27.

<https://developer.apple.com/videos/play/wwdc2025/251/>

---

### 2. Entitlements, usage descriptions, and TCC

**VERIFIED.** `NSAudioCaptureUsageDescription` — *"A message that tells people why your app is requesting access to capture system audio on macOS."* Introduced **macOS 14.2**.
<https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription>

**VERIFIED-LOCAL.** The TCC service backing it exists on macOS 27. `strings` on `/System/Library/PrivateFrameworks/TCC.framework/Support/tccd` yields both, and only these two, in the same neighbourhood:

```
kTCCServiceAudioCapture
NSAudioCaptureUsageDescription
```

and separately, distinctly:

```
kTCCServiceMicrophone
```

**This is the single most useful fact in this document for scoping the ask:** capturing system output is `kTCCServiceAudioCapture`, which is **not** `kTCCServiceMicrophone`. Punch never needs microphone rights for the hero path.

**VERIFIED.** Apple documents the prompt trigger precisely — and it is not where you would guess:

> "The first time you start recording from an aggregate device that contains a tap, the system prompts you to grant the app system audio recording permission."

So `AudioHardwareCreateProcessTap` does **not** prompt. `AudioDeviceStart` on the tap-bearing aggregate device does. **CORROBORATED** field report: with the plist key missing, `AudioHardwareCreateProcessTap` *returns `noErr` while access is silently denied* — you get a tap that produces nothing but silence, with no error. Budget debugging time for this; it is a trap that looks like a DSP bug.

**VERIFIED.** `com.apple.security.device.audio-input` — *"A Boolean value that indicates whether the app may record audio using the built-in microphone **and access audio input using Core Audio**."* macOS 10.7+.
<https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input>

**INFERRED** (and I want to be clear this is inference): a sandboxed process reading from a tap-backed aggregate device is "accessing audio input using Core Audio", so it needs this entitlement. Apple's taps article never mentions sandboxing at all, and the most detailed field write-up I found simply **turned the sandbox off** (`com.apple.security.app-sandbox = false`), describing taps as *"fragile under sandbox"*. Since a screensaver `.appex` is **forced** to be sandboxed, this is a live risk, not a settled question. See [Open questions](#open-questions).

**CORROBORATED.** Taps require a **stable code-signing identity** — TCC keys its record off it. Unsigned `xcodebuild` output compiles and runs but never prompts, so audio capture silently fails. Test via Xcode or a real signing identity, never an ad-hoc build.

- <https://dgrlabs.co/blog/2026-04-25-capturing-system-audio-on-macos-in-2026.html>

Reset the grant between tests with `tccutil reset` against the bundle ID.

#### An operational hazard that lands squarely on a screensaver

**CORROBORATED**, and I flag it because it is *worse* for our use case than for anyone else's. An open Apple Developer Forums thread reports process taps **silently degrading to all-zero PCM after extended sessions** — minutes to hours in — while system audio remains audible:

- The IOProc keeps firing with correct timestamps and frame counts. Every sample is exactly `0.0f`.
- Correlates with sample-rate renegotiation (44.1 ↔ 48 kHz) and Bluetooth device state changes (AirPods sleeping/waking).
- The only known recovery is a **full teardown and rebuild**: stop and destroy the IOProc, destroy the aggregate device, destroy the tap, recreate all three.
- Zero Apple replies on the thread.

**A screensaver is precisely the long-running, unattended, hours-at-a-time workload that triggers this**, and it will hit exactly the Bluetooth-wake and sample-rate-change conditions described. Worse, "the tap went dead" and "the music stopped" are indistinguishable from inside the visualizer — both are silence.

**Design consequence, and it is cheap to build in from day one:** the audio layer needs a **watchdog** — if the tap reports continuous digital silence beyond some threshold while `kAudioProcessPropertyIsRunningOutput` says a process *is* producing output, tear down and rebuild the whole tap chain. Map decision #14 (every modulation route carries an autonomous baseline) means a dead tap degrades gracefully rather than freezing, which is a real piece of luck — but it also means the failure is **invisible**, so the watchdog cannot rely on anyone noticing.

<https://developer.apple.com/forums/thread/825780>

---

### 3. The critical question: can a screensaver hold any of this?

This is where the project's biggest risk actually lives, and the answer splits hard depending on bundle format.

#### 3a. `.saver` — no, and the reason is structural

**VERIFIED-LOCAL.** The complete entitlement set of `legacyScreenSaver.appex` on macOS 27 (`codesign -d --entitlements`):

```xml
com.apple.private.xpc.launchd.per-user-lookup          true
com.apple.security.app-sandbox                         true
com.apple.security.assets.pictures.read-only           true
com.apple.security.cs.disable-library-validation       true
com.apple.security.files.bookmarks.app-scope           true
com.apple.security.files.user-selected.read-only       true
com.apple.security.network.client                      true
com.apple.security.network.server                      true
com.apple.security.temporary-exception.files.absolute-path.read-only
                                                       [ "/" ]
com.apple.security.temporary-exception.mach-lookup.global-name
                                                       [ com.apple.CARenderServer,
                                                         com.apple.CoreDisplay.master,
                                                         com.apple.nsurlstorage-cache,
                                                         com.apple.ViewBridgeAuxiliary ]
com.apple.security.temporary-exception.yasb            true
```

Read what is **absent**:

- No `com.apple.security.device.audio-input`. **No audio input, at all, ever.**
- No `com.apple.security.device.camera`.
- No `com.apple.security.application-groups`. **App Groups are not available** — see the note on map decision #11 below.
- No blanket `mach-lookup`. Exactly four Apple services are permitted. **Custom XPC to a helper is blocked.**

And what is **present** and useful:

- `com.apple.security.cs.disable-library-validation` — this is *why* third-party `.saver` code can load at all.
- `com.apple.security.network.client` + `.server` — **localhost sockets work.** This is the surviving IPC transport.
- `temporary-exception.files.absolute-path.read-only: /` — the saver can **read any file on disk**. It cannot write outside its container.

**VERIFIED-LOCAL.** `legacyScreenSaver.appex`'s `Info.plist` contains **no `NS*UsageDescription` keys whatsoever**, and identifies as:

```
CFBundleIdentifier  com.apple.ScreenSaver.Engine.legacyScreenSaver
CFBundlePackageType XPC!
NSExtensionPointIdentifier  com.apple.screensaver
LSMinimumSystemVersion      27.0
```

**This closes the question for `.saver`.** TCC will not prompt for a service whose usage-description key is missing from the requesting process's `Info.plist` — that is long-standing, well-known TCC behaviour. The requesting process here is Apple's, signed by Apple, and Punch cannot modify it. There is no bundle ID for the user to grant, no prompt that can be shown, and no `tccutil` invocation that would help.

**"Can the companion app perform the grant such that the saver inherits it?"** — **No. VERIFIED reasoning:** TCC grants are keyed to a code identity. The `.saver` has no runtime code identity distinct from `legacyScreenSaver.appex`. Granting Punch.app `kTCCServiceAudioCapture` records a grant against `io.blakepetersen.punch` (or whatever); when the saver's code calls `AudioDeviceStart`, tccd evaluates `com.apple.ScreenSaver.Engine.legacyScreenSaver`. Different subject, no match, denied. There is nothing to inherit *through* — inheritance would require the saver to be a child process of the app, and it is not; it is a bundle inside Apple's process.

**VERIFIED-LOCAL.** For completeness, `ScreenSaverEngine.app` (the outer host) is also sandboxed with no audio entitlement. Notably it *does* hold `com.apple.security.scripting-targets` for `com.apple.Music` and an Apple Events exception — which is how the system's own "now playing" screensaver behaviour is possible. That is metadata, not audio. Worth knowing: **track title / artist / artwork is reachable; waveform is not.**

**VERIFIED-LOCAL.** The modern `WallpaperAgent.app` is likewise sandboxed with `com.apple.private.tcc.allow` limited to `kTCCServiceSystemPolicyAllFiles` and `kTCCServicePhotos`. **No audio there either.**

**CORROBORATED**, and it matches the binaries exactly — the Aerial project's own account of the `.saver` model:

> "Being a plugin to [`legacyScreenSaver.appex`], we can't control entitlements ourselves. […] Apple's bundled screensavers are using the new AppExtension model to get around that limitation, but that is not available to 3rd party screen savers."

That last clause was true when written. It is no longer true — see next.

- Aerial: <https://github.com/AerialScreensaver/Aerial>
- Apple Developer Forums, *legacyScreenSaver Sandboxing CFPreferences* — a developer hitting exactly these walls, **zero Apple replies in the thread**: <https://developer.apple.com/forums/thread/119731>

#### 3b. `.appex` — yes, and it is being shipped today

**VERIFIED-LOCAL.** Apple's own screensavers are `.appex` bundles at the `com.apple.screensaver` extension point. E.g. `/System/Library/ExtensionKit/Extensions/Arabesque.appex`:

```
NSExtensionPointIdentifier   com.apple.screensaver
NSExtensionPointVersion      1.0
NSExtensionPrincipalClass    Arabesque.ArabesqueExtension
ScreenSaverViewControllerClass  Arabesque.ArabesqueViewController
SSENeedsAnimationTimer       true
```

**VERIFIED-LOCAL.** `ScreenSaverEngine.app` and `WallpaperAgent.app` both carry `com.apple.developer.extension-host.screensaver` — they are the hosts for this extension point.

**VERIFIED.** And a third party is using it. Aerial 4 (stable, **macOS 15+**; 4.1 beta, macOS 26+) ships as an `.appex` inside `Aerial.app`. Its own words:

> "Apple introduced AppExtension screensavers (`.appex`) all the way back in macOS 10.15 (Catalina) — that's the format Apple's own video screensavers have used ever since. But the API has been private the entire time; Apple has never documented it publicly, which is why every other third-party screensaver still ships in the older `.saver` bundle format. **Aerial 4 is the first third-party screensaver to implement this via the private API.**"

And the benefits it claims — every one of which is a problem on Punch's map:

> "Better compatibility — no more random black screens, no more stacking screensaver instances on wake. Better isolation and stability — Aerial runs in its own process and sandbox, not bundled inside Apple's shared legacy screensaver host alongside every other `.saver` you have installed. Better permission needs — you no longer need to grant Full Disk Access for Aerial to work."

<https://aerialscreensaver.github.io/faq/>

**VERIFIED — this is the load-bearing artifact.** `AerialScreenSaverExtension/AerialScreenSaverExtension.entitlements`, from the repo:

```xml
<key>com.apple.security.app-sandbox</key>                        <true/>
<key>com.apple.security.network.client</key>                     <true/>
<key>com.apple.security.cs.disable-library-validation</key>      <true/>
<key>com.apple.security.personal-information.location</key>      <true/>
<key>com.apple.security.temporary-exception.files.absolute-path.read-only</key>
    <array><string>/</string></array>
<key>com.apple.security.temporary-exception.files.absolute-path.read-write</key>
    <array><string>/Users/Shared/</string></array>
<key>com.apple.security.temporary-exception.mach-lookup.global-name</key>
    <array>
      <string>com.apple.CoreAnimation.WindowServer</string>
      <string>com.apple.CARenderServer</string>
    </array>
```

<https://github.com/AerialScreensaver/Aerial/blob/main/AerialScreenSaverExtension/AerialScreenSaverExtension.entitlements>

**Three things this proves, all of them decisive:**

1. A third-party screensaver extension **declares its own entitlements**, chosen by the developer — including a **read-write** filesystem exception, which `legacyScreenSaver` flatly does not grant.
2. It declares `com.apple.security.personal-information.location`, a **TCC-gated privacy capability**, and pairs it with **its own usage description** in **its own Info.plist**: *"Aerial uses your location to display local weather information and calculate sunrise/sunset times."*
3. It is **notarized and distributed publicly**, so Apple's notary service accepts a third-party binary at this extension point.

**VERIFIED.** Why this works and `.saver` does not: an `.appex` **runs as its own process**. It has its own Mach-O, its own signature, its own bundle ID, its own entitlements, its own `Info.plist`. TCC therefore has a real subject to attribute a grant to. This is the same mechanism by which System Settings' own panes — themselves `.appex` bundles running as standalone processes — act as the instigator process for permission grants.

- *The Curious Case of the Responsible Process*: <https://www.qt.io/blog/the-curious-case-of-the-responsible-process>
- *Explainer: Permissions, privacy and TCC*: <https://eclecticlight.co/2025/11/08/explainer-permissions-privacy-and-tcc/>

#### 3c. The honest caveats on the `.appex` route

I do not want to oversell this. The costs are real:

- **The extension point is private and undocumented.** Apple has left it private since Catalina (2019) — seven years — while shipping its own screensavers on it. That is a long, stable run, and Aerial's public bet suggests it is not about to vanish. But there is no API contract, no deprecation policy, and no Apple support if it breaks. **INFERRED risk assessment:** low-to-moderate, decreasing, because Apple's own screensavers depend on the same plumbing.
- **Notarization accepts it today.** It accepted Aerial. There is no guarantee it always will. **UNVERIFIED** whether Apple has ever rejected a third-party build at this extension point.
- **Aerial proves Location, not AudioCapture.** Different TCC service, different daemon path (CoreLocation goes through `locationd`). Location working is strong evidence the *mechanism* works; it is not proof that `kTCCServiceAudioCapture` specifically is reachable. **This is the gap.**
- **App Sandbox is mandatory for an app extension**, so the "turn off the sandbox" workaround the field uses for taps is **not available to us**. Combined with the unverified sandbox-vs-taps interaction above, this is the concentrated risk of the whole approach.
- **Where does the prompt come from?** A screensaver runs when the user is *away*. A TCC prompt fired at that moment is invisible and will time out or be dismissed. **The grant must be obtained ahead of time, from the companion app's UI, while the user is present.** Whether a grant made by `Punch.app` covers the embedded `PunchSaver.appex` — or whether the appex must prompt separately — is **UNVERIFIED**. Apple's taps article says "prompts you to grant *the app*", which is suggestive but not conclusive for the extension case.

---

### 4. Real-world evidence

| Project | Approach | Notes |
|---|---|---|
| [`insidegui/AudioCap`](https://github.com/insidegui/AudioCap) | CoreAudio process taps | The reference implementation. macOS 14.4+. Uses **private TCC API** to *pre-check / pre-request* permission, because — in its own words — *"There's no public API to request audio recording permission or to check if the app has that permission."* Has a build flag to disable the private-API path, in which case the prompt fires on first record. |
| [`AerialScreensaver/Aerial`](https://github.com/AerialScreensaver/Aerial) | Third-party screensaver `.appex` | The proof that the `.appex` route works. Holds its own entitlements and a TCC Location grant. **No audio.** |
| [Apple sample: *Capturing system audio with Core Audio taps*](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps) | Process taps | First-party. Documents the prompt trigger and the aggregate-device assembly. |
| [BlackHole](https://github.com/ExistentialAudio/BlackHole) | Virtual `AudioServerPlugIn` (user-space HAL, **not** a kext) | The pre-taps standard. See fallbacks. |
| OBS Studio (macOS) | Historically a virtual device; now SCK / taps | Migrated as APIs arrived. |
| projectM / Milkdrop ports | Virtual device or mic | [`frontend-sdl-cpp` issue #110](https://github.com/projectM-visualizer/frontend-sdl-cpp/issues/110) discusses macOS capture pain. |

**Anyone doing system audio capture from a screensaver specifically:** **I found none.** Not one project, on any macOS version. This is a genuine negative result and worth stating plainly — nobody has shipped this. The absence is consistent with the `.saver` analysis above (it is impossible there), and the `.appex` route is new enough (Aerial 4, ~2025) that nobody has tried audio on it yet.

**Punch would be first.** That is a real risk multiplier and should be priced in.

---

## Fallbacks, ranked

Ranked by *value delivered per unit of risk*, not by ease.

### 1. Screensaver `.appex` + process taps — **recommended**

Punch.app contains `PunchSaver.appex` at `com.apple.screensaver`. The appex declares `com.apple.security.device.audio-input` and `NSAudioCaptureUsageDescription`. The companion app walks the user through granting System Audio Recording while they are present. The appex opens its own tap.

- **Cost:** depends on a private extension point; must prove `kTCCServiceAudioCapture` works under a mandatory sandbox; nobody has done it before.
- **Payoff:** the hero experience, with no user-visible plumbing, no driver install, no device switching.
- **Kill criterion:** a prototype that cannot get a tap to deliver non-silent buffers from inside a sandboxed appex.

### 2. Companion app captures, screensaver renders — **the strong fallback, and a good hedge**

The app (unsandboxed, or normally sandboxed with the audio entitlement — either way it is a plain app with a real identity, and taps are known to work there) does the capture and the DSP, and publishes `AudioFrame` values. The screensaver consumes them.

This is attractive because **it fits map decision #7 exactly** — `AudioFrame` is already specified as a curated, scriptable value type. The transport is an implementation detail behind an interface the map already committed to.

Transport options, given the sandbox:

- **Localhost socket.** `com.apple.security.network.client`/`.server` are present in **both** `legacyScreenSaver.appex` and any `.appex` we write. **VERIFIED** as entitled; **UNVERIFIED** end-to-end. This is the most likely transport to survive.
- **A file the app writes and the saver mmaps.** `legacyScreenSaver` has read access to `/` — **VERIFIED**. Companion writes to `/Users/Shared/`, saver polls. Crude, but 60Hz polling of a small mmap'd ring buffer is cheap and it works within verified permissions.
- **XPC to a custom Mach service.** **VERIFIED BLOCKED for `.saver`** — `legacyScreenSaver`'s `mach-lookup` allowlist is four Apple names, nothing else. Available for our own `.appex`, where we choose the entitlement.
- **Darwin notifications.** Likely fine for signalling, useless for streaming.

- **Cost:** the companion app must be **running** whenever the screensaver is. That means a LaunchAgent, which is a real UX and trust cost for a screensaver ("why does this thing run all the time?"). **Critically — and this is the one that hurts: at the login window there is no user session and no user agents, so there is no capture and no reactivity.** A screensaver that works when locked-but-logged-in and dies at the login window is a confusing product.
- **Payoff:** hero experience in the common case, and it de-risks #1 entirely — if the appex tap fails, this still ships.

### 3. Virtual audio driver (BlackHole et al.) — **do not ship, but know it exists**

BlackHole is a user-space `AudioServerPlugIn` in `/Library/Audio/Plug-Ins/HAL`, **not** a kext — so no reduced-security or kext approval. That is the good news, and it is the reason this remains the fallback of last resort rather than a non-starter.

Everything else about it is bad for Punch:

- The user must **install a driver** and then **re-route their audio output** through a Multi-Output Device to keep hearing anything. That is a hostile ask for a *screensaver*.
- Multi-Output Devices lose volume-key control and are prone to sample-rate/clock drift.
- **Reading from BlackHole is reading an audio input device**, so it still needs `com.apple.security.device.audio-input` and — **INFERRED, high confidence** — a **microphone** TCC grant, since it presents as an input device. So it **does not dodge the TCC problem**; it trades a narrow, honest "record system audio" prompt for a broad, misleading "microphone" prompt, *plus* a driver install.
- **Licensing: BlackHole is GPL-3.0. VERIFIED** — I read the `LICENSE` file. And note the extra wrinkle: *"the compiled binaries, branding, trademarks, and logos remain proprietary to Existential Audio Inc."* Punch is Apache-2.0. **We cannot bundle the source, and we cannot redistribute the binaries either.** The most we could ever do is *detect* an existing BlackHole install and instruct the user — never ship it.
  <https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE>

**UNVERIFIED:** whether reading a virtual input device from inside `legacyScreenSaver` works at all — given no `audio-input` entitlement there, almost certainly not. So this fallback does not even rescue the `.saver` route.

### 4. Microphone only

Capture the built-in mic, react to room sound. Needs `NSMicrophoneUsageDescription` + `kTCCServiceMicrophone` + `com.apple.security.device.audio-input` — **all of which face the identical attribution problem**. Available to an `.appex`, impossible in a `.saver`. So this is **not** a fallback that rescues the `.saver` path; it is strictly worse than #1 on the same architecture.

It also sounds bad: room mic through laptop speakers means comb filtering, feedback risk, and reacting to typing and HVAC. Map decision #2 already calls mic "the fallback" — **this research suggests demoting it below the companion-capture route**, because mic buys nothing architecturally that taps don't, and it sounds worse.

### 5. Non-reactive `.saver` + reactive app

Ship a generative-only screensaver and put the full reactive visualizer in the companion app.

Map decision #14 makes this *survivable* rather than catastrophic — every modulation route already carries an autonomous baseline, so a silent screensaver is a designed state rather than a broken one. But it concedes the product's premise. **This is the floor, not a plan.**

---

## Open questions

Ordered by how much they cost if the answer is bad.

1. **Does `kTCCServiceAudioCapture` grant to a screensaver `.appex`, and does a tap deliver audio from inside its mandatory sandbox?** The whole recommendation rests here. Aerial proves Location works; nothing proves audio does. **Resolvable only by prototype** — and it is a *small* prototype: an `.appex` at `com.apple.screensaver` with `audio-input` + `NSAudioCaptureUsageDescription`, that creates a tap, starts an aggregate device, and logs RMS. Should be the very next ticket, ahead of any renderer work.

2. **Is the grant made by the containing app honoured for the embedded appex, or must the appex prompt separately?** **INFERRED, and I lean strongly toward "prompts separately":** TCC records are keyed on bundle ID *and* code signature, and an `.appex` has its own bundle ID and its own signature. Apple's taps article says the system "prompts you to grant *the app*" permission, but that phrasing predates any consideration of extensions. I could find **no** authoritative statement either way — treat this as genuinely open.

   **If the appex must prompt for itself, there is a clean answer and it is worth designing around now:** the user selects Punch in **System Settings › Screen Saver**, which runs the extension **in a live preview while the user is sitting right there**. That is the natural, honest moment for the prompt — the user has just chosen the screensaver, and the system asks whether it may react to audio. The companion app's onboarding should *drive the user to that moment* rather than trying to pre-grant on the extension's behalf. Verify in the same prototype as #1.

3. **~~Does the screensaver run at the login window?~~ — mostly answered, and mostly moot.** **CORROBORATED:** the login window lives in a restricted Mach bootstrap namespace that user LaunchAgents cannot bridge, and pre-login there is no user graphical session — ScreenCaptureKit returns empty frames there, and by the same logic a per-user companion agent is simply not running. So **fallback #2 is dead at the login window.** But so is the use case: with nobody logged in, nothing is playing music. The case that actually matters for Punch is **logged-in-and-idle** — user walked away with music playing — and there the user session, its agents, and its audio are all alive. Treat login-window reactivity as explicitly out of scope and let decision #14's autonomous baseline cover it.
   <https://developer.apple.com/forums/thread/814152> · <https://developer.apple.com/forums/thread/763453>

4. **Does Apple's notary service reliably accept third-party `com.apple.screensaver` extensions?** Aerial says yes today. One data point.

5. **What replaces App Groups?** Map decision #11 puts settings in a shared App Group container. **VERIFIED: `legacyScreenSaver.appex` has no `application-groups` entitlement**, so that is not available to a `.saver`. Our own `.appex` *can* declare App Groups — so decision #11 survives on the recommended path but **dies on the `.saver` path**. Another reason to go `.appex`. Aerial's answer was a `/Users/Shared/` read-write exception; that is the proven-in-the-field alternative.

6. **Can `AudioCap`'s private-TCC pre-check be avoided?** Shipping private API is a notarization and stability risk. Without it there is no way to *ask* for the permission, or even to know whether you have it — you just try to record and see. For a screensaver that must be configured while the user is present, a blind "start a tap and see if it's silent" probe from the companion app may be the only supportable way to drive onboarding UI.

---

## Impact on the map

Proposed amendments to [#1](https://github.com/BlakePetersen/punch/issues/1):

| # | Current | Proposed |
|---|---|---|
| 1 | `PunchCore` + a **`.saver` bundle** + companion app | `PunchCore` + a **`com.apple.screensaver` `.appex` embedded in the companion app**. The app stops being merely the dev harness and becomes the **delivery vehicle** — it is where the TCC grant is obtained. **`.saver` is the fallback shape, not the target.** |
| 2 | System capture hero, **mic fallback**, generative degradation | Keep the shape, **reorder the middle**: system capture hero → **companion-app capture over IPC** → generative. Demote mic below IPC; it shares every permission problem and sounds worse. |
| 6 | macOS 15.0, **provisional pending this ticket** | **Confirm macOS 15.0, now non-provisional.** Taps need 14.4; Aerial's `.appex` route is proven on 15+. macOS 15 is the correct floor and there is no reason to go lower. `CATapDescription.bundleIDs` on macOS 26+ is a nice-to-have, not a floor-raiser. |
| 11 | Settings via **shared App Group container** | Survives — but **only because we are moving to `.appex`**. Would have been impossible in a `.saver`. Worth recording *why*. |

Decision 7's `AudioFrame` contract is **validated** by this research: it is exactly the right seam. Whether frames come from an in-process tap or over a socket from the companion app is hidden behind it, which means **the renderer work is not blocked on resolving open question #1.**

---

## Sources

- Apple, *Capturing system audio with Core Audio taps* — <https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps>
- Apple, `AudioHardwareCreateProcessTap(_:_:)` — <https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap(_:_:)>
- Apple, `NSAudioCaptureUsageDescription` — <https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription>
- Apple, Audio Input Entitlement — <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input>
- Apple, WWDC25 session 251, *Enhance your app's audio recording capabilities* — <https://developer.apple.com/videos/play/wwdc2025/251/>
- Apple Developer Forums, *legacyScreenSaver Sandboxing CFPreferences* — <https://developer.apple.com/forums/thread/119731>
- Apple Developer Forums, *Is it possible to get only audio from ScreenCaptureKit?* — <https://developer.apple.com/forums/thread/718279>
- `insidegui/AudioCap` — <https://github.com/insidegui/AudioCap>
- `AerialScreensaver/Aerial` — <https://github.com/AerialScreensaver/Aerial>
- Aerial FAQ (the `.appex` account) — <https://aerialscreensaver.github.io/faq/>
- Aerial extension entitlements — <https://github.com/AerialScreensaver/Aerial/blob/main/AerialScreenSaverExtension/AerialScreenSaverExtension.entitlements>
- `AerialScreensaver/ScreenSaverMinimal` — <https://github.com/AerialScreensaver/ScreenSaverMinimal>
- BlackHole — <https://github.com/ExistentialAudio/BlackHole>
- DGR Labs, *Capturing System Audio on macOS in 2026* — <https://dgrlabs.co/blog/2026-04-25-capturing-system-audio-on-macos-in-2026.html>
- Mark Rowe, *TCC and the macOS Platform Sandbox Policy* — <https://bdash.net.nz/posts/tcc-and-the-platform-sandbox-policy/>
- Qt, *The Curious Case of the Responsible Process* — <https://www.qt.io/blog/the-curious-case-of-the-responsible-process>
- The Eclectic Light Company, *Explainer: Permissions, privacy and TCC* — <https://eclecticlight.co/2025/11/08/explainer-permissions-privacy-and-tcc/>
- Local SDK headers: `CoreAudio.framework/Headers/{AudioHardwareTapping,CATapDescription,AudioHardware}.h`, MacOSX.sdk, Xcode 26.6
- Local binaries: `legacyScreenSaver.appex`, `ScreenSaverEngine.app`, `WallpaperAgent.app`, `Arabesque.appex`, `tccd` — macOS 27.0 (26A5406e)
