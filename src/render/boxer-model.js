// Procedural boxer model + animation (owner: characters).
//
// A very basic, friendly toy boxer built from a handful of smooth primitives: an egg head
// with a painted face (render/face.js), a short neck, a tapered torso, capsule limbs,
// oversized glossy gloves, trunks with a contrasting waistband and rounded shoes. Also the
// trainer (cap + whistle, mitt anchors). There is no referee (research/mechanics.md C12: the
// count is numbers + voice), so there is no referee role.
//
// Driving it: call update(view, dt) every render frame with the boxer's BoxerView
// (see core/types.js). Everything is procedural — no clips:
//   * gloves follow BoxerView.hands (boxer perspective, shoulder-width units) through an
//     analytic two-bone IK, shaped toward a readable guard (COM03);
//   * punches (COM01/COM02) fly along per-kind arcs (straight/hook/uppercut, head/body) to
//     the opponent's head/body at LAYOUT.fighterGap, with body twist, step-in and
//     follow-through; AI windups are big, readable telegraphs (shoulder pull-back, cocked
//     glove, body twist, glove shake) so they read through webcam latency;
//   * lean x/y/z (COM04) moves torso/head: slips, ducks, forward/back;
//   * hit reactions (UI03) are directional impulses on critically damped springs: head snap
//     for straights/hooks/uppercuts, body fold for body shots, glove push for blocks;
//   * DAZED wobble, DOWN fall (backwards or to the knees), GETUP (one knee, then up), KO
//     (limp, stays down), VICTORY (gloves up, hops), DEFEAT (slump) (MAT02/MAT03).
// Every channel runs through critically damped springs, so 30 Hz input looks fluid at
// 60 fps; punches use stiff springs (snappy out) and softer ones on the way back.
//
// Local space: the model faces local +Z, +Y up, so the boxer's RIGHT is local −X.
// Place it with placeBoxer(model, 'p1'|'p2') or object3d.position + object3d.lookAt(foe).
//
// Imports cleanly in Node: no DOM access at import or construction time except through
// face.js, which returns null textures when there is no canvas.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BoxerPhase } from '../core/types.js';
import { LAYOUT, PLAYER_GHOST_OPACITY, vinyl, leather } from './style.js';
import { validateAppearance, TRAINER } from './appearance.js';
import {
  acquireFaceTexture, releaseFaceTexture, faceUV, HEAD_SHAPE, normalizeExpression, shadeHex, mixHex, luminance,
} from './face.js';

// ───────────────────────────── tunables ─────────────────────────────

/** Body proportions in metres at height scale 1.0, average build. */
export const BODY = Object.freeze({
  hipHeight: 0.645,       // pelvis centre when standing tall
  crouch: 0.03,           // fighting-stance knee bend
  hipJointX: 0.085, hipJointY: -0.03,
  thigh: 0.29, shin: 0.285, ankleY: 0.08,
  spineY: 0.05,           // waist pivot above the pelvis centre
  shoulderX: 0.195, shoulderY: 0.33, shoulderZ: -0.005,
  neckY: 0.395, neckLen: 0.06,
  headR: 0.162,           // horizontal head radius (HEAD_SHAPE gives the egg proportions)
  headLift: 0.172,        // skull centre above the top of the neck
  headFwd: 0.02,
  upperArm: 0.25, foreArm: 0.235, gloveOffset: 0.1,   // wrist → glove centre
  gloveR: 0.118,          // oversized gloves
  handR: 0.055,           // bare hands (trainer)
  armR: 0.06, foreR: 0.056, thighR: 0.086, shinR: 0.068,
  shortsLen: 0.17,        // boxing-trunk leg sleeve length
  stanceWidth: 0.13, stanceLead: 0.09, stanceRear: -0.08,
});

/** Build variations (scales relative to BODY / average). */
export const BUILDS = Object.freeze({
  slim: { torsoW: 0.9, torsoD: 0.6, belly: 0, limb: 0.88, shoulder: 0.95, head: 0.98, neck: 0.9, hips: 0.92 },
  average: { torsoW: 1, torsoD: 0.64, belly: 0, limb: 1, shoulder: 1, head: 1, neck: 1, hips: 1 },
  heavy: { torsoW: 1.13, torsoD: 0.76, belly: 0.03, limb: 1.2, shoulder: 1.06, head: 1.03, neck: 1.18, hips: 1.1 },
});

/** Animation tunables (seconds, radians, metres, spring ω in rad/s). */
export const ANIM = {
  // springs
  wBody: 12, wSpine: 14, wHead: 15, wGlove: 26, wGlovePunch: 70, wGloveBack: 15, wFoot: 22, wFall: 26,
  wSpinePunch: 42, wBodyPunch: 36, wGesture: 34,
  // The player's own boxer (R11): stiffer springs on the channels that follow the tracked body while
  // it moves, so it shows with little lag on top of the camera and tracking delay (a critically
  // damped spring's ramp lag is 2/ω: gloves 40 ms, head 50, spine 65, hips 67 ms; the AI keeps the
  // springs above). Only while a channel runs its default spring: punches, falls, get-ups and
  // gestures keep theirs. See `track` for how still poses stay calm.
  // Input round (merge-refix): the rule is the brief's — the total lag of the own boxer (the recognizer's
  // own lag + these springs) no worse than the polish build's, then as little frame-to-frame motion as
  // that allows. The gloves keep the polish ω 50: the merged recognizer's hand lag is unchanged
  // (12–20 ms), so 35 ms ramp lag ≈ 55 ms in all, as before. Its lean is 10 ms earlier (R4's leanLead:
  // 14 → 4 ms), which pays for softer spine / hips: 31 / 30 (polish 36 / 32) keep every lean figure
  // within polish + 10 ms — a lean at 0.5/s 54 → 61 ms (in all ≈ 65 against 68), the fast dodge's head
  // 37/67 → 42/77 ms (its 90 % point is the binding one), the hips 45/82 → 48/89 — and take the head's
  // motion on the replayed real clip from 2.47× to 2.27× BASE (gloves 1.89 / 2.21×; the polish values on
  // the polish recognizer: 2.04 / 2.10 / 1.92×). The merge-fix's 47 / 40 / 28 / 25 (2.08 / 2.07×) cost
  // the gloves 3 ms and the head 9 ms more than the polish build. Curve (real clip, 2 loops, × BASE, ω 50
  // gloves): spine / hips 36 / 32 → head 2.47, lean 54 ms; 32.4 / 28.8 → 2.28, 61 ms (hips dodge
  // 51/94: over); 31 / 30 → 2.27, 61 ms; 29.5 / 29.5 → 2.22, 64 ms (head dodge 44/80: over); 28 / 25 →
  // 2.07, 73 ms. wHeadHuman 34–50 moves the head's motion by ≤ 0.03× (it is the spine and the hips).
  wGloveHuman: 50, wHeadHuman: 40, wSpineHuman: 31, wBodyHuman: 30,
  /**
   * The human's tracking filter (R11), one-euro style: each channel's spring runs between its
   * `still` ω and the stiff ω above (`w…Human`) by how fast its input moves — the hand's spine-space
   * target per glove (m/s), the lean for the head, spine and hips (lean units/s), each a signed
   * velocity smoothed over `tau` s so noise averages out and a real move doesn't: below `glove[0]` /
   * `lean[0]` still, from `glove[1]` / `lean[1]` up fully stiff. The still springs are calmer than
   * the default ones for the gloves (15 against 26; the gloves now follow the hands in full, noise
   * included) and equal to them for the head, spine and hips (15 / 14 / 12). A held guard
   * (`guardGlove`, `still.guardGlove` 9) is mostly still and the drawn guard pose used to hide 70 %
   * of its hands' noise, so there the gloves need a little more speed and are calmer at rest. Below
   * `rate.below` s between new input samples (a camera under 24 Hz: a slow machine) ω is capped at
   * `rate.glove` / `rate.body` ÷ that interval — about the default springs at 15 Hz — so its samples
   * never show as steps (30 Hz and faster: no cap). Measured (view3d-repair-polish-boxer.test.mjs,
   * 30 Hz input): a hand moving 0.12 m/s or faster lags ≈ 30–35 ms (in a held guard from 0.23 m/s), a
   * lean at 0.5/s or faster ≈ 57–61 ms. The price of calm still poses: a hand drifting as slowly as
   * tracking noise moves (≈ 0.06 m/s, a held guard ≈ 0.12 m/s) is smoothed like a still pose (≈ 90–
   * 100 ms, i.e. 6–11 mm behind), and on a constantly moving real replay the gloves and head show
   * about twice the frame-to-frame motion of the repair round's softer springs (they follow the
   * moves it smoothed away: see the R11 handoff's lag / jitter curve).
   */
  track: {
    tau: 0.3, glove: [0.04, 0.14], guardGlove: [0.07, 0.22], lean: [0.08, 0.4],
    still: { glove: 15, guardGlove: 9, head: 15, spine: 14, body: 12 },
    rate: { below: 1 / 24, glove: 1.75, body: 1 },
    hitHold: 0.7,
  },
  // idle
  bobHz: 1.65, bobAmp: 0.012, swayHz: 0.5, swayAmp: 0.012,
  // hands → gloves
  // the gloves follow the player's tracked hands all the way (R11: within 2 cm of HandState)
  handsWeightHuman: 1, handsWeightAI: 0.55,
  aiGuardX: 0.175, aiGuardY: 0.475, // the opponent's high guard: gloves beside the jaw, face clear
  blockCatch: 0.32,                  // s the opponent's gloves close in front of the face when it blocks
  handScaleX: 0.95, handScaleY: 1.0, guardZ: 0.27, reachZ: 0.66,
  // a human's guard: the guard's posture cues (elbows in, chin down, a slight crouch) at this weight,
  // and the gloves pulled toward the drawn guard pose by only guardGloveHuman — they stay where the
  // player's hands are (R11; the opponent's guard is drawn fully)
  guardBlendHuman: 0.7, guardGloveHuman: 0,
  // lean
  leanSideShift: 0.07, leanSideRoll: 0.2, leanHipRoll: 0.08, leanHeadCounter: 0.55,
  duckDrop: 0.17, duckPitch: 0.34, leanFwdShift: 0.07, leanFwdPitch: 0.2,
  // punches
  punchOutTime: 0.16,     // fallback out-stroke when the view gives no progress
  punchBackTime: 0.24,    // retract time when the view gives no RECOVER phase
  punchReachAt: 0.88,     // progress at which the glove arrives
  maxStretch: 1.22,       // cartoon arm stretch allowed at full extension
  impactSink: 0.55,       // fraction of glove radius that sinks into the target (squash look)
  blockBounce: 1.6,       // m/s glove kick-back when the punch was blocked
  missOvershoot: 0.1, missOvershootTime: 0.07, // whiffs sail past the target before retracting
  twist: { straight: 0.6, hook: 0.85, uppercut: 0.5 },
  step: { straight: 0.19, hook: 0.17, uppercut: 0.15 }, // lunge toward the opponent
  // AI windup telegraph (≥0.28 s from game/ai.js)
  windupRamp: 0.3, windupShakeHz: 13, windupShakeAmp: 0.014,
  tellMin: 0.7, tellMax: 1.25, // clamp for the AI's per-opponent tell scale (pullback / shoulder)
  // hit reactions (impulse velocities, scaled by strength)
  hit: {
    straight: { headPitch: -9, spinePitch: -2.6, hipsZ: -0.5, headYaw: 1.5 },
    hook: { headYaw: 10, headRoll: 6.5, spineYaw: 2.6, hipsX: 0.35 },
    uppercut: { headPitch: -13, spinePitch: -2.4, hipsY: 0.45 },
    body: { spinePitch: 6.5, headPitch: 4, hipsZ: -0.45, gloveDrop: 1.4 },
    blocked: { glovePush: 1.8, spinePitch: -1.5, hipsZ: -0.22 },
  },
  flashTime: 0.13, squash: 0.13,
  fill: 0.07, skinFill: 0.13,   // emissive self-fill (fraction of albedo)
  // falls & get-up (own clock; the count can last up to 10 s)
  fallBackTime: 0.95, fallKneesTime: 0.95, getupTime: 1.25,
  // locomotion (auto-step when the renderer moves the model)
  walkSpeedMin: 0.35, walkSmooth: 0.35, stride: 0.5,  // auto-step when the renderer walks the model
  blinkMin: 2.2, blinkMax: 5.0, blinkDur: 0.11,
};

/** Expressions painted at construction (the rest are painted on first use). */
const PREWARM_EXPRESSIONS = ['neutral', 'neutral-blink', 'focus', 'focus-blink', 'hurt'];

/**
 * The player's own gloves stay SOLID in ghost mode (research/mechanics.md §6 "Live fight": the
 * body is about 50% transparent, the gloves are solid and large in the foreground). In the ghost
 * set they are fully opaque but sorted after the translucent body (renderOrder) so the player's
 * own see-through head never veils them; they still write depth, so the opponent hides them
 * correctly.
 */
export const GHOST_GLOVE_OPACITY = 1;
/**
 * Own-part fade look (R8, setOwnFade): a faded own glove's opacity (≤ 0.35 reads as see-through) and
 * the factor on the see-through head's ghost opacity while it covers the opponent's face (0.1: the
 * veil it leaves on the face changes the face's mean brightness by ≈ 64–69 × the head's opacity
 * factor, i.e. ≈ 3–6 of 255 once faded; ≤ 8 needs the fade ≥ 0.98, which own-fade.js's fast
 * fade-in reaches within ≈ 2–3 frames while the view turns toward its own side or the opponent's
 * punch comes).
 */
export const OWN_FADE_LOOK = Object.freeze({
  glove: 0.3, head: 0.1,
  // the face sphere partSpheres() reports: its centre in the skull's own (unit-sphere) frame, front
  // and a little down, and its radius as a share of the skull's bounding radius
  face: Object.freeze({ fwd: 0.5, down: -0.2, r: 0.75 }),
});
/** Materials that stay opaque when the model is ghosted (the gloves and their cuff band). */
const GHOST_SOLID = new Set(['gloves', 'cuff']);
/** Opaque-looking (opacity 1) but drawn in the transparent pass after the ghost body, writing depth. */
function solidOnTop(m) { m.transparent = true; m.opacity = 1; m.depthWrite = true; return m; }
/**
 * Ghost "hologram" falloff: opacity × lerp(core, rim, fresnel²). With PLAYER_GHOST_OPACITY 0.5
 * the body reads about half transparent (a little clearer in the middle, firmer at the
 * silhouette); the head/hair are the thinnest because they sit in the sight line to the
 * opponent's face.
 */
export const GHOST_FRESNEL = Object.freeze({ body: [0.78, 1.45], head: [0.4, 1.3] });

/** World bounding sphere {c, r} of a mesh (its geometry's sphere through the world matrix). */
function sphereOf(mesh, out) {
  const g = mesh.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  out.c.copy(g.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
  out.r = g.boundingSphere.radius * mesh.matrixWorld.getMaxScaleOnAxis();
  return out;
}

/** Inject a view-angle (fresnel) alpha falloff into a transparent standard/physical material. */
function ghostFresnel(material, core, rim) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
      {
        vec3 ghostView = normalize( vViewPosition );
        float ghostF = 1.0 - abs( dot( normalize( normal ), ghostView ) );
        gl_FragColor.a = clamp( gl_FragColor.a * mix( ${core.toFixed(3)}, ${rim.toFixed(3)}, ghostF * ghostF ), 0.0, 1.0 );
      }`);
  };
  material.customProgramCacheKey = () => `ghost-fresnel-${core}-${rim}`;
}

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (t, p = 2) => 1 - Math.pow(1 - clamp(t, 0, 1), p);
const easeIn = (t, p = 2) => Math.pow(clamp(t, 0, 1), p);
const num = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const other = (hand) => (hand === 'right' ? 'left' : 'right');
const HANDS = ['left', 'right'];

// scratch
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();
const _e0 = new THREE.Euler();
const _c0 = new THREE.Color(), _c1 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// ───────────────────────────── springs ─────────────────────────────

/** Fresh state of the human's tracking filter (BoxerModel._trackInput). */
function newTrack() {
  const ch = () => ({ p: new THREE.Vector3(), v: new THREE.Vector3() });
  return { on: false, ok: false, guard: false, left: ch(), right: ch(), body: ch(), mu: { left: 1, right: 1, body: 1 }, last: -1, interval: 1 / 30, capGlove: Infinity, capBody: Infinity, hitUntil: -Infinity };
}
/** Boxer phases in which a human boxer's tracked body drives it (BoxerModel._trackInput). */
const LIVE_PHASES = new Set([BoxerPhase.IDLE, BoxerPhase.GUARD, BoxerPhase.PUNCH, BoxerPhase.RECOVER, BoxerPhase.DODGE]);

/** Critically damped spring (exact integration — stable for any dt). */
class Spring1 {
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(target, omega, dt) {
    const x0 = this.x - target;
    const e = Math.exp(-omega * dt);
    const tmp = (this.v + omega * x0) * dt;
    this.x = target + (x0 + tmp) * e;
    this.v = (this.v - omega * tmp) * e;
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
}
class Spring3 {
  constructor(x = 0, y = 0, z = 0) { this.x = new THREE.Vector3(x, y, z); this.v = new THREE.Vector3(); }
  step(target, omega, dt) {
    const e = Math.exp(-omega * dt);
    for (const k of ['x', 'y', 'z']) {
      const x0 = this.x[k] - target[k];
      const tmp = (this.v[k] + omega * x0) * dt;
      this.x[k] = target[k] + (x0 + tmp) * e;
      this.v[k] = (this.v[k] - omega * tmp) * e;
    }
    return this.x;
  }
  snap(v) { this.x.copy(v); this.v.set(0, 0, 0); }
}

// ───────────────────────────── pose ─────────────────────────────

/** Full-body pose. Rotations are Euler (x = pitch fwd+, y = yaw left+, z = roll right+). */
class Pose {
  constructor() {
    this.rigPos = new THREE.Vector3();
    this.hipsPos = new THREE.Vector3(0, BODY.hipHeight, 0);
    this.hipsRot = new THREE.Vector3();
    this.spineRot = new THREE.Vector3();
    this.headRot = new THREE.Vector3();
    this.glove = { left: new THREE.Vector3(), right: new THREE.Vector3() };   // spine space
    this.elbow = { left: new THREE.Vector3(1, -1, 0), right: new THREE.Vector3(-1, -1, 0) }; // pole dirs
    this.roll = { left: 0, right: 0 };          // glove roll about the forearm
    this.shoulder = { left: 0, right: 0 };      // shoulder protraction (m, forward)
    this.foot = { left: new THREE.Vector3(), right: new THREE.Vector3() };    // rig space ankles
    this.knee = { left: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(0, 0, 1) };
    this.footYaw = { left: 0, right: 0 };
    this.footFlat = { left: 1, right: 1 };
  }
  copy(p) {
    this.rigPos.copy(p.rigPos); this.hipsPos.copy(p.hipsPos); this.hipsRot.copy(p.hipsRot);
    this.spineRot.copy(p.spineRot); this.headRot.copy(p.headRot);
    for (const h of HANDS) {
      this.glove[h].copy(p.glove[h]); this.elbow[h].copy(p.elbow[h]); this.roll[h] = p.roll[h];
      this.shoulder[h] = p.shoulder[h]; this.foot[h].copy(p.foot[h]); this.knee[h].copy(p.knee[h]);
      this.footYaw[h] = p.footYaw[h]; this.footFlat[h] = p.footFlat[h];
    }
    return this;
  }
  /** this = lerp(a, b, t) */
  lerpPoses(a, b, t) {
    this.rigPos.lerpVectors(a.rigPos, b.rigPos, t); this.hipsPos.lerpVectors(a.hipsPos, b.hipsPos, t);
    this.hipsRot.lerpVectors(a.hipsRot, b.hipsRot, t); this.spineRot.lerpVectors(a.spineRot, b.spineRot, t);
    this.headRot.lerpVectors(a.headRot, b.headRot, t);
    for (const h of HANDS) {
      this.glove[h].lerpVectors(a.glove[h], b.glove[h], t); this.elbow[h].lerpVectors(a.elbow[h], b.elbow[h], t);
      this.roll[h] = lerp(a.roll[h], b.roll[h], t); this.shoulder[h] = lerp(a.shoulder[h], b.shoulder[h], t);
      this.foot[h].lerpVectors(a.foot[h], b.foot[h], t); this.knee[h].lerpVectors(a.knee[h], b.knee[h], t);
      this.footYaw[h] = lerp(a.footYaw[h], b.footYaw[h], t); this.footFlat[h] = lerp(a.footFlat[h], b.footFlat[h], t);
    }
    return this;
  }
}

/**
 * Keyframe pose from a compact description. Arrays are [x,y,z]; gloves/elbows/feet/knees
 * as {l:[...], r:[...]} in boxer-left = +X convention.
 */
function keyPose(d, base) {
  const p = new Pose();
  if (base) p.copy(base);
  if (d.rig) p.rigPos.fromArray(d.rig);
  if (d.hips) p.hipsPos.fromArray(d.hips);
  if (d.hipsRot) p.hipsRot.fromArray(d.hipsRot);
  if (d.spine) p.spineRot.fromArray(d.spine);
  if (d.head) p.headRot.fromArray(d.head);
  const pair = (src, dst) => { if (src) { dst.left.fromArray(src.l); dst.right.fromArray(src.r); } };
  pair(d.glove, p.glove); pair(d.elbow, p.elbow); pair(d.foot, p.foot); pair(d.knee, p.knee);
  if (d.roll) { p.roll.left = d.roll[0]; p.roll.right = d.roll[1]; }
  if (d.flat) { p.footFlat.left = d.flat[0]; p.footFlat.right = d.flat[1]; }
  if (d.footYaw) { p.footYaw.left = d.footYaw[0]; p.footYaw.right = d.footYaw[1]; }
  return p;
}

// Knockdown/get-up keyframes (rig/spine space, boxer's left = +X). Times are seconds for
// falls and 0..1 progress for the get-up. Tuned against dev/models.html screenshots.
const FALL_BACK = [
  { t: 0.16, ease: 'out', pose: { hips: [0, 0.6, -0.1], hipsRot: [-0.28, 0, 0.06], spine: [-0.3, 0.05, 0], head: [-0.65, 0.15, 0.1],
    glove: { l: [0.34, 0.72, 0.1], r: [-0.32, 0.66, 0.16] }, elbow: { l: [1, 0.2, -0.4], r: [-1, 0.2, -0.4] },
    foot: { l: [0.14, 0.078, 0.1], r: [-0.15, 0.078, -0.24] }, knee: { l: [0.1, 0, 1], r: [-0.1, 0, 1] } } },
  { t: 0.44, ease: 'in', pose: { hips: [0, 0.24, -0.36], hipsRot: [-0.85, 0, 0.05], spine: [-0.32, 0, 0], head: [-0.35, 0.1, 0],
    glove: { l: [0.36, 0.56, 0.22], r: [-0.36, 0.5, 0.26] }, elbow: { l: [1, 0, -0.3], r: [-1, 0, -0.3] },
    foot: { l: [0.16, 0.078, 0.14], r: [-0.17, 0.078, 0.02] }, knee: { l: [0.2, 0.6, 1], r: [-0.2, 0.6, 1] } } },
  { t: 0.62, ease: 'in', pose: { hips: [0, 0.13, -0.5], hipsRot: [-1.5, 0, 0], spine: [-0.06, 0, 0], head: [0.1, 0.25, 0],
    glove: { l: [0.46, 0.4, -0.04], r: [-0.46, 0.36, -0.02] }, elbow: { l: [1, -0.4, -0.6], r: [-1, -0.4, -0.6] },
    foot: { l: [0.17, 0.078, 0.2], r: [-0.18, 0.078, 0.16] }, knee: { l: [0.2, 1, 0.4], r: [-0.2, 1, 0.4] } } },
  { t: 0.74, ease: 'out', pose: { hips: [0, 0.19, -0.52], hipsRot: [-1.36, 0, 0.04], spine: [-0.12, 0, 0], head: [0.2, 0.3, 0],
    glove: { l: [0.47, 0.46, 0.06], r: [-0.47, 0.42, 0.08] }, elbow: { l: [1, -0.4, -0.6], r: [-1, -0.4, -0.6] },
    foot: { l: [0.17, 0.09, 0.18], r: [-0.18, 0.09, 0.12] }, knee: { l: [0.2, 1, 0.4], r: [-0.2, 1, 0.4] } } },
  { t: 0.95, ease: 'inout', pose: { hips: [0, 0.13, -0.52], hipsRot: [-1.5, 0, 0.02], spine: [-0.06, 0, 0], head: [0.05, 0.42, 0.1],
    glove: { l: [0.47, 0.42, -0.05], r: [-0.46, 0.4, -0.04] }, elbow: { l: [1, -0.4, -0.6], r: [-1, -0.4, -0.6] },
    foot: { l: [0.2, 0.078, -0.02], r: [-0.16, 0.078, 0.12] }, knee: { l: [0.3, 1, 0.2], r: [-0.2, 1, 0.3] } } },
];
const FALL_KNEES = [
  { t: 0.18, ease: 'out', pose: { hips: [0, 0.6, -0.06], hipsRot: [0.15, 0, 0], spine: [0.6, 0, 0], head: [0.35, 0, 0],
    glove: { l: [0.1, 0.1, 0.22], r: [-0.1, 0.12, 0.2] }, elbow: { l: [1, -1, -0.2], r: [-1, -1, -0.2] },
    foot: { l: [0.14, 0.078, 0.1], r: [-0.14, 0.078, -0.12] }, knee: { l: [0.1, 0, 1], r: [-0.1, 0, 1] } } },
  { t: 0.5, ease: 'in', pose: { hips: [0, 0.4, -0.02], hipsRot: [0.25, 0, 0], spine: [0.5, 0, 0.05], head: [0.4, 0.1, 0],
    glove: { l: [0.14, 0.12, 0.3], r: [-0.14, 0.1, 0.28] }, elbow: { l: [1, -1, 0], r: [-1, -1, 0] },
    foot: { l: [0.14, 0.07, -0.32], r: [-0.14, 0.07, -0.34] }, knee: { l: [0.1, -0.6, 1], r: [-0.1, -0.6, 1] }, flat: [0, 0] } },
  { t: 0.72, ease: 'out', pose: { hips: [0, 0.36, 0.0], hipsRot: [0.5, 0, 0.04], spine: [0.55, 0.1, 0.08], head: [0.55, 0.15, 0.1],
    glove: { l: [0.2, 0.25, 0.5], r: [-0.18, 0.2, 0.52] }, elbow: { l: [1, -0.6, 0], r: [-1, -0.6, 0] },
    foot: { l: [0.14, 0.07, -0.34], r: [-0.14, 0.07, -0.36] }, knee: { l: [0.1, -0.6, 1], r: [-0.1, -0.6, 1] }, flat: [0, 0] } },
  { t: 0.95, ease: 'inout', pose: { hips: [0, 0.38, -0.02], hipsRot: [0.45, 0, 0.04], spine: [0.5, 0.1, 0.06], head: [0.6, 0.1, 0.12],
    glove: { l: [0.2, 0.22, 0.46], r: [-0.18, 0.18, 0.48] }, elbow: { l: [1, -0.6, 0], r: [-1, -0.6, 0] },
    foot: { l: [0.14, 0.07, -0.34], r: [-0.14, 0.07, -0.36] }, knee: { l: [0.1, -0.6, 1], r: [-0.1, -0.6, 1] }, flat: [0, 0] } },
];
// Get-up from the back: sit up → one knee → stand (progress 0..1; final pose is the live stance)
const GETUP_BACK = [
  { t: 0.3, ease: 'inout', pose: { hips: [0, 0.15, -0.42], hipsRot: [-0.55, 0, 0], spine: [0.42, 0, 0], head: [0.25, 0, 0],
    glove: { l: [0.3, 0.02, -0.12], r: [-0.3, 0.02, -0.12] }, elbow: { l: [1, 0, -1], r: [-1, 0, -1] },
    foot: { l: [0.17, 0.078, -0.06], r: [-0.17, 0.078, -0.1] }, knee: { l: [0.2, 1, 0.5], r: [-0.2, 1, 0.5] } } },
  { t: 0.62, ease: 'inout', pose: { hips: [0, 0.44, -0.18], hipsRot: [0.18, 0, 0], spine: [0.22, 0, 0], head: [0.1, 0, 0],
    glove: { l: [0.18, 0.05, 0.3], r: [-0.16, 0.25, 0.25] }, elbow: { l: [1, -1, 0], r: [-1, -1, 0] },
    foot: { l: [0.15, 0.078, 0.14], r: [-0.13, 0.07, -0.5] }, knee: { l: [0.1, 0.2, 1], r: [-0.1, -0.7, 1] }, flat: [1, 0] } },
];
const GETUP_KNEES = [
  { t: 0.4, ease: 'inout', pose: { hips: [0, 0.44, -0.1], hipsRot: [0.2, 0, 0], spine: [0.25, 0, 0], head: [0.15, 0, 0],
    glove: { l: [0.18, 0.05, 0.32], r: [-0.16, 0.25, 0.26] }, elbow: { l: [1, -1, 0], r: [-1, -1, 0] },
    foot: { l: [0.15, 0.078, 0.18], r: [-0.13, 0.07, -0.42] }, knee: { l: [0.1, 0.2, 1], r: [-0.1, -0.7, 1] }, flat: [1, 0] } },
];

// Face-down fall (the player's own knockdowns, research/mechanics.md §3.5 / §6 "Player knocked
// down": a low shot with the player face-down in the foreground): knees buckle, the body topples
// forward onto the gloves and settles prone with the head turned to the side.
const FALL_FRONT = [
  { t: 0.16, ease: 'out', pose: { hips: [0, 0.55, 0.06], hipsRot: [0.32, 0, 0], spine: [0.5, 0, 0], head: [0.3, 0, 0],
    glove: { l: [0.2, 0.26, 0.32], r: [-0.2, 0.24, 0.3] }, elbow: { l: [1, -1, 0], r: [-1, -1, 0] },
    foot: { l: [0.14, 0.078, 0.1], r: [-0.14, 0.078, -0.1] }, knee: { l: [0.1, 0, 1], r: [-0.1, 0, 1] } } },
  { t: 0.42, ease: 'in', pose: { hips: [0, 0.37, 0.16], hipsRot: [0.72, 0, 0.04], spine: [0.6, 0, 0], head: [0.1, 0.2, 0],
    glove: { l: [0.26, 0.42, 0.36], r: [-0.26, 0.4, 0.34] }, elbow: { l: [1, -0.6, -0.2], r: [-1, -0.6, -0.2] },
    foot: { l: [0.14, 0.07, -0.18], r: [-0.14, 0.07, -0.22] }, knee: { l: [0.1, -0.6, 1], r: [-0.1, -0.6, 1] }, flat: [0, 0] } },
  { t: 0.64, ease: 'in', pose: { hips: [0, 0.15, 0.42], hipsRot: [1.46, 0, 0.03], spine: [0.06, 0, 0], head: [-0.45, 0.75, 0],
    glove: { l: [0.31, 0.56, 0.08], r: [-0.31, 0.52, 0.08] }, elbow: { l: [1, 0.2, -0.6], r: [-1, 0.2, -0.6] },
    foot: { l: [0.16, 0.078, -0.14], r: [-0.16, 0.078, -0.12] }, knee: { l: [0.1, -1, 0.1], r: [-0.1, -1, 0.1] }, flat: [0, 0] } },
  { t: 0.77, ease: 'out', pose: { hips: [0, 0.2, 0.43], hipsRot: [1.36, 0, 0.03], spine: [0.1, 0, 0], head: [-0.5, 0.8, 0],
    glove: { l: [0.32, 0.56, 0.1], r: [-0.32, 0.52, 0.1] }, elbow: { l: [1, 0.2, -0.6], r: [-1, 0.2, -0.6] },
    foot: { l: [0.16, 0.085, -0.13], r: [-0.16, 0.085, -0.11] }, knee: { l: [0.1, -1, 0.1], r: [-0.1, -1, 0.1] }, flat: [0, 0] } },
  { t: 0.95, ease: 'inout', pose: { hips: [0, 0.145, 0.44], hipsRot: [1.49, 0, 0.02], spine: [0.05, 0, 0], head: [-0.42, 0.88, 0.08],
    glove: { l: [0.33, 0.57, 0.08], r: [-0.31, 0.5, 0.09] }, elbow: { l: [1, 0.2, -0.6], r: [-1, 0.2, -0.6] },
    foot: { l: [0.17, 0.078, -0.14], r: [-0.15, 0.078, -0.1] }, knee: { l: [0.1, -1, 0.1], r: [-0.1, -1, 0.1] }, flat: [0, 0] } },
];
// Get-up from face-down: push up onto hands and knees → one knee → stand
const GETUP_FRONT = [
  { t: 0.32, ease: 'inout', pose: { hips: [0, 0.42, 0.12], hipsRot: [0.78, 0, 0], spine: [0.52, 0, 0], head: [-0.25, 0, 0],
    glove: { l: [0.2, 0.22, 0.42], r: [-0.2, 0.22, 0.42] }, elbow: { l: [1, 0, -0.4], r: [-1, 0, -0.4] },
    foot: { l: [0.14, 0.07, -0.34], r: [-0.14, 0.07, -0.36] }, knee: { l: [0.1, -0.6, 1], r: [-0.1, -0.6, 1] }, flat: [0, 0] } },
  { t: 0.62, ease: 'inout', pose: { hips: [0, 0.44, -0.1], hipsRot: [0.2, 0, 0], spine: [0.25, 0, 0], head: [0.15, 0, 0],
    glove: { l: [0.18, 0.05, 0.32], r: [-0.16, 0.25, 0.26] }, elbow: { l: [1, -1, 0], r: [-1, -1, 0] },
    foot: { l: [0.15, 0.078, 0.18], r: [-0.13, 0.07, -0.42] }, knee: { l: [0.1, 0.2, 1], r: [-0.1, -0.7, 1] }, flat: [1, 0] } },
];

const FALL_BACK_POSES = FALL_BACK.map((k) => ({ ...k, pose: keyPose(k.pose) }));
const FALL_FRONT_POSES = FALL_FRONT.map((k) => ({ ...k, pose: keyPose(k.pose) }));
const GETUP_FRONT_POSES = GETUP_FRONT.map((k) => ({ ...k, pose: keyPose(k.pose) }));
/** Fall styles a renderer may force with setFallStyle(). */
export const FALL_STYLES = Object.freeze(['back', 'knees', 'front']);
const FALL_KNEES_POSES = FALL_KNEES.map((k) => ({ ...k, pose: keyPose(k.pose) }));
const GETUP_BACK_POSES = GETUP_BACK.map((k) => ({ ...k, pose: keyPose(k.pose) }));
const GETUP_KNEES_POSES = GETUP_KNEES.map((k) => ({ ...k, pose: keyPose(k.pose) }));

function ease(kind, t) {
  switch (kind) {
    case 'in': return easeIn(t, 2);
    case 'out': return easeOut(t, 2);
    case 'inout': return smooth(t);
    default: return clamp(t, 0, 1);
  }
}

/** Sample keyframes: keys start at t=0 with `start`; past the last key holds it. */
function sampleKeys(out, start, keys, t) {
  let prevT = 0, prev = start;
  for (const k of keys) {
    if (t <= k.t) return out.lerpPoses(prev, k.pose, ease(k.ease, (t - prevT) / Math.max(1e-6, k.t - prevT)));
    prevT = k.t; prev = k.pose;
  }
  return out.copy(prev);
}

// ───────────────────────────── shared geometry ─────────────────────────────

const geoCache = new Map();
function useGeo(key, make, owner) {
  let e = geoCache.get(key);
  if (!e) { e = { geo: make(), refs: 0 }; e.geo.name = key; geoCache.set(key, e); }
  e.refs++;
  owner.push(key);
  return e.geo;
}
function releaseGeos(keys) {
  for (const key of keys) {
    const e = geoCache.get(key);
    if (!e) continue;
    if (--e.refs <= 0) { e.geo.dispose(); geoCache.delete(key); }
  }
  keys.length = 0;
}
/** Number of live shared geometries (debug/tests). */
export function sharedGeometryCount() { return geoCache.size; }

/** Unit-sphere → egg head deformation (narrower jaw, calmer face plane). */
function headDeform(x, y, z, out) {
  const below = Math.max(0, -y);
  const sx = 1 - 0.15 * Math.pow(below, 1.7);
  const sz = 1 - 0.07 * Math.pow(below, 1.7);
  const front = Math.max(0, z);
  const fz = 1 - 0.06 * front * front * front;
  return out.set(x * sx, y, z * sz * fz);
}

function makeHeadGeometry() {
  const g = new THREE.SphereGeometry(1, 56, 40);
  g.rotateX(Math.PI / 2); // poles → front (+Z, face centre) and back (−Z)
  const pos = g.attributes.position, uv = g.attributes.uv, nrm = g.attributes.normal;
  const n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), p = new THREE.Vector3();
  const eps = 1e-3;
  for (let i = 0; i < pos.count; i++) {
    n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const az = uv.getX(i) * TAU + Math.PI; // azimuth fallback exactly at the poles
    const [u, v] = faceUV(n.x, n.y, n.z, az);
    uv.setXY(i, u, v);
    headDeform(n.x, n.y, n.z, p);
    pos.setXYZ(i, p.x, p.y, p.z);
    // normal of the deformed surface by finite differences in the tangent plane
    t1.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) t1.set(1, 0, 0);
    t1.cross(n).normalize(); t2.crossVectors(n, t1);
    headDeform(n.x + t1.x * eps, n.y + t1.y * eps, n.z + t1.z * eps, a);
    headDeform(n.x - t1.x * eps, n.y - t1.y * eps, n.z - t1.z * eps, b);
    headDeform(n.x + t2.x * eps, n.y + t2.y * eps, n.z + t2.z * eps, c);
    headDeform(n.x - t2.x * eps, n.y - t2.y * eps, n.z - t2.z * eps, d);
    a.sub(b); c.sub(d);
    const nn = a.cross(c).normalize();
    if (nn.dot(p) < 0) nn.negate();
    nrm.setXYZ(i, nn.x, nn.y, nn.z);
  }
  pos.needsUpdate = true; uv.needsUpdate = true; nrm.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** Smooth closed-normals helper for untextured procedural shapes (welds seams, recomputes normals). */
function smoothed(g) {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  m.computeVertexNormals();
  g.dispose();
  return m;
}

/**
 * Hair cap: a sphere cap around +Y, tilted back by `tilt`, radius `r` with extra `bulge`
 * toward the crown and the rim tucked into the head so the hairline reads cleanly.
 */
function makeHairCap({ r = 1.05, bulge = 0.04, beta = 84, tilt = 26, tuck = 0.985, phiStart = 0, phiLength = TAU, segW = 64, segH = 34, flare = 0 }) {
  const betaR = THREE.MathUtils.degToRad(beta);
  const g = new THREE.SphereGeometry(1, segW, segH, phiStart, phiLength, 0, betaR);
  const pos = g.attributes.position;
  const v = new THREE.Vector3(), out = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const theta = Math.acos(clamp(v.y, -1, 1));
    const f = theta / betaR; // 0 crown → 1 rim
    let rad = r + bulge * (1 - f * f) + flare * f * f * f;
    const rim = smooth((f - 0.82) / 0.18);
    rad = lerp(rad, tuck, rim);
    v.multiplyScalar(rad);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.rotateX(-THREE.MathUtils.degToRad(tilt));
  for (let i = 0; i < pos.count; i++) {
    headDeform(pos.getX(i), pos.getY(i), pos.getZ(i), out);
    pos.setXYZ(i, out.x, out.y, out.z);
  }
  return smoothed(g);
}

function makeLathe(profile, segments = 40) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y));
  return new THREE.LatheGeometry(pts, segments);
}

function torsoProfile(B) {
  const w = B.torsoW, belly = B.belly;
  return [
    [0.145 * w, -0.1], [0.148 * w + belly * 0.6, 0.0], [0.153 * w + belly, 0.07], [0.165 * w + belly * 0.7, 0.145],
    [0.183 * w, 0.22], [0.194 * w, 0.275], [0.195 * w, 0.32], [0.183 * w, 0.36], [0.155 * w, 0.395],
    [0.11 * w, 0.418], [0.06 * w, 0.428], [0.0, 0.43],
  ];
}
/** Front surface z of the torso at spine-space height y (for buttons, zips, ties). */
function torsoFrontZ(B, y) {
  const prof = torsoProfile(B);
  for (let i = 1; i < prof.length; i++) {
    const [r1, y1] = prof[i - 1], [r2, y2] = prof[i];
    if (y <= y2) return lerp(r1, r2, clamp((y - y1) / (y2 - y1), 0, 1)) * B.torsoD;
  }
  return 0;
}
function trunksProfile(B, long) {
  // bottom → top (LatheGeometry needs ascending profiles for outward-facing normals)
  const w = B.hips;
  const bottom = long ? -0.1 : -0.13;
  return [
    [0.0, bottom - 0.016], [0.13 * w, bottom - 0.01], [0.196 * w, bottom], [0.205 * w, bottom + 0.025],
    [0.198 * w, -0.11], [0.18 * w, -0.03], [0.166 * w, 0.06], [0.158 * w, 0.13], [0.12 * w, 0.134], [0.0, 0.135],
  ];
}

function makeGloveGeometry() {
  // main mitt: a slightly squashed sphere, fuller at the knuckles
  const g = new THREE.SphereGeometry(1, 36, 28);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const front = Math.max(0, z);
    x *= 0.93 + 0.05 * front; y *= 0.86 + 0.06 * front; z *= 1.08;
    pos.setXYZ(i, x, y, z + 0.04);
  }
  g.computeVertexNormals();
  return smoothed(g);
}

function makeStarGeometry() {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + Math.PI / 2;
    const r = i % 2 === 0 ? 1 : 0.45;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 2 });
  g.center();
  return g;
}

// ───────────────────────────── IK ─────────────────────────────

const _ikD = new THREE.Vector3(), _ikP = new THREE.Vector3();
/**
 * Analytic two-bone IK. root/target/pole in the same space (pole = direction hint).
 * Writes the joint (elbow/knee) into outMid and the end (clamped to reach) into outEnd.
 * @returns {number} stretch factor applied to both bones (≥1)
 */
export function solveTwoBone(root, target, pole, a, b, maxStretch, outMid, outEnd) {
  _ikD.subVectors(target, root);
  let d = _ikD.length();
  if (d < 1e-6) { _ikD.set(0, -1, 0); d = 1e-6; } else _ikD.multiplyScalar(1 / d);
  let stretch = 1;
  if (d > a + b) { stretch = Math.min(maxStretch, d / (a + b)); a *= stretch; b *= stretch; }
  const dc = clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-5);
  const cosA = clamp((a * a + dc * dc - b * b) / (2 * a * dc), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _ikP.copy(pole).addScaledVector(_ikD, -pole.dot(_ikD));
  if (_ikP.lengthSq() < 1e-8) { _ikP.set(0, 0, 1).addScaledVector(_ikD, -_ikD.z); if (_ikP.lengthSq() < 1e-8) _ikP.set(1, 0, 0); }
  _ikP.normalize();
  outMid.copy(root).addScaledVector(_ikD, a * cosA).addScaledVector(_ikP, a * sinA);
  outEnd.copy(root).addScaledVector(_ikD, dc);
  return stretch;
}

/** Place a Y-axis capsule/cylinder mesh between two points; `len` = geometry's nominal length. */
function placeBetween(mesh, p, q, len) {
  _v5.subVectors(q, p);
  const d = _v5.length();
  mesh.position.addVectors(p, q).multiplyScalar(0.5);
  if (d > 1e-6) mesh.quaternion.setFromUnitVectors(UP, _v5.multiplyScalar(1 / d));
  mesh.scale.set(1, len > 0 ? Math.max(0.2, d / len) : 1, 1);
}

// ───────────────────────────── view normalisation ─────────────────────────────

const PHASES = new Set(Object.values(BoxerPhase));
const KINDS = new Set(['straight', 'hook', 'uppercut']);

function readHand(h) {
  if (!h || typeof h !== 'object') return null;
  const x = num(h.x, NaN), y = num(h.y, NaN), reach = num(h.reach, 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, -3, 3), y: clamp(y, -4, 4), reach: clamp(reach, 0, 1.2), punching: !!h.punching };
}

// ───────────────────────────── the model ─────────────────────────────

export class BoxerModel {
  /**
   * @param {import('../core/types.js').Appearance} appearance
   * @param {{ghost?:boolean, role?:'boxer'|'trainer', shadows?:boolean, stars?:boolean, seed?:number}} [opts]
   *   (a legacy role 'referee' builds a plain boxer — there is no referee in the ring any more)
   */
  constructor(appearance, opts = {}) {
    this.role = opts.role === 'trainer' ? 'trainer' : 'boxer';
    const fallback = this.role === 'trainer' ? TRAINER : undefined;
    this.appearance = validateAppearance(appearance ?? fallback, fallback);
    this.shadows = opts.shadows !== false;
    this._withStars = opts.stars !== false;
    this.ghost = false;
    /** The own-part fade last applied (setOwnFade): 0 = the normal ghost look. */
    this.ownFade = { left: 0, right: 0, head: 0 };
    this.build = BUILDS[this.appearance.build] ?? BUILDS.average;
    this._seed = (opts.seed ?? 0) | 0;
    this._geoKeys = [];
    this._meshes = [];
    this._faceTex = new Map();
    this._manualExpr = null;
    this._shownExpr = '';
    this._time = (this._seed % 97) * 0.173; // de-sync idle bobs between models
    this._phase = BoxerPhase.IDLE;
    this._phaseT = 0;
    this._lastHitAge = Infinity;
    this._lastHit = null;
    this._fallStyle = 'back';
    this._fallPref = null;
    this._fallEntry = new Pose();
    this._getupEntry = new Pose();
    this._lastPhaseProgress = 0;
    this._punch = { left: this._newPunchState(), right: this._newPunchState() };
    this._windup = { hand: 'right', kind: 'straight', target: 'head', t: 0 };
    this._handOverride = { left: null, right: null };
    this._lookTarget = null;
    this._gesture = null;
    this._foe = null;
    this._blink = { next: 2 + (this._seed % 5) * 0.5, t: -1 };
    this._flash = 0;
    this._walk = { phase: 0, w: 0, last: null, vel: new THREE.Vector3() };
    this._track = newTrack();
    this._tailSpring = new Spring3();
    this._dizzy = new Spring1(0);
    this._squash = new Spring1(0);

    // pose state
    this._tgt = new Pose();
    this._tmpPose = new Pose();
    this._sp = this._makeSprings();
    this._stancePose(this._tgt, this._defaultView(), 0);
    this._snapSprings(this._tgt);

    this._buildRig();
    this._buildOwnFadeSets();
    if (opts.ghost) this.setGhost(true);
    this._applyPose();
    // paint the faces that show up mid-fight now, so the first hit never waits on a canvas
    for (const e of PREWARM_EXPRESSIONS) if (!this._faceTex.has(e)) this._faceTex.set(e, acquireFaceTexture(this.appearance, e));
    this._updateExpression(this._defaultView(), 0);
  }

  // ─────────── public API ───────────

  /**
   * Drive the rig from a BoxerView (or null → idle). Call once per render frame.
   * @param {import('../core/types.js').BoxerView|null} view
   * @param {number} dt seconds
   */
  update(view, dt) {
    dt = clamp(num(dt, 0), 0, 0.1);
    const V = this._readView(view);
    this._time += dt;
    // hits first: the blow that causes a knockdown arrives in the same frame as DOWN and
    // decides how the boxer falls
    this._detectHit(V);
    if (V.phase !== this._phase) this._enterPhase(V, dt);
    else this._phaseT += dt;
    this._trackWalk(dt);
    if (this.role === 'boxer') {
      this._updatePunchStates(V, dt);
      this._targetBoxer(V, dt);
    } else {
      this._targetStaff(V, dt);
    }
    this._trackInput(V, dt);
    this._stepSprings(dt);
    this._applyPose();
    this._updateExpression(V, dt);
    this._updateExtras(V, dt);
    this._lastPhaseProgress = V.phaseProgress;
  }

  /** Translucent "own boxer" look: body ≈ PLAYER_GHOST_OPACITY, gloves solid, no shadows. */
  setGhost(on) {
    on = !!on;
    if (on === this.ghost && this._ghostApplied) return;
    this._ghostApplied = true;
    this.ghost = on;
    for (const m of this._meshes) {
      const key = m.userData.mat;
      m.material = on ? this._ghostMaterial(m) : this._mats.solid[key];
      const sh = !on && this.shadows && !m.userData.noShadow;
      m.castShadow = sh;
      m.receiveShadow = sh;
      m.renderOrder = on ? (GHOST_SOLID.has(key) ? 12 : 10) : 0;
    }
  }

  /**
   * Own-part fade (R8; render/own-fade.js drives it in the viewer's own viewport): `left` / `right`
   * fade that glove (and its cuff) from solid to OWN_FADE_LOOK.glove opacity, `head` the see-through
   * head (skull, face, hair, ears, headwear) to OWN_FADE_LOOK.head × its ghost opacity; 0 = the
   * normal ghost look. Only the ghost material set changes, so the same model drawn solid in the
   * other versus half (or in a cut) is untouched. Values are clamped to 0..1.
   * @param {{left?:number, right?:number, head?:number}} f
   */
  setOwnFade(f) {
    const M = this._mats;
    if (!M.ghostHand) return;
    for (const hand of HANDS) {
      const k = clamp(num(f?.[hand], 0), 0, 1);
      for (const m of [M.ghostHand[hand].gloves, M.ghostHand[hand].cuff]) {
        m.opacity = 1 - k * (1 - OWN_FADE_LOOK.glove);
        // a see-through glove must not hide what is drawn after it (hit bursts on the face)
        m.depthWrite = k < 0.02;
      }
    }
    const h = clamp(num(f?.head, 0), 0, 1);
    for (const [key, m] of Object.entries(M.ghostHead)) m.opacity = M.ghost[key].opacity * (1 - h * (1 - OWN_FADE_LOOK.head));
    this.ownFade = { left: clamp(num(f?.left, 0), 0, 1), right: clamp(num(f?.right, 0), 0, 1), head: h };
  }

  /**
   * World bounding spheres of the parts the own-part fade tests: the skull carrying the face and
   * each glove (boxers; a trainer has no gloves). Fills `out` = {head, left, right}, each {c, r};
   * with `out.face`, also a sphere around the face itself (OWN_FADE_LOOK.face: the front, lower part
   * of the skull that its hair and guard leave visible, about half the skull's disc).
   */
  partSpheres(out) {
    this.object3d.updateWorldMatrix(true, true);
    sphereOf(this._headMesh, out.head);
    if (out.face) {
      const F = OWN_FADE_LOOK.face;
      out.face.c.set(0, F.down, F.fwd).applyMatrix4(this._skull.matrixWorld);
      out.face.r = out.head.r * F.r;
    }
    for (const hand of HANDS) {
      const g = this._gloveMesh?.[hand];
      if (g) sphereOf(g, out[hand]); else out[hand].r = 0;
    }
    return out;
  }

  /** True while `hand` is out on a punch or still pulling back from one. */
  handBusy(hand) {
    const P = this._punch[hand === 'right' ? 'right' : 'left'];
    return P.mode !== 'idle' && P.w > 0.05;
  }

  /** True from a punch's wind-up (its tell) until the punching glove is back home. */
  attacking() {
    return this._phase === BoxerPhase.WINDUP || this.handBusy('left') || this.handBusy('right');
  }

  /** The ghost-set material for a mesh: per-hand gloves and a head set of their own (setOwnFade). */
  _ghostMaterial(m) {
    const key = m.userData.mat, part = m.userData.part, M = this._mats;
    if ((part === 'left' || part === 'right') && M.ghostHand?.[part][key]) return M.ghostHand[part][key];
    if (part === 'head' && M.ghostHead?.[key]) return M.ghostHead[key];
    return M.ghost[key];
  }

  /** Force an expression ('neutral'|'focus'|'hurt'|'dazed'|'ko'|'happy'|'sad'); null = follow the view. */
  setExpression(name) {
    this._manualExpr = name == null ? null : normalizeExpression(name);
    this._updateExpression(this._lastV ?? this._defaultView(), 0);
  }

  /** Optional: aim punches at this opponent's actual position (defaults to LAYOUT.fighterGap). */
  setFoe(model) { this._foe = model instanceof BoxerModel ? model : null; }

  /**
   * Force how the next knockdown falls: 'front' (face-down — the player's own knockdowns),
   * 'back', 'knees', or null to pick from the knockdown blow (body blow → knees, else back).
   */
  setFallStyle(style) { this._fallPref = FALL_STYLES.includes(style) ? style : null; }

  /**
   * Jump straight to the pose for `view` with no springs in flight (cinematics and replays cut
   * to a new moment). Clears punch, hit, gesture and walk state; a DOWN/KO view lands lying down.
   * @param {import('../core/types.js').BoxerView|null} view
   */
  snapTo(view) {
    const V = this._readView(view);
    this._phase = V.phase;
    const lying = V.phase === BoxerPhase.DOWN || V.phase === BoxerPhase.KO;
    if (lying && this._fallPref) this._fallStyle = this._fallPref;
    this._phaseT = lying ? 6 : V.phase === BoxerPhase.GETUP ? ANIM.getupTime : 0;
    this._koFromDown = false;
    this._lastHitAge = V.hitReact ? V.hitReact.age : Infinity;
    this._lastHit = null;
    this._flash = 0;
    this._squash.snap(0);
    this._punch.left = this._newPunchState();
    this._punch.right = this._newPunchState();
    this._windup.t = 0;
    this._gesture = null;
    this._walk.last = null; this._walk.vel.set(0, 0, 0); this._walk.w = 0;
    this._track = newTrack();
    this._omega = { body: ANIM.wBody, spine: ANIM.wSpine, head: ANIM.wHead, glove: { left: ANIM.wGlove, right: ANIM.wGlove }, foot: ANIM.wFoot };
    if (this.role === 'boxer') this._targetBoxer(V, 0);
    else this._targetStaff(V, 0);
    this._snapSprings(this._tgt);
    this._applyPose();
    this._updateExpression(V, 0);
    this._lastPhaseProgress = V.phaseProgress;
  }

  /** Trainer: turn head (and a little of the body) toward a world point; null = straight ahead. */
  setLookTarget(worldPos) { this._lookTarget = worldPos ? new THREE.Vector3().copy(worldPos) : null; }

  /**
   * Trainer (or any role): drive a hand to a point in model-local space (metres, +Z forward,
   * boxer's left = +X), e.g. to present a focus mitt. null releases it back to the view/idle pose.
   */
  setHandTarget(hand, localPos) {
    if (hand !== 'left' && hand !== 'right') return;
    this._handOverride[hand] = localPos ? new THREE.Vector3().copy(localPos) : null;
  }

  /**
   * Object3D that sits at the hand/glove centre and follows it. For the trainer, attach focus
   * mitts here: its +Z is the palm normal (facing forward), +Y runs along the fingers.
   */
  handAnchor(hand) { return this._anchors[hand === 'right' ? 'right' : 'left']; }

  /** Trainer: throw a ball with `hand`. Returns seconds until release (spawn the ball at handAnchor then). */
  trainerThrow(hand = 'right') {
    this._gesture = { kind: 'throw', t: 0, hand: hand === 'left' ? 'left' : 'right' };
    return ANIM_THROW.release;
  }
  /** True while a trainer gesture is playing. */
  get gestureActive() { return !!this._gesture; }

  /** Free GPU resources (materials, face textures, shared geometry refs) and detach. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const expr of this._faceTex.keys()) releaseFaceTexture(this.appearance, expr);
    this._faceTex.clear();
    const M = this._mats;
    for (const set of [M.solid, M.ghost, M.ghostHead, ...(M.ghostHand ? [M.ghostHand.left, M.ghostHand.right] : [])]) for (const k of Object.keys(set)) set[k].dispose();
    releaseGeos(this._geoKeys);
    this.object3d.removeFromParent();
    this._meshes.length = 0;
  }

  // ─────────── construction ───────────

  _defaultView() {
    return {
      phase: BoxerPhase.IDLE, phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null,
      punch: null, hitReact: null, expression: 'neutral', isHuman: false, hp01: 1, valid: false,
    };
  }

  _makeSprings() {
    const S3 = () => new Spring3();
    return {
      rigPos: S3(), hipsPos: S3(), hipsRot: S3(), spineRot: S3(), headRot: S3(),
      glove: { left: S3(), right: S3() }, elbow: { left: S3(), right: S3() },
      roll: { left: new Spring1(), right: new Spring1() }, shoulder: { left: new Spring1(), right: new Spring1() },
      foot: { left: S3(), right: S3() }, knee: { left: S3(), right: S3() },
      footYaw: { left: new Spring1(), right: new Spring1() }, footFlat: { left: new Spring1(1), right: new Spring1(1) },
    };
  }

  _snapSprings(p) {
    const S = this._sp;
    S.rigPos.snap(p.rigPos); S.hipsPos.snap(p.hipsPos); S.hipsRot.snap(p.hipsRot); S.spineRot.snap(p.spineRot); S.headRot.snap(p.headRot);
    for (const h of HANDS) {
      S.glove[h].snap(p.glove[h]); S.elbow[h].snap(p.elbow[h]); S.roll[h].snap(p.roll[h]); S.shoulder[h].snap(p.shoulder[h]);
      S.foot[h].snap(p.foot[h]); S.knee[h].snap(p.knee[h]); S.footYaw[h].snap(p.footYaw[h]); S.footFlat[h].snap(p.footFlat[h]);
    }
  }

  /** Copy the current (spring) pose into `out`. */
  _currentPose(out) {
    const S = this._sp;
    out.rigPos.copy(S.rigPos.x); out.hipsPos.copy(S.hipsPos.x); out.hipsRot.copy(S.hipsRot.x);
    out.spineRot.copy(S.spineRot.x); out.headRot.copy(S.headRot.x);
    for (const h of HANDS) {
      out.glove[h].copy(S.glove[h].x); out.elbow[h].copy(S.elbow[h].x); out.roll[h] = S.roll[h].x;
      out.shoulder[h] = S.shoulder[h].x; out.foot[h].copy(S.foot[h].x); out.knee[h].copy(S.knee[h].x);
      out.footYaw[h] = S.footYaw[h].x; out.footFlat[h] = S.footFlat[h].x;
    }
    return out;
  }

  _buildMaterials() {
    const A = this.appearance;
    const skin = A.skin;
    const top = A.top === 'none' ? skin : A.top;
    const gloveCol = A.gloves;
    const cuffBand = luminance(gloveCol) > 0.6 ? A.trim : '#f7f3ea';
    const colors = {
      skin, top, trunks: A.trunks, trim: A.trim, shoes: A.shoes,
      hair: A.hair.color,
      stubble: mixHex(A.hair.color, skin, 0.38),
      sole: luminance(A.shoes) > 0.5 ? '#3a3f55' : '#f7f3ea',
      cuff: cuffBand, ink: '#2b211f', metal: '#ffc94a', lens: '#9fe3ff', strap: '#3a3f55',
      silver: '#d9dee8', star: '#ffd166',
    };
    const solid = {}, ghost = {};
    const go = PLAYER_GHOST_OPACITY;
    const rough = (k) => (k === 'hair' || k === 'stubble' ? 0.75 : k === 'metal' || k === 'silver' ? 0.3 : 0.55);
    // one ghost material per key (also used again for the per-hand gloves and the head set that
    // setOwnFade fades: the same parameters and shader, so no extra program is compiled)
    const makeGhost = (k) => {
      let m;
      if (k === 'gloves') m = solidOnTop(leather(new THREE.Color(gloveCol))); // own gloves stay solid when ghosted
      else if (k === 'star') m = new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.star), transparent: true, opacity: 0.7, depthWrite: false });
      else if (k === 'head') {
        // head: white × face map (skin painted into the texture); falls back to plain skin
        m = new THREE.MeshStandardMaterial({ color: new THREE.Color(skin), roughness: 0.55, metalness: 0, transparent: true, opacity: go, depthWrite: false });
        m.emissive.setScalar(ANIM.skinFill).multiply(m.color); m.emissiveIntensity = 1;
      } else {
        const c = new THREE.Color(colors[k]);
        m = GHOST_SOLID.has(k) ? solidOnTop(vinyl(c, { roughness: rough(k) })) : vinyl(c, { roughness: rough(k), transparent: true, opacity: go });
      }
      // soft self-fill so shadowed sides stay toy-bright and readable under any arena light
      if (k !== 'head' && m.emissive) m.emissive.copy(m.color).multiplyScalar(k === 'skin' ? ANIM.skinFill : ANIM.fill);
      m.name = 'ghost:' + k;
      if (k !== 'star' && !GHOST_SOLID.has(k)) {
        const [core, rim] = k === 'head' || k === 'hair' || k === 'stubble' ? GHOST_FRESNEL.head : GHOST_FRESNEL.body;
        ghostFresnel(m, core, rim);
      }
      return m;
    };
    for (const [k, c] of Object.entries(colors)) solid[k] = vinyl(new THREE.Color(c), { roughness: rough(k) });
    solid.gloves = leather(new THREE.Color(gloveCol));
    for (const [k, m] of Object.entries(solid)) if (m.emissive) m.emissive.copy(m.color).multiplyScalar(k === 'skin' ? ANIM.skinFill : ANIM.fill);
    solid.star = new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.star) });
    solid.head = new THREE.MeshStandardMaterial({ color: new THREE.Color(skin), roughness: 0.55, metalness: 0 });
    solid.head.emissive.setScalar(ANIM.skinFill).multiply(solid.head.color); solid.head.emissiveIntensity = 1;
    for (const k of [...Object.keys(colors), 'gloves', 'star', 'head']) ghost[k] = makeGhost(k);
    for (const [k, m] of Object.entries(solid)) { m.name = k; }
    this._makeGhost = makeGhost;
    this._mats = { solid, ghost, ghostHand: null, ghostHead: {} };
  }

  /**
   * After the rig is built: the per-hand glove materials and the head's own ghost set (setOwnFade
   * fades them without touching the body). Tags each mesh with its part ('head' | 'left' | 'right').
   */
  _buildOwnFadeSets() {
    const M = this._mats, make = this._makeGhost;
    for (const hand of HANDS) this._arm[hand].hand.traverse((o) => { if (o.isMesh) o.userData.part = hand; });
    this._head.traverse((o) => { if (o.isMesh) o.userData.part = 'head'; });
    if (this.role === 'boxer') M.ghostHand = { left: { gloves: make('gloves'), cuff: make('cuff') }, right: { gloves: make('gloves'), cuff: make('cuff') } };
    for (const m of this._meshes) {
      const key = m.userData.mat;
      if (m.userData.part !== 'head' || M.ghostHead[key]) continue;
      const g = make(key);
      g.side = M.ghost[key].side; // e.g. the hair's DoubleSide
      M.ghostHead[key] = g;
    }
    this._headMats = [M.solid.head, M.ghost.head, ...(M.ghostHead.head ? [M.ghostHead.head] : [])];
  }

  _mesh(geoKey, make, mat, parent, opts = {}) {
    const g = useGeo(geoKey, make, this._geoKeys);
    const m = new THREE.Mesh(g, this._mats.solid[mat]);
    m.userData.mat = mat;
    if (opts.noShadow) m.userData.noShadow = true;
    const sh = this.shadows && !opts.noShadow;
    m.castShadow = sh; m.receiveShadow = sh;
    if (opts.pos) m.position.fromArray(opts.pos);
    if (opts.rot) m.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
    if (opts.scale) (Array.isArray(opts.scale) ? m.scale.fromArray(opts.scale) : m.scale.setScalar(opts.scale));
    if (opts.name) m.name = opts.name;
    parent.add(m);
    this._meshes.push(m);
    return m;
  }

  _buildRig() {
    this._buildMaterials();
    const A = this.appearance, B = this.build, role = this.role;
    const L = B.limb;
    const root = new THREE.Group();
    root.name = role === 'boxer' ? 'boxer' : role;
    const rig = new THREE.Group();
    rig.scale.setScalar(A.height);
    root.add(rig);
    const hips = new THREE.Group();
    const spine = new THREE.Group();
    spine.position.y = BODY.spineY;
    hips.add(spine);
    rig.add(hips);
    const neck = new THREE.Group();
    neck.position.set(0, BODY.neckY, -0.008);
    spine.add(neck);
    const head = new THREE.Group();
    head.position.set(0, BODY.neckLen, 0);
    neck.add(head);
    const R = BODY.headR * B.head;
    const skull = new THREE.Group();
    skull.position.set(0, BODY.headLift, BODY.headFwd);
    this._skullScale = new THREE.Vector3(R * HEAD_SHAPE.x, R * HEAD_SHAPE.y, R * HEAD_SHAPE.z);
    skull.scale.copy(this._skullScale);
    head.add(skull);
    Object.assign(this, { object3d: root, _rig: rig, _hips: hips, _spine: spine, _neck: neck, _head: head, _skull: skull });

    const bk = A.build;
    // torso / clothing
    const torso = this._mesh('torso:' + bk, () => makeLathe(torsoProfile(B), 44), 'top', spine, { name: 'torso' });
    torso.scale.set(1, 1, B.torsoD);
    const longPants = role !== 'boxer';
    const trunks = this._mesh('trunks:' + bk + (longPants ? ':long' : ''), () => makeLathe(trunksProfile(B, longPants), 40), 'trunks', hips, { name: 'trunks' });
    trunks.scale.set(1, 1, Math.max(0.86, B.torsoD * 1.3));
    // waistband (boxer: trim colour; trainer: jacket hem)
    const bandMat = role === 'boxer' ? 'trim' : 'top';
    const band = this._mesh('band:' + bk, () => new THREE.TorusGeometry(0.163 * B.hips, 0.026, 12, 48), bandMat, hips, { name: 'waistband' });
    band.rotation.x = Math.PI / 2; band.position.y = 0.11; band.scale.set(1.02, Math.max(0.86, B.torsoD * 1.3) * 1.02, 1.25);
    if (role === 'boxer' && A.top !== 'none') {
      // tank-top neckline + arm-hole piping in the trim colour
      const neckline = this._mesh('neckline:' + bk, () => new THREE.TorusGeometry(0.083 * B.torsoW, 0.012, 8, 40), 'trim', spine, { name: 'neckline' });
      neckline.rotation.x = Math.PI / 2 - 0.12; neckline.position.set(0, 0.452, 0.004); neckline.scale.set(1, B.torsoD * 1.25, 1);
    }
    if (role === 'trainer') this._buildTrainerDetails(spine, skull, B);

    // neck + head
    const neckR = 0.054 * B.neck;
    this._mesh('neck:' + bk, () => new THREE.CylinderGeometry(neckR, neckR * 1.12, 0.16, 20), 'skin', neck, { pos: [0, 0.035, 0.0], name: 'neck' });
    this._headMesh = this._mesh('head', makeHeadGeometry, 'head', skull, { name: 'head' });
    for (const s of [-1, 1]) {
      // ears: boxer's left = +X
      this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'skin', skull, { pos: [s * 0.965, -0.06, -0.08], scale: [0.2, 0.28, 0.14], rot: [0, s * 0.35, 0], name: 'ear' });
    }
    this._buildHair(skull);
    this._buildAccessory(skull);

    // arms
    this._arm = {};
    this._anchors = {};
    this._gloveMesh = {};
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1; // boxer's left = +X
      const armR = BODY.armR * L, foreR = BODY.foreR * L;
      const upperMat = role === 'trainer' ? 'top' : 'skin';
      const foreMat = role === 'trainer' ? 'top' : 'skin';
      const shoulderBall = this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), role === 'boxer' ? 'skin' : 'top', spine, { scale: armR * 1.18, name: 'shoulder' });
      const upper = this._mesh('cap:upper:' + bk + ':' + role, () => new THREE.CapsuleGeometry(armR, BODY.upperArm, 6, 16), upperMat, spine, { name: 'upperArm' });
      const fore = this._mesh('cap:fore:' + bk + ':' + role, () => new THREE.CapsuleGeometry(foreR, BODY.foreArm, 6, 16), foreMat, spine, { name: 'foreArm' });
      const hand3 = new THREE.Group(); hand3.name = hand + 'Hand';
      spine.add(hand3);
      if (role === 'boxer') {
        const gR = BODY.gloveR;
        const glove = this._mesh('glove', makeGloveGeometry, 'gloves', hand3, { scale: gR, name: 'glove' });
        this._gloveMesh[hand] = glove;
        const thumb = this._mesh('cap:thumb', () => new THREE.CapsuleGeometry(0.3, 0.5, 6, 12), 'gloves', glove, { name: 'thumb' });
        thumb.position.set(-s * 0.6, 0.2, 0.14); // inner side (toward the midline in guard)
        thumb.rotation.set(Math.PI / 2 - 0.3, 0, s * 0.4);
        thumb.scale.setScalar(0.85);
        this._mesh('cyl:cuff', () => new THREE.CylinderGeometry(0.6, 0.66, 0.75, 24, 1, false), 'gloves', glove, { pos: [0, -0.04, -0.82], rot: [Math.PI / 2, 0, 0], name: 'cuff' });
        this._mesh('tor:cuffband', () => new THREE.TorusGeometry(0.64, 0.09, 10, 28), 'cuff', glove, { pos: [0, -0.04, -0.98], name: 'cuffBand' });
      } else {
        this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'skin', hand3, { scale: [BODY.handR * 0.95, BODY.handR * 1.05, BODY.handR * 1.15], name: 'hand' });
        if (role === 'trainer') this._mesh('tor:cuffband', () => new THREE.TorusGeometry(0.64, 0.09, 10, 28), 'trim', hand3, { scale: 0.065, pos: [0, 0, -0.05], name: 'cuff' });
      }
      const anchor = new THREE.Group(); anchor.name = hand + 'Anchor';
      spine.add(anchor);
      this._anchors[hand] = anchor;
      this._arm[hand] = { shoulderBall, upper, fore, hand: hand3, s, upperLen: BODY.upperArm, foreLen: BODY.foreArm, elbow: new THREE.Vector3(), end: new THREE.Vector3() };
    }

    // legs
    this._leg = {};
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      const thighR = BODY.thighR * L, shinR = BODY.shinR * L;
      const legMat = role === 'boxer' ? 'skin' : 'trunks';
      const thigh = this._mesh('cap:thigh:' + bk, () => new THREE.CapsuleGeometry(thighR, BODY.thigh, 6, 16), legMat, rig, { name: 'thigh' });
      // boxing-trunk leg: a flared sleeve riding on the upper thigh (never lets the thigh poke through)
      const shorts = role === 'boxer'
        ? this._mesh('cyl:shorts:' + bk, () => new THREE.CylinderGeometry(thighR * 1.3, thighR * 1.5, BODY.shortsLen, 22), 'trunks', rig, { name: 'shortsLeg' })
        : null;
      const shin = this._mesh('cap:shin:' + bk, () => new THREE.CapsuleGeometry(shinR, BODY.shin, 6, 16), legMat, rig, { name: 'shin' });
      const foot = new THREE.Group(); foot.name = hand + 'Foot';
      rig.add(foot);
      // rounded shoe on a contrasting sole; boxers get a short boot collar
      this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'shoes', foot, { pos: [0, -0.026, 0.04], scale: [0.066, 0.056, 0.122], name: 'shoe' });
      this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'sole', foot, { pos: [0, -0.064, 0.04], scale: [0.069, 0.016, 0.126], name: 'sole' });
      if (role === 'boxer') {
        this._mesh('cyl:collar:' + bk, () => new THREE.CylinderGeometry(shinR * 1.16, shinR * 1.3, 0.075, 18), 'shoes', foot, { pos: [0, 0.012, -0.008], name: 'collar' });
      }
      this._leg[hand] = { thigh, shin, foot, shorts, s, knee: new THREE.Vector3(), end: new THREE.Vector3(), hip: new THREE.Vector3() };
    }

    // dizzy stars (DAZED / DOWN / KO); opts.stars === false leaves them out
    const stars = new THREE.Group(); stars.name = 'stars'; stars.visible = false;
    for (let i = 0; i < (this._withStars ? 3 : 0); i++) {
      const st = this._mesh('star', makeStarGeometry, 'star', stars, { scale: 0.035, noShadow: true, name: 'star' });
      st.userData.i = i;
    }
    rig.add(stars);
    this._stars = stars;
  }

  _buildHair(skull) {
    const A = this.appearance;
    const style = A.hair.style;
    const cap = (key, params, mat = 'hair') => {
      const m = this._mesh('hair:' + key, () => makeHairCap(params), mat, skull, { name: 'hair' });
      return m;
    };
    const sphere = (pos, scale, mat = 'hair', rot) => this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), mat, skull, { pos, scale, rot, name: 'hair' });
    switch (style) {
      case 'bald': break;
      case 'buzz': cap('buzz', { r: 1.018, bulge: 0.008, beta: 84, tilt: 26 }, 'stubble'); break;
      case 'crew':
        cap('crew', { r: 1.045, bulge: 0.07, beta: 84, tilt: 25 });
        break;
      case 'spiky': {
        cap('spiky', { r: 1.04, bulge: 0.04, beta: 84, tilt: 25 });
        const spikes = [[0, 1.0, 0.25, 0.26], [0.3, 0.94, 0.2, 0.22], [-0.3, 0.94, 0.2, 0.22], [0.16, 0.9, -0.35, 0.24], [-0.16, 0.9, -0.35, 0.24],
          [0.5, 0.7, -0.15, 0.2], [-0.5, 0.7, -0.15, 0.2], [0, 0.72, 0.62, 0.2], [0.42, 0.62, 0.5, 0.17], [-0.42, 0.62, 0.5, 0.17], [0, 0.6, -0.72, 0.2]];
        for (const [x, y, z, r] of spikes) {
          const dir = _v0.set(x, y + 0.25, z).normalize();
          const m = this._mesh('cone:spike', () => new THREE.ConeGeometry(0.2, 0.5, 14), 'hair', skull, { name: 'hair' });
          m.scale.setScalar(r / 0.2);
          m.position.set(x, y, z).normalize().multiplyScalar(0.98).addScaledVector(dir, 0.2 * (r / 0.2));
          m.quaternion.setFromUnitVectors(UP, dir);
        }
        break;
      }
      case 'mohawk': {
        cap('buzz', { r: 1.018, bulge: 0.008, beta: 84, tilt: 26 }, 'stubble');
        const n = 7;
        for (let i = 0; i < n; i++) {
          // angle from the crown: −35° = over the forehead … 115° = down the back of the head
          const a = THREE.MathUtils.degToRad(-35 + (i / (n - 1)) * 150);
          const dir = _v0.set(0, Math.cos(a), -Math.sin(a));
          const size = 0.34 - Math.abs(i - 2) * 0.03;
          const m = this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'hair', skull, { name: 'hair' });
          m.position.copy(dir).multiplyScalar(1.0 + size * 0.35);
          m.quaternion.setFromUnitVectors(UP, dir);
          m.scale.set(0.11, size, 0.2);
        }
        break;
      }
      case 'bun':
        cap('sleek', { r: 1.03, bulge: 0.02, beta: 86, tilt: 24 });
        sphere([0, 0.93, -0.42], 0.36);
        this._mesh('tor:bunband', () => new THREE.TorusGeometry(0.22, 0.06, 8, 20), 'trim', skull, { pos: [0, 0.83, -0.36], rot: [-0.95, 0, 0], name: 'hair' });
        break;
      case 'ponytail': {
        cap('sleek', { r: 1.03, bulge: 0.02, beta: 86, tilt: 24 });
        const tail = new THREE.Group(); tail.name = 'ponytail';
        tail.position.set(0, 0.42, -0.96);
        skull.add(tail);
        this._mesh('tor:bunband', () => new THREE.TorusGeometry(0.22, 0.06, 8, 20), 'trim', tail, { scale: 0.75, rot: [0.5, 0, 0], name: 'hair' });
        this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'hair', tail, { pos: [0, -0.32, -0.16], scale: [0.2, 0.42, 0.2], rot: [0.35, 0, 0], name: 'hair' });
        this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'hair', tail, { pos: [0, -0.7, -0.24], scale: [0.15, 0.24, 0.15], rot: [0.2, 0, 0], name: 'hair' });
        this._tail = tail;
        break;
      }
      case 'afro':
        sphere([0, 0.5, -0.32], [1.36, 1.24, 1.3]);
        break;
      case 'curly': {
        cap('curly', { r: 1.04, bulge: 0.04, beta: 82, tilt: 25 });
        // curls on a golden-angle spiral over the cap
        const n = 22;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const elev = Math.acos(1 - t * 1.05); // 0 at crown → ~90° at the rim
          const az = i * 2.39996;
          const dir = _v0.set(Math.sin(elev) * Math.cos(az), Math.cos(elev), Math.sin(elev) * Math.sin(az));
          // tilt back like the cap so the forehead stays clear
          dir.applyAxisAngle(_v1.set(1, 0, 0), -THREE.MathUtils.degToRad(25));
          if (dir.z > 0.55 && dir.y < 0.55) continue;
          const m = this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'hair', skull, { name: 'hair' });
          m.position.copy(dir).multiplyScalar(1.07);
          m.scale.setScalar(0.2 + ((i * 37) % 7) * 0.012);
        }
        break;
      }
      case 'flat-top':
        cap('buzz', { r: 1.018, bulge: 0.008, beta: 84, tilt: 26 }, 'hair');
        // squared-off block with softly rounded top edges
        this._mesh('lathe:flattop', () => makeLathe([[0, 0.34], [0.72, 0.34], [0.84, 0.31], [0.9, 0.24], [0.93, 0.0], [0.94, -0.3], [0, -0.3]], 36),
          'hair', skull, { pos: [0, 0.78, -0.07], scale: [1, 1, 1.02], name: 'hair' });
        break;
      case 'bob': {
        // helmet bob framing the face + fringe (open shells → render both sides)
        cap('bob', { r: 1.1, bulge: 0.02, beta: 122, tilt: 8, tuck: 1.06, phiStart: THREE.MathUtils.degToRad(140), phiLength: THREE.MathUtils.degToRad(260), flare: 0.06 });
        cap('fringe', { r: 1.06, bulge: 0.04, beta: 62, tilt: -2, tuck: 1.0, phiStart: THREE.MathUtils.degToRad(25), phiLength: THREE.MathUtils.degToRad(130) });
        this._mats.solid.hair.side = THREE.DoubleSide;
        this._mats.ghost.hair.side = THREE.DoubleSide;
        break;
      }
      case 'cornrows': {
        cap('cornrows', { r: 1.02, bulge: 0.01, beta: 84, tilt: 26 }, 'hair');
        for (let i = -2; i <= 2; i++) {
          const x = i * 0.27;
          const rad = Math.sqrt(Math.max(0.05, 1.05 * 1.05 - x * x));
          const m = this._mesh('tor:row:' + i, () => new THREE.TorusGeometry(rad, 0.075, 8, 40, THREE.MathUtils.degToRad(165)), 'hair', skull, { name: 'hair' });
          m.rotation.set(0, Math.PI / 2, 0);
          m.rotateZ(THREE.MathUtils.degToRad(-30));
          m.position.set(x, 0, 0);
        }
        break;
      }
      default: cap('crew', { r: 1.045, bulge: 0.07, beta: 84, tilt: 25 });
    }
  }

  _buildAccessory(skull) {
    const A = this.appearance;
    switch (A.accessory) {
      case 'headband': {
        const m = this._mesh('tor:headband', () => new THREE.TorusGeometry(0.97, 0.09, 12, 48), 'trim', skull, { name: 'headband' });
        m.rotation.x = Math.PI / 2 - 0.3;
        m.position.set(0, 0.36, -0.06);
        m.scale.set(1.04, 1.06, 1.25);
        break;
      }
      case 'goggles': {
        const strap = this._mesh('tor:strap', () => new THREE.TorusGeometry(0.93, 0.055, 10, 48), 'strap', skull, { name: 'goggles' });
        strap.rotation.x = Math.PI / 2 - 0.42;
        strap.position.set(0, 0.5, -0.08);
        strap.scale.set(1.07, 1.08, 1.2);
        for (const s of [-1, 1]) {
          const dir = _v0.set(s * 0.3, 0.72, 0.62).normalize();
          const rim = this._mesh('tor:goggle', () => new THREE.TorusGeometry(0.2, 0.06, 10, 28), 'strap', skull, { name: 'goggles' });
          rim.position.copy(dir).multiplyScalar(1.07);
          rim.quaternion.setFromUnitVectors(FWD, dir);
          const lens = this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'lens', skull, { name: 'goggles' });
          lens.position.copy(dir).multiplyScalar(1.065);
          lens.quaternion.setFromUnitVectors(FWD, dir);
          lens.scale.set(0.19, 0.19, 0.07);
        }
        break;
      }
      case 'earring':
        this._mesh('tor:earring', () => new THREE.TorusGeometry(0.075, 0.022, 8, 20), 'metal', skull, { pos: [0.98, -0.32, -0.08], rot: [0, Math.PI / 2, 0], name: 'earring' });
        break;
      default: break;
    }
  }

  _buildTrainerDetails(spine, skull, B) {
    // zip line + whistle on a cord
    const zAt = (y, lift = 0.004) => torsoFrontZ(B, y) + lift;
    for (let i = 0; i < 4; i++) {
      const y0 = 0.42 - i * 0.1, y1 = y0 - 0.1;
      const z = this._mesh('cyl:zip', () => new THREE.CylinderGeometry(0.005, 0.005, 1, 6), 'trim', spine, { name: 'zip' });
      placeBetween(z, _v0.set(0, y0, zAt(y0, 0.002)), _v1.set(0, y1, zAt(y1, 0.002)), 1);
    }
    const wy = 0.27;
    for (const s of [-1, 1]) {
      const cord = this._mesh('cyl:cord', () => new THREE.CylinderGeometry(0.0035, 0.0035, 1, 6), 'ink', spine, { name: 'cord' });
      placeBetween(cord, _v0.set(s * 0.05, 0.445, zAt(0.445, -0.01)), _v1.set(s * 0.006, wy + 0.012, zAt(wy, 0.012)), 1);
    }
    const w = this._mesh('cyl:whistle', () => new THREE.CylinderGeometry(0.013, 0.013, 0.048, 14), 'silver', spine, { name: 'whistle' });
    w.position.set(0, wy, zAt(wy, 0.016));
    w.rotation.set(0, 0, Math.PI / 2);
    this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'silver', spine, { pos: [0.018, wy - 0.006, zAt(wy, 0.016)], scale: 0.016, name: 'whistle' });
    // cap: crown + brim + button, in the trim colour
    this._mesh('hair:capcrown', () => makeHairCap({ r: 1.09, bulge: 0.05, beta: 80, tilt: 14, tuck: 1.03 }), 'trim', skull, { name: 'cap' });
    const brim = this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'trim', skull, { name: 'capBrim' });
    brim.position.set(0, 0.42, 0.98); brim.scale.set(0.62, 0.07, 0.48); brim.rotation.x = 0.22;
    this._mesh('sphere', () => new THREE.SphereGeometry(1, 20, 14), 'trim', skull, { pos: [0, 1.13, -0.05], scale: 0.09, name: 'capButton' });
  }

  // ─────────── per-frame: input ───────────

  _readView(view) {
    const V = this._view || (this._view = this._defaultView());
    const v = view && typeof view === 'object' ? view : null;
    V.valid = !!v;
    V.phase = v && PHASES.has(v.phase) ? v.phase : BoxerPhase.IDLE;
    V.phaseProgress = clamp(num(v?.phaseProgress, 0), 0, 1);
    V.guard = v?.guard === 'high' || v?.guard === 'low' ? v.guard : 'none';
    const ln = v?.lean;
    V.lean = { x: clamp(num(ln?.x), -1, 1), y: clamp(num(ln?.y), -1, 1), z: clamp(num(ln?.z), -1, 1) };
    const hl = readHand(v?.hands?.left), hr = readHand(v?.hands?.right);
    // all-zero hands mean "not provided" (e.g. AI without hand animation)
    const degenerate = hl && hr && Math.abs(hl.x) + Math.abs(hl.y) + Math.abs(hr.x) + Math.abs(hr.y) + hl.reach + hr.reach < 0.05;
    V.hands = hl && hr && !degenerate ? { left: hl, right: hr } : null;
    const p = v?.punch;
    V.punch = p && (p.hand === 'left' || p.hand === 'right')
      ? { id: p.id ?? null, hand: p.hand, kind: KINDS.has(p.kind) ? p.kind : 'straight', target: p.target === 'body' ? 'body' : 'head',
        progress: clamp(num(p.progress, NaN), 0, 1), hasProgress: Number.isFinite(p.progress), impact: !!p.impact,
        stage: typeof p.stage === 'string' ? p.stage : null, outcome: typeof p.outcome === 'string' ? p.outcome : null }
      : null;
    // every live punch (game/boxer.js): newest per hand; recover-stage progress runs 1 → 0
    V.punches = null;
    if (Array.isArray(v?.punches)) {
      const by = { left: null, right: null };
      for (const q of v.punches) {
        if (!q || (q.hand !== 'left' && q.hand !== 'right')) continue;
        if (!by[q.hand] || num(q.id, 0) >= num(by[q.hand].id, 0)) by[q.hand] = q;
      }
      const norm = (q) => (q ? {
        id: q.id ?? null, hand: q.hand, kind: KINDS.has(q.kind) ? q.kind : 'straight', target: q.target === 'body' ? 'body' : 'head',
        stage: q.stage === 'recover' ? 'recover' : 'travel', progress: clamp(num(q.progress, 0), 0, 1), hasProgress: Number.isFinite(q.progress),
        retract: 1 - clamp(num(q.progress, 0), 0, 1), outcome: typeof q.outcome === 'string' ? q.outcome : null,
      } : null);
      V.punches = { left: norm(by.left), right: norm(by.right) };
    }
    V.taunting = !!v?.taunting;
    const w = v?.windup;
    V.windup = w && (w.hand === 'left' || w.hand === 'right') ? {
      hand: w.hand, kind: KINDS.has(w.kind) ? w.kind : 'straight', target: w.target === 'body' ? 'body' : 'head',
      progress: Number.isFinite(w.progress) ? clamp(w.progress, 0, 1) : null,
      pull: clamp(num(w.tell?.pullback, 1), ANIM.tellMin, ANIM.tellMax), shoulder: clamp(num(w.tell?.shoulder, 1), ANIM.tellMin, ANIM.tellMax),
    } : null;
    const h = v?.hitReact;
    V.hitReact = h && typeof h === 'object'
      ? { hand: h.hand === 'left' ? 'left' : 'right', kind: KINDS.has(h.kind) ? h.kind : 'straight', target: h.target === 'body' ? 'body' : 'head', strength: clamp(num(h.strength, 0.6), 0, 1.5), age: Math.max(0, num(h.age, 0)), blocked: !!h.blocked }
      : null;
    V.expression = typeof v?.expression === 'string' ? v.expression : 'neutral';
    V.isHuman = !!v?.isHuman;
    V.hp01 = clamp(num(v?.hp01, 1), 0, 1);
    this._lastV = V;
    return V;
  }

  _enterPhase(V, dt) {
    const prev = this._phase;
    this._phase = V.phase;
    this._phaseT = dt;
    if (V.phase === BoxerPhase.DOWN || (V.phase === BoxerPhase.KO && prev !== BoxerPhase.DOWN)) {
      this._fallStyle = this._fallPref ?? (this._lastHit && this._lastHit.target === 'body' && !this._lastHit.blocked ? 'knees' : 'back');
      this._currentPose(this._fallEntry);
    }
    if (V.phase === BoxerPhase.KO && prev === BoxerPhase.DOWN) {
      this._koFromDown = true;
      this._koT0 = 0;
      this._currentPose(this._fallEntry);
    } else if (V.phase === BoxerPhase.KO) {
      this._koFromDown = false;
    }
    if (V.phase === BoxerPhase.GETUP) this._currentPose(this._getupEntry);
    if (V.phase === BoxerPhase.WINDUP) this._windup.t = 0;
  }

  _detectHit(V) {
    const h = V.hitReact;
    if (!h) { this._lastHitAge = Infinity; return; }
    const isNew = h.age < this._lastHitAge - 1e-6 && h.age < 0.3;
    this._lastHitAge = h.age;
    if (!isNew) return;
    this._lastHit = h;
    if (this._phase === BoxerPhase.DOWN || this._phase === BoxerPhase.KO) return;
    this._applyHitImpulse(h);
  }

  _applyHitImpulse(h) {
    const S = this._sp, H = ANIM.hit;
    const s = clamp(h.strength, 0.15, 1.3);
    // attacker's hand → which side of my head/body it lands on: their left hits my right
    const turn = h.hand === 'left' ? 1 : -1; // + = my head turns to my left
    if (h.blocked) {
      for (const hand of HANDS) S.glove[hand].v.z -= H.blocked.glovePush * s;
      S.spineRot.v.x += H.blocked.spinePitch * s;
      S.hipsPos.v.z += H.blocked.hipsZ * s;
      return;
    }
    if (h.target === 'body') {
      S.spineRot.v.x += H.body.spinePitch * s;
      S.headRot.v.x += H.body.headPitch * s;
      S.hipsPos.v.z += H.body.hipsZ * s;
      S.spineRot.v.y += turn * 1.2 * s;
      for (const hand of HANDS) S.glove[hand].v.y -= H.body.gloveDrop * s;
    } else if (h.kind === 'hook') {
      S.headRot.v.y += turn * H.hook.headYaw * s;
      S.headRot.v.z += -turn * H.hook.headRoll * s;
      S.spineRot.v.y += turn * H.hook.spineYaw * s;
      S.hipsPos.v.x += turn * H.hook.hipsX * s;
    } else if (h.kind === 'uppercut') {
      S.headRot.v.x += H.uppercut.headPitch * s;
      S.spineRot.v.x += H.uppercut.spinePitch * s;
      S.hipsPos.v.y += H.uppercut.hipsY * s;
    } else {
      S.headRot.v.x += H.straight.headPitch * s;
      S.headRot.v.y += turn * H.straight.headYaw * s;
      S.spineRot.v.x += H.straight.spinePitch * s;
      S.hipsPos.v.z += H.straight.hipsZ * s;
    }
    if (h.target !== 'body') { this._flash = ANIM.flashTime * clamp(s, 0.5, 1.2); this._squash.v += 40 * s; }
    // the reaction plays on the default springs (R11: the tracking filter's stiffer ones would shrink it)
    this._track.hitUntil = this._time + ANIM.track.hitHold;
  }

  _trackWalk(dt) {
    const W = this._walk;
    const p = this.object3d.getWorldPosition(_v0);
    if (W.last && dt > 0) {
      _v1.subVectors(p, W.last).divideScalar(dt);
      _v1.y = 0;
      // long smoothing: quick root slides (e.g. the renderer's lean sidestep) must not read as walking
      W.vel.lerp(_v1, clamp(dt / ANIM.walkSmooth, 0, 1));
    }
    W.last = (W.last || new THREE.Vector3()).copy(p);
    const speed = W.vel.length();
    W.w = lerp(W.w, smooth((speed - ANIM.walkSpeedMin) / 0.4), clamp(dt * 8, 0, 1));
    W.phase += (speed * dt / ANIM.stride) * Math.PI;
  }

  // ─────────── per-frame: punches ───────────

  _newPunchState() {
    return { mode: 'idle', kind: 'straight', target: 'head', id: null, over: 0, s: 0, t: 0, back: 0, sawProgress: false, lastProgress: -1,
      from: new THREE.Vector3(), ctrl: new THREE.Vector3(), impact: new THREE.Vector3(), w: 0 };
  }

  /**
   * Per-hand punch state. Prefers BoxerView.punches[] (every live punch with id/stage/outcome);
   * falls back to the single BoxerView.punch + phase (PUNCH = travelling, RECOVER = pulling back).
   */
  _updatePunchStates(V, dt) {
    for (const hand of HANDS) {
      const P = this._punch[hand];
      const q = this._handPunch(V, hand);
      if (q && q.stage === 'travel') {
        const restarted = P.mode !== 'out' || P.kind !== q.kind || P.target !== q.target ||
          (q.id != null && q.id !== P.id) ||
          (q.id == null && q.hasProgress && P.sawProgress && q.progress < P.lastProgress - 0.25);
        if (restarted) this._launchPunch(hand, q.kind, q.target, q.id);
        P.t += dt;
        if (q.hasProgress && q.progress !== P.lastProgress && P.lastProgress >= 0) P.sawProgress = true;
        const sView = q.hasProgress ? q.progress : 0;
        const sClock = P.t / ANIM.punchOutTime;
        P.s = clamp(P.sawProgress ? Math.max(sView, P.s) : Math.max(sView, sClock), 0, 1);
        P.lastProgress = q.hasProgress ? q.progress : P.lastProgress;
        P.w = Math.min(1, P.w + dt / 0.06);
        continue;
      }
      if (P.mode === 'out') this._beginRetract(hand, q && (q.id == null || q.id === P.id) ? q.outcome : null);
      if (P.mode === 'back') {
        P.back += dt;
        // follow the game's recovery when it describes this punch; always finish on our own clock too
        let k = P.back / ANIM.punchBackTime;
        if (q && q.stage === 'recover' && (q.id == null || q.id === P.id)) k = Math.max(k, q.retract);
        P.w = 1 - smooth(k);
        if (k >= 1) { P.mode = 'idle'; P.w = 0; P.over = 0; }
      }
    }
  }

  /** Normalised punch info for one hand from the view (or null). */
  _handPunch(V, hand) {
    if (V.punches) return V.punches[hand];
    const p = V.punch;
    if (!p || p.hand !== hand) return null;
    if (V.phase === BoxerPhase.PUNCH && p.stage !== 'recover') return { ...p, stage: 'travel' };
    if (V.phase === BoxerPhase.RECOVER || p.stage === 'recover') return { ...p, stage: 'recover', retract: V.phaseProgress };
    return null;
  }

  /** Out-stroke finished: blocked gloves bounce back, missed/dodged punches overshoot first. */
  _beginRetract(hand, outcome) {
    const P = this._punch[hand];
    P.mode = 'back'; P.back = 0; P.over = 0;
    if (outcome === 'blocked') this._sp.glove[hand].v.z -= ANIM.blockBounce;
    else if (outcome === 'dodged' || outcome === 'miss') P.over = 1;
  }

  _launchPunch(hand, kind, target, id = null) {
    const P = this._punch[hand];
    P.mode = 'out'; P.kind = kind; P.target = target; P.t = 0; P.s = 0; P.sawProgress = false; P.lastProgress = -1;
    P.id = id; P.over = 0;
    P.w = Math.max(P.w, 0.01);
    // start = where the glove is now (rig space)
    this._spineToRig(this._sp.glove[hand].x, P.from);
    this._impactPoint(hand, kind, target, P.impact);
    const s = hand === 'left' ? 1 : -1; // punching side in rig X
    const mid = _v0.addVectors(P.from, P.impact).multiplyScalar(0.5);
    P.ctrl.copy(mid);
    if (kind === 'hook') { P.ctrl.x += s * 0.34; P.ctrl.y += 0.04; P.ctrl.z -= 0.06; }
    else if (kind === 'uppercut') { P.ctrl.x += s * 0.06; P.ctrl.y -= target === 'body' ? 0.2 : 0.3; P.ctrl.z -= 0.1; }
    else { P.ctrl.y += 0.02; P.ctrl.x -= s * 0.06; } // straights cut in toward the centre line
  }

  /** Where a punch lands, in this model's rig space (opponent at its NEUTRAL spot, so dodges whiff). */
  _impactPoint(hand, kind, target, out) {
    const s = hand === 'left' ? 1 : -1;
    const sink = BODY.gloveR * ANIM.impactSink;
    let gap = LAYOUT.fighterGap, foeH = 1, foeX = 0, foeR = BODY.headR;
    const foe = this._foe;
    if (foe && foe.object3d) {
      this._rig.updateWorldMatrix(true, false);
      _m0.copy(this._rig.matrixWorld).invert();
      foe.object3d.getWorldPosition(_v1).applyMatrix4(_m0);
      gap = Math.max(0.6, _v1.z); foeX = _v1.x; foeH = foe.appearance.height / this.appearance.height;
      foeR = BODY.headR * (foe.build?.head ?? 1);
    }
    const crouchY = BODY.hipHeight - BODY.crouch + BODY.spineY;
    const headY = (crouchY + BODY.neckY + BODY.neckLen + BODY.headLift) * foeH;
    const headZ = gap - 0.05 * foeH;
    const faceZ = headZ - foeR * HEAD_SHAPE.z * foeH;
    if (target === 'body') {
      const bellyY = (crouchY + 0.2) * foeH;
      const bellyZ = gap - 0.14 * foeH;
      if (kind === 'hook') out.set(foeX + s * 0.13, bellyY + 0.04, bellyZ - 0.02);
      else if (kind === 'uppercut') out.set(foeX + s * 0.03, bellyY + 0.02, bellyZ - sink * 0.6);
      else out.set(foeX + s * 0.04, bellyY + 0.05, bellyZ - sink * 0.5);
    } else if (kind === 'hook') out.set(foeX + s * 0.11 * foeH, headY - 0.07 * foeH, faceZ + 0.01);
    else if (kind === 'uppercut') out.set(foeX + s * 0.02, headY - 0.16 * foeH, faceZ - sink * 0.3);
    else out.set(foeX + s * 0.02, headY - 0.085 * foeH, faceZ - sink);
    // foe guarding the target → stop on the gloves (blocks look physical)
    const fv = foe && foe._lastV;
    if (fv && ((target === 'head' && fv.guard === 'high') || (target === 'body' && fv.guard === 'low'))) out.z -= BODY.gloveR * 1.6;
    return out;
  }

  /** Spine-space → rig-space using the current spring pose. */
  _spineToRig(p, out) {
    this._spineMatrix(_m1);
    return out.copy(p).applyMatrix4(_m1);
  }
  _rigToSpine(p, out) {
    this._spineMatrix(_m1).invert();
    return out.copy(p).applyMatrix4(_m1);
  }
  _spineMatrix(out) {
    const S = this._sp;
    _e0.set(S.hipsRot.x.x, S.hipsRot.x.y, S.hipsRot.x.z, 'YXZ');
    _q0.setFromEuler(_e0);
    out.compose(_v6.copy(S.hipsPos.x).add(S.rigPos.x), _q0, _v4.set(1, 1, 1));
    _e0.set(S.spineRot.x.x, S.spineRot.x.y, S.spineRot.x.z, 'YXZ');
    _q1.setFromEuler(_e0);
    _m0.compose(_v4.set(0, BODY.spineY, 0), _q1, _v6.set(1, 1, 1));
    return out.multiply(_m0);
  }

  // ─────────── per-frame: target pose (boxer) ───────────

  _targetBoxer(V, dt) {
    const T = this._tgt;
    const ph = V.phase;
    this._omega = { body: ANIM.wBody, spine: ANIM.wSpine, head: ANIM.wHead, glove: { left: ANIM.wGlove, right: ANIM.wGlove }, foot: ANIM.wFoot };
    switch (ph) {
      case BoxerPhase.DOWN: this._targetDown(T); return;
      case BoxerPhase.KO: this._targetKO(T); return;
      case BoxerPhase.GETUP: this._targetGetup(T, V); return;
      case BoxerPhase.VICTORY: this._targetVictory(T, V); this._walkLayer(T); return;
      case BoxerPhase.DEFEAT: this._targetDefeat(T, V); this._walkLayer(T); return;
      default: break;
    }
    this._stancePose(T, V, this._time);
    if (V.taunting && ph !== BoxerPhase.DAZED) this._tauntLayer(T);
    if (ph === BoxerPhase.DAZED) this._dazedLayer(T);
    if (ph === BoxerPhase.WINDUP) this._windupLayer(T, V, dt);
    this._punchLayer(T, V);
    if (ph === BoxerPhase.HITSTUN) this._hitstunLayer(T, V);
    this._walkLayer(T);
  }

  /** The fighting stance + idle bob + hands/guard + lean. */
  _stancePose(T, V, time) {
    const lead = 'left'; // every boxer is orthodox (the stance choice was removed on 2026-11-10)
    const leadS = lead === 'left' ? 1 : -1; // +X side of the lead hand/foot
    const bob = Math.sin(time * TAU * ANIM.bobHz);
    const sway = Math.sin(time * TAU * ANIM.swayHz);
    const tired = 1 - V.hp01;
    T.rigPos.set(0, 0, 0);
    T.hipsPos.set(sway * ANIM.swayAmp, BODY.hipHeight - BODY.crouch + bob * ANIM.bobAmp - tired * 0.02, 0);
    T.hipsRot.set(0, -0.1 * leadS, 0);
    T.spineRot.set(0.07 + tired * 0.05, -0.08 * leadS, sway * 0.025);
    T.headRot.set(0.05 + bob * 0.01, 0, 0);
    // feet
    T.foot.left.set(BODY.stanceWidth, BODY.ankleY, lead === 'left' ? BODY.stanceLead : BODY.stanceRear);
    T.foot.right.set(-BODY.stanceWidth, BODY.ankleY, lead === 'right' ? BODY.stanceLead : BODY.stanceRear);
    T.footYaw.left = lead === 'left' ? 0.18 : 0.42;
    T.footYaw.right = lead === 'right' ? -0.18 : -0.42;
    T.footFlat.left = 1; T.footFlat.right = 1;
    T.knee.left.set(0.12, 0, 1); T.knee.right.set(-0.12, 0, 1);
    // gloves: fighting stance (lead forward, rear at the chin)
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      const isLead = hand === lead;
      const g = T.glove[hand];
      g.set(s * (isLead ? 0.125 : 0.14), isLead ? 0.41 : 0.43, isLead ? 0.34 : 0.26);
      g.y += Math.sin(time * TAU * ANIM.bobHz - 0.6 - (isLead ? 0 : 0.8)) * 0.008;
      T.elbow[hand].set(s * 0.55, -1, -0.15);
      T.roll[hand] = 0;
      T.shoulder[hand] = 0;
    }
    // tired: gloves sag a little
    if (tired > 0.5) for (const hand of HANDS) T.glove[hand].y -= (tired - 0.5) * 0.16;

    // live hands (human: follow the player's real hands; AI: shape the stance)
    if (V.hands) {
      const w = V.isHuman ? ANIM.handsWeightHuman : ANIM.handsWeightAI;
      const sw = BODY.shoulderX * 2;
      for (const hand of HANDS) {
        const h = V.hands[hand];
        // boxer perspective +x = boxer's right = local −X
        const x = -h.x * sw * ANIM.handScaleX;
        const y = BODY.shoulderY + h.y * sw * ANIM.handScaleY;
        const zGuard = lerp(0.17, ANIM.guardZ, smooth((h.y + 1.2) / 1.4));
        const z = lerp(zGuard, ANIM.reachZ, smooth(h.reach));
        T.glove[hand].lerp(_v0.set(x, y, z), w);
        // hands hanging low → elbows hang down; hands high → elbows out a bit
        T.elbow[hand].set((hand === 'left' ? 1 : -1) * (0.35 + 0.3 * smooth(h.y + 0.3)), -1, -0.2);
      }
    }

    // guard (COM03): clear, readable blocking shapes
    const tracked = V.isHuman && !!V.hands;
    const gw = V.guard === 'none' ? 0 : tracked ? ANIM.guardBlendHuman : 1;
    const gwGlove = V.guard === 'none' ? 0 : tracked ? ANIM.guardGloveHuman : 1;
    if (gw > 0) {
      for (const hand of HANDS) {
        const s = hand === 'left' ? 1 : -1;
        // the opponent's high guard sits beside the jaw so its face stays readable (§6 "Live fight");
        // the player's own guard (seen from behind) stays in front of the face
        if (V.guard === 'high') {
          if (V.isHuman) _v0.set(s * 0.1, 0.565, 0.3);
          else {
            _v0.set(s * ANIM.aiGuardX, ANIM.aiGuardY, 0.28);
            // catching a punch: the gloves snap together in front of the face for a moment
            const hr = V.hitReact;
            if (hr && hr.blocked && hr.target === 'head' && hr.age < ANIM.blockCatch) _v0.lerp(_v1.set(s * 0.09, 0.54, 0.31), 1 - hr.age / ANIM.blockCatch);
          }
        }
        else _v0.set(s * 0.105, 0.16, 0.255);
        if (gwGlove > 0) T.glove[hand].lerp(_v0, gwGlove);
        T.elbow[hand].lerp(_v1.set(s * 0.3, -1, -0.25), gw);
      }
      if (V.guard === 'high') { T.headRot.x += 0.09 * gw; T.hipsPos.y -= 0.015 * gw; T.spineRot.x += 0.03 * gw; }
      else { T.spineRot.x += 0.06 * gw; T.hipsPos.y -= 0.01 * gw; }
    }

    // lean (COM04): slips, ducks, forward/back. Head keeps its eyes roughly level.
    const ln = V.lean;
    const dodgeBoost = V.phase === BoxerPhase.DODGE ? 1.12 : 1;
    const lx = ln.x * dodgeBoost, ly = ln.y * dodgeBoost, lz = ln.z;
    T.hipsPos.x += -lx * ANIM.leanSideShift;
    T.hipsRot.z += lx * ANIM.leanHipRoll;
    T.spineRot.z += lx * ANIM.leanSideRoll;
    T.headRot.z += -lx * ANIM.leanSideRoll * ANIM.leanHeadCounter;
    const duck = Math.max(0, -ly);
    T.hipsPos.y -= duck * ANIM.duckDrop;
    T.hipsPos.y += Math.max(0, ly) * 0.025;
    T.spineRot.x += duck * ANIM.duckPitch;
    T.headRot.x -= duck * 0.2;
    T.hipsPos.z += lz * ANIM.leanFwdShift - duck * 0.03;
    T.spineRot.x += lz * ANIM.leanFwdPitch;
    // knees open a little when ducking
    T.knee.left.x += duck * 0.5; T.knee.right.x -= duck * 0.5;
    // keep eyes on the opponent: undo most of the body yaw at the head
    T.headRot.y += -0.75 * (T.hipsRot.y + T.spineRot.y);
  }

  _punchLayer(T, V) {
    let twist = 0, step = 0, dip = 0, pitch = 0, roll = 0, out = false;
    for (const hand of HANDS) {
      const P = this._punch[hand];
      if (P.mode === 'idle' || P.w <= 0) continue;
      const s = hand === 'left' ? 1 : -1;
      const ys = -s; // yaw sign: right-hand punch → +yaw (right shoulder forward)
      if (P.mode === 'out') {
        const e = easeOut(Math.min(1, P.s / ANIM.punchReachAt), 2.3);
        // quadratic Bézier in rig space: from → ctrl → impact
        const u = 1 - e;
        _v0.copy(P.from).multiplyScalar(u * u).addScaledVector(P.ctrl, 2 * u * e).addScaledVector(P.impact, e * e);
        // follow-through past the impact: uppercuts keep rising, hooks keep sweeping across
        const ft = smooth((P.s - ANIM.punchReachAt) / (1 - ANIM.punchReachAt));
        if (ft > 0) {
          if (P.kind === 'uppercut') _v0.y += 0.07 * ft;
          else if (P.kind === 'hook') _v0.x -= s * 0.07 * ft;
          else _v0.z += 0.025 * ft;
        }
        this._rigToSpine(_v0, T.glove[hand]);
        this._omega.glove[hand] = ANIM.wGlovePunch;
        out = true;
        // elbow: hooks swing with the elbow up and out; uppercuts tucked under
        if (P.kind === 'hook') T.elbow[hand].set(s * 1, 0.55, -0.35);
        else if (P.kind === 'uppercut') T.elbow[hand].set(s * 0.25, -1, 0.25);
        else T.elbow[hand].set(s * 0.6, -0.8, -0.1);
        T.roll[hand] = P.kind === 'straight' ? -ys * 1.25 * e : P.kind === 'hook' ? -ys * 1.4 * e : ys * 0.35 * e;
        T.shoulder[hand] = 0.06 * e;
        // the other glove tucks to the chin
        const o = other(hand);
        if (this._punch[o].mode === 'idle') T.glove[o].lerp(_v1.set(-s * 0.09, 0.48, 0.3), 0.65 * P.w);
        const k = P.w * smooth(P.s / 0.3); // body leads the arm
        twist += ys * ANIM.twist[P.kind] * k;
        step += ANIM.step[P.kind] * k;
        if (P.target === 'body') { dip += 0.075 * k; pitch += 0.2 * k; }
        if (P.kind === 'uppercut') { dip += 0.05 * k * (1 - smooth((P.s - 0.3) / 0.5)) - 0.03 * k * smooth((P.s - 0.4) / 0.5); pitch -= 0.06 * k; }
        if (P.kind === 'hook') roll += -ys * 0.1 * k;
        pitch += (P.target === 'head' ? 0.2 : 0.1) * k;
      } else if (P.over > 0 && P.back < ANIM.missOvershootTime) {
        // whiff: the glove sails a little past where the target was before coming back
        _v0.subVectors(P.impact, P.from).normalize().multiplyScalar(ANIM.missOvershoot).add(P.impact);
        this._rigToSpine(_v0, T.glove[hand]);
        this._omega.glove[hand] = ANIM.wGlovePunch;
        twist += ys * ANIM.twist[P.kind] * 1.1 * P.w;
        step += ANIM.step[P.kind] * 1.1 * P.w;
        pitch += 0.2 * P.w;
      } else {
        // retract: back to the stance/hands target (spring), slower than the out-stroke
        this._omega.glove[hand] = ANIM.wGloveBack;
        twist += ys * ANIM.twist[P.kind] * 0.6 * P.w;
        step += ANIM.step[P.kind] * 0.5 * P.w;
        pitch += 0.05 * P.w;
        T.roll[hand] = 0;
      }
    }
    if (twist === 0 && step === 0) return;
    // punches are explosive: the body whips into the twist/step instead of easing
    if (out) { this._omega.spine = ANIM.wSpinePunch; this._omega.body = ANIM.wBodyPunch; }
    T.hipsRot.y += twist * 0.35;
    T.spineRot.y += twist * 0.65;
    T.hipsPos.z += step;
    T.hipsPos.y -= dip;
    T.spineRot.x += pitch;
    T.spineRot.z += roll;
    // lead foot slides in with the lunge, the rear foot follows a little
    const leadFoot = 'left'; // orthodox
    T.foot[leadFoot].z += step * 0.6; T.foot[other(leadFoot)].z += step * 0.25;
    T.headRot.y += -0.5 * twist; // eyes stay on target
  }

  _windupLayer(T, V, dt) {
    const W = this._windup;
    W.t += dt;
    // what is coming: the game's windup object, else the described punch, else the rear hand straight
    const src = V.windup ?? (V.punch && V.punch.stage !== 'recover' && V.punch.stage !== 'travel' ? V.punch : null);
    if (src) { W.hand = src.hand; W.kind = src.kind; W.target = src.target; }
    else { W.hand = 'right'; W.kind = 'straight'; W.target = 'head'; } // the rear (right) hand
    const p = Math.max(V.windup?.progress ?? V.phaseProgress, 0);
    // tougher opponents telegraph a bit less (tell scale), but never below ANIM.tellMin
    const pull = V.windup?.pull ?? 1, sh = V.windup?.shoulder ?? 1;
    // fast ramp so the telegraph is readable early, then hold with a shake
    const a0 = easeOut(Math.min(1, Math.max(p, W.t / 0.45) / ANIM.windupRamp), 2);
    const a = a0 * pull;
    const hand = W.hand, s = hand === 'left' ? 1 : -1, ys = -s;
    const g = T.glove[hand];
    const shakeEnv = smooth((Math.max(p, W.t / 0.45) - 0.25) / 0.15);
    const shx = Math.sin(this._time * TAU * ANIM.windupShakeHz) * ANIM.windupShakeAmp * shakeEnv;
    const shy = Math.sin(this._time * TAU * ANIM.windupShakeHz * 0.83 + 1.1) * ANIM.windupShakeAmp * 0.8 * shakeEnv;
    if (W.kind === 'hook') {
      g.lerp(_v0.set(s * 0.3, 0.5, 0.06), a);
      T.elbow[hand].lerp(_v1.set(s * 1, 0.5, -0.5), a);
      T.spineRot.y += -ys * 0.42 * a0 * sh; T.hipsRot.y += -ys * 0.14 * a0 * sh; T.spineRot.z += ys * 0.08 * a0;
    } else if (W.kind === 'uppercut') {
      // glove dropped low and wide, knees dip, body leans over the punching side
      g.lerp(_v0.set(s * 0.25, W.target === 'body' ? 0.1 : 0.05, 0.1), a);
      T.elbow[hand].lerp(_v1.set(s * 0.5, -1, -0.4), a);
      T.spineRot.y += -ys * 0.3 * a0 * sh; T.spineRot.z += ys * 0.2 * a0; T.spineRot.x += 0.1 * a0;
      T.hipsPos.y -= 0.09 * a; T.hipsPos.x += -ys * 0.04 * a;
    } else {
      // shoulder pulled back, glove cocked beside the ear, body coiled away
      g.lerp(_v0.set(s * 0.22, W.target === 'body' ? 0.3 : 0.42, -0.08), a);
      T.elbow[hand].lerp(_v1.set(s * 0.9, -0.6, -0.6), a);
      T.spineRot.y += -ys * 0.4 * a0 * sh; T.hipsRot.y += -ys * 0.14 * a0 * sh; T.spineRot.x -= 0.07 * a0;
    }
    if (W.target === 'body') { T.hipsPos.y -= 0.05 * a; T.spineRot.x += 0.08 * a; }
    g.x += shx; g.y += shy;
    T.headRot.y += 0.6 * ys * 0.3 * a;
    T.headRot.x += 0.04 * a;
    // the other glove guards the chin
    const o = other(hand);
    T.glove[o].lerp(_v2.set(-s * 0.09, 0.47, 0.3), 0.7 * a);
  }

  _hitstunLayer(T, V) {
    const h = this._lastHit;
    const p = V.phaseProgress;
    const k = 1 - smooth((Math.max(p, this._phaseT / 0.45) - 0.55) / 0.45);
    if (h && h.target === 'body' && !h.blocked) {
      T.spineRot.x += 0.28 * k; T.hipsPos.y -= 0.04 * k; T.headRot.x += 0.12 * k;
      for (const hand of HANDS) T.glove[hand].lerp(_v0.set((hand === 'left' ? 1 : -1) * 0.1, 0.18, 0.22), 0.6 * k);
    } else {
      T.hipsPos.y -= 0.025 * k;
      T.spineRot.x -= 0.06 * k;
      // flinch: gloves come in toward the face
      for (const hand of HANDS) T.glove[hand].lerp(_v0.set((hand === 'left' ? 1 : -1) * 0.12, 0.52, 0.27), 0.35 * k);
    }
  }

  /** "Come on!" — gloves dropped low and wide, shoulder shimmy, chin up. */
  _tauntLayer(T) {
    const t = this._time;
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      T.glove[hand].set(s * (0.25 + 0.03 * Math.sin(t * 6 + s)), 0.06 + 0.05 * Math.sin(t * 6.3 + s * 1.3), 0.13);
      T.elbow[hand].set(s, -1, -0.3);
    }
    T.spineRot.z += Math.sin(t * 7) * 0.09;
    T.spineRot.x -= 0.09;
    T.headRot.x -= 0.16;
    T.headRot.z += Math.sin(t * 3.5) * 0.12;
  }

  _dazedLayer(T) {
    const t = this._time;
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      T.glove[hand].set(s * (0.17 + Math.sin(t * 2.1 + s) * 0.02), 0.1 + Math.sin(t * 1.7 + s * 0.9) * 0.03, 0.17);
      T.elbow[hand].set(s * 0.7, -1, -0.3);
    }
    T.hipsPos.x += Math.sin(t * 1.7) * 0.05;
    T.hipsPos.z += Math.sin(t * 1.1) * 0.02;
    T.hipsPos.y -= 0.035;
    T.spineRot.z += Math.sin(t * 1.7 + 0.6) * 0.13;
    T.spineRot.x += 0.06 + Math.sin(t * 2.3) * 0.05;
    T.headRot.z += Math.sin(t * 2.6 + 1.2) * 0.2;
    T.headRot.x += 0.08 + Math.cos(t * 2.6) * 0.1;
    T.headRot.y += Math.sin(t * 1.3) * 0.16;
    T.foot.left.z += Math.sin(t * 1.7) * 0.02;
    T.foot.right.z -= Math.sin(t * 1.7) * 0.02;
  }

  _walkLayer(T) {
    const W = this._walk;
    if (W.w < 0.01) return;
    // velocity in rig space
    this.object3d.updateWorldMatrix(true, false);
    _q0.copy(this.object3d.getWorldQuaternion(_q1)).invert();
    _v0.copy(W.vel).applyQuaternion(_q0);
    _v0.y = 0;
    const sp = _v0.length();
    if (sp < 1e-4) return;
    _v0.multiplyScalar(1 / sp);
    const a = Math.sin(W.phase), b = Math.cos(W.phase);
    const amp = 0.13 * W.w;
    T.foot.left.addScaledVector(_v0, a * amp); T.foot.left.y += Math.max(0, b) * 0.06 * W.w;
    T.foot.right.addScaledVector(_v0, -a * amp); T.foot.right.y += Math.max(0, -b) * 0.06 * W.w;
    T.hipsPos.y += Math.abs(b) * 0.015 * W.w;
  }

  _targetDown(T) {
    this._omega.body = this._omega.spine = this._omega.head = ANIM.wFall;
    this._omega.glove.left = this._omega.glove.right = ANIM.wFall;
    this._omega.foot = ANIM.wFall;
    const t = this._phaseT;
    const knees = this._fallStyle === 'knees';
    const keys = knees ? FALL_KNEES_POSES : this._fallStyle === 'front' ? FALL_FRONT_POSES : FALL_BACK_POSES;
    // keyframes are authored over 0.95 s; ANIM.fall*Time rescales them
    sampleKeys(T, this._fallEntry, keys, t * (0.95 / (knees ? ANIM.fallKneesTime : ANIM.fallBackTime)));
    // lying/kneeling idle: breathing + slow head roll; stirs later in the count
    const settle = smooth((t - 0.95) / 0.4);
    if (settle > 0) {
      const br = Math.sin(this._time * 2.4) * 0.025 * settle;
      T.spineRot.x += br;
      T.headRot.y += Math.sin(this._time * 0.9) * 0.18 * settle;
      const stir = smooth((t - 2.2) / 1.0) * (0.5 + 0.5 * Math.sin(this._time * 1.3));
      if (this._fallStyle === 'back') { T.headRot.x += 0.35 * stir; T.glove.left.z += 0.06 * stir; }
      else { T.headRot.x -= 0.3 * stir; }
    }
  }

  _targetKO(T) {
    this._omega.body = this._omega.spine = this._omega.head = ANIM.wFall;
    this._omega.glove.left = this._omega.glove.right = ANIM.wFall * 0.6;
    this._omega.foot = ANIM.wFall;
    const t = this._phaseT;
    const front = this._fallStyle === 'front';
    const lying = (front ? FALL_FRONT_POSES : FALL_BACK_POSES)[(front ? FALL_FRONT_POSES : FALL_BACK_POSES).length - 1].pose;
    const kneesEnd = FALL_KNEES_POSES[FALL_KNEES_POSES.length - 1];
    let limpStart = 0;
    if (this._koFromDown) {
      // already down: settle (or topple from the knees) onto the back
      T.lerpPoses(this._fallEntry, lying, smooth(t / (this._fallStyle === 'knees' ? 0.8 : 0.45)));
      limpStart = this._fallStyle === 'knees' ? 0.6 : 0;
    } else if (this._fallStyle === 'knees') {
      if (t < kneesEnd.t) sampleKeys(T, this._fallEntry, FALL_KNEES_POSES, t * (0.95 / ANIM.fallKneesTime));
      else T.lerpPoses(kneesEnd.pose, lying, smooth((t - kneesEnd.t) / 0.8));
      limpStart = kneesEnd.t + 0.6;
    } else {
      sampleKeys(T, this._fallEntry, front ? FALL_FRONT_POSES : FALL_BACK_POSES, t * (0.95 / ANIM.fallBackTime));
      limpStart = ANIM.fallBackTime * 0.95;
    }
    // limp: arms flop wider, head lolls to the side, legs relax
    const limp = smooth((t - limpStart) / 0.6);
    T.glove.left.x += 0.06 * limp; T.glove.right.x -= 0.06 * limp;
    T.headRot.y = lerp(T.headRot.y, 0.75, limp);
    T.headRot.x = lerp(T.headRot.x, 0.0, limp);
    T.foot.left.z += 0.12 * limp; T.foot.right.z += 0.08 * limp;
    T.knee.left.lerp(_v0.set(0.6, 1, 0.3), limp);
  }

  _targetGetup(T, V) {
    this._omega.body = this._omega.spine = this._omega.head = ANIM.wFall;
    this._omega.glove.left = this._omega.glove.right = ANIM.wFall;
    this._omega.foot = ANIM.wFall;
    const p = Math.max(V.phaseProgress, this._phaseT / ANIM.getupTime);
    const keys = this._fallStyle === 'knees' ? GETUP_KNEES_POSES : this._fallStyle === 'front' ? GETUP_FRONT_POSES : GETUP_BACK_POSES;
    const last = keys[keys.length - 1];
    if (p <= last.t) {
      sampleKeys(T, this._getupEntry, keys, p);
    } else {
      // final stretch: blend into the live stance, gloves come up, head shake
      this._stancePose(this._tmpPose, V, this._time);
      const k = smooth((p - last.t) / (1 - last.t));
      T.lerpPoses(last.pose, this._tmpPose, k);
      T.headRot.y += Math.sin(this._phaseT * 18) * 0.25 * (1 - k) * k * 3;
    }
  }

  _targetVictory(T, V) {
    this._stancePose(T, V, this._time);
    const t = this._phaseT;
    const hopT = (t % 0.56) / 0.56;
    const hop = Math.sin(hopT * Math.PI);
    const k = smooth(t / 0.35);
    T.rigPos.y = hop * 0.075 * k;
    T.hipsPos.y -= (1 - hop) * 0.03 * k;
    T.spineRot.set(-0.12 * k, 0, Math.sin(t * 3.3) * 0.05);
    T.hipsRot.set(0, 0, 0);
    T.headRot.set(-0.22 * k, 0, Math.sin(t * 3.3) * 0.08);
    const pump = Math.floor(t / 0.56) % 2;
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      const up = 0.86 + (pump === (hand === 'left' ? 0 : 1) ? 0.06 * hop : 0);
      T.glove[hand].lerp(_v0.set(s * 0.27, up, 0.1), k);
      T.elbow[hand].lerp(_v1.set(s * 1, 0, -0.3), k);
      T.roll[hand] = 0;
    }
  }

  _targetDefeat(T, V) {
    this._stancePose(T, V, this._time);
    const t = this._phaseT;
    const k = smooth(t / 0.8);
    T.hipsPos.y -= 0.03 * k;
    T.spineRot.x = lerp(T.spineRot.x, 0.36, k);
    T.spineRot.y = lerp(T.spineRot.y, 0, k);
    T.spineRot.z = Math.sin(t * 0.9) * 0.04 * k;
    T.hipsRot.y = lerp(T.hipsRot.y, 0, k);
    T.headRot.set(lerp(T.headRot.x, 0.5, k), Math.sin(t * 0.7) * 0.12 * k, 0);
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      T.glove[hand].lerp(_v0.set(s * 0.26, -0.06, 0.08), k);
      T.elbow[hand].lerp(_v1.set(s * 0.4, -0.2, -1), k);
    }
  }

  // ─────────── per-frame: trainer ───────────

  _targetStaff(V, dt) {
    const T = this._tgt;
    this._omega = { body: ANIM.wBody, spine: ANIM.wSpine, head: ANIM.wHead, glove: { left: 18, right: 18 }, foot: ANIM.wFoot };
    const t = this._time;
    const sway = Math.sin(t * TAU * 0.35);
    T.rigPos.set(0, 0, 0);
    T.hipsPos.set(sway * 0.01, BODY.hipHeight - 0.01 + Math.sin(t * TAU * 0.5) * 0.004, 0);
    T.hipsRot.set(0, 0, 0);
    T.spineRot.set(0.04, 0, sway * 0.015);
    T.headRot.set(0.02, 0, 0);
    T.foot.left.set(0.12, BODY.ankleY, 0.02); T.foot.right.set(-0.12, BODY.ankleY, -0.02);
    T.footYaw.left = 0.2; T.footYaw.right = -0.2;
    T.footFlat.left = 1; T.footFlat.right = 1;
    T.knee.left.set(0.2, 0, 1); T.knee.right.set(-0.2, 0, 1);
    for (const hand of HANDS) {
      const s = hand === 'left' ? 1 : -1;
      // mitts up, palms toward the boxer
      T.glove[hand].set(s * 0.19, 0.48 + Math.sin(t * 1.9 + s) * 0.01, 0.3);
      T.elbow[hand].set(s * 1, -0.6, -0.3);
      T.roll[hand] = 0; T.shoulder[hand] = 0;
    }
    // trainer mitts can be driven like a boxer's hands (BoxerView.hands) or set directly
    if (V.valid && V.hands) {
      const sw = BODY.shoulderX * 2;
      for (const hand of HANDS) {
        const h = V.hands[hand];
        T.glove[hand].set(-h.x * sw, BODY.shoulderY + h.y * sw, lerp(0.22, ANIM.reachZ, smooth(h.reach)));
      }
    }
    if (V.valid) {
      const ln = V.lean;
      T.hipsPos.x += -ln.x * ANIM.leanSideShift; T.spineRot.z += ln.x * ANIM.leanSideRoll;
      T.hipsPos.y -= Math.max(0, -ln.y) * ANIM.duckDrop; T.spineRot.x += Math.max(0, -ln.y) * ANIM.duckPitch;
    }
    for (const hand of HANDS) {
      const o = this._handOverride[hand];
      if (o) this._rigToSpine(_v0.copy(o).divideScalar(this.appearance.height), T.glove[hand]);
    }
    this._gestureLayer(T, dt);
    // look target (head + a little body)
    if (this._lookTarget) {
      this._rig.updateWorldMatrix(true, false);
      _m0.copy(this._rig.matrixWorld).invert();
      _v0.copy(this._lookTarget).applyMatrix4(_m0);
      const yaw = clamp(Math.atan2(_v0.x, _v0.z), -1.4, 1.4);
      const dist = Math.hypot(_v0.x, _v0.z);
      const pitch = clamp(Math.atan2(1.35 - _v0.y, Math.max(0.3, dist)), -0.6, 0.8);
      T.hipsRot.y += yaw * 0.25; T.spineRot.y += yaw * 0.25; T.headRot.y += yaw * 0.5;
      T.headRot.x += pitch * 0.6; T.spineRot.x += pitch * 0.2;
    }
    // hit reaction (trainer punched instead of the mitts)
    if (V.valid && V.phase === BoxerPhase.HITSTUN) this._hitstunLayer(T, V);
    this._walkLayer(T);
  }

  _gestureLayer(T, dt) {
    const G = this._gesture;
    if (!G) return;
    G.t += dt;
    const t = G.t;
    // gestures are snappy, readable signals
    this._omega.glove.left = this._omega.glove.right = ANIM.wGesture;
    this._omega.spine = ANIM.wSpinePunch * 0.6;
    if (G.kind === 'throw') {
      const hand = G.hand, s = hand === 'left' ? 1 : -1;
      const back = smooth(t / ANIM_THROW.windup);
      const fwd = smooth((t - ANIM_THROW.windup) / (ANIM_THROW.release - ANIM_THROW.windup + 0.05));
      const rest = smooth((t - ANIM_THROW.release - 0.2) / 0.3);
      _v0.set(s * 0.28, 0.6, -0.16).lerp(_v1.set(s * 0.12, 0.42, 0.52), fwd).lerp(_v2.set(s * 0.19, 0.48, 0.3), rest);
      T.glove[hand].lerp(_v0, Math.max(back, fwd) * (1 - rest) + rest);
      T.elbow[hand].set(s * 1, -0.2, -0.4);
      T.spineRot.y += (-s) * (0.3 * back - 0.55 * fwd) * (1 - rest);
      T.hipsRot.y += (-s) * (0.1 * back - 0.2 * fwd) * (1 - rest);
      if (t > ANIM_THROW.release + 0.55) this._gesture = null;
    }
  }

  // ─────────── springs & rig application ───────────

  /**
   * The human's tracking filter state for this frame (R11, ANIM.track): how fast each hand's target
   * and the lean move (smoothed signed velocities → 0..1 `mu` per channel) and the input's sample
   * interval (→ `cap`, the highest ω its rate shows without steps). Off (the default springs) for
   * the AI, the trainer and a human without tracked hands.
   */
  _trackInput(V, dt) {
    const R = this._track, K = ANIM.track;
    // only while the tracked body drives the boxer: punches (out and back: the arc, the body's twist
    // and step, the other glove's tuck), hit reactions (their impulses and the flinch, `hitHold` s
    // after a blow), falls, the get-up and the outro poses keep the default springs
    const punching = this.role === 'boxer' && (this.handBusy('left') || this.handBusy('right'));
    R.on = this.role === 'boxer' && V.isHuman && !!V.hands && LIVE_PHASES.has(V.phase) && !punching && this._time >= R.hitUntil;
    R.guard = V.guard !== 'none';
    if (!R.on) { R.ok = false; R.mu.left = R.mu.right = R.mu.body = 1; R.capGlove = R.capBody = Infinity; return; }
    const sw = BODY.shoulderX * 2, rz = ANIM.reachZ - ANIM.guardZ;
    const a = dt > 0 ? 1 - Math.exp(-dt / K.tau) : 0;
    let changed = false;
    const feed = (key, x, y, z, lo, hi) => {
      const c = R[key];
      if (R.ok && dt > 0) {
        const dx = x - c.p.x, dy = y - c.p.y, dz = z - c.p.z;
        if (dx * dx + dy * dy + dz * dz > 1e-14) changed = true;
        c.v.x += (dx / dt - c.v.x) * a; c.v.y += (dy / dt - c.v.y) * a; c.v.z += (dz / dt - c.v.z) * a;
      }
      c.p.set(x, y, z);
      R.mu[key] = R.ok ? smooth((c.v.length() - lo) / (hi - lo)) : 1;
    };
    const G = R.guard ? K.guardGlove : K.glove;
    for (const hand of HANDS) { const h = V.hands[hand]; feed(hand, h.x * sw, h.y * sw, h.reach * rz, G[0], G[1]); }
    feed('body', V.lean.x, V.lean.y, V.lean.z, K.lean[0], K.lean[1]);
    // the input's sample rate: the time between frames that brought new values
    if (changed) {
      if (R.last >= 0) R.interval += (clamp(this._time - R.last, 1 / 60, 1 / 10) - R.interval) * 0.25;
      R.last = this._time;
    }
    const slow = R.interval > K.rate.below;
    R.capGlove = slow ? K.rate.glove / R.interval : Infinity;
    R.capBody = slow ? K.rate.body / R.interval : Infinity;
    R.ok = true;
  }

  _stepSprings(dt) {
    const S = this._sp, T = this._tgt, W = this._omega;
    // the player's own boxer follows the tracked body closely while it moves (R11, ANIM.track); a
    // channel running a spring of its own (punch, fall, get-up, gesture) keeps it
    const R = this._track, hu = R.on, K = ANIM.track.still;
    const gStill = R.guard ? K.guardGlove : K.glove;
    const tracked = (w, def, still, stiff, mu, cap) => (hu && w === def ? Math.min(Math.max(still, cap), still + (stiff - still) * mu) : w);
    const wBody = tracked(W.body, ANIM.wBody, K.body, ANIM.wBodyHuman, R.mu.body, R.capBody);
    const wSpine = tracked(W.spine, ANIM.wSpine, K.spine, ANIM.wSpineHuman, R.mu.body, R.capBody);
    const wHead = tracked(W.head, ANIM.wHead, K.head, ANIM.wHeadHuman, R.mu.body, R.capBody);
    S.rigPos.step(T.rigPos, 30, dt);
    S.hipsPos.step(T.hipsPos, wBody, dt);
    S.hipsRot.step(T.hipsRot, wBody, dt);
    S.spineRot.step(T.spineRot, wSpine, dt);
    S.headRot.step(T.headRot, wHead, dt);
    for (const h of HANDS) {
      S.glove[h].step(T.glove[h], tracked(W.glove[h], ANIM.wGlove, gStill, ANIM.wGloveHuman, R.mu[h], R.capGlove), dt);
      S.elbow[h].step(T.elbow[h], 18, dt);
      S.roll[h].step(T.roll[h], 22, dt);
      S.shoulder[h].step(T.shoulder[h], 22, dt);
      S.foot[h].step(T.foot[h], W.foot, dt);
      S.knee[h].step(T.knee[h], 14, dt);
      S.footYaw[h].step(T.footYaw[h], 14, dt);
      S.footFlat[h].step(T.footFlat[h], 14, dt);
    }
  }

  _applyPose() {
    const S = this._sp;
    const hips = this._hips, spine = this._spine;
    hips.position.copy(S.hipsPos.x).add(S.rigPos.x);
    hips.rotation.set(S.hipsRot.x.x, S.hipsRot.x.y, S.hipsRot.x.z, 'YXZ');
    spine.rotation.set(S.spineRot.x.x, S.spineRot.x.y, S.spineRot.x.z, 'YXZ');
    // head rotation split between the neck and the head for a softer curve
    const hr = S.headRot.x;
    this._neck.rotation.set(hr.x * 0.4, hr.y * 0.35, hr.z * 0.4, 'YXZ');
    this._head.rotation.set(hr.x * 0.6, hr.y * 0.65, hr.z * 0.6, 'YXZ');

    // arms (spine space)
    const B = this.build;
    for (const hand of HANDS) {
      const A = this._arm[hand];
      const s = A.s;
      const shoulder = _v0.set(s * BODY.shoulderX * B.shoulder, BODY.shoulderY, BODY.shoulderZ + S.shoulder[hand].x);
      A.shoulderBall.position.copy(shoulder);
      const fore = A.foreLen + (this.role === 'boxer' ? BODY.gloveOffset : BODY.handR * 0.9);
      const stretch = solveTwoBone(shoulder, S.glove[hand].x, S.elbow[hand].x, A.upperLen, fore, ANIM.maxStretch, A.elbow, A.end);
      placeBetween(A.upper, shoulder, A.elbow, A.upperLen);
      _v1.subVectors(A.end, A.elbow).normalize();
      const wrist = _v2.copy(A.elbow).addScaledVector(_v1, A.foreLen * stretch);
      placeBetween(A.fore, A.elbow, wrist, A.foreLen);
      // glove/hand orientation: +Z along the forearm, +Y "up", rolled about the forearm
      const f = _v1;
      _v3.set(0, 1, 0);
      if (Math.abs(f.dot(_v3)) > 0.92) _v3.set(0, 0, f.y > 0 ? -1 : 1);
      const x = _v4.crossVectors(_v3, f).normalize();
      const y = _v3.crossVectors(f, x).normalize();
      _m0.makeBasis(x, y, f);
      A.hand.quaternion.setFromRotationMatrix(_m0);
      A.hand.rotateZ(S.roll[hand].x);
      A.hand.position.copy(A.end);
      // anchor: palm normal = forward component perpendicular to the forearm, fingers along it
      const anchor = this._anchors[hand];
      anchor.position.copy(A.end);
      const pz = _v4.set(0, 0, 1).addScaledVector(f, -f.z);
      if (pz.lengthSq() < 1e-6) pz.set(0, 1, 0).addScaledVector(f, -f.y);
      pz.normalize();
      const px = _v5.crossVectors(f, pz).normalize();
      _m0.makeBasis(px, f, pz);
      anchor.quaternion.setFromRotationMatrix(_m0);
    }

    // legs (rig space): hip joints from the hips transform
    hips.updateMatrix();
    for (const hand of HANDS) {
      const Lg = this._leg[hand];
      const s = Lg.s;
      Lg.hip.set(s * BODY.hipJointX * B.hips, BODY.hipJointY, 0).applyMatrix4(hips.matrix);
      const pole = S.knee[hand].x;
      // knee pole follows the hips' yaw
      _v3.copy(pole).applyAxisAngle(UP, S.hipsRot.x.y * 0.7);
      const target = _v6.copy(S.foot[hand].x).add(S.rigPos.x);
      solveTwoBone(Lg.hip, target, _v3, BODY.thigh, BODY.shin, 1.04, Lg.knee, Lg.end);
      placeBetween(Lg.thigh, Lg.hip, Lg.knee, BODY.thigh);
      if (Lg.shorts) {
        // sleeve spans from just above the hip joint down the thigh; narrow end up
        _v1.subVectors(Lg.hip, Lg.knee).normalize();
        Lg.shorts.position.copy(Lg.hip).addScaledVector(_v1, 0.035 - BODY.shortsLen / 2);
        Lg.shorts.quaternion.setFromUnitVectors(UP, _v1);
      }
      placeBetween(Lg.shin, Lg.knee, Lg.end, BODY.shin);
      // foot: flat on the canvas (yawed) or following the shin (kneeling/lying)
      const foot = Lg.foot;
      foot.position.copy(Lg.end);
      _q0.setFromAxisAngle(UP, S.footYaw[hand].x + S.hipsRot.x.y * 0.3);
      const shinDir = _v1.subVectors(Lg.knee, Lg.end).normalize();
      _v2.copy(_v3).addScaledVector(shinDir, -_v3.dot(shinDir));
      if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, 1);
      _v2.normalize();
      const xx = _v4.crossVectors(shinDir, _v2).normalize();
      _m0.makeBasis(xx, shinDir, _v2);
      _q1.setFromRotationMatrix(_m0);
      foot.quaternion.copy(_q1).slerp(_q0, clamp(S.footFlat[hand].x, 0, 1));
    }
  }

  // ─────────── expression & extras ───────────

  /** Head emissive = soft fill (+ hit flash), modulated by the face map when present. */
  _setHeadEmissive() {
    const f = this._flash > 0 ? (this._flash / ANIM.flashTime) : 0;
    for (const m of this._headMats) {
      const base = m.map ? _c0.setScalar(ANIM.skinFill) : _c0.set(this.appearance.skin).multiplyScalar(ANIM.skinFill);
      m.emissive.copy(base);
      if (f > 0) m.emissive.add(_c1.setRGB(0.9 * f, 0.38 * f, 0.3 * f));
    }
  }

  _phaseExpression(V) {
    switch (V.phase) {
      case BoxerPhase.KO: return 'ko';
      case BoxerPhase.DOWN: return 'dazed';
      case BoxerPhase.DAZED: return 'dazed';
      case BoxerPhase.HITSTUN: return 'hurt';
      case BoxerPhase.GETUP: return 'hurt';
      case BoxerPhase.VICTORY: return 'happy';
      case BoxerPhase.DEFEAT: return 'sad';
      case BoxerPhase.WINDUP: case BoxerPhase.PUNCH: return 'focus';
      default: return V.guard === 'high' ? 'focus' : 'neutral';
    }
  }

  _updateExpression(V, dt) {
    let e;
    if (this._manualExpr) e = this._manualExpr;
    else if (V.phase === BoxerPhase.KO) e = 'ko';
    else if (V.valid && V.expression && V.expression !== 'neutral' && normalizeExpression(V.expression) === V.expression) e = V.expression;
    else e = this.role === 'boxer' || V.valid ? this._phaseExpression(V) : (this.role === 'trainer' ? 'happy' : 'neutral');
    // blinking keeps idle faces alive
    const B = this._blink;
    if (e === 'neutral' || e === 'focus') {
      B.next -= dt;
      if (B.next <= 0 && B.t < 0) { B.t = 0; }
      if (B.t >= 0) {
        B.t += dt;
        if (B.t > ANIM.blinkDur) {
          B.t = -1;
          const r = Math.abs(Math.sin((this._time + this._seed) * 12.9898) * 43758.5453) % 1;
          B.next = lerp(ANIM.blinkMin, ANIM.blinkMax, r);
        } else e = e + '-blink';
      }
    }
    if (e === this._shownExpr) return;
    this._shownExpr = e;
    let tex = this._faceTex.get(e);
    if (tex === undefined) {
      tex = acquireFaceTexture(this.appearance, e);
      this._faceTex.set(e, tex);
    }
    for (const m of this._headMats) {
      const had = !!m.map;
      m.map = tex || null;
      m.emissiveMap = tex || null;
      m.color.set(tex ? 0xffffff : this.appearance.skin);
      if (had !== !!tex) m.needsUpdate = true;
    }
    this._setHeadEmissive();
  }

  _updateExtras(V, dt) {
    // hit flash (warm emissive pulse on the head, on top of the soft fill)
    const flashing = this._flash > 0;
    this._flash = Math.max(0, this._flash - dt);
    if (flashing) this._setHeadEmissive();
    // head squash on impact
    const sq = this._squash.step(0, 30, dt);
    const k = clamp(sq * ANIM.squash, -0.2, 0.2);
    this._skull.scale.set(this._skullScale.x * (1 + k * 0.6), this._skullScale.y * (1 + k * 0.4), this._skullScale.z * (1 - k));
    // dizzy stars
    const wantStars = V.phase === BoxerPhase.DAZED || (V.phase === BoxerPhase.DOWN && this._phaseT > 0.7) || V.phase === BoxerPhase.KO;
    const st = this._dizzy.step(wantStars && this.role === 'boxer' ? 1 : 0, 9, dt);
    this._stars.visible = st > 0.02 && this._stars.children.length > 0;
    if (this._stars.visible) {
      this._skull.updateWorldMatrix(true, false);
      this._rig.updateWorldMatrix(true, false);
      _m0.copy(this._rig.matrixWorld).invert();
      const headPos = this._skull.getWorldPosition(_v0).applyMatrix4(_m0);
      // ring above the head (above the face when lying on the back)
      const lying = V.phase === BoxerPhase.DOWN || V.phase === BoxerPhase.KO;
      const up = lying && this._fallStyle !== 'knees' ? 0.14 : 0.21;
      this._stars.position.set(headPos.x, headPos.y + up, headPos.z);
      const n = this._stars.children.length;
      this._stars.children.forEach((c, i) => {
        const a = this._time * 2.6 + (i / n) * TAU;
        c.position.set(Math.cos(a) * 0.17, Math.sin(this._time * 3 + i) * 0.02, Math.sin(a) * 0.17);
        c.rotation.set(0.3, this._time * 4 + i, 0);
        c.scale.setScalar(0.035 * st * (0.85 + 0.15 * Math.sin(this._time * 6 + i * 2)));
      });
    }
    // ponytail lags behind head motion
    if (this._tail) {
      const hr = this._sp.headRot.x, sr = this._sp.spineRot.x;
      _v0.set(0.35 - (hr.x + sr.x) * 0.6, 0, -(hr.z + sr.z) * 0.8);
      const t = this._tailSpring.step(_v0, 7, dt);
      this._tail.rotation.set(t.x, 0, t.z);
    }
  }
}

/** Trainer throw timing (seconds). */
export const ANIM_THROW = Object.freeze({ windup: 0.3, release: 0.42 });

// ───────────────────────────── helpers for other modules ─────────────────────────────

/**
 * World position of a glove (boxers) or hand (trainer) centre — for FX placement.
 * @param {BoxerModel} model @param {'left'|'right'} hand @param {THREE.Vector3} [out]
 */
export function gloveWorldPosition(model, hand, out = new THREE.Vector3()) {
  const a = model._arm[hand === 'right' ? 'right' : 'left'];
  model.object3d.updateWorldMatrix(true, true);
  return a.hand.getWorldPosition(out);
}

/**
 * World position of the head centre; with {front:true} the point on the face surface
 * (where a punch to the face lands).
 * @param {BoxerModel} model @param {THREE.Vector3} [out] @param {{front?:boolean}} [opts]
 */
export function headWorldPosition(model, out = new THREE.Vector3(), opts = {}) {
  model.object3d.updateWorldMatrix(true, true);
  if (opts.front) return out.set(0, -0.15, 1.0).applyMatrix4(model._skull.matrixWorld);
  return model._skull.getWorldPosition(out);
}

/** World position of the belly target (body shots) — for FX placement. */
export function bodyWorldPosition(model, out = new THREE.Vector3()) {
  model.object3d.updateWorldMatrix(true, true);
  return out.set(0, 0.2, 0.13 * model.build.torsoD / 0.64).applyMatrix4(model._spine.matrixWorld);
}

/**
 * Put a model on its LAYOUT spot facing the opponent: P1 at +Z facing −Z, P2 at −Z facing +Z.
 * @param {BoxerModel} model @param {'p1'|'p2'} id
 */
export function placeBoxer(model, id) {
  const p = id === 'p2' ? LAYOUT.p2Pos : LAYOUT.p1Pos;
  model.object3d.position.set(p[0], p[1], p[2]);
  model.object3d.rotation.set(0, id === 'p2' ? 0 : Math.PI, 0);
}
