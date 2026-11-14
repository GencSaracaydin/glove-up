// Player profiles, play records and settings, persisted in localStorage under a versioned
// schema ('gloveup:v1:*'). Pure logic: no DOM access at import time, runs in Node with any
// backend that implements getItem/setItem/removeItem (+ optional length/key() for scans).
//
// Requirements implemented here (research/spec.md):
//  SET01  local / guest / portable (imported) profiles.
//  SAV01  play records are saved automatically for LOCAL profiles only; guest and portable
//         profiles are never written to the backend; deleting a local profile erases its
//         records (including any quarantined copies). Match skill, versus results and
//         training results are kept as distinct record sections.
//  SES02  recordMatch / recordTraining are idempotent per result id: applying the same
//         completed result twice never double-counts.
//  ERR04  every storage failure (quota exceeded, storage disabled, private mode, corrupt JSON)
//         returns {ok:true, saved:false, error} — the activity completed but was NOT saved.
//         Nothing here throws. Corrupt data is moved aside ("quarantined"), never crashes.
//  PRG02  the new rating ("skill") is computed by the caller (game/progression.applyBout /
//         applySkill) and passed in; versus results never change it. PRO is always derived
//         from the rating (progression.isPro: 1000 or more), never trusted from the caller.
//  Two tabs (FLOWS-04): each tab keeps its own mirror of the one shared backend, so nothing may
//         write an older copy over what another tab saved. A window 'storage' event re-reads what
//         the other tab changed (syncExternal, wired automatically for window.localStorage), and
//         every write re-reads its key first: a boxer saved elsewhere is adopted before this tab
//         changes it, a rating update computed from an older copy is applied as the change it is,
//         a settings save merges only the keys this tab changed over a fresh read, the index keeps
//         boxers created elsewhere, and a boxer deleted elsewhere (key and index entry gone) is
//         forgotten here — never written back.
//
// Progression state kept per profile (research/mechanics.md §7, ARCHITECTURE.md §6.8). All of it
// is updated by recordMatch inside the same idempotent step (SES02) and written in one setItem:
//   opponents     {[opponentId]: {wins, losses, draws, beaten, rating}} — single-player only;
//                 `rating` is the opponent's raised rematch rating for this boxer (null = still at
//                 its roster base rating). Raised via progression.opponentAfterBout on every win.
//   bestRating    best rating ever reached; glove-colour unlocks follow it (losing PRO keeps them)
//   tutorialDone  the first-bout tutorial was finished or skipped (markTutorialDone) or a
//                 single-player bout was recorded
//   rating history: NOT stored twice — progression.ratingHistory(profile) derives the results-card
//                 graph from records.matches.history (skillBefore/skillAfter per bout). The history
//                 keeps the last 50 single-player AND the last 50 versus bouts, so versus play can
//                 never push rating points out of the graph.
// Migration: profiles saved before this pass have none of these fields; sanitizeProfile derives
// them on load (opponents from the match history, bestRating from skill + history, tutorialDone
// = any single-player bout recorded, pro = isPro(skill)). The key prefix and schema stay v1.
//
// Layout of keys:
//   gloveup:v1:profiles            JSON array of local profile ids (display order)
//   gloveup:v1:profile:<id>        one local profile (JSON)
//   gloveup:v1:settings            settings (JSON)
//   gloveup:v1:quarantine:<k>:<t>  raw copy of a value that failed to parse/validate

import { APPEARANCE_OPTIONS, ProfileKind, TrainingKind, Medal, ResultMethod } from './types.js';
import {
  isPro, bestRatingOf, deriveOpponentStates, sanitizeOpponentState, opponentAfterBout, profileKey, gloveUnlocksBetween,
  isSafeOpponentId,
} from '../game/progression.js';

export const STORAGE_PREFIX = 'gloveup:v1:';
export const SCHEMA_VERSION = 1;
export const PORTABLE_FORMAT = 'glove-up-portable';

export const STORAGE_KEYS = Object.freeze({
  index: STORAGE_PREFIX + 'profiles',
  settings: STORAGE_PREFIX + 'settings',
  probe: STORAGE_PREFIX + 'probe',
  profilePrefix: STORAGE_PREFIX + 'profile:',
  quarantinePrefix: STORAGE_PREFIX + 'quarantine:',
  /** @param {string} id */
  profile: (id) => STORAGE_PREFIX + 'profile:' + id,
});

/** Tunable limits (documented; tests rely on the history caps). */
export const STORAGE_LIMITS = Object.freeze({
  matchHistory: 50,        // single-player entries kept in records.matches.history (the rating graph)
  versusHistory: 50,       // versus entries kept in the same list (counted separately)
  opponents: 64,           // per-opponent progress entries kept per profile
  trainingHistory: 20,     // records.training[kind].history entries kept per activity
  appliedIds: 300,         // result ids remembered for idempotency (SES02)
  nameMaxLength: 16,       // profile name characters (user-perceived: an emoji sequence counts once)
  nameMaxCodePoints: 64,   // … and never more code points than this (stacked combining marks)
  maxProfiles: 24,         // local profiles
  importMaxBytes: 256 * 1024,
  quarantineMax: 10,       // quarantined raw values kept (oldest dropped first)
  skillMax: 99999,
});

/**
 * @typedef {Object} TrainingRecord
 * @property {number} best      best score so far
 * @property {string} medal     best medal so far (Medal)
 * @property {number} plays     completed attempts
 * @property {Array<{id:string, t:number, score:number, medal:string}>} history  newest last, ≤ STORAGE_LIMITS.trainingHistory
 */

/**
 * @typedef {Object} MatchRecord
 * @property {string} id
 * @property {number} t
 * @property {'single'|'versus'} mode
 * @property {'p1'|'p2'} side
 * @property {string|null} opponentId
 * @property {string|null} opponentName
 * @property {'win'|'loss'|'draw'} outcome
 * @property {string} method        ResultMethod
 * @property {number} endRound
 * @property {number} skillBefore
 * @property {number} skillAfter
 * @property {number} delta
 * @property {boolean} pro          Pro status after this bout
 * @property {number|null} opponentRating   the opponent's rating going into this bout (single player; null if unknown)
 * @property {boolean} rematch      the player had beaten this opponent before this bout
 */

/**
 * @typedef {Object} ProfileRecords
 * @property {{wins:number, losses:number, draws:number, kos:number, history: MatchRecord[]}} matches
 *           wins/losses/draws/kos count SINGLE-PLAYER bouts (the skill-bearing mode); history holds both modes,
 *           oldest first (≤ 50 single-player + ≤ 50 versus entries)
 * @property {{wins:number, losses:number, draws:number, kos:number}} versus   local human-vs-human bouts
 * @property {{bag: TrainingRecord, dodge: TrainingRecord, mitts: TrainingRecord}} training
 * @property {string[]} applied     result ids already applied (SES02 idempotency)
 */

/**
 * @typedef {Object} Profile
 * @property {number} schema
 * @property {string} id
 * @property {string} name
 * @property {'local'|'guest'|'portable'} kind
 * @property {import('./types.js').Appearance} appearance
 * @property {import('./types.js').Calibration|null} calibration
 * @property {number} skill        the rating (0 …), research/mechanics.md §7
 * @property {boolean} pro          always isPro(skill): 1000 or more
 * @property {number} bestRating    best rating ever reached (glove-colour unlocks follow it)
 * @property {boolean} tutorialDone first-bout tutorial finished/skipped, or a single-player bout recorded
 * @property {Record<string, import('../game/progression.js').OpponentState>} opponents  per-opponent progress
 * @property {ProfileRecords} records
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} [sourceId]    portable profiles: id of the profile on the device it came from
 */

/**
 * What one recorded single-player bout changed (SaveResult.summary from recordMatch) — the
 * results card's numbers. Same shape as progression.resultsSummary() plus `opponent`.
 * @typedef {Object} MatchSummary
 * @property {number} before  @property {number} after  @property {number} delta
 * @property {boolean} pro  @property {boolean} becamePro  @property {boolean} lostPro
 * @property {number} bestBefore  @property {number} bestAfter
 * @property {Array<{id:string, name:string, color:string, at:number}>} unlocked  glove colours opened by this bout
 * @property {null|{id:string, ratingBefore:number|null, ratingAfter:number|null, rematch:boolean, beaten:boolean,
 *           wins:number, losses:number, draws:number}} opponent
 */

/**
 * @typedef {Object} Settings
 * @property {number} schema
 * @property {number} rev             settings revision (SETTINGS_REV): 2 = the tracking model may be 'auto'; 3 = sensitivity default 0.6
 * @property {string|null} cameraDeviceId
 * @property {'auto'|'full'|'lite'} model  pose model: 'auto' (default) = full, lite while the machine can't keep up (PERF-06)
 * @property {number} sensitivity      0..1 punch sensitivity (0.5 = the recognizer's base thresholds, the default 0.6 a notch
 *                                     easier; higher = easier punches)
 * @property {{master:number, sfx:number, music:number, voice:number}} volumes   0..1 each
 * @property {boolean} mirror          mirror webcam previews
 * @property {boolean} showSkeleton    webcam picture-in-picture with skeleton during play
 * @property {boolean} pipLarge        that picture bigger (e.g. for recording a demo)
 * @property {boolean} keyboardAssist  keyboard punches/guard also work in camera mode
 * @property {'camera'|'keyboard'} inputMode
 * @property {boolean} reducedMotion
 * @property {string|null} lastProfileId
 */

/**
 * @typedef {Object} SaveResult
 * @property {boolean} ok          false only for invalid arguments / unknown profile (a programming error)
 * @property {boolean} saved       true only if the change is durably in the backend
 * @property {string} [error]      human-readable reason when not saved
 * @property {'quota'|'unavailable'|'corrupt'|'unknown'} [errorCode]
 * @property {'guest'|'portable'} [reason]   set when not saved because the profile kind never saves (SAV01)
 * @property {boolean} [duplicate] the result id was already applied (SES02) — nothing changed
 * @property {Profile} [profile]   fresh copy of the profile after the change
 */

export const DEFAULT_APPEARANCE = Object.freeze({
  skin: '#eec1a0',
  hair: Object.freeze({ style: 'crew', color: '#4a2f22' }),
  eyes: 'oval',
  brows: 'flat',
  mouth: 'smile',
  nose: 'button',
  accessory: 'none',
  top: '#3d7bff',
  trunks: '#1f3b73',
  trim: '#ffd166',
  gloves: '#ff6b5a',
  shoes: '#f7f3ea',
  build: 'average',
  height: 1,
});

/** Distinct, friendly looks handed to guests (cycled), so several guests are told apart. */
export const GUEST_LOOKS = Object.freeze([
  { skin: '#d9a07a', hair: { style: 'buzz', color: '#1d1a19' }, top: '#2bb3a3', trunks: '#14182b', trim: '#ffc94a', gloves: '#ff4d5e' },
  { skin: '#f6d7c3', hair: { style: 'ponytail', color: '#b8432f' }, top: '#c77dff', trunks: '#2d3a66', trim: '#f7f3ea', gloves: '#3d7bff' },
  { skin: '#8d5a3b', hair: { style: 'afro', color: '#1d1a19' }, top: '#ffd166', trunks: '#ff6b5a', trim: '#14182b', gloves: '#2bb3a3' },
  { skin: '#b97a52', hair: { style: 'spiky', color: '#d8b26a' }, top: '#9be564', trunks: '#3d7bff', trim: '#fffaf0', gloves: '#ff8a5b' },
]);

/**
 * Settings revision. 2 (PERF-06): the tracking model has an 'auto' choice, the new default. Settings saved before
 * (no `rev`) hold model 'full' whenever anything was saved, because 'full' was the default — that 'full' becomes
 * 'auto'; an older 'lite' was a real choice and stays. From rev 2 on, an explicit 'full' is kept.
 * 3 (2026-11-13): the default punch sensitivity is a notch less strict, 0.6 (was 0.5 — a player found the old default a
 * little strict and always moved it up one step). A 0.5 saved before rev 3 was the old default (saving any setting
 * stores them all), so it moves to 0.6; any other value was a real choice and stays. From rev 3 on, an explicit 0.5 is kept.
 */
export const SETTINGS_REV = 3;

export const DEFAULT_SETTINGS = Object.freeze({
  schema: SCHEMA_VERSION,
  rev: SETTINGS_REV,
  cameraDeviceId: null,
  model: 'auto',
  sensitivity: 0.6,
  volumes: Object.freeze({ master: 0.8, sfx: 0.9, music: 0.6, voice: 0.9 }),
  mirror: true,
  showSkeleton: true,
  pipLarge: false,
  keyboardAssist: false,
  inputMode: 'camera',
  reducedMotion: false,
  lastProfileId: null,
});

const MEDAL_ORDER = [Medal.NONE, Medal.BRONZE, Medal.SILVER, Medal.GOLD, Medal.PLATINUM];
const TRAINING_KINDS = [TrainingKind.BAG, TrainingKind.DODGE, TrainingKind.MITTS];
const HEX = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const OPP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const validOpponentId = (id) => typeof id === 'string' && OPP_ID_RE.test(id) && isSafeOpponentId(id);

// ───────────────────────────── small pure helpers ─────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nonNegInt = (v) => (finite(v) && v > 0 ? Math.floor(v) : 0);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Rank of a medal (none=0 … platinum=4); unknown → 0. */
export function medalRank(medal) {
  const i = MEDAL_ORDER.indexOf(medal);
  return i < 0 ? 0 : i;
}
/** The better of two medals. */
export function betterMedal(a, b) {
  return medalRank(b) > medalRank(a) ? (MEDAL_ORDER[medalRank(b)]) : MEDAL_ORDER[medalRank(a)];
}

let graphemeSegmenter;
/**
 * A string split into user-perceived characters (grapheme clusters: a family emoji, a rainbow flag or a
 * Devanagari conjunct each count once), via Intl.Segmenter where the engine has it, else into code points.
 * @returns {string[]}
 */
export function graphemes(s) {
  const str = typeof s === 'string' ? s : '';
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    } catch { graphemeSegmenter = null; }
  }
  if (graphemeSegmenter) {
    try { return Array.from(graphemeSegmenter.segment(str), (x) => x.segment); } catch { /* fall through */ }
  }
  return Array.from(str);
}

/**
 * The first `max` user-perceived characters of a name (never half an emoji sequence), and never
 * more than STORAGE_LIMITS.nameMaxCodePoints code points. The profile editor uses it as you type.
 */
export function clampName(s, max = STORAGE_LIMITS.nameMaxLength) {
  let cps = 0;
  const out = [];
  for (const g of graphemes(s)) {
    if (out.length >= max) break;
    cps += Array.from(g).length;
    if (cps > STORAGE_LIMITS.nameMaxCodePoints) break;
    out.push(g);
  }
  return out.join('');
}

const JOINERS_AT_ENDS = /^[\u200c\u200d]+|[\u200c\u200d]+$/g;
const VISIBLE = /[^\s\p{M}\p{Cf}]/u; // anything but spaces, combining marks and format characters

/**
 * Clean a display name (FLOWS-11). Strings only (anything else → fallback, never "[object Object]").
 * Removes control characters, zero-width spaces, direction marks and overrides and the BOM, but
 * KEEPS the joiners U+200C/U+200D inside a name — composite emoji and Persian or Indic spellings
 * need them (only those at the ends are trimmed). Collapses spaces, keeps ≤ nameMaxLength
 * user-perceived characters (clampName) and falls back when nothing visible is left.
 */
export function sanitizeName(name, fallback = 'Boxer') {
  if (typeof name !== 'string') return fallback;
  const s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(JOINERS_AT_ENDS, '')
    .trim();
  const out = clampName(s).trim().replace(JOINERS_AT_ENDS, '').trim();
  return VISIBLE.test(out) ? out : fallback;
}

/**
 * Validate an Appearance against APPEARANCE_OPTIONS; every invalid/missing field falls back.
 * @param {any} a
 * @param {import('./types.js').Appearance} [fallback]
 * @returns {import('./types.js').Appearance}
 */
export function sanitizeAppearance(a, fallback = DEFAULT_APPEARANCE) {
  const src = isObj(a) ? a : {};
  const fb = isObj(fallback) ? fallback : DEFAULT_APPEARANCE;
  const O = APPEARANCE_OPTIONS;
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
  const hair = isObj(src.hair) ? src.hair : {};
  const fbHair = isObj(fb.hair) ? fb.hair : DEFAULT_APPEARANCE.hair;
  return {
    skin: hex(src.skin, fb.skin),
    hair: { style: pick(hair.style, O.hairStyles, fbHair.style), color: hex(hair.color, fbHair.color) },
    eyes: pick(src.eyes, O.eyes, fb.eyes),
    brows: pick(src.brows, O.brows, fb.brows),
    mouth: pick(src.mouth, O.mouths, fb.mouth),
    nose: pick(src.nose, O.noses, fb.nose),
    accessory: pick(src.accessory, O.accessories, fb.accessory),
    top: src.top === 'none' ? 'none' : hex(src.top, fb.top),
    trunks: hex(src.trunks, fb.trunks),
    trim: hex(src.trim, fb.trim),
    gloves: hex(src.gloves, fb.gloves),
    shoes: hex(src.shoes, fb.shoes),
    build: pick(src.build, O.builds, fb.build),
    height: clamp(finite(src.height) ? src.height : (finite(fb.height) ? fb.height : 1), 0.9, 1.1),
  };
}

/** Copy only JSON-safe data (numbers, strings, booleans, nulls, plain objects/arrays), depth-limited. */
function jsonSafe(v, depth = 0) {
  if (depth > 4) return undefined;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => jsonSafe(x, depth + 1)).filter((x) => x !== undefined);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).slice(0, 64)) {
      const x = jsonSafe(v[k], depth + 1);
      if (x !== undefined) out[k] = x;
    }
    return out;
  }
  return undefined;
}

/**
 * Validate a Calibration (core fields must be finite and plausible; extra JSON-safe fields
 * added by the gesture module are kept). Invalid → null (the player simply re-calibrates).
 */
export function sanitizeCalibration(c) {
  if (!isObj(c)) return null;
  const inRange = (v, lo, hi) => finite(v) && v >= lo && v <= hi;
  if (!inRange(c.shoulderWidth, 1e-4, 4)) return null;
  if (!inRange(c.armLengthWorld, 0.01, 5)) return null;
  if (!isObj(c.neutralHead) || !inRange(c.neutralHead.x, -2, 3) || !inRange(c.neutralHead.y, -2, 3)) return null;
  if (!inRange(c.neutralShoulderY, -2, 3)) return null;
  // (a `stance` recorded by builds before 2026-11-10 is dropped: the stance choice is gone, every boxer is orthodox)
  const { stance: _oldStance, ...extra } = jsonSafe(c) || {};
  return {
    ...extra,
    version: finite(c.version) ? c.version : 1,
    shoulderWidth: c.shoulderWidth,
    armLengthWorld: c.armLengthWorld,
    neutralHead: { x: c.neutralHead.x, y: c.neutralHead.y },
    neutralShoulderY: c.neutralShoulderY,
    swapSides: !!c.swapSides,
    createdAt: finite(c.createdAt) ? c.createdAt : 0,
  };
}

function emptyTrainingRecord() {
  return { best: 0, medal: Medal.NONE, plays: 0, history: [] };
}

/** Fresh, empty records object. */
export function emptyRecords() {
  return {
    matches: { wins: 0, losses: 0, draws: 0, kos: 0, history: [] },
    versus: { wins: 0, losses: 0, draws: 0, kos: 0 },
    training: { bag: emptyTrainingRecord(), dodge: emptyTrainingRecord(), mitts: emptyTrainingRecord() },
    applied: [],
  };
}

const METHODS = Object.values(ResultMethod);

function sanitizeMatchRecord(m) {
  if (!isObj(m) || typeof m.id !== 'string' || !m.id) return null;
  const skillBefore = finite(m.skillBefore) ? m.skillBefore : 0;
  const skillAfter = finite(m.skillAfter) ? m.skillAfter : skillBefore;
  return {
    id: m.id.slice(0, 80),
    t: finite(m.t) ? m.t : 0,
    mode: m.mode === 'versus' ? 'versus' : 'single',
    side: m.side === 'p2' ? 'p2' : 'p1',
    opponentId: typeof m.opponentId === 'string' ? m.opponentId.slice(0, 64) : null,
    opponentName: typeof m.opponentName === 'string' ? sanitizeName(m.opponentName, '') || null : null,
    outcome: ['win', 'loss', 'draw'].includes(m.outcome) ? m.outcome : 'draw',
    method: METHODS.includes(m.method) ? m.method : ResultMethod.DECISION,
    endRound: nonNegInt(m.endRound),
    skillBefore,
    skillAfter,
    delta: finite(m.delta) ? m.delta : skillAfter - skillBefore,
    pro: !!m.pro,
    opponentRating: finite(m.opponentRating) ? clamp(Math.round(m.opponentRating), 0, STORAGE_LIMITS.skillMax) : null,
    rematch: m.rematch === true,
  };
}

/**
 * Keep the newest STORAGE_LIMITS.matchHistory single-player entries and the newest
 * STORAGE_LIMITS.versusHistory versus entries, in their original (oldest-first) order.
 * @param {MatchRecord[]} list
 */
function capMatchHistory(list) {
  let singles = 0;
  let versus = 0;
  const keep = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const isVersus = list[i].mode === 'versus';
    if (isVersus ? versus++ < STORAGE_LIMITS.versusHistory : singles++ < STORAGE_LIMITS.matchHistory) keep.push(list[i]);
  }
  return keep.reverse();
}

/**
 * Validate per-opponent progress ({[id]: OpponentState}); unknown shapes are dropped.
 * @returns {Record<string, import('../game/progression.js').OpponentState>}
 */
export function sanitizeOpponents(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (Object.keys(out).length >= STORAGE_LIMITS.opponents) break;
    if (!validOpponentId(id)) continue;
    const st = sanitizeOpponentState(raw[id]);
    if (st) out[id] = { ...st, rating: st.rating == null ? null : clamp(st.rating, 0, STORAGE_LIMITS.skillMax) };
  }
  return out;
}

function sanitizeTrainingRecord(r) {
  const out = emptyTrainingRecord();
  if (!isObj(r)) return out;
  out.best = finite(r.best) && r.best > 0 ? r.best : 0;
  out.medal = MEDAL_ORDER.includes(r.medal) ? r.medal : Medal.NONE;
  out.plays = nonNegInt(r.plays);
  if (Array.isArray(r.history)) {
    out.history = r.history
      .filter((h) => isObj(h) && typeof h.id === 'string' && finite(h.score))
      .map((h) => ({ id: h.id.slice(0, 80), t: finite(h.t) ? h.t : 0, score: h.score, medal: MEDAL_ORDER.includes(h.medal) ? h.medal : Medal.NONE }))
      .slice(-STORAGE_LIMITS.trainingHistory);
  }
  out.plays = Math.max(out.plays, out.history.length);
  return out;
}

/** Validate a records object; anything malformed is reset to empty for that section. */
export function sanitizeRecords(r) {
  const out = emptyRecords();
  if (!isObj(r)) return out;
  const m = isObj(r.matches) ? r.matches : {};
  out.matches.wins = nonNegInt(m.wins);
  out.matches.losses = nonNegInt(m.losses);
  out.matches.draws = nonNegInt(m.draws);
  out.matches.kos = nonNegInt(m.kos);
  if (Array.isArray(m.history)) out.matches.history = capMatchHistory(m.history.map(sanitizeMatchRecord).filter(Boolean));
  const v = isObj(r.versus) ? r.versus : {};
  out.versus = { wins: nonNegInt(v.wins), losses: nonNegInt(v.losses), draws: nonNegInt(v.draws), kos: nonNegInt(v.kos) };
  const t = isObj(r.training) ? r.training : {};
  for (const k of TRAINING_KINDS) out.training[k] = sanitizeTrainingRecord(t[k]);
  if (Array.isArray(r.applied)) out.applied = r.applied.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 80)).slice(-STORAGE_LIMITS.appliedIds);
  return out;
}

/**
 * Validate a whole profile. Returns null if it is not recognisably a profile.
 * @param {any} raw
 * @param {{kind?:string, id?:string, now?:number}} [opts]  forced kind/id
 * @returns {Profile|null}
 */
export function sanitizeProfile(raw, opts = {}) {
  if (!isObj(raw)) return null;
  const id = opts.id ?? (typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null);
  if (!id) return null;
  const kinds = Object.values(ProfileKind);
  const kind = opts.kind ?? (kinds.includes(raw.kind) ? raw.kind : ProfileKind.LOCAL);
  const now = finite(opts.now) ? opts.now : 0;
  const skill = finite(raw.skill) ? clamp(Math.round(raw.skill), 0, STORAGE_LIMITS.skillMax) : 0;
  const records = sanitizeRecords(raw.records);
  const sourceId = typeof raw.sourceId === 'string' && ID_RE.test(raw.sourceId) ? raw.sourceId : null;
  // Progression fields (alignment pass). Missing on profiles saved before it → derived here.
  const singles = records.matches.history.some((h) => h.mode !== 'versus')
    || records.matches.wins + records.matches.losses + records.matches.draws > 0;
  const opponents = isObj(raw.opponents)
    ? sanitizeOpponents(raw.opponents)
    : sanitizeOpponents(deriveOpponentStates(records.matches.history, sourceId ?? id));
  const p = {
    schema: SCHEMA_VERSION,
    id,
    name: sanitizeName(raw.name),
    kind,
    appearance: sanitizeAppearance(raw.appearance),
    calibration: sanitizeCalibration(raw.calibration),
    skill,
    pro: isPro(skill),
    bestRating: clamp(bestRatingOf({ skill, bestRating: finite(raw.bestRating) ? raw.bestRating : 0, records }), 0, STORAGE_LIMITS.skillMax),
    tutorialDone: typeof raw.tutorialDone === 'boolean' ? raw.tutorialDone : singles,
    opponents,
    records,
    createdAt: finite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: finite(raw.updatedAt) ? raw.updatedAt : now,
  };
  if (sourceId) p.sourceId = sourceId;
  return p;
}

/** Validate settings; unknown/invalid values fall back to DEFAULT_SETTINGS. */
export function sanitizeSettings(raw) {
  const s = isObj(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const vol = isObj(s.volumes) ? s.volumes : {};
  const v01 = (x, dv) => (finite(x) ? clamp(x, 0, 1) : dv);
  const bool = (x, dv) => (typeof x === 'boolean' ? x : dv);
  // PERF-06 migration (SETTINGS_REV): an unversioned 'full' was the old default → 'auto'
  const rev = finite(s.rev) ? s.rev : 1;
  const model = s.model === 'auto' || s.model === 'lite' ? s.model
    : s.model === 'full' ? (rev >= 2 ? 'full' : 'auto') : d.model;
  return {
    schema: SCHEMA_VERSION,
    rev: SETTINGS_REV,
    cameraDeviceId: typeof s.cameraDeviceId === 'string' && s.cameraDeviceId.length <= 512 ? s.cameraDeviceId : null,
    model,
    // (rev 3: a 0.5 saved before was the old default — see SETTINGS_REV)
    sensitivity: rev < 3 && finite(s.sensitivity) && Math.abs(s.sensitivity - 0.5) < 1e-6 ? d.sensitivity : v01(s.sensitivity, d.sensitivity),
    volumes: {
      master: v01(vol.master, d.volumes.master),
      sfx: v01(vol.sfx, d.volumes.sfx),
      music: v01(vol.music, d.volumes.music),
      voice: v01(vol.voice, d.volumes.voice),
    },
    mirror: bool(s.mirror, d.mirror),
    showSkeleton: bool(s.showSkeleton, d.showSkeleton),
    pipLarge: bool(s.pipLarge, d.pipLarge),
    keyboardAssist: bool(s.keyboardAssist, d.keyboardAssist),
    inputMode: s.inputMode === 'keyboard' ? 'keyboard' : s.inputMode === 'camera' ? 'camera' : d.inputMode,
    reducedMotion: bool(s.reducedMotion, d.reducedMotion),
    lastProfileId: typeof s.lastProfileId === 'string' && ID_RE.test(s.lastProfileId) ? s.lastProfileId : null,
  };
}

/** Map a thrown storage error to a code + readable message. */
export function classifyStorageError(e) {
  const name = e && typeof e === 'object' ? String(e.name || '') : '';
  const code = e && typeof e === 'object' ? e.code : undefined;
  const msg = e && typeof e === 'object' && e.message ? String(e.message) : String(e ?? 'unknown error');
  if (/quota/i.test(name) || /quota/i.test(msg) || code === 22 || code === 1014) {
    return { code: 'quota', error: 'Browser storage is full, so progress could not be saved.' };
  }
  if (/security|notallowed|invalidaccess/i.test(name) || /denied|disabled|insecure|access/i.test(msg)) {
    return { code: 'unavailable', error: 'Browser storage is turned off (private mode or blocked site data), so progress could not be saved.' };
  }
  return { code: 'unknown', error: `Progress could not be saved (${msg.slice(0, 120)}).` };
}

const UNAVAILABLE = Object.freeze({ code: 'unavailable', error: 'Browser storage is not available here, so progress is kept only until you close the game.' });
const DELETED_ELSEWHERE = Object.freeze({ code: 'deleted', error: 'This boxer was deleted in another window of the game, so nothing was saved.' });

let idCounter = 0;
function defaultIdGen(prefix) {
  idCounter = (idCounter + 1) % 1679616;
  let rnd = '';
  try {
    if (globalThis.crypto?.getRandomValues) {
      const a = new Uint32Array(2);
      globalThis.crypto.getRandomValues(a);
      rnd = a[0].toString(36) + a[1].toString(36);
    }
  } catch { /* fall through */ }
  if (!rnd) rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd.slice(0, 8)}`;
}

// ───────────────────────────── Storage ─────────────────────────────

export class Storage {
  /**
   * @param {Object} [opts]
   * @param {any} [opts.backend]   localStorage-like object; omitted → globalThis.localStorage (if usable);
   *                               null → memory only (nothing persists, every save reports saved:false)
   * @param {() => number} [opts.now]
   * @param {(prefix:string) => string} [opts.idGen]
   * @param {boolean} [opts.watch]  follow other tabs through window 'storage' events (default: when
   *                               the backend is window.localStorage; tests call syncExternal by hand)
   */
  constructor({ backend, now, idGen, watch } = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._idGen = typeof idGen === 'function' ? idGen : defaultIdGen;
    if (backend === undefined) {
      try { backend = globalThis.localStorage ?? null; } catch { backend = null; }
    }
    /** @type {any} */
    this._backend = backend && typeof backend.getItem === 'function' && typeof backend.setItem === 'function' ? backend : null;
    /** @type {Map<string, Profile>} local profiles (mirror of the backend, plus unsaved ones) */
    this._local = new Map();
    /** @type {string[]} local profile order */
    this._order = [];
    /** @type {Map<string, Profile>} guest + portable profiles (this session only, never written) */
    this._session = new Map();
    /** @type {Set<string>} local profile ids whose latest state is not yet in the backend */
    this._dirty = new Set();
    this._indexDirty = false;
    this._settings = sanitizeSettings(null);
    this._settingsDirty = false;
    /** settings keys this tab changed and has not written yet (re-applied over a fresh read) */
    this._settingsPatch = null;
    // FLOWS-04: the raw JSON last read from / written to the backend, to notice another tab's writes
    /** @type {Map<string, string>} local profile id → raw JSON */
    this._raw = new Map();
    /** @type {string|null|undefined} */
    this._rawIndex = undefined;
    /** @type {string|null|undefined} */
    this._rawSettings = undefined;
    /** @type {Set<string>} local profile ids another tab deleted (later writes say so) */
    this._gone = new Set();
    /** @type {Set<string>} local profile ids deleted here or elsewhere: never adopted again from the index */
    this._dropped = new Set();
    /** @type {Set<(change:{key:string|null, ids:string[]}) => void>} */
    this._listeners = new Set();
    this._onStorage = null;
    this._guestCount = 0;
    /** @type {Array<{key:string, code:string, message:string, quarantinedAs:string|null}>} */
    this._issues = [];
    this._lastError = null;
    this._writable = !!this._backend;
    this._load();
    this._watch(watch);
  }

  // ── other tabs (FLOWS-04) ──

  /**
   * Another tab changed the shared backend: re-read what it changed. Called with each window
   * 'storage' event's key (null = storage cleared or unknown → everything); wired automatically
   * when the backend is window.localStorage, callable by hand (tests). A boxer saved elsewhere is
   * adopted (unless this tab holds an unsaved change of it), one deleted elsewhere is forgotten,
   * new boxers appear, settings follow (this tab's unsaved keys stay on top). Subscribers hear
   * about every change. Never throws.
   * @param {string|null} [key]
   * @returns {boolean} whether this tab's view changed
   */
  syncExternal(key = null) {
    try {
      if (!this._backend) return false;
      if (key != null && (typeof key !== 'string' || !key.startsWith(STORAGE_PREFIX))) return false;
      const ids = [];
      let changed = false;
      if (key == null || key === STORAGE_KEYS.settings) changed = this._refreshSettings() || changed;
      if (key == null || key === STORAGE_KEYS.index || key.startsWith(STORAGE_KEYS.profilePrefix)) {
        const before = this._order.join('|');
        if (this._syncIndex() || this._order.join('|') !== before) changed = true;
      }
      const which = key == null ? [...this._order] : key.startsWith(STORAGE_KEYS.profilePrefix) ? [key.slice(STORAGE_KEYS.profilePrefix.length)] : [];
      for (const id of which) {
        if (this._local.has(id) && this._refreshProfile(id) !== 'same') { changed = true; ids.push(id); }
      }
      if (changed) this._emit({ key, ids });
      return changed;
    } catch (e) {
      this._lastError = classifyStorageError(e).error;
      return false;
    }
  }

  /**
   * Hear about changes made by other tabs (syncExternal) and about boxers found deleted elsewhere
   * while saving. @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  /** Stop following other tabs and drop subscribers. */
  dispose() {
    if (this._onStorage) {
      try { globalThis.removeEventListener?.('storage', this._onStorage); } catch { /* ignore */ }
      this._onStorage = null;
    }
    this._listeners.clear();
  }

  _watch(watch) {
    const g = globalThis;
    if (watch === false || !this._backend || typeof g.addEventListener !== 'function') return;
    let shared = false;
    try { shared = this._backend === g.localStorage; } catch { shared = false; }
    if (!shared && watch !== true) return;
    this._onStorage = (e) => {
      if (!e || (e.storageArea && e.storageArea !== this._backend)) return;
      this.syncExternal(typeof e.key === 'string' ? e.key : null);
    };
    try { g.addEventListener('storage', this._onStorage); } catch { this._onStorage = null; }
  }

  _emit(change) {
    for (const fn of [...this._listeners]) {
      try { fn(change); } catch (e) { console.warn('[storage] change listener failed', e); }
    }
  }

  // ── status ──

  /** @returns {{available:boolean, writable:boolean, issues:Array<{key:string,code:string,message:string,quarantinedAs:string|null}>, lastError:string|null}} */
  status() {
    return { available: !!this._backend, writable: this._writable, issues: this._issues.map((x) => ({ ...x })), lastError: this._lastError };
  }

  // ── profiles ──

  /** Local profiles (copies), in display order — boxers another tab added or deleted included (FLOWS-04). */
  listProfiles() {
    try { this._syncIndex(); } catch { /* keep the mirror */ }
    return this._order.map((id) => this._local.get(id)).filter(Boolean).map(clone);
  }

  /** Guest/portable profiles created this session (copies). */
  sessionProfiles() {
    return [...this._session.values()].map(clone);
  }

  /** Any profile by id (local or session), as a copy; null if unknown. */
  getProfile(id) {
    const p = this._find(id);
    return p ? clone(p) : null;
  }

  /**
   * Create a LOCAL profile. Records start empty and skill at 0.
   * @param {{name?:string, appearance?:object, calibration?:object}} data
   * @returns {SaveResult}
   */
  createProfile(data = {}) {
    return this._safe(() => {
      this._syncIndex(); // boxers another tab made count too (FLOWS-04)
      if (this._local.size >= STORAGE_LIMITS.maxProfiles) {
        return { ok: false, saved: false, error: `You can keep up to ${STORAGE_LIMITS.maxProfiles} boxers. Delete one to make room.` };
      }
      const src = isObj(data) ? data : {};
      let id = '';
      for (let i = 0; i < 8 && (!id || !ID_RE.test(id) || this._find(id)); i++) id = String(this._idGen('p'));
      if (!ID_RE.test(id) || this._find(id)) id = `p_${this._now().toString(36)}_${this._local.size + 1}`;
      const t = this._now();
      const p = sanitizeProfile({
        name: src.name, appearance: src.appearance, calibration: src.calibration,
        skill: 0, pro: false, bestRating: 0, tutorialDone: false, opponents: {}, records: emptyRecords(), createdAt: t, updatedAt: t,
      }, { kind: ProfileKind.LOCAL, id, now: t });
      if (!p) return { ok: false, saved: false, error: 'Could not create the profile.' };
      this._local.set(p.id, p);
      this._order.push(p.id);
      this._indexDirty = true;
      return this._commit(p);
    });
  }

  /**
   * Update name / appearance / calibration, and (debug / tests) skill, tutorialDone,
   * bestRating or opponents. `pro` is accepted for compatibility but always follows the rating
   * (progression.isPro: 1000 or more); bestRating never drops below the rating.
   * @returns {SaveResult}
   */
  updateProfile(id, patch = {}) {
    return this._safe(() => {
      const w = this._forWrite(id);
      if (!w.p) return w.res;
      const p = w.p;
      const src = isObj(patch) ? patch : {};
      if ('name' in src) p.name = sanitizeName(src.name, p.name);
      if ('appearance' in src) p.appearance = sanitizeAppearance(src.appearance, p.appearance);
      if ('calibration' in src) p.calibration = src.calibration === null ? null : (sanitizeCalibration(src.calibration) ?? p.calibration);
      if ('skill' in src && finite(src.skill)) p.skill = clamp(Math.round(src.skill), 0, STORAGE_LIMITS.skillMax);
      if ('tutorialDone' in src && typeof src.tutorialDone === 'boolean') p.tutorialDone = src.tutorialDone;
      if ('opponents' in src && isObj(src.opponents)) p.opponents = sanitizeOpponents(src.opponents);
      if ('bestRating' in src && finite(src.bestRating)) p.bestRating = clamp(Math.round(src.bestRating), 0, STORAGE_LIMITS.skillMax);
      p.pro = isPro(p.skill);
      p.bestRating = Math.max(p.bestRating || 0, p.skill);
      p.updatedAt = this._now();
      return this._commit(p);
    });
  }

  /**
   * The first-bout tutorial (research/mechanics.md §8) was finished or skipped: never run it
   * again for this boxer. Local profiles are saved; guest/visiting ones change in memory only.
   * Already marked → {ok, saved, duplicate:true} without a write.
   * @returns {SaveResult}
   */
  markTutorialDone(profileId) {
    return this._safe(() => {
      const w = this._forWrite(profileId);
      if (!w.p) return w.res;
      const p = w.p;
      if (p.tutorialDone === true) return this._duplicate(p);
      p.tutorialDone = true;
      p.updatedAt = this._now();
      return this._commit(p);
    });
  }

  /**
   * Delete a profile. For LOCAL profiles this erases its records from the backend too,
   * including quarantined copies (SAV01).
   * @returns {SaveResult}
   */
  deleteProfile(id) {
    return this._safe(() => {
      const sessionProfile = this._session.get(id);
      if (sessionProfile) {
        this._session.delete(id);
        return { ok: true, saved: false, reason: sessionProfile.kind };
      }
      if (!this._local.has(id)) return { ok: false, saved: false, error: 'Unknown profile.' };
      this._forget(id);
      this._refreshSettings(); // another tab may have picked a different boxer meanwhile (FLOWS-04)
      if (this._settings.lastProfileId === id) this._patchSettings({ lastProfileId: null });
      if (!this._backend) return { ok: true, saved: false, error: UNAVAILABLE.error, errorCode: UNAVAILABLE.code };
      const key = STORAGE_KEYS.profile(id);
      const r1 = this._remove(key);
      for (const k of this._keys()) {
        if (k.startsWith(STORAGE_KEYS.quarantinePrefix + 'profile:' + id + ':')) this._remove(k);
      }
      this._indexDirty = true;
      this._flushIndex(); // a stale index entry is harmless: missing profile keys are dropped on load
      if (this._settingsDirty) this._flushSettings();
      if (!r1.ok) return { ok: true, saved: false, error: r1.error, errorCode: r1.code };
      return { ok: true, saved: true };
    });
  }

  /**
   * A new ephemeral guest profile (never saved). Each call makes a distinct guest.
   * @param {{name?:string, appearance?:object}} [data]
   * @returns {Profile}
   */
  guest(data = {}) {
    const src = isObj(data) ? data : {};
    const n = ++this._guestCount;
    const look = GUEST_LOOKS[(n - 1) % GUEST_LOOKS.length];
    const base = sanitizeAppearance({ ...DEFAULT_APPEARANCE, ...look, hair: { ...look.hair } });
    const t = this._now();
    let id = String(this._idGen('guest'));
    if (!ID_RE.test(id) || this._find(id)) id = `guest_${t.toString(36)}_${n}`;
    const p = sanitizeProfile({
      id, name: src.name ?? (n === 1 ? 'Guest' : `Guest ${n}`),
      appearance: src.appearance ? sanitizeAppearance(src.appearance, base) : base,
      skill: 0, pro: false, bestRating: 0, tutorialDone: false, opponents: {}, records: emptyRecords(), createdAt: t, updatedAt: t,
    }, { kind: ProfileKind.GUEST, now: t });
    this._session.set(p.id, p);
    return clone(p);
  }

  /**
   * Portable profile JSON for carrying a boxer to another device (SET01).
   * @returns {string|null} null if the profile is unknown
   */
  exportProfile(id) {
    const p = this._find(id);
    if (!p) return null;
    const payload = {
      format: PORTABLE_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: this._now(),
      profile: {
        sourceId: p.sourceId ?? p.id,
        name: p.name,
        appearance: p.appearance,
        calibration: p.calibration,
        skill: p.skill,
        pro: p.pro,
        bestRating: p.bestRating,
        tutorialDone: p.tutorialDone,
        opponents: p.opponents,
        records: { ...p.records, applied: [] },
        createdAt: p.createdAt,
      },
    };
    return JSON.stringify(payload);
  }

  /**
   * Import a portable profile (JSON string or parsed object). The result is an in-memory
   * profile of kind 'portable' that is never written to storage (SAV01). Importing the same
   * portable twice returns the existing session copy.
   * @returns {{ok:boolean, profile?:Profile, error?:string}}
   */
  importPortable(json) {
    try {
      let data = json;
      if (typeof json === 'string') {
        if (json.length > STORAGE_LIMITS.importMaxBytes) return { ok: false, error: 'That file is too big to be a boxer profile.' };
        try { data = JSON.parse(json); } catch { return { ok: false, error: "That doesn't look like a Glove Up boxer file (it isn't valid JSON)." }; }
      }
      if (!isObj(data)) return { ok: false, error: "That doesn't look like a Glove Up boxer file." };
      let raw = data;
      if (data.format !== undefined || data.profile !== undefined) {
        if (data.format !== PORTABLE_FORMAT || !isObj(data.profile)) return { ok: false, error: "That doesn't look like a Glove Up boxer file." };
        if (finite(data.version) && data.version > SCHEMA_VERSION) return { ok: false, error: 'That boxer file comes from a newer version of the game.' };
        raw = data.profile;
      }
      if (typeof raw.name !== 'string' || !isObj(raw.appearance)) return { ok: false, error: 'That boxer file is missing a name or a look.' };
      const sourceId = typeof raw.sourceId === 'string' && ID_RE.test(raw.sourceId) ? raw.sourceId
        : typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
      if (sourceId) {
        for (const p of this._session.values()) {
          if (p.kind === ProfileKind.PORTABLE && p.sourceId === sourceId) return { ok: true, profile: clone(p) };
        }
      }
      const t = this._now();
      let id = String(this._idGen('portable'));
      if (!ID_RE.test(id) || this._find(id)) id = `portable_${t.toString(36)}_${this._session.size + 1}`;
      const p = sanitizeProfile({ ...raw, id, sourceId: sourceId ?? undefined, createdAt: raw.createdAt ?? t, updatedAt: t }, { kind: ProfileKind.PORTABLE, id, now: t });
      if (!p) return { ok: false, error: "That doesn't look like a Glove Up boxer file." };
      p.records.applied = [];
      this._session.set(p.id, p);
      return { ok: true, profile: clone(p) };
    } catch (e) {
      return { ok: false, error: `Could not import that boxer (${String(e?.message ?? e).slice(0, 80)}).` };
    }
  }

  // ── records ──

  /**
   * Apply a finished match to a profile (idempotent by result.id — SES02). Everything below is
   * changed in one step and written with one setItem, or not at all:
   *  - single player: W/L/D/KO tally; the rating from skillUpdate.skill (progression.applyBout /
   *    applySkill; PRG02); pro = isPro(rating); bestRating; tutorialDone = true; the opponent's
   *    entry in profile.opponents (wins/losses/draws/beaten, and a raised rematch rating on a win —
   *    progression.opponentAfterBout); a history entry (skillBefore/After, opponentRating, rematch).
   *  - versus: the separate versus tally and a history entry; the rating is never touched.
   * Guest / visiting (portable) profiles change in memory only (SAV01).
   * @param {string} profileId
   * @param {import('./types.js').MatchResult} result
   * @param {null|{skill:number}} [skillUpdate]  any applyBout()/applySkill() result; only `skill` is read
   * @param {{side?:'p1'|'p2', opponentName?:string}} [opts]  which corner this profile fought in (default p1)
   * @returns {SaveResult & {outcome?:string, skillBefore?:number, skillAfter?:number, summary?:MatchSummary}}
   */
  recordMatch(profileId, result, skillUpdate = null, opts = {}) {
    return this._safe(() => {
      const w = this._forWrite(profileId);
      if (!w.p) return w.res;
      const p = w.p;
      if (!isObj(result) || typeof result.id !== 'string' || !result.id) return { ok: false, saved: false, error: 'Invalid match result.' };
      if (p.records.applied.includes(result.id)) return { ...this._duplicate(p), ...this._pastMatch(p, result.id) };
      const o = isObj(opts) ? opts : {};
      const side = o.side === 'p2' ? 'p2' : 'p1';
      const mode = result.mode === 'versus' ? 'versus' : 'single';
      const outcome = result.winner === side ? 'win' : (result.winner === 'p1' || result.winner === 'p2') ? 'loss' : 'draw';
      const method = METHODS.includes(result.method) ? result.method : ResultMethod.DECISION;
      const byKO = outcome === 'win' && (method === ResultMethod.KO || method === ResultMethod.TKO);
      const before = p.skill;
      const wasPro = p.pro;
      const bestBefore = p.bestRating;
      const tally = mode === 'single' ? p.records.matches : p.records.versus;
      if (outcome === 'win') tally.wins++;
      else if (outcome === 'loss') tally.losses++;
      else tally.draws++;
      if (byKO) tally.kos++;
      let opponent = null;
      if (mode === 'single') {
        if (isObj(skillUpdate) && finite(skillUpdate.skill)) {
          // FLOWS-04: an update computed from an older copy (another tab saved a bout since) is
          // applied as the change it is, never as an absolute rating that erases that bout
          const stale = finite(skillUpdate.before) && skillUpdate.before !== before;
          const next = stale ? before + (skillUpdate.skill - skillUpdate.before) : skillUpdate.skill;
          p.skill = clamp(Math.round(next), 0, STORAGE_LIMITS.skillMax);
        }
        p.pro = isPro(p.skill);
        p.bestRating = Math.max(p.bestRating, p.skill);
        p.tutorialDone = true;
        const oid = validOpponentId(result.opponentId) ? result.opponentId : null;
        if (oid) {
          const known = Object.prototype.hasOwnProperty.call(p.opponents, oid);
          const r = opponentAfterBout(known ? p.opponents[oid] : null, { key: profileKey(p), opponentId: oid, outcome });
          if (known || Object.keys(p.opponents).length < STORAGE_LIMITS.opponents) p.opponents[oid] = r.state;
          opponent = { id: oid, ratingBefore: r.ratingBefore, ratingAfter: r.ratingAfter, rematch: r.rematch, ...r.state };
        }
      }
      const opponentName = typeof o.opponentName === 'string' ? o.opponentName
        : isObj(result.opponent) && typeof result.opponent.name === 'string' ? result.opponent.name : null;
      const rec = sanitizeMatchRecord({
        id: result.id, t: this._now(), mode, side,
        opponentId: typeof result.opponentId === 'string' ? result.opponentId : null,
        opponentName, outcome, method, endRound: result.endRound,
        skillBefore: before, skillAfter: p.skill, delta: p.skill - before, pro: p.pro,
        opponentRating: opponent ? opponent.ratingBefore : null, rematch: opponent ? opponent.rematch : false,
      });
      p.records.matches.history.push(rec);
      p.records.matches.history = capMatchHistory(p.records.matches.history);
      this._markApplied(p, result.id);
      p.updatedAt = this._now();
      const summary = {
        before, after: p.skill, delta: p.skill - before, pro: p.pro, becamePro: p.pro && !wasPro, lostPro: wasPro && !p.pro,
        bestBefore, bestAfter: p.bestRating, unlocked: gloveUnlocksBetween(bestBefore, p.bestRating).map((u) => ({ ...u })), opponent,
      };
      return this._commit(p, { outcome, skillBefore: before, skillAfter: p.skill, summary });
    });
  }

  /**
   * Apply a finished training attempt (idempotent by result.id — SES02).
   * @param {string} profileId
   * @param {import('./types.js').TrainingResult} result
   * @returns {SaveResult & {newBest?:boolean, prevBest?:number, best?:number, medal?:string}}
   */
  recordTraining(profileId, result) {
    return this._safe(() => {
      const w = this._forWrite(profileId);
      if (!w.p) return w.res;
      const p = w.p;
      if (!isObj(result) || typeof result.id !== 'string' || !result.id) return { ok: false, saved: false, error: 'Invalid training result.' };
      if (!TRAINING_KINDS.includes(result.kind)) return { ok: false, saved: false, error: 'Unknown training activity.' };
      const rec = p.records.training[result.kind];
      if (p.records.applied.includes(result.id)) {
        return { ...this._duplicate(p), newBest: false, prevBest: rec.best, best: rec.best, medal: rec.medal };
      }
      const score = finite(result.score) ? Math.max(0, result.score) : 0;
      const medal = MEDAL_ORDER.includes(result.medal) ? result.medal : Medal.NONE;
      const prevBest = rec.best;
      const newBest = score > prevBest;
      if (newBest) rec.best = score;
      rec.medal = betterMedal(rec.medal, medal);
      rec.plays++;
      rec.history.push({ id: result.id.slice(0, 80), t: this._now(), score, medal });
      if (rec.history.length > STORAGE_LIMITS.trainingHistory) rec.history.splice(0, rec.history.length - STORAGE_LIMITS.trainingHistory);
      this._markApplied(p, result.id);
      p.updatedAt = this._now();
      return this._commit(p, { newBest, prevBest, best: rec.best, medal: rec.medal });
    });
  }

  // ── settings ──

  /** Current settings (copy, always valid). */
  settings() {
    return clone(this._settings);
  }

  /**
   * Merge a (partial) settings patch, validate and persist. Only the keys in the patch are written
   * over the latest stored settings, so another tab's changes survive (FLOWS-04).
   * @returns {{ok:boolean, saved:boolean, settings:Settings, error?:string, errorCode?:string}}
   */
  saveSettings(patch = {}) {
    const res = this._safe(() => {
      this._patchSettings(isObj(patch) ? patch : {});
      const w = this._flushSettings();
      return w.ok ? { ok: true, saved: true } : { ok: true, saved: false, error: w.error, errorCode: w.code };
    });
    return { ...res, settings: clone(this._settings) };
  }

  // ───────────────────────────── internals ─────────────────────────────

  _find(id) {
    if (typeof id !== 'string') return null;
    return this._local.get(id) ?? this._session.get(id) ?? null;
  }

  /**
   * The profile a write is about to change, re-read first if it is local (FLOWS-04).
   * @returns {{p: Profile} | {p: null, res: SaveResult}}
   */
  _forWrite(id) {
    const found = this._find(id);
    if (!found && this._gone.has(id)) return { p: null, res: { ok: false, saved: false, error: DELETED_ELSEWHERE.error, errorCode: DELETED_ELSEWHERE.code } };
    if (!found) return { p: null, res: { ok: false, saved: false, error: 'Unknown profile.' } };
    if (found.kind === ProfileKind.LOCAL && this._refreshProfile(id) === 'deleted') {
      this._emit({ key: STORAGE_KEYS.profile(id), ids: [id] });
      return { p: null, res: { ok: false, saved: false, error: DELETED_ELSEWHERE.error, errorCode: DELETED_ELSEWHERE.code } };
    }
    return { p: this._find(id) };
  }

  /**
   * FLOWS-04: re-read one local boxer before this tab changes it (and on a 'storage' event).
   * Another tab saved it → adopt that copy (unless this tab holds an unsaved change of it, which
   * the ERR04 retry still writes). Stored before and now gone from its key AND the index → it was
   * deleted elsewhere: forget it here. Never stored (an earlier write failed) → still ours to write.
   * @returns {'same'|'changed'|'deleted'}
   */
  _refreshProfile(id) {
    if (!this._backend || !this._local.has(id)) return 'same';
    const r = this._get(STORAGE_KEYS.profile(id));
    if (!r.ok) return 'same';
    const known = this._raw.get(id);
    if (r.value === known) return 'same';
    if (r.value == null) {
      if (known === undefined || this._indexLists(id) !== false) return 'same';
      this._forget(id, true);
      return 'deleted';
    }
    if (this._dirty.has(id)) return 'same';
    let p = null;
    try { p = sanitizeProfile(JSON.parse(r.value), { id, kind: ProfileKind.LOCAL, now: this._now() }); } catch { p = null; }
    if (!p) return 'same'; // damaged elsewhere: this copy is the good one and the next write repairs it
    this._local.set(id, p);
    this._raw.set(id, r.value);
    return 'changed';
  }

  /** Does the stored index list this id? null when it can't be read (then nothing is assumed). */
  _indexLists(id) {
    const r = this._get(STORAGE_KEYS.index);
    if (!r.ok || r.value == null) return null;
    try {
      const v = JSON.parse(r.value);
      return Array.isArray(v) ? v.includes(id) : null;
    } catch { return null; }
  }

  /** Drop a local profile from this tab's mirror (deleted here, or `elsewhere` by another tab). */
  _forget(id, elsewhere = false) {
    this._dropped.add(id);
    if (elsewhere) this._gone.add(id);
    this._local.delete(id);
    this._order = this._order.filter((x) => x !== id);
    this._dirty.delete(id);
    this._raw.delete(id);
  }

  /**
   * FLOWS-04: follow the stored index — adopt boxers another tab created (listed, key readable,
   * unknown here) and forget the ones it deleted (once stored, now in neither the index nor their
   * key). The stored order comes first; boxers made here and not yet listed keep their place after.
   * @returns {boolean} whether the set of boxers changed
   */
  _syncIndex() {
    if (!this._backend) return false;
    const r = this._get(STORAGE_KEYS.index);
    if (!r.ok || r.value === this._rawIndex) return false;
    this._rawIndex = r.value;
    if (r.value == null) return false; // no index stored (fresh, or cleared elsewhere): keep ours
    let stored;
    try { stored = JSON.parse(r.value); } catch { return false; }
    if (!Array.isArray(stored)) return false;
    const listed = stored.filter((x) => typeof x === 'string' && ID_RE.test(x));
    let changed = false;
    for (const id of [...this._order]) {
      if (listed.includes(id) || !this._raw.has(id)) continue;
      const k = this._get(STORAGE_KEYS.profile(id));
      if (k.ok && k.value == null) { this._forget(id, true); changed = true; }
    }
    for (const id of listed) {
      if (this._local.has(id) || this._dropped.has(id)) continue;
      const k = this._get(STORAGE_KEYS.profile(id));
      if (!k.ok || k.value == null) continue;
      let p = null;
      try { p = sanitizeProfile(JSON.parse(k.value), { id, kind: ProfileKind.LOCAL, now: this._now() }); } catch { p = null; }
      if (!p) continue;
      this._local.set(id, p);
      this._raw.set(id, k.value);
      this._order.push(id);
      changed = true;
    }
    const first = listed.filter((id) => this._local.has(id));
    const order = [...new Set([...first, ...this._order])];
    if (order.join('|') !== this._order.join('|')) this._order = order;
    return changed;
  }

  /** Apply a settings patch here and remember it until it is written (re-applied over a fresh read). */
  _patchSettings(src) {
    const vol = (x) => (isObj(x) ? x : {});
    const prev = this._settingsPatch || {};
    const next = { ...prev, ...src };
    if (isObj(prev.volumes) || isObj(src.volumes)) next.volumes = { ...vol(prev.volumes), ...vol(src.volumes) };
    else delete next.volumes;
    this._settingsPatch = next;
    this._settings = sanitizeSettings({ ...this._settings, ...src, volumes: { ...this._settings.volumes, ...vol(src.volumes) } });
    this._settingsDirty = true;
  }

  /**
   * FLOWS-04: adopt settings another tab saved; this tab's unwritten keys stay on top.
   * @returns {boolean} whether this tab's settings changed
   */
  _refreshSettings() {
    if (!this._backend) return false;
    const r = this._get(STORAGE_KEYS.settings);
    if (!r.ok || r.value === this._rawSettings) return false;
    this._rawSettings = r.value;
    if (r.value == null) return false; // removed elsewhere: keep ours
    let v;
    try { v = JSON.parse(r.value); } catch { return false; }
    if (!isObj(v)) return false;
    const before = JSON.stringify(this._settings);
    const pend = this._settingsPatch;
    const vol = (x) => (isObj(x) ? x : {});
    const fresh = sanitizeSettings(v);
    this._settings = pend ? sanitizeSettings({ ...fresh, ...pend, volumes: { ...fresh.volumes, ...vol(pend.volumes) } }) : fresh;
    return JSON.stringify(this._settings) !== before;
  }

  _markApplied(p, id) {
    p.records.applied.push(id.slice(0, 80));
    if (p.records.applied.length > STORAGE_LIMITS.appliedIds) p.records.applied.splice(0, p.records.applied.length - STORAGE_LIMITS.appliedIds);
  }

  /**
   * For a match result applied earlier: its outcome and a best-effort summary rebuilt from the
   * history entry (empty if the entry was already trimmed), so a retried save reports the same numbers.
   */
  _pastMatch(p, resultId) {
    const hist = p.records.matches.history;
    const id = resultId.slice(0, 80);
    const i = hist.findIndex((h) => h.id === id);
    if (i < 0) return {};
    const h = hist[i];
    const before = h.skillBefore;
    const after = h.skillAfter;
    let bestBefore = before;
    for (let k = 0; k < i; k++) {
      if (hist[k].mode !== 'versus') bestBefore = Math.max(bestBefore, hist[k].skillBefore, hist[k].skillAfter);
    }
    const bestAfter = Math.max(bestBefore, after);
    const summary = {
      before, after, delta: after - before, pro: isPro(after), becamePro: isPro(after) && !isPro(before), lostPro: isPro(before) && !isPro(after),
      bestBefore, bestAfter, unlocked: h.mode === 'versus' ? [] : gloveUnlocksBetween(bestBefore, bestAfter).map((u) => ({ ...u })),
      opponent: h.mode !== 'versus' && h.opponentId ? { id: h.opponentId, ratingBefore: h.opponentRating, rematch: h.rematch } : null,
    };
    return { outcome: h.outcome, skillBefore: before, skillAfter: after, summary };
  }

  /** Same result applied twice: nothing changes; if an earlier save failed, retry it now. */
  _duplicate(p) {
    if (p.kind !== ProfileKind.LOCAL) return { ok: true, saved: false, duplicate: true, reason: p.kind, profile: clone(p) };
    if (this._dirty.has(p.id)) return { ...this._commit(p), duplicate: true };
    return { ok: true, saved: true, duplicate: true, profile: clone(p) };
  }

  /** Persist a changed profile if (and only if) it is LOCAL (SAV01). */
  _commit(p, extra = {}) {
    if (p.kind !== ProfileKind.LOCAL) return { ok: true, saved: false, reason: p.kind, ...extra, profile: clone(p) };
    this._dirty.add(p.id);
    if (!this._backend) return { ok: true, saved: false, error: UNAVAILABLE.error, errorCode: UNAVAILABLE.code, ...extra, profile: clone(p) };
    const json = JSON.stringify(p);
    const w = this._set(STORAGE_KEYS.profile(p.id), json);
    if (!w.ok) return { ok: true, saved: false, error: w.error, errorCode: w.code, ...extra, profile: clone(p) };
    this._raw.set(p.id, json);
    this._dirty.delete(p.id);
    if (this._indexDirty) {
      const wi = this._flushIndex();
      if (!wi.ok) {
        // The profile itself is stored; it will be found again by the key scan on load.
        if (!this._canScan()) return { ok: true, saved: false, error: wi.error, errorCode: wi.code, ...extra, profile: clone(p) };
      }
    }
    if (this._settingsDirty) this._flushSettings();
    return { ok: true, saved: true, ...extra, profile: clone(p) };
  }

  _flushIndex() {
    this._syncIndex(); // keep boxers another tab created, drop the ones it deleted (FLOWS-04)
    const json = JSON.stringify(this._order.filter((id) => this._local.has(id)));
    const w = this._set(STORAGE_KEYS.index, json);
    if (w.ok) { this._indexDirty = false; this._rawIndex = json; }
    return w;
  }

  /** Write this tab's settings changes over the latest stored settings (FLOWS-04: never a stale whole copy). */
  _flushSettings() {
    if (!this._backend) return { ok: false, ...UNAVAILABLE };
    this._refreshSettings();
    const json = JSON.stringify(this._settings);
    const w = this._set(STORAGE_KEYS.settings, json);
    if (w.ok) { this._settingsDirty = false; this._settingsPatch = null; this._rawSettings = json; }
    return w;
  }

  /** Run fn; any unexpected exception becomes a non-throwing result (ERR04: never throw). */
  _safe(fn) {
    try {
      return fn();
    } catch (e) {
      const c = classifyStorageError(e);
      this._lastError = c.error;
      return { ok: true, saved: false, error: c.error, errorCode: c.code };
    }
  }

  _get(key) {
    if (!this._backend) return { ok: false, value: null, ...UNAVAILABLE };
    try {
      const v = this._backend.getItem(key);
      return { ok: true, value: v === undefined ? null : v };
    } catch (e) {
      const c = classifyStorageError(e);
      this._lastError = c.error;
      return { ok: false, value: null, ...c };
    }
  }

  _set(key, value) {
    if (!this._backend) return { ok: false, ...UNAVAILABLE };
    try {
      this._backend.setItem(key, value);
      this._writable = true;
      return { ok: true };
    } catch (e) {
      const c = classifyStorageError(e);
      this._lastError = c.error;
      this._writable = false;
      return { ok: false, ...c };
    }
  }

  _remove(key) {
    if (!this._backend) return { ok: false, ...UNAVAILABLE };
    try {
      if (typeof this._backend.removeItem === 'function') this._backend.removeItem(key);
      else this._backend.setItem(key, null);
      return { ok: true };
    } catch (e) {
      const c = classifyStorageError(e);
      this._lastError = c.error;
      return { ok: false, ...c };
    }
  }

  _canScan() {
    const b = this._backend;
    return !!b && ((typeof b.key === 'function' && typeof b.length === 'number') || typeof b.keys === 'function');
  }

  /** All backend keys under our prefix (best effort; [] if the backend can't enumerate). */
  _keys() {
    const b = this._backend;
    const out = [];
    if (!b) return out;
    try {
      if (typeof b.key === 'function' && typeof b.length === 'number') {
        for (let i = 0; i < b.length; i++) {
          const k = b.key(i);
          if (typeof k === 'string' && k.startsWith(STORAGE_PREFIX)) out.push(k);
        }
      } else if (typeof b.keys === 'function') {
        for (const k of b.keys()) if (typeof k === 'string' && k.startsWith(STORAGE_PREFIX)) out.push(k);
      }
    } catch { /* enumeration unsupported/blocked */ }
    return out;
  }

  /** Move a corrupt raw value aside so it never crashes a load again; record an issue. */
  _quarantine(key, raw, message) {
    const qKey = `${STORAGE_KEYS.quarantinePrefix}${key.slice(STORAGE_PREFIX.length)}:${this._now()}`;
    let quarantinedAs = null;
    if (typeof raw === 'string' && raw.length <= 1024 * 1024) {
      const w = this._set(qKey, raw);
      if (w.ok) quarantinedAs = qKey;
    }
    if (quarantinedAs || raw == null || typeof raw !== 'string' || raw.length > 1024 * 1024) this._remove(key);
    this._issues.push({ key, code: 'corrupt', message, quarantinedAs });
    this._trimQuarantine();
  }

  _trimQuarantine() {
    const q = this._keys().filter((k) => k.startsWith(STORAGE_KEYS.quarantinePrefix));
    if (q.length <= STORAGE_LIMITS.quarantineMax) return;
    const stamp = (k) => Number(k.slice(k.lastIndexOf(':') + 1)) || 0;
    q.sort((a, b) => stamp(a) - stamp(b));
    for (const k of q.slice(0, q.length - STORAGE_LIMITS.quarantineMax)) this._remove(k);
  }

  _parse(key, raw) {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      this._quarantine(key, raw, 'Saved data could not be read (damaged JSON) and was set aside.');
      return { ok: false };
    }
  }

  _load() {
    if (!this._backend) {
      this._writable = false;
      return;
    }
    // Probe: private modes may expose localStorage but throw on every write.
    const probe = this._set(STORAGE_KEYS.probe, '1');
    if (probe.ok) this._remove(STORAGE_KEYS.probe);

    // settings
    const rs = this._get(STORAGE_KEYS.settings);
    if (rs.ok && rs.value != null) {
      const parsed = this._parse(STORAGE_KEYS.settings, rs.value);
      if (parsed.ok) {
        if (isObj(parsed.value)) { this._settings = sanitizeSettings(parsed.value); this._rawSettings = rs.value; }
        else this._quarantine(STORAGE_KEYS.settings, rs.value, 'Saved settings were damaged and were reset.');
      }
    } else if (rs.ok) this._rawSettings = null;

    // profile index
    let ids = [];
    let indexOk = false;
    const ri = this._get(STORAGE_KEYS.index);
    if (!ri.ok) return; // backend unreadable: run from memory only
    this._rawIndex = ri.value;
    if (ri.value != null) {
      const parsed = this._parse(STORAGE_KEYS.index, ri.value);
      if (parsed.ok && Array.isArray(parsed.value)) {
        ids = parsed.value.filter((x) => typeof x === 'string' && ID_RE.test(x));
        indexOk = ids.length === parsed.value.length;
      } else if (parsed.ok) {
        this._quarantine(STORAGE_KEYS.index, ri.value, 'The list of boxers was damaged and has been rebuilt.');
      }
    } else {
      indexOk = true; // fresh install (or index never written): orphans below are recovered
    }
    // Recover profiles whose index entry is missing (e.g. an index write failed earlier).
    const seen = new Set(ids);
    for (const k of this._keys()) {
      if (!k.startsWith(STORAGE_KEYS.profilePrefix)) continue;
      const id = k.slice(STORAGE_KEYS.profilePrefix.length);
      if (ID_RE.test(id) && !seen.has(id)) { ids.push(id); seen.add(id); indexOk = false; }
    }
    const t = this._now();
    for (const id of [...new Set(ids)]) {
      const key = STORAGE_KEYS.profile(id);
      const r = this._get(key);
      if (!r.ok) { indexOk = false; continue; }
      if (r.value == null) { indexOk = false; continue; }
      const parsed = this._parse(key, r.value);
      if (!parsed.ok) { indexOk = false; continue; }
      const p = sanitizeProfile(parsed.value, { id, kind: ProfileKind.LOCAL, now: t });
      if (!p) {
        this._quarantine(key, r.value, 'A saved boxer was damaged and was set aside.');
        indexOk = false;
        continue;
      }
      this._local.set(id, p);
      this._raw.set(id, r.value);
      this._order.push(id);
    }
    if (!indexOk && this._writable) {
      this._indexDirty = true;
      this._flushIndex();
    }
  }
}

/** Shared helper for UIs: the profile-kind sentence explaining whether records are kept (SAV01/ERR04). */
export function saveNotice(saveResult) {
  if (!saveResult) return null;
  if (saveResult.saved) return null;
  if (saveResult.reason === ProfileKind.GUEST) return 'Guest boxers don’t keep records — progress from this session isn’t saved.';
  if (saveResult.reason === ProfileKind.PORTABLE) return 'Visiting boxers don’t keep records on this device — progress isn’t saved here.';
  return saveResult.error || 'Progress was not saved.';
}
