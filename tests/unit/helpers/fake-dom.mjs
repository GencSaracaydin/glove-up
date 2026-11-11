// A minimal DOM for screen tests in Node: enough for kit.js h()/svg()/button()/icon()/progressRing() and class
// selectors (the same model as tests/unit/ui-camera-ready.test.mjs). withDom(fn) installs it as globalThis.document.
import { LM } from '../../../src/core/types.js';

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class N0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) if (c != null) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  replaceChildren(...cs) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...cs); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
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
    Object.assign(this, { nodeType: 1, tagName: String(tag).toUpperCase(), attrs: new Map(), dataset: {}, className: '', hidden: false, disabled: false });
    this.style = { setProperty() {}, removeProperty() {} };
    const el = this;
    this.classList = {
      add: (...cs) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); el.className = [...s].join(' '); },
      remove: (...cs) => { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(' '); },
      contains: (c) => el.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const want = on === undefined ? !el.classList.contains(c) : !!on; if (want) el.classList.add(c); else el.classList.remove(c); return want; },
    };
  }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); else this.attrs.set(k, String(v)); }
  getAttribute(k) { if (k.startsWith('data-')) return this.dataset[camel(k.slice(5))] ?? null; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  addEventListener() {}
  removeEventListener() {}
  focus() { this.ownerDocument.activeElement = this; }
  matches(sel) { const want = sel.split('.').filter(Boolean); const have = this.className.split(/\s+/); return want.every((c) => have.includes(c)); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** Run fn(doc) with the fake document installed as globalThis.document. */
export async function withDom(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = { activeElement: null };
  doc.createElement = (t) => new E0(doc, t);
  doc.createElementNS = (_ns, t) => new E0(doc, t);
  doc.createTextNode = (t) => new T0(doc, t);
  globalThis.document = doc;
  try { return await fn(doc); } finally { if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document; }
}

/** A player in view centred at x (nose, shoulders 0.16 of the picture apart, both fists up); `hide`: landmarks out of view. */
export function body(x = 0.5, hide = []) {
  const L = Array.from({ length: 33 }, () => ({ x, y: 0.9, z: 0, visibility: 0.05 }));
  const put = (i, dx, y) => { L[i] = { x: x + dx, y, z: 0, visibility: 0.95 }; };
  put(LM.NOSE, 0, 0.3); put(LM.LEFT_SHOULDER, 0.08, 0.45); put(LM.RIGHT_SHOULDER, -0.08, 0.45);
  put(LM.LEFT_WRIST, 0.05, 0.36); put(LM.RIGHT_WRIST, -0.05, 0.36);
  for (const i of hide) L[i] = { ...L[i], visibility: 0.05 };
  return { image: L, world: L.map(() => ({ x: 0, y: 0, z: 0 })), score: 0.95 };
}
