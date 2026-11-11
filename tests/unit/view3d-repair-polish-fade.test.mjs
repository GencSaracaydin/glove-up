// view3d-repair-polish (polish round) — R8, a readable opponent face: where the level camera can keep the line of sight
// past the player's own see-through head and solid gloves it does; where geometry can't (the opponent's
// hook lunging toward the camera's own side, a narrow versus half) the viewer's OWN parts fade while
// they overlap the face on screen (render/own-fade.js; BoxerModel.setOwnFade), smoothed over ~80 ms.
// Node, the real models, CameraRig and OwnFade run frame by frame as the renderer runs them; the cover
// is EXACT (mesh ray casts): the opponent's visible face = rays across its skull whose first opponent
// surface is the 'head'-material skull (its own hair, gloves and punching arm in front excluded), under
// an OPAQUE own part = the segment to it crosses an own glove / cuff mesh whose fade leaves it more than
// 0.35 opaque (a glove faded to ≤ 0.35 counts as see-through, as the brief defines it).
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { CameraRig, Shot } from '../../src/render/camera-rig.js';
import { BoxerModel, placeBoxer, headWorldPosition, bodyWorldPosition, OWN_FADE_LOOK } from '../../src/render/boxer-model.js';
import { OwnFade, OWN_FADE, circleCover } from '../../src/render/own-fade.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';
import { RENDER_TUNING, GameRenderer } from '../../src/render/renderer.js';
import { MatchPhase } from '../../src/core/types.js';

const DT = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);
const HANDS = {
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
  camHigh: { left: { x: -0.16, y: 0.45, reach: 0.15 }, right: { x: 0.19, y: 0.37, reach: 0.19 } },
  camMid: { left: { x: -0.22, y: 0.25, reach: 0.1 }, right: { x: 0.24, y: 0.2, reach: 0.12 } },
  peek: { left: { x: -0.08, y: 0.5, reach: 0.02 }, right: { x: 0.1, y: 0.5, reach: 0.02 } },
};
const VIEWS = { '1280×720': 16 / 9, '1920×1080': 16 / 9, '1024×768': 4 / 3, '2560×1080': 2560 / 1080 };
const L = (x, y = 0, z = 0) => ({ x, y, z });
const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: L(0), hands: null, punch: null, punches: null, windup: null, hitReact: null, isHuman: false, hp01: 1, hp: 10, expression: 'neutral', ...o });
const SEE_THROUGH = 0.35;

/** P1 = the player (ghosted), P2 the opponent; `step` animates one frame the way the renderer stages it. */
function fighters({ hands = 'high', lean = 0, settle = 1.2, foePreset = 11 } = {}) {
  const m = { me: 'p1', foe: 'p2' };
  m.p1 = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 });
  m.p2 = new BoxerModel(PRESETS[foePreset], { seed: 2 });
  placeBoxer(m.p1, 'p1'); placeBoxer(m.p2, 'p2');
  const base = m.p1.object3d.position.clone(), base2 = m.p2.object3d.position.clone();
  m.p1.setFoe(m.p2); m.p2.setFoe(m.p1);
  m.mine = (x, extra = {}) => view({ isHuman: true, hands: HANDS[hands], guard: hands === 'idle' ? 'none' : 'high', lean: L(x), phase: Math.abs(x) >= 0.42 ? 'dodge' : 'idle', ...extra });
  // foeX: the opponent's own sideways lean (its root sidestep, as the renderer places it; P2's right is −X)
  m.step = (dt, x, fv = view({ guard: 'high' }), mine = null, foeX = 0) => {
    m.p1.object3d.position.copy(base).x += x * RENDER_TUNING.leanRootShift;
    m.p2.object3d.position.copy(base2).x -= foeX * RENDER_TUNING.leanRootShift;
    m.p1.update(mine ?? m.mine(x), dt); m.p2.update(fv, dt);
    m.p1.object3d.updateWorldMatrix(true, true); m.p2.object3d.updateWorldMatrix(true, true);
  };
  for (let t = 0; t < settle; t += DT) m.step(DT, lean);
  return m;
}

function ctxFor(m, x, versus = false) {
  return {
    mode: 'match', phase: MatchPhase.FIGHTING, phaseTime: 2, stage: 'live', stageTime: 2, versus, downed: null, koLoser: null, winner: null,
    pos: { p1: m.p1.object3d.position.clone(), p2: m.p2.object3d.position.clone() }, yaw: { p1: Math.PI, p2: 0 },
    lean: { p1: L(x), p2: L(0) },
    head: { p1: headWorldPosition(m.p1, new THREE.Vector3()), p2: headWorldPosition(m.p2, new THREE.Vector3()) },
    body: { p1: bodyWorldPosition(m.p1, new THREE.Vector3()), p2: bodyWorldPosition(m.p2, new THREE.Vector3()) },
    focus: null, shake: { x: 0, y: 0, roll: 0 },
  };
}
const refresh = (m, c) => { c.pos.p1.copy(m.p1.object3d.position); c.pos.p2.copy(m.p2.object3d.position); headWorldPosition(m.p1, c.head.p1); headWorldPosition(m.p2, c.head.p2); };

/** A live rig + fade driven frame by frame (as GameRenderer.renderMatch → _updateOwnFade). */
function live(m, aspect, x, versus = false) {
  const rig = new CameraRig({ side: 'p1', aspect });
  const fade = new OwnFade();
  const c = ctxFor(m, x, versus);
  const frame = (dt) => {
    refresh(m, c);
    rig.update(dt, c);
    rig.camera.updateMatrixWorld();
    const v = fade.update(dt, rig.camera, m.p1, m.p2, rig.ownShift);
    m.p1.setOwnFade(v);
    return v;
  };
  return { rig, fade, c, frame };
}

const meshes = (root, keep = () => true) => { const a = []; root.traverse((o) => { if (o.isMesh && o.visible && keep(o)) a.push(o); }); return a; };
const _ray = new THREE.Raycaster();
/**
 * Exact cover of the opponent's visible face: {n visible face points, opaque: share under opaque own
 * gloves, head: share under the own see-through head}. A glove counts as opaque while its material
 * (BoxerModel.setOwnFade) is more than 0.35 opaque.
 */
function exactCover(m, cam, N = 8) {
  // what can stand between the lens and the opponent's face: its head (skull, hair, ears) and its arms
  const opp = [...meshes(m.p2._head), ...meshes(m.p2.object3d, (o) => /^(shoulder|upperArm|foreArm|glove|thumb|cuff|cuffBand)$/.test(o.name))];
  const skull = meshes(m.p2._skull, (o) => o.userData.mat === 'head')[0];
  skull.geometry.computeBoundingSphere();
  const bs = skull.geometry.boundingSphere.clone().applyMatrix4(skull.matrixWorld);
  const opaque = meshes(m.p1.object3d, (o) => (o.userData.mat === 'gloves' || o.userData.mat === 'cuff') && o.material.opacity > SEE_THROUGH);
  const head = meshes(m.p1._head);
  const ahead = bs.center.clone().sub(cam.position).normalize();
  const u = new THREE.Vector3().crossVectors(ahead, UP).normalize(), w = new THREE.Vector3().crossVectors(u, ahead);
  let n = 0, op = 0, hd = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const a = (2 * i) / N - 1, b = (2 * j) / N - 1;
    if (a * a + b * b > 1) continue;
    const aim = bs.center.clone().addScaledVector(u, a * bs.radius).addScaledVector(w, b * bs.radius);
    _ray.set(cam.position, aim.sub(cam.position).normalize()); _ray.near = 0; _ray.far = Infinity;
    const first = _ray.intersectObjects(opp, false)[0];
    if (!first || first.object.userData.mat !== 'head') continue;
    n++;
    _ray.far = first.distance - 1e-4;
    if (opaque.length && _ray.intersectObjects(opaque, false).length) op++;
    if (_ray.intersectObjects(head, false).length) hd++;
  }
  const d = Math.max(1, n);
  return { n, opaque: op / d, head: hd / d };
}

const pct = (v) => `${Math.round(v * 100)} %`;

test('view3d-repair-polish R8: circleCover — the share of the face circle a part covers', () => {
  assert.equal(circleCover(0, 0, 1, 5, 0, 1), 0, 'apart');
  assert.equal(circleCover(0, 0, 1, 0, 0, 2), 1, 'a bigger part over it');
  assert(Math.abs(circleCover(0, 0, 1, 0, 0, 0.5) - 0.25) < 1e-9, 'a smaller part inside: its area share');
  const h = circleCover(0, 0, 1, 1, 0, 1);
  assert(Math.abs(h - (2 * Math.PI / 3 - Math.sqrt(3) / 2) / Math.PI) < 1e-9, `two unit circles a radius apart: ${h.toFixed(4)}`);
  assert(circleCover(0, 0, 1, 0.5, 0, 1) > circleCover(0, 0, 1, 1.5, 0, 1), 'monotonic in distance');
});

test('view3d-repair-polish R8: the fade touches only the viewer\'s own ghost set — per glove, the head on its own — and a see-through glove stops writing depth', () => {
  const m = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 });
  const mats = (part) => meshes(m.object3d, (o) => o.userData.part === part).map((o) => o.material);
  m.setOwnFade({ left: 1, right: 0, head: 1 });
  for (const mat of mats('left').filter((x) => /gloves|cuff/.test(x.name))) { assert(Math.abs(mat.opacity - OWN_FADE_LOOK.glove) < 1e-9 && mat.opacity <= SEE_THROUGH, `left glove faded (${mat.name} ${mat.opacity})`); assert.equal(mat.depthWrite, false); }
  for (const mat of mats('right').filter((x) => /gloves|cuff/.test(x.name))) { assert.equal(mat.opacity, 1, 'right glove solid'); assert.equal(mat.depthWrite, true); }
  for (const mat of mats('head')) assert(mat.opacity < 0.2, `the see-through head fades (${mat.name} ${mat.opacity.toFixed(2)})`);
  // the body and the solid set (the same model in the other versus half, cuts, the outro) are untouched
  const body = meshes(m.object3d, (o) => !o.userData.part && o.userData.mat === 'skin')[0];
  assert(Math.abs(body.material.opacity - 0.5) < 1e-9, 'the ghost body keeps its look');
  m.setGhost(false);
  for (const o of meshes(m.object3d)) assert(o.material.opacity === 1 || o.material.name === 'star' || !o.material.transparent, `solid set untouched (${o.material.name})`);
  m.setGhost(true); m.setOwnFade({ left: 0, right: 0, head: 0 });
  for (const mat of mats('left').filter((x) => /gloves|cuff/.test(x.name))) assert(mat.opacity === 1 && mat.depthWrite, 'back to solid');
  // timing (a stub scene: a glove right over the face): see-through within ~70 ms, settled in ~80 ms,
  // back when it no longer covers (after the minimum hold) — at once when the lean ends, after
  // OWN_FADE.releaseHeld of being clearly apart while the own-side lean is still held
  const cam = new THREE.PerspectiveCamera(50, 1, 0.05, 100); cam.lookAt(0, 0, -1); cam.updateMatrixWorld();
  let over = true;
  const own = { partSpheres(o) { o.head.c.set(2, 2, -1); o.head.r = 0.05; o.left.c.set(over ? 0 : 1, 0, -1); o.left.r = 0.2; o.right.c.set(-3, 0, -1); o.right.r = 0.1; return o; }, handBusy: () => false };
  const foe = { partSpheres(o) { o.head.c.set(0, 0, -3); o.head.r = 0.2; o.left.r = 0; o.right.r = 0; return o; }, handBusy: () => false };
  for (const held of [false, true]) {
    const f = new OwnFade();
    over = true;
    let t = 0, see = null, settled = null;
    while (t < 0.3) { const v = f.update(DT, cam, own, foe, 1); t += DT; if (see === null && 1 - (1 - OWN_FADE_LOOK.glove) * v.left <= SEE_THROUGH) see = t; if (settled === null && v.left >= 0.97) settled = t; }
    assert(see !== null && see <= 0.07, `see-through after ${see?.toFixed(3)} s`);
    assert(settled !== null && settled >= 0.06 && settled <= 0.1, `settled after ${settled?.toFixed(3)} s (≈ ${OWN_FADE.ms} ms)`);
    assert.equal(f.value.right, 0, 'only the glove over the face fades');
    over = false; t = 0;
    while (t < 1.2 && f.value.left > 0) { f.update(DT, cam, own, foe, held ? 1 : 0); t += DT; }
    if (held) assert(f.value.left === 0 && t >= OWN_FADE.releaseHeld && t <= OWN_FADE.releaseHeld + 0.2, `lean held: back to solid ${t.toFixed(2)} s after it left the face (≈ ${OWN_FADE.releaseHeld} s)`);
    else assert(f.value.left === 0 && t <= 0.2, `lean released: back to solid ${t.toFixed(2)} s after it left the face`);
  }
  m.dispose();
});

test('view3d-repair-polish R8: a resting guard never fades (keyboard and camera guards, with hand jitter, single views and versus halves)', () => {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (const [aspect, versus] of [[16 / 9, false], [4 / 3, false], [2560 / 1080, false], [638 / 720, true], [510 / 768, true]]) {
    for (const hands of ['high', 'camHigh', 'camMid', 'peek']) {
      const m = fighters({ hands });
      const L1 = live(m, aspect, 0, versus);
      let worst = 0;
      for (let t = 0; t < 2; t += DT) {
        const h = HANDS[hands], j = {};
        for (const k of ['left', 'right']) j[k] = { x: h[k].x + rnd() * 0.06, y: h[k].y + rnd() * 0.06, reach: h[k].reach };
        m.step(DT, 0, view({ guard: 'high' }), m.mine(0, { hands: j }));
        const v = L1.frame(DT);
        worst = Math.max(worst, v.left, v.right, v.head);
      }
      assert(worst === 0, `aspect ${aspect.toFixed(2)} ${hands}: a resting guard faded (${worst.toFixed(2)})`);
    }
  }
});

test('view3d-repair-polish R8: a held own-side lean never switches a part on and off — the opponent\'s idle drift and a webcam player\'s tracking noise, 6 s holds: at most one switch per part (the previous fade: up to 4)', () => {
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let cases = 0, switched = 0;
  for (const aspect of [16 / 9, 2560 / 1080]) {
    for (const hands of ['high', 'camHigh', 'peek']) {
      for (const amt of [-0.42, -0.7, -1]) {
        for (const noise of [0, 0.03]) {
          const m = fighters({ hands, settle: 0.8 });
          const L1 = live(m, aspect, 0);
          const tog = { left: 0, right: 0, head: 0 };
          let x = 0, held = null, prev = null;
          for (let f = 0, t = 0; t < 7; f++, t += DT) {
            x += ((t >= 0.5 ? amt : 0) - x) * (1 - Math.exp(-DT / 0.07)); // Space+A (the keyboard's ramp, τ 70 ms)
            if (f % 2 === 0) { // a 30 Hz camera: noise on the hands and the lean
              const h = HANDS[hands], j = {};
              for (const k of ['left', 'right']) j[k] = { x: h[k].x + rnd() * noise, y: h[k].y + rnd() * noise, reach: Math.max(0, h[k].reach + rnd() * noise * 0.5) };
              held = { hands: j, x: x + rnd() * noise };
            }
            // the opponent drifts a little from side to side while it waits (in the browser: ±1–2 % of the width over ~4 s)
            const fx = 0.12 * Math.sin((2 * Math.PI * t) / 3.7);
            m.step(DT, held.x, view({ guard: 'high', lean: L(fx) }), m.mine(held.x, { hands: held.hands }), fx);
            L1.c.lean.p1 = L(held.x); L1.c.lean.p2 = L(fx);
            L1.frame(DT);
            if (t < 1) continue; // the lean settles
            const on = { ...L1.fade._on };
            if (prev) for (const k of Object.keys(tog)) if (on[k] !== prev[k]) tog[k]++;
            prev = on;
          }
          cases++;
          if (tog.left + tog.right + tog.head > 0) switched++;
          for (const [k, n] of Object.entries(tog)) assert(n <= 1, `aspect ${aspect.toFixed(2)} ${hands} lean ${amt} noise ${noise}: the ${k} switched ${n} times in a 6 s hold`);
        }
      }
    }
  }
  assert(switched > 0, `the drift does move the face across the parts (${switched} of ${cases} holds switch a part once)`);
});

test('view3d-repair-polish R8: keyboard A / Space+A / D / Space+D held 150–900 ms — the face under opaque own parts ≤ 0.15, under the see-through head ≤ 0.25 or faded (1280×720, 1920×1080, 1024×768, 2560×1080)', () => {
  const sampled = new Set([9, 18, 30, 54]); // frames after the key-down: 150, 300, 500, 900 ms
  for (const [name, aspect] of Object.entries(VIEWS)) {
    if (name === '1920×1080') continue; // same aspect as 1280×720 (the Node camera has no pixel size)
    for (const hands of ['idle', 'high']) {
      for (const key of [-1, 1]) {
        const m = fighters({ hands });
        const L1 = live(m, aspect, 0);
        for (let t = 0; t < 0.5; t += DT) { m.step(DT, 0); L1.frame(DT); }
        let x = 0;
        for (let f = 1; f <= 54; f++) {
          x += (key - x) * (1 - Math.exp(-DT / 0.07)); // the keyboard's lean ramp (τ 70 ms)
          m.step(DT, x); L1.c.lean.p1 = L(x);
          const v = L1.frame(DT);
          if (!sampled.has(f)) continue;
          const c = exactCover(m, L1.rig.camera);
          assert(c.opaque <= 0.15, `${name} ${hands === 'idle' ? '' : 'Space+'}${key < 0 ? 'A' : 'D'} at ${Math.round(f * 1000 / 60)} ms: ${pct(c.opaque)} of the face under opaque own parts (fade ${JSON.stringify(v)})`);
          // the veil a see-through head leaves on the face scales with its opacity: in the browser ≈ 64–69 of
          // 255 per unit of the head's opacity factor (5.5–6.4 at the full fade's 0.1, 8.4–10 at 0.145), so
          // a mean luma change ≤ 8 needs the factor ≤ 0.12
          const factor = 1 - v.head * (1 - OWN_FADE_LOOK.head);
          assert(c.head <= 0.25 || factor <= 0.12, `${name} ${key < 0 ? 'A' : 'D'} at ${Math.round(f * 1000 / 60)} ms: ${pct(c.head)} under the own see-through head at ${factor.toFixed(3)} of its opacity (veil ≈ ${(67 * factor).toFixed(1)} > 8)`);
        }
      }
    }
  }
});

test('view3d-repair-polish R8: the opponent\'s punch lunging toward the own side (leans −0.42 / −0.7 / −1, with and without a guard, a peek-a-boo guard, the average and the shortest opponent): the face under opaque own parts ≤ 0.25 on EVERY frame, wind-up included', () => {
  // the verifier's worst cases (previous fade: one frame over 0.25 at the start of the lunge — the
  // glove had let go during the wind-up, or faded in too slowly): opponent 13 (the shortest) peek −1
  // rear hook 0.375, 11 peek −1 0.308, 13 high −1 0.268, 11 peek −0.7 straight 0.263, 13 camHigh −0.7 0.256
  const P = (hand, kind, st, p) => ({ id: 1, hand, kind, target: 'head', stage: st, progress: p, outcome: st === 'recover' ? 'dodged' : null, powerPunch: kind === 'hook' });
  const punch = (hand, kind) => (t) => {
    if (t < 0.3) return view({ guard: 'high', phase: 'windup', windup: { id: 1, hand, kind, target: 'head', progress: t / 0.3, tell: { pullback: 1, shoulder: 1 } } });
    if (t < 0.85) { const p = (t - 0.3) / 0.55; return view({ guard: 'high', phase: 'punch', punches: [P(hand, kind, 'travel', p)], punch: P(hand, kind, 'travel', p) }); }
    const p = Math.max(0, 1 - (t - 0.85) / 0.6);
    return view({ guard: 'high', phase: 'recover', punches: [P(hand, kind, 'recover', p)], punch: P(hand, kind, 'recover', p) });
  };
  const PUNCH = { 'rear hook': punch('right', 'hook'), 'lead hook': punch('left', 'hook'), straight: punch('right', 'straight') };
  const cases = [];
  for (const preset of [11, 13]) for (const hands of ['idle', 'high', 'camHigh', 'peek']) for (const x of [-0.42, -0.7, -1]) cases.push([preset, hands, x, 'rear hook']);
  for (const preset of [11, 13]) for (const hands of ['high', 'peek']) for (const x of [-0.7, -1]) cases.push([preset, hands, x, 'straight']);
  cases.push([13, 'peek', -0.7, 'lead hook'], [13, 'camHigh', -0.7, 'straight']);
  let fadedSomewhere = 0;
  for (const [preset, hands, x, name] of cases) {
    const m = fighters({ hands, lean: x, foePreset: preset, settle: 1.0 });
    const L1 = live(m, 16 / 9, x);
    for (let t = 0; t < 1; t += DT) { m.step(DT, x); L1.frame(DT); }
    const restN = exactCover(m, L1.rig.camera).n;
    let worst = 0, at = 0, faded = 0;
    for (let t = 0; t < 1.5; t += DT) {
      m.step(DT, x, PUNCH[name](t));
      const v = L1.frame(DT);
      if (v.left > 0.5 || v.right > 0.5) faded++;
      const c = exactCover(m, L1.rig.camera);
      if (c.n < 0.25 * restN) continue; // its own punching arm hides most of its face: no face to read
      if (c.opaque > worst) { worst = c.opaque; at = t; }
    }
    if (faded) fadedSomewhere++;
    assert(worst <= 0.25, `opponent ${preset}, ${name}, lean ${x}, ${hands}: ${pct(worst)} of the face under opaque own parts at ${at.toFixed(3)} s (BASE before R6: 100 % throughout)`);
  }
  assert(fadedSomewhere >= cases.length / 3, `the lunges do sweep the face behind the gloves, which fade (${fadedSomewhere} of ${cases.length})`);
});

test('view3d-repair-polish R8: a glove out on a punch never fades (it is the punch), even over the face', () => {
  const m = fighters({ hands: 'high' });
  const L1 = live(m, 16 / 9, 0);
  const P = (st, p) => ({ id: 7, hand: 'left', kind: 'straight', target: 'head', stage: st, progress: p, outcome: 'hit', power: 0.5 });
  let maxLeft = 0, overFace = 0;
  for (let t = 0; t < 0.6; t += DT) {
    const p = Math.min(1, t / 0.25);
    const st = t < 0.25 ? 'travel' : 'recover';
    const mine = m.mine(0, { phase: t < 0.25 ? 'punch' : 'recover', punches: [P(st, st === 'travel' ? p : 1 - (t - 0.25) / 0.35)], punch: P(st, p) });
    m.step(DT, 0, view({ guard: 'high' }), mine);
    const v = L1.frame(DT);
    maxLeft = Math.max(maxLeft, v.left);
    const c = exactCover(m, L1.rig.camera);
    if (c.opaque > 0.25) overFace++;
  }
  assert.equal(maxLeft, 0, 'the punching glove stays solid');
  assert(overFace > 0, 'the jab does pass over the face (the case is real)');
});

test('view3d-repair-polish R8: without a lean, the guard stays solid when the opponent\'s punch carries its face behind it (the classic guard look; only the own-side slide fades gloves)', () => {
  const P = (st, p) => ({ id: 3, hand: 'right', kind: 'straight', target: 'head', stage: st, progress: p, outcome: st === 'recover' ? 'blocked' : null, powerPunch: false });
  const foeView = (t) => {
    if (t < 0.3) return view({ guard: 'high', phase: 'windup', windup: { id: 3, hand: 'right', kind: 'straight', target: 'head', progress: t / 0.3, tell: { pullback: 1, shoulder: 1 } } });
    if (t < 0.8) { const p = (t - 0.3) / 0.5; return view({ guard: 'high', phase: 'punch', punches: [P('travel', p)], punch: P('travel', p) }); }
    const p = Math.max(0, 1 - (t - 0.8) / 0.6); return view({ guard: 'high', phase: 'recover', punches: [P('recover', p)], punch: P('recover', p) });
  };
  for (const hands of ['high', 'camHigh']) {
    const m = fighters({ hands });
    const L1 = live(m, 16 / 9, 0);
    for (let t = 0; t < 0.5; t += DT) { m.step(DT, 0); L1.frame(DT); }
    let gloves = 0, covered = 0;
    for (let t = 0; t < 1.4; t += DT) {
      m.step(DT, 0, foeView(t));
      const v = L1.frame(DT);
      gloves = Math.max(gloves, v.left, v.right);
      if (Math.round(t / DT) % 5 === 0 && exactCover(m, L1.rig.camera).opaque > 0.5) covered++;
    }
    assert.equal(gloves, 0, `${hands}: a resting guard faded (${gloves.toFixed(2)})`);
    assert(covered > 0, `${hands}: the straight does carry the face behind the guard (the case is real)`);
  }
});

test('view3d-repair-polish R8: the round-start settle shot keeps the normal look — the renderer fades the own parts only in the live shot (the verifier saw the head fade in the settle close-up)', () => {
  // the opponent leaning to its own left parks its face behind the player's see-through head (the rest
  // framing, D18): enough for the live shot to fade the head — the settle shot must still show it as is
  const m = fighters({ hands: 'high' });
  const rig = new CameraRig({ side: 'p1', aspect: 16 / 9 });
  const R = Object.create(GameRenderer.prototype);
  R._split = 1; R._outro = null; R._rigs = [rig, null];
  R._slots = { p1: { model: m.p1, ownFade: new OwnFade() }, p2: { model: m.p2, ownFade: new OwnFade() } };
  R._reportOnce = (k, msg, e) => { throw e; };
  const probe = new OwnFade(); // what the fade would do if it also ran in the settle shot
  const c = ctxFor(m, 0);
  const foeLean = L(-1);
  c.lean.p2 = foeLean;
  // a faded head left over from the previous round's live view
  R._slots.p1.ownFade.value.head = 1; R._slots.p1.ownFade._on.head = true; m.p1.setOwnFade(R._slots.p1.ownFade.value);
  const headOpacity = () => Math.min(...meshes(m.p1._head).map((o) => o.material.opacity));
  const normal = meshes(m.p1._head).map((o) => o.material).find((x) => /ghost:head/.test(x.name));
  let shots = new Set(), worst = 0, probeMax = 0, coverMax = 0;
  for (let t = 0; t < 0.9; t += DT) { // the settle shot ('fight' stage, BEHIND)
    m.step(DT, 0, view({ guard: 'high', lean: foeLean, phase: 'dodge' }), null, -1);
    Object.assign(c, { phase: MatchPhase.ROUND_START, stage: 'fight', stageTime: t, phaseTime: t });
    refresh(m, c); rig.update(DT, c); rig.camera.updateMatrixWorld();
    shots.add(rig.shot);
    R._updateOwnFade(DT);
    const v = R._slots.p1.ownFade.value;
    worst = Math.max(worst, v.left, v.right, v.head);
    probeMax = Math.max(probeMax, probe.update(DT, rig.camera, m.p1, m.p2, rig.ownShift).head);
    coverMax = Math.max(coverMax, exactCover(m, rig.camera).head);
  }
  assert(shots.has(Shot.BEHIND) && !shots.has(Shot.PLAY), `the settle shot ran (${[...shots]})`);
  assert.equal(worst, 0, 'no own part fades in the settle shot');
  assert(Math.abs(headOpacity() - normal.opacity) < 1e-9 && headOpacity() > 0.3, `the own head keeps its ghost look (${headOpacity().toFixed(2)})`);
  assert(coverMax > 0.25 && probeMax > 0.9, `the case is real: ${pct(coverMax)} of the face behind the own head, a fade run there would reach ${probeMax.toFixed(2)}`);
  // the live shot right after: the same cover does fade the head
  let liveMax = 0;
  for (let t = 0; t < 0.6; t += DT) {
    m.step(DT, 0, view({ guard: 'high', lean: foeLean, phase: 'dodge' }), null, -1);
    Object.assign(c, { phase: MatchPhase.FIGHTING, stage: 'live', stageTime: 1 + t, phaseTime: 1 + t });
    refresh(m, c); rig.update(DT, c); rig.camera.updateMatrixWorld();
    R._updateOwnFade(DT);
    liveMax = Math.max(liveMax, R._slots.p1.ownFade.value.head);
  }
  assert.equal(rig.shot, Shot.PLAY);
  assert(liveMax > 0.9, `the live shot fades the head (${liveMax.toFixed(2)})`);
});
