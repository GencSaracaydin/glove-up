// view3d-repair-polish (polish round) — R8, the live camera's lean language: the reference keeps a LEVEL horizon and
// SLIDES the view sideways on a lean, its own see-through head in view near the top; a lean to the
// left is the mirror image of a lean to the right (the user: the left dodge felt out of character,
// the right one good); a webcam player's lean noise must not shake the view; the slide is a share of
// each view's width; the versus keep-in turn is damped. Node, the real boxer models and CameraRig (no
// WebGL). Screen positions are percentages of the viewport's width / height; versus halves are drawn
// as renderer._drawSplit draws them (half width − 2 px, the versus fov).
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { CameraRig, RIG_TUNING, leanSlide, leanDeadzone, viewportFollowScale } from '../../src/render/camera-rig.js';
import { BoxerModel, placeBoxer, headWorldPosition, bodyWorldPosition } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';
import { RENDER_TUNING } from '../../src/render/renderer.js';
import { MatchPhase } from '../../src/core/types.js';

const DT = 1 / 60;
const HANDS = {
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
};
const VIEWS = {
  '16:9': { aspect: 16 / 9, versus: false }, '21:9': { aspect: 2560 / 1080, versus: false }, '4:3': { aspect: 4 / 3, versus: false },
  'half 1280×720': { aspect: 638 / 720, versus: true }, 'half 1920×1080': { aspect: 958 / 1080, versus: true }, 'half 1024×768': { aspect: 510 / 768, versus: true },
};
const SINGLE = VIEWS['16:9'];
const other = (id) => (id === 'p1' ? 'p2' : 'p1');
const L = (x, y = 0, z = 0) => ({ x, y, z });
const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: L(0), hands: null, punch: null, punches: null, windup: null, hitReact: null, isHuman: false, hp01: 1, hp: 10, expression: 'neutral', ...o });
const deg = (r) => (r * 180) / Math.PI;

/**
 * Both boxers staged the way the renderer stages them (the human's lean is its model's own lean plus
 * the renderer's root sidestep); `step(dt, myLean, foeView, foeLean)` animates a frame.
 */
function fighters({ me = 'p1', hands = 'high', lean = L(0), foeLean = L(0), settle = 1.2 } = {}) {
  const m = { me, foe: other(me) };
  m[me] = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 });
  m[m.foe] = new BoxerModel(PRESETS[11], { seed: 2 });
  placeBoxer(m.p1, 'p1'); placeBoxer(m.p2, 'p2');
  const base = { p1: m.p1.object3d.position.clone(), p2: m.p2.object3d.position.clone() };
  m.p1.setFoe(m.p2); m.p2.setFoe(m.p1);
  const right = { p1: new THREE.Vector3(1, 0, 0), p2: new THREE.Vector3(-1, 0, 0) };
  const fwd = { p1: new THREE.Vector3(0, 0, -1), p2: new THREE.Vector3(0, 0, 1) };
  const place = (id, ln) => m[id].object3d.position.copy(base[id]).addScaledVector(right[id], ln.x * RENDER_TUNING.leanRootShift).addScaledVector(fwd[id], ln.z * RENDER_TUNING.leanFwdShift);
  const dodge = (ln) => (Math.abs(ln.x) >= 0.42 || ln.y <= -0.42 ? 'dodge' : 'idle');
  m.myView = (ln) => view({ isHuman: true, hands: HANDS[hands], guard: hands === 'idle' ? 'none' : 'high', lean: { ...ln }, phase: dodge(ln) });
  m.foeView = (ln) => view({ guard: 'high', lean: { ...ln }, phase: dodge(ln) });
  m.step = (dt, ln, fv, fl) => {
    place(me, ln); place(m.foe, fl);
    m[me].update(m.myView(ln), dt); m[m.foe].update(fv ?? m.foeView(fl), dt);
    m.p1.object3d.updateWorldMatrix(true, true); m.p2.object3d.updateWorldMatrix(true, true);
  };
  for (let t = 0; t < settle; t += DT) m.step(DT, lean, null, foeLean);
  return m;
}

function ctxFor(m, { versus = false, lean = L(0), foeLean = L(0) } = {}) {
  return {
    mode: 'match', phase: MatchPhase.FIGHTING, phaseTime: 2, stage: 'live', stageTime: 2, versus, downed: null, koLoser: null, winner: null,
    pos: { p1: m.p1.object3d.position.clone(), p2: m.p2.object3d.position.clone() }, yaw: { p1: Math.PI, p2: 0 },
    lean: { [m.me]: { ...lean }, [m.foe]: { ...foeLean } },
    head: { p1: headWorldPosition(m.p1, new THREE.Vector3()), p2: headWorldPosition(m.p2, new THREE.Vector3()) },
    body: { p1: bodyWorldPosition(m.p1, new THREE.Vector3()), p2: bodyWorldPosition(m.p2, new THREE.Vector3()) },
    focus: null, shake: { x: 0, y: 0, roll: 0 },
  };
}
function refresh(m, c) {
  c.pos.p1.copy(m.p1.object3d.position); c.pos.p2.copy(m.p2.object3d.position);
  headWorldPosition(m.p1, c.head.p1); headWorldPosition(m.p2, c.head.p2);
}

/** The live camera after `sec` of a held lean. */
function liveCam(m, { aspect, versus }, { lean = L(0), foeLean = L(0), sec = 1.5, reducedMotion = false } = {}) {
  const rig = new CameraRig({ side: m.me, aspect });
  rig.reducedMotion = reducedMotion;
  const c = ctxFor(m, { versus, lean, foeLean });
  for (let t = 0; t < sec - 1e-9; t += DT) rig.update(DT, c);
  rig.camera.updateMatrixWorld();
  return rig;
}

const project = (p, cam) => { const q = p.clone().project(cam); return { x: (q.x + 1) * 50, y: (1 - q.y) * 50 }; };
const skull = (m, id, cam) => project(headWorldPosition(m[id], new THREE.Vector3()), cam);
const pitchOf = (rig) => { const d = rig.pose.target.clone().sub(rig.pose.pos); return deg(Math.atan2(-d.y, Math.hypot(d.x, d.z))); };
const yawOf = (rig) => { const d = rig.pose.target.clone().sub(rig.pose.pos); return deg(Math.atan2(d.x, -d.z)); };

test('view3d-repair-polish R8: a lean keeps the horizon level — no pitch, no rise, no push-in, no roll (both sides, dodge level and full); the duck and back / forward terms stay', () => {
  const m0 = fighters({ lean: L(0) });
  const rest = liveCam(m0, SINGLE);
  const p0 = pitchOf(rest), y0 = rest.pose.pos.y, z0 = rest.pose.pos.z; // P1 faces −Z: a push toward the opponent lowers z
  for (const name of ['16:9', '21:9', '4:3']) {
    for (const x of [-1, -0.42, 0.42, 1]) {
      const m = fighters({ lean: L(x) });
      const rig = liveCam(m, VIEWS[name], { lean: L(x) });
      const dp = pitchOf(rig) - p0, rise = rig.pose.pos.y - y0, push = z0 - rig.pose.pos.z;
      assert(Math.abs(dp) <= 3, `${name} lean ${x}: pitch changes ${dp.toFixed(2)}° (≤ 3°; BASE 16:9: +9.2° at −0.42, +12.6° at −1)`);
      assert(rise <= 0.1, `${name} lean ${x}: the camera rises ${rise.toFixed(3)} m (≤ 0.10; BASE: 0.27 / 0.35)`);
      assert(push <= 0.15, `${name} lean ${x}: the camera pushes ${push.toFixed(3)} m toward the opponent (≤ 0.15; BASE: 0.42 / 0.55)`);
      assert.equal(rig.pose.roll, 0, `${name} lean ${x}: no head-tilt roll (a level horizon)`);
    }
  }
  // the separate duck / rise and back / forward terms are unchanged
  const F = RIG_TUNING.play.follow;
  const duck = liveCam(m0, SINGLE, { lean: L(0, -1, 0) }), lean = liveCam(m0, SINGLE, { lean: L(0, 0, 1) });
  assert(Math.abs(duck.pose.pos.y - (y0 - F.duck)) < 1e-3, `a full duck drops the camera ${F.duck} m (${(y0 - duck.pose.pos.y).toFixed(3)})`);
  assert(Math.abs(z0 - lean.pose.pos.z - F.z) < 1e-3, `a full forward lean moves the camera ${F.z} m (${(z0 - lean.pose.pos.z).toFixed(3)})`);
});

test('view3d-repair-polish R8: at the dodge level the own see-through head stays in frame near the top (as in the reference), and the rest framing is unchanged', () => {
  const m0 = fighters({ lean: L(0) });
  const rest = liveCam(m0, SINGLE).camera;
  const f0 = skull(m0, 'p2', rest), o0 = skull(m0, 'p1', rest);
  assert(Math.abs(f0.x - 49.3) < 1.5 && Math.abs(f0.y - 28) < 1.5, `rest: the opponent's head at ${f0.x.toFixed(1)} %, ${f0.y.toFixed(1)} % (≈ 49 %, 28 %)`);
  assert(Math.abs(o0.x - 65.5) < 1.5 && Math.abs(o0.y - 22) < 2.5, `rest: the own head at ${o0.x.toFixed(1)} %, ${o0.y.toFixed(1)} % (≈ 66 %, 20–23 %)`);
  for (const hands of ['idle', 'high']) {
    const m = fighters({ hands, lean: L(-0.42) });
    const cam = liveCam(m, SINGLE, { lean: L(-0.42) }).camera;
    const o = skull(m, 'p1', cam);
    // the head's own radius on screen (≈ 11 % of the width): its left part must still be in frame
    const edge = headWorldPosition(m.p1, new THREE.Vector3()).applyMatrix4(cam.matrixWorldInverse);
    const rPct = (0.17 / -edge.z) / Math.tan((29 * Math.PI) / 180) / (16 / 9) * 50;
    assert(o.x - rPct < 100, `${hands}: the own head (centre ${o.x.toFixed(1)} %, radius ≈ ${rPct.toFixed(1)} %) has left the frame (BASE: 106.6 %, 50 % down)`);
    assert(o.y <= 35, `${hands}: the own head ${o.y.toFixed(1)} % down — near the top (BASE: 50 %)`);
  }
});

test('view3d-repair-polish R8: a webcam player\'s lean noise does not shake the view (camera-only soft deadzone, level camera; combat\'s lean untouched)', () => {
  // a deterministic webcam-like lean at 30 Hz, rendered at 60 fps: small jitter around upright (the real
  // facecam clip: half its frames within ±0.02), a drifting half lean toward the camera's own side with
  // jitter on top, and three real dodges
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const series = [];
  for (let i = 0; i < 30 * 12; i++) {
    const dodge = [[60, 75], [150, 168], [260, 270]].some(([a, b]) => i >= a && i < b);
    const drift = i >= 190 && i < 240 ? -0.3 : 0;
    series.push(dodge ? -1 : drift + rnd() * (drift ? 0.06 : 0.04));
  }
  const m = fighters({ lean: L(0) });
  const runSeries = (sign) => {
    const rig = new CameraRig({ side: 'p1', aspect: 16 / 9 });
    const c = ctxFor(m);
    for (let t = 0; t < 1; t += DT) rig.update(DT, c);
    const r = { pitchTotal: 0, rise: 0, yawQuiet: 0, yawDrift: 0 };
    let prevP = pitchOf(rig), prevY = yawOf(rig);
    const y0 = rig.pose.pos.y;
    for (let f = 0; f < series.length * 2; f++) {
      const i = f >> 1;
      c.lean.p1 = L(sign * series[i]);
      rig.update(DT, c);
      const p = pitchOf(rig), y = yawOf(rig);
      r.pitchTotal += Math.abs(p - prevP); r.rise = Math.max(r.rise, Math.abs(rig.pose.pos.y - y0));
      const settled = !series.slice(Math.max(0, i - 15), i + 1).some((v) => v <= -0.5) && (i < 190 || i >= 255);
      if (settled) r.yawQuiet += Math.abs(y - prevY);
      if (i >= 200 && i < 240) r.yawDrift += Math.abs(y - prevY);
      prevP = p; prevY = y;
    }
    return r;
  };
  const own = runSeries(1), mirrored = runSeries(-1);
  assert(own.pitchTotal < 0.5, `the pitch moves ${own.pitchTotal.toFixed(2)}° in all (a level camera; BASE: ≈ 103° on a series like this)`);
  assert(own.rise < 1e-6, `the camera's height moves ${(own.rise * 1000).toFixed(2)} mm on sideways leans (BASE: up to 0.35 m)`);
  assert(own.yawQuiet < 0.5, `jitter around upright turns the view ${own.yawQuiet.toFixed(2)}° in all over 12 s (soft deadzone ±0.03–0.15)`);
  // jitter on a held partial lean moves the view as much as on the mirrored lean — no more on the own side
  assert(own.yawDrift < 15 && Math.abs(own.yawDrift - mirrored.yawDrift) <= 0.1 * mirrored.yawDrift, `±0.03 jitter on a held −0.3 lean turns the view ${own.yawDrift.toFixed(1)}° in 1.3 s (on +0.3: ${mirrored.yawDrift.toFixed(1)}°)`);
  // the deadzone itself: nothing below 0.03, the dodge level and above untouched, monotonic
  assert.equal(leanDeadzone(0.02), 0); assert.equal(leanDeadzone(-0.03), 0);
  assert.equal(leanDeadzone(0.42), 0.42); assert.equal(leanDeadzone(-1), -1);
  let prev = 0;
  for (let v = 0; v <= 1.0001; v += 0.01) { const d = leanDeadzone(v); assert(d >= prev - 1e-12 && d <= v + 1e-12, `monotonic, never above the lean (${v.toFixed(2)} → ${d})`); prev = d; }
});

test('view3d-repair-polish R8: a full lean slides the opponent 1/4–1/3 of the view and a dodge-level lean at least 1/5 — both sides, 16:9, 21:9, 4:3 and versus halves', () => {
  for (const [name, vp] of Object.entries(VIEWS)) {
    const m0 = fighters({ lean: L(0) });
    const x0 = skull(m0, 'p2', liveCam(m0, vp).camera).x;
    for (const [x, lo, hi] of [[-1, 25, 33.4], [1, 25, 33.4], [-0.42, 20, 33.4], [0.42, 20, 33.4]]) {
      const m = fighters({ lean: L(x) });
      const s = Math.abs(skull(m, 'p2', liveCam(m, vp, { lean: L(x) }).camera).x - x0);
      assert(s >= lo && s <= hi, `${name} lean ${x}: the opponent slides ${s.toFixed(1)} % of the width (want ${lo}–${hi} %; BASE 21:9 right: 24.8 / 18.4 %)`);
    }
  }
});

test('view3d-repair-polish R8: a dodge reaches ≥ 94 % of its on-screen slide within 0.15 s (§2.5) — the dodge level, 0.7 and full, both sides (BASE at ±0.42: 91.8–93.2 %)', () => {
  const m = fighters({ lean: L(0) });
  for (const vp of [SINGLE, VIEWS['half 1280×720'], VIEWS['21:9']]) {
    for (const x of [-1, -0.7, -0.42, 0.42, 0.7, 1]) {
      const rig = new CameraRig({ side: 'p1', aspect: vp.aspect });
      const c = ctxFor(m, { versus: vp.versus });
      for (let t = 0; t < 1; t += DT) rig.update(DT, c);
      rig.camera.updateMatrixWorld();
      const x0 = skull(m, 'p2', rig.camera).x;
      c.lean.p1 = L(x);
      for (let i = 0; i < 9; i++) rig.update(DT, c);
      rig.camera.updateMatrixWorld();
      const early = skull(m, 'p2', rig.camera).x - x0;
      for (let t = 0; t < 2; t += DT) rig.update(DT, c);
      rig.camera.updateMatrixWorld();
      const settled = skull(m, 'p2', rig.camera).x - x0;
      assert(early / settled >= 0.94, `aspect ${vp.aspect.toFixed(2)} lean ${x}: ${(100 * early / settled).toFixed(1)} % of the slide within 0.15 s`);
    }
  }
});

test('view3d-repair-polish R8: versus keep-in — the opponent\'s slip, hook or hit reaction turns the view at most 25°/s (BASE 42–126°/s)', () => {
  const hook = (st, p, hand) => ({ id: 1, hand, kind: 'hook', target: 'head', stage: st, progress: p, outcome: null, powerPunch: true });
  const acts = {
    'rear hook': (u) => (u < 0 ? [view({ guard: 'high' }), 0] : u < 0.3 ? [view({ guard: 'high', phase: 'windup', windup: { id: 1, hand: 'right', kind: 'hook', target: 'head', progress: u / 0.3, tell: { pullback: 1, shoulder: 1 } } }), 0]
      : u < 0.6 ? [view({ guard: 'high', phase: 'punch', punches: [hook('travel', (u - 0.3) / 0.3, 'right')], punch: hook('travel', (u - 0.3) / 0.3, 'right') }), 0]
        : u < 1.2 ? [view({ guard: 'high', phase: 'recover', punches: [hook('recover', 1 - (u - 0.6) / 0.6, 'right')], punch: hook('recover', 1 - (u - 0.6) / 0.6, 'right') }), 0] : [view({ guard: 'high' }), 0]),
    'hit by a hook': (u) => [u >= 0 && u < 0.6 ? view({ guard: 'high', phase: 'hit', hitReact: { hand: 'right', kind: 'hook', target: 'head', strength: 1, age: u, blocked: false } }) : view({ guard: 'high' }), 0],
    'slips +1': (u) => { const x = u < 0 ? 0 : u < 1.15 ? Math.min(1, u / 0.15) : u < 1.3 ? 1 - (u - 1.15) / 0.15 : 0; return [view({ guard: 'high', lean: L(x), phase: x >= 0.42 ? 'dodge' : 'idle' }), x]; },
    'slips −1': (u) => { const x = u < 0 ? 0 : u < 1.15 ? -Math.min(1, u / 0.15) : u < 1.3 ? -(1 - (u - 1.15) / 0.15) : 0; return [view({ guard: 'high', lean: L(x), phase: x <= -0.42 ? 'dodge' : 'idle' }), x]; },
  };
  let worst = 0, where = '';
  for (const lean of [1, -1, 0.42]) {
    for (const [name, act] of Object.entries(acts)) {
      const m = fighters({ lean: L(lean), settle: 0.5 });
      const rig = new CameraRig({ side: 'p1', aspect: 638 / 720 });
      const c = ctxFor(m, { versus: true, lean: L(lean) });
      let prev = null;
      for (let t = 0; t < 4; t += DT) {
        const [fv, fx] = act(t - 2);
        m.step(DT, L(lean), fv, L(fx));
        refresh(m, c); c.lean.p2 = L(fx);
        rig.update(DT, c);
        const y = yawOf(rig);
        if (t > 1.5 && prev !== null) { const r = Math.abs(y - prev) / DT; if (r > worst) { worst = r; where = `lean ${lean} / ${name}`; } }
        prev = y;
      }
    }
  }
  assert(worst <= 25, `the view turns up to ${worst.toFixed(1)}°/s (${where})`);
});

test('view3d-repair-polish R8: versus — a full lean by P1 or P2 keeps the opponent\'s skull within 15–85 % of the half and its face in the half', () => {
  for (const name of ['half 1280×720', 'half 1920×1080', 'half 1024×768']) {
    for (const me of ['p1', 'p2']) {
      for (const x of [-1, 1]) {
        const m = fighters({ me, lean: L(x) });
        const cam = liveCam(m, VIEWS[name], { lean: L(x) }).camera;
        const s = skull(m, m.foe, cam);
        assert(s.x >= 15 && s.x <= 85, `${name} ${me} lean ${x}: skull at ${s.x.toFixed(1)} % (want 15–85 %)`);
        // the face (skull ± its radius on screen) stays inside the half
        const r = headWorldPosition(m[m.foe], new THREE.Vector3()).applyMatrix4(cam.matrixWorldInverse);
        const half = Math.tan((RIG_TUNING.play.versusFov * Math.PI) / 360) * VIEWS[name].aspect;
        const rPct = (0.15 / -r.z) / half * 50;
        assert(s.x - rPct >= -1 && s.x + rPct <= 101, `${name} ${me} lean ${x}: the face (${s.x.toFixed(1)} ± ${rPct.toFixed(1)} %) leaves the half`);
      }
    }
  }
});

test('view3d-repair-polish R8: the single view keeps the opponent\'s face in frame when both lean the same way and in portrait views at a full lean (soft keep-in)', () => {
  const inFrame = (m, cam) => { const s = skull(m, 'p2', cam); return s.x >= 4 && s.x <= 96; };
  // the AI slips to its right while the player holds D (BASE: the skull at 0.8 %, 39 % of the face in frame)
  const both = fighters({ lean: L(1), foeLean: L(1) });
  const cam = liveCam(both, SINGLE, { lean: L(1), foeLean: L(1) }).camera;
  assert(skull(both, 'p2', cam).x >= 5, `both lean right: skull at ${skull(both, 'p2', cam).x.toFixed(1)} % (BASE 0.8 %)`);
  for (const [name, aspect] of [['9:16', 9 / 16], ['390×844', 390 / 844]]) {
    for (const x of [-1, 1]) {
      const m = fighters({ lean: L(x) });
      const c = liveCam(m, { aspect, versus: false }, { lean: L(x) }).camera;
      assert(inFrame(m, c), `${name} lean ${x}: skull at ${skull(m, 'p2', c).x.toFixed(1)} % (BASE 390×844 −1: 96 %)`);
    }
  }
  // the keep-in never turns a 16:9 / 21:9 / 4:3 single view at rest or on a single lean
  for (const vp of [SINGLE, VIEWS['21:9'], VIEWS['4:3']]) {
    for (const x of [-1, -0.42, 0, 0.42, 1]) {
      const rig = liveCam(fighters({ lean: L(x) }), vp, { lean: L(x) });
      assert(Math.abs(rig._keep.yaw) < 1e-6, `aspect ${vp.aspect.toFixed(2)} lean ${x}: the single-view keep-in turned ${deg(rig._keep.yaw).toFixed(2)}°`);
    }
  }
});

test('view3d-repair-polish R8: the right lean keeps its camera position and turn (16:9, 4:3, versus halves); only its look target now stays at the rest distance (level)', () => {
  const F = RIG_TUNING.play.follow, P = RIG_TUNING.play;
  for (const [name, vp] of [['16:9', VIEWS['16:9']], ['4:3', VIEWS['4:3']], ['half', VIEWS['half 1280×720']]]) {
    const fov = vp.versus ? P.versusFov : P.fov;
    const v = viewportFollowScale(fov, vp.aspect);
    for (const x of [0.21, 0.42, 0.7, 1]) {
      const m = fighters({ lean: L(x) });
      const rig = liveCam(m, vp, { lean: L(x), sec: 3 });
      const lx = leanSlide(leanDeadzone(x), F.knee, F.kneeGain + F.kneeNarrow * (1 - v));
      // the repair-round (BASE) right lean: the camera at offset + lx·x·v, looking at lookAt + lx·lookX·v
      const cx = P.offset[0] + lx * F.x * v;
      const yawBase = deg(Math.atan2(P.lookAt[0] + lx * F.lookX * v - cx, P.lookAt[2] + P.offset[2]));
      const keep = deg(rig._keep.yaw);
      assert(Math.abs(rig.pose.pos.x - cx) < 1e-6, `${name} lean ${x}: the camera at ${rig.pose.pos.x.toFixed(4)} (BASE ${cx.toFixed(4)})`);
      assert(Math.abs(yawOf(rig) - keep - yawBase) < 1e-3, `${name} lean ${x}: the view turned to ${(yawOf(rig) - keep).toFixed(3)}° (BASE ${yawBase.toFixed(3)}°)`);
    }
  }
});

test('view3d-repair-polish R8: a left lean mirrors a right one — slide and look-at shift within 10 %, yaw and pitch within 1°, forward / back and height within 2 cm (held and quick slips, 0.42 / 0.7 / 1, single view and versus halves, P1 and P2)', () => {
  const RIGHT = { p1: new THREE.Vector3(1, 0, 0), p2: new THREE.Vector3(-1, 0, 0) }, FWD = { p1: new THREE.Vector3(0, 0, -1), p2: new THREE.Vector3(0, 0, 1) };
  const poseOf = (rig, me) => {
    const p = rig.pose.pos, t = rig.pose.target, d = t.clone().sub(p);
    return { x: p.dot(RIGHT[me]), f: p.dot(FWD[me]), y: p.y, tx: t.dot(RIGHT[me]), yaw: deg(Math.atan2(d.dot(RIGHT[me]), d.dot(FWD[me]))), pitch: deg(Math.atan2(-d.y, Math.hypot(d.x, d.z))) };
  };
  const keyRamp = (a, hold) => { let x = 0; return (t) => { x += ((t < hold ? a : 0) - x) * (1 - Math.exp(-DT / 0.07)); return x; }; };
  const run = (me, vp, xOf, sec) => {
    const m = fighters({ me, lean: L(0), settle: 0.6 });
    const rig = new CameraRig({ side: me, aspect: vp.aspect });
    const c = ctxFor(m, { versus: vp.versus });
    for (let t = 0; t < 1; t += DT) { m.step(DT, L(0), null, L(0)); refresh(m, c); rig.update(DT, c); }
    const rest = poseOf(rig, me), rows = [];
    for (let t = 0; t < sec - 1e-9; t += DT) {
      const x = xOf(t);
      m.step(DT, L(x), null, L(0)); refresh(m, c); c.lean[me] = L(x); rig.update(DT, c);
      const q = poseOf(rig, me);
      rows.push({ slide: q.x - rest.x, look: q.tx - rest.tx, yaw: q.yaw - rest.yaw, pitch: q.pitch - rest.pitch, fwd: q.f - rest.f, h: q.y - rest.y });
    }
    return rows;
  };
  for (const [name, vp] of [['16:9', VIEWS['16:9']], ['half 1280×720', VIEWS['half 1280×720']]]) {
    for (const me of ['p1', 'p2']) {
      for (const a of [0.42, 0.7, 1]) {
        for (const [kind, mk, sec] of [['held', (s) => () => s * a, 1.4], ['slip', (s) => keyRamp(s * a, 0.25), 0.8]]) {
          const R = run(me, vp, mk(1), sec), Lr = run(me, vp, mk(-1), sec);
          const pk = (k) => Math.max(...R.map((r) => Math.abs(r[k])));
          for (let i = 0; i < R.length; i++) {
            const tag = `${name} ${me} ${kind} ${a} frame ${i}`;
            assert(Math.abs(Lr[i].slide + R[i].slide) <= 0.1 * pk('slide') + 1e-9, `${tag}: slide R ${R[i].slide.toFixed(3)} L ${Lr[i].slide.toFixed(3)}`);
            assert(Math.abs(Lr[i].look + R[i].look) <= 0.1 * pk('look') + 1e-9, `${tag}: look-at shift R ${R[i].look.toFixed(3)} L ${Lr[i].look.toFixed(3)}`);
            assert(Math.abs(Lr[i].yaw + R[i].yaw) <= 1, `${tag}: yaw R ${R[i].yaw.toFixed(2)}° L ${Lr[i].yaw.toFixed(2)}°`);
            assert(Math.abs(Lr[i].pitch - R[i].pitch) <= 1, `${tag}: pitch R ${R[i].pitch.toFixed(2)}° L ${Lr[i].pitch.toFixed(2)}°`);
            assert(Math.abs(Lr[i].fwd - R[i].fwd) <= 0.02 && Math.abs(Lr[i].h - R[i].h) <= 0.02, `${tag}: forward ${R[i].fwd.toFixed(3)} / ${Lr[i].fwd.toFixed(3)}, height ${R[i].h.toFixed(3)} / ${Lr[i].h.toFixed(3)} m`);
          }
          if (kind === 'held') assert(Math.abs(R.at(-1).yaw) > 5 && R.at(-1).slide > 0.1, `${name} ${me} ${a}: the lean does move the view (yaw ${R.at(-1).yaw.toFixed(1)}°, slide ${R.at(-1).slide.toFixed(2)} m)`);
        }
      }
    }
  }
});
