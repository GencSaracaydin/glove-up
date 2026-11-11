// Regression test of the repair round for body straights from a held low guard (RV-INPUT-04): the INPUT-05 tuning
// against pointing and reaching (a stricter early-rise limit for strokes ending at body height; with untrusted depth
// a weak straight's retraction must show in the picture) cost these punches. A stroke that starts within
// lowGuardRecentMs of a held LOW guard — where pointing and reaching never start — is exempt from the first again,
// and may also be confirmed by its 3D retraction (in addition to the picture's).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

/** Players (of 60: 30 seeds × both hands) for whom a slow reach toward the screen from `from` fires a punch. */
function slowReaches(from) {
  let fired = 0;
  for (const hand of ['right', 'left']) for (let i = 0; i < 30; i++) {
    const o = randomPlayerOptions(6400 + i, { noise: 1 });
    const gr = new GestureRecognizer();
    let k = 0;
    for (const f of makeSyntheticPlayer(o).frames(sequence([{ action: from, ms: 1500 }, { action: 'reach-slow', hand, ms: 3200 }, { action: from, ms: 800 }]))) {
      for (const e of gr.update(f.players[0], f.t).events) if (e.type === 'punch' && f.t >= 1500) k++;
    }
    if (k) fired++;
  }
  return fired;
}

test('repair RV-INPUT-04: body straights from a held low guard are recognised again; slow reaches from the stance stay rejected', () => {
  let body = 0, n = 0;
  for (let i = 0; i < 30; i++) {
    const o = randomPlayerOptions(6300 + i, { noise: 1 });
    const steps = [{ action: 'guard-high', ms: 2500 }, { action: 'guard-low', ms: 2500 }];
    for (let k = 0; k < 7; k++) steps.push({ action: k % 2 ? 'body-right' : 'body-left', ms: 700 }, { action: 'guard-low', ms: 700 });
    const gr = new GestureRecognizer();
    for (const f of makeSyntheticPlayer(o).frames(sequence(steps))) {
      for (const e of gr.update(f.players[0], f.t).events) if (e.type === 'punch' && f.t >= 5000 && e.punch.target === 'body' && e.punch.kind === 'straight') body++;
    }
    n += 7;
  }
  // (69 of these 210 before this repair, 81 with it)
  assert(body >= 76, `body straights from a low guard: ${body}/${n}`);
  // a slow reach toward the screen from the fighting stance is what the INPUT-05 limits are for: no more than before
  const fromStance = slowReaches('idle');
  assert(fromStance <= 6, `slow reaches from the stance with a punch: ${fromStance}/60`);
});

test('repair RV-INPUT-04: the accepted cost — slow reaches that start from a held low guard fire at most 6 of 60 (3 before)', () => {
  const fromLow = slowReaches('guard-low');
  assert(fromLow <= 6, `slow reaches from a held low guard with a punch: ${fromLow}/60`);
});
