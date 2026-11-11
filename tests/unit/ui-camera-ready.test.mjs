// Camera check "ready once, stays ready" (src/ui/screens/camera-setup.js, user request 2026-11-08): a player fully
// in view (head, shoulders, both hands) for UI_TUNING.readyHoldMs = 2 s in a row is READY and stays ready on that
// screen while they step to the computer to click Continue (hands out of the picture). Only a camera change, a
// camera / tracker error or a stale feed (> 1.5 s without fresh frames; not the first readings after a page stall)
// clears it. Driven over a tiny fake DOM with the real screen; and the removed hand pointer stays removed from src/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import * as kit from '../../src/ui/screens/kit.js';
import cameraSetup from '../../src/ui/screens/camera-setup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { UI_TUNING } = kit;

// ───────────── a minimal DOM: enough for kit.js h()/svg()/button()/icon()/cycler() and class selectors ─────────────
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class N0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
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
  }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); else this.attrs.set(k, String(v)); }
  getAttribute(k) { if (k.startsWith('data-')) return this.dataset[camel(k.slice(5))] ?? null; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  addEventListener() {}
  removeEventListener() {}
  focus() { this.ownerDocument.activeElement = this; }
  matches(sel) { const want = sel.split('.').filter(Boolean); const have = this.className.split(/\s+/); return want.every((c) => have.includes(c)); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
async function withDom(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = { activeElement: null };
  doc.createElement = (t) => new E0(doc, t);
  doc.createElementNS = (_ns, t) => new E0(doc, t);
  doc.createTextNode = (t) => new T0(doc, t);
  globalThis.document = doc;
  try { return await fn(doc); } finally { if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document; }
}

/** A player fully in view centred at x (nose, shoulders 0.16 of the picture apart, both fists up); `hide`: landmarks out of view. */
function body(x = 0.5, hide = []) {
  const L = Array.from({ length: 33 }, () => ({ x, y: 0.9, z: 0, visibility: 0.05 }));
  const put = (i, dx, y) => { L[i] = { x: x + dx, y, z: 0, visibility: 0.95 }; };
  put(LM.NOSE, 0, 0.3); put(LM.LEFT_SHOULDER, 0.08, 0.45); put(LM.RIGHT_SHOULDER, -0.08, 0.45);
  put(LM.LEFT_WRIST, 0.05, 0.36); put(LM.RIGHT_WRIST, -0.05, 0.36);
  for (const i of hide) L[i] = { ...L[i], visibility: 0.05 };
  return { image: L, world: L.map(() => ({ x: 0, y: 0, z: 0 })), score: 0.95 };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The real screen with a scripted camera: run(t0, t1, players) feeds a frame every 33 ms and reads the screen back. */
function camCheck(doc, { players = 1, calibrated = false, cameras = [] } = {}) {
  const status = { frameAgeMs: 30, error: null };
  const S = { frame: null, done: [], sfx: [], setCamera: [] };
  const ctx = {
    done: (r) => S.done.push(r), sfx: (n) => S.sfx.push(n), settings: () => ({}),
    storage: { saveSettings: (s) => ({ settings: s }) },
    deps: { load: async (n) => (n === 'camera' ? { listCameras: async () => cameras } : null), peek: () => null },
    bus: { on: () => () => {} },
    input: { status, setCamera: async (id) => { S.setCamera.push(id); } },
    ui: { latestFrame: () => S.frame, getVideo: () => null, back() {}, loading() {}, applySettings() {} },
  };
  const inst = cameraSetup.create(ctx, { players, calibrated });
  const footer = inst.el.querySelector('.gu-footer');
  const cont = footer.children.at(-1);
  const recal = footer.querySelectorAll('.gu-btn').find((b) => b.querySelector('.gu-btn__label')?.textContent === 'Recalibrate') || null;
  const read = (t) => ({
    t, enabled: !cont.disabled, label: cont.querySelector('.gu-btn__label').textContent, recal: recal ? !recal.disabled : null,
    chips: inst.el.querySelectorAll('.gu-pchip').map((c) => c.dataset.state), texts: inst.el.querySelectorAll('.gu-pchip__text').map((c) => c.textContent),
  });
  const run = (t0, t1, ps) => {
    const out = [];
    for (let t = t0; t <= t1; t += 33) { S.frame = { players: ps }; inst.update(0.033, t); out.push(read(t)); }
    return out;
  };
  return { inst, status, S, cont, recal, run, read };
}

test('camera check B: readyHoldMs is 2 s — fully in view that long makes P1 ready ("Looking good — hold it…" before)', async () => {
  assert.equal(UI_TUNING.readyHoldMs, 2000);
  await withDom(async (doc) => {
    const c = camCheck(doc, { calibrated: true });
    const s = c.run(0, 2500, [body()]);
    const before = s.filter((x) => x.t < 2000);
    assert(before.every((x) => !x.enabled && !x.recal && x.chips[0] === 'partial' && x.texts[0] === 'Looking good — hold it…' && x.label === 'Waiting for you…'),
      `before 2 s: ${JSON.stringify(before.find((x) => x.enabled || x.chips[0] !== 'partial'))}`);
    const first = s.find((x) => x.enabled);
    assert(first && first.t >= 2000 && first.t <= 2040, `ready at ${first?.t} ms`);
    assert(first.recal && first.chips[0] === 'ready' && first.texts[0] === 'P1 ready' && first.label === 'Continue');
    assert.equal(doc.activeElement, c.cont, 'the first time everyone is ready, Continue gets the focus (Enter / Space continue)');
    assert.equal(c.inst.focus(), c.cont);
    assert.deepEqual(c.S.sfx, ['ui-ready']);
    // out of the picture before 2 s: as before (the hold starts over)
    const d = camCheck(doc);
    const s2 = [...d.run(0, 1500, [body()]), ...d.run(1533, 1700, []), ...d.run(1733, 4000, [body()])];
    assert(s2.filter((x) => x.t >= 1533 && x.t <= 1700).every((x) => x.chips[0] === 'missing' && x.texts[0] === 'Not visible — step into the picture'));
    assert(s2.filter((x) => x.t < 1733 + 1980).every((x) => !x.enabled), 'the 2 s start again after leaving the picture');
    assert(s2.at(-1).enabled);
  });
});

test('camera check B: once ready, P1 stays ready while a hand, the head or the whole player leaves the picture — Continue still clicks', async () => {
  await withDom(async (doc) => {
    const c = camCheck(doc, { calibrated: true });
    c.run(0, 2100, [body()]);
    const away = [
      ...c.run(2133, 3000, [body(0.5, [LM.LEFT_WRIST])]),                // one hand drops out (reaching for the touchpad)
      ...c.run(3033, 3500, [body(0.5, [LM.LEFT_WRIST, LM.RIGHT_WRIST])]),
      ...c.run(3533, 4000, [body(0.5, [LM.NOSE])]),                       // turned away
      ...c.run(4033, 9000, []),                                           // nobody in the picture
    ];
    const bad = away.find((x) => !x.enabled || !x.recal || x.chips[0] !== 'ready' || x.label !== 'Continue');
    assert(!bad, `dropped at ${bad?.t} ms: ${JSON.stringify(bad)}`);
    assert.deepEqual(c.S.sfx, ['ui-ready'], 'no second "ready" sound');
    c.cont.__guAction(c.cont, 'pointer');
    assert.deepEqual(c.S.done, [{ action: 'continue', deviceId: null }], 'the click goes through with nobody in view');
  });
});

test('camera check B: a stale feed or a camera / tracker error clears ready; then it takes 2 s in view again', async () => {
  await withDom(async (doc) => {
    const c = camCheck(doc);
    c.run(0, 2100, [body()]);
    c.status.frameAgeMs = 1600; // no fresh frame for 1.6 s
    let s = c.run(2133, 2400, [body()]);
    assert(s.every((x) => !x.enabled && x.chips[0] === 'missing'), `stale: ${JSON.stringify(s[0])}`);
    c.status.frameAgeMs = 30;
    s = c.run(2433, 5000, [body()]);
    let first = s.find((x) => x.enabled);
    assert(first && first.t - 2433 >= 1980 && first.t - 2433 <= 2040 && s[0].chips[0] === 'partial', `ready again ${first ? first.t - 2433 : 'never'} ms after the feed came back`);
    // a tracker error while the player is in view
    c.status.error = 'Pose tracking stopped'; c.status.errorCode = 'init-failed'; c.status.errorSource = 'tracker';
    s = c.run(5033, 5033, [body()]);
    assert(!s[0].enabled && s[0].chips[0] !== 'ready' && !c.inst.el.querySelector('.gu-camsetup__error').hidden, 'the error shows and ready is gone');
    c.status.error = null;
    s = c.run(5066, 8000, [body()]);
    first = s.find((x) => x.enabled);
    assert(first && first.t - 5033 >= 1980 && first.t - 5033 <= 2040, `ready again ${first ? first.t - 5033 : 'never'} ms after the error`);
    // without a frame at all (latestFrame() null) it is the same as a stale feed
    c.S.frame = null;
    c.inst.update(0.033, 8033);
    assert(!c.read(8033).enabled);
  });
});

test('camera check B: after a page stall or tab switch the first stale readings keep ready, a feed that stays stale clears it, a hold in progress starts over', async () => {
  await withDom(async (doc) => {
    const c = camCheck(doc);
    c.run(0, 2100, [body()]);
    c.status.frameAgeMs = 3000; // no updates for 3 s; the first readings back still carry the old frame age
    let s = c.run(5100, 5400, [body()]);
    assert(s.every((x) => x.enabled && x.chips[0] === 'ready'), `ready right after the gap: ${JSON.stringify(s.find((x) => !x.enabled))}`);
    s = c.run(5433, 7600, [body()]);
    assert(!s.at(-1).enabled, 'a feed that stays stale clears ready');
    c.status.frameAgeMs = 30;
    s = c.run(7633, 8600, [body()]); // a new hold, 1 s in …
    assert(s.every((x) => !x.enabled));
    s = c.run(10100, 12000, [body()]); // … then 1.5 s without updates: nobody was watched, the 2 s start again
    assert(s.every((x) => !x.enabled), `ready ${s.find((x) => x.enabled)?.t} ms: the hold did not start over`);
    assert(c.run(12033, 12300, [body()]).at(-1).enabled);
  });
});

test('camera check B: choosing another camera clears ready (the new camera has to see the player for 2 s)', async () => {
  await withDom(async (doc) => {
    const c = camCheck(doc, { cameras: [{ deviceId: 'a', label: 'Front' }, { deviceId: 'b', label: 'USB' }] });
    await flush(); // the picker loads the camera list
    const picker = c.inst.el.querySelector('.gu-cycler');
    assert(picker, 'two cameras: a picker');
    c.run(0, 2100, [body()]);
    picker.step(1);
    assert.deepEqual(c.S.setCamera, ['b']);
    const s = c.run(2133, 4500, [body()]);
    assert(s[0].chips[0] === 'partial' && !s[0].enabled, 'not ready on the new camera yet');
    const first = s.find((x) => x.enabled);
    assert(first && first.t - 2133 >= 1980 && first.t - 2133 <= 2040, `ready ${first ? first.t - 2133 : 'never'} ms after the switch`);
  });
});

test('camera check B (versus): each boxer locks on their own — P1 stays ready away from the camera while P2 gets ready', async () => {
  await withDom(async (doc) => {
    const c = camCheck(doc, { players: 2 });
    let s = c.run(0, 2500, [body(0.28)]);
    assert(s.at(-1).chips[0] === 'ready' && s.at(-1).chips[1] === 'missing' && s.at(-1).texts[1] === 'P2 not visible — step into the right half');
    assert(s.every((x) => !x.enabled && x.label === 'Waiting for both boxers…'), 'Continue waits for both');
    s = c.run(2533, 5000, [null, body(0.72)]); // P1 walks to the computer, P2 steps in
    assert(s.every((x) => x.chips[0] === 'ready'), 'P1 stays ready');
    const first = s.find((x) => x.enabled);
    assert(first && first.t - 2533 >= 1980 && first.t - 2533 <= 2040 && first.label === 'Continue', `both ready ${first ? first.t - 2533 : 'never'} ms after P2 stepped in`);
    assert(s.filter((x) => x.t < first.t).every((x) => x.chips[1] === 'partial'));
    assert.equal(doc.activeElement, c.cont);
    s = c.run(5033, 6000, []);
    assert(s.every((x) => x.enabled && x.chips.every((st) => st === 'ready')), 'both stay ready with nobody in view');
  });
});

// ───────────── the hand pointer is gone ─────────────
function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}

test('pointer removed: no hand pointer left in src (module, hub, UI, kit helpers, screen attributes, styles)', () => {
  assert(!existsSync(join(ROOT, 'src/input/hand-cursor.js')), 'src/input/hand-cursor.js is deleted');
  for (const k of ['dwellMs', 'cursorPadPx', 'cursorStickPx']) assert(!(k in UI_TUNING), `UI_TUNING.${k} is gone`);
  assert.equal(kit.hitTest, undefined, 'kit.js hitTest is gone');
  // code only: comments may tell the history
  const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
  const LEFT = /HandCursor|CURSOR_TUNING|hand-cursor|updateCursor|HAND_HINT|HINT_EDGE|data-hand-confirm|handConfirm|data-cursor-off|cursorOff|data-cursor-repeat|cursorRepeat|gu-hand\b|gu-hand__|gu-btn__dwell|is-hand-confirm|is-cursor-hover|dwellMs|cursorPadPx|cursorStickPx|hitTest|FreshRaise|freshRaise/;
  const left = [];
  for (const p of walk(join(ROOT, 'src'))) {
    if (!/\.(m?js|css)$/.test(p)) continue;
    const m = code(p).match(LEFT);
    if (m) left.push(`${relative(ROOT, p)}: ${m[0]}`);
  }
  assert.deepEqual(left, []);
  // the calibration's "stuck" tip no longer tells the player to raise a hand to pick
  assert(!/raise one hand|by hand/i.test(code(join(ROOT, 'src/ui/screens/calibrate.js'))));
});
