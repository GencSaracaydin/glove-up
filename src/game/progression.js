// Rating ("skill" in profiles), PRO status, matchmaking, glove-colour unlocks and the helpers the
// VS card and the results card use (PRG01, PRG02 — research/mechanics.md §7). Pure; runs in Node.
//
// After a single-player bout (integration):
//   const bout = nextBout(profile);                    // {opponent, rating, rematch, reason}
//   …the bout is fought against bout.opponent…
//   const upd  = applyBout(profile, result, { opponent: bout.opponent });
//   const save = storage.recordMatch(profile.id, result, upd, { side: 'p1', opponentName });
//   // results card: upd (or save.summary) = {before, after, delta, pro, becamePro, lostPro, unlocked, …}
//   //               ratingHistory(save.profile, { withStart: true }) feeds the graph (PRO line at 1000)
//   // VS card:      describeBout({ profile, bout }) → {player, opponent, rematch}
// The older calls keep working: skillDelta({result, playerId, opponent, playerSkill}) → integer,
// applySkill(profile, delta), nextOpponent(skill|profile), unlockedOpponents, ladderPosition.
//
// Rules (M = measured in the reference footage, E = our recommendation; §n = research/mechanics.md):
//  * Win (§7.1 fit, §7.5): Δ = round(75 − R/135) − 20·[knocked down ≥ 1] − 35·[knocked down ≥ 2]
//    − 10·[the bout reached round 3], never below −10. R = the player's rating BEFORE the bout.
//    A clean KO at R 816 → +69; one knockdown → +49. As measured, damage taken without a
//    knockdown, the round of the KO and the opponent's rating do not enter the formula.
//  * Loss (E, never observed): −40 by KO (or TKO), −25 on points. Draw (E, never observed): +5 —
//    the player held a higher-rated opponent level over three full rounds: a token gain, far
//    below any clean win (+55…+75) and well above a points loss.
//  * Versus bouts never change the rating (PRG02). The rating never drops below 0.
//  * PRO: a rating of 1000 or more (§7.3: badge at r1017 and r1047, none at r981). Losable: it
//    goes again the moment the rating falls below 1000.
//  * Opponents (§7.2, §7.5). Each roster entry has a base rating (its documented `rating` field,
//    else BASE_RATINGS by ladder position). Each time the player beats an opponent, that
//    opponent's rating for this profile rises by 60–125 (deterministic: seeded by profile,
//    opponent and win number), so rematches come back stronger (r1017 → r1025, r1487 → r1612).
//    Raises stop at the NEXT rung's base + 100 (ratingCap: #1 380 … #9 1700), the champion's at
//    its base + 125 (1725, the reference's pool topped out near 1600, §7.2), so a low-tier style
//    never shows up as a 1600+ opponent. Ratings saved above today's cap are read as the cap.
//  * nextBout(profile) aims at the measured band: the next opponent sits 50–148 above the player
//    (mean +100, §7.2) and rematches are occasional (2 in 26 bouts). In order:
//      1. a brand-new profile meets the first opponent;
//      2. the next unbeaten opponent (ladder order) once rated ≤ R + 150 (after a loss to it: again);
//      3. a rematch: the beaten opponent rated R + 50 … R + 150 nearest R + 100, skipping the
//         opponents met in the last 2 bouts (then only the last one) while another one fits;
//      4. once the player has out-climbed the whole roster (everyone beaten, all rated below
//         R + 50): the top of the ladder takes turns — the highest-rated not met in the last 2
//         bouts, i.e. the champion, #9, #8, the champion … (like the reference's 1572 at 1656);
//      5. otherwise the nearest fit to that band (within 100 of it), still skipping recent ones;
//      6. otherwise a straight rematch in the band (like B14 → B15), else the nearest fit at all.
//    A straight run of clean wins turns PRO at bout 14, unlocks the 1600 colours at bout 24 and
//    meets the champion again every third bout once it has out-climbed the pool (~bout 26).
//  * Glove colours (§7.4, §7.5): GLOVE_UNLOCKS open at 1000 and 1600 — our own colours. They
//    follow the BEST rating ever reached, so losing PRO never takes them away.

import { ROSTER } from './roster.js';

export const PRO_THRESHOLD = 1000;

/** Tunables: rating formula (§7.1/§7.5) and matchmaking (§7.2/§7.5). */
export const SKILL = Object.freeze({
  // win Δ = round(winBase − R / winPerRating) − penalties, never below winMin
  winBase: 75,
  winPerRating: 135,
  knockedDownOnce: 20,    // the player was knocked down at least once
  knockedDownTwice: 35,   // … at least twice (on top of the 20)
  lateRound: 3,           // the bout reached this round …
  lateRoundPenalty: 10,   // … costs this much
  winMin: -10,
  lossKO: -40,            // lost by KO / TKO (E)
  lossDecision: -25,      // lost on points (E)
  draw: 5,                // never observed (E): a token gain for going the distance level
  floor: 0,
  max: 99999,             // = core/storage.js STORAGE_LIMITS.skillMax (wins stop paying near 10 000)
  // matchmaking (§7.2: the next opponent sat 50–148 above the player, mean +100, n = 26)
  nextWithin: 150,        // offer the next unbeaten opponent once its rating ≤ R + 150
  rematchAbove: 50,       // a rematch is rated R + 50 …
  rematchWithin: 150,     // … to R + 150 …
  rematchTarget: 100,     // … and the one nearest R + 100 is picked
  cooldown: 2,            // opponents met in the last 2 bouts are skipped while another one fits
  fitTolerance: 100,      // nothing in the band: the nearest fit within 100 of it (still skipping recent ones)
  rematchRaise: Object.freeze([60, 125]), // rating added to an opponent per win against it
  capAboveNext: 100,      // a beaten opponent's raised rating stops at the next rung's base + this
  ceilingAbove: 125,      // … the champion's at the top roster rating + this (1725): the pool tops out (§7.2)
});

/** Fallback base ratings by ladder position (research/mechanics.md §4.5) when an entry has no `rating`. */
export const BASE_RATINGS = Object.freeze([120, 280, 450, 600, 750, 900, 1050, 1200, 1400, 1600]);

/**
 * Cosmetic glove colours unlocked by rating milestones (§7.4/§7.5). Our own colours, chosen to
 * differ from the regular editor swatches (render/appearance.js GLOVE_COLORS). `at` is compared
 * with the BEST rating ever reached.
 *   Pro Flame    #ff6a00  vivid orange   1000 (PRO)
 *   Pro Emerald  #0ca678  emerald green  1000 (PRO)
 *   Star Cyan    #15d1f0  electric cyan  1600
 *   Royal Violet #6741d9  deep violet    1600
 * @typedef {{id:string, name:string, color:string, at:number}} GloveUnlock
 */
export const GLOVE_UNLOCKS = Object.freeze([
  Object.freeze({ id: 'pro-flame', name: 'Pro Flame', color: '#ff6a00', at: 1000 }),
  Object.freeze({ id: 'pro-emerald', name: 'Pro Emerald', color: '#0ca678', at: 1000 }),
  Object.freeze({ id: 'star-cyan', name: 'Star Cyan', color: '#15d1f0', at: 1600 }),
  Object.freeze({ id: 'royal-violet', name: 'Royal Violet', color: '#6741d9', at: 1600 }),
]);

// ───────────────────────────── small helpers ─────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const MAX_WINS = 10000; // guards loops against corrupt data
const count = (v) => (finite(v) && v > 0 ? Math.min(MAX_WINS, Math.floor(v)) : 0);
const listOf = (roster) => (Array.isArray(roster) ? roster.filter(isObj) : ROSTER);
/** Own property only: an id such as 'toString' must never resolve to an inherited member. */
const own = (o, k) => (isObj(o) && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
/** Opponent ids index plain objects: never let one reach the prototype. */
export const isSafeOpponentId = (id) => typeof id === 'string' && id.length > 0 && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';

/** A rating from a number or a profile (`skill`); invalid → 0. Integer, 0 … SKILL.max. */
export function ratingOf(x) {
  const n = Number(isObj(x) ? x.skill : x);
  return Number.isFinite(n) ? clamp(Math.round(n), SKILL.floor, SKILL.max) : 0;
}

/** PRO = a rating of 1000 or more (§7.3). Takes a number or a profile. */
export function isPro(x) {
  const n = Number(isObj(x) ? x.skill : x);
  return Number.isFinite(n) && n >= PRO_THRESHOLD;
}

/** The best rating a profile ever reached (max of bestRating, skill and its history); a number passes through. */
export function bestRatingOf(x) {
  if (!isObj(x)) return ratingOf(x);
  let best = ratingOf(x);
  if (finite(x.bestRating)) best = Math.max(best, x.bestRating);
  const hist = x.records && x.records.matches && x.records.matches.history;
  if (Array.isArray(hist)) {
    for (const m of hist) {
      if (!isObj(m) || m.mode === 'versus') continue;
      if (finite(m.skillAfter)) best = Math.max(best, m.skillAfter);
      if (finite(m.skillBefore)) best = Math.max(best, m.skillBefore);
    }
  }
  return clamp(Math.round(best), SKILL.floor, SKILL.max);
}

/** Stable seed for one boxer across devices: a portable copy keeps its source id. */
export function profileKey(profile) {
  if (!isObj(profile)) return 'anon';
  const k = profile.sourceId || profile.id;
  return typeof k === 'string' && k ? k : 'anon';
}

/** 32-bit string hash (FNV-1a + murmur3 finaliser). Local on purpose: saved ratings depend on it. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ───────────────────────────── rating changes (§7.1, §7.5) ─────────────────────────────

/** Rating gain for a single-player WIN at rating R (before the bout). */
export function winDelta(rating, { knockdowns = 0, endRound = 1 } = {}) {
  const R = ratingOf(rating);
  const kd = count(knockdowns);
  let d = Math.round(SKILL.winBase - R / SKILL.winPerRating);
  if (kd >= 1) d -= SKILL.knockedDownOnce;
  if (kd >= 2) d -= SKILL.knockedDownTwice;
  if (Number(endRound) >= SKILL.lateRound) d -= SKILL.lateRoundPenalty;
  return Math.max(SKILL.winMin, d) || 0; // `|| 0` turns −0 into 0
}

const isKoMethod = (m) => m === 'KO' || m === 'TKO';

/** Rating change for a single-player LOSS (by KO/TKO or on points). */
export function lossDelta(method) {
  return isKoMethod(method) ? SKILL.lossKO : SKILL.lossDecision;
}

/** Knockdowns `side` suffered: result.knockdowns[side], else the other corner's knockdownsScored. */
function knockdownsSuffered(result, side) {
  const k = result.knockdowns;
  if (isObj(k) && finite(k[side])) return count(k[side]);
  const foe = side === 'p1' ? 'p2' : 'p1';
  const st = result.stats && result.stats[foe];
  return isObj(st) ? count(st.knockdownsScored) : 0;
}

/**
 * Rating change for one player after a match (integer). Reads result.mode, winner, method,
 * knockdowns (or stats[foe].knockdownsScored) and endRound. 0 for versus or a missing result.
 * @param {Object} a
 * @param {import('../core/types.js').MatchResult} a.result
 * @param {'p1'|'p2'} [a.playerId]
 * @param {Object|null} [a.opponent]   accepted for compatibility; the measured formula ignores it
 * @param {number} [a.playerSkill]     the player's rating before the bout
 */
export function skillDelta({ result, playerId = 'p1', opponent = null, playerSkill = 0 } = {}) { // eslint-disable-line no-unused-vars
  if (!isObj(result) || result.mode === 'versus') return 0; // PRG02
  const me = playerId === 'p2' ? 'p2' : 'p1';
  const foe = me === 'p1' ? 'p2' : 'p1';
  if (result.winner === me) return winDelta(playerSkill, { knockdowns: knockdownsSuffered(result, me), endRound: result.endRound });
  if (result.winner === foe) return lossDelta(result.method);
  return SKILL.draw;
}

/**
 * Apply a delta to a profile-like object ({skill, pro?, bestRating?, records?}). Never mutates it.
 * @returns {{skill:number, pro:boolean, becamePro:boolean, lostPro:boolean, delta:number, before:number,
 *            after:number, bestBefore:number, bestRating:number, bestAfter:number, unlocked:GloveUnlock[]}}
 */
export function applySkill(profile, delta) {
  const before = ratingOf(profile);
  const wasPro = isObj(profile) && typeof profile.pro === 'boolean' ? profile.pro : isPro(before);
  const skill = clamp(Math.round(before + (Number(delta) || 0)), SKILL.floor, SKILL.max);
  const pro = isPro(skill);
  const bestBefore = bestRatingOf(profile);
  const bestRating = Math.max(bestBefore, skill);
  return {
    skill, pro, becamePro: pro && !wasPro, lostPro: wasPro && !pro, delta: skill - before, before, after: skill,
    bestBefore, bestRating, bestAfter: bestRating, unlocked: gloveUnlocksBetween(bestBefore, bestRating),
  };
}

// ───────────────────────────── opponents' ratings ─────────────────────────────

function resolveDef(defOrId, roster) {
  if (typeof defOrId === 'string') return roster.find((d) => d.id === defOrId) || null;
  return isObj(defOrId) ? defOrId : null;
}

/**
 * An opponent's base rating: the roster entry's documented `rating`, else BASE_RATINGS by ladder
 * position (or by `tier` for an entry outside the roster). null for an unknown opponent.
 */
export function baseRating(defOrId, roster = ROSTER) {
  const list = listOf(roster);
  const def = resolveDef(defOrId, list);
  if (!def) return null;
  if (finite(def.rating)) return Math.max(0, Math.round(def.rating));
  let i = list.indexOf(def);
  if (i < 0 && def.id != null) i = list.findIndex((d) => d.id === def.id);
  if (i >= 0 && finite(list[i].rating)) return Math.max(0, Math.round(list[i].rating));
  if (i < 0 && finite(def.tier) && def.tier >= 1) i = Math.round(def.tier) - 1;
  if (i < 0) return null;
  if (i < BASE_RATINGS.length) return BASE_RATINGS[i];
  return BASE_RATINGS[BASE_RATINGS.length - 1] + 200 * (i - BASE_RATINGS.length + 1);
}

/** The player rating from which an unbeaten opponent can be offered (base − 150, ≥ 0). */
export function reachRating(defOrId, roster = ROSTER) {
  const b = baseRating(defOrId, roster);
  return b == null ? Infinity : Math.max(0, b - SKILL.nextWithin);
}

/** Rating added to an opponent when this profile beats it for the `winNumber`-th time (60–125, deterministic). */
export function rematchRaise(key, opponentId, winNumber) {
  const [lo, hi] = SKILL.rematchRaise;
  return lo + (hash32(`${key}|${opponentId}|${count(winNumber)}`) % (hi - lo + 1));
}

/** The most any opponent's rating can be raised to: the top base rating in the roster + 125 (1725). */
export function ratingCeiling(roster = ROSTER) {
  const list = listOf(roster);
  let top = 0;
  for (const d of list) {
    const b = baseRating(d, list);
    if (b != null && b > top) top = b;
  }
  return Math.min(SKILL.max, top + SKILL.ceilingAbove);
}

/**
 * The most this opponent's rating can be raised to: the next rung's base + 100 (#1 → 380 … #9 →
 * 1700), the champion's (and anyone outside the roster) the ceiling (1725); never below its own
 * base. A low-tier style never shows up rated like the top of the ladder. null for an unknown opponent.
 */
export function ratingCap(defOrId, roster = ROSTER) {
  const list = listOf(roster);
  const def = resolveDef(defOrId, list);
  const base = baseRating(def || defOrId, list);
  if (base == null) return null;
  const ceiling = Math.max(base, ratingCeiling(list));
  let i = def ? list.indexOf(def) : -1;
  if (i < 0 && def && def.id != null) i = list.findIndex((d) => d.id === def.id);
  const next = i >= 0 && i + 1 < list.length ? baseRating(list[i + 1], list) : null;
  return next == null ? ceiling : clamp(next + SKILL.capAboveNext, base, ceiling);
}

/** One raise: +60…125, never above the cap, never lowering a rating already above it. */
function raised(rating, key, opponentId, winNumber, cap) {
  return Math.max(rating, Math.min(rating + rematchRaise(key, opponentId, winNumber), cap));
}

/** An opponent's rating after `wins` wins by the profile `key`: base + every raise (capped). null if unknown. */
export function ratingAfterWins(key, defOrId, wins, roster = ROSTER) {
  const list = listOf(roster);
  const def = resolveDef(defOrId, list);
  const id = def ? def.id : typeof defOrId === 'string' ? defOrId : null;
  let r = baseRating(def, list);
  if (r == null || id == null) return null;
  const cap = ratingCap(def, list) ?? ratingCeiling(list);
  const n = count(wins);
  for (let k = 1; k <= n && r < cap; k++) r = raised(r, key, id, k, cap);
  return r;
}

/**
 * Per-opponent progress of one profile (profile.opponents[id] in core/storage.js).
 * `rating` is that opponent's raised rating for this profile; null = still its base rating.
 * @typedef {{wins:number, losses:number, draws:number, beaten:boolean, rating:number|null}} OpponentState
 */

/** @returns {OpponentState} */
export function emptyOpponentState() {
  return { wins: 0, losses: 0, draws: 0, beaten: false, rating: null };
}

/** Validate one OpponentState; null if it is not an object. */
export function sanitizeOpponentState(s) {
  if (!isObj(s)) return null;
  const wins = count(s.wins);
  const beaten = s.beaten === true || wins > 0;
  const rating = beaten && finite(s.rating) ? clamp(Math.round(s.rating), 0, SKILL.max) : null;
  return { wins, losses: count(s.losses), draws: count(s.draws), beaten, rating };
}

/** Rebuild per-opponent states from a match history (single-player entries, oldest first) — old profiles. */
export function deriveOpponentStates(history, key = 'anon', roster = ROSTER) {
  /** @type {Record<string, OpponentState>} */
  const out = {};
  for (const m of Array.isArray(history) ? history : []) {
    if (!isObj(m) || m.mode === 'versus' || !isSafeOpponentId(m.opponentId)) continue;
    const st = own(out, m.opponentId) || (out[m.opponentId] = emptyOpponentState());
    if (m.outcome === 'win') { st.wins++; st.beaten = true; }
    else if (m.outcome === 'loss') st.losses++;
    else st.draws++;
  }
  for (const [id, st] of Object.entries(out)) st.rating = st.wins > 0 ? ratingAfterWins(key, id, st.wins, roster) : null;
  return out;
}

/** Per-opponent states of a profile: profile.opponents (validated), else derived from its match history. */
export function opponentStates(profile, roster = ROSTER) {
  if (!isObj(profile)) return {};
  if (isObj(profile.opponents)) {
    const out = {};
    for (const [id, s] of Object.entries(profile.opponents)) {
      const st = isSafeOpponentId(id) ? sanitizeOpponentState(s) : null;
      if (st) out[id] = st;
    }
    return out;
  }
  const hist = profile.records && profile.records.matches && profile.records.matches.history;
  return deriveOpponentStates(hist, profileKey(profile), roster);
}

function stateRating(st, key, defOrId, roster) {
  const wins = Math.max(st.wins, st.beaten ? 1 : 0);
  if (wins > 0 && finite(st.rating)) {
    // a rating saved above today's cap (older saves raised everyone towards 1725) reads as the cap
    const cap = ratingCap(defOrId, roster);
    return cap == null ? st.rating : Math.min(st.rating, cap);
  }
  return wins > 0 ? ratingAfterWins(key, defOrId, wins, roster) : baseRating(defOrId, roster);
}

/**
 * An opponent's current rating: for a profile, raised by every win against it; without a
 * profile, its base rating. null for an opponent outside the roster without `rating`/`tier`.
 */
export function opponentRating(defOrId, profile = null, roster = ROSTER) {
  const list = listOf(roster);
  const def = resolveDef(defOrId, list);
  const id = def ? def.id : typeof defOrId === 'string' ? defOrId : null;
  if (!isObj(profile) || !isSafeOpponentId(id)) return baseRating(def || defOrId, list);
  const st = own(opponentStates(profile, list), id);
  return st ? stateRating(st, profileKey(profile), def || id, list) : baseRating(def || id, list);
}

/**
 * One bout's effect on an opponent's state (shared by applyBout and core/storage.js recordMatch,
 * so the preview and the saved value always agree). A win raises the opponent's rating.
 * @param {OpponentState|null|undefined} state
 * @param {{key?:string, opponentId:string, outcome:'win'|'loss'|'draw', roster?:Object[]}} o
 * @returns {{state:OpponentState, ratingBefore:number|null, ratingAfter:number|null, rematch:boolean}}
 */
export function opponentAfterBout(state, { key = 'anon', opponentId, outcome, roster = ROSTER } = {}) {
  const st = sanitizeOpponentState(state) || emptyOpponentState();
  const ratingBefore = stateRating(st, key, opponentId, roster);
  const next = { ...st };
  if (outcome === 'win') {
    next.wins = Math.max(st.wins, st.beaten ? 1 : 0) + 1;
    next.beaten = true;
    next.rating = ratingBefore == null ? null : raised(ratingBefore, key, opponentId, next.wins, ratingCap(opponentId, roster) ?? ratingCeiling(roster));
  } else {
    if (outcome === 'loss') next.losses++;
    else next.draws++;
    next.rating = next.beaten ? ratingBefore : null;
  }
  const ratingAfter = next.beaten ? next.rating : ratingBefore;
  return { state: next, ratingBefore, ratingAfter, rematch: st.beaten };
}

// ───────────────────────────── matchmaking (§7.2, §7.5) ─────────────────────────────

/** True for a profile that has never finished a single-player bout and is still rated 0. */
export function isNewProfile(profile) {
  if (!isObj(profile)) return ratingOf(profile) === 0;
  const m = profile.records && profile.records.matches;
  const played = isObj(m) && (count(m.wins) + count(m.losses) + count(m.draws) > 0
    || (Array.isArray(m.history) && m.history.some((h) => isObj(h) && h.mode !== 'versus')));
  const beatenAny = isObj(profile.opponents) && Object.values(profile.opponents).some((s) => isObj(s) && (s.beaten === true || count(s.wins) > 0));
  return !played && !beatenAny && ratingOf(profile) === 0;
}

/** Should this profile's next single-player bout start with the first-bout tutorial (§8)? */
export function needsTutorial(profile) {
  if (!isObj(profile) || profile.tutorialDone === true) return false;
  const m = profile.records && profile.records.matches;
  const played = isObj(m) && (count(m.wins) + count(m.losses) + count(m.draws) > 0
    || (Array.isArray(m.history) && m.history.some((h) => isObj(h) && h.mode !== 'versus')));
  return !played;
}

/**
 * @typedef {Object} Bout
 * @property {Object|null} opponent   roster entry
 * @property {number|null} rating     the opponent's rating for this bout (raised for a rematch)
 * @property {boolean} rematch        the player has beaten this opponent before
 * @property {'first'|'next'|'rematch'|'fallback'|'none'} reason
 * @property {number} index           ladder position (0-based)
 * @property {number} wins            times the player has beaten this opponent
 * @property {number|null} base       the opponent's base rating
 */

/**
 * Opponent ids of a profile's last `n` single-player bouts, oldest first (from its match history).
 * @returns {string[]}
 */
export function recentOpponents(profile, n = SKILL.cooldown) {
  const hist = isObj(profile) && profile.records && profile.records.matches && profile.records.matches.history;
  const out = [];
  const want = Math.max(0, Math.floor(Number(n) || 0));
  if (!Array.isArray(hist) || !want) return out;
  for (let i = hist.length - 1; i >= 0 && out.length < want; i--) {
    const m = hist[i];
    if (isObj(m) && m.mode !== 'versus' && typeof m.opponentId === 'string') out.unshift(m.opponentId);
  }
  return out;
}

/**
 * Who the player meets next (§7.2, §7.5 — the order is documented at the top of this file):
 * the first opponent for a brand-new profile; the next unbeaten opponent once rated ≤ R + 150;
 * else the beaten opponent rated R + 50 … R + 150 nearest R + 100 that was not met in the last
 * two bouts; once the whole roster is out-climbed, the top three in turn (the champion first);
 * else the nearest fit. `reason`: 'next' (always ≤ R + 150), 'rematch' (always inside the band),
 * else 'fallback'. A bare number is treated statelessly (as if every opponent below had been
 * beaten) and returns nextOpponent(number).
 * @param {Object|number|null} profile
 * @param {{roster?: Object[]}} [opts]
 * @returns {Bout}
 */
export function nextBout(profile = null, { roster = ROSTER } = {}) {
  const list = listOf(roster);
  if (!list.length) return { opponent: null, rating: null, rematch: false, reason: 'none', index: -1, wins: 0, base: null };
  if (!isObj(profile)) {
    const opp = nextOpponent(ratingOf(profile), { roster: list });
    const b = baseRating(opp, list);
    return { opponent: opp, rating: b, rematch: false, reason: ratingOf(profile) === 0 ? 'first' : 'next', index: list.indexOf(opp), wins: 0, base: b };
  }
  const R = ratingOf(profile);
  const key = profileKey(profile);
  const states = opponentStates(profile, list);
  const rows = list.map((def, index) => {
    const st = own(states, def.id) || null;
    const base = baseRating(def, list);
    const wins = st ? Math.max(st.wins, st.beaten ? 1 : 0) : 0;
    const rating = st ? stateRating(st, key, def, list) : base;
    return { def, index, base, wins, beaten: wins > 0, rating: finite(rating) ? rating : 0 };
  });
  const pick = (row, reason) => ({
    opponent: row.def, rating: row.rating, rematch: row.beaten, reason, index: row.index, wins: row.wins, base: row.base,
  });
  if (isNewProfile(profile)) return pick(rows[0], 'first');
  const cool = Math.max(0, Math.floor(SKILL.cooldown));
  const recent = recentOpponents(profile, cool);
  const metWithin = (row, n) => n > 0 && recent.slice(-n).includes(row.def.id);
  const lo = R + SKILL.rematchAbove, hi = R + SKILL.rematchWithin, target = R + SKILL.rematchTarget;
  const nearTarget = (a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target) || b.rating - a.rating || b.index - a.index;
  const off = (r) => (r.rating < lo ? lo - r.rating : r.rating > hi ? r.rating - hi : 0);
  const nearest = (a, b) => off(a) - off(b) || nearTarget(a, b);
  // 1. the next rung of the ladder once within reach (after a loss to it: straight back in)
  const unbeaten = rows.find((r) => !r.beaten) || null;
  if (unbeaten && unbeaten.rating <= R + SKILL.nextWithin) return pick(unbeaten, 'next');
  // 2. a rematch inside the measured band, nearest R + 100, not an opponent just met
  const band = rows.filter((r) => r.beaten && r.rating >= lo && r.rating <= hi);
  for (let n = cool; n >= 1; n--) {
    const c = band.filter((r) => !metWithin(r, n)).sort(nearTarget);
    if (c.length) return pick(c[0], 'rematch');
  }
  const open = rows.filter((r) => r.beaten || r === unbeaten);
  // 3. the whole roster is beaten and rated below the band: the top of the ladder takes turns
  if (!unbeaten && open.every((r) => r.rating < lo)) {
    const c = open.filter((r) => !metWithin(r, cool)).sort((a, b) => b.rating - a.rating || b.index - a.index);
    if (c.length) return pick(c[0], 'fallback');
  }
  // 4. the nearest fit to the band (within fitTolerance), still not an opponent just met
  for (let n = cool; n >= 1; n--) {
    const c = open.filter((r) => !metWithin(r, n) && off(r) <= SKILL.fitTolerance).sort(nearest);
    if (c.length) return pick(c[0], 'fallback');
  }
  // 5. only the opponent just met fits: a straight rematch, as the reference did (B14 → B15)
  if (band.length) return pick(band.sort(nearTarget)[0], 'rematch');
  // 6. anything left: the nearest fit, preferring one not met last
  const any = open.filter((r) => !metWithin(r, 1)).sort(nearest);
  return pick(any[0] || open.sort(nearest)[0] || rows[0], 'fallback');
}

/**
 * The next opponent (PRG01). With a profile: nextBout(profile).opponent. With a bare rating
 * (stateless — e.g. a menu label): the toughest opponent rated ≤ rating + 150, i.e. the one met
 * next by a player who has beaten everyone below.
 */
export function nextOpponent(skillOrProfile, { roster = ROSTER } = {}) {
  const list = listOf(roster);
  if (isObj(skillOrProfile)) return nextBout(skillOrProfile, { roster: list }).opponent;
  const s = ratingOf(skillOrProfile);
  let pick = list[0] || null;
  for (const d of list) if (reachRating(d, list) <= s) pick = d;
  return pick;
}

/**
 * Opponents open to this player. Rating: every opponent rated ≤ rating + 150. Profile: the ones
 * already beaten plus the next unbeaten one when it is within reach (the first one for a new profile).
 */
export function unlockedOpponents(skillOrProfile, { roster = ROSTER } = {}) {
  const list = listOf(roster);
  if (!isObj(skillOrProfile)) {
    const s = ratingOf(skillOrProfile);
    return list.filter((d, i) => i === 0 || reachRating(d, list) <= s);
  }
  const states = opponentStates(skillOrProfile, list);
  const beat = (d) => { const s = own(states, d.id); return !!(s && (s.beaten || s.wins > 0)); };
  const R = ratingOf(skillOrProfile);
  const next = list.find((d) => !beat(d));
  return list.filter((d) => beat(d) || (d === next && (d === list[0] || (baseRating(d, list) ?? Infinity) <= R + SKILL.nextWithin)));
}

/** Where a rating sits on the ladder: the opponent met next, the one after it and progress (0..1) towards it. */
export function ladderPosition(skillOrProfile, { roster = ROSTER } = {}) {
  const list = listOf(roster);
  const s = ratingOf(skillOrProfile);
  const current = isObj(skillOrProfile) ? nextBout(skillOrProfile, { roster: list }).opponent : nextOpponent(s, { roster: list });
  const i = list.indexOf(current);
  const next = i >= 0 ? list[i + 1] || null : null;
  let progress01 = 1;
  if (next) {
    const a = reachRating(current, list), b = reachRating(next, list);
    progress01 = Number.isFinite(a) && Number.isFinite(b) ? clamp((s - a) / Math.max(1, b - a), 0, 1) : 0;
  }
  return { current, next, progress01, pro: isPro(s), rating: s };
}

// ───────────────────────────── cosmetics (§7.4) ─────────────────────────────

/** Glove colours unlocked by a profile (its best rating ever) or a rating. */
export function unlockedGloveColors(profileOrRating) {
  const best = bestRatingOf(profileOrRating);
  return GLOVE_UNLOCKS.filter((u) => best >= u.at);
}

/** Glove colours still locked for a profile / rating. */
export function lockedGloveColors(profileOrRating) {
  const best = bestRatingOf(profileOrRating);
  return GLOVE_UNLOCKS.filter((u) => best < u.at);
}

/** Glove colours that open when the best rating goes from `bestBefore` to `bestAfter`. */
export function gloveUnlocksBetween(bestBefore, bestAfter) {
  const a = Number(bestBefore) || 0, b = Number(bestAfter) || 0;
  return GLOVE_UNLOCKS.filter((u) => a < u.at && b >= u.at);
}

/** The unlock entry for a glove colour (hex, any case), or null for an ordinary colour. */
export function gloveUnlockFor(color) {
  const c = String(color || '').toLowerCase();
  return GLOVE_UNLOCKS.find((u) => u.color === c) || null;
}

/** May this profile / rating wear this glove colour? Ordinary colours always; unlock colours once earned. */
export function isGloveColorAllowed(profileOrRating, color) {
  const u = gloveUnlockFor(color);
  return !u || bestRatingOf(profileOrRating) >= u.at;
}

// ───────────────────────────── results card / VS card helpers ─────────────────────────────

/**
 * Everything one single-player bout changes, computed before saving (the same numbers
 * core/storage.js recordMatch then stores). Pass the returned object to storage.recordMatch as
 * its skillUpdate. Versus: delta 0 and no opponent change.
 * @returns {ReturnType<typeof applySkill> & {opponent: null|{id:string, ratingBefore:number|null,
 *           ratingAfter:number|null, rematch:boolean, beaten:boolean, wins:number, losses:number, draws:number}}}
 */
export function applyBout(profile, result, { playerId = 'p1', opponent = null, roster = ROSTER } = {}) {
  const list = listOf(roster);
  const delta = skillDelta({ result, playerId, opponent, playerSkill: ratingOf(profile) });
  const upd = applySkill(profile, delta);
  let opp = null;
  const single = isObj(result) && result.mode !== 'versus';
  const oid = single ? (typeof result.opponentId === 'string' && result.opponentId) || (isObj(opponent) && opponent.id) || null : null;
  if (isSafeOpponentId(oid)) {
    const me = playerId === 'p2' ? 'p2' : 'p1';
    const outcome = result.winner === me ? 'win' : (result.winner === 'p1' || result.winner === 'p2') ? 'loss' : 'draw';
    const r = opponentAfterBout(own(opponentStates(profile, list), oid), { key: profileKey(profile), opponentId: oid, outcome, roster: list });
    opp = { id: oid, ratingBefore: r.ratingBefore, ratingAfter: r.ratingAfter, rematch: r.rematch, ...r.state };
  }
  return { ...upd, opponent: opp };
}

/**
 * Results-card numbers {before, after, delta, pro, becamePro, lostPro, bestBefore, bestAfter, unlocked}.
 *   resultsSummary(profileBefore, profileAfter)  — two profile snapshots (or two ratings)
 *   resultsSummary(update)                       — an applySkill() / applyBout() result
 */
export function resultsSummary(from, to) {
  if (to === undefined && isObj(from) && finite(from.before) && finite(from.skill)) {
    const u = from;
    const bestBefore = finite(u.bestBefore) ? u.bestBefore : u.before;
    const bestAfter = finite(u.bestRating) ? u.bestRating : Math.max(bestBefore, u.skill);
    return {
      before: u.before, after: u.skill, delta: u.skill - u.before, pro: isPro(u.skill), becamePro: !!u.becamePro, lostPro: !!u.lostPro,
      bestBefore, bestAfter, unlocked: Array.isArray(u.unlocked) ? u.unlocked : gloveUnlocksBetween(bestBefore, bestAfter),
    };
  }
  const before = ratingOf(from), after = ratingOf(to);
  const wasPro = isObj(from) && typeof from.pro === 'boolean' ? from.pro : isPro(before);
  const pro = isPro(after);
  const bestBefore = bestRatingOf(from);
  const bestAfter = Math.max(bestBefore, bestRatingOf(to));
  return {
    before, after, delta: after - before, pro, becamePro: pro && !wasPro, lostPro: wasPro && !pro,
    bestBefore, bestAfter, unlocked: gloveUnlocksBetween(bestBefore, bestAfter),
  };
}

/**
 * Rating history for the results-card graph, oldest first, derived from the profile's match
 * history (single-player bouts only; core/storage.js keeps the last 50 of them).
 * { withStart: true } prepends the rating before the first listed bout (usually 0) as a
 * `start` point, so the line begins where the boxer began.
 * @returns {Array<{id:string|null, t:number, rating:number, before:number, delta:number, opponentId:string|null,
 *           opponentName:string|null, opponentRating:number|null, method:string|null, outcome:string|null,
 *           won:boolean, rematch:boolean, pro:boolean, start?:true}>}
 */
export function ratingHistory(profile, { limit = 50, withStart = false } = {}) {
  const hist = isObj(profile) && profile.records && profile.records.matches && Array.isArray(profile.records.matches.history)
    ? profile.records.matches.history : [];
  const rows = [];
  for (const m of hist) {
    if (!isObj(m) || m.mode === 'versus' || !finite(m.skillAfter)) continue;
    const before = finite(m.skillBefore) ? m.skillBefore : m.skillAfter - (finite(m.delta) ? m.delta : 0);
    rows.push({
      id: typeof m.id === 'string' ? m.id : null, t: finite(m.t) ? m.t : 0, rating: m.skillAfter, before,
      delta: finite(m.delta) ? m.delta : m.skillAfter - before,
      opponentId: typeof m.opponentId === 'string' ? m.opponentId : null,
      opponentName: typeof m.opponentName === 'string' ? m.opponentName : null,
      opponentRating: finite(m.opponentRating) ? m.opponentRating : null,
      method: typeof m.method === 'string' ? m.method : null, outcome: typeof m.outcome === 'string' ? m.outcome : null,
      won: m.outcome === 'win', rematch: m.rematch === true, pro: isPro(m.skillAfter),
    });
  }
  const n = Math.max(1, Math.floor(Number(limit) || 50));
  const out = rows.slice(-n);
  if (withStart && out.length) {
    const first = out[0];
    out.unshift({
      id: null, t: isObj(profile) && finite(profile.createdAt) ? Math.min(profile.createdAt, first.t || profile.createdAt) : first.t,
      rating: first.before, before: first.before, delta: 0, opponentId: null, opponentName: null, opponentRating: null,
      method: null, outcome: null, won: false, rematch: false, pro: isPro(first.before), start: true,
    });
  }
  return out;
}

/**
 * VS-card data: each side's name, rating and PRO badge (§5: badge at 1000 or more).
 * `bout` is a nextBout() result (or a roster entry); omitted → nextBout(profile).
 * @returns {{player:{id:string|null, name:string, rating:number, pro:boolean},
 *            opponent:null|{id:string, name:string, nickname:string|null, rating:number|null, pro:boolean},
 *            rematch:boolean, reason:string|null}}
 */
export function describeBout({ profile = null, bout = null } = {}) {
  let b = bout;
  if (isObj(b) && !isObj(b.opponent) && typeof b.id === 'string') b = { opponent: b };
  if (!isObj(b) || !isObj(b.opponent)) b = nextBout(profile);
  const opp = b.opponent || null;
  const oppRating = finite(b.rating) ? b.rating : opp ? opponentRating(opp, profile) : null;
  let rematch = typeof b.rematch === 'boolean' ? b.rematch : false;
  if (typeof b.rematch !== 'boolean' && opp && isObj(profile)) {
    const st = own(opponentStates(profile), opp.id);
    rematch = !!(st && st.beaten);
  }
  const R = ratingOf(profile);
  return {
    player: { id: isObj(profile) && typeof profile.id === 'string' ? profile.id : null, name: isObj(profile) && profile.name ? String(profile.name) : 'You', rating: R, pro: isPro(R) },
    opponent: opp ? { id: opp.id, name: opp.name, nickname: opp.nickname || null, rating: oppRating, pro: isPro(oppRating) } : null,
    rematch,
    reason: typeof b.reason === 'string' ? b.reason : null,
  };
}
