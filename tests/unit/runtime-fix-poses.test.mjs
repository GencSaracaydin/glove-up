// PERF-02 regression: MediaPipe looks for `players + 1` people on setup (camera check, calibration)
// and for `players` during activities (bout, drill, tutorial); the extra pose comes back while a
// player is missing, and stays when other people are in view. Switches happen only on transitions
// (each one restarts MediaPipe's graph, ≈240 ms), never per frame.
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { InputHub, HUB_TUNING } from '../../src/input/input-hub.js';

class FakeRecognizer {
  update(pose) { return { control: neutralControl({ tracked: !!pose }), events: [] }; }
  setCalibration() {}
  reset() {}
}
class FakeCalibration { update() { return { step: 'frame', progress: 0, message: '', ok: false, done: false, result: null }; } }

/** Tracker stub: detect() hands out queued frames; setNumPoses is recorded. */
function trackerClass() {
  const made = [];
  class StubTracker {
    constructor(o) { Object.assign(this, { model: o.model, requestedDelegate: o.delegate, numPoses: o.numPoses, delegate: 'GPU', error: null, queue: [], calls: [] }); made.push(this); }
    async init() { return {}; }
    detect() { return this.queue.shift() || null; }
    async setNumPoses(n) { this.calls.push(n); this.numPoses = n; }
    getStats() { return { delegate: 'GPU', detectMs: 10, detectMsP95: 12, numPoses: this.numPoses, fallbackReason: null, detector: 'main' }; }
    close() { this.closed = true; }
  }
  return { StubTracker, made };
}

const ASPECT = 0.75;
function person({ x = 0.5, y = 0.42, sw = 0.22, vis = 0.95, t = 0 } = {}) {
  const ya = 1 / ASPECT;
  const w = 0.35 * Math.sin(t / 260);
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
const frame = (t, players) => ({ t, width: 640, height: 480, players });

async function cameraHub({ players = 1, bus = new EventBus(), ...extra } = {}) {
  const { StubTracker, made } = trackerClass();
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
  const cam = { video, stream: null, kind: 'camera', label: 'cam', width: 640, height: 480, deviceId: 'x', stop() {} };
  const hub = new InputHub({ bus, mode: InputMode.CAMERA, players, deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration, PoseTracker: StubTracker, openCamera: async () => cam }, ...extra });
  const r = await hub.start();
  assert(r.ok, JSON.stringify(r));
  return { hub, bus, tracker: made[0], made };
}

/** Run the app loop: a camera frame every 33 ms (poseFn(t) → players array, or undefined for none), update every 16 ms. */
function run(hub, tracker, from, to, poseFn) {
  let next = from;
  for (let t = from; t <= to; t += 16) {
    if (t >= next) { const ps = poseFn(t); if (ps !== undefined) tracker.queue.push(frame(t, ps)); next += 33; }
    hub.update(t);
  }
}

test('PERF-02: setup tracks players + 1, an activity tracks players, setup again → players + 1', async () => {
  const { hub, tracker } = await cameraHub();
  assert(tracker.numPoses === 2 && hub.status.poseMode === 'setup', `setup: ${tracker.numPoses}`);
  run(hub, tracker, 0, 1000, (t) => [person({ t })]);
  hub.setActivityMode(true);
  assert(tracker.numPoses === 1 && hub.status.numPoses === 1 && hub.status.poseMode === 'activity', `activity: ${tracker.numPoses}`);
  hub.setActivityMode(false);
  assert(tracker.numPoses === 2, `setup again: ${tracker.numPoses}`);
  assert.deepEqual(tracker.calls, [1, 2], 'one setNumPoses per transition');
});

test('PERF-02: the hub follows the bus — VS card / bout intro / drill start → players; camera check / calibration → players + 1', async () => {
  const { hub, bus, tracker } = await cameraHub();
  run(hub, tracker, 0, 800, (t) => [person({ t })]);
  bus.emit(Ev.APP_SCREEN, { screen: 'opponent' });
  assert(tracker.numPoses === 1, 'VS card');
  bus.emit(Ev.MATCH_INTRO, { p1Name: 'a', p2Name: 'b' });
  assert(tracker.numPoses === 1 && tracker.calls.length === 1, 'the bout intro after the VS card does not switch again');
  bus.emit(Ev.APP_SCREEN, { screen: 'camera-setup' });
  assert(tracker.numPoses === 2, 'camera check');
  bus.emit(Ev.TRAIN_START, { kind: 'bag' });
  assert(tracker.numPoses === 1, 'drill');
  bus.emit(Ev.APP_SCREEN, { screen: 'calibrate' });
  assert(tracker.numPoses === 2, 'calibration');
  bus.emit(Ev.MATCH_INTRO, {});
  assert(tracker.numPoses === 1, 'direct bout (no VS card)');
  bus.emit(Ev.APP_SCREEN, { screen: 'results' });
  bus.emit(Ev.APP_SCREEN, { screen: 'mode' });
  assert(tracker.numPoses === 1, 'menus after an activity keep the activity budget (no extra switch)');
  hub.calibrate(0);
  assert(tracker.numPoses === 2, 'hub.calibrate() is a setup step too');
});

test('PERF-02: versus — 3 poses on setup, 2 in the bout', async () => {
  const { hub, tracker } = await cameraHub({ players: 2 });
  assert(tracker.numPoses === 3);
  run(hub, tracker, 0, 800, (t) => [person({ x: 0.3, t }), person({ x: 0.7, t })]);
  hub.setActivityMode(true);
  assert(tracker.numPoses === 2, `versus bout: ${tracker.numPoses}`);
  hub.setPlayers(1);
  assert(tracker.numPoses === 1, 'back to one player during an activity budget');
});

test('PERF-02: a steady activity never re-switches (no per-frame setOptions)', async () => {
  const { hub, tracker } = await cameraHub();
  run(hub, tracker, 0, 800, (t) => [person({ t })]);
  hub.setActivityMode(true);
  run(hub, tracker, 816, 8000, (t) => [person({ t })]);
  assert.deepEqual(tracker.calls, [1], `calls ${JSON.stringify(tracker.calls)}`);
  assert(hub.status.tracking[0] && hub.status.numPoses === 1);
});

test('PERF-02: a player missing mid-activity brings the extra pose back until they are found again', async () => {
  const { hub, tracker } = await cameraHub();
  run(hub, tracker, 0, 800, (t) => [person({ t })]);
  hub.setActivityMode(true);
  run(hub, tracker, 816, 2000, (t) => [person({ t })]);
  assert(tracker.numPoses === 1);
  run(hub, tracker, 2016, 3200, () => []); // the player walks out
  assert(!hub.status.tracking[0] && hub.status.searching && tracker.numPoses === 2, `searching with ${tracker.numPoses}`);
  run(hub, tracker, 3216, 4400, (t) => [person({ t })]); // back
  assert(hub.status.tracking[0] && !hub.status.searching && tracker.numPoses === 1, `found → ${tracker.numPoses}`);
  assert.deepEqual(tracker.calls, [1, 2, 1]);
});

test('PERF-02: other people in view keep the extra pose for the activity (no lock-on to a poster)', async () => {
  // before the activity: a bystander next to the player
  const a = await cameraHub();
  run(a.hub, a.tracker, 0, 1500, (t) => [person({ t }), person({ x: 0.85, sw: 0.12, t: t * 0.3 })]);
  a.hub.setActivityMode(true);
  assert(a.tracker.numPoses === 2 && a.hub.status.poseMode === 'activity', `crowded at start: ${a.tracker.numPoses}`);
  // long ago (beyond othersMemoryMs) does not count
  const b = await cameraHub();
  run(b.hub, b.tracker, 0, 1500, (t) => [person({ t }), person({ x: 0.85, sw: 0.12, t: t * 0.3 })]);
  run(b.hub, b.tracker, 1516, 1516 + HUB_TUNING.othersMemoryMs + 500, (t) => [person({ t })]);
  b.hub.setActivityMode(true);
  assert(b.tracker.numPoses === 1, `others seen ${HUB_TUNING.othersMemoryMs} ms ago: ${b.tracker.numPoses}`);
  // seen while searching for a missing player: stay at players + 1 for the rest of the activity.
  // Pre-assigned frames say exactly who the assigner picked (slot) and who it ignored (the poster).
  const poster = person({ x: 0.9, sw: 0.1 });
  const assigned = (from, to, fn) => {
    for (let t = from; t <= to; t += 16) {
      if (t % 32 === 0) b.hub.injectFrames([{ t, width: 640, height: 480, ...fn(t) }], { assigned: true });
      b.hub.update(t);
    }
  };
  assigned(20000, 21200, () => ({ players: [null], ignored: [poster] })); // the player left, only the poster is there
  assert(!b.hub.status.tracking[0] && b.hub.status.searching && b.tracker.numPoses === 2, `searching: ${b.tracker.numPoses}`);
  assigned(21216, 23000, (t) => ({ players: [person({ t })], ignored: [poster] })); // back, next to the poster
  assert(b.hub.status.tracking[0] && b.tracker.numPoses === 2, `crowded after the search: ${b.tracker.numPoses}`);
  assigned(23016, 30000, (t) => ({ players: [person({ t })], ignored: [] }));
  assert(b.tracker.numPoses === 2, 'crowded is kept for the rest of the activity');
  b.hub.setActivityMode(false);
  assigned(30016, 30000 + HUB_TUNING.othersMemoryMs + 500, (t) => ({ players: [person({ t })], ignored: [] }));
  b.hub.setActivityMode(true);
  assert(b.tracker.numPoses === 1, 'the next activity starts lean again once nobody else was seen for a while');
  // a missing player alone (nobody else) → back to players once found (no crowding)
  assigned(40000, 41200, () => ({ players: [null], ignored: [] }));
  assert(b.tracker.numPoses === 2);
  assigned(41216, 42400, (t) => ({ players: [person({ t })], ignored: [] }));
  assert(b.tracker.numPoses === 1, `found alone → ${b.tracker.numPoses}`);
});

test('PERF-02: the frame gap of a numPoses switch (MediaPipe restarting) is not a lost player', async () => {
  const bus = new EventBus();
  const lost = [];
  bus.on(Ev.INPUT_TRACKING_LOST, (p) => lost.push(p));
  const { hub, tracker } = await cameraHub({ bus });
  run(hub, tracker, 0, 1000, (t) => [person({ t })]);
  // the restart takes 1.4 s here (a slow machine): setOptions resolves late, no frame meanwhile
  let resolve;
  tracker.setNumPoses = (n) => { tracker.calls.push(n); tracker.numPoses = n; return new Promise((r) => { resolve = r; }); };
  hub.setActivityMode(true);
  run(hub, tracker, 1016, 2400, () => undefined);
  resolve();
  await Promise.resolve();
  run(hub, tracker, 2416, 3000, (t) => [person({ t })]);
  assert(lost.length === 0 && hub.status.tracking[0], `no LOST across the switch (${lost.length})`);
  // but a camera that really stops after a switch is still noticed (poseSwitchGraceMs)
  hub.setActivityMode(false);
  resolve();
  await Promise.resolve();
  run(hub, tracker, 3016, 3016 + HUB_TUNING.poseSwitchGraceMs + HUB_TUNING.lostMs + 400, () => undefined);
  assert(lost.length === 1 && !hub.status.tracking[0], 'frozen camera after a switch → LOST');
});

test('PERF-02: an activity that starts before the player is found keeps looking (no switch there and back)', async () => {
  const { hub, tracker } = await cameraHub();
  hub.update(0);
  hub.setActivityMode(true);
  assert(hub.status.searching && tracker.numPoses === 2 && tracker.calls.length === 0, `no switch yet: ${JSON.stringify(tracker.calls)}`);
  run(hub, tracker, 16, 1200, (t) => [person({ t })]);
  assert(hub.status.tracking[0] && tracker.numPoses === 1 && tracker.calls.join() === '1', `one switch once found: ${JSON.stringify(tracker.calls)}`);
});

test('PERF-02: keyboard mode and synthetic (no tracker) are unaffected; autoActivity:false ignores the bus', async () => {
  const bus = new EventBus();
  const kb = new InputHub({ bus, mode: InputMode.KEYBOARD, deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration } });
  await kb.start();
  bus.emit(Ev.APP_SCREEN, { screen: 'opponent' });
  kb.update(0);
  assert(kb.status.phase === 'running' && kb.status.poseMode === 'activity');
  const { hub, tracker, bus: b2 } = await cameraHub({ autoActivity: false });
  b2.emit(Ev.APP_SCREEN, { screen: 'opponent' });
  assert(tracker.numPoses === 2 && hub.status.poseMode === 'setup');
});
