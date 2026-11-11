// game/progression.js — opponent ratings, rematches and nextBout (research/mechanics.md §7.2, §7.5),
// glove-colour unlocks (§7.4), and the VS / results card helpers (ARCHITECTURE.md §6.8).
import { test, assert } from '../harness.mjs';
import {
  SKILL, BASE_RATINGS, GLOVE_UNLOCKS, nextBout, nextOpponent, unlockedOpponents, rematchRaise, ratingAfterWins, ratingCeiling,
  opponentAfterBout, deriveOpponentStates, opponentStates, opponentRating, describeBout, resultsSummary, ratingHistory,
  unlockedGloveColors, lockedGloveColors, gloveUnlocksBetween, gloveUnlockFor, isGloveColorAllowed, applyBout, applySkill,
  isNewProfile, needsTutorial, profileKey, bestRatingOf, isPro, ladderPosition, sanitizeOpponentState, recentOpponents, ratingCap,
} from '../../src/game/progression.js';
import { ROSTER, CHAMPION } from '../../src/game/roster.js';
import { GLOVE_COLORS } from '../../src/render/appearance.js';

// A small roster with explicit ratings, so the matchmaking rules are tested on their own.
const MINI = Object.freeze([
  { id: 'a', name: 'A', rating: 100 }, { id: 'b', name: 'B', rating: 300 }, { id: 'c', name: 'C', rating: 500 },
].map((d) => Object.freeze(d)));
const profile = (o = {}) => ({
  id: 'p_test', name: 'Tess', skill: 0, pro: false, bestRating: 0, tutorialDone: false, opponents: {},
  records: { matches: { wins: 0, losses: 0, draws: 0, kos: 0, history: [] } }, createdAt: 1000, ...o,
});
const st = (wins, rating = null, o = {}) => ({ wins, losses: 0, draws: 0, beaten: wins > 0, rating, ...o });
const played = (n) => ({ matches: { wins: n, losses: 0, draws: 0, kos: n, history: [] } });

test('rematch raise: 60–125, deterministic per profile + opponent + win number', () => {
  const seen = new Set();
  for (let k = 1; k <= 400; k++) {
    const r = rematchRaise('p_x', 'opp', k);
    assert(Number.isInteger(r) && r >= 60 && r <= 125, `raise ${r}`);
    seen.add(r);
  }
  assert(seen.size > 40, `spread over the range (${seen.size} distinct values)`);
  assert.equal(rematchRaise('p_x', 'opp', 3), rematchRaise('p_x', 'opp', 3), 'deterministic');
  const vary = new Set(['p_a', 'p_b', 'p_c', 'p_d', 'p_e'].map((k) => rematchRaise(k, 'opp', 1)));
  assert(vary.size > 1, 'differs between profiles');
  assert.equal(profileKey({ id: 'portable_9', sourceId: 'p_home' }), 'p_home', 'a visiting copy keeps its home seed');
  assert.equal(profileKey(null), 'anon');
});

test('opponent ratings: base + every raise, capped at the next rung + 100 (the champion at the top + 125)', () => {
  const id = ROSTER[3].id;
  assert.equal(ratingAfterWins('k', id, 0), BASE_RATINGS[3]);
  const one = ratingAfterWins('k', id, 1);
  assert.equal(one, BASE_RATINGS[3] + rematchRaise('k', id, 1));
  assert.equal(ratingAfterWins('k', id, 2), Math.min(one + rematchRaise('k', id, 2), ratingCap(id)));
  assert.equal(ratingCeiling(), BASE_RATINGS[9] + SKILL.ceilingAbove, '1725');
  assert.equal(ratingCeiling(MINI), 625);
  assert.deepEqual(ROSTER.map((d) => ratingCap(d)), [380, 550, 700, 850, 1000, 1150, 1300, 1500, 1700, 1725]);
  assert.deepEqual(MINI.map((d) => ratingCap(d, MINI)), [400, 600, 625]);
  assert.equal(ratingAfterWins('k', CHAMPION.id, 50), ratingCeiling(), 'the pool tops out');
  for (let i = 0; i < ROSTER.length; i++) assert.equal(ratingAfterWins('k', ROSTER[i].id, 60), ratingCap(ROSTER[i]), `${ROSTER[i].id} stops at its cap`);
  assert.equal(ratingAfterWins('k', 'nobody', 3), null, 'unknown opponent → no rating');
  assert.equal(ratingCap('nobody'), null);
  assert.equal(ratingCap({ id: 'guest-star', rating: 777 }), ratingCeiling(), 'outside the roster: the ceiling');
});

test('opponentAfterBout: a win raises the rating (once per win), a loss or draw keeps it', () => {
  const id = ROSTER[1].id;
  const w1 = opponentAfterBout(undefined, { key: 'k', opponentId: id, outcome: 'win' });
  assert.equal(w1.ratingBefore, BASE_RATINGS[1]);
  assert.equal(w1.rematch, false);
  assert.deepEqual(w1.state, { wins: 1, losses: 0, draws: 0, beaten: true, rating: BASE_RATINGS[1] + rematchRaise('k', id, 1) });
  assert.equal(w1.ratingAfter, w1.state.rating);
  const l = opponentAfterBout(w1.state, { key: 'k', opponentId: id, outcome: 'loss' });
  assert.equal(l.rematch, true);
  assert.deepEqual([l.state.wins, l.state.losses, l.state.rating], [1, 1, w1.state.rating]);
  const w2 = opponentAfterBout(l.state, { key: 'k', opponentId: id, outcome: 'win' });
  assert.equal(w2.ratingBefore, w1.state.rating);
  assert.equal(w2.state.rating, w1.state.rating + rematchRaise('k', id, 2));
  const fresh = opponentAfterBout(null, { key: 'k', opponentId: id, outcome: 'loss' });
  assert.deepEqual(fresh.state, { wins: 0, losses: 1, draws: 0, beaten: false, rating: null }, 'unbeaten keeps its base (null)');
  assert.equal(fresh.ratingAfter, BASE_RATINGS[1]);
  const unknown = opponentAfterBout(null, { key: 'k', opponentId: 'nobody', outcome: 'win' });
  assert.deepEqual([unknown.state.wins, unknown.state.rating, unknown.ratingBefore], [1, null, null]);
  assert.equal(sanitizeOpponentState('junk'), null);
  assert.deepEqual(sanitizeOpponentState({ wins: -2, losses: 'x', beaten: 'yes', rating: 900 }), { wins: 0, losses: 0, draws: 0, beaten: false, rating: null });
});

test('opponent states are derived from the match history when a profile has none (old saves)', () => {
  const a = ROSTER[0].id, b = ROSTER[1].id;
  const history = [
    { id: '1', mode: 'single', opponentId: a, outcome: 'win' },
    { id: '2', mode: 'single', opponentId: b, outcome: 'loss' },
    { id: '3', mode: 'versus', opponentId: null, outcome: 'win' },
    { id: '4', mode: 'single', opponentId: a, outcome: 'win' },
    { id: '5', mode: 'single', opponentId: b, outcome: 'draw' },
  ];
  const s = deriveOpponentStates(history, 'k');
  assert.deepEqual(s[a], { wins: 2, losses: 0, draws: 0, beaten: true, rating: ratingAfterWins('k', a, 2) });
  assert.deepEqual(s[b], { wins: 0, losses: 1, draws: 1, beaten: false, rating: null });
  const old = { id: 'k', skill: 150, records: { matches: { wins: 2, losses: 1, draws: 1, history } } };
  assert.deepEqual(opponentStates(old), s, 'no profile.opponents → derived');
  assert.equal(opponentRating(a, old), ratingAfterWins('k', a, 2));
  assert.equal(opponentRating(b, old), BASE_RATINGS[1]);
});

test('nextBout: a brand-new profile gets the first opponent (and the tutorial)', () => {
  const p = profile();
  const b = nextBout(p);
  assert.equal(b.opponent.id, ROSTER[0].id);
  assert.deepEqual([b.reason, b.rematch, b.rating, b.index, b.wins], ['first', false, BASE_RATINGS[0], 0, 0]);
  assert.equal(isNewProfile(p), true);
  assert.equal(needsTutorial(p), true);
  assert.equal(needsTutorial({ ...p, tutorialDone: true }), false, 'skipped or finished');
  assert.equal(needsTutorial({ ...p, records: played(1) }), false, 'already fought');
  assert.equal(needsTutorial(null), false);
  assert.equal(nextBout(null).opponent.id, ROSTER[0].id);
  assert.equal(nextBout(0).reason, 'first');
});

/** Single-player history entries against these opponent ids (oldest first) — what nextBout reads for recency. */
const met = (...ids) => ids.map((opponentId, i) => ({ id: `h${i}`, t: i, mode: 'single', opponentId, outcome: 'win', skillBefore: 0, skillAfter: 0 }));
const playedVs = (...ids) => ({ matches: { wins: ids.length, losses: 0, draws: 0, kos: ids.length, history: met(...ids) } });

test('nextBout: the next unbeaten opponent once rated within 150 of the player', () => {
  const p = profile({ skill: 150, opponents: { a: st(1, 180) }, records: played(1) });
  const b = nextBout(p, { roster: MINI });
  assert.deepEqual([b.opponent.id, b.reason, b.rematch, b.rating], ['b', 'next', false, 300]);
  // 200 away is out of reach: the beaten one inside the band instead (a at +80)
  assert.deepEqual([nextBout({ ...p, skill: 100 }, { roster: MINI }).opponent.id, nextBout({ ...p, skill: 100 }, { roster: MINI }).reason], ['a', 'rematch']);
  // a loss does not make an opponent "beaten": still the next one — straight back in, even just after losing to it
  const lost = profile({ skill: 160, opponents: { a: st(1, 180), b: { wins: 0, losses: 2, draws: 0, beaten: false, rating: null } }, records: playedVs('a', 'b', 'b') });
  assert.deepEqual([nextBout(lost, { roster: MINI }).opponent.id, nextBout(lost, { roster: MINI }).reason], ['b', 'next']);
});

test('nextBout: otherwise a rematch — the beaten opponent nearest R + 100 inside R + 50 … R + 150', () => {
  const p = profile({ skill: 75, opponents: { a: st(1, 180) }, records: played(1) });
  const b = nextBout(p, { roster: MINI });
  assert.deepEqual([b.opponent.id, b.reason, b.rematch, b.rating, b.wins], ['a', 'rematch', true, 180, 1]);
  // the one NEAREST R + 100 is chosen, not the highest-rated (band 300 … 400: a +95, b +145)
  const two = profile({ skill: 250, opponents: { a: st(3, 345), b: st(1, 395) }, records: played(4) });
  assert.equal(nextBout(two, { roster: MINI }).opponent.id, 'a');
  // everyone beaten: still the one nearest R + 100 inside the band (b +70, c +105)
  const all = profile({ skill: 520, opponents: { a: st(1, 200), b: st(1, 590), c: st(1, 625) }, records: played(3) });
  assert.deepEqual([nextBout(all, { roster: MINI }).opponent.id, nextBout(all, { roster: MINI }).reason], ['c', 'rematch']);
  // never above the band: a beaten opponent 160 above is no rematch — only the nearest fit
  const high = profile({ skill: 240, opponents: { a: st(1, 400), b: st(1, 600) }, records: played(2) });
  assert.deepEqual([nextBout(high, { roster: MINI }).opponent.id, nextBout(high, { roster: MINI }).reason], ['a', 'fallback']);
});

test('nextBout: the opponents met in the last two bouts are skipped while another one fits (RULES-04)', () => {
  const opps = { a: st(1, 200), b: st(1, 590), c: st(1, 625) };
  const at = (...ids) => nextBout(profile({ skill: 520, opponents: opps, records: playedVs(...ids) }), { roster: MINI });
  assert.equal(at('a').opponent.id, 'c', 'nearest R + 100');
  assert.equal(at('c').opponent.id, 'b', 'not the opponent just met');
  assert.equal(at('c', 'b').opponent.id, 'c', 'both met recently: the older meeting gives way');
  assert.equal(at('b', 'c').opponent.id, 'b');
  assert.equal(at('b', 'c').reason, 'rematch');
  // only the opponent just met sits in the band: the nearest other fit within 100 of the band wins…
  const solo = (ids, o = { a: st(1, 180), b: st(1, 330) }) => nextBout(profile({ skill: 75, opponents: o, records: playedVs(...ids) }), { roster: MINI });
  assert.deepEqual([solo(['a']).opponent.id, solo(['a']).reason], ['a', 'rematch'], 'b at +255 is too far: a straight rematch (B14 → B15)');
  const near = nextBout(profile({ skill: 150, opponents: { a: st(1, 250) }, records: playedVs('a') }), { roster: MINI });
  assert.deepEqual([near.opponent.id, near.reason, near.rematch], ['b', 'next', false], 'b within reach anyway');
  const early = nextBout(profile({ skill: 75, opponents: { a: st(1, 200) }, records: playedVs('a') }), { roster: MINI.map((d) => ({ ...d, rating: d.id === 'b' ? 280 : d.rating })) });
  assert.deepEqual([early.opponent.id, early.reason, early.rematch], ['b', 'fallback', false], 'the next rung at +205 rather than a straight rematch');
  // versus bouts in the history do not count as meetings
  const vs = profile({ skill: 520, opponents: opps, records: { matches: { wins: 1, losses: 0, draws: 0, history: [...met('c'), { id: 'v', mode: 'versus', opponentId: null, outcome: 'win' }] } } });
  assert.equal(nextBout(vs, { roster: MINI }).opponent.id, 'b');
  assert.deepEqual(recentOpponents(vs, 3), ['c']);
  assert.deepEqual(recentOpponents(profile({ records: playedVs('a', 'b', 'c') }), 2), ['b', 'c']);
  assert.deepEqual(recentOpponents(null), []);
});

test('nextBout: when nothing fits, the nearest fit; once the roster is out-climbed the top three take turns', () => {
  // next unbeaten (c, 500) is 260 away and no beaten opponent sits in 290 … 390: b (+40) is nearest
  const gap = profile({ skill: 240, opponents: { a: st(1, 200), b: st(1, 280) }, records: played(2) });
  const g = nextBout(gap, { roster: MINI });
  assert.deepEqual([g.opponent.id, g.reason, g.rematch], ['b', 'fallback', true]);
  // everyone beaten and the player above them all (like r1572 offered at 1656): the champion first …
  const opps = { a: st(2, 230), b: st(2, 420), c: st(4, 625) };
  const top = (...ids) => nextBout(profile({ skill: 800, opponents: opps, records: playedVs(...ids) }), { roster: MINI });
  const t = top();
  assert.deepEqual([t.opponent.id, t.reason, t.rating], ['c', 'fallback', 625]);
  assert(t.rating < 800, 'rated below the player');
  // … then the next-best in turn, never the one just met: c, b, a, c, b, a …
  assert.deepEqual([top('c').opponent.id, top('c', 'b').opponent.id, top('b', 'a').opponent.id, top('a', 'c').opponent.id], ['b', 'a', 'c', 'b']);
});

test('nextBout without profile.opponents uses the history (old profiles) and a bare rating is stateless', () => {
  const history = [{ id: '1', mode: 'single', opponentId: ROSTER[0].id, outcome: 'win', skillBefore: 0, skillAfter: 75 }];
  const old = { id: 'p_old', skill: 75, records: { matches: { wins: 1, losses: 0, draws: 0, history } } };
  assert.equal(opponentRating(ROSTER[0].id, old), ratingAfterWins('p_old', ROSTER[0].id, 1), 'derived from the history');
  const b = nextBout(old);
  // the first opponent was just met: the next rung (280, +205) comes before a straight rematch
  assert.deepEqual([b.opponent.id, b.reason, b.rematch, b.rating], [ROSTER[1].id, 'fallback', false, BASE_RATINGS[1]]);
  assert.equal(nextOpponent(old).id, ROSTER[1].id, 'nextOpponent(profile) follows nextBout');
  assert.equal(nextBout(500).opponent.id, nextOpponent(500).id);
  assert.deepEqual(unlockedOpponents(old).map((d) => d.id), [ROSTER[0].id], '280 is not yet within 150 of 75');
  assert.equal(ladderPosition(old).current.id, ROSTER[1].id);
});

/** Apply one bout to an in-memory profile the way core/storage.js recordMatch does. */
function fight(p, { win = true, kd = 0, endRound = 2, method = 'KO' } = {}) {
  const bout = nextBout(p);
  const result = {
    id: `r${p.records.matches.history.length + 1}`, mode: 'single', winner: win ? 'p1' : 'p2', method, endRound,
    knockdowns: { p1: kd, p2: win ? 3 : 0 }, opponentId: bout.opponent.id,
  };
  const u = applyBout(p, result, { opponent: bout.opponent });
  const { id, ratingBefore, ratingAfter, rematch, ...state } = u.opponent; // eslint-disable-line no-unused-vars
  const outcome = win ? 'win' : 'loss';
  const m = p.records.matches;
  const next = {
    ...p, skill: u.skill, pro: u.pro, bestRating: u.bestRating, tutorialDone: true, opponents: { ...p.opponents, [id]: state },
    records: { matches: { ...m, wins: m.wins + (win ? 1 : 0), losses: m.losses + (win ? 0 : 1),
      history: [...m.history, { id: result.id, t: m.history.length, mode: 'single', outcome, method, opponentId: id, skillBefore: u.before, skillAfter: u.skill, delta: u.delta, opponentRating: ratingBefore, rematch }] } },
  };
  return { p: next, bout, u };
}

test('a winning career: new opponents and rematches in turn, offers in the measured band, PRO, all ten beaten, the top three take turns', () => {
  let p = profile({ id: 'p_career' });
  const log = [];
  for (let n = 1; n <= 40; n++) {
    const before = p.skill;
    const r = fight(p);
    log.push({ n, before, reason: r.bout.reason, idx: r.bout.index, rating: r.bout.rating, after: r.u.skill, becamePro: r.u.becamePro, unlocked: r.u.unlocked });
    p = r.p;
  }
  assert.equal(log[0].reason, 'first');
  const proAt = log.find((x) => x.becamePro);
  assert(proAt && proAt.n >= 12 && proAt.n <= 16, `PRO after ${proAt?.n} straight clean wins`);
  assert.deepEqual(proAt.unlocked.map((u) => u.at), [1000, 1000], 'PRO glove colours arrive with PRO');
  const champFirst = log.findIndex((x) => x.idx === ROSTER.length - 1) + 1;
  assert(champFirst >= 18 && champFirst <= 24, `champion first met at bout ${champFirst}`);
  const at1600 = log.find((x) => x.unlocked.some((u) => u.at === 1600));
  assert(at1600 && at1600.after >= 1600 && at1600.n <= 27, '1600 colours by about the reference playthrough length');
  assert(ROSTER.every((d) => p.opponents[d.id]?.beaten), 'every opponent beaten');
  // each reason keeps its promise: a new rung within 150, a rematch inside the measured band
  for (const x of log) {
    const gap = x.rating - x.before;
    if (x.reason === 'next') assert(gap <= SKILL.nextWithin, `bout ${x.n}: new opponent within 150 (+${gap})`);
    if (x.reason === 'rematch') assert(gap >= SKILL.rematchAbove && gap <= SKILL.rematchWithin, `bout ${x.n}: rematch inside the band (+${gap})`);
    assert(x.rating <= ratingCap(ROSTER[x.idx]), `bout ${x.n}: #${x.idx + 1} at ${x.rating} is within its cap`);
  }
  // while the band is reachable at all, offers sit around the measured +100 (§7.2: 50–148, mean +100)
  const live = log.slice(1).filter((x) => x.before + SKILL.rematchAbove <= ratingCeiling());
  const gaps = live.map((x) => x.rating - x.before).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const inBand = gaps.filter((g) => g >= 50 && g <= 148).length;
  assert(median >= 50 && median <= 148, `median gap ${median}`);
  assert(inBand >= 0.6 * gaps.length, `${inBand}/${gaps.length} offers in 50–148`);
  assert(gaps.every((g) => g >= -60 && g <= 250), `every offer within 100 of the band (${gaps[0]} … ${gaps.at(-1)})`);
  // no lock-on: no straight repeats, and no opponent fills more than 40 % of bouts 15–40
  const seq = log.map((x) => x.idx);
  assert(seq.every((x, i) => i === 0 || x !== seq[i - 1] || log[i].reason === 'rematch'), 'a straight repeat only as an in-band rematch');
  assert(seq.filter((x, i) => i > 0 && x === seq[i - 1]).length <= 1, 'at most one straight repeat');
  const late = seq.slice(14);
  const share = Math.max(...ROSTER.map((d, i) => late.filter((x) => x === i).length)) / late.length;
  assert(share <= 0.4, `top late share ${share.toFixed(2)}`);
  // out-climbed the pool (like r1572 at 1656): the champion, #9 and #8 take turns, all below the player
  const end = log.slice(-9);
  assert(end.every((x) => x.rating < x.before), 'late offers are rated below the player');
  assert.deepEqual([...new Set(end.map((x) => x.idx))].sort((a, b) => a - b), [7, 8, 9], 'the top three take turns');
  assert.equal(end.filter((x) => x.idx === 9).length, 3, 'the champion every third bout');
  assert(log.filter((x) => x.idx === 9).length >= 6, 'the champion is met again and again');
  assert(log.every((x) => x.after > x.before), 'clean wins always gain');
});

test('a career with losses: the beaten-by opponent stays next, rating never below 0', () => {
  let p = profile({ id: 'p_rough' });
  let r = fight(p, { win: false });
  assert.equal(r.p.skill, 0, '0 − 40 → floor 0');
  assert.equal(r.p.opponents[ROSTER[0].id].losses, 1);
  r = fight(r.p, { win: false, method: 'decision', endRound: 3 });
  assert.equal(r.bout.opponent.id, ROSTER[0].id, 'same opponent again');
  p = r.p;
  for (let i = 0; i < 3; i++) p = fight(p).p;
  const before = p.skill;
  const loss = fight(p, { win: false });
  assert.equal(loss.u.delta, -40);
  assert.equal(loss.p.skill, before - 40);
});

test('glove colours: our own, unlocked at 1000 and 1600 by the BEST rating ever (losing PRO keeps them)', () => {
  assert.deepEqual(GLOVE_UNLOCKS.map((u) => u.at), [1000, 1000, 1600, 1600]);
  for (const u of GLOVE_UNLOCKS) {
    assert.match(u.color, /^#[0-9a-f]{6}$/);
    assert(u.name && u.id, 'named');
    assert(!GLOVE_COLORS.includes(u.color), `${u.color} is new, not a regular swatch`);
  }
  assert.equal(new Set(GLOVE_UNLOCKS.map((u) => u.color)).size, GLOVE_UNLOCKS.length);
  assert.deepEqual(unlockedGloveColors(999), []);
  assert.equal(unlockedGloveColors(1000).length, 2);
  assert.equal(unlockedGloveColors(1600).length, 4);
  assert.equal(lockedGloveColors(1000).length, 2);
  const fallen = { skill: 940, bestRating: 1035, pro: false };
  assert.equal(isPro(fallen), false);
  assert.equal(unlockedGloveColors(fallen).length, 2, 'kept after losing PRO');
  assert.equal(bestRatingOf({ skill: 10, records: { matches: { history: [{ mode: 'single', skillBefore: 0, skillAfter: 1610 }] } } }), 1610, 'history counts');
  assert.deepEqual(gloveUnlocksBetween(990, 1650).map((u) => u.id), GLOVE_UNLOCKS.map((u) => u.id));
  assert.deepEqual(gloveUnlocksBetween(1000, 1100), []);
  assert.equal(gloveUnlockFor(GLOVE_UNLOCKS[2].color.toUpperCase()).id, GLOVE_UNLOCKS[2].id);
  assert.equal(gloveUnlockFor('#ff4d5e'), null);
  assert.equal(isGloveColorAllowed(500, '#ff4d5e'), true, 'ordinary colours always');
  assert.equal(isGloveColorAllowed(500, GLOVE_UNLOCKS[0].color), false);
  assert.equal(isGloveColorAllowed(fallen, GLOVE_UNLOCKS[0].color), true);
});

test('describeBout: names, ratings and PRO badges for the VS card', () => {
  const beaten = Object.fromEntries(ROSTER.slice(0, 7).map((d, i) => [d.id, st(1, BASE_RATINGS[i] + 90)]));
  const p = profile({ name: 'Tess', skill: 1050, records: played(14), opponents: beaten });
  const bout = nextBout(p);
  assert.deepEqual([bout.opponent.id, bout.reason, bout.rating], [ROSTER[7].id, 'next', BASE_RATINGS[7]]);
  const d = describeBout({ profile: p, bout });
  assert.deepEqual(d.player, { id: 'p_test', name: 'Tess', rating: 1050, pro: true });
  assert.deepEqual(d.opponent, { id: ROSTER[7].id, name: ROSTER[7].name, nickname: ROSTER[7].nickname || null, rating: BASE_RATINGS[7], pro: true });
  assert.deepEqual([d.rematch, d.reason], [false, 'next']);
  // a bare roster entry and no bout at all both work
  const byDef = describeBout({ profile: p, bout: ROSTER[6] });
  assert.deepEqual([byDef.opponent.rating, byDef.opponent.pro, byDef.rematch], [BASE_RATINGS[6] + 90, true, true]);
  const low = describeBout({ profile: p, bout: ROSTER[5] });
  assert.deepEqual([low.opponent.rating, low.opponent.pro], [BASE_RATINGS[5] + 90, false], 'r990: no badge');
  const auto = describeBout({ profile: profile() });
  assert.deepEqual([auto.opponent.id, auto.opponent.pro, auto.player.pro, auto.rematch], [ROSTER[0].id, false, false, false]);
  assert.equal(describeBout().player.name, 'You');
});

test('resultsSummary: before/after/delta, PRO gained or lost, unlocks — from profiles or an update', () => {
  const a = profile({ skill: 960, bestRating: 960, pro: false });
  const b = profile({ skill: 1028, bestRating: 1028, pro: true });
  const s = resultsSummary(a, b);
  assert.deepEqual([s.before, s.after, s.delta, s.pro, s.becamePro, s.lostPro], [960, 1028, 68, true, true, false]);
  assert.deepEqual(s.unlocked.map((u) => u.at), [1000, 1000]);
  const back = resultsSummary(b, profile({ skill: 988, bestRating: 1028, pro: false }));
  assert.deepEqual([back.delta, back.becamePro, back.lostPro, back.unlocked.length], [-40, false, true, 0]);
  const upd = applySkill(a, 68);
  assert.deepEqual(resultsSummary(upd), { ...s, bestBefore: 960, bestAfter: 1028 });
  assert.deepEqual(resultsSummary(10, 85).delta, 75);
});

test('ratingHistory: single-player bouts only, oldest first, ≤ limit, optional start point', () => {
  const history = [
    { id: 'a', t: 10, mode: 'single', outcome: 'win', method: 'KO', opponentId: 'x', skillBefore: 0, skillAfter: 75, delta: 75, opponentRating: 120 },
    { id: 'v', t: 11, mode: 'versus', outcome: 'win', method: 'KO', opponentId: null, skillBefore: 75, skillAfter: 75, delta: 0 },
    { id: 'b', t: 12, mode: 'single', outcome: 'loss', method: 'decision', opponentId: 'y', skillBefore: 75, skillAfter: 50, delta: -25, rematch: true },
  ];
  const p = profile({ records: { matches: { wins: 1, losses: 1, draws: 0, history } }, createdAt: 5 });
  const h = ratingHistory(p);
  assert.deepEqual(h.map((x) => x.rating), [75, 50]);
  assert.deepEqual(h.map((x) => x.won), [true, false]);
  assert.deepEqual(Object.keys(h[0]).sort(), ['before', 'delta', 'id', 'method', 'opponentId', 'opponentName', 'opponentRating', 'outcome', 'pro', 'rating', 'rematch', 't', 'won'].sort());
  assert.equal(h[0].opponentRating, 120);
  assert.equal(h[1].rematch, true);
  const ws = ratingHistory(p, { withStart: true });
  assert.deepEqual(ws.map((x) => x.rating), [0, 75, 50]);
  assert.equal(ws[0].start, true);
  assert.equal(ws[0].t, 5);
  assert.deepEqual(ratingHistory(p, { limit: 1 }).map((x) => x.id), ['b']);
  assert.deepEqual(ratingHistory(profile()), []);
  assert.deepEqual(ratingHistory(null, { withStart: true }), []);
});

test('applyBout: rating update + opponent change in one preview; versus changes neither', () => {
  const p = profile({ skill: 296, records: played(4), opponents: { [ROSTER[0].id]: st(2, 300), [ROSTER[1].id]: st(2, 470) } });
  const bout = nextBout(p);
  assert.equal(bout.opponent.id, ROSTER[2].id, '450 is within 200 of 296');
  const res = { id: 'z', mode: 'single', winner: 'p1', method: 'KO', endRound: 2, knockdowns: { p1: 1, p2: 2 }, opponentId: bout.opponent.id };
  const u = applyBout(p, res, { opponent: bout.opponent });
  assert.equal(u.delta, 73 - 20);
  assert.deepEqual([u.opponent.id, u.opponent.ratingBefore, u.opponent.rematch, u.opponent.wins, u.opponent.beaten], [ROSTER[2].id, 450, false, 1, true]);
  assert.equal(u.opponent.ratingAfter, 450 + rematchRaise('p_test', ROSTER[2].id, 1));
  const v = applyBout(p, { ...res, mode: 'versus' });
  assert.deepEqual([v.delta, v.skill, v.opponent], [0, 296, null]);
  assert.equal(applyBout(p, null).delta, 0);
});
