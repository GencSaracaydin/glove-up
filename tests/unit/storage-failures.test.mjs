// core/storage.js — ERR04: storage failures never throw and never report a false save;
// corrupt data is quarantined, not crashing.
import { test, assert } from '../harness.mjs';
import { Storage, STORAGE_KEYS, classifyStorageError, saveNotice } from '../../src/core/storage.js';
import { makeBackend, makeDeterministic, matchResult, trainingResult, quotaError } from './storage-fakes.test.mjs';

test('ERR04: quota exceeded on save → {ok:true, saved:false, error}, state kept in memory', () => {
  const backend = makeBackend();
  const store = new Storage({ backend, ...makeDeterministic() });
  const id = store.createProfile({ name: 'Sam' }).profile.id;
  backend.opts.failSet = () => true; // storage full from now on
  const r = store.recordMatch(id, matchResult('m1'), { skill: 120, pro: false });
  assert.equal(r.ok, true);
  assert.equal(r.saved, false);
  assert.equal(r.errorCode, 'quota');
  assert.match(r.error, /full/i);
  assert.equal(store.getProfile(id).skill, 120, 'session continues with the new state');
  assert.equal(new Storage({ backend }).getProfile(id).skill, 0, 'nothing false was persisted');
  const t = store.recordTraining(id, trainingResult('t1'));
  assert.equal(t.saved, false);
  const s = store.saveSettings({ model: 'lite' });
  assert.equal(s.ok, true);
  assert.equal(s.saved, false);
  assert.equal(s.settings.model, 'lite', 'setting applies for this session');
  assert.match(saveNotice(r), /full/i);
});

test('ERR04: retrying the same result after a failed save persists it (SES02 + recovery)', () => {
  const backend = makeBackend();
  const store = new Storage({ backend, ...makeDeterministic() });
  const id = store.createProfile({ name: 'Sam' }).profile.id;
  backend.opts.failSet = () => true;
  assert.equal(store.recordMatch(id, matchResult('m1'), { skill: 120 }).saved, false);
  backend.opts.failSet = null; // space freed
  const retry = store.recordMatch(id, matchResult('m1'), { skill: 120 });
  assert.equal(retry.saved, true);
  assert.equal(retry.duplicate, true);
  const p = new Storage({ backend }).getProfile(id);
  assert.equal(p.skill, 120);
  assert.equal(p.records.matches.wins, 1, 'applied exactly once');
});

test('ERR04: a real byte quota — big writes fail, nothing throws', () => {
  const backend = makeBackend({ quotaChars: 2500 });
  const store = new Storage({ backend, ...makeDeterministic() });
  const id = store.createProfile({ name: 'Sam' }).profile.id;
  let failures = 0;
  for (let i = 0; i < 40; i++) {
    const r = store.recordMatch(id, matchResult(`m${i}`), { skill: i });
    assert.equal(r.ok, true);
    if (!r.saved) { failures++; assert.equal(r.errorCode, 'quota'); }
  }
  assert(failures > 0, 'quota was eventually hit');
});

test('ERR04: storage disabled (getItem/setItem throw SecurityError) → memory-only session', () => {
  const backend = makeBackend({ failGet: () => true, failSet: () => true });
  const store = new Storage({ backend });
  assert.equal(store.status().writable, false);
  const r = store.createProfile({ name: 'Private' });
  assert.equal(r.ok, true);
  assert.equal(r.saved, false);
  assert.equal(typeof r.error, 'string');
  assert.equal(store.listProfiles().length, 1, 'profile usable for this session');
  const m = store.recordMatch(r.profile.id, matchResult('m'), { skill: 10 });
  assert.equal(m.ok, true);
  assert.equal(m.saved, false);
  assert.equal(store.deleteProfile(r.profile.id).ok, true);
});

test('ERR04: no backend at all (null) and a backend without the API', () => {
  for (const backend of [null, {}, { getItem: 1 }]) {
    const store = new Storage({ backend });
    assert.equal(store.status().available, false);
    const r = store.createProfile({ name: 'Nobody' });
    assert.equal(r.ok, true);
    assert.equal(r.saved, false);
    assert.equal(r.errorCode, 'unavailable');
    assert.equal(store.saveSettings({ mirror: false }).saved, false);
    assert.equal(store.settings().mirror, false);
  }
});

test('corrupt JSON: profile, index and settings are quarantined and the rest still loads', () => {
  const good = { id: 'good', name: 'Good', kind: 'local', appearance: {}, records: {} };
  const backend = makeBackend({
    seed: {
      [STORAGE_KEYS.index]: JSON.stringify(['good', 'bad', 'missing']),
      [STORAGE_KEYS.profile('good')]: JSON.stringify(good),
      [STORAGE_KEYS.profile('bad')]: '{"id": "bad", "name": ',
      [STORAGE_KEYS.settings]: '{{{{',
    },
  });
  const store = new Storage({ backend, ...makeDeterministic() });
  assert.deepEqual(store.listProfiles().map((p) => p.id), ['good']);
  assert.equal(store.settings().model, 'auto', 'settings reset to defaults (PERF-06: the tracking model defaults to auto)');
  const st = store.status();
  assert.equal(st.issues.length, 2);
  assert(st.issues.every((i) => i.code === 'corrupt' && i.quarantinedAs), 'both quarantined');
  assert(!backend.map.has(STORAGE_KEYS.profile('bad')), 'corrupt profile moved out of the way');
  const q = [...backend.map.keys()].filter((k) => k.startsWith(STORAGE_KEYS.quarantinePrefix));
  assert.equal(q.length, 2);
  assert.equal(backend.map.get(q.find((k) => k.includes('profile:bad'))), '{"id": "bad", "name": ', 'raw value preserved');
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.index)), ['good'], 'index repaired');
  // the next load is clean
  assert.equal(new Storage({ backend }).status().issues.length, 0);
});

test('corrupt index: rebuilt from profile keys (orphans recovered)', () => {
  const backend = makeBackend({
    seed: {
      [STORAGE_KEYS.index]: '"not an array"',
      [STORAGE_KEYS.profile('a1')]: JSON.stringify({ id: 'a1', name: 'A', appearance: {} }),
      [STORAGE_KEYS.profile('b2')]: JSON.stringify({ id: 'b2', name: 'B', appearance: {} }),
    },
  });
  const store = new Storage({ backend });
  assert.deepEqual(store.listProfiles().map((p) => p.name).sort(), ['A', 'B']);
  assert.equal(store.status().issues.length, 1);
});

test('corrupt shapes: wrong types inside a profile are repaired field by field', () => {
  const backend = makeBackend({
    seed: {
      [STORAGE_KEYS.index]: JSON.stringify(['x1']),
      [STORAGE_KEYS.profile('x1')]: JSON.stringify({
        id: 'x1', name: 42, skill: 'high', pro: 'yes', appearance: 'blue',
        records: { matches: { wins: -3, history: [null, { id: 'ok', outcome: 'win' }, 'junk'] }, training: { bag: { best: 'a', history: 'b' } } },
      }),
      [STORAGE_KEYS.profile('arr')]: '[1,2,3]',
    },
  });
  const store = new Storage({ backend });
  const p = store.getProfile('x1');
  assert.equal(p.name, 'Boxer', 'a name that is not a string falls back (FLOWS-11), never "42" or "[object Object]"');
  assert.equal(p.skill, 0);
  assert.equal(p.pro, false, 'pro always follows the rating (0 → not PRO), whatever was stored');
  assert.equal(p.records.matches.wins, 0);
  assert.equal(p.records.matches.history.length, 1);
  assert.equal(p.records.training.bag.best, 0);
  assert.equal(store.getProfile('arr'), null, 'non-object profile quarantined');
});

test('quarantine copy that cannot be written leaves the original in place but still loads', () => {
  const backend = makeBackend({
    seed: { [STORAGE_KEYS.index]: JSON.stringify(['z9']), [STORAGE_KEYS.profile('z9')]: 'garbage' },
    failSet: (k) => k.includes('quarantine'),
  });
  const store = new Storage({ backend });
  assert.equal(store.listProfiles().length, 0);
  assert.equal(store.status().issues[0].quarantinedAs, null);
});

test('errors are classified', () => {
  assert.equal(classifyStorageError(quotaError()).code, 'quota');
  assert.equal(classifyStorageError({ name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 }).code, 'quota');
  assert.equal(classifyStorageError(new DOMException('denied', 'SecurityError')).code, 'unavailable');
  assert.equal(classifyStorageError(new Error('weird')).code, 'unknown');
  assert.equal(classifyStorageError(undefined).code, 'unknown');
});

test('nothing throws, whatever the backend does', () => {
  const evil = {
    getItem() { throw new Error('boom'); },
    setItem() { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); },
    get length() { throw new Error('boom'); },
    key() { throw new Error('boom'); },
  };
  const store = new Storage({ backend: evil });
  const r = store.createProfile({ name: 'X' });
  assert.equal(r.ok, true);
  assert.equal(r.saved, false);
  const id = r.profile.id;
  for (const fn of [
    () => store.updateProfile(id, { name: 'Y' }),
    () => store.recordMatch(id, matchResult('m')),
    () => store.recordTraining(id, trainingResult('t')),
    () => store.saveSettings({ mirror: false }),
    () => store.deleteProfile(id),
    () => store.exportProfile(id),
    () => store.importPortable('{'),
    () => store.listProfiles(),
    () => store.status(),
  ]) {
    assert.doesNotThrow(fn);
  }
});
