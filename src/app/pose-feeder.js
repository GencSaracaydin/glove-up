// PoseFeeder — scripted "camera" for tests and debugging (window.__glove.injectPose).
//
// Synthetic players (input/synthetic.js) perform queued actions; every camera tick (≈30 Hz) the
// feeder renders their poses into PoseFrames and pushes them through the REAL pipeline:
// InputHub.injectFrames → PlayerAssigner → GestureRecognizer → ControlState + punch events →
// Match / TrainingActivity. Nothing is faked below the landmark level.
//
//   const feeder = new PoseFeeder(hub, { noise: 0.5 });
//   feeder.push('guard-high', 1500);          // P1 holds a guard …
//   feeder.push('jab-left', 450);             // … then jabs; steps run back to back
//   feeder.push('lean-left', 900, { player: 1 });   // a second synthetic player (versus)
//   feeder.stop();                            // everybody leaves the picture (frames stop)
//   per frame (the app loop, before InputHub.update): feeder.tick(performance.now())
//
// Continuity: each player keeps ONE growing script, so a new step blends from the pose the
// previous one ended in (no teleporting skeleton). After the last step the final posture is
// held, like a person standing still in front of the camera, until stop().

import { makeSyntheticPlayer, sequence, SYNTH_ACTIONS } from '../input/synthetic.js';

/** Tunables (documented; tests may override via the constructor). */
export const FEEDER_DEFAULTS = Object.freeze({
  /** Camera frame rate of the fake camera. */
  fps: 30,
  /** Base seed of the synthetic players (player i uses seed + i). */
  seed: 7,
  /** Tracker noise 0..1 (1 = realistic jitter, lag, dropouts; see SYNTH_DEFAULTS). */
  noise: 0.5,
  /** Player → camera distance (m). */
  distance: 2.2,
  /** Sideways offset (m) of each player when two are fed (P1 left in the mirrored preview). */
  versusLateral: 0.55,
  /** After a long main-thread stall, render at most this much missed time (ms). */
  maxCatchUpMs: 1000,
  /** Frame size reported to the pipeline. */
  width: 640,
  height: 480,
});

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class Feed {
  constructor(player, opts) {
    this.player = player;
    this.opts = opts;
    this.sp = null;
    this.steps = [];
    this.script = null;
    this.start = 0;
    this.active = false;
  }

  /** (Re)create the synthetic body for 1 or 2 players in the picture. */
  body(players) {
    const o = this.opts;
    // synthetic.js: +lateral = toward the RAW image's right, which is the LEFT of the mirrored
    // preview — where PlayerAssigner puts P1. So P1 gets +lateral, P2 −lateral.
    const lateral = players === 2 ? (this.player === 0 ? o.versusLateral : -o.versusLateral) : 0;
    const key = `${players}|${lateral}`;
    if (this.sp && this._key === key) return this.sp;
    this._key = key;
    this.sp = makeSyntheticPlayer({
      seed: o.seed + this.player, noise: o.noise, distance: o.distance + (players === 2 ? 0.4 : 0), lateral,
      width: o.width, height: o.height, fps: o.fps,
    });
    return this.sp;
  }

  push(action, ms, extra, t) {
    if (!this.active) {
      this.steps = [];
      this.start = t;
      this.active = true;
    } else if (this.script) {
      // the script ran out before this push: stretch the last step so the new one starts now
      const end = this.start + this.script.totalMs;
      if (end < t && this.steps.length) this.steps[this.steps.length - 1].ms += t - end;
    }
    this.steps.push({ ...extra, action, ms });
    this.script = sequence(this.steps);
    return { startsAt: this.start + this.script.totalMs - ms, endsAt: this.start + this.script.totalMs };
  }

  pose(t, players) {
    if (!this.active || !this.script) return null;
    return this.body(players).pose(Math.max(0, t - this.start), this.script);
  }
}

export class PoseFeeder {
  /**
   * @param {{injectFrames: Function}} hub   InputHub (or anything with injectFrames)
   * @param {Partial<typeof FEEDER_DEFAULTS> & {now?: () => number}} [opts]  now: clock (default performance.now)
   */
  constructor(hub, opts = {}) {
    const { now, ...rest } = opts;
    this.hub = hub;
    this.now = typeof now === 'function' ? now : nowMs;
    this.opts = { ...FEEDER_DEFAULTS, ...rest };
    this.feeds = [new Feed(0, this.opts), new Feed(1, this.opts)];
    this.nextT = null;
    this.framesSent = 0;
  }

  /** True while at least one synthetic player is in the picture. */
  get active() { return this.feeds.some((f) => f.active); }

  /**
   * Queue an action for a synthetic player.
   * @param {string} action   one of SYNTH_ACTIONS (e.g. 'guard-high', 'jab-left', 'duck')
   * @param {number} [ms]     how long the step lasts (punches finish their motion regardless)
   * @param {{player?:0|1, hand?:string, amount?:number, speedMs?:number}} [extra]
   * @returns {{player:number, startsAt:number, endsAt:number}} performance.now() times of the step
   */
  push(action, ms = 800, extra = {}) {
    if (!SYNTH_ACTIONS.includes(action)) throw new Error(`injectPose: unknown action "${action}". Known: ${SYNTH_ACTIONS.join(', ')}`);
    const { player = 0, ...rest } = extra || {};
    const i = player === 1 ? 1 : 0;
    const t = this.now();
    if (this.nextT === null || !this.active) this.nextT = t;
    const dur = Math.max(1, Number(ms) || 800);
    const r = this.feeds[i].push(action, dur, rest, t);
    return { player: i, ...r };
  }

  /** Remove one synthetic player (or everybody) from the picture: frames stop / they vanish. */
  stop(player = null) {
    for (const f of this.feeds) if (player === null || f.player === player) f.active = false;
    if (!this.active) this.nextT = null;
  }

  /** Render and inject every camera frame that is due at `now` (call once per app frame, before hub.update). */
  tick(now = this.now()) {
    if (!this.active || this.nextT === null) return 0;
    const step = 1000 / this.opts.fps;
    if (now - this.nextT > this.opts.maxCatchUpMs) this.nextT = now - this.opts.maxCatchUpMs;
    const players = this.feeds[1].active ? 2 : 1;
    const frames = [];
    while (this.nextT <= now) {
      const t = this.nextT;
      const poses = [];
      for (const f of this.feeds) {
        if (!f.active) continue;
        const p = f.pose(t, players);
        if (p) poses.push(p);
      }
      frames.push({ t, width: this.opts.width, height: this.opts.height, players: poses });
      this.nextT += step;
    }
    if (frames.length) {
      this.hub.injectFrames(frames);
      this.framesSent += frames.length;
    }
    return frames.length;
  }

  /** When the queued script of a player ends (performance.now() ms), or null when idle. */
  busyUntil(player = 0) {
    const f = this.feeds[player === 1 ? 1 : 0];
    return f.active && f.script ? f.start + f.script.totalMs : null;
  }
}
