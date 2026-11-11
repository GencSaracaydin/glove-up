// One-Euro filter (src/input/one-euro.js).
import { test, assert, approx } from '../harness.mjs';
import { OneEuroFilter, OneEuroVector, oneEuroAlpha, makeFilterBank } from '../../src/input/one-euro.js';
import { mulberry32 } from '../../src/input/synthetic.js';

const gaussian = (r) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

test('one-euro: alpha is a proper low-pass factor', () => {
  approx(oneEuroAlpha(1 / 30, 1e9), 1, 1e-6, 'huge cutoff passes through');
  assert(oneEuroAlpha(1 / 30, 1) > 0 && oneEuroAlpha(1 / 30, 1) < 0.25, 'low cutoff smooths');
  assert(oneEuroAlpha(1 / 30, 5) > oneEuroAlpha(1 / 30, 1), 'monotonic in cutoff');
});

test('one-euro: first sample passes, constant input stays constant', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.5 });
  approx(f.filter(3.5, 0), 3.5);
  for (let i = 1; i < 30; i++) approx(f.filter(3.5, i * 33), 3.5, 1e-9);
  approx(f.velocity, 0, 1e-9);
});

test('one-euro: removes jitter at rest', () => {
  const r = mulberry32(7);
  const f = new OneEuroFilter({ minCutoff: 1.0, beta: 0 });
  const raw = [], out = [];
  for (let i = 0; i < 600; i++) { const x = 0.01 * gaussian(r); raw.push(x); out.push(f.filter(x, i * 33.3)); }
  assert(sd(out.slice(30)) < 0.35 * sd(raw.slice(30)), `output sd ${sd(out)} vs raw ${sd(raw)}`);
});

test('one-euro: beta reduces lag on fast motion', () => {
  const lagAt = (beta) => {
    const f = new OneEuroFilter({ minCutoff: 1.0, beta, dCutoff: 2 });
    let y = 0;
    for (let i = 0; i <= 10; i++) y = f.filter(i * 0.1, i * 33.3);   // ramp of 3 units/s
    return 1.0 - y;
  };
  assert(lagAt(5) < 0.5 * lagAt(0), `lag with beta ${lagAt(5)} vs without ${lagAt(0)}`);
});

test('one-euro: duplicate or backwards timestamps and NaN are ignored', () => {
  const f = new OneEuroFilter({ minCutoff: 1 });
  f.filter(1, 0);
  const a = f.filter(2, 33);
  approx(f.filter(100, 33), a, 1e-12, 'duplicate timestamp');
  approx(f.filter(100, 10), a, 1e-12, 'backwards timestamp');
  approx(f.filter(NaN, 66), a, 1e-12, 'NaN');
});

test('one-euro: vector filter shares one cutoff and can be re-seeded', () => {
  const v = new OneEuroVector(3, { minCutoff: 1, beta: 1 });
  v.filter([0, 0, 0], 0);
  v.filter([1, 0, 0], 33);
  assert(v.value[0] > 0 && v.value[0] < 1 && v.value[1] === 0);
  assert(v.speed > 0);
  v.seed([5, 5, 5], 66);
  assert(v.value.every((x) => x === 5) && v.speed === 0);
  v.reset();
  assert(!v.initialized);
});

test('one-euro: filter bank keeps independent filters per key', () => {
  const bank = makeFilterBank(2, { minCutoff: 1, beta: 0 });
  bank.filter('a', [0, 0], 0);
  bank.filter('b', [10, 10], 0);
  const a = bank.filter('a', [1, 1], 33);
  const b = bank.filter('b', [10, 10], 33);
  assert(a[0] < 1 && b[0] === 10);
  assert(bank.get('a') && !bank.get('c'));
});
