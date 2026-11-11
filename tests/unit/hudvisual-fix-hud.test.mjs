// hudvisual fix pass — the in-bout HUD (src/ui/hud.js) over a tiny fake DOM, plus the CSS rules it relies on.
//  VISUAL-08 / RELEASE-06: the KO replay tag is our own marker (a badge with a replay arrow) — no
//              three-triangle prefix — and keeps the pill, the bottom-left corner and the word "Replay".
//  FLOWS-05:   during the whole outro (one full-screen view) the HUD root carries .is-outro and the CSS hides
//              the versus divider and the P1/P2 tags; the class goes when the outro ends.
//  VISUAL-12:  a tutorial step change resets the check mark and the progress bar with transitions off, so
//              the new card never shows the previous card's check or a draining full bar.
//  VISUAL-13:  the tutorial card sits at the lower left, directly above the caption band (D17).
//  VISUAL-15:  menu pages keep the 16:9 layout, centred, on desktop windows wider than 16:9 — not on landscape
//              phones (RV-VISUAL-03: 844×390 keeps its 27.5 px gutters).
import { test, assert } from '../harness.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hud } from '../../src/ui/hud.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_RAW = readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8');
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, ''); // comments out: they hold commas and braces-free prose

// ───────────── a minimal DOM: enough for kit.js h()/svg()/icon()/clear() and the Hud ─────────────
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class N0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) if (c != null) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  replaceChildren(...cs) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...cs); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
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
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.dataset = {}; this.className = ''; this.hidden = false; this.title = '';
    const props = {};
    this.style = { setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: (k) => props[k] ?? '', removeProperty: (k) => { delete props[k]; } };
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
  getAttribute(k) { if (k === 'class') return this.className || null; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener() {}
  removeEventListener() {}
  /** A forced reflow: lets a test see the element's state at that exact moment. */
  get offsetWidth() { this.ownerDocument.onReflow?.(this); return 100; }
  matches(sel) { return matches(this, sel); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
/** Simple selectors: tag, .class, compounds (tag.a.b) and descendant combinators. */
function matches(el, sel) {
  const one = (e, p) => {
    let ok = true;
    for (const m of p.matchAll(/(\.[\w-]+)|(^[a-zA-Z][\w-]*)/g)) {
      if (m[1]) ok = ok && e.classList.contains(m[1].slice(1));
      else if (m[2]) ok = ok && e.tagName === m[2].toUpperCase();
    }
    return ok;
  };
  const parts = sel.trim().split(/\s+/);
  if (!one(el, parts.at(-1))) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (n && n.nodeType === 1 && !one(n, parts[i])) n = n.parentNode;
    if (!n || n.nodeType !== 1) return false;
    n = n.parentNode;
  }
  return true;
}
function makeDocument() {
  const doc = { onReflow: null };
  doc.createElement = (t) => new E0(doc, t);
  doc.createElementNS = (_ns, t) => new E0(doc, t);
  doc.createTextNode = (t) => new T0(doc, t);
  doc.body = new E0(doc, 'body');
  return doc;
}
/** Run fn(doc) with a fake `document` installed, then restore the global. */
async function withDom(fn) {
  const saved = globalThis.document;
  const doc = makeDocument();
  globalThis.document = doc;
  try { return await fn(doc); } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
}
const newHud = (doc) => new Hud({ root: doc.body, bus: null });

// ───────────── CSS helpers ─────────────
/** Every innermost rule of the stylesheet: {selectors: string[], body} (rules inside @media included). */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
/** Declarations of the first rule whose selector list is exactly `selector`, or null. */
function rule(selector) {
  return RULES.find((r) => r.selectors.length === 1 && r.selectors[0] === selector)?.body ?? null;
}
/** Declarations of the first rule whose selector list contains `selector` (lists like "a,\nb { … }"), or null. */
function ruleContaining(selector) {
  return RULES.find((r) => r.selectors.includes(selector))?.body ?? null;
}
const decl = (body, prop) => { const m = body && new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(body); return m ? m[1].trim() : null; };

// ───────────── VISUAL-08 / RELEASE-06 ─────────────
test('VISUAL-08 / RELEASE-06: the replay tag is our own marker — badge + "Replay", no three-triangle prefix', async () => {
  await withDom((doc) => {
    const hud = newHud(doc);
    hud.outroStage({ stage: 'start', winner: 'p1', method: 'KO' });
    hud.outroStage({ stage: 'wipe' });
    hud.outroStage({ stage: 'replay' });
    const tag = hud.outroEl.querySelector('.gu-replay');
    assert(tag, 'a .gu-replay pill during the replay');
    assert.equal(tag.textContent.trim(), 'Replay', 'the word "Replay" (e2e checks /Replay/)');
    assert.equal(tag.querySelectorAll('.gu-replay__arrows').length, 0, 'no triangle group');
    assert.equal(tag.querySelectorAll('i').length, 0, 'no triangle glyphs');
    const mark = tag.querySelector('.gu-replay__mark');
    assert(mark, 'our marker badge');
    assert.equal(mark.getAttribute('aria-hidden'), 'true', 'the badge is decoration; the word is the label');
    assert(mark.querySelector('svg.gu-icon'), 'the badge holds our replay-arrow icon');
    assert.deepEqual(tag.children.map((c) => c.className), ['gu-replay__mark', 'gu-replay__text'], 'marker, then the word');
    hud.outroStage({ stage: 'banner', winner: 'p1' });
    assert(tag.classList.contains('is-out'), 'the tag leaves when the banner comes');
    hud.outroStage({ stage: 'end' });
  });
  // the stylesheet: the pill keeps its bottom-left corner; the triangle rules and their keyframes are gone
  const pill = rule('.gu-replay');
  assert.equal(decl(pill, 'left'), '1.6rem');
  assert.equal(decl(pill, 'bottom'), '1.6rem');
  assert.equal(decl(pill, 'border-radius'), 'var(--pill)');
  assert(!/\.gu-replay__arrows/.test(CSS), 'no .gu-replay__arrows rules');
  assert(!/@keyframes gu-chevron/.test(CSS), 'no chevron keyframes');
  assert(rule('.gu-replay__mark'), '.gu-replay__mark is styled');
});

// ───────────── FLOWS-05 ─────────────
test('FLOWS-05: the versus divider and P1/P2 tags hide for the whole outro and come back after it', async () => {
  await withDom((doc) => {
    const hud = newHud(doc);
    hud.show('match', { mode: 'versus' });
    assert.equal(hud.el.querySelectorAll('.gu-hud__divider').length, 1, 'versus has a divider');
    assert.deepEqual(hud.el.querySelectorAll('.gu-hud__tag').map((t) => t.textContent), ['P1', 'P2']);
    assert(!hud.el.classList.contains('is-outro'), 'no outro yet');
    for (const stage of ['start', 'wipe', 'flash', 'replay', 'banner', 'winner']) {
      hud.outroStage({ stage, winner: 'p2', method: 'KO' });
      assert(hud.el.classList.contains('is-outro'), `.is-outro at stage ${stage}`);
    }
    // the HUD rebuilt mid-outro (ui.hide() then an update) keeps the class
    hud.show('match', { mode: 'versus' });
    assert(hud.el.classList.contains('is-outro'), 'show() during the outro keeps .is-outro');
    hud.outroStage({ stage: 'end' });
    assert(!hud.el.classList.contains('is-outro'), 'gone at the end');
    hud.outroStage({ stage: 'banner', winner: 'p1' }); // a decision outro may start at the banner
    assert(hud.el.classList.contains('is-outro'));
    hud.clearOutro();
    assert(!hud.el.classList.contains('is-outro'), 'clearOutro() (a menu screen) removes it');
    hud.show('match', { mode: 'versus' });
    assert(!hud.el.classList.contains('is-outro'), 'a new bout starts without it');
  });
  for (const sel of ['.gu-hud.is-outro .gu-hud__divider', '.gu-hud.is-outro .gu-hud__tag']) {
    assert.equal(decl(ruleContaining(sel), 'display'), 'none', `${sel} { display: none }`);
  }
});

// ───────────── VISUAL-12 ─────────────
test('VISUAL-12: a new tutorial card starts with no check and an empty bar, reset with transitions off', async () => {
  await withDom((doc) => {
    const hud = newHud(doc);
    hud.show('match', { mode: 'single' });
    hud.showTutorial({ step: 'guard-head', index: 1, total: 6, progress01: 1, mode: 'keyboard' });
    const card = hud.el.querySelector('.gu-tut__card');
    const fill = hud.el.querySelector('.gu-tut__fill');
    assert(card.classList.contains('is-complete'), 'the finished card shows its check');
    assert.equal(fill.style.getPropertyValue('--k'), '1', 'and a full bar');
    const atReflow = [];
    doc.onReflow = (el) => { if (el === card) atReflow.push({ cls: card.className, k: fill.style.getPropertyValue('--k') }); };
    hud.showTutorial({ step: 'punch-head', index: 2, total: 6, progress01: 0, mode: 'keyboard' });
    doc.onReflow = null;
    assert.equal(atReflow.length, 1, 'one forced reflow on the step change');
    const r = atReflow[0].cls.split(' ');
    assert(r.includes('is-resetting'), `the reset is applied with transitions off (classes at the reflow: ${atReflow[0].cls})`);
    assert(!r.includes('is-complete'), 'no check mark at the reflow');
    assert.equal(atReflow[0].k, '0', 'empty bar at the reflow');
    assert(!r.includes('is-new'), 'the pop-in restarts after the reflow');
    assert(!card.classList.contains('is-resetting'), 'transitions back on afterwards');
    assert(!card.classList.contains('is-complete'), 'the new card has no check');
    assert.equal(fill.style.getPropertyValue('--k'), '0', 'the new card has an empty bar');
    assert(card.classList.contains('is-new'), 'the new card pops in');
    assert.equal(hud.el.querySelector('.gu-tut__title').textContent, 'Head shots');
    // progress on the same card still animates normally (no reflow, no reset)
    doc.onReflow = () => atReflow.push('x');
    hud.showTutorial({ step: 'punch-head', index: 2, total: 6, progress01: 2 / 3, mode: 'keyboard' });
    doc.onReflow = null;
    assert.equal(atReflow.length, 1, 'no reset while the step stays the same');
    assert.equal(fill.style.getPropertyValue('--k'), String(2 / 3));
    hud.hideTutorial();
  });
  const off = ruleContaining('.gu-tut__card.is-resetting .gu-tut__fill');
  assert.equal(decl(off, 'transition'), 'none', '.is-resetting switches the bar transition off');
  assert.equal(off, ruleContaining('.gu-tut__card.is-resetting .gu-tut__check'), '… and the check mark’s');
});

// ───────────── VISUAL-13 (D17) ─────────────
test('VISUAL-13: the tutorial card is a bottom-aligned column item — lower left, right above the caption band', async () => {
  const tut = rule('.gu-tut');
  assert.equal(decl(tut, 'display'), 'flex');
  assert.equal(decl(tut, 'flex-direction'), 'column');
  assert.equal(decl(tut, 'justify-content'), 'flex-end', 'stacked from the bottom');
  assert.equal(decl(tut, 'align-items'), 'flex-start', 'left-aligned');
  const card = rule('.gu-tut__card');
  assert.equal(decl(card, 'top'), null, 'no longer pinned to the top');
  assert.equal(decl(card, 'position'), 'relative', 'in the column flow, above the band');
  const band = rule('.gu-tut__band');
  assert.equal(decl(band, 'position'), 'relative', 'the band is the column’s last item');
  assert.equal(decl(band, 'align-self'), 'stretch', 'full width');
  // the card may sit above the band's fade (z-index), but never above the screens layer (pause, menus)
  assert(decl(card, 'z-index') === null || decl(tut, 'isolation') === 'isolate', 'the card’s z-index is contained by .gu-tut');
  await withDom((doc) => {
    const hud = newHud(doc);
    hud.show('match', { mode: 'single' });
    hud.showTutorial({ step: 'stance', index: 0, total: 6, mode: 'camera' });
    const tut = hud.el.querySelector('.gu-tut');
    assert.deepEqual(tut.children.map((c) => c.className.split(' ')[0]), ['gu-tut__card', 'gu-tut__band'], 'DOM order: card, then band');
  });
});

// ───────────── VISUAL-15 / RV-VISUAL-03 ─────────────
test('VISUAL-15 / RV-VISUAL-03: desktop windows wider than 16:9 get the 16:9 layout, centred; 16:9, narrower windows and landscape phones keep the plain gutters', () => {
  assert(/^1\.5rem 2\.5rem 1\.75rem$/.test(decl(rule('.gu-page'), 'padding')), 'base padding 1.5rem 2.5rem 1.75rem');
  const pad = decl(rule('.gu-page'), 'padding-inline');
  assert(pad, '.gu-page sets padding-inline');
  assert(!/@media[^{]*\{\s*\.gu-page\s*\{/.test(CSS), 'no media query switches the page gutters on and off (they jumped at its edge)');
  const remPx = (vw, vh) => Math.max(11, Math.min(0.0125 * vw, 0.022222 * vh)); // html { font-size } in styles.css
  const evalPad = (vw, vh) => {
    const rem = remPx(vw, vh);
    const js = pad.replace(/\b(max|min)\(/g, 'Math.$1(').replace(/calc\(/g, '(').replace(/100vw/g, String(vw)).replace(/100vh/g, String(vh))
      .replace(/(\d+(?:\.\d+)?)rem/g, (_, n) => `(${n}*${rem})`).replace(/(\d+(?:\.\d+)?)px/g, '$1');
    assert(/^(?:Math\.max|Math\.min|[\d\s.()+\-*/,])+$/.test(js), `evaluable: ${js}`);
    return Function(`return ${js}`)();
  };
  const content = (vw, vh) => vw - 2 * evalPad(vw, vh);
  for (const [vw, vh] of [[1280, 720], [1920, 1080], [1366, 768], [1440, 900], [1024, 768], [2560, 1440], [800, 600]]) {
    assert.equal(evalPad(vw, vh), 2.5 * remPx(vw, vh), `${vw}×${vh}: exactly the usual 2.5rem gutters`);
  }
  // RV-VISUAL-03: phones turned sideways are wider than 1.8:1 but small: no centred column (it squeezed the menus)
  for (const [vw, vh] of [[844, 390], [932, 430], [915, 412], [740, 360]]) {
    assert.equal(evalPad(vw, vh), 2.5 * remPx(vw, vh), `${vw}×${vh} (landscape phone): plain 2.5rem gutters (${evalPad(vw, vh)} px)`);
  }
  assert.equal(evalPad(844, 390), 27.5, '844×390: 27.5 px, as before VISUAL-15');
  for (const [[vw, vh], [w169, h169]] of [[[2560, 1080], [1920, 1080]], [[3440, 1440], [2560, 1440]], [[5120, 1440], [2560, 1440]]]) {
    const r = content(vw, vh) / content(w169, h169);
    assert(r >= 1 && r < 1.02, `${vw}×${vh} shows (within 2 %) the ${w169}×${h169} page: ${Math.round(content(vw, vh))} vs ${content(w169, h169)} px`);
    assert(evalPad(vw, vh) > 0.1 * vw, `${vw}×${vh}: centred`);
  }
  assert(Math.abs(evalPad(2560, 1080) - 368) < 0.5, `2560×1080 keeps its centred column (368 px gutters, got ${evalPad(2560, 1080)})`);
  for (const [vw, vh, px] of [[1920, 950, 157.8], [1536, 730, 151.6], [1440, 790, 52.9]]) {
    assert(Math.abs(evalPad(vw, vh) - px) < 0.1, `${vw}×${vh}: ${px} px gutters as before (got ${evalPad(vw, vh).toFixed(1)})`);
  }
  // RV-VISUAL-03 (the verifier's R8): resizing a short window across 1000 px wide no longer jumps the gutters (28.9 → 60.9 px)
  for (const vh of [480, 520, 560]) {
    let worst = 0;
    for (let vw = 900; vw < 1300; vw++) worst = Math.max(worst, Math.abs(evalPad(vw + 1, vh) - evalPad(vw, vh)));
    assert(worst <= 1.01, `height ${vh}: the gutter changes by at most 1 px per px of width (worst ${worst.toFixed(2)})`);
  }
  assert(Math.abs(evalPad(1000, 520) - evalPad(999, 520)) < 1, '999 → 1000 px wide: no jump');
});
