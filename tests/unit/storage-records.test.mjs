// core/storage.js — play records: SAV01 (local only), SES02 (idempotent by result id), PRG02.
import { test, assert } from '../harness.mjs';
import { Storage, STORAGE_LIMITS, STORAGE_KEYS } from '../../src/core/storage.js';
import { makeBackend, makeDeterministic, matchResult, trainingResult } from './storage-fakes.test.mjs';

function setup() {
  const backend = makeBackend();
  const store = new Storage({ backend, ...makeDeterministic() });
  const id = store.createProfile({ name: 'Sam' }).profile.id;
  return { backend, store, id };
}

test('records: single-player win by KO updates W/KO, skill, Pro and history', () => {
  const { store, id } = setup();
  const r = store.recordMatch(id, matchResult('m1'), { skill: 1040, pro: true, becamePro: true }, { opponentName: 'Pepper' });
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  const p = store.getProfile(id);
  assert.equal(p.records.matches.wins, 1);
  assert.equal(p.records.matches.kos, 1);
  assert.equal(p.skill, 1040);
  assert.equal(p.pro, true);
  const h = p.records.matches.history.at(-1);
  assert.equal(h.id, 'm1');
  assert.equal(h.outcome, 'win');
  assert.equal(h.method, 'KO');
  assert.equal(h.skillBefore, 0);
  assert.equal(h.skillAfter, 1040);
  assert.equal(h.delta, 1040);
  assert.equal(h.opponentName, 'Pepper');
  assert.equal(h.opponentId, 'opp-1');
});

test('records: losses, draws and decisions are counted; TKO counts as a KO win', () => {
  const { store, id } = setup();
  store.recordMatch(id, matchResult('a', { winner: 'p2', method: 'decision' }), { skill: 0 });
  store.recordMatch(id, matchResult('b', { winner: null, method: 'draw' }), { skill: 0 });
  store.recordMatch(id, matchResult('c', { winner: 'p1', method: 'TKO' }), { skill: 30 });
  store.recordMatch(id, matchResult('d', { winner: 'p1', method: 'decision' }), { skill: 60 });
  const m = store.getProfile(id).records.matches;
  assert.deepEqual([m.wins, m.losses, m.draws, m.kos], [2, 1, 1, 1]);
});

test('records: SES02 — the same result id is applied once, even across reloads', () => {
  const { backend, store, id } = setup();
  const first = store.recordMatch(id, matchResult('same'), { skill: 100, pro: false });
  const second = store.recordMatch(id, matchResult('same'), { skill: 200, pro: false });
  assert.equal(first.duplicate, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.saved, true);
  assert.equal(second.duplicate, true);
  let p = store.getProfile(id);
  assert.equal(p.records.matches.wins, 1);
  assert.equal(p.skill, 100, 'second application did not change skill');
  assert.equal(p.records.matches.history.length, 1);
  const reloaded = new Storage({ backend });
  const third = reloaded.recordMatch(id, matchResult('same'), { skill: 300 });
  assert.equal(third.duplicate, true);
  p = reloaded.getProfile(id);
  assert.equal(p.records.matches.wins, 1);
  assert.equal(p.skill, 100);
  // training is idempotent too
  const t1 = reloaded.recordTraining(id, trainingResult('t1', { score: 50 }));
  const t2 = reloaded.recordTraining(id, trainingResult('t1', { score: 50 }));
  assert.equal(t1.newBest, true);
  assert.equal(t2.duplicate, true);
  assert.equal(reloaded.getProfile(id).records.training.bag.plays, 1);
});

test('records: PRG02 — versus bouts never change skill and use a separate tally', () => {
  const { store, id } = setup();
  store.recordMatch(id, matchResult('s1'), { skill: 500, pro: false });
  const r = store.recordMatch(id, matchResult('v1', { mode: 'versus', winner: 'p2', method: 'KO' }), { skill: 9999, pro: true }, { side: 'p2' });
  assert.equal(r.saved, true);
  const p = store.getProfile(id);
  assert.equal(p.skill, 500, 'versus skill update ignored');
  assert.equal(p.pro, false);
  assert.deepEqual(p.records.versus, { wins: 1, losses: 0, draws: 0, kos: 1 }, 'won from the p2 corner');
  assert.equal(p.records.matches.wins, 1, 'single-player tally untouched by versus');
  assert.equal(p.records.matches.history.at(-1).mode, 'versus');
  assert.equal(p.records.matches.history.at(-1).delta, 0);
});

test('records: history caps (50 matches, 20 per training activity)', () => {
  const { store, id } = setup();
  for (let i = 0; i < 60; i++) store.recordMatch(id, matchResult(`m${i}`, { winner: i % 2 ? 'p1' : 'p2', method: 'decision' }), { skill: i });
  for (let i = 0; i < 25; i++) store.recordTraining(id, trainingResult(`t${i}`, { kind: 'dodge', score: i }));
  const p = store.getProfile(id);
  assert.equal(p.records.matches.history.length, STORAGE_LIMITS.matchHistory);
  assert.equal(p.records.matches.history[0].id, 'm10', 'oldest dropped first');
  assert.equal(p.records.matches.wins + p.records.matches.losses, 60, 'tallies keep counting past the cap');
  assert.equal(p.records.training.dodge.history.length, STORAGE_LIMITS.trainingHistory);
  assert.equal(p.records.training.dodge.plays, 25);
  assert.equal(p.records.training.dodge.best, 24);
});

test('records: training best, best medal and new-best flag per activity (TRN02)', () => {
  const { store, id } = setup();
  const a = store.recordTraining(id, trainingResult('a', { kind: 'mitts', score: 300, medal: 'gold' }));
  assert.equal(a.newBest, true);
  assert.equal(a.prevBest, 0);
  const b = store.recordTraining(id, trainingResult('b', { kind: 'mitts', score: 200, medal: 'bronze' }));
  assert.equal(b.newBest, false);
  assert.equal(b.prevBest, 300);
  assert.equal(b.best, 300);
  assert.equal(b.medal, 'gold', 'best medal kept');
  const t = store.getProfile(id).records.training;
  assert.equal(t.mitts.best, 300);
  assert.equal(t.mitts.medal, 'gold');
  assert.equal(t.bag.plays, 0, 'other activities untouched');
  assert.equal(store.recordTraining(id, trainingResult('c', { kind: 'juggling' })).ok, false);
  assert.equal(store.recordTraining(id, { kind: 'bag' }).ok, false, 'missing id rejected');
});

test('records: SAV01 — guest and portable records are never written to storage', () => {
  const { backend, store, id } = setup();
  const portable = store.importPortable(store.exportProfile(id)).profile;
  const guest = store.guest();
  const writesBefore = backend.calls.set.length;
  for (const p of [guest, portable]) {
    const m = store.recordMatch(p.id, matchResult(`m-${p.id}`), { skill: 77, pro: false });
    assert.equal(m.ok, true);
    assert.equal(m.saved, false);
    assert.equal(m.reason, p.kind);
    const t = store.recordTraining(p.id, trainingResult(`t-${p.id}`));
    assert.equal(t.saved, false);
    assert.equal(t.reason, p.kind);
    // in-memory session progress still works (e.g. the ladder within this session)
    assert.equal(store.getProfile(p.id).skill, 77);
    assert.equal(store.getProfile(p.id).records.matches.wins, 1);
  }
  assert.equal(backend.calls.set.length, writesBefore, 'no backend writes for guest/portable');
  const reloaded = new Storage({ backend });
  assert.equal(reloaded.getProfile(guest.id), null);
  assert.equal(reloaded.getProfile(portable.id), null);
  assert.equal(reloaded.getProfile(id).records.matches.wins, 0, 'the original local profile was not touched');
});

test('records: invalid inputs are rejected without throwing', () => {
  const { store, id } = setup();
  assert.equal(store.recordMatch('nobody', matchResult('x')).ok, false);
  assert.equal(store.recordMatch(id, null).ok, false);
  assert.equal(store.recordMatch(id, { winner: 'p1' }).ok, false);
  assert.equal(store.recordTraining(id, null).ok, false);
  const weird = store.recordMatch(id, { id: 'w', winner: 'banana', method: 'magic', mode: 'single' }, { skill: 'lots' });
  assert.equal(weird.ok, true);
  const p = store.getProfile(id);
  assert.equal(p.records.matches.draws, 1, 'unknown winner treated as draw');
  assert.equal(p.records.matches.history.at(-1).method, 'decision');
  assert.equal(p.skill, 0, 'non-numeric skill ignored');
});

test('records: profile JSON in storage carries the records (one key per profile)', () => {
  const { backend, store, id } = setup();
  store.recordTraining(id, trainingResult('t', { kind: 'bag', score: 999, medal: 'platinum' }));
  const raw = JSON.parse(backend.map.get(STORAGE_KEYS.profile(id)));
  assert.equal(raw.records.training.bag.best, 999);
  assert.equal(raw.records.training.bag.medal, 'platinum');
  assert.equal(raw.schema, 1);
});
