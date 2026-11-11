// core/rng.js — seeded RNG.
import { test, assert } from '../harness.mjs';
import { Rng, createRng, toRng, hashString } from '../../src/core/rng.js';

test('rng: same seed → same sequence; different seeds differ', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const sa = Array.from({ length: 20 }, () => a.float());
  const sb = Array.from({ length: 20 }, () => b.float());
  const sc = Array.from({ length: 20 }, () => c.float());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.deepEqual(new Rng('daily').float(), new Rng('daily').float());
  assert.equal(createRng(7).float(), new Rng(7).float());
});

test('rng: float/range/int/pick/chance stay in bounds', () => {
  const r = new Rng(1);
  for (let i = 0; i < 2000; i++) {
    const f = r.float(); assert(f >= 0 && f < 1);
    const g = r.range(2, 5); assert(g >= 2 && g < 5);
    const n = r.int(1, 6); assert(Number.isInteger(n) && n >= 1 && n <= 6);
    assert(['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])));
  }
  assert.equal(r.int(3, 3), 3);
  assert.equal(r.pick([]), undefined);
  assert.equal(r.chance(0), false);
  assert.equal(r.chance(1), true);
  let hits = 0;
  for (let i = 0; i < 4000; i++) if (r.chance(0.25)) hits++;
  assert(hits > 850 && hits < 1150, `chance(0.25) ≈ 1000/4000, got ${hits}`);
});

test('rng: int covers both ends; weighted honours weights', () => {
  const r = new Rng(9);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(r.int(0, 3));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  const n = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 3000; i++) n[r.weighted({ a: 1, b: 3, c: 0 })]++;
  assert.equal(n.c, 0);
  assert(n.b > n.a * 2, JSON.stringify(n));
});

test('rng: fork(label) is independent of parent consumption and stable per label', () => {
  const p1 = new Rng(100), p2 = new Rng(100);
  for (let i = 0; i < 37; i++) p2.float(); // consume the parent
  assert.equal(p1.fork('ai').float(), p2.fork('ai').float());
  assert.notEqual(p1.fork('ai').float(), p1.fork('combat').float());
});

test('rng: toRng wraps seeds, Rngs and random-like objects', () => {
  const r = new Rng(5);
  assert.equal(toRng(r), r);
  assert.equal(toRng(5).float(), new Rng(5).float());
  const w = toRng({ random: () => 0.5 });
  assert.equal(w.float(), 0.5);
  assert(typeof hashString('x') === 'number');
});
