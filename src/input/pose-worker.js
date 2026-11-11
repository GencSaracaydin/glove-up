// Pose detection worker (PERF-01): runs the MediaPipe PoseLandmarker off the main thread, so the
// render loop never waits for a detection. Started by WorkerPoseTracker (pose-worker-tracker.js),
// which posts camera frames (transferred VideoFrame / ImageBitmap) and reads results back.
//
// Protocol (all messages are plain objects with a `type`):
//   main → worker  {type:'init', id, wasmUrl, model:ArrayBuffer, delegate:'GPU'|'CPU', avoidSoftwareGL, warmup, options}
//                  {type:'frame', seq, ts, image}          one camera frame; the worker closes `image`
//                  {type:'options', id, numPoses}          landmarker.setOptions (restarts the graph)
//                  {type:'switch', id, delegate:'CPU'}     GPU → CPU (driver failure / too slow)
//                  {type:'model', id, model:ArrayBuffer}   full ↔ lite in place (PERF-06): the new landmarker is built
//                                                          and warmed up first; if it can't start, the old one keeps going
//                  {type:'close', id}
//   worker → main  {type:'reply', id, ok, value?, error?}  answer to init / options / switch / model / close
//                                                          (init's value carries the worker's performance.timeOrigin)
//                  {type:'result', seq, ts, ms, n, data, rx, t0, t1}   data: Float32Array (pose-worker-codec.js),
//                                                          transferred; rx = frame message handled, t0/t1 = inference
//                                                          start / end, all on the worker's clock (PERF-06 timings)
//                  {type:'detect-error', seq, message}
// Messages are handled strictly in order (a frame posted after 'options' sees the new options).
//
// The wasm loader: in a module worker importScripts() throws, and tasks-vision then import()s the
// loader instead, which needs its ES-module build (`vision_wasm_module_internal.js`). In a classic
// worker the classic loader is importScripts()ed. Vite serves this file as a module worker in dev
// and bundles it (iife) for the build; isModuleWorker picks the right loader in both.
//
// No telemetry (R5): tasks-vision's usage logger would POST to Google from this worker; the guard from
// no-telemetry.js answers it locally (installed below, before any landmarker exists).

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { MP_NOISE, packResult, keepModuleFactory } from './pose-worker-codec.js';
import { blockMediapipeTelemetry } from './no-telemetry.js';

// MediaPipe's usage statistics stay on this device (the logger reads `fetch` when it sends).
blockMediapipeTelemetry(self);

// The worker runs nothing but MediaPipe: drop its start-up chatter for good.
for (const k of ['log', 'info', 'warn', 'error']) {
  const orig = console[k];
  console[k] = (...a) => { if (typeof a[0] === 'string' && MP_NOISE.test(a[0])) return; orig.apply(console, a); };
}

// A second landmarker in this worker (GPU → CPU) needs the wasm factory the cached loader set once.
const factory = keepModuleFactory(self);

const isModuleWorker = (() => {
  try { importScripts(); return false; } catch { return true; }
})();

let landmarker = null;
let fileset = null;
let model = null;
let options = null;
let warmup = true;
let lastTs = 0;
/** The delegate the current landmarker runs on (a model swap keeps it). */
let delegate = 'GPU';

const errText = (e) => (e && e.message ? e.message : String(e));
const shortErr = (e) => { const s = errText(e).replace(/\s+/g, ' ').trim(); return s.length > 140 ? s.slice(0, 137) + '…' : s; };
const post = (m, transfer) => self.postMessage(m, transfer || []);

/** Why the GPU delegate would be a bad idea in this worker (null if WebGL2 looks hardware-accelerated). */
function gpuProblem() {
  if (typeof OffscreenCanvas === 'undefined') return 'OffscreenCanvas unavailable';
  let gl = null;
  try {
    gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return 'WebGL2 unavailable';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    const m = name.match(/swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i);
    return m ? `software WebGL (${/swiftshader/i.test(name) ? 'SwiftShader' : m[0]})` : null;
  } catch {
    return null;
  } finally {
    try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
  }
}

function closeQuietly(lm) {
  if (!lm) return;
  try { lm.close(); } catch { /* already closed */ }
}

/** One inference on a small blank image: a broken delegate pipeline fails here, not on a camera frame. */
function warm(lm) {
  if (typeof ImageData === 'undefined') return;
  const img = new ImageData(64, 64);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  lastTs += 1;
  lm.detectForVideo(img, lastTs);
}

async function create(on, buffer = model) {
  let lm = null;
  try {
    factory.restore();
    lm = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buffer, delegate: on },
      runningMode: 'VIDEO',
      ...options,
      outputSegmentationMasks: false,
    });
    if (warmup) warm(lm);
    return lm;
  } catch (e) {
    closeQuietly(lm);
    throw e;
  }
}

async function init(m) {
  const t0 = performance.now();
  options = { ...m.options };
  warmup = m.warmup !== false;
  model = new Uint8Array(m.model);
  fileset = await FilesetResolver.forVisionTasks(m.wasmUrl, isModuleWorker);
  let order = m.delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  let fallbackReason = m.delegate === 'CPU' ? 'CPU requested' : null;
  const problem = m.avoidSoftwareGL && order[0] === 'GPU' ? gpuProblem() : null;
  if (problem) {
    order = ['CPU'];
    fallbackReason = `${problem} — CPU is faster`;
  }
  let lastErr = null;
  for (const d of order) {
    try {
      landmarker = await create(d);
      delegate = d;
      return { delegate: d, fallbackReason, initMs: performance.now() - t0, moduleWorker: isModuleWorker, timeOrigin: performance.timeOrigin };
    } catch (e) {
      lastErr = e;
      if (d === 'GPU') fallbackReason = `GPU unavailable (${shortErr(e)})`;
    }
  }
  throw lastErr || new Error('no delegate could start');
}

function detect(m) {
  const image = m.image;
  try {
    if (!landmarker) throw new Error('the pose landmarker is not ready');
    const ts = Math.max(m.ts, lastTs + 1);
    lastTs = ts;
    const t0 = performance.now();
    const result = landmarker.detectForVideo(image, ts);
    const t1 = performance.now();
    const { n, data } = packResult(result);
    post({ type: 'result', seq: m.seq, ts: m.ts, ms: t1 - t0, n, data, rx: m.rx, t0, t1 }, [data.buffer]);
  } catch (e) {
    post({ type: 'detect-error', seq: m.seq, message: errText(e) });
  } finally {
    try { if (image && typeof image.close === 'function') image.close(); } catch { /* ignore */ }
  }
}

async function handle(m) {
  switch (m.type) {
    case 'frame': detect(m); return undefined;
    case 'init': return init(m);
    case 'options':
      options = { ...options, numPoses: m.numPoses };
      if (landmarker) await landmarker.setOptions({ numPoses: m.numPoses });
      return { numPoses: m.numPoses };
    case 'switch': {
      // the new landmarker first: if it can't start, the old one keeps working
      const d = m.delegate === 'GPU' ? 'GPU' : 'CPU';
      const next = await create(d);
      const old = landmarker;
      landmarker = next;
      delegate = d;
      closeQuietly(old);
      return { delegate: d };
    }
    case 'model': {
      // full ↔ lite on the same delegate and options (PERF-06); the old landmarker stays until the new one works
      const t0 = performance.now();
      const buffer = new Uint8Array(m.model);
      const next = await create(delegate, buffer);
      const old = landmarker;
      landmarker = next;
      model = buffer;
      closeQuietly(old);
      return { delegate, ms: performance.now() - t0 };
    }
    case 'close': {
      const old = landmarker;
      landmarker = null;
      closeQuietly(old);
      return { closed: true };
    }
    default:
      throw new Error(`unknown message ${m.type}`);
  }
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'frame') m.rx = performance.now(); // when the frame reached this worker (it may queue behind a switch)
  chain = chain.then(() => handle(m)).then(
    (value) => { if (m.id !== undefined) post({ type: 'reply', id: m.id, ok: true, value }); },
    (err) => {
      if (m.id !== undefined) post({ type: 'reply', id: m.id, ok: false, error: errText(err) });
      else if (m.type === 'frame') post({ type: 'detect-error', seq: m.seq, message: errText(err) });
    });
};
