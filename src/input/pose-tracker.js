// PoseTracker — thin, robust wrapper around the MediaPipe Pose Landmarker (tasks-vision).
//
//  * Loads the wasm runtime from `<base>mediapipe/wasm` and the model from
//    `<base>models/pose_landmarker_{full|lite}.task` (served locally; `npm run setup:models`).
//  * VIDEO running mode, 1..3 poses, GPU delegate first with automatic CPU fallback — both
//    at init (incl. a warm-up inference, where broken GPU stacks usually fail) and at run
//    time (a GPU detect that throws switches to CPU once). `delegate` says which one runs.
//  * Detects only when the video has a NEW frame (requestVideoFrameCallback when it fires,
//    otherwise currentTime polling capped at the camera rate) and feeds MediaPipe strictly
//    increasing timestamps.
//  * Returns PoseFrame objects (src/core/types.js): players in DETECTION order — run them
//    through PlayerAssigner to get stable P1/P2 slots. Each frame carries `timing` (capture →
//    pose-ready latency from the frame-callback metadata; research/mechanics.md §4.6) and
//    getStats() reports the rolling median (latencyMs, latencySource).
//
// No DOM access at import time: @mediapipe/tasks-vision is imported lazily inside init(), so this
// file (and toPlayerPose/poseScore) can be imported in Node. Importing it does one thing: it wraps
// the global fetch with the telemetry guard (no-telemetry.js; everything else passes through), so a
// main-thread landmarker (?detector=main, or the worker's fallback) never sends MediaPipe's usage
// statistics to Google (R5).
//
// This class detects on the main thread (`kind` 'main'): detect() blocks for the whole inference.
// WorkerPoseTracker (pose-worker-tracker.js, `kind` 'worker') extends it and runs the same model in
// a dedicated worker instead; it falls back to this class when the worker cannot start.
//
// Errors: TrackerError {code, message, help, title, source:'tracker', devHint}. message/help/title
// are written for players (no developer commands, in dev and production builds alike); devHint is the
// developer's remedy, logged once to the console by the input hub.
//
// Per-stage timings (PERF-06): every tracker keeps a PipelineMeter (exported below). For each detected
// frame it records, on the page clock: camera capture (frame metadata), frame available to the page
// (frame callback), handed to the detector, inference start / end, result back on the main thread and
// processed by the game. getStats().pipeline / pipelineStats() summarise the last couple of seconds
// (camera and detection rates, the slowest 1-s detection rate of the last 10 s, p50/p90 per stage).

import { LM } from '../core/types.js';
import { MP_NOISE } from './pose-worker-codec.js';
import { blockMediapipeTelemetry } from './no-telemetry.js';

// Before any landmarker exists on this thread: MediaPipe's usage logger is answered locally (R5).
blockMediapipeTelemetry(globalThis);

/** Tunables (all documented). */
export const TRACKER_DEFAULTS = Object.freeze({
  /** Directory (relative to basePath) holding vision_wasm_*.{js,wasm}. */
  wasmDir: 'mediapipe/wasm',
  /** Model files (relative to basePath). 'full' is more accurate, 'lite' ~2x faster. */
  modelFiles: Object.freeze({ full: 'models/pose_landmarker_full.task', lite: 'models/pose_landmarker_lite.task' }),
  /** MediaPipe confidences. Slightly below the 0.5 defaults keeps fast-moving fists tracked. */
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.45,
  minTrackingConfidence: 0.45,
  /** EMA factor for the reported detect time. */
  statsAlpha: 0.1,
  /** Window for the detections-per-second figure. */
  fpsWindowMs: 1000,
  /** requestVideoFrameCallback counts as "working" if it fired within this many ms. */
  rvfcStallMs: 400,
  /**
   * Rate cap when falling back to currentTime polling (live streams advance continuously). The input hub
   * raises it to the camera's own rate with setCameraFps() (a 60 fps camera, PERF-06).
   */
  pollFps: 30,
  /** PipelineMeter: the window of the rates and stage percentiles (getStats().pipeline). */
  pipelineWindowMs: 2000,
  /**
   * WorkerPoseTracker: finished results waiting for the game (PERF-06: all of them are delivered, in order).
   * More than this many (a page stall) and the oldest are dropped: ≈ 200 ms at 30 fps, 100 ms at 60 fps.
   */
  maxQueuedResults: 6,
  /** Run one inference on a blank image during init so a broken GPU path fails early. */
  warmup: true,
  /** Consecutive detect errors (after any fallback) before the tracker reports a fatal error. */
  maxConsecutiveErrors: 20,
  /** Skip the GPU delegate when WebGL is software-rendered (SwiftShader/llvmpipe): CPU wasm is far faster there. */
  avoidSoftwareGL: true,
  /**
   * If the GPU's median detect time over the first `slowGpuFrames` frames exceeds this, switch to CPU.
   * Main-thread detection decides on that first window; the detection worker looks a second time
   * (slowGpuRecheckMs) unless the first window was above slowGpuSevereMs. With a switch gate (the input hub,
   * PERF-06) the verdict is left in tracker.slowGpu and the hub moves at a safe moment, as a trial.
   */
  slowGpuMs: 90,
  slowGpuFrames: 12,
  /**
   * Latency (research/mechanics.md §4.6): every PoseFrame carries `timing.latencyMs` = when its pose
   * was ready − when the camera captured it. The capture time comes from requestVideoFrameCallback
   * metadata (captureTime, then receiveTime); without them the frame's presentationTime /
   * expectedDisplayTime (or, when polling, the moment the new frame was noticed minus half a frame)
   * stands in, plus `nominalCaptureMs` for a live camera (sensor → browser, not visible to the page).
   */
  nominalCaptureMs: 40,
  /** Samples in the rolling latency median (getStats().latencyMs). */
  latencyWindow: 45,
  /** WorkerPoseTracker: the worker must be ready this soon (load + warm-up), else detection falls back to the main thread. */
  workerInitTimeoutMs: 45000,
  /** WorkerPoseTracker: options / delegate switches must be answered this soon. */
  workerRequestTimeoutMs: 15000,
  /**
   * WorkerPoseTracker: a frame unanswered for this long of live page time means the worker is stuck →
   * fall back to the main thread. Time in which the page itself was stalled does not count (workerPageStallMs).
   */
  workerStallMs: 5000,
  /**
   * WorkerPoseTracker: a detect() call this long after the previous one means the page itself was stalled
   * (a long task, a debugger pause, a frozen machine), not the worker: the gap is taken out of the age of
   * the frame in flight, because the worker's answer may still be queued behind this rendering step
   * (RV-PERF-01). Live time before and between stalls still counts, so a dead worker is caught after
   * workerStallMs of live page time even while the page keeps stalling. An absolute 1 s, not a share of
   * workerStallMs.
   */
  workerPageStallMs: 1000,
  /**
   * WorkerPoseTracker: a first slow-GPU window (slowGpuFrames frames, median > slowGpuMs) is checked
   * again this long after it, and only a second slow window switches the worker to the CPU delegate. The
   * worker runs one scheduling class below the page, so a busy start-up (or other busy programs) can starve
   * one window without the GPU being slow (RV-PERF-02). Main-thread detection decides on the first window.
   * 8 s (was 3 s, PERF-06): a GPU starved by the game's own rendering (a Retina-size arena at pixel ratio 2)
   * looks slow until the adaptive render quality has given its GPU time back (≈ 4–6 s), and a CPU delegate
   * picked then stays for the session at roughly twice the GPU's unstarved detect time.
   */
  slowGpuRecheckMs: 8000,
  /**
   * WorkerPoseTracker: a first window this slow (median, ms) switches at once, without the second look. 1000
   * (was 270, PERF-06): at start-up the title arena drawn at pixel ratio 2 on a Retina screen plus a busy machine
   * (load ≈ 11) starved healthy GPU windows to 220–430 ms medians, and the switch then pinned the CPU delegate
   * (≈ 100 ms per pose under that load) for the session; the adaptive render quality frees the GPU within ≈ 5 s,
   * before the second look. Only a GPU slower than a second per frame skips that look.
   */
  slowGpuSevereMs: 1000,
});

/** Upper-body landmarks whose mean visibility is PlayerPose.score. */
export const UPPER_BODY = Object.freeze([LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST]);

/** Player-facing titles per tracker error code (the camera itself may be fine). */
export const TRACKER_ERROR_TITLES = Object.freeze({
  unsupported: 'Pose tracking can’t run in this browser',
  'wasm-missing': 'Pose-tracking files missing',
  'model-missing': 'Pose model missing',
  'init-failed': 'Pose tracking couldn’t start',
  'detect-failed': 'Pose tracking stopped',
});

/** Developer remedy for missing / damaged model or runtime files (never shown to players in a build). */
export const SETUP_DEV_HINT = 'Run "npm run setup:models" in the project folder, then reload the page.';

/**
 * Readable tracker error; `code` ∈ unsupported | wasm-missing | model-missing | init-failed | detect-failed.
 * `source` is always 'tracker' (CameraError has 'camera'): the pose model/runtime failed, not the camera.
 */
export class TrackerError extends Error {
  /**
   * @param {string} code
   * @param {string} message  one sentence for players
   * @param {string} [help]   what players can do (no developer commands)
   * @param {unknown} [cause]
   * @param {{devHint?:string, title?:string}} [o]  devHint: the developer's remedy (console only, never shown to players)
   */
  constructor(code, message, help = '', cause = undefined, { devHint = '', title = '' } = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.source = 'tracker';
    this.title = title || TRACKER_ERROR_TITLES[code] || 'Pose tracking problem';
    this.devHint = devHint;
    this.help = help; // players are never told to run npm scripts (the console gets devHint)
    this.cause = cause;
  }
  get fullMessage() { return this.help ? `${this.message} ${this.help}` : this.message; }
}

/** What players can do when the game's own pose files are missing or damaged. */
const FILES_HELP = 'Pose tracking can’t start without it. Reload the page, or choose Use keyboard instead. If you set the game up yourself, see Setup in the README.';

const DEFAULT_BASE = (() => {
  try { return (import.meta.env && import.meta.env.BASE_URL) || '/'; } catch { return '/'; }
})();

export const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// MediaPipe's start-up chatter (MP_NOISE, pose-worker-codec.js) is dropped while our own calls into
// MediaPipe run so the console stays meaningful. Anything else passes through untouched.
let quietDepth = 0;
let savedConsole = null;
function quietStart() {
  if (typeof console === 'undefined') return;
  if (quietDepth++ > 0) return;
  savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(savedConsole)) {
    const orig = savedConsole[k];
    console[k] = (...a) => { if (typeof a[0] === 'string' && MP_NOISE.test(a[0])) return; orig.apply(console, a); };
  }
}
function quietEnd() {
  if (typeof console === 'undefined' || quietDepth === 0) return;
  if (--quietDepth > 0) return;
  Object.assign(console, savedConsole);
  savedConsole = null;
}
const errText = (e) => (e && e.message) ? e.message : String(e);

/**
 * Mean visibility of the upper-body landmarks (0..1).
 * @param {import('../core/types.js').Landmark[]} image
 */
export function poseScore(image) {
  if (!image || image.length < 17) return 0;
  let s = 0;
  for (const i of UPPER_BODY) s += image[i]?.visibility ?? 0;
  return s / UPPER_BODY.length;
}

const copyLm = (l) => {
  const o = { x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 };
  if (l.presence !== undefined) o.presence = l.presence;
  return o;
};

/**
 * Convert one MediaPipe result entry into a PlayerPose (plain objects, safe to keep).
 * @param {Array<{x:number,y:number,z:number,visibility?:number,presence?:number}>} landmarks
 * @param {Array<{x:number,y:number,z:number,visibility?:number}>} [world]
 * @param {number} [aspect]  camera frame width/height (stamped on the pose for the recognizer)
 * @returns {import('../core/types.js').PlayerPose}
 */
export function toPlayerPose(landmarks, world, aspect) {
  const image = landmarks.map(copyLm);
  const w = (world && world.length === landmarks.length)
    ? world.map((l, i) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? image[i].visibility }))
    : image.map(() => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const pose = { image, world: w, score: poseScore(image) };
  if (aspect > 0) pose.aspect = aspect;
  return pose;
}

/** p-quantile of a numeric array (nearest rank), rounded to 0.1 ms; null when empty. */
function quantile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return Math.round(a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))] * 10) / 10;
}

/**
 * Rolling per-stage timings of the camera → pose → game pipeline (PERF-06). All times are page-clock ms
 * (performance.now()); a stage whose ends are unknown (no capture metadata, main-thread detection has no
 * transfer) is simply left out of that stage's percentiles.
 *
 *   frameSeen(t)        a new camera frame became available to the page (frame callback / poll / worker read)
 *   record({capture, seen, sent, start, end, arrived, picked, ms})   one detected frame
 *   stats(now)          {camFps, detFps, detFpsMin, detMs, waitMs, queueMs, returnMs, capToSeen, capToPose,
 *                        poseToGame, capToGame, frames, windowMs, ageMs}  (each stage {p50, p90}; cached ≤ 200 ms)
 */
export class PipelineMeter {
  constructor({ windowMs = TRACKER_DEFAULTS.pipelineWindowMs, minWindowMs = 10000 } = {}) {
    this.windowMs = windowMs;
    this.minWindowMs = minWindowMs;
    this._seen = [];
    this._recs = [];
    this._buckets = [];      // detections per 1-s bucket for the detFpsMin figure: [bucketStart, count]
    this._cache = null;
    this._cacheAt = -Infinity;
    this._firstAt = Infinity;
  }

  reset() { this._seen = []; this._recs = []; this._buckets = []; this._cache = null; this._cacheAt = -Infinity; this._firstAt = Infinity; }

  frameSeen(t) {
    if (!Number.isFinite(t)) return;
    if (t < this._firstAt) this._firstAt = t;
    this._seen.push(t);
    if (this._seen.length > 400) this._seen.splice(0, this._seen.length - 400);
  }

  record(r) {
    const at = Number.isFinite(r.picked) ? r.picked : Number.isFinite(r.arrived) ? r.arrived : r.end;
    if (!Number.isFinite(at)) return;
    if (at < this._firstAt) this._firstAt = at;
    this._recs.push({ ...r, at });
    if (this._recs.length > 400) this._recs.splice(0, this._recs.length - 400);
    const b = Math.floor(at / 1000) * 1000;
    const last = this._buckets[this._buckets.length - 1];
    if (last && last[0] === b) last[1]++;
    else {
      // empty seconds between two detections count as 0
      if (last) for (let s = last[0] + 1000; s < b && s - last[0] <= this.minWindowMs; s += 1000) this._buckets.push([s, 0]);
      this._buckets.push([b, 1]);
    }
    while (this._buckets.length && this._buckets[0][0] < b - this.minWindowMs) this._buckets.shift();
    this._cache = null;
  }

  /** @param {number} now  page clock */
  stats(now) {
    if (this._cache && now - this._cacheAt < 200 && now >= this._cacheAt) return this._cache;
    const from = now - this.windowMs;
    while (this._seen.length && this._seen[0] < from - 1000) this._seen.shift();
    while (this._recs.length && this._recs[0].at < from - 1000) this._recs.shift();
    const seen = this._seen.filter((t) => t >= from && t <= now);
    const recs = this._recs.filter((r) => r.at >= from && r.at <= now);
    // rates over the window, or over the time since the first sample while the meter is younger than that
    const span = Number.isFinite(this._firstAt) ? Math.max(250, Math.min(this.windowMs, now - this._firstAt)) : this.windowMs;
    const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN);
    const stage = (f) => { const v = recs.map(f); return { p50: quantile(v, 0.5), p90: quantile(v, 0.9) }; };
    // the slowest full second of the last minWindowMs (the current, unfinished second does not count)
    const cur = Math.floor(now / 1000) * 1000;
    const full = this._buckets.filter((b) => b[0] < cur && b[0] >= cur - this.minWindowMs);
    const s = {
      windowMs: Math.round(span),
      /** how long this meter has been watching (since its first sample after a reset) */
      ageMs: Number.isFinite(this._firstAt) ? Math.round(now - this._firstAt) : 0,
      frames: recs.length,
      camFps: Math.round((seen.length * 1000 / span) * 10) / 10,
      detFps: Math.round((recs.length * 1000 / span) * 10) / 10,
      detFpsMin: full.length ? Math.min(...full.map((b) => b[1])) : null,
      detMs: stage((r) => r.ms),
      waitMs: stage((r) => d(r.seen, r.sent)),
      queueMs: stage((r) => d(r.sent, r.start)),
      returnMs: stage((r) => d(r.end, r.arrived)),
      capToSeen: stage((r) => d(r.capture, r.seen)),
      capToPose: stage((r) => d(r.capture, r.arrived)),
      poseToGame: stage((r) => d(r.arrived, r.picked)),
      capToGame: stage((r) => d(r.capture, r.picked)),
    };
    this._cache = s;
    this._cacheAt = now;
    return s;
  }
}

export class PoseTracker {
  /**
   * @param {{numPoses?:number, model?:'full'|'lite', delegate?:'GPU'|'CPU', basePath?:string, tuning?:object}} [opts]
   */
  constructor({ numPoses = 1, model = 'full', delegate = 'GPU', basePath = DEFAULT_BASE, tuning = {} } = {}) {
    this.tuning = { ...TRACKER_DEFAULTS, ...tuning };
    this.numPoses = clampPoses(numPoses);
    this.model = model === 'lite' ? 'lite' : 'full';
    this.requestedDelegate = delegate === 'CPU' ? 'CPU' : 'GPU';
    this.basePath = basePath.endsWith('/') ? basePath : basePath + '/';
    /** Where detection runs: 'main' (this class) | 'worker' (WorkerPoseTracker). */
    this.kind = 'main';
    /** 'GPU' | 'CPU' | null — the delegate actually running. */
    this.delegate = null;
    /** Why GPU was not used (null if it is). */
    this.fallbackReason = null;
    /** Fatal runtime error (TrackerError) or null. */
    this.error = null;
    this._landmarker = null;
    this._vision = null;
    this._fileset = null;
    this._modelBuffer = null;
    this._initPromise = null;
    this._switching = null;
    this._closed = false;
    this._lastTs = 0;
    this._consecutiveErrors = 0;
    /** First detections still emit one-time runtime notices (see MP_NOISE). */
    this._quietFrames = 90;
    /** Did the last detect() call do detection work on this thread? (InputHub.lastDetectMs) */
    this._worked = false;
    /** Optional hook called from the video-frame callback: (video, wallNow, meta) → void. */
    this._onVideoFrame = null;
    // new-frame detection
    this._video = null;
    this._rvfcHandle = 0;
    this._rvfcPending = false;
    this._rvfcMeta = null;
    this._rvfcLastWall = -Infinity;
    this._rvfcSupported = false;
    this._watchStart = 0;
    this._lastCurrentTime = -1;
    this._lastDetectWall = -Infinity;
    // latency (capture → pose ready)
    this._frameRef = null;
    this._latencies = [];
    this._latencySource = null;
    // stats
    this._detectMsEma = 0;
    this._durations = [];
    this._detectTimes = [];
    this.frames = 0;
    this.initMs = 0;
    /** Per-stage pipeline timings (PERF-06). */
    this._meter = new PipelineMeter({ windowMs: this.tuning.pipelineWindowMs });
    /** Polling cap (frames per second) when the frame callback does not fire; the camera's own rate (setCameraFps). */
    this._pollFps = this.tuning.pollFps;
    /** nowMs() of the last frame callback (when the frame became available to the page). */
    this._rvfcLastCb = -Infinity;
    // PERF-06 two-phase switch: the landmarker prepared next to the running one, and the one a commit kept
    this._prepared = null;
    this._kept = null;
    this._prepGen = 0;
    /**
     * Optional () => boolean set by the input hub: when present, a slow-GPU verdict (RV-PERF-02) is not acted on here;
     * it is left in `slowGpu` ({median, reason}) for the hub, which moves to the CPU at a safe moment (PERF-06).
     */
    this.switchGate = null;
    this.slowGpu = null;
  }

  /**
   * The camera's frame rate (PERF-06: 60 fps cameras): the polling fallback may detect up to this rate.
   * @param {number} fps
   */
  setCameraFps(fps) {
    const v = Number(fps);
    this._pollFps = Number.isFinite(v) && v > 0 ? Math.max(5, Math.min(120, v)) : this.tuning.pollFps;
  }

  /** Per-stage pipeline timings of the last couple of seconds (PipelineMeter.stats). */
  pipelineStats(now = nowMs()) { return this._meter.stats(now); }

  /** Start the pipeline figures over (the camera rate or the pose budget changed: older rates would mislead). */
  resetPipeline() { this._meter.reset(); }

  get ready() { return !!this._landmarker && !this._closed; }
  get modelUrl() { return this.basePath + this.tuning.modelFiles[this.model]; }
  get wasmUrl() { return this.basePath + this.tuning.wasmDir; }
  /** True if the last detect() call ran detection work on this thread (InputHub.lastDetectMs). */
  get lastCallWorked() { return this._worked; }

  /**
   * Load runtime + model and create the landmarker (GPU first, CPU fallback).
   * @returns {Promise<{delegate:string, model:string, fallbackReason:string|null, initMs:number}>}
   * @throws {TrackerError} readable error (missing model/wasm, no WebAssembly, both delegates failed)
   */
  async init() {
    if (this.ready) return this.info();
    if (!this._initPromise) {
      this._closed = false;
      this._initPromise = this._doInit().finally(() => { this._initPromise = null; });
    }
    return this._initPromise;
  }

  info() {
    return { delegate: this.delegate, model: this.model, fallbackReason: this.fallbackReason, initMs: this.initMs };
  }

  async _doInit() {
    const t0 = nowMs();
    if (typeof WebAssembly === 'undefined') {
      throw new TrackerError('unsupported', 'This browser cannot run the pose tracker (WebAssembly is unavailable).',
        'Use a recent Chrome, Edge, Firefox or Safari, or choose Use keyboard instead.');
    }
    if (!this._vision) {
      try {
        this._vision = await import('@mediapipe/tasks-vision');
      } catch (e) {
        throw new TrackerError('init-failed', 'The pose-tracking library failed to load.', 'Reload the page, or choose Use keyboard instead.', e);
      }
    }
    const [fileset, buffer] = await Promise.all([this._resolveFileset(), this._loadModel()]);
    let order = this.requestedDelegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
    let lastErr = null;
    this.fallbackReason = this.requestedDelegate === 'CPU' ? 'CPU requested' : null;
    const problem = this.tuning.avoidSoftwareGL && order[0] === 'GPU' ? gpuProblem() : null;
    if (problem) {
      order = ['CPU'];
      this.fallbackReason = `${problem} — CPU is faster`;
    }
    for (const delegate of order) {
      if (this._closed) break;
      let lm = null;
      quietStart();
      try {
        const opts = this._options(delegate, buffer);
        lm = await this._vision.PoseLandmarker.createFromOptions(fileset, opts);
        // setNumPoses() while the landmarker was being created (activity / setup switch): apply it now
        if (opts.numPoses !== this.numPoses && typeof lm.setOptions === 'function') await lm.setOptions({ numPoses: this.numPoses });
        if (this.tuning.warmup) this._warmup(lm);
        if (this._closed) { closeQuietly(lm); break; }
        this._landmarker = lm;
        this.delegate = delegate;
        this.error = null;
        this.initMs = nowMs() - t0;
        return this.info();
      } catch (e) {
        lastErr = e;
        closeQuietly(lm);
        if (delegate === 'GPU') this.fallbackReason = `GPU unavailable (${shortErr(e)})`;
      } finally {
        quietEnd();
      }
    }
    if (this._closed) throw new TrackerError('init-failed', 'Pose tracking was stopped while starting.');
    // Both delegates failed: a missing runtime file is the usual culprit — say so plainly.
    if (await this._wasmMissing(fileset)) {
      throw new TrackerError('wasm-missing', `This copy of the game is missing its pose-tracking runtime (${this.wasmUrl}).`,
        FILES_HELP, lastErr, { devHint: SETUP_DEV_HINT });
    }
    throw new TrackerError('init-failed', `Pose tracking could not start (${shortErr(lastErr)}).`,
      'Reload the page. If it keeps failing, try another browser, or choose Use keyboard instead.', lastErr);
  }

  async _resolveFileset() {
    if (this._fileset) return this._fileset;
    this._fileset = await this._vision.FilesetResolver.forVisionTasks(this.wasmUrl);
    return this._fileset;
  }

  /** A missing file comes back as 404 or as the dev server's HTML fallback page. */
  async _wasmMissing(fileset) {
    try {
      const res = await fetch(fileset.wasmLoaderPath, { cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      return res.status === 404 || (res.ok && /text\/html/i.test(type));
    } catch {
      return false;
    }
  }

  /**
   * Fetch and check a model file (cached for the running model). @param {'full'|'lite'} [m] another model (PERF-06
   * prepareSwitch): fetched fresh, not cached.
   */
  async _loadModel(m = this.model) {
    const own = m === this.model;
    if (own && this._modelBuffer) return this._modelBuffer;
    const url = this.basePath + this.tuning.modelFiles[m === 'lite' ? 'lite' : 'full'];
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new TrackerError('model-missing', `The pose model could not be downloaded (${url}).`,
        'Check that the game is still running (its server or tab), then reload the page — or choose Use keyboard instead.', e);
    }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || /text\/html/i.test(type)) {
      throw new TrackerError('model-missing',
        `This copy of the game is missing its pose model (${url}${res.ok ? '' : `, HTTP ${res.status}`}).`,
        FILES_HELP, undefined, { devHint: SETUP_DEV_HINT });
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // .task files are zip archives (a "PK\3\4" header within the first bytes; the official
    // models start with two zero bytes); anything else is a broken download or an HTML page.
    if (buf.byteLength < 100_000 || !hasZipHeader(buf)) {
      throw new TrackerError('model-missing', `This copy of the game has a damaged pose model (${url}, ${buf.byteLength} bytes).`,
        FILES_HELP, undefined, { devHint: SETUP_DEV_HINT });
    }
    if (own) this._modelBuffer = buf;
    return buf;
  }

  _options(delegate, buffer) {
    const t = this.tuning;
    return {
      baseOptions: { modelAssetBuffer: buffer, delegate },
      runningMode: 'VIDEO',
      numPoses: this.numPoses,
      minPoseDetectionConfidence: t.minPoseDetectionConfidence,
      minPosePresenceConfidence: t.minPosePresenceConfidence,
      minTrackingConfidence: t.minTrackingConfidence,
      outputSegmentationMasks: false,
    };
  }

  /** One inference on a small blank image; throws if the delegate's pipeline is broken. */
  _warmup(lm) {
    let img;
    if (typeof ImageData !== 'undefined') img = new ImageData(64, 64);
    else return;
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    this._lastTs = Math.max(this._lastTs + 1, 1);
    lm.detectForVideo(img, this._lastTs);
  }

  /** Change how many people MediaPipe looks for (1..3). */
  async setNumPoses(n) {
    const v = clampPoses(n);
    if (v === this.numPoses) return;
    this.numPoses = v;
    this._meter.reset(); // the other pose budget detects at another speed (PERF-06 judges the new one)
    if (this._landmarker) {
      try { await this._landmarker.setOptions({ numPoses: v }); } catch (e) { this.error = new TrackerError('detect-failed', `Could not switch the number of tracked people (${shortErr(e)}).`, 'Reload the page, or choose Use keyboard instead.', e); }
    }
  }

  /** Switch between the 'full' and 'lite' model (re-creates the landmarker). */
  async setModel(model) {
    const m = model === 'lite' ? 'lite' : 'full';
    if (m === this.model && this.ready) return this.info();
    this.model = m;
    this._modelBuffer = null;
    const old = this._landmarker;
    this._landmarker = null;
    closeQuietly(old);
    this._resetTimings();
    return this.init();
  }

  /** A new model or delegate: its detect times start over (stats, pipeline meter). */
  _resetTimings() {
    this._durations = [];
    this._detectTimes = [];
    this._meter.reset();
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  /**
   * Run detection if `video` shows a frame we have not processed yet.
   * @param {HTMLVideoElement} video
   * @param {number} [tMs] current time (performance.now() domain)
   * @returns {import('../core/types.js').PoseFrame|null} players in detection order; null if no new frame
   */
  detect(video, tMs = nowMs()) {
    this._worked = false;
    if (!this._landmarker || this._closed || this._switching || !video) return null;
    this._watch(video, tMs);
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const frameT = this._takeNewFrame(video, tMs);
    if (frameT === null) return null;
    const ts = Math.max(Math.round(frameT), this._lastTs + 1);
    this._lastTs = ts;
    this._worked = true;
    const t0 = nowMs();
    let result;
    const quiet = this._quietFrames > 0;
    if (quiet) { this._quietFrames--; quietStart(); }
    try {
      result = this._landmarker.detectForVideo(video, ts);
    } catch (e) {
      this._onDetectError(e);
      return null;
    } finally {
      if (quiet) quietEnd();
    }
    const t1 = nowMs();
    this._consecutiveErrors = 0;
    this._recordStats(t1 - t0, t1);
    this._checkSlowGpu();
    const players = [];
    const lms = result && result.landmarks ? result.landmarks : [];
    const aspect = video.videoWidth / video.videoHeight;
    for (let i = 0; i < lms.length; i++) players.push(toPlayerPose(lms[i], result.worldLandmarks && result.worldLandmarks[i], aspect));
    const ref = this._frameRef;
    const timing = this._timing(video, t1);
    // main-thread detection: handed over, inferred and back in one call (no transfer)
    Object.assign(timing, { seenTime: ref ? ref.seenAt ?? ref.seenMs : null, sentTime: t0, startTime: t0, endTime: t1, arrivedTime: t1, pickedTime: t1 });
    this._meter.record({ capture: timing.captureTime, seen: timing.seenTime, sent: t0, start: t0, end: t1, arrived: t1, picked: t1, ms: t1 - t0 });
    return { t: ts, width: video.videoWidth, height: video.videoHeight, players, timing };
  }

  /**
   * Capture → pose-ready latency of the frame just detected (see TRACKER_DEFAULTS.nominalCaptureMs),
   * recorded into the rolling median. @returns {{latencyMs:number|null, source:string, captureTime:number|null, readyTime:number}}
   */
  _timing(video, readyMs) {
    return this._timingOf(this._frameRef, !!(video && video.srcObject), readyMs);
  }

  /** _timing for a frame reference taken earlier (`live`: a camera stream, not a clip). */
  _timingOf(ref, live, readyMs) {
    let capture = null, source = 'none';
    if (ref) {
      const m = ref.meta || {};
      const ok = (v) => Number.isFinite(v) && v <= readyMs + 5 && v >= readyMs - 1500;
      if (ok(m.captureTime)) { capture = m.captureTime; source = 'capture'; }
      else if (ok(m.receiveTime)) { capture = m.receiveTime; source = 'receive'; }
      else if (ok(m.presentationTime) || ok(m.expectedDisplayTime)) {
        capture = (ok(m.presentationTime) ? m.presentationTime : m.expectedDisplayTime) - (live ? this.tuning.nominalCaptureMs : 0);
        source = 'presentation';
      } else if (Number.isFinite(ref.seenMs)) {
        capture = ref.seenMs - (ref.frameMs || 33) / 2 - (live ? this.tuning.nominalCaptureMs : 0);
        source = ref.meta ? 'callback' : 'poll';
      }
    }
    const latencyMs = capture === null ? null : Math.max(0, readyMs - capture);
    if (latencyMs !== null && latencyMs < 1500) {
      this._latencies.push(latencyMs);
      if (this._latencies.length > this.tuning.latencyWindow) this._latencies.shift();
      this._latencySource = source;
    }
    return { latencyMs: latencyMs === null ? null : Math.round(latencyMs * 10) / 10, source, captureTime: capture, readyTime: readyMs };
  }

  /** Rolling median capture → pose-ready latency (ms), or null before the first frame. */
  get latencyMs() {
    const n = this._latencies.length;
    if (!n) return null;
    const s = [...this._latencies].sort((a, b) => a - b);
    return s[Math.floor((n - 1) / 2)];
  }

  /** Attach requestVideoFrameCallback to `video` (once per element). */
  _watch(video, tMs) {
    if (this._video === video) return;
    this._unwatch();
    this._video = video;
    this._rvfcPending = false;
    this._rvfcLastWall = -Infinity;
    this._watchStart = tMs;
    this._lastCurrentTime = -1;
    this._rvfcSupported = typeof video.requestVideoFrameCallback === 'function';
    if (!this._rvfcSupported) return;
    const onFrame = (wallNow, meta) => {
      if (this._video !== video || this._closed) return;
      this._rvfcPending = true;
      this._rvfcMeta = meta;
      this._rvfcLastWall = wallNow;
      this._rvfcLastCb = nowMs();
      this._meter.frameSeen(this._rvfcLastCb);
      this._rvfcHandle = video.requestVideoFrameCallback(onFrame);
      if (this._onVideoFrame) {
        try { this._onVideoFrame(video, wallNow, meta); } catch (e) { console.error('[input] video frame hook failed', e); }
      }
    };
    this._rvfcHandle = video.requestVideoFrameCallback(onFrame);
  }

  _unwatch() {
    const v = this._video;
    if (v && this._rvfcHandle && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(this._rvfcHandle); } catch { /* ignore */ }
    }
    this._video = null;
    this._rvfcHandle = 0;
  }

  /** The video got a new source (camera reopened): attach a fresh frame callback on the next detect(). */
  rewatch() {
    this._unwatch();
    this._lastCurrentTime = -1;
  }

  /**
   * Decide whether there is an unprocessed frame; returns its timestamp or null.
   * rVFC is authoritative while it keeps firing; otherwise poll currentTime at ≤ pollFps.
   */
  _takeNewFrame(video, tMs) {
    const stall = this.tuning.rvfcStallMs;
    // rVFC decides while it keeps firing — and right after attaching, until it had a fair chance
    // to fire (hidden/detached videos may never get callbacks: then fall back to polling).
    const rvfcAlive = this._rvfcSupported && (tMs - this._rvfcLastWall < stall
      || (this._rvfcLastWall === -Infinity && tMs - this._watchStart < stall));
    if (rvfcAlive) {
      if (!this._rvfcPending) return null;
      this._rvfcPending = false;
      this._lastCurrentTime = video.currentTime;
      const frameMs = Number.isFinite(this._lastDetectWall) ? Math.min(100, Math.max(8, tMs - this._lastDetectWall)) : 33;
      this._lastDetectWall = tMs;
      const m = this._rvfcMeta || {};
      this._frameRef = { meta: m, seenMs: this._rvfcLastWall, seenAt: Number.isFinite(this._rvfcLastCb) ? this._rvfcLastCb : this._rvfcLastWall, frameMs };
      const metaT = Number.isFinite(m.captureTime) ? m.captureTime
        : Number.isFinite(m.presentationTime) ? m.presentationTime : NaN;
      // Use the camera's own frame time when it is sane: steadier velocities than rAF time.
      return (Number.isFinite(metaT) && metaT <= tMs + 50 && metaT >= tMs - 300) ? metaT : tMs;
    }
    // A changed currentTime means a new frame: playback, or a seek while paused (frame stepping).
    const ct = video.currentTime;
    if (ct === this._lastCurrentTime) return null;
    if (tMs - this._lastDetectWall < 1000 / this._pollFps - 4) return null;
    const frameMs = Number.isFinite(this._lastDetectWall) ? Math.min(100, Math.max(8, tMs - this._lastDetectWall)) : 33;
    this._lastCurrentTime = ct;
    this._lastDetectWall = tMs;
    this._rvfcPending = false;
    this._frameRef = { meta: null, seenMs: tMs, seenAt: tMs, frameMs };
    this._meter.frameSeen(tMs);
    return tMs;
  }

  _recordStats(ms, at) {
    const a = this.tuning.statsAlpha;
    this._detectMsEma = this.frames === 0 ? ms : this._detectMsEma + a * (ms - this._detectMsEma);
    this.frames++;
    this._durations.push(ms);
    if (this._durations.length > 90) this._durations.shift();
    this._detectTimes.push(at);
    const cutoff = at - this.tuning.fpsWindowMs;
    while (this._detectTimes.length && this._detectTimes[0] < cutoff) this._detectTimes.shift();
  }

  /**
   * A GPU that works but crawls (software GL, blocklisted driver) is worse than the CPU path. Decided once,
   * on the median detect time of the first `slowGpuFrames` GPU frames; where _slowGpuRecheckMs() is above 0
   * (the detection worker) a slow first window — unless it is above slowGpuSevereMs — is measured again that
   * much later and only a second slow window switches (RV-PERF-02). A fast first window ends the check.
   * @param {number} [at]  now (performance.now() domain)
   */
  _checkSlowGpu(at = nowMs()) {
    const T = this.tuning;
    if (this.delegate !== 'GPU' || this._switching || this._gpuChecked) return;
    if (this._gpuSlow && at < this._gpuSlow.recheckAt) return; // between the two windows
    if (this._gpuFrames === undefined) this._gpuFrames = [];
    this._gpuFrames.push(this._durations[this._durations.length - 1]);
    if (this._gpuFrames.length < T.slowGpuFrames) return;
    const sorted = [...this._gpuFrames].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this._gpuFrames = [];
    if (median <= T.slowGpuMs) { this._gpuChecked = true; this._gpuSlow = null; return; }
    const wait = this._slowGpuRecheckMs();
    if (wait > 0 && !this._gpuSlow && !(median > T.slowGpuSevereMs)) { this._gpuSlow = { recheckAt: at + wait }; return; }
    this._gpuChecked = true;
    this._gpuSlow = null;
    const reason = `GPU too slow (${Math.round(median)} ms per frame) — using CPU`;
    // PERF-06: with a switch gate (the input hub: safe moments) the move is left to the gate's owner, which builds the
    // CPU landmarker next to the running one and swaps between rounds (a trial: kept only if the CPU is faster)
    if (typeof this.switchGate === 'function') { this.slowGpu = { median: Math.round(median), reason }; return; }
    this.fallbackReason = reason;
    this._switching = this._switchToCpu().finally(() => { this._switching = null; });
  }

  /** How long a slow first GPU window waits for a second look (0: decide at once; main-thread detection). */
  _slowGpuRecheckMs() { return 0; }

  _onDetectError(e) {
    this._consecutiveErrors++;
    if (this.delegate === 'GPU' && !this._switching) {
      // GPU pipelines that pass init can still die on real frames (context loss, driver bugs).
      this.fallbackReason = `GPU failed while tracking (${shortErr(e)})`;
      this._switching = this._switchToCpu().finally(() => { this._switching = null; });
      return;
    }
    if (this._consecutiveErrors >= this.tuning.maxConsecutiveErrors) {
      this.error = new TrackerError('detect-failed', `Pose tracking stopped working (${shortErr(e)}).`,
        'Reload the page. If it keeps happening, pick the lite model in Settings, or use the keyboard.', e);
    }
  }

  async _switchToCpu() {
    const old = this._landmarker;
    this._landmarker = null;
    closeQuietly(old);
    quietStart();
    try {
      const fileset = await this._resolveFileset();
      const buffer = await this._loadModel();
      const lm = await this._vision.PoseLandmarker.createFromOptions(fileset, this._options('CPU', buffer));
      if (this._closed) { closeQuietly(lm); return; }
      this._landmarker = lm;
      this.delegate = 'CPU';
      this._consecutiveErrors = 0;
      this._resetTimings();
      this.frames = 0;
      this._quietFrames = 90;
    } catch (e) {
      this.error = new TrackerError('init-failed', `Pose tracking could not restart on the CPU (${shortErr(e)}).`, 'Reload the page, or choose Use keyboard instead.', e);
    } finally {
      quietEnd();
    }
  }

  /**
   * Run on the other delegate (PERF-06: the input hub's delegate governor). The new landmarker is created first; if it
   * can't start, the old one keeps detecting and this throws. Detection pauses while the new graph starts.
   * @param {'GPU'|'CPU'} d
   */
  async setDelegate(d) {
    const want = d === 'GPU' ? 'GPU' : 'CPU';
    if (want === this.delegate || !this._landmarker || this._switching) return this.info();
    const run = (async () => {
      quietStart();
      try {
        const fileset = await this._resolveFileset();
        const buffer = await this._loadModel();
        const lm = await this._vision.PoseLandmarker.createFromOptions(fileset, this._options(want, buffer));
        if (this._closed) { closeQuietly(lm); return; }
        const old = this._landmarker;
        this._landmarker = lm;
        closeQuietly(old);
        this.delegate = want;
        this._consecutiveErrors = 0;
        this._resetTimings();
        this._quietFrames = 90;
      } finally {
        quietEnd();
      }
    })();
    this._switching = run.then(() => undefined, () => undefined).finally(() => { if (this._switching === pending) this._switching = null; });
    const pending = this._switching;
    try { await run; } catch (e) {
      throw new TrackerError('init-failed', `Pose tracking could not start on the ${want} (${shortErr(e)}).`, 'Keep playing, or reload the page.', e);
    }
    return this.info();
  }

  // ───────────────────────────── PERF-06: two-phase switch ─────────────────────────────
  // prepareSwitch() builds a landmarker for another model / delegate NEXT to the running one, which keeps detecting;
  // commitSwitch() makes it current (its warm-up inference is the only pause); with keep the old one stays, idle, for
  // revertSwitch() (a delegate trial: going back costs no build and no warm-up); discardSwitch() drops either. The input
  // hub drives this so that the pause falls at a safe moment (between rounds, paused, menus).

  /** Can a switch be prepared while this tracker keeps detecting? */
  get canPrepare() { return !!this._landmarker && !this._closed && !this._switching; }

  /**
   * @param {{model?:'full'|'lite', delegate?:'GPU'|'CPU'}} to
   * @returns {Promise<{delegate:string, model:string, buildMs:number}>}  throws TrackerError (code 'model-missing' when the
   *          model file is missing: retrying will not help)
   */
  async prepareSwitch(to = {}) {
    const m = to.model === 'lite' || to.model === 'full' ? to.model : this.model;
    const d = to.delegate === 'GPU' || to.delegate === 'CPU' ? to.delegate : (this.delegate || this.requestedDelegate);
    const gen = ++this._prepGen;
    this._dropPrepared();
    const t0 = nowMs();
    let lm = null;
    quietStart();
    try {
      const fileset = await this._resolveFileset();
      const buffer = await this._loadModel(m);
      lm = await this._vision.PoseLandmarker.createFromOptions(fileset, this._options(d, buffer));
    } catch (e) {
      closeQuietly(lm);
      throw e instanceof TrackerError ? e : new TrackerError('init-failed', `Pose tracking could not start ${m !== this.model ? `the ${m} model` : `on the ${d}`} (${shortErr(e)}).`, 'Keep playing, or reload the page.', e);
    } finally {
      quietEnd();
    }
    if (gen !== this._prepGen || this._closed) { closeQuietly(lm); throw new TrackerError('init-failed', 'The prepared pose model was superseded.'); }
    this._prepared = { lm, model: m, delegate: d, numPoses: this.numPoses };
    return { delegate: d, model: m, buildMs: nowMs() - t0 };
  }

  /**
   * Make the prepared landmarker current. keep: the old one stays for revertSwitch(); reason: fallbackReason when this
   * moves detection to the CPU. @returns {Promise<object>} info() + warmMs
   */
  async commitSwitch({ keep = false, reason = null } = {}) {
    const p = this._prepared;
    if (!p) throw new TrackerError('init-failed', 'No pose landmarker was prepared.');
    this._prepared = null;
    const t0 = nowMs();
    quietStart();
    try {
      if (p.numPoses !== this.numPoses && typeof p.lm.setOptions === 'function') await p.lm.setOptions({ numPoses: this.numPoses });
      if (this.tuning.warmup) this._warmup(p.lm);
    } catch (e) {
      closeQuietly(p.lm);
      throw new TrackerError('init-failed', `Pose tracking could not start ${p.model !== this.model ? `the ${p.model} model` : `on the ${p.delegate}`} (${shortErr(e)}).`, 'Keep playing, or reload the page.', e);
    } finally {
      quietEnd();
    }
    const old = { lm: this._landmarker, model: this.model, delegate: this.delegate, numPoses: this.numPoses, reason: this.fallbackReason };
    this._landmarker = p.lm;
    this._dropKept();
    if (keep) this._kept = old; else closeQuietly(old.lm);
    this._adoptInfo(p.model, p.delegate, reason);
    return { ...this.info(), warmMs: nowMs() - t0 };
  }

  /** Back to the landmarker the last commitSwitch({keep: true}) kept. */
  async revertSwitch() {
    const k = this._kept;
    if (!k) throw new TrackerError('init-failed', 'No pose landmarker to go back to.');
    this._kept = null;
    if (k.numPoses !== this.numPoses && typeof k.lm.setOptions === 'function') await k.lm.setOptions({ numPoses: this.numPoses });
    const cur = this._landmarker;
    this._landmarker = k.lm;
    closeQuietly(cur);
    this._adoptInfo(k.model, k.delegate, k.reason);
    return this.info();
  }

  /** Drop the prepared (and / or the kept) landmarker; a prepare still building is dropped when it finishes. */
  async discardSwitch({ prepared = true, kept = true } = {}) {
    if (prepared) { this._prepGen++; this._dropPrepared(); }
    if (kept) this._dropKept();
  }

  /** The running landmarker changed (two-phase switch): stats start over; fallbackReason follows the delegate. */
  _adoptInfo(model, delegate, reason) {
    this.model = model === 'lite' ? 'lite' : 'full';
    this.delegate = delegate === 'CPU' ? 'CPU' : 'GPU';
    this._modelBuffer = null;
    this._consecutiveErrors = 0;
    this._resetTimings();
    this._quietFrames = 90;
    if (this.delegate === 'GPU') this.fallbackReason = null;
    else if (reason || (this.slowGpu && this.slowGpu.reason)) this.fallbackReason = reason || this.slowGpu.reason;
    this.slowGpu = null;
  }

  _dropPrepared() {
    const p = this._prepared;
    this._prepared = null;
    if (p && p.lm) closeQuietly(p.lm);
  }

  _dropKept() {
    const k = this._kept;
    this._kept = null;
    if (k && k.lm) closeQuietly(k.lm);
  }

  /** @returns {{delegate:string|null, model:string, numPoses:number, detectMs:number, detectMsP95:number, fps:number, frames:number, fallbackReason:string|null, initMs:number, latencyMs:number|null, latencySource:string|null, detector:string, pipeline:object}} */
  getStats() {
    const d = [...this._durations].sort((x, y) => x - y);
    const p95 = d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.95))] : 0;
    let fps = 0;
    const n = this._detectTimes.length;
    if (n >= 2) {
      const span = this._detectTimes[n - 1] - this._detectTimes[0];
      fps = span > 0 ? ((n - 1) * 1000) / span : 0;
    }
    return {
      delegate: this.delegate, model: this.model, numPoses: this.numPoses,
      detectMs: this._detectMsEma, detectMsP95: p95, fps, frames: this.frames,
      fallbackReason: this.fallbackReason, initMs: this.initMs,
      latencyMs: this.latencyMs, latencySource: this._latencySource,
      detector: this.kind,
      pipeline: this._meter.stats(nowMs()),
    };
  }

  close() {
    this._closed = true;
    this._unwatch();
    this._prepGen++;
    this._dropPrepared();
    this._dropKept();
    const lm = this._landmarker;
    this._landmarker = null;
    closeQuietly(lm);
  }
}

/**
 * Why the GPU delegate would be a bad idea here, or null if WebGL2 looks hardware-accelerated:
 * 'WebGL2 unavailable' (blocked/disabled) or 'software WebGL (SwiftShader|llvmpipe|…)'.
 * Uses a throwaway WebGL2 context which is released immediately.
 */
export function gpuProblem() {
  if (typeof document === 'undefined') return null;
  let gl = null;
  try {
    const c = document.createElement('canvas');
    gl = c.getContext('webgl2');
    if (!gl) return 'WebGL2 unavailable';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    const m = name.match(/swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i);
    return m ? `software WebGL (${/swiftshader/i.test(name) ? 'SwiftShader' : m[0]})` : null;
  } catch {
    return null;
  } finally {
    try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
  }
}

/** True if a zip local-file header ("PK\3\4") appears in the first 64 bytes. */
export function hasZipHeader(buf) {
  const n = Math.min(buf.length - 3, 64);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) return true;
  }
  return false;
}

function closeQuietly(lm) {
  if (!lm) return;
  quietStart();
  try { lm.close(); } catch { /* already closed */ } finally { quietEnd(); }
}

/** numPoses as MediaPipe accepts it here: 1..3. */
export function clampPoses(n) {
  const v = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(3, v));
}

/** One-line error text, at most 140 characters. */
export function shortErr(e) {
  const s = errText(e).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}
