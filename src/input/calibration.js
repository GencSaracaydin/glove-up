// CalibrationSession: a short guided routine that measures one player so the gesture
// recognizer can work in "their" units. Steps (ARCHITECTURE.md §3):
//
//   1 'frame'        get head, shoulders, elbows and wrists (ideally hips) in the picture at a
//                    workable distance — ERR01-style "who/what is missing" messages;
//   2 'guard'        hold the gloves up by the face, still → the head's offset over the shoulders
//                    (neutralHeadRel, in shoulder widths), shoulder width, shoulder line, camera tilt
//                    (torso up-vector). The recognizer learns where "upright" is in each bout itself:
//                    an image position stored here would be stale as soon as the player stands
//                    elsewhere or the laptop moves (neutralHead / shoulderWidth are kept as metadata);
//   3 'right-hand'   raise the RIGHT hand straight up → detects mirrored feeds / swapped
//                    left-right labels (Calibration.swapSides) and measures the true arm length
//                    (an arm held up lies in the image plane, so its depth is not compressed);
//   4 'punch-left' / 'punch-right'   three punches with each hand at the screen → the head-punch
//                    height, the tracker's depth compression (zScale), and the player's natural
//                    punch speed → a suggested sensitivity. Punches thrown with the other hand are
//                    pointed out ("That was your right hand…", shown for eventMessageMs); when they
//                    keep coming from the other hand only (swapFixWrongPunches), the punch steps
//                    contradict the raise step. They may only swap left / right back to the browser
//                    default — when the raise step found them swapped and nothing confirmed it (the raise
//                    caught the LEFT hand, INPUT-06); they never swap on their own (RV-INPUT-03). Any other
//                    contradiction (no swap found; or a swap the left punch step already confirmed) asks
//                    for the right hand once more ('right-hand' again, in plain mirror terms), and only a
//                    second raise that agrees with the punches changes it. After that, only the message;
//   5 'done'. The result also stores the measured camera → game latency (Calibration.latencyMs,
//     research/mechanics.md §4.6) when the session was given one (InputHub.calibrate does that).
//
// Robust to jitter (medians, hold timers with a short grace period) and to people who need
// help (timeouts escalate to concrete advice; a step that cannot succeed falls back to safe
// defaults instead of trapping the player — the frame and guard steps, which cannot, flag
// `stuck: true` after frameGiveUpMs / guardGiveUpMs so the screen can point to skipping).
// Pure module: runs in Node for tests.

import { LM, Hand } from '../core/types.js';
import { GestureRecognizer } from './gesture.js';

/** Every tunable of the calibration routine (times in ms, sizes in frame-width units unless noted). */
export const CALIBRATION_DEFAULTS = Object.freeze({
  /** Landmarks below this visibility count as missing. */
  minVisibility: 0.5,
  /** Shoulder width (fraction of the frame width) above which the player is too close … */
  tooCloseSW: 0.4,
  /** … and below which they are too far (MediaPipe gets unreliable on tiny people). The same limit as the
   *  camera-setup check that let the player in (UI_TUNING.minShoulderWidth): 2–3 m with a wide webcam. */
  tooFarSW: 0.07,
  /** The nose this close to the top edge (fraction of the frame height) = head cut off. */
  topMargin: 0.06,
  /** Shoulder centre further than this from the frame centre (fraction of width) = off-centre. */
  maxOffCentre: 0.3,
  /** How long each check must hold (the stance/guard hold that measures the neutral pose is
   *  1 s, as research/mechanics.md §2.1 recommends). */
  frameHoldMs: 900,
  guardHoldMs: 1000,
  raiseHoldMs: 600,
  /** Short failures inside a hold are forgiven (tracking jitter). */
  graceMs: 220,
  /** Guard step: head/shoulders must move slower than this (shoulder widths per second) … */
  stillSpeedSW: 0.5,
  /** … and the wrists slower than this … */
  stillWristSpeedSW: 0.9,
  /** … measured over this baseline (ms). */
  speedBaselineMs: 200,
  /** A new message must persist this long before it replaces the shown one (no flicker). */
  messageDebounceMs: 300,
  /** Raised hand: wrist above the head centre by at least this (shoulder widths). */
  raiseAboveHeadSW: 0.45,
  /** Punches to collect per hand. */
  punchesPerHand: 3,
  /** A punch's depth-compression sample keeps the largest raw depth extent of its hand within this long before and after
   *  the fire (the recognizer's early decision fires before full extension, a retraction-confirmed one after it; the step
   *  waits for the last one). */
  punchDepthFollowMs: 150,
  /** Recognizer sensitivity while collecting calibration punches (a little eager). */
  punchSensitivity: 0.7,
  /** After this long in one step, show troubleshooting advice. */
  hintAfterMs: 5000,
  /** Steps advance when the pose is held or the action was seen punchesPerHand times, with a
   *  10 s cap (research/mechanics.md §8): after this long a punch step accepts what it has … */
  punchAcceptAfterMs: 10000,
  /** … or, with no punch at all, moves on with defaults. */
  punchGiveUpMs: 10000,
  /** After this long the right-hand step gives up and assumes unswapped labels. */
  raiseGiveUpMs: 10000,
  /** The frame and guard steps cannot move on without their measurement: after this long they flag the state
   *  `stuck: true` (the calibrate screen then points to "Skip for now") and say so in the hint. */
  frameGiveUpMs: 15000,
  guardGiveUpMs: 15000,
  /** A message about something the player just did ("That was your right hand…") stays up this long. */
  eventMessageMs: 1500,
  /** A punch step that sees this many punches from the other hand and none from the asked one contradicts the
   *  raise step: when that said "mirrored" and nothing confirmed it, left and right are swapped back to the default
   *  (once); otherwise the right hand is asked for once more and only a second raise that agrees with the punches
   *  changes it (RV-INPUT-03). */
  swapFixWrongPunches: 2,
  /** Asked for the right hand again: hands are not judged for this long (the punch that triggered it is still in
   *  flight — at a low, near camera a straight punch's wrist shows above the head). */
  recheckSettleMs: 600,
});

/** The second right-hand raise (the punch steps disagreed with the first): our own words, in mirror terms — about the
 *  body only, never which side of the picture (the preview may or may not be mirrored, the camera too). */
const RECHECK_MSG = 'Quick check: raise your own RIGHT hand high above your head. The picture may be mirrored, so go by your body, not the screen.';

const STEPS = ['frame', 'guard', 'right-hand', 'punch-left', 'punch-right', 'done'];
const STEP_WEIGHT = { frame: 0.15, guard: 0.2, 'right-hand': 0.15, 'punch-left': 0.25, 'punch-right': 0.25 };

const SWAP_PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const swapIndex = (i, swap) => {
  if (!swap) return i;
  for (const [a, b] of SWAP_PAIRS) { if (i === a) return b; if (i === b) return a; }
  return i;
};
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const vis = (l) => (l ? (l.visibility ?? l.presence ?? 1) : 0);

const STUCK_HINT = 'Stuck on this step? You can skip calibration for now and box with the default settings.';

const PART_NAMES = {
  head: 'your face', shoulders: 'both shoulders', leftElbow: 'your left elbow', rightElbow: 'your right elbow',
  leftHand: 'your left hand', rightHand: 'your right hand',
};

/**
 * Is the player framed well enough to play? Shared by the calibration 'frame' step and the
 * camera-setup screen (ERR01: say exactly what is missing).
 * @param {import('../core/types.js').PlayerPose|null} pose
 * @param {{aspect?: number, swapSides?: boolean}} [opts]
 * @returns {{ok:boolean, missing:string[], tooClose:boolean, tooFar:boolean, offCentre:boolean,
 *            cutTop:boolean, shoulderWidth:number, message:string}}
 */
export function frameCheck(pose, opts = {}) {
  const T = { ...CALIBRATION_DEFAULTS, ...(opts.tuning || {}) };
  const out = { ok: false, missing: [], tooClose: false, tooFar: false, offCentre: false, cutTop: false, shoulderWidth: 0, message: '' };
  if (!pose || !Array.isArray(pose.image) || pose.image.length < 25) {
    out.missing = ['you'];
    out.message = 'Step into the picture so the camera can see you.';
    return out;
  }
  const aspect = opts.aspect || pose.aspect || 4 / 3;
  const swap = !!opts.swapSides;
  const L = (i) => pose.image[swapIndex(i, swap)];
  const okL = (i) => { const l = L(i); return !!l && vis(l) >= T.minVisibility && l.x > -0.02 && l.x < 1.02 && l.y > -0.02 && l.y < 1.02; };
  const parts = {
    head: okL(LM.NOSE) || (okL(LM.LEFT_EYE) && okL(LM.RIGHT_EYE)),
    shoulders: okL(LM.LEFT_SHOULDER) && okL(LM.RIGHT_SHOULDER),
    leftElbow: okL(LM.LEFT_ELBOW), rightElbow: okL(LM.RIGHT_ELBOW),
    leftHand: okL(LM.LEFT_WRIST), rightHand: okL(LM.RIGHT_WRIST),
  };
  out.missing = Object.keys(parts).filter((k) => !parts[k]);
  if (parts.shoulders) {
    const a = L(LM.LEFT_SHOULDER), b = L(LM.RIGHT_SHOULDER);
    out.shoulderWidth = Math.hypot(a.x - b.x, (a.y - b.y) / aspect);
    out.tooClose = out.shoulderWidth > T.tooCloseSW;
    out.tooFar = out.shoulderWidth < T.tooFarSW;
    out.offCentre = Math.abs((a.x + b.x) / 2 - 0.5) > T.maxOffCentre;
  }
  const nose = L(LM.NOSE);
  out.cutTop = !!nose && nose.y < T.topMargin;
  if (!parts.head && !parts.shoulders) out.message = 'Step into the picture so the camera can see you.';
  else if (out.tooClose || (!parts.shoulders && parts.head)) out.message = 'Step back a little — your head, shoulders and both hands need to fit in the picture.';
  else if (!parts.head) out.message = "We can't see your face — keep your head in the picture and make sure it's well lit.";
  else if (out.cutTop) out.message = 'Your head is at the top edge — step back a little or tilt the camera down.';
  else if (out.tooFar) out.message = 'Come a little closer to the camera.';
  else if (!parts.leftHand && !parts.rightHand) out.message = "We can't see your hands — hold both hands up in front of your chest.";
  else if (!parts.leftHand || !parts.rightHand) out.message = `We can't see ${PART_NAMES[!parts.leftHand ? 'leftHand' : 'rightHand']} — keep both hands in the picture.`;
  else if (!parts.leftElbow || !parts.rightElbow) out.message = 'Step back a little so your elbows are in the picture too.';
  else if (out.offCentre) out.message = 'Move toward the middle of the picture.';
  else { out.ok = true; out.message = 'Great — stay right there.'; }
  return out;
}

/** A hold timer that forgives brief failures (tracking flicker). */
class Hold {
  constructor(needMs, graceMs) { this.need = needMs; this.grace = graceMs; this.reset(); }
  reset() { this.since = null; this.badSince = null; this.held = 0; }
  /** @returns {number} 0..1 progress */
  update(good, tMs) {
    if (good) {
      if (this.since === null) this.since = tMs;
      this.badSince = null;
    } else if (this.since !== null) {
      if (this.badSince === null) this.badSince = tMs;
      if (tMs - this.badSince > this.grace) this.reset();
    }
    this.held = this.since === null ? 0 : tMs - this.since;
    return Math.min(1, this.held / this.need);
  }
  get done() { return this.held >= this.need; }
}

export class CalibrationSession {
  /**
   * @param {{aspect?: number, tuning?: Partial<typeof CALIBRATION_DEFAULTS>,
   *          now?: () => number, latency?: number|(() => number|null)}} [opts]
   */
  constructor({ aspect = 0, tuning = {}, now, latency } = {}) {
    this.tuning = { ...CALIBRATION_DEFAULTS, ...tuning };
    /** Measured camera → game latency (ms) to store in the result: a number or a function returning
     *  one (InputHub passes () => hub.latencyMs). Absent → the result has no latencyMs. */
    this._latency = latency;
    this.aspect = aspect || 0;
    this._now = now || (() => (typeof Date !== 'undefined' ? Date.now() : 0));
    this.restart();
  }

  /** Start over from the first step. */
  restart() {
    this.step = 'frame';
    this._stepStart = null;
    this._t = null;
    this._hold = new Hold(this.tuning.frameHoldMs, this.tuning.graceMs);
    this._samples = { head: [], sw: [], shY: [], tilt: [], up: [], wsw: [], rel: [], arm: [], armBones: [] };
    this._geomHist = [];
    this._msg = { text: '', since: -Infinity, pending: null, pendingSince: 0 };
    this._swapSides = false;
    this._swapVotes = { normal: 0, swapped: 0 };
    this._punch = { left: [], right: [] };
    this._wrongHand = 0;
    this._stepWrong = 0;                       // other-hand punches in the current punch step
    this._flippedAt = null;                    // the punch step that swapped left and right back, if any
    this._recheck = null;                      // {from: punch step, claim: what the punches said} once asked again
    this._eventMsg = null;
    this._rec = null;
    this._prev = null;
    this._notes = [];
    this.result = null;
    this._last = null;
    this._progressMax = 0;
  }

  /** Redo the current step (e.g. the player asked to try again). */
  retryStep() {
    this._enter(this.step === 'done' ? 'frame' : this.step);
  }

  /** Camera frame width/height (PlayerPose.aspect overrides it). */
  setAspect(aspect) { if (aspect > 0) this.aspect = aspect; }

  /**
   * Feed one frame of this player's pose.
   * @param {import('../core/types.js').PlayerPose|null} pose
   * @param {number} tMs
   * @returns {{step:string, progress:number, message:string, ok:boolean, done:boolean,
   *            result: import('../core/types.js').Calibration|null, stepProgress:number, hint:string|null,
   *            stuck:boolean, count?:number, missing?:string[]}}  stuck: the frame / guard step has not
   *            succeeded for frameGiveUpMs / guardGiveUpMs (point to skipping)
   */
  update(pose, tMs) {
    if (this.step === 'done') return this._state(1, 'All set! Gloves up — let’s box.', true);
    if (!Number.isFinite(tMs)) tMs = this._t === null ? 0 : this._t + 33;
    if (this._t !== null && tMs <= this._t) return this._last || this._state(0, '', false);
    this._t = tMs;
    if (this._stepStart === null) this._stepStart = tMs;
    if (pose && pose.aspect > 0) this.aspect = pose.aspect;
    const elapsed = tMs - this._stepStart;
    let st;
    switch (this.step) {
      case 'frame': st = this._frame(pose, tMs, elapsed); break;
      case 'guard': st = this._guard(pose, tMs, elapsed); break;
      case 'right-hand': st = this._raise(pose, tMs, elapsed); break;
      default: st = this._punches(pose, tMs, elapsed);
    }
    this._prev = pose ? { pose, t: tMs } : null;
    this._last = st;
    return st;
  }

  // ───────────────────────────── steps ─────────────────────────────

  _enter(step) {
    this.step = step;
    this._stepStart = this._t;
    const T = this.tuning;
    this._hold = new Hold(step === 'guard' ? T.guardHoldMs : step === 'right-hand' ? T.raiseHoldMs : T.frameHoldMs, T.graceMs);
    if (step === 'guard') for (const k of ['head', 'sw', 'shY', 'tilt', 'up', 'wsw', 'rel']) this._samples[k] = [];
    // (asked again: the first raise's arm samples are kept — whichever arm went up, it measured an arm)
    if (step === 'right-hand') { this._swapVotes = { normal: 0, swapped: 0 }; if (!this._recheck) this._samples.arm = []; }
    if (step === 'punch-left' || step === 'punch-right') {
      const hand = step === 'punch-left' ? Hand.LEFT : Hand.RIGHT;
      this._punch[hand] = [];
      this._rawRecent = [];
      this._stepWrong = 0;
      this._newPunchRecognizer();
    }
    if (step === 'done') this.result = this._buildResult();
  }

  _frame(pose, tMs, elapsed) {
    const fc = frameCheck(pose, { aspect: this.aspect });
    const p = this._hold.update(fc.ok, tMs);
    if (this._hold.done) { this._enter('guard'); return this._state(0, 'Now put your gloves up by your face and hold still.', true); }
    const stuck = elapsed > this.tuning.frameGiveUpMs;
    const hint = stuck ? STUCK_HINT
      : elapsed > this.tuning.hintAfterMs && !fc.ok
        ? 'Tip: the camera should see you from the waist up with some space above your head. Bright light in front of you helps.'
        : null;
    return this._state(p, fc.ok ? 'Great — hold that spot…' : fc.message, fc.ok, { hint, missing: fc.missing, stuck });
  }

  _guard(pose, tMs, elapsed) {
    const T = this.tuning;
    const m = this._measure(pose);
    let ok = false, msg = 'Put your gloves up by your face and hold still.';
    if (!m) msg = frameCheck(pose, { aspect: this.aspect }).message;
    else {
      const up = (w) => m.headV - w[1] < 0.95 * m.sw && w[1] < m.shY + 0.1 * m.sw;     // raised to the face region
      const near = (w) => Math.abs(w[0] - m.head[0]) < 0.9 * m.sw;
      const handsUp = up(m.lw) && up(m.rw) && near(m.lw) && near(m.rw);
      const still = m.speed.body < T.stillSpeedSW && m.speed.wrists < T.stillWristSpeedSW;
      ok = handsUp && still;
      if (!handsUp) msg = 'Bring both gloves up to your chin, like you’re guarding your face.';
      else if (!still) msg = 'Hold still for a moment…';
      else msg = 'Perfect — hold it…';
      if (ok) {
        const S = this._samples;
        S.head.push(m.headRaw); S.sw.push(m.sw); S.shY.push(m.shYRaw); S.tilt.push(m.tilt);
        S.rel.push({ x: (m.head[0] - m.sc[0]) / m.sw, y: (m.head[1] - m.sc[1]) / m.sw });
        if (m.up) S.up.push(m.up);
        if (m.wsw) S.wsw.push(m.wsw);
      }
    }
    const p = this._hold.update(ok, tMs);
    if (this._hold.done && this._samples.head.length >= 5) {
      this._enter('right-hand');
      return this._state(0, 'Now raise your RIGHT hand straight up above your head.', true);
    }
    const stuck = elapsed > T.guardGiveUpMs;
    const hint = stuck ? STUCK_HINT : elapsed > T.hintAfterMs ? 'Tip: gloves up by your cheeks, elbows tucked in, and keep your head still for a second.' : null;
    return this._state(p, msg, ok, { hint, stuck });
  }

  _raise(pose, tMs, elapsed) {
    const T = this.tuning;
    const m = this._measure(pose, false, true);   // raw labels: we are finding out whether to swap
    let ok = false, msg = this._recheck ? RECHECK_MSG : 'Raise your RIGHT hand straight up above your head.';
    if (!m) msg = frameCheck(pose, { aspect: this.aspect }).message;
    else if (this._recheck && elapsed < T.recheckSettleMs) { /* let the last punch come back first */ }
    else {
      // uniform y grows downward; a hand above the top of the picture with its elbow raised counts
      const above = (w, out) => out || m.headV - w[1] > T.raiseAboveHeadSW * m.sw;
      const labelRightUp = above(m.rw, m.outUp.right), labelLeftUp = above(m.lw, m.outUp.left);
      if (labelRightUp && labelLeftUp) msg = 'Just your right hand — keep the left one down.';
      else if (labelRightUp || labelLeftUp) {
        ok = true;
        msg = 'Got it — hold it up…';
        this._swapVotes[labelRightUp ? 'normal' : 'swapped']++;
        // a straight arm held up lies in the image plane: its world length is not depth-compressed
        const arm = labelRightUp ? (m.outUp.right ? null : m.worldArm.right) : (m.outUp.left ? null : m.worldArm.left);
        if (arm) this._samples.arm.push(arm);
      }
    }
    const p = this._hold.update(ok, tMs);
    if (this._hold.done) {
      const v = this._swapVotes;
      if (this._recheck) {
        // asked again because the punches disagreed with the first raise: only a raise that agrees with them
        // changes it (RV-INPUT-03)
        const says = v.swapped > v.normal;
        if (says === this._recheck.claim) {
          this._swapSides = says;
          this._notes.push(`the second right-hand raise agreed with the punches: left and right ${says ? 'swapped (mirrored camera)' : 'not swapped'}`);
        } else this._notes.push('the second right-hand raise matched the first: left and right kept');
        return this._resumePunches(`Thanks! Now 3 punches with your ${this._recheck.from === 'punch-left' ? 'LEFT' : 'RIGHT'} hand at the screen.`);
      }
      this._swapSides = v.swapped > v.normal;
      this._enter('punch-left');
      return this._state(0, 'Nice! Now throw 3 punches with your LEFT hand at the screen.', true);
    }
    if (elapsed > T.raiseGiveUpMs && this._recheck) {
      this._notes.push('the second right-hand raise timed out: left and right kept');
      return this._resumePunches(`Let’s carry on. Throw 3 punches with your ${this._recheck.from === 'punch-left' ? 'LEFT' : 'RIGHT'} hand at the screen.`);
    }
    if (elapsed > T.raiseGiveUpMs) {
      this._notes.push('right-hand step timed out; assuming the camera is not mirrored');
      this._swapSides = false;
      this._enter('punch-left');
      return this._state(0, 'Let’s move on. Throw 3 punches with your LEFT hand at the screen.', true);
    }
    const hint = elapsed > T.hintAfterMs
      ? 'Tip: lift the hand on your RIGHT side (in the mirror picture it’s on the right of the screen) straight up, higher than your head.'
      : null;
    return this._state(p, msg, ok, { hint });
  }

  /** Back from the second right-hand raise to the punch step that asked for it (that hand's punches start over). */
  _resumePunches(message) {
    this._enter(this._recheck.from);
    return this._state(0, message, true);
  }

  _punches(pose, tMs, elapsed) {
    const T = this.tuning;
    const hand = this.step === 'punch-left' ? Hand.LEFT : Hand.RIGHT;
    const label = hand === Hand.LEFT ? 'LEFT' : 'RIGHT';
    const out = this._rec.update(pose, tMs);
    let msg = null;
    // (the arm's full extension comes up to ~punchDepthFollowMs after the recognizer fires — its early decision fires a
    // strong punch while the fist is still speeding up — or came before it — a punch confirmed by its retraction: the
    // depth-compression sample keeps the largest depth extent around the fire)
    const dNow = this._rawDepth(pose, hand);
    const rd = this._rawRecent || (this._rawRecent = []);
    if (dNow) rd.push({ t: tMs, ...dNow });
    while (rd.length && tMs - rd[0].t > T.punchDepthFollowMs) rd.shift();
    for (const sm of this._punch[hand]) {
      if (!(sm.until > tMs) || !dNow) continue;
      if (sm.rawDz === null || dNow.rawDz > sm.rawDz) { sm.rawDz = dNow.rawDz; sm.rawXY = dNow.rawXY; }
    }
    for (const ev of out.events) {
      if (ev.type !== 'punch') continue;
      if (ev.punch.hand !== hand) {
        this._wrongHand++; this._stepWrong++;
        // only the "other" hand punches, even after being told so: the punch steps contradict the raise step.
        // A player who really used the wrong hand sees the message below after the first punch and switches.
        if (this._stepWrong >= T.swapFixWrongPunches && this._punch[hand].length === 0 && !this._recheck) {
          // (the left punch step already went as the raise said — two of its punches or more: the right step alone
          // is no reason to swap back)
          const confirmed = hand === Hand.RIGHT && this._punch[Hand.LEFT].length >= T.swapFixWrongPunches;
          if (this._swapSides && this._flippedAt === null && !confirmed) {
            // the raise step said "mirrored" (browsers almost never deliver mirrored frames): it caught the LEFT
            // hand — swap left and right back to the default, once (INPUT-06)
            this._swapSides = false;
            this._flippedAt = this.step;
            this._stepWrong = 0;
            this._stepStart = tMs;   // a fresh 10 s for the three punches
            this._notes.push(`left and right were swapped back at the ${label.toLowerCase()} punch step`);
            this._newPunchRecognizer();
            this._flash(`Left and right looked swapped — fixed! Now 3 punches with your ${label} hand.`);
            break;
          }
          // the punches contradict the raise step: punches alone never swap — two mixed-up punch steps must not beat
          // a right raise (RV-INPUT-03) — nor swap back a raise the left step already confirmed. Ask for the right
          // hand once more, in mirror terms.
          this._recheck = { from: this.step, claim: !this._swapSides };
          this._notes.push(`the ${label.toLowerCase()} punch step disagreed with the raised hand: the right hand was asked for again`);
          this._enter('right-hand');
          return this._state(0, RECHECK_MSG, true);
        }
        this._flash(`That was your ${hand === Hand.LEFT ? 'right' : 'left'} hand — use your ${label} hand.`);
        continue;
      }
      const sm = { ...this._punchSample(pose, ev), until: tMs + T.punchDepthFollowMs };
      for (const r of rd) if (sm.rawDz === null || r.rawDz > sm.rawDz) { sm.rawDz = r.rawDz; sm.rawXY = r.rawXY; }
      this._punch[hand].push(sm);
    }
    const n = this._punch[hand].length;
    const need = T.punchesPerHand;
    const following = this._punch[hand].some((sm) => sm.until > tMs);
    const finish = () => {
      if (hand === Hand.LEFT) { this._enter('punch-right'); return this._state(0, 'Great! Now 3 punches with your RIGHT hand.', true); }
      this._enter('done');
      return this._state(1, 'All set! Gloves up — let’s box.', true);
    };
    if (n >= need && !following) return finish();
    if (elapsed > T.punchGiveUpMs || (elapsed > T.punchAcceptAfterMs && n >= 1)) {
      if (n === 0) this._notes.push(`no ${hand} punches detected; using defaults`);
      return finish();
    }
    if (!out.control.tracked) msg = frameCheck(pose, { aspect: this.aspect, swapSides: this._swapSides }).message;
    if (!msg) msg = n === 0 ? `Throw 3 punches with your ${label} hand at the screen.` : `Nice! ${need - n} more with your ${label} hand.`;
    const hint = elapsed > T.hintAfterMs && n < need
      ? 'Tip: snap the punch straight at the screen and pull it back — quick, like a jab.' : null;
    return this._state(n / need, msg, true, { hint, count: n });
  }

  // ───────────────────────────── measurements ─────────────────────────────

  /**
   * Geometry of one frame. `useSwap` applies the swap decided so far (false during the
   * right-hand step, which decides it). Uniform image units: x and y both in frame widths.
   */
  _measure(pose, useSwap = true, allowHandsAbove = false) {
    const T = this.tuning;
    if (!pose || !Array.isArray(pose.image) || pose.image.length < 25) return null;
    const aspect = this.aspect || pose.aspect || 4 / 3;
    const swap = useSwap && this._swapSides;
    const I = (i) => pose.image[swapIndex(i, swap)];
    const W = (i) => (Array.isArray(pose.world) && pose.world.length >= 25 ? pose.world[swapIndex(i, swap)] : null);
    // a wrist above the top of the picture with its elbow raised above the shoulder = hand up
    const outUp = {};
    for (const [h, w, e, sh] of [['left', LM.LEFT_WRIST, LM.LEFT_ELBOW, LM.LEFT_SHOULDER], ['right', LM.RIGHT_WRIST, LM.RIGHT_ELBOW, LM.RIGHT_SHOULDER]]) {
      outUp[h] = allowHandsAbove && vis(I(w)) < T.minVisibility && !!I(w) && I(w).y < 0.03 && vis(I(e)) >= T.minVisibility && I(e).y < I(sh).y;
    }
    const need = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER];
    if (!outUp.left) need.push(LM.LEFT_WRIST);
    if (!outUp.right) need.push(LM.RIGHT_WRIST);
    for (const i of need) if (vis(I(i)) < T.minVisibility) return null;
    const u = (l) => [l.x, l.y / aspect];
    const ls = u(I(LM.LEFT_SHOULDER)), rs = u(I(LM.RIGHT_SHOULDER));
    const sw = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]);
    if (!(sw > 0.01)) return null;
    // head centroid (nose + eye midpoint + ear midpoint) — the same definition gesture.js uses
    const pts = [[u(I(LM.NOSE)), 2]];
    if (vis(I(LM.LEFT_EYE)) >= T.minVisibility && vis(I(LM.RIGHT_EYE)) >= T.minVisibility) {
      const a = u(I(LM.LEFT_EYE)), b = u(I(LM.RIGHT_EYE)); pts.push([[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1]);
    }
    if (vis(I(LM.LEFT_EAR)) >= T.minVisibility && vis(I(LM.RIGHT_EAR)) >= T.minVisibility) {
      const a = u(I(LM.LEFT_EAR)), b = u(I(LM.RIGHT_EAR)); pts.push([[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1]);
    }
    let hx = 0, hy = 0, wsum = 0;
    for (const [p, k] of pts) { hx += p[0] * k; hy += p[1] * k; wsum += k; }
    const head = [hx / wsum, hy / wsum];
    const lw = u(I(LM.LEFT_WRIST)), rw = u(I(LM.RIGHT_WRIST));
    const sc = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
    // speeds (shoulder widths per second) over a ~200 ms baseline: frame-to-frame differences
    // are dominated by landmark jitter
    const speed = { body: 0, wrists: 0 };
    const hist = this._geomHist;
    while (hist.length && this._t - hist[0].t > 600) hist.shift();
    let ref = null;
    for (const g of hist) if (this._t - g.t >= T.speedBaselineMs) ref = g;
    if (ref) {
      const dt = (this._t - ref.t) / 1000;
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      speed.body = Math.max(d(head, ref.head), d(sc, ref.sc)) / sw / dt;
      speed.wrists = Math.max(d(lw, ref.lw), d(rw, ref.rw)) / sw / dt;
    }
    hist.push({ t: this._t, head, sc, lw, rw });
    // player-perspective shoulder tilt (+ = leaning to the player's right: right shoulder lower),
    // the same definition as gesture.js
    const tilt = Math.atan2(rs[1] - ls[1], Math.abs(rs[0] - ls[0]));
    // world: torso up-vector, world shoulder width, straight-arm lengths
    let up = null, wsw = null;
    const worldArm = { left: null, right: null };
    const wl = W(LM.LEFT_SHOULDER), wr = W(LM.RIGHT_SHOULDER);
    if (wl && wr && Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z) > 0.08) {
      const hl = W(LM.LEFT_HIP), hr = W(LM.RIGHT_HIP);
      const hip = hl && hr ? [(hl.x + hr.x) / 2, (hl.y + hr.y) / 2, (hl.z + hr.z) / 2] : [0, 0, 0];
      const t = [(wl.x + wr.x) / 2 - hip[0], (wl.y + wr.y) / 2 - hip[1], (wl.z + wr.z) / 2 - hip[2]];
      const tl = Math.hypot(...t);
      if (tl > 0.2) up = t.map((c) => c / tl);
      wsw = Math.hypot(wl.x - wr.x, wl.y - wr.y);
      for (const [h, s, w] of [['left', wl, W(LM.LEFT_WRIST)], ['right', wr, W(LM.RIGHT_WRIST)]]) {
        if (w) worldArm[h] = Math.hypot(w.x - s.x, w.y - s.y, w.z - s.z);
      }
    }
    return {
      sw, sc, head, headV: head[1], lw, rw, shY: sc[1], tilt, speed, up, wsw, worldArm, outUp,
      headRaw: { x: head[0], y: head[1] * aspect }, shYRaw: sc[1] * aspect,
    };
  }

  /** The recognizer that watches a punch step, set up with what is known so far (label swap, arm length…). */
  _newPunchRecognizer() {
    this._rec = new GestureRecognizer({
      calibration: this._provisional(),
      tuning: { sensitivity: this.tuning.punchSensitivity }, aspect: this.aspect || undefined,
    });
  }

  /** Show a message about something the player just did for eventMessageMs (the debounce would swallow it). */
  _flash(text) {
    this._eventMsg = { text, step: this.step, until: (this._t ?? 0) + this.tuning.eventMessageMs };
  }

  /** Features of one calibration punch (from the recognizer's view at fire time + raw depth). */
  _punchSample(pose, ev) {
    const dbg = this._rec.debug && this._rec.debug.hands[ev.punch.hand];
    const info = (dbg && dbg.fireInfo) || {};
    const d = this._rawDepth(pose, ev.punch.hand);
    return { peak: info.peak ?? null, up: info.up ?? null, wy: info.wy ?? null, rawDz: d ? d.rawDz : null, rawXY: d ? d.rawXY : null, kind: ev.punch.kind };
  }

  /** Raw (tracker) depth extent and in-plane length of a hand's shoulder→wrist vector, or null. */
  _rawDepth(pose, hand) {
    if (!(pose && Array.isArray(pose.world) && pose.world.length >= 25)) return null;
    const sh = hand === Hand.LEFT ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
    const wr = hand === Hand.LEFT ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
    const s = pose.world[swapIndex(sh, this._swapSides)], w = pose.world[swapIndex(wr, this._swapSides)];
    return s && w ? { rawDz: Math.abs(w.z - s.z), rawXY: Math.hypot(w.x - s.x, w.y - s.y) } : null;
  }

  /** Calibration from what we know so far (used to run the punch-step recognizer). */
  _provisional() {
    const S = this._samples;
    const aspect = this.aspect || 4 / 3;
    const head = S.head.length ? { x: median(S.head.map((h) => h.x)), y: median(S.head.map((h) => h.y)) } : null;
    // a straight arm held up lies in the image plane (no depth compression): its 3D length is the
    // arm length; use the upper quartile (samples include the arm on its way up). Fallback: the
    // anthropometric ratio arm ≈ 1.55 × the (world) shoulder-landmark distance.
    let arm = S.arm.length >= 3 ? [...S.arm].sort((x, y) => x - y)[Math.floor(0.75 * (S.arm.length - 1))] : null;
    if (!(arm > 0.3 && arm < 0.95) && S.wsw.length) arm = 1.55 * median(S.wsw);
    const cal = {
      version: 1,
      shoulderWidth: S.sw.length ? median(S.sw) : undefined,
      armLengthWorld: arm && arm > 0.3 && arm < 0.95 ? arm : undefined,
      neutralHead: head || undefined,
      // the head over the shoulder centre in shoulder widths (x toward the raw image's right, y down): unlike an
      // image position it does not change when the player stands elsewhere (gesture.js uses only this)
      neutralHeadRel: S.rel.length ? { x: median(S.rel.map((r) => r.x)), y: median(S.rel.map((r) => r.y)) } : undefined,
      neutralShoulderY: S.shY.length ? median(S.shY) : undefined,
      swapSides: this._swapSides,
      createdAt: 0,
      aspect,
    };
    if (S.tilt.length) cal.neutralTilt = median(S.tilt);
    if (S.up.length >= 3) {
      const u = [0, 1, 2].map((k) => median(S.up.map((v) => v[k])));
      const l = Math.hypot(...u);
      if (l > 0.5) cal.neutralUp = u.map((c) => c / l);
    }
    return cal;
  }

  _buildResult() {
    const cal = this._provisional();
    const P = [...this._punch.left, ...this._punch.right];
    // depth compression: at a punch peak the arm (≈ armLen · ext) points at the camera, so its
    // raw depth extent is zScale · sqrt((ext·L)² − xy²). ext ≈ 0.93 for a natural punch.
    if (cal.armLengthWorld) {
      const ks = [];
      for (const p of P) {
        if (p.rawDz === null || p.rawXY === null) continue;
        const along = (0.93 * cal.armLengthWorld) ** 2 - p.rawXY ** 2;
        if (along > 0.04 * cal.armLengthWorld ** 2) ks.push(p.rawDz / Math.sqrt(along));
      }
      if (ks.length >= 2) cal.zScale = clamp(median(ks), 0.35, 1.25);
    }
    // head-punch height (calibration punches are thrown "at the screen" — head height)
    const ups = P.filter((p) => p.up !== null && p.kind !== 'uppercut').map((p) => p.up);
    const wys = P.filter((p) => p.wy !== null && p.kind !== 'uppercut').map((p) => p.wy);
    if (ups.length >= 2 || wys.length >= 2) {
      cal.headPunchLevel = {
        world: ups.length >= 2 ? clamp(median(ups), -0.25, 0.6) : undefined,
        image: wys.length >= 2 ? clamp(median(wys), -0.4, 1.2) : undefined,
      };
    }
    // sensitivity from the natural punch speed: crisp punchers can use stricter settings
    // peaks were measured at punchSensitivity; convert to multiples of the default onset, then
    // pick the sensitivity at which a typical punch peaks at ~2.2× the onset (headroom for
    // weaker punches): s = 0.5 − log2(P / 2.2) / 1.3 (see gesture.js effectiveTuning)
    const peaks = P.map((p) => p.peak).filter((x) => Number.isFinite(x));
    if (peaks.length) {
      const qCal = Math.pow(2, (0.5 - this.tuning.punchSensitivity) * 1.3);
      const P50 = median(peaks) * qCal;
      cal.suggestedSensitivity = Math.round(clamp(0.5 - Math.log2(P50 / 2.2) / 1.3, 0.35, 0.85) * 100) / 100;
    }
    cal.createdAt = this._now();
    // research/mechanics.md §4.6: "Measure end-to-end latency per device during calibration and store it"
    const lat = typeof this._latency === 'function' ? this._latency() : this._latency;
    if (Number.isFinite(lat) && lat >= 0) cal.latencyMs = Math.round(Math.min(lat, 600));
    // fill anything a skipped step could not measure with neutral defaults
    if (!Number.isFinite(cal.shoulderWidth)) delete cal.shoulderWidth;
    if (!Number.isFinite(cal.armLengthWorld)) delete cal.armLengthWorld;
    if (!cal.neutralHead) delete cal.neutralHead;
    if (!cal.neutralHeadRel) delete cal.neutralHeadRel;
    if (!Number.isFinite(cal.neutralShoulderY)) delete cal.neutralShoulderY;
    if (this._notes.length) cal.notes = this._notes.slice();
    return cal;
  }

  /** Show a new message only once it has persisted for messageDebounceMs (or the step changed). */
  _stable(message) {
    const M = this._msg, t = this._t ?? 0;
    if (M.step !== this.step || !M.text) { Object.assign(M, { step: this.step, text: message, pending: null }); return message; }
    if (message === M.text) { M.pending = null; return message; }
    if (M.pending !== message) { M.pending = message; M.pendingSince = t; }
    if (t - M.pendingSince >= this.tuning.messageDebounceMs) { M.text = message; M.pending = null; }
    return M.text;
  }

  _state(stepProgress, message, ok, extra = {}) {
    const E = this._eventMsg;
    if (E && E.step === this.step && (this._t ?? 0) < E.until) {
      // an event message overrides the step's own message (no debounce) while it lasts
      message = E.text;
      Object.assign(this._msg, { step: this.step, text: message, pending: null });
    } else message = this._stable(message);
    const i = STEPS.indexOf(this.step);
    let progress = 0;
    for (let k = 0; k < i; k++) progress += STEP_WEIGHT[STEPS[k]] || 0;
    progress += (STEP_WEIGHT[this.step] || 0) * clamp(stepProgress, 0, 1);
    const done = this.step === 'done';
    // the overall bar never moves backwards (a step's own hold may restart: see stepProgress)
    this._progressMax = Math.max(this._progressMax || 0, clamp(progress, 0, 0.999));
    return {
      step: this.step,
      progress: done ? 1 : Math.round(this._progressMax * 1000) / 1000,
      stepProgress: Math.round(clamp(stepProgress, 0, 1) * 1000) / 1000,
      message,
      ok: !!ok,
      done,
      result: done ? this.result : null,
      hint: extra.hint ?? null,
      stuck: !!extra.stuck,
      ...(extra.count !== undefined ? { count: extra.count } : {}),
      ...(extra.missing ? { missing: extra.missing } : {}),
    };
  }
}
