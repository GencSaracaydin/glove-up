// Audio lab: buttons for every sound, music and crowd reaction, volume sliders, a live output
// meter, a simulated bout through the real EventBus wiring, and an offline report that renders
// each sound through the full master chain (OfflineAudioContext) and measures peak / RMS so
// nothing clips or is silent.
//
//   /dev/audio.html             interactive
//   /dev/audio.html?report=1    also run the offline report on load → window.__audioReport(Ready)
//   /dev/audio.html?smoke=1     press every sound button once (realtime) → window.__audioSmoke(Ready)

import { EventBus } from '../src/core/events.js';
import { Ev } from '../src/core/types.js';
import { AudioEngine, renderOffline, CROWD_REACTIONS } from '../src/audio/audio.js';
import { measure, SFX_NAMES } from '../src/audio/synth.js';
import { STINGERS, stingerLength } from '../src/audio/music.js';

const params = new URLSearchParams(location.search);
const bus = new EventBus();
const audio = new AudioEngine({ bus });
window.__audio = audio;
window.__bus = bus;

// ───────────────────────────── tiny DOM helpers ─────────────────────────────

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

const lab = document.getElementById('lab');
const allButtons = [];

function card(title, color, ...kids) {
  const c = h('section', { class: 'card' }, h('h2', {}, h('span', { class: 'chip', style: `background:${color}` }), title), ...kids);
  lab.append(c);
  return c;
}

/** A sound button: unlocks audio (it is a user gesture) and runs `fn`. */
function btn(label, fn, tint = '', { smoke = true } = {}) {
  const b = h('button', { class: tint, type: 'button' }, label);
  b.addEventListener('click', async () => {
    await audio.unlock();
    try { fn(); } catch (e) { console.error(`[lab] ${label}`, e); }
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 120);
  });
  if (smoke) allButtons.push({ label, fn });
  return b;
}

const row = (...kids) => h('div', { class: 'btns' }, ...kids);
const sub = (t) => h('h3', {}, t);

// ───────────────────────────── header / status ─────────────────────────────

const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
document.getElementById('unlock').addEventListener('click', async () => {
  const ok = await audio.unlock();
  if (ok) startMeter();
});

// ───────────────────────────── mixer ─────────────────────────────

const vol = { ...audio.getVolume() };
const mixer = h('div', { class: 'mixer' });
for (const [key, label] of [['master', 'Master'], ['sfx', 'Effects'], ['music', 'Music'], ['voice', 'Voice']]) {
  const out = h('output', {}, `${Math.round(vol[key] * 100)}`);
  const input = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: vol[key], 'aria-label': `${label} volume` });
  input.addEventListener('input', () => {
    vol[key] = Number(input.value);
    out.textContent = `${Math.round(vol[key] * 100)}`;
    audio.setVolume({ [key]: vol[key] });
  });
  mixer.append(h('span', {}, label), input, out);
}
const muteBox = h('input', { type: 'checkbox' });
muteBox.addEventListener('change', () => audio.setMuted(muteBox.checked));
const meter = h('canvas', { id: 'meter', width: 720, height: 172 });
const stateBox = h('div', { class: 'state' });
card('Mixer', 'var(--accent)',
  h('p', { class: 'note' }, 'Same sliders as Settings → Sound (the crowd follows Effects).'),
  mixer,
  h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { class: 'check' }, muteBox, 'Mute all'),
    btn('Test sound (bell)', () => audio.playSfx('bell'), 't-bell', { smoke: false })),
  meter, stateBox);

// ───────────────────────────── fight ─────────────────────────────

const P = (o) => ({ attacker: 'p1', defender: 'p2', hand: 'left', kind: 'straight', target: 'head', power: 0.6, ...o });
card('Fight', 'var(--p2)',
  h('p', { class: 'note' }, 'Hits, guards and misses must be told apart by ear (UI03).'),
  sub('Landed punches'),
  row(
    btn('Jab (head)', () => audio.playSfx('hit', { power: 0.45, pan: -0.24 }), 't-fight'),
    btn('Cross (head)', () => audio.playSfx('hit', { power: 0.7, pan: 0.24 }), 't-fight'),
    btn('Body shot', () => audio.playSfx('hit', { power: 0.65, target: 'body' }), 't-fight'),
    btn('Power hook', () => audio.playSfx('hit', { power: 1, pan: 0.38, kind: 'hook' }), 't-fight'),
    btn('Counter!', () => audio.playSfx('hit', { power: 0.8, counter: true }), 't-fight'),
    btn('Hit taken', () => audio.playSfx('hit', { power: 0.7, perspective: 'taken', pan: -0.24 }), 't-fight'),
    btn('Heavy hit taken', () => audio.playSfx('hit', { power: 0.9, perspective: 'taken', heavy: true, pan: 0.2 }), 't-fight'),
    btn('Knockdown blow', () => audio.playSfx('hit', { power: 1, knockdown: true }), 't-fight'),
  ),
  sub('Defence & misses'),
  row(
    btn('Blocked', () => audio.playSfx('block', { power: 0.6 }), 't-fight'),
    btn('Dodged', () => audio.playSfx('dodge', { pan: 0.2, dir: -1 }), 't-fight'),
    btn('Missed', () => audio.playSfx('whoosh', { pan: -0.2 }), 't-fight'),
    btn('My punch swish', () => audio.playSfx('swish', { pan: 0.15 }), 't-fight'),
    btn('Counter ready', () => audio.playSfx('counter-ready'), 't-fight'),
  ),
  sub('Tells, daze, the canvas'),
  row(
    btn('Wind-up grunt', () => audio.playSfx('grunt', { pan: 0.3 }), 't-fight'),
    btn('Glove glint', () => audio.playSfx('glint', { pan: -0.3 }), 't-fight'),
    btn('Dazed', () => audio.playSfx('dazed'), 't-fight'),
    btn('Body hits canvas', () => audio.playSfx('thud'), 't-fight'),
    btn('KO boom', () => audio.playSfx('ko-boom'), 't-fight'),
    btn('Get up', () => audio.playSfx('getup'), 't-fight'),
  ));

// ───────────────────────────── bell & announcer ─────────────────────────────

const sayInput = h('input', { type: 'text', value: 'Round one!', 'aria-label': 'Text for the announcer' });
const call = (c, extra) => () => bus.emit(Ev.MATCH_CALL, { call: c, ...extra });
card('Bell & announcer', 'var(--warn)',
  h('p', { class: 'note' }, 'Announcer calls arrive as Ev.MATCH_CALL; each moment sounds once, whichever event announces it first.'),
  sub('Calls (through the bus)'),
  row(
    btn('Round 2 · tone + call', call('round', { round: 2 }), 't-bell'),
    btn('Final round', call('final-round', { round: 3 }), 't-bell'),
    btn('"Fight!" + bell', call('fight'), 't-bell'),
    btn('"Down!"', call('down', { boxer: 'p2' }), 't-bell'),
    btn('KO · slam + call', call('ko', { winner: 'p1' }), 't-bell'),
    btn('Time · 0:00 bell', call('time', { round: 1 }), 't-bell'),
    btn('Decision', call('decision'), 't-bell'),
  ),
  sub('Ring bell'),
  row(
    btn('Start · 2 rings', () => bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 }), 't-bell'),
    btn('End · 3 rings', () => bus.emit(Ev.MATCH_BELL, { kind: 'end', round: 1 }), 't-bell'),
    btn('Final · 5 rings', () => audio.playSfx('bell', { rings: 5, spacing: 0.2 }), 't-bell'),
  ),
  sub('Count (through the bus: voice + tick; the roar follows "Ten")'),
  row(...Array.from({ length: 10 }, (_, i) => btn(String(i + 1), () => bus.emit(Ev.MATCH_COUNT, { downed: 'p2', n: i + 1 }), 't-bell'))),
  sub('Sounds under the calls'),
  row(
    btn('Round tone', () => audio.playSfx('round-tone'), 't-bell'),
    btn('Final-round tone', () => audio.playSfx('round-tone', { final: true }), 't-bell'),
    btn('KO slam', () => audio.playSfx('ko-slam'), 't-bell'),
  ),
  h('div', { class: 'row', style: 'margin-top:8px' }, sayInput, btn('Say it', () => audio.say(sayInput.value), 't-bell', { smoke: false })),
  sub('Decision'),
  row(
    btn('Drum roll', () => bus.emit(Ev.MATCH_DECISION, { scorecards: [] }), 't-bell'),
    btn('Reveal → win', () => bus.emit(Ev.MATCH_RESULT, { id: `lab-${Date.now()}`, winner: 'p1', method: 'decision', mode: 'single', names: { p1: 'Sunny' } }), 't-bell'),
  ));

// ───────────────────────────── slow motion, camera cut, outro ─────────────────────────────

const OUTRO = [[0, 'start'], [150, 'wipe'], [950, 'flash'], [1150, 'replay'], [7200, 'flash'], [7700, 'banner'], [11700, 'winner'], [15200, 'end']];
let outroTimers = [];
function playOutro(winner = 'p1') {
  outroTimers.forEach(clearTimeout);
  outroTimers = OUTRO.map(([ms, stage]) => setTimeout(() => bus.emit(Ev.RENDER_OUTRO, { stage, winner, method: 'KO' }), ms));
}
card('Slow motion, cut & outro', 'var(--pink)',
  h('p', { class: 'note' }, 'Dodge slow motion (Ev.MATCH_SLOWMO), the player-hit camera cut (Ev.RENDER_CUT) and the bout outro stages (Ev.RENDER_OUTRO).'),
  sub('Through the bus'),
  row(
    btn('Dodge slow-mo', () => { audio.startCrowd(); bus.emit(Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 }); }, 't-bus'),
    btn('Cut: hit', () => bus.emit(Ev.RENDER_CUT, { kind: 'player-hit', viewer: 'p1', durationMs: 350 }), 't-bus'),
    btn('Cut: heavy hit', () => bus.emit(Ev.RENDER_CUT, { kind: 'player-hit-heavy', viewer: 'p1', durationMs: 650 }), 't-bus'),
  ),
  sub('Outro stages'),
  row(...['wipe', 'replay', 'flash', 'banner', 'winner', 'end'].map((stage) => btn(stage, () => bus.emit(Ev.RENDER_OUTRO, { stage, winner: 'p1', method: 'KO' }), 't-bus'))),
  row(
    btn('Full KO outro · I win', () => { audio.startCrowd(); playOutro('p1'); }, 't-bus', { smoke: false }),
    btn('… I lose', () => { audio.startCrowd(); playOutro('p2'); }, 't-bus', { smoke: false }),
  ),
  sub('The sounds themselves'),
  row(
    btn('Time slows', () => audio.playSfx('time-slow'), 't-fight'),
    btn('Time resumes', () => audio.playSfx('time-resume'), 't-fight'),
    btn('Cut thud', () => audio.playSfx('cut-thud'), 't-fight'),
    btn('Cut thud (heavy)', () => audio.playSfx('cut-thud', { heavy: true }), 't-fight'),
    btn('Logo wipe', () => audio.playSfx('outro-wipe'), 't-fight'),
    btn('Flash sting', () => audio.playSfx('flash-sting'), 't-fight'),
  ));

// ───────────────────────────── crowd ─────────────────────────────

const exciteOut = h('output', {}, 'auto');
const excite = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.3, 'aria-label': 'Crowd excitement' });
const autoBox = h('input', { type: 'checkbox', checked: true });
const applyExcite = () => {
  audio.setExcitement(autoBox.checked ? null : Number(excite.value));
  exciteOut.textContent = autoBox.checked ? 'auto' : Number(excite.value).toFixed(2);
};
excite.addEventListener('input', () => { autoBox.checked = false; applyExcite(); });
autoBox.addEventListener('change', applyExcite);
card('Crowd', 'var(--good)',
  h('p', { class: 'note' }, 'A murmur that swells with the bout; reactions on top.'),
  row(
    btn('Start crowd', () => audio.startCrowd(), 't-crowd', { smoke: false }),
    btn('Stop crowd', () => audio.stopCrowd(), 't-crowd', { smoke: false }),
  ),
  h('div', { class: 'mixer', style: 'margin-top:10px' }, h('span', {}, 'Excite'), excite, exciteOut),
  h('label', { class: 'check' }, autoBox, 'Follow the match (auto)'),
  sub('Reactions'),
  row(...CROWD_REACTIONS.map((k) => btn(k, () => audio.crowdReact(k), 't-crowd'))));

// ───────────────────────────── music ─────────────────────────────

card('Music', 'var(--peri)',
  h('p', { class: 'note' }, 'Original procedural loops (crossfade between them) and one-shot jingles.'),
  sub('Loops'),
  row(
    btn('Menu · 118 BPM', () => audio.music('menu'), 't-music', { smoke: false }),
    btn('Training groove', () => audio.music('training'), 't-music', { smoke: false }),
    btn('Results · 92 BPM', () => audio.music('results'), 't-music', { smoke: false }),
    btn('Stop', () => audio.music(null), 't-music', { smoke: false }),
  ),
  sub('Jingles'),
  row(...Object.keys(STINGERS).map((n) => btn(n, () => audio.playSfx(n), 't-music'))));

// ───────────────────────────── training ─────────────────────────────

const TRAIN = [
  ['Bag thump', 'bag-thump'], ['Chain snap', 'chain-snap'], ['Bag falls', 'bag-fall'], ['New bag', 'chain-rattle'],
  ['Ball throw', 'ball-throw'], ['Ball hits you', 'ball-hit'], ['Dodge swish', 'dodge-swish'], ['Mitt smack', 'mitt-smack'],
  ['Mitts up', 'mitt-up'], ['Trainer "oof"', 'trainer-oof'], ['Score +', 'score-up'], ['Score −', 'score-down'], ['Combo', 'combo'],
];
card('Training', 'var(--lime)',
  row(...TRAIN.map(([label, name]) => btn(label, () => audio.playSfx(name), 't-train'))),
  sub('Whistle'),
  row(
    btn('Start', () => audio.playSfx('whistle', { pattern: 'start' }), 't-train'),
    btn('End', () => audio.playSfx('whistle', { pattern: 'end' }), 't-train'),
    btn('Short', () => audio.playSfx('whistle', { pattern: 'short' }), 't-train'),
  ),
  sub('Through the bus (TRAIN_EVENT types)'),
  row(...['go', 'bag-new', 'bag-hit', 'bag-miss', 'bag-break', 'ball-throw', 'ball-dodge', 'ball-hit', 'target-up', 'mitt-hit', 'mitt-absorb', 'glove-miss', 'trainer-hit', 'time-up']
    .map((type) => btn(type, () => bus.emit(Ev.TRAIN_EVENT, { kind: 'lab', type, power: 0.7, side: 'right', arriveInMs: 900, pos: [0.4, 1.4, -1.5] }), 't-train'))));

// ───────────────────────────── ui ─────────────────────────────

card('Menus', 'var(--purple)',
  row(...['ui-hover', 'ui-move', 'ui-dwell-tick', 'ui-confirm', 'ui-back', 'ui-deny', 'ui-ready', 'ui-alert', 'ui-pause', 'ui-resume']
    .map((n) => btn(n.replace('ui-', ''), () => audio.playSfx(n, { progress: 0.6 }), 't-ui'))));

// ───────────────────────────── simulated bout ─────────────────────────────

const A = (o) => P(o);
const TAKEN = (o) => ({ attacker: 'p2', defender: 'p1', hand: 'left', kind: 'straight', target: 'head', power: 0.7, ...o });
const CUT = (heavy) => ({ kind: heavy ? 'player-hit-heavy' : 'player-hit', viewer: 'p1', durationMs: heavy ? 650 : 350 });
// One bout as the alignment-pass match emits it (research/mechanics.md §1.2, §3.1, §6): the round
// banner ≈4 s before "Fight!", a block, a heavy counter on the player with the camera cut, a dodge
// into slow motion and a counter, a knockdown with "Down" and a count at 1.08 s, the restart, then
// a knockdown counted out, the "KO" call ≈1.3 s after "Ten", the result and the KO outro.
const TEN = 30440 + 9 * 1080;
const DEMO = [
  [0, Ev.APP_SCREEN, { screen: null }],
  [100, Ev.MATCH_INTRO, { p1Name: 'Sunny', p2Name: 'Rocco', mode: 'single' }],
  [1200, Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 }],
  [1400, Ev.MATCH_CALL, { call: 'round', round: 1 }],
  [5350, Ev.MATCH_CALL, { call: 'fight', round: 1 }], [5350, Ev.MATCH_BELL, { kind: 'start', round: 1 }],
  [6500, Ev.MATCH_PUNCH_THROWN, A({})], [6620, Ev.MATCH_HIT, A({ power: 0.5, hpBefore: 10, hpAfter: 8.8 })],
  [7300, Ev.MATCH_PUNCH_THROWN, A({ hand: 'right' })], [7420, Ev.MATCH_BLOCK, A({ hand: 'right', chip: 0 })],
  [7850, Ev.MATCH_HIT, TAKEN({ hand: 'right', kind: 'hook', power: 0.85, counter: true, heavy: true, hpBefore: 10, hpAfter: 6.8 })],
  [7880, Ev.RENDER_CUT, CUT(true)],
  [9400, Ev.MATCH_WINDUP, { attacker: 'p2', hand: 'right', kind: 'hook', target: 'head', windupMs: 560, tell: { grunt: true, glint: true } }],
  [9960, Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'hook', counterWindowMs: 750 }],
  [9960, Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 }],
  [10200, Ev.MATCH_PUNCH_THROWN, A({ hand: 'right' })], [10320, Ev.MATCH_HIT, A({ hand: 'right', power: 0.85, counter: true, heavy: true, hpBefore: 8.8, hpAfter: 5.6 })],
  [11400, Ev.MATCH_WINDUP, { attacker: 'p2', hand: 'left', kind: 'straight', target: 'body', windupMs: 300, tell: { grunt: true, glint: false } }],
  [11700, Ev.MATCH_HIT, TAKEN({ target: 'body', hpBefore: 6.8, hpAfter: 5.7 })], [11730, Ev.RENDER_CUT, CUT(false)],
  [12500, Ev.MATCH_PUNCH_THROWN, A({})], [12620, Ev.MATCH_MISS, A({})],
  [13300, Ev.MATCH_PUNCH_THROWN, A({ hand: 'right', kind: 'hook' })], [13420, Ev.MATCH_HIT, A({ hand: 'right', kind: 'hook', power: 1, hpBefore: 5.6, hpAfter: 0.3 })],
  [14600, Ev.MATCH_PUNCH_THROWN, A({ kind: 'uppercut' })], [14720, Ev.MATCH_HIT, A({ kind: 'uppercut', power: 0.9, knockdown: true, hpBefore: 0.3, hpAfter: 0 })],
  [14720, Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1, roundCount: 1, by: 'p1', round: 1 }],
  [15620, Ev.MATCH_CALL, { call: 'down', boxer: 'p2' }],
  ...[1, 2, 3, 4, 5].map((n) => [16920 + (n - 1) * 1080, Ev.MATCH_COUNT, { downed: 'p2', n }]),
  [21660, Ev.MATCH_GETUP, { downed: 'p2', atCount: 5 }],
  [26260, Ev.MATCH_CALL, { call: 'fight', round: 1 }],
  [27500, Ev.MATCH_PUNCH_THROWN, A({ hand: 'right' })], [27620, Ev.MATCH_HIT, A({ hand: 'right', power: 0.9, hpBefore: 8, hpAfter: 6.7 })],
  [28100, Ev.MATCH_PUNCH_THROWN, A({ kind: 'hook' })], [28220, Ev.MATCH_HIT, A({ kind: 'hook', power: 1, counter: true, heavy: true, knockdown: true, hpBefore: 6.7, hpAfter: 0 })],
  [28220, Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 2, roundCount: 2, by: 'p1', round: 1 }],
  [29140, Ev.MATCH_CALL, { call: 'down', boxer: 'p2' }],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [30440 + (n - 1) * 1080, Ev.MATCH_COUNT, { downed: 'p2', n }]),
  [TEN, Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' }],
  [TEN, Ev.MATCH_BELL, { kind: 'final' }],
  [TEN + 1300, Ev.MATCH_CALL, { call: 'ko', winner: 'p1' }],
  [TEN + 3000, Ev.MATCH_RESULT, { id: 'lab-demo', winner: 'p1', method: 'KO', mode: 'single', endRound: 1 }],
  ...OUTRO.map(([ms, stage]) => [TEN + 3400 + ms, Ev.RENDER_OUTRO, { stage, winner: 'p1', method: 'KO' }]),
];
let demoTimers = [];
function playDemo() {
  stopDemo();
  for (const [ms, ev, payload] of DEMO) demoTimers.push(setTimeout(() => bus.emit(ev, payload), ms));
}
function stopDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; }
card('Simulated bout', 'var(--orange)',
  h('p', { class: 'note' }, 'Plays a scripted one-minute bout through the EventBus, as the match and renderer emit it: the round call and banner tone, "Fight!" and the bell, a block, a heavy hit on you with the camera cut, a dodge into slow motion and a counter, "Down" and the count, the restart, a ten-count KO with the "KO" call, then the outro and results music.'),
  row(
    btn('Play demo bout', playDemo, 't-bus', { smoke: false }),
    btn('Stop', () => { stopDemo(); bus.emit(Ev.APP_SCREEN, { screen: 'mode' }); }, 't-bus', { smoke: false }),
    btn('Pause', () => bus.emit(Ev.APP_PAUSE, { reason: 'user' }), 't-bus', { smoke: false }),
    btn('Resume', () => bus.emit(Ev.APP_RESUME, {}), 't-bus', { smoke: false }),
    btn('Back to menu', () => bus.emit(Ev.APP_SCREEN, { screen: 'mode' }), 't-bus', { smoke: false }),
  ),
  sub('Recent cues'),
  h('div', { class: 'log', id: 'log' }));

// ───────────────────────────── offline report ─────────────────────────────

const SECONDS = {
  bell: 3.2, whistle: 1.8, 'ko-boom': 2.8, thud: 1.2, dazed: 1.2, 'chain-snap': 1.0, 'chain-rattle': 1.1, reveal: 2.4, 'bag-fall': 1,
  'round-tone': 2.2, 'ko-slam': 2.8, 'time-slow': 1, 'flash-sting': 1.8, 'outro-wipe': 1.2, 'cut-thud': 0.8,
};
const LOUD = { master: 1, sfx: 1, music: 1, voice: 1 };

function reportItems() {
  const items = SFX_NAMES.map((n) => ({ group: 'Effects', label: n, secs: SECONDS[n] ?? 1, run: (e) => e.playSfx(n, n === 'bell' ? { rings: 5, spacing: 0.2 } : n === 'whistle' ? { pattern: 'end' } : {}) }));
  items.push(
    { group: 'Effects', label: 'hit · counter, full power', secs: 1, run: (e) => e.playSfx('hit', { counter: true, power: 1 }) },
    { group: 'Effects', label: 'hit · taken, knockdown', secs: 1, run: (e) => e.playSfx('hit', { perspective: 'taken', knockdown: true, power: 1 }) },
    { group: 'Effects', label: 'hit · body, light', secs: 1, run: (e) => e.playSfx('hit', { target: 'body', power: 0.2 }) },
    { group: 'Effects', label: 'hit · heavy, taken', secs: 1.2, run: (e) => e.playSfx('hit', { perspective: 'taken', heavy: true, power: 1 }) },
    { group: 'Effects', label: 'round-tone · final round', secs: 2.2, run: (e) => e.playSfx('round-tone', { final: true }) },
    { group: 'Effects', label: 'time-slow · deep (replay)', secs: 1.6, run: (e) => e.playSfx('time-slow', { deep: true, dur: 1.2 }) },
    { group: 'Effects', label: 'cut-thud · heavy', secs: 0.9, run: (e) => e.playSfx('cut-thud', { heavy: true }) },
    { group: 'Effects', label: 'replay ambience (drone, 6 s)', secs: 6, run: (e) => e.handle(Ev.RENDER_OUTRO, { stage: 'replay', winner: 'p1' }) },
    { group: 'Effects', label: 'decision drum roll', secs: 4.6, run: (e) => e.handle(Ev.MATCH_DECISION, {}) },
  );
  for (const k of CROWD_REACTIONS) items.push({ group: 'Crowd', label: `react · ${k}`, secs: 5, run: (e) => e.crowdReact(k) });
  for (const x of [0.25, 0.6, 1]) items.push({ group: 'Crowd', label: `bed · excitement ${x}`, secs: 4, run: (e) => { e.setExcitement(x); e.startCrowd(); } });
  items.push({ group: 'Music', label: 'loop · menu (10 s)', secs: 10, run: (e) => e.music('menu') });
  items.push({ group: 'Music', label: 'loop · training (10 s)', secs: 10, run: (e) => e.music('training') });
  items.push({ group: 'Music', label: 'loop · results (10 s)', secs: 10, run: (e) => e.music('results') });
  for (const n of Object.keys(STINGERS)) items.push({ group: 'Music', label: `jingle · ${n}`, secs: stingerLength(STINGERS[n]) + 0.2, run: (e) => e.playSfx(n) });
  items.push({
    group: 'Stress', label: 'KO moment: everything at once', secs: 7,
    run: (e) => {
      e.setExcitement(1); e.startCrowd();
      e.playSfx('hit', { counter: true, knockdown: true, power: 1 });
      e.playSfx('hit', { perspective: 'taken', power: 1, delay: 0.02 });
      e.playSfx('ko-boom'); e.crowdReact('roar'); e.crowdReact('gasp');
      e.playSfx('bell', { rings: 5, spacing: 0.2 });
      e.playSfx('ko', { delay: 0.3 }); e.playSfx('whistle', { pattern: 'end' }); e.music('menu');
    },
  });
  items.push({
    group: 'Stress', label: 'KO call: slam + "KO" stinger + roar', secs: 4,
    run: (e) => {
      e.setExcitement(1); e.startCrowd();
      e.playSfx('ko-slam'); e.playSfx('ko', { delay: 0.1 }); e.crowdReact('roar', { delay: 0.5 });
      e.playSfx('bell', { rings: 5, spacing: 0.2 });
    },
  });
  items.push({
    group: 'Stress', label: 'outro: wipe, flash, fanfare + roar', secs: 6,
    run: (e) => {
      e.setExcitement(0.9); e.startCrowd();
      e.playSfx('outro-wipe'); e.playSfx('flash-sting', { delay: 0.6 });
      e.playSfx('victory', { delay: 0.8 }); e.crowdReact('roar', { delay: 0.9 }); e.playSfx('winner', { delay: 3.6 });
    },
  });
  items.push({
    group: 'Stress', label: 'punch flurry (24 hits in 3 s)', secs: 4,
    run: (e) => { for (let i = 0; i < 24; i++) e.playSfx('hit', { power: 0.5 + (i % 5) / 10, counter: i % 6 === 0, target: i % 3 ? 'head' : 'body', delay: i * 0.125 }); },
  });
  return items;
}

const db = (x) => (Number.isFinite(x) ? x.toFixed(1) : '−∞');

async function runReport(progressEl) {
  const items = reportItems();
  const rows = [];
  const t0 = performance.now();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    progressEl.textContent = `Rendering ${i + 1}/${items.length}: ${it.label}…`;
    const { buffer } = await renderOffline(async (e) => { it.run(e); }, { seconds: it.secs + 0.3, sampleRate: 44100, volumes: LOUD });
    const m = measure([buffer.getChannelData(0), buffer.getChannelData(1)], buffer.sampleRate);
    const status = m.peak >= 0.995 ? 'CLIP' : m.peakDb < -36 ? 'QUIET' : 'ok';
    rows.push({ group: it.group, label: it.label, peakDb: +m.peakDb.toFixed(2), activeRmsDb: +m.activeRmsDb.toFixed(2), activeSec: +m.activeSec.toFixed(2), clipped: m.clipped, status });
  }
  const ms = Math.round(performance.now() - t0);
  progressEl.textContent = `Rendered ${rows.length} sounds through the full master chain at full volume in ${(ms / 1000).toFixed(1)} s — ${rows.filter((r) => r.status !== 'ok').length} problems.`;
  return rows;
}

function renderReport(rows, host) {
  host.innerHTML = '';
  const groups = [...new Set(rows.map((r) => r.group))];
  const wrap = h('div', { class: 'report-cols' });
  for (const g of groups) {
    const tb = h('tbody');
    for (const r of rows.filter((x) => x.group === g)) {
      const w = Math.max(0, Math.min(100, ((r.peakDb + 48) / 48) * 100));
      const heat = r.status === 'CLIP' ? 'lvl clip' : r.peakDb > -3 ? 'lvl hot' : 'lvl';
      tb.append(h('tr', {},
        h('td', {}, r.label),
        h('td', { class: 'bar' }, h('div', { class: 'track' }, h('div', { class: heat, style: `width:${w}%` }))),
        h('td', {}, db(r.peakDb)),
        h('td', {}, db(r.activeRmsDb)),
        h('td', {}, `${r.activeSec.toFixed(2)} s`),
        h('td', { class: r.status === 'ok' ? 'ok' : 'bad' }, r.status)));
    }
    wrap.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, g), h('th', {}, 'peak'), h('th', {}, 'dBFS'), h('th', {}, 'RMS'), h('th', {}, 'length'), h('th', {}, ''))), tb));
  }
  host.append(wrap);
}

const reportHost = h('div');
const reportProgress = h('span', { class: 'note' }, 'Renders every sound offline at full volume and measures it.');
let reportPromise = null;
function startReport() {
  if (!reportPromise) {
    reportPromise = runReport(reportProgress).then((rows) => { renderReport(rows, reportHost); window.__audioReport = rows; return rows; })
      .catch((e) => { console.error('[lab] report failed', e); reportProgress.textContent = `Report failed: ${e.message}`; return []; })
      .finally(() => { reportPromise = null; });
  }
  return reportPromise;
}
const rc = card('Offline level check', 'var(--mint)',
  h('div', { class: 'report-head' }, btn('Render report', startReport, 't-crowd', { smoke: false }), reportProgress),
  reportHost);
rc.classList.add('wide');

// ───────────────────────────── live meter + state ─────────────────────────────

/** Match the canvas backing store to its displayed size (crisp text at any width / DPR). */
function fitMeter() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, Math.round(meter.clientWidth * dpr)), hh = Math.max(60, Math.round(meter.clientHeight * dpr));
  if (meter.width !== w || meter.height !== hh) { meter.width = w; meter.height = hh; }
  return dpr;
}

function drawIdleMeter() {
  const dpr = fitMeter();
  const c = meter.getContext('2d');
  c.fillStyle = '#14182b';
  c.fillRect(0, 0, meter.width, meter.height);
  c.strokeStyle = 'rgba(91, 209, 184, 0.45)';
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(0, meter.height * 0.4); c.lineTo(meter.width, meter.height * 0.4); c.stroke();
  c.fillStyle = 'rgba(255, 250, 240, 0.7)';
  c.font = `800 ${13 * dpr}px Nunito, system-ui`;
  const msg = 'Output meter · press any sound to start';
  c.fillText(msg, 12 * dpr, meter.height - 14 * dpr, meter.width - 24 * dpr);
}
drawIdleMeter();

let meterOn = false;
function startMeter() {
  if (meterOn) return;
  const an = audio.analyser();
  if (!an) return;
  meterOn = true;
  const ctx2 = meter.getContext('2d');
  const buf = new Float32Array(an.fftSize);
  let peakHold = 0;
  const draw = () => {
    const dpr = fitMeter();
    an.getFloatTimeDomainData(buf);
    let pk = 0, sum = 0;
    for (const x of buf) { const a = Math.abs(x); if (a > pk) pk = a; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    peakHold = Math.max(pk, peakHold * 0.96);
    const W = meter.width, H = meter.height;
    ctx2.fillStyle = '#14182b';
    ctx2.fillRect(0, 0, W, H);
    ctx2.strokeStyle = '#5bd1b8';
    ctx2.lineWidth = 2 * dpr;
    ctx2.beginPath();
    for (let i = 0; i < buf.length; i += 4) {
      const x = (i / buf.length) * W, y = H * 0.4 - buf[i] * H * 0.36;
      if (i) ctx2.lineTo(x, y); else ctx2.moveTo(x, y);
    }
    ctx2.stroke();
    const pad = 10 * dpr, barH = 10 * dpr, barY = H - pad - barH;
    const toX = (a) => Math.max(0, Math.min(1, (20 * Math.log10(a + 1e-9) + 48) / 48)) * (W - 2 * pad) + pad;
    ctx2.fillStyle = 'rgba(255,250,240,0.12)';
    ctx2.fillRect(pad, barY, W - 2 * pad, barH);
    ctx2.fillStyle = '#2bb3a3';
    ctx2.fillRect(pad, barY, toX(rms) - pad, barH);
    ctx2.fillStyle = peakHold > 0.95 ? '#ff4d5e' : '#ffc94a';
    ctx2.fillRect(toX(peakHold) - 2 * dpr, barY - 3 * dpr, 4 * dpr, barH + 6 * dpr);
    ctx2.fillStyle = '#fffaf0';
    ctx2.font = `800 ${13 * dpr}px Nunito, system-ui`;
    ctx2.fillText(`peak ${db(20 * Math.log10(peakHold + 1e-9))} dBFS · rms ${db(20 * Math.log10(rms + 1e-9))}`, pad, 18 * dpr);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

const logEl = document.getElementById('log');
function refresh() {
  const s = audio.state();
  const on = s.context === 'running' && !s.hidden;
  statusEl.classList.toggle('on', on);
  statusText.textContent = on ? 'Audio is running' : s.context === 'none' ? 'Audio is off — click anything' : `Audio: ${s.context}`;
  stateBox.replaceChildren(...[
    ['music', s.music ?? '—'], ['crowd', s.crowd ? `on · ${s.excitement.toFixed(2)}` : 'off'], ['phase', s.phase],
    ['voices', s.voices], ['speech', s.speech + (s.voiceName ? ` · ${s.voiceName.split(/\s|\(/)[0]}` : '')], ['activity', s.activity ?? '—'],
    ['calls', s.calls ? 'match:call' : 'legacy'], ['slow-mo', s.warp ?? '—'], ['outro', s.outro + (s.drone ? ' · drone' : '')],
  ].map(([k, v]) => h('div', {}, h('b', {}, k), String(v))));
  const lines = audio.log.slice(-14).reverse().map((l) => h('div', {}, h('span', { class: 'k' }, `${l.t.toFixed(2).padStart(7)}  ${l.kind.padEnd(8)}`), ` ${l.name}`));
  logEl.replaceChildren(...lines);
  if (on) startMeter();
}
setInterval(refresh, 250);
refresh();

// ───────────────────────────── automation hooks (headless checks) ─────────────────────────────

window.__audioLab = { reportItems, renderOffline, measure };
window.__audioReportReady = params.has('report') ? startReport() : null;

if (params.has('smoke')) {
  window.__audioSmokeReady = (async () => {
    const ok = await audio.unlock();
    const errors = [];
    const onErr = (e) => errors.push(String(e.message || e));
    window.addEventListener('error', onErr);
    let played = 0;
    for (const b of allButtons) {
      try { b.fn(); played++; } catch (e) { errors.push(`${b.label}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 90));
    }
    audio.music('menu');
    await new Promise((r) => setTimeout(r, 1500));
    audio.music('training');
    await new Promise((r) => setTimeout(r, 1500));
    audio.music(null);
    window.removeEventListener('error', onErr);
    const s = audio.state();
    window.__audioSmoke = { unlocked: ok, played, errors, state: s, logTail: audio.log.slice(-6) };
    return window.__audioSmoke;
  })();
}
