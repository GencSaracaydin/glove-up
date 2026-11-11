// Own-part fade (R8, owner: view3d).
//
// In the live view the camera stands just behind the viewer's own see-through head and solid gloves,
// and a lean toward the camera's own side (the player's left) turns the view so the opponent's face
// slides toward them: the camera's left lean mirrors its right one (camera-rig.js) instead of
// dodging the own parts. So the viewer's OWN parts fade while they overlap the opponent's face on
// screen (the reference's own avatar is see-through, so a faded own part is in its spirit): each
// glove to OWN_FADE_LOOK.glove opacity, the head to OWN_FADE_LOOK.head × its ghost opacity
// (BoxerModel.setOwnFade). Only the viewer's own model in its own viewport is faded (the ghost
// material set); the opponent and every other view stay as they are. The same covers the
// opponent's hook lunging toward the own side, both players leaning the same way and the opponent
// slipping behind the own head.
//
// A cheap screen-space test: a sphere around the opponent's face (BoxerModel.partSpheres) and the
// bounding spheres of each own glove / the own head (× `size`), as circles of view directions from
// the viewer's camera. A part fades once it covers more than `on` of the face circle — or, while
// the view is turning toward its own side (the lean follow, faster than `turning` units of
// CameraRig.ownShift per s) or, for the gloves, while the opponent's head is moving in the arena
// faster than `moving` m/s (a lunge, a slip, a hit snap), more than `onAhead` where both are
// heading: each circle carried `lookahead` s ahead at its own (smoothed) image velocity, so a glove
// the face is sweeping behind is already see-through when it gets there (the see-through head looks
// ahead only on the view's own turn: a lunge's curved path, carried straight ahead, would fade it
// without ever covering the face). The fade eases exponentially and settles in about `ms`; while the
// face sweeps in fast — the view's own turn, or the opponent's punch — it fades in within `msFast`
// (see-through in two frames). A part comes back once it covers less than `off` (and, while
// things move, less than `off` ahead too), after at least `hold` s; not while the opponent's punch
// is coming — from its wind-up (the tell) until `afterPunch` s after its glove is home (its lunge,
// then its arm and its face coming back out, would cover the guard again); and during a held lean
// toward the own side only after the part has been clearly apart from the face (`releaseGap` face
// radii) for `releaseHeld` s, so the opponent's idle drift, the own idle sway and a webcam player's
// tracking noise never switch a part on and off while nobody moves. A glove out on a punch or pulling
// back from one never fades (it is the punch). The gloves fade only while the view follows a lean
// toward the camera's own side (CameraRig.ownShift ≥ glove.lean): that lean is what carries the face
// behind them, and a player standing behind a resting guard keeps it solid when the opponent's punch
// carries its face behind it (the classic guard look); the see-through head may fade at any time.
// The renderer fades only in the live shot (Shot.PLAY): the round-start settle shot keeps the
// normal look.
// Pure (THREE math only): the renderer runs one OwnFade per viewer; the unit tests run the same code
// on the real models and CameraRig.

import * as THREE from 'three';

/** Fade timing and triggers (cover = share of the opponent's face circle). */
export const OWN_FADE = Object.freeze({
  ms: 80,
  // fading in while the face is sweeping in fast — while the opponent's punch is coming (wind-up to
  // recovery: its face lunges in within a few frames) or the view turns toward its own side (the lean
  // follow): see-through in two frames
  msFast: 35,
  lookahead: 0.1,
  moving: 0.4,
  hold: 0.25,
  afterPunch: 0.25,
  turning: 0.8,
  // during a held lean toward the own side a faded part stays faded until it has been clearly apart
  // from the face (a gap of more than `releaseGap` face radii between the circles) for `releaseHeld`
  // s: the idle sway and a webcam player's tracking noise never switch it on and off
  releaseGap: 0.3,
  releaseHeld: 0.6,
  glove: Object.freeze({ size: 0.9, on: 0.13, onAhead: 0.1, off: 0.09, lean: 0.15 }),
  head: Object.freeze({ size: 1, on: 0.3, onAhead: 0.25, off: 0.2 }),
});

const PARTS = ['left', 'right', 'head'];

/**
 * Share of circle 1's area covered by circle 2 (centres (x1, y1) and (x2, y2), radii r1 and r2;
 * any consistent units). 0..1.
 */
export function circleCover(x1, y1, r1, x2, y2, r2) {
  if (!(r1 > 0) || !(r2 > 0)) return 0;
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
  const a1 = r1 * r1 * Math.acos(Math.min(1, Math.max(-1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))));
  const a2 = r2 * r2 * Math.acos(Math.min(1, Math.max(-1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
  const k = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return Math.min(1, (a1 + a2 - k) / (Math.PI * r1 * r1));
}

const _p = new THREE.Vector3();
const _c1 = { x: 0, y: 0, r: 0 };
const _c2 = { x: 0, y: 0, r: 0 };

/**
 * A world sphere as a circle of view directions (azimuth, elevation and angular radius, radians):
 * unlike its image (an ellipse stretched toward the edges of a wide view), the overlap of two such
 * circles is the same share wherever they sit in the frame. False when not in front.
 */
function circleOf(camera, s, out) {
  _p.copy(s.c).applyMatrix4(camera.matrixWorldInverse);
  const z = -_p.z, d = _p.length();
  if (!(z > s.r * 1.05) || !(d > s.r)) return false;
  out.x = Math.atan2(_p.x, z); out.y = Math.atan2(_p.y, Math.hypot(_p.x, z));
  out.r = Math.asin(s.r / d);
  return true;
}

const sphere = () => ({ c: new THREE.Vector3(), r: 0 });
const track = () => ({ x: 0, y: 0, vx: 0, vy: 0, ok: false });
/** Follow a circle's image position; its velocity smoothed over about two frames. */
function follow(t, c, dt) {
  if (t.ok && dt > 0) {
    t.vx = 0.5 * t.vx + 0.5 * ((c.x - t.x) / dt);
    t.vy = 0.5 * t.vy + 0.5 * ((c.y - t.y) / dt);
  } else { t.vx = 0; t.vy = 0; }
  t.x = c.x; t.y = c.y; t.ok = true;
}

export class OwnFade {
  constructor() {
    /** Current fade per part (0 = the normal look, 1 = faded) — pass to BoxerModel.setOwnFade. */
    this.value = { left: 0, right: 0, head: 0 };
    /** The last measured cover of the face circle per part, now and `lookahead` ahead. */
    this.cover = { left: 0, right: 0, head: 0 };
    this.ahead = { left: 0, right: 0, head: 0 };
    this._on = { left: false, right: false, head: false };
    this._since = { left: 0, right: 0, head: 0 };
    this._clear = { left: 0, right: 0, head: 0 };
    this._track = { face: track(), left: track(), right: track(), head: track() };
    this._foePos = new THREE.Vector3();
    this._foeSpeed = 0;
    this._foeOk = false;
    this._sincePunch = Infinity;
    this._attack = false;
    this._shift = 0; this._shiftRate = 0; this._shiftOk = false;
    this._own = { head: sphere(), left: sphere(), right: sphere() };
    this._foe = { head: sphere(), left: sphere(), right: sphere(), face: sphere() };
  }

  /** Back to the normal look at once (new match, scene change). */
  reset() {
    for (const k of PARTS) { this.value[k] = 0; this.cover[k] = 0; this.ahead[k] = 0; this._on[k] = false; this._since[k] = 0; this._clear[k] = 0; }
    for (const t of Object.values(this._track)) { t.ok = false; t.vx = 0; t.vy = 0; }
    this._foeOk = false; this._foeSpeed = 0; this._sincePunch = Infinity; this._attack = false;
    this._shiftOk = false; this._shift = 0; this._shiftRate = 0;
    return this.value;
  }

  /**
   * Advance by `dt` real seconds. `camera` is the viewer's camera (matrices current), `own` the
   * viewer's ghosted BoxerModel, `foe` the opponent's, `shift` the viewer's rig's ownShift (how far
   * its view follows a lean toward the camera's own side, 0..1). Returns `this.value`.
   * @param {number} dt @param {THREE.Camera} camera @param {Object} own @param {Object} foe
   * @param {number} [shift]
   */
  update(dt, camera, own, foe, shift = 1) {
    const sh = Number.isFinite(shift) ? shift : 0;
    const sliding = sh >= OWN_FADE.glove.lean;
    // the view turning toward its own side (the lean follow's rate, smoothed over about two frames)
    if (this._shiftOk && dt > 0) this._shiftRate = 0.5 * this._shiftRate + 0.5 * ((sh - this._shift) / dt);
    this._shift = sh; this._shiftOk = true;
    const turning = this._shiftRate > OWN_FADE.turning;
    const want = { left: false, right: false, head: false };
    this._attack = false;
    if (camera && own?.partSpheres && foe?.partSpheres) {
      own.partSpheres(this._own);
      foe.partSpheres(this._foe);
      // the opponent's head speed in the arena (smoothed over about two frames)
      const hc = this._foe.head.c;
      if (this._foeOk && dt > 0) this._foeSpeed = 0.5 * this._foeSpeed + 0.5 * (hc.distanceTo(this._foePos) / dt);
      this._foePos.copy(hc); this._foeOk = true;
      const lunging = this._foeSpeed > OWN_FADE.moving;
      // the opponent's punch, from its wind-up (the tell) until `afterPunch` s after its glove is home
      const attacking = foe.attacking ? foe.attacking() : !!(foe.handBusy?.('left') || foe.handBusy?.('right'));
      if (attacking) this._sincePunch = 0;
      else this._sincePunch += Math.max(0, dt || 0);
      const punching = this._sincePunch < OWN_FADE.afterPunch;
      this._attack = punching;
      // the face itself (BoxerModel.partSpheres' face sphere; the whole skull without one)
      const faceSphere = this._foe.face.r > 0 ? this._foe.face : this._foe.head;
      if (circleOf(camera, faceSphere, _c1)) {
        const L = OWN_FADE.lookahead;
        follow(this._track.face, _c1, dt);
        const F = this._track.face, fx = _c1.x + F.vx * L, fy = _c1.y + F.vy * L;
        for (const k of PARTS) {
          const s = this._own[k], P = this._track[k];
          const G = k === 'head' ? OWN_FADE.head : OWN_FADE.glove;
          const on = G.on, off = G.off;
          const busy = k !== 'head' && !!own.handBusy?.(k);
          let c = 0, a = 0, gap = Infinity;
          if (s.r > 0 && !busy) {
            s.r *= G.size;
            if (circleOf(camera, s, _c2)) {
              follow(P, _c2, dt);
              c = circleCover(_c1.x, _c1.y, _c1.r, _c2.x, _c2.y, _c2.r);
              a = circleCover(fx, fy, _c1.r, _c2.x + P.vx * L, _c2.y + P.vy * L, _c2.r);
              gap = (Math.hypot(_c2.x - _c1.x, _c2.y - _c1.y) - _c1.r - _c2.r) / _c1.r;
            } else P.ok = false;
          } else P.ok = false;
          // looking ahead: the gloves while the opponent's head moves (its lunge) or the view turns
          // toward its own side; the see-through head only on the view's own turn (a lunge's curved
          // path, carried straight ahead, would fade it without ever covering the face)
          const moving = turning || (k !== 'head' && lunging);
          this.cover[k] = c; this.ahead[k] = moving ? a : 0;
          const step = Math.max(0, dt || 0);
          if (this._on[k]) this._since[k] += step;
          // how long the part has been clearly apart from the face
          this._clear[k] = gap > OWN_FADE.releaseGap ? this._clear[k] + step : 0;
          if (busy) this._on[k] = false;
          else if ((k === 'head' || sliding) && (c > on || (moving && a > Math.min(on, G.onAhead)))) { if (!this._on[k]) this._since[k] = 0; this._on[k] = true; }
          else if (c < off && (!moving || a < off) && !punching && this._since[k] >= OWN_FADE.hold
            && (!sliding || this._clear[k] >= OWN_FADE.releaseHeld)) this._on[k] = false;
          want[k] = this._on[k];
        }
      } else {
        for (const t of Object.values(this._track)) t.ok = false;
        for (const k of PARTS) { this.cover[k] = 0; this.ahead[k] = 0; this._on[k] = false; }
      }
    }
    // exponential ease: ≈ 97 % of the way in `ms`; fading in while the face sweeps in fast: `msFast`
    const d = Math.max(0, dt || 0);
    const e = 1 - Math.exp((-3.5 * d) / (OWN_FADE.ms / 1000));
    const eFast = 1 - Math.exp((-3.5 * d) / (OWN_FADE.msFast / 1000));
    for (const k of PARTS) {
      const t = want[k] ? 1 : 0;
      const fast = t > this.value[k] && (turning || this._attack);
      this.value[k] += (t - this.value[k]) * (fast ? eFast : e);
      if (Math.abs(t - this.value[k]) < 1e-3) this.value[k] = t;
    }
    return this.value;
  }
}
