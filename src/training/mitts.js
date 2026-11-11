// Target punching (TRN01): the trainer holds focus mitts and pops one up (your left or right,
// high or low) — sometimes both, sometimes a quick "1-2". Hit the raised mitt with the glove on
// that side before it drops. Don't hit the trainer!
//
// Owner: training. Pure logic (no DOM / three.js).
//
// Rules (spec §6 "Strike the mitts presented by the trainer, including occasions when both are
// raised. Reward mitt hits and deduct points for hitting the trainer." — numbers in MITTS_TUNING):
//   * The mitt on YOUR left is hit with your LEFT hand (it is the trainer's right hand, like a
//     mirror). High mitts take head-height punches, low mitts body punches (requireHeight); the
//     wrong height whiffs past it (a "HIGHER!" / "LOWER!" hint, no deduction).
//   * A hit scores 10 + a speed bonus of up to 10 (full when your punch is recognised within
//     fastMs = 0.45 s of the mitt starting to rise, none from slowMs = 1 s) + streak bonus
//     (+2 from 5 in a row, +4 from 10). Hitting BOTH mitts of a double presentation: +20.
//   * A punch landing where no mitt is up — nothing raised on that side, or nothing raised at all —
//     hits the trainer: −10 (the score never drops below 0), the trainer flinches and the next
//     target waits until he has recovered. The streak resets.
//   * Fairness through webcam latency: a punch is matched to a mitt at the moment it is
//     RECOGNISED (the trainer then holds that mitt until the glove arrives), and a mitt that just
//     started dropping without being hit still counts for lateGraceMs. A quick second punch into a
//     mitt you just hit is absorbed by the mitt (no points, no deduction).
//   * The drill speeds up: mitts stay up 1.7 s → 0.95 s, rests shrink, doubles / combos / low
//     mitts get more frequent.

import { TrainingActivity, TrainingPhase, headWorld, punchContact, clamp01, lerp, ramp } from './activity.js';

/** Every target-punching tunable (ms, metres, points). */
export const MITTS_TUNING = Object.freeze({
  durationMs: 60000,
  rampMs: 52000,
  trainer: Object.freeze({
    pos: Object.freeze([0, 0, -0.66]),  // facing the player (+Z)
    hitPos: Object.freeze([0, 1.18, -0.5]), // where a punch on the trainer lands (chest / chin)
  }),
  mitt: Object.freeze({
    x: 0.15,            // mitt centre offset from the centre line (your left = −X)
    highY: 1.22,        // head height (where the ghost's straights land)
    lowY: 0.94,         // body height
    faceZ: -0.35,       // the mitt's face sits on the punch plane
    rest: Object.freeze([0.3, 0.86, -0.48]), // lowered mitt (|x|, y, z) — clearly not a target
    catchBlend: 0.85,   // a claimed mitt moves this far toward where your glove really lands (pad work: the trainer meets the punch)
  }),
  timing: Object.freeze({
    firstDelayMs: 450,
    raiseMs: 170,
    lowerMs: 200,
    hitPopMs: 260,
    showMs: Object.freeze([1700, 950]),     // how long a raised mitt waits for your punch
    gapMs: Object.freeze([650, 230]),       // rest between presentations
    comboStepMs: Object.freeze([520, 320]), // "1-2": the second mitt pops this soon after the first (or once it is hit)
    lateGraceMs: 150,
    safeAfterHitMs: 500,                    // ≥ one glove's recovery + travel, so a jab-jab is absorbed
    trainerHurtMs: 480,
    claimTimeoutMs: 500,                    // safety: a claim whose punch vanished is dropped
    jitter: 0.12,
  }),
  mix: Object.freeze({
    bothChance: Object.freeze([0.1, 0.26]),
    comboFrom: 0.25, comboChance: Object.freeze([0.15, 0.35]),
    lowFrom: 0.2, lowChance: Object.freeze([0.15, 0.35]),
    maxSameSide: 2,      // never more than this many single targets in a row on the same side
  }),
  score: Object.freeze({
    base: 10,
    speedBonus: 10,
    fastMs: 450,         // raise → punch recognised at or under this: full speed bonus …
    slowMs: 1000,        // … falling linearly to none at this reaction time (both include webcam latency)
    perfectAt: 8,        // speed bonus ≥ this → "PERFECT!"
    both: 20,
    trainer: -10,
    streakBonus: Object.freeze([[5, 2], [10, 4]]),
    milestones: Object.freeze([5, 10, 15, 20, 30, 40]),
  }),
  requireHeight: true,
});

const SIDES = ['left', 'right'];
const heightOf = (p) => (p?.target === 'body' ? 'low' : 'high');

export class TargetPunching extends TrainingActivity {
  static KIND = 'mitts';
  static TUNING = MITTS_TUNING;

  _init() {
    this.mitts = { left: this._newMitt('left'), right: this._newMitt('right') };
    this.pres = null;
    this.nextAt = Infinity;
    this._presId = 0;
    this._claims = new Map();
    this._sameSide = { side: null, n: 0 };
    this.trainerState = { hurtAt: -1e9, hitReact: null, cheerUntil: -1e9 };
    this.drill = { presented: 0, mittsShown: 0, hits: 0, expired: 0, trainerHits: 0, doubles: 0, doublesHit: 0, whiffs: 0, perfect: 0, reactionSum: 0 };
  }

  _newMitt(side) {
    return {
      side, hand: side === 'left' ? 'right' : 'left', height: 'high', state: 'rest', stateAt: 0,
      raisedAt: null, showMs: 0, showUntil: 0, claim: null, claimAt: 0, hitAt: -1e9, wasHit: false, pres: null, catch: null,
    };
  }

  _onActive(t) {
    this.nextAt = t + this.tuning.timing.firstDelayMs;
  }

  /** World centre of a mitt's face when presented. */
  mittPos(side, height) {
    const M = this.tuning.mitt;
    return [(side === 'left' ? -1 : 1) * M.x, height === 'low' ? M.lowY : M.highY, M.faceZ];
  }

  /** Where the trainer brings a mitt to meet punch `p` (between the mitt and the glove's landing point). */
  catchPos(m, p) {
    const at = this.mittPos(m.side, m.height), g = punchContact(p, [0, 0, 0], undefined, this.trainee.lean), k = this.tuning.mitt.catchBlend;
    return [lerp(at[0], g[0], k), lerp(at[1], g[1], k), at[2]];
  }

  restPos(side) {
    const r = this.tuning.mitt.rest;
    return [(side === 'left' ? -1 : 1) * r[0], r[1], r[2]];
  }

  /** Late grace (ms): the tuning, widened to the measured camera latency when known. */
  lateGraceMs() {
    const g = this.tuning.timing.lateGraceMs;
    return Number.isFinite(this.latencyMs) ? Math.max(g, this.latencyMs + 30) : g;
  }

  /** Can a punch thrown now be matched to this mitt? */
  claimable(m, t) {
    if (m.state === 'raising' || m.state === 'up') return true;
    return m.state === 'lowering' && !m.wasHit && t - m.stateAt <= this.lateGraceMs();
  }

  /** A follow-up punch into a mitt that was just hit is absorbed (no points, no deduction). */
  absorbs(m, t) {
    return m.wasHit && t - m.hitAt <= this.tuning.timing.safeAfterHitMs;
  }

  // ───────────── presentations ─────────────

  _step(h, t) {
    if (this.phase === TrainingPhase.ACTIVE && !this.timeUp && !this.pres && t >= this.nextAt && t >= this.trainerState.hurtAt + this.tuning.timing.trainerHurtMs) {
      this._present(t);
    }
    this._stepMitts(t);
  }

  /**
   * Script a presentation starting now (dev page, tests, demos); ACTIVE phase only and only when
   * no presentation is running. Unspecified fields follow the current difficulty.
   * @param {{kind?:'single'|'both'|'combo', side?:'left'|'right', heights?:string[]|string, showMs?:number}} [spec]
   * @returns {Object|null} the presentation
   */
  presentNow(spec = {}) {
    if (this.phase !== TrainingPhase.ACTIVE || this.timeUp || this.pres) return null;
    this._present(this.t, spec);
    return this.pres;
  }

  _present(t, spec = null) {
    const T = this.tuning.timing, X = this.tuning.mix, rng = this.rng;
    const d = this.difficulty(t);
    const jit = () => 1 + (rng.float() * 2 - 1) * T.jitter;
    const both = spec?.kind ? spec.kind === 'both' : rng.chance(ramp(X.bothChance, d));
    const combo = spec?.kind ? spec.kind === 'combo' : !both && d >= X.comboFrom && rng.chance(ramp(X.comboChance, (d - X.comboFrom) / (1 - X.comboFrom)));
    const lowP = d >= X.lowFrom ? ramp(X.lowChance, (d - X.lowFrom) / (1 - X.lowFrom)) : 0;
    const showMs = Number.isFinite(spec?.showMs) ? spec.showMs : ramp(T.showMs, d) * jit();
    const hs = spec?.heights == null ? null : Array.isArray(spec.heights) ? spec.heights : [spec.heights];
    let hi = 0;
    const height = () => (hs ? (hs[Math.min(hi++, hs.length - 1)] === 'low' ? 'low' : 'high') : rng.chance(lowP) ? 'low' : 'high');
    let first = spec?.side === 'left' || spec?.side === 'right' ? spec.side : rng.chance(0.5) ? 'left' : 'right';
    if (!spec?.side && !both && this._sameSide.side === first && this._sameSide.n >= X.maxSameSide) first = first === 'left' ? 'right' : 'left';
    const id = ++this._presId;
    this.pres = { id, kind: both ? 'both' : combo ? 'combo' : 'single', sides: [], startedAt: t, hits: new Set(), expired: new Set(), bonusDone: false, pending: [] };
    this.drill.presented++;
    if (both) {
      this.drill.doubles++;
      for (const side of SIDES) this._raise(this.mitts[side], t, height(), showMs);
      this._sameSide = { side: null, n: 0 };
    } else {
      this._raise(this.mitts[first], t, height(), showMs);
      this._sameSide = this._sameSide.side === first ? { side: first, n: this._sameSide.n + 1 } : { side: first, n: 1 };
      if (combo) {
        const other = first === 'left' ? 'right' : 'left';
        this.pres.pending.push({ side: other, at: t + ramp(T.comboStepMs, d), height: height(), showMs: showMs * 0.9 });
      }
    }
  }

  _raise(m, t, height, showMs) {
    const T = this.tuning.timing;
    m.state = 'raising';
    m.stateAt = t;
    m.raisedAt = t;
    m.height = height;
    m.showMs = showMs;
    m.showUntil = t + T.raiseMs + showMs;
    m.claim = null;
    m.catch = null;
    m.wasHit = false;
    m.pres = this.pres.id;
    this.pres.sides.push(m.side);
    this.drill.mittsShown++;
    this._event('target-up', { presentation: this.pres.id, kind: this.pres.kind, side: m.side, height: m.height, showMs: Math.round(showMs), pos: this.mittPos(m.side, height) });
  }

  _stepMitts(t) {
    const T = this.tuning.timing;
    const P = this.pres;
    if (P && P.pending.length) {
      for (const q of [...P.pending]) {
        if (t >= q.at) {
          P.pending.splice(P.pending.indexOf(q), 1);
          if (this.phase === TrainingPhase.ACTIVE && !this.timeUp) this._raise(this.mitts[q.side], t, q.height, q.showMs);
        }
      }
    }
    for (const side of SIDES) {
      const m = this.mitts[side];
      if (m.claim != null && t - m.claimAt > T.claimTimeoutMs && !this.trainee.punches.some((p) => p.id === m.claim && p.stage === 'travel')) m.claim = null;
      if (m.state === 'raising' && t - m.stateAt >= T.raiseMs) { m.state = 'up'; m.stateAt = t; }
      if (m.state === 'up' && t >= m.showUntil && m.claim == null) {
        m.state = 'lowering';
        m.stateAt = t;
        if (P && P.id === m.pres) P.expired.add(side);
        this.drill.expired++;
        this._comboBreak();
        this._event('target-expire', { side, height: m.height, pos: this.mittPos(side, m.height) });
      }
      if (m.state === 'hit' && t - m.stateAt >= T.hitPopMs) { m.state = 'lowering'; m.stateAt = t; }
      if (m.state === 'lowering' && t - m.stateAt >= T.lowerMs) { m.state = 'rest'; m.stateAt = t; m.catch = null; }
    }
    if (P && !P.pending.length && SIDES.every((s) => this.mitts[s].state === 'rest' || this.mitts[s].pres !== P.id)) {
      this.pres = null;
      const d = this.difficulty(t);
      this.nextAt = t + ramp(T.gapMs, d) * (1 + (this.rng.float() * 2 - 1) * T.jitter);
    }
  }

  // ───────────── punches ─────────────

  _onThrown(p, t) {
    const m = this.mitts[p.hand === 'right' ? 'right' : 'left'];
    let info = null;
    if (this.claimable(m, t)) {
      if (m.claim != null) info = { follow: true };
      else if (this.tuning.requireHeight && heightOf(p) !== m.height) info = { mismatch: m.height };
      else {
        info = { mitt: m.side, pres: m.pres };
        m.claim = p.id;
        m.claimAt = t;
        m.catch = this.catchPos(m, p);
        if (m.state === 'lowering') { m.state = 'up'; m.stateAt = t; } // the trainer holds it for you
      }
    } else if (this.absorbs(m, t)) info = { follow: true };
    this._claims.set(p.id, info);
    if (this._claims.size > 16) this._claims.delete(this._claims.keys().next().value);
  }

  _resolvePunch(p, t) {
    const info = this._claims.get(p.id) ?? null;
    this._claims.delete(p.id);
    const m = this.mitts[p.hand === 'right' ? 'right' : 'left'];
    if (info?.mitt && m.claim === p.id) return this._hitMitt(m, p, t);
    if (m.claim === p.id) m.claim = null;
    if (info?.follow || this.absorbs(m, t)) {
      this._event('mitt-absorb', { side: m.side, pos: this.mittPos(m.side, m.height) });
      return { result: 'blocked' };
    }
    if (info?.mismatch) {
      this.drill.whiffs++;
      this._comboBreak();
      this._popup(info.mismatch === 'high' ? 'HIGHER!' : 'LOWER!', 'miss', this.mittPos(m.side, info.mismatch));
      this._event('glove-miss', { side: m.side, wanted: info.mismatch, pos: punchContact(p, [0, 0, 0], undefined, this.trainee.lean) });
      return { result: 'miss' };
    }
    // a mitt that came up on that side while the glove was on its way still counts
    if (this.claimable(m, t) && m.claim == null && (!this.tuning.requireHeight || heightOf(p) === m.height)) {
      m.claim = p.id;
      m.catch = this.catchPos(m, p);
      return this._hitMitt(m, p, t);
    }
    return this._trainerHit(p, t);
  }

  _hitMitt(m, p, t) {
    const S = this.tuning.score;
    const reaction = Math.max(0, p.thrownAt - (m.raisedAt ?? p.thrownAt));
    const k = clamp01(1 - (reaction - S.fastMs) / Math.max(1, S.slowMs - S.fastMs));
    const speed = Math.round(S.speedBonus * k);
    const n = this._comboUp();
    let streak = 0;
    for (const [at, add] of S.streakBonus) if (n >= at) streak = add;
    const pts = S.base + speed + streak;
    const pos = m.catch ? [...m.catch] : this.mittPos(m.side, m.height);
    m.state = 'hit';
    m.stateAt = t;
    m.hitAt = t;
    m.wasHit = true;
    m.claim = null;
    this.drill.hits++;
    this.drill.reactionSum += reaction;
    this.stats.landed++;
    const perfect = speed >= S.perfectAt;
    if (perfect) this.drill.perfect++;
    this._score(pts, 'mitt-hit', { pos, popup: perfect ? `PERFECT +${pts}` : `+${pts}`, popupKind: perfect ? 'perfect' : 'hit' });
    this._event('mitt-hit', { pos, side: m.side, height: m.height, hand: p.hand, punch: p.kind, reaction, points: pts, power: 0.45 + 0.04 * speed });
    if (S.milestones.includes(n)) this._popup(`${n} IN A ROW!`, 'bonus', pos);
    const P = this.pres;
    if (P && P.id === m.pres) {
      P.hits.add(m.side);
      if (P.kind === 'both' && P.hits.size === 2 && !P.bonusDone) {
        P.bonusDone = true;
        this.drill.doublesHit++;
        this._score(S.both, 'mitt-double', { pos: [0, pos[1], pos[2]], popup: `DOUBLE! +${S.both}`, popupKind: 'bonus' });
      }
      // "1-2": the second mitt pops as soon as the first is hit
      if (P.kind === 'combo' && P.pending.length) for (const q of P.pending) q.at = Math.min(q.at, t + 90);
    }
    if (n >= 5) this.trainerState.cheerUntil = t + 500;
    return { result: 'hit' };
  }

  _trainerHit(p, t) {
    const S = this.tuning.score, T = this.tuning.timing;
    const anyUp = SIDES.some((s) => this.claimable(this.mitts[s], t));
    const pos = [...this.tuning.trainer.hitPos];
    pos[0] = p.hand === 'right' ? 0.06 : -0.06;
    if (p.target === 'body') pos[1] = 0.95;
    this.drill.trainerHits++;
    this._comboBreak();
    this.trainerState.hurtAt = t;
    this.trainerState.hitReact = { hand: p.hand, kind: p.kind, target: p.target, at: t };
    this._score(S.trainer, 'trainer-hit', { pos, popup: anyUp ? `WRONG HAND ${S.trainer}` : `OUCH! ${S.trainer}`, popupKind: 'penalty' });
    this._event('trainer-hit', { pos, hand: p.hand, punch: p.kind, target: p.target });
    this.nextAt = Math.max(this.nextAt, t + T.trainerHurtMs);
    return { result: 'hit' };
  }

  _details() {
    const D = this.drill;
    return {
      presented: D.presented, mitts: D.mittsShown, hits: D.hits, expired: D.expired, trainerHits: D.trainerHits,
      doubles: D.doubles, doublesHit: D.doublesHit, whiffs: D.whiffs, perfect: D.perfect,
      avgReactionMs: D.hits ? Math.round(D.reactionSum / D.hits) : null, bestStreak: this.bestCombo,
    };
  }

  _fillView(view, t) {
    const T = this.tuning.timing, tr = this.trainerState;
    const hurtAge = t - tr.hurtAt;
    const hurt = hurtAge >= 0 && hurtAge < T.trainerHurtMs;
    const hr = tr.hitReact && t - tr.hitReact.at < 2000
      ? { hand: tr.hitReact.hand, kind: tr.hitReact.kind, target: tr.hitReact.target, strength: 0.75, age: (t - tr.hitReact.at) / 1000, blocked: false }
      : null;
    const anyUp = SIDES.some((s) => this.mitts[s].state === 'raising' || this.mitts[s].state === 'up');
    view.trainer = {
      pos: [...this.tuning.trainer.pos], yaw: 0,
      action: hurt ? 'hurt' : anyUp ? 'present' : 'idle',
      phase: hurt ? 'hitstun' : 'idle',
      phaseProgress: hurt ? clamp01(hurtAge / T.trainerHurtMs) : 0,
      hitReact: hr,
      expression: hurt ? 'hurt' : t < tr.cheerUntil ? 'happy' : anyUp ? 'focus' : 'happy',
      lookAt: headWorld(this._latestLean()),
    };
    view.mitts = SIDES.map((side) => {
      const m = this.mitts[side];
      const k = clamp01((t - m.stateAt) / Math.max(1, m.state === 'raising' ? T.raiseMs : T.lowerMs));
      const up01 = m.state === 'raising' ? k : m.state === 'up' || m.state === 'hit' ? 1 : m.state === 'lowering' ? 1 - k : 0;
      const live = m.state === 'raising' || m.state === 'up';
      return {
        side, hand: m.hand, height: m.height, state: m.state, up01, live,
        claimed: m.claim != null,
        timeLeft01: live ? clamp01((m.showUntil - t) / Math.max(1, m.showMs + T.raiseMs)) : 0,
        msLeft: live ? Math.max(0, m.showUntil - t) : 0,
        pos: this.mittPos(side, m.height),
        catchPos: m.catch && (m.claim != null || m.state === 'hit' || m.state === 'lowering') ? [...m.catch] : null,
        restPos: this.restPos(side),
        hitAge: m.wasHit ? (t - m.hitAt) / 1000 : null,
        double: !!(this.pres && this.pres.kind === 'both' && m.pres === this.pres.id),
        presentation: m.pres,
      };
    });
    view.drill = { ...this.drill, streak: this.combo };
  }
}
