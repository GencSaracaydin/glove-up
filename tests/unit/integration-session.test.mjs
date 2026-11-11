// src/app/session.js (MatchSession, TrainingRun) and src/app/params.js — the app-side wiring of
// a bout / a drill: game clock, pause/resume (SES02), restart, result hand-over, versus routing.
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';
import { ROSTER } from '../../src/game/roster.js';
import { MatchSession, TrainingRun, deriveSeed, humanCorner, SESSION_TUNING } from '../../src/app/session.js';
import { parseParams } from '../../src/app/params.js';

const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.1, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.1, reach: 0.1, punching: false } },
  activity: 0, ...o,
});
const idle = () => ({ control: ctl(), events: [] });
const jab = (hand = 'left', t = 0) => ({ control: ctl(), events: [{ type: 'punch', t, punch: { hand, kind: 'straight', target: 'head', power: 0.8, t } }] });
const profile = (id, name) => ({ id, name, kind: 'guest', appearance: null, skill: 0, records: {} });

/** Fake renderer / HUD that record what the session asks of them. */
function fakes() {
  const calls = [];
  const renderer = {
    timeScale: 1,
    resetMatch: () => calls.push('resetMatch'), setSplit: (n) => calls.push(`split:${n}`), setScene: (s) => calls.push(`scene:${s}`),
    renderMatch: () => calls.push('renderMatch'), renderTraining: () => calls.push('renderTraining'),
  };
  const hud = {
    show: (k, o) => calls.push(`hud:${k}:${o?.mode || o?.training}`), hide: () => calls.push('hud:hide'),
    update: () => calls.push('hud:update'), updateTraining: () => calls.push('hud:updateTraining'),
  };
  return { calls, renderer, hud };
}

function runner(session) {
  let now = 1000;
  return {
    get now() { return now; },
    step(ms, inputs = () => [idle()]) {
      for (let t = 0; t < ms; t += 16) { now += 16; session.update(0.016, now, typeof inputs === 'function' ? inputs() : inputs); }
    },
    until(pred, inputs = () => [idle()], maxMs = 120000) {
      const end = now + maxMs;
      while (!pred() && now < end) { now += 16; session.update(0.016, now, inputs()); }
      return pred();
    },
  };
}

test('params: input modes, flags, seed, quality, skip', () => {
  const p = parseParams('?input=keyboard&debug=1&fast=1&seed=42&quality=low&skip=match&calibrate=1');
  assert.deepEqual([p.input, p.debug, p.fast, p.seed, p.quality, p.skip, p.calibrate], ['keyboard', true, true, '42', 'low', 'match', true]);
  const d = parseParams('');
  assert.deepEqual([d.input, d.debug, d.fast, d.seed, d.quality, d.skip], [null, false, false, null, 'auto', null]);
  assert.equal(parseParams('?input=bogus').input, null);
  assert.equal(parseParams('?input=SYNTHETIC').input, 'synthetic');
  assert.equal(parseParams('?fast=0').fast, false);
  assert.equal(parseParams('?input=replay&rec=/r.json').rec, '/r.json');
  // first-bout tutorial: forced off / on, or automatic (null)
  assert.equal(parseParams('?tutorial=0').tutorial, false);
  assert.equal(parseParams('?tutorial=1').tutorial, true);
  assert.equal(parseParams('').tutorial, null);
  // where pose detection runs (PERF-01): the hub's default unless asked
  assert.equal(parseParams('?detector=main').detector, 'main');
  assert.equal(parseParams('?detector=WORKER').detector, 'worker');
  assert.equal(parseParams('?detector=gpu').detector, null);
  assert.equal(parseParams('').detector, null);
});

test('session: deriveSeed is deterministic per base + counter, random without a base', () => {
  assert.equal(deriveSeed('7', 'match:1'), deriveSeed('7', 'match:1'));
  assert.notEqual(deriveSeed('7', 'match:1'), deriveSeed('7', 'match:2'));
  assert.notEqual(deriveSeed('7', 'match:1'), deriveSeed('8', 'match:1'));
  const r = deriveSeed(null, 1);
  assert(Number.isInteger(r) && r >= 0);
  assert.deepEqual(humanCorner(profile('a', 'Ann')), { name: 'Ann', appearance: null, isHuman: true });
});

test('session: a single-player bout puts the arena, split and HUD in place and runs on the game clock', () => {
  const { calls, renderer, hud } = fakes();
  const bus = new EventBus();
  const intro = [];
  bus.on(Ev.MATCH_INTRO, (p) => intro.push(p));
  const s = new MatchSession({ bus, renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[0], seed: 'x', fast: true });
  s.begin();
  assert.deepEqual(calls.slice(0, 4), ['resetMatch', 'split:1', 'scene:match', 'hud:match:single']);
  assert(intro.length === 1 && intro[0].p1Name === 'Pat' && intro[0].p2Name === ROSTER[0].name, 'MATCH_INTRO with both names');
  assert.equal(s.humans, 1);
  const r = runner(s);
  assert(r.until(() => s.match.phase === MatchPhase.FIGHTING), 'reaches the first exchange');
  // hit-stop / slow motion: game time follows renderer.timeScale
  const t0 = s.match.t;
  renderer.timeScale = 0.25;
  r.step(400);
  const slow = s.match.t - t0;
  renderer.timeScale = 1;
  assert(slow > 60 && slow < 140, `slowed game time ${slow}`);
  // punches reach the match through the P1 input
  r.step(200, () => [jab('left', r.now)]);
  assert(s.match.boxers.p1.stats.thrown >= 1, 'punch thrown');
  s.render(0.016, {});
  assert(calls.includes('renderMatch') && calls.includes('hud:update'));
});

test('session: pause freezes the bout exactly; resume continues; restart starts over (SES01/SES02)', () => {
  const { renderer, hud } = fakes();
  const s = new MatchSession({ bus: new EventBus(), renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[1], seed: 3, fast: true });
  s.begin();
  const r = runner(s);
  r.until(() => s.match.phase === MatchPhase.FIGHTING);
  r.step(500, () => [jab('right', r.now)]);
  const before = JSON.stringify(s.match.getView().boxers.p2.hp01) + s.match.roundElapsed + s.match.t;
  s.pause();
  assert(s.paused && s.match.phase === MatchPhase.PAUSED && s.canPause === true);
  r.step(3000, () => [jab('left', r.now)]);
  assert.equal(JSON.stringify(s.match.getView().boxers.p2.hp01) + s.match.roundElapsed + s.match.t, before, 'nothing moves while paused');
  s.resume();
  assert(!s.paused && s.match.phase === MatchPhase.FIGHTING);
  r.step(200);
  assert(s.match.t > 0);
  const id = s.match.id;
  s.restart();
  assert(s.match.id !== id && s.attempt === 2 && s.match.phase === MatchPhase.INTRO && !s.paused && !s.finished, 'fresh bout');
  assert.equal(s.match.getView().boxers.p2.hp01, 1);
});

test('session: without a renderer outro the result is handed over once, after the linger; pausing is refused once decided (MAT04)', () => {
  const { renderer, hud } = fakes();
  const bus = new EventBus();
  let results = 0;
  bus.on(Ev.MATCH_RESULT, () => results++);
  const s = new MatchSession({ bus, renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[0], seed: 5, fast: true });
  s.begin();
  const r = runner(s);
  assert(r.until(() => s.match.phase === MatchPhase.FIGHTING));
  s.match.debugKnockdown('p2', { stayDown: true });
  assert(r.until(() => s.over), 'decided');
  assert(s.handoff, 'a locked result is handed to the app at once (it saves it)');
  assert.equal(s.canPause, false, 'no pausing a decided bout');
  assert(r.until(() => s.match.phase === MatchPhase.RESULT));
  const at = r.now;
  assert(!s.finished && !s.outroActive, 'lingers on the result first (no playOutro on this renderer)');
  assert(r.until(() => s.finished));
  assert(r.now - at >= SESSION_TUNING.resultLingerFastMs - 20, 'linger respected');
  assert.equal(results, 1);
  assert(s.result && s.result.winner === 'p1' && s.result.method === 'KO');
  s.releaseHud();
});

test('session: after MATCH_RESULT the bout outro plays; finished (and whenFinished) only when it resolves; skipOutro (§6.5)', async () => {
  const { calls, renderer, hud } = fakes();
  let resolveOutro = null;
  const outroArgs = [];
  renderer.playOutro = (o) => { outroArgs.push(o); calls.push('playOutro'); return new Promise((res) => { resolveOutro = res; }); };
  renderer.skipOutro = () => { calls.push('skipOutro'); resolveOutro?.(); };
  const bus = new EventBus();
  const order = [];
  bus.on(Ev.MATCH_RESULT, () => order.push('result'));
  const s = new MatchSession({ bus, renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[2], seed: 9, fast: true });
  s.begin();
  const r = runner(s);
  assert(r.until(() => s.match.phase === MatchPhase.FIGHTING));
  s.match.debugKnockdown('p2', { stayDown: true });
  assert(r.until(() => s.over));
  assert(!calls.includes('playOutro'), 'no outro before RESULT (KO call and hold first)');
  assert(r.until(() => s.outroActive));
  assert.deepEqual(order, ['result'], 'MATCH_RESULT first, then the outro');
  assert.equal(outroArgs.length, 1);
  assert(outroArgs[0].result.method === 'KO' && outroArgs[0].view.phase === MatchPhase.RESULT && outroArgs[0].fast === true, 'result + view + fast');
  let finishedWith = null;
  s.whenFinished().then((res) => { finishedWith = res; });
  r.step(5000);
  assert(!s.finished && s.outroActive, 'waits for the outro, however long it runs');
  assert.equal(calls.filter((c) => c === 'playOutro').length, 1, 'played once');
  // once the result is locked, punches no longer reach the match (its figures still mirror the players)
  const thrown = s.match.boxers.p1.stats.thrown;
  r.step(300, () => [jab('left', r.now)]);
  assert.equal(s.match.boxers.p1.stats.thrown, thrown, 'post-result punches ignored');
  assert.equal(s.skipOutro(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert(s.finished && !s.outroActive && s.debug().outro.skipped, 'finished after the (skipped) outro');
  assert.equal(finishedWith?.id, s.result.id);
  assert.equal(s.skipOutro(), false, 'nothing left to skip');
  assert(calls.includes('skipOutro'));
});

test('session: the camera latency reaches the Match (re-read on restart); training passes it to the drill (§4.6)', () => {
  const { renderer, hud } = fakes();
  let lat = 142;
  const s = new MatchSession({ bus: new EventBus(), renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[0], seed: 2, fast: true, latencyMs: () => lat });
  s.begin();
  assert.equal(s.match.latencyMs, 142);
  assert.equal(s.view.latencyMs, 142);
  assert.equal(s.match.boxers.p1.latencyMs, 142, 'the human corner judges its defence with it');
  lat = 60;
  s.restart();
  assert.equal(s.match.latencyMs, 60);
  const d = new MatchSession({ bus: new EventBus(), renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[0], seed: 2, fast: true, latencyMs: null });
  d.begin();
  assert.equal(d.match.latencyMs, 100, 'no measurement → the game default');
  const run = new TrainingRun({ bus: new EventBus(), renderer, hud, kind: 'dodge', participants: [profile('a', 'Ann')], seed: 4, fast: true, latencyMs: () => 130 });
  run.begin();
  assert.equal(run.act.latencyMs, 130);
  const run2 = new TrainingRun({ bus: new EventBus(), renderer, hud, kind: 'dodge', participants: [{ ...profile('a', 'Ann'), calibration: { latencyMs: 90 } }], seed: 4, fast: true });
  run2.begin();
  assert.equal(run2.act.latencyMs, 90, 'the activity reads calibration.latencyMs itself');
});

test('session: dodge slow motion runs inside the Match — the world slows, the dodging human does not (§6.3)', () => {
  const { renderer, hud } = fakes();
  const bus = new EventBus();
  const slow = [];
  bus.on(Ev.MATCH_SLOWMO, (e) => slow.push(e));
  const s = new MatchSession({ bus, renderer, hud, mode: 'single', players: [profile('p', 'Pat')], opponent: ROSTER[0], seed: 6, fast: true });
  s.begin();
  const r = runner(s);
  assert(r.until(() => s.match.phase === MatchPhase.FIGHTING));
  s.match.ai.setScript('dodge', s.match.wt); // scripted power hooks with long tells
  const duck = () => [{ control: ctl({ lean: { x: 0, y: -1, z: 0 } }), events: [] }];
  // a timed dodge (R2): duck once the raised-glove tell shows
  assert(r.until(() => !!s.match.boxers.p2.windup, () => [idle()], 15000), 'the tell shows');
  assert(r.until(() => !!s.view.slowmo, duck, 15000), 'a ducked power hook opens the slow motion');
  assert(slow.length === 1 && slow[0].dodger === 'p1' && slow[0].scale === 0.25);
  const t0 = s.match.t, w0 = s.match.wt, g0 = s.gameNow;
  r.step(160, duck);
  const dt = s.match.t - t0, dw = s.match.wt - w0;
  assert(Math.abs(dt - (s.gameNow - g0)) < 1, 'the human corner keeps real (game) time');
  assert(dw < dt * 0.4, `the world runs slower (${dw.toFixed(0)} vs ${dt.toFixed(0)} ms)`);
});

test('session: versus routes P2 input to the second human and shows the split screen', () => {
  const { calls, renderer, hud } = fakes();
  const s = new MatchSession({ bus: new EventBus(), renderer, hud, mode: 'versus', players: [profile('a', 'Ann'), profile('b', 'Bo')], seed: 1, fast: true });
  s.begin();
  assert(calls.includes('split:2') && calls.includes('hud:match:versus'));
  assert.equal(s.humans, 2);
  assert.equal(s.nameOf(1), 'Bo');
  const r = runner(s);
  r.until(() => s.match.phase === MatchPhase.FIGHTING);
  r.step(300, () => [idle(), jab('left', r.now)]);
  assert(s.match.boxers.p2.isHuman && s.match.boxers.p2.stats.thrown >= 1 && s.match.boxers.p1.stats.thrown === 0, 'P2 punched, P1 did not');
});

test('session: a training turn runs to its result; restart replaces the attempt (TRN01/TRN02)', () => {
  const { calls, renderer, hud } = fakes();
  const bus = new EventBus();
  const ends = [];
  bus.on(Ev.TRAIN_END, (r) => ends.push(r));
  const parts = [profile('a', 'Ann'), profile('b', 'Bo')];
  const run = new TrainingRun({ bus, renderer, hud, kind: 'bag', participants: parts, seed: 4, fast: true });
  run.begin();
  assert(calls.includes('scene:training') && calls.includes('hud:training:bag'));
  assert.equal(run.participant.name, 'Ann');
  const firstId = run.act.id;
  run.restart();
  assert(run.act.id !== firstId, 'restart = a new attempt');
  const r = runner(run);
  assert(r.until(() => run.act.phase === 'active'));
  run.pause();
  const t = run.act.t;
  r.step(1000, () => [jab('left', r.now)]);
  assert.equal(run.act.t, t, 'paused drill does not move');
  run.resume();
  let k = 0;
  assert(r.until(() => run.finished, () => [++k % 12 === 0 ? jab(k % 24 ? 'left' : 'right', r.now) : idle()], 60000), 'drill finishes');
  assert(ends.length === 1 && run.result && run.result.id === ends[0].id && Number.isFinite(run.result.score));
  run.session.record(run.result, { ok: true, saved: false, reason: 'guest' });
  assert(run.session.next() && run.participant.name === 'Bo', 'next participant');
  run.begin();
  assert.equal(run.act.participant.name, 'Bo');
});
