// RELEASE-03 / PERF-06 / VISUAL-07 (D7): the fonts are self-hosted. index.html loads nothing from
// another host (no Google Fonts CSS that blocks the first paint and fails offline), and
// src/ui/fonts.css brings Lilita One 400 and Nunito 400/700/800/900 from the pinned @fontsource
// packages under the family names the CSS and the canvas code use.
// (The browser side, zero third-party requests online and offline in dev and in a build, is checked by
// tests/e2e.mjs, which fails a scenario on any request to another host.)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const WANT = [['lilita-one', 'Lilita One', 400], ['nunito', 'Nunito', 400], ['nunito', 'Nunito', 700], ['nunito', 'Nunito', 800], ['nunito', 'Nunito', 900]];

test('fonts: index.html loads nothing from another host (no Google Fonts)', () => {
  const html = read('index.html');
  assert(!/fonts\.(googleapis|gstatic)\.com/.test(html), 'Google Fonts links are gone');
  const external = [...html.matchAll(/<(link|script)\b[^>]*\b(?:href|src)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/gi)].map((m) => m[0]);
  assert.deepEqual(external, [], `no <link>/<script> to another host: ${external.join(' | ')}`);
  assert(!/rel=["']preconnect["']/.test(html), 'no preconnect to a font CDN');
});

test('fonts: index.html links src/ui/fonts.css before styles.css', () => {
  const html = read('index.html');
  const fonts = html.search(/<link[^>]+href=["']\/src\/ui\/fonts\.css["']/);
  const styles = html.search(/<link[^>]+href=["']\/src\/ui\/styles\.css["']/);
  assert(fonts >= 0, 'fonts.css is linked');
  assert(styles > fonts, 'fonts.css comes first, so the faces exist before the styles use them');
});

test('fonts: fonts.css imports exactly Lilita One 400 and Nunito 400/700/800/900 from @fontsource', () => {
  const css = read('src/ui/fonts.css');
  const imports = [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['@fontsource/lilita-one/400.css', '@fontsource/nunito/400.css', '@fontsource/nunito/700.css', '@fontsource/nunito/800.css', '@fontsource/nunito/900.css']);
  assert(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no URL to another host');
});

test('fonts: each imported face is declared with the expected family and weight, its woff2 file exists', () => {
  for (const [pkg, family, weight] of WANT) {
    const dir = join(ROOT, 'node_modules', '@fontsource', pkg);
    const css = readFileSync(join(dir, `${weight}.css`), 'utf8');
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert(faces.length >= 1, `${pkg}/${weight}.css declares faces`);
    for (const f of faces) {
      assert(new RegExp(`font-family:\\s*'${family}'`).test(f), `${pkg}/${weight}: family ${family}`);
      assert(new RegExp(`font-weight:\\s*${weight}\\b`).test(f), `${pkg}/${weight}: weight`);
      assert(/font-display:\s*swap/.test(f), `${pkg}/${weight}: font-display swap (text never waits for the font)`);
      assert(!/url\(\s*['"]?https?:/.test(f), `${pkg}/${weight}: local files only`);
      const woff2 = f.match(/url\(([^)]+\.woff2)\)/)?.[1];
      assert(woff2 && existsSync(join(dir, woff2)), `${pkg}/${weight}: ${woff2} exists`);
    }
    // the latin subset (every UI string) is among them
    assert(faces.some((f) => f.includes(`${pkg}-latin-${weight}-normal.woff2`)), `${pkg}/${weight}: latin subset`);
  }
});

test('fonts: the font packages are pinned and installed at that version', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['@fontsource/lilita-one', '@fontsource/nunito']) {
    const want = pkg.dependencies[name];
    assert(/^\d+\.\d+\.\d+$/.test(want || ''), `${name} pinned to an exact version (${want})`);
    const have = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    assert.equal(have, want, `${name} installed version`);
  }
});

test('fonts: the families the CSS and the 3D text ask for are the self-hosted ones', () => {
  const first = (stack) => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const styles = read('src/ui/styles.css');
  for (const v of ['--font-display', '--font-body']) {
    const m = styles.match(new RegExp(`${v}:\\s*([^;]+);`));
    assert(m, `styles.css defines ${v}`);
    assert(['Lilita One', 'Nunito'].includes(first(m[1])), `${v} starts with a self-hosted family (${first(m[1])})`);
  }
  const style = read('src/render/style.js');
  for (const fam of ['Lilita One', 'Nunito']) assert(style.includes(`'${fam}'`), `render/style.js still names ${fam}`);
});
