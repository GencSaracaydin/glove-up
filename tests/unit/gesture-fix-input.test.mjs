// Regression tests of the gesture fix pass for punch recognition: counters thrown while the head moves
// (INPUT-04), the real-noise regime (INPUT-05), the camera frame rate (INPUT-07) and the at-extension flag
// (D5). Realistic tracker noise (noise 1 = the measured MediaPipe depth jitter of ≈ 2 cm per frame).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

function punchesIn(o, steps, tuning) {
  const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return { ev, truth, rec };
}
const hits = (ev, p) => ev.some((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);

test('fix INPUT-04: a jab thrown while coming back upright from a lean or duck (the counter) is recognised', () => {
  const G = { action: 'guard-high', ms: 1500 };
  const rows = [];
  for (const lean of ['lean-left', 'lean-right', 'duck']) {
    for (const after of [1, 100]) {
      let hit = 0, n = 0;
      for (let i = 0; i < 20; i++) {
        const o = randomPlayerOptions(7100 + i, {});
        const h = i % 2 ? 'left' : 'right';
        const { ev, truth } = punchesIn(o, [G, { action: lean, ms: 450 }, { action: 'guard-high', ms: after }, { action: `jab-${h}`, ms: 900 }, { action: 'guard-high', ms: 600 }]);
        n++; if (hits(ev, truth.punches[truth.punches.length - 1])) hit++;
      }
      rows.push(`${lean}+${after}ms ${hit}/${n}`);
      assert(hit >= 14, `${lean}, jab ${after} ms into the return: ${hit}/${n} (before the fix ≈ 0–5/20)`);
    }
  }
  // …and slipping while punching
  for (const lean of ['lean-left', 'duck']) {
    let hit = 0;
    for (let i = 0; i < 20; i++) {
      const o = randomPlayerOptions(3300 + i, {});
      const h = i % 2 ? 'left' : 'right';
      const { ev, truth } = punchesIn(o, [G, { action: lean, ms: 1 }, { action: `jab-${h}`, ms: 900 }, { action: 'guard-high', ms: 600 }]);
      if (hits(ev, truth.punches[truth.punches.length - 1])) hit++;
    }
    rows.push(`slip ${lean} ${hit}/20`);
    assert(hit >= 14, `jab thrown as the ${lean} starts: ${hit}/20`);
  }
  console.log(`      counters: ${rows.join(' · ')}`);
});

test('fix INPUT-04: the hands riding along with leans, ducks and fast slips still never fire', () => {
  const rows = {
    'lean/duck/back/fwd': [{ action: 'guard-high', ms: 1500 }, { action: 'lean-left', ms: 900 }, { action: 'lean-right', ms: 900 }, { action: 'duck', ms: 900 }, { action: 'lean-forward', ms: 900 }, { action: 'lean-back', ms: 900 }, { action: 'guard-high', ms: 900 }],
    'fast slips': [{ action: 'guard-high', ms: 1500 }, ...['lean-left', 'lean-right', 'duck', 'lean-left', 'duck', 'lean-right'].flatMap((a) => [{ action: a, amount: 1.4, ms: 450 }, { action: 'guard-high', ms: 450 }])],
    'low-guard leans': [{ action: 'guard-low', ms: 1500 }, { action: 'lean-left', ms: 900 }, { action: 'guard-low', ms: 500 }, { action: 'duck', ms: 900 }, { action: 'guard-low', ms: 500 }, { action: 'lean-right', ms: 900 }, { action: 'guard-low', ms: 600 }],
  };
  for (const [name, steps] of Object.entries(rows)) {
    let fired = 0;
    for (let i = 0; i < 24; i++) if (punchesIn(randomPlayerOptions(4400 + i, {}), steps).ev.length) fired++;
    assert(fired === 0, `${name}: ${fired}/24 trials fired`);
  }
});

test('fix INPUT-05: the default noise is the real regime — depth stays untrusted; pointing and reaching rarely fire there', () => {
  // the generator's default noise jitters world depth like real MediaPipe output (≈ 20 mm per frame)
  const o = randomPlayerOptions(8100, {});
  const { rec } = punchesIn(o, [{ action: 'guard-high', ms: 2500 }]);
  assert(rec.depthTrusted === false && rec.depthNoiseMm > 12, `default noise: depth ${rec.depthNoiseMm} mm, trusted ${rec.depthTrusted}`);
  const rate = (action) => {
    let fired = 0;
    for (let i = 0; i < 30; i++) {
      const { ev } = punchesIn(randomPlayerOptions(4400 + i, {}), [{ action: 'idle', ms: 1500 }, { action, hand: i % 2 ? 'left' : 'right', ms: action === 'point' ? 3000 : 3200 }, { action: 'idle', ms: 800 }]);
      if (ev.length) fired++;
    }
    return fired / 30;
  };
  const point = rate('point'), reach = rate('reach-slow');
  console.log(`      default noise: trials with a false punch — point ${(100 * point).toFixed(0)}% reach ${(100 * reach).toFixed(0)}% (before the fix ≈ 24% / 16% in the bench)`);
  assert(point <= 0.17 && reach <= 0.17, JSON.stringify({ point, reach }));
});

test('fix INPUT-07 / R3: recognition holds up at 15 fps; a 60 fps camera is used and adds no false punches', () => {
  const steps = [{ action: 'guard-high', ms: 1300 }];
  for (const a of ['jab-left', 'cross', 'hook-left', 'hook-right', 'uppercut-right', 'body-left']) steps.push({ action: a, ms: 1100 }, { action: 'guard-high', ms: 500 });
  const detect = (fps) => {
    let n = 0, hit = 0;
    for (let i = 0; i < 16; i++) {
      const { ev, truth } = punchesIn(randomPlayerOptions(7100 + i, { fps }), steps);
      for (const p of truth.punches) { n++; if (hits(ev, p)) hit++; }
    }
    return hit / n;
  };
  const d15 = detect(15), d30 = detect(30);
  console.log(`      detection at 15 fps ${(100 * d15).toFixed(0)}% vs 30 fps ${(100 * d30).toFixed(0)}%`);
  assert(d15 >= 0.72 && d15 >= d30 - 0.15, `15 fps detection ${d15.toFixed(2)} (30 fps ${d30.toFixed(2)})`);
  // 60 fps: twice the frames carry twice the per-second jitter — slow pointing / reaching fired in ≈ 38 % of
  // the trials before INPUT-07 (≈ 20 % at 30 fps). R3: every 60 fps frame is used now (they cut ≈ 7–12 ms of latency);
  // differences, noise estimates and window extremes are taken on a ≤ 42 Hz view (diffBaseMs), so this stays low
  let fired = 0;
  for (let i = 0; i < 30; i++) {
    const action = i % 2 ? 'point' : 'reach-slow';
    if (punchesIn(randomPlayerOptions(4400 + i, { fps: 60 }), [{ action: 'idle', ms: 1500 }, { action, hand: i % 4 < 2 ? 'left' : 'right', ms: 3100 }, { action: 'idle', ms: 800 }]).ev.length) fired++;
  }
  assert(fired <= 6, `pointing / reaching at 60 fps: ${fired}/30 trials fired`);
  // a 60 fps frame (16 ms after the last) is processed; a duplicate 5 ms later is skipped
  const rec = new GestureRecognizer({});
  const sp = makeSyntheticPlayer({ seed: 2 });
  const a = rec.update(sp.pose(1000, 'guard-high'), 1000);
  const b = rec.update(sp.pose(1016, 'guard-high'), 1016);
  const c = rec.update(sp.pose(1021, 'guard-high'), 1021);
  assert(b.control !== a.control, 'a 16 ms (60 fps) frame is processed');
  assert(c.control === b.control && c.events.length === 0, 'a frame 5 ms after the last one is skipped');
  assert(rec.tuning.minFrameIntervalMs <= 12, `minFrameIntervalMs ${rec.tuning.minFrameIntervalMs}`);
});

test('fix D5: every punch the camera recognises says so (atExtension: true)', () => {
  const { ev } = punchesIn({ seed: 1 }, [{ action: 'guard-high', ms: 1500 }, { action: 'jab-left', ms: 1000 }, { action: 'cross', ms: 1000 }, { action: 'hook-left', ms: 1000 }, { action: 'uppercut-right', ms: 1000 }, { action: 'body-left', ms: 1000 }, { action: 'guard-high', ms: 600 }]);
  assert(ev.length >= 4, `punches ${ev.length}`);
  for (const e of ev) assert(e.punch.atExtension === true, JSON.stringify(e.punch));
});
