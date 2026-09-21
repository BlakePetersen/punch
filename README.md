# Punch

A music visualizer screensaver for macOS that reacts to whatever is actually playing.

Punch listens to the Mac's own audio output and drives a fluid simulation with it: ink billowing in water, a wave surface refracting red depth, and the two composited together. No microphone, no "visualizer" window you have to keep open. It runs as a real screensaver, so it comes on when the machine idles and the music keeps going.

## Status

Pre-alpha. Nothing is shippable yet. The project is being planned in the open on the [wayfinder map](https://github.com/BlakePetersen/punch/issues/1): one issue holds the destination and the decisions so far, and its sub-issues are the questions still being answered. Two things that had to be true are now proven:

- A sandboxed `com.apple.screensaver` extension can capture system audio through a CoreAudio process tap, with the permission prompt owned by the containing app ([#13](https://github.com/BlakePetersen/punch/issues/13)).
- The visual direction is settled: two fluid engines plus their composition ([#5](https://github.com/BlakePetersen/punch/issues/5)).

Follow the map for what's next. Throwaway spikes and prototypes live on `spike/*` and `prototype/*` branches and are never merged.

## How it will work

- **An app containing a screensaver extension.** Third-party `.saver` bundles run inside Apple's legacy host with no code identity of their own, so they can never be granted audio access. Punch ships a companion app that contains a `com.apple.screensaver` `.appex`. The app is the development harness and holds the settings; the extension does the rendering and the listening.
- **Metal, from scratch.** Engines are compute and fragment shaders written in Metal Shading Language. Each engine is a simulation that exposes textures; lighting and composition are a separate layer, which is how two engines combine for free.
- **Audio becomes an `AudioFrame`.** Band levels normalized against a long-term baseline, per-band onsets, presence, integrating clocks, and a tempo estimate. In silence every ratio reads 1.0, so a preset degrades to gentle motion rather than freezing.
- **Presets are JSON, not code.** A preset is parameters, a palette, and a routing table that maps audio features onto engine parameters. Presets cannot crash or hang the screensaver, and a community preset is a readable one-file pull request.

Requires macOS 15 or later, because that is where the extension point Punch depends on became viable.

## Contributing

Issues, presets and code are all welcome once there is something to run. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the repo works and what a preset contribution looks like. Everyone participating is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
