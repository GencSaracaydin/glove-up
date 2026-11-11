// hudflows fix pass — D13 / FLOWS-03: webcam-only players. Moving in front of the camera is not a browser
// user gesture, so the engine must not create or resume the AudioContext before a real click / key press
// (Chrome refuses and logs "The AudioContext was not allowed to start" again and again); it reports
// `needsGesture` (getter + state()) so the UI can show a "Sound is off" badge, keeps its pointerdown /
// keydown / touchend listeners until audio runs, and never claims `unlocked` while it can't play.
import { test, assert } from '../harness.mjs';
import { AudioEngine } from '../../src/audio/audio.js';
import { FakeContext, fakeTimers } from './audio-fakes.mjs';

/** Run fn with navigator.userActivation / getAutoplayPolicy stubbed (Node has a navigator without them). */
async function withActivation({ active = false, policy = undefined } = {}, fn) {
  const nav = globalThis.navigator;
  if (!nav) return; // very old Node: nothing to stub
  const ua = { hasBeenActive: active, isActive: active };
  Object.defineProperty(nav, 'userActivation', { value: ua, configurable: true });
  if (policy !== undefined) Object.defineProperty(nav, 'getAutoplayPolicy', { value: () => policy, configurable: true });
  try { await fn(ua); } finally {
    delete nav.userActivation;
    if (policy !== undefined) delete nav.getAutoplayPolicy;
  }
}

test('audio D13: without user activation unlock() creates no context, reports needsGesture and never claims unlocked', async () => {
  await withActivation({ active: false }, async (ua) => {
    let made = 0;
    const mk = () => { made++; return new FakeContext(); };
    const e = new AudioEngine({ createContext: mk, timers: fakeTimers(), speech: null });
    assert.equal(e.needsGesture, true);
    assert.equal(await e.unlock(), false, 'no click or key press yet: no sound');
    assert.equal(await e.unlock(), false);
    assert.equal(made, 0, 'no AudioContext created (no autoplay warning)');
    const st = e.state();
    assert.equal(st.needsGesture, true);
    assert.equal(st.unlocked, false, 'not unlocked while nothing can play');
    assert.equal(st.context, 'none');
    e.playSfx('ui-confirm'); // silently skipped
    e.music('menu');
    assert.equal(e.currentMusic, 'menu', 'the request is remembered');
    // the player presses a key / clicks: activation → the next unlock starts audio
    ua.hasBeenActive = true;
    assert.equal(await e.unlock(), true);
    assert.equal(made, 1);
    assert.equal(e.needsGesture, false);
    assert.equal(e.state().unlocked, true);
    assert.equal(e.state().needsGesture, false);
    e.dispose();
  });
});

test('audio D13: once the page has been activated needsGesture is false even while the context is still starting', async () => {
  await withActivation({ active: true }, async () => {
    const ctx = new FakeContext({ state: 'suspended' });
    const e = new AudioEngine({ createContext: () => ctx, timers: fakeTimers(), speech: null, autoUnlock: false });
    assert.equal(e.needsGesture, false, 'a real gesture already happened: no badge');
    const p = e.unlock();
    assert.equal(ctx.resumeCalls, 1, 'resumed under the activation');
    assert.equal(await p, true);
    e.dispose();
  });
});

test('audio D13: the gesture listeners stay until audio runs — a modifier key (no activation) does nothing, a real key starts it', async () => {
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  const win = new EventTarget();
  globalThis.window = win;
  try {
    await withActivation({ active: false }, async (ua) => {
      let made = 0;
      const e = new AudioEngine({ createContext: () => { made++; return new FakeContext(); }, timers: fakeTimers(), speech: null });
      win.dispatchEvent(new Event('keydown')); // e.g. Shift alone: Chrome does not count it as activation
      assert.equal(made, 0, 'no context without activation');
      assert.equal(e.needsGesture, true);
      ua.hasBeenActive = true;                  // a letter key / click activates the page …
      win.dispatchEvent(new Event('pointerdown'));
      assert.equal(made, 1, '… and the listener starts audio');
      await Promise.resolve();
      assert.equal(e.needsGesture, false);
      win.dispatchEvent(new Event('keydown'));
      assert.equal(made, 1, 'listeners removed once running');
      e.dispose();
    });
  } finally {
    if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window;
  }
});

test('audio D13: browsers without userActivation keep the old behaviour; an autoplay-allowed policy needs no gesture', async () => {
  // no navigator.userActivation at all (Node default): unlock() works as before
  let made = 0;
  const e = new AudioEngine({ createContext: () => { made++; return new FakeContext(); }, timers: fakeTimers(), speech: null, autoUnlock: false });
  assert.equal(await e.unlock(), true);
  assert.equal(made, 1);
  assert.equal(e.needsGesture, false, 'running');
  e.dispose();
  await withActivation({ active: false, policy: 'allowed' }, async () => {
    let n = 0;
    const e2 = new AudioEngine({ createContext: () => { n++; return new FakeContext(); }, timers: fakeTimers(), speech: null, autoUnlock: false });
    assert.equal(e2.needsGesture, false, 'autoplay allowed: no badge');
    assert.equal(await e2.unlock(), true);
    assert.equal(n, 1);
    e2.dispose();
  });
});
