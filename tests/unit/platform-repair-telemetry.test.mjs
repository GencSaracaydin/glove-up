// R5 / RV-INPUT-05 / RV-RELEASE-01: MediaPipe Tasks' usage logger never reaches the network.
//  * src/input/no-telemetry.js: a fetch guard answers odml.pa.googleapis.com with an empty 204 (string, URL
//    and Request inputs), passes everything else through unchanged, and installs once.
//  * The real logger of the installed @mediapipe/tasks-vision, lifted out of vision_bundle.mjs and run in a
//    sandbox: it reads the global fetch when it sends, and the guard's 204 makes it stop for good (error
//    flag, empty queue, 60 s timer cleared). Without the guard it POSTs and keeps its timer.
//  * Both detection paths install the guard at module scope: pose-tracker.js on the page (?detector=main,
//    the worker's fallback) and pose-worker.js in the worker.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test, assert } from '../harness.mjs';
import { blockMediapipeTelemetry, fetchHost, TELEMETRY_HOSTS } from '../../src/input/no-telemetry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_URL = 'https://odml.pa.googleapis.com/v1/log';
const BUNDLE = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'vision_bundle.mjs');
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake global scope whose fetch records its calls. */
function fakeScope(status = 200) {
  const calls = [];
  const scope = { location: { href: 'http://127.0.0.1:5180/index.html' } };
  scope.fetch = function realFetch(input, init) { calls.push({ input, init, self: this, args: arguments.length }); return Promise.resolve(new Response('ok', { status })); };
  return { scope, calls, orig: scope.fetch };
}

test('telemetry guard: the usage-log host gets an empty local 204 for a string, a URL and a Request', async () => {
  assert.deepEqual([...TELEMETRY_HOSTS], ['odml.pa.googleapis.com']);
  const { scope, calls } = fakeScope();
  assert.equal(blockMediapipeTelemetry(scope), true);
  assert(scope.fetch.__gloveGuard === true && scope.fetch.blocked === 0);
  const inputs = [LOG_URL, new URL(LOG_URL), new Request(LOG_URL, { method: 'POST', body: new Uint8Array([1, 2, 3]) }),
    'HTTPS://ODML.PA.GOOGLEAPIS.COM/v1/log?x=1', 'http://odml.pa.googleapis.com/v1/log'];
  for (const input of inputs) {
    const res = await scope.fetch(input, { method: 'POST', headers: { 'x-goog-api-key': 'k' } });
    assert(res instanceof Response && res.status === 204 && res.ok, `204 for ${String(input?.url ?? input)}`);
    assert.equal(await res.text(), '', 'empty body');
  }
  assert.equal(calls.length, 0, 'the real fetch was never called');
  assert.equal(scope.fetch.blocked, inputs.length, 'every logger call counted');
});

test('telemetry guard: every other request passes through unchanged (same arguments, same this)', async () => {
  const { scope, calls } = fakeScope();
  blockMediapipeTelemetry(scope);
  const init = { method: 'GET', cache: 'no-store' };
  const req = new Request('http://127.0.0.1:5180/models/pose_landmarker_full.task');
  for (const input of ['/models/pose_landmarker_lite.task', 'mediapipe/wasm/vision_wasm_internal.js', req,
    new URL('http://127.0.0.1:5180/x'), 'https://storage.googleapis.com/mediapipe-models/x.task', 'https://pa.googleapis.com/v1/log']) {
    const res = await scope.fetch(input, init);
    assert.equal(res.status, 200);
    const c = calls.at(-1);
    assert(c.input === input && c.init === init && c.self === scope, `passed through: ${String(input?.url ?? input)}`);
  }
  assert.equal(calls.length, 6);
  assert.equal(scope.fetch.blocked, 0, 'nothing else is answered locally (not even other googleapis.com hosts)');
});

test('telemetry guard: installs once; a scope without fetch is left alone; hosts are read like fetch reads them', () => {
  const { scope, orig } = fakeScope();
  blockMediapipeTelemetry(scope);
  const g = scope.fetch;
  assert(g !== orig);
  assert.equal(blockMediapipeTelemetry(scope), true);
  assert(scope.fetch === g, 'a second install keeps the first guard (no guard around a guard)');
  const bare = {};
  assert.equal(blockMediapipeTelemetry(bare), false);
  assert(!('fetch' in bare));
  assert.equal(fetchHost('/v1/log', 'https://odml.pa.googleapis.com/'), 'odml.pa.googleapis.com', 'relative URLs resolve against the location');
  assert.equal(fetchHost('/models/x.task', 'http://127.0.0.1:5180/'), '127.0.0.1');
  assert.equal(fetchHost('::not a url::'), '');
  assert.equal(fetchHost({ url: LOG_URL }), 'odml.pa.googleapis.com');
});

/** The class expression `<name>=class{…}` of the bundle (brace-matched, string literals skipped). */
function classSource(src, name) {
  const hit = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}=class\\{`).exec(src);
  if (!hit) return null;
  const start = hit.index;
  let depth = 0, quote = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start + name.length + 1, i + 1);
  }
  return null;
}

/**
 * tasks-vision's usage logger (the class whose constructor creates the sender and the 60 s flush timer) and
 * its sender, compiled in a sandbox whose free identifiers resolve through `scope` at the moment the code
 * runs — the way the bundle's free `fetch` resolves to the worker's or the page's global. The protobuf
 * helpers the flush calls become pass-through stubs.
 */
function loadLogger(scope) {
  const src = readFileSync(BUNDLE, 'utf8');
  const m = src.match(/([A-Za-z_$][\w$]*)=class\{constructor\(t\)\{this\.i=\[\],this\.o=new ([A-Za-z_$][\w$]*),this\.l=t\?\?"",this\.h=setInterval\(\(\)=>\{this\.flush\(\)\},6e4\)\}/);
  assert(m, 'tasks-vision changed its usage logger: re-check that it reads fetch when it sends and stops on a non-200 answer, then update no-telemetry.js and this test');
  const loggerSrc = classSource(src, m[1]);
  const senderSrc = classSource(src, m[2]);
  assert(loggerSrc && senderSrc && loggerSrc.includes(LOG_URL), 'logger and sender found');
  assert(/async send\(t,e,r\)\{[^]*?await fetch\(t\.url,/.test(senderSrc), 'the sender calls the global fetch at send time');
  assert(/200===\w+\.status\?/.test(senderSrc), 'only HTTP 200 counts as delivered');
  const stub = function stub(a) { return a; };
  const names = new Map([[m[2], null]]);
  const lookup = new Proxy({}, {
    has: (_, k) => typeof k === 'string',
    get: (_, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (names.has(k)) return names.get(k);
      if (k in scope) return scope[k];
      if (k in globalThis) return globalThis[k];
      return stub; // protobuf builders (minified names)
    },
  });
  const make = new vm.Script(`(function (scope) { with (scope) { return [${senderSrc}, ${loggerSrc}]; } })`).runInThisContext();
  const [Sender, Logger] = make(lookup);
  names.set(m[2], Sender);
  return Logger;
}

function fakeTimers() {
  const live = new Set();
  let next = 1;
  return { live, setInterval: () => { const id = next++; live.add(id); return id; }, clearInterval: (id) => { live.delete(id); } };
}

test('telemetry guard: the real tasks-vision logger reads fetch at send time; the 204 stops it for good', async () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'package.json'), 'utf8')).version;
  // without the guard (what the game did before R5): a flush POSTs to Google and the 60 s timer keeps running
  {
    const { scope, calls } = fakeScope(200);
    const timers = fakeTimers();
    Object.assign(scope, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    const lg = new (loadLogger(scope))('api-key');
    assert.equal(timers.live.size, 1, 'the 60 s flush timer runs');
    lg.i.push({ event: 'init' });
    lg.flush();
    await tick(); await tick();
    assert.equal(calls.length, 1, `tasks-vision ${version} POSTs its queue`);
    assert(String(calls[0].input) === LOG_URL && calls[0].init.method === 'POST' && calls[0].init.headers['x-goog-api-key'] === 'api-key');
    assert(!lg.error && timers.live.size === 1, 'a 200 answer keeps the logger and its timer alive');
    lg.i.push({ event: 'stats' });
    lg.close();
    await tick(); await tick();
    assert.equal(calls.length, 2, 'close() flushes once more');
  }
  // with the guard on the scope the logger's fetch resolves to: one local 204, then silence. Installed after
  // the logger exists (as in the worker, after the tasks-vision import): the logger looks fetch up when it sends.
  {
    const { scope, calls } = fakeScope(200);
    const timers = fakeTimers();
    Object.assign(scope, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    const lg = new (loadLogger(scope))('api-key');
    blockMediapipeTelemetry(scope);
    lg.i.push({ event: 'init' });
    lg.flush();                       // the 60 s timer firing
    await tick(); await tick();
    assert.equal(calls.length, 0, 'nothing reached the real fetch');
    assert.equal(scope.fetch.blocked, 1, 'the guard answered the one send');
    assert(lg.error instanceof Error && /HTTP error: 204/.test(lg.error.message), String(lg.error));
    assert(lg.i.length === 0 && timers.live.size === 0, 'queue dropped and the 60 s timer cleared');
    let failed = null;
    lg.i.push({ event: 'stats' });
    lg.flush(() => {}, (why) => { failed = why; });
    lg.close();
    await tick(); await tick();
    assert(failed === 'net-send-failed' && calls.length === 0 && scope.fetch.blocked === 1, 'later flushes and close() send nothing at all');
  }
});

test('telemetry guard: pose-tracker.js installs it on the page at module scope (?detector=main and the worker fallback)', async () => {
  const had = globalThis.fetch;
  const calls = [];
  globalThis.fetch = function plainFetch(input) { calls.push(String(input)); return Promise.resolve(new Response('x')); };
  try {
    await import(`${pathToFileURL(join(ROOT, 'src', 'input', 'pose-tracker.js')).href}?telemetry-test=${Date.now()}`);
    assert(globalThis.fetch.__gloveGuard === true, 'importing the tracker module installs the guard');
    const r = await fetch(LOG_URL, { method: 'POST' });
    assert(r.status === 204 && calls.length === 0, 'the usage log is answered locally');
    await fetch('/models/pose_landmarker_full.task');
    assert.deepEqual(calls, ['/models/pose_landmarker_full.task'], 'the model still loads through the real fetch');
  } finally {
    globalThis.fetch = had;
  }
});

test('telemetry guard: pose-worker.js installs it on the worker scope at module scope', () => {
  // a child process: the worker module sets self.onmessage, ModuleFactory and console filters for good
  const worker = pathToFileURL(join(ROOT, 'src', 'input', 'pose-worker.js')).href;
  const code = `globalThis.self = globalThis;
    const calls = [];
    globalThis.fetch = async (u) => { calls.push(String(u)); return new Response('x'); };
    await import(${JSON.stringify(worker)});
    const r = await self.fetch(${JSON.stringify(LOG_URL)}, { method: 'POST' });
    await self.fetch('http://127.0.0.1:5180/mediapipe/wasm/vision_wasm_module_internal.js');
    process.stdout.write(JSON.stringify({ guard: self.fetch.__gloveGuard === true, status: r.status, blocked: self.fetch.blocked, calls, handler: typeof self.onmessage }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert(r.guard && r.status === 204 && r.blocked === 1, JSON.stringify(r));
  assert.deepEqual(r.calls, ['http://127.0.0.1:5180/mediapipe/wasm/vision_wasm_module_internal.js'], 'only the local request went to the real fetch');
  assert.equal(r.handler, 'function', 'the worker module loaded completely');
  // and the order: installed at the top level, before the message handler can create a landmarker
  const src = readFileSync(join(ROOT, 'src', 'input', 'pose-worker.js'), 'utf8');
  const call = src.search(/^blockMediapipeTelemetry\(self\);/m);
  assert(call > 0 && call < src.indexOf('self.onmessage ='), 'blockMediapipeTelemetry(self) runs at module scope before self.onmessage');
});

test('telemetry guard: the docs say it — README, THIRD_PARTY_NOTICES (MediaPipe entry) and index.html', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert(/usage statistics[^.]*switched off \(`src\/input\/no-telemetry\.js`\)/.test(readme), 'README: MediaPipe\'s usage statistics are switched off');
  assert(!/never contacts another host/.test(readme), 'README: no blanket "never contacts another host" (the browser\'s online voices are outside the game)');
  assert(/picks by itself[^.]*\. In some browsers that can be an online voice[^.]*speech service/.test(readme), 'README: the announcer\'s voice is picked by the game and can be an online voice');
  const notices = readFileSync(join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  const mp = notices.slice(notices.indexOf('2. MediaPipe Tasks Vision'), notices.indexOf('\n3. ')).replace(/\s+/g, ' ');
  assert(/odml\.pa\.googleapis\.com/.test(mp) && /src\/input\/no-telemetry\.js/.test(mp), 'notices entry 2 names the logger and the guard');
  assert(/guard of its own, in assets\/main-\*\.js and assets\/pose-worker-\*\.js/.test(mp), 'notices entry 2 names the build files that hold the guard (the entries list build files)');
  assert(/no-telemetry\.js/.test(readFileSync(join(ROOT, 'index.html'), 'utf8')), 'index.html\'s "no third-party requests" note points at the guard');
});
