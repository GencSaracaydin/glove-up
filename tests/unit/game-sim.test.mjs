// dev/sim.mjs — the tuned ladder stays in the research/mechanics.md §4.5c shape (a light regression
// guard on the roster numbers; `node dev/sim.mjs --n 200` prints the full target table). The sim runs
// like MatchSession: a real clock for the bot, a game clock the renderer's hit-stop stalls.
import { test, assert } from '../harness.mjs';
import { simulateMany, simulateBout, TARGETS, hitStopMs, makeBot } from '../../dev/sim.mjs';
import { ROSTER } from '../../src/game/roster.js';
import { COMBAT } from '../../src/game/combat.js';

test('sim: standing still loses by KO to the first and the last opponent', () => {
  for (const opp of [ROSTER[0], ROSTER[9]]) {
    const { result } = simulateBout({ opponent: opp, bot: 'idle', seed: 3 });
    assert(result.winner === 'p2' && result.method === 'KO', `${opp.id}: ${result.method}`);
  }
});

test('sim: the webcam player bot — sparring partner in round 1 after ~10 s, the champion a long, two-round fight', () => {
  const t1 = simulateMany({ opponent: ROSTER[0], bot: 'player', n: 16, seed: 2 });
  assert.equal(t1.win, 16);
  assert(t1.endings[1] === 16, 'round 1');
  assert(t1.firstKdMedian >= 6.5 && t1.firstKdMedian <= 15, `first KD ${t1.firstKdMedian}`);
  assert(t1.blockedShare < 0.27 && t1.hitsPerMin < 5);
  const t5 = simulateMany({ opponent: ROSTER[4], bot: 'player', n: 30, seed: 2 });
  assert(t5.firstKdMedian >= 15 && t5.firstKdMedian <= 32, `#5 first KD ${t5.firstKdMedian}`);
  assert(t5.blockedShare >= 0.55 && t5.blockedShare <= 0.75, `#5 blocked ${t5.blockedShare}`);
  assert(t5.kdToKoMean >= 2.5, `#5 knockdowns to KO ${t5.kdToKoMean}`);
  const t10 = simulateMany({ opponent: ROSTER[9], bot: 'player', n: 24, seed: 2 });
  assert(t10.win >= 15, `the good player still usually beats the champion (${t10.win}/24)`);
  assert(t10.kdToKoMean >= 3, `#10 knockdowns to KO ${t10.kdToKoMean}`);
  assert((t10.endings[2] || 0) + (t10.endings[3] || 0) >= 5, 'the champion often lasts into round 2');
  assert(t10.firstKdMedian >= 17, `the champion takes a while to floor (${t10.firstKdMedian} s)`);
  assert(t10.hitsPerMin >= 6, `the champion lands (${t10.hitsPerMin}/min)`);
});

test('sim: flailing only beats the first few — a jab-spammer loses to the fortress more often than not', () => {
  const low = simulateMany({ opponent: ROSTER[1], bot: 'spam', n: 8, seed: 4 });
  const high = simulateMany({ opponent: ROSTER[6], bot: 'spam', n: 12, seed: 4 });
  assert.equal(low.win, 8);
  assert(high.win <= 6, `spam vs #7: ${high.win}/12`);
});

test('sim: helpers — targets for all ten, hit-stop per §2.8 (the render/fx.js tiers via combat.stallMsFor)', () => {
  assert.equal(TARGETS.length, 11);
  for (let i = 1; i <= 10; i++) assert(TARGETS[i].firstKd[0] < TARGETS[i].firstKd[1]);
  assert.equal(hitStopMs({ attacker: 'p1' }), 200);
  assert.equal(hitStopMs({ attacker: 'p1', counter: true, heavy: true }), 500);
  assert.equal(hitStopMs({ attacker: 'p1', knockdown: true }), 700);
  assert.equal(hitStopMs({ attacker: 'p2' }), 0);
  assert.equal(hitStopMs({ attacker: 'p2', heavy: true }), 450);
  assert.equal(hitStopMs({ attacker: 'p2', knockdown: true }), 700, 'a knockdown blow stalls 0.7 s whoever lands it');
});

test('sim: a camera player\'s punch registers at full extension — out-stroke + camera lag, atExtension (RULES-09)', () => {
  const bot = makeBot('player', 11);
  const due = [];
  for (let i = 0; i < 300; i++) bot.body.punch(1000, 'left', 'straight', 'head', 0.7);
  for (const p of bot.body.punches) {
    due.push(p.due - 1000);
    assert.equal(p.punch.atExtension, true, 'recognised at extension, like GestureRecognizer');
  }
  const mean = due.reduce((a, b) => a + b, 0) / due.length;
  // moveMs 170 (± 40) to full extension + lagMs 120 (± 25) of camera — not just the 120 ms lag
  assert(mean > 260 && mean < 320, `mean registration ${mean.toFixed(0)} ms after the throw`);
  assert(Math.min(...due) > 120, 'never faster than the arm can extend');
  // the legacy bots keep their old model (keyboard-like: lag only, no flag)
  const legacy = makeBot('smart', 11);
  legacy.body.punch(1000, 'left', 'straight', 'head', 0.7);
  assert(!legacy.body.punches[0].punch.atExtension && legacy.body.punches[0].due - 1000 < 200);
});

test('sim: the renderer hit-stop is emulated — game time stalls on hits, the bot and live time run on', () => {
  let stall = 0;
  const on = simulateBout({ opponent: ROSTER[0], bot: 'player', seed: 5, log: (n, p) => { if (n === 'match:hit') stall += hitStopMs(p); } });
  // match time (result.durationMs) leaves out most of each stall; the real clock (ms) includes it
  const lost = on.ms - on.result.durationMs;
  assert(stall > 1000 && lost > 0.7 * stall * (1 - COMBAT.hitStop.scale), `stalled ${stall} ms of hits, real − game ${lost.toFixed(0)} ms`);
  const off = simulateBout({ opponent: ROSTER[0], bot: 'player', seed: 5, hitStop: false });
  // (both include the short KO call → RESULT tail after the result locks)
  assert(Math.abs(off.ms - off.result.durationMs) < 300 && lost > (off.ms - off.result.durationMs) + 1000, `without the hit-stop both clocks agree (${(off.ms - off.result.durationMs).toFixed(0)} ms)`);
});
