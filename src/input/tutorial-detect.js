// Tutorial detection helpers for the first-bout tutorial (research/mechanics.md §8, ARCHITECTURE
// §6.9): six live steps — stance → guard face → punch face → guard body → punch body → dodge. Each
// step advances when the pose is HELD (stance, guards) or the action is DETECTED 3 times (punches,
// dodges), with a 10 s cap.
//
// Pure helpers over the input the app already has (ControlState / InputEvent, camera or keyboard):
//
//   stanceHeld(control, heldMs?)            fists up, steady, centred — for ≥ heldMs (default 1 s)
//   guardHeld(control, 'high'|'low', ms?)   that guard, convincingly, for ≥ ms (default 1 s)
//   punchMatches(event, 'head'|'body')      a punch event aimed at that target
//   dodgeDetected(control, thresholds?)     'left'|'right'|'duck'|'back'|'forward'|null
//
// The hold times come from ControlState.stanceMs / guardMs, which GestureRecognizer and
// KeyboardInput keep (how long the stance / the current guard has lasted), so these functions need
// no state of their own. TutorialStepTracker wraps them into the step logic (hold / 3 detections /
// cap, edge-triggered dodges) for the tutorial runner:
//
//   const tr = new TutorialStepTracker();
//   tr.setStep('guard-face', now);
//   const s = tr.update(playerInput, now);   // → {step, progress01, count, need, heldMs, done, reason, ok}
//
// Thresholds mirror game/combat.js (guardMinAmount 0.35; dodge lean 0.42 / duck 0.42 / back 0.62),
// so a pose that passes here is a block / dodge in the bout. Pass `thresholds` to follow changes.

import { GuardKind, Target } from '../core/types.js';

export const TUTORIAL_STEPS = Object.freeze(['stance', 'guard-face', 'punch-face', 'guard-body', 'punch-body', 'dodge']);

export const TUTORIAL_DETECT = Object.freeze({
  /** Hold time (ms) that completes the stance and guard steps (research/mechanics.md §2.1: a 1 s hold). */
  holdMs: Object.freeze({ stance: 1000, 'guard-face': 1000, 'guard-body': 1000 }),
  /** Detections that complete the punch and dodge steps (§8: "detected 3 times"). */
  detections: 3,
  /** Every step advances after this long anyway (§8: 10 s cap). */
  capMs: 10000,
  /** A guard counts from this ControlState.guardAmount up (= COMBAT.guardMinAmount). */
  minGuardAmount: 0.35,
  /** Dodge thresholds in lean units (= COMBAT.dodgeLeanThreshold / duckThreshold / backLeanThreshold;
   *  `forward` mirrors the back lean: §2.1 lists tilting forward as a dodge direction too). With the
   *  camera these are crossed when the nose moves ≥ 0.35 shoulder widths sideways / the head drops
   *  ≥ 0.35 SW / the upper body sways ≥ ≈ 11 cm away from or toward the camera, at any distance
   *  (input/gesture.js lean tunables). */
  dodge: Object.freeze({ x: 0.42, y: 0.42, z: 0.62, forward: 0.62 }),
  /** After a dodge, |lean| must fall below this fraction of its threshold before the next one counts. */
  dodgeReleaseFrac: 0.5,
  /** Fallback stance test when a ControlState has no stanceMs (older producers): fists at least this
   *  high (SW from the shoulder line), within this far of the centre, not reaching, lean below. */
  stanceMinY: -0.6,
  stanceMaxDx: 0.95,
  stanceMaxReach: 0.6,
  stanceMaxLean: 0.3,
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Is the player in a fighting stance right now (tracked, fists up in front, steady, centred)?
 * Uses ControlState.stanceMs when the producer keeps it, else a geometric check.
 * @param {import('../core/types.js').ControlState|null|undefined} control
 */
export function isStance(control) {
  if (!control || control.tracked === false) return false;
  if (finite(control.stanceMs)) return control.stanceMs > 0;
  const T = TUTORIAL_DETECT;
  const h = control.hands || {};
  for (const k of ['left', 'right']) {
    const s = h[k];
    if (!s || s.punching || !(s.y >= T.stanceMinY) || Math.abs(s.x) > T.stanceMaxDx || s.reach > T.stanceMaxReach) return false;
  }
  const l = control.lean || { x: 0, y: 0, z: 0 };
  return Math.abs(l.x || 0) < T.stanceMaxLean && Math.abs(l.y || 0) < T.stanceMaxLean && Math.abs(l.z || 0) < T.stanceMaxLean;
}

/**
 * Tutorial step 1: the fighting stance has been held for at least `heldMs`.
 * (Producers without ControlState.stanceMs: use TutorialStepTracker, which times isStance itself.)
 * @param {import('../core/types.js').ControlState|null|undefined} control
 * @param {number} [heldMs]
 */
export function stanceHeld(control, heldMs = TUTORIAL_DETECT.holdMs.stance) {
  return isStance(control) && finite(control.stanceMs) && control.stanceMs >= heldMs;
}

/**
 * Is this guard up right now, convincingly enough to block in the bout?
 * @param {import('../core/types.js').ControlState|null|undefined} control
 * @param {'high'|'low'} height
 * @param {{minGuardAmount?:number}} [opts]
 */
export function isGuard(control, height, { minGuardAmount = TUTORIAL_DETECT.minGuardAmount } = {}) {
  if (!control || control.tracked === false) return false;
  const want = height === GuardKind.LOW || height === 'body' ? GuardKind.LOW : GuardKind.HIGH;
  const amount = finite(control.guardAmount) ? control.guardAmount : 1;
  return control.guard === want && amount >= minGuardAmount;
}

/**
 * Tutorial steps 2 and 4: that guard has been held for at least `heldMs`.
 * @param {import('../core/types.js').ControlState|null|undefined} control
 * @param {'high'|'low'} height   'high' = guard your face, 'low' = guard your body
 * @param {number} [heldMs]
 */
export function guardHeld(control, height, heldMs = TUTORIAL_DETECT.holdMs['guard-face']) {
  return isGuard(control, height) && finite(control.guardMs) && control.guardMs >= heldMs;
}

/**
 * Tutorial steps 3 and 5: is this a punch at the given target? Accepts an InputEvent
 * ({type:'punch', punch}), a bus payload ({player, punch}) or a bare PunchInput.
 * @param {object|null|undefined} event
 * @param {'head'|'body'} target   uppercuts are head punches
 */
export function punchMatches(event, target) {
  if (!event) return false;
  if (event.type !== undefined && event.type !== 'punch') return false;
  const p = event.punch || event;
  if (!p || (p.hand !== 'left' && p.hand !== 'right')) return false;
  const want = target === Target.BODY || target === 'body' ? Target.BODY : Target.HEAD;
  return p.target === want;
}

/**
 * Tutorial step 6: which dodge (if any) the lean shows right now — the same thresholds that make a
 * dodge in the bout. Sideways wins over duck / back / forward when several are past.
 * @param {import('../core/types.js').ControlState|null|undefined} control
 * @param {{x?:number, y?:number, z?:number, forward?:number}} [thresholds]
 * @returns {null|'left'|'right'|'duck'|'back'|'forward'}
 */
export function dodgeDetected(control, thresholds = TUTORIAL_DETECT.dodge) {
  if (!control || control.tracked === false || !control.lean) return null;
  const th = { ...TUTORIAL_DETECT.dodge, ...(thresholds || {}) };
  const { x = 0, y = 0, z = 0 } = control.lean;
  const side = Math.abs(x) >= th.x ? Math.abs(x) / th.x : 0;
  const duck = -y >= th.y ? -y / th.y : 0;
  const back = -z >= th.z ? -z / th.z : 0;
  const fwd = z >= th.forward ? z / th.forward : 0;
  const best = Math.max(side, duck, back, fwd);
  if (!best) return null;
  if (best === side) return x < 0 ? 'left' : 'right';
  if (best === duck) return 'duck';
  return best === back ? 'back' : 'forward';
}

/** True when every lean axis is back below `frac` × its threshold (ready for the next dodge). */
export function leanReleased(control, thresholds = TUTORIAL_DETECT.dodge, frac = TUTORIAL_DETECT.dodgeReleaseFrac) {
  if (!control || !control.lean) return true;
  const th = { ...TUTORIAL_DETECT.dodge, ...(thresholds || {}) };
  const { x = 0, y = 0, z = 0 } = control.lean;
  return Math.abs(x) < th.x * frac && -y < th.y * frac && -z < th.z * frac && z < th.forward * frac;
}

/**
 * Step logic for the tutorial runner: feed it the player's input every tick.
 * Hold steps (stance, guard-face, guard-body) complete after their hold; punch steps after
 * `detections` matching punches; the dodge step after `detections` separate dodges (lean out past
 * a threshold, come back, …). Every step completes after capMs regardless (reason 'cap').
 */
export class TutorialStepTracker {
  /**
   * @param {{step?:string, tuning?:Partial<typeof TUTORIAL_DETECT>, thresholds?:object}} [opts]
   */
  constructor({ step = 'stance', tuning = {}, thresholds = null } = {}) {
    this.tuning = { ...TUTORIAL_DETECT, ...tuning, holdMs: { ...TUTORIAL_DETECT.holdMs, ...(tuning.holdMs || {}) } };
    this.thresholds = { ...TUTORIAL_DETECT.dodge, ...(thresholds || {}) };
    this.setStep(step, null);
  }

  /** Start (or restart) a step; `tMs` = now (the cap counts from here; null = from the first update). */
  setStep(step, tMs = null) {
    this.step = TUTORIAL_STEPS.includes(step) ? step : 'stance';
    this.t0 = tMs;
    this.count = 0;
    this.holdSince = null;
    this.armed = true;          // dodge edge detection
    this.lastDodge = null;
    this.done = false;
    this.reason = null;
    this.state = this._state(0, 0, false);
    return this.state;
  }

  /**
   * @param {{control?:object, events?:object[]}|null} input   PlayerInput from InputHub.update()
   * @param {number} tMs
   * @returns {{step:string, progress01:number, count:number, need:number, heldMs:number, done:boolean,
   *            reason:null|'hold'|'count'|'cap', ok:boolean, dodge:null|string}}
   */
  update(input, tMs) {
    if (this.done) return this.state;
    if (this.t0 === null) this.t0 = tMs;
    const T = this.tuning;
    const c = input && input.control ? input.control : null;
    const events = input && Array.isArray(input.events) ? input.events : [];
    let progress = 0, held = 0, ok = false, dodge = null;
    const step = this.step;
    if (step === 'stance' || step === 'guard-face' || step === 'guard-body') {
      const need = T.holdMs[step];
      ok = step === 'stance' ? isStance(c) : isGuard(c, step === 'guard-face' ? GuardKind.HIGH : GuardKind.LOW);
      // the producer's own hold time when it keeps one (counted from this step's start: a pose
      // already held when the card appears still has to be held for the full time), else timed here
      const own = step === 'stance' ? c && c.stanceMs : c && c.guardMs;
      if (!ok) this.holdSince = null;
      else if (this.holdSince === null) this.holdSince = Math.max(this.t0, tMs - (finite(own) ? own : 0));
      held = ok ? tMs - this.holdSince : 0;
      progress = Math.min(1, held / need);
      if (held >= need) return this._finish('hold', progress, held, ok, null);
    } else if (step === 'punch-face' || step === 'punch-body') {
      const target = step === 'punch-face' ? Target.HEAD : Target.BODY;
      for (const e of events) if (punchMatches(e, target)) this.count++;
      ok = this.count > 0;
      progress = Math.min(1, this.count / T.detections);
      if (this.count >= T.detections) return this._finish('count', progress, 0, ok, null);
    } else if (step === 'dodge') {
      dodge = dodgeDetected(c, this.thresholds);
      if (dodge && this.armed) { this.count++; this.armed = false; this.lastDodge = dodge; }
      if (!this.armed && leanReleased(c, this.thresholds, T.dodgeReleaseFrac)) this.armed = true;
      ok = !!dodge;
      progress = Math.min(1, this.count / T.detections);
      if (this.count >= T.detections) return this._finish('count', progress, 0, ok, dodge);
    }
    if (tMs - this.t0 >= T.capMs) return this._finish('cap', progress, held, ok, dodge);
    this.state = this._state(progress, held, ok, dodge);
    return this.state;
  }

  _finish(reason, progress, held, ok, dodge) {
    this.done = true;
    this.reason = reason;
    this.state = this._state(reason === 'cap' ? progress : 1, held, ok, dodge);
    return this.state;
  }

  _state(progress01, heldMs, ok, dodge = null) {
    const isCount = this.step === 'punch-face' || this.step === 'punch-body' || this.step === 'dodge';
    return {
      step: this.step,
      progress01: Math.round(progress01 * 1000) / 1000,
      count: this.count,
      need: isCount ? this.tuning.detections : 0,
      heldMs: Math.round(heldMs),
      done: this.done,
      reason: this.reason,
      ok,
      dodge: dodge || this.lastDodge || null,
    };
  }
}
