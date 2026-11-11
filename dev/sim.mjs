#!/usr/bin/env node
// Headless match simulator: scripted "human" bots vs every roster opponent, used to tune the
// ladder (src/game/roster.js) against research/mechanics.md §4.5c and to sanity-check the rules.
// Pure Node, no browser.
//
//   node dev/sim.mjs                          # the tuning table: 'player', 'casual' and 'mid' vs all ten (two-sided, R3)
//   node dev/sim.mjs --n 200 --bots player,casual --tiers 1-10 --seed 7
//   node dev/sim.mjs --legacy                 # the old win-rate grid (idle/guard/spam/beginner/average/smart)
//   node dev/sim.mjs --one player --tier 5 --seed 3 --verbose   # one bout, event log
//   node dev/sim.mjs --no-hitstop             # without the renderer's hit-stop (the old, faster clock)
//
// Time: like MatchSession, every bout runs on a REAL clock and the Match on a game clock that the
// renderer's hit-stop stalls (×0.02 for 0.2 / 0.5 / 0.7 s on the player's hits, 0.45 s on a heavy hit
// on the player — combat.js stallMsFor, the render/fx.js tiers). The bots live on the real clock, so
// they keep moving through a stall exactly as a person in front of the camera does, and "live" time is
// real time while the clock is up (stalls included, as in the footage).
//
// Bots (all play p1 through the same PlayerInput path the camera uses):
//   player   THE TUNING BOT — a skilled webcam player like the one in the reference footage:
//            sees the screen ~40 ms late, decides in ~230 ms (± 50) and needs ~170 ms to move,
//            and the camera reports the body 120 ms (± 25) later; a punch is recognised at FULL
//            EXTENSION, i.e. after that ~170 ms out-stroke plus the camera lag (atExtension, like
//            GestureRecognizer); webcam noise on guard and lean,
//            ~4 % of punches never recognised. Keeps a high guard between bursts (85 %), throws
//            bursts of 1–3 punches (≈1 punch/s overall, 75 % to the head), dodges visible power
//            tells (85 %), drops to a low guard against visible body tells, counters in the
//            slow-motion window, follows up on a reeling opponent, pumps 3–4 punches/s when down.
//   casual   the same body, slower and sloppier (a first-timer).
//   mid      every knob halfway between 'casual' and 'player', learning on (a modest player).
// The tuning is TWO-SIDED (decision R3): 'player' keeps the §4.5c targets, and the weaker bots keep FLOORS —
// 'casual' wins ≥ 90 % against #1–#4, ≥ 25 % against each of #5–#9 and ≥ 15 % against the champion (#10 hits as hard
// as research/mechanics.md §4.5a says, decision R9), 'mid' ≥ 55 % against #7 and #8 — so the PRO tier stays beatable
// for weaker players. The table marks a missed target with * and a missed floor with !.
//   idle     stands there, never moves                → should lose by KO to everyone
//   guard    holds a high guard forever, never punches → body shots beat it
//   spam     throws straight jabs as fast as allowed, never defends
//   smart / average / beginner   the first build's "reads every tell" bots (legacy; still used by tests)

import { pathToFileURL } from 'node:url';
import { Match } from '../src/game/match.js';
import { ROSTER } from '../src/game/roster.js';
import { COMBAT, dodgeLeanFor, stallMsFor } from '../src/game/combat.js';
import { Rng } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ev } from '../src/core/types.js';

/** Presentation stages shortened (they never change who wins); the count and its timing stay real. */
export const SIM_RULES = Object.freeze({
  introArenaMs: 100, bannerMs: 100, flyinMs: 50, ringMs: 50, fightToClockMs: 100,
  roundEndBellMs: 250, roundEndHoldMs: 100, betweenArenaMs: 100,
  standoffMs: 300, getUpAnimMs: 250, koCallDelayMs: 100, koCallStageMs: 50, koHoldMs: 50, decisionMs: 100,
});

/** Win-rate floors for the weaker bots per ladder rung (1-based; decision R3): the PRO tier must stay beatable. */
export const FLOORS = Object.freeze({
  casual: Object.freeze([null, 0.9, 0.9, 0.9, 0.9, 0.25, 0.25, 0.25, 0.25, 0.25, 0.15]),
  mid: Object.freeze([null, null, null, null, null, null, null, 0.55, 0.55, null, null]),
});

/** research/mechanics.md §4.5c tuning targets per ladder rung (1-based). */
export const TARGETS = Object.freeze([
  null,
  { firstKd: [9, 13], hitsPerMin: [0, 4], blocked: [0, 0.2], kdToKo: [1, 2], ending: 'R1' },
  { firstKd: [12, 17], hitsPerMin: [4, 5], blocked: [0.3, 0.45], kdToKo: [1, 2], ending: 'R1' },
  { firstKd: [12, 18], hitsPerMin: [8, 9], blocked: [0.35, 0.5], kdToKo: [2, 2], ending: 'R1' },
  { firstKd: [10, 15], hitsPerMin: [6, 9], blocked: [0.45, 0.55], kdToKo: [1, 3], ending: 'R1' },
  { firstKd: [20, 30], hitsPerMin: [7, 9], blocked: [0.58, 0.67], kdToKo: [3, 4], ending: 'R1-2' },
  { firstKd: [13, 31], hitsPerMin: [8, 13], blocked: [0.5, 0.6], kdToKo: [3, 4], ending: 'R1-2' },
  { firstKd: [25, 60], hitsPerMin: [7, 10], blocked: [0.6, 0.75], kdToKo: [2, 4], ending: 'R2 (3)' },
  { firstKd: [25, 40], hitsPerMin: [5, 7], blocked: [0.5, 0.6], kdToKo: [3, 4], ending: 'R2' },
  { firstKd: [20, 40], hitsPerMin: [8, 10], blocked: [0.4, 0.6], kdToKo: [2, 4], ending: 'R2' },
  { firstKd: [21, 33], hitsPerMin: [9, 12], blocked: [0.35, 0.5], kdToKo: [3, 4], ending: 'R2' },
]);

const other = (id) => (id === 'p1' ? 'p2' : 'p1');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * The player's body as seen by the game: every intent shows up in ControlState `lagMs` later
 * (camera + pose + gesture pipeline). A punch is recognised `lagMs` after it happens — and, for a
 * camera player (`punch.moveMs` > 0), only once the arm reaches full extension: the out-stroke
 * (moveMs ± moveJitterMs) comes first, and the punch carries `atExtension` like GestureRecognizer's.
 */
class LaggedBody {
  /**
   * @param {{moveMs?:number, moveJitterMs?:number, atExtension?:boolean}} [punch]  out-stroke model (legacy bots: none)
   */
  constructor(rng, lagMs = 120, lagJitterMs = 20, noise = 0, punch = {}) {
    this.rng = rng;
    this.lagMs = lagMs;
    this.lagJitterMs = lagJitterMs;
    this.noise = noise;
    this.moveMs = Math.max(0, punch.moveMs || 0);
    this.moveJitterMs = Math.max(0, punch.moveJitterMs || 0);
    this.atExtension = !!punch.atExtension;
    this.intents = [{ t: -1e9, guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 }, activity: 0.2 }];
    this.punches = [];
  }
  /** Change what the body is doing from time t on. */
  set(t, patch) {
    const cur = this.intents[this.intents.length - 1];
    const next = { ...cur, ...patch, lean: { ...cur.lean, ...(patch.lean || {}) }, t };
    this.intents.push(next);
    if (this.intents.length > 64) this.intents.splice(0, this.intents.length - 64);
  }
  current() { return this.intents[this.intents.length - 1]; }
  /** Throw a punch physically at time t (the arm is out moveMs later; the game sees it lagMs after that). */
  punch(t, hand, kind, target, power = 0.7) {
    const move = this.moveMs > 0 ? Math.max(60, this.moveMs + this.rng.normal(0, this.moveJitterMs)) : 0;
    const due = t + move + this.lagMs + this.rng.normal(0, this.lagJitterMs);
    const p = { hand, kind, target, power, t: due };
    if (this.atExtension) p.atExtension = true;
    this.punches.push({ due, punch: p });
  }
  /** PlayerInput as the game would receive it at time t. */
  input(t) {
    const seen = t - this.lagMs;
    let s = this.intents[0];
    for (const it of this.intents) { if (it.t <= seen) s = it; else break; }
    const events = [];
    this.punches = this.punches.filter((p) => {
      if (p.due <= t) { events.push({ type: 'punch', punch: p.punch, t: p.due }); return false; }
      return true;
    });
    const n = this.noise, r = this.rng;
    const up = s.guard === 'high', low = s.guard === 'low';
    const hand = (sign) => ({ x: sign * 0.25, y: up ? 0.5 : low ? -0.4 : 0.2, reach: 0.15, punching: false });
    const amount = s.guard === 'none' ? 0 : clamp(s.guardAmount - (n ? r.float() * n * 0.6 : 0), 0, 1);
    const jit = () => (n ? r.normal(0, n * 0.06) : 0);
    return {
      control: {
        tracked: true, confidence: 1,
        guard: s.guard, guardAmount: amount,
        lean: { x: clamp(s.lean.x + jit(), -1, 1), y: clamp(s.lean.y + jit(), -1, 1), z: clamp(s.lean.z + jit(), -1, 1) },
        head: { x: s.lean.x * 0.5, y: s.lean.y * 0.5 },
        hands: { left: hand(-1), right: hand(1) },
        activity: s.activity,
      },
      events,
    };
  }
}

/** Bot that does nothing at all. */
class IdleBot {
  constructor(rng) { this.body = new LaggedBody(rng); this.body.set(0, { guard: 'none', guardAmount: 0, activity: 0 }); }
  update(t) { return this.body.input(t); }
}

/** Bot that holds a high guard forever and never punches. */
class GuardBot {
  constructor(rng) { this.body = new LaggedBody(rng); this.body.set(0, { guard: 'high', guardAmount: 1, activity: 0.05 }); }
  update(t) { return this.body.input(t); }
}

/** Bot that throws jabs as fast as it can and never defends. */
class SpamBot {
  constructor(rng) {
    this.rng = rng;
    this.body = new LaggedBody(rng);
    this.body.set(0, { guard: 'none', guardAmount: 0, activity: 0.85 });
    this.next = 0;
    this.hand = 'left';
  }
  update(t) {
    if (t >= this.next) {
      this.body.punch(t, this.hand, this.rng.chance(0.8) ? 'straight' : 'hook', 'head', this.rng.range(0.5, 0.9));
      this.hand = this.hand === 'left' ? 'right' : 'left';
      this.next = t + this.rng.range(210, 300);
    }
    return this.body.input(t);
  }
}

/** Presets for the realistic webcam player bot (see the header). */
export const PLAYER_PRESETS = Object.freeze({
  player: {
    lagMs: 120, lagJitterMs: 25, noise: 0.5, seeMs: 40, reactMs: 230, reactJitterMs: 50, moveMs: 170, moveJitterMs: 40,
    guardUp: 0.9, idleLowGuard: 0.04, relaxMs: [500, 1300],
    burstEveryMs: [700, 1500], burstWeights: [0.45, 0.35, 0.2], punchGapMs: [200, 320], headPct: 0.85,
    power: [0.35, 0.95], dodgePower: 0.85, dodgeOrdinary: 0.3, lowGuardBody: 0.45, raiseGuard: 0.6, wrongWay: 0.08,
    counter: 0.85, followUp: 0.55, missRate: 0.04, pumpMs: [250, 340],
    calmAfterAttackMs: [500, 900], calmAfterHitMs: [900, 1500], respectBlock: 0.7, learn: true,
  },
  casual: {
    lagMs: 130, lagJitterMs: 30, noise: 0.7, seeMs: 50, reactMs: 300, reactJitterMs: 70, moveMs: 200, moveJitterMs: 50,
    guardUp: 0.6, idleLowGuard: 0.05, relaxMs: [600, 1600],
    burstEveryMs: [900, 2100], burstWeights: [0.55, 0.3, 0.15], punchGapMs: [230, 380], headPct: 0.8,
    power: [0.3, 0.85], dodgePower: 0.55, dodgeOrdinary: 0.15, lowGuardBody: 0.2, raiseGuard: 0.4, wrongWay: 0.18,
    counter: 0.5, followUp: 0.35, missRate: 0.07, pumpMs: [280, 400],
    calmAfterAttackMs: [300, 700], calmAfterHitMs: [600, 1200], respectBlock: 0.3, learn: false,
  },
});

/** 'mid': every knob halfway between PLAYER_PRESETS.casual and PLAYER_PRESETS.player, learning on (a modest player). */
export const MID_PRESET = Object.freeze((() => {
  const a = PLAYER_PRESETS.casual, b = PLAYER_PRESETS.player, out = {};
  for (const k of Object.keys(b)) {
    if (Array.isArray(b[k])) out[k] = b[k].map((v, i) => (a[k][i] + v) / 2);
    else if (typeof b[k] === 'number') out[k] = (a[k] + b[k]) / 2;
    else out[k] = b[k];
  }
  return out;
})());

const KINDS = { straight: 0.7, hook: 0.2, uppercut: 0.1 };

/** A realistic webcam player: limited perception, human reaction + movement time, camera lag. */
class PlayerBot {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.o = { ...PLAYER_PRESETS.player, ...opts };
    // a camera player: punches are recognised at full extension (the same move time as a dodge or a guard)
    this.body = new LaggedBody(rng, this.o.lagMs, this.o.lagJitterMs, this.o.noise, { moveMs: this.o.moveMs, moveJitterMs: this.o.moveJitterMs, atExtension: true });
    this.body.set(0, { guard: 'high', guardAmount: 1, activity: 0.25 });
    this.plans = [];
    this.seenWindup = 0;
    this.inSlowmo = false;
    this.seenReel = -1e9;
    this.seenHitAt = -1e9;
    this.seenBlockAt = -1e9;
    this.burstPlans = [];
    this.patience = 1;
    this.nextBurstAt = 1200;
    this.busyUntil = 0;     // punching: guard down until then
    this.defendUntil = 0;   // a defensive posture is held until then
    this.hand = 'left';
    this.nextPump = 0;
    this.nextRelaxAt = 0;
  }
  ms(base, jit) { return Math.max(40, base + this.rng.normal(0, jit)); }
  plan(at, fn) { this.plans.push({ at, fn }); }
  swapHand() { this.hand = this.hand === 'left' ? 'right' : 'left'; return this.hand; }
  power() { return this.rng.range(this.o.power[0], this.o.power[1]); }
  throwOne(t, target) {
    if (this.rng.chance(this.o.missRate)) return; // the webcam never saw it
    const kind = this.rng.weighted(KINDS);
    this.body.punch(t, this.swapHand(), kind, target, this.power());
  }
  rest(t) {
    // between exchanges: mostly a high guard, sometimes relaxed
    const r = this.rng, o = this.o;
    const g = r.chance(o.guardUp) ? 'high' : r.chance(o.idleLowGuard / Math.max(0.01, 1 - o.guardUp)) ? 'low' : 'none';
    this.body.set(t, { guard: g, guardAmount: g === 'none' ? 0 : 1, lean: { x: 0, y: 0, z: 0 }, activity: 0.25 });
    this.nextRelaxAt = t + r.range(o.relaxMs[0], o.relaxMs[1]);
  }

  update(t, view, me) {
    const o = this.o, r = this.rng;
    const self = view.boxers[me], foe = view.boxers[other(me)];
    const body = this.body;

    if (this.plans.length) {
      const due = this.plans.filter((p) => p.at <= t);
      if (due.length) {
        this.plans = this.plans.filter((p) => p.at > t);
        for (const p of due) p.fn(t);
      }
    }

    // knocked down: pump punches until up
    if (self.phase === 'down' || view.downed === me) {
      this.plans = [];
      body.set(t, { activity: 0.9, guard: 'none', lean: { x: 0, y: 0, z: 0 } });
      if (t >= this.nextPump) { body.punch(t, this.swapHand(), 'straight', 'head', 0.8); this.nextPump = t + r.range(o.pumpMs[0], o.pumpMs[1]); }
      return body.input(t);
    }
    if (view.phase !== 'fighting') {
      if (this.plans.length || body.current().guard !== 'high') { this.plans = []; this.rest(t); }
      this.busyUntil = 0; this.defendUntil = 0;
      this.nextBurstAt = t + r.range(500, 1300);
      return body.input(t);
    }

    // 0) we just got hit: get the gloves back up (a reaction, not a read)
    const hr = self.hitReact;
    const hrAt = hr && !hr.blocked ? Math.round(view.t - hr.age * 1000) : null;
    if (hrAt != null && Math.abs(hrAt - this.seenHitAt) > 5) {
      this.seenHitAt = hrAt;
      // learning the opponent: getting countered right after a blocked punch makes you more patient
      if (o.learn && hrAt - this.seenBlockAt < 1100) this.patience = Math.min(3, this.patience * 1.25);
      // getting hit makes you careful: no new burst for a moment
      this.nextBurstAt = Math.max(this.nextBurstAt, t + r.range(o.calmAfterHitMs[0], o.calmAfterHitMs[1]));
      if (r.chance(o.raiseGuard)) {
        const at = t + o.seeMs + this.ms(o.reactMs, o.reactJitterMs);
        this.plan(at, (tt) => { if (tt >= this.busyUntil && tt >= this.defendUntil) this.body.set(tt, { guard: 'high', guardAmount: 1 }); });
      }
    }

    // 1) a new telegraph: react if it is visible long enough
    const w = foe.windup;
    if (w && w.id !== this.seenWindup) {
      this.seenWindup = w.id;
      const decide = o.seeMs + this.ms(o.reactMs, o.reactJitterMs);
      const move = this.ms(o.moveMs, o.moveJitterMs);
      const travel = w.powerPunch ? 230 : 110;
      const impactIn = (w.msLeft ?? 0) + travel;
      const visible = impactIn - decide - move; // > 0: the body gets there before impact
      const punch = { kind: w.kind, target: w.target, hand: w.hand };
      let act = null;
      if (w.target === 'body') {
        if (r.chance(o.lowGuardBody)) act = 'low';
      } else if (w.powerPunch) {
        if (r.chance(o.dodgePower)) act = 'dodge';
      } else if (r.chance(o.dodgeOrdinary)) act = 'dodge';
      else if (body.current().guard !== 'high' && r.chance(o.raiseGuard)) act = 'high';
      // noticing an attack: the rest of a burst is abandoned (the gloves come back), and you wait it out
      this.nextBurstAt = Math.max(this.nextBurstAt, t + impactIn + r.range(o.calmAfterAttackMs[0], o.calmAfterAttackMs[1]));
      this.plan(t + decide, (tt) => {
        if (this.burstPlans.length) {
          this.plans = this.plans.filter((p) => !this.burstPlans.includes(p));
          this.burstPlans = [];
          this.busyUntil = Math.min(this.busyUntil, tt + 120);
          if (!act) this.plan(tt + 120, (t2) => { if (t2 >= this.defendUntil) this.rest(t2); });
        }
      });
      if (act) {
        const at = t + decide;
        const hold = Math.max(0, impactIn - decide) + 420;
        this.plan(at, (tt) => {
          let patch;
          if (act === 'dodge') {
            const lean = dodgeLeanFor(punch, r, 0.85) || { x: 0.85, y: 0, z: 0 };
            if (r.chance(o.wrongWay) && punch.kind === 'hook') lean.x = -lean.x;
            patch = { guard: 'high', guardAmount: 1, lean };
          } else patch = { guard: act, guardAmount: 1, lean: { x: 0, y: 0, z: 0 } };
          // the body takes `move` ms to get there: model it as the pose arriving at tt + move
          this.plan(tt + move, (t2) => this.body.set(t2, patch));
          this.defendUntil = Math.max(this.defendUntil, tt + move + hold);
          this.plan(tt + move + hold, (t3) => { if (t3 >= this.defendUntil - 1) this.rest(t3); });
        });
        void visible;
      }
    }

    // 2) our dodge opened the slow-motion window → counter
    const sm = view.slowmo;
    if (!sm) this.inSlowmo = false;
    else if (sm.dodger === me && !this.inSlowmo) {
      this.inSlowmo = true;
      if (r.chance(o.counter)) {
        const at = t + o.seeMs + this.ms(o.reactMs, o.reactJitterMs);
        this.plan(at, (tt) => {
          this.body.set(tt, { guard: 'none', lean: { x: 0, y: 0, z: 0 } });
          this.throwOne(tt, r.chance(0.85) ? 'head' : 'body');
          this.busyUntil = Math.max(this.busyUntil, tt + 380);
          this.defendUntil = 0;
          this.plan(tt + 380, (t3) => this.rest(t3));
        });
      }
    }

    // 2b) our punch hit the gloves (green ring): a careful player stops and covers (the counter is coming)
    const fh = foe.hitReact;
    const blockAt = fh && fh.blocked ? Math.round((view.worldT ?? view.t) - fh.age * 1000) : null;
    if (blockAt != null && Math.abs(blockAt - this.seenBlockAt) > 5) {
      this.seenBlockAt = blockAt;
      if (o.learn) this.patience = Math.min(3, this.patience * 1.06);
      if (r.chance(o.respectBlock)) {
        this.plan(t + o.seeMs + this.ms(o.reactMs, o.reactJitterMs), (tt) => {
          if (this.burstPlans.length) { this.plans = this.plans.filter((p) => !this.burstPlans.includes(p)); this.burstPlans = []; }
          this.busyUntil = Math.min(this.busyUntil, tt);
          this.body.set(tt, { guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } });
          this.nextBurstAt = Math.max(this.nextBurstAt, tt + r.range(400, 900));
        });
      }
    }

    // 3) the opponent reels after our hit → follow up
    const hitAt = foe.hitReact && !foe.hitReact.blocked ? Math.round((view.worldT ?? view.t) - foe.hitReact.age * 1000) : null;
    if (foe.reeling && hitAt != null && Math.abs(this.seenReel - hitAt) > 5 && t >= this.busyUntil - 150) {
      this.seenReel = hitAt;
      if (o.learn) this.patience = Math.max(1, this.patience * 0.94);
      if (r.chance(o.followUp)) {
        const at = t + o.seeMs + this.ms(o.reactMs * 0.8, o.reactJitterMs);
        this.plan(at, (tt) => {
          this.body.set(tt, { guard: 'none' });
          this.throwOne(tt, r.chance(o.headPct) ? 'head' : 'body');
          this.busyUntil = Math.max(this.busyUntil, tt + 350);
          this.plan(tt + 350, (t3) => { if (t3 >= this.busyUntil - 1 && t3 >= this.defendUntil) this.rest(t3); });
        });
      }
    }

    // 4) neutral offence: a burst of 1–3 punches
    if (t >= this.nextBurstAt && t >= this.defendUntil && t >= this.busyUntil && !foe.windup) {
      const n = r.weighted(o.burstWeights.map((x, i) => [i + 1, x])) || 1;
      let at = t;
      this.burstPlans = [];
      for (let i = 0; i < n; i++) {
        const target = r.chance(o.headPct) ? 'head' : 'body';
        const pl = { at, fn: (tt) => { this.burstPlans = this.burstPlans.filter((q) => q !== pl); this.body.set(tt, { guard: 'none', activity: 0.6 }); this.throwOne(tt, target); } };
        this.plans.push(pl);
        this.burstPlans.push(pl);
        at += r.range(o.punchGapMs[0], o.punchGapMs[1]);
      }
      this.busyUntil = at + 120;
      this.plan(this.busyUntil, (tt) => { if (tt >= this.defendUntil) this.rest(tt); });
      this.nextBurstAt = this.busyUntil + r.range(o.burstEveryMs[0], o.burstEveryMs[1]) * this.patience;
    } else if (t >= this.nextRelaxAt && t >= this.busyUntil && t >= this.defendUntil && !this.plans.length) this.rest(t);

    return body.input(t);
  }
}

/** Presets for the legacy "reads every tell" bot. */
export const SMART_PRESETS = Object.freeze({
  smart: { reactMs: 200, reactJitterMs: 50, errorRate: 0.1, tellPenalty: 0.45, tellSlowMs: 120, defendChance: 0.95, counterChance: 0.9, counterReactMs: 170, offenseMs: [800, 1400], flurry: 5, punchPower: [0.6, 1] },
  average: { reactMs: 290, reactJitterMs: 80, errorRate: 0.25, tellPenalty: 0.5, tellSlowMs: 160, defendChance: 0.75, counterChance: 0.55, counterReactMs: 260, offenseMs: [1100, 2000], flurry: 3, punchPower: [0.45, 0.85] },
  beginner: { reactMs: 380, reactJitterMs: 100, errorRate: 0.35, tellPenalty: 0.5, tellSlowMs: 200, defendChance: 0.6, counterChance: 0.35, counterReactMs: 340, offenseMs: [1300, 2400], flurry: 2, punchPower: [0.4, 0.8] },
});

/** Legacy thinking bot (first build): reacts to every tell after reactMs (unrealistically well). */
class SmartBot {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.o = { ...SMART_PRESETS.smart, ...opts };
    this.body = new LaggedBody(rng, opts.lagMs ?? 120, opts.lagJitterMs ?? 20);
    this.body.set(0, { guard: 'high', guardAmount: 1, activity: 0.25 });
    this.plans = [];
    this.seenWindup = 0;
    this.seenOutcome = 0;
    this.defendUntil = 0;
    this.nextOffense = 1500;
    this.flurryLeft = 0;
    this.nextFlurryAt = 0;
    this.hand = 'left';
    this.nextPump = 0;
    this.sawReelAt = -1e9;
  }
  react(base = this.o.reactMs) { return Math.max(90, base + this.rng.normal(0, this.o.reactJitterMs)); }
  plan(at, fn) { this.plans.push({ at, fn }); }
  power() { return this.rng.range(this.o.punchPower[0], this.o.punchPower[1]); }
  swapHand() { this.hand = this.hand === 'left' ? 'right' : 'left'; return this.hand; }
  openTarget(foe) { return foe.guard === 'high' ? 'body' : 'head'; }

  update(t, view, me) {
    const o = this.o, r = this.rng;
    const self = view.boxers[me], foe = view.boxers[other(me)];
    const body = this.body;
    if (this.plans.length) {
      const due = this.plans.filter((p) => p.at <= t);
      if (due.length) {
        this.plans = this.plans.filter((p) => p.at > t);
        for (const p of due) p.fn(t);
      }
    }
    if (self.phase === 'down') {
      this.plans = [];
      body.set(t, { activity: 0.92, guard: 'none', lean: { x: 0, y: 0, z: 0 } });
      if (t >= this.nextPump) { body.punch(t, this.swapHand(), 'straight', 'head', 0.8); this.nextPump = t + r.range(260, 360); }
      return body.input(t);
    }
    if (view.phase !== 'fighting') {
      body.set(t, { activity: 0.2, guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } });
      this.plans = [];
      this.flurryLeft = 0;
      this.defendUntil = 0;
      this.nextOffense = t + r.range(600, 1200);
      return body.input(t);
    }
    if (body.current().activity !== 0.25 && t > this.defendUntil) body.set(t, { activity: 0.25 });
    if (foe.windup && foe.windup.id !== this.seenWindup) {
      const w = foe.windup;
      this.seenWindup = w.id;
      if (r.chance(o.defendChance)) {
        const subtle = 1 - clamp((w.tell && w.tell.pullback) ?? 1, 0.4, 1);
        const delay = this.react(o.reactMs + o.tellSlowMs * subtle);
        const hold = Math.max(0, w.msLeft - delay) + 300 + 260;
        const misread = o.errorRate + o.tellPenalty * subtle;
        this.plan(t + delay, (tt) => this.defend(tt, w, hold, misread));
      }
    }
    const fp = foe.punch;
    if (fp && fp.outcome && fp.id !== this.seenOutcome) {
      this.seenOutcome = fp.id;
      if (fp.outcome === 'dodged' && r.chance(o.counterChance)) {
        this.plan(t + this.react(o.counterReactMs), (tt) => {
          this.body.set(tt, { guard: 'none', lean: { x: 0, y: 0, z: 0.2 } });
          this.body.punch(tt, this.swapHand(), r.chance(0.7) ? 'straight' : 'hook', 'head', this.power());
          this.plan(tt + r.range(230, 300), (t2) => this.body.punch(t2, this.swapHand(), 'straight', 'head', this.power()));
          this.plan(tt + 650, (t3) => this.body.set(t3, { guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } }));
          this.defendUntil = Math.max(this.defendUntil, tt + 400);
        });
      }
    }
    if (foe.reeling && t - this.sawReelAt > 3000) {
      this.sawReelAt = t;
      this.plan(t + this.react(), (tt) => { this.flurryLeft = o.flurry; this.nextFlurryAt = tt; });
    }
    if (this.flurryLeft > 0 && t >= this.nextFlurryAt && !foe.windup) {
      this.flurryLeft--;
      body.set(t, { guard: 'none' });
      body.punch(t, this.swapHand(), r.chance(0.6) ? 'straight' : 'hook', 'head', this.power());
      this.nextFlurryAt = t + r.range(220, 300);
      if (this.flurryLeft === 0) this.plan(t + 300, (tt) => this.body.set(tt, { guard: 'high', guardAmount: 1 }));
    }
    if (t >= this.nextOffense && t >= this.defendUntil && !foe.windup && this.flurryLeft === 0 && !this.plans.length) {
      this.nextOffense = t + r.range(o.offenseMs[0], o.offenseMs[1]);
      const tgt = this.openTarget(foe);
      const kind = r.weighted({ straight: 0.7, hook: 0.2, uppercut: 0.1 });
      this.plan(t + this.react(), (tt) => {
        this.body.set(tt, { guard: 'none' });
        this.body.punch(tt, this.swapHand(), kind, tgt, this.power());
        if (r.chance(0.45)) this.plan(tt + r.range(230, 320), (t2) => this.body.punch(t2, this.swapHand(), 'straight', tgt, this.power()));
        this.plan(tt + 450, (t3) => { if (t3 >= this.defendUntil) this.body.set(t3, { guard: 'high', guardAmount: 1 }); });
      });
    }
    return body.input(t);
  }

  defend(t, w, hold, misread) {
    const r = this.rng;
    const wrong = r.chance(misread);
    let patch;
    if (w.target === 'body') {
      patch = wrong ? { guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } } : { guard: 'low', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } };
    } else if (w.kind === 'hook') {
      const away = w.hand === 'left' ? -1 : 1;
      patch = { guard: 'high', guardAmount: 1, lean: { x: (wrong ? -away : away) * 0.85, y: 0, z: 0 } };
    } else if (w.kind === 'uppercut') {
      patch = wrong ? { guard: 'high', guardAmount: 1, lean: { x: 0, y: -0.85, z: 0 } } : { guard: 'high', guardAmount: 1, lean: { x: r.sign() * 0.85, y: 0, z: 0 } };
    } else {
      patch = wrong ? { guard: 'none', lean: { x: 0, y: 0, z: 0 } } : (r.chance(0.75) ? { guard: 'high', guardAmount: 1, lean: { x: r.sign() * 0.85, y: 0, z: 0 } } : { guard: 'high', guardAmount: 1, lean: { x: 0, y: -0.85, z: 0 } });
    }
    this.body.set(t, { ...patch, activity: 0.4 });
    this.defendUntil = Math.max(this.defendUntil, t + hold);
    this.plan(t + hold, (tt) => { if (tt >= this.defendUntil - 1) this.body.set(tt, { guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 } }); });
  }
}

/**
 * Create a bot. kind ∈ player | casual | mid | idle | guard | spam | smart | average | beginner.
 * @returns {{update(t:number, view:Object, me:'p1'|'p2'):import('../src/core/types.js').PlayerInput}}
 */
export function makeBot(kind, rng, opts = {}) {
  const r = rng instanceof Rng ? rng : new Rng(rng);
  switch (kind) {
    case 'player': return new PlayerBot(r, { ...PLAYER_PRESETS.player, ...opts });
    case 'casual': return new PlayerBot(r, { ...PLAYER_PRESETS.casual, ...opts });
    case 'mid': return new PlayerBot(r, { ...MID_PRESET, ...opts });
    case 'idle': return new IdleBot(r);
    case 'guard': return new GuardBot(r);
    case 'spam': return new SpamBot(r);
    case 'average': return new SmartBot(r, { ...SMART_PRESETS.average, ...opts });
    case 'beginner': return new SmartBot(r, { ...SMART_PRESETS.beginner, ...opts });
    case 'smart': return new SmartBot(r, { ...SMART_PRESETS.smart, ...opts });
    default: throw new Error(`unknown bot "${kind}"`);
  }
}

/**
 * Real ms the renderer's hit-stop stalls the game for a hit (ARCHITECTURE §6.2, research §2.8) with the
 * human in p1: combat.js stallMsFor, i.e. the render/fx.js tiers (the player's hit 0.2 s, big 0.5 s,
 * knockdown blow 0.7 s; a hit on the player 0, heavy 0.45 s).
 */
export function hitStopMs(hit) {
  return stallMsFor(hit, (id) => id === 'p1');
}

/**
 * Simulate one bout: bot (p1) vs a roster opponent (p2).
 * hitStop (default true): emulate MatchSession + the renderer's hit-stop — the game clock runs at
 * COMBAT.hitStop.scale while a stall lasts (the longer stall wins, no stacking, like fx.hitStop) and the
 * Match is told it is stalled; the bot and the "live" time run on the real clock. hitStop false: the old
 * unstalled clock, with the stall estimate added to the live time instead.
 * @returns {{result:Object, windups:number[], tells:number[], powerTells:number[], events:Object, ms:number, metrics:Object}}
 */
export function simulateBout({ opponent, bot = 'player', seed = 1, botOpts = {}, rules = SIM_RULES, dtMs = 1000 / 30, log = null, latencyMs, hitStop = true }) {
  const rng = new Rng(seed);
  const bus = new EventBus();
  const counts = {};
  const windups = [], tells = [], powerTells = [];
  let live = 0, firstKd = null, aiHits = 0, aiHeavy = 0, p1Thrown = 0, p1Blocked = 0, p1Landed = 0, aiThrown = 0, stall = 0;
  const capMs = 1000; // fx: the longest single stall accepted
  bus.on('*', (name, p) => {
    counts[name] = (counts[name] || 0) + 1;
    if (name === Ev.MATCH_WINDUP && p.attacker === 'p2') { windups.push(p.windupMs); (p.powerPunch ? powerTells : tells).push(p.tellMs); }
    if (name === Ev.MATCH_HIT) {
      const ms = hitStopMs(p);
      if (hitStop) { if (ms > 0) stall = Math.max(stall, Math.min(ms, capMs)); } else live += ms;
    }
    if (name === Ev.MATCH_KNOCKDOWN && p.downed === 'p2' && firstKd == null) firstKd = live;
    if (name === Ev.MATCH_HIT && p.attacker === 'p2') { aiHits++; if (p.heavy) aiHeavy++; }
    if (name === Ev.MATCH_HIT && p.attacker === 'p1') p1Landed++;
    if (name === Ev.MATCH_PUNCH_THROWN) { if (p.attacker === 'p1') p1Thrown++; else aiThrown++; }
    if (name === Ev.MATCH_BLOCK && p.attacker === 'p1') p1Blocked++;
    if (log) log(name, p);
  });
  const match = new Match({ bus, mode: 'single', p1: { name: `bot:${bot}`, isHuman: true }, p2: opponent, rng: rng.fork('match'), rules, id: `sim-${seed}`, latencyMs });
  const b = makeBot(bot, rng.fork('bot'), botOpts);
  const scaleOf = () => (stall > 0 ? COMBAT.hitStop.scale : 1);
  match.start(0);
  let now = 0, game = 0;
  const limit = 30 * 60 * 1000;
  while (match.phase !== 'result' && now < limit) {
    now += dtMs;
    const scale = scaleOf();
    game += dtMs * scale;
    const view = match.getView();
    if (view.phase === 'fighting' && !view.tutorial) live += dtMs;
    // the bot lives on the real clock (with hitStop off both clocks are the same)
    const input = b.update(hitStop ? now : view.t, view, 'p1');
    match.update((dtMs * scale) / 1000, game, { p1: input }, { stalled: scale < 1 });
    stall = Math.max(0, stall - dtMs); // fx.update(realDt) runs after the session update
  }
  const result = match.getResult();
  return {
    result, windups, tells, powerTells, events: counts, ms: now,
    metrics: { liveMs: live, firstKdMs: firstKd, aiHits, aiHeavy, aiThrown, p1Thrown, p1Blocked, p1Landed },
  };
}

const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Run many bouts and aggregate (win rates plus the §4.5c tuning metrics). */
export function simulateMany({ opponent, bot, n = 40, seed = 1, botOpts = {}, rules = SIM_RULES, latencyMs, hitStop = true }) {
  const agg = {
    n, win: 0, loss: 0, draw: 0, koWin: 0, koLoss: 0, decWin: 0, decLoss: 0, rounds: 0, kdFor: 0, kdAgainst: 0,
    landed: 0, thrown: 0, aiLanded: 0, aiThrown: 0, minWindup: Infinity, minTell: Infinity, minPowerTell: Infinity, counters: 0, dodged: 0, blocked: 0,
    firstKd: [], liveMs: 0, aiHits: 0, aiHeavy: 0, p1Thrown: 0, p1Blocked: 0, kdToKo: [], endings: { 1: 0, 2: 0, 3: 0 }, playerKdBouts: 0,
  };
  for (let i = 0; i < n; i++) {
    const { result: r, windups, tells, powerTells, metrics: m } = simulateBout({ opponent, bot, seed: seed * 100003 + i * 7919, botOpts, rules, latencyMs, hitStop });
    if (!r) continue;
    if (r.winner === 'p1') { agg.win++; if (r.method === 'KO' || r.method === 'TKO') { agg.koWin++; agg.kdToKo.push(r.knockdowns.p2); } else agg.decWin++; }
    else if (r.winner === 'p2') { agg.loss++; if (r.method === 'KO' || r.method === 'TKO') agg.koLoss++; else agg.decLoss++; }
    else agg.draw++;
    agg.rounds += r.endRound;
    agg.endings[r.endRound] = (agg.endings[r.endRound] || 0) + 1;
    agg.kdFor += r.stats.p1.knockdownsScored;
    agg.kdAgainst += r.stats.p2.knockdownsScored;
    if (r.stats.p2.knockdownsScored > 0) agg.playerKdBouts++;
    agg.landed += r.stats.p1.landed; agg.thrown += r.stats.p1.thrown;
    agg.aiLanded += r.stats.p2.landed; agg.aiThrown += r.stats.p2.thrown;
    agg.counters += r.stats.p1.counters; agg.dodged += r.stats.p1.dodged; agg.blocked += r.stats.p1.blocked;
    for (const w of windups) agg.minWindup = Math.min(agg.minWindup, w);
    for (const w of tells) agg.minTell = Math.min(agg.minTell, w);
    for (const w of powerTells) agg.minPowerTell = Math.min(agg.minPowerTell, w);
    if (m.firstKdMs != null) agg.firstKd.push(m.firstKdMs / 1000);
    agg.liveMs += m.liveMs; agg.aiHits += m.aiHits; agg.aiHeavy += m.aiHeavy; agg.p1Thrown += m.p1Thrown; agg.p1Blocked += m.p1Blocked;
  }
  agg.firstKdMedian = median(agg.firstKd);
  agg.hitsPerMin = agg.liveMs > 0 ? agg.aiHits / (agg.liveMs / 60000) : 0;
  agg.heavyPerMin = agg.liveMs > 0 ? agg.aiHeavy / (agg.liveMs / 60000) : 0;
  agg.blockedShare = agg.p1Thrown > 0 ? agg.p1Blocked / agg.p1Thrown : 0;
  agg.kdToKoMean = agg.kdToKo.length ? agg.kdToKo.reduce((a, b) => a + b, 0) / agg.kdToKo.length : NaN;
  agg.punchesPerLiveSec = agg.liveMs > 0 ? agg.p1Thrown / (agg.liveMs / 1000) : 0;
  return agg;
}

function parseArgs(argv) {
  const o = { n: 60, bots: ['player', 'casual', 'mid'], tiers: [1, 10], seed: 1, verbose: false, one: null, tier: 1, legacy: false, latency: undefined, hitStop: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--n') { o.n = Number(v); i++; }
    else if (a === '--bots') { o.bots = v.split(','); i++; }
    else if (a === '--tiers') { const [x, y] = v.split('-').map(Number); o.tiers = [x, y || x]; i++; }
    else if (a === '--seed') { o.seed = Number(v); i++; }
    else if (a === '--one') { o.one = v; i++; }
    else if (a === '--tier') { o.tier = Number(v); i++; }
    else if (a === '--latency') { o.latency = Number(v); i++; }
    else if (a === '--legacy') { o.legacy = true; o.bots = ['idle', 'guard', 'spam', 'beginner', 'average', 'smart']; }
    else if (a === '--no-hitstop') o.hitStop = false;
    else if (a === '--verbose') o.verbose = true;
  }
  return o;
}

const pct = (a, n) => `${String(Math.round((100 * a) / Math.max(1, n))).padStart(3)}%`;
const inRange = (v, [a, b]) => Number.isFinite(v) && v >= a - 1e-9 && v <= b + 1e-9;
const mark = (ok) => (ok ? ' ' : '*');
/** The win-rate floor of a bot at a rung (null: none). */
export function floorFor(bot, tier) { const f = FLOORS[bot]; return f && Number.isFinite(f[tier]) ? f[tier] : null; }

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.one) {
    const opp = ROSTER[clamp(o.tier, 1, ROSTER.length) - 1];
    const lines = [];
    const { result, ms, metrics } = simulateBout({
      opponent: opp, bot: o.one, seed: o.seed, latencyMs: o.latency, hitStop: o.hitStop,
      log: o.verbose ? (name, p) => lines.push(`${name} ${JSON.stringify(p).slice(0, 170)}`) : null,
    });
    if (o.verbose) console.log(lines.join('\n'));
    console.log(`\n${o.one} vs ${opp.name} (tier ${opp.tier}) seed ${o.seed}: winner=${result.winner} method=${result.method} round=${result.endRound} (${Math.round(ms / 1000)} s sim, ${Math.round(metrics.liveMs / 1000)} s live)`);
    console.log('metrics', metrics);
    console.log('p1', result.stats.p1);
    console.log('p2', result.stats.p2);
    if (result.scorecards.length) console.log('cards', result.scorecards.map((c) => `${c.judge} ${c.p1}-${c.p2}`).join(' | '));
    return;
  }
  const t0 = Date.now();
  console.log(`Glove Up ladder sim — ${o.n} bouts per cell, seed ${o.seed}${o.latency != null ? `, latency ${o.latency} ms` : ''}${o.hitStop ? '' : ', NO hit-stop'}\n`);
  if (o.legacy) {
    console.log('tier opponent             bot      win  loss draw | KOwin KOloss | rnds  KD+  KD- | p1 L/T     acc | ai L/T    acc | ctr/b minTell');
  } else {
    console.log('tier opponent             bot     | 1st KD live s  (target) | AI hits/min (target) heavy | blocked (target) | KDs→KO (target) | R1/R2/R3   | win  KO  | you down | p/s');
  }
  let misses = 0, floorMisses = 0;
  for (const opp of ROSTER) {
    if (opp.tier < o.tiers[0] || opp.tier > o.tiers[1]) continue;
    for (const bot of o.bots) {
      const a = simulateMany({ opponent: opp, bot, n: o.n, seed: o.seed, latencyMs: o.latency, hitStop: o.hitStop });
      if (o.legacy) {
        console.log(
          `${String(opp.tier).padStart(4)} ${opp.name.padEnd(20)} ${bot.padEnd(7)} ${pct(a.win, a.n)} ${pct(a.loss, a.n)} ${pct(a.draw, a.n)} | ${pct(a.koWin, a.n)}  ${pct(a.koLoss, a.n)} | ` +
          `${(a.rounds / a.n).toFixed(2)} ${(a.kdFor / a.n).toFixed(1).padStart(4)} ${(a.kdAgainst / a.n).toFixed(1).padStart(4)} | ` +
          `${String(Math.round(a.landed / a.n)).padStart(3)}/${String(Math.round(a.thrown / a.n)).padEnd(4)} ${pct(a.landed, a.thrown)} | ${String(Math.round(a.aiLanded / a.n)).padStart(3)}/${String(Math.round(a.aiThrown / a.n)).padEnd(4)} ${pct(a.aiLanded, a.aiThrown)} | ${(a.counters / a.n).toFixed(1).padStart(4)}  ${a.minTell === Infinity ? '-' : Math.round(a.minTell)}`,
        );
        continue;
      }
      const T = TARGETS[opp.tier];
      const kdm = a.firstKdMedian;
      const end = a.endings;
      if (bot === 'player') misses += [inRange(kdm, T.firstKd), inRange(a.hitsPerMin, T.hitsPerMin), inRange(a.blockedShare, T.blocked), inRange(a.kdToKoMean, T.kdToKo)].filter((x) => !x).length;
      const floor = floorFor(bot, opp.tier);
      const floorOk = floor == null || a.win / Math.max(1, a.n) >= floor - 1e-9;
      if (!floorOk) floorMisses++;
      console.log(
        `${String(opp.tier).padStart(4)} ${opp.name.padEnd(20)} ${bot.padEnd(7)} | ` +
        `${(Number.isFinite(kdm) ? kdm.toFixed(1) : '-').padStart(5)}${mark(inRange(kdm, T.firstKd))} (${T.firstKd.join('–').padEnd(5)}) | ` +
        `${a.hitsPerMin.toFixed(1).padStart(5)}${mark(inRange(a.hitsPerMin, T.hitsPerMin))} (${T.hitsPerMin.join('–').padEnd(5)}) ${a.heavyPerMin.toFixed(1).padStart(4)} | ` +
        `${pct(a.p1Blocked, a.p1Thrown)}${mark(inRange(a.blockedShare, T.blocked))} (${Math.round(T.blocked[0] * 100)}–${Math.round(T.blocked[1] * 100)}%) | ` +
        `${(Number.isFinite(a.kdToKoMean) ? a.kdToKoMean.toFixed(1) : '-').padStart(4)}${mark(inRange(a.kdToKoMean, T.kdToKo))} (${T.kdToKo.join('–')})     | ` +
        `${pct(end[1] || 0, a.n)}/${pct(end[2] || 0, a.n)}/${pct(end[3] || 0, a.n)} ${T.ending.padEnd(6)} | ${pct(a.win, a.n)}${floorOk ? ' ' : '!'}${pct(a.koWin, a.n)} | ${pct(a.playerKdBouts, a.n)}    | ${a.punchesPerLiveSec.toFixed(2)}`,
      );
    }
  }
  if (!o.legacy) console.log(`\n'player' outside §4.5c in ${misses} cells; weaker bots below their win floor in ${floorMisses} rows`);
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s   (* = outside the §4.5c target, ! = below the bot's win floor: casual ≥ 90 % #1–#4, ≥ 25 % #5–#9 and ≥ 15 % #10, mid ≥ 55 % #7/#8)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
