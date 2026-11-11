// Shared fakes for the audio tests (not a test file itself: the runner only loads *.test.mjs).
// A strict fake WebAudio that throws where browsers throw (non-finite automation values,
// exponential ramps to 0, starting a source twice, connecting to a non-node) and records
// connections; fake timers; a fake speech synthesizer.

export class FakeParam {
  constructor(name, value) { this.name = name; this._v = value; this.events = []; this.inputs = 0; }
  get value() { return this._v; }
  set value(v) { if (!Number.isFinite(v)) throw new TypeError(`${this.name}.value = ${v}`); this._v = v; }
  _ev(type, v, t, extra) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError(`${this.name}.${type}(${v}, ${t}) non-finite`);
    if (t < 0) throw new RangeError(`${this.name}.${type}: negative time ${t}`);
    this.events.push({ type, v, t, ...extra });
    return this;
  }
  setValueAtTime(v, t) { return this._ev('set', v, t); }
  linearRampToValueAtTime(v, t) { return this._ev('linear', v, t); }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new RangeError(`${this.name}: exponential ramp to 0`);
    return this._ev('exp', v, t);
  }
  setTargetAtTime(v, t, tc) {
    if (!(Number.isFinite(tc) && tc >= 0)) throw new RangeError(`${this.name}: bad time constant ${tc}`);
    return this._ev('target', v, t, { tc });
  }
  cancelScheduledValues(t) {
    if (!Number.isFinite(t)) throw new TypeError('cancel: non-finite');
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** Last setTargetAtTime value (or the static value). */
  get lastTarget() { return this.events.filter((x) => x.type === 'target').pop()?.v ?? this._v; }
}

export class FakeNode {
  constructor(ctx, kind, params = {}) {
    this.context = ctx;
    this.kind = kind;
    this.outputs = new Set();
    this.disconnected = false;
    for (const [k, v] of Object.entries(params)) this[k] = new FakeParam(`${kind}.${k}`, v);
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!(dest instanceof FakeNode) && !(dest instanceof FakeParam)) throw new TypeError(`${this.kind}.connect: bad destination`);
    if (dest instanceof FakeNode && dest.context !== this.context) throw new Error('cross-context connect');
    if (dest instanceof FakeParam) dest.inputs++;
    this.outputs.add(dest);
    this.disconnected = false;
    return dest;
  }
  disconnect() { this.outputs.clear(); this.disconnected = true; }
}

export class FakeSource extends FakeNode {
  start(t = 0, offset = 0) {
    if (this.startAt !== undefined) throw new Error(`${this.kind}: start() twice`);
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(offset) || offset < 0) throw new RangeError(`${this.kind}.start(${t}, ${offset})`);
    this.startAt = t;
    this.context.sources.push(this);
  }
  stop(t = 0) {
    if (this.startAt === undefined) throw new Error(`${this.kind}: stop() before start()`);
    if (!Number.isFinite(t)) throw new RangeError('stop: non-finite');
    this.stopAt = t;
  }
}

export class FakeBuffer {
  constructor(ch, len, sr) {
    if (!(len > 0)) throw new RangeError('createBuffer: length');
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr;
    this._data = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._data[i]; }
}

export class FakeContext {
  constructor({ sampleRate = 8000, state = 'running' } = {}) {
    this.sampleRate = sampleRate; // low rate keeps generated noise textures cheap in tests
    this.currentTime = 0;
    this.state = state;
    this.nodes = [];
    this.sources = [];
    this.listeners = {};
    this.destination = new FakeNode(this, 'destination');
    this.resumeCalls = 0;
    this.suspendCalls = 0;
  }
  createGain() { return new FakeNode(this, 'gain', { gain: 1 }); }
  createOscillator() { const o = new FakeSource(this, 'osc', { frequency: 440, detune: 0 }); o.type = 'sine'; return o; }
  createBufferSource() { const s = new FakeSource(this, 'buffer', { playbackRate: 1, detune: 0 }); s.buffer = null; s.loop = false; return s; }
  createBiquadFilter() { const f = new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 }); f.type = 'lowpass'; return f; }
  createStereoPanner() { return new FakeNode(this, 'panner', { pan: 0 }); }
  createDynamicsCompressor() { return new FakeNode(this, 'compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }); }
  createWaveShaper() { const w = new FakeNode(this, 'shaper'); w.curve = null; w.oversample = 'none'; return w; }
  createConvolver() { const c = new FakeNode(this, 'convolver'); c.buffer = null; c.normalize = true; return c; }
  createDelay() { return new FakeNode(this, 'delay', { delayTime: 0 }); }
  createAnalyser() { const a = new FakeNode(this, 'analyser'); a.fftSize = 2048; return a; }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  _emit(type) { for (const fn of this.listeners[type] || []) fn(); }
  resume() { this.resumeCalls++; this.state = 'running'; this._emit('statechange'); return Promise.resolve(); }
  suspend() { this.suspendCalls++; this.state = 'suspended'; this._emit('statechange'); return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  /** Move the clock; fire `onended` for sources that stopped. */
  advance(t) {
    this.currentTime = t;
    for (const s of this.sources) {
      if (!s.ended && s.stopAt !== undefined && s.stopAt <= t) { s.ended = true; s.onended?.(); }
    }
  }
}

export function fakeTimers() {
  let id = 0;
  const timeouts = new Map(), intervals = new Map();
  return {
    setTimeout: (fn, ms) => { timeouts.set(++id, { fn, ms }); return id; },
    clearTimeout: (i) => timeouts.delete(i),
    setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; },
    clearInterval: (i) => intervals.delete(i),
    flush() { const all = [...timeouts.entries()]; timeouts.clear(); for (const [, t] of all) t.fn(); },
    tickIntervals() { for (const t of [...intervals.values()]) t.fn(); },
    get pendingTimeouts() { return timeouts.size; },
    get intervalCount() { return intervals.size; },
  };
}

export function fakeSpeech({ voices = [{ name: 'Daniel', lang: 'en-GB', localService: true }, { name: 'Zed', lang: 'fr-FR' }], autoEnd = false } = {}) {
  const spoken = [];
  let cancels = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const synth = {
    getVoices: () => voices,
    speak: (u) => { spoken.push(u); u.onstart?.(); if (autoEnd) u.onend?.(); },
    cancel: () => { cancels++; },
    addEventListener() {},
  };
  return { speech: { synth, Utterance }, spoken, get cancels() { return cancels; } };
}

/** Expand 'once' / 'fallback' / 'later' cue groups into one flat list (groups stay in too). */
export function flatCues(cues) {
  const out = [];
  for (const c of cues || []) {
    out.push(c);
    if (Array.isArray(c?.cues)) out.push(...flatCues(c.cues));
  }
  return out;
}
