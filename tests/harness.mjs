// Tiny test harness (no dependencies). Usage in tests/unit/*.test.mjs:
//   import { test, assert, approx } from '../harness.mjs';
//   test('name', () => { assert(cond, 'message'); });
import assertMod from 'node:assert/strict';

const cases = [];
let currentFile = '';
export function test(name, fn) { cases.push({ name, fn, file: currentFile }); }
export const assert = Object.assign((cond, msg) => assertMod.ok(cond, msg), assertMod);
export function approx(a, b, eps = 1e-6, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ${a} ≈ ${b} (eps ${eps})`);
}
export async function run() {
  let pass = 0, fail = 0;
  for (const c of cases) {
    try { await c.fn(); pass++; console.log(`  ok   ${c.name}`); }
    catch (e) { fail++; console.log(`  FAIL ${c.name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}
