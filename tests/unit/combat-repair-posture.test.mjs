// Repair round (combat), RV-RULES-01 / decision R2: turtling must not beat opponents. A held posture earns no slow
// motion or counter window (combat-repair-fresh-dodge), and — our own design (E), kept modest — an opponent answers a
// dodge posture held ~1 s with a punch that posture does not evade and the guard does not block; a cocked punch it
// held through the lean (holdWhileLeanMs, §2.5) is pulled back and re-thrown as that answer.
import { test, assert } from '../harness.mjs';
import { Match } from '../../src/game/match.js';
import { COMBAT, evasionFor } from '../../src/game/combat.js';
import { ROSTER } from '../../src/game/roster.js';
import { OpponentAI, AI_DEFAULTS } from '../../src/game/ai.js';
import { Boxer } from '../../src/game/boxer.js';
import { KeyboardInput } from '../../src/input/keyboard.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';
import { Rng } from '../../src/core/rng.js';

const DT = 1000 / 60;
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
/** An opponent attacking every ~1.2 s with single punches of its usual mix (no punishes, no slips). */
const busy = (ai = {}, base = ROSTER[4]) => ({
  ...base, id: 'posture-test',
  ai: { ...base.ai, firstAttackMs: 600, attackGapMs: 1200, stringWeights: [1], powerPct: 0, punishPct: 0, slipPct: 0, punchIntoPct: 0,
    coverUpPct: 0, feintChance: 0, moodSwing: 0, holdWhileLeanMs: 0, punchMix: { straight: 0.6, hook: 0.3, uppercut: 0.1 }, bodyPct: 0.3, ...ai },
});

function bout(def, control, ms = 9000, seed = 1) { // (inside round 1: ?fast=1 rounds are 10 s)
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed, p2: def, fast: true, id: 'posture' });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0;
  m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
  const t0 = m.t;
  while (m.t - t0 < ms && m.phase !== MatchPhase.RESULT) {
    now += DT;
    if (m.phase === MatchPhase.FIGHTING && m.boxers.p1.hp < 3) m.debugSetHp('p1', 10);
    m.update(DT / 1000, now, { p1: { control: control(m.t - t0), events: [] } });
  }
  const thrown = log.filter((e) => e.name === Ev.MATCH_PUNCH_THROWN && e.p.attacker === 'p2');
  return { m, log, t0, thrown, ai: m.ais.p2 };
}

test('combat-repair R2 (E): a duck held with a low guard is answered with uppercuts; one held under a high guard with body shots', () => {
  const duckLow = bout(busy({ postureAnswerPct: 1 }), () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }));
  const late = duckLow.thrown.filter((e) => e.t - duckLow.t0 > AI_DEFAULTS.postureAnswerMs + 400);
  assert(late.length >= 5, `punches after the posture was held ~1 s (${late.length})`);
  assert(late.every((e) => e.p.kind === 'uppercut' && e.p.target === 'head'), `answers: ${late.map((e) => `${e.p.target}:${e.p.kind}`).join(' ')}`);
  assert(duckLow.log.some((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2' && e.p.kind === 'uppercut'), 'the uppercut lands under the duck');
  const duckHigh = bout(busy({ postureAnswerPct: 1 }), () => ctl({ guard: 'high', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }));
  const lateHigh = duckHigh.thrown.filter((e) => e.t - duckHigh.t0 > AI_DEFAULTS.postureAnswerMs + 400);
  assert(lateHigh.length >= 3 && lateHigh.every((e) => e.p.target === 'body'), `under a high guard: ${lateHigh.map((e) => `${e.p.target}:${e.p.kind}`).join(' ')}`);
});

test('combat-repair R2 (E): a held sideways lean meets the other hook; a held back lean with a low guard meets a step-in head shot that lands', () => {
  const left = bout(busy({ postureAnswerPct: 1 }), () => ctl({ guard: 'low', guardAmount: 1, lean: { x: -1, y: 0, z: 0 } }));
  const late = left.thrown.filter((e) => e.t - left.t0 > AI_DEFAULTS.postureAnswerMs + 400);
  assert(late.length >= 5, 'enough answers');
  for (const e of late) {
    assert(e.p.kind === 'hook' && e.p.target === 'head', `answer ${e.p.target}:${e.p.kind}`);
    assert.equal(evasionFor({ kind: e.p.kind, target: e.p.target, hand: e.p.hand }, { x: -1, y: 0, z: 0 }), null, `${e.p.hand} hook is not evaded by a left lean`);
  }
  // the back lean (z −1, D4) evades every head punch, and the low guard blocks the body: only a step-in reaches
  const back = bout(busy({ postureAnswerPct: 1 }), () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: 0, z: -1 } }));
  const stepIns = back.ai.log.filter((l) => l.answer && l.stepIn);
  assert(stepIns.length >= 4, `step-in answers (${stepIns.length})`);
  const hits = back.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2' && e.t - back.t0 > AI_DEFAULTS.postureAnswerMs + 400);
  assert(hits.length >= 3 && hits.every((e) => e.p.target === 'head'), `step-in head shots land through the back lean (${hits.length})`);
  // the step-in reaches like a full lean-in (D4), and only an AI answer steps in
  assert.equal(evasionFor({ kind: 'straight', target: 'head', hand: 'left' }, { x: 0, y: 0, z: -1 }, 1), null);
  assert.equal(evasionFor({ kind: 'straight', target: 'head', hand: 'left' }, { x: 0, y: 0, z: -1 }, 0), 'back');
});

test('combat-repair R2 (E): no answer before the posture is held ~1 s, nor to a timed dodge that ends in time', () => {
  const ai = new OpponentAI(busy({ postureAnswerPct: 1 }), new Rng(5));
  const self = new Boxer({ id: 'p2', isHuman: false, ai: busy().ai });
  self.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  const foe = new Boxer({ id: 'p1', isHuman: true });
  foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 0);
  ai._trackPosture(0, foe);
  ai._trackPosture(AI_DEFAULTS.postureAnswerMs - 50, foe);
  assert(!ai._postureHeld(AI_DEFAULTS.postureAnswerMs - 50), 'not yet held');
  ai._trackPosture(AI_DEFAULTS.postureAnswerMs + 10, foe);
  assert(ai._postureHeld(AI_DEFAULTS.postureAnswerMs + 10), 'held after ~1 s');
  // back to the stance only briefly (bobbing on the key): still the same posture
  foe.setControl(ctl({ guard: 'low', guardAmount: 1 }), 1100);
  ai._trackPosture(1100, foe);
  foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 1100 + COMBAT.freshDodgeResetMs - 100);
  ai._trackPosture(1100 + COMBAT.freshDodgeResetMs - 100, foe);
  assert(ai._postureHeld(1100 + COMBAT.freshDodgeResetMs - 100), 'a short release does not reset it');
  // really back in the stance: the next lean starts a new posture
  foe.setControl(ctl({ guard: 'low', guardAmount: 1 }), 2000);
  ai._trackPosture(2000, foe);
  ai._trackPosture(2000 + COMBAT.freshDodgeResetMs + 10, foe);
  foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 2500);
  ai._trackPosture(2500, foe);
  assert(!ai._postureHeld(2600), 'a new posture is not held yet');
  // a short timed dodge in a bout draws the usual mix, not answers
  const timed = bout(busy({ postureAnswerPct: 1 }), (t) => ctl({ guard: 'high', guardAmount: 1, lean: { x: 0, y: (t % 2400) < 600 ? -1 : 0, z: 0 } }));
  assert(!timed.ai.log.some((l) => l.answer), 'dodges held 0.6 s at a time are never answered');
});

test('combat-repair R2 (E): a cocked punch held through a held posture is pulled back and re-thrown as the answer', () => {
  // #6 waits out a lean up to 1 s (§2.5); it never answers on its own here (postureAnswerPct 0), and it mostly throws
  // straights (an uppercut is in its kit, so the duck can be answered)
  const def = busy({ holdWhileLeanMs: 1000, postureAnswerPct: 0, punchMix: { straight: 0.9, hook: 0, uppercut: 0.1 }, bodyPct: 0 }, ROSTER[5]);
  const b = bout(def, () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 9000);
  const answers = b.ai.log.filter((l) => l.answer);
  assert(answers.length >= 2 && answers.every((l) => l.kind === 'uppercut' && l.target === 'head'), `answers after a held wind-up: ${answers.map((l) => l.kind).join(' ')}`);
  const dodged = b.log.filter((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1').length;
  const hits = b.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2' && e.p.kind === 'uppercut').length;
  assert(hits >= 2, `the answers land (${hits} uppercuts, ${dodged} straights dodged)`);
});

/**
 * A keyboard turtle with the real KeyboardInput: hold the posture + guard keys, tap K/J 300 ms after each dodge — and,
 * with `mashMs`, also every mashMs regardless (a turtle that keeps punching). Returns the result and the event log.
 */
function turtleBout(opp, keys, seed, mashMs = 0) {
  const bus = new EventBus();
  const ev = [];
  const m = new Match({ bus, mode: 'single', p1: { name: 'T', isHuman: true }, p2: opp, rng: seed, id: 'turtle', latencyMs: 40 });
  bus.on('*', (name, p) => ev.push({ name, p }));
  const kb = new KeyboardInput({ players: 1 });
  let real = 0, game = 0, held = false, seen = 0, hand = 0, mashAt = 0, mashNext = 0;
  const taps = [];
  m.start(0);
  while (m.phase !== MatchPhase.RESULT && real < 12 * 60 * 1000) {
    if (!held && m.phase === MatchPhase.FIGHTING) { for (const k of keys) kb.handleKey(k, true, { t: real }); held = true; }
    const dodges = ev.filter((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1').length;
    if (dodges > seen) { seen = dodges; taps.push({ at: real + 300, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); }
    if (mashMs > 0 && m.phase === MatchPhase.FIGHTING && !m.boxers.p1.down && real >= mashNext) { taps.push({ at: real, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); mashNext = real + mashMs; }
    if (m.boxers.p1.down && real >= mashAt) { taps.push({ at: real, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); mashAt = real + 150; }
    for (const tp of taps) {
      if (!tp.down && real >= tp.at) { kb.handleKey(tp.code, true, { t: real }); tp.down = true; }
      else if (tp.down && !tp.up && real >= tp.at + 45) { kb.handleKey(tp.code, false, { t: real }); tp.up = true; }
    }
    real += DT; game += DT;
    m.update(DT / 1000, game, { p1: kb.update(real, 0) });
  }
  return { result: m.getResult(), ev, ai: m.ais.p2 };
}
const turtle = (opp, keys, seed, mashMs) => turtleBout(opp, keys, seed, mashMs).result;

test('combat-repair R2: keyboard turtles (S+B duck, W+B forward tilt, X+B back lean) lose to the PRO tier and get floored', () => {
  for (const [keys, tier] of [[['KeyS', 'KeyB'], 7], [['KeyW', 'KeyB'], 10], [['KeyX', 'KeyB'], 7], [['KeyA', 'Space'], 9]]) {
    let wins = 0, floored = 0;
    for (const seed of [11, 12]) {
      const r = turtle(ROSTER[tier - 1], keys, seed);
      if (r.winner === 'p1') wins++;
      if (r.knockdowns.p1 > 0) floored++;
    }
    assert.equal(wins, 0, `${keys.join('+')} vs #${tier}: the turtle won ${wins}/2 (before: every bout, never floored)`);
    assert.equal(floored, 2, `${keys.join('+')} vs #${tier}: floored in ${floored}/2`);
  }
});

// ── re-fix (the adversarial verifier's open cases) ─────────────────────────────────────────────────────────────────

test('combat-repair R2: a combined posture (side lean + duck or lean-in) is no shelter — the uppercut still catches the head', () => {
  const up = (hand) => ({ kind: 'uppercut', target: 'head', hand });
  for (const lean of [{ x: -1, y: -1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: -1, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: -1, z: 1 }]) {
    for (const hand of ['left', 'right']) assert.equal(evasionFor(up(hand), lean), null, `${hand} uppercut vs ${JSON.stringify(lean)}`);
    // the straights and hooks that posture slipped before still miss (the D3 geometry for them is unchanged)
    assert(evasionFor({ kind: 'straight', target: 'head', hand: 'left' }, lean), `straight vs ${JSON.stringify(lean)}`);
    assert(evasionFor({ kind: 'hook', target: 'head', hand: 'left' }, lean) && evasionFor({ kind: 'hook', target: 'head', hand: 'right' }, lean), `hooks vs ${JSON.stringify(lean)}`);
  }
  // a side lean on its own still slips the uppercut (help card: lean to slip; "uppercuts still catch you" when ducking)
  assert.equal(evasionFor(up('left'), { x: 1, y: 0, z: 0 }), 'lean');
  assert.equal(evasionFor(up('left'), { x: -0.5, y: -0.3, z: 0.5 }), 'lean', 'below the duck / forward thresholds');
  // a back lean still takes the head out of reach (only a step-in reaches it, D4)
  assert.equal(evasionFor(up('left'), { x: 1, y: -1, z: -1 }), 'back');
  assert.equal(evasionFor(up('left'), { x: 1, y: -1, z: -1 }, 1), null);
  // and in a bout: A+S held with a low guard is answered with uppercuts that land
  const b = bout(busy({ postureAnswerPct: 1 }), () => ctl({ guard: 'low', guardAmount: 1, lean: { x: -1, y: -1, z: 0 } }));
  const late = b.thrown.filter((e) => e.t - b.t0 > AI_DEFAULTS.postureAnswerMs + 400);
  assert(late.length >= 5 && late.every((e) => e.p.kind === 'uppercut' && e.p.target === 'head'), `answers: ${late.map((e) => `${e.p.target}:${e.p.kind}`).join(' ')}`);
  assert(b.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2' && e.p.kind === 'uppercut').length >= 4, 'the uppercuts land');
});

test('combat-repair R2: turtles that keep punching (J/K every 0.6–0.8 s) do not out-win ordinary play and get floored vs PRO', () => {
  // the skilled 'player' bot wins 94–99 % against #7–#10 (dev/sim.mjs); before this fix the mashing turtles below won
  // 94–100 %, the combined A+S+B / D+W+B one never floored by #10
  const postures = [['KeyS', 'KeyB'], ['KeyA', 'KeyS', 'KeyB'], ['KeyD', 'KeyW', 'KeyB'], ['KeyX', 'KeyB']];
  let bouts = 0, wins = 0, floored = 0, champWins = 0, champBouts = 0, champFloored = 0;
  for (const keys of postures) {
    for (const [tier, mash, seed] of [[7, 700, 31], [9, 600, 32], [10, 700, 33], [10, 800, 34]]) {
      const r = turtle(ROSTER[tier - 1], keys, seed, mash);
      bouts++;
      if (r.winner === 'p1') wins++;
      if (r.knockdowns.p1 > 0) floored++;
      if (tier === 10) { champBouts++; if (r.winner === 'p1') champWins++; if (r.knockdowns.p1 > 0) champFloored++; }
    }
  }
  assert(wins / bouts <= 0.5, `mashing turtles won ${wins}/${bouts}`);
  assert(floored / bouts >= 0.9, `floored in ${floored}/${bouts}`);
  assert(champFloored === champBouts, `the champion floors every mashing turtle (${champFloored}/${champBouts}; won ${champWins})`);
});

test('combat-repair R2: a held posture\'s dodge is no counter chance — a punch into the hanging glove lands as an ordinary punch', () => {
  // (the glove-hang counter, Boxer.midPunchFor, skips a punch dodged by a held posture: only a fresh dodge earns a counter)
  const def = busy({ postureAnswerPct: 0, punchMix: { straight: 1, hook: 0, uppercut: 0 }, bodyPct: 0, headGuard: 0, bodyGuard: 0, missRecoveryMs: 1200, whiffRecoverMs: undefined });
  const lean = { x: 0, y: -1, z: 0 };
  // a duck held all along, and a jab 80 ms after each (held) dodge — inside the hanging glove's window
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed: 3, p2: def, fast: true, id: 'hang' });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0, seen = 0, due = null, hand = 0;
  m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
  const t0 = m.t;
  while (m.t - t0 < 6000 && m.phase !== MatchPhase.RESULT) {
    now += DT;
    const ds = log.filter((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1').length;
    if (ds > seen) { seen = ds; due = m.t + 80; }
    const events = due != null && m.t >= due ? [{ type: 'punch', punch: { hand: hand++ % 2 ? 'left' : 'right', kind: 'straight', target: 'head', power: 0.6 } }] : [];
    if (events.length) due = null;
    m.update(DT / 1000, now, { p1: { control: ctl({ lean }), events } });
  }
  const dodges = log.filter((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1');
  assert(dodges.length >= 2 && dodges.every((e) => e.p.fresh === false), `held dodges (${dodges.length})`);
  const mine = log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p1');
  assert(mine.length >= 2, `the jabs land through the open guard (${mine.length})`);
  assert(mine.every((e) => !e.p.counter), `none is a counter (${mine.filter((e) => e.p.counter).length} were)`);
  assert(!log.some((e) => e.name === Ev.MATCH_SLOWMO), 'no slow motion');
});

test('combat-repair R2 (E): against a posture it cannot answer, a held punch is released — no endless cock-and-pull-back', () => {
  // an opponent that waits out leans (holdWhileLeanMs) and has no uppercut: a duck + low guard leaves it nothing to throw
  const def = busy({ holdWhileLeanMs: 900, postureAnswerPct: 1, punchMix: { straight: 0.7, hook: 0.3, uppercut: 0 }, bodyPct: 0.3 }, ROSTER[6]);
  const b = bout(def, () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 9000);
  const windups = b.log.filter((e) => e.name === Ev.MATCH_WINDUP && e.p.attacker === 'p2').length;
  assert(windups >= 3, `wind-ups ${windups}`);
  assert(b.thrown.length >= windups - 1, `every held punch goes in the end: ${b.thrown.length} thrown of ${windups} wind-ups`);
  assert(!b.ai.log.some((l) => l.answer), 'nothing answers this posture');
  assert.equal(b.ai.answerNext, false);
  // the same opponent with an uppercut in its kit pulls back and answers
  const b2 = bout({ ...def, ai: { ...def.ai, punchMix: { straight: 0.6, hook: 0.3, uppercut: 0.1 } } }, () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 9000);
  assert(b2.ai.log.some((l) => l.answer && l.kind === 'uppercut'), 'answered with an uppercut');
});

test('combat-repair R2 (E): answers stay in the opponent\'s own kit — the first opponent never throws an uppercut', () => {
  const benny = { ...ROSTER[0], ai: { ...ROSTER[0].ai, postureAnswerPct: 1, attackGapMs: 1200, firstAttackMs: 600 } };
  assert.equal(benny.ai.punchMix.uppercut, 0);
  const duckLow = bout(benny, () => ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } }), 9000);
  assert(duckLow.thrown.length >= 4, 'it keeps attacking');
  assert(!duckLow.thrown.some((e) => e.p.kind === 'uppercut'), `kinds: ${duckLow.thrown.map((e) => e.p.kind).join(' ')}`);
  assert(!duckLow.ai.log.some((l) => l.answer), 'a duck with a low guard leaves #1 no answer');
  // with the body open, its answer is a body shot (in its kit)
  const duckOpen = bout(benny, () => ctl({ lean: { x: 0, y: -1, z: 0 } }), 9000);
  const answers = duckOpen.ai.log.filter((l) => l.answer);
  assert(answers.length >= 3 && answers.every((l) => l.target === 'body' && l.kind !== 'uppercut'), `answers: ${answers.map((l) => `${l.target}:${l.kind}`).join(' ')}`);
});

test('combat-repair R2 (E): a turtle whose guard drops while it punches is answered where its guard is KEPT', () => {
  // X+B (back lean, low guard) and S+B, J/K every 700 ms: the keyboard drops the guard for each punch, but the answer
  // still goes at the head (a step-in through the back lean / an uppercut under the duck), not into the low guard
  for (const [keys, want] of [[['KeyX', 'KeyB'], 'step-in'], [['KeyS', 'KeyB'], 'uppercut']]) {
    const { ai } = turtleBout({ ...ROSTER[9], ai: { ...ROSTER[9].ai, postureAnswerPct: 1 } }, keys, 41, 700);
    const answers = ai.log.filter((l) => l.answer);
    assert(answers.length >= 5, `${keys.join('+')}: answers ${answers.length}`);
    const body = answers.filter((l) => l.target === 'body').length;
    assert(body <= answers.length * 0.1, `${keys.join('+')}: ${body}/${answers.length} answers went into the kept low guard`);
    if (want === 'step-in') assert(answers.filter((l) => l.stepIn).length >= answers.length * 0.9, 'step-ins');
    else assert(answers.filter((l) => l.kind === 'uppercut').length >= answers.length * 0.9, 'uppercuts');
  }
});

test('combat-repair R2 (E): every planned counter answers a held posture; a pending answer is spent only when thrown', () => {
  const def = busy({ postureAnswerPct: 0, holdWhileLeanMs: 0 });
  const ai = new OpponentAI(def, new Rng(9));
  const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  self.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  const foe = new Boxer({ id: 'p1', isHuman: true });
  const duck = ctl({ guard: 'low', guardAmount: 1, lean: { x: 0, y: -1, z: 0 } });
  foe.setControl(duck, 0);
  ai.reset(0);
  ai.nextAttackAt = 1e9;
  for (let t = 0; t <= 1200; t += 50) { foe.setControl(duck, t); ai._trackPosture(t, foe); }
  assert(ai._postureHeld(1200), 'held');
  // building a request does not spend a pending answer (_decide may build one and not return it)…
  ai.answerNext = true;
  const built = ai._makePunch(1250, self, foe, { first: true, reason: 'attack' });
  assert(built && built.answer && built.kind === 'uppercut', 'the pending answer shapes the request');
  assert.equal(ai.answerNext, true, 'not spent by building a request');
  // …a planned punish answers the duck (counters always do while a posture is held), and returning it spends it
  ai.counterPlan = { impactAt: 1700, reason: 'punish' };
  const mv = { phase: 'fighting' };
  let req = null;
  for (let t = 1250; t <= 1700 && !req; t += DT) { foe.setControl(duck, t); req = ai.update(1 / 60, t, self, foe, mv).punch; }
  assert(req && req.counter && req.answer && req.kind === 'uppercut' && req.target === 'head', `the punish answers the duck: ${JSON.stringify(req && { kind: req.kind, target: req.target, answer: req.answer })}`);
  assert.equal(ai.answerNext, false, 'spent once the answer is thrown');
});
