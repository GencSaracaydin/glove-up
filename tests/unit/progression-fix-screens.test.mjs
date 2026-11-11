// FLOWS-06 / FLOWS-07 / FLOWS-11 regressions on the real boxer screens (src/ui/screens/profiles.js,
// profile-editor.js) over a tiny fake DOM, driven the way src/ui/ui.js drives them: a sub-screen's
// result goes to the parent's refresh() and the parent's focus() is asked BEFORE the sub-screen's
// promise resolves (UI._done); every activation calls the button's __guAction.
import { test, assert } from '../harness.mjs';
import { Storage, STORAGE_LIMITS } from '../../src/core/storage.js';
import profilesScreen from '../../src/ui/screens/profiles.js';
import * as editorModule from '../../src/ui/screens/profile-editor.js';
import { makeBackend, makeDeterministic } from './storage-fakes.test.mjs';

const graphemes = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
const editorScreen = editorModule.default;
const DELETE_CONFIRM_MIN_MS = editorModule.DELETE_CONFIRM_MIN_MS ?? 600;
const DELETE_ARMED_MS = editorModule.DELETE_ARMED_MS ?? 3000;

// ───────────── a minimal DOM: enough for h()/svg()/button() and simple selectors ─────────────
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class Node0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument.body) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
class Text0 extends Node0 {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class El extends Node0 {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.dataset = {}; this.listeners = {};
    this.className = ''; this.disabled = false; this.value = ''; this.id = ''; this.title = ''; this.type = ''; this.selectionStart = null; this.selectionEnd = null;
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { el.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { el.className = list().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, force) => { const on = force ?? !list().includes(c); if (on) el.classList.add(c); else el.classList.remove(c); return on; },
      contains: (c) => list().includes(c),
    };
  }
  setAttribute(k, v) {
    const s = String(v);
    if (k === 'class') this.className = s;
    else if (k === 'value') this.value = s;
    else if (k === 'id') this.id = s;
    else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = s;
    else this.attrs.set(k, s);
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    if (k.startsWith('data-')) { const v = this.dataset[camel(k.slice(5))]; return v === undefined ? null : v; }
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { if (k.startsWith('data-')) delete this.dataset[camel(k.slice(5))]; else this.attrs.delete(k); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {}, ...ev }); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }; }
  scrollIntoView() {}
  get offsetWidth() { return 10; }
  matches(sel) { return matchesSel(this, sel); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
/** Simple selectors: tag, .class, #id, [attr], [attr="v"], compounds, and descendant combinators. */
function matchesSel(el, sel) {
  const parts = sel.trim().split(/\s+/);
  const one = (e, p) => {
    const re = /(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])|(^[a-zA-Z][\w-]*)/g;
    let m, ok = true;
    while ((m = re.exec(p)) && ok) {
      if (m[1]) ok = e.classList.contains(m[1].slice(1));
      else if (m[2]) ok = e.id === m[2].slice(1);
      else if (m[3]) {
        const [, k, v] = /^\[([\w-]+)(?:=["']?(.*?)["']?)?\]$/.exec(m[3]) || [];
        const got = e.getAttribute(k);
        ok = v === undefined ? got !== null : got === v.replace(/\\(.)/g, '$1');
      } else if (m[4]) ok = e.tagName === m[4].toUpperCase();
    }
    return ok;
  };
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
  const doc = { activeElement: null };
  doc.createElement = (t) => new El(doc, t);
  doc.createElementNS = (_ns, t) => new El(doc, t);
  doc.createTextNode = (t) => new Text0(doc, t);
  doc.body = new El(doc, 'body');
  return doc;
}
/** Run fn with document / CSS / a controllable performance.now installed, then restore them. */
async function withDom(fn) {
  const saved = { document: globalThis.document, CSS: globalThis.CSS, now: performance.now };
  const doc = makeDocument();
  const clock = { t: 10_000 };
  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  performance.now = () => clock.t;
  try { return await fn(doc, clock); } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.CSS === undefined) delete globalThis.CSS; else globalThis.CSS = saved.CSS;
    performance.now = saved.now;
  }
}

/** A ScreenCtx like ui.js builds one; sub() resolves when the test says so. */
function makeCtx(storage, doc) {
  const log = { toasts: [], done: [], subs: [], refocus: 0 };
  const ctx = {
    storage, log, ui: { back() {} },
    settings: () => storage.settings(),
    deps: { peek: () => null, load: () => Promise.resolve(null) },
    portrait: () => { const el = doc.createElement('div'); el.setLook = () => {}; return el; },
    toast: (t) => log.toasts.push(t), sfx() {}, refocus: () => { log.refocus++; }, arm() {},
    done: (r) => log.done.push(r),
    sub: (id, params) => new Promise((resolve) => log.subs.push({ id, params, resolve })),
  };
  return ctx;
}
const btn = (root, re) => root.querySelectorAll('button').find((b) => re.test(b.getAttribute('aria-label') || b.textContent));
const press = (b) => b.__guAction(b, 'pointer');

test('FLOWS-06: after creating a 5th boxer the boxers screen shows its page and focuses it (Enter boxes as them)', async () => {
  await withDom(async (doc) => {
    const storage = new Storage({ backend: makeBackend(), ...makeDeterministic() });
    for (const n of ['Ann', 'Bob', 'Cat', 'Dan']) storage.createProfile({ name: n });
    const ctx = makeCtx(storage, doc);
    const inst = profilesScreen.create(ctx, {});
    doc.body.appendChild(inst.el);
    const names = () => inst.el.querySelectorAll('.gu-boxer-card__name').map((e) => e.textContent);
    assert.deepEqual(names(), ['Ann', 'Bob', 'Cat', 'Dan']);
    press(btn(inst.el, /^New boxer/));
    assert.equal(ctx.log.subs.at(-1).id, 'profile-editor');
    // the editor saves 'Eve'; UI._done: parent.refresh(result) → focus the parent → resolve the sub
    const save = storage.createProfile({ name: 'Eve' });
    const result = { action: 'saved', profile: save.profile, save };
    inst.refresh(result);
    const focused = inst.focus();
    ctx.log.subs.at(-1).resolve(result);
    await Promise.resolve();
    assert.deepEqual(names(), ['Eve'], 'the new boxer\'s page');
    assert.equal(inst.el.querySelector('.gu-pager__label').textContent, 'Page 2 of 2');
    assert.equal(focused?.getAttribute('aria-label'), 'Box as Eve', 'focus on the new boxer');
    press(focused);
    assert.equal(ctx.log.done.at(-1).profile.name, 'Eve', 'Enter boxes as the boxer just made');
    // editing a boxer on page 1 brings its page back; deleting the focused one clears the focus
    const ann = storage.listProfiles()[0];
    inst.refresh({ action: 'saved', profile: storage.updateProfile(ann.id, { name: 'Annie' }).profile });
    assert.equal(inst.focus()?.getAttribute('aria-label'), 'Box as Annie');
    assert.equal(inst.el.querySelector('.gu-pager__label').textContent, 'Page 1 of 2');
    storage.deleteProfile(ann.id);
    inst.refresh({ action: 'deleted', id: ann.id });
    assert.notEqual(inst.focus()?.getAttribute('aria-label'), 'Box as Annie');
    inst.destroy?.();
  });
});

test('FLOWS-04: the boxers screen follows another tab (subscribe → render) and stops on destroy', async () => {
  await withDom(async (doc) => {
    const backend = makeBackend();
    const here = new Storage({ backend, ...makeDeterministic() });
    here.createProfile({ name: 'Ann' });
    const there = new Storage({ backend, idGen: (p) => `${p}_there` });
    const ctx = makeCtx(here, doc);
    const inst = profilesScreen.create(ctx, {});
    doc.body.appendChild(inst.el);
    const names = () => inst.el.querySelectorAll('.gu-boxer-card__name').map((e) => e.textContent);
    there.createProfile({ name: 'Zed' });
    here.syncExternal(null); // what the window 'storage' event does
    assert.deepEqual(names(), ['Ann', 'Zed']);
    assert(ctx.log.refocus >= 1, 'focus restored after the re-render');
    inst.destroy();
    there.createProfile({ name: 'Yan' });
    here.syncExternal(null);
    assert.deepEqual(names(), ['Ann', 'Zed'], 'no re-render once the screen is gone');
  });
});

test('FLOWS-07: a double-click on Delete never deletes; a deliberate second press does', async () => {
  await withDom(async (doc, clock) => {
    const storage = new Storage({ backend: makeBackend(), ...makeDeterministic() });
    const keeper = storage.createProfile({ name: 'Keeper' }).profile;
    const ctx = makeCtx(storage, doc);
    const open = () => { const inst = editorScreen.create(ctx, { profile: storage.getProfile(keeper.id) }); doc.body.appendChild(inst.el); return inst; };
    let inst = open();
    const del = () => btn(inst.el, /^(Delete|Tap again to delete)$/);
    const label = () => del().querySelector('.gu-btn__label').textContent;
    press(del());
    assert.equal(label(), 'Tap again to delete', 'armed');
    clock.t += 120; // a double-click's second press
    press(del());
    assert(storage.getProfile(keeper.id), 'still there after a double-click');
    assert.deepEqual(ctx.log.done, []);
    assert.equal(label(), 'Tap again to delete', 'still armed');
    clock.t += DELETE_CONFIRM_MIN_MS - 120 - 1; // 1 ms short of the minimum
    press(del());
    assert(storage.getProfile(keeper.id), 'too early by a millisecond');
    clock.t += 200; // 0.8 s after arming: deliberate
    press(del());
    assert.equal(storage.getProfile(keeper.id), null, 'deleted');
    assert.deepEqual(ctx.log.done.at(-1), { action: 'deleted', id: keeper.id });
    // the arm runs out: a press 3 s later only arms again
    const other = storage.createProfile({ name: 'Other' }).profile;
    inst = editorScreen.create(ctx, { profile: storage.getProfile(other.id) });
    doc.body.appendChild(inst.el);
    press(del());
    clock.t += DELETE_ARMED_MS + 50;
    press(del());
    assert(storage.getProfile(other.id), 'an expired arm re-arms');
    clock.t += DELETE_CONFIRM_MIN_MS + 50;
    press(del());
    assert.equal(storage.getProfile(other.id), null);
  });
});

test('FLOWS-11: the name field keeps whole emoji and joiners, stops at 16 characters, and stores them intact', async () => {
  await withDom(async (doc) => {
    const storage = new Storage({ backend: makeBackend(), ...makeDeterministic() });
    const ctx = makeCtx(storage, doc);
    const c = (...cp) => String.fromCodePoint(...cp);
    const ZWJ = c(0x200d);
    const family = c(0x1f469) + ZWJ + c(0x1f469) + ZWJ + c(0x1f467) + ZWJ + c(0x1f466);
    const typed = c(0x1f94a, 0x1f525) + ' Ünïcødé ' + family; // 12 user-perceived characters, 24 UTF-16 units
    const persian = 'می' + c(0x200c) + 'خواهم';
    for (const [value, want] of [[typed, typed], ['Kim ' + c(0x1f3f3, 0xfe0f) + ZWJ + c(0x1f308), 'Kim ' + c(0x1f3f3, 0xfe0f) + ZWJ + c(0x1f308)], [persian, persian],
      ['abcdefghijklmnopqrstu', 'abcdefghijklmnop'], [family.repeat(20), family.repeat(9)]]) {
      const inst = editorScreen.create(ctx, {});
      doc.body.appendChild(inst.el);
      const field = inst.el.querySelector('.gu-editor__name');
      assert.equal(field.getAttribute('maxlength'), null, 'no UTF-16 maxlength on the field');
      field.value = value; // a paste or an emoji picker inserts the whole sequence at once
      field.selectionStart = value.length;
      field.fire('input', { isComposing: false });
      assert.equal(field.value, want, `field after inserting ${JSON.stringify(value).slice(0, 30)}`);
      assert(graphemes(field.value).length <= STORAGE_LIMITS.nameMaxLength);
      press(btn(inst.el, /^Create boxer/));
      assert.equal(ctx.log.done.at(-1).profile.name, want, 'stored as shown');
    }
    // while an IME composes, the field is left alone; the limit applies when composition ends
    const inst = editorScreen.create(ctx, {});
    doc.body.appendChild(inst.el);
    const field = inst.el.querySelector('.gu-editor__name');
    field.value = 'x'.repeat(20);
    field.fire('input', { isComposing: true });
    assert.equal(field.value.length, 20);
    field.fire('compositionend');
    assert.equal(field.value.length, 16);
    // a name of nothing visible becomes a random name, never "Boxer" by accident or an invisible one
    field.value = ZWJ + ' ' + ZWJ;
    field.fire('input', { isComposing: false });
    press(btn(inst.el, /^Create boxer/));
    const made = ctx.log.done.at(-1).profile.name;
    assert(/[A-Za-z]/.test(made) && !made.includes(ZWJ), `random name ${JSON.stringify(made)}`);
  });
});
