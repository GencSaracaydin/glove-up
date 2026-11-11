// One-Euro filter (Casiez, Roussel & Vogel, "1€ Filter", CHI 2012).
//
// An adaptive low-pass filter: when the signal is slow it smooths hard (kills webcam
// jitter), when it moves fast the cutoff rises with the speed so the output lags very
// little (punches stay snappy). Two knobs matter:
//   minCutoff (Hz) — smoothing at rest. Lower = steadier but laggier when moving slowly.
//   beta           — how fast the cutoff grows with speed (cutoff = minCutoff + beta·|speed|,
//                    speed in input-units per second). Higher = less lag on fast motion.
//   dCutoff (Hz)   — smoothing of the speed estimate itself (1 Hz is the usual choice).
//
// Pure module (no DOM); timestamps are milliseconds. Duplicate / out-of-order timestamps
// return the previous output unchanged instead of producing NaN or spikes.

/** @typedef {{minCutoff?:number, beta?:number, dCutoff?:number}} OneEuroParams */

export const ONE_EURO_DEFAULTS = Object.freeze({ minCutoff: 1.0, beta: 0.0, dCutoff: 1.0 });

/**
 * Exponential-smoothing factor for a first-order low-pass with the given cutoff.
 * @param {number} dtSec  sample interval (s)
 * @param {number} cutoffHz
 */
export function oneEuroAlpha(dtSec, cutoffHz) {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoffHz));
  return 1 / (1 + tau / Math.max(1e-6, dtSec));
}

/** Scalar One-Euro filter. */
export class OneEuroFilter {
  /** @param {OneEuroParams} [params] */
  constructor(params = {}) {
    this.minCutoff = params.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = params.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = params.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
    this.reset();
  }

  /** Forget history; the next sample passes through unfiltered. */
  reset() {
    /** @type {number|null} */ this._t = null;
    this._x = 0;
    this._dx = 0;
  }

  /** @param {OneEuroParams} params */
  setParams(params) {
    if (params.minCutoff != null) this.minCutoff = params.minCutoff;
    if (params.beta != null) this.beta = params.beta;
    if (params.dCutoff != null) this.dCutoff = params.dCutoff;
  }

  /** Last filtered value (0 before the first sample). */
  get value() { return this._x; }
  /** Filtered derivative (units per second). */
  get velocity() { return this._dx; }
  get initialized() { return this._t !== null; }

  /**
   * @param {number} x     raw sample
   * @param {number} tMs   timestamp (ms)
   * @returns {number} filtered value
   */
  filter(x, tMs) {
    if (!Number.isFinite(x)) return this._x;
    if (this._t === null) {
      this._t = tMs; this._x = x; this._dx = 0;
      return x;
    }
    const dt = (tMs - this._t) / 1000;
    if (!(dt > 0)) return this._x;
    this._t = tMs;
    const rawDx = (x - this._x) / dt;
    this._dx += oneEuroAlpha(dt, this.dCutoff) * (rawDx - this._dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);
    this._x += oneEuroAlpha(dt, cutoff) * (x - this._x);
    return this._x;
  }
}

/**
 * One-Euro filter over an N-dimensional point that adapts ONE cutoff from the speed
 * magnitude (so a fast diagonal motion is not smoothed differently per axis).
 */
export class OneEuroVector {
  /**
   * @param {number} dim
   * @param {OneEuroParams} [params]
   */
  constructor(dim, params = {}) {
    this.dim = dim;
    this.minCutoff = params.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = params.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = params.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
    /** Speed (the cut-off's input) from samples at least this far apart (ms): at 60 fps the frame-to-frame raw
     *  derivative of white jitter is twice as large per second as at 30 fps, which opens the cut-off at rest; with
     *  e.g. 24 a 60 fps feed is smoothed like a 30 fps one (frames ≥ minDerivDtMs apart: unchanged). 0 = every frame. */
    this.minDerivDtMs = params.minDerivDtMs ?? 0;
    this.value = new Array(dim).fill(0);
    this.velocity = new Array(dim).fill(0);
    this.reset();
  }

  reset() {
    /** @type {number|null} */ this._t = null;
    this.value.fill(0);
    this.velocity.fill(0);
    this.cutoff = this.minCutoff;
    /** recent [tMs, value[]] for the speed over ≥ minDerivDtMs */
    this._ref = [];
  }

  /** @param {OneEuroParams & {minDerivDtMs?: number}} params */
  setParams(params) {
    if (params.minCutoff != null) this.minCutoff = params.minCutoff;
    if (params.beta != null) this.beta = params.beta;
    if (params.dCutoff != null) this.dCutoff = params.dCutoff;
    if (params.minDerivDtMs != null) this.minDerivDtMs = params.minDerivDtMs;
  }

  get initialized() { return this._t !== null; }

  /** How far (ms) the output trails a steady ramp right now: 1 / (2π · the last cut-off). The steady-state lag of the
   *  first-order low-pass — value + velocity · lagMs / 1000 undoes it (a display value; the derivative is itself smoothed,
   *  so it overshoots a little when a motion stops). */
  get lagMs() { return this.cutoff > 0 ? 1000 / (2 * Math.PI * this.cutoff) : 0; }

  /** Speed magnitude of the filtered derivative (units/s). */
  get speed() {
    let s = 0;
    for (let i = 0; i < this.dim; i++) s += this.velocity[i] * this.velocity[i];
    return Math.sqrt(s);
  }

  /**
   * Re-seed the filter at a value (e.g. after a confirmed tracking jump).
   * @param {ArrayLike<number>} x
   * @param {number} tMs
   */
  seed(x, tMs) {
    this._t = tMs;
    for (let i = 0; i < this.dim; i++) { this.value[i] = x[i]; this.velocity[i] = 0; }
    this._ref = this.minDerivDtMs > 0 ? [[tMs, Array.from(this.value)]] : [];
  }

  /**
   * @param {ArrayLike<number>} x  raw sample (length dim)
   * @param {number} tMs
   * @returns {number[]} the filtered value (the internal array — copy it if you keep it)
   */
  filter(x, tMs) {
    for (let i = 0; i < this.dim; i++) if (!Number.isFinite(x[i])) return this.value;
    if (this._t === null) { this.seed(x, tMs); return this.value; }
    const dt = (tMs - this._t) / 1000;
    if (!(dt > 0)) return this.value;
    this._t = tMs;
    const aD = oneEuroAlpha(dt, this.dCutoff);
    // the raw speed: against the previous output, or (minDerivDtMs) against the newest output ≥ that long ago
    let ref = this.value, dtr = dt;
    if (this.minDerivDtMs > 0 && this._ref.length) {
      let r = null;
      for (let k = this._ref.length - 1; k >= 0; k--) if (tMs - this._ref[k][0] >= this.minDerivDtMs) { r = this._ref[k]; break; }
      if (r && tMs - r[0] > 1000 * dt + 1e-6) { ref = r[1]; dtr = (tMs - r[0]) / 1000; }
    }
    let sp = 0;
    for (let i = 0; i < this.dim; i++) {
      const raw = (x[i] - ref[i]) / dtr;
      this.velocity[i] += aD * (raw - this.velocity[i]);
      sp += this.velocity[i] * this.velocity[i];
    }
    const cutoff = this.minCutoff + this.beta * Math.sqrt(sp);
    /** the cut-off of the last step (Hz): a ramp at speed v trails by v / (2π · cutoff) — see lagMs */
    this.cutoff = cutoff;
    const a = oneEuroAlpha(dt, cutoff);
    for (let i = 0; i < this.dim; i++) this.value[i] += a * (x[i] - this.value[i]);
    if (this.minDerivDtMs > 0) {
      this._ref.push([tMs, Array.from(this.value)]);
      while (this._ref.length > 4) this._ref.shift();
    }
    return this.value;
  }
}

/**
 * Convenience: a bank of OneEuroVector filters keyed by name (e.g. one per landmark).
 * @param {number} dim
 * @param {OneEuroParams} params
 */
export function makeFilterBank(dim, params) {
  /** @type {Map<string|number, OneEuroVector>} */
  const bank = new Map();
  return {
    /** @param {string|number} key @param {ArrayLike<number>} x @param {number} tMs */
    filter(key, x, tMs) {
      let f = bank.get(key);
      if (!f) { f = new OneEuroVector(dim, params); bank.set(key, f); }
      return f.filter(x, tMs);
    },
    get(key) { return bank.get(key) || null; },
    reset() { for (const f of bank.values()) f.reset(); },
    setParams(p) { for (const f of bank.values()) f.setParams(p); Object.assign(params, p); },
  };
}
