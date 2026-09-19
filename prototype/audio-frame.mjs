// ABOUTME: Pure DSP for wayfinder ticket #6 — turns PCM blocks into AudioFrame values with no
// ABOUTME: DOM or Web Audio dependency, so the same code runs in the browser page and in node.
//
// PROTOTYPE. Throwaway JS whose job is to settle the AudioFrame field list and default tuning
// (map decision 7) on real tracks. Algorithms per ticket #4: Butterchurn band normalization
// (three EMAs, asymmetric attack/release, ratio-to-baseline export forced to 1.0 in silence),
// SSF feature kinds (level / hits / presence / time), spectral-flux onsets, autocorrelation tempo.
// Every rate is a time constant in ms and converted per hop, which is the generalized form of
// Butterchurn's `rate ** (30 / fps)` frame-rate compensation (decision 10).

export const BAND_PRESETS = {
  'butterchurn-3': [
    { name: 'bass', lo: 20, hi: 320 },
    { name: 'mid', lo: 320, hi: 2800 },
    { name: 'treb', lo: 2800, hi: 11025 },
  ],
  'ssf-4': [
    { name: 'bass', lo: 20, hi: 250 },
    { name: 'mid', lo: 250, hi: 2000 },
    { name: 'midhigh', lo: 2000, hi: 6000 },
    { name: 'high', lo: 6000, hi: 16000 },
  ],
  'punch-5': [
    // sub gets a longer refractory: a swept kick lands in the sub bins ~100 ms after its transient
    { name: 'sub', lo: 20, hi: 80, refractoryMs: 160 },
    { name: 'bass', lo: 80, hi: 250 },
    { name: 'lowmid', lo: 250, hi: 1000 },
    { name: 'mid', lo: 1000, hi: 3000 },
    { name: 'high', lo: 3000, hi: 12000 },
  ],
};

export const DEFAULT_CONFIG = {
  fftSize: 2048,
  hop: 512,
  bands: BAND_PRESETS['punch-5'],
  all: { name: 'all', lo: 20, hi: 16000 },
  level: { attackMs: 20, releaseMs: 50, longMs: 4000, warmupMs: 300, warmupS: 1.5, silenceDb: -80, ratioCeil: 8 },
  onset: { k: 1.6, delta: 0.06, windowMs: 500, refractoryMs: 90, pulseMs: 120 },
  presence: { riseMs: 800, fallMs: 2500 },
  time: { floor: 0.25, ceil: 3 },
  tempo: { enabled: true, minBpm: 60, maxBpm: 200, windowS: 8, everyMs: 500, priorBpm: 120, priorOctaves: 1.0 },
};

export function mergeConfig(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? mergeConfig(base[k], v) : v;
  }
  return out;
}

// ---- FFT ---------------------------------------------------------------------------------

export class RealFFT {
  constructor(n) {
    this.n = n;
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
    this.window = new Float32Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  // samples: n time-domain samples. out: n/2 magnitudes (Hann-windowed, unnormalized).
  magnitudes(samples, out) {
    const { n, re, im, rev, window, cos, sin } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = samples[i] * window[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}

// ---- Analyzer ----------------------------------------------------------------------------

const emaCoef = (dt, ms) => (ms <= 0 ? 0 : Math.exp(-dt / (ms / 1000)));
const ema = (prev, x, coef) => prev * coef + x * (1 - coef);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class BandState {
  constructor(def, binLo, binHi) {
    this.name = def.name; this.lo = def.lo; this.hi = def.hi; this.refractoryMs = def.refractoryMs;
    this.binLo = binLo; this.binHi = Math.max(binHi, binLo + 1);
    this.imm = 0; this.avg = 0; this.longAvg = 0;
    this.prevMags = new Float32Array(this.binHi - this.binLo);
    this.flux = 0; this.fluxPrev = 0; this.fluxPrev2 = 0; this.threshold = 0;
    this.fluxHist = []; this.fluxSum = 0;
    this.lastHitAt = -1e9; this.hitPulse = 0;
    this.presence = 0; this.time = 0;
  }
}

export class AudioFrameAnalyzer {
  constructor(sampleRate, config = {}) {
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.sampleRate = sampleRate;
    const { fftSize, hop } = this.config;
    this.fft = new RealFFT(fftSize);
    this.mags = new Float32Array(fftSize / 2);
    this.ring = new Float32Array(fftSize);
    this.ringPos = 0; this.sinceHop = 0; this.filled = 0;
    this.frameBuf = new Float32Array(fftSize);
    this.hopDt = hop / sampleRate;
    this.t = 0; this.frames = 0;
    const bucketHz = sampleRate / fftSize;
    const mk = (def) => new BandState(def, Math.max(1, Math.round(def.lo / bucketHz)), Math.min(fftSize / 2, Math.round(def.hi / bucketHz)));
    this.all = mk(this.config.all);
    this.bands = this.config.bands.map(mk);
    // magnitude-per-bin of a full-scale sine under a Hann window is fftSize/4
    this.fullScale = fftSize / 4;
    this.silenceMag = this.fullScale * Math.pow(10, this.config.level.silenceDb / 20);
    // tempo
    const tc = this.config.tempo;
    this.osfRate = 1 / this.hopDt;
    this.osf = new Float32Array(Math.ceil(tc.windowS * this.osfRate));
    this.osfPos = 0; this.osfCount = 0; this.lastTempoAt = 0;
    this.tempo = { bpm: 0, confidence: 0, phase: 0, period: 0, anchor: 0 };
    this.bpmHist = [];
  }

  // Feed any number of samples (mono, float). Returns the AudioFrames produced (0..n).
  process(samples) {
    const out = [];
    const { fftSize, hop } = this.config;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringPos] = samples[i];
      this.ringPos = (this.ringPos + 1) % fftSize;
      if (this.filled < fftSize) this.filled++;
      if (++this.sinceHop >= hop) {
        this.sinceHop = 0;
        if (this.filled >= fftSize) {
          for (let j = 0; j < fftSize; j++) this.frameBuf[j] = this.ring[(this.ringPos + j) % fftSize];
          this.fft.magnitudes(this.frameBuf, this.mags);
          out.push(this.step(this.mags, this.hopDt));
        }
      }
    }
    return out;
  }

  // Scriptable entry point: one hop from a magnitude spectrum. Used by process() and by tests.
  step(mags, dt) {
    this.t += dt; this.frames++;
    const cfg = this.config;
    const warm = this.t < cfg.level.warmupS;
    const aAtt = emaCoef(dt, cfg.level.attackMs), aRel = emaCoef(dt, cfg.level.releaseMs);
    const aLong = emaCoef(dt, warm ? cfg.level.warmupMs : cfg.level.longMs);
    const aPulse = emaCoef(dt, cfg.onset.pulseMs);
    const aRise = emaCoef(dt, cfg.presence.riseMs), aFall = emaCoef(dt, cfg.presence.fallMs);
    const fluxWin = Math.max(2, Math.round(cfg.onset.windowMs / 1000 / dt));

    const feature = (b) => {
      // Butterchurn: imm / avg / longAvg, ratio export forced to 1.0 in silence.
      let imm = 0, flux = 0;
      for (let k = b.binLo, j = 0; k < b.binHi; k++, j++) {
        const m = mags[k];
        imm += m;
        const d = m - b.prevMags[j];
        if (d > 0) flux += d;
        b.prevMags[j] = m;
      }
      const bins = b.binHi - b.binLo;
      b.imm = imm;
      b.avg = ema(b.avg, imm, imm > b.avg ? aAtt : aRel);
      b.longAvg = ema(b.longAvg, imm, aLong);
      // Silence gate on the *current* level (avg), not the baseline: the ratio glides back to 1.0
      // within the release time when the music stops, instead of collapsing to 0 and later
      // snapping to 1 when the baseline finally decays below the floor.
      const floor = this.silenceMag * bins;
      const audible = smoothstep(floor, floor * 3, b.avg);
      const safeLong = Math.max(b.longAvg, floor);
      const level = 1 + (Math.min(cfg.level.ratioCeil, imm / safeLong) - 1) * audible;
      const att = 1 + (Math.min(cfg.level.ratioCeil, b.avg / safeLong) - 1) * audible;
      const db = 20 * Math.log10(Math.max(1e-9, imm / bins / this.fullScale));
      const abs = Math.min(1, Math.max(0, (db + 60) / 60));

      // Onset: rectified per-bin spectral flux, scale-invariant against the baseline, adaptive
      // threshold from a short running mean, one-hop lookahead peak pick, refractory period.
      // The rule itself (k, delta, refractory, peak-pick vs raw) is what Blake's ear decides.
      const nflux = (flux / safeLong) * audible;
      b.fluxHist.push(nflux); b.fluxSum += nflux;
      while (b.fluxHist.length > fluxWin) b.fluxSum -= b.fluxHist.shift();
      const mean = b.fluxSum / b.fluxHist.length;
      const thr = cfg.onset.k * mean + cfg.onset.delta;
      const cand = b.fluxPrev; // one hop of lookahead
      let hit = false;
      const refractory = (b.refractoryMs ?? cfg.onset.refractoryMs) / 1000;
      if (cand > thr && cand > b.fluxPrev2 && cand >= nflux && this.t - b.lastHitAt >= refractory) {
        hit = true; b.lastHitAt = this.t;
        b.hitPulse = Math.max(b.hitPulse, Math.min(1, cand / (thr * 2)));
      } else {
        b.hitPulse *= aPulse;
      }
      b.fluxPrev2 = b.fluxPrev; b.fluxPrev = nflux; b.flux = nflux; b.threshold = thr;

      b.presence = ema(b.presence, abs, abs > b.presence ? aRise : aFall);
      const rate = Math.min(cfg.time.ceil, Math.max(cfg.time.floor, att));
      b.time += dt * rate;

      return { name: b.name, lo: b.lo, hi: b.hi, abs, level, att, hit, hitPulse: b.hitPulse, presence: b.presence, time: b.time, flux: nflux, threshold: thr };
    };

    const all = feature(this.all);
    const bands = this.bands.map(feature);

    // Tempo from a bass-weighted onset strength function sampled at the hop rate.
    let osf = all.flux;
    for (let i = 0; i < bands.length; i++) if (bands[i].lo < 100) osf += bands[i].flux * 2;
    this.osf[this.osfPos] = osf; this.osfPos = (this.osfPos + 1) % this.osf.length; this.osfCount++;
    if (cfg.tempo.enabled && this.t - this.lastTempoAt >= cfg.tempo.everyMs / 1000 && this.osfCount >= this.osf.length / 2) {
      this.lastTempoAt = this.t; this.estimateTempo();
    }
    const tp = this.tempo; let beat = false;
    if (tp.period > 0) {
      const ph = (((this.t - tp.anchor) / tp.period) % 1 + 1) % 1;
      beat = ph < tp.phase; // wrapped since last hop
      tp.phase = ph;
    }

    return { t: this.t, dt, all, bands, tempo: { bpm: tp.bpm, confidence: tp.confidence, phase: tp.phase, beat }, mags };
  }

  estimateTempo() {
    const tc = this.config.tempo, N = this.osf.length, rate = this.osfRate;
    const n = Math.min(this.osfCount, N);
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { x[i] = this.osf[(this.osfPos - n + i + N) % N]; mean += x[i]; }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy < 1e-9) { this.tempo.confidence = 0; return; }
    const minLag = Math.floor((60 / tc.maxBpm) * rate), maxLag = Math.ceil((60 / tc.minBpm) * rate);
    const ac = new Float32Array(maxLag + 2);
    let acMean = 0, best = -1, bestLag = 0;
    for (let L = minLag; L <= maxLag; L++) {
      let s = 0;
      for (let i = L; i < n; i++) s += x[i] * x[i - L];
      s /= energy;
      const bpm = (60 * rate) / L;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / tc.priorBpm) / tc.priorOctaves, 2));
      ac[L] = s;
      acMean += s;
      const w = s * prior;
      if (w > best) { best = w; bestLag = L; }
    }
    acMean /= (maxLag - minLag + 1);
    if (!bestLag) return;
    // parabolic refinement of the lag
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-9) lag += 0.5 * (a - c) / denom;
    }
    const raw = ac[bestLag];
    const base = Math.max(0, acMean);
    const confidence = Math.min(1, Math.max(0, ((raw - base) / (1 - base + 1e-6)) * 2));
    const bpm = (60 * rate) / lag;
    this.bpmHist.push(bpm); if (this.bpmHist.length > 5) this.bpmHist.shift();
    const sorted = [...this.bpmHist].sort((a, b) => a - b);
    const medBpm = sorted[sorted.length >> 1];
    const period = 60 / medBpm;
    // Beat phase: the offset within one period that lines up with the most onset energy.
    const P = Math.max(1, Math.round(period * rate));
    let bestOff = 0, bestSum = -Infinity;
    for (let off = 0; off < P; off++) {
      let s = 0, c = 0;
      for (let i = n - 1 - off; i >= 0; i -= P) { s += x[i]; c++; }
      if (c && s / c > bestSum) { bestSum = s / c; bestOff = off; }
    }
    this.tempo.bpm = medBpm; this.tempo.confidence = confidence; this.tempo.period = period;
    this.tempo.anchor = this.t - (bestOff / rate);
  }
}

// Synthetic test track for scripted runs (decision 13). Quiet intro → drop → silence.
export function synthTrack({ sampleRate = 48000, bpm = 128, introS = 8, dropS = 14, tailS = 2 } = {}) {
  const total = Math.round((introS + dropS + tailS) * sampleRate);
  const out = new Float32Array(total);
  const beat = 60 / bpm;
  const db = (d) => Math.pow(10, d / 20);
  let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const inDrop = t >= introS && t < introS + dropS;
    const inIntro = t < introS;
    let s = 0;
    // pad / bassline
    if (inIntro) s += db(-30) * Math.sin(2 * Math.PI * 55 * t) + db(-34) * Math.sin(2 * Math.PI * 440 * t);
    if (inDrop) s += db(-14) * (0.7 * Math.sin(2 * Math.PI * 55 * t) + 0.3 * Math.sin(2 * Math.PI * 110 * t));
    // hats on 8ths
    if (inIntro || inDrop) {
      const eighth = t % (beat / 2);
      if (eighth < 0.06) s += db(inDrop ? -12 : -30) * rnd() * 2 * Math.exp(-eighth / 0.015) * (1 - eighth / 0.06);
    }
    if (inDrop) {
      const tb = (t - introS) % beat, beatIdx = Math.floor((t - introS) / beat);
      if (tb < 0.4) {
        const f = 40 + 80 * Math.exp(-tb / 0.03);
        s += db(-6) * Math.sin(2 * Math.PI * f * tb) * Math.exp(-tb / 0.06);
      }
      if (beatIdx % 2 === 1 && tb < 0.15) s += db(-16) * rnd() * 2 * Math.exp(-tb / 0.02);
    }
    out[i] = s;
  }
  const events = [];
  const nBeats = Math.floor(dropS / beat);
  for (let b = 0; b < nBeats; b++) events.push({ t: introS + b * beat, kind: 'kick' });
  return { samples: out, sampleRate, bpm, events, introS, dropS, tailS };
}
