// The app's single-player bookkeeping with REAL bouts (src/app/session.js MatchSession → game/match.js
// MatchResult → progression.applyBout → storage.recordMatch → summary / nextBout), the way
// src/app/app.js flowSingle wires it: the rating Δ reads the knockdowns and the end round from the
// Match's own result (research/mechanics.md §7.1, §7.5), the beaten opponent comes back as a rematch,
// PRO and glove unlocks reach the results-card summary and the editor's gate (§7.3–7.4), and a bout
// marks the first-bout tutorial done (§8).
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { MatchPhase } from '../../src/core/types.js';
import { Storage } from '../../src/core/storage.js';
import { nextBout, describeBout, applyBout, resultsSummary, needsTutorial, isGloveColorAllowed, GLOVE_UNLOCKS } from '../../src/game/progression.js';
import { MatchSession } from '../../src/app/session.js';
import { makeBackend, makeDeterministic } from './storage-fakes.test.mjs';

const ctl = () => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.1, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.1, reach: 0.1, punching: false } },
  activity: 0,
});
const idle = () => [{ control: ctl(), events: [] }];
const jab = (t, hand) => [{ control: ctl(), events: [{ type: 'punch', t, punch: { hand, kind: 'straight', target: 'head', power: 0.6, t } }] }];

/** One real bout against the opponent nextBout picks, ending in a KO win; optionally floored first. */
function playBout(store, id, { seed, floored = 0 } = {}) {
  const profile = store.getProfile(id);
  const bout = nextBout(profile);
  const s = new MatchSession({ bus: new EventBus(), renderer: null, hud: null, mode: 'single', players: [profile], opponent: bout.opponent, seed, fast: true });
  s.begin();
  let now = 0, k = 0;
  const step = (inputs = idle) => { now += 16; s.update(0.016, now, inputs()); };
  const until = (pred, inputs, max = 60000) => { const end = now + max; while (!pred() && now < end) step(inputs); return pred(); };
  assert(until(() => s.match.phase === MatchPhase.FIGHTING && s.view.stage === 'live'), 'live');
  for (let i = 0; i < floored; i++) {
    s.match.debugKnockdown('p1');
    // get up by throwing punches during the count (8 / 12 punches, earliest at counts 4 / 5)
    assert(until(() => s.match.phase !== MatchPhase.KNOCKDOWN, () => (++k % 6 === 0 ? jab(now, k % 12 ? 'left' : 'right') : idle())), 'got up');
    assert(until(() => s.match.phase === MatchPhase.FIGHTING && s.view.stage === 'live'), 'live again');
  }
  s.match.debugKnockdown('p2', { stayDown: true });
  assert(until(() => s.over), 'KO');
  const result = s.result;
  const before = store.getProfile(id);
  const upd = applyBout(before, result, { playerId: 'p1', opponent: bout.opponent });
  const save = store.recordMatch(id, result, upd, { side: 'p1', opponentName: bout.opponent.name });
  return { bout, result, upd, save, summary: save.summary || resultsSummary(upd) };
}

test('integration progress: real bouts → applyBout + recordMatch → results summary and the next VS card (§7.1, §7.5)', () => {
  const store = new Storage({ backend: makeBackend(), ...makeDeterministic() });
  const id = store.createProfile({ name: 'Kai' }).profile.id;
  assert(needsTutorial(store.getProfile(id)), 'a new boxer gets the tutorial');
  const first = nextBout(store.getProfile(id));
  assert(first.reason === 'first' && first.opponent.rating === 120, 'the first opponent');
  // bout 1: floored once, then a KO win → 75 − 20 = +55 (the Match's own result carries the knockdown)
  const b1 = playBout(store, id, { seed: 41, floored: 1 });
  assert.equal(b1.result.method, 'KO');
  assert.equal(b1.result.knockdowns.p1, 1, 'the result counts the player knockdown');
  assert.equal(b1.upd.delta, 55, `Δ ${b1.upd.delta}`);
  assert(b1.save.ok && b1.save.saved, 'saved once');
  assert.deepEqual([b1.summary.before, b1.summary.after, b1.summary.delta], [0, 55, 55]);
  assert(!needsTutorial(store.getProfile(id)) && store.getProfile(id).tutorialDone, 'a recorded bout marks the tutorial done');
  // the next VS card: the first opponent was just beaten, so the next rung (280, +225) rather than a
  // straight rematch (RULES-04: no lock-on to the opponent just met)
  const nb = nextBout(store.getProfile(id));
  const card = describeBout({ profile: store.getProfile(id), bout: nb });
  assert(nb.opponent.id !== first.opponent.id && nb.index === 1 && !card.rematch && card.opponent.rating === 280, JSON.stringify(card));
  // the same result recorded again (a second save attempt) changes nothing (SES02)
  const dup = store.recordMatch(id, b1.result, b1.upd, { side: 'p1' });
  assert(dup.duplicate === true && store.getProfile(id).skill === 55);
  // bout 2 (against that second opponent): a clean KO win → +75 (rating 55 → 130); then a rematch
  // with the raised first opponent, now inside the measured band (R + 50 … R + 150)
  const b2 = playBout(store, id, { seed: 42 });
  assert.equal(b2.bout.opponent.id, nb.opponent.id);
  assert.equal(b2.upd.delta, 75);
  assert.equal(store.getProfile(id).skill, 130);
  const nb2 = nextBout(store.getProfile(id));
  const gap = nb2.rating - 130;
  assert(nb2.opponent.id === first.opponent.id && nb2.rematch && gap >= 50 && gap <= 150, JSON.stringify({ reason: nb2.reason, id: nb2.opponent.id, rating: nb2.rating }));
});

test('integration progress: crossing 1000 turns PRO and unlocks glove colours for the editor (§7.3–7.4)', () => {
  const store = new Storage({ backend: makeBackend(), ...makeDeterministic() });
  const id = store.createProfile({ name: 'Rio' }).profile.id;
  store.updateProfile(id, { skill: 990, tutorialDone: true });
  const flame = GLOVE_UNLOCKS.find((u) => u.at === 1000);
  assert(flame && !isGloveColorAllowed(store.getProfile(id), flame.color), 'locked below 1000');
  const b = playBout(store, id, { seed: 43 });
  const p = store.getProfile(id);
  assert(p.skill >= 1000 && p.pro && b.summary.becamePro, `PRO at ${p.skill}`);
  assert(b.summary.unlocked.some((u) => u.color === flame.color), 'the results card announces the unlock');
  assert(isGloveColorAllowed(p, flame.color), 'the editor now offers it');
  assert.equal(p.bestRating, p.skill);
});
