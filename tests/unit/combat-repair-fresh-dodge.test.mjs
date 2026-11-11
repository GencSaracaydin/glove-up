// Repair round (combat), RV-RULES-01 / decision R2: only a FRESH dodge earns the dodge slow motion and the counter
// window. A posture held longer than COMBAT.freshDodgeMs before the deciding sample (and entered before the punch's
// tell began) still evades — the D3 geometry is unchanged — but earns neither.
import { test, assert } from '../harness.mjs';
import { Match } from '../../src/game/match.js';
import { Boxer } from '../../src/game/boxer.js';
import { COMBAT, resolvePunch } from '../../src/game/combat.js';
import { ROSTER } from '../../src/game/roster.js';
import { KeyboardInput } from '../../src/input/keyboard.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';

const DT = 1000 / 60;
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
const jab = (hand = 'right') => ({ type: 'punch', punch: { hand, kind: 'straight', target: 'head', power: 0.6 } });
/** An opponent that throws one straight to the head ~2 s after the clock starts, then rests (it never answers a held
 *  posture: these cases isolate the fresh-dodge rule; combat-repair-posture covers the answer). */
const oneShot = (ai = {}) => ({
  ...ROSTER[0], id: 'fresh-test',
  ai: { ...ROSTER[0].ai, firstAttackMs: 2000, firstAttackJitter: 0, attackGapMs: 1e9, stringWeights: [1], powerPct: 0, bodyPct: 0,
    punchMix: { straight: 1, hook: 0, uppercut: 0 }, tellMs: 300, tellJitterMs: 0, punishPct: 0, slipPct: 0, punchIntoPct: 0,
    coverUpPct: 0, headGuard: 0, bodyGuard: 0, feintChance: 0, postureAnswerPct: 0, ...ai },
});

function harness(p2, seed = 1) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed, p2, fast: true, id: 'fresh' });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0;
  m.start(0);
  const step = (input) => { now += DT; m.update(DT / 1000, now, { p1: input }); };
  const until = (pred, inputFn, maxMs = 20000) => { const end = now + maxMs; while (!pred() && now < end) step(inputFn()); return pred(); };
  until(() => m.phase === MatchPhase.FIGHTING, () => ({ control: ctl(), events: [] }));
  return { m, log, step, until, first: (n, f = () => true) => log.find((e) => e.name === n && f(e.p)) };
}

/** The player's punch thrown `delayMs` after the dodge was decided: did it land as a counter? */
function punchAfterDodge(h, lean, delayMs) {
  const dodgeAt = h.m.t;
  h.until(() => h.m.t >= dodgeAt + delayMs, () => ({ control: ctl({ lean }), events: [] }), 3000);
  h.step({ control: ctl({ lean }), events: [jab()] });
  h.until(() => !!h.first(Ev.MATCH_HIT, (p) => p.attacker === 'p1'), () => ({ control: ctl(), events: [] }), 1500);
  const hit = h.first(Ev.MATCH_HIT, (p) => p.attacker === 'p1');
  return hit ? hit.p.counter : null;
}

test('combat-repair R2 (case A): a duck held from the clock start evades a straight 2 s later — no slow motion, no counter', () => {
  const h = harness(oneShot());
  const lean = { x: 0, y: -1, z: 0 };
  assert(h.until(() => !!h.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), 'the held duck still evades (D3 geometry)');
  const dodge = h.first(Ev.MATCH_DODGE);
  assert(dodge.p.defender === 'p1' && dodge.p.how === 'duck' && dodge.p.fresh === false && dodge.p.counterWindowMs === 0, JSON.stringify(dodge.p));
  assert(dodge.t >= 2000, `the punch came ≥ 2 s into the hold (${dodge.t.toFixed(0)} ms)`);
  const counter = punchAfterDodge(h, lean, 250);
  assert.equal(counter, false, 'a punch 250 ms after a held dodge is an ordinary punch');
  assert(!h.first(Ev.MATCH_SLOWMO), 'no slow motion for a held posture');
  assert.equal(h.m.boxers.p1.counterLeft, 0);
});

test('combat-repair R2 (case A, glove hang): a jab 100 ms after a held dodge lands into the hanging glove, but not as a counter', () => {
  const h = harness(oneShot());
  const lean = { x: 0, y: -1, z: 0 };
  assert(h.until(() => !!h.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), 'the held duck evades');
  assert.equal(h.first(Ev.MATCH_DODGE).p.fresh, false);
  assert.equal(punchAfterDodge(h, lean, 100), false, 'the missed glove still hangs, but a held posture earns no counter');
  // the same jab after a FRESH dodge is a counter (case B's dodge)
  const f = harness(oneShot());
  assert(f.until(() => !!f.m.boxers.p2.windup, () => ({ control: ctl(), events: [] })), 'the tell shows');
  assert(f.until(() => !!f.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), 'dodged on the tell');
  assert.equal(f.first(Ev.MATCH_DODGE).p.fresh, true);
  assert.equal(punchAfterDodge(f, { x: 0, y: 0, z: 0 }, 100), true, 'a fresh dodge: the counter');
});

test('combat-repair R2 (case B): a duck entered 300 ms before impact opens the slow motion and the counter', () => {
  const h = harness(oneShot());
  // the straight's impact time is known once it is thrown (tell 300 ms): duck 300 ms before it
  assert(h.until(() => !!h.m.boxers.p2.windup, () => ({ control: ctl(), events: [] })), 'the tell shows');
  const w = h.m.boxers.p2.windup;
  const impactW = w.end + w.travelMs;
  h.until(() => h.m.wt >= impactW - 300, () => ({ control: ctl(), events: [] }));
  const lean = { x: 0, y: -1, z: 0 };
  assert(h.until(() => !!h.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), 'dodged');
  assert(h.first(Ev.MATCH_DODGE).p.fresh === true && h.first(Ev.MATCH_DODGE).p.counterWindowMs === COMBAT.counterWindowMs);
  assert(h.first(Ev.MATCH_SLOWMO, (p) => p.dodger === 'p1'), 'the slow motion opens');
  assert.equal(punchAfterDodge(h, { x: 0, y: 0, z: 0 }, 250), true, 'the punch 250 ms later is a counter');
});

test('combat-repair R2: every dodge posture — held: evades without the reward; entered on the tell: the reward', () => {
  const postures = { duck: { x: 0, y: -1, z: 0 }, forward: { x: 0, y: 0, z: 1 }, back: { x: 0, y: 0, z: -1 }, lean: { x: 1, y: 0, z: 0 } };
  for (const [how, lean] of Object.entries(postures)) {
    const held = harness(oneShot(), 2);
    assert(held.until(() => !!held.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), `${how}: held evades`);
    assert(held.first(Ev.MATCH_DODGE).p.how === how && held.first(Ev.MATCH_DODGE).p.fresh === false, `${how}: ${JSON.stringify(held.first(Ev.MATCH_DODGE).p)}`);
    held.until(() => false, () => ({ control: ctl({ lean }), events: [] }), 400);
    assert(!held.first(Ev.MATCH_SLOWMO), `${how}: no slow motion when held`);
    const timed = harness(oneShot(), 2);
    assert(timed.until(() => !!timed.m.boxers.p2.windup, () => ({ control: ctl(), events: [] })), `${how}: tell`);
    assert(timed.until(() => !!timed.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), `${how}: timed evades`);
    assert(timed.first(Ev.MATCH_DODGE).p.fresh === true && timed.first(Ev.MATCH_SLOWMO), `${how}: a timed dodge earns the slow motion`);
  }
});

test('combat-repair R2: a lean entered on a long, HELD tell keeps the reward (a reaction to this punch, however long the AI waits)', () => {
  // a power straight whose wind-up the AI holds while the player leans (§2.5 / holdWhileLeanMs): the lean starts on the
  // tell, so it is > freshDodgeMs old at impact but still fresh
  const h = harness(oneShot({ powerPct: 1, powerKind: 'straight', powerBodyPct: 0, powerTellMs: 700, holdWhileLeanMs: 1000 }));
  assert(h.until(() => !!h.m.boxers.p2.windup, () => ({ control: ctl(), events: [] })), 'the tell shows');
  const lean = { x: -1, y: 0, z: 0 };
  const leanAt = h.m.t;
  assert(h.until(() => !!h.first(Ev.MATCH_DODGE), () => ({ control: ctl({ lean }), events: [] })), 'dodged');
  const dodge = h.first(Ev.MATCH_DODGE);
  assert(dodge.t - leanAt > COMBAT.freshDodgeMs, `the lean was held ${Math.round(dodge.t - leanAt)} ms by then (the AI held its punch)`);
  assert(dodge.p.fresh === true && h.first(Ev.MATCH_SLOWMO), 'still a fresh dodge: entered after the tell began');
});

test('combat-repair R2: the keyboard — S held all along evades without the slow motion; S pressed on the tell earns it', () => {
  const run = (pressOnTell) => {
    const h = harness(oneShot(), 3);
    const kb = new KeyboardInput({ players: 1 });
    let real = h.m.t, pressed = false;
    if (!pressOnTell) { kb.handleKey('KeyS', true, { t: real }); pressed = true; }
    h.until(() => !!h.first(Ev.MATCH_DODGE) && h.m.t > h.first(Ev.MATCH_DODGE).t + 300, () => {
      real += DT;
      if (!pressed && h.m.boxers.p2.windup) { kb.handleKey('KeyS', true, { t: real }); pressed = true; }
      return kb.update(real, 0);
    });
    return { dodge: h.first(Ev.MATCH_DODGE), slow: h.first(Ev.MATCH_SLOWMO) };
  };
  const held = run(false), timed = run(true);
  assert(held.dodge && held.dodge.p.how === 'duck' && held.dodge.p.fresh === false && !held.slow, 'held S: dodge, no reward');
  assert(timed.dodge && timed.dodge.p.fresh === true && timed.slow, 'S on the tell: the reward');
});

test('combat-repair R2: versus — a held lean opens no counter window (there is no slow motion in versus anyway)', () => {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, mode: 'versus', seed: 4, fast: true, id: 'vs' });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0;
  m.start(0);
  const lean = { x: 0.9, y: 0, z: 0 };
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ lean }), events: [] }, p2: { control: ctl(), events: [] } }); }
  for (let i = 0; i < 60; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ lean }), events: [] }, p2: { control: ctl(), events: [] } }); }
  now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ lean }), events: [] }, p2: { control: ctl(), events: [jab('left')] } });
  for (let i = 0; i < 30; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ lean }), events: [] }, p2: { control: ctl(), events: [] } }); }
  const d = log.find((e) => e.name === Ev.MATCH_DODGE);
  assert(d && d.p.defender === 'p1' && d.p.fresh === false, `held lean dodged (${d && JSON.stringify(d.p)})`);
  assert(!m.boxers.p1.counterReady(m.t), 'no counter window');
  assert(!log.some((e) => e.name === Ev.MATCH_SLOWMO));
});

test('combat-repair R2: Boxer.dodgeSince follows the posture (a short release is the same posture); combat reports it', () => {
  const b = new Boxer({ id: 'p1', isHuman: true });
  b.setControl(ctl(), 0);
  assert.equal(b.dodgeSince, null);
  b.setControl(ctl({ lean: { x: 0, y: -0.9, z: 0 } }), 100);
  b.setControl(ctl({ lean: { x: 0, y: 0, z: 0.9 } }), 200); // duck → forward tilt without coming up: one posture
  assert.equal(b.dodgeSince, 100);
  b.setControl(ctl(), 300);
  b.setControl(ctl({ lean: { x: 0, y: -0.9, z: 0 } }), 300 + COMBAT.freshDodgeResetMs - 50); // bobbing: back in it too soon
  assert.equal(b.dodgeSince, 100, 'a release shorter than freshDodgeResetMs does not end the posture');
  const back = 300 + COMBAT.freshDodgeResetMs;
  b.setControl(ctl(), back);
  b.setControl(ctl(), back + COMBAT.freshDodgeResetMs);
  assert.equal(b.dodgeSince, null, 'back in the stance long enough: the posture is over');
  const again = back + COMBAT.freshDodgeResetMs + 100;
  b.setControl(ctl({ lean: { x: 0.9, y: 0, z: 0 } }), again);
  assert.equal(b.dodgeSince, again);
  const res = resolvePunch({ attacker: { isHuman: false }, defender: b, punch: { hand: 'left', kind: 'straight', target: 'head', impactAt: again - 100 }, now: again + 100 });
  assert(res.result === 'dodged' && res.leanSince === again, `deciding sample at ${res.sampleT}, since ${res.leanSince}`);
  const held = resolvePunch({ attacker: { isHuman: false }, defender: { isHuman: true, samples: [{ t: 900, guard: 'none', guardAmount: 0, lean: { x: 0, y: -1, z: 0 }, since: 50 }] }, punch: { hand: 'left', kind: 'straight', target: 'head', impactAt: 800 }, now: 960 });
  assert(held.result === 'dodged' && held.leanSince === 50);
  // a hit or a block carries no posture start
  assert.equal(resolvePunch({ attacker: { isHuman: false }, defender: { isHuman: true, guard: 'high' }, punch: { hand: 'left', kind: 'straight', target: 'head' } }).leanSince, null);
});
