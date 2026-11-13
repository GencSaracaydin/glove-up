// Settings → Play → "Bigger camera picture" (settings.pipLarge, 2026-11-13: the user records a demo and wants the webcam
// view larger): saved like every setting, off by default, applied to the HUD's picture-in-picture.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { Storage } from '../../src/core/storage.js';
import { makeBackend, makeDeterministic } from './storage-fakes.test.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('pipLarge: off by default, saved when switched on, and anything but true reads as off', () => {
  const backend = makeBackend();
  const store = new Storage({ backend, ...makeDeterministic() });
  assert.equal(store.settings().pipLarge, false);
  const res = store.saveSettings({ pipLarge: true });
  assert.equal(res.settings.pipLarge, true);
  assert.equal(new Storage({ backend }).settings().pipLarge, true, 'kept after a reload');
  assert.equal(store.saveSettings({ pipLarge: 'yes' }).settings.pipLarge, false);
});

test('pipLarge: the Play tab offers it, the UI hands it to the HUD, and the HUD sizes the picture', () => {
  assert(/row\('Bigger camera picture', [^\n]*change\('pipLarge', v\)/.test(read('src/ui/screens/settings.js')), 'a switch in Settings → Play');
  assert(/this\.hud\.setPipLarge\(this\._settings\.pipLarge === true\)/.test(read('src/ui/ui.js')), 'applySettings passes it on');
  const hud = read('src/ui/hud.js');
  assert(/setPipLarge\(on\) \{ this\._pipLarge = !!on; this\.pip\?\.classList\?\.toggle\('is-large', this\._pipLarge\); \}/.test(hud));
  assert(/class: `gu-hud__pip\$\{this\._pipLarge \? ' is-large' : ''\}`/.test(hud), 'a rebuilt HUD (every bout) keeps the size');
  const css = read('src/ui/styles.css');
  const width = (sel) => Number((css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*?width: ([\\d.]+)rem`)) || [])[1]);
  assert(width('.gu-hud__pip.is-large') > width('.gu-hud__pip') * 1.5, 'clearly bigger than the small view');
  assert(/\.gu-hud__pip\.is-large:not\(\[hidden\]\) ~ \.gu-handswarn \{\s*top: /.test(css), 'the hands warning moves below a big picture');
});
