// RELEASE-08: the README says the P2 keys also work on the number pad. Every P2 top-row key (1-9, 0
// and /) has a number-pad twin bound to the same action (Num 9 = low guard and Num / = lean back
// were missing); Num . and Num − keep working; help screens still name the top-row key first.
import { test, assert } from '../harness.mjs';
import { KeyboardInput, DEFAULT_KEYMAP, KEY_ACTIONS, keyLabel } from '../../src/input/keyboard.js';
import { dodgeDetected } from '../../src/input/tutorial-detect.js';

const TWINS = [...'1234567890'].map((d) => [`Digit${d}`, `Numpad${d}`]).concat([['Slash', 'NumpadDivide']]);
const actionsOf = (kb, code, p) => (kb._byCode.get(code) || []).filter((b) => b.p === p).map((b) => b.action);

test('keyboard (RELEASE-08): every P2 top-row key has a number-pad twin with the same action', () => {
  const kb = new KeyboardInput({ players: 2 });
  for (const [top, pad] of TWINS) {
    const a = actionsOf(kb, top, 1);
    assert(a.length === 1, `${top} is a P2 key`);
    assert.deepEqual(actionsOf(kb, pad, 1), a, `${pad} does what ${top} does`);
  }
  assert.deepEqual(actionsOf(kb, 'NumpadDecimal', 1), ['guardLow'], 'Num . still low guard');
  assert.deepEqual(actionsOf(kb, 'NumpadSubtract', 1), ['leanBack'], 'Num − still lean back');
});

test('keyboard (RELEASE-08): Num 9 raises a low guard and Num / leans back, for P2 in versus and for P1 alone', () => {
  const run = (players, player) => {
    const kb = new KeyboardInput({ players });
    kb.update(0, player);
    assert(kb.handleKey('Numpad9', true, { t: 0 }) === true, 'Numpad9 is bound');
    let c = null;
    for (let t = 16; t <= 400; t += 16) c = kb.update(t, player).control;
    assert.equal(c.guard, 'low', `players=${players}: Num 9 → low guard`);
    kb.handleKey('Numpad9', false, { t: 400 });
    assert(kb.handleKey('NumpadDivide', true, { t: 400 }) === true, 'NumpadDivide is bound');
    for (let t = 416; t <= 800; t += 16) c = kb.update(t, player).control;
    assert.equal(dodgeDetected(c), 'back', `players=${players}: Num / → lean back (${JSON.stringify(c.lean)})`);
    if (players === 2) assert.equal(kb.update(800, 0).control.lean.z, 0, 'P1 untouched in versus');
  };
  run(2, 1);
  run(1, 0);
});

test('keyboard (RELEASE-08): the top-row key stays first (help.js names it); labels for the new keys', () => {
  for (const a of KEY_ACTIONS) {
    const keys = DEFAULT_KEYMAP.p2[a];
    if (keys.length && keys.some((k) => /^Numpad/.test(k))) assert(!/^Numpad/.test(keys[0]), `p2.${a}: ${keys[0]} first`);
  }
  assert.equal(keyLabel('Numpad9'), 'Num 9');
  assert.equal(keyLabel('NumpadDivide'), 'Num /');
  const rows = new KeyboardInput({ players: 2 }).describe();
  const row = (a) => rows.find((r) => r.player === 2 && r.action === a);
  assert.deepEqual(row('guardLow').keys, ['9', 'Num 9', 'Num .']);
  assert.deepEqual(row('leanBack').keys, ['/', 'Num /', 'Num −']);
});
