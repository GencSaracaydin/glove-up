// The single-player ladder: 10 ORIGINAL opponents (PRG01). Names, nicknames, intros and
// looks are our own inventions — no likenesses of real people or of any other game's
// characters. Appearances use only APPEARANCE_OPTIONS (src/core/types.js) and the shared
// palette mood of src/render/style.js.
//
// The FIGHTING STYLES are research/mechanics.md §4.5 ("recommended roster of 10 original
// opponents"), mapped in ladder order onto our ten characters: table a) offence, table b)
// defence and knockouts, table c) the tuning targets dev/sim.mjs checks. Every number below is
// in the table's own units (seconds → ms, percentages → 0..1) so it can be compared line by line.
//
// Entry shape:
//   { id, name, nickname, tier 1..10, rating, skillRequired, style, intro, appearance,
//     stats: { hp, power, speed, heart }, ai: { … } }
//
//   rating        BASE RATING of the opponent (§4.5 "#  Rating" column: 120 … 1600). The progression
//                 owner (game/progression.js) reads it for matchmaking and the VS card.
//   skillRequired legacy ladder gate (kept for older readers).
//   stats.hp      max health in WEDGES (10, like the player — §2.6)
//
// ai — offence (§4.5a; consumed by game/ai.js, see AI_DEFAULTS there):
//   firstAttackMs    clock start ("Fight!") → first wind-up
//   attackGapMs      rest between attacks; attackGapByRound optional per-round override
//   tellMs           ordinary tell = first visible movement → impact (bodyTellMs for body punches)
//   stringWeights    punches per attack: weights for 1, 2, 3, 4 punches
//   stringGapMs      impact → next impact inside an attack ([min, max] or a number);
//                    stringGapReelMs when the last one landed (player reeling); stringGapHeadBodyMs head → body
//   bodyPct          share of punches to the body;  powerPct share that are power punches
//   powerTellMs      power-punch tell (never below COMBAT.minPowerTellMs + the input latency, §4.6)
//   powerDamage / ordinaryDamage / firstPunchDamage   wedges per clean hit (before the ±30 % variance)
//   powerKind        the power punch ('hook' raised glove, 'straight' long trail)
// ai — defence & knockouts (§4.5b):
//   headGuard / bodyGuard  chance a player punch at that height meets the guard while the AI is idle
//   slipPct / slipCounterMs   per head punch: slip it, then counter after this delay
//   punishPct / punishDelayMs counter after blocking: green ring → counter impact ([min, max])
//   punchIntoPct     punch into the player's punch (lands 0.17–0.23 s after it starts)
//   coverUpPct       after 2 hits within 1 s: hold a high guard for coverMs (900 ms REAL time: the
//                    second hit's hit-stop is netted out, ai.js _coverMs)
//   reelMs           reel after a clean hit (can't punch; game ms after the hit-stop)
//   stunGuardMs      [ordinary, heavy]: game ms the reel keeps the guard OPEN after an ordinary / a heavy
//                    (counter, combo, power) clean hit. The renderer stalls the game 0.2 / 0.5 s on those hits
//                    first, so the PRO values [400–450, 175–205] bring the guard back ~0.6–0.65 / ~0.69 s
//                    (real) after the impact (§2.3, §2.7: "guard back up after about 0.7 s")
//   missRecoveryMs   how long the missed glove hangs out, as SEEN (real time, slow motion included)
//   stayDown         chance of staying down on knockdowns 1 / 2 / 3 (a 4th always stays down)
//   riseMean         mean count when rising from knockdowns 1 / 2 / 3 (SD 1.2, clamped 3–9)
// ai — our own extras: guardStyle ('high'|'low'|'open'|'switch' — where the idle gloves are),
//   holdWhileLeanMs (hold a cocked punch while you lean, §4.1.7), followUpPct (keep hitting a
//   reeling player, §4.1.5), smartTargeting (aim at your open zone), moodSwing (chance per round
//   of an aggressive/defensive mood, §4.1.9), feintChance, punchMix (ordinary punch kinds),
//   the read knobs of AI_DEFAULTS (streakBlock / postReelGuardMs: the set guard right after a block
//   or a reel; flurryGuard: the 3rd+ punch of a flurry; attackGuardMul: the other glove while punching),
//   exchangeMs / punishedMs (one punish per blocked exchange), postureAnswerMs / postureAnswerPct (a dodge
//   posture held ~1 s is answered with a punch it does not evade — E, see ai.js; every opponent uses the defaults),
//   and the body params of AI_BODY_DEFAULTS (game/boxer.js): tells (renderer cues), guardRaiseMs, …
//   whiffRecoverMs is DERIVED from missRecoveryMs (see withDerived below).
//
// FIX-PASS TUNING (re-tuned E values; `node dev/sim.mjs --n 200`, which now runs on the renderer's
// hit-stop clock like MatchSession): punishPct follows §4.5b again for #7–#10 (85/70/75/85 %: the PRO tier
// punishes nearly every blocked punch, §4.2/§4.4) — once per blocked exchange (ai.js, RV-RULES-03). With the
// measured punish rates and a faithful clock the skilled tuning bot lands follow-ups through the stalls, so the
// upper tiers hold a tighter head guard than §4.5b's E guesses (headGuard, streakBlock) and the punishing tiers
// attack less on their own (attackGapMs: #8 7.6 s, #9 5.6 s) to stay inside the §4.5c hits-per-minute
// targets — most of their hits are punishes now.
// REPAIR-ROUND RE-TUNE (two-sided, decision R3): the table is checked for three bots — 'player' (the skilled
// tuning bot, §4.5c), 'mid' and 'casual' (a first-timer) — so the PRO tier stays beatable for weaker players
// (casual ≥ ~25 % at each of #5–#10, mid ≥ ~55 % at #7/#8). The extra difficulty came out of the knobs that hurt
// weak players most rather than the head-guard read that paces the skilled bot (it only eased a little: #7 0.96 →
// 0.92, #8 0.80 → 0.74): #7 body guard 0.78 → 0.35 (§4.5b 0.30), cover-ups 0.86/0.85 → 0.5 (#7) / 0.6 (#8), #8
// flurry guard 0.6 → 0.4 and body guard 0.48 → 0.38, #7 punishes landing 0.28–0.65 s after the green ring (was
// 0.23–0.60; still inside §4.3's 0.20–0.82 s), ordinary damage 1.0 and a 3.1 s attack gap (was 3.3); the champion
// presses with 1.7 s gaps after round 1 (§4.5a 1.6; was 1.5), covers up as §4.5b says (0.85 → 0.5), punishes 0.40–0.60 s
// after the ring (was 0.40), guards a little more (head 0.45 → 0.5) and hits a little lighter (power share 25 → 20 %,
// power 3.5 → 3.0, ordinary 1.1 → 1.0: with §4.5a's 25 % / 3.5 / 1.1 a first-timer wins only 14–21 % against it).
// Residual misses for 'player' (n 200): 11 of 40 cells at seed 1 and 9 at seed 7, as before the re-tune — see
// research/mechanics.md §4.5 d.
// POLISH ROUND (decisions R9, R10): the champion hits as §4.5a says again — power 25 % at 3.5, ordinary 1.1 — at a pace
// near §4.5a's: 3.8 s between attacks in round 1 (§4.5a 3.5) and 1.7 s after (§4.5a 1.6, as in the repair round). With
// §4.5a's exact gaps and punishes thrown as measured a first-timer won 14.5–19 % (the casual floor against it is 15 %,
// dev/sim.mjs FLOORS) and the skilled bot floored it too early (20.3 s, §4.5c 21–33). Degenerate keyboard play (mashing to
// the head, the body or both behind a held guard, postures plus a guard, pulsed postures) is answered by mechanics in
// ai.js and match.js, not by the table: from #5 up a player who keeps punching into the guard has the next punch caught
// and countered while the glove is out, the body read follows a player who goes to the body, every blocked punch of a held
// posture may be punished, a bobbing posture is answered, and dips with no attack coming earn no slow motion (measured
// over 145 strategies, research/mechanics.md §4.5 d; still open: a single jab every 2 s or slower behind a held keyboard
// guard — no mashing — wins about half its bouts against #8 and #9, as in the repair round). #1–#4 keep
// the measured punish timing and their open body (punishIntoGlove 0, bodyReadAdapt 0). Table moves for the 'player' bot's
// §4.5c fit (9 / 8 / 9 misses at seeds 1 / 7 / 3; repair round 11 / 9 / 11) and the floors: #5 head guard 0.95 → 0.94,
// #9 head guard 0.72 → 0.69 with its other glove covering 0.85 of reads while it punches (attackGuardMul, was 0.7) and a
// 5.1 s attack gap (was 5.6).

import { COMBAT } from './combat.js';

/** Base ratings in ladder order (§4.5 table a, "Rating"). */
export const RATINGS = Object.freeze([120, 280, 450, 600, 750, 900, 1050, 1200, 1400, 1600]);

/**
 * World-time whiff recovery that makes the missed glove hang `missRecoveryMs` in REAL time: the
 * human's dodge is judged latency + grace after the glove arrives (it hangs at full stretch
 * meanwhile), then the dodge slow motion (COMBAT.slowmoScale for COMBAT.slowmoMs) stretches the
 * rest (§2.5, §2.7: "the missed glove stays out 0.6–0.7 s", ≈0.3 s against the top opponents).
 */
export function whiffRecoverForHang(missRecoveryMs, tuning = COMBAT) {
  const before = (tuning.latencyMs ?? 100) + (tuning.defenseGraceMs ?? 60);
  const real = Math.max(0, missRecoveryMs - before);
  const slow = Math.min(real, tuning.slowmoMs ?? 750);
  return Math.max(40, Math.round(slow * (tuning.slowmoScale ?? 0.25) + (real - slow)));
}

function withDerived(def) {
  const ai = { ...def.ai };
  if (!Number.isFinite(ai.whiffRecoverMs) && Number.isFinite(ai.missRecoveryMs)) ai.whiffRecoverMs = whiffRecoverForHang(ai.missRecoveryMs);
  return Object.freeze({ ...def, ai: Object.freeze(ai) });
}

/** @typedef {typeof ROSTER[number]} OpponentDef */

export const ROSTER = Object.freeze([
  {
    // §4.5 #1 — sparring partner: long tells, one punch at a time, gloves open.
    id: 'benny-bramble', name: 'Benny Bramble', nickname: 'Butterfingers', tier: 1, rating: 120, skillRequired: 0,
    style: 'rookie',
    intro: "Benny's first real bout. He brought snacks for the crowd.",
    appearance: {
      skin: '#f6d7c3', hair: { style: 'curly', color: '#8a5a33' }, eyes: 'wide', brows: 'worried', mouth: 'open',
      nose: 'button', accessory: 'headband', top: '#9be564', trunks: '#2bb3a3', trim: '#ffd166',
      gloves: '#ff8a5b', shoes: '#f4f1e8', build: 'average', height: 0.95,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.45 },
    ai: {
      firstAttackMs: 2000, attackGapMs: 7000, tellMs: 450, stringWeights: [1], stringGapMs: 900,
      bodyPct: 0.2, powerPct: 0, ordinaryDamage: 1.0,
      headGuard: 0.23, bodyGuard: 0.08, slipPct: 0, punishPct: 0, punchIntoPct: 0, coverUpPct: 0, stunGuardMs: [550, 315],
      postReelGuardMs: 300, streakBlock: 0.5,
      reelMs: 700, missRecoveryMs: 800, stayDown: [0.4, 0.8, 1], riseMean: [7, 8, 9],
      guardStyle: 'open', holdWhileLeanMs: 0, followUpPct: 0, smartTargeting: 0, moodSwing: 0, feintChance: 0,
      punchMix: { straight: 0.85, hook: 0.15, uppercut: 0 },
      guardRaiseMs: 140, leanSpeed: 7, punishIntoGlove: 0, bodyReadAdapt: 0,
      tells: { pullback: 1.15, glint: true, grunt: true, shoulder: 1.3 },
    },
  },
  {
    // §4.5 #2 — bell rusher: attacks right after "Fight!", single punches and one-twos.
    id: 'pip-calloway', name: 'Pip Calloway', nickname: 'The Pipsqueak', tier: 2, rating: 280, skillRequired: 80,
    style: 'speedy',
    intro: 'Small, speedy and very loud about it.',
    appearance: {
      skin: '#eec1a0', hair: { style: 'spiky', color: '#d8b26a' }, eyes: 'happy', brows: 'arched', mouth: 'grin',
      nose: 'round', accessory: 'none', top: 'none', trunks: '#c77dff', trim: '#f4f1e8',
      gloves: '#ffd166', shoes: '#6c8dff', build: 'slim', height: 0.9,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.52 },
    ai: {
      firstAttackMs: 400, attackGapMs: 6500, tellMs: 250, stringWeights: [0.6, 0.4], stringGapMs: 600,
      bodyPct: 0.25, powerPct: 0, ordinaryDamage: 1.0,
      headGuard: 0.56, bodyGuard: 0.24, slipPct: 0, punishPct: 0.15, punishDelayMs: [600, 600], punchIntoPct: 0, coverUpPct: 0.2, stunGuardMs: [440, 260],
      streakBlock: 0.77,
      reelMs: 650, missRecoveryMs: 700, stayDown: [0.45, 0.75, 1], riseMean: [7.5, 8, 9],
      guardStyle: 'low', holdWhileLeanMs: 0, followUpPct: 0.1, smartTargeting: 0.1, moodSwing: 0.1, feintChance: 0,
      punchMix: { straight: 0.75, hook: 0.2, uppercut: 0.05 },
      guardRaiseMs: 120, leanSpeed: 8, punishIntoGlove: 0, bodyReadAdapt: 0,
      tells: { pullback: 1.07, glint: true, grunt: true, shoulder: 1.19 },
    },
  },
  {
    // §4.5 #3 — string puncher: strings of up to 4, a heavier first punch, the odd power hook.
    id: 'gus-hammerly', name: 'Gus Hammerly', nickname: 'The Bulldozer', tier: 3, rating: 450, skillRequired: 180,
    style: 'slugger',
    intro: 'Hits like a fridge falling down the stairs. Moves like one, too.',
    appearance: {
      skin: '#b97a52', hair: { style: 'buzz', color: '#1d1a19' }, eyes: 'narrow', brows: 'thick', mouth: 'flat',
      nose: 'round', accessory: 'moustache', top: '#ff5d8f', trunks: '#3b5bdb', trim: '#ffc94a',
      gloves: '#f4f1e8', shoes: '#1d1a19', build: 'heavy', height: 1.05,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.57 },
    ai: {
      firstAttackMs: 700, attackGapMs: 2600, tellMs: 300, stringWeights: [0.4, 0.3, 0.2, 0.1], stringGapMs: 750,
      bodyPct: 0.3, powerPct: 0.1, powerTellMs: 600, powerDamage: 2.0, ordinaryDamage: 1.0, firstPunchDamage: 1.5, powerKind: 'hook',
      headGuard: 0.68, bodyGuard: 0.32, slipPct: 0, punishPct: 0.25, punishDelayMs: [600, 600], punchIntoPct: 0, coverUpPct: 0.5, stunGuardMs: [480, 420],
      streakBlock: 0.85,
      reelMs: 600, missRecoveryMs: 700, stayDown: [0.35, 0.6, 1], riseMean: [7, 7.5, 8.5],
      guardStyle: 'high', holdWhileLeanMs: 0, followUpPct: 0.2, smartTargeting: 0.15, moodSwing: 0.15, feintChance: 0,
      punchMix: { straight: 0.4, hook: 0.45, uppercut: 0.15 },
      guardRaiseMs: 120, leanSpeed: 7, punishIntoGlove: 0, bodyReadAdapt: 0,
      tells: { pullback: 1.01, glint: true, grunt: true, shoulder: 1.11 },
    },
  },
  {
    // §4.5 #4 — quick one-two, head and body; switches her guard height.
    id: 'lula-fairweather', name: 'Lula Fairweather', nickname: 'Sunny', tier: 4, rating: 600, skillRequired: 290,
    style: 'switcher',
    intro: 'Smiles the whole fight, and switches her guard when you least expect it.',
    appearance: {
      skin: '#d9a07a', hair: { style: 'ponytail', color: '#b8432f' }, eyes: 'oval', brows: 'arched', mouth: 'smile',
      nose: 'button', accessory: 'earring', top: '#ffd166', trunks: '#ff8a5b', trim: '#f4f1e8',
      gloves: '#5bd1b8', shoes: '#f4f1e8', build: 'slim', height: 0.98,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.62 },
    ai: {
      firstAttackMs: 700, attackGapMs: 3450, tellMs: 300, bodyTellMs: 450, stringWeights: [0.5, 0.5], stringGapMs: 400,
      bodyPct: 0.4, powerPct: 0.1, powerTellMs: 600, powerDamage: 2.0, ordinaryDamage: 1.0, powerKind: 'hook',
      headGuard: 0.64, bodyGuard: 0.3, slipPct: 0.01, slipCounterMs: 300, punishPct: 0.26, punishDelayMs: [600, 600], punchIntoPct: 0, coverUpPct: 0.3, stunGuardMs: [600, 600],
      reelMs: 600, missRecoveryMs: 700, stayDown: [0.3, 0.5, 0.6], riseMean: [6, 7, 8],
      guardStyle: 'switch', guardSwitchMs: 2200, holdWhileLeanMs: 0, followUpPct: 0.25, smartTargeting: 0.2, moodSwing: 0.2, feintChance: 0,
      punchMix: { straight: 0.6, hook: 0.3, uppercut: 0.1 },
      guardRaiseMs: 110, leanSpeed: 9, punishIntoGlove: 0, bodyReadAdapt: 0,
      tells: { pullback: 0.95, glint: true, grunt: true, shoulder: 1.03 },
    },
  },
  {
    // §4.5 #5 — counter-puncher: punishes blocked punches, keeps hitting a reeling player.
    id: 'otto-wexley', name: 'Otto Wexley', nickname: 'The Professor', tier: 5, rating: 750, skillRequired: 410,
    style: 'counter-puncher',
    intro: "A patient counter-puncher. Miss him once and he'll make you pay for it.",
    appearance: {
      skin: '#f6d7c3', hair: { style: 'flat-top', color: '#e9e4dc' }, eyes: 'dot', brows: 'flat', mouth: 'smirk',
      nose: 'long', accessory: 'beard', top: '#6c8dff', trunks: '#14182b', trim: '#ffd166',
      gloves: '#c77dff', shoes: '#6c8dff', build: 'average', height: 1,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.67 },
    ai: {
      firstAttackMs: 1000, attackGapMs: 4000, tellMs: 250, stringWeights: [0.4, 0.4, 0.2], stringGapMs: 500, stringGapReelMs: 800,
      bodyPct: 0.35, powerPct: 0.15, powerTellMs: 550, powerDamage: 2.5, ordinaryDamage: 1.1, powerKind: 'hook',
      headGuard: 0.94, bodyGuard: 0.5, slipPct: 0.02, slipCounterMs: 300, punishPct: 0.6, punishDelayMs: [400, 800], punchIntoPct: 0, coverUpPct: 0.65, stunGuardMs: [400, 205],
      streakBlock: 0.92, flurryGuard: 0.45, postReelGuardMs: 550,
      reelMs: 550, missRecoveryMs: 650, stayDown: [0.15, 0.2, 0.25], riseMean: [5, 6.5, 8],
      guardStyle: 'high', holdWhileLeanMs: 0, followUpPct: 0.35, smartTargeting: 0.3, moodSwing: 0.2, feintChance: 0,
      punchMix: { straight: 0.55, hook: 0.3, uppercut: 0.15 },
      guardRaiseMs: 100, leanSpeed: 10,
      tells: { pullback: 0.9, glint: true, grunt: true, shoulder: 0.95 },
    },
  },
  {
    // §4.5 #6 — patient power puncher: waits, fast little combos, holds a cocked punch while you lean.
    id: 'juno-vale', name: 'Juno Vale', nickname: 'Quicksilver', tier: 6, rating: 900, skillRequired: 530,
    style: 'speedster',
    intro: "Blink and you'll miss the jab. Don't blink.",
    appearance: {
      skin: '#8d5a3b', hair: { style: 'cornrows', color: '#1d1a19' }, eyes: 'fierce', brows: 'flat', mouth: 'smirk',
      nose: 'button', accessory: 'mouthguard', top: '#a0f0ff', trunks: '#1f3b73', trim: '#a0f0ff',
      gloves: '#f7f3ea', shoes: '#1f3b73', build: 'slim', height: 1.02,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.71 },
    ai: {
      firstAttackMs: 3000, attackGapMs: 2450, tellMs: 250, stringWeights: [0.5, 0.25, 0.25], stringGapMs: 350,
      bodyPct: 0.3, powerPct: 0.2, powerTellMs: 600, powerDamage: 2.5, ordinaryDamage: 1.0, powerKind: 'hook',
      headGuard: 0.72, bodyGuard: 0.32, slipPct: 0.02, slipCounterMs: 200, punishPct: 0.45, punishDelayMs: [500, 500], punchIntoPct: 0, coverUpPct: 0.4, stunGuardMs: [480, 330],
      reelMs: 550, missRecoveryMs: 650, stayDown: [0.1, 0.2, 0.25], riseMean: [5.5, 6, 8],
      guardStyle: 'high', holdWhileLeanMs: 1000, followUpPct: 0.35, smartTargeting: 0.3, moodSwing: 0.25, feintChance: 0,
      punchMix: { straight: 0.65, hook: 0.25, uppercut: 0.1 },
      guardRaiseMs: 90, leanSpeed: 12,
      tells: { pullback: 0.85, glint: false, grunt: true, shoulder: 0.88 },
    },
  },
  {
    // §4.5 #7 — fortress: a high guard, punishes nearly everything, a huge raised-glove power punch.
    id: 'earl-pickett', name: 'Big Earl Pickett', nickname: 'The Mountain', tier: 7, rating: 1050, skillRequired: 650,
    style: 'tank',
    intro: 'Takes a punch like a brick wall. Throws one like a brick wall, too.',
    appearance: {
      skin: '#5e3b26', hair: { style: 'bald', color: '#1d1a19' }, eyes: 'sleepy', brows: 'thick', mouth: 'flat',
      nose: 'round', accessory: 'beard', top: 'none', trunks: '#2d6a4f', trim: '#ffd166',
      gloves: '#ffc94a', shoes: '#14182b', build: 'heavy', height: 1.1,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.75 },
    ai: {
      firstAttackMs: 2400, attackGapMs: 3100, tellMs: 220, stringWeights: [0.5, 0.5], stringGapMs: 330, stringGapHeadBodyMs: 900,
      bodyPct: 0.3, powerPct: 0.2, powerTellMs: 800, powerDamage: 3.5, ordinaryDamage: 1.0, powerKind: 'hook',
      headGuard: 0.92, bodyGuard: 0.35, slipPct: 0.03, slipCounterMs: 270, punishPct: 0.85, punishDelayMs: [280, 650], punchIntoPct: 0, coverUpPct: 0.5, stunGuardMs: [410, 185],
      streakBlock: 0.96, flurryGuard: 0.5, postReelGuardMs: 700,
      reelMs: 500, missRecoveryMs: 600, stayDown: [0, 0.17, 0.4], riseMean: [5, 7, 8],
      guardStyle: 'high', holdWhileLeanMs: 800, followUpPct: 0.4, smartTargeting: 0.35, moodSwing: 0.2, feintChance: 0,
      punchMix: { straight: 0.5, hook: 0.3, uppercut: 0.2 },
      guardRaiseMs: 100, leanSpeed: 8,
      tells: { pullback: 0.8, glint: false, grunt: true, shoulder: 0.8 },
    },
  },
  {
    // §4.5 #8 — body hunter: most punches go downstairs, heavy body hooks, patient counters.
    id: 'sasha-brightwater', name: 'Sasha Brightwater', nickname: 'Showtime', tier: 8, rating: 1200, skillRequired: 770,
    style: 'showboat',
    intro: 'Loves the crowd, loves a feint, loves watching you flinch.',
    appearance: {
      skin: '#eec1a0', hair: { style: 'bob', color: '#e64980' }, eyes: 'happy', brows: 'arched', mouth: 'grin',
      nose: 'button', accessory: 'shades', top: '#c77dff', trunks: '#ffd166', trim: '#c77dff',
      gloves: '#ff5d8f', shoes: '#ffd166', build: 'slim', height: 1,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.8 },
    ai: {
      firstAttackMs: 1500, attackGapMs: 7600, tellMs: 230, stringWeights: [0.6, 0.4], stringGapMs: 500,
      bodyPct: 0.5, powerPct: 0.2, powerTellMs: 530, powerDamage: 3.0, ordinaryDamage: 1.2, powerKind: 'hook', powerBodyPct: 0.6,
      headGuard: 0.74, bodyGuard: 0.38, slipPct: 0.03, slipCounterMs: 250, punishPct: 0.7, punishDelayMs: [400, 700], punchIntoPct: 0, coverUpPct: 0.6, stunGuardMs: [400, 205],
      streakBlock: 0.94, flurryGuard: 0.4, postReelGuardMs: 650, attackGuardMul: 0.88,
      reelMs: 500, missRecoveryMs: 500, stayDown: [0, 0.1, 0.35], riseMean: [6, 8, 8],
      guardStyle: 'high', holdWhileLeanMs: 800, followUpPct: 0.4, smartTargeting: 0.35, moodSwing: 0.25, feintChance: 0.04,
      punchMix: { straight: 0.45, hook: 0.4, uppercut: 0.15 },
      guardRaiseMs: 90, leanSpeed: 12,
      tells: { pullback: 0.75, glint: false, grunt: false, shoulder: 0.73 },
    },
  },
  {
    // §4.5 #9 — rusher: fast restarts, long power straights, punches into your punches.
    id: 'dante-mossgrove', name: 'Dante Mossgrove', nickname: 'Iron Moss', tier: 9, rating: 1400, skillRequired: 890,
    style: 'relentless',
    intro: 'Never stays down. Never stops coming.',
    appearance: {
      skin: '#d9a07a', hair: { style: 'mohawk', color: '#3b5bdb' }, eyes: 'fierce', brows: 'angry', mouth: 'gritted',
      nose: 'long', accessory: 'bandage', top: '#2d3a66', trunks: '#5bd1b8', trim: '#1f3b73',
      gloves: '#9be564', shoes: '#14182b', build: 'average', height: 1.05,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.91 },
    ai: {
      firstAttackMs: 600, attackGapMs: 5100, tellMs: 200, stringWeights: [0.5, 0.5], stringGapMs: 550,
      bodyPct: 0.4, powerPct: 0.25, powerTellMs: 700, powerDamage: 3.0, ordinaryDamage: 1.1, powerKind: 'straight',
      headGuard: 0.69, bodyGuard: 0.42, slipPct: 0.02, slipCounterMs: 250, punishPct: 0.75, punishDelayMs: [470, 470], punchIntoPct: 0.08, coverUpPct: 0.8, stunGuardMs: [450, 175],
      streakBlock: 0.88, attackGuardMul: 0.85,
      reelMs: 500, missRecoveryMs: 420, stayDown: [0, 0.15, 0.4], riseMean: [5, 6, 8.5],
      guardStyle: 'high', holdWhileLeanMs: 600, followUpPct: 0.45, smartTargeting: 0.4, moodSwing: 0.25, feintChance: 0,
      punchMix: { straight: 0.5, hook: 0.35, uppercut: 0.15 },
      guardRaiseMs: 80, leanSpeed: 13,
      tells: { pullback: 0.7, glint: false, grunt: false, shoulder: 0.67 },
    },
  },
  {
    // §4.5 #10 — champion: cagey first round, then pressure; wide power hooks, punishes everything.
    id: 'nova-kingsley', name: 'Nova Kingsley', nickname: 'The Crown', tier: 10, rating: 1600, skillRequired: 1000,
    style: 'champion',
    intro: "The champion. Every trick in the book, and a few that aren't in it yet.",
    appearance: {
      skin: '#8d5a3b', hair: { style: 'bun', color: '#1d1a19' }, eyes: 'narrow', brows: 'flat', mouth: 'smirk',
      nose: 'button', accessory: 'earring', top: '#fffaf0', trunks: '#ffc94a', trim: '#fffaf0',
      gloves: '#ffc94a', shoes: '#fffaf0', build: 'average', height: 1.08,
    },
    stats: { hp: 10, power: 1, speed: 1, heart: 0.88 },
    ai: {
      firstAttackMs: 600, attackGapMs: 3500, attackGapByRound: [3800, 1700, 1700], guardByRound: [0.2, 0, 0], tellMs: 180, stringWeights: [0.4, 0.4, 0.2], stringGapMs: [400, 900],
      bodyPct: 0.4, powerPct: 0.25, powerTellMs: 450, powerDamage: 3.5, ordinaryDamage: 1.1, powerKind: 'hook',
      headGuard: 0.5, bodyGuard: 0.25, slipPct: 0.04, slipCounterMs: 250, punishPct: 0.85, punishDelayMs: [400, 600], punchIntoPct: 0.05, coverUpPct: 0.5, stunGuardMs: [430, 185],
      streakBlock: 0.94, flurryGuard: 0.55, postReelGuardMs: 600, attackGuardMul: 0.82,
      reelMs: 500, missRecoveryMs: 350, stayDown: [0, 0.1, 0.4], riseMean: [6, 7.5, 8],
      guardStyle: 'high', holdWhileLeanMs: 980, followUpPct: 0.5, smartTargeting: 0.45, moodSwing: 0.1, feintChance: 0,
      punchMix: { straight: 0.5, hook: 0.32, uppercut: 0.18 },
      guardRaiseMs: 70, leanSpeed: 14,
      tells: { pullback: 0.65, glint: false, grunt: false, shoulder: 0.6 },
    },
  },
].map(withDerived));

/** Lookup by id. */
export const ROSTER_BY_ID = Object.freeze(Object.fromEntries(ROSTER.map((d) => [d.id, d])));

/** Roster entry by id (null if unknown). */
export function opponentById(id) { return ROSTER_BY_ID[id] || null; }

/** Roster entry by tier 1..10 (clamped). */
export function opponentByTier(tier) {
  const i = Math.max(1, Math.min(ROSTER.length, Math.round(Number(tier) || 1)));
  return ROSTER[i - 1];
}

/** The champion (last rung). */
export const CHAMPION = ROSTER[ROSTER.length - 1];
