<!-- ABOUTME: Ground truth for building, signing, installing, and debugging macOS `.saver` screensaver bundles on macOS 26/27. -->
<!-- ABOUTME: Research output for issue #3; every claim is marked VERIFIED (with source) or INFERRED. -->

# `.saver` bundle mechanics on macOS 26/27

Research for [#3](https://github.com/BlakePetersen/punch/issues/3). Written 2026-08-24.

**Verification machine:** macOS 27.0 (build `26A5406e`), Xcode 26.6 (`17F113`), Swift 6.3.3, `MacOSX26.5.sdk`, arm64.

Claims are tagged:

- **VERIFIED (local)** — observed directly on the machine above; the command is given so it can be re-run.
- **VERIFIED (source)** — confirmed against a first-party document or a real, current open-source project; URL given.
- **INFERRED** — reasoned from the above, not directly observed. Treat as a hypothesis to test in the tracer bullet.

## The short version

- **`ScreenSaverView` is still it.** Not deprecated, `macOS 10.0+`, still has an Xcode target template in 26.6. Apple's own savers have moved to a `com.apple.screensaver` ExtensionKit extension point, but that door is entitlement-gated and closed to third parties. Build a `.saver`.
- **Your code runs inside Apple's `legacyScreenSaver.appex` and inherits its sandbox verbatim.** That sandbox has no microphone entitlement and no App Groups. Two map decisions need re-testing because of it (§7).
- **Metal is fine.** `MTLCreateSystemDefaultDevice()` works from plug-in code, compute pipelines build, runtime MSL compiles. The trap is `Bundle.main` — it is Apple's bundle, not yours (§5).
- **The dev loop is: build a debug host app.** Not a preference — it is what Apple DTS tells people to do, and the alternative is fighting a sticky cache in a process you cannot attach to (§4).
- **The host has real, current bugs.** `stopAnimation` is never sent and instances leak; `isPreview` is unreliable and got worse on macOS 26; multi-display "mostly broken in new ways" (§5, §6). Design around them from the start.

---

## 1. Bundle anatomy

### Is `ScreenSaverView` still the API? Yes.

**VERIFIED (source).** `ScreenSaverView` is **not deprecated**. Apple's documentation index reports availability `macOS 10.0+` with no deprecation summary — <https://developer.apple.com/documentation/screensaver/screensaverview> (machine-readable form: `https://developer.apple.com/tutorials/data/documentation/screensaver/screensaverview.json`).

**VERIFIED (local).** The macOS 26.5 SDK header carries no deprecation attribute at all — the only availability macros in the entire framework are `API_UNAVAILABLE_BEGIN(ios, tvos, watchos)` / `API_UNAVAILABLE_END`:

```
SDK=$(xcodebuild -version -sdk macosx Path)
grep -n "DEPRECATED\|API_AVAILABLE\|UNAVAILABLE" \
  "$SDK/System/Library/Frameworks/ScreenSaver.framework/Headers/"*.h
# ScreenSaverView.h:10:API_UNAVAILABLE_BEGIN(ios, tvos, watchos)
# ScreenSaverView.h:287:API_UNAVAILABLE_END
# ScreenSaverDefaults.h:10:API_UNAVAILABLE_BEGIN(ios, tvos, watchos)
# ScreenSaverDefaults.h:47:API_UNAVAILABLE_END
```

The framework's public surface is exactly three headers: `ScreenSaver.h`, `ScreenSaverView.h`, `ScreenSaverDefaults.h`. The header file itself is still stamped `Copyright (c) 2000-2020` — this is a frozen, maintained API, not an evolving one.

### There *is* a successor architecture. It is not available to us.

This is the most important structural finding, and it is worth stating precisely because it looks at first glance like an opportunity.

**VERIFIED (local).** Apple's own screensavers on macOS 27 are no longer `.saver` bundles. They are ExtensionKit app extensions in `/System/Library/ExtensionKit/Extensions/` declaring the `com.apple.screensaver` extension point:

```
plutil -p "/System/Library/ExtensionKit/Extensions/Arabesque.appex/Contents/Info.plist"
```
```
"NSExtension" => {
    "NSExtensionPointIdentifier" => "com.apple.screensaver"
    "NSExtensionPointVersion" => "1.0"
    "NSExtensionPrincipalClass" => "Arabesque.ArabesqueExtension"
}
"ScreenSaverViewControllerClass" => "Arabesque.ArabesqueViewController"
"SSEHasConfigureSheet" => false
"SSENeedsAnimationTimer" => true
```

The full roster of registered screensaver extensions is enumerable:

```
pluginkit -m -p com.apple.screensaver -v
```

On this machine that lists 13 plug-ins — Flurry, Arabesque, Hello, Drift, Monterey, Ventura, Album Artwork, Word of the Day, Computer Name, iLife Slideshows, Shell — **all `com.apple.*`** — plus the two legacy hosts.

**VERIFIED (local).** The adjacent wallpaper extension point is explicitly gated behind a private entitlement:

```
plutil -p /System/Library/ExtensionKit/ExtensionPoints/com.apple.wallpaper.appexpt
```
```
"com.apple.wallpaper" => {
    "EXRequiredEntitlements" => { "com.apple.private.wallpaper.extension" => true }
    "EXRequiredHostEntitlements" => { "com.apple.private.wallpaper.extension-host" => true }
}
```

**VERIFIED (local).** The host side of the screensaver extension point is likewise entitlement-gated. `ScreenSaverEngine.app` carries `com.apple.developer.extension-host.screensaver`:

```
codesign -d --entitlements - --xml /System/Library/CoreServices/ScreenSaverEngine.app | plutil -p -
```

**INFERRED.** There is no Xcode target template for a `com.apple.screensaver` extension (see §2), no public documentation for `ScreenSaverViewControllerClass` / `SSENeedsAnimationTimer` / `SSEHasConfigureSheet`, and the sibling extension point requires an Apple-private entitlement. The modern path is Apple-internal SPI. **Third parties still ship `.saver` bundles.** Plan on `ScreenSaverView` and do not design for a migration that has no public door.

### Where the legacy `.saver` actually runs

**VERIFIED (local).** `.saver` bundles are loaded into `legacyScreenSaver.appex`, an XPC app extension shipped *inside the ScreenSaver framework*:

```
/System/Library/Frameworks/ScreenSaver.framework/PlugIns/legacyScreenSaver.appex
/System/Library/Frameworks/ScreenSaver.framework/PlugIns/legacyScreenSaver-x86_64.appex
```

Its `Info.plist` shows it is itself just another `com.apple.screensaver` extension — a shim that adapts the old plug-in world to the new extension point:

```
"CFBundleIdentifier" => "com.apple.ScreenSaver.Engine.legacyScreenSaver"
"CFBundlePackageType" => "XPC!"
"NSExtension" => {
    "NSExtensionPointIdentifier" => "com.apple.screensaver"
    "NSExtensionPrincipalClass" => "LegacyController"
}
"ScreenSaverViewControllerClass" => "LegacyConfigurationViewController"  # (config sheet)
"ScreenSaverExtensionManagerClass" => "LegacyExtensionManager"
"SSEHasConfigureSheet" => true
"SSENeedsAnimationTimer" => true
```

The separate `-x86_64` variant exists to host Intel-only `.saver` bundles under Rosetta. **INFERRED:** shipping an arm64+x86_64 universal `.saver` keeps you in the native host on Apple Silicon; an x86_64-only build gets routed to the Rosetta host, which would be a bad place to run a Metal compute pipeline.

**VERIFIED (local).** The enumeration of installed legacy savers for the settings UI is done by a *third* component, `WallpaperLegacyExtension.appex`, whose strings name the search path, both hosts, and the provider identity used in the wallpaper store:

```
strings -a "/System/Library/ExtensionKit/Extensions/WallpaperLegacyExtension.appex/Contents/MacOS/WallpaperLegacyExtension" | grep -i saver
```
```
Load Screen Saver Modules
legacyScreenSaver
legacyScreenSaver-x86_64
/Library/Screen Savers/
com.apple.wallpaper.choice.screen-saver
Encountered missing name for legacy screen saver
Could not load thumbnail for legacy screen saver: %s
Encountered missing path for legacy screen saver: %s
```

So the chain is: **System Settings → `WallpaperAgent` → `WallpaperLegacyExtension.appex` (discovery) → `legacyScreenSaver.appex` (execution) → your `.saver`.** Four processes between the user and your code. That is the source of the caching pain in §3.

### Bundle layout and `Info.plist`

**VERIFIED (local).** Apple's own remaining legacy saver, `/System/Library/Screen Savers/FloatingMessage.saver`, declares exactly one screensaver-specific key:

```
plutil -p "/System/Library/Screen Savers/FloatingMessage.saver/Contents/Info.plist"
```
```
"CFBundleIdentifier" => "com.apple.ScreenSaver.FloatingMessage"
"NSPrincipalClass" => "FloatingMessageView"
```

The layout is a plain macOS loadable bundle (`com.apple.product-type.bundle`) with the extension renamed:

```
Punch.saver/
  Contents/
    Info.plist            # NSPrincipalClass = your ScreenSaverView subclass
    MacOS/Punch           # MH_BUNDLE, universal arm64 + x86_64
    Resources/
      default.metallib    # see §5 — must be loaded from THIS bundle, not the main bundle
      thumbnail.png
    Frameworks/           # embedded PunchCore.framework, if not statically linked
    _CodeSignature/
```

Required keys, minimum viable set:

| Key | Value | Notes |
|---|---|---|
| `NSPrincipalClass` | your `ScreenSaverView` subclass | **VERIFIED (local)**; for Swift this must be the *Objective-C* name — see §2 |
| `CFBundleIdentifier` | e.g. `io.blakepetersen.punch.saver` | Must be unique; it namespaces `ScreenSaverDefaults` |
| `CFBundleName` / `CFBundleDisplayName` | `Punch` | Shown in System Settings; `WallpaperLegacyExtension` logs "missing display name" if absent |
| `CFBundlePackageType` | `BNDL` | Set by the bundle product type |
| `LSMinimumSystemVersion` | `15.0` | Matches map decision 6 |
| `NSHumanReadableCopyright` | Apache-2.0 line | Template default |

`CFBundleExecutable`, `CFBundleVersion`, `CFBundleShortVersionString` are set by the build as usual.

---

## 2. Build & signing

### The Xcode template still exists

**VERIFIED (local).** Xcode 26.6 still ships a Screen Saver target template, under **macOS → Other → Screen Saver**:

```
/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Xcode/Templates/Project Templates/macOS/Other/Screen Saver.xctemplate
```

Its `TemplateInfo.plist` is short and tells you everything the build needs:

```
"Ancestors" => [ "com.apple.dt.unit.systemPlugInBase" ]     # → ProductType com.apple.product-type.bundle
"Identifier" => "com.apple.dt.unit.screenSaver"
"Targets" => [ {
    "SharedSettings" => {
        "INFOPLIST_KEY_NSPrincipalClass" => "___PACKAGENAMEASIDENTIFIER___View"
        "INSTALL_PATH" => "$(HOME)/Library/Screen Savers"
        "WRAPPER_EXTENSION" => "saver"
    }
    "TargetIdentifier" => "com.apple.dt.cocoaScreenSaverTarget"
} ]
```

So, concretely: **the `.saver` extension comes from `WRAPPER_EXTENSION = saver`** on a bundle target. There is no special product type. Three build settings are the whole story:

```
PRODUCT_TYPE                    = com.apple.product-type.bundle   (from the template ancestor)
WRAPPER_EXTENSION               = saver
INFOPLIST_KEY_NSPrincipalClass  = PunchSaverView
INSTALL_PATH                    = $(HOME)/Library/Screen Savers
```

**VERIFIED (local).** The template's sources are Objective-C only (`___View.h` / `___View.m`) — there is no Swift variant in Xcode 26.6. The generated `.m` sets `[self setAnimationTimeInterval:1/30.0]` in `initWithFrame:isPreview:` and stubs `startAnimation`, `stopAnimation`, `drawRect:`, `animateOneFrame`, `hasConfigureSheet`, `configureSheet`.

### Swift concerns

Swift `.saver` bundles are the norm in the current open-source ecosystem, but two things bite:

1. **`NSPrincipalClass` must be the Objective-C runtime name.** Swift mangles class names to `<ModuleName>.<ClassName>`. Two forms work, and **VERIFIED (local, experiment)** below confirms both: annotate the class `@objc(PunchSaverView)` and write the bare name, or leave it unannotated and write the mangled `PunchSaver.PunchSaverView`. Apple's own `Arabesque.appex` uses the mangled form. Pick one and never let it drift — if it is wrong you get a silent "Module … failed to load" (see §4).
2. **`initWithFrame:isPreview:` is `NS_DESIGNATED_INITIALIZER`** (VERIFIED local, header line). A Swift subclass must implement `init?(frame:isPreview:)` and will be forced to supply `init?(coder:)`.
3. **Swift in a `.saver` is only officially supported from macOS 14.6.** VERIFIED (source) — <https://github.com/AerialScreensaver/ScreenSaverMinimal>. Another reason the 15.0 floor is the right call rather than a conservative one.

Note the initializer is `nullable instancetype` — returning `nil` is a legal failure mode.

### Deployment target

Map decision 6 sets the floor at macOS 15.0. Two facts bear on it:

- **VERIFIED (local).** `CVDisplayLink` is deprecated as of **macOS 15.0**, with the replacement named in the deprecation message itself:
  ```
  # CoreVideo.framework/Headers/CVDisplayLink.h:51
  API_DEPRECATED_BEGIN("use NSView.displayLink(target:selector:), NSWindow.displayLink(target:selector:), or NSScreen.displayLink(target:selector:) ", macos(10.4, 15.0))
  ```
- **VERIFIED (local).** `-[NSView displayLinkWithTarget:selector:]` is `API_AVAILABLE(macos(14.0))` (`AppKit/NSView.h`, `NSView (NSDisplayLink)` category).

A 15.0 floor therefore gets the modern display link with no availability dance and no deprecated API. **A 15.0 floor is well-supported by this ticket's evidence.**


### Code signing, hardened runtime, notarization

#### What the host does and does not require

**VERIFIED (local).** `legacyScreenSaver.appex` is signed by Apple and carries `com.apple.security.cs.disable-library-validation`. That entitlement is the reason a third-party `.saver` can be loaded at all: without it, the host would only load code signed by Apple's team. **We are therefore not required to match any particular team identifier, and the host does not enforce a signature of a specific origin.**

**VERIFIED (local, experiment).** An **ad-hoc signed** (`codesign -s -`, `TeamIdentifier=not set`) Swift `.saver` loads and instantiates cleanly — see §2's probe. Unsigned/ad-hoc is fine for local development.

#### What breaks when it is downloaded — tested, not guessed

The distinction that matters is **not** signed-vs-unsigned. It is **quarantined-vs-not**.

**VERIFIED (local, experiment).** The identical ad-hoc bundle was copied and given a quarantine attribute, exactly as a browser download would:

```bash
cp -R Probe.saver QProbe.saver
xattr -w -r com.apple.quarantine "0083;68ab1234;Safari;" QProbe.saver
./host ./QProbe.saver
# LOAD FAILED          ← Bundle.load() returns false
```

`syspolicyd` explains why:

```
GK evaluateScanResult: 1, PST: (…), (team: (null)), (id: io.blakepetersen.punchprobe), 1, 0, 1, 0, 0, 0, 0
Prompt shown (6, 0), waiting for response: PST: (…), (team: (null)), …
Adding Gatekeeper denial breadcrumb (open): PST: (…), (team: (null)), …
```

Gatekeeper put up a consent prompt and, absent approval, **denied the load**. Removing the attribute and changing nothing else restores it:

```bash
xattr -d -r com.apple.quarantine QProbe.saver
./host ./QProbe.saver
# loaded=true  principalClass=ProbeView  instantiated=true
```

So:

| Scenario | Result |
|---|---|
| Locally built, ad-hoc or unsigned, never downloaded | **Loads.** VERIFIED (local). This is the dev loop. |
| Downloaded (quarantined), ad-hoc / unsigned / not notarized | **Blocked** — Gatekeeper prompt, then denial. VERIFIED (local). |
| Downloaded, Developer ID signed + notarized + stapled | Expected to load without a prompt. **INFERRED** — no Developer ID certificate exists on this machine (`security find-identity -v -p codesigning` → `0 valid identities found`), so this leg could not be tested here. |

⚠️ The failure mode a user sees is *not* a helpful error from Punch. It is a system prompt and then a screensaver that does not appear. Anyone who reports "installed it, nothing happens" should be asked for `xattr -l` on the bundle first.

#### Practical rules

- **Ship Developer ID + notarized.** Map decision 18 (notarized DMG + Homebrew cask) is the right call and the experiment above is why: a plain zip of an unsigned `.saver` is unusable by anyone who downloads it.
- **Sign inside-out, never `--deep`.** `--deep` has been discouraged by Apple for years. Sign embedded frameworks first, then the `.saver` wrapper:
  ```bash
  codesign --force --options runtime --timestamp \
           --sign "Developer ID Application: …" Punch.saver/Contents/Frameworks/PunchCore.framework
  codesign --force --options runtime --timestamp \
           --sign "Developer ID Application: …" Punch.saver
  codesign --verify --strict --verbose=2 Punch.saver
  ```
  **INFERRED** for the exact flag set on a plug-in bundle. `--options runtime` (hardened runtime) is required for notarization of executables; whether it is meaningful on an `MH_BUNDLE` loaded into a host that has *already* set its own runtime policy is an open question — the host's hardened-runtime configuration governs the process. If notarization rejects the bundle without it, add it; that is the deciding test.
- **Statically link `PunchCore` if you can.** Map decision 1 makes `PunchCore` a Swift package shared by two hosts. Linking it statically into the `.saver` removes a whole class of nested-signing and `@rpath` problems inside someone else's process. Only embed a framework if the companion app genuinely needs to share the same dylib instance, which it does not.
- **Build universal (`arm64` + `x86_64`).** VERIFIED (local): a separate `legacyScreenSaver-x86_64.appex` host exists specifically to run Intel-only savers, and being routed there on Apple Silicon would mean a translated Metal host.
- **A `.saver` can be notarized and stapled directly.** **VERIFIED (source)** — this is the exact published sequence from `AerialScreensaver/ScreenSaverMinimal`, a template actively maintained for macOS 15.6 / Xcode 26 (<https://github.com/AerialScreensaver/ScreenSaverMinimal>):
  ```bash
  # one-time
  xcrun notarytool store-credentials "AC_PASSWORD" \
    --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-password"

  # per release
  xcrun notarytool submit "Punch.saver" --keychain-profile "AC_PASSWORD" --wait
  xcrun stapler staple   "Punch.saver"
  xcrun stapler validate "Punch.saver"
  ```
  `xcrun notarytool` version `1.1.2 (41)` is present in this toolchain (VERIFIED local). Note this is *simpler* than assumed: no zip/dmg wrapper is needed for the submission itself, and the `.saver` bundle is a valid stapling target. Map decision 18's DMG is then a delivery vehicle for an already-stapled bundle, and should be notarized and stapled in its own right.
### The sandbox your code inherits — read this before designing anything

Your `.saver` does not get its own entitlements. It is a plug-in dlopen'd into Apple's process, so **it runs under `legacyScreenSaver.appex`'s sandbox, verbatim**.

**VERIFIED (local).** The complete entitlement set of the host:

```
codesign -d --entitlements - --xml \
  /System/Library/Frameworks/ScreenSaver.framework/PlugIns/legacyScreenSaver.appex \
  | plutil -p -
```
```
"com.apple.private.xpc.launchd.per-user-lookup" => true
"com.apple.security.app-sandbox" => true
"com.apple.security.assets.pictures.read-only" => true
"com.apple.security.cs.disable-library-validation" => true
"com.apple.security.files.bookmarks.app-scope" => true
"com.apple.security.files.user-selected.read-only" => true
"com.apple.security.network.client" => true
"com.apple.security.network.server" => true
"com.apple.security.temporary-exception.files.absolute-path.read-only" => [ "/" ]
"com.apple.security.temporary-exception.mach-lookup.global-name" => [
    "com.apple.CARenderServer", "com.apple.CoreDisplay.master",
    "com.apple.nsurlstorage-cache", "com.apple.ViewBridgeAuxiliary" ]
"com.apple.security.temporary-exception.yasb" => true
```

That list is the single most consequential artifact in this document. What it means:

**`com.apple.security.cs.disable-library-validation` is why third-party savers work at all.** Apple's host is signed by Apple; library validation would normally refuse to load code signed by anyone else. Apple explicitly turns it off on this host. **INFERRED, high confidence:** this is why an ad-hoc-signed or even unsigned locally-built `.saver` loads at all, and it means we are *not* required to match Apple's team identifier.

**Read-only access to the entire filesystem** (`temporary-exception.files.absolute-path.read-only = ["/"]`). The saver can read any file the user can read. It can write almost nothing.

**No `com.apple.security.application-groups`.** ⚠️ **This threatens map decision 11** ("settings live in the companion app via a shared App Group container"). Without the entitlement, `containerURL(forSecurityApplicationGroupIdentifier:)` will not resolve inside the saver — and we cannot add the entitlement, because the entitlements belong to Apple's binary, not ours. **INFERRED workaround, and it is a good one:** the read-only `/` exception means the saver can still *read* `~/Library/Group Containers/<GROUP>/…` directly by path. Make the data flow one-directional — companion app writes, saver reads — and decision 11 survives with a path-based read instead of an App Group API call. Test this early; it is a cheap experiment and it gates the settings design.

**No `com.apple.security.device.audio-input`.** ⚠️ **This threatens map decision 2** (system audio capture as the hero). A sandboxed process without that entitlement is normally refused microphone/audio-input access outright, and there is no TCC prompt to grant because the entitlement gate precedes TCC. Additionally, any TCC prompt that *did* appear would be attributed to `com.apple.ScreenSaver.Engine.legacyScreenSaver` — Apple's bundle identifier, not ours. **This belongs to the audio research ticket, but flag it there immediately: it may be the single largest risk on the map.** The likely shape of a workaround is a companion-app helper that captures audio outside the sandbox and publishes frames to the saver — but note the mach-lookup allowlist below before assuming XPC is available.

**Mach lookups are allow-listed to four names**, none of which is a third-party service. ⚠️ **INFERRED:** a plain XPC connection from the saver to a companion-app helper (`NSXPCConnection(machServiceName:)`) will be denied by the sandbox. `com.apple.security.temporary-exception.yasb` ("yet another sandbox bypass") is undocumented and may relax this; that is an open question in §8. If XPC is genuinely unavailable, IPC has to go through something the sandbox does allow — a file the saver polls (read-only `/` covers it), or the network (`network.client` and `network.server` are both granted, so a localhost socket is on the table).

**`network.client` + `network.server` are both granted.** Localhost networking is available. Worth remembering as the IPC fallback.

**Preferences land in Apple's container, not yours.** **VERIFIED (local):** the container exists and has the usual sandbox preference redirection:

```
ls ~/Library/Containers/com.apple.ScreenSaver.Engine.legacyScreenSaver/Data/Library/Preferences/
# com.apple.security.plist  com.apple.security_common.plist
```

Note also that, unlike `ScreenSaverEngine.app`, the appex has **no** `temporary-exception.sbpl` entry for `(allow user-preference-read user-preference-write)`. **INFERRED:** `ScreenSaverDefaults` writes from inside the saver are redirected into that shared container path, and *every* third-party saver on the machine shares it. Do not treat it as private storage, and do not expect the companion app to see those writes at the normal `~/Library/Preferences` location.

### Empirical check: a Swift `.saver` really does load, ad-hoc signed

**VERIFIED (local, experiment).** A throwaway probe was built and loaded on this machine to settle the Swift questions rather than infer them. Sources and commands, reproducible in full:

```swift
// Probe.swift
import ScreenSaver; import Metal; import os

@objc(ProbeView)
final class ProbeView: ScreenSaverView {
    private let log = Logger(subsystem: "io.blakepetersen.punchprobe", category: "probe")
    override init?(frame: NSRect, isPreview: Bool) {
        super.init(frame: frame, isPreview: isPreview)
        animationTimeInterval = 1.0 / 30.0
        let dev = MTLCreateSystemDefaultDevice()
        log.notice("PUNCHPROBE isPreview=\(isPreview) mtldevice=\(dev?.name ?? "NIL", privacy: .public) pid=\(getpid())")
    }
    required init?(coder: NSCoder) { fatalError() }
    override func animateOneFrame() {}
}
```

```bash
SDK=$(xcodebuild -version -sdk macosx Path)
mkdir -p Probe.saver/Contents/MacOS
swiftc -emit-library -o Probe.saver/Contents/MacOS/Probe \
       -module-name Probe -target arm64-apple-macos15.0 -sdk "$SDK" \
       -Xlinker -bundle Probe.swift
cp Info.plist Probe.saver/Contents/Info.plist   # NSPrincipalClass = ProbeView
codesign -s - -f Probe.saver                    # ad-hoc
```

Results:

- `file Probe.saver/Contents/MacOS/Probe` → `Mach-O 64-bit bundle arm64`; `otool -hv` filetype `BUNDLE`. A `.saver` executable is an `MH_BUNDLE`, exactly as `-Xlinker -bundle` / a bundle target produces.
- `codesign -dv` → `flags=0x2(adhoc)`, `TeamIdentifier=not set`, `Sealed Resources version=2`. Ad-hoc signing a `.saver` succeeds and seals resources normally.
- **`NSPrincipalClass` can be the bare, unmangled name if the class is annotated `@objc(ProbeView)`.** Loading the bundle and resolving `principalClass` yields `ProbeView` and `cls.init(frame:isPreview:)` returns a live instance with `animationTimeInterval == 0.0333…`. This *corrects* the cautious inference above: `@objc(Name)` + bare name works and is the more readable option. The mangled `Module.Class` form also works and is what Apple uses internally; either is fine, but pick one and never let them drift.
- **`MTLCreateSystemDefaultDevice()` returns a device from plug-in code** — logged `mtldevice=Apple M5 Max`.
- **`syspolicyd` evaluates the ad-hoc bundle at load time** (`GK evaluateScanResult: 2, … (team: (null)), (id: io.blakepetersen.punchprobe)`) and allows it. Gatekeeper is in the path even for a locally-built, never-downloaded plug-in.

⚠️ **Caveat, stated plainly:** this probe was loaded into an ordinary host process, **not** into `legacyScreenSaver.appex`. It proves the bundle wiring, the Swift naming, the ad-hoc signature, and that Metal needs no entitlement. It does *not* prove behaviour under the appex's sandbox. Everything in §2's sandbox subsection stays INFERRED until the tracer bullet runs inside the real host.

**VERIFIED (local), and it will save hours:** `os.Logger` string interpolation is **redacted by default**. The first run logged `mtldevice=<private>`; adding `privacy: .public` produced `mtldevice=Apple M5 Max`. Since the unified log is the primary debugging channel inside the host (see §4), every diagnostic interpolation needs an explicit `privacy: .public`.
---

## 3. Install & cache-busting

### Paths

| Path | Status |
|---|---|
| `~/Library/Screen Savers` | **The one to use.** VERIFIED (local): it is the Xcode template's `INSTALL_PATH` default in Xcode 26.6 (`"INSTALL_PATH" => "$(HOME)/Library/Screen Savers"`). No admin rights, no `sudo`, per-user. |
| `/Library/Screen Savers` | Honored. VERIFIED (local): the literal string `/Library/Screen Savers/` appears in `WallpaperLegacyExtension.appex`'s binary alongside `Load Screen Saver Modules`. Machine-wide; needs `sudo`; use only for the shipped installer. |
| `/System/Library/Screen Savers` | SIP-protected, Apple only. VERIFIED (local): still contains `FloatingMessage.saver`, `Random.saver`, and `Default Collections`. Not writable. |

For the dev loop, `~/Library/Screen Savers` — a symlink from there to your build product is the cheapest possible install step:

```
ln -sfn "$PWD/build/Debug/Punch.saver" ~/"Library/Screen Savers/Punch.saver"
```

**INFERRED:** a symlink is what makes the loop fast, but it interacts with code signing (the seal covers the real directory) and with Gatekeeper provenance. If loading misbehaves, replace the symlink with an `rsync`/`ditto` copy before assuming the bug is yours.

### Where the selection actually lives now — not in `com.apple.screensaver`

**VERIFIED (local).** The old `defaults -currentHost read com.apple.screensaver moduleDict` is gone. That domain now holds only idle policy:

```
$ defaults -currentHost read com.apple.screensaver
{ idleTime = 3600; showClock = 1; tokenRemovalAction = 0; }
```

**VERIFIED (local).** Since the Sonoma wallpaper/screensaver merge, selection lives in the wallpaper store, owned by `WallpaperAgent`:

```
plutil -p ~/"Library/Application Support/com.apple.wallpaper/Store/Index.plist"
```
```
"AllSpacesAndDisplays" => { "Linked" => { "Content" => {
    "Choices" => [ { "Provider" => "com.apple.wallpaper.extension.photos",
                     "Configuration" => <binary plist>, "Files" => [] } ],
    "EncodedOptionValues" => <binary plist> } , "LastSet" => …, "LastUse" => … },
  "Type" => "linked" }
"Displays" => { }
"Spaces"   => { }
"SystemDefault" => { … }
```

Note the shape: `AllSpacesAndDisplays` **/** `Displays` **/** `Spaces`. Screensaver and wallpaper choice can be per-display, and the empty `Displays` dict here means "one choice for everything" (see §6).

**VERIFIED (local).** The provider identifier a third-party `.saver` is selected under is `com.apple.wallpaper.choice.screen-saver` — it appears in `WallpaperLegacyExtension.appex`'s strings next to the legacy host names. The `Configuration` value is a nested binary plist; **INFERRED:** it carries the chosen module's bundle path or identifier. Scripting the selection means writing a nested binary plist into a store owned by a running agent — treat "set the screensaver from the command line" as unsupported and expect to click it once in System Settings.

### Cache-busting

**VERIFIED (local).** Four processes sit between an installed `.saver` and pixels — the ones actually resident on this machine right now:

```
$ ps aux | grep -iE 'wallpaper|screensaver'
/System/Library/CoreServices/WallpaperAgent.app/Contents/MacOS/WallpaperAgent
/System/Library/ExtensionKit/Extensions/WallpaperImageExtension.appex/…
/System/Library/ExtensionKit/Extensions/WallpaperAerialsExtension.appex/…
/System/Library/ExtensionKit/Extensions/WallpaperSettingsIntents.appex/…
```

plus `legacyScreenSaver` (only while a legacy saver is actually running) and `WallpaperLegacyExtension` (only while enumerating). Any of them can be holding your old bundle.

**VERIFIED (source).** This caching is real, reported to Apple, and answered by DTS. A developer reported that macOS kept showing the previous build "until a reboot"; Quinn "The Eskimo!" confirmed the behaviour and noted that **the real screen saver is much more "sticky" than the preview** — so a change appearing in the preview but not in the running saver is expected, not a build problem. — <https://developer.apple.com/forums/thread/745327>

The working incantation, and the manual ritual for when it is not enough, are in §4 (Loop B) — they belong with the loop that needs them.

---

## 4. The dev/debug loop

The honest summary: **do not iterate inside the screensaver host.** The host is sandboxed, Apple-signed, spawned on demand by an agent you do not control, and takes over the display when it runs. Every hour spent fighting it is an hour not spent on the fluid sim. The map already anticipated this — decision 1 makes the companion app "the development harness first, a shipped feature second." That decision is strongly confirmed by this research; treat it as the primary loop, not a convenience.

### Loop A — the harness (default; use this for ~95% of the work)

Render `PunchCore` into an `NSWindow` in the companion app, driven by a `CADisplayLink`, with scripted `AudioFrame` sequences (decisions 7 and 13). Full Xcode debugging, Metal frame capture, GPU counters, breakpoints, hot rebuild — all the tools work, because it is an ordinary app.

**VERIFIED (local, experiment).** A harness that loads the *actual built `.saver`* — rather than linking the core directly — is about fifteen lines, and it catches the bundle-level mistakes (wrong `NSPrincipalClass`, missing `metallib`, `Bundle.main` confusion) that a directly-linked harness would hide:

```swift
import AppKit; import ScreenSaver

let b = Bundle(path: CommandLine.arguments[1])!
guard b.load() else { fatalError("bundle failed to load") }
guard let cls = b.principalClass as? ScreenSaverView.Type else {
    fatalError("principal class did not resolve: \(String(describing: b.principalClass))")
}
let view = cls.init(frame: NSRect(x: 0, y: 0, width: 1280, height: 720), isPreview: false)!
// … put `view` in a window, call view.startAnimation()
```

Run against the probe on this machine, that printed:

```
loaded=true principalClassName=ProbeView
principalClass=ProbeView
instantiated=true animationTimeInterval=0.03333333333333333
```

**Build this harness in the tracer-bullet ticket.** It is the highest-leverage thing on the whole map, and it is cheap.

Its one blind spot is the sandbox — the harness runs unsandboxed, so anything gated by the host's entitlements (§2: audio input, App Groups, mach lookups, possibly `MTLCompilerService`) will *work in the harness and fail in the saver*. Mitigate by keeping a short, explicit list of sandbox-sensitive operations and testing exactly those in Loop B.

### Loop B — the real host (use rarely, deliberately, with a checklist)

Reserve this for the sandbox-sensitive list, multi-display behaviour, and pre-release verification. Because it is slow and disruptive, batch the questions and go in once.

Install and force a reload:

```bash
# install (or symlink) the freshly built bundle
ditto "build/Release/Punch.saver" ~/"Library/Screen Savers/Punch.saver"

# force the enumerating agent and any running host to drop the old copy
killall legacyScreenSaver 2>/dev/null      # the process your code runs inside
killall WallpaperAgent    2>/dev/null      # owns selection + enumeration on Sonoma+
killall "System Settings" 2>/dev/null      # the settings UI caches its saver list
```

**VERIFIED (local)** that `legacyScreenSaver` and `WallpaperAgent` are the correct, current process names (§1, §3) — `WallpaperAgent` is running right now and `legacyScreenSaver` is the appex executable name. **INFERRED** that this trio is sufficient; the pre-Sonoma folk incantation `killall ScreenSaverEngine` targets `/System/Library/CoreServices/ScreenSaverEngine.app`, which still exists but is no longer the process holding your code.

Observe what happens — the unified log is the debugging channel:

```bash
# everything the saver host says
/usr/bin/log stream --level debug --style compact \
  --predicate 'process == "legacyScreenSaver" OR process == "WallpaperAgent"'

# your own os.Logger output only
/usr/bin/log stream --style compact --predicate 'subsystem == "io.blakepetersen.punch"'

# after the fact
/usr/bin/log show --last 10m --style compact \
  --predicate 'process == "legacyScreenSaver"'
```

**VERIFIED (local).** The host emits a specific, greppable message when your principal class cannot be instantiated — this exact format string is in the `legacyScreenSaver` binary:

```
%s -- Module: %{public}@ (%{public}@) failed to load. Exception: %{public}@, reason: %{public}@
```

So the first diagnostic for "my screensaver is just black" is:

```bash
/usr/bin/log show --last 5m --style compact --predicate 'eventMessage CONTAINS "failed to load"'
```

**VERIFIED (local), and it costs people hours:** `os.Logger` interpolations are **redacted by default** — the first probe run logged `mtldevice=<private>`. Annotate every diagnostic value:

```swift
log.notice("frame \(n, privacy: .public) device=\(dev.name, privacy: .public)")
```

**VERIFIED (local).** `syspolicyd` evaluates the bundle on load and logs it, which is how you tell a Gatekeeper rejection apart from a code bug:

```bash
/usr/bin/log show --last 5m --style compact --predicate 'process == "syspolicyd"' | grep -i punch
# e.g. GK evaluateScanResult: 2, PST: (path: …), (team: (null)), (id: io.blakepetersen.punch)
```

**A note on the shell:** on this machine `log` is shadowed by a shell alias and every `log show` invocation failed with `too many arguments` until it was called as `/usr/bin/log`. Use the absolute path in scripts.


### Apple's own advice agrees: use a debug host

**VERIFIED (source).** A developer asked Apple DTS exactly this — "macOS caches the previous version of my ScreenSaver until I reboot" — and Quinn "The Eskimo!" answered with (a) a manual cache-clearing ritual, (b) "use Terminal to find and kill the host process in which the screen saver is running", noting *the real screen saver is much more "sticky" than the preview*, and (c) the actual recommendation: **develop with a "debug host" app that loads the `.saver` bundle and instantiates the `ScreenSaverView`**, with a code snippet doing exactly that. — <https://developer.apple.com/forums/thread/745327>

That is Loop A above, endorsed by DTS. The probe in this document is an independent reimplementation of it and works.

**VERIFIED (source).** Quinn's manual cache-clearing ritual, when a `killall` is not enough:

1. Select a *different* screen saver.
2. Click its **Preview** button.
3. Escape out of it.
4. Control-click your screen saver and choose **Delete**.
5. Quit and relaunch System Settings.

Note what this implies: the preview path and the real path cache separately, and the real one is stickier. If a change shows up in preview but not in the running saver, that is expected, not a bug in your build.

**VERIFIED (source).** The reference template also ships a `SaverTest` target for exactly this purpose, and its logging convention is worth copying — a fixed prefix plus the pid (`SSM (P:12345)`) so a single `log stream` filter follows one instance across `ScreenSaverEngine`, System Settings, and the debug host, which are three different hosting environments with three different process names. — <https://github.com/AerialScreensaver/ScreenSaverMinimal>

For Punch, that means: pick a prefix now (`PUNCH (P:<pid>) [instance i/n]`), log it from `init(frame:isPreview:)`, `startAnimation`, `stopAnimation`, and the willStop observer, and always `privacy: .public`.

### On attaching LLDB

**INFERRED, and the honest answer is: do not plan on it.** No first-party or community source found in this research documents a working, routine LLDB attach to `legacyScreenSaver.appex` on Sonoma or later. The host is Apple-signed, sandboxed, hardened, and spawned on demand by `WallpaperAgent`; `get-task-allow` would have to be set on Apple's binary, not ours. Every practitioner source consulted — Apple DTS included — routes around the problem with a debug host app instead of attaching to the real one.

Treat the unified log as the debugger for Loop B, and get your breakpoints in Loop A. If an attach is ever needed, `Debug → Attach to Process by PID or Name…` on `legacyScreenSaver` is the thing to try, and the result should be recorded here.


---

## 5. Metal & timing

### Metal works. The footgun is the bundle, not the GPU.

**VERIFIED (local, experiment).** `MTLCreateSystemDefaultDevice()` returns a valid device from code loaded out of a `.saver` bundle (§2). Metal requires no entitlement — it is not in the host's entitlement list, and it does not need to be. Compute encoders, command queues, and `CAMetalLayer` are all ordinary Metal API with no extension-specific gate that this research found.

**VERIFIED (local).** The real trap is shader library loading. `makeDefaultLibrary()` reads `Bundle.main` — and inside the appex, **`Bundle.main` is Apple's `legacyScreenSaver.appex`, not your `.saver`.** Your `default.metallib` is invisible to it. Use the bundle-scoped variant, which has existed since macOS 10.12:

```
# MacOSX26.5.sdk/System/Library/Frameworks/Metal.framework/Headers/MTLDevice.h:759
- (nullable id <MTLLibrary>)newDefaultLibraryWithBundle:(NSBundle *)bundle
      error:(__autoreleasing NSError **)error API_AVAILABLE(macos(10.12), ios(10.0));
```

```swift
// The only correct form inside a .saver:
let bundle = Bundle(for: PunchSaverView.self)
let library = try device.makeDefaultLibrary(bundle: bundle)
```

The same rule applies to every resource lookup in the saver: `Bundle(for: Self.self)`, never `Bundle.main`. **INFERRED, high confidence** — this follows directly from plug-in loading semantics and is the single most commonly reported cause of "works in my test app, blank in the screensaver".

### Timing: prefer your own display link over `animateOneFrame`

**VERIFIED (local, header).** The `ScreenSaverView` contract is a timer, and the documentation is explicit that it is a *floor*, not a rate:

> "The system calls this method each time the timer animating the screen saver fires. The time between calls to this method is always **at least** `animationTimeInterval`." — `ScreenSaverView.h`, `animateOneFrame`

> "`startAnimation` — Activates the periodic timer that animates the screen saver… If you override this method, you must call the inherited implementation at some point."

**VERIFIED (local).** The host explicitly asks for that timer: `legacyScreenSaver.appex`'s `Info.plist` sets `SSENeedsAnimationTimer => true`. Apple's own modern savers (e.g. `Arabesque.appex`) set the same key. **INFERRED:** the animation timer is driven by the extension host, and `animateOneFrame` is therefore an `NSTimer`-grade callback — not vsync-locked, not phase-aligned to the display, and subject to runloop jitter.

For a 60fps fluid simulation with ProMotion opt-in (map decision 10), a timer is the wrong clock. The right clock:

**VERIFIED (local).** `CVDisplayLink` is deprecated as of macOS 15.0, and the deprecation message names the replacement:

```
# CoreVideo.framework/Headers/CVDisplayLink.h:51
API_DEPRECATED_BEGIN("use NSView.displayLink(target:selector:), NSWindow.displayLink(target:selector:), or NSScreen.displayLink(target:selector:) ", macos(10.4, 15.0))
```

**VERIFIED (local).** The replacement is a `CADisplayLink` vended by the view, available from macOS 14.0:

```
# AppKit/NSView.h — API_AVAILABLE(macos(14.0)) @interface NSView (NSDisplayLink)
- (CADisplayLink *)displayLinkWithTarget:(id)target selector:(SEL)selector
    NS_SWIFT_NAME(displayLink(target:selector:));
```

Its header note matters for a screensaver: *"If the view is hidden, or not on any display, the callback will not be invoked."* That is free power management — a saver on a sleeping or disconnected display stops being ticked.

**Recommended shape (INFERRED, to be validated by the tracer bullet):**

```swift
override func startAnimation() {
    super.startAnimation()                       // required by the header contract
    let link = displayLink(target: self, selector: #selector(tick))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
    link.add(to: .main, forMode: .common)
    displayLinkRef = link
}
override func stopAnimation() { displayLinkRef?.invalidate(); displayLinkRef = nil; super.stopAnimation() }
override func animateOneFrame() { /* deliberately empty — the display link drives rendering */ }
```

Set `animationTimeInterval` to something coarse and cheap (the template's `1/30.0`, or larger) so the host's timer costs nothing, and do the real work on the display link. `CAFrameRateRange` is how ProMotion opt-in (decision 10) and on-battery degradation are expressed — you lower `preferred`, you do not stop the link.

### Two build-environment facts worth knowing before CI is written

**VERIFIED (local).** Xcode 26 does **not** ship the offline Metal shader compiler by default. Compiling a `.metal` file fails until a component is downloaded:

```
$ xcrun -sdk macosx metal -c shader.metal -o shader.air
error: cannot execute tool 'metal' due to missing Metal Toolchain;
       use: xcodebuild -downloadComponent MetalToolchain
```

⚠️ This lands directly on map decision 12 (GitHub Actions build+test per PR). **Any CI job that builds a `.metallib` must run `xcodebuild -downloadComponent MetalToolchain` first**, and that download wants caching or every build pays for it. Golden-image tests (decision 13) are in the same boat.

**VERIFIED (local, experiment).** Runtime MSL compilation works and does **not** need the offline toolchain — it goes through the OS's runtime compiler:

```
device=Apple M5 Max
runtime MSL compile OK, functions=["punch"]
compute pipeline OK, maxThreads=1024
```
from `try device.makeLibrary(source: src, options: nil)` + `makeComputePipelineState(function:)`.

This is a real signal for the map's "runtime MSL compilation in the sandbox" open question (the user-authored-shaders v2 door): the API works, needs no toolchain install on the user's machine, and produced a working compute pipeline. **Still INFERRED for our case:** this probe was unsandboxed. Runtime compilation is serviced by `MTLCompilerService` over XPC, and the host's mach-lookup allowlist is short (§2). Whether that particular lookup is permitted inside `legacyScreenSaver.appex` is untested — put it on the tracer bullet's checklist, because a cheap `makeLibrary(source:)` call answers a v2 architecture question for free.

### Lifecycle landmines — three host bugs that shape the code

These are not edge cases. They are the current, documented behaviour of the shim, and each one has architectural consequences for a saver that holds a Metal device, a texture set, and an audio tap.

#### 1. `stopAnimation` is never sent, and instances are never released

**VERIFIED (source).** Since Sonoma, `legacyScreenSaver.appex` fails to send `stopAnimation` and does not destroy the `ScreenSaverView` instance. Every activation stacks another live instance inside the same process. Users see `legacyScreenSaver` at ~20% CPU with the screensaver not even visible; Apple Feedback `FB13041503`. — Apple Developer Forums, <https://developer.apple.com/forums/thread/738547>; `AerialScreensaver/ScreenSaverMinimal` README, <https://github.com/AerialScreensaver/ScreenSaverMinimal>

⚠️ For Punch this is severe rather than annoying. An orphaned instance keeps a `CAMetalLayer`, a command queue, textures, a fluid simulation, and a display link alive. Leak three of those and the machine is running three fluid sims to render nothing.

**VERIFIED (source).** The workaround the ecosystem converged on is to watch a distributed notification and terminate the host process:

```swift
willStopObserver = DistributedNotificationCenter.default().addObserver(
    forName: NSNotification.Name("com.apple.screensaver.willstop"),
    object: nil, queue: .main) { [weak self] _ in self?.handleWillStop() }

private func handleWillStop() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { exit(0) }
}
```

Registered only when *not* in preview and *not* running in the debug host. The template's own README calls it "a bad idea for many reasons, [but] it works, and it's the only workaround we have found." — <https://github.com/AerialScreensaver/ScreenSaverMinimal>; see also `JohnCoates/Aerial` issue [#1305](https://github.com/JohnCoates/Aerial/issues/1305)

**Design consequence:** treat `stopAnimation` as advisory and `deinit` as never happening. Every expensive resource must be releasable from an explicit teardown you trigger yourself, and the saver must be correct when the process is killed mid-frame. Apple's own DTS position on the underlying cause is blunt — Quinn: *"The legacy screen saver API relies on a complicated compatibility shim, and that's a source of ongoing problems"* — with the recommended action being to file an enhancement request for an app-extension-based API (<https://developer.apple.com/forums/thread/738547>).

#### 2. `isPreview` cannot be trusted, and macOS 26 made it worse

**VERIFIED (source).** `isPreview` has been wrong for years (Radar `FB7486243`); the long-standing workaround was to ignore the flag and infer from the frame size:

```swift
preview = !(frame.width > 400 && frame.height > 300)
```

On macOS 26 (Tahoe) the behaviour changed again and, per the template's maintainers, **"the Tahoe bug currently has no known workaround"** — their fallback is to infer preview state from whether the screen is locked. — <https://github.com/AerialScreensaver/ScreenSaverMinimal>

⚠️ This machine runs macOS 27, so the Tahoe-era behaviour is the behaviour we get. **Do not branch expensive setup on `isPreview` alone.** Size-based inference plus a conservative default (assume preview, i.e. assume cheap) is the safer construction, and the tracer bullet should log both `isPreview` and the frame size from every instantiation so we learn what macOS 27 actually passes.

#### 3. Swift in a `.saver` is only recently safe

**VERIFIED (source).** The same maintainers state that Swift screen savers are only officially supported as of **macOS 14.6**, and recommend targeting only the current and previous macOS releases. — <https://github.com/AerialScreensaver/ScreenSaverMinimal>

This is further support for map decision 6's macOS 15.0 floor — it sits comfortably above the line, with no reason to reach lower.

*(One claim from that README does not hold on this machine: it says Apple discontinued the Objective-C screen saver template in Xcode 26. VERIFIED (local) — the `Screen Saver.xctemplate` is present in Xcode 26.6 and is still Obj-C, §2. Possibly fixed after an early Xcode 26 beta.)*

### What real Metal savers do

**VERIFIED (source).** `CAMetalLayer` directly, not `MTKView`, is the pattern in the field:

- `thoughtworks/dancing-glyphs` — `Library/MetalScreenSaverView.swift` builds a `CAMetalLayer` (`bgra8Unorm`, `framebufferOnly = true`, `contentsScale` from the window's backing scale factor) and drives frames from a `CVDisplayLink`, overriding `startAnimation()`/`stopAnimation()` to start/stop the link **instead of calling `super`**, and reporting `isAnimating` from `CVDisplayLinkIsRunning`. <https://github.com/thoughtworks/dancing-glyphs/blob/master/Library/MetalScreenSaverView.swift>
- `space4yyy/splatoon3screensaver` — a `ScreenSaverView` backed directly by `CAMetalLayer`, described as avoiding `MTKView`'s lifecycle problems and behaving better across Retina and multi-GPU setups. <https://github.com/space4yyy/splatoon3screensaver>
- `fuzzywalrus/ScreenSaverKit` — an Obj-C framework for macOS 11→current with Metal rendering diagnostics (success/failure rates, FPS) drawn on a `CAMetalLayer`. <https://github.com/fuzzywalrus/ScreenSaverKit>
- `AerialScreensaver/ScreenSaverMinimal` — the reference Swift template, `SaverTest` debug host, current for macOS 15.6 / Xcode 26. <https://github.com/AerialScreensaver/ScreenSaverMinimal>
- `JohnCoates/Aerial` — the largest real-world third-party saver; its issue tracker is the best archive of Sonoma+ breakage. <https://github.com/JohnCoates/Aerial>

**Two adjustments to the §5 recommendation in light of this:**

- **Use `CAMetalLayer`, not `MTKView`.** Two independent projects cite `MTKView` lifecycle problems inside savers. `CAMetalLayer` via `makeBackingLayer()` gives full control of the drawable and the frame clock.
- **`dancing-glyphs` does not call `super.startAnimation()`.** That contradicts the header's "you must call the inherited implementation." Given landmine #1, deliberately *not* starting the host's timer is defensible — it is one less thing leaking in an orphaned instance. Prefer calling `super` (contract-correct) and leaving `animateOneFrame` empty; fall back to skipping `super` only if the host timer proves to cost something measurable. Either way, be deliberate: this is a choice, not a detail.


## 6. Multi-display

⚠️ **This is the weakest part of the platform, and it lands squarely on map decision 8.**

**VERIFIED (source).** Multi-monitor behaviour in the legacy shim is broken, and has been broken in different ways in most releases since Catalina. The reported behaviour is that `legacyScreenSaver` **instantiates one saver per display and then only one of them continues to run** — on multi-monitor setups the saver is called once rather than once per screen as it historically was. — Apple Developer Forums <https://developer.apple.com/forums/thread/117136>; `AerialScreensaver/ScreenSaverMinimal`'s README states multi-monitor support on macOS 26 is "mostly broken in new ways" (<https://github.com/AerialScreensaver/ScreenSaverMinimal>)

**VERIFIED (source).** Instances are enumerable from within a single process — `ScreenSaverMinimal` tracks them with a shared registry and logs `Instance 1/3`, which only works if those views live in one address space:

```swift
instanceNumber = InstanceTracker.shared.registerInstance(self)
let totalInstances = InstanceTracker.shared.totalInstances
```

So the model appears to be **one `legacyScreenSaver` process hosting N `ScreenSaverView` instances**, not a process per display. That is the good news: siblings *can* share a preset, an audio source, and a device without IPC. **INFERRED**, since it rests on that instance tracker behaving as advertised rather than on a direct observation here — confirm with `ps aux | grep legacyScreenSaver` on a two-display setup.

**VERIFIED (source).** A user-level workaround exists for the "only one display animates" problem on Sequoia: System Settings → Desktop & Dock → enable *Displays have separate Spaces*, then in Screen Saver settings turn off *Show on all Spaces* and configure each display from the dropdown. That it takes a three-step settings ritual tells you how load-bearing this path is.

**VERIFIED (local).** The store is shaped for per-display choice: `Index.plist` carries `AllSpacesAndDisplays`, `Displays`, `Spaces`, and `SystemDefault` (§3). On this machine `Displays` and `Spaces` are empty — one linked choice for everything. A user *can* pick a different saver per display, so "same preset everywhere" is our default, not an OS guarantee.

**VERIFIED (local).** `-[NSView displayLinkWithTarget:selector:]` vends a link "in-sync with the display the view is on" and does not fire when the view is hidden or off-display (`AppKit/NSView.h`). Per-display cadence and per-display sleep come for free — *if* the instance is alive and on a screen.

### What this means for decision 8

Decision 8 — *"one instance per display, same preset and audio, different seed — siblings, not clones"* — is the right design and is **not** overturned. But it now carries a platform risk that did not exist when it was locked: **the OS may not keep more than one instance running.** Recommendation:

- Keep the design as decided; it is correct, and it is what a working platform would give us.
- Make each instance self-sufficient (own device, queue, textures, seed) and treat cross-instance sharing as an optimization to add once the process model is confirmed.
- Derive the seed from something stable per display (e.g. `NSScreen`'s display ID) so a restarted instance looks like itself.
- **Add "does the second display actually animate?" to the tracer bullet's Loop B checklist.** If the answer is no, that is a platform bug to document and degrade around — a single-display-perfect Punch that is honest about the second display beats a Punch that pretends.

**INFERRED:** with mixed GPUs (integrated + discrete, or an eGPU) different displays can be backed by different `MTLDevice`s. Call `MTLCreateSystemDefaultDevice()` per instance and never share a pipeline state across instances without confirming the device matches. Moot on Apple Silicon, which is most of the audience.


## 7. Cross-ticket alerts

Three findings here reach outside this ticket's scope and should be carried to their owners now rather than discovered later.

1. **⚠️ Audio capture may not be possible from inside the saver at all.** The host has no `com.apple.security.device.audio-input` entitlement, and we cannot add one. This bears directly on map decision 2 (system output capture is the hero). The audio research ticket must test capture *inside `legacyScreenSaver.appex`*, not in a test app, before the audio architecture is settled. If capture is blocked, the fallback shape is a companion-app capture helper plus an IPC channel — and §2 shows the IPC options are narrow (file polling or localhost sockets; probably not XPC).
2. **⚠️ App Groups are not available to the saver.** Map decision 11 puts settings in a shared App Group container. The entitlement is absent from the host. The likely rescue is that the host's read-only `/` exception lets the saver read the group container *by path* — making the contract "companion app writes, saver reads", which is what decision 11 wanted anyway. Cheap to test; test it early.
3. **⚠️ CI must install the Metal toolchain.** `xcrun metal` is not present in a stock Xcode 26 install (`xcodebuild -downloadComponent MetalToolchain`). Map decision 12's GitHub Actions build needs this step and a cache for it.

None of these overturns a locked decision outright. Decisions 5 (raw Metal + compute shaders), 6 (macOS 15.0 floor), 10 (60fps/ProMotion/degradation) and 1 (companion app as the dev harness) all came out of this research **strengthened**.

---

## 8. Open questions

Ranked by how much later work they gate. Each is phrased as an experiment, because each is answerable in the tracer bullet by adding a few lines and one trip through Loop B.

1. **Does `MTLCreateSystemDefaultDevice()` succeed inside `legacyScreenSaver.appex`?** Verified only in an unsandboxed host here. Everything on the map depends on "yes". Log it from `init(frame:isPreview:)` with `privacy: .public` and read the unified log. *Gates: the entire project.*
2. **Does `CAMetalLayer` render correctly as a `ScreenSaverView` backing layer inside the host?** The host holds a `com.apple.CARenderServer` mach-lookup exception, which is a good sign, but layer-backed rendering in a window owned by another process is exactly where surprises live. *Gates: the renderer's whole architecture.*
3. **Can the saver read a file under `~/Library/Group Containers/`?** Tests the §2 workaround for decision 11 in one line. *Gates: the settings design.*
4. **One process per display, or one process with N views?** `ps aux | grep legacyScreenSaver` with two displays attached, while the saver runs. *Gates: decision 8's "siblings, not clones" implementation, and how audio reaches each instance.*
5. **Is `MTLCompilerService` reachable from inside the sandbox** — i.e. does `makeLibrary(source:)` work in the appex? Answers the map's "runtime MSL compilation in the sandbox" open question and the v2 user-shader door for free. *Gates: nothing in v1; informs v2 architecture.*
6. **What is `com.apple.security.temporary-exception.yasb` and does it relax the mach-lookup allowlist?** Undocumented. Matters only if XPC to a companion helper turns out to be the required audio path.
7. **Does a symlinked `.saver` in `~/Library/Screen Savers` load, or must it be a real copy?** Half-answered: **VERIFIED (local, experiment)** that `NSBundle` loads a symlinked `.saver` fine in an unsandboxed host. Untested is whether the sandboxed appex — which has a read-only `/` exception but resolves paths through its own container view — follows the link, and whether `WallpaperLegacyExtension` enumerates it. Decides whether the Loop B install step is instant or a `ditto`.
8. **Does the host's animation timer keep firing if `animateOneFrame` is empty and a display link does the work** — or does the host consider a non-drawing saver stalled? *Gates: the timing design in §5.*
9. **What does macOS 27 actually pass for `isPreview`, and what frame size?** The Tahoe-era bug has no published workaround (§5). Log both from every instantiation on the first Loop B run and we will know more than the template maintainers do. *Gates: whether preview can be made cheap.*
10. **Does the second display animate at all on macOS 27?** §6. *Gates: how honest decision 8 can be.*
11. **Does the `com.apple.screensaver.willstop` distributed notification arrive inside the sandbox?** The `exit(0)` workaround for the leaked-instance bug depends on it, and distributed notifications are sandbox-mediated. *Gates: whether we leak a fluid sim per activation.*

*Closed by this research, previously open:* whether a `.saver` can be notarized and stapled directly — it can (§2), so map decision 18 rests on solid ground.

## Sources

Primary evidence for this document is the machine itself — macOS 27.0 (`26A5406e`), Xcode 26.6, `MacOSX26.5.sdk` — via the commands shown inline. Every such claim is re-runnable.

- `ScreenSaverView` reference (not deprecated, macOS 10.0+) — <https://developer.apple.com/documentation/screensaver/screensaverview>
- `ScreenSaver` framework — <https://developer.apple.com/documentation/screensaver>
- SDK headers: `ScreenSaver.framework/Headers/ScreenSaverView.h`, `AppKit/NSView.h` (`NSView (NSDisplayLink)`), `CoreVideo/CVDisplayLink.h`, `Metal/MTLDevice.h`, `QuartzCore/CADisplayLink.h`
- On-disk system components: `legacyScreenSaver.appex`, `WallpaperLegacyExtension.appex`, `Arabesque.appex`, `ScreenSaverEngine.app`, `Screen Saver.xctemplate`

Apple Developer Forums (DTS replies by Quinn "The Eskimo!"):

- ScreenSaver caching during development on Sonoma — <https://developer.apple.com/forums/thread/745327>
- Third-party screensavers not quitting on Sonoma (FB13041503) — <https://developer.apple.com/forums/thread/738547>
- `legacyScreenSaver` process / multi-display — <https://developer.apple.com/forums/thread/117136>
- Your Friend the System Log — <https://developer.apple.com/forums/thread/705868>

Open-source `.saver` projects consulted:

- `AerialScreensaver/ScreenSaverMinimal` — Swift template, macOS 15.6 / Xcode 26, `SaverTest` debug host, documented Sonoma+/Tahoe workarounds — <https://github.com/AerialScreensaver/ScreenSaverMinimal>
- `JohnCoates/Aerial` — <https://github.com/JohnCoates/Aerial>
- `thoughtworks/dancing-glyphs` — `CAMetalLayer` + display-link `ScreenSaverView` — <https://github.com/thoughtworks/dancing-glyphs/blob/master/Library/MetalScreenSaverView.swift>
- `space4yyy/splatoon3screensaver` — `CAMetalLayer`-backed saver — <https://github.com/space4yyy/splatoon3screensaver>
- `fuzzywalrus/ScreenSaverKit` — Obj-C saver framework, macOS 11→current — <https://github.com/fuzzywalrus/ScreenSaverKit>
