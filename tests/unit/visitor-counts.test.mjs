// src/app/visitor-counts.js: visitor counts (Vercel Web Analytics) only in the public deploy's build
// (VITE_VISITOR_COUNTS=1) and only on a real host. Never in development, the tests or a local copy, and
// never from another host than the game's own.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { startVisitorCounts, shouldCountVisits, visitorCountsBuild, VISITOR_COUNTS_SCRIPT } from '../../src/app/visitor-counts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A page on `hostname` with just enough DOM for the snippet. */
function fakePage(hostname) {
  const scripts = [];
  const doc = {
    head: { appendChild: (el) => { scripts.push(el); return el; } },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), defer: false, src: '' }),
    querySelector: (sel) => scripts.find((s) => sel === `script[src="${s.src}"]`) || null,
  };
  return { win: { location: { hostname } }, doc, scripts };
}

test('visitor counts: off unless the build asks for them (dev, tests, npm run build: no VITE_VISITOR_COUNTS)', () => {
  assert.equal(visitorCountsBuild(), false);
  const p = fakePage('glove-up-seven.vercel.app');
  assert.equal(startVisitorCounts({ win: p.win, doc: p.doc }), false, 'default = the build flag, which is off here');
  assert.equal(p.scripts.length, 0);
  assert.equal(p.win.va, undefined);
});

test('visitor counts: never on this computer (local previews and test servers)', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.1.1', '[::1]', '0.0.0.0', 'glove.localhost', '']) {
    assert.equal(shouldCountVisits({ enabled: true, hostname: host }), false, host || '(no host)');
    const p = fakePage(host);
    assert.equal(startVisitorCounts({ enabled: true, win: p.win, doc: p.doc }), false, host || '(no host)');
    assert.equal(p.scripts.length, 0, host || '(no host)');
  }
  assert.equal(shouldCountVisits({ enabled: false, hostname: 'glove-up-seven.vercel.app' }), false);
});

test('visitor counts: a deploy build on the real host loads Vercel\'s script once, from the game\'s own domain', () => {
  assert(VISITOR_COUNTS_SCRIPT.startsWith('/_vercel/insights/'), 'same origin: no other host is contacted');
  const p = fakePage('glove-up-seven.vercel.app');
  assert.equal(startVisitorCounts({ enabled: true, win: p.win, doc: p.doc }), true);
  assert.equal(p.scripts.length, 1);
  assert.equal(p.scripts[0].tagName, 'SCRIPT');
  assert.equal(p.scripts[0].src, VISITOR_COUNTS_SCRIPT);
  assert.equal(p.scripts[0].defer, true, 'deferred: never holds up the game');
  assert.equal(typeof p.win.va, 'function');
  p.win.va('pageview');
  assert.equal(p.win.vaq.length, 1, 'calls made before the script has loaded wait in the queue');
  assert.equal(startVisitorCounts({ enabled: true, win: p.win, doc: p.doc }), true);
  assert.equal(p.scripts.length, 1, 'a second start adds no second script');
});

test('visitor counts: started by src/main.js and by nothing else; the deploy keeps its cache headers', () => {
  const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/import \{ startVisitorCounts \} from '\.\/app\/visitor-counts\.js'/.test(main) && /startVisitorCounts\(\)/.test(main), 'main.js starts them');
  const others = readdirSync(join(ROOT, 'src'), { recursive: true }).filter((f) => String(f).endsWith('.js') && String(f) !== 'main.js' && String(f) !== join('app', 'visitor-counts.js'))
    .filter((f) => /visitor-counts/.test(readFileSync(join(ROOT, 'src', String(f)), 'utf8')));
  assert.equal(others.length, 0, `only main.js starts them: ${others.join(', ')}`);
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  // Vercel builds from the repository: the pinned models first, the visitor counter only on production
  assert(/npm run setup:models && /.test(cfg.buildCommand) && /VITE_VISITOR_COUNTS=\$\(\[ "\$VERCEL_ENV" = production \] && echo 1 \|\| echo 0\) npm run build/.test(cfg.buildCommand), cfg.buildCommand);
  assert.equal(cfg.outputDirectory, 'dist');
  const rule = (src) => cfg.headers.find((h) => h.source === src)?.headers.find((x) => x.key === 'Cache-Control')?.value || '';
  assert(/immutable/.test(rule('/assets/(.*)')), 'hashed assets cached for good');
  assert(/max-age=\d+/.test(rule('/(models|mediapipe)/(.*)')), 'the pose model and runtime stay cached between visits');
});
