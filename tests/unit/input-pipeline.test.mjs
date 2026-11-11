// PERF-06 — pose rate and lag (input pipeline):
//  * PipelineMeter: camera / detection rates, the slowest second, per-stage p50/p90 on the page clock.
//  * WorkerPoseTracker: every finished pose reaches the game in order (detect() + takeFrames()), each with its own
//    capture time and per-stage times (worker clock mapped to the page clock); a stalled page drops only the oldest;
//    setModel swaps full ↔ lite inside the running worker (no restart; no frame sent while the new graph starts).
//  * InputHub: all queued poses are processed per update; an explicit model is never changed; status.pipeline.
//    The governor itself (render pressure, auto model, delegate, safe moments, two-phase switches, camera rate) is in
//    input-governor.test.mjs; the hub fakes are in helpers/hub-fakes.mjs.
//  * camera.js: 60 fps request, maxFrameRate, setFrameRate (applyConstraints keeping the size).
//  * render/adaptive.js: a GPU detector that is behind takes render quality down (frame cap on a fast display first),
//    up-steps need detection headroom, no oscillation; a CPU detector or no camera changes nothing.
//  * core/storage.js: model 'auto' is the default; unversioned saves migrate ('full' → 'auto', 'lite' stays).
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { PoseTracker, PipelineMeter, TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';
import { WorkerPoseTracker } from '../../src/input/pose-worker-tracker.js';
import { packResult } from '../../src/input/pose-worker-codec.js';
import { HUB_TUNING, normModelPref } from '../../src/input/input-hub.js';
import { FakeRecognizer, GovTracker, govHub, person, run, intoActivity } from './helpers/hub-fakes.mjs';
import { openCamera } from '../../src/input/camera.js';
import { AdaptiveQuality, ADAPTIVE_TUNING } from '../../src/render/adaptive.js';
import { Storage, sanitizeSettings, DEFAULT_SETTINGS, SETTINGS_REV, STORAGE_KEYS } from '../../src/core/storage.js';

const lm33 = (x = 0.5) => Array.from({ length: 33 }, (_, i) => ({ x: x + i * 0.001, y: 0.5 + i * 0.002, z: -0.1 * i, visibility: 0.9, presence: 0.8 }));
const zipModel = () => { const b = new Uint8Array(200_000); b.set([0, 0, 0x50, 0x4b, 3, 4], 0); return b; };

// ───────────────────────────── PipelineMeter ─────────────────────────────

test('PERF-06 meter: rates, the slowest second, per-stage p50/p90, age; reset starts over', () => {
  const m = new PipelineMeter({ windowMs: 2000 });
  let cap = 1000;
  for (let i = 0; i < 90; i++, cap += 1000 / 30) {
    m.frameSeen(cap + 8);
    m.record({ capture: cap, seen: cap + 8, sent: cap + 10, start: cap + 11, end: cap + 27, arrived: cap + 28, picked: cap + 34, ms: 16 });
  }
  const s = m.stats(cap);
  approx(s.camFps, 30, 1.1, 'camera rate');
  approx(s.detFps, 30, 1.1, 'detection rate');
  assert(s.detMs.p50 === 16 && s.capToSeen.p50 === 8 && s.waitMs.p50 === 2 && s.queueMs.p50 === 1 && s.returnMs.p50 === 1, JSON.stringify(s));
  assert(s.capToPose.p50 === 28 && s.poseToGame.p50 === 6 && s.capToGame.p50 === 34, JSON.stringify(s));
  assert(s.detFpsMin >= 29 && s.detFpsMin <= 31, `slowest full second ${s.detFpsMin}`);
  approx(s.ageMs, 3000, 40);
  // a stalled second: 5 detections, the camera keeps going
  for (let i = 0; i < 30; i++, cap += 1000 / 30) {
    m.frameSeen(cap + 8);
    if (i % 6 === 0) m.record({ capture: cap, seen: cap + 8, sent: cap + 9, start: cap + 10, end: cap + 150, arrived: cap + 151, picked: cap + 160, ms: 140 });
  }
  const s2 = m.stats(cap + 1001);
  assert(s2.detFpsMin <= 6, `the slow second shows (${s2.detFpsMin})`);
  assert(s2.detMs.p90 === 140, 'the slow detections are in the p90');
  m.reset();
  const s3 = m.stats(cap + 2000);
  assert(s3.frames === 0 && s3.ageMs === 0 && s3.detMs.p50 === null && s3.detFpsMin === null);
  // a young meter rates over its own age, not the whole window
  m.frameSeen(10000); m.record({ capture: 9990, arrived: 10020, picked: 10030, ms: 15 });
  for (let k = 1; k <= 15; k++) { m.frameSeen(10000 + k * 33.3); m.record({ capture: 9990 + k * 33.3, arrived: 10020 + k * 33.3, picked: 10030 + k * 33.3, ms: 15 }); }
  const young = m.stats(10530);
  approx(young.detFps, 30, 2.5, `young meter rate ${young.detFps}`);
});

// ───────────────────────────── WorkerPoseTracker ─────────────────────────────

function withEnv(fn) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) }, arrayBuffer: async () => zipModel().buffer });
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.VideoFrame = class { constructor(src, init) { this.timestamp = init && init.timestamp; } close() { this.closed = true; } };
  return Promise.resolve().then(fn).finally(() => {
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
    globalThis.fetch = origFetch;
  });
}

/** Fake worker speaking pose-worker.js's protocol; `modelReply` may hold a 'model' answer back. */
function fakeWorker({ workerOriginDelta = 5, modelFails = false } = {}) {
  const w = {
    received: [], frames: [], terminated: false, onmessage: null, held: null,
    postMessage(m, transfer) {
      w.received.push({ m, transfer });
      if (m.type === 'frame') { w.frames.push(m); return; }
      const send = (reply) => queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ...reply } }));
      if (m.type === 'init') send({ ok: true, value: { delegate: 'GPU', fallbackReason: null, initMs: 5, timeOrigin: performance.timeOrigin + workerOriginDelta } });
      else if (m.type === 'model') { w.held = () => send(modelFails ? { ok: false, error: 'model failed to start' } : { ok: true, value: { delegate: 'GPU', ms: 120 } }); }
      else send({ ok: true, value: {} });
    },
    /** Answer every queued frame (inference 100 → 116 ms on the worker clock). */
    flush() {
      for (const f of w.frames.splice(0)) {
        const { n, data } = packResult({ landmarks: [lm33()], worldLandmarks: [lm33(0)] });
        w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms: 16, n, data, rx: 99, t0: 100, t1: 116 } });
      }
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

function videoWithRvfc() {
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, srcObject: {}, cb: null };
  v.requestVideoFrameCallback = (cb) => { v.cb = cb; return 7; };
  v.cancelVideoFrameCallback = () => {};
  v.present = (wall, meta = {}) => { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; cb(wall, { presentationTime: wall - 5, ...meta }); };
  return v;
}

test('PERF-06 worker tracker: two poses finished between two game frames both reach the game, in order, with their own times', async () => {
  await withEnv(async () => {
    const fw = fakeWorker();
    const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
    await t.init();
    const v = videoWithRvfc();
    assert(t.detect(v, 1000) === null);
    v.present(1010, { captureTime: 995 });           // frame A → worker
    v.present(1043, { captureTime: 1028 });          // frame B waits (one in flight)
    fw.flush();                                       // A answered → B is sent at once
    fw.flush();                                       // B answered: two results, no game frame in between
    const a = t.detect(v, 1060);
    const rest = t.takeFrames(1060);
    assert(a && a.t === 995 && rest.length === 1 && rest[0].t === 1028, `both, oldest first (${a && a.t}, ${rest.map((f) => f.t)})`);
    assert(t.takeFrames(1070).length === 0 && t.detect(v, 1070) === null, 'each once');
    approx(a.timing.latencyMs, 65, 0.11, 'A: capture → handed to the game');
    approx(rest[0].timing.latencyMs, 32, 0.11, 'B: its own capture time');
    // per-stage times on the page clock: the worker's clock is 5 ms ahead of the page's origin
    assert(a.timing.startTime === 105 && a.timing.endTime === 121, `worker clock → page clock (${a.timing.startTime}, ${a.timing.endTime})`);
    assert(Number.isFinite(a.timing.sentTime) && Number.isFinite(a.timing.arrivedTime) && a.timing.pickedTime === 1060, JSON.stringify(a.timing));
    const st = t.pipelineStats(1060);
    assert(st.frames === 2 && st.detMs.p50 === 16, JSON.stringify(st));
    t.close();
  });
});

test('PERF-06 worker tracker: a stalled page keeps the newest maxQueuedResults poses and counts the dropped ones', async () => {
  await withEnv(async () => {
    const fw = fakeWorker();
    const t = new WorkerPoseTracker({ numPoses: 1, forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
    await t.init();
    const v = videoWithRvfc();
    t.detect(v, 1000);
    for (let i = 0; i < 9; i++) { v.present(1010 + i * 33, { captureTime: 1000 + i * 33 }); fw.flush(); }
    const max = TRACKER_DEFAULTS.maxQueuedResults;
    const got = [t.detect(v, 1400), ...t.takeFrames(1400)];
    assert(got.length === max && t.droppedResults === 9 - max, `${got.length} delivered, ${t.droppedResults} dropped`);
    assert(got.every((f, i) => i === 0 || f.t > got[i - 1].t) && got.at(-1).t === 1000 + 8 * 33, 'the newest, in order');
    t.close();
  });
});

test('PERF-06 worker tracker: setModel swaps the model inside the running worker; no frame goes out meanwhile; a failure keeps the old model', async () => {
  await withEnv(async () => {
    const fw = fakeWorker();
    const t = new WorkerPoseTracker({ numPoses: 1, model: 'full', forceWorker: true, workerFactory: () => fw, tuning: { warmup: false } });
    await t.init();
    const v = videoWithRvfc();
    t.detect(v, 1000);
    const p = t.setModel('lite');
    await new Promise((r) => setTimeout(r, 0));       // the model file is fetched, the swap is requested
    const req = fw.received.find((r) => r.m.type === 'model');
    assert(req && req.m.model instanceof ArrayBuffer && req.transfer.includes(req.m.model), 'the new model buffer is transferred to the worker');
    v.present(1033, { captureTime: 1020 });
    assert(fw.frames.length === 0, 'no frame is sent while the new graph starts');
    fw.held();
    const info = await p;
    assert(info.model === 'lite' && t.model === 'lite' && !fw.terminated, 'same worker, new model');
    assert(fw.received.filter((r) => r.m.type === 'init').length === 1, 'no second init (no wasm reload)');
    v.present(1066, { captureTime: 1050 });
    assert(fw.frames.length === 1, 'frames flow again');
    t.close();

    const fw2 = fakeWorker({ modelFails: true });
    const t2 = new WorkerPoseTracker({ numPoses: 1, model: 'full', forceWorker: true, workerFactory: () => fw2, tuning: { warmup: false } });
    await t2.init();
    const p2 = t2.setModel('lite');
    await new Promise((r) => setTimeout(r, 0));
    fw2.held();
    let err = null;
    try { await p2; } catch (e) { err = e; }
    assert(err && err.name === 'TrackerError' && t2.model === 'full' && !fw2.terminated && t2.ready, `old model kept (${err && err.message})`);
    t2.close();
  });
});

test('PERF-06 tracker: the polling fallback may detect up to the camera rate (setCameraFps)', () => {
  const lm = { detectForVideo() { return { landmarks: [lm33()], worldLandmarks: [lm33(0)] }; }, close() {} };
  const t = new PoseTracker({ numPoses: 1 });
  t._landmarker = lm; t.delegate = 'CPU';
  t.setCameraFps(60);
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, paused: false };
  let n = 0;
  let clock = 0;
  performance.now = () => clock; // the main-thread tracker times its inference with performance.now()
  try {
    for (clock = 0; clock < 1000; clock += 4) { v.currentTime = clock / 1000; if (t.detect(v, clock)) n++; }
    assert(n >= 55 && n <= 64, `~60 per second at a 60 fps camera, got ${n}`);
    const s = t.pipelineStats(1000);
    assert(s.frames >= 55 && s.camFps >= 55, JSON.stringify({ frames: s.frames, camFps: s.camFps }));
  } finally { delete performance.now; }
  t.setCameraFps(0);
  assert(t._pollFps === TRACKER_DEFAULTS.pollFps, 'nonsense → the default cap');
});

// ───────────────────────────── InputHub ─────────────────────────────

test('PERF-06 hub: every queued pose is processed per update, in order (detect() + takeFrames())', async () => {
  const { hub, t } = await govHub();
  FakeRecognizer.last = null;
  const pose = { image: lm33(), world: lm33(0), score: 0.9 };
  t.queue.push({ t: 100, width: 640, height: 480, players: [pose] });
  t.more = [{ t: 117, width: 640, height: 480, players: [pose] }, { t: 133, width: 640, height: 480, players: [pose] }];
  hub.update(140);
  assert.deepEqual(FakeRecognizer.last.calls, [100, 117, 133], `the recognizer saw each pose with its own time (${FakeRecognizer.last.calls})`);
  hub.stop();
});

test('PERF-06 hub: an explicit model is never changed by the hub; setModel("auto") keeps the running model', async () => {
  const { hub, bus, t } = await govHub({ model: 'full' });
  assert(hub.modelPref === 'full');
  const now = await intoActivity(hub, t);
  bus.emit(Ev.MATCH_ROUND_END, { round: 1 });
  t.stats = GovTracker.stats({ detFps: 12, p50: 80 });
  run(hub, t, now, HUB_TUNING.liteAfterMs * 2);
  assert(t.modelCalls.length === 0 && hub.model === 'full' && hub.status.pipeline.pendingModel === null, 'explicit full stays');
  await hub.setModel('lite');
  assert.deepEqual(t.modelCalls, ['lite'], 'the Settings choice applies at once (in place)');
  await hub.setModel('auto');
  assert(hub.modelPref === 'auto' && hub.model === 'lite' && t.modelCalls.length === 1, 'auto keeps lite for now');
  assert(normModelPref('x') === 'auto' && normModelPref('lite') === 'lite');
  hub.stop();
});

test('PERF-06 hub: status.pipeline carries the readout (rates, stages, capture → punch, model, camera, pressure)', async () => {
  const { hub, t } = await govHub();
  t.stats = GovTracker.stats({ p50: 15 });
  const now = run(hub, t, 0, 300);               // the assigner claims the player's slot
  const pose = { ...person({ t: now }), punch: true };
  t.queue.push({ t: now - 30, width: 640, height: 480, players: [pose], timing: { latencyMs: 40, captureTime: now - 40, arrivedTime: now - 10, source: 'capture' } });
  hub.update(now);
  const p = hub.status.pipeline;
  assert(p.capToEvent.p50 === 40 && p.poseToEvent.p50 === 10 && p.events === 1, JSON.stringify(p));
  assert(p.model === 'full' && p.modelPref === 'auto' && p.delegate === 'GPU' && p.detector === 'worker' && p.cameraFps === 30, JSON.stringify(p));
  assert(p.detFps === 30 && p.detMs.p50 === 15 && p.capToGame.p50 === 40, 'the tracker figures pass through');
  hub.stop();
});

// ───────────────────────────── camera.js ─────────────────────────────

function withMediaDevices(md, fn) {
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'mediaDevices');
  Object.defineProperty(nav, 'mediaDevices', { value: md, configurable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (had) Object.defineProperty(nav, 'mediaDevices', had); else delete nav.mediaDevices;
    if (!hadNav) delete globalThis.navigator;
  });
}

test('PERF-06 camera: asks for 60 fps when told, reports maxFrameRate, setFrameRate keeps the size and never throws', async () => {
  const applied = [];
  let settings = { deviceId: 'd60', width: 640, height: 480, frameRate: 60 };
  const track = {
    label: 'Fast Cam', readyState: 'live', addEventListener() {}, stop() {},
    getSettings: () => settings,
    getCapabilities: () => ({ frameRate: { min: 1, max: 60 } }),
    async applyConstraints(c) { applied.push(c); settings = { ...settings, frameRate: c.frameRate.max }; },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const calls = [];
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480, addEventListener() {}, removeEventListener() {}, async play() {}, pause() {} };
  await withMediaDevices({ getUserMedia: async (c) => { calls.push(c); return stream; } }, async () => {
    const cam = await openCamera({ video, frameRate: 60 });
    assert(calls[0].video.frameRate.ideal === 60 && calls[0].video.frameRate.max === 60, JSON.stringify(calls[0].video.frameRate));
    assert(cam.frameRate === 60 && cam.maxFrameRate === 60);
    const got = await cam.setFrameRate(30);
    assert(got === 30 && cam.frameRate === 30, 'decimated to 30');
    const c = applied[0];
    assert(c.width.ideal === 640 && c.height.ideal === 480 && c.frameRate.ideal === 30 && c.frameRate.max === 30, JSON.stringify(c));
    track.applyConstraints = async () => { throw Object.assign(new Error('nope'), { name: 'OverconstrainedError' }); };
    assert(await cam.setFrameRate(60) === 30, 'a refused change keeps the current rate');
    cam.stop();
    assert(await cam.setFrameRate(60) === 30, 'after stop: no-op');
  });
  // a camera that offers no capabilities: maxFrameRate is its current rate
  const t2 = { label: 'Old', addEventListener() {}, stop() {}, getSettings: () => ({ frameRate: 30 }) };
  await withMediaDevices({ getUserMedia: async () => ({ getTracks: () => [t2], getVideoTracks: () => [t2] }) }, async () => {
    const cam = await openCamera({ video });
    assert(cam.maxFrameRate === 30 && cam.frameRate === 30);
  });
});

// ───────────────────────────── render/adaptive.js ─────────────────────────────

/** Feed `sec` seconds of frames `ms` apart with the given detection pressure; returns the changes. */
function feedDet(q, sec, { ms = 16.7, p = null } = {}) {
  const changes = [];
  let t = 0;
  while (t < sec) {
    q.setDetectionPressure(typeof p === 'function' ? p(q) : p);
    const c = q.frame(ms / 1000);
    if (c) changes.push({ at: +t.toFixed(2), ...c });
    t += ms / 1000;
  }
  return changes;
}
const BEHIND = { behind: true, headroom: false, gpu: true, activity: true, detFps: 20, wantFps: 30 };
const FAR = { ...BEHIND, detFps: 8 };
const HEADROOM = { behind: false, headroom: true, gpu: true, activity: true, detFps: 30, wantFps: 30 };
const NEUTRAL = { behind: false, headroom: false, gpu: true, activity: true, detFps: 30, wantFps: 30 };

test('PERF-06 adaptive: a GPU detector behind for two windows takes one step; far behind, two notches at once', () => {
  const q = new AdaptiveQuality({ maxRatio: 2 });
  const ch = feedDet(q, 3.2, { p: BEHIND });
  assert(ch.length === 1 && ch[0].pixelRatio === 1.75 && ch[0].reason === 'detection', JSON.stringify(ch));
  assert(ch[0].at < 3.2, 'within a few seconds (the render warm-up does not apply)');
  const f = new AdaptiveQuality({ maxRatio: 2 });
  const fc = feedDet(f, 2.2, { p: FAR });
  assert(fc.length === 1 && fc[0].pixelRatio === 1.5, `far behind: 2 → 1.5 in one step (${JSON.stringify(fc)})`);
  // the whole ladder, then nothing left
  const all = feedDet(new AdaptiveQuality({ maxRatio: 2 }), 40, { p: BEHIND });
  assert.deepEqual(all.map((c) => c.pixelRatio ?? c.shadow), [1.75, 1.5, 1.25, 1, 'low']);
  // the frame interval says nothing (60 fps throughout): the render-time judge alone would never step
  assert.deepEqual(feedDet(new AdaptiveQuality({ maxRatio: 2 }), 40, { p: null }), []);
});

test('PERF-06 adaptive: a CPU detector, a one-off stall or setup-time noise change nothing', () => {
  assert.deepEqual(feedDet(new AdaptiveQuality({ maxRatio: 2 }), 30, { p: { ...BEHIND, gpu: false } }), [], 'CPU detector: render steps would not help');
  // one behind window between good ones (a main-thread stall) is not GPU contention
  let n = 0;
  const one = feedDet(new AdaptiveQuality({ maxRatio: 2 }), 12, { p: () => ((n++ % 360) < 60 ? BEHIND : NEUTRAL) });
  assert.deepEqual(one, [], JSON.stringify(one));
  assert.deepEqual(feedDet(new AdaptiveQuality({ maxRatio: 2, enabled: false }), 30, { p: FAR }), [], 'fixed quality');
});

test('PERF-06 adaptive: on a 120 Hz display the first step is a 60 fps frame cap, and it is the last thing lifted', () => {
  const q = new AdaptiveQuality({ maxRatio: 2 });
  const hz = [];
  const ch = feedDet(q, 4, { ms: 8.33, p: () => { if (q.frameDivisor === 1) hz.push(q.displayHz); return BEHIND; } });
  assert(ch.length >= 1 && ch[0].frameDivisor === 2 && q.frameDivisor === 2, JSON.stringify(ch));
  const seen = hz.filter(Number.isFinite).at(-1);
  assert(seen >= 110 && seen <= 130, `display measured at ${seen} Hz before the cap`);
  // capped, the app renders every 2nd display frame: the adaptive now sees 16.7 ms frames
  const more = feedDet(q, 4, { ms: 16.66, p: BEHIND });
  assert(more.length >= 1 && more[0].pixelRatio === 1.75 && q.displayHz >= 110, `then the pixel ratio (${JSON.stringify(more)})`);
  // detection recovers with headroom: up again, the cap last
  const up = feedDet(q, 120, { ms: 16.66, p: HEADROOM });
  assert(up.length >= 2 && up.at(-1).frameDivisor === 1 && q.pixelRatio === 2 && q.frameDivisor === 1, JSON.stringify(up));
  // a 60 Hz display is never capped
  const s = new AdaptiveQuality({ maxRatio: 2 });
  assert(feedDet(s, 4, { p: BEHIND })[0].pixelRatio === 1.75 && s.frameDivisor === 1);
});

test('PERF-06 adaptive: steps up need detection headroom; undoing a step up blocks that level for detCeilingSec (detCeilingRateSec when the rate starved); another pose budget is another context', () => {
  const q = new AdaptiveQuality({ maxRatio: 2 });
  feedDet(q, 3.2, { p: BEHIND });
  assert(q.pixelRatio === 1.75);
  assert.deepEqual(feedDet(q, 40, { p: NEUTRAL }), [], 'render headroom but no detection headroom: stays');
  const up = feedDet(q, 13, { p: HEADROOM });
  assert(up.length === 1 && up[0].pixelRatio === 2, JSON.stringify(up));
  const down = feedDet(q, 3.2, { p: { ...BEHIND, rateBehind: false, detFps: 30 } }); // lag: a slow median at the full rate
  assert(down.length === 1 && down[0].pixelRatio === 1.75 && q.state().ceiling, 'undone right away: ceiling set');
  assert(q.state().ceiling.of === ADAPTIVE_TUNING.detCeilingSec, JSON.stringify(q.state().ceiling));
  assert.deepEqual(feedDet(q, ADAPTIVE_TUNING.detCeilingSec - 10, { p: HEADROOM }), [], 'the starved level is off-limits');
  const later = feedDet(q, 90, { p: HEADROOM });
  assert(later.length === 1 && later[0].pixelRatio === 2, `tried again after the ceiling (${JSON.stringify(later)})`);
  // a probe that starved the rate (a big cost jump): off-limits for longer
  const r = new AdaptiveQuality({ maxRatio: 2 });
  feedDet(r, 3.2, { p: BEHIND });
  feedDet(r, 13, { p: HEADROOM });
  feedDet(r, 3.2, { p: BEHIND });
  assert(r.state().ceiling && r.state().ceiling.of === ADAPTIVE_TUNING.detCeilingRateSec, JSON.stringify(r.state().ceiling));
  // the hub's pose budget changes (setup → activity): the ceiling learnt for the other budget goes
  const b = new AdaptiveQuality({ maxRatio: 2 });
  feedDet(b, 3.2, { p: { ...BEHIND, activity: false } });
  feedDet(b, 13, { p: { ...HEADROOM, activity: false } });
  feedDet(b, 3.2, { p: { ...BEHIND, activity: false } });
  assert(b.state().ceiling, 'ceiling in setup');
  feedDet(b, 0.5, { p: HEADROOM });
  assert(b.state().ceiling === null, 'the activity budget has its own (none); merge-fix RG2: the setup one is kept for later');
});

// ───────────────────────────── storage ─────────────────────────────

function memBackend(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null };
}

test('PERF-06 storage: the tracking model defaults to auto; unversioned saves migrate (full → auto, lite stays); rev 2 keeps an explicit full', () => {
  assert(DEFAULT_SETTINGS.model === 'auto' && DEFAULT_SETTINGS.rev === SETTINGS_REV && SETTINGS_REV === 2);
  assert(sanitizeSettings(null).model === 'auto');
  assert(sanitizeSettings({ model: 'full' }).model === 'auto', 'an old save: full was only the default');
  assert(sanitizeSettings({ model: 'lite' }).model === 'lite', 'an old lite was a real choice');
  assert(sanitizeSettings({ model: 'full', rev: 2 }).model === 'full', 'a full chosen since rev 2 stays');
  assert(sanitizeSettings({ model: 'turbo', rev: 2 }).model === 'auto', 'junk → default');
  const backend = memBackend({ [STORAGE_KEYS.settings]: JSON.stringify({ schema: 1, model: 'full', sensitivity: 0.7 }) });
  const store = new Storage({ backend });
  assert(store.settings().model === 'auto' && store.settings().sensitivity === 0.7, 'migrated on load');
  const r = store.saveSettings({ model: 'full' });
  assert(r.saved && r.settings.model === 'full', 'an explicit full from Settings is kept');
  assert(new Storage({ backend: memBackend({ [STORAGE_KEYS.settings]: backend.map.get(STORAGE_KEYS.settings) }) }).settings().model === 'full', '… across reloads (rev written)');
});
