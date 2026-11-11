// KeyboardInput: same {control, events} shape as GestureRecognizer, default map, no key
// repeats, plausible animated hands, P2 map, custom maps.
import { test, assert, approx } from '../harness.mjs';
import { KeyboardInput, KEYBOARD_TUNING, DEFAULT_KEYMAP, keyLabel, neutralControl, HAND_POSES } from '../../src/input/keyboard.js';

function checkControlShape(c) {
  assert(typeof c.tracked === 'boolean' && typeof c.confidence === 'number');
  assert(['none', 'high', 'low'].includes(c.guard), `guard ${c.guard}`);
  assert(c.guardAmount >= 0 && c.guardAmount <= 1);
  for (const k of ['x', 'y', 'z']) assert(c.lean[k] >= -1 && c.lean[k] <= 1, `lean.${k}`);
  assert(Number.isFinite(c.head.x) && Number.isFinite(c.head.y));
  for (const h of ['left', 'right']) {
    const s = c.hands[h];
    assert(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.reach) && typeof s.punching === 'boolean', `hands.${h}`);
    assert(s.reach >= 0 && s.reach <= 1.0001);
  }
  assert(c.activity >= 0 && c.activity <= 1);
}

/** Press and release a key at time t. */
function tap(kb, code, t, holdMs = 60) { kb.handleKey(code, true, { t }); kb.handleKey(code, false, { t: t + holdMs }); }

test('keyboard: output shape matches ControlState/InputEvent', () => {
  const kb = new KeyboardInput();
  const out = kb.update(0);
  assert(Array.isArray(out.events) && out.events.length === 0);
  checkControlShape(out.control);
  checkControlShape(neutralControl({ tracked: false }));
  assert(neutralControl({ tracked: false }).tracked === false);
});

test('keyboard: J/K throw one straight punch each, events drained exactly once', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  tap(kb, 'KeyJ', 10);
  tap(kb, 'KeyK', 20);
  const out = kb.update(30);
  assert(out.events.length === 2, `got ${out.events.length}`);
  const [a, b] = out.events;
  assert(a.type === 'punch' && a.punch.hand === 'left' && a.punch.kind === 'straight' && a.punch.target === 'head');
  assert(b.punch.hand === 'right');
  assert(a.t === 10 && a.punch.t === 10 && a.punch.power === KEYBOARD_TUNING.punchPower);
  assert(kb.update(40).events.length === 0, 'events must not repeat');
});

test('keyboard: key auto-repeat and held keys never repeat punches', () => {
  const kb = new KeyboardInput();
  kb.handleKey('KeyJ', true, { t: 0 });
  for (let i = 1; i <= 10; i++) kb.handleKey('KeyJ', true, { t: i * 30, repeat: true });
  kb.handleKey('KeyJ', true, { t: 400 }); // a second keydown without keyup (no repeat flag)
  assert(kb.update(450).events.length === 1);
  kb.handleKey('KeyJ', false, { t: 500 });
  kb.handleKey('KeyJ', true, { t: 600 });
  assert(kb.update(650).events.length === 1, 'release + press again punches again');
});

test('keyboard: hooks, uppercuts and Shift for body shots', () => {
  const kb = new KeyboardInput();
  tap(kb, 'KeyU', 0); tap(kb, 'KeyI', 5); tap(kb, 'KeyN', 10); tap(kb, 'KeyM', 15);
  kb.handleKey('ShiftLeft', true, { t: 20 });
  tap(kb, 'KeyK', 25);
  kb.handleKey('ShiftLeft', false, { t: 30 });
  tap(kb, 'KeyJ', 40);
  const ev = kb.update(50).events.map((e) => `${e.punch.hand}-${e.punch.kind}-${e.punch.target}`);
  assert.deepEqual(ev, ['left-hook-head', 'right-hook-head', 'left-uppercut-head', 'right-uppercut-head', 'right-straight-body', 'left-straight-head']);
});

test('keyboard: Space raises a high guard, B a low guard, punching drops it', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  kb.handleKey('Space', true, { t: 0 });
  let c;
  for (let t = 16; t <= 400; t += 16) c = kb.update(t).control;
  assert(c.guard === 'high' && c.guardAmount > 0.95, `${c.guard} ${c.guardAmount}`);
  approx(c.hands.left.y, HAND_POSES.high.left.y, 0.03, 'left glove at the face');
  assert(c.hands.left.y > HAND_POSES.idle.left.y + 0.2, 'gloves rose');
  tap(kb, 'KeyJ', 410);
  for (let t = 416; t <= 520; t += 16) c = kb.update(t).control;
  assert(c.guard === 'none', 'guard drops while a punch is out');
  for (let t = 536; t <= 1100; t += 16) c = kb.update(t).control;
  assert(c.guard === 'high', 'guard comes back after the punch');
  kb.handleKey('Space', false, { t: 1100 });
  kb.handleKey('KeyB', true, { t: 1100 });
  for (let t = 1116; t <= 1500; t += 16) c = kb.update(t).control;
  assert(c.guard === 'low' && c.hands.right.y < -0.4, `${c.guard} ${c.hands.right.y}`);
});

test('keyboard: A/D lean ease in and out, S ducks, W leans in', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  kb.handleKey('KeyA', true, { t: 0 });
  let c = kb.update(30).control;
  assert(c.lean.x < -0.1 && c.lean.x > -0.9, `eases in, got ${c.lean.x}`);
  for (let t = 46; t <= 500; t += 16) c = kb.update(t).control;
  assert(c.lean.x < -0.98 && c.head.x < -0.45, 'full left lean (player perspective: left = negative)');
  kb.handleKey('KeyA', false, { t: 500 });
  c = kb.update(530).control;
  assert(c.lean.x < -0.3, 'eases out, not instantly');
  for (let t = 546; t <= 1200; t += 16) c = kb.update(t).control;
  assert(Math.abs(c.lean.x) < 0.01, `back to centre, got ${c.lean.x}`);
  kb.handleKey('KeyD', true, { t: 1200 }); kb.handleKey('KeyS', true, { t: 1200 }); kb.handleKey('KeyW', true, { t: 1200 });
  for (let t = 1216; t <= 1700; t += 16) c = kb.update(t).control;
  assert(c.lean.x > 0.98 && c.lean.y < -0.98 && c.lean.z > 0.98 && c.head.y < -0.4);
});

test('keyboard: glove timing follows the game per kind; a plain number applies to every kind', () => {
  const kb = new KeyboardInput({ tuning: { extendMs: 100, retractMs: 100 } });
  kb.update(0);
  tap(kb, 'KeyN', 0);
  const peak = kb.update(100 + 20).control.hands.left;
  assert(peak.punching && peak.reach > 0.6, `uppercut at peak with a numeric extendMs, reach ${peak.reach}`);
  assert(!kb.update(100 + KEYBOARD_TUNING.holdMs + 100 + 5).control.hands.left.punching);
  assert(KEYBOARD_TUNING.extendMs.straight < KEYBOARD_TUNING.extendMs.hook && KEYBOARD_TUNING.extendMs.hook < KEYBOARD_TUNING.extendMs.uppercut);
});

test('keyboard: punch animates the glove out and back with punching flag during flight', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  tap(kb, 'KeyK', 100);
  const T = KEYBOARD_TUNING;
  const out = T.extendMs.straight, ret = T.retractMs.straight;
  const at = (t) => kb.update(t).control.hands.right;
  const early = at(100 + out * 0.5);
  const peak = at(100 + out + T.holdMs * 0.5);
  const back = at(100 + out + T.holdMs + ret + 20);
  assert(early.reach > 0.4 && early.reach < peak.reach && early.punching, `early ${early.reach}`);
  approx(peak.reach, 1, 1e-6, 'full extension');
  assert(peak.punching && Math.abs(peak.x) < 0.2, 'straights drive to the centre line');
  assert(!back.punching && back.reach < 0.2, 'retracted');
  // the other glove did not move
  approx(kb.update(1000).control.hands.left.reach, HAND_POSES.idle.left.reach, 1e-6);
});

test('keyboard: hooks swing wide, uppercuts rise from below', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  tap(kb, 'KeyI', 0); // right hook
  const mid = kb.update(KEYBOARD_TUNING.extendMs.hook * 0.5).control.hands.right;
  assert(mid.x > 0.45, `hook arcs out to the right first, x=${mid.x}`);
  const kb2 = new KeyboardInput();
  kb2.update(0);
  tap(kb2, 'KeyN', 0); // left uppercut
  const early = kb2.update(KEYBOARD_TUNING.extendMs.uppercut * 0.12).control.hands.left;
  const top = kb2.update(KEYBOARD_TUNING.extendMs.uppercut + 10).control.hands.left;
  assert(early.y < HAND_POSES.idle.left.y, 'uppercut dips first');
  assert(top.y > 0.4, 'and finishes high');
});

test('keyboard: activity rises when mashing punches and decays', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  for (let i = 0; i < 6; i++) tap(kb, i % 2 ? 'KeyK' : 'KeyJ', i * 100, 40);
  const hi = kb.update(600).control.activity;
  assert(hi > 0.6, `activity ${hi}`);
  const lo = kb.update(4000).control.activity;
  assert(lo < 0.05, `decays, got ${lo}`);
});

test('keyboard: Esc and P pause', () => {
  const kb = new KeyboardInput();
  tap(kb, 'Escape', 0); tap(kb, 'KeyP', 100);
  const ev = kb.update(200).events;
  assert(ev.length === 2 && ev.every((e) => e.type === 'pause'));
});

test('keyboard: versus — P2 keys drive P2 only; in single player they drive P1', () => {
  const kb = new KeyboardInput({ players: 2 });
  tap(kb, 'Digit1', 0); tap(kb, 'Numpad2', 10);
  kb.handleKey('ArrowLeft', true, { t: 0 });
  kb.handleKey('Digit0', true, { t: 0 });
  const [p1, p2] = kb.updateAll(400);
  assert(p1.events.length === 0 && p2.events.length === 2);
  assert(p2.events[0].punch.hand === 'left' && p2.events[1].punch.hand === 'right');
  assert(p2.control.lean.x < -0.9 && p2.control.guard === 'high' && p1.control.lean.x === 0 && p1.control.guard === 'none');
  const single = new KeyboardInput({ players: 1 });
  tap(single, 'Digit2', 0);
  single.handleKey('ArrowRight', true, { t: 0 });
  const o = single.update(400);
  assert(o.events.length === 1 && o.events[0].punch.hand === 'right' && o.control.lean.x > 0.9);
  assert(single.updateAll(500).length === 1);
});

test('keyboard: custom keymap replaces bindings; unknown keys are ignored', () => {
  const kb = new KeyboardInput({ keymap: { p1: { punchLeft: ['KeyF'] } } });
  assert(kb.handleKey('KeyF', true, { t: 0 }) === true);
  assert(kb.handleKey('KeyJ', true, { t: 0 }) === false, 'J no longer bound');
  assert(kb.handleKey('KeyQ', true, { t: 0 }) === false);
  const ev = kb.update(10).events;
  assert(ev.length === 1 && ev[0].punch.hand === 'left');
  assert(DEFAULT_KEYMAP.p1.punchLeft[0] === 'KeyJ', 'defaults untouched');
});

test('keyboard: releaseAll (window blur) un-sticks held guard/lean', () => {
  const kb = new KeyboardInput();
  kb.handleKey('Space', true, { t: 0 });
  kb.handleKey('KeyD', true, { t: 0 });
  kb.update(300);
  kb.releaseAll();
  let c;
  for (let t = 316; t <= 1000; t += 16) c = kb.update(t).control;
  assert(c.guard === 'none' && Math.abs(c.lean.x) < 0.01, `${c.guard} ${c.lean.x}`);
});

test('keyboard: DOM wiring ignores text fields and modifier shortcuts, prevents page scroll', () => {
  const listeners = {};
  const target = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: (n) => { delete listeners[n]; } };
  const kb = new KeyboardInput({ target });
  let prevented = 0;
  const ev = (code, extra = {}) => ({ code, repeat: false, target: { tagName: 'DIV' }, preventDefault: () => { prevented++; }, ...extra });
  listeners.keydown(ev('KeyJ', { target: { tagName: 'INPUT' } }));
  listeners.keydown(ev('KeyK', { metaKey: true }));
  assert(kb.update(10).events.length === 0, 'typing / shortcuts must not punch');
  listeners.keydown(ev('Space'));
  assert(prevented === 1, 'Space should not scroll the page');
  listeners.keydown(ev('KeyJ'));
  assert(kb.update(20).events.length === 1);
  kb.detach();
  assert(!listeners.keydown && !kb.attached);
});

test('keyboard: describe() and keyLabel for help screens', () => {
  assert(keyLabel('KeyJ') === 'J' && keyLabel('Digit1') === '1' && keyLabel('ArrowLeft') === '←' && keyLabel('Space') === 'Space');
  const rows = new KeyboardInput({ players: 2 }).describe();
  const pl = rows.find((r) => r.player === 1 && r.action === 'punchLeft');
  assert(pl && pl.keys[0] === 'J');
  const body = rows.find((r) => r.player === 1 && r.action === 'body');
  assert(body.keys.length === 1 && body.keys[0] === 'Shift', 'ShiftLeft/Right collapse to one label');
  assert(rows.some((r) => r.player === 2 && r.action === 'leanLeft' && r.keys[0] === '←'));
});
