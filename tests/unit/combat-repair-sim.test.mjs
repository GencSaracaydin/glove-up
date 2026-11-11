// Repair round (combat), RV-RULES-02 / decision R3: the tuning is two-sided. dev/sim.mjs's default table runs the
// skilled 'player' bot (research/mechanics.md §4.5c targets) next to a first-timer ('casual') and a modest player
// ('mid', every knob halfway, learning on), and the PRO tier must stay beatable for them (FLOORS; `node dev/sim.mjs
// --n 200` prints the full table — casual ≥ 25 % at each of #5–#9 and, since the polish round's R9 (the champion hits as
// hard as §4.5a says), ≥ 15 % at #10; mid ≥ 55 % at #7/#8). The sim is deterministic for a
// (n, seed): a light guard at n 40 below, and the documented floors at n 200 on the thinnest cells. The 'player' bot's
// §4.5c miss count (the lead's "no more misses than BASE": 11 at seed 1 and 9 at seed 7, BASE the same) is a full-table
// number (`node dev/sim.mjs --n 200`); at small n it is noise (n 60: BASE 13 / 9, this tree 12 / 13 at seeds 1 / 2), so it
// is not asserted here.
import { test, assert } from '../harness.mjs';
import { simulateMany, makeBot, FLOORS, MID_PRESET, PLAYER_PRESETS, floorFor } from '../../dev/sim.mjs';
import { ROSTER } from '../../src/game/roster.js';

test('combat-repair R3: the sim has the mid bot (halfway, learning on) and win floors for the weaker bots', () => {
  for (const k of ['reactMs', 'guardUp', 'respectBlock', 'counter']) {
    assert.equal(MID_PRESET[k], (PLAYER_PRESETS.casual[k] + PLAYER_PRESETS.player[k]) / 2, k);
  }
  assert.equal(MID_PRESET.learn, true);
  assert(makeBot('mid', 1), 'makeBot("mid")');
  assert.equal(floorFor('casual', 7), 0.25);
  assert.equal(floorFor('casual', 2), 0.9);
  assert.equal(floorFor('mid', 8), 0.55);
  assert.equal(floorFor('player', 7), null);
  assert(FLOORS.casual.slice(5, 10).every((f) => f === 0.25));
  assert.equal(floorFor('casual', 10), 0.15, 'R9: the champion floor');
});

test('combat-repair R3: the PRO tier stays beatable — a first-timer and a modest player still win against #7, #8 and #10 (light guard, n 40)', () => {
  const wins = (bot, tier) => [3, 4].reduce((acc, seed) => acc + simulateMany({ opponent: ROSTER[tier - 1], bot, n: 40, seed }).win, 0) / 80;
  const c7 = wins('casual', 7), c10 = wins('casual', 10), m7 = wins('mid', 7), m8 = wins('mid', 8);
  // before the re-tune (same bots, same seeds): casual 6 % vs #7 and ~15–20 % vs #10, mid ~25 % vs #7 and ~40 % vs #8
  assert(c7 >= 0.2, `casual vs #7 ${Math.round(100 * c7)} %`);
  assert(c10 >= 0.2, `casual vs #10 ${Math.round(100 * c10)} %`);
  assert(m7 >= 0.5, `mid vs #7 ${Math.round(100 * m7)} %`);
  assert(m8 >= 0.5, `mid vs #8 ${Math.round(100 * m8)} %`);
});

test('combat-repair R3: the documented floors hold at n 200 on the thinnest cells (casual ≥ 25 % vs #9, ≥ 15 % vs #10, mid ≥ 55 % vs #8)', () => {
  // seed 1, the table's own seed: casual #9 32 %, #10 20 %, mid #8 61 % (repair round 29 %, 29 % with #10's lighter
  // punches, 63 %; before the re-tune 25 %, 15 %, 39 %)
  const rate = (bot, tier) => simulateMany({ opponent: ROSTER[tier - 1], bot, n: 200, seed: 1 }).win / 200;
  for (const [bot, tier] of [['casual', 9], ['casual', 10], ['mid', 8]]) {
    const w = rate(bot, tier);
    assert(w >= floorFor(bot, tier), `${bot} vs #${tier}: ${Math.round(100 * w)} % (floor ${Math.round(100 * floorFor(bot, tier))} %)`);
  }
});
