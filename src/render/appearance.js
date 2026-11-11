// Boxer appearance kit: defaults, presets, seeded randomizer and validation.
//
// Pure module (no DOM, no three.js) — safe to import in Node. Everything that builds or
// paints a boxer (render/boxer-model.js, render/face.js, the profile editor, the roster)
// passes appearances through validateAppearance() first, so a bad or partial profile can
// never break rendering.
//
// Implements SET01 (the selected profile's avatar is shown as the player's boxer): any
// appearance a profile stores is repaired here into a renderable one.
//
// Style: simple, friendly toy boxers from our own feature kit (APPEARANCE_OPTIONS in
// core/types.js). Colours are our own palette (see render/style.js).

import { APPEARANCE_OPTIONS } from '../core/types.js';

/** Height scale limits (1.0 = LAYOUT.boxerHeight). */
export const HEIGHT_RANGE = Object.freeze([0.9, 1.1]);

/** Clothing colours used by the randomizer and presets (our palette, bright and readable). */
export const CLOTH_COLORS = Object.freeze([
  '#3d7bff', '#ff4d5e', '#2bb3a3', '#ffc94a', '#ff8a5b', '#c77dff', '#5bd1b8', '#6c8dff',
  '#ff5d8f', '#9be564', '#1f3b73', '#14182b', '#f7f3ea', '#e64980', '#2d3a66', '#f08c00',
]);
/** Glove colours: saturated or clean light/dark so gloves always pop on screen. */
export const GLOVE_COLORS = Object.freeze([
  '#ff4d5e', '#3d7bff', '#ffc94a', '#2bb3a3', '#f7f3ea', '#c77dff', '#ff8a5b', '#e03131',
  '#1971c2', '#ff5d8f', '#9be564',
]);
export const SHOE_COLORS = Object.freeze(['#f7f3ea', '#14182b', '#ff4d5e', '#3d7bff', '#ffc94a', '#2bb3a3', '#c77dff']);

/** Fallback appearance; every missing/invalid field is taken from here. */
export const DEFAULT_APPEARANCE = deepFreeze({
  skin: '#eec1a0',
  hair: { style: 'crew', color: '#4a2f22' },
  eyes: 'oval',
  brows: 'flat',
  mouth: 'smile',
  nose: 'button',
  accessory: 'none',
  top: '#3d7bff',
  trunks: '#1f3b73',
  trim: '#ffd166',
  gloves: '#ff4d5e',
  shoes: '#f7f3ea',
  build: 'average',
  height: 1.0,
});

/** Default look for a brand-new player profile. */
export const DEFAULT_PLAYER = deepFreeze({
  skin: '#eec1a0',
  hair: { style: 'crew', color: '#4a2f22' },
  eyes: 'oval',
  brows: 'arched',
  mouth: 'smile',
  nose: 'button',
  accessory: 'none',
  top: '#3d7bff',
  trunks: '#1f3b73',
  trim: '#ffd166',
  gloves: '#ff4d5e',
  shoes: '#f7f3ea',
  build: 'average',
  height: 1.0,
});

/**
 * Trainer look (role 'trainer'): `top` = track jacket, `trunks` = track trousers,
 * `trim` = cap + jacket piping, `shoes` = trainers. Focus mitts are attached by
 * render/training-props.js to BoxerModel.handAnchor().
 */
export const TRAINER = deepFreeze({
  skin: '#b97a52',
  hair: { style: 'buzz', color: '#1d1a19' },
  eyes: 'happy',
  brows: 'arched',
  mouth: 'grin',
  nose: 'round',
  accessory: 'none',
  top: '#2bb3a3',
  trunks: '#2d3a66',
  trim: '#ffc94a',
  gloves: '#ff6b5a',
  shoes: '#f7f3ea',
  build: 'heavy',
  height: 1.02,
});

/**
 * Ready-made looks for the profile editor and quick picks. Each is a complete, valid
 * Appearance plus a display `label` (validateAppearance keeps `label`). Together they use
 * every hair style, every skin tone, every build and every accessory at least once.
 * @type {ReadonlyArray<import('../core/types.js').Appearance & {label:string}>}
 */
export const PRESETS = deepFreeze([
  { label: 'Rookie', skin: '#eec1a0', hair: { style: 'crew', color: '#4a2f22' }, eyes: 'oval', brows: 'arched', mouth: 'smile', nose: 'button', accessory: 'none', top: '#3d7bff', trunks: '#1f3b73', trim: '#ffd166', gloves: '#ff4d5e', shoes: '#f7f3ea', build: 'average', height: 1.0 },
  { label: 'Blaze', skin: '#d9a07a', hair: { style: 'mohawk', color: '#b8432f' }, eyes: 'fierce', brows: 'angry', mouth: 'smirk', nose: 'button', accessory: 'mouthguard', top: 'none', trunks: '#ff4d5e', trim: '#ffd166', gloves: '#ffc94a', shoes: '#14182b', build: 'slim', height: 1.02 },
  { label: 'Big Mo', skin: '#8d5a3b', hair: { style: 'bald', color: '#1d1a19' }, eyes: 'dot', brows: 'thick', mouth: 'grin', nose: 'round', accessory: 'beard', top: '#2bb3a3', trunks: '#14182b', trim: '#f7f3ea', gloves: '#ff8a5b', shoes: '#14182b', build: 'heavy', height: 1.06 },
  { label: 'Pep', skin: '#f6d7c3', hair: { style: 'ponytail', color: '#d8b26a' }, eyes: 'wide', brows: 'arched', mouth: 'grin', nose: 'button', accessory: 'headband', top: '#ff5d8f', trunks: '#2d3a66', trim: '#ffd166', gloves: '#3d7bff', shoes: '#f7f3ea', build: 'slim', height: 0.94 },
  { label: 'Doc', skin: '#b97a52', hair: { style: 'flat-top', color: '#1d1a19' }, eyes: 'narrow', brows: 'flat', mouth: 'flat', nose: 'long', accessory: 'shades', top: '#14182b', trunks: '#c77dff', trim: '#ffd166', gloves: '#f7f3ea', shoes: '#c77dff', build: 'average', height: 1.04 },
  { label: 'Kit', skin: '#eec1a0', hair: { style: 'bob', color: '#1d1a19' }, eyes: 'happy', brows: 'arched', mouth: 'smile', nose: 'button', accessory: 'earring', top: '#ffc94a', trunks: '#3d7bff', trim: '#f7f3ea', gloves: '#ff4d5e', shoes: '#3d7bff', build: 'slim', height: 0.96 },
  { label: 'Tank', skin: '#f6d7c3', hair: { style: 'buzz', color: '#8a5a33' }, eyes: 'sleepy', brows: 'thick', mouth: 'flat', nose: 'round', accessory: 'bandage', top: '#9be564', trunks: '#2d3a66', trim: '#ff6b5a', gloves: '#2bb3a3', shoes: '#14182b', build: 'heavy', height: 1.08 },
  { label: 'Ziggy', skin: '#5e3b26', hair: { style: 'afro', color: '#1d1a19' }, eyes: 'oval', brows: 'arched', mouth: 'grin', nose: 'button', accessory: 'headband', top: '#ff8a5b', trunks: '#f7f3ea', trim: '#2bb3a3', gloves: '#c77dff', shoes: '#ff8a5b', build: 'average', height: 1.0 },
  { label: 'Gramps', skin: '#eec1a0', hair: { style: 'crew', color: '#e9e4dc' }, eyes: 'sleepy', brows: 'thick', mouth: 'smile', nose: 'long', accessory: 'moustache', top: '#1f3b73', trunks: '#f7f3ea', trim: '#ff4d5e', gloves: '#ff4d5e', shoes: '#14182b', build: 'average', height: 0.97 },
  { label: 'Nova', skin: '#8d5a3b', hair: { style: 'bun', color: '#3b5bdb' }, eyes: 'wide', brows: 'arched', mouth: 'smirk', nose: 'button', accessory: 'goggles', top: '#c77dff', trunks: '#14182b', trim: '#5bd1b8', gloves: '#ffc94a', shoes: '#f7f3ea', build: 'slim', height: 0.98 },
  { label: 'Rex', skin: '#d9a07a', hair: { style: 'spiky', color: '#1d1a19' }, eyes: 'fierce', brows: 'angry', mouth: 'gritted', nose: 'button', accessory: 'mouthguard', top: '#ff4d5e', trunks: '#14182b', trim: '#ffc94a', gloves: '#3d7bff', shoes: '#ff4d5e', build: 'average', height: 1.03 },
  { label: 'Coco', skin: '#b97a52', hair: { style: 'curly', color: '#4a2f22' }, eyes: 'happy', brows: 'worried', mouth: 'grin', nose: 'round', accessory: 'none', top: '#5bd1b8', trunks: '#ff5d8f', trim: '#f7f3ea', gloves: '#ff8a5b', shoes: '#f7f3ea', build: 'average', height: 0.95 },
  { label: 'Duke', skin: '#5e3b26', hair: { style: 'cornrows', color: '#1d1a19' }, eyes: 'narrow', brows: 'flat', mouth: 'smirk', nose: 'long', accessory: 'earring', top: '#ffd166', trunks: '#1f3b73', trim: '#ff6b5a', gloves: '#ff6b5a', shoes: '#1f3b73', build: 'heavy', height: 1.05 },
  { label: 'Pixie', skin: '#f6d7c3', hair: { style: 'spiky', color: '#e64980' }, eyes: 'wide', brows: 'none', mouth: 'open', nose: 'none', accessory: 'bandage', top: '#2bb3a3', trunks: '#ff5d8f', trim: '#ffd166', gloves: '#f7f3ea', shoes: '#2bb3a3', build: 'slim', height: 0.92 },
]);

// ───────────────────────────── validation ─────────────────────────────

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX3 = /^#[0-9a-f]{3}$/;

/**
 * Normalise a colour to '#rrggbb' (lower case). Accepts '#rgb', '#rrggbb', 'rrggbb' and
 * 0xRRGGBB numbers. Returns null for anything else.
 * @param {unknown} c
 * @returns {string|null}
 */
export function normalizeHex(c) {
  if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 0xffffff) {
    return '#' + Math.floor(c).toString(16).padStart(6, '0');
  }
  if (typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  if (!s.startsWith('#')) s = '#' + s;
  if (HEX6.test(s)) return s;
  if (HEX3.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return null;
}

const pick = (value, allowed, fallback) => (typeof value === 'string' && allowed.includes(value) ? value : fallback);
const color = (value, fallback) => normalizeHex(value) ?? fallback;

/**
 * Fill defaults and clamp/repair every field. Never throws, never mutates its input.
 * Unknown fields are dropped except a string `label` (preset display name).
 * @param {any} a  partial or untrusted appearance (may be null/undefined)
 * @param {import('../core/types.js').Appearance} [base=DEFAULT_APPEARANCE] where missing fields come from
 * @returns {import('../core/types.js').Appearance}
 */
export function validateAppearance(a, base = DEFAULT_APPEARANCE) {
  const src = a && typeof a === 'object' ? a : {};
  const d = base === DEFAULT_APPEARANCE ? DEFAULT_APPEARANCE : validateAppearance(base);
  const O = APPEARANCE_OPTIONS;
  let hairStyle = d.hair.style;
  let hairColor = d.hair.color;
  if (typeof src.hair === 'string') hairStyle = pick(src.hair, O.hairStyles, hairStyle);
  else if (src.hair && typeof src.hair === 'object') {
    hairStyle = pick(src.hair.style, O.hairStyles, hairStyle);
    hairColor = color(src.hair.color, hairColor);
  }
  const top = src.top === 'none' ? 'none' : color(src.top, d.top);
  let height = typeof src.height === 'number' ? src.height : Number(src.height);
  if (!Number.isFinite(height)) height = d.height;
  height = Math.min(HEIGHT_RANGE[1], Math.max(HEIGHT_RANGE[0], height));
  /** @type {any} */
  const out = {
    skin: color(src.skin, d.skin),
    hair: { style: hairStyle, color: hairColor },
    eyes: pick(src.eyes, O.eyes, d.eyes),
    brows: pick(src.brows, O.brows, d.brows),
    mouth: pick(src.mouth, O.mouths, d.mouth),
    nose: pick(src.nose, O.noses, d.nose),
    accessory: pick(src.accessory, O.accessories, d.accessory),
    top,
    trunks: color(src.trunks, d.trunks),
    trim: color(src.trim, d.trim),
    gloves: color(src.gloves, d.gloves),
    shoes: color(src.shoes, d.shoes),
    build: pick(src.build, O.builds, d.build),
    height: Math.round(height * 1000) / 1000,
  };
  if (typeof src.label === 'string' && src.label.trim()) out.label = src.label.trim().slice(0, 40);
  return out;
}

/** True when `a` is already a complete, valid appearance (validateAppearance would not change it). */
export function isValidAppearance(a) {
  if (!a || typeof a !== 'object') return false;
  return appearanceKey(a, true) === appearanceKey(validateAppearance(a), true);
}

/**
 * Stable string key for caching (face textures, models). Field order independent.
 * @param {any} a
 * @param {boolean} [raw=false] skip validation (caller guarantees a valid appearance)
 */
export function appearanceKey(a, raw = false) {
  const v = raw ? a : validateAppearance(a);
  const h = v.hair || {};
  return [v.skin, h.style, h.color, v.eyes, v.brows, v.mouth, v.nose, v.accessory, v.top, v.trunks,
    v.trim, v.gloves, v.shoes, v.build, v.height].join('|');
}

// ───────────────────────────── seeded random looks ─────────────────────────────

/** 32-bit hash of a number or string seed (FNV-1a for strings). */
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    let x = Math.floor(seed) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
  }
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32) → function returning [0,1). */
export function makeRng(seed) {
  let a = hashSeed(seed);
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(rng, items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}
const choose = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Euclidean RGB distance 0..441 — cheap "do these two read as different colours" check. */
export function colorDistance(a, b) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}
function pickDistinct(rng, list, others, minDist) {
  for (let tries = 0; tries < 24; tries++) {
    const c = choose(rng, list);
    if (others.every((o) => !o || colorDistance(c, o) >= minDist)) return c;
  }
  // Deterministic fallback: the list entry farthest from everything else.
  let best = list[0], bestD = -1;
  for (const c of list) {
    const d = Math.min(...others.filter(Boolean).map((o) => colorDistance(c, o)), 999);
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Tunables for randomAppearance(). Weights are relative. */
export const RANDOM_WEIGHTS = Object.freeze({
  hairStyles: { buzz: 1, crew: 1.2, spiky: 1, mohawk: 0.6, bun: 0.8, ponytail: 0.8, afro: 0.7, curly: 0.9, bald: 0.5, 'flat-top': 0.6, bob: 0.8, cornrows: 0.6 },
  // natural colours first, then the two fun colours
  hairColors: [1, 1, 0.8, 0.8, 0.6, 0.4, 0.15, 0.15],
  brows: { flat: 1, arched: 1, angry: 0.7, thick: 0.9, none: 0.25, worried: 0.5 },
  noses: { button: 1.2, round: 1, long: 0.7, none: 0.35 },
  accessoryNone: 0.45,          // probability of no accessory
  bareTorso: 0.12,              // probability of top = 'none'
  builds: { slim: 0.3, average: 0.45, heavy: 0.25 },
  minTopTrunksDist: 120,        // RGB distance so top and trunks read as separate pieces
  minTrimDist: 140,             // waistband vs trunks
  minGloveDist: 110,            // gloves vs top (or skin when bare)
});

/**
 * Deterministic random appearance: the same seed always gives the same look.
 * @param {number|string} seed
 * @returns {import('../core/types.js').Appearance}
 */
export function randomAppearance(seed) {
  const rng = makeRng(seed);
  const O = APPEARANCE_OPTIONS;
  const W = RANDOM_WEIGHTS;
  const skin = choose(rng, O.skinTones);
  const style = weighted(rng, O.hairStyles, O.hairStyles.map((s) => W.hairStyles[s] ?? 1));
  const hairColor = weighted(rng, O.hairColors, O.hairColors.map((_, i) => W.hairColors[i] ?? 0.5));
  const eyes = choose(rng, O.eyes);
  const brows = weighted(rng, O.brows, O.brows.map((b) => W.brows[b] ?? 1));
  const mouth = choose(rng, O.mouths);
  const nose = weighted(rng, O.noses, O.noses.map((n) => W.noses[n] ?? 1));
  const others = O.accessories.filter((x) => x !== 'none');
  const accessory = rng() < W.accessoryNone ? 'none' : choose(rng, others);
  const top = rng() < W.bareTorso ? 'none' : choose(rng, CLOTH_COLORS);
  const trunks = pickDistinct(rng, CLOTH_COLORS, [top === 'none' ? skin : top], W.minTopTrunksDist);
  const trim = pickDistinct(rng, ['#ffd166', '#f7f3ea', '#ff6b5a', '#2bb3a3', '#ffc94a', '#5bd1b8', '#ff5d8f', '#14182b'], [trunks], W.minTrimDist);
  const gloves = pickDistinct(rng, GLOVE_COLORS, [top === 'none' ? skin : top, skin], W.minGloveDist);
  const shoes = choose(rng, SHOE_COLORS);
  const build = weighted(rng, O.builds, O.builds.map((b) => W.builds[b] ?? 1));
  const height = 0.92 + rng() * 0.16;
  return validateAppearance({
    skin, hair: { style, color: hairColor }, eyes, brows, mouth, nose, accessory,
    top, trunks, trim, gloves, shoes, build, height,
  });
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
