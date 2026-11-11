// Record / replay PoseFrames — capture real webcam sessions once, then tune gestures and
// reproduce bugs without standing up (spec COM07: "validate recognition using captured input
// examples before choosing sensitivity thresholds").
//
// File format (compact JSON, numbers rounded to 4 decimals):
//   { format: 'glove-up-poses', version: 1, createdAt, width, height, meta: {...},
//     frames: [ [tRelMs, [pose, …], width?, height?], … ] }
//   pose = { s: score, i: [x,y,z,vis, …33×4], w: [x,y,z, …33×3] }
// Frames are stored RAW (detection order, before PlayerAssigner) so a replay exercises the
// whole pipeline exactly like the camera did.
//
// Pure logic; download()/load(File|URL) touch browser APIs only when called.

export const RECORDING_FORMAT = 'glove-up-poses';
export const RECORDING_VERSION = 1;

/** Default cap: 5 minutes at 30 fps (≈30 MB of copied landmarks; recording stops itself, meta.truncated). */
const DEFAULT_MAX_FRAMES = 30 * 60 * 5;

const round = (v, k) => (Number.isFinite(v) ? Math.round(v * k) / k : 0);

/**
 * @typedef {Object} Recording
 * @property {string} format
 * @property {number} version
 * @property {number} createdAt
 * @property {number} width
 * @property {number} height
 * @property {Object} meta
 * @property {import('../core/types.js').PoseFrame[]} frames   t relative to the first frame (ms)
 */

/** Encode one PlayerPose compactly. */
function encodePose(pose, k) {
  const i = new Array(pose.image.length * 4);
  pose.image.forEach((l, n) => {
    i[n * 4] = round(l.x, k); i[n * 4 + 1] = round(l.y, k); i[n * 4 + 2] = round(l.z, k); i[n * 4 + 3] = round(l.visibility ?? 0, k);
  });
  const w = new Array((pose.world ? pose.world.length : 0) * 3);
  (pose.world || []).forEach((l, n) => { w[n * 3] = round(l.x, k); w[n * 3 + 1] = round(l.y, k); w[n * 3 + 2] = round(l.z, k); });
  return { s: round(pose.score ?? 0, k), i, w };
}

/** Decode one compact pose back into a PlayerPose. */
function decodePose(p) {
  if (!p || !Array.isArray(p.i) || p.i.length % 4 !== 0) throw new Error('bad pose entry');
  const n = p.i.length / 4;
  const image = new Array(n);
  for (let j = 0; j < n; j++) image[j] = { x: p.i[j * 4], y: p.i[j * 4 + 1], z: p.i[j * 4 + 2], visibility: p.i[j * 4 + 3] };
  const world = new Array(n);
  const w = Array.isArray(p.w) && p.w.length === n * 3 ? p.w : null;
  for (let j = 0; j < n; j++) {
    world[j] = w ? { x: w[j * 3], y: w[j * 3 + 1], z: w[j * 3 + 2], visibility: image[j].visibility } : { x: 0, y: 0, z: 0, visibility: 0 };
  }
  return { image, world, score: Number.isFinite(p.s) ? p.s : 0 };
}

/**
 * Serialize a recording (or any {frames, width, height, meta}) to compact JSON.
 * @param {{frames: import('../core/types.js').PoseFrame[], width?:number, height?:number, meta?:object, createdAt?:number}} rec
 * @param {{decimals?:number}} [opts]
 * @returns {string}
 */
export function encodeRecording(rec, { decimals = 4 } = {}) {
  const k = 10 ** decimals;
  const frames = rec.frames || [];
  const t0 = frames.length ? frames[0].t : 0;
  const width = rec.width || (frames[0] && frames[0].width) || 0;
  const height = rec.height || (frames[0] && frames[0].height) || 0;
  const out = {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    createdAt: rec.createdAt || Date.now(),
    width, height,
    meta: rec.meta || {},
    frames: frames.map((f) => {
      const row = [Math.round((f.t - t0) * 10) / 10, (f.players || []).filter(Boolean).map((p) => encodePose(p, k))];
      if ((f.width && f.width !== width) || (f.height && f.height !== height)) row.push(f.width, f.height);
      return row;
    }),
  };
  return JSON.stringify(out);
}

/**
 * Parse a recording from JSON text or an already-parsed object. Throws a readable Error.
 * @param {string|object} json
 * @returns {Recording}
 */
export function decodeRecording(json) {
  let o = json;
  if (typeof json === 'string') {
    try { o = JSON.parse(json); } catch (e) { throw new Error(`Not a pose recording (invalid JSON: ${e.message})`); }
  }
  if (!o || typeof o !== 'object' || o.format !== RECORDING_FORMAT) throw new Error('Not a pose recording (unknown format).');
  if (o.version > RECORDING_VERSION) throw new Error(`Pose recording version ${o.version} is newer than this game understands.`);
  if (!Array.isArray(o.frames)) throw new Error('Pose recording has no frames.');
  const width = o.width || 640, height = o.height || 480;
  const frames = o.frames.map((row, n) => {
    if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Array.isArray(row[1])) throw new Error(`Pose recording frame ${n} is damaged.`);
    const fw = row[2] || width, fh = row[3] || height;
    const players = row[1].map(decodePose);
    for (const pl of players) pl.aspect = fw / fh;
    return { t: row[0], width: fw, height: fh, players };
  });
  for (let n = 1; n < frames.length; n++) {
    if (frames[n].t <= frames[n - 1].t) frames[n].t = frames[n - 1].t + 0.1; // keep strictly increasing
  }
  return { format: RECORDING_FORMAT, version: o.version || 1, createdAt: o.createdAt || 0, width, height, meta: o.meta || {}, frames };
}

export class Recorder {
  /** @param {{maxFrames?:number, decimals?:number}} [opts] */
  constructor({ maxFrames = DEFAULT_MAX_FRAMES, decimals = 4 } = {}) {
    this.maxFrames = maxFrames;
    this.decimals = decimals;
    this.recording = false;
    /** @type {import('../core/types.js').PoseFrame[]} */
    this.frames = [];
    this.meta = {};
    this.startedAt = 0;
    this.truncated = false;
  }

  /** Start a new recording (clears the previous one). */
  start(meta = {}) {
    this.frames = [];
    this.meta = { ...meta };
    this.startedAt = Date.now();
    this.truncated = false;
    this.recording = true;
  }

  /** Stop and return the recording. */
  stop() {
    this.recording = false;
    return this.toRecording();
  }

  clear() { this.frames = []; this.truncated = false; }

  get frameCount() { return this.frames.length; }
  get durationMs() { return this.frames.length > 1 ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0; }

  /**
   * Add a RAW PoseFrame (detection order). Ignored unless recording. Poses are copied, so
   * later mutation by consumers can't corrupt the take.
   */
  push(frame) {
    if (!this.recording || !frame) return;
    if (this.frames.length >= this.maxFrames) { this.truncated = true; this.recording = false; return; }
    const last = this.frames[this.frames.length - 1];
    if (last && frame.t <= last.t) return;
    this.frames.push({
      t: frame.t, width: frame.width, height: frame.height,
      players: (frame.players || []).filter(Boolean).map((p) => ({
        image: p.image.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
        world: (p.world || []).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
        score: p.score ?? 0,
      })),
    });
  }

  /** @returns {Recording} with t relative to the first frame */
  toRecording() {
    const t0 = this.frames.length ? this.frames[0].t : 0;
    const f0 = this.frames[0];
    return {
      format: RECORDING_FORMAT, version: RECORDING_VERSION, createdAt: this.startedAt || Date.now(),
      width: f0 ? f0.width : 0, height: f0 ? f0.height : 0, meta: { ...this.meta, truncated: this.truncated },
      frames: this.frames.map((f) => ({ ...f, t: f.t - t0 })),
    };
  }

  toJSON() { return encodeRecording(this.toRecording(), { decimals: this.decimals }); }

  /** Browser: save the recording as a .json download. */
  download(filename = `glove-up-poses-${new Date().toISOString().replace(/[:.]/g, '-')}.json`) {
    if (typeof document === 'undefined') throw new Error('download() needs a browser');
    const blob = new Blob([this.toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }

  /**
   * Load a recording from a File/Blob, a URL, JSON text or a parsed object.
   * @param {Blob|string|object} src
   * @returns {Promise<Recording>}
   */
  static async load(src) {
    if (typeof Blob !== 'undefined' && src instanceof Blob) return decodeRecording(await src.text());
    if (typeof src === 'string') {
      const s = src.trim();
      if (s.startsWith('{')) return decodeRecording(s);
      const res = await fetch(s);
      if (!res.ok) throw new Error(`Could not load pose recording ${s} (HTTP ${res.status}).`);
      return decodeRecording(await res.text());
    }
    return decodeRecording(src);
  }
}

/**
 * Plays a Recording back in real time: next(nowMs) returns every frame that became due since
 * the previous call, re-timestamped into the caller's clock (strictly increasing, also across
 * loops).
 */
export class ReplaySource {
  /**
   * @param {Recording} recording
   * @param {{loop?:boolean, speed?:number}} [opts]
   */
  constructor(recording, { loop = false, speed = 1, maxLagMs = 750 } = {}) {
    this.recording = recording;
    this.loop = loop;
    this.speed = speed > 0 ? speed : 1;
    /** Frames that are more than this late (caller stalled, tab hidden) are skipped, not flooded. */
    this.maxLagMs = maxLagMs;
    const fr = recording.frames || [];
    this._frames = fr;
    this._dur = fr.length ? fr[fr.length - 1].t - fr[0].t : 0;
    this._gap = fr.length > 1 ? Math.max(1, this._dur / (fr.length - 1)) : 33;
    this.reset();
  }

  reset() {
    this._start = null;   // caller time of recording t = first frame
    this._idx = 0;
    this._lap = 0;
    this._lastOut = -Infinity;
  }

  /** True once a non-looping replay has emitted its last frame. */
  get done() { return !this.loop && this._idx >= this._frames.length; }
  get durationMs() { return this._dur / this.speed; }
  /** Progress through the current lap, 0..1. */
  get progress() { return this._frames.length ? Math.min(1, this._idx / this._frames.length) : 1; }

  /**
   * @param {number} nowMs caller clock (e.g. performance.now())
   * @returns {import('../core/types.js').PoseFrame[]}
   */
  next(nowMs) {
    const fr = this._frames;
    if (!fr.length) return [];
    if (this._start === null) this._start = nowMs;
    const out = [];
    const t0 = fr[0].t;
    for (let guard = 0; guard < 10000; guard++) {
      if (this._idx >= fr.length) {
        if (!this.loop) break;
        this._idx = 0;
        this._lap++;
      }
      const f = fr[this._idx];
      const lapOffset = this._lap * (this._dur + this._gap);
      const due = this._start + (f.t - t0 + lapOffset) / this.speed;
      if (due > nowMs) break;
      if (nowMs - due > this.maxLagMs) { this._idx++; continue; } // far behind (hidden tab): skip, don't flood
      let t = due;
      if (t <= this._lastOut) t = this._lastOut + 0.1;
      this._lastOut = t;
      out.push({ t, width: f.width, height: f.height, players: f.players });
      this._idx++;
    }
    return out;
  }
}
