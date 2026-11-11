// FLOWS-04 regression: the game open in two tabs = two Storage instances over ONE backend. An
// older tab must never overwrite newer progress or settings, nor bring back a deleted boxer —
// whether or not the window 'storage' event (Storage.syncExternal) arrived first.
import { test, assert } from '../harness.mjs';
import { Storage, STORAGE_KEYS } from '../../src/core/storage.js';
import { nextBout, applyBout } from '../../src/game/progression.js';
import { makeBackend, makeDeterministic, matchResult, trainingResult } from './storage-fakes.test.mjs';

/** Two tabs on one backend; the second opens after the first made a boxer. */
function twoTabs() {
  const backend = makeBackend();
  const A = new Storage({ backend, ...makeDeterministic() });
  const id = A.createProfile({ name: 'Twin' }).profile.id;
  const B = new Storage({ backend, idGen: (p) => `${p}_b${Math.random().toString(36).slice(2, 8)}` });
  return { backend, A, B, id };
}
const stored = (backend, id) => JSON.parse(backend.map.get(STORAGE_KEYS.profile(id)));

/** One single-player win the way the app records it: nextBout + applyBout on THIS tab's copy, then recordMatch. */
function winIn(tab, id, n) {
  const profile = tab.getProfile(id);
  const bout = nextBout(profile);
  const result = matchResult(`win-${n}`, { opponentId: bout.opponent.id, knockdowns: { p1: 0, p2: 2 } });
  return tab.recordMatch(id, result, applyBout(profile, result, { opponent: bout.opponent }), { opponentName: bout.opponent.name });
}

test('FLOWS-04: without any storage event, a stale tab never writes an older copy over newer progress', () => {
  const { backend, A, B, id } = twoTabs();
  assert(A.recordTraining(id, trainingResult('a1', { kind: 'bag', score: 300, medal: 'gold' })).saved);
  assert(B.recordTraining(id, trainingResult('b1', { kind: 'mitts', score: 900, medal: 'gold' })).saved);
  const fresh = new Storage({ backend }).getProfile(id);
  assert.deepEqual([fresh.records.training.bag.best, fresh.records.training.mitts.best], [300, 900], 'both drills kept');
  // a bout won in each tab with the same boxer: both count, and the rating adds up
  const a = winIn(A, id, 1);
  const b = winIn(B, id, 2); // B's preview was computed from its older copy (rating 0)
  assert(a.saved && b.saved);
  const p = stored(backend, id);
  assert.deepEqual([p.records.matches.wins, p.records.matches.history.length], [2, 2], 'two wins, two history entries');
  assert.equal(p.skill, a.summary.delta + b.summary.delta, `rating ${p.skill}: both gains kept`);
  assert.deepEqual([b.summary.before, b.summary.after], [a.summary.after, p.skill], 'B\'s results card starts from A\'s rating');
  const opps = Object.values(p.opponents);
  assert.equal(opps.reduce((s, o) => s + o.wins, 0), 2, 'both wins reached the opponents');
  assert.deepEqual(B.getProfile(id), new Storage({ backend }).getProfile(id), 'B now mirrors what is stored');
});

test('FLOWS-04: settings — each tab writes only the keys it changed over the latest stored settings', () => {
  const { backend, A, B } = twoTabs();
  A.saveSettings({ volumes: { master: 0.2, music: 0.1 } });
  const r = B.saveSettings({ sensitivity: 0.9 });
  assert.deepEqual([r.settings.volumes.master, r.settings.volumes.music, r.settings.sensitivity], [0.2, 0.1, 0.9], 'B returns the merged settings');
  const s = new Storage({ backend }).settings();
  assert.deepEqual([s.volumes.master, s.volumes.music, s.volumes.sfx, s.sensitivity], [0.2, 0.1, 0.9, 0.9]);
  // a later change in A keeps B's sensitivity too
  A.saveSettings({ mirror: false });
  const t = new Storage({ backend }).settings();
  assert.deepEqual([t.mirror, t.sensitivity, t.volumes.master], [false, 0.9, 0.2]);
});

test('FLOWS-04: a boxer deleted in one tab is never written back by the other', () => {
  const { backend, A, B, id } = twoTabs();
  const other = A.createProfile({ name: 'Keeper' }).profile.id;
  assert(A.deleteProfile(id).saved);
  const seen = [];
  B.subscribe((c) => seen.push(c));
  const writes = {
    update: () => B.updateProfile(id, { name: 'Twin B' }),
    match: () => B.recordMatch(id, matchResult('late'), { skill: 75 }),
    training: () => B.recordTraining(id, trainingResult('late-t')),
    tutorial: () => B.markTutorialDone(id),
  };
  for (const [name, first] of Object.entries(writes)) {
    // each kind of write, as the first one B attempts after the deletion
    const tabs = twoTabs();
    tabs.A.deleteProfile(tabs.id);
    const C = tabs.B;
    const r = { update: () => C.updateProfile(tabs.id, { name: 'X' }), match: () => C.recordMatch(tabs.id, matchResult('late'), { skill: 75 }),
      training: () => C.recordTraining(tabs.id, trainingResult('late-t')), tutorial: () => C.markTutorialDone(tabs.id) }[name]();
    assert.deepEqual([r.ok, r.saved, r.errorCode], [false, false, 'deleted'], `${name}: ${JSON.stringify(r)}`);
    assert.match(r.error, /deleted in another window/);
    assert(!tabs.backend.map.has(STORAGE_KEYS.profile(tabs.id)), `${name}: not written back`);
    assert.deepEqual(new Storage({ backend: tabs.backend }).listProfiles(), [], `${name}: a reload finds no boxer`);
    const again = first(); // and in the shared pair: refused every time, with the same reason
    assert.deepEqual([again.ok, again.saved, again.errorCode], [false, false, 'deleted'], `${name} (shared pair)`);
  }
  // the 'storage' event may arrive first: B forgets the boxer, and a later save still says why
  const ev = twoTabs();
  ev.A.deleteProfile(ev.id);
  assert.equal(ev.B.syncExternal(STORAGE_KEYS.index), true);
  assert.equal(ev.B.getProfile(ev.id), null);
  const late = ev.B.recordMatch(ev.id, matchResult('late'), { skill: 75 });
  assert.deepEqual([late.ok, late.saved, late.errorCode], [false, false, 'deleted']);
  assert.deepEqual(new Storage({ backend: ev.backend }).listProfiles(), []);
  assert(!backend.map.has(STORAGE_KEYS.profile(id)), 'the profile key stays gone');
  assert.equal(B.getProfile(id), null, 'B forgot it');
  assert(seen.length >= 1 && seen[0].ids.includes(id), 'B\'s screens were told');
  // B keeps working: making a boxer there does not resurrect the deleted one in the index
  const made = B.createProfile({ name: 'New' });
  assert(made.saved);
  const index = JSON.parse(backend.map.get(STORAGE_KEYS.index));
  assert(!index.includes(id) && index.includes(other) && index.includes(made.profile.id), JSON.stringify(index));
  assert.deepEqual(new Storage({ backend }).listProfiles().map((p) => p.name), ['Keeper', 'New']);
  assert.deepEqual(A.listProfiles().map((p) => p.name), ['Keeper', 'New'], 'A sees the boxer B made');
});

test('FLOWS-04: following the index never brings back a boxer this tab deleted (even when its key could not be removed)', () => {
  const backend = makeBackend();
  const A = new Storage({ backend, ...makeDeterministic() });
  const id = A.createProfile({ name: 'Stuck' }).profile.id;
  A.createProfile({ name: 'Other' });
  backend.opts.failRemove = (k) => k === STORAGE_KEYS.profile(id);
  const r = A.deleteProfile(id);
  assert.deepEqual([r.ok, r.saved], [true, false], 'reported as not saved (the editor says "deleted for now")');
  assert.deepEqual(A.listProfiles().map((p) => p.name), ['Other'], 'still gone in this tab');
  assert(!JSON.parse(backend.map.get(STORAGE_KEYS.index)).includes(id), 'and not listed');
});

test('FLOWS-04: a boxer that was never stored (failed first write) is still ours to save', () => {
  const backend = makeBackend();
  const A = new Storage({ backend, ...makeDeterministic() });
  backend.opts.failSet = (k) => k.includes(':profile:');
  const r = A.createProfile({ name: 'Unsaved' });
  assert.deepEqual([r.ok, r.saved], [true, false]);
  backend.opts.failSet = null;
  const u = A.updateProfile(r.profile.id, { name: 'Saved now' });
  assert.deepEqual([u.ok, u.saved], [true, true], 'not mistaken for a deletion elsewhere');
  assert.equal(new Storage({ backend }).getProfile(r.profile.id).name, 'Saved now');
});

test('FLOWS-04: the storage-event hook keeps the other tab\'s mirror fresh (driven by hand)', () => {
  const { backend, A, B, id } = twoTabs();
  const seen = [];
  B.subscribe((c) => seen.push(c));
  // A wins a bout: B's event for that key brings the new rating in before B does anything
  const a = winIn(A, id, 1);
  assert.equal(B.getProfile(id).skill, 0, 'stale until the event arrives');
  assert.equal(B.syncExternal(STORAGE_KEYS.profile(id)), true);
  assert.equal(B.getProfile(id).skill, a.summary.after);
  assert.deepEqual(seen.at(-1), { key: STORAGE_KEYS.profile(id), ids: [id] });
  assert.equal(B.syncExternal(STORAGE_KEYS.profile(id)), false, 'nothing new: no change');
  // a boxer made in A shows up in B; a settings change follows
  const made = A.createProfile({ name: 'Second' }).profile.id;
  B.syncExternal(STORAGE_KEYS.profile(made));
  assert.deepEqual(B.listProfiles().map((p) => p.name), ['Twin', 'Second']);
  A.saveSettings({ reducedMotion: true });
  assert.equal(B.syncExternal(STORAGE_KEYS.settings), true);
  assert.equal(B.settings().reducedMotion, true);
  // deletion: B forgets the boxer as soon as the index event arrives
  A.deleteProfile(made);
  B.syncExternal(STORAGE_KEYS.index);
  assert.equal(B.getProfile(made), null);
  assert.deepEqual(B.listProfiles().map((p) => p.name), ['Twin']);
  // a late event never rolls B back: B saves after A, then A's (older) event is handled
  winIn(A, id, 2);
  const b = winIn(B, id, 3);
  B.syncExternal(STORAGE_KEYS.profile(id)); // the event for A's write arrives after B's own save
  assert.equal(B.getProfile(id).skill, b.summary.after, 'B keeps the newest stored copy');
  assert.equal(B.getProfile(id).records.matches.wins, 3);
  // key null (storage cleared / unknown) → everything re-read; foreign keys are ignored
  assert.equal(B.syncExternal('someone-else:key'), false);
  assert.equal(B.syncExternal(null), false);
  assert.equal(stored(backend, id).records.matches.wins, 3);
});

test('FLOWS-04: with window.localStorage as the backend the storage event is wired automatically', () => {
  const backend = makeBackend();
  const listeners = new Map();
  const saved = { ls: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  Object.defineProperty(globalThis, 'localStorage', { value: backend, configurable: true, writable: true });
  globalThis.addEventListener = (type, fn) => listeners.set(fn, type);
  globalThis.removeEventListener = (type, fn) => listeners.delete(fn);
  try {
    const A = new Storage();
    const B = new Storage();
    assert.equal([...listeners.values()].filter((t) => t === 'storage').length, 2, 'both tabs listen');
    const id = A.createProfile({ name: 'Wired' }).profile.id;
    // the browser fires 'storage' in the OTHER tab for each write; here every listener hears it
    for (const fn of [...listeners.keys()]) fn({ key: STORAGE_KEYS.index, storageArea: backend });
    assert.deepEqual(B.listProfiles().map((p) => p.name), ['Wired']);
    for (const fn of [...listeners.keys()]) fn({ key: STORAGE_KEYS.settings, storageArea: {} });
    B.dispose();
    A.dispose();
    assert.equal(listeners.size, 0, 'dispose removes the listener');
    assert.equal(new Storage({ backend: makeBackend() })._onStorage, null, 'a private backend is not wired by default');
    assert.equal(new Storage({ backend, watch: false })._onStorage, null);
    assert.equal(B.getProfile(id).name, 'Wired');
  } finally {
    if (saved.ls) Object.defineProperty(globalThis, 'localStorage', saved.ls); else delete globalThis.localStorage;
    if (saved.add) globalThis.addEventListener = saved.add; else delete globalThis.addEventListener;
    if (saved.remove) globalThis.removeEventListener = saved.remove; else delete globalThis.removeEventListener;
  }
});
