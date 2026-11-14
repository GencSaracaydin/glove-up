// Regression tests of the repair round for the calibration's left/right check (RV-INPUT-03): the punch steps may
// only swap left and right back to the default (a camera that does not mirror), and only when nothing confirmed the
// raise step's swap; any other contradiction asks for the right hand once more in mirror terms, and only a second
// raise that agrees with the punches changes it. Closed loop: a synthetic player (tracker noise 1) who does what the
// current step asks, by a policy.
import { test, assert } from '../harness.mjs';
import { CalibrationSession } from '../../src/input/calibration.js';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const other = (h) => (h === 'left' ? 'right' : 'left');

/**
 * Calibrate a synthetic player. `raise(n)` → the hand raised at the n-th right-hand step; `punch(step)` → the hand
 * punching in a punch step (a jab every 1.5 s). Returns the result, the steps in the order visited and every
 * message shown.
 */
function calibrate(o, { raise = () => 'right', punch = (s) => (s === 'punch-left' ? 'left' : 'right'), maxMs = 70000 } = {}) {
  const sp = makeSyntheticPlayer(o);
  const cs = new CalibrationSession();
  const steps = []; let key = null, keyAt = 0, seq = null, stepAt = 0;
  let st = { step: 'frame' }, raises = 0, last = null;
  const visited = [], messages = new Set();
  for (const t of sp.frameTimes(maxMs)) {
    const s = st.step;
    if (s !== last) { if (s === 'right-hand') raises++; visited.push(s); last = s; stepAt = t; }
    let w;
    if (s === 'right-hand') { const h = raise(raises); w = { key: `raise-${h}-${raises}`, step: { action: 'raise-hand', hand: h } }; }
    else if (s === 'punch-left' || s === 'punch-right') {
      const h = punch(s), since = t - stepAt, k = Math.floor(since / 1500), inA = since - k * 1500 < 650;
      w = { key: `${s}-${raises}-${k}-${inA ? 'p' : 'g'}`, step: { action: inA ? `jab-${h}` : 'guard-high' } };
    } else w = { key: 'guard', step: { action: 'guard-high' } };
    if (w.key !== key) {
      if (steps.length) steps[steps.length - 1].ms = Math.max(1, t - keyAt);
      steps.push({ ...w.step, ms: 600000 }); keyAt = t; key = w.key; seq = sequence(steps);
    }
    st = cs.update(sp.pose(t, seq), t);
    if (st.message) messages.add(st.message);
    if (st.done) break;
  }
  return { result: st.done ? st.result : null, visited, messages: [...messages] };
}

const asked = (r) => r.visited.filter((s) => s === 'right-hand').length;
const mirrorWords = (r) => r.messages.some((m) => /RIGHT hand/.test(m) && /mirror/i.test(m));

test('repair RV-INPUT-03: the right hand raised, then the other hand in both punch steps → not swapped (asked once more)', () => {
  for (const seed of [5200, 5201]) {
    const o = randomPlayerOptions(seed, { noise: 1 });
    const r = calibrate(o, { punch: (s) => other(s === 'punch-left' ? 'left' : 'right') });
    assert(r.result, `seed ${seed}: calibration finished`);
    assert(r.result.swapSides === false, `seed ${seed}: swapSides ${r.result.swapSides} (two mixed-up punch steps overruled a right raise)`);
    assert(asked(r) === 2, `seed ${seed}: the right hand was asked for ${asked(r)} times (once more, and only once)`);
    assert(mirrorWords(r), `seed ${seed}: the second ask explains left and right in mirror terms`);
    // the next bout keeps the labels: a LEFT jab is the left hand
    const gr = new GestureRecognizer({ calibration: r.result });
    const hands = [];
    for (const f of makeSyntheticPlayer({ ...o, seed: o.seed + 1 }).frames(sequence([{ action: 'guard-high', ms: 2000 }, { action: 'jab-left', ms: 900 }, { action: 'guard-high', ms: 600 }]))) {
      for (const e of gr.update(f.players[0], f.t).events) if (e.type === 'punch') hands.push(e.punch.hand);
    }
    assert(hands[0] === 'left', `seed ${seed}: a later LEFT jab read as ${hands.join(',')}`);
  }
});

test('repair RV-INPUT-03: the right hand raised, then the right hand only in both punch steps → not swapped', () => {
  for (const seed of [5200, 5203, 5208]) {
    const r = calibrate(randomPlayerOptions(seed, { noise: 1 }), { punch: () => 'right' });
    assert(r.result && r.result.swapSides === false, `seed ${seed}: swapSides ${r.result && r.result.swapSides}`);
    assert(asked(r) <= 2, `seed ${seed}: the right hand was asked for ${asked(r)} times`);
  }
});

test('repair RV-INPUT-03: a camera that mirrors still ends swapped — raised right at once, or right when asked again', () => {
  for (const seed of [5200, 5202]) {
    const o = randomPlayerOptions(seed, { noise: 1, mirrorCamera: true });
    const ok = calibrate(o);
    assert(ok.result && ok.result.swapSides === true, `seed ${seed}: mirrored camera, right hand raised → swapSides ${ok.result && ok.result.swapSides}`);
    assert(asked(ok) === 1, `seed ${seed}: no second ask when everything agrees (${asked(ok)})`);
    // raised LEFT at first (the punch steps then disagree), the RIGHT hand when asked again: the second raise agrees
    const late = calibrate(o, { raise: (n) => (n === 1 ? 'left' : 'right') });
    assert(late.result && late.result.swapSides === true, `seed ${seed}: mirrored camera, right hand on the second ask → swapSides ${late.result && late.result.swapSides}`);
    assert(asked(late) === 2, `seed ${seed}: asked ${asked(late)} times`);
  }
});

test('repair RV-INPUT-03: the LEFT hand raised on a normal camera is still swapped back by the punch steps (INPUT-06)', () => {
  for (const seed of [5200, 5204]) {
    const r = calibrate(randomPlayerOptions(seed, { noise: 1 }), { raise: () => 'left' });
    assert(r.result && r.result.swapSides === false, `seed ${seed}: swapSides ${r.result && r.result.swapSides}`);
    assert(asked(r) === 1, `seed ${seed}: swapping back to the default needs no second ask (${asked(r)})`);
    assert(r.messages.some((m) => /swapped/i.test(m)), `seed ${seed}: the player is told left and right were fixed`);
  }
});

test('repair RV-INPUT-03: a mirrored camera with a correct raise and right step, then the RIGHT hand in the left step → asked again, still swapped', () => {
  // (the second punch step alone used to swap a raise the first had already confirmed back to "not mirrored"; the punch steps
  // run right hand first since 2026-11-13 — the hand just raised)
  for (const seed of [9100, 9101]) {
    const o = randomPlayerOptions(seed, { noise: 1, mirrorCamera: true });
    const r = calibrate(o, { punch: () => 'right' });
    assert(r.result && r.result.swapSides === true, `seed ${seed}: swapSides ${r.result && r.result.swapSides}`);
    assert(asked(r) === 2, `seed ${seed}: the right hand was asked for ${asked(r)} times`);
    // its normal-camera mirror image, whose second raise says "not mirrored", ends not swapped
    const n = calibrate(randomPlayerOptions(seed, { noise: 1 }), { raise: (k) => (k === 1 ? 'left' : 'right'), punch: () => 'left' });
    assert(n.result && n.result.swapSides === false, `seed ${seed}: normal camera, left then right raised → swapSides ${n.result && n.result.swapSides}`);
  }
});

test('repair RV-INPUT-03: the second ask talks about the body, never about a side of the picture (the preview may or may not be mirrored)', () => {
  const r = calibrate(randomPlayerOptions(5200, { noise: 1 }), { punch: (s) => other(s === 'punch-left' ? 'left' : 'right') });
  const second = r.messages.filter((m) => /RIGHT hand/.test(m) && /mirror/i.test(m));
  assert(second.length > 0, 'the second ask was shown');
  for (const m of second) {
    assert(!/(left|right)(-hand)? (side )?of the (picture|screen)/i.test(m) && !/on the (left|right)/i.test(m), `the second ask points to a side of the picture: "${m}"`);
    assert(/body/i.test(m), `the second ask says to go by the body: "${m}"`);
  }
});
