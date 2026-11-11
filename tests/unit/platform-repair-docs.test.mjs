// RV-RELEASE-02 / RV-RELEASE-03: repository hygiene.
//  * No committed text file (the docs, and also src, tests, dev, scripts, index.html, the notices …) carries an
//    absolute path of the machine it was written on (paths under `/private` or `/Users`: dead links that also
//    expose the account and the session layout) or the folder name of the reference footage, which is its
//    video id ("yt-" and an 11-character id). This file is scanned too, so its examples are built from pieces.
//  * No patch leftovers (*.orig, *.rej) in the tree, and .gitignore keeps them out of a commit. (Applying a
//    patch with fuzz leaves .orig backups behind: this test names them so they get deleted.)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** An absolute macOS / scratch path (under /private or /Users), not inside a longer word or a URL path. */
const ABS_PATH = /(^|[^\w.\/-])\/(?:private|Users)\/[^\s`'")\]]*/;
/** A reference-footage folder named after its video id ("yt-" plus an 11-character id). */
const VIDEO_ID = /\byt-[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/;
/** Text files that would be committed (binaries — the clip, models, wasm, fonts — can't hold a doc link). */
const TEXT = /\.(?:m?js|cjs|md|txt|html|json|css|sh|ya?ml)$|^\.gitignore$/;

function docLeaks(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const p = ABS_PATH.exec(line);
    if (p) hits.push(`${i + 1}: absolute path ${p[0].trim().slice(0, 80)}`);
    const v = VIDEO_ID.exec(line);
    if (v) hits.push(`${i + 1}: video id ${v[0]}`);
  });
  return hits;
}

/** Folders .gitignore keeps out of a commit (its "dir/" lines), plus git's and Vite's own. */
function ignoredDirs() {
  const dirs = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l.endsWith('/') && !l.startsWith('#') && !l.startsWith('!')).map((l) => l.replace(/^\/|\/$/g, ''));
  return new Set([...dirs, '.git']);
}

function* walk(dir, skip = new Set(['node_modules', 'test-results', 'dist', '.git'])) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p).split(sep).join('/');
    if (skip.has(rel) || skip.has(name) || name.startsWith('.vite')) continue;
    if (statSync(p).isDirectory()) yield* walk(p, skip); else yield p;
  }
}

/** Every committed text file, as a path relative to the project. */
function committedTextFiles() {
  return [...walk(ROOT, ignoredDirs())].map((p) => relative(ROOT, p).split(sep).join('/'))
    .filter((f) => TEXT.test(f.split('/').pop()));
}

// examples made of pieces (this file is scanned as well)
const slash = '/';
const example = {
  scratch: `see \`${slash}private/tmp/example/merge/pies.png\``,
  home: `logs in ${slash}Users/someone/Documents/x.txt`,
  video: `frames in scratchpad/${'yt'}-AbCdEfGhIjK/agent1/x.jpg`,
};

test('docs: the leak check catches scratch paths and video ids, not ordinary text', () => {
  assert.equal(docLeaks(example.scratch).length, 1);
  assert.equal(docLeaks(example.home).length, 1);
  assert.equal(docLeaks(example.video).length, 1);
  for (const ok of ['`src/input/no-telemetry.js`', 'http://127.0.0.1:5180/', 'https://example.com/private/x', 'node_modules/@mediapipe/tasks-vision',
    'Copyright (c) 2019-present, VoidZero Inc.', 'pay-to-play', 'ARCHITECTURE.md §2', 'yt-short', `paths under \`${slash}private\` or \`${slash}Users\``]) {
    assert.deepEqual(docLeaks(ok), [], ok);
  }
});

test('docs: README, ARCHITECTURE and research/*.md carry no absolute local paths and no reference video ids', () => {
  const docs = ['README.md', 'ARCHITECTURE.md', ...readdirSync(join(ROOT, 'research')).filter((f) => f.endsWith('.md')).map((f) => `research/${f}`)];
  assert(docs.includes('research/mechanics.md') && docs.includes('research/spec.md'), docs.join());
  const hits = [];
  for (const f of docs) for (const h of docLeaks(readFileSync(join(ROOT, f), 'utf8'))) hits.push(`${f}:${h}`);
  assert(hits.length === 0, `local paths / video ids in committed docs:\n  ${hits.join('\n  ')}`);
});

test('repo: no committed text file (source, tests, dev pages, scripts, notices, this test) carries them either', () => {
  const files = committedTextFiles();
  for (const f of ['src/main.js', 'tests/e2e.mjs', 'tests/unit/platform-repair-docs.test.mjs', 'dev/gesture-lab.js', 'scripts/shot.mjs',
    'public/THIRD_PARTY_NOTICES.txt', 'index.html', 'package.json', 'research/mechanics.md', '.gitignore']) {
    assert(files.includes(f), `scanned: ${f}`);
  }
  assert(!files.some((f) => /^(node_modules|dist|test-results|public\/models|public\/mediapipe)\//.test(f)), 'ignored folders are not scanned');
  const hits = [];
  for (const f of files) for (const h of docLeaks(readFileSync(join(ROOT, f), 'utf8'))) hits.push(`${f}:${h}`);
  assert(hits.length === 0, `local paths / video ids in committed files:\n  ${hits.join('\n  ')}`);
});

test('docs: mechanics.md Appendix C keeps its evidence list without file names or paths', () => {
  const md = readFileSync(join(ROOT, 'research', 'mechanics.md'), 'utf8');
  const c = md.slice(md.indexOf('## Appendix C'));
  assert(c.length > 0 && /Pies have 10 wedges/.test(c) && /Tutorial cards/.test(c), 'the bullets are still there');
  assert(!/`[^`]*\.(?:png|jpe?g)`/.test(c) && !/\.(?:png|jpe?g)\b/.test(c), 'no frame-grab file names');
  assert(/outside the repository/.test(md.slice(md.indexOf('## Appendix B'))), 'says where the scripts and frame grabs went');
});

test('repo: no patch leftovers (*.orig, *.rej), and .gitignore keeps them out of a commit', () => {
  const left = [...walk(ROOT)].filter((p) => /\.(orig|rej)$/.test(p)).map((p) => relative(ROOT, p));
  assert.deepEqual(left, [], `patch leftovers (delete them): ${left.join(', ')}`);
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert(ignore.includes('*.orig') && ignore.includes('*.rej'), '.gitignore lists *.orig and *.rej');
});
