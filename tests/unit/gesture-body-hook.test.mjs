// Body hooks (a player's report, 2026-11-13: body shots registered less — people hook to the body, nobody throws
// straights there). A hook to the body keeps the elbow LOW, bent and by the side; the head hook's "elbow raised" test
// and its wrist floor rejected every one, and the fist's way back up to the guard then fired as an uppercut to the
// HEAD. gesture.js `bodyHook`: a hook that ends at body height may keep its elbow low (out to its side only). Synthetic
// body hooks ('hook-body-left/right' in synthetic.js) at the default sensitivity, A/B against the switch turned off.
import { test, assert } from '../harness.mjs';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { DEFAULT_SETTINGS } from '../../src/core/storage.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const SENS = DEFAULT_SETTINGS.sensitivity;

/** `action` with '%' → each hand in turn; reps punches per player from `guard`. Tally of kind/target per punch fired. */
function throwMany(action, { guard = 'guard-high', players = 10, reps = 5, tuning = {}, preset = 'real-like', seed0 = 7100 } = {}) {
  const out = { n: 0, fired: 0, kinds: {} };
  for (const hand of ['left', 'right']) for (let i = 0; i < players; i++) {
    const o = randomPlayerOptions(seed0 + i, preset ? { preset } : { noise: 1 });
    const gr = new GestureRecognizer({ tuning: { sensitivity: SENS, ...tuning } });
    const steps = [{ action: guard, ms: 2500 }];
    for (let k = 0; k < reps; k++) {
      steps.push(action.includes('%') ? { action: action.replace('%', hand), ms: 700 } : { action, hand, ms: 1600 }, { action: guard, ms: 900 });
    }
    for (const f of makeSyntheticPlayer(o).frames(sequence(steps))) {
      for (const e of gr.update(f.players[0], f.t).events) {
        if (e.type !== 'punch' || f.t < 2500 || e.punch.hand !== hand) continue;
        out.fired++;
        const key = `${e.punch.kind}/${e.punch.target}`;
        out.kinds[key] = (out.kinds[key] || 0) + 1;
      }
    }
    out.n += reps;
  }
  out.body = Object.entries(out.kinds).filter(([k]) => k.endsWith('/body')).reduce((a, [, v]) => a + v, 0);
  out.text = `${out.fired}/${out.n} fired: ${JSON.stringify(out.kinds)}`;
  return out;
}

test('body hooks from a high guard register as hooks to the body — not as uppercuts to the head (bodyHook)', () => {
  const on = throwMany('hook-body-%');
  const off = throwMany('hook-body-%', { tuning: { bodyHook: false } });
  // (100 punches; when written: on 88 body punches (83 hooks), 4 head uppercuts · off 26 body (no hooks), 20 head uppercuts)
  assert(on.body >= 80, `body punches with bodyHook: ${on.text}`);
  assert((on.kinds['hook/body'] || 0) >= 70, `hooks to the body with bodyHook: ${on.text}`);
  assert((on.kinds['uppercut/head'] || 0) <= 10, `phantom head uppercuts with bodyHook: ${on.text}`);
  assert((off.kinds['hook/body'] || 0) <= 5 && (off.kinds['uppercut/head'] || 0) >= 15, `the old rule (bodyHook off): ${off.text}`);
});

test('body hooks from a low guard register too (bodyHook)', () => {
  const on = throwMany('hook-body-%', { guard: 'guard-low' });
  const off = throwMany('hook-body-%', { guard: 'guard-low', tuning: { bodyHook: false } });
  // (when written: on 72 of 100 body punches (65 hooks) · off 18)
  assert(on.body >= 60, `low-guard body hooks with bodyHook: ${on.text}`);
  assert(on.body >= off.body + 40, `bodyHook adds them: on ${on.text} · off ${off.text}`);
});

test('bodyHook leaves head hooks, jabs and body straights alone', () => {
  for (const action of ['hook-%', 'jab-%', 'body-%']) {
    const on = throwMany(action, { players: 8 });
    const off = throwMany(action, { players: 8, tuning: { bodyHook: false } });
    assert(Math.abs(on.fired - off.fired) <= 2, `${action}: fired on ${on.text} · off ${off.text}`);
    if (action !== 'body-%') assert(on.body <= off.body + 1, `${action}: no head punch turns into a body punch: on ${on.text} · off ${off.text}`);
    else assert(on.body >= off.body - 2, `${action}: body straights stay body punches: on ${on.text} · off ${off.text}`);
  }
});

test('bodyHook fires no more non-punch gestures (reaching, waving, scratching, glasses, pointing, pull-backs)', () => {
  let on = 0, off = 0;
  for (const g of ['reach-slow', 'wave', 'scratch-face', 'adjust-glasses', 'point', 'pull-back']) {
    on += throwMany(g, { guard: 'idle', reps: 3, preset: null, players: 8 }).fired;
    off += throwMany(g, { guard: 'idle', reps: 3, preset: null, players: 8, tuning: { bodyHook: false } }).fired;
  }
  // (when written: 11 with and 11 without, of 288 gestures)
  assert(on <= off, `gesture false fires: bodyHook on ${on} vs off ${off}`);
});
