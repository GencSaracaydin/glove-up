// In-fight HUD — our own graphics for the functions measured in research/mechanics.md §5:
//
//  * Name plates in the bottom corners: a small face icon, the name and a coloured underline
//    (P1 blue, P2 coral), plus the camera-tracking dot on human boxers.
//  * Our own round clock at the bottom centre: three round lamps (done / current / future) above an
//    M:SS countdown. Plates + clock show only while the round is live (view.clockVisible): they hide
//    for intros, knockdown stoppages, breaks and outros, and stay up during the player-hit cut.
//  * Text calls (Ev.MATCH_CALL / view.call, view.count; view.banner as a fallback for older matches):
//    "Round N" / "Final round" plate (~2 s), "Fight!" (~0.9 s), "Down!" whose two halves sweep in and
//    merge (~0.95 s), count numbers 1–10 that pop, scale and fade (~0.5 s each), "KO" letters that fly
//    in and bounce (~1.8 s), "Time!" and "Decision".
//  * Bout outro (Ev.RENDER_OUTRO from GameRenderer.playOutro): the win banner text on stage 'banner'
//    (the confetti is 3D) and a "Replay" tag at the bottom left during stage 'replay' — our own marker,
//    a coral badge with a turning replay arrow. The renderer shows one full-screen view for the whole
//    outro, so the HUD root gets .is-outro and hides the versus divider and P1/P2 tags (FLOWS-05).
//  * A small, subtle get-up hint for a downed human ("Pump your arms!" + the view.getUp01 meter).
//  * The first-bout tutorial card (ARCHITECTURE.md §6.9): hud.showTutorial({...}) / hud.hideTutorial().
//  * An optional webcam picture-in-picture; versus = two halves, each tagged P1 / P2.
//  * Training HUD (our own mode): timer, score, streak and score popups that stack instead of overlapping.
//
// Health is drawn in the 3D view by render/ (ARCHITECTURE.md §6.7): this HUD shows no health bars,
// stats, combo counters, damage numbers or hit-text popups during bouts.
//
//   hud.show('match', { mode: 'single'|'versus' })      hud.update(matchView, extras?)
//   hud.show('training', { training, participant, turn, turns })   hud.updateTraining(trainingView, extras?)
//   hud.showTutorial({ step, index, total, title?, caption?, progress01?, mode?, skipHint? })   hud.hideTutorial()
//   hud.hide()          (the outro banner/replay tag live in their own layer; ui.show() of a menu clears them)
//   extras: { tracking?: boolean[], confidence?: number[], activity?: number[] }  (InputHub status / controls)
//
// CSS transforms/animations only. Pure helpers (hudCall, clockVisibleFor, roundLamps, outroBannerText,
// tutorialText, getUpHint, PopupStack) are exported for unit tests; nothing touches the DOM at import time.

import { Ev, MatchPhase } from '../core/types.js';
import { h, svg, icon, formatClock, formatNumber, clamp01, TRAINING_INFO, clear } from './screens/kit.js';
import { portraits } from './screens/portrait.js';
import { drawFallbackPreview } from './screens/live-preview.js';

export const HUD_TUNING = Object.freeze({
  /** How long each text call stays up (ms) — research/mechanics.md §5 "Text calls" and §1.2/§3.1. */
  callMs: Object.freeze({
    round: 2000,          // "Round N" banner 1.5–2.5 s
    'final-round': 2200,  // final-round banner 1.5–2.5 s
    fight: 900,           // "Fight!" 0.75–1 s
    down: 950,            // "Down" 0.75–1 s
    ko: 1800,             // "KO" letters bounce ~1.5 s, then the logo wipe 1–2 s after the call
    time: 1000,           // our own: the bell at 0:00 (the clock reads 0:00 underneath)
    decision: 1600,       // our own: no decision was ever shown in the reference
  }),
  /** Each count number is visible this long (one number per 1.08 s, each visible ~0.5 s). */
  countMs: 520,
  /** Exit animation of a call (ms; matches the CSS). */
  callOutMs: 260,
  /** Fallback when the view has no clockVisible: the clock stays up this long after the bell (s). */
  roundEndClockSec: 1.2,
  /** Fallback when the view has neither call nor banner: "Fight!" while phaseTime < this (s). */
  fightBannerSec: 0.9,
  /** Win banner (outro stage 'banner'): 3–5 s; hidden at the next stage or after this. */
  winBannerMaxMs: 5000,
  /** Webcam PiP redraw rate (Hz). */
  pipFps: 24,
  /** Get-up meter fallback (no getUp01 / activity): per punch and decay per second. */
  getUpPerPunch: 0.16,
  getUpDecayPerSec: 0.45,
  /** Training: popups younger than this are shown (s); lifetimes match the CSS (ms). */
  trainingPopupMaxAge: 0.6,
  popupMs: 950,
  popupBigMs: 1250,
  /** Training popups stack in this many slots per lane instead of overlapping. */
  popupSlots: 3,
  /** Training "GO!" banner (ms). */
  goBannerMs: 800,
  /** Auto tutorial card (view.tutorial without showTutorial calls): progress = holdMs / this for the
   *  stance / guard steps, count / tutorialCount for the punch / dodge steps (ARCHITECTURE §6.9). */
  tutorialHoldMs: 1000,
  tutorialCount: 3,
});

/** Progress 0..1 of a tutorial step from the match's view.tutorial {step, count, holdMs} (null if unknown). */
export function tutorialProgress(vt) {
  if (!vt || !vt.step) return null;
  if (Number.isFinite(vt.progress01)) return clamp01(vt.progress01);
  const counted = vt.step === 'punch-head' || vt.step === 'punch-body' || vt.step === 'dodge';
  if (counted) return Number.isFinite(vt.count) ? clamp01(vt.count / HUD_TUNING.tutorialCount) : null;
  return Number.isFinite(vt.holdMs) ? clamp01(vt.holdMs / HUD_TUNING.tutorialHoldMs) : null;
}

const P = MatchPhase;
const other = (id) => (id === 'p1' ? 'p2' : 'p1');

// ───────────────────────────── pure helpers (tested) ─────────────────────────────

/**
 * Should the live HUD (name plates + round clock) be up? Uses view.clockVisible (ARCHITECTURE §6.4)
 * when the match provides it; otherwise: only while fighting, plus a moment after the bell.
 * @param {import('../core/types.js').MatchView|null} view
 */
export function clockVisibleFor(view) {
  if (!view) return false;
  if (typeof view.clockVisible === 'boolean') return view.clockVisible;
  if (view.tutorial) return false;
  const phase = view.phase === P.PAUSED ? view.pausedFrom || view.phase : view.phase;
  if (phase === P.FIGHTING) return true;
  if (phase === P.ROUND_END) return (view.phaseTime ?? 0) < HUD_TUNING.roundEndClockSec;
  return false;
}

/** Lamp states for the round clock: one per round, 'done' | 'now' | 'next'. */
export function roundLamps(round, maxRounds = 3) {
  const n = Math.max(1, Math.min(9, Math.round(Number(maxRounds) || 3)));
  const r = Math.max(1, Math.round(Number(round) || 1));
  return Array.from({ length: n }, (_, i) => (i + 1 < r ? 'done' : i + 1 === r ? 'now' : 'next'));
}

/**
 * The text call the HUD should show for a MatchView, or null.
 * New matches (ARCHITECTURE §6.4): view.call {call, age, round?, boxer?, winner?} (or extra.call from
 * Ev.MATCH_CALL when the view lacks it) + view.count during the count. Older matches: view.banner.
 * `key` changes whenever a new call should pop; `lifeMs` is how long it stays up.
 * @param {any} view
 * @param {{call?: null|{call:string, age?:number, round?:number, boxer?:string, winner?:string}}} [extra]
 * @returns {null|{key:string, kind:string, text:string, sub?:string|null, final?:boolean, lifeMs:number}}
 */
export function hudCall(view, extra = {}) {
  if (!view) return null;
  const boxers = view.boxers || {};
  const name = (id) => boxers[id]?.name || (id === 'p1' ? 'P1' : 'P2');
  const kdTotal = (boxers.p1?.knockdowns || 0) + (boxers.p2?.knockdowns || 0);
  const round = view.round || 1;
  const maxRounds = view.maxRounds || 3;
  const C = HUD_TUNING.callMs;
  const make = (kind, text, o = {}) => ({ key: o.key || kind, kind, text, sub: o.sub ?? null, final: !!o.final, lifeMs: o.lifeMs ?? C[kind] ?? 1200 });
  const countDesc = (n) => make('count', String(n), { key: `count|${view.downed}|${kdTotal}|${n}`, lifeMs: HUD_TUNING.countMs });
  const callDesc = (c) => {
    const r = Number.isFinite(c.round) ? c.round : round;
    switch (c.call) {
      case 'round': return r >= maxRounds && maxRounds > 1
        ? make('round', 'FINAL ROUND', { key: `round|${r}`, final: true, sub: `Round ${r}`, lifeMs: C['final-round'] })
        : make('round', `ROUND ${r}`, { key: `round|${r}` });
      case 'final-round': return make('round', 'FINAL ROUND', { key: `round|${r}`, final: true, sub: `Round ${r}`, lifeMs: C['final-round'] });
      case 'fight': return make('fight', 'FIGHT!', { key: `fight|${r}|${kdTotal}|${view.tutorial ? 't' : ''}` });
      case 'down': return make('down', 'DOWN!', { key: `down|${c.boxer || view.downed}|${kdTotal}` });
      case 'ko': return make('ko', 'KO', { key: `ko|${c.winner || view.result?.winner || ''}` });
      case 'time': return make('time', 'TIME!', { key: `time|${r}` });
      case 'decision': return make('decision', 'DECISION', { key: 'decision' });
      default: return null;
    }
  };

  const hasCall = Object.prototype.hasOwnProperty.call(view, 'call') || (extra.call !== undefined && extra.call !== null);
  if (hasCall) {
    const c = view.call || extra.call || null;
    const age = Number.isFinite(c?.age) ? c.age : 0;
    const active = c && c.call && age * 1000 < (C[c.call] ?? 1200) ? c : null;
    const counting = view.phase === P.KNOCKDOWN && !!view.downed && !view.result
      && (view.stage === undefined || view.stage === null || view.stage === 'count');
    const n = counting && Number.isFinite(view.count) && view.count > 0 ? Math.min(10, Math.round(view.count)) : 0;
    if (active?.call === 'ko') return callDesc(active);
    if (n && (!active || active.call === 'down')) return countDesc(n);
    return active ? callDesc(active) : null;
  }

  // ── fallback: view.banner (game/match.js before the alignment pass) or the phase ──
  const b = view.banner;
  let kind = b ? b.kind : null;
  if (b === undefined) {
    switch (view.phase) {
      case P.ROUND_START: kind = 'round'; break;
      case P.FIGHTING: kind = (view.phaseTime ?? 99) < HUD_TUNING.fightBannerSec ? 'fight' : null; break;
      case P.KNOCKDOWN: kind = view.result ? 'ko' : view.count > 0 ? 'count' : 'knockdown'; break;
      case P.ROUND_END: kind = 'roundEnd'; break;
      case P.DECISION: kind = 'decision'; break;
      case P.RESULT: kind = view.result && (view.result.method === 'KO' || view.result.method === 'TKO') ? 'ko' : 'result'; break;
      default: kind = null;
    }
  }
  switch (kind) {
    case 'round': return callDesc({ call: 'round' });
    case 'fight': return callDesc({ call: 'fight' });
    case 'knockdown': return callDesc({ call: 'down', boxer: view.downed });
    case 'count': {
      const n = Number.isFinite(view.count) && view.count > 0 ? view.count : Number(b?.text) || 1;
      return countDesc(Math.min(10, Math.round(n)));
    }
    case 'ko': case 'tko': return callDesc({ call: 'ko', winner: view.result?.winner });
    case 'roundEnd': return callDesc({ call: 'time' });
    case 'decision': return callDesc({ call: 'decision' });
    case 'result': {
      const r = view.result;
      if (!r) return null;
      const text = r.winner ? `${name(r.winner).toUpperCase()} WINS!` : 'DRAW!';
      return make('result', text, { key: `result|${text}`, lifeMs: Infinity });
    }
    default: return null; // intro, between, getup, paused: the reference shows no text there
  }
}

/** @deprecated alias kept for older callers: the call descriptor (text/kind/key) for a view. */
export const hudBanner = hudCall;

/**
 * Win-banner text for the bout outro (Ev.RENDER_OUTRO stage 'banner').
 * @param {{winner?: 'p1'|'p2'|null}} e
 * @param {{names?: {p1?:string, p2?:string}, humanSide?: 'p1'|'p2'|null}} [o]  humanSide: single player 'p1', versus null
 * @returns {{text:string, kind:'win'|'loss'|'draw'}}
 */
export function outroBannerText(e = {}, { names = {}, humanSide = null } = {}) {
  const w = e && (e.winner === 'p1' || e.winner === 'p2') ? e.winner : null;
  if (!w) return { text: 'DRAW!', kind: 'draw' };
  if (humanSide && w === humanSide) return { text: 'YOU WIN!', kind: 'win' };
  const n = names[w] || (w === 'p1' ? 'P1' : 'P2');
  return { text: `${String(n).toUpperCase()} WINS!`, kind: humanSide ? 'loss' : 'win' };
}

/** First-bout tutorial steps, in order (ARCHITECTURE.md §6.9, research/mechanics.md §8). */
export const TUTORIAL_STEPS = Object.freeze(['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge']);

// [title, caption line 1, caption line 2] per step. The titles are our own words (RELEASE-01): only the
// six steps and their pacing come from research/mechanics.md §8, never the reference's card titles; they
// reuse the game's own vocabulary (help screen: "High guard", "Low guard", "Body shot"). The keyboard set
// names the real bindings of input/keyboard.js DEFAULT_KEYMAP.p1 (tests/unit/hudvisual-fix-text.test.mjs
// cross-checks them), including E = power punch and X = lean back.
const TUTORIAL_TEXT = Object.freeze({
  camera: {
    stance: ['Gloves up', 'Stand back so the camera sees your head, shoulders and both hands.', 'Make two fists and hold them up by your chin.'],
    // (our own words: no phrase shared with the reference's caption — hudvisual's leftover, RELEASE-01)
    'guard-head': ['High guard', 'Keep both gloves high to cover your face.', 'A high guard blocks punches to the head.'],
    'punch-head': ['Head shots', 'Throw a quick punch straight at the screen, at face height.', 'Land 3 punches on the head!'],
    'guard-body': ['Low guard', 'Hold both fists low, in front of your belly.', 'A low guard blocks punches to the body.'],
    'punch-body': ['Body shots', 'Punch from lower down, at belly height.', 'Land 3 punches to the body!'],
    // D3/D4: a back lean (and a forward tilt) dodge in bouts too, and the card counts them
    dodge: ['Slip the punch', 'Lean your head and shoulders left, right or back as a punch comes in,', 'then hit back while they’re open!'],
  },
  keyboard: {
    stance: ['Gloves up', 'J and K punch left and right. Hold E while punching for power.', 'Space and B guard. A and D lean, X leans back, S ducks.'],
    'guard-head': ['High guard', 'Hold Space to cover your face.', 'A high guard blocks punches to the head.'],
    'punch-head': ['Head shots', 'Tap J or K to punch the head.', 'Land 3 punches!'],
    // (RV-RELEASE-05: no caption repeats one of the reference's card titles either, e.g. its body-guard and body-punch cards)
    'guard-body': ['Low guard', 'Hold B to cover your belly.', 'A low guard blocks punches to the body.'],
    'punch-body': ['Body shots', 'Hold Shift and tap J or K for body shots.', 'Land 3 punches!'],
    dodge: ['Slip the punch', 'Hold A or D to lean aside, or X to lean back, as a punch comes in,', 'then hit back while they’re open!'],
  },
});

/**
 * Default title + 2-line caption for a tutorial step.
 * @param {string} step  one of TUTORIAL_STEPS
 * @param {'camera'|'keyboard'} [mode]
 * @returns {{step:string, title:string, caption:[string, string]}}
 */
export function tutorialText(step, mode = 'camera') {
  const table = TUTORIAL_TEXT[mode === 'keyboard' ? 'keyboard' : 'camera'];
  const row = table[step] || table.stance;
  return { step: table[step] ? step : 'stance', title: row[0], caption: [row[1], row[2]] };
}

/**
 * The HUD warning while the game has lost a player's hands (camera play): the tracking-lost card follows if they
 * stay out of view. `who`: the players (0/1) whose hands are lost; `names`: [P1, P2] names in versus.
 */
export function handsWarningText({ versus = false, who = [0], names = [] } = {}) {
  if (versus && who.length === 1) return `${names[who[0]] || `P${who[0] + 1}`}: please keep your hands visible`;
  return 'Please keep your hands visible';
}

/** Default "skip" hint on the tutorial caption band. */
export function tutorialSkipHint(mode = 'camera') {
  return mode === 'keyboard' ? 'Skip tutorial: Enter' : 'Skip tutorial: Enter, or pause → Skip';
}

/** Get-up hint text for the downed human. */
export function getUpHint(mode = 'camera', { versus = false, name = '' } = {}) {
  const base = mode === 'keyboard' ? 'Mash your punch keys!' : 'Pump your arms!';
  return versus && name ? `${name}: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
}

/**
 * Training popups: each lane ('opp' near the target, 'self' near the player) has a few fixed
 * slots, so texts never overlap. The same text arriving again restarts its popup in place
 * (×n), a new text takes the lowest free slot, and a full lane recycles its oldest slot.
 */
export class PopupStack {
  constructor({ slots = HUD_TUNING.popupSlots } = {}) {
    this.slots = Math.max(1, slots);
    /** @type {Array<{id:number, lane:string, slot:number, text:string, kind:string, born:number, life:number, n:number}>} */
    this.items = [];
    this._id = 0;
  }
  /**
   * @param {{text:string, kind?:string, lane?:'opp'|'self', big?:boolean}} p
   * @param {number} now  ms
   * @returns {{id:number, lane:string, slot:number, n:number, replaces:number|null, evicts:number|null}}
   */
  add(p, now) {
    this.prune(now);
    const lane = p.lane === 'self' ? 'self' : 'opp';
    const life = p.big ? HUD_TUNING.popupBigMs : HUD_TUNING.popupMs;
    const kind = p.kind || 'hit';
    const same = this.items.find((it) => it.lane === lane && it.text === p.text && it.kind === kind);
    if (same) {
      const id = ++this._id;
      const replaces = same.id;
      Object.assign(same, { id, born: now, life, n: same.n + 1 });
      return { id, lane, slot: same.slot, n: same.n, replaces, evicts: null };
    }
    const used = new Set(this.items.filter((it) => it.lane === lane).map((it) => it.slot));
    let slot = -1;
    for (let s = 0; s < this.slots; s++) if (!used.has(s)) { slot = s; break; }
    let evicts = null;
    if (slot < 0) {
      const oldest = this.items.filter((it) => it.lane === lane).sort((a, b) => a.born - b.born)[0];
      slot = oldest.slot;
      evicts = oldest.id;
      this.items.splice(this.items.indexOf(oldest), 1);
    }
    const id = ++this._id;
    this.items.push({ id, lane, slot, text: p.text, kind, born: now, life, n: 1 });
    return { id, lane, slot, n: 1, replaces: null, evicts };
  }
  /** Forget popups whose lifetime is over. */
  prune(now) { this.items = this.items.filter((it) => now - it.born < it.life); }
  clear() { this.items = []; }
}

// ───────────────────────────── DOM pieces ─────────────────────────────

/** Name plate: face icon, name, coloured underline, tracking dot. */
class NamePlate {
  constructor(side, align) {
    this.face = h('span', { class: 'gu-plate__face' });
    this.nameEl = h('span', { class: 'gu-plate__name' });
    this.dot = h('span', { class: 'gu-plate__track', hidden: true, title: 'Camera tracking' });
    this.el = h('div', { class: `gu-plate gu-plate--${side} gu-plate--${align}` },
      this.face,
      h('div', { class: 'gu-plate__main' },
        h('div', { class: 'gu-plate__row' }, this.nameEl, this.dot),
        h('span', { class: 'gu-plate__line', 'aria-hidden': 'true' })));
    this.last = { name: null, look: null, track: undefined };
  }
  set(b, tracking) {
    if (!b) return;
    const L = this.last;
    if (b.name !== L.name) { L.name = b.name; this.nameEl.textContent = b.name || ''; }
    const lookKey = b.appearance ? JSON.stringify(b.appearance) : '';
    if (lookKey !== L.look) {
      L.look = lookKey;
      clear(this.face);
      if (b.appearance) this.face.appendChild(portraits.element(b.appearance, { size: 64, framing: 'head', gloves: false, cls: 'gu-plate__img' }));
    }
    const track = tracking === undefined || tracking === null ? null : tracking;
    if (track !== L.track) {
      L.track = track;
      this.dot.hidden = track === null;
      if (track !== null) this.dot.dataset.state = track;
      this.dot.title = track === 'ok' ? 'Camera tracking: good' : track === 'weak' ? 'Camera tracking: weak' : 'Camera tracking: lost';
    }
  }
}

/** Our round clock: lamps (done / now / next) above an M:SS countdown. */
class RoundClock {
  constructor() {
    this.lamps = h('span', { class: 'gu-clock__lamps', 'aria-hidden': 'true' });
    this.time = h('span', { class: 'gu-clock__time' });
    this.el = h('div', { class: 'gu-clock', role: 'timer' }, this.lamps, this.time);
    this.last = { lamps: '', text: '' };
  }
  set(view) {
    const lamps = roundLamps(view.round, view.maxRounds);
    const lk = lamps.join(',');
    if (lk !== this.last.lamps) {
      this.last.lamps = lk;
      clear(this.lamps);
      for (const s of lamps) this.lamps.appendChild(h('span', { class: `gu-clock__lamp is-${s}` }));
      this.el.setAttribute('aria-label', `Round ${view.round || 1} of ${lamps.length}`);
    }
    const text = formatClock(view.clockDisplayMs);
    if (text !== this.last.text) { this.last.text = text; this.time.textContent = text; }
  }
}

/** One player's view of the bout (single: the whole screen; versus: one half). */
class MatchPanel {
  constructor(viewer, { versus }) {
    this.viewer = viewer;
    this.foe = other(viewer);
    this.self = new NamePlate(viewer, 'left');
    this.opp = new NamePlate(this.foe, 'right');
    this.clock = new RoundClock();
    this.live = h('div', { class: 'gu-hud__live is-hidden' }, this.self.el, this.clock.el, this.opp.el);
    this.tag = versus ? h('span', { class: `gu-hud__tag gu-hud__tag--${viewer}`, text: viewer.toUpperCase() }) : null;
    this.el = h('div', { class: `gu-hud__panel gu-hud__panel--${viewer}` }, this.tag, this.live);
    this.shown = false;
  }
  update(view, trackFor, live) {
    const b = view.boxers || {};
    this.self.set(b[this.viewer], trackFor(this.viewer));
    this.opp.set(b[this.foe], trackFor(this.foe));
    this.clock.set(view);
    if (live !== this.shown) { this.shown = live; this.live.classList.toggle('is-hidden', !live); }
  }
}

// ── our own tutorial pictograms (120×120, simple rounded figure, chunky gloves) ──
const FIG = { body: '#3d7bff', ink: '#14182b', glove: '#ff6b5a', ghost: 'rgba(61, 123, 255, 0.22)' };
function limb(points, ghost = false) {
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  return [
    svg('path', { d, fill: 'none', stroke: ghost ? 'none' : FIG.ink, 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    svg('path', { d, fill: 'none', stroke: ghost ? FIG.ghost : FIG.body, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  ];
}
function glove(x, y, r = 9, ghost = false) {
  return svg('circle', { cx: x, cy: y, r, fill: ghost ? 'rgba(255,107,90,0.25)' : FIG.glove, stroke: ghost ? 'none' : FIG.ink, 'stroke-width': 3 });
}
function frontFigure({ gl, gr, el, er, ghost = false, tilt = 0, gloveOverHead = false }) {
  const stroke = ghost ? 'none' : FIG.ink;
  const fill = ghost ? FIG.ghost : FIG.body;
  const head = svg('circle', { cx: 60, cy: 27, r: 13, fill: ghost ? FIG.ghost : '#ffd9b8', stroke, 'stroke-width': 3 });
  const parts = [
    svg('rect', { x: 47, y: 80, width: 11, height: 28, rx: 5.5, fill, stroke, 'stroke-width': 3 }),
    svg('rect', { x: 62, y: 80, width: 11, height: 28, rx: 5.5, fill, stroke, 'stroke-width': 3 }),
    svg('rect', { x: 42, y: 42, width: 36, height: 42, rx: 14, fill, stroke, 'stroke-width': 3 }),
    gloveOverHead ? head : null,
    ...limb([[47, 50], el, gl], ghost), ...limb([[73, 50], er, gr], ghost),
    gloveOverHead ? null : head,
    glove(gl[0], gl[1], 9, ghost), glove(gr[0], gr[1], 9, ghost),
  ];
  return svg('g', { transform: tilt ? `rotate(${tilt} 60 108)` : undefined }, parts);
}
function sideFigure({ high }) {
  const y = high ? 30 : 62;
  return svg('g', null,
    svg('rect', { x: 49, y: 80, width: 11, height: 28, rx: 5.5, fill: FIG.body, stroke: FIG.ink, 'stroke-width': 3 }),
    svg('rect', { x: 57, y: 80, width: 11, height: 28, rx: 5.5, fill: FIG.body, stroke: FIG.ink, 'stroke-width': 3 }),
    ...limb([[52, 50], [45, 63], [62, 44]]),
    svg('rect', { x: 42, y: 42, width: 30, height: 42, rx: 13, fill: FIG.body, stroke: FIG.ink, 'stroke-width': 3 }),
    svg('circle', { cx: 57, cy: 27, r: 13, fill: '#ffd9b8', stroke: FIG.ink, 'stroke-width': 3 }),
    svg('circle', { cx: 64, cy: 25, r: 2, fill: FIG.ink }),
    ...limb([[62, 50], [84, y + 2], [101, y]]),
    glove(62, 44), glove(103, y, 10),
    svg('path', { d: `M76 ${y - 9}h9 M72 ${y + 1}h11 M76 ${y + 11}h9`, stroke: '#ffc94a', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' }));
}
/** SVG pictogram for a tutorial step. */
export function tutorialArt(step) {
  const kids = [];
  switch (step) {
    case 'guard-head':
      kids.push(frontFigure({ gl: [53, 27], gr: [67, 27], el: [37, 56], er: [83, 56], gloveOverHead: true }));
      break;
    case 'guard-body':
      kids.push(frontFigure({ gl: [52, 64], gr: [68, 64], el: [36, 60], er: [84, 60] }));
      break;
    case 'punch-head': kids.push(sideFigure({ high: true })); break;
    case 'punch-body': kids.push(sideFigure({ high: false })); break;
    case 'dodge':
      kids.push(frontFigure({ gl: [49, 46], gr: [71, 46], el: [38, 64], er: [82, 64], ghost: true }));
      kids.push(frontFigure({ gl: [49, 46], gr: [71, 46], el: [38, 64], er: [82, 64], tilt: -17 }));
      kids.push(svg('path', { d: 'M18 30c-6 8-6 20 0 28 M14 52l4 6 6-4 M102 30c6 8 6 20 0 28 M106 52l-4 6-6-4', stroke: FIG.ink, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }));
      break;
    default: // stance
      kids.push(frontFigure({ gl: [49, 46], gr: [71, 46], el: [38, 64], er: [82, 64] }));
  }
  // tight framing per pose so the figure fills the card
  const box = step === 'punch-head' || step === 'punch-body' ? '26 6 92 104' : step === 'dodge' ? '4 2 112 108' : '16 6 88 104';
  return svg('svg', { viewBox: box, class: `gu-tut__svg gu-tut__svg--${step}`, 'aria-hidden': 'true' }, kids);
}

/** The first-bout tutorial card: framed panel (title, pictogram, pips, progress) + caption band. */
class TutorialCard {
  constructor() {
    this.titleEl = h('span', { class: 'gu-tut__title' });
    this.pips = h('span', { class: 'gu-tut__pips', 'aria-hidden': 'true' });
    this.art = h('div', { class: 'gu-tut__art' });
    this.fill = h('span', { class: 'gu-tut__fill' });
    this.check = h('span', { class: 'gu-tut__check', 'aria-hidden': 'true' }, icon('check'));
    this.card = h('div', { class: 'gu-tut__card' },
      h('div', { class: 'gu-tut__head' }, this.titleEl, this.pips),
      this.art,
      h('div', { class: 'gu-tut__progress' }, this.fill),
      this.check);
    this.line1 = h('span', { class: 'gu-tut__line' });
    this.line2 = h('span', { class: 'gu-tut__line' });
    this.skip = h('span', { class: 'gu-tut__skip' });
    this.band = h('div', { class: 'gu-tut__band' }, h('p', { class: 'gu-tut__caption' }, this.line1, this.line2), this.skip);
    this.el = h('div', { class: 'gu-tut', role: 'status', 'aria-live': 'polite' }, this.card, this.band);
    this.last = { step: null, title: '', l1: '', l2: '', pips: '', k: -1, skip: '' };
  }
  set(t) {
    const L = this.last;
    if (t.step !== L.step) {
      L.step = t.step;
      this.el.dataset.step = t.step;
      this.art.replaceChildren(tutorialArt(t.step));
      // VISUAL-12: the new card starts clean — no check mark, an empty bar. The reset is applied with the
      // card's transitions switched off (.is-resetting) for this one style change, so the previous card's
      // check never fades out and its full bar never drains on the new card.
      this.card.classList.add('is-resetting');
      this.card.classList.remove('is-complete', 'is-new');
      this.fill.style.setProperty('--k', '0');
      L.k = -1; // the progress block below re-applies has-progress / --k / is-complete for the new step
      void this.card.offsetWidth; // one reflow: applies the reset instantly and restarts the pop-in
      this.card.classList.remove('is-resetting');
      this.card.classList.add('is-new');
    }
    if (t.title !== L.title) { L.title = t.title; this.titleEl.textContent = t.title; }
    if (t.caption[0] !== L.l1) { L.l1 = t.caption[0]; this.line1.textContent = t.caption[0]; }
    if (t.caption[1] !== L.l2) { L.l2 = t.caption[1] || ''; this.line2.textContent = t.caption[1] || ''; }
    const pk = `${t.index}/${t.total}`;
    if (pk !== L.pips) {
      L.pips = pk;
      clear(this.pips);
      for (let i = 0; i < t.total; i++) this.pips.appendChild(h('span', { class: `gu-tut__pip${i < t.index ? ' is-done' : i === t.index ? ' is-now' : ''}` }));
    }
    const k = Number.isFinite(t.progress01) ? clamp01(t.progress01) : null;
    if (k !== L.k) {
      L.k = k;
      this.card.classList.toggle('has-progress', k !== null);
      this.fill.style.setProperty('--k', String(k ?? 0));
      this.card.classList.toggle('is-complete', k !== null && k >= 1);
    }
    if (t.skipHint !== L.skip) { L.skip = t.skipHint; this.skip.textContent = t.skipHint || ''; this.skip.hidden = !t.skipHint; }
  }
}

/** Text-call elements (our own typography: Lilita One, ink outline, warm fills). */
function buildCall(desc) {
  const kind = desc.kind;
  const cls = `gu-call gu-call--${kind}${desc.final ? ' is-final' : ''}`;
  switch (kind) {
    case 'round':
      return h('div', { class: cls },
        h('span', { class: 'gu-call__plate' }, h('span', { class: 'gu-call__text', text: desc.text })),
        desc.sub ? h('span', { class: 'gu-call__sub', text: desc.sub }) : null);
    case 'down':
      // two halves of the word sweep in from opposite sides and merge
      return h('div', { class: cls },
        h('span', { class: 'gu-call__word' },
          h('span', { class: 'gu-call__half gu-call__half--top', text: desc.text }),
          h('span', { class: 'gu-call__half gu-call__half--bottom', text: desc.text, 'aria-hidden': 'true' })));
    case 'ko':
      return h('div', { class: cls, 'aria-label': 'KO' },
        h('span', { class: 'gu-call__burst', 'aria-hidden': 'true' }),
        h('span', { class: 'gu-call__letter gu-call__letter--k', text: 'K' }),
        h('span', { class: 'gu-call__letter gu-call__letter--o', text: 'O' }));
    default: {
      const el = h('div', { class: cls }, h('span', { class: 'gu-call__text', text: desc.text }), desc.sub ? h('span', { class: 'gu-call__sub', text: desc.sub }) : null);
      if (kind === 'count') el.dataset.n = desc.text;
      return el;
    }
  }
}

// ───────────────────────────── Hud ─────────────────────────────

export class Hud {
  /**
   * @param {{root: HTMLElement, bus?: any, input?: any, ui?: any, video?: HTMLVideoElement, deps?: {peek:(name:string)=>any}}} o
   *        deps.peek('preview') supplies input/preview.js (injected by UI so this module stays Node-importable)
   */
  constructor({ root, bus, input, ui, video, deps } = {}) {
    this.deps = deps || null;
    this.root = root;
    this.bus = bus || null;
    this.input = input || null;
    this.ui = ui || null;
    this.video = video || null;
    this.el = h('div', { class: 'gu-hud', hidden: true });
    // The outro layer is separate from the HUD so the win banner / Replay tag survive hud.hide().
    this.outroEl = h('div', { class: 'gu-outro', 'aria-live': 'polite' });
    this.root?.append(this.el, this.outroEl);
    this.kind = null;
    this.mode = 'single';
    this.visible = false;
    this._pipEnabled = true;
    this._pipLarge = false;
    this._mirror = true;
    this._offs = [];
    this._tracking = [null, null];
    this._getUpFallback = 0;
    this._lastT = 0;
    this._pipLast = 0;
    this._call = null;
    this._callKey = null;
    this._eventCall = null;
    this._names = { p1: 'P1', p2: 'P2' };
    this._humanSide = 'p1';
    this._tutorial = null;      // {explicit:boolean, state}
    this._sawViewTutorial = false;
    this._outro = { active: false, banner: null, replay: null, timer: 0 };
    this._popups = new PopupStack();
    // Outro + calls are bus-driven even while the HUD is hidden between screens.
    this._permOffs = [];
    if (this.bus?.on) {
      if (Ev.RENDER_OUTRO) this._permOffs.push(this.bus.on(Ev.RENDER_OUTRO, (e) => this.outroStage(e)));
      if (Ev.MATCH_CALL) this._permOffs.push(this.bus.on(Ev.MATCH_CALL, (e) => { if (e?.call) this._eventCall = { ...e, at: performance.now() }; }));
    }
  }

  /**
   * Build the HUD for a match or a training activity.
   * @param {'match'|'training'} kind
   * @param {{mode?:'single'|'versus', training?:string, participant?:{name:string, appearance?:object}, turn?:number, turns?:number}} [opts]
   */
  show(kind = 'match', opts = {}) {
    this._unbind();
    clear(this.el);
    this.kind = kind;
    this.mode = opts.mode === 'versus' ? 'versus' : 'single';
    this.opts = opts;
    this._tracking = [null, null];
    this._call = null;
    this._callKey = null;
    this._eventCall = null;
    this._getUpFallback = 0;
    this._lastT = performance.now();
    this._popups.clear();
    this.el.className = `gu-hud gu-hud--${kind} gu-hud--${this.mode}${this._outro.active ? ' is-outro' : ''}`;
    this.calls = h('div', { class: 'gu-hud__calls', role: 'status', 'aria-live': 'assertive' });
    this.getUp = h('div', { class: 'gu-getup', hidden: true },
      h('span', { class: 'gu-getup__hint' }),
      h('span', { class: 'gu-getup__bar' }, h('span', { class: 'gu-getup__fill' })));
    this.handsWarn = h('div', { class: 'gu-handswarn', role: 'status', hidden: true }, icon('glove'), h('span', { class: 'gu-handswarn__text' }));
    this.tutHost = h('div', { class: 'gu-hud__tutorial' });
    this.pip = h('div', { class: `gu-hud__pip${this._pipLarge ? ' is-large' : ''}`, hidden: true }, h('canvas', { class: 'gu-hud__pipcanvas' }));
    if (kind === 'training') this._buildTraining(opts);
    else this._buildMatch();
    this.el.append(this.getUp, this.calls, this.tutHost, this.pip, this.handsWarn);
    this._bind();
    this.el.hidden = false;
    this.visible = true;
    if (this._tutorial && kind === 'match') this._renderTutorial();
  }

  hide() {
    this._unbind();
    this.el.hidden = true;
    this.visible = false;
    clear(this.el);
    this.kind = null;
    this._call = null;
    this._callKey = null;
    this._tutorial = null;
    this._tutCard = null;
    this._sawViewTutorial = false;
  }

  /** Webcam PiP on/off (settings.showSkeleton). */
  setPip(on) { this._pipEnabled = !!on; if (this.pip && !on) this.pip.hidden = true; }
  /** A bigger webcam PiP (settings.pipLarge; handy when recording a demo). */
  setPipLarge(on) { this._pipLarge = !!on; this.pip?.classList?.toggle('is-large', this._pipLarge); }
  setMirror(on) { this._mirror = !!on; }
  /** Reduced motion (CSS does the work; kept for API compatibility). */
  setReducedMotion(on) { this._reduced = !!on; }

  /** Per-player tracking: [{tracked, confidence}] or booleans. */
  setTracking(list) {
    if (!Array.isArray(list)) return;
    list.forEach((t, i) => {
      const tracked = typeof t === 'object' && t ? t.tracked : t;
      const conf = typeof t === 'object' && t ? t.confidence : undefined;
      this._tracking[i] = tracked === false ? 'lost' : Number.isFinite(conf) && conf < 0.55 ? 'weak' : tracked === true ? 'ok' : this._tracking[i];
    });
  }

  /** Show a call manually (app-level messages), e.g. hud.banner('FIGHT!', {kind:'fight', ms:900}). */
  banner(text, { sub = null, kind = 'round', ms = 1600 } = {}) {
    if (!this.visible) return;
    this._syncCall({ key: `manual|${text}|${performance.now()}`, kind, text, sub, lifeMs: ms }, performance.now());
  }

  /**
   * First-bout tutorial card (ARCHITECTURE.md §6.9). Call on every step change (or every frame —
   * it updates in place). Missing title/caption use tutorialText(step, mode).
   * @param {{step:string, index?:number, total?:number, title?:string, caption?:string|string[], progress01?:number,
   *          mode?:'camera'|'keyboard', skipHint?:string|null}} t
   */
  showTutorial(t = {}) {
    this._tutorial = { explicit: true, state: this._tutorialState(t) };
    this._renderTutorial();
  }

  hideTutorial() {
    this._tutorial = null;
    if (this._tutCard) {
      const el = this._tutCard.el;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), HUD_TUNING.callOutMs);
      this._tutCard = null;
    }
  }

  /**
   * Bout outro progress (Ev.RENDER_OUTRO {stage, winner, method}); the HUD subscribes itself, this
   * is public for pages that drive it directly.
   */
  outroStage(e) {
    const stage = e?.stage;
    const O = this._outro;
    switch (stage) {
      case 'start':
        O.active = true;
        break;
      case 'wipe':
        O.active = true;
        this._clearCalls();
        break;
      case 'replay':
        O.active = true;
        this._clearCalls();
        this._setReplay(true);
        break;
      case 'flash':
        this._setReplay(false);
        this._clearCalls();
        break;
      case 'banner':
        O.active = true;
        this._setReplay(false);
        this._clearCalls();
        this._showWinBanner(e);
        break;
      case 'winner':
        this._hideWinBanner();
        break;
      case 'end':
        this.clearOutro();
        break;
      default:
    }
    this._syncOutroClass();
  }

  /** Remove the outro banner / Replay tag (ui.show() of a menu screen calls this). */
  clearOutro() {
    const O = this._outro;
    clearTimeout(O.timer);
    O.active = false;
    O.banner = null;
    O.replay = null;
    this._syncOutroClass();
    for (const el of [...this.outroEl.children]) {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), HUD_TUNING.callOutMs);
    }
  }

  /**
   * FLOWS-05: the outro is one full-screen view (GameRenderer drops the split while outroActive), so the
   * HUD root carries .is-outro for the whole outro and the CSS hides the versus divider and P1/P2 tags.
   */
  _syncOutroClass() {
    this.el.classList.toggle('is-outro', !!this._outro.active);
  }

  /**
   * Per-frame match update.
   * @param {import('../core/types.js').MatchView} view
   * @param {{tracking?: boolean[], confidence?: number[], activity?: number[]}} [extras]
   */
  update(view, extras = {}) {
    if (!view) return;
    if (!this.visible) {
      // Forgiving: the first update after ui.hide() brings the HUD back (but never over a menu screen).
      if (this.ui?.menuOpen) return;
      this.show('match', { ...(this.opts || {}), mode: view.mode === 'versus' ? 'versus' : 'single' });
    }
    if (this.kind !== 'match' || (view.mode === 'versus') !== (this.mode === 'versus')) this.show('match', { ...this.opts, mode: view.mode === 'versus' ? 'versus' : 'single' });
    const now = performance.now();
    const dtMs = Math.min(100, Math.max(0, now - this._lastT));
    this._lastT = now;
    this._status = this.input?.status || null;
    if (extras.tracking) this.setTracking(extras.tracking.map((tr, i) => ({ tracked: tr, confidence: extras.confidence?.[i] })));
    else if (this._status?.tracking && this._status.mode === 'camera') this.setTracking(this._status.tracking);
    const trackFor = (id) => (view.boxers?.[id]?.isHuman === false ? null : this._tracking[id === 'p1' ? 0 : 1]);
    this._names = { p1: view.boxers?.p1?.name || 'P1', p2: view.boxers?.p2?.name || 'P2' };
    this._humanSide = view.mode === 'versus' ? null : 'p1';
    if (this._outro.active && !view.result) this.clearOutro(); // a new, undecided bout: the old outro is over
    const live = clockVisibleFor(view) && !this._outro.active;
    for (const p of this.panels) p.update(view, trackFor, live);
    this._syncCall(this._callFor(view, now), now);
    this._updateGetUp(view, extras, dtMs);
    this._updateHandsWarning(extras);
    this._autoTutorial(view);
    this._drawPip(now, view.mode === 'versus' ? 2 : 1);
  }

  /**
   * Per-frame training update.
   * @param {{kind:string, phase:'ready'|'active'|'done', timeLeftMs:number, readyLeftMs?:number, score:number, combo:number, popups?:Array<{id?:number, text:string, kind:string, age:number}>}} view
   */
  updateTraining(view, extras = {}) {
    if (!view) return;
    if (!this.visible && this.ui?.menuOpen) return;
    if (this.kind !== 'training' || !this.visible) this.show('training', { ...(this.opts || {}), training: view.kind });
    this._status = this.input?.status || null;
    const now = performance.now();
    this._lastT = now;
    const T = this.t;
    if (view.kind && view.kind !== T.kindShown) {
      T.kindShown = view.kind;
      T.title.textContent = (TRAINING_INFO[view.kind]?.title || 'Training').toUpperCase();
      T.icon.replaceChildren(icon(TRAINING_INFO[view.kind]?.icon || 'target'));
    }
    const timeText = formatClock(view.timeLeftMs);
    if (timeText !== T.lastTime) { T.lastTime = timeText; T.time.textContent = timeText; }
    T.timeBox.classList.toggle('is-low', view.phase === 'active' && view.timeLeftMs < 5000);
    const score = Math.round(view.score || 0);
    if (score !== T.lastScore) {
      const up = score > T.lastScore;
      T.lastScore = score;
      T.score.textContent = formatNumber(score);
      if (up) { T.scoreBox.classList.remove('is-bump'); void T.scoreBox.offsetWidth; T.scoreBox.classList.add('is-bump'); }
    }
    const combo = Math.round(view.combo || 0);
    if (combo !== T.lastCombo) {
      T.lastCombo = combo;
      T.combo.hidden = combo < 2;
      T.combo.textContent = combo >= 2 ? `×${combo} STREAK` : '';
      if (combo >= 2) { T.combo.classList.remove('is-bump'); void T.combo.offsetWidth; T.combo.classList.add('is-bump'); }
    }
    // popups: new ones only (by id when the activity provides one, else by text + kind + birth time)
    const nowS = now / 1000;
    for (const p of view.popups || []) {
      if (!p || !p.text || !(p.age <= HUD_TUNING.trainingPopupMaxAge)) continue;
      const born = nowS - (p.age || 0);
      if (p.id != null) {
        if (T.seenIds.has(p.id)) continue;
        T.seenIds.add(p.id);
      } else {
        if (T.seen.some((s) => s.text === p.text && s.kind === p.kind && Math.abs(s.born - born) < 0.35)) continue;
        T.seen.push({ text: p.text, kind: p.kind, born });
      }
      const k = String(p.kind || '');
      this._trainingPopup({ text: p.text, kind: trainingPopupKind(k), lane: /penalty|bad|trainer|ouch|hurt/i.test(k) ? 'self' : 'opp', big: /big|bonus|break|perfect/i.test(k) }, now);
    }
    T.seen = T.seen.filter((s) => nowS - s.born < 3);
    if (T.seenIds.size > 200) T.seenIds = new Set([...T.seenIds].slice(-100));
    // phase calls: READY? → 3, 2, 1 → GO! → … → TIME!/FINISH!
    const prev = T.phase;
    if (view.phase === 'ready') {
      const left = Number.isFinite(view.readyLeftMs) ? Math.ceil(view.readyLeftMs / 1000) : null;
      if (left !== null && left >= 1 && left <= 3) this._syncCall({ key: `t-count|${left}|${T.round}`, kind: 'count', text: String(left), lifeMs: 900 }, now);
      else if (prev !== 'ready') this._syncCall({ key: `t-ready|${T.round}`, kind: 'ready', text: 'READY?', sub: TRAINING_INFO[view.kind]?.rule || null, lifeMs: Infinity }, now);
    } else if (view.phase === 'active' && prev !== 'active') {
      if (prev) this._syncCall({ key: `t-go|${now}`, kind: 'fight', text: 'GO!', lifeMs: HUD_TUNING.goBannerMs }, now);
      else this._syncCall(null, now);
    } else if (view.phase === 'done' && prev !== 'done') {
      this._syncCall({ key: `t-done|${now}`, kind: 'time', text: view.timeLeftMs > 50 ? 'FINISH!' : 'TIME!', sub: `${formatNumber(score)} points`, lifeMs: Infinity }, now);
    } else if (this._call && now - this._call.born > this._call.life) {
      this._exitCall();
    }
    if (view.phase !== prev) {
      if (view.phase === 'ready' && prev) T.round++;
      T.phase = view.phase;
    }
    if (extras.tracking) this.setTracking(extras.tracking);
    this._updateHandsWarning(extras);
    this._drawPip(now, 1);
  }

  /** "Please keep your hands visible" while extras.handsWarning flags a player (app.js _hudExtras). */
  _updateHandsWarning(extras) {
    const el = this.handsWarn;
    if (!el) return;
    const who = (Array.isArray(extras?.handsWarning) ? extras.handsWarning : []).map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    const show = who.length > 0;
    if (el.hidden === show) el.hidden = !show;
    if (!show) return;
    const txt = handsWarningText({ versus: this.mode === 'versus', who, names: [this._names?.p1, this._names?.p2] });
    const span = el.lastElementChild;
    if (span && span.textContent !== txt) span.textContent = txt;
  }

  dispose() {
    this._unbind();
    for (const off of this._permOffs.splice(0)) { try { off?.(); } catch { /* ignore */ } }
    clearTimeout(this._outro.timer);
    this.el.remove();
    this.outroEl.remove();
  }

  // ───────────────────────────── internals ─────────────────────────────

  _buildMatch() {
    const versus = this.mode === 'versus';
    this.panels = versus ? [new MatchPanel('p1', { versus }), new MatchPanel('p2', { versus })] : [new MatchPanel('p1', { versus })];
    const wrap = h('div', { class: 'gu-hud__panels' }, this.panels.map((p) => p.el));
    if (versus) wrap.appendChild(h('div', { class: 'gu-hud__divider', 'aria-hidden': 'true' }));
    this.el.appendChild(wrap);
  }

  _buildTraining(opts) {
    const part = opts.participant || null;
    const title = h('span', { class: 'gu-thud__title' });
    const ic = h('span', { class: 'gu-thud__icon' });
    const time = h('span', { class: 'gu-thud__time', text: '0:00' });
    const score = h('span', { class: 'gu-thud__score', text: '0' });
    const combo = h('span', { class: 'gu-thud__combo', hidden: true });
    const timeBox = h('div', { class: 'gu-thud__timebox' }, h('span', { class: 'gu-thud__activity' }, ic, title), time);
    const scoreBox = h('div', { class: 'gu-thud__scorebox' }, h('span', { class: 'gu-thud__lbl', text: 'SCORE' }), score, combo);
    const who = part ? h('div', { class: 'gu-thud__who' },
      part.appearance ? h('span', { class: 'gu-plate__face gu-thud__portrait' }, portraits.element(part.appearance, { size: 64, framing: 'head', gloves: false, cls: 'gu-plate__img' })) : null,
      h('div', { class: 'gu-thud__whotext' }, h('span', { class: 'gu-thud__name', text: part.name || 'Player' }),
        Number.isFinite(opts.turns) && opts.turns > 1 ? h('span', { class: 'gu-thud__turn', text: `Turn ${(opts.turn ?? 0) + 1} of ${opts.turns}` }) : null)) : h('span');
    const popups = h('div', { class: 'gu-hud__popups', 'aria-hidden': 'true' });
    const panelEl = h('div', { class: 'gu-hud__panel' }, h('div', { class: 'gu-thud__top' }, who, timeBox, scoreBox), popups);
    this.panels = [];
    this.t = { title, icon: ic, time, timeBox, score, scoreBox, combo, popups, popEls: new Map(), seen: [], seenIds: new Set(), round: 0, lastScore: 0, lastCombo: 0, lastTime: '', phase: null, kindShown: null };
    if (opts.training) {
      this.t.kindShown = opts.training;
      title.textContent = (TRAINING_INFO[opts.training]?.title || 'Training').toUpperCase();
      ic.replaceChildren(icon(TRAINING_INFO[opts.training]?.icon || 'target'));
    }
    this.el.appendChild(h('div', { class: 'gu-hud__panels' }, panelEl));
  }

  /** Training popup placed by the PopupStack (fixed slots: no overlapping texts). */
  _trainingPopup(p, now) {
    const T = this.t;
    if (!T) return;
    const r = this._popups.add(p, now);
    const kill = (id) => {
      const el = T.popEls.get(id);
      if (el) { el.remove(); T.popEls.delete(id); }
    };
    if (r.replaces != null) kill(r.replaces);
    if (r.evicts != null) kill(r.evicts);
    const text = r.n > 1 ? `${p.text} ×${r.n}` : p.text;
    const el = h('div', { class: `gu-popup gu-popup--${p.kind}${p.big ? ' gu-popup--big' : ''} gu-popup--${r.lane}`, vars: { '--slot': r.slot } }, text);
    T.popups.appendChild(el);
    T.popEls.set(r.id, el);
    const ms = p.big ? HUD_TUNING.popupBigMs : HUD_TUNING.popupMs;
    setTimeout(() => { if (T.popEls.get(r.id) === el) kill(r.id); }, ms + 60);
  }

  _bind() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => { if (ev) this._offs.push(bus.on(ev, fn)); };
    on(Ev.MATCH_KNOCKDOWN, () => { this._getUpFallback = 0; });
    on(Ev.INPUT_PUNCH, () => { this._getUpFallback = Math.min(1, this._getUpFallback + HUD_TUNING.getUpPerPunch); });
    on(Ev.INPUT_TRACKING_LOST, (e) => { const i = e?.player === 1 ? 1 : 0; this._tracking[i] = 'lost'; });
    on(Ev.INPUT_TRACKING_FOUND, (e) => { const i = e?.player === 1 ? 1 : 0; this._tracking[i] = 'ok'; });
  }

  _unbind() {
    for (const off of this._offs.splice(0)) { try { off?.(); } catch { /* ignore */ } }
  }

  /** The call for this frame: view.call/view.count, or the last Ev.MATCH_CALL when the view lacks `call`. */
  _callFor(view, now) {
    let extra;
    if (!Object.prototype.hasOwnProperty.call(view, 'call') && this._eventCall) {
      const e = this._eventCall;
      extra = { call: { ...e, age: (now - e.at) / 1000 } };
    }
    const desc = hudCall(view, extra);
    if (desc && desc.kind === 'result' && this._outro.active) return null; // the outro banner speaks
    return desc;
  }

  /** Show `desc` (pops when its key changes) and retire the current call when its life is over. */
  _syncCall(desc, now) {
    if (!desc) {
      if (this._call) this._exitCall();
      this._callKey = null;
      return;
    }
    if (desc.key !== this._callKey) {
      // a new call cuts the previous one at once (hard cut: no overlap with a fading "Round N" / "Down!")
      this._exitCall(true);
      this._callKey = desc.key;
      if (!this.calls) return;
      for (const old of [...this.calls.querySelectorAll('.gu-call.is-out')]) old.remove();
      const el = buildCall(desc);
      this.calls.appendChild(el);
      this._call = { el, born: now, life: desc.lifeMs ?? 1200 };
      while (this.calls.children.length > 4) this.calls.firstElementChild.remove();
      return;
    }
    if (this._call && now - this._call.born > this._call.life) this._exitCall();
  }

  _exitCall(cut = false) {
    const c = this._call;
    this._call = null;
    if (!c) return;
    if (cut) { c.el.remove(); return; }
    c.el.classList.add('is-out');
    setTimeout(() => c.el.remove(), HUD_TUNING.callOutMs);
  }

  _clearCalls() {
    this._exitCall();
    if (this.calls) for (const el of [...this.calls.children]) { el.classList.add('is-out'); setTimeout(() => el.remove(), HUD_TUNING.callOutMs); }
  }

  _updateGetUp(view, extras, dtMs) {
    const downedId = view.downed;
    const downed = view.phase === P.KNOCKDOWN && downedId && !view.result ? view.boxers?.[downedId] : null;
    let value = null;
    if (downed && downed.isHuman !== false) {
      const idx = downedId === 'p2' ? 1 : 0;
      if (Number.isFinite(view.getUp01)) value = view.getUp01;
      else if (Number.isFinite(downed.getUp01)) value = downed.getUp01;
      else if (Number.isFinite(extras.activity?.[idx])) value = extras.activity[idx];
      else {
        this._getUpFallback = Math.max(0, this._getUpFallback - (HUD_TUNING.getUpDecayPerSec * dtMs) / 1000);
        value = this._getUpFallback;
      }
    }
    const counting = view.stage === 'count' || view.stage === 'down-call' || (view.stage == null && view.count > 0);
    const show = value !== null && counting;
    if (this.getUp.hidden === show) this.getUp.hidden = !show;
    if (!show) return;
    const k = clamp01(value);
    this.getUp.style.setProperty('--k', k.toFixed(3));
    this.getUp.classList.toggle('is-full', k >= 1);
    this.getUp.classList.toggle('is-versus', this.mode === 'versus');
    this.getUp.dataset.side = downedId;
    const hint = this.getUp.firstElementChild;
    const txt = getUpHint(this._inputMode(), { versus: this.mode === 'versus', name: downed?.name });
    if (hint.textContent !== txt) hint.textContent = txt;
  }

  _inputMode() {
    const m = this._status?.mode || this.input?.status?.mode || this.input?.mode;
    return m === 'keyboard' ? 'keyboard' : 'camera';
  }

  _tutorialState(t) {
    const step = TUTORIAL_STEPS.includes(t.step) ? t.step : 'stance';
    const mode = t.mode === 'keyboard' || t.mode === 'camera' ? t.mode : this._inputMode();
    const def = tutorialText(step, mode);
    const total = Number.isFinite(t.total) && t.total > 0 ? Math.round(t.total) : TUTORIAL_STEPS.length;
    const index = Number.isFinite(t.index) ? Math.max(0, Math.min(total - 1, Math.round(t.index))) : Math.max(0, TUTORIAL_STEPS.indexOf(step));
    let caption = def.caption;
    if (Array.isArray(t.caption)) caption = [String(t.caption[0] ?? ''), String(t.caption[1] ?? '')];
    else if (typeof t.caption === 'string' && t.caption) {
      const parts = t.caption.split('\n');
      caption = [parts[0], parts.slice(1).join(' ')];
    }
    return {
      step, index, total, title: t.title || def.title, caption,
      progress01: Number.isFinite(t.progress01) ? t.progress01 : null,
      skipHint: t.skipHint === null ? '' : (t.skipHint || tutorialSkipHint(mode)),
    };
  }

  _renderTutorial() {
    if (!this._tutorial || !this.tutHost || this.kind !== 'match') return;
    if (!this._tutCard) {
      this._tutCard = new TutorialCard();
      this.tutHost.appendChild(this._tutCard.el);
    }
    this._tutCard.set(this._tutorial.state);
  }

  /** view.tutorial (Match in tutorial mode) shows the default card when nobody calls showTutorial(). */
  _autoTutorial(view) {
    const vt = view.tutorial;
    if (vt && vt.step) {
      this._sawViewTutorial = true;
      if (!this._tutorial || !this._tutorial.explicit) {
        const prev = this._tutorial?.state;
        const next = this._tutorialState({ step: vt.step, index: vt.index, total: vt.total, progress01: tutorialProgress(vt) ?? undefined });
        if (!prev || prev.step !== next.step || prev.progress01 !== next.progress01 || prev.index !== next.index) {
          this._tutorial = { explicit: false, state: next };
          this._renderTutorial();
        }
      }
    } else if (this._sawViewTutorial && Object.prototype.hasOwnProperty.call(view, 'tutorial')) {
      // the match left tutorial mode ("Fight!"): close the card whoever opened it
      this._sawViewTutorial = false;
      if (this._tutorial) this.hideTutorial();
    }
  }

  _setReplay(on) {
    const O = this._outro;
    if (on && !O.replay) {
      // Our own replay marker (VISUAL-08 / RELEASE-06): a round coral badge whose replay arrow turns, then
      // the word, in our dark pill at the bottom left (research/mechanics.md §5 measures only "a Replay tag
      // at the bottom left"). No play-triangle prefix.
      O.replay = h('div', { class: 'gu-replay' },
        h('span', { class: 'gu-replay__mark', 'aria-hidden': 'true' }, icon('restart')),
        h('span', { class: 'gu-replay__text', text: 'Replay' }));
      this.outroEl.appendChild(O.replay);
    } else if (!on && O.replay) {
      const el = O.replay;
      O.replay = null;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), HUD_TUNING.callOutMs);
    }
  }

  _showWinBanner(e) {
    const O = this._outro;
    this._hideWinBanner();
    const t = outroBannerText(e, { names: this._names, humanSide: this._humanSide });
    O.banner = h('div', { class: `gu-win gu-win--${t.kind}` },
      h('span', { class: 'gu-win__band', 'aria-hidden': 'true' }),
      h('span', { class: 'gu-win__streak', 'aria-hidden': 'true' }),
      h('span', { class: 'gu-win__text', text: t.text, vars: { '--len': Math.max(8, t.text.length) } }));
    this.outroEl.appendChild(O.banner);
    clearTimeout(O.timer);
    O.timer = setTimeout(() => this._hideWinBanner(), HUD_TUNING.winBannerMaxMs);
  }

  _hideWinBanner() {
    const O = this._outro;
    clearTimeout(O.timer);
    if (!O.banner) return;
    const el = O.banner;
    O.banner = null;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), HUD_TUNING.callOutMs + 200);
  }

  _drawPip(now, players) {
    const status = this._status;
    const camera = !status || status.mode !== 'keyboard';
    const want = this._pipEnabled && camera && !this._outro.active && !!(this.ui?.latestFrame?.() || this.ui?.getVideo?.());
    if (this.pip.hidden === want) this.pip.hidden = !want;
    if (!want || now - this._pipLast < 1000 / HUD_TUNING.pipFps) return;
    this._pipLast = now;
    const canvas = this.pip.firstElementChild;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr)), hgt = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const video = this.ui?.getVideo?.() || this.video;
    const frame = this.ui?.latestFrame?.() || null;
    const mod = this.deps?.peek?.('preview') || null;
    try {
      if (mod?.drawPreview) mod.drawPreview(ctx, video, frame, { mirrored: this._mirror, players, highlight: true, labels: players > 1, dim: 0.1 });
      else drawFallbackPreview(ctx, video, frame, { mirrored: this._mirror });
    } catch {
      drawFallbackPreview(ctx, video, frame, { mirrored: this._mirror });
    }
  }
}

function trainingPopupKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (/penalty|bad|trainer|hurt|ouch/.test(k)) return 'bad';
  if (/miss/.test(k)) return 'miss';
  if (/bonus|break|perfect|big/.test(k)) return 'counter';
  if (/dodge|good|ok/.test(k)) return 'good';
  return 'hit';
}
