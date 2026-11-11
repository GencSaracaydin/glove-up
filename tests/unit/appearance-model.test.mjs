// BoxerModel (render/boxer-model.js) driven headlessly in Node: DOM-free import, every
// phase/role stays finite, punches land on the opponent, windups telegraph, hits react in
// the right direction, 30 Hz input stays smooth at 60 fps, ghost materials, clean dispose.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import * as THREE from 'three';
import { BoxerPhase } from '../../src/core/types.js';
import {
  BoxerModel, BODY, ANIM, placeBoxer, gloveWorldPosition, headWorldPosition, bodyWorldPosition, sharedGeometryCount, solveTwoBone, FALL_STYLES,
} from '../../src/render/boxer-model.js';
import { PRESETS, DEFAULT_PLAYER, TRAINER } from '../../src/render/appearance.js';

const DT = 1 / 60;
const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, hitReact: null, isHuman: false, hp01: 1, expression: 'neutral', ...o });

function pair(look = PRESETS[3]) {
  const a = new BoxerModel(look, { seed: 1 }), b = new BoxerModel(DEFAULT_PLAYER, { seed: 2 });
  placeBoxer(a, 'p2'); placeBoxer(b, 'p1');
  a.setFoe(b); b.setFoe(a);
  return { a, b, run(n, va, vb = view()) { for (let i = 0; i < n; i++) { a.update(typeof va === 'function' ? va(i) : va, DT); b.update(vb, DT); } } };
}

function finite(model) {
  let ok = true;
  model.object3d.updateWorldMatrix(true, true);
  model.object3d.traverse((o) => { for (const v of o.matrixWorld.elements) if (!Number.isFinite(v)) ok = false; });
  return ok;
}

test('model: importing render modules never touches the DOM', () => {
  const root = fileURLToPath(new URL('../../src/render/', import.meta.url));
  const code = `
    // (three.js itself does a harmless typeof-window check, so window is not trapped)
    for (const k of ['document', 'navigator', 'OffscreenCanvas', 'Image', 'HTMLCanvasElement']) {
      Object.defineProperty(globalThis, k, { get() { throw new Error('touched ' + k); }, configurable: true });
    }
    await import(${JSON.stringify('file://' + root + 'boxer-model.js')});
    await import(${JSON.stringify('file://' + root + 'face.js')});
    await import(${JSON.stringify('file://' + root + 'appearance.js')});
    console.log('clean');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean/);
});

test('model: every preset/role survives every phase with finite transforms', () => {
  const looks = [...PRESETS.map((p) => [p, 'boxer']), [TRAINER, 'trainer']];
  for (const [look, role] of looks) {
    const m = new BoxerModel(look, { role });
    for (const phase of Object.values(BoxerPhase)) {
      for (let i = 0; i < 40; i++) {
        m.update(view({
          phase, phaseProgress: i / 40, guard: i % 3 ? 'high' : 'low', lean: { x: Math.sin(i), y: -0.6, z: 0.3 },
          hands: { left: { x: -0.3, y: 0.5, reach: i / 40 }, right: { x: 0.3, y: -2, reach: 0 } },
          punch: { hand: i % 2 ? 'left' : 'right', kind: ['straight', 'hook', 'uppercut'][i % 3], target: i % 4 ? 'head' : 'body', progress: i / 40 },
          hitReact: { hand: 'left', kind: 'hook', target: i % 2 ? 'head' : 'body', strength: 1.3, age: (i % 10) / 30, blocked: i % 7 === 0 },
        }), DT);
      }
      assert(finite(m), `${look.label ?? role} ${phase}`);
    }
    m.update(null, DT); m.update(undefined, 0); m.update({ phase: 'nonsense', lean: 'x', hands: 5 }, NaN);
    assert(finite(m), `${role} garbage views`);
    m.dispose();
  }
});

test('model: punches land on the opponent at impact (head & body, every kind, both hands)', () => {
  const R = BODY.gloveR;
  const report = [];
  for (const ai of [true, false]) for (const kind of ['straight', 'hook', 'uppercut']) for (const target of ['head', 'body']) for (const hand of ['left', 'right']) {
    const P = pair();
    P.run(30, view());
    if (ai) P.run(27, (i) => view({ phase: 'windup', phaseProgress: i / 27, punch: { hand, kind, target, progress: 0 } }));
    let glove = null;
    P.run(10, (i) => {
      const p = (i + 1) / 10;
      if (i === 9) glove = null;
      return view({ phase: 'punch', phaseProgress: p, punch: { hand, kind, target, progress: p, impact: p >= 0.88 } });
    });
    glove = gloveWorldPosition(P.a, hand);
    let d, limit;
    if (target === 'head') { d = glove.distanceTo(headWorldPosition(P.b)); limit = R + BODY.headR * 1.12; }
    else { d = glove.distanceTo(bodyWorldPosition(P.b)); limit = R + 0.04; }
    report.push(`${ai ? 'ai' : 'human'} ${hand} ${kind} ${target}: ${(d * 100).toFixed(1)}cm (limit ${(limit * 100).toFixed(1)})`);
    assert(d <= limit, report[report.length - 1]);
    P.a.dispose(); P.b.dispose();
  }
});

test('model: punches travel out fast and come back slower', () => {
  const P = pair();
  P.run(30, view());
  const rest = gloveWorldPosition(P.a, 'right').clone();
  P.run(10, (i) => view({ phase: 'punch', phaseProgress: (i + 1) / 10, punch: { hand: 'right', kind: 'straight', target: 'head', progress: (i + 1) / 10 } }));
  const out = gloveWorldPosition(P.a, 'right').clone();
  assert(out.distanceTo(rest) > 0.3, `extends ${out.distanceTo(rest)}`);
  // after 0.1 s of recovery the glove has not snapped all the way back yet
  P.run(6, (i) => view({ phase: 'recover', phaseProgress: (i + 1) / 18, punch: { hand: 'right', kind: 'straight', target: 'head', progress: 1 } }));
  const mid = gloveWorldPosition(P.a, 'right').clone();
  assert(mid.distanceTo(rest) > 0.08, 'retract is slower than the out-stroke');
  P.run(40, view());
  assert(gloveWorldPosition(P.a, 'right').distanceTo(rest) < 0.06, 'back in stance');
});

test('model: AI windup is a big, readable telegraph (glove cocked + body coiled)', () => {
  for (const kind of ['straight', 'hook', 'uppercut']) {
    const P = pair();
    P.run(40, view());
    const g0 = gloveWorldPosition(P.a, 'right').clone();
    const yaw0 = P.a._sp.spineRot.x.y + P.a._sp.hipsRot.x.y;
    // readable early: by 0.15 s (≈ webcam latency) the pose has clearly changed
    P.run(9, (i) => view({ phase: 'windup', phaseProgress: (i + 1) / 27, punch: { hand: 'right', kind, target: 'head', progress: 0 } }));
    const g1 = gloveWorldPosition(P.a, 'right');
    const yaw1 = P.a._sp.spineRot.x.y + P.a._sp.hipsRot.x.y;
    assert(g1.distanceTo(g0) > 0.1, `${kind}: glove moved ${g1.distanceTo(g0).toFixed(3)} m`);
    assert(yaw1 - yaw0 < -0.12, `${kind}: right shoulder pulled back (yaw ${(yaw1 - yaw0).toFixed(2)})`);
  }
});

test('model: hit reactions snap in the direction of the punch', () => {
  const hit = (h) => {
    const m = new BoxerModel(PRESETS[0]);
    for (let i = 0; i < 30; i++) m.update(view(), DT);
    const s0 = { pitch: m._sp.headRot.x.x, yaw: m._sp.headRot.x.y, spine: m._sp.spineRot.x.x };
    for (let i = 0; i < 5; i++) m.update(view({ phase: 'hitstun', phaseProgress: i / 25, hitReact: { strength: 1, age: i * DT, blocked: false, ...h } }), DT);
    return { dPitch: m._sp.headRot.x.x - s0.pitch, dYaw: m._sp.headRot.x.y - s0.yaw, dSpine: m._sp.spineRot.x.x - s0.spine, m };
  };
  const st = hit({ hand: 'right', kind: 'straight', target: 'head' });
  assert(st.dPitch < -0.12, `straight snaps the head back (${st.dPitch.toFixed(2)})`);
  const hl = hit({ hand: 'left', kind: 'hook', target: 'head' });
  assert(hl.dYaw > 0.12, `attacker's left hook turns my head to my left (${hl.dYaw.toFixed(2)})`);
  const hr = hit({ hand: 'right', kind: 'hook', target: 'head' });
  assert(hr.dYaw < -0.12, `attacker's right hook turns my head to my right (${hr.dYaw.toFixed(2)})`);
  const up = hit({ hand: 'right', kind: 'uppercut', target: 'head' });
  assert(up.dPitch < -0.18, `uppercut snaps the chin up (${up.dPitch.toFixed(2)})`);
  const bd = hit({ hand: 'left', kind: 'hook', target: 'body' });
  assert(bd.dSpine > 0.12, `body shot folds the torso (${bd.dSpine.toFixed(2)})`);
  const bl = hit({ hand: 'right', kind: 'straight', target: 'head', blocked: true });
  assert(Math.abs(bl.dPitch) < Math.abs(st.dPitch) * 0.5, 'blocked hits barely move the head');
});

test('model: 30 Hz input is smooth at 60 fps (no stair-steps)', () => {
  const m = new BoxerModel(DEFAULT_PLAYER);
  for (let i = 0; i < 30; i++) m.update(view({ isHuman: true, hands: { left: { x: -0.3, y: 0.4, reach: 0 }, right: { x: 0.3, y: 0.4, reach: 0 } } }), DT);
  let prev = gloveWorldPosition(m, 'left').clone();
  let still = 0, maxStep = 0;
  for (let i = 0; i < 40; i++) {
    const k = Math.floor(i / 2) / 20; // input changes every other frame (30 Hz)
    m.update(view({ isHuman: true, hands: { left: { x: -0.3 - k * 0.6, y: 0.4 - k, reach: k * 0.5 }, right: { x: 0.3, y: 0.4, reach: 0 } } }), DT);
    const cur = gloveWorldPosition(m, 'left').clone();
    const step = cur.distanceTo(prev);
    if (step < 1e-4) still++;
    maxStep = Math.max(maxStep, step);
    prev = cur;
  }
  assert.equal(still, 0, 'glove keeps moving between camera frames');
  assert(maxStep < 0.06, `no jumps (max ${maxStep.toFixed(3)} m/frame)`);
});

test('model: ghost mode — body ~50% transparent, gloves SOLID, no shadows, reversible', () => {
  const m = new BoxerModel(DEFAULT_PLAYER, { ghost: true });
  const meshes = [];
  m.object3d.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const gloveParts = new Set(['glove', 'thumb', 'cuff', 'cuffBand']);
  let gloves = 0, body = 0;
  for (const o of meshes) {
    assert(!o.castShadow, `${o.name} casts no shadow`);
    if (gloveParts.has(o.name)) {
      gloves++;
      assert(o.material.opacity === 1 && o.material.depthWrite === true, `${o.name} solid`);
      assert(o.renderOrder > 10, `${o.name} drawn after the see-through body (never veiled by the own head)`);
    } else if (o.name !== 'star') {
      body++;
      assert(o.material.transparent && o.material.depthWrite === false, `${o.name} transparent`);
      assert(o.material.opacity >= 0.4 && o.material.opacity <= 0.6, `${o.name} ≈ half transparent (${o.material.opacity})`);
      assert(o.renderOrder === 10, `${o.name} sorted before the gloves`);
    }
  }
  assert(gloves >= 8 && body > 10, `${gloves} glove parts, ${body} body parts`);
  m.setGhost(false);
  for (const o of meshes) if (o.name !== 'star') assert(!o.material.transparent && o.castShadow, `${o.name} solid again`);
  m.setGhost(true); m.setGhost(true);
  assert(meshes.find((o) => o.name === 'torso').material.transparent, 'ghost again');
  m.dispose();
});

test('model: placement, anchors and helpers', () => {
  const P = pair();
  P.run(20, view());
  const c1 = headWorldPosition(P.b), f1 = headWorldPosition(P.b, undefined, { front: true });
  assert(f1.z < c1.z, 'P1 faces −Z');
  const c2 = headWorldPosition(P.a), f2 = headWorldPosition(P.a, undefined, { front: true });
  assert(f2.z > c2.z, 'P2 faces +Z');
  for (const hand of ['left', 'right']) {
    const anchor = P.a.handAnchor(hand).getWorldPosition(new THREE.Vector3());
    assert(anchor.distanceTo(gloveWorldPosition(P.a, hand)) < 1e-6, `${hand} anchor at the glove`);
  }
  // boxer's left glove is on world −X for P2 (facing +Z) and on +X... for P1 (facing −Z) its RIGHT is +X
  assert(gloveWorldPosition(P.b, 'right').x > gloveWorldPosition(P.b, 'left').x, 'P1 right glove toward world +X');
  assert(c1.y > 1.15 && c1.y < 1.45, `head height ${c1.y.toFixed(2)}`);
});

test('model: knockdown → lies down → gets up; KO stays down; victory raises the gloves', () => {
  const m = new BoxerModel(PRESETS[0]);
  const run = (n, v) => { for (let i = 0; i < n; i++) m.update(typeof v === 'function' ? v(i) : v, DT); };
  run(30, view());
  run(6, view({ phase: 'hitstun', hitReact: { hand: 'right', kind: 'uppercut', target: 'head', strength: 1.2, age: 0 } }));
  run(90, view({ phase: 'down' }));
  assert(headWorldPosition(m).y < 0.5, `down: head at ${headWorldPosition(m).y.toFixed(2)} m`);
  run(75, (i) => view({ phase: 'getup', phaseProgress: (i + 1) / 75 }));
  run(60, view());
  assert(headWorldPosition(m).y > 1.15, `up again: head at ${headWorldPosition(m).y.toFixed(2)} m`);
  run(30, view({ phase: 'down' }));
  run(150, view({ phase: 'ko' }));
  assert(headWorldPosition(m).y < 0.5, 'KO stays down');
  run(80, view({ phase: 'victory' }));
  const head = headWorldPosition(m).y;
  assert(gloveWorldPosition(m, 'left').y > head && gloveWorldPosition(m, 'right').y > head, 'victory: gloves above the head');
  m.dispose();
});

test('model: no referee role (legacy role builds a boxer) and the trainer throw', () => {
  const legacy = new BoxerModel(null, { role: 'referee' });
  assert.equal(legacy.role, 'boxer');
  assert.equal(typeof legacy.refCount, 'undefined', 'referee gestures are gone');
  legacy.dispose();
  const tr = new BoxerModel(TRAINER, { role: 'trainer' });
  for (let i = 0; i < 20; i++) tr.update(null, DT);
  const release = tr.trainerThrow('right');
  assert(release > 0.2 && release < 0.8, `release at ${release}`);
  for (let i = 0; i < Math.round(0.28 / DT); i++) tr.update(null, DT);
  const back = gloveWorldPosition(tr, 'right').z;
  for (let i = 0; i < Math.round((release - 0.28) / DT) + 4; i++) tr.update(null, DT);
  assert(gloveWorldPosition(tr, 'right').z > back + 0.2, 'throw swings the hand forward');
  tr.setHandTarget('left', new THREE.Vector3(0.3, 1.3, 0.4));
  for (let i = 0; i < 40; i++) tr.update(null, DT);
  assert(gloveWorldPosition(tr, 'left').distanceTo(new THREE.Vector3(0.3, 1.3, 0.4)) < 0.05, 'setHandTarget drives the mitt hand');
  tr.dispose();
});

test('model: face-down fall for the player (setFallStyle front) — prone, gets up, KO stays prone', () => {
  assert.deepEqual([...FALL_STYLES].sort(), ['back', 'front', 'knees']);
  const m = new BoxerModel(DEFAULT_PLAYER);
  m.setFallStyle('front');
  const run = (n, v) => { for (let i = 0; i < n; i++) m.update(typeof v === 'function' ? v(i) : v, DT); };
  run(30, view({ isHuman: true }));
  const start = headWorldPosition(m).clone();
  run(6, view({ phase: 'hitstun', hitReact: { hand: 'right', kind: 'straight', target: 'head', strength: 1.2, age: 0 } }));
  run(90, view({ phase: 'down', isHuman: true }));
  const head = headWorldPosition(m), front = headWorldPosition(m, undefined, { front: true });
  assert(head.y < 0.45, `prone: head at ${head.y.toFixed(2)} m`);
  assert(head.z > start.z + 0.5, `fell forward (model faces +Z): head z ${head.z.toFixed(2)} vs ${start.z.toFixed(2)}`);
  assert(m._hips.getWorldPosition(new THREE.Vector3()).y < 0.3, 'hips on the canvas');
  assert(front.y < head.y + 0.12, 'face turned down/sideways, not up');
  assert(finite(m));
  run(80, (i) => view({ phase: 'getup', phaseProgress: (i + 1) / 80, isHuman: true }));
  run(60, view({ isHuman: true }));
  assert(headWorldPosition(m).y > 1.15, `up again: ${headWorldPosition(m).y.toFixed(2)}`);
  run(30, view({ phase: 'down' }));
  run(120, view({ phase: 'ko' }));
  assert(headWorldPosition(m).y < 0.45 && finite(m), 'KO stays down (prone)');
  m.setFallStyle(null);
  m.dispose();
});

test('model: snapTo jumps to a pose with nothing in flight (replays and cinematics)', () => {
  const m = new BoxerModel(PRESETS[2]);
  for (let i = 0; i < 20; i++) m.update(view({ phase: 'punch', punch: { hand: 'right', kind: 'hook', target: 'head', progress: i / 20 } }), DT);
  m.snapTo(view({ phase: 'down' }));
  assert(headWorldPosition(m).y < 0.5, 'lands lying down at once');
  m.snapTo(view());
  const h = headWorldPosition(m).y;
  assert(h > 1.15, `standing at once (${h.toFixed(2)})`);
  m.update(view(), DT);
  assert(Math.abs(headWorldPosition(m).y - h) < 0.02, 'no spring catch-up after the snap');
  assert(finite(m));
  m.dispose();
});

test('model: two-bone IK reaches, bends toward the pole and stretches within limits', () => {
  const mid = new THREE.Vector3(), end = new THREE.Vector3();
  const root = new THREE.Vector3(), pole = new THREE.Vector3(0, -1, 0);
  solveTwoBone(root, new THREE.Vector3(0.3, 0, 0.2), pole, 0.25, 0.25, 1, mid, end);
  assert(Math.abs(mid.distanceTo(root) - 0.25) < 1e-6 && Math.abs(mid.distanceTo(end) - 0.25) < 1e-6, 'bone lengths kept');
  assert(mid.y < 0, 'elbow bends toward the pole');
  const s = solveTwoBone(root, new THREE.Vector3(0, 0, 0.7), pole, 0.25, 0.25, ANIM.maxStretch, mid, end);
  assert(s > 1 && s <= ANIM.maxStretch + 1e-9, `stretch ${s}`);
});

test('model: dispose releases shared geometry and expressions switch without a DOM', () => {
  const before = sharedGeometryCount();
  const ms = PRESETS.slice(0, 4).map((p) => new BoxerModel(p));
  assert(sharedGeometryCount() > before);
  for (const m of ms) { m.setExpression('ko'); m.update(view(), DT); m.setExpression(null); m.update(view({ expression: 'happy' }), DT); }
  for (const m of ms) m.dispose();
  ms[0].dispose(); // double dispose is harmless
  assert.equal(sharedGeometryCount(), before);
});

test('model: game view format — punches[] stages, recover 1→0, windup object beside a recovering punch', () => {
  const P = pair();
  P.run(40, view());
  const restL = gloveWorldPosition(P.a, 'left').clone(), restR = gloveWorldPosition(P.a, 'right').clone();
  const jab = (progress, stage) => ({ id: 7, hand: 'left', kind: 'straight', target: 'head', progress, stage, impact: false, outcome: stage === 'recover' ? 'hit' : null });
  P.run(10, (i) => { const q = jab((i + 1) / 10, 'travel'); return view({ phase: 'punch', phaseProgress: q.progress, punch: q, punches: [q] }); });
  const ext = gloveWorldPosition(P.a, 'left').clone();
  assert(ext.distanceTo(restL) > 0.3, 'jab extends');
  // the left jab recovers (progress runs 1 → 0) while the right hand winds up a hook
  P.run(15, (i) => {
    const q = jab(1 - (i + 1) / 15, 'recover');
    return view({ phase: 'windup', phaseProgress: (i + 1) / 15, punch: q, punches: [q],
      windup: { hand: 'right', kind: 'hook', target: 'head', progress: (i + 1) / 15, tell: { pullback: 1, shoulder: 1 } } });
  });
  // P2 faces +Z: a retracted glove is well behind (smaller z than) the extended one
  assert(gloveWorldPosition(P.a, 'left').z < ext.z - 0.25, 'jab came back while the other hand winds up');
  assert(gloveWorldPosition(P.a, 'right').distanceTo(restR) > 0.1, 'right hook telegraph from the windup object');
  // a new punch id with the same hand restarts the out-stroke
  P.run(30, view());
  const q2 = (progress) => ({ id: 9, hand: 'left', kind: 'straight', target: 'body', progress, stage: 'travel' });
  P.run(10, (i) => view({ phase: 'punch', punch: q2((i + 1) / 10), punches: [q2((i + 1) / 10)] }));
  const body = bodyWorldPosition(P.b);
  assert(gloveWorldPosition(P.a, 'left').distanceTo(body) < BODY.gloveR + 0.05, 'second punch (new id) lands on the body');
  // a dodged punch sails past before coming back
  P.run(30, view());
  const q3 = (progress, stage) => ({ id: 11, hand: 'right', kind: 'straight', target: 'head', progress, stage, outcome: stage === 'recover' ? 'dodged' : null });
  P.run(10, (i) => view({ phase: 'punch', punch: q3((i + 1) / 10, 'travel'), punches: [q3((i + 1) / 10, 'travel')] }));
  const atImpact = gloveWorldPosition(P.a, 'right').clone();
  P.run(3, (i) => view({ phase: 'recover', punch: q3(1 - (i + 1) / 15, 'recover'), punches: [q3(1 - (i + 1) / 15, 'recover')] }));
  assert(gloveWorldPosition(P.a, 'right').z > atImpact.z, 'whiff overshoots toward the opponent first');
});

test('model: taunting and tell scaling', () => {
  const m = new BoxerModel(PRESETS[10]);
  for (let i = 0; i < 40; i++) m.update(view({ taunting: true, expression: 'happy' }), DT);
  const head = headWorldPosition(m).y;
  assert(gloveWorldPosition(m, 'left').y < head - 0.45 && gloveWorldPosition(m, 'right').y < head - 0.45, 'taunt drops the gloves');
  const cock = (pullback) => {
    const b = new BoxerModel(PRESETS[10]);
    for (let i = 0; i < 40; i++) b.update(view(), DT);
    const r = gloveWorldPosition(b, 'right').clone();
    for (let i = 0; i < 15; i++) b.update(view({ phase: 'windup', windup: { hand: 'right', kind: 'straight', target: 'head', progress: (i + 1) / 20, tell: { pullback, shoulder: pullback } } }), DT);
    return gloveWorldPosition(b, 'right').distanceTo(r);
  };
  const big = cock(1.2), small = cock(0.5);
  assert(big > small, 'smaller tells for tougher opponents');
  assert(small > 0.08, `still readable (${small.toFixed(3)} m)`);
});

test('model: the knockdown blow decides the fall even when it arrives with DOWN', () => {
  const fall = (target) => {
    const m = new BoxerModel(PRESETS[0]);
    for (let i = 0; i < 30; i++) m.update(view(), DT);
    // previous hit to the other target, then the knockdown blow in the same frame as DOWN
    m.update(view({ phase: 'hitstun', hitReact: { hand: 'left', kind: 'straight', target: target === 'body' ? 'head' : 'body', strength: 0.5, age: 0 } }), DT);
    for (let i = 0; i < 20; i++) m.update(view({ phase: 'idle' }), DT);
    for (let i = 0; i < 80; i++) m.update(view({ phase: 'down', hitReact: { hand: 'right', kind: 'hook', target, strength: 1, age: i * DT } }), DT);
    const hipsY = m._hips.getWorldPosition(new THREE.Vector3()).y;
    m.dispose();
    return hipsY;
  };
  const knees = fall('body'), back = fall('head');
  assert(knees > back + 0.15, `body blow → kneeling (${knees.toFixed(2)}) vs head blow → flat (${back.toFixed(2)})`);
});

test('model: feet step when the renderer walks the model, but not for quick lean slides', () => {
  const m = new BoxerModel(PRESETS[0]);
  const feetY = () => Math.max(m._leg.left.foot.position.y, m._leg.right.foot.position.y);
  for (let i = 0; i < 30; i++) m.update(view(), DT);
  // quick 10 cm sidestep (renderer lean slide) → no stepping
  let maxLift = 0;
  for (let i = 0; i < 30; i++) { m.object3d.position.x = Math.min(0.1, i * 0.01); m.update(view({ lean: { x: 1, y: 0, z: 0 } }), DT); maxLift = Math.max(maxLift, feetY()); }
  assert(maxLift < BODY.ankleY + 0.01, `lean slide keeps feet planted (${maxLift.toFixed(3)})`);
  // real walk at 1.6 m/s for a second → feet lift
  maxLift = 0;
  for (let i = 0; i < 60; i++) { m.object3d.position.z += 1.6 * DT; m.update(view({ phase: 'defeat' }), DT); maxLift = Math.max(maxLift, feetY()); }
  assert(maxLift > BODY.ankleY + 0.02, `walking lifts the feet (${maxLift.toFixed(3)})`);
  m.dispose();
});
