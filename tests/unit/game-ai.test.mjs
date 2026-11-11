// game/ai.js — opponent behaviour from research/mechanics.md §4.1–§4.6, checked in real bouts:
// strings, the four punish modes, keeps hitting a reeling player, cover-ups, holding a cocked punch
// while you lean, never groggy, guard reads, flurries, mood by round.
import { test, assert } from '../harness.mjs';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { OpponentAI, SCRIPT } from '../../src/game/ai.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';

const DT = 25;
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
const idle = (o) => ({ control: ctl(o), events: [] });
const punchEv = (hand = 'left', o = {}) => ({ type: 'punch', t: 0, punch: { hand, kind: 'straight', target: 'head', power: 0.5, t: 0, ...o } });
const opp = (ai = {}, base = ROSTER[4]) => ({
  ...base, id: `${base.id}-ai-test`,
  ai: { ...base.ai, firstAttackMs: 1e9, attackGapMs: 1e9, punishPct: 0, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, headGuard: 0, bodyGuard: 0, powerPct: 0, moodSwing: 0, holdWhileLeanMs: 0, ...ai },
});

function bout(def, seed = 1) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, fast: true, seed, p2: def });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0;
  const step = (input) => { now += DT; m.update(DT / 1000, now, { p1: input }); };
  const run = (ms, fn = () => idle()) => { const end = now + ms; while (now < end) step(fn()); };
  const until = (pred, fn = () => idle(), max = 20000) => { const end = now + max; while (!pred() && now < end) step(fn()); return pred(); };
  m.start(0);
  until(() => m.phase === MatchPhase.FIGHTING);
  return { m, log, step, run, until, of: (name, f = () => true) => log.filter((e) => e.name === name && f(e.p)) };
}

test('ai: attacks come as single punches, one-twos and strings of 3–4 per stringWeights, impact to impact ~stringGapMs', () => {
  const b = bout(opp({ firstAttackMs: 200, attackGapMs: 1500, stringWeights: [0, 0, 1], stringGapMs: 450, bodyPct: 0, tellMs: 250 }));
  b.run(6000, () => idle({ guard: 'high', guardAmount: 1 }));
  const thrown = b.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2');
  assert(thrown.length >= 6, `${thrown.length} punches`);
  const impacts = b.m.ais.p2.log.filter((e) => e.reason === 'attack' || e.reason === 'string').map((e) => e.reason);
  const strings = impacts.join(',').split('attack').filter(Boolean).map((s) => s.split(',').filter((x) => x === 'string').length + 1);
  assert(strings.slice(0, -1).every((n) => n === 3), `strings of 3: ${impacts.join(',')}`);
  const hands = thrown.slice(0, 3).map((e) => e.p.hand);
  assert(hands[0] !== hands[1] && hands[1] !== hands[2], 'alternating hands');
  const blocks = b.of(Ev.MATCH_BLOCK, (p) => p.attacker === 'p2').map((e) => e.t);
  for (let i = 1; i < 3; i++) assert(Math.abs(blocks[i] - blocks[i - 1] - 450) <= 2 * DT + 5, `impact gap ${blocks[i] - blocks[i - 1]}`);
});

test('ai: punishes a blocked punch — the counter lands within punishDelayMs of the green ring (§4.1.4)', () => {
  const b = bout(opp({ headGuard: 1, punishPct: 1, punishDelayMs: [500, 500], tellMs: 250 }));
  b.step({ control: ctl(), events: [punchEv()] });
  b.run(1200, () => idle());
  const block = b.of(Ev.MATCH_BLOCK, (p) => p.attacker === 'p1')[0];
  const ctr = b.of(Ev.MATCH_HIT, (p) => p.attacker === 'p2')[0];
  assert(block && ctr, 'blocked, then countered');
  assert(ctr.p.counter && ctr.p.heavy, 'a punish counter is a heavy hit (§2.3)');
  const impact = ctr.t - b.m.latencyMs - b.m.tuning.defenseGraceMs;
  assert(Math.abs(impact - block.t - 500) <= 3 * DT, `green ring → counter impact ${impact - block.t} ms`);
  assert(ctr.p.damage >= 1.1 * 2.5 * 0.7 - 0.01);
});

test('ai: slips a head punch and counters 0.2–0.3 s later (§2.5, §4.1.4)', () => {
  const b = bout(opp({ slipPct: 1, slipCounterMs: 250, tellMs: 200 }));
  b.step({ control: ctl(), events: [punchEv()] });
  b.run(1500, () => idle());
  const slip = b.of(Ev.MATCH_DODGE, (p) => p.attacker === 'p1')[0];
  assert(slip, 'the AI slipped it');
  assert(!b.of(Ev.MATCH_SLOWMO).length, 'no slow motion when the AI dodges');
  const ctr = b.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2' && p.counter)[0];
  assert(ctr, 'and countered');
  const tell = b.m.ais.p2.log.find((e) => e.reason === 'slip');
  assert(tell && tell.tellMs >= 200 && tell.tellMs <= 300 + DT, `slip counter tell ${tell && tell.tellMs}`);
});

test('ai: punches into the player\'s punch — lands 0.17–0.23 s after it starts (§4.3)', () => {
  const b = bout(opp({ punchIntoPct: 1 }));
  b.step({ control: ctl(), events: [punchEv()] });
  const started = b.m.boxers.p1.punches[0].thrownAt;
  b.run(800, () => idle());
  const req = b.m.ais.p2.log.find((e) => e.reason === 'punch-into');
  assert(req, 'punch-into requested');
  const hit = b.of(Ev.MATCH_HIT, (p) => p.attacker === 'p2')[0];
  assert(hit && hit.p.counter, 'landed as a counter on the punching player');
  const impactAt = hit.t - b.m.latencyMs - b.m.tuning.defenseGraceMs;
  assert(impactAt - started >= 170 - DT && impactAt - started <= 230 + 2 * DT, `${impactAt - started} ms after the player's punch started`);
});

test('ai: keeps hitting a reeling player — a landed punch can extend the attack (§4.1.5)', () => {
  const b = bout(opp({ firstAttackMs: 200, attackGapMs: 4000, stringWeights: [1], followUpPct: 1, stringGapReelMs: 600, bodyPct: 0 }));
  b.run(2500, () => idle());
  const hits = b.of(Ev.MATCH_HIT, (p) => p.attacker === 'p2');
  assert(hits.length >= 2, `a follow-up came (${hits.length})`);
  const gap = hits[1].t - hits[0].t;
  assert(gap >= 400 && gap <= 1000, `0.4–0.94 s apart (${gap})`);
});

test('ai: covers up with a high guard after two quick hits, then punishes out of it (§2.7, §4.1.6)', () => {
  const b = bout(opp({ coverUpPct: 1, punishPct: 1, punishDelayMs: [400, 400], reelMs: 500, stunGuardMul: 1 }));
  b.step({ control: ctl(), events: [punchEv('left')] });
  b.run(250, () => idle());
  b.step({ control: ctl(), events: [punchEv('right')] });
  b.run(200, () => idle());
  assert(b.m.getView().boxers.p2.covering, 'covering after two hits within 1 s');
  b.step({ control: ctl(), events: [punchEv('left')] });
  b.run(1200, () => idle());
  assert(b.of(Ev.MATCH_BLOCK, (p) => p.attacker === 'p1').length >= 1, 'the third punch hit the cover');
  assert(b.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2' && p.counter).length >= 1, 'and the AI punished out of the cover');
});

test('ai: holds a cocked punch (up to holdWhileLeanMs) while the player leans, releasing when they come back (§4.1.7)', () => {
  const b = bout(opp({ firstAttackMs: 200, stringWeights: [1], holdWhileLeanMs: 1000, tellMs: 300, bodyPct: 0 }));
  let windupAt = null;
  b.until(() => { if (b.m.boxers.p2.windup && windupAt == null) windupAt = b.m.wt; return windupAt != null; }, () => idle({ lean: { x: 0.9, y: 0, z: 0 } }), 3000);
  b.run(600, () => idle({ lean: { x: 0.9, y: 0, z: 0 } }));
  const w = b.m.boxers.p2.windup;
  assert(w && w.held, 'still cocked 0.6 s into a 0.3 s tell');
  assert(b.m.getView().boxers.p2.windup.held);
  b.run(100, () => idle());
  b.run(400, () => idle());
  assert(b.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2').length === 1, 'released once the player came back to centre');
  const c = bout(opp({ firstAttackMs: 200, stringWeights: [1], holdWhileLeanMs: 1000, tellMs: 300 }), 2);
  c.run(2500, () => idle({ lean: { x: 0.9, y: 0, z: 0 } }));
  assert(c.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2').length >= 1, 'released after at most 1 s even if the lean stays');
});

test('ai: never gets groggy — no daze, no lowered guard, still punching at almost 0 health (§4.1.8)', () => {
  const b = bout(opp({ firstAttackMs: 300, attackGapMs: 1200, stringWeights: [1], headGuard: 0 }));
  b.m.debugSetHp('p2', 0.2);
  for (let i = 0; i < 6; i++) { b.step({ control: ctl(), events: [punchEv(i % 2 ? 'right' : 'left', { target: 'body', power: 0 })] }); b.run(400, () => idle({ guard: 'high', guardAmount: 1 })); }
  assert(!b.of(Ev.MATCH_DAZED).length, 'never dazed');
  const c = bout(opp({ firstAttackMs: 300, attackGapMs: 1000, stringWeights: [1] }), 3);
  c.m.debugSetHp('p2', 0.05);
  c.run(3000, () => idle({ guard: 'high', guardAmount: 1 }));
  assert(c.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2').length >= 2, 'keeps punching on an empty pie');
  assert.notEqual(c.m.getView().boxers.p2.phase, 'dazed');
});

test('ai: guard reads — an idle AI blocks about headGuard of head punches; flurries and fresh reels meet a set guard', () => {
  let blocked = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const b = bout(opp({ headGuard: 0.6, bodyGuard: 0.2 }), seed);
    b.step({ control: ctl(), events: [punchEv()] });
    b.run(300);
    n++;
    if (b.of(Ev.MATCH_BLOCK, (p) => p.attacker === 'p1').length) blocked++;
  }
  assert(blocked / n > 0.42 && blocked / n < 0.78, `~60 % blocked (${blocked}/${n})`);
  // a flurry: the third and later punches inside 0.9 s are read with +flurryGuard (roster entries may set more)
  const ai = new OpponentAI(opp({ headGuard: 0.5 }), 1);
  assert(ai.p.flurryGuard >= 0.25);
  assert(ai.p.streakBlock >= 0.8 && ai.p.postReelGuardMs >= 300);
  const plain = new OpponentAI({ ai: {} }, 1);
  assert(plain.p.flurryGuard === 0.25 && plain.p.streakBlock === 0.85 && plain.p.postReelGuardMs === 400, 'defaults');
});

test('ai: an attack the player dodges is over — the rest of the string is abandoned (§2.3)', () => {
  const b = bout(opp({ firstAttackMs: 200, attackGapMs: 1e9, stringWeights: [0, 0, 0, 1], stringGapMs: 500, bodyPct: 0, punchMix: { straight: 1, hook: 0, uppercut: 0 } }));
  b.run(3000, () => idle({ lean: { x: 0.9, y: 0, z: 0 } }));
  const thrown = b.of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2');
  assert(b.of(Ev.MATCH_DODGE, (p) => p.defender === 'p1').length >= 1, 'dodged');
  assert(thrown.length <= 2, `the 4-punch string stopped after the dodge (${thrown.length})`);
});

test('ai: mood can change between rounds; the champion is cagey in round 1 (§4.1.9)', () => {
  const champ = new OpponentAI(ROSTER[9], 5);
  champ.newRound(1);
  const g1 = champ._gap(), c1 = champ._guardChance(true);
  champ.newRound(2);
  const g2 = champ._gap(), c2 = champ._guardChance(true);
  assert(g1 > g2 * 1.8, `gaps ${g1} → ${g2}`);
  assert(c1 > c2, 'a tighter guard in round 1');
  let changed = 0;
  for (let s = 0; s < 60; s++) { const a = new OpponentAI(opp({ moodSwing: 0.5 }), s); a.newRound(2); if (a.mood !== 1) changed++; }
  assert(changed > 15 && changed < 45, `mood swings ~50 % (${changed}/60)`);
});

test('ai: tutorial scripts exist for all six steps and only the attacking steps attack', () => {
  for (const step of ['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge']) assert(SCRIPT[step], step);
  assert(!SCRIPT.stance.attack && !SCRIPT['punch-head'].attack && !SCRIPT['punch-body'].attack);
  assert(SCRIPT.dodge.attack.power && SCRIPT.dodge.attack.tellMs >= 800);
  assert.equal(SCRIPT['guard-body'].attack.target, 'body');
});
