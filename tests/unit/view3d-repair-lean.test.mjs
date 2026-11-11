// view3d repair round — R6, RV-VISUAL-01 / RV-VISUAL-02: the live camera's lean follow on the real
// boxer models in Node (no WebGL). Which of the player's own parts hides the opponent's face depends
// only on where the camera STANDS, so occlusion is measured in 3D: the opponent's visible face (rays
// from the lens across its head that first meet the skull carrying the face, its own hair and gloves
// in front excluded, as the visual re-verify's harness measures it) against the player's own head
// meshes (see-through head, hair, ears) and glove meshes (solid gloves, thumbs, cuffs), exact mesh
// ray casts (polish round: the level camera passes the guard closely, where the bounding spheres the
// repair round used, 1–2 cm fatter than the parts, misread the cover). Screen positions are
// percentages of the viewport's width; versus halves are 638×720 at the versus fov, as
// renderer._drawSplit draws them.
// Polish round (R8): the camera's left lean is the mirror image of its right one (a level slide and
// turn), so a left lean carries the opponent's face behind the player's own see-through head and
// guard, and the viewer's own gloves and see-through head fade while they overlap the face
// (render/own-fade.js, run here exactly as the renderer runs it). A glove faded to ≤ 0.35 opacity
// counts as see-through, so the bounds below are on the face under OPAQUE own parts (R8: ≤ 0.15 for
// a held lean); the see-through head may cover ≤ 0.25 of it or must be faded. The hook-lunge check
// moved to view3d-repair-polish-fade.test.mjs (every frame, exact casts, leans −0.42 / −0.7 / −1).
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import * as rigModule from '../../src/render/camera-rig.js';
import { BoxerModel, placeBoxer, headWorldPosition, bodyWorldPosition } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';
import { RENDER_TUNING } from '../../src/render/renderer.js';
import { MatchPhase } from '../../src/core/types.js';
import { OwnFade } from '../../src/render/own-fade.js';

const { CameraRig, RIG_TUNING, leanSlide } = rigModule;
const DT = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);
// keyboard idle / high guard hands, and the camera-mode high guard read from the synthetic pipeline
const HANDS = {
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
  camHigh: { left: { x: -0.16, y: 0.45, reach: 0.15 }, right: { x: 0.19, y: 0.37, reach: 0.19 } },
};
const SINGLE = { aspect: 16 / 9, versus: false };
const HALF = { aspect: 638 / 720, versus: true };

const view = (o = {}) => ({ phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, punches: null, windup: null, hitReact: null, isHuman: false, hp01: 1, hp: 10, expression: 'neutral', ...o });
const other = (id) => (id === 'p1' ? 'p2' : 'p1');

/**
 * The player (`me`, ghosted, a held sideways lean like the renderer stages it: the model's own lean
 * in its DODGE phase plus the renderer's root sidestep) and the opponent in a high guard, leaning
 * `foeLean` in its own frame (versus: both players lean). `foeView` (t → BoxerView) animates the
 * opponent after the stance has settled.
 */
function fighters({ me = 'p1', hands = 'idle', lean = 0, foeLean = 0, foeView = null, foeSec = 0 } = {}) {
  const models = {};
  models[me] = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 });
  models[other(me)] = new BoxerModel(PRESETS[11], { seed: 2 });
  placeBoxer(models.p1, 'p1'); placeBoxer(models.p2, 'p2');
  const right = me === 'p1' ? 1 : -1; // the player's right in world X (the opponent's right is the other way)
  models[me].object3d.position.x += right * lean * RENDER_TUNING.leanRootShift;
  models[other(me)].object3d.position.x -= right * foeLean * RENDER_TUNING.leanRootShift;
  models.p1.setFoe(models.p2); models.p2.setFoe(models.p1);
  const mine = view({ isHuman: true, hands: HANDS[hands], guard: hands === 'idle' ? 'none' : 'high', lean: { x: lean, y: 0, z: 0 }, phase: Math.abs(lean) >= 0.42 ? 'dodge' : 'idle' });
  const theirs = view({ guard: 'high', lean: { x: foeLean, y: 0, z: 0 }, phase: Math.abs(foeLean) >= 0.42 ? 'dodge' : 'idle' });
  for (let t = 0; t < 1.2; t += DT) { models[me].update(mine, DT); models[other(me)].update(theirs, DT); }
  for (let t = 0; t < foeSec - 1e-9; t += DT) { models[me].update(mine, DT); models[other(me)].update(foeView(t), DT); }
  models.p1.object3d.updateWorldMatrix(true, true); models.p2.object3d.updateWorldMatrix(true, true);
  return { ...models, me, foe: other(me) };
}

function ctxFor(m, lean, versus, foeLean = 0) {
  return {
    mode: 'match', phase: MatchPhase.FIGHTING, phaseTime: 2, stage: 'live', stageTime: 2, versus, downed: null, koLoser: null, winner: null,
    pos: { p1: m.p1.object3d.position.clone(), p2: m.p2.object3d.position.clone() }, yaw: { p1: Math.PI, p2: 0 },
    lean: { [m.me]: { x: lean, y: 0, z: 0 }, [m.foe]: { x: foeLean, y: 0, z: 0 } },
    head: { p1: headWorldPosition(m.p1, new THREE.Vector3()), p2: headWorldPosition(m.p2, new THREE.Vector3()) },
    body: { p1: bodyWorldPosition(m.p1, new THREE.Vector3()), p2: bodyWorldPosition(m.p2, new THREE.Vector3()) },
    focus: null, shake: { x: 0, y: 0, roll: 0 },
  };
}

/**
 * The player's live camera after `sec` of a held lean (the rig's own smoothing settled), with the
 * own-part fade run every frame as the renderer runs it (`rig.fade`: the last fade values).
 */
function liveCam(m, lean, { aspect, versus }, { sec = 1.5, reducedMotion = false, foeLean = 0 } = {}) {
  const rig = new CameraRig({ side: m.me, aspect });
  rig.reducedMotion = reducedMotion;
  const c = ctxFor(m, lean, versus, foeLean);
  const fade = new OwnFade();
  for (let t = 0; t < sec - 1e-9; t += DT) {
    rig.update(DT, c);
    rig.camera.updateMatrixWorld();
    fade.update(DT, rig.camera, m[m.me], m[m.foe], rig.ownShift);
  }
  rig.camera.updateMatrixWorld();
  rig.fade = { ...fade.value };
  return rig;
}

/**
 * The player's own head meshes or glove meshes (`fade`: gloves faded to see-through, opacity ≤ 0.35,
 * are left out — R8).
 */
function ownMeshes(model, part, fade = null) {
  const out = [];
  if (part === 'head') model._head.traverse((o) => { if (o.isMesh && o.visible) out.push(o); });
  else model.object3d.traverse((o) => { if (o.isMesh && o.visible && (o.userData.mat === 'gloves' || o.userData.mat === 'cuff') && !(fade && 1 - 0.7 * (fade[o.userData.part] ?? 0) <= 0.35)) out.push(o); });
  return out;
}

const _ray = new THREE.Raycaster();
const meshesOf = (root, keep = () => true) => { const a = []; root.traverse((o) => { if (o.isMesh && o.visible && keep(o)) a.push(o); }); return a; };

/**
 * The opponent's visible face as the skeptic's harness defines it: rays from the lens across the
 * opponent's head (a 17 × 17 grid over its skull's bounding disc), kept where the first opponent
 * surface they meet is the 'head'-material skull that carries the face — so its own hair, ears and
 * gloves in front, or its punching arm, are excluded. Returns the face points.
 */
function visibleFace(model, cam) {
  const all = meshesOf(model.object3d);
  const skull = meshesOf(model._skull, (o) => o.userData.mat === 'head')[0];
  skull.geometry.computeBoundingSphere();
  const bs = skull.geometry.boundingSphere.clone().applyMatrix4(skull.matrixWorld);
  const ahead = bs.center.clone().sub(cam.position).normalize();
  const u = new THREE.Vector3().crossVectors(ahead, UP).normalize(), w = new THREE.Vector3().crossVectors(u, ahead);
  const pts = [];
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
    const a = i / 8 - 1, b = j / 8 - 1;
    if (a * a + b * b > 1) continue;
    const aim = bs.center.clone().addScaledVector(u, a * bs.radius).addScaledVector(w, b * bs.radius);
    _ray.set(cam.position, aim.sub(cam.position).normalize()); _ray.near = 0; _ray.far = Infinity;
    const first = _ray.intersectObjects(all, false)[0];
    if (first && first.object.userData.mat === 'head') pts.push(first.point.clone());
  }
  return pts;
}

const _hit = new THREE.Raycaster();
/** Does the segment from the lens to `p` cross any of `meshes`? */
function blocked(from, p, meshes) {
  if (!meshes.length) return false;
  const d = p.clone().sub(from); const len = d.length();
  _hit.set(from, d.divideScalar(len)); _hit.near = 0; _hit.far = len - 1e-4;
  return _hit.intersectObjects(meshes, false).length > 0;
}

/**
 * Share of the opponent's visible face hidden by the own head / OPAQUE gloves / either (exact casts;
 * `fade` = the own-part fade, gloves faded to see-through left out), its point count and the share
 * of it inside the frame.
 */
function faceCover(m, cam, fade = null) {
  const pts = visibleFace(m[m.foe], cam);
  const head = ownMeshes(m[m.me], 'head'), gloves = ownMeshes(m[m.me], 'gloves', fade);
  let h = 0, g = 0, any = 0, inFrame = 0;
  for (const p of pts) {
    const bh = blocked(cam.position, p, head), bg = blocked(cam.position, p, gloves);
    h += bh; g += bg; any += bh || bg;
    const q = p.clone().project(cam);
    if (q.z < 1 && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1) inFrame++;
  }
  const n = Math.max(1, pts.length);
  return { n: pts.length, head: h / n, gloves: g / n, any: any / n, inFrame: inFrame / n };
}

/** R8's readable face: ≤ 15 % under opaque own gloves; the see-through head ≤ 25 % or faded. */
function assertReadable(c, fade, tag) {
  assert(c.gloves <= 0.15, `${tag}: ${pct(c.gloves)} of the face behind opaque own gloves (R8 ≤ 15 %; fade ${JSON.stringify(fade)})`);
  assert(c.head <= 0.25 || (fade && fade.head >= 0.9), `${tag}: ${pct(c.head)} of the face behind the own see-through head, not faded (${fade?.head})`);
}

/** Opponent's skull centre, % of the viewport's width from the left. */
const skullX = (m, cam) => (headWorldPosition(m[m.foe], new THREE.Vector3()).project(cam).x + 1) * 50;

const pct = (v) => `${Math.round(v * 100)} %`;

test('view3d-repair RV-VISUAL-01 / R8: a held left lean keeps the opponent\'s face readable — off the opaque own guard, the own see-through head faded where it covers it (keyboard and camera hands)', () => {
  for (const hands of ['idle', 'high', 'camHigh']) {
    for (const lean of [-1, -0.8, -0.6, -0.42]) {
      const m = fighters({ hands, lean });
      const rig = liveCam(m, lean, SINGLE);
      const c = faceCover(m, rig.camera, rig.fade);
      assert(c.inFrame >= 0.95, `${hands} lean ${lean}: the opponent's face in the frame (${pct(c.inFrame)})`);
      assertReadable(c, rig.fade, `${hands} lean ${lean} (pre-repair, unfaded: up to 82 % behind the own head and 82 % behind the high guard at −1)`);
    }
  }
});

test('view3d-repair RV-VISUAL-02: versus halves — a full lean either way keeps the opponent inside the leaning player\'s half, face clear (P1 and P2)', () => {
  for (const me of ['p1', 'p2']) {
    const m0 = fighters({ me });
    const x0 = skullX(m0, liveCam(m0, 0, HALF).camera);
    assert(x0 >= 40 && x0 <= 60, `${me}: opponent near the middle of the half at rest (${x0.toFixed(1)} %)`);
    for (const hands of ['idle', 'high']) {
      for (const lean of [-1, 1]) {
        const m = fighters({ me, hands, lean });
        const rig = liveCam(m, lean, HALF), cam = rig.camera;
        const x = skullX(m, cam), c = faceCover(m, cam, rig.fade);
        assert(x >= 15 && x <= 85, `${me} ${hands} lean ${lean}: skull at ${x.toFixed(1)} % of the half (pre-repair: ${lean < 0 ? '112' : '−10'} %)`);
        assert(c.inFrame >= 0.95, `${me} ${hands} lean ${lean}: the face inside the half (${pct(c.inFrame)}; pre-repair: 0 %)`);
        assertReadable(c, rig.fade, `${me} ${hands} lean ${lean}`);
      }
    }
  }
});

test('view3d-repair RV-VISUAL-02 / R6: versus halves — when both players lean the same way at once, the opponent still stays inside the half', () => {
  // the opponent's own full lean carries its head another ≈15–22 % of the half; the view turns just
  // enough to keep it within 17–83 % (turning never changes which own part hides it)
  for (const me of ['p1', 'p2']) {
    for (const lean of [-1, 1]) {
      const m = fighters({ me, hands: 'high', lean, foeLean: lean });
      const rig = liveCam(m, lean, HALF, { foeLean: lean }), cam = rig.camera;
      const x = skullX(m, cam), c = faceCover(m, cam, rig.fade);
      assert(x >= 15 && x <= 85, `${me} both lean ${lean}: skull at ${x.toFixed(1)} % of the half (pre-repair: ${lean < 0 ? '133' : '−37'} %)`);
      assert(c.inFrame >= 0.95, `${me} both lean ${lean}: the face inside the half (${pct(c.inFrame)}; pre-repair: 0 %)`);
      // the opponent's own lean carries its head behind the guard: geometry can't, the fade does (R8)
      assertReadable(c, rig.fade, `${me} both lean ${lean}`);
    }
  }
});

test('view3d-repair RV-VISUAL-02: versus halves — a dodge-level lean (0.42) slides the opponent 1/5–1/3 of the half, a full lean 1/4 to ~1/3', () => {
  // R8 (polish): the dodge level ≥ 1/5 of the view (the level camera without the old head-tilt roll
  // puts the half's dodge-level slide at ≈ 0.248 instead of 0.258)
  const m0 = fighters();
  const x0 = skullX(m0, liveCam(m0, 0, HALF).camera);
  for (const [lean, lo, hi] of [[0.42, 0.2, 0.334], [-0.42, 0.2, 0.334], [1, 0.25, 0.345], [-1, 0.25, 0.345]]) {
    const m = fighters({ lean });
    const slide = Math.abs(skullX(m, liveCam(m, lean, HALF).camera) - x0) / 100;
    assert(slide >= lo && slide <= hi, `lean ${lean}: slide ${slide.toFixed(3)} of the half (BASE: 0.44–0.64)`);
  }
});

test('view3d-repair R6: the 16:9 view keeps its rest framing and right-lean follow; the own side slides 1/4–1/3 at a full lean, ≥ 1/5 at 0.42; 4:3 slides the same share', () => {
  const F = RIG_TUNING.play.follow, P = RIG_TUNING.play;
  // right leans in the 16:9 view: the tuned metres for the camera and the same turn as the pre-repair
  // pose (polish R8: the look target now stays at its rest distance, so the pitch stays level)
  for (const lean of [0, 0.21, 0.42, 0.7, 1]) {
    const rig = liveCam(fighters(), lean, SINGLE, { sec: 3 });
    const lx = leanSlide(rigModule.leanDeadzone(lean));
    const want = new THREE.Vector3(P.offset[0] + lx * F.x, P.offset[1], 0.575 + P.offset[2]);
    assert(rig.pose.pos.distanceTo(want) < 1e-3, `lean ${lean}: camera at ${rig.pose.pos.toArray().map((v) => v.toFixed(3))}`);
    const tgt = new THREE.Vector3(P.lookAt[0] + lx * F.lookX, P.lookAt[1], 0.575 - P.lookAt[2]);
    const d = rig.pose.target.clone().sub(rig.pose.pos), e = tgt.clone().sub(want);
    const yaw = (v) => Math.atan2(v.x, -v.z);
    assert(Math.abs(yaw(d) - yaw(e)) < 1e-4, `lean ${lean}: the look turns as before (${(yaw(d) * 180 / Math.PI).toFixed(3)}° vs ${(yaw(e) * 180 / Math.PI).toFixed(3)}°)`);
    assert(Math.abs(Math.atan2(-d.y, Math.hypot(d.x, d.z)) - Math.atan2(P.offset[1] - P.lookAt[1], Math.hypot(P.lookAt[0] - P.offset[0], P.lookAt[2] + P.offset[2]))) < 1e-6, `lean ${lean}: the rest pitch`);
  }
  for (const vp of [SINGLE, { aspect: 4 / 3, versus: false }]) {
    const m0 = fighters();
    const x0 = skullX(m0, liveCam(m0, 0, vp).camera);
    const slide = (lean) => { const m = fighters({ lean }); return Math.abs(skullX(m, liveCam(m, lean, vp).camera) - x0) / 100; };
    const full = slide(-1), knee = slide(-0.42), right = slide(1);
    assert(full >= 0.25 && full <= 0.334, `aspect ${vp.aspect.toFixed(2)}: a full left lean slides ${full.toFixed(3)} of the width (BASE 16:9: 0.357, 4:3: 0.477)`);
    assert(knee >= 0.2, `aspect ${vp.aspect.toFixed(2)}: a dodge-level left lean slides ${knee.toFixed(3)} (≥ 1/5)`);
    assert(right >= 0.3 && right <= 0.345, `aspect ${vp.aspect.toFixed(2)}: a full right lean slides ${right.toFixed(3)} (BASE 4:3: 0.442)`);
  }
  // ultrawide 21:9 (integrator, view3d verifier polish): the own-side swing takes the uncapped ratio, so a left
  // lean still slides 1/4–1/3 of THIS width (before: 0.220 / 0.161); its right side keeps the 16:9 metres
  const UW = { aspect: 2560 / 1080, versus: false };
  const u0 = skullX(fighters(), liveCam(fighters(), 0, UW).camera);
  const uSlide = (lean) => { const m = fighters({ hands: 'high', lean }); const rig = liveCam(m, lean, UW); return { s: Math.abs(skullX(m, rig.camera) - u0) / 100, c: faceCover(m, rig.camera, rig.fade), fade: rig.fade }; };
  const uFull = uSlide(-1), uKnee = uSlide(-0.42);
  assert(uFull.s >= 0.25 && uFull.s <= 0.334, `21:9: a full left lean slides ${uFull.s.toFixed(3)} of the width`);
  assert(uKnee.s >= 0.2, `21:9: a dodge-level left lean slides ${uKnee.s.toFixed(3)} (≥ 1/5)`);
  assertReadable(uFull.c, uFull.fade, '21:9 full left lean'); assertReadable(uKnee.c, uKnee.fade, '21:9 dodge-level left lean');
});

test('view3d-repair R6: reduced motion keeps no roll and a gentler slide, and the opponent\'s face stays readable', () => {
  const m0 = fighters();
  const x0 = skullX(m0, liveCam(m0, 0, SINGLE).camera);
  const m = fighters({ hands: 'high', lean: -1 });
  const full = liveCam(m, -1, SINGLE), calm = liveCam(m, -1, SINGLE, { reducedMotion: true });
  assert.equal(calm.pose.roll, 0, 'no head-tilt roll');
  const sFull = Math.abs(skullX(m, full.camera) - x0), sCalm = Math.abs(skullX(m, calm.camera) - x0);
  assert(sCalm < sFull, `gentler slide (${sCalm.toFixed(1)} vs ${sFull.toFixed(1)} % of the width)`);
  const c = faceCover(m, calm.camera, calm.fade);
  assertReadable(c, calm.fade, 'reduced motion, full left lean (pre-repair: 100 % behind own parts)');
});

test('view3d-repair R6: the follow scale is the viewport\'s horizontal field against the 16:9 / 58° view', () => {
  const f = rigModule.viewportFollowScale;
  assert.equal(typeof f, 'function', 'camera-rig exports viewportFollowScale');
  assert(Math.abs(f(58, 16 / 9) - 1) < 1e-9 && f(58, 2560 / 1080) === 1, '16:9 and wider: the tuned metres');
  assert(Math.abs(f(58, 4 / 3) - 0.75) < 1e-9, '4:3: 0.75');
  const v = f(RIG_TUNING.play.versusFov, 638 / 720);
  assert(v > 0.55 && v < 0.57, `versus half: ${v.toFixed(3)}`);
  assert.equal(f(58, 0), 1, 'a degenerate aspect falls back to 1');
});
