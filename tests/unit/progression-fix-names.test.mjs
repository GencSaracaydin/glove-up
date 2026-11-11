// FLOWS-11 regression: boxer names. Non-strings never show as "[object Object]"; ZWJ / ZWNJ stay
// (composite emoji, Persian, Indic scripts); names are cut by user-perceived character, never in
// the middle of an emoji sequence (core/storage.js sanitizeName / clampName / graphemes).
import { test, assert } from '../harness.mjs';
import * as storageModule from '../../src/core/storage.js';
import { makeBackend } from './storage-fakes.test.mjs';

const { Storage, STORAGE_KEYS, STORAGE_LIMITS, sanitizeName } = storageModule;
const c = (...cp) => String.fromCodePoint(...cp);
const ZWJ = c(0x200d), ZWNJ = c(0x200c);
const FAMILY = c(0x1f469) + ZWJ + c(0x1f469) + ZWJ + c(0x1f467) + ZWJ + c(0x1f466);
const RAINBOW = c(0x1f3f3, 0xfe0f) + ZWJ + c(0x1f308);
const PERSIAN = 'می' + ZWNJ + 'خواهم';
const KSHA = 'क्' + ZWJ + 'ष';
const segments = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);

test('FLOWS-11: joiners inside a name are kept — composite emoji, Persian and Indic spellings survive', () => {
  assert.equal(sanitizeName(FAMILY), FAMILY, 'the family emoji keeps its three ZWJs');
  assert.equal(sanitizeName(RAINBOW + ' Rainbow'), RAINBOW + ' Rainbow');
  assert.equal(sanitizeName(PERSIAN), PERSIAN, 'ZWNJ kept');
  assert.equal(sanitizeName(KSHA), KSHA);
  // real zero-width junk still goes: zero-width space, direction marks and overrides, the BOM, controls
  assert.equal(sanitizeName('a' + c(0x200b) + 'b' + c(0x200e) + c(0x200f)), 'ab');
  assert.equal(sanitizeName(c(0x202e) + 'evil' + c(0x2066)), 'evil');
  assert.equal(sanitizeName(c(0xfeff) + 'Bo'), 'Bo');
  assert.equal(sanitizeName('  a' + c(7) + 'b  c '), 'ab c');
  // joiners at the ends are trimmed; nothing visible left → the fallback
  assert.equal(sanitizeName(ZWJ + 'Ann' + ZWNJ), 'Ann');
  assert.equal(sanitizeName(ZWJ + ZWJ), 'Boxer');
  assert.equal(sanitizeName(ZWNJ + ' ' + ZWJ), 'Boxer');
  assert.equal(sanitizeName(c(0x301)), 'Boxer', 'a lone combining mark');
  assert.equal(sanitizeName(c(0xfe0f)), 'Boxer', 'a lone variation selector');
});

test('FLOWS-11: anything but a string falls back — never "[object Object]"', () => {
  for (const v of [{ evil: true }, ['a', 'b'], 12345, true, null, undefined, () => 'x', Symbol('s')]) {
    assert.equal(sanitizeName(v), 'Boxer', String(typeof v));
  }
  assert.equal(sanitizeName({}, 'Kept'), 'Kept', 'a caller fallback (updateProfile keeps the old name)');
});

test('FLOWS-11: names are cut by user-perceived character (16), never inside an emoji sequence', () => {
  const long = c(0x1f94a, 0x1f525) + ' Ünïcødé ' + FAMILY + ' extra'; // 18 user-perceived characters
  const out = sanitizeName(long);
  assert.equal(segments(out).length, STORAGE_LIMITS.nameMaxLength);
  assert(out.includes(FAMILY), 'the family stays whole');
  assert.equal(sanitizeName('x'.repeat(40)).length, 16);
  assert.equal(sanitizeName(FAMILY.repeat(12)), FAMILY.repeat(9), 'and at most 64 code points (9 × 7)');
  assert.equal(sanitizeName('Z' + c(0x301).repeat(80)), 'Boxer', 'an absurd stack of marks is not a name');
  assert.equal(storageModule.clampName?.('abc' + FAMILY + 'def', 4), 'abc' + FAMILY);
  assert.deepEqual(storageModule.graphemes?.(RAINBOW + 'a'), [RAINBOW, 'a']);
});

test('FLOWS-11: a corrupt saved profile whose name is an object loads as "Boxer"; good names round-trip', () => {
  const backend = makeBackend({ seed: {
    [STORAGE_KEYS.index]: JSON.stringify(['p_bad', 'p_fam']),
    [STORAGE_KEYS.profile('p_bad')]: JSON.stringify({ name: { evil: true }, skill: 'lots', appearance: 'x', records: [1, 2] }),
    [STORAGE_KEYS.profile('p_fam')]: JSON.stringify({ name: PERSIAN + ' ' + FAMILY, appearance: {} }),
  } });
  const store = new Storage({ backend });
  assert.deepEqual(store.listProfiles().map((p) => p.name), ['Boxer', PERSIAN + ' ' + FAMILY]);
  const made = store.createProfile({ name: 'Kim ' + RAINBOW });
  assert.equal(made.profile.name, 'Kim ' + RAINBOW);
  assert.equal(new Storage({ backend }).getProfile(made.profile.id).name, 'Kim ' + RAINBOW, 'stored intact');
  assert.equal(store.updateProfile(made.profile.id, { name: { nope: 1 } }).profile.name, 'Kim ' + RAINBOW, 'a junk rename keeps the name');
});
