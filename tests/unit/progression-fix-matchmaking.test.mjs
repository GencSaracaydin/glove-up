// RULES-04 regression: matchmaking must not lock onto one rematch opponent, and its offers must sit
// in the measured band (research/mechanics.md §7.2: the next opponent 50–148 above the player,
// mean +100; rematches occasional). Whole careers run through the REAL save path the way
// src/app/app.js flowSingle does it: nextBout → applyBout → Storage.recordMatch → reload.
import { test, assert } from '../harness.mjs';
import { Storage } from '../../src/core/storage.js';
import { nextBout, applyBout, opponentRating, ratingCeiling, SKILL, BASE_RATINGS } from '../../src/game/progression.js';
import { ROSTER, CHAMPION } from '../../src/game/roster.js';
import { Rng } from '../../src/core/rng.js';
import { makeBackend } from './storage-fakes.test.mjs';

// win chance by ladder index (0-based) and knockdown chance in a win
const MODELS = {
  always: { win: () => 1, kd: 1 / 3 },                     // wins every bout, floored in a third of them
  mixed: { win: (i) => (i < 6 ? 0.9 : 0.7), kd: 1 / 3 },   // loses some (by KO), more often from #7 on
};

/** One career of `bouts` single-player bouts through storage; returns one row per bout. */
function career(model, seed, bouts = 40) {
  const M = MODELS[model];
  let t = 1_700_000_000_000;
  const store = new Storage({ backend: makeBackend(), idGen: () => `p_${model}_${seed}`, now: () => (t += 1000) });
  const id = store.createProfile({ name: `C${seed}` }).profile.id;
  const rng = new Rng(seed * 7919 + model.length);
  const rows = [];
  for (let n = 1; n <= bouts; n++) {
    const profile = store.getProfile(id);
    const bout = nextBout(profile);
    const win = rng.chance(M.win(bout.index));
    const kd = win && rng.chance(M.kd) ? 1 : 0;
    const result = { id: `${model}-${seed}-${n}`, mode: 'single', winner: win ? 'p1' : 'p2', method: 'KO', endRound: 2, opponentId: bout.opponent.id, knockdowns: { p1: kd, p2: win ? 3 : 0 } };
    const save = store.recordMatch(id, result, applyBout(profile, result, { opponent: bout.opponent }), { side: 'p1', opponentName: bout.opponent.name });
    assert(save.saved, 'saved');
    rows.push({ n, idx: bout.index, R: profile.skill, rating: bout.rating, gap: bout.rating - profile.skill, reason: bout.reason, win, summary: save.summary });
  }
  return { rows, profile: store.getProfile(id) };
}

const lateShare = (rows) => {
  const late = rows.slice(14).map((r) => r.idx);
  return Math.max(...ROSTER.map((d, i) => late.filter((x) => x === i).length)) / late.length;
};
const reachable = (rows) => rows.filter((r) => r.n > 1 && r.R + SKILL.rematchAbove <= ratingCeiling());
const median = (xs) => { const a = xs.slice().sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };

test('RULES-04: winning careers spread the late bouts, meet the champion again and again, offer near +100', () => {
  const bandShares = [];
  for (let seed = 1; seed <= 12; seed++) {
    const { rows } = career('always', seed);
    const share = lateShare(rows);
    assert(share <= 0.4, `seed ${seed}: one opponent filled ${(share * 100).toFixed(0)} % of bouts 15–40`);
    let run = 1, longest = 1;
    for (let i = 1; i < rows.length; i++) { run = rows[i].idx === rows[i - 1].idx ? run + 1 : 1; longest = Math.max(longest, run); }
    assert(longest <= 2, `seed ${seed}: ${longest} bouts in a row against one opponent`);
    const champ = rows.filter((r) => r.idx === ROSTER.length - 1).length;
    assert(champ >= 5, `seed ${seed}: the champion was met ${champ}× in 40 wins`);
    const reach = reachable(rows);
    const gaps = reach.map((r) => r.gap);
    const inBand = gaps.filter((g) => g >= 50 && g <= 148).length;
    // (10 opponents ~150 apart and no straight repeats: about two offers in three can sit in the band)
    assert(inBand >= 0.45 * gaps.length, `seed ${seed}: ${inBand}/${gaps.length} offers in 50–148`);
    bandShares.push(inBand / gaps.length);
    const m = median(gaps);
    assert(m >= 50 && m <= 148, `seed ${seed}: median gap ${m}`);
    assert(gaps.every((g) => g >= -60 && g <= 250), `seed ${seed}: every offer within 100 of the band`);
  }
  const mean = bandShares.reduce((a, b) => a + b, 0) / bandShares.length;
  assert(mean >= 0.6, `${(mean * 100).toFixed(0)} % of offers in 50–148 while the band was reachable`);
});

test('RULES-04: mixed records never meet a rung 1–5 style above 1000, and no opponent takes over the late career', () => {
  const shares = [];
  for (let seed = 1; seed <= 12; seed++) {
    const { rows } = career('mixed', seed);
    for (const r of rows) {
      if (r.idx < 5) assert(r.rating <= 1000, `seed ${seed} bout ${r.n}: #${r.idx + 1} offered at ${r.rating}`);
      if (r.reason === 'rematch') assert(r.gap >= SKILL.rematchAbove && r.gap <= SKILL.rematchWithin, `seed ${seed} bout ${r.n}: rematch at +${r.gap}`);
      if (r.reason === 'next') assert(r.gap <= SKILL.nextWithin, `seed ${seed} bout ${r.n}: new rung at +${r.gap}`);
    }
    shares.push(lateShare(rows));
    const gaps = reachable(rows).map((r) => r.gap);
    const m = median(gaps);
    assert(m >= 50 && m <= 148, `seed ${seed}: median gap ${m}`);
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  assert(mean <= 0.35 && Math.max(...shares) <= 0.5, `late top share mean ${mean.toFixed(2)}, max ${Math.max(...shares).toFixed(2)}`);
});

test('RULES-04: PRO and the glove colours still arrive at about the reference bout counts', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { rows, profile } = career('always', seed);
    const pro = rows.find((r) => r.summary.becamePro);
    const at1000 = rows.find((r) => r.summary.unlocked.some((u) => u.at === 1000));
    const at1600 = rows.find((r) => r.summary.unlocked.some((u) => u.at === 1600));
    assert(pro && pro.n >= 13 && pro.n <= 18, `seed ${seed}: PRO at bout ${pro?.n} (reference: bout 17)`);
    assert(at1000 && at1000.n === pro.n, 'PRO colours arrive with PRO');
    assert(at1600 && at1600.n >= 23 && at1600.n <= 28, `seed ${seed}: 1600 colours at bout ${at1600?.n} (reference: ~bout 27)`);
    assert(ROSTER.every((d) => profile.opponents[d.id]?.beaten), 'all ten beaten');
  }
  for (let seed = 1; seed <= 6; seed++) {
    const { rows } = career('mixed', seed);
    const pro = rows.find((r) => r.summary.becamePro);
    assert(pro && pro.n <= 32, `mixed seed ${seed}: PRO at bout ${pro?.n}`);
  }
});

test('RULES-04: a rating saved above today\'s cap is read at the cap and never shown again (old saves)', () => {
  let t = 1_700_000_000_000;
  const store = new Storage({ backend: makeBackend(), idGen: () => 'p_old', now: () => (t += 1000) });
  const id = store.createProfile({ name: 'Vet' }).profile.id;
  // an older build raised every beaten opponent towards 1725: #4 and #7 were shown as top-of-the-pool opponents
  const opponents = Object.fromEntries(ROSTER.slice(0, 9).map((d, i) => [d.id, { wins: 6, losses: 0, draws: 0, beaten: true, rating: i === 3 || i === 6 ? 1725 : BASE_RATINGS[i] + 100 }]));
  store.updateProfile(id, { skill: 1500, opponents, tutorialDone: true });
  const p = store.getProfile(id);
  assert.equal(opponentRating(ROSTER[3], p), 850, '#4 reads at its cap (the next rung + 100)');
  assert.equal(opponentRating(ROSTER[6], p), 1300);
  for (let n = 1; n <= 12; n++) {
    const profile = store.getProfile(id);
    const bout = nextBout(profile);
    assert(bout.index >= 7 || bout.rating <= 1300, `bout ${n}: #${bout.index + 1} at ${bout.rating}`);
    const result = { id: `old-${n}`, mode: 'single', winner: 'p1', method: 'KO', endRound: 2, opponentId: bout.opponent.id, knockdowns: { p1: 0, p2: 3 } };
    store.recordMatch(id, result, applyBout(profile, result, { opponent: bout.opponent }), {});
  }
  const after = store.getProfile(id);
  assert.equal(opponentRating(ROSTER[3], after), 850, 'still capped');
  assert(opponentRating(CHAMPION, after) <= ratingCeiling(), 'the champion tops out at the ceiling');
  // a win against a capped opponent stores the capped rating
  const res = { id: 'old-cap', mode: 'single', winner: 'p1', method: 'KO', endRound: 2, opponentId: ROSTER[3].id, knockdowns: { p1: 0, p2: 3 } };
  store.recordMatch(id, res, applyBout(after, res, { opponent: ROSTER[3] }), {});
  assert.equal(store.getProfile(id).opponents[ROSTER[3].id].rating, 850);
});
