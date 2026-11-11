// Robustness fixes of the alignment pass (input owner): COM07 slow pointing / reaching must not
// attack, body straights from a low guard, uppercuts without a scoop, punch power spread, the
// sensitivity knob and the depth-trust estimate. Two noise models: the generator's default (world
// depth jittering ≈ 2 cm per frame — what real MediaPipe output does: ≈ 20 mm (full model) / ≈ 23 mm
// (lite) median per-frame |Δz| of still joints on dev/clips/facecam-boxing.mp4, so this is the real
// regime) and "clean depth" (≈ 3–4 mm per frame — a what-if for a much cleaner tracker, the only case in
// which the depth-led paths, low-guard body pushes and dip-less uppercuts, switch on).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING, effectiveTuning, sensitivityScale } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const CLEAN = { zNoise: 0.006, worldNoise: 0.003, zBias: 0.008 };

function punchesIn(o, steps, tuning) {
  const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return { ev, truth, rec };
}

test('robust: slow pointing / slow reaching at the screen rarely fire (COM07)', () => {
  const rate = (syn, action) => {
    let fired = 0, n = 0;
    for (let i = 0; i < 20; i++) {
      const o = randomPlayerOptions(4400 + i, syn);
      const { ev } = punchesIn(o, [{ action: 'idle', ms: 1500 }, { action, hand: i % 2 ? 'left' : 'right', ms: 3000 }, { action: 'idle', ms: 800 }]);
      n++; if (ev.length) fired++;
    }
    return fired / n;
  };
  const r = { pointNoisy: rate({}, 'point'), reachNoisy: rate({}, 'reach-slow'), pointClean: rate(CLEAN, 'point'), reachClean: rate(CLEAN, 'reach-slow') };
  console.log(`      trials with a false punch — noisy depth: point ${(100 * r.pointNoisy).toFixed(0)}% reach ${(100 * r.reachNoisy).toFixed(0)}% · clean depth: point ${(100 * r.pointClean).toFixed(0)}% reach ${(100 * r.reachClean).toFixed(0)}%   (first build: 62% / 25% noisy)`);
  assert(r.pointNoisy <= 0.25 && r.reachNoisy <= 0.25, JSON.stringify(r));
  assert(r.pointClean <= 0.1 && r.reachClean <= 0.1, JSON.stringify(r));
});

test('robust: weak straights wait for their retraction, normal punches do not', () => {
  // a lazy 380 ms jab still counts (once its retraction shows) …
  let lazy = 0, n = 0, fast = 0, fastLate = 0;
  for (let i = 0; i < 12; i++) {
    const o = randomPlayerOptions(6100 + i, { punchMs: 380 });
    const { ev, truth } = punchesIn(o, [{ action: 'guard-high', ms: 1500 }, { action: 'jab-left', ms: 1300 }, { action: 'guard-high', ms: 500 }, { action: 'cross', ms: 1300 }, { action: 'guard-high', ms: 600 }]);
    for (const p of truth.punches) { n++; if (ev.some((e) => e.punch.hand === p.hand && e.t >= p.tStart && e.t <= p.tPeak + 450)) lazy++; }
    // … and a normal 180 ms punch fires near full extension
    const f = punchesIn(randomPlayerOptions(6200 + i, { punchMs: 180 }), [{ action: 'guard-high', ms: 1500 }, { action: 'jab-left', ms: 1000 }, { action: 'guard-high', ms: 500 }]);
    const p = f.truth.punches[0];
    const e = f.ev.find((x) => x.punch.hand === p.hand);
    if (e) { fast++; if (e.t - p.tPeak > 120) fastLate++; }
  }
  assert(lazy / n >= 0.75, `lazy punches ${lazy}/${n}`);
  assert(fast >= 10 && fastLate <= 2, `normal punches ${fast}/12, late ${fastLate}`);
});

test('robust: body straights from a low guard (clean depth) and dip-less uppercuts (clean depth)', () => {
  let body = 0, nb = 0, up = 0, nu = 0, upAsStraight = 0;
  for (let i = 0; i < 16; i++) {
    const o = randomPlayerOptions(5300 + i, CLEAN);
    const b = punchesIn(o, [{ action: 'guard-low', ms: 1500 }, { action: i % 2 ? 'body-left' : 'body-right', ms: 1200 }, { action: 'guard-low', ms: 600 }, { action: i % 2 ? 'body-right' : 'body-left', ms: 1200 }, { action: 'guard-low', ms: 800 }]);
    for (const p of b.truth.punches) { nb++; if (b.ev.some((e) => e.punch.hand === p.hand && e.punch.target === 'body' && e.t >= p.tStart - 40 && e.t <= p.tPeak + 500)) body++; }
    const u = punchesIn(o, [{ action: 'idle', ms: 1500 }, { action: i % 2 ? 'uppercut-left' : 'uppercut-right', dip: false, ms: 1100 }, { action: 'idle', ms: 600 }, { action: i % 2 ? 'uppercut-right' : 'uppercut-left', dip: false, ms: 1100 }, { action: 'idle', ms: 800 }]);
    for (const p of u.truth.punches) {
      nu++;
      const e = u.ev.find((x) => x.punch.hand === p.hand && x.t >= p.tStart - 40 && x.t <= p.tPeak + 350);
      if (e && e.punch.kind === 'uppercut') up++; else if (e) upAsStraight++;
    }
  }
  console.log(`      clean depth: body from a low guard ${body}/${nb} (first build ≈ 30 %), dip-less uppercuts ${up}/${nu} as uppercuts, ${upAsStraight} as other kinds`);
  assert(body / nb >= 0.45, `low-guard body punches ${body}/${nb}`);
  assert(up / nu >= 0.45, `dip-less uppercuts ${up}/${nu}`);
});

test('robust: hands going to the face (glasses, scratching) or raising the guard are not uppercuts (clean depth)', () => {
  let fired = 0;
  const report = [];
  for (let i = 0; i < 16; i++) {
    const o = randomPlayerOptions(4000 + i, CLEAN);
    for (const steps of [
      [{ action: 'idle', ms: 1500 }, { action: 'adjust-glasses', hand: 'right', ms: 1500 }, { action: 'idle', ms: 800 }],
      [{ action: 'idle', ms: 1500 }, { action: 'scratch-face', hand: 'left', ms: 2400 }, { action: 'idle', ms: 800 }],
      [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1200 }],
    ]) {
      const { ev } = punchesIn(o, steps);
      if (ev.length) { fired++; report.push(`${steps[1].action} p${i}: ${ev.map((e) => e.punch.kind).join(',')}`); }
    }
  }
  assert(fired <= 2, report.join('; '));
});

test('robust: punch power spreads with speed (sensitivity-independent); fast punches rarely saturate', () => {
  const byMs = {};
  for (const pm of [110, 200, 360]) {
    byMs[pm] = [];
    for (let i = 0; i < 10; i++) {
      for (const sens of [0.5, 0.9]) {
        const o = randomPlayerOptions(7300 + i, { punchMs: pm });
        const { ev } = punchesIn(o, [{ action: 'guard-high', ms: 1300 }, { action: 'jab-left', ms: 1000 }, { action: 'cross', ms: 1000 }, { action: 'hook-right', ms: 1000 }, { action: 'guard-high', ms: 500 }], { sensitivity: sens });
        if (sens === 0.5) byMs[pm].push(...ev.map((e) => e.punch.power));
      }
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  const m = Object.fromEntries(Object.entries(byMs).map(([k, v]) => [k, med(v)]));
  const at1 = byMs[200].filter((p) => p >= 0.99).length / byMs[200].length;
  console.log(`      power medians: 110 ms ${m[110]} · 200 ms ${m[200]} · 360 ms ${m[360]}; 200 ms punches at power 1: ${(100 * at1).toFixed(0)}%`);
  assert(m[110] > m[200] && m[200] > m[360], JSON.stringify(m));
  assert(m[110] - m[360] >= 0.25, `spread ${JSON.stringify(m)}`);
  assert(at1 <= 0.2, `saturation ${at1}`);
  for (const v of Object.values(byMs).flat()) assert(v >= 0 && v <= 1);
});

test('robust: sensitivity — 0.5 is exactly the default tuning; bad values fall back to 0.5; scale is monotonic', () => {
  const e = effectiveTuning({ sensitivity: 0.5 });
  for (const k of Object.keys(DEFAULT_TUNING)) assert(JSON.stringify(e[k]) === JSON.stringify(DEFAULT_TUNING[k]), `0.5 changes ${k}`);
  for (const bad of [undefined, null, NaN, 'x', '']) assert(effectiveTuning({ sensitivity: bad }).sensitivity === 0.5, `sensitivity ${bad}`);
  assert(effectiveTuning({ sensitivity: 3 }).sensitivity === 1 && effectiveTuning({ sensitivity: -1 }).sensitivity === 0);
  assert(sensitivityScale(0) > sensitivityScale(0.5) && sensitivityScale(0.5) === 1 && sensitivityScale(1) < 1);
  const strict = effectiveTuning({ sensitivity: 0 }), eager = effectiveTuning({ sensitivity: 1 });
  for (const k of ['xOnsetRate', 'hookOnsetSpeed', 'upOnsetSpeed', 'weakStraightPeak', 'straightMinRise', 'hookMinDisp']) {
    assert(strict[k] > DEFAULT_TUNING[k] && eager[k] < DEFAULT_TUNING[k], k);
  }
  for (const k of ['leanDodgeSW', 'leanZDodgeM', 'guardOn', 'powerSlowSpeed', 'dodgeStrokeMinPeak']) assert(DEFAULT_TUNING[k] !== undefined && strict[k] === DEFAULT_TUNING[k] && eager[k] === DEFAULT_TUNING[k], `${k} must not depend on sensitivity`);
});

test('robust: depth trust follows the measured world-depth jitter', () => {
  const trusted = (syn) => {
    const o = randomPlayerOptions(8100, syn);
    const { rec } = punchesIn(o, [{ action: 'guard-high', ms: 2500 }]);
    return rec.depthTrusted;
  };
  assert(trusted(CLEAN) === true, 'clean depth is trusted');
  assert(trusted({}) === false, 'noisy depth is not trusted');
});
