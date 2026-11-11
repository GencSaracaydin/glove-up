// Shared fakes for the PERF-06 input-hub tests (input-pipeline.test.mjs, input-governor.test.mjs). Not a test file:
// tests/run-unit.mjs only imports tests/unit/*.test.mjs.
import { assert } from '../../harness.mjs';
import { EventBus } from '../../../src/core/events.js';
import { InputMode } from '../../../src/core/types.js';
import { neutralControl } from '../../../src/input/keyboard.js';
import { InputHub } from '../../../src/input/input-hub.js';

export class FakeRecognizer {
  constructor() { this.calls = []; FakeRecognizer.last = this; }
  update(pose, t) { this.calls.push(t); return { control: neutralControl({ tracked: !!pose }), events: pose && pose.punch ? [{ type: 'punch', t, punch: { hand: 'left', kind: 'straight', target: 'head', power: 0.8, t } }] : [] }; }
  setCalibration() {}
  reset() {}
}

/** A tracker whose pipeline figures the test sets (stats), with frames on demand and recorded one-step switches. */
export class GovTracker {
  constructor(o) {
    this.model = o.model; this.numPoses = o.numPoses; this.requestedDelegate = o.delegate; this.delegate = 'GPU';
    this.queue = []; this.more = []; this.modelCalls = []; this.camFps = []; this.resets = 0; this.ready = true; this.error = null;
    this.stats = GovTracker.stats({});
    GovTracker.made = this;
  }
  static stats({ frames = 60, detFps = 30, camFps = 30, p50 = 15, ageMs = 5000, windowMs = 2000 }) {
    return { frames, detFps, camFps, ageMs, windowMs, detMs: { p50, p90: p50 }, detFpsMin: Math.floor(detFps), capToGame: { p50: 40, p90: 50 } };
  }
  async init() { return { delegate: 'GPU' }; }
  detect() { return this.queue.shift() || null; }
  takeFrames() { const m = this.more; this.more = []; return m; }
  getStats() { return { delegate: this.delegate, numPoses: this.numPoses, detectMs: 12, detectMsP95: 14, detector: 'worker', pipeline: this.stats }; }
  pipelineStats() { return this.stats; }
  async setNumPoses(n) { this.numPoses = n; }
  async setModel(m) { this.modelCalls.push(m); this.model = m; return { model: m }; }
  async setDelegate(d) { (this.delegateCalls ||= []).push(d); this.delegate = d; return {}; }
  setCameraFps(f) { this.camFps.push(f); }
  resetPipeline() { this.resets++; }
  get lastCallWorked() { return false; }
  close() { this.closed = true; }
}

/**
 * The same, with the two-phase switch (prepareSwitch → commitSwitch, revertSwitch, discardSwitch) and a switch gate.
 * hold: prepareSwitch waits for release(); fail: an error (with .code) prepareSwitch rejects with (failOnly: only for that
 * model / delegate).
 */
export class TwoPhaseTracker extends GovTracker {
  constructor(o) {
    super(o);
    this.calls = []; this.prepared = null; this.kept = null; this.hold = false; this.fail = null; this.release = null;
    this.switchGate = null; this.slowGpu = null; this.fallbackReason = null; this.tuning = { slowGpuMs: 90 };
  }
  get canPrepare() { return true; }
  prepareSwitch(to) {
    this.calls.push(['prepare', to.model || to.delegate]);
    return new Promise((resolve, reject) => {
      if (this.fail && (!this.failOnly || this.failOnly === (to.model || to.delegate))) { reject(this.fail); return; }
      const done = () => { this.prepared = { model: to.model || this.model, delegate: to.delegate || this.delegate }; resolve({ buildMs: 1500 }); };
      if (this.hold) this.release = done; else done();
    });
  }
  async commitSwitch({ keep = false, reason = null } = {}) {
    this.calls.push(['commit', keep]);
    const old = { model: this.model, delegate: this.delegate };
    this.model = this.prepared.model; this.delegate = this.prepared.delegate; this.prepared = null;
    this.kept = keep ? old : null;
    if (this.delegate === 'CPU') this.fallbackReason = reason || (this.slowGpu && this.slowGpu.reason) || 'cpu';
    else this.fallbackReason = null;
    this.slowGpu = null;
    return { warmMs: 300 };
  }
  async revertSwitch() { this.calls.push(['revert']); this.model = this.kept.model; this.delegate = this.kept.delegate; this.kept = null; return {}; }
  async discardSwitch(o = {}) { this.calls.push(['discard', o.prepared !== false, o.kept !== false]); if (o.prepared !== false) this.prepared = null; if (o.kept !== false) this.kept = null; }
  /** the calls of one kind */
  did(kind) { return this.calls.filter((c) => c[0] === kind); }
}

export function fakeCam({ fps = 30, max = 30 } = {}) {
  const cam = {
    video: { readyState: 4, videoWidth: 640, videoHeight: 480 }, stream: null, kind: 'camera', label: 'cam', width: 640, height: 480, deviceId: 'd',
    frameRate: fps, maxFrameRate: max, rates: [],
    async setFrameRate(f) { cam.rates.push(f); cam.frameRate = f; return f; },
    stop() {},
  };
  return cam;
}

export async function govHub({ model, cam = fakeCam(), tuning = {}, Tracker = GovTracker } = {}) {
  const bus = new EventBus();
  let opened = null;
  const hub = new InputHub({
    bus, mode: InputMode.CAMERA, players: 1, ...(model ? { model } : {}), tuning,
    deps: { GestureRecognizer: FakeRecognizer, PoseTracker: Tracker, openCamera: async (o) => { opened = o; return cam; } },
  });
  const r = await hub.start();
  assert(r.ok, JSON.stringify(r));
  return { hub, bus, t: GovTracker.made, cam, opened: () => opened };
}

/** A plausible upper body (the assigner claims a slot for it; tests/unit/input-hub.test.mjs has the same figure). */
export function person({ x = 0.5, y = 0.42, sw = 0.22, vis = 0.95, t = 0 } = {}) {
  const ya = 1 / 0.75;
  const w = 0.35 * Math.sin(t / 260); // the hands move: a still figure would be taken for a poster
  const P = (dx, dy, v = vis) => ({ x: x + dx * sw, y: y + dy * sw * ya, z: 0, visibility: v });
  const L = [];
  L[0] = P(0, -0.55);
  for (let i = 1; i <= 10; i++) L[i] = P((i <= 3 || i === 7 || i === 9 ? 0.1 : -0.1), -0.6);
  L[11] = P(0.5, 0); L[12] = P(-0.5, 0);
  L[13] = P(0.62, 0.62); L[14] = P(-0.62, 0.62);
  L[15] = P(0.25, -0.25 + w); L[16] = P(-0.25, -0.25 - w);
  for (let i = 17; i <= 22; i++) L[i] = P(i % 2 ? 0.25 : -0.25, -0.3 + (i % 2 ? w : -w));
  L[23] = P(0.3, 1.45); L[24] = P(-0.3, 1.45);
  for (let i = 25; i < 33; i++) L[i] = P(i % 2 ? 0.3 : -0.3, 2.4, 0.2);
  return { image: L, world: L.map(() => ({ x: 0, y: 0, z: 0, visibility: vis })), score: vis };
}

/** Run the hub from t0 for ms (an update every 50 ms, a pose frame with the (moving) player each time). */
export function run(hub, t, t0, ms, players = null) {
  let now = t0;
  for (; now <= t0 + ms; now += 50) {
    t.queue.push({ t: now - 30, width: 640, height: 480, players: players || [person({ t: now })], timing: { latencyMs: 30, captureTime: now - 30, arrivedTime: now - 5, source: 'capture' } });
    hub.update(now);
  }
  return now;
}

/** The player tracked (the assigner claims the slot, the debounce finds them), then the activity pose budget. */
export async function intoActivity(hub, t, now = 0) {
  now = run(hub, t, now, 800);
  hub.setActivityMode(true);
  await Promise.resolve();
  return run(hub, t, now, 100);
}

/** Let promise chains (prepare / commit / revert) settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
