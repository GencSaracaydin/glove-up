// ui repair round — menu flows and the pause card, on the real UI / App code over a tiny fake DOM (no browser):
//  D14 / RV-FLOWS-01: a window too small for the menus gets the small-screen card ("Continue anyway" focused, the
//               menu under it inert); dismissed, the menu gets its focus back and the card stays away.
//  Activation:  mouse / touch ('pointer') and keyboard are the only sources: a press runs the button, unlocks audio
//               and reports Ev.UI_CLICK {id, screen, source}; an unavailable (aria-disabled) button only says no.
//  RV-FLOWS-04: a pause because the picture dropped out (WebGL context lost) says so; Continue is unavailable
//               (aria-disabled; Esc / P / the hands-up gesture do nothing) until the picture is back,
//               then enabled and focused; Start over and Quit keep working; the app never resumes onto a blank arena.
// src/ui/ui.js (through src/ui/screens/deps.js) uses Vite's import.meta.glob, which Node lacks: a module hook
// replaces that one call with an empty module list (the UI then falls back exactly as when a module is missing).
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { Ev } from '../../src/core/types.js';

// (a namespace import: a named import from this builtin fails to link on some supported Node versions, RELEASE-04)
const GLOB_HOOK = 'data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!/\\/src\\/ui\\/screens\\/deps\\.js$/.test(url)) return r;
  const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  return { ...r, source: src.replace(/import\\.meta\\.glob\\(\\[[\\s\\S]*?\\]\\)/, '({})') };
}`);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ───────────── a minimal DOM: enough for kit.js h()/svg()/button()/icon(), pause.js and a few UI methods ─────────────
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class N0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) if (c != null) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
class T0 extends N0 {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class E0 extends N0 {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.dataset = {}; this.className = '';
    this.hidden = false; this.disabled = false; this.id = ''; this.title = ''; this.rect = { left: 0, top: 0, width: 0, height: 0 };
    const props = {};
    this.style = { transform: '', setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: (k) => props[k] ?? '', removeProperty: (k) => { delete props[k]; } };
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { el.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { el.className = list().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, force) => { const on = force === undefined ? !list().includes(c) : !!force; if (on) el.classList.add(c); else el.classList.remove(c); return on; },
      contains: (c) => list().includes(c),
    };
  }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); else this.attrs.set(k, String(v)); }
  getAttribute(k) { if (k === 'class') return this.className || null; if (k.startsWith('data-')) return this.dataset[camel(k.slice(5))] ?? null; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return k === 'hidden' ? !!this.hidden : this.getAttribute(k) !== null; }
  removeAttribute(k) { if (k.startsWith('data-')) delete this.dataset[camel(k.slice(5))]; else this.attrs.delete(k); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  addEventListener() {}
  removeEventListener() {}
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { const r = this.rect; return { ...r, right: r.left + r.width, bottom: r.top + r.height }; }
  matches(sel) { return sel.split(',').some((one) => matchOne(this, one.trim())); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
/** Simple selectors: .class compounds, a tag, and [attr] (no combinators). */
function matchOne(el, sel) {
  let ok = true;
  for (const m of sel.matchAll(/(\.[\w-]+)|(^[a-zA-Z][\w-]*)|\[([\w-]+)\]/g)) {
    if (m[1]) ok = ok && el.classList.contains(m[1].slice(1));
    else if (m[2]) ok = ok && el.tagName === m[2].toUpperCase();
    else if (m[3]) ok = ok && el.hasAttribute(m[3]);
  }
  return ok;
}
function makeDocument() {
  const doc = { activeElement: null };
  doc.createElement = (t) => new E0(doc, t);
  doc.createElementNS = (_ns, t) => new E0(doc, t);
  doc.createTextNode = (t) => new T0(doc, t);
  doc.body = new E0(doc, 'body');
  return doc;
}
/** Run fn(doc) with a fake document / window (W×H) / rAF installed, then restore the globals. */
async function withDom(fn, { W = 1280, H = 720 } = {}) {
  const keys = ['document', 'window', 'requestAnimationFrame', 'CSS'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const doc = makeDocument();
  const win = { innerWidth: W, innerHeight: H, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, { document: doc, window: win, requestAnimationFrame: () => 0, CSS: { escape: (s) => String(s) } });
  try { return await fn(doc, win); } finally {
    for (const k of keys) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
  }
}

// the modules under test (a load failure fails these tests, never the whole run)
let UI, pauseScreen, PAUSE_TEXT, App, button, loadError = null;
try {
  if (typeof nodeModule.register !== 'function') throw new Error('node:module register() is missing (Node ≥ 20.6 needed)');
  nodeModule.register(GLOB_HOOK);
  ({ UI } = await import('../../src/ui/ui.js'));
  ({ default: pauseScreen, PAUSE_TEXT } = await import('../../src/ui/screens/pause.js'));
  ({ App } = await import('../../src/app/app.js'));
  ({ button } = await import('../../src/ui/screens/kit.js'));
} catch (e) { loadError = e; }
const loaded = () => assert(!loadError, `could not load the UI / app modules in Node: ${loadError?.message}`);

/** A UI object with only the state its gate / activation methods read (the real methods from UI.prototype). */
function uiShell(doc) {
  const ui = Object.create(UI.prototype);
  const entryEl = doc.createElement('section');
  const inst = { el: doc.createElement('div') };
  entryEl.appendChild(inst.el);
  const entry = { def: { id: 'mode', layer: 'menu' }, el: entryEl, inst, params: {}, completed: false, armedAt: 0 };
  Object.assign(ui, {
    _stack: [entry], _gateOpen: false, _gateDismissed: false, _gateWaiters: [],
    gateEl: doc.createElement('div'), gateTitle: doc.createElement('h1'), gateText: doc.createElement('p'),
    gateBtn: button({ label: 'Continue anyway', onClick: () => ui._dismissGate() }),
    screenLayer: doc.createElement('div'), soundEl: doc.createElement('div'), hud: { visible: false }, _lastTick: 0,
    input: null, audio: null, bus: null,
  });
  ui.gateEl.appendChild(ui.gateBtn);
  ui.gateEl.hidden = true;
  ui.soundEl.hidden = true;
  return { ui, entry };
}

// ───────────── D14 / RV-FLOWS-01: the small-screen card ─────────────
test('D14 / RV-FLOWS-01: a too-small window covers the menu with the card; "Continue anyway" gives the menu its focus back and the card stays away', async () => {
  loaded();
  await withDom(async (doc, win) => {
    globalThis.requestAnimationFrame = (f) => { f(); return 0; }; // focus moves at once
    const { ui, entry } = uiShell(doc);
    const tile = button({ label: 'Single player', onClick: () => {} });
    entry.el.appendChild(tile);
    entry.inst.focus = () => tile;
    ui._checkGate();
    assert(!ui.gateOpen && ui.gateEl.hidden, '1280×720: no card');
    win.innerWidth = 650; win.innerHeight = 400; // the window shrinks: the card opens over the menu
    ui._checkGate();
    assert(ui.gateOpen && !ui.gateEl.hidden, 'the card is up');
    assert.equal(ui.gateTitle.textContent, 'Make the window bigger');
    assert(ui.screenLayer.hasAttribute('inert'), 'the menu under it takes no input');
    assert.equal(doc.activeElement, ui.gateBtn, '"Continue anyway" has the focus (Enter dismisses the card)');
    let clear = false;
    const waiting = ui.whenGateClear().then(() => { clear = true; });
    ui._checkGate();
    await Promise.resolve();
    assert(ui.gateOpen && !clear, 'it stays up (and boot steps wait) while the window is small');
    assert.equal(ui._activate(ui.gateBtn, 'keyboard'), true, '"Continue anyway"');
    assert(!ui.gateOpen && ui.gateEl.hidden && !ui.screenLayer.hasAttribute('inert'), 'the card is gone');
    assert.equal(doc.activeElement, tile, 'the menu gets its focus back');
    await waiting;
    assert(clear, 'waiting boot steps go on');
    ui._checkGate();
    assert(!ui.gateOpen, 'dismissed for the session: it stays away while the window is still small');
  });
});

// ───────────── activation: mouse / touch and keyboard only ─────────────
test('activation: a click or a key runs the button, unlocks audio and reports UI_CLICK {id, screen, source}; an unavailable (aria-disabled) button only says no', async () => {
  loaded();
  await withDom(async (doc) => {
    const { ui, entry } = uiShell(doc);
    const sfx = [], clicks = [], ran = [];
    let unlocks = 0;
    ui.audio = { needsGesture: true, unlock() { unlocks++; }, playSfx: (n) => sfx.push(n) };
    ui.bus = { emit: (name, p) => clicks.push(`${name} ${p.id} ${p.screen} ${p.source}`) };
    const cont = button({ label: 'Continue', onClick: (_el, source) => ran.push(`continue ${source}`) });
    const quit = button({ label: 'Quit', onClick: (_el, source) => ran.push(`quit ${source}`) });
    entry.el.append(cont, quit);
    assert.equal(ui._activate(quit, 'pointer'), true);
    assert.equal(ui._activate(quit, 'keyboard'), true);
    assert.deepEqual(ran, ['quit pointer', 'quit keyboard']);
    const id = quit.dataset.cursor;
    assert.deepEqual(clicks, [`${Ev.UI_CLICK} ${id} mode pointer`, `${Ev.UI_CLICK} ${id} mode keyboard`]);
    assert.equal(unlocks, 2, 'every click or key press is real input: it starts audio');
    cont.setAttribute('aria-disabled', 'true'); // e.g. the pause card's Continue while the picture is lost
    sfx.length = 0;
    assert.equal(ui._activate(cont, 'pointer'), false);
    assert.equal(ui._activate(cont, 'keyboard'), false);
    assert.deepEqual(ran, ['quit pointer', 'quit keyboard'], 'an unavailable button does not run');
    assert.deepEqual(sfx, ['ui-deny', 'ui-deny'], 'one "no" per press, mouse or keyboard');
    assert.equal(clicks.length, 2, 'and reports no click');
    // D13: until a click or key starts audio, the "Sound is off" badge shows
    ui._tick(16, {}, 0.016);
    assert.equal(ui.soundEl.hidden, false, 'sound off: the badge shows');
    ui.audio.needsGesture = false;
    ui._tick(32, {}, 0.016);
    assert.equal(ui.soundEl.hidden, true, 'audio running: the badge goes');
  });
  assert(/\.gu-btn\[aria-disabled='true'\] \{[^}]*opacity/.test(CSS), 'styles.css dims an unavailable button');
});

// ───────────── RV-FLOWS-04 ─────────────
function pauseCard(doc, params) {
  const done = [], sfx = [];
  const inst = pauseScreen.create({ done: (r) => done.push(r.action), sfx: (n) => sfx.push(n) }, { kind: 'match', canRestart: true, ...params });
  doc.body.appendChild(inst.el);
  const btn = (label) => inst.el.querySelectorAll('.gu-btn').find((b) => b.querySelector('.gu-btn__label')?.textContent === label);
  return { inst, done, sfx, btn, why: inst.el.querySelector('.gu-pause__why'), hint: inst.el.querySelector('.gu-modal__hint') };
}

test('RV-FLOWS-04: a graphics pause names the cause and keeps Continue unavailable until the picture is back, then enables and focuses it', async () => {
  loaded();
  await withDom(async (doc) => {
    let lost = true;
    const p = pauseCard(doc, { reason: 'graphics', graphicsLost: () => lost });
    const cont = p.btn('Continue');
    assert(p.why && !p.why.hidden && p.why.textContent === PAUSE_TEXT.lost, `the card says the picture dropped out ("${p.why?.textContent}")`);
    assert(/picture/i.test(PAUSE_TEXT.lost) && /waits|waiting/i.test(PAUSE_TEXT.lost), PAUSE_TEXT.lost);
    assert.equal(cont.getAttribute('aria-disabled'), 'true', 'Continue is unavailable');
    assert.equal(cont.disabled, false, '…but keeps the keyboard focus (aria-disabled, so Enter can\'t fall through to Start over)');
    assert.equal(p.inst.focus(), cont, 'the card focuses Continue');
    assert.equal(p.hint.textContent, PAUSE_TEXT.lostHint, 'the hint no longer offers the hands-up / P / Esc way to continue');
    assert.equal(p.inst.back(), true, 'Esc / P / the hands-up gesture are handled …');
    // (one Esc / P press reaches back() twice — the UI's key handler, then the app's 'pause' input event — R4)
    assert.equal(p.inst.back(), true);
    cont.__guAction(cont, 'pointer');
    p.inst.update(0.016, 0);
    assert.deepEqual(p.done, [], '… and do nothing, nor does Continue itself, while the picture is gone');
    assert.equal(p.sfx.filter((s) => s === 'ui-deny').length, 1, `one "no" sound per press, not two (${p.sfx.join(', ')})`);
    // the picture comes back
    lost = false;
    doc.activeElement = null;
    p.inst.update(0.016, 1);
    assert.equal(cont.getAttribute('aria-disabled'), null, 'Continue is enabled again');
    assert.equal(doc.activeElement, cont, 'and focused');
    assert(!p.why.hidden && p.why.textContent === PAUSE_TEXT.back, 'the card says the picture is back');
    assert.equal(p.hint.textContent, PAUSE_TEXT.hint);
    assert.equal(p.inst.back(), true);
    assert.deepEqual(p.done, ['continue'], 'now Esc / P / hands up continue');
  });
  // a second press a moment later gets its own "no"
  await withDom(async (doc) => {
    const p = pauseCard(doc, { reason: 'graphics', graphicsLost: () => true });
    const perf = globalThis.performance, now0 = perf.now();
    let fake = now0;
    const realNow = perf.now;
    perf.now = () => fake;
    try {
      p.inst.back(); fake += 12; p.inst.back(); fake += 400; p.inst.back();
    } finally { perf.now = realNow; }
    assert.equal(p.sfx.filter((s) => s === 'ui-deny').length, 2, `two presses 0.4 s apart: two "no" sounds (${p.sfx.join(', ')})`);
  });
  // R3: the picture comes back while the player has moved the keyboard focus on to Quit: it stays there (Enter quits)
  await withDom(async (doc) => {
    let lost = true;
    const p = pauseCard(doc, { reason: 'graphics', graphicsLost: () => lost });
    p.btn('Quit').focus();
    lost = false;
    p.inst.update(0.016, 1);
    assert.equal(doc.activeElement, p.btn('Quit'), 'the focus stays on Quit');
    assert.equal(p.btn('Continue').getAttribute('aria-disabled'), null, 'Continue is available again');
  });
  // Start over and Quit keep working while the picture is gone
  for (const label of ['Start over', 'Quit']) {
    await withDom(async (doc) => {
      const p = pauseCard(doc, { reason: 'graphics', graphicsLost: () => true });
      p.btn(label).__guAction(p.btn(label), 'pointer');
      assert.deepEqual(p.done, [label === 'Quit' ? 'quit' : 'restart'], `${label} works while the picture is gone`);
    });
  }
  // an ordinary pause is unchanged; a context lost while already paused for another reason is caught as well
  await withDom(async (doc) => {
    let lost = false;
    const p = pauseCard(doc, { reason: 'user', graphicsLost: () => lost });
    assert(p.why.hidden && p.btn('Continue').getAttribute('aria-disabled') === null, 'a user pause: no line, Continue available');
    assert.equal(p.hint.textContent, PAUSE_TEXT.hint);
    lost = true;
    p.inst.update(0.016, 0);
    assert(!p.why.hidden && p.btn('Continue').getAttribute('aria-disabled') === 'true', 'the picture drops out while paused: the card says so');
    assert.equal(p.inst.back(), true);
    assert.deepEqual(p.done, []);
  });
  // the pause card without a getter (older callers) behaves as before
  await withDom(async (doc) => {
    const p = pauseCard(doc, {});
    assert(p.why.hidden && p.btn('Continue').getAttribute('aria-disabled') === null);
    p.inst.back();
    assert.deepEqual(p.done, ['continue']);
  });
});

test('RV-FLOWS-04: the app never resumes onto a blank arena — Continue while the context is lost brings the card back, the bout stays paused', async () => {
  loaded();
  const log = [];
  const renderer = { contextLost: true };
  const shows = [];
  const answers = [{ action: 'continue' }, { action: 'continue' }];
  const s = {
    kind: 'match', paused: false, canPause: true, tutorialActive: false, humans: 1, nameOf: () => 'You',
    pause() { this.paused = true; log.push('pause'); }, resume() { this.paused = false; log.push(`resume (lost ${renderer.contextLost})`); },
    restart() { log.push('restart'); }, skipTutorial() {},
  };
  const app = Object.create(App.prototype);
  Object.assign(app, {
    session: s, _play: { resolve() {} }, _pausing: false, _resumedAt: -Infinity, _token: 3, _pauseReason: null, _pauseShownAt: 0,
    _lostSince: [null, null], renderer,
    bus: { emit: (name, p) => log.push(`${name}${p?.reason ? ':' + p.reason : ''}`) },
    ui: {
      show(id, params) {
        if (shows.length === 1) renderer.contextLost = false; // the picture comes back while the card is up again
        shows.push({ id, reason: params.reason, lost: typeof params.graphicsLost === 'function' ? params.graphicsLost() : undefined });
        return Promise.resolve(answers.shift());
      },
      hide() { log.push('hide'); },
    },
  });
  const ok = await app.requestPause('graphics');
  assert.equal(ok, true);
  assert.deepEqual(shows.map((x) => `${x.id}:${x.reason}:${x.lost}`), ['pause:graphics:true', 'pause:graphics:false'],
    'the first Continue (picture still gone) shows the card again; the getter follows the renderer');
  assert.deepEqual(log.filter((x) => x === 'pause' || x.startsWith('resume (')), ['pause', 'resume (lost false)'], `the session resumed once, after the restore (${log.join(', ')})`);
  assert.equal(log.filter((x) => x === 'app:resume').length, 1, 'one app:resume, no resume / pause pair while the picture was gone');
  assert(!s.paused);
});

test('RV-FLOWS-04: "Skip tutorial" while the picture is lost ends the tutorial but keeps the bout paused until the picture is back', async () => {
  loaded();
  const log = [];
  const renderer = { contextLost: true };
  const shows = [];
  const answers = [{ action: 'skip-tutorial' }, { action: 'continue' }];
  const s = {
    kind: 'match', paused: false, canPause: true, tutorialActive: true, humans: 1, nameOf: () => 'You',
    pause() { this.paused = true; log.push('pause'); }, resume() { this.paused = false; log.push(`resume (lost ${renderer.contextLost})`); },
    restart() { log.push('restart'); }, skipTutorial() { this.tutorialActive = false; log.push(`skip tutorial (paused ${this.paused})`); return true; },
  };
  const app = Object.create(App.prototype);
  Object.assign(app, {
    session: s, _play: { resolve() {} }, _pausing: false, _resumedAt: -Infinity, _token: 5, _pauseReason: null, _pauseShownAt: 0,
    _lostSince: [null, null], renderer,
    bus: { emit: (name, p) => log.push(`${name}${p?.reason ? ':' + p.reason : ''}`) },
    ui: {
      show(id, params) {
        shows.push(`${id}:${params.reason}:skip ${params.canSkipTutorial}`);
        if (shows.length === 2) renderer.contextLost = false; // the picture comes back while the card is up again
        return Promise.resolve(answers.shift());
      },
      hide() { log.push('hide'); },
    },
  });
  assert.equal(await app.requestPause('graphics'), true);
  assert.deepEqual(shows, ['pause:graphics:skip true', 'pause:graphics:skip false'], 'the card comes back (without "Skip tutorial") while the picture is gone');
  assert.deepEqual(log.filter((x) => !x.startsWith('app:pause') && x !== 'hide'), ['pause', 'skip tutorial (paused true)', 'resume (lost false)', 'app:resume'],
    `skipped at once, resumed only after the restore (${log.join(', ')})`);
  assert.equal(log.filter((x) => x === 'app:resume').length, 1, 'no resume / pause pair while the picture was gone');
});
