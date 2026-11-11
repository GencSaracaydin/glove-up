// Opponent brains (PRG01: opponents get tougher and create chances to practise guarding,
// evasion and counter-attacking). Pure logic, deterministic for a given Rng.
//
//   const ai = new OpponentAI(rosterEntry, rng.fork('ai'), { latencyMs });
//   each frame (FIGHTING only):  const intent = ai.update(dt, tMs, selfBoxer, foe, matchView);
//                                selfBoxer.applyIntent(intent, tMs);
//                                if (intent.punch) selfBoxer.startWindup(intent.punch, tMs);
//   at contact of a foe punch:   ai.readFor(punch, tMs, selfBoxer) → 'block' | 'open' | null
//   ai.reset(tMs) when the clock starts (round start, after a knockdown); ai.newRound(n) per round.
//
// The AI runs on the Match's WORLD clock (slowed during the human's dodge slow motion); `foe` is
// the other boxer as seen in world time (match.js passes a time-converting view of a human).
//
// What it does — research/mechanics.md §4.1–§4.6, numbers per opponent in roster.js (§4.5):
//   1. Walks in at "Fight!" and attacks firstAttackMs after the clock starts (no grace, §1.4).
//   2. Bobs in place between attacks, gloves where its guardStyle puts them (most: high).
//   3. Attacks with single punches, one-twos and strings of 3–4 (stringWeights), head and body
//      (bodyPct), sometimes a telegraphed power punch (powerPct, powerTellMs ≥ 0.55 s + latency).
//      Ordinary tells are as measured (tellMs 0.18–0.45 s): you are meant to keep a guard up.
//   4. Punishes in four ways: counter after blocking (punishPct, green ring → impact punishDelayMs —
//      the punish replaces the rest of a pending attack, and a wind-up already cocked becomes the
//      counter when it lands inside the measured block → counter window, so PRO opponents punish
//      "nearly every blocked punch", §4.2/§4.4); ONCE per blocked exchange (RV-RULES-03): a flurry into
//      the guard shares its first block's roll, nothing rolls while a punish is planned, cocked or in the
//      air, and a punish that can only start late keeps this opponent's normal tell); from #5 up, against a
//      player who keeps punching into the guard (blocked again soon after a green ring, on a steady beat, or
//      mashing: quick punches with a guard shown in between), the punish goes into that player's next punch
//      instead — caught, then countered while the glove is out (§2.4, R10: nothing is shown until then, and
//      none is thrown if no punch comes — see _fireArmed); the
//      player's miss = a slip (slipPct per head punch, counter slipCounterMs later); punching into the
//      player's punch (punchIntoPct, landing 0.17–0.23 s after it starts). AI counters do the heavy ×2.5
//      damage (combat.js).
//   5. Keeps hitting a reeling player (stringGapReelMs, followUpPct extends a string).
//   6. Covers up with a high guard for 0.9 s (real time: the hit-stop of the second hit is netted out)
//      after two hits within 1 s (coverUpPct).
//   7. Holds a cocked punch up to holdWhileLeanMs while the player leans, releasing when they
//      come back to centre (§4.1.7). Our own extension (E, decision R2): a dodge posture held
//      postureAnswerMs (~1 s) is answered — postureAnswerPct of the punches chosen meanwhile, and every
//      planned counter, are one that posture does not evade and the guard does not block (an uppercut
//      against a duck or a forward tilt, with or without a side lean; the other hook against a sideways
//      lean; a body shot under a high guard; a step-in head shot against a back lean), from the opponent's
//      own kit, aimed past the guard the player KEEPS between punches; a cocked punch held through such a
//      posture is pulled back and re-thrown as that answer (only when there is one). A posture taken again
//      after less than COMBAT.freshDodgeResetMs is the same; so is one the player keeps bobbing back into
//      (in a posture postureDutyPct of the recent time, R10), answered as that posture between two dips;
//      against a held posture every blocked punch may be punished; the posture is followed across clock
//      restarts (a turtle that holds its keys through a knockdown is still holding them).
//   8. Never gets groggy (no daze meter at all).
//   9. Mood can change between rounds (moodSwing; attackGapByRound for a scripted change).
// Blocking is a READ (headGuard / bodyGuard): when a player punch starts while the AI is idle (not
// reeling, not punching) it decides at once whether it will cover that zone (the gloves move there
// in time) — pure reaction could never beat a 0.1 s punch with no wind-up. readFor() tells the Match.
// From #5 up the body read follows the player's habit (R10, E): when most of their recent punches go to
// the body, it rises toward the head read (a fighter tucks an elbow, §2.4 "dropping one glove can block a
// body shot"), so going to the body every time is no free path.
//
// Tutorial (ARCHITECTURE §6.9): setScript(step) replaces all of the above with a passive script
// per step (see SCRIPT below).

import { COMBAT, dodgeLeanFor, openTarget, guardFor, isLeaning, evasionFor, travelMs, netOfStall } from './combat.js';
import { toRng } from '../core/rng.js';

/** Default AI parameters (roster entries override any subset under `ai`; see roster.js header). */
export const AI_DEFAULTS = Object.freeze({
  // offence (§4.5a)
  firstAttackMs: 1500,          // clock start → first wind-up …
  firstAttackJitter: 0.2,       // … × U(1 ± this)
  attackGapMs: 3000,            // rest between attack sequences …
  attackGapJitter: 0.35,        // … × U(1 ± this)
  attackGapByRound: null,       // optional [r1, r2, r3] override of attackGapMs
  tellMs: 300,                  // ordinary tell (first movement → impact)
  bodyTellMs: null,             // tell for body punches (null = tellMs)
  tellJitterMs: 30,
  stringWeights: [0.6, 0.4],    // punches per attack: weights for 1, 2, 3, 4
  stringGapMs: 500,             // impact → next impact inside an attack ([min, max] or number)
  stringGapReelMs: null,        // … when the previous punch landed (player reeling)
  stringGapHeadBodyMs: null,    // … when switching from head to body
  bodyPct: 0.3,
  powerPct: 0,
  powerTellMs: 600,
  powerDamage: 2.5,
  powerKind: 'hook',
  powerBodyPct: 0.15,           // share of power punches aimed at the body
  ordinaryDamage: 1.1,
  firstPunchDamage: null,       // first punch of an attack (#3: 1.5)
  punchMix: { straight: 0.6, hook: 0.3, uppercut: 0.1 },
  leadHandBias: 0.65,           // straights open with the lead hand (jab) this often
  smartTargeting: 0.2,          // counters: chance to aim at the player's open zone (high guard → body …)
  followUpPct: 0.2,             // a punch landed → chance to add one more punch to the string
  feintChance: 0,               // a pulled wind-up (personality; never two in a row)
  // defence (§4.5b)
  headGuard: 0.5,
  bodyGuard: 0.2,
  slipPct: 0,
  slipCounterMs: 250,
  punishPct: 0,
  punishDelayMs: [400, 800],
  punishWindowMs: [200, 820],   // a wind-up already under way becomes the punish if it lands this long after
                                // the green ring (§2.3, §4.3: block → counter impact 0.20–0.82 s)
  exchangeMs: 700,              // blocks within this of an exchange's first block share its punish roll …
  punishedMs: 300,              // … and none rolls again until a punish's impact + this (RV-RULES-03)
  // R10, §2.4 "a counter … lands while the player's glove is still out" (_fireArmed): against a foe that keeps punching
  // into the guard — its blocked punch comes within punishMashMs of an earlier green ring, or it punches on a steady beat
  // (the last three gaps within ±punishBeatTol of their median, at most punishBeatMaxMs) — a punish is not thrown at a guard
  // that is back up by then: nothing shows, and the opponent punches into the foe's next punch if that starts within
  // punishArmMs of the green ring (1.2 × a steady beat when that is longer); with no punch, no punish. A foe that mashes —
  // punishMashChain punches in a row, each within punishMashMs of the last with its guard shown in between (a guard key
  // held while a punch key is tapped) — has every punch it throws at a free opponent caught and countered that way. Every
  // other punish goes at its planned time, as measured (§2.3)
  punishIntoGlove: 1,           // 0 = never (the low tiers, which rarely counter)
  punishMashMs: 1000,
  punishMashChain: 3,
  punishArmMs: 1300,
  punishBeatMaxMs: 1600,
  punishBeatTol: 0.25,
  punchIntoPct: 0,
  punchIntoMs: [170, 230],      // the punch-into lands this long after the player's punch started
  coverUpPct: 0,
  coverMs: 900,                 // REAL ms (§2.7: ~0.9–1.0 s): the second hit's hit-stop is netted out
  coverWindowMs: 1000,          // "two hits within 1 s"
  guardStyle: 'high',           // 'high' | 'low' | 'open' | 'switch'
  guardSwitchMs: 2200,          // 'switch': mean time between guard heights
  holdWhileLeanMs: 0,
  // a posture held this long (a duck, a lean, a back lean or a forward tilt, or several at once) is answered (our own
  // design, E — the reference only shows an opponent waiting out a lean, §2.5): postureAnswerPct of the punches chosen
  // meanwhile, and every planned counter, are one that posture does not evade and the guard does not block (an
  // uppercut against a duck or a forward tilt, the other hook against a sideways lean, a body shot against a high
  // guard, a step-in head shot against a back lean; only kinds in punchMix), and a cocked punch held through the lean
  // (holdWhileLeanMs) is pulled back and re-thrown as that answer
  postureAnswerMs: 1000,
  postureAnswerPct: 0.5,
  postureDutyMs: 2000,          // R10: so is a posture the foe keeps going back to — in one postureDutyPct of the recent
  postureDutyPct: 0.55,         //   time (EMA, this time constant; 0 = off) — answered as the posture it bobs into
  turtlePunishEach: 1,          // R10: while a posture is held, every blocked punch may be punished (no shared exchange)
  moodSwing: 0,                 // chance per round of a defensive (gaps ×1.5, guard +0.1) or aggressive (×0.65, −0.05) mood
  guardByRound: null,           // optional per-round offsets added to headGuard/bodyGuard (e.g. a cagey first round)
  bodyReadAdapt: 1,             // R10 (E): when more than bodyReadFree of the foe's recent punches (EMA, bodyReadEma per punch)
  bodyReadFree: 0.55,           //   go to the body, the body read rises toward the head read — all the way for a foe who goes
  bodyReadEma: 0.15,            //   nowhere else (× this; 0 = never: the low tiers keep their open body)
  readHoldMs: 260,              // keep a read guard this long after the punch's contact …
  streakBlock: 0.85,            // … and meanwhile block the next punch to the same zone at least this often
  postReelGuardMs: 400,         // after a reel the head is covered like that for this long
  flurryWindowMs: 900,          // the 3rd+ player punch within this window …
  flurryGuard: 0.25,            // … gets this much more read chance
  attackGuardMul: 0.5,          // while its own punch is out, the other glove still covers this share of reads
  stunRecoverDelayMs: 150,      // after a reel, wait at least this long before attacking
  openFoeMs: 450,               // the player has had no guard this long …
  openFoePressure: 0.5,         // … → chance to bring the next attack forward
  stayDown: [0.2, 0.3, 0.4],    // used by match.js
  riseMean: [6, 7, 8],          // used by match.js
});

/** Tutorial scripts (ARCHITECTURE §6.9). every: [min,max] ms between attacks; tellMs ≥ 0.8 s for dodge. */
export const SCRIPT = Object.freeze({
  stance:       { guard: 'none', attack: null },
  'guard-head': { guard: 'high', attack: { kind: 'straight', target: 'head', tellMs: 700, every: [1500, 2000], power: false }, firstMs: 1200 },
  'punch-head': { guard: 'none', attack: null, reads: { head: 'open', body: 'open' } },
  'guard-body': { guard: 'high', attack: { kind: 'straight', target: 'body', tellMs: 700, every: [1500, 2000], power: false }, firstMs: 1200 },
  'punch-body': { guard: 'high', attack: null, reads: { head: 'block', body: 'open' } },
  dodge:        { guard: 'high', attack: { kind: 'hook', target: 'head', tellMs: 950, every: [2000, 2600], power: true }, firstMs: 1500 },
});

const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
/** A foe that shows no guard this long has really dropped it (a keyboard punch drops the guard for 0.4–0.6 s). */
const GUARD_DROP_MS = 700;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const other = (h) => (h === 'left' ? 'right' : 'left');
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Merge roster ai params over the defaults (objects/arrays copied). */
export function aiParams(def) {
  const src = (def && def.ai) || {};
  const p = { ...AI_DEFAULTS, ...src };
  p.punchMix = { ...(src.punchMix || AI_DEFAULTS.punchMix) };
  for (const k of ['stringWeights', 'punishDelayMs', 'punishWindowMs', 'punchIntoMs', 'stayDown', 'riseMean']) {
    const v = src[k] ?? AI_DEFAULTS[k];
    p[k] = Array.isArray(v) ? v.slice() : v;
  }
  if (Array.isArray(src.attackGapByRound)) p.attackGapByRound = src.attackGapByRound.slice();
  if (Array.isArray(src.stringGapMs)) p.stringGapMs = src.stringGapMs.slice();
  p.tellMs = Math.max(COMBAT.minTellMs, num(Number(p.tellMs), AI_DEFAULTS.tellMs));
  return p;
}

const range = (rng, v) => (Array.isArray(v) ? (v.length > 1 ? rng.range(v[0], v[1]) : v[0]) : v);

export class OpponentAI {
  /**
   * @param {Object} def  roster entry (uses def.ai; see AI_DEFAULTS)
   * @param {import('../core/rng.js').Rng|number|string} [rng]
   * @param {{latencyMs?:number, tuning?:Object}} [opts]  latency raises the power-tell floor (§4.6)
   */
  constructor(def, rng, opts = {}) {
    this.def = def || {};
    this.p = aiParams(this.def);
    this.rng = toRng(rng);
    this.tuning = opts.tuning || COMBAT;
    this.latencyMs = Math.max(0, num(opts.latencyMs, this.tuning.latencyMs ?? 100));
    this.round = 1;
    this.mood = 1;
    this.guardMood = 0;
    this.script = null;
    /** Wind-ups requested (for tests / telemetry): last 300 [{t, windupMs, tellMs, kind, target, hand, powerPunch, counter, reason}]. */
    this.log = [];
    /** Reads of foe punches: id → 'block' | 'open' | 'slip'. */
    this.reads = new Map();
    this.lastSeenFoePunchId = 0;
    this.foeStarts = [];
    this.seenFoeOutcome = new Set();
    this.seenOwnOutcome = new Set();
    // the foe's dodge posture, followed across clock restarts (a posture held through a stoppage is still held)
    this.foePostureSince = null; // world time the foe's current dodge posture began (null: not leaning)
    this.foePostureOffAt = null; // … and when it last came back to the stance (a posture ends after freshDodgeResetMs)
    this.foeDuty = 0;            // share of the recent time the foe spent in a dodge posture (EMA over postureDutyMs)
    this.foeDutyT = null;
    this.foePostureLean = null;  // the lean of the foe's latest posture (a bobbing posture is answered as that one)
    this.foeBodyShare = 0.2;     // share of the foe's recent punches aimed at the body (EMA per punch; the body read follows it)
    this.foeGuardShown = false;  // the foe showed a guard since its last punch …
    this.foeMashChain = 0;       // … and how many punches in a row came that way, each within punishMashMs (mashing)
    this.foeLastPunchAt = -Infinity; // when the foe's latest punch started (world time)
    this.reset(0);
  }

  /** Latency changed (calibration): power tells follow it. */
  setLatency(ms) { if (Number.isFinite(ms)) this.latencyMs = Math.max(0, ms); }

  /** Fresh start when the clock starts (round start, after a knockdown): first attack per §4.5a. */
  reset(t) {
    const p = this.p, r = this.rng;
    this.nextAttackAt = t + p.firstAttackMs * r.range(1 - p.firstAttackJitter, 1 + p.firstAttackJitter);
    this.string = null;          // current attack: {left, nextImpactAt, lastTarget, lastHand, lastId, pending, first}
    this.counterPlan = null;     // {impactAt, target?, kind?, reason}
    // one punish per blocked exchange (RV-RULES-03): the first block of an exchange rolls punishPct, later blocks
    // inside exchangeMs share that roll, and nothing is rolled while a punish is planned, cocked or in the air
    this.exchangeUntil = -Infinity;
    this.punishedUntil = -Infinity;
    // a masher is still one when the clock starts again (its keys did not change during the stoppage): its first punch
    // within punishMashMs of the restart carries the chain on
    this.foeLastPunchAt = this.foeMashChain >= num(p.punishMashChain, AI_DEFAULTS.punishMashChain) ? t : -Infinity;
    this.foeBeat = [];               // the foe's last four punch starts (a steady beat is read, _foeBeatMs)
    this.foeRingAt = -Infinity;      // the latest green ring (a foe punch blocked): blocked again soon after = mashing
    this.punishArmed = null;         // {blockAt, until}: a punish waiting, unseen, for the foe's next punch (R10)
    this.answerNext = false;     // a cocked punch was pulled back from a held posture: the next punch answers it
    this.foeGuardKept = null;    // the guard the foe keeps up between its own punches ('high'|'low'|'none'; null: unseen)
    this.foeGuardOffSince = null; // … and since when it has shown no guard at all
    this.readGuard = null;       // {guard, until}
    this.slip = null;            // {lean, until}
    this.lastWasFeint = false;
    this.recentHits = [];
    this.lastHitSeenAt = -1;
    this.coverRolledAt = -1;
    this.lastHand = null;
    this.foeOpenSince = null;
    this.openRolled = false;
    this.habit = this._styleGuard();
    this.nextSwitchAt = t + p.guardSwitchMs * r.range(0.7, 1.3);
    this.swayPhase = r.range(0, Math.PI * 2);
    this.scriptNextAt = t + (this.script ? (SCRIPT[this.script]?.firstMs ?? 1500) : 0);
  }

  /** A new round begins (mood may change, §4.1.9). */
  newRound(round) {
    const p = this.p, r = this.rng;
    this.round = Math.max(1, round | 0);
    this.mood = 1;
    this.guardMood = 0;
    if (p.moodSwing > 0 && r.chance(p.moodSwing)) {
      const aggressive = r.chance(0.5);
      this.mood = aggressive ? 0.65 : 1.5;
      this.guardMood = aggressive ? -0.05 : 0.1;
    }
    if (Array.isArray(p.guardByRound)) {
      const g = p.guardByRound[Math.min(this.round, p.guardByRound.length) - 1];
      if (Number.isFinite(g)) this.guardMood += g;
    }
  }

  /** Read chance for a punch at this height, this round (mood included). */
  _guardChance(head) {
    const base = head ? this.p.headGuard : this.p.bodyGuard;
    return clamp(base + (this.guardMood || 0) * (head ? 1 : 0.6), 0, 0.98);
  }

  /**
   * The read chance actually used: the head read, or the body read raised toward it when more than bodyReadFree of the
   * foe's recent punches went to the body (R10, E: a foe who only goes to the body meets the head read there too).
   */
  _readChance(head) {
    const p = this.p, g = this._guardChance(head);
    if (head) return g;
    const free = num(p.bodyReadFree, AI_DEFAULTS.bodyReadFree);
    const k = clamp(num(p.bodyReadAdapt, 0), 0, 1) * clamp((this.foeBodyShare - free) / Math.max(1e-6, 1 - free), 0, 1);
    return k > 0 ? g + Math.max(0, this._guardChance(true) - g) * k : g;
  }

  /** The foe goes to the body more often than not (R10: from #5 up the gloves are set low after a reel, not high). */
  _bodyFoe() {
    return num(this.p.bodyReadAdapt, 0) > 0 && this.foeBodyShare > num(this.p.bodyReadFree, AI_DEFAULTS.bodyReadFree);
  }

  /** Tutorial: run a scripted, passive opponent for this step (null = normal brain). */
  setScript(step, t = 0) {
    this.script = step && SCRIPT[step] ? step : null;
    this.string = null;
    this.counterPlan = null;
    this.readGuard = null;
    this.slip = null;
    this.scriptNextAt = t + (this.script ? (SCRIPT[this.script].firstMs ?? 1500) : 0);
  }

  _styleGuard() {
    const s = this.p.guardStyle;
    return s === 'low' ? 'low' : s === 'open' ? 'none' : 'high';
  }

  // ───────────────────────────── the Match asks ─────────────────────────────

  /**
   * How this AI meets a foe punch at contact: 'block' (covers that zone), 'open' (it lands), or null
   * (no read — use the boxer's own guard). Reeling / punching AIs never read: their guard is open.
   */
  readFor(punch, t, self) {
    if (!punch) return null;
    if (this.script) {
      const sc = SCRIPT[this.script];
      if (sc.reads) return sc.reads[punch.target === 'body' ? 'body' : 'head'] || null;
      return null;
    }
    const r = this.reads.get(punch.id);
    if (self && typeof self.effectiveGuard === 'function') {
      if (!self.canAct(t) && !self.isCovering(t)) return null;   // reeling: open anyway
      if (r === 'catch') return 'block'; // the glove that was set for this punch (an armed punish, R10) catches it
      // a missed glove hanging out (or the guard still coming back): wide open — the counter window
      if ((typeof self.isWhiffing === 'function' && self.isWhiffing(t)) || t < (self.guardBackAt ?? -Infinity)) return 'open';
      if (self.punches && self.punches.length) {
        // own punch out / pulling back: only the other glove guards (attackGuardMul of the usual read)
        if (typeof self.isMidPunch === 'function' && !self.isMidPunch(t)) return null;
        return this.rng.chance(this._readChance(punch.target !== 'body') * this.p.attackGuardMul) ? 'block' : 'open';
      }
    }
    if (!r) return null;
    if (r === 'slip') return 'open';                             // the lean decides (geometry)
    if (r === 'catch') return 'block';
    return r;
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /**
   * One decision tick.
   * @param {number} dt     seconds since the last call (world time)
   * @param {number} now    world time (ms)
   * @param {import('./boxer.js').Boxer} self
   * @param {Object} foe    the other boxer (a Boxer or match.js's world-time view of one)
   * @param {Object} [matchView]  light match info ({phase, round, ...}); optional
   * @returns {{guard:'none'|'high'|'low', lean:{x:number,y:number,z:number}, punch:null|Object, taunt:boolean, leanFast?:boolean}}
   */
  update(dt, now, self, foe, matchView) {
    const t = now, p = this.p;
    if (this.script) return this._scripted(t, self, foe);
    this._trackPosture(t, foe);
    this._observe(t, self, foe);

    if (!self.canAct(t)) {
      // reeling / down: no plans survive except the guard intent (back the moment the reel ends)
      // (an armed punish keeps waiting: the foe's next punch inside its window is still answered once this reel is over)
      this.string = null;
      this.counterPlan = null;
      this.slip = null;
      this.nextAttackAt = Math.max(this.nextAttackAt, t + p.stunRecoverDelayMs);
      return { guard: self.isCovering(t) ? 'high' : this._idleGuard(t), lean: ZERO, punch: null, taunt: false };
    }

    let guard = this._idleGuard(t);
    if (this.readGuard && t < this.readGuard.until) guard = this.readGuard.guard;
    else this.readGuard = null;
    if (self.isCovering(t)) guard = 'high';
    let lean = this._idleLean(t);
    let leanFast = false;
    if (this.slip && t < this.slip.until) { lean = this.slip.lean; leanFast = true; } else this.slip = null;

    if (self.windup) this._maybeHold(t, self, foe);
    if (this.punishArmed) this._armedPunish(t, self, foe);

    // a cover-up ends when a planned counter is due (the reference punishes straight out of it)
    if (self.isCovering(t) && this.counterPlan && t >= this.counterPlan.impactAt - p.tellMs - 40) self.coverUntil = t;

    let punch = null;
    if (!self.windup && !self.travelling() && !this.slip && !self.isCovering(t)) punch = this._decide(t, self, foe, matchView);
    if (punch) {
      this.lastHand = punch.hand;
      if (punch.answer) this.answerNext = false; // the pulled-back punch has been re-thrown as an answer
      this.log.push({ t, windupMs: punch.windupMs, tellMs: punch.tellMs, kind: punch.kind, target: punch.target, hand: punch.hand, powerPunch: punch.powerPunch, counter: punch.counter, feint: punch.feint, reason: punch.reason, answer: punch.answer, stepIn: punch.stepIn });
      if (this.log.length > 300) this.log.shift();
    }
    return { guard, lean, punch, taunt: false, leanFast };
  }

  /** Called by the Match when one of this AI's punches was thrown (string tracking). */
  onPunchThrown(punch) {
    if (punch && this.string && this.string.pending) {
      this.string.lastId = punch.id;
      this.string.pending = false;
      this.string.lastImpactAt = punch.impactAt;
    }
  }

  // ───────────────────────────── perception ─────────────────────────────

  _observe(t, self, foe) {
    const p = this.p, r = this.rng;
    const fps = (foe && foe.punches) || [];
    for (const fp of fps) {
      if (fp.id > this.lastSeenFoePunchId) {
        this.lastSeenFoePunchId = fp.id;
        this._onFoePunch(t, self, foe, fp);
      }
      if (fp.outcome && !this.seenFoeOutcome.has(fp.id)) {
        this.seenFoeOutcome.add(fp.id);
        this._onFoeOutcome(t, self, foe, fp);
      }
    }
    if (this.seenFoeOutcome.size > 64) this.seenFoeOutcome = new Set([...this.seenFoeOutcome].slice(-32));
    if (this.reads.size > 64) this.reads = new Map([...this.reads].slice(-32));

    // own punches: outcomes steer the attack string
    for (const q of self.punches) {
      if (!q.outcome || this.seenOwnOutcome.has(q.id)) continue;
      this.seenOwnOutcome.add(q.id);
      this._onOwnOutcome(t, self, foe, q);
    }
    if (this.seenOwnOutcome.size > 64) this.seenOwnOutcome = new Set([...this.seenOwnOutcome].slice(-32));

    // two hits within coverWindowMs → maybe cover up (§2.7, §4.1.6)
    const hr = self.hitReact;
    if (hr && !hr.blocked && hr.at !== this.lastHitSeenAt) {
      this.lastHitSeenAt = hr.at;
      this.recentHits.push(hr.at);
      while (this.recentHits.length && this.recentHits[0] < t - p.coverWindowMs) this.recentHits.shift();
      if (this.recentHits.length >= 2 && this.coverRolledAt < this.recentHits[this.recentHits.length - 2] && !self.down) {
        this.coverRolledAt = hr.at;
        if (r.chance(p.coverUpPct)) {
          const ms = this._coverMs(hr);
          self.cover(t, ms);
          this.string = null;
          this.counterPlan = null;
          this.recentHits = [];
          this.nextAttackAt = Math.max(this.nextAttackAt, t + ms);
        }
      }
    }
  }

  /** A foe punch just started: read it (block / open / slip) or punch into it. */
  _onFoePunch(t, self, foe, fp) {
    const p = this.p, r = this.rng;
    const head = fp.target !== 'body';
    if (Number.isFinite(fp.thrownAt)) {
      // mashing: a guard shown since the last punch, and this one within punishMashMs of it — one more in the chain
      const quick = fp.thrownAt - this.foeLastPunchAt <= num(p.punishMashMs, AI_DEFAULTS.punishMashMs);
      this.foeMashChain = quick && this.foeGuardShown ? this.foeMashChain + 1 : 0;
      this.foeGuardShown = false;
      this.foeLastPunchAt = Math.max(this.foeLastPunchAt, fp.thrownAt);
      this.foeBeat.push(fp.thrownAt);
      if (this.foeBeat.length > 4) this.foeBeat.shift();
    }
    const ema = clamp(num(p.bodyReadEma, AI_DEFAULTS.bodyReadEma), 0, 1);
    this.foeBodyShare += ((head ? 0 : 1) - this.foeBodyShare) * ema;
    // flurry: the 3rd+ punch within flurryWindowMs meets a better-set guard (fighters shell up)
    this.foeStarts.push(fp.thrownAt);
    while (this.foeStarts.length && this.foeStarts[0] < fp.thrownAt - p.flurryWindowMs) this.foeStarts.shift();
    const flurry = this.foeStarts.length >= 3 ? p.flurryGuard : 0;
    if (self.down || self.terminal) return;
    if (this._fireArmed(t, self, fp)) return;
    if (self.isCovering(t)) {
      // covered up: the head (§2.7) — or the body, against a foe who goes there (R10), the other zone read as usual
      const covered = head !== this._bodyFoe();
      this.reads.set(fp.id, covered || r.chance(this._readChance(head)) ? 'block' : 'open');
      if (!head && this.reads.get(fp.id) === 'block') this.readGuard = { guard: 'low', until: fp.impactAt + p.readHoldMs };
      return;
    }
    const idle = self.canAct(t) && !(self.punches && self.punches.length);
    if (!idle) return; // reeling or punching: the punch lands (no read)
    if (head && r.chance(p.slipPct)) {
      this.reads.set(fp.id, 'slip');
      this.slip = { lean: dodgeLeanFor(fp, r, 0.95), until: fp.impactAt + 260 };
      this.string = null;
      return;
    }
    if (!self.windup && !this.counterPlan && r.chance(p.punchIntoPct)) {
      this.counterPlan = { impactAt: fp.thrownAt + range(r, p.punchIntoMs), reason: 'punch-into', target: head ? 'head' : (r.chance(0.5) ? 'head' : 'body') };
      this.string = null;
    }
    // gloves already covering this zone after a block (a flurry into a guard keeps hitting the guard)
    const streak = (this.readGuard && t < this.readGuard.until && this.readGuard.guard === guardFor(fp.target))
      // just out of a reel: the gloves are set (§2.7) — over the head, or over the body against a foe who goes there (R10)
      || (head !== this._bodyFoe() && t < self.stunUntil + p.postReelGuardMs);
    const chance = Math.min(0.95, this._readChance(head) + flurry);
    const block = r.chance(streak ? Math.max(chance, p.streakBlock) : chance);
    this.reads.set(fp.id, block ? 'block' : 'open');
    if (block) this.readGuard = { guard: guardFor(fp.target), until: fp.impactAt + p.readHoldMs };
  }

  /**
   * Game ms of a cover-up that starts with the hit `hr`: coverMs is measured in real time (§2.7), and that
   * hit's hit-stop (0.2 s, or 0.5 s when heavy / a counter — render/fx.js tiers, COMBAT.hitStop) runs first.
   */
  _coverMs(hr) {
    const H = this.tuning.hitStop || COMBAT.hitStop;
    const stall = hr && (hr.heavy || hr.counter) ? H.big : H.hit;
    return Math.round(netOfStall(this.p.coverMs, stall, this.tuning));
  }

  /** A foe punch was decided: punish a block (once per blocked exchange), counter a slip. */
  _onFoeOutcome(t, self, foe, fp) {
    const p = this.p, r = this.rng;
    if (self.down || self.terminal) return;
    if (fp.outcome === 'blocked') {
      const blockAt = Number.isFinite(fp.resolvedAt) && fp.resolvedAt > 0 ? fp.resolvedAt : t;
      const prevRing = this.foeRingAt;
      this.foeRingAt = Math.max(this.foeRingAt, blockAt);
      // One punish per blocked exchange (RV-RULES-03): a flurry into the guard is one exchange. Its first block
      // rolls punishPct; the later blocks inside exchangeMs share that roll, and while a punish is planned, waiting
      // for the next punch, cocked or in the air (until its impact + punishedMs) no block rolls again. Against a held
      // posture (E, R10) every blocked punch may roll as soon as no punish is pending: a turtle's punches into the guard
      // are its exposure.
      const turtle = num(p.turtlePunishEach, 0) > 0 && this._postureHeld(t);
      if (turtle) {
        if (this.counterPlan || this.punishArmed || (self.windup && self.windup.counter) || self.punches.some((q) => q.counter && q.stage === 'travel')) return;
      } else if (t < this.punishedUntil || t < this.exchangeUntil) return;
      this.exchangeUntil = t + num(p.exchangeMs, AI_DEFAULTS.exchangeMs);
      // (a counter already planned or waiting answers this exchange)
      if (this.counterPlan || this.punishArmed || !r.chance(p.punishPct)) return;
      // PRO opponents punish nearly every blocked punch (§4.2, §4.4): the punish replaces whatever attack
      // was still pending (the rest of a string waits a full rest after it)
      if (this.string) { this.string = null; this.nextAttackAt = Math.max(this.nextAttackAt, t + this._rest()); }
      const w = self.windup;
      const win = Array.isArray(p.punishWindowMs) ? p.punishWindowMs : AI_DEFAULTS.punishWindowMs;
      const wImpact = w ? w.end + num(w.travelMs, 0) : NaN;
      if (w && !w.feint && !w.powerPunch && !w.counter && wImpact - blockAt >= win[0] && wImpact - blockAt <= win[1]) {
        // already cocked and landing inside the block → counter window: that punch is the punish
        w.counter = true;
        this.punishedUntil = wImpact + num(p.punishedMs, AI_DEFAULTS.punishedMs);
        this.log.push({ t, windupMs: Math.max(0, w.end - t), tellMs: Math.max(0, wImpact - t), kind: w.kind, target: w.target, hand: w.hand, powerPunch: false, counter: true, feint: false, reason: 'punish', converted: true });
        if (this.log.length > 300) this.log.shift();
        return;
      }
      // R10 (§2.4): a foe that keeps punching into the guard — blocked again within punishMashMs of an earlier green ring,
      // or punching on a steady beat — has its guard back up by the time a punish at the measured delay lands. The
      // punish waits, unseen, for its next punch instead and lands while that glove is out (_fireArmed).
      if (num(p.punishIntoGlove, 0) > 0 && (blockAt - prevRing <= num(p.punishMashMs, AI_DEFAULTS.punishMashMs) || this._foeBeatMs() > 0)) {
        this.punishArmed = { blockAt, until: blockAt + this._armMs() };
        this.punishedUntil = Math.max(this.punishedUntil, this.punishArmed.until);
        return;
      }
      this.counterPlan = { impactAt: blockAt + range(r, p.punishDelayMs), reason: 'punish' };
      this.punishedUntil = this.counterPlan.impactAt + num(p.punishedMs, AI_DEFAULTS.punishedMs);
    } else if (this.counterPlan) {
      return;
    } else if (fp.outcome === 'dodged' && this.reads.get(fp.id) === 'slip') {
      this.counterPlan = { impactAt: t + p.slipCounterMs, reason: 'slip' };
      this.slip = null;
    }
  }

  /** One of our punches was decided: a dodge ends the attack; a landed punch keeps it going. */
  _onOwnOutcome(t, self, foe, q) {
    const p = this.p, r = this.rng;
    const s = this.string;
    if (q.outcome === 'dodged' || q.outcome === 'miss') {
      // over-extended: the glove hangs out, the rest of the attack is off (§2.3, §2.5)
      this.string = null;
      this.counterPlan = null;
      if (self.windup && !self.windup.counter) self.cancelWindup();
      this.nextAttackAt = Math.max(this.nextAttackAt, t + this._rest());
      return;
    }
    if (!s || q.id !== s.lastId) return;
    if (q.outcome === 'hit') {
      s.reeling = true;
      if (s.left === 0 && s.total < 4 && r.chance(p.followUpPct)) { s.left = 1; s.total++; }
    }
  }

  // ───────────────────────────── guard & body ─────────────────────────────

  _idleGuard(t) {
    const p = this.p, r = this.rng;
    if (p.guardStyle === 'switch' && t >= this.nextSwitchAt) {
      this.habit = this.habit === 'high' ? 'low' : 'high';
      this.nextSwitchAt = t + p.guardSwitchMs * r.range(0.7, 1.3);
    }
    // against a foe who goes to the body more often than not, the gloves rest low (R10, E: go upstairs to beat it)
    if (this.habit === 'high' && this._bodyFoe()) return 'low';
    return this.habit;
  }

  _idleLean(t) {
    return { x: 0.12 * Math.sin(t / 650 + this.swayPhase), y: 0.04 * Math.sin(t / 410 + this.swayPhase), z: 0 };
  }

  /**
   * Hold a cocked punch while the foe leans (§4.1.7, §4.3: up to holdWhileLeanMs), releasing it when they come back
   * to centre. If the lean is still there when the hold runs out and has become a held posture (postureAnswerMs), the
   * punch it would evade is pulled back and the next one answers the posture (E, see AI_DEFAULTS).
   */
  _maybeHold(t, self, foe) {
    const p = this.p, w = self.windup;
    if (!(p.holdWhileLeanMs > 0) || !w || w.feint || !foe) return;
    const leaning = isLeaning(foe.lean, this.tuning);
    if (!leaning) return; // back to centre: the punch goes now (§2.5)
    if (t - w.start < p.holdWhileLeanMs) {
      if (t >= w.end - 50) self.extendWindup(Math.min(w.start + p.holdWhileLeanMs, t + 60));
      return;
    }
    // pulled back only when the posture can be answered (a punch it doesn't evade, its guard doesn't block, in this
    // opponent's kit); otherwise the held punch goes as before
    if (!w.counter && !w.answer && this._postureHeld(t) && t >= w.end - 20
      && evasionFor({ kind: w.kind, target: w.target, hand: w.hand }, foe.lean, w.stepIn ? 1 : 0, this.tuning)
      && this._answerOptions(t, foe).length > 0) {
      self.cancelWindup();
      self.feintRecoverUntil = Math.max(self.feintRecoverUntil || 0, t + 120);
      this.string = null;
      this.answerNext = true;
      this.nextAttackAt = Math.min(this.nextAttackAt, t + 120 + this.rng.range(80, 220));
    }
  }

  /**
   * An armed punish (R10, see _onFoeOutcome) goes into the foe's next punch — one started after the green ring, inside the
   * window (_armMs), while this opponent is free to throw — and so does every punch of a foe that mashes (foeMashChain ≥
   * punishMashChain; also right after the last counter, the other glove being free). Its gloves are set for it: the punch
   * is caught (streakBlock of the time, or the usual read if that is higher; caught even if the counter is already out)
   * and the counter lands punchIntoMs after that punch started (§4.1.4 punch-into timing, never sooner than the minimum
   * tell), while the glove is out (§2.4). Nothing shows before. Returns true when it fired (the read of `fp` is set).
   */
  _fireArmed(t, self, fp) {
    const a = this.punishArmed, p = this.p, r = this.rng;
    const armed = !!a && fp.thrownAt > a.blockAt + 1 && t <= a.until;
    const mash = !armed && num(p.punishIntoGlove, 0) > 0 && this.foeMashChain >= num(p.punishMashChain, AI_DEFAULTS.punishMashChain);
    if (!armed && !mash) return false;
    // busy (own wind-up or punch out, a counter already planned, reeling): this punch goes by; a later one may still count
    if (this.counterPlan || self.windup || self.travelling() || this.slip || !self.canAct(t)) return false;
    const head = fp.target !== 'body';
    const caught = r.chance(Math.max(this._readChance(head), num(p.streakBlock, AI_DEFAULTS.streakBlock)));
    this.reads.set(fp.id, caught ? 'catch' : 'open');
    if (caught) this.readGuard = { guard: guardFor(fp.target), until: fp.impactAt + p.readHoldMs };
    const minTell = num(this.tuning.minTellMs, COMBAT.minTellMs);
    const impactAt = Math.max(t + minTell, fp.thrownAt + range(r, p.punchIntoMs));
    this.counterPlan = { impactAt, reason: 'punish', target: 'head', into: true };
    this.string = null;
    this.punishArmed = null;
    this.punishedUntil = impactAt + num(p.punishedMs, AI_DEFAULTS.punishedMs);
    return true;
  }

  /** An armed punish whose window (_armMs) passed without a punch to go into is dropped: none is thrown. */
  _armedPunish(t, self, foe) {
    const a = this.punishArmed;
    if (!foe || foe.down || foe.terminal || t > a.until) { this.punishArmed = null; this.punishedUntil = Math.min(this.punishedUntil, t); }
  }

  /**
   * The foe's steady punching beat: the median of its last three gaps when all three are within ±punishBeatTol of it and
   * it is at most punishBeatMaxMs (a key tapped on a metronome); 0 when there is none.
   */
  _foeBeatMs() {
    const p = this.p, b = this.foeBeat, max = num(p.punishBeatMaxMs, 0);
    if (b.length < 4 || !(max > 0)) return 0;
    const gaps = [b[1] - b[0], b[2] - b[1], b[3] - b[2]];
    const med = gaps.slice().sort((x, y) => x - y)[1];
    const tol = num(p.punishBeatTol, AI_DEFAULTS.punishBeatTol);
    if (!(med > 0) || med > max || gaps.some((g) => Math.abs(g - med) > tol * med)) return 0;
    return med;
  }

  /** How long after a green ring an armed punish waits for the foe's next punch: punishArmMs, or 1.2 × a steady beat. */
  _armMs() {
    const base = num(this.p.punishArmMs, AI_DEFAULTS.punishArmMs);
    return Math.max(base, 1.2 * this._foeBeatMs());
  }

  /**
   * Follow how long the foe's dodge posture has been held (world time). Any change between postures is one, and so is
   * a posture taken again after less than COMBAT.freshDodgeResetMs back in the stance (bobbing on a key).
   */
  _trackPosture(t, foe) {
    const resetMs = num(this.tuning.freshDodgeResetMs, COMBAT.freshDodgeResetMs);
    // the guard the foe keeps: throwing a punch drops it for a moment (keyboard and camera alike), so a turtle that
    // keeps throwing still "has" its guard — only a guard shown, or none for guardDropMs, changes it
    const g = this._foeGuardNow(t, foe);
    if (g !== 'none') { this.foeGuardKept = g; this.foeGuardOffSince = null; this.foeGuardShown = true; }
    else {
      if (this.foeGuardOffSince == null) this.foeGuardOffSince = t;
      if (this.foeGuardKept == null || t - this.foeGuardOffSince >= GUARD_DROP_MS) this.foeGuardKept = 'none';
    }
    const leaning = !!(foe && !foe.down && isLeaning(foe.lean, this.tuning));
    const tau = num(this.p.postureDutyMs, AI_DEFAULTS.postureDutyMs);
    // (at most 100 ms per look: across a stoppage the AI did not watch, the share stays what it was)
    if (this.foeDutyT != null && t > this.foeDutyT && tau > 0) this.foeDuty += ((leaning ? 1 : 0) - this.foeDuty) * (1 - Math.exp(-Math.min(100, t - this.foeDutyT) / tau));
    this.foeDutyT = t;
    if (leaning) this.foePostureLean = { x: foe.lean.x || 0, y: foe.lean.y || 0, z: foe.lean.z || 0 };
    if (leaning) {
      if (this.foePostureSince == null || (this.foePostureOffAt != null && t - this.foePostureOffAt >= resetMs)) this.foePostureSince = t;
      this.foePostureOffAt = null;
    } else if (this.foePostureSince != null) {
      if (this.foePostureOffAt == null) this.foePostureOffAt = t;
      if (t - this.foePostureOffAt >= resetMs || (foe && foe.down)) { this.foePostureSince = null; this.foePostureOffAt = null; this.answerNext = false; }
    }
  }

  /** The foe's guard right now ('high' | 'low' | 'none'; a guard below guardMinAmount is none). */
  _foeGuardNow(t, foe) {
    if (!foe) return 'none';
    const C = this.tuning;
    const g = typeof foe.effectiveGuard === 'function' ? foe.effectiveGuard(t) : foe.guard;
    const amount = Number.isFinite(foe.guardAmount) ? foe.guardAmount : 1;
    return (g === 'high' || g === 'low') && amount >= (C.guardMinAmount ?? COMBAT.guardMinAmount) ? g : 'none';
  }

  /** The foe is in a dodge posture held for postureAnswerMs or longer. */
  _postureHeld(t) {
    if (this.foePostureSince != null && this.foePostureOffAt == null && t - this.foePostureSince >= num(this.p.postureAnswerMs, AI_DEFAULTS.postureAnswerMs)) return true;
    const duty = num(this.p.postureDutyPct, AI_DEFAULTS.postureDutyPct);
    return duty > 0 && this.foeDuty >= duty;
  }

  /**
   * The punches the foe's held posture does not evade and its guard does not block (E), as weighted options
   * [[{kind, target, hand, stepIn}, weight], …] — only kinds in this opponent's own kit (punchMix > 0: the first
   * opponent never throws an uppercut), weighted by its mix and body share. A zone counts as guarded when the guard
   * covers it now or is kept there between the foe's punches (foeGuardKept: a turtle's own punches drop its guard
   * only for a moment). Step-in head shots (D4: a real lean-in eats into a back lean) only when nothing else
   * reaches. Empty: the posture can't be answered. Uses no randomness.
   */
  _answerOptions(t, foe) {
    const p = this.p, C = this.tuning;
    let lean = (foe && foe.lean) || ZERO;
    // a foe bobbing in and out of a posture (in one most of the time) is answered as in it, also between two dips
    if (!isLeaning(lean, C) && this.foePostureLean && num(p.postureDutyPct, 0) > 0 && this.foeDuty >= p.postureDutyPct) lean = this.foePostureLean;
    const now = this._foeGuardNow(t, foe), kept = this.foeGuardKept;
    const covered = (target) => now === guardFor(target) || kept === guardFor(target);
    for (const stepIn of [false, true]) {
      const opts = [];
      for (const kind of ['straight', 'hook', 'uppercut']) {
        const mix = num(p.punchMix && p.punchMix[kind], 0);
        if (!(mix > 0)) continue;
        for (const target of ['head', 'body']) {
          if (covered(target) || (stepIn && target === 'body')) continue;
          for (const hand of ['left', 'right']) {
            if (evasionFor({ kind, target, hand }, lean, stepIn ? 1 : 0, C)) continue;
            opts.push([{ kind, target, hand, stepIn }, mix * (target === 'body' ? Math.max(0.15, p.bodyPct) : Math.max(0.15, 1 - p.bodyPct))]);
          }
        }
      }
      if (opts.length) return opts;
    }
    return [];
  }

  /** One answer to the foe's held posture (see _answerOptions), or null when there is none. */
  _answerFor(t, foe) {
    const opts = this._answerOptions(t, foe);
    return opts.length ? this.rng.weighted(opts) : null;
  }

  // ───────────────────────────── offence ─────────────────────────────

  _gap() {
    const p = this.p;
    const byRound = Array.isArray(p.attackGapByRound) ? p.attackGapByRound[Math.min(this.round, p.attackGapByRound.length) - 1] : null;
    return (Number.isFinite(byRound) ? byRound : p.attackGapMs) * this.mood;
  }

  _rest() {
    const p = this.p;
    return this._gap() * this.rng.range(1 - p.attackGapJitter, 1 + p.attackGapJitter);
  }

  _decide(t, self, foe, mv) {
    const p = this.p, r = this.rng;
    if (!foe || foe.down || foe.terminal || (typeof foe.isGettingUp === 'function' && foe.isGettingUp(t))) return null;
    if (mv && mv.phase && mv.phase !== 'fighting') return null;

    // 1) a planned counter (punish after a block, after a slip, or into the foe's punch)
    if (this.counterPlan) {
      const plan = this.counterPlan;
      // a punish that can only start late (the AI was busy) keeps this opponent's normal tell instead of
      // collapsing to COMBAT.minTellMs (RV-RULES-03): it lands at t + tellMs — except one punched into the foe's punch
      // (an armed punish, R10), which keeps the punch-into timing
      const impactAt = plan.reason === 'punish' && !plan.into ? Math.max(plan.impactAt, t + p.tellMs) : plan.impactAt;
      const req = this._makePunch(t, self, foe, { counter: true, impactAt, target: plan.target, reason: plan.reason, noPower: true });
      if (req) {
        const startAt = impactAt - req.tellMs;
        if (t + 1 < startAt) return null;
        this.counterPlan = null;
        if (plan.reason === 'punish') this.punishedUntil = Math.max(this.punishedUntil, t + req.tellMs + num(p.punishedMs, AI_DEFAULTS.punishedMs));
        return req;
      }
      if (t > plan.impactAt + 400) this.counterPlan = null;
      return null;
    }

    // 2) the next punch of the current attack
    const s = this.string;
    if (s && s.pending && !self.windup && !self.travelling() && t - s.pendingAt > 1200) {
      // the requested punch never left (wind-up refused or cut short): close the attack
      this.string = null;
      this.nextAttackAt = Math.max(this.nextAttackAt, t + this._rest());
      return null;
    }
    if (s) {
      if (s.left <= 0) {
        if (!self.isBusy(t)) { this.string = null; this.nextAttackAt = Math.max(this.nextAttackAt, t + this._rest()); }
        return null;
      }
      if (s.pending || !Number.isFinite(s.lastImpactAt)) return null;
      const gap = this._stringGap(s, s.nextTarget);
      const impactAt = s.lastImpactAt + gap;
      const req = this._makePunch(t, self, foe, { impactAt, target: s.nextTarget, avoidHand: s.lastHand, reason: 'string', noPower: s.hadPower });
      if (!req) return null;
      if (t + 1 < impactAt - req.tellMs) return null;
      s.left--;
      s.pending = true;
      s.pendingAt = t;
      s.lastHand = req.hand;
      s.lastTarget = req.target;
      s.reeling = false;
      if (req.powerPunch) { s.hadPower = true; s.left = 0; }
      s.nextTarget = this._chooseTarget(t, foe, {});
      return req;
    }

    // an opponent standing there with no guard invites a punch (brings the next attack forward)
    const fg = typeof foe.effectiveGuard === 'function' ? foe.effectiveGuard(t) : foe.guard;
    if (fg === 'none' || !fg) {
      if (this.foeOpenSince == null) this.foeOpenSince = t;
      else if (t - this.foeOpenSince >= p.openFoeMs && !this.openRolled) {
        this.openRolled = true;
        if (r.chance(p.openFoePressure)) this.nextAttackAt = Math.min(this.nextAttackAt, t + r.range(60, 220));
      }
    } else { this.foeOpenSince = null; this.openRolled = false; }

    if (self.isBusy(t) || t < this.nextAttackAt) return null;

    // 3) a new attack
    if (!this.lastWasFeint && r.chance(p.feintChance)) {
      const req = this._makePunch(t, self, foe, { feint: true, reason: 'feint', noPower: true });
      if (req) {
        this.lastWasFeint = true;
        this.nextAttackAt = t + req.windupMs + r.range(250, 450);
        return req;
      }
    }
    this.lastWasFeint = false;
    const total = this._stringLength();
    const req = this._makePunch(t, self, foe, { first: true, reason: 'attack' });
    if (!req) return null;
    this.string = {
      total, left: total - 1, pending: true, pendingAt: t, lastHand: req.hand, lastTarget: req.target, lastId: 0,
      lastImpactAt: NaN, reeling: false, hadPower: req.powerPunch, nextTarget: this._chooseTarget(t, foe, {}),
    };
    if (req.powerPunch) this.string.left = 0;
    return req;
  }

  _stringLength() {
    const w = this.p.stringWeights || [1];
    const pick = this.rng.weighted(w.map((x, i) => [i + 1, x]));
    return Math.max(1, Math.min(4, pick || 1));
  }

  _stringGap(s, nextTarget) {
    const p = this.p, r = this.rng;
    if (s.reeling && Number.isFinite(p.stringGapReelMs)) return p.stringGapReelMs * r.range(0.9, 1.15);
    if (Number.isFinite(p.stringGapHeadBodyMs) && s.lastTarget === 'head' && nextTarget === 'body') return p.stringGapHeadBodyMs;
    const g = range(r, p.stringGapMs);
    return Number.isFinite(g) ? g : 500;
  }

  /**
   * Head or body: bodyPct of ordinary punches go to the body (§4.5a). Counters go upstairs where the
   * player's glove is still out (§2.4), or — smartTargeting of the time — at the zone the guard leaves
   * open. Power punches use powerBodyPct (most are raised-glove head hooks, §4.3).
   */
  _chooseTarget(t, foe, opts) {
    const p = this.p, r = this.rng;
    if (opts.target) return opts.target;
    if (opts.counter) {
      const g = foe && typeof foe.effectiveGuard === 'function' ? foe.effectiveGuard(t) : foe && foe.guard;
      const open = openTarget(g);
      if (open && r.chance(p.smartTargeting)) return open;
      return 'head';
    }
    if (opts.power) return r.chance(p.powerBodyPct) ? 'body' : 'head';
    return r.chance(p.bodyPct) ? 'body' : 'head';
  }

  /**
   * Build a wind-up request (null if no hand can throw).
   * opts: {target, counter, impactAt, avoidHand, first, feint, noPower, reason}
   */
  _makePunch(t, self, foe, opts) {
    const p = this.p, r = this.rng, C = this.tuning;
    // a held posture is answered (E): a punch it does not evade, whatever the plan wanted — always for a planned
    // counter (punish, slip, punch-into: what a turtle's own punches feed) and for the punch re-thrown after a
    // pull-back (answerNext), postureAnswerPct of the time otherwise
    let answer = null;
    if (!opts.feint && foe && this._postureHeld(t) && (opts.counter || this.answerNext || r.chance(num(p.postureAnswerPct, 0)))) {
      answer = this._answerFor(t, foe);
      if (!answer) this.answerNext = false; // nothing answers this posture: no pending answer either
    }
    const powerPunch = !answer && !opts.counter && !opts.feint && !opts.noPower && r.chance(p.powerPct);
    const target = answer ? answer.target : this._chooseTarget(t, foe, { ...opts, power: powerPunch });
    let kind = answer ? answer.kind : powerPunch ? (C.punch[p.powerKind] ? p.powerKind : 'hook') : (r.weighted(p.punchMix) || 'straight');
    let hand = null;
    if (answer && kind === 'hook') hand = answer.hand;
    else if (kind === 'straight') hand = !opts.avoidHand && r.chance(p.leadHandBias) ? self.leadHand() : self.rearHand();
    else if (kind === 'uppercut') hand = r.chance(0.65) ? self.rearHand() : self.leadHand();
    else hand = r.chance(0.5) ? 'left' : 'right';
    if (opts.avoidHand && hand === opts.avoidHand && !(answer && kind === 'hook')) hand = other(hand);
    if (!self.canStartWindup(t, hand)) {
      // (an answering hook keeps its side: the other hook is the one the lean evades — wait for the glove instead)
      if (answer && kind === 'hook') return null;
      hand = other(hand);
      if (!self.canStartWindup(t, hand)) return null;
    }
    const travel = travelMs(kind, false, self.speed, C, powerPunch);
    const minTell = powerPunch ? C.minPowerTellMs + this.latencyMs : C.minTellMs;
    let tell;
    if (powerPunch) tell = Math.max(minTell, p.powerTellMs + r.normal(0, p.tellJitterMs));
    else tell = (target === 'body' && Number.isFinite(p.bodyTellMs) ? p.bodyTellMs : p.tellMs) + r.normal(0, p.tellJitterMs);
    if (Number.isFinite(opts.impactAt)) tell = Math.max(tell, opts.impactAt - t);
    if (opts.counter && Number.isFinite(opts.impactAt)) tell = Math.max(minTell, opts.impactAt - t);
    tell = Math.max(minTell, tell);
    const windupMs = Math.max(C.minWindupMs, tell - travel);
    const damage = powerPunch ? p.powerDamage : opts.first && Number.isFinite(p.firstPunchDamage) ? p.firstPunchDamage : p.ordinaryDamage;
    const jab = kind === 'straight' && hand === self.leadHand();
    const power = powerPunch ? 0.95 : jab ? r.range(0.45, 0.6) : r.range(0.6, 0.85);
    // (answerNext is spent in update(), once an answering punch is actually returned: a request built here is not
    // always thrown)
    return {
      hand, kind, target, windupMs, tellMs: windupMs + travel, power, powerPunch, damage,
      feint: !!opts.feint, counter: !!opts.counter, minTellMs: minTell, reason: opts.reason || 'attack',
      answer: !!answer, stepIn: !!(answer && answer.stepIn),
    };
  }

  // ───────────────────────────── tutorial ─────────────────────────────

  _scripted(t, self, foe) {
    const sc = SCRIPT[this.script];
    let punch = null;
    if (sc.attack && self.canAct(t) && !self.isBusy(t) && t >= this.scriptNextAt && foe && !foe.down) {
      const a = sc.attack;
      const hand = a.power ? self.rearHand() : self.leadHand();
      if (self.canStartWindup(t, hand)) {
        const travel = travelMs(a.kind, false, self.speed, this.tuning, !!a.power);
        const tell = Math.max(a.tellMs, a.power ? this.tuning.minPowerTellMs + this.latencyMs : this.tuning.minTellMs);
        punch = {
          hand, kind: a.kind, target: a.target, windupMs: Math.max(this.tuning.minWindupMs, tell - travel), tellMs: tell,
          power: a.power ? 0.95 : 0.5, powerPunch: !!a.power, damage: a.power ? 2 : 1, feint: false, counter: false,
          minTellMs: tell, reason: 'tutorial',
        };
        this.scriptNextAt = t + tell + range(this.rng, a.every);
        this.log.push({ t, windupMs: punch.windupMs, tellMs: tell, kind: a.kind, target: a.target, hand, powerPunch: punch.powerPunch, counter: false, feint: false, reason: 'tutorial' });
        if (this.log.length > 300) this.log.shift();
      }
    }
    return { guard: sc.guard, lean: this._idleLean(t), punch, taunt: false };
  }
}
