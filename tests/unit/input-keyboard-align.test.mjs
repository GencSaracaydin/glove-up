// Keyboard alignment pass: every mechanic of research/mechanics.md §2.1 is reachable from the keys —
// dodge left / right / back / duck (and lean in), both guard heights, the get-up pump (punch keys are
// punches), pause, and a power modifier; hold times for the tutorial (guardMs / stanceMs).
import { test, assert } from '../harness.mjs';
import { KeyboardInput, KEYBOARD_TUNING, DEFAULT_KEYMAP, KEY_ACTIONS } from '../../src/input/keyboard.js';
import { dodgeDetected } from '../../src/input/tutorial-detect.js';

function hold(kb, code, from, to, step = 16) {
  kb.handleKey(code, true, { t: from });
  let c = null;
  for (let t = from; t <= to; t += step) c = kb.update(t).control;
  kb.handleKey(code, false, { t: to });
  return c;
}

test('keyboard: every dodge direction crosses the combat thresholds (A/D left/right, S duck, X back, W in)', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  const want = { KeyA: 'left', KeyD: 'right', KeyS: 'duck', KeyX: 'back', KeyW: 'forward' };
  let t = 0;
  for (const [code, dir] of Object.entries(want)) {
    const c = hold(kb, code, t, t + 300);
    assert(dodgeDetected(c) === dir, `${code} → ${dodgeDetected(c)} (${JSON.stringify(c.lean)})`);
    t += 300;
    for (const end = t + 700; t <= end; t += 16) kb.update(t);   // ease back to the centre
    assert(dodgeDetected(kb.update(t).control) === null, `${code} released`);
  }
  // the dodge is reached quickly (lean in τ 70 ms → threshold ≈ 40 ms after the key)
  const kb2 = new KeyboardInput();
  kb2.update(0);
  kb2.handleKey('KeyA', true, { t: 0 });
  let tCross = null;
  for (let tt = 0; tt <= 300; tt += 8) if (tCross === null && dodgeDetected(kb2.update(tt).control) === 'left') tCross = tt;
  assert(tCross !== null && tCross <= 60, `left dodge after ${tCross} ms`);
});

test('keyboard: hold E for a power punch; normal punches carry the normal power', () => {
  const kb = new KeyboardInput();
  kb.handleKey('KeyJ', true, { t: 0 }); kb.handleKey('KeyJ', false, { t: 30 });
  kb.handleKey('KeyE', true, { t: 40 });
  kb.handleKey('KeyK', true, { t: 50 }); kb.handleKey('KeyK', false, { t: 80 });
  kb.handleKey('ShiftLeft', true, { t: 90 });
  kb.handleKey('KeyI', true, { t: 100 }); kb.handleKey('KeyI', false, { t: 130 });
  kb.handleKey('KeyE', false, { t: 140 }); kb.handleKey('ShiftLeft', false, { t: 140 });
  const ev = kb.update(150).events.map((e) => e.punch);
  assert(ev.length === 3, `events ${ev.length}`);
  assert(ev[0].power === KEYBOARD_TUNING.punchPower && ev[1].power === KEYBOARD_TUNING.powerPunchPower, JSON.stringify(ev));
  assert(ev[2].power === KEYBOARD_TUNING.powerPunchPower && ev[2].kind === 'hook' && ev[2].target === 'body', 'power + body + hook combine');
  assert(KEYBOARD_TUNING.powerPunchPower > KEYBOARD_TUNING.punchPower);
});

test('keyboard: get-up pump — mashing punch keys gives one punch event per press and raises activity', () => {
  const kb = new KeyboardInput();
  let n = 0;
  for (let k = 0; k < 16; k++) {
    const code = k % 2 ? 'KeyK' : 'KeyJ';
    kb.handleKey(code, true, { t: k * 90 }); kb.handleKey(code, false, { t: k * 90 + 40 });
    n += kb.update(k * 90 + 45).events.filter((e) => e.type === 'punch').length;
  }
  assert(n === 16, `pump punches ${n}`);
  assert(kb.update(16 * 90).control.activity > 0.8, 'activity high while pumping');
});

test('keyboard: both guard heights and pause stay reachable; guardMs / stanceMs time the holds', () => {
  const kb = new KeyboardInput();
  kb.update(0);
  let c = hold(kb, 'Space', 0, 1200);
  assert(c.guard === 'high' && c.guardMs >= 1000, `high guard ${c.guard} ${c.guardMs}`);
  for (let t = 1200; t <= 1600; t += 16) c = kb.update(t).control;
  assert(c.guard === 'none' && c.guardMs === 0);
  c = hold(kb, 'KeyB', 1600, 2400);
  assert(c.guard === 'low' && c.guardMs >= 600, `low guard ${c.guard} ${c.guardMs}`);
  kb.handleKey('KeyP', true, { t: 2500 });
  assert(kb.update(2510).events.some((e) => e.type === 'pause'), 'P pauses');
  kb.handleKey('KeyP', false, { t: 2520 });
  // stance: settled (no punch, no lean) → stanceMs grows; a punch or a lean resets it
  const kb2 = new KeyboardInput();
  for (let t = 0; t <= 1100; t += 16) c = kb2.update(t).control;
  assert(c.stanceMs >= 1000, `stanceMs ${c.stanceMs}`);
  kb2.handleKey('KeyJ', true, { t: 1110 });
  c = kb2.update(1130).control;
  assert(c.stanceMs === 0, 'a punch breaks the stance');
});

test('keyboard: the new actions are in the map, P2 gets them too, and describe() lists them for help screens', () => {
  for (const a of ['leanBack', 'power']) assert(KEY_ACTIONS.includes(a), a);
  assert.deepEqual(DEFAULT_KEYMAP.p1.leanBack, ['KeyX']);
  assert.deepEqual(DEFAULT_KEYMAP.p1.power, ['KeyE']);
  assert(DEFAULT_KEYMAP.p2.leanBack.length && DEFAULT_KEYMAP.p2.power.length);
  // no key is bound twice within a player
  for (const p of ['p1', 'p2']) {
    const seen = new Map();
    for (const a of KEY_ACTIONS) for (const code of DEFAULT_KEYMAP[p][a]) {
      assert(!seen.has(code), `${p}: ${code} bound to ${seen.get(code)} and ${a}`);
      seen.set(code, a);
    }
  }
  const rows = new KeyboardInput().describe();
  const row = (a) => rows.find((r) => r.player === 1 && r.action === a);
  assert(row('leanBack').keys[0] === 'X' && row('power').keys[0] === 'E' && row('duck').keys[0] === 'S');
  // versus: P2's lean back + power drive P2 only
  const vs = new KeyboardInput({ players: 2 });
  vs.update(0, 1);
  vs.handleKey('Digit6', true, { t: 0 }); vs.handleKey('Digit1', true, { t: 10 });
  assert(vs.update(20, 1).events[0].punch.power === KEYBOARD_TUNING.powerPunchPower);
  let c2 = null;
  vs.handleKey('Slash', true, { t: 30 });
  for (let t = 30; t <= 400; t += 16) c2 = vs.update(t, 1).control;
  assert(c2.lean.z < -0.9 && vs.update(400, 0).control.lean.z === 0, 'P2 leans back, P1 does not');
});
