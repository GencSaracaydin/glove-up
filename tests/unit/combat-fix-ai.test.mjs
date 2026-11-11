// Fix pass (combat): the punish ramp (RULES-03), the debug knockdown's synthetic blow (Q6) and the hit-stop
// mirror the timers are netted against (COMBAT.hitStop = render/fx.js FX_TUNING.hitStop).
import { test, assert } from '../harness.mjs';
import { COMBAT, stallMsFor, netOfStall } from '../../src/game/combat.js';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { OpponentAI } from '../../src/game/ai.js';
import { Boxer } from '../../src/game/boxer.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';
import { Rng } from '../../src/core/rng.js';

const DT = 20;
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.1, punching: false } },
  activity: 0, ...o,
});

test('combat-fix RULES-03: the roster punishes blocked punches on the §4.5b ramp — rarely below 600, nearly always at the top', () => {
  const pct = ROSTER.map((d) => d.ai.punishPct);
  assert.deepEqual(pct.slice(6), [0.85, 0.7, 0.75, 0.85], '§4.5b #7–#10');
  assert(pct.slice(0, 4).every((p) => p <= 0.3), `below 600: ${pct.slice(0, 4)}`);
  assert(Math.min(...pct.slice(6)) > Math.max(...pct.slice(0, 6)), 'the PRO tier punishes more than anyone below it');
});

/**
 * Isolated head jabs into a high guard every 1.8–2.6 s with the normal brain running: share of blocks punished — a counter
 * actually THROWN (MATCH_PUNCH_THROWN, counter) within 1.2 s of the green ring, as the player sees it (the polish round's
 * first pass cocked punishes and lowered most of them; a counter that is only cocked does not count).
 */
function punishShare(def, seeds) {
  let blocked = 0, punished = 0;
  for (const seed of seeds) {
    const bus = new EventBus(); const blocks = []; const thrown = [];
    const m = new Match({ bus, seed, p2: def, fast: false });
    bus.on(Ev.MATCH_BLOCK, (p) => { if (p.attacker === 'p1') blocks.push(m.wt); });
    bus.on(Ev.MATCH_PUNCH_THROWN, (p) => { if (p.attacker === 'p2' && p.counter) thrown.push(m.wt); });
    const rng = new Rng(seed + 99);
    let now = 0, next = null;
    m.start(0);
    while (now < 70000 && m.phase !== MatchPhase.RESULT) {
      now += DT;
      const ev = [];
      if (m.phase === MatchPhase.FIGHTING && m.stage === 'live') {
        if (next == null) next = now + 1500;
        if (now >= next) { ev.push({ type: 'punch', t: now, punch: { hand: rng.chance(0.5) ? 'left' : 'right', kind: 'straight', target: 'head', power: 0.6, t: now } }); next = now + rng.range(1800, 2600); }
      } else next = null;
      if (m.phase === MatchPhase.FIGHTING) { if (m.boxers.p1.hp < 3) m.debugSetHp('p1', 10); if (m.boxers.p2.hp < 3) m.debugSetHp('p2', 10); }
      m.update(DT / 1000, now, { p1: { control: ctl({ guard: 'high', guardAmount: 1 }), events: ev } });
    }
    for (const b of blocks) { blocked++; if (thrown.some((x) => x >= b && x <= b + 1200)) punished++; }
  }
  return { blocked, share: punished / Math.max(1, blocked) };
}

test('combat-fix RULES-03: a PRO opponent punishes nearly every isolated blocked jab; a low-rated one rarely (t-punish)', () => {
  const top = punishShare(ROSTER[6], [1, 2, 3]);
  const low = punishShare(ROSTER[2], [1, 2, 3]);
  assert(top.blocked >= 40 && low.blocked >= 25, `enough blocks (${top.blocked}, ${low.blocked})`);
  assert(top.share >= 0.72, `#7 punished ${Math.round(100 * top.share)}% (before the fix ~21 %; §4.2 "nearly every")`);
  assert(low.share <= 0.35, `#3 punished ${Math.round(100 * low.share)}% (§4.2 "rarely counters")`);
});

test('combat-fix RULES-03: a punish replaces a pending string; a cocked wind-up becomes the counter', () => {
  const def = { ...ROSTER[6], ai: { ...ROSTER[6].ai, punishPct: 1 } };
  // pending string: the plan is made and the rest of the attack is dropped
  const ai = new OpponentAI(def, 1);
  const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  ai.string = { total: 3, left: 2, pending: false, lastImpactAt: 900, lastHand: 'left', nextTarget: 'head' };
  ai._onFoeOutcome(1000, self, null, { id: 7, outcome: 'blocked', resolvedAt: 1000 });
  assert(ai.counterPlan && ai.counterPlan.reason === 'punish' && ai.string === null, 'punish planned, string dropped');
  const d = ai.counterPlan.impactAt - 1000;
  assert(d >= def.ai.punishDelayMs[0] && d <= def.ai.punishDelayMs[1], `green ring → counter impact ${d} ms`);
  assert(ai.nextAttackAt >= 1000 + 0.5 * def.ai.attackGapMs, 'the next attack waits a rest after the punish');
  // a wind-up already cocked and landing 0.2–0.82 s after the green ring becomes the punish counter
  const ai2 = new OpponentAI(def, 2);
  const self2 = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  self2.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  const w = self2.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 250 }, 900);
  ai2._onFoeOutcome(1000, self2, null, { id: 8, outcome: 'blocked', resolvedAt: 1000 });
  assert(w.counter === true && ai2.counterPlan === null, 'the cocked punch is the punish');
  const log = ai2.log[ai2.log.length - 1];
  assert(log.reason === 'punish' && log.converted && log.t + log.tellMs === w.end + w.travelMs);
  const thrown = self2.update(w.end).find((n) => n.type === 'thrown').punch;
  assert(thrown.counter, 'it lands as a counter (×2.5, heavy)');
});

test('combat-fix Q6: debugKnockdown records a synthetic blow — MATCH_HIT then MATCH_KNOCKDOWN {blow}, the glove out, finalBlow on the KO', () => {
  const bus = new EventBus(); const log = [];
  bus.on('*', (n, p) => log.push({ n, p }));
  const m = new Match({ bus, seed: 4, p2: { ...ROSTER[0], ai: { ...ROSTER[0].ai, firstAttackMs: 1e9 } }, fast: true });
  let now = 0; m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
  assert(m.debugKnockdown('p2', { stayDown: true, hand: 'left', kind: 'hook' }));
  const i = log.findIndex((e) => e.n === Ev.MATCH_HIT), k = log.findIndex((e) => e.n === Ev.MATCH_KNOCKDOWN);
  assert(i >= 0 && k > i, 'the blow comes before the knockdown, like a real one');
  const hit = log[i].p;
  assert(hit.knockdown && hit.synthetic && hit.attacker === 'p1' && hit.defender === 'p2' && hit.hand === 'left' && hit.kind === 'hook' && hit.target === 'head' && hit.hpAfter === 0);
  const blow = log[k].p.blow;
  assert(blow && blow.synthetic && blow.attacker === 'p1' && blow.hand === 'left' && blow.kind === 'hook' && Number.isFinite(blow.impactAt));
  const v = m.getView().boxers.p1;
  assert(v.punches.some((p) => p.hand === 'left' && p.kind === 'hook' && p.outcome === 'hit' && p.progress > 0.9), 'the glove shows at full extension');
  assert.equal(m.boxers.p1.stats.landed, 0, 'no stats for a debug blow');
  while (m.phase !== MatchPhase.RESULT && now < 30000) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
  const r = m.getResult();
  assert(r.method === 'KO' && r.finalBlow && r.finalBlow.hand === 'left' && r.finalBlow.synthetic, 'the KO result carries the final blow');
  // the default blow: the scorer's rear straight to the head; a real knockdown records its real punch
  const m2 = new Match({ bus: new EventBus(), seed: 5, p2: { ...ROSTER[0], ai: { ...ROSTER[0].ai, firstAttackMs: 1e9, headGuard: 0, bodyGuard: 0 } }, fast: true });
  let n2 = 0; m2.start(0);
  while (m2.phase !== MatchPhase.FIGHTING) { n2 += DT; m2.update(DT / 1000, n2, { p1: { control: ctl(), events: [] } }); }
  m2.debugSetHp('p2', 0.3);
  n2 += DT; m2.update(DT / 1000, n2, { p1: { control: ctl(), events: [{ type: 'punch', t: n2, punch: { hand: 'right', kind: 'uppercut', target: 'head', power: 0.9 } }] } });
  for (let j = 0; j < 20 && !m2.kd; j++) { n2 += DT; m2.update(DT / 1000, n2, { p1: { control: ctl(), events: [] } }); }
  assert(m2.kd && m2.kd.blow && !m2.kd.blow.synthetic && m2.kd.blow.kind === 'uppercut' && m2.kd.blow.hand === 'right', 'a real knockdown blow is recorded too');
});

test('combat-fix: COMBAT.hitStop mirrors the renderer (render/fx.js) — stallMsFor = hitStopMsFor; netOfStall', async () => {
  const FX = await import('../../src/render/fx.js'); // pure module, imports in Node (render/fx.js header)
  {
    const H = FX.FX_TUNING.hitStop;
    for (const k of ['scale', 'big', 'knockdown', 'onHuman', 'onHumanHeavy']) assert.equal(COMBAT.hitStop[k], H[k], k);
    assert.equal(COMBAT.hitStop.hit, H.playerHit);
    const human = (id) => id === 'p1';
    for (const e of [{ attacker: 'p1' }, { attacker: 'p1', heavy: true }, { attacker: 'p1', counter: true }, { attacker: 'p1', knockdown: true },
      { attacker: 'p2' }, { attacker: 'p2', heavy: true }, { attacker: 'p2', knockdown: true }, { attacker: 'p2', defender: 'p1', counter: true }]) {
      assert.equal(stallMsFor(e, human), FX.hitStopMsFor(e, human), JSON.stringify(e));
    }
  }
  assert.equal(netOfStall(900, 500), 900 - 500 * 0.98);
  assert.equal(netOfStall(100, 500), 100 * 0.02, 'never negative');
});
