// Training props + staging (owner: training): the heavy bag on its stand, the trainer with focus
// mitts, tennis balls — everything the three practice activities need on top of the ring.
//
// Our own look (render/style.js palette, toy-like and readable):
//   * BAG — a stitched leather heavy bag (a new colour for every tougher bag) on a chain from a
//     teal gym stand with golden caps; it swings exactly as the logic's pendulum says (TrainingView
//     .bag), squashes and flashes on hits, gets taped up as it weakens, its top link strains and
//     glows before the chain snaps; the dropped bag falls, topples away and rolls aside; the next
//     bag is lowered in on its chain. A floating strength meter shows partial credit.
//   * TRAINER — BoxerModel(role 'trainer'). Target punching: navy focus mitts with a cream face and
//     a coral bullseye, attached via handAnchor(); a raised mitt gets a pulsing gold ring and a
//     shrinking countdown ring, pops on a hit; resting mitts hang low, face down. Dodging drill: the
//     trainer walks between spots, raises the ball (aim — the readable tell), throws with
//     trainerThrow() so the release lines up with the logic; doubles throw both hands.
//   * BALLS — oversized fuzzy yellow-green tennis balls (CanvasTexture seam), spin, a short trail,
//     a blob shadow on the canvas, a faint landing ring where each ball will cross your head plane.
//   * The player's own boxer: the GameRenderer ghosts it (trainee slot); when this scene is used
//     without a GameRenderer (e.g. a bare three.js page) it draws its own ghost BoxerModel driven
//     by TrainingView.playerView (opts.drawPlayer).
//   * Camera: `focus` (THREE.Vector3, read by GameRenderer → CameraRig training shot) and a
//     suggested `cameraPose` per activity.
//
// Everything is driven by the TrainingView (pausable, deterministic); dt only drives cosmetic
// springs. Imports cleanly in Node (canvas textures are only drawn when a document exists).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PALETTE, LAYOUT, CAMERA, FONTS, vinyl, leather, css } from './style.js';
import { BoxerModel } from './boxer-model.js';
import { TRAINING_LAYOUT, headWorld } from '../training/activity.js';
import { BAG_TUNING } from '../training/bag.js';
import { DODGE_TUNING } from '../training/dodge.js';
import { MITTS_TUNING } from '../training/mitts.js';

/** Visual knobs of the training props (metres, seconds). */
export const TRAINING_PROPS_TUNING = Object.freeze({
  /** One leather colour set per bag (bag n uses entry min(n, last)). */
  bagTiers: Object.freeze([
    Object.freeze({ leather: 0xc98140, band: 0x7f4a22, stitch: 0xfff1d6, emblem: 0xffc94a }), // caramel
    Object.freeze({ leather: 0xe85a4f, band: 0x9b2b26, stitch: 0xfff1d6, emblem: 0xffc94a }), // coral red
    Object.freeze({ leather: 0x3d6bd8, band: 0x223f8f, stitch: 0xf7f3ea, emblem: 0xffc94a }), // royal blue
    Object.freeze({ leather: 0x9b59c9, band: 0x5d2d86, stitch: 0xfff1d6, emblem: 0xffd166 }), // plum
    Object.freeze({ leather: 0xf2b630, band: 0xa8730f, stitch: 0xfffaf0, emblem: 0xff6b5a }), // sunflower
    Object.freeze({ leather: 0x353b55, band: 0xffc94a, stitch: 0xffc94a, emblem: 0xffc94a }), // champion black-and-gold
    Object.freeze({ leather: 0xf7f3ea, band: 0x14182b, stitch: 0x14182b, emblem: 0xff6b5a }), // ivory
  ]),
  stand: Object.freeze({ color: PALETTE.ropeC, cap: PALETTE.post, halfWidth: 0.82, height: 2.8, foot: 0.95 }),
  chain: Object.freeze({ color: 0xcfd5e2, linkR: 0.026, linkTube: 0.0078, pitch: 0.05, strapLen: 0.24, strapColor: 0x2a2f45 }),
  /** Strength gauge mounted on the stand's left upright, facing the player. */
  meter: Object.freeze({ y0: 0.92, height: 0.86, width: 0.085, full: PALETTE.uiGood, mid: PALETTE.uiWarn, low: PALETTE.uiAccent }),
  hitSquash: 0.06,
  mitt: Object.freeze({ body: 0x1f3b73, face: 0xfffaf0, ring: PALETTE.uiAccent, glow: PALETTE.post, radius: 0.1, depth: 0.034, palmOffset: 0.045 }),
  ball: Object.freeze({ color: 0xd9ef3c, seam: 0xfffbe8, radius: DODGE_TUNING.ball.radius, trail: 6 }),
  /** Where the trainer waits in bag practice (beside the bag, watching). */
  bagCoach: Object.freeze({ pos: Object.freeze([1.5, 0, -1.0]) }),
  /** Camera framing per activity: GameRenderer's CameraRig aims at `focus`; `pose` is a suggestion. */
  camera: Object.freeze({
    bag: Object.freeze({ focus: Object.freeze([0, 1.22, -0.56]), pose: Object.freeze({ offset: [0, 1.88, 1.38], lookAt: [0, 1.18, -1.1], fov: CAMERA.fov }) }),
    dodge: Object.freeze({ focus: Object.freeze([0, 1.12, -1.55]), pose: Object.freeze({ offset: [0, 1.9, 1.45], lookAt: [0, 1.1, -2.1], fov: CAMERA.fov }) }),
    mitts: Object.freeze({ focus: Object.freeze([0, 1.12, -0.66]), pose: Object.freeze({ offset: [0, 1.85, 1.3], lookAt: [0, 1.1, -1.2], fov: CAMERA.fov }) }),
    lambda: 4,
  }),
});

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => { k = clamp01(k); return k * k * (3 - 2 * k); };
const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

function makeCanvas(w, h) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasTexture(canvas, { srgb = true, repeatU = false } = {}) {
  if (!canvas) return null;
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeatU) t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ───────────────────────────── textures ─────────────────────────────

/** Leather heavy-bag skin for a LatheGeometry whose profile is resampled evenly by arc length. */
function drawBagTexture(tier, vSide, aspect = 1) {
  const W = 512, H = 640;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  const [v0, v1] = vSide; // side wall spans v0..v1 (0 = bottom pole, 1 = top pole)
  const yOf = (v) => (1 - v) * H;
  // base leather with a soft vertical light gradient and fine grain
  g.fillStyle = css(tier.leather);
  g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  let seed = 1337;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // caps + bands (v1..1 is the top cap, 0..v0 the bottom cap)
  const band = 0.075;
  g.fillStyle = css(tier.band);
  g.fillRect(0, 0, W, yOf(v1) + 1);                          // top cap
  g.fillRect(0, yOf(v1), W, band * H);                       // top band
  g.fillRect(0, yOf(v0 + band), W, band * H);                // bottom band
  g.fillRect(0, yOf(v0) - 1, W, H - yOf(v0) + 1);            // bottom cap
  // stitching
  const stitch = css(tier.stitch);
  const dashedH = (v) => {
    g.strokeStyle = stitch; g.lineWidth = 3; g.setLineDash([9, 7]);
    g.beginPath(); g.moveTo(0, yOf(v)); g.lineTo(W, yOf(v)); g.stroke();
  };
  dashedH(v1 - band - 0.012); dashedH(v1 - 0.012); dashedH(v0 + band + 0.012); dashedH(v0 + 0.012);
  // four vertical panel seams (away from the front emblem at u = 0)
  for (const u of [0.125, 0.375, 0.625, 0.875]) {
    const x = u * W;
    g.setLineDash([]);
    g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(x, yOf(v1 - band)); g.lineTo(x, yOf(v0 + band)); g.stroke();
    g.strokeStyle = stitch; g.lineWidth = 2.5; g.setLineDash([8, 7]);
    for (const dx of [-6, 6]) { g.beginPath(); g.moveTo(x + dx, yOf(v1 - band)); g.lineTo(x + dx, yOf(v0 + band)); g.stroke(); }
  }
  g.setLineDash([]);
  // front emblem (faces the player): a cream disc with a bullseye ring and a star — ours
  const vc = 0.5 - 0.05;
  const r = 0.11 * W;
  for (const cx of [0, W]) {
    g.save();
    g.translate(cx, yOf(vc));
    g.scale(1, aspect);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath(); g.arc(3, 5, r + 6, 0, TAU); g.fill();
    g.fillStyle = css(tier.stitch);
    g.beginPath(); g.arc(0, 0, r + 4, 0, TAU); g.fill();
    g.strokeStyle = css(tier.band); g.lineWidth = 9;
    g.beginPath(); g.arc(0, 0, r - 12, 0, TAU); g.stroke();
    g.fillStyle = css(tier.emblem);
    star(g, 0, 0, r * 0.55, r * 0.24, 5);
    g.strokeStyle = css(tier.band); g.lineWidth = 4; g.stroke();
    g.restore();
  }
  return canvasTexture(c, { repeatU: true });
}

function star(g, x, y, ro, ri, n) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? ri : ro;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

/** Tennis ball: fuzzy yellow-green felt with the classic curving seam (equirectangular). */
function drawBallTexture() {
  const W = 256, H = 128;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = css(TRAINING_PROPS_TUNING.ball.color);
  g.fillRect(0, 0, W, H);
  let seed = 77;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = rnd() < 0.55 ? 'rgba(120,150,0,0.16)' : 'rgba(255,255,210,0.22)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  const seam = (off, width, color) => {
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= 128; i++) {
      const u = i / 128;
      const v = 0.5 + 0.2 * Math.sin(2 * TAU * u + off);
      if (i === 0) g.moveTo(u * W, v * H); else g.lineTo(u * W, v * H);
    }
    g.stroke();
  };
  seam(0, 9, 'rgba(160,190,20,0.5)');
  seam(0, 5, css(TRAINING_PROPS_TUNING.ball.seam));
  return canvasTexture(c, { repeatU: true });
}

function drawBlobTexture() {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(20,24,43,0.55)');
  grad.addColorStop(0.55, 'rgba(20,24,43,0.28)');
  grad.addColorStop(1, 'rgba(20,24,43,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvasTexture(c, { srgb: false });
}

function drawLabel(text, color = PALETTE.uiPaper, outline = true) {
  const c = makeCanvas(256, 96);
  if (!c) return null;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 96);
  g.font = `76px ${FONTS.display}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (outline) {
    g.lineJoin = 'round';
    g.lineWidth = 12;
    g.strokeStyle = css(PALETTE.uiInk);
    g.strokeText(text, 128, 52);
  }
  g.fillStyle = css(color);
  g.fillText(text, 128, 52);
  return canvasTexture(c);
}

// ───────────────────────────── geometry helpers ─────────────────────────────

/** Evenly resampled rounded-cylinder profile for LatheGeometry (+ the v-range of its side wall). */
function bagProfile(radius, length, corner = 0.06, n = 72) {
  const half = length / 2;
  const pts = [];
  const add = (x, y) => pts.push(new THREE.Vector2(x, y));
  add(0, -half);
  add(radius - corner, -half);
  for (let i = 1; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2); add(radius - corner + Math.cos(a) * corner, -half + corner + Math.sin(a) * corner); }
  for (let i = 1; i <= 8; i++) { const y = -half + corner + (i / 8) * (length - 2 * corner); const bulge = Math.sin((i / 8) * Math.PI) * 0.006; add(radius + bulge, y); }
  for (let i = 1; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); add(radius - corner + Math.cos(a) * corner, half - corner + Math.sin(a) * corner); }
  add(0, half);
  // arc-length resampling so the texture is not stretched
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lens[lens.length - 1];
  const out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * total;
    while (j < lens.length - 1 && lens[j] < s) j++;
    const a = pts[j - 1], b = pts[j];
    const f = (s - lens[j - 1]) / Math.max(1e-9, lens[j] - lens[j - 1]);
    out.push(new THREE.Vector2(lerp(a.x, b.x, f), lerp(a.y, b.y, f)));
  }
  const capLen = (radius - corner) + (corner * Math.PI) / 2;
  return { points: out, vSide: [capLen / total, 1 - capLen / total], length: total };
}

/** A rounded puck (focus mitt pad) facing +Z: radius r, depth d. */
function puckGeometry(r, d) {
  const pts = [];
  const e = d / 2;
  pts.push(new THREE.Vector2(0, -e));
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI;
    pts.push(new THREE.Vector2(r - e + Math.cos(a) * e, Math.sin(a) * e));
  }
  pts.push(new THREE.Vector2(0, e));
  const g = new THREE.LatheGeometry(pts, 36);
  g.rotateX(Math.PI / 2); // lathe axis Y → Z (face toward +Z)
  return g;
}

// ───────────────────────────── the scene ─────────────────────────────

export class TrainingScene {
  /**
   * @param {import('./renderer.js').GameRenderer|null} renderer  GameRenderer (gives FX + draws the
   *        player's ghost) or null for a bare scene
   * @param {{drawPlayer?: boolean, trainer?: boolean}} [opts]
   *        drawPlayer: draw the player's ghost here (default: only when there is no GameRenderer)
   *        trainer: build the trainer model (default true)
   */
  constructor(renderer = null, opts = {}) {
    this.renderer = renderer || null;
    this.object3d = new THREE.Group();
    this.object3d.name = 'training-props';
    /** Point the GameRenderer's training camera aims at (smoothly follows the activity). */
    this.focus = new THREE.Vector3(...TRAINING_PROPS_TUNING.camera.bag.focus);
    /** Suggested camera pose relative to the player's spot ({offset, lookAt, fov}). */
    this.cameraPose = TRAINING_PROPS_TUNING.camera.bag.pose;
    this.kind = null;
    this._viewId = null;
    this._time = 0;
    this._drawPlayer = opts.drawPlayer ?? !(renderer && typeof renderer.renderTraining === 'function');
    this._wantTrainer = opts.trainer !== false;
    this._disposables = [];
    this._tex = { ball: drawBallTexture(), blob: drawBlobTexture() };
    for (const t of Object.values(this._tex)) if (t) this._disposables.push(t);
    this._buildBag();
    this._buildBalls();
    this._buildTrainer();
    this._buildPlayerGhost();
    this.setActivity('bag');
  }

  // ───────────── public API ─────────────

  /** Show the props of one activity ('bag' | 'dodge' | 'mitts'). */
  setActivity(kind) {
    const k = kind === 'dodge' || kind === 'mitts' ? kind : 'bag';
    this.kind = k;
    this.bagRig.visible = k === 'bag';
    this.ballsGroup.visible = k === 'dodge';
    for (const m of Object.values(this.mitts || {})) if (m) m.group.visible = k === 'mitts';
    this.cameraPose = TRAINING_PROPS_TUNING.camera[k].pose;
    this._resetTransient();
  }

  /** Point the camera aims at (also exposed as `focus`). */
  getFocus() { return this.focus; }

  /**
   * Sync the props to a TrainingView. Call every frame.
   * @param {Object} view  TrainingView (see training/activity.js getView)
   * @param {number} dt    seconds (0 while paused / during hit-stop)
   */
  update(view, dt) {
    if (!view) return;
    const kind = view.kind === 'dodge' || view.kind === 'mitts' ? view.kind : 'bag';
    if (kind !== this.kind) this.setActivity(kind);
    if (view.id && view.id !== this._viewId) { this._viewId = view.id; this._resetTransient(); }
    const d = view.paused ? 0 : Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    this._time += d;
    this._updateFocus(kind, d);
    if (kind === 'bag') this._updateBag(view, d);
    if (kind === 'mitts') this._mittTargets(view, d);
    this._updateTrainer(view, d);           // hands are set before the rig solves this frame …
    if (kind === 'dodge') this._updateBalls(view, d);   // … so held balls / mitts sit on this frame's hands
    if (kind === 'mitts') this._updateMitts(view, d);
    this._updatePlayer(view, d);
  }

  dispose() {
    this.trainer?.dispose();
    this.player?.dispose();
    for (const tex of Object.values(this._bagTex || {})) tex?.dispose();
    this._meterLabelTex?.dispose();
    this.object3d.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        if (o.userData.sharedGeo !== true) o.geometry?.dispose();
      }
    });
    for (const d of this._disposables) d?.dispose?.();
    this._disposables = [];
    this.object3d.removeFromParent();
  }

  // ───────────── construction: bag rig ─────────────

  _mat(m) { this._disposables.push(m); return m; }

  _buildBag() {
    const T = TRAINING_PROPS_TUNING, R = BAG_TUNING.rig;
    const rig = new THREE.Group();
    rig.name = 'bag-rig';
    this.object3d.add(rig);
    this.bagRig = rig;
    const S = T.stand;
    const steel = this._mat(vinyl(S.color, { roughness: 0.42 }));
    const capMat = this._mat(leather(S.cap));
    const z = R.pivot[2];
    // uprights, beam, feet, braces
    const upright = new RoundedBoxGeometry(0.1, S.height, 0.1, 3, 0.03);
    const beam = new RoundedBoxGeometry(S.halfWidth * 2 + 0.16, 0.12, 0.14, 3, 0.04);
    const foot = new RoundedBoxGeometry(0.17, 0.06, S.foot, 3, 0.025);
    const brace = new THREE.CylinderGeometry(0.022, 0.022, 1, 10);
    const cap = new THREE.SphereGeometry(0.075, 18, 12);
    const bolt = new THREE.CylinderGeometry(0.03, 0.03, 0.03, 14);
    for (const sx of [-1, 1]) {
      const x = sx * S.halfWidth;
      const u = new THREE.Mesh(upright, steel); u.position.set(x, S.height / 2, z); rig.add(u);
      const f = new THREE.Mesh(foot, steel); f.position.set(x, 0.03, z); rig.add(f);
      for (const sz of [-1, 1]) {
        const b = new THREE.Mesh(brace, steel);
        const a = new THREE.Vector3(x, 0.72, z), e = new THREE.Vector3(x, 0.05, z + sz * S.foot * 0.42);
        b.position.copy(a).add(e).multiplyScalar(0.5);
        b.scale.y = a.distanceTo(e);
        b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.clone().sub(a).normalize());
        rig.add(b);
        const fc = new THREE.Mesh(cap, capMat); fc.scale.set(0.6, 0.4, 0.6); fc.position.set(x, 0.06, z + sz * S.foot / 2); rig.add(fc);
      }
      const c = new THREE.Mesh(cap, capMat); c.position.set(x, S.height + 0.02, z); rig.add(c);
      const bl = new THREE.Mesh(bolt, capMat); bl.rotation.x = Math.PI / 2; bl.position.set(x, R.pivot[1] + 0.18, z + 0.075); rig.add(bl);
    }
    const bm = new THREE.Mesh(beam, steel); bm.position.set(0, R.pivot[1] + 0.18, z); rig.add(bm);
    // swivel under the beam
    const swivelMat = this._mat(new THREE.MeshStandardMaterial({ color: T.chain.color, metalness: 0.85, roughness: 0.28 }));
    this._chainMat = swivelMat;
    const sw = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.022, 0.09, 16), capMat);
    sw.position.set(0, R.pivot[1] + 0.075, z); rig.add(sw);
    for (const o of rig.children) { o.castShadow = true; o.receiveShadow = true; }

    // pendulum: pivot → chain → ring → straps → bag
    const pivot = new THREE.Group();
    pivot.position.set(R.pivot[0], R.pivot[1], R.pivot[2]);
    rig.add(pivot);
    this.bagPivot = pivot;
    const C = T.chain;
    const linkGeo = new THREE.TorusGeometry(C.linkR, C.linkTube, 8, 18);
    linkGeo.scale(1, 1.45, 1);
    // one instanced draw for the whole chain (links alternate 90°)
    const nLinks = Math.ceil((R.chainLen + BAG_TUNING.bags.dropHeight) / C.pitch) + 2;
    this.chain = new THREE.InstancedMesh(linkGeo, swivelMat, nLinks);
    this.chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chain.castShadow = true;
    this.chain.frustumCulled = false; // instances move far from the geometry's own bounds
    this.chain.userData.sharedGeo = true;
    this.chain.count = 0;
    pivot.add(this.chain);
    this._nLinks = nLinks;
    // the weakest (top) link glows and strains when the bag is nearly done
    this._strainMat = this._mat(new THREE.MeshStandardMaterial({ color: C.color, metalness: 0.7, roughness: 0.3, emissive: new THREE.Color(PALETTE.uiAccent), emissiveIntensity: 0 }));
    this.strainLink = new THREE.Mesh(linkGeo, this._strainMat);
    this.strainLink.userData.sharedGeo = true;
    this.strainLink.scale.setScalar(1.08);
    this.strainLink.visible = false;
    pivot.add(this.strainLink);
    this.hanger = new THREE.Group(); // ring + straps + bag, positioned at the top of the bag
    pivot.add(this.hanger);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.011, 8, 22), swivelMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = C.strapLen;
    this.hanger.add(ring);
    const strapMat = this._mat(vinyl(C.strapColor, { roughness: 0.6 }));
    const strapGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const top = new THREE.Vector3(Math.cos(a) * 0.03, C.strapLen, Math.sin(a) * 0.03);
      const bot = new THREE.Vector3(Math.cos(a) * R.radius * 0.78, 0.01, Math.sin(a) * R.radius * 0.78);
      const s = new THREE.Mesh(strapGeo, strapMat);
      s.position.copy(top).add(bot).multiplyScalar(0.5);
      s.scale.y = top.distanceTo(bot);
      s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bot).normalize());
      s.castShadow = true;
      this.hanger.add(s);
    }
    // the bag
    const prof = bagProfile(R.radius, R.bagLen);
    this._bagVSide = prof.vSide;
    // texture pixels per metre: 640 px over the profile vs 512 px around the circumference
    this._bagAspect = (640 / prof.length) / (512 / (TAU * R.radius));
    this._bagGeo = new THREE.LatheGeometry(prof.points, 48);
    this._bagTex = {};
    this._bagMat = this._mat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, emissive: new THREE.Color(0xfff1d6), emissiveIntensity: 0 }));
    this.bagBody = new THREE.Group();
    this.bagBody.position.y = -R.bagLen / 2;
    this.hanger.add(this.bagBody);
    this.bagMesh = new THREE.Mesh(this._bagGeo, this._bagMat);
    this.bagMesh.castShadow = true;
    this.bagMesh.receiveShadow = true;
    this.bagMesh.userData.sharedGeo = true;
    this.bagBody.add(this.bagMesh);
    // tape patches that appear as the bag weakens
    const tapeMat = this._mat(vinyl(0xd9dee8, { roughness: 0.6 }));
    this.tapes = [];
    const tapeSpots = [[0.35, 0.22, 0.5], [-0.6, -0.12, -0.6], [1.1, 0.05, 0.25], [-1.25, 0.3, -0.35], [2.3, -0.25, 0.7], [0.15, -0.32, 0.1]];
    for (const [a, y, rot] of tapeSpots) {
      // (outside the bag's 6 mm barrel bulge)
      const g = new THREE.CylinderGeometry(R.radius + 0.011, R.radius + 0.011, 0.06, 20, 1, true, a - 0.34, 0.68);
      const m = new THREE.Mesh(g, tapeMat);
      m.position.y = y;
      m.rotation.z = rot * 0.25;
      m.visible = false;
      this.bagBody.add(m);
      this.tapes.push(m);
    }
    // metal collar where the straps meet the bag: glows and rattles when the bag is about to drop
    this._collarMat = this._mat(new THREE.MeshStandardMaterial({ color: T.chain.color, metalness: 0.8, roughness: 0.3, emissive: new THREE.Color(PALETTE.uiAccent), emissiveIntensity: 0 }));
    this.collar = new THREE.Mesh(new THREE.TorusGeometry(R.radius * 0.82, 0.014, 8, 36), this._collarMat);
    this.collar.rotation.x = Math.PI / 2;
    this.collar.position.y = R.bagLen / 2 + 0.006;
    this.bagBody.add(this.collar);
    this._bagTier = 0;
    this._setBagTier(1);
    // strength gauge on the left upright: fills from the bottom, bag number on a badge above
    const M = T.meter;
    const meter = new THREE.Group();
    meter.position.set(-S.halfWidth, M.y0, z + 0.058);
    rig.add(meter);
    this.meter = meter;
    const round = (w, h, r) => {
      const sh = new THREE.Shape();
      sh.moveTo(-w / 2 + r, 0); sh.lineTo(w / 2 - r, 0); sh.quadraticCurveTo(w / 2, 0, w / 2, r);
      sh.lineTo(w / 2, h - r); sh.quadraticCurveTo(w / 2, h, w / 2 - r, h); sh.lineTo(-w / 2 + r, h);
      sh.quadraticCurveTo(-w / 2, h, -w / 2, h - r); sh.lineTo(-w / 2, r); sh.quadraticCurveTo(-w / 2, 0, -w / 2 + r, 0);
      return new THREE.ShapeGeometry(sh, 6);
    };
    const pad = 0.016;
    const frame = new THREE.Mesh(round(M.width + pad * 2 + 0.012, M.height + pad * 2 + 0.012, 0.03), this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiPaper })));
    frame.position.set(0, -pad - 0.006, 0);
    meter.add(frame);
    const back = new THREE.Mesh(round(M.width + pad * 2, M.height + pad * 2, 0.026), this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiInk })));
    back.position.set(0, -pad, 0.001);
    meter.add(back);
    this._meterFillMat = this._mat(new THREE.MeshBasicMaterial({ color: M.full }));
    this.meterFill = new THREE.Mesh(round(M.width, M.height, 0.02), this._meterFillMat);
    this.meterFill.position.z = 0.002;
    meter.add(this.meterFill);
    const tickMat = this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiInk, transparent: true, opacity: 0.55 }));
    for (const f of [0.25, 0.5, 0.75]) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(M.width, 0.008), tickMat);
      tick.position.set(0, M.height * f, 0.003);
      meter.add(tick);
    }
    const badge = new THREE.Mesh(new THREE.CircleGeometry(0.085, 32), this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiPaper })));
    badge.position.set(0, M.height + 0.11, 0.001);
    meter.add(badge);
    const badgeRing = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 32), this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiInk })));
    badgeRing.position.set(0, M.height + 0.11, 0.002);
    meter.add(badgeRing);
    this._meterLabelMat = this._mat(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, color: 0xffffff }));
    this.meterLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), this._meterLabelMat);
    this.meterLabel.position.set(0, M.height + 0.11, 0.004);
    meter.add(this.meterLabel);
    this._meterN = 0;
    // dropped bags
    this.fallenMeshes = [];
    for (let i = 0; i < BAG_TUNING.bags.maxFallen; i++) {
      const mat = this._mat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, clearcoat: 0.35, transparent: true, opacity: 1 }));
      const grp = new THREE.Group();
      const mesh = new THREE.Mesh(this._bagGeo, mat);
      mesh.userData.sharedGeo = true;
      mesh.castShadow = true;
      grp.add(mesh);
      // the broken chain end still attached
      for (let k = 0; k < 3; k++) {
        const l = new THREE.Mesh(linkGeo, swivelMat);
        l.userData.sharedGeo = true;
        l.position.y = R.bagLen / 2 + C.strapLen * 0.6 + k * C.pitch;
        l.rotation.y = k % 2 ? Math.PI / 2 : 0;
        grp.add(l);
      }
      grp.visible = false;
      grp.userData = { mat, tier: 0, landings: 0 };
      rig.add(grp);
      this.fallenMeshes.push(grp);
    }
    this._linkGeo = linkGeo;
    this._meterShown = 1;
    this._disposables.push(linkGeo, this._bagGeo);
    this._bagSpring = { squash: 0, squashV: 0, flash: 0, stubSwing: 0, stubV: 0 };
  }

  _bagTexture(tier) {
    const T = TRAINING_PROPS_TUNING.bagTiers;
    const i = Math.max(0, Math.min(T.length - 1, tier - 1));
    if (!(i in this._bagTex)) this._bagTex[i] = drawBagTexture(T[i], this._bagVSide, this._bagAspect);
    return { tex: this._bagTex[i], colors: T[i] };
  }

  _setBagTier(tier) {
    if (tier === this._bagTier) return;
    this._bagTier = tier;
    const { tex, colors } = this._bagTexture(tier);
    this._bagMat.map = tex;
    this._bagMat.color.set(tex ? 0xffffff : colors.leather);
    this._bagMat.needsUpdate = true;
  }

  _setMeterLabel(n) {
    if (n === this._meterN) return;
    this._meterN = n;
    this._meterLabelTex?.dispose();
    this._meterLabelTex = drawLabel(String(n), PALETTE.uiInk, false);
    this._meterLabelMat.map = this._meterLabelTex;
    this._meterLabelMat.visible = !!this._meterLabelTex;
    this._meterLabelMat.needsUpdate = true;
  }

  // ───────────── construction: balls ─────────────

  _buildBalls() {
    const B = TRAINING_PROPS_TUNING.ball;
    this.ballsGroup = new THREE.Group();
    this.ballsGroup.name = 'balls';
    this.object3d.add(this.ballsGroup);
    const geo = new THREE.SphereGeometry(B.radius, 28, 18);
    const mat = this._mat(new THREE.MeshPhysicalMaterial({
      color: this._tex.ball ? 0xffffff : B.color, map: this._tex.ball, roughness: 0.92, sheen: 1, sheenColor: new THREE.Color(0xf8ffc0), sheenRoughness: 0.5,
      emissive: new THREE.Color(B.color), emissiveIntensity: 0.16,
    }));
    const trailGeo = new THREE.SphereGeometry(B.radius * 0.8, 12, 8);
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    const ringGeo = new THREE.RingGeometry(0.12, 0.15, 48);
    this._disposables.push(geo, trailGeo, blobGeo, ringGeo);
    this.balls = [];
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.userData.sharedGeo = true;
      const trail = [];
      for (let k = 0; k < B.trail; k++) {
        const tm = this._mat(new THREE.MeshBasicMaterial({ color: B.color, transparent: true, opacity: 0, depthWrite: false }));
        const t = new THREE.Mesh(trailGeo, tm);
        t.userData.sharedGeo = true;
        t.renderOrder = 4;
        this.ballsGroup.add(t);
        trail.push(t);
      }
      const blobMat = this._mat(new THREE.MeshBasicMaterial({ map: this._tex.blob, color: this._tex.blob ? 0xffffff : 0x14182b, transparent: true, opacity: 0.6, depthWrite: false }));
      const blob = new THREE.Mesh(blobGeo, blobMat);
      blob.userData.sharedGeo = true;
      blob.renderOrder = 2;
      const ringMat = this._mat(new THREE.MeshBasicMaterial({ color: PALETTE.uiAccent, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.userData.sharedGeo = true;
      ring.renderOrder = 6;
      this.ballsGroup.add(mesh, blob, ring);
      this.balls.push({ mesh, trail, blob, ring, id: null, hist: [], spinAxis: new THREE.Vector3(1, 0, 0), last: new THREE.Vector3(), offset: new THREE.Vector3(), blend: 1, held: false });
    }
  }

  // ───────────── construction: trainer, mitts, player ghost ─────────────

  _buildTrainer() {
    this.trainer = null;
    this.mitts = null;
    if (!this._wantTrainer) return;
    try {
      this.trainer = new BoxerModel(null, { role: 'trainer', seed: 5 });
    } catch (e) {
      console.error('[training] could not build the trainer model', e);
      this.trainer = null;
      return;
    }
    this.object3d.add(this.trainer.object3d);
    this._trainerView = { phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, hitReact: null, expression: 'happy' };
    this._trainerPos = new THREE.Vector3(...TRAINING_PROPS_TUNING.bagCoach.pos);
    this._trainerYaw = 0;
    this._throwSeen = new Set();
    this._cheer = 0;
    this._lastBagsDone = 0;
    this._buildMitts();
  }

  _buildMitts() {
    const T = TRAINING_PROPS_TUNING.mitt;
    const padGeo = puckGeometry(T.radius, T.depth);
    const faceGeo = new THREE.CircleGeometry(T.radius * 0.8, 36);
    const ringGeo = new THREE.RingGeometry(T.radius * 0.42, T.radius * 0.6, 36);
    const dotGeo = new THREE.CircleGeometry(T.radius * 0.2, 24);
    const strapGeo = new RoundedBoxGeometry(T.radius * 1.3, T.radius * 0.5, 0.02, 2, 0.008);
    const glowGeo = new THREE.TorusGeometry(T.radius * 1.16, 0.016, 8, 48);
    const segGeo = new THREE.BoxGeometry(0.026, 0.016, 0.006);
    const burstGeo = new THREE.TorusGeometry(T.radius * 1.1, 0.008, 6, 40);
    this._disposables.push(padGeo, faceGeo, ringGeo, dotGeo, strapGeo, glowGeo, segGeo, burstGeo);
    this.mitts = {};
    for (const side of ['left', 'right']) {
      const hand = side === 'left' ? 'right' : 'left'; // your left mitt is the trainer's right hand
      const bodyMat = this._mat(leather(T.body));
      const faceMat = this._mat(vinyl(T.face, { roughness: 0.5 }));
      const ringMat = this._mat(vinyl(T.ring, { roughness: 0.45 }));
      for (const m of [faceMat, ringMat]) m.emissive = new THREE.Color(0x000000);
      const group = new THREE.Group();
      group.name = `mitt-${side}`;
      const inner = new THREE.Group();
      group.add(inner);
      const pad = new THREE.Mesh(padGeo, bodyMat);
      const face = new THREE.Mesh(faceGeo, faceMat); face.position.z = T.depth / 2 + 0.0015;
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.position.z = T.depth / 2 + 0.003;
      const dot = new THREE.Mesh(dotGeo, ringMat); dot.position.z = T.depth / 2 + 0.003;
      const strap = new THREE.Mesh(strapGeo, bodyMat); strap.position.z = -T.depth / 2 - 0.01;
      for (const o of [pad, face, ring, dot, strap]) { o.castShadow = true; o.userData.sharedGeo = true; inner.add(o); }
      const glowMat = this._mat(new THREE.MeshBasicMaterial({ color: T.glow, transparent: true, opacity: 0, depthWrite: false }));
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.z = T.depth / 2 + 0.006;
      glow.userData.sharedGeo = true;
      glow.renderOrder = 8;
      inner.add(glow);
      const segMat = this._mat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
      const SEG = 28;
      const segs = new THREE.InstancedMesh(segGeo, segMat, SEG);
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
      const rr = T.radius * 1.42;
      for (let i = 0; i < SEG; i++) {
        const a = Math.PI / 2 - (i / SEG) * TAU; // clockwise from 12 o'clock
        p.set(Math.cos(a) * rr, Math.sin(a) * rr, T.depth / 2 + 0.006);
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a + Math.PI / 2);
        segs.setMatrixAt(i, mtx.compose(p, q, sc));
      }
      segs.instanceMatrix.needsUpdate = true;
      segs.count = 0;
      segs.renderOrder = 9;
      segs.userData.sharedGeo = true;
      inner.add(segs);
      const burstMat = this._mat(new THREE.MeshBasicMaterial({ color: T.glow, transparent: true, opacity: 0, depthWrite: false }));
      const burst = new THREE.Mesh(burstGeo, burstMat);
      burst.position.z = T.depth / 2 + 0.01;
      burst.userData.sharedGeo = true;
      burst.renderOrder = 9;
      inner.add(burst);
      group.visible = false;
      const anchor = this.trainer.handAnchor(hand);
      anchor.add(group);
      this.mitts[side] = {
        side, hand, group, inner, anchor, faceMat, ringMat, bodyMat, glowMat, glow, segs, segMat, SEG, burst, burstMat,
        up: 0, pop: 0, popV: 0, lastHitAge: null, at: new THREE.Vector3((side === 'left' ? -1 : 1) * MITTS_TUNING.mitt.x, MITTS_TUNING.mitt.highY, MITTS_TUNING.mitt.faceZ),
      };
    }
  }

  _buildPlayerGhost() {
    this.player = null;
    if (!this._drawPlayer) return;
    try {
      this.player = new BoxerModel(null, { ghost: true, role: 'boxer' });
      this._playerApp = null;
      this.object3d.add(this.player.object3d);
    } catch (e) {
      console.error('[training] could not build the player ghost', e);
      this.player = null;
    }
  }

  _resetTransient() {
    const s = this._bagSpring;
    if (s) { s.squash = 0; s.squashV = 0; s.flash = 0; s.stubSwing = 0; s.stubV = 0; }
    for (const f of this.fallenMeshes || []) { f.visible = false; f.userData.landings = 0; }
    for (const b of this.balls || []) { b.id = null; b.hist.length = 0; b.mesh.visible = false; b.blob.visible = false; b.ring.visible = false; for (const t of b.trail) t.visible = false; }
    this._throwSeen?.clear();
    this._lastBagsDone = 0;
    this._cheer = 0;
    if (this.trainer) { this.trainer.setHandTarget('left', null); this.trainer.setHandTarget('right', null); this.trainer.setExpression(null); }
  }

  // ───────────── per frame: camera ─────────────

  _updateFocus(kind, dt) {
    const C = TRAINING_PROPS_TUNING.camera;
    const f = C[kind].focus;
    if (!this._focusReady) { this.focus.set(f[0], f[1], f[2]); this._focusReady = true; return; }
    const k = dt > 0 ? 1 - Math.exp(-C.lambda * dt) : 0;
    this.focus.x += (f[0] - this.focus.x) * k;
    this.focus.y += (f[1] - this.focus.y) * k;
    this.focus.z += (f[2] - this.focus.z) * k;
  }

  // ───────────── per frame: bag ─────────────

  _updateBag(view, dt) {
    const bag = view.bag;
    if (!bag) return;
    const R = BAG_TUNING.rig, C = TRAINING_PROPS_TUNING.chain, Tn = TRAINING_PROPS_TUNING;
    const sp = this._bagSpring;
    const present = bag.state === 'hanging' || bag.state === 'dropping';
    // pendulum
    this.bagPivot.rotation.set(bag.swing.ax, 0, bag.swing.az, 'XYZ');
    const drop = present ? bag.dropOffset : 0;
    const top = -(R.chainLen - drop); // bag top below the pivot
    this.hanger.position.y = top;
    this.hanger.visible = present;
    this.bagBody.rotation.y = bag.swing.yaw;
    if (present) this._setBagTier(bag.tier);
    // chain: links from the ring up to the pivot; after a snap only a short broken end swings
    const ringY = top + C.strapLen;
    let stub = 0;
    if (!present) {
      // a broken chain end swaying under the swivel
      if (this._wasPresent) { sp.stubV = 2.2 * (Math.random() < 0.5 ? -1 : 1); }
      sp.stubV += (-30 * sp.stubSwing - 2.5 * sp.stubV) * dt;
      sp.stubSwing += sp.stubV * dt;
      stub = 4;
    }
    this._wasPresent = present;
    let n = 0, topI = -1;
    for (let i = 0; i < this._nLinks; i++) {
      const y = present ? ringY + C.linkR * 0.8 + i * C.pitch : -(stub - i) * C.pitch;
      if (present ? y >= -0.01 : i >= stub) continue;
      const x = present ? 0 : Math.sin(sp.stubSwing) * (stub - i) * C.pitch * 0.9;
      _m4.compose(_v.set(x, y, 0), _qa.setFromAxisAngle(_Y, i % 2 ? Math.PI / 2 : 0), _one);
      this.chain.setMatrixAt(n++, _m4);
      topI = i;
      _w.set(x, y, 0);
    }
    this.chain.count = n;
    this.chain.instanceMatrix.needsUpdate = true;
    // strain: the top link glows and jitters when the bag is nearly done
    const danger = present && bag.state === 'hanging' ? clamp01((0.22 - bag.hp01) / 0.22) : 0;
    this.strainLink.visible = danger > 0 && topI >= 0;
    if (this.strainLink.visible) {
      this.strainLink.position.set(_w.x + Math.sin(this._time * 47) * 0.004 * danger, _w.y, 0);
      this.strainLink.rotation.set(0, topI % 2 ? Math.PI / 2 : 0, 0);
      this._strainMat.emissiveIntensity = danger * (0.6 + 0.4 * Math.sin(this._time * 22));
    }
    // … and the collar on the bag's top (always in view) glows and rattles too
    this._collarMat.emissiveIntensity = danger * (0.7 + 0.5 * Math.sin(this._time * 22));
    this.collar.position.x = Math.sin(this._time * 53) * 0.006 * danger;
    this.collar.rotation.z = Math.sin(this._time * 41) * 0.06 * danger;
    // hit squash + flash
    if (bag.hitFlash > sp.flash + 0.3) sp.squashV += 7;
    sp.flash = bag.hitFlash;
    sp.squashV += (-220 * sp.squash - 18 * sp.squashV) * dt;
    sp.squash += sp.squashV * dt;
    const sq = Math.max(-0.5, Math.min(0.5, sp.squash)) * Tn.hitSquash;
    this.bagMesh.scale.set(1 + sq, 1 - sq * 0.6, 1 + sq);
    this._bagMat.emissiveIntensity = 0.1 * bag.hitFlash * bag.hitFlash;
    // tape patches as it weakens
    const wear = present ? 1 - bag.hp01 : 0;
    this.tapes.forEach((m, i) => { m.visible = wear > 0.25 + i * 0.11; });
    // strength gauge (empties as the bag weakens; shows the next bag's number once it is coming)
    {
      const M = Tn.meter;
      const k = present ? clamp01(bag.hp01) * clamp01((bag.drop01 - 0.2) / 0.8) : 0;
      this._meterShown += (k - this._meterShown) * (dt > 0 ? 1 - Math.exp(-14 * dt) : 1);
      this.meterFill.scale.y = Math.max(0.0001, this._meterShown);
      this.meterFill.visible = this._meterShown > 0.004;
      const filling = bag.state === 'dropping' || bag.state === 'waiting';
      this._meterFillMat.color.setHex(filling || this._meterShown > 0.5 ? M.full : this._meterShown > 0.22 ? M.mid : M.low);
      this._setMeterLabel(bag.n);
    }
    // dropped bags
    const fallen = bag.fallen || [];
    this.fallenMeshes.forEach((g, i) => {
      const f = fallen[i];
      g.visible = !!f && f.alpha > 0.01;
      if (!g.visible) { g.userData.landings = 0; return; }
      g.position.set(f.x, f.y, f.z);
      g.rotation.set(f.tilt, f.roll, 0, 'XYZ');
      const mesh = g.children[0];
      const { tex, colors } = this._bagTexture(f.tier);
      if (g.userData.tier !== f.tier) {
        g.userData.tier = f.tier;
        g.userData.mat.map = tex;
        g.userData.mat.color.set(tex ? 0xffffff : colors.leather);
        g.userData.mat.needsUpdate = true;
      }
      g.userData.mat.opacity = f.alpha;
      g.userData.mat.depthWrite = f.alpha > 0.98;
      mesh.castShadow = f.alpha > 0.5;
      if (f.landings > g.userData.landings) {
        g.userData.landings = f.landings;
        try { this.renderer?.fx?.dust?.({ x: f.x, y: 0, z: f.z }, { size: f.landings > 1 ? 0.85 : 0.55 }); } catch { /* cosmetic */ }
        try { if (f.landings > 1) this.renderer?.fx?.shake?.(0.12, 'p1'); } catch { /* cosmetic */ }
      }
    });
    // the coach cheers when a bag goes down
    if ((view.bagsDone ?? 0) > this._lastBagsDone) { this._cheer = 1.4; }
    this._lastBagsDone = view.bagsDone ?? 0;
  }

  // ───────────── per frame: trainer ─────────────

  _updateTrainer(view, dt) {
    const tm = this.trainer;
    if (!tm) return;
    const kind = this.kind;
    const tv = view.trainer || null;
    const V = this._trainerView;
    // placement
    if (kind === 'bag') {
      const p = TRAINING_PROPS_TUNING.bagCoach.pos;
      this._trainerPos.set(p[0], p[1], p[2]);
      this._trainerYaw = Math.atan2(-0.3 - p[0], 0.15 - p[2]); // face between the bag and the player
    } else if (tv?.pos) {
      this._trainerPos.set(tv.pos[0], tv.pos[1], tv.pos[2]);
      this._trainerYaw = Number.isFinite(tv.yaw) ? tv.yaw : 0;
    }
    tm.object3d.position.copy(this._trainerPos);
    tm.object3d.rotation.set(0, this._trainerYaw, 0);
    // view for the rig
    V.phase = tv?.phase === 'hitstun' ? 'hitstun' : 'idle';
    V.phaseProgress = tv?.phaseProgress ?? 0;
    V.hitReact = tv?.hitReact ?? null;
    this._cheer = Math.max(0, this._cheer - dt);
    V.expression = this._cheer > 0 ? 'happy' : tv?.expression || 'happy';
    // look target
    if (kind === 'bag') {
      const b = view.bag;
      _v.set(0, 1.25, BAG_TUNING.rig.pivot[2] + (b ? -Math.sin(b.swing.ax) * 1.3 : 0));
      tm.setLookTarget(_v);
    } else if (tv?.lookAt) tm.setLookTarget(_v.set(tv.lookAt[0], tv.lookAt[1], tv.lookAt[2]));
    // hands
    if (kind === 'bag') this._coachHands(dt);
    else if (kind === 'dodge') this._throwHands(view, tv);
    tm.update(V, dt);
  }

  /** Hand target in the trainer's model space for a world point. */
  _toTrainerLocal(world, out) {
    out.copy(world).sub(this._trainerPos);
    out.applyAxisAngle(_Y, -this._trainerYaw);
    return out;
  }

  _coachHands() {
    const tm = this.trainer;
    if (this._cheer > 0) {
      const k = smooth(Math.min(1, (1.4 - this._cheer) / 0.25)) * smooth(this._cheer / 0.3);
      const bob = Math.sin(this._time * 14) * 0.05;
      for (const [hand, s] of [['left', 1], ['right', -1]]) {
        _v.set(s * lerp(0.3, 0.26, k), lerp(0.95, 1.78 + bob, k), lerp(0.1, 0.12, k));
        tm.setHandTarget(hand, _v);
      }
    } else {
      // relaxed: hands loosely together in front of the belt
      tm.setHandTarget('left', _v.set(0.08, 0.98, 0.2));
      tm.setHandTarget('right', _v.set(-0.08, 0.96, 0.2));
    }
  }

  _throwHands(view, tv) {
    const tm = this.trainer;
    const throwMs = DODGE_TUNING.throw.throwAnimMs;
    const rel = tv?.releases || [];
    const holding = tv?.holding || {};
    const used = { left: false, right: false };
    rel.forEach((r, i) => {
      const s = r.hand === 'left' ? 1 : -1; // model space: the trainer's left = +X
      const key = `${tv.throwId}:${r.ball}`;
      if (tv.action === 'walk') {
        // carrying the ball at the hip while stepping across
        tm.setHandTarget(r.hand, _v.set(s * 0.26, 1.02, 0.18));
        used[r.hand] = true;
      } else if (r.msToRelease > throwMs && holding[r.hand]) {
        // AIM: the ball cocked beside the head, ready — the readable tell (plus a glint)
        const k = smooth((tv.aim01 ?? 1) * 3);
        _v.set(s * lerp(0.26, 0.36, k), lerp(1.05, 1.36, k), lerp(0.18, -0.3, k));
        tm.setHandTarget(r.hand, _v);
        used[r.hand] = true;
        if ((tv.aim01 ?? 0) > 0.35 && !this._throwSeen.has('glint:' + key)) {
          this._throwSeen.add('glint:' + key);
          const a = tm.handAnchor(r.hand);
          a.updateWorldMatrix(true, false);
          try { this.renderer?.fx?.glint?.(a.getWorldPosition(_w), { color: 0xfff6d8, size: 1.1 }); } catch { /* cosmetic */ }
        }
      } else if (r.msToRelease <= throwMs && r.msToRelease > -350) {
        if (i === 0) {
          // the first ball: the rig's own throw gesture, timed so its release meets the logic's
          if (!this._throwSeen.has(key)) {
            this._throwSeen.add(key);
            tm.setHandTarget(r.hand, null);
            tm.trainerThrow(r.hand);
          }
          used[r.hand] = true;
        } else {
          // the second ball of a double: a quick push with the other hand
          const k = clamp01(1 - r.msToRelease / throwMs);
          const back = smooth(k / 0.6), fwd = smooth((k - 0.6) / 0.4);
          _v.set(s * lerp(0.36, 0.12, fwd), lerp(1.36, 1.25, fwd) + back * 0.04, lerp(-0.3, 0.5, fwd));
          tm.setHandTarget(r.hand, _v);
          used[r.hand] = true;
        }
      }
    });
    for (const hand of ['left', 'right']) {
      if (used[hand]) continue;
      if (tm.gestureActive) continue;
      const s = hand === 'left' ? 1 : -1;
      // ready stance: hands up in front, like a catcher
      tm.setHandTarget(hand, _v.set(s * 0.2, 1.12 + (view.trainer?.cheering ? 0.4 + Math.sin(this._time * 12) * 0.08 : 0), 0.24));
    }
    if (this._throwSeen.size > 40) this._throwSeen.clear();
  }

  // ───────────── per frame: mitts ─────────────

  /** Mitts, part 1 (before the trainer's rig update): where the trainer's hands go. */
  _mittTargets(view, dt) {
    if (!this.trainer || !this.mitts) return;
    const tm = this.trainer, T = TRAINING_PROPS_TUNING.mitt;
    const list = Array.isArray(view.mitts) ? view.mitts : [];
    for (const side of ['left', 'right']) {
      const M = this.mitts[side];
      const mv = list.find((m) => m.side === side) || null;
      M.view = mv;
      M.group.visible = true;
      const up = mv ? mv.up01 : 0;
      M.up += (up - M.up) * (dt > 0 ? 1 - Math.exp(-30 * dt) : 1);
      // pop when hit
      const hitAge = mv?.hitAge;
      if (hitAge != null && hitAge < 0.05 && (M.lastHitAge == null || hitAge < M.lastHitAge)) { M.popV += 9; }
      M.lastHitAge = hitAge;
      M.popV += (-260 * M.pop - 20 * M.popV) * dt;
      M.pop += M.popV * dt;
      // hand target: rest (low, by the hip) ↔ presented on the punch plane, pushed back on a hit
      // a claimed / just-hit mitt meets the glove where it really lands
      const tgt = mv?.catchPos || mv?.pos || MITTS_TUNING.mitt.rest;
      M.at.lerp(_w.set(tgt[0], tgt[1], tgt[2]), dt > 0 ? 1 - Math.exp(-(mv?.catchPos ? 26 : 12) * dt) : 1);
      const pos = [M.at.x, M.at.y, M.at.z];
      const rest = mv?.restPos || [(side === 'left' ? -1 : 1) * MITTS_TUNING.mitt.rest[0], MITTS_TUNING.mitt.rest[1], MITTS_TUNING.mitt.rest[2]];
      const k = smooth(M.up);
      _w.set(lerp(rest[0], pos[0], k), lerp(rest[1], pos[1], k), lerp(rest[2], pos[2], k) - (T.palmOffset + T.depth / 2) * k - Math.max(0, M.pop) * 0.5);
      tm.setHandTarget(M.hand, this._toTrainerLocal(_w, _v));
      M.k = k;
    }
  }

  /** Mitts, part 2 (after the trainer's rig update): pad orientation on the hand + target cues. */
  _updateMitts(view, dt) {
    if (!this.trainer || !this.mitts) return;
    const T = TRAINING_PROPS_TUNING.mitt;
    void view; void dt;
    for (const side of ['left', 'right']) {
      const M = this.mitts[side];
      const mv = M.view;
      const k = M.k ?? 0;
      const hitAge = mv?.hitAge;
      // face orientation (world): presented → facing the player (+Z) tilted a touch inward;
      // resting → face down
      const inward = side === 'left' ? 0.18 : -0.18;
      _e.set(lerp(Math.PI / 2 - 0.15, -0.06, k), inward * k, 0, 'XYZ');
      _qw.setFromEuler(_e);
      M.anchor.updateWorldMatrix(true, false);
      M.anchor.getWorldQuaternion(_qa).invert();
      M.group.quaternion.copy(_qa).multiply(_qw);
      // pad sits in front of the palm
      _v.set(0, 0, T.palmOffset).applyQuaternion(_qw).applyQuaternion(_qa);
      M.group.position.copy(_v);
      const s = 1 + Math.max(-0.2, Math.min(0.4, M.pop)) * 0.6;
      M.inner.scale.setScalar(s);
      // target cues
      const live = !!mv?.live;
      const pulse = 0.5 + 0.5 * Math.sin(this._time * 9);
      M.glowMat.opacity = live ? 0.55 + 0.4 * pulse : 0;
      M.glow.scale.setScalar(live ? 1 + 0.06 * pulse : 1);
      M.faceMat.emissive.setHex(PALETTE.post).multiplyScalar(live ? 0.12 + 0.1 * pulse : 0);
      M.ringMat.emissive.setHex(PALETTE.uiAccent).multiplyScalar(live ? 0.25 : 0);
      const left = live ? clamp01(mv.timeLeft01) : 0;
      M.segs.count = live ? Math.ceil(left * M.SEG) : 0;
      M.segMat.color.setHex(left > 0.35 ? PALETTE.post : PALETTE.uiAccent);
      // hit burst ring
      if (hitAge != null && hitAge < 0.4) {
        const b = hitAge / 0.4;
        M.burst.scale.setScalar(1 + b * 1.4);
        M.burstMat.opacity = (1 - b) * 0.9;
      } else M.burstMat.opacity = 0;
      // resting mitts read as "not a target"
      M.bodyMat.color.setHex(T.body).multiplyScalar(lerp(0.75, 1, k));
    }
  }

  // ───────────── per frame: balls ─────────────

  _updateBalls(view, dt) {
    const list = Array.isArray(view.balls) ? view.balls : [];
    const head = headWorld(view.playerView?.lean || { x: 0, y: 0 }, [0, 0, 0]);
    const B = TRAINING_PROPS_TUNING.ball;
    const used = new Set();
    // keep slots stable per ball id
    for (const b of list) {
      let slot = this.balls.find((s) => s.id === b.id);
      if (!slot) slot = this.balls.find((s) => s.id == null && !used.has(s));
      if (!slot) continue;
      used.add(slot);
      if (slot.id !== b.id) { slot.id = b.id; slot.hist.length = 0; slot.blend = 1; slot.held = false; slot.state = null; }
      this._drawBall(slot, b, head, view, dt);
    }
    for (const s of this.balls) {
      if (used.has(s)) continue;
      s.id = null;
      s.mesh.visible = false; s.blob.visible = false; s.ring.visible = false;
      for (const t of s.trail) t.visible = false;
    }
    void B;
  }

  _drawBall(slot, b, head, view, dt) {
    const B = TRAINING_PROPS_TUNING.ball;
    const m = slot.mesh;
    m.visible = true;
    if (b.state === 'hit' && slot.state !== 'hit' && slot.state != null) {
      // you got hit: the warm flash + jolt the match uses for a punch taken
      try {
        this.renderer?.fx?.screenFlash?.(0.16, PALETTE.p2Accent, 'p1');
        this.renderer?.fx?.shake?.(0.22, 'p1');
      } catch { /* cosmetic */ }
    }
    slot.state = b.state;
    if (b.state === 'held' || !b.pos) {
      // in the trainer's hand
      const a = this.trainer?.handAnchor(b.hand);
      if (a) { a.updateWorldMatrix(true, false); a.getWorldPosition(_w); _v.set(0, 0, 0.05).applyQuaternion(a.getWorldQuaternion(_qa)); _w.add(_v); } else _w.set(0, 1.5, -2);
      m.position.copy(_w);
      slot.last.copy(_w);
      slot.blend = 0;
      slot.held = true;
      // the ready ball glows a little (the tell)
      m.scale.setScalar(1 + 0.08 * Math.sin(this._time * 10));
      slot.blob.visible = false; slot.ring.visible = false;
      for (const t of slot.trail) t.visible = false;
      return;
    }
    _w.set(b.pos[0], b.pos[1], b.pos[2]);
    // first frames after release: blend from where the hand really let go
    if (slot.held) { slot.held = false; slot.offset.subVectors(slot.last, _w); slot.blend = 0; }
    if (slot.blend < 1) {
      slot.blend = Math.min(1, slot.blend + dt / 0.1);
      _w.addScaledVector(slot.offset, 1 - smooth(slot.blend));
    }
    // a dodged ball visibly misses: keep it outside the (moving) head
    if (b.state === 'dodged' && Math.abs(_w.z - head[2]) < 0.5) {
      _v.set(_w.x - head[0], _w.y - head[1], 0);
      const min = TRAINING_LAYOUT.headRadius + B.radius + 0.03;
      const d = _v.length();
      const near = 1 - Math.abs(_w.z - head[2]) / 0.5;
      if (d < min && d > 1e-4) _w.add(_v.multiplyScalar(((min - d) / d) * smooth(near)));
      else if (d <= 1e-4) _w.x += min * smooth(near);
    }
    // spin about an axis perpendicular to the motion
    _v.subVectors(_w, slot.last);
    const dist = _v.length();
    if (dist > 1e-5 && dt > 0) {
      slot.spinAxis.set(_v.z, 0, -_v.x).normalize();
      if (slot.spinAxis.lengthSq() < 0.5) slot.spinAxis.set(1, 0, 0);
      m.rotateOnWorldAxis(slot.spinAxis, dist / B.radius);
    }
    slot.last.copy(_w);
    m.position.copy(_w);
    // squash against the face while it is judged
    if (b.state === 'contact') m.scale.set(1.12, 1.12, 0.72); else m.scale.setScalar(1);
    // trail
    const keep = slot.trail.length * 2 + 1;
    const hv = slot.hist.length >= keep ? slot.hist.pop() : new THREE.Vector3(); // reuse vectors (no per-frame garbage)
    slot.hist.unshift(hv.copy(_w));
    const flying = b.state === 'flying' || b.state === 'dodged';
    slot.trail.forEach((t, i) => {
      const p = slot.hist[(i + 1) * 2];
      t.visible = flying && !!p;
      if (!t.visible) return;
      t.position.copy(p);
      t.scale.setScalar(1 - (i + 1) / (slot.trail.length + 1) * 0.6);
      t.material.opacity = 0.28 * (1 - i / slot.trail.length);
    });
    // blob shadow on the canvas
    slot.blob.visible = true;
    const hgt = Math.max(0, _w.y);
    slot.blob.position.set(_w.x, 0.006, _w.z);
    slot.blob.scale.setScalar(0.16 + hgt * 0.09);
    slot.blob.material.opacity = 0.62 * (1 - clamp01(hgt / 2.6) * 0.75);
    // where it will cross your head plane: a ring that tightens as the ball comes in
    const ring = slot.ring;
    if (b.state === 'flying' && b.target && b.msToArrive > -40) {
      ring.visible = true;
      const k = clamp01(b.flight01);
      ring.position.set(b.target[0], b.target[1], b.target[2] - 0.2);
      ring.scale.setScalar(lerp(2.2, 1.0, smooth(k)));
      ring.material.opacity = 0.25 + 0.6 * smooth(k);
      ring.material.color.setHex(k > 0.72 ? PALETTE.uiAccent : PALETTE.post);
    } else ring.visible = false;
    void view;
  }

  // ───────────── per frame: the player's own ghost (no GameRenderer) ─────────────

  _updatePlayer(view, dt) {
    const pm = this.player;
    if (!pm) return;
    const pv = view.playerView;
    if (!pv) { pm.object3d.visible = false; return; }
    pm.object3d.visible = true;
    const app = pv.appearance || null;
    if (app && app !== this._playerApp) {
      this._playerApp = app;
      try {
        const next = new BoxerModel(app, { ghost: true, role: 'boxer' });
        pm.dispose();
        this.player = next;
        this.object3d.add(next.object3d);
      } catch (e) { console.error('[training] could not rebuild the player ghost', e); }
    }
    const p = this.player;
    const P = LAYOUT.p1Pos;
    p.object3d.position.set(P[0] + (pv.lean?.x || 0) * 0.1, P[1], P[2]);
    p.object3d.rotation.set(0, Math.PI, 0);
    p.update(pv, dt);
  }
}

// scratch
const _m4 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _e = new THREE.Euler();
