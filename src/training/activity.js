// Training activities — the shared base class (TRN01 practice activities, TRN02 results).
//
// Owner: training. Pure logic: no DOM, no three.js — imports cleanly in Node.
//
// Lifecycle of one attempt by one participant:
//   READY  — `readyMs` countdown (the HUD shows "READY?" + the activity rule); punches are ignored.
//   ACTIVE — the `durationMs` clock runs; punches / leans score. When the clock hits 0:00 no new
//            punches are taken, but punches and balls already in flight still count (they were
//            thrown before the bell) — at most TRAINING_TIMING.overtimeMs.
//   DONE   — the TrainingResult is resolved exactly ONCE (getResult() + one Ev.TRAIN_END). The world
//            keeps animating (a falling bag, a ball rolling away) but nothing scores any more.
//   pause()/resume() freeze and restore everything exactly (SES02 "continuing restores the same
//   activity state"); a paused activity ignores input.
//
// Time: the activity keeps its own pausable clock `t` (ms since start), advanced from `now`
// deltas like game/match.js (clamped per update, fixed sub-steps for the physics) so a paused
// activity, a hitch or a background tab never makes it jump.
//
// The player's own boxer is a game/boxer.js `Boxer` used stand-alone (as documented there): its
// guard / lean / hands follow ControlState, PunchInput events start punches with the same travel
// and recovery times as a match, and toView() is the BoxerView the renderer ghosts in front of the
// camera. Each activity decides what a punch hits when its glove arrives (`_resolvePunch`).
//
// Feedback (all on the shared EventBus, payloads documented in core/types.js Ev):
//   Ev.TRAIN_START {kind, participant, id, durationMs}
//   Ev.TRAIN_SCORE {kind, delta, applied, total, reason, pos?}   on every score change
//   Ev.TRAIN_EVENT {kind, type, ...}   e.g. bag-hit, bag-break, bag-new, ball-throw, ball-dodge,
//                                       ball-hit, target-up, mitt-hit, trainer-hit, target-expire
//   Ev.TRAIN_END   TrainingResult      exactly once
// `pos` fields are world positions in metres (render/style.js LAYOUT space) so the renderer can
// put sparks / dust / whooshes where things happen.

import { Ev } from '../core/types.js';
import { Boxer } from '../game/boxer.js';
import { COMBAT } from '../game/combat.js';
import { toRng } from '../core/rng.js';
import { medalFor } from './medals.js';

/** Phases of a training activity (TrainingView.phase). */
export const TrainingPhase = Object.freeze({ READY: 'ready', ACTIVE: 'active', DONE: 'done' });

/** Shared timing knobs (ms). Every activity can override any of them through its own tuning. */
export const TRAINING_TIMING = Object.freeze({
  readyMs: 3000,          // "READY?" countdown before the clock starts
  durationMs: 60000,      // default activity length (spec §9: training duration — one minute)
  maxStepMs: 100,         // one update never advances the activity more than this
  substepMs: 1000 / 120,  // fixed simulation sub-step (pendulum, balls)
  overtimeMs: 1500,       // after time-up, wait at most this long for things already in flight
  popupLifeMs: 1500,      // popups stay in the view this long (the HUD shows the young ones)
  maxPopups: 10,
  sampleKeepMs: 1500,     // ControlState history kept for latency-fair judging (dodges)
});

/**
 * World layout of the training props, shared by the logic (hit tests) and render/training-props.js.
 * Metres, Y up, ring centre at the origin; the player stands at LAYOUT.p1Pos facing −Z, so the
 * player's right is world +X. Values mirror render/style.js LAYOUT and render/boxer-model.js BODY
 * (duplicated so this logic never loads three.js; a unit test keeps them in sync).
 */
export const TRAINING_LAYOUT = Object.freeze({
  playerPos: Object.freeze([0, 0, 0.575]),  // = LAYOUT.p1Pos
  opponentPos: Object.freeze([0, 0, -0.575]), // = LAYOUT.p2Pos (where the player's punches are aimed)
  headY: 1.29,          // head centre of a height-1.0 boxer in stance
  headZ: 0.555,
  headRadius: 0.17,
  /** Where the player's gloves land (the ghost model aims at an opponent standing at p2Pos). */
  punch: Object.freeze({
    planeZ: -0.35,      // front of the glove at full extension
    headY: 1.21,        // straights / hooks to the head
    uppercutY: 1.13,
    bodyY: 0.92,
    straightX: 0.02,    // straights cut in to the centre line …
    hookX: 0.11,        // … hooks land wider (player's left = −X)
  }),
  /** Head displacement per unit ControlState lean (ghost model + renderer root shift). */
  lean: Object.freeze({ x: 0.29, duckY: 0.21, duckFwd: 0.2, upY: 0.05 }),
  /** Glove contact shift per unit lean (shoulders move less than the head): sideways, duck, lean-in reach. */
  gloveLean: Object.freeze({ x: 0.22, duckY: 0.14, z: 0.07 }),
});

/** Combat tuning for the trainee: the match's punch timings, without the low-stamina slow-down
 *  (pounding the bag for a minute must never make the gloves lag behind the player's arms). */
export const TRAINEE_COMBAT = Object.freeze({ ...COMBAT, lowStaminaTravelMul: 1 });

// ───────────────────────────── small helpers (exported for the activities) ─────────────────────────────

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (k) => { k = clamp01(k); return k * k * (3 - 2 * k); };
export const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** Linear ramp a→b for difficulty d ∈ [0,1]; `range` is [a, b] or a plain number. */
export function ramp(range, d) {
  return Array.isArray(range) ? lerp(range[0], range[1], clamp01(d)) : range;
}

/** Deep-ish merge of tuning objects (plain objects merge, everything else replaces). */
export function mergeTuning(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base ? base[k] : undefined;
    out[k] = isPlain(v) && isPlain(b) ? mergeTuning(b, v) : v;
  }
  return out;
}
function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** World position of the player's head for a lean (x: player's right = +, y: duck = −). */
export function headWorld(lean, out = [0, 0, 0], layout = TRAINING_LAYOUT) {
  const L = layout.lean;
  const lx = clamp(num(lean?.x), -1, 1), ly = clamp(num(lean?.y), -1, 1);
  out[0] = layout.playerPos[0] + lx * L.x;
  out[1] = layout.headY + (ly < 0 ? ly * L.duckY : ly * L.upY);
  out[2] = layout.headZ + (ly < 0 ? ly * L.duckFwd : 0);
  return out;
}

/**
 * Where a punch from `hand` lands (world, metres) — the ghost glove's contact point, shifted by the
 * puncher's lean when given (leaning carries the shoulders; leaning in reaches further).
 */
export function punchContact(punch, out = [0, 0, 0], layout = TRAINING_LAYOUT, lean = null) {
  const P = layout.punch, G = layout.gloveLean;
  const side = punch?.hand === 'right' ? 1 : -1;
  const kind = punch?.kind;
  const lx = clamp(num(lean?.x), -1, 1), ly = clamp(num(lean?.y), -1, 1), lz = clamp(num(lean?.z), -1, 1);
  out[0] = side * (kind === 'hook' ? P.hookX : P.straightX) + lx * G.x;
  out[1] = (punch?.target === 'body' ? P.bodyY : kind === 'uppercut' ? P.uppercutY : P.headY) + Math.min(0, ly) * G.duckY;
  out[2] = P.planeZ - lz * G.z;
  return out;
}

let idCounter = 0;
/** Unique-per-attempt result id (storage.recordTraining is idempotent by it — SES02). */
export function makeResultId(kind, rng) {
  idCounter = (idCounter + 1) % 1e6;
  const r = rng && typeof rng.nextUint32 === 'function' ? rng.nextUint32() : Math.floor(Math.random() * 4294967296);
  return `trn-${kind}-${Date.now().toString(36)}-${(r >>> 0).toString(36)}-${idCounter.toString(36)}`;
}

function normParticipant(p) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : 'guest',
    name: typeof o.name === 'string' && o.name ? o.name : 'Player',
    kind: typeof o.kind === 'string' ? o.kind : 'guest',
    appearance: o.appearance && typeof o.appearance === 'object' ? o.appearance : null,
  };
}

/** Accepts a PlayerInput, an InputHub.update() result ({players:[…]}) or an array of PlayerInputs. */
function normInput(input) {
  if (!input) return { control: null, events: [] };
  if (Array.isArray(input)) return normInput(input[0]);
  if (Array.isArray(input.players)) return normInput(input.players[0]);
  return { control: input.control ?? null, events: Array.isArray(input.events) ? input.events : [] };
}

// ───────────────────────────── base class ─────────────────────────────

export class TrainingActivity {
  /** TrainingKind of the subclass. */
  static KIND = 'training';
  /** Subclass tunables (merged with TRAINING_TIMING and the constructor's `tuning`). */
  static TUNING = {};

  /**
   * @param {Object} [o]
   * @param {import('../core/events.js').EventBus} [o.bus]
   * @param {import('../core/rng.js').Rng|number|string} [o.rng]  Rng or seed (deterministic drills)
   * @param {Object} [o.participant]   profile ({id, name, kind, appearance}); default guest
   * @param {Object} [o.tuning]        overrides of TRAINING_TIMING / the activity's TUNING
   * @param {number} [o.durationMs]    shorthand for tuning.durationMs
   * @param {number} [o.readyMs]       shorthand for tuning.readyMs
   * @param {string} [o.id]            result id (default: unique per attempt)
   * @param {number} [o.latencyMs]     measured camera→game latency for this player/device (widens the
   *                                   latency grace of judged moments); default: participant.calibration.latencyMs if any
   */
  constructor(o = {}) {
    this.bus = o.bus || null;
    this.rng = toRng(o.rng ?? o.seed);
    this.participant = normParticipant(o.participant);
    this.kind = this.constructor.KIND;
    const over = { ...(o.tuning || {}) };
    if (Number.isFinite(o.durationMs)) over.durationMs = o.durationMs;
    if (Number.isFinite(o.readyMs)) over.readyMs = o.readyMs;
    /** Effective tunables (read-only by convention). */
    this.tuning = mergeTuning(mergeTuning(TRAINING_TIMING, this.constructor.TUNING), over);
    this.readyMs = Math.max(0, num(this.tuning.readyMs, TRAINING_TIMING.readyMs));
    this.durationMs = Math.max(1000, num(this.tuning.durationMs, TRAINING_TIMING.durationMs));
    this.id = typeof o.id === 'string' && o.id ? o.id : makeResultId(this.kind, this.rng.fork('id'));
    const lat = Number.isFinite(o.latencyMs) ? o.latencyMs : o.participant?.calibration?.latencyMs;
    /** Camera→game latency (ms) when measured, else null (tunable graces apply). */
    this.latencyMs = Number.isFinite(lat) ? clamp(lat, 0, 400) : null;

    this.trainee = new Boxer({
      id: 'p1', isHuman: true, name: this.participant.name, appearance: this.participant.appearance,
      tuning: TRAINEE_COMBAT,
    });

    this.t = 0;
    this.started = false;
    this.paused = false;
    this.phase = TrainingPhase.READY;
    this.phaseStart = 0;
    this.activeStart = null;
    this.timeUp = false;
    this.timeUpAt = null;
    this.endedAt = null;
    this.endReason = null;
    this.result = null;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.stats = { punches: 0, landed: 0 };
    this._lastNow = null;
    this._popups = [];
    this._popupId = 0;
    this._samples = [];
    this._control = null;
    this._endEmitted = false;
    this._init();
  }

  // ───────────── public API (ARCHITECTURE.md training/*) ─────────────

  /** Begin the READY countdown (also called implicitly by the first update). */
  start(now) {
    if (this.started) return this;
    this.started = true;
    this._lastNow = Number.isFinite(now) ? now : null;
    this.phase = TrainingPhase.READY;
    this.phaseStart = this.t;
    this._emit(Ev.TRAIN_START, {
      kind: this.kind, id: this.id, durationMs: this.durationMs,
      participant: { id: this.participant.id, name: this.participant.name },
    });
    if (this.readyMs <= 0) this._goActive(this.t);
    return this;
  }

  /**
   * Advance the activity.
   * @param {number} dt   seconds since the last update (used when `now` is not given)
   * @param {number} now  ms timestamp (performance.now() domain); preferred time source
   * @param {import('../core/types.js').PlayerInput} [input]  the participant's input this frame
   *        (only 'punch' events are consumed — pausing is the app's job: call pause()/resume())
   * @param {{stalled?:boolean}} [opts]  stalled: the renderer's hit-stop is running (TrainingRun passes
   *        timeScale < 1) — a punch whose glove is not ready yet is queued (one per hand) instead of dropped (D6)
   */
  update(dt, now, input, opts = null) {
    this._stalled = !!(opts && opts.stalled);
    if (!this.started) this.start(now);
    let ms;
    if (Number.isFinite(now)) {
      ms = this._lastNow == null ? (Number.isFinite(dt) ? dt * 1000 : 0) : now - this._lastNow;
      this._lastNow = now;
    } else ms = (Number.isFinite(dt) ? dt : 0) * 1000;
    if (this.paused) return this;
    ms = clamp(ms, 0, this.tuning.maxStepMs);
    const inp = normInput(input);
    let events = inp.events.length ? inp.events : null;
    if (ms <= 0) { this._substep(0, inp.control, events); return this; }
    let rest = ms;
    while (rest > 1e-6) {
      const h = Math.min(rest, this.tuning.substepMs);
      this._substep(h, inp.control, events);
      events = null;
      rest -= h;
    }
    return this;
  }

  /** Freeze exactly where it is. Returns false if already paused. */
  pause() {
    if (this.paused) return false;
    this.paused = true;
    this._lastNow = null;
    return true;
  }

  /** Continue from the exact paused state. Returns false if not paused. */
  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this._lastNow = null;
    return true;
  }

  isPaused() { return this.paused; }
  isDone() { return this.phase === TrainingPhase.DONE; }

  /** The locked TrainingResult, or null while the attempt is still running (resolved once). */
  getResult() { return this.result; }

  /** End the attempt now (e.g. a "finish" button): the result is resolved with the score so far. */
  endNow(reason = 'ended') {
    if (!this.started) this.start(null);
    if (this.phase === TrainingPhase.READY) this._goActive(this.t);
    this._finish(reason, this.t);
    return this.result;
  }

  /** Milliseconds of the activity clock left (full duration during READY, 0 once done). */
  timeLeftMs() {
    if (this.phase === TrainingPhase.READY || this.activeStart == null) return this.durationMs;
    if (this.phase === TrainingPhase.DONE) return Math.max(0, this.durationMs - ((this.endedAt ?? this.t) - this.activeStart));
    return Math.max(0, this.durationMs - (this.t - this.activeStart));
  }

  /** Difficulty ramp 0..1 over `rampMs` of active time (activities speed up as the clock runs). */
  difficulty(t = this.t, rampMs = this.tuning.rampMs ?? this.durationMs) {
    if (this.activeStart == null) return 0;
    return clamp01((t - this.activeStart) / Math.max(1, rampMs));
  }

  /**
   * TrainingView for the renderer and HUD.
   * @returns {Object} {kind, id, phase, paused, t, timeLeftMs, durationMs, readyLeftMs, elapsedMs,
   *   score, combo, bestCombo, popups:[{id,text,kind,age,pos?}], playerView: BoxerView,
   *   participant:{id,name}, result, stats, ...activity extras (bag | balls+trainer | mitts+trainer)}
   */
  getView() {
    const t = this.t;
    const life = this.tuning.popupLifeMs;
    const popups = [];
    for (const p of this._popups) {
      const age = (t - p.born) / 1000;
      if (age * 1000 <= life) popups.push({ id: p.id, text: p.text, kind: p.kind, age, pos: p.pos });
    }
    const view = {
      kind: this.kind,
      id: this.id,
      phase: this.phase,
      paused: this.paused,
      t,
      timeLeftMs: this.timeLeftMs(),
      durationMs: this.durationMs,
      readyLeftMs: this.phase === TrainingPhase.READY ? Math.max(0, this.readyMs - (t - this.phaseStart)) : 0,
      elapsedMs: this.activeStart == null ? 0 : Math.min(this.durationMs, (this.endedAt ?? t) - this.activeStart),
      timeUp: this.timeUp,
      score: this.score,
      combo: this.combo,
      bestCombo: this.bestCombo,
      popups,
      playerView: this.trainee.toView(t),
      participant: { id: this.participant.id, name: this.participant.name },
      result: this.result,
      stats: { ...this.stats },
    };
    this._fillView(view, t);
    return view;
  }

  // ───────────── hooks for subclasses ─────────────

  /** Set up activity state (called from the constructor). */
  _init() {}
  /** The clock just started. */
  _onActive(t) { void t; }
  /** Simulate the activity world by one sub-step (every phase; check this.phase). */
  _step(h, t) { void h; void t; }
  /** A punch was just thrown (ACTIVE only). `p` is the Boxer punch {id, hand, kind, target, power, thrownAt, impactAt}. */
  _onThrown(p, t) { void p; void t; }
  /** The glove of punch `p` arrives now. @returns {{result:'hit'|'miss'|'blocked'}} */
  _resolvePunch(p, t) { void p; void t; return { result: 'miss' }; }
  /** Anything in flight that should still count after time-up (base: travelling punches). */
  _busy(t) { void t; return this.trainee.punches.some((p) => p.stage === 'travel'); }
  /** The clock hit 0:00 (stop starting new things). */
  _onTimeUp(t) { void t; }
  /** The result was just resolved. */
  _onFinish(t) { void t; }
  /** Activity-specific result breakdown (TrainingResult.details). */
  _details() { return {}; }
  /** Add activity extras to the view. */
  _fillView(view, t) { void view; void t; }

  // ───────────── helpers for subclasses ─────────────

  /** Change the score (never below 0), emit Ev.TRAIN_SCORE, optionally pop a popup. */
  _score(delta, reason, { pos = null, popup = null, popupKind = 'hit' } = {}) {
    const d = Math.round(num(delta));
    const before = this.score;
    this.score = Math.max(0, before + d);
    this._emit(Ev.TRAIN_SCORE, { kind: this.kind, delta: d, applied: this.score - before, total: this.score, reason, pos: pos || undefined });
    if (popup) this._popup(popup, popupKind, pos);
    return this.score - before;
  }

  /** Queue a popup (HUD): kind ∈ hit | good | dodge | bonus | big | break | perfect | miss | penalty | bad. */
  _popup(text, kind = 'hit', pos = null) {
    this._popups.push({ id: ++this._popupId, text: String(text), kind, born: this.t, pos: pos || undefined });
    const life = this.tuning.popupLifeMs;
    while (this._popups.length && (this.t - this._popups[0].born > life || this._popups.length > this.tuning.maxPopups)) this._popups.shift();
  }

  /** Emit Ev.TRAIN_EVENT {kind, type, ...payload}. */
  _event(type, payload = {}) {
    this._emit(Ev.TRAIN_EVENT, { kind: this.kind, type, t: this.t, ...payload });
  }

  _emit(name, payload) {
    if (this.bus && typeof this.bus.emit === 'function') this.bus.emit(name, payload);
  }

  /** Combo bookkeeping: a success extends it, a failure resets it. */
  _comboUp() { this.combo++; if (this.combo > this.bestCombo) this.bestCombo = this.combo; return this.combo; }
  _comboBreak() { this.combo = 0; }

  /** ControlState samples in [a, b] (ms), plus the last one before `a` (what was true at `a`). */
  _samplesIn(a, b) {
    const out = [];
    let before = null;
    for (const s of this._samples) {
      if (s.t < a) before = s;
      else if (s.t <= b) out.push(s);
      else break;
    }
    if (before) out.unshift(before);
    return out;
  }

  /** Most recent lean sample {t, x, y, z, tracked} (or a neutral one). */
  _latestLean() {
    return this._samples.length ? this._samples[this._samples.length - 1] : { t: this.t, x: 0, y: 0, z: 0, tracked: false };
  }

  // ───────────── internals ─────────────

  _substep(h, control, events) {
    this.t += h;
    const t = this.t;
    this._control = control;
    this.trainee.setControl(control, t);
    this._sample(control, t);
    if (this.phase === TrainingPhase.READY && t - this.phaseStart >= this.readyMs) this._goActive(t);

    if (events && this.phase === TrainingPhase.ACTIVE && !this.timeUp) {
      for (const e of events) {
        if (!e || e.type !== 'punch' || !e.punch) continue;
        const p = this.trainee.tryPunch(e.punch, t, this._stalled ? { stalled: true } : null);
        if (p && typeof p === 'object') this._thrown(p, t);
      }
    }
    const notes = this.trainee.update(t, { regen: true });
    for (const n of notes) {
      if (n.type === 'thrown' && n.punch) {
        // buffered punches start later; after the bell they are dropped
        if (this.phase === TrainingPhase.ACTIVE && !this.timeUp) this._thrown(n.punch, t);
        else this.trainee.punches = this.trainee.punches.filter((q) => q !== n.punch);
      }
    }

    this._step(h, t);

    for (const p of this.trainee.duePunches(t)) {
      let res = { result: 'miss' };
      if (this.phase === TrainingPhase.ACTIVE) {
        try { res = this._resolvePunch(p, t) || res; } catch (err) { console.error('[training] resolving a punch failed', err); }
      }
      this.trainee.onPunchResolved(p, { result: res.result, damage: 0, counter: false }, t);
    }

    if (this.phase === TrainingPhase.ACTIVE) {
      if (!this.timeUp && t - this.activeStart >= this.durationMs) {
        this.timeUp = true;
        this.timeUpAt = this.activeStart + this.durationMs;
        this.trainee.buffered = { left: null, right: null };
        this._onTimeUp(t);
        this._event('time-up');
      }
      if (this.timeUp && (!this._busy(t) || t - this.timeUpAt >= this.tuning.overtimeMs)) this._finish('time', t);
    }
  }

  _thrown(p, t) {
    this.stats.punches++;
    try { this._onThrown(p, t); } catch (err) { console.error('[training] punch hook failed', err); }
  }

  _sample(control, t) {
    const c = control && control.tracked !== false ? control : null;
    const l = c?.lean;
    const s = { t, x: clamp(num(l?.x), -1, 1), y: clamp(num(l?.y), -1, 1), z: clamp(num(l?.z), -1, 1), tracked: !!c };
    const S = this._samples;
    S.push(s);
    const cut = t - this.tuning.sampleKeepMs;
    let drop = 0;
    while (drop < S.length - 1 && S[drop].t < cut) drop++;
    if (drop) S.splice(0, drop);
  }

  _goActive(t) {
    if (this.phase !== TrainingPhase.READY) return;
    this.phase = TrainingPhase.ACTIVE;
    this.phaseStart = t;
    this.activeStart = t;
    this._event('go');
    this._onActive(t);
  }

  _finish(reason, t) {
    if (this.result) return;
    if (this.activeStart == null) this.activeStart = t;
    this.phase = TrainingPhase.DONE;
    this.phaseStart = t;
    this.endedAt = Math.min(t, this.activeStart + this.durationMs);
    this.endReason = reason;
    this.trainee.buffered = { left: null, right: null };
    try { this._onFinish(t); } catch (err) { console.error('[training] finish hook failed', err); }
    const score = Math.max(0, Math.round(this.score));
    let details = {};
    try { details = this._details() || {}; } catch (err) { console.error('[training] result details failed', err); }
    this.result = Object.freeze({
      id: this.id,
      kind: this.kind,
      score,
      medal: medalFor(this.kind, score),
      details: Object.freeze({
        ...details, punches: this.stats.punches, landed: this.stats.landed, bestCombo: this.bestCombo,
        playedMs: Math.round(this.endedAt - this.activeStart), endReason: reason,
      }),
      participantId: this.participant.id,
      participantName: this.participant.name,
      durationMs: this.durationMs,
    });
    if (!this._endEmitted) {
      this._endEmitted = true;
      this._emit(Ev.TRAIN_END, this.result);
    }
  }
}
