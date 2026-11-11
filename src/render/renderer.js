// GameRenderer: the one Three.js renderer for menus, matches and training (owner: view3d).
//
// Owns the WebGLRenderer, one THREE.Scene (arena + boxers + training props + FX + screen
// overlays + the 3D health meters), one CameraRig per player and the viewport layout (UI01:
// single view behind the player; local versus = two scissored viewports side by side, each
// ghosting its own boxer and cutting for its own player).
//
// Presentation follows research/mechanics.md §5–§6 and ARCHITECTURE.md §6.2–§6.7:
//   * no referee is drawn — the count is numbers (HUD) + voice (audio);
//   * live: behind/above the player, body ~50 % transparent, gloves solid; the venue turns slowly
//     (arena.setYaw) like fighters circling; the lean slides the view (level, R8); the viewer's own
//     gloves and see-through head fade while they overlap the opponent's face (own-fade.js, R8);
//   * cameras keyed on view.phase / view.stage / view.stageTime (camera-rig.js); every hard cut is
//     announced as Ev.RENDER_CUT {kind, viewer, durationMs};
//   * hit-stop tiers from MATCH_HIT (fx.hitStopMsFor) through `timeScale`;
//   * the hit vocabulary (pink pop, green ring, orange lines + cut + blue/white burst, purple for
//     heavy, red/blue trails) — no 3D hit text;
//   * dodge slow motion: smear + tint, slowed crowd and particles, the red miss streak lingering;
//   * on-hit health meters (meter.js);
//   * the bout outro: playOutro({result, view}) → Promise (replay.js plans it).
//
// Time contract: pass the UNSCALED frame dt to renderMatch/renderTraining/renderMenu. The renderer
// measures real time itself and exposes `timeScale` (= fx.timeScale); the app multiplies its GAME dt
// by it (≈0.02 during a hit-stop, so the round clock stalls for exactly the measured time). The AI
// boxer's animation runs on scaled time (it freezes on impact); a human boxer's model keeps real
// time so the player's gloves follow their hands (only the boxer struck by the impact freezes).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Ev, MatchPhase, BoxerPhase, ResultMethod } from '../core/types.js';
import { LAYOUT, VENUE_LIGHTING as LIGHTING, PALETTE } from './style.js';
import { buildArena, ARENA_TUNING } from './arena.js';
import { CameraRig, Shot, RIG_TUNING } from './camera-rig.js';
import { FX, readVec3, hitStopMsFor } from './fx.js';
import { HealthMeters } from './meter.js';
import { ScreenFX } from './screen-fx.js';
import { ViewRecorder, planOutro, lerpSnap, makeSnap, makeViewOut, snapToView } from './replay.js';
import { AdaptiveQuality, ADAPTIVE_TUNING } from './adaptive.js';
import { OwnFade } from './own-fade.js';

// Sibling render modules resolved at build time. `import.meta.glob` (eager) is a static import when
// the file exists and an empty object when it does not; in Node (unit tests) it is unavailable.
let OPTIONAL = {};
try {
  OPTIONAL = import.meta.glob(['./boxer-model.js', './training-props.js', './appearance.js'], { eager: true });
} catch {
  OPTIONAL = {};
}

/** What was found next to this module (debug / dev pages). */
export const RENDER_MODULES = Object.freeze({
  BoxerModel: OPTIONAL['./boxer-model.js']?.BoxerModel ?? null,
  gloveWorldPosition: OPTIONAL['./boxer-model.js']?.gloveWorldPosition ?? null,
  headWorldPosition: OPTIONAL['./boxer-model.js']?.headWorldPosition ?? null,
  bodyWorldPosition: OPTIONAL['./boxer-model.js']?.bodyWorldPosition ?? null,
  TrainingScene: OPTIONAL['./training-props.js']?.TrainingScene ?? null,
  appearance: OPTIONAL['./appearance.js'] ?? null,
});

/** Presentation knobs (event → effect mapping, staging, quality). */
export const RENDER_TUNING = Object.freeze({
  pixelRatioMax: 2,
  // quality 'auto': render/adaptive.js (windows, hysteresis, step back up; detection time excluded)
  adaptive: ADAPTIVE_TUNING,
  shadowMapHigh: ARENA_TUNING.key.shadowMap, shadowMapLow: 1024,
  modelForwardYaw: 0,     // added to every boxer yaw; BoxerModel faces local +Z
  leanRootShift: 0.1,     // m of sidestep per unit lean.x on top of the model's own torso lean
  leanFwdShift: 0.07,     // m per unit lean.z
  leanLambda: 20,         // 1/s — root follows the player's lean almost immediately
  // VIEW3D-LOST-FRAME: a human view from an untracked frame (BoxerView.tracked false — the recognizer lost a wrist, the
  // shoulders or the head for a moment) shows the stance pose, which made the stiff own gloves (R11) twitch there and back
  // and slid the live camera. Within this many ms of the last tracked frame the view keeps that frame's hands, guard and
  // lean instead (display only; combat already used its own state); a longer loss shows the stance pose as before.
  lostHoldMs: 250,
  walkSpeed: 1.6,         // m/s for retreat / return moves
  turnSpeed: 4.5,         // rad/s
  // while one boxer is down: the opponent walks to the far side and waits (§3.1); the player stays
  kd: Object.freeze({ aiFar: 1.3, humanStay: 0.12, versusFar: 1.05 }),
  // the slow orbit: a far corner post crosses the frame in ~20 s (§6, measured on the live camera) → 0.056 rad/s of venue yaw
  orbit: Object.freeze({ radPerSec: 0.056 }),
  excitement: Object.freeze({
    base: Object.freeze({
      intro: 0.6, roundStart: 0.55, fighting: 0.32, knockdown: 0.92, recovery: 0.6, roundEnd: 0.45,
      between: 0.35, decision: 0.6, result: 0.95, paused: 0.2,
    }),
    hit: 0.05, hitPower: 0.1, counter: 0.18, dodge: 0.04, knockdown: 0.6, boostDecay: 0.45, lambda: 1.8,
  }),
  crowd: Object.freeze({ hit: 0.28, counter: 0.6, knockdown: 1, count: 0.25, getup: 0.75, koRoar: 3.2 }),
  shake: Object.freeze({ hitTaken: 0.2, hitTakenPower: 0.25, counterBonus: 0.12, hitLanded: 0.06, block: 0.06, knockdown: 0.45 }),
  sweatPower: 0.6,
  dustDelayGame: 0.42,    // game seconds after a knockdown before the body meets the canvas
  glintAt: 0.45,          // AI windup glint appears this far into the windup (glove cocked)
  glintSize: 1.25,
  knockdownHitScale: 1.35,
  // trails: the opponent's power punch / hook (red) and the player's fast punch (blue)
  trail: Object.freeze({ humanFast: 0.7, aiPower: 0.9, missLinger: 0.75, hitLinger: 0.25 }),
  // player-hit cut on the knockdown blow: held through the fall until the low "player down" shot
  cut: Object.freeze({ knockdownBlowMs: 1600 }),
  // the round-change / intro cut to the arena dips through the hall colour
  dip: Object.freeze({ alpha: 0.9, decayPerSec: 2.2 }),
  // own meter anchor in the player's frame: [right, up, forward] m — projects through the live
  // camera to (28.5 %, 61 %), the reference's player pie at left-centre (§5: 25–32 % across,
  // 58–65 % down); the meter follows it within ±6 % as the view leans
  meterAnchor: Object.freeze([-0.65, 0.86, 0.32]),
  slowmo: Object.freeze({ fadeIn: 0.08, fadeOut: 0.2, scale: 0.25, ms: 750 }),
  splitGapPx: 4,
  dividerColor: 0xfffaf0,
  // the outro's staging
  outro: Object.freeze({
    winnerPos: [0, 0, 0.25], loserPos: [0.95, 0, -0.95], drawGap: 0.42,
    // low, looking up at the winner's chest: the face lands at ~22 % height, above the HUD's win
    // banner text (28–48 %), the band across the chest as in the reference (VISUAL-04; was look y 1.18)
    bannerCam: Object.freeze({ pos: [0.16, 0.74, 1.62], look: [0, 0.92, 0], fov: 46, push: 0.3 }),
    winnerCam: Object.freeze({ pos: [0.34, 1.02, 2.8], look: [0.28, 0.98, -0.35], fov: 40, drift: 0.18 }),
    watchdogMs: 1500,
  }),
  // the KO replay's 'low' angle (the segment holding the blow): metres along the punch direction
  // behind the loser, sideways off the punch line (− = left of it; +slide·k drifts back), height,
  // aim point between attacker (0) and loser (1), look height, fov
  replayLow: Object.freeze({ back: 0.9, side: -1.25, slide: 0.15, height: 0.75, aim: 0.75, lookY: 1.12, fov: 50 }),
});

const DEFAULT_APPEARANCE = {
  p1: { skin: '#eec1a0', hair: { style: 'crew', color: '#4a2f22' }, eyes: 'oval', brows: 'flat', mouth: 'smile', nose: 'button', accessory: 'none', top: 'none', trunks: '#3d7bff', trim: '#ffd166', gloves: '#3d7bff', shoes: '#14182b', build: 'average', height: 1 },
  p2: { skin: '#b97a52', hair: { style: 'spiky', color: '#1d1a19' }, eyes: 'fierce', brows: 'angry', mouth: 'grin', nose: 'round', accessory: 'headband', top: 'none', trunks: '#ff4d5e', trim: '#f7f3ea', gloves: '#ff4d5e', shoes: '#14182b', build: 'average', height: 1 },
};

const IDS = ['p1', 'p2'];
const HANDS = ['left', 'right'];
const BASE = { p1: new THREE.Vector3(...LAYOUT.p1Pos), p2: new THREE.Vector3(...LAYOUT.p2Pos) };
const BASE_YAW = { p1: Math.PI, p2: 0 }; // facing −Z / +Z (yaw maps local +Z to (sin, 0, cos))
const TRAIL_KEY = { p1: { left: 'p1:left', right: 'p1:right' }, p2: { left: 'p2:left', right: 'p2:right' } };
const INTRO_PHASES = new Set([MatchPhase.INTRO, MatchPhase.ROUND_START, MatchPhase.BETWEEN]);
const LIVE_PHASES = new Set([MatchPhase.FIGHTING, MatchPhase.KNOCKDOWN, MatchPhase.RECOVERY, MatchPhase.ROUND_END]);
const other = (id) => (id === 'p1' ? 'p2' : 'p1');
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const UP = new THREE.Vector3(0, 1, 0);

// scratch (no per-frame allocations)
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _shake = { x: 0, y: 0, roll: 0 };
const _shake2 = { x: 0, y: 0, roll: 0 };
const _sample = { a: null, b: null, t: 0 };
const _anchors = { foeHead: null, ownAnchor: null };

function facingOf(yaw, out) { return out.set(Math.sin(yaw), 0, Math.cos(yaw)); }
/** A slot's own-part fade for debugState (rounded). */
function fadeOf(slot) { const v = slot.ownFade.value; return { left: +v.left.toFixed(2), right: +v.right.toFixed(2), head: +v.head.toFixed(2) }; }
function rightOf(yaw, out) { return out.set(-Math.cos(yaw), 0, Math.sin(yaw)); }
function approachAngle(a, b, maxStep) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) <= maxStep ? b : a + Math.sign(d) * maxStep;
}
function moveToward(cur, target, maxStep) {
  const d = _v3.subVectors(target, cur);
  const len = d.length();
  if (len <= maxStep || len < 1e-6) cur.copy(target);
  else cur.addScaledVector(d, maxStep / len);
}

function makeSlot() {
  return {
    model: null, key: null, appRef: undefined, failedKey: null, ghost: null, view: null, human: null,
    anchor: new THREE.Vector3(), leanOff: new THREE.Vector3(), pos: new THREE.Vector3(), yaw: 0, placed: false,
    head: new THREE.Vector3(), body: new THREE.Vector3(), meterAnchor: new THREE.Vector3(),
    trail: { left: { on: false, id: null }, right: { on: false, id: null } }, pendingRise: false,
    ownFade: new OwnFade(),
    held: { at: -Infinity, hands: null, guard: 'none', guardAmount: 0, lean: null, phase: null },
  };
}

/** Phases in which a human's hands and lean come straight from tracking (no punch, hit or fall drawn over them). */
const HOLD_PHASES = new Set([BoxerPhase.IDLE, BoxerPhase.GUARD, BoxerPhase.DODGE]);

/**
 * VIEW3D-LOST-FRAME (RENDER_TUNING.lostHoldMs): a human BoxerView from an untracked frame, within holdMs of the last tracked
 * one, keeps that one's hands, guard, lean and the phase they made (idle / guard / dodge), with `held: true`; every other
 * view passes through unchanged and a tracked human view is remembered in `mem`. Pure; the renderer keeps one `mem` per
 * boxer slot.
 * @param {Object|null} bv  BoxerView
 * @param {{at:number, hands:Object|null, guard:string, guardAmount:number, lean:Object|null, phase:string|null}} mem
 * @param {number} nowMs
 * @param {number} [holdMs]
 */
export function holdLostView(bv, mem, nowMs, holdMs = RENDER_TUNING.lostHoldMs) {
  if (!bv || !bv.isHuman || !mem) return bv;
  if (bv.tracked !== false) {
    if (bv.hands && HOLD_PHASES.has(bv.phase)) {
      mem.at = nowMs; mem.hands = bv.hands; mem.guard = bv.guard; mem.guardAmount = bv.guardAmount; mem.lean = bv.lean; mem.phase = bv.phase;
    } else mem.hands = null; // a punch, a hit or a fall: nothing to hold over the next dropout
    return bv;
  }
  if (!mem.hands || !(nowMs - mem.at <= holdMs) || !HOLD_PHASES.has(bv.phase)) return bv;
  return { ...bv, phase: mem.phase || bv.phase, hands: mem.hands, guard: mem.guard, guardAmount: mem.guardAmount, lean: mem.lean, held: true };
}

/** A synthetic BoxerView for staged moments (outro banner / winner). */
function makeStagedView() {
  return {
    id: 'p1', isHuman: false, appearance: null, phase: BoxerPhase.IDLE, phaseProgress: 0, guard: 'none',
    lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, punches: null, windup: null, hitReact: null,
    taunting: false, expression: 'neutral', hp01: 1, hp: 10,
  };
}

export class GameRenderer {
  /**
   * @param {{canvas: HTMLCanvasElement, bus?: import('../core/events.js').EventBus,
   *          quality?: 'auto'|'high'|'low', BoxerModel?: Function, TrainingScene?: Function,
   *          gloveWorldPosition?: Function, clock?: () => number, reducedMotion?: boolean, fast?: boolean}} opts
   *   BoxerModel / TrainingScene / gloveWorldPosition override the sibling modules (dev pages, tests).
   *   clock: ms timestamp source (defaults to performance.now) — dev pages drive a virtual clock.
   *   fast: ?fast=1 — the bout outro takes ≤ 1.5 s (also read from the page URL when not given).
   * @throws {Error} with a readable message when WebGL is unavailable.
   */
  constructor({ canvas, bus = null, quality = 'auto', BoxerModel = null, TrainingScene = null, gloveWorldPosition = null,
    headWorldPosition = null, bodyWorldPosition = null, clock = null, reducedMotion = false, fast = null } = {}) {
    if (!canvas) throw new Error('GameRenderer needs a <canvas>.');
    this.canvas = canvas;
    this.bus = bus;
    this._quality = quality;
    this._fast = fast;
    this._BoxerModel = BoxerModel ?? RENDER_MODULES.BoxerModel;
    this._TrainingScene = TrainingScene ?? RENDER_MODULES.TrainingScene;
    // when a BoxerModel is injected, only use helpers injected alongside it (they read its internals)
    const injected = !!BoxerModel;
    this._gloveWorldPosition = gloveWorldPosition ?? (injected ? null : RENDER_MODULES.gloveWorldPosition);
    this._headWorldPosition = headWorldPosition ?? (injected ? null : RENDER_MODULES.headWorldPosition);
    this._bodyWorldPosition = bodyWorldPosition ?? (injected ? null : RENDER_MODULES.bodyWorldPosition);
    this._clock = clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    if (!this._BoxerModel) console.warn('[render] BoxerModel not available — boxers will not be drawn.');

    // ── WebGL ──
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    } catch (e) {
      throw new Error(`This game needs WebGL to draw the ring, but it could not start (${e?.message || e}). Try enabling hardware acceleration or another browser.`);
    }
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = LIGHTING.exposure;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap was folded into PCF (soft via shadow.radius)
    r.setClearColor(LIGHTING.hallTop, 1);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this._pixelRatio = Math.min(RENDER_TUNING.pixelRatioMax, dpr, quality === 'low' ? 1 : 2);
    r.setPixelRatio(this._pixelRatio);
    this._adaptive = new AdaptiveQuality({ maxRatio: this._pixelRatio, enabled: quality === 'auto' });

    // ── scene ──
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(LIGHTING.fogColor, LIGHTING.fogNear, LIGHTING.fogFar);
    this.arena = buildArena({ quality: quality === 'low' ? 'low' : 'high' });
    this.scene.add(this.arena.group);
    if (quality === 'low') this.arena.setShadowMapSize(1024);
    this.arena.setAnisotropy(Math.min(8, r.capabilities.getMaxAnisotropy?.() || 1));
    try {
      const pmrem = new THREE.PMREMGenerator(r);
      const room = new RoomEnvironment();
      this._envTex = pmrem.fromScene(room, 0.04).texture;
      room.dispose?.();
      pmrem.dispose();
      this.scene.environment = this._envTex;
      this.scene.environmentIntensity = ARENA_TUNING.envIntensity;
    } catch (e) {
      this._envTex = null; // purely cosmetic (glossy highlights) — keep going without it
    }

    this._boxerGroup = new THREE.Group(); this._boxerGroup.name = 'boxers';
    this._trainGroup = new THREE.Group(); this._trainGroup.name = 'training';
    this.scene.add(this._boxerGroup, this._trainGroup);
    this._boxerGroup.visible = false;
    this._trainGroup.visible = false;

    this.fx = new FX();
    this.scene.add(this.fx.object3d);
    const gl = r.getContext();
    const ps = gl?.getParameter?.(gl.ALIASED_POINT_SIZE_RANGE);
    if (ps && ps[1] > 0) {
      for (const sys of [this.fx.sparks, this.fx.drops]) sys.uniforms.uMaxSize.value = Math.min(sys.uniforms.uMaxSize.value, ps[1]);
    }
    this.screen = new ScreenFX();
    this.scene.add(this.screen.object3d);
    this.meters = new HealthMeters();
    this.scene.add(this.meters.object3d);
    this._recorder = new ViewRecorder();

    // ── cameras ──
    this._rigs = [new CameraRig({ side: 'p1' }), null];
    this._split = 1;
    this._scene = 'menu';
    this._ctx = {
      mode: 'menu', phase: null, phaseTime: 0, stage: null, stageTime: 0, versus: false, downed: null, koLoser: null, winner: null,
      pos: { p1: new THREE.Vector3(), p2: new THREE.Vector3() }, yaw: { p1: Math.PI, p2: 0 },
      lean: { p1: null, p2: null }, head: { p1: new THREE.Vector3(), p2: new THREE.Vector3() },
      body: { p1: new THREE.Vector3(), p2: new THREE.Vector3() }, focus: null, shake: _shake,
    };

    // ── boxers ──
    this._slots = { p1: makeSlot(), p2: makeSlot(), trainee: makeSlot() };
    this._staged = { p1: makeStagedView(), p2: makeStagedView() };
    this._replaySnap = { p1: makeSnap(), p2: makeSnap() };
    this._replayView = { p1: makeViewOut(), p2: makeViewOut() };
    this._outro = null;
    this._orbit = 0;
    this._slow = { on: false, dodger: null, attacker: null, scale: 1, left: 0, strength: 0 };
    this._cutCount = 0;
    this._resetMatchState();

    // ── training ──
    this._training = null;
    this._trainKind = null;
    this._trainFocus = new THREE.Vector3(BASE.p2.x, 1.1, BASE.p2.z);

    // ── bookkeeping ──
    this._lastNow = null;
    this._w = 0; this._h = 0;
    this._lost = false;
    this._delayed = Array.from({ length: 6 }, () => ({ active: false, t: 0, x: 0, z: 0, size: 1, kind: null, who: null, hand: null }));

    this._onLost = (e) => { e.preventDefault(); this._lost = true; console.warn('[render] WebGL context lost — waiting for the browser to restore it.'); };
    this._onRestored = () => { this._lost = false; this.arena.refreshText(); this._lastNow = null; };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._offs = [];
    if (bus) this._subscribe(bus);
    this.setReducedMotion(reducedMotion);
    this.resize();
  }

  /** Settings → reducedMotion (also picked up from Ev.SETTINGS_CHANGED): calmer shake, flashes and camera sway. */
  setReducedMotion(on) {
    this._reducedMotion = !!on;
    this.fx.setReducedMotion(this._reducedMotion);
    for (const rig of this._rigs) if (rig) rig.reducedMotion = this._reducedMotion;
  }

  /** ?fast=1: short outros (tests). */
  setFast(on) { this._fast = !!on; }

  // ───────────────────────────── public API ─────────────────────────────

  /** 'menu' | 'match' | 'training' */
  setScene(name) {
    const n = name === 'match' || name === 'training' ? name : 'menu';
    if (n === this._scene) return;
    this._scene = n;
    this._boxerGroup.visible = n === 'match';
    this._trainGroup.visible = n === 'training';
    for (const rig of this._rigs) rig?.cut();
    this.fx.clear();
    this.screen.clear();
    this._resetMatchState();
  }

  /** 1 = single view, 2 = versus split screen (P1 left, P2 right). */
  setSplit(n) {
    const s = n === 2 ? 2 : 1;
    if (s === this._split) return;
    this._split = s;
    if (s === 2 && !this._rigs[1]) {
      this._rigs[1] = new CameraRig({ side: 'p2' });
      this._rigs[1].reducedMotion = !!this._reducedMotion;
    }
    for (const rig of this._rigs) rig?.cut();
    this.resize();
  }

  /** Game-dt multiplier (hit-stop). */
  get timeScale() { return this.fx.timeScale; }

  /** True while the bout outro runs (playOutro). */
  get outroActive() { return !!this._outro && !this._outro.done; }

  /** {scene, renderer, camera, cameras, arena, fx, rigs, meters, screen} for debugging. */
  get three() {
    return {
      scene: this.scene, renderer: this.renderer, camera: this._rigs[0].camera,
      cameras: this._rigs.filter(Boolean).map((rig) => rig.camera), arena: this.arena, fx: this.fx, rigs: this._rigs,
      meters: this.meters, screen: this.screen,
    };
  }

  /** The THREE.WebGLRenderer (TrainingScene and tools may need it). */
  get webgl() { return this.renderer; }

  get contextLost() { return this._lost; }

  /**
   * The adaptive render quality (render/adaptive.js AdaptiveQuality, PERF-03 / PERF-06). The app hands it the input hub's
   * detection pressure every frame (setDetectionPressure), reads `frameDivisor` (render every Nth display frame) and
   * tells the hub whether the quality is at its floor (`atFloor`; `enabled` false = a fixed 'high' / 'low' quality).
   */
  get adaptive() { return this._adaptive; }

  /** Small debug snapshot (tests, dev pages, `?debug=1` overlays). */
  debugState() {
    const m = (id) => { const s = this.meters.state[id]; return { visible: s.visible, value: +s.value.toFixed(2), dark: +s.dark.toFixed(2), alpha: +s.alpha.toFixed(2) }; };
    const o = this._outro;
    return {
      scene: this._scene, split: this._split, shot: this._rigs[0].shot, shot2: this._rigs[1]?.shot ?? null,
      timeScale: this.fx.timeScale, hitStopMs: Math.round(this.fx.hitStopLeftMs), excitement: this._excite, pixelRatio: this._pixelRatio,
      quality: this._adaptive.state(),
      phase: this._phase, stage: this._stage,
      models: { p1: !!this._slots.p1.model, p2: !!this._slots.p2.model },
      ghost: { p1: this._slots.p1.ghost, p2: this._slots.p2.ghost }, fx: this.fx.stats(), lost: this._lost,
      ownFade: { p1: fadeOf(this._slots.p1), p2: fadeOf(this._slots.p2) },
      meters: { p1: m('p1'), p2: m('p2') },
      slowmo: { on: this._slow.on, strength: +this._slow.strength.toFixed(2), dodger: this._slow.dodger },
      orbitYaw: +this._orbit.toFixed(3), cuts: this._cutCount,
      replay: { frames: this._recorder.count, clip: this._recorder.clip ? this._recorder.clip.count : 0, pending: !!this._recorder.pending },
      outro: o ? { active: !o.done, t: +o.t.toFixed(2), total: +o.plan.total.toFixed(2), stage: o.stage, kind: o.plan.kind } : null,
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
    };
  }

  /**
   * Draw the menu backdrop (empty lit ring, crowd doing the wave, slow orbit).
   * @param {number} dt  unscaled frame seconds
   * @param {{draw?: boolean}} [opts]
   */
  renderMenu(dt, opts) {
    if (this._scene !== 'menu') this.setScene('menu');
    const realDt = this._tick(dt, opts);
    if (this._lost) return;
    this.fx.update(realDt);
    this.screen.update(realDt);
    this.meters.setHidden(true);
    this.meters.update(realDt);
    this.arena.update(realDt, 0.45, { wave: 1 });
    const ctx = this._ctx;
    ctx.mode = 'menu';
    _shake.x = _shake.y = _shake.roll = 0;
    this._rigs[0].update(realDt, ctx);
    if (opts?.draw === false) return;
    this._drawSingle(this._rigs[0], null);
  }

  /**
   * Draw one frame of a match.
   * @param {import('../core/types.js').MatchView} view
   * @param {number} dt  unscaled frame seconds (see the time contract at the top)
   * @param {{draw?: boolean}} [opts]  draw:false updates everything without drawing (dev fast-forward)
   */
  renderMatch(view, dt, opts) {
    if (this._scene !== 'match') this.setScene('match');
    const realDt = this._tick(dt, opts);
    if (this._lost || !view || !view.boxers) return;
    view = this._holdLost(view); // VIEW3D-LOST-FRAME: a short tracking dropout keeps the last tracked hands / lean
    this._trackPhase(view, realDt);
    if (!this._result && view.result) this._result = { winner: view.result.winner ?? null, method: view.result.method ?? null };
    if (this._outro) { this._renderOutro(view, realDt, opts); return; }

    const paused = view.phase === MatchPhase.PAUSED;
    const ph = paused ? view.pausedFrom ?? this._phaseBeforePause : view.phase;
    this._updateSlowmo(view, paused ? 0 : realDt);
    const slow = this._slow;
    const pScale = slow.on ? slow.scale : 1;
    this.fx.update(paused ? 0 : realDt, pScale);
    this.screen.update(paused ? 0 : realDt);
    if (this.fx.hitStopLeftMs <= 0) this._freezeId = null;
    const ts = this.fx.timeScale;

    for (const id of IDS) this._updateBoxer(id, view, paused ? 0 : realDt, ts);
    this._updateDelayed(paused ? 0 : realDt * ts);
    this._updateExcitement(view, paused ? 0 : realDt);
    this.arena.update(paused ? 0 : realDt * pScale, this._excite);
    if (!paused && (ph === MatchPhase.FIGHTING || ph === MatchPhase.RECOVERY || (ph === MatchPhase.ROUND_START && view.stage === 'fight'))) {
      this._orbit += RENDER_TUNING.orbit.radPerSec * realDt * ts * pScale;
      this.arena.setYaw(this._orbit);
    }
    // meters: hidden around intros, breaks, decisions and results — and during the first-bout
    // tutorial, which has no health (research/mechanics.md §8: "no clock and no pies")
    this.meters.setHidden(INTRO_PHASES.has(ph) || ph === MatchPhase.DECISION || ph === MatchPhase.RESULT || !!view.tutorial);
    for (const id of IDS) {
      const bv = view.boxers[id];
      if (!bv) continue;
      const hp = Number.isFinite(bv.hp) && Number.isFinite(bv.maxHp) && bv.maxHp > 0 ? (bv.hp / bv.maxHp) * 10 : Number.isFinite(bv.hp01) ? bv.hp01 * 10 : NaN;
      if (this._slots[id].pendingRise && bv.phase !== BoxerPhase.DOWN) { this.meters.rise(id, hp); this._slots[id].pendingRise = false; }
      this.meters.observe(id, hp);
    }
    this.meters.update(paused ? 0 : realDt);
    // the replay buffer (live phases only)
    if (!paused && LIVE_PHASES.has(view.phase)) this._recorder.record(realDt, realDt * ts, this._slots, view.boxers);

    const ctx = this._ctx;
    ctx.mode = 'match';
    ctx.phase = view.phase;
    ctx.phaseTime = Number.isFinite(view.phaseTime) ? view.phaseTime : this._phaseClock;
    ctx.stage = typeof view.stage === 'string' ? view.stage : null;
    ctx.stageTime = Number.isFinite(view.stageTime) ? view.stageTime : ctx.phaseTime;
    ctx.versus = view.mode === 'versus' || this._split === 2;
    ctx.downed = view.downed ?? null;
    ctx.winner = view.result ? view.result.winner ?? null : this._result?.winner ?? null;
    ctx.koLoser = this._koLoser;
    for (const id of IDS) {
      const slot = this._slots[id];
      ctx.pos[id].copy(slot.pos);
      ctx.yaw[id] = slot.yaw;
      ctx.lean[id] = view.boxers[id]?.lean ?? null;
      ctx.head[id].copy(slot.head);
      ctx.body[id].copy(slot.body);
    }
    ctx.focus = null;

    const rigDt = paused ? 0 : realDt;
    ctx.shake = this.fx.getShake('p1', _shake);
    this._rigs[0].update(rigDt, ctx);
    this._emitCut(this._rigs[0], 'p1');
    if (this._split === 2) {
      ctx.shake = this.fx.getShake('p2', _shake2);
      this._rigs[1].update(rigDt, ctx);
      this._emitCut(this._rigs[1], 'p2');
    }
    this._updateOwnFade(rigDt);
    if (opts?.draw === false) return;
    if (this._split === 2) this._drawSplit();
    else this._drawSingle(this._rigs[0], 'p1');
  }

  /** VIEW3D-LOST-FRAME: each human view from an untracked frame holds its last tracked hands, guard and lean (holdLostView). */
  _holdLost(view) {
    const now = this._clock();
    let boxers = null;
    for (const id of IDS) {
      const bv = view.boxers[id];
      const h = holdLostView(bv, this._slots[id].held, now);
      if (h !== bv) (boxers ||= { ...view.boxers })[id] = h;
    }
    return boxers ? { ...view, boxers } : view;
  }

  /**
   * R8: in each viewer's own live view, fade that viewer's own gloves and see-through head while they
   * overlap the opponent's face on screen (own-fade.js; ~80 ms, ahead of a lunge). Runs once per
   * frame after the cameras moved; only the viewer's own model, through its ghost material set, so
   * the same model drawn solid in the other versus half or in a cut is untouched. Only the live shot
   * (Shot.PLAY) fades: the round-start settle shot (Shot.BEHIND) always shows the normal ghost look
   * (the fade is reset there); in cuts, cinematics and the outro the own boxer is drawn solid and
   * the fade holds; a new match resets it.
   */
  _updateOwnFade(dt) {
    const n = this._split === 2 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const viewer = i === 0 ? 'p1' : 'p2';
      const slot = this._slots[viewer], foe = this._slots[other(viewer)], rig = this._rigs[i];
      if (!slot.model?.setOwnFade || !foe.model || !rig?.wantsGhost || this._outro) continue;
      try {
        if (rig.shot === Shot.PLAY) slot.model.setOwnFade(slot.ownFade.update(dt, rig.camera, slot.model, foe.model, rig.ownShift));
        else if (rig.shot === Shot.BEHIND) {
          const v = slot.ownFade.value, faded = v.left || v.right || v.head;
          slot.ownFade.reset();
          if (faded) slot.model.setOwnFade(slot.ownFade.value);
        }
      } catch (e) { this._reportOnce('own-fade', '[render] own-part fade failed', e); }
    }
  }

  /**
   * Draw one frame of a training activity.
   * @param {Object} view  TrainingView {kind, phase, playerView, bag?, balls?, trainer?, mitts?, ...}
   * @param {number} dt    unscaled frame seconds
   * @param {{draw?: boolean}} [opts]
   */
  renderTraining(view, dt, opts) {
    if (this._scene !== 'training') this.setScene('training');
    const realDt = this._tick(dt, opts);
    if (this._lost || !view) return;
    const paused = view.phase === 'paused' || view.paused === true;
    this.fx.update(paused ? 0 : realDt);
    this.screen.update(paused ? 0 : realDt);
    this.meters.setHidden(true);
    this.meters.update(realDt);
    const animDt = paused ? 0 : realDt * this.fx.timeScale;

    const slot = this._slots.trainee;
    const pv = holdLostView(view.playerView, slot.held, this._clock()); // VIEW3D-LOST-FRAME
    if (pv) {
      const model = this._ensureModel(slot, pv.appearance ?? DEFAULT_APPEARANCE.p1, 'boxer', true, this._trainGroup);
      slot.view = pv;
      if (!slot.placed) { slot.anchor.copy(BASE.p1); slot.yaw = BASE_YAW.p1; slot.placed = true; }
      this._applyLean(slot, pv, realDt);
      if (model) {
        model.object3d.position.copy(slot.pos);
        model.object3d.rotation.set(0, slot.yaw + RENDER_TUNING.modelForwardYaw, 0);
        this._safeUpdate(model, pv, animDt);
      }
    }

    const ts = this._ensureTrainingScene();
    if (ts) {
      if (view.kind !== this._trainKind) {
        this._trainKind = view.kind;
        try { ts.setActivity?.(view.kind); } catch (e) { console.error('[render] TrainingScene.setActivity failed', e); }
      }
      try { ts.update?.(view, animDt); } catch (e) { this._reportOnce('ts-update', '[render] TrainingScene.update failed', e); }
    }

    this.arena.update(paused ? 0 : realDt, 0.25 + 0.25 * clamp01((view.combo ?? 0) / 10));
    const ctx = this._ctx;
    ctx.mode = 'training';
    ctx.lean.p1 = pv?.lean ?? null;
    ctx.focus = this._trainingFocus(ts);
    ctx.shake = this.fx.getShake('p1', _shake);
    this._rigs[0].update(paused ? 0 : realDt, ctx);
    if (opts?.draw === false) return;
    if (slot.model && slot.ghost !== this._rigs[0].wantsGhost) { slot.model.setGhost?.(this._rigs[0].wantsGhost); slot.ghost = this._rigs[0].wantsGhost; }
    this._drawSingle(this._rigs[0], null);
  }

  /** Match the drawing buffer to the canvas' CSS size (called automatically when it changes). */
  resize() {
    const c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : c.width) || 1));
    const h = Math.max(1, Math.round(c.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : c.height) || 1));
    this._w = w; this._h = h;
    this.renderer.setPixelRatio(this._pixelRatio);
    this.renderer.setSize(w, h, false);
    this._applyAspects();
  }

  _applyAspects() {
    const w = this._w, h = this._h, gap = RENDER_TUNING.splitGapPx;
    const single = this._split !== 2 || this.outroActive || (this._outro && this._outro.done);
    const aspect = single ? w / h : Math.max(0.1, (w / 2 - gap / 2) / h);
    for (const rig of this._rigs) rig?.setAspect(aspect);
  }

  /** Clear match state (new match / restart). Models are kept and reused by appearance. */
  resetMatch() {
    this.fx.clear();
    this.screen.clear();
    this._resetMatchState();
    for (const rig of this._rigs) rig?.cut();
  }

  // ───────────────────────────── bout outro (ARCHITECTURE §6.5) ─────────────────────────────

  /**
   * Play the bout outro: KO → our own logo wipe → white flash → slow-motion multi-angle replay
   * of the final knockdown blow → white fade → win banner moment (3D confetti + light streaks;
   * the banner TEXT is the HUD's) → the winner faces the camera with the beaten opponent behind.
   * Decision / draw: flash → banner → winner. Emits Ev.RENDER_OUTRO {stage, winner, method} for
   * 'start', 'wipe', 'flash', 'replay', 'banner', 'winner', 'end'. Never throws: called twice it
   * returns the running promise; outside a match or without a recorded clip it still resolves.
   * Keep calling renderMatch(view, dt) every frame while it runs.
   * @param {{result?:Object|null, view?:Object|null, fast?:boolean, reducedMotion?:boolean}} [o]
   * @returns {Promise<void>}
   */
  playOutro({ result = null, view = null, fast = undefined, reducedMotion = undefined } = {}) {
    try {
      if (this._outro && !this._outro.done) return this._outro.promise;
      if (this._scene !== 'match') return Promise.resolve();
      const res = result ?? view?.result ?? this._result ?? null;
      const winner = res?.winner === 'p1' || res?.winner === 'p2' ? res.winner : null;
      const method = res?.method ?? null;
      const ko = method === ResultMethod.KO || method === ResultMethod.TKO;
      const clip = ko ? this._recorder.latestClip() : null;
      const isFast = fast ?? this._fast ?? this._fastFromUrl();
      const rm = reducedMotion ?? this._reducedMotion;
      const plan = planOutro({ ko, clip: clip ? { tau0: clip.tau0, tau1: clip.tau1, blowTau: clip.blowTau } : null, fast: !!isFast, reducedMotion: rm });
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      const blow = clip?.blow ?? {};
      const att = blow.attacker === 'p2' ? 'p2' : blow.attacker === 'p1' ? 'p1' : winner ?? 'p1';
      this._outro = {
        plan, t: 0, stageIdx: 0, stage: null, winner, method, ko, clip, resolve, promise, done: false,
        segIdx: -1, prevTau: null, evDone: 0, staged: null, flashed: false, impactShown: false,
        attacker: att, loser: other(att), reduced: rm, wall: Date.now(), timer: null,
      };
      this._fadeOutroMeters();
      this._advanceOutroStages();
      this._armWatchdog();
      return promise;
    } catch (e) {
      this._reportOnce('outro', '[render] playOutro failed — resolving', e);
      this._finishOutro();
      return Promise.resolve();
    }
  }

  /**
   * Compile, ahead of the bout, every shader program its key moments would otherwise compile on
   * the main thread (PERF-04, ARCHITECTURE D11): builds both boxer models for the bout's looks
   * (kept: the match reuses them by appearance), and compiles both of their material sets — solid
   * and ghost (the human switches to ghost at "Fight!"; in versus each player is a ghost in their
   * own viewport) — together with the arena, the FX pools, the health meters and the screen
   * overlays, through renderer.compileAsync (parallel compiles where KHR_parallel_shader_compile
   * exists). Restores every ghost state afterwards. Call it while the VS card is up (or during the
   * short black before it). Never throws, never draws.
   * @param {{p1?:Object|null, p2?:Object|null, versus?:boolean}} [o]  the bout's appearances
   * @returns {Promise<{programs:number, ms:number, skipped?:string}>}
   */
  async prewarm({ p1 = null, p2 = null, versus = false } = {}) {
    const t0 = this._clock();
    const r = this.renderer;
    const progs = () => (Array.isArray(r.info?.programs) ? r.info.programs.length : 0);
    const before = progs();
    if (this._lost) return { programs: 0, ms: 0, skipped: 'context-lost' };
    if (typeof r.compileAsync !== 'function' && typeof r.compile !== 'function') return { programs: 0, ms: 0, skipped: 'no-compile' };
    const compile = (cam) => (typeof r.compileAsync === 'function' ? r.compileAsync(this.scene, cam) : Promise.resolve(r.compile(this.scene, cam)));
    const cam = this._rigs[0].camera;
    const restore = [];
    try {
      const models = [];
      for (const [id, look] of [['p1', p1], ['p2', p2]]) {
        const slot = this._slots[id];
        const m = this._ensureModel(slot, look ?? slot.view?.appearance ?? DEFAULT_APPEARANCE[id], 'boxer', id === 'p1' && !versus, this._boxerGroup);
        if (m) models.push([slot, m]);
      }
      // first pass: everything as it is now (arena, FX pools, meters, screen overlays, both models)
      await compile(cam);
      // second pass: the other material set of each model (solid ↔ ghost), then put them back
      for (const [slot, m] of models) {
        const was = !!m.ghost;
        restore.push(() => { try { m.setGhost?.(was); slot.ghost = was; } catch { /* optional API */ } });
        m.setGhost?.(!was);
      }
      if (models.length) await compile(cam);
    } catch (e) {
      this._reportOnce('prewarm', '[render] shader prewarm failed (the first bout may hitch once)', e);
    } finally {
      for (const f of restore) f();
    }
    return { programs: progs() - before, ms: Math.round(this._clock() - t0) };
  }

  /** Jump to the end of the outro (stages 'end', resolves the promise, holds the winner shot). */
  skipOutro() {
    const o = this._outro;
    if (!o || o.done) return;
    o.t = o.plan.total;
    this._finishOutro();
  }

  dispose() {
    this._finishOutro();
    for (const off of this._offs) off();
    this._offs = [];
    this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
    for (const slot of Object.values(this._slots)) this._disposeModel(slot);
    try { this._training?.dispose?.(); } catch { /* owner's dispose failed; nothing else to do */ }
    this.fx.dispose();
    this.screen.dispose();
    this.meters.dispose();
    this.arena.dispose();
    this._envTex?.dispose();
    this.renderer.dispose();
  }

  // ───────────────────────────── internals: time & layout ─────────────────────────────

  _tick(dt, opts) {
    if (opts && Number.isFinite(opts.externalMs)) this._adaptive.setExternalCost(opts.externalMs);
    const now = this._clock();
    let real;
    if (this._lastNow == null) real = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
    else real = (now - this._lastNow) / 1000;
    this._lastNow = now;
    if (!(real > 0)) real = 0;
    if (real > 0.25) real = Number.isFinite(dt) && dt > 0 && dt < 0.1 ? dt : 1 / 60; // tab switch / long hitch
    real = Math.min(real, 0.1);
    this._adapt(real);
    const c = this.canvas;
    if ((c.clientWidth && c.clientWidth !== this._w) || (c.clientHeight && c.clientHeight !== this._h)) this.resize();
    return real;
  }

  /**
   * Main-thread milliseconds the current frame spent outside rendering — pose detection
   * (InputHub.lastDetectMs). Call it once per frame before renderMatch / renderMenu /
   * renderTraining; the adaptive quality ('auto') subtracts it from the frame interval it judges,
   * so detection time is never mistaken for render time (PERF-03, ARCHITECTURE D9). Also accepted
   * as `opts.externalMs` on the render calls. Accumulates until the next rendered frame.
   * @param {number} ms
   */
  setExternalFrameCost(ms) { this._adaptive.setExternalCost(ms); }

  _adapt(real) {
    const c = this._adaptive.frame(real);
    if (!c) return;
    const verb = c.dir === 'down' ? 'lowering' : 'raising';
    // a step taken for pose detection (PERF-06) says so: adaptive.js logged its reason just before ('rate', 'lag', 'start',
    // or 'context' for the level remembered for the bout / menus)
    const why = c.reason === 'detection' ? ` (for pose detection: ${c.why || 'rate'})` : '';
    if (c.pixelRatio != null) {
      this._pixelRatio = c.pixelRatio;
      this.resize();
      console.info(`[render] average frame ${c.avgMs.toFixed(1)} ms (render share) — ${verb} pixel ratio to ${c.pixelRatio}${why}`);
    }
    if (c.shadow) {
      this._shadowLowered = c.shadow === 'low';
      this.arena.setShadowMapSize(this._shadowLowered ? RENDER_TUNING.shadowMapLow : RENDER_TUNING.shadowMapHigh);
      console.info(`[render] average frame ${c.avgMs.toFixed(1)} ms (render share) — ${verb} shadow resolution${why}`);
    }
  }

  _drawSingle(rig, viewer) {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this._w, this._h);
    this.arena.setMirrored(false);
    this.fx.setViewportChannel('p1');
    this.screen.setChannel('p1');
    if (viewer) this._setGhosts(viewer, rig);
    this._prepareMeters(viewer ?? 'p1', rig, this._w / this._h, !viewer || this._scene !== 'match');
    r.render(this.scene, rig.camera);
  }

  _drawSplit() {
    const r = this.renderer;
    const w = this._w, h = this._h, gap = RENDER_TUNING.splitGapPx;
    const vw = Math.floor(w / 2 - gap / 2);
    r.setScissorTest(true);
    r.setScissor(0, 0, w, h);
    r.setClearColor(RENDER_TUNING.dividerColor, 1);
    r.clear(true, true, false);
    r.setClearColor(LIGHTING.hallTop, 1);
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? 0 : w - vw;
      const viewer = i === 0 ? 'p1' : 'p2';
      r.setViewport(x, 0, vw, h);
      r.setScissor(x, 0, vw, h);
      this.arena.setMirrored(i === 1);
      this.fx.setViewportChannel(viewer);
      this.screen.setChannel(viewer);
      this._setGhosts(viewer, this._rigs[i]);
      this._prepareMeters(viewer, this._rigs[i], vw / h, false);
      r.render(this.scene, this._rigs[i].camera);
    }
    r.setScissorTest(false);
    this.arena.setMirrored(false);
  }

  /** Ghost the viewer's own boxer when that viewport's camera is behind it; everyone else solid. */
  _setGhosts(viewer, rig) {
    for (const id of IDS) {
      const slot = this._slots[id];
      if (!slot.model) continue;
      const ghost = id === viewer && rig.wantsGhost && !this._outro;
      if (slot.ghost !== ghost) {
        try { slot.model.setGhost?.(ghost); } catch (e) { this._reportOnce('ghost', '[render] setGhost failed', e); }
        slot.ghost = ghost;
      }
    }
  }

  /** Place both meters for this viewport (own low-left, the foe's by its head). */
  _prepareMeters(viewer, rig, aspect, hideAll) {
    if (hideAll) { this.meters.hideMeshes(); return; }
    const foe = other(viewer);
    _anchors.foeHead = this._slots[foe].model ? this._slots[foe].head : null;
    _anchors.ownAnchor = this._slots[viewer].model && rig.shot === Shot.PLAY ? this._slots[viewer].meterAnchor : null;
    this.meters.prepare(viewer, rig.camera, _anchors, aspect);
  }

  /** Announce a rig's hard cut on the bus. */
  _emitCut(rig, viewer) {
    const c = rig.takeCut();
    if (!c) return;
    this._cutCount++;
    if (c.kind === 'round-intro') this.screen.setFade(RENDER_TUNING.dip.alpha, LIGHTING.hallTop, RENDER_TUNING.dip.decayPerSec);
    if (this.bus) this.bus.emit(Ev.RENDER_CUT, { kind: c.kind, viewer, durationMs: c.durationMs });
  }

  // ───────────────────────────── internals: match staging ─────────────────────────────

  _resetMatchState() {
    this._finishOutro();
    this._outro = null;
    for (const rig of this._rigs) rig?.setOverride(null);
    this._phase = null;
    this._stage = null;
    this._phaseBeforePause = null;
    this._phaseClock = 0;
    this._koLoser = null;
    this._result = null;
    this._excite = 0.45;
    this._exciteBoost = 0;
    this._freezeId = null;
    this._orbit = 0;
    this.arena.setYaw(0);
    this._slow.on = false; this._slow.left = 0; this._slow.strength = 0; this._slow.dodger = null;
    this.screen.setSlow('p1', 0); this.screen.setSlow('p2', 0);
    this.meters.reset();
    this._recorder.reset();
    for (const id of ['p1', 'p2', 'trainee']) {
      const slot = this._slots[id];
      slot.placed = false; slot.pendingRise = false;
      slot.ownFade.reset();
      try { slot.model?.setOwnFade?.(slot.ownFade.value); } catch { /* optional API */ }
      for (const hand of HANDS) { slot.trail[hand].on = false; slot.trail[hand].id = null; }
    }
    if (this._delayed) for (const d of this._delayed) d.active = false;
    this._applyAspectsSafe();
  }

  _applyAspectsSafe() { if (this._w > 0 && this._h > 0) this._applyAspects(); }

  _trackPhase(view, realDt) {
    const ph = view.phase;
    if (ph !== this._phase) {
      const prev = this._phase;
      const resumed = prev === MatchPhase.PAUSED ? this._phaseBeforePause : prev;
      if (ph === MatchPhase.PAUSED) this._phaseBeforePause = prev;
      const newMatch = ph === MatchPhase.INTRO && resumed !== MatchPhase.INTRO && prev != null;
      const restart = resumed === MatchPhase.RESULT && ph !== MatchPhase.RESULT && ph !== MatchPhase.PAUSED;
      if (newMatch || restart) {
        this.fx.clear();
        this.screen.clear();
        this._resetMatchState();
        for (const rig of this._rigs) rig?.cut();
      }
      const resuming = prev === MatchPhase.PAUSED && ph === resumed;
      if (ph !== MatchPhase.PAUSED && !resuming) this._phaseClock = 0;
      this._phase = ph;
    }
    this._stage = typeof view.stage === 'string' ? view.stage : null;
    if (ph !== MatchPhase.PAUSED) this._phaseClock += realDt;
  }

  _ensureModel(slot, appearance, role, ghost, parent) {
    const Model = this._BoxerModel;
    if (!Model || !appearance) return slot.model;
    if (slot.model && slot.appRef === appearance) return slot.model;
    const key = `${role}|${safeKey(appearance)}`;
    slot.appRef = appearance;
    if (slot.model && slot.key === key) return slot.model;
    if (slot.failedKey === key) return null;
    this._disposeModel(slot);
    try {
      slot.model = new Model(appearance, { ghost, role });
      slot.key = key;
      slot.ghost = ghost;
      slot.human = null;
      (parent ?? this._boxerGroup).add(slot.model.object3d);
      this._linkFoes();
    } catch (e) {
      console.error(`[render] could not build the ${role} model`, e);
      slot.model = null;
      slot.failedKey = key;
    }
    return slot.model;
  }

  /** Let each boxer aim punches at the other's actual (moving) position. */
  _linkFoes() {
    const a = this._slots.p1.model, b = this._slots.p2.model;
    try {
      if (a && b) { a.setFoe?.(b); b.setFoe?.(a); }
    } catch { /* optional API */ }
  }

  _disposeModel(slot) {
    if (!slot.model) return;
    slot.model.object3d?.removeFromParent();
    try { slot.model.dispose?.(); } catch { /* owner's dispose failed; the object is detached anyway */ }
    slot.model = null; slot.key = null; slot.ghost = null;
  }

  _safeUpdate(model, view, dt) {
    try { model.update(view, dt); } catch (e) { this._reportOnce('model-update', '[render] BoxerModel.update failed', e); }
  }

  _reportOnce(key, msg, e) {
    this._reported ??= new Set();
    if (this._reported.has(key)) return;
    this._reported.add(key);
    console.error(msg, e);
  }

  _isHuman(id) { return !!this._slots[id]?.view?.isHuman; }

  _applyLean(slot, bv, realDt) {
    const T = RENDER_TUNING;
    const down = bv && (bv.phase === BoxerPhase.DOWN || bv.phase === BoxerPhase.KO || bv.phase === BoxerPhase.GETUP);
    const lean = bv?.lean;
    if (lean && !down) {
      rightOf(slot.yaw, _v);
      facingOf(slot.yaw, _v2);
      _dir.set(0, 0, 0)
        .addScaledVector(_v, (Number.isFinite(lean.x) ? lean.x : 0) * T.leanRootShift)
        .addScaledVector(_v2, (Number.isFinite(lean.z) ? lean.z : 0) * T.leanFwdShift);
    } else _dir.set(0, 0, 0);
    slot.leanOff.lerp(_dir, 1 - Math.exp(-T.leanLambda * realDt));
    slot.pos.copy(slot.anchor).add(slot.leanOff);
  }

  /**
   * Place, pose and animate one boxer. A human boxer animates on real time (the player's gloves
   * follow their hands) except when an impact freezes it; the AI animates on scaled time (it
   * freezes on hit-stop) and slows with the dodge slow motion.
   */
  _updateBoxer(id, view, realDt, ts) {
    const T = RENDER_TUNING;
    const bv = view.boxers[id];
    const slot = this._slots[id];
    slot.view = bv ?? null;
    if (!bv) return;
    if (!slot.placed) { slot.anchor.copy(BASE[id]); slot.yaw = BASE_YAW[id]; slot.leanOff.set(0, 0, 0); slot.placed = true; }
    const human = !!bv.isHuman;
    let k = human && this._freezeId !== id ? 1 : ts;
    if (this._slow.on && id !== this._slow.dodger && !human) k *= this._slow.scale;
    const animDt = realDt * k;

    // where should this boxer stand? (while the other one is down: the opponent waits at the far side)
    const ph = view.phase === MatchPhase.PAUSED ? this._phaseBeforePause : view.phase;
    const downed = view.downed ?? (ph === MatchPhase.RESULT || ph === MatchPhase.KNOCKDOWN ? this._koLoser : null);
    const target = _v.copy(BASE[id]);
    let yaw = BASE_YAW[id];
    if ((ph === MatchPhase.KNOCKDOWN || ph === MatchPhase.RESULT) && downed && downed !== id) {
      const versus = view.mode === 'versus' || this._split === 2;
      const far = versus ? T.kd.versusFar : human ? T.kd.humanStay : T.kd.aiFar;
      facingOf(BASE_YAW[id], _v2);
      target.addScaledVector(_v2, -far);
      _v2.subVectors(this._slots[downed].pos, target);
      if (_v2.lengthSq() > 1e-4) yaw = Math.atan2(_v2.x, _v2.z);
    }
    moveToward(slot.anchor, target, T.walkSpeed * animDt);
    slot.yaw = approachAngle(slot.yaw, yaw, T.turnSpeed * realDt);
    this._applyLean(slot, bv, realDt);

    const model = this._ensureModel(slot, bv.appearance ?? DEFAULT_APPEARANCE[id], 'boxer', id === 'p1' && view.mode !== 'versus', this._boxerGroup);
    if (!model) return;
    if (slot.human !== human) { slot.human = human; try { model.setFallStyle?.(human ? 'front' : null); } catch { /* optional */ } }
    model.object3d.position.copy(slot.pos);
    model.object3d.rotation.set(0, slot.yaw + T.modelForwardYaw, 0);
    this._safeUpdate(model, bv, animDt);
    this._updateAnchors(id, slot, model);
    if (realDt > 0) this._updateTrails(id, slot, bv, model, human);
  }

  /** Head / body / meter anchor world points of a boxer (cameras, meters, FX). */
  _updateAnchors(id, slot, model) {
    try {
      if (this._headWorldPosition) this._headWorldPosition(model, slot.head);
      else this._targetPos(id, 'head', slot.head);
      if (this._bodyWorldPosition) this._bodyWorldPosition(model, slot.body);
      else slot.body.copy(slot.pos).setY(0.3);
    } catch {
      this._targetPos(id, 'head', slot.head);
      slot.body.copy(slot.pos).setY(0.3);
    }
    const A = RENDER_TUNING.meterAnchor;
    rightOf(slot.yaw, _v4);
    facingOf(slot.yaw, _dir);
    slot.meterAnchor.copy(slot.pos).addScaledVector(_v4, A[0]).addScaledVector(_dir, A[2]);
    slot.meterAnchor.y = A[1];
  }

  /** Red trail on the opponent's power punch / hook, blue on the player's fast punch (from the view). */
  _updateTrails(id, slot, bv, model, human) {
    const T = RENDER_TUNING.trail;
    for (const hand of HANDS) {
      const q = punchFor(bv, hand);
      const st = slot.trail[hand];
      const travel = !!q && q.stage !== 'recover' && q.stage !== 'windup' && (q.stage === 'travel' || bv.phase === BoxerPhase.PUNCH);
      const power = Number.isFinite(q?.power) ? q.power : 0;
      const want = travel && (human ? power >= T.humanFast : (q.kind === 'hook' || !!q.powerPunch || !!q.heavy || power >= T.aiPower));
      const key = TRAIL_KEY[id][hand];
      if (want && (!st.on || (q.id != null && q.id !== st.id))) {
        this.fx.trailStart(key, human ? PALETTE.trailBlue : PALETTE.trailRed);
        st.on = true; st.id = q.id ?? null;
      }
      if (st.on && this._gloveOrEstimate(id, hand, _v4)) this.fx.trailPoint(key, _v4);
      if (st.on && !want) {
        const missed = q && (q.outcome === 'dodged' || q.outcome === 'miss');
        this.fx.trailStop(key, missed && !human ? T.missLinger : T.hitLinger);
        st.on = false;
      }
    }
    void model;
  }

  /** Dodge slow motion state from view.slowmo (preferred) or Ev.MATCH_SLOWMO's timer. */
  _updateSlowmo(view, realDt) {
    const S = this._slow, T = RENDER_TUNING.slowmo;
    const vs = view.slowmo;
    if (vs && typeof vs === 'object') {
      S.on = true;
      S.dodger = vs.dodger === 'p2' ? 'p2' : 'p1';
      S.scale = Number.isFinite(vs.scale) && vs.scale > 0 ? Math.min(1, vs.scale) : T.scale;
      S.left = Number.isFinite(vs.msLeft) ? vs.msLeft / 1000 : 0.1;
    } else if (S.left > 0) {
      S.left -= realDt;
      S.on = S.left > 0;
    } else S.on = false;
    const goal = S.on ? 1 : 0;
    const rate = S.on ? 1 / T.fadeIn : 1 / T.fadeOut;
    S.strength = clamp01(S.strength + Math.sign(goal - S.strength) * rate * realDt);
    const ch = S.dodger === 'p2' ? 'p2' : 'p1';
    this.screen.setSlow(ch, S.strength);
    this.screen.setSlow(other(ch), 0);
  }

  _updateExcitement(view, dt) {
    const E = RENDER_TUNING.excitement;
    const base = E.base[view.phase] ?? 0.35;
    const lowHp = Math.min(view.boxers.p1?.hp01 ?? 1, view.boxers.p2?.hp01 ?? 1);
    const target = clamp01(base + this._exciteBoost + (view.phase === MatchPhase.FIGHTING ? (1 - lowHp) * 0.25 : 0));
    this._excite += (target - this._excite) * (1 - Math.exp(-E.lambda * dt));
    this._exciteBoost *= Math.exp(-E.boostDecay * dt);
  }

  _schedule(kind, x, z, size, gameDelay, who = null, hand = null) {
    if (kind === 'dust') { for (const d of this._delayed) if (d.active && d.kind === 'dust') return; }
    let slot = this._delayed[0];
    for (const d of this._delayed) if (!d.active) { slot = d; break; }
    slot.active = true; slot.kind = kind; slot.t = gameDelay; slot.x = x; slot.z = z; slot.size = size;
    slot.who = who; slot.hand = hand;
  }

  _updateDelayed(animDt) {
    for (const d of this._delayed) {
      if (!d.active) continue;
      d.t -= animDt;
      if (d.t > 0) continue;
      d.active = false;
      if (d.kind === 'dust') { _v.set(d.x, 0, d.z); this.fx.dust(_v, { size: d.size }); this.fx.shake(0.18, 'all'); }
      else if (d.kind === 'glint' && this._gloveOrEstimate(d.who, d.hand, _v)) this.fx.glint(_v, { size: RENDER_TUNING.glintSize });
    }
  }

  // ───────────────────────────── internals: positions for FX ─────────────────────────────

  _heightScale(id) { return this._slots[id].view?.appearance?.height ?? 1; }

  /** Head (or body) centre of a boxer in world space (estimate; accounts for lean). */
  _targetPos(id, target, out) {
    const slot = this._slots[id];
    const h = LAYOUT.boxerHeight * this._heightScale(id);
    out.copy(slot.pos);
    const lean = slot.view?.lean;
    if (target === 'body') {
      out.y = h * 0.52;
    } else {
      out.y = h * 0.77;
      if (lean) {
        rightOf(slot.yaw, _v3);
        out.addScaledVector(_v3, (lean.x || 0) * 0.16);
        out.y += Math.min(0, lean.y || 0) * 0.32;
      }
    }
    return out;
  }

  /** World impact point for a hit/block: on the defender's surface toward the attacker. */
  _impactPos(e, att, def, frontOffset, out) {
    if (readVec3(e.pos, out)) return out;
    const dm = this._slots[def].model;
    try {
      if (dm && e.target !== 'body' && this._headWorldPosition) {
        this._headWorldPosition(dm, out, { front: true });
        if (Number.isFinite(out.x)) return this._towardAttacker(out, att, def, frontOffset - 0.17);
      } else if (dm && e.target === 'body' && this._bodyWorldPosition) {
        this._bodyWorldPosition(dm, out);
        if (Number.isFinite(out.x)) return this._towardAttacker(out, att, def, frontOffset - 0.12);
      }
    } catch { /* fall back to the estimate below */ }
    this._targetPos(def, e.target, out);
    _dir.subVectors(this._slots[att].pos, this._slots[def].pos).setY(0);
    if (_dir.lengthSq() > 1e-6) out.addScaledVector(_dir.normalize(), frontOffset);
    return out;
  }

  _towardAttacker(out, att, def, d) {
    if (d === 0) return out;
    _dir.subVectors(this._slots[att].pos, this._slots[def].pos).setY(0);
    if (_dir.lengthSq() > 1e-6) out.addScaledVector(_dir.normalize(), d);
    return out;
  }

  /** World glove position (model helper when available, else a guard-position estimate). */
  _gloveOrEstimate(id, hand, out) {
    const slot = this._slots[id];
    if (!slot) return false;
    if (slot.model && this._gloveWorldPosition) {
      try { const g = this._gloveWorldPosition(slot.model, hand, out); if (g && Number.isFinite(g.x)) { if (g !== out) out.copy(g); return true; } } catch { /* estimate */ }
    }
    facingOf(slot.yaw, _dir); rightOf(slot.yaw, _v2);
    out.copy(slot.pos).addScaledVector(_dir, 0.28).addScaledVector(_v2, hand === 'left' ? -0.2 : 0.2);
    out.y = LAYOUT.boxerHeight * this._heightScale(id) * 0.72;
    return true;
  }

  _trainingFocus(ts) {
    const f = ts?.focus ?? ts?.cameraTarget ?? (typeof ts?.getFocus === 'function' ? ts.getFocus() : null);
    if (f && readVec3(f, this._trainFocus)) return this._trainFocus;
    return this._trainFocus.set(BASE.p2.x, 1.1, BASE.p2.z);
  }

  _ensureTrainingScene() {
    if (this._training || !this._TrainingScene) return this._training;
    if (this._trainingFailed) return null;
    try {
      this._training = new this._TrainingScene(this);
      const obj = this._training.object3d;
      if (obj && obj.parent !== this._trainGroup) this._trainGroup.add(obj);
    } catch (e) {
      console.error('[render] could not build the training scene', e);
      this._trainingFailed = true;
      this._training = null;
    }
    return this._training;
  }

  /** The rig drawing `id`'s own view (null when that player has no viewport). */
  _rigFor(id) {
    if (this._split === 2) return id === 'p2' ? this._rigs[1] : this._rigs[0];
    return id === 'p1' ? this._rigs[0] : null;
  }

  // ───────────────────────────── bus → effects ─────────────────────────────

  _subscribe(bus) {
    const on = (name, fn) => { if (name) this._offs.push(bus.on(name, (p) => fn.call(this, p ?? {}))); };
    on(Ev.MATCH_HIT, this._onHit);
    on(Ev.MATCH_WINDUP, this._onWindup);
    on(Ev.MATCH_DAZED, this._onDazed);
    on(Ev.MATCH_BLOCK, this._onBlock);
    on(Ev.MATCH_DODGE, this._onDodge);
    on(Ev.MATCH_MISS, this._onMiss);
    on(Ev.MATCH_KNOCKDOWN, this._onKnockdown);
    on(Ev.MATCH_COUNT, this._onCount);
    on(Ev.MATCH_GETUP, this._onGetup);
    on(Ev.MATCH_KO, this._onKO);
    on(Ev.MATCH_RESULT, this._onResult);
    on(Ev.MATCH_ROUND_START, this._onRoundStart);
    on(Ev.MATCH_INTRO, this._onIntro);
    on(Ev.MATCH_SLOWMO, this._onSlowmo);
    on(Ev.MATCH_CALL, this._onCall);
    on(Ev.TRAIN_EVENT, this._onTrainEvent);
    on(Ev.SETTINGS_CHANGED, (e) => { if (e.settings && 'reducedMotion' in e.settings) this.setReducedMotion(e.settings.reducedMotion); });
    on(Ev.TRAIN_SCORE, this._onTrainScore);
  }

  _onHit(e) {
    if (this._scene !== 'match' || this._outro) return;
    const S = RENDER_TUNING.shake;
    const att = e.attacker === 'p2' ? 'p2' : 'p1';
    const def = e.defender === 'p1' || e.defender === 'p2' ? e.defender : other(att);
    const power = clamp01(Number.isFinite(e.power) ? e.power : 0.6);
    const counter = !!e.counter;
    const knockdown = !!e.knockdown;
    const attHuman = this._isHuman(att), defHuman = this._isHuman(def);
    const heavy = !!e.heavy || counter || knockdown;
    const pos = this._impactPos(e, att, def, 0.17, _v);

    // hit-stop tiers (§2.8): the impact freezes the struck boxer's model too
    const ms = hitStopMsFor(e, (id) => this._isHuman(id));
    if (ms > 0) { this.fx.hitStop(ms); this._freezeId = def; }

    // hit vocabulary (§5)
    if (attHuman || !defHuman) this.fx.hit(pos, { kind: attHuman ? 'player' : 'neutral', power, counter, scale: knockdown ? RENDER_TUNING.knockdownHitScale : 1 });
    if (defHuman) {
      this.fx.hit(pos, { kind: 'taken', power, heavy });
      const rig = this._rigFor(def);
      if (rig) {
        this.fx.speedLines(def, 1);
        const dur = knockdown ? RENDER_TUNING.cut.knockdownBlowMs : heavy ? RIG_TUNING.hit.heavyMs : RIG_TUNING.hit.ms;
        rig.hitCut({ heavy, durationMs: dur });
      }
      this.fx.shake(S.hitTaken + S.hitTakenPower * power + (counter ? S.counterBonus : 0), def);
    }
    if (attHuman) this.fx.shake(S.hitLanded, att);
    if (knockdown) this.fx.screenFlash(0.28, 0xffffff);
    if ((power >= RENDER_TUNING.sweatPower || counter) && !defHuman) { // (a human's own sweat would fly into its camera)
      this._targetPos(def, 'head', _v2);
      _dir.subVectors(this._slots[def].pos, this._slots[att].pos).setY(0).normalize().setY(0.35);
      this.fx.sweat(_v2, _dir, { amount: 0.6 + power });
    }

    // health meter of the boxer who was hit (wedges) — only for a hit that cost health: the
    // first-bout tutorial's hits carry damage 0 and must not arm a meter that fades in after it (Q3)
    const toW = (x) => (Number.isFinite(x) ? x : undefined);
    const after = toW(e.hpAfter) ?? (Number.isFinite(e.hp01) ? e.hp01 * 10 : undefined);
    if (knockdown || !harmless(e)) this.meters.hit(def, { hpBefore: toW(e.hpBefore), hpAfter: after, knockdown });

    // replay memory
    this._recorder.event('hit', pos, { counter, heavy, knockdown, power, attacker: att, defender: def });
    if (knockdown) this._recorder.markBlow({ attacker: att, defender: def, hand: e.hand, kind: e.kind, target: e.target, counter });

    // crowd
    const C = RENDER_TUNING.crowd;
    this.arena.cheer(counter ? C.counter : C.hit + 0.25 * power);
    if (counter) this.arena.taunt(false);
    const E = RENDER_TUNING.excitement;
    this._exciteBoost = Math.min(0.6, this._exciteBoost + E.hit + E.hitPower * power + (counter ? E.counter : 0));
  }

  /** AI telegraph: early opponents flash a glint on the cocked glove (tell.glint). */
  _onWindup(e) {
    if (this._scene !== 'match' || !e.tell?.glint) return;
    const who = e.attacker === 'p2' ? 'p2' : 'p1';
    const ms = Number.isFinite(e.windupMs) ? e.windupMs : 400;
    this._schedule('glint', 0, 0, 1, Math.max(0.05, (ms / 1000) * RENDER_TUNING.glintAt), who, e.hand === 'left' ? 'left' : 'right');
  }

  _onDazed() {
    if (this._scene !== 'match') return;
    this.arena.cheer(0.35);
  }

  /** Any block: a quick green ring at the contact point (no cut, no meter). */
  _onBlock(e) {
    if (this._scene !== 'match' || this._outro) return;
    const att = e.attacker === 'p2' ? 'p2' : 'p1';
    const def = e.defender === 'p1' || e.defender === 'p2' ? e.defender : other(att);
    const pos = this._impactPos(e, att, def, 0.3, _v);
    pos.y -= e.target === 'body' ? 0 : 0.06; // gloves sit just under the eyes
    this.fx.block(pos, { power: clamp01(e.power ?? 0.5) });
    this.fx.shake(RENDER_TUNING.shake.block, def);
    this._recorder.event('block', pos, { attacker: att, defender: def });
  }

  /** A dodged punch: the opponent's misses leave a red streak (it lingers in the slow motion). */
  _onDodge(e) {
    if (this._scene !== 'match' || this._outro) return;
    const att = e.attacker === 'p2' ? 'p2' : 'p1';
    const def = e.defender === 'p1' || e.defender === 'p2' ? e.defender : other(att);
    this._missEffect(att, e.hand);
    this._exciteBoost = Math.min(0.6, this._exciteBoost + RENDER_TUNING.excitement.dodge);
    void def;
  }

  _onMiss(e) {
    if (this._scene !== 'match' || this._outro) return;
    this._missEffect(e.attacker === 'p2' ? 'p2' : 'p1', e.hand);
  }

  _missEffect(att, hand) {
    const slot = this._slots[att];
    this._gloveOrEstimate(att, hand === 'right' ? 'right' : 'left', _v);
    facingOf(slot.yaw, _dir);
    if (this._isHuman(att)) this.fx.miss(_v, _dir);
    else this.fx.missStreak(_v, _dir, { life: this._slow.on ? 0.45 : 0.42 });
  }

  _onSlowmo(e) {
    if (this._scene !== 'match') return;
    const S = this._slow;
    S.dodger = e.dodger === 'p2' ? 'p2' : 'p1';
    S.attacker = e.attacker === 'p1' || e.attacker === 'p2' ? e.attacker : other(S.dodger);
    S.scale = Number.isFinite(e.scale) && e.scale > 0 ? Math.min(1, e.scale) : RENDER_TUNING.slowmo.scale;
    S.left = (Number.isFinite(e.durationMs) ? e.durationMs : RENDER_TUNING.slowmo.ms) / 1000;
    S.on = true;
  }

  _onCall(e) {
    if (this._scene !== 'match') return;
    if (e.call === 'fight') this.arena.cheer(0.6);
    else if (e.call === 'round' || e.call === 'final-round') { this.arena.cheer(0.5); this.arena.taunt(true); }
  }

  _onKnockdown(e) {
    if (this._scene !== 'match' || this._outro) return;
    const downed = e.downed === 'p2' ? 'p2' : 'p1';
    const by = other(downed);
    if (!this._recorder.pending) this._recorder.markBlow({ attacker: by, defender: downed });
    this.meters.down(downed);
    this.fx.shake(RENDER_TUNING.shake.knockdown, 'all');
    this.arena.cheer(RENDER_TUNING.crowd.knockdown);
    this.arena.flash(1);
    this.arena.taunt(true);
    facingOf(this._slots[downed].yaw, _v2);
    const back = this._isHuman(downed) ? 0.55 : -0.55; // face-down players fall forward
    _v.copy(this._slots[downed].pos).addScaledVector(_v2, back);
    this._schedule('dust', _v.x, _v.z, 1, RENDER_TUNING.dustDelayGame);
    this._exciteBoost = Math.min(0.8, this._exciteBoost + RENDER_TUNING.excitement.knockdown);
  }

  _onCount(e) {
    if (this._scene !== 'match') return;
    const n = Number.isFinite(e.n) ? e.n : 1;
    this.arena.cheer(RENDER_TUNING.crowd.count + 0.04 * n);
  }

  _onGetup(e) {
    if (this._scene !== 'match') return;
    const id = e.downed === 'p2' ? 'p2' : e.downed === 'p1' ? 'p1' : null;
    if (id) this._slots[id].pendingRise = true; // refill sweep once the view shows the new health
    this.arena.cheer(RENDER_TUNING.crowd.getup);
  }

  _onKO(e) {
    if (this._scene !== 'match') return;
    const loser = e.loser === 'p1' || e.loser === 'p2' ? e.loser : e.winner === 'p1' ? 'p2' : e.winner === 'p2' ? 'p1' : null;
    if (loser) this._koLoser = loser;
    this.arena.roar(RENDER_TUNING.crowd.koRoar);
    this.fx.shake(RENDER_TUNING.shake.knockdown, 'all');
    this._exciteBoost = 0.8;
  }

  _onResult(e) {
    if (this._scene !== 'match') return;
    this._result = { winner: e.winner ?? null, method: e.method ?? null };
    if ((e.method === ResultMethod.KO || e.method === ResultMethod.TKO) && !this._koLoser) {
      this._koLoser = e.winner === 'p1' ? 'p2' : e.winner === 'p2' ? 'p1' : null;
    }
    this.arena.cheer(1);
  }

  _onRoundStart() {
    if (this._scene !== 'match') return;
    this.arena.cheer(0.45);
  }

  _onIntro() {
    if (this._scene !== 'match') return;
    this.arena.cheer(0.8);
    this.arena.flash(0.6);
  }

  _onTrainEvent(e) {
    if (this._scene !== 'training') return;
    const type = String(e.type ?? '');
    const hasPos = readVec3(e.pos, _v);
    if (/break|fall|drop/.test(type)) {
      this.arena.cheer(0.7);
      if (hasPos) { this.fx.dust(_v, { size: 0.7 }); this.fx.hit(_v, { power: 0.9 }); }
    } else if (hasPos && /trainer-hit|penalty|foul/.test(type)) {
      this.fx.block(_v, { power: 0.6 });
    } else if (hasPos && /hit|punch|mitt/.test(type)) {
      this.fx.hit(_v, { power: Number.isFinite(e.power) ? e.power : 0.6, scale: 0.85 });
      this.fx.hitStop(this.fx.punchHitStopMs(Number.isFinite(e.power) ? e.power : 0.5, false) * 0.7);
    } else if (hasPos && /dodge|miss|avoid/.test(type)) {
      this.fx.whoosh(_v, 1, 0, { strength: 0.8 });
    }
  }

  _onTrainScore(e) {
    if (this._scene !== 'training') return;
    if ((e.delta ?? 0) >= 50) this.arena.cheer(0.5);
  }

  // ───────────────────────────── internals: the outro ─────────────────────────────

  _fastFromUrl() {
    try { return /(?:^|[?&])fast=(?:1|true)\b/.test(globalThis.location?.search ?? ''); } catch { return false; }
  }

  _fadeOutroMeters() {
    this.meters.setHidden(true);
    for (const rig of this._rigs) rig?.cut();
    this._slow.on = false; this._slow.left = 0;
    this.screen.setSlow('p1', 0); this.screen.setSlow('p2', 0);
    this._applyAspectsSafe();
  }

  /** Emit every stage whose time has come (in order) and react to stage entries. */
  _advanceOutroStages() {
    const o = this._outro;
    if (!o) return;
    const stages = o.plan.stages;
    while (o.stageIdx < stages.length && stages[o.stageIdx].at <= o.t + 1e-9) {
      const st = stages[o.stageIdx++].stage;
      o.stage = st;
      if (st === 'end') { this._finishOutro(); return; }
      this._emitOutro(st);
    }
  }

  _emitOutro(stage) {
    const o = this._outro;
    if (this.bus) this.bus.emit(Ev.RENDER_OUTRO, { stage, winner: o?.winner ?? null, method: o?.method ?? null });
  }

  /** Stop the outro: emit 'end' once, resolve, keep the winner composition on screen. */
  _finishOutro() {
    const o = this._outro;
    if (!o || o.done) return;
    o.done = true;
    if (o.timer && typeof clearTimeout === 'function') clearTimeout(o.timer);
    o.timer = null;
    this.screen.setWipe(0);
    this.screen.setFade(0);
    o.stage = 'end';
    try { if (o.staged !== 'winner') this._stageMoment('winner', true); } catch (e) { this._reportOnce('outro-stage', '[render] outro staging failed', e); }
    if (this.bus) this.bus.emit(Ev.RENDER_OUTRO, { stage: 'end', winner: o.winner, method: o.method });
    try { o.resolve(); } catch { /* nothing to do */ }
  }

  /** Resolve the outro even if the app stops rendering (hidden tab, or a caller that only awaits). */
  _armWatchdog() {
    const o = this._outro;
    if (!o || typeof setTimeout !== 'function') return;
    const tick = () => {
      if (!this._outro || this._outro !== o || o.done) return;
      if (Date.now() - o.wall > RENDER_TUNING.outro.watchdogMs) { this._finishOutro(); return; }
      o.timer = setTimeout(tick, 500);
    };
    o.timer = setTimeout(tick, 500);
  }

  _renderOutro(view, realDt, opts) {
    const o = this._outro;
    const P = o.plan;
    if (!o.done) {
      o.t += realDt;
      o.wall = Date.now();
      this._advanceOutroStages();
    }
    const done = o.done;
    // overlays: logo wipe, the white flash, the white fade
    if (!done && P.wipe) {
      const k = (o.t - P.wipe.at) / P.wipe.dur;
      this.screen.setWipe(k > 0 && k < 1 ? (o.reduced ? 0.5 : k) : 0);
      if (o.reduced && k > 0 && k < 1) this.screen.setFade(Math.sin(k * Math.PI), PALETTE.apron);
    }
    if (!done && !o.flashed && o.t >= P.flashAt) { o.flashed = true; this.fx.screenFlash(0.95, 0xffffff); }
    if (!done && P.fade) {
      const k = (o.t - P.fade.at) / P.fade.dur;
      if (k > 0 && k < 1) this.screen.setFade(Math.sin(k * Math.PI), 0xffffff);
      else if (!(o.reduced && P.wipe && o.t < P.wipe.at + P.wipe.dur)) this.screen.setFade(0);
    }

    const inReplay = !done && P.replay.length > 0 && o.t >= P.replay[0].at && o.t < P.bannerAt;
    let pScale = 1;
    if (inReplay) pScale = this._outroReplay(o, realDt);
    else if (done || o.t >= P.bannerAt) this._outroStaging(o, realDt, done ? 'winner' : o.t >= P.winnerAt ? 'winner' : 'banner');
    else this._outroHoldLive(view, realDt);

    this.fx.update(realDt, pScale);
    this.screen.update(realDt);
    this.meters.setHidden(true);
    this.meters.update(realDt);
    this.arena.update(realDt * pScale, 0.95);
    // a single full-screen view, everybody solid
    const rig = this._rigs[0];
    _shake.x = _shake.y = _shake.roll = 0;
    this._ctx.mode = 'match';
    rig.update(realDt, this._ctx);
    if (opts?.draw === false) return;
    if (this._split === 2) this._applyAspects();
    this._drawSingle(rig, 'p1');
  }

  /** Before the replay (under the wipe): the KO'd scene keeps breathing. */
  _outroHoldLive(view, realDt) {
    for (const id of IDS) {
      const slot = this._slots[id];
      const bv = view.boxers?.[id];
      if (slot.model && bv) {
        slot.model.object3d.position.copy(slot.pos);
        slot.model.object3d.rotation.set(0, slot.yaw, 0);
        this._safeUpdate(slot.model, bv, realDt);
        this._updateAnchors(id, slot, slot.model);
      }
    }
    // keep the current camera
    const rig = this._rigs[0];
    if (!rig.hasOverride) rig.setOverride({ pos: rig.pose.pos.clone(), target: rig.pose.target.clone(), fov: rig.pose.fov, roll: 0 });
  }

  /** The slow-motion multi-angle replay of the final blow. Returns the particle time scale. */
  _outroReplay(o, realDt) {
    const P = o.plan, clip = o.clip, rec = this._recorder;
    let idx = P.replay.length - 1;
    for (let i = 0; i < P.replay.length; i++) if (o.t < P.replay[i].at + P.replay[i].dur) { idx = i; break; }
    const seg = P.replay[idx];
    const first = o.segIdx < 0;
    if (o.segIdx !== idx) { o.segIdx = idx; o.segStart = true; }
    const lt = Math.max(0, o.t - seg.at);
    const blowLocal = seg.from < 0 && seg.to > 0 ? -seg.from / seg.speed : Infinity;
    const hold = P.impactHold;
    let rel, rate;
    if (lt < blowLocal) { rel = seg.from + lt * seg.speed; rate = seg.speed; }
    else if (lt < blowLocal + hold) { rel = 0; rate = 0.02; }
    else { rel = Math.min(seg.to, (blowLocal === Infinity ? seg.from + lt * seg.speed : (lt - blowLocal - hold) * seg.speed)); rate = seg.speed; }
    const tau = clip.blowTau + rel;
    rec.sample(tau, _sample);
    if (!_sample.a) return 1;
    for (const id of IDS) {
      const slot = this._slots[id];
      const s = lerpSnap(this._replaySnap[id], _sample.a.snap[id], _sample.b.snap[id], _sample.t);
      const pa = _sample.a.pos[id], pb = _sample.b.pos[id];
      slot.pos.set(pa[0] + (pb[0] - pa[0]) * _sample.t, pa[1] + (pb[1] - pa[1]) * _sample.t, pa[2] + (pb[2] - pa[2]) * _sample.t);
      slot.anchor.copy(slot.pos); slot.leanOff.set(0, 0, 0);
      slot.yaw = _sample.a.yaw[id];
      if (!slot.model) continue;
      const v = snapToView(this._replayView[id], s, slot.view?.appearance ?? null);
      slot.model.object3d.position.copy(slot.pos);
      slot.model.object3d.rotation.set(0, slot.yaw, 0);
      if (first) { try { slot.model.snapTo?.(v); } catch { /* optional */ } }
      this._safeUpdate(slot.model, v, first ? 0 : realDt * rate);
      this._updateAnchors(id, slot, slot.model);
    }
    // the recorded hits / blocks happen again, in slow motion
    if (o.prevTau === null) o.prevTau = tau - 1e-6;
    if (tau > o.prevTau) {
      for (let i = 0; i < clip.eventCount; i++) {
        const ev = clip.events[i];
        if (ev.tau > o.prevTau && ev.tau <= tau + 1e-6) {
          _v.set(ev.x, ev.y, ev.z);
          if (ev.kind === 'block') this.fx.block(_v, { power: 0.6 });
          else {
            const humanAtt = !!this._slots[ev.attacker]?.view?.isHuman;
            this.fx.hit(_v, { kind: humanAtt ? 'player' : 'taken', power: ev.power, counter: ev.counter, heavy: ev.heavy, scale: ev.knockdown ? 1.5 : 1.15 });
          }
        }
      }
      o.prevTau = tau;
    }
    if (!o.impactShown && rel >= 0 && blowLocal !== Infinity) { o.impactShown = true; this.fx.screenFlash(0.35, 0xffffff); this.arena.cheer(1); }
    // camera for this angle
    this._replayCamera(o, seg, lt / Math.max(0.01, seg.dur));
    return Math.max(0.05, rate);
  }

  _replayCamera(o, seg, k) {
    const pose = (o.pose ??= { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, roll: 0 });
    replayCameraPose(seg.angle, this._slots[o.attacker].pos, this._slots[o.loser].pos, o.reduced ? 0 : smooth(k), pose);
    this._rigs[0].setOverride(pose);
  }

  /** Banner / winner moments: the winner faces the camera, the beaten opponent behind. */
  _outroStaging(o, realDt, moment) {
    if (o.staged !== moment) this._stageMoment(moment, o.staged === null);
    o.stageT = (o.stageT ?? 0) + realDt;
    for (const id of IDS) {
      const slot = this._slots[id];
      if (!slot.model) continue;
      const v = this._staged[id];
      v.phaseProgress = clamp01(o.stageT / 1.5);
      slot.model.object3d.position.copy(slot.pos);
      slot.model.object3d.rotation.set(0, slot.yaw, 0);
      this._safeUpdate(slot.model, v, realDt);
      this._updateAnchors(id, slot, slot.model);
    }
    const k = o.reduced ? 0 : smooth(o.stageT / (moment === 'banner' ? 3.6 : 3.4));
    const pose = (o.pose ??= { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, roll: 0 });
    outroStagePose(moment, o.winner ? this._slots[o.winner].pos : null, k, pose);
    this._rigs[0].setOverride(pose);
  }

  /** Place the boxers for the banner / winner moment and snap them into their poses. */
  _stageMoment(moment, entering) {
    const o = this._outro;
    if (!o) return;
    const O = RENDER_TUNING.outro;
    const w = o.winner, l = w ? other(w) : null;
    o.stageT = 0;
    o.staged = moment;
    for (const id of IDS) {
      const slot = this._slots[id];
      const v = this._staged[id];
      v.id = id;
      v.isHuman = !!slot.view?.isHuman;
      v.appearance = slot.view?.appearance ?? null;
      if (!w) {
        slot.pos.set(id === 'p1' ? -O.drawGap : O.drawGap, 0, 0.2);
        v.phase = BoxerPhase.IDLE; v.expression = 'neutral';
      } else if (id === w) {
        slot.pos.fromArray(O.winnerPos);
        v.phase = BoxerPhase.VICTORY; v.expression = 'happy';
      } else {
        slot.pos.fromArray(O.loserPos);
        v.phase = BoxerPhase.DEFEAT; v.expression = 'sad';
      }
      slot.anchor.copy(slot.pos); slot.leanOff.set(0, 0, 0);
      slot.yaw = id === l ? -0.3 : 0; // face the camera (+Z); the beaten one half-turned toward the winner
      v.phaseProgress = 0;
      if (slot.model) {
        slot.model.object3d.position.copy(slot.pos);
        slot.model.object3d.rotation.set(0, slot.yaw, 0);
        if (entering || moment === 'banner') { try { slot.model.snapTo?.(v); } catch { /* optional */ } }
      }
    }
    if (moment === 'banner') {
      this.fx.clear();
      const c = w ? this._slots[w].pos : _v.set(0, 0, 0.2);
      this.fx.confetti({ x: c.x, y: 0, z: c.z });
      this.fx.streaks({ x: c.x, y: 0, z: c.z });
      this.arena.roar(2.4);
    }
  }
}

/**
 * Camera pose of one KO-replay angle (pure; GameRenderer._replayCamera drives the rig with it).
 * @param {'side'|'low'|'overhead'} angle
 * @param {THREE.Vector3} A  the attacker's root   @param {THREE.Vector3} L  the loser's root
 * @param {number} sw  eased segment progress 0..1 (0 with reduced motion)
 * @param {{pos:THREE.Vector3, target:THREE.Vector3, fov:number, roll:number}} pose  written in place
 */
export function replayCameraPose(angle, A, L, sw, pose) {
  _dir.subVectors(L, A).setY(0);
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
  _dir.normalize();
  _v2.crossVectors(_dir, UP).normalize(); // right of the punch direction
  if (angle === 'side') {
    _v3.lerpVectors(A, L, 0.5);
    pose.pos.copy(_v3).addScaledVector(_v2, 2.35 - 0.4 * sw).addScaledVector(_dir, 0.25 * sw); pose.pos.y = 1.0;
    pose.target.copy(_v3); pose.target.y = 1.0; pose.fov = 40;
  } else if (angle === 'low') {
    // behind the loser but well off the punch line, low (waist height) and aimed at the contact
    // point: the loser sits in the near-left third and the attacker's blow lands on a visible face
    // (VISUAL-02 — straight behind the loser its back hid 50–60 % of the attacker at impact)
    const R = RENDER_TUNING.replayLow;
    pose.pos.copy(L).addScaledVector(_dir, R.back).addScaledVector(_v2, R.side + R.slide * sw); pose.pos.y = R.height;
    pose.target.lerpVectors(A, L, R.aim); pose.target.y = R.lookY; pose.fov = R.fov;
  } else {
    const a = 0.9 * sw;
    _v4.copy(_v2).multiplyScalar(Math.cos(a)).addScaledVector(_dir, Math.sin(a));
    pose.pos.copy(L).addScaledVector(_dir, 0.45).addScaledVector(_v4, 1.05); pose.pos.y = 3.3;
    pose.target.copy(L).addScaledVector(_dir, 0.55); pose.target.y = 0.25; pose.fov = 46;
  }
  pose.roll = 0;
  return pose;
}

/**
 * Camera pose of the outro's banner / winner moment (pure). `W` = the winner's root (null for a
 * draw: both stand around the ring centre); `k` = eased stage progress 0..1.
 */
export function outroStagePose(moment, W, k, pose) {
  const O = RENDER_TUNING.outro;
  const C = moment === 'banner' ? O.bannerCam : O.winnerCam;
  const mx = W ? W.x : 0, mz = W ? W.z : 0.2;
  pose.pos.set(mx + C.pos[0], C.pos[1], mz + C.pos[2] - (moment === 'banner' ? C.push * k : 0));
  pose.pos.x += moment === 'winner' ? -C.drift * k : 0;
  pose.target.set(mx + C.look[0], C.look[1], mz + C.look[2]);
  pose.fov = C.fov; pose.roll = 0;
  return pose;
}

/**
 * A MATCH_HIT that cost no health: damage 0 (the tutorial's no-damage hits) or an hp that did not
 * drop. Such hits keep their bursts and hit-stop but never wake the health meters (Q3).
 * @param {{damage?:number, hpBefore?:number, hpAfter?:number}} e
 */
export function harmless(e) {
  if (e && e.damage === 0) return true;
  return !!e && Number.isFinite(e.hpBefore) && Number.isFinite(e.hpAfter) && e.hpAfter >= e.hpBefore;
}

/** The live punch of one hand from a BoxerView (punches[] first, else the single punch). */
function punchFor(bv, hand) {
  const arr = bv.punches;
  if (Array.isArray(arr)) {
    let best = null;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      if (q && q.hand === hand && (!best || (q.id ?? 0) >= (best.id ?? 0))) best = q;
    }
    return best;
  }
  return bv.punch && bv.punch.hand === hand ? bv.punch : null;
}

/** Stable key for an appearance object (models are rebuilt only when this changes). */
function safeKey(app) {
  try { return JSON.stringify(app); } catch { return String(Math.random()); }
}
