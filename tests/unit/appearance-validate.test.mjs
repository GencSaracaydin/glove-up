// Appearance validation, presets and seeded randomizer (render/appearance.js).
import { test, assert } from '../harness.mjs';
import { APPEARANCE_OPTIONS as O } from '../../src/core/types.js';
import {
  validateAppearance, isValidAppearance, appearanceKey, randomAppearance, makeRng, normalizeHex, colorDistance,
  DEFAULT_APPEARANCE, DEFAULT_PLAYER, TRAINER, PRESETS, HEIGHT_RANGE, RANDOM_WEIGHTS,
} from '../../src/render/appearance.js';

const FIELDS = ['skin', 'hair', 'eyes', 'brows', 'mouth', 'nose', 'accessory', 'top', 'trunks', 'trim', 'gloves', 'shoes', 'build', 'height'];
const HEX = /^#[0-9a-f]{6}$/;

function assertComplete(a, msg = '') {
  for (const f of FIELDS) assert(f in a, `${msg} missing ${f}`);
  for (const f of ['skin', 'trunks', 'trim', 'gloves', 'shoes']) assert(HEX.test(a[f]), `${msg} ${f}=${a[f]}`);
  assert(a.top === 'none' || HEX.test(a.top), `${msg} top=${a.top}`);
  assert(HEX.test(a.hair.color) && O.hairStyles.includes(a.hair.style), `${msg} hair`);
  assert(O.eyes.includes(a.eyes) && O.brows.includes(a.brows) && O.mouths.includes(a.mouth), `${msg} face parts`);
  assert(O.noses.includes(a.nose) && O.accessories.includes(a.accessory) && O.builds.includes(a.build), `${msg} nose/acc/build`);
  assert(a.height >= HEIGHT_RANGE[0] && a.height <= HEIGHT_RANGE[1], `${msg} height ${a.height}`);
}

test('appearance: validate(nothing) → complete defaults', () => {
  for (const bad of [undefined, null, {}, 'garbage', 42, [], true]) {
    const a = validateAppearance(bad);
    assertComplete(a, String(bad));
    assert.deepEqual(a, { ...DEFAULT_APPEARANCE, hair: { ...DEFAULT_APPEARANCE.hair } });
  }
});

test('appearance: invalid fields repaired, valid ones kept', () => {
  const a = validateAppearance({
    skin: '#ABC', hair: { style: 'afro', color: 'not-a-colour' }, eyes: 'laser', brows: 'angry', mouth: 'grin',
    nose: 'beak', accessory: 'cape', top: 'none', trunks: 'none', trim: 0xff0000, gloves: 'ff4d5e', shoes: '#12345',
    build: 'giant', height: 3, extra: 'dropped', label: '  Champ  ',
  });
  assert.equal(a.skin, '#aabbcc');
  assert.equal(a.hair.style, 'afro');
  assert.equal(a.hair.color, DEFAULT_APPEARANCE.hair.color);
  assert.equal(a.eyes, DEFAULT_APPEARANCE.eyes);
  assert.equal(a.brows, 'angry');
  assert.equal(a.mouth, 'grin');
  assert.equal(a.nose, DEFAULT_APPEARANCE.nose);
  assert.equal(a.accessory, DEFAULT_APPEARANCE.accessory);
  assert.equal(a.top, 'none', 'bare torso allowed');
  assert.equal(a.trunks, DEFAULT_APPEARANCE.trunks, "'none' only valid for top");
  assert.equal(a.trim, '#ff0000');
  assert.equal(a.gloves, '#ff4d5e');
  assert.equal(a.shoes, DEFAULT_APPEARANCE.shoes);
  assert.equal(a.build, 'average');
  assert.equal(a.height, HEIGHT_RANGE[1]);
  assert(!('extra' in a), 'unknown fields dropped');
  assert.equal(a.label, 'Champ');
  assertComplete(a);
});

test('appearance: height clamps and parses, hair may be a style string', () => {
  assert.equal(validateAppearance({ height: 0.2 }).height, HEIGHT_RANGE[0]);
  assert.equal(validateAppearance({ height: '1.05' }).height, 1.05);
  assert.equal(validateAppearance({ height: NaN }).height, 1);
  assert.equal(validateAppearance({ height: Infinity }).height, 1);
  assert.equal(validateAppearance({ hair: 'bun' }).hair.style, 'bun');
  assert.equal(validateAppearance({ hair: 'wig' }).hair.style, DEFAULT_APPEARANCE.hair.style);
});

test('appearance: pure — never mutates input, idempotent, custom base', () => {
  const input = Object.freeze({ skin: '#FFF', hair: Object.freeze({ style: 'bob', color: '#000' }), height: 9 });
  const a = validateAppearance(input);
  assert.equal(input.skin, '#FFF');
  assert.deepEqual(validateAppearance(a), a);
  a.hair.style = 'afro';
  assert.equal(input.hair.style, 'bob', 'hair object is copied');
  const r = validateAppearance({ skin: '#000000' }, TRAINER);
  assert.equal(r.skin, '#000000');
  assert.equal(r.accessory, TRAINER.accessory);
  assert.equal(r.top, TRAINER.top);
});

test('appearance: normalizeHex accepts common forms only', () => {
  assert.equal(normalizeHex('#AbCdEf'), '#abcdef');
  assert.equal(normalizeHex('abc'), '#aabbcc');
  assert.equal(normalizeHex(0x00ff00), '#00ff00');
  for (const bad of ['red', '#12', '#1234567', -1, 0x1000000, null, {}]) assert.equal(normalizeHex(bad), null, String(bad));
});

test('appearance: key is stable, order independent and discriminating', () => {
  const a = { ...PRESETS[2] };
  const b = Object.fromEntries(Object.entries(PRESETS[2]).reverse());
  assert.equal(appearanceKey(a), appearanceKey(b));
  assert.notEqual(appearanceKey(PRESETS[0]), appearanceKey(PRESETS[1]));
  assert.notEqual(appearanceKey({ ...DEFAULT_APPEARANCE, height: 1.01 }), appearanceKey(DEFAULT_APPEARANCE));
});

test('appearance: presets — ≥12, valid, varied, labelled', () => {
  assert(PRESETS.length >= 12, `${PRESETS.length} presets`);
  const labels = new Set();
  for (const p of PRESETS) {
    assertComplete(p, p.label);
    assert(isValidAppearance(p), `${p.label} valid`);
    assert(typeof p.label === 'string' && p.label.length > 0 && !labels.has(p.label), `label ${p.label}`);
    labels.add(p.label);
  }
  const uses = (field, list) => list.every((v) => PRESETS.some((p) => (field === 'hairStyle' ? p.hair.style : p[field]) === v));
  assert(uses('hairStyle', O.hairStyles), 'every hair style used');
  assert(uses('accessory', O.accessories), 'every accessory used');
  assert(uses('build', O.builds), 'every build used');
  assert(uses('skin', O.skinTones), 'every skin tone used');
  assert(uses('eyes', O.eyes) && uses('mouth', O.mouths) && uses('nose', O.noses), 'face kit covered');
  assert(Object.isFrozen(PRESETS) && Object.isFrozen(PRESETS[0]) && Object.isFrozen(PRESETS[0].hair), 'presets frozen');
});

test('appearance: trainer and default player are valid (no referee look: the count is numbers + voice)', () => {
  for (const [name, a] of [['TRAINER', TRAINER], ['DEFAULT_PLAYER', DEFAULT_PLAYER], ['DEFAULT', DEFAULT_APPEARANCE]]) {
    assertComplete(a, name);
    assert(isValidAppearance(a), name);
  }
  assert(!isValidAppearance({ skin: '#ffffff' }), 'partial look is not valid as-is');
});

test('appearance: randomAppearance is deterministic per seed', () => {
  for (const seed of [0, 1, 42, 123456789, -7, 'p1', 'guest-7']) {
    assert.deepEqual(randomAppearance(seed), randomAppearance(seed), `seed ${seed}`);
  }
  assert.notDeepEqual(randomAppearance(1), randomAppearance(2));
  assert.notDeepEqual(randomAppearance('a'), randomAppearance('b'));
  const keys = new Set();
  for (let i = 0; i < 100; i++) keys.add(appearanceKey(randomAppearance(i)));
  assert(keys.size >= 98, `variety ${keys.size}/100`);
});

test('appearance: random looks are valid, cover the kit and keep clothes readable', () => {
  const seen = { style: new Set(), skin: new Set(), build: new Set(), acc: new Set() };
  for (let i = 0; i < 600; i++) {
    const a = randomAppearance(i * 7919);
    assertComplete(a, `seed ${i}`);
    assert(isValidAppearance(a), `seed ${i} valid`);
    seen.style.add(a.hair.style); seen.skin.add(a.skin); seen.build.add(a.build); seen.acc.add(a.accessory);
    const topRef = a.top === 'none' ? a.skin : a.top;
    assert(colorDistance(topRef, a.trunks) >= RANDOM_WEIGHTS.minTopTrunksDist, `seed ${i}: top vs trunks`);
    assert(colorDistance(a.trim, a.trunks) >= RANDOM_WEIGHTS.minTrimDist, `seed ${i}: trim vs trunks`);
    assert(colorDistance(a.gloves, topRef) >= RANDOM_WEIGHTS.minGloveDist, `seed ${i}: gloves vs top`);
  }
  assert.equal(seen.style.size, O.hairStyles.length);
  assert.equal(seen.skin.size, O.skinTones.length);
  assert.equal(seen.build.size, O.builds.length);
  assert.equal(seen.acc.size, O.accessories.length);
});

test('appearance: makeRng is a uniform-ish [0,1) stream', () => {
  const r = makeRng('x');
  let sum = 0;
  for (let i = 0; i < 5000; i++) { const v = r(); assert(v >= 0 && v < 1); sum += v; }
  assert(Math.abs(sum / 5000 - 0.5) < 0.03, `mean ${sum / 5000}`);
});
