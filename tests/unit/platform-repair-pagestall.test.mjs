// RV-PERF-01: the detection worker's watchdog measures the worker, not the page. After a main-thread stall
// (a long task, a debugger pause, a frozen machine) Chromium runs the first rendering step BEFORE the worker's
// answer that has been queued all along, so the first WorkerPoseTracker.detect() after the stall still sees
// the frame in flight, aged by the stall. A detect() call more than workerPageStallMs (1 s) after the
// previous one therefore takes the gap out of the age of the frame in flight. Live page time before and
// between stalls still counts, so a worker that really stops answering is caught after workerStallMs of
// live page time — also while the page keeps stalling (the verifier's hung-worker-plus-stalls attack).
// Ported from the perf skeptic's prototype tests. Time is a virtual clock (performance.now stubbed), so the
// stalls are exact on a loaded machine; one test repeats the first case with a real busy-wait.
import { test, assert } from '../harness.mjs';
import { Ev, InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { InputHub } from '../../src/input/input-hub.js';
import { TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';
import { WorkerPoseTracker } from '../../src/input/pose-worker-tracker.js';
import { packResult } from '../../src/input/pose-worker-codec.js';

const lm33 = (x = 0.5) => Array.from({ length: 33 }, (_, i) => ({ x: x + i * 0.001, y: 0.5 + i * 0.002, z: -0.1 * i, visibility: 0.9, presence: 0.8 }));
const zipModel = () => { const b = new Uint8Array(200_000); b.set([0, 0, 0x50, 0x4b, 3, 4], 0); return b; };
const mainVision = { FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }), close() {}, setOptions: async () => {} }) } };

/** Model fetch OK, a VideoFrame stand-in, console.warn collected, and (optionally) a virtual clock. */
async function setup(fn, { virtual = true } = {}) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) }, arrayBuffer: async () => zipModel().buffer });
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.VideoFrame = class { constructor() { this.closed = false; } close() { this.closed = true; } };
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  const clock = { t: 1000 };
  if (virtual) performance.now = () => clock.t;
  try {
    await fn({ clock, warnings });
  } finally {
    if (virtual) delete performance.now;
    console.warn = origWarn;
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
    globalThis.fetch = origFetch;
  }
}

/** Fake worker (pose-worker.js protocol): answers requests at once, queues frames until flush(). */
function fakeWorker() {
  const w = {
    frames: [], terminated: false, onmessage: null,
    postMessage(m) {
      if (m.type === 'frame') { w.frames.push(m); return; }
      const reply = m.type === 'init' ? { ok: true, value: { delegate: 'GPU', fallbackReason: null, initMs: 5 } } : { ok: true, value: {} };
      queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ...reply } }));
    },
    flush() { for (const f of w.frames.splice(0)) { const { n, data } = packResult({ landmarks: [lm33()], worldLandmarks: [lm33(0)] }); w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms: 12, n, data } }); } },
    terminate() { w.terminated = true; },
  };
  return w;
}

async function tracker(fw, tuning) {
  const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false, ...tuning } });
  t._vision = mainVision;
  await t.init();
  return t;
}
const video = () => ({ readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1 });

test('page stall: the default is an absolute 1 s, independent of workerStallMs (5 s)', () => {
  assert.equal(TRACKER_DEFAULTS.workerPageStallMs, 1000);
  assert.equal(TRACKER_DEFAULTS.workerStallMs, 5000);
});

test('page stall: a main-thread stall of 2× workerStallMs keeps the healthy worker and returns its queued answer', async () => {
  await setup(async ({ clock, warnings }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, { workerStallMs: 60, workerPageStallMs: 40 });
    const v = video();
    t.detect(v, 0);                       // a frame goes to the worker
    assert(fw.frames.length === 1 && t._inflight, 'one frame in flight');
    clock.t += 120;                       // the page is frozen 2× workerStallMs; the worker answered meanwhile…
    assert(t.detect(v, 130) === null, 'first call after the stall: the answer is still queued behind this frame');
    assert(!t._switching && t.detector === 'worker' && !fw.terminated && warnings.length === 0, 'the worker is not blamed for the page stall');
    fw.flush();                           // …and the queued answer is delivered right after that first call
    clock.t += 16;
    const f = t.detect(v, 146);
    assert(f && f.players.length === 1 && t.detector === 'worker', 'the queued answer arrives; worker detection goes on');
    t.close();
  });
});

test('page stall: the same with the defaults — a 6 s freeze of the page (the perf reports’ case) keeps the worker', async () => {
  await setup(async ({ clock, warnings }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, {});
    const v = video();
    for (let i = 0; i < 5; i++) { v.currentTime += 1; t.detect(v, i * 33); clock.t += 16; fw.flush(); clock.t += 17; }
    v.currentTime += 1;
    t.detect(v, 200);
    assert(t._inflight, 'a frame in flight when the page freezes');
    clock.t += 6000;
    assert(t.detect(v, 6200) === null && t.detector === 'worker' && !t._switching, 'no fallback on the first frame after the freeze');
    fw.flush();
    clock.t += 16;
    v.currentTime += 1;
    assert(t.detect(v, 6216) !== null && t.detector === 'worker' && warnings.length === 0, 'poses continue from the worker at once');
    t.close();
  });
});

test('page stall: a worker that stops answering is still caught while the page keeps running', async () => {
  await setup(async ({ clock }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, { workerStallMs: 60, workerPageStallMs: 40 });
    const v = video();
    t.detect(v, 0);                       // sent, never answered
    let calls = 0;
    while (!t._switching && calls < 100) { clock.t += 10; calls++; t.detect(v, calls * 10); } // rAF-like calls
    assert(t._switching, 'no answer for workerStallMs of live page time → fall back');
    assert(calls >= 6 && calls <= 7, `after ≈ workerStallMs (${calls * 10} ms)`);
    await t._switching;
    assert(fw.terminated && t.detector === 'main' && /no answer/.test(t.workerFallbackReason), String(t.workerFallbackReason));
    t.close();
  });
});

test('page stall: a page stall right after a real worker death only delays the fallback by the stall', async () => {
  await setup(async ({ clock }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, { workerStallMs: 60, workerPageStallMs: 40 });
    const v = video();
    t.detect(v, 0);
    clock.t += 120;                       // the page stalls; the dead worker never answers
    t.detect(v, 120);
    assert(!t._switching, 'not yet: the page was the one stalled');
    const t0 = clock.t;
    while (!t._switching && clock.t - t0 < 500) { clock.t += 10; t.detect(v, clock.t); }
    const after = clock.t - t0;
    assert(t._switching && after >= 60 && after <= 70, `fallback once the worker had workerStallMs of live page time (${after} ms)`);
    await t._switching;
    assert(t.detector === 'main');
    t.close();
  });
});

test('page stall: a dead worker is caught after workerStallMs of live time even while the page keeps stalling', async () => {
  await setup(async ({ clock }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, {});      // defaults: workerStallMs 5000, workerPageStallMs 1000
    const v = video();
    t.detect(v, clock.t);                 // a frame goes out; the worker never answers
    const t0 = clock.t;
    let live = 0, stalls = 0;
    // 1.5 s of live page (a rendering step every 16 ms), then a 1.5 s freeze, over and over
    while (!t._switching && clock.t - t0 < 60000) {
      for (let i = 0; i < 94 && !t._switching; i++) { clock.t += 16; live += 16; t.detect(v, clock.t); }
      if (t._switching) break;
      clock.t += 1500; stalls++;
      t.detect(v, clock.t);
    }
    assert(t._switching, `falls back while the stalls go on (${stalls} stalls, ${clock.t - t0} ms)`);
    assert(live > 5000 && live <= 5016 && stalls === 3, `after workerStallMs of live page time (${live} ms live, ${stalls} stalls, ${clock.t - t0} ms in all)`);
    await t._switching;
    assert(t.detector === 'main' && /no answer/.test(t.workerFallbackReason), String(t.workerFallbackReason));
    t.close();
  });
});

test('page stall: live time before a stall still counts — 4.5 s unanswered, a 2 s freeze, caught 0.5 s later', async () => {
  await setup(async ({ clock }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, {});
    const v = video();
    t.detect(v, clock.t);                 // sent, never answered
    for (let i = 0; i < 281; i++) { clock.t += 16; t.detect(v, clock.t); } // 4496 ms of live page
    assert(!t._switching, 'not yet');
    clock.t += 2000;                      // the page freezes
    t.detect(v, clock.t);
    assert(!t._switching, 'the freeze itself is not blamed on the worker');
    const t0 = clock.t;
    while (!t._switching && clock.t - t0 < 10000) { clock.t += 16; t.detect(v, clock.t); }
    const after = clock.t - t0;
    assert(t._switching && after > 480 && after <= 528, `the rest of workerStallMs after the freeze (${after} ms), not a fresh 5 s`);
    await t._switching;
    assert(t.detector === 'main');
    t.close();
  });
});

test('page stall: the existing regime (workerStallMs 30, calls 45 ms apart) still falls back', async () => {
  await setup(async ({ clock }) => {
    const fw = fakeWorker();
    const t = await tracker(fw, { workerStallMs: 30 });
    const v = video();
    t.detect(v, 0);
    clock.t += 45;
    assert(t.detect(v, 50) === null && t._switching, '45 ms of live time > 30 ms: stall detected (a 45 ms gap is no page stall)');
    await t._switching;
    assert(fw.terminated && t.detector === 'main');
    t.close();
  });
});

test('page stall: real time — a 300 ms busy-wait of the page with workerStallMs 120 keeps the worker', async () => {
  await setup(async () => {
    const fw = fakeWorker();
    const t = await tracker(fw, { workerStallMs: 120, workerPageStallMs: 60 });
    const v = video();
    t.detect(v, 0);
    const end = performance.now() + 300;
    while (performance.now() < end) { /* the page is frozen */ }
    assert(t.detect(v, 300) === null && !t._switching && t.detector === 'worker', 'not blamed on the worker');
    fw.flush();
    assert(t.detect(v, 316) !== null && t.detector === 'worker');
    t.close();
  }, { virtual: false });
});

class FakeRecognizer {
  update(pose) { return { control: neutralControl({ tracked: !!pose }), events: [] }; }
  setCalibration() {} reset() {} setAspect() {}
}

test('page stall: through the input hub — a 6 s page freeze mid-bout keeps worker detection and loses no tracking', async () => {
  await setup(async ({ clock, warnings }) => {
    const fw = fakeWorker();
    const v = video();
    class TestWorkerTracker extends WorkerPoseTracker {
      constructor(o) { super({ ...o, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } }); this._vision = mainVision; }
    }
    const events = [];
    const bus = { emit: (name, p) => events.push({ name, p }), on: () => () => {} };
    const hub = new InputHub({ bus, mode: InputMode.CAMERA, detector: 'worker', deps: { GestureRecognizer: FakeRecognizer, WorkerPoseTracker: TestWorkerTracker, openCamera: async () => ({ video: v, stop() {} }) } });
    assert((await hub.start()).ok);
    // the camera delivers a frame every 33 ms and the worker answers within the frame
    const frame = () => { v.currentTime += 1 / 30; hub.update(clock.t); fw.flush(); clock.t += 16; hub.update(clock.t); clock.t += 17; };
    for (let i = 0; i < 30; i++) frame();
    assert(hub.status.tracking[0] === true && hub.status.detector === 'worker', 'tracked by the worker');
    v.currentTime += 1 / 30;
    hub.update(clock.t);                  // a frame goes out …
    assert(hub._tracker._inflight, 'frame in flight');
    clock.t += 6000;                      // … and the page freezes for 6 s (the worker answers meanwhile)
    hub.update(clock.t);                  // the first rendering step after the freeze runs before the answer
    fw.flush();
    for (let i = 0; i < 30; i++) frame();
    assert.equal(hub.status.detector, 'worker', 'detection stays in the worker');
    assert(!events.some((e) => e.name === Ev.INPUT_TRACKING_LOST), 'no tracking-lost pause');
    assert(hub.status.tracking[0] === true && warnings.length === 0, warnings.join(' | '));
    hub.stop();
  });
});
