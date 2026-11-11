// Fix pass (combat): evasion — decisions D3 (a forward lean is a dodge) and D4 (the AI's punch animation never
// raises the back-lean threshold above 0.62). Findings RULES-M1 and RULES-06.
import { test, assert } from '../harness.mjs';
import { COMBAT, evasionFor, isLeaning, resolvePunch } from '../../src/game/combat.js';
import { dodgeDetected } from '../../src/input/tutorial-detect.js';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';

const AI_TRAVEL_LEAN = 0.28; // Boxer._aiLeanGoal leans every travelling AI punch to z +0.28
const head = (kind, hand = 'left') => ({ kind, target: 'head', hand });

test('combat-fix D4: a 0.62 back lean dodges every AI head punch even while the AI leans into its punch (RULES-06)', () => {
  for (const kind of ['straight', 'hook', 'uppercut']) {
    for (const hand of ['left', 'right']) {
      assert.equal(evasionFor(head(kind, hand), { x: 0, y: 0, z: -COMBAT.backLeanThreshold }, AI_TRAVEL_LEAN), 'back', `${kind}/${hand}`);
      assert.equal(evasionFor(head(kind, hand), { x: 0, y: 0, z: -0.6 }, AI_TRAVEL_LEAN), null, `${kind}: 0.6 is not enough`);
    }
  }
  // a REAL lean-in (≥ leanInMin) still eats into the back lean (keyboard W / a human attacker in versus)
  assert.equal(evasionFor(head('straight'), { x: 0, y: 0, z: -0.8 }, 1), null, 'lean-in z 1 cancels 0.5 of it');
  assert.equal(evasionFor(head('straight'), { x: 0, y: 0, z: -0.8 }, COMBAT.leanInMin - 0.01), 'back');
  assert(COMBAT.leanInMin > AI_TRAVEL_LEAN, 'the AI animation is below a real lean-in');
});

test('combat-fix D4: in a bout, an AI head straight meets a held −0.62 lean and misses (t12-backlean)', () => {
  let dodged = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const base = ROSTER[4];
    const opp = { ...base, ai: { ...base.ai, powerPct: 0, bodyPct: 0, punchMix: { straight: 1, hook: 0, uppercut: 0 }, firstAttackMs: 400, attackGapMs: 1e9, stringWeights: [1], slipPct: 0 } };
    const bus = new EventBus(); const out = [];
    bus.on('*', (n, p) => { if (p && p.attacker === 'p2' && [Ev.MATCH_HIT, Ev.MATCH_DODGE, Ev.MATCH_BLOCK].includes(n)) out.push(n); });
    const m = new Match({ bus, seed, p2: opp, fast: true });
    const ctl = (z) => ({ control: { tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.1, punching: false } }, activity: 0 }, events: [] });
    let now = 0;
    m.start(0);
    while (m.phase !== MatchPhase.FIGHTING && now < 20000) { now += 20; m.update(0.02, now, { p1: ctl(0) }); }
    while (!out.length && now < 30000) { now += 20; m.update(0.02, now, { p1: ctl(-COMBAT.backLeanThreshold) }); }
    if (out[0] === Ev.MATCH_DODGE) dodged++;
  }
  assert.equal(dodged, 6, `dodged ${dodged}/6 at lean.z −0.62`);
});

test('combat-fix D3: a forward tilt (lean.z ≥ 0.62) evades what a duck evades — straights and hooks, not uppercuts (RULES-M1)', () => {
  const fwd = { x: 0, y: 0, z: COMBAT.forwardLeanThreshold };
  for (const aZ of [0, AI_TRAVEL_LEAN]) {
    assert.equal(evasionFor(head('straight'), fwd, aZ), 'forward');
    assert.equal(evasionFor(head('hook', 'left'), fwd, aZ), 'forward');
    assert.equal(evasionFor(head('hook', 'right'), fwd, aZ), 'forward');
    assert.equal(evasionFor(head('uppercut'), fwd, aZ), null, 'an uppercut catches a forward tilt, like a duck');
  }
  assert.equal(evasionFor({ kind: 'straight', target: 'body', hand: 'left' }, fwd), null, 'never a body shot');
  assert.equal(evasionFor(head('straight'), { x: 0, y: 0, z: 0.6 }), null, 'below the threshold');
  assert(isLeaning(fwd), 'a dodge posture (the AI holds its cocked punch, §4.1.7)');
  const r = resolvePunch({ attacker: { isHuman: false, lean: { x: 0, y: 0, z: AI_TRAVEL_LEAN } }, defender: { isHuman: true, guard: 'none', lean: fwd, hp: 10 }, punch: { hand: 'left', kind: 'straight', target: 'head', impactAt: 0 }, now: 0 });
  assert(r.result === 'dodged' && r.dodge === 'forward');
});

test('combat-fix D3: every pose the tutorial dodge card accepts evades at least one AI head-punch kind in a bout', () => {
  const kinds = [head('straight'), head('hook', 'left'), head('hook', 'right'), head('uppercut')];
  let accepted = 0;
  for (let x = -1; x <= 1.0001; x += 0.1) {
    for (let y = -1; y <= 1.0001; y += 0.1) {
      for (let z = -1; z <= 1.0001; z += 0.1) {
        const lean = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 };
        const kind = dodgeDetected({ tracked: true, lean });
        if (!kind) continue;
        accepted++;
        for (const aZ of [0, AI_TRAVEL_LEAN]) {
          assert(kinds.some((p) => evasionFor(p, lean, aZ) != null), `tutorial "${kind}" ${JSON.stringify(lean)} (attacker z ${aZ}) dodges nothing`);
        }
      }
    }
  }
  // exactly at the thresholds too
  for (const lean of [{ x: 0.42, y: 0, z: 0 }, { x: -0.42, y: 0, z: 0 }, { x: 0, y: -0.42, z: 0 }, { x: 0, y: 0, z: -0.62 }, { x: 0, y: 0, z: 0.62 }]) {
    assert(dodgeDetected({ tracked: true, lean }), JSON.stringify(lean));
    assert(kinds.some((p) => evasionFor(p, lean, AI_TRAVEL_LEAN) != null), `threshold pose ${JSON.stringify(lean)}`);
  }
  assert(accepted > 1000, `grid covered (${accepted} accepted poses)`);
});
