// Target punching: matching-side hits, speed bonus, trainer-hit deduction, latency grace,
// follow-up absorption, wrong height, double bonus, combos, expiry, ramp.
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { TargetPunching, MITTS_TUNING } from '../../src/training/mitts.js';

const control = () => ({ tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 });
const punch = (hand, target = 'head', kind = 'straight') => ({ type: 'punch', t: 0, punch: { hand, kind, target, power: 0.7, t: 0 } });
const S = MITTS_TUNING.score, T = MITTS_TUNING.timing;

function rig(opts = {}) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, payload) => log.push({ name, payload }));
  const act = new TargetPunching({ bus, rng: 21, readyMs: 0, tuning: { timing: { firstDelayMs: 1e9 } }, ...opts });
  const clock = { now: 1000 };
  const run = (ms, events = null, step = 1000 / 120) => {
    let first = true;
    for (let done = 0; done < ms - 1e-9; done += step) {
      clock.now += step;
      act.update(step / 1000, clock.now, { control: control(), events: first && events ? events : [] });
      first = false;
    }
  };
  run(20);
  const events = (type) => log.filter((e) => e.name === Ev.TRAIN_EVENT && e.payload.type === type);
  return { act, run, log, events };
}

test('training-mitts: hitting the raised mitt with the matching hand scores base + speed bonus', () => {
  const { act, run, events } = rig();
  act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 });
  assert.equal(events('target-up').length, 1);
  run(150);                                   // a fast reaction
  run(10, [punch('left')]);
  run(250);
  assert.equal(act.drill.hits, 1);
  assert.equal(act.score, S.base + S.speedBonus, 'fast → full speed bonus');
  assert.equal(events('mitt-hit').length, 1);
  const pos = events('mitt-hit')[0].payload.pos;
  assert(pos[0] < -0.02 && pos[0] > -MITTS_TUNING.mitt.x, `your left mitt is on world −X, brought in to meet the glove (${pos[0]})`);
  approx(pos[2], MITTS_TUNING.mitt.faceZ, 1e-9);
  assert.equal(act.mitts.left.state, 'hit');
  assert(act.getView().popups.some((p) => p.kind === 'perfect'));
});

test('training-mitts: slower reactions earn less (monotonic speed bonus)', () => {
  const scores = [150, 500, 700, 900, 1200].map((delay) => {
    const { act, run } = rig();
    act.presentNow({ kind: 'single', side: 'right', heights: 'high', showMs: 1600 });
    run(delay);
    run(10, [punch('right')]);
    run(250);
    assert.equal(act.drill.hits, 1, `hit after ${delay} ms`);
    return act.score;
  });
  for (let i = 1; i < scores.length; i++) assert(scores[i] <= scores[i - 1], scores.join());
  assert(scores[0] > scores[scores.length - 1]);
  assert.equal(scores[scores.length - 1], S.base, 'no speed bonus past slowMs');
});

test('training-mitts: wrong hand hits the trainer: −10, flinch, streak reset, next target waits', () => {
  const { act, run, events } = rig();
  act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 });
  run(200);
  run(10, [punch('left')]);
  run(400);
  const before = act.score;
  assert(before > 0);
  act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 }) || (run(600), act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 }));
  run(200);
  run(10, [punch('right')]);
  run(250);
  assert.equal(act.score, before + S.trainer);
  assert.equal(act.drill.trainerHits, 1);
  assert.equal(act.combo, 0);
  assert.equal(events('trainer-hit').length, 1);
  const tv = act.getView().trainer;
  assert.equal(tv.phase, 'hitstun');
  assert(tv.hitReact && tv.hitReact.hand === 'right');
  assert(act.getView().popups.some((p) => p.kind === 'penalty' && /WRONG HAND/.test(p.text)));
});

test('training-mitts: punching when no mitt is up hits the trainer; the score never goes below 0', () => {
  const { act, run } = rig();
  run(10, [punch('left')]);
  run(250);
  assert.equal(act.drill.trainerHits, 1);
  assert.equal(act.score, 0);
  assert(act.getView().popups.some((p) => /OUCH/.test(p.text)));
});

test('training-mitts: a punch recognised just after the mitt started dropping still counts (latency grace)', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'single', side: 'right', heights: 'high', showMs: 400 });
  // wait until it starts lowering
  let guard = 0;
  while (act.mitts.right.state !== 'lowering' && guard++ < 400) run(5);
  run(T.lateGraceMs * 0.6);
  run(5, [punch('right')]);
  run(250);
  assert.equal(act.drill.hits, 1, 'counted');
  assert.equal(act.drill.trainerHits, 0);
});

test('training-mitts: a punch long after the mitt dropped hits the trainer', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'single', side: 'right', heights: 'high', showMs: 300 });
  run(300 + T.raiseMs + T.lateGraceMs + 300);
  run(5, [punch('right')]);
  run(250);
  assert.equal(act.drill.hits, 0);
  assert.equal(act.drill.trainerHits, 1);
  assert.equal(act.drill.expired, 1);
});

test('training-mitts: a claimed mitt is held until the glove arrives (and brought in to meet it)', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 260 });
  run(T.raiseMs + 240);         // ~20 ms before it would drop
  run(5, [punch('left')]);
  run(60);
  assert.equal(act.mitts.left.state, 'up', 'held for the incoming glove');
  const mv = act.getView().mitts.find((m) => m.side === 'left');
  assert(mv.claimed && mv.catchPos && mv.catchPos[0] > mv.pos[0], 'meets the glove nearer the centre line');
  run(200);
  assert.equal(act.drill.hits, 1);
});

test('training-mitts: a quick second punch into a just-hit mitt is absorbed (no points, no deduction)', () => {
  const { act, run, events } = rig();
  act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 });
  run(200);
  run(5, [punch('left')]);
  run(200);
  const after = act.score;
  assert(after > 0);
  run(5, [punch('left')]);   // jab-jab: the second one leaves as soon as the glove is back
  run(400);
  assert.equal(act.score, after);
  assert.equal(act.drill.trainerHits, 0);
  assert.equal(events('mitt-absorb').length, 1);
});

test('training-mitts: wrong height whiffs past the mitt with a hint (no deduction)', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'single', side: 'right', heights: 'low', showMs: 1500 });
  run(200);
  run(5, [punch('right', 'head')]);
  run(250);
  assert.equal(act.drill.hits, 0);
  assert.equal(act.drill.trainerHits, 0);
  assert.equal(act.drill.whiffs, 1);
  assert(act.getView().popups.some((p) => p.text === 'LOWER!'));
  run(200);                 // the whiffing glove has to come back first
  run(5, [punch('right', 'body')]);
  run(250);
  assert.equal(act.drill.hits, 1, 'body punch hits the low mitt');
});

test('training-mitts: both mitts up — hitting both earns the double bonus', () => {
  const { act, run, events } = rig();
  act.presentNow({ kind: 'both', heights: ['high', 'high'], showMs: 1500 });
  assert.equal(events('target-up').length, 2);
  run(200);
  run(5, [punch('left')]);
  run(150);
  run(5, [punch('right')]);
  run(250);
  assert.equal(act.drill.hits, 2);
  assert.equal(act.drill.doublesHit, 1);
  assert(act.getView().popups.some((p) => /DOUBLE/.test(p.text)));
  const pts = act.score;
  assert(pts >= 2 * S.base + S.both, `${pts}`);
});

test('training-mitts: "1-2" combo — the second mitt pops as soon as the first is hit', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'combo', side: 'left', heights: ['high', 'high'], showMs: 1500 });
  assert.equal(act.mitts.right.state, 'rest');
  run(150);
  run(5, [punch('left')]);
  run(250);
  assert(['raising', 'up'].includes(act.mitts.right.state), act.mitts.right.state);
  run(100);
  run(5, [punch('right')]);
  run(250);
  assert.equal(act.drill.hits, 2);
  assert.equal(act.combo, 2);
});

test('training-mitts: an expired mitt breaks the streak; streak bonus from 5 in a row', () => {
  const { act, run } = rig();
  const hitOne = () => {
    act.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1500 });
    run(800); run(5, [punch('left')]); run(700);
  };
  for (let i = 0; i < 5; i++) hitOne();
  assert.equal(act.combo, 5);
  const base = act.score;
  hitOne();
  assert(act.score - base >= S.base + S.streakBonus[0][1], 'streak bonus');
  act.presentNow({ kind: 'single', side: 'right', heights: 'high', showMs: 300 });
  run(1200);
  assert.equal(act.combo, 0);
});

test('training-mitts: full automatic drill ramps up and resolves once', () => {
  const bus = new EventBus();
  let ends = 0;
  bus.on(Ev.TRAIN_END, () => ends++);
  const act = new TargetPunching({ bus, rng: 5, readyMs: 0 });
  let now = 0;
  const shows = [];
  bus.on(Ev.TRAIN_EVENT, (e) => { if (e.type === 'target-up') shows.push({ t: e.t, ms: e.showMs }); });
  for (let i = 0; i < 64 * 60 && !act.isDone(); i++) { now += 1000 / 60; act.update(1 / 60, now, { control: control(), events: [] }); }
  assert(act.isDone());
  assert.equal(ends, 1);
  assert(shows.length > 20, `presented ${shows.length}`);
  const early = shows.filter((s) => s.t < 15000).map((s) => s.ms), late = shows.filter((s) => s.t > 45000).map((s) => s.ms);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert(avg(late) < avg(early) * 0.8, 'mitts stay up for less time later in the drill');
  assert.equal(act.getResult().score, 0, 'nobody punched');
  assert.equal(act.getResult().details.expired, act.getResult().details.mitts);
});

test('training-mitts: view lists both mitts with state, height, positions and countdown', () => {
  const { act, run } = rig();
  act.presentNow({ kind: 'single', side: 'right', heights: 'low', showMs: 1000 });
  run(400);
  const v = act.getView();
  assert.equal(v.mitts.length, 2);
  const r = v.mitts.find((m) => m.side === 'right');
  assert.equal(r.hand, 'left', "your right is the trainer's left hand");
  assert(r.live && r.up01 === 1 && r.height === 'low');
  assert(r.timeLeft01 > 0 && r.timeLeft01 < 1);
  approx(r.pos[1], MITTS_TUNING.mitt.lowY, 1e-9);
  const l = v.mitts.find((m) => m.side === 'left');
  assert(!l.live && l.up01 === 0);
  assert(v.trainer && v.trainer.pos && v.trainer.lookAt);
});

test('training-mitts: measured latency widens the late grace', () => {
  assert.equal(new TargetPunching({ latencyMs: 250 }).lateGraceMs(), 280);
  assert.equal(new TargetPunching({ latencyMs: 20 }).lateGraceMs(), T.lateGraceMs);
  assert.equal(new TargetPunching().lateGraceMs(), T.lateGraceMs);
});
