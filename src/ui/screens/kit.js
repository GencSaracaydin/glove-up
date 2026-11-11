// UI kit shared by ui.js, hud.js and every screen.
//
//  * Pure helpers (formatting, result wording, spatial navigation, hit testing, graphs,
//    pose visibility / guard heuristics, appearance swatches). Unit-tested in Node
//    (tests/unit/ui-kit.test.mjs) — nothing here touches the DOM at import time.
//  * Tiny DOM builders (h, svg, icon, button, cycler, slider, toggle, segmented). They only
//    touch `document` when called.
//
// Interactive elements built here carry `data-cursor` (the control's id for focus, keyboard navigation
// and Ev.UI_CLICK — a historical name from the removed hand pointer) and an `__guAction` handler that
// ui.js invokes for mouse / touch and keyboard activations.

import { LM, Medal, ResultMethod, APPEARANCE_OPTIONS } from '../../core/types.js';
import { medalRank, betterMedal, sanitizeAppearance, DEFAULT_APPEARANCE } from '../../core/storage.js';
import * as AppearanceKit from '../../render/appearance.js';

export { medalRank, betterMedal };

/** UI feel tunables (documented; every screen reads these). */
export const UI_TUNING = Object.freeze({
  /** Ignore activations for this long after a screen appears (stray clicks / gestures). */
  armDelayMs: 350,
  /** After a fight (result / skill / training-result) the hands are up: arm buttons later (MAT04). */
  postFightArmDelayMs: 1400,
  /** Screen enter/leave transition (ms). */
  transitionMs: 260,
  /** ERR02: the tracking-lost card carries on by itself this long after the player's hands are seen again
   *  (user request 2026-11-10; it used to wait for a 2 s guard hold). */
  lostResumeMs: 500,
  /** Toast lifetime (ms). */
  toastMs: 3600,
  /** A landmark counts as visible above this visibility. */
  visibleAt: 0.5,
  /** Minimum player size (shoulder width as a fraction of frame width) — smaller = too far. */
  minShoulderWidth: 0.07,
  /** Maximum player size — bigger = too close (hands will leave the frame when punching). */
  maxShoulderWidth: 0.42,
  /** Camera check: how long a player must be fully in view in a row before "ready" (ms). Once ready they
   *  stay ready on that screen even out of the picture (they step to the computer to click Continue). */
  readyHoldMs: 2000,
});

// ───────────────────────────── formatting ─────────────────────────────

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(Number.isFinite(v) ? v : 0, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Round clock "m:ss". Counts down with ceil so 0:00 only shows when time is truly up. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Thousands separators, integers. */
export function formatNumber(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? `−${s}` : s;
}

/** "+42", "−15" (true minus sign), "±0". */
export function formatSigned(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  if (v === 0) return '±0';
  return v > 0 ? `+${formatNumber(v)}` : `−${formatNumber(-v)}`;
}

/** Integer percentage a/b (0 when b is 0). */
export function percent(a, b) {
  return b > 0 && Number.isFinite(a) ? Math.round((100 * a) / b) : 0;
}

/** "1 knockdown" / "2 knockdowns". */
export function plural(n, word, pluralWord = word + 's') {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Human label for an option value: 'flat-top' → 'Flat top'. */
export function optionLabel(value) {
  const special = { none: 'None', 'flat-top': 'Flat top', mouthguard: 'Mouthguard', 'gritted': 'Gritted teeth' };
  if (special[value]) return special[value];
  const s = String(value ?? '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Ordinal "1st", "2nd", … */
export function ordinal(n) {
  const v = Math.abs(Math.round(n)) % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${Math.round(n)}${suf}`;
}

// ───────────────────────────── results (MAT04) ─────────────────────────────

/** Count judges' votes. kind: 'unanimous' | 'majority' | 'split' | 'draw' | 'none'. */
export function judgesSummary(scorecards) {
  const cards = Array.isArray(scorecards) ? scorecards.filter((c) => c && Number.isFinite(c.p1) && Number.isFinite(c.p2)) : [];
  let p1 = 0, p2 = 0, even = 0;
  for (const c of cards) {
    if (c.p1 > c.p2) p1++;
    else if (c.p2 > c.p1) p2++;
    else even++;
  }
  let kind = 'none';
  if (cards.length) {
    if (p1 === p2) kind = 'draw';
    else if ((p1 === cards.length) || (p2 === cards.length)) kind = 'unanimous';
    else if (Math.min(p1, p2) === 0) kind = 'majority';
    else kind = 'split';
  }
  const winner = p1 > p2 ? 'p1' : p2 > p1 ? 'p2' : null;
  return { p1, p2, even, total: cards.length, kind, winner };
}

/**
 * Headline + sub line for a finished match.
 * @param {import('../../core/types.js').MatchResult} result
 * @param {{names?:{p1:string,p2:string}, humanSide?:'p1'|'p2'|null}} [opts]
 *        humanSide: single player → 'p1' ("YOU WIN!"); versus → null (names used)
 * @returns {{headline:string, sub:string, outcome:'win'|'loss'|'draw'|null, winner:'p1'|'p2'|null, method:string, methodShort:string}}
 */
export function describeResult(result, opts = {}) {
  const r = result || {};
  const names = { p1: opts.names?.p1 || 'P1', p2: opts.names?.p2 || 'P2' };
  const winner = r.winner === 'p1' || r.winner === 'p2' ? r.winner : null;
  const loser = winner === 'p1' ? 'p2' : winner === 'p2' ? 'p1' : null;
  const human = opts.humanSide === 'p1' || opts.humanSide === 'p2' ? opts.humanSide : null;
  // Older saved results may say TKO; there is no TKO any more (research/mechanics.md §3.4) — it reads as a KO.
  const method = r.method === ResultMethod.TKO ? ResultMethod.KO : r.method;
  const round = Number.isFinite(r.endRound) && r.endRound > 0 ? r.endRound : null;
  const clock = Number.isFinite(r.endClockMs) ? formatClock(r.endClockMs) : null;
  const when = round ? ` in round ${round}${clock ? ` (${clock} on the clock)` : ''}` : '';
  let methodShort = 'Decision';
  let sub;
  if (method === ResultMethod.KO) {
    methodShort = 'KO';
    sub = winner ? `${names[loser]} couldn’t beat the count${when}.` : `Knockout${when}.`;
  } else if (method === ResultMethod.DRAW || (!winner && method === ResultMethod.DECISION)) {
    methodShort = 'Draw';
    const j = judgesSummary(r.scorecards);
    sub = j.total ? `The judges couldn’t split them (${j.p1}–${j.p2}${j.even ? `, ${j.even} even` : ''}).` : 'Nobody could be separated after the final bell.';
  } else {
    const j = judgesSummary(r.scorecards);
    methodShort = j.kind === 'split' ? 'Split decision' : j.kind === 'majority' ? 'Majority decision' : j.kind === 'unanimous' ? 'Unanimous decision' : 'Decision';
    sub = j.total ? `${methodShort} on the judges’ cards (${Math.max(j.p1, j.p2)}–${Math.min(j.p1, j.p2)}).` : 'Won on points after the final bell.';
  }
  let headline;
  let outcome = null;
  if (!winner) {
    headline = 'DRAW!';
    outcome = human ? 'draw' : null;
  } else if (human) {
    outcome = winner === human ? 'win' : 'loss';
    headline = outcome === 'win' ? 'YOU WIN!' : 'YOU LOSE';
  } else {
    headline = `${names[winner].toUpperCase()} WINS!`;
  }
  return { headline, sub, outcome, winner, method: method || ResultMethod.DECISION, methodShort };
}

/**
 * Decision reveal: the decision type and each judge's totals (no punch stats).
 * Uses result.decisionType when the match provides it, else counts the cards.
 * @returns {{kind:'unanimous'|'majority'|'split'|'draw'|'none', label:string, winner:'p1'|'p2'|null,
 *            cards: Array<{judge:string, p1:number, p2:number, winner:'p1'|'p2'|null}>}}
 */
export function decisionReveal(result) {
  const r = result || {};
  const raw = Array.isArray(r.scorecards) ? r.scorecards.filter((c) => c && Number.isFinite(c.p1) && Number.isFinite(c.p2)) : [];
  const j = judgesSummary(raw);
  const kinds = ['unanimous', 'majority', 'split', 'draw'];
  let kind = kinds.includes(r.decisionType) ? r.decisionType : j.kind;
  const winner = r.winner === 'p1' || r.winner === 'p2' ? r.winner : null;
  if (!winner && raw.length) kind = 'draw';
  const label = { unanimous: 'Unanimous decision', majority: 'Majority decision', split: 'Split decision', draw: 'Draw', none: 'Decision' }[kind] || 'Decision';
  const cards = raw.map((c, i) => ({ judge: String(c.judge || `Judge ${i + 1}`), p1: Math.round(c.p1), p2: Math.round(c.p2), winner: c.p1 > c.p2 ? 'p1' : c.p2 > c.p1 ? 'p2' : null }));
  return { kind, label, winner, cards };
}

/** Rows for the punch-stats table (kept for older pages; bouts no longer show punch stats). */
export function statRows(stats) {
  const a = stats?.p1 || {};
  const b = stats?.p2 || {};
  const n = (x) => (Number.isFinite(x) ? Math.round(x) : 0);
  return [
    { label: 'Punches thrown', p1: n(a.thrown), p2: n(b.thrown) },
    { label: 'Punches landed', p1: n(a.landed), p2: n(b.landed) },
    { label: 'Accuracy', p1: percent(a.landed, a.thrown), p2: percent(b.landed, b.thrown), unit: '%' },
    { label: 'Punches blocked', p1: n(a.blocked), p2: n(b.blocked) },
    { label: 'Punches dodged', p1: n(a.dodged), p2: n(b.dodged) },
    { label: 'Counter punches', p1: n(a.counters), p2: n(b.counters) },
    { label: 'Knockdowns', p1: n(a.knockdownsScored), p2: n(b.knockdownsScored) },
  ];
}

// ───────────────────────────── medals (TRN02) ─────────────────────────────

export const MEDAL_INFO = Object.freeze({
  [Medal.NONE]: { label: 'No medal', color: '#9aa3c0', ribbon: '#5b6688' },
  [Medal.BRONZE]: { label: 'Bronze', color: '#d98b4f', ribbon: '#ff6b5a' },
  [Medal.SILVER]: { label: 'Silver', color: '#c9d2e3', ribbon: '#3d7bff' },
  [Medal.GOLD]: { label: 'Gold', color: '#ffc94a', ribbon: '#2bb3a3' },
  [Medal.PLATINUM]: { label: 'Platinum', color: '#b9f3ff', ribbon: '#c77dff' },
});

export const TRAINING_INFO = Object.freeze({
  bag: { title: 'Bag practice', short: 'Bag', rule: 'Pound the hanging bag until it drops off its chain — then the next one swings in.', icon: 'bag' },
  dodge: { title: 'Dodging drill', short: 'Dodge', rule: 'Lean and duck out of the way of the trainer’s tennis balls. Every ball you slip scores.', icon: 'ball' },
  mitts: { title: 'Target punching', short: 'Targets', rule: 'Hit the mitts the trainer holds up — both when both go up. Don’t hit the trainer!', icon: 'mitt' },
});

// ───────────────────────────── navigation geometry ─────────────────────────────

/**
 * Spatial navigation: the best neighbour of rects[from] in a direction.
 * Prefers candidates roughly in line; returns -1 when there is none.
 * @param {Array<{left:number, top:number, width:number, height:number}>} rects
 * @param {number} from
 * @param {'up'|'down'|'left'|'right'} dir
 */
export function pickNeighbor(rects, from, dir) {
  const c = rects[from];
  if (!c) return rects.length ? 0 : -1;
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  const vertical = dir === 'up' || dir === 'down';
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const r = rects[i];
    const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
    let primary;
    if (dir === 'down') { if (dy <= 4) continue; primary = dy; }
    else if (dir === 'up') { if (dy >= -4) continue; primary = -dy; }
    else if (dir === 'right') { if (dx <= 4) continue; primary = dx; }
    else if (dir === 'left') { if (dx >= -4) continue; primary = -dx; }
    else return -1;
    // Overlap along the cross axis counts as "in line" (small tie-break penalty only).
    const overlap = vertical
      ? Math.min(r.left + r.width, c.left + c.width) - Math.max(r.left, c.left)
      : Math.min(r.top + r.height, c.top + c.height) - Math.max(r.top, c.top);
    const off = Math.abs(vertical ? dx : dy);
    const score = primary + (overlap > 0 ? off * 0.1 : off * 2.2);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// ───────────────────────────── graphs ─────────────────────────────

/** Skill values over time from match history (single-player bouts only), oldest first. */
export function skillSeries(history, startSkill = 0) {
  const list = Array.isArray(history) ? history.filter((m) => m && m.mode !== 'versus' && Number.isFinite(m.skillAfter)) : [];
  if (!list.length) return [];
  const first = list[0];
  const out = [Number.isFinite(first.skillBefore) ? first.skillBefore : startSkill];
  for (const m of list) out.push(m.skillAfter);
  return out;
}

/**
 * Polyline geometry for a small line chart.
 * @returns {{d:string, area:string, points:Array<{x:number,y:number,v:number}>, min:number, max:number, y:(v:number)=>number}}
 */
export function linePath(values, { w = 600, h = 240, pad = 16, min, max, includeZero = false } = {}) {
  const vals = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  let lo = Number.isFinite(min) ? min : Math.min(...vals, includeZero ? 0 : Infinity);
  let hi = Number.isFinite(max) ? max : Math.max(...vals, -Infinity);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 1;
  if (hi - lo < 1e-9) { hi = lo + 1; lo = lo - 1; }
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo));
  const n = vals.length;
  const x = (i) => (n <= 1 ? w / 2 : pad + ((w - 2 * pad) * i) / (n - 1));
  const points = vals.map((v, i) => ({ x: round2(x(i)), y: round2(y(v)), v }));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  const area = points.length ? `${d} L${points.at(-1).x} ${h - pad} L${points[0].x} ${h - pad} Z` : '';
  return { d, area, points, min: lo, max: hi, y };
}
const round2 = (v) => Math.round(v * 100) / 100;

// ───────────────────────────── rating, PRO, VS card, glove unlocks (§7, PRG02) ─────────────────────────────

/** PRO starts at this rating (research/mechanics.md §7.3); progression.PRO_THRESHOLD wins when present. */
export const PRO_RATING = 1000;

/** progression.PRO_THRESHOLD when available, else 1000. */
export function proThreshold(prog) {
  const v = Number(prog?.PRO_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : PRO_RATING;
}

/** PRO badge at a rating of 1000 or more (§5, §7.3). */
export function isProRating(rating, proAt = PRO_RATING) {
  return Number.isFinite(rating) && rating >= proAt;
}

const firstNumber = (...vals) => {
  for (const v of vals) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
};

/**
 * Everything the VS card shows, from progression.describeBout() output when present.
 * Accepts describeBout's {player:{name, rating, pro}, opponent:{id, name, nickname, rating, pro}, rematch}
 * or a nextBout() result {opponent: RosterEntry, rating, rematch}; falls back to the profile + roster entry.
 * @param {{profile?:any, opponent?:any, bout?:any, proAt?:number, roster?:any[], ratingOf?:(opp:any)=>number|null}} o
 * @returns {{player:{name:string, appearance:any, rating:number, pro:boolean},
 *            opponent:{id:string|null, name:string, nickname:string|null, appearance:any, rating:number|null, pro:boolean},
 *            rematch:boolean}}
 */
export function vsCardModel({ profile = null, opponent = null, bout = null, proAt = PRO_RATING, roster = [], ratingOf = null } = {}) {
  const b = bout && typeof bout === 'object' ? bout : {};
  const bp = b.player && typeof b.player === 'object' ? b.player : {};
  const bo = b.opponent && typeof b.opponent === 'object' ? b.opponent : {};
  const list = Array.isArray(roster) ? roster : [];
  const id = bo.id ?? opponent?.id ?? null;
  // describeBout's opponent has no appearance: take it from the roster entry
  const entry = (opponent && (!id || opponent.id === id) ? opponent : null) || (bo.appearance ? bo : null) || list.find((r) => r && r.id === id) || opponent || {};
  const oppRating = firstNumber(b.opponentRating, bo.rating, typeof b.rating === 'number' ? b.rating : null, entry.rating,
    ratingOf ? safeCall(() => ratingOf(entry)) : null, entry.skillRequired);
  const playerRating = firstNumber(b.playerRating, bp.rating, profile?.skill, 0);
  const pro = (explicit, r) => (typeof explicit === 'boolean' ? explicit : isProRating(r, proAt));
  return {
    player: {
      name: String(bp.name || profile?.name || 'You'), appearance: profile?.appearance || null,
      rating: playerRating, pro: pro(bp.pro ?? b.playerPro, playerRating),
    },
    opponent: {
      id, name: String(bo.name || entry.name || 'Mystery boxer'), nickname: bo.nickname || entry.nickname || null,
      appearance: entry.appearance || null, rating: oppRating, pro: oppRating === null ? false : pro(bo.pro ?? b.opponentPro, oppRating),
    },
    rematch: !!(b.rematch ?? b.isRematch ?? false),
  };
}

function safeCall(fn) { try { return fn(); } catch { return null; } }

/**
 * Rating series for the results-card graph (oldest first), ending at `after`.
 * Prefers progression.ratingHistory(profile, {withStart:true}) rows ({rating}); else match history.
 * @returns {number[]}
 */
export function ratingSeries({ profile = null, before = 0, after = before, history = null, limit = 40 } = {}) {
  let vals = [];
  if (Array.isArray(history) && history.length) vals = history.map((r) => (typeof r === 'number' ? r : r?.rating)).filter(Number.isFinite);
  else vals = skillSeries(profile?.records?.matches?.history || [], before);
  if (!vals.length) vals = [before];
  if (vals[vals.length - 1] !== after) {
    if (vals.length === 1 && vals[0] !== before) vals.push(before);
    vals.push(after);
  }
  if (vals.length === 1) vals.unshift(before === after ? 0 : before);
  return vals.slice(-Math.max(2, limit));
}

/**
 * Line-graph geometry for the rating card: 0 at the bottom, room above the PRO line.
 * @returns {ReturnType<typeof linePath> & {proY:number, top:number}}
 */
export function ratingGraph(values, { w = 560, h = 300, pad = 22, proAt = PRO_RATING } = {}) {
  const vals = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  const peak = Math.max(proAt * 1.2, ...vals.map((v) => v * 1.1), 100);
  const top = Math.ceil(peak / 100) * 100;
  const g = linePath(vals, { w, h, pad, min: 0, max: top });
  return { ...g, proY: g.y(proAt), top };
}

/**
 * Normalise progression.GLOVE_UNLOCKS ([{id, name, color, at}]) — or a {rating: color(s)} / {color: rating} map —
 * into [{at, color, name, id}] sorted by milestone. Colours are lower-case hex.
 */
export function normalizeGloveUnlocks(raw) {
  const out = [];
  const hex = (c) => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c.trim()) ? `#${c.trim().replace('#', '').toLowerCase()}` : null);
  const push = (at, color, name, id) => {
    const c = hex(color);
    const n = Number(at);
    if (c && Number.isFinite(n)) out.push({ at: n, color: c, name: name ? String(name) : null, id: id ? String(id) : c });
  };
  if (Array.isArray(raw)) {
    for (const u of raw) {
      if (!u || typeof u !== 'object') continue;
      const at = u.at ?? u.rating ?? u.minRating ?? u.min ?? u.skill ?? u.threshold;
      const colors = Array.isArray(u.colors) ? u.colors : [u.color ?? u.hex ?? u.colour];
      for (const c of colors) push(at, c, u.name || u.label, colors.length > 1 ? null : u.id);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (hex(k) && Number.isFinite(Number(v))) push(v, k, null, null);
      else for (const c of [].concat(v)) push(k, c, null, null);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Glove swatches for the editor: the regular colours plus the unlock colours, each marked locked
 * until its milestone. `isAllowed(color)` (progression.isGloveColorAllowed bound to the profile) wins
 * over the milestone check against `best` (the best rating ever reached).
 * @returns {Array<{color:string, locked:boolean, at:number|null, name:string|null}>}
 */
export function gloveSwatches({ base = [], unlocks = [], best = 0, isAllowed = null } = {}) {
  const list = normalizeGloveUnlocks(unlocks);
  const byColor = new Map(list.map((u) => [u.color, u]));
  const seen = new Set();
  const out = [];
  const add = (color) => {
    const c = String(color || '').toLowerCase();
    if (!c || seen.has(c)) return;
    seen.add(c);
    const u = byColor.get(c) || null;
    let locked = !!u && !(best >= u.at);
    if (u && typeof isAllowed === 'function') { const ok = safeCall(() => isAllowed(c)); if (typeof ok === 'boolean') locked = !ok; }
    out.push({ color: c, locked, at: u ? u.at : null, name: u ? u.name : null });
  };
  for (const c of base) add(c);
  for (const u of list) add(u.color);
  return out;
}

/** Unlock entries crossed when the best rating goes from `bestBefore` to `bestAfter`. */
export function crossedGloveUnlocks(unlocks, bestBefore, bestAfter) {
  const a = Number(bestBefore) || 0, b = Number(bestAfter) || 0;
  return normalizeGloveUnlocks(unlocks).filter((u) => a < u.at && b >= u.at);
}

// ───────────────────────────── pose analysis (camera setup, ERR01/ERR02) ─────────────────────────────

const vis = (lm, at) => !!lm && (lm.visibility ?? lm.presence ?? 1) >= at && lm.x >= -0.02 && lm.x <= 1.02 && lm.y >= -0.02 && lm.y <= 1.02;

/**
 * Is this player framed well enough to play? Explains what's missing in plain words.
 * Image landmarks are RAW camera space; hints are phrased for the MIRRORED preview.
 * @param {import('../../core/types.js').PlayerPose|null} pose
 * @returns {{visible:boolean, ready:boolean, missing:string[], hint:string, size:number}}
 */
export function playerVisibility(pose, { visibleAt = UI_TUNING.visibleAt, minSize = UI_TUNING.minShoulderWidth, maxSize = UI_TUNING.maxShoulderWidth } = {}) {
  const im = pose && Array.isArray(pose.image) ? pose.image : null;
  if (!im || im.length < 17) return { visible: false, ready: false, missing: ['you'], hint: 'Step into view', size: 0 };
  const has = (i) => vis(im[i], visibleAt);
  const head = has(LM.NOSE) || (has(LM.LEFT_EAR) && has(LM.RIGHT_EAR));
  const shoulders = has(LM.LEFT_SHOULDER) && has(LM.RIGHT_SHOULDER);
  // Person's RIGHT hand appears on the RIGHT of the mirrored preview.
  const rightHand = has(LM.RIGHT_WRIST);
  const leftHand = has(LM.LEFT_WRIST);
  const missing = [];
  if (!head) missing.push('head');
  if (!shoulders) missing.push('shoulders');
  if (!leftHand) missing.push('left hand');
  if (!rightHand) missing.push('right hand');
  const size = shoulders ? Math.hypot(im[LM.LEFT_SHOULDER].x - im[LM.RIGHT_SHOULDER].x, im[LM.LEFT_SHOULDER].y - im[LM.RIGHT_SHOULDER].y) : 0;
  const visible = head || shoulders;
  let hint = '';
  let ready = missing.length === 0;
  if (!visible) hint = 'Step into view';
  else if (!shoulders || !head) hint = !head ? 'Your head is out of the picture' : 'Face the camera so we can see both shoulders';
  else if (size > maxSize) { hint = 'Step back a little'; ready = false; }
  else if (size < minSize) { hint = 'Come a bit closer'; ready = false; }
  else if (!leftHand && !rightHand) hint = 'Raise both gloves so we can see your hands';
  else if (!leftHand) hint = 'We can’t see your left hand';
  else if (!rightHand) hint = 'We can’t see your right hand';
  else hint = 'Looking good!';
  return { visible, ready, missing, hint, size };
}

/**
 * Simple guard detector from raw landmarks (fallback when no ControlState is available):
 * both wrists up near the face, between the shoulders' outer edges.
 * @returns {{guard:boolean, amount:number}}
 */
export function guardFromPose(pose, { visibleAt = 0.4 } = {}) {
  const im = pose && Array.isArray(pose.image) ? pose.image : null;
  if (!im || im.length < 17) return { guard: false, amount: 0 };
  const need = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_WRIST, LM.RIGHT_WRIST];
  if (!need.every((i) => vis(im[i], visibleAt))) return { guard: false, amount: 0 };
  const ls = im[LM.LEFT_SHOULDER], rs = im[LM.RIGHT_SHOULDER], nose = im[LM.NOSE];
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (!(sw > 0.01)) return { guard: false, amount: 0 };
  const shoulderY = (ls.y + rs.y) / 2;
  const cx = (ls.x + rs.x) / 2;
  const score = (w) => {
    const high = clamp01((shoulderY + 0.15 * sw - w.y) / (0.5 * sw)); // above the shoulder line
    const nearFace = clamp01(1 - (Math.hypot(w.x - nose.x, w.y - nose.y) - 0.9 * sw) / (0.7 * sw));
    const inside = clamp01(1 - (Math.abs(w.x - cx) - 0.9 * sw) / (0.4 * sw));
    return Math.min(high, nearFace, inside);
  };
  const amount = Math.min(score(im[LM.LEFT_WRIST]), score(im[LM.RIGHT_WRIST]));
  return { guard: amount > 0.6, amount };
}

// ───────────────────────────── appearance (editor) ─────────────────────────────

const AK = AppearanceKit;

/** Colour swatches for the appearance editor (characters' palette when available). */
export const SWATCHES = Object.freeze({
  skin: APPEARANCE_OPTIONS.skinTones,
  hair: APPEARANCE_OPTIONS.hairColors,
  cloth: Array.isArray(AK.CLOTH_COLORS) && AK.CLOTH_COLORS.length ? AK.CLOTH_COLORS
    : ['#3d7bff', '#ff4d5e', '#2bb3a3', '#ffc94a', '#ff8a5b', '#c77dff', '#5bd1b8', '#1f3b73', '#14182b', '#f7f3ea'],
  gloves: Array.isArray(AK.GLOVE_COLORS) && AK.GLOVE_COLORS.length ? AK.GLOVE_COLORS
    : ['#ff4d5e', '#3d7bff', '#ffc94a', '#2bb3a3', '#f7f3ea', '#c77dff', '#ff8a5b'],
  shoes: Array.isArray(AK.SHOE_COLORS) && AK.SHOE_COLORS.length ? AK.SHOE_COLORS
    : ['#f7f3ea', '#14182b', '#ff4d5e', '#3d7bff', '#ffc94a', '#2bb3a3'],
  trim: ['#ffd166', '#f7f3ea', '#ff6b5a', '#2bb3a3', '#ffc94a', '#5bd1b8', '#ff5d8f', '#14182b'],
});

/** Validate an appearance with the characters module when present (same repair rules as rendering). */
export function validLook(a) {
  try {
    if (typeof AK.validateAppearance === 'function') {
      const v = AK.validateAppearance(a);
      delete v.label;
      return v;
    }
  } catch { /* fall back */ }
  return sanitizeAppearance(a);
}

/** Starting look for a new boxer. */
export function defaultLook() {
  return validLook(AK.DEFAULT_PLAYER || DEFAULT_APPEARANCE);
}

/** Seeded random look (characters' randomizer when present). */
export function randomLook(seed) {
  try {
    if (typeof AK.randomAppearance === 'function') return validLook(AK.randomAppearance(seed));
  } catch { /* fall back */ }
  const rnd = mulberry(typeof seed === 'number' ? seed : hashString(String(seed)));
  const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
  const O = APPEARANCE_OPTIONS;
  return sanitizeAppearance({
    skin: pick(O.skinTones), hair: { style: pick(O.hairStyles), color: pick(O.hairColors) },
    eyes: pick(O.eyes), brows: pick(O.brows), mouth: pick(O.mouths), nose: pick(O.noses),
    accessory: rnd() < 0.5 ? 'none' : pick(O.accessories), top: rnd() < 0.15 ? 'none' : pick(SWATCHES.cloth),
    trunks: pick(SWATCHES.cloth), trim: pick(SWATCHES.trim), gloves: pick(SWATCHES.gloves), shoes: pick(SWATCHES.shoes),
    build: pick(O.builds), height: 0.92 + rnd() * 0.16,
  });
}

/** Ready-made looks (label + appearance). */
export function presetLooks() {
  const list = Array.isArray(AK.PRESETS) ? AK.PRESETS : [];
  return list.map((p) => ({ label: p.label || 'Preset', look: validLook(p) }));
}

/** Friendly random names for new boxers (our own list). */
export const RANDOM_NAMES = Object.freeze([
  'Sunny', 'Biscuit', 'Rocket', 'Pepper', 'Maple', 'Comet', 'Noodle', 'Ziggy', 'Mango', 'Pixel',
  'Bolt', 'Taffy', 'Jet', 'Clover', 'Dash', 'Juniper', 'Rumble', 'Sprout', 'Echo', 'Waffles',
  'Kip', 'Nova', 'Bruno', 'Poppy', 'Zest', 'Marlo', 'Tango', 'Fizz', 'Ollie', 'Skye',
]);

export function randomName(seed, avoid = []) {
  const rnd = mulberry(typeof seed === 'number' ? seed : hashString(String(seed)));
  const pool = RANDOM_NAMES.filter((n) => !avoid.includes(n));
  const list = pool.length ? pool : RANDOM_NAMES;
  return list[Math.floor(rnd() * list.length) % list.length];
}

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Readable text colour (ink or paper) on a hex background. */
export function contrastInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#14182b';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#14182b' : '#fffaf0';
}

// ───────────────────────────── DOM builders (call-time DOM only) ─────────────────────────────

/**
 * Hyperscript: h('div', {class:'x', onclick, style:{...}, dataset:{...}}, child, 'text', [more]).
 * Strings become text nodes (never HTML).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** SVG element builder (attributes set verbatim). */
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  appendChildren(el, children);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'vars' && typeof v === 'object') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, String(val));
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Our own simple line icons (24×24 grid, rounded strokes). */
const ICONS = {
  glove: 'M7 20h9v-3.5c2.2-1 3.5-3 3.5-5.5V8.5A3.5 3.5 0 0 0 16 5h-4.5A4.5 4.5 0 0 0 7 9.5V12H5.5a1.5 1.5 0 0 0 0 3H7z M7 17h9 M11.5 9.5h4',
  gloves: 'M3 19h6v-2.5c1.5-.7 2.4-2 2.4-3.8v-1.8A2.4 2.4 0 0 0 9 8.5H6.2A3.2 3.2 0 0 0 3 11.7z M13 19h6v-2.5c1.5-.7 2.4-2 2.4-3.8v-1.8A2.4 2.4 0 0 0 19 8.5h-2.8a3.2 3.2 0 0 0-3.2 3.2z M8 4l1.5 2 M12 3v2.5 M16 4l-1.5 2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12h.01',
  chart: 'M4 20V4 M4 20h16 M7 15l4-4 3 3 5-6',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 13.5l1.6 1.2-2 3.4-1.9-.8a7.6 7.6 0 0 1-2.3 1.3L14.5 21h-5l-.3-2.4a7.6 7.6 0 0 1-2.3-1.3l-1.9.8-2-3.4 1.6-1.2a7.7 7.7 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.8a7.6 7.6 0 0 1 2.3-1.3L9.5 3h5l.3 2.4a7.6 7.6 0 0 1 2.3 1.3l1.9-.8 2 3.4-1.6 1.2a7.7 7.7 0 0 1 0 3z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8 M12 17.2h.01',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  guest: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5 M17.5 3.5l3 3 M20.5 3.5l-3 3',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3',
  export: 'M12 15V3 M7 8l5-5 5 5 M4 17v3h16v-3',
  dice: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8.5 8.5h.01 M15.5 8.5h.01 M12 12h.01 M8.5 15.5h.01 M15.5 15.5h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6 6l12 12 M18 6L6 18',
  camera: 'M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  keyboard: 'M3 6h18v12H3z M6.5 9.5h.01 M10 9.5h.01 M13.5 9.5h.01 M17 9.5h.01 M6.5 12.5h.01 M17 12.5h.01 M8 15h8',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4.5v15l12-7.5z',
  restart: 'M4 12a8 8 0 1 0 2.3-5.6 M4 4v4h4',
  exit: 'M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0z M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4 M12 13v4 M8 20h8 M9.5 17h5',
  bag: 'M12 2v3 M9 5h6 M8 7.5A2.5 2.5 0 0 1 10.5 5h3A2.5 2.5 0 0 1 16 7.5V19a2.5 2.5 0 0 1-2.5 2.5h-3A2.5 2.5 0 0 1 8 19z M8 10h8 M8 17h8',
  ball: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M4.6 7.5c3 1.4 3.6 7.5 0 9 M19.4 7.5c-3 1.4-3.6 7.5 0 9',
  mitt: 'M6 20h8l2-3c2.5-1 4-3.4 4-6.2A6.8 6.8 0 0 0 13.2 4H11a5 5 0 0 0-5 5z M10.5 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  edit: 'M4 20h4l11-11-4-4L4 16z M13 7l4 4',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  eyeoff: 'M3 3l18 18 M10.6 6.1A9.7 9.7 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6 M6.4 7.6C4.6 8.9 3.3 10.7 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1 M9.9 10a3 3 0 0 0 4.1 4.1',
  sound: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4z M15.5 9a4.2 4.2 0 0 1 0 6 M18 6.5a7.8 7.8 0 0 1 0 11',
  move: 'M12 3v18 M3 12h18 M12 3l-3 3 M12 3l3 3 M12 21l-3-3 M12 21l3-3 M3 12l3-3 M3 12l3 3 M21 12l-3-3 M21 12l-3 3',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z',
  duck: 'M12 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z M5 21l3-7h8l3 7 M8 14l-2-3 M16 14l2-3',
  lean: 'M9.5 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z M10.5 8.5l2 6.5-1 6 M12.5 15l3.5 6 M11 11l-4 2.5 M11.5 11.5l4.5.5',
  bolt: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2 2.2.8-2.2.8L19 22l-.8-2.2-2.2-.8 2.2-.8z',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3 M5.5 11h13v9.5h-13z M12 14.5v2.5',
  up: 'M6 17L17 6 M8.5 6H17v8.5',
  down: 'M6 7l11 11 M17 9.5V18H8.5',
  crown: 'M4 18h16 M4.5 15L3 7l5 3.5L12 4l4 6.5L21 7l-1.5 8z',
};

/** An inline SVG icon. */
export function icon(name, { size, cls } = {}) {
  const d = ICONS[name] || ICONS.help;
  const el = svg('svg', { viewBox: '0 0 24 24', class: `gu-icon${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true', width: size, height: size },
    svg('path', { d }));
  return el;
}

let autoId = 0;
/** Unique-ish id for controls (`data-cursor`). */
export function uid(prefix = 'gu') {
  autoId = (autoId + 1) % 1e9;
  return `${prefix}-${autoId}`;
}

/**
 * A big button. `onClick` runs for mouse / touch and keyboard (Enter/Space) — ui.js routes every
 * activation through `__guAction`.
 * @param {{label:string, sub?:string, icon?:string, id?:string, kind?:'primary'|'secondary'|'ghost'|'danger'|'good',
 *          size?:'xl'|'lg'|'md'|'sm', onClick?:Function, disabled?:boolean, cls?:string, sfx?:string,
 *          ariaLabel?:string, badge?:string|HTMLElement, content?:HTMLElement[]}} o
 */
export function button(o) {
  const id = o.id || uid('btn');
  const kids = [];
  if (o.icon) kids.push(h('span', { class: 'gu-btn__icon' }, icon(o.icon)));
  const text = [];
  if (o.label) text.push(h('span', { class: 'gu-btn__label', text: o.label }));
  if (o.sub) text.push(h('span', { class: 'gu-btn__sub', text: o.sub }));
  if (text.length) kids.push(h('span', { class: 'gu-btn__text' }, text));
  if (o.content) kids.push(...o.content);
  if (o.badge) kids.push(typeof o.badge === 'string' ? h('span', { class: 'gu-btn__badge', text: o.badge }) : o.badge);
  const el = h('button', {
    type: 'button',
    class: ['gu-btn', `gu-btn--${o.kind || 'secondary'}`, `gu-btn--${o.size || 'lg'}`, o.cls],
    'aria-label': o.ariaLabel || (o.sub ? `${o.label}. ${o.sub}` : undefined),
    dataset: { cursor: id, ...(o.sfx ? { sfx: o.sfx } : {}) },
  }, kids);
  el.disabled = !!o.disabled;
  el.__guAction = o.onClick || null;
  return el;
}

/** Update a button's label text in place. */
export function setButtonLabel(btn, label, sub) {
  const l = btn.querySelector('.gu-btn__label');
  if (l && label !== undefined) l.textContent = label;
  const s = btn.querySelector('.gu-btn__sub');
  if (s && sub !== undefined) s.textContent = sub;
}

/**
 * "◀ value ▶" picker usable with mouse / touch and arrow keys.
 * @param {{label:string, values:any[], value:any, format?:(v:any)=>string, onChange:(v:any)=>void, id?:string, swatch?:boolean}} o
 * @returns {HTMLElement & {setValue:(v:any)=>void, setValues:(vals:any[], v:any)=>void}}
 */
export function cycler(o) {
  let values = o.values.slice();
  let idx = Math.max(0, values.indexOf(o.value));
  const fmt = o.format || ((v) => optionLabel(v));
  const valueEl = h('span', { class: 'gu-cycler__value', 'aria-live': 'polite' });
  const step = (d) => {
    if (!values.length) return;
    idx = (idx + d + values.length) % values.length;
    render();
    o.onChange?.(values[idx]);
  };
  const prev = button({ icon: 'back', kind: 'ghost', size: 'md', cls: 'gu-cycler__arrow', ariaLabel: `Previous ${o.label}`, onClick: () => step(-1), sfx: 'ui-move' });
  const next = button({ icon: 'next', kind: 'ghost', size: 'md', cls: 'gu-cycler__arrow', ariaLabel: `Next ${o.label}`, onClick: () => step(1), sfx: 'ui-move' });
  const root = h('div', { class: 'gu-cycler', role: 'group', 'aria-label': o.label },
    o.label ? h('span', { class: 'gu-cycler__label', text: o.label }) : null,
    h('div', { class: 'gu-cycler__row' }, prev, valueEl, next));
  function render() {
    const v = values[idx];
    valueEl.textContent = v === undefined ? '—' : fmt(v);
  }
  root.setValue = (v) => { const i = values.indexOf(v); if (i >= 0) { idx = i; render(); } };
  root.setValues = (vals, v) => { values = vals.slice(); idx = Math.max(0, values.indexOf(v)); render(); };
  root.step = step;
  // Left/Right on either arrow button steps the value (ui.js gives arrows to widgets that ask).
  for (const b of [prev, next]) b.__guArrows = (dir) => (dir === 'left' ? (step(-1), true) : dir === 'right' ? (step(1), true) : false);
  render();
  return root;
}

/**
 * Big slider with −/+ buttons and a draggable track (mouse/touch).
 * @param {{label:string, value:number, min?:number, max?:number, step?:number, format?:(v:number)=>string, onChange:(v:number, final:boolean)=>void, desc?:string}} o
 */
export function slider(o) {
  const min = o.min ?? 0, max = o.max ?? 1, stepV = o.step ?? 0.1;
  let value = clamp(o.value ?? min, min, max);
  const fmt = o.format || ((v) => `${Math.round(((v - min) / (max - min)) * 100)}%`);
  const fill = h('span', { class: 'gu-slider__fill' });
  const knob = h('span', { class: 'gu-slider__knob' });
  const out = h('span', { class: 'gu-slider__value' });
  const track = h('div', { class: 'gu-slider__track', role: 'slider', tabindex: '0', 'aria-label': o.label, 'aria-valuemin': String(min), 'aria-valuemax': String(max) }, fill, knob);
  const set = (v, final = true) => {
    const nv = clamp(Math.round(v / stepV) * stepV, min, max);
    const changed = Math.abs(nv - value) > 1e-9;
    value = nv;
    render();
    if (changed || final) o.onChange?.(value, final);
  };
  const minus = button({ icon: 'minus', kind: 'ghost', size: 'md', cls: 'gu-slider__btn', ariaLabel: `Less ${o.label}`, onClick: () => set(value - stepV), sfx: 'ui-move' });
  const plus = button({ icon: 'plus', kind: 'ghost', size: 'md', cls: 'gu-slider__btn', ariaLabel: `More ${o.label}`, onClick: () => set(value + stepV), sfx: 'ui-move' });
  const fromEvent = (ev) => {
    const r = track.getBoundingClientRect();
    return min + clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1) * (max - min);
  };
  let dragging = false;
  track.addEventListener('pointerdown', (ev) => { dragging = true; track.setPointerCapture?.(ev.pointerId); set(fromEvent(ev), false); });
  track.addEventListener('pointermove', (ev) => { if (dragging) set(fromEvent(ev), false); });
  const end = (ev) => { if (!dragging) return; dragging = false; set(fromEvent(ev), true); };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', () => { dragging = false; });
  const arrows = (dir) => (dir === 'left' ? (set(value - stepV), true) : dir === 'right' ? (set(value + stepV), true) : false);
  track.__guArrows = arrows;
  minus.__guArrows = arrows;
  plus.__guArrows = arrows;
  function render() {
    const k = (value - min) / (max - min);
    track.style.setProperty('--k', String(k));
    out.textContent = fmt(value);
    track.setAttribute('aria-valuenow', String(value));
    track.setAttribute('aria-valuetext', fmt(value));
  }
  render();
  const root = h('div', { class: 'gu-slider' }, minus, track, plus, out);
  root.setValue = (v) => { value = clamp(v, min, max); render(); };
  return root;
}

/**
 * On/off switch rendered as one big button.
 * @param {{label:string, value:boolean, onChange:(v:boolean)=>void, on?:string, off?:string}} o
 */
export function toggle(o) {
  let value = !!o.value;
  const state = h('span', { class: 'gu-toggle__state' });
  const btn = button({ kind: 'ghost', size: 'md', cls: 'gu-toggle', ariaLabel: o.label, onClick: () => { value = !value; render(); o.onChange?.(value); }, content: [h('span', { class: 'gu-toggle__track' }, h('span', { class: 'gu-toggle__knob' })), state] });
  btn.setAttribute('role', 'switch');
  function render() {
    btn.classList.toggle('is-on', value);
    btn.setAttribute('aria-checked', String(value));
    state.textContent = value ? (o.on || 'On') : (o.off || 'Off');
  }
  btn.__guArrows = (dir) => {
    if (dir === 'left' && value) { value = false; render(); o.onChange?.(value); return true; }
    if (dir === 'right' && !value) { value = true; render(); o.onChange?.(value); return true; }
    return false;
  };
  render();
  btn.setValue = (v) => { value = !!v; render(); };
  return btn;
}

/**
 * Segmented choice (2–4 options as big buttons).
 * @param {{label:string, options:Array<{value:any, label:string, sub?:string, icon?:string}>, value:any, onChange:(v:any)=>void}} o
 */
export function segmented(o) {
  let value = o.value;
  const btns = o.options.map((opt) => {
    const b = button({ label: opt.label, sub: opt.sub, icon: opt.icon, kind: 'ghost', size: 'md', cls: 'gu-seg__opt', onClick: () => { value = opt.value; render(); o.onChange?.(value); } });
    b.__value = opt.value;
    b.setAttribute('role', 'radio');
    return b;
  });
  const root = h('div', { class: 'gu-seg', role: 'radiogroup', 'aria-label': o.label }, btns);
  function render() {
    for (const b of btns) {
      const on = b.__value === value;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  render();
  root.setValue = (v) => { value = v; render(); };
  return root;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * Standard screen header: [Back] Title (sub) [right…]
 * @param {{title:string, sub?:string, onBack?:Function|null, backLabel?:string, right?:HTMLElement|HTMLElement[]}} o
 */
export function pageHeader(o) {
  const back = o.onBack ? button({ icon: 'back', label: o.backLabel || 'Back', kind: 'ghost', size: 'md', cls: 'gu-back', sfx: 'ui-back', onClick: o.onBack }) : h('span', { class: 'gu-header__spacer' });
  return h('header', { class: 'gu-header' },
    back,
    h('div', { class: 'gu-header__titles' },
      h('h1', { class: 'gu-title', text: o.title }),
      o.sub ? h('p', { class: 'gu-subtitle', text: o.sub }) : null),
    h('div', { class: 'gu-header__right' }, o.right || null));
}

/**
 * Tab strip + panel host. Tabs are big buttons; content is built lazily.
 * @param {{tabs:Array<{id:string, label:string, icon?:string, build:()=>HTMLElement}>, value?:string, onChange?:(id:string)=>void}} o
 * @returns {HTMLElement & {select:(id:string)=>void, current:()=>string}}
 */
export function tabs(o) {
  let cur = o.value || o.tabs[0]?.id;
  const host = h('div', { class: 'gu-tabs__panel', role: 'tabpanel' });
  const btns = o.tabs.map((t) => {
    const b = button({ label: t.label, icon: t.icon, kind: 'ghost', size: 'md', cls: 'gu-tabs__tab', sfx: 'ui-move', onClick: () => select(t.id) });
    b.setAttribute('role', 'tab');
    b.__tab = t.id;
    return b;
  });
  const root = h('div', { class: 'gu-tabs' }, h('div', { class: 'gu-tabs__strip', role: 'tablist' }, btns), host);
  function select(id) {
    const t = o.tabs.find((x) => x.id === id) || o.tabs[0];
    if (!t) return;
    cur = t.id;
    for (const b of btns) {
      const on = b.__tab === cur;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', String(on));
    }
    clear(host);
    host.appendChild(t.build());
    o.onChange?.(cur);
  }
  root.select = select;
  root.current = () => cur;
  select(cur);
  return root;
}

/** Small rounded label. */
export function chip(text, kind = 'neutral', iconName) {
  return h('span', { class: `gu-chip gu-chip--${kind}` }, iconName ? icon(iconName) : null, text);
}

/** Pro badge (PRG02). */
export function proBadge(big = false) {
  return h('span', { class: `gu-pro${big ? ' gu-pro--big' : ''}`, title: 'Pro boxer' }, icon('star'), 'PRO');
}

/**
 * Medal artwork (our own: round medal on a two-tone ribbon).
 * @param {string} medal  Medal value
 * @param {{size?:number, label?:boolean}} [opts]
 */
export function medalArt(medal, { size = 96, label = false } = {}) {
  const info = MEDAL_INFO[medal] || MEDAL_INFO[Medal.NONE];
  const none = medal === Medal.NONE || !MEDAL_INFO[medal];
  const art = svg('svg', { viewBox: '0 0 100 120', width: size, height: size * 1.2, class: `gu-medal gu-medal--${none ? 'none' : medal}`, role: 'img', 'aria-label': info.label },
    none ? null : svg('path', { d: 'M30 0h16l10 34-16 6z', fill: info.ribbon }),
    none ? null : svg('path', { d: 'M70 0H54L44 34l16 6z', fill: shadeHex(info.ribbon, -0.25) }),
    svg('circle', { cx: 50, cy: 74, r: 38, fill: none ? 'none' : info.color, stroke: none ? '#9aa3c0' : '#14182b', 'stroke-width': 5, 'stroke-dasharray': none ? '8 7' : undefined }),
    none ? null : svg('circle', { cx: 50, cy: 74, r: 27, fill: 'none', stroke: shadeHex(info.color, -0.3), 'stroke-width': 3 }),
    none ? null : svg('path', { d: 'M50 56l5.6 11.4 12.6 1.8-9.1 8.9 2.2 12.5L50 84.7l-11.3 5.9 2.2-12.5-9.1-8.9 12.6-1.8z', fill: shadeHex(info.color, -0.38) }),
    none ? null : svg('path', { d: 'M27 60a26 26 0 0 1 16-14', stroke: 'rgba(255,255,255,0.75)', 'stroke-width': 5, 'stroke-linecap': 'round', fill: 'none' }));
  if (!label) return art;
  return h('div', { class: 'gu-medal-wrap' }, art, h('span', { class: 'gu-medal__label', text: info.label }));
}

/** Hex shade helper for SVG fills (amt −1..1). */
export function shadeHex(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x888888;
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/** Progress ring (SVG) — set with ring.set(0..1). */
export function progressRing({ size = 160, stroke = 12, cls = '' } = {}) {
  const r = 50 - stroke / 2;
  const fg = svg('circle', { class: 'gu-ring__fg', cx: 50, cy: 50, r, pathLength: 100 });
  const el = svg('svg', { viewBox: '0 0 100 100', width: size, height: size, class: `gu-ring ${cls}`.trim(), 'aria-hidden': 'true' },
    svg('circle', { class: 'gu-ring__bg', cx: 50, cy: 50, r }), fg);
  el.style.setProperty('--ring-stroke', String(stroke));
  el.set = (k) => fg.style.setProperty('stroke-dashoffset', String(100 - 100 * clamp01(k)));
  el.set(0);
  return el;
}

/** Trigger a file download (portable profile export). Returns false if the browser refused. */
export function downloadText(filename, text, mime = 'application/json') {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

/** Safe file name from a display name. */
export function fileSafe(name) {
  return String(name || 'boxer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'boxer';
}
