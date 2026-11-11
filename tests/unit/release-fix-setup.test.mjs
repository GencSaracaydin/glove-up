// RELEASE-05 / RELEASE-02 (docs): a fresh checkout gets from the README alone to a working setup —
// the real Node minimum (Vite 7's, also in package.json "engines"), the Playwright browser install, where
// the e2e clip comes from — and the README credits the third-party parts and points to the notices.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const viteEngines = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'vite', 'package.json'), 'utf8')).engines.node;

/** "^20.19.0 || >=22.12.0" → [[20, 19], [22, 12]] */
const minima = (range) => range.split('||').map((r) => r.trim().replace(/^[\^>=~]+/, '').split('.').slice(0, 2).map(Number));

test('setup: package.json "engines" states the Node range Vite needs', () => {
  assert.equal(pkg.engines?.node, viteEngines, `engines.node (${pkg.engines?.node}) = vite's (${viteEngines})`);
});

test('setup: the README states the same Node minimum (not "Node 20+")', () => {
  const text = readme();
  assert(!/Node 20\+/.test(text), 'the old, wrong "Node 20+"');
  const want = minima(pkg.engines.node).map(([a, b]) => `${a}.${b}+`).join(' or ');
  assert(text.includes(`Node.js ${want}`), `README says "Node.js ${want}"`);
});

test('setup: the README installs the Playwright browser and explains the e2e clip', () => {
  const text = readme();
  assert(text.includes('npx playwright install chromium'), 'Playwright browser install');
  assert(/save your own clip as\s+`dev\/clips\/facecam-boxing\.mp4`/.test(text), 'how to supply the clip');
  assert(/not distributed/.test(text) && /SKIP clip/.test(text), 'why it is missing and what the run does without it');
});

test('setup: the README credits the third-party parts and points to THIRD_PARTY_NOTICES.txt', () => {
  const text = readme();
  const at = text.indexOf('## Credits and licenses');
  assert(at >= 0, 'a Credits and licenses section');
  const section = text.slice(at);
  for (const s of ['three.js', 'MIT', 'MediaPipe', 'Apache 2.0', 'Lilita One', 'Nunito', 'SIL Open Font License 1.1', 'public/THIRD_PARTY_NOTICES.txt']) {
    assert(section.includes(s), `mentions ${s}`);
  }
});
