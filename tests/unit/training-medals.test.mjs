// Medal cutoffs (TRN02): thresholds, helpers, and calibration against scripted players —
// a beginner earns bronze, platinum takes real skill, doing nothing earns nothing.
import { test, assert } from '../harness.mjs';
import { Medal, TrainingKind } from '../../src/core/types.js';
import { MEDAL_CUTOFFS, MEDAL_ORDER, medalFor, medalRank, betterMedal, nextMedal } from '../../src/training/medals.js';
import { createActivity, makeTrainingBot } from '../../src/training/session.js';

const KINDS = [TrainingKind.BAG, TrainingKind.DODGE, TrainingKind.MITTS];

test('training-medals: every activity has strictly increasing bronze < silver < gold < platinum', () => {
  for (const k of KINDS) {
    const c = MEDAL_CUTOFFS[k];
    assert(c, k);
    assert(c.bronze > 0 && c.bronze < c.silver && c.silver < c.gold && c.gold < c.platinum, `${k}: ${JSON.stringify(c)}`);
  }
});

test('training-medals: medalFor thresholds are inclusive; junk input earns nothing', () => {
  for (const k of KINDS) {
    const c = MEDAL_CUTOFFS[k];
    assert.equal(medalFor(k, 0), Medal.NONE);
    assert.equal(medalFor(k, c.bronze - 1), Medal.NONE);
    assert.equal(medalFor(k, c.bronze), Medal.BRONZE);
    assert.equal(medalFor(k, c.silver), Medal.SILVER);
    assert.equal(medalFor(k, c.gold - 1), Medal.SILVER);
    assert.equal(medalFor(k, c.gold), Medal.GOLD);
    assert.equal(medalFor(k, c.platinum), Medal.PLATINUM);
    assert.equal(medalFor(k, c.platinum * 10), Medal.PLATINUM);
  }
  assert.equal(medalFor('fitness', 9999), Medal.NONE);
  assert.equal(medalFor('bag', NaN), Medal.NONE);
});

test('training-medals: helpers (rank, better, next)', () => {
  assert.deepEqual([...MEDAL_ORDER], ['none', 'bronze', 'silver', 'gold', 'platinum']);
  assert(medalRank('gold') > medalRank('silver'));
  assert.equal(medalRank('bogus'), 0);
  assert.equal(betterMedal('silver', 'gold'), 'gold');
  assert.equal(betterMedal('gold', 'bronze'), 'gold');
  const n = nextMedal('dodge', MEDAL_CUTOFFS.dodge.silver);
  assert.equal(n.medal, 'gold');
  assert.equal(n.need, MEDAL_CUTOFFS.dodge.gold - MEDAL_CUTOFFS.dodge.silver);
  assert.equal(nextMedal('dodge', MEDAL_CUTOFFS.dodge.platinum), null);
  assert.equal(nextMedal('nope', 1), null);
});

function play(kind, skill, seed) {
  const act = createActivity(kind, { rng: seed * 101 });
  const bot = skill == null ? null : makeTrainingBot(kind, { skill, seed: seed * 7 });
  let now = 0;
  for (let i = 0; i < 66 * 60 && !act.isDone(); i++) {
    now += 1000 / 60;
    act.update(1 / 60, now, bot ? bot.update(act.getView()) : null);
  }
  assert(act.isDone(), `${kind} finished`);
  return act.getResult();
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

test('training-medals: calibrated with scripted players (beginner → bronze … expert → platinum)', () => {
  const SEEDS = [1, 2, 3, 4, 5];
  const table = {};
  for (const kind of KINDS) {
    const rank = (skill) => medalRank(medalFor(kind, median(SEEDS.map((s) => play(kind, skill, s).score))));
    const r = { idle: rank(null), beginner: rank(0.2), average: rank(0.5), good: rank(0.75), expert: rank(0.95) };
    table[kind] = r;
    assert.equal(r.idle, 0, `${kind}: doing nothing earns nothing`);
    assert(r.beginner >= medalRank('bronze') && r.beginner <= medalRank('silver'), `${kind}: beginner ${JSON.stringify(r)}`);
    assert(r.average >= medalRank('silver') && r.average <= medalRank('gold'), `${kind}: average ${JSON.stringify(r)}`);
    assert(r.good >= medalRank('gold'), `${kind}: good ${JSON.stringify(r)}`);
    assert.equal(r.expert, medalRank('platinum'), `${kind}: expert ${JSON.stringify(r)}`);
    assert(r.beginner <= r.average && r.average <= r.good && r.good <= r.expert, `${kind}: monotonic`);
  }
});

test('training-medals: the result of an attempt carries its medal', () => {
  const r = play('dodge', 0.95, 3);
  assert.equal(r.medal, medalFor('dodge', r.score));
});
