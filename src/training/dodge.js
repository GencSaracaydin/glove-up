// Dodging drill (TRN01): the trainer winds up and throws tennis balls at your head; lean or
// duck out of the way.
//
// Owner: training. Pure logic (no DOM / three.js).
//
// How a throw works (all timings ramp from friendly to fast over DODGE_TUNING.rampMs):
//   WALK   the trainer sometimes steps to another spot (left / centre / right of the ring),
//   AIM    he cocks the ball beside his head and looks at you for aimMs (0.74 s → 0.32 s) — a big,
//          readable tell: aim + throw is never under 0.7 s (research/mechanics.md §4.6: dodgeable
//          tells ≥ 0.55 s plus webcam latency),
//   THROW  the throw gesture (420 ms, render/boxer-model.js ANIM_THROW) ends with the release,
//   FLIGHT the ball flies flightMs (0.82 s → 0.44 s) to where your HEAD WAS at the release, so you
//          cannot pre-dodge: watch the release, then move. Later in the drill:
//            * doubles — two balls, one at you and one covering the side you would slip to (or
//              the spot you would duck to), released a beat apart: pick the open escape,
//            * curve balls that bow out to one side and swing back in at your head.
//   ARRIVAL judged with latency grace (see below).
//
// Judging (spec §6 "Reward successful avoidance. Exact counting and penalties require
// validation" — our decision, all in DODGE_TUNING):
//   * In lean space (ControlState.lean, −1..1): a ball aimed at lean point A is avoided if your lean
//     is at least judge.clearRadius away from A at ANY moment in [arrival − earlyMs, arrival +
//     graceMs]. clearRadius follows the match's COMBAT.dodgeLeanThreshold (+0.03) so the drill
//     trains exactly the dodge that works in a fight. The grace covers webcam latency (the camera
//     sees a dodge ~70–150 ms after you made it; a per-device latencyMs widens it). A dodge that
//     ends before the window does not count.
//   * Score: +1 per ball avoided; while on a streak of 5+ every dodge is worth 2, on 10+ worth 3.
//   * A hit costs no points (score.hitPenalty = 0) but breaks the streak and makes your boxer
//     flinch — losing the streak bonus is the penalty. Every ball counts: doubles are two balls.
//   * Visual honesty: if at arrival you are clearly not out of the way yet (and not moving away
//     fast), the ball stops at your face for the grace period (a hit-stop) and then bounces off —
//     or, if the camera catches your dodge in time, carries on past ("just made it!").

import { COMBAT } from '../game/combat.js';
import { TrainingActivity, TrainingPhase, TRAINING_LAYOUT, headWorld, clamp, clamp01, lerp, ramp } from './activity.js';

/** Every dodging-drill tunable (ms, metres, lean units −1..1). */
export const DODGE_TUNING = Object.freeze({
  durationMs: 60000,
  rampMs: 52000,                  // difficulty 0 → 1 over this much of the drill
  trainer: Object.freeze({
    z: -2.25,                     // where the trainer stands (world z; the player is at +0.575)
    spots: Object.freeze([-0.85, 0, 0.85]),
    walkSpeed: 1.7,               // m/s between spots
    moveChance: Object.freeze([0.2, 0.55]),
    releaseY: 1.17,               // ball position at release (BoxerModel throw pose, height 1.02)
    releaseFwd: 0.52,
    releaseSide: 0.13,
    cheerMs: 900,                 // laughs it up after hitting you
  }),
  throw: Object.freeze({
    firstDelayMs: 500,            // after GO before the first wind-up
    aimMs: Object.freeze([740, 320]),
    throwAnimMs: 420,             // = ANIM_THROW.release (seconds × 1000) in render/boxer-model.js
    flightMs: Object.freeze([820, 440]),
    intervalMs: Object.freeze([2300, 1150]), // wind-up start → next wind-up start (flights overlap aims)
    recoverMs: 260,               // after the last release before the next wind-up may begin
    jitter: 0.12,
    doubleFrom: 0.22,             // difficulty from which doubles appear …
    doubleChance: Object.freeze([0.18, 0.45]),
    doubleGapMs: Object.freeze([260, 160]),
    curveFrom: 0.35,
    curveChance: Object.freeze([0.15, 0.35]),
    curveAmp: Object.freeze([0.28, 0.5]),      // m of sideways bow at mid-flight
    lowFrom: 0.5,
    lowPairChance: 0.35,          // share of doubles whose second ball goes where you would duck
    endMarginMs: 250,             // no throw whose ball would arrive after the bell
  }),
  judge: Object.freeze({
    clearRadius: COMBAT.dodgeLeanThreshold + 0.03, // 0.45 with the default combat tuning
    duckWeight: 1.0,              // scale of lean.y in the distance
    sideLane: 0.85,               // a double's cover ball sits this far to one side of the first
    lowLane: -0.85,               // … or at this duck depth
    aimClamp: 0.9,                // the trainer never aims further out than this lean
    earlyMs: 60,
    graceMs: 150,
    predictSpeed: 2.0,            // lean units/s away from the ball at arrival → let it fly past (likely dodge)
  }),
  score: Object.freeze({
    points: 1,
    streakBonus: Object.freeze([[5, 1], [10, 2]]), // [streak ≥, extra points per dodge]
    hitPenalty: 0,
    milestones: Object.freeze([5, 10, 15, 20, 25, 30, 40, 50]),
  }),
  flinchMs: 320,                  // the player's boxer flinches this long when hit
  hitDamage: 9,                   // only sizes the flinch (training never costs health)
  ball: Object.freeze({
    radius: 0.055,                // an oversized toy tennis ball (reads from across the ring)
    gravity: 9.81,
    bounce: 0.55,                 // floor restitution
    lifeAfterMs: 1700,            // a ball disappears this long after it was judged
    rebound: Object.freeze({ back: 0.3, up: 1.7, side: 0.9 }), // bounce off the face
  }),
});

const HEAD = TRAINING_LAYOUT;

export class DodgeDrill extends TrainingActivity {
  static KIND = 'dodge';
  static TUNING = DODGE_TUNING;

  _init() {
    const T = this.tuning.trainer;
    this.trainerState = { x: 0, targetX: 0, z: T.z, cheerUntil: -1e9, lastSpot: 1 };
    this.plan = null;
    this.balls = [];
    this.nextThrowAt = Infinity;
    this._ballId = 0;
    this._planId = 0;
    this.drill = { thrown: 0, dodged: 0, hits: 0, late: 0, doubles: 0, curves: 0 };
  }

  _onActive(t) {
    this.nextThrowAt = t + this.tuning.throw.firstDelayMs;
  }

  _onTimeUp() {
    // balls still in the hand are not thrown any more
    for (const b of this.balls) if (b.state === 'held') b.state = 'gone';
    this.balls = this.balls.filter((b) => b.state !== 'gone');
    this.plan = null;
    this.nextThrowAt = Infinity;
  }

  _busy() {
    return this.balls.some((b) => b.state === 'flying' || b.state === 'contact' || b.state === 'held');
  }

  /** Points for a dodge at streak length n (after counting this dodge). */
  pointsFor(n) {
    const S = this.tuning.score;
    let extra = 0;
    for (const [at, add] of S.streakBonus) if (n >= at) extra = add;
    return S.points + extra;
  }

  // ───────────── throw planning ─────────────

  _step(h, t) {
    const dt = h / 1000;
    const P = this.tuning.throw;
    if (this.phase === TrainingPhase.ACTIVE && !this.timeUp && !this.plan && t >= this.nextThrowAt) this._planThrow(t);
    // trainer walks to his spot
    const tr = this.trainerState;
    if (dt > 0 && tr.x !== tr.targetX) {
      const step = this.tuning.trainer.walkSpeed * dt;
      const d = tr.targetX - tr.x;
      tr.x = Math.abs(d) <= step ? tr.targetX : tr.x + Math.sign(d) * step;
    }
    // releases
    for (const b of this.balls) if (b.state === 'held' && t >= b.releaseAt) this._release(b, t);
    if (this.plan && t >= this.plan.lastRelease + P.recoverMs) this.plan = null;
    // flights, arrivals, judging, bounces
    for (const b of this.balls) this._stepBall(b, t, dt);
    if (this.balls.some((b) => b.state === 'gone')) this.balls = this.balls.filter((b) => b.state !== 'gone');
  }

  /**
   * Script a throw starting now (dev page, tests, demos); ACTIVE phase only and not while another
   * throw is being wound up. Unspecified fields follow the current difficulty.
   * @param {{hand?:'left'|'right', double?:boolean, low?:boolean, curve?:null|{amp:number, dir:1|-1},
   *          aimMs?:number, flightMs?:number, doubleGapMs?:number, spot?:number}} [spec]
   * @returns {Object|null} the throw plan
   */
  throwNow(spec = {}) {
    if (this.phase !== TrainingPhase.ACTIVE || this.timeUp || this.plan) return null;
    this._planThrow(this.t, spec);
    return this.plan;
  }

  _planThrow(t, spec = null) {
    const P = this.tuning.throw, T = this.tuning.trainer, rng = this.rng;
    const d = this.difficulty(t);
    const jit = (k = 1) => 1 + (rng.float() * 2 - 1) * P.jitter * k;
    const tr = this.trainerState;
    // maybe step to another spot first
    let moveMs = 0;
    if (spec && Number.isFinite(spec.spot)) {
      tr.targetX = spec.spot;
      moveMs = (Math.abs(tr.targetX - tr.x) / T.walkSpeed) * 1000;
    } else if (!spec && this.drill.thrown >= 2 && rng.chance(ramp(T.moveChance, d))) {
      const choices = T.spots.map((x, i) => i).filter((i) => i !== tr.lastSpot);
      const i = rng.pick(choices);
      tr.lastSpot = i;
      tr.targetX = T.spots[i];
      moveMs = (Math.abs(tr.targetX - tr.x) / T.walkSpeed) * 1000 + 120;
    }
    const aimMs = Number.isFinite(spec?.aimMs) ? spec.aimMs : ramp(P.aimMs, d) * jit();
    const flightMs = Number.isFinite(spec?.flightMs) ? spec.flightMs : ramp(P.flightMs, d) * jit(0.5);
    const dd = (d - P.doubleFrom) / Math.max(1e-6, 1 - P.doubleFrom);
    const isDouble = spec ? !!spec.double : d >= P.doubleFrom && rng.chance(ramp(P.doubleChance, dd));
    const cd = (d - P.curveFrom) / Math.max(1e-6, 1 - P.curveFrom);
    const isCurve = spec ? !!spec.curve : !isDouble && d >= P.curveFrom && rng.chance(ramp(P.curveChance, cd));
    const aimStart = t + moveMs;
    const throwStart = aimStart + aimMs;
    const release = throwStart + P.throwAnimMs;
    const gap = isDouble ? (Number.isFinite(spec?.doubleGapMs) ? spec.doubleGapMs : ramp(P.doubleGapMs, d)) : 0;
    const lastArrive = release + gap + flightMs;
    if (!spec && lastArrive > this.activeStart + this.durationMs - P.endMarginMs) {
      // nothing more can arrive before the bell
      tr.targetX = tr.x;
      this.nextThrowAt = Infinity;
      return;
    }
    const first = spec?.hand === 'left' || spec?.hand === 'right' ? spec.hand : rng.chance(0.5) ? 'right' : 'left';
    const id = ++this._planId;
    const balls = [];
    const mk = (hand, releaseAt, flight, lane, curve) => {
      const b = {
        id: ++this._ballId, plan: id, hand, lane, state: 'held', releaseAt, flightMs: flight, arriveAt: releaseAt + flight,
        curve, double: isDouble, R: null, C: null, aim: null, vy0: 0, pos: [0, 0, 0], vel: [0, 0, 0],
        provisional: null, judgedAt: null, result: null, contactAt: null, late: false, spin: 0,
      };
      balls.push(b);
      this.balls.push(b);
      return b;
    };
    if (isDouble) {
      const low = spec ? !!spec.low : d >= P.lowFrom && rng.chance(P.lowPairChance);
      mk(first, release, flightMs, 'aim', null);
      // the cover ball leaves a beat later but flies a touch faster: both arrive close together
      mk(first === 'right' ? 'left' : 'right', release + gap, flightMs * 0.92, low ? 'low' : 'side', null);
      this.drill.doubles++;
    } else {
      const curve = !isCurve ? null : spec?.curve && typeof spec.curve === 'object'
        ? { amp: Number.isFinite(spec.curve.amp) ? spec.curve.amp : ramp(P.curveAmp, cd), dir: spec.curve.dir === -1 ? -1 : 1 }
        : { amp: ramp(P.curveAmp, cd) * jit(0.5), dir: rng.chance(0.5) ? 1 : -1 };
      if (curve) this.drill.curves++;
      mk(first, release, flightMs, 'aim', curve);
    }
    this.plan = {
      id, aimStart, throwStart, release, lastRelease: release + gap, balls, double: isDouble,
      hands: balls.map((b) => b.hand), moveMs, aimMs,
    };
    const interval = ramp(P.intervalMs, d) * jit();
    this.nextThrowAt = Math.max(aimStart + interval, release + gap + P.recoverMs);
  }

  /** Lean the trainer aims at: where your head is now (clamped), or a cover lane for doubles. */
  _aimFor(b) {
    const J = this.tuning.judge;
    const s = this._latestLean();
    const at = { x: clamp(s.x, -J.aimClamp, J.aimClamp), y: clamp(s.y, -J.aimClamp, 0.3) };
    if (b.lane === 'aim') return at;
    const first = this.balls.find((o) => o.plan === b.plan && o.lane === 'aim');
    const base = first?.aim ?? at;
    if (b.lane === 'low') return { x: base.x, y: J.lowLane };
    // cover the side you would most likely slip to (back toward the centre if you are out wide)
    let dir;
    if (base.x > 0.2) dir = -1;
    else if (base.x < -0.2) dir = 1;
    else dir = this.rng.chance(0.5) ? 1 : -1;
    return { x: clamp(base.x + dir * J.sideLane, -1, 1), y: base.y };
  }

  /** The trainer turns to face the player from whichever spot he is on (yaw: 0 = facing +Z). */
  trainerYaw() {
    const tr = this.trainerState, P = TRAINING_LAYOUT.playerPos;
    return Math.atan2(P[0] - tr.x, P[2] - tr.z);
  }

  _releasePoint(hand) {
    const T = this.tuning.trainer, tr = this.trainerState;
    // facing the player: his right hand is on his right (world −X when he faces +Z)
    const side = hand === 'right' ? -1 : 1;
    const yaw = this.trainerYaw(), c = Math.cos(yaw), sn = Math.sin(yaw);
    const lx = side * T.releaseSide, lz = T.releaseFwd; // model space (+X = his left, +Z = forward)
    return [tr.x + lx * c + lz * sn, T.releaseY, tr.z - lx * sn + lz * c];
  }

  _release(b, t) {
    b.state = 'flying';
    b.R = this._releasePoint(b.hand);
    b.aim = this._aimFor(b);
    b.C = headWorld(b.aim);
    const F = b.flightMs / 1000, g = this.tuning.ball.gravity;
    b.vy0 = (b.C[1] - b.R[1] + 0.5 * g * F * F) / F;
    this._ballPos(b, t, b.pos);
    this.drill.thrown++;
    this._event('ball-throw', { pos: [...b.R], ball: b.id, hand: b.hand, arriveInMs: b.flightMs, lane: b.lane, curve: !!b.curve, double: b.double });
  }

  /** Analytic flight (also continues past the head along the same arc). */
  _ballPos(b, t, out) {
    const F = b.flightMs / 1000, g = this.tuning.ball.gravity;
    const tau = (t - b.releaseAt) / 1000;
    const s = tau / F;
    out[0] = lerp(b.R[0], b.C[0], s);
    out[1] = b.R[1] + b.vy0 * tau - 0.5 * g * tau * tau;
    out[2] = lerp(b.R[2], b.C[2], s);
    if (b.curve) out[0] += b.curve.amp * b.curve.dir * (s <= 1 ? Math.sin(Math.PI * s) : -Math.PI * (s - 1));
    return out;
  }

  /** Grace after arrival (ms): the tuning, widened to the measured camera latency when known. */
  graceMs() {
    const g = this.tuning.judge.graceMs;
    return Number.isFinite(this.latencyMs) ? Math.max(g, this.latencyMs + 40) : g;
  }

  _stepBall(b, t, dt) {
    const J = this.tuning.judge;
    const grace = this.graceMs();
    if (b.state === 'flying' && b.result == null) {
      this._ballPos(b, t, b.pos);
      b.spin += dt * 25;
      if (t >= b.arriveAt) {
        if (b.provisional == null) {
          if (this._clear(b, b.arriveAt - J.earlyMs, t)) { this._dodge(b, t, false); return; }
          if (this._awaySpeed(b) >= J.predictSpeed) b.provisional = 'flying';
          else { b.provisional = 'contact'; b.state = 'contact'; b.contactAt = t; this._contactPos(b, b.pos); }
        } else if (this._clear(b, b.arriveAt - J.earlyMs, t)) { this._dodge(b, t, true); return; }
        if (t >= b.arriveAt + grace) { this._hit(b, t); return; }
      }
      return;
    }
    if (b.state === 'contact') {
      if (this._clear(b, b.arriveAt - J.earlyMs, t)) {
        // the camera caught the dodge in time: carry on past ("just made it") from where it waited
        const frozen = t - b.contactAt;
        b.releaseAt += frozen;
        b.arriveAt += frozen;
        this._dodge(b, t, true);
        return;
      }
      if (t >= b.arriveAt + grace) this._hit(b, t);
      return;
    }
    if (b.state === 'dodged') {
      if (b.ballistic) this._stepBallistic(b, dt);
      else {
        this._ballPos(b, t, b.pos);
        b.spin += dt * 25;
        if (b.pos[1] <= this.tuning.ball.radius || b.pos[2] > 3.4) this._toBallistic(b, t);
      }
      if (t - b.judgedAt > this.tuning.ball.lifeAfterMs) b.state = 'gone';
      return;
    }
    if (b.state === 'hit') {
      this._stepBallistic(b, dt);
      if (t - b.judgedAt > this.tuning.ball.lifeAfterMs) b.state = 'gone';
    }
  }

  _toBallistic(b, t) {
    const p0 = this._ballPos(b, t, [0, 0, 0]);
    const p1 = this._ballPos(b, t + 5, [0, 0, 0]);
    b.vel = [(p1[0] - p0[0]) / 0.005, (p1[1] - p0[1]) / 0.005, (p1[2] - p0[2]) / 0.005];
    b.pos = p0;
    b.ballistic = true;
  }

  _stepBallistic(b, dt) {
    const B = this.tuning.ball;
    if (!(dt > 0)) return;
    b.vel[1] -= B.gravity * dt;
    for (let i = 0; i < 3; i++) b.pos[i] += b.vel[i] * dt;
    if (b.pos[1] < B.radius) {
      b.pos[1] = B.radius;
      if (b.vel[1] < 0) {
        b.vel[1] = -b.vel[1] * B.bounce;
        b.vel[0] *= 0.8; b.vel[2] *= 0.8;
        if (b.vel[1] < 0.35) b.vel[1] = 0;
      }
    }
    b.spin += dt * Math.hypot(b.vel[0], b.vel[2]) * 8;
  }

  /** The point on your face where an unavoided ball stops (just in front of the head centre). */
  _contactPos(b, out) {
    const dx = b.C[0] - b.R[0], dz = b.C[2] - b.R[2];
    const len = Math.hypot(dx, dz) || 1;
    const back = HEAD.headRadius + this.tuning.ball.radius;
    out[0] = b.C[0] - (dx / len) * back;
    out[1] = b.C[1];
    out[2] = b.C[2] - (dz / len) * back;
    return out;
  }

  // ───────────── judging ─────────────

  /** Lean-space distance from the ball's aim point. */
  _dist(s, aim) {
    const J = this.tuning.judge;
    return Math.hypot(s.x - aim.x, (s.y - aim.y) * J.duckWeight);
  }

  /** Was the head clear of the ball at any sample in [a, b]? */
  _clear(b, a, z) {
    const J = this.tuning.judge;
    for (const s of this._samplesIn(a, z)) if (this._dist(s, b.aim) >= J.clearRadius) return true;
    return false;
  }

  /** How fast (lean units/s) the head is moving away from the ball's aim point right now. */
  _awaySpeed(b) {
    const S = this._samples;
    if (S.length < 2) return 0;
    const last = S[S.length - 1];
    let prev = S[S.length - 2];
    for (let i = S.length - 2; i >= 0; i--) { prev = S[i]; if (last.t - S[i].t >= 50) break; }
    const dtS = (last.t - prev.t) / 1000;
    if (dtS <= 0) return 0;
    return (this._dist(last, b.aim) - this._dist(prev, b.aim)) / dtS;
  }

  _dodge(b, t, late) {
    b.result = 'dodged';
    b.state = 'dodged';
    b.judgedAt = t;
    b.late = late;
    this.drill.dodged++;
    if (late) this.drill.late++;
    const n = this._comboUp();
    const pts = this.pointsFor(n);
    const head = headWorld(b.aim);
    const mate = b.double ? this.balls.find((o) => o.plan === b.plan && o !== b) : null;
    const both = mate && mate.result === 'dodged';
    const text = both ? 'DOUBLE DODGE!' : late ? 'JUST MADE IT!' : pts > 1 ? `DODGE +${pts}` : 'DODGE!';
    this._score(pts, 'dodge', { pos: head, popup: text, popupKind: both ? 'bonus' : 'dodge' });
    if (this.tuning.score.milestones.includes(n)) this._popup(`${n} IN A ROW!`, 'bonus', head);
    this._event('ball-dodge', { pos: head, ball: b.id, late, streak: n, points: pts });
  }

  _hit(b, t) {
    const B = this.tuning.ball, R = B.rebound;
    b.result = 'hit';
    b.judgedAt = t;
    this.drill.hits++;
    this._comboBreak();
    // a ball that was let fly on (you were moving away, but not far enough) bounces off from where
    // it is; one waiting at your face bounces off from there
    const pos = b.state === 'contact' ? this._contactPos(b, [0, 0, 0]) : [b.pos[0], b.pos[1], b.pos[2]];
    if (this.tuning.score.hitPenalty) this._score(-this.tuning.score.hitPenalty, 'ball-hit', { pos });
    this._popup('OUCH!', 'bad', pos);
    this._event('ball-hit', { pos, ball: b.id, power: 0.55 });
    // your boxer flinches; the ball came from the side it was thrown from
    const fromLeft = b.R[0] < b.C[0];
    this.trainee.receive({ result: 'hit', damage: this.tuning.hitDamage, stunMs: this.tuning.flinchMs, daze: 0 },
      { hand: fromLeft ? 'right' : 'left', kind: 'straight', target: 'head' }, t);
    this.trainee.heal01(1);
    this.trainerState.cheerUntil = t + this.tuning.trainer.cheerMs;
    // bounce off the face
    const dx = b.C[0] - b.R[0], dz = b.C[2] - b.R[2], len = Math.hypot(dx, dz) || 1;
    const speed = len / (b.flightMs / 1000);
    b.state = 'hit';
    b.pos = pos;
    b.vel = [-(dx / len) * speed * R.back + (this.rng.float() * 2 - 1) * R.side, R.up, -(dz / len) * speed * R.back];
    b.ballistic = true;
  }

  // ───────────── results & view ─────────────

  _details() {
    const D = this.drill;
    return { thrown: D.thrown, dodged: D.dodged, hits: D.hits, late: D.late, doubles: D.doubles, curves: D.curves, bestStreak: this.bestCombo };
  }

  _fillView(view, t) {
    const tr = this.trainerState, P = this.plan, J = this.tuning.judge;
    const head = headWorld(this._latestLean());
    let action = 'idle', aim01 = 0, msToRelease = null;
    if (P) {
      if (t < P.aimStart) action = 'walk';
      else if (t < P.throwStart) { action = 'aim'; aim01 = clamp01((t - P.aimStart) / Math.max(1, P.throwStart - P.aimStart)); }
      else action = 'throw';
      msToRelease = Math.max(0, P.release - t);
    } else if (tr.x !== tr.targetX) action = 'walk';
    const cheering = t < tr.cheerUntil;
    const holding = { left: false, right: false };
    for (const b of this.balls) if (b.state === 'held') holding[b.hand] = true;
    view.trainer = {
      pos: [tr.x, 0, tr.z], yaw: this.trainerYaw(), action, aim01, msToRelease, cheering,
      throwId: P ? P.id : null, double: P ? P.double : false,
      releases: P ? P.balls.map((b) => ({ hand: b.hand, msToRelease: b.releaseAt - t, ball: b.id })) : [],
      holding,
      expression: cheering ? 'happy' : action === 'aim' || action === 'throw' ? 'focus' : 'neutral',
      lookAt: head,
      phase: 'idle', hitReact: null,
    };
    view.balls = this.balls.map((b) => ({
      id: b.id, hand: b.hand, state: b.state, lane: b.lane, double: b.double, curve: !!b.curve,
      pos: b.state === 'held' ? null : [b.pos[0], b.pos[1], b.pos[2]],
      target: b.C ? [b.C[0], b.C[1], b.C[2]] : null,
      aim: b.aim ? { x: b.aim.x, y: b.aim.y } : null,
      releaseAt: b.releaseAt, arriveAt: b.arriveAt,
      msToRelease: b.releaseAt - t, msToArrive: b.arriveAt - t,
      flight01: b.state === 'held' ? 0 : clamp01((t - b.releaseAt) / b.flightMs),
      result: b.result, late: b.late, spin: b.spin, judgedAge: b.judgedAt == null ? null : (t - b.judgedAt) / 1000,
    }));
    view.clearRadius = J.clearRadius;
    view.drill = { ...this.drill, streak: this.combo };
  }
}
