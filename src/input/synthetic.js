// Synthetic player generator: a scripted 3D skeleton (metres) rendered into MediaPipe-like
// PlayerPose data — image landmarks through a pinhole camera and hip-centred world
// landmarks — with the imperfections real pose tracking has (jitter, compressed and noisy
// depth, tracker lag, visibility drops, one-frame glitches, irregular frame timing).
//
// Used by the gesture unit tests, the gesture lab (dev/gesture-lab.html), the e2e test and
// `window.__glove.injectPose` in debug builds. Pure module: runs in Node and the browser.
//
//   const sp = makeSyntheticPlayer({ seed: 7, distance: 2.2, punchMs: 180 });
//   sp.pose(120, 'jab-left')                       // PlayerPose 120 ms into a left jab
//   const seq = sequence([{ action: 'guard-high', ms: 800 }, { action: 'cross', ms: 600 }]);
//   const { frames, truth } = sp.run(seq);          // PoseFrame[] (25–33 fps) + ground truth
//   input.injectFrames(syntheticPoseFrames('hook-right', { seed: 3 }));
//
// Coordinates (see ARCHITECTURE.md §1): image landmarks are normalised [0,1] in the RAW
// (non-mirrored) camera frame, so the person's RIGHT side appears at SMALLER x. World
// landmarks: metres, origin between the hips, axes aligned with the camera — x toward the
// image's right, y DOWN, z AWAY from the camera (smaller z = closer). `mirrorCamera: true`
// simulates a webcam that delivers mirrored frames: x is flipped and, like the real
// tracker, left/right labels come out swapped (calibration detects that).
//
// R5: the defaults are unchanged (the gesture bench's headline). `{preset: 'real-like'}` (SYNTH_PRESETS, withPreset;
// randomPlayerOptions(seed, {preset}) keeps every default draw and varies a few preset values on its own stream) is what
// real MediaPipe VIDEO-mode output measured like: less and correlated jitter, depth ≈ 3–9 mm and not compressed, ≈ 4 ms
// lag, the head and shoulders moving with every punch (punchShiftM, punchYawGain). New knobs, all off by default:
// imageNoiseRho / worldNoiseRho / zNoiseRho (jitter correlation), handLagMs, punchYawGain, punchShiftM, frameDrop2Rate
// (two camera frames dropped in a row). `dip: false` uppercuts from a high guard now drive at least 12 cm up (R1).

import { LM } from '../core/types.js';

// ───────────────────────────── seeded randomness ─────────────────────────────

/** Small fast seeded PRNG → () => [0,1). */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of any mix of numbers/strings (for per-step random streams). */
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e37; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function gauss(rand) {
  let u = 0;
  while (u <= 1e-12) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
const uni = (rand, a, b) => a + (b - a) * rand();

// ───────────────────────────── small vector helpers ─────────────────────────────

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
const lerp = (a, b, s) => a + (b - a) * s;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => clamp(x, 0, 1);
/** Combine basis vectors: r·R + u·U + f·F. */
const inBasis = (B, v) => [
  B.R[0] * v[0] + B.U[0] * v[1] + B.F[0] * v[2],
  B.R[1] * v[0] + B.U[1] * v[1] + B.F[1] * v[2],
  B.R[2] * v[0] + B.U[2] * v[1] + B.F[2] * v[2],
];

/** Minimum-jerk position profile 0→1 (the classic model of a ballistic human reach). */
export function minJerk(tau) {
  const t = clamp01(tau);
  return t * t * t * (10 - 15 * t + 6 * t * t);
}
const quadBezier = (p0, p1, p2, s) => {
  const a = (1 - s) * (1 - s), b = 2 * (1 - s) * s, c = s * s;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1], a * p0[2] + b * p1[2] + c * p2[2]];
};

// ───────────────────────────── options ─────────────────────────────

/** Every knob of the generator. Distances in metres, times in ms. */
export const SYNTH_DEFAULTS = Object.freeze({
  seed: 1,
  /** Noise multiplier: 0 = perfect landmarks (no jitter, lag, drops or glitches), 1 = realistic. */
  noise: 1,
  // ── camera ──
  width: 640,
  height: 480,
  /** Focal length in units of the image width (0.8 ≈ 64° horizontal field of view). */
  focal: 0.8,
  /** Horizontal distance camera → player (m). Play range is about 1.2–3 m. */
  distance: 2.0,
  /** Camera height above the floor (m): ~0.75 laptop on a desk, ~1.8 on top of a TV. */
  cameraHeight: 1.0,
  /** Camera pitch in radians (+ = looking down). null = aimed at the player's chest (+ aimError). */
  cameraTilt: null,
  /** Random aiming error added to the automatic tilt (radians, ±). */
  aimError: 0.05,
  /** Player's sideways offset from the optical axis (m, + = toward the camera's right). */
  lateral: 0,
  /** Simulate a camera that delivers mirrored frames (labels come out swapped). */
  mirrorCamera: false,
  // ── body ──
  bodyHeight: 1.75,
  armScale: 1,
  shoulderScale: 1,
  /** Which glove leads ('left' = orthodox). The game has no stance setting (removed 2026-11-10): punches are read
   *  per hand, and scripted players may still stand with the right hand forward, as real players may. */
  lead: 'left',
  /** Torso rotation in the fighting stance (rad): lead shoulder toward the camera. */
  stanceYaw: 0.22,
  // ── motion style ──
  /** Punch extension time (ms). Real players: ~120 (snappy) … 350 (lazy). */
  punchMs: 200,
  /** Retraction time as a multiple of the extension time (randomised ±20% per punch). */
  retractFactor: 1.5,
  /** Fraction of full arm length reached by straight punches. */
  extension: 0.93,
  /** Idle bounce amplitude multiplier. */
  bounce: 1,
  // ── tracker imperfections (scaled by `noise`) ──
  /** World depth of each landmark relative to the hips is compressed by this factor (MediaPipe underestimates depth motion by 30–50%). */
  zScale: 0.6,
  /** Image landmark jitter σ (normalised units) — grows with wrist speed (motion blur). */
  imageNoise: 0.003,
  /** World landmark jitter σ for x/y (m). */
  worldNoise: 0.015,
  /** World landmark jitter σ for z (m) — depth is much noisier. */
  zNoise: 0.035,
  /** Slow wandering bias of world z (m σ). */
  zBias: 0.02,
  /** Tracker smoothing lag (first-order time constant, ms). */
  lagMs: 18,
  /** Probability per frame per wrist of a one-frame glitch (landmark jumps away and back). */
  glitchRate: 0.004,
  /** Visibility drops per second per arm (wrist/hand go low-visibility and freeze for 2–6 frames). */
  dropRate: 0.08,
  /** Whole-pose dropouts per second (tracker returns no person for 1–2 frames). */
  poseDropRate: 0.02,
  // ── frame timing ──
  fps: 30,
  /** ±fraction of random frame-interval jitter. */
  timingJitter: 0.12,
  /** Probability that a camera frame is skipped (interval doubles). */
  frameDropRate: 0.03,
  /** Probability that two camera frames in a row are skipped (interval triples; a loaded machine). 0 = never. */
  frameDrop2Rate: 0,
  // ── realism knobs (R5; the defaults keep the generator exactly as it was — see SYNTH_PRESETS['real-like']) ──
  /** Per-30-fps-frame correlation of the image / world x-y / world z jitter (AR(1) coefficients). Real MediaPipe
   *  (VIDEO mode) jitter is temporally correlated (lag-1 autocorrelation of the residual ≈ 0.2–0.5). */
  imageNoiseRho: 0.55,
  worldNoiseRho: 0.6,
  zNoiseRho: 0.7,
  /** Extra tracker lag (ms, first order) on the wrist and hand points only (motion blur), on top of lagMs. */
  handLagMs: 0,
  /** Torso rotation of every punch × this (real punches turn the shoulders further: the picture's shoulder
   *  width drops to ≈ 0.7–0.9 of the guard's during a punch, vs ≈ 0.95 with 1). */
  punchYawGain: 1,
  /** Upper-body weight shift (m) at a punch's full extension: toward the camera and across toward the target
   *  line — it moves the head and the shoulders (real punches move the head ≈ 2 SW/s at their peak). */
  punchShiftM: 0,
});

/**
 * Named option sets for makeSyntheticPlayer / randomPlayerOptions ({preset: name}; explicit options win).
 * 'real-like' (R5) matches what real MediaPipe (tasks-vision 1.1.1, VIDEO mode, full model) gives on four real clips
 * (dev/clips/facecam-boxing.mp4 and three public shadowboxing clips at 2–4 m; see the R5 notes in the bench header):
 * per-frame image jitter ≈ 0.003–0.009 SW on still joints (second difference; the default ≈ 0.018), still joints' world
 * depth |Δz| median ≈ 2–10 mm (default ≈ 20), jitter lag-1 autocorrelation ≈ 0.2–0.5 (default ≈ 0), depth NOT
 * compressed (the recognizer's bone-length estimate kz ≈ 1.04–1.25; default zScale 0.5–0.7), hand lag ≈ 2–4 ms behind
 * an independent track of the fist (default 18), wrist drop-outs only when the hand leaves the picture, and much more
 * body in every punch: head speed at the punch's peak p50 ≈ 1.3–2.3 SW/s (59–73 % above 1.8 on two of the clips;
 * default p50 ≈ 0.95, 11 %), the shoulders' picture width down to p50 ≈ 0.67–0.89 of the second before (13–59 % below
 * 0.72; default 0.95, 0 %).
 */
export const SYNTH_PRESETS = Object.freeze({
  'real-like': Object.freeze({
    imageNoise: 0.0016,
    imageNoiseRho: 0.88,
    worldNoise: 0.006,
    worldNoiseRho: 0.85,
    zNoise: 0.014,
    zNoiseRho: 0.85,
    zBias: 0.01,
    zScale: 1.05,
    lagMs: 4,
    dropRate: 0.02,
    glitchRate: 0.002,
    poseDropRate: 0.01,
    punchYawGain: 3,
    punchShiftM: 0.1,
  }),
});

/** Options with a preset applied ({preset:'real-like', …}): the preset's values, then the explicit ones. */
export function withPreset(opts = {}) {
  const pr = opts && opts.preset ? SYNTH_PRESETS[opts.preset] : null;
  if (opts && opts.preset && !pr) throw new Error(`synthetic: unknown preset "${opts.preset}"`);
  if (!pr) return opts;
  const { preset, ...rest } = opts;
  return { ...pr, ...rest, preset };
}

/** Actions understood by pose()/sequence(). */
export const SYNTH_ACTIONS = Object.freeze([
  'idle', 'guard-high', 'guard-low', 'arms-down', 'pause',
  'jab', 'cross', 'jab-left', 'jab-right', 'hook-left', 'hook-right', 'uppercut-left', 'uppercut-right',
  'body-left', 'body-right',
  'lean-left', 'lean-right', 'duck', 'lean-forward', 'lean-back', 'twist-left', 'twist-right',
  'wave', 'scratch-face', 'adjust-glasses', 'reach-slow', 'point', 'raise-hand', 'pull-back', 'walk-away',
]);

/** Punch actions → what they are. 'lead'/'rear' resolve from the lead hand. */
const PUNCHES = {
  jab: { hand: 'lead', kind: 'straight', target: 'head', twist: 0.07 },
  cross: { hand: 'rear', kind: 'straight', target: 'head', twist: 0.28 },
  'jab-left': { hand: 'left', kind: 'straight', target: 'head', twist: 0.1 },
  'jab-right': { hand: 'right', kind: 'straight', target: 'head', twist: 0.1 },
  'hook-left': { hand: 'left', kind: 'hook', target: 'head', twist: 0.32 },
  'hook-right': { hand: 'right', kind: 'hook', target: 'head', twist: 0.32 },
  'uppercut-left': { hand: 'left', kind: 'uppercut', target: 'head', twist: 0.14 },
  'uppercut-right': { hand: 'right', kind: 'uppercut', target: 'head', twist: 0.14 },
  'body-left': { hand: 'left', kind: 'straight', target: 'body', twist: 0.16 },
  'body-right': { hand: 'right', kind: 'straight', target: 'body', twist: 0.16 },
};
/** One-arm gestures that are NOT punches. */
const GESTURES = { wave: 1, 'scratch-face': 1, 'adjust-glasses': 1, 'reach-slow': 1, point: 1, 'raise-hand': 1, 'pull-back': 1 };
/** Actions that set the arm posture of both hands (and stand the body upright). */
const ARM_POSTURES = { idle: 'stance', 'guard-high': 'guard-high', 'guard-low': 'guard-low', 'arms-down': 'down', pause: 'pause', 'walk-away': 'walk' };
/** Actions that set the body posture. */
const BODY_POSTURES = {
  idle: 'upright', 'guard-high': 'upright', 'guard-low': 'upright', 'arms-down': 'upright', pause: 'upright',
  'lean-left': 'lean-left', 'lean-right': 'lean-right', duck: 'duck', 'lean-forward': 'lean-forward', 'lean-back': 'lean-back',
  'twist-left': 'twist-left', 'twist-right': 'twist-right',
  'walk-away': 'walk',
};

const DEFAULT_MS = {
  idle: 1500, 'guard-high': 1500, 'guard-low': 1500, 'arms-down': 1200, pause: 2000,
  'lean-left': 1200, 'lean-right': 1200, duck: 1200, 'lean-forward': 1200, 'lean-back': 1200, 'twist-left': 1200, 'twist-right': 1200,
  wave: 3000, 'scratch-face': 2400, 'adjust-glasses': 1500, 'reach-slow': 3200, point: 3000, 'walk-away': 3000,
  'raise-hand': 1800, 'pull-back': 2600,
};

// ───────────────────────────── scripts ─────────────────────────────

/**
 * @typedef {Object} SynthStep
 * @property {string} action   one of SYNTH_ACTIONS
 * @property {number} [ms]     how long this step lasts (punch motions may run past it; the next step starts anyway)
 * @property {'left'|'right'} [hand]   hand for gestures (default right)
 * @property {number} [speedMs]       punch extension time override
 * @property {number} [extension]     punch extension override (fraction of arm length)
 * @property {number} [amount]        lean/duck amount multiplier (default 1)
 * @property {'high'|'face'} [height] wave height (default high)
 * @property {-1|1} [dir]             walk-away direction (+1 = toward the camera's right)
 * @property {boolean} [dip]          uppercuts: false = driven straight up without the scoop (default true)
 */

/**
 * Build a timed script from steps. Steps run back to back; a punch's retraction keeps going
 * after its step ends (so short steps make overlapping combos, like real ones).
 * @param {Array<SynthStep|string>} steps
 * @returns {{type:'sequence', steps:Array<SynthStep & {start:number, end:number, index:number}>, totalMs:number}}
 */
export function sequence(steps) {
  let t = 0;
  const out = [];
  for (const raw of steps) {
    const s = typeof raw === 'string' ? { action: raw } : { ...raw };
    if (!SYNTH_ACTIONS.includes(s.action)) throw new Error(`synthetic: unknown action "${s.action}"`);
    const ms = s.ms ?? DEFAULT_MS[s.action] ?? 700;
    out.push({ ...s, ms, start: t, end: t + ms, index: out.length });
    t += ms;
  }
  return { type: 'sequence', steps: out, totalMs: t };
}

function toScript(action) {
  if (action && action.type === 'sequence') return action;
  if (Array.isArray(action)) return sequence(action);
  if (typeof action === 'string') return sequence([{ action, ms: Infinity }]);
  if (action && action.action) return sequence([{ ...action, ms: action.ms ?? Infinity }]);
  throw new Error('synthetic: action must be a name, a step, an array of steps or a sequence()');
}

// ───────────────────────────── the player ─────────────────────────────

/**
 * Random-but-plausible player/camera parameters for test matrices and the lab.
 * Rejects configurations where the fighting stance would not fit in the picture (the
 * calibration screen would ask the player to step back in that case).
 * @param {number} seed
 * @param {Partial<typeof SYNTH_DEFAULTS>} [overrides]
 */
export function randomPlayerOptions(seed, overrides = {}) {
  const rand = mulberry32(hashSeed('player', seed));
  // a preset (overrides.preset): its values replace the defaults; a few of them vary per player on a separate random
  // stream (so the players' other draws stay exactly those of the default bench)
  const pre = overrides && overrides.preset ? withPreset({ preset: overrides.preset }) : null;
  const prand = pre ? mulberry32(hashSeed('preset', overrides.preset, seed)) : null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const o = {
      seed: hashSeed('p', seed, attempt),
      distance: uni(rand, 1.2, 3.0),
      cameraHeight: uni(rand, 0.6, 1.9),
      focal: uni(rand, 0.62, 1.05),
      bodyHeight: uni(rand, 1.5, 1.95),
      armScale: uni(rand, 0.92, 1.08),
      shoulderScale: uni(rand, 0.88, 1.12),
      lead: rand() < 0.7 ? 'left' : 'right', // the same draw as the former stance option: same players per seed
      stanceYaw: uni(rand, 0.06, 0.4),
      lateral: uni(rand, -0.25, 0.25),
      punchMs: uni(rand, 120, 350),
      retractFactor: uni(rand, 1.2, 1.9),
      extension: uni(rand, 0.86, 0.97),
      zScale: uni(rand, 0.5, 0.7),
      fps: uni(rand, 25, 33),
      ...(pre ? {
        ...pre,
        zScale: pre.zScale * uni(prand, 0.9, 1.15),
        zNoise: pre.zNoise * uni(prand, 0.6, 1.4),
        imageNoise: pre.imageNoise * uni(prand, 0.7, 1.4),
        punchYawGain: pre.punchYawGain * uni(prand, 0.7, 1.3),
        punchShiftM: pre.punchShiftM * uni(prand, 0.5, 1.5),
      } : {}),
      ...overrides,
    };
    if (fitsInFrame(o)) return o;
  }
  return { seed, ...(pre || {}), ...overrides };
}

/** True when head, shoulders, elbows and wrists of the guard stance land inside the picture. */
export function fitsInFrame(opts) {
  const sp = makeSyntheticPlayer({ ...opts, noise: 0 });
  for (const action of ['idle', 'guard-high']) {
    const p = sp.pose(1200, action);
    if (!p) return false;
    for (const i of [LM.NOSE, LM.LEFT_EYE, LM.RIGHT_EYE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW,
      LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST]) {
      const l = p.image[i];
      if (l.x < 0.04 || l.x > 0.96 || l.y < 0.04 || l.y > 0.96) return false;
    }
  }
  return true;
}

/**
 * Create a synthetic player.
 * @param {Partial<typeof SYNTH_DEFAULTS>} [opts]
 */
export function makeSyntheticPlayer(opts = {}) {
  const P = { ...SYNTH_DEFAULTS, ...withPreset(opts) };
  const noise = Math.max(0, Number(P.noise) || 0);
  const k = P.bodyHeight / 1.75;                      // body scale
  const B = {
    k,
    L1: 0.300 * k * P.armScale,                       // upper arm
    L2: 0.255 * k * P.armScale,                       // forearm (elbow → wrist)
    SW: 0.37 * k * P.shoulderScale,                   // shoulder landmark distance
    hipW: 0.21 * k,
    torso: 0.50 * k,                                  // hip centre → shoulder centre
    hipH: 0.92 * k,                                   // hip joint height
    head: 0.175 * k,                                  // shoulder centre → head centre
    thigh: 0.43 * k, shin: 0.43 * k,
  };
  B.arm = B.L1 + B.L2;
  const leadHand = P.lead === 'right' ? 'right' : 'left';
  const stanceYaw = (leadHand === 'right' ? -1 : 1) * P.stanceYaw;
  const playerRand = mulberry32(hashSeed('player-static', P.seed));
  // per-player constants (deterministic)
  const phases = Array.from({ length: 12 }, () => uni(playerRand, 0, Math.PI * 2));
  const visBase = Array.from({ length: 33 }, (_, i) => (i >= 17 && i <= 22 ? uni(playerRand, 0.72, 0.9)
    : i <= 10 ? uni(playerRand, 0.95, 0.995) : uni(playerRand, 0.9, 0.99)));
  const worldScaleBias = noise > 0 ? uni(playerRand, 0.93, 1.07) : 1;
  const chestH = 0.73 * P.bodyHeight;
  const tilt = P.cameraTilt != null ? P.cameraTilt
    : Math.atan2(P.cameraHeight - chestH, P.distance) + (noise > 0 ? uni(playerRand, -1, 1) * P.aimError : 0);
  const cT = Math.cos(tilt), sT = Math.sin(tilt);
  const fpx = P.focal * P.width;

  /** Room (camera-untilted, x right, y down, z away) → camera frame. */
  const toCam = (p) => [p[0], cT * p[1] - sT * p[2], sT * p[1] + cT * p[2]];

  // ── per-step random parameters (deterministic per seed+step so truth() matches pose()) ──
  const stepCache = new Map();
  function stepParams(step) {
    const key = step.index;
    if (stepCache.has(key)) return stepCache.get(key);
    const r = mulberry32(hashSeed(P.seed, 'step', step.index, step.action));
    const sp = {
      T: step.speedMs ?? P.punchMs * uni(r, 0.85, 1.15),
      hold: uni(r, 25, 60),
      retract: (step.speedMs ?? P.punchMs) * P.retractFactor * uni(r, 0.8, 1.2),
      ext: step.extension ?? clamp(P.extension + uni(r, -0.03, 0.03), 0.7, 0.99),
      aimU: uni(r, -0.04, 0.05),
      aimR: uni(r, -0.03, 0.03),
      trans: uni(r, 180, 280),
      amount: (step.amount ?? 1) * uni(r, 0.85, 1.15),
      gestureIn: uni(r, 0.85, 1.15),
      waveHz: uni(r, 1.6, 2.4),
      dir: step.dir ?? (r() < 0.5 ? -1 : 1),
    };
    stepCache.set(key, sp);
    return sp;
  }

  const resolveHand = (h) => (h === 'lead' ? leadHand : h === 'rear' ? (leadHand === 'left' ? 'right' : 'left') : h);

  // ── arm postures (offsets from the arm's own shoulder in the hands frame: r=person's right, u=up, f=toward camera) ──
  function postureArm(name, hand, t, tLocal = t) {
    const s = hand === 'right' ? 1 : -1;
    const lead = hand === leadHand;
    const ph = phases[hand === 'right' ? 0 : 1];
    const drift = [0.012 * Math.sin(t / 1000 * 1.1 + ph), 0.012 * Math.sin(t / 1000 * 1.7 + ph * 2), 0.01 * Math.sin(t / 1000 * 0.9 + ph * 3)];
    let pos, pole;
    switch (name) {
      case 'guard-high': pos = [-s * 0.11, 0.12, 0.19]; pole = [s * 0.3, -1, 0.3]; break;
      case 'guard-low': pos = [-s * 0.10, -0.30, 0.22]; pole = [s * 0.45, -1, -0.4]; break;
      case 'pause': pos = [s * 0.06, 0.50, 0.05]; pole = [s * 1, 0, -0.3]; break;
      case 'down': pos = [s * 0.03, -0.53, 0.04]; pole = [s * 0.2, 0, -1]; break;
      case 'walk': {
        const sw = Math.sin(tLocal / 1000 * 2 * Math.PI * 0.9 + (s > 0 ? Math.PI : 0));
        pos = [s * 0.04, -0.52, 0.04 + 0.13 * sw]; pole = [0, 0.2, -1]; break;
      }
      case 'stance':
      default:
        pos = lead ? [-s * 0.10, -0.03, 0.27] : [-s * 0.08, -0.07, 0.18];
        pole = [s * 0.35, -1, -0.15];
    }
    return { pos: add(mul(pos, k), name === 'down' || name === 'walk' || name === 'pause' ? [0, 0, 0] : drift), pole };
  }

  // ── body postures ──
  function postureBody(name, t, sp) {
    const st = { roll: 0, pitch: 0.05, yaw: stanceYaw, drop: 0, shiftR: 0, shiftF: 0, walkX: 0, bounce: 1, walkYaw: 0, headFollow: 0 };
    const a = sp ? sp.amount : 1;
    switch (name) {
      case 'lean-left': st.roll = -0.30 * a; st.shiftR = 0.03 * a; st.bounce = 0.3; break;
      case 'lean-right': st.roll = 0.30 * a; st.shiftR = -0.03 * a; st.bounce = 0.3; break;
      case 'duck': st.drop = 0.20 * a * k; st.pitch = 0.40 * a; st.bounce = 0.2; break;
      case 'lean-forward': st.pitch = 0.30 * a; st.shiftF = 0.04; st.bounce = 0.3; break;
      case 'lean-back': st.pitch = -0.17 * a; st.shiftF = -0.05; st.bounce = 0.3; break;
      // torso turned without punching (chest toward the player's left / right): the shoulders
      // narrow in the picture like a back lean, the head stays where it was
      case 'twist-left': st.yaw = stanceYaw - 0.45 * a; st.bounce = 0.5; break;
      case 'twist-right': st.yaw = stanceYaw + 0.45 * a; st.bounce = 0.5; break;
      case 'walk': {
        const dir = sp ? sp.dir : 1;
        st.walkYaw = -dir * 1.35 * minJerk(t / 600);
        st.walkX = dir * 2.4 * minJerk((t - 300) / 1800);
        st.bounce = 2.2; st.headFollow = 1;
        break;
      }
      default: break;
    }
    return st;
  }

  // ── punch / gesture trajectories ──
  /** Natural duration of a temporary arm motion. */
  function tempDuration(step) {
    const sp = stepParams(step);
    if (PUNCHES[step.action]) return sp.T + sp.hold + sp.retract;
    if (Number.isFinite(step.ms)) return step.ms;
    return DEFAULT_MS[step.action] ?? 2000;
  }

  function punchTarget(step, hand, sp, start = null) {
    const def = PUNCHES[step.action];
    const s = hand === 'right' ? 1 : -1;
    if (def.kind === 'hook') {
      return { end: mul([-s * (0.24 + sp.aimR), 0.04 + sp.aimU * 0.5, 0.32], k), ctrl: mul([s * 0.20, -0.02, 0.24], k), pole: [s * 1, 0.02, -0.3] };
    }
    if (def.kind === 'uppercut') {
      // `dip: false` = a lazy uppercut driven straight up from where the fist is (no scoop). From a high guard (the fist
      // already at the cheek) it still drives UP to about face height — at least 12 cm above where it started (R1: before,
      // it ended 2 cm below the guard, a 12 cm forward push nobody could call an uppercut); from lower starts as before
      const ctrl = step.dip === false ? null : mul([-s * 0.03, -0.36, 0.10], k);
      const end = mul([-s * (0.11 + sp.aimR), 0.10 + sp.aimU * 0.5, 0.30], k);
      if (step.dip === false && start && start.pos[1] + 0.12 * k > 0.10 * k) end[1] = start.pos[1] + 0.12 * k + sp.aimU * 0.5 * k;
      return { end, ctrl, pole: [s * 0.3, -1, -0.5] };
    }
    const dir = def.target === 'body'
      ? norm([-s * (0.15 + sp.aimR), -0.30 + sp.aimU, 0.42])
      : norm([-s * (B.SW / 2 + sp.aimR), 0.08 + sp.aimU, 0.5]);
    const end = mul(dir, B.arm * sp.ext * (def.target === 'body' ? 0.97 : 1));
    return { end, ctrl: null, pole: [s * 0.5, -1, -0.2] };
  }

  /** Temporary motion state at local time lt (start = arm state when the step began, post = posture now). */
  function evalTemp(step, hand, lt, start, post) {
    const sp = stepParams(step);
    const s = hand === 'right' ? 1 : -1;
    if (PUNCHES[step.action]) {
      const tg = punchTarget(step, hand, sp, start);
      const ctrl = tg.ctrl || add(lerp3(start.pos, tg.end, 0.5), [0, PUNCHES[step.action].target === 'body' ? -0.02 * k : 0.03 * k, 0]);
      if (lt < sp.T) {
        const u = minJerk(lt / sp.T);
        return { pos: quadBezier(start.pos, ctrl, tg.end, u), pole: lerp3(start.pole, tg.pole, minJerk(lt / (0.4 * sp.T))) };
      }
      if (lt < sp.T + sp.hold) return { pos: tg.end, pole: tg.pole };
      const u = minJerk((lt - sp.T - sp.hold) / sp.retract);
      return { pos: lerp3(tg.end, post.pos, u), pole: lerp3(tg.pole, post.pole, u) };
    }
    const total = tempDuration(step);
    const back = 450 * sp.gestureIn;
    const outU = lt > total - back ? 1 - minJerk((lt - (total - back)) / back) : 1;
    let target, pole, inMs;
    switch (step.action) {
      case 'wave': {
        const high = step.height !== 'face';
        inMs = 380 * sp.gestureIn;
        const osc = Math.sin((lt - inMs) / 1000 * 2 * Math.PI * sp.waveHz) * (lt > inMs ? 1 : 0);
        target = high ? [s * (0.16 + 0.14 * osc), 0.43, 0.10] : [s * (0.10 + 0.11 * osc), 0.20, 0.16];
        target = mul(target, k);
        pole = high ? [s * 1, -0.3, -0.2] : [s * 0.7, -1, 0];
        break;
      }
      case 'scratch-face': {
        inMs = 520 * sp.gestureIn;
        const sc = lt > inMs ? Math.sin((lt - inMs) / 1000 * 2 * Math.PI * 3.5) : 0;
        target = mul([-s * 0.12 + 0.012 * sc, 0.17 + 0.012 * sc, 0.10], k);
        pole = [s * 0.5, -1, 0.1];
        break;
      }
      case 'adjust-glasses':
        inMs = 330 * sp.gestureIn;
        target = mul([-s * (B.SW / 2 / k), 0.21, 0.09], k);
        pole = [s * 0.4, -1, 0.2];
        break;
      case 'reach-slow':
        inMs = 1300 * sp.gestureIn;
        target = mul([-s * 0.05, -0.25, 0.47], k);
        pole = [s * 0.4, -1, -0.3];
        break;
      case 'raise-hand':
        // calibration: one arm straight up above the head
        inMs = 450 * sp.gestureIn;
        target = [s * 0.04 * k, B.arm * 0.97, 0.03 * k];
        pole = [s * 1, 0, -0.3];
        break;
      case 'pull-back': {
        // arm eased out to a punch-like extension (slowly, ~1 s), held, then yanked back fast:
        // the fast return must never count as a punch
        const outMs = 1000 * sp.gestureIn, holdMs = 500;
        const backMs = Math.max(120, (step.speedMs ?? P.punchMs) * 0.9);
        const ext = mul(norm([-s * (B.SW / 2), 0.06, 0.5]), B.arm * 0.92);
        if (lt < outMs) { const u = minJerk(lt / outMs); return { pos: lerp3(start.pos, ext, u), pole: lerp3(start.pole, [s * 0.5, -1, -0.2], u) }; }
        if (lt < outMs + holdMs) return { pos: ext, pole: [s * 0.5, -1, -0.2] };
        const u = minJerk((lt - outMs - holdMs) / backMs);
        return { pos: lerp3(ext, post.pos, u), pole: lerp3([s * 0.5, -1, -0.2], post.pole, u) };
      }
      case 'point':
      default: {
        // a deliberate one-handed point at the screen (the move of the removed menu hand pointer, kept as a
        // false-punch test move): the hand goes up high first, holds there a moment, then comes down to aim
        // at the screen and wanders a little; the free arm hangs down meanwhile (pointFreeArm).
        // (slow, mostly vertical moves: neither the raise nor the reach reads as an uppercut or a straight)
        const upMs = 1000 * sp.gestureIn, topMs = upMs + 150, downMs = 700 * sp.gestureIn, aimMs = topMs + downMs;
        const up = mul([s * 0.10, 0.38, 0.22], k), upPole = [s * 1, -0.3, -0.2];
        const w = lt > aimMs ? (lt - aimMs) / 1000 : 0;
        const amp = Math.min(1, w / 1.5); // held steady on the target at first, then it wanders a little
        // (aimed a little below shoulder height, at the middle of the screen)
        const aim = mul([-s * 0.08 + amp * 0.04 * Math.sin(w * 2.4), -0.035 + amp * 0.03 * Math.sin(w * 4.8), 0.44], k);
        const aimPole = [s * 0.4, -1, -0.2];
        let act;
        if (lt < upMs) { const u = minJerk(lt / upMs); act = { pos: lerp3(start.pos, up, u), pole: lerp3(start.pole, upPole, u) }; }
        else if (lt < topMs) act = { pos: up, pole: upPole };
        else { const u = minJerk((lt - topMs) / downMs); act = { pos: lerp3(up, aim, u), pole: lerp3(upPole, aimPole, u) }; }
        return { pos: lerp3(post.pos, act.pos, outU), pole: lerp3(post.pole, act.pole, outU) };
      }
    }
    const inU = minJerk(lt / inMs);
    const active = { pos: lerp3(start.pos, target, inU), pole: lerp3(start.pole, pole, inU) };
    return { pos: lerp3(post.pos, active.pos, outU), pole: lerp3(post.pole, active.pole, outU) };
  }

  // ── script evaluation (per-channel, memoised step-start states) ──
  function makeEvaluator(script) {
    const steps = script.steps;
    const memoArm = new Map();
    const memoBody = new Map();
    const armPostureStep = (t) => { for (let i = steps.length - 1; i >= 0; i--) if (steps[i].start <= t && ARM_POSTURES[steps[i].action]) return i; return -1; };
    const bodyStep = (t) => { for (let i = steps.length - 1; i >= 0; i--) if (steps[i].start <= t && BODY_POSTURES[steps[i].action]) return i; return -1; };

    function armPosture(hand, t) {
      const i = armPostureStep(t);
      if (i < 0) return postureArm('stance', hand, t);
      const st = steps[i];
      const target = postureArm(ARM_POSTURES[st.action], hand, t, t - st.start);
      const sp = stepParams(st);
      const lt = t - st.start;
      if (lt >= sp.trans || i === 0 && st.start === 0) return target;
      const key = `${hand}:${i}`;
      let from = memoArm.get(key);
      if (!from) { from = armPosture(hand, st.start - 1e-3); memoArm.set(key, from); }
      const u = minJerk(lt / sp.trans);
      return { pos: lerp3(from.pos, target.pos, u), pole: lerp3(from.pole, target.pole, u) };
    }

    function tempStepFor(hand, t, before = Infinity) {
      for (let i = steps.length - 1; i >= 0; i--) {
        const st = steps[i];
        if (st.start > t || i >= before) continue;
        let h = null;
        // (posture steps do not cut a motion short: its return phase blends into the new posture)
        if (PUNCHES[st.action]) h = resolveHand(PUNCHES[st.action].hand);
        else if (GESTURES[st.action]) h = st.hand || 'right';
        if (h !== hand) continue;
        if (t - st.start < tempDuration(st)) return i;
        return null;
      }
      return null;
    }

    // 'point': while one hand points, the free arm hangs down (it blends in and out with the point)
    function pointFreeArm(hand, t, post) {
      const i = tempStepFor(hand === 'right' ? 'left' : 'right', t);
      if (i === null || steps[i].action !== 'point') return post;
      const st = steps[i], sp = stepParams(st), lt = t - st.start, total = tempDuration(st);
      const back = 900 * sp.gestureIn; // an unhurried way back up into the posture (not a punch)
      const u = Math.min(minJerk(lt / (400 * sp.gestureIn)), lt > total - back ? 1 - minJerk((lt - (total - back)) / back) : 1);
      if (!(u > 0)) return post;
      const down = postureArm('down', hand, t);
      return { pos: lerp3(post.pos, down.pos, u), pole: lerp3(post.pole, down.pole, u) };
    }

    function arm(hand, t, before = Infinity) {
      const post = pointFreeArm(hand, t, armPosture(hand, t));
      const i = tempStepFor(hand, t, before);
      if (i === null) return post;
      const st = steps[i];
      const key = `${hand}:t${i}`;
      let start = memoArm.get(key);
      if (!start) { start = arm(hand, st.start, i); memoArm.set(key, start); }
      return evalTemp(st, hand, t - st.start, start, post);
    }

    function body(t) {
      const i = bodyStep(t);
      const st = i >= 0 ? steps[i] : null;
      const sp = st ? stepParams(st) : null;
      const target = postureBody(st ? BODY_POSTURES[st.action] : 'upright', st ? t - st.start : t, sp);
      let out = target;
      if (st && !(i === 0 && st.start === 0) && t - st.start < sp.trans) {
        const key = `b${i}`;
        let from = memoBody.get(key);
        if (!from) { from = body(st.start - 1e-3); memoBody.set(key, from); }
        const u = minJerk((t - st.start) / sp.trans);
        out = {};
        for (const kk of Object.keys(target)) out[kk] = lerp(from[kk], target[kk], u);
        out.walkX = target.walkX; out.walkYaw = target.walkYaw; out.headFollow = target.headFollow;
      }
      // punches twist the torso / dip the knees (additive) — and with punchShiftM shift the upper body's weight
      // toward the camera and across toward the target line (real punches carry the head along)
      let yawAdd = 0, dropAdd = 0, shiftRAdd = 0, shiftFAdd = 0;
      for (const ps of steps) {
        const def = PUNCHES[ps.action];
        if (!def || ps.start > t) continue;
        const sp2 = stepParams(ps);
        const lt = t - ps.start;
        const dur = sp2.T + sp2.hold + sp2.retract;
        if (lt > dur) continue;
        const bump = lt < sp2.T ? minJerk(lt / sp2.T) : lt < sp2.T + sp2.hold ? 1 : 1 - minJerk((lt - sp2.T - sp2.hold) / sp2.retract);
        const s = resolveHand(def.hand) === 'right' ? 1 : -1;
        yawAdd += -s * def.twist * P.punchYawGain * bump;
        if (P.punchShiftM) {
          // (a rear-hand punch or a hook shifts across more; a jab mostly forward). The hips carry 40 % of the shift,
          // the head moves the whole of it (it leans over the punch): the shoulders move less than the head
          const across = def.kind === 'hook' ? 0.8 : resolveHand(def.hand) === leadHand ? 0.3 : 0.6;
          shiftFAdd += P.punchShiftM * k * bump;
          shiftRAdd += -s * across * P.punchShiftM * k * bump;
        }
        if (def.kind === 'uppercut') dropAdd += 0.04 * k * Math.sin(Math.PI * clamp01(lt / (sp2.T * 0.7))) * (lt < sp2.T ? 1 : 0) - 0.015 * k * bump;
        if (def.target === 'body') dropAdd += 0.035 * k * bump;
      }
      if (shiftRAdd || shiftFAdd) {
        return { ...out, yaw: out.yaw + yawAdd, drop: out.drop + dropAdd, shiftR: out.shiftR + 0.4 * shiftRAdd, shiftF: out.shiftF + 0.4 * shiftFAdd,
          headR: 0.6 * shiftRAdd, headF: 0.6 * shiftFAdd };
      }
      return { ...out, yaw: out.yaw + yawAdd, drop: out.drop + dropAdd };
    }
    return { arm, body, steps };
  }

  // ── kinematics: 33 landmarks in room coordinates ──
  const R0 = [-1, 0, 0], U0 = [0, -1, 0], F0 = [0, 0, -1];
  /** Basis after yaw (left shoulder forward for +yaw), pitch (bend toward camera) and roll (toward person's right). */
  function basis(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let R = sub(mul(R0, cy), mul(F0, sy));
    let F = add(mul(F0, cy), mul(R0, sy));
    let U = U0;
    const cp = Math.cos(pitch), spp = Math.sin(pitch);
    const U1 = add(mul(U, cp), mul(F, spp));
    F = sub(mul(F, cp), mul(U, spp));
    U = U1;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const U2 = add(mul(U, cr), mul(R, sr));
    R = sub(mul(R, cr), mul(U, sr));
    return { R, U: U2, F };
  }

  function solveElbow(S, W, pole) {
    let d = sub(W, S);
    let dist = len(d);
    const n = dist > 1e-6 ? mul(d, 1 / dist) : [0, -1, 0];
    dist = clamp(dist, Math.abs(B.L1 - B.L2) + 0.02, (B.L1 + B.L2) * 0.997);
    const Wc = add(S, mul(n, dist));
    const a = (B.L1 * B.L1 - B.L2 * B.L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, B.L1 * B.L1 - a * a));
    let p = sub(pole, mul(n, dot(pole, n)));
    if (len(p) < 1e-4) p = Math.abs(n[1]) < 0.9 ? sub([0, 1, 0], mul(n, n[1])) : sub([1, 0, 0], mul(n, n[0]));
    p = norm(p);
    return { E: add(add(S, mul(n, a)), mul(p, h)), W: Wc };
  }

  function joints(ev, t) {
    const bd = ev.body(t);
    const bounceAmp = 0.012 * k * P.bounce * bd.bounce;
    const bob = bounceAmp * Math.sin(t / 1000 * 2 * Math.PI * 1.8 + phases[2]);
    const sway = 0.015 * k * P.bounce * Math.min(1, bd.bounce) * Math.sin(t / 1000 * 2 * Math.PI * 0.45 + phases[3]);
    const yawT = bd.yaw + bd.walkYaw;
    const Bt = basis(yawT, bd.pitch, bd.roll);                 // torso
    const Bh = basis(bd.walkYaw, bd.pitch * 0.85, bd.roll * 0.85); // hands frame: punches aim at the camera
    const Bhip = basis(bd.yaw * 0.5 + bd.walkYaw, 0, 0);
    const floorY = P.cameraHeight;
    const hip = add(add([P.lateral + bd.walkX, floorY - B.hipH + bd.drop - bob, P.distance], mul(R0, bd.shiftR + sway)), mul(F0, bd.shiftF));
    const sc = add(hip, mul(Bt.U, B.torso));
    const rSh = add(sc, mul(Bt.R, B.SW / 2));
    const lSh = sub(sc, mul(Bt.R, B.SW / 2));
    const rHip = add(hip, mul(Bhip.R, B.hipW / 2));
    const lHip = sub(hip, mul(Bhip.R, B.hipW / 2));
    // head looks at the camera (compensates torso yaw/roll) unless walking away
    const headYaw = yawT * (bd.headFollow ? 0.9 : 0.15) + 0.03 * Math.sin(t / 1000 * 0.7 + phases[4]);
    const Bhd = basis(headYaw, bd.pitch * 0.45 + 0.02 * Math.sin(t / 1000 * 0.5 + phases[5]), bd.roll * 0.6);
    let hc = add(add(sc, mul(Bt.U, B.head)), mul(Bt.F, 0.01 * k));
    if (bd.headR || bd.headF) hc = add(add(hc, mul(R0, bd.headR || 0)), mul(F0, bd.headF || 0));   // punchShiftM: the head leans over the punch
    const H = (r, u, f) => add(hc, inBasis(Bhd, [r * k, u * k, f * k]));
    const pts = new Array(33);
    pts[LM.NOSE] = H(0, -0.005, 0.105);
    pts[LM.LEFT_EYE_INNER] = H(-0.016, 0.03, 0.088);
    pts[LM.LEFT_EYE] = H(-0.033, 0.031, 0.083);
    pts[LM.LEFT_EYE_OUTER] = H(-0.048, 0.03, 0.074);
    pts[LM.RIGHT_EYE_INNER] = H(0.016, 0.03, 0.088);
    pts[LM.RIGHT_EYE] = H(0.033, 0.031, 0.083);
    pts[LM.RIGHT_EYE_OUTER] = H(0.048, 0.03, 0.074);
    pts[LM.LEFT_EAR] = H(-0.075, 0.012, 0.0);
    pts[LM.RIGHT_EAR] = H(0.075, 0.012, 0.0);
    pts[LM.MOUTH_LEFT] = H(-0.026, -0.045, 0.09);
    pts[LM.MOUTH_RIGHT] = H(0.026, -0.045, 0.09);
    pts[LM.LEFT_SHOULDER] = lSh;
    pts[LM.RIGHT_SHOULDER] = rSh;
    for (const hand of ['left', 'right']) {
      const s = hand === 'right' ? 1 : -1;
      const S = hand === 'right' ? rSh : lSh;
      const a = ev.arm(hand, t);
      const target = add(S, inBasis(Bh, a.pos));
      const { E, W } = solveElbow(S, target, inBasis(Bh, a.pole));
      const fd = norm(sub(W, E));
      let side = norm(sub(Bh.U, mul(fd, dot(Bh.U, fd))));      // "top" of the fist
      if (len(side) < 0.5) side = Bh.F;
      const lat = norm([fd[1] * side[2] - fd[2] * side[1], fd[2] * side[0] - fd[0] * side[2], fd[0] * side[1] - fd[1] * side[0]]);
      const medial = mul(lat, s * (dot(lat, Bh.R) >= 0 ? -1 : 1));  // toward the body midline
      const idx = hand === 'right' ? { e: LM.RIGHT_ELBOW, w: LM.RIGHT_WRIST, p: LM.RIGHT_PINKY, i: LM.RIGHT_INDEX, t: LM.RIGHT_THUMB }
        : { e: LM.LEFT_ELBOW, w: LM.LEFT_WRIST, p: LM.LEFT_PINKY, i: LM.LEFT_INDEX, t: LM.LEFT_THUMB };
      pts[idx.e] = E;
      pts[idx.w] = W;
      pts[idx.i] = add(add(W, mul(fd, 0.085 * k)), mul(medial, 0.02 * k));
      pts[idx.p] = add(add(W, mul(fd, 0.075 * k)), mul(medial, -0.03 * k));
      pts[idx.t] = add(add(add(W, mul(fd, 0.045 * k)), mul(medial, 0.03 * k)), mul(side, 0.025 * k));
    }
    pts[LM.LEFT_HIP] = lHip;
    pts[LM.RIGHT_HIP] = rHip;
    // legs: feet planted in the stance, knees bend when the hips drop
    const leadSign = leadHand === 'left' ? -1 : 1;
    const foot = (s) => {
      const fwd = (s === leadSign ? 0.12 : -0.08) * k;
      return add([P.lateral + bd.walkX, floorY - 0.08 * k, P.distance], add(mul(Bhip.R, s * 0.17 * k), mul(Bhip.F, fwd)));
    };
    for (const s of [-1, 1]) {
      const hipJ = s > 0 ? rHip : lHip;
      const ank = foot(s);
      let d = sub(ank, hipJ);
      let dist = clamp(len(d), 0.2, (B.thigh + B.shin) * 0.999);
      const n = norm(d);
      const a = (B.thigh * B.thigh - B.shin * B.shin + dist * dist) / (2 * dist);
      const h = Math.sqrt(Math.max(0, B.thigh * B.thigh - a * a));
      let p = sub(Bhip.F, mul(n, dot(Bhip.F, n)));
      p = len(p) > 1e-4 ? norm(p) : Bhip.F;
      const knee = add(add(hipJ, mul(n, a)), mul(p, h));
      const iK = s > 0 ? LM.RIGHT_KNEE : LM.LEFT_KNEE;
      pts[iK] = knee;
      pts[iK + 2] = ank;                                        // ankle
      pts[iK + 4] = add(ank, add(mul(Bhip.F, -0.05 * k), [0, 0.05 * k, 0]));   // heel
      pts[iK + 6] = add(ank, add(mul(Bhip.F, 0.15 * k), [0, 0.06 * k, 0]));    // foot index
    }
    return { pts, hip };
  }

  // ── rendering through the camera + tracker imperfections ──
  const rand = mulberry32(hashSeed('noise', P.seed));
  const ns = {
    lastT: null,
    lag: null,                // lag-filtered room points
    img: null, wld: null, zb: null,
    vis: null,
    drop: { left: 0, right: 0 },   // frames remaining
    frozen: { left: null, right: null },
    poseDrop: 0,
    prevWrist: { left: null, right: null },
  };
  function resetNoise() {
    ns.lastT = null; ns.lag = null; ns.hlag = null;
    ns.img = Array.from({ length: 33 }, () => [0, 0, 0]);
    ns.wld = Array.from({ length: 33 }, () => [0, 0, 0]);
    ns.zb = Array.from({ length: 33 }, () => gauss(rand) * P.zBias * noise);
    ns.vis = visBase.map(() => 0);
    ns.drop = { left: 0, right: 0 };
    ns.frozen = { left: null, right: null };
    ns.poseDrop = 0;
    ns.prevWrist = { left: null, right: null };
  }
  resetNoise();
  const ar = (x, rho, sigma) => rho * x + Math.sqrt(1 - rho * rho) * sigma * gauss(rand);

  const ARM_IDX = { left: [LM.LEFT_WRIST, LM.LEFT_PINKY, LM.LEFT_INDEX, LM.LEFT_THUMB], right: [LM.RIGHT_WRIST, LM.RIGHT_PINKY, LM.RIGHT_INDEX, LM.RIGHT_THUMB] };
  const SWAP = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];

  function render(pts, hip, t) {
    // timing / AR decay
    let dtMs = ns.lastT === null ? 33.3 : t - ns.lastT;
    if (!(dtMs > 0) || dtMs > 1000) { resetNoise(); dtMs = 33.3; }
    ns.lastT = t;
    const frames = dtMs / 33.3;
    // tracker lag (first-order low-pass on true 3D points)
    const lagMs = P.lagMs * Math.min(1, noise);
    if (!ns.lag || lagMs <= 0) ns.lag = pts.map((p) => p.slice());
    else {
      const a = 1 - Math.exp(-dtMs / lagMs);
      for (let i = 0; i < 33; i++) ns.lag[i] = lerp3(ns.lag[i], pts[i], a);
    }
    let P3 = ns.lag;
    // extra lag of the wrist and hand points (handLagMs, R5 what-if: motion blur) — elbows and the rest unchanged
    const handLag = (P.handLagMs || 0) * Math.min(1, noise);
    if (handLag > 0) {
      if (!ns.hlag) ns.hlag = new Map();
      const ah = 1 - Math.exp(-dtMs / handLag);
      P3 = P3.slice();
      for (let i = 15; i <= 22; i++) {
        const prev = ns.hlag.get(i);
        const v = prev ? lerp3(prev, P3[i], ah) : P3[i].slice();
        ns.hlag.set(i, v);
        P3[i] = v;
      }
    }
    // the tracker's world origin is the midpoint of its (lagged) hip landmarks
    const hipCam = toCam(lerp3(P3[LM.LEFT_HIP], P3[LM.RIGHT_HIP], 0.5));
    const image = new Array(33);
    const world = new Array(33);
    // wrist speeds (m/s) for motion blur
    const speed = {};
    for (const h of ['left', 'right']) {
      const wi = h === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
      const prev = ns.prevWrist[h];
      speed[h] = prev ? len(sub(P3[wi], prev)) / (dtMs / 1000) : 0;
      ns.prevWrist[h] = P3[wi].slice();
    }
    const rhoI = Math.pow(P.imageNoiseRho, frames), rhoW = Math.pow(P.worldNoiseRho, frames), rhoZ = Math.pow(P.zNoiseRho, frames), rhoB = Math.pow(0.985, frames);
    let inFrame = 0;
    for (let i = 0; i < 33; i++) {
      const c = toCam(P3[i]);
      const zc = Math.max(0.05, c[2]);
      let x = 0.5 + (fpx * c[0] / zc) / P.width;
      let y = 0.5 + (fpx * c[1] / zc) / P.height;
      // world: hip-centred, camera-aligned, depth compressed, global scale bias
      const rel = sub(c, hipCam);
      let wx = rel[0] * worldScaleBias, wy = rel[1] * worldScaleBias, wz = rel[2] * P.zScale * worldScaleBias;
      let iz = wz * (fpx / P.width) / Math.max(0.3, hipCam[2]);
      if (noise > 0) {
        const isHand = (i >= 15 && i <= 22);
        const hand = (i % 2 === 1) ? 'left' : 'right';
        const blur = isHand ? 1 + speed[hand] / 1.5 : 1;
        const n = ns.img[i];
        n[0] = ar(n[0], rhoI, P.imageNoise * noise * blur);
        n[1] = ar(n[1], rhoI, P.imageNoise * noise * blur);
        n[2] = ar(n[2], rhoI, P.imageNoise * noise * 3);
        const w = ns.wld[i];
        w[0] = ar(w[0], rhoW, P.worldNoise * noise * (isHand ? 1.3 : 1));
        w[1] = ar(w[1], rhoW, P.worldNoise * noise * (isHand ? 1.3 : 1));
        w[2] = ar(w[2], rhoZ, P.zNoise * noise * (isHand ? 1.15 : 1));
        ns.zb[i] = ar(ns.zb[i], rhoB, P.zBias * noise);
        x += n[0]; y += n[1] * (P.width / P.height); iz += n[2];
        wx += w[0]; wy += w[1]; wz += w[2] + ns.zb[i];
      }
      // visibility: in-frame landmarks are confident; out-of-frame ones are not
      const outBy = Math.max(0, -x, x - 1, -y, y - 1);
      let vis = outBy > 0 ? clamp(0.25 - outBy * 2, 0.01, 0.25) : visBase[i] - (Math.min(x, 1 - x, y, 1 - y) < 0.03 ? 0.15 : 0);
      if (noise > 0) { ns.vis[i] = ar(ns.vis[i], 0.9, 0.03 * noise); vis = clamp(vis + ns.vis[i], 0, 1); }
      if (outBy === 0 && i <= 24) inFrame++;
      image[i] = { x, y, z: iz, visibility: vis, presence: outBy > 0 ? clamp(0.3 - outBy, 0.01, 0.3) : clamp(vis + 0.03, 0, 1) };
      world[i] = { x: wx, y: wy, z: wz, visibility: vis };
    }
    if (noise > 0) {
      // visibility drops (wrist + hand freeze at their last value with low confidence)
      for (const h of ['left', 'right']) {
        if (ns.drop[h] <= 0 && rand() < P.dropRate * noise * dtMs / 1000) {
          ns.drop[h] = 2 + Math.floor(rand() * 5);
          ns.frozen[h] = ARM_IDX[h].map((i) => ({ img: { ...image[i] }, wld: { ...world[i] } }));
        }
        if (ns.drop[h] > 0) {
          ns.drop[h]--;
          ARM_IDX[h].forEach((i, j) => {
            const f = ns.frozen[h][j];
            const v = uni(rand, 0.05, 0.42);
            image[i] = { ...f.img, visibility: v, presence: v };
            world[i] = { ...f.wld, visibility: v };
          });
        }
        // one-frame glitch: the wrist (and hand points) jump somewhere else for a single frame
        if (ns.drop[h] <= 0 && rand() < P.glitchRate * noise * frames) {
          const other = h === 'left' ? LM.RIGHT_WRIST : LM.LEFT_WRIST;
          const snap = rand() < 0.35;
          const ang = rand() * Math.PI * 2, mag = uni(rand, 0.04, 0.2);
          const dx = snap ? image[other].x - image[ARM_IDX[h][0]].x : Math.cos(ang) * mag;
          const dy = snap ? image[other].y - image[ARM_IDX[h][0]].y : Math.sin(ang) * mag;
          const scale = hipCam[2] / P.focal;
          const v = uni(rand, 0.55, 0.95);
          for (const i of ARM_IDX[h]) {
            image[i] = { ...image[i], x: image[i].x + dx, y: image[i].y + dy, visibility: v };
            world[i] = { ...world[i], x: world[i].x + dx * scale, y: world[i].y + dy * scale * (P.height / P.width), z: world[i].z + gauss(rand) * 0.08, visibility: v };
          }
        }
      }
    }
    if (inFrame < 6) return null;
    if (noise > 0) {
      if (ns.poseDrop > 0) { ns.poseDrop--; return null; }
      if (rand() < P.poseDropRate * noise * dtMs / 1000) { ns.poseDrop = Math.floor(rand() * 2); return null; }
    }
    let img = image, wld = world;
    if (P.mirrorCamera) {
      img = image.map((l) => ({ ...l, x: 1 - l.x }));
      wld = world.map((l) => ({ ...l, x: -l.x }));
      for (const [a, b] of SWAP) {
        [img[a], img[b]] = [img[b], img[a]];
        [wld[a], wld[b]] = [wld[b], wld[a]];
      }
    }
    let score = 0;
    for (const i of [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST]) score += img[i].visibility;
    return { image: img, world: wld, score: score / 7, aspect: P.width / P.height };
  }

  let cached = { action: null, ev: null };
  function evaluatorFor(action) {
    if (cached.action !== action || !cached.ev) cached = { action, ev: makeEvaluator(toScript(action)) };
    return cached.ev;
  }

  /** Ground truth of a script. Punch times are relative to the script start (+startMs). */
  function truth(action, { startMs = 0 } = {}) {
    const script = toScript(action);
    const punches = [];
    for (const st of script.steps) {
      const def = PUNCHES[st.action];
      if (!def) continue;
      const sp = stepParams(st);
      punches.push({
        hand: resolveHand(def.hand), kind: def.kind, target: def.target, action: st.action,
        tStart: startMs + st.start, tPeak: startMs + st.start + sp.T,
        tEnd: startMs + st.start + sp.T + sp.hold + sp.retract, stepIndex: st.index,
      });
    }
    return {
      punches,
      steps: script.steps.map((s) => ({ action: s.action, t0: startMs + s.start, t1: startMs + s.end, index: s.index })),
      totalMs: script.totalMs,
    };
  }

  /** Frame timestamps (relative ms) for `ms` of video at the player's fps with jitter/drops. */
  function frameTimes(ms, fps = P.fps) {
    const r = mulberry32(hashSeed('frames', P.seed, fps));
    const out = [];
    const base = 1000 / fps;
    let t = 0;
    // (double drops draw from their own stream, so frameDrop2Rate 0 leaves the frame times exactly as they were)
    const r2 = P.frameDrop2Rate > 0 ? mulberry32(hashSeed('frames2', P.seed, fps)) : null;
    while (t <= ms) {
      out.push(t);
      let dt = base * (1 + (noise > 0 ? uni(r, -P.timingJitter, P.timingJitter) : 0));
      if (noise > 0 && r() < P.frameDropRate) dt += base;
      else if (r2 && noise > 0 && r2() < P.frameDrop2Rate) dt += 2 * base;
      t += dt;
    }
    return out;
  }

  const api = {
    options: P,
    body: B,
    /** Camera pitch actually used (rad, + = looking down). */
    cameraTilt: tilt,
    /**
     * PlayerPose at `tMs` milliseconds into `action` (string | step | step[] | sequence()).
     * Call with increasing times for realistic (temporally correlated) noise.
     * @returns {import('../core/types.js').PlayerPose|null} null when the player is out of the picture / dropped
     */
    pose(tMs, action = 'idle') {
      const ev = evaluatorFor(action);
      const { pts, hip } = joints(ev, tMs);
      return render(pts, hip, tMs);
    },
    /** Noise-free 3D joints (room coordinates, metres) for debugging/visualisation. */
    skeleton(tMs, action = 'idle') { return joints(evaluatorFor(action), tMs).pts; },
    truth,
    frameTimes,
    /**
     * Render a whole script into PoseFrames.
     * @param {*} action
     * @param {{ms?:number, startMs?:number, fps?:number}} [o]
     * @returns {import('../core/types.js').PoseFrame[]}
     */
    frames(action, o = {}) {
      const script = toScript(action);
      const ms = o.ms ?? (Number.isFinite(script.totalMs) ? script.totalMs : 2000);
      const startMs = o.startMs ?? 0;
      resetNoise();
      return frameTimes(ms, o.fps ?? P.fps).map((t) => ({
        t: startMs + t, width: P.width, height: P.height, players: [api.pose(t, script)],
      }));
    },
    /** frames() + truth() in one go. */
    run(action, o = {}) {
      const script = toScript(action);
      return { frames: api.frames(script, o), truth: truth(script, { startMs: o.startMs ?? 0 }) };
    },
    reset: resetNoise,
  };
  return api;
}

/**
 * Convenience for InputHub.injectFrames / window.__glove.injectPose: render an action or
 * script into PoseFrames starting at `startMs` (default 0; pass performance.now() to inject live).
 * @param {*} action   name | step | step[] | sequence()
 * @param {Partial<typeof SYNTH_DEFAULTS> & {ms?:number, startMs?:number}} [opts]
 * @returns {import('../core/types.js').PoseFrame[]}
 */
export function syntheticPoseFrames(action, opts = {}) {
  const { ms, startMs, ...playerOpts } = opts;
  return makeSyntheticPlayer(playerOpts).frames(action, { ms, startMs });
}
