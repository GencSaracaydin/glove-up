// Camera → game latency (research/mechanics.md §4.6): PoseTracker stamps every frame with its
// capture → pose-ready latency from requestVideoFrameCallback metadata (captureTime / receiveTime /
// presentationTime / expectedDisplayTime, else the polling time), InputHub keeps a rolling median
// (hub.latencyMs, status.latencyMs) and the calibration result stores it (Calibration.latencyMs).
import { test, assert, approx } from '../harness.mjs';
import { PoseTracker, TRACKER_DEFAULTS } from '../../src/input/pose-tracker.js';
import { InputHub, HUB_TUNING } from '../../src/input/input-hub.js';
import { CalibrationSession } from '../../src/input/calibration.js';
import { InputMode } from '../../src/core/types.js';
import { syntheticPoseFrames } from '../../src/input/synthetic.js';

const lm33 = () => Array.from({ length: 33 }, (_, i) => ({ x: 0.4 + i * 0.001, y: 0.5, z: 0, visibility: 0.9 }));
function fakeLandmarker(costMs = 0) {
  return {
    detectForVideo() {
      const t0 = performance.now();
      while (performance.now() - t0 < costMs) { /* burn */ }
      return { landmarks: [lm33()], worldLandmarks: [lm33()] };
    },
    close() {},
  };
}
function readyTracker() { const t = new PoseTracker({ numPoses: 2 }); t._landmarker = fakeLandmarker(); t.delegate = 'CPU'; return t; }
function video({ live = true } = {}) {
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, cb: null, srcObject: live ? {} : null };
  v.requestVideoFrameCallback = (cb) => { v.cb = cb; return 1; };
  v.cancelVideoFrameCallback = () => {};
  v.present = (wall, meta) => { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; cb(wall, meta); };
  return v;
}

test('latency: tracker uses the camera capture time when it has one', () => {
  const t = readyTracker(), v = video();
  const now = performance.now();
  t.detect(v, now);                                     // attach the frame callback
  v.present(now, { captureTime: now - 55, presentationTime: now - 8 });
  const f = t.detect(v, now + 1);
  assert(f && f.timing && f.timing.source === 'capture', JSON.stringify(f && f.timing));
  assert(f.timing.latencyMs >= 55 && f.timing.latencyMs < 90, `latency ${f.timing.latencyMs}`);
  assert(Math.abs(t.getStats().latencyMs - f.timing.latencyMs) < 0.1 && t.getStats().latencySource === 'capture');
});

test('latency: receiveTime, then presentation time (+ nominal sensor delay for a live camera), then the poll time', () => {
  let t = readyTracker(), v = video();
  let now = performance.now();
  t.detect(v, now);
  v.present(now, { receiveTime: now - 40, presentationTime: now - 5 });
  let f = t.detect(v, now + 1);
  assert(f.timing.source === 'receive' && f.timing.latencyMs >= 40 && f.timing.latencyMs < 80, JSON.stringify(f.timing));
  // presentation only: live camera adds nominalCaptureMs, a clip does not
  t = readyTracker(); v = video({ live: true }); now = performance.now();
  t.detect(v, now); v.present(now, { presentationTime: now - 10 });
  f = t.detect(v, now + 1);
  assert(f.timing.source === 'presentation' && f.timing.latencyMs >= 10 + TRACKER_DEFAULTS.nominalCaptureMs - 1, JSON.stringify(f.timing));
  t = readyTracker(); v = video({ live: false }); now = performance.now();
  t.detect(v, now); v.present(now, { presentationTime: now - 10, mediaTime: 1.2 });
  f = t.detect(v, now + 1);
  assert(f.timing.source === 'presentation' && f.timing.latencyMs >= 10 && f.timing.latencyMs < 10 + TRACKER_DEFAULTS.nominalCaptureMs, JSON.stringify(f.timing));
  // no requestVideoFrameCallback: polling — half a frame + the nominal sensor delay
  t = readyTracker();
  const pv = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, srcObject: {} };
  now = performance.now();
  pv.currentTime = 0.5;
  f = t.detect(pv, now);
  assert(f && f.timing.source === 'poll' && f.timing.latencyMs >= TRACKER_DEFAULTS.nominalCaptureMs, JSON.stringify(f && f.timing));
});

test('latency: insane metadata is ignored; the median is robust', () => {
  const t = readyTracker(), v = video();
  t.detect(v, performance.now());
  for (let k = 0; k < 9; k++) {
    const now = performance.now();
    const meta = k === 4 ? { captureTime: now - 900000 } : { captureTime: now - 60 };   // one absurd clock
    v.present(now, meta);
    t.detect(v, now + 1);
  }
  const lat = t.latencyMs;
  assert(lat >= 60 && lat < 100, `median ${lat}`);
});

test('latency: hub.latencyMs = rolling median of the frames + processing lag; null with the keyboard', async () => {
  const hub = new InputHub({ mode: InputMode.CAMERA, players: 1 });
  assert(hub.latencyMs === null, 'no frames yet');
  const t0 = 10000;
  const frames = syntheticPoseFrames('guard-high', { seed: 3, ms: 1500, startMs: t0 });
  let k = 0;
  for (const f of frames) {
    // camera frames carry PoseTracker timing; make most of them 70 ms
    f.timing = { latencyMs: k++ % 7 === 3 ? 140 : 70, source: 'capture', captureTime: f.t - 70, readyTime: f.t };
    hub.injectFrames([f]);
  }
  hub.update(t0 + 1600);
  approx(hub.latencyMs, 70 + HUB_TUNING.processingLagMs, 0.6);
  assert(hub.status.latencyMs === hub.latencyMs && hub.status.latencySource === 'capture');
  // replayed / injected frames without timing: the frame's age when processed
  const hub2 = new InputHub({ mode: InputMode.CAMERA, players: 1 });
  for (const f of syntheticPoseFrames('idle', { seed: 2, ms: 600, startMs: 0 })) hub2.injectFrames([f]);
  assert(hub2.latencyMs === HUB_TUNING.processingLagMs, `injected now → frame age 0 → ${hub2.latencyMs}`);
  const kb = new InputHub({ mode: InputMode.KEYBOARD, players: 1 });
  await kb.start();
  kb.update(100);
  assert(kb.latencyMs === null && kb.status.latencyMs === null);
  kb.stop();
});

test('latency: CalibrationSession stores the measured latency in its result (number or getter)', () => {
  for (const latency of [83.4, () => 91]) {
    const s = new CalibrationSession({ latency, tuning: { punchGiveUpMs: 400, punchAcceptAfterMs: 400, raiseGiveUpMs: 400 }, now: () => 1 });
    const frames = syntheticPoseFrames([{ action: 'guard-high', ms: 6000 }], { seed: 1, noise: 0.3 });
    let st = null;
    for (const f of frames) { st = s.update(f.players[0], f.t); if (st.done) break; }
    assert(st && st.done && st.result, 'calibration finished');
    assert(st.result.latencyMs === Math.round(typeof latency === 'function' ? latency() : latency), JSON.stringify(st.result.latencyMs));
  }
  const none = new CalibrationSession({ tuning: { punchGiveUpMs: 300, punchAcceptAfterMs: 300, raiseGiveUpMs: 300 } });
  let st = null;
  for (const f of syntheticPoseFrames([{ action: 'guard-high', ms: 6000 }], { seed: 1, noise: 0.3 })) { st = none.update(f.players[0], f.t); if (st.done) break; }
  assert(st.done && !('latencyMs' in st.result), 'no latency known → field absent');
});

test('latency: hub.calibrate(i) puts the hub latency into the profile calibration', () => {
  const hub = new InputHub({ mode: InputMode.CAMERA, players: 1 });
  const bound = hub.calibrate(0);
  bound.session.tuning = { ...bound.session.tuning, punchGiveUpMs: 400, punchAcceptAfterMs: 400, raiseGiveUpMs: 400 };
  const frames = syntheticPoseFrames([{ action: 'guard-high', ms: 7000 }], { seed: 5, noise: 0.3, startMs: 1000 });
  for (const f of frames) {
    f.timing = { latencyMs: 64, source: 'capture', captureTime: f.t - 64, readyTime: f.t };
    hub.injectFrames([f]);
    if (bound.done) break;
  }
  assert(bound.done && bound.result, `calibration ${JSON.stringify(bound.state.step)}`);
  assert(bound.result.latencyMs === 64 + HUB_TUNING.processingLagMs, `stored ${bound.result.latencyMs}`);
  assert(hub.profiles[0].calibration === bound.result, 'applied to the player');
});
