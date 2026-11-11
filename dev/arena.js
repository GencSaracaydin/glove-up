// Arena lab: drives the real GameRenderer with a scripted fake bout that follows the alignment-pass
// contract (ARCHITECTURE §6: view.stage / stageTime, hp in wedges, MATCH_HIT {heavy, knockdown,
// hpBefore, hpAfter}, MATCH_SLOWMO + view.slowmo, MATCH_CALL), then plays the bout outro.
//
//   /dev/arena.html                      live loop (buttons at the bottom)
//   /dev/arena.html?shot=<preset>        fast-forward to a moment and freeze it (for screenshots)
//   presets: arena banner flyin ring fight gameplay guard lean hit cut heavy block dodge slowmo
//            fall kdwide count standoff pdown pcount meters ko
//            outro-wipe outro-side outro-low outro-over outro-banner outro-winner decision menu training
//   extra params: &split=2  &ending=decision  &t=<seconds>  &o=<outro seconds>  &q=low  &rm=1  &fast=1
//
// The script's own clock is game time (advanced by dt × renderer.timeScale, like the app).

import * as THREE from 'three';
import { EventBus } from '../src/core/events.js';
import { Ev, BoxerPhase } from '../src/core/types.js';
import { GameRenderer } from '../src/render/renderer.js';

const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const statusEl = document.getElementById('status');
if (shotName) document.body.classList.add('shot');

const APPEARANCE = {
  p1: { skin: '#eec1a0', hair: { style: 'crew', color: '#4a2f22' }, eyes: 'oval', brows: 'flat', mouth: 'smile', nose: 'button', accessory: 'none', top: 'none', trunks: '#3d7bff', trim: '#ffd166', gloves: '#3d7bff', shoes: '#14182b', build: 'average', height: 1 },
  p2: { skin: '#8d5a3b', hair: { style: 'mohawk', color: '#e64980' }, eyes: 'fierce', brows: 'angry', mouth: 'grin', nose: 'round', accessory: 'headband', top: '#ffd166', trunks: '#ff4d5e', trim: '#f7f3ea', gloves: '#ff4d5e', shoes: '#f7f3ea', build: 'average', height: 1.02 },
};

const ending = params.get('ending') === 'decision' ? 'decision' : 'ko';
const TRAVEL = 0.14, RECOVER = 0.24, AI_TRAVEL = 0.22;

// ───────────────────────────── the scripted bout ─────────────────────────────

/** Timeline of [start, phase, stage, extra]. */
const TL = [];
let T = 0;
const seg = (dur, phase, stage, extra = {}) => { TL.push({ t: T, dur, phase, stage, ...extra }); T += dur; return T; };
seg(1.0, 'intro', 'arena');
seg(2.0, 'roundStart', 'banner');
seg(1.6, 'roundStart', 'flyin');
seg(1.4, 'roundStart', 'ring');
seg(0.9, 'roundStart', 'fight');
const LIVE1 = seg(9.5, 'fighting', 'live');
// knockdown 1 (opponent), rises at 5
const KD1 = LIVE1;
seg(0.9, 'knockdown', 'fall', { downed: 'p2' }); seg(1.2, 'knockdown', 'down-call', { downed: 'p2' });
seg(5 * 1.08 + 0.3, 'knockdown', 'count', { downed: 'p2', rise: 5 });
const REC1 = T;
seg(1.2, 'recovery', 'rise'); seg(2.4, 'recovery', 'standoff'); seg(0.8, 'recovery', 'fight');
const LIVE2 = seg(4.2, 'fighting', 'live');
// knockdown of the player, rises at 4
const PKD = LIVE2;
seg(0.9, 'knockdown', 'fall', { downed: 'p1' }); seg(1.2, 'knockdown', 'down-call', { downed: 'p1' });
seg(4 * 1.08 + 0.3, 'knockdown', 'count', { downed: 'p1', rise: 4 });
seg(1.2, 'recovery', 'rise'); seg(2.0, 'recovery', 'standoff'); seg(0.8, 'recovery', 'fight');
const LIVE3 = seg(ending === 'ko' ? 3.0 : 4.5, 'fighting', 'live');
let RESULT_T;
if (ending === 'ko') {
  seg(0.9, 'knockdown', 'fall', { downed: 'p2' }); seg(1.2, 'knockdown', 'down-call', { downed: 'p2' });
  seg(10 * 1.08 + 0.2, 'knockdown', 'count', { downed: 'p2' }); seg(1.4, 'knockdown', 'ko-call', { downed: 'p2' });
  seg(1.0, 'knockdown', 'ko-hold', { downed: 'p2' });
  RESULT_T = T; seg(60, 'result', 'result');
} else {
  seg(0.4, 'roundEnd', 'bell'); seg(1.6, 'roundEnd', 'hold'); seg(2.0, 'decision', 'decision');
  RESULT_T = T; seg(60, 'result', 'result');
}
const KD2 = LIVE3;

/** Punches: t = impact time. out ∈ hit | blocked | dodged | miss. */
const L1 = LIVE1 - 9.5, L2 = LIVE2 - 4.2, L3 = LIVE3 - (ending === 'ko' ? 3.0 : 4.5);
const ACTIONS = [
  { t: L1 + 0.8, who: 'p2', hand: 'left', kind: 'straight', target: 'head', out: 'blocked', windup: 0.3 },
  { t: L1 + 1.6, who: 'p1', hand: 'left', kind: 'straight', target: 'head', out: 'hit', power: 0.5, dmg: 1.2 },
  { t: L1 + 2.0, who: 'p1', hand: 'right', kind: 'straight', target: 'head', out: 'hit', power: 0.8, dmg: 1.5 },
  { t: L1 + 3.4, who: 'p2', hand: 'right', kind: 'hook', target: 'head', out: 'dodged', windup: 0.6, power: true, dodge: { x: -0.95, y: -0.1 } },
  { t: L1 + 3.85, who: 'p1', hand: 'right', kind: 'straight', target: 'head', out: 'hit', power: 0.95, counter: true, dmg: 3.0 },
  { t: L1 + 5.0, who: 'p1', hand: 'left', kind: 'straight', target: 'body', out: 'blocked' },
  { t: L1 + 5.6, who: 'p2', hand: 'left', kind: 'straight', target: 'head', out: 'hit', power: 0.6, windup: 0.28, dmg: 1.1 },
  { t: L1 + 6.4, who: 'p1', hand: 'right', kind: 'uppercut', target: 'head', out: 'miss' },
  { t: L1 + 7.1, who: 'p2', hand: 'right', kind: 'hook', target: 'head', out: 'hit', power: 0.95, windup: 0.6, heavy: true, dmg: 3.2 },
  { t: L1 + 8.2, who: 'p1', hand: 'left', kind: 'hook', target: 'head', out: 'hit', power: 0.8, dmg: 1.4 },
  { t: L1 + 9.48, who: 'p1', hand: 'right', kind: 'straight', target: 'head', out: 'hit', power: 1.0, counter: true, dmg: 4.0, kd: true },
  { t: L2 + 1.0, who: 'p2', hand: 'left', kind: 'straight', target: 'body', out: 'hit', power: 0.6, windup: 0.3, dmg: 1.1 },
  { t: L2 + 2.0, who: 'p1', hand: 'left', kind: 'straight', target: 'head', out: 'hit', power: 0.75, dmg: 1.3 },
  { t: L2 + 4.18, who: 'p2', hand: 'right', kind: 'hook', target: 'head', out: 'hit', power: 1, windup: 0.6, heavy: true, dmg: 9, kd: true },
  { t: L3 + 1.2, who: 'p1', hand: 'left', kind: 'straight', target: 'head', out: 'hit', power: 0.8, dmg: 1.3 },
  ...(ending === 'ko' ? [{ t: L3 + 2.98, who: 'p1', hand: 'left', kind: 'hook', target: 'head', out: 'hit', power: 1.0, counter: true, dmg: 9, kd: true }] : []),
];

/** Health in wedges over time (knockdown refill = 10 − 2k). */
function hpAt(id, t) {
  let hp = 10, kds = 0;
  for (const a of ACTIONS) {
    if (a.t > t) break;
    const foe = id === 'p1' ? 'p2' : 'p1';
    if (a.who === foe && a.out === 'hit') hp = Math.max(0, hp - (a.dmg ?? 1));
    if (a.who === foe && a.kd) kds++;
  }
  // refills after rising
  for (const s of TL) if (s.stage === 'rise' && s.t <= t) {
    const prevKd = TL.slice(0, TL.indexOf(s)).reverse().find((x) => x.phase === 'knockdown');
    if (prevKd && prevKd.downed === id) {
      const k = ACTIONS.filter((a) => a.kd && a.t <= s.t && a.who !== id).length;
      hp = Math.max(hp, 10 - 2 * k);
    }
  }
  return { hp, kds };
}

/** Timed bus events, sorted. */
const EVENTS = [];
const evt = (t, name, payload) => EVENTS.push({ t, name, payload });
evt(0.02, Ev.MATCH_INTRO, { p1Name: 'You', p2Name: 'Sunny Rivera' });
for (const s of TL) {
  if (s.phase === 'roundStart' && s.stage === 'banner') { evt(s.t, Ev.MATCH_ROUND_START, { round: 1 }); evt(s.t, Ev.MATCH_CALL, { call: 'round', round: 1 }); }
  if (s.stage === 'fight') { evt(s.t, Ev.MATCH_CALL, { call: 'fight' }); evt(s.t, Ev.MATCH_BELL, { kind: 'start' }); }
  if (s.stage === 'down-call') evt(s.t, Ev.MATCH_CALL, { call: 'down', boxer: s.downed });
  if (s.stage === 'count') {
    const n = s.rise ?? 10;
    for (let i = 1; i <= n; i++) evt(s.t + (i - 1) * 1.08 + 0.1, Ev.MATCH_COUNT, { downed: s.downed, n: i });
    if (s.rise) evt(s.t + s.dur - 0.05, Ev.MATCH_GETUP, { downed: s.downed, atCount: s.rise });
  }
  if (s.stage === 'ko-call') { evt(s.t, Ev.MATCH_CALL, { call: 'ko', winner: 'p1' }); evt(s.t, Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' }); }
  if (s.stage === 'decision') evt(s.t, Ev.MATCH_CALL, { call: 'decision' });
}
const RESULT = ending === 'ko'
  ? { id: 'dev-ko', winner: 'p1', method: 'KO', endRound: 1, endClockMs: 95000, scorecards: [], mode: 'single', opponentId: 'dev', stats: {} }
  : { id: 'dev-dec', winner: 'p1', method: 'decision', endRound: 3, endClockMs: 180000, mode: 'single', opponentId: 'dev', stats: {}, scorecards: [] };
evt(RESULT_T, Ev.MATCH_RESULT, RESULT);
for (const a of ACTIONS) {
  const att = a.who, def = a.who === 'p1' ? 'p2' : 'p1';
  const base = { attacker: att, hand: a.hand, kind: a.kind, target: a.target };
  const travel = att === 'p1' ? TRAVEL : AI_TRAVEL;
  if (a.windup) evt(a.t - travel - a.windup, Ev.MATCH_WINDUP, { ...base, windupMs: a.windup * 1000, tell: { pullback: 1, glint: false, grunt: true, shoulder: 1, power: !!a.power } });
  evt(a.t - travel, Ev.MATCH_PUNCH_THROWN, base);
  if (a.out === 'hit') {
    const before = hpAt(def, a.t - 1e-6).hp, after = Math.max(0, before - (a.dmg ?? 1));
    evt(a.t, Ev.MATCH_HIT, { ...base, defender: def, damage: a.dmg ?? 1, counter: !!a.counter, power: typeof a.power === 'number' ? a.power : 0.8,
      heavy: !!a.heavy || !!a.counter, knockdown: !!a.kd, hpBefore: before, hpAfter: after });
    if (a.kd) evt(a.t + 0.001, Ev.MATCH_KNOCKDOWN, { downed: def, count: 1 });
  }
  if (a.out === 'blocked') evt(a.t, Ev.MATCH_BLOCK, { ...base, defender: def, chip: 0 });
  if (a.out === 'dodged') {
    evt(a.t, Ev.MATCH_DODGE, { ...base, defender: def, counterWindowMs: 700 });
    if (def === 'p1') evt(a.t + 0.001, Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 });
  }
  if (a.out === 'miss') evt(a.t, Ev.MATCH_MISS, { attacker: att, hand: a.hand, kind: a.kind });
}
EVENTS.sort((a, b) => a.t - b.t);

function segAt(t) {
  let cur = TL[0];
  for (const s of TL) if (t >= s.t) cur = s;
  return cur;
}
/** Start of the run of segments sharing the phase that contains t. */
function phaseStart(t) {
  let i = 0;
  for (let k = 0; k < TL.length; k++) if (TL[k].t <= t) i = k;
  while (i > 0 && TL[i - 1].phase === TL[i].phase) i--;
  return TL[i].t;
}
/** The knockdown segment that the recovery segment `sg` follows. */
function lastDowned(sg) {
  for (let i = TL.indexOf(sg); i >= 0; i--) if (TL[i].phase === 'knockdown') return TL[i].downed;
  return null;
}

const smooth = (e0, e1, x) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
const bump = (t, a, b, ramp = 0.12) => smooth(a - ramp, a, t) * (1 - smooth(b, b + ramp, t));

function makeView(id) {
  return {
    id, name: id === 'p1' ? 'You' : 'Sunny Rivera', isHuman: id === 'p1', appearance: APPEARANCE[id], phase: 'idle', phaseProgress: 0,
    hp01: 1, hp: 10, maxHp: 10, stamina01: 1, guard: 'high', lean: { x: 0, y: 0, z: 0 },
    hands: { left: { x: -0.3, y: 0.55, reach: 0.12, punching: false }, right: { x: 0.3, y: 0.6, reach: 0.12, punching: false } },
    punch: null, punches: [], hitReact: null, knockdowns: 0, roundKnockdowns: 0, counterReady: false, expression: 'focus',
  };
}
const views = { p1: makeView('p1'), p2: makeView('p2') };
const matchView = {
  phase: 'intro', phaseTime: 0, stage: 'arena', stageTime: 0, round: 1, maxRounds: 3, clockDisplayMs: 180000, roundRealMsLeft: 60000,
  downed: null, count: null, boxers: views, banner: null, result: null, mode: 'single', opponent: null, slowmo: null, clockVisible: false,
};

function boxerAt(id, t, sg) {
  const v = views[id];
  const foe = id === 'p1' ? 'p2' : 'p1';
  const seed = id === 'p1' ? 0 : 1.7;
  v.lean.x = 0.08 * Math.sin(t * 1.6 + seed); v.lean.y = 0.03 * Math.sin(t * 2.3 + seed); v.lean.z = 0;
  v.guard = 'high'; v.phase = BoxerPhase.GUARD; v.phaseProgress = 0; v.punch = null; v.punches = []; v.hitReact = null; v.counterReady = false;
  v.expression = 'focus';
  const L = v.hands.left, R = v.hands.right;
  const breathe = 0.03 * Math.sin(t * 3 + seed);
  L.x = -0.3; L.y = 0.62 + breathe; L.reach = 0.12; L.punching = false;
  R.x = 0.3; R.y = 0.66 + breathe; R.reach = 0.12; R.punching = false;
  const { hp, kds } = hpAt(id, t);
  v.hp = hp; v.hp01 = hp / 10; v.knockdowns = kds; v.roundKnockdowns = kds;

  const ph = sg.phase;
  if (ph === 'intro' || ph === 'roundStart') { v.phase = BoxerPhase.IDLE; v.guard = sg.stage === 'fight' ? 'high' : 'none'; if (v.guard === 'none') { L.y = 0.15; R.y = 0.15; } return v; }
  if (ph === 'roundEnd' || ph === 'decision') { v.phase = BoxerPhase.IDLE; v.guard = 'none'; L.y = -0.6; R.y = -0.6; L.reach = 0; R.reach = 0; v.expression = 'neutral'; return v; }
  if (ph === 'result') {
    const won = RESULT.winner === id;
    if (!won && RESULT.method === 'KO') { v.phase = BoxerPhase.KO; v.phaseProgress = 1; v.expression = 'ko'; return v; }
    v.phase = won ? BoxerPhase.VICTORY : BoxerPhase.DEFEAT; v.expression = won ? 'happy' : 'sad'; v.guard = 'none';
    return v;
  }
  if (ph === 'knockdown' && sg.downed === id) {
    v.phase = BoxerPhase.DOWN; v.expression = 'dazed'; v.guard = 'none';
    if (sg.stage === 'ko-call' || sg.stage === 'ko-hold') v.phase = BoxerPhase.KO;
    return v;
  }
  if (ph === 'recovery') {
    if (lastDowned(sg) === id && sg.stage === 'rise') { v.phase = BoxerPhase.GETUP; v.phaseProgress = Math.min(1, (t - sg.t) / 1.2); v.expression = 'hurt'; return v; }
    return v;
  }
  if (ph === 'knockdown') { v.phase = BoxerPhase.GUARD; return v; }

  for (const a of ACTIONS) {
    const travel = a.who === 'p1' ? TRAVEL : AI_TRAVEL;
    const start = a.t - travel - (a.windup ?? 0);
    if (t < start - 0.5 || t > a.t + 0.9) continue;
    if (a.who === id) {
      const H = a.hand === 'left' ? L : R;
      const sgn = a.hand === 'left' ? -1 : 1;
      const q = { id: Math.round(a.t * 100), hand: a.hand, kind: a.kind, target: a.target, progress: 0, stage: 'travel', outcome: null,
        power: typeof a.power === 'number' ? a.power : a.power ? 1 : 0.5, powerPunch: a.power === true || !!a.heavy, counter: !!a.counter };
      if (a.windup && t >= start && t < a.t - travel) {
        const k = (t - start) / a.windup;
        v.phase = BoxerPhase.WINDUP; v.phaseProgress = k;
        v.windup = { hand: a.hand, kind: a.kind, target: a.target, progress: k, tell: { pullback: 1, shoulder: 1 } };
      } else if (t >= a.t - travel && t < a.t) {
        const k = (t - (a.t - travel)) / travel;
        v.windup = null;
        v.phase = BoxerPhase.PUNCH; v.phaseProgress = k; v.guard = 'none';
        q.progress = k; v.punch = q; v.punches = [q];
        H.punching = true; H.reach = Math.sin(k * Math.PI / 2);
      } else if (t >= a.t && t < a.t + RECOVER) {
        const k = (t - a.t) / RECOVER;
        v.windup = null;
        v.phase = BoxerPhase.RECOVER; v.phaseProgress = k;
        q.stage = 'recover'; q.progress = 1 - k; q.outcome = a.out === 'hit' ? 'hit' : a.out === 'blocked' ? 'blocked' : a.out === 'dodged' ? 'dodged' : 'miss';
        v.punch = q; v.punches = [q];
        H.reach = 1 - k; H.x = sgn * 0.3 * k;
      } else v.windup = null;
    } else {
      if (a.out === 'hit' && t >= a.t && t < a.t + 0.7) {
        const age = t - a.t;
        v.hitReact = { hand: a.hand, kind: a.kind, target: a.target, strength: typeof a.power === 'number' ? a.power : 0.9, age, blocked: false };
        if (age < 0.4) { v.phase = BoxerPhase.HITSTUN; v.phaseProgress = age / 0.4; v.guard = 'none'; v.expression = 'hurt'; L.y = 0.3; R.y = 0.3; }
      }
      if (a.out === 'blocked') {
        const g = bump(t, a.t - 0.3, a.t + 0.25);
        if (g > 0.5) { v.guard = a.target === 'body' ? 'low' : 'high'; v.phase = BoxerPhase.GUARD; }
        if (t >= a.t && t < a.t + 0.4) v.hitReact = { hand: a.hand, kind: a.kind, target: a.target, strength: 0.3, age: t - a.t, blocked: true };
      }
      if (a.out === 'dodged' && a.dodge) {
        const k = bump(t, a.t - 0.14, a.t + 0.5, 0.12);
        v.lean.x += a.dodge.x * k; v.lean.y += a.dodge.y * k;
        if (k > 0.5) v.phase = BoxerPhase.DODGE;
        if (t > a.t && t < a.t + 0.7) v.counterReady = true;
      }
    }
  }
  void foe;
  return v;
}

function viewAt(t) {
  const sg = segAt(t);
  matchView.phase = sg.phase;
  matchView.phaseTime = t - phaseStart(t);
  matchView.stage = sg.stage;
  matchView.stageTime = t - sg.t;
  matchView.downed = sg.phase === 'knockdown' ? sg.downed ?? null : null;
  matchView.count = sg.stage === 'count' ? Math.max(1, Math.min(10, Math.floor((t - sg.t) / 1.08) + 1)) : null;
  matchView.result = sg.phase === 'result' ? RESULT : null;
  matchView.clockVisible = sg.phase === 'fighting';
  // dodge slow motion (the player dodged the power hook)
  const dodge = ACTIONS.find((a) => a.out === 'dodged' && a.who === 'p2' && t >= a.t && t < a.t + 0.75);
  matchView.slowmo = dodge ? { kind: 'dodge', dodger: 'p1', scale: 0.25, t01: (t - dodge.t) / 0.75, msLeft: (dodge.t + 0.75 - t) * 1000 } : null;
  boxerAt('p1', t, sg);
  boxerAt('p2', t, sg);
  return matchView;
}

// ───────────────────────────── training view (fake) ─────────────────────────────

const trainView = { kind: 'bag', phase: 'active', timeLeftMs: 42000, score: 180, combo: 4, popups: [], playerView: makeView('p1') };
function trainingAt(t) {
  const pv = trainView.playerView;
  pv.lean.x = 0.15 * Math.sin(t * 1.3); pv.lean.y = 0; pv.phase = BoxerPhase.GUARD;
  const k = (t * 1.6) % 1;
  pv.hands.right.reach = k < 0.5 ? Math.sin(k * 2 * Math.PI) : 0.12;
  pv.hands.right.punching = k < 0.5;
  return trainView;
}

// ───────────────────────────── driver ─────────────────────────────

const A = (i) => ACTIONS[i].t;
const segT = (phase, stage, n = 0) => TL.filter((s) => s.phase === phase && s.stage === stage)[n]?.t ?? 0;
const PRESETS = {
  arena: { t: 0.6 }, banner: { t: 2.0 }, flyin: { t: segT('roundStart', 'flyin') + 0.9 }, ring: { t: segT('roundStart', 'ring') + 0.8 },
  fight: { t: segT('roundStart', 'fight') + 0.25 },
  gameplay: { t: L1 + 0.3 }, guard: { t: A(0) - 0.02 }, lean: { t: A(3) + 0.12 }, hit: { t: A(2) + 0.03 },
  cut: { t: A(6) + 0.12 }, heavy: { t: A(8) + 0.04 }, block: { t: A(0) + 0.03 }, dodge: { t: A(3) + 0.1 }, slowmo: { t: A(3) + 0.35 },
  fall: { t: KD1 + 0.55, from: KD1 - 2 }, kdwide: { t: KD1 + 1.6, from: KD1 - 2 }, count: { t: KD1 + 4.2, from: KD1 - 2 },
  standoff: { t: REC1 + 1.6, from: REC1 - 1 }, pdown: { t: PKD + 1.5, from: PKD - 2 }, pcount: { t: PKD + 3.8, from: PKD - 2 },
  meters: { t: A(8) + 1.0 }, ko: { t: KD2 + 13.5, from: KD2 - 3 },
  'outro-wipe': { t: RESULT_T + 0.05, from: KD2 - 3, o: 0.62 }, 'outro-side': { t: RESULT_T + 0.05, from: KD2 - 3, o: 1.9 },
  'outro-low': { t: RESULT_T + 0.05, from: KD2 - 3, o: 4.4 }, 'outro-over': { t: RESULT_T + 0.05, from: KD2 - 3, o: 7.2 },
  'outro-banner': { t: RESULT_T + 0.05, from: KD2 - 3, o: 10.2 }, 'outro-winner': { t: RESULT_T + 0.05, from: KD2 - 3, o: 14.2 },
  decision: { t: RESULT_T + 0.05, from: RESULT_T - 3, o: 2.2, ending: 'decision' },
  menu: { menu: 4 }, training: { training: 3 },
};

const bus = new EventBus();
let simMs = 0;
const quality = params.get('q') === 'low' ? 'low' : 'auto';
const canvas = document.getElementById('scene');
const renderer = new GameRenderer({ canvas, bus, quality, clock: () => simMs, reducedMotion: params.get('rm') === '1', fast: params.get('fast') === '1' });
// ?cam=up,back,lookY,fov (centred) or ?cam=side,up,back,lookX,lookY,fov — try a live-camera framing
const cam = (params.get('cam') || '').split(',').map(Number);
if (cam.length === 4 && cam.every(Number.isFinite)) renderer.three.rigs[0].playTuning = { offset: [0, cam[0], cam[1]], lookAt: [0, cam[2], 1.75], fov: cam[3] };
else if (cam.length === 6 && cam.every(Number.isFinite)) renderer.three.rigs[0].playTuning = { offset: [cam[0], cam[1], cam[2]], lookAt: [cam[3], cam[4], 1.75], fov: cam[5] };
const log = [];
for (const name of [Ev.RENDER_CUT, Ev.RENDER_OUTRO]) bus.on(name, (p) => log.push({ t: +simT.toFixed(2), name, ...p }));
window.__arena = { renderer, bus, viewAt, PRESETS, log, TL, ACTIONS, step: (dt, draw = false) => stepMatch(dt, draw), get simT() { return simT; } };

const preset = shotName ? PRESETS[shotName] : null;
if (shotName && !preset) console.warn(`[arena] unknown preset "${shotName}" — try: ${Object.keys(PRESETS).join(', ')}`);
const split = Number(params.get('split') ?? preset?.split ?? 1);
if (split === 2) { matchView.mode = 'versus'; views.p2.isHuman = true; renderer.setSplit(2); }
if (preset?.ending && preset.ending !== ending) { params.set('ending', preset.ending); location.search = params.toString(); }

let simT = 0;
let lastEventT = -1;
let outroP = null;
function emitUpTo(t) {
  for (const e of EVENTS) if (e.t > lastEventT && e.t <= t) {
    bus.emit(e.name, e.payload);
    if (e.name === Ev.MATCH_RESULT && !outroP) outroP = renderer.playOutro({ result: e.payload, view: matchView });
  }
  lastEventT = t;
}

function stepMatch(dt, draw) {
  simMs += dt * 1000;
  simT += dt * renderer.timeScale; // like the app: game time advances by dt × renderer.timeScale
  emitUpTo(simT);
  renderer.renderMatch(viewAt(simT), dt, { draw });
}

async function waitFonts() {
  try {
    await Promise.race([document.fonts.load("64px 'Lilita One'"), new Promise((r) => setTimeout(r, 2500))]);
    renderer.arena.refreshText();
  } catch { /* fallback font is fine */ }
}

function status() {
  const d = renderer.debugState();
  statusEl.textContent = `t=${simT.toFixed(2)}s  ${matchView.phase}/${matchView.stage}  shot=${d.shot}${d.shot2 ? '/' + d.shot2 : ''}  ` +
    `ts=${d.timeScale.toFixed(2)}  calls=${d.drawCalls}  outro=${d.outro ? d.outro.stage + '@' + d.outro.t : '-'}`;
}

async function runShot(p) {
  await waitFonts();
  const dt = 1 / 60;
  if (p.menu) {
    const n = p.menu * 60;
    for (let i = 0; i < n; i++) { simMs += dt * 1000; renderer.renderMenu(dt, { draw: i === n - 1 }); }
  } else if (p.training) {
    for (let i = 0; i < p.training * 60; i++) { simMs += dt * 1000; renderer.renderTraining(trainingAt(i * dt), dt, { draw: i === p.training * 60 - 1 }); }
  } else {
    const T0 = Number(params.get('t') ?? p.t);
    simT = Math.max(0, p.from ?? T0 - 4);
    lastEventT = simT;
    let guard = 0;
    while (simT < T0 && guard++ < 20000) stepMatch(dt, false);
    const O = Number(params.get('o') ?? p.o ?? NaN);
    if (Number.isFinite(O)) {
      let t = 0;
      while (t < O && guard++ < 40000) { t += dt; stepMatch(dt, false); }
    }
    stepMatch(0, true);
  }
  status();
  window.__shotReady = true;
}

function buildPanel() {
  const panel = document.getElementById('panel');
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { const q = new URLSearchParams(); q.set('shot', name); location.search = q.toString(); };
    panel.appendChild(b);
  }
  const live = document.createElement('button');
  live.textContent = 'live';
  live.className = 'on';
  live.onclick = () => { location.search = ''; };
  panel.appendChild(live);
}

if (preset) {
  runShot(preset);
} else {
  buildPanel();
  await waitFonts();
  let last = performance.now();
  let paused = false;
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') paused = !paused;
    if (e.code === 'KeyR') { simT = 0; lastEventT = -1; outroP = null; renderer.resetMatch(); }
  });
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) stepMatch(dt, true);
    status();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
void THREE;
