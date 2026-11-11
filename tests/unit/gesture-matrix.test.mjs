// Broad randomized matrix: many synthetic players (distance 1.2–3 m, camera 0.6–1.9 m high,
// focal 0.62–1.05, body 1.5–1.95 m, arm/shoulder scale, lead hand, stance twist, punch speed
// 120–350 ms, retraction speed, depth compression 0.5–0.7, 25–33 fps, full tracker noise).
// Prints the confusion matrix and per-condition rates; asserts conservative floors so a
// regression fails loudly. See the report in the gesture module notes for the numbers.
import { test, assert } from '../harness.mjs';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions, mulberry32 } from '../../src/input/synthetic.js';

const N_PLAYERS = 36;
const KINDS = ['straight', 'hook', 'uppercut'];
const L = ['jab-left', 'hook-left', 'uppercut-left', 'body-left'];
const R = ['jab-right', 'hook-right', 'uppercut-right', 'body-right'];

function runPlayer(i) {
  const o = randomPlayerOptions(9000 + i);
  const r = mulberry32(31 + i);
  const steps = [{ action: 'idle', ms: 1200 }];
  const posture = [];
  for (let g = 0; g < 4; g++) {
    const post = ['guard-high', 'idle', 'guard-low'][Math.floor(r() * 3)];
    steps.push({ action: post, ms: 1200 });
    for (let k = 0; k < 4; k++) { steps.push({ action: (k % 2 ? R : L)[Math.floor(r() * 4)], ms: 950 + r() * 200 }); posture.push(post); }
  }
  steps.push({ action: 'idle', ms: 1000 });
  const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
  const rec = new GestureRecognizer();
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return { o, truth, ev, posture };
}

const results = Array.from({ length: N_PLAYERS }, (_, i) => runPlayer(i));

function tally() {
  const conf = {};
  for (const k of KINDS) conf[k] = { straight: 0, hook: 0, uppercut: 0, miss: 0 };
  let multi = 0, extra = 0, tOk = 0, tN = 0;
  const lat = [];
  const byPost = {};
  for (const { truth, ev, posture } of results) {
    const used = new Set();
    truth.punches.forEach((p, j) => {
      const m = ev.filter((e, k) => !used.has(k) && e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
      m.forEach((e) => used.add(ev.indexOf(e)));
      const key = `${p.kind}${p.target === 'body' ? '-body' : ''} from ${posture[j]}`;
      byPost[key] = byPost[key] || [0, 0];
      byPost[key][1]++;
      if (!m.length) { conf[p.kind].miss++; return; }
      byPost[key][0]++;
      if (m.length > 1) multi++;
      conf[p.kind][m[0].punch.kind]++;
      if (p.kind !== 'uppercut') { tN++; if (m[0].punch.target === p.target) tOk++; }
      lat.push(m[0].t - p.tPeak);
    });
    extra += ev.length - used.size;
  }
  lat.sort((a, b) => a - b);
  return { conf, multi, extra, target: tOk / tN, lat, byPost };
}

const T = tally();

test('matrix: confusion matrix (rows = performed, columns = recognised)', () => {
  const pad = (s, n) => String(s).padStart(n);
  console.log(`\n      performed \\ recognised   straight     hook  uppercut     miss   (${N_PLAYERS} random players)`);
  for (const k of KINDS) {
    const row = T.conf[k];
    const n = KINDS.reduce((a, c) => a + row[c], 0) + row.miss;
    console.log(`      ${k.padEnd(24)}${pad(row.straight, 9)}${pad(row.hook, 9)}${pad(row.uppercut, 10)}${pad(row.miss, 9)}   n=${n}`);
  }
  const q = (p) => T.lat[Math.floor(p * (T.lat.length - 1))].toFixed(0);
  console.log(`      target accuracy ${(100 * T.target).toFixed(1)}%   duplicates ${T.multi}   extra events ${T.extra}`);
  console.log(`      latency peak→event ms: p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} p95 ${q(0.95)}`);
  console.log('      detection by start posture: ' + Object.entries(T.byPost).sort().map(([k, [a, b]]) => `${k} ${a}/${b}`).join(' | '));
  assert(true);
});

test('matrix: exactly one punch per action, no duplicates, few extras', () => {
  const total = KINDS.reduce((a, k) => a + KINDS.reduce((x, c) => x + T.conf[k][c], 0) + T.conf[k].miss, 0);
  const missed = KINDS.reduce((a, k) => a + T.conf[k].miss, 0);
  assert(T.multi === 0, `${T.multi} duplicated punches`);
  assert((total - missed) / total >= 0.8, `detected ${total - missed}/${total}`);
  assert(T.extra <= total * 0.02, `${T.extra} extra punches for ${total} performed`);
});

test('matrix: kind accuracy (hooks/uppercuts ≥ 85%) and head/body ≥ 95%', () => {
  for (const k of KINDS) {
    const row = T.conf[k];
    const got = KINDS.reduce((a, c) => a + row[c], 0);
    assert(row[k] / got >= (k === 'straight' ? 0.93 : 0.86), `${k} kind accuracy ${row[k]}/${got}`);
  }
  assert(T.target >= 0.95, `target accuracy ${T.target}`);
});

test('matrix: latency (broad conditions incl. 25 fps and frame drops)', () => {
  const q = (p) => T.lat[Math.floor(p * (T.lat.length - 1))];
  assert(q(0.5) <= 35, `median ${q(0.5)}`);
  assert(q(0.9) <= 90, `p90 ${q(0.9)}`);
});

test('matrix: distractors across random players (ERR03)', () => {
  const D = {
    'hold idle': [{ action: 'idle', ms: 5000 }],
    'hold guard-high': [{ action: 'guard-high', ms: 5000 }],
    'hold guard-low': [{ action: 'guard-low', ms: 5000 }],
    'guard changes': [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'guard-low', ms: 1500 }, { action: 'idle', ms: 1500 }],
    'lean/duck': [{ action: 'guard-high', ms: 1500 }, { action: 'lean-left', ms: 900 }, { action: 'lean-right', ms: 900 }, { action: 'duck', ms: 900 }, { action: 'lean-forward', ms: 900 }, { action: 'lean-back', ms: 900 }],
    wave: [{ action: 'idle', ms: 1500 }, { action: 'wave', hand: 'right', ms: 3000 }, { action: 'idle', ms: 800 }],
    scratch: [{ action: 'idle', ms: 1500 }, { action: 'scratch-face', hand: 'left', ms: 2400 }, { action: 'idle', ms: 800 }],
    glasses: [{ action: 'idle', ms: 1500 }, { action: 'adjust-glasses', hand: 'right', ms: 1500 }, { action: 'idle', ms: 800 }],
    'walk-away': [{ action: 'idle', ms: 1500 }, { action: 'walk-away', ms: 3000 }],
    'reach-slow': [{ action: 'idle', ms: 1500 }, { action: 'reach-slow', hand: 'right', ms: 3200 }, { action: 'idle', ms: 800 }],
    'pull-back (return phase)': [{ action: 'guard-high', ms: 1500 }, { action: 'pull-back', hand: 'left', ms: 2600 }, { action: 'guard-high', ms: 1200 }],
  };
  const rates = {};
  for (const [name, steps] of Object.entries(D)) {
    let trials = 0, fired = 0;
    for (let i = 0; i < 24; i++) {
      const o = randomPlayerOptions(4000 + i);
      const { frames } = makeSyntheticPlayer(o).run(sequence(steps));
      const rec = new GestureRecognizer();
      let n = 0;
      for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) {
        if (e.type !== 'punch') continue;
        if (name.startsWith('pull-back') && e.t < 1500 + 1450) continue;   // only the yank counts here
        n++;
      }
      trials++;
      if (n) fired++;
    }
    rates[name] = fired / trials;
  }
  console.log('      distractor trials with ≥1 punch: ' + Object.entries(rates).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(' | '));
  for (const [k, v] of Object.entries(rates)) {
    if (k === 'reach-slow') assert(v <= 0.35, `${k} ${v}`);
    else if (k.startsWith('pull-back')) assert(v === 0, `${k} ${v}`);
    else assert(v <= 0.05, `${k} ${v}`);
  }
});
