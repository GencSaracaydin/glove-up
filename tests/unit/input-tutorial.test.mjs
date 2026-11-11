// Tutorial detection helpers (src/input/tutorial-detect.js) for the first-bout tutorial
// (research/mechanics.md §8): stance → guard face → punch face → guard body → punch body → dodge,
// each advancing on a hold or 3 detections with a 10 s cap — with keyboard input and with the
// camera recognizer on synthetic players.
import { test, assert } from '../harness.mjs';
import {
  TUTORIAL_STEPS, TUTORIAL_DETECT, isStance, stanceHeld, isGuard, guardHeld, punchMatches, dodgeDetected, leanReleased, TutorialStepTracker,
} from '../../src/input/tutorial-detect.js';
import { KeyboardInput, neutralControl } from '../../src/input/keyboard.js';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence } from '../../src/input/synthetic.js';

const ctl = (o = {}) => ({ ...neutralControl(), ...o, lean: { x: 0, y: 0, z: 0, ...(o.lean || {}) } });

test('tutorial: step list and thresholds mirror the bout (combat guard / dodge thresholds)', async () => {
  assert.deepEqual([...TUTORIAL_STEPS], ['stance', 'guard-face', 'punch-face', 'guard-body', 'punch-body', 'dodge']);
  assert(TUTORIAL_DETECT.detections === 3 && TUTORIAL_DETECT.capMs === 10000);
  let COMBAT = null;
  try { ({ COMBAT } = await import('../../src/game/combat.js')); } catch { /* mid-edit */ }
  if (COMBAT && Number.isFinite(COMBAT.dodgeLeanThreshold)) {
    assert(TUTORIAL_DETECT.dodge.x === COMBAT.dodgeLeanThreshold && TUTORIAL_DETECT.dodge.y === COMBAT.duckThreshold && TUTORIAL_DETECT.dodge.z === COMBAT.backLeanThreshold);
    if (Number.isFinite(COMBAT.guardMinAmount)) assert(TUTORIAL_DETECT.minGuardAmount === COMBAT.guardMinAmount);
  }
});

test('tutorial: pure helpers — stance, guards, punch targets, dodges', () => {
  assert(!isStance(null) && !isStance(ctl({ tracked: false, stanceMs: 2000 })));
  assert(isStance(ctl({ stanceMs: 10 })) && !isStance(ctl({ stanceMs: 0 })));
  assert(stanceHeld(ctl({ stanceMs: 1000 })) && !stanceHeld(ctl({ stanceMs: 900 })) && stanceHeld(ctl({ stanceMs: 500 }), 400));
  // fallback without stanceMs: geometric check
  const noMs = ctl(); delete noMs.stanceMs;
  assert(isStance(noMs), 'neutral hands count as a stance');
  assert(!isStance({ ...noMs, hands: { ...noMs.hands, left: { x: -0.3, y: -1.4, reach: 0, punching: false } } }), 'hand hanging down');
  assert(isGuard(ctl({ guard: 'high', guardAmount: 0.8 }), 'high') && !isGuard(ctl({ guard: 'high', guardAmount: 0.2 }), 'high'));
  assert(!isGuard(ctl({ guard: 'low', guardAmount: 1 }), 'high') && isGuard(ctl({ guard: 'low', guardAmount: 1 }), 'low'));
  assert(guardHeld(ctl({ guard: 'high', guardAmount: 1, guardMs: 1200 }), 'high') && !guardHeld(ctl({ guard: 'high', guardAmount: 1, guardMs: 300 }), 'high'));
  const ev = (target, type = 'punch') => ({ type, t: 0, punch: { hand: 'left', kind: 'straight', target, power: 0.6, t: 0 } });
  assert(punchMatches(ev('head'), 'head') && !punchMatches(ev('head'), 'body') && punchMatches(ev('body'), 'body'));
  assert(punchMatches({ player: 0, punch: ev('body').punch }, 'body') && punchMatches(ev('head').punch, 'head'));
  assert(!punchMatches({ type: 'pause', t: 0 }, 'head') && !punchMatches(null, 'head'));
  assert(dodgeDetected(ctl()) === null && dodgeDetected(ctl({ tracked: false, lean: { x: -1 } })) === null);
  assert(dodgeDetected(ctl({ lean: { x: -0.5 } })) === 'left' && dodgeDetected(ctl({ lean: { x: 0.43 } })) === 'right');
  assert(dodgeDetected(ctl({ lean: { x: 0.41 } })) === null, 'below the combat threshold');
  assert(dodgeDetected(ctl({ lean: { y: -0.6 } })) === 'duck' && dodgeDetected(ctl({ lean: { z: -0.7 } })) === 'back' && dodgeDetected(ctl({ lean: { z: 0.7 } })) === 'forward');
  assert(dodgeDetected(ctl({ lean: { x: 0.9, y: -0.5 } })) === 'right', 'the clearest one wins');
  assert(dodgeDetected(ctl({ lean: { x: 0.5 } }), { x: 0.6 }) === null, 'thresholds can be passed in');
  assert(leanReleased(ctl()) && !leanReleased(ctl({ lean: { x: 0.3 } })));
});

/** Drive a tracker with keyboard input; `script` = [[tMs, code, down]]. */
function keyboardRun(step, script, endMs) {
  const kb = new KeyboardInput();
  const tr = new TutorialStepTracker();
  tr.setStep(step, 0);
  let s = null, i = 0;
  for (let t = 0; t <= endMs; t += 16) {
    while (i < script.length && script[i][0] <= t) { kb.handleKey(script[i][1], script[i][2], { t: script[i][0] }); i++; }
    s = tr.update(kb.update(t, 0), t);
    if (s.done) return { s, t };
  }
  return { s, t: endMs };
}

test('tutorial: every step completes with the keyboard (hold steps after ~1 s, counted steps after 3)', () => {
  let r = keyboardRun('stance', [], 3000);
  assert(r.s.done && r.s.reason === 'hold' && r.t >= 1000 && r.t <= 1100, `stance ${JSON.stringify(r)}`);
  r = keyboardRun('guard-face', [[200, 'Space', true]], 4000);
  assert(r.s.done && r.s.reason === 'hold' && r.t >= 1200 && r.t <= 1500, `guard face ${JSON.stringify(r)}`);
  r = keyboardRun('guard-body', [[0, 'KeyB', true]], 4000);
  assert(r.s.done && r.s.reason === 'hold', `guard body ${JSON.stringify(r)}`);
  r = keyboardRun('punch-face', [[100, 'KeyJ', true], [150, 'KeyJ', false], [500, 'KeyK', true], [550, 'KeyK', false], [900, 'KeyU', true], [950, 'KeyU', false]], 3000);
  assert(r.s.done && r.s.reason === 'count' && r.s.count === 3, `punch face ${JSON.stringify(r)}`);
  r = keyboardRun('punch-body', [[100, 'KeyJ', true], [150, 'KeyJ', false], [400, 'ShiftLeft', true], [500, 'KeyJ', true], [550, 'KeyJ', false], [800, 'KeyK', true], [850, 'KeyK', false], [1200, 'KeyM', true], [1250, 'KeyM', false]], 3000);
  assert(r.s.done && r.s.count === 3 && r.t >= 1200, `punch body counts body shots only ${JSON.stringify(r)}`);
  r = keyboardRun('dodge', [[100, 'KeyA', true], [400, 'KeyA', false], [800, 'KeyD', true], [1100, 'KeyD', false], [1500, 'KeyX', true], [1800, 'KeyX', false]], 3000);
  assert(r.s.done && r.s.reason === 'count' && r.s.count === 3 && r.s.dodge === 'back', `dodge ${JSON.stringify(r)}`);
});

test('tutorial: a held dodge counts once; releasing the hold resets a hold step; the 10 s cap always advances', () => {
  let r = keyboardRun('dodge', [[100, 'KeyA', true]], 3000);
  assert(!r.s.done && r.s.count === 1, `held lean counted ${r.s.count}`);
  r = keyboardRun('guard-face', [[0, 'Space', true], [600, 'Space', false], [700, 'Space', true]], 1500);
  assert(!r.s.done && r.s.heldMs < 1000, 'guard released → hold restarts');
  r = keyboardRun('punch-face', [], 12000);
  assert(r.s.done && r.s.reason === 'cap' && r.t >= 10000 && r.t <= 10050, `cap ${JSON.stringify(r)}`);
  const tr = new TutorialStepTracker({ tuning: { capMs: 500, holdMs: { 'guard-face': 300 } } });
  tr.setStep('guard-face', 0);
  const g = { control: ctl({ guard: 'high', guardAmount: 1, guardMs: 400 }), events: [] };
  assert(!tr.update(g, 10).done, 'a guard held before the step began still has to be held for the step');
  assert(tr.update(g, 320).done && tr.state.reason === 'hold', 'custom hold time');
  tr.setStep('nonsense', 0);
  assert(tr.step === 'stance', 'unknown step → stance');
});

test('tutorial: with the camera recognizer (synthetic player) the poses are detected', () => {
  // clean world depth (a what-if much cleaner than real MediaPipe output, see gesture-robust.test.mjs): body
  // punches thrown from the low guard of the previous step are short forward pushes that need it
  const sp = makeSyntheticPlayer({ seed: 4, zNoise: 0.006, worldNoise: 0.003, zBias: 0.008 });
  const seq = sequence([{ action: 'idle', ms: 2500 }, { action: 'guard-high', ms: 2000 }, { action: 'guard-low', ms: 2000 },
    { action: 'body-left', ms: 900 }, { action: 'body-right', ms: 900 }, { action: 'body-left', ms: 900 }, { action: 'body-right', ms: 900 }, { action: 'guard-high', ms: 800 },
    { action: 'lean-left', amount: 1.4, ms: 900 }, { action: 'guard-high', ms: 700 }, { action: 'lean-right', amount: 1.4, ms: 900 }, { action: 'guard-high', ms: 700 }, { action: 'duck', amount: 1.3, ms: 900 }, { action: 'guard-high', ms: 800 }]);
  const { frames } = sp.run(seq);
  const rec = new GestureRecognizer({});
  const steps = { stance: [500, 2500], 'guard-face': [2600, 4500], 'guard-body': [4600, 6500], 'punch-body': [6500, 10100], dodge: [10100, 15800] };
  const trackers = Object.fromEntries(Object.entries(steps).map(([k, [a]]) => { const t = new TutorialStepTracker(); t.setStep(k, a); return [k, t]; }));
  const done = {};
  for (const fr of frames) {
    const out = rec.update(fr.players[0], fr.t);
    for (const [k, [a, b]] of Object.entries(steps)) {
      if (fr.t < a || fr.t > b || done[k]) continue;
      const s = trackers[k].update(out, fr.t);
      if (s.done) done[k] = { t: Math.round(fr.t - a), reason: s.reason, count: s.count };
    }
  }
  // body punches thrown from the low guard are the weakest camera case (≈ 55 % in simulation, see
  // gesture-robust.test.mjs): 4 thrown here must give at least 2; the 10 s cap covers the rest
  const pb = trackers['punch-body'].state;
  assert(pb.count >= 2, `punch-body counted ${pb.count}`);
  delete done['punch-body'];
  for (const k of Object.keys(steps)) if (k !== 'punch-body') assert(done[k] && done[k].reason !== 'cap', `${k}: ${JSON.stringify(done[k])}`);
  assert(done.stance.t >= 900 && done['guard-face'].t < 1800, JSON.stringify(done));
});
