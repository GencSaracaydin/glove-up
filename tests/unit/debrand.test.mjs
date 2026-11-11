// Debranding guard: the game must not mention the reference game, its console, its maker
// or its avatar system anywhere in source, docs, UI strings or file names.
// Patterns are built from char codes so this file itself stays clean.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const words = [
  [87, 105, 105],                         // console
  [78, 105, 110, 116, 101, 110, 100, 111], // maker
  [77, 105, 105],                          // avatar system
].map((codes) => String.fromCharCode(...codes));
const re = new RegExp(`\\b(${words.join('|')})(s|'s)?\\b`, 'i');

const SKIP = new Set(['node_modules', 'dist', '.git', 'public', 'test-results', 'recordings']);
const EXT = /\.(js|mjs|cjs|ts|html|css|md|json|txt|svg)$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('debrand: no reference-game brand names in files or file names', () => {
  const hits = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (re.test(rel)) hits.push(`${rel}: (file name)`);
    if (!EXT.test(file) || rel === 'package-lock.json') continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => { if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert(hits.length === 0, `brand names found:\n${hits.join('\n')}`);
});
