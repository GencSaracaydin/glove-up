// view3d-repair-polish (polish round) — R11, the player's own boxer follows the tracked body with little lag and
// accurately (the user: "getting the lag lower, tracking more accurate"). Node, the real BoxerModel.
// The human boxer's springs run stiff while its input moves and calm while it holds still (a
// one-euro style tracking filter, ANIM.track); its gloves sit where HandState puts them (no 12 %
// pull toward the stance, no 70 % pull toward a drawn guard pose); punches, hit reactions, falls and
// every AI boxer keep the springs they had. "BASE-equivalent" below = the same model with the
// repair round's tuning put back (ANIM: default springs for the human, hands weight 0.88, the guard
// pulling the gloves 0.7), so the comparisons need no second tree.
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { BoxerModel, placeBoxer, gloveWorldPosition, headWorldPosition, ANIM, BODY } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';

const DT = 1 / 60;
const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, punches: null, windup: null, hitReact: null, isHuman: false, hp01: 1, hp: 10, expression: 'neutral', ...o });
const human = (hands, o = {}) => view({ isHuman: true, hands, ...o });
const HANDS = {
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
  camHigh: { left: { x: -0.16, y: 0.45, reach: 0.15 }, right: { x: 0.19, y: 0.37, reach: 0.19 } },
  camMid: { left: { x: -0.22, y: 0.25, reach: 0.1 }, right: { x: 0.24, y: 0.2, reach: 0.12 } },
  peek: { left: { x: -0.08, y: 0.5, reach: 0.02 }, right: { x: 0.1, y: 0.5, reach: 0.02 } },
  wide: { left: { x: -0.45, y: 0.3, reach: 0.2 }, right: { x: 0.5, y: 0.35, reach: 0.25 } },
};
const make = (ai = false) => { const m = new BoxerModel(ai ? PRESETS[11] : DEFAULT_PLAYER, { ghost: !ai, seed: ai ? 2 : 1 }); placeBoxer(m, ai ? 'p2' : 'p1'); return m; };

/**
 * Run `fn` with the repair round's (BASE's) tuning for the human boxer put back. (On the repair-round
 * tree itself, which has no tracking filter, it just runs `fn`: there these tests fail on their
 * absolute bounds — lag, accuracy — not on a missing API.)
 */
function withBase(fn) {
  if (!ANIM.track) return fn();
  const keep = { ...ANIM, track: ANIM.track };
  Object.assign(ANIM, { wGloveHuman: ANIM.wGlove, wHeadHuman: ANIM.wHead, wSpineHuman: ANIM.wSpine, wBodyHuman: ANIM.wBody, handsWeightHuman: 0.88, guardGloveHuman: 0.7 });
  ANIM.track = { ...ANIM.track, still: { glove: ANIM.wGlove, guardGlove: ANIM.wGlove, head: ANIM.wHead, spine: ANIM.wSpine, body: ANIM.wBody }, rate: { ...ANIM.track.rate, below: Infinity } };
  try { return fn(); } finally { Object.assign(ANIM, keep); }
}

const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
/** Where HandState puts a glove: boxer-model's hands → spine-space mapping, through the rendered spine. */
function handTarget(m, h) {
  const sw = BODY.shoulderX * 2;
  const zGuard = 0.17 + (ANIM.guardZ - 0.17) * smooth((h.y + 1.2) / 1.4);
  const p = new THREE.Vector3(-h.x * sw * ANIM.handScaleX, BODY.shoulderY + h.y * sw * ANIM.handScaleY, zGuard + (ANIM.reachZ - zGuard) * smooth(h.reach));
  m.object3d.updateWorldMatrix(true, true);
  return p.applyMatrix4(m._spine.matrixWorld);
}
const gloveAt = (m, hand) => gloveWorldPosition(m, hand, new THREE.Vector3());

/**
 * Steady-state ramp lag (ms) of a channel: the model fed the ramp (every frame, or `hz` camera samples
 * held between frames) against the same model with every spring snapped to its target (the instant
 * pose of the same held input).
 */
function rampLag(feed, read, { dur, settle = 0.3, hz = 60 }) {
  const m = make(), ref = make();
  const pairs = [];
  let held = null, next = 0;
  for (let t = 0; t < 0.5 + dur; t += DT) {
    if (t + 1e-9 >= next) { held = feed(Math.min(dur, Math.max(0, t - 0.5))); next += 1 / hz; }
    const v = held;
    m.update(v, DT); ref.update(v, DT); ref._snapSprings(ref._tgt); ref._applyPose();
    if (t > 0.5 + settle && t < 0.5 + dur - 0.02) pairs.push([read(ref), read(m)]);
  }
  const n = pairs.length; let d = 0; for (const p of pairs) d += p[0] - p[1];
  return ((d / n) / ((pairs[n - 1][0] - pairs[0][0]) / ((n - 1) * DT))) * 1000;
}

// input round (merge-refix): the measured head / spine / hips bound stays 65 ms; the springs' own 2/ω bound for the spine and
// the hips is 70 ms (it was 65): the merged recognizer's lean comes 10 ms earlier (R4's leanLead: 14 → 4 ms), which pays for
// wSpineHuman / wBodyHuman 31 / 30 (polish 36 / 32) with the total lean lag still under the polish build's (boxer-model.js).
test('view3d-repair-polish R11: the human boxer\'s rendered ramp lag at 60 Hz and 30 Hz input — gloves ≤ 45 ms from 0.12 m/s (a held guard from 0.23 m/s), head / spine / hips ≤ 65 ms from a 0.5/s lean (BASE: 61–75 / 121–161 ms); slower drifts stay within ≈ 1 cm', () => {
  const sw = BODY.shoulderX * 2;
  for (const hz of [60, 30]) {
    for (const [sp, guard] of [[0.3, 'none'], [0.45, 'none'], [0.8, 'none'], [1.2, 'none'], [2.5, 'none'], [0.6, 'high'], [1.2, 'high']]) { // shoulder widths / s (0.12–1 m/s)
      const dur = 1.5 / sp;
      const ramp = (u) => human({ left: { x: -0.2, y: -0.6 + sp * u, reach: 0.1 }, right: { x: 0.2, y: 0.1, reach: 0.1 } }, { guard });
      const lag = rampLag(ramp, (m) => gloveAt(m, 'left').y, { dur, hz });
      const base = withBase(() => rampLag((u) => human({ left: { x: -0.2, y: -0.6 + sp * u, reach: 0.1 }, right: { x: 0.2, y: 0.1, reach: 0.1 } }), (m) => gloveAt(m, 'left').y, { dur, hz }));
      assert(lag <= 45, `${hz} Hz, a hand raise at ${(sp * sw).toFixed(2)} m/s (guard ${guard}): the glove lags ${lag.toFixed(1)} ms (BASE-equivalent ${base.toFixed(1)} ms)`);
      assert(base > 55, `the BASE-equivalent tuning lags ${base.toFixed(1)} ms (the case is real)`);
    }
    for (const rate of [0.5, 1, 3]) { // lean units / s: a slow lean to a dodge
      const dur = 2 / rate;
      const lean = (u) => human(HANDS.high, { guard: 'high', lean: { x: 1 - rate * u, y: 0, z: 0 } });
      const lags = {
        head: rampLag(lean, (m) => headWorldPosition(m, new THREE.Vector3()).x, { dur, hz }),
        hips: rampLag(lean, (m) => m._sp.hipsPos.x.x, { dur, hz }),
        spine: rampLag(lean, (m) => m._sp.spineRot.x.z, { dur, hz }),
      };
      for (const [k, v] of Object.entries(lags)) assert(v <= 65, `${hz} Hz, a lean at ${rate}/s: the ${k} lags ${v.toFixed(1)} ms`);
    }
    // drifts as slow as tracking noise (0.06 m/s; a held guard 0.12 m/s) are smoothed like a still pose:
    // more lag in time, but the glove stays within about a centimetre of the hand (BASE: 4–9 mm)
    for (const [sp, guard] of [[0.15, 'none'], [0.3, 'high']]) {
      const dur = 3;
      const lag = rampLag((u) => human({ left: { x: -0.2, y: -0.6 + sp * u, reach: 0.1 }, right: { x: 0.2, y: 0.1, reach: 0.1 } }, { guard }), (m) => gloveAt(m, 'left').y, { dur, hz, settle: 1 });
      const mm = lag * sp * sw;
      assert(mm <= 12, `${hz} Hz, a ${(sp * sw).toFixed(2)} m/s drift (guard ${guard}): the glove ${mm.toFixed(1)} mm behind (${lag.toFixed(0)} ms)`);
    }
  }
  // the springs themselves (2/ω): the stiff ends
  assert(2000 / ANIM.wGloveHuman <= 45 && 2000 / ANIM.wHeadHuman <= 65 && 2000 / ANIM.wSpineHuman <= 70 && 2000 / ANIM.wBodyHuman <= 70, 'stiff springs: 2/ω within the bounds');
});

test('view3d-repair-polish R11: with no punch running, the rendered gloves sit within 2 cm of where HandState puts them — guard included (BASE: up to 16 cm with a guard)', () => {
  let worst = 0, worstBase = 0;
  for (const [name, hs] of Object.entries(HANDS)) {
    for (const guard of ['none', 'high', 'low']) {
      for (const lx of [0, -0.6, 0.6]) {
        const v = human(hs, { guard, lean: { x: lx, y: 0, z: 0 }, phase: Math.abs(lx) >= 0.42 ? 'dodge' : guard === 'none' ? 'idle' : 'guard' });
        const m = make();
        for (let t = 0; t < 1.5; t += DT) m.update(v, DT);
        for (const hand of ['left', 'right']) {
          const d = gloveAt(m, hand).distanceTo(handTarget(m, hs[hand])) * 100;
          worst = Math.max(worst, d);
          assert(d <= 2, `${name} guard ${guard} lean ${lx}: the ${hand} glove ${d.toFixed(2)} cm from its hand`);
        }
        worstBase = Math.max(worstBase, withBase(() => { const b = make(); for (let t = 0; t < 1.5; t += DT) b.update(v, DT); return Math.max(...['left', 'right'].map((h) => gloveAt(b, h).distanceTo(handTarget(b, hs[h])) * 100)); }));
      }
    }
  }
  assert(worstBase > 5, `the BASE-equivalent tuning puts a glove ${worstBase.toFixed(1)} cm off (the case is real)`);
});

test('view3d-repair-polish R11: 30 Hz and 15 Hz input at 60 fps — no visible stepping: the per-frame travel varies ≤ 15 % within an input sample, or ≤ 1.3 × the BASE-equivalent', () => {
  const bob = [ANIM.bobAmp, ANIM.swayAmp];
  ANIM.bobAmp = 0; ANIM.swayAmp = 0;
  try {
    const modulation = (hz, sp) => {
      const m = make();
      let held = null, next = 0, prev = null, prevH = null;
      const g = [], h = [];
      for (let i = 0; i < 100; i++) {
        const t = i * DT;
        const v = human({ left: { x: -0.2, y: -0.6 + sp * t, reach: 0.1 }, right: { x: 0.2, y: 0.1, reach: 0.1 } }, { lean: { x: -Math.min(1, 0.6 * t), y: 0, z: 0 } });
        if (t + 1e-9 >= next) { held = v; next += 1 / hz; }
        m.update(held, DT);
        const gp = gloveAt(m, 'left'), hp = headWorldPosition(m, new THREE.Vector3());
        if (prev && i > 40 && i < 60) { g.push(gp.distanceTo(prev)); h.push(hp.distanceTo(prevH)); }
        prev = gp; prevH = hp;
      }
      const mod = (a) => (Math.max(...a) - Math.min(...a)) / (a.reduce((x, y) => x + y, 0) / a.length);
      return { glove: mod(g), head: mod(h) };
    };
    for (const hz of [30, 15]) {
      for (const sp of [0.5, 1.5]) {
        const now = modulation(hz, sp), base = withBase(() => modulation(hz, sp));
        // (a 30 Hz alternation of ±7 % in the per-frame travel at 60 fps is not visible; a sample-and-hold
        // staircase without any spring would vary 100 %)
        assert(now.glove <= Math.max(0.15, 1.3 * base.glove), `${hz} Hz, hand ${sp} sw/s: glove travel varies ${(100 * now.glove).toFixed(1)} % within a sample (BASE-equivalent ${(100 * base.glove).toFixed(1)} %)`);
        assert(now.head <= Math.max(0.15, 1.3 * base.head), `${hz} Hz: head travel varies ${(100 * now.head).toFixed(1)} % (BASE-equivalent ${(100 * base.head).toFixed(1)} %)`);
      }
    }
  } finally { [ANIM.bobAmp, ANIM.swayAmp] = bob; }
});

test('view3d-repair-polish R11: a still pose with tracking noise stays as calm as before — gloves and head jitter ≤ 1.5 × BASE-equivalent (no guard and a held guard)', () => {
  // a held pose with webcam-like noise on the hands and the lean (σ ≈ 4 mm, a little correlated, 30 Hz),
  // the model at 60 fps; jitter = mean |2nd difference| of the rendered positions
  const run = (guard, hs) => {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const m = make();
    const n = { lx: 0, ly: 0, rx: 0, ry: 0, r: 0 };
    let held = null;
    const P = { left: [], right: [], head: [] };
    for (let i = 0; i < 60 * 8; i++) {
      if (i % 2 === 0) {
        for (const k of Object.keys(n)) n[k] = 0.5 * n[k] + 0.06 * rnd();
        held = human({ left: { x: hs.left.x + n.lx, y: hs.left.y + n.ly, reach: Math.max(0, hs.left.reach + n.r) }, right: { x: hs.right.x + n.rx, y: hs.right.y + n.ry, reach: hs.right.reach } }, { guard, phase: guard === 'none' ? 'idle' : 'guard', lean: { x: 0.02 * rnd(), y: 0.02 * rnd(), z: 0 } });
      }
      m.update(held, DT);
      if (i > 90) { P.left.push(gloveAt(m, 'left')); P.right.push(gloveAt(m, 'right')); P.head.push(headWorldPosition(m, new THREE.Vector3())); }
    }
    const acc = (a) => { let s = 0; for (let i = 2; i < a.length; i++) s += a[i].clone().sub(a[i - 1]).sub(a[i - 1].clone().sub(a[i - 2])).length(); return (s / (a.length - 2)) * 1000; };
    return { left: acc(P.left), right: acc(P.right), head: acc(P.head) };
  };
  for (const guard of ['none', 'high']) {
    for (const hands of ['high', 'camHigh']) {
      const now = run(guard, HANDS[hands]), base = withBase(() => run(guard, HANDS[hands]));
      for (const k of ['left', 'right', 'head']) assert(now[k] <= 1.5 * base[k], `guard ${guard}, ${hands}: the ${k} jitters ${now[k].toFixed(3)} mm/frame² (BASE-equivalent ${base[k].toFixed(3)})`);
    }
  }
});

test('view3d-repair-polish R11: punches, hit reactions, falls and the AI keep their springs — the tracking filter is off for them', () => {
  // the AI boxer through guard, a wind-up, a hook, a hit and a slip: never tracked, every frame identical
  // with the human tuning changed wildly (it only ever reads the AI's default springs)
  const seq = (t) => {
    const P = (stage, p) => ({ id: 1, hand: 'right', kind: 'hook', target: 'head', stage, progress: p, outcome: stage === 'recover' ? 'blocked' : null, powerPunch: true });
    if (t < 1) return view({ guard: 'high' });
    if (t < 1.4) return view({ guard: 'high', phase: 'windup', windup: { id: 1, hand: 'right', kind: 'hook', target: 'head', progress: (t - 1) / 0.4, tell: { pullback: 1, shoulder: 1 } } });
    if (t < 1.8) return view({ guard: 'high', phase: 'punch', punches: [P('travel', (t - 1.4) / 0.4)], punch: P('travel', (t - 1.4) / 0.4) });
    if (t < 2.4) return view({ guard: 'high', phase: 'recover', punches: [P('recover', 1 - (t - 1.8) / 0.6)], punch: P('recover', 1 - (t - 1.8) / 0.6) });
    if (t < 3) return view({ guard: 'high', phase: 'hitstun', hitReact: { hand: 'left', kind: 'straight', target: 'head', strength: 1, age: t - 2.4, blocked: false } });
    return view({ guard: 'high', lean: { x: Math.min(1, (t - 3) / 0.15), y: 0, z: 0 }, phase: 'dodge' });
  };
  const trace = () => { const m = make(true); const out = []; for (let t = 0; t < 3.6; t += DT) { m.update(seq(t), DT); assert.equal(m._track?.on ?? false, false, 'the AI is never tracked'); out.push(...gloveAt(m, 'right').toArray(), ...headWorldPosition(m, new THREE.Vector3()).toArray()); } return out; };
  const a = trace();
  const keep = { ...ANIM };
  Object.assign(ANIM, { wGloveHuman: 99, wHeadHuman: 99, wSpineHuman: 99, wBodyHuman: 99 });
  let b; try { b = trace(); } finally { Object.assign(ANIM, keep); }
  assert.deepEqual(a, b, 'the AI boxer moves exactly as with any human tuning');

  // the human: a jab (out and back), then a blow to the head (its reaction), then a fall — untracked
  // throughout, and the hit reaction plays exactly as with the default springs
  const human1 = (t) => {
    const J = (stage, p) => ({ id: 2, hand: 'left', kind: 'straight', target: 'head', stage, progress: p, outcome: 'hit', power: 0.5 });
    if (t < 0.5) return human(HANDS.high, { guard: 'high', phase: 'guard' });
    if (t < 0.75) return human(HANDS.high, { phase: 'punch', punches: [J('travel', (t - 0.5) / 0.25)], punch: J('travel', (t - 0.5) / 0.25) });
    if (t < 1.1) return human(HANDS.high, { phase: 'recover', punches: [J('recover', 1 - (t - 0.75) / 0.35)], punch: J('recover', 1 - (t - 0.75) / 0.35) });
    if (t < 1.6) return human(HANDS.high, { guard: 'high', phase: 'guard' });
    if (t < 2.2) return human(HANDS.high, { phase: 'hitstun', hitReact: { hand: 'right', kind: 'hook', target: 'head', strength: 1, age: t - 1.6, blocked: false } });
    if (t < 2.5) return human(HANDS.high, { guard: 'high', phase: 'guard' });
    return human(HANDS.high, { phase: 'down', hitReact: null });
  };
  const m = make();
  const states = [];
  for (let t = 0; t < 3.2; t += DT) { m.update(human1(t), DT); states.push({ t, on: !!m._track?.on, busy: !!m.handBusy?.('left') }); }
  const at = (t0, t1) => states.filter((s) => s.t >= t0 && s.t < t1);
  assert(at(0.2, 0.5).every((s) => s.on), 'tracked in a held guard');
  assert(at(0.52, 0.9).every((s) => !s.on) && states.every((s) => !(s.on && s.busy)), 'a punch out and back: the default springs until the glove is home');
  assert(at(1.6, 2.29).every((s) => !s.on), 'a hit reaction: the default springs');
  assert(at(2.6, 3.2).every((s) => !s.on), 'a fall: the default springs');
  // the head's hit reaction (its world path relative to the rest pose) is the same as with the BASE springs
  const reaction = () => {
    const h = make(); const rest = []; const out = [];
    for (let t = 0; t < 1.2; t += DT) { h.update(human(HANDS.high, { guard: 'high', phase: 'guard' }), DT); rest.push(headWorldPosition(h, new THREE.Vector3())); }
    for (let t = 0; t < 0.7; t += DT) { h.update(human(HANDS.high, { phase: 'hitstun', hitReact: { hand: 'right', kind: 'hook', target: 'head', strength: 1, age: t, blocked: false } }), DT); out.push(headWorldPosition(h, new THREE.Vector3()).sub(rest.at(-1))); }
    return out;
  };
  const r1 = reaction(), r0 = withBase(reaction);
  const dev = Math.max(...r1.map((v, i) => v.distanceTo(r0[i])));
  const amp = Math.max(...r0.map((v) => v.length()));
  assert(amp > 0.01, `the hit snaps the head (${(amp * 100).toFixed(1)} cm)`);
  assert(dev < 0.01 * amp + 1e-4, `the head's hit reaction differs by ${(dev * 1000).toFixed(2)} mm from the default springs' (amplitude ${(amp * 1000).toFixed(1)} mm)`);
});
