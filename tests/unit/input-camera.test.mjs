// camera.js: readable errors for every getUserMedia failure, constraint relaxation, clean stop,
// "camera unplugged" callback, clip playback — with fake mediaDevices / video elements.
import { test, assert } from '../harness.mjs';
import { openCamera, openVideoFile, listCameras, describeCameraError, CameraError, CameraErrorCode } from '../../src/input/camera.js';

const domErr = (name, message = '') => Object.assign(new Error(message || name), { name });

/** Minimal HTMLVideoElement stand-in: "decodes" a frame shortly after play(). */
function fakeVideo({ w = 640, h = 480, failPlay = null, neverLoads = false } = {}) {
  const listeners = {};
  const v = {
    readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null, src: '', muted: false, playsInline: false, autoplay: false, loop: false, playbackRate: 1,
    paused: true, attrs: {},
    addEventListener(n, f) { (listeners[n] ||= []).push(f); },
    removeEventListener(n, f) { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
    removeAttribute(n) { if (n === 'src') this.src = ''; },
    load() {}, pause() { this.paused = true; },
    async play() {
      if (failPlay) throw domErr(failPlay);
      this.paused = false;
      if (!neverLoads) setTimeout(() => { this.readyState = 4; this.videoWidth = w; this.videoHeight = h; (listeners.loadeddata || []).forEach((f) => f()); }, 5);
    },
  };
  return v;
}

function fakeStream(label = 'Fake Cam') {
  const trackListeners = {};
  const track = {
    label, stopped: false, kind: 'video',
    stop() { this.stopped = true; },
    getSettings: () => ({ deviceId: 'dev-1', width: 640, height: 480, frameRate: 30 }),
    addEventListener(n, f) { (trackListeners[n] ||= []).push(f); },
    fire(n) { (trackListeners[n] || []).forEach((f) => f()); },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

/**
 * Run fn with navigator.mediaDevices = md. Node only has a global `navigator` from v21 (README: Node
 * 20+), so one is created for the test when missing and removed again afterwards (RELEASE-M1).
 */
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

test('camera: every getUserMedia failure maps to a readable, actionable CameraError', () => {
  const cases = [
    ['NotAllowedError', CameraErrorCode.DENIED, /address bar|Allow/],
    ['PermissionDeniedError', CameraErrorCode.DENIED, /Allow/],
    ['NotFoundError', CameraErrorCode.NOT_FOUND, /Plug in|keyboard/],
    ['NotReadableError', CameraErrorCode.BUSY, /Close apps|video calls/],
    ['TrackStartError', CameraErrorCode.BUSY, /Close/],
    ['OverconstrainedError', CameraErrorCode.OVERCONSTRAINED, /different camera/],
    ['AbortError', CameraErrorCode.ABORTED, /Reconnect/],
    ['NotSupportedError', CameraErrorCode.UNSUPPORTED, /Allow the camera|keyboard/],
    ['WeirdError', CameraErrorCode.UNKNOWN, /Try again/],
  ];
  for (const [name, code, help] of cases) {
    const e = describeCameraError(domErr(name));
    assert(e instanceof CameraError && e.code === code, `${name} → ${e.code}`);
    assert(e.message.length > 10 && help.test(e.help), `${name}: "${e.help}"`);
    assert(e.fullMessage.includes(e.message) && e.fullMessage.includes(e.help));
  }
  const sys = describeCameraError(domErr('NotAllowedError', 'Permission denied by system'));
  assert(/System Settings|Privacy/.test(sys.help), 'OS-level block explains the system setting');
  const same = new CameraError('busy', 'x', 'y');
  assert(describeCameraError(same) === same);
});

test('camera: the tests also run without a global navigator (Node 20, RELEASE-M1)', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (had) delete globalThis.navigator;
  try {
    assert(typeof globalThis.navigator === 'undefined', 'navigator removed for this test');
    const stream = fakeStream();
    await withMediaDevices({ getUserMedia: async () => stream }, async () => {
      const cam = await openCamera({ video: fakeVideo() });
      assert(cam.label === 'Fake Cam');
      cam.stop();
    });
    assert(typeof globalThis.navigator === 'undefined', 'the helper cleans up the navigator it created');
    let err = null;
    try { await openCamera({ video: fakeVideo() }); } catch (e) { err = e; }
    assert(err && err.code === CameraErrorCode.UNSUPPORTED, 'no navigator at all → readable "unsupported"');
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
  }
});

test('camera: no mediaDevices → readable "unsupported" error; listCameras → []', async () => {
  await withMediaDevices(undefined, async () => {
    let err = null;
    try { await openCamera({ video: fakeVideo() }); } catch (e) { err = e; }
    assert(err && err.code === CameraErrorCode.UNSUPPORTED && /keyboard/.test(err.help));
    assert((await listCameras()).length === 0);
  });
});

test('camera: opens with ideal 640x480@30 user-facing constraints and stops cleanly', async () => {
  const calls = [];
  const stream = fakeStream();
  const md = { getUserMedia: async (c) => { calls.push(c); return stream; }, enumerateDevices: async () => [] };
  await withMediaDevices(md, async () => {
    const video = fakeVideo();
    const cam = await openCamera({ video });
    assert(calls.length === 1 && calls[0].audio === false);
    const v = calls[0].video;
    assert(v.width.ideal === 640 && v.height.ideal === 480 && v.frameRate.ideal === 30 && v.facingMode === 'user');
    assert(cam.video === video && video.srcObject === stream && video.muted && video.playsInline);
    assert(cam.width === 640 && cam.height === 480 && cam.label === 'Fake Cam' && cam.kind === 'camera' && cam.deviceId === 'dev-1');
    cam.stop();
    assert(stream.track.stopped && video.srcObject === null);
    cam.stop(); // idempotent
  });
});

test('camera: a picked device that is gone/over-constrained falls back to looser constraints', async () => {
  const calls = [];
  const stream = fakeStream('Any Cam');
  const md = {
    getUserMedia: async (c) => {
      calls.push(c);
      if (calls.length < 3) throw domErr('OverconstrainedError');
      return stream;
    },
  };
  await withMediaDevices(md, async () => {
    const cam = await openCamera({ deviceId: 'gone', video: fakeVideo() });
    assert(calls.length === 3 && calls[0].video.deviceId.exact === 'gone' && calls[2].video === true);
    assert(cam.label === 'Any Cam');
  });
});

test('camera: permission denied is not retried and surfaces the help text', async () => {
  let n = 0;
  const md = { getUserMedia: async () => { n++; throw domErr('NotAllowedError'); } };
  await withMediaDevices(md, async () => {
    let err = null;
    try { await openCamera({ video: fakeVideo() }); } catch (e) { err = e; }
    assert(n === 1 && err.code === CameraErrorCode.DENIED);
  });
});

test('camera: a stream that never shows a frame times out readably and releases the camera', async () => {
  const stream = fakeStream();
  const md = { getUserMedia: async () => stream };
  await withMediaDevices(md, async () => {
    let err = null;
    const orig = globalThis.setTimeout;
    globalThis.setTimeout = (f, ms) => orig(f, Math.min(ms, 20)); // speed up the 8 s first-frame wait
    try { await openCamera({ video: fakeVideo({ neverLoads: true }) }); } catch (e) { err = e; } finally { globalThis.setTimeout = orig; }
    assert(err && err.code === CameraErrorCode.NO_FRAMES && stream.track.stopped);
  });
});

test('camera: unplugging fires onEnded with a readable error (not after a deliberate stop)', async () => {
  const stream = fakeStream();
  const md = { getUserMedia: async () => stream };
  await withMediaDevices(md, async () => {
    const ended = [];
    const cam = await openCamera({ video: fakeVideo(), onEnded: (e) => ended.push(e) });
    stream.track.fire('ended');
    assert(ended.length === 1 && ended[0].code === CameraErrorCode.ABORTED && /unplugged/.test(ended[0].message));
    assert(/Try again/.test(ended[0].help) && !/Retry/.test(ended[0].help), `help names the screens' button: "${ended[0].help}"`);
    cam.stop();
    stream.track.fire('ended');
    assert(ended.length === 1);
  });
});

test('camera: listCameras names unlabeled devices and keeps only video inputs', async () => {
  const md = { enumerateDevices: async () => [
    { kind: 'audioinput', deviceId: 'a', label: 'Mic' },
    { kind: 'videoinput', deviceId: 'v1', label: '', groupId: 'g' },
    { kind: 'videoinput', deviceId: 'v2', label: 'USB Cam' },
  ], getUserMedia: async () => fakeStream() };
  await withMediaDevices(md, async () => {
    const list = await listCameras();
    assert(list.length === 2 && list[0].label === 'Camera 1' && list[1].label === 'USB Cam' && list[0].groupId === 'g');
  });
});

test('camera: openVideoFile loops a clip as a fake camera; bad clips fail readably', async () => {
  const video = fakeVideo({ w: 641, h: 534 });
  const cam = await openVideoFile('/dev/clips/x.mp4', { video });
  assert(cam.kind === 'file' && cam.width === 641 && cam.height === 534 && video.loop && video.muted && video.src === '/dev/clips/x.mp4');
  assert(cam.label === 'x.mp4');
  cam.stop();
  assert(video.src === '' && video.paused);
  let err = null;
  try { await openVideoFile('/nope.mp4', { video: fakeVideo({ failPlay: 'NotSupportedError' }) }); } catch (e) { err = e; }
  assert(err && err.code === CameraErrorCode.VIDEO_FILE && /nope\.mp4/.test(err.message));
  err = null;
  try { await openVideoFile(null, { video: fakeVideo() }); } catch (e) { err = e; }
  assert(err && err.code === CameraErrorCode.VIDEO_FILE);
});
