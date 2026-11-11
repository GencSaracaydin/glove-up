// Tracking lost (user request 2026-11-10): the HUD asks "Please keep your hands visible" while a player's hands are
// lost (the pause follows HUB_TUNING.lostMs = 1 s later), and the tracking-lost card carries on by itself
// UI_TUNING.lostResumeMs = 0.5 s after both hands are back in view (it used to need a 2 s guard hold). Drives the
// real screen over a tiny fake DOM.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { UI_TUNING } from '../../src/ui/screens/kit.js';
import { HUB_TUNING } from '../../src/input/input-hub.js';
import { handsWarningText } from '../../src/ui/hud.js';
import trackingLost from '../../src/ui/screens/tracking-lost.js';
import { withDom, body } from './helpers/fake-dom.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** The real card with a scripted camera: step(t, pose, tracked) feeds one frame. */
function lostCard(params = {}) {
  const status = { phase: 'running', frameAgeMs: 30, tracking: [false, false], error: null };
  const S = { frame: null, done: [], sfx: [] };
  const ctx = {
    done: (r) => S.done.push(r), sfx: (n) => S.sfx.push(n), settings: () => ({}),
    bus: { on: () => () => {} },
    input: { status, start: async () => ({ ok: true }) },
    ui: { latestFrame: () => S.frame, getVideo: () => null },
  };
  const inst = trackingLost.create(ctx, params);
  const title = () => inst.el.querySelector('.gu-modal__title').textContent;
  const msg = () => inst.el.querySelector('.gu-lost__status').textContent;
  const step = (t, pose, tracked, pose2 = null, tracked2 = false) => {
    S.frame = { players: [pose, pose2] }; status.tracking[0] = tracked; status.tracking[1] = tracked2; inst.update(0.033, t);
  };
  return { inst, status, S, title, msg, step };
}

test('tracking lost: both hands back → carries on by itself after 0.5 s (not before), no guard hold needed', async () => {
  assert.equal(UI_TUNING.lostResumeMs, 500);
  await withDom(async () => {
    const c = lostCard();
    // gone, then back with both hands; the hub's own "found" debounce agrees after 300 ms (HUB_TUNING.foundMs)
    for (let t = 0; t <= 600; t += 33) c.step(t, null, false);
    assert(/lost sight of you/i.test(c.title()), c.title());
    const back = 1000;
    let resumedAt = null;
    for (let t = back; t <= back + 1200 && resumedAt === null; t += 33) {
      c.step(t, body(), t - back >= HUB_TUNING.foundMs);
      if (c.S.done.length) resumedAt = t - back;
    }
    assert(resumedAt !== null, 'resumed');
    assert(resumedAt >= 500 && resumedAt < 560, `0.5 s after the hands are back (${resumedAt} ms)`);
    assert.deepEqual(c.S.done, [{ action: 'resume', via: 'hands' }]);
  });
});

test('tracking lost: in the picture without both hands → "We can\'t see your hands", and no resume', async () => {
  await withDom(async () => {
    const c = lostCard();
    for (let t = 0; t <= 3000; t += 33) c.step(t, body(0.5, [LM.LEFT_WRIST]), false);
    assert(/can’t see your hands/i.test(c.title()), c.title());
    assert.equal(c.msg(), 'Now show both hands');
    assert.equal(c.S.done.length, 0);
    for (let t = 3033; t <= 3600; t += 33) c.step(t, null, false);
    assert(/lost sight of you/i.test(c.title()), `gone altogether: ${c.title()}`);
    for (let t = 3633; t <= 3900; t += 33) c.step(t, body(0.5, [LM.RIGHT_WRIST]), false);
    assert(/can’t see your hands/i.test(c.title()), 'back without a hand');
    c.step(3933, body(), false);
    assert.equal(c.msg(), 'Almost there…', 'both hands back but the hub has not found the player yet: no false "carrying on"');
    for (let t = 3966; t <= 4300; t += 33) c.step(t, body(), true);
    assert(/can’t see your hands/i.test(c.title()) && c.msg() === 'Great — carrying on…', 'both hands back: the title holds still while it counts down');
  });
});

test('tracking lost: the hub must track the player again too, and a hand that drops out restarts the 0.5 s', async () => {
  await withDom(async () => {
    const c = lostCard();
    for (let t = 0; t <= 1500; t += 33) c.step(t, body(), false);
    assert.equal(c.S.done.length, 0, 'hands visible but the hub still has them lost: wait (resuming would pause again at once)');
    c.step(1533, body(), true);
    assert.equal(c.S.done.length, 1, 'carries on as soon as the hub agrees (the 0.5 s already passed)');
    const d = lostCard();
    for (let t = 0; t <= 300; t += 33) d.step(t, body(), true);
    for (let t = 333; t <= 400; t += 33) d.step(t, body(0.5, [LM.RIGHT_WRIST]), true);
    for (let t = 433; t <= 900; t += 33) d.step(t, body(), true);
    assert.equal(d.S.done.length, 0, 'the timer started over when the hand dropped out');
    for (let t = 933; t <= 1000; t += 33) d.step(t, body(), true);
    assert.equal(d.S.done.length, 1);
  });
});

test('hands warning: wording, and the app shows it only while a live activity could pause', () => {
  assert.equal(handsWarningText(), 'Please keep your hands visible');
  assert.equal(handsWarningText({ versus: true, who: [1], names: ['Robin', 'Vera'] }), 'Vera: please keep your hands visible');
  assert.equal(handsWarningText({ versus: true, who: [0, 1], names: ['Robin', 'Vera'] }), 'Please keep your hands visible');
  assert.equal(HUB_TUNING.lostMs, 1000, 'the warning shows for a second before the fight pauses');
  const app = read('src/app/app.js');
  assert(/const warn = !!s && this\._live\(\) && s\.canPause && !this\._pausing && camOk;/.test(app), 'live, pausable, not already pausing, camera working');
  assert(/const camOk = st\.phase !== 'error' && !\(typeof age === 'number' && \(!Number\.isFinite\(age\) \|\| age > /.test(app), 'a stopped or frozen camera is no reason to ask for the hands');
  assert(/return p\?\.control\?\.tracked === false \|\| \(this\._noPoseSince\[i\] !== null && now - this\._noPoseSince\[i\] >= APP_TUNING\.handsWarnPoseMs\);/.test(app), 'a lost hand, or the whole pose gone for a moment');
  const hud = read('src/ui/hud.js');
  assert(/this\._updateHandsWarning\(extras\);[\s\S]*this\._autoTutorial\(view\);/.test(hud) && /if \(extras\.tracking\) this\.setTracking\(extras\.tracking\);\s*this\._updateHandsWarning\(extras\);/.test(hud), 'bouts and drills');
  assert(/\.gu-handswarn \{/.test(read('src/ui/styles.css')));
  assert(/render\(realDt, hudExtras\) \{[\s\S]*?updateTraining\(view, hudExtras \|\| \{\}\)/.test(read('src/app/session.js')), 'drills pass the extras to the HUD');
});

test('tracking lost: back means what the tracker needs — head, both shoulders, both hands, hands not raised above the head', async () => {
  await withDom(async () => {
    const c = lostCard();
    for (let t = 0; t <= 1500; t += 33) c.step(t, body(0.5, [LM.NOSE]), true); // head out of the top of the picture
    assert.equal(c.S.done.length, 0, 'no resume without the head');
    assert(/head is out of the picture/.test(c.msg()), c.msg());
    const up = body();
    up.image[LM.LEFT_WRIST] = { ...up.image[LM.LEFT_WRIST], y: 0.08 };
    up.image[LM.RIGHT_WRIST] = { ...up.image[LM.RIGHT_WRIST], y: 0.08 };
    const d = lostCard();
    for (let t = 0; t <= 1500; t += 33) d.step(t, up, true); // both hands above the head: the pause gesture
    assert.equal(d.S.done.length, 0, 'hands up above the head is not "back" (the pause hold would fire right after)');
    assert.equal(d.msg(), 'Bring your hands down to your guard');
    for (let t = 1533; t <= 2100; t += 33) d.step(t, body(), true);
    assert.equal(d.S.done.length, 1, 'down into a guard: carries on 0.5 s later');
  });
});

test('tracking lost: two players — carries on only once both are back; a restarting camera (no frame yet) is nobody', async () => {
  await withDom(async () => {
    const c = lostCard({ player: 0, players: 2 });
    for (let t = 0; t <= 1500; t += 33) c.step(t, body(0.3), true, null, false);
    assert.equal(c.S.done.length, 0, 'P1 back, P2 still out: keep waiting');
    assert.equal(c.msg(), 'Waiting for P2 to step back in');
    c.step(1533, body(0.3), true, body(0.7), true);
    assert.equal(c.S.done.length, 1, 'both back');
    const d = lostCard();
    d.status.frameAgeMs = Infinity; // input.start() after "Try again": the old frame is still the latest one
    for (let t = 0; t <= 1500; t += 33) d.step(t, body(), false);
    assert.equal(d.S.done.length, 0);
    assert.equal(d.msg(), 'We can’t see you yet', 'no false "carrying on" from the frame before the camera stopped');
  });
});
