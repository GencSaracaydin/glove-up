// Seeded pseudo-random numbers for everything gameplay-related (AI decisions, damage
// variance, judges, get-up rolls, the headless simulator). Pure: no DOM, runs in Node.
//
// Generator: mulberry32 (32-bit state, fast, good enough for games; NOT cryptographic).
//
// Usage:
//   import { Rng } from '../core/rng.js';
//   const rng = new Rng(1234);            // or new Rng('daily-2026-11-05'), or createRng()
//   rng.float();        // [0, 1)
//   rng.range(2, 5);    // [2, 5)
//   rng.int(1, 6);      // 1..6 inclusive
//   rng.pick(['a','b']);
//   rng.chance(0.25);   // true 25% of the time
//   const ai = rng.fork('ai');  // independent child stream (depends only on seed + label)
//
// fork(label) derives a child from the ORIGINAL seed and the label, never from how many
// numbers the parent has already produced. That keeps sub-systems decoupled: adding a
// damage roll in combat does not change what the AI decides. Use distinct labels for
// distinct streams (the same label always yields the same stream).

/** FNV-1a 32-bit hash of a string → uint32. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Final avalanche (murmur3 fmix32) so nearby seeds give unrelated streams. */
function mix32(x) {
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Turn anything seed-like into a uint32: numbers (floored), numeric strings, any string
 * (hashed), another Rng (its seed), or nothing (time + Math.random → non-deterministic).
 * @param {number|string|Rng|undefined|null} seed
 */
export function normalizeSeed(seed) {
  if (seed instanceof Rng) return seed.seed;
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(Math.abs(seed)) >>> 0;
  if (typeof seed === 'string' && seed.length) {
    if (/^\d+$/.test(seed)) return Number(seed) >>> 0;
    return hashString(seed);
  }
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

export class Rng {
  /** @param {number|string|Rng} [seed] */
  constructor(seed) {
    /** The uint32 seed this stream was created from (stable; used by fork). */
    this.seed = normalizeSeed(seed);
    /** Current generator state (advances with every draw). */
    this.state = mix32(this.seed ^ 0x9e3779b9);
  }

  /** Next raw uint32 (mulberry32 step). */
  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float() { return this.nextUint32() / 4294967296; }

  /** Uniform float in [a, b). */
  range(a, b) { return a + (b - a) * this.float(); }

  /** Uniform integer in [a, b] (inclusive both ends; order of a/b does not matter). */
  int(a, b) {
    let lo = Math.ceil(Math.min(a, b));
    const hi = Math.floor(Math.max(a, b));
    if (hi < lo) return lo;
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** Random element of an array (undefined for an empty array). */
  pick(arr) {
    if (!arr || !arr.length) return undefined;
    return arr[Math.floor(this.float() * arr.length)];
  }

  /** true with probability p (p ≤ 0 → never, p ≥ 1 → always). */
  chance(p) {
    if (!(p > 0)) return false;
    if (p >= 1) return true;
    return this.float() < p;
  }

  /** ±1 with equal probability. */
  sign() { return this.float() < 0.5 ? -1 : 1; }

  /** Normally distributed number (Box–Muller). */
  normal(mean = 0, sd = 1) {
    let u = this.float();
    if (u < 1e-12) u = 1e-12;
    const v = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Weighted choice. Accepts `{key: weight}` or `[[key, weight], ...]`. Non-positive
   * weights are skipped. Returns undefined if no weight is positive.
   */
  weighted(weights) {
    const entries = Array.isArray(weights) ? weights : Object.entries(weights || {});
    let total = 0;
    for (const [, w] of entries) if (w > 0) total += w;
    if (!(total > 0)) return undefined;
    let r = this.float() * total;
    for (const [k, w] of entries) {
      if (!(w > 0)) continue;
      r -= w;
      if (r < 0) return k;
    }
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i][1] > 0) return entries[i][0];
    return undefined;
  }

  /** Shuffled copy of an array (Fisher–Yates). */
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Independent child stream derived from this stream's seed and a label. */
  fork(label) {
    return new Rng(mix32(this.seed ^ hashString(String(label ?? ''))) ^ 0x5bd1e995);
  }

  /** Exact copy (same seed and current state). */
  clone() {
    const r = new Rng(this.seed);
    r.state = this.state;
    return r;
  }

  /** Serializable state (for save/replay). */
  getState() { return { seed: this.seed, state: this.state }; }
  setState(s) {
    if (s && Number.isFinite(s.seed)) this.seed = s.seed >>> 0;
    if (s && Number.isFinite(s.state)) this.state = s.state >>> 0;
    return this;
  }
}

/** Factory alias: createRng(seed) === new Rng(seed). */
export function createRng(seed) { return new Rng(seed); }
/** Second alias for convenience. */
export const makeRng = createRng;

/**
 * Coerce whatever a caller passed as "rng" into an Rng: an Rng is returned as is, an object
 * with a float()/random() method is wrapped, anything else is treated as a seed.
 * @returns {Rng}
 */
export function toRng(x) {
  if (x instanceof Rng) return x;
  if (x && typeof x === 'object' && (typeof x.float === 'function' || typeof x.random === 'function')) {
    const src = x;
    const r = new Rng(typeof src.seed === 'number' ? src.seed : undefined);
    const f = typeof src.float === 'function' ? () => src.float() : () => src.random();
    r.nextUint32 = () => (Math.floor(f() * 4294967296) >>> 0);
    r.fork = (label) => new Rng(mix32((r.seed >>> 0) ^ hashString(String(label ?? ''))) ^ 0x5bd1e995);
    return r;
  }
  if (typeof x === 'function') {
    const r = new Rng();
    r.nextUint32 = () => (Math.floor(x() * 4294967296) >>> 0);
    return r;
  }
  return new Rng(x);
}

export default Rng;
