// BUILD-HEADROOM: vite.config.js splits the app into chunks by module layer (core → input / game → main) so that no chunk
// crosses Vite's 1000 kB warning without raising the limit. These checks keep the split free of chunk cycles (Rollup's
// "Circular chunk" warning) as files are added: every static import of a src/ module, mapped through manualChunks, must
// point down the layer order — and nothing outside main may import main.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const cfgModule = () => import(pathToFileURL(join(ROOT, 'vite.config.js')).href);

function srcFiles(dir = SRC, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Static imports / re-exports of relative modules (multi-line import lists included). */
function staticImports(file) {
  const s = readFileSync(file, 'utf8');
  const out = new Set();
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*'(\.[^']+)'/g;
  let m;
  while ((m = re.exec(s))) out.add(normalize(join(dirname(file), m[1])));
  return [...out];
}

const ORDER = ['core', 'input', 'game', 'main']; // an import may only point to an earlier (or the same) layer

test('build chunks: manualChunks keeps the libraries in their own chunks and splits the app by layer', async () => {
  const { manualChunks, default: cfg } = await cfgModule();
  assert.equal(typeof manualChunks, 'function');
  assert.equal(cfg.build.rollupOptions.output.manualChunks, manualChunks, 'the build uses it');
  assert.equal(cfg.build.chunkSizeWarningLimit, 1000, 'the warning limit is not raised');
  const nm = (p) => join(ROOT, 'node_modules', p);
  assert.equal(manualChunks(nm('three/build/three.module.js')), 'three');
  assert.equal(manualChunks(nm('three/build/three.core.js')), 'three');
  assert.equal(manualChunks(nm('three/examples/jsm/environments/RoomEnvironment.js')), undefined, 'addons stay with their users');
  assert.equal(manualChunks(nm('@mediapipe/tasks-vision/vision_bundle.mjs')), 'mediapipe');
  assert.equal(manualChunks(join(SRC, 'core/types.js')), 'core');
  assert.equal(manualChunks(join(SRC, 'core/storage.js')), undefined, 'storage imports game/progression.js: main');
  assert.equal(manualChunks(join(SRC, 'input/gesture.js')), 'input');
  assert.equal(manualChunks(join(SRC, 'input/pose-worker-tracker.js')), 'input');
  assert.equal(manualChunks(join(SRC, 'game/match.js')), 'game');
  assert.equal(manualChunks(join(SRC, 'training/bag.js')), 'game');
  for (const f of ['main.js', 'app/app.js', 'render/renderer.js', 'ui/ui.js', 'audio/audio.js']) assert.equal(manualChunks(join(SRC, f)), undefined, f);
  // Windows paths too
  assert.equal(manualChunks('C:\\x\\src\\input\\camera.js'), 'input');
});

test('build chunks: every src import points down the layer order (no chunk cycle, nothing imports main)', async () => {
  const { manualChunks } = await cfgModule();
  const chunkOf = (f) => manualChunks(f) || 'main';
  const bad = [];
  let edges = 0;
  for (const f of srcFiles()) {
    const from = chunkOf(f);
    for (const dep of staticImports(f)) {
      const to = chunkOf(dep);
      edges++;
      if (ORDER.indexOf(to) > ORDER.indexOf(from)) bad.push(`${relative(ROOT, f)} (${from}) → ${relative(ROOT, dep)} (${to})`);
    }
  }
  assert(edges > 100, `the import scan found the imports (${edges})`);
  assert.deepEqual(bad, [], `imports against the layer order:\n${bad.join('\n')}`);
});
