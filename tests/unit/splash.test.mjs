// The loading screen (index.html #splash, src/app/splash.js): painted before any script, it fades once a screen
// is up, two frames are drawn and the title's fonts are in (capped), and the title's intro waits for it. A fatal
// start-up error or a safety timeout removes it too.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { Splash, hideSplash, SPLASH } from '../../src/app/splash.js';
import { STORAGE_KEYS } from '../../src/core/storage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** A document with the loading screen, a classList for <html>, and fonts that load when told to. */
function fakeDoc({ withSplash = true, fonts = 'manual' } = {}) {
  const classes = (init) => {
    const set = new Set(init);
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), set };
  };
  const listeners = {};
  const el = withSplash ? {
    classList: classes([]), removed: false,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    remove() { this.removed = true; doc._splash = null; },
  } : null;
  let resolveFonts;
  const fontsReady = new Promise((r) => { resolveFonts = r; });
  const doc = {
    _splash: el,
    documentElement: { classList: classes(['is-loading']) },
    getElementById: (id) => (id === 'splash' ? doc._splash : null),
    fonts: fonts === 'none' ? undefined : { load: () => (fonts === 'manual' ? fontsReady : Promise.resolve([])) },
  };
  return { doc, el, listeners, loadFonts: () => resolveFonts([]) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('splash: fades only once a screen is up, two frames are drawn and the fonts are in', async () => {
  const { doc, el, listeners, loadFonts } = fakeDoc();
  let t = 1000;
  const s = new Splash({ doc, now: () => t });
  assert.equal(s.frameDrawn(false), false, 'nothing on screen yet');
  assert.equal(s.frameDrawn(true), false, 'the first frame compiles the shaders');
  t += 16;
  assert.equal(s.frameDrawn(true), false, 'fonts not in yet');
  loadFonts();
  await tick();
  t += 16;
  assert.equal(s.frameDrawn(true), true, 'second frame, fonts in: fade');
  assert(el.classList.contains('is-done'), 'the fade starts');
  assert(!doc.documentElement.classList.contains('is-loading'), 'the title intro may play');
  listeners.transitionend?.({ target: { className: 'splash__name' } });
  assert.equal(el.removed, false, 'the name\'s own fade-in (bubbling up) does not cut the fade short');
  listeners.transitionend?.({ target: el });
  assert.equal(el.removed, true, 'removed after its own fade');
  assert.equal(s.frameDrawn(true), false, 'once');
});

test('splash: a slow font never holds it longer than fontWaitMs', () => {
  const { doc, el } = fakeDoc();
  let t = 0;
  const s = new Splash({ doc, now: () => t });
  s.frameDrawn(true);
  t = 100; assert.equal(s.frameDrawn(true), false);
  t = SPLASH.fontWaitMs - 1; assert.equal(s.frameDrawn(true), false);
  t = SPLASH.fontWaitMs; assert.equal(s.frameDrawn(true), true);
  assert(el.classList.contains('is-done'));
});

test('splash: no font API, no loading screen, a fatal error — never left over the page', async () => {
  const noFonts = fakeDoc({ fonts: 'none' });
  const s = new Splash({ doc: noFonts.doc, now: () => 0 });
  s.frameDrawn(true);
  assert.equal(s.frameDrawn(true), true, 'without document.fonts it does not wait');
  const none = fakeDoc({ withSplash: false });
  const s2 = new Splash({ doc: none.doc });
  assert.equal(s2.done, true);
  assert(!none.doc.documentElement.classList.contains('is-loading'), 'no loading screen: the title is never left paused');
  const fatal = fakeDoc();
  assert.equal(hideSplash(fatal.doc), true, 'main.js showFatal / the safety timeout');
  assert.equal(hideSplash(fatal.doc), false, 'idempotent');
  assert.equal(hideSplash(null), false);
});

test('splash: index.html paints it before any script; its motion is transform-only; it preloads the title\'s fonts', () => {
  const html = read('index.html');
  assert(/<html[^>]*class="[^"]*\bis-loading\b/.test(html), 'html starts with is-loading');
  const splashAt = html.indexOf('<div id="splash"'), moduleAt = html.indexOf('<script type="module"');
  assert(splashAt > 0 && moduleAt > splashAt, 'the loading screen comes before the game script');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const kf of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\})\s*\}/g)) {
    const props = [...kf[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert(props.every((p) => p === 'transform'), `keyframes animate transform only (off the main thread): ${props.join(',')}`);
  }
  assert(/#splash\s*\{[^}]*pointer-events:\s*none/.test(css), 'never blocks a click');
  const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin \/>/g)].map((m) => m[1]);
  assert.equal(preloads.length, 3, preloads.join());
  for (const p of preloads) {
    assert(p.startsWith('/node_modules/@fontsource/'), p);
    assert(existsSync(join(ROOT, p)), `${p} exists`);
  }
});

test('splash: the title intro waits for it; the app reports frames; main.js has the safety net', () => {
  assert(/html\.is-loading \.gu-title-screen,\s*html\.is-loading \.gu-title-screen \*\s*\{\s*animation-play-state:\s*paused !important;/.test(read('src/ui/styles.css')));
  const app = read('src/app/app.js');
  assert(/new Splash\(\)/.test(app) && /splash\?\.frameDrawn\(this\.ui\.isOpen \|\| !!this\.session\)/.test(app), 'boot creates it, every drawn frame reports');
  const main = read('src/main.js');
  assert(/function showFatal\(err\) \{\s*hideSplash\(\);/.test(main), 'a fatal error removes it');
  assert(/setTimeout\(\(\) => hideSplash\(\), SPLASH\.safetyMs\)/.test(main), 'a safety timeout removes it');
});

test('splash: if the game\'s code never runs, index.html says so (Reload) instead of loading forever', () => {
  const html = read('index.html');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert(/addEventListener\('load', function \(\) \{ if \(!window\.__gloveMain\) fail\(\); \}\)/.test(inline), 'by the load event the module has run or failed');
  assert(/addEventListener\('error', function \(e\) \{[^}]*tagName === 'SCRIPT'[^}]*fail\(\);[^}]*\}, true\)/.test(inline), 'a script that fails to download says so at once');
  assert(/<div class="splash__fail" hidden>[\s\S]*?<button type="button" onclick="location\.reload\(\)">Reload<\/button>/.test(html), 'the message and a Reload button, hidden until needed');
  assert(/<noscript>[\s\S]*?needs JavaScript[\s\S]*?<\/noscript>/.test(html), 'JavaScript switched off');
  const ns = html.match(/<noscript>([\s\S]*?)<\/noscript>/)[1];
  assert(/\.splash__bar, \.splash__sr \{ display: none; \}/.test(ns) && /\.splash__mark \{ animation: none; \}/.test(ns) && /\.splash__name \{ opacity: 1; \}/.test(ns), 'without JavaScript it reads as a message, not as loading');
  const main = read('src/main.js');
  const body = main.replace(/^(\s*(\/\/.*|import .*;)?\n)*/, '');
  assert(body.startsWith('window.__gloveMain = true;'), 'main.js marks itself as run before anything else');
});

test('splash: painted before the start-up work; the in-game Reduced motion setting stills it', () => {
  const main = read('src/main.js');
  assert(/requestAnimationFrame\(\(\) => setTimeout\(start, 0\)\)/.test(main), 'the game starts after the next paint');
  const html = read('index.html');
  assert(html.includes(`localStorage.getItem('${STORAGE_KEYS.settings}')`) && /reducedMotion === true/.test(html), 'reads the saved setting (the same key as storage.js)');
  assert(/html\.splash-still \.splash__mark, html\.splash-still \.splash__bar span \{ animation: none; \}/.test(html));
});
