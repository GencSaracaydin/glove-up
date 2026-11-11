// RELEASE-10: the e2e summary reports skipped scenarios separately and never counts them as passed
// (a fresh checkout has no dev/clips/facecam-boxing.mp4, so the clip scenario is skipped). Also the
// helper behind the e2e "no third-party requests" check (RELEASE-03). Importing tests/e2e.mjs runs
// nothing: no server, no browser.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, assert } from '../harness.mjs';

const e2e = await import('../e2e.mjs');
const { runScenarios, summarize, Skip, Check, scenarios, isLocalUrl, CLIP_FILE } = e2e;
const quiet = () => {};

test('e2e runner: a skipped scenario is reported as SKIP and never counted as passed', async () => {
  const lines = [];
  const results = await runScenarios([
    { name: 'a', fn: async () => {} },
    { name: 'clip', fn: async () => { throw new Skip('no dev/clips/facecam-boxing.mp4'); } },
    { name: 'b', fn: async () => { throw new Check('broken'); } },
  ], { log: (s) => lines.push(s) });
  assert.deepEqual(results.map((r) => `${r.name}:${r.status}`), ['a:pass', 'clip:skip', 'b:fail']);
  assert(lines.includes('SKIP clip (no dev/clips/facecam-boxing.mp4)'), lines.join(' | '));
  assert(!lines.some((l) => /^PASS clip/.test(l)), 'no PASS line for the skipped scenario');
  const sum = summarize(results, { seconds: 3 });
  assert(sum.text.startsWith('1 passed, 1 skipped, 1 failed (3 s)'), sum.text);
  assert(sum.text.includes('  skip clip (no dev/clips/facecam-boxing.mp4)'), sum.text);
  assert.equal(sum.exitCode, 1);
});

test('e2e runner: only skips → exit 0 and "0 passed, 1 skipped, 0 failed"', async () => {
  const results = await runScenarios([{ name: 'clip', fn: async () => { throw new Skip('no clip'); } }], { log: quiet });
  const sum = summarize(results);
  assert.equal(sum.text.split('\n')[0], '0 passed, 1 skipped, 0 failed');
  assert.equal(sum.exitCode, 0);
  assert.equal(sum.passed, 0);
});

test('e2e runner: the real clip scenario skips (does not pass) when the clip file is missing', async () => {
  const clip = scenarios.find((s) => s.name === 'clip');
  assert(clip, 'clip scenario exists');
  assert(CLIP_FILE.endsWith(join('dev', 'clips', 'facecam-boxing.mp4')), CLIP_FILE);
  const missing = join(tmpdir(), 'no-such-dir-glove', 'facecam-boxing.mp4');
  const [r] = await runScenarios([clip], { browser: null, shared: { clipFile: missing }, log: quiet });
  assert.equal(r.status, 'skip', `status ${r.status} (${r.error?.message ?? ''})`);
  assert(r.reason.includes('facecam-boxing.mp4'), r.reason);
  assert.equal(summarize([r]).text.split('\n')[0], '0 passed, 1 skipped, 0 failed');
});

test('e2e: the test server gets a private Vite dependency cache (GLOVE_VITE_CACHE_DIR)', async () => {
  const { readFileSync } = await import('node:fs');
  const cfgUrl = new URL('../../vite.config.js', import.meta.url).href;
  const had = process.env.GLOVE_VITE_CACHE_DIR;
  try {
    delete process.env.GLOVE_VITE_CACHE_DIR;
    const plain = (await import(`${cfgUrl}?env=none`)).default;
    assert.equal(plain.cacheDir, undefined, 'normal runs keep Vite\'s default cache');
    process.env.GLOVE_VITE_CACHE_DIR = join(tmpdir(), 'glove-vite-cache-test');
    const cfg = (await import(`${cfgUrl}?env=set`)).default;
    assert.equal(cfg.cacheDir, process.env.GLOVE_VITE_CACHE_DIR);
  } finally { if (had === undefined) delete process.env.GLOVE_VITE_CACHE_DIR; else process.env.GLOVE_VITE_CACHE_DIR = had; }
  const src = readFileSync(new URL('../e2e.mjs', import.meta.url), 'utf8');
  assert(/GLOVE_VITE_CACHE_DIR: cacheDir/.test(src) && /\.vite-e2e-\$\{PORT\}/.test(src), 'e2e.mjs passes a per-port cache dir to its server');
});

test('e2e: third-party request check — only the local server counts as local', () => {
  for (const u of ['http://127.0.0.1:5190/', 'http://localhost:5190/src/main.js', 'ws://127.0.0.1:5190/', 'data:image/png;base64,AA', 'blob:http://127.0.0.1:5190/x']) assert(isLocalUrl(u), u);
  for (const u of ['https://fonts.googleapis.com/css2?family=Nunito', 'https://fonts.gstatic.com/s/nunito/x.woff2', 'https://storage.googleapis.com/mediapipe-models/x.task', 'http://example.com/']) assert(!isLocalUrl(u), u);
});
