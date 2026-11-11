// FLOWS-02 / INPUT-11 regression:
//  * a camera that ends (or stays muted) mid-activity puts the hub in phase 'error' with a "Try again"
//    help; start() again returns to 'running' with the same tracker and the same player slots; a
//    track that unmutes by itself recovers without start(); an ended track without an 'ended' event
//    is still noticed;
//  * errors say what failed: source 'camera' | 'tracker', a player-facing title, no npm commands for
//    players (the developer hint goes to the console once).
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, InputMode } from '../../src/core/types.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { InputHub } from '../../src/input/input-hub.js';
import { openCamera, describeCameraError, cameraStoppedError, CameraError, CameraErrorCode, CAMERA_ERROR_TITLES } from '../../src/input/camera.js';
import { TrackerError, SETUP_DEV_HINT } from '../../src/input/pose-tracker.js';

class FakeRecognizer { update(pose) { return { control: neutralControl({ tracked: !!pose }), events: [] }; } setCalibration() {} reset() {} }

function person(x = 0.5, t = 0) {
  const sw = 0.22, ya = 4 / 3, w = 0.35 * Math.sin(t / 260);
  const P = (dx, dy, v = 0.95) => ({ x: x + dx * sw, y: 0.42 + dy * sw * ya, z: 0, visibility: v });
  const L = [];
  L[0] = P(0, -0.55);
  for (let i = 1; i <= 10; i++) L[i] = P((i <= 3 || i === 7 || i === 9 ? 0.1 : -0.1), -0.6);
  L[11] = P(0.5, 0); L[12] = P(-0.5, 0); L[13] = P(0.62, 0.62); L[14] = P(-0.62, 0.62);
  L[15] = P(0.25, -0.25 + w); L[16] = P(-0.25, -0.25 - w);
  for (let i = 17; i <= 22; i++) L[i] = P(i % 2 ? 0.25 : -0.25, -0.3 + (i % 2 ? w : -w));
  L[23] = P(0.3, 1.45); L[24] = P(-0.3, 1.45);
  for (let i = 25; i < 33; i++) L[i] = P(i % 2 ? 0.3 : -0.3, 2.4, 0.2);
  return { image: L, world: L.map(() => ({ x: 0, y: 0, z: 0, visibility: 0.95 })), score: 0.95 };
}

/** A hub on a stub tracker + fake openCamera that records its callbacks. */
function setup({ bus = new EventBus(), players = 1 } = {}) {
  const made = [];
  class StubTracker {
    constructor(o) { Object.assign(this, { model: o.model, requestedDelegate: o.delegate, numPoses: o.numPoses, delegate: 'GPU', error: null, queue: [], rewatched: 0 }); made.push(this); }
    async init() { return {}; }
    detect() { return this.queue.shift() || null; }
    rewatch() { this.rewatched++; }
    async setNumPoses(n) { this.numPoses = n; }
    getStats() { return { delegate: 'GPU', detectMs: 9, detectMsP95: 9, numPoses: this.numPoses, detector: 'worker' }; }
    close() { this.closed = true; }
  }
  const cams = [];
  const openCamera = async (opts) => {
    const cam = { video: { readyState: 4, videoWidth: 640, videoHeight: 480 }, stream: null, kind: 'camera', label: `cam${cams.length + 1}`, width: 640, height: 480, deviceId: 'x', opts, stopped: false,
      ended: false, stop() { this.stopped = true; }, isEnded() { return this.ended && !this.stopped; }, endedError: () => cameraStoppedError() };
    cams.push(cam);
    return cam;
  };
  const hub = new InputHub({ bus, mode: InputMode.CAMERA, players, deps: { GestureRecognizer: FakeRecognizer, PoseTracker: StubTracker, openCamera } });
  const run = (from, to, poseFn) => {
    let next = from;
    for (let t = from; t <= to; t += 16) {
      const tr = made[made.length - 1];
      if (t >= next && tr) { const ps = poseFn(t); if (ps !== undefined) tr.queue.push({ t, width: 640, height: 480, players: ps }); next += 33; }
      hub.update(t);
    }
  };
  return { hub, bus, made, cams, run };
}

test('FLOWS-02: the camera ends mid-activity → phase error, "Try again" help; start() again → running, same tracker, same player slot', async () => {
  const bus = new EventBus();
  const errors = [];
  bus.on(Ev.INPUT_ERROR, (p) => errors.push(p));
  const { hub, made, cams, run } = setup({ bus });
  assert((await hub.start()).ok);
  run(0, 1200, (t) => [person(0.5, t)]);
  hub.setActivityMode(true);
  const slotBefore = hub.latestFrame().trackIds[0];
  assert(hub.status.tracking[0] && slotBefore != null);
  cams[0].opts.onEnded(cameraStoppedError()); // what camera.js reports when the track ends
  const st = hub.status;
  assert(st.phase === 'error' && st.errorSource === 'camera' && st.errorTitle === 'The camera stopped', JSON.stringify(st));
  assert(/Try again/.test(st.errorHelp) && !/Retry/.test(st.errorHelp), st.errorHelp);
  assert(errors.length === 1 && errors[0].source === 'camera' && errors[0].title === 'The camera stopped' && errors[0].code === 'aborted');
  made[0].queue.push({ t: 1300, width: 640, height: 480, players: [person(0.5, 1300)] });
  hub.update(1300);
  assert(made[0].queue.length === 1, 'no detection while the camera is gone');
  // the tracking-lost screen's "Try again"
  const r = await hub.start();
  assert(r.ok && hub.status.phase === 'running' && !hub.status.error, JSON.stringify(r));
  assert(cams.length === 2 && cams[0].stopped && !cams[1].stopped, 'the old stream is released, a new one opened');
  assert(made.length === 1 && made[0].rewatched >= 1, 'same tracker, re-attached to the new picture');
  made[0].queue.length = 0;
  run(1400, 2200, (t) => [person(0.52, t)]);
  assert(hub.status.tracking[0], 'tracked again');
  assert(hub.latestFrame().trackIds[0] === slotBefore, 'the player keeps their slot (assigner kept)');
  assert(hub.status.poseMode === 'activity', 'still the activity budget');
  // an ordinary (re)start, e.g. another camera picked, starts the assigner afresh
  await hub.start();
  run(2300, 3200, (t) => [person(0.5, t)]);
  assert(hub.latestFrame().trackIds[0] !== slotBefore, 'a fresh start re-assigns');
});

test('FLOWS-02: a muted track is an error until it unmutes (no start() needed); a silently ended track is noticed', async () => {
  const { hub, cams, run } = setup();
  await hub.start();
  run(0, 800, (t) => [person(0.5, t)]);
  cams[0].opts.onInterrupted(cameraStoppedError());
  assert(hub.status.phase === 'error' && /stopped sending video/.test(hub.status.error));
  cams[0].opts.onInterrupted(null);
  assert(hub.status.phase === 'running' && !hub.status.error, 'recovered by itself');
  run(816, 1600, (t) => [person(0.5, t)]);
  assert(hub.status.tracking[0]);
  // ended without an 'ended' event (stopped elsewhere): update() notices within cameraCheckMs
  cams[0].ended = true;
  run(1616, 1616 + hub.tuning.cameraCheckMs + 40, (t) => [person(0.5, t)]);
  assert(hub.status.phase === 'error' && hub.status.errorCode === 'aborted');
  const r = await hub.start();
  assert(r.ok && hub.status.phase === 'running' && cams.length === 2);
  // events from the old camera are ignored
  cams[0].opts.onEnded(cameraStoppedError());
  assert(hub.status.phase === 'running');
});

test('FLOWS-02: a tracker failure mid-activity is a tracker error; start() again builds a fresh tracker and runs', async () => {
  const { hub, made, run } = setup();
  await hub.start();
  run(0, 800, (t) => [person(0.5, t)]);
  made[0].error = new TrackerError('detect-failed', 'Pose tracking stopped working (WebGL context lost).', 'Reload the page.');
  hub.update(816);
  assert(hub.status.phase === 'error' && hub.status.errorSource === 'tracker' && hub.status.errorTitle === 'Pose tracking stopped');
  const r = await hub.start();
  assert(r.ok && hub.status.phase === 'running' && made.length === 2 && made[0].closed, 'the broken tracker is replaced');
  run(900, 1700, (t) => [person(0.5, t)]);
  assert(hub.status.tracking[0] && !hub.status.error);
});

test('INPUT-11: tracker failures are reported as tracker problems with a player title; the dev hint goes to the console once', async () => {
  const fail = new TrackerError('model-missing', 'This copy of the game is missing its pose model (/models/x.task, HTTP 404).',
    'Pose tracking can’t start without it. Reload the page, or choose Use keyboard instead.', undefined, { devHint: SETUP_DEV_HINT });
  class FailingTracker { constructor(o) { this.model = o.model; this.requestedDelegate = o.delegate; this.numPoses = o.numPoses; } async init() { throw fail; } close() {} }
  const bus = new EventBus();
  const errs = [];
  bus.on(Ev.INPUT_ERROR, (p) => errs.push(p));
  const cam = { video: { readyState: 4, videoWidth: 640, videoHeight: 480 }, stop() {} };
  const hub = new InputHub({ bus, mode: InputMode.CAMERA, deps: { GestureRecognizer: FakeRecognizer, PoseTracker: FailingTracker, openCamera: async () => cam } });
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = await hub.start();
    assert(!r.ok && r.code === 'model-missing' && r.source === 'tracker' && r.title === 'Pose model missing', JSON.stringify(r));
    const st = hub.status;
    assert(st.errorSource === 'tracker' && st.errorTitle === 'Pose model missing' && !/npm/.test(st.errorHelp));
    assert(errs[0].source === 'tracker' && errs[0].title === 'Pose model missing');
    await hub.start();
    assert(warns.length === 1 && /npm run setup:models/.test(warns[0]), `dev hint logged once: ${JSON.stringify(warns)}`);
  } finally { console.warn = ow; }
  // the same code from the camera side keeps its own source
  const camErr = describeCameraError(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
  assert(camErr.code === 'unsupported' && camErr.source === 'camera' && camErr.title === CAMERA_ERROR_TITLES.unsupported);
  assert(new TrackerError('unsupported', 'x').title !== camErr.title, 'tracker "unsupported" ≠ camera "unsupported"');
});

test('camera: every help text names the screens’ "Try again" button (never "Retry"); errors carry source + title', () => {
  const names = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'NotSupportedError', 'AbortError', 'Whatever'];
  for (const n of names) {
    for (const msg of ['', 'Permission denied by system']) {
      const e = describeCameraError(Object.assign(new Error(msg), { name: n }));
      assert(!/Retry/.test(e.help), `${n}: "${e.help}"`);
      assert(e.source === 'camera' && typeof e.title === 'string' && e.title.length > 3, `${n} title`);
    }
  }
  const stopped = cameraStoppedError();
  assert(stopped instanceof CameraError && stopped.code === CameraErrorCode.ABORTED && /Try again/.test(stopped.help));
});

// ───────────────────────────── camera.js: mute / unmute / silent end ─────────────────────────────

function fakeStream() {
  const listeners = {};
  const track = {
    label: 'Fake Cam', readyState: 'live', muted: false, stopped: false,
    stop() { this.stopped = true; this.readyState = 'ended'; },
    getSettings: () => ({ deviceId: 'dev-1', width: 640, height: 480, frameRate: 30 }),
    addEventListener(n, f) { (listeners[n] ||= []).push(f); },
    fire(n) { if (n === 'mute') this.muted = true; if (n === 'unmute') this.muted = false; (listeners[n] || []).forEach((f) => f()); },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function fakeVideo() {
  const ls = {};
  return {
    readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null, muted: false, playsInline: false, autoplay: false, paused: true,
    addEventListener(n, f) { (ls[n] ||= []).push(f); }, removeEventListener(n, f) { ls[n] = (ls[n] || []).filter((x) => x !== f); },
    pause() { this.paused = true; },
    async play() { this.paused = false; setTimeout(() => { this.readyState = 4; this.videoWidth = 640; this.videoHeight = 480; (ls.loadeddata || []).forEach((f) => f()); }, 2); },
  };
}
async function withMediaDevices(md, fn) {
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true });
  try { return await fn(); } finally {
    if (had) Object.defineProperty(globalThis.navigator, 'mediaDevices', had); else delete globalThis.navigator.mediaDevices;
    if (!hadNav) delete globalThis.navigator;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('camera: a track muted for mutedErrorMs reports onInterrupted(err), unmuting reports null; a brief mute reports nothing', async () => {
  const stream = fakeStream();
  await withMediaDevices({ getUserMedia: async () => stream }, async () => {
    const got = [];
    const cam = await openCamera({ video: fakeVideo(), mutedErrorMs: 20, onInterrupted: (e) => got.push(e) });
    stream.track.fire('mute');
    await wait(5);
    stream.track.fire('unmute');
    await wait(30);
    assert(got.length === 0, 'a short hiccup is not an error');
    stream.track.fire('mute');
    await wait(35);
    assert(got.length === 1 && got[0] instanceof CameraError && got[0].code === 'aborted' && /Try again/.test(got[0].help));
    stream.track.fire('unmute');
    assert(got.length === 2 && got[1] === null, 'frames are back');
    cam.stop();
    stream.track.fire('mute');
    await wait(35);
    assert(got.length === 2, 'nothing after a deliberate stop');
  });
});

test('camera: isEnded() spots a track that ended without an event, but not our own stop()', async () => {
  const stream = fakeStream();
  await withMediaDevices({ getUserMedia: async () => stream }, async () => {
    const cam = await openCamera({ video: fakeVideo() });
    assert(cam.isEnded() === false);
    stream.track.readyState = 'ended';
    assert(cam.isEnded() === true && cam.endedError().code === 'aborted');
    cam.stop();
    assert(cam.isEnded() === false, 'stopped on purpose');
  });
});
