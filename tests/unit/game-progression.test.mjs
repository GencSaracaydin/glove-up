// game/progression.js — rating formula (research/mechanics.md §7.1/§7.5), PRO at 1000 or more
// (§7.3, PRG02), versus never rated (A11), opponent ratings + matchmaking (§7.2/§7.5, PRG01).
import { test, assert } from '../harness.mjs';
import {
  PRO_THRESHOLD, SKILL, BASE_RATINGS, skillDelta, winDelta, lossDelta, applySkill, isPro, ratingOf,
  nextOpponent, unlockedOpponents, ladderPosition, baseRating, reachRating, opponentRating,
} from '../../src/game/progression.js';
import { ROSTER, CHAMPION } from '../../src/game/roster.js';

const result = (o = {}) => ({
  id: 'r', winner: 'p1', method: 'KO', endRound: 2, endClockMs: 0, scorecards: [],
  stats: { p1: { thrown: 40, landed: 20, damageDealt: 120, knockdownsScored: 3 }, p2: { thrown: 30, landed: 10, damageDealt: 60, knockdownsScored: 0 } },
  knockdowns: { p1: 0, p2: 3 }, mode: 'single', opponentId: ROSTER[2].id, ...o,
});
const won = (R, kd = 0, endRound = 2, o = {}) => skillDelta({ result: result({ knockdowns: { p1: kd, p2: 3 }, endRound, ...o }), playerSkill: R });

// Appendix A of research/mechanics.md: [bout, R before, observed Δ, player knockdowns, round it ended]
const OBSERVED = [
  ['B01', 0, 75, 0, 1], ['B02', 75, 74, 0, 1], ['B03', 149, 76, 0, 1], ['B04', 225, 74, 0, 1], ['B05', 299, 73, 0, 1],
  ['B06', 372, 73, 0, 1], ['B07', 445, 73, 0, 1], ['B08', 518, 72, 0, 1], ['B09', 590, 33, 1, 2], ['B10', 623, 71, 0, 1],
  ['B11', 694, 52, 1, 1], ['B12', 746, 70, 0, 2], ['B13', 816, 71, 0, 1], ['B14', 887, 48, 1, 2], ['B15', 935, -4, 2, 3],
  ['B16', 931, 47, 1, 2], ['B17', 978, 69, 0, 2], ['B18', 1047, 53, 1, 2], ['B19', 1100, 70, 0, 2], ['B20', 1170, 68, 0, 2],
  ['B21', 1238, 64, 0, 2], ['B22', 1302, 68, 0, 2], ['B23', 1370, 67, 0, 2], ['B24', 1437, 38, 1, 2], ['B25', 1475, 66, 0, 2],
  ['B26', 1541, 63, 0, 2], ['B27', 1656, 10, 2, 2],
];

test('progression: versus bouts never change the rating (PRG02 / A11)', () => {
  for (const winner of ['p1', 'p2', null]) {
    for (const playerId of ['p1', 'p2']) {
      assert.equal(skillDelta({ result: result({ mode: 'versus', winner }), playerId, playerSkill: 500 }), 0);
    }
  }
  assert.equal(skillDelta({ result: null }), 0);
  assert.equal(skillDelta(), 0);
});

test('progression: win formula hits the §7.1 examples (clean KO at 816 → +69, a knockdown costs 20)', () => {
  assert.equal(won(0), 75);
  assert.equal(won(816), 69, 'clean KO at R 816');
  assert.equal(won(816, 1), 49, 'one knockdown: 20 less');
  assert.equal(won(816, 2), 14, 'two knockdowns: 20 + 35 less');
  assert.equal(won(816, 0, 3), 59, 'went to round 3: 10 less');
  assert.equal(won(1541), 64, 'falls slowly with rating (+63 observed at 1541)');
  assert.equal(won(887, 1), 48, 'B14 exactly');
  // the round of the KO makes no difference before round 3 (§7.1: +71 R1 at 816, +70 R2 at 746)
  assert.equal(won(816, 0, 1), won(816, 0, 2));
  // heavy damage without a knockdown does not count; neither does the opponent's rating
  assert.equal(won(1238, 0, 2, { stats: { p1: { damageDealt: 10 }, p2: { damageDealt: 999, knockdownsScored: 0 } } }), won(1238));
  assert.equal(skillDelta({ result: result({ opponentId: CHAMPION.id }), playerSkill: 500 }), skillDelta({ result: result({ opponentId: ROSTER[0].id }), playerSkill: 500 }));
});

test('progression: win formula stays within 18 of every observed bout (Appendix A), within 3 for clean wins', () => {
  for (const [bout, R, obs, kd, endRound] of OBSERVED) {
    const d = won(R, kd, endRound);
    assert(Number.isInteger(d), `${bout} integer`);
    assert(Math.abs(d - obs) <= 18, `${bout}: formula ${d} vs observed ${obs}`);
    if (kd === 0) assert(Math.abs(d - obs) <= 3, `${bout} (clean): formula ${d} vs observed ${obs}`);
  }
  assert.equal(won(935, 2, 3), 3, 'B15: two knockdowns and round 3 (observed −4)');
  assert.equal(won(1656, 2), 8, 'B27: two knockdowns late (observed +10)');
});

test('progression: a win never scores below −10; knockdowns read from result.knockdowns or stats', () => {
  assert.equal(won(3000, 2, 3), -10, 'round(75 − 22.2) − 65 = −12 → −10');
  assert.equal(winDelta(20000), -10);
  assert.equal(Object.is(winDelta(10179), -0), false, 'never −0');
  // fallback: the other corner's knockdownsScored when result.knockdowns is missing
  const r = result({ knockdowns: undefined, stats: { p1: {}, p2: { knockdownsScored: 1 } } });
  assert.equal(skillDelta({ result: r, playerSkill: 816 }), 49);
  // the p2 seat is scored from its own perspective
  const asP2 = result({ winner: 'p2', knockdowns: { p1: 3, p2: 1 } });
  assert.equal(skillDelta({ result: asP2, playerId: 'p2', playerSkill: 816 }), 49);
  assert.equal(skillDelta({ result: asP2, playerId: 'p1', playerSkill: 816 }), SKILL.lossKO);
});

test('progression: losses −40 by KO / −25 on points, draw +5, floor 0', () => {
  assert.equal(skillDelta({ result: result({ winner: 'p2', method: 'KO' }), playerSkill: 300 }), -40);
  assert.equal(skillDelta({ result: result({ winner: 'p2', method: 'TKO' }), playerSkill: 300 }), -40);
  assert.equal(skillDelta({ result: result({ winner: 'p2', method: 'decision' }), playerSkill: 300 }), -25);
  assert.equal(lossDelta('KO'), -40);
  assert.equal(lossDelta(undefined), -25);
  const draw = skillDelta({ result: result({ winner: null, method: 'draw', endRound: 3 }), playerSkill: 300 });
  assert.equal(draw, 5);
  assert(draw > lossDelta('decision') && draw < won(300, 0, 3), 'a draw sits between a points loss and any clean win');
  assert.equal(applySkill({ skill: 25 }, -40).skill, 0, 'rating floor 0');
  assert.equal(applySkill({ skill: 0 }, -25).delta, 0, 'delta reports what really changed');
});

test('progression: PRO is 1000 or more — earned at exactly 1000 and lost below it (PRG02)', () => {
  assert.equal(PRO_THRESHOLD, 1000);
  assert.equal(isPro(999), false);
  assert.equal(isPro(1000), true);
  assert.equal(isPro(1017), true, 'r1017 had a badge (§7.3)');
  assert.equal(isPro(981), false, 'r981 had none');
  assert.equal(isPro({ skill: 1000 }), true, 'accepts a profile');
  assert.equal(isPro('junk'), false);
  const up = applySkill({ skill: 932, pro: false }, 68);
  assert.deepEqual([up.skill, up.pro, up.becamePro, up.lostPro], [1000, true, true, false]);
  const stay = applySkill({ skill: 1020, pro: true }, 10);
  assert.deepEqual([stay.pro, stay.becamePro, stay.lostPro], [true, false, false]);
  const down = applySkill({ skill: 1010, pro: true }, -25);
  assert.deepEqual([down.skill, down.pro, down.becamePro, down.lostPro], [985, false, false, true]);
  const edge = applySkill({ skill: 1000, pro: true }, -1);
  assert.equal(edge.lostPro, true, '999 is not PRO');
  assert.equal(applySkill(null, 25).skill, 25);
  assert.equal(applySkill({ skill: 100 }, 0).delta, 0);
  assert.equal(ratingOf({ skill: -5 }), 0);
  assert.equal(ratingOf('12'), 12);
});

test('progression: applySkill reports the best rating and glove colours unlocked by this bout', () => {
  const a = applySkill({ skill: 960, bestRating: 960 }, 60);
  assert.equal(a.bestRating, 1020);
  assert.deepEqual(a.unlocked.map((u) => u.at), [1000, 1000]);
  const lost = applySkill({ skill: 1010, bestRating: 1070 }, -40);
  assert.equal(lost.bestRating, 1070, 'best rating never drops');
  assert.deepEqual(lost.unlocked, [], 'nothing new');
  const again = applySkill({ skill: 970, bestRating: 1070 }, 60);
  assert.deepEqual(again.unlocked, [], 'climbing back over 1000 unlocks nothing twice');
});

test('progression: base ratings follow the §4.5 ladder (roster `rating`, else the table by position)', () => {
  assert.deepEqual([...BASE_RATINGS], [120, 280, 450, 600, 750, 900, 1050, 1200, 1400, 1600]);
  assert.deepEqual(ROSTER.map((d) => baseRating(d)), [...BASE_RATINGS].slice(0, ROSTER.length));
  assert.equal(baseRating(ROSTER[3].id), BASE_RATINGS[3], 'by id');
  assert.equal(baseRating({ ...ROSTER[5] }), BASE_RATINGS[5], 'a copy of an entry still resolves by id');
  assert.equal(baseRating({ id: 'x', rating: 777 }), 777, 'a documented rating wins');
  assert.equal(baseRating({ id: 'x', tier: 2 }), BASE_RATINGS[1], 'outside the roster: by tier');
  assert.equal(baseRating('nobody'), null);
  assert.equal(opponentRating(ROSTER[0]), BASE_RATINGS[0], 'no profile → base rating');
  assert.equal(SKILL.nextWithin, 150, 'the next rung is offered once within 150 (§7.2: offers sat 50–148 above)');
  assert.equal(reachRating(ROSTER[0]), 0);
  assert.equal(reachRating(ROSTER[1]), BASE_RATINGS[1] - 150);
});

test('progression: nextOpponent(rating) ramps from the first opponent to the champion (PRG01)', () => {
  assert.equal(nextOpponent(0).id, ROSTER[0].id);
  assert.equal(nextOpponent(-50).id, ROSTER[0].id);
  assert.equal(nextOpponent(5000).id, CHAMPION.id);
  let prev = 0;
  for (let s = 0; s <= 2000; s += 10) {
    const t = ROSTER.indexOf(nextOpponent(s));
    assert(t >= prev, 'never easier with a higher rating');
    prev = t;
  }
  for (const d of ROSTER) assert.equal(nextOpponent(reachRating(d)).id, d.id, `${d.id} offered once within 150`);
  assert.equal(nextOpponent(1450).id, CHAMPION.id, '1600 is within 150 of 1450');
  assert.equal(nextOpponent(1449).id, ROSTER[8].id);
  assert.equal(unlockedOpponents(0).length, 1);
  assert.equal(unlockedOpponents(1450).length, ROSTER.length);
  const lp = ladderPosition(reachRating(ROSTER[3]));
  assert.equal(lp.current.id, ROSTER[3].id);
  assert.equal(lp.next.id, ROSTER[4].id);
  assert.equal(lp.progress01, 0);
  assert.equal(ladderPosition(2000).next, null);
  assert.equal(ladderPosition(1000).pro, true);
});
