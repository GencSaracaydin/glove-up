// Training sessions (TRN01/TRN02): 1–4 participants take turns at one practice activity with a
// shared camera; per-participant results, a comparison table and personal-best flags; repeat
// attempts. Also the activity factory and scripted "bot" players (dev page, e2e, unit tests that
// calibrate the medal cutoffs).
//
// Owner: training. Pure logic (no DOM / three.js).
//
// Typical app wiring (see ARCHITECTURE.md training/*):
//   const session = new TrainingSession({ participants, kind });   // from the training-select screen
//   let act = session.createActivity({ bus });                       // current participant's attempt
//   per frame: act.update(dt, now, inputHub.update(now).players[0]); renderer.renderTraining(act.getView(), dt)
//   on Ev.TRAIN_END: const save = storage.recordTraining(participant.id, act.getResult()) (local profiles only);
//                    session.record(act.getResult(), save); ui.show('training-result', session.screenParams())
//   result screen:   'retry' → session.retry(); 'next' → session.next(); 'done' → leave.

import { TrainingKind, Medal } from '../core/types.js';
import { toRng } from '../core/rng.js';
import { BagPractice, BAG_TUNING } from './bag.js';
import { DodgeDrill } from './dodge.js';
import { TargetPunching } from './mitts.js';
import { medalRank } from './medals.js';
import { clamp01, lerp, num } from './activity.js';

/** TrainingKind → activity class. */
export const ACTIVITIES = Object.freeze({
  [TrainingKind.BAG]: BagPractice,
  [TrainingKind.DODGE]: DodgeDrill,
  [TrainingKind.MITTS]: TargetPunching,
});

/** Session limits (spec §2: one to four participants take turns). */
export const SESSION_LIMITS = Object.freeze({ minParticipants: 1, maxParticipants: 4 });

/**
 * New activity of `kind` (constructor options as TrainingActivity: bus, rng, participant, tuning, durationMs, …).
 * @throws {Error} for an unknown kind
 */
export function createActivity(kind, opts = {}) {
  const C = ACTIVITIES[kind];
  if (!C) throw new Error(`Unknown training activity "${kind}".`);
  return new C(opts);
}

function participantBest(p, kind) {
  const b = p?.records?.training?.[kind]?.best;
  return Number.isFinite(b) && b > 0 ? b : 0;
}

export class TrainingSession {
  /**
   * @param {Object} o
   * @param {Object[]} o.participants  profiles (1..4) in turn order (extra ones are ignored; none → one guest)
   * @param {string} o.kind            TrainingKind
   * @param {number|string} [o.seed]   seeds every attempt's drill (deterministic sessions)
   * @param {Object<string, number>} [o.bests]  previous best per profile id (else profile.records.training[kind].best)
   */
  constructor({ participants = [], kind = TrainingKind.BAG, seed, bests = null } = {}) {
    if (!ACTIVITIES[kind]) throw new Error(`Unknown training activity "${kind}".`);
    this.kind = kind;
    const list = (Array.isArray(participants) ? participants : []).filter((p) => p && typeof p === 'object').slice(0, SESSION_LIMITS.maxParticipants);
    this.participants = list.length ? list : [{ id: 'guest', name: 'Guest 1', kind: 'guest' }];
    this.rng = toRng(seed);
    this.index = 0;
    /** Per participant (turn order): every recorded attempt. */
    this.attempts = this.participants.map(() => []);
    /** Best score known before each attempt (profile record, then this session). */
    this._best = this.participants.map((p) => Math.max(participantBest(p, kind), num(bests?.[p.id], 0)));
    this._seen = new Set();
  }

  get turns() { return this.participants.length; }

  /** The participant whose turn it is, or null once every turn is done. */
  current() {
    if (this.index >= this.turns) return null;
    const i = this.index;
    return { index: i, turn: i, turns: this.turns, participant: this.participants[i], attempt: this.attempts[i].length + 1, best: this._best[i] };
  }

  /** New activity for the current participant's turn (rng forked per turn + attempt). */
  createActivity(opts = {}) {
    const cur = this.current();
    if (!cur) throw new Error('This training session is complete.');
    return createActivity(this.kind, { ...opts, participant: cur.participant, rng: opts.rng ?? this.rng.fork(`turn:${cur.index}:${cur.attempt}`) });
  }

  /**
   * Store the current participant's finished attempt (idempotent by result.id).
   * @param {import('../core/types.js').TrainingResult} result
   * @param {Object} [save]  storage.recordTraining(...) outcome ({ok, saved, newBest?, prevBest?, …})
   * @returns {null|{participant, index, result, save, personalBest:boolean, prevBest:number}}
   */
  record(result, save = null) {
    const cur = this.current();
    if (!cur || !result || typeof result !== 'object') return null;
    if (result.id && this._seen.has(result.id)) {
      return this.attempts.flat().find((a) => a.result.id === result.id) || null;
    }
    if (result.id) this._seen.add(result.id);
    const i = cur.index;
    const score = Math.max(0, num(result.score));
    const prevBest = Number.isFinite(save?.prevBest) ? save.prevBest : this._best[i];
    const personalBest = typeof save?.newBest === 'boolean' ? save.newBest && score > 0 : score > prevBest && score > 0;
    const entry = { participant: cur.participant, index: i, attempt: cur.attempt, result, save: save || null, personalBest, prevBest };
    this.attempts[i].push(entry);
    this._best[i] = Math.max(this._best[i], score);
    return entry;
  }

  /** Repeat attempt for the same participant (TRN02 repeat attempts). */
  retry() { return this.current(); }

  /** Advance to the next participant; returns the new current() or null when all turns are done. */
  next() {
    if (this.index < this.turns) this.index++;
    return this.current();
  }

  isComplete() { return this.index >= this.turns; }

  /** Per participant (turn order): attempts, best and latest result, personal-best flag. */
  results() {
    return this.participants.map((participant, index) => {
      const atts = this.attempts[index];
      const best = atts.reduce((a, b) => (!a || b.result.score > a.result.score ? b : a), null);
      const latest = atts[atts.length - 1] || null;
      return {
        participant, index, attempts: atts.slice(), played: atts.length > 0,
        best: best ? best.result : null, latest: latest ? latest.result : null,
        score: best ? best.result.score : null, medal: best ? best.result.medal : Medal.NONE,
        personalBest: atts.some((a) => a.personalBest),
      };
    });
  }

  /** Ranking by each participant's best score this session (ties share a place; unplayed last). */
  comparison() {
    const rows = this.results().filter((r) => r.played)
      .sort((a, b) => b.score - a.score || medalRank(b.medal) - medalRank(a.medal) || a.index - b.index);
    let place = 0, last = null;
    return rows.map((r, i) => {
      if (r.score !== last) { place = i + 1; last = r.score; }
      return { rank: place, index: r.index, participant: r.participant, score: r.score, medal: r.medal, personalBest: r.personalBest };
    });
  }

  /**
   * Params for the 'training-result' screen (src/ui/screens/training-result.js): one entry per
   * participant who has played — the participant who just finished with their LATEST attempt,
   * everyone else with their best.
   */
  screenParams() {
    const justPlayed = Math.min(this.index, this.turns - 1);
    const results = [];
    let current = 0;
    this.results().forEach((r) => {
      if (!r.played) return;
      const pick = r.index === justPlayed ? r.attempts[r.attempts.length - 1] : r.attempts.reduce((a, b) => (b.result.score > a.result.score ? b : a));
      if (r.index === justPlayed) current = results.length;
      results.push({ participant: r.participant, result: pick.result, save: pick.save });
    });
    return {
      kind: this.kind, results, current, turns: this.turns, participants: this.participants.slice(),
      final: justPlayed >= this.turns - 1,
    };
  }
}

// ───────────────────────────── scripted players ─────────────────────────────
// Bots read the TrainingView like a player watching the screen and answer with a PlayerInput.
// `skill` 0..1 scales reaction time (which includes webcam latency), accuracy and pace. Used by
// dev/training.html, e2e smoke runs and the medal-calibration unit tests.

/** Bot knobs at skill 0 → skill 1. */
export const BOT_TUNING = Object.freeze({
  reactMs: Object.freeze([760, 330]),     // seeing something → the camera reporting your response
  leanTauMs: Object.freeze([150, 60]),
  leanAmp: Object.freeze([0.62, 1.0]),
  bagIntervalMs: Object.freeze([1150, 330]),
  bagTiming: Object.freeze([0.0, 0.95]),  // chance a punch waits for the bag to be in reach / coming back
  dodgeError: Object.freeze([0.33, 0.02]), // wrong / too-small / too-late dodges
  mittWrongHand: Object.freeze([0.12, 0.004]),
  mittWrongHeight: Object.freeze([0.1, 0.005]),
  mittSpamPerSec: Object.freeze([0.22, 0]),
  doubleStepMs: Object.freeze([330, 150]),
});

class BotBody {
  constructor(skill) {
    this.skill = skill;
    this.lean = { x: 0, y: 0 };
    this.goal = { x: 0, y: 0 };
    this.events = [];
    this.lastT = null;
    this.punchAt = { left: -1e9, right: -1e9 };
  }

  punch(t, hand, kind = 'straight', target = 'head', power = 0.7) {
    this.punchAt[hand] = t;
    this.events.push({ type: 'punch', t, punch: { hand, kind, target, power: clamp01(power), t } });
  }

  update(t) {
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const k = 1 - Math.exp(-dt / lerp(BOT_TUNING.leanTauMs[0], BOT_TUNING.leanTauMs[1], this.skill));
    this.lean.x += (this.goal.x - this.lean.x) * k;
    this.lean.y += (this.goal.y - this.lean.y) * k;
    const hand = (h, side) => {
      const age = t - this.punchAt[h];
      const ext = age >= 0 && age < 330 ? Math.sin(Math.PI * clamp01(age / 330)) : 0;
      return { x: side * (0.24 - 0.18 * ext), y: 0.3 + 0.1 * ext, reach: 0.1 + 0.85 * ext, punching: age >= 0 && age < 180 };
    };
    const events = this.events;
    this.events = [];
    return {
      control: {
        tracked: true, confidence: 1, guard: 'none', guardAmount: 0,
        lean: { x: this.lean.x, y: this.lean.y, z: 0 },
        head: { x: this.lean.x * 0.5, y: this.lean.y * 0.45 },
        hands: { left: hand('left', -1), right: hand('right', 1) },
        activity: 0.3,
      },
      events,
    };
  }
}

const sk = (range, s) => lerp(range[0], range[1], s);

/**
 * Scripted player for an activity.
 * @param {string} kind  TrainingKind
 * @param {{skill?:number, seed?:number|string}} [opts]
 * @returns {{kind:string, skill:number, update:(view:Object)=>import('../core/types.js').PlayerInput}}
 */
export function makeTrainingBot(kind, { skill = 0.5, seed = 7 } = {}) {
  const s = clamp01(num(skill, 0.5));
  const rng = toRng(seed).fork(`bot:${kind}`);
  const body = new BotBody(s);
  const idle = { update(view) { return body.update(num(view?.t, 0)); } };
  if (kind === TrainingKind.BAG) return { kind, skill: s, ...bagBrain(body, s, rng) };
  if (kind === TrainingKind.DODGE) return { kind, skill: s, ...dodgeBrain(body, s, rng) };
  if (kind === TrainingKind.MITTS) return { kind, skill: s, ...mittsBrain(body, s, rng) };
  return { kind, skill: s, ...idle };
}

function bagBrain(body, s, rng) {
  let nextAt = 0;
  let lastHand = 'right';
  let lastPunch = -1e9;
  const seen = [];   // delayed copies of the bag state: what the player saw `latency` ago
  const latency = lerp(170, 110, s);
  const H = BAG_TUNING.hit, C = BAG_TUNING.combo;
  const throwOne = (t) => {
    const hand = rng.chance(0.75) ? (lastHand === 'left' ? 'right' : 'left') : lastHand;
    lastHand = hand;
    lastPunch = t;
    const r = rng.float();
    const kind = r < 0.1 + 0.15 * s ? 'hook' : r < 0.18 + 0.2 * s ? 'uppercut' : 'straight';
    body.punch(t, hand, kind, rng.chance(0.2) ? 'body' : 'head', lerp(0.4, 0.85, s) + (rng.float() - 0.5) * 0.3);
  };
  return {
    update(view) {
      const t = num(view?.t, 0);
      const bag = view?.bag;
      if (bag) seen.push({ t, d: bag.reachD, v: bag.approach, ok: bag.hittable });
      while (seen.length > 2 && seen[1].t <= t - latency) seen.shift();
      const saw = seen[0];
      if (view?.phase === 'active' && !view.timeUp && t >= nextAt && saw) {
        const mean = sk(BOT_TUNING.bagIntervalMs, s);
        if (!saw.ok) nextAt = t + 60;
        else if (rng.chance(sk(BOT_TUNING.bagTiming, s))) {
          // a careful puncher meets the bag on its way back, holds off while it is out of reach,
          // but never lets the combo lapse
          const coming = saw.v >= H.meetSpeed * 0.85 && saw.d <= H.reachSlack;
          const far = saw.d > H.reachSlack * 0.9 && saw.v < H.meetSpeed * 0.5;
          const lapse = t - lastPunch > C.gapMs - 220;
          if (coming || !far || lapse) { throwOne(t); nextAt = t + mean * (0.85 + rng.float() * 0.3); } else nextAt = t + 30;
        } else {
          // an erratic puncher: random gaps (exponential) around the same average pace
          throwOne(t);
          nextAt = t + Math.min(mean * 3, -Math.log(1 - rng.float() * 0.995) * mean);
        }
      }
      return body.update(t);
    },
  };
}

function dodgeBrain(body, s, rng) {
  const handled = new Set();
  let decideAt = Infinity;
  let holdUntil = -1e9;
  const amp = sk(BOT_TUNING.leanAmp, s);
  return {
    update(view) {
      const t = num(view?.t, 0);
      const balls = Array.isArray(view?.balls) ? view.balls : [];
      const incoming = balls.filter((b) => b.aim && (b.state === 'flying' || b.state === 'contact') && b.msToArrive > -200);
      for (const b of incoming) {
        if (handled.has(b.id)) continue;
        handled.add(b.id);
        // a fresh release: respond after the reaction time (re-plan for the second ball of a double)
        let react = sk(BOT_TUNING.reactMs, s) * (0.85 + rng.float() * 0.3);
        if (rng.chance(sk(BOT_TUNING.dodgeError, s) * 0.5)) react += 250;
        decideAt = Math.min(decideAt, t + react);
        holdUntil = Math.max(holdUntil, t + b.msToArrive + 260);
      }
      if (t >= decideAt) {
        decideAt = Infinity;
        const threats = incoming.map((b) => b.aim);
        const cands = [{ x: -amp, y: 0 }, { x: amp, y: 0 }, { x: 0, y: -amp }, { x: body.lean.x, y: body.lean.y }];
        let best = cands[0], bestD = -1;
        for (const c of cands) {
          const d = Math.min(...threats.map((a) => Math.hypot(c.x - a.x, c.y - a.y)), 9);
          if (d > bestD + 1e-6) { bestD = d; best = c; }
        }
        if (rng.chance(sk(BOT_TUNING.dodgeError, s))) best = rng.chance(0.5) ? rng.pick(cands) : { x: best.x * 0.35, y: best.y * 0.35 };
        body.goal = { x: best.x, y: best.y };
      }
      if (t > holdUntil && decideAt === Infinity) body.goal = { x: 0, y: 0 };
      return body.update(t);
    },
  };
}

function mittsBrain(body, s, rng) {
  const plans = [];          // {at, hand, target, raisedKey}
  const seen = new Set();
  let spamAt = Infinity;
  return {
    update(view) {
      const t = num(view?.t, 0);
      const mitts = Array.isArray(view?.mitts) ? view.mitts : [];
      if (view?.phase === 'active' && !view.timeUp) {
        const live = mitts.filter((m) => m.live);
        live.forEach((m, i) => {
          const key = `${m.presentation}:${m.side}`;
          if (seen.has(key)) return;
          seen.add(key);
          let react = sk(BOT_TUNING.reactMs, s) * (0.85 + rng.float() * 0.35) + i * sk(BOT_TUNING.doubleStepMs, s);
          if (plans.length) react = Math.max(react, plans[plans.length - 1].at - t + sk(BOT_TUNING.doubleStepMs, s));
          let hand = m.side;
          if (rng.chance(sk(BOT_TUNING.mittWrongHand, s))) hand = hand === 'left' ? 'right' : 'left';
          let target = m.height === 'low' ? 'body' : 'head';
          if (rng.chance(sk(BOT_TUNING.mittWrongHeight, s))) target = target === 'body' ? 'head' : 'body';
          plans.push({ at: t + react, hand, target, key, side: m.side });
        });
        for (const p of [...plans]) {
          if (t < p.at) continue;
          plans.splice(plans.indexOf(p), 1);
          const m = mitts.find((x) => x.side === p.side);
          if (!m || `${m.presentation}:${m.side}` !== p.key || !(m.live || m.state === 'lowering')) continue; // gone already
          body.punch(t, p.hand, 'straight', p.target, lerp(0.5, 0.85, s));
        }
        const rate = sk(BOT_TUNING.mittSpamPerSec, s);
        if (spamAt === Infinity && rate > 0) spamAt = t + (-Math.log(1 - rng.float() * 0.999) / rate) * 1000;
        if (t >= spamAt) { body.punch(t, rng.chance(0.5) ? 'left' : 'right'); spamAt = Infinity; }
      }
      return body.update(t);
    },
  };
}
