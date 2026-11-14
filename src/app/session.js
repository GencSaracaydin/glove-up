// Activity sessions: one running bout (MatchSession) or one practice session with turns
// (TrainingRun). They own the game-logic object, its pausable game clock, the renderer scene and
// the HUD for the activity; the App (app.js) owns the loop, input, menus and saving.
//
// Time: the app passes the REAL frame dt; game logic advances by dt × renderer.timeScale so
// hit-stop (render/fx.js, research/mechanics.md §2.8) stalls the fight and the round clock exactly
// as measured, while the renderer keeps measuring real time for cameras and effects (see
// render/renderer.js "time contract"). The human corner stalls with it (decision D6: its rate limit
// stays on match time, or flurries would run far faster than measured), but the session tells the
// Match that it is stalled, so a punch recognised during the stall is queued instead of dropped.
// The dodge slow motion (§2.5) is NOT applied here: Match runs
// the opponent's corner and the round clock at ×0.25 itself while the dodging human stays real-time
// (ARCHITECTURE.md §6.3). Each session keeps its own game clock (`gameNow`, ms) that only runs while
// the activity is live, so pausing (SES01/SES02, ERR02) freezes everything exactly where it was.
//
// A bout's life: begin() → intro (→ first-bout tutorial, app/tutorial.js) → rounds … → the result
// locks (`over`: the app saves it right away) → RESULT → the bout outro (renderer.playOutro, §6
// "KO outro": logo wipe, flash, replay, win banner, winner pose; ARCHITECTURE.md §6.5) → `finished`
// (the app shows the decision reveal / results card). skipOutro() jumps to the end of the outro.
//
// Spec: MAT01–MAT04 (Match), SES01/SES02 (pause, restart, quit keep/clear state), UI01 (versus
// split screen), TRN01/TRN02 (training turns and results).

import { MatchPhase } from '../core/types.js';
import { Match } from '../game/match.js';
import { TrainingSession } from '../training/session.js';
import { TutorialRunner } from './tutorial.js';

/** Presentation timings of the app around the game modules (ms). */
export const SESSION_TUNING = Object.freeze({
  /** Without a renderer outro (headless tests, no WebGL): keep the winner on screen this long after RESULT. */
  resultLingerMs: 1800,
  resultLingerFastMs: 600,
  /** After a drill ends ("TIME!"), keep the scene this long before the result screen. */
  trainingLingerMs: 1700,
  trainingLingerFastMs: 600,
  /** ?fast=1 training: short drills for tests. */
  fastTraining: Object.freeze({ durationMs: 8000, readyMs: 1200 }),
});

const clampDt = (dt) => (Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0);
const call = (v) => (typeof v === 'function' ? v() : v);

/** Combine the app seed with a counter → a new deterministic seed (or random when no seed). */
export function deriveSeed(base, n) {
  if (base === null || base === undefined || base === '') return Math.floor(Math.random() * 0x7fffffff);
  let h = 2166136261 >>> 0;
  for (const c of `${base}|${n}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 0x7fffffff;
}

/** Profile → the boxer description Match expects for a human corner. */
export function humanCorner(profile, fallbackName) {
  return {
    name: profile?.name || fallbackName,
    appearance: profile?.appearance || null,
    isHuman: true,
  };
}

/** Strip discrete events (punches, pauses) from PlayerInputs: controls only (bout over / outro). */
function controlsOnly(inputs) {
  return (inputs || []).map((p) => (p ? { control: p.control || null, events: [] } : null));
}

/**
 * One bout: single player (P2 = roster opponent, driven by the AI) or local versus (two humans,
 * split screen). restart() starts the same pairing again from scratch (SES02).
 */
export class MatchSession {
  /**
   * @param {Object} o
   * @param {import('../core/events.js').EventBus} o.bus
   * @param {import('../render/renderer.js').GameRenderer|null} o.renderer
   * @param {import('../ui/hud.js').Hud|null} o.hud
   * @param {'single'|'versus'} o.mode
   * @param {Object[]} o.players     [P1 profile] or [P1 profile, P2 profile]
   * @param {Object} [o.opponent]   roster entry (single player)
   * @param {number|string|null} [o.seed]
   * @param {boolean} [o.fast]      FAST_RULES (?fast=1)
   * @param {number|null|(() => number|null)} [o.latencyMs]  camera → game latency for the human corners
   *        (calibration.latencyMs, research/mechanics.md §4.6); a function is read at every (re)start; null = Match default
   * @param {boolean} [o.tutorial]  run the first-bout tutorial (single player, ARCHITECTURE.md §6.9)
   * @param {'camera'|'keyboard'|(() => string)} [o.inputMode]  tutorial caption wording
   * @param {(info:{skipped:boolean}) => void} [o.onTutorialDone]  the tutorial finished or was skipped
   */
  constructor({ bus, renderer, hud, mode, players, opponent = null, seed = null, fast = false, latencyMs = null, tutorial = false, inputMode = 'camera', onTutorialDone = null }) {
    this.kind = 'match';
    this.bus = bus;
    this.renderer = renderer;
    this.hud = hud;
    this.mode = mode === 'versus' ? 'versus' : 'single';
    this.players = players.slice(0, this.mode === 'versus' ? 2 : 1);
    this.opponent = opponent;
    this.seed = seed;
    this.fast = !!fast;
    this.latencyMs = latencyMs;
    this.tutorialWanted = this.mode === 'single' && !!tutorial;
    this.inputMode = inputMode;
    this.onTutorialDone = onTutorialDone;
    this.tutorialDone = false;
    this.attempt = 0;
    this.match = null;
    this.tutorial = null;
    this.paused = false;
    this.finished = false;
    this.hudActive = false;
    this.outro = null;
    this._view = null;
    this._finishedWaiters = [];
  }

  /** How many humans take part (InputHub players). */
  get humans() { return this.mode === 'versus' ? 2 : 1; }
  /** Display names of the human corners (tracking-lost screen). */
  nameOf(i) { return this.players[i]?.name || `Player ${i + 1}`; }

  /** Build a fresh Match and put it on screen (also used by restart()). */
  begin() {
    this.attempt++;
    const p1 = humanCorner(this.players[0], 'Player 1');
    const p2 = this.mode === 'versus' ? humanCorner(this.players[1], 'Player 2') : this.opponent;
    const lat = call(this.latencyMs);
    // a tutorial that was finished or skipped is not repeated by "Start over"
    const tutorial = this.tutorialWanted && !this.tutorialDone;
    this.match = new Match({
      bus: this.bus, mode: this.mode, p1, p2, rng: deriveSeed(this.seed, `match:${this.attempt}`), fast: this.fast,
      ...(Number.isFinite(lat) ? { latencyMs: lat } : {}),
      ...(tutorial ? { rules: { tutorial: true } } : {}),
    });
    this.tutorial = tutorial ? new TutorialRunner({
      match: this.match, hud: this.hud, fast: this.fast, mode: () => call(this.inputMode),
      onDone: (info) => this._tutorialFinished(info),
    }) : null;
    this.gameNow = 0;
    this.resultAt = null;
    this.outro = null;
    this.finished = false;
    this.paused = false;
    this._view = null;
    this._finishedWaiters = this._finishedWaiters || [];
    if (this.renderer) {
      this.renderer.resetMatch();
      this.renderer.setSplit(this.mode === 'versus' ? 2 : 1);
      this.renderer.setScene('match');
    }
    this.hud?.hideTutorial?.(); // a restarted bout never shows the old attempt's card
    this.hud?.show('match', { mode: this.mode });
    this.hudActive = true;
    this.match.start(this.gameNow); // emits MATCH_INTRO (renderer intro cinematic, crowd)
    this._view = this.match.getView();
  }

  /** SES02: Start over clears every transient state and begins the same pairing again. */
  restart() { this.begin(); }

  pause() { if (this.match && !this.paused) { this.match.pause(); this.paused = true; this._view = this.match.getView(); } }
  resume() { if (this.match && this.paused) { this.match.resume(); this.paused = false; this._view = null; } }

  /** Pausing is pointless (and quitting would discard a decided bout) once the result is locked. */
  get canPause() { return !!this.match && !this.match.isOver() && !this.finished; }
  /**
   * Human player i may leave the picture right now: their opponent is down for the count (a player's request,
   * 2026-11-13). The app then neither asks for i's hands nor pauses for i; once the opponent is up again (or
   * counted out) tracking matters again. The player who is down still needs tracking — pumping the arms gets them up.
   * @param {0|1} i
   */
  trackingOptional(i) {
    const m = this.match;
    if (!m || this.paused || m.isOver() || m.phase !== MatchPhase.KNOCKDOWN) return false;
    const down = m.downed;
    return !!down && down !== (i === 1 ? 'p2' : 'p1');
  }
  /** The result is locked (MAT04) — the app saves it now; the bout keeps playing its KO call / outro. */
  get over() { return !!this.match?.isOver(); }
  /** What play() hands to the app: a match as soon as its result is locked. */
  get handoff() { return this.over; }
  get result() { return this.match?.getResult() || null; }
  get view() { return this._view || (this.match ? this.match.getView() : null); }
  /** The first-bout tutorial is running (cards on screen, no clock yet). */
  get tutorialActive() { return !!this.tutorial && this.tutorial.active; }
  /** The bout outro (renderer.playOutro) is playing. */
  get outroActive() { return !!this.outro && !this.outro.done; }

  /** Skip the rest of the tutorial: "Fight!" now (ARCHITECTURE.md §6.9). */
  skipTutorial() { return this.tutorial ? this.tutorial.skip() : false; }

  /** Jump to the end of the bout outro (confirm / Enter / hands up). */
  skipOutro() {
    if (!this.outroActive) return false;
    this.outro.skipped = true;
    try { this.renderer?.skipOutro?.(); } catch (e) { console.error('[session] skipOutro failed', e); }
    return true;
  }

  /** Resolves when the bout is finished: the outro is over (or the linger elapsed without one). */
  whenFinished() {
    if (this.finished) return Promise.resolve(this.result);
    return new Promise((resolve) => this._finishedWaiters.push(resolve));
  }

  /**
   * Advance the bout.
   * @param {number} realDt  real seconds since the last frame
   * @param {number} now     performance.now()
   * @param {import('../core/types.js').PlayerInput[]} inputs  [P1, P2?] from InputHub
   */
  update(realDt, now, inputs) {
    if (!this.match || this.paused) return;
    const raw = this.renderer ? this.renderer.timeScale : 1;
    const scale = Number.isFinite(raw) ? raw : 1;
    const dt = clampDt(realDt) * scale;
    this.gameNow += dt * 1000;
    // once the result is locked nothing the players do counts (MAT04): their figures still mirror them
    const inp = this.over ? controlsOnly(inputs) : (inputs || []);
    this.match.update(dt, this.gameNow, { p1: inp[0] || null, p2: this.mode === 'versus' ? inp[1] || null : null }, { stalled: scale < 1 });
    this._view = this.match.getView();
    if (this.tutorial && this.tutorial.active) this.tutorial.update(this.gameNow, inp[0] || null, this._view);
    if (this.match.phase === MatchPhase.RESULT && this.resultAt === null) this._enterResult(now);
    if (this.resultAt !== null && !this.outro && !this.finished) {
      const linger = this.fast ? SESSION_TUNING.resultLingerFastMs : SESSION_TUNING.resultLingerMs;
      if (now - this.resultAt >= linger) this._finish();
    }
  }

  /** Draw the bout (+HUD while it is the main view). */
  render(realDt, hudExtras) {
    const view = this.view;
    if (!view) return;
    this.renderer?.renderMatch(view, realDt);
    if (this.hudActive) this.hud?.update(view, hudExtras || {});
  }

  /** Leave the HUD (result screens come next); the scene keeps animating behind the menus. */
  releaseHud() {
    this.hudActive = false;
    this.hud?.hideTutorial?.();
    this.hud?.hide();
  }

  /** Small snapshot for window.__glove.state() / the debug overlay. */
  debug() {
    const v = this.view;
    if (!v) return null;
    const b = (id) => ({ hp: v.boxers[id].hp, hp01: +v.boxers[id].hp01.toFixed(3), phase: v.boxers[id].phase, knockdowns: v.boxers[id].knockdowns, guard: v.boxers[id].guard });
    const st = this.match.boxers;
    return {
      kind: 'match', mode: this.mode, id: this.match.id, attempt: this.attempt, phase: v.phase, pausedFrom: v.pausedFrom,
      stage: v.stage ?? null, round: v.round, clockMs: Math.round(v.clockDisplayMs), clockVisible: v.clockVisible ?? null,
      downed: v.downed, count: v.count, call: v.call ? v.call.call : null, paused: this.paused,
      slowmo: v.slowmo ? { dodger: v.slowmo.dodger, msLeft: Math.round(v.slowmo.msLeft) } : null, latencyMs: v.latencyMs ?? null,
      tutorial: this.tutorial ? this.tutorial.state() : null,
      outro: this.outro ? { active: !this.outro.done, skipped: !!this.outro.skipped } : null,
      over: this.over, finished: this.finished, result: this.result ? { winner: this.result.winner, method: this.result.method, id: this.result.id } : null,
      p1: b('p1'), p2: b('p2'),
      stats: { p1: { ...st.p1.stats }, p2: { ...st.p2.stats } },
    };
  }

  // ───────────────────────────── internals ─────────────────────────────

  _tutorialFinished(info) {
    this.tutorialDone = true;
    try { this.onTutorialDone?.(info); } catch (e) { console.error('[session] onTutorialDone failed', e); }
  }

  /** RESULT reached: play the bout outro (ARCHITECTURE.md §6.5), or linger when there is none. */
  _enterResult(now) {
    this.resultAt = now;
    const r = this.renderer;
    if (!r || typeof r.playOutro !== 'function') return;
    const outro = { done: false, skipped: false };
    this.outro = outro;
    let p;
    try {
      p = r.playOutro({ result: this.result, view: this._view, fast: this.fast });
    } catch (e) {
      console.error('[session] playOutro failed', e);
      p = null;
    }
    const match = this.match;
    Promise.resolve(p).then(() => {
      if (this.outro !== outro || this.match !== match) return; // restarted / dropped meanwhile
      outro.done = true;
      this._finish();
    }, (e) => {
      console.error('[session] the bout outro failed', e);
      if (this.outro !== outro || this.match !== match) return;
      outro.done = true;
      this._finish();
    });
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    const waiters = this._finishedWaiters.splice(0);
    for (const w of waiters) { try { w(this.result); } catch { /* ignore */ } }
  }
}

/**
 * A practice session: 1–4 participants take turns at one activity (TRN01/TRN02). The App
 * decides what happens between turns (result screen, retry, next participant).
 */
export class TrainingRun {
  /**
   * @param {Object} o
   * @param {import('../core/events.js').EventBus} o.bus
   * @param {import('../render/renderer.js').GameRenderer|null} o.renderer
   * @param {import('../ui/hud.js').Hud|null} o.hud
   * @param {'bag'|'dodge'|'mitts'} o.kind
   * @param {Object[]} o.participants  profiles in turn order
   * @param {number|string|null} [o.seed]
   * @param {boolean} [o.fast]
   * @param {null|((participant:Object) => number|null)} [o.latencyMs]  camera → game latency for a participant
   *        (null = the activity uses participant.calibration.latencyMs or its default graces)
   */
  constructor({ bus, renderer, hud, kind, participants, seed = null, fast = false, latencyMs = null }) {
    this.kind = 'training';
    this.activity = kind;
    this.bus = bus;
    this.renderer = renderer;
    this.hud = hud;
    this.fast = !!fast;
    this.latencyMs = latencyMs;
    this.session = new TrainingSession({ participants, kind, seed: deriveSeed(seed, `training:${kind}`) });
    this.act = null;
    this.paused = false;
    this.finished = false;
    this.hudActive = false;
  }

  get humans() { return 1; }
  /** The participant whose turn it is. */
  get participant() { return this.session.current()?.participant || null; }
  nameOf() { return this.participant?.name || 'Player'; }

  /** Start (or restart, SES02) the current participant's attempt. */
  begin() {
    const cur = this.session.current();
    if (!cur) throw new Error('No training turn left.');
    const lat = typeof this.latencyMs === 'function' ? this.latencyMs(cur.participant) : this.latencyMs;
    this.act = this.session.createActivity({
      bus: this.bus, ...(this.fast ? SESSION_TUNING.fastTraining : {}), ...(Number.isFinite(lat) ? { latencyMs: lat } : {}),
    });
    this.gameNow = 0;
    this.endAt = null;
    this.finished = false;
    this.paused = false;
    if (this.renderer) {
      this.renderer.setSplit(1);
      this.renderer.setScene('training');
    }
    this.hud?.show('training', { training: this.activity, participant: cur.participant, turn: cur.index, turns: cur.turns });
    this.hudActive = true;
    this.act.start(this.gameNow);
  }

  restart() { this.begin(); }

  pause() { if (this.act && !this.paused) { this.act.pause(); this.paused = true; } }
  resume() { if (this.act && this.paused) { this.act.resume(); this.paused = false; } }

  get canPause() { return !!this.act && !this.act.isDone() && !this.finished; }
  /** Drills never let tracking lapse (no knockdowns). */
  trackingOptional() { return false; }
  get over() { return !!this.act?.isDone(); }
  /** What play() hands to the app: a drill once its closing beat has played. */
  get handoff() { return this.finished; }
  get result() { return this.act?.getResult() || null; }
  get view() { return this.act ? this.act.getView() : null; }
  get tutorialActive() { return false; }
  get outroActive() { return false; }

  update(realDt, now, inputs) {
    if (!this.act || this.paused) return;
    const scale = this.renderer ? this.renderer.timeScale : 1;
    const dt = clampDt(realDt) * (Number.isFinite(scale) ? scale : 1);
    this.gameNow += dt * 1000;
    // D6, as in bouts: a punch recognised during a drill's hit-stop pop is queued, never dropped
    this.act.update(dt, this.gameNow, inputs[0] || null, { stalled: scale < 1 });
    if (this.act.isDone() && this.endAt === null) this.endAt = now;
    const linger = this.fast ? SESSION_TUNING.trainingLingerFastMs : SESSION_TUNING.trainingLingerMs;
    if (this.endAt !== null && now - this.endAt >= linger) this.finished = true;
  }

  render(realDt, hudExtras) {
    const view = this.view;
    if (!view) return;
    this.renderer?.renderTraining(view, realDt);
    if (this.hudActive) this.hud?.updateTraining(view, hudExtras || {});
  }

  releaseHud() {
    this.hudActive = false;
    this.hud?.hide();
  }

  debug() {
    const v = this.view;
    const cur = this.session.current();
    return {
      kind: 'training', activity: this.activity, phase: v?.phase ?? null, score: v ? Math.round(v.score) : 0,
      timeLeftMs: v ? Math.round(v.timeLeftMs) : 0, paused: this.paused, over: this.over, finished: this.finished,
      turn: cur ? cur.index : null, turns: this.session.turns, participant: cur?.participant?.name ?? null,
      latencyMs: this.act?.latencyMs ?? null,
      result: this.result ? { id: this.result.id, score: this.result.score, medal: this.result.medal } : null,
    };
  }
}
