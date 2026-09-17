# Punch Spike — can a screensaver extension capture system audio?

Throwaway feasibility test for [#13](https://github.com/BlakePetersen/punch/issues/13). This branch is never merged; only the findings and the verbatim entitlements/Info.plist go back to [#11](https://github.com/BlakePetersen/punch/issues/11).

## What it is

Two targets sharing one probe:

- **Punch Spike.app** — a window with four buttons: start/stop a tap in the *app*, register the extension with `pluginkit`, and open Screen Saver settings.
- **PunchSpikeSaver.appex** — a `com.apple.screensaver` extension that starts the same tap when its view reaches a window, and prints the latest checkpoint on screen.

Both log to subsystem `io.blakepetersen.punch.spike`, category `ladder`.

## The checkpoint ladder

`FAILED` and `nonSilentAudio` are the two rungs that matter; the rest exist so a failure says *where* it failed rather than just "no audio".

| Rung | Meaning |
|---|---|
| `extensionInit` | the extension's principal class was constructed — it loaded at all |
| `loadView` | the view controller was created (Aerial's #101 dies between these two) |
| `viewInWindow` | the view reached a window; the probe starts here |
| `tapCreated` | `AudioHardwareCreateProcessTap` returned a tap |
| `tapFormat` | sample rate / channels / bits, read off the tap |
| `aggregateCreated` | the tap-bearing aggregate device exists |
| `ioProcCreated` / `deviceStarted` | the render callback is installed and running |
| `firstBuffer` | buffers are arriving |
| `nonSilentAudio` | **RMS > 0.0001 — the actual pass** |
| `meter` | peak RMS, once per second |

A denied tap is expected to deliver buffers of silence rather than an error, so `firstBuffer` without `nonSilentAudio` (while music plays) means *denied*, not *broken*.

## Prerequisites

- Xcode signed in to the paid team; `PUNCH_TEAM_ID` exported.
- Music playing out of the default output device throughout.

## Build and install

`pluginkit` prefers `/Applications` and refuses to register a second copy of the same bundle id, so exactly one copy exists on the machine at a time.

```sh
export PUNCH_TEAM_ID=<team id>
cd spike
xcodegen generate
xcodebuild -project PunchSpike.xcodeproj -scheme PunchSpikeHost \
  -configuration Release -derivedDataPath build -allowProvisioningUpdates build
rm -rf "/Applications/Punch Spike.app"
cp -R "build/Build/Products/Release/Punch Spike.app" /Applications/
open "/Applications/Punch Spike.app"
```

Watch the ladder in another terminal:

```sh
log stream --style compact --level info \
  --predicate 'subsystem == "io.blakepetersen.punch.spike"'
```

## Run A — the extension asks for itself

Answers: does a screensaver extension get its own TCC grant?

1. `tccutil reset All io.blakepetersen.punch.spike.saver` and `tccutil reset All io.blakepetersen.punch.spike`
2. In the app, click **Register extension**, then **Open Screen Saver settings**.
3. Select **Punch Spike**. The live preview runs the extension while you are sitting there — **this is where a prompt would appear.** Record whether one does.
4. Let the screensaver start for real (hot corner, or `open -a ScreenSaverEngine`).
5. Record the highest rung reached, and whether the on-screen text shows a meter.

## Run B — the app grants first

Answers #2's open question: does the containing app's grant reach the embedded extension?

1. `tccutil reset All` for both bundle ids again.
2. In the app, click **Start host tap**. Allow the prompt. Confirm the app itself reaches `nonSilentAudio`.
3. Trigger the screensaver again. Record whether it prompts separately, and its highest rung.

## Reading the result

| Outcome | Meaning |
|---|---|
| `nonSilentAudio` in run A | the hero path works; the extension stands on its own |
| run A silent, run B reaches `nonSilentAudio` | grants must come from the app — onboarding lives there |
| both silent at `firstBuffer` | TCC denies screensaver extensions; fall back to app-captures / extension-renders |
| never reaches `loadView` | a registration problem, not an audio one — check for duplicate `pluginkit` registrations before concluding anything |
