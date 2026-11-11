// RELEASE-07: scripts/fetch-models.mjs pins the pose models to exact files, checks their SHA-256
// (existing files and downloads), never leaves a bad or partial file in public/models, and fails
// offline with one readable line instead of a stack trace. No network: fetch is stubbed throughout
// and every run uses a temporary root.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'fetch-models.mjs');
const fm = await import(pathToFileURL(SCRIPT).href);
const { MODELS, SetupError, setupModels, fetchModel, sha256 } = fm;

const tmp = () => mkdtempSync(join(tmpdir(), 'glove-models-'));
const quiet = { log: () => {} };
const body = Buffer.from('a tiny stand-in for a pose model');
const TINY = { 'tiny.task': { url: 'https://models.invalid/tiny/1/tiny.task', bytes: body.length, sha256: sha256(body) } };
const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND storage.googleapis.com'), { code: 'ENOTFOUND', hostname: 'storage.googleapis.com' }) }); };
const serve = (bytes, status = 200) => async () => new Response(status === 200 ? bytes : 'nope', { status });

test('models: every model is pinned (no floating "latest" path) and has a SHA-256', () => {
  for (const [name, spec] of Object.entries(MODELS)) {
    assert(/^[0-9a-f]{64}$/.test(spec.sha256), `${name} sha256`);
    const u = new URL(spec.url);
    assert(u.hostname === 'storage.googleapis.com' && u.pathname.endsWith(`/${name}`), `${name} url ${spec.url}`);
    assert(!u.pathname.includes('/latest/') || /^\d+$/.test(u.searchParams.get('generation') || ''), `${name}: a "latest" path must pin the object generation (${spec.url})`);
    assert(Number.isInteger(spec.bytes) && spec.bytes > 1e6, `${name} size`);
  }
  assert(MODELS['pose_landmarker_lite.task'].url.includes('/float16/1/'), 'lite: the numbered release');
});

test('models: the pinned sums are the files the game uses (when public/models is set up)', () => {
  for (const [name, spec] of Object.entries(MODELS)) {
    const p = join(ROOT, 'public', 'models', name);
    if (!existsSync(p)) continue; // a fresh checkout before "npm run setup:models"
    const buf = readFileSync(p);
    assert.equal(buf.length, spec.bytes, `${name} size`);
    assert.equal(sha256(buf), spec.sha256, `${name} sha256`);
  }
});

test('models: offline → one SetupError line naming the cause and what to do; nothing written', async () => {
  const root = tmp();
  try {
    let err = null;
    try { await setupModels({ root, fetchImpl: offline, models: TINY, wasm: false, ...quiet }); } catch (e) { err = e; }
    assert(err instanceof SetupError, `SetupError (${err})`);
    assert(!err.message.includes('\n'), 'one line');
    assert(/Could not download the pose models \(offline\?\)/.test(err.message) && /ENOTFOUND/.test(err.message) && /npm run setup:models/.test(err.message), err.message);
    assert.deepEqual(readdirSync(join(root, 'public', 'models')), [], 'no file left behind');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('models: a download is saved only when its SHA-256 matches; a wrong file is refused and not kept', async () => {
  const root = tmp();
  try {
    assert.equal(await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: serve(body), ...quiet }), 'downloaded');
    assert(readFileSync(join(root, 'public/models/tiny.task')).equals(body), 'saved');
    rmSync(join(root, 'public/models/tiny.task'));
    let err = null;
    try { await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: serve(Buffer.from('something else')), ...quiet }); } catch (e) { err = e; }
    assert(err instanceof SetupError && /not the pinned model/.test(err.message) && err.message.includes(TINY['tiny.task'].sha256), String(err));
    assert.deepEqual(readdirSync(join(root, 'public/models')), [], 'neither the file nor a .part is left');
    err = null;
    try { await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: serve(null, 404), ...quiet }); } catch (e) { err = e; }
    assert(err instanceof SetupError && /HTTP 404/.test(err.message), String(err));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('models: an existing file is kept when it matches (no download) and replaced when it does not', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'public/models'), { recursive: true });
    writeFileSync(join(root, 'public/models/tiny.task'), body);
    let calls = 0;
    const counting = async (u) => { calls++; return serve(body)(u); };
    assert.equal(await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: counting, ...quiet }), 'have');
    assert.equal(calls, 0, 'a matching file is not downloaded again');
    writeFileSync(join(root, 'public/models/tiny.task'), Buffer.alloc(2_000_000)); // a corrupt "model" (the old check only wanted > 1 MB)
    assert.equal(await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: counting, ...quiet }), 'downloaded');
    assert(calls === 1 && readFileSync(join(root, 'public/models/tiny.task')).equals(body), 'the corrupt file was replaced by the pinned one');
    writeFileSync(join(root, 'public/models/tiny.task'), Buffer.alloc(2_000_000));
    let err = null;
    try { await fetchModel('tiny.task', TINY['tiny.task'], { root, fetchImpl: offline, ...quiet }); } catch (e) { err = e; }
    assert(err instanceof SetupError, 'offline with a corrupt file: fails clearly');
    assert(!existsSync(join(root, 'public/models/tiny.task')), 'and does not keep the corrupt file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('models: the CLI offline prints one line on stderr, no stack trace, and exits 1', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@mediapipe/tasks-vision/wasm/stub.wasm'), 'stub');
    const stub = join(root, 'offline-fetch.mjs');
    writeFileSync(stub, `globalThis.fetch = ${offline.toString()};\n`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, '--root', root], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, `exit code (stderr: ${r.stderr})`);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `one stderr line: ${r.stderr}`);
    assert(/^setup:models: Could not download the pose models \(offline\?\)/.test(lines[0]), lines[0]);
    assert(!/\n\s+at |TypeError/.test(r.stderr), 'no stack trace');
    assert(/copied wasm/.test(r.stdout) && existsSync(join(root, 'public/mediapipe/wasm/stub.wasm')), 'the wasm runtime is still copied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
