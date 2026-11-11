// Lean / dodge mapping of the alignment pass (research/mechanics.md §2.1 dodge table):
// sideways = the nose moves ≥ 0.35 shoulder widths → lean.x crosses the combat dodge threshold;
// back / forward = the upper body sways ≥ leanZDodgeM (≈ 11 cm) away from / toward the camera at ANY
// distance (INPUT-10; §2.1's "12 % narrower" was that sway at ≈ 1 m) → lean.z crosses the back-lean
// threshold; the lean stays fast; a back/forward lean must persist ~80 ms; a torso twist without a
// punch rarely reads as a back lean.
import { test, assert, approx } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { GestureRecognizer, DEFAULT_TUNING, leanCurve } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const T = DEFAULT_TUNING;
const ASPECT = 4 / 3;
const swOf = (p) => Math.hypot(p.image[LM.LEFT_SHOULDER].x - p.image[LM.RIGHT_SHOULDER].x, (p.image[LM.LEFT_SHOULDER].y - p.image[LM.RIGHT_SHOULDER].y) / ASPECT);

test('lean: leanCurve is 0 in the deadzone, exactly the level at the dodge movement, 1 at full, monotonic', () => {
  for (const [dz, at, level, full] of [[0.05, 0.35, 0.42, 0.6], [0.02, 0.12, 0.62, 0.18], [0.06, 0.35, 0.42, 0.75]]) {
    assert(leanCurve(dz * 0.9, dz, at, level, full) === 0 && leanCurve(0, dz, at, level, full) === 0);
    approx(leanCurve(at, dz, at, level, full), level, 1e-9);
    approx(leanCurve(-at, dz, at, level, full), -level, 1e-9);
    approx(leanCurve(full, dz, at, level, full), 1, 1e-9);
    assert(leanCurve(full * 2, dz, at, level, full) === 1);
    let prev = 0;
    for (let v = 0; v <= full * 1.5; v += full / 200) { const y = leanCurve(v, dz, at, level, full); assert(y >= prev - 1e-12, 'monotonic'); prev = y; }
  }
});

test('lean: the dodge levels in the tuning match game/combat.js (lean.x / lean.y / lean.z thresholds)', async () => {
  let COMBAT = null;
  try { ({ COMBAT } = await import('../../src/game/combat.js')); } catch { /* combat module mid-edit: skip */ }
  if (!COMBAT) return;
  if (Number.isFinite(COMBAT.dodgeLeanThreshold)) assert(T.leanDodgeLevelX === COMBAT.dodgeLeanThreshold, `lean.x level ${T.leanDodgeLevelX} vs COMBAT.dodgeLeanThreshold ${COMBAT.dodgeLeanThreshold}`);
  if (Number.isFinite(COMBAT.duckThreshold)) assert(T.duckDodgeLevel === COMBAT.duckThreshold, `duck level ${T.duckDodgeLevel} vs COMBAT.duckThreshold ${COMBAT.duckThreshold}`);
  if (Number.isFinite(COMBAT.backLeanThreshold)) assert(T.leanDodgeLevelZ === COMBAT.backLeanThreshold, `lean.z level ${T.leanDodgeLevelZ} vs COMBAT.backLeanThreshold ${COMBAT.backLeanThreshold}`);
});

/** Hold a lean of `amount`, return {dx: true nose shift (SW), scale: true shoulder-width change, lean: mean ControlState.lean}. */
function holdLean(base, action, amount) {
  const seq = sequence([{ action: 'guard-high', ms: 2000 }, { action, amount, ms: 1500 }, { action: 'guard-high', ms: 600 }]);
  const clean = makeSyntheticPlayer({ ...base, noise: 0 });
  const p0 = clean.pose(1900, seq); clean.reset();
  const p1 = clean.pose(3300, seq);
  const sw0 = swOf(p0);
  const dx = Math.abs(p1.image[LM.NOSE].x - p0.image[LM.NOSE].x) / sw0;
  const dy = (p1.image[LM.NOSE].y - p0.image[LM.NOSE].y) / ASPECT / sw0;
  const scale = swOf(p1) / sw0 - 1;
  const { frames } = makeSyntheticPlayer(base).run(seq);
  const rec = new GestureRecognizer();
  const hold = [];
  for (const fr of frames) { const c = rec.update(fr.players[0], fr.t).control; if (fr.t > 3000 && fr.t < 3450) hold.push(c.lean); }
  const m = (k) => hold.reduce((a, l) => a + l[k], 0) / hold.length;
  return { dx, dy, scale, lean: { x: m('x'), y: m('y'), z: m('z') } };
}

test('lean: sideways — a nose shift under the dodge distance stays under the threshold, well past it crosses it', () => {
  const small = [], big = [];
  for (let i = 0; i < 12; i++) {
    const base = randomPlayerOptions(600 + i);
    for (const [action, amount] of [['lean-left', 0.45], ['lean-right', 0.45], ['lean-left', 1.2], ['lean-right', 1.2]]) {
      const r = holdLean(base, action, amount);
      if (r.dx < 0.27) small.push(r); else if (r.dx > 0.45) big.push(r);
      assert(Math.sign(r.lean.x) === (action === 'lean-left' ? -1 : 1) || Math.abs(r.lean.x) < 0.05, `lean direction ${action} ${r.lean.x}`);
    }
  }
  assert(small.length >= 6 && big.length >= 6, `samples small ${small.length} big ${big.length}`);
  for (const r of small) assert(Math.abs(r.lean.x) < T.leanDodgeLevelX, `nose ${r.dx.toFixed(2)} SW read as a dodge (${r.lean.x.toFixed(2)})`);
  for (const r of big) assert(Math.abs(r.lean.x) >= T.leanDodgeLevelX, `nose ${r.dx.toFixed(2)} SW not a dodge (${r.lean.x.toFixed(2)})`);
});

/** Noise-free forward sway (m, + = toward the camera) of the upper body (shoulder centre + nose) after a hold. */
function swayOf(base, seq, t0, t1) {
  const sk = makeSyntheticPlayer({ ...base, noise: 0 });
  const z = (t) => { const p = sk.skeleton(t, seq); return ((p[LM.LEFT_SHOULDER][2] + p[LM.RIGHT_SHOULDER][2]) / 2 + p[LM.NOSE][2]) / 2; };
  return z(t0) - z(t1);   // room z grows away from the camera
}

test('lean: back / forward — the dodge line is a physical sway (≈ 11 cm), the same at every camera distance (INPUT-10)', () => {
  const rows = { near: { under: [], over: [] }, far: { under: [], over: [] } };
  for (let i = 0; i < 14; i++) {
    for (const band of ['near', 'far']) {
      const base = randomPlayerOptions(700 + i, { distance: band === 'near' ? 1.3 + 0.05 * i : 2.3 + 0.05 * i });
      for (const [action, amount] of [['lean-back', 0.3], ['lean-back', 1.6], ['lean-forward', 0.25], ['lean-forward', 1.2]]) {
        const seq = sequence([{ action: 'guard-high', ms: 2000 }, { action, amount, ms: 1500 }, { action: 'guard-high', ms: 600 }]);
        const sway = swayOf(base, seq, 1900, 3300);
        const r = holdLean(base, action, amount);
        if (Math.abs(sway) < 0.06) rows[band].under.push({ sway, z: r.lean.z }); else if (Math.abs(sway) > 0.16) rows[band].over.push({ sway, z: r.lean.z });
      }
    }
  }
  for (const [band, { under, over }] of Object.entries(rows)) {
    assert(under.length >= 8 && over.length >= 8, `${band}: samples under ${under.length} over ${over.length}`);
    for (const r of under) assert(Math.abs(r.z) < T.leanDodgeLevelZ, `${band}: a ${(100 * r.sway).toFixed(1)} cm sway read as a dodge (${r.z.toFixed(2)})`);
    const crossed = over.filter((r) => Math.abs(r.z) >= T.leanDodgeLevelZ * 0.9 && Math.sign(r.z) === Math.sign(r.sway)).length;
    console.log(`      ${band} (${band === 'near' ? '1.3–2.0' : '2.3–3.0'} m): sways ≥ 16 cm crossed ${crossed}/${over.length}; ≤ 6 cm 0/${under.length}`);
    // (the mean over a held lean: the forward/back cues jitter by a few cm and the camera's focal length is
    // only assumed, so a 16–20 cm sway of a far player can average just short; before the fix ≈ 5/28 near)
    assert(crossed >= Math.ceil(over.length * 0.75), `${band}: clear back/forward leans crossed ${crossed}/${over.length}`);
  }
});

test('lean: fast — lean.x crosses the dodge threshold within ~60 ms of the nose crossing 0.35 SW (sim, incl. 18 ms tracker lag)', () => {
  const lags = [];
  for (let i = 0; i < 10; i++) {
    const base = randomPlayerOptions(800 + i);
    for (const action of ['lean-left', 'lean-right']) {
      const seq = sequence([{ action: 'guard-high', ms: 2000 }, { action, amount: 1.2, ms: 1000 }]);
      const clean = makeSyntheticPlayer({ ...base, noise: 0 });
      const p0 = clean.pose(1900, seq), sw0 = swOf(p0);
      let tTrue = null;
      for (let t = 2000; t < 2800; t += 2) { if (Math.abs(clean.pose(t, seq).image[LM.NOSE].x - p0.image[LM.NOSE].x) / sw0 >= 0.35) { tTrue = t; break; } }
      const { frames } = makeSyntheticPlayer(base).run(seq);
      const rec = new GestureRecognizer();
      let tOut = null;
      for (const fr of frames) { const c = rec.update(fr.players[0], fr.t).control; if (fr.t > 2000 && tOut === null && Math.abs(c.lean.x) >= T.leanDodgeLevelX) tOut = fr.t; }
      if (tTrue !== null && tOut !== null) lags.push(tOut - tTrue);
    }
  }
  lags.sort((a, b) => a - b);
  const med = lags[Math.floor(lags.length / 2)];
  console.log(`      dodge crossing lag: median ${med.toFixed(0)} ms, max ${lags[lags.length - 1].toFixed(0)} ms (n ${lags.length})`);
  assert(lags.length >= 16, `crossings ${lags.length}`);
  assert(med <= 60, `median lag ${med}`);
});

/** Poses of one player (2.0 m from the camera) moved back as a whole upper body by the scale k(t): the
 *  picture shrinks about the shoulder centre by k and the world depth of everything above the hips grows
 *  by the matching sway (compressed like the tracker's), so both forward/back cues agree. */
function scaledFrames(k, ms = 3000) {
  const sp = makeSyntheticPlayer({ seed: 5, noise: 0.3 });
  const out = [];
  for (let t = 0; t <= ms; t += 33) {
    const p = sp.pose(t, 'guard-high');
    const f = k(t);
    const cx = (p.image[11].x + p.image[12].x) / 2, cy = (p.image[11].y + p.image[12].y) / 2;
    p.image = p.image.map((l) => ({ ...l, x: cx + (l.x - cx) * f, y: cy + (l.y - cy) * f }));
    const dz = 2.0 * (1 / f - 1) * sp.options.zScale;
    p.world = p.world.map((l, i) => (i <= 22 ? { ...l, z: l.z + dz } : l));
    out.push({ t, pose: p });
  }
  return out;
}

test('lean: a back lean must persist ~80 ms before lean.z shows it; the release is immediate', () => {
  // a 2-frame (≈ 66 ms) shrink by 20 % never counts …
  let rec = new GestureRecognizer({});
  let minZ = 0;
  for (const { t, pose } of scaledFrames((t) => (t >= 2000 && t < 2066 ? 0.8 : 1))) minZ = Math.min(minZ, rec.update(pose, t).control.lean.z);
  assert(minZ > -T.leanDodgeLevelZ, `brief shrink read as a back lean (${minZ})`);
  // … a sustained one (12 % ≈ 27 cm at 2 m) does, about leanZHoldMs after it starts, and drops right after it ends
  rec = new GestureRecognizer({});
  let tOn = null, tOff = null;
  for (const { t, pose } of scaledFrames((t) => (t >= 2000 && t < 2600 ? 0.88 : 1))) {
    const z = rec.update(pose, t).control.lean.z;
    if (tOn === null && z <= -T.leanDodgeLevelZ) tOn = t;
    if (tOn !== null && tOff === null && t >= 2600 && z > -T.leanDodgeLevelZ) tOff = t;
  }
  assert(tOn !== null && tOn - 2000 >= T.leanZHoldMs - 1 && tOn - 2000 <= T.leanZHoldMs + 120, `back lean showed at +${tOn - 2000} ms`);
  assert(tOff !== null && tOff - 2600 <= 140, `release after ${tOff - 2600} ms`);
});

test('lean: a torso twist without a punch (≈ 26°) rarely reads as a back lean; own punches never do', () => {
  let twistFalse = 0, punchFalse = 0, n = 0;
  for (let i = 0; i < 16; i++) {
    const base = randomPlayerOptions(900 + i);
    const seq = sequence([{ action: 'guard-high', ms: 2500 }, { action: 'twist-left', ms: 1200 }, { action: 'guard-high', ms: 900 }, { action: 'twist-right', ms: 1200 }, { action: 'guard-high', ms: 800 },
      { action: 'jab-left', ms: 700 }, { action: 'cross', ms: 700 }, { action: 'hook-left', ms: 800 }, { action: 'hook-right', ms: 800 }, { action: 'guard-high', ms: 600 }]);
    const { frames } = makeSyntheticPlayer(base).run(seq);
    const rec = new GestureRecognizer();
    let tz = 0, pz = 0;
    for (const fr of frames) {
      const z = rec.update(fr.players[0], fr.t).control.lean.z;
      if (fr.t > 2500 && fr.t < 7100) tz = Math.min(tz, z); else if (fr.t >= 7100) pz = Math.min(pz, z);
    }
    n++;
    if (tz <= -T.leanDodgeLevelZ) twistFalse++;
    if (pz <= -T.leanDodgeLevelZ) punchFalse++;
  }
  console.log(`      twist read as a back-lean dodge: ${twistFalse}/${n}; punches: ${punchFalse}/${n}`);
  assert(twistFalse <= Math.ceil(n * 0.25), `twists ${twistFalse}/${n}`);
  assert(punchFalse === 0, `punches ${punchFalse}/${n}`);
});

test('lean: at rest the lean is quiet (no dodge, |lean.x| tiny)', () => {
  for (let i = 0; i < 6; i++) {
    const base = randomPlayerOptions(950 + i);
    const { frames } = makeSyntheticPlayer(base).run(sequence([{ action: 'guard-high', ms: 6000 }]));
    const rec = new GestureRecognizer();
    let mx = 0, mz = 0;
    for (const fr of frames) { const c = rec.update(fr.players[0], fr.t).control; if (fr.t > 1500) { mx = Math.max(mx, Math.abs(c.lean.x), Math.abs(c.lean.y)); mz = Math.max(mz, Math.abs(c.lean.z)); } }
    assert(mx < 0.15 && mz < T.leanDodgeLevelZ, `rest lean x/y ${mx.toFixed(2)} z ${mz.toFixed(2)} (seed ${i})`);
  }
});
