// Procedural music for Glove Up — our own compositions, synthesized live (see synth.js INSTR).
//
//   Loops     'menu'      upbeat, friendly, 118 BPM, F major, 16 bars (+ a varied second pass)
//             'training'  lighter swung groove, 104 BPM, D major, 16 bars (marimba hook, whistle tune)
//             'results'   warm, laid-back, 92 BPM, Eb major, 8 bars (under the results card after a bout)
//   Stingers  'victory' 'defeat' 'draw' 'between-rounds' 'ko' 'medal-none' 'medal-bronze'
//             'medal-silver' 'medal-gold' 'medal-platinum' 'skill-up' 'skill-down' 'pro'
//             'winner' (the winner faces the camera) 'winner-soft' (… when the local player lost)
//
// A song is data + a small `bar(b, h)` function that returns that bar's notes on a step grid
// (16ths). songBar() turns them into timed events (pure, cached, Node-testable). MusicPlayer
// schedules events with a lookahead scheduler ("two clocks": a JS timer wakes up every ~30 ms and
// schedules everything due in the next ~250 ms on the sample-accurate AudioContext clock), so
// timing never depends on the main thread. Late events are dropped, never played in a burst, and
// a track that fell far behind (stalled thread, resumed context) re-syncs to the bar grid.
// Loops crossfade; a stinger dips the running loop and replaces any stinger still sounding.

import { INSTR, mulberry32, num, clamp } from './synth.js';

/** Scheduler / mixer knobs (seconds unless the name says ms). */
export const MUSIC_TUNING = Object.freeze({
  lookahead: 0.25,     // audio scheduled ahead of the clock (covers ~200 ms main-thread stalls)
  intervalMs: 30,      // scheduler wake-up period
  lateSlack: 0.03,     // events later than this are dropped (never played in a burst)
  startDelay: 0.06,    // play() → first note
  fadeIn: 0.5,         // loop fade-in
  crossfade: 0.9,      // loop → loop
  stopFade: 0.8,       // music(null)
  stingerDuck: 0.25,   // loop level while a stinger plays
  stingerCut: 0.12,    // fade when a newer stinger replaces a sounding one
  level: 1,            // overall music trim
});

// ───────────────────────────── theory + grid helpers (pure) ─────────────────────────────

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITY = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6],
  '5': [0, 7], add9: [0, 4, 7, 14], '9': [0, 4, 7, 10, 14],
};

/**
 * Parse a chord symbol ('F', 'Dm7', 'Bb', 'C7', 'Dmaj7', 'Fsus4', 'C/E').
 * @returns {{symbol:string, root:number, intervals:number[], bass:number, pcs:number[]}} pitch classes 0..11
 */
export function parseChord(sym) {
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(String(sym).trim());
  if (!m) throw new Error(`music: bad chord "${sym}"`);
  const acc = (a) => (a === '#' ? 1 : a === 'b' ? -1 : 0);
  const root = (PC[m[1]] + acc(m[2]) + 12) % 12;
  const intervals = QUALITY[m[3]];
  if (!intervals) throw new Error(`music: unknown chord quality in "${sym}"`);
  const bass = m[4] ? (PC[m[4]] + acc(m[5]) + 12) % 12 : root;
  return { symbol: String(sym), root, intervals: intervals.slice(), bass, pcs: intervals.map((i) => (root + i) % 12) };
}

/** Close voicing: the chord's pitch classes stacked upward from `low`, at most `max` notes ≤ `high`. */
export function voiceChord(chord, { low = 57, high = 74, max = 4 } = {}) {
  const pcs = new Set(chord.pcs);
  const notes = [];
  for (let m = low; m <= high && notes.length < max; m++) if (pcs.has(((m % 12) + 12) % 12)) notes.push(m);
  return notes;
}

/** The chord's bass pitch class placed in [low, low+11]. */
export function bassRoot(chord, low = 36) {
  const pc = chord.bass ?? chord.root;
  return low + ((pc - (low % 12) + 12) % 12);
}

/** Bass line token → MIDI: R root, O octave, 5 fifth, 3 third, 7 seventh (relative to root R). */
export function bassToken(tok, R, chord) {
  switch (tok) {
    case 'O': return R + 12;
    case '5': return R + 7;
    case '3': return R + (chord.intervals.includes(3) && !chord.intervals.includes(4) ? 3 : 4);
    case '7': return R + (chord.intervals.includes(11) ? 11 : 10);
    default: return R;
  }
}

/** 'X' accent 1.0, 'x' 0.78, 'o' 0.42, 'g' ghost 0.22, anything else = rest. One char per step. */
export function parsePattern(str) {
  const out = [];
  const s = String(str).replace(/\s+/g, '');
  for (let i = 0; i < s.length; i++) {
    const vel = { X: 1, x: 0.78, o: 0.42, g: 0.22 }[s[i]];
    if (vel) out.push({ step: i, vel });
  }
  return out;
}

export const stepDur = (def) => 60 / def.bpm / (def.stepsPerBeat || 4);
export const barDuration = (def) => (60 / def.bpm) * (def.beatsPerBar || 4);

/** Seconds from bar start to `step`; odd steps are delayed by `swing` × one step (0 = straight). */
export function stepOffset(step, def) {
  const sd = stepDur(def);
  const sw = def.swing && step % 2 === 1 ? clamp(def.swing, 0, 0.5) * sd : 0;
  return step * sd + sw;
}

// event builders (step units)
const N = (step, inst, midi, len = 1, vel = 0.8, extra) => ({ step, inst, midi, len, vel, ...extra });
const C = (step, inst, notes, len = 1, vel = 0.8, extra) => ({ step, inst, notes, len, vel, ...extra });
const D = (step, inst, vel = 0.8, extra) => ({ step, inst, vel, len: 1, ...extra });
const drums = (inst, pattern, gain = 1, extra) => parsePattern(pattern).map(({ step, vel }) => D(step, inst, vel * gain, extra));
const mod = (a, n) => ((a % n) + n) % n;

const BAR_CACHE = new WeakMap();

/**
 * Timed events of one bar of a song (pure, deterministic, cached).
 * @returns {ReadonlyArray<{t:number, dur:number, inst:string, vel:number, midi?:number, notes?:number[], step:number}>}
 *          t = seconds from the bar start, sorted by t; unknown instruments are dropped
 */
export function songBar(def, bar) {
  const key = def.loop ? mod(bar, def.period || def.bars) : bar;
  let cache = BAR_CACHE.get(def);
  if (!cache) BAR_CACHE.set(def, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;
  const out = [];
  if (def.loop || (bar >= 0 && bar < def.bars)) {
    const b = def.loop ? mod(bar, def.bars) : bar;
    const chords = def.chords || [];
    const chordAt = (i) => (chords.length ? parseChord(chords[mod(i, chords.length)]) : null);
    const h = { b, pass: Math.floor(key / def.bars), chord: chordAt(b), next: chordAt(b + 1), rng: mulberry32((def.seed || 1) * 7919 + key) };
    const sd = stepDur(def);
    for (const e of def.bar(b, h) || []) {
      if (!e || !INSTR[e.inst]) continue;
      out.push({ ...e, t: stepOffset(e.step, def), dur: Math.max(0.02, num(e.len, 1) * sd) });
    }
    out.sort((a, c) => a.t - c.t || (a.inst < c.inst ? -1 : a.inst > c.inst ? 1 : 0));
  }
  Object.freeze(out);
  cache.set(key, out);
  return out;
}

/** Total length of a stinger in seconds (last note end + tail); Infinity for loops. */
export function stingerLength(def) {
  if (def.loop) return Infinity;
  const bd = barDuration(def);
  let end = 0;
  for (let b = 0; b < def.bars; b++) for (const e of songBar(def, b)) end = Math.max(end, b * bd + e.t + e.dur);
  return end + num(def.tail, 1);
}

/** Absolute-time events of a song started at `start`, with from ≤ at < to (pure; tests & tools). */
export function eventsInWindow(def, start, from, to) {
  const bd = barDuration(def);
  const out = [];
  for (let b = Math.max(0, Math.floor((from - start) / bd) - 1); ; b++) {
    const bs = start + b * bd;
    if (bs >= to || (!def.loop && b >= def.bars)) break;
    for (const e of songBar(def, b)) {
      const at = bs + e.t;
      if (at >= from && at < to) out.push({ ...e, at, bar: b });
    }
  }
  return out;
}

// ───────────────────────────── compositions ─────────────────────────────

// 'menu' — bouncy pop: kick/snare/claps, octave-hopping bass, off-beat chord stabs, a square
// lead with a dotted-eighth echo, glockenspiel counter-line in the lift. Second pass: the tune
// moves to a marimba an octave down for the first eight bars.
const MENU_CHORDS = ['F', 'Dm7', 'Bb', 'C', 'F', 'Am7', 'Bb', 'C7', 'Gm7', 'C', 'Am7', 'Dm7', 'Bb', 'C', 'F', 'C7'];
const MENU_LEAD = [ // [step, midi, length(steps)]
  [[0, 69, 2], [2, 72, 2], [4, 77, 4], [8, 76, 2], [10, 77, 2], [12, 79, 4]],
  [[0, 77, 4], [4, 74, 2], [6, 72, 2], [8, 69, 7]],
  [[0, 70, 2], [2, 74, 2], [4, 77, 4], [8, 76, 2], [10, 74, 2], [12, 72, 4]],
  [[0, 74, 2], [2, 72, 2], [4, 70, 2], [6, 69, 2], [8, 67, 7]],
  [[0, 69, 2], [2, 72, 2], [4, 77, 4], [8, 76, 2], [10, 77, 2], [12, 81, 4]],
  [[0, 79, 4], [4, 76, 2], [6, 72, 2], [8, 76, 7]],
  [[0, 74, 2], [2, 70, 2], [4, 74, 2], [6, 77, 2], [8, 76, 4], [12, 74, 4]],
  [[0, 72, 4], [4, 70, 2], [6, 67, 2], [8, 72, 7]],
  [[2, 70, 2], [4, 74, 2], [6, 77, 4], [10, 74, 2], [12, 77, 2], [14, 79, 2]],
  [[0, 76, 6], [6, 72, 2], [8, 76, 2], [10, 79, 6]],
  [[2, 69, 2], [4, 72, 2], [6, 76, 4], [10, 72, 2], [12, 76, 2], [14, 79, 2]],
  [[0, 77, 6], [6, 76, 2], [8, 74, 7]],
  [[0, 77, 4], [4, 74, 2], [6, 70, 2], [8, 74, 2], [10, 77, 2], [12, 74, 4]],
  [[0, 76, 4], [4, 79, 4], [8, 77, 2], [10, 76, 2], [12, 74, 2], [14, 76, 2]],
  [[0, 77, 8], [8, 72, 2], [10, 69, 2], [12, 72, 4]],
  [[12, 64, 2], [14, 67, 2]],
];
const MENU_BASS = [[0, 'R', 3, 0.95], [3, 'R', 1, 0.55], [6, 'O', 2, 0.75], [8, '5', 3, 0.85], [11, 'R', 1, 0.55], [14, 'O', 2, 0.7]];
const MENU_BASS_LIFT = [[0, 'R', 2, 0.95], [2, 'O', 2, 0.7], [4, 'R', 2, 0.85], [6, 'O', 2, 0.7], [8, 'R', 2, 0.9], [10, 'O', 2, 0.7], [12, '5', 2, 0.8], [14, 'O', 2, 0.7]];

const MENU = Object.freeze({
  name: 'menu', bpm: 118, beatsPerBar: 4, stepsPerBeat: 4, swing: 0.08, bars: 16, period: 32, loop: true,
  seed: 118, level: 0.95, echo: { steps: 3, feedback: 0.28, mix: 0.2 }, chords: MENU_CHORDS,
  bar(b, h) {
    const ev = [];
    const lift = b >= 8 && b < 12;
    const phraseEnd = b % 4 === 3;
    // drums
    if (b === 0 || b === 8) ev.push(D(0, 'crash', 0.65));
    ev.push(...drums('kick', lift ? 'X...x...X...x...' : b % 2 ? 'X.....x.X.....x.' : 'X.....x.X.......'));
    ev.push(...drums('snare', b === 15 ? '....X...x.xoX.XX' : b === 7 ? '....X.......XoXo' : '....X.......X...', 0.9));
    if (b >= 4) ev.push(...drums('clap', '....x.......x...', 0.6));
    ev.push(...drums('hat', lift ? 'o.x.o.x.o.x.o.x.' : 'x.o.x.o.x.o.x.o.', 0.9));
    if (lift) ev.push(...drums('ohat', '..o...o...o...o.', 0.7));
    else if (b % 2 === 1 && b !== 7 && b !== 15) ev.push(D(14, 'ohat', 0.45));
    if (lift || b >= 12) for (const s of [3, 7, 11, 15]) if (h.rng() < 0.5) ev.push(D(s, 'hat', 0.22));
    // bass (approach note into the next phrase)
    const R = bassRoot(h.chord, 36);
    for (const [s, k, len, vel] of lift ? MENU_BASS_LIFT : MENU_BASS) {
      if (phraseEnd && s === 14) continue;
      ev.push(N(s, 'bass', bassToken(k, R, h.chord), len, vel));
    }
    if (phraseEnd) ev.push(N(14, 'bass', bassRoot(h.next, 36) - 1, 2, 0.7));
    // chords: off-beat stabs, held pushes in the lift
    const voicing = voiceChord(h.chord, { low: 58, high: 74, max: 4 });
    if (lift) ev.push(C(0, 'stab', voicing, 3, 0.72), C(6, 'stab', voicing, 2, 0.6), C(10, 'stab', voicing, 2, 0.64));
    else for (const s of [2, 6, 10, 14]) ev.push(C(s, 'stab', voicing, 1, s === 6 || s === 14 ? 0.6 : 0.52));
    // tune
    const mallet = h.pass === 1 && b < 8;
    for (const [s, m, len] of MENU_LEAD[b] || []) ev.push(N(s, mallet ? 'marimba' : 'lead', mallet ? m - 12 : m, len, mallet ? 0.85 : 0.8));
    if (lift) {
      const tones = voiceChord(h.chord, { low: 79, high: 93, max: 4 });
      [2, 6, 10, 14].forEach((s, i) => ev.push(N(s, 'glock', tones[i % tones.length], 2, 0.42)));
    }
    return ev;
  },
});

// 'training' — lighter swung groove: rim + shaker + soft kick, funky bass, a two-bar marimba
// hook that follows the chords, an airy whistle tune in the second half.
const TRAIN_CHORDS = ['Em7', 'A7', 'Dmaj7', 'Bm7'];
const TRAIN_BASS = [[0, 'R', 2, 0.9], [3, 'R', 1, 0.45], [4, 'O', 1, 0.65], [6, 'R', 2, 0.8], [10, '5', 1, 0.6], [11, 'O', 1, 0.62], [12, '7', 2, 0.65], [14, '5', 2, 0.55]];
const TRAIN_HOOK = [
  [[0, 0], [3, 2], [6, 1], [8, 3], [10, 2], [13, 1]],
  [[0, 3], [2, 2], [6, 0], [8, 1], [11, 2], [14, 3]],
];
const TRAIN_LEAD = {
  8: [[2, 71, 2], [4, 74, 2], [6, 76, 6]],
  9: [[2, 73, 2], [4, 76, 2], [6, 79, 4], [10, 78, 2], [12, 76, 4]],
  10: [[0, 78, 6], [6, 76, 2], [8, 74, 4], [12, 69, 4]],
  11: [[0, 71, 4], [4, 74, 8]],
  12: [[2, 71, 2], [4, 74, 2], [6, 76, 4], [10, 79, 2], [12, 78, 4]],
  13: [[0, 76, 4], [4, 73, 2], [6, 69, 2], [8, 73, 6]],
  14: [[0, 74, 6], [6, 73, 2], [8, 74, 2], [10, 78, 6]],
  15: [[0, 76, 4], [4, 74, 4], [8, 71, 8]],
};

const TRAINING = Object.freeze({
  name: 'training', bpm: 104, beatsPerBar: 4, stepsPerBeat: 4, swing: 0.14, bars: 16, loop: true,
  seed: 104, level: 0.9, echo: { steps: 3, feedback: 0.25, mix: 0.18 }, chords: TRAIN_CHORDS,
  bar(b, h) {
    const ev = [];
    if (b === 0) ev.push(D(0, 'crash', 0.4));
    ev.push(...drums('kick', b % 4 === 3 ? 'X.....x...x...x.' : 'X.....x...x.....', 0.85));
    ev.push(...drums('rim', '....x.......x...', 0.9));
    ev.push(...drums('shaker', 'gogogogogogogogo'));
    if (b % 4 === 3) ev.push(D(12, 'clap', 0.5));
    if (b % 2 === 1) ev.push(D(14, 'ohat', 0.35));
    const R = bassRoot(h.chord, 33);
    for (const [s, k, len, vel] of TRAIN_BASS) ev.push(N(s, 'bass', bassToken(k, R, h.chord), len, vel * 0.9));
    const tones = voiceChord(h.chord, { low: 62, high: 79, max: 4 });
    for (const [s, i] of TRAIN_HOOK[b % 2]) ev.push(N(s, 'marimba', tones[Math.min(i, tones.length - 1)], 2, 0.7));
    for (const [s, m, len] of TRAIN_LEAD[b] || []) ev.push(N(s, 'whistle', m, len, 0.75));
    if (b >= 8 && b % 2 === 0) ev.push(N(0, 'glock', tones[tones.length - 1] + 12, 4, 0.28));
    return ev;
  },
});

// 'results' — warm and laid-back under the results card: soft kick + rim + shaker, a round bass,
// a soft pad, an eighth-note pluck arpeggio through the chords and a sparse glockenspiel answer.
const RESULTS_CHORDS = ['Ebmaj7', 'Cm7', 'Fm7', 'Bb7', 'Gm7', 'Cm7', 'Abmaj7', 'Bb'];
const RESULTS_ARP = [0, 1, 2, 3, 2, 1, 2, 3]; // chord-tone index per eighth note
const RESULTS_BASS = [[0, 'R', 6, 0.8], [6, '5', 2, 0.5], [8, 'O', 2, 0.6], [10, '5', 2, 0.5], [12, 'R', 4, 0.7]];
const RESULTS_TUNE = {
  1: [[8, 79, 2], [10, 77, 2], [12, 75, 4]],
  3: [[8, 77, 2], [10, 79, 2], [12, 82, 4]],
  5: [[8, 79, 2], [10, 82, 2], [12, 84, 4]],
  7: [[0, 82, 4], [4, 79, 2], [6, 77, 2], [8, 75, 8]],
};

const RESULTS = Object.freeze({
  name: 'results', bpm: 92, beatsPerBar: 4, stepsPerBeat: 4, swing: 0.12, bars: 8, loop: true,
  seed: 92, level: 0.8, echo: { steps: 3, feedback: 0.3, mix: 0.22 }, chords: RESULTS_CHORDS,
  bar(b, h) {
    const ev = [];
    if (b === 0) ev.push(D(0, 'crash', 0.3));
    ev.push(...drums('kick', b % 2 ? 'X.....x...x.....' : 'X.........x.....', 0.7));
    ev.push(...drums('rim', '....x.......x...', 0.75));
    ev.push(...drums('shaker', 'g.o.g.o.g.o.g.o.'));
    const R = bassRoot(h.chord, 36);
    for (const [s, k, len, vel] of RESULTS_BASS) ev.push(N(s, 'bass', bassToken(k, R, h.chord), len, vel));
    ev.push(C(0, 'pad', voiceChord(h.chord, { low: 55, high: 70, max: 4 }), 16, 0.45));
    const tones = voiceChord(h.chord, { low: 67, high: 84, max: 4 });
    RESULTS_ARP.forEach((k, i) => ev.push(N(i * 2, 'pluck', tones[k % tones.length], 2, i % 2 ? 0.4 : 0.48)));
    for (const [s, m, len] of RESULTS_TUNE[b] || []) ev.push(N(s, 'glock', m, len, 0.4));
    return ev;
  },
});

/** Looping songs by name. */
export const SONGS = Object.freeze({ menu: MENU, training: TRAINING, results: RESULTS });

const STING = (def) => Object.freeze({ beatsPerBar: 4, stepsPerBeat: 4, swing: 0, loop: false, tail: 1.2, level: 1, ...def });

/** One-shot jingles by name. */
export const STINGERS = Object.freeze({
  // Bb major brass fanfare: stab, rising call, Eb → Bb landing with a glockenspiel sparkle
  victory: STING({
    bpm: 140, bars: 2, tail: 1.5,
    bar: (b) => (b === 0 ? [
      D(0, 'crash', 0.75), D(0, 'kick', 1), N(0, 'timp', 46, 8, 0.85),
      C(0, 'brass', [58, 62, 65], 2, 0.85),
      N(3, 'brass', 65, 1, 0.75), N(4, 'brass', 70, 2, 0.85), N(6, 'brass', 74, 2, 0.85), N(8, 'brass', 77, 4, 0.95),
      N(12, 'brass', 74, 2, 0.85), N(14, 'brass', 77, 2, 0.9),
      C(8, 'stab', [62, 65, 70], 2, 0.55),
      N(0, 'bass', 34, 6, 0.9), N(8, 'bass', 41, 6, 0.8),
      D(8, 'snare', 0.35), D(10, 'snare', 0.45), D(12, 'snare', 0.55), D(13, 'snare', 0.6), D(14, 'snare', 0.7), D(15, 'snare', 0.8),
    ] : [
      D(0, 'crash', 0.85), D(0, 'kick', 1), N(0, 'timp', 39, 6, 0.85),
      C(0, 'brass', [63, 67, 70], 6, 0.8), N(0, 'brass', 82, 6, 0.95), N(6, 'brass', 81, 2, 0.85),
      C(8, 'brass', [62, 65, 70], 14, 0.85), N(8, 'brass', 82, 14, 1),
      N(0, 'bass', 39, 6, 0.9), N(8, 'bass', 34, 14, 0.95),
      N(8, 'glock', 82, 2, 0.7), N(9, 'glock', 86, 2, 0.7), N(10, 'glock', 89, 2, 0.7), N(11, 'glock', 94, 6, 0.8),
      D(8, 'crash', 1), D(8, 'kick', 1), N(8, 'timp', 46, 8, 1),
    ]),
  }),
  // gentle, encouraging: Cm – Ab – Fm6 – G7 sighing down, then a soft C major ("next time!")
  defeat: STING({
    bpm: 104, bars: 2, tail: 1.4,
    bar: (b) => (b === 0 ? [
      C(0, 'pad', [60, 63, 67], 4, 0.7), N(0, 'bass', 36, 4, 0.5), N(0, 'horn', 67, 4, 0.8), N(0, 'timp', 36, 4, 0.35),
      C(4, 'pad', [56, 60, 63], 4, 0.7), N(4, 'bass', 44, 4, 0.5), N(4, 'horn', 63, 4, 0.8),
      C(8, 'pad', [53, 56, 60, 62], 4, 0.7), N(8, 'bass', 41, 4, 0.5), N(8, 'horn', 62, 4, 0.8),
      C(12, 'pad', [55, 59, 62, 65], 4, 0.7), N(12, 'bass', 43, 4, 0.5), N(12, 'horn', 59, 4, 0.8),
    ] : [
      C(0, 'pad', [60, 64, 67], 10, 0.65), N(0, 'bass', 36, 10, 0.5), N(0, 'horn', 60, 10, 0.75),
      N(2, 'glock', 72, 4, 0.35), N(4, 'glock', 76, 4, 0.35), N(6, 'glock', 79, 6, 0.4),
    ]),
  }),
  draw: STING({
    bpm: 112, bars: 1, tail: 1.3,
    bar: () => [
      C(0, 'brass', [65, 70, 72], 4, 0.6), D(0, 'tom', 0.55, { midi: 50 }), N(0, 'bass', 41, 4, 0.6),
      C(4, 'brass', [65, 69, 72], 10, 0.65), D(4, 'tom', 0.7, { midi: 45 }), D(4, 'crash', 0.35), N(4, 'bass', 41, 10, 0.65),
      N(4, 'glock', 77, 2, 0.4), N(5, 'glock', 81, 2, 0.4), N(6, 'glock', 84, 6, 0.45),
    ],
  }),
  'between-rounds': STING({
    bpm: 132, bars: 2, tail: 1.0,
    bar: (b) => (b === 0 ? [
      D(0, 'kick', 1), C(0, 'stab', [65, 69, 72], 1, 0.9), C(3, 'stab', [65, 69, 72], 1, 0.75),
      C(6, 'stab', [63, 67, 70], 2, 0.85), C(8, 'stab', [65, 69, 72], 1, 0.9),
      N(0, 'bass', 41, 2, 0.9), N(3, 'bass', 41, 1, 0.7), N(6, 'bass', 39, 2, 0.8), N(8, 'bass', 41, 2, 0.9),
      ...drums('hat', 'x.x.x.x.x.......', 0.7), D(4, 'snare', 0.7), D(8, 'kick', 0.9),
      D(10, 'snare', 0.45), D(11, 'snare', 0.5), D(12, 'snare', 0.6), D(13, 'snare', 0.7), D(14, 'snare', 0.8), D(15, 'snare', 0.9),
    ] : [
      D(0, 'crash', 0.75), D(0, 'kick', 1), C(0, 'brass', [65, 69, 72, 77], 6, 0.85), N(0, 'bass', 41, 6, 0.9), N(0, 'timp', 41, 4, 0.6),
    ]),
  }),
  // dramatic and neutral (it plays whoever went down): timpani roll into a power-chord hit
  ko: STING({
    bpm: 100, bars: 1, tail: 1.3,
    bar: () => [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((s) => N(s, 'timp', 36, 1, 0.3 + s * 0.085)),
      D(8, 'crash', 1), D(8, 'kick', 1), N(8, 'timp', 36, 6, 1),
      C(8, 'brass', [48, 55, 60, 67, 72], 8, 1), N(8, 'bass', 36, 8, 1),
    ],
  }),
  'medal-none': STING({ bpm: 150, bars: 1, tail: 0.6, bar: () => [N(0, 'pluck', 67, 2, 0.75), N(2, 'pluck', 72, 4, 0.8)] }),
  'medal-bronze': STING({
    bpm: 150, bars: 1, tail: 0.8,
    bar: () => [N(0, 'pluck', 72, 1, 0.8), N(1, 'pluck', 76, 1, 0.8), N(2, 'pluck', 79, 4, 0.9), C(2, 'stab', [60, 64, 67], 3, 0.6), N(2, 'glock', 84, 4, 0.6)],
  }),
  'medal-silver': STING({
    bpm: 150, bars: 1, tail: 1.0,
    bar: () => [
      N(0, 'pluck', 72, 1, 0.8), N(1, 'pluck', 76, 1, 0.8), N(2, 'pluck', 79, 1, 0.85), N(3, 'pluck', 84, 5, 0.95),
      C(3, 'stab', [60, 64, 67, 72], 4, 0.65), D(3, 'shaker', 0.7), D(3, 'crash', 0.3),
      N(3, 'glock', 84, 2, 0.5), N(5, 'glock', 88, 2, 0.5), N(7, 'glock', 91, 4, 0.55),
    ],
  }),
  'medal-gold': STING({
    bpm: 150, bars: 1, tail: 1.4,
    bar: () => [
      N(0, 'brass', 67, 1, 0.7), N(1, 'brass', 72, 1, 0.75), N(2, 'brass', 76, 1, 0.8), N(3, 'brass', 79, 1, 0.85),
      N(4, 'brass', 84, 8, 0.95), C(4, 'brass', [60, 64, 67], 8, 0.8), D(4, 'crash', 0.7), D(4, 'kick', 0.9), N(4, 'timp', 36, 4, 0.7),
      N(6, 'glock', 84, 2, 0.55), N(7, 'glock', 88, 2, 0.55), N(8, 'glock', 91, 2, 0.55), N(9, 'glock', 96, 6, 0.6),
    ],
  }),
  'medal-platinum': STING({
    bpm: 150, bars: 1, tail: 1.6,
    bar: () => [
      ...[67, 71, 74, 79, 72, 76, 79, 84].map((m, i) => N(i, 'pluck', m, 1, 0.55 + i * 0.03)),
      ...[79, 83, 86, 91, 84, 88, 91, 96].map((m, i) => N(i, 'glock', m, 1, 0.32)),
      C(8, 'brass', [60, 64, 67, 71], 8, 0.85), N(8, 'brass', 88, 8, 1), D(8, 'crash', 0.85), D(8, 'kick', 1), N(8, 'timp', 36, 6, 0.85),
      ...[9, 10, 11, 12, 13, 14, 15].map((s, i) => N(s, 'glock', i % 2 ? 88 : 91, 1, 0.5 - i * 0.05)),
    ],
  }),
  'skill-up': STING({
    bpm: 160, bars: 1, tail: 0.5,
    bar: () => [N(0, 'pluck', 72, 1, 0.6), N(1, 'pluck', 76, 1, 0.62), N(2, 'pluck', 79, 1, 0.65), N(3, 'pluck', 84, 4, 0.7), N(3, 'glock', 84, 4, 0.45)],
  }),
  'skill-down': STING({ bpm: 132, bars: 1, tail: 0.5, bar: () => [N(0, 'horn', 79, 2, 0.6), N(2, 'horn', 76, 2, 0.6), N(4, 'horn', 72, 4, 0.6)] }),
  // the winner turns to the camera (bout outro): a quick Bb pickup into a held brass chord + sparkle
  winner: STING({
    bpm: 132, bars: 1, tail: 1.2,
    bar: () => [
      N(0, 'brass', 65, 1, 0.8), N(1, 'brass', 70, 1, 0.85), N(2, 'brass', 74, 2, 0.9),
      C(4, 'brass', [62, 65, 70, 74], 10, 0.9), N(4, 'brass', 77, 10, 1), D(4, 'crash', 0.8), D(4, 'kick', 1),
      N(4, 'timp', 46, 6, 0.8), N(4, 'bass', 34, 10, 0.9),
      N(6, 'glock', 82, 2, 0.5), N(7, 'glock', 86, 2, 0.5), N(8, 'glock', 89, 4, 0.55),
    ],
  }),
  // … the same moment when the local player lost: warm and respectful, Ab → Eb
  'winner-soft': STING({
    bpm: 112, bars: 1, tail: 1.0,
    bar: () => [
      C(0, 'pad', [56, 60, 63], 8, 0.65), N(0, 'bass', 44, 8, 0.55), N(0, 'horn', 63, 8, 0.72),
      C(8, 'pad', [55, 58, 63], 8, 0.7), N(8, 'bass', 39, 8, 0.55), N(8, 'horn', 67, 8, 0.72),
      N(8, 'glock', 75, 4, 0.3), N(10, 'glock', 79, 6, 0.3),
    ],
  }),
  pro: STING({
    bpm: 140, bars: 1, tail: 1.3,
    bar: () => [
      N(0, 'brass', 67, 1, 0.8), N(1, 'brass', 72, 1, 0.85), N(2, 'brass', 76, 1, 0.9), N(3, 'brass', 79, 5, 1),
      C(3, 'brass', [60, 64, 67], 5, 0.8), D(3, 'crash', 0.8), D(3, 'kick', 1), N(3, 'timp', 36, 4, 0.8),
      N(5, 'glock', 84, 1, 0.55), N(6, 'glock', 88, 1, 0.55), N(7, 'glock', 91, 1, 0.55), N(8, 'glock', 96, 4, 0.6),
      C(10, 'brass', [65, 69, 72], 2, 0.8), C(12, 'brass', [64, 67, 72], 8, 0.9), N(12, 'brass', 84, 8, 1),
      D(12, 'crash', 0.7), N(12, 'timp', 36, 4, 0.8),
    ],
  }),
});

export const isLoop = (name) => Object.prototype.hasOwnProperty.call(SONGS, name);
export const isStinger = (name) => Object.prototype.hasOwnProperty.call(STINGERS, name);
export const MUSIC_NAMES = Object.freeze([...Object.keys(SONGS), ...Object.keys(STINGERS)]);

// ───────────────────────────── scheduler ─────────────────────────────

/**
 * Wakes up every `intervalMs` and asks `pump(now, now + lookahead)` to schedule what is due.
 * `now` is a function returning the audio clock in seconds. Timers are injectable for tests.
 */
export class LookaheadScheduler {
  constructor({ now, pump, lookahead = MUSIC_TUNING.lookahead, intervalMs = MUSIC_TUNING.intervalMs, timers = globalThis } = {}) {
    this.now = now;
    this.pump = pump;
    this.lookahead = lookahead;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this._id = null;
    this._reported = false;
  }

  get running() { return this._id != null; }

  start() {
    if (this._id != null) return;
    this._id = this.timers.setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    if (this._id == null) return;
    this.timers.clearInterval(this._id);
    this._id = null;
  }

  tick() {
    const n = this.now();
    if (!Number.isFinite(n)) return;
    try { this.pump(n, n + this.lookahead); }
    catch (e) { if (!this._reported) { this._reported = true; console.error('[audio] scheduler pump failed', e); } }
  }
}

// ───────────────────────────── player ─────────────────────────────

class Track {
  constructor(player, name, def, start, { dry, wet, fadeIn = 0 }) {
    const ctx = player.ctx;
    this.player = player;
    this.ctx = ctx;
    this.name = name;
    this.def = def;
    this.start = start;
    this.barDur = barDuration(def);
    this.bar = 0;
    this.queue = null;
    this.qi = 0;
    this.level = num(def.level, 1) * player.T.level;
    this.stopAt = Infinity;
    this.endAt = def.loop ? Infinity : start + stingerLength(def);
    this.dead = false;
    this.scheduled = 0;   // events handed to instruments
    this.dropped = 0;     // events skipped because they were already late (diagnostics)
    this.g = ctx.createGain();
    this.w = ctx.createGain();
    const v0 = fadeIn > 0 ? 0 : this.level;
    for (const p of [this.g.gain, this.w.gain]) {
      p.value = v0;
      p.setValueAtTime(v0, start);
      if (fadeIn > 0) p.linearRampToValueAtTime(this.level, start + fadeIn);
    }
    this._fade = { t0: start, v0, t1: start + Math.max(0, fadeIn), v1: this.level };
    this.g.connect(dry);
    if (wet) this.w.connect(wet);
    this.out = { dry: this.g, send: wet ? this.w : null, echo: null };
    this._extra = [];
    if (def.echo) this._makeEcho(def.echo);
  }

  _makeEcho({ steps = 3, feedback = 0.28, mix = 0.2 }) {
    const ctx = this.ctx;
    const inp = ctx.createGain(), d = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter(), wet = ctx.createGain();
    d.delayTime.value = clamp(steps * stepDur(this.def), 0.05, 1.5);
    fb.gain.value = clamp(feedback, 0, 0.7);
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    wet.gain.value = mix;
    inp.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(this.g);
    this.out.echo = inp;
    this._extra.push(inp, d, fb, lp, wet);
  }

  _gainAt(t) {
    const f = this._fade;
    if (t <= f.t0) return f.v0;
    if (t >= f.t1) return f.v1;
    return f.v0 + ((f.v1 - f.v0) * (t - f.t0)) / (f.t1 - f.t0);
  }

  fadeOut(at, dur) {
    if (this.dead || this.stopAt <= at) return;
    const v0 = this._gainAt(at), d = Math.max(0.01, dur);
    for (const p of [this.g.gain, this.w.gain]) {
      p.cancelScheduledValues(at);
      p.setValueAtTime(v0, at);
      p.linearRampToValueAtTime(0, at + d);
    }
    this._fade = { t0: at, v0, t1: at + d, v1: 0 };
    this.stopAt = at + d;
  }

  /** Schedule every event with at < until (dropping ones already late). → events scheduled. */
  pump(now, until) {
    if (this.dead) return 0;
    const T = this.player.T;
    const lim = Math.min(until, this.stopAt, this.endAt);
    let n = 0;
    for (let guard = 0; guard < 4096; guard++) {
      if (!this.queue || this.qi >= this.queue.length) {
        if (!this.def.loop && this.bar >= this.def.bars) break;
        const barStart = this.start + this.bar * this.barDur;
        if (barStart + this.barDur < now - T.lateSlack) { // a whole bar is already in the past: re-sync
          this.bar = Math.max(this.bar + 1, Math.floor((now - this.start) / this.barDur));
          this.queue = null;
          continue;
        }
        if (barStart >= lim) break;
        this.queue = songBar(this.def, this.bar).map((e) => ({ e, at: barStart + e.t }));
        this.qi = 0;
        this.bar++;
        continue;
      }
      const q = this.queue[this.qi];
      if (q.at >= lim) break;
      this.qi++;
      if (q.at < now - T.lateSlack) { this.dropped++; continue; } // late: drop, never burst
      this._play(q.e, q.at);
      n++;
    }
    this.scheduled += n;
    return n;
  }

  _play(e, at) {
    const fn = INSTR[e.inst];
    if (!fn) return;
    try { fn(this.ctx, this.out, at, e, this.player.res); }
    catch (err) { this.player._report(err); }
  }

  isOver(now) {
    return now > this.stopAt + 0.4 || now > this.endAt + 0.3;
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    for (const n of [this.g, this.w, ...this._extra]) { try { n.disconnect(); } catch { /* gone */ } }
  }
}

/**
 * Plays loops (with crossfades) and stingers on one context.
 *   const mp = new MusicPlayer({ ctx, out: {dry, send}, res: getResources(ctx) });
 *   mp.play('menu'); mp.play('training'); mp.stinger('victory'); mp.stop(); — and call
 *   mp.pump(now, now + lookahead) from a LookaheadScheduler.
 */
export class MusicPlayer {
  constructor({ ctx, out, res, tuning } = {}) {
    this.ctx = ctx;
    this.res = res;
    this.T = { ...MUSIC_TUNING, ...(tuning || {}) };
    this.out = out;
    this.loopDry = ctx.createGain();
    this.loopWet = ctx.createGain();
    this.loopDry.connect(out.dry);
    if (out.send) this.loopWet.connect(out.send);
    this.tracks = [];
    this.loop = null;
    this._reported = false;
  }

  /** Name of the loop currently playing (not fading out), or null. */
  get current() { return this.loop ? this.loop.name : null; }

  /** Live tracks (loops + stingers, including ones fading out). */
  get active() { return this.tracks.filter((t) => !t.dead).length; }

  /** Diagnostics for the live tracks: [{name, scheduled, dropped, loop}]. */
  stats() {
    return this.tracks.filter((t) => !t.dead).map((t) => ({ name: t.name, scheduled: t.scheduled, dropped: t.dropped, loop: !!t.def.loop }));
  }

  /**
   * Play a loop (crossfading from the current one) or a stinger; null stops the loop.
   * @returns {boolean} false for an unknown name
   */
  play(name, { fadeIn, when } = {}) {
    if (name == null) { this.stop(); return true; }
    if (isStinger(name)) return !!this.stinger(name, { when });
    if (!isLoop(name)) return false;
    if (this.loop && this.loop.name === name) return true;
    const now = this.ctx.currentTime;
    const start = Math.max(now + this.T.startDelay, num(when, 0));
    if (this.loop) this.loop.fadeOut(now, this.T.crossfade);
    const tr = new Track(this, name, SONGS[name], start, { dry: this.loopDry, wet: this.loopWet, fadeIn: num(fadeIn, this.T.fadeIn) });
    this.loop = tr;
    this.tracks.push(tr);
    tr.pump(now, now + this.T.lookahead);
    return true;
  }

  /** Fade the current loop out. */
  stop({ fadeOut } = {}) {
    if (!this.loop) return;
    this.loop.fadeOut(this.ctx.currentTime, num(fadeOut, this.T.stopFade));
    this.loop = null;
  }

  /**
   * Play a one-shot jingle at `when` (default: now). A newer stinger cuts any that is still
   * sounding; the loop is dipped while it plays.
   * @returns {null|{name:string, start:number, end:number, cancel:() => void}}
   */
  stinger(name, { when } = {}) {
    if (!isStinger(name)) return null;
    const now = this.ctx.currentTime;
    const start = Math.max(now + this.T.startDelay, num(when, 0));
    for (const tr of this.tracks) {
      if (!tr.dead && !tr.def.loop && tr.endAt > start) tr.fadeOut(Math.max(now, start - this.T.stingerCut), this.T.stingerCut);
    }
    const tr = new Track(this, name, STINGERS[name], start, { dry: this.out.dry, wet: this.out.send, fadeIn: 0 });
    this.tracks.push(tr);
    this._duck(start, tr.endAt);
    tr.pump(now, now + this.T.lookahead);
    return {
      name, start, end: tr.endAt,
      cancel: () => { const t = this.ctx.currentTime; if (start > t) tr.kill(); else tr.fadeOut(t, 0.06); },
    };
  }

  _duck(start, end) {
    let until = end;
    for (const tr of this.tracks) if (!tr.dead && !tr.def.loop && tr.stopAt === Infinity) until = Math.max(until, tr.endAt);
    for (const p of [this.loopDry.gain, this.loopWet.gain]) {
      p.cancelScheduledValues(start);
      p.setTargetAtTime(this.T.stingerDuck, start, 0.06);
      p.setTargetAtTime(1, until, 0.35);
    }
  }

  /** Schedule everything due before `until`; retire finished tracks. */
  pump(now, until) {
    let n = 0;
    for (const tr of this.tracks) n += tr.pump(now, until);
    if (this.tracks.some((tr) => tr.isOver(now))) {
      for (const tr of this.tracks) if (tr.isOver(now)) tr.kill();
      this.tracks = this.tracks.filter((tr) => !tr.dead);
      if (this.loop && this.loop.dead) this.loop = null;
    }
    return n;
  }

  _report(err) {
    if (this._reported) return;
    this._reported = true;
    console.error('[audio] music instrument failed', err);
  }

  dispose() {
    for (const tr of this.tracks) tr.kill();
    this.tracks = [];
    this.loop = null;
    for (const n of [this.loopDry, this.loopWet]) { try { n.disconnect(); } catch { /* gone */ } }
  }
}
