# Prior art: how other visualizers solved this

Research for [#4](https://github.com/BlakePetersen/punch/issues/4). Conclusions bearing on map
decisions **2** (audio source), **15** (preset = engine code + JSON data + modulation routing
table), and **17** (transitions via parameter interpolation).

This is a conclusions document, not a survey. Everything here is either something Punch should
copy, something Punch should refuse to copy, or a constraint on what Punch is allowed to copy.

**Headline:** the design the map already settled on is not novel — it is
[Synesthesia's Shader Format](https://app.synesthesia.live/docs/ssf/ssf.html), shipping
commercially since 2018, and it is close to
[ISF](https://github.com/mrRay/ISF_Spec). Both are engine-code-plus-JSON-parameters. Both name
their audio features rather than exposing raw FFT. Synesthesia's `SMOOTH_TRANSITIONS` is
literally decision 17. Punch should adopt their vocabulary wholesale instead of inventing one.

---

## What to steal

### From Butterchurn — MIT, borrowable verbatim

[jberg/butterchurn](https://github.com/jberg/butterchurn) is a from-scratch WebGL
reimplementation of MilkDrop. It is **MIT**, which makes it the single most useful piece of
MilkDrop prior art for an Apache-2.0 project: the algorithms are legible, correct, and legally
clean, where projectM's are LGPL.

**1. The band-energy normalization algorithm.** This is the thing that makes MilkDrop feel
connected to the music, and Punch's `AudioFrame` (decision 7) should implement it.
From [`src/audio/audioLevels.js`](https://github.com/jberg/butterchurn/blob/master/src/audio/audioLevels.js):

- Band edges by **Hz, not bin index**: bass `20–320 Hz`, mid `320–2800 Hz`, treble
  `2800–11025 Hz`, converted to bins via `bucketHz = sampleRate / fftSize`.
- Three time scales per band, all exponential moving averages:
  - `imm` — this frame's summed band energy.
  - `avg` — short-term, `rate = 0.2` when rising, `0.5` when falling (**asymmetric attack/release**).
  - `longAvg` — long-term baseline, `rate = 0.9` for the first 50 frames then `0.992`.
- Every rate is frame-rate compensated: `rate ** (30.0 / effectiveFPS)`. Punch runs at 60 and
  degrades on battery (decision 10), so **this compensation is mandatory, not optional** — without
  it the same preset feels different at 60fps and 30fps.
- The exported values are **ratios against the long-term baseline**, not absolute energies:
  `val = imm / longAvg`, `att = avg / longAvg`, with both forced to `1.0` when
  `longAvg < 0.001` (silence).

That last point is the whole trick, and MilkDrop's own authoring guide states the resulting
semantics: bass/mid/treb give "the current amount of bass. 1 is normal; below ~0.7 is quiet;
above ~1.3 is loud bass"
([geisswerks](https://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html)).

> **This is AGC for free, and it is the answer to decision 14.** A ratio-to-baseline feature sits
> at `1.0` in silence rather than `0.0`. Presets authored against it degrade gracefully when audio
> is quiet, denied, or absent — which is exactly the "one mechanism covers silence, denied
> permissions, and the no-audio fallback" the map asked for. Punch's `AudioFrame` should carry
> **both** the absolute level and the ratio-to-baseline, and the modulation routing table should
> default to the ratio.

The `_att` (attenuated) variants are also worth copying wholesale: MilkDrop ships *both* a
snappy and a damped version of every band, and preset authors pick per-route. That is cheaper and
more expressive than making every route configure its own smoothing.

**2. The transition easing and the interpolate-vs-snap split.** From
`Renderer.mixFrameEquations(blendProgress, mdVSFrame, mdVSFramePrev)` in
[`src/rendering/renderer.js`](https://github.com/jberg/butterchurn/blob/master/src/rendering/renderer.js):

```js
const mix = 0.5 - 0.5 * Math.cos(blendProgress * Math.PI);
const mix2 = 1 - mix;
const snapPoint = 0.5;
```

- Continuous parameters are crossfaded with a **raised cosine** (ease-in-out), not a linear ramp.
- Discrete/boolean parameters (`wave_dots`, `wave_thick`, `additivewave`, `wave_brighten`,
  `darken_center`, `gammaadj`, `wrap`, `invert`, `brighten`, `darken`, `solarize`) are **snapped
  at `blendProgress = 0.5`**, never interpolated.

> **Decision 17 needs a third field per parameter.** A preset parameter is not just
> `{ name, value }`; it needs an *interpolation kind* — `continuous` (lerp with cosine ease) vs
> `discrete` (snap at the midpoint). Interpolating a boolean produces garbage. Punch should bake
> this into the parameter schema from day one rather than discovering it during the first
> transition bug.

**3. The blend-pattern generator, if Punch wants spatial transitions.**
[`src/rendering/blendPattern.js`](https://github.com/jberg/butterchurn/blob/master/src/rendering/blendPattern.js)
builds a **per-vertex crossfade mask** with a randomized pattern — linear gradient wipe, plasma
fractal (diamond-square), or radial rings — each with a randomized band width. Each vertex carries
a scale (`vertInfoA`) and offset (`vertInfoC`) so the blend front sweeps across the mesh rather
than dissolving uniformly.

See "the spatial transition trick" below for why this matters even though Punch is not
crossfading two renders.

**4. Palette interpolation should not be in RGB.** Not from Butterchurn — this is a gap in all the
MilkDrop-lineage code. Presets carry palettes (decision 15) and transitions interpolate them
(decision 17). Interpolating RGB produces desaturated, hue-shifted midpoints; Björn Ottosson's
[Oklab writeup](https://bottosson.github.io/posts/oklab/) demonstrates that CIELAB, CIELUV and HSV
"all show hue shifts towards purple" blending white with blue, and that Oklab's orthogonal L/a/b
means "one can be altered without affecting the other two." Interpolate palettes in **Oklab (or
OkLCh for hue-rotating transitions)**. It is a dozen lines of shader math and it is the difference
between a transition that looks designed and one that looks like a dissolve.

### From Synesthesia SSF — commercial, look-don't-copy-code, but the design is the target

[Synesthesia](https://synesthesia.live) is a shipping commercial music visualizer whose scene
format (SSF) is *the same architecture Punch has chosen*: GLSL engine code plus a `scene.json`
declaring typed controls, passes, and transitions. It is closed-source, so nothing is borrowable
as code — but the design is public, mature, and validated, and the naming is free to adopt.

**1. Named audio features in a 4 × 5 grid, not raw FFT.** From
[SSF Audio Uniforms](https://app.synesthesia.live/docs/ssf/audio_uniforms.html), four *kinds* of
feature across five bands (whole spectrum, Bass, Mid, MidHigh, High):

| Kind | Uniform | Docs say |
|---|---|---|
| Level | `syn_Level`, `syn_BassLevel`, … | smoothed volume, 0–1 |
| Hits | `syn_Hits`, `syn_BassHits`, … | "detect 'hits' within specific frequency bands, spiking in value during the isolated transients" — "great for tracking drum hits" |
| Presence | `syn_Presence`, `syn_BassPresence`, … | "track the 'presence' of specific frequency bands, detecting rising or falling action **without reacting to each individual sound**" |
| Time | `syn_Time`, `syn_BassTime`, … | "clocks that move forward when the volume of a specific frequency band is high" |

> **This 4-kind decomposition is the most valuable single idea in this document.** Punch's
> `AudioFrame` (decision 7) currently says "banded energies, AGC-normalized loudness, per-band
> onset flags, tempo estimate." That is Level + Hits + tempo. It is missing **Presence** and
> **Time**, and both are load-bearing:
>
> - **Presence** is the slow structural feature — "is there bass in this song at all right now" —
>   which is what you route to things that should change per *section*, not per *beat*. Without
>   it, everything in a preset twitches at the same rate and the result reads as noise. This is the
>   named cure for "reacts to the wrong thing."
> - **Time** is an *integrator*: a clock whose rate is the band's energy. Route a Time feature to a
>   rotation or a flow offset and motion **continues in silence at a floor rate and accelerates
>   with the music** — which is decision 14's "audio modulates motion rather than driving it",
>   implemented as a feature rather than as per-route glue. `syn_CurvedTime` is the same idea with
>   a steeper response.
>
> Recommendation: `AudioFrame` should expose `level`, `hits`, `presence`, and `time` per band, plus
> whole-spectrum. Time features must be integrated in the audio layer (frame-rate independent), not
> in shaders.

**2. Tempo as a family of ready-made oscillators, not just a number.** Synesthesia exposes
`syn_BPM`, `syn_BPMConfidence` (0–1 stability), and then `syn_BPMSin` / `syn_BPMSin2` /
`syn_BPMSin4` and `syn_BPMTri` / `syn_BPMTri2` / `syn_BPMTri4` — sine and triangle LFOs already
running at beat, half-beat and quarter-beat rates. Plus `syn_OnBeat` (spike), `syn_ToggleOnBeat`
(flip-flop), `syn_RandomOnBeat` (sample-and-hold), `syn_BeatTime` (beat counter).

> A bare `tempo: Float` is nearly useless to a preset author — they have to build the phase
> accumulator themselves and it will drift. Ship the derived oscillators. `syn_BPMConfidence` is
> also the honest way to handle bad tempo estimates: route confidence to the *depth* of
> tempo-driven modulation, so a wrong BPM fades out instead of visibly fighting the music.
> `syn_RandomOnBeat` (sample-and-hold on onset) is the cheapest source of variety in existence.

**3. Two long-horizon features worth having.** `syn_FadeInOut` ("slowly rises to 1.0 as music
starts, then slowly falls to 0.0") and `syn_Intensity` ("slowly accumulates to 1.0 depending on
the intensity of the song"). `syn_FadeInOut` is the built-in answer to "music stopped, now what" —
it is the graceful hand-off between audio-driven and autonomous behaviour that decision 14 needs.

**4. `SMOOTH_TRANSITIONS` is decision 17, already shipping.** From
[SSF JSON Configuration](https://app.synesthesia.live/docs/ssf/json.html):

```json
"SMOOTH_TRANSITIONS": [
  { "UNIFORMS": ["color1", "color2", "color3"], "DURATION": 3.0 }
]
"HARD_TRANSITIONS": [
  { "UNIFORM": "myVariable", "VALUES": [0.9, 0.8, 0.2, 0.0] }
]
```

`SMOOTH_TRANSITIONS` declares a **family of mutually exclusive uniforms** where exactly one is
`1.0` and the rest are `0.0`; on a song change a new member activates and the host performs "a
linear interpolation between the old 'ON' variable and the new 'ON' variable" over `DURATION`.
`HARD_TRANSITIONS` picks a new value from an enumerated set, with duplicates used to weight the
draw.

> This is a validated existence proof that **parameter interpolation is sufficient for transitions
> inside one engine** — Punch's decision 17 is not a compromise, it is what the commercial
> incumbent does. Two refinements worth taking:
>
> - The **one-hot family** idiom is better than interpolating N independent scalars. It lets the
>   engine branch on which member is hot while the transition is still a single lerp, and it gives
>   the author explicit control over which variations are mutually exclusive.
> - Keep `HARD_TRANSITIONS`' weighted-random-from-a-list too. Not every parameter should be
>   crossfaded; some should just re-roll. Weighting by duplication is crude but requires no
>   schema.

**5. Control types encode behaviour, not just range.** SSF's `CONTROLS` entries use `TYPE`, `NAME`,
`DEFAULT`, `MIN`, `MAX`, `UI_GROUP`, `DESCRIPTION`, `PARAMS`, `LABELS`, `VALUES`, `DEF_COLOR`. The
`TYPE` list is `slider`, `knob`, `toggle`, `bang`, `bang counter`, `xy`, `color`, `dropdown` — each
with a `smooth` variant and, for continuous ones, a `speed` variant:

- **`smooth`** variants interpolate on change, with `PARAMS` as the rate: "It takes roughly
  `1/PARAMS` frames to transition (`1.0` takes 1 frame, `.1` takes ten frames)."
- **`speed`** variants make the control set a *rate*, and the host integrates it — "useful for
  controlling infinite movement like camera position or rotation."

> The **`speed` variant is a second, simpler expression of decision 14**: a parameter whose value is
> an integral is autonomous by construction. Punch's parameter schema should have a
> `position` vs `rate` distinction, and `smooth`-with-a-time-constant should be a property of the
> parameter rather than something every route reimplements. `UI_GROUP` is also worth copying — the
> companion app (decision 11) needs to render preset parameters and grouping is the cheapest way to
> keep that panel usable.

### From ISF — MIT spec, BSD-3 reference implementation, borrowable

[ISF](https://github.com/mrRay/ISF_Spec) (MIT) is a GLSL shader plus a JSON blob in a leading
comment. Reference implementation [VVISF-GL](https://github.com/mrRay/VVISF-GL) is **BSD-3-Clause**.
Implemented by VDMX, Magic, MadMapper, Millumin, CoGe — i.e. it actually achieved cross-app
portability, which is more than Shadertoy managed.

**1. Audio is a declared input type, not an ambient global.** ISF's `TYPE` values are
`"event"`, `"bool"`, `"long"`, `"float"`, `"point2D"`, `"color"`, `"image"`, **`"audio"`**, and
**`"audioFFT"`**. The spec:

> "The images sent to 'audio'-type inputs contains one row of image data for each channel of audio
> data … while each column of the image represents a single sample of the wave, the value of which
> is centered around 0.5." … "'audio'- and 'audioFFT'-type inputs allow you to specify the number
> of samples (the 'width' of the images in which the audio data is sent) via the `MAX` key."

> **The preset declares what audio it wants; the host owns where audio comes from.** This is the
> right seam for decision 2. Whether Punch's audio is a Core Audio process tap, a microphone, or a
> synthetic test signal is entirely the host's business; a preset that declares
> `{"TYPE": "audioFFT", "MAX": 256}` works identically against all three. It is also precisely what
> makes decision 7's "must be scriptable, so the renderer is testable" achievable — the preset
> cannot tell a scripted `AudioFrame` from a real one.
>
> Note the `MAX`-declares-resolution idea: presets shouldn't all pay for 1024-bin FFT texture
> uploads when most want 32 bands.

**2. `IDENTITY`.** ISF inputs carry `DEFAULT`, `MIN`, `MAX`, and `IDENTITY` — the value at which
the parameter is a **no-op**. That is not the same as `DEFAULT`, and it is exactly the field a
modulation routing table needs: it is the *baseline* a modulation offsets from, and the value to
fall back to when a route's source is unavailable. Steal the concept and the word.

**3. Automatic uniforms.** `PASSINDEX` (int), `RENDERSIZE` (vec2), `isf_FragNormCoord` (vec2),
`TIME` (float), `TIMEDELTA` (float), `DATE` (vec4), `FRAMEINDEX` (int). Note `TIMEDELTA` and
`FRAMEINDEX` — a fluid sim needs both, and `TIMEDELTA` is what makes the sim frame-rate
independent under decision 10's degradation.

**4. Buffer declarations.** `PASSES` entries carry `TARGET`, `PERSISTENT` ("the target buffer will
be persistent — saved across frames"), `FLOAT` (32-bit float per channel), and `WIDTH`/`HEIGHT` as
**equation strings**. Punch's fluid engine needs persistent float buffers for the velocity field,
and expressing internal resolution as an equation of `RENDERSIZE` is exactly decision 10's
"internal resolution scaling from day one."

### The spatial transition trick — a cheap upgrade to decision 17

Every serious MilkDrop-lineage implementation transitions by **rendering both presets and
crossfading in pixel space with a spatially-varying mask**:

- Butterchurn keeps both presets live during a blend: it runs
  `prevPresetEquationRunner.runFrameEquations()` alongside the current one, then renders
  `prevWarpShader` and `warpShader` (and `prevCompShader`/`compShader`) in sequence each frame,
  combining them through the per-vertex `blendPattern` mask.
- projectM v4 compiles **six built-in transition shaders** — Circle, Plasma, Simple Blend, Sweep,
  Warp, Zoom Blur — in
  [`TransitionShaderManager.cpp`](https://github.com/projectM-visualizer/projectm/blob/master/src/libprojectM/Renderer/TransitionShaderManager.cpp).
- MilkDrop 3's `.milk2` "double preset" format blends two presets simultaneously with selectable
  patterns ("zoom", "side", "plasma") ([MilkDrop3](https://github.com/milkdrop2077/MilkDrop3)).

Punch renders one engine, so it pays ~1× where those pay ~2×. But it also gives up the transition
*vocabulary* — the wipes and dissolves that make a change read as deliberate rather than as drift.

> **There is a way to have both.** Because a preset is data, not code, Punch can evaluate the
> parameter blend **per-pixel through a mask** instead of globally:
> `p = mix(p_old, p_new, mask(uv, t))`. One simulation, one render pass, but the transition sweeps
> across the frame like MilkDrop's. Butterchurn's `blendPattern.js` mask generators (MIT) drop
> straight in. Cost is a handful of extra interpolations in the shader, not a second render.
>
> Caveat worth prototyping: a fluid sim is stateful and spatially coupled, so a spatially-varying
> parameter field is *physically* meaningful in a way a global lerp is not — it may look better, or
> it may look like a seam. This is a cheap prototype and worth one.

### From projectM v4 — LGPL-2.1, read the design, don't copy the code

The one directly reusable thing is the **audio ingest contract**, from
[`audio.h`](https://github.com/projectM-visualizer/projectm/blob/master/src/api/include/projectM-4/audio.h):

```c
unsigned int projectm_pcm_get_max_samples();
void projectm_pcm_add_float(projectm_handle instance, const float* samples,
                            unsigned int count, projectm_channels channels);
```

> "Adds 32-bit floating-point audio samples… It is internally converted to 2-channel float data,
> duplicating the channel. If stereo, the channel order in samples is LRLRLR."
> "Returns the maximum number of audio samples that can be stored… If more samples are added, only
> this number of samples is stored and the remainder discarded."

Three design notes worth copying into Punch's audio seam (the *shape*, which is uncopyrightable —
not the code, which is LGPL):

- **Push, don't pull.** The audio source pushes buffers whenever it has them; the renderer reads
  the analysis state whenever it draws. No shared clock, no blocking. This is what makes a scripted
  `AudioFrame` source (decision 7/13) trivial.
- **The library advertises its capacity and silently truncates.** A visualizer must never
  backpressure a realtime audio callback.
- **Normalize channel count at the boundary.** Mono is upmixed at ingest, so nothing downstream
  branches on channel count.

`projectm-eval` is **MIT** (see licensing) and is a portable reimplementation of MilkDrop's ns-eel2
expression evaluator, which "directly assembles machine code from compiled assembler fragments";
projectm-eval deliberately avoids that, "sacrificing some performance over portability."
Punch does not need it — but if presets-as-code is ever reconsidered, this is the only
legally-clean starting point.

### From TouchDesigner and Ableton — vocabulary, see below

Both are proprietary; nothing to borrow but names, and names are free. Harvested into the
vocabulary section.

---

## What to avoid, and why

### Do not make a preset be code

MilkDrop presets are programs: `per_frame_init_`, `per_frame_`, `per_pixel_`/`per_vertex_`
equation blocks in an interpreted expression language, plus (in MilkDrop 2) embedded HLSL `warp`
and `comp` shaders. It produced a corpus of tens of thousands of presets. It also produced:

**Untrusted presets hang and crash the host.** projectM
[#408](https://github.com/projectM-visualizer/projectm/issues/408) is a user reporting that after
installing the community preset pack, "there are certain presets in there that cause problems…
four separate issues, according to backtraces… crashes (three problems found), and
freezes/deadlocks." [#476](https://github.com/projectM-visualizer/projectm/issues/476), a year
later, is the same user reporting the freezes were never fully fixed. In a screensaver this is not
a bug report, it is a **black or frozen lock screen**, and the user's only recourse is the power
button.

**The embedded shader dialect ossifies.** projectM's maintainer, in
[#761](https://github.com/projectM-visualizer/projectm/issues/761):

> "libprojectM uses the 'hlslparser' library from the game Natural Selection 2 to convert the HLSL
> warp and composite shader code in presets to GLSL. While this parser works well in most cases, it
> has not been maintained for ten years now, and thus doesn't support any modern versions of both
> HLSL and GLSL, which currently limits us to PS 2.0 and GLSL 3.30 syntax."

Twenty years of presets pinned the renderer to a 2007 shader model, and every renderer that wants
to run them must ship a transpiler for a dead dialect. Punch chose raw Metal + MSL (decision 5); if
presets carried shader source, Punch would inherit exactly this obligation.

**JIT is a non-starter here anyway.** ns-eel2 JITs expressions to native code. Writable-executable
memory on a notarized, hardened-runtime macOS binary requires `com.apple.security.cs.allow-jit`
([Apple Developer Forums](https://developer.apple.com/forums/thread/667527)), and a `.saver`
plug-in does not carry its own entitlements — it runs inside Apple's `legacyScreenSaver` host and
inherits that process's. *(Flagged for the saver-bundle ticket to confirm; if it holds, it closes
the presets-as-code door permanently, and also constrains the "user-authored shaders" v2 door in
decision 4.)*

> **Decision 15 is right, and the reasons are stronger than "JSON is simpler."** Data presets are
> non-Turing-complete: they cannot hang, cannot crash, cannot pin the renderer to a legacy shader
> dialect, and need no JIT. That is a security and reliability argument, not an aesthetic one.

### Do not adopt MilkDrop's variable namespace

MilkDrop passes data between stages through `q1`–`q32` and `t1`–`t8`: per-frame code writes them,
per-vertex code, custom waves, custom shapes and pixel shaders read them, and they reset each frame
to values fixed in the init block
([authoring guide](https://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html)). Thirty-two
anonymous numbered slots, meaning nothing, with a convention that lives only in comments. It is the
worst possible interface and the reason the preset corpus is largely un-editable by anyone but its
author.

Punch's routing table should have **named sources and named destinations**. If a preset needs an
intermediate value, it gets a name.

### Do not bundle the MilkDrop preset corpus

[presets-cream-of-the-crop](https://github.com/projectM-visualizer/presets-cream-of-the-crop) —
9,795 presets, the default pack for projectM since 2022 — **has no LICENSE file**, and neither does
[presets-projectm-classic](https://github.com/projectM-visualizer/presets-projectm-classic)
(~4,200 presets). Twenty years of community contributions with no license grant on record. No
license means no permission. Irrelevant to Punch's aesthetic (decision 3) but worth knowing that
the entire ecosystem sits on unlicensed content — and worth learning from: **Punch's preset
directory should require a license grant in the contribution flow from the first PR**, which
decision 18's one-file-PR model makes easy.

### Do not expose raw FFT as the primary interface

Shadertoy hands shaders a 512×2 texture — spectrum on one row, waveform on the other — and nothing
else. It is the most portable audio interface ever built and it is also why most audio Shadertoys
look the same: every author reinvents band-splitting, smoothing and onset detection in GLSL,
badly, without frame-rate compensation or a long-term baseline. MilkDrop, Synesthesia and ISF all
concluded the same thing — ship *analyzed* features. Decision 7 already says this; the raw FFT
should stay available (for spectrum-drawing engines) but should not be where a preset author
starts.

### Do not let every route configure everything

MilkDrop ships `bass` and `bass_att` and stops. Synesthesia ships four feature kinds per band and
stops. Neither exposes a per-route smoothing filter, because a routing table where every entry has
eight knobs is a routing table nobody authors. Push smoothing into the **feature** (a small fixed
menu of pre-smoothed sources) and keep the **route** to source, destination, depth, curve.

---

## Vocabulary worth adopting

For decision 15's modulation routing table. Every term below is in current use by at least one
shipping tool; preferred spelling in **bold**.

### The route

| Term | Used by | Meaning for Punch |
|---|---|---|
| **source** | synth mod matrices; VDMX "data source" | the `AudioFrame` feature the route reads |
| **destination** | synth mod matrices; TouchDesigner "export target" | the engine parameter the route writes |
| **depth** | synth mod matrices; Ableton "Modulation Amount" ("determines the modulation range relative to the base value") | signed scalar; how far the source pushes the parameter |
| **polarity** — `unipolar` / `bipolar` | Ableton "Modulation Polarity toggle — Bipolar or Unipolar"; Serum; u-he | whether the source drives `[0,1]` from the base value or `[-1,+1]` around it |
| **curve** | Serum modulation matrix; TouchDesigner `Lookup CHOP` | response shaping applied to the normalized source before depth |
| **range** — `min` / `max` | Ableton Envelope Follower "Min and Max sliders … scale the modulation range"; ISF `MIN`/`MAX` | clamp on the destination after modulation |

### Modulation vs. takeover — take this distinction verbatim

Ableton's Envelope Follower has a **Mod toggle** switching between **Modulation** mode and
**Remote Control** mode ([Live manual](https://www.ableton.com/en/live-manual/12/max-for-live-devices/)).
In Modulation mode the amount "determines the modulation range **relative to the base value**"; in
Remote Control mode the follower takes the parameter over outright, scaled between Min and Max.

> That is exactly decision 14's requirement stated as a mode. Punch should name it the same way:
> a route is either **modulating** (offsets the preset's baseline, so silence leaves the baseline
> intact) or **driving** (replaces it, so silence pins it to the floor). Default to modulating.
> The map's "every modulation route carries an autonomous baseline" becomes: *routes are
> modulating unless declared otherwise, and the baseline is the parameter's own value.*

### Response and ballistics

| Term | Used by | Meaning |
|---|---|---|
| **rise** / **fall** | Ableton Envelope Follower ("Rise… smooths the attack of the envelope"; "Fall… smooths the release") | asymmetric smoothing time constants. Prefer over attack/release — unambiguous for a non-audio parameter, and matches Butterchurn's asymmetric `0.2`/`0.5` rates |
| **gain** | Ableton ("gain applied to the incoming signal") | pre-curve scaling of the source |
| **delay** | Ableton Envelope Follower "Delay control" | offset in time; cheap way to stagger routes so a preset doesn't pulse in lockstep |
| **time constant** | Web Audio `setTargetAtTime` | the honest unit for an exponential smoother; frame-rate independent by construction |
| **from range** / **to range** | TouchDesigner `Math CHOP` (`fromrange1/2`, `torange1/2`) | linear remap. Use if a general remap is wanted instead of depth+polarity |
| **lag** | TouchDesigner `Lag CHOP` | separate attack/decay slew |
| **envelope follower** | universal | the thing that turns band energy into a smooth control signal |
| **onset detection** | MIR literature | the thing that produces Hits |

### Feature kinds — from Synesthesia, adopt as-is

**level** · **hits** · **presence** · **time** — per band, plus whole-spectrum. Plus
**confidence** on tempo, and **fade-in-out** / **intensity** as long-horizon features.
`level`/`hits`/`presence` map to three time scales of the same band energy — Butterchurn's `imm`,
`avg` and `longAvg` are already exactly those three.

### Parameter kinds — from ISF/SSF

**default** · **min** · **max** · **identity** (the no-op value; the baseline for modulation) ·
**label** · **group** (SSF `UI_GROUP`, for the companion app's panel) ·
**interpolation**: `continuous` | `discrete` (Butterchurn's lerp-vs-snap) ·
**kind**: `position` | `rate` (SSF's `speed` variants — a `rate` parameter is integrated by the
host and is autonomous by construction).

### Terms to reject

- **`q1`…`q32`, `t1`…`t8`** (MilkDrop) — anonymous numbered slots. Named values only.
- **`bind`** (TouchDesigner's bi-directional parameter mode) — Punch's routes are one-way;
  borrowing the word invites confusion. TouchDesigner's four parameter modes are **Constant**,
  **Expression**, **Export**, **Bind** ([derivative.ca](https://derivative.ca/UserGuide/Parameter));
  Punch wants Constant and Export only, and should call the latter **routed**.
- **`amount`** — ambiguous between depth and range. Use **depth**.
- **`att`** (MilkDrop's attenuated suffix) — means "attenuated", reads as "attack". Use rise/fall.

---

## Licensing constraints

Punch is Apache-2.0. Apache-2.0 can absorb MIT, BSD-2/3-Clause and ISC code with attribution. It
cannot absorb GPL or LGPL code, and LGPL is not made safe by dynamic linking in a distributed
`.saver` bundle.

### Safe to borrow code from

| Project | License | Verified |
|---|---|---|
| **Butterchurn** ([jberg/butterchurn](https://github.com/jberg/butterchurn)) | **MIT** | GitHub license API |
| **projectm-eval** ([repo](https://github.com/projectM-visualizer/projectm-eval)) | **MIT** — "put under the MIT license to make it useful in other projects, open source and closed source" | GitHub license API + README |
| **ISF_Spec** ([mrRay/ISF_Spec](https://github.com/mrRay/ISF_Spec)) | **MIT** | GitHub license API |
| **VVISF-GL** ([mrRay/VVISF-GL](https://github.com/mrRay/VVISF-GL)) | **BSD-3-Clause** | GitHub license API |
| **MilkDrop 2.25c** — Geiss's May 2013 source release | **BSD-3-Clause** | [Wikipedia](https://en.wikipedia.org/wiki/MilkDrop) citing geisswerks; [SourceForge](https://sourceforge.net/projects/milkdrop2/files/) `milkdrop2_v2.25c_OPEN_SOURCED_20130514_orig_code.zip` |
| **Aerial** ([JohnCoates/Aerial](https://github.com/JohnCoates/Aerial)) | **MIT** | GitHub license API |

Caveat on MilkDrop 2.25c: the released tree bundles `ns-eel2` (Cockos WDL) and Winamp SDK
components under their own terms — check per-directory before lifting anything, and note that the
parts most worth reading (the equation evaluator) are the parts with the murkiest provenance. Also
note [iaddis/milkdrop2020](https://github.com/iaddis/milkdrop2020) presents itself as MIT with a
2021 copyright naming only its own author despite being a MilkDrop 2 port; that relicensing drops
the BSD attribution requirement and is not obviously proper. **Prefer Butterchurn as the reference
implementation** — clean-room, MIT, actively maintained, and its algorithms are legible.

### Look, don't touch

| Project | License | Note |
|---|---|---|
| **projectM** ([repo](https://github.com/projectM-visualizer/projectm)) | **LGPL-2.1** (verified: `LICENSE.txt` is the LGPL 2.1 text) | Read the architecture, the API shape, the issue tracker. Copy no code. LGPL's relinking obligation is not satisfiable in practice for a notarized, statically-linked `.saver` |
| **frontend-sdl-cpp** ([repo](https://github.com/projectM-visualizer/frontend-sdl-cpp)) | **GPL-3.0** | projectM's own desktop app. Useful as a worked example of audio ingest; copy nothing |
| **BlackHole** ([ExistentialAudio/BlackHole](https://github.com/ExistentialAudio/BlackHole)) | **GPL-3.0**, plus explicit trademark restrictions: "does not grant permission to use the BlackHole name, logo, trademarks, or branding for modified versions, unofficial builds, or third-party distributions without prior written permission" | Recommending users install it is fine; bundling or rebranding it is not. Feeds directly into decision 2 — see below |
| **MilkDrop3** ([milkdrop2077/MilkDrop3](https://github.com/milkdrop2077/MilkDrop3)) | **none** — no LICENSE file in the repo | No license means no permission. Do not copy |
| **milkdrop2077** | GPL-3.0 | |
| **Kodi visualization.milkdrop** | GPL-2.0 | |
| **Synesthesia** | proprietary, closed source | The docs are public and the *design* is free to learn from; nothing is copyable |
| **TouchDesigner, Resolume, VDMX, Magic, Ableton** | proprietary | Vocabulary only |

### Content licensing

- **Shadertoy** shaders default to **CC BY-NC-SA 3.0** unless the author states otherwise. The
  **NC** clause makes the corpus unusable for anything with a commercial path, and messy even for
  a free project. Punch should take Shadertoy's *uniform conventions* (which are facts, not
  expression) and none of its shaders.
- **MilkDrop preset packs** — unlicensed (see above).
- **presets-milkdrop-texture-pack** — no license file either.

---

## What this changes

1. **Decision 7 (`AudioFrame`) should grow.** Add **presence** (slow, structural) and **time**
   (energy-integrated clocks) per band, alongside level and hits. Add **tempo confidence** and the
   derived beat-rate oscillators. Add **fade-in-out**. Every feature must be frame-rate compensated
   at the source.
2. **Decision 7 should be ratio-normalized, not absolute.** Ship Butterchurn's
   `imm / longAvg` design so `1.0` means "normal for this song" and silence reads as `1.0`, not
   `0.0`. This is what makes decision 14 fall out for free instead of needing per-route glue.
3. **Decision 15's parameter schema needs three fields it doesn't have yet**: `identity` (the
   no-op/baseline value), `interpolation` (`continuous` | `discrete`), and `kind`
   (`position` | `rate`).
4. **Decision 15's route schema**: `source`, `destination`, `depth`, `polarity`, `curve`, `range`,
   and a **mode** of `modulating` (default, offsets the baseline) vs `driving` (replaces it).
5. **Decision 17 is confirmed by prior art**, with one addition: interpolate with a raised cosine,
   snap discrete parameters at the midpoint, interpolate palettes in Oklab, and prototype a
   spatially-masked parameter blend to recover MilkDrop's transition vocabulary at ~1× cost.
6. **Decision 2 has a licensing wrinkle.** The virtual-device fallback everyone reaches for
   (BlackHole) is GPL-3 with trademark restrictions — recommendable, not bundleable. That raises the
   stakes on first-party system-audio capture. *(Detail owned by the audio-capture ticket.)*

---

## Sources

Primary sources consulted directly.

**MilkDrop / projectM**
- MilkDrop preset authoring guide — https://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html
- projectM `LICENSE.txt` — https://raw.githubusercontent.com/projectM-visualizer/projectm/master/LICENSE.txt
- projectM v4 audio API — https://github.com/projectM-visualizer/projectm/blob/master/src/api/include/projectM-4/audio.h
- projectM transition shaders — https://github.com/projectM-visualizer/projectm/blob/master/src/libprojectM/Renderer/TransitionShaderManager.cpp
- projectM #408 (preset crashes/deadlocks) — https://github.com/projectM-visualizer/projectm/issues/408
- projectM #476 (freezes persist) — https://github.com/projectM-visualizer/projectm/issues/476
- projectM #761 (hlslparser / PS 2.0 ceiling) — https://github.com/projectM-visualizer/projectm/issues/761
- projectm-eval — https://github.com/projectM-visualizer/projectm-eval
- Preset packs (unlicensed) — https://github.com/projectM-visualizer/presets-cream-of-the-crop · https://github.com/projectM-visualizer/presets-projectm-classic
- MilkDrop 2.25c BSD release — https://en.wikipedia.org/wiki/MilkDrop · https://sourceforge.net/projects/milkdrop2/files/
- MilkDrop3 (no license) — https://github.com/milkdrop2077/MilkDrop3

**Butterchurn (MIT)**
- `src/audio/audioLevels.js` — https://github.com/jberg/butterchurn/blob/master/src/audio/audioLevels.js
- `src/audio/audioProcessor.js` — https://github.com/jberg/butterchurn/blob/master/src/audio/audioProcessor.js
- `src/rendering/renderer.js` (`mixFrameEquations`) — https://github.com/jberg/butterchurn/blob/master/src/rendering/renderer.js
- `src/rendering/blendPattern.js` — https://github.com/jberg/butterchurn/blob/master/src/rendering/blendPattern.js

**Synesthesia SSF**
- Audio uniforms — https://app.synesthesia.live/docs/ssf/audio_uniforms.html
- Standard uniforms — https://synesthesia.live/docs/ssf/standard_uniforms.html
- JSON configuration (`CONTROLS`, `PASSES`, `HARD_TRANSITIONS`, `SMOOTH_TRANSITIONS`) — https://app.synesthesia.live/docs/ssf/json.html

**ISF**
- ISF spec — https://github.com/mrRay/ISF_Spec
- VVISF-GL (BSD-3) — https://github.com/mrRay/VVISF-GL

**Vocabulary**
- Ableton Live 12 manual, Max for Live devices (Envelope Follower) — https://www.ableton.com/en/live-manual/12/max-for-live-devices/
- TouchDesigner parameter modes — https://derivative.ca/UserGuide/Parameter
- TouchDesigner Math CHOP range parameters — https://docs.derivative.ca/Math_CHOP

**Other**
- Oklab — https://bottosson.github.io/posts/oklab/
- BlackHole license — https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE
- macOS hardened runtime / JIT entitlement — https://developer.apple.com/forums/thread/667527
