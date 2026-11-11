// "Different author" check: hand-built irregular sequences from an INDEPENDENT keyframe
// generator (does not use synthetic.js): hand-entered metric body, joint keyframes with cubic
// ease timing (fast out / slow back, uneven holds), sloppy technique (no hook wind-up,
// uppercut without a dip, flared-elbow jab), heavy-tailed per-frame noise, a different depth
// compression and multi-frame landmark freezes. Guards against overfitting to our generator.
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import { GestureRecognizer } from '../../src/input/gesture.js';

// ── a tiny seeded RNG (independent of synthetic.js) ──
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const laplace = (r, b) => { const u = r() - 0.5; return -b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)); };
const ease = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };   // cubic smoothstep
const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);

// ── body at rest (world metres: x = image right, y down, z away; origin between the hips) ──
const REST = {
  [LM.NOSE]: [0, -0.68, -0.1], [LM.LEFT_EYE]: [0.035, -0.71, -0.08], [LM.RIGHT_EYE]: [-0.035, -0.71, -0.08],
  [LM.LEFT_EYE_INNER]: [0.015, -0.71, -0.09], [LM.RIGHT_EYE_INNER]: [-0.015, -0.71, -0.09],
  [LM.LEFT_EYE_OUTER]: [0.05, -0.71, -0.07], [LM.RIGHT_EYE_OUTER]: [-0.05, -0.71, -0.07],
  [LM.LEFT_EAR]: [0.075, -0.69, 0], [LM.RIGHT_EAR]: [-0.075, -0.69, 0],
  [LM.MOUTH_LEFT]: [0.025, -0.635, -0.09], [LM.MOUTH_RIGHT]: [-0.025, -0.635, -0.09],
  [LM.LEFT_SHOULDER]: [0.18, -0.5, 0], [LM.RIGHT_SHOULDER]: [-0.18, -0.5, 0],
  [LM.LEFT_ELBOW]: [0.19, -0.27, -0.1], [LM.RIGHT_ELBOW]: [-0.19, -0.26, -0.07],
  [LM.LEFT_WRIST]: [0.08, -0.47, -0.27], [LM.RIGHT_WRIST]: [-0.07, -0.43, -0.2],
  [LM.LEFT_HIP]: [0.1, 0, 0], [LM.RIGHT_HIP]: [-0.1, 0, 0],
  [LM.LEFT_KNEE]: [0.11, 0.42, -0.05], [LM.RIGHT_KNEE]: [-0.11, 0.42, 0.02],
  [LM.LEFT_ANKLE]: [0.12, 0.84, -0.1], [LM.RIGHT_ANKLE]: [-0.12, 0.84, 0.05],
};
const SIDE = { left: { w: LM.LEFT_WRIST, e: LM.LEFT_ELBOW }, right: { w: LM.RIGHT_WRIST, e: LM.RIGHT_ELBOW } };

/**
 * A motion = list of keyframes for one arm: [{t, w:[x,y,z], e:[x,y,z]}] (times relative to the
 * motion start, eased between keys). Missing joints stay where they were.
 */
function armAt(keys, t, base) {
  let a = { t: 0, ...base }, cur = base;
  for (const k of keys) {
    const b = { w: k.w || cur.w, e: k.e || cur.e };
    if (t <= k.t) { const u = ease((t - a.t) / Math.max(1, k.t - a.t)); return { w: mix(a.w, b.w, u), e: mix(a.e, b.e, u) }; }
    a = { t: k.t, ...b }; cur = b;
  }
  return cur;
}

/** Render a script [{at, hand, keys, wiggle?}] into PoseFrames with this author's noise. */
function render(script, ms, seed, { zComp = 0.75 } = {}) {
  const r = rng(seed);
  const frames = [];
  const freeze = { left: 0, right: 0 }, frozen = {};
  for (let t = 0; t <= ms; t += 33.3 + (r() - 0.5) * 12) {
    const pos = {};
    for (const [i, p] of Object.entries(REST)) pos[i] = p.slice();
    // idle sway of the whole upper body
    const sway = [0.012 * Math.sin(t / 700), 0.008 * Math.sin(t / 310), 0];
    for (const i of Object.keys(pos)) if (+i <= 22) pos[i] = pos[i].map((v, k) => v + sway[k]);
    for (const m of script) {
      if (t < m.at) continue;
      const S = SIDE[m.hand];
      const base = { w: pos[S.w], e: pos[S.e] };
      const a = armAt(m.keys, t - m.at, base);
      const wig = m.wiggle ? [m.wiggle * Math.sin((t - m.at) / 1000 * 2 * Math.PI * (m.hz || 4)), 0, 0] : [0, 0, 0];
      pos[S.w] = a.w.map((v, k) => v + wig[k]);
      pos[S.e] = a.e;
    }
    // fist points from the wrist
    for (const h of ['left', 'right']) {
      const S = SIDE[h], w = pos[S.w], e = pos[S.e];
      const d = w.map((v, k) => v - e[k]); const l = Math.hypot(...d) || 1;
      const off = (s) => w.map((v, k) => v + d[k] / l * 0.07 + (k === 0 ? s : 0));
      pos[h === 'left' ? LM.LEFT_INDEX : LM.RIGHT_INDEX] = off(0.015);
      pos[h === 'left' ? LM.LEFT_PINKY : LM.RIGHT_PINKY] = off(-0.02);
      pos[h === 'left' ? LM.LEFT_THUMB : LM.RIGHT_THUMB] = off(0.025);
    }
    for (let i = 0; i < 33; i++) if (!pos[i]) pos[i] = REST[LM.LEFT_ANKLE].slice();
    // camera: 2.1 m in front, slightly below the shoulders, f = 0.85 · width, 640×480
    const image = [], world = [];
    for (let i = 0; i < 33; i++) {
      const [X, Y, Z] = pos[i];
      const cz = Z + 2.1, cy = Y + 0.42;
      image.push({ x: 0.5 + 0.85 * X / cz + laplace(r, 0.0018), y: 0.5 + 1.1333 * cy / cz + laplace(r, 0.0024), z: 0, visibility: 0.93 + 0.06 * r() });
      world.push({ x: X + laplace(r, 0.008), y: Y + laplace(r, 0.008), z: Z * zComp + laplace(r, 0.02), visibility: image[i].visibility });
    }
    // occasional multi-frame freezes of a wrist (motion blur), lower visibility
    for (const h of ['left', 'right']) {
      const wi = SIDE[h].w;
      if (freeze[h] <= 0 && r() < 0.015) { freeze[h] = 2 + Math.floor(r() * 3); frozen[h] = { img: image[wi], wld: world[wi] }; }
      if (freeze[h] > 0) { freeze[h]--; image[wi] = { ...frozen[h].img, visibility: 0.35 }; world[wi] = { ...frozen[h].wld, visibility: 0.35 }; }
    }
    frames.push({ t, width: 640, height: 480, players: [{ image, world, score: 0.95 }] });
  }
  return frames;
}

function recognise(frames) {
  const rec = new GestureRecognizer({});
  const ev = [];
  for (const f of frames) for (const e of rec.update(f.players[0], f.t).events) if (e.type === 'punch') ev.push(e.punch);
  return ev;
}

// ── punches, authored differently ──
const W = (h, k) => REST[SIDE[h][k]];
const jab = (at, out = 140, hold = 40, back = 260) => ({ at, hand: 'left', keys: [
  { t: out, w: [0.02, -0.53, -0.72], e: [0.13, -0.49, -0.42] }, { t: out + hold }, { t: out + hold + back, w: W('left', 'w'), e: W('left', 'e') }] });
const cross = (at, out = 170) => ({ at, hand: 'right', keys: [
  { t: out, w: [-0.01, -0.54, -0.76], e: [-0.11, -0.5, -0.46] }, { t: out + 30 }, { t: out + 330, w: W('right', 'w'), e: W('right', 'e') }] });
const lazyHook = (at) => ({ at, hand: 'right', keys: [   // elbow up and out first, then sweep — no backswing
  { t: 90, w: [-0.27, -0.5, -0.3], e: [-0.31, -0.49, -0.12] }, { t: 260, w: [0.05, -0.53, -0.38], e: [-0.22, -0.5, -0.24] },
  { t: 310 }, { t: 620, w: W('right', 'w'), e: W('right', 'e') }] });
const scoopless = (at) => ({ at, hand: 'left', keys: [  // uppercut straight up from the stance (no dip)
  { t: 190, w: [0.06, -0.69, -0.4], e: [0.14, -0.4, -0.25] }, { t: 230 }, { t: 520, w: W('left', 'w'), e: W('left', 'e') }] });
const bodyJab = (at) => ({ at, hand: 'left', keys: [
  { t: 160, w: [0.03, -0.25, -0.64], e: [0.13, -0.35, -0.36] }, { t: 200 }, { t: 480, w: W('left', 'w'), e: W('left', 'e') }] });

test('irregular: sloppy jab–cross–jab combos with uneven gaps', () => {
  for (const seed of [1, 2, 3]) {
    const script = [jab(1200), cross(1650), jab(2500, 110, 60, 200), cross(2800, 150), jab(3900, 180), cross(4300)];
    const ev = recognise(render(script, 5200, seed));
    assert.deepEqual(ev.map((p) => p.hand), ['left', 'right', 'left', 'right', 'left', 'right'], `seed ${seed}: ${JSON.stringify(ev)}`);
    assert(ev.every((p) => p.kind === 'straight' && p.target === 'head'), JSON.stringify(ev));
  }
});

test('irregular: lazy hook (no wind-up) is a hook; body jab is a body straight', () => {
  for (const seed of [4, 5]) {
    const ev = recognise(render([lazyHook(1200), bodyJab(2300)], 3300, seed));
    assert(ev.length === 2, `seed ${seed}: ${JSON.stringify(ev)}`);
    assert(ev[0].hand === 'right' && ev[0].kind === 'hook', `hook seen as ${ev[0].kind}`);
    assert(ev[1].hand === 'left' && ev[1].target === 'body', `body jab target ${ev[1].target}`);
  }
});

test('irregular: uppercut without a dip still registers as one punch (kind reported)', () => {
  const kinds = [];
  for (const seed of [6, 7, 8]) {
    const ev = recognise(render([scoopless(1200)], 2200, seed));
    assert(ev.length <= 1, `seed ${seed}: double fire ${JSON.stringify(ev)}`);
    kinds.push(ev[0] ? ev[0].kind : 'none');
  }
  // Our uppercut test wants a scoop (dip or low start); a dip-less "uppercut" from the stance is
  // ambiguous with a rising straight. It must at least not double-fire; report what it was.
  console.log(`      dip-less uppercut recognised as: ${kinds.join(', ')}`);
  assert(kinds.filter((k) => k !== 'none').length >= 2, `dip-less uppercut mostly missed: ${kinds}`);
});

test('irregular: distractors from another author never fire', () => {
  const scratchHead = { at: 1000, hand: 'right', wiggle: 0.015, hz: 4, keys: [
    { t: 600, w: [-0.05, -0.82, -0.05], e: [-0.25, -0.65, 0] }, { t: 1500 }, { t: 2100, w: W('right', 'w'), e: W('right', 'e') }] };
  const waveHigh = { at: 1000, hand: 'left', wiggle: 0.15, hz: 2.2, keys: [
    { t: 500, w: [0.25, -0.95, -0.1], e: [0.3, -0.72, -0.05] }, { t: 2500 }, { t: 3000, w: W('left', 'w'), e: W('left', 'e') }] };
  const fidget = [{ at: 1000, hand: 'left', wiggle: 0.03, hz: 6, keys: [{ t: 400, w: [0.06, -0.15, -0.25], e: [0.16, -0.25, -0.05] }, { t: 2400 }] },
    { at: 1000, hand: 'right', wiggle: 0.03, hz: 5, keys: [{ t: 400, w: [-0.06, -0.15, -0.25], e: [-0.16, -0.25, -0.05] }, { t: 2400 }] }];
  const stretch = [{ at: 1000, hand: 'left', keys: [{ t: 700, w: [0.2, -1.05, 0], e: [0.22, -0.78, 0] }, { t: 1500 }, { t: 2200, w: W('left', 'w'), e: W('left', 'e') }] },
    { at: 1000, hand: 'right', keys: [{ t: 700, w: [-0.2, -1.05, 0], e: [-0.22, -0.78, 0] }, { t: 1500 }, { t: 2200, w: W('right', 'w'), e: W('right', 'e') }] }];
  for (const seed of [9, 10]) {
    for (const [name, script, ms] of [['scratch head', [scratchHead], 3500], ['wave', [waveHigh], 4300], ['fidget', fidget, 3800], ['stretch', stretch, 3600]]) {
      const ev = recognise(render(script, ms, seed));
      assert(ev.length === 0, `${name} (seed ${seed}) fired ${JSON.stringify(ev)}`);
    }
  }
});

test('irregular: no world-depth compression at all (tracker with honest depth) still works', () => {
  const ev = recognise(render([jab(1200), cross(1700), lazyHook(2600), bodyJab(3700)], 4600, 11, { zComp: 1.0 }));
  assert.deepEqual(ev.map((p) => p.hand), ['left', 'right', 'right', 'left'], JSON.stringify(ev));
});
