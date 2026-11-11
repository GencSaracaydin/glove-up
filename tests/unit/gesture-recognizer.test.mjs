// GestureRecognizer behaviour on representative synthetic players (realistic tracker noise).
// The broad randomized matrix + confusion matrix live in gesture-matrix.test.mjs.
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { GestureRecognizer, DEFAULT_TUNING, effectiveTuning, MP_AXES, sideSignFor } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence } from '../../src/input/synthetic.js';

/** Typical setups: laptop on a desk, TV-top camera, close + low, far + high. */
const PLAYERS = [
  { seed: 1 },
  { seed: 2, distance: 1.4, cameraHeight: 0.75, focal: 0.75 },
  { seed: 3, distance: 2.8, cameraHeight: 1.8, focal: 0.9 },
  { seed: 4, distance: 2.0, cameraHeight: 1.2, bodyHeight: 1.6, lead: 'right', punchMs: 150 },
  { seed: 5, distance: 2.3, cameraHeight: 0.9, bodyHeight: 1.9, punchMs: 280 },
];

function run(opts, steps, recOpts = {}) {
  const sp = makeSyntheticPlayer(opts);
  const { frames, truth } = sp.run(sequence(steps));
  const rec = new GestureRecognizer({ ...recOpts });
  const events = [], controls = [];
  for (const fr of frames) {
    const out = rec.update(fr.players[0], fr.t);
    for (const e of out.events) events.push(e);
    controls.push({ t: fr.t, c: out.control });
  }
  return { events, controls, truth, rec, frames };
}
const punches = (evs) => evs.filter((e) => e.type === 'punch');
/** Match truth punches to events (same hand, near the peak). */
function score(truth, events) {
  const ev = punches(events);
  const used = new Set();
  const out = [];
  for (const p of truth.punches) {
    const m = ev.filter((e, i) => !used.has(i) && e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
    m.forEach((e) => used.add(ev.indexOf(e)));
    out.push({ p, m });
  }
  return { out, extra: ev.filter((_, i) => !used.has(i)) };
}

test('gesture: MediaPipe axis conventions are encoded once and consistently', () => {
  assert(MP_AXES.imageUp === -1 && MP_AXES.worldUp === -1 && MP_AXES.worldForward === -1);
  assert(sideSignFor(false) === -1 && sideSignFor(true) === 1);
  const t = effectiveTuning({ sensitivity: 1 }), s = effectiveTuning({ sensitivity: 0 });
  assert(t.xOnsetRate < DEFAULT_TUNING.xOnsetRate && s.xOnsetRate > DEFAULT_TUNING.xOnsetRate, 'sensitivity scales thresholds');
});

test('gesture: one punch per punch action, right hand, kind and target (5 setups)', () => {
  let n = 0, ok = 0, kindOk = 0, targetOk = 0, targetN = 0, multi = 0, extra = 0;
  for (const o of PLAYERS) {
    const steps = [{ action: 'idle', ms: 1500 }];
    for (const a of ['jab-left', 'cross', 'hook-left', 'hook-right', 'uppercut-left', 'uppercut-right', 'body-left', 'body-right', 'jab-right', 'jab']) {
      steps.push({ action: 'guard-high', ms: 900 }, { action: a, ms: 1100 });
    }
    const { events, truth } = run(o, steps);
    const s = score(truth, events);
    extra += s.extra.length;
    for (const { p, m } of s.out) {
      n++;
      if (m.length) ok++;
      if (m.length > 1) multi++;
      if (m.length && m[0].punch.kind === p.kind) kindOk++;
      if (m.length && p.kind !== 'uppercut') { targetN++; if (m[0].punch.target === p.target) targetOk++; }
    }
  }
  assert(multi === 0, `${multi} punches fired twice`);
  assert(ok / n >= 0.9, `detected ${ok}/${n}`);
  assert(kindOk / ok >= 0.9, `kind ${kindOk}/${ok}`);
  assert(targetOk / targetN >= 0.95, `target ${targetOk}/${targetN}`);
  assert(extra <= 2, `${extra} extra punches`);
});

test('gesture: peak→event latency ≤ 70 ms (p90) and ~20 ms typical', () => {
  const lat = [];
  for (const o of PLAYERS) {
    const steps = [{ action: 'idle', ms: 1500 }];
    for (let i = 0; i < 8; i++) steps.push({ action: ['jab-left', 'cross', 'hook-right', 'uppercut-left'][i % 4], ms: 1000 });
    const { events, truth } = run(o, steps);
    for (const { p, m } of score(truth, events).out) if (m.length) lat.push(m[0].t - p.tPeak);
  }
  lat.sort((a, b) => a - b);
  const q = (x) => lat[Math.floor(x * (lat.length - 1))];
  assert(q(0.9) <= 70, `p90 latency ${q(0.9)} ms (${lat.map((v) => v.toFixed(0)).join(' ')})`);
  assert(q(0.5) <= 40, `median latency ${q(0.5)} ms`);
});

test('gesture: fast alternating combo — 4 punches in 1.2 s all recognised', () => {
  const combo = (posture) => {
    let n = 0, ok = 0;
    for (const o of [{ seed: 11, punchMs: 130, retractFactor: 1.2 }, { seed: 12, punchMs: 140, retractFactor: 1.3, distance: 2.4 }, { seed: 13, punchMs: 125, retractFactor: 1.2, cameraHeight: 1.5 }]) {
      const steps = [{ action: posture, ms: 1500 }];
      for (let r = 0; r < 3; r++) {
        steps.push({ action: 'jab-left', ms: 300 }, { action: 'cross', ms: 300 }, { action: 'jab-left', ms: 300 }, { action: 'cross', ms: 300 }, { action: posture, ms: 1200 });
      }
      const { events, truth } = run(o, steps);
      const s = score(truth, events);
      for (const { m } of s.out) { n++; if (m.length === 1) ok++; }
      assert(s.extra.length === 0, `extra punches in combo: ${s.extra.length}`);
    }
    return ok / n;
  };
  // (a simulated tracker glitch landing mid-punch drops that punch on purpose — corrupted
  // data must not fire — so allow one such loss in 36)
  const fromStance = combo('idle');
  assert(fromStance >= 0.95, `combo from the stance: ${fromStance}`);
  // straight down the lens from a high guard the image barely moves (documented limitation)
  const fromGuard = combo('guard-high');
  assert(fromGuard >= 0.8, `combo from a high guard: ${fromGuard}`);
});

test('gesture: flurries — jab–cross every 250 ms (4/s) nearly all recognised, 5/s mostly', () => {
  const rate = (stepMs) => {
    let n = 0, ok = 0;
    for (const base of PLAYERS) {
      const steps = [{ action: 'guard-high', ms: 1500 }];
      for (let k = 0; k < 8; k++) steps.push({ action: k % 2 ? 'cross' : 'jab', ms: stepMs });
      steps.push({ action: 'guard-high', ms: 800 });
      const { events, truth } = run({ ...base, punchMs: 130, retractFactor: 1.2 }, steps);
      const s = score(truth, events);
      for (const { m } of s.out) { n++; if (m.length === 1) ok++; }
      assert(s.extra.length === 0, `extra punches in a flurry (seed ${base.seed})`);
    }
    return ok / n;
  };
  const four = rate(250), five = rate(200);
  console.log(`      flurry detection: 4/s ${(100 * four).toFixed(0)}%  5/s ${(100 * five).toFixed(0)}%`);
  assert(four >= 0.9, `4 punches/s: ${four}`);
  assert(five >= 0.7, `5 punches/s: ${five}`);
});

test('gesture: pull-backs never fire (COM07/A05)', () => {
  for (const o of PLAYERS) {
    // a punch followed by its own retraction (slow and fast retracting players): exactly one event
    for (const rf of [1.1, 2.2]) {
      const { events, truth } = run({ ...o, retractFactor: rf }, [{ action: 'guard-high', ms: 1500 }, { action: 'cross', ms: 1600 }, { action: 'guard-high', ms: 800 }]);
      const s = score(truth, events);
      assert(s.out[0].m.length <= 1 && s.extra.length === 0, `retraction fired (retractFactor ${rf}, seed ${o.seed})`);
    }
    // arm eased out, held, yanked back fast: the yank must not fire
    const hand = o.seed % 2 ? 'left' : 'right';
    const { events } = run(o, [{ action: 'guard-high', ms: 1500 }, { action: 'pull-back', hand, ms: 2600 }, { action: 'guard-high', ms: 1200 }]);
    const yank = punches(events).filter((e) => e.t > 1500 + 1450);
    assert(yank.length === 0, `pull-back yank fired (seed ${o.seed})`);
  }
});

test('gesture: no punches while holding still, changing guard, leaning, ducking (ERR03)', () => {
  let fired = 0;
  const report = [];
  for (const o of PLAYERS) {
    for (const steps of [
      [{ action: 'idle', ms: 5000 }],
      [{ action: 'guard-high', ms: 5000 }],
      [{ action: 'guard-low', ms: 5000 }],
      [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'guard-low', ms: 1500 }, { action: 'idle', ms: 1500 }],
      [{ action: 'guard-high', ms: 1500 }, { action: 'lean-left', ms: 900 }, { action: 'lean-right', ms: 900 }, { action: 'duck', ms: 900 }, { action: 'lean-forward', ms: 900 }, { action: 'lean-back', ms: 900 }, { action: 'guard-high', ms: 900 }],
    ]) {
      const p = punches(run(o, steps).events);
      fired += p.length;
      if (p.length) report.push(`${steps.map((s) => s.action).join('>')} seed ${o.seed}`);
    }
  }
  assert(fired === 0, `punches fired: ${report.join('; ')}`);
});

test('gesture: no punches for waving, scratching, glasses, walking away, pause gesture (ERR03)', () => {
  const report = [];
  for (const o of PLAYERS) {
    const hand = o.seed % 2 ? 'left' : 'right';
    for (const steps of [
      [{ action: 'idle', ms: 1500 }, { action: 'wave', hand, ms: 3000 }, { action: 'idle', ms: 1000 }],
      [{ action: 'idle', ms: 1500 }, { action: 'scratch-face', hand, ms: 2400 }, { action: 'idle', ms: 1000 }],
      [{ action: 'idle', ms: 1500 }, { action: 'adjust-glasses', hand, ms: 1500 }, { action: 'idle', ms: 1000 }],
      [{ action: 'idle', ms: 1500 }, { action: 'walk-away', ms: 3000 }],
      [{ action: 'idle', ms: 1500 }, { action: 'pause', ms: 2000 }, { action: 'idle', ms: 1200 }],
    ]) {
      const p = punches(run(o, steps).events);
      if (p.length) report.push(`${steps[1].action} seed ${o.seed}: ${p.map((e) => e.punch.kind).join(',')}`);
    }
  }
  assert(report.length === 0, report.join('; '));
});

test('gesture: slow reaches rarely fire (reported rate)', () => {
  let fired = 0, n = 0;
  for (const o of PLAYERS) for (const hand of ['left', 'right']) {
    n++;
    if (punches(run(o, [{ action: 'idle', ms: 1500 }, { action: 'reach-slow', hand, ms: 3200 }, { action: 'idle', ms: 1000 }]).events).length) fired++;
  }
  assert(fired <= 2, `slow reach fired ${fired}/${n}`);
});

test('gesture: guard high / low / none (COM03)', () => {
  for (const o of PLAYERS) {
    const { controls, truth } = run(o, [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'guard-low', ms: 1500 }, { action: 'idle', ms: 1500 }]);
    const during = (i) => controls.filter((x) => x.t > truth.steps[i].t0 + 500 && x.t < truth.steps[i].t1 - 50).map((x) => x.c);
    const frac = (arr, g) => arr.filter((c) => c.guard === g).length / arr.length;
    assert(frac(during(1), 'high') > 0.9, `high guard seed ${o.seed}`);
    const amt = during(1).map((c) => c.guardAmount);
    assert(amt.reduce((a, b) => a + b, 0) / amt.length > 0.75 && Math.min(...amt) > 0.3, `guardAmount while guarding high (seed ${o.seed})`);
    assert(frac(during(2), 'low') > 0.9, `low guard seed ${o.seed}`);
    assert(frac(during(0), 'none') > 0.9 && frac(during(3), 'none') > 0.9, `no guard in stance seed ${o.seed}`);
  }
});

test('gesture: lean left/right, duck, forward/back (COM04)', () => {
  const means = { 'lean-left': [], 'lean-right': [], duck: [], 'lean-forward': [], 'lean-back': [], idle: [] };
  for (const o of PLAYERS) {
    const steps = [{ action: 'idle', ms: 1500 }];
    // clear dodges (research/mechanics.md §2.1 needs the nose ≥ 0.35 SW sideways, the shoulders
    // ≥ 12 % narrower / wider): amounts well past those so every setup crosses them
    const amount = { 'lean-left': 1.5, 'lean-right': 1.5, duck: 1.2, 'lean-forward': 2.6, 'lean-back': 3.4 };
    for (const a of ['lean-left', 'lean-right', 'duck', 'lean-forward', 'lean-back']) steps.push({ action: a, amount: amount[a], ms: 1000 }, { action: 'idle', ms: 900 });
    const { controls, truth } = run(o, steps);
    for (const st of truth.steps) {
      const arr = controls.filter((x) => x.t > st.t0 + 450 && x.t < st.t1 - 50).map((x) => x.c.lean);
      const m = { x: arr.reduce((a, l) => a + l.x, 0) / arr.length, y: arr.reduce((a, l) => a + l.y, 0) / arr.length, z: arr.reduce((a, l) => a + l.z, 0) / arr.length };
      means[st.action].push(m);
    }
  }
  for (const m of means['lean-left']) assert(m.x < -0.6, `lean-left x ${m.x}`);
  for (const m of means['lean-right']) assert(m.x > 0.6, `lean-right x ${m.x}`);
  for (const m of means.duck) assert(m.y < -0.42, `duck y ${m.y}`);
  assert(means.duck.reduce((a, m) => a + m.y, 0) / means.duck.length < -0.6, 'duck y on average');
  for (const m of means['lean-forward']) assert(m.z > 0.3, `lean-forward z ${m.z}`);
  for (const m of means['lean-back']) assert(m.z < -0.3, `lean-back z ${m.z}`);
  for (const m of means.idle) assert(Math.abs(m.x) < 0.12 && Math.abs(m.y) < 0.12 && Math.abs(m.z) < 0.2, `idle lean ${JSON.stringify(m)}`);
});

test('gesture: own punches do not read as a back lean (torso twist narrows the shoulders)', () => {
  const report = [];
  for (const o of PLAYERS) {
    const steps = [{ action: 'guard-high', ms: 2000 }];
    for (const a of ['jab-left', 'cross', 'hook-right', 'hook-left', 'uppercut-right', 'uppercut-left', 'body-left', 'body-right']) steps.push({ action: a, ms: 1000 });
    const { controls } = run(o, steps);
    const minZ = Math.min(...controls.filter((x) => x.t > 2000).map((x) => x.c.lean.z));
    if (minZ <= -0.5) report.push(`seed ${o.seed}: ${minZ.toFixed(2)}`);
    // …while a deliberate back lean right after a punch still reads as one
    const back = run(o, [{ action: 'guard-high', ms: 2000 }, { action: 'cross', ms: 900 }, { action: 'lean-back', amount: 3.4, ms: 1200 }]);
    const z = back.controls.filter((x) => x.t > 2900 + 500 && x.t < 4100).map((x) => x.c.lean.z);
    assert(z.reduce((a, b) => a + b, 0) / z.length < -0.3, `lean-back after a cross (seed ${o.seed})`);
  }
  assert(report.length === 0, `lean.z dipped during punches: ${report.join('; ')}`);
});

test('gesture: hands follow the gloves in shoulder widths (player perspective)', () => {
  const { controls, truth } = run({ seed: 1 }, [{ action: 'guard-high', ms: 1500 }, { action: 'cross', ms: 900 }]);
  const guard = controls.filter((x) => x.t > 800 && x.t < 1450).map((x) => x.c.hands);
  for (const h of guard) {
    assert(h.left.x < 0 && h.right.x > 0, 'left glove on the player\'s left');
    assert(h.left.y > 0.2 && h.right.y > 0.2, 'gloves up by the face');
    assert(h.left.reach < 0.35 && h.right.reach < 0.35, 'not extended in guard');
  }
  const peak = truth.punches[0].tPeak;
  const around = controls.filter((x) => x.t >= peak - 60 && x.t <= peak + 160).map((x) => x.c.hands.right);
  const maxReach = Math.max(...around.map((h) => h.reach));
  assert(maxReach > 0.55, `reach at the punch ${maxReach}`);
  assert(around.some((h) => h.punching), 'punching flag while the punch is out');
});

test('gesture: tracking loss after lostAfterMs, brief dropouts tolerated (ERR02)', () => {
  const sp = makeSyntheticPlayer({ seed: 1 });
  const rec = new GestureRecognizer({});
  let t = 0, c;
  for (; t < 1500; t += 33) c = rec.update(sp.pose(t, 'guard-high'), t).control;
  assert(c.tracked && c.confidence > 0.7);
  for (let k = 0; k < 6; k++, t += 33) c = rec.update(null, t).control;      // 200 ms gap
  assert(c.tracked, 'short dropout keeps tracking');
  for (; t < 2700; t += 33) c = rec.update(sp.pose(t, 'guard-high'), t).control;
  for (let k = 0; k < 20; k++, t += 33) c = rec.update(null, t).control;     // 660 ms gap
  assert(!c.tracked, 'long loss reported');
  assert(c.guard === 'none' && c.guardAmount === 0);
  for (const end = t + 1200; t < end; t += 33) c = rec.update(sp.pose(t, 'guard-high'), t).control;
  assert(c.tracked, 'recovers');
  // a missing wrist alone also counts as lost after lostAfterMs
  const rec2 = new GestureRecognizer({});
  let t2 = 0;
  for (; t2 < 1200; t2 += 33) rec2.update(sp.pose(t2, 'idle'), t2);
  for (; t2 < 2000; t2 += 33) {
    const p = sp.pose(t2, 'idle');
    p.image[LM.LEFT_WRIST] = { ...p.image[LM.LEFT_WRIST], visibility: 0.05 };
    c = rec2.update(p, t2).control;
  }
  assert(!c.tracked, 'missing wrist → not tracked');
});

test('gesture: one-frame glitches and visibility drops never fire', () => {
  const sp = makeSyntheticPlayer({ seed: 21, noise: 0.5 });
  const rec = new GestureRecognizer({});
  let fired = 0;
  for (let t = 0; t < 8000; t += 33) {
    const p = sp.pose(t, 'guard-high');
    const k = Math.floor(t / 33);
    if (k % 25 === 0 && t > 1000) {   // wrist teleports for one frame (sometimes onto the other wrist)
      const w = p.image[LM.RIGHT_WRIST];
      p.image[LM.RIGHT_WRIST] = k % 50 === 0 ? { ...p.image[LM.LEFT_WRIST] } : { ...w, x: w.x + 0.12, y: w.y + 0.15 };
      p.world[LM.RIGHT_WRIST] = { ...p.world[LM.RIGHT_WRIST], z: p.world[LM.RIGHT_WRIST].z - 0.25 };
    }
    if (k % 40 === 5 && t > 1000) for (const i of [LM.LEFT_WRIST, LM.LEFT_INDEX]) p.image[i] = { ...p.image[i], visibility: 0.1 };
    fired += punches(rec.update(p, t).events).length;
  }
  assert(fired === 0, `${fired} punches from glitches`);
});

test('gesture: pause gesture fires once per raise (both hands above the head ≥ 1.2 s)', () => {
  const { events } = run({ seed: 1 }, [{ action: 'idle', ms: 1500 }, { action: 'pause', ms: 3000 }, { action: 'idle', ms: 1500 }, { action: 'pause', ms: 2000 }, { action: 'idle', ms: 1000 }]);
  const p = events.filter((e) => e.type === 'pause');
  assert(p.length === 2, `pause events ${p.length}`);
  assert(p[0].t > 1500 + 1200 && p[0].t < 1500 + 2000, `first pause at ${p[0].t}`);
  const short = run({ seed: 1 }, [{ action: 'idle', ms: 1500 }, { action: 'pause', ms: 1000 }, { action: 'idle', ms: 1500 }]).events;
  assert(short.filter((e) => e.type === 'pause').length === 0, 'too short a raise does not pause');
});

test('gesture: activity rises while punching, falls at rest', () => {
  const { controls } = run({ seed: 1 }, [{ action: 'idle', ms: 2500 }, { action: 'jab-left', ms: 400 }, { action: 'cross', ms: 400 }, { action: 'jab-left', ms: 400 }, { action: 'cross', ms: 400 }, { action: 'idle', ms: 2500 }]);
  const at = (t0, t1) => Math.max(...controls.filter((x) => x.t > t0 && x.t < t1).map((x) => x.c.activity));
  assert(at(4000, 4200) > 2 * at(1500, 2400), 'punching raises activity');
  assert(controls[controls.length - 1].c.activity < at(4000, 4200) * 0.6, 'decays at rest');
});

test('gesture: mirrored camera + calibration.swapSides keeps hands right', () => {
  const o = { seed: 31, mirrorCamera: true };
  const steps = [{ action: 'guard-high', ms: 1500 }, { action: 'jab-left', ms: 1000 }, { action: 'cross', ms: 1000 }, { action: 'lean-right', ms: 1000 }];
  const cal = { version: 1, swapSides: true, createdAt: 0 };
  const { events, controls } = run(o, steps, { calibration: cal });
  assert.deepEqual(punches(events).map((e) => e.punch.hand), ['left', 'right']);
  const lean = controls.filter((x) => x.t > 3900).map((x) => x.c.lean.x);
  assert(lean.reduce((a, b) => a + b, 0) / lean.length > 0.5, 'lean right stays right');
  const guard = controls.find((x) => x.t > 1200).c.hands;
  assert(guard.left.x < 0 && guard.right.x > 0, 'left glove on the left');
});

test('gesture: works without world landmarks (degraded, image only) and without hips', () => {
  for (const o of [{ seed: 1 }, { seed: 3, distance: 2.8, cameraHeight: 1.8 }]) {
    const sp = makeSyntheticPlayer(o);
    const seq = sequence([{ action: 'idle', ms: 1500 }, { action: 'cross', ms: 1100 }, { action: 'jab-left', ms: 1100 }, { action: 'hook-right', ms: 1100 }, { action: 'body-right', ms: 1100 }]);
    const rec = new GestureRecognizer({});
    const ev = [];
    for (const fr of sp.frames(seq)) {
      const p = fr.players[0];
      if (p) {
        p.world = p.world.map(() => ({ x: 0, y: 0, z: 0, visibility: 0 }));
        for (const i of [LM.LEFT_HIP, LM.RIGHT_HIP]) p.image[i] = { ...p.image[i], visibility: 0.1 };
      }
      ev.push(...punches(rec.update(p, fr.t).events));
    }
    assert.deepEqual(ev.map((e) => e.punch.hand), ['right', 'left', 'right', 'right'], JSON.stringify(ev.map((e) => e.punch)));
  }
});

test('gesture: sensitivity trades eagerness for strictness; reset() clears motion state', () => {
  const steps = [{ action: 'guard-high', ms: 1500 }];
  for (let i = 0; i < 6; i++) steps.push({ action: i % 2 ? 'cross' : 'jab-left', ms: 1100 });
  const count = (s) => {
    let n = 0;
    for (const o of PLAYERS) n += punches(run({ ...o, punchMs: 360, extension: 0.85 }, steps, { tuning: { sensitivity: s } }).events).length;
    return n;
  };
  assert(count(1) >= count(0), 'more eager at high sensitivity');
  const rec = new GestureRecognizer({ tuning: { sensitivity: 0.3 } });
  rec.setSensitivity(0.8);
  assert(rec.tuning.sensitivity === 0.8 && rec.tuning.xOnsetRate < DEFAULT_TUNING.xOnsetRate);
  const sp = makeSyntheticPlayer({ seed: 1 });
  for (let t = 0; t < 1000; t += 33) rec.update(sp.pose(t, 'idle'), t);
  rec.reset();
  assert(!rec.update(null, 2000).control.tracked);
});
