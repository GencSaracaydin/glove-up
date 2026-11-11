// hudvisual fix pass — player-facing words.
//  RELEASE-01: the first-bout tutorial card titles are our own words in BOTH caption sets (camera and
//              keyboard), not the reference's six card titles (research/mechanics.md §8 measured only the
//              steps and their pacing). RV-RELEASE-05: no caption line repeats one of those titles either.
//  Q5:         the keyboard captions and the help screen name every real binding of input/keyboard.js,
//              including E = power punch and X = lean back (P2: 6 = power, / = lean back).
//  VISUAL-14 (a, b) / RELEASE-09: help copy — "fists … block" (plural), and the calibration card's punch
//              count comes from CALIBRATION_DEFAULTS.punchesPerHand (three per hand), never "two punches".
import { test, assert } from '../harness.mjs';
import { tutorialText, tutorialSkipHint, TUTORIAL_STEPS } from '../../src/ui/hud.js';
import * as help from '../../src/ui/screens/help.js';
import * as keyboard from '../../src/input/keyboard.js';
import { CALIBRATION_DEFAULTS } from '../../src/input/calibration.js';

const MODES = ['camera', 'keyboard'];
/** The reference game's card titles, normalised (lower case, no punctuation) — never ours. */
const REFERENCE_TITLES = ['fighting stance', 'guard your face', 'punch the face', 'guard your body', 'punch the body', 'dodge punches'];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
const P1 = keyboard.DEFAULT_KEYMAP.p1;
const P2 = keyboard.DEFAULT_KEYMAP.p2;
const label = (code) => keyboard.keyLabel(code);

test('RELEASE-01: no tutorial card title (camera or keyboard) is a reference title, in any spelling', () => {
  for (const mode of MODES) {
    for (const step of TUTORIAL_STEPS) {
      const { title } = tutorialText(step, mode);
      assert(!REFERENCE_TITLES.includes(norm(title)), `${mode}/${step}: "${title}" is the reference's own card title`);
      for (const ref of REFERENCE_TITLES) assert(!norm(title).includes(ref), `${mode}/${step}: "${title}" contains "${ref}"`);
    }
  }
});

test('RV-RELEASE-05: no tutorial caption line (camera or keyboard) or skip hint repeats a reference card title either', () => {
  const lines = [];
  for (const mode of MODES) {
    for (const step of TUTORIAL_STEPS) lines.push(...tutorialText(step, mode).caption.map((line) => [`${mode}/${step}`, line]));
    lines.push([`${mode}/skip`, tutorialSkipHint(mode)]);
  }
  assert.equal(lines.length, 2 * (6 * 2 + 1), 'every caption line of both sets is scanned');
  for (const [where, line] of lines) {
    for (const ref of REFERENCE_TITLES) assert(!norm(line).includes(ref), `${where}: "${line}" contains the reference title "${ref}"`);
  }
  // the two keyboard captions reworded in the repair round keep their meaning and the real keys
  assert.equal(tutorialText('guard-body', 'keyboard').caption[0], 'Hold B to cover your belly.');
  assert.equal(tutorialText('punch-body', 'keyboard').caption[0], 'Hold Shift and tap J or K for body shots.');
});

test('RELEASE-01: six distinct titles per mode, the same wording in both modes, short enough for the card bar', () => {
  for (const mode of MODES) {
    const titles = TUTORIAL_STEPS.map((s) => tutorialText(s, mode).title);
    assert.equal(new Set(titles.map(norm)).size, 6, `${mode}: six different titles (${titles.join(' / ')})`);
    // the title bar (19rem card, six pips) holds ~15 characters of Lilita One at 1.55rem without clipping
    for (const t of titles) assert(t.length >= 4 && t.length <= 15, `${mode}: "${t}" fits the title bar`);
  }
  for (const step of TUTORIAL_STEPS) assert.equal(tutorialText(step, 'camera').title, tutorialText(step, 'keyboard').title, `${step}: one name for the step whatever the input`);
  // the step ids are unchanged (integration, tests and the e2e run key on them)
  assert.deepEqual([...TUTORIAL_STEPS], ['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge']);
});

test('Q5: the keyboard tutorial names E (power punch) and X (lean back) — the real P1 bindings', () => {
  const power = label(P1.power[0]);
  const back = label(P1.leanBack[0]);
  assert.equal(power, 'E', 'keyboard.js binds the power punch to E');
  assert.equal(back, 'X', 'keyboard.js binds the back lean to X');
  const stance = tutorialText('stance', 'keyboard').caption.join(' ');
  assert(new RegExp(`\\b${power}\\b[^.]*power`, 'i').test(stance), `the keys overview explains ${power} = power: "${stance}"`);
  assert(new RegExp(`\\b${back}\\b leans back`, 'i').test(stance), `the keys overview explains ${back} = lean back: "${stance}"`);
  const dodge = tutorialText('dodge', 'keyboard').caption.join(' ');
  assert(new RegExp(`\\b${back}\\b to lean back`).test(dodge), `the dodge card offers the back lean: "${dodge}"`);
  // every key a keyboard caption names is a real P1 binding
  const p1Labels = new Set(Object.values(P1).flat().map(label));
  for (const step of TUTORIAL_STEPS) {
    const text = tutorialText(step, 'keyboard').caption.join(' ');
    for (const m of text.matchAll(/\b(?:Hold|Tap|and|or|,)\s+([A-Z]|Space|Shift)\b(?= |,|\.)/g)) assert(p1Labels.has(m[1]), `${step}: "${m[1]}" is bound in DEFAULT_KEYMAP.p1`);
  }
  for (const mode of MODES) for (const step of TUTORIAL_STEPS) for (const line of tutorialText(step, mode).caption) assert(line.length <= 70, `${mode}/${step} caption line fits the band: "${line}"`);
});

test('Q5: the help key table lists power punch, lean back and lean in from the real keymap (and the fallback agrees)', () => {
  assert.equal(typeof help.keyRows, 'function', 'help.js exports keyRows');
  const flat = (rows) => Object.fromEntries(rows.map(([a, parts]) => [a, parts.filter((p) => typeof p === 'object').map((p) => p.k)]));
  const live = flat(help.keyRows(keyboard));
  assert.deepEqual(live['Power punch'], P1.power.map(label), 'Power punch = hold E + punch');
  assert.deepEqual(live['Lean back / in'], [...new Set([...P1.leanBack, ...P1.leanIn].map(label))], 'Lean back / in = X W');
  for (const [action, keys] of Object.entries({ 'Left / right punch': ['punchLeft', 'punchRight'], 'Body shot': ['body'], 'High guard': ['guardHigh'], 'Low guard': ['guardLow'], 'Lean left / right': ['leanLeft', 'leanRight'], Duck: ['duck'], Pause: ['pause'] })) {
    assert.deepEqual(live[action], [...new Set(keys.flatMap((k) => P1[k]).map(label))], action);
  }
  assert.deepEqual(flat(help.keyRows(null)), live, 'the built-in fallback shows the same keys as the real keymap');
  const cols = help.keyRows(keyboard).map((r) => r[2]);
  assert(cols.includes(0) && cols.includes(1), 'two columns (punches | defence) so the table fits without scrolling');
});

test('Q5: the P2 line names the real P2 keys, including power and lean back', () => {
  assert.equal(typeof help.p2KeysText, 'function', 'help.js exports p2KeysText');
  const live = help.p2KeysText(keyboard);
  const first = (a) => label(P2[a][0]);
  assert(live.includes(`${first('power')} for a power punch`), `P2 power: "${live}"`);
  assert(live.includes(`back with ${first('leanBack')}`), `P2 lean back: "${live}"`);
  for (const a of ['punchLeft', 'punchRight', 'hookLeft', 'hookRight', 'uppercutLeft', 'uppercutRight', 'body', 'guardHigh', 'guardLow', 'leanLeft', 'leanRight', 'duck', 'leanIn']) {
    assert(live.includes(first(a)), `P2 ${a} (${first(a)}) is named`);
  }
  assert.equal(help.p2KeysText(null), live, 'the fallback sentence matches the real keymap');
});

test('VISUAL-14a: the Guard card agrees in number ("fists … block")', () => {
  assert(Array.isArray(help.MOVES), 'help.js exports MOVES');
  const guard = help.MOVES.find((m) => m.title === 'Guard');
  assert(guard, 'a Guard card');
  assert(!/\bfists\b[^.;]*\bblocks\b/i.test(guard.text), `plural subject, plural verb: "${guard.text}"`);
  assert(/Fists up by your chin block head punches/.test(guard.text), guard.text);
  assert(/fists in front of your belly block body shots/i.test(guard.text), guard.text);
});

test('VISUAL-14b / RELEASE-09: the calibration card counts the punches the calibration asks for (three per hand)', () => {
  assert.equal(typeof help.calibrationText, 'function', 'help.js exports calibrationText');
  const n = CALIBRATION_DEFAULTS.punchesPerHand;
  assert.equal(n, 3, 'the calibration asks for 3 punches with each hand');
  const text = help.calibrationText(n);
  assert(/\bthree punches per hand\b/.test(text), text);
  assert(!/two punches/.test(text), 'never "two punches"');
  const card = help.setupCards({ punchesPerHand: n }).find((c) => c.title === 'Calibration');
  assert.equal(card.text, text);
  assert.equal(help.setupCards().find((c) => c.title === 'Calibration').text, text, 'the fallback (module not loaded yet) says three as well');
  assert(/\bfour punches per hand\b/.test(help.calibrationText(4)), 'follows the calibration if it changes');
  assert(/\bone punch per hand\b/.test(help.calibrationText(1)));
  for (const c of [...help.MOVES, ...help.setupCards({ punchesPerHand: n })]) assert(!/two punches/.test(c.text), `${c.title}: "${c.text}"`);
});

test('help: the Menus card teaches click / tap and the keys — no raised-hand pointer any more', () => {
  const menus = help.setupCards().find((c) => c.title === 'Menus');
  assert(/click|tap/i.test(menus.text) && /arrow keys|enter/i.test(menus.text), menus.text);
  assert(!/one hand high|other arm down|to point|ring fills|twice to quit/i.test(menus.text), menus.text);
});
