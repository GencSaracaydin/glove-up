// RELEASE-04 regression: `npm test` imports every test file before running any, so one import that
// fails to LINK on a supported Node (README: Node 20+; Vite 7: ^20.19 || >=22.12) aborts the whole run.
// A named import of `registerHooks` from the node:module builtin did exactly that on Node < 22.15.
// Guard: no test file takes named imports from that builtin (use a namespace import + typeof check).
import { readdirSync, readFileSync } from 'node:fs';
import { test, assert } from '../harness.mjs';

const dir = new URL('./', import.meta.url);
/** Code only: line comments dropped, so prose about the problem does not trip the scan. */
const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const NAMED_FROM_MODULE = new RegExp(String.raw`import\s*\{[^}]*\}\s*from\s*['"](?:node:)?module['"]`);

test('RELEASE-04: no unit test file uses a named import from node:module (link error on older Node)', () => {
  const bad = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    if (NAMED_FROM_MODULE.test(code(readFileSync(new URL(f, dir), 'utf8')))) bad.push(f);
  }
  assert(bad.length === 0, `named imports from node:module in ${bad.join(', ')}`);
});

test('RELEASE-04: the input hub tests load with plain static imports (no module hooks needed)', () => {
  const src = code(readFileSync(new URL('input-hub.test.mjs', dir), 'utf8'));
  assert(!/registerHooks/.test(src), 'no module hooks');
  assert(/import \{[^}]*InputHub[^}]*\} from '\.\.\/\.\.\/src\/input\/input-hub\.js'/.test(src), 'static import of the hub');
});
