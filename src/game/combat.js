// Punch resolution — pure, deterministic given an rng, runs in Node.
//
// Implements COM05 (attack resolution against the defender's current position and defence:
// a swing connects, is guarded, or misses) and COM06 (counter-attacks), with the numbers measured
// in research/mechanics.md (sections cited as §n). The same rules apply to the human and the AI,
// in both directions.
//
// HEALTH is counted in WEDGES: every fighter has a 10-wedge pie (COMBAT.maxHp), partial wedges
// allowed (§2.6, §2.9). There is no chip damage, no regeneration, no stamina and no daze (§2.4,
// §4.1.8): a block costs nothing, and nobody ever gets groggy.
//
// Defence rules (see COMBAT for every number):
//   * Guards: a HIGH guard blocks head shots (straights, hooks, uppercuts); a LOW guard blocks
//     body shots. A high guard leaves the body open and vice versa (§2.4). A human guard only
//     counts when ControlState.guardAmount ≥ guardMinAmount.
//   * Evasion (head shots only — body shots are never dodged by leaning, only blocked low):
//       straight → any clear sideways lean (|lean.x| ≥ dodgeLeanThreshold), a duck or a forward tilt
//       hook     → leaning AWAY from the side the hook arrives on, a duck or a forward tilt. An
//                  attacker's left hook arrives on the defender's right side, so lean.x·handSign(hand) ≥ thr.
//       uppercut → leaning sideways (either way); ducking or tilting forward does NOT work — not even
//                  together with a sideways lean: a head that is down or forward stays in the uppercut's
//                  path (so every dodge posture leaves some punch open, decision R2 / RV-RULES-01). During a
//                  sideways lean only a real duck counts (lean.y ≤ −(duckThreshold + duckSlipK·|x|), isDuck):
//                  a webcam slip's natural head dip is no duck, for any kind of punch.
//       any head shot → leaning far back (lean.z ≤ −backLeanThreshold) takes you out of reach. Only a
//                  real lean-in by the attacker (lean.z ≥ leanInMin) cancels part of it; the AI's own
//                  punch animation (z +0.28 in travel) never does (ARCHITECTURE decision D4).
//     The forward tilt (lean.z ≥ forwardLeanThreshold) is research/mechanics.md §2.1's "tilt the body
//     forward" dodge: it evades what a duck evades (decision D3), so every pose the tutorial's dodge
//     card accepts (input/tutorial-detect.js) is a dodge in the bout too.
//   * Damage (§2.6, §2.10): the player's ordinary clean hit is humanBaseDamage + humanSpeedDamage ×
//     punch.power² (1.2 + 0..0.5 wedges, the bonus going to fast punches); an AI punch carries its own `damage` (roster ordinary
//     1.0–1.2, power 2–4). A COUNTER (the target was mid-punch / pulling back / recovering from a
//     miss, or the punch came in the post-dodge window — the caller decides and sets punch.counter)
//     does ×counterDamageMul, capped at counterDamageCap. Every clean hit varies ±damageVariance.
//   * Knockdown (§2.9): a clean hit whose damage is ≥ the health left floors the defender
//     (`knockdown`). Warning beat: an ORDINARY hit (no counter, no power punch) never floors a
//     fighter who has more than warningBeatHp wedges left — it leaves warningBeatLeave instead, so
//     an "empty-looking" pie always comes before the knockdown blow.
//   * Stun: an AI hit cleanly reels for its reelMs (guard open, can't punch; §2.7), shorter for
//     every further hit of a flurry (stunDecay); a counter reels at least counterStunMs. A human hit
//     cleanly only flinches (humanHitLockMs, visual) — guard and punches keep counting (§2.10).
//
// LATENCY FAIRNESS (§4.6): a human's defence comes from webcam ControlState, which shows their body
// `latencyMs` late. The caller keeps `defender.samples` (a short history of {t, guard, guardAmount,
// lean}) and resolves an incoming punch only after impactAt + latencyMs + defenseGraceMs; this
// module then judges the BEST defence the camera saw in
//   [impactAt + latencyMs − defenseEarlyMs, impactAt + latencyMs + defenseGraceMs],
// i.e. the player's real pose at the moment of impact (± a small grace).

import { handSign } from '../core/types.js';

/** All combat tunables. Every number used by resolvePunch/Boxer lives here. */
export const COMBAT = {
  /** Wedges in a health pie (§2.6, V). Boxer.maxHp defaults to this. */
  maxHp: 10,

  // ── telegraphs (AI) — total tell = wind-up + travel = first visible movement → impact (§4.3) ──
  /** Floor for the wind-up part alone. */
  minWindupMs: 60,
  /** Floor for the whole tell of an ORDINARY AI punch (measured 0.17–0.45 s; §4.6: keep as measured). */
  minTellMs: 170,
  /** Floor for the whole tell of a POWER punch, before the input latency is added (§4.6: ≥ 0.55 s + latency). */
  minPowerTellMs: 550,
  /** Travel of an AI power punch (the swing after the raised/cocked glove; §4.3 "0.23 s swing"). */
  powerTravelMs: 230,

  // ── per-kind punch data ──────────────────────────────────────────────────────────────
  // humanTravelMs  recognition → contact for the player's punches recognised when they START (keyboard:
  //                the key goes down as the punch begins; §2.2: full extension in 0.07–0.13 s)
  // aiTravelMs     end of wind-up → contact for ordinary AI punches at stats.speed 1 (§4.3: 0.07–0.13 s)
  // humanRecoverMs contact → the glove is back (animation; the rate limit is perHandMs)
  // aiRecoverMs    contact → AI back in stance after a punch that hit or was blocked (× ai.recoverMul)
  // damageMul      × damage by kind (the footage cannot separate kinds, §9.6 → all 1)
  punch: {
    straight: { humanTravelMs: 100, aiTravelMs: 100, humanRecoverMs: 150, aiRecoverMs: 260, damageMul: 1 },
    hook:     { humanTravelMs: 120, aiTravelMs: 120, humanRecoverMs: 170, aiRecoverMs: 300, damageMul: 1 },
    uppercut: { humanTravelMs: 130, aiTravelMs: 120, humanRecoverMs: 180, aiRecoverMs: 300, damageMul: 1 },
  },
  /** Recognition → contact for a punch the camera recognised AT FULL EXTENSION (PunchInput.atExtension,
   *  decision D5): the arm is already out, so contact follows at once. 30 ms (two 60 fps steps) keeps one
   *  frame of visible punch and leaves an AI slip (slipLeanSpeed 16/s) time to clear the 0.42 lean. */
  atExtensionTravelMs: 30,

  // ── damage (wedges; §2.6, §2.10) ─────────────────────────────────────────────────────
  humanBaseDamage: 1.2,       // the player's ordinary clean hit …
  humanSpeedDamage: 0.5,      // … + this × punch.power² (0..1, speed of the motion: fast punches earn it)
  defaultPower: 0.6,          // punch.power when the recognizer gave none
  aiBaseDamage: 1.1,          // an AI punch without its own `damage` (roster ordinary 1.0–1.2)
  counterDamageMul: 2.5,      // counters: × this …
  counterDamageCap: 4,        // … capped here (and no hit ever does more)
  damageVariance: 0.3,        // ± fraction per clean hit (only when an rng is supplied; §2.9)
  heavyDamage: 2.0,           // a hit of at least this many wedges counts as `heavy`
  warningBeatHp: 1.5,         // an ordinary hit never floors a fighter with more than this left …
  warningBeatLeave: 0.1,      // … it leaves this sliver instead (§2.9 optional rule)
  comboWindowMs: 800,         // a clean hit within this of the attacker's previous one is a combo hit (heavy, §2.8)

  // ── stun / reel (§2.7) ──────────────────────────────────────────────────────────────
  aiReelMs: 600,              // AI reel after a clean hit (guard open, can't punch); roster reelMs overrides
  counterStunMs: 470,         // a counter reels the AI at least this long
  stunDecay: 0.72,            // reel × stunDecay^(hits already taken in this flurry)
  minStunMs: 150,
  maxReelChainMs: 900,        // a flurry can keep an AI reeling at most this long (REAL ms: each hit's hit-stop is
                              // counted, Boxer.receive) from its first hit (§2.7: the guard is back ~0.7 s after a
                              // clean hit; a second punch usually lands) — no stun-lock; hits still do damage
  humanHitLockMs: 220,        // a human hit cleanly flinches (HITSTUN phase) this long — visual only: guard and
  humanHeavyLockMs: 420,      // punches keep counting through the hit cut (§2.10); … after a heavy hit

  // ── defence thresholds (ControlState / BoxerView lean units, −1..1) ─────────────────
  dodgeLeanThreshold: 0.42,   // |lean.x| ≥ → clear sideways lean
  duckThreshold: 0.42,        // lean.y ≤ −this → duck …
  duckSlipK: 0.25,            // … but during a clear sideways lean only at lean.y ≤ −(duckThreshold + this × |lean.x|): a
                              // webcam slip dips the head a little (real clip: y −0.46 at |x| 1), and that slip is no duck
                              // (it still slips the uppercut); a keyboard A/D + S (y −1) stays a duck (polish round, item 3)
  backLeanThreshold: 0.62,    // −lean.z ≥ this (after the attacker's forward-lean reach) → out of reach
  forwardLeanThreshold: 0.62, // lean.z ≥ this → the forward tilt: evades what a duck evades (D3, §2.1)
  forwardLeanReach: 0.5,      // attacker lean.z = +1 cancels this much of the defender's back lean …
  leanInMin: 0.42,            // … but only a real lean-in counts (attacker lean.z ≥ this; the AI's travel
                              // animation leans z +0.28 and must not raise the back-lean threshold, D4)
  guardMinAmount: 0.35,       // human guardAmount below this does not block

  // ── latency fairness (human defenders only; see header) ─────────────────────────────
  latencyMs: 100,             // default camera → game latency (Match/Boxer option; calibration overrides)
  defenseEarlyMs: 60,
  defenseGraceMs: 60,

  // ── counters & dodge slow motion (§2.5, §2.10) ──────────────────────────────────────
  counterWindowMs: 750,       // after a successful dodge the next punch(es) are counters …
  counterMaxPunches: 1,       // … this many of them (the window is the slow-motion window)
  slowmoScale: 0.25,          // world time × this while a human's dodge window is open
  slowmoMs: 750,
  freshDodgeMs: 700,          // only a FRESH dodge earns the slow motion and the counter window (decision R2): the
                              // dodging posture was entered at most this long before the defence sample that decided
                              // the dodge, or after the punch's wind-up (its tell) began. A posture held longer still
                              // evades (the D3 geometry is unchanged) but earns neither (no turtling, RV-RULES-01).
  freshDodgeResetMs: 400,     // a posture only ends after this long back in the stance: a release shorter than this
                              // and a lean again (bobbing on a key) is still the old, held posture
  freshDodgeBobMs: 6000,      // bobbing (Match._bobbing): no dodge is fresh when, in the last this-many ms of live fight time
  freshDodgeBobOnsets: 2,     // up to its posture's start, the player went into a posture this many times (or more) with no
  freshDodgeProvokeMs: 900,   // attack coming — no wind-up or punch of the opponent's out, none begun this long before (0 = off)

  // ── human input handling (Boxer; §2.10 rate limit) ──────────────────────────────────
  perHandMs: 200,             // the same glove never starts two punches closer than this …
  betweenHandsMs: 100,        // … and no two punches (either hand) start closer than this
  inputBufferMs: 140,         // a punch arriving this close to its glove being allowed is queued (during a
                              // hit-stop every recognised punch is queued, one per hand: decision D6)

  // ── the renderer's hit-stop (ARCHITECTURE §6.2, research §2.8) ─────────────────────
  // Mirrors render/fx.js FX_TUNING.hitStop (view3d owns the look; tests keep the two equal). During a
  // stall the session runs game time at ×scale, so a game timer that the reference measured in REAL
  // time (cover-up, guard back after a hit, the "Down" call) must be set net of the stall: netOfStall().
  hitStop: Object.freeze({ scale: 0.02, hit: 200, big: 500, knockdown: 700, onHuman: 0, onHumanHeavy: 450 }),

  // ── legacy keys (kept so older readers keep working; all neutral now) ───────────────
  minPunchGapMs: 100,         // = betweenHandsMs
  humanBlockedExtraMs: 0,
  humanWhiffExtraMs: 0,
  regenPerSec01: 0,           // no regeneration (§2.9, V)
  chipCannotKnockDown: true,  // there is no chip at all
  lowStaminaTravelMul: 1,     // no stamina (§2.4)
};

/** Outcome ranking from the defender's point of view (higher = better for the defender). */
const RANK = { hit: 1, blocked: 2, dodged: 3, miss: 4 };

const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
const UNHITTABLE = new Set(['down', 'getup', 'ko']);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const round2 = (v) => Math.round(v * 100) / 100;

/** Per-kind data (falls back to straight for unknown kinds). */
export function punchSpec(kind, tuning = COMBAT) {
  return tuning.punch[kind] || tuning.punch.straight;
}

/**
 * Travel time (wind-up end / recognition → contact) for a punch.
 * @param {string} kind
 * @param {boolean} isHuman
 * @param {number} [speed]  stats.speed (AI)
 * @param {Object} [tuning]
 * @param {boolean} [powerPunch]  AI power punch (longer swing)
 * @param {boolean} [atExtension] human punch recognised at full extension (camera, PunchInput.atExtension):
 *        contact follows within atExtensionTravelMs instead of the whole humanTravelMs out-stroke (D5)
 */
export function travelMs(kind, isHuman, speed = 1, tuning = COMBAT, powerPunch = false, atExtension = false) {
  const s = punchSpec(kind, tuning);
  let base;
  if (isHuman) base = atExtension ? Math.min(s.humanTravelMs, tuning.atExtensionTravelMs ?? COMBAT.atExtensionTravelMs) : s.humanTravelMs;
  else base = powerPunch ? (tuning.powerTravelMs ?? COMBAT.powerTravelMs) : s.aiTravelMs;
  return base / clamp(speed || 1, 0.5, 2);
}

/**
 * The renderer's hit-stop for a MATCH_HIT-shaped event, in real ms — the same tiers as render/fx.js
 * hitStopMsFor (knockdown blow 700; a hit by a human 200, or 500 when heavy / a counter; a hit ON a
 * human 0, or 450 when heavy; AI on AI like a human attacker).
 * @param {{attacker?:string, defender?:string, heavy?:boolean, counter?:boolean, knockdown?:boolean}} e
 * @param {(id:string) => boolean} isHuman
 */
export function stallMsFor(e, isHuman, tuning = COMBAT) {
  const H = tuning.hitStop || COMBAT.hitStop;
  if (!e) return 0;
  if (e.knockdown) return H.knockdown;
  const att = e.attacker === 'p2' ? 'p2' : 'p1';
  const def = e.defender === 'p1' || e.defender === 'p2' ? e.defender : (att === 'p1' ? 'p2' : 'p1');
  const big = !!e.heavy || !!e.counter;
  const human = typeof isHuman === 'function' ? isHuman : () => false;
  if (human(att)) return big ? H.big : H.hit;
  if (human(def)) return big ? H.onHumanHeavy : H.onHuman;
  return big ? H.big : H.hit;
}

/**
 * Game ms that last `realMs` of REAL time when a hit-stop of `stallMs` starts at the same moment
 * (game time runs at hitStop.scale during the stall): realMs − stallMs × (1 − scale), never negative.
 * Used for timers the reference measured in real time but the game runs on its (stallable) clock.
 */
export function netOfStall(realMs, stallMs, tuning = COMBAT) {
  const H = tuning.hitStop || COMBAT.hitStop;
  const stall = Math.max(0, Math.min(Number(stallMs) || 0, Number(realMs) || 0));
  return Math.max(0, (Number(realMs) || 0) - stall * (1 - clamp01(H.scale ?? 0.02)));
}

/** The guard that stops a punch aimed at `target`. */
export function guardFor(target) { return target === 'body' ? 'low' : 'high'; }

/** The target a guard leaves open ('none' → both open → null). */
export function openTarget(guard) {
  if (guard === 'high') return 'body';
  if (guard === 'low') return 'head';
  return null;
}

/**
 * The player's ordinary clean-hit damage for a punch power (0..1), before variance/counters.
 * @param {number} [power]
 */
export function humanDamage(power, tuning = COMBAT) {
  const p = Number.isFinite(power) ? clamp01(power) : tuning.defaultPower;
  // the bonus goes to the genuinely fast punches (the reference's blue-trail punches, §2.2)
  return tuning.humanBaseDamage + tuning.humanSpeedDamage * p * p;
}

/** The attacker's lean-in that eats into a defender's back lean (0 unless it is a real lean-in, D4). */
function leanInReach(attackerLeanZ, C) {
  const z = Number(attackerLeanZ) || 0;
  const min = C.leanInMin ?? COMBAT.leanInMin;
  return z >= min ? z * (C.forwardLeanReach ?? COMBAT.forwardLeanReach) : 0;
}

/** Forward-tilt threshold (falls back to the back-lean one for older tunings). */
const forwardThr = (C) => C.forwardLeanThreshold ?? C.backLeanThreshold ?? COMBAT.forwardLeanThreshold;

/**
 * Is this lean a duck? lean.y ≤ −duckThreshold, or — during a clear sideways lean (|x| ≥ dodgeLeanThreshold) —
 * lean.y ≤ −(duckThreshold + duckSlipK·|x|): the head's natural dip in a webcam slip is not a duck.
 * @param {{x?:number,y?:number}} lean
 */
export function isDuck(lean, tuning = COMBAT) {
  const C = tuning;
  const l = lean || ZERO;
  const ax = Math.abs(l.x || 0);
  const k = ax >= C.dodgeLeanThreshold ? (C.duckSlipK ?? COMBAT.duckSlipK) * ax : 0;
  return (l.y || 0) <= -(C.duckThreshold + k);
}

/**
 * Would this lean evade this punch? (Pure geometry; ignores guards.)
 * @param {{kind:string,target:string,hand:string}} punch
 * @param {{x:number,y:number,z?:number}} lean defender lean (defender perspective)
 * @param {number} [attackerLeanZ]  the attacker's lean.z (only a real lean-in, ≥ leanInMin, has reach)
 * @returns {null|'lean'|'duck'|'forward'|'back'}
 */
export function evasionFor(punch, lean, attackerLeanZ = 0, tuning = COMBAT) {
  const C = tuning;
  if (punch.target === 'body') return null; // body shots are never evaded by leaning
  const l = lean || ZERO;
  const lz = l.z || 0;
  const back = -lz - leanInReach(attackerLeanZ, C);
  const lx = l.x || 0;
  const duck = isDuck(l, C);
  const forward = lz >= forwardThr(C);
  if (punch.kind === 'hook') {
    if (lx * handSign(punch.hand) >= C.dodgeLeanThreshold) return 'lean';
    if (duck) return 'duck';
    if (forward) return 'forward';
  } else if (punch.kind === 'uppercut') {
    // a ducked or forward head stays in the uppercut's path, side lean or not ("uppercuts still catch you")
    if (Math.abs(lx) >= C.dodgeLeanThreshold && !duck && !forward) return 'lean';
  } else {
    if (Math.abs(lx) >= C.dodgeLeanThreshold) return 'lean';
    if (duck) return 'duck';
    if (forward) return 'forward';
  }
  if (back >= C.backLeanThreshold) return 'back';
  return null;
}

/** Is this lean a clear dodge posture of any kind (sideways, duck, far back or a forward tilt)? */
export function isLeaning(lean, tuning = COMBAT) {
  const l = lean || ZERO;
  const z = l.z || 0;
  return Math.abs(l.x || 0) >= tuning.dodgeLeanThreshold || (l.y || 0) <= -tuning.duckThreshold
    || z <= -tuning.backLeanThreshold || z >= forwardThr(tuning);
}

/**
 * A lean that evades the given punch (for AI slips and bots). Returns null for body shots.
 * @param {{kind:string,target:string,hand:string}} punch
 * @param {{float:()=>number}} [rng]
 * @param {number} [depth] magnitude of the lean (default 0.9)
 */
export function dodgeLeanFor(punch, rng = null, depth = 0.9) {
  if (punch.target === 'body') return null;
  const r = rng ? rng.float() : 0.5;
  if (punch.kind === 'hook') {
    // away from the arriving glove, or duck under it
    return r < 0.75 ? { x: handSign(punch.hand) * depth, y: 0, z: 0 } : { x: 0, y: -depth, z: 0 };
  }
  if (punch.kind === 'uppercut') {
    return { x: (r < 0.5 ? -1 : 1) * depth, y: 0, z: 0 };
  }
  // straight: either side, or duck
  if (r < 0.4) return { x: -depth, y: 0, z: 0 };
  if (r < 0.8) return { x: depth, y: 0, z: 0 };
  return { x: 0, y: -depth, z: 0 };
}

/** Evaluate one defence sample against a punch → {result, how, into, blockedBy, guardAmount, t, since}. */
function evalSample(sample, punch, attackerLeanZ, C) {
  const head = punch.target !== 'body';
  const lean = sample.lean || ZERO;
  const how = evasionFor(punch, lean, attackerLeanZ, C);
  if (how) return { result: 'dodged', how, into: false, blockedBy: null, guardAmount: 0, t: sample.t, since: Number.isFinite(sample.since) ? sample.since : null };
  let into = false;
  if (head) {
    const lx = lean.x || 0;
    if (punch.kind === 'hook' && lx * handSign(punch.hand) <= -C.dodgeLeanThreshold) into = true;
    if (punch.kind === 'uppercut' && isDuck(lean, C)) into = true;
  }
  const need = guardFor(punch.target);
  const amount = sample.guardAmount == null ? 1 : sample.guardAmount;
  if (sample.guard === need && amount >= C.guardMinAmount) {
    return { result: 'blocked', how: null, into: false, blockedBy: need, guardAmount: amount, t: sample.t };
  }
  return { result: 'hit', how: null, into, blockedBy: null, guardAmount: 0, t: sample.t };
}

/** Accept a Boxer (anything with combatSnapshot) or a plain snapshot object. */
function snap(x, now) {
  if (x && typeof x.combatSnapshot === 'function') return x.combatSnapshot(now);
  return x || {};
}

/**
 * @typedef {Object} CombatSnapshot
 * @property {boolean} [isHuman]
 * @property {string}  [phase]        BoxerPhase ('down'|'getup'|'ko' cannot be hit)
 * @property {'none'|'high'|'low'} [guard]   EFFECTIVE guard right now (already 'none' when reeling etc.)
 * @property {number}  [guardAmount]  0..1 (humans)
 * @property {{x:number,y:number,z:number}} [lean]
 * @property {number}  [power]        stat multiplier on damage dealt by AI punches without their own damage (default 1)
 * @property {number}  [hp]           health left (wedges) — decides the knockdown
 * @property {number}  [maxHp]
 * @property {number}  [reelMs]       AI defender: reel after a clean hit (default COMBAT.aiReelMs)
 * @property {number}  [comboCount]   attacker: clean hits already landed in the current combo
 * @property {number}  [takenCombo]   defender: hits already taken in the current flurry
 * @property {boolean} [invulnerable]
 * @property {number}  [latencyMs]    human defender: camera → game latency (default COMBAT.latencyMs)
 * @property {Array<{t:number,guard:string,guardAmount:number,lean:{x:number,y:number,z:number},since?:number|null}>} [samples]
 *           human defence history (see LATENCY FAIRNESS); `since` = when the sample's dodging posture began (Boxer.dodgeSince)
 */

/**
 * @typedef {Object} PunchResolution
 * @property {'hit'|'blocked'|'dodged'|'miss'} result
 * @property {number} damage      raw wedges of the blow on a hit (0 otherwise) — may exceed the health left
 * @property {number} dealt       wedges actually removed (hpBefore − hpAfter)
 * @property {boolean} counter    true if a COUNTER landed (COM06)
 * @property {boolean} heavy      counter, power punch, combo hit or damage ≥ heavyDamage
 * @property {boolean} powerPunch
 * @property {boolean} knockdown  this clean hit floors the defender
 * @property {number} hpBefore    defender health before (wedges)
 * @property {number} hpAfter     defender health after (wedges)
 * @property {number} stunMs      reel / punch lock for the defender (0 unless hit)
 * @property {number} chip        always 0 (no chip damage, §2.4)
 * @property {number} daze        always 0 (nobody gets groggy, §4.1.8)
 * @property {null|'lean'|'duck'|'forward'|'back'} dodge  how it was evaded
 * @property {boolean} into       defender moved INTO the punch (duck into uppercut / lean into hook)
 * @property {null|'high'|'low'} blockedBy
 * @property {boolean} dazedTarget always false (legacy)
 * @property {number} comboIndex  0-based index of this hit in the attacker's combo
 * @property {null|number} sampleT time of the defence sample that decided the outcome
 * @property {null|number} leanSince  dodged: when the deciding sample's dodging posture began (null if unknown) —
 *           the Match grants the slow motion / counter window only to a fresh dodge (COMBAT.freshDodgeMs)
 */

/**
 * Resolve one punch at contact (COM05/COM06). Pure: never mutates its arguments.
 * @param {Object} a
 * @param {CombatSnapshot|Object} a.attacker   snapshot or Boxer
 * @param {CombatSnapshot|Object} a.defender   snapshot or Boxer
 * @param {{hand:string,kind:string,target:string,power?:number,counter?:boolean,impactAt?:number,damage?:number,powerPunch?:boolean,atExtension?:boolean,stepIn?:boolean}} a.punch
 * @param {number} [a.now]
 * @param {{float:()=>number}} [a.rng]   optional; adds ±damageVariance
 * @param {Object} [a.tuning]            COMBAT override (defaults to COMBAT)
 * @param {boolean} [a.noDamage]         resolve normally but take no health (tutorial)
 * @returns {PunchResolution}
 */
export function resolvePunch({ attacker, defender, punch, now = 0, rng = null, tuning = COMBAT, noDamage = false }) {
  const C = tuning || COMBAT;
  const A = snap(attacker, now);
  const D = snap(defender, now);
  const p = punch || {};
  const kind = C.punch[p.kind] ? p.kind : 'straight';
  const target = p.target === 'body' ? 'body' : 'head';
  const pn = { hand: p.hand === 'right' ? 'right' : 'left', kind, target };
  const maxHp = Number.isFinite(D.maxHp) ? D.maxHp : C.maxHp;
  const hpBefore = Number.isFinite(D.hp) ? D.hp : maxHp;
  const out = {
    result: 'miss', damage: 0, dealt: 0, counter: false, heavy: false, powerPunch: !!p.powerPunch, knockdown: false,
    hpBefore, hpAfter: hpBefore, stunMs: 0, chip: 0, daze: 0,
    dodge: null, into: false, blockedBy: null, dazedTarget: false, comboIndex: 0, sampleT: null, leanSince: null,
  };

  // A boxer on the canvas / getting up / knocked out cannot be hit: the punch sails over.
  if (D.invulnerable || UNHITTABLE.has(D.phase)) return out;

  // an AI punch that steps in (ai.js answers a held back lean, E) reaches like a full lean-in (D4)
  const attackerLeanZ = Math.max((A.lean && A.lean.z) || 0, p.stepIn ? 1 : 0);
  const impactAt = Number.isFinite(p.impactAt) ? p.impactAt : now;

  // Gather the defence samples to judge (humans: a latency-fair window; AI: the present).
  let samples = null;
  if (Array.isArray(D.samples) && D.samples.length) {
    const lat = Number.isFinite(D.latencyMs) ? D.latencyMs : C.latencyMs;
    const lo = impactAt + lat - C.defenseEarlyMs, hi = impactAt + lat + C.defenseGraceMs;
    samples = D.samples.filter((s) => s && s.t >= lo && s.t <= hi);
    if (!samples.length) {
      // the window is not covered (e.g. resolved early): use the newest sample at or before it
      let last = null;
      for (const s of D.samples) if (s && s.t <= hi) last = s;
      samples = last ? [last] : null;
    }
  }
  if (!samples || !samples.length) {
    samples = [{ t: now, guard: D.guard || 'none', guardAmount: D.guardAmount == null ? 1 : D.guardAmount, lean: D.lean || ZERO }];
  }

  // Best outcome for the defender across the window; among hits prefer the one without "into".
  let best = null;
  for (const s of samples) {
    const r = evalSample(s, pn, attackerLeanZ, C);
    if (!best || RANK[r.result] > RANK[best.result] || (r.result === best.result && best.into && !r.into)) best = r;
  }
  out.sampleT = best.t ?? null;

  if (best.result === 'dodged') {
    out.result = 'dodged';
    out.dodge = best.how;
    out.leanSince = best.since ?? null;
    return out;
  }
  if (best.result === 'blocked') {
    out.result = 'blocked';
    out.blockedBy = best.blockedBy;
    return out;
  }

  // ── clean hit ──
  out.result = 'hit';
  out.into = best.into;
  const isCounter = !!p.counter;
  out.counter = isCounter;
  const comboIndex = Math.max(0, Math.floor(A.comboCount || 0));
  out.comboIndex = comboIndex;
  const spec = C.punch[kind];
  let base = Number.isFinite(p.damage)
    ? p.damage
    : A.isHuman ? humanDamage(p.power, C) : C.aiBaseDamage * (Number.isFinite(A.power) ? A.power : 1);
  base *= spec.damageMul ?? 1;
  let dmg = isCounter ? Math.max(base, base * C.counterDamageMul) : base;
  if (rng && C.damageVariance > 0) dmg *= 1 + (rng.float() * 2 - 1) * C.damageVariance;
  dmg = clamp(dmg, 0.05, C.counterDamageCap);
  out.damage = round2(dmg);
  out.heavy = isCounter || out.powerPunch || dmg >= C.heavyDamage || (!!A.isHuman && comboIndex >= 1);

  // knockdown rule (§2.9) — an ordinary hit never floors a fighter who still has > warningBeatHp
  if (noDamage) {
    out.hpAfter = hpBefore;
  } else if (dmg >= hpBefore - 1e-9) {
    if (!isCounter && !out.powerPunch && hpBefore > C.warningBeatHp) {
      out.hpAfter = Math.min(hpBefore, C.warningBeatLeave);
    } else {
      out.hpAfter = 0;
      out.knockdown = true;
    }
  } else {
    out.hpAfter = round2(hpBefore - dmg);
  }
  out.dealt = round2(Math.max(0, hpBefore - out.hpAfter));

  // stun
  if (D.isHuman) {
    out.stunMs = out.heavy ? C.humanHeavyLockMs : C.humanHitLockMs;
  } else {
    let stun = (Number.isFinite(D.reelMs) ? D.reelMs : C.aiReelMs) * Math.pow(C.stunDecay, Math.max(0, D.takenCombo || 0));
    if (isCounter) stun = Math.max(stun, C.counterStunMs);
    out.stunMs = Math.round(Math.max(C.minStunMs, stun));
  }
  return out;
}
