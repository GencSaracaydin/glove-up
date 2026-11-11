// Training medals (TRN02): bronze / silver / gold / platinum per practice activity.
//
// Owner: training. Pure data + functions (no DOM); imported by the activities (result medal),
// by the training-result screen (next-medal hint) and by unit tests.
//
// Cutoffs are scores (≥ cutoff earns the medal). They were calibrated with the scripted bots in
// session.js (makeTrainingBot) over many seeds — see tests/unit/training-medals.test.mjs:
//   * a beginner who keeps at it (bot skill ≈ 0.2: slow, late, sloppy) earns BRONZE,
//   * an average player (≈ 0.5) earns SILVER,
//   * a good player (≈ 0.75) earns GOLD,
//   * PLATINUM needs near-flawless play for the whole minute (≈ 0.95+).
// Score arithmetic per activity (spec §9 "training duration and score arithmetic"):
//   bag   — 100 points per bag knocked off its chain + partial credit (% of the current bag's
//           strength knocked out), so 437 = four bags and 37 % of the fifth.
//   dodge — 1 point per ball avoided, 2 while on a 5+ streak, 3 while on a 10+ streak.
//   mitts — 10 points per mitt + up to 10 for a fast reaction, streak and double-mitt bonuses,
//           minus 10 for every punch that lands on the trainer (never below 0).

import { Medal } from '../core/types.js';

/** Medals from worst to best. */
export const MEDAL_ORDER = Object.freeze([Medal.NONE, Medal.BRONZE, Medal.SILVER, Medal.GOLD, Medal.PLATINUM]);

/** Score needed for each medal, per activity (TrainingKind). */
// bag platinum 550 → 530 in the alignment pass: the player's punches now reach the target in
// 100 / 120 / 130 ms (research/mechanics.md §2.2; was 140 / 175 / 195) and training keeps the bout's
// punch timings, which moved the expert bot's median from 568 to 544 (good 454, average 397).
export const MEDAL_CUTOFFS = Object.freeze({
  bag: Object.freeze({ bronze: 180, silver: 330, gold: 450, platinum: 530 }),
  dodge: Object.freeze({ bronze: 12, silver: 32, gold: 60, platinum: 92 }),
  mitts: Object.freeze({ bronze: 300, silver: 650, gold: 950, platinum: 1250 }),
});

/** 0 (none) … 4 (platinum). Unknown values rank as none. */
export function medalRank(medal) {
  const i = MEDAL_ORDER.indexOf(medal);
  return i < 0 ? 0 : i;
}

/** The better of two medals. */
export function betterMedal(a, b) {
  return medalRank(b) > medalRank(a) ? b : (MEDAL_ORDER.includes(a) ? a : Medal.NONE);
}

/**
 * Medal earned by `score` in activity `kind` (TRN02). Unknown kinds and non-finite scores earn none.
 * @param {string} kind   TrainingKind ('bag' | 'dodge' | 'mitts')
 * @param {number} score
 * @returns {string} Medal
 */
export function medalFor(kind, score) {
  const cuts = MEDAL_CUTOFFS[kind];
  if (!cuts || !Number.isFinite(score)) return Medal.NONE;
  if (score >= cuts.platinum) return Medal.PLATINUM;
  if (score >= cuts.gold) return Medal.GOLD;
  if (score >= cuts.silver) return Medal.SILVER;
  if (score >= cuts.bronze) return Medal.BRONZE;
  return Medal.NONE;
}

/**
 * The next medal above `score` and how many points it still needs, or null at platinum
 * (or for an unknown kind).
 * @returns {null|{medal:string, cutoff:number, need:number}}
 */
export function nextMedal(kind, score) {
  const cuts = MEDAL_CUTOFFS[kind];
  if (!cuts) return null;
  const s = Number.isFinite(score) ? score : 0;
  for (const m of [Medal.BRONZE, Medal.SILVER, Medal.GOLD, Medal.PLATINUM]) {
    if (s < cuts[m]) return { medal: m, cutoff: cuts[m], need: cuts[m] - s };
  }
  return null;
}
