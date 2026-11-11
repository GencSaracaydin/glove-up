// InputHub: injectFrames → assigner → recognizer → events exactly once, debounced tracking
// events, keyboard/replay modes, calibration binding, recorder, camera start errors.
// Gesture/calibration are replaced by deterministic fakes via `deps` (their own tests live with
// the gesture module). Plain static imports only: `npm test` must run on every Node the README
// supports (a named `registerHooks` import broke the whole run on Node < 22.15, RELEASE-04).
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { encodeRecording, decodeRecording } from '../../src/input/recorder.js';
import { CameraError } from '../../src/input/camera.js';
import { InputHub, HUB_TUNING, BoundCalibration } from '../../src/input/input-hub.js';

// ───────────────────────────── fakes ─────────────────────────────

class FakeRecognizer {
  constructor(opts) { this.opts = opts; this.calibration = opts.calibration; this.calls = []; FakeRecognizer.last = this; (FakeRecognizer.all ||= []).push(this); }
  update(pose, t) {
    this.calls.push({ pose, t });
    const control = { ...neutralControl({ tracked: !!pose }), who: pose ? pose.who : null };
    // punch marker: a `punch` field (live injection) or score 0.777 (survives a recording round trip)
    const hand = pose && (pose.punch || (Math.abs(pose.score - 0.777) < 1e-6 ? 'left' : null));
    const events = hand ? [{ type: 'punch', t, punch: { hand, kind: 'straight', target: 'head', power: 0.9, t } }] : [];
    return { control, events };
  }
  setCalibration(c) { this.calibration = c; }
  reset() { this.resetCalled = true; }
}

class FakeCalibration {
  constructor(opts) { this.opts = opts; this.n = 0; FakeCalibration.last = this; }
  update(pose, t) {
    if (pose) this.n++;
    const done = this.n >= 10;
    return { step: done ? 'done' : 'guard', progress: Math.min(1, this.n / 10), message: 'hold still', ok: !!pose, done,
      result: done ? { version: 1, shoulderWidth: 0.22, armLengthWorld: 0.6, neutralHead: { x: 0.5, y: 0.3 }, neutralShoulderY: 0.45, swapSides: false, createdAt: t } : null };
  }
}

const ASPECT = 0.75;
function person({ x = 0.5, y = 0.42, sw = 0.22, vis = 0.95, t = 0, who = 'me', punch = null } = {}) {
  const ya = 1 / ASPECT;
  const w = 0.35 * Math.sin(t / 260);
  const P = (dx, dy, v = vis) => ({ x: x + dx * sw, y: y + dy * sw * ya, z: 0, visibility: v });
  const L = [];
  L[0] = P(0, -0.55);
  for (let i = 1; i <= 10; i++) L[i] = P((i <= 3 || i === 7 || i === 9 ? 0.1 : -0.1), -0.6);
  L[7] = P(0.2, -0.58); L[8] = P(-0.2, -0.58);
  L[11] = P(0.5, 0); L[12] = P(-0.5, 0);
  L[13] = P(0.62, 0.62); L[14] = P(-0.62, 0.62);
  L[15] = P(0.25, -0.25 + w); L[16] = P(-0.25, -0.25 - w);
  for (let i = 17; i <= 22; i++) L[i] = P(i % 2 ? 0.25 : -0.25, -0.3 + (i % 2 ? w : -w));
  L[23] = P(0.3, 1.45); L[24] = P(-0.3, 1.45);
  for (let i = 25; i < 33; i++) L[i] = P(i % 2 ? 0.3 : -0.3, 2.4, 0.2);
  return { image: L, world: L.map(() => ({ x: 0, y: 0, z: 0, visibility: vis })), score: vis, who, punch };
}
const frame = (t, players) => ({ t, width: 640, height: 480, players });

function makeHub(extra = {}) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, payload) => log.push({ name, payload }));
  FakeRecognizer.all = [];
  const hub = new InputHub({ bus, mode: InputMode.CAMERA, players: 1, deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration }, ...extra });
  return { hub, bus, log };
}
const count = (log, name) => log.filter((e) => e.name === name).length;

/** Simulate the app loop: frames at 30 fps (if poseFn returns non-undefined), update at 60 fps. */
function loop(hub, from, to, poseFn) {
  const outs = [];
  let nextFrame = from;
  for (let t = from; t <= to; t += 16) {
    if (t >= nextFrame) {
      const ps = poseFn(t);
      if (ps !== undefined) hub.injectFrames([frame(t, ps)]);
      nextFrame += 33;
    }
    outs.push({ t, ...hub.update(t) });
  }
  return outs;
}

// ───────────────────────────── tests ─────────────────────────────

test('hub: injected frames reach the recognizer; each event is returned exactly once', () => {
  const { hub, log } = makeHub();
  for (let t = 0; t < 200; t += 33) hub.injectFrames([frame(t, [person({ t })])]);
  hub.injectFrames([frame(231, [person({ t: 231, punch: 'left' })])]);
  const a = hub.update(240);
  assert(a.players.length === 1 && a.players[0].events.length === 1, `events ${a.players[0].events.length}`);
  assert(a.players[0].events[0].punch.hand === 'left');
  assert(a.players[0].control.who === 'me', 'control comes from the recognizer');
  assert(hub.update(256).players[0].events.length === 0, 'returned once only');
  assert(count(log, Ev.INPUT_PUNCH) === 1 && log.find((e) => e.name === Ev.INPUT_PUNCH).payload.player === 0);
  assert(hub.latestFrame().players[0].who === 'me');
});

test('hub: events from several frames between two updates are all delivered, in order', () => {
  const { hub } = makeHub();
  for (let t = 0; t < 200; t += 33) hub.injectFrames([frame(t, [person({ t })])]);
  hub.injectFrames([frame(231, [person({ t: 231, punch: 'left' })]), frame(264, [person({ t: 264, punch: 'right' })])]);
  const ev = hub.update(270).players[0].events;
  assert(ev.length === 2 && ev[0].punch.hand === 'left' && ev[1].punch.hand === 'right');
});

test('hub: tracking FOUND/LOST are debounced (≈300 ms / ≈600 ms) and fire once', () => {
  const { hub, log } = makeHub();
  const outs = loop(hub, 0, 1000, (t) => [person({ t })]);
  const foundAt = log.find((e) => e.name === Ev.INPUT_TRACKING_FOUND);
  assert(foundAt && count(log, Ev.INPUT_TRACKING_FOUND) === 1, 'found once');
  const firstTracked = outs.find((o) => o.status.tracking[0]).t;
  assert(firstTracked >= HUB_TUNING.foundMs && firstTracked <= HUB_TUNING.foundMs + 150, `found at ${firstTracked}`);
  // a 300 ms dropout must not fire LOST
  loop(hub, 1016, 1316, () => []);
  loop(hub, 1332, 1800, (t) => [person({ t })]);
  assert(count(log, Ev.INPUT_TRACKING_LOST) === 0, 'short dropout fired LOST');
  // a real loss fires LOST once after ~600 ms
  const lost = loop(hub, 1816, 3000, () => []);
  assert(count(log, Ev.INPUT_TRACKING_LOST) === 1);
  const lostT = lost.find((o) => !o.status.tracking[0]).t - 1816;
  assert(lostT >= HUB_TUNING.lostMs && lostT <= HUB_TUNING.lostMs + 100, `lost after ${lostT}`);
  // and FOUND again when the player is back
  loop(hub, 3016, 3600, (t) => [person({ t })]);
  assert(count(log, Ev.INPUT_TRACKING_FOUND) === 2);
});

test('hub: frames that stop arriving (frozen camera) end in TRACKING_LOST', () => {
  const { hub, log } = makeHub();
  loop(hub, 0, 800, (t) => [person({ t })]);
  assert(hub.status.tracking[0]);
  const outs = loop(hub, 816, 2500, () => undefined); // no frames at all
  const lostAt = outs.find((o) => !o.status.tracking[0]);
  assert(lostAt && count(log, Ev.INPUT_TRACKING_LOST) === 1);
  assert(lostAt.t - 800 <= HUB_TUNING.staleFrameMs + HUB_TUNING.lostMs + 150, `lost after ${lostAt.t - 800}`);
  assert(FakeRecognizer.last.calls.some((c) => c.pose === null), 'recognizer was told the pose is gone');
});

test('hub: 2 players — P1 is the left of the mirrored preview; each recognizer gets its own pose', () => {
  const { hub, log } = makeHub({ players: 2 });
  let punched = false;
  const punchNow = (t) => (!punched && t >= 700 ? ((punched = true), 'right') : null);
  loop(hub, 0, 800, (t) => [person({ x: 0.3, t, who: 'rawLeft' }), person({ x: 0.7, t, who: 'rawRight', punch: punchNow(t) })]);
  const out = hub.update(816);
  assert(out.players.length === 2);
  assert(out.players[0].control.who === 'rawRight' && out.players[1].control.who === 'rawLeft', `${out.players[0].control.who} / ${out.players[1].control.who}`);
  assert(out.status.tracking[0] && out.status.tracking[1]);
  const punch = log.find((e) => e.name === Ev.INPUT_PUNCH);
  assert(punch && punch.payload.player === 0, 'P1 punch tagged player 0');
});

test('hub: keyboard mode — same output shape, tracked immediately, punch once on the bus', async () => {
  const { hub, log } = makeHub({ mode: InputMode.KEYBOARD });
  const r = await hub.start();
  assert(r.ok && hub.status.phase === 'running');
  const first = hub.update(0);
  assert(first.status.tracking[0] && count(log, Ev.INPUT_TRACKING_FOUND) === 1);
  hub.keyboard.handleKey('KeyK', true, { t: 5 });
  const out = hub.update(16);
  assert(out.players[0].events.length === 1 && out.players[0].events[0].punch.hand === 'right');
  assert(hub.update(32).players[0].events.length === 0);
  assert(count(log, Ev.INPUT_PUNCH) === 1);
  hub.stop();
  assert(hub.status.phase === 'stopped');
});

test('hub: calibrate(i) is fed by that player, applies the result when done, no double feeding', () => {
  const { hub } = makeHub();
  loop(hub, 0, 200, (t) => [person({ t })]);
  const cal = hub.calibrate(0);
  assert(cal instanceof BoundCalibration && cal.state.done === false);
  let st = null;
  const outs = loop(hub, 216, 900, (t) => [person({ t })]);
  for (const o of outs) st = cal.update(hub.latestFrame().players[0], o.t); // UI polling every tick
  assert(st.done && cal.done && cal.result && cal.result.shoulderWidth === 0.22);
  assert(FakeCalibration.last.n === 10, `session fed ${FakeCalibration.last.n} times (no double feeding)`);
  assert(FakeRecognizer.last.calibration === cal.result, 'result applied to the recognizer');
  assert(hub.profiles[0].calibration === cal.result);
});

test('hub: replay mode plays a recording through the full pipeline in real time', async () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push(frame(5000 + i * 33, [person({ t: i * 33, vis: i === 20 ? 0.777 : 0.95 })]));
  const rec = decodeRecording(encodeRecording({ frames }));
  const { hub } = makeHub();
  const r = await hub.replay(rec, { loop: false });
  assert(r.ok && hub.mode === InputMode.REPLAY && hub.status.replaying);
  let events = 0, tracked = false;
  for (let t = 100000; t <= 101600; t += 16) {
    const o = hub.update(t);
    events += o.players[0].events.length;
    tracked = tracked || o.status.tracking[0];
  }
  assert(events === 1 && tracked, `events ${events}, tracked ${tracked}`);
});

test('hub: recorder captures RAW frames (detection order) while recording', () => {
  const { hub } = makeHub({ players: 2 });
  hub.recorder.start();
  loop(hub, 0, 300, (t) => [person({ x: 0.3, t, who: 'b' }), person({ x: 0.7, t, who: 'a' })]);
  const rec = hub.recorder.stop();
  assert(rec.frames.length >= 9 && rec.frames[0].players.length === 2);
  assert(rec.frames[0].players[0].image[11].x < 0.5, 'stored in detection order, not slot order');
});

test('hub: realtime injection schedules frames by their relative time', () => {
  const { hub } = makeHub();
  const frames = [];
  for (let i = 0; i < 30; i++) frames.push(frame(i * 33, [person({ t: i * 33, punch: i === 29 ? 'right' : null })]));
  hub.injectFrames(frames, { realtime: true });
  let events = 0;
  hub.update(10000);
  assert(FakeRecognizer.last.calls.length === 1, 'only the first frame is due immediately');
  for (let t = 10016; t <= 11200; t += 16) events += hub.update(t).players[0].events.length;
  assert(events === 1 && FakeRecognizer.last.calls.length >= 30);
});

test('hub: pre-assigned injection skips the assigner', () => {
  const { hub } = makeHub({ players: 2 });
  hub.injectFrames([frame(0, [person({ x: 0.3, who: 'first' }), person({ x: 0.7, who: 'second' })])], { assigned: true });
  const f = hub.latestFrame();
  assert(f.players[0].who === 'first' && f.players[1].who === 'second');
});

test('hub: camera errors are reported readably (status, return value, INPUT_ERROR)', async () => {
  class OkTracker { constructor(o) { this.model = o.model; this.requestedDelegate = o.delegate; this.numPoses = o.numPoses; } async init() { return {}; } getStats() { return { delegate: 'CPU', detectMs: 0, detectMsP95: 0, numPoses: this.numPoses, fallbackReason: null }; } close() {} async setNumPoses(n) { this.numPoses = n; } }
  const denied = new CameraError('denied', 'Camera access was blocked for this page.', 'Allow it in the address bar.');
  const { hub, log } = makeHub({ deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration, PoseTracker: OkTracker, openCamera: async () => { throw denied; } } });
  const r = await hub.start();
  assert(!r.ok && r.code === 'denied' && /blocked/.test(r.error) && r.help);
  const st = hub.status;
  assert(st.phase === 'error' && st.error === denied.message && st.errorHelp && st.errorCode === 'denied');
  const ev = log.find((e) => e.name === Ev.INPUT_ERROR);
  assert(ev && ev.payload.message === denied.message);
  const u = hub.update(0);
  assert(u.players[0].control.tracked === false && u.players[0].events.length === 0, 'safe neutral output while broken');
});

test('hub: camera mode runs tracker.detect on update and reports delegate/fps/detect ms', async () => {
  const queue = [];
  class QTracker {
    constructor(o) { this.model = o.model; this.requestedDelegate = o.delegate; this.numPoses = o.numPoses; this.delegate = 'CPU'; QTracker.made = this; }
    async init() { return {}; }
    detect() { return queue.shift() || null; }
    getStats() { return { delegate: 'CPU', detectMs: 12.5, detectMsP95: 20, numPoses: this.numPoses, fallbackReason: 'GPU unavailable (test)' }; }
    close() { this.closed = true; }
    async setNumPoses(n) { this.numPoses = n; }
  }
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
  const cam = { video, stream: null, kind: 'camera', label: 'Fake cam', width: 640, height: 480, deviceId: 'x', stop() { this.stopped = true; } };
  const { hub } = makeHub({ deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration, PoseTracker: QTracker, openCamera: async () => cam } });
  const r = await hub.start();
  assert(r.ok && r.delegate === 'CPU' && hub.video === video);
  assert(QTracker.made.numPoses === 2, '1 player + 1 extra pose so posters can be rejected');
  for (let t = 0; t <= 1000; t += 16) {
    if (t % 32 === 0) queue.push(frame(t, [person({ t })]));
    hub.update(t);
  }
  const st = hub.status;
  assert(st.delegate === 'CPU' && st.detectMs === 12.5 && st.fps > 25 && st.fps < 35, JSON.stringify(st));
  assert(st.camera.label === 'Fake cam' && st.tracking[0]);
  hub.setPlayers(2);
  assert(QTracker.made.numPoses === 3);
  hub.stop();
  assert(cam.stopped && QTracker.made.closed);
});

test('hub: keyboard assist adds key punches and overrides lean in camera mode', () => {
  const target = { addEventListener() {}, removeEventListener() {} };
  const { hub } = makeHub({ keyboardAssist: true, keyboardTarget: target });
  hub._phase = 'running'; // camera started (no real camera in Node)
  hub._attachKeyboard();
  loop(hub, 0, 300, (t) => [person({ t })]);
  hub.keyboard.handleKey('KeyJ', true, { t: 310 });
  hub.keyboard.handleKey('KeyA', true, { t: 310 });
  let ev = 0, lean = 0;
  for (const o of loop(hub, 316, 700, (t) => [person({ t })])) { ev += o.players[0].events.length; lean = o.players[0].control.lean.x; }
  assert(ev === 1 && lean < -0.9, `events ${ev}, lean ${lean}`);
});

test('hub: setCalibration reaches the recognizer; setProfiles recreates it with the new calibration', () => {
  const { hub } = makeHub();
  hub.injectFrames([frame(0, [person()])]);
  const cal = { version: 1, shoulderWidth: 0.2 };
  hub.setCalibration(0, cal);
  assert(FakeRecognizer.last.calibration === cal);
  const first = FakeRecognizer.last, cal2 = { version: 1, shoulderWidth: 0.25 };
  hub.setProfiles([{ calibration: cal2 }]);
  hub.injectFrames([frame(33, [person({ t: 33 })])]);
  assert(FakeRecognizer.last !== first && FakeRecognizer.last.opts.calibration === cal2, 'recreated with the new calibration');
  assert.deepEqual(hub.profiles, [{ calibration: cal2 }, { calibration: null }]);
});

test('hub + real GestureRecognizer: synthetic punches come out once each, in order', async () => {
  let GR = null, synth = null;
  try { ({ GestureRecognizer: GR } = await import('../../src/input/gesture.js')); synth = await import('../../src/input/synthetic.js'); } catch { /* not available yet */ }
  if (!GR || !synth || !GR.prototype || typeof GR.prototype.update !== 'function') return;
  const seq = synth.sequence([{ action: 'guard-high', ms: 1500 }, { action: 'jab-left', ms: 700 }, { action: 'guard-high', ms: 600 },
    { action: 'jab-right', ms: 700 }, { action: 'guard-high', ms: 600 }, { action: 'body-left', ms: 700 }, { action: 'guard-high', ms: 800 }]);
  const { frames } = synth.makeSyntheticPlayer({ seed: 3, noise: 0.5 }).run(seq, { startMs: 1000 });
  const bus = new EventBus();
  let busPunches = 0;
  bus.on(Ev.INPUT_PUNCH, () => busPunches++);
  const hub = new InputHub({ bus, deps: { GestureRecognizer: GR, CalibrationSession: FakeCalibration } });
  const got = [];
  let fi = 0;
  for (let t = 1000; t <= frames[frames.length - 1].t + 200; t += 16) {
    while (fi < frames.length && frames[fi].t <= t) hub.injectFrames([frames[fi++]]);
    for (const ev of hub.update(t).players[0].events) if (ev.type === 'punch') got.push(ev);
  }
  assert(got.length >= 2 && got.length <= 3, `punches: ${got.map((e) => e.punch.hand).join(',')}`);
  assert(got[0].punch.hand === 'left' && got[1].punch.hand === 'right', 'order/hands');
  assert(new Set(got).size === got.length && busPunches === got.length, 'each event exactly once (returned and on the bus)');
  assert(hub.status.tracking[0], 'synthetic player tracked');
});
