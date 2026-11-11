// CalibrationSession + frameCheck (src/input/calibration.js).
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { CalibrationSession, frameCheck, CALIBRATION_DEFAULTS } from '../../src/input/calibration.js';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

/** Closed loop: a synthetic player who does what the current calibration step asks. */
function calibrate(opts, { punches = true, maxMs = 90000 } = {}) {
  const sp = makeSyntheticPlayer(opts);
  const cal = new CalibrationSession({ now: () => 123 });
  const plan = {
    frame: sequence([{ action: 'idle', ms: Infinity }]),
    guard: sequence([{ action: 'idle', ms: 300 }, { action: 'guard-high', ms: Infinity }]),
    'right-hand': sequence([{ action: 'guard-high', ms: 400 }, { action: 'raise-hand', hand: 'right', ms: Infinity }]),
    'punch-left': sequence([{ action: 'idle', ms: 600 }, ...Array.from({ length: 30 }, () => ({ action: punches ? 'jab-left' : 'idle', ms: 900 }))]),
    'punch-right': sequence([{ action: 'idle', ms: 600 }, ...Array.from({ length: 30 }, () => ({ action: punches ? 'jab-right' : 'idle', ms: 900 }))]),
  };
  const states = [];
  let step = null, start = 0, st = null;
  for (let t = 0; t < maxMs; t += 33.3) {
    if (!st || st.step !== step) { step = st ? st.step : 'frame'; start = t; sp.reset(); }
    if (step === 'done') break;
    st = cal.update(sp.pose(t - start, plan[step]), t);
    states.push(st);
    if (st.done) break;
  }
  return { cal, states, last: states[states.length - 1] };
}
/** The open-loop variant (fixed script) for the jitter test. */
function session(opts) {
  const steps = [{ action: 'idle', ms: 2000 }, { action: 'guard-high', ms: 2600 }, { action: 'raise-hand', hand: 'right', ms: 1800 }, { action: 'idle', ms: 900 }];
  return makeSyntheticPlayer(opts).run(sequence(steps)).frames;
}

test('calibration: completes on synthetic players with plausible measurements', () => {
  for (const o of [{ seed: 5 }, randomPlayerOptions(12), randomPlayerOptions(13), randomPlayerOptions(14)]) {
    const { last, states } = calibrate(o);
    assert(last.done && last.step === 'done' && last.progress === 1, `not done: ${last.step} ${last.message}`);
    const r = last.result;
    assert(r.version === 1 && r.swapSides === false && r.createdAt === 123);
    // compare with the noise-free geometry of the same player
    const p = makeSyntheticPlayer({ ...o, noise: 0 }).pose(1500, 'guard-high');
    const sw = Math.hypot(p.image[LM.LEFT_SHOULDER].x - p.image[LM.RIGHT_SHOULDER].x, (p.image[LM.LEFT_SHOULDER].y - p.image[LM.RIGHT_SHOULDER].y) * 0.75);
    assert(Math.abs(r.shoulderWidth - sw) / sw < 0.15, `shoulder width ${r.shoulderWidth} vs ${sw}`);
    assert(Math.abs(r.neutralHead.x - p.image[LM.NOSE].x) < 0.04 && Math.abs(r.neutralHead.y - p.image[LM.NOSE].y) < 0.06, 'neutral head near the face');
    assert(r.armLengthWorld > 0.4 && r.armLengthWorld < 0.8, `arm ${r.armLengthWorld}`);
    if (o.zScale) assert(Math.abs(r.zScale - o.zScale) < 0.15, `zScale ${r.zScale} vs ${o.zScale}`);
    assert(r.headPunchLevel && Number.isFinite(r.headPunchLevel.image), 'head-punch height measured');
    assert(r.suggestedSensitivity >= 0.35 && r.suggestedSensitivity <= 0.85);
    // progress only moves forward, steps in order, every state has a message
    const order = ['frame', 'guard', 'right-hand', 'punch-left', 'punch-right', 'done'];
    for (let i = 1; i < states.length; i++) {
      assert(states[i].progress >= states[i - 1].progress - 1e-9, 'progress monotonic');
      assert(order.indexOf(states[i].step) >= order.indexOf(states[i - 1].step), 'step order');
    }
    assert(states.every((s) => typeof s.message === 'string' && s.message.length > 5));
    assert(new Set(states.map((s) => s.step)).size === 6, 'visited every step');
  }
});

test('calibration: mirrored camera → swapSides, and the recognizer then gets hands right', () => {
  const o = { seed: 21, mirrorCamera: true };
  const { last } = calibrate(o);
  assert(last.done && last.result.swapSides === true, 'swap detected');
  const rec = new GestureRecognizer({ calibration: last.result });
  const { frames } = makeSyntheticPlayer(o).run(sequence([{ action: 'idle', ms: 1500 }, { action: 'jab-left', ms: 1000 }, { action: 'cross', ms: 1000 }]));
  const hands = [];
  for (const f of frames) for (const e of rec.update(f.players[0], f.t).events) if (e.type === 'punch') hands.push(e.punch.hand);
  assert.deepEqual(hands, ['left', 'right']);
  const { last: normal } = calibrate({ seed: 21 });
  assert(normal.result.swapSides === false);
});

test('calibration: frameCheck names what is missing (ERR01)', () => {
  const sp = makeSyntheticPlayer({ seed: 1, noise: 0 });
  assert(!frameCheck(null).ok && /Step into the picture/.test(frameCheck(null).message));
  const good = frameCheck(sp.pose(500, 'idle'));
  assert(good.ok && good.missing.length === 0, good.message);
  const p = sp.pose(500, 'idle');
  p.image[LM.LEFT_WRIST] = { ...p.image[LM.LEFT_WRIST], visibility: 0.05 };
  const noHand = frameCheck(p);
  assert(!noHand.ok && noHand.missing.includes('leftHand') && /left hand/.test(noHand.message), noHand.message);
  const close = frameCheck(makeSyntheticPlayer({ seed: 1, noise: 0, distance: 0.55, focal: 0.9 }).pose(500, 'idle'));
  assert(!close.ok && /Step back/.test(close.message), close.message);
  const far = frameCheck(makeSyntheticPlayer({ seed: 1, noise: 0, distance: 5.5, focal: 0.6 }).pose(500, 'idle'));
  assert(!far.ok && far.tooFar && /closer/.test(far.message), far.message);
  const side = frameCheck(makeSyntheticPlayer({ seed: 1, noise: 0, lateral: 0.85 }).pose(500, 'idle'));
  assert(!side.ok && /middle/.test(side.message), side.message);
});

test('calibration: no punches → hints, then moves on with defaults (never traps the player)', () => {
  const { states, last } = calibrate({ seed: 7 }, { punches: false });
  assert(last.done, `stuck at ${last.step}: ${last.message}`);
  assert(states.some((s) => s.hint && /snap the punch/.test(s.hint)), 'punch hint shown');
  assert(last.result.notes && last.result.notes.some((n) => /no left punches/.test(n)), JSON.stringify(last.result.notes));
  assert(last.result.armLengthWorld > 0.4, 'arm length still measured from the raised hand');
  assert(!last.result.zScale && !last.result.headPunchLevel, 'no punch-derived values without punches');
});

test('calibration: robust to jitter; retryStep and restart', () => {
  const frames = session({ seed: 8, noise: 1.6 });
  const cal = new CalibrationSession({});
  let st;
  for (const fr of frames) { st = cal.update(fr.players[0], fr.t); if (st.step === 'guard' && st.stepProgress > 0.3) break; }
  assert(st.step === 'guard' && st.stepProgress > 0.3, 'guard hold progressing under heavy jitter');
  cal.retryStep();
  const again = cal.update(frames[frames.length - 1].players[0], frames[frames.length - 1].t + 100);
  assert(again.step === 'guard' && again.stepProgress < 0.3, 'retry resets the step');
  cal.restart();
  assert(cal.update(null, 1e6).step === 'frame');
  // losing the player mid-step says so
  const cal2 = new CalibrationSession({});
  let s2;
  for (const fr of frames.slice(0, 80)) s2 = cal2.update(fr.players[0], fr.t);
  for (let k = 0; k < 15; k++) s2 = cal2.update(null, frames[79].t + 33 * (k + 1));
  assert(/picture/i.test(s2.message), s2.message);
  assert(CALIBRATION_DEFAULTS.punchesPerHand === 3);
});
