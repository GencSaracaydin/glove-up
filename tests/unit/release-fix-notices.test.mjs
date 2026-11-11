// RELEASE-02: public/THIRD_PARTY_NOTICES.txt (copied into every build) attributes everything the game
// ships that is not ours: three.js (MIT), MediaPipe Tasks Vision + its wasm (Apache-2.0), the pose models
// (Apache-2.0 per the model card), Lilita One and Nunito (OFL-1.1) and Vite's preload helper (MIT),
// with the full licence texts, verbatim. A new or upgraded dependency fails here until the file
// is updated. vite.config.js also keeps the licence comments in the minified chunks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = join(ROOT, 'node_modules');
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
const notices = () => norm(readFileSync(join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8'));
const pkgJson = (name) => JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8'));

test('notices: public/THIRD_PARTY_NOTICES.txt exists and names every runtime dependency at its installed version', () => {
  const text = notices();
  const deps = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies;
  assert(Object.keys(deps).length >= 4, 'three, tasks-vision and the two font packages');
  for (const name of Object.keys(deps)) {
    const v = pkgJson(name).version;
    assert(text.includes(`"${name}"`), `${name} is listed`);
    assert(new RegExp(`${v.replace(/\./g, '\\.')}\\b`).test(text), `${name} ${v} (installed version) is listed`);
  }
  assert(text.includes(`Vite ${pkgJson('vite').version}`), 'Vite (its preload helper ships in the build) at the installed version');
});

test('notices: the MIT text of three.js and the OFL texts of both fonts are included verbatim', () => {
  const text = notices();
  for (const file of ['three/LICENSE', '@fontsource/lilita-one/LICENSE', '@fontsource/nunito/LICENSE']) {
    assert(text.includes(norm(readFileSync(join(NM, file), 'utf8'))), `${file} verbatim`);
  }
  assert(/Copyright © 2010-2026 three\.js authors/.test(text), 'three.js copyright line');
  assert(/Reserved Font Names "Lilita One"/.test(text), 'Lilita One copyright + reserved name');
  assert(/Copyright 2014 The Nunito Project Authors/.test(text), 'Nunito copyright');
});

test('notices: the full Apache License 2.0 text is included (MediaPipe runtime and models)', () => {
  const text = notices();
  // the licence terms, from the copy in playwright-core (identical Apache-2.0 text up to its appendix)
  const pw = norm(readFileSync(join(NM, 'playwright-core', 'LICENSE'), 'utf8'));
  const terms = pw.slice(0, pw.indexOf('END OF TERMS AND CONDITIONS') + 'END OF TERMS AND CONDITIONS'.length);
  assert(terms.length > 9000 && terms.startsWith('Apache License'), 'reference terms found');
  assert(text.includes(terms), 'Apache-2.0 terms (sections 1-9) verbatim');
  assert(text.includes('Copyright [yyyy] [name of copyright owner]'), 'the standard appendix, not a vendor copyright line');
  assert(!/Portions Copyright \(c\) Microsoft/.test(text), 'no copyright lines of an unrelated project');
});

test('notices: Vite\'s MIT text is included verbatim (its module-preload helper ships in the build)', () => {
  const head = norm(readFileSync(join(NM, 'vite', 'LICENSE.md'), 'utf8')).split('# Licenses of bundled dependencies')[0];
  const mit = head.slice(head.indexOf('MIT License')).trim();
  assert(mit.includes('VoidZero Inc. and Vite contributors') && mit.length > 900, 'reference text found');
  assert(notices().includes(mit), 'Vite MIT text verbatim');
});

test('notices: the pose models are listed with the licence source and the SHA-256 sums setup:models enforces', async () => {
  const text = notices();
  const { MODELS } = await import(pathToFileURL(join(ROOT, 'scripts', 'fetch-models.mjs')).href);
  for (const [name, spec] of Object.entries(MODELS)) {
    assert(new RegExp(`${name.replace('.', '\\.')}\\s+${spec.sha256}`).test(text), `${name} with sha256 ${spec.sha256}`);
  }
  assert(text.includes('Model%20Card%20BlazePose%20GHUM%203D.pdf'), 'the model card URL');
  assert(/Licensed under: Apache License, Version 2\.0/.test(text), 'what the model card says');
});

/** Every .js file under src/ (the game's own code). */
function srcFiles(dir = join(ROOT, 'src')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p)); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('notices: three.js add-ons the game imports are named in entry 1 with assets/main-*.js (RV-RELEASE-04)', () => {
  const text = notices();
  const entry1 = text.slice(text.indexOf('1. three.js'), text.indexOf('\n2. '));
  assert(entry1.includes('assets/three-*.js'), 'the three.js chunk');
  // three/addons/… and three/examples/jsm/… are bundled into the app chunk, not into assets/three-*.js
  const addons = new Set();
  for (const f of srcFiles()) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"]three\/(?:addons|examples\/jsm)\/(?:[\w-]+\/)*([\w-]+)\.js['"]/g)) addons.add(m[1]);
  }
  if (!addons.size) return;
  assert(entry1.includes('assets/main-*.js'), `entry 1 must say the add-ons (${[...addons].join(', ')}) are inside assets/main-*.js`);
  for (const a of addons) assert(entry1.includes(a), `entry 1 names the add-on ${a}`);
});

test('notices: the build keeps licence comments (three.js @license, MediaPipe banner in every chunk that bundles it)', async () => {
  const cfg = (await import(pathToFileURL(join(ROOT, 'vite.config.js')).href)).default;
  assert.equal(cfg.esbuild?.legalComments, 'inline', 'esbuild keeps /*! / @license comments (Vite default: none)');
  for (const banner of [cfg.build.rollupOptions.output.banner, cfg.worker?.rollupOptions?.output?.banner]) {
    assert.equal(typeof banner, 'function', 'banner for main chunks and the worker');
    const mp = banner({ name: 'mediapipe', moduleIds: [join(NM, '@mediapipe/tasks-vision/vision_bundle.mjs')] });
    assert(mp.startsWith('/*!') && mp.includes('Apache-2.0') && mp.includes(pkgJson('@mediapipe/tasks-vision').version) && mp.includes('THIRD_PARTY_NOTICES.txt'), mp);
    assert.equal(banner({ name: 'main', moduleIds: [join(ROOT, 'src/main.js')] }), '', 'our own chunks get no third-party banner');
  }
});
