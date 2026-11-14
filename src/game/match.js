// Match state machine: rounds, clock, stages and text calls, knockdowns, counts, get-ups, the dodge
// slow motion, the first-bout tutorial, judges, the one result. Pure logic (no DOM; runs in Node and
// in dev/sim.mjs). Rules and timings follow research/mechanics.md (sections cited as §n) and
// ARCHITECTURE.md §6.1, §6.3, §6.4, §6.9.
//
// Spec coverage: MAT01 (up to three rounds, a KO ends the bout at once, else a decision), MAT02
// (landed punches accumulate damage; a clean hit on an empty pie → knockdown, separate from a
// bout-ending KO), MAT03 (the count runs to 10; still down at "10" loses; rising continues the
// bout), MAT04 (the result is resolved exactly once and nothing afterwards changes it), COM05/COM06
// via combat.js, pause that restores the exact prior state.
//
// PHASES and their STAGES (view.stage / view.stageTime; ARCHITECTURE §6.4):
//   INTRO        'arena' (~1 s establishing shot; the VS card before it is a UI screen)
//   [tutorial]   FIGHTING with stage = the tutorial step (rules.tutorial; see below)
//   ROUND_START  'banner' (call 'round' / 'final-round') → 'flyin' → 'ring' → 'fight' (call 'fight' +
//                MATCH_BELL start) → the clock starts 0.5–1.3 s later = FIGHTING. Intro → first tick ≈ 5.5–6.7 s.
//   FIGHTING     'live' — the clock runs (1 game-s per 0.333 s: 3:00 in 60 s of live time, §1.1).
//   KNOCKDOWN    'fall' (the clock keeps running until the stoppage hides it, §1.4)
//                → 'down-call' (call 'down', 0–0.7 game-s after the blow: the renderer's 0.7 s knockdown
//                hit-stop comes first, so 0.7–1.4 s real, median ≈ 0.9 s, §3.1) → 'count' (first number
//                0.75–1.5 s after "Down", then one every 1.08 s) → rise 0.3–0.5 s after a number →
//                RECOVERY; or "10" → 'ko-call' 1–2 s later (call 'ko' + MATCH_KO) → 'ko-hold' → RESULT.
//   RECOVERY     'rise' (get-up anim) → 'standoff' (3.3–5.7 s after rising) → 'fight' (call 'fight' +
//                bell) → the clock restarts 0.5–1.3 s later. Total stoppage ≈ 8.1 s + 0.92 s × count (§3.1).
//   ROUND_END    'bell' (0:00; punches already in flight still land; final round: call 'time') →
//                'hold' (~1.6 s, fighters drop their guard) → BETWEEN or DECISION.
//   BETWEEN      'arena' (wide shot, no top-up) → next ROUND_START. Break 7.65–9.45 s, median ≈ 8.5 (§1.2: 7.8–10).
//   DECISION     'decision' (call 'decision' + MATCH_DECISION) → RESULT (never observed: kept quick).
//   RESULT       'result' — MATCH_RESULT once. Integration then plays the renderer outro.
//   PAUSED       from any phase; resume() restores it exactly.
// view.clockVisible is true only while the clock is meant to be on screen (live, the fall until the
// stoppage, the round-end bell). view.call mirrors the latest Ev.MATCH_CALL (with its age in s).
//
// RULES (§2.6–§3.6): health in wedges, no regeneration / top-up / chip; a 4th knockdown always stays
// down; refill on rising = 10 − 2 × knockdown number; no TKO (ResultMethod.TKO is never produced);
// the clock never cuts a count short; no saved-by-the-bell (a fighter who rises with 0:00 left goes
// straight to the round-end bell). Human get-up: a punch-pump meter (5 / 7 / 9 punch events for
// knockdowns 1 / 2 / 3; pumping the arms — ControlState.activity ≥ 0.3 — fills it too, up to 2.5
// punches a second), earliest rise at counts 4 / 5 / 7, KO if it isn't full before "10"
// (view.getUp01). Opponents: stay-down roll per knockdown number, else rise at
// round(normal(mean, 1.2)) clamped 3–9 (roster stayDown / riseMean).
//
// DODGE SLOW MOTION (§2.5, ARCHITECTURE §6.3): when a HUMAN dodges an AI punch with a FRESH dodge (the posture
// entered within COMBAT.freshDodgeMs of the deciding sample, or after the punch's wind-up began — decision R2; a
// posture held longer still evades but earns neither the slow motion nor the counter window, and the glove it made
// miss is no counter chance either: Boxer.midPunchFor skips a punch marked heldDodge; the same for a dodge made while
// bobbing — dipping into postures with no attack coming, COMBAT.freshDodgeBob*, _bobbing, R10), Ev.MATCH_SLOWMO
// fires and for slowmo.durationMs the WORLD runs at ×slowmo.scale: the AI corner's body, brain and
// punches and the round clock live on `wt` (world time), the human on `t` (real match time), so the
// dodging player stays real-time. The window ends early when their counter lands. Cross-clock
// references (the AI reading the human, AI punches judged against the human's camera samples) are
// converted through a piecewise-linear time map. In versus (two humans) there is no slow motion at
// all (a human's own inputs are never slowed); the post-dodge counter window still applies.
//
// LATENCY (§4.6): an AI punch against a human is judged on the human's pose at impact, read from
// camera samples `latencyMs` later (option, default 100 ms; integration passes calibration.latencyMs).
// Power-punch tells are never shorter than 0.55 s + latencyMs.
//
// TUTORIAL (§8, ARCHITECTURE §6.9): rules.tutorial = true runs six live steps after the intro
// ('stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge') with no clock, no damage
// and no knockdowns, a scripted opponent per step (ai.js SCRIPT). setTutorialStep(step) switches
// step, endTutorial() → "Fight!" → round 1 goes live. If nobody drives it, each step ends after
// tutorialStepMaxMs on its own (fallback only).
//
// Simultaneous events: impacts resolve strictly in contact order (ties: p1 first). A knockdown
// interrupts the exchange — every other punch in flight is cancelled, so there is never a double
// knockdown (§2.3 "trade": only one knockdown is resolved).

import { Ev, MatchPhase, ResultMethod } from '../core/types.js';
import { Boxer } from './boxer.js';
import { COMBAT, resolvePunch, guardFor } from './combat.js';
import { OpponentAI } from './ai.js';
import { ROSTER, opponentById } from './roster.js';
import { toRng } from '../core/rng.js';

/** Match rules and timings (ms unless noted). Override any subset via `new Match({rules})`.
 *  A timing may be a number, [min, max] (uniform) or [min, max, mode] (triangular), drawn per use (seeded). */
export const RULES = Object.freeze({
  rounds: 3,
  roundRealMs: 60000,            // live time per round: 3:00 at 1 game-s per 0.333 s (§1.1)
  clockDisplayMs: 180000,        // what the round clock shows at the start (3:00)
  countIntervalMs: 1080,         // one number every 1.08 s (§3.1)
  countTo: 10,
  knockdownsForKo: 4,            // the 4th knockdown in a bout always stays down (§3.4)
  // presentation timeline (§1.2, §3.1)
  introArenaMs: 1000,            // establishing shot after the VS card
  bannerMs: [2000, 2500],        // "Round N" banner (spoken round call at its start)
  flyinMs: [1000, 1250],         // camera flies into the ring …
  ringMs: [550, 800],            // … ring-level shot of both fighters (fly-in + ring: 1.5–2 s)
  fightToClockMs: [500, 1300, 750], // "Fight!" + bell → the clock runs (median ≈ 0.8 s)
  fightTextMs: 900,              // view.banner shows "Fight!" this long after the call
  roundEndBellMs: 600,           // bell at 0:00, the clock still on screen
  roundEndHoldMs: 1700,          // fighters drop their guard and hold, HUD hidden (~1.5 s)
  betweenArenaMs: 1100,          // wide arena shot before the next round's banner (break 0:00 → clock 7.65–9.45 s)
  downCallMs: [0, 700, 100],     // knockdown blow → "Down" in GAME ms; the fall plays meanwhile. The renderer
                                 // stalls the game 0.7 s on the blow first (§2.8), so "Down" comes 0.69–1.39 s
                                 // after the blow in real time, median ≈ 0.93 s (§3.1: 0.4–1.8 s, median ≈ 0.9)
  fallClockMs: [0, 1300],        // the clock keeps running this long into the fall (capped by the fall itself)
  firstNumberMs: [750, 1500, 1250], // "Down" → "1"
  riseDelayMs: [300, 500],       // a number → rising
  getUpAnimMs: 1200,             // RECOVERY 'rise' stage
  standoffMs: [3300, 5700, 5100], // rising → "Fight!" (median ≈ 4.77 s; §3.1: 3.3–5.7 s, median ≈ 4.6) — keeps the
                                  // whole stoppage on the 8.1 s + 0.92 s × count fit now that "Down" nets out the stall
  koCallDelayMs: [1000, 2000, 1250], // "10" → "KO" (median ≈ 1.3 s)
  koCallStageMs: 500,            // 'ko-call' (the KO letters fly in) …
  koHoldMs: 1300,                // … 'ko-hold', then RESULT (KO → RESULT 1.8 s; the outro follows)
  decisionMs: 2500,              // 'decision' → RESULT
  // health (§2.9, §3.3)
  betweenRoundHeal01: 0,         // no top-up between rounds (V)
  getUp: {
    refillWedges: [8, 6, 4],     // refill on rising from knockdown 1 / 2 / 3 (10 − 2k)
    human: {
      // (2026-11-13, a player's report: 8 / 12 / 16 punches, with a 1 punch/s arm-pump trickle from activity 0.5, made the
      // first get-up very hard and the second almost impossible — the camera recognises only part of a flurry thrown while
      // down, and pumping both arms at once is no punch at all. Now pumping the arms alone gets a player up in time.)
      punches: [5, 7, 9],        // punch events to fill the get-up meter for knockdown 1 / 2 / 3
      earliestCount: [4, 5, 7],  // never up before this count
      activityPunchesPerSec: 2.5, // ControlState.activity ≥ activityMin adds this × activity punches/s
      activityMin: 0.3,
      graceMs: 300,              // effort only counts this long after the fall
    },
    ai: { sd: 1.2, minCount: 3, maxCount: 9 }, // rise count ~ normal(roster riseMean[k], sd) clamped
  },
  // dodge slow motion (§2.5, §2.10; ARCHITECTURE §6.3)
  slowmo: { enabled: true, scale: 0.25, durationMs: 750 },
  latencyMs: 100,                // camera → game latency (Match option latencyMs overrides)
  // first-bout tutorial (§8; ARCHITECTURE §6.9)
  tutorial: false,
  tutorialSteps: ['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge'],
  tutorialStepMaxMs: 12000,      // fallback auto-advance while nobody calls setTutorialStep (0 = never)
  // judging (never observed in the footage, §9.1 — kept simple)
  judges: [
    // weights per round: per wedge of damage dealt, per punch landed, per counter landed, per
    // punch blocked/dodged, per punch thrown (effective aggression)
    { name: 'Judge Marlow', w: { damage: 1.0, landed: 0.45, counters: 0.6, defense: 0.05, activity: 0.1 } },
    { name: 'Judge Ito', w: { damage: 0.5, landed: 1.0, counters: 0.8, defense: 0.08, activity: 0.1 } },
    { name: 'Judge Brennan', w: { damage: 0.6, landed: 0.6, counters: 0.5, defense: 0.15, activity: 0.2 } },
  ],
  knockdownRoundWeight: 3,       // a knockdown scored counts this much toward winning the round
  knockdownPointPenalty: 1,      // and costs the downed boxer this many points
  judgeNoise: 0.6,               // per-judge per-round scoring noise (score units, seeded)
  evenMargin: 1.0,               // |round score difference| below this → 10-10
  minRoundScore: 6,
  // simulation
  maxStepMs: 100,                // a single update never advances more than this
  substepMs: 1000 / 60,          // internal fixed-ish step
});

/** Overrides for `fast: true` (tests / ?fast=1): 10 s rounds and every stage short.
 *  Intro → clock 0.72 s; knockdown → "1" 0.35 s, numbers 0.3 s apart; rise → "Fight!" 0.45 s;
 *  "10" → KO 0.3 s → RESULT 0.6 s later; round break 0.45 s; decision 0.6 s. */
export const FAST_RULES = Object.freeze({
  roundRealMs: 10000,
  introArenaMs: 150, bannerMs: 250, flyinMs: 120, ringMs: 80, fightToClockMs: 120, fightTextMs: 400,
  roundEndBellMs: 150, roundEndHoldMs: 200, betweenArenaMs: 100,
  downCallMs: 200, fallClockMs: [0, 150], firstNumberMs: 150, countIntervalMs: 300, riseDelayMs: 60,
  getUpAnimMs: 300, standoffMs: 450, koCallDelayMs: 300, koCallStageMs: 150, koHoldMs: 450,
  decisionMs: 600, tutorialStepMaxMs: 3000,
});

const P = MatchPhase;
const IDS = ['p1', 'p2'];
const other = (id) => (id === 'p1' ? 'p2' : 'p1');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Deep-ish merge of rule overrides (getUp.*, slowmo, judges and arrays handled). */
export function mergeRules(...layers) {
  const out = JSON.parse(JSON.stringify(RULES));
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      if (k === 'getUp' && v && typeof v === 'object') {
        out.getUp = {
          ...out.getUp, ...v,
          human: { ...out.getUp.human, ...(v.human || {}) },
          ai: { ...out.getUp.ai, ...(v.ai || {}) },
        };
      } else if (k === 'slowmo' && v && typeof v === 'object') out.slowmo = { ...out.slowmo, ...v };
      else out[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : (v && typeof v === 'object' ? { ...v } : v);
    }
  }
  return out;
}

/** Draw a timing: number | [min, max] (uniform) | [min, max, mode] (triangular). */
export function drawTiming(rng, spec) {
  if (Number.isFinite(spec)) return spec;
  if (!Array.isArray(spec) || !spec.length) return 0;
  const a = Number(spec[0]), b = Number(spec.length > 1 ? spec[1] : spec[0]);
  if (!(b > a)) return a;
  const u = rng.float();
  if (spec.length > 2 && Number.isFinite(spec[2])) {
    const c = clamp(Number(spec[2]), a, b), f = (c - a) / (b - a);
    return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  }
  return a + (b - a) * u;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function freshRoundStats() {
  const s = () => ({ thrown: 0, landed: 0, damage: 0, counters: 0, defense: 0, kdScored: 0, kdSuffered: 0 });
  return { p1: s(), p2: s() };
}

function freshBoxerStats() {
  return { thrown: 0, landed: 0, blocked: 0, dodged: 0, counters: 0, damageDealt: 0, knockdownsScored: 0, missed: 0, damageTaken: 0, hitsTaken: 0, headLanded: 0, bodyLanded: 0, feints: 0, powerLanded: 0 };
}

function normInputs(inputs) {
  if (!inputs) return { p1: null, p2: null };
  if (Array.isArray(inputs)) return { p1: inputs[0] || null, p2: inputs[1] || null };
  if (Array.isArray(inputs.players)) return { p1: inputs.players[0] || null, p2: inputs.players[1] || null };
  return { p1: inputs.p1 || null, p2: inputs.p2 || null };
}

function punchesOf(pi) {
  if (!pi || !Array.isArray(pi.events)) return [];
  const out = [];
  for (const e of pi.events) if (e && e.type === 'punch' && e.punch) out.push(e.punch);
  return out;
}

let idCounter = 0;
function makeMatchId(seed) {
  idCounter = (idCounter + 1) % 1e6;
  const rnd = Math.floor(Math.random() * 0x100000000).toString(36);
  return `m-${Date.now().toString(36)}-${(seed >>> 0).toString(36)}-${idCounter.toString(36)}-${rnd}`;
}

/** Resolve a single-player opponent from a roster entry, an id string or a partial def. */
function resolveOpponent(p2) {
  if (!p2) return ROSTER[0];
  if (typeof p2 === 'string') return opponentById(p2) || ROSTER[0];
  if (p2.ai || p2.stats) return p2;
  if (p2.id && opponentById(p2.id)) return opponentById(p2.id);
  return { ...ROSTER[0], ...p2 };
}

export class Match {
  /**
   * @param {Object} o
   * @param {{emit:Function}} [o.bus]            EventBus (optional)
   * @param {'single'|'versus'} [o.mode]
   * @param {{name?:string, appearance?:Object, isHuman?:boolean, stats?:Object, ai?:Object}} [o.p1]
   * @param {Object|string} [o.p2]   single: roster entry / id; versus: like p1
   * @param {import('../core/rng.js').Rng|number|string} [o.rng]   seed or Rng
   * @param {Object} [o.rules]       RULES overrides (e.g. {tutorial: true})
   * @param {boolean} [o.fast]       FAST_RULES (short rounds/stages) for tests
   * @param {Object} [o.combat]      COMBAT overrides
   * @param {string} [o.id]          result id (default: unique)
   * @param {number} [o.latencyMs]   camera → game latency of the human corners (calibration.latencyMs)
   * @param {boolean} [o.tutorial]   shorthand for rules.tutorial
   */
  constructor(o = {}) {
    this.bus = o.bus || null;
    this.mode = o.mode === 'versus' ? 'versus' : 'single';
    this.rules = mergeRules(o.fast ? FAST_RULES : null, o.rules || null);
    if (o.tutorial != null) this.rules.tutorial = !!o.tutorial;
    this.tuning = o.combat ? { ...COMBAT, ...o.combat, punch: { ...COMBAT.punch, ...(o.combat.punch || {}) } } : COMBAT;
    this.latencyMs = clamp(num(o.latencyMs, num(this.rules.latencyMs, this.tuning.latencyMs)), 0, 400);
    this.rng = toRng(o.rng !== undefined ? o.rng : o.seed);
    this.seed = this.rng.seed;
    this.rngCombat = this.rng.fork('combat');
    this.rngJudges = this.rng.fork('judges');
    this.rngGetup = this.rng.fork('getup');
    this.rngTimeline = this.rng.fork('timeline');

    const p1 = o.p1 || {};
    let p2 = o.p2 || null;
    this.opponent = null;
    if (this.mode === 'single') { p2 = resolveOpponent(p2); this.opponent = p2; }
    else p2 = p2 || { name: 'Player 2', isHuman: true };

    const mk = (id, src, forceAi) => {
      const ai = forceAi || (src && src.isHuman === false) || (!!src && !!src.ai && src.isHuman !== true);
      return new Boxer({
        id, isHuman: !ai,
        name: src.name || (id === 'p1' ? 'Player 1' : 'Player 2'),
        appearance: src.appearance || null,
        stats: src.stats,
        ai: ai ? src.ai : null,
        tuning: this.tuning,
        latencyMs: this.latencyMs,
      });
    };
    this.boxers = { p1: mk('p1', p1, false), p2: mk('p2', p2, this.mode === 'single') };
    const aiOpts = { latencyMs: this.latencyMs, tuning: this.tuning };
    /** One brain per AI-controlled corner (p1 can be AI too: attract/demo bouts). */
    this.ais = {
      p1: this.boxers.p1.isHuman ? null : new OpponentAI(p1, this.rng.fork('ai-p1'), aiOpts),
      p2: this.boxers.p2.isHuman ? null : new OpponentAI(p2, this.rng.fork('ai'), aiOpts),
    };
    this.ai = this.ais.p2;
    this.id = o.id || makeMatchId(this.seed);

    // time: `t` = match time (real, pausable; humans), `wt` = world time (AI corners, round clock)
    this.t = 0;
    this.wt = 0;
    this.timeSegs = [{ t: 0, wt: 0, rate: 1 }];
    this.slowmo = null;
    this.lastNow = null;
    this.started = false;
    this.stalled = false;    // the renderer's hit-stop is on (set by every update; see update opts)
    this.lastBlow = null;    // the latest knockdown blow {attacker, defender, hand, kind, target, impactAt, …}
    this._foeViews = {};
    // bobbing (R10, see _freshDodge): live fight time, each human's dodge-posture starts in it (and whether an attack was
    // coming), and when each AI corner last began a wind-up (match time)
    this.liveT = 0;
    this._fightSince = Infinity;
    this._onsets = { p1: { seen: null, list: [] }, p2: { seen: null, list: [] } };
    this._tellAt = { p1: -Infinity, p2: -Infinity };

    this.phase = P.INTRO;
    this.phaseStart = 0;
    this.stage = 'arena';
    this.stageStart = 0;
    this.pausedFrom = null;
    this.round = 1;
    this.roundElapsed = 0;
    this.roundStats = [freshRoundStats()];
    this.roundEndEmitted = 0;
    this.lastCall = null;
    this.kd = null;          // knockdown in progress (see _knockdown)
    this.rec = null;         // recovery in progress (see _rise)
    this.rs = null;          // round-start timeline
    this.tut = null;         // tutorial state while it runs
    this.pendingTutorialStep = null;
    this.tutorialSkipped = false;
    this.result = null;
    this.resultAt = 0;
    this.resultEmitted = false;
    this.scorecards = null;
    this.decisionType = null;
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Begin the intro (also called implicitly by the first update). */
  start(now = 0) {
    if (this.started) return;
    this.started = true;
    this.lastNow = Number.isFinite(now) ? now : null;
    this._setPhase(P.INTRO);
    this._setStage('arena');
    this._emit(Ev.MATCH_INTRO, {
      p1Name: this.boxers.p1.name, p2Name: this.boxers.p2.name,
      mode: this.mode, opponentId: this.opponent ? this.opponent.id : null, tutorial: !!this.rules.tutorial,
    });
  }

  /**
   * Advance the match.
   * @param {number} dt    seconds since the last update (used when `now` is not given)
   * @param {number} now   ms timestamp (the session's game clock); preferred time source
   * @param {{p1?:import('../core/types.js').PlayerInput, p2?:import('../core/types.js').PlayerInput}|Array} [inputs]
   *        p2 is only read in versus mode (the AI drives p2 in single player). Only 'punch'
   *        events are consumed — pausing is the app's job (call pause()/resume()).
   * @param {{stalled?:boolean}} [opts]  stalled: the renderer's hit-stop is slowing the game clock right now
   *        (MatchSession passes renderer.timeScale < 1). Human punches recognised meanwhile are queued, one
   *        per hand, instead of being dropped by the rate limit (decision D6).
   */
  update(dt, now, inputs, opts = null) {
    this.stalled = !!(opts && opts.stalled);
    if (!this.started) this.start(now);
    let ms;
    if (Number.isFinite(now)) {
      ms = this.lastNow == null ? (Number.isFinite(dt) ? dt * 1000 : 0) : now - this.lastNow;
      this.lastNow = now;
    } else ms = (Number.isFinite(dt) ? dt : 0) * 1000;
    if (this.phase === P.PAUSED) return;
    ms = clamp(ms, 0, this.rules.maxStepMs);
    const inp = normInputs(inputs);
    let events = { p1: punchesOf(inp.p1), p2: punchesOf(inp.p2) };
    if (ms <= 0) { this._step(0, inp, events); return; }
    let rest = ms;
    while (rest > 1e-6) {
      const h = Math.min(rest, this.rules.substepMs);
      this._step(h, inp, events);
      events = null;
      rest -= h;
      if (this.phase === P.PAUSED) break;
    }
  }

  /** Freeze the match exactly where it is (from any phase). */
  pause() {
    if (this.phase === P.PAUSED) return false;
    this.pausedFrom = this.phase;
    this.phase = P.PAUSED;
    this.lastNow = null;
    return true;
  }

  /** Restore the exact phase/timers that were paused. */
  resume() {
    if (this.phase !== P.PAUSED) return false;
    this.phase = this.pausedFrom || P.FIGHTING;
    this.pausedFrom = null;
    this.lastNow = null;
    return true;
  }

  isPaused() { return this.phase === P.PAUSED; }
  isOver() { return !!this.result; }

  /** The locked MatchResult, or null while undecided (MAT04: never changes once set). */
  getResult() { return this.result; }

  /** Change the human corners' camera latency (calibration). */
  setLatency(ms) {
    if (!Number.isFinite(ms)) return;
    this.latencyMs = clamp(ms, 0, 400);
    for (const id of IDS) {
      if (this.boxers[id].isHuman) this.boxers[id].latencyMs = this.latencyMs;
      if (this.ais[id]) this.ais[id].setLatency(this.latencyMs);
    }
  }

  /** Legacy readers: the downed corner / current count. */
  get downed() { return this.kd ? this.kd.downed : null; }
  get count() { return this.kd ? this.kd.count : 0; }

  // ── tutorial (ARCHITECTURE §6.9) ──

  /**
   * Switch the running tutorial to `step` (one of rules.tutorialSteps). Before the tutorial has
   * begun (INTRO) the step is remembered. Returns false when there is no tutorial (or it is over).
   */
  setTutorialStep(step) {
    const R = this.rules;
    if (!R.tutorial || this.result) return false;
    const idx = R.tutorialSteps.indexOf(step);
    if (idx < 0) return false;
    if (!this.tut) {
      if (this.phase === P.INTRO || (this.phase === P.PAUSED && this.pausedFrom === P.INTRO)) { this.pendingTutorialStep = step; return true; }
      return false;
    }
    this._tutorialGo(idx, true);
    return true;
  }

  /** End the tutorial: "Fight!" and round 1 goes live (its stats start from zero). */
  endTutorial() {
    if (!this.rules.tutorial || this.result) return false;
    if (!this.tut) {
      if (this.phase === P.INTRO || (this.phase === P.PAUSED && this.pausedFrom === P.INTRO)) { this.tutorialSkipped = true; return true; }
      return false;
    }
    const wasPaused = this.phase === P.PAUSED;
    this.tut = null;
    for (const id of IDS) {
      const b = this.boxers[id];
      if (this.ais[id]) this.ais[id].setScript(null, this.wt);
      b.stats = freshBoxerStats();
      b.hp = b.maxHp;
      b.neutralize(this._clock(id));
    }
    this.roundStats = [freshRoundStats()];
    this._endSlowmo();
    this._enterRoundStart({ fightNow: true });
    if (wasPaused) { this.pausedFrom = this.phase; this.phase = P.PAUSED; }
    return true;
  }

  /** @returns {import('../core/types.js').MatchView} */
  getView() {
    const t = this.t, R = this.rules;
    const kd = this.kd;
    const boxers = { p1: this.boxers.p1.toView(this._clock('p1')), p2: this.boxers.p2.toView(this._clock('p2')) };
    let getUp01 = null;
    if (kd && this.boxers[kd.downed].isHuman && !this.result) getUp01 = kd.stayDown ? 0 : clamp01(kd.meter / Math.max(1e-6, kd.required));
    if (getUp01 != null) boxers[kd.downed].getUp01 = getUp01;
    const call = this.lastCall ? { ...this.lastCall.payload, age: Math.max(0, (t - this.lastCall.at) / 1000) } : null;
    const s = this.slowmo;
    return {
      phase: this.phase,
      phaseTime: Math.max(0, (t - this.phaseStart) / 1000),
      round: this.round,
      maxRounds: R.rounds,
      clockDisplayMs: this._clockDisplay(),
      roundRealMsLeft: Math.max(0, R.roundRealMs - this.roundElapsed),
      downed: kd ? kd.downed : null,
      count: kd && kd.count > 0 ? kd.count : null,
      boxers,
      banner: this._banner(),
      result: this.result,
      mode: this.mode,
      opponent: this.opponent,
      getUp01,
      pausedFrom: this.pausedFrom,
      scorecards: this.scorecards,
      t,
      worldT: this.wt,
      id: this.id,
      seed: this.seed,
      stage: this.stage,
      stageTime: Math.max(0, (t - this.stageStart) / 1000),
      call,
      clockVisible: this._clockVisible(),
      slowmo: s ? { kind: s.kind, dodger: s.dodger, attacker: s.attacker, scale: s.scale, t01: clamp01((t - s.start) / Math.max(1, s.durationMs)), msLeft: Math.max(0, s.end - t) } : null,
      tutorial: this.tut ? { step: this.tut.step, index: this.tut.index, total: this.tut.total, count: this.tut.count, holdMs: Math.round(this.tut.holdMs), stepTime: Math.max(0, (t - this.tut.stepStart) / 1000) } : null,
      latencyMs: this.latencyMs,
    };
  }

  // ───────────────────────────── debug hooks (dev pages / e2e) ─────────────────────────────

  /** Set a boxer's health in wedges (clamped to 0.05..max). */
  debugSetHp(id, hp) { const b = this.boxers[id]; if (b && Number.isFinite(hp)) b.hp = clamp(hp, 0.05, b.maxHp); }
  /**
   * Knock a boxer down right now (only while fighting, not in the tutorial). The other boxer is credited
   * with a synthetic knockdown blow, exactly like a real one: MATCH_HIT {knockdown, synthetic: true, hand,
   * kind, target} then MATCH_KNOCKDOWN {blow}, and its glove shows at full extension pulling back — so the
   * renderer's hit-stop, burst and KO replay have a blow to show (stats are not touched).
   * @param {'p1'|'p2'} id
   * @param {{stayDown?:boolean, riseCount?:number, hand?:'left'|'right', kind?:string, target?:'head'|'body'}} [opts]
   *        force the opponent's roll (tests / e2e); stayDown:false never overrides the 4th-knockdown rule;
   *        hand / kind / target shape the synthetic blow (default: the scorer's rear straight to the head)
   */
  debugKnockdown(id, opts = {}) {
    if (this.phase !== P.FIGHTING || this.tut || !this.boxers[id]) return false;
    const o = opts || {};
    const byId = other(id);
    const att = this.boxers[byId], def = this.boxers[id];
    const hand = o.hand === 'left' || o.hand === 'right' ? o.hand : att.rearHand();
    const kind = this.tuning.punch[o.kind] ? o.kind : 'straight';
    const target = o.target === 'body' ? 'body' : 'head';
    const hpBefore = def.hp;
    const blow = { attacker: byId, defender: id, hand, kind, target, impactAt: this.t, counter: false, powerPunch: false, damage: Math.round(Math.max(hpBefore, 0.1) * 100) / 100, synthetic: true };
    this._emit(Ev.MATCH_HIT, {
      attacker: byId, defender: id, hand, kind, target, damage: blow.damage, dealt: Math.round(hpBefore * 100) / 100, counter: false, power: 0.8,
      powerPunch: false, heavy: true, knockdown: true, hpBefore, hpAfter: 0, hp01: 0, into: false, combo: 1, dazedTarget: false, synthetic: true,
    });
    this._knockdown(id, byId, blow);
    att.showBlow({ hand, kind, target, power: 0.8 }, this._clock(byId));
    const kd = this.kd;
    if (kd && opts) {
      if (opts.stayDown === true) kd.stayDown = true;
      else if (opts.stayDown === false && kd.k < this.rules.knockdownsForKo) {
        kd.stayDown = false;
        if (!kd.human && kd.riseCount == null) kd.riseCount = this.rules.getUp.ai.minCount + 2;
      }
      if (Number.isFinite(opts.riseCount) && !kd.human) kd.riseCount = clamp(Math.round(opts.riseCount), 1, this.rules.countTo - 1);
    }
    return true;
  }
  /** Run the round clock out. */
  debugEndRound() { if (this.phase === P.FIGHTING && !this.tut) this.roundElapsed = this.rules.roundRealMs; }

  // ───────────────────────────── internals: time ─────────────────────────────

  _emit(name, payload) { if (this.bus && typeof this.bus.emit === 'function') this.bus.emit(name, payload); }
  _setPhase(ph) { this.phase = ph; this.phaseStart = this.t; }
  _setStage(s) { this.stage = s; this.stageStart = this.t; }
  _draw(spec) { return drawTiming(this.rngTimeline, spec); }
  /** The clock a corner lives on: humans real match time, AI corners world time. */
  _clock(id) { return this.boxers[id].isHuman ? this.t : this.wt; }

  _pushSeg(t, wt, rate) {
    const segs = this.timeSegs;
    const last = segs[segs.length - 1];
    if (last && last.t === t) { last.wt = wt; last.rate = rate; }
    else segs.push({ t, wt, rate });
    if (segs.length > 64) segs.splice(0, segs.length - 64);
  }

  /** Match time → world time (past via the time map; future assumes the slow motion ends as scheduled). */
  _toWorld(h) {
    if (!Number.isFinite(h)) return h;
    if (h >= this.t) {
      const s = this.slowmo;
      if (s && s.end > this.t) {
        if (h <= s.end) return this.wt + (h - this.t) * s.scale;
        return this.wt + (s.end - this.t) * s.scale + (h - s.end);
      }
      return this.wt + (h - this.t);
    }
    const segs = this.timeSegs;
    for (let i = segs.length - 1; i >= 0; i--) {
      const g = segs[i];
      if (g.t <= h || i === 0) return g.wt + (h - g.t) * g.rate;
    }
    return h;
  }

  /** World time → match time. */
  _toHuman(w) {
    if (!Number.isFinite(w)) return w;
    if (w >= this.wt) {
      const s = this.slowmo;
      if (s && s.end > this.t) {
        const wEnd = this.wt + (s.end - this.t) * s.scale;
        if (w <= wEnd) return this.t + (w - this.wt) / s.scale;
        return s.end + (w - wEnd);
      }
      return this.t + (w - this.wt);
    }
    const segs = this.timeSegs;
    for (let i = segs.length - 1; i >= 0; i--) {
      const g = segs[i];
      if (g.wt <= w || i === 0) return g.t + (w - g.wt) / g.rate;
    }
    return w;
  }

  /** Advance both clocks by h ms of match time (the world runs slower during the slow motion). */
  _advanceClocks(h) {
    const s = this.slowmo;
    if (!s) { this.t += h; this.wt += h; return h; }
    const slow = clamp(s.end - this.t, 0, h);
    let wh = slow * s.scale;
    this.t += slow; this.wt += slow * s.scale;
    if (this.t >= s.end - 1e-9) {
      this.slowmo = null;
      this._pushSeg(this.t, this.wt, 1);
      const restH = h - slow;
      this.t += restH; this.wt += restH; wh += restH;
    }
    return wh;
  }

  /**
   * Decision R2 (RV-RULES-01): is a human's dodge of punch `p` FRESH — the dodging posture entered at most
   * COMBAT.freshDodgeMs before the defence sample that decided it, or after the punch's wind-up began (a reaction to
   * its tell, however long the AI then held it)? Only a fresh dodge earns the slow motion and the counter window; a
   * posture held longer still evades (the D3 geometry is unchanged). Unknown posture start → fresh.
   */
  _freshDodge(att, p, res, contact, defId) {
    const since = res.leanSince;
    if (!Number.isFinite(since)) return true;
    if (!att.isHuman && this._bobbing(defId, since)) return false;
    const at = Number.isFinite(res.sampleT) ? res.sampleT : contact;
    if (at - since <= num(this.tuning.freshDodgeMs, COMBAT.freshDodgeMs)) return true;
    const ws = Number.isFinite(p.windupStart) ? p.windupStart : p.thrownAt;
    const tellStart = att.isHuman ? ws : this._toHuman(ws);
    return Number.isFinite(tellStart) && since >= tellStart; // a reaction to this punch's (long, held) tell
  }

  /**
   * A human's new dodge posture (Boxer.dodgeSince moved): remember when it began, in live fight time, and whether an attack
   * was coming — the opponent had a wind-up or a punch out, or began one at most COMBAT.freshDodgeProvokeMs before. Only
   * postures begun while the clock runs count (not the tutorial, not a stoppage).
   */
  _trackOnset(id, t) {
    const b = this.boxers[id], s = this._onsets[id];
    const since = b.dodgeSince;
    if (since == null || since === s.seen) return;
    s.seen = since;
    if (this.phase !== P.FIGHTING || this.tut || !(since >= this._fightSince)) return;
    const foeId = other(id), foe = this.boxers[foeId];
    if (foe.isHuman) return;
    const provoked = !!foe.windup || !!foe.travelling() || t - this._tellAt[foeId] <= num(this.tuning.freshDodgeProvokeMs, COMBAT.freshDodgeProvokeMs);
    s.list.push({ since, live: this.liveT, provoked });
    if (s.list.length > 12) s.list.shift();
  }

  /**
   * Bobbing (R10, our own design E, extending R2): in the last COMBAT.freshDodgeBobMs of live fight time up to the start of
   * the posture that made this dodge, the player went into a dodge posture with no attack coming freshDodgeBobOnsets times
   * or more (this posture included) — dips on a rhythm, not dodges. Its dodges evade but are not fresh.
   */
  _bobbing(defId, since) {
    const C = this.tuning, s = this._onsets[defId];
    const need = num(C.freshDodgeBobOnsets, 0), win = num(C.freshDodgeBobMs, 0);
    if (!s || !(need > 0) || !(win > 0)) return false;
    let at = this.liveT;
    for (const o of s.list) if (o.since === since) at = o.live;
    let n = 0;
    for (const o of s.list) if (!o.provoked && o.live <= at && o.live > at - win) n++;
    return n >= need;
  }

  _slowmoAllowed(dodgerId, attackerId) {
    const S = this.rules.slowmo;
    return !!(S && S.enabled !== false && this.mode !== 'versus' && this.boxers[dodgerId].isHuman && !this.boxers[attackerId].isHuman);
  }

  _startSlowmo(dodger, attacker) {
    const S = this.rules.slowmo;
    const scale = clamp(num(S.scale, 0.25), 0.05, 1);
    const durationMs = Math.max(0, num(S.durationMs, 750));
    this._pushSeg(this.t, this.wt, scale);
    this.slowmo = { kind: 'dodge', dodger, attacker, scale, start: this.t, end: this.t + durationMs, durationMs };
    this._emit(Ev.MATCH_SLOWMO, { kind: 'dodge', dodger, attacker, scale, durationMs });
  }

  _endSlowmo() {
    if (!this.slowmo) return;
    this.slowmo = null;
    this._pushSeg(this.t, this.wt, 1);
  }

  /** The other corner as the AI in `aiId` sees it, with its times converted to world time. */
  _foeView(id) {
    const b = this.boxers[id];
    if (!b.isHuman) return b;
    if (this._foeViews[id]) return this._foeViews[id];
    const W = (h) => this._toWorld(h), H = (w) => this._toHuman(w);
    const view = {
      id: b.id, isHuman: true,
      get hp01() { return b.hp01; }, get hp() { return b.hp; }, get maxHp() { return b.maxHp; },
      get down() { return b.down; }, get terminal() { return b.terminal; },
      get guard() { return b.guard; }, get guardAmount() { return b.guardAmount; }, get lean() { return b.lean; },
      get activity() { return b.activity; }, get speed() { return b.speed; },
      get hitReact() { return b.hitReact; },
      get punches() {
        return b.punches.map((p) => ({
          id: p.id, hand: p.hand, kind: p.kind, target: p.target, power: p.power, counter: p.counter, stage: p.stage, outcome: p.outcome,
          thrownAt: W(p.thrownAt), impactAt: W(p.impactAt), resolvedAt: p.resolvedAt ? W(p.resolvedAt) : 0, recoverUntil: p.recoverUntil ? W(p.recoverUntil) : 0,
        }));
      },
      leadHand: () => b.leadHand(), rearHand: () => b.rearHand(),
      canAct: (w) => b.canAct(H(w)), isStunned: (w) => b.isStunned(H(w)), isDazed: () => false,
      isGettingUp: (w) => b.isGettingUp(H(w)), effectiveGuard: (w) => b.effectiveGuard(H(w)),
      counterReady: (w) => b.counterReady(H(w)), isDodging: () => b.isDodging(),
      travelling: () => b.travelling(), isMidPunch: (w) => b.isMidPunch(Number.isFinite(w) ? H(w) : undefined),
    };
    this._foeViews[id] = view;
    return view;
  }

  // ───────────────────────────── internals: the step ─────────────────────────────

  _step(h, inp, events) {
    const wh = this._advanceClocks(h);
    const t = this.t, wt = this.wt;
    if (this.phase === P.FIGHTING) this.liveT += h;

    // 1) human controls (continuous) and punches (discrete, once per update)
    for (const id of IDS) {
      const b = this.boxers[id];
      if (!b.isHuman) continue;
      b.setControl(inp[id] ? inp[id].control : null, t);
      this._trackOnset(id, t);
      if (events) for (const pi of events[id]) this._humanPunch(b, pi, t);
    }

    // 2) AI corners (world time)
    const live = this.phase === P.FIGHTING;
    for (const id of IDS) {
      const ai = this.ais[id];
      if (!ai) continue;
      const self = this.boxers[id];
      if (live) {
        const intent = ai.update(wh / 1000, wt, self, this._foeView(other(id)), { phase: this.phase, round: this.round, stage: this.stage, tutorial: !!this.tut });
        self.applyIntent(intent, wt);
        if (intent.punch) {
          const w = self.startWindup(intent.punch, wt);
          if (w) {
            this._tellAt[id] = t;
            this._emit(Ev.MATCH_WINDUP, {
              attacker: id, hand: w.hand, kind: w.kind, target: w.target, windupMs: w.ms, tellMs: w.ms + w.travelMs,
              powerPunch: w.powerPunch, counter: w.counter, tell: { ...w.tell },
            });
          }
        }
      } else self.applyIntent(this._passiveIntent(id), wt);
    }

    // 3) boxer timers (wind-ups become punches, recoveries end)
    for (const id of IDS) {
      const b = this.boxers[id];
      const notes = b.update(b.isHuman ? t : wt);
      for (const n of notes) if (n.type === 'thrown') this._onThrown(id, n.punch);
    }

    // 4) contacts (punches thrown before the bell still land during the bell)
    if (this.phase === P.FIGHTING || (this.phase === P.ROUND_END && this.stage === 'bell')) this._resolveImpacts();

    // 5) phase logic
    this._tick(h, wh);
  }

  _passiveIntent(id) {
    const ai = this.ais[id];
    const idle = ai ? ai._styleGuard() : 'high';
    const zero = { x: 0, y: 0, z: 0 };
    switch (this.phase) {
      case P.ROUND_END: return this.stage === 'hold' ? { guard: 'none', lean: zero, rest: true } : { guard: idle, lean: zero };
      case P.BETWEEN: return { guard: 'none', lean: zero, rest: true };
      case P.KNOCKDOWN: case P.RECOVERY: return { guard: 'high', lean: zero };
      case P.DECISION: case P.RESULT: return { guard: 'none', lean: zero };
      default: return { guard: idle, lean: zero };
    }
  }

  _humanPunch(b, pi, t) {
    if (this.phase === P.FIGHTING) {
      const r = b.tryPunch(pi, t, { stalled: !!this.stalled });
      if (r && typeof r === 'object') this._onThrown(b.id, r);
    } else if (this.phase === P.KNOCKDOWN && this.kd && !this.result && this.kd.downed === b.id && b.down && !this.kd.stayDown) {
      if (t - this.kd.at >= this.rules.getUp.human.graceMs) this.kd.meter += 1;
    }
  }

  _onThrown(id, p) {
    this._rs(id).thrown++;
    if (this.ais[id]) this.ais[id].onPunchThrown(p);
    this._emit(Ev.MATCH_PUNCH_THROWN, { attacker: id, hand: p.hand, kind: p.kind, target: p.target, power: p.power, counter: !!p.counter, powerPunch: !!p.powerPunch });
  }

  _rs(id) {
    const rs = this.roundStats[this.round - 1] || (this.roundStats[this.round - 1] = freshRoundStats());
    return rs[id];
  }

  _resolveImpacts() {
    const t = this.t, wt = this.wt;
    const pending = [];
    for (const id of IDS) {
      const att = this.boxers[id], def = this.boxers[other(id)];
      const defer = def.isHuman ? def.latencyMs + this.tuning.defenseGraceMs : 0;
      for (const p of att.punches) {
        if (p.stage !== 'travel') continue;
        let contact;
        if (att.isHuman) contact = p.impactAt;
        else {
          if (p.impactAt > wt + 1e-9) continue;
          if (!Number.isFinite(p.contactH)) p.contactH = this._toHuman(p.impactAt);
          contact = p.contactH;
        }
        if (contact > t + 1e-9) continue;
        pending.push({ id, p, contact, ready: contact + defer <= t + 1e-9 });
      }
    }
    if (!pending.length) return;
    pending.sort((a, b) => a.contact - b.contact || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Resolve in contact order up to the last punch that is ready; an earlier contact still in
    // its latency-grace window is resolved early rather than out of order.
    let last = -1;
    for (let i = 0; i < pending.length; i++) if (pending[i].ready) last = i;
    for (let i = 0; i <= last; i++) {
      if (this.phase !== P.FIGHTING && this.phase !== P.ROUND_END) break; // knockdown interrupted the exchange
      const { id, p, contact } = pending[i];
      if (p.stage !== 'travel') continue;
      this._resolveOne(id, p, contact);
    }
  }

  _resolveOne(attId, p, contact) {
    const defId = other(attId);
    const att = this.boxers[attId], def = this.boxers[defId];
    const attT = this._clock(attId), defT = this._clock(defId);
    const aSnap = att.combatSnapshot(attT);
    const dSnap = def.combatSnapshot(defT);
    const dai = this.ais[defId];
    if (dai) {
      const read = dai.readFor(p, defT, def);
      if (read === 'block') dSnap.guard = guardFor(p.target);
      else if (read === 'open') dSnap.guard = 'none';
    }
    const tut = !!this.tut;
    let counter = !!p.counter;
    if (att.isHuman && !tut) {
      if (this.t < att.counterUntil) counter = true;   // landing inside the post-dodge window
      // their punch was already out when ours started (or their glove hangs after a miss): a counter —
      // once per punch of theirs (a flurry into one swing earns one counter, not one per jab)
      if (!counter) {
        const q = def.midPunchFor(defT, def.isHuman ? p.thrownAt : this._toWorld(p.thrownAt));
        if (q && !q.counteredBy) { q.counteredBy = p.id; counter = true; }
      }
    }
    if (tut) counter = false;
    const res = resolvePunch({ attacker: aSnap, defender: dSnap, punch: { ...p, counter, impactAt: contact }, now: defT, rng: this.rngCombat, tuning: this.tuning, noDamage: tut });
    if (res.result === 'dodged' && def.isHuman) {
      res.freshDodge = this._freshDodge(att, p, res, contact, defId);
      // a held posture's dodge leaves the missed glove hanging (the guard is open, a punch lands) but is no counter
      // chance either: midPunchFor skips it (R2 — only a fresh dodge earns a counter)
      if (res.freshDodge === false) p.heldDodge = true;
    }
    att.onPunchResolved(p, res, attT);
    def.receive(res, p, defT);
    const base = { attacker: attId, defender: defId, hand: p.hand, kind: p.kind, target: p.target };
    if (res.result === 'hit') {
      const rs = this._rs(attId);
      rs.landed++; rs.damage += res.dealt; if (res.counter) rs.counters++;
      this._emit(Ev.MATCH_HIT, {
        ...base, damage: tut ? 0 : res.damage, dealt: res.dealt, counter: res.counter, power: p.power, powerPunch: !!p.powerPunch,
        heavy: res.heavy, knockdown: res.knockdown && !tut, hpBefore: res.hpBefore, hpAfter: res.hpAfter,
        hp01: def.hp01, into: res.into, combo: res.comboIndex + 1, dazedTarget: false,
      });
      if (att.isHuman && res.counter) {
        att.endCounterWindow(this.t);
        if (this.slowmo && this.slowmo.dodger === attId) this._endSlowmo();
      }
      if (tut && att.isHuman && ((this.tut.step === 'punch-head' && p.target === 'head') || (this.tut.step === 'punch-body' && p.target === 'body'))) this.tut.count++;
    } else if (res.result === 'blocked') {
      this._rs(defId).defense++;
      this._emit(Ev.MATCH_BLOCK, { ...base, chip: 0, guard: res.blockedBy });
      if (tut && def.isHuman && ((this.tut.step === 'guard-head' && p.target === 'head') || (this.tut.step === 'guard-body' && p.target === 'body'))) this.tut.count++;
    } else if (res.result === 'dodged') {
      this._rs(defId).defense++;
      // a held posture still evades, but only a fresh dodge earns the slow motion and the counter window (R2)
      const fresh = res.freshDodge !== false;
      this._emit(Ev.MATCH_DODGE, { ...base, counterWindowMs: fresh ? this.tuning.counterWindowMs : 0, how: res.dodge, fresh });
      if (fresh && this._slowmoAllowed(defId, attId)) this._startSlowmo(defId, attId);
      if (tut && def.isHuman && this.tut.step === 'dodge') this.tut.count++;
    } else {
      this._emit(Ev.MATCH_MISS, { attacker: attId, hand: p.hand, kind: p.kind, target: p.target });
    }
    if (res.result === 'hit' && res.knockdown && !tut && !def.down) {
      this._knockdown(defId, attId, {
        attacker: attId, defender: defId, hand: p.hand, kind: p.kind, target: p.target, impactAt: contact,
        counter: !!res.counter, powerPunch: !!p.powerPunch, damage: res.damage, synthetic: false,
      });
    }
  }

  // ───────────────────────────── internals: knockdowns ─────────────────────────────

  /**
   * @param {'p1'|'p2'} downedId
   * @param {'p1'|'p2'} byId
   * @param {null|{attacker:string, defender:string, hand:string, kind:string, target:string, impactAt:number,
   *         counter:boolean, powerPunch:boolean, damage:number, synthetic:boolean}} [blow]  the knockdown blow
   */
  _knockdown(downedId, byId, blow = null) {
    const R = this.rules;
    const d = this.boxers[downedId], s = this.boxers[byId];
    this._endSlowmo();
    d.knockDown(this._clock(downedId));
    s.neutralize(this._clock(byId));
    s.stats.knockdownsScored++;
    this._rs(byId).kdScored++;
    this._rs(downedId).kdSuffered++;
    const k = d.knockdowns;
    const at = this.t;
    const downCallAt = at + Math.max(0, this._draw(R.downCallMs));
    const kd = {
      downed: downedId, by: byId, at, k, human: d.isHuman,
      blow: blow ? { ...blow } : null,
      downCallAt,
      fallClockUntil: at + clamp(this._draw(R.fallClockMs), 0, downCallAt - at),
      nextCountAt: downCallAt + Math.max(0, this._draw(R.firstNumberMs)),
      count: 0, lastCountAt: at,
      stayDown: false, riseCount: null, riseAt: null,
      meter: 0, required: Infinity, earliest: R.countTo,
      koCallAt: null, koStageEnd: null, resultAt: null,
    };
    if (k >= R.knockdownsForKo) kd.stayDown = true;
    else if (d.isHuman) {
      const g = R.getUp.human;
      kd.required = Math.max(1, g.punches[Math.min(k - 1, g.punches.length - 1)]);
      kd.earliest = g.earliestCount[Math.min(k - 1, g.earliestCount.length - 1)];
    } else {
      const p = this.ais[downedId] ? this.ais[downedId].p : { stayDown: [0.2, 0.3, 0.4], riseMean: [6, 7, 8] };
      const sd = p.stayDown[Math.min(k - 1, p.stayDown.length - 1)];
      kd.stayDown = this.rngGetup.chance(Number.isFinite(sd) ? sd : 1);
      const mean = p.riseMean[Math.min(k - 1, p.riseMean.length - 1)];
      const g = R.getUp.ai;
      kd.riseCount = clamp(Math.round(this.rngGetup.normal(Number.isFinite(mean) ? mean : 7, g.sd)), g.minCount, g.maxCount);
    }
    this.kd = kd;
    this.lastBlow = kd.blow;
    this.rec = null;
    this._setPhase(P.KNOCKDOWN);
    this._setStage('fall');
    this._emit(Ev.MATCH_KNOCKDOWN, { downed: downedId, count: k, roundCount: d.roundKnockdowns, by: byId, round: this.round, blow: kd.blow ? { ...kd.blow } : null });
  }

  _tickKnockdown(h, wh) {
    const R = this.rules, t = this.t, kd = this.kd;
    if (!kd) return;
    if (this.result) {
      if (this.stage === 'ko-call' && t >= kd.koStageEnd) this._setStage('ko-hold');
      if (t >= kd.resultAt) this._enterResult();
      return;
    }
    if (t < kd.fallClockUntil) this.roundElapsed = Math.min(R.roundRealMs, this.roundElapsed + wh);
    if (this.stage === 'fall' && t >= kd.downCallAt) {
      this._setStage('down-call');
      this._callOut('down', { boxer: kd.downed });
    }
    const d = this.boxers[kd.downed];
    if (d.isHuman && !kd.stayDown) {
      const g = R.getUp.human;
      if (t - kd.at >= g.graceMs && d.activity >= g.activityMin) kd.meter += g.activityPunchesPerSec * d.activity * (h / 1000);
    }
    while (t >= kd.nextCountAt && kd.count < R.countTo) {
      if (this.stage === 'fall') { this._setStage('down-call'); this._callOut('down', { boxer: kd.downed }); }
      kd.count++;
      kd.lastCountAt = kd.nextCountAt;
      kd.nextCountAt += R.countIntervalMs;
      if (this.stage !== 'count') this._setStage('count');
      this._emit(Ev.MATCH_COUNT, { downed: kd.downed, n: kd.count });
      if (kd.count >= R.countTo) kd.koCallAt = kd.lastCountAt + Math.max(0, this._draw(R.koCallDelayMs));
    }
    if (!kd.stayDown && kd.count < R.countTo && kd.riseAt == null) {
      if (d.isHuman) {
        if (kd.meter >= kd.required && kd.count >= kd.earliest) kd.riseAt = Math.max(t, kd.lastCountAt + this._draw(R.riseDelayMs));
      } else if (kd.riseCount != null && kd.count >= kd.riseCount) kd.riseAt = kd.lastCountAt + this._draw(R.riseDelayMs);
    }
    if (kd.riseAt != null && kd.count < R.countTo && t >= kd.riseAt) { this._rise(); return; }
    if (kd.count >= R.countTo && kd.koCallAt != null && t >= kd.koCallAt) this._koCall();
  }

  _koCall() {
    const R = this.rules, kd = this.kd;
    const loser = kd.downed, winner = other(loser);
    this._setStage('ko-call');
    this._resolveResult({ winner, method: ResultMethod.KO, scorecards: [], decisionType: null });
    this.boxers[loser].setTerminal('ko', this._clock(loser));
    this.boxers[winner].setTerminal('victory', this._clock(winner));
    this._callOut('ko', { boxer: loser, winner });
    this._emit(Ev.MATCH_KO, { winner, loser, method: ResultMethod.KO });
    kd.koStageEnd = this.t + R.koCallStageMs;
    kd.resultAt = kd.koStageEnd + R.koHoldMs;
  }

  _rise() {
    const R = this.rules, kd = this.kd, t = this.t;
    const id = kd.downed;
    const d = this.boxers[id];
    const tbl = R.getUp.refillWedges;
    const refill = Number.isFinite(tbl[kd.k - 1]) ? tbl[kd.k - 1] : Math.max(0, 10 - 2 * kd.k);
    d.getUp(this._clock(id), clamp01(refill / d.maxHp), R.getUpAnimMs);
    this.boxers[other(id)].neutralize(this._clock(other(id)));
    this._emit(Ev.MATCH_GETUP, { downed: id, atCount: kd.count, hp: d.hp, knockdown: kd.k });
    this.rec = { riser: id, at: t, atCount: kd.count, fightAt: t + Math.max(R.getUpAnimMs, this._draw(R.standoffMs)), clockAt: null };
    this.kd = null;
    this._setPhase(P.RECOVERY);
    this._setStage('rise');
  }

  _stoppage() { /* no TKO in this game (§3.4): kept as a no-op for older callers */ }

  // ───────────────────────────── internals: phases ─────────────────────────────

  _tick(h, wh) {
    const R = this.rules, t = this.t;
    const st = t - this.stageStart;
    switch (this.phase) {
      case P.INTRO:
        if (st >= R.introArenaMs) {
          if (R.tutorial && !this.tutorialSkipped) this._enterTutorial();
          else this._enterRoundStart();
        }
        break;
      case P.ROUND_START: this._tickRoundStart(); break;
      case P.FIGHTING:
        if (this.tut) { this._tickTutorial(h); break; }
        this.roundElapsed += wh;
        if (this.roundElapsed >= R.roundRealMs) { this.roundElapsed = R.roundRealMs; this._enterRoundEnd(); }
        break;
      case P.KNOCKDOWN: this._tickKnockdown(h, wh); break;
      case P.RECOVERY: this._tickRecovery(); break;
      case P.ROUND_END: {
        if (this.stage === 'bell') {
          const inFlight = this.boxers.p1.travelling() || this.boxers.p2.travelling();
          if (st >= R.roundEndBellMs && !inFlight) this._setStage('hold');
        } else if (st >= R.roundEndHoldMs) {
          if (this.round >= R.rounds) this._enterDecision();
          else this._enterBetween();
        }
        break;
      }
      case P.BETWEEN:
        if (st >= R.betweenArenaMs) { this.round++; this._enterRoundStart(); }
        break;
      case P.DECISION:
        if (st >= R.decisionMs) this._enterResult();
        break;
      default:
        break;
    }
  }

  _callOut(call, extra = {}) {
    const payload = { call, round: this.round, ...extra };
    this.lastCall = { payload, at: this.t };
    this._emit(Ev.MATCH_CALL, payload);
  }

  /** "Fight!" + the bell (round starts and restarts). */
  _fightCall(restart) {
    this._setStage('fight');
    this._callOut('fight');
    this._emit(Ev.MATCH_BELL, { kind: 'start', round: this.round, restart: !!restart });
  }

  _enterRoundStart(opts = {}) {
    const R = this.rules, t = this.t;
    this._setPhase(P.ROUND_START);
    this.roundElapsed = 0;
    this.roundEndEmitted = Math.min(this.roundEndEmitted, this.round - 1);
    if (!this.roundStats[this.round - 1]) this.roundStats[this.round - 1] = freshRoundStats();
    for (const id of IDS) {
      this.boxers[id].neutralize(this._clock(id));
      if (this.ais[id]) this.ais[id].newRound(this.round);
    }
    this._emit(Ev.MATCH_ROUND_START, { round: this.round, maxRounds: R.rounds });
    if (opts.fightNow) {
      this.rs = { bannerEnd: t, flyinEnd: t, ringEnd: t, clockAt: t + Math.max(0, this._draw(R.fightToClockMs)) };
      this._fightCall(false);
    } else {
      const bannerEnd = t + Math.max(0, this._draw(R.bannerMs));
      const flyinEnd = bannerEnd + Math.max(0, this._draw(R.flyinMs));
      const ringEnd = flyinEnd + Math.max(0, this._draw(R.ringMs));
      this.rs = { bannerEnd, flyinEnd, ringEnd, clockAt: null };
      this._setStage('banner');
      this._callOut(this.round >= R.rounds && R.rounds > 1 ? 'final-round' : 'round');
    }
  }

  _tickRoundStart() {
    const R = this.rules, t = this.t, rs = this.rs;
    if (!rs) { this._enterFighting(); return; }
    if (this.stage === 'banner' && t >= rs.bannerEnd) this._setStage('flyin');
    if (this.stage === 'flyin' && t >= rs.flyinEnd) this._setStage('ring');
    if (this.stage === 'ring' && t >= rs.ringEnd) {
      this._fightCall(false);
      rs.clockAt = t + Math.max(0, this._draw(R.fightToClockMs));
    }
    if (this.stage === 'fight' && rs.clockAt != null && t >= rs.clockAt) this._enterFighting();
  }

  _tickRecovery() {
    const R = this.rules, t = this.t, rc = this.rec;
    if (!rc) { this._enterFighting(); return; }
    if (this.stage === 'rise' && t >= rc.at + R.getUpAnimMs) this._setStage('standoff');
    if ((this.stage === 'rise' || this.stage === 'standoff') && t >= rc.fightAt) {
      if (this.roundElapsed >= R.roundRealMs) { this.rec = null; this._enterRoundEnd(); return; }
      this._fightCall(true);
      rc.clockAt = t + Math.max(0, this._draw(R.fightToClockMs));
    }
    if (this.stage === 'fight' && rc.clockAt != null && t >= rc.clockAt) { this.rec = null; this._enterFighting(); }
  }

  _enterFighting() {
    this._setPhase(P.FIGHTING);
    this._setStage(this.tut ? this.tut.step : 'live');
    this._fightSince = this.t; // (a posture taken while the clock was stopped is no bobbing evidence)
    for (const id of IDS) if (this.ais[id]) this.ais[id].reset(this.wt);
  }

  _enterRoundEnd() {
    this._endSlowmo();
    this._setPhase(P.ROUND_END);
    this._setStage('bell');
    for (const id of IDS) {
      const b = this.boxers[id];
      b.cancelWindup();
      b.buffered = { left: null, right: null };
    }
    if (this.roundEndEmitted < this.round) {
      this.roundEndEmitted = this.round;
      const last = this.round >= this.rules.rounds;
      this._emit(Ev.MATCH_BELL, { kind: last ? 'final' : 'end', round: this.round });
      this._emit(Ev.MATCH_ROUND_END, { round: this.round });
      if (last) this._callOut('time');
    }
  }

  _enterBetween() {
    this._setPhase(P.BETWEEN);
    this._setStage('arena');
    for (const id of IDS) this.boxers[id].resetForRound(this._clock(id), this.rules.betweenRoundHeal01);
  }

  _enterDecision() {
    this._setPhase(P.DECISION);
    this._setStage('decision');
    for (const id of IDS) this.boxers[id].neutralize(this._clock(id));
    const j = this._judge();
    this.scorecards = j.cards;
    this.decisionType = j.decisionType;
    this._resolveResult({ winner: j.winner, method: j.winner ? ResultMethod.DECISION : ResultMethod.DRAW, scorecards: j.cards, decisionType: j.decisionType });
    this._callOut('decision', { winner: this.result.winner });
    this._emit(Ev.MATCH_DECISION, { scorecards: this.result.scorecards, winner: this.result.winner, decisionType: j.decisionType });
  }

  _enterResult() {
    this._setPhase(P.RESULT);
    this._setStage('result');
    const r = this.result;
    if (r && r.winner) {
      const w = this.boxers[r.winner], l = this.boxers[other(r.winner)];
      if (!w.terminal) w.setTerminal('victory', this._clock(r.winner));
      if (!l.terminal) l.setTerminal(r.method === ResultMethod.DECISION ? 'defeat' : 'ko', this._clock(other(r.winner)));
    }
    if (r && !this.resultEmitted) {
      this.resultEmitted = true;
      this._emit(Ev.MATCH_RESULT, r);
    }
  }

  // ───────────────────────────── internals: tutorial ─────────────────────────────

  _enterTutorial() {
    const R = this.rules;
    const steps = R.tutorialSteps;
    const idx = Math.max(0, this.pendingTutorialStep ? steps.indexOf(this.pendingTutorialStep) : 0);
    this.tut = { step: steps[idx], index: idx, total: steps.length, stepStart: this.t, count: 0, holdMs: 0, driven: !!this.pendingTutorialStep };
    this.pendingTutorialStep = null;
    this.roundElapsed = 0;
    if (!this.roundStats[0]) this.roundStats[0] = freshRoundStats();
    for (const id of IDS) {
      this.boxers[id].neutralize(this._clock(id));
      if (this.ais[id]) { this.ais[id].reset(this.wt); this.ais[id].setScript(this.tut.step, this.wt); }
    }
    this._setPhase(P.FIGHTING);
    this._setStage(this.tut.step);
  }

  _tutorialGo(idx, driven) {
    const R = this.rules, tut = this.tut;
    tut.index = idx;
    tut.step = R.tutorialSteps[idx];
    tut.stepStart = this.t;
    tut.count = 0;
    tut.holdMs = 0;
    if (driven) tut.driven = true;
    for (const id of IDS) {
      const ai = this.ais[id];
      if (!ai) continue;
      this.boxers[id].cancelWindup();
      ai.setScript(tut.step, this.wt);
    }
    this._setStage(tut.step);
  }

  _tickTutorial(h) {
    const R = this.rules, tut = this.tut;
    const human = this.boxers.p1.isHuman ? this.boxers.p1 : this.boxers.p2;
    const want = tut.step === 'guard-body' ? 'low' : 'high';
    if (human.isHuman && human.guard === want && human.guardAmount >= this.tuning.guardMinAmount) tut.holdMs += h; else tut.holdMs = 0;
    if (!tut.driven && R.tutorialStepMaxMs > 0 && this.t - tut.stepStart >= R.tutorialStepMaxMs) {
      if (tut.index + 1 < tut.total) this._tutorialGo(tut.index + 1, false);
      else this.endTutorial();
    }
  }

  // ───────────────────────────── internals: result & view ─────────────────────────────

  _clockDisplay() {
    const R = this.rules;
    return Math.max(0, R.clockDisplayMs * (1 - this.roundElapsed / R.roundRealMs));
  }

  _clockVisible() {
    const ph = this.phase === P.PAUSED ? this.pausedFrom : this.phase;
    switch (ph) {
      case P.FIGHTING: return !this.tut;
      case P.KNOCKDOWN: return !!this.kd && !this.result && this.t < this.kd.fallClockUntil;
      case P.ROUND_END: return this.stage === 'bell';
      default: return false;
    }
  }

  /** Lock the result (exactly once — MAT04). */
  _resolveResult({ winner, method, scorecards, decisionType }) {
    if (this.result) return this.result;
    const statsOf = (b) => ({ ...b.stats, damageDealt: Math.round(b.stats.damageDealt * 100) / 100, damageTaken: Math.round(b.stats.damageTaken * 100) / 100 });
    const r = {
      id: this.id,
      winner: winner || null,
      method,
      endRound: this.round,
      endClockMs: Math.round(this._clockDisplay()),
      scorecards: (scorecards || []).map((c) => ({ judge: c.judge, p1: c.p1, p2: c.p2, rounds: (c.rounds || []).map((x) => ({ p1: x.p1, p2: x.p2 })) })),
      stats: { p1: statsOf(this.boxers.p1), p2: statsOf(this.boxers.p2) },
      mode: this.mode,
      opponentId: this.opponent ? this.opponent.id : null,
      // extras
      decisionType: decisionType || null,
      knockdowns: { p1: this.boxers.p1.knockdowns, p2: this.boxers.p2.knockdowns },
      names: { p1: this.boxers.p1.name, p2: this.boxers.p2.name },
      rounds: this.roundStats.map((rs) => ({ p1: { ...rs.p1, damage: Math.round(rs.p1.damage * 100) / 100 }, p2: { ...rs.p2, damage: Math.round(rs.p2.damage * 100) / 100 } })),
      seed: this.seed,
      durationMs: Math.round(this.t),
      // KO: the final blow (real or debugKnockdown's synthetic one) for the outro replay
      finalBlow: method === ResultMethod.KO && this.kd && this.kd.blow ? { ...this.kd.blow } : null,
    };
    this.result = deepFreeze(r);
    this.resultAt = this.t;
    return this.result;
  }

  _judge() {
    const R = this.rules, rng = this.rngJudges;
    const cards = [];
    const votes = { p1: 0, p2: 0, even: 0 };
    const rounds = this.roundStats.slice(0, Math.min(this.round, R.rounds));
    for (const j of R.judges) {
      const w = j.w || {};
      let s1 = 0, s2 = 0;
      const per = [];
      for (const rs of rounds) {
        const a = rs.p1, b = rs.p2;
        const diff = (w.damage || 0) * (a.damage - b.damage)
          + (w.landed || 0) * (a.landed - b.landed)
          + (w.counters || 0) * (a.counters - b.counters)
          + (w.defense || 0) * (a.defense - b.defense)
          + (w.activity || 0) * (a.thrown - b.thrown)
          + R.knockdownRoundWeight * (a.kdScored - b.kdScored)
          // judges disagree a little about busy rounds, never about empty ones
          + rng.normal(0, R.judgeNoise) * clamp01((a.thrown + b.thrown) / 10);
        let r1 = 10, r2 = 10;
        if (diff > R.evenMargin) r2 = 9; else if (diff < -R.evenMargin) r1 = 9;
        r1 = Math.max(R.minRoundScore, r1 - a.kdSuffered * R.knockdownPointPenalty);
        r2 = Math.max(R.minRoundScore, r2 - b.kdSuffered * R.knockdownPointPenalty);
        s1 += r1; s2 += r2;
        per.push({ p1: r1, p2: r2 });
      }
      cards.push({ judge: j.name, p1: s1, p2: s2, rounds: per });
      if (s1 > s2) votes.p1++; else if (s2 > s1) votes.p2++; else votes.even++;
    }
    const need = Math.floor(R.judges.length / 2) + 1;
    const winner = votes.p1 >= need ? 'p1' : votes.p2 >= need ? 'p2' : null;
    let decisionType = 'draw';
    if (winner) decisionType = votes[winner] === R.judges.length ? 'unanimous' : votes.even > 0 && votes[other(winner)] === 0 ? 'majority' : 'split';
    return { cards, winner, decisionType, votes };
  }

  /** Legacy banner, kept in sync with the stages/calls (the HUD may use view.call/stage instead). */
  _banner() {
    const R = this.rules, t = this.t;
    const n = (id) => (id ? this.boxers[id].name : '');
    const opp = this.opponent;
    const lc = this.lastCall;
    const fightText = lc && lc.payload.call === 'fight' && t - lc.at < R.fightTextMs;
    switch (this.phase) {
      case P.INTRO:
        return { text: `${n('p1')} vs ${n('p2')}`, sub: opp ? `"${opp.nickname}" · ${opp.intro}` : 'Versus', kind: 'intro' };
      case P.ROUND_START:
        if (this.stage === 'fight') return { text: 'Fight!', kind: 'fight' };
        return { text: this.round >= R.rounds && R.rounds > 1 ? 'Final round' : `Round ${this.round}`, sub: this.round >= R.rounds && R.rounds > 1 ? `Round ${this.round}` : `of ${R.rounds}`, kind: 'round' };
      case P.FIGHTING:
        if (this.tut) return null;
        return fightText ? { text: 'Fight!', kind: 'fight' } : null;
      case P.KNOCKDOWN: {
        const kd = this.kd;
        if (this.result) return { text: 'K.O.!', sub: `${n(this.result.winner)} wins`, kind: 'ko' };
        if (!kd) return null;
        if (kd.count > 0) return { text: String(kd.count), sub: `${n(kd.downed)} is down`, kind: 'count' };
        if (this.stage === 'down-call') return { text: 'Down!', sub: `${n(kd.downed)} is down`, kind: 'knockdown' };
        return null;
      }
      case P.RECOVERY:
        if (this.stage === 'fight') return { text: 'Fight!', kind: 'fight' };
        return { text: `${n(this.rec ? this.rec.riser : null)} is up!`, sub: 'Box on', kind: 'getup' };
      case P.ROUND_END:
        return { text: this.round >= R.rounds ? 'Time!' : `End of round ${this.round}`, kind: 'roundEnd' };
      case P.BETWEEN:
        return { text: `Round ${this.round + 1} next`, sub: this.round + 1 >= R.rounds ? 'Final round' : 'Catch your breath', kind: 'between' };
      case P.DECISION:
        return { text: "Judges' decision", sub: this._methodText(), kind: 'decision' };
      case P.RESULT: {
        const r = this.result;
        if (!r) return null;
        return { text: r.winner ? `${n(r.winner)} wins!` : 'Draw!', sub: this._methodText(), kind: 'result' };
      }
      case P.PAUSED:
        return { text: 'Paused', kind: 'paused' };
      default:
        return null;
    }
  }

  _methodText() {
    const r = this.result;
    if (!r) return null;
    switch (r.method) {
      case ResultMethod.KO: return `Knockout in round ${r.endRound}`;
      case ResultMethod.DECISION: return `${r.decisionType === 'unanimous' ? 'Unanimous' : r.decisionType === 'majority' ? 'Majority' : 'Split'} decision`;
      default: return 'The judges could not split them';
    }
  }
}
