// game/match.js — the bout as research/mechanics.md measured it: stages, text calls and the clock
// (§1.2, §3.1, ARCHITECTURE §6.4), knockdowns/KO/get-up (§3, A06), the dodge slow motion (§2.5, §6.3),
// latency fairness (§4.6), the first-bout tutorial (§8, §6.9), one stable result (MAT04), pause,
// determinism, versus.
import { test, assert } from '../harness.mjs';
import { Match, RULES, FAST_RULES, drawTiming } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { COMBAT } from '../../src/game/combat.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase, ResultMethod } from '../../src/core/types.js';
import { Rng } from '../../src/core/rng.js';
import { makeBot } from '../../dev/sim.mjs';

const DT = 25; // exactly representable → paused/unpaused twins stay bit-identical
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
const idle = () => ({ control: ctl(), events: [] });
const punchEv = (hand = 'left', o = {}) => ({ type: 'punch', t: 0, punch: { hand, kind: 'straight', target: 'head', power: 0.5, t: 0, ...o } });
/** A roster-shaped opponent that never attacks unless told to. */
const passive = (ai = {}, base = ROSTER[0]) => ({ ...base, id: `${base.id}-test`, ai: { ...base.ai, firstAttackMs: 1e9, attackGapMs: 1e9, punishPct: 0, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, headGuard: 0, bodyGuard: 0, ...ai } });

function harness(opts = {}) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, fast: opts.fast !== false, seed: 1, id: 'test', ...opts });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t, phase: m.phase, stage: m.stage }));
  let now = 0;
  const step = (inputs) => { now += DT; m.update(DT / 1000, now, inputs); };
  const runUntil = (pred, inputsFn = () => ({}), maxMs = 600000) => {
    const end = now + maxMs;
    while (!pred() && now < end) step(inputsFn());
    return pred();
  };
  const run = (ms, inputsFn = () => ({})) => { const end = now + ms; while (now < end) step(inputsFn()); };
  m.start(0);
  const calls = () => log.filter((e) => e.name === Ev.MATCH_CALL).map((e) => e.p.call);
  const first = (name, pred = () => true) => log.find((e) => e.name === name && pred(e.p));
  return { m, bus, log, step, run, runUntil, calls, first, names: () => log.map((e) => e.name) };
}

const between = (v, a, b, msg) => assert(v >= a && v <= b, `${msg}: ${v} not in [${a}, ${b}]`);

test('match: intro — arena → "Round 1" banner → fly-in → ring → "Fight!" + bell → the clock 0.5–1.3 s later (§1.2)', () => {
  const h = harness({ fast: false, mode: 'versus' });
  const stages = [];
  let lastKey = '';
  assert(h.runUntil(() => {
    const key = `${h.m.phase}/${h.m.stage}`;
    if (key !== lastKey) { stages.push({ key, t: h.m.t, clockVisible: h.m.getView().clockVisible }); lastKey = key; }
    return h.m.phase === MatchPhase.FIGHTING;
  }, () => ({ p1: idle(), p2: idle() })));
  assert.deepEqual(stages.map((s) => s.key), ['intro/arena', 'roundStart/banner', 'roundStart/flyin', 'roundStart/ring', 'roundStart/fight', 'fighting/live']);
  assert(stages.slice(0, -1).every((s) => !s.clockVisible), 'no clock during the intro');
  assert(h.m.getView().clockVisible, 'clock on screen once it runs');
  const tOf = (key) => stages.find((s) => s.key === key).t;
  between(tOf('roundStart/banner'), RULES.introArenaMs, RULES.introArenaMs + DT, 'arena shot ~1 s');
  between(tOf('roundStart/flyin') - tOf('roundStart/banner'), 2000 - DT, 2500 + DT, 'banner 1.5–2.5 s');
  between(tOf('roundStart/fight') - tOf('roundStart/flyin'), 1500 - DT, 2050 + DT, 'fly-in + ring 1.5–2 s');
  between(tOf('fighting/live') - tOf('roundStart/fight'), 500 - DT, 1300 + DT, '"Fight!" → clock');
  between(tOf('fighting/live'), 5000, 6900, 'intro → first tick (VS card excluded)');
  assert.deepEqual(h.calls(), ['round', 'fight']);
  const callRound = h.first(Ev.MATCH_CALL, (p) => p.call === 'round');
  assert(callRound.p.round === 1 && callRound.stage === 'banner');
  const bell = h.first(Ev.MATCH_BELL);
  assert(bell.p.kind === 'start' && bell.stage === 'fight');
  const v = h.m.getView();
  assert(Math.abs(v.clockDisplayMs - RULES.clockDisplayMs) <= 3 * DT, `3:00 (${v.clockDisplayMs})`);
  assert.equal(v.call.call, 'fight');
  assert(v.call.age >= 0.5 && v.call.age <= 1.4);
});

test('match: the round clock counts one game-second every 0.333 s of live time (§1.1)', () => {
  const h = harness({ fast: false, mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  const c0 = h.m.getView().clockDisplayMs;
  h.run(3000, () => ({ p1: idle(), p2: idle() }));
  const c1 = h.m.getView().clockDisplayMs;
  assert(Math.abs((c0 - c1) - 9000) <= 3 * DT * 3, `3 s live → 9 game-s (${c0 - c1})`);
  assert.equal(RULES.clockDisplayMs / RULES.roundRealMs, 3);
});

test('match: a bout without knockouts walks every phase, announces the final round, ends on "Time!" and one decision (A07)', () => {
  const h = harness({ mode: 'versus', p1: { name: 'A' }, p2: { name: 'B' } });
  const phases = [h.m.phase];
  assert(h.runUntil(() => { if (phases[phases.length - 1] !== h.m.phase) phases.push(h.m.phase); return h.m.phase === MatchPhase.RESULT; }, () => ({ p1: idle(), p2: idle() })));
  assert.deepEqual(phases, [
    'intro', 'roundStart', 'fighting', 'roundEnd', 'between',
    'roundStart', 'fighting', 'roundEnd', 'between',
    'roundStart', 'fighting', 'roundEnd', 'decision', 'result',
  ]);
  const n = h.names();
  const count = (name) => n.filter((x) => x === name).length;
  assert.equal(count(Ev.MATCH_INTRO), 1);
  assert.equal(count(Ev.MATCH_ROUND_START), 3);
  assert.equal(count(Ev.MATCH_ROUND_END), 3);
  assert.equal(count(Ev.MATCH_DECISION), 1);
  assert.equal(count(Ev.MATCH_RESULT), 1);
  assert.deepEqual(h.log.filter((e) => e.name === Ev.MATCH_BELL).map((e) => e.p.kind), ['start', 'end', 'start', 'end', 'start', 'final']);
  assert.deepEqual(h.calls(), ['round', 'fight', 'round', 'fight', 'final-round', 'fight', 'time', 'decision']);
  const r = h.m.getResult();
  assert(r.winner === null && r.method === 'draw' && r.scorecards.length === 3 && r.endRound === 3 && r.mode === 'versus');
  for (const c of r.scorecards) { assert.equal(c.p1, 30); assert.equal(c.p2, 30); }
});

test('match: the break between rounds — bell at 0:00, gloves down, wide shot, banner, fly-in, "Fight!" — takes 7.6–9.5 s (§1.2)', () => {
  const h = harness({ fast: false, mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  h.m.debugEndRound();
  h.step({ p1: idle(), p2: idle() });
  const seen = [];
  let last = '';
  h.runUntil(() => {
    const key = `${h.m.phase}/${h.m.stage}`;
    if (key !== last) { seen.push({ key, t: h.m.t, clock: h.m.getView().clockVisible }); last = key; }
    return h.m.phase === MatchPhase.FIGHTING && h.m.round === 2;
  }, () => ({ p1: idle(), p2: idle() }));
  assert.deepEqual(seen.map((s) => s.key), ['roundEnd/bell', 'roundEnd/hold', 'between/arena', 'roundStart/banner', 'roundStart/flyin', 'roundStart/ring', 'roundStart/fight', 'fighting/live']);
  assert(seen[0].clock && !seen[1].clock, 'clock up at the bell, hidden from the hold on');
  between(seen[seen.length - 1].t - seen[0].t, 7600, 9500, 'break');
  const g = h.m.getView().boxers;
  assert(g.p1.hp === 10 && g.p2.hp === 10);
});

test('match: knockdown stoppage — fall (clock still runs), "Down", the count at 1.08 s, rise, stand-off, "Fight!" (§3.1)', () => {
  const h = harness({ fast: false, p2: passive() });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  h.run(2000, () => ({ p1: idle() }));
  const clock0 = h.m.roundElapsed;
  assert(h.m.debugKnockdown('p2', { stayDown: false, riseCount: 6 }));
  const t0 = h.m.t;
  let clockAtHide = null, hiddenAt = null, clockAtFight = null;
  assert(h.runUntil(() => {
    const v = h.m.getView();
    if (hiddenAt == null && !v.clockVisible) { hiddenAt = h.m.t; clockAtHide = h.m.roundElapsed; }
    if (clockAtFight == null && h.m.phase === MatchPhase.RECOVERY && h.m.stage === 'fight') clockAtFight = h.m.roundElapsed;
    return h.m.phase === MatchPhase.FIGHTING;
  }, () => ({ p1: idle() }), 30000));
  const down = h.first(Ev.MATCH_CALL, (p) => p.call === 'down');
  const counts = h.log.filter((e) => e.name === Ev.MATCH_COUNT);
  const getup = h.first(Ev.MATCH_GETUP);
  const fight = h.log.filter((e) => e.name === Ev.MATCH_CALL && e.p.call === 'fight').pop();
  // game ms: the renderer's 0.7 s knockdown hit-stop comes first, so in real time "Down" is 0.7–1.4 s after the blow (§3.1)
  between(down.t - t0, 0, RULES.downCallMs[1] + DT, 'blow → "Down"');
  assert.equal(down.p.boxer, 'p2');
  between(counts[0].t - down.t, 750 - DT, 1500 + DT, '"Down" → "1"');
  for (let i = 1; i < counts.length; i++) between(counts[i].t - counts[i - 1].t, RULES.countIntervalMs - DT, RULES.countIntervalMs + DT, 'count step');
  assert.deepEqual(counts.map((e) => e.p.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(getup.p.atCount, 6);
  between(getup.t - counts[5].t, 300 - DT, 500 + DT, 'last number → rise');
  between(fight.t - getup.t, 3300 - DT, 5700 + DT, 'stand-off');
  between(h.m.t - fight.t, 500 - DT, 1300 + DT, '"Fight!" → clock');
  between(h.m.t - t0, 8100 + 0.92 * 6 * 1000 - 2600, 8100 + 0.92 * 6 * 1000 + 2600, 'stoppage ≈ 8.1 s + 0.92 s × count');
  between(clockAtHide - clock0, 0, 1300 + DT, 'the clock ran during the fall (0–4 game-s)');
  assert.equal(clockAtFight, clockAtHide, 'the clock stayed frozen through the count and the stand-off');
  assert.equal(h.m.boxers.p2.hp, 8, 'refill 10 − 2·1');
  assert.deepEqual(h.log.filter((e) => e.name === Ev.MATCH_CALL).slice(-2).map((e) => e.p.call), ['down', 'fight']);
});

test('match: KO — still down at "10" → "KO" 1–2 s later (call + MATCH_KO) → hold → RESULT with MATCH_RESULT once', () => {
  const h = harness({ fast: false, p2: passive() });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  h.m.debugKnockdown('p2', { stayDown: true });
  assert(h.runUntil(() => h.m.phase === MatchPhase.RESULT, () => ({ p1: idle() }), 30000));
  const ten = h.log.find((e) => e.name === Ev.MATCH_COUNT && e.p.n === 10);
  const ko = h.first(Ev.MATCH_KO);
  const koCall = h.first(Ev.MATCH_CALL, (p) => p.call === 'ko');
  const result = h.first(Ev.MATCH_RESULT);
  between(ko.t - ten.t, 1000 - DT, 2000 + DT, '"10" → "KO"');
  assert.equal(koCall.t, ko.t);
  assert.deepEqual(ko.p, { winner: 'p1', loser: 'p2', method: 'KO' });
  assert.deepEqual({ call: koCall.p.call, boxer: koCall.p.boxer, winner: koCall.p.winner }, { call: 'ko', boxer: 'p2', winner: 'p1' });
  between(result.t - ko.t, RULES.koCallStageMs + RULES.koHoldMs - DT, RULES.koCallStageMs + RULES.koHoldMs + DT, 'KO → RESULT');
  assert.equal(h.names().filter((x) => x === Ev.MATCH_RESULT).length, 1);
  assert(h.m.getResult().method === 'KO' && h.m.getResult().winner === 'p1');
  const stages = [...new Set(h.log.filter((e) => e.phase === MatchPhase.KNOCKDOWN).map((e) => e.stage))];
  assert(['fall', 'down-call', 'count', 'ko-call'].every((s) => stages.includes(s)), stages.join(','));
});

test('match: the human gets up by pumping punches — 5 / 7 / 9 punches, earliest at counts 4 / 5 / 7 (§3.6)', () => {
  const h = harness({ mode: 'versus' });
  const pumpInputs = (k) => { let i = 0; return () => ({ p1: { control: ctl({ activity: 0 }), events: ++i % 2 === 0 && i < k * 2 + 30 ? [punchEv(i % 4 ? 'left' : 'right')] : [] }, p2: idle() }); };
  for (const [kd, earliest] of [[1, 4], [2, 5], [3, 7]]) {
    h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
    h.m.debugKnockdown('p1');
    const before = h.log.length;
    let meter = 0;
    let i = 0;
    const need = RULES.getUp.human.punches[kd - 1];
    assert(h.runUntil(() => { const v = h.m.getView(); if (v.getUp01 != null) meter = Math.max(meter, v.getUp01); return h.m.phase === MatchPhase.RECOVERY; },
      () => ({ p1: { control: ctl(), events: ++i % 3 === 0 && i < 3 * (need + 12) && h.m.t - h.m.kd.at > 350 ? [punchEv(i % 6 ? 'left' : 'right')] : [] }, p2: idle() }), 8000), `rose from knockdown ${kd}`);
    const up = h.log.slice(before).find((e) => e.name === Ev.MATCH_GETUP);
    assert.equal(up.p.atCount, earliest, `knockdown ${kd} rises at ${earliest}`);
    assert.equal(h.m.boxers.p1.hp, 10 - 2 * kd);
    assert(meter >= 0.99, 'getUp01 reached 1');
  }
  void pumpInputs;
  // too few punches → counted out
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  assert.equal(h.m.boxers.p1.knockdowns, 3);
  h.m.debugKnockdown('p1');
  let i = 0;
  h.runUntil(() => !!h.m.getResult(), () => ({ p1: { control: ctl({ activity: 1 }), events: ++i % 3 === 0 ? [punchEv(i % 6 ? 'left' : 'right')] : [] }, p2: idle() }), 10000);
  assert(h.m.getResult() && h.m.getResult().method === 'KO' && h.m.getResult().winner === 'p2', 'a 4th knockdown always stays down');
  assert.equal(h.m.getView().getUp01, null);
});

test('match: a human who does not pump enough is counted out (KO, never a TKO)', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  h.m.debugKnockdown('p1');
  let i = 0;
  assert(h.runUntil(() => !!h.m.getResult(), () => ({ p1: { control: ctl(), events: ++i % 20 === 0 && i < 100 ? [punchEv()] : [] }, p2: idle() }), 10000));
  assert.deepEqual(h.log.filter((e) => e.name === Ev.MATCH_COUNT).map((e) => e.p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert(h.m.getResult().method === ResultMethod.KO && h.m.getResult().winner === 'p2');
});

test('match: pumping the arms (ControlState.activity) alone slowly fills the meter too', () => {
  const h = harness({ mode: 'versus', rules: { countIntervalMs: 1080, firstNumberMs: 1000, downCallMs: 600 } });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  h.m.debugKnockdown('p1');
  assert(h.runUntil(() => h.m.phase === MatchPhase.RECOVERY || !!h.m.getResult(), () => ({ p1: { control: ctl({ activity: 1 }), events: [] }, p2: idle() }), 15000));
  assert.equal(h.m.getResult(), null, 'rose before 10 on activity alone (first knockdown)');
});

test('match: steady arm pumping alone gets a player up from knockdowns 1, 2 and 3 in time; standing still does not (eased 2026-11-13)', () => {
  // (a player's report: the first get-up was very hard and the second almost impossible. Pumping both arms is no punch for
  // the recognizer and a flurry's activity sits around 0.25–0.4 — below the old 0.5 trickle threshold — so only the
  // recognised punches counted, 8 / 12 / 16 of them)
  const R = { countIntervalMs: 1080, firstNumberMs: 1000, downCallMs: 600 };
  const h = harness({ mode: 'versus', rules: R });
  for (let kd = 1; kd <= 3; kd++) {
    h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
    h.m.debugKnockdown('p1');
    const before = h.log.length;
    assert(h.runUntil(() => h.m.phase === MatchPhase.RECOVERY || !!h.m.getResult(), () => ({ p1: { control: ctl({ activity: 0.4 }), events: [] }, p2: idle() }), 15000));
    assert.equal(h.m.getResult(), null, `rose from knockdown ${kd} on arm pumping alone`);
    const up = h.log.slice(before).find((e) => e.name === Ev.MATCH_GETUP);
    assert(up && up.p.atCount <= 8, `knockdown ${kd}: up at ${up && up.p.atCount}`);
  }
  const still = harness({ mode: 'versus', rules: R });
  still.runUntil(() => still.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  still.m.debugKnockdown('p1');
  assert(still.runUntil(() => !!still.m.getResult(), () => ({ p1: { control: ctl({ activity: 0.25 }), events: [] }, p2: idle() }), 15000));
  assert(still.m.getResult().method === ResultMethod.KO, 'barely moving (activity below activityMin) is counted out');
});

test('match: opponents get up per their stay-down chance and rise counts ~ normal(mean, 1.2) clamped 3–9 (§3.2, §3.6)', () => {
  const def = passive({ stayDown: [0.5, 0, 0], riseMean: [6, 7, 8] });
  let stayed = 0;
  const rises = [];
  const N = 120;
  for (let seed = 1; seed <= N; seed++) {
    const h = harness({ seed, p2: def });
    h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
    h.m.debugKnockdown('p2');
    h.runUntil(() => h.m.phase !== MatchPhase.KNOCKDOWN || !!h.m.getResult(), () => ({ p1: idle() }), 20000);
    if (h.m.getResult()) stayed++;
    else rises.push(h.first(Ev.MATCH_GETUP).p.atCount);
  }
  between(stayed / N, 0.36, 0.64, 'stay-down share on knockdown 1');
  assert(rises.every((c) => c >= 3 && c <= 9), `rise counts ${rises}`);
  const mean = rises.reduce((a, b) => a + b, 0) / rises.length;
  between(mean, 5.4, 6.6, 'mean rise count');
});

test('match: refill on rising is 10 − 2k for the opponent too; a 4th knockdown always stays down; never a TKO', () => {
  const h = harness({ p2: passive({ stayDown: [0, 0, 0], riseMean: [4, 4, 4] }) });
  for (let k = 1; k <= 3; k++) {
    h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
    h.m.debugKnockdown('p2');
    assert(h.runUntil(() => h.m.phase === MatchPhase.RECOVERY, () => ({ p1: idle() }), 20000), `rose ${k}`);
    assert.equal(h.m.boxers.p2.hp, 10 - 2 * k);
    assert.equal(h.m.getResult(), null, `three knockdowns in a round are no TKO (${k})`);
  }
  assert.equal(h.m.boxers.p2.roundKnockdowns, 3);
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  h.m.debugKnockdown('p2', { stayDown: false });
  assert(h.runUntil(() => !!h.m.getResult(), () => ({ p1: idle() }), 20000));
  assert.equal(h.m.getResult().method, ResultMethod.KO);
  assert(!h.log.some((e) => e.name === Ev.MATCH_KO && e.p.method === ResultMethod.TKO));
});

test('match: the clock never cuts a count short and there is no saved-by-the-bell (§1.4)', () => {
  const h = harness({ p2: passive({ stayDown: [0, 0, 0], riseMean: [8, 8, 8] }) });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  h.m.roundElapsed = FAST_RULES.roundRealMs - 20; // 0:00 arrives during the fall
  h.m.debugKnockdown('p2', { stayDown: false, riseCount: 8 });
  assert(h.runUntil(() => h.m.phase === MatchPhase.ROUND_END, () => ({ p1: idle() }), 20000));
  const counts = h.log.filter((e) => e.name === Ev.MATCH_COUNT).map((e) => e.p.n);
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8], 'the count went on at 0:00');
  const i = h.log.findIndex((e) => e.name === Ev.MATCH_GETUP);
  const after = h.log.slice(i).map((e) => (e.name === Ev.MATCH_CALL ? `call:${e.p.call}` : e.name));
  assert(after.indexOf(Ev.MATCH_ROUND_END) > 0 && !after.slice(0, after.indexOf(Ev.MATCH_ROUND_END)).includes('call:fight'), 'rose with 0:00 left → straight to the bell');
  const bells = h.log.filter((e) => e.name === Ev.MATCH_BELL && e.p.kind === 'end');
  assert.equal(bells.length, 1);
});

test('match: health carries over between rounds; no regeneration in a round (§1.1, §2.9)', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  h.step({ p1: { control: ctl(), events: [punchEv('left', { power: 0 })] }, p2: idle() });
  h.run(1500, () => ({ p1: idle(), p2: idle() }));
  const hp = h.m.boxers.p2.hp;
  assert(hp < 10 && hp >= 10 - 1.2 * 1.3 - 0.01, `one jab (${hp})`);
  h.run(4000, () => ({ p1: idle(), p2: idle() }));
  assert.equal(h.m.boxers.p2.hp, hp, 'no regeneration');
  h.runUntil(() => h.m.round === 2 && h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  assert.equal(h.m.boxers.p2.hp, hp, 'no top-up between rounds');
});

test('match: MATCH_HIT carries heavy, knockdown, hpBefore and hpAfter in wedges; a block costs nothing', () => {
  const h = harness({ p2: passive() });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  h.step({ p1: { control: ctl(), events: [punchEv('left', { power: 1 })] } });
  h.run(400, () => ({ p1: idle() }));
  const hit = h.first(Ev.MATCH_HIT);
  assert(hit && hit.p.attacker === 'p1' && hit.p.hpBefore === 10 && hit.p.knockdown === false && hit.p.heavy === false);
  assert.equal(hit.p.hpAfter, Math.round((10 - hit.p.damage) * 100) / 100);
  between(hit.p.damage, 1.7 * 0.7 - 0.01, 1.7 * 1.3 + 0.01, 'fast punch 1.2 + 0.5 ±30 %');
  h.m.debugSetHp('p2', 0.4);
  h.step({ p1: { control: ctl(), events: [punchEv('right')] } });
  h.run(400, () => ({ p1: idle() }));
  const kdHit = h.log.filter((e) => e.name === Ev.MATCH_HIT).pop();
  assert(kdHit.p.knockdown && kdHit.p.hpAfter === 0 && kdHit.p.hpBefore === 0.4);
  assert.equal(h.m.phase, MatchPhase.KNOCKDOWN);
  const g = harness({ p2: passive({ headGuard: 1 }) });
  g.runUntil(() => g.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  g.step({ p1: { control: ctl(), events: [punchEv()] } });
  g.run(400, () => ({ p1: idle() }));
  const block = g.first(Ev.MATCH_BLOCK);
  assert(block && block.p.chip === 0 && g.m.boxers.p2.hp === 10, 'green ring, no chip');
});

test('match: dodge slow motion — the world runs ×0.25 for 0.75 s while the dodging human stays real-time (§2.5, §6.3)', () => {
  const def = passive({ firstAttackMs: 300, attackGapMs: 1e9, powerPct: 1, powerKind: 'straight', powerBodyPct: 0, stringWeights: [1], whiffRecoverMs: 190 });
  const h = harness({ p2: def });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  // a timed dodge: the player leans once the power tell shows (only a fresh dodge earns the slow motion, R2)
  assert(h.runUntil(() => !!h.m.boxers.p2.windup, () => ({ p1: idle() }), 5000), 'the tell shows');
  const lean = () => ({ p1: { control: ctl({ lean: { x: 0.9, y: 0, z: 0 } }), events: [] } });
  assert(h.runUntil(() => !!h.m.slowmo, lean, 5000), 'the dodge opened the slow motion');
  const sm = h.first(Ev.MATCH_SLOWMO);
  assert.deepEqual(sm.p, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 });
  const dodge = h.first(Ev.MATCH_DODGE);
  assert(dodge && dodge.p.defender === 'p1' && h.log.indexOf(dodge) < h.log.indexOf(sm));
  const t0 = h.m.t, w0 = h.m.wt, c0 = h.m.roundElapsed;
  h.step({ p1: { control: ctl(), events: [punchEv('right', { power: 0 })] } }); // counter right away
  const thrown = h.m.boxers.p1.punches[0];
  assert(thrown && thrown.counter, 'thrown inside the counter window');
  assert.equal(thrown.impactAt - thrown.thrownAt, COMBAT.punch.straight.humanTravelMs, 'the human punch travels in real time');
  h.run(75, () => ({ p1: idle() }));
  const v = h.m.getView();
  assert(v.slowmo && v.slowmo.dodger === 'p1' && v.slowmo.scale === 0.25 && v.slowmo.t01 > 0 && v.slowmo.msLeft < 750);
  assert(Math.abs((h.m.wt - w0) - (h.m.t - t0) * 0.25) < 1, `world ×0.25 (${h.m.wt - w0} vs ${h.m.t - t0})`);
  assert(Math.abs((h.m.roundElapsed - c0) - (h.m.t - t0) * 0.25) < 1, 'the round clock slows with the world');
  h.run(100, () => ({ p1: idle() }));
  const counter = h.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p1').pop();
  assert(counter && counter.p.counter && counter.p.heavy, 'the counter landed on the hanging glove');
  between(counter.p.damage, 1.2 * 2.5 * 0.7 - 0.01, 4, 'counter ×2.5');
  assert.equal(h.m.getView().slowmo, null, 'the counter ends the slow motion');
});

test('match: versus never slows a human — no slow motion, but the post-dodge counter window opens', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({}));
  h.step({ p1: { control: ctl({ lean: { x: 0.9, y: 0, z: 0 } }), events: [] }, p2: { control: ctl(), events: [punchEv()] } });
  h.run(500, () => ({ p1: { control: ctl({ lean: { x: 0.9, y: 0, z: 0 } }), events: [] }, p2: idle() }));
  assert(h.first(Ev.MATCH_DODGE), 'dodged');
  assert(!h.first(Ev.MATCH_SLOWMO) && h.m.getView().slowmo === null);
  assert.equal(h.m.wt, h.m.t);
});

test('match: latency — an AI punch is judged on the human pose at impact, read latencyMs later (§4.6)', () => {
  const def = passive({ firstAttackMs: 200, attackGapMs: 1e9, stringWeights: [1], powerPct: 0, bodyPct: 0, tellMs: 300 });
  const outcome = (latencyMs, guardFromMs) => {
    const h = harness({ p2: def, latencyMs });
    h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
    let impact = null;
    h.runUntil(() => h.first(Ev.MATCH_HIT) || h.first(Ev.MATCH_BLOCK), () => {
      const p = h.m.boxers.p2.punches.find((q) => q.stage === 'travel');
      if (p && impact == null) impact = p.impactAt;
      const up = impact != null && h.m.t >= impact + guardFromMs;
      return { p1: { control: ctl(up ? { guard: 'high', guardAmount: 1 } : {}), events: [] } };
    }, 6000);
    return h.first(Ev.MATCH_BLOCK) ? 'blocked' : 'hit';
  };
  assert.equal(outcome(100, 90), 'blocked', 'the camera showed the guard 90 ms after contact: it was up in time');
  assert.equal(outcome(0, 90), 'hit', 'with no latency the same pose is too late');
  assert.equal(outcome(100, 260), 'hit', 'genuinely late');
  const m = new Match({ fast: true, latencyMs: 140, p2: def });
  assert(m.latencyMs === 140 && m.boxers.p1.latencyMs === 140);
  m.setLatency(80);
  assert(m.boxers.p1.latencyMs === 80 && m.ais.p2.latencyMs === 80);
});

test('match: AI tells — ordinary ≥ 0.17 s, power punches ≥ 0.55 s + latency (every roster opponent)', () => {
  let powerTotal = 0;
  for (const opp of ROSTER) {
    const bus = new EventBus();
    const m = new Match({ bus, fast: true, seed: opp.tier, p2: opp });
    let n = 0, power = 0;
    bus.on(Ev.MATCH_WINDUP, (p) => {
      if (p.attacker !== 'p2') return;
      n++;
      assert(p.tellMs >= COMBAT.minTellMs - 0.01, `${opp.id} tell ${p.tellMs}`);
      if (p.powerPunch) { power++; assert(p.tellMs >= COMBAT.minPowerTellMs + m.latencyMs - 0.01, `${opp.id} power tell ${p.tellMs}`); }
    });
    const bot = makeBot('player', opp.tier);
    let now = 0;
    m.start(0);
    while (m.phase !== MatchPhase.RESULT && now < 200000) { now += DT; const v = m.getView(); m.update(DT / 1000, now, { p1: bot.update(v.t, v, 'p1') }); }
    assert(n >= 3, `${opp.id} attacked (${n})`);
    powerTotal += power;
  }
  assert(powerTotal >= 5, `power punches were thrown (${powerTotal})`);
});

test('match: no grace after "Fight!" — a bell rusher attacks a fraction of a second after the clock starts (§1.4)', () => {
  const pip = ROSTER[1];
  const h = harness({ fast: false, p2: pip, seed: 3 });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: { control: ctl({ guard: 'high', guardAmount: 1 }), events: [] } }));
  const t0 = h.m.t;
  h.runUntil(() => !!h.first(Ev.MATCH_WINDUP), () => ({ p1: { control: ctl({ guard: 'high', guardAmount: 1 }), events: [] } }), 5000);
  between(h.first(Ev.MATCH_WINDUP).t - t0, pip.ai.firstAttackMs * 0.8 - DT, pip.ai.firstAttackMs * 1.2 + DT, 'first attack');
});

test('match: tutorial — six live steps before the clock, no damage, no knockdowns, scripted opponent; endTutorial → "Fight!" (§8, §6.9)', () => {
  const h = harness({ rules: { tutorial: true, tutorialStepMaxMs: 0 }, p2: ROSTER[0] });
  assert(h.m.setTutorialStep('guard-head') && h.m.setTutorialStep('stance'), 'a step can be chosen during the intro');
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  let v = h.m.getView();
  assert.deepEqual({ step: v.tutorial.step, index: v.tutorial.index, total: v.tutorial.total }, { step: 'stance', index: 0, total: 6 });
  assert(v.stage === 'stance' && v.clockVisible === false && v.call === null);
  assert(!h.first(Ev.MATCH_ROUND_START), 'no round banner before the tutorial');
  h.run(3000, () => ({ p1: idle() }));
  assert(!h.first(Ev.MATCH_WINDUP), 'stance: the opponent waits');
  assert.equal(h.m.roundElapsed, 0, 'no clock');
  // guard-head: slow head jabs that bounce off a high guard
  assert(h.m.setTutorialStep('guard-head'));
  const guard = () => ({ p1: { control: ctl({ guard: 'high', guardAmount: 1 }), events: [] } });
  h.run(6000, guard);
  const blocks = h.log.filter((e) => e.name === Ev.MATCH_BLOCK && e.p.defender === 'p1');
  assert(blocks.length >= 2, `jabs bounced off the guard (${blocks.length})`);
  assert(h.m.getView().tutorial.count >= 2);
  const tells = h.log.filter((e) => e.name === Ev.MATCH_WINDUP).map((e) => e.p.tellMs);
  assert(tells.every((x) => x >= 650), `clearly telegraphed: ${tells}`);
  const gaps = h.log.filter((e) => e.name === Ev.MATCH_WINDUP).map((e) => e.t);
  for (let i = 1; i < gaps.length; i++) between(gaps[i] - gaps[i - 1], 1500 + 600, 2000 + 800, 'one jab every ~1.5–2 s (+ its tell)');
  // unguarded: hits without damage
  h.run(4000, () => ({ p1: idle() }));
  assert(h.log.some((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2'), 'the jab lands on an open guard');
  assert.equal(h.m.boxers.p1.hp, 10, 'no damage');
  // punch-head: guard down, head hits react but cost nothing; no knockdown even on an "empty" pie
  h.m.setTutorialStep('punch-head');
  h.m.debugSetHp('p2', 0.3);
  for (let i = 0; i < 6; i++) { h.step({ p1: { control: ctl(), events: [punchEv(i % 2 ? 'right' : 'left')] } }); h.run(300, () => ({ p1: idle() })); }
  const headHits = h.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p1' && e.p.target === 'head');
  assert(headHits.length >= 5 && headHits.every((e) => e.p.damage === 0 && !e.p.knockdown), 'head hits land, no damage');
  assert(h.m.boxers.p2.hp === 0.3 && h.m.phase === MatchPhase.FIGHTING && h.m.getView().tutorial.count >= 5);
  // punch-body: the head is covered, the body is open
  h.m.setTutorialStep('punch-body');
  h.step({ p1: { control: ctl(), events: [punchEv('left')] } }); h.run(300, () => ({ p1: idle() }));
  h.step({ p1: { control: ctl(), events: [punchEv('right', { target: 'body' })] } }); h.run(300, () => ({ p1: idle() }));
  assert(h.log.some((e) => e.name === Ev.MATCH_BLOCK && e.p.attacker === 'p1' && e.p.target === 'head'));
  assert(h.log.some((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p1' && e.p.target === 'body'));
  // dodge: slow power punches (≥ 0.8 s tells) miss when you lean → MATCH_DODGE + slow motion (a duck entered on the
  // tell, R2); a duck held all along still evades and counts for the card, without the slow motion
  h.m.setTutorialStep('dodge');
  const before = h.log.length;
  const onTell = () => {
    const ai = h.m.boxers.p2;
    const duck = !!(ai.windup || ai.travelling() || ai.punches.some((q) => q.outcome === 'dodged'));
    return { p1: { control: ctl({ lean: { x: 0, y: duck ? -0.9 : 0, z: 0 } }), events: [] } };
  };
  h.run(6000, onTell);
  const late = h.log.slice(before);
  assert(late.some((e) => e.name === Ev.MATCH_WINDUP && e.p.powerPunch && e.p.tellMs >= 800), 'slow power punch');
  assert(late.some((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1' && e.p.fresh) && late.some((e) => e.name === Ev.MATCH_SLOWMO));
  // (the held duck starts while the opponent is between punches: it predates every tell that follows)
  h.runUntil(() => { const ai = h.m.boxers.p2; return !ai.windup && !ai.punches.length && !h.m.slowmo; }, () => ({ p1: idle() }), 5000);
  const count0 = h.m.getView().tutorial.count;
  const held = h.log.length;
  h.run(6000, () => ({ p1: { control: ctl({ lean: { x: 0, y: -0.9, z: 0 } }), events: [] } }));
  const heldLog = h.log.slice(held);
  assert(heldLog.some((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1' && e.p.fresh === false), 'a held duck still evades');
  assert(!heldLog.some((e) => e.name === Ev.MATCH_SLOWMO), 'no slow motion for a held duck');
  assert(h.m.getView().tutorial.count > count0, 'the dodge card still counts it');
  assert.equal(h.m.boxers.p1.hp, 10);
  // end: "Fight!" → round 1 live with fresh stats
  assert(h.m.endTutorial());
  v = h.m.getView();
  assert(v.tutorial === null && v.phase === MatchPhase.ROUND_START && v.stage === 'fight' && v.call.call === 'fight');
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle() }));
  v = h.m.getView();
  assert(v.clockVisible && v.stage === 'live' && v.round === 1);
  assert(h.m.boxers.p1.stats.thrown === 0 && h.m.boxers.p2.hp === 10 && h.m.roundStats[0].p1.thrown === 0, 'the tutorial never counts');
  assert.equal(h.m.setTutorialStep('stance'), false);
});

test('match: an undriven tutorial advances on its own and then starts the bout', () => {
  const h = harness({ rules: { tutorial: true, tutorialStepMaxMs: 1000 } });
  const steps = [];
  assert(h.runUntil(() => {
    const v = h.m.getView();
    if (v.tutorial && steps[steps.length - 1] !== v.tutorial.step) steps.push(v.tutorial.step);
    return h.m.phase === MatchPhase.FIGHTING && !v.tutorial && v.stage === 'live';
  }, () => ({ p1: idle() }), 20000));
  assert.deepEqual(steps, RULES.tutorialSteps);
  const t = harness({ rules: { tutorial: true } });
  assert(t.m.endTutorial(), 'skipping from the intro');
  t.runUntil(() => t.m.phase === MatchPhase.ROUND_START, () => ({}));
  assert(t.m.getView().tutorial === null);
});

test('match: MAT04 — the result is resolved once and later inputs never change it', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({ p1: idle(), p2: idle() }));
  h.m.debugKnockdown('p2', { stayDown: true });
  h.runUntil(() => !!h.m.getResult(), () => ({ p1: idle(), p2: idle() }));
  const r = h.m.getResult();
  const snap = JSON.stringify(r);
  assert(Object.isFrozen(r) && Object.isFrozen(r.stats.p1));
  for (let i = 0; i < 400; i++) h.step({ p1: { control: ctl({ activity: 1 }), events: [punchEv('left'), punchEv('right')] }, p2: { control: ctl({ activity: 1 }), events: [punchEv()] } });
  assert.equal(h.m.phase, MatchPhase.RESULT);
  assert.equal(h.m.getResult(), r, 'same object');
  assert.equal(JSON.stringify(h.m.getResult()), snap, 'same content');
  assert.equal(h.names().filter((x) => x === Ev.MATCH_RESULT).length, 1, 'MATCH_RESULT exactly once');
  assert.equal(h.log.find((e) => e.name === Ev.MATCH_RESULT).p, r);
});

test('match: decision — the busier, more accurate boxer wins on the cards', () => {
  const h = harness({ mode: 'versus', p1: { name: 'A' }, p2: { name: 'B' } });
  let k = 0;
  h.runUntil(() => h.m.phase === MatchPhase.RESULT, () => {
    k++;
    const fighting = h.m.phase === MatchPhase.FIGHTING;
    return { p1: { control: ctl(), events: fighting && k % 230 === 0 ? [punchEv(k % 460 ? 'left' : 'right', { power: 0 })] : [] }, p2: idle() };
  });
  const r = h.m.getResult();
  assert.equal(r.method, 'decision');
  assert.equal(r.winner, 'p1');
  assert.equal(r.decisionType, 'unanimous');
  assert(r.stats.p1.landed > 0 && r.stats.p2.landed === 0);
  for (const c of r.scorecards) assert(c.p1 > c.p2);
});

function botRun(seed, pauseAt = -1) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, p) => log.push(name + JSON.stringify(p)));
  const m = new Match({ bus, fast: true, seed, id: 'det', p2: ROSTER[4] });
  const bot = makeBot('player', seed + 1);
  let now = 0, steps = 0, pausedView = null;
  m.start(0);
  while (m.phase !== MatchPhase.RESULT && steps < 20000) {
    steps++;
    now += DT;
    if (steps === pauseAt) {
      const before = JSON.stringify(m.getView());
      m.pause();
      assert(m.isPaused());
      for (let i = 0; i < 60; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ lean: { x: 1, y: 0, z: 0 }, guard: 'high' }), events: [punchEv()] } }); }
      pausedView = m.getView();
      assert.equal(pausedView.phase, MatchPhase.PAUSED);
      m.resume();
      assert.equal(JSON.stringify(m.getView()), before, 'resume restores the exact state');
    }
    const v = m.getView();
    m.update(DT / 1000, now, { p1: bot.update(v.t, v, 'p1') });
  }
  return { log, result: m.getResult(), pausedView };
}

test('match: seeded determinism — same seed and inputs → identical events and result', () => {
  const a = botRun(21), b = botRun(21), c = botRun(22);
  assert(a.result && b.result);
  assert.deepEqual(a.log, b.log);
  assert.notDeepEqual(a.log, c.log);
});

test('match: pause/resume from mid-fight restores the exact prior state and changes nothing', () => {
  const a = botRun(31), b = botRun(31, 400);
  assert.equal(b.pausedView.pausedFrom, MatchPhase.FIGHTING);
  assert.equal(b.pausedView.banner.kind, 'paused');
  assert.deepEqual(a.log, b.log, 'paused twin plays out identically');
});

test('match: pause works from every phase (intro, knockdown, result)', () => {
  const h = harness({ mode: 'versus' });
  for (const target of [MatchPhase.INTRO, MatchPhase.KNOCKDOWN, MatchPhase.RESULT]) {
    if (target === MatchPhase.KNOCKDOWN) { h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({})); h.m.debugKnockdown('p1'); }
    if (target === MatchPhase.RESULT) h.runUntil(() => h.m.phase === MatchPhase.RESULT, () => ({}));
    assert.equal(h.m.phase, target);
    const t = h.m.t;
    const vis = h.m.getView().clockVisible;
    h.m.pause();
    assert.equal(h.m.getView().clockVisible, vis);
    for (let i = 0; i < 20; i++) h.step({});
    assert.equal(h.m.t, t);
    h.m.resume();
    assert.equal(h.m.phase, target);
  }
});

test('match: punches thrown before the bell still land after it; wind-ups are cancelled', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({}));
  h.m.roundElapsed = FAST_RULES.roundRealMs - 40; // 40 ms before the bell
  h.step({ p1: { control: ctl(), events: [punchEv('left')] }, p2: idle() });
  h.runUntil(() => h.log.some((e) => e.name === Ev.MATCH_HIT), () => ({}), 1000);
  const end = h.log.findIndex((e) => e.name === Ev.MATCH_ROUND_END);
  const hit = h.log.findIndex((e) => e.name === Ev.MATCH_HIT);
  assert(end >= 0 && hit > end, 'hit lands after the bell');
  assert.equal(h.m.roundStats[0].p1.landed, 1, 'and counts for that round');
});

test('match: simultaneous contacts resolve in order (ties → p1) and a knockdown cancels the other punch', () => {
  const h = harness({ mode: 'versus' });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({}));
  h.m.debugSetHp('p1', 0.3);
  h.m.debugSetHp('p2', 0.3);
  h.step({ p1: { control: ctl(), events: [punchEv('left')] }, p2: { control: ctl(), events: [punchEv('left')] } });
  h.runUntil(() => h.m.phase === MatchPhase.KNOCKDOWN, () => ({}), 1000);
  assert.equal(h.m.downed, 'p2');
  const hits = h.log.filter((e) => e.name === Ev.MATCH_HIT);
  assert(hits.length === 1 && hits[0].p.attacker === 'p1');
  assert.equal(h.m.boxers.p1.down, false);
});

test('match: versus mode — p2 is driven by its own input', () => {
  const h = harness({ mode: 'versus', p1: { name: 'Ana' }, p2: { name: 'Ben' } });
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({}));
  h.step({ p1: idle(), p2: { control: ctl(), events: [punchEv('right', { kind: 'hook' })] } });
  const thrown = h.log.find((e) => e.name === Ev.MATCH_PUNCH_THROWN);
  assert(thrown.p.attacker === 'p2' && thrown.p.kind === 'hook');
  assert(h.m.getView().opponent === null && h.m.boxers.p2.isHuman);
});

test('match: the view carries stages, calls, clockVisible, slowmo, tutorial and the legacy banner in sync', () => {
  const h = harness({ p2: ROSTER[2] });
  let v = h.m.getView();
  assert(v.phase === MatchPhase.INTRO && v.stage === 'arena' && v.banner.kind === 'intro' && v.clockVisible === false);
  for (const k of ['stage', 'stageTime', 'call', 'clockVisible', 'slowmo', 'tutorial', 'worldT', 'latencyMs']) assert(k in v, k);
  assert(v.opponent.id === ROSTER[2].id && v.boxers.p2.name === ROSTER[2].name && v.maxRounds === 3);
  assert.equal(v.boxers.p1.maxHp, 10);
  h.runUntil(() => h.m.phase === MatchPhase.ROUND_START, () => ({}));
  v = h.m.getView();
  assert(v.banner.text === 'Round 1' && v.banner.kind === 'round' && v.call.call === 'round');
  h.runUntil(() => h.m.stage === 'fight', () => ({}));
  assert.equal(h.m.getView().banner.kind, 'fight');
  h.runUntil(() => h.m.phase === MatchPhase.FIGHTING, () => ({}));
  assert.equal(h.m.getView().banner.kind, 'fight', '"Fight!" still showing as the clock starts');
  h.m.debugKnockdown('p2', { stayDown: false, riseCount: 3 });
  assert.equal(h.m.getView().banner, null, 'the fall: no text yet');
  h.runUntil(() => h.m.stage === 'down-call', () => ({}));
  assert.equal(h.m.getView().banner.kind, 'knockdown');
  h.runUntil(() => h.m.stage === 'count', () => ({}));
  assert(h.m.getView().banner.kind === 'count' && h.m.getView().count === 1);
  h.runUntil(() => h.m.phase === MatchPhase.RECOVERY, () => ({}));
  assert.equal(h.m.getView().banner.kind, 'getup');
  assert(drawTiming(new Rng(1), [100, 200, 120]) >= 100 && drawTiming(new Rng(1), 5) === 5);
});
