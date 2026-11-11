// First-bout tutorial runner (research/mechanics.md §8, ARCHITECTURE.md §6.9).
//
// A profile's first single-player bout starts with six LIVE steps against the first opponent,
// before the round clock runs: stance → guard face → punch face → guard body → punch body → dodge.
// Each card advances when its pose is HELD (stance, guards: 1 s) or its action is DETECTED 3 times
// (punches at that height, dodges), with a 10 s cap per card; the whole thing can be skipped. Then
// match.endTutorial() → "Fight!" and the clock starts.
//
// Who does what:
//   game/match.js        rules.tutorial = true runs the bout in tutorial mode (no clock, no damage,
//                        a scripted, passive opponent per step); setTutorialStep(step) / endTutorial().
//                        Its view.tutorial {count, holdMs} also counts blocks / landed hits / dodges.
//   input/tutorial-detect.js  TutorialStepTracker: the same step logic from the player's own input
//                        (ControlState holds, punch events at a height, edge-triggered dodges), so a
//                        step completes even when the scripted opponent never gets a punch in.
//   ui/hud.js            hud.showTutorial({step, index, total, progress01, mode}) / hud.hideTutorial().
//   this file            drives the cards: whichever source completes a step first wins.
//
// Time: update(now) takes the session's GAME clock (ms) — it freezes while paused, so the 10 s cap
// never runs out behind a pause screen. Works with the camera and with the keyboard (KeyboardInput
// fills ControlState.stanceMs / guardMs too).
//
// Webcam calibration: the stance card re-checks that the player is tracked, centred and in a
// fighting stance, but the full CalibrationSession (label swap, arm length) still runs before the
// bout for an uncalibrated boxer — its later steps (raise your right hand, three punches per hand)
// have no tutorial counterpart, so folding it in would not be safe.

import { TutorialStepTracker } from '../input/tutorial-detect.js';

/** Tunables (ms). */
export const TUTORIAL_TUNING = Object.freeze({
  /** Card order — the step names game/match.js and ui/hud.js use. */
  steps: Object.freeze(['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge']),
  /** The same steps in input/tutorial-detect.js naming. */
  inputStep: Object.freeze({
    stance: 'stance', 'guard-head': 'guard-face', 'punch-head': 'punch-face',
    'guard-body': 'guard-body', 'punch-body': 'punch-body', dodge: 'dodge',
  }),
  /** Every card advances after this long at the latest (§8: 10 s cap). */
  capMs: 10000,
  /** A completed card shows its check mark this long before the next card (§8: 1–2 s between cards). */
  doneMs: 1100,
  /** Hold time for the stance / guard cards and detections for the punch / dodge cards (§8). */
  holdMs: 1000,
  count: 3,
  /** ?fast=1 (tests): short cap and check-mark beat. */
  fast: Object.freeze({ capMs: 4000, doneMs: 200 }),
});

const HOLD_STEPS = new Set(['stance', 'guard-head', 'guard-body']);

/**
 * Runs the six tutorial cards of one bout.
 *
 *   const tut = new TutorialRunner({ match, hud, mode: 'keyboard', onDone: ({skipped}) => … });
 *   per frame (live, not paused):  tut.update(gameNowMs, p1PlayerInput, match.getView());
 *   skip:                          tut.skip();
 */
export class TutorialRunner {
  /**
   * @param {Object} o
   * @param {{setTutorialStep:Function, endTutorial:Function, getView?:Function}} o.match
   * @param {{showTutorial?:Function, hideTutorial?:Function}|null} [o.hud]
   * @param {'camera'|'keyboard'|(() => 'camera'|'keyboard')} [o.mode]   caption wording (HUD)
   * @param {boolean} [o.fast]
   * @param {Partial<typeof TUTORIAL_TUNING>} [o.tuning]
   * @param {(info:{skipped:boolean, steps:Array<{step:string, reason:string, ms:number}>}) => void} [o.onDone]
   * @param {(info:{step:string, index:number, reason:string, ms:number}) => void} [o.onStep]  a card completed
   */
  constructor({ match, hud = null, mode = 'camera', fast = false, tuning = {}, onDone = null, onStep = null } = {}) {
    this.match = match;
    this.hud = hud;
    this._mode = mode;
    this.tuning = { ...TUTORIAL_TUNING, ...(fast ? TUTORIAL_TUNING.fast : {}), ...(tuning || {}) };
    this.onDone = onDone;
    this.onStep = onStep;
    this.tracker = new TutorialStepTracker();
    this.index = -1;
    this.stage = 'waiting';     // 'waiting' (match intro) → 'card' → 'done' (check mark) → … → 'finished'
    this.cardAt = 0;
    this.doneAt = 0;
    this.progress01 = 0;
    this.count = 0;
    this.reason = null;
    this.skipped = false;
    this.log = [];              // completed cards: {step, reason, ms}
  }

  get steps() { return this.tuning.steps; }
  get total() { return this.tuning.steps.length; }
  get step() { return this.index >= 0 ? this.tuning.steps[this.index] : null; }
  /** True until the last card is done (or the tutorial was skipped). */
  get active() { return this.stage !== 'finished'; }
  get finished() { return this.stage === 'finished'; }
  get mode() { const m = typeof this._mode === 'function' ? this._mode() : this._mode; return m === 'keyboard' ? 'keyboard' : 'camera'; }

  /**
   * Advance the cards.
   * @param {number} now                     the session's game clock (ms)
   * @param {{control?:object, events?:object[]}|null} input   P1's PlayerInput this frame
   * @param {object} [view]                  this frame's MatchView (else match.getView())
   */
  update(now, input, view) {
    if (this.stage === 'finished') return this.state();
    const v = view || (typeof this.match.getView === 'function' ? this.match.getView() : null);
    const vt = v && v.tutorial;
    if (this.stage === 'waiting') {
      if (!vt) {
        // the match left its intro without a tutorial (skipped before it began, or no tutorial rule)
        if (v && v.phase !== 'intro' && v.phase !== 'paused') this._finish(false);
        return this.state();
      }
      this._startCard(0, now);
    } else if (!vt && v && v.phase !== 'paused') {
      // the match ended the tutorial by itself (its own fallback timer, or endTutorial elsewhere)
      this._finish(false);
      return this.state();
    }
    const T = this.tuning;
    if (this.stage === 'card') {
      const st = this.tracker.update(input || null, now);
      const step = this.step;
      // the match's own counters: blocks / landed hits / dodges, and the guard held
      let mk = 0;
      if (vt && vt.step === step) {
        mk = HOLD_STEPS.has(step) ? (Number(vt.holdMs) || 0) / T.holdMs : (Number(vt.count) || 0) / T.count;
        if (step === 'stance') mk = 0; // the match has no stance check
      }
      this.progress01 = Math.min(1, Math.max(st.progress01 || 0, mk));
      this.count = Math.max(st.count || 0, vt && vt.step === step ? Number(vt.count) || 0 : 0);
      let reason = null;
      if (st.done && st.reason !== 'cap') reason = st.reason;
      else if (mk >= 1) reason = HOLD_STEPS.has(step) ? 'hold' : 'count';
      else if (now - this.cardAt >= T.capMs) reason = 'cap';
      if (reason) {
        this.reason = reason;
        this.stage = 'done';
        this.doneAt = now;
        if (reason !== 'cap') this.progress01 = 1;
        const info = { step, index: this.index, reason, ms: Math.round(now - this.cardAt) };
        this.log.push({ step, reason, ms: info.ms });
        try { this.onStep?.(info); } catch (e) { console.error('[tutorial] onStep failed', e); }
      }
      this._show();
    } else if (this.stage === 'done' && now - this.doneAt >= T.doneMs) {
      if (this.index + 1 < this.total) this._startCard(this.index + 1, now);
      else this._finish(false);
    }
    return this.state();
  }

  /** Skip the rest: "Fight!" right away (the bout keeps its pause state if paused). */
  skip() {
    if (this.stage === 'finished') return false;
    this.skipped = true;
    this._finish(true);
    return true;
  }

  /** Snapshot for debugging / tests / window.__glove.state(). */
  state() {
    return {
      stage: this.stage, step: this.step, index: this.index, total: this.total, progress01: +this.progress01.toFixed(3),
      count: this.count, reason: this.reason, skipped: this.skipped, done: this.log.map((l) => l.step),
    };
  }

  // ───────────────────────────── internals ─────────────────────────────

  _startCard(i, now) {
    this.index = i;
    this.stage = 'card';
    this.cardAt = now;
    this.progress01 = 0;
    this.count = 0;
    this.reason = null;
    const step = this.step;
    try { this.match.setTutorialStep(step); } catch (e) { console.error('[tutorial] setTutorialStep failed', e); }
    this.tracker.setStep(this.tuning.inputStep[step] || step, now);
    this._show();
  }

  _show() {
    if (!this.hud || typeof this.hud.showTutorial !== 'function') return;
    this.hud.showTutorial({ step: this.step, index: this.index, total: this.total, progress01: this.progress01, mode: this.mode });
  }

  _finish(skipped) {
    const was = this.stage;
    this.stage = 'finished';
    if (was !== 'finished') {
      try { this.match.endTutorial(); } catch (e) { console.error('[tutorial] endTutorial failed', e); }
      try { this.hud?.hideTutorial?.(); } catch { /* the HUD also closes the card when view.tutorial goes */ }
      try { this.onDone?.({ skipped: !!skipped, steps: this.log.slice() }); } catch (e) { console.error('[tutorial] onDone failed', e); }
    }
  }
}
