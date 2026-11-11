// PERF-01 / PERF-05 / D9 regression: detection off the render frame.
//  * WorkerPoseTracker (with an in-process fake worker speaking pose-worker.js's protocol): init and
//    warm-up happen in the worker, detect() never waits and returns each finished result once, one
//    frame in flight, frames sent from the video-frame callback with their capture time (latency),
//    numPoses / GPU→CPU go to the worker, and every failure falls back to main-thread detection.
//  * InputHub.lastDetectMs: the main-thread ms the last update() spent on detection (0 if none).
import { test, assert, approx } from '../harness.mjs';
import { InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { InputHub } from '../../src/input/input-hub.js';
import { PoseTracker, toPlayerPose, TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';
import { WorkerPoseTracker, workerDetectionSupported } from '../../src/input/pose-worker-tracker.js';
import { packResult, unpackPoses, PACKED_POSE, keepModuleFactory } from '../../src/input/pose-worker-codec.js';
import { poseScore } from '../../src/input/pose-tracker.js';

const lm33 = (x = 0.5, vis = 0.9) => Array.from({ length: 33 }, (_, i) => ({ x: x + i * 0.001, y: 0.5 + i * 0.002, z: -0.1 * i, visibility: vis, presence: 0.8 }));
const zipModel = () => { const b = new Uint8Array(200_000); b.set([0, 0, 0x50, 0x4b, 3, 4], 0); return b; };
function stubFetch(map) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = map(String(url));
    return { ok: r.status === 200, status: r.status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (r.type || '') : null) }, arrayBuffer: async () => (r.body || new Uint8Array(0)).buffer };
  };
  return () => { globalThis.fetch = orig; };
}
const modelOk = () => stubFetch(() => ({ status: 200, type: 'application/octet-stream', body: zipModel() }));

/** VideoFrame stand-in (Node has none). */
function withVideoFrame(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  const made = [];
  globalThis.VideoFrame = class { constructor(src, init) { this.src = src; this.timestamp = init && init.timestamp; this.closed = false; made.push(this); } close() { this.closed = true; } };
  return Promise.resolve().then(() => fn(made)).finally(() => { if (had) Object.defineProperty(globalThis, 'VideoFrame', had); else delete globalThis.VideoFrame; });
}

function videoWithRvfc({ w = 640, h = 480 } = {}) {
  const v = { readyState: 4, videoWidth: w, videoHeight: h, currentTime: 0, srcObject: {}, cb: null };
  v.requestVideoFrameCallback = (cb) => { v.cb = cb; return 7; };
  v.cancelVideoFrameCallback = () => {};
  v.present = (wall, meta = {}) => { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; cb(wall, { presentationTime: wall - 5, ...meta }); };
  return v;
}

/**
 * Fake worker: answers init/options/switch/close at once (or fails init), queues frames until
 * flush() (one result per frame, `people` poses each), records everything it received.
 */
function fakeWorker({ initError = null, delegate = 'GPU', people = 1, detectThrows = false } = {}) {
  const w = {
    received: [], frames: [], terminated: false, onmessage: null, onerror: null,
    postMessage(m, transfer) {
      w.received.push({ m, transfer });
      if (m.type === 'frame') { w.frames.push(m); return; }
      let reply;
      if (m.type === 'init') reply = initError ? { ok: false, error: initError } : { ok: true, value: { delegate, fallbackReason: null, initMs: 5 } };
      else if (m.type === 'options') reply = { ok: true, value: { numPoses: m.numPoses } };
      else if (m.type === 'switch') { delegate = 'CPU'; reply = { ok: true, value: { delegate: 'CPU' } }; }
      else reply = { ok: true, value: {} };
      queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ...reply } }));
    },
    /** Answer every queued frame. */
    flush() {
      for (const f of w.frames.splice(0)) {
        f.image.close();
        if (detectThrows) { w.onmessage({ data: { type: 'detect-error', seq: f.seq, message: 'WebGL context lost' } }); continue; }
        const { n, data } = packResult({ landmarks: Array.from({ length: people }, (_, k) => lm33(0.3 + 0.4 * k)), worldLandmarks: Array.from({ length: people }, () => lm33(0)) });
        w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms: 12.5, n, data } });
      }
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

test('codec: a packed result unpacks to exactly what toPlayerPose builds (image, world, score, aspect)', () => {
  const lms = [lm33(0.3, 0.7), lm33(0.6, 0.95)];
  const worlds = [lm33(0), lm33(0.1)];
  const { n, data } = packResult({ landmarks: lms, worldLandmarks: worlds });
  assert(n === 2 && data.length === 2 * PACKED_POSE);
  const got = unpackPoses(data, n, 4 / 3, poseScore);
  for (let k = 0; k < 2; k++) {
    const want = toPlayerPose(lms[k], worlds[k], 4 / 3);
    assert(got[k].aspect === want.aspect);
    approx(got[k].score, want.score, 1e-6);
    for (let i = 0; i < 33; i++) {
      for (const f of ['x', 'y', 'z', 'visibility', 'presence']) approx(got[k].image[i][f], want.image[i][f], 1e-6, `image ${i}.${f}`);
      for (const f of ['x', 'y', 'z', 'visibility']) approx(got[k].world[i][f], want.world[i][f], 1e-6, `world ${i}.${f}`);
    }
  }
  const noWorld = unpackPoses(packResult({ landmarks: [lm33(0.4)] }).data, 1, 0, poseScore)[0];
  assert(noWorld.world[5].x === 0 && noWorld.world[5].visibility === 0 && !('aspect' in noWorld), 'missing world → zeros, like toPlayerPose');
  assert(packResult({ landmarks: [] }).n === 0);
});

test('worker tracker: init + warm-up run in the worker; detect() never waits and returns each result once', async () => {
  const restore = modelOk();
  try {
    await withVideoFrame(async (frames) => {
      const fw = fakeWorker();
      const t = new WorkerPoseTracker({ numPoses: 2, forceWorker: true, workerFactory: () => fw });
      let mainThreadLoads = 0;
      t._vision = { get PoseLandmarker() { mainThreadLoads++; return null; }, get FilesetResolver() { mainThreadLoads++; return null; } };
      const info = await t.init();
      assert(info.delegate === 'GPU' && t.detector === 'worker' && t.ready && t.getStats().detector === 'worker');
      assert(mainThreadLoads === 0 && t._landmarker === null, 'no landmarker / inference on the main thread (PERF-05)');
      const init = fw.received[0];
      assert(init.m.type === 'init' && init.m.options.numPoses === 2 && init.m.warmup === TRACKER_DEFAULTS.warmup);
      assert(/^https?:\/\/.+\/mediapipe\/wasm$/.test(init.m.wasmUrl), `absolute wasm URL: ${init.m.wasmUrl}`);
      assert(init.m.model instanceof ArrayBuffer && init.transfer.includes(init.m.model), 'model buffer transferred, not copied');

      const v = videoWithRvfc();
      assert(t.detect(v, 1000) === null && !t.lastCallWorked, 'attaches the frame callback');
      v.present(1010, { captureTime: 990 });
      assert(fw.frames.length === 1 && frames.length === 1, 'the new camera frame goes to the worker from the frame callback');
      assert(fw.received.at(-1).transfer[0] === frames[0], 'the VideoFrame is transferred');
      v.present(1043, { captureTime: 1023 });
      assert(fw.frames.length === 1, 'one frame in flight: the next one waits');
      assert(t.detect(v, 1050) === null, 'no result yet → null, no waiting');
      fw.flush();
      assert(fw.frames.length === 1 && fw.frames[0].ts === 1023, 'the newest camera frame is sent as soon as the worker is free');
      const f = t.detect(v, 1060);
      assert(f && f.players.length === 1 && f.width === 640 && f.height === 480 && t.lastCallWorked);
      assert(f.t === 990 && f.timing.source === 'capture', JSON.stringify(f.timing));
      approx(f.timing.latencyMs, 70, 0.11, 'capture → handed to the game');
      approx(f.players[0].aspect, 640 / 480, 1e-9);
      assert(t.detect(v, 1070) === null && !t.lastCallWorked, 'each result is returned once');
      const s = t.getStats();
      assert(s.frames === 1 && Math.abs(s.detectMs - 12.5) < 1e-6, 'stats report the worker detect time');
      assert(frames[0].closed, 'the worker closed the frame');
      t.close();
      assert(fw.terminated && !t.ready);
    });
  } finally { restore(); }
});

test('worker tracker: without frame callbacks it polls from detect(); numPoses and GPU→CPU go to the worker', async () => {
  const restore = modelOk();
  try {
    await withVideoFrame(async () => {
      const fw = fakeWorker({ detectThrows: true });
      const t = new WorkerPoseTracker({ numPoses: 2, forceWorker: true, workerFactory: () => fw });
      await t.init();
      const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
      v.currentTime = 1;
      assert(t.detect(v, 100) === null && fw.frames.length === 1 && t.lastCallWorked, 'polled frame sent from detect()');
      await t.setNumPoses(1);
      assert(fw.received.some((r) => r.m.type === 'options' && r.m.numPoses === 1) && t.numPoses === 1);
      fw.flush(); // the GPU detect throws in the worker
      assert(t._switching, 'GPU → CPU switch started');
      await t._switching;
      assert(t.delegate === 'CPU' && fw.received.some((r) => r.m.type === 'switch' && r.m.delegate === 'CPU') && /GPU failed/.test(t.fallbackReason));
      assert(t.detector === 'worker', 'still in the worker');
      t.close();
    });
  } finally { restore(); }
});

test('worker: the wasm factory survives tasks-vision clearing it, so a second landmarker (GPU → CPU) can start', () => {
  // what the module loader does once (a cached import), and what tasks-vision does per created task
  const scope = {};
  const keeper = keepModuleFactory(scope);
  assert(keeper.restore() === false, 'nothing to restore before the loader ran');
  const factory = async () => ({});
  scope.ModuleFactory = factory;          // vision_wasm_module_internal.js: globalThis.ModuleFactory = …
  assert(scope.ModuleFactory === factory);
  scope.ModuleFactory = undefined;        // tasks-vision after the first task: self.ModuleFactory = void 0
  assert(!scope.ModuleFactory, 'cleared like tasks-vision does');
  assert(keeper.restore() === true && scope.ModuleFactory === factory, 'put back for the next task');
  assert(keeper.restore() === false, 'no-op while set');
  // a classic worker re-running the loader still works (a fresh factory replaces the kept one)
  const fresh = async () => ({});
  scope.ModuleFactory = fresh;
  scope.ModuleFactory = undefined;
  keeper.restore();
  assert(scope.ModuleFactory === fresh);
});

test('worker tracker: a CPU switch the worker cannot make → main-thread detection, not a fatal error', async () => {
  const restore = modelOk();
  try {
    await withVideoFrame(async () => {
      const fw = fakeWorker({ detectThrows: true });
      const post = fw.postMessage;
      fw.postMessage = (m, tr) => {
        if (m.type === 'switch') { fw.received.push({ m, transfer: tr }); queueMicrotask(() => fw.onmessage({ data: { type: 'reply', id: m.id, ok: false, error: 'ModuleFactory not set.' } })); return; }
        post(m, tr);
      };
      const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
      const mainCreated = [];
      t._vision = {
        FilesetResolver: { forVisionTasks: async () => ({}) },
        PoseLandmarker: { createFromOptions: async (fs, o) => { mainCreated.push(o.baseOptions.delegate); return { detectForVideo: () => ({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }), close() {}, setOptions: async () => {} }; } },
      };
      await t.init();
      const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 };
      t.detect(v, 10);
      fw.flush(); // GPU detect fails in the worker → switch to CPU → the worker can't
      const ow = console.warn; console.warn = () => {};
      try { await t._switching; } finally { console.warn = ow; }
      assert(!t.error, `no fatal error: ${t.error && t.error.message}`);
      assert(t.detector === 'main' && fw.terminated && mainCreated.length === 1 && /could not switch/.test(t.workerFallbackReason));
      v.currentTime = 2;
      assert(t.detect(v, 100) !== null, 'detection goes on (main thread)');
      t.close();
    });
  } finally { restore(); }
});

test('worker tracker: a video that can’t become a VideoFrame goes as ImageBitmaps; frames that can’t be passed at all → main thread', async () => {
  const restore = modelOk();
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  const hadCIB = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const ow = console.warn;
  try {
    globalThis.VideoFrame = class { constructor() { throw new DOMException('no frame', 'InvalidStateError'); } };
    let bitmaps = 0;
    globalThis.createImageBitmap = async () => { bitmaps++; return { close() {} }; };
    const fw = fakeWorker();
    const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
    t._vision = { FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }), close() {}, setOptions: async () => {} }) } };
    await t.init();
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 };
    t.detect(v, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert(bitmaps === 1 && fw.frames.length === 1, 'sent as an ImageBitmap');
    fw.flush();
    assert(t.detect(v, 40) !== null && t.detector === 'worker');
    // now nothing can be grabbed: after a few frames detection moves to the main thread
    globalThis.createImageBitmap = async () => { throw new Error('tainted'); };
    console.warn = () => {};
    for (let i = 0; i < 12 && t.detector === 'worker'; i++) { v.currentTime += 1; t.detect(v, 100 + i * 40); await new Promise((r) => setTimeout(r, 0)); }
    if (t._switching) await t._switching;
    assert(t.detector === 'main' && /cannot be passed/.test(t.workerFallbackReason), String(t.workerFallbackReason));
    v.currentTime += 1;
    assert(t.detect(v, 2000) !== null, 'main-thread detection works');
    t.close();
  } finally {
    console.warn = ow;
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
    if (hadCIB) Object.defineProperty(globalThis, 'createImageBitmap', hadCIB); else delete globalThis.createImageBitmap;
    restore();
  }
});

test('worker tracker: a worker that cannot start → main-thread detection (same tracker object)', async () => {
  const restore = modelOk();
  try {
    for (const factory of [() => fakeWorker({ initError: 'OffscreenCanvas WebGL unavailable' }), () => { throw new Error('Worker is not defined'); }]) {
      const t = new WorkerPoseTracker({ numPoses: 2, forceWorker: true, workerFactory: factory, tuning: { warmup: false } });
      const main = [];
      t._vision = {
        FilesetResolver: { forVisionTasks: async (base) => ({ wasmLoaderPath: `${base}/x.js` }) },
        PoseLandmarker: { createFromOptions: async (fs, o) => { main.push(o.baseOptions.delegate); return { detectForVideo: () => ({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }), close() {}, setOptions: async () => {} }; } },
      };
      const info = await t.init();
      assert(main.length === 1 && info.delegate === 'GPU' && t.detector === 'main' && t.ready, `fallback init ${JSON.stringify(main)}`);
      assert(t.workerFallbackReason && t.getStats().detector === 'main');
      const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 };
      const f = t.detect(v, 100);
      assert(f && f.players.length === 1 && t.lastCallWorked, 'main-thread detection works');
      t.close();
    }
    // Node has no Worker / OffscreenCanvas: without forceWorker the tracker goes straight to the main thread
    assert(!workerDetectionSupported());
    const t2 = new WorkerPoseTracker({ tuning: { warmup: false } });
    t2._vision = { FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [] }), close() {} }) } };
    await t2.init();
    assert(t2.detector === 'main' && /cannot detect in a worker/.test(t2.workerFallbackReason));
    t2.close();
  } finally { restore(); }
});

test('worker tracker: a worker that stops answering mid-session hands detection to the main thread', async () => {
  const restore = modelOk();
  try {
    await withVideoFrame(async () => {
      const fw = fakeWorker();
      const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false, workerStallMs: 30 } });
      t._vision = {
        FilesetResolver: { forVisionTasks: async () => ({}) },
        PoseLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }), close() {}, setOptions: async () => {} }) },
      };
      await t.init();
      const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 };
      t.detect(v, 0); // frame sent, never answered
      await new Promise((r) => setTimeout(r, 45));
      assert(t.detect(v, 50) === null && t._switching, 'stall detected → falling back');
      const origWarn = console.warn; console.warn = () => {};
      try { await t._switching; } finally { console.warn = origWarn; }
      assert(fw.terminated && t.detector === 'main' && /failed/.test(t.workerFallbackReason));
      v.currentTime = 2;
      assert(t.detect(v, 200) !== null, 'detection continues on the main thread');
      t.close();
    });
  } finally { restore(); }
});

// ───────────────────────────── InputHub.lastDetectMs (D9) and detector choice ─────────────────────────────

class FakeRecognizer { update(pose) { return { control: neutralControl({ tracked: !!pose }), events: [] }; } setCalibration() {} reset() {} }
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

test('hub: lastDetectMs is the main-thread time of the last update()’s detection, 0 when none ran', async () => {
  const queue = [];
  class SlowTracker {
    constructor(o) { Object.assign(this, { model: o.model, requestedDelegate: o.delegate, numPoses: o.numPoses, error: null, _worked: false }); }
    async init() { return {}; }
    get lastCallWorked() { return this._worked; }
    detect() { const f = queue.shift() || null; this._worked = !!f; if (f) busy(8); return f; }
    async setNumPoses(n) { this.numPoses = n; }
    getStats() { return { delegate: 'GPU', detectMs: 8, detectMsP95: 8, numPoses: this.numPoses, detector: 'main' }; }
    close() {}
  }
  const cam = { video: { readyState: 4, videoWidth: 640, videoHeight: 480 }, stop() {} };
  const hub = new InputHub({ mode: InputMode.CAMERA, deps: { GestureRecognizer: FakeRecognizer, PoseTracker: SlowTracker, openCamera: async () => cam } });
  assert(hub.lastDetectMs === 0);
  await hub.start();
  hub.update(0);
  assert(hub.lastDetectMs === 0 && hub.status.lastDetectMs === 0, 'no new camera frame → 0');
  queue.push({ t: 16, width: 640, height: 480, players: [] });
  hub.update(16);
  assert(hub.lastDetectMs >= 7.5 && hub.lastDetectMs < 60, `detection frame → ${hub.lastDetectMs}`);
  hub.update(32);
  assert(hub.lastDetectMs === 0, 'and 0 again on the next frame without one');
  hub.stop();
  hub.update(48);
  assert(hub.lastDetectMs === 0);
});

test('hub: detector "worker" uses WorkerPoseTracker, "main" PoseTracker (option or ?detector=)', async () => {
  const made = [];
  const mk = (name) => class { constructor(o) { this.name = name; this.model = o.model; this.requestedDelegate = o.delegate; this.numPoses = o.numPoses; made.push(name); } async init() {} detect() { return null; } async setNumPoses(n) { this.numPoses = n; } getStats() { return { numPoses: this.numPoses, detector: name }; } close() { this.closed = true; } };
  const cam = { video: { readyState: 4, videoWidth: 640, videoHeight: 480 }, stop() {} };
  const deps = { GestureRecognizer: FakeRecognizer, PoseTracker: mk('main'), WorkerPoseTracker: mk('worker'), openCamera: async () => cam };
  const w = new InputHub({ mode: InputMode.CAMERA, detector: 'worker', deps });
  await w.start();
  assert(w._tracker.name === 'worker' && w.status.detector === 'worker');
  await w.setDetector('main');
  assert(w._tracker.name === 'main' && w.status.detector === 'main', 'switching detector restarts the tracker');
  const m = new InputHub({ mode: InputMode.CAMERA, detector: 'main', deps });
  await m.start();
  assert(m._tracker.name === 'main');
  const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { search: '?detector=worker', href: 'http://127.0.0.1/?detector=worker' }, configurable: true });
  try {
    const u = new InputHub({ mode: InputMode.CAMERA, deps });
    assert(u.detector === 'worker', '?detector=worker');
  } finally { if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc); else delete globalThis.location; }
  // the default worker class really is WorkerPoseTracker, a PoseTracker
  assert(new InputHub({}).deps.WorkerPoseTracker === WorkerPoseTracker && WorkerPoseTracker.prototype instanceof PoseTracker);
});
