// Training sessions: 1–4 participants in turn order, repeat attempts, per-participant results,
// comparison table, personal-best flags, result-screen params, activity factory.
import { test, assert } from '../harness.mjs';
import { TrainingSession, createActivity, ACTIVITIES, SESSION_LIMITS, makeTrainingBot } from '../../src/training/session.js';
import { BagPractice } from '../../src/training/bag.js';
import { DodgeDrill } from '../../src/training/dodge.js';
import { TargetPunching } from '../../src/training/mitts.js';

const prof = (id, name, best = 0, kind = 'local') => ({ id, name, kind, records: { training: { bag: { best }, dodge: { best: 0 }, mitts: { best: 0 } } } });
let n = 0;
const result = (score, kind = 'bag') => ({ id: `r${++n}`, kind, score, medal: score >= 330 ? 'silver' : score >= 180 ? 'bronze' : 'none', details: {}, participantId: 'x' });

test('training-session: factory makes the three activities; unknown kinds throw', () => {
  assert(createActivity('bag') instanceof BagPractice);
  assert(createActivity('dodge') instanceof DodgeDrill);
  assert(createActivity('mitts') instanceof TargetPunching);
  assert.deepEqual(Object.keys(ACTIVITIES).sort(), ['bag', 'dodge', 'mitts']);
  assert.throws(() => createActivity('fitness'));
  assert.throws(() => new TrainingSession({ participants: [prof('a', 'A')], kind: 'nope' }));
});

test('training-session: turns go in order; createActivity is for the current participant', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann'), prof('b', 'Ben'), prof('c', 'Cy')], kind: 'bag', seed: 4 });
  assert.equal(s.turns, 3);
  assert.equal(s.current().participant.name, 'Ann');
  const act = s.createActivity();
  assert.equal(act.participant.name, 'Ann');
  assert.equal(act.kind, 'bag');
  s.record(result(200));
  assert.equal(s.next().participant.name, 'Ben');
  assert.equal(s.createActivity().participant.id, 'b');
  s.record(result(150));
  assert.equal(s.next().participant.name, 'Cy');
  s.record(result(400));
  assert.equal(s.next(), null);
  assert(s.isComplete());
  assert.throws(() => s.createActivity());
  assert.equal(s.record(result(1)), null, 'nothing to record once complete');
});

test('training-session: 1–4 participants (extra ones ignored, none → a guest)', () => {
  const many = new TrainingSession({ participants: [1, 2, 3, 4, 5, 6].map((i) => prof(`p${i}`, `P${i}`)), kind: 'dodge' });
  assert.equal(many.turns, SESSION_LIMITS.maxParticipants);
  const none = new TrainingSession({ participants: [], kind: 'mitts' });
  assert.equal(none.turns, 1);
  assert.equal(none.current().participant.kind, 'guest');
});

test('training-session: retry repeats the same participant; best/latest tracked; record is idempotent', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann', 250), prof('b', 'Ben')], kind: 'bag' });
  const r1 = result(200);
  const e1 = s.record(r1);
  assert.equal(e1.personalBest, false, 'below the stored best of 250');
  assert.equal(s.record(r1), e1, 'same result recorded twice → same entry');
  assert.equal(s.retry().participant.id, 'a');
  assert.equal(s.current().attempt, 2);
  const e2 = s.record(result(300));
  assert.equal(e2.personalBest, true);
  assert.equal(e2.prevBest, 250);
  s.record(result(280));           // third attempt, not a new best (300 now)
  const ann = s.results()[0];
  assert.equal(ann.attempts.length, 3);
  assert.equal(ann.best.score, 300);
  assert.equal(ann.latest.score, 280);
  assert.equal(ann.personalBest, true);
  assert.equal(s.results()[1].played, false);
});

test('training-session: storage save outcome decides the personal-best flag when present', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann', 0)], kind: 'bag' });
  const e = s.record(result(120), { ok: true, saved: true, newBest: false, prevBest: 500 });
  assert.equal(e.personalBest, false);
  assert.equal(e.prevBest, 500);
  const g = new TrainingSession({ participants: [{ id: 'g', name: 'Guest', kind: 'guest' }], kind: 'bag' });
  assert.equal(g.record(result(50)).personalBest, true, 'first score for a guest is a personal best');
  assert.equal(g.record(result(0)).personalBest, false, 'zero is never a best');
});

test('training-session: comparison ranks best scores (ties share a place, unplayed omitted)', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann'), prof('b', 'Ben'), prof('c', 'Cy'), prof('d', 'Di')], kind: 'bag' });
  s.record(result(300)); s.next();
  s.record(result(450)); s.next();
  s.record(result(300)); s.next();
  const rows = s.comparison();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.participant.name), ['Ben', 'Ann', 'Cy']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 2]);
});

test('training-session: screenParams match the training-result screen (latest for the current turn)', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann'), prof('b', 'Ben')], kind: 'mitts' });
  s.record(result(500, 'mitts'));
  let p = s.screenParams();
  assert.equal(p.kind, 'mitts');
  assert.equal(p.results.length, 1);
  assert.equal(p.current, 0);
  assert.equal(p.final, false);
  assert.equal(p.turns, 2);
  s.retry();
  s.record(result(420, 'mitts'));
  p = s.screenParams();
  assert.equal(p.results[0].result.score, 420, 'the attempt just played');
  s.next();
  s.record(result(610, 'mitts'));
  p = s.screenParams();
  assert.equal(p.results.length, 2);
  assert.equal(p.current, 1);
  assert.equal(p.final, true);
  assert.equal(p.results[0].result.score, 500, 'others show their best');
  assert.equal(p.participants.length, 2);
});

test('training-session: a full turn with a bot produces a recordable result', () => {
  const s = new TrainingSession({ participants: [prof('a', 'Ann')], kind: 'dodge', seed: 3 });
  const act = s.createActivity({ durationMs: 8000, readyMs: 500 });
  const bot = makeTrainingBot('dodge', { skill: 0.8, seed: 1 });
  let now = 0;
  for (let i = 0; i < 12 * 60 && !act.isDone(); i++) { now += 1000 / 60; act.update(1 / 60, now, bot.update(act.getView())); }
  assert(act.isDone());
  const e = s.record(act.getResult());
  assert(e && e.result.kind === 'dodge');
  assert.equal(s.results()[0].best, act.getResult());
});
