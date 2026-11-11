// Repair round (combat), RV-RULES-03: a blocked flurry is ONE exchange — the AI punishes it at most once (one
// punishPct roll per blocked exchange, none while a punish is planned, cocked or in the air), and a punish that
// can only start late keeps the opponent's normal tell instead of collapsing to COMBAT.minTellMs.
import { test, assert } from '../harness.mjs';
import { COMBAT } from '../../src/game/combat.js';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { OpponentAI, AI_DEFAULTS } from '../../src/game/ai.js';
import { Boxer } from '../../src/game/boxer.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';

const DT = 1000 / 60;
const ctl = (guard) => ({
  tracked: true, confidence: 1, guard, guardAmount: guard === 'none' ? 0 : 1, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.25, y: 0.5, reach: 0.1, punching: false }, right: { x: 0.25, y: 0.5, reach: 0.1, punching: false } },
  activity: 0.2,
});

/**
 * #7 that reads every head punch as a block (headGuard 1) and punishes every blocked exchange (punishPct 1), its
 * own attacks off: the player throws 3-jab head flurries 200 ms apart (guard back 300 ms after the last) every
 * 2.6 s. Returns, per flurry with a block, the AI counter punches THROWN within 1.5 s of its first block.
 */
function flurryCounters(seed, { gap = 200, n = 3 } = {}) {
  const def = { ...ROSTER[6], ai: { ...ROSTER[6].ai, punishPct: 1, headGuard: 1, flurryGuard: 0, firstAttackMs: 1e9, attackGapMs: 1e9, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, feintChance: 0 } };
  const bus = new EventBus();
  const m = new Match({ bus, seed, p2: def, id: 'rv03' });
  const ev = [];
  bus.on('*', (name, p) => ev.push({ t: m.t, name, p }));
  m.start(0);
  let now = 0, next = null, plan = [], guardBack = -1, fi = 0;
  const starts = [];
  while (m.phase !== MatchPhase.RESULT && now < 40000) {
    now += DT;
    const evs = [];
    if (m.phase === MatchPhase.FIGHTING && m.stage === 'live') {
      if (next === null) next = now + 800;
      if (now >= next && !plan.length) {
        starts.push(m.t);
        plan = Array.from({ length: n }, (_, i) => now + i * gap);
        guardBack = now + (n - 1) * gap + 300;
        next = now + 2600;
      }
      while (plan.length && now >= plan[0]) { plan.shift(); evs.push({ type: 'punch', punch: { hand: fi++ % 2 ? 'right' : 'left', kind: 'straight', target: 'head', power: 0.6 } }); }
      if (m.boxers.p1.hp < 4) m.debugSetHp('p1', 10);
    } else { next = null; plan = []; }
    const guard = plan.length || now < guardBack ? 'none' : 'high';
    m.update(DT / 1000, now, { p1: { control: ctl(guard), events: evs } });
  }
  const blocks = ev.filter((e) => e.name === Ev.MATCH_BLOCK && e.p.attacker === 'p1');
  const thrown = ev.filter((e) => e.name === Ev.MATCH_PUNCH_THROWN && e.p.attacker === 'p2' && e.p.counter);
  const out = [];
  for (const st of starts) {
    const b = blocks.find((x) => x.t >= st && x.t <= st + (n - 1) * gap + 300);
    if (!b) continue;
    out.push(thrown.filter((h) => h.t >= b.t && h.t <= b.t + 1500).length);
  }
  return out;
}

test('combat-repair RV-RULES-03: a blocked 3-jab flurry draws exactly one counter punch (#7, punishPct 1)', () => {
  const per = [];
  for (const seed of [1, 2, 3, 4]) per.push(...flurryCounters(seed));
  assert(per.length >= 30, `enough blocked flurries (${per.length})`);
  const twoPlus = per.filter((c) => c >= 2).length;
  const none = per.filter((c) => c === 0).length;
  // before the fix every later blocked jab of the flurry rolled punishPct again: 2–3 counters per flurry
  assert.equal(twoPlus, 0, `flurries answered by 2+ counter punches: ${twoPlus} of ${per.length} (${per.join('')})`);
  assert(none <= 0.1 * per.length, `punishPct 1 still punishes the exchange (${none} of ${per.length} unanswered)`);
});

test('combat-repair RV-RULES-03: a longer flurry (5 jabs, 150 ms apart) is still answered once', () => {
  const per = [];
  for (const seed of [5, 6]) per.push(...flurryCounters(seed, { gap: 150, n: 5 }));
  assert(per.length >= 15, `enough blocked flurries (${per.length})`);
  assert(per.every((c) => c <= 1), `counter punches per flurry: ${per.join('')}`);
});

test('combat-repair RV-RULES-03: a converted wind-up closes the exchange — the next blocked jab does not roll again', () => {
  const def = { ...ROSTER[6], ai: { ...ROSTER[6].ai, punishPct: 1 } };
  const ai = new OpponentAI(def, 3);
  const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  self.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  // cocked at 900, lands at 1600: 0.6 s after the green ring at 1000 (inside the 0.2–0.82 s punish window)
  const w = self.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 600 }, 900);
  ai._onFoeOutcome(1000, self, null, { id: 8, outcome: 'blocked', resolvedAt: 1000 });
  assert(w.counter === true && ai.counterPlan === null, 'the cocked punch is the punish');
  // the flurry's second jab is blocked 200 ms later, and a third one after the exchange window but before the
  // converted punch has landed + punishedMs: neither plans a second punish
  ai._onFoeOutcome(1200, self, null, { id: 9, outcome: 'blocked', resolvedAt: 1200 });
  assert.equal(ai.counterPlan, null, 'second block of the exchange: no new plan');
  const impact = w.end + w.travelMs;
  const third = 1000 + AI_DEFAULTS.exchangeMs + 50;
  assert(third < impact + AI_DEFAULTS.punishedMs, 'the third block comes while the punish is still due');
  ai._onFoeOutcome(third, self, null, { id: 10, outcome: 'blocked', resolvedAt: third });
  assert.equal(ai.counterPlan, null, 'the punish is still in the air: no new plan');
  // a fresh exchange after the punish has landed rolls again (and comes more than punishMashMs after the last green ring:
  // blocked again sooner, the player keeps punching into the guard — since the polish round's R10 that punish waits for
  // the next punch instead, combat-polish-r10)
  const later = Math.max(impact + AI_DEFAULTS.punishedMs + AI_DEFAULTS.exchangeMs, third + (AI_DEFAULTS.punishMashMs || 0)) + 50;
  self.windup = null;
  ai._onFoeOutcome(later, self, null, { id: 11, outcome: 'blocked', resolvedAt: later });
  assert(ai.counterPlan && ai.counterPlan.reason === 'punish', 'a new exchange is punished again');
});

test('combat-repair RV-RULES-03: a punish that starts late keeps the opponent\'s normal tell (not COMBAT.minTellMs)', () => {
  for (const tier of [2, 3, 5, 7]) {
    const def = ROSTER[tier - 1];
    const ai = new OpponentAI(def, 7);
    const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
    self.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
    const foe = new Boxer({ id: 'p1', isHuman: true });
    foe.setControl(ctl('high'), 0);
    // the plan was due 40 ms from now (the AI was busy until now): it may not wind up a 170 ms counter
    ai.counterPlan = { impactAt: 5040, reason: 'punish' };
    const req = ai._decide(5000, self, foe, { phase: 'fighting' });
    assert(req && req.counter, `#${tier}: the punish goes`);
    assert(req.tellMs >= ai.p.tellMs - 1e-6, `#${tier}: late punish tell ${req.tellMs} ms ≥ normal tell ${ai.p.tellMs} ms`);
    assert(req.tellMs > COMBAT.minTellMs, `#${tier}: above the ${COMBAT.minTellMs} ms floor`);
    // an on-time plan keeps its own (longer) delay
    const ai2 = new OpponentAI(def, 8);
    ai2.counterPlan = { impactAt: 5600, reason: 'punish' };
    const req2 = ai2._decide(5000, self, foe, { phase: 'fighting' });
    assert(req2 && Math.abs(req2.tellMs - 600) < 1, `#${tier}: on-time punish lands as planned (${req2 && req2.tellMs})`);
  }
});
