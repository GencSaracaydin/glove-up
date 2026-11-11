// Gameplay and cinematic cameras (owner: view3d).
//
// research/mechanics.md §6 camera table, keyed on MatchView.phase / stage / stageTime
// (ARCHITECTURE.md §6.4, §6.6). Without stage fields (older match builds) the same table is
// driven from phase + phaseTime.
//
//   live            PLAY: just behind the player's head, at about head height and to the player's
//                   left (as in the reference footage): the own see-through head sits high in the
//                   frame beside the opponent's head, off its face; the opponent is seen
//                   whole (head to feet) left of centre; the solid gloves sit mid-frame, clear of
//                   the round clock. Body ghosted, gloves solid. A dodge-level lean (0.42) already
//                   slides the opponent about 1/4 of the screen, a full lean about 1/3, within
//                   0.15 s (§2.5, UI01, COM04), as a share of each landscape view's width (16:9,
//                   21:9, 4:3, a versus half). The camera slides sideways and turns with the lean,
//                   and a lean to the left is the mirror image of a lean to the right (R8): the
//                   same slide, turn, height and distance either way. The horizon stays LEVEL, as
//                   in the reference: no pitch, no roll, no rise, no push-in, and the own
//                   see-through head stays near the top of the frame. A lean toward the camera's
//                   own side (the player's left) carries the opponent's face behind the player's
//                   own see-through head and gloves; the renderer fades those OWN parts while they
//                   cover it (own-fade.js; the reference's own avatar is see-through too). A webcam
//                   player's lean noise is dropped by a camera-only soft deadzone. Near the edges of
//                   the view a damped keep-in turn (at most 16°/s) aims to hold the opponent's head
//                   within 16–84 % of a versus half (6–94 % of a single view); a held lean stays
//                   there, but when the opponent slips or lunges the same way the player leans its
//                   head runs on toward the edge for a moment (to ≈ 3–6 % of a half for ≈ 0.5 s)
//                   rather than the arena swinging under it. The slow orbit (a corner post crosses
//                   the frame in ~20 s) is the arena turning under the fighters (arena.setYaw), so
//                   every shot stays simple.
//   player hit      HIT: one frame of orange radial lines (renderer), then a hard cut to a tight,
//                   solid shot just behind the player's head (alternately over the right shoulder
//                   and tight off the left cheek) for 0.35 s (0.65 s heavy), then a hard cut back
//                   (sometimes a 0.3–0.4 s swing back). Only the camera changes.
//   opponent down   the fall plays in PLAY, then KD_WIDE: high and wide from behind the standing
//                   player's left shoulder, looking down at the opponent on the canvas (upper third).
//   player down     PLAYER_DOWN: raised shot over the player face-down in the foreground, the
//                   opponent waiting upright at the far side in the upper part of the frame (the
//                   count number lands on the canvas between them, as in the reference).
//   rising          hard cut back to PLAY (stand-off).
//   intro / rounds  ARENA (high wide) → FLYIN (swoop into the ring) → RING (ring level, both
//                   fighters) → BEHIND (close-up from behind the player, settling into PLAY).
//   decision        DECISION: ring-level wide two-shot from inside the ropes, a hard cut in (no
//                   referee — there is none).
//   bout outro      OUTRO: GameRenderer.playOutro drives the pose through setOverride().
// Versus (UI01 split screen): one rig per player; each rig cuts for its own player.
//
// Pure module (THREE math only) — imports and runs in Node for tests.
//
// Frame convention per rig: `fwd` = the rig owner's facing (toward the opponent), `right` = the
// owner's right, `back` = -fwd. P1 faces -Z (right = +X); P2 faces +Z (right = -X).

import * as THREE from 'three';
import { CAMERA, LAYOUT } from './style.js';
import { MatchPhase } from '../core/types.js';

/** Camera feel knobs. Offsets are [right, up, back] in the rig owner's frame (metres). */
export const RIG_TUNING = Object.freeze({
  near: 0.05,
  far: 200,
  play: Object.freeze({
    // Just behind the player's head, at about head height and half a metre to the player's
    // left (§6 "Live fight", matched to the footage — VISUAL-03): the own see-through head lands
    // high in the frame (≈66 %, 20 %) beside the opponent's head (≈49 %, 28 %), off its face at
    // rest; the opponent is seen whole (feet ≈79 % down); the idle gloves sit mid-frame (≈35–55 %
    // down), clear of the round clock; a high guard sits right of the opponent's face, not on it.
    // The camera looks a little across to the right, down at about 14°.
    offset: [-0.5, 1.25, 0.72],
    lookAt: [0.22, 0.56, 1.75],
    fov: 58,
    versusFov: CAMERA.versusFov,
    follow: Object.freeze({
      // The sideways follow is the same either way (R8: a lean to the left is the mirror image of a
      // lean to the right, which the reference-matched right lean set): the camera slides `x` m per
      // unit of the shaped lean and turns by the angle a look target swinging `lookX` m would turn it
      // in the rest geometry — toward the lean, mirrored for a left one — with the target kept at its
      // rest distance and height, so the horizon stays level (no pitch, no roll, no rise, no push-in).
      // Tuned for the 16:9 single view at fov 58 and scaled by viewportFollowScale() (≤ 1) in
      // narrower views, so the slide is a share of THIS viewport; views wider than 16:9 turn further
      // (the uncapped ratio) so it stays that share there too.
      x: 0.45,      // camera slides sideways with the (shaped) lean (m per unit) …
      lookX: 1.4,   // … and turns further: a full lean slides the view ≈1/3 of the width (§2.5)
      knee: 0.42,   // the dodge-level lean (combat's sideways threshold) …
      kneeGain: 0.76, // … already gives 76 % of the slide (≈1/4 of the width; Q4)
      kneeNarrow: 0.1, // narrower views add this × (1 − scale) to kneeGain (a versus half: 0.80), so
                       // the dodge-level lean still slides ≈1/4 of the half without a full lean leaving it
      // Camera-only soft deadzone on the sideways lean (R8: a webcam player's lean noise must not
      // shake the view): |lean| ≤ dead[0] moves nothing, ≥ dead[1] moves fully, smoothstep-blended in
      // between (leanDeadzone). The dodge level and everything above it are untouched; combat's lean
      // is not touched at all.
      dead: Object.freeze([0.03, 0.15]),
      // (A lean toward the camera's OWN side — lean.x < 0 in the owner's frame, the player's left, for
      // P1 and P2 — carries the opponent's face behind the player's own see-through head and guard:
      // the camera sits half a metre off the left shoulder. The camera does not dodge that (R8: the
      // left lean mirrors the right one); the renderer fades the viewer's OWN parts while they cover
      // the face, render/own-fade.js.)
      // Keep-in-view turn (R6, R8): when the opponent's head (its slips and lunges included) heads for
      // the edge of the view, the look turns toward it — softly: the turn it aims for leaves the head
      // where it is within 0.5 ± soft of the width and compresses it beyond, never past 0.5 ± edge (a
      // versus half: 22–78 % / 16–84 %; the single view only near its edges, 12–88 % / 6–94 %, e.g.
      // portrait or both leaning the same way). The turn itself follows that aim critically damped
      // (tau s) and never faster than `rate` °/s, so an opponent's slip, lunge or hit reaction never
      // swings the arena under it: a held lean settles inside the edge, but while the opponent slips
      // or lunges the same way the player leans its head runs on past the edge for a moment (a
      // versus half: to ≈ 3–6 % for ≈ 0.5–0.7 s; 25°/s would still leave ≈ 9 %). Turning never
      // changes which own part hides the face. In a versus half a single full lean lands at the soft
      // zone's start (≈ 18 % / 79 %) and is pulled in by under half a degree; both players leaning
      // the same way push into it.
      keep: Object.freeze({ soft: 0.28, edge: 0.34, softSingle: 0.38, edgeSingle: 0.44, tau: 0.12, rate: 16 }),
      duck: 0.4,    // camera drops when ducking (m per unit -lean.y)
      up: 0.05,     // rising slightly above neutral
      z: 0.2,       // leaning in / back
      lookY: 0.22,
      // head-tilt roll at a full lean (radians). 0 (R8): the reference keeps the horizon level on a
      // lean; a tilt also turned a webcam player's lean noise into vertical motion at the frame's edges
      roll: 0,
    }),
    lambda: 18,     // lean smoothing rate (1/s) of the duck / rise and the lean in / back
    // … and of the sideways lean in the fight view (1/s): a dodge-level step slides ≥ 94 % of the way
    // within 0.15 s (§2.5: 1 − e^(−20·0.15) = 95 %; at 18 it was 93 %), a full lean 98 %
    lambdaX: 20,
  }),
  /** 'fight' stage: close-up from behind the player's head (same side) that settles into the play pose. */
  behind: Object.freeze({ offset: [-0.3, 1.38, 0.46], lookAt: [0.14, 0.82, 1.5], fov: 54, dur: 0.9 }),
  /** 'arena'/'banner': high, wide establishing shot (slow drift). Angle is from the rig owner's back. */
  arena: Object.freeze({ dist: 9.2, height: 6.4, angle: 0.62, drift: 0.035, lookY: 0.15, fov: 50 }),
  /** 'flyin': swoop from the arena shot down to ring level. */
  flyin: Object.freeze({ dur: 1.5, arc: 1.4 }),
  /** 'ring': ring-level shot of both fighters from the side. */
  ring: Object.freeze({ side: 3.15, toward: 0.45, height: 1.02, lookY: 0.92, push: 0.35, pushSec: 4, fov: 42 }),
  /**
   * Player hit: a tight, SOLID shot from just behind the player's head at head height (§2.3, §6,
   * as in the footage): the own head, big and opaque, fills the top of the frame and the opponent
   * stays readable beside it. Cuts alternate between two variants (metres from the head along the
   * head → opponent line: `side` to the player's right, `up`, `back`; `lookDrop` aims below the
   * opponent's head): over the right shoulder (own head top-left) and tight off the left cheek
   * (own head top-right, about twice its live size). Both sit ≥ 0.4 m from the live pose, so the
   * cut always reads as a cut.
   */
  hit: Object.freeze({
    variants: Object.freeze([
      Object.freeze({ side: 0.38, up: -0.03, back: 0.72, lookDrop: 0.42 }),
      Object.freeze({ side: -0.28, up: -0.03, back: 0.45, lookDrop: 0.3 }),
    ]),
    fov: 52,
    ms: 350, heavyMs: 650,       // §2.10: 0.35 s ordinary, 0.65 s heavy
    swingMs: 350,                // the occasional 0.3–0.4 s swing back
    swingEvery: 3,               // every n-th ordinary cut swings back (heavy cuts always do)
  }),
  /**
   * Opponent knocked down: high wide shot from behind the standing player's left shoulder (the
   * live camera's side), pitched about 40° down (was 53°): the standing player fills ~55–60 % of
   * the frame height under the count, the downed fighter lies high in the frame beside its head
   * (VISUAL-09; reference 19:06, 24:47).
   */
  kdWide: Object.freeze({ back: 1.95, height: 2.35, side: -0.8, lookY: 0.2, aimShort: 1.5, push: 0.3, pushSec: 8, fov: 50, fallSec: 0.9 }),
  /**
   * The rig's own player down: a raised shot from behind the player's right, looking down past the
   * player (face-down in the foreground) at the opponent waiting upright in the upper part of the
   * frame, right of centre — so the centred count number lands on the canvas between them, not on
   * the opponent's torso (Q1; reference 42:20). `toward` places the aim between body and opponent.
   */
  playerDown: Object.freeze({ back: 1.2, side: 0.8, height: 2.4, toward: 0.2, lookY: 0.8, fov: 50, drift: 0.12 }),
  /** Decision: side-on two-shot from inside the ropes (clamped like every canvas-level shot), hard cut in. */
  decision: Object.freeze({ side: 3.6, toward: 0.2, height: 1.15, lookY: 0.8, push: 0.4, fov: 44 }),
  result: Object.freeze({ dist: 2.8, height: 1.4, side: 0.4, push: 0.45, fov: 47, lookY: 1.1 }),
  menu: Object.freeze({ radius: 8.4, height: 3.3, speed: 0.07, fov: 46, lookY: 0.55 }),
  // (training keeps its own head-tilt roll on a lean: the fight view's is 0, R8)
  training: Object.freeze({ offset: [0, 1.88, 1.38], lookAt: [0, 1.08, -1.2], fov: CAMERA.fov, roll: 0.06 }),
  /** Fallback stage timings (seconds of phaseTime) when the view has no `stage`. */
  fallback: Object.freeze({
    intro: Object.freeze({ arena: 1.0, flyin: 2.5 }),    // arena until 1.0 s, flyin until 2.5 s, then ring
    between: Object.freeze({ arena: 1.4, flyin: 2.9 }),
  }),
  reducedMotionFollow: 0.6, // lean-follow multiplier when reducedMotion is on
  /** Cinematic cameras at canvas height stay inside this radius (inside the ropes at any arena yaw). */
  insideRadius: LAYOUT.ringHalf - 0.3,
  // (DECISION is a hard cut — a blend out of the live pose swept the lens through the player's
  // head, which turns solid at the shot change: VISUAL-01)
  blend: Object.freeze({ toPlay: 0.5, toResult: 1.4, unpause: 0.4 }),
});

/**
 * The live camera's response to a sideways lean (Q4, research/mechanics.md §2.5): a dodge-level
 * lean (|x| = knee, combat's 0.42) already gives `kneeGain` of the full slide, a full lean all of
 * it. Monotonic and piecewise linear; sign-preserving; |v| ≤ 1.
 */
export function leanSlide(v, knee = RIG_TUNING.play.follow.knee, gain = RIG_TUNING.play.follow.kneeGain) {
  const a = Math.min(1, Math.abs(Number.isFinite(v) ? v : 0));
  const s = a <= knee ? (a / knee) * gain : gain + (1 - gain) * (a - knee) / (1 - knee);
  return v < 0 ? -s : s;
}

/**
 * Camera-only soft deadzone on a sideways lean (R8): |v| ≤ d0 → 0, |v| ≥ d1 → v unchanged, a
 * smoothstep blend in between. Monotonic, sign-preserving, continuous slope at d1.
 */
export function leanDeadzone(v, d0 = RIG_TUNING.play.follow.dead[0], d1 = RIG_TUNING.play.follow.dead[1]) {
  const x = Number.isFinite(v) ? v : 0;
  const a = Math.abs(x);
  if (!(a > d0)) return 0;
  if (a >= d1) return x;
  const t = (a - d0) / (d1 - d0);
  return x * t * t * (3 - 2 * t);
}

/** tan of the horizontal half-field the lean follow is tuned for: the 16:9 single view at fov 58. */
const FOLLOW_REF_HALF_TAN = Math.tan((29 * Math.PI) / 180) * (16 / 9);

/**
 * The 16:9 / 58° view's horizontal half-field tangent against a viewport's, tan(fov/2)·aspect,
 * capped at 1 (R6, RV-VISUAL-02): a versus half (aspect ≈0.89, fov 64) gets ≈0.56, a 4:3 view
 * 0.75, the 16:9 view 1. The sideways follow (follow.x / lookX, either way) is multiplied by it —
 * and, in views wider than 16:9, its turn also by the uncapped ratio — so a lean slides about the
 * same share of the width in every landscape view. Portrait views keep the scaled slide; the single
 * view's soft keep-in holds the opponent's face in frame there.
 * @param {number} fov  vertical field of view (degrees)  @param {number} aspect  width / height
 * @param {boolean} [cap=true]  false: the raw ratio (> 1 in views wider than 16:9)
 */
export function viewportFollowScale(fov, aspect, cap = true) {
  const t = Math.tan((fov * Math.PI) / 360) * aspect;
  if (!(Number.isFinite(t) && t > 0)) return 1;
  return cap ? Math.min(1, t / FOLLOW_REF_HALF_TAN) : t / FOLLOW_REF_HALF_TAN;
}

/**
 * Soft edge for the keep-in turn: identity within ±s, then compressed so it approaches (never
 * passes) ±e — tanh, slope 1 at s. In NDC units.
 */
function softEdge(x, s, e) {
  const a = Math.abs(x);
  if (a <= s) return x;
  const r = s + (e - s) * Math.tanh((a - s) / (e - s));
  return x < 0 ? -r : r;
}

/** Shots this rig can be in (also returned by `rig.shot`). */
export const Shot = Object.freeze({
  PLAY: 'play', BEHIND: 'behind', ARENA: 'arena', FLYIN: 'flyin', RING: 'ring', HIT: 'hit',
  KD_WIDE: 'kd-wide', PLAYER_DOWN: 'player-down', DECISION: 'decision', RESULT: 'result', OUTRO: 'outro',
  MENU: 'menu', TRAINING: 'training', HOLD: 'hold',
});

/** Shots where the camera is behind the rig's own boxer (that boxer is drawn as a ghost). */
const BEHIND_SHOTS = new Set([Shot.PLAY, Shot.BEHIND, Shot.TRAINING]);
/** Hard cuts that are announced as Ev.RENDER_CUT kinds. */
const CUT_KIND = Object.freeze({
  [Shot.KD_WIDE]: 'knockdown-wide', [Shot.PLAYER_DOWN]: 'player-down', [Shot.ARENA]: 'round-intro', [Shot.BEHIND]: 'fight',
});

const UP = new THREE.Vector3(0, 1, 0);
/** Side of the ring the shared side-on shots use (−X, the player's left). Kept for older callers. */
export const CINE_SIDE = Object.freeze(new THREE.Vector3(-1, 0, 0));
const FRAME = {
  p1: { fwd: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), base: new THREE.Vector3(...LAYOUT.p1Pos) },
  p2: { fwd: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(-1, 0, 0), base: new THREE.Vector3(...LAYOUT.p2Pos) },
};
const other = (id) => (id === 'p1' ? 'p2' : 'p1');

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoother = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

// scratch
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tgt = new THREE.Vector3();

class Pose {
  constructor() { this.pos = new THREE.Vector3(); this.target = new THREE.Vector3(); this.fov = 50; this.roll = 0; }
  copy(p) { this.pos.copy(p.pos); this.target.copy(p.target); this.fov = p.fov; this.roll = p.roll; return this; }
  lerp(a, b, t) {
    this.pos.lerpVectors(a.pos, b.pos, t); this.target.lerpVectors(a.target, b.target, t);
    this.fov = lerp(a.fov, b.fov, t); this.roll = lerp(a.roll, b.roll, t); return this;
  }
}

/**
 * Context the renderer fills every frame (reuse one object; nothing here is retained).
 * @typedef {Object} RigContext
 * @property {'match'|'menu'|'training'} mode
 * @property {string} [phase]              MatchPhase
 * @property {number} [phaseTime]          seconds since the phase began
 * @property {string|null} [stage]         MatchView.stage (ARCHITECTURE §6.4) — optional
 * @property {number} [stageTime]          seconds since the stage began
 * @property {boolean} [versus]
 * @property {null|'p1'|'p2'} [downed]
 * @property {null|'p1'|'p2'} [koLoser]    the boxer who was knocked out (once a KO happened)
 * @property {null|'p1'|'p2'} [winner]     result winner (null = draw / unknown)
 * @property {{p1:THREE.Vector3, p2:THREE.Vector3}} [pos]   current root positions of the boxers
 * @property {{p1:number, p2:number}} [yaw]                 current facing yaw of the boxers (rad, +Z = 0)
 * @property {{p1:{x:number,y:number,z:number}, p2:{x:number,y:number,z:number}}} [lean]  BoxerView.lean
 * @property {{p1:THREE.Vector3, p2:THREE.Vector3}} [head]  head centres (optional; estimated from pos)
 * @property {{p1:THREE.Vector3, p2:THREE.Vector3}} [body]  body centres of downed boxers (optional)
 * @property {THREE.Vector3|null} [focus]  training: point to frame (bag/trainer)
 * @property {{x:number, y:number, roll:number}} [shake]   from FX.getShake(side)
 */

export class CameraRig {
  /**
   * @param {{side?:'p1'|'p2', camera?:THREE.PerspectiveCamera, aspect?:number}} [opts]
   */
  constructor({ side = 'p1', camera = null, aspect = 16 / 9 } = {}) {
    this.side = side === 'p2' ? 'p2' : 'p1';
    this.camera = camera ?? new THREE.PerspectiveCamera(CAMERA.fov, aspect, RIG_TUNING.near, RIG_TUNING.far);
    this.camera.aspect = aspect;
    this.camera.near = RIG_TUNING.near;
    this.camera.far = RIG_TUNING.far;
    this.camera.updateProjectionMatrix();
    this.frame = FRAME[this.side];
    this._shot = null;
    this._prevShot = null;
    this._shotTime = 0;
    this._blendT = 0;
    this._blendDur = 0;
    this._from = new Pose();
    this._want = new Pose();
    this._start = new Pose();      // pose at the start of the current shot (FLYIN starts from it)
    this.pose = new Pose();
    this._lean = { x: 0, y: 0, z: 0 };
    this._keep = { yaw: 0, vel: 0 }; // keep-in-view turn (rad, rad/s; > 0 turns right)
    this._menuPhi = 0.6;
    this._cutNext = true;
    this._override = null;
    // player-hit cut state
    this._hit = { armed: false, wait: 0, active: false, t: 0, dur: 0, heavy: false, swing: false, side: 1, n: 0, endBlend: 0 };
    this._cut = { kind: null, durationMs: 0 };
    /** Settings → reducedMotion: no head-tilt roll, gentler lean sway, no swing-backs. */
    this.reducedMotion = false;
    /** Optional {offset, lookAt, fov} replacing RIG_TUNING.play's framing (dev pages / tuning). */
    this.playTuning = null;
    // place somewhere sensible before the first update
    this._playPose(null, this.pose, RIG_TUNING.play.offset, RIG_TUNING.play.lookAt, RIG_TUNING.play.fov);
    this._apply({ x: 0, y: 0, roll: 0 });
  }

  /** Current shot name (see Shot). */
  get shot() { return this._shot; }

  /** True when the camera is behind this rig's boxer (that boxer should be drawn as a ghost). */
  get wantsGhost() {
    const s = this._shot === Shot.HOLD ? this._prevShot : this._shot;
    if (!BEHIND_SHOTS.has(s)) return false;
    return this._blendDur <= 0 || this._blendT / this._blendDur > 0.45 || BEHIND_SHOTS.has(this._prevShot);
  }

  /** Blend progress of the current transition 0..1 (1 = settled). */
  get settled() { return this._blendDur <= 0 ? 1 : clamp01(this._blendT / this._blendDur); }

  /**
   * How far the view follows a lean toward the camera's OWN side (the player's left), in units of a
   * full lean's follow, 0..1 (0 on a right lean or at rest). The own-part fade (own-fade.js) only
   * fades the gloves while it is on: that lean is what carries the opponent's face behind them.
   */
  get ownShift() { return Math.max(0, -leanSlide(leanDeadzone(this._lean.x))); }

  /** True while the player-hit cut (or its pending first frame) is on. */
  get hitCutActive() { return this._hit.active || this._hit.armed; }

  setAspect(aspect) {
    if (!(aspect > 0) || Math.abs(this.camera.aspect - aspect) < 1e-4) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Make the next shot change a hard cut (scene changes, new match). Also drops any hit cut. */
  cut() {
    this._cutNext = true;
    this._hit.armed = false; this._hit.active = false;
    this._keep.yaw = 0; this._keep.vel = 0;
  }

  /** Force a shot restart (e.g. a new round start while already in that shot). */
  restartShot() { this._shot = null; }

  /**
   * Player-hit cut (§2.3/§6): after `preFrames` live frames (the orange radial lines frame), a
   * hard cut to a tight, solid over-the-shoulder shot of this rig's player for `durationMs`, then
   * a hard cut back — or a short swing back (every few ordinary cuts, always for heavy ones).
   * A hit while the cut is on extends it. Returns the cut length in ms.
   * @param {{heavy?:boolean, durationMs?:number, preFrames?:number, swing?:boolean|null}} [o]
   */
  hitCut({ heavy = false, durationMs = null, preFrames = 1, swing = null } = {}) {
    const H = RIG_TUNING.hit, S = this._hit;
    const dur = Math.max(0.05, (Number.isFinite(durationMs) ? durationMs : heavy ? H.heavyMs : H.ms) / 1000);
    if (S.active) {
      S.dur = Math.max(S.dur, S.t + dur);
      S.heavy = S.heavy || heavy;
      return Math.round((S.dur - S.t) * 1000);
    }
    S.n++;
    S.armed = true;
    S.wait = Math.max(0, preFrames | 0);
    S.dur = dur; S.t = 0; S.heavy = heavy;
    S.swing = !this.reducedMotion && (swing ?? (heavy || S.n % H.swingEvery === 0));
    S.side = S.n % 2 ? 1 : -1;
    return Math.round(dur * 1000);
  }

  /** Drive the camera from outside (bout outro); null hands control back to the shot table. */
  setOverride(pose) {
    this._override = pose || null;
  }

  /** True while setOverride() drives the camera. */
  get hasOverride() { return !!this._override; }

  /** The last hard cut announced since the previous call ({kind, durationMs}) — or null. */
  takeCut() {
    if (!this._cut.kind) return null;
    const out = { kind: this._cut.kind, durationMs: this._cut.durationMs };
    this._cut.kind = null; this._cut.durationMs = 0;
    return out;
  }

  /**
   * Advance the rig.
   * @param {number} dt  REAL seconds (camera motion is never slowed by hit-stop)
   * @param {RigContext} ctx
   */
  update(dt, ctx) {
    const d = Math.max(0, Math.min(0.1, dt || 0));
    const base = this._chooseShot(ctx);
    const shot = this._withHitCut(base, ctx, d);
    if (shot !== this._shot) this._startShot(shot, ctx);
    if (shot !== Shot.HOLD) this._shotTime += d; // a paused shot resumes where it left off

    // lean filter (own boxer)
    const L = ctx?.lean?.[this.side];
    // (the training view keeps one rate for all three)
    const k = 1 - Math.exp(-RIG_TUNING.play.lambda * d);
    const kx = shot === Shot.TRAINING ? k : 1 - Math.exp(-RIG_TUNING.play.lambdaX * d);
    const m = this.reducedMotion ? RIG_TUNING.reducedMotionFollow : 1;
    const lx = L ? clampN(L.x) * m : 0, ly = L ? clampN(L.y) * m : 0, lz = L ? clampN(L.z) * m : 0;
    this._lean.x += (lx - this._lean.x) * kx;
    this._lean.y += (ly - this._lean.y) * k;
    this._lean.z += (lz - this._lean.z) * k;

    if (shot === Shot.HOLD) { this._apply(ctx?.shake); return; }

    this._computeShot(shot, this._shotTime, ctx, this._want, d);
    if (this._blendDur > 0 && this._blendT < this._blendDur) {
      this._blendT += d;
      this.pose.lerp(this._from, this._want, smoother(this._blendT / this._blendDur));
    } else {
      this.pose.copy(this._want);
    }
    this._apply(ctx?.shake);
  }

  // ───────────── shot selection ─────────────

  _chooseShot(ctx) {
    if (!ctx || ctx.mode === 'menu') return Shot.MENU;
    if (ctx.mode === 'training') return Shot.TRAINING;
    if (this._override) return Shot.OUTRO;
    const ph = ctx.phase;
    if (ph === MatchPhase.PAUSED) return Shot.HOLD;
    const t = Number.isFinite(ctx.phaseTime) ? ctx.phaseTime : 0;
    switch (ph) {
      case MatchPhase.INTRO:
      case MatchPhase.ROUND_START:
      case MatchPhase.BETWEEN:
        return this._introShot(ph, ctx.stage, t);
      case MatchPhase.FIGHTING:
      case MatchPhase.ROUND_END:
      case MatchPhase.RECOVERY:
        return Shot.PLAY;
      case MatchPhase.KNOCKDOWN: {
        const downed = ctx.downed ?? ctx.koLoser ?? null;
        if (!downed) return Shot.PLAY;
        const fallen = ctx.stage ? ctx.stage !== 'fall' : t >= RIG_TUNING.kdWide.fallSec;
        if (!fallen) return this._shot === Shot.KD_WIDE || this._shot === Shot.PLAYER_DOWN ? this._shot : Shot.PLAY;
        return downed === this.side ? Shot.PLAYER_DOWN : Shot.KD_WIDE;
      }
      case MatchPhase.DECISION: return Shot.DECISION;
      case MatchPhase.RESULT:
        if (ctx.koLoser) return ctx.koLoser === this.side ? Shot.PLAYER_DOWN : Shot.KD_WIDE;
        return Shot.RESULT;
      default: return Shot.PLAY;
    }
  }

  /** INTRO / ROUND_START / BETWEEN: stage names from the view, else the fallback timetable. */
  _introShot(ph, stage, t) {
    let s = typeof stage === 'string' ? stage : null;
    if (!s) {
      if (ph === MatchPhase.ROUND_START) s = 'fight';
      else {
        const F = ph === MatchPhase.INTRO ? RIG_TUNING.fallback.intro : RIG_TUNING.fallback.between;
        s = t < F.arena ? 'arena' : t < F.flyin ? 'flyin' : 'ring';
      }
    }
    switch (s) {
      case 'arena': case 'banner': return Shot.ARENA;
      case 'flyin': return Shot.FLYIN;
      case 'ring': return Shot.RING;
      case 'fight': return Shot.BEHIND;
      case 'live': return Shot.PLAY;
      default: return ph === MatchPhase.ROUND_START ? Shot.BEHIND : Shot.ARENA;
    }
  }

  /** Layer the player-hit cut over the live shots. */
  _withHitCut(base, ctx, dt) {
    const S = this._hit;
    if (!S.active && !S.armed) return base;
    const live = base === Shot.PLAY && ctx?.mode === 'match';
    if (!live) { S.armed = false; S.active = false; return base; }
    if (S.armed) {
      // the event frame itself stays live (it carries the orange radial lines), then the hard cut
      if (S.wait > 0) { S.wait--; return base; }
      S.armed = false; S.active = true; S.t = 0;
      return Shot.HIT;
    }
    S.t += dt;
    if (S.t < S.dur) return Shot.HIT;
    S.active = false;
    S.endBlend = S.swing ? RIG_TUNING.hit.swingMs / 1000 : 0;
    return base;
  }

  _blendFor(from, to) {
    const B = RIG_TUNING.blend;
    if (this._cutNext || !from) return 0;
    if (from === Shot.HOLD && to === this._prevShot) return B.unpause; // resuming the same shot
    switch (to) {
      case Shot.PLAY:
        if (from === Shot.HIT) { const s = this._hit.endBlend; this._hit.endBlend = 0; return s; }
        if (from === Shot.BEHIND || from === Shot.RESULT || from === Shot.DECISION) return B.toPlay;
        return 0; // hard cuts during play (rising, round restarts)
      case Shot.FLYIN: case Shot.RING: return 0; // FLYIN starts from the arena pose itself; RING continues it
      // DECISION: a hard cut (the reference's transition language). A blend out of the live pose
      // would sweep the lens through the player's own head, which is solid from the first frame
      // of the shot (VISUAL-01).
      case Shot.DECISION: return 0;
      case Shot.RESULT: return from === Shot.DECISION || from === Shot.PLAY ? B.toResult : 0;
      default: return 0;
    }
  }

  _startShot(shot, ctx) {
    if (shot === Shot.HOLD) { this._prevShot = this._shot; this._shot = shot; return; }
    const from = this._shot;
    const resuming = from === Shot.HOLD && this._prevShot === shot;
    this._blendDur = shot === Shot.OUTRO ? 0 : this._blendFor(from, shot);
    this._blendT = 0;
    this._from.copy(this.pose);
    this._start.copy(this.pose);
    // resuming from a pause continues the same shot clock instead of restarting it
    if (!resuming) this._shotTime = 0;
    this._prevShot = this._shot;
    this._shot = shot;
    const announce = !resuming && from !== null && this._blendDur === 0;
    if (announce) {
      if (shot === Shot.HIT) {
        this._cut.kind = this._hit.heavy ? 'player-hit-heavy' : 'player-hit';
        this._cut.durationMs = Math.round(this._hit.dur * 1000);
      } else if (shot === Shot.PLAY && (from === Shot.KD_WIDE || from === Shot.PLAYER_DOWN)) {
        this._cut.kind = 'standoff'; this._cut.durationMs = 0;
      } else if (CUT_KIND[shot] && !(shot === Shot.ARENA && from === Shot.ARENA)) {
        this._cut.kind = CUT_KIND[shot];
        this._cut.durationMs = shot === Shot.BEHIND ? Math.round(RIG_TUNING.behind.dur * 1000) : 0;
      }
    }
    this._cutNext = false;
    void ctx;
  }

  // ───────────── shots ─────────────

  _computeShot(shot, t, ctx, out, dt) {
    const T = RIG_TUNING;
    const P = T.play;
    const fovPlay = ctx?.versus ? P.versusFov : P.fov;
    switch (shot) {
      case Shot.PLAY: {
        const Q = this.playTuning ?? P;
        this._playPose(ctx, out, Q.offset, Q.lookAt, ctx?.versus ? P.versusFov : Q.fov, 'play', dt);
        return;
      }
      case Shot.BEHIND: {
        const B = T.behind;
        const Q = this.playTuning ?? P;
        this._playPose(ctx, out, Q.offset, Q.lookAt, ctx?.versus ? P.versusFov : Q.fov, 'play', dt);
        const k = 1 - easeInOutSine(t / B.dur);
        if (k <= 0) return;
        const { fwd, right, base } = this.frame;
        _a.copy(base).addScaledVector(right, B.offset[0]).addScaledVector(UP, B.offset[1]).addScaledVector(fwd, -B.offset[2]);
        _b.copy(base).addScaledVector(right, B.lookAt[0]).addScaledVector(UP, B.lookAt[1]).addScaledVector(fwd, B.lookAt[2]);
        out.pos.lerp(_a, k); out.target.lerp(_b, k); out.fov = lerp(out.fov, B.fov, k);
        return;
      }
      case Shot.ARENA: {
        this._arenaPose(t, out);
        return;
      }
      case Shot.FLYIN: {
        const F = T.flyin;
        this._ringPose(ctx, 0, out);
        const k = easeInOutSine(t / F.dur);
        // a high arc from where the arena shot was, swooping down to ring level
        _a.copy(this._start.pos);
        _c.lerpVectors(_a, out.pos, 0.5); _c.y = Math.max(_a.y, out.pos.y) * 0.65 + F.arc;
        bezier(_a, _c, out.pos, k, _d);
        out.target.lerpVectors(this._start.target, out.target, smoother(t / F.dur));
        out.fov = lerp(this._start.fov, out.fov, k);
        out.pos.copy(_d);
        out.roll = 0;
        return;
      }
      case Shot.RING:
        this._ringPose(ctx, t, out);
        return;
      case Shot.HIT:
        this._hitPose(ctx, out);
        return;
      case Shot.KD_WIDE:
        this._kdWidePose(ctx, t, out);
        return;
      case Shot.PLAYER_DOWN:
        this._playerDownPose(ctx, t, out);
        return;
      case Shot.DECISION: {
        const D = T.decision;
        const e = easeOutCubic(t / 6);
        const { fwd, right } = FRAME.p1; // the same side-on two-shot in every viewport
        out.pos.set(0, D.height, 0).addScaledVector(right, -(D.side - D.push * e)).addScaledVector(fwd, -D.toward);
        // inside the ropes whatever the arena's yaw, like RING / RESULT / PLAYER_DOWN (VISUAL-01:
        // unclamped it stood 0.3–0.6 m outside, level with the top rope)
        clampInRing(out.pos);
        out.target.set(0, D.lookY, 0);
        out.fov = D.fov; out.roll = 0;
        return;
      }
      case Shot.RESULT: {
        const R = T.result;
        const focus = ctx?.versus ? this.side : ctx?.winner;
        if (!focus || !ctx?.pos) { this._wideTwoShot(t, out); return; }
        const p = ctx.pos[focus];
        const yaw = ctx.yaw?.[focus] ?? (focus === 'p1' ? Math.PI : 0);
        _b.set(Math.sin(yaw), 0, Math.cos(yaw));               // where the focus boxer faces
        _c.crossVectors(_b, UP).normalize();                   // their right
        const outer = Math.sign(_c.x * p.x + _c.z * p.z) || 1;
        const e = easeOutCubic(t / 5);
        out.pos.copy(p).addScaledVector(_b, R.dist - R.push * e).addScaledVector(_c, outer * R.side * (1 - 0.4 * e));
        out.pos.y = R.height;
        clampInRing(out.pos);
        out.target.copy(p); out.target.y = R.lookY;
        out.fov = R.fov; out.roll = 0;
        return;
      }
      case Shot.OUTRO: {
        const o = this._override;
        if (o) {
          if (o.pos) out.pos.copy(o.pos);
          if (o.target) out.target.copy(o.target);
          out.fov = Number.isFinite(o.fov) ? o.fov : 46;
          out.roll = Number.isFinite(o.roll) ? o.roll : 0;
        }
        return;
      }
      case Shot.MENU: {
        const M = T.menu;
        this._menuPhi += M.speed * dt;
        out.pos.set(Math.sin(this._menuPhi) * M.radius, M.height, Math.cos(this._menuPhi) * M.radius);
        out.target.set(0, M.lookY, 0);
        out.fov = M.fov; out.roll = 0;
        return;
      }
      case Shot.TRAINING: {
        const Tr = T.training;
        this._playPose(ctx, out, Tr.offset, Tr.lookAt, Tr.fov, 'training');
        if (ctx?.focus) out.target.lerp(_tgt.copy(ctx.focus), 0.7); // keep the lean parallax, aim at the bag / trainer
        return;
      }
      default:
        this._playPose(ctx, out, P.offset, P.lookAt, fovPlay);
    }
  }

  /**
   * Behind-the-boxer pose with lean follow. ctx may be null (initial placement).
   * The look target is given as [right, up, fwd] (forward of the boxer, toward the opponent).
   */
  _playPose(ctx, out, offset, look, fov, kind = 'play', dt = 0) {
    const F = RIG_TUNING.play.follow;
    const L = this._lean;
    const { fwd, right, base } = this.frame;
    const duck = L.y < 0 ? L.y * F.duck : L.y * F.up;
    const back = offset[2] - L.z * F.z;
    const lookUp = look[1] + Math.min(0, L.y) * F.lookY;
    out.pos.copy(base).addScaledVector(UP, offset[1] + duck).addScaledVector(fwd, -back);
    out.fov = fov;
    if (kind === 'training') {
      // training keeps its linear, metre-based follow and its head-tilt roll (look[2] is a −Z
      // distance in the owner's frame: the legacy convention)
      out.pos.addScaledVector(right, offset[0] + L.x * 0.4);
      out.target.copy(base).addScaledVector(right, look[0] + L.x * 0.12).addScaledVector(UP, lookUp).addScaledVector(fwd, -look[2]);
      out.roll = this.reducedMotion ? 0 : -L.x * RIG_TUNING.training.roll || 0; // (|| 0: never −0)
      return;
    }
    // The fight view answers a dodge-level lean with most of its slide (Q4), as a share of THIS
    // viewport's width (R6); lean noise below the camera's soft deadzone moves nothing (R8).
    const aspect = this.camera.aspect;
    const v = viewportFollowScale(fov, aspect), wide = Math.max(1, viewportFollowScale(fov, aspect, false));
    const lx = leanSlide(leanDeadzone(L.x), F.knee, F.kneeGain + F.kneeNarrow * (1 - v));
    const a = Math.abs(lx), sg = lx < 0 ? -1 : 1;
    // The right-hand response to |lx| in the rest geometry: the camera slides s, and the look turns
    // by the angle a target swinging lookX (× the uncapped ratio in views wider than 16:9, so the
    // slide stays a share of THEIR width) takes it. A left lean gets the mirror image (R8): the same
    // slide and turn toward the other side.
    const rx = look[0] - offset[0], rf = look[2] + offset[2];
    const s = a * F.x * v;
    const turn = sg * (Math.atan2(rx + a * F.lookX * v * wide - s, rf) - Math.atan2(rx, rf));
    // the look target stays at its rest distance (for this lean in / back) and height: the horizon
    // stays level, no pitch on a sideways lean either way
    const cx = offset[0] + sg * s, cf = -back;
    const dx = look[0] - offset[0], df = look[2] - cf;
    const d = Math.hypot(dx, df), yaw = Math.atan2(dx, df) + turn;
    out.pos.addScaledVector(right, cx);
    out.target.copy(base)
      .addScaledVector(right, cx + d * Math.sin(yaw))
      .addScaledVector(UP, lookUp)
      .addScaledVector(fwd, cf + d * Math.cos(yaw));
    out.roll = this.reducedMotion ? 0 : -lx * F.roll || 0;
    if (ctx) this._keepFoeInView(ctx, out, dt);
  }

  /**
   * Keep-in-view turn (R6, R8): where the opponent's head (ctx.head, this frame) projects beyond
   * 0.5 ± keep.soft of this viewport's width, the look turns toward it — the wanted turn brings the
   * head to its soft-edged spot (never past 0.5 ± keep.edge; the single view uses the wider
   * softSingle / edgeSingle), and the applied turn follows it critically damped (keep.tau) at no
   * more than keep.rate °/s, so the opponent's slips, lunges and hit reactions never drag the view
   * 1:1 (the head may run past the edge while the turn catches up). Exact projection (fov, aspect,
   * roll) of the un-turned pose; the turn is about the vertical axis through the lens, so it never
   * changes which own part hides the face.
   */
  _keepFoeInView(ctx, out, dt) {
    const K = RIG_TUNING.play.follow.keep, S = this._keep;
    let want = 0;
    const h = ctx.head?.[other(this.side)];
    if (h && Number.isFinite(h.x) && Number.isFinite(h.z)) {
      const T = Math.tan((out.fov * Math.PI) / 360) * this.camera.aspect;
      _fwd.subVectors(out.target, out.pos);
      if (_fwd.lengthSq() > 1e-8) {
        _fwd.normalize();
        _rgt.crossVectors(_fwd, UP);
        if (_rgt.lengthSq() > 1e-8) {
          _rgt.normalize();
          _up.crossVectors(_rgt, _fwd);
          _c.subVectors(h, out.pos);
          const depth = _c.dot(_fwd);
          if (depth > 1e-3) {
            // camera-space x of the head (the roll turns the lens's right axis toward its up axis)
            const x = (_c.dot(_rgt) * Math.cos(out.roll) + _c.dot(_up) * Math.sin(out.roll)) / depth / T;
            const vs = !!ctx.versus;
            const to = softEdge(x, 2 * (vs ? K.soft : K.softSingle), 2 * (vs ? K.edge : K.edgeSingle));
            want = Math.atan(x * T) - Math.atan(to * T); // > 0: turn right, toward the head
          }
        }
      }
    }
    if (dt > 0) {
      // critically damped step toward `want` (exact for a constant target), speed-capped
      const w = 1 / K.tau, e = Math.exp(-w * dt), x0 = S.yaw - want;
      const c = S.vel + w * x0;
      const cap = (K.rate * Math.PI) / 180;
      const vel = Math.max(-cap, Math.min(cap, (S.vel - w * c * dt) * e));
      const next = want + (x0 + c * dt) * e;
      S.yaw += Math.max(-cap * dt, Math.min(cap * dt, next - S.yaw));
      S.vel = vel;
    }
    const turn = S.yaw;
    if (Math.abs(turn) < 1e-7) return;
    // rotate the horizontal look direction about the vertical axis through the lens
    const dx = out.target.x - out.pos.x, dz = out.target.z - out.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return;
    const fx = dx / dist, fz = dz / dist, c = Math.cos(turn), s = Math.sin(turn);
    out.target.x = out.pos.x + (fx * c - fz * s) * dist;
    out.target.z = out.pos.z + (fz * c + fx * s) * dist;
  }

  /** High, wide arena establishing shot from behind this rig's corner (slow drift). */
  _arenaPose(t, out) {
    const A = RIG_TUNING.arena;
    const { fwd, right } = this.frame;
    const ang = A.angle + A.drift * t;
    out.pos.set(0, A.height, 0)
      .addScaledVector(fwd, -Math.cos(ang) * A.dist)
      .addScaledVector(right, Math.sin(ang) * A.dist);
    out.target.set(0, A.lookY, 0);
    out.fov = A.fov; out.roll = 0;
  }

  /** Ring-level side shot of both fighters (the end of the fly-in). */
  _ringPose(ctx, t, out) {
    const R = RIG_TUNING.ring;
    const { fwd, right } = this.frame;
    const p1 = ctx?.pos?.p1, p2 = ctx?.pos?.p2;
    if (p1 && p2) _a.lerpVectors(p1, p2, 0.5); else _a.set(0, 0, 0);
    _a.y = 0;
    const push = R.push * easeOutCubic(t / R.pushSec);
    out.pos.copy(_a).addScaledVector(right, -(R.side - push)).addScaledVector(fwd, -R.toward);
    out.pos.y = R.height;
    clampInRing(out.pos);
    out.target.copy(_a); out.target.y = R.lookY;
    out.fov = R.fov; out.roll = 0;
  }

  /** Tight over-the-shoulder of this rig's player looking at the opponent (the player is solid). */
  _hitPose(ctx, out) {
    const H = RIG_TUNING.hit;
    const me = this.side, foe = other(me);
    this._headOf(ctx, me, _a);
    this._headOf(ctx, foe, _b);
    _d.subVectors(_b, _a).setY(0);
    if (_d.lengthSq() < 1e-6) _d.copy(this.frame.fwd);
    _d.normalize();
    _r.crossVectors(_d, UP).normalize(); // the player's right
    const s = this._hit.side;
    const V = H.variants[s > 0 ? 0 : 1];
    out.pos.copy(_a).addScaledVector(_d, -V.back).addScaledVector(_r, V.side);
    out.pos.y += V.up;
    out.target.copy(_b).addScaledVector(_r, -s * 0.06);
    out.target.y -= V.lookDrop;
    out.fov = H.fov; out.roll = this.reducedMotion ? 0 : -s * 0.035;
  }

  /** High wide shot from behind the standing boxer, looking down at the one on the canvas. */
  _kdWidePose(ctx, t, out) {
    const K = RIG_TUNING.kdWide;
    const downed = ctx?.downed ?? ctx?.koLoser ?? other(this.side);
    const standing = other(downed);
    const S = ctx?.pos?.[standing];
    if (!S) { this._playPose(ctx, out, RIG_TUNING.play.offset, RIG_TUNING.play.lookAt, RIG_TUNING.play.fov); return; }
    this._bodyOf(ctx, downed, _b);
    _d.subVectors(_b, S).setY(0);
    if (_d.lengthSq() < 1e-6) _d.copy(FRAME[standing].fwd);
    _d.normalize();
    _r.crossVectors(_d, UP).normalize();
    const back = K.back - K.push * easeOutCubic(t / K.pushSec);
    out.pos.copy(S).addScaledVector(_d, -back).addScaledVector(_r, K.side);
    out.pos.y = K.height;
    // aim well short of the body: it lies in the upper third and the HUD count (47% down) overlays the
    // standing player, as in the reference wide shot (research/mechanics.md §6; integration pass: aimShort 0.6 → 1.25)
    out.target.copy(_b).addScaledVector(_d, -K.aimShort);
    out.target.y = K.lookY;
    out.fov = K.fov; out.roll = 0;
  }

  /** Low shot: this rig's player face-down in the foreground, the opponent upright at the far side. */
  _playerDownPose(ctx, t, out) {
    const D = RIG_TUNING.playerDown;
    const me = this.side, foe = other(me);
    const O = ctx?.pos?.[foe];
    this._bodyOf(ctx, me, _b);
    if (!O) { this._playPose(ctx, out, RIG_TUNING.play.offset, RIG_TUNING.play.lookAt, RIG_TUNING.play.fov); return; }
    _d.subVectors(O, _b).setY(0);
    if (_d.lengthSq() < 1e-6) _d.copy(this.frame.fwd);
    _d.normalize();
    _r.crossVectors(_d, UP).normalize();
    const drift = D.drift * Math.sin(Math.min(t, 8) * 0.2);
    out.pos.copy(_b).addScaledVector(_d, -D.back).addScaledVector(_r, D.side + drift);
    out.pos.y = D.height;
    clampInRing(out.pos);
    out.target.lerpVectors(_b, O, D.toward);
    out.target.y = D.lookY;
    out.fov = D.fov; out.roll = 0;
  }

  _wideTwoShot(t, out) {
    out.pos.set(0, 1.7, 0).addScaledVector(CINE_SIDE, 4.6 - 0.5 * easeOutCubic(t / 6));
    out.target.set(0, 1.0, 0);
    out.fov = 46; out.roll = 0;
  }

  /** Head centre of a boxer (from ctx.head when the renderer provides it, else estimated). */
  _headOf(ctx, id, out) {
    const h = ctx?.head?.[id];
    if (h && Number.isFinite(h.x)) return out.copy(h);
    const p = ctx?.pos?.[id] ?? FRAME[id].base;
    return out.set(p.x, 1.2, p.z);
  }

  /** Where a downed boxer's body lies (from ctx.body, else estimated: fallen backwards). */
  _bodyOf(ctx, id, out) {
    const b = ctx?.body?.[id];
    if (b && Number.isFinite(b.x)) { out.copy(b); out.y = Math.min(out.y, 0.4); return out; }
    const p = ctx?.pos?.[id] ?? FRAME[id].base;
    out.copy(p).addScaledVector(FRAME[id].fwd, -0.55);
    out.y = 0.25;
    return out;
  }

  _apply(shake) {
    const cam = this.camera;
    const p = this.pose;
    _fwd.subVectors(p.target, p.pos);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _rgt.crossVectors(_fwd, UP);
    if (_rgt.lengthSq() < 1e-8) _rgt.set(1, 0, 0);
    _rgt.normalize();
    _up.crossVectors(_rgt, _fwd);
    const sx = shake?.x ?? 0, sy = shake?.y ?? 0, sr = shake?.roll ?? 0;
    cam.position.copy(p.pos).addScaledVector(_rgt, sx).addScaledVector(_up, sy);
    _tgt.copy(p.target).addScaledVector(_rgt, sx * 0.5).addScaledVector(_up, sy * 0.5);
    cam.up.copy(UP);
    cam.lookAt(_tgt);
    const roll = p.roll + sr;
    if (roll !== 0) cam.rotateZ(roll);
    if (Math.abs(cam.fov - p.fov) > 1e-3) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}

function clampN(x) { return Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0; }

function bezier(a, c, b, t, out) {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
}

/** Keep a canvas-level camera inside the ropes whatever the arena's yaw (a circle inside the square). */
function clampInRing(p) {
  const R = RIG_TUNING.insideRadius;
  const r = Math.hypot(p.x, p.z);
  if (r > R) { p.x *= R / r; p.z *= R / r; }
  return p;
}
