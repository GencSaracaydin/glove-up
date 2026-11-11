// RV-PERF-02 hardening: the detection worker runs one scheduling class below the page, so a busy start-up can
// starve one 12-frame window without the GPU being slow. The worker's one-time slow-GPU decision therefore
// takes two slow windows slowGpuRecheckMs (8 s since PERF-06, was 3 s) apart before it switches to the CPU delegate
// for good — the game's own rendering can starve the GPU detector until the adaptive quality has given GPU time
// back — unless
// the first window is above slowGpuSevereMs (1000 ms since PERF-06, was 270 ms): a GPU that slow switches at once. A fast first
// window ends the check exactly as before, and main-thread detection still decides on its first window.
import { test, assert } from '../harness.mjs';
import { PoseTracker, TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';
import { WorkerPoseTracker } from '../../src/input/pose-worker-tracker.js';
import { packResult } from '../../src/input/pose-worker-codec.js';

const lm33 = (x = 0.5) => Array.from({ length: 33 }, (_, i) => ({ x: x + i * 0.001, y: 0.5 + i * 0.002, z: -0.1 * i, visibility: 0.9, presence: 0.8 }));
const zipModel = () => { const b = new Uint8Array(200_000); b.set([0, 0, 0x50, 0x4b, 3, 4], 0); return b; };

async function setup(fn) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) }, arrayBuffer: async () => zipModel().buffer });
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.VideoFrame = class { close() {} };
  const clock = { t: 1000 };
  performance.now = () => clock.t;
  try { await fn(clock); } finally {
    delete performance.now;
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
    globalThis.fetch = origFetch;
  }
}

/** Fake worker whose detections take `ms()` (as measured inside the worker); records the messages it got. */
function fakeWorker(ms) {
  const w = {
    received: [], frames: [], onmessage: null, delegate: 'GPU',
    postMessage(m) {
      w.received.push(m.type);
      if (m.type === 'frame') { w.frames.push(m); return; }
      let value = {};
      if (m.type === 'init') value = { delegate: 'GPU', fallbackReason: null, initMs: 5 };
      if (m.type === 'switch') { w.delegate = 'CPU'; value = { delegate: 'CPU' }; }
      queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ok: true, value } }));
    },
    flush() { for (const f of w.frames.splice(0)) { const { n, data } = packResult({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }); w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms: ms(), n, data } }); } },
    terminate() {},
  };
  return w;
}

/** One camera frame every 33 ms: sent, answered, picked up. */
function frames(t, fw, v, clock, n) {
  for (let i = 0; i < n; i++) {
    v.currentTime += 1 / 30;
    t.detect(v, clock.t);
    fw.flush();
    clock.t += 33;
    t.detect(v, clock.t);
  }
}

async function workerTracker(ms) {
  const fw = fakeWorker(ms);
  const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
  await t.init();
  return { t, fw, v: { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 } };
}

test('slow GPU (worker): defaults — 12-frame windows, 90 ms, a second look 8 s later unless above 1000 ms', () => {
  assert.equal(TRACKER_DEFAULTS.slowGpuFrames, 12);
  assert.equal(TRACKER_DEFAULTS.slowGpuMs, 90);
  assert.equal(TRACKER_DEFAULTS.slowGpuRecheckMs, 8000);
  assert.equal(TRACKER_DEFAULTS.slowGpuSevereMs, 1000);
});

test('slow GPU (worker): a first window above slowGpuSevereMs switches at once (no second look for a GPU that slow)', async () => {
  await setup(async (clock) => {
    const severe = TRACKER_DEFAULTS.slowGpuSevereMs + 30;
    const { t, fw, v } = await workerTracker(() => severe);
    frames(t, fw, v, clock, 11);
    assert(!t._switching && !t._gpuChecked, 'still measuring the first window');
    frames(t, fw, v, clock, 1);
    assert(t._switching && !t._gpuSlow, 'switched on the first window');
    await t._switching;
    assert(t.delegate === 'CPU' && fw.received.includes('switch') && new RegExp(`GPU too slow \\(${severe} ms per frame\\) — using CPU`).test(t.fallbackReason), t.fallbackReason);
    t.close();
  });
});

test('slow GPU (worker): a first window at slowGpuSevereMs still gets the second look', async () => {
  await setup(async (clock) => {
    const { t, fw, v } = await workerTracker(() => TRACKER_DEFAULTS.slowGpuSevereMs);
    frames(t, fw, v, clock, 12);
    assert(!t._switching && t._gpuSlow && !fw.received.includes('switch'), 'a second look is planned');
    t.close();
  });
});

test('slow GPU (worker): one starved start-up window does not pin the CPU delegate', async () => {
  await setup(async (clock) => {
    let cost = 130;                                    // the worker is starved at start-up …
    const { t, fw, v } = await workerTracker(() => cost);
    frames(t, fw, v, clock, 12);
    assert(t.delegate === 'GPU' && !t._switching && !fw.received.includes('switch'), 'no switch on the first slow window');
    assert(t._gpuSlow && !t._gpuChecked, 'a second look is planned');
    cost = 25;                                         // … and fine once the page has settled
    const wait = Math.floor(TRACKER_DEFAULTS.slowGpuRecheckMs / 33) - 1;
    frames(t, fw, v, clock, wait);                     // < slowGpuRecheckMs: nothing counts yet
    assert(t._gpuSlow && !t._gpuChecked && t._gpuFrames.length === 0, 'waiting for the second look');
    frames(t, fw, v, clock, 30);                       // past it: the second window (12 frames)
    assert(t._gpuChecked && !t._gpuSlow, 'checked');
    assert(t.delegate === 'GPU' && !fw.received.includes('switch') && t.fallbackReason === null, `stays on the GPU (${t.fallbackReason})`);
    t.close();
  });
});

test('slow GPU (worker): two slow windows slowGpuRecheckMs apart switch to the CPU delegate', async () => {
  await setup(async (clock) => {
    const { t, fw, v } = await workerTracker(() => 130);
    frames(t, fw, v, clock, 12);
    const firstAt = clock.t;
    assert(!fw.received.includes('switch'));
    frames(t, fw, v, clock, 60);                       // 2 s: still waiting — frames in between do not count
    assert(!fw.received.includes('switch') && t._gpuSlow && t._gpuFrames.length === 0, 'frames before the second look are ignored');
    let at = null;
    for (let i = 0; i < 400 && !t._switching; i++) { frames(t, fw, v, clock, 1); if (t._switching) at = clock.t; }
    assert(t._switching && at - firstAt >= TRACKER_DEFAULTS.slowGpuRecheckMs, `switch after the second slow window (${at - firstAt} ms after the first)`);
    await t._switching;
    assert(t.delegate === 'CPU' && fw.received.includes('switch') && /GPU too slow \(130 ms per frame\) — using CPU/.test(t.fallbackReason), t.fallbackReason);
    assert(t.detector === 'worker', 'still in the worker');
    t.close();
  });
});

test('slow GPU (worker): the normal-load path is unchanged — a fast first window ends the check after 12 frames', async () => {
  await setup(async (clock) => {
    const { t, fw, v } = await workerTracker(() => 18);
    frames(t, fw, v, clock, 11);
    assert(!t._gpuChecked);
    frames(t, fw, v, clock, 1);
    assert(t._gpuChecked && !t._gpuSlow && t.delegate === 'GPU' && !fw.received.includes('switch'));
    t.close();
  });
});

test('slow GPU (main thread): decides on its first window, as before', async () => {
  await setup(async (clock) => {
    const created = [];
    const t = new PoseTracker({ numPoses: 1, tuning: { warmup: false } });
    t._vision = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      PoseLandmarker: { createFromOptions: async (fs, o) => {
        created.push(o.baseOptions.delegate);
        // a GPU detect takes 120 ms of (virtual) main-thread time
        return { detectForVideo: () => { if (o.baseOptions.delegate === 'GPU') clock.t += 120; return { landmarks: [lm33()], worldLandmarks: [lm33(0)] }; }, close() {}, setOptions: async () => {} };
      } },
    };
    await t.init();
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
    for (let i = 0; i < 12 && !t._switching; i++) { v.currentTime += 1; clock.t += 40; t.detect(v, clock.t); }
    assert(t._switching, 'switched on the first slow window (main thread: unchanged)');
    await t._switching;
    assert(t.delegate === 'CPU' && created.join() === 'GPU,CPU' && /GPU too slow \(120 ms/.test(t.fallbackReason), t.fallbackReason);
    t.close();
  });
});
