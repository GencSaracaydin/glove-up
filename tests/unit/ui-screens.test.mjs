// Pure models behind the reworked screens (src/ui/screens/kit.js): the VS card (from progression's
// describeBout() / nextBout() or a roster entry), the results card's rating series and graph with the
// PRO line, glove-colour unlocks for the editor and the results card, and the decision reveal.
// research/mechanics.md §5 (VS card, results card), §7.3–7.5; ARCHITECTURE.md §6.7–6.8.
import { test, assert, approx } from '../harness.mjs';
import {
  vsCardModel, ratingSeries, ratingGraph, normalizeGloveUnlocks, gloveSwatches, crossedGloveUnlocks,
  decisionReveal, isProRating, proThreshold, PRO_RATING,
} from '../../src/ui/screens/kit.js';
import * as progression from '../../src/game/progression.js';

const look = { skin: '#eec1a0' };
const profile = { id: 'p-sam', name: 'Sam', skill: 1047, appearance: look };
const opp = { id: 'o-pip', name: 'Pip', nickname: 'Quick', appearance: { skin: '#8d5a3b' }, skillRequired: 700 };

test('screens: PRO at a rating of 1000 or more (§7.3)', () => {
  assert.equal(PRO_RATING, 1000);
  assert.equal(isProRating(999), false);
  assert.equal(isProRating(1000), true);
  assert.equal(isProRating(1017), true);
  assert.equal(isProRating(NaN), false);
  assert.equal(proThreshold({ PRO_THRESHOLD: 1200 }), 1200);
  assert.equal(proThreshold(null), 1000);
});

test('screens: VS card from describeBout() — names, ratings, PRO badges, rematch; looks from the roster', () => {
  const bout = { player: { id: 'p-sam', name: 'Sam', rating: 1047, pro: true }, opponent: { id: 'o-pip', name: 'Pip', nickname: 'Quick', rating: 1125, pro: true }, rematch: true, reason: 'rematch' };
  const m = vsCardModel({ profile, opponent: opp, bout });
  assert.equal(m.player.name, 'Sam');
  assert.equal(m.player.rating, 1047);
  assert.equal(m.player.pro, true);
  assert.equal(m.player.appearance, look);
  assert.equal(m.opponent.name, 'Pip');
  assert.equal(m.opponent.rating, 1125, 'the raised rematch rating, not the base one');
  assert.equal(m.opponent.pro, true);
  assert.equal(m.opponent.appearance, opp.appearance, 'describeBout has no appearance: taken from the roster entry');
  assert.equal(m.rematch, true);
  const byRoster = vsCardModel({ profile, bout: { opponent: { id: 'o-pip', name: 'Pip', rating: 760, pro: false } }, roster: [opp] });
  assert.equal(byRoster.opponent.appearance, opp.appearance, 'found by id in the roster');
  assert.equal(byRoster.opponent.pro, false);
});

test('screens: VS card from a nextBout() result or just a roster entry', () => {
  const nb = vsCardModel({ profile: { name: 'Kit', skill: 980 }, bout: { opponent: opp, rating: 790, rematch: false } });
  assert.equal(nb.opponent.rating, 790);
  assert.equal(nb.player.pro, false, '980 is not PRO');
  const plain = vsCardModel({ profile: { name: 'Kit', skill: 0 }, opponent: opp });
  assert.equal(plain.opponent.rating, 700, 'falls back to the roster entry');
  assert.equal(plain.rematch, false);
  const viaFn = vsCardModel({ profile: { skill: 10 }, opponent: { id: 'x', name: 'X' }, ratingOf: () => 1250 });
  assert.equal(viaFn.opponent.rating, 1250);
  assert.equal(viaFn.opponent.pro, true);
  const none = vsCardModel({});
  assert.equal(none.player.name, 'You');
  assert.equal(none.opponent.rating, null);
  assert.equal(none.opponent.pro, false);
});

test('screens: VS card agrees with progression.describeBout when it is available', () => {
  if (typeof progression.describeBout !== 'function') return; // progression owner may still be adding it
  const p = { id: 'p-new', name: 'Rookie', skill: 0, records: { matches: { history: [] } } };
  const bout = progression.describeBout({ profile: p });
  const m = vsCardModel({ profile: p, bout });
  assert.equal(m.player.rating, bout.player.rating);
  if (bout.opponent) {
    assert.equal(m.opponent.name, bout.opponent.name);
    assert.equal(m.opponent.rating, bout.opponent.rating);
    assert.equal(m.opponent.pro, bout.opponent.pro);
  }
});

test('screens: rating series ends at the new rating; graph puts PRO 1000 on a horizontal line', () => {
  assert.deepEqual(ratingSeries({ before: 0, after: 75 }), [0, 75], 'first bout');
  assert.deepEqual(ratingSeries({ before: 149, after: 225, history: [{ rating: 0 }, { rating: 75 }, { rating: 149 }, { rating: 225 }] }), [0, 75, 149, 225]);
  assert.deepEqual(ratingSeries({ before: 149, after: 225, history: [{ rating: 0 }, { rating: 75 }, { rating: 149 }] }), [0, 75, 149, 225], 'appends the bout when the save failed');
  const hist = [{ mode: 'single', skillBefore: 0, skillAfter: 75 }, { mode: 'versus', skillBefore: 75, skillAfter: 75 }, { mode: 'single', skillBefore: 75, skillAfter: 149 }];
  assert.deepEqual(ratingSeries({ profile: { records: { matches: { history: hist } } }, before: 75, after: 149 }), [0, 75, 149], 'versus bouts are skipped');
  assert.equal(ratingSeries({ before: 0, after: 1, history: Array.from({ length: 80 }, (_, i) => i) , limit: 40 }).length, 40);
  const g = ratingGraph([0, 600, 1100], { w: 500, h: 300, pad: 20, proAt: 1000 });
  assert(g.top >= 1200, 'room above the PRO line');
  approx(g.proY, g.y(1000), 1e-9);
  assert(g.proY > 20 && g.proY < 280);
  assert(g.points[2].y < g.proY && g.points[1].y > g.proY, 'above PRO is above the line');
  assert.equal(g.points[0].y, 280, '0 sits on the bottom');
});

test('screens: glove unlocks — normalise, lock in the editor, show the milestone', () => {
  const U = [{ id: 'pro-flame', name: 'Pro Flame', color: '#FF6A00', at: 1000 }, { id: 'star-cyan', name: 'Star Cyan', color: '#15d1f0', at: 1600 }];
  const n = normalizeGloveUnlocks(U);
  assert.deepEqual(n.map((u) => [u.color, u.at]), [['#ff6a00', 1000], ['#15d1f0', 1600]]);
  assert.deepEqual(normalizeGloveUnlocks({ 1600: ['#15d1f0'], 1000: '#ff6a00' }).map((u) => u.at), [1000, 1600]);
  assert.deepEqual(normalizeGloveUnlocks({ '#ff6a00': 1000 })[0], { at: 1000, color: '#ff6a00', name: null, id: '#ff6a00' });
  assert.deepEqual(normalizeGloveUnlocks(null), []);
  const base = ['#ff4d5e', '#3d7bff'];
  const rookie = gloveSwatches({ base, unlocks: U, best: 120 });
  assert.equal(rookie.length, 4, 'unlock colours are added to the regular swatches');
  assert.deepEqual(rookie.filter((s) => s.locked).map((s) => s.at), [1000, 1600]);
  assert.equal(rookie[0].locked, false, 'regular colours are always open');
  const pro = gloveSwatches({ base, unlocks: U, best: 1047 });
  assert.deepEqual(pro.filter((s) => s.locked).map((s) => s.color), ['#15d1f0']);
  const ask = gloveSwatches({ base, unlocks: U, best: 0, isAllowed: (c) => c === '#ff6a00' });
  assert.deepEqual(ask.filter((s) => s.locked).map((s) => s.color), ['#15d1f0'], 'progression.isGloveColorAllowed wins');
  assert.deepEqual(crossedGloveUnlocks(U, 980, 1041).map((u) => u.name), ['Pro Flame']);
  assert.deepEqual(crossedGloveUnlocks(U, 1041, 1100), []);
});

test('screens: editor locks agree with progression.GLOVE_UNLOCKS when present', () => {
  if (!Array.isArray(progression.GLOVE_UNLOCKS)) return;
  const list = gloveSwatches({ base: [], unlocks: progression.GLOVE_UNLOCKS, best: 0 });
  assert(list.length >= 2 && list.every((s) => s.locked && Number.isFinite(s.at)), 'all special gloves locked for a new boxer');
  const top = gloveSwatches({ base: [], unlocks: progression.GLOVE_UNLOCKS, best: 5000 });
  assert(top.every((s) => !s.locked), 'all open at a high rating');
});

test('screens: decision reveal — type, winner and each judge’s totals (no punch stats)', () => {
  const cards = [{ judge: 'A', p1: 29, p2: 28 }, { judge: 'B', p1: 28, p2: 29 }, { judge: 'C', p1: 30, p2: 27 }];
  const split = decisionReveal({ winner: 'p1', method: 'decision', scorecards: cards });
  assert.equal(split.kind, 'split');
  assert.equal(split.label, 'Split decision');
  assert.deepEqual(split.cards.map((c) => c.winner), ['p1', 'p2', 'p1']);
  assert.equal(decisionReveal({ winner: 'p1', decisionType: 'unanimous', scorecards: cards }).label, 'Unanimous decision', 'the match’s own decisionType wins');
  const draw = decisionReveal({ winner: null, method: 'draw', scorecards: [{ p1: 29, p2: 28 }, { p1: 28, p2: 29 }, { p1: 28, p2: 28 }] });
  assert.equal(draw.kind, 'draw');
  assert.equal(draw.label, 'Draw');
  assert.equal(draw.cards[2].winner, null);
  assert.equal(draw.cards[0].judge, 'Judge 1', 'unnamed judges get a number');
  assert.equal(decisionReveal({ winner: 'p1', method: 'KO' }).cards.length, 0, 'KO: no cards');
});
