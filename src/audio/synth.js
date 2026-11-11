// Synthesis kit for Glove Up audio. Every sound in the game is generated live with WebAudio —
// no samples, no recordings, no borrowed music.
//
// Layers (all importable in Node; nothing touches the DOM or an AudioContext at import time):
//   1. Pure helpers — math, seeded RNG, noise/texture generators, soft-clip curve, level meter.
//   2. Shared per-context resources (noise buffers, applause texture, reverb impulse).
//   3. `Voice` — a self-cleaning one-shot graph builder: every node it creates is disconnected
//      when its last source ends, so short-lived sounds never pile up (performance rule).
//   4. INSTR — the instrument kit music.js plays (drums, bass, stabs, lead, brass, mallets …).
//   5. SFX — every sound-effect recipe the AudioEngine plays (punches, bell, crowd, training, UI).
//
// Recipe signature: (ctx, out, t, opts, res) → end time (s).
//   ctx  BaseAudioContext (AudioContext or OfflineAudioContext)
//   out  { dry: AudioNode, send?: AudioNode|null, echo?: AudioNode|null }  (category bus inputs)
//   t    start time in ctx seconds
//   res  getResources(ctx) — noise buffers + rng
// Levels: recipes aim for peaks ≈ 0.1 (UI) … 0.8 (counter punch) at unity bus gain; the
// engine's master chain (glue compressor → limiter → soft clipper) keeps the sum below 0 dBFS.

// ───────────────────────────── pure helpers ─────────────────────────────

/** Smallest value used for exponential ramps (WebAudio rejects 0). ≈ −80 dB. */
export const EPS = 1e-4;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, k) => a + (b - a) * k;
/** Finite number or the default. */
export const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export function smoothstep(a, b, x) {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
}

/**
 * Settings slider value (0..1) → linear gain. A gentle power curve so the middle of the
 * slider sounds like "half as loud" rather than barely quieter.
 */
export function volumeToGain(v, curve = 1.6) {
  const x = num(typeof v === 'string' ? Number(v) : v, 0);
  if (x <= 0) return 0;
  return Math.pow(Math.min(x, 1), curve);
}

/** Small fast seeded PRNG → () => [0,1). */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Accept a function, a seed number or nothing (Math.random). */
export function makeRng(r) {
  if (typeof r === 'function') return r;
  if (typeof r === 'number' && Number.isFinite(r)) return mulberry32(r);
  return Math.random;
}

/** 1 ± amount, uniformly. */
export const jit = (rng, amount) => 1 + (rng() * 2 - 1) * amount;
export const rand = (rng, a, b) => a + (b - a) * rng();

/**
 * Fill a Float32Array with noise. 'white' (uniform), 'pink' (−3 dB/oct, Kellet filter) or
 * 'brown' (−6 dB/oct, leaky integrator). Normalised to a peak of 0.95.
 */
export function fillNoise(data, color = 'white', rng = Math.random) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    if (color === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else if (color === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last;
    } else data[i] = w;
  }
  normalizePeak([data], 0.95);
  return data;
}

/** Smooth (cosine-interpolated) random signal in −1..1 that changes about `hz` times a second. */
export function fillSmoothRandom(data, sampleRate, hz = 8, rng = Math.random) {
  const span = Math.max(2, Math.round(sampleRate / hz));
  const n = Math.ceil(data.length / span) + 1;
  const pts = Array.from({ length: n }, () => rng() * 2 - 1);
  pts[n - 1] = pts[0]; // seamless loop when the length is a multiple of span
  for (let i = 0; i < data.length; i++) {
    const k = Math.floor(i / span), f = (i % span) / span;
    const w = (1 - Math.cos(f * Math.PI)) / 2;
    data[i] = pts[k] * (1 - w) + pts[Math.min(k + 1, n - 1)] * w;
  }
  return data;
}

/**
 * Render an applause texture (many random hand claps: short band-passed noise bursts) into a
 * stereo pair of Float32Arrays. Wraps around so it loops seamlessly. Peak normalised to 0.9.
 */
export function fillApplause(left, right, sampleRate, { clapsPerSec = 60, rng = Math.random } = {}) {
  const len = left.length;
  for (const ch of [left, right]) {
    const claps = Math.round((clapsPerSec * len) / sampleRate);
    for (let k = 0; k < claps; k++) {
      const start = Math.floor(rng() * len);
      const tau = sampleRate * (0.0018 + rng() * 0.0035);
      const n = Math.floor(tau * 6);
      const amp = 0.25 + rng() * 0.75;
      // RBJ band-pass (constant 0 dB peak) around a random "hand" resonance
      const f0 = 700 + rng() * 1900, q = 1.2 + rng() * 1.4;
      const w0 = (2 * Math.PI * f0) / sampleRate, alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
      const bb0 = alpha / a0, bb2 = -alpha / a0, a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const x = (rng() * 2 - 1) * Math.exp(-i / tau) * amp;
        const y = bb0 * x + bb2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        ch[(start + i) % len] += y;
      }
    }
  }
  normalizePeak([left, right], 0.9);
}

/**
 * Small-arena reverb impulse: a few early reflections then exponentially decaying noise whose
 * high end dies faster (one-pole low-pass sweeping down). Stereo-decorrelated.
 */
export function fillImpulse(left, right, sampleRate, { decay = 3.2, predelay = 0.012, rng = Math.random } = {}) {
  const len = left.length;
  const pre = Math.floor(predelay * sampleRate);
  [left, right].forEach((ch, c) => {
    let lp = 0;
    for (let i = 0; i < len; i++) {
      if (i < pre) { ch[i] = 0; continue; }
      const k = (i - pre) / Math.max(1, len - pre);
      const env = Math.pow(1 - k, decay);
      const a = 0.55 + 0.4 * (1 - k); // brighter at first, darker later
      lp = lp + a * ((rng() * 2 - 1) - lp);
      ch[i] = lp * env;
    }
    for (let r = 0; r < 6; r++) {
      const at = pre + Math.floor((0.004 + rng() * 0.05) * sampleRate) + c * 37;
      if (at < len) ch[at] += (0.5 - r * 0.06) * (rng() < 0.5 ? -1 : 1);
    }
  });
  normalizePeak([left, right], 0.9);
}

function normalizePeak(chans, target) {
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (peak <= 0) return;
  const k = target / peak;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
}

/**
 * Transfer curve for the final safety clipper. The WaveShaper is fed signal/headroom, so the
 * curve maps a signal range of ±headroom: transparent (exactly linear) below `knee`, then a
 * tanh shoulder that approaches `ceiling` — nothing can ever leave the shaper above it.
 * Odd length so 0 maps exactly to 0 (no DC).
 */
export function makeSoftClipCurve({ n = 2049, headroom = 2, knee = 0.8, ceiling = 0.985 } = {}) {
  const curve = new Float32Array(n);
  const span = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const s = ((i / (n - 1)) * 2 - 1) * headroom;
    const a = Math.abs(s);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = s < 0 ? -y : y;
  }
  return curve;
}

const DRIVE_CACHE = new Map();
/** Gentle saturation curve tanh(k·x)/tanh(k) (cached per amount). */
export function makeDriveCurve(amount = 1.5, n = 1025) {
  const key = `${amount}:${n}`;
  let c = DRIVE_CACHE.get(key);
  if (c) return c;
  c = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(amount * x) / norm;
  }
  DRIVE_CACHE.set(key, c);
  return c;
}

/**
 * Level meter for rendered audio (offline report, tests).
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{peak:number, peakDb:number, rms:number, rmsDb:number, activeRmsDb:number, activeSec:number, clipped:number}}
 *   activeRmsDb = RMS over the span where the signal is above −50 dBFS (the "body" of a short sound)
 */
export function measure(channels, sampleRate) {
  let peak = 0, sum = 0, n = 0, clipped = 0, first = -1, last = -1;
  const thr = dbToGain(-50);
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sum += ch[i] * ch[i];
      if (a > thr) { if (first < 0 || i < first) first = i; if (i > last) last = i; }
    }
    n += ch.length;
  }
  let asum = 0, an = 0;
  if (first >= 0) for (const ch of channels) for (let i = first; i <= last; i++) { asum += ch[i] * ch[i]; an++; }
  const rms = n ? Math.sqrt(sum / n) : 0;
  const arms = an ? Math.sqrt(asum / an) : 0;
  return {
    peak, peakDb: gainToDb(peak), rms, rmsDb: gainToDb(rms), activeRmsDb: gainToDb(arms),
    activeSec: first >= 0 ? (last - first + 1) / sampleRate : 0, clipped,
  };
}

// ───────────────────────────── shared resources ─────────────────────────────

const RESOURCES = new WeakMap();

/**
 * Noise buffers and textures shared by every recipe on one context (generated once, lazily).
 * @param {BaseAudioContext} ctx
 * @param {() => number} [rng]
 * @returns {{white:AudioBuffer, pink:AudioBuffer, brown:AudioBuffer, applause:AudioBuffer,
 *            lfo:AudioBuffer, rng:() => number, impulse:() => AudioBuffer}}
 */
export function getResources(ctx, rng = Math.random) {
  let r = RESOURCES.get(ctx);
  if (r) return r;
  const sr = ctx.sampleRate || 48000;
  // fixed seeds: textures are identical every session (and in tests); variation comes from offsets
  const make = (sec, ch, fill) => {
    const b = ctx.createBuffer(ch, Math.max(1, Math.round(sec * sr)), sr);
    fill(b);
    return b;
  };
  let impulse = null, applause = null, lfo = null;
  r = {
    rng,
    white: make(2, 1, (b) => fillNoise(b.getChannelData(0), 'white', mulberry32(11))),
    pink: make(6, 1, (b) => fillNoise(b.getChannelData(0), 'pink', mulberry32(12))),
    brown: make(4, 1, (b) => fillNoise(b.getChannelData(0), 'brown', mulberry32(13))),
    // crowd-only textures are built on first use (keeps the unlock click light)
    get applause() {
      return applause || (applause = make(4, 2, (b) => fillApplause(b.getChannelData(0), b.getChannelData(1), sr, { clapsPerSec: 70, rng: mulberry32(14) })));
    },
    /** Slow random modulator (~9 changes/s); played back at 0.6–1.4× for different "talkers". */
    get lfo() {
      return lfo || (lfo = make(6, 1, (b) => fillSmoothRandom(b.getChannelData(0), sr, 9, mulberry32(15))));
    },
    impulse() {
      if (!impulse) impulse = make(1.9, 2, (b) => fillImpulse(b.getChannelData(0), b.getChannelData(1), sr, { decay: 3.4, rng: mulberry32(16) }));
      return impulse;
    },
  };
  RESOURCES.set(ctx, r);
  return r;
}

// ───────────────────────────── envelopes ─────────────────────────────

/** Percussive envelope: 0 → peak in `a` s (linear), exponential fall to silence over `d` s. → end time. */
export function perc(param, t, peak, a, d) {
  const p = Math.max(EPS * 2, num(peak, 0));
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + a);
  param.exponentialRampToValueAtTime(EPS, t + a + d);
  return t + a + d;
}

/**
 * Note envelope with a note-off: attack to `peak`, decay toward `s·peak` (time constant d/3),
 * hold until t+dur, then a linear release to exactly 0 over `r`. → end time.
 */
export function adsr(param, t, dur, { a = 0.005, d = 0.1, s = 0.6, r = 0.08, peak = 1 } = {}) {
  const p = Math.max(0, num(peak, 0));
  const tA = t + Math.max(0.0005, a);
  const tOff = Math.max(tA, t + num(dur, 0.1));
  const tau = Math.max(0.001, d / 3);
  const vOff = p * s + (p - p * s) * Math.exp(-(tOff - tA) / tau);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, tA);
  if (tOff > tA) param.setTargetAtTime(p * s, tA, tau);
  param.setValueAtTime(vOff, tOff);
  param.linearRampToValueAtTime(0, tOff + r);
  return tOff + r;
}

/** Exponential glide of a (positive) param from f0 to f1. */
export function glide(param, t, f0, f1, dur) {
  param.setValueAtTime(Math.max(EPS, f0), t);
  param.exponentialRampToValueAtTime(Math.max(EPS, f1), t + Math.max(0.001, dur));
}

// ───────────────────────────── Voice: self-cleaning one-shot graph ─────────────────────────────

/**
 * Builds the node graph of one sound and tears it down when the last source stops.
 *   const v = new Voice(ctx, out, t, res);
 *   const o = v.osc('sine', 220, t, t + 0.3); const g = v.gain(0); perc(g.gain, t, 0.5, 0.002, 0.25);
 *   o.connect(g); v.toOut(g, 0.1); return v.done();
 */
export class Voice {
  constructor(ctx, out, t, res) {
    this.ctx = ctx;
    this.out = out;
    this.t = t;
    this.res = res;
    this.nodes = [];
    this.srcs = [];
    this.end = t;
    this.disposed = false;
  }

  _add(n) { this.nodes.push(n); return n; }

  gain(v = 0) {
    const g = this._add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  /** BiquadFilter. NB: for lowpass/highpass WebAudio's Q is a resonance in dB; for bandpass it is linear Q. */
  filter(type, freq, q) {
    const f = this._add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = clamp(freq, 10, 22000);
    if (q !== undefined) f.Q.value = q;
    return f;
  }

  /** Stereo panner (falls back to a unity gain where StereoPanner is missing — then `.pan` is undefined). */
  pan(p = 0) {
    if (typeof this.ctx.createStereoPanner !== 'function') return this.gain(1);
    const s = this._add(this.ctx.createStereoPanner());
    s.pan.value = clamp(num(p, 0), -1, 1);
    return s;
  }

  shaper(curve) {
    const w = this._add(this.ctx.createWaveShaper());
    w.curve = curve;
    return w;
  }

  osc(type, freq, t0, t1, detune = 0) {
    const o = this._add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = clamp(freq, 0.01, 22000);
    if (detune) o.detune.value = detune;
    this._src(o, t0, t1);
    return o;
  }

  /** Looping buffer source started at a random offset (so noise never sounds identical twice). */
  buf(buffer, t0, t1, { rate = 1, offset } = {}) {
    const s = this._add(this.ctx.createBufferSource());
    s.buffer = buffer;
    s.loop = true;
    if (rate !== 1) s.playbackRate.value = rate;
    const dur = buffer.duration || buffer.length / (buffer.sampleRate || 48000);
    const off = offset ?? (this.res?.rng ? this.res.rng() : Math.random()) * Math.max(0, dur - 0.01);
    this._src(s, t0, t1, off);
    return s;
  }

  _src(node, t0, t1, offset) {
    const a = Math.max(0, t0);
    const b = Math.max(a + 0.001, t1);
    if (offset !== undefined) node.start(a, offset); else node.start(a);
    node.stop(b);
    node.__stopAt = b;
    this.srcs.push(node);
    if (b > this.end) this.end = b;
  }

  /** Connect a node to the category bus, plus an optional reverb send. */
  toOut(node, send = 0) {
    node.connect(this.out.dry);
    if (send > 0 && this.out.send) {
      const g = this.gain(send);
      node.connect(g);
      g.connect(this.out.send);
    }
    return node;
  }

  /** Finish building: schedule teardown after the last source stops. → end time. */
  done() {
    if (!this.srcs.length) { this.dispose(); return this.end; }
    let last = this.srcs[0];
    for (const s of this.srcs) if (s.__stopAt > last.__stopAt) last = s;
    last.onended = () => this.dispose();
    return this.end;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    for (const s of this.srcs) s.onended = null;
    this.nodes.length = 0;
    this.srcs.length = 0;
  }
}

/** Simple percussive tone: osc(type, f) → gain env → dest. */
function tone(v, dest, type, f, t, peak, a, d, f1) {
  const o = v.osc(type, f, t, t + a + d + 0.02);
  if (f1) glide(o.frequency, t, f, f1, (a + d) * 0.6);
  const g = v.gain(0);
  perc(g.gain, t, peak, a, d);
  o.connect(g);
  g.connect(dest);
  return o;
}

/** Filtered noise burst: buffer → filter(s) → gain env → dest. */
function noiseHit(v, dest, buffer, t, peak, a, d, filters) {
  const s = v.buf(buffer, t, t + a + d + 0.02);
  let node = s;
  for (const [type, f, q] of filters) { const fl = v.filter(type, f, q); node.connect(fl); node = fl; }
  const g = v.gain(0);
  perc(g.gain, t, peak, a, d);
  node.connect(g);
  g.connect(dest);
  return g;
}

/** Bus with pan + reverb send for a recipe; returns the input node. */
function outBus(v, pan = 0, send = 0, level = 1) {
  const p = v.pan(pan);
  const g = v.gain(level);
  g.connect(p);
  v.toOut(p, send);
  return g;
}

// ───────────────────────────── instrument kit (music.js) ─────────────────────────────
// Event fields: midi, notes[], dur (s), vel (0..1). Each returns its end time.

function evVel(e) { return clamp(num(e.vel, 0.8), 0, 1.2) * num(e.gain, 1); }

export const INSTR = {
  kick(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), dec = num(e.decay, 0.3), tune = num(e.tune, 1);
    const bus = outBus(v, 0, 0);
    tone(v, bus, 'sine', 150 * tune, t, 0.95 * vel, 0.002, dec, 46 * tune);
    noiseHit(v, bus, res.white, t, 0.16 * vel, 0.0005, 0.008, [['highpass', 1800]]);
    return v.done();
  },

  snare(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const bus = outBus(v, num(e.pan, 0), 0.12);
    tone(v, bus, 'triangle', 205, t, 0.34 * vel, 0.001, 0.075, 165);
    noiseHit(v, bus, res.white, t, 0.5 * vel, 0.001, num(e.decay, 0.13), [['highpass', 1300], ['bandpass', 3800, 0.7]]);
    return v.done();
  },

  clap(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const bus = outBus(v, 0, 0.16);
    const s = v.buf(res.white, t, t + 0.2);
    const hp = v.filter('highpass', 650), bp = v.filter('bandpass', 1250, 1.1), g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const ti = t + i * 0.011;
      g.gain.setValueAtTime(0.75 * vel, ti);
      g.gain.exponentialRampToValueAtTime(0.06 * vel + EPS, ti + 0.009);
    }
    g.gain.setValueAtTime(0.6 * vel, t + 0.033);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.17);
    s.connect(hp); hp.connect(bp); bp.connect(g); g.connect(bus);
    return v.done();
  },

  hat(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), open = !!e.open;
    const bus = outBus(v, num(e.pan, 0.15), open ? 0.08 : 0.03);
    noiseHit(v, bus, res.white, t, (open ? 0.2 : 0.22) * vel, 0.0008, num(e.decay, open ? 0.22 : 0.034), [['highpass', 7200], ['bandpass', 10500, 0.9]]);
    return v.done();
  },

  ohat(ctx, out, t, e, res) { return INSTR.hat(ctx, out, t, { ...e, open: true }, res); },

  shaker(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const bus = outBus(v, num(e.pan, -0.2), 0.04);
    const s = v.buf(res.white, t, t + 0.09);
    const bp = v.filter('bandpass', 6200, 1.4), g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.014);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.075);
    s.connect(bp); bp.connect(g); g.connect(bus);
    return v.done();
  },

  rim(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const bus = outBus(v, num(e.pan, 0.1), 0.06);
    tone(v, bus, 'sine', 1720, t, 0.17 * vel, 0.0005, 0.03);
    tone(v, bus, 'triangle', 520, t, 0.12 * vel, 0.0005, 0.022);
    noiseHit(v, bus, res.white, t, 0.08 * vel, 0.0003, 0.006, [['highpass', 3000]]);
    return v.done();
  },

  crash(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), dec = num(e.decay, 1.7);
    const bus = outBus(v, num(e.pan, -0.15), 0.3);
    noiseHit(v, bus, res.white, t, 0.26 * vel, 0.002, dec, [['highpass', 4200], ['bandpass', 7500, 0.45]]);
    const hp = v.filter('highpass', 3200), mg = v.gain(0);
    perc(mg.gain, t, 0.035 * vel, 0.002, dec * 0.7);
    hp.connect(mg); mg.connect(bus);
    for (const f of [413, 587, 829]) v.osc('square', f * num(e.tune, 1), t, t + dec).connect(hp);
    return v.done();
  },

  tom(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const f = e.midi ? midiToHz(e.midi) : 150;
    const bus = outBus(v, num(e.pan, 0), 0.14);
    tone(v, bus, 'sine', f, t, 0.62 * vel, 0.002, 0.3, f * 0.72);
    noiseHit(v, bus, res.white, t, 0.14 * vel, 0.001, 0.05, [['lowpass', 900]]);
    return v.done();
  },

  timp(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res);
    const f = midiToHz(num(e.midi, 36)), dec = num(e.decay, 1.1);
    const bus = outBus(v, 0, 0.25);
    tone(v, bus, 'sine', f * 1.03, t, 0.62 * vel, 0.004, dec, f);
    tone(v, bus, 'sine', f * 1.505, t, 0.22 * vel, 0.004, dec * 0.42);
    tone(v, bus, 'sine', f * 1.99, t, 0.1 * vel, 0.003, dec * 0.28);
    noiseHit(v, bus, res.white, t, 0.22 * vel, 0.001, 0.05, [['lowpass', 520]]);
    return v.done();
  },

  bass(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 36));
    const dur = num(e.dur, 0.2);
    const bus = outBus(v, 0, 0);
    const lp = v.filter('lowpass', 300, 4);
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.exponentialRampToValueAtTime(380 + 1500 * vel, t + 0.012);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.22);
    const g = v.gain(0);
    const end = adsr(g.gain, t, dur, { a: 0.004, d: 0.14, s: 0.62, r: 0.06, peak: 0.42 * vel });
    v.osc('sawtooth', f, t, end + 0.01).connect(lp);
    const sub = v.osc('sine', f, t, end + 0.01), sg = v.gain(0.9);
    sub.connect(sg); sg.connect(g);
    lp.connect(g); g.connect(bus);
    return v.done();
  },

  stab(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), notes = e.notes || [e.midi ?? 60];
    const bus = outBus(v, num(e.pan, 0.1), 0.14);
    const lp = v.filter('lowpass', 3000, 2);
    lp.frequency.setValueAtTime(3400 * (0.6 + 0.4 * vel), t);
    lp.frequency.exponentialRampToValueAtTime(950, t + 0.16);
    const g = v.gain(0);
    const end = adsr(g.gain, t, num(e.dur, 0.1), { a: 0.003, d: 0.09, s: 0.32, r: 0.06, peak: 0.62 * vel });
    const per = 0.15 / Math.sqrt(notes.length);
    for (const m of notes) {
      for (const dt of [-8, 8]) {
        const o = v.osc('sawtooth', midiToHz(m), t, end + 0.01, dt), og = v.gain(per);
        o.connect(og); og.connect(lp);
      }
    }
    lp.connect(g); g.connect(bus);
    return v.done();
  },

  lead(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 72)), dur = num(e.dur, 0.2);
    const bus = outBus(v, num(e.pan, -0.05), 0.12);
    const lp = v.filter('lowpass', 2700, 1);
    const g = v.gain(0);
    const end = adsr(g.gain, t, dur, { a: 0.008, d: 0.16, s: 0.62, r: 0.08, peak: 0.19 * vel });
    const o1 = v.osc('square', f, t, end + 0.01), o2 = v.osc('triangle', f * 2, t, end + 0.01);
    const g2 = v.gain(0.35);
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(bus);
    if (e.glideFrom) { glide(o1.frequency, t, midiToHz(e.glideFrom), f, 0.05); glide(o2.frequency, t, midiToHz(e.glideFrom) * 2, f * 2, 0.05); }
    if (dur > 0.28) { // delayed vibrato
      const lfo = v.osc('sine', 5.6, t, end + 0.01), lg = v.gain(0);
      lg.gain.setValueAtTime(0, t + 0.16);
      lg.gain.linearRampToValueAtTime(9, t + 0.4);
      lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
    }
    if (out.echo) { const es = v.gain(0.5); g.connect(es); es.connect(out.echo); }
    return v.done();
  },

  /** Airy whistle-like lead (training groove). */
  whistle(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 76)), dur = num(e.dur, 0.2);
    const bus = outBus(v, num(e.pan, 0.12), 0.2);
    const g = v.gain(0);
    const end = adsr(g.gain, t, dur, { a: 0.03, d: 0.2, s: 0.8, r: 0.1, peak: 0.2 * vel });
    const o1 = v.osc('sine', f, t, end + 0.01), o2 = v.osc('sine', f * 2, t, end + 0.01), g2 = v.gain(0.08);
    o1.connect(g); o2.connect(g2); g2.connect(g);
    const nz = v.buf(res.white, t, end + 0.01), bp = v.filter('bandpass', f * 2, 3), ng = v.gain(0.025);
    nz.connect(bp); bp.connect(ng); ng.connect(g);
    if (dur > 0.3) {
      const lfo = v.osc('sine', 5, t, end + 0.01), lg = v.gain(0);
      lg.gain.setValueAtTime(0, t + 0.2);
      lg.gain.linearRampToValueAtTime(14, t + 0.45);
      lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
    }
    g.connect(bus);
    if (out.echo) { const es = v.gain(0.4); g.connect(es); es.connect(out.echo); }
    return v.done();
  },

  marimba(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 72));
    const bus = outBus(v, num(e.pan, 0.2), 0.12);
    tone(v, bus, 'sine', f, t, 0.38 * vel, 0.002, 0.42);
    tone(v, bus, 'sine', f * 4, t, 0.1 * vel, 0.001, 0.07);
    noiseHit(v, bus, res.white, t, 0.04 * vel, 0.0005, 0.01, [['bandpass', 2200, 1]]);
    return v.done();
  },

  pluck(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 72));
    const bus = outBus(v, num(e.pan, 0), 0.16);
    const lp = v.filter('lowpass', 2400, 2);
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    const g = v.gain(0);
    const end = perc(g.gain, t, 0.4 * vel, 0.002, Math.max(0.25, num(e.dur, 0.3)));
    v.osc('triangle', f, t, end + 0.01).connect(lp);
    const s = v.osc('sawtooth', f, t, end + 0.01, 6), sg = v.gain(0.45);
    s.connect(sg); sg.connect(lp);
    lp.connect(g); g.connect(bus);
    return v.done();
  },

  glock(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 84));
    const bus = outBus(v, num(e.pan, 0.25), 0.3);
    tone(v, bus, 'sine', f, t, 0.15 * vel, 0.001, 1.0);
    tone(v, bus, 'sine', f * 2.76, t, 0.05 * vel, 0.001, 0.32);
    tone(v, bus, 'sine', f * 5.4, t, 0.02 * vel, 0.0008, 0.14);
    return v.done();
  },

  brass(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), notes = e.notes || [num(e.midi, 67)];
    const bus = outBus(v, num(e.pan, 0), 0.22);
    const lp = v.filter('lowpass', 600, 1);
    lp.frequency.setValueAtTime(450, t);
    lp.frequency.linearRampToValueAtTime(700 + 2600 * clamp01(vel), t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(1500 + 600 * clamp01(vel), t + 0.32);
    const g = v.gain(0);
    const end = adsr(g.gain, t, num(e.dur, 0.25), { a: 0.028, d: 0.22, s: 0.8, r: 0.13, peak: 0.42 * vel });
    const per = 0.32 / Math.sqrt(notes.length);
    for (const m of notes) {
      for (const dt of [-6, 6]) {
        const o = v.osc('sawtooth', midiToHz(m), t, end + 0.01, dt);
        o.detune.setValueAtTime(dt - 35, t); // brassy scoop up into the note
        o.detune.linearRampToValueAtTime(dt, t + 0.05);
        const og = v.gain(per);
        o.connect(og); og.connect(lp);
      }
    }
    lp.connect(g); g.connect(bus);
    return v.done();
  },

  /** Soft muted-horn voice (defeat stinger). */
  horn(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), f = midiToHz(num(e.midi, 60));
    const bus = outBus(v, num(e.pan, 0), 0.25);
    const lp = v.filter('lowpass', 1300, 0);
    const g = v.gain(0);
    const end = adsr(g.gain, t, num(e.dur, 0.4), { a: 0.06, d: 0.3, s: 0.75, r: 0.25, peak: 0.3 * vel });
    v.osc('triangle', f, t, end + 0.01).connect(lp);
    const s = v.osc('sawtooth', f, t, end + 0.01, -4), sg = v.gain(0.25);
    s.connect(sg); sg.connect(lp);
    lp.connect(g); g.connect(bus);
    return v.done();
  },

  pad(ctx, out, t, e, res) {
    const vel = evVel(e), v = new Voice(ctx, out, t, res), notes = e.notes || [num(e.midi, 60)];
    const bus = outBus(v, 0, 0.35);
    const lp = v.filter('lowpass', 1400, 0);
    const g = v.gain(0);
    const end = adsr(g.gain, t, num(e.dur, 1), { a: 0.22, d: 0.5, s: 0.8, r: 0.6, peak: 0.36 * vel });
    const per = 0.2 / Math.sqrt(notes.length);
    for (const m of notes) {
      for (const dt of [-10, 10]) {
        const o = v.osc('sawtooth', midiToHz(m), t, end + 0.01, dt), og = v.gain(per);
        o.connect(og); og.connect(lp);
      }
    }
    lp.connect(g); g.connect(bus);
    return v.done();
  },
};

// ───────────────────────────── SFX building blocks ─────────────────────────────

/** Band-passed noise sweep (whoosh / swish / swoosh). */
function whooshCore(ctx, out, t, o, res) {
  const { dur = 0.3, f0 = 400, f1 = 1800, f2 = 600, q = 1.8, vel = 0.4, pan0 = 0, pan1 = 0, send = 0.05, low = 0, color = 'white' } = o;
  const v = new Voice(ctx, out, t, res);
  const p = v.pan(pan0);
  if (p.pan && pan1 !== pan0) { p.pan.setValueAtTime(clamp(pan0, -1, 1), t); p.pan.linearRampToValueAtTime(clamp(pan1, -1, 1), t + dur); }
  v.toOut(p, send);
  const s = v.buf(res[color] || res.white, t, t + dur + 0.02);
  const bp = v.filter('bandpass', f0, q);
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(Math.max(EPS * 2, vel), t + dur * 0.42);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  s.connect(bp); bp.connect(g); g.connect(p);
  if (low > 0) {
    const ls = v.buf(res.pink, t, t + dur + 0.02), lp = v.filter('lowpass', 520, 0), lg = v.gain(0);
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(vel * low, t + dur * 0.4);
    lg.gain.exponentialRampToValueAtTime(EPS, t + dur);
    ls.connect(lp); lp.connect(lg); lg.connect(p);
  }
  return v.done();
}

/** Ring-bell partials: [frequency ratio, amplitude, decay seconds] — inharmonic, gong-like. */
export const BELL_PARTIALS = Object.freeze([
  [0.5, 0.16, 2.4], [1, 1, 2.0], [1.183, 0.45, 1.4], [1.506, 0.34, 1.1], [2.0, 0.4, 1.0],
  [2.514, 0.28, 0.7], [2.662, 0.2, 0.6], [3.011, 0.17, 0.5], [4.166, 0.11, 0.35],
  [5.433, 0.07, 0.25], [6.796, 0.045, 0.18],
]);

function bellStrike(v, dest, t, f, vel) {
  const rng = v.res.rng;
  for (const [r, a, d] of BELL_PARTIALS) tone(v, dest, 'sine', f * r * jit(rng, 0.0015), t, a * vel, 0.0015, d);
  tone(v, dest, 'sine', f + 1.3, t, 0.32 * vel, 0.002, 1.8); // slow beating shimmer on the prime
  noiseHit(v, dest, v.res.white, t, 0.5 * vel, 0.0005, 0.012, [['highpass', 2600]]); // hammer tick
}

/** Formant filter bank (vowel colour) feeding `dest`; returns its input node. */
export const VOWELS = Object.freeze({
  oo: [[330, 5, 1.0], [820, 6, 0.6], [2300, 8, 0.15]],
  oh: [[470, 5, 1.0], [880, 6, 0.65], [2450, 8, 0.15]],
  ah: [[780, 4, 1.0], [1230, 5, 0.7], [2600, 7, 0.22]],
  eh: [[560, 4, 1.0], [1750, 6, 0.55], [2600, 7, 0.2]],
  ee: [[300, 5, 1.0], [2250, 8, 0.5], [3050, 8, 0.22]],
  uh: [[600, 4, 1.0], [1150, 5, 0.5], [2500, 6, 0.15]],
});

function formantBank(v, vowel, dest, shift = 1, comp = 3.4) {
  const input = v.gain(1);
  for (const [f, q, a] of VOWELS[vowel] || VOWELS.ah) {
    const bp = v.filter('bandpass', f * shift, q), g = v.gain(a * comp);
    input.connect(bp); bp.connect(g); g.connect(dest);
  }
  return input;
}

function contour(param, kind, t0, t1, f, rng) {
  const d = Math.max(0.05, t1 - t0);
  const r = () => jit(rng, 0.04);
  param.setValueAtTime(f * (kind === 'fall' ? 1.1 : kind === 'gasp' ? 0.85 : 0.92), t0);
  if (kind === 'rise-fall') {
    param.exponentialRampToValueAtTime(f * 1.06 * r(), t0 + d * 0.3);
    param.exponentialRampToValueAtTime(f * 0.84 * r(), t1);
  } else if (kind === 'rise') {
    param.exponentialRampToValueAtTime(f * 1.14 * r(), t0 + Math.min(0.4, d * 0.3));
    param.exponentialRampToValueAtTime(f * 1.04 * r(), t1);
  } else if (kind === 'gasp') {
    param.exponentialRampToValueAtTime(f * 1.25 * r(), t0 + Math.min(0.12, d * 0.4));
    param.exponentialRampToValueAtTime(f * 1.08, t1);
  } else if (kind === 'fall') {
    param.exponentialRampToValueAtTime(f * 0.78 * r(), t1);
  } else {
    param.exponentialRampToValueAtTime(f * r(), t1);
  }
}

/**
 * Many voices singing one vowel (crowd "ooh", "aah", "yeah"): detuned sawtooth talkers with
 * individual pitch contours through two stereo formant banks, plus breath noise.
 */
export function crowdVoices(ctx, out, t, o, res) {
  const { vowel = 'ah', n = 8, dur = 1.5, attack = 0.15, release = 0.8, vel = 0.3, lo = 110, hi = 300,
    shape = 'rise-fall', breath = 0.25, spread = 0.55, onsetJitter = 0.1, send = 0.3 } = o;
  const rng = res.rng, v = new Voice(ctx, out, t, res), tEnd = t + dur;
  const groups = [-spread, spread].map((p) => {
    const pan = v.pan(p), env = v.gain(0);
    env.connect(pan);
    v.toOut(pan, send);
    const e = env.gain;
    e.setValueAtTime(0, t);
    e.linearRampToValueAtTime(Math.max(EPS * 2, vel), t + attack);
    e.setValueAtTime(Math.max(EPS * 2, vel), Math.max(t + attack, tEnd - release));
    e.exponentialRampToValueAtTime(EPS, tEnd);
    return formantBank(v, vowel, env, jit(rng, 0.04));
  });
  const lvl = 1 / Math.sqrt(Math.max(1, n));
  for (let i = 0; i < n; i++) {
    const f = lo * Math.pow(hi / lo, rng()), t0 = t + rng() * onsetJitter;
    const osc = v.osc('sawtooth', f, t0, tEnd + 0.02, (rng() * 2 - 1) * 20);
    contour(osc.frequency, shape, t0, tEnd, f, rng);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime((0.7 + 0.6 * rng()) * lvl, t0 + 0.05);
    osc.connect(g); g.connect(groups[i & 1]);
  }
  if (breath > 0) for (const bank of groups) {
    const nz = v.buf(res.pink, t, tEnd + 0.02), ng = v.gain(breath);
    nz.connect(ng); ng.connect(bank);
  }
  return v.done();
}

/** Applause swell from the pre-rendered texture. */
function applause(ctx, out, t, { dur = 2.5, vel = 0.5, attack = 0.25, release = 1.2 } = {}, res) {
  const v = new Voice(ctx, out, t, res), tEnd = t + dur;
  const s = v.buf(res.applause, t, tEnd + 0.02, { rate: jit(res.rng, 0.04) });
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(Math.max(EPS * 2, vel), t + attack);
  g.gain.setValueAtTime(Math.max(EPS * 2, vel), Math.max(t + attack, tEnd - release));
  g.gain.exponentialRampToValueAtTime(EPS, tEnd);
  s.connect(g);
  v.toOut(g, 0.25);
  return v.done();
}

/** One fan's two-finger whistle (rise, then a falling tail). */
function fanWhistle(ctx, out, t, { f = 2800, dur = 0.6, vel = 0.05, pan = 0 } = {}, res) {
  const v = new Voice(ctx, out, t, res), bus = outBus(v, pan, 0.3);
  const o = v.osc('sine', f, t, t + dur + 0.02);
  o.frequency.setValueAtTime(f * 0.78, t);
  o.frequency.exponentialRampToValueAtTime(f * 1.08, t + Math.min(0.15, dur * 0.3));
  o.frequency.exponentialRampToValueAtTime(f * 0.74, t + dur);
  const lfo = v.osc('sine', 6.5, t, t + dur + 0.02), lg = v.gain(f * 0.012);
  lfo.connect(lg); lg.connect(o.frequency);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.03);
  g.gain.setValueAtTime(vel, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  o.connect(g); g.connect(bus);
  return v.done();
}

/** Low crowd rumble (stamping/roar body). */
function rumble(ctx, out, t, { dur = 3, vel = 0.3 } = {}, res) {
  const v = new Voice(ctx, out, t, res);
  const s = v.buf(res.brown, t, t + dur + 0.02), lp = v.filter('lowpass', 320, 0), g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.3);
  g.gain.setValueAtTime(vel, t + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  s.connect(lp); lp.connect(g);
  v.toOut(g, 0.2);
  return v.done();
}

/**
 * Crowd reactions. kind ∈ 'ooh' | 'cheer' | 'roar' | 'gasp' | 'aww' | 'shout' | 'whistle'.
 * @returns {number} end time
 */
export function crowdReaction(ctx, out, t, kind, o = {}, res) {
  const rng = res.rng, amt = clamp01(num(o.amount, 1));
  const ends = [t];
  const add = (x) => ends.push(x);
  switch (kind) {
    case 'ooh':
      add(crowdVoices(ctx, out, t, { vowel: 'oo', n: 9, dur: 1.5, attack: 0.16, release: 1.0, vel: 0.26 * amt, lo: 100, hi: 290, shape: 'rise-fall', breath: 0.2 }, res));
      break;
    case 'aww':
      add(crowdVoices(ctx, out, t, { vowel: 'ah', n: 8, dur: 1.4, attack: 0.12, release: 1.0, vel: 0.2 * amt, lo: 110, hi: 280, shape: 'fall', breath: 0.25 }, res));
      break;
    case 'gasp': {
      const v = new Voice(ctx, out, t, res);
      const g = v.gain(0), p = v.pan(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5 * amt, t + 0.07);
      g.gain.exponentialRampToValueAtTime(EPS, t + 0.55);
      g.connect(p); v.toOut(p, 0.25);
      const s = v.buf(res.pink, t, t + 0.6), bp = v.filter('bandpass', 650, 1.6);
      bp.frequency.setValueAtTime(650, t);
      bp.frequency.exponentialRampToValueAtTime(1500, t + 0.14);
      bp.frequency.exponentialRampToValueAtTime(1100, t + 0.5);
      const bp2 = v.filter('bandpass', 2400, 2), g2 = v.gain(0.5);
      s.connect(bp); bp.connect(g); s.connect(bp2); bp2.connect(g2); g2.connect(g);
      add(v.done());
      add(crowdVoices(ctx, out, t, { vowel: 'ah', n: 6, dur: 0.5, attack: 0.05, release: 0.35, vel: 0.13 * amt, lo: 150, hi: 380, shape: 'gasp', breath: 0.35, onsetJitter: 0.05 }, res));
      break;
    }
    case 'cheer': {
      const dur = 2.1 + 0.4 * amt;
      add(crowdVoices(ctx, out, t, { vowel: 'ah', n: 10, dur, attack: 0.18, release: 1.2, vel: 0.24 * amt, lo: 140, hi: 360, shape: 'rise', breath: 0.25, onsetJitter: 0.18 }, res));
      add(crowdVoices(ctx, out, t + 0.05, { vowel: 'eh', n: 4, dur: dur * 0.6, attack: 0.1, release: 0.6, vel: 0.12 * amt, lo: 160, hi: 340, shape: 'rise', breath: 0.15, onsetJitter: 0.25 }, res));
      add(applause(ctx, out, t + 0.1, { dur: dur + 0.6, vel: 0.42 * amt }, res));
      const whistles = amt > 0.5 ? 1 + Math.floor(rng() * 2) : 0;
      for (let i = 0; i < whistles; i++) add(fanWhistle(ctx, out, t + 0.2 + rng() * 0.9, { f: rand(rng, 2300, 3300), dur: rand(rng, 0.45, 0.8), vel: 0.04 * amt, pan: rand(rng, -0.8, 0.8) }, res));
      break;
    }
    case 'roar': {
      const dur = 2.8 + 0.8 * amt;
      add(crowdVoices(ctx, out, t, { vowel: 'ah', n: 12, dur, attack: 0.22, release: 1.6, vel: 0.3 * amt, lo: 105, hi: 340, shape: 'rise', breath: 0.3, onsetJitter: 0.2 }, res));
      add(crowdVoices(ctx, out, t + 0.1, { vowel: 'oh', n: 6, dur: dur * 0.8, attack: 0.25, release: 1.2, vel: 0.16 * amt, lo: 95, hi: 220, shape: 'rise', breath: 0.2, onsetJitter: 0.2 }, res));
      add(rumble(ctx, out, t, { dur: dur + 0.4, vel: 0.28 * amt }, res));
      add(applause(ctx, out, t + 0.25, { dur: dur + 1.2, vel: 0.55 * amt, attack: 0.5 }, res));
      for (let i = 0; i < 3; i++) add(fanWhistle(ctx, out, t + 0.3 + rng() * 1.6, { f: rand(rng, 2200, 3400), dur: rand(rng, 0.5, 0.9), vel: 0.045 * amt, pan: rand(rng, -0.85, 0.85) }, res));
      break;
    }
    case 'shout': { // one fan in the crowd
      const vowel = o.vowel || ['ah', 'eh', 'oh', 'ee'][Math.floor(rng() * 4)];
      const f = num(o.pitch, rand(rng, 160, 400));
      add(crowdVoices(ctx, out, t, { vowel, n: 1, dur: num(o.dur, rand(rng, 0.18, 0.45)), attack: 0.03, release: 0.12, vel: 0.06 * amt, lo: f, hi: f * 1.01, shape: rng() < 0.6 ? 'rise' : 'fall', breath: 0.15, spread: num(o.pan, rand(rng, -0.8, 0.8)), onsetJitter: 0, send: 0.35 }, res));
      break;
    }
    case 'whistle':
      add(fanWhistle(ctx, out, t, { f: rand(rng, 2300, 3300), dur: rand(rng, 0.4, 0.8), vel: 0.045 * amt, pan: num(o.pan, rand(rng, -0.8, 0.8)) }, res));
      break;
    default:
      break;
  }
  return Math.max(...ends);
}

// ───────────────────────────── SFX recipes ─────────────────────────────

/**
 * Every sound effect, by name. opts common to all: gain (×), pan (−1..1).
 * Combat opts: power 0..1, target 'head'|'body', counter, knockdown, heavy, kind, perspective
 * ('dealt' = the local player threw it, 'taken' = the local player was hit).
 */
export const SFX = {
  /**
   * Landed punch: low sine drop + noise transient + leathery click (+ counter crack / sub).
   * Four distinct families (mechanics.md §6 "distinct sounds for a clean hit, a block and a counter"):
   * a clean hit; a counter (bright crack + sizzle + ping); a heavy hit (o.heavy — a power punch or
   * counter on the player: deeper, crushed crunch + a downward "whump"); the knockdown blow (big).
   */
  hit(ctx, out, t, o, res) {
    const rng = res.rng, P = clamp01(num(o.power, 0.6)), body = o.target === 'body';
    const heavy = !!o.heavy, big = !!(o.counter || o.knockdown || heavy), taken = o.perspective === 'taken';
    const vel = (0.4 + 0.6 * P) * (big ? 1.12 : 1) * num(o.gain, 1);
    const v = new Voice(ctx, out, t, res);
    const bus = outBus(v, num(o.pan, 0), big ? 0.22 : 0.12);
    // 1) thump — a sine that drops in pitch, lightly saturated for weight
    const tDec = (body ? 0.3 : 0.2) + (big ? 0.14 : 0) + (heavy ? 0.1 : 0) + P * 0.05;
    const f0 = (body ? 118 : 160) * jit(rng, 0.06) * (taken ? 0.86 : 1) * (heavy ? 0.85 : 1);
    const th = v.osc('sine', f0, t, t + tDec + 0.05);
    glide(th.frequency, t, f0, body ? 40 : heavy ? 44 : 52, body ? 0.15 : heavy ? 0.13 : 0.1);
    const thG = v.gain(0);
    perc(thG.gain, t, vel * (body ? 0.95 : 0.8) * (taken ? 1.12 : 1), 0.002, tDec);
    const drive = v.shaper(makeDriveCurve(heavy ? 2.6 : big ? 2.2 : 1.3));
    th.connect(thG); thG.connect(drive); drive.connect(bus);
    // 2) noise transient (darker for body shots)
    noiseHit(v, bus, res.white, t, vel * (body ? 0.5 : 0.6), 0.001, body ? 0.075 : 0.055,
      [['bandpass', (body ? 850 : 1900) * jit(rng, 0.12), body ? 1.1 : 0.9]]);
    // 3) leathery click + glove-slap resonance
    noiseHit(v, bus, res.white, t, vel * (body ? 0.2 : 0.36) * (taken ? 0.7 : 1), 0.0005, 0.014, [['highpass', taken ? 1800 : 2800]]);
    noiseHit(v, bus, res.white, t, vel * 0.45, 0.001, 0.045, [['bandpass', (body ? 620 : 1150) * jit(rng, 0.08), body ? 3 : 4.5]]);
    // 4) counters: a bright crack, sizzle and a sparkle ping
    if (o.counter) {
      tone(v, bus, 'triangle', 900, t, 0.15 * vel, 0.001, 0.09, 2400);
      noiseHit(v, bus, res.white, t + 0.004, 0.12 * vel, 0.004, 0.28, [['highpass', 5200]]);
      tone(v, bus, 'sine', 2637, t + 0.01, 0.055 * vel, 0.002, 0.45);
    }
    // 5) sub boom for big shots, power shots and hits the local player takes
    const sub = heavy ? 0.7 : big ? 0.62 : taken ? 0.36 : P >= 0.75 ? 0.3 : 0;
    if (sub > 0) tone(v, bus, 'sine', heavy ? 64 : 72, t, vel * sub, 0.004, heavy ? 0.6 : big ? 0.5 : 0.3, heavy ? 30 : 34);
    // 6) heavy shots: a crushed low-mid crunch and a dark "whump" sweeping down
    if (heavy) {
      const crunch = v.shaper(makeDriveCurve(3));
      crunch.connect(bus);
      noiseHit(v, crunch, res.pink, t, 0.42 * vel, 0.002, 0.09, [['bandpass', 420 * jit(rng, 0.08), 1.2]]);
      const s = v.buf(res.brown, t, t + 0.4), lp = v.filter('lowpass', 1100, 0.5), g = v.gain(0);
      lp.frequency.setValueAtTime(1100, t);
      lp.frequency.exponentialRampToValueAtTime(110, t + 0.34);
      perc(g.gain, t, 0.65 * vel, 0.004, 0.34);
      s.connect(lp); lp.connect(g); g.connect(bus);
    }
    return v.done();
  },

  /** Punch into a guard: a muffled pad. */
  block(ctx, out, t, o, res) {
    const P = clamp01(num(o.power, 0.5)), vel = (0.48 + 0.3 * P) * num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.06);
    tone(v, bus, 'sine', 120, t, 0.65 * vel, 0.003, 0.13, 72);
    noiseHit(v, bus, res.pink, t, 1.2 * vel, 0.004, 0.1, [['lowpass', 620, 1]]);
    noiseHit(v, bus, res.white, t, 0.38 * vel, 0.006, 0.07, [['bandpass', 340, 1.3]]);
    noiseHit(v, bus, res.white, t, 0.1 * vel, 0.001, 0.025, [['bandpass', 1050, 2.2]]);
    return v.done();
  },

  /** A punch that hits nothing (miss): a full whoosh. */
  whoosh(ctx, out, t, o, res) {
    const P = clamp01(num(o.power, 0.6)), dir = num(o.dir, 1), c = num(o.pan, 0);
    return whooshCore(ctx, out, t, { dur: 0.3, f0: 380, f1: 1700, f2: 520, q: 1.7, vel: (0.45 + 0.25 * P) * num(o.gain, 1), pan0: c - 0.35 * dir, pan1: c + 0.35 * dir, low: 0.5 }, res);
  },

  /** Somebody slipped a punch: a quick, airy swish. */
  dodge(ctx, out, t, o, res) {
    const dir = num(o.dir, 1), c = num(o.pan, 0);
    return whooshCore(ctx, out, t, { dur: 0.22, f0: 600, f1: 3200, f2: 900, q: 2.4, vel: 0.5 * num(o.gain, 1), pan0: c - 0.5 * dir, pan1: c + 0.5 * dir }, res);
  },

  /** The local player's punch leaving (immediate "your punch registered" feedback). */
  swish(ctx, out, t, o, res) {
    const c = num(o.pan, 0);
    return whooshCore(ctx, out, t, { dur: 0.11, f0: 900, f1: 2800, f2: 1500, q: 1.4, vel: 0.22 * num(o.gain, 1), pan0: c, pan1: c * 1.4, send: 0 }, res);
  },

  /** Ring bell: inharmonic additive partials + hammer tick. opts.rings (1–8), spacing (s). */
  bell(ctx, out, t, o, res) {
    const rings = clamp(Math.round(num(o.rings, 2)), 1, 8), spacing = num(o.spacing, 0.32), f = num(o.freq, 820);
    const v = new Voice(ctx, out, t, res);
    const bus = outBus(v, num(o.pan, 0.05), 0.3, 0.2 * num(o.gain, 1));
    for (let i = 0; i < rings; i++) bellStrike(v, bus, t + i * spacing, f, i === 0 ? 1 : 0.86 + 0.1 * res.rng());
    return v.done();
  },

  /** Body meets canvas: thud-dud. */
  thud(ctx, out, t, o, res) {
    const vel = clamp(num(o.power, 1), 0.2, 1) * num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.2);
    tone(v, bus, 'sine', 95, t, 0.9 * vel, 0.003, 0.55, 30);
    noiseHit(v, bus, res.brown, t, 0.9 * vel, 0.004, 0.35, [['lowpass', 320, 0]]);
    noiseHit(v, bus, res.pink, t, 0.4 * vel, 0.002, 0.12, [['bandpass', 520, 0.9]]);
    const tb = t + 0.16;
    tone(v, bus, 'sine', 80, tb, 0.42 * vel, 0.003, 0.3, 36);
    noiseHit(v, bus, res.brown, tb, 0.38 * vel, 0.003, 0.2, [['lowpass', 280, 0]]);
    return v.done();
  },

  /** Cinematic KO impact: sub drop + dark noise sweep + cymbal. */
  'ko-boom'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.35);
    tone(v, bus, 'sine', 62, t, 0.85 * vel, 0.005, 1.4, 27);
    const s = v.buf(res.brown, t, t + 1.1), lp = v.filter('lowpass', 1200, 0), g = v.gain(0);
    lp.frequency.setValueAtTime(1300, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + 0.8);
    perc(g.gain, t, 0.75 * vel, 0.003, 1.0);
    s.connect(lp); lp.connect(g); g.connect(bus);
    const crashEnd = INSTR.crash(ctx, out, t, { vel: 0.8 * vel, decay: 2.2 }, res);
    return Math.max(v.done(), crashEnd);
  },

  /** Count beat under each number the announcer calls: a wood-block "tock". */
  'count-tick'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.12);
    tone(v, bus, 'sine', 980, t, 0.26 * vel, 0.001, 0.06);
    tone(v, bus, 'sine', 1540, t, 0.12 * vel, 0.001, 0.035);
    noiseHit(v, bus, res.white, t, 0.12 * vel, 0.0005, 0.006, [['highpass', 3500]]);
    return v.done();
  },

  /** Fallback "voice" for a count when speech is unavailable: a pitched beep (n = 1..10). */
  'count-beep'(ctx, out, t, o, res) {
    const n = clamp(Math.round(num(o.n, 1)), 1, 10), f = midiToHz(69 + n), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.1);
    tone(v, bus, 'triangle', f, t, 0.22 * vel, 0.004, 0.16);
    tone(v, bus, 'sine', f * 2, t, 0.06 * vel, 0.004, 0.1);
    return v.done();
  },

  /** One syllable of the fallback announcer voice (used when speech synthesis is unavailable). */
  'voice-blip'(ctx, out, t, o, res) {
    const f0 = num(o.pitch, 140), dur = clamp(num(o.dur, 0.12), 0.05, 0.5), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.12);
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.22 * vel, t + 0.012);
    env.gain.setValueAtTime(0.22 * vel, t + dur * 0.7);
    env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(bus);
    const src = v.osc('sawtooth', f0, t, t + dur + 0.01);
    glide(src.frequency, t, f0 * 1.04, f0 * 0.9, dur);
    src.connect(formantBank(v, o.vowel || 'ah', env, 1, 4));
    return v.done();
  },

  /** Decision reveal: crash + kick + timpani. */
  reveal(ctx, out, t, o, res) {
    const vel = 0.7 * num(o.gain, 1);
    INSTR.kick(ctx, out, t, { vel }, res);
    INSTR.timp(ctx, out, t, { midi: 38, vel: 0.9 * vel }, res);
    return INSTR.crash(ctx, out, t, { vel: 0.85 * vel, decay: 2 }, res);
  },

  /** AI wind-up tell: a short effort grunt ("hnh!"). */
  grunt(ctx, out, t, o, res) {
    const rng = res.rng, f0 = num(o.pitch, 128) * jit(rng, 0.08), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.12);
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.14 * vel, t + 0.015);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.22);
    const drive = v.shaper(makeDriveCurve(1.8));
    env.connect(drive); drive.connect(bus);
    const bank = formantBank(v, 'uh', env, 1, 4);
    const src = v.osc('sawtooth', f0, t, t + 0.25);
    src.frequency.setValueAtTime(f0 * 1.05, t);
    src.frequency.exponentialRampToValueAtTime(f0 * 0.78, t + 0.2);
    src.connect(bank);
    noiseHit(v, bus, res.white, t, 0.07 * vel, 0.005, 0.12, [['bandpass', 1800, 1]]);
    return v.done();
  },

  /** AI wind-up glint: a bright "shing". */
  glint(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.4);
    tone(v, bus, 'sine', 2093, t, 0.075 * vel, 0.002, 0.36, 2637);
    tone(v, bus, 'sine', 2643, t + 0.02, 0.05 * vel, 0.002, 0.32);
    tone(v, bus, 'sine', 3951, t + 0.02, 0.035 * vel, 0.002, 0.2);
    return v.done();
  },

  /** The local player just dodged: their counter window is open. */
  'counter-ready'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.3);
    tone(v, bus, 'sine', 1760, t, 0.12 * vel, 0.003, 0.22);
    tone(v, bus, 'sine', 2637, t + 0.04, 0.085 * vel, 0.003, 0.2);
    return v.done();
  },

  /** Daze: little circling chirps + a wobbly slide down. */
  dazed(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res);
    for (let i = 0; i < 3; i++) {
      const ti = t + i * 0.2, p = v.pan(Math.sin(i * 2.1) * 0.6);
      v.toOut(p, 0.3);
      const c = v.osc('sine', 2500, ti, ti + 0.17);
      c.frequency.setValueAtTime(2400, ti);
      c.frequency.exponentialRampToValueAtTime(3300, ti + 0.06);
      c.frequency.exponentialRampToValueAtTime(2500, ti + 0.15);
      const g = v.gain(0);
      perc(g.gain, ti, 0.09 * vel, 0.005, 0.14);
      c.connect(g); g.connect(p);
    }
    const bus = outBus(v, 0, 0.25);
    const s = v.osc('sine', 1100, t, t + 0.8);
    glide(s.frequency, t, 1100, 520, 0.75);
    const lfo = v.osc('sine', 9, t, t + 0.8), lg = v.gain(35);
    lfo.connect(lg); lg.connect(s.frequency);
    const g = v.gain(0);
    perc(g.gain, t, 0.11 * vel, 0.04, 0.7);
    s.connect(g); g.connect(bus);
    return v.done();
  },

  /** Rising whoosh as a boxer beats the count. */
  getup(ctx, out, t, o, res) {
    return whooshCore(ctx, out, t, { dur: 0.45, f0: 300, f1: 1400, f2: 1600, q: 1.5, vel: 0.55 * num(o.gain, 1), color: 'pink', send: 0.15 }, res);
  },

  // ── match presentation (mechanics.md §6 "Audio cue moments"; all of it our own design) ──

  /**
   * The tone under the "Round N" banner: a short airy riser into a bright stacked chord with a
   * sparkle on top. opts.final: the final round — a darker minor colour and a low hit.
   */
  'round-tone'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), fin = !!o.final, rise = 0.2, len = 1.6;
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.35);
    const s = v.buf(res.white, t, t + rise + 0.06), bp = v.filter('bandpass', 600, 1.1), rg = v.gain(0);
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(4800, t + rise);
    rg.gain.setValueAtTime(0, t);
    rg.gain.linearRampToValueAtTime(0.1 * vel, t + rise * 0.85);
    rg.gain.linearRampToValueAtTime(0, t + rise + 0.05);
    s.connect(bp); bp.connect(rg); rg.connect(bus);
    const th = t + rise, root = fin ? 50 : 53;               // D3 minor (final) / F3 major
    const ivs = fin ? [0, 7, 12, 15, 19] : [0, 7, 12, 16, 19];
    const lp = v.filter('lowpass', 1000, 1.5);
    lp.frequency.setValueAtTime(1000, th);
    lp.frequency.exponentialRampToValueAtTime(5600, th + 0.04);
    lp.frequency.exponentialRampToValueAtTime(1300, th + len);
    const env = v.gain(0);
    perc(env.gain, th, 0.3 * vel, 0.01, len);
    lp.connect(env); env.connect(bus);
    const per = 0.5 / Math.sqrt(ivs.length * 2);
    for (const iv of ivs) {
      for (const dt of [-7, 7]) {
        const osc = v.osc('sawtooth', midiToHz(root + iv), th, th + len + 0.05, dt), og = v.gain(per);
        osc.connect(og); og.connect(lp);
      }
    }
    tone(v, bus, 'sine', midiToHz(root - 12), th, 0.38 * vel, 0.004, fin ? 1.1 : 0.8);
    tone(v, bus, 'sine', midiToHz(root + 31), th + 0.03, 0.04 * vel, 0.002, 0.9); // the fifth, three octaves up
    noiseHit(v, bus, res.white, th, 0.16 * vel, 0.0005, 0.03, [['highpass', 3200]]);
    if (fin) tone(v, bus, 'sine', 62, th, 0.3 * vel, 0.004, 0.7, 34);
    return v.done();
  },

  /** The "KO" call: heavier than any punch in the fight — a deep crunching hit on top of the KO boom. */
  'ko-slam'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1);
    const a = SFX.hit(ctx, out, t, { power: 1, knockdown: true, heavy: true, gain: 0.95 * vel, pan: 0 }, res);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.3);
    const drive = v.shaper(makeDriveCurve(2.8));
    drive.connect(bus);
    tone(v, drive, 'sine', 128, t, 0.55 * vel, 0.002, 0.42, 38);
    noiseHit(v, drive, res.pink, t, 0.5 * vel, 0.002, 0.12, [['bandpass', 380, 1.1]]);
    tone(v, bus, 'sine', 48, t + 0.01, 0.5 * vel, 0.006, 1.3, 22);
    const b = SFX['ko-boom'](ctx, out, t + 0.015, { gain: 0.75 * vel }, res);
    return Math.max(a, v.done(), b);
  },

  /**
   * Time slows down (dodge slow motion; opts.deep for the KO replay): a whoosh sweeping down, a
   * falling tone like a tape winding to a stop, and a glassy shimmer as the world freezes. opts.dur s.
   */
  'time-slow'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), deep = !!o.deep, dur = clamp(num(o.dur, deep ? 1.2 : 0.6), 0.25, 3);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.4);
    const s = v.buf(res.pink, t, t + dur + 0.05), bp = v.filter('bandpass', 2600, 1.4), g = v.gain(0);
    bp.frequency.setValueAtTime(deep ? 1800 : 2600, t);
    bp.frequency.exponentialRampToValueAtTime(deep ? 160 : 260, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.85 * vel, t + 0.05);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    s.connect(bp); bp.connect(g); g.connect(bus);
    const f0 = deep ? 150 : 220, osc = v.osc('triangle', f0, t, t + dur + 0.02);
    glide(osc.frequency, t, f0, deep ? 38 : 55, dur);
    const lp = v.filter('lowpass', 900, 0), og = v.gain(0);
    perc(og.gain, t, 0.36 * vel, 0.02, dur);
    osc.connect(lp); lp.connect(og); og.connect(bus);
    for (const f of [1870, 1990]) tone(v, bus, 'sine', f, t, 0.05 * vel, 0.004, 0.45, f * 0.82);
    return v.done();
  },

  /** Real time resumes after a slow-motion window: a soft upward swish. */
  'time-resume'(ctx, out, t, o, res) {
    return whooshCore(ctx, out, t, { dur: 0.2, f0: 300, f1: 2200, f2: 2600, q: 1.3, vel: 0.5 * num(o.gain, 1), color: 'pink', send: 0.1, pan0: num(o.pan, 0), pan1: num(o.pan, 0) }, res);
  },

  /** Camera cut to the player who was just hit: a short thud heard as if through your own skull. opts.heavy. */
  'cut-thud'(ctx, out, t, o, res) {
    const heavy = !!o.heavy, vel = num(o.gain, 1) * (heavy ? 1 : 0.8);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.12);
    const lp = v.filter('lowpass', heavy ? 380 : 480, 0);
    lp.connect(bus);
    tone(v, lp, 'sine', heavy ? 92 : 112, t, 0.75 * vel, 0.004, heavy ? 0.34 : 0.2, heavy ? 34 : 44);
    noiseHit(v, lp, res.brown, t, 0.8 * vel, 0.004, heavy ? 0.26 : 0.15, [['lowpass', 300, 0]]);
    noiseHit(v, lp, res.pink, t, 0.3 * vel, 0.002, 0.06, [['bandpass', 240, 1]]);
    if (heavy) { // the second beat of a "thu-thump"
      const t2 = t + 0.15;
      tone(v, lp, 'sine', 70, t2, 0.42 * vel, 0.006, 0.28, 32);
      noiseHit(v, lp, res.brown, t2, 0.35 * vel, 0.006, 0.2, [['lowpass', 220, 0]]);
    }
    return v.done();
  },

  /** Our logo wipe after the KO call: a big stereo swoosh with a little sparkle run. */
  'outro-wipe'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1);
    const a = whooshCore(ctx, out, t, { dur: 0.75, f0: 260, f1: 3200, f2: 700, q: 1.1, vel: 0.62 * vel, pan0: -0.85, pan1: 0.85, low: 0.7, send: 0.25 }, res);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.45);
    [79, 84, 88, 91, 96].forEach((m, i) => tone(v, bus, 'sine', midiToHz(m), t + 0.12 + i * 0.05, 0.05 * vel, 0.002, 0.3));
    return Math.max(a, v.done());
  },

  /** The white flash / white fade of the outro: a bright "fssh" and a shimmering chord. */
  'flash-sting'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.5);
    noiseHit(v, bus, res.white, t, 0.3 * vel, 0.001, 0.25, [['highpass', 4200]]);
    [[84, 0.07], [88, 0.055], [91, 0.05], [96, 0.04], [100, 0.025]].forEach(([m, amp], i) => tone(v, bus, 'sine', midiToHz(m), t + i * 0.012, amp * vel, 0.003, 1.4 - i * 0.12));
    tone(v, bus, 'sine', midiToHz(60), t, 0.12 * vel, 0.01, 0.9);
    return v.done();
  },

  // ── training ──

  'bag-thump'(ctx, out, t, o, res) {
    const rng = res.rng, P = clamp01(num(o.power, 0.6)), vel = (0.6 + 0.4 * P) * num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.12);
    tone(v, bus, 'sine', 98 * jit(rng, 0.05), t, 0.82 * vel, 0.002, 0.26, 52);
    noiseHit(v, bus, res.pink, t, 0.7 * vel, 0.002, 0.12, [['lowpass', 650, 0]]);
    noiseHit(v, bus, res.white, t, 0.3 * vel, 0.001, 0.03, [['bandpass', 950, 1.6]]);
    for (let i = 0; i < 3; i++) tone(v, bus, 'sine', rand(rng, 3000, 5200), t + 0.03 + rng() * 0.12, 0.022 * vel, 0.001, 0.09);
    return v.done();
  },

  'chain-snap'(ctx, out, t, o, res) {
    const rng = res.rng, vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.25);
    noiseHit(v, bus, res.white, t, 0.55 * vel, 0.0005, 0.04, [['highpass', 2200]]);
    // metallic clank: a little FM pair
    const car = v.osc('sine', 1850, t, t + 0.35), mod = v.osc('sine', 1850 * 1.414, t, t + 0.35), mg = v.gain(0);
    perc(mg.gain, t, 1300, 0.001, 0.25);
    mod.connect(mg); mg.connect(car.frequency);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.22 * vel, 0.001, 0.3);
    car.connect(cg); cg.connect(bus);
    for (let i = 0; i < 7; i++) tone(v, bus, 'sine', rand(rng, 2500, 6000), t + 0.05 + i * 0.06 * jit(rng, 0.3), 0.05 * (1 - i / 8) * vel, 0.001, 0.07);
    return v.done();
  },

  'bag-fall'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.18);
    tone(v, bus, 'sine', 75, t, 0.85 * vel, 0.004, 0.45, 34);
    noiseHit(v, bus, res.brown, t, 0.8 * vel, 0.004, 0.3, [['lowpass', 260, 0]]);
    noiseHit(v, bus, res.pink, t, 0.33 * vel, 0.002, 0.09, [['bandpass', 420, 0.9]]);
    tone(v, bus, 'sine', 64, t + 0.13, 0.32 * vel, 0.003, 0.25, 32);
    return v.done();
  },

  'chain-rattle'(ctx, out, t, o, res) {
    const rng = res.rng, vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.25);
    for (let i = 0; i < 9; i++) tone(v, bus, 'sine', rand(rng, 2600, 6200), t + i * 0.065 * jit(rng, 0.35), 0.1 * (1 - i / 10) * vel, 0.001, 0.08);
    noiseHit(v, bus, res.white, t, 0.1 * vel, 0.05, 0.45, [['bandpass', 6000, 2]]);
    return v.done();
  },

  /** Ball leaves the trainer's hand ("pok"), then builds — brighter and louder — until it arrives (opts.dur s). */
  'ball-throw'(ctx, out, t, o, res) {
    const c = clamp(num(o.pan, 0), -1, 1), vel = num(o.gain, 1), dur = clamp(num(o.dur, 0.45), 0.25, 2.5);
    const v = new Voice(ctx, out, t, res);
    const p = v.pan(c);
    if (p.pan) { p.pan.setValueAtTime(c, t); p.pan.linearRampToValueAtTime(c * 0.2, t + dur); }
    v.toOut(p, 0.08);
    tone(v, p, 'sine', 520, t, 0.22 * vel, 0.001, 0.05, 380);
    const s = v.buf(res.white, t, t + dur + 0.16);
    const bp = v.filter('bandpass', 600, 2);
    glide(bp.frequency, t, 600, 2800, dur);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1 * vel, t + Math.min(0.12, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(Math.max(EPS * 2, 0.65 * vel), t + dur);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.14);
    s.connect(bp); bp.connect(g); g.connect(p);
    return v.done();
  },

  'ball-hit'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.1);
    tone(v, bus, 'sine', 460, t, 0.55 * vel, 0.001, 0.07, 300);
    noiseHit(v, bus, res.white, t, 0.42 * vel, 0.0005, 0.03, [['bandpass', 1700, 1.3]]);
    noiseHit(v, bus, res.pink, t, 0.12 * vel, 0.001, 0.05, [['bandpass', 3500, 0.8]]);
    return v.done();
  },

  'dodge-swish'(ctx, out, t, o, res) {
    const dir = num(o.dir, 1), c = num(o.pan, 0), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, c, 0.3);
    tone(v, bus, 'sine', 3136, t + 0.08, 0.035 * vel, 0.002, 0.18);
    v.done();
    return whooshCore(ctx, out, t, { dur: 0.24, f0: 700, f1: 3600, f2: 1000, q: 2.8, vel: 0.5 * vel, pan0: c - 0.5 * dir, pan1: c + 0.5 * dir }, res);
  },

  'mitt-smack'(ctx, out, t, o, res) {
    const P = clamp01(num(o.power, 0.7)), vel = (0.6 + 0.4 * P) * num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.1);
    noiseHit(v, bus, res.white, t, 0.8 * vel, 0.0008, 0.05, [['bandpass', 1500, 1.6]]);
    noiseHit(v, bus, res.white, t, 0.32 * vel, 0.0004, 0.012, [['highpass', 3200]]);
    tone(v, bus, 'sine', 190, t, 0.5 * vel, 0.002, 0.11, 95);
    noiseHit(v, bus, res.pink, t, 0.32 * vel, 0.002, 0.07, [['lowpass', 900, 0]]);
    return v.done();
  },

  'mitt-up'(ctx, out, t, o, res) {
    const c = num(o.pan, 0);
    return whooshCore(ctx, out, t, { dur: 0.16, f0: 500, f1: 1800, f2: 900, q: 1.5, vel: 0.55 * num(o.gain, 1), pan0: c, pan1: c }, res);
  },

  'trainer-oof'(ctx, out, t, o, res) {
    const rng = res.rng, vel = num(o.gain, 1), f0 = 165 * jit(rng, 0.06);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.15);
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.3 * vel, t + 0.02);
    env.gain.setValueAtTime(0.3 * vel, t + 0.1);
    env.gain.exponentialRampToValueAtTime(EPS, t + 0.3);
    env.connect(bus);
    const bank = formantBank(v, 'oo', env, 1, 4);
    const src = v.osc('sawtooth', f0, t, t + 0.32);
    glide(src.frequency, t, f0, f0 * 0.7, 0.26);
    src.connect(bank);
    noiseHit(v, bus, res.white, t + 0.17, 0.1 * vel, 0.02, 0.13, [['highpass', 1600]]); // the "f"
    return v.done();
  },

  /** Pea whistle. opts.pattern: 'start' (short+long), 'end' (three blasts), 'short'. */
  whistle(ctx, out, t, o, res) {
    const rng = res.rng, vel = 0.25 * num(o.gain, 1);
    const blasts = o.pattern === 'end' ? [[0, 0.2], [0.3, 0.2], [0.6, 0.75]] : o.pattern === 'short' ? [[0, 0.2]] : [[0, 0.16], [0.24, 0.48]];
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.22);
    for (const [dt, len] of blasts) {
      const t0 = t + dt, t1 = t0 + len, f = 2950 * jit(rng, 0.01);
      const g = v.gain(0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vel, t0 + 0.012);
      g.gain.setValueAtTime(vel, t1 - 0.03);
      g.gain.linearRampToValueAtTime(0, t1);
      g.connect(bus);
      const o1 = v.osc('sine', f, t0, t1 + 0.01), o2 = v.osc('sine', f * 2, t0, t1 + 0.01), g2 = v.gain(0.12);
      const trill = v.osc('triangle', 34 * jit(rng, 0.1), t0, t1 + 0.01), d1 = v.gain(170), d2 = v.gain(340);
      trill.connect(d1); d1.connect(o1.frequency); trill.connect(d2); d2.connect(o2.frequency);
      o1.connect(g); o2.connect(g2); g2.connect(g);
      const nz = v.buf(res.white, t0, t1 + 0.01), bp = v.filter('bandpass', 3000, 1.2), ng = v.gain(0.4);
      nz.connect(bp); bp.connect(ng); ng.connect(g);
    }
    return v.done();
  },

  'score-up'(ctx, out, t, o, res) {
    const step = clamp(Math.round(num(o.step, 0)), 0, 12), f = midiToHz(91 + step), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0.1), 0.25);
    tone(v, bus, 'sine', f, t, 0.11 * vel, 0.002, 0.16);
    tone(v, bus, 'sine', f * 2, t, 0.03 * vel, 0.002, 0.08);
    return v.done();
  },

  'score-down'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.08);
    const s = v.osc('square', 330, t, t + 0.24), lp = v.filter('lowpass', 1300, 0), g = v.gain(0);
    glide(s.frequency, t, 330, 205, 0.18);
    perc(g.gain, t, 0.11 * vel, 0.004, 0.2);
    s.connect(lp); lp.connect(g); g.connect(bus);
    return v.done();
  },

  combo(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, num(o.pan, 0), 0.25);
    tone(v, bus, 'triangle', midiToHz(88), t, 0.13 * vel, 0.002, 0.07);
    tone(v, bus, 'triangle', midiToHz(93), t + 0.06, 0.15 * vel, 0.002, 0.14);
    return v.done();
  },

  // ── UI ──

  'ui-hover'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.05);
    tone(v, bus, 'sine', 1320 * jit(res.rng, 0.02), t, 0.11 * vel, 0.002, 0.05, 1760);
    tone(v, bus, 'triangle', 2640, t, 0.028 * vel, 0.002, 0.03);
    return v.done();
  },

  'ui-move'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.03);
    tone(v, bus, 'triangle', 1480 * jit(res.rng, 0.02), t, 0.11 * vel, 0.001, 0.035);
    return v.done();
  },

  'ui-dwell-tick'(ctx, out, t, o, res) {
    const p = clamp01(num(o.progress, 0.5)), vel = num(o.gain, 1);
    const v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0);
    tone(v, bus, 'sine', 1200 + 1000 * p, t, 0.07 * vel, 0.001, 0.025);
    return v.done();
  },

  'ui-confirm'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.12);
    const lp = v.filter('lowpass', 3600, 0);
    lp.connect(bus);
    tone(v, lp, 'square', 1046.5, t, 0.1 * vel, 0.002, 0.07);
    tone(v, lp, 'square', 1568, t + 0.065, 0.105 * vel, 0.002, 0.14);
    tone(v, bus, 'sine', 3136, t + 0.065, 0.045 * vel, 0.002, 0.12);
    return v.done();
  },

  'ui-back'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.08);
    tone(v, bus, 'triangle', 784, t, 0.16 * vel, 0.002, 0.07);
    tone(v, bus, 'triangle', 523.3, t + 0.065, 0.16 * vel, 0.002, 0.12);
    return v.done();
  },

  'ui-deny'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.04);
    const lp = v.filter('lowpass', 900, 0);
    lp.connect(bus);
    tone(v, lp, 'square', 196, t, 0.17 * vel, 0.003, 0.08, 170);
    tone(v, lp, 'square', 175, t + 0.11, 0.17 * vel, 0.003, 0.1, 150);
    return v.done();
  },

  'ui-ready'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.18);
    [72, 76, 79, 84].forEach((m, i) => {
      tone(v, bus, 'triangle', midiToHz(m), t + i * 0.055, 0.14 * vel, 0.002, i === 3 ? 0.3 : 0.1);
      tone(v, bus, 'sine', midiToHz(m + 12), t + i * 0.055, 0.04 * vel, 0.002, 0.08);
    });
    return v.done();
  },

  'ui-alert'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.1);
    tone(v, bus, 'triangle', 880, t, 0.16 * vel, 0.004, 0.12);
    tone(v, bus, 'triangle', 659.3, t + 0.15, 0.16 * vel, 0.004, 0.2);
    return v.done();
  },

  'ui-pause'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.1);
    tone(v, bus, 'triangle', 1046.5, t, 0.15 * vel, 0.003, 0.16, 523.3);
    return v.done();
  },

  'ui-resume'(ctx, out, t, o, res) {
    const vel = num(o.gain, 1), v = new Voice(ctx, out, t, res), bus = outBus(v, 0, 0.1);
    tone(v, bus, 'triangle', 523.3, t, 0.15 * vel, 0.003, 0.16, 1046.5);
    return v.done();
  },
};

/**
 * Snare roll that can be cut short (decision drum roll).
 * @returns {{end:number, stop:(at:number) => void}}
 */
export function drumRoll(ctx, out, t, { dur = 4, vel = 0.8, rate0 = 14, rate1 = 22 } = {}, res) {
  const rng = res.rng, v = new Voice(ctx, out, t, res);
  const master = v.gain(0), p = v.pan(-0.1);
  v.toOut(p, 0.18);
  const hp = v.filter('highpass', 900), bp = v.filter('bandpass', 3200, 0.6), body = v.filter('lowpass', 700, 0), bodyG = v.gain(0.35);
  hp.connect(bp); bp.connect(master); body.connect(bodyG); bodyG.connect(master); master.connect(p);
  const lo = 0.15;
  master.gain.setValueAtTime(lo, t);
  master.gain.linearRampToValueAtTime(1, t + dur);
  let tt = t;
  while (tt < t + dur) {
    const k = (tt - t) / dur;
    const s = v.buf(res.white, tt, tt + 0.08), g = v.gain(0);
    perc(g.gain, tt, (0.5 + 0.5 * rng()) * vel * 1.1, 0.001, 0.06);
    s.connect(g); g.connect(hp); g.connect(body);
    tt += (1 / lerp(rate0, rate1, k)) * jit(rng, 0.08);
  }
  const end = v.done();
  let stopped = false;
  return {
    end,
    stop(at) {
      if (stopped) return;
      stopped = true;
      const a = Math.max(at, t);
      const cur = a >= t + dur ? 1 : lo + (1 - lo) * ((a - t) / dur);
      try {
        master.gain.cancelScheduledValues(a);
        master.gain.setValueAtTime(cur, a);
        master.gain.linearRampToValueAtTime(0, a + 0.05);
      } catch { /* voice already torn down */ }
    },
  };
}

/**
 * Slowed ambience under the KO replay: a low breathing wind and a deep two-voice hum. Lasts `dur`
 * seconds at most; stop(at) fades it out early and ends its sources (nothing keeps running).
 * @returns {{end:number, stop:(at:number) => void}}
 */
export function slowDrone(ctx, out, t, { dur = 12, vel = 0.4, fadeIn = 0.6, fadeOut = 0.5 } = {}, res) {
  const v = new Voice(ctx, out, t, res);
  const D = clamp(num(dur, 12), 0.5, 60), tEnd = t + D, peak = Math.max(0, num(vel, 0.4));
  const fi = Math.min(Math.max(0.01, fadeIn), D / 2), fo = Math.min(Math.max(0.01, fadeOut), D / 2);
  const master = v.gain(0), p = v.pan(0);
  master.connect(p);
  v.toOut(p, 0.35);
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(peak, t + fi);
  master.gain.setValueAtTime(peak, tEnd - fo);
  master.gain.linearRampToValueAtTime(0, tEnd);
  const wind = v.buf(res.brown, t, tEnd + 0.02), lp = v.filter('lowpass', 220, 0), wg = v.gain(0.7);
  wind.connect(lp); lp.connect(wg); wg.connect(master);
  const lfo = v.osc('sine', 0.45, t, tEnd + 0.02), lg = v.gain(0.3);
  lfo.connect(lg); lg.connect(wg.gain);
  for (const [f, amp] of [[55, 0.32], [55.6, 0.28], [82.4, 0.1]]) {
    const o = v.osc('sine', f, t, tEnd + 0.02), g = v.gain(amp);
    o.connect(g); g.connect(master);
  }
  const srcs = v.srcs.slice();
  const end = v.done();
  let stopped = false;
  return {
    end,
    stop(at) {
      if (stopped) return;
      stopped = true;
      const a = Math.max(num(at, t), t);
      if (a >= tEnd) return;
      const cur = a < t + fi ? peak * ((a - t) / fi) : a > tEnd - fo ? peak * ((tEnd - a) / fo) : peak;
      try {
        master.gain.cancelScheduledValues(a);
        master.gain.setValueAtTime(cur, a);
        master.gain.linearRampToValueAtTime(0, a + fo);
        for (const s of srcs) s.stop(a + fo + 0.02);
      } catch { /* voice already torn down */ }
    },
  };
}

/** Every playable SFX name (excluding musical jingles, which live in music.js). */
export const SFX_NAMES = Object.freeze(Object.keys(SFX));
