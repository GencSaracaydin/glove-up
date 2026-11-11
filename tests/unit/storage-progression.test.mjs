// core/storage.js — progression state (ARCHITECTURE.md §6.8, research/mechanics.md §7): per-opponent
// progress, best rating, tutorial flag, summaries; SES02 idempotency, SAV01 kinds, ERR04, migration.
import { test, assert } from '../harness.mjs';
import { Storage, STORAGE_KEYS, STORAGE_LIMITS, sanitizeProfile, sanitizeOpponents } from '../../src/core/storage.js';
import {
  nextBout, applyBout, rematchRaise, ratingAfterWins, ratingHistory, BASE_RATINGS, GLOVE_UNLOCKS, needsTutorial, isPro,
} from '../../src/game/progression.js';
import { ROSTER } from '../../src/game/roster.js';
import { makeBackend, makeDeterministic, matchResult } from './storage-fakes.test.mjs';

function setup(backend = makeBackend()) {
  const store = new Storage({ backend, ...makeDeterministic() });
  const id = store.createProfile({ name: 'Sam' }).profile.id;
  return { backend, store, id };
}
const raw = (backend, id) => JSON.parse(backend.map.get(STORAGE_KEYS.profile(id)));

/** A single-player bout against `opp` (a roster entry), the way the app reports it. */
function bout(n, opp, { win = true, kd = 0, method = 'KO', endRound = 2 } = {}) {
  return matchResult(`b${n}`, { winner: win ? 'p1' : 'p2', method, endRound, opponentId: opp.id, knockdowns: { p1: kd, p2: win ? 2 : 0 } });
}
/** Play the next bout picked by nextBout through applyBout + recordMatch (what integration does). */
function playNext(store, id, n, o = {}) {
  const profile = store.getProfile(id);
  const b = nextBout(profile);
  const result = bout(n, b.opponent, o);
  const upd = applyBout(profile, result, { opponent: b.opponent });
  const save = store.recordMatch(id, result, upd, { opponentName: b.opponent.name });
  return { b, upd, save, result };
}

test('progression storage: a new profile starts clean (rating 0, tutorial pending, no opponents)', () => {
  const { backend, store, id } = setup();
  const p = store.getProfile(id);
  assert.deepEqual([p.skill, p.pro, p.bestRating, p.tutorialDone], [0, false, 0, false]);
  assert.deepEqual(p.opponents, {});
  assert.equal(needsTutorial(p), true);
  const r = raw(backend, id);
  assert.deepEqual([r.bestRating, r.tutorialDone], [0, false]);
  assert.deepEqual(r.opponents, {});
  const g = store.guest();
  assert.deepEqual([g.bestRating, g.tutorialDone, g.opponents], [0, false, {}]);
});

test('progression storage: recordMatch updates rating, PRO, best, tutorial, opponent and history in one save', () => {
  const { backend, store, id } = setup();
  const opp = ROSTER[0];
  const writes = backend.calls.set.length;
  const { upd, save } = playNext(store, id, 1);
  assert.equal(save.saved, true);
  assert.equal(backend.calls.set.length - writes, 1, 'one setItem for everything');
  const p = store.getProfile(id);
  assert.deepEqual([p.skill, p.pro, p.bestRating, p.tutorialDone], [75, false, 75, true]);
  const raise = rematchRaise(id, opp.id, 1);
  assert.deepEqual(p.opponents[opp.id], { wins: 1, losses: 0, draws: 0, beaten: true, rating: BASE_RATINGS[0] + raise });
  const h = p.records.matches.history.at(-1);
  assert.deepEqual([h.skillBefore, h.skillAfter, h.delta, h.opponentRating, h.rematch], [0, 75, 75, BASE_RATINGS[0], false]);
  // the summary the results card shows, identical to the applyBout preview
  const s = save.summary;
  assert.deepEqual([s.before, s.after, s.delta, s.pro, s.becamePro, s.lostPro, s.bestBefore, s.bestAfter], [0, 75, 75, false, false, false, 0, 75]);
  assert.deepEqual(s.unlocked, []);
  assert.deepEqual(s.opponent, { id: opp.id, ratingBefore: BASE_RATINGS[0], ratingAfter: BASE_RATINGS[0] + raise, rematch: false, wins: 1, losses: 0, draws: 0, beaten: true, rating: BASE_RATINGS[0] + raise });
  assert.deepEqual(s.opponent, upd.opponent, 'storage and the preview agree');
  assert.deepEqual([s.before, s.after, s.delta], [upd.before, upd.skill, upd.delta]);
  // persisted as one JSON
  const r = raw(backend, id);
  assert.deepEqual(r.opponents, p.opponents);
  assert.deepEqual([r.skill, r.pro, r.bestRating, r.tutorialDone], [75, false, 75, true]);
  // the next VS card: the first opponent was just met (the stored history says so), so the next
  // rung (280, +205) comes before a straight rematch at the raised rating
  const next = nextBout(p);
  assert.deepEqual([next.opponent.id, next.reason, next.rating], [ROSTER[1].id, 'fallback', BASE_RATINGS[1]]);
});

test('progression storage: SES02 — the same result id never raises an opponent or the rating twice', () => {
  const { backend, store, id } = setup();
  const { result, upd, save } = playNext(store, id, 1);
  const p1 = store.getProfile(id);
  const again = store.recordMatch(id, result, upd);
  assert.equal(again.duplicate, true);
  assert.deepEqual(store.getProfile(id), p1, 'nothing changed');
  assert.deepEqual([again.summary.before, again.summary.after, again.summary.delta], [save.summary.before, save.summary.after, save.summary.delta]);
  assert.equal(again.summary.opponent.ratingBefore, save.summary.opponent.ratingBefore);
  assert.equal(again.outcome, 'win');
  const reloaded = new Storage({ backend });
  const third = reloaded.recordMatch(id, result, { skill: 9999 });
  assert.equal(third.duplicate, true);
  assert.deepEqual(reloaded.getProfile(id).opponents, p1.opponents);
  assert.equal(reloaded.getProfile(id).skill, 75);
});

test('progression storage: ERR04 — a failed save keeps the session state; the retry writes it exactly once', () => {
  const { backend, store, id } = setup();
  backend.opts.failSet = () => true;
  const { result, upd, save } = playNext(store, id, 1);
  assert.deepEqual([save.ok, save.saved, save.errorCode], [true, false, 'quota']);
  assert.equal(save.summary.after, 75, 'the results card still has its numbers');
  const mem = store.getProfile(id);
  assert.equal(mem.opponents[ROSTER[0].id].wins, 1);
  assert.equal(new Storage({ backend }).getProfile(id).opponents[ROSTER[0].id], undefined, 'nothing false persisted');
  backend.opts.failSet = null;
  const retry = store.recordMatch(id, result, upd);
  assert.deepEqual([retry.saved, retry.duplicate], [true, true]);
  const p = new Storage({ backend }).getProfile(id);
  assert.deepEqual(p.opponents, mem.opponents, 'raised once');
  assert.deepEqual([p.skill, p.records.matches.wins, p.tutorialDone], [75, 1, true]);
});

test('progression storage: losses and draws are tallied per opponent; versus touches none of it (PRG02)', () => {
  const { store, id } = setup();
  store.recordMatch(id, bout(1, ROSTER[0], { win: false }), { skill: 0 });
  store.recordMatch(id, bout(2, ROSTER[0], { win: false, method: 'decision', endRound: 3 }), { skill: 0 });
  store.recordMatch(id, matchResult('d', { winner: null, method: 'draw', opponentId: ROSTER[0].id }), { skill: 5 });
  let p = store.getProfile(id);
  assert.deepEqual(p.opponents[ROSTER[0].id], { wins: 0, losses: 2, draws: 1, beaten: false, rating: null });
  assert.equal(p.tutorialDone, true, 'any single-player bout completes the tutorial');
  const before = JSON.stringify([p.skill, p.pro, p.bestRating, p.opponents]);
  const v = store.recordMatch(id, matchResult('v', { mode: 'versus', winner: 'p1', opponentId: null }), { skill: 4000 }, { side: 'p1' });
  assert.equal(v.saved, true);
  p = store.getProfile(id);
  assert.equal(JSON.stringify([p.skill, p.pro, p.bestRating, p.opponents]), before, 'versus left the rating, PRO, best and opponents alone');
  assert.equal(v.summary.delta, 0);
  assert.equal(v.summary.opponent, null);
  // versus-only profiles still get the tutorial for their first single-player bout
  const other = store.createProfile({ name: 'Vee' }).profile.id;
  store.recordMatch(other, matchResult('vv', { mode: 'versus' }), null);
  assert.equal(store.getProfile(other).tutorialDone, false);
});

test('progression storage: PRO follows the rating (1000 or more); unlocks follow the best rating and are reported once', () => {
  const { store, id } = setup();
  store.updateProfile(id, { skill: 960 });
  let p = store.getProfile(id);
  assert.deepEqual([p.pro, p.bestRating], [false, 960]);
  const up = store.recordMatch(id, bout(1, ROSTER[6]), { skill: 1000, pro: false });
  assert.equal(up.summary.becamePro, true);
  assert.equal(store.getProfile(id).pro, true, 'exactly 1000 is PRO, whatever the caller said');
  assert.deepEqual(up.summary.unlocked.map((u) => u.id), GLOVE_UNLOCKS.filter((u) => u.at === 1000).map((u) => u.id));
  const down = store.recordMatch(id, bout(2, ROSTER[7], { win: false }), { skill: 960 });
  assert.deepEqual([down.summary.lostPro, down.summary.pro, down.summary.unlocked.length], [true, false, 0]);
  p = store.getProfile(id);
  assert.deepEqual([p.pro, p.bestRating], [false, 1000], 'best rating kept after losing PRO');
  const back = store.recordMatch(id, bout(3, ROSTER[7]), { skill: 1010 });
  assert.deepEqual([back.summary.becamePro, back.summary.unlocked.length], [true, 0], 'no second unlock');
  const top = store.recordMatch(id, bout(4, ROSTER[9]), { skill: 1650 });
  assert.deepEqual(top.summary.unlocked.map((u) => u.at), [1600, 1600]);
  assert.equal(store.updateProfile(id, { skill: 400, pro: true }).profile.pro, false, 'a pro patch cannot contradict the rating');
  assert.equal(store.getProfile(id).bestRating, 1650);
});

test('progression storage: old saved profiles migrate on load (opponents, best, tutorial, PRO derived)', () => {
  const a = ROSTER[0].id, b = ROSTER[1].id;
  const hist = (id, mode, opponentId, outcome, skillBefore, skillAfter) => ({
    id, t: 1, mode, side: 'p1', opponentId, opponentName: 'X', outcome, method: 'KO', endRound: 1, skillBefore, skillAfter, delta: skillAfter - skillBefore, pro: false,
  });
  const oldProfile = { // first-build shape: no opponents / bestRating / tutorialDone, PRO was "> 1000"
    schema: 1, id: 'old1', name: 'Oldie', kind: 'local', appearance: {}, calibration: null, skill: 1000, pro: false,
    records: {
      matches: { wins: 3, losses: 1, draws: 0, kos: 3, history: [
        hist('m1', 'single', a, 'win', 0, 700), hist('m2', 'single', b, 'loss', 700, 650), hist('m3', 'single', a, 'win', 650, 1040),
        hist('v1', 'versus', null, 'win', 1040, 1040), hist('m4', 'single', b, 'win', 1040, 1000),
      ] },
      versus: { wins: 1, losses: 0, draws: 0, kos: 1 }, training: {}, applied: ['m1', 'm2', 'm3', 'v1', 'm4'],
    },
    createdAt: 1, updatedAt: 2,
  };
  const fresh = { schema: 1, id: 'old2', name: 'Newbie', kind: 'local', appearance: {}, skill: 0, pro: false, records: { matches: { wins: 0, losses: 0, draws: 0, kos: 0, history: [] } } };
  const backend = makeBackend({ seed: {
    [STORAGE_KEYS.index]: JSON.stringify(['old1', 'old2']),
    [STORAGE_KEYS.profile('old1')]: JSON.stringify(oldProfile),
    [STORAGE_KEYS.profile('old2')]: JSON.stringify(fresh),
  } });
  const store = new Storage({ backend, ...makeDeterministic() });
  assert.equal(store.status().issues.length, 0, 'old profiles load without complaint');
  const p = store.getProfile('old1');
  assert.deepEqual([p.skill, p.pro, p.bestRating, p.tutorialDone], [1000, true, 1040, true]);
  assert.deepEqual(p.opponents[a], { wins: 2, losses: 0, draws: 0, beaten: true, rating: ratingAfterWins('old1', a, 2) });
  assert.deepEqual(p.opponents[b], { wins: 1, losses: 1, draws: 0, beaten: true, rating: ratingAfterWins('old1', b, 1) });
  assert.equal(p.records.matches.history.length, 5, 'history kept');
  assert.equal(p.records.matches.history[0].opponentRating, null);
  assert.equal(p.records.matches.history[0].rematch, false);
  const q = store.getProfile('old2');
  assert.deepEqual([q.tutorialDone, q.bestRating, q.opponents], [false, 0, {}], 'a profile that never fought still gets the tutorial');
  // play on from the migrated state: the raise continues from the derived rating
  const r = store.recordMatch('old1', bout(9, ROSTER[1]), { skill: 1067 });
  assert.equal(r.summary.opponent.ratingBefore, ratingAfterWins('old1', b, 1));
  assert.equal(store.getProfile('old1').opponents[b].rating, ratingAfterWins('old1', b, 2));
  assert.equal(r.summary.opponent.rematch, true);
  // the migrated fields are written with the next save and survive a reload
  const again = new Storage({ backend }).getProfile('old1');
  assert.deepEqual(again.opponents, store.getProfile('old1').opponents);
  assert.equal(raw(backend, 'old1').tutorialDone, true);
  assert.equal(nextBout(again).opponent != null, true);
});

test('progression storage: markTutorialDone — saved for local boxers, memory only for guests, idempotent', () => {
  const { backend, store, id } = setup();
  const r = store.markTutorialDone(id);
  assert.deepEqual([r.ok, r.saved, r.profile.tutorialDone], [true, true, true]);
  assert.equal(new Storage({ backend }).getProfile(id).tutorialDone, true);
  const writes = backend.calls.set.length;
  const again = store.markTutorialDone(id);
  assert.deepEqual([again.ok, again.saved, again.duplicate], [true, true, true]);
  assert.equal(backend.calls.set.length, writes, 'no extra write');
  const g = store.guest();
  const gr = store.markTutorialDone(g.id);
  assert.deepEqual([gr.ok, gr.saved, gr.reason], [true, false, 'guest']);
  assert.equal(store.getProfile(g.id).tutorialDone, true);
  assert.equal(backend.calls.set.length, writes, 'guest never written');
  assert.equal(store.markTutorialDone('nobody').ok, false);
  assert.equal(store.updateProfile(id, { tutorialDone: false }).profile.tutorialDone, false, 'debug patch');
});

test('progression storage: guests climb the ladder in memory; visiting boxers keep their home seed', () => {
  const home = setup();
  for (let n = 1; n <= 3; n++) playNext(home.store, home.id, n);
  const homeP = home.store.getProfile(home.id);
  const json = home.store.exportProfile(home.id);
  const exported = JSON.parse(json).profile;
  assert.deepEqual([exported.bestRating, exported.tutorialDone], [homeP.bestRating, true]);
  assert.deepEqual(exported.opponents, homeP.opponents);
  // on another device
  const away = setup();
  const visit = away.store.importPortable(json).profile;
  assert.equal(visit.kind, 'portable');
  assert.deepEqual(visit.opponents, homeP.opponents);
  const writes = away.backend.calls.set.length;
  const vs = playNext(away.store, visit.id, 4);
  const hs = playNext(home.store, home.id, 4);
  assert.equal(vs.save.saved, false);
  assert.equal(vs.save.reason, 'portable');
  assert.equal(away.backend.calls.set.length, writes, 'a visiting boxer is never written here');
  assert.equal(vs.b.opponent.id, hs.b.opponent.id, 'same next bout on both devices');
  assert.deepEqual(vs.save.summary.opponent, hs.save.summary.opponent, 'the same raise on both devices (seeded by the home id)');
  // a guest's ladder works within the session and is never written
  const g = away.store.guest();
  const gs = playNext(away.store, g.id, 1);
  assert.deepEqual([gs.save.saved, gs.save.reason], [false, 'guest']);
  assert.equal(away.store.getProfile(g.id).opponents[ROSTER[0].id].wins, 1);
  assert.equal(nextBout(away.store.getProfile(g.id)).opponent.id, ROSTER[1].id, 'the in-memory history steers the next bout too');
  assert.equal(away.backend.calls.set.length, writes);
});

test('progression storage: history keeps 50 single-player and 50 versus bouts; the rating graph is never crowded out', () => {
  const { store, id } = setup();
  for (let i = 0; i < 60; i++) store.recordMatch(id, matchResult(`s${i}`, { opponentId: ROSTER[0].id }), { skill: (i + 1) * 10 });
  for (let i = 0; i < 70; i++) store.recordMatch(id, matchResult(`v${i}`, { mode: 'versus' }), null);
  const p = store.getProfile(id);
  const h = p.records.matches.history;
  assert.equal(h.filter((x) => x.mode !== 'versus').length, STORAGE_LIMITS.matchHistory);
  assert.equal(h.filter((x) => x.mode === 'versus').length, STORAGE_LIMITS.versusHistory);
  assert.equal(h.at(-1).id, 'v69', 'order kept');
  const g = ratingHistory(p, { withStart: true });
  assert.equal(g.length, 51);
  assert.deepEqual([g[0].start, g[0].rating, g.at(-1).rating], [true, 100, 600]);
  assert.equal(p.opponents[ROSTER[0].id].wins, 60, 'per-opponent tallies keep counting past the cap');
  // a reload keeps the same caps
  assert.equal(sanitizeProfile(JSON.parse(JSON.stringify(p))).records.matches.history.length, 100);
});

test('progression storage: unknown opponent ids are tallied without a rating; junk ids are not stored', () => {
  const { store, id } = setup();
  const r = store.recordMatch(id, matchResult('u1', { opponentId: 'opp-1' }), { skill: 75 });
  assert.deepEqual(store.getProfile(id).opponents['opp-1'], { wins: 1, losses: 0, draws: 0, beaten: true, rating: null });
  assert.deepEqual([r.summary.opponent.ratingBefore, r.summary.opponent.ratingAfter], [null, null]);
  store.recordMatch(id, matchResult('u2', { opponentId: 'not an id!' }), { skill: 150 });
  assert.equal('not an id!' in store.getProfile(id).opponents, false);
  assert.equal(store.getProfile(id).records.matches.wins, 2);
  assert.deepEqual(sanitizeOpponents({ ok: { wins: 2, rating: 400 }, 'bad id': { wins: 1 }, x: 'junk' }), { ok: { wins: 2, losses: 0, draws: 0, beaten: true, rating: 400 } });
  assert.deepEqual(sanitizeOpponents(null), {});
  // a crafted boxer file cannot reach an object prototype through an opponent id
  const crafted = JSON.parse('{"name":"Sly","appearance":{},"opponents":{"__proto__":{"wins":5,"beaten":true},"constructor":{"wins":1}}}');
  const imp = store.importPortable(crafted);
  assert.equal(imp.ok, true);
  assert.deepEqual(Object.keys(imp.profile.opponents), []);
  assert.equal(Object.getPrototypeOf(imp.profile.opponents), Object.prototype);
  const viaResult = store.recordMatch(id, matchResult('u3', { opponentId: '__proto__' }), { skill: 225 });
  assert.equal(viaResult.ok, true);
  assert.equal(viaResult.summary.opponent, null);
  assert.equal(Object.getPrototypeOf(store.getProfile(id).opponents), Object.prototype);
  assert.equal(store.recordMatch(id, matchResult('u4', { opponentId: 'constructor' }), { skill: 300 }).summary.opponent, null);
  // an id that names an inherited member is an ordinary own key, never the built-in
  const ts = store.recordMatch(id, matchResult('u5', { opponentId: 'toString' }), { skill: 375 });
  assert.deepEqual(ts.summary.opponent.wins, 1);
  assert.deepEqual(store.getProfile(id).opponents.toString, { wins: 1, losses: 0, draws: 0, beaten: true, rating: null });
  const derived = sanitizeProfile({ id: 'h1', name: 'H', appearance: {}, records: { matches: { wins: 2, history: [
    { id: 'a', mode: 'single', opponentId: 'toString', outcome: 'win' }, { id: 'b', mode: 'single', opponentId: 'hasOwnProperty', outcome: 'loss' },
  ] } } });
  assert.deepEqual(Object.keys(derived.opponents).sort(), ['hasOwnProperty', 'toString']);
  assert.equal(derived.opponents.toString.wins, 1);
  assert.equal(Object.prototype.toString.wins, undefined, 'built-ins untouched');
  assert.equal(nextBout(store.getProfile(id)).opponent.id, ROSTER[0].id, 'stray ids do not disturb matchmaking');
});

test('progression storage: a whole career through storage — reloads agree with memory at every step', () => {
  const backend = makeBackend();
  const { store, id } = setup(backend);
  const unlockedAt = [];
  let reasons = '';
  for (let n = 1; n <= 26; n++) {
    const { b, save } = playNext(store, id, n, { kd: n % 5 === 0 ? 1 : 0 });
    reasons += b.reason[0];
    assert.equal(save.saved, true);
    for (const u of save.summary.unlocked) unlockedAt.push([u.at, save.summary.after]);
    assert.deepEqual(new Storage({ backend }).getProfile(id), store.getProfile(id), `bout ${n} reloads identically`);
  }
  const p = store.getProfile(id);
  assert.equal(reasons[0], 'f');
  assert(reasons.includes('n') && reasons.includes('r'), `new opponents and rematches (${reasons})`);
  assert(ROSTER.every((d) => p.opponents[d.id]?.beaten), 'all ten beaten');
  assert(isPro(p.skill) && p.pro, `PRO at ${p.skill}`);
  assert.deepEqual(unlockedAt.map(([at]) => at), [1000, 1000, 1600, 1600], 'each colour announced exactly once');
  assert(unlockedAt.every(([at, after]) => after >= at));
  assert.equal(ratingHistory(p).length, 26);
  assert(p.tutorialDone && p.bestRating === p.skill);
});
