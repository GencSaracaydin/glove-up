// Polish round (combat), item 3: webcam slips vs the uppercut rule (design E). A sideways lean slips an uppercut unless
// the head is also ducked or tilted forward (the repair round's answer to the A+S / D+W keyboard turtles). Measured
// through the real recognizer, a webcam slip dips the head a little: synthetic players (24 at noise 0.5 and 1) never
// read a duck during |x| ≥ 0.42, but in the real-person clip (MediaPipe full) one of its four slips read y −0.44 … −0.46
// at x −1 (4 of the 58 slip frames, 6.9 %), and 2 of the 58 slip moments lost the uppercut slip (two more moments, at
// 3.7 s, are a full duck, y −1, drifting sideways: they stay a duck). During a clear sideways lean a duck now needs
// y ≤ −(0.42 + COMBAT.duckSlipK·|x|) (−0.67 at |x| 1): the natural dip is a slip, a keyboard A/D + S (y −1) is still a duck.
import { test, assert } from '../harness.mjs';
import * as combat from '../../src/game/combat.js';
import { Boxer } from '../../src/game/boxer.js';

const { COMBAT, evasionFor, isLeaning, resolvePunch } = combat;
const isDuck = (lean) => combat.isDuck(lean);
const up = (hand) => ({ kind: 'uppercut', target: 'head', hand });
const hook = (hand) => ({ kind: 'hook', target: 'head', hand });

test('combat-polish slip: a slip with a natural dip is no duck; a real duck and the keyboard A/D + S still are', () => {
  assert.equal(COMBAT.duckSlipK, 0.25);
  assert(!isDuck({ x: -1, y: -0.46 }), 'slip, head dipped −0.46');
  assert(!isDuck({ x: 0.6, y: -0.5 }), 'slip −0.5 at x 0.6 (needs −0.57)');
  assert(isDuck({ x: -1, y: -1 }), 'A+S (keyboard)');
  assert(isDuck({ x: -1, y: -0.7 }), 'a deep dip during the slip');
  assert(isDuck({ x: 0, y: -0.45 }), 'a plain duck');
  assert(isDuck({ x: 0.3, y: -0.45 }), 'a duck drifting sideways below the lean threshold');
  assert(isLeaning({ x: -1, y: -0.46, z: 0 }), 'still a dodge posture');
});

test('combat-polish slip: the dipping slip slips the uppercut again; A+S and D+W still leave it open (R10 stays closed)', () => {
  for (const hand of ['left', 'right']) {
    assert.equal(evasionFor(up(hand), { x: -1, y: -0.46, z: 0 }), 'lean', `${hand} uppercut vs a dipping slip (before: hit)`);
    assert.equal(evasionFor(up(hand), { x: -1, y: -1, z: 0 }), null, `${hand} uppercut vs A+S`);
    assert.equal(evasionFor(up(hand), { x: 1, y: -1, z: 0 }), null, `${hand} uppercut vs D+S`);
    assert.equal(evasionFor(up(hand), { x: 1, y: 0, z: 1 }), null, `${hand} uppercut vs D+W`);
    assert.equal(evasionFor(up(hand), { x: -1, y: -1, z: -1 }), 'back', 'a back lean still takes the head out of reach');
  }
  // the same slip is a slip for hooks too: the hook it leans away from misses, the other one lands (into the lean)
  assert.equal(evasionFor(hook('left'), { x: -1, y: -0.5, z: 0 }), 'lean');
  assert.equal(evasionFor(hook('right'), { x: -1, y: -0.5, z: 0 }), null, 'the other hook (before: a "duck" took it as well)');
  assert.equal(evasionFor(hook('right'), { x: -1, y: -1, z: 0 }), 'duck', 'A+S still ducks it');
  assert.equal(evasionFor({ kind: 'straight', target: 'head', hand: 'left' }, { x: -1, y: -0.5, z: 0 }), 'lean');
});

test('combat-polish slip: the real clip\'s dipping slip (recognizer output, 8.87–9.30 s) slips an uppercut at every moment', () => {
  // ControlState.lean of the clip's slip through the real GestureRecognizer (MediaPipe full landmarks), one per frame
  const slip = [[8870, -0.43, -0.09, 0], [8900, -0.67, -0.19, 0], [8930, -0.94, -0.26, 0], [8970, -1, -0.32, 0], [9000, -1, -0.39, 0],
    [9030, -1, -0.44, 0], [9070, -1, -0.45, 0.25], [9100, -1, -0.46, 0], [9130, -1, -0.44, 0], [9170, -1, -0.41, 0], [9200, -1, -0.34, 0],
    [9230, -0.83, -0.25, 0], [9270, -0.61, -0.19, 0]];
  const human = new Boxer({ id: 'p1', isHuman: true, latencyMs: 0 });
  for (const [t, x, y, z] of slip) human.setControl({ tracked: true, guard: 'none', guardAmount: 0, lean: { x, y, z } }, t);
  let slipped = 0, moments = 0;
  for (const [t, x] of slip) {
    if (Math.abs(x) < COMBAT.dodgeLeanThreshold) continue;
    for (const hand of ['left', 'right']) {
      moments++;
      const res = resolvePunch({ attacker: { isHuman: false }, defender: human.combatSnapshot(t), punch: { ...up(hand), impactAt: t }, now: t });
      if (res.result === 'dodged') slipped++;
    }
  }
  assert.equal(slipped, moments, `uppercuts slipped at ${slipped} of ${moments} impact moments (before: 4 of the 26 landed)`);
});
