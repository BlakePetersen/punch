# Contributing to Punch

Thanks for looking. Punch is early: the route is being proven and the product specified before much code exists. That makes some contributions premature and others very welcome. This page says which is which, and how the repo works.

## Where things stand

The [wayfinder map](https://github.com/BlakePetersen/punch/issues/1) is the single source of truth for what is decided and what is open. Read it before proposing a direction; a lot of the obvious questions ("why not a `.saver`?", "why not the microphone?") are already answered there with evidence.

Until a first build exists, the most useful contributions are:

- **Bug reports against the prototypes** on `prototype/*` branches, if you run them.
- **Corrections to the research** on closed tickets. If a claim on the map is wrong, say so on that ticket with a source.
- **Discussion on open tickets**, especially ones labelled `wayfinder:grilling`.

Code contributions become practical once the tracer bullet ([#11](https://github.com/BlakePetersen/punch/issues/11)) lands.

## Reporting a bug

Use the bug report template. Include the macOS version, the Mac model, what was playing and from which app, and whether the screen saver was running for real or in the System Settings preview. Screen recordings help more than screenshots for anything about motion.

## Presets

A preset is a single JSON file. It declares parameter values, a palette, and a routing table that maps `AudioFrame` features (band level, onset, presence, time, tempo) onto engine parameters. It contains no code and cannot make the screensaver crash or hang, which is why presets can be accepted from anyone.

The schema is being settled on [#9](https://github.com/BlakePetersen/punch/issues/9). Once it lands, a preset pull request is expected to look like this:

- One file, `presets/<engine>/<name>.json`, and nothing else in the diff.
- A name that describes what it looks like, not who made it.
- Every routed parameter uses a modulating route by default, so the preset still moves in silence.
- A short description in the pull request of what track or genre it was tuned on.

Do not port presets from MilkDrop, projectM or Butterchurn. Their preset corpora carry licences that are not compatible with redistribution here, and their visual language is not what Punch is going for.

## Code

- `main` is protected. All changes arrive by pull request, and CI must pass.
- Tests come first. DSP changes are covered by unit tests against synthetic signals; rendering changes by golden-image tests driven from scripted `AudioFrame` sequences.
- Keep changes small and reviewable. One concern per pull request.
- Every source file starts with a two-line `// ABOUTME:` comment saying what the file is for.
- Names describe purpose, not history. No "new", "legacy", "v2" in identifiers.
- Match the surrounding style. There is no formatter to argue with yet; when one arrives it will be the arbiter.
- Do not copy code from projectM (LGPL). Butterchurn (MIT) and ISF's reference implementation (BSD-3) are fine to borrow from with attribution in the file.

Commit messages: a short imperative subject, a body that says why. Reference the issue with `#n` where one exists.

## Licence

Punch is Apache-2.0. By contributing you agree that your contribution is licensed under the same terms, as described in section 5 of the [LICENSE](LICENSE). There is no separate contributor agreement.
