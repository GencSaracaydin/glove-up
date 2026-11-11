// Training base class: READY → ACTIVE → DONE lifecycle, timer, result exactly once, pause/resume,
// popups, score floor, input handling, shared layout constants.
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { LAYOUT } from '../../src/render/style.js';
import {
  TrainingActivity, TrainingPhase, TRAINING_TIMING, TRAINING_LAYOUT, headWorld, punchContact, mergeTuning, ramp,
} from '../../src/training/activity.js';
import { createActivity } from '../../src/training/session.js';

/** Minimal activity: every landed punch scores 10 (or −15 with a left hand). */
class Probe extends TrainingActivity {
  static KIND = 'bag';
  _resolvePunch(p) {
    if (p.hand === 'left') this._score(-15, 'probe-penalty', { popup: 'NOPE', popupKind: 'penalty' });
    else this._score(10, 'probe', { popup: '+10' });
    this.stats.landed++;
    return { result: 'hit' };
  }
}

const control = (lean = { x: 0, y: 0, z: 0 }) => ({ tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { z: 0, ...lean }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 });
const punch = (hand = 'right', kind = 'straight', target = 'head') => ({ type: 'punch', t: 0, punch: { hand, kind, target, power: 0.7, t: 0 } });

function rig(Kind = Probe, opts = {}) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, payload) => log.push({ name, payload }));
  const act = new Kind({ bus, rng: 5, ...opts });
  const clock = { now: 1000 };
  const run = (ms, input = null, step = 1000 / 60) => {
    let first = true;
    for (let done = 0; done < ms - 1e-9; done += step) {
      clock.now += step;
      act.update(step / 1000, clock.now, first ? input : (input ? { control: input.control, events: [] } : null));
      first = false;
    }
  };
  return { bus, log, act, clock, run, count: (n) => log.filter((e) => e.name === n).length };
}

test('training-activity: starts READY, emits TRAIN_START once, goes ACTIVE after readyMs', () => {
  const { act, run, count } = rig();
  assert.equal(act.phase, TrainingPhase.READY);
  run(100);
  assert.equal(count(Ev.TRAIN_START), 1);
  assert.equal(act.getView().phase, 'ready');
  assert.equal(act.getView().timeLeftMs, act.durationMs, 'full clock during READY');
  approx(act.getView().readyLeftMs, TRAINING_TIMING.readyMs - 100, 20);
  run(TRAINING_TIMING.readyMs);
  assert.equal(act.phase, TrainingPhase.ACTIVE);
  assert(act.getView().timeLeftMs < act.durationMs);
});

test('training-activity: punches during READY are ignored; during ACTIVE they resolve after glove travel', () => {
  const { act, run } = rig();
  run(50, { control: control(), events: [punch()] });
  run(400);
  assert.equal(act.score, 0, 'READY punches never score');
  run(TRAINING_TIMING.readyMs);
  run(17, { control: control(), events: [punch('right')] });
  assert.equal(act.score, 0, 'not before the glove arrives');
  run(250);
  assert.equal(act.score, 10);
  assert.equal(act.stats.punches, 1);
});

test('training-activity: clock runs out → DONE, result resolved once with medal, TRAIN_END exactly once', () => {
  const { act, run, count } = rig(Probe, { durationMs: 5000, readyMs: 500 });
  run(600);
  run(17, { control: control(), events: [punch('right')] });
  run(5200);
  assert(act.isDone());
  const r = act.getResult();
  assert(r && r.kind === 'bag' && r.score === 10 && typeof r.id === 'string');
  assert.equal(r.medal, 'none');
  assert.equal(r.participantId, 'guest');
  assert.equal(count(Ev.TRAIN_END), 1);
  // later input / updates / endNow never change it (result resolved once)
  run(1000, { control: control(), events: [punch('right'), punch('left')] });
  act.endNow();
  assert.equal(act.getResult(), r, 'same object');
  assert.equal(act.getResult().score, 10);
  assert.equal(count(Ev.TRAIN_END), 1);
  assert.equal(act.getView().timeLeftMs, 0);
});

test('training-activity: a punch thrown just before the bell still counts (lands in overtime)', () => {
  const { act, run } = rig(Probe, { durationMs: 2000, readyMs: 0 });
  run(1950);
  run(17, { control: control(), events: [punch('right')] });
  run(600);
  assert(act.isDone());
  assert.equal(act.getResult().score, 10);
});

test('training-activity: pause freezes clock and ignores input; resume continues from the same state', () => {
  const { act, run } = rig(Probe, { readyMs: 0 });
  run(1000);
  const left = act.getView().timeLeftMs;
  assert(act.pause());
  assert(!act.pause(), 'second pause is a no-op');
  run(3000, { control: control(), events: [punch('right')] });
  assert.equal(act.getView().timeLeftMs, left, 'clock frozen');
  assert.equal(act.getView().paused, true);
  assert.equal(act.score, 0, 'input ignored while paused');
  assert(act.resume());
  run(1000 / 60);
  approx(act.getView().timeLeftMs, left - 1000 / 60, 1, 'no jump after resume');
  run(17, { control: control(), events: [punch('right')] });
  run(300);
  assert.equal(act.score, 10);
});

test('training-activity: score never drops below 0; popups age and expire', () => {
  const { act, run, log } = rig(Probe, { readyMs: 0 });
  run(100);
  run(17, { control: control(), events: [punch('left')] });
  run(300);
  assert.equal(act.score, 0);
  const ev = log.find((e) => e.name === Ev.TRAIN_SCORE);
  assert.equal(ev.payload.delta, -15);
  assert.equal(ev.payload.applied, 0);
  const pop = act.getView().popups.find((p) => p.text === 'NOPE');
  assert(pop && pop.kind === 'penalty' && pop.age >= 0 && pop.age < 0.4);
  run(TRAINING_TIMING.popupLifeMs + 100);
  assert(!act.getView().popups.some((p) => p.text === 'NOPE'), 'expired');
});

test('training-activity: endNow resolves early once; update steps are clamped (no jumps)', () => {
  const { act, run, clock, count } = rig(Probe, { readyMs: 0 });
  run(50);
  clock.now += 60000; // a long hitch / background tab
  act.update(60, clock.now, null);
  assert(!act.isDone(), 'one update advances at most maxStepMs');
  assert(act.t < 400);
  const r = act.endNow('quit');
  assert(r && act.isDone() && r.details.endReason === 'quit');
  act.endNow('again');
  assert.equal(count(Ev.TRAIN_END), 1);
});

test('training-activity: accepts PlayerInput, {players:[…]} and arrays; trainee follows lean', () => {
  const { act, clock } = rig(Probe, { readyMs: 0 });
  const feed = (input) => { for (let i = 0; i < 6; i++) { clock.now += 16; act.update(0.016, clock.now, input); } };
  feed({ players: [{ control: control({ x: 0.8, y: 0 }), events: [] }] });
  assert(act.getView().playerView.lean.x > 0.7);
  feed([{ control: control({ x: -0.8, y: 0 }), events: [] }]);
  assert(act.getView().playerView.lean.x < -0.7);
  assert.equal(act.getView().playerView.phase, 'dodge');
  feed({ control: control({ x: 0, y: -0.9 }), events: [] });
  assert(act.getView().playerView.lean.y < -0.8);
  feed(null);
  assert.equal(act.getView().playerView.lean.y, 0, 'no input = neutral');
});

test('training-activity: participant profile flows into the trainee view and the result', () => {
  const participant = { id: 'p-42', name: 'Robin', kind: 'local', appearance: { skin: '#eec1a0' } };
  const act = new Probe({ participant, durationMs: 1000, readyMs: 0 });
  const v = act.getView();
  assert.equal(v.participant.name, 'Robin');
  assert.equal(v.playerView.name, 'Robin');
  assert.deepEqual(v.playerView.appearance, participant.appearance);
  act.endNow();
  assert.equal(act.getResult().participantId, 'p-42');
});

test('training-activity: result ids are unique per attempt', () => {
  const a = createActivity('bag', { rng: 1 }), b = createActivity('bag', { rng: 1 });
  assert.notEqual(a.id, b.id);
});

test('training-activity: layout mirrors render/style.js LAYOUT', () => {
  assert.deepEqual([...TRAINING_LAYOUT.playerPos], [...LAYOUT.p1Pos]);
  assert.deepEqual([...TRAINING_LAYOUT.opponentPos], [...LAYOUT.p2Pos]);
  assert(TRAINING_LAYOUT.headY < LAYOUT.boxerHeight && TRAINING_LAYOUT.headY > LAYOUT.boxerHeight * 0.75);
  // gloves land between the fighters, closer to the opponent's spot
  assert(TRAINING_LAYOUT.punch.planeZ < 0 && TRAINING_LAYOUT.punch.planeZ > LAYOUT.p2Pos[2]);
});

test('training-activity: headWorld / punchContact geometry', () => {
  const n = headWorld({ x: 0, y: 0 });
  approx(n[0], 0, 1e-9); approx(n[1], TRAINING_LAYOUT.headY, 1e-9);
  const r = headWorld({ x: 1, y: 0 });
  assert(r[0] > 0.2, 'leaning right moves the head to world +X (player faces −Z)');
  const d = headWorld({ x: 0, y: -1 });
  assert(d[1] < n[1] - 0.15 && d[2] < n[2], 'ducking drops the head and pitches it forward');
  const lj = punchContact({ hand: 'left', kind: 'straight', target: 'head' });
  const rh = punchContact({ hand: 'right', kind: 'hook', target: 'head' });
  const lb = punchContact({ hand: 'left', kind: 'straight', target: 'body' });
  assert(lj[0] < 0 && rh[0] > lj[0] && rh[0] > 0.05);
  assert(lb[1] < lj[1] - 0.2);
  // leaning carries the gloves: right lean shifts contact to +X, a duck lowers it, leaning in reaches further
  const leanR = punchContact({ hand: 'left', kind: 'straight', target: 'head' }, [0, 0, 0], undefined, { x: 1, y: 0, z: 0 });
  assert(leanR[0] > lj[0] + 0.15);
  const duck = punchContact({ hand: 'left', kind: 'straight', target: 'head' }, [0, 0, 0], undefined, { x: 0, y: -1, z: 0 });
  assert(duck[1] < lj[1] - 0.1);
  const lunge = punchContact({ hand: 'left', kind: 'straight', target: 'head' }, [0, 0, 0], undefined, { x: 0, y: 0, z: 1 });
  assert(lunge[2] < lj[2]);
});

test('training-activity: mergeTuning / ramp helpers', () => {
  const m = mergeTuning({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { d: 9 }, e: [5] });
  assert.deepEqual(m, { a: 1, b: { c: 2, d: 9 }, e: [5] });
  approx(ramp([10, 20], 0.5), 15);
  approx(ramp([10, 20], 2), 20);
  approx(ramp(7, 0.3), 7);
});
