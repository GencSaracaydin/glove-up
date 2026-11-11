// Pure UI helpers (src/ui/screens/kit.js): formatting, result wording (MAT04), navigation
// geometry, graphs, pose visibility (ERR01) and the guard heuristic (ERR02).
import { test, assert, approx } from '../harness.mjs';
import {
  formatClock, formatNumber, formatSigned, percent, optionLabel, ordinal, judgesSummary, describeResult,
  statRows, pickNeighbor, skillSeries, linePath, playerVisibility, guardFromPose, validLook, randomLook,
  randomName, RANDOM_NAMES, contrastInk, medalRank, betterMedal, MEDAL_INFO, TRAINING_INFO, UI_TUNING, shadeHex, fileSafe,
} from '../../src/ui/screens/kit.js';
import { APPEARANCE_OPTIONS, LM } from '../../src/core/types.js';

test('ui kit: clock counts down with ceil and never goes negative', () => {
  assert.equal(formatClock(180000), '3:00');
  assert.equal(formatClock(83000), '1:23');
  assert.equal(formatClock(59001), '1:00');
  assert.equal(formatClock(999), '0:01');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-500), '0:00');
  assert.equal(formatClock(NaN), '0:00');
});

test('ui kit: numbers, signs, percentages, labels', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(999.6), '1,000');
  assert.equal(formatSigned(42), '+42');
  assert.equal(formatSigned(-15), '−15');
  assert.equal(formatSigned(0), '±0');
  assert.equal(percent(61, 112), 54);
  assert.equal(percent(5, 0), 0);
  assert.equal(optionLabel('flat-top'), 'Flat top');
  assert.equal(optionLabel('mouthguard'), 'Mouthguard');
  assert.equal(optionLabel('none'), 'None');
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(23), '23rd');
});

test('ui kit: judges summary kinds', () => {
  const card = (p1, p2) => ({ judge: 'J', p1, p2 });
  assert.equal(judgesSummary([card(30, 27), card(29, 28), card(30, 28)]).kind, 'unanimous');
  assert.equal(judgesSummary([card(29, 28), card(28, 29), card(30, 27)]).kind, 'split');
  assert.equal(judgesSummary([card(29, 28), card(28, 28), card(30, 27)]).kind, 'majority');
  const d = judgesSummary([card(29, 28), card(28, 29), card(28, 28)]);
  assert.equal(d.kind, 'draw');
  assert.equal(d.winner, null);
  assert.equal(judgesSummary([]).kind, 'none');
  assert.equal(judgesSummary(null).total, 0);
});

test('ui kit: MAT04 result wording (single player and versus)', () => {
  const names = { p1: 'Sam', p2: 'Pip' };
  const ko = describeResult({ winner: 'p1', method: 'KO', endRound: 2, endClockMs: 83000 }, { names, humanSide: 'p1' });
  assert.equal(ko.headline, 'YOU WIN!');
  assert.equal(ko.outcome, 'win');
  assert.equal(ko.methodShort, 'KO');
  assert.match(ko.sub, /Pip couldn’t beat the count in round 2 \(1:23/);
  // there is no TKO any more (research/mechanics.md §3.4): an old saved TKO reads as a KO, no referee
  const loss = describeResult({ winner: 'p2', method: 'TKO', endRound: 1 }, { names, humanSide: 'p1' });
  assert.equal(loss.headline, 'YOU LOSE');
  assert.equal(loss.methodShort, 'KO');
  assert.equal(loss.method, 'KO');
  assert(!/referee|T\.K\.O|TKO/i.test(`${loss.sub} ${loss.methodShort}`), 'no TKO / referee wording');
  const vs = describeResult({ winner: 'p2', method: 'decision', scorecards: [{ p1: 28, p2: 29 }, { p1: 28, p2: 30 }, { p1: 29, p2: 28 }] }, { names, humanSide: null });
  assert.equal(vs.headline, 'PIP WINS!');
  assert.equal(vs.outcome, null);
  assert.equal(vs.methodShort, 'Split decision');
  const draw = describeResult({ winner: null, method: 'draw', scorecards: [{ p1: 29, p2: 28 }, { p1: 28, p2: 29 }, { p1: 28, p2: 28 }] }, { names, humanSide: 'p1' });
  assert.equal(draw.headline, 'DRAW!');
  assert.equal(draw.outcome, 'draw');
  assert.equal(draw.methodShort, 'Draw');
});

test('ui kit: punch-stat rows with accuracy', () => {
  const rows = statRows({ p1: { thrown: 10, landed: 4 }, p2: { thrown: 0, landed: 0, knockdownsScored: 2 } });
  const acc = rows.find((r) => r.label === 'Accuracy');
  assert.equal(acc.p1, 40);
  assert.equal(acc.p2, 0);
  assert.equal(acc.unit, '%');
  assert.equal(rows.find((r) => r.label === 'Knockdowns').p2, 2);
  assert.equal(statRows(undefined).length, 7);
});

test('ui kit: spatial navigation picks the nearest in-line neighbour', () => {
  // 3×2 grid of 100×80 tiles with 20px gaps
  const rects = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) rects.push({ left: c * 120, top: r * 100, width: 100, height: 80 });
  assert.equal(pickNeighbor(rects, 0, 'right'), 1);
  assert.equal(pickNeighbor(rects, 0, 'down'), 3);
  assert.equal(pickNeighbor(rects, 4, 'up'), 1);
  assert.equal(pickNeighbor(rects, 4, 'left'), 3);
  assert.equal(pickNeighbor(rects, 2, 'right'), -1, 'no wrap');
  assert.equal(pickNeighbor(rects, 5, 'down'), -1);
  // a wide footer button below the grid is reachable from any column
  rects.push({ left: 0, top: 220, width: 340, height: 70 });
  assert.equal(pickNeighbor(rects, 5, 'down'), 6);
  assert.equal(pickNeighbor(rects, 6, 'up'), 4, 'prefers the tile above its centre');
  assert.equal(pickNeighbor([], 0, 'down'), -1);
});

test('ui kit: skill series + line path geometry', () => {
  const hist = [
    { mode: 'single', skillBefore: 0, skillAfter: 50 },
    { mode: 'versus', skillBefore: 50, skillAfter: 50 },
    { mode: 'single', skillBefore: 50, skillAfter: 120 },
  ];
  assert.deepEqual(skillSeries(hist), [0, 50, 120]);
  assert.deepEqual(skillSeries([]), []);
  const g = linePath([0, 50, 100], { w: 200, h: 100, pad: 10 });
  assert.equal(g.points.length, 3);
  approx(g.points[0].x, 10);
  approx(g.points[2].x, 190);
  approx(g.points[0].y, 90);
  approx(g.points[2].y, 10);
  assert.match(g.d, /^M10 90 L100 50 L190 10$/);
  approx(g.y(50), 50);
  const flat = linePath([7, 7], { w: 100, h: 100, pad: 0 });
  assert(Number.isFinite(flat.points[0].y), 'flat series still has finite geometry');
});

function pose(over = {}) {
  const image = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  const set = (i, x, y) => { image[i] = { x, y, z: 0, visibility: 0.95 }; };
  set(LM.NOSE, 0.5, 0.3);
  set(LM.LEFT_EAR, 0.53, 0.3); set(LM.RIGHT_EAR, 0.47, 0.3);
  set(LM.LEFT_SHOULDER, 0.6, 0.45); set(LM.RIGHT_SHOULDER, 0.4, 0.45);
  set(LM.LEFT_WRIST, 0.66, 0.7); set(LM.RIGHT_WRIST, 0.34, 0.7);
  for (const [i, v] of Object.entries(over)) image[i] = { ...image[i], ...v };
  return { image, world: [], score: 0.9 };
}

test('ui kit: ERR01 player visibility explains what is missing', () => {
  assert.equal(playerVisibility(null).visible, false);
  assert.equal(playerVisibility(null).hint, 'Step into view');
  const ok = playerVisibility(pose());
  assert.equal(ok.visible, true);
  assert.equal(ok.ready, true);
  assert.equal(ok.hint, 'Looking good!');
  const noLeft = playerVisibility(pose({ [LM.LEFT_WRIST]: { visibility: 0.1 } }));
  assert.equal(noLeft.ready, false);
  assert.deepEqual(noLeft.missing, ['left hand']);
  assert.match(noLeft.hint, /left hand/);
  const tooClose = playerVisibility(pose({ [LM.LEFT_SHOULDER]: { x: 0.85 }, [LM.RIGHT_SHOULDER]: { x: 0.15 } }));
  assert.equal(tooClose.ready, false);
  assert.equal(tooClose.hint, 'Step back a little');
  const tooFar = playerVisibility(pose({ [LM.LEFT_SHOULDER]: { x: 0.52 }, [LM.RIGHT_SHOULDER]: { x: 0.48 } }));
  assert.equal(tooFar.hint, 'Come a bit closer');
  const offscreen = playerVisibility(pose({ [LM.RIGHT_WRIST]: { x: 1.3 } }));
  assert.deepEqual(offscreen.missing, ['right hand'], 'landmarks outside the frame do not count');
});

test('ui kit: ERR02 guard heuristic (both fists up by the face)', () => {
  const up = pose({ [LM.LEFT_WRIST]: { x: 0.54, y: 0.33 }, [LM.RIGHT_WRIST]: { x: 0.46, y: 0.33 } });
  assert.equal(guardFromPose(up).guard, true);
  assert.equal(guardFromPose(pose()).guard, false, 'hands down is not a guard');
  const one = pose({ [LM.LEFT_WRIST]: { x: 0.54, y: 0.33 } });
  assert.equal(guardFromPose(one).guard, false, 'one hand up is not a guard');
  const wave = pose({ [LM.LEFT_WRIST]: { x: 0.54, y: 0.05 }, [LM.RIGHT_WRIST]: { x: 0.46, y: 0.05 } });
  assert.equal(guardFromPose(wave).guard, false, 'hands far above the head is not a guard');
  assert.equal(guardFromPose(null).guard, false);
});

test('ui kit: appearance helpers stay inside APPEARANCE_OPTIONS', () => {
  for (let s = 0; s < 25; s++) {
    const a = randomLook(s);
    assert(APPEARANCE_OPTIONS.hairStyles.includes(a.hair.style));
    assert(APPEARANCE_OPTIONS.eyes.includes(a.eyes));
    assert(a.height >= 0.9 && a.height <= 1.1);
  }
  const v = validLook({ eyes: 'nope', hair: 'mohawk' });
  assert(APPEARANCE_OPTIONS.eyes.includes(v.eyes));
  assert.equal(v.label, undefined, 'preset labels are stripped');
  const n = randomName(3, ['Sunny']);
  assert(RANDOM_NAMES.includes(n));
  assert.notEqual(randomName(5, [...RANDOM_NAMES.slice(1)]), undefined);
});

test('ui kit: medals, colours, file names', () => {
  assert.equal(medalRank('gold'), 3);
  assert.equal(betterMedal('silver', 'bronze'), 'silver');
  assert.equal(betterMedal('none', 'platinum'), 'platinum');
  for (const m of ['none', 'bronze', 'silver', 'gold', 'platinum']) assert(MEDAL_INFO[m].label);
  for (const k of ['bag', 'dodge', 'mitts']) assert(TRAINING_INFO[k].rule.length > 20);
  assert.equal(contrastInk('#ffffff'), '#14182b');
  assert.equal(contrastInk('#14182b'), '#fffaf0');
  assert.equal(shadeHex('#ffffff', -0.5), '#808080');
  assert.equal(fileSafe('Sam the Man!'), 'sam-the-man');
  assert.equal(fileSafe(''), 'boxer');
  assert(UI_TUNING.lostResumeMs === 500, 'ERR02: the tracking-lost card carries on 0.5 s after the hands are back');
});
