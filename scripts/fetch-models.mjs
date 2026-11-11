// Copies the MediaPipe wasm runtime out of node_modules and downloads the pose models from Google's
// MediaPipe model bucket into public/, so the game runs fully from the local server (no CDN at play
// time). Each model is pinned to one exact file and checked by SHA-256 (RELEASE-07), so a fresh
// checkout gets the very files the gesture thresholds were tuned on, or a clear one-line error.
//
//   npm run setup:models                      (= node scripts/fetch-models.mjs)
//   node scripts/fetch-models.mjs --root DIR  (set up another checkout; used by the unit tests)
//
// Existing model files are kept when their SHA-256 matches and replaced when it does not. Downloads go
// to a .part file that only becomes the model once its checksum matches.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

/**
 * The pose models the game was tuned on (pose-tracker.js loads /models/<name>). Checked on 2026-11-06
 * with HEAD requests only, comparing the bucket's x-goog-hash md5 and size to the local files:
 *  - lite: the numbered release float16/1 is byte-identical to 'latest' (md5 BKdd33yBGsehpFIyZt19iA==).
 *  - full: float16/1 is a DIFFERENT file (same 9,398,198 bytes, md5 g4eWidNz0UO+CUyXI1Xkjg==) from the
 *    one the thresholds were tuned on, which is 'latest' as uploaded on 2023-04-28
 *    (md5 WprYiRmyIx0Csf30pUCQ7A==). The URL pins that exact object generation.
 * The licence (Apache-2.0, per the model card) is in public/THIRD_PARTY_NOTICES.txt.
 */
export const MODELS = Object.freeze({
  'pose_landmarker_lite.task': Object.freeze({
    url: `${BUCKET}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    bytes: 5777746,
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
  }),
  'pose_landmarker_full.task': Object.freeze({
    url: `${BUCKET}/pose_landmarker_full/float16/latest/pose_landmarker_full.task?generation=1682642787774579`,
    bytes: 9398198,
    sha256: '4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad',
  }),
});

const AGAIN = 'Run "npm run setup:models" again when you are online.';
const REPIN = 'If it keeps failing, the pinned file has changed or gone: update MODELS in scripts/fetch-models.mjs and re-check the gesture tuning.';

/** A setup problem with a one-line message for people; the CLI prints it without a stack trace. */
export class SetupError extends Error {
  constructor(message) { super(message); this.name = 'SetupError'; }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Why a fetch failed, in a few words (undici puts the network error in `cause`). */
function reason(e) {
  const c = e && e.cause;
  return String((c && (c.code ? `${c.code}${c.hostname ? ' ' + c.hostname : ''}` : c.message)) || (e && e.message) || e);
}

/** Copy node_modules/@mediapipe/tasks-vision/wasm → public/mediapipe/wasm. */
export function copyWasm({ root = ROOT, log = console.log } = {}) {
  const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const dst = join(root, 'public/mediapipe/wasm');
  if (!existsSync(src)) throw new SetupError(`The MediaPipe runtime is missing (${src}). Run "npm ci" first, then "npm run setup:models".`);
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  log(`copied wasm -> ${dst}`);
}

/**
 * Make public/models/<name> the pinned model. → 'have' (already right) | 'downloaded'.
 * Throws SetupError: offline / HTTP error / checksum mismatch (nothing is left at the target then).
 */
export async function fetchModel(name, spec, { root = ROOT, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const dir = join(root, 'public/models');
  const dst = join(dir, name);
  const part = `${dst}.part`;
  mkdirSync(dir, { recursive: true });
  rmSync(part, { force: true });
  if (existsSync(dst)) {
    const have = sha256(readFileSync(dst));
    if (have === spec.sha256) { log(`have ${name} (sha256 ok)`); return 'have'; }
    log(`${name} is not the pinned model (sha256 ${have.slice(0, 12)}…): removing it and downloading the pinned one`);
    rmSync(dst, { force: true });
  }
  let res;
  let body;
  try {
    res = await fetchImpl(spec.url);
    if (res.ok) body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new SetupError(`Could not download the pose models (offline?): ${name} failed with ${reason(e)}. ${AGAIN}`);
  }
  if (!res.ok) throw new SetupError(`Could not download ${name}: HTTP ${res.status} from ${spec.url}. ${REPIN}`);
  const got = sha256(body);
  if (got !== spec.sha256) {
    throw new SetupError(`${name} from ${spec.url} is not the pinned model (sha256 ${got}, ${body.length} bytes; expected ${spec.sha256}, ${spec.bytes} bytes), so it was not saved. ${REPIN}`);
  }
  writeFileSync(part, body);
  renameSync(part, dst);
  log(`downloaded ${name} ${body.length} bytes (sha256 ok)`);
  return 'downloaded';
}

/** The whole setup: the wasm runtime, then every model. */
export async function setupModels({ root = ROOT, fetchImpl = globalThis.fetch, log = console.log, models = MODELS, wasm = true } = {}) {
  if (wasm) copyWasm({ root, log });
  const out = {};
  for (const [name, spec] of Object.entries(models)) out[name] = await fetchModel(name, spec, { root, fetchImpl, log });
  return out;
}

/** Run as a script (not imported)? Real paths, so a symlinked path (macOS /tmp) still counts. */
function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const at = process.argv.indexOf('--root');
  const root = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : ROOT;
  try {
    await setupModels({ root });
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    console.error(`setup:models: ${e.message}`);
    process.exit(1);
  }
}
