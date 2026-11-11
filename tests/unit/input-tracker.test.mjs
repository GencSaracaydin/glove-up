// PoseTracker: new-frame detection (requestVideoFrameCallback / currentTime polling), strictly
// increasing timestamps, PoseFrame shape, GPU→CPU fallback (init, runtime error, too slow),
// readable init errors — with a fake MediaPipe module, fake video and stubbed fetch.
import { test, assert, approx } from '../harness.mjs';
import { PoseTracker, TrackerError, toPlayerPose, poseScore, hasZipHeader, TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';

const lm33 = (x = 0.5, vis = 0.9) => Array.from({ length: 33 }, (_, i) => ({ x: x + i * 0.001, y: 0.5, z: 0, visibility: vis }));

/** Fake landmarker: records timestamps, returns `people` poses; can throw. */
function fakeLandmarker({ people = 1, throwOnDetect = false } = {}) {
  return {
    ts: [], closed: false, options: null,
    detectForVideo(video, ts) {
      if (throwOnDetect) throw new Error('WebGL context lost');
      this.ts.push(ts);
      const landmarks = Array.from({ length: people }, (_, k) => lm33(0.3 + 0.4 * k));
      return { landmarks, worldLandmarks: landmarks.map(() => lm33(0)) };
    },
    async setOptions(o) { this.options = o; },
    close() { this.closed = true; },
  };
}

/** Fake MediaPipe module whose createFromOptions hands out landmarkers per delegate. */
function fakeVision(byDelegate) {
  const created = [];
  return {
    created,
    FilesetResolver: { forVisionTasks: async (base) => ({ wasmLoaderPath: `${base}/vision_wasm_internal.js`, wasmBinaryPath: `${base}/vision_wasm_internal.wasm` }) },
    PoseLandmarker: {
      createFromOptions: async (fileset, opts) => {
        created.push(opts.baseOptions.delegate);
        const f = byDelegate[opts.baseOptions.delegate];
        if (f instanceof Error) throw f;
        const lm = typeof f === 'function' ? f() : f;
        lm.options = opts;
        return lm;
      },
    },
  };
}

function videoWithRvfc({ w = 640, h = 480 } = {}) {
  const v = { readyState: 4, videoWidth: w, videoHeight: h, currentTime: 0, paused: false, ended: false, cb: null, cancelled: 0 };
  v.requestVideoFrameCallback = (cb) => { v.cb = cb; return 7; };
  v.cancelVideoFrameCallback = () => { v.cancelled++; };
  v.present = (wall, meta = {}) => { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; cb(wall, { presentationTime: wall - 5, ...meta }); };
  return v;
}

const zipModel = () => { const b = new Uint8Array(200_000); b.set([0, 0, 0x50, 0x4b, 3, 4], 0); return b; };
function stubFetch(map) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = map(String(url));
    return { ok: r.status === 200, status: r.status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (r.type || '') : null) }, arrayBuffer: async () => (r.body || new Uint8Array(0)).buffer };
  };
  return () => { globalThis.fetch = orig; };
}

/** A tracker that is "initialised" on a given fake landmarker without touching the network. */
function readyTracker(lm, opts = {}) {
  const t = new PoseTracker({ numPoses: 2, ...opts });
  t._landmarker = lm;
  t.delegate = opts.delegate || 'CPU';
  return t;
}

test('tracker: toPlayerPose copies landmarks, stamps aspect, scores upper-body visibility', () => {
  const p = toPlayerPose(lm33(0.4, 0.8), lm33(0), 4 / 3);
  assert(p.image.length === 33 && p.world.length === 33 && p.aspect === 4 / 3);
  approx(p.score, 0.8, 1e-9);
  const noWorld = toPlayerPose(lm33(0.4, 0.5));
  assert(noWorld.world.length === 33 && noWorld.world[0].x === 0 && !('aspect' in noWorld));
  assert(poseScore(null) === 0);
});

test('tracker: model files are recognised by their zip header (official .task starts with 2 zero bytes)', () => {
  assert(hasZipHeader(zipModel()));
  assert(!hasZipHeader(new TextEncoder().encode('<!doctype html><html>…')));
});

test('tracker: detects only when requestVideoFrameCallback reports a new frame', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const v = videoWithRvfc();
  assert(t.detect(v, 1000) === null, 'no frame callback yet → wait for it (no polling double-processing)');
  v.present(1010);
  const f = t.detect(v, 1016);
  assert(f && f.players.length === 1 && f.width === 640 && f.height === 480);
  assert(t.detect(v, 1032) === null, 'same frame is not detected twice');
  v.present(1043);
  assert(t.detect(v, 1049) !== null);
  assert(lm.ts.length === 2);
});

test('tracker: timestamps fed to MediaPipe are strictly increasing; camera capture time is used when sane', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const v = videoWithRvfc();
  t.detect(v, 1990); // attaches the frame callback
  v.present(2000, { captureTime: 1960 });
  const a = t.detect(v, 2005);
  approx(a.t, 1960, 0.51, 'capture time');
  v.present(2033, { captureTime: 1950 }); // clock hiccup: earlier than the previous frame
  const b = t.detect(v, 2040);
  assert(b.t > a.t, 'still increasing');
  v.present(2066, { captureTime: -5 }); // nonsense → falls back to the update time
  const c = t.detect(v, 2070);
  assert(c.t >= 2070 - 1 && c.t > b.t);
  for (let i = 1; i < lm.ts.length; i++) assert(lm.ts[i] > lm.ts[i - 1]);
});

test('tracker: a video whose frame callback never fires (hidden/detached) falls back to polling', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const v = videoWithRvfc();
  v.requestVideoFrameCallback = () => 1; // registered, never called
  assert(t.detect(v, 0) === null);
  v.currentTime = 0.1;
  assert(t.detect(v, 200) === null, 'still waiting for the callback');
  v.currentTime = 0.6;
  assert(t.detect(v, TRACKER_DEFAULTS.rvfcStallMs + 50) !== null, 'then polls currentTime');
});

test('tracker: without requestVideoFrameCallback it polls currentTime at most at the camera rate', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const v = { readyState: 4, videoWidth: 641, videoHeight: 534, currentTime: 0, paused: false };
  let n = 0;
  for (let now = 0; now < 1000; now += 8) { v.currentTime = now / 1000; if (t.detect(v, now)) n++; }
  assert(n >= 28 && n <= 32, `~30 detections per second, got ${n}`);
  const f = t.detect(v, 2000) || (v.currentTime += 1, t.detect(v, 2100));
  assert(f.players[0].aspect === 641 / 534, 'aspect stamped from the video size');
  v.readyState = 1;
  v.currentTime += 1;
  assert(t.detect(v, 3000) === null, 'not ready → no detection');
});

test('tracker: a paused clip that is seeked is detected once (frame stepping)', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 3, paused: true };
  assert(t.detect(v, 100) !== null);
  assert(t.detect(v, 200) === null);
  v.currentTime = 7.9;
  assert(t.detect(v, 300) !== null && t.detect(v, 400) === null);
});

test('tracker: players come back in detection order with world landmarks; stats are reported', () => {
  const lm = fakeLandmarker({ people: 2 });
  const t = readyTracker(lm);
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
  let f = null;
  for (let now = 0; now < 500; now += 34) { v.currentTime = now; f = t.detect(v, now) || f; }
  assert(f.players.length === 2 && f.players[0].image[0].x < f.players[1].image[0].x);
  assert(f.players[0].world.length === 33);
  const s = t.getStats();
  assert(s.frames >= 10 && s.fps > 20 && s.delegate === 'CPU' && s.detectMs >= 0 && s.numPoses === 2);
});

test('tracker: init loads the model once, prefers GPU and falls back to CPU when GPU fails', async () => {
  const restore = stubFetch((url) => (url.endsWith('.task') ? { status: 200, type: 'application/octet-stream', body: zipModel() } : { status: 200, type: 'text/javascript' }));
  try {
    const vision = fakeVision({ GPU: new Error('Unable to create WebGL context'), CPU: () => fakeLandmarker() });
    const t = new PoseTracker({ numPoses: 2, model: 'lite', basePath: '/', tuning: { warmup: false } });
    t._vision = vision;
    const info = await t.init();
    assert.deepEqual(vision.created, ['GPU', 'CPU']);
    assert(info.delegate === 'CPU' && t.delegate === 'CPU' && /GPU unavailable/.test(t.fallbackReason));
    const opts = t._landmarker.options;
    assert(opts.runningMode === 'VIDEO' && opts.numPoses === 2 && opts.baseOptions.modelAssetBuffer instanceof Uint8Array);
    assert(t.modelUrl === '/models/pose_landmarker_lite.task' && t.wasmUrl === '/mediapipe/wasm');
  } finally { restore(); }
});

test('tracker: a GPU that throws while tracking switches to CPU once', async () => {
  const restore = stubFetch(() => ({ status: 200, type: 'application/octet-stream', body: zipModel() }));
  try {
    const gpu = fakeLandmarker({ throwOnDetect: true });
    const t = readyTracker(gpu, { delegate: 'GPU' });
    t._vision = fakeVision({ CPU: () => fakeLandmarker() });
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 };
    assert(t.detect(v, 100) === null);
    assert(t._switching, 'switch started');
    await t._switching;
    assert(t.delegate === 'CPU' && gpu.closed && /GPU failed while tracking/.test(t.fallbackReason));
    v.currentTime = 2;
    assert(t.detect(v, 200) !== null);
  } finally { restore(); }
});

test('tracker: a GPU that works but crawls is replaced by the CPU after a few frames', async () => {
  const restore = stubFetch(() => ({ status: 200, type: 'application/octet-stream', body: zipModel() }));
  try {
    const t = readyTracker(fakeLandmarker(), { delegate: 'GPU', tuning: { slowGpuMs: -1 } }); // every frame counts as slow
    t._vision = fakeVision({ CPU: () => fakeLandmarker() });
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
    for (let i = 1; i <= TRACKER_DEFAULTS.slowGpuFrames; i++) { v.currentTime = i; t.detect(v, i * 40); }
    assert(t._switching, 'switch after slowGpuFrames');
    await t._switching;
    assert(t.delegate === 'CPU' && /GPU too slow/.test(t.fallbackReason) && t.getStats().frames === 0);
  } finally { restore(); }
});

test('tracker: missing model (404 or dev-server HTML page) → a pose-tracking error for players, the npm command as the dev hint', async () => {
  for (const r of [{ status: 404 }, { status: 200, type: 'text/html', body: new TextEncoder().encode('<html>') }]) {
    const restore = stubFetch(() => r);
    try {
      const t = new PoseTracker({});
      t._vision = fakeVision({});
      let err = null;
      try { await t.init(); } catch (e) { err = e; }
      assert(err instanceof TrackerError && err.code === 'model-missing', err && err.message);
      assert(err.source === 'tracker' && err.title === 'Pose model missing', `${err.source} / ${err.title}`);
      assert(!/npm|setup:models/.test(err.message + err.help + err.title), `players are not told to run npm scripts: "${err.help}"`);
      assert(/Use keyboard instead/.test(err.help) && /README/.test(err.help), err.help);
      assert(/npm run setup:models/.test(err.devHint), 'the developer remedy travels as devHint');
      assert(/pose_landmarker_full\.task/.test(err.message));
    } finally { restore(); }
  }
});

test('tracker: both delegates failing with a missing wasm runtime → "wasm-missing"', async () => {
  const restore = stubFetch((url) => (url.endsWith('.task') ? { status: 200, type: 'application/octet-stream', body: zipModel() } : { status: 404 }));
  try {
    const t = new PoseTracker({ tuning: { warmup: false } });
    t._vision = fakeVision({ GPU: new Error('boom'), CPU: new Error('boom') });
    let err = null;
    try { await t.init(); } catch (e) { err = e; }
    assert(err && err.code === 'wasm-missing' && err.source === 'tracker' && err.title === 'Pose-tracking files missing');
    assert(/setup:models/.test(err.devHint) && !/npm/.test(err.help), err.help);
  } finally { restore(); }
});

test('tracker: a numPoses change while the landmarker is being created is applied once it exists', async () => {
  const restore = stubFetch(() => ({ status: 200, type: 'application/octet-stream', body: zipModel() }));
  try {
    let release;
    const lm = fakeLandmarker();
    const t = new PoseTracker({ numPoses: 2, tuning: { warmup: false } });
    t._vision = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      PoseLandmarker: { createFromOptions: (fs, o) => new Promise((r) => { lm.options = o; release = () => r(lm); }) },
    };
    const p = t.init();
    while (!release) await new Promise((r) => setTimeout(r, 1));
    await t.setNumPoses(1); // the activity started meanwhile
    release();
    await p;
    assert(lm.options.numPoses === 1 && t.numPoses === 1, `landmarker numPoses ${lm.options.numPoses}`);
  } finally { restore(); }
});

test('tracker: lastCallWorked says whether detect() ran an inference; the video-frame hook sees every frame; rewatch re-attaches', () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  const seen = [];
  t._onVideoFrame = (v, wall) => seen.push(wall);
  const v = videoWithRvfc();
  assert(t.detect(v, 1000) === null && t.lastCallWorked === false);
  v.present(1010);
  assert(seen.length === 1 && seen[0] === 1010);
  assert(t.detect(v, 1016) !== null && t.lastCallWorked === true);
  assert(t.detect(v, 1032) === null && t.lastCallWorked === false);
  t.rewatch();
  assert(v.cancelled === 1, 'old callback cancelled');
  t.detect(v, 1040);
  v.present(1043);
  assert(seen.length === 2 && t.detect(v, 1050) !== null, 'callback attached again');
  assert(t.getStats().detector === 'main');
});

test('tracker: setNumPoses clamps 1..3 and reconfigures; close cancels the frame callback', async () => {
  const lm = fakeLandmarker();
  const t = readyTracker(lm);
  await t.setNumPoses(7);
  assert(t.numPoses === 3 && lm.options.numPoses === 3);
  const v = videoWithRvfc();
  t.detect(v, 0);
  t.close();
  assert(lm.closed && v.cancelled === 1 && !t.ready);
  assert(t.detect(v, 10) === null);
});
