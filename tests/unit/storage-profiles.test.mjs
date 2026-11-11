// core/storage.js — profiles, guest/portable (SET01), settings, persistence across reloads.
import { test, assert } from '../harness.mjs';
import {
  Storage, STORAGE_KEYS, STORAGE_LIMITS, DEFAULT_SETTINGS, sanitizeAppearance, sanitizeName,
  sanitizeCalibration, PORTABLE_FORMAT,
} from '../../src/core/storage.js';
import { APPEARANCE_OPTIONS } from '../../src/core/types.js';
import { makeBackend, makeDeterministic } from './storage-fakes.test.mjs';

const fresh = (backend = makeBackend()) => ({ backend, store: new Storage({ backend, ...makeDeterministic() }) });

const CAL = { version: 1, shoulderWidth: 0.21, armLengthWorld: 0.58, neutralHead: { x: 0.5, y: 0.31 }, neutralShoulderY: 0.45, swapSides: false, createdAt: 5, extraGain: 1.2 };

test('storage: create → list → get, persisted under gloveup:v1:* keys', () => {
  const { backend, store } = fresh();
  const r = store.createProfile({ name: '  Sam  ', appearance: { skin: '#8D5A3B', eyes: 'fierce' } });
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  assert.equal(r.profile.name, 'Sam');
  assert.equal(r.profile.kind, 'local');
  assert.equal(r.profile.skill, 0);
  assert.equal(r.profile.appearance.skin, '#8d5a3b');
  assert.equal(r.profile.appearance.eyes, 'fierce');
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.getProfile(r.profile.id).name, 'Sam');
  assert(backend.map.has(STORAGE_KEYS.profile(r.profile.id)), 'profile key written');
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.index)), [r.profile.id]);
  for (const k of backend.map.keys()) assert(k.startsWith('gloveup:v1:'), `unexpected key ${k}`);
});

test('storage: profiles survive a reload (new Storage on the same backend), order kept', () => {
  const backend = makeBackend();
  const a = new Storage({ backend, ...makeDeterministic() });
  const p1 = a.createProfile({ name: 'Ana' }).profile;
  const p2 = a.createProfile({ name: 'Bo' }).profile;
  a.updateProfile(p1.id, { calibration: CAL });
  const b = new Storage({ backend });
  assert.deepEqual(b.listProfiles().map((p) => p.name), ['Ana', 'Bo']);
  assert.equal(b.getProfile(p1.id).calibration.shoulderWidth, 0.21);
  assert.equal(b.getProfile(p1.id).calibration.extraGain, 1.2, 'extra calibration fields kept');
  assert.equal(b.getProfile(p2.id).calibration, null);
});

test('storage: getProfile/listProfiles return copies (callers cannot corrupt state)', () => {
  const { store } = fresh();
  const id = store.createProfile({ name: 'Cy' }).profile.id;
  const copy = store.getProfile(id);
  copy.name = 'Hacked';
  copy.records.matches.wins = 99;
  assert.equal(store.getProfile(id).name, 'Cy');
  assert.equal(store.getProfile(id).records.matches.wins, 0);
});

test('storage: updateProfile patches name/appearance/calibration; invalid values are rejected', () => {
  const { store } = fresh();
  const id = store.createProfile({ name: 'Dee' }).profile.id;
  const r = store.updateProfile(id, { name: 'Dee Dee', appearance: { hair: { style: 'mohawk', color: '#e64980' }, build: 'heavy' } });
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  const p = store.getProfile(id);
  assert.equal(p.name, 'Dee Dee');
  assert.equal(p.appearance.hair.style, 'mohawk');
  assert.equal(p.appearance.build, 'heavy');
  store.updateProfile(id, { appearance: { eyes: 'laser', skin: 'red' }, calibration: { shoulderWidth: -1 } });
  const q = store.getProfile(id);
  assert.equal(q.appearance.eyes, p.appearance.eyes, 'unknown eye style ignored');
  assert.equal(q.appearance.skin, p.appearance.skin, 'non-hex skin ignored');
  assert.equal(q.calibration, null, 'invalid calibration not stored');
  assert.equal(store.updateProfile('nope', { name: 'x' }).ok, false);
});

test('storage: deleteProfile erases the profile and its records (SAV01)', () => {
  const { backend, store } = fresh();
  const keep = store.createProfile({ name: 'Keep' }).profile.id;
  const gone = store.createProfile({ name: 'Gone' }).profile.id;
  store.recordMatch(gone, { id: 'm1', winner: 'p1', method: 'KO', mode: 'single', endRound: 1 }, { skill: 50, pro: false });
  backend.map.set(`gloveup:v1:quarantine:profile:${gone}:123`, '{broken');
  const r = store.deleteProfile(gone);
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  assert.equal(store.getProfile(gone), null);
  assert(!backend.map.has(STORAGE_KEYS.profile(gone)), 'profile key removed');
  assert(![...backend.map.keys()].some((k) => k.includes(gone)), 'no trace of the deleted profile remains');
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.index)), [keep]);
  const reloaded = new Storage({ backend });
  assert.deepEqual(reloaded.listProfiles().map((p) => p.id), [keep]);
  assert.equal(store.deleteProfile('unknown').ok, false);
});

test('storage: guest() makes distinct ephemeral profiles that are never written', () => {
  const { backend, store } = fresh();
  const g1 = store.guest();
  const g2 = store.guest();
  assert.equal(g1.kind, 'guest');
  assert.notEqual(g1.id, g2.id);
  assert.equal(g1.name, 'Guest');
  assert.equal(g2.name, 'Guest 2');
  assert.notDeepEqual(g1.appearance, g2.appearance, 'guests look different');
  assert.equal(store.listProfiles().length, 0, 'guests are not in the local list');
  assert.equal(store.getProfile(g1.id).kind, 'guest');
  const u = store.updateProfile(g1.id, { name: 'Visitor' });
  assert.equal(u.ok, true);
  assert.equal(u.saved, false);
  assert.equal(u.reason, 'guest');
  assert(!backend.calls.set.some((k) => k.includes(g1.id)), 'guest never written');
});

test('storage: export → import makes an in-memory portable profile (never saved), de-duplicated', () => {
  const src = fresh();
  const id = src.store.createProfile({ name: 'Rover' }).profile.id;
  src.store.recordMatch(id, { id: 'm1', winner: 'p1', method: 'decision', mode: 'single', endRound: 3 }, { skill: 140, pro: false });
  const json = src.store.exportProfile(id);
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, PORTABLE_FORMAT);
  assert.equal(parsed.profile.name, 'Rover');

  const dst = fresh();
  const r = dst.store.importPortable(json);
  assert.equal(r.ok, true);
  assert.equal(r.profile.kind, 'portable');
  assert.equal(r.profile.name, 'Rover');
  assert.equal(r.profile.skill, 140);
  assert.equal(r.profile.records.matches.wins, 1);
  assert.equal(dst.store.listProfiles().length, 0, 'portable is not a local profile');
  assert.equal(dst.backend.calls.set.filter((k) => !k.endsWith('probe')).length, 0, 'import wrote nothing');
  const again = dst.store.importPortable(json);
  assert.equal(again.profile.id, r.profile.id, 'same portable imported twice → same session profile');
  assert.equal(dst.store.sessionProfiles().length, 1);
  assert.equal(src.store.exportProfile('nope'), null);
});

test('storage: importPortable rejects junk with a readable error and never throws', () => {
  const { store } = fresh();
  for (const bad of ['', 'not json', '{"format":"other","profile":{}}', '[1,2]', 'null', '{"format":"glove-up-portable"}',
    JSON.stringify({ format: PORTABLE_FORMAT, version: 99, profile: { name: 'x', appearance: {} } }), 42, null, undefined,
    'x'.repeat(STORAGE_LIMITS.importMaxBytes + 1)]) {
    const r = store.importPortable(bad);
    assert.equal(r.ok, false, `should reject ${String(bad).slice(0, 30)}`);
    assert.equal(typeof r.error, 'string');
  }
  // a bare profile object (no wrapper) is accepted
  const ok = store.importPortable({ name: 'Bare', appearance: { skin: '#5e3b26' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.profile.appearance.skin, '#5e3b26');
});

test('storage: max profiles is enforced with a friendly error', () => {
  const { store } = fresh();
  for (let i = 0; i < STORAGE_LIMITS.maxProfiles; i++) assert.equal(store.createProfile({ name: `B${i}` }).ok, true);
  const r = store.createProfile({ name: 'One too many' });
  assert.equal(r.ok, false);
  assert.match(r.error, /up to/);
});

test('storage: settings default, merge, validate and persist', () => {
  const backend = makeBackend();
  const store = new Storage({ backend });
  assert.deepEqual(store.settings(), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  const r = store.saveSettings({ model: 'lite', sensitivity: 2, volumes: { music: 0.1 }, inputMode: 'keyboard', mirror: 'yes', cameraDeviceId: 'cam-2' });
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  assert.equal(r.settings.model, 'lite');
  assert.equal(r.settings.sensitivity, 1, 'clamped to 0..1');
  assert.equal(r.settings.volumes.music, 0.1);
  assert.equal(r.settings.volumes.master, DEFAULT_SETTINGS.volumes.master, 'other volumes kept');
  assert.equal(r.settings.mirror, true, 'non-boolean ignored');
  assert.equal(r.settings.inputMode, 'keyboard');
  const again = new Storage({ backend }).settings();
  assert.equal(again.model, 'lite');
  assert.equal(again.cameraDeviceId, 'cam-2');
  assert.equal(again.volumes.music, 0.1);
});

test('storage: sanitizers', () => {
  assert.equal(sanitizeName('  a\u0007b  c '), 'ab c');
  assert.equal(sanitizeName(''), 'Boxer');
  assert.equal(sanitizeName('x'.repeat(40)).length, STORAGE_LIMITS.nameMaxLength);
  const a = sanitizeAppearance({ hair: { style: 'nope' }, top: 'none', height: 3 });
  assert(APPEARANCE_OPTIONS.hairStyles.includes(a.hair.style));
  assert.equal(a.top, 'none');
  assert.equal(a.height, 1.1);
  assert.equal(sanitizeCalibration(null), null);
  assert.equal(sanitizeCalibration({ ...CAL, armLengthWorld: NaN }), null);
  assert.equal(sanitizeCalibration(CAL).swapSides, false);
});
