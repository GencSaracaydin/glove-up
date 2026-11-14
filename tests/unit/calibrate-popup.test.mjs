// Calibration screen (a player's request, 2026-11-13): the instruction pops up over the camera picture — one prompt at a
// time with its own progress ring, no step list — and the punch steps start with the RIGHT hand, the one just raised
// (asking for the right hand and then for left punches was confusing). The real screen over the tiny fake DOM, driven by
// a scripted session; the order itself is the real CalibrationSession's (gesture-calibration.test.mjs runs it end to end).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { withDom } from './helpers/fake-dom.mjs';
import calibrate from '../../src/ui/screens/calibrate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function screen(states) {
  let i = 0;
  const S = { done: [], saved: [] };
  const session = { update: () => states[Math.min(i++, states.length - 1)], cancel() {}, result: null };
  const ctx = {
    done: (r) => S.done.push(r), sfx() {}, arm() {}, refocus() {}, toast() {}, settings: () => ({}),
    storage: { updateProfile: (id, patch) => { S.saved.push(patch); return { saved: true }; } },
    deps: { peek: () => null },
    input: { status: { frameAgeMs: 30 }, calibrate: () => session },
    ui: { latestFrame: () => ({ players: [null], t: 0 }), getVideo: () => null, back() {} },
  };
  const inst = calibrate.create(ctx, { name: 'Ana', profile: { id: 'p1', name: 'Ana', kind: 'local' } });
  let t = 0;
  const read = () => {
    const pop = inst.el.querySelector('.gu-calib__pop');
    return {
      step: inst.el.dataset.step, pop,
      no: inst.el.querySelector('.gu-calib__stepno').textContent,
      title: inst.el.querySelector('.gu-calib__title').textContent,
      msg: inst.el.querySelector('.gu-calib__msg'),
    };
  };
  return { inst, S, read, next: () => { t += 33; inst.update(0.033, t); return read(); } };
}

const st = (step, message, o = {}) => ({ step, message, progress: 0.1, stepProgress: 0, ok: false, done: false, result: null, hint: null, stuck: false, ...o });

test('calibrate screen: one instruction at a time pops up over the camera picture — no step list', () => withDom(() => {
  const s = screen([
    st('frame', 'Step into the picture so the camera can see you.'),
    st('frame', 'Great — hold that spot…', { ok: true, stepProgress: 0.5 }),
    st('guard', 'Now put your gloves up by your face and hold still.'),
    st('right-hand', 'Raise your RIGHT hand straight up above your head.'),
    st('punch-right', 'Nice! Now throw 3 punches with that RIGHT hand at the screen.'),
    st('punch-left', 'Great! Now 3 punches with your LEFT hand.'),
    st('done', 'All set! Gloves up — let’s box.', { done: true, progress: 1, result: { version: 1 } }),
  ]);
  const el = s.inst.el;
  assert.equal(el.querySelectorAll('.gu-calib__steps').length + el.querySelectorAll('.gu-calib__step').length, 0, 'no step list');
  const preview = el.querySelector('.gu-preview');
  let r = s.read();
  assert(r.pop && r.pop.parentNode === preview, 'the prompt sits over the live preview');
  assert(r.step === 'frame' && r.title === 'Step into the picture' && r.no === 'Step 1 of 5' && r.pop.classList.contains('is-pop'));
  r = s.next();
  assert.equal(r.msg.textContent, 'Step into the picture so the camera can see you.');
  r.pop.classList.remove('is-pop');
  r = s.next();
  assert(r.msg.textContent === 'Great — hold that spot…' && r.msg.classList.contains('is-bump'), 'a new message within the step bumps');
  assert(!r.pop.classList.contains('is-pop'), '…without popping the whole prompt again');
  assert(r.pop.classList.contains('is-ok'), 'holding it right turns the prompt green');
  const seen = [];
  for (let k = 0; k < 4; k++) {
    r = s.next();
    assert(r.pop.classList.contains('is-pop'), `${r.step}: a new step pops a new prompt up`);
    r.pop.classList.remove('is-pop');
    seen.push(`${r.step}|${r.no}|${r.title}`);
  }
  assert.deepEqual(seen, [
    'guard|Step 2 of 5|Gloves up!',
    'right-hand|Step 3 of 5|Raise your RIGHT hand',
    'punch-right|Step 4 of 5|Punch with your RIGHT',
    'punch-left|Step 5 of 5|Now punch with your LEFT',
  ]);
  r = s.next();
  assert(r.step === 'done' && r.title === 'All set!' && r.no === 'Done', `done: ${r.step} ${r.title}`);
  assert(s.S.saved.length === 1, 'the result is saved to the boxer');
}));

test('calibrate screen: the pop-up styles exist and the old checklist styles are gone', () => {
  const css = readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert(/\.gu-calib__pop\s*\{[^}]*position:\s*absolute/.test(css), 'the prompt is positioned over the preview');
  assert(/\.gu-calib__pop\.is-pop\s*\{[^}]*animation:\s*gu-calib-pop/.test(css) && /@keyframes gu-calib-pop/.test(css), 'it pops in');
  assert(!/\.gu-calib__steps|\.gu-calib__bullet/.test(css), 'no checklist styles left');
});
