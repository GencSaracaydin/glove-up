// game/boxer.js — Boxer state machine and BoxerView (wedge health, §2.10 rate limits, reels, held
// tells, cover-ups, the counter window, training compatibility).
import { test, assert, approx } from '../harness.mjs';
import { Boxer, HUMAN_STATS, AI_STATS } from '../../src/game/boxer.js';
import { COMBAT } from '../../src/game/combat.js';
import { BoxerPhase, APPEARANCE_OPTIONS } from '../../src/core/types.js';
import { ROSTER } from '../../src/game/roster.js';

const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
const human = () => new Boxer({ id: 'p1', isHuman: true, name: 'Me' });
const ai = (aiParams = {}) => new Boxer({ id: 'p2', isHuman: false, name: 'Bot', stats: { hp: 10, power: 1, speed: 1 }, ai: aiParams });
const jab = (o = {}) => ({ hand: 'left', kind: 'straight', target: 'head', power: 0.7, t: 0, ...o });

test('boxer: health is counted in wedges — maxHp 10, hp01 = hp/10, both in the view', () => {
  assert.equal(HUMAN_STATS.hp, 10);
  assert.equal(AI_STATS.hp, 10);
  const b = ai();
  b.receive({ result: 'hit', damage: 1.3, hpAfter: 8.7, stunMs: 0 }, jab(), 0);
  const v = b.toView(10);
  assert.equal(v.hp, 8.7);
  assert.equal(v.maxHp, 10);
  assert(Math.abs(v.hp01 - 0.87) < 1e-9);
  assert.equal(b.stats.damageTaken, 1.3);
});

test('boxer: a human punch starts instantly and travels 0.1–0.13 s by kind (§2.2); impact due at the end of travel', () => {
  for (const kind of ['straight', 'hook', 'uppercut']) {
    const ms = COMBAT.punch[kind].humanTravelMs;
    const b = human();
    b.setControl(ctl(), 1000);
    const p = b.tryPunch(jab({ kind }), 1000);
    assert(p && typeof p === 'object', 'started');
    assert.equal(p.impactAt - p.thrownAt, ms, kind);
    b.update(1000);
    assert.equal(b.phase, BoxerPhase.PUNCH);
    assert.equal(b.duePunches(1000 + ms - 1).length, 0);
    assert.equal(b.duePunches(1000 + ms).length, 1);
  }
});

test('boxer: rate limit — the same glove every 0.2 s, any two punches 0.1 s apart (5–6 punches/s flurries); near misses are buffered', () => {
  const b = human();
  b.setControl(ctl(), 0);
  const p1 = b.tryPunch(jab({ hand: 'left' }), 0);
  assert(p1 && p1.hand === 'left');
  assert.equal(b.tryPunch(jab({ hand: 'right' }), 50), 'buffered', 'other glove, but only 50 ms later → buffered for 0.1 s');
  const n = b.update(100);
  assert(n.some((x) => x.type === 'thrown' && x.punch.hand === 'right'), 'buffered right fires at 100 ms');
  b.onPunchResolved(p1, { result: 'hit', damage: 1.2 }, p1.impactAt);
  assert.equal(b.tryPunch(jab({ hand: 'left' }), 150), 'buffered', 'left again at 150 ms: within the buffer of its 200 ms limit');
  const n2 = b.update(200);
  assert(n2.some((x) => x.type === 'thrown' && x.punch.hand === 'left'), 'fires at 200 ms');
  // a full alternating flurry: 10 punches in under 2 s all go through
  const c = human();
  c.setControl(ctl(), 0);
  let thrown = 0;
  for (let i = 0; i < 10; i++) {
    const t = i * 170;
    for (const q of c.duePunches(t)) c.onPunchResolved(q, { result: 'hit', damage: 1.2 }, t);
    const r = c.tryPunch(jab({ hand: i % 2 ? 'right' : 'left' }), t);
    for (const note of c.update(t)) if (note.type === 'thrown') thrown++;
    if (r && typeof r === 'object') thrown++;
  }
  assert(thrown >= 9, `flurry at ~6/s goes through (${thrown})`);
  const d = human();
  d.setControl(ctl(), 0);
  d.tryPunch(jab(), 0);
  assert.equal(d.tryPunch(jab(), 20), null, 'same glove 20 ms later: too early even for the buffer');
});

test('boxer: punches are ignored while down or getting up; after a hit a human only flinches — guard and punches keep counting', () => {
  const b = human();
  b.setControl(ctl({ guard: 'high', guardAmount: 1 }), 0);
  b.receive({ result: 'hit', damage: 1.1, hpAfter: 8.9, stunMs: COMBAT.humanHitLockMs }, jab(), 100);
  b.update(150);
  assert.equal(b.phase, BoxerPhase.HITSTUN, 'the flinch shows');
  assert.equal(b.effectiveGuard(200), 'high', 'the guard pose still counts (§2.10)');
  assert(b.tryPunch(jab(), 200), 'motion keeps registering through the hit cut');
  const d = human();
  d.knockDown(0);
  assert.equal(d.tryPunch(jab(), 10), null, 'down');
  d.getUp(500, 0.8, 1000);
  assert.equal(d.tryPunch(jab(), 900), null, 'getting up');
  assert(d.tryPunch(jab(), 1600), 'up again');
});

test('boxer: human guard/lean follow ControlState; a clear lean is the DODGE phase; untracked → neutral', () => {
  const b = human();
  b.setControl(ctl({ guard: 'high', guardAmount: 0.9 }), 0);
  b.update(0);
  assert.equal(b.phase, BoxerPhase.GUARD);
  b.setControl(ctl({ lean: { x: 0.8, y: 0, z: 0 } }), 50);
  b.update(50);
  assert.equal(b.phase, BoxerPhase.DODGE);
  b.setControl(ctl({ tracked: false, guard: 'high', lean: { x: 0.9, y: 0, z: 0 } }), 100);
  b.update(100);
  assert(b.guard === 'none' && b.lean.x === 0);
  assert(b.samples.length >= 3, 'defence history recorded');
  assert.equal(b.combatSnapshot(100).latencyMs, COMBAT.latencyMs);
  assert.equal(new Boxer({ isHuman: true, latencyMs: 140 }).combatSnapshot(0).latencyMs, 140);
});

test('boxer: no regeneration, no daze, no stamina (§2.4, §2.9, §4.1.8); the legacy update({regen}) option is harmless', () => {
  const b = ai();
  b.receive({ result: 'hit', damage: 4, hpAfter: 6, stunMs: 200 }, jab(), 0);
  for (let t = 0; t <= 20000; t += 100) b.update(t, { regen: true });
  assert.equal(b.hp, 6, 'still 6 wedges after 20 s');
  for (let i = 0; i < 8; i++) b.receive({ result: 'hit', damage: 0.1, hpAfter: b.hp - 0.1, stunMs: 100, daze: 1 }, jab(), 20100 + i * 50);
  const v = b.toView(20500);
  assert(!b.isDazed(20500) && v.dazed === false && v.daze01 === 0 && v.stamina01 === 1);
  assert.notEqual(v.phase, BoxerPhase.DAZED);
});

test('boxer: AI tells — wind-up + travel never under COMBAT.minTellMs; power punches swing longer and honour their own floor', () => {
  const b = ai();
  const w = b.startWindup({ hand: 'right', kind: 'straight', target: 'head', windupMs: 10 }, 0);
  assert.equal(w.ms + w.travelMs, COMBAT.minTellMs);
  b.update(w.ms - 1);
  assert.equal(b.phase, BoxerPhase.WINDUP);
  const v = b.toView(w.ms / 2);
  assert(v.windup && v.windup.tellMs === COMBAT.minTellMs && v.punch.stage === 'windup');
  const notes = b.update(w.ms);
  const thrown = notes.find((n) => n.type === 'thrown');
  assert(thrown && thrown.punch.impactAt - w.end === w.travelMs);
  assert.equal(b.effectiveGuard(w.ms + 1), 'none', 'guard open while punching');
  const c = ai();
  const pw = c.startWindup({ hand: 'left', kind: 'hook', target: 'head', windupMs: 100, powerPunch: true, damage: 3, minTellMs: 650 }, 0);
  assert(pw.powerPunch && pw.travelMs === COMBAT.powerTravelMs && pw.ms + pw.travelMs === 650);
  assert(c.toView(10).windup.tell.power, 'the renderer gets a power-punch tell');
  const pt = c.update(pw.end).find((n) => n.type === 'thrown').punch;
  assert(pt.powerPunch && pt.damage === 3);
});

test('boxer: an AI wind-up can be held cocked (extendWindup) — progress stays at the cocked pose', () => {
  const b = ai();
  const w = b.startWindup({ hand: 'left', kind: 'hook', target: 'head', windupMs: 300 }, 0);
  b.extendWindup(900);
  assert.equal(b.windup.end, 900);
  b.update(500);
  const v = b.toView(500);
  assert(v.windup.held && v.windup.progress === 1 && v.windup.msLeft === 400);
  assert.equal(b.update(899).filter((n) => n.type === 'thrown').length, 0);
  assert.equal(b.update(900).filter((n) => n.type === 'thrown').length, 1);
  void w;
});

test('boxer: feints wind up like a punch but never throw it', () => {
  const b = ai();
  b.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 300, feint: true }, 0);
  assert.equal(b.toView(10).windup.feint, undefined, 'feints are not revealed in the view');
  const notes = b.update(300);
  assert(notes.some((n) => n.type === 'feint') && !notes.some((n) => n.type === 'thrown'));
});

test('boxer: AI guard takes guardRaiseMs to move and stays up through a wind-up', () => {
  const b = ai({ guardRaiseMs: 100 });
  b.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  assert.equal(b.effectiveGuard(0), 'high');
  b.applyIntent({ guard: 'low', lean: { x: 0, y: 0, z: 0 } }, 1000);
  assert.equal(b.effectiveGuard(1050), 'none', 'gloves moving');
  assert.equal(b.effectiveGuard(1100), 'low');
  b.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 300 }, 1200);
  assert.equal(b.effectiveGuard(1300), 'low', 'guard held during the wind-up');
});

test('boxer: wind-up armor — ordinary hits do not cancel it, counters do', () => {
  const armored = ai({ windupArmor: true });
  armored.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 400 }, 0);
  armored.receive({ result: 'hit', damage: 1.2, hpAfter: 8.8, stunMs: 600 }, jab(), 100);
  assert(armored.windup && armored.canAct(110), 'armor holds, no reel');
  armored.receive({ result: 'hit', damage: 3, hpAfter: 5.8, stunMs: 600, counter: true }, jab(), 150);
  assert.equal(armored.windup, null, 'a counter cuts through');
  const soft = ai({ windupArmor: false });
  soft.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 400 }, 0);
  const notes = soft.receive({ result: 'hit', damage: 1.2, hpAfter: 8.8, stunMs: 600 }, jab(), 100);
  assert(soft.windup === null && notes.some((n) => n.type === 'interrupted'));
});

test('boxer: a dodge opens the counter window for one counter punch (COM06)', () => {
  const b = human();
  b.setControl(ctl(), 0);
  b.receive({ result: 'dodged' }, jab(), 1000);
  assert.equal(b.toView(1001).counterReady, true);
  const p1 = b.tryPunch(jab(), 1100);
  assert(p1.counter, 'first punch in the window is a counter');
  const p2 = b.tryPunch(jab({ hand: 'right' }), 1250);
  assert(p2 && !p2.counter, `window used up (${COMBAT.counterMaxPunches})`);
  const late = human();
  late.receive({ result: 'dodged' }, jab(), 0);
  assert(!late.tryPunch(jab(), COMBAT.counterWindowMs + 1).counter, 'window expired');
});

test('boxer: an AI reel opens the guard (stunGuardMul share) and a flurry can extend it to maxReelChainMs at most', () => {
  const b = ai({ reelMs: 600, stunGuardMul: 0.5 });
  b.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  b.receive({ result: 'hit', damage: 1.2, hpAfter: 8.8, stunMs: 600 }, jab(), 1000);
  assert(!b.canAct(1100) && b.effectiveGuard(1100) === 'none', 'reeling: open');
  assert.equal(b.effectiveGuard(1400), 'high', 'guard back after half the reel');
  assert(!b.canAct(1400), '… but still cannot punch');
  assert(b.toView(1100).reeling && !b.toView(1400).reeling);
  // A reel chain is capped in REAL time: every clean hit stalls the game clock (the renderer's hit-stop,
  // COMBAT.hitStop: 0.2 s at ×0.02) while real time runs on, so the chain's game-time end moves in by it.
  const net = COMBAT.hitStop.hit * (1 - COMBAT.hitStop.scale);
  b.receive({ result: 'hit', damage: 0.1, hpAfter: b.hp - 0.1, stunMs: 600 }, jab(), 1200);
  approx(b.stunUntil - 1000 + 2 * net, COMBAT.maxReelChainMs, 1e-6, 'two hits: the reel ends maxReelChainMs (real) after the first');
  b.receive({ result: 'hit', damage: 0.1, hpAfter: b.hp - 0.1, stunMs: 600 }, jab(), 1400);
  assert(b.stunUntil <= 1400 && b.effectiveGuard(1401) === 'high', 'a third quick hit finds the chain spent: the reel ends with it (no stun-lock)');
  for (let t = 1600; t <= 1800; t += 200) b.receive({ result: 'hit', damage: 0.1, hpAfter: b.hp - 0.1, stunMs: 600 }, jab(), t);
  assert.equal(b.hp, 8.4, 'the hits still did damage');
  const c = ai({ reelMs: 600 });
  c.receive({ result: 'hit', damage: 1.2, hpAfter: 8.8, stunMs: 600 }, jab(), 0);
  c.cover(100, 900);
  assert(c.canAct(100) && c.effectiveGuard(100) === 'high' && c.isCovering(500) && !c.isCovering(1001));
  assert(!c.canStartWindup(500, 'left'), 'no attacks while covering');
  assert(c.toView(500).covering);
});

test('boxer: a missed AI glove hangs whiffRecoverMs, then the guard needs guardRaiseMs; counters only for punches already out', () => {
  const b = ai({ whiffRecoverMs: 200, guardRaiseMs: 100 });
  b.applyIntent({ guard: 'high', lean: { x: 0, y: 0, z: 0 } }, 0);
  const w = b.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 100 }, 0);
  const p = b.update(w.end).find((n) => n.type === 'thrown').punch;
  assert(b.isMidPunch(p.impactAt - 10, p.thrownAt), 'out (travel)');
  assert(!b.isMidPunch(p.impactAt - 10, p.thrownAt - 1), 'a punch thrown before theirs started does not counter it');
  b.onPunchResolved(p, { result: 'dodged' }, p.impactAt);
  assert(b.isWhiffing(p.impactAt + 150) && b.effectiveGuard(p.impactAt + 150) === 'none');
  assert.equal(b.effectiveGuard(p.impactAt + 250), 'none', 'guard still coming back');
  assert.equal(b.effectiveGuard(p.impactAt + 320), 'high');
  assert(b.midPunchFor(p.impactAt + 250, Infinity), 'the whiff is what gets countered');
  // own counter-punches are not counterable
  const c = ai();
  const cw = c.startWindup({ hand: 'left', kind: 'straight', target: 'head', windupMs: 100, counter: true }, 0);
  const cp = c.update(cw.end).find((n) => n.type === 'thrown').punch;
  assert(cp.counter && !c.midPunchFor(cp.impactAt - 10, cp.impactAt), 'a counter-punch cannot be countered');
});

test('boxer: toView is a complete BoxerView every frame', () => {
  const d = ROSTER[3];
  const b = new Boxer({ id: 'p2', isHuman: false, name: d.name, appearance: d.appearance, stats: d.stats, ai: d.ai });
  b.receive({ result: 'hit', damage: 1.1, hpAfter: 8.9, stunMs: 100 }, jab({ kind: 'hook' }), 0);
  for (const t of [0, 50, 500, 3000]) {
    b.update(t);
    const v = b.toView(t);
    for (const k of ['id', 'name', 'isHuman', 'appearance', 'phase', 'phaseProgress', 'hp01', 'hp', 'maxHp', 'stamina01', 'guard', 'lean', 'hands', 'punch', 'punches', 'hitReact', 'knockdowns', 'roundKnockdowns', 'counterReady', 'expression', 'reeling', 'covering']) {
      assert(k in v, `missing ${k}`);
    }
    assert(Object.values(BoxerPhase).includes(v.phase), v.phase);
    assert(v.phaseProgress >= 0 && v.phaseProgress <= 1 && v.hp01 >= 0 && v.hp01 <= 1);
    assert(['none', 'high', 'low'].includes(v.guard));
    for (const h of ['left', 'right']) for (const f of ['x', 'y', 'reach']) assert(Number.isFinite(v.hands[h][f]), `${h}.${f}`);
    assert(['neutral', 'focus', 'hurt', 'dazed', 'ko', 'happy', 'sad'].includes(v.expression));
    assert(APPEARANCE_OPTIONS.hairStyles.includes(v.appearance.hair.style));
  }
  const v0 = b.toView(50);
  assert(v0.hitReact && v0.hitReact.kind === 'hook' && Math.abs(v0.hitReact.age - 0.05) < 1e-9);
  assert.equal(b.toView(5000).hitReact, null, 'old hit reactions expire');
});

test('boxer: knockdown / get-up refill / terminal phases', () => {
  const b = ai();
  b.knockDown(0);
  b.update(10);
  assert(b.phase === BoxerPhase.DOWN && b.knockdowns === 1 && b.hp === 0);
  b.getUp(1000, 0.8, 800);
  b.update(1100);
  assert(b.phase === BoxerPhase.GETUP && b.hp === 8, 'refill 10 − 2·1 wedges');
  b.update(1900);
  assert.notEqual(b.phase, BoxerPhase.GETUP);
  b.setTerminal('victory', 2000);
  b.update(2000);
  assert(b.phase === BoxerPhase.VICTORY && b.toView(2000).expression === 'happy');
  b.resetForRound(3000);
  assert.equal(b.hp, 8, 'no top-up between rounds');
});

test('boxer: stand-alone use (training) still works — a flinch then heal01 restores full health', () => {
  const b = new Boxer({ id: 'p1', isHuman: true, name: 'Trainee', tuning: { ...COMBAT, lowStaminaTravelMul: 1 } });
  b.setControl(ctl(), 0);
  b.receive({ result: 'hit', damage: 9, stunMs: 150, daze: 0 }, jab(), 10);
  assert.equal(b.hp, 1);
  b.heal01(1);
  assert(b.hp === 10 && b.toView(20).hp01 === 1);
  const p = b.tryPunch(jab(), 500);
  b.update(500, { regen: true });
  const due = b.duePunches(500 + p.impactAt - p.thrownAt);
  assert.equal(due.length, 1);
  b.onPunchResolved(due[0], { result: 'hit', damage: 0, counter: false }, 700);
  assert.equal(b.stats.landed, 1);
});
