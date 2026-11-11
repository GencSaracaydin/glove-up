// Shared by the pose detection worker (pose-worker.js) and its main-thread client
// (pose-worker-tracker.js): how a MediaPipe result travels between them, plus the runtime-noise
// filter. Pure module, no DOM, no MediaPipe import (safe in Node, in the worker and in the page).
//
// A result is packed into ONE Float32Array (transferred, not copied): per pose, 33 image
// landmarks × [x, y, z, visibility, presence] followed by 33 world landmarks × [x, y, z,
// visibility]. A missing `presence` is NaN; missing world landmarks are zeros with visibility 0
// (exactly what toPlayerPose in pose-tracker.js produces).

/** Landmarks per pose (MediaPipe Pose). */
export const LM_COUNT = 33;
const IMG = 5;
const WLD = 4;
/** Floats per packed pose. */
export const PACKED_POSE = LM_COUNT * (IMG + WLD);

/**
 * MediaPipe's wasm runtime logs informational glog lines (and an XNNPACK notice via console.error)
 * while it starts. They are not errors; the tracker drops exactly these while its own calls into
 * MediaPipe run (the worker drops them for good: it runs nothing else).
 */
export const MP_NOISE = /^(?:[IW]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+ [\w.]+:\d+\]|INFO: Created TensorFlow Lite|Graph successfully started running|Graph finished closing successfully)/;

/**
 * tasks-vision reads `self.ModuleFactory` (set by its wasm loader script) for every task it creates and
 * then clears it. A classic script / classic worker re-runs the loader each time; a module worker's
 * `import()` of the loader is cached and runs once — so a second landmarker (a GPU → CPU switch) would
 * fail with "ModuleFactory not set". This keeps the factory the loader set; restore() puts it back.
 * @param {object} scope  the global object (self)
 * @returns {{restore: () => boolean}}  restore() → true if a factory was put back
 */
export function keepModuleFactory(scope) {
  let current = scope.ModuleFactory;
  let kept = typeof current === 'function' ? current : null;
  Object.defineProperty(scope, 'ModuleFactory', {
    configurable: true,
    enumerable: true,
    get() { return current; },
    set(v) { current = v; if (typeof v === 'function') kept = v; },
  });
  return {
    restore() {
      if (current || !kept) return false;
      current = kept;
      return true;
    },
  };
}

/**
 * Pack a PoseLandmarkerResult ({landmarks, worldLandmarks}).
 * @param {{landmarks?: Array<Array<{x:number,y:number,z:number,visibility?:number,presence?:number}>>,
 *          worldLandmarks?: Array<Array<{x:number,y:number,z:number,visibility?:number}>>}} result
 * @returns {{n:number, data: Float32Array}}
 */
export function packResult(result) {
  const lms = (result && result.landmarks) || [];
  const worlds = (result && result.worldLandmarks) || [];
  const n = lms.length;
  const data = new Float32Array(Math.max(1, n) * PACKED_POSE);
  for (let k = 0; k < n; k++) {
    const im = lms[k] || [];
    const wl = worlds[k] && worlds[k].length === im.length ? worlds[k] : null;
    const o = k * PACKED_POSE;
    for (let i = 0; i < LM_COUNT; i++) {
      const l = im[i];
      const a = o + i * IMG;
      const vis = l ? (l.visibility ?? 0) : 0;
      if (l) { data[a] = l.x; data[a + 1] = l.y; data[a + 2] = l.z; }
      data[a + 3] = vis;
      data[a + 4] = l && l.presence !== undefined ? l.presence : NaN;
      const b = o + LM_COUNT * IMG + i * WLD;
      const w = wl && wl[i];
      if (w) { data[b] = w.x; data[b + 1] = w.y; data[b + 2] = w.z; data[b + 3] = w.visibility ?? vis; }
      // else: zeros with visibility 0 (Float32Array starts zeroed)
    }
  }
  return { n, data };
}

/**
 * Unpack into PlayerPose objects (plain objects, safe to keep). `scoreFn(image)` = poseScore.
 * @param {Float32Array} data
 * @param {number} n
 * @param {number} aspect  frame width / height (stamped on each pose, like toPlayerPose)
 * @param {(image: object[]) => number} scoreFn
 * @returns {import('../core/types.js').PlayerPose[]}
 */
export function unpackPoses(data, n, aspect, scoreFn) {
  const players = [];
  for (let k = 0; k < n; k++) {
    const o = k * PACKED_POSE;
    const image = new Array(LM_COUNT);
    const world = new Array(LM_COUNT);
    for (let i = 0; i < LM_COUNT; i++) {
      const a = o + i * IMG;
      const lm = { x: data[a], y: data[a + 1], z: data[a + 2], visibility: data[a + 3] };
      const pr = data[a + 4];
      if (!Number.isNaN(pr)) lm.presence = pr;
      image[i] = lm;
      const b = o + LM_COUNT * IMG + i * WLD;
      world[i] = { x: data[b], y: data[b + 1], z: data[b + 2], visibility: data[b + 3] };
    }
    const pose = { image, world, score: scoreFn(image) };
    if (aspect > 0) pose.aspect = aspect;
    players.push(pose);
  }
  return players;
}
