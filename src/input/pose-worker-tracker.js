// WorkerPoseTracker — PoseTracker with the MediaPipe Pose Landmarker in a dedicated worker
// (PERF-01: detection off the render frame). Same interface as PoseTracker (pose-tracker.js), so
// InputHub uses either.
//
//  * init(): the main thread only fetches + validates the model (readable model-missing errors),
//    then starts pose-worker.js, which loads the wasm runtime, creates the landmarker (GPU through
//    OffscreenCanvas when it works, CPU otherwise) and runs the warm-up inference — none of it on
//    the main thread (PERF-05).
//  * Frames: each new camera frame (requestVideoFrameCallback, or currentTime polling from
//    detect() when the callback doesn't fire) is grabbed as a VideoFrame (else an ImageBitmap) and
//    transferred to the worker together with its capture metadata. One frame is in flight at a
//    time; newer camera frames are skipped while the worker is busy (the freshest one goes next).
//  * detect(video, t) never waits: it returns the oldest finished result not handed out yet (null
//    otherwise) and takeFrames(t) the rest, in order (PERF-06: every detected frame reaches the game with
//    its own capture timestamp — two results between two game frames, which a 60 fps camera makes common,
//    are both delivered; at most `maxQueuedResults` wait, older ones are dropped after a page stall).
//    PoseFrame.timing.latencyMs = capture → result handed to the game (worker time included); timing
//    also carries the per-stage times (seenTime, sentTime, startTime, endTime, arrivedTime, pickedTime).
//  * setModel(m) swaps full ↔ lite inside the running worker (the new landmarker is built and warmed up
//    before the old one is closed; no worker restart, no wasm reload; no frame is sent meanwhile).
//  * Two-phase switch (PERF-06, used by the input hub's governor) — a worker swap: prepareSwitch({model?, delegate?})
//    starts a SECOND worker with that model / delegate (wasm, graph build, warm-up — even its synchronous parts run on
//    that worker's own thread) and primes it with one real camera frame (its shaders compile there), while the running
//    worker keeps detecting every frame; commitSwitch({keep}) sends the next frames to the new worker — no pause (the
//    frame in flight still answers through the old one); keep: the old worker stays loaded for revertSwitch(), which
//    goes back at once; discardSwitch() stops the prepared / kept worker.
//  * Fallback to main-thread detection (`kind` stays 'worker' only while the worker runs): when
//    Worker / OffscreenCanvas / VideoFrame+createImageBitmap are missing, when the worker fails to
//    start (or times out), or when it crashes / stops answering while tracking. GPU→CPU switches
//    (broken or slow GPU) happen inside the worker, as in PoseTracker.
//
// No DOM access at import time: safe to import in Node, where it always falls back. (Importing it imports
// pose-tracker.js, which wraps the global fetch with the telemetry guard, R5.)

import { PoseTracker, TrackerError, poseScore, clampPoses, shortErr, nowMs } from './pose-tracker.js';
import { unpackPoses } from './pose-worker-codec.js';

/** Can this browser run detection in a worker (worker + OffscreenCanvas + a transferable frame type)? */
export function workerDetectionSupported() {
  return typeof Worker === 'function' && typeof OffscreenCanvas === 'function'
    && (typeof VideoFrame === 'function' || typeof createImageBitmap === 'function');
}

/** The default worker: pose-worker.js (Vite bundles it; the literal URL pattern matters). */
function spawnPoseWorker() {
  return new Worker(new URL('./pose-worker.js', import.meta.url), { type: 'module' });
}

/** A worker's performance.timeOrigin minus the page's (worker clock → page clock), from its init answer. */
function clockOffsetOf(info) {
  const origin = typeof performance !== 'undefined' ? performance.timeOrigin : NaN;
  return info && Number.isFinite(info.timeOrigin) && Number.isFinite(origin) ? info.timeOrigin - origin : null;
}

const absUrl = (u) => {
  try { return new URL(u, (typeof location !== 'undefined' && location.href) || 'http://localhost/').href; } catch { return u; }
};

export class WorkerPoseTracker extends PoseTracker {
  /**
   * @param {object} [opts]  PoseTracker options, plus (tests) `workerFactory: () => Worker-like`
   *                         and `forceWorker: true` (skip the feature check).
   */
  constructor(opts = {}) {
    super(opts);
    this.kind = 'worker';
    /** Why detection runs on the main thread after all (null while the worker runs). */
    this.workerFallbackReason = null;
    this._workerFactory = typeof opts.workerFactory === 'function' ? opts.workerFactory : spawnPoseWorker;
    this._forceWorker = !!opts.forceWorker;
    this._fallback = false;
    this._worker = null;
    /** The worker detecting now as a slot {w, offset}; prepareSwitch adds a second one (PERF-06 worker swap). */
    this._slot = null;
    this._preparing = null;
    this._wready = false;
    this._reqId = 0;
    this._pending = new Map();
    this._seq = 0;
    this._busy = false;
    this._inflight = null;
    /** Finished results not handed to the game yet, oldest first (PERF-06). */
    this._results = [];
    /** Results dropped because the game did not pick them up in time (a page stall). */
    this.droppedResults = 0;
    /** The worker's performance.timeOrigin minus the page's: worker clock → page clock (PERF-06 timings). */
    this._clockOffset = null;
    /** Grab frames as VideoFrames (zero-copy) until that fails once; ImageBitmaps otherwise. */
    this._videoFrames = true;
    this._grabFailures = 0;
    /** nowMs() of the previous detect() call (the page-stall check of the watchdog, RV-PERF-01). */
    this._lastDetectCall = -Infinity;
    this.workerInfo = null;
    // a new camera frame: send it right away when the worker is idle (lowest latency)
    this._onVideoFrame = (video, wallNow) => {
      if (!this._fallback && !this._busy) this._send(video, wallNow);
    };
  }

  get ready() { return this._fallback ? super.ready : (this._wready && !this._closed); }

  /** 'worker' while the worker detects, 'main' after a fallback. */
  get detector() { return this._fallback ? 'main' : 'worker'; }

  async _doInit() {
    if (this._fallback) return super._doInit();
    if (!this._forceWorker && !workerDetectionSupported()) {
      this._toMainThread('this browser cannot detect in a worker');
      return super._doInit();
    }
    const t0 = nowMs();
    const buffer = await this._loadModel(); // readable model-missing errors come from here
    if (this._closed) throw new TrackerError('init-failed', 'Pose tracking was stopped while starting.');
    let info;
    try {
      info = await this._startWorker(buffer);
    } catch (e) {
      this._terminate();
      if (this._closed) throw new TrackerError('init-failed', 'Pose tracking was stopped while starting.');
      this._toMainThread(`the detection worker did not start (${shortErr(e)})`);
      console.warn(`[input] pose detection runs on the main thread: ${this.workerFallbackReason}`);
      return super._doInit();
    }
    if (this._closed) { this._terminate(); throw new TrackerError('init-failed', 'Pose tracking was stopped while starting.'); }
    this.workerInfo = info;
    this._clockOffset = clockOffsetOf(info);
    if (this._slot) this._slot.offset = this._clockOffset;
    this.delegate = info.delegate === 'CPU' ? 'CPU' : 'GPU';
    this.fallbackReason = info.fallbackReason || null;
    this.error = null;
    this.initMs = nowMs() - t0;
    this._wready = true;
    return this.info();
  }

  _startWorker(buffer) {
    const slot = this._spawn();
    this._slot = slot;
    this._worker = slot.w;
    // the model buffer is transferred (not copied); the main thread re-fetches it if it ever needs it
    this._modelBuffer = null;
    return this._request(this._initMessage(buffer, this.requestedDelegate), [buffer.buffer], this.tuning.workerInitTimeoutMs);
  }

  /** A new worker as a slot {w, offset}: its messages carry the slot (its own clock); its failures go to the slot's role. */
  _spawn() {
    const w = this._workerFactory();
    const slot = { w, offset: null, priming: null, retire: false };
    w.onmessage = (e) => this._onMessage(e && e.data, slot);
    const failed = (err) => {
      if (slot === this._slot) this._onWorkerFailure(err);
      else this._dropSlot(slot); // a prepared / kept worker: only it goes (a prepare in progress fails by its timeout or reply)
    };
    w.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      failed(new Error((e && e.message) || 'the detection worker failed'));
    };
    w.onmessageerror = () => failed(new Error('a message from the detection worker could not be read'));
    return slot;
  }

  _initMessage(buffer, delegate) {
    const t = this.tuning;
    return {
      type: 'init',
      wasmUrl: absUrl(this.wasmUrl),
      model: buffer.buffer,
      delegate,
      avoidSoftwareGL: !!t.avoidSoftwareGL,
      warmup: !!t.warmup,
      options: {
        numPoses: this.numPoses,
        minPoseDetectionConfidence: t.minPoseDetectionConfidence,
        minPosePresenceConfidence: t.minPosePresenceConfidence,
        minTrackingConfidence: t.minTrackingConfidence,
      },
    };
  }

  /** Request/answer with a timeout (to the detecting worker, or `w`). @returns {Promise<any>} */
  _request(msg, transfer = [], timeoutMs = this.tuning.workerRequestTimeoutMs, w = this._worker) {
    if (!w) return Promise.reject(new Error('no detection worker'));
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`the detection worker did not answer (${msg.type}, ${Math.round(timeoutMs / 1000)} s)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, w });
      try {
        w.postMessage({ ...msg, id }, transfer);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  _onMessage(m, slot = this._slot) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reply') {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'detection worker error'));
      return;
    }
    if (m.type === 'result' || m.type === 'detect-error') {
      if (slot && slot.priming && slot.priming.seq === m.seq) { slot.priming.done(); return; } // a prepared worker's priming frame
      const fl = this._inflight;
      if (!fl || fl.seq !== m.seq) return; // a frame from before a reset
      this._inflight = null;
      this._busy = false;
      // the frame in flight at a worker swap answers through the old worker, which goes now
      if (slot && slot.retire && slot !== this._slot) this._dropSlot(slot);
      if (m.type === 'result') {
        const off = slot && slot.offset !== null && slot.offset !== undefined ? slot.offset : this._clockOffset;
        const page = (t) => (off !== null && Number.isFinite(t) ? t + off : null);
        this._results.push({ ...fl, ms: m.ms, n: m.n, data: m.data, readyAt: nowMs(), rxAt: page(m.rx), startAt: page(m.t0), endAt: page(m.t1) });
        const max = Math.max(1, this.tuning.maxQueuedResults | 0);
        if (this._results.length > max) this.droppedResults += this._results.splice(0, this._results.length - max).length;
      } else {
        this._onDetectError(new Error(m.message || 'detection failed'));
      }
      // a camera frame arrived while the worker was busy: send the newest one now (timed like its callback)
      if (this._rvfcPending && this._video && !this._closed) {
        this._send(this._video, Number.isFinite(this._rvfcLastWall) ? this._rvfcLastWall : nowMs());
      }
    }
  }

  /**
   * Grab the video's current frame and hand it to the worker (if it shows a frame we haven't sent).
   * @returns {boolean} a frame was sent
   */
  _send(video, tMs) {
    if (this._busy || !this._wready || this._closed || this._switching || !this._worker || !video) return false;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    const frameT = this._takeNewFrame(video, tMs);
    if (frameT === null) return false;
    const ts = Math.max(Math.round(frameT), this._lastTs + 1);
    this._lastTs = ts;
    const seq = ++this._seq;
    const fl = { seq, ts, ref: this._frameRef, w: video.videoWidth, h: video.videoHeight, live: !!video.srcObject, sentAt: nowMs(), slot: this._slot };
    let image = null;
    if (this._videoFrames && typeof VideoFrame === 'function') {
      try { image = new VideoFrame(video, { timestamp: Math.round(ts * 1000) }); } catch {
        image = null;
        // this browser can't wrap this video in a VideoFrame: use ImageBitmaps from now on
        if (typeof createImageBitmap === 'function') this._videoFrames = false; else this._grabFailed();
      }
    }
    if (image) {
      this._busy = true;
      this._inflight = fl;
      try {
        this._worker.postMessage({ type: 'frame', seq, ts, image }, [image]);
      } catch (e) {
        try { image.close(); } catch { /* ignore */ }
        this._busy = false;
        this._inflight = null;
        this._grabFailed();
        return false;
      }
      this._grabFailures = 0;
      return true;
    }
    if (typeof createImageBitmap !== 'function') return false;
    this._busy = true;
    this._inflight = fl;
    createImageBitmap(video).then((bmp) => {
      if (this._inflight !== fl || !this._worker) { try { bmp.close(); } catch { /* ignore */ } return; }
      try { this._worker.postMessage({ type: 'frame', seq, ts, image: bmp }, [bmp]); this._grabFailures = 0; } catch {
        try { bmp.close(); } catch { /* ignore */ }
        if (this._inflight === fl) { this._inflight = null; this._busy = false; }
        this._grabFailed();
      }
    }, () => {
      if (this._inflight === fl) { this._inflight = null; this._busy = false; }
      this._grabFailed();
    });
    return true;
  }

  /** Frames that can't be handed to the worker: after a few in a row, detect on the main thread instead. */
  _grabFailed() {
    this._grabFailures = (this._grabFailures || 0) + 1;
    if (this._grabFailures >= 10 && this._wready && !this._fallback && !this._closed) {
      this._onWorkerFailure(new Error('camera frames cannot be passed to the worker'));
    }
  }

  /**
   * Non-blocking: send a pending frame (polling path), then return the oldest finished result not handed out
   * yet (null if none). takeFrames(tMs) returns the others, in order (PERF-06: every frame reaches the game).
   * @returns {import('../core/types.js').PoseFrame|null}
   */
  detect(video, tMs = nowMs()) {
    if (this._fallback) return super.detect(video, tMs);
    this._worked = false;
    // The watchdog blames the worker only for time in which the page could have read its answer
    // (RV-PERF-01). A call this long after the previous one means the PAGE was stalled (after a long task
    // the browser runs the first rendering step before the worker's queued answer), so the gap is taken out
    // of the age of the frame in flight. Live time before and between stalls still counts: a dead worker is
    // caught after workerStallMs of live page time even while the page keeps stalling. A frame sent during
    // this very step is never older than now. Tracked before the early returns, so the cadence is always known.
    const now = nowMs();
    const gap = Number.isFinite(this._lastDetectCall) ? now - this._lastDetectCall : 0;
    this._lastDetectCall = now;
    if (!this._wready || this._closed || !video) return null;
    this._watch(video, tMs);
    if (!this._busy && !this._switching && this._send(video, tMs)) this._worked = true;
    const fl = this._inflight;
    if (fl && gap > this.tuning.workerPageStallMs) fl.sentAt = Math.min(now, fl.sentAt + gap);
    if (fl && nowMs() - fl.sentAt > this.tuning.workerStallMs) {
      this._onWorkerFailure(new Error(`no answer for ${Math.round((nowMs() - fl.sentAt) / 1000)} s`));
      return null;
    }
    const r = this._results.shift();
    if (!r) return null;
    this._worked = true;
    return this._frameOf(r, tMs);
  }

  /**
   * The finished results detect() did not return yet, oldest first (each with its own capture timestamp).
   * @param {number} [tMs]
   * @returns {import('../core/types.js').PoseFrame[]}
   */
  takeFrames(tMs = nowMs()) {
    if (this._fallback || !this._results.length) return [];
    const out = [];
    while (this._results.length) out.push(this._frameOf(this._results.shift(), tMs));
    return out;
  }

  /** A queued worker result as the PoseFrame handed to the game at tMs (stats, timing, pipeline meter). */
  _frameOf(r, tMs) {
    this._consecutiveErrors = 0;
    // the pose reaches the game now (tMs: the caller's clock, the capture times' domain)
    this._recordStats(r.ms, tMs);
    this._checkSlowGpu();
    const players = unpackPoses(r.data, r.n, r.h > 0 ? r.w / r.h : 0, poseScore);
    const timing = this._timingOf(r.ref, r.live, tMs);
    const seen = r.ref ? r.ref.seenAt ?? r.ref.seenMs : null;
    Object.assign(timing, { seenTime: seen, sentTime: r.sentAt, startTime: r.startAt, endTime: r.endAt, arrivedTime: r.readyAt, pickedTime: tMs });
    this._meter.record({ capture: timing.captureTime, seen, sent: r.sentAt, start: r.startAt, end: r.endAt, arrived: r.readyAt, picked: tMs, ms: r.ms });
    return { t: r.ts, width: r.w, height: r.h, players, timing };
  }

  async setNumPoses(n) {
    if (this._fallback || !this._worker) return super.setNumPoses(n);
    const v = clampPoses(n);
    if (v === this.numPoses) return;
    this.numPoses = v;
    this._meter.reset(); // the other pose budget detects at another speed (PERF-06 judges the new one)
    try {
      await this._request({ type: 'options', numPoses: v });
    } catch (e) {
      if (this._fallback || this._closed || !this._worker) return;
      this.error = new TrackerError('detect-failed', `Could not switch the number of tracked people (${shortErr(e)}).`, 'Reload the page, or choose Use keyboard instead.', e);
    }
  }

  /**
   * Switch between 'full' and 'lite'. A running worker builds the new landmarker next to the old one and swaps
   * (PERF-06: no worker restart; detection pauses only while the new graph starts, ≈ a numPoses switch). If the
   * new model can't start there, the old one keeps detecting and this throws; a worker that is not running
   * yet (or has failed) is simply restarted with the new model.
   */
  async setModel(model) {
    if (this._fallback) return super.setModel(model);
    const m = model === 'lite' ? 'lite' : 'full';
    if (m === this.model && this.ready) return this.info();
    if (!this._wready || !this._worker || this._closed) {
      this.model = m;
      this._modelBuffer = null;
      this._terminate();
      return this.init();
    }
    const prev = this.model;
    this.model = m;
    this._modelBuffer = null;
    const swap = (async () => {
      const buffer = await this._loadModel(); // readable model-missing errors come from here
      const ab = buffer.buffer;
      this._modelBuffer = null;
      await this._request({ type: 'model', model: ab }, [ab], this.tuning.workerInitTimeoutMs);
    })();
    // no frame is sent while the new graph starts (the watchdog never sees the gap as a dead worker)
    this._switching = swap.then(() => undefined, () => undefined).finally(() => { if (this._switching === pending) this._switching = null; });
    const pending = this._switching;
    try {
      await swap;
    } catch (e) {
      if (this._fallback || this._closed) return this.info();
      this.model = prev;
      this._modelBuffer = null;
      throw e instanceof TrackerError ? e : new TrackerError('init-failed', `The ${m} pose model could not start (${shortErr(e)}).`,
        'Keep playing with the current model, or reload the page.', e);
    }
    this._resetTimings();
    return this.info();
  }

  /**
   * The worker runs one scheduling class below the page: a busy start-up can starve one slow-GPU window
   * without the GPU being slow, so a slow first window is measured again before the switch (RV-PERF-02).
   */
  _slowGpuRecheckMs() { return this._fallback ? 0 : Math.max(0, Number(this.tuning.slowGpuRecheckMs) || 0); }

  async _switchToCpu() {
    if (this._fallback) return super._switchToCpu();
    let failed = null;
    try {
      await this._request({ type: 'switch', delegate: 'CPU' });
      if (this._fallback || this._closed) return;
      this.delegate = 'CPU';
      this._consecutiveErrors = 0;
      this._resetTimings();
      this.frames = 0;
    } catch (e) {
      failed = e;
    }
    // the worker could not start its CPU landmarker: main-thread detection decides again (its own GPU / CPU)
    if (failed && !this._fallback && !this._closed) {
      const restart = this._restartOnMainThread(`the detection worker could not switch to the CPU (${shortErr(failed)})`);
      if (restart) await restart;
    }
  }

  /**
   * Run the worker's landmarker on the other delegate (PERF-06: the input hub's delegate governor). The worker builds
   * the new landmarker before closing the old one; no frame is sent meanwhile; a failure keeps the old one and throws.
   * @param {'GPU'|'CPU'} d
   */
  async setDelegate(d) {
    if (this._fallback) return super.setDelegate(d);
    const want = d === 'GPU' ? 'GPU' : 'CPU';
    if (want === this.delegate || !this._wready || !this._worker || this._switching) return this.info();
    const run = this._request({ type: 'switch', delegate: want });
    this._switching = run.then(() => undefined, () => undefined).finally(() => { if (this._switching === pending) this._switching = null; });
    const pending = this._switching;
    try { await run; } catch (e) {
      if (this._fallback || this._closed) return this.info();
      throw new TrackerError('init-failed', `Pose tracking could not start on the ${want} (${shortErr(e)}).`, 'Keep playing, or reload the page.', e);
    }
    this.delegate = want;
    this._consecutiveErrors = 0;
    this._resetTimings();
    return this.info();
  }

  // ── PERF-06: two-phase switch (see PoseTracker) as a worker swap ──

  get canPrepare() {
    return this._fallback ? super.canPrepare : (this._wready && !!this._worker && !this._closed && !this._switching && !this._preparing);
  }

  /**
   * Start a second worker with the other model / delegate and prime it with one real camera frame; the running worker keeps
   * detecting every frame meanwhile (nothing of the new one runs on its thread). @param {{model?:string, delegate?:string}} to
   * @returns {Promise<{delegate:string, model:string, buildMs:number}>}  throws TrackerError ('model-missing' for a missing file)
   */
  async prepareSwitch(to = {}) {
    if (this._fallback) return super.prepareSwitch(to);
    if (!this._wready || !this._worker || this._closed) throw new TrackerError('init-failed', 'The detection worker is not running.');
    const m = to.model === 'lite' || to.model === 'full' ? to.model : this.model;
    const d = to.delegate === 'GPU' || to.delegate === 'CPU' ? to.delegate : this.delegate;
    const what = m !== this.model ? `the ${m} model` : `on the ${d}`;
    const gen = ++this._prepGen;
    this._dropPrepared();
    const t0 = nowMs();
    let buf = await this._loadModel(m); // readable model-missing errors come from here
    if (buf === this._modelBuffer) buf = buf.slice(); // the cached copy stays: the worker gets its own (transferred)
    if (gen !== this._prepGen || this._fallback || this._closed) throw new TrackerError('init-failed', 'The prepared pose model was superseded.');
    const slot = this._spawn();
    slot.model = m;
    slot.delegate = d;
    this._preparing = slot;
    try {
      const info = await this._request(this._initMessage(buf, d), [buf.buffer], this.tuning.workerInitTimeoutMs, slot.w);
      if (gen !== this._prepGen || this._fallback || this._closed || this._preparing !== slot) throw new Error('superseded');
      // a GPU that could not start there falls back to the CPU inside the new worker: that is not the switch asked for
      if ((info && info.delegate) !== d) throw new Error(`it started on the ${(info && info.delegate) || '?'} (${(info && info.fallbackReason) || 'no reason'})`);
      slot.offset = clockOffsetOf(info);
      slot.numPoses = this.numPoses;
      slot.info = info;
      await this._prime(slot);
      if (gen !== this._prepGen || this._fallback || this._closed || this._preparing !== slot) throw new Error('superseded');
    } catch (e) {
      if (this._preparing === slot) this._preparing = null;
      this._dropSlot(slot);
      if (e instanceof TrackerError) throw e;
      throw new TrackerError('init-failed', `Pose tracking could not start ${what} (${shortErr(e)}).`, 'Keep playing, or reload the page.', e);
    }
    this._preparing = null;
    this._prepared = slot;
    return { delegate: d, model: m, buildMs: nowMs() - t0 };
  }

  /**
   * One real camera frame through a prepared worker: its first full inference (person detector and landmarks — where a GPU
   * compiles its shaders) happens now, not on the first frame after the swap. Never rejects.
   */
  _prime(slot) {
    const video = this._video;
    if (!video || video.readyState < 2 || !video.videoWidth || typeof VideoFrame !== 'function') return Promise.resolve();
    const ts = ++this._lastTs;
    const seq = ++this._seq;
    let image;
    try { image = new VideoFrame(video, { timestamp: Math.round(ts * 1000) }); } catch { return Promise.resolve(); }
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); slot.priming = null; resolve(); };
      timer = setTimeout(done, this.tuning.workerRequestTimeoutMs);
      slot.priming = { seq, done };
      try { slot.w.postMessage({ type: 'frame', seq, ts, image }, [image]); } catch {
        try { image.close(); } catch { /* ignore */ }
        done();
      }
    });
  }

  /** The prepared worker detects from the next frame on (no pause). keep: the old one stays loaded for revertSwitch(). */
  async commitSwitch({ keep = false, reason = null } = {}) {
    if (this._fallback) return super.commitSwitch({ keep, reason });
    const p = this._prepared;
    if (!p || !p.w || !this._worker) throw new TrackerError('init-failed', 'No pose landmarker was prepared.');
    this._prepared = null;
    // the pose budget changed while it waited: the options go first (that worker handles its messages in order)
    if (p.numPoses !== this.numPoses) { this._request({ type: 'options', numPoses: this.numPoses }, [], undefined, p.w).catch(() => {}); p.numPoses = this.numPoses; }
    const old = this._slot;
    Object.assign(old, { model: this.model, delegate: this.delegate, reason: this.fallbackReason, numPoses: this.numPoses });
    this._activate(p);
    this._dropKept();
    if (keep) this._kept = old; else this._retire(old);
    if (p.info) this.workerInfo = p.info;
    this._adoptInfo(p.model, p.delegate, reason);
    return { ...this.info(), warmMs: 0 };
  }

  /** Back to the worker the last commitSwitch({keep: true}) kept: at once (it is loaded and warm). */
  async revertSwitch() {
    if (this._fallback) return super.revertSwitch();
    const k = this._kept;
    if (!k || !k.w || !this._worker) throw new TrackerError('init-failed', 'No pose landmarker to go back to.');
    this._kept = null;
    if (k.numPoses !== this.numPoses) { this._request({ type: 'options', numPoses: this.numPoses }, [], undefined, k.w).catch(() => {}); k.numPoses = this.numPoses; }
    const cur = this._slot;
    this._activate(k);
    this._retire(cur);
    this._adoptInfo(k.model, k.delegate, k.reason);
    return this.info();
  }

  async discardSwitch({ prepared = true, kept = true } = {}) {
    if (this._fallback) return super.discardSwitch({ prepared, kept });
    if (prepared) {
      this._prepGen++;
      this._dropPrepared();
      if (this._preparing) { this._dropSlot(this._preparing); this._preparing = null; }
    }
    if (kept) this._dropKept();
  }

  /** Frames go to this slot's worker from now on. */
  _activate(slot) {
    this._slot = slot;
    this._worker = slot.w;
    this._clockOffset = slot.offset;
    slot.retire = false;
  }

  /** A slot that stops detecting: stopped now, or — when the frame in flight went to it — once that frame answers. */
  _retire(slot) {
    if (!slot) return;
    if (this._inflight && this._inflight.slot === slot) {
      slot.retire = true;
      setTimeout(() => { if (slot.retire) this._dropSlot(slot); }, this.tuning.workerStallMs); // never kept for long
    } else this._dropSlot(slot);
  }

  /** Stop a worker that is not detecting (prepared, kept, retired, failed). */
  _dropSlot(slot) {
    if (!slot || !slot.w || slot === this._slot) return;
    const w = slot.w;
    slot.w = null;
    slot.retire = false;
    if (this._prepared === slot) this._prepared = null;
    if (this._kept === slot) this._kept = null;
    // its frame in flight will not answer now: the next frame goes to the detecting worker (no watchdog alarm)
    if (this._inflight && this._inflight.slot === slot) { this._inflight = null; this._busy = false; }
    for (const [id, p] of this._pending) {
      if (p.w === w) { clearTimeout(p.timer); this._pending.delete(id); p.reject(new Error('the detection worker was stopped')); }
    }
    try { w.onmessage = null; w.onerror = null; w.onmessageerror = null; } catch { /* ignore */ }
    try { w.terminate(); } catch { /* ignore */ }
  }

  _dropPrepared() { const p = this._prepared; this._prepared = null; if (p && p.w) this._dropSlot(p); else if (p && p.lm) super._dropPrepared(); }

  _dropKept() { const k = this._kept; this._kept = null; if (k && k.w) this._dropSlot(k); else if (k && k.lm) super._dropKept(); }

  /** The worker crashed or stopped answering: carry on with main-thread detection. */
  _onWorkerFailure(err) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
    if (!this._wready || this._fallback || this._closed) return; // init failures are handled by _doInit
    const restart = this._restartOnMainThread(`the detection worker failed (${shortErr(err)})`);
    if (restart) this._switching = restart.finally(() => { this._switching = null; });
  }

  /** Stop the worker and start main-thread detection. @returns {Promise<void>|null} */
  _restartOnMainThread(reason) {
    if (this._fallback || this._closed) return null;
    this._terminate();
    this._toMainThread(reason);
    console.warn(`[input] pose detection moved to the main thread: ${reason}`);
    this.delegate = null;
    this.fallbackReason = null;
    this._resetTimings();
    this.frames = 0;
    this._gpuChecked = false;
    this._gpuFrames = undefined;
    this._gpuSlow = null;
    return super._doInit()
      .then(() => undefined)
      .catch((e) => { this.error = e instanceof TrackerError ? e : new TrackerError('init-failed', `Pose tracking could not restart (${shortErr(e)}).`, 'Reload the page, or choose Use keyboard instead.', e); });
  }

  _toMainThread(reason) {
    this._fallback = true;
    this.workerFallbackReason = reason;
  }

  _terminate() {
    const w = this._worker;
    // a prepared, kept or preparing worker goes with it (PERF-06 worker swap)
    this._prepGen++;
    for (const sl of [this._prepared, this._kept, this._preparing]) {
      if (sl && sl.w && sl.w !== w) { try { sl.w.terminate(); } catch { /* ignore */ } sl.w = null; }
    }
    this._prepared = null;
    this._kept = null;
    this._preparing = null;
    this._slot = null;
    this._worker = null;
    this._wready = false;
    this._busy = false;
    this._inflight = null;
    this._results = [];
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('the detection worker was stopped')); }
    this._pending.clear();
    if (w) {
      try { w.onmessage = null; w.onerror = null; w.onmessageerror = null; } catch { /* ignore */ }
      try { w.terminate(); } catch { /* ignore */ }
    }
  }

  getStats() {
    return { ...super.getStats(), detector: this.detector, workerFallbackReason: this.workerFallbackReason };
  }

  close() {
    this._terminate();
    super.close();
  }
}
