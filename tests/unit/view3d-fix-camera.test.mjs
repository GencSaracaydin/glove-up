// view3d fix pass — camera language with the real boxer models in Node (no WebGL): the live camera
// at head height off the left shoulder (VISUAL-03 / D18) and what depends on it (lean slide Q4,
// meter anchor, settle shot, hit cut), the decision shot (VISUAL-01), the knockdown wide shot
// (VISUAL-09), the player-down shot (Q1), the KO replay's low angle (VISUAL-02) and the win
// banner camera (VISUAL-04). Screen positions are percentages of a 16:9 frame (x from the left,
// y from the top) measured on the actual mesh vertices.
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { CameraRig, Shot, RIG_TUNING, leanSlide } from '../../src/render/camera-rig.js';
import { BoxerModel, placeBoxer, headWorldPosition, bodyWorldPosition } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';
import { RENDER_TUNING, replayCameraPose, outroStagePose } from '../../src/render/renderer.js';
import { LAYOUT } from '../../src/render/style.js';
import { MatchPhase, BoxerPhase } from '../../src/core/types.js';

const DT = 1 / 60;
// keyboard idle / high guard hands, and the camera-mode ones read from the synthetic pipeline
const HANDS = {
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
  camIdle: { left: { x: -0.24, y: 0.06, reach: 0.04 }, right: { x: 0.32, y: -0.11, reach: 0 } },
  camHigh: { left: { x: -0.16, y: 0.45, reach: 0.15 }, right: { x: 0.19, y: 0.37, reach: 0.19 } },
};
// the HUD's round-clock box (styles.css .gu-clock at 1280×720) and the centred count number
const CLOCK = [44.2, 85.7, 55.8, 97.2];
const COUNT = [45.2, 31.4, 54.8, 62.6];

const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, hitReact: null, isHuman: false, hp01: 1, hp: 10, expression: 'neutral', ...o });

function fighters({ p1View = view({ isHuman: true, hands: HANDS.idle }), p2View = view({ guard: 'high' }), p1Pos = null, p2Pos = null, p1Fall = null, sec = 1.2 } = {}) {
  const a = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 });
  const b = new BoxerModel(PRESETS[11], { seed: 2 });
  placeBoxer(a, 'p1'); placeBoxer(b, 'p2');
  if (p1Pos) a.object3d.position.copy(p1Pos);
  if (p2Pos) b.object3d.position.copy(p2Pos);
  if (p1Fall) a.setFallStyle(p1Fall);
  a.setFoe(b); b.setFoe(a);
  for (let t = 0; t < sec; t += DT) { a.update(typeof p1View === 'function' ? p1View(t) : p1View, DT); b.update(typeof p2View === 'function' ? p2View(t) : p2View, DT); }
  a.object3d.updateWorldMatrix(true, true); b.object3d.updateWorldMatrix(true, true);
  return { p1: a, p2: b };
}

function ctxFor(m, over = {}) {
  return {
    mode: 'match', phase: MatchPhase.FIGHTING, phaseTime: 2, stage: 'live', stageTime: 2, versus: false, downed: null, koLoser: null, winner: null,
    pos: { p1: m.p1.object3d.position.clone(), p2: m.p2.object3d.position.clone() }, yaw: { p1: Math.PI, p2: 0 },
    lean: { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 0 } },
    head: { p1: headWorldPosition(m.p1, new THREE.Vector3()), p2: headWorldPosition(m.p2, new THREE.Vector3()) },
    body: { p1: bodyWorldPosition(m.p1, new THREE.Vector3()), p2: bodyWorldPosition(m.p2, new THREE.Vector3()) },
    focus: null, shake: { x: 0, y: 0, roll: 0 }, ...over,
  };
}

const _v = new THREE.Vector3();
/** Screen bbox (%) of the meshes of `model` (optionally only those named `name`). */
function box(model, cam, name = null) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  model.object3d.traverse((o) => {
    if (!o.isMesh || !o.visible || (name && o.name !== name)) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).project(cam);
      if (_v.z > 1) continue;
      const sx = (_v.x + 1) * 50, sy = (1 - _v.y) * 50;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  });
  return [x0, y0, x1, y1];
}
function boxes(model, cam, name) { const out = []; model.object3d.traverse((o) => { if (o.isMesh && o.name === name) out.push(box({ object3d: o }, cam)); }); return out; }
const union = (bs) => bs.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], [1e9, 1e9, -1e9, -1e9]);
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
/** The opponent's face: its head box without the top 30 % (hair) and the sides. */
const faceOf = (h) => [h[0] + 0.12 * (h[2] - h[0]), h[1] + 0.3 * (h[3] - h[1]), h[2] - 0.12 * (h[2] - h[0]), h[3]];
/** Share of box `f` covered by the inscribed ellipses of `es` (solid gloves, a head). */
function covered(f, es) {
  let n = 0, hit = 0;
  for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
    const x = f[0] + (f[2] - f[0]) * i / 24, y = f[1] + (f[3] - f[1]) * j / 24;
    n++;
    if (es.some((e) => (((x - (e[0] + e[2]) / 2) / ((e[2] - e[0]) / 2)) ** 2 + ((y - (e[1] + e[3]) / 2) / ((e[3] - e[1]) / 2)) ** 2) <= 1)) hit++;
  }
  return hit / n;
}
const pct = (p, cam) => { const q = p.clone().project(cam); return [(q.x + 1) * 50, (1 - q.y) * 50]; };

function liveRig(m, { lean = { x: 0, y: 0, z: 0 }, sec = 1, aspect = 16 / 9, versus = false } = {}) {
  const rig = new CameraRig({ side: 'p1', aspect });
  const c = ctxFor(m, { lean: { p1: lean, p2: { x: 0, y: 0, z: 0 } }, versus });
  for (let t = 0; t < sec - 1e-9; t += DT) rig.update(DT, c);
  return rig;
}

const IDLE = fighters();

test('view3d-fix VISUAL-03: live camera at about head height, off the left shoulder', () => {
  const rig = liveRig(IDLE);
  const cam = rig.camera.position;
  const head = headWorldPosition(IDLE.p1, new THREE.Vector3());
  assert(Math.abs(cam.y - head.y) <= 0.15, `camera at head height (camera ${cam.y.toFixed(2)} m, head ${head.y.toFixed(2)} m)`);
  assert(cam.x <= head.x - 0.25, `a side offset to the player's left (${(cam.x - head.x).toFixed(2)} m)`);
  assert(cam.z > head.z + 0.5, 'behind the player');
  assert.equal(rig.shot, Shot.PLAY);
  assert.equal(rig.wantsGhost, true, 'own body ghosted');
});

test('view3d-fix VISUAL-03: own head high and beside the opponent (never on its face); opponent whole; gloves mid-frame, clear of the clock', () => {
  for (const [name, hands] of [['keyboard', HANDS.idle], ['camera', HANDS.camIdle]]) {
    const m = name === 'keyboard' ? IDLE : fighters({ p1View: view({ isHuman: true, hands }) });
    const cam = liveRig(m).camera;
    const own = box(m.p1, cam, 'head'), opp = box(m.p2, cam, 'head');
    const [ox, oy] = centre(own), [px, py] = centre(opp);
    assert(oy <= 35, `${name}: own head centre high in the frame (${oy.toFixed(1)} % down; was 75 %)`);
    assert(ox > px + 8, `${name}: own head right of the opponent's (${ox.toFixed(1)} vs ${px.toFixed(1)} %)`);
    assert(covered(faceOf(opp), [own]) <= 0.1, `${name}: own head off the opponent's face`);
    assert(py >= 15 && py <= 38 && px >= 38 && px <= 58, `${name}: opponent's head (${px.toFixed(1)}, ${py.toFixed(1)}) %`);
    const feet = pct(new THREE.Vector3(LAYOUT.p2Pos[0], 0, LAYOUT.p2Pos[2]), cam)[1];
    assert(feet <= 85, `${name}: the opponent seen head to feet (feet ${feet.toFixed(1)} % down; was off-screen)`);
    const g = union(boxes(m.p1, cam, 'glove'));
    assert(g[1] >= 28 && g[3] <= 80, `${name}: idle gloves mid-frame (y ${g[1].toFixed(1)}–${g[3].toFixed(1)} %; was 62–105 %)`);
    assert.equal(overlapArea(g, CLOCK), 0, `${name}: gloves clear of the round clock`);
  }
});

test('view3d-fix VISUAL-03: a high guard does not hide the opponent\'s face (keyboard and camera hands)', () => {
  for (const hands of [HANDS.high, HANDS.camHigh]) {
    const m = fighters({ p1View: view({ isHuman: true, guard: 'high', hands }) });
    const cam = liveRig(m).camera;
    const face = faceOf(box(m.p2, cam, 'head'));
    const c = covered(face, boxes(m.p1, cam, 'glove'));
    assert(c <= 0.2, `face ${Math.round(c * 100)} % behind the guard`);
  }
});

test('view3d-fix VISUAL-03: 4:3 and the versus viewport keep the opponent whole and the gloves on screen', () => {
  for (const [aspect, versus] of [[4 / 3, false], [638 / 720, true]]) {
    const cam = liveRig(IDLE, { aspect, versus }).camera;
    const opp = box(IDLE.p2, cam);
    assert(opp[0] >= 15 && opp[2] <= 85, `opponent inside the frame (x ${opp[0].toFixed(1)}–${opp[2].toFixed(1)} %)`);
    const g = union(boxes(IDLE.p1, cam, 'glove'));
    assert(g[2] <= 100 && g[3] <= 80, 'gloves on screen');
  }
});

test('view3d-fix Q4: a dodge-level lean (0.42) already slides the view ~1/4 of the width, a full lean ~1/3, within 0.15 s', () => {
  assert(Math.abs(leanSlide(0.42) - RIG_TUNING.play.follow.kneeGain) < 1e-9 && leanSlide(1) === 1 && leanSlide(-0.21) < 0 && leanSlide(0) === 0);
  const H2 = headWorldPosition(IDLE.p2, new THREE.Vector3());
  const x0 = pct(H2, liveRig(IDLE).camera)[0];
  // the left lean mirrors the right one (polish round R8): the same slide and turn, so the opponent
  // moves a little less of the width toward the own side (the camera looks across to the right at
  // rest): ≥ 1/5 at the dodge level, 1/4–1/3 at full
  for (const [lean, lo, hi] of [[0.42, 0.22, 0.3], [-0.42, 0.2, 0.3], [1, 0.3, 0.36], [-1, 0.25, 0.34]]) {
    const settled = Math.abs(pct(H2, liveRig(IDLE, { lean: { x: lean, y: 0, z: 0 } }).camera)[0] - x0) / 100;
    const early = Math.abs(pct(H2, liveRig(IDLE, { lean: { x: lean, y: 0, z: 0 }, sec: 0.15 }).camera)[0] - x0) / 100;
    assert(settled >= lo && settled <= hi, `lean ${lean}: slide ${settled.toFixed(3)} of the width (want ${lo}–${hi})`);
    assert(early >= 0.88 * settled, `lean ${lean}: most of it within 0.15 s (${early.toFixed(3)})`);
  }
  const r = liveRig(IDLE, { lean: { x: 1, y: 0, z: 0 } });
  assert(pct(H2, r.camera)[0] < x0, 'leaning right moves the opponent left on screen');
});

test('view3d-fix: the own meter anchor lands at the reference pie spot (25–32 % across, 58–65 % down)', () => {
  const A = RENDER_TUNING.meterAnchor;
  // P1 faces −Z: right = +X, forward = −Z
  const p = new THREE.Vector3(LAYOUT.p1Pos[0] + A[0], A[1], LAYOUT.p1Pos[2] - A[2]);
  const [x, y] = pct(p, liveRig(IDLE).camera);
  assert(x >= 25 && x <= 32 && y >= 58 && y <= 65, `meter anchor at (${x.toFixed(1)}, ${y.toFixed(1)}) %`);
});

test('view3d-fix: player-hit cut stays a hard cut from the new live pose — tight, solid, own head at the top', () => {
  const c = ctxFor(IDLE);
  const rig = new CameraRig({ side: 'p1' });
  for (let i = 0; i < 60; i++) rig.update(DT, c);
  const live = rig.camera.position.clone();
  const head = c.head.p1;
  for (let n = 0; n < 2; n++) {
    rig.hitCut({ heavy: false });
    rig.update(DT, c); rig.update(DT, c);
    assert.equal(rig.shot, Shot.HIT);
    assert.equal(rig.wantsGhost, false, 'solid player');
    const cam = rig.camera;
    assert(cam.position.distanceTo(live) >= 0.38, `cut ${n}: ${cam.position.distanceTo(live).toFixed(2)} m from the live pose (old tuning: 0.17 m)`);
    assert(cam.position.distanceTo(head) < live.distanceTo(head), `cut ${n}: tighter than the live view`);
    const own = box(IDLE.p1, cam, 'head');
    assert(centre(own)[1] < 35, `cut ${n}: own head in the top of the frame (${centre(own)[1].toFixed(1)} %)`);
    const opp = box(IDLE.p2, cam);
    assert(opp[2] > 0 && opp[0] < 100 && opp[3] > 0, `cut ${n}: opponent in frame`);
    const face = faceOf(box(IDLE.p2, cam, 'head'));
    assert(covered(face, [own]) <= 0.2, `cut ${n}: the opponent's face stays readable beside the own head`);
    for (let i = 0; i < 40; i++) rig.update(DT, c);
    assert.equal(rig.shot, Shot.PLAY);
  }
});

test('view3d-fix: the "fight" settle shot starts close behind the head, on the live side, and settles exactly into the live pose', () => {
  const rig = new CameraRig({ side: 'p1' });
  const c = ctxFor(IDLE, { phase: MatchPhase.ROUND_START, stage: 'fight' });
  rig.update(DT, ctxFor(IDLE, { phase: MatchPhase.ROUND_START, stage: 'ring' }));
  rig.update(DT, c);
  assert.equal(rig.shot, Shot.BEHIND);
  const start = rig.camera.position.clone();
  const live = liveRig(IDLE).camera.position;
  const head = c.head.p1;
  assert(start.distanceTo(head) < live.distanceTo(head) - 0.15, 'a close-up first');
  assert(start.x < head.x, 'on the live camera\'s side');
  for (let t = 0; t < RIG_TUNING.behind.dur + 0.1; t += DT) rig.update(DT, c);
  assert(rig.camera.position.distanceTo(live) < 0.02, 'settled into the live view');
});

test('view3d-fix VISUAL-01: the decision shot cuts straight in and stays inside the ropes at any arena yaw', () => {
  const rig = new CameraRig({ side: 'p1' });
  const c = ctxFor(IDLE);
  for (let i = 0; i < 60; i++) rig.update(DT, c);
  rig.update(DT, ctxFor(IDLE, { phase: MatchPhase.DECISION, stage: 'decision', phaseTime: 0, stageTime: 0 }));
  assert.equal(rig.shot, Shot.DECISION);
  const head = c.head.p1;
  // the first DECISION frame: the player is solid now, so the lens must not be at its head
  assert(rig.wantsGhost || rig.camera.position.distanceTo(head) > 1.2, `solid player head ${rig.camera.position.distanceTo(head).toFixed(2)} m from the lens`);
  assert.equal(rig.settled, 1, 'a hard cut');
  let worst = 0;
  for (let i = 0; i < 150; i++) {
    rig.update(DT, ctxFor(IDLE, { phase: MatchPhase.DECISION, stage: 'decision', phaseTime: i / 60, stageTime: i / 60 }));
    const p = rig.camera.position;
    if (p.y < 1.5) worst = Math.max(worst, Math.hypot(p.x, p.z));
  }
  assert(worst <= RIG_TUNING.insideRadius + 1e-6, `decision camera at r = ${worst.toFixed(2)} m (ropes at ${LAYOUT.ringHalf} m; was 3.41 m)`);
  // both fighters framed, heads above the centred DECISION call
  for (const id of ['p1', 'p2']) {
    const h = box(IDLE[id], rig.camera, 'head');
    assert(h[0] > 0 && h[2] < 100 && centre(h)[1] < 40, `${id} head framed above the call (${centre(h).map((v) => v.toFixed(1))})`);
  }
});

test('view3d-fix VISUAL-09: knockdown wide shot — the standing player large under the count, the downed fighter high and beside its head', () => {
  const p1Pos = new THREE.Vector3(0, 0, LAYOUT.p1Pos[2] + RENDER_TUNING.kd.humanStay);
  const m = fighters({ p1View: view({ isHuman: true, hands: HANDS.idle }), p2View: (t) => view({ phase: BoxerPhase.DOWN, phaseProgress: Math.min(1, t) }), p1Pos, sec: 3 });
  m.p1.setGhost(false);
  const rig = new CameraRig({ side: 'p1' });
  const c = ctxFor(m, { phase: MatchPhase.KNOCKDOWN, stage: 'count', downed: 'p2', phaseTime: 2, stageTime: 0 });
  for (let t = 0; t < 4.2; t += DT) rig.update(DT, c); // about count 3
  assert.equal(rig.shot, Shot.KD_WIDE);
  const cam = rig.camera;
  const S = box(m.p1, cam), D = box(m.p2, cam), H = box(m.p1, cam, 'head');
  assert(S[3] - S[1] >= 55, `standing player ${(S[3] - S[1]).toFixed(1)} % of the frame tall (was 43 %)`);
  assert(centre(D)[1] <= 35, `downed fighter high in the frame (centre ${centre(D)[1].toFixed(1)} % down)`);
  assert(overlapArea(H, D) <= 0.1 * (D[2] - D[0]) * (D[3] - D[1]), 'the standing head does not hide the downed fighter');
  assert(S[1] < COUNT[1] + 5 && S[3] > COUNT[3] - 5, 'the count lands over the standing player');
  const dir = cam.getWorldDirection(new THREE.Vector3());
  const pitch = Math.asin(-dir.y) * 180 / Math.PI;
  assert(pitch >= 30 && pitch <= 46, `looking down ~35–45° (${pitch.toFixed(1)}°; was 53°)`);
});

test('view3d-fix Q1: player down — opponent waiting in the upper part, right of the centred count; the player in the foreground', () => {
  const p2Pos = new THREE.Vector3(0, 0, LAYOUT.p2Pos[2] - RENDER_TUNING.kd.aiFar);
  const m = fighters({ p1View: (t) => view({ isHuman: true, phase: BoxerPhase.DOWN, phaseProgress: Math.min(1, t) }), p2Pos, p1Fall: 'front', sec: 3 });
  m.p1.setGhost(false);
  const rig = new CameraRig({ side: 'p1' });
  const c = ctxFor(m, { phase: MatchPhase.KNOCKDOWN, stage: 'count', downed: 'p1', phaseTime: 2, stageTime: 0 });
  for (let t = 0; t < 2; t += DT) rig.update(DT, c);
  assert.equal(rig.shot, Shot.PLAYER_DOWN);
  const cam = rig.camera;
  const O = box(m.p2, cam), D = box(m.p1, cam);
  const under = overlapArea(O, COUNT) / ((O[2] - O[0]) * (O[3] - O[1]));
  assert(under <= 0.1, `${Math.round(under * 100)} % of the opponent under the count (was its torso)`);
  assert(O[1] >= -2 && O[3] <= 55, `opponent in the upper part (y ${O[1].toFixed(1)}–${O[3].toFixed(1)} %)`);
  assert(D[1] >= 45, `the downed player in the lower foreground (top ${D[1].toFixed(1)} %)`);
  assert(cam.position.distanceTo(c.body.p1) < cam.position.distanceTo(c.pos.p2), 'player nearer the lens');
});

test('view3d-fix VISUAL-02: the KO replay\'s low angle keeps the loser off the attacker (both outcomes)', () => {
  for (const [att, los] of [['p1', 'p2'], ['p2', 'p1']]) {
    const m = fighters();
    m.p1.setGhost(false);
    const A = m[att].object3d.position, L = m[los].object3d.position;
    for (const sw of [0, 0.5, 1]) {
      const pose = replayCameraPose('low', A, L, sw, { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, roll: 0 });
      const cam = new THREE.PerspectiveCamera(pose.fov, 16 / 9, 0.05, 200);
      cam.position.copy(pose.pos); cam.lookAt(pose.target); cam.updateMatrixWorld();
      const a = box(m[att], cam), l = box(m[los], cam);
      const hidden = overlapArea(a, l) / ((a[2] - a[0]) * (a[3] - a[1]));
      assert(hidden <= 0.5, `${att} wins, k ${sw}: attacker box ${Math.round(hidden * 100)} % behind the loser's (old pose: ~100 %)`);
      const face = headWorldPosition(m[los], new THREE.Vector3(), { front: true });
      const [fx, fy] = pct(face, cam);
      assert(fx > 10 && fx < 90 && fy > 5 && fy < 70, `the loser's face (the contact point) in frame (${fx.toFixed(1)}, ${fy.toFixed(1)})`);
      assert(pose.pos.y >= 0.6 && pose.pos.y <= 1.0, 'still a low angle');
    }
  }
});

test('view3d-fix VISUAL-04: the banner camera puts the winner\'s face above the win banner text (28–48 % down)', () => {
  const O = RENDER_TUNING.outro;
  const w = new BoxerModel(DEFAULT_PLAYER, { seed: 3 });
  w.object3d.position.fromArray(O.winnerPos); w.object3d.rotation.set(0, 0, 0);
  for (let t = 0; t < 1.5; t += DT) w.update(view({ isHuman: true, phase: BoxerPhase.VICTORY, phaseProgress: Math.min(1, t / 1.5), expression: 'happy' }), DT);
  w.object3d.updateWorldMatrix(true, true);
  for (const aspect of [16 / 9, 4 / 3]) {
    for (const k of [0, 1]) {
      const pose = outroStagePose('banner', w.object3d.position, k, { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, roll: 0 });
      const cam = new THREE.PerspectiveCamera(pose.fov, aspect, 0.05, 200);
      cam.position.copy(pose.pos); cam.lookAt(pose.target); cam.updateMatrixWorld();
      const [hx, hy] = pct(headWorldPosition(w, new THREE.Vector3()), cam);
      assert(hy < 26, `aspect ${aspect.toFixed(2)}, k ${k}: head ${hy.toFixed(1)} % down (was 42 %)`);
      assert(hy > 3 && hx > 30 && hx < 70, 'still framed');
    }
  }
});
