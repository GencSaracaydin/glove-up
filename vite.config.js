import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Licence notices in the minified chunks (RELEASE-02). three.js brings its own "@license" header,
// which esbuild keeps with legalComments 'inline' (Vite's default, 'none', strips it). MediaPipe's
// bundle has no header, so every chunk that contains it (the mediapipe chunk and the pose worker)
// gets a short one. The full licence texts are in public/THIRD_PARTY_NOTICES.txt, which the build
// copies next to index.html.
let mediapipeVersion = '';
try {
  mediapipeVersion = JSON.parse(readFileSync(resolve(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8')).version;
} catch { /* not installed: nothing to bundle either */ }
const MEDIAPIPE_BANNER = `/*! @mediapipe/tasks-vision ${mediapipeVersion} | (c) The MediaPipe Authors | Apache-2.0 | licence: THIRD_PARTY_NOTICES.txt */`;
const licenseBanner = (chunk) =>
  (chunk.moduleIds || []).some((id) => /[\\/]node_modules[\\/]@mediapipe[\\/]tasks-vision[\\/]/.test(id)) ? MEDIAPIPE_BANNER : '';

// Chunks (BUILD-HEADROOM): the libraries in their own long-cacheable chunks, as before; and the app split along its module
// layers so that no chunk crosses the 1000 kB warning (the app alone was ≈ 1054 kB after the input round):
//   core   src/core/{types,events,rng}.js   shared leaf modules: everything imports them, they import nothing
//   input  src/input/**                     the camera → pose → gesture pipeline (imports core and mediapipe only)
//   game   src/game/** and src/training/**  bouts, AI, drills (import core only; training imports game)
//   main   app, render, ui, audio, and core/storage.js (it imports game/progression.js, and only main imports it)
// Every arrow points down that list, so there is no chunk cycle (tests/unit/build-chunks.test.mjs checks the import graph).
// three is matched by its build folder only, like the former { three: ['three'] }: its addons stay with the code using them.
// The pose worker is a separate build (worker.rollupOptions below), which this does not touch.
const CHUNKS = [
  [/[\\/]node_modules[\\/]three[\\/]build[\\/]/, 'three'],
  [/[\\/]node_modules[\\/]@mediapipe[\\/]tasks-vision[\\/]/, 'mediapipe'],
  [/[\\/]src[\\/]core[\\/](types|events|rng)\.js$/, 'core'],
  [/[\\/]src[\\/]input[\\/]/, 'input'],
  [/[\\/]src[\\/](game|training)[\\/]/, 'game'],
];
export function manualChunks(id) {
  for (const [re, name] of CHUNKS) if (re.test(id)) return name;
  return undefined;
}

export default defineConfig({
  // GLOVE_VITE_CACHE_DIR (tests/e2e.mjs sets one per port): a private dependency cache, so another Vite
  // server on this checkout re-optimizing the shared node_modules/.vite cannot break a running test page
  ...(process.env.GLOVE_VITE_CACHE_DIR ? { cacheDir: process.env.GLOVE_VITE_CACHE_DIR } : {}),
  server: {
    host: '127.0.0.1',
    port: 5180,
    // GLOVE_NO_HMR=1 (tests/e2e.mjs sets it): no hot reload — an editor saving a file mid-run must
    // not reload the page under a running scenario
    ...(process.env.GLOVE_NO_HMR ? { hmr: false, watch: null } : {}),
  },
  // keep third-party "@license" / "/*!" comments in minified output (see above)
  esbuild: { legalComments: 'inline' },
  build: {
    target: 'es2022',
    // a 3D game: three.js alone is ~580 kB minified; the app is split into layers below that (CHUNKS above)
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
      output: {
        // libraries in their own long-cacheable chunks, the app by module layer (see CHUNKS)
        manualChunks,
        banner: licenseBanner,
      },
    },
  },
  worker: {
    rollupOptions: { output: { banner: licenseBanner } },
  },
});
