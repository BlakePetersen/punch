// ABOUTME: Offline check for the #6 AudioFrame prototype — runs the analyzer over the synthetic
// ABOUTME: track and prints onset precision/recall per band, ratio behaviour at the drop, tempo lock.
//
// PROTOTYPE. Run: node prototype/audio-frame-check.mjs [bandPreset] [config.json]
// This is the scripted half of decision 13: synthetic signal in, feature stats out. It is not a
// test suite; it is the sanity gate before Blake's ear gets involved.

import { readFileSync } from 'node:fs';
import { AudioFrameAnalyzer, BAND_PRESETS, synthTrack } from './audio-frame.mjs';

const preset = process.argv[2] || 'punch-5';
const patch = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const track = synthTrack({});
const an = new AudioFrameAnalyzer(track.sampleRate, { bands: BAND_PRESETS[preset], ...patch });

const frames = [];
const block = 1024;
for (let i = 0; i < track.samples.length; i += block) frames.push(...an.process(track.samples.subarray(i, i + block)));

const fmt = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d) : String(x)).padStart(7);
const kicks = track.events.map((e) => e.t);
const dropStart = track.introS, dropEnd = track.introS + track.dropS, tailStart = dropEnd;
const beat = 60 / track.bpm;

console.log(`preset=${preset} sr=${track.sampleRate} hop=${an.config.hop} frames=${frames.length} hopRate=${an.osfRate.toFixed(1)}Hz`);
console.log('\nonsets during the drop (kick every beat, hats on 8ths, noise burst on 2 & 4)');
console.log('lanes below 250 Hz should hit kicks (quarter grid); lanes above should hit hats (8th grid)');
console.log('band      expect  hits  onGrid  offGrid  recall  precision  intro-hits');
const lanes = [an.all, ...an.bands];
for (let li = 0; li < lanes.length; li++) {
  const lane = lanes[li];
  const grid = lane.lo < 250 && lane.name !== 'all' ? beat : beat / 2;
  const slots = Math.floor(track.dropS / grid);
  let hits = 0, onGrid = 0, introHits = 0;
  const slotHit = new Set();
  for (const f of frames) {
    const feat = li === 0 ? f.all : f.bands[li - 1];
    if (!feat.hit) continue;
    if (f.t < dropStart) { introHits++; continue; }
    if (f.t >= dropEnd) continue;
    hits++;
    const rel = (f.t - dropStart) % grid;
    if (Math.min(rel, grid - rel) < 0.045) { onGrid++; slotHit.add(Math.round((f.t - dropStart) / grid)); }
  }
  const recall = slotHit.size / slots;
  const precision = hits ? onGrid / hits : 0;
  console.log(`${lane.name.padEnd(9)}${(grid === beat ? 'kick' : 'hat').padEnd(6)}${fmt(hits, 0)}${fmt(onGrid, 0)}${fmt(hits - onGrid, 0)}   ${fmt(recall)}${fmt(precision)}     ${fmt(introHits, 0)}`);
}

console.log('\nlevel ratio (imm/longAvg) for the sub/bass lane around the drop — pumping check');
const lane = 0;
const windows = [[dropStart - 2, dropStart], [dropStart, dropStart + 1], [dropStart + 1, dropStart + 3], [dropStart + 3, dropStart + 6], [dropStart + 6, dropEnd], [tailStart + 0.5, tailStart + 2]];
console.log('window            mean    max    min   att-mean  presence   abs');
for (const [a, b] of windows) {
  const sel = frames.filter((f) => f.t >= a && f.t < b).map((f) => f.bands[lane]);
  if (!sel.length) continue;
  const lv = sel.map((s) => s.level), at = sel.map((s) => s.att);
  const mean = lv.reduce((p, c) => p + c, 0) / lv.length;
  const attMean = at.reduce((p, c) => p + c, 0) / at.length;
  console.log(`${`${a.toFixed(1)}–${b.toFixed(1)}s`.padEnd(16)}${fmt(mean)}${fmt(Math.max(...lv))}${fmt(Math.min(...lv))}${fmt(attMean)}${fmt(sel[sel.length - 1].presence)}${fmt(sel[sel.length - 1].abs)}`);
}

console.log('\ntempo (true 128 bpm from 8.0s)');
console.log('t        bpm   conf   phase-at-kick');
for (const t of [4, 8, 10, 12, 14, 16, 18, 20, 22, 23.5]) {
  const f = frames.find((x) => x.t >= t);
  if (!f) continue;
  const kickT = kicks.find((k) => k >= t) ?? t;
  const fk = frames.find((x) => x.t >= kickT);
  console.log(`${t.toFixed(1).padEnd(8)}${fmt(f.tempo.bpm, 1)}${fmt(f.tempo.confidence)}${fmt(fk ? fk.tempo.phase : NaN)}`);
}

const last = frames[frames.length - 1];
console.log(`\nsilence tail: all.level=${last.all.level.toFixed(3)} all.abs=${last.all.abs.toFixed(3)} sub.level=${last.bands[0].level.toFixed(3)} sub.time-rate≈${(an.config.time.floor).toFixed(2)}x`);
