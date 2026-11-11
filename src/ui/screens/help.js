// How to play: camera setup and distance, punches (aim high/low, hooks, uppercuts), guard, dodge,
// duck, counters, getting up, pausing, menus, and the keyboard keys.
//   params: {}
//   result: { action: 'back' }
//
// The keyboard tab and the calibration card read the real values when those modules are loaded
// (ctx.deps: input/keyboard.js DEFAULT_KEYMAP + keyLabel, input/calibration.js CALIBRATION_DEFAULTS),
// with built-in fallbacks that match them. The data helpers are exported for tests.

import { h, icon, tabs, pageHeader } from './kit.js';

/** Moves tab (camera play). */
export const MOVES = Object.freeze([
  { icon: 'bolt', title: 'Punch', text: 'Thrust a fist straight at the screen. The glove on the same side punches — left arm, left glove.' },
  { icon: 'target', title: 'Head or body', text: 'Punch at face height to hit the head. Punch from lower down, at belly height, for a body shot.' },
  { icon: 'glove', title: 'Hooks & uppercuts', text: 'Swing round with your elbow up for a hook. Scoop up from below your chin for an uppercut.' },
  { icon: 'shield', title: 'Guard', text: 'Fists up by your chin block head punches; fists in front of your belly block body shots.' },
  { icon: 'lean', title: 'Dodge', text: 'Lean your head and shoulders left, right or back to slip a punch at your head.' },
  { icon: 'duck', title: 'Duck', text: 'Dip your head down to duck straights and hooks. Uppercuts still catch you!' },
  { icon: 'sparkle', title: 'Counter', text: 'Dodge as the punch comes, then punch straight away: time slows and your counter does extra damage.' },
  { icon: 'restart', title: 'Knocked down?', text: 'Pump your arms (or keep punching) to get back up before the count reaches 10.' },
]);

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * Calibration card text, built from the calibration's own punch count
 * (input/calibration.js CALIBRATION_DEFAULTS.punchesPerHand: 3 with the left hand, then 3 with the right).
 * @param {number} [punchesPerHand]
 */
export function calibrationText(punchesPerHand = 3) {
  const n = Math.round(Number(punchesPerHand));
  const ok = Number.isFinite(n) && n >= 1;
  const count = ok ? NUMBER_WORDS[n] || String(n) : 'three';
  const punches = ok && n === 1 ? 'punch' : 'punches';
  return `A 20-second check (guard, right hand up, ${count} ${punches} per hand) tunes punches to your reach. Saved with your boxer.`;
}

/** Setup tab cards. `punchesPerHand` comes from the calibration module when it is loaded. */
export function setupCards({ punchesPerHand } = {}) {
  return [
    { icon: 'move', title: 'Where to stand', text: 'About 1–2 m from the camera so your head, shoulders and both hands fit in the picture. Light in front of you, not behind.' },
    { icon: 'gloves', title: 'Two players', text: 'In Versus, P1 stands on the left of the picture and P2 on the right. Keep a little gap between you.' },
    { icon: 'pause', title: 'Pausing', text: 'Hold both hands up above your head for a second, or press Esc or P. If your hands leave the picture the fight pauses by itself, and carries on once we see them again.' },
    // (no longer than the old hand-pointer card: a longer card adds a line and makes the Setup tab scroll at 1280×720)
    { icon: 'keyboard', title: 'Menus', text: 'Click or tap a button, or use the arrow keys and Enter. Esc goes back.' },
    { icon: 'target', title: 'Calibration', text: calibrationText(punchesPerHand) },
    { icon: 'eyeoff', title: 'Privacy', text: 'The camera picture never leaves this computer. Tracking runs in your browser.' },
  ];
}

// Key rows: [action, parts, column]; parts are plain text or {k: 'Key'} for a key cap.
// Column 0 = punches, 1 = defence and pause (two tables side by side, so every key fits without scrolling).
const FALLBACK_KEYS = [
  ['Left / right punch', [{ k: 'J' }, { k: 'K' }], 0], ['Left / right hook', [{ k: 'U' }, { k: 'I' }], 0],
  ['Left / right uppercut', [{ k: 'N' }, { k: 'M' }], 0], ['Body shot', ['hold', { k: 'Shift' }, '+ punch'], 0],
  ['Power punch', ['hold', { k: 'E' }, '+ punch'], 0],
  ['High guard', ['hold', { k: 'Space' }], 1], ['Low guard', ['hold', { k: 'B' }], 1],
  ['Lean left / right', [{ k: 'A' }, { k: 'D' }], 1], ['Lean back / in', [{ k: 'X' }, { k: 'W' }], 1],
  ['Duck', [{ k: 'S' }], 1], ['Pause', [{ k: 'Esc' }, { k: 'P' }], 1],
];

/**
 * P1 key rows from input/keyboard.js (DEFAULT_KEYMAP.p1 + keyLabel), or the built-in fallback.
 * @returns {Array<[string, Array<string|{k:string}>, 0|1]>}
 */
export function keyRows(mod) {
  const map = mod?.DEFAULT_KEYMAP?.p1;
  const label = typeof mod?.keyLabel === 'function' ? mod.keyLabel : null;
  if (!map || !label) return FALLBACK_KEYS;
  const keys = (...actions) => actions.flatMap((a) => [...new Set((map[a] || []).map(label))]).map((k) => ({ k }));
  const rows = [
    ['Left / right punch', keys('punchLeft', 'punchRight'), 0],
    ['Left / right hook', keys('hookLeft', 'hookRight'), 0],
    ['Left / right uppercut', keys('uppercutLeft', 'uppercutRight'), 0],
    ['Body shot', ['hold', ...keys('body'), '+ punch'], 0],
    ['Power punch', ['hold', ...keys('power'), '+ punch'], 0],
    ['High guard', ['hold', ...keys('guardHigh')], 1],
    ['Low guard', ['hold', ...keys('guardLow')], 1],
    ['Lean left / right', keys('leanLeft', 'leanRight'), 1],
    ['Lean back / in', keys('leanBack', 'leanIn'), 1],
    ['Duck', keys('duck'), 1],
    ['Pause', keys('pause'), 1],
  ];
  return rows.filter(([, parts]) => parts.some((p) => typeof p === 'object'));
}

/**
 * The versus line for P2, from DEFAULT_KEYMAP.p2 (the first, top-row key of each action) or the fallback.
 * @returns {string}
 */
export function p2KeysText(mod) {
  const map = mod?.DEFAULT_KEYMAP?.p2;
  const label = typeof mod?.keyLabel === 'function' ? mod.keyLabel : null;
  const k = (action, fallback) => (map && label && map[action]?.length ? label(map[action][0]) : fallback);
  return `Versus on one keyboard: P2 punches with ${k('punchLeft', '1')} / ${k('punchRight', '2')} `
    + `(hooks ${k('hookLeft', '4')} / ${k('hookRight', '5')}, uppercuts ${k('uppercutLeft', '7')} / ${k('uppercutRight', '8')}), `
    + `holds ${k('body', '3')} for a body shot and ${k('power', '6')} for a power punch, `
    + `guards with ${k('guardHigh', '0')} (high) and ${k('guardLow', '9')} (low), `
    + `leans with ${k('leanLeft', '←')} / ${k('leanRight', '→')}, ducks with ${k('duck', '↓')}, `
    + `leans in with ${k('leanIn', '↑')} and back with ${k('leanBack', '/')}.`;
}

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'help',
  title: 'How to play',
  create(ctx) {
    const card = (m) => h('div', { class: 'gu-helpcard' }, h('span', { class: 'gu-helpcard__icon' }, icon(m.icon)), h('h3', { class: 'gu-helpcard__title', text: m.title }), h('p', { class: 'gu-helpcard__text', text: m.text }));
    const keysHost = h('div', { class: 'gu-keys' });
    const keyTable = (rows) => h('table', { class: 'gu-keys__table' }, h('tbody', null, rows.map(([a, parts]) => h('tr', null, h('th', { scope: 'row', text: a }),
      h('td', { class: 'gu-keys__keys' }, parts.map((p) => (typeof p === 'string' ? h('span', { class: 'gu-keys__word', text: p }) : h('kbd', { text: p.k }))))))));
    const fillKeys = (mod) => {
      const rows = keyRows(mod);
      keysHost.replaceChildren(
        h('div', { class: 'gu-keys__cols' }, keyTable(rows.filter((r) => r[2] !== 1)), keyTable(rows.filter((r) => r[2] === 1))),
        h('p', { class: 'gu-keys__p2', text: p2KeysText(mod) }));
    };
    fillKeys(ctx.deps.peek('keyboard'));
    ctx.deps.load('keyboard').then((mod) => fillKeys(mod));
    ctx.deps.load?.('calibration');
    const punchesPerHand = () => ctx.deps.peek('calibration')?.CALIBRATION_DEFAULTS?.punchesPerHand;

    const panel = tabs({
      value: 'moves',
      tabs: [
        { id: 'moves', label: 'Moves', icon: 'glove', build: () => h('div', { class: 'gu-help__grid' }, MOVES.map(card)) },
        {
          id: 'setup', label: 'Setup', icon: 'camera',
          build: () => h('div', { class: 'gu-help__grid gu-help__grid--3' }, setupCards({ punchesPerHand: punchesPerHand() }).map(card)),
        },
        { id: 'keys', label: 'Keyboard', icon: 'keyboard', build: () => keysHost },
      ],
    });

    const el = h('div', { class: 'gu-page gu-help' },
      pageHeader({ title: 'How to play', onBack: () => ctx.ui.back() }),
      h('div', { class: 'gu-panel gu-help__panel' }, panel));
    return { el };
  },
};
