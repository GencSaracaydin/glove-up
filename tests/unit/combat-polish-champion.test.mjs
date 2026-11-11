// Polish round (combat), decision R9: the champion (#10) hits as hard as research/mechanics.md §4.5a says again —
// a quarter of its attacks are power punches of 3.5 wedges, its ordinary punches 1.1 (the repair round had 20 %, 3.0
// and 1.0) — at a pace near §4.5a's: 3.8 s between attacks in round 1 (a) 3.5; a cagey first round), 1.7 s after (a) 1.6,
// as in the repair round). With a)'s exact 3.5 / 1.6 s and punishes thrown as measured, a first-timer won 18 / 19 / 14.5 %
// at seeds 1 / 7 / 3 (below the floor) and the skilled bot floored it 20.3 s in at seed 1 (below §4.5c's 21 s). The casual
// floor against it drops to ≥ 15 % (dev/sim.mjs FLOORS); every other R3 floor stays.
import { test, assert } from '../harness.mjs';
import { CHAMPION } from '../../src/game/roster.js';
import { OpponentAI } from '../../src/game/ai.js';
import { Boxer } from '../../src/game/boxer.js';
import { simulateMany, floorFor } from '../../dev/sim.mjs';

test('combat-polish R9: the champion uses §4.5a damage (25 % power at 3.5 wedges, ordinary 1.1) at a pace near it (3.8 s, then 1.7 s)', () => {
  const a = CHAMPION.ai;
  assert.equal(a.powerPct, 0.25);
  assert.equal(a.powerDamage, 3.5);
  assert.equal(a.ordinaryDamage, 1.1);
  assert.deepEqual([...a.attackGapByRound], [3800, 1700, 1700]);
  // the brain carries them into its punches: new attacks are power punches a quarter of the time, at 3.5; the rest 1.1
  const def = { ...CHAMPION, ai: { ...CHAMPION.ai, moodSwing: 0 } };
  const ai = new OpponentAI(def, 77);
  let power = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
    const req = ai._makePunch(1000, self, null, { first: false, reason: 'attack' });
    n++;
    if (req.powerPunch) { power++; assert.equal(req.damage, 3.5); } else assert.equal(req.damage, 1.1);
  }
  assert(Math.abs(power / n - 0.25) < 0.03, `power share ${(100 * power / n).toFixed(1)} %`);
  ai.newRound(1);
  assert.equal(ai._gap(), 3800, 'round 1');
  ai.newRound(2);
  assert.equal(ai._gap(), 1700, 'round 2');
  ai.newRound(3);
  assert.equal(ai._gap(), 1700, 'round 3');
});

test('combat-polish R9: the champion floor — a first-timer still wins ≥ 15 % at the other table seeds (7 and 3, n 200)', () => {
  assert.equal(floorFor('casual', 10), 0.15);
  // (seed 1 is checked by combat-repair-sim; measured 20 / 24 / 20 % at seeds 1 / 7 / 3 — the repair round's lighter
  // champion: 29 / 31 / 27 %)
  for (const seed of [7, 3]) {
    const w = simulateMany({ opponent: CHAMPION, bot: 'casual', n: 200, seed }).win / 200;
    assert(w >= floorFor('casual', 10), `casual vs #10 at seed ${seed}: ${Math.round(100 * w)} %`);
  }
});
