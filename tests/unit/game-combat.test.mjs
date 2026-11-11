// game/combat.js — resolvePunch (COM05, COM06, A04, A05) with the research/mechanics.md rules:
// wedge damage, no chip, counters ×2.5 capped at 4, the knockdown rule and the latency-fair window.
import { test, assert } from '../harness.mjs';
import { COMBAT, resolvePunch, evasionFor, dodgeLeanFor, travelMs, openTarget, guardFor, humanDamage, isLeaning } from '../../src/game/combat.js';
import { Rng } from '../../src/core/rng.js';

const ZERO = { x: 0, y: 0, z: 0 };
const att = (o = {}) => ({ isHuman: true, phase: 'punch', guard: 'none', lean: ZERO, power: 1, comboCount: 0, ...o });
const def = (o = {}) => ({ isHuman: false, phase: 'idle', guard: 'none', guardAmount: 1, lean: ZERO, hp: 10, maxHp: 10, takenCombo: 0, ...o });
const P = (o = {}) => ({ hand: 'left', kind: 'straight', target: 'head', power: 0.6, counter: false, impactAt: 1000, ...o });
const res = (d, p, a = att()) => resolvePunch({ attacker: a, defender: d, punch: P(p), now: 1000 });

test('combat: wedges — the player\'s clean hit is 1.2 + 0.5·power², an AI punch carries its own damage; no chip, no daze', () => {
  const slow = res(def(), { power: 0 }), fast = res(def(), { power: 1 }), mid = res(def(), { power: 0.6 });
  assert.equal(slow.result, 'hit');
  assert.equal(slow.damage, 1.2);
  assert.equal(fast.damage, 1.7);
  assert.equal(mid.damage, Math.round((1.2 + 0.5 * 0.36) * 100) / 100);
  assert.equal(humanDamage(0.6), 1.2 + 0.5 * 0.36);
  assert.equal(mid.hpBefore, 10);
  assert.equal(mid.hpAfter, Math.round((10 - mid.damage) * 100) / 100);
  assert.equal(mid.dealt, mid.damage);
  assert(mid.chip === 0 && mid.daze === 0 && mid.dazedTarget === false);
  const ai = res(def({ isHuman: true }), { damage: 1.1 }, att({ isHuman: false }));
  assert.equal(ai.damage, 1.1, 'AI punches use their roster damage');
  const aiDefault = res(def({ isHuman: true }), {}, att({ isHuman: false }));
  assert.equal(aiDefault.damage, COMBAT.aiBaseDamage);
});

test('combat: a high guard blocks head shots for nothing (no chip) and leaves the body open', () => {
  for (const kind of ['straight', 'hook', 'uppercut']) {
    const r = res(def({ guard: 'high' }), { kind });
    assert.equal(r.result, 'blocked', kind);
    assert(r.chip === 0 && r.damage === 0 && r.hpAfter === 10, `${kind}: no chip`);
    assert.equal(r.blockedBy, 'high');
  }
  assert.equal(res(def({ guard: 'high' }), { target: 'body' }).result, 'hit');
});

test('combat: a low guard blocks body shots and leaves the head open', () => {
  assert.equal(res(def({ guard: 'low' }), { target: 'body', kind: 'hook' }).result, 'blocked');
  assert.equal(res(def({ guard: 'low' }), { target: 'head' }).result, 'hit');
});

test('combat: hit, block and dodge are three distinct outcomes for the same punch (A04)', () => {
  const p = { kind: 'straight', target: 'head' };
  const outcomes = new Set([res(def(), p).result, res(def({ guard: 'high' }), p).result, res(def({ lean: { x: 0.8, y: 0, z: 0 } }), p).result]);
  assert.deepEqual([...outcomes].sort(), ['blocked', 'dodged', 'hit']);
});

test('combat: straights are dodged by any clear lean or a duck', () => {
  for (const lean of [{ x: 0.6, y: 0, z: 0 }, { x: -0.6, y: 0, z: 0 }, { x: 0, y: -0.6, z: 0 }]) {
    assert.equal(res(def({ lean }), { kind: 'straight' }).result, 'dodged', JSON.stringify(lean));
  }
  assert.equal(res(def({ lean: { x: COMBAT.dodgeLeanThreshold * 0.6, y: 0, z: 0 } }), {}).result, 'hit', 'small lean is not a dodge');
  assert(isLeaning({ x: 0.5, y: 0, z: 0 }) && !isLeaning({ x: 0.1, y: -0.1, z: 0 }));
});

test('combat: hooks are dodged leaning away from the arriving glove or ducking; leaning into one is flagged', () => {
  assert.equal(res(def({ lean: { x: -0.7, y: 0, z: 0 } }), { kind: 'hook', hand: 'left' }).result, 'dodged');
  assert.equal(res(def({ lean: { x: 0.7, y: 0, z: 0 } }), { kind: 'hook', hand: 'right' }).result, 'dodged');
  assert.equal(res(def({ lean: { x: 0, y: -0.7, z: 0 } }), { kind: 'hook', hand: 'left' }).result, 'dodged', 'duck');
  const into = res(def({ lean: { x: 0.7, y: 0, z: 0 } }), { kind: 'hook', hand: 'left' });
  assert.equal(into.result, 'hit');
  assert(into.into, 'leaning into the hook is reported');
});

test('combat: uppercuts are dodged sideways but NOT by ducking', () => {
  assert.equal(res(def({ lean: { x: 0.7, y: 0, z: 0 } }), { kind: 'uppercut' }).result, 'dodged');
  assert.equal(res(def({ lean: { x: -0.7, y: 0, z: 0 } }), { kind: 'uppercut' }).result, 'dodged');
  const duck = res(def({ lean: { x: 0, y: -0.8, z: 0 } }), { kind: 'uppercut' });
  assert(duck.result === 'hit' && duck.into);
});

test('combat: body shots are never dodged by leaning or ducking — only a low guard stops them', () => {
  for (const lean of [{ x: 0.9, y: 0, z: 0 }, { x: -0.9, y: 0, z: 0 }, { x: 0, y: -0.9, z: 0 }, { x: 0, y: 0, z: -1 }]) {
    for (const kind of ['straight', 'hook', 'uppercut']) {
      assert.equal(res(def({ lean }), { kind, target: 'body' }).result, 'hit', `${kind} ${JSON.stringify(lean)}`);
    }
  }
  assert.equal(res(def({ guard: 'low', lean: { x: 0.9, y: 0, z: 0 } }), { target: 'body' }).result, 'blocked');
});

test('combat: leaning far back takes you out of reach; the attacker leaning in cancels part of it', () => {
  const back = { x: 0, y: 0, z: -0.8 };
  assert.equal(res(def({ lean: back }), {}).dodge, 'back');
  assert.equal(res(def({ lean: back }), {}, att({ lean: { x: 0, y: 0, z: 1 } })).result, 'hit');
});

test('combat: counters do ×2.5, capped at 4 wedges, and are heavy; a blocked counter is no counter (COM06)', () => {
  const normal = res(def(), { power: 0.6 });
  const counter = res(def(), { power: 0.6, counter: true });
  assert(counter.counter && counter.heavy && !normal.counter && !normal.heavy);
  assert.equal(counter.damage, Math.round(normal.damage * 2.5 * 100) / 100);
  assert.equal(res(def(), { power: 1, counter: true }).damage, COMBAT.counterDamageCap, 'cap 4');
  const aiCounter = res(def({ isHuman: true }), { damage: 1.1, counter: true }, att({ isHuman: false }));
  assert.equal(aiCounter.damage, 2.75, 'AI counters: ordinary 1.1 × 2.5');
  const power = res(def({ isHuman: true }), { damage: 3, powerPunch: true }, att({ isHuman: false }));
  assert(power.heavy && power.powerPunch && power.damage === 3);
  const blocked = res(def({ guard: 'high' }), { counter: true });
  assert(blocked.result === 'blocked' && blocked.counter === false);
});

test('combat: per-hit damage varies ±30 % with an rng (seeded, reproducible); a combo hit is heavy', () => {
  const rng = new Rng(4);
  const seen = [];
  for (let i = 0; i < 400; i++) seen.push(resolvePunch({ attacker: att(), defender: def(), punch: P({ power: 0 }), now: 1000, rng }).damage);
  const lo = Math.min(...seen), hi = Math.max(...seen);
  assert(lo >= 1.2 * 0.7 - 0.01 && hi <= 1.2 * 1.3 + 0.01, `${lo}..${hi}`);
  assert(lo < 1.0 && hi > 1.4, 'the spread is used');
  const a = resolvePunch({ attacker: att(), defender: def(), punch: P(), now: 1000, rng: new Rng(9) });
  const b = resolvePunch({ attacker: att(), defender: def(), punch: P(), now: 1000, rng: new Rng(9) });
  assert.deepEqual(a, b);
  assert(res(def(), {}, att({ comboCount: 1 })).heavy, 'second hit of a quick pair = big hit (§2.8)');
});

test('combat: knockdown when the damage is at least the health left; an ordinary hit never floors a fighter with more than 1.5', () => {
  const r1 = res(def({ hp: 1.0 }), { power: 0 });
  assert(r1.knockdown && r1.hpAfter === 0, 'clean hit on an almost empty pie floors');
  const r2 = res(def({ hp: 1.4 }), { power: 1 });
  assert(r2.knockdown, '1.7 ≥ 1.4 with only 1.4 left (≤ 1.5): down');
  const r3 = res(def({ hp: 1.6 }), { power: 1 });
  assert(!r3.knockdown && r3.hpAfter === COMBAT.warningBeatLeave, 'warning beat: 1.6 left → a 0.1 sliver, not a knockdown');
  const r4 = res(def({ hp: 3 }), { counter: true, power: 1 });
  assert(r4.knockdown, 'a heavy counter can empty the pie and floor in one blow (§2.9)');
  const r5 = res(def({ hp: 5 }), { power: 1 });
  assert(!r5.knockdown && r5.hpAfter === 3.3);
  const tut = resolvePunch({ attacker: att(), defender: def({ hp: 0.5 }), punch: P(), now: 1000, noDamage: true });
  assert(tut.result === 'hit' && !tut.knockdown && tut.hpAfter === 0.5, 'noDamage (tutorial)');
});

test('combat: reels — an AI hit cleanly reels for its reelMs (shorter in a flurry, ≥ 0.47 s for counters); a human only loses punches briefly', () => {
  assert.equal(res(def({ reelMs: 600 }), {}).stunMs, 600);
  assert.equal(res(def({ reelMs: 600, takenCombo: 1 }), {}).stunMs, Math.round(600 * COMBAT.stunDecay));
  assert(res(def({ reelMs: 300, takenCombo: 3 }), { counter: true }).stunMs >= COMBAT.counterStunMs);
  assert.equal(res(def({ isHuman: true }), { damage: 1.1 }, att({ isHuman: false })).stunMs, COMBAT.humanHitLockMs);
  assert.equal(res(def({ isHuman: true }), { damage: 3, powerPunch: true }, att({ isHuman: false })).stunMs, COMBAT.humanHeavyLockMs);
});

test('combat: human guard needs guardAmount ≥ guardMinAmount', () => {
  assert.equal(res(def({ isHuman: true, guard: 'high', guardAmount: COMBAT.guardMinAmount - 0.1 }), {}, att({ isHuman: false })).result, 'hit');
  assert.equal(res(def({ isHuman: true, guard: 'high', guardAmount: 0.9 }), {}, att({ isHuman: false })).result, 'blocked');
});

test('combat: boxers on the canvas / getting up / KO cannot be hit (miss)', () => {
  for (const phase of ['down', 'getup', 'ko']) assert.equal(res(def({ phase }), {}).result, 'miss', phase);
  assert.equal(res(def({ invulnerable: true }), {}).result, 'miss');
});

test('combat: latency fairness — the human is judged on the pose the camera shows latencyMs after impact', () => {
  const impactAt = 1000;
  const lat = 100;
  const samples = (from, to = Infinity) => {
    const out = [];
    for (let t = 800; t <= 1400; t += 10) out.push({ t, guard: 'none', guardAmount: 0, lean: t >= from && t < to ? { x: 0.8, y: 0, z: 0 } : ZERO });
    return out;
  };
  const human = (s) => def({ isHuman: true, samples: s, latencyMs: lat });
  const judge = (s) => resolvePunch({ attacker: att({ isHuman: false }), defender: human(s), punch: P({ impactAt }), now: impactAt + lat + COMBAT.defenseGraceMs }).result;
  assert.equal(judge(samples(impactAt + lat - 20)), 'dodged', 'the lean the camera reported 80 ms after contact was there at impact');
  assert.equal(judge(samples(impactAt + lat + COMBAT.defenseGraceMs + 30)), 'hit', 'too late');
  assert.equal(judge(samples(900, impactAt + lat - COMBAT.defenseEarlyMs - 20)), 'hit', 'leaned too early and came back');
  const s3 = samples(99999).map((s) => ({ ...s, guard: s.t >= 1080 && s.t <= 1110 ? 'high' : 'none', guardAmount: 1 }));
  assert.equal(resolvePunch({ attacker: att({ isHuman: false }), defender: human(s3), punch: P({ impactAt }), now: 1160 }).result, 'blocked', 'best defence in the window counts');
  // latency 0 judges around the contact itself
  const zero = def({ isHuman: true, latencyMs: 0, samples: samples(impactAt + 90) });
  assert.equal(resolvePunch({ attacker: att({ isHuman: false }), defender: zero, punch: P({ impactAt }), now: 1100 }).result, 'hit');
});

test('combat: resolvePunch is pure and deterministic for a given rng', () => {
  const a = att(), d = def({ guard: 'low' }), p = P();
  const before = JSON.stringify({ a, d, p });
  const r1 = resolvePunch({ attacker: a, defender: d, punch: p, now: 1000, rng: new Rng(5) });
  const r2 = resolvePunch({ attacker: a, defender: d, punch: p, now: 1000, rng: new Rng(5) });
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify({ a, d, p }), before, 'inputs untouched');
});

test('combat: helpers — evasion geometry, dodge suggestions, travel times, open targets', () => {
  assert.equal(evasionFor({ kind: 'hook', target: 'head', hand: 'right' }, { x: 0.8, y: 0 }), 'lean');
  assert.equal(evasionFor({ kind: 'hook', target: 'head', hand: 'right' }, { x: -0.8, y: 0 }), null);
  const rng = new Rng(3);
  for (let i = 0; i < 50; i++) {
    for (const kind of ['straight', 'hook', 'uppercut']) {
      const punch = { kind, target: 'head', hand: rng.pick(['left', 'right']) };
      assert(evasionFor(punch, dodgeLeanFor(punch, rng)), `suggested dodge works for ${kind}`);
    }
  }
  assert.equal(dodgeLeanFor({ kind: 'straight', target: 'body', hand: 'left' }), null);
  const th = ['straight', 'hook', 'uppercut'].map((k) => travelMs(k, true));
  assert(th[0] >= 70 && th[2] <= 130 && th[0] <= th[1] && th[1] <= th[2], `human travel 0.07–0.13 s (§2.2): ${th}`);
  assert.equal(travelMs('hook', false, 1, COMBAT, true), COMBAT.powerTravelMs, 'power swing');
  assert.equal(openTarget('high'), 'body');
  assert.equal(openTarget('low'), 'head');
  assert.equal(openTarget('none'), null);
  assert.equal(guardFor('body'), 'low');
  assert.equal(COMBAT.maxHp, 10);
  assert(COMBAT.regenPerSec01 === 0 && COMBAT.perHandMs === 200 && COMBAT.betweenHandsMs === 100);
});
