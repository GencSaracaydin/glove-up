// Regression tests of the gesture fix pass for the neutral / lean model (INPUT-01, INPUT-02, INPUT-10)
// and the calibration fixes (INPUT-06, INPUT-M1, INPUT-09). Realistic tracker noise (noise 1) unless noted.
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { GestureRecognizer, DEFAULT_TUNING as T } from '../../src/input/gesture.js';
import { CalibrationSession, frameCheck, CALIBRATION_DEFAULTS } from '../../src/input/calibration.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

/** Closed-loop calibration: a player who does what each step asks (`raise`: which hand goes up at step 3). */
function calibrate(opts, { raise = 'right', punchLeft = 'left', punchRight = 'right', maxMs = 70000 } = {}) {
  const sp = makeSyntheticPlayer(opts);
  const cs = new CalibrationSession();
  const punches = (hand) => { const s = [{ action: 'guard-high', ms: 600 }]; for (let i = 0; i < 14; i++) s.push({ action: `jab-${hand}`, ms: 900 }, { action: 'guard-high', ms: 300 }); return sequence(s); };
  const plan = {
    frame: sequence([{ action: 'idle', ms: Infinity }]),
    guard: sequence([{ action: 'idle', ms: 300 }, { action: 'guard-high', ms: Infinity }]),
    'right-hand': sequence([{ action: 'guard-high', ms: 400 }, { action: 'raise-hand', hand: raise, ms: Infinity }]),
    'punch-left': punches(punchLeft), 'punch-right': punches(punchRight),
  };
  const states = [];
  let step = null, t0 = 0, st = null;
  for (let t = 0; t < maxMs; t += 33.3) {
    const cur = cs.step;
    if (cur !== step) { step = cur; t0 = t; sp.reset(); }
    st = cs.update(sp.pose(t - t0, plan[cur]), t);
    states.push({ t, step: cur, message: st.message, stuck: st.stuck });
    if (st.done) break;
  }
  return { result: st.done ? st.result : null, states, cs };
}

/** A bout: guard, jabs, crosses and real sideways leans. */
function boutScript() {
  const s = [{ action: 'guard-high', ms: 3000 }];
  for (let i = 0; i < 4; i++) {
    s.push({ action: 'jab', ms: 700 }, { action: 'guard-high', ms: 1200 }, { action: 'cross', ms: 700 }, { action: 'guard-high', ms: 1400 },
      { action: i % 2 ? 'lean-left' : 'lean-right', ms: 700 }, { action: 'guard-high', ms: 1600 });
  }
  return sequence(s);
}

test('fix INPUT-01: a calibration made elsewhere never pins the neutral head — standing 15–25 cm aside reads upright', () => {
  for (const seed of [1, 3, 6]) {
    const o = randomPlayerOptions(seed, { noise: 1 });
    const { result: cal } = calibrate(o);
    assert(cal, `calibration finished (seed ${seed})`);
    for (const off of [0.15, 0.25]) {
      const script = boutScript();
      const gr = new GestureRecognizer({ calibration: cal });
      let quiet = 0, dodge = 0, leans = 0, leansOk = 0, peak = 0, cur = null, stance = 0;
      for (const f of makeSyntheticPlayer({ ...o, lateral: o.lateral + off }).frames(script)) {
        const { control } = gr.update(f.players[0], f.t);
        stance = Math.max(stance, control.stanceMs);
        const st = script.steps.find((s) => f.t >= s.start && f.t < s.end);
        if (st && st.action.startsWith('lean-')) {
          if (cur !== st.index) { if (cur !== null) { leans++; if (peak >= T.leanDodgeLevelX) leansOk++; } cur = st.index; peak = 0; }
          peak = Math.max(peak, (st.action === 'lean-left' ? -1 : 1) * control.lean.x);
        }
        if (f.t < 3000 || !st || st.action !== 'guard-high' || f.t - st.start < 600) continue;
        quiet++; if (Math.abs(control.lean.x) >= T.leanDodgeLevelX) dodge++;
      }
      if (cur !== null) { leans++; if (peak >= T.leanDodgeLevelX) leansOk++; }
      assert(dodge / quiet < 0.05, `seed ${seed}, ${off * 100} cm aside: ${(100 * dodge / quiet).toFixed(0)}% of quiet-guard frames read as a dodge`);
      assert(leansOk === leans, `seed ${seed}, ${off * 100} cm aside: real leans reached the dodge ${leansOk}/${leans}`);
      assert(stance >= 1000, `seed ${seed}, ${off * 100} cm aside: the stance was held (${stance} ms)`);
    }
    // what it keeps instead: the head over the shoulders in shoulder widths
    assert(cal.neutralHeadRel && Math.abs(cal.neutralHeadRel.x) < 0.3 && cal.neutralHeadRel.y < 0, `neutralHeadRel stored: ${JSON.stringify(cal.neutralHeadRel)}`);
  }
});

test('fix INPUT-01: calibration image positions are ignored (a bogus neutralHead / shoulderWidth / camera pitch change)', () => {
  const o = { seed: 11, noise: 1, distance: 2.0, cameraHeight: 0.8, cameraTilt: -0.1 };
  const bogus = { version: 1, shoulderWidth: 0.4, armLengthWorld: 0.6, neutralHead: { x: 0.2, y: 0.9 }, neutralShoulderY: 1.0, swapSides: false, createdAt: 0, neutralTilt: 0 };
  for (const dt of [0, 0.05, -0.05]) {
    const gr = new GestureRecognizer({ calibration: bogus });
    let n = 0, bad = 0;
    for (const f of makeSyntheticPlayer({ ...o, cameraTilt: o.cameraTilt + dt }).frames(sequence([{ action: 'guard-high', ms: 8000 }]))) {
      const { control } = gr.update(f.players[0], f.t);
      if (f.t < 2000) continue;
      n++; if (Math.abs(control.lean.x) >= 0.3 || Math.abs(control.lean.y) >= 0.3 || Math.abs(control.lean.z) >= 0.3) bad++;
    }
    assert(bad / n < 0.02, `camera pitch ${dt}: ${(100 * bad / n).toFixed(1)}% of frames leaned`);
  }
});

test('fix INPUT-02: a step back / forward mid-bout is never a lasting lean; a real back lean after it still dodges', () => {
  const lerp = (a, b, u) => a + (b - a) * u;
  const blend = (a, b, u) => (!a || !b ? (u < 0.5 ? a : b) : { ...b,
    image: b.image.map((l, i) => ({ ...l, x: lerp(a.image[i].x, l.x, u), y: lerp(a.image[i].y, l.y, u) })),
    world: b.world.map((l, i) => ({ ...l, x: lerp(a.world[i].x, l.x, u), y: lerp(a.world[i].y, l.y, u), z: lerp(a.world[i].z, l.z, u) })) });
  const seq = sequence([{ action: 'guard-high', ms: 5000 }, ...Array.from({ length: 4 }, (_, i) => [{ action: 'guard-high', ms: 2500 }, { action: i % 2 ? 'jab' : 'cross', ms: 800 }]).flat(),
    { action: 'guard-high', ms: 2000 }, { action: 'lean-back', amount: 1.5, ms: 1000 }, { action: 'guard-high', ms: 2000 }]);
  const leanAt = seq.steps.find((s) => s.action === 'lean-back').start;
  for (const seed of [5, 9, 13]) {
    for (const [d0, d1] of [[2.0, 2.4], [2.4, 2.0], [2.5, 3.0]]) {
      const A = makeSyntheticPlayer({ seed, noise: 1, distance: d0, cameraTilt: 0, cameraHeight: 1.28 });
      const B = makeSyntheticPlayer({ seed, noise: 1, distance: d1, cameraTilt: 0, cameraHeight: 1.28 });
      const gr = new GestureRecognizer();
      let n = 0, bad = 0, leanMin = 0;
      for (const t of A.frameTimes(seq.totalMs)) {
        const u = Math.min(1, Math.max(0, (t - 6000) / 800));
        const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), u), t);
        if (t > 7000 && t < leanAt) { n++; if (Math.abs(control.lean.z) >= T.leanDodgeLevelZ || control.lean.y <= -T.duckDodgeLevel) bad++; }
        if (t > leanAt && t < leanAt + 1000) leanMin = Math.min(leanMin, control.lean.z);
      }
      assert(bad / n < 0.05, `seed ${seed} ${d0}→${d1} m: ${(100 * bad / n).toFixed(0)}% of frames after the step read as a dodge`);
      assert(leanMin <= -T.leanDodgeLevelZ, `seed ${seed} ${d0}→${d1} m: the back lean after the step reached ${leanMin.toFixed(2)}`);
    }
  }
});

test('fix INPUT-02: Fight! pressed near the laptop, then the walk to the play spot — no duck or back lean in the bout', () => {
  const lerp = (a, b, u) => a + (b - a) * u;
  const blend = (a, b, u) => (!a || !b ? (u < 0.5 ? a : b) : { ...b,
    image: b.image.map((l, i) => ({ ...l, x: lerp(a.image[i].x, l.x, u), y: lerp(a.image[i].y, l.y, u) })),
    world: b.world.map((l, i) => ({ ...l, x: lerp(a.world[i].x, l.x, u), y: lerp(a.world[i].y, l.y, u), z: lerp(a.world[i].z, l.z, u) })) });
  const seq = sequence([{ action: 'idle', ms: 9000 }, { action: 'guard-high', ms: 16000 }]);
  for (const seed of [3, 7, 11]) {
    for (const d0 of [1.3, 1.6]) {
      const A = makeSyntheticPlayer({ seed, distance: d0, cameraHeight: 0.75, cameraTilt: -0.12 });
      const B = makeSyntheticPlayer({ seed, distance: 2.3, cameraHeight: 0.75, cameraTilt: -0.12 });
      const gr = new GestureRecognizer();
      let n = 0, bad = 0;
      for (const t of A.frameTimes(seq.totalMs)) {
        const u = Math.min(1, Math.max(0, (t - 2500) / 2000));
        const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), u), t);
        if (t > 9000) { n++; if (control.lean.y <= -T.duckDodgeLevel || control.lean.z <= -T.leanDodgeLevelZ) bad++; }
      }
      assert(bad / n < 0.05, `seed ${seed} from ${d0} m: ${(100 * bad / n).toFixed(0)}% of the bout read as a duck / back lean`);
    }
  }
});

test('fix INPUT-02: the neutral waits for a steady stance (lean 0 while walking in) and is learned again after the player was gone', () => {
  const o = { seed: 4, noise: 1, distance: 2.2 };
  // walking in: arms down and moving — no lean at all; then the guard: learned within ~1.5 s
  const sp = makeSyntheticPlayer(o);
  const seq = sequence([{ action: 'arms-down', ms: 1500 }, { action: 'lean-left', amount: 1.3, ms: 600 }, { action: 'guard-high', ms: 4000 }]);
  const gr = new GestureRecognizer();
  let learnedAt = null, early = 0;
  for (const f of sp.frames(seq)) {
    const { control } = gr.update(f.players[0], f.t);
    if (f.t < 2100 && Math.abs(control.lean.x) > 0) early++;
    if (learnedAt === null && gr.debug && gr.debug.neutral) learnedAt = f.t;
  }
  assert(early === 0, `no lean before the stance (${early} frames)`);
  assert(learnedAt !== null && learnedAt > 2100 && learnedAt < 2100 + 2000, `neutral learned in the guard (${learnedAt})`);
  // gone for 2 s, back 30 cm to the side: upright again after re-learning, not a permanent dodge
  const g2 = new GestureRecognizer();
  const A = makeSyntheticPlayer(o), B = makeSyntheticPlayer({ ...o, lateral: 0.3 });
  const s2 = sequence([{ action: 'guard-high', ms: 20000 }]);
  let n = 0, bad = 0;
  for (const t of A.frameTimes(14000)) {
    const pose = t < 4000 ? A.pose(t, s2) : t < 6000 ? null : B.pose(t, s2);
    const { control } = g2.update(pose, t);
    if (t > 8000) { n++; if (Math.abs(control.lean.x) >= T.leanDodgeLevelX) bad++; }
  }
  assert(bad / n < 0.05, `after coming back 30 cm aside: ${(100 * bad / n).toFixed(0)}% dodge frames`);
});

test('fix INPUT-10: an 18 cm back sway reaches the back-lean dodge at 2.0, 2.5 and 3.0 m; a twist does not', () => {
  for (const d of [2.0, 2.5, 3.0]) {
    let reached = 0, n = 0;
    for (const seed of [4, 8, 15, 16]) {
      const fr = makeSyntheticPlayer({ seed, noise: 1, distance: d }).frames(sequence([{ action: 'guard-high', ms: 2500 }, { action: 'lean-back', amount: 1.5, ms: 1200 }, { action: 'guard-high', ms: 800 }]));
      const gr = new GestureRecognizer();
      let zmin = 0;
      for (const f of fr) { const c = gr.update(f.players[0], f.t).control; if (f.t > 2500) zmin = Math.min(zmin, c.lean.z); }
      n++; if (zmin <= -T.leanDodgeLevelZ) reached++;
    }
    assert(reached === n, `${d} m: an 18 cm sway reached the dodge in ${reached}/${n}`);
  }
  // the same player only twisting the torso (shoulders narrow by ~20 %) at the far end
  const fr = makeSyntheticPlayer({ seed: 4, noise: 1, distance: 3.0 }).frames(sequence([{ action: 'guard-high', ms: 2500 }, { action: 'twist-right', ms: 1200 }, { action: 'guard-high', ms: 800 }]));
  const gr = new GestureRecognizer();
  let zmin = 0;
  for (const f of fr) { const c = gr.update(f.players[0], f.t).control; if (f.t > 2500) zmin = Math.min(zmin, c.lean.z); }
  assert(zmin > -T.leanDodgeLevelZ, `a twist at 3 m read as a back lean (${zmin.toFixed(2)})`);
});

test('fix INPUT-06: raising the LEFT hand at the right-hand step is undone by the punch steps (normal webcam); a mirrored camera still swaps', () => {
  for (const seed of [21, 33]) {
    const o = { ...randomPlayerOptions(seed, { noise: 1 }), lead: 'left' };
    const wrong = calibrate(o, { raise: 'left' });
    assert(wrong.result && wrong.result.swapSides === false, `seed ${seed}: raised left → swapSides ${wrong.result && wrong.result.swapSides}`);
    assert(wrong.states.some((s) => /swapped/i.test(s.message)), 'the player is told left and right were fixed');
    const gr = new GestureRecognizer({ calibration: wrong.result });
    const hands = [];
    for (const f of makeSyntheticPlayer({ ...o, seed: o.seed + 1 }).frames(sequence([{ action: 'guard-high', ms: 2000 }, { action: 'jab-left', ms: 900 }, { action: 'guard-high', ms: 600 }, { action: 'jab-right', ms: 900 }, { action: 'guard-high', ms: 600 }]))) {
      for (const e of gr.update(f.players[0], f.t).events) if (e.type === 'punch') hands.push(e.punch.hand);
    }
    assert(hands[0] === 'left' && !hands.slice(1).includes('left'), `later bout: ${hands.join(',')}`);
    const mirrored = calibrate({ ...o, mirrorCamera: true }, { raise: 'right' });
    assert(mirrored.result && mirrored.result.swapSides === true, `seed ${seed}: mirrored camera → swapSides ${mirrored.result && mirrored.result.swapSides}`);
  }
  // a player who keeps punching with the right hand in both steps (ignoring the messages): no swap in the end
  const o = { ...randomPlayerOptions(45, { noise: 1 }), lead: 'left' };
  const r = calibrate(o, { raise: 'right', punchLeft: 'right', punchRight: 'right' });
  assert(r.result && r.result.swapSides === false, `obstinate right-hander → swapSides ${r.result && r.result.swapSides}`);
});

test('fix INPUT-M1: "That was your right hand" stays on screen ≥ 1 s after a wrong-hand punch', () => {
  const o = { ...randomPlayerOptions(21, { noise: 1 }), lead: 'left' };
  const { states } = calibrate(o, { punchLeft: 'right', maxMs: 30000 });
  let longest = 0, run = 0, prev = null;
  for (const s of states.filter((x) => x.step === 'punch-left')) {
    if (/That was your right hand — use your LEFT hand/.test(s.message)) { run += prev === null ? 0 : s.t - prev; longest = Math.max(longest, run); } else run = 0;
    prev = s.t;
  }
  assert(longest >= 1000, `wrong-hand message shown for ${Math.round(longest)} ms`);
  assert(CALIBRATION_DEFAULTS.eventMessageMs >= 1200);
});

test('fix INPUT-09: the frame and guard steps flag stuck after their give-up time (the screen then offers to skip)', () => {
  const run = (o, action, ms) => {
    const sp = makeSyntheticPlayer({ ...o, noise: 1 });
    const cs = new CalibrationSession({});
    const seq = sequence([{ action, ms: Infinity }]);
    const out = [];
    for (const t of sp.frameTimes(ms)) { const st = cs.update(sp.pose(t, seq), t); out.push({ t, step: st.step, stuck: st.stuck, hint: st.hint }); }
    return out;
  };
  const far = run({ seed: 3, distance: 3.9, focal: 0.62 }, 'idle', 17000);
  assert(far.every((s) => s.step === 'frame'), 'too far: stays on the frame step');
  assert(far.filter((s) => s.t < CALIBRATION_DEFAULTS.frameGiveUpMs - 100).every((s) => !s.stuck), 'not stuck before the give-up time');
  assert(far[far.length - 1].stuck && /skip/i.test(far[far.length - 1].hint), 'stuck (with a hint) after it');
  const low = run({ seed: 3 }, 'arms-down', 19000);
  const last = low[low.length - 1];
  assert(last.step === 'guard' && last.stuck, `hands never up: ${last.step} stuck ${last.stuck}`);
  // a player the camera check lets in (2.8 m, wide lens) passes the frame step too (tooFarSW = the camera check)
  const p = makeSyntheticPlayer({ seed: 57, noise: 0, distance: 2.8, focal: 0.65 }).pose(500, 'idle');
  const fc = frameCheck(p);
  assert(fc.ok, `2.8 m with a wide lens: ${fc.message} (shoulder width ${fc.shoulderWidth.toFixed(3)})`);
});
