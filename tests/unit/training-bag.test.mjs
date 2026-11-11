// Bag practice: pendulum physics, reach, meeting bonus, combos, per-bag strength, chain snap,
// next bag, fallen-bag animation, partial-credit scoring.
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { BagPractice, BAG_TUNING } from '../../src/training/bag.js';

const control = () => ({ tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 });
const punch = (hand = 'right', kind = 'straight', target = 'head', power = 0.6) => ({ type: 'punch', t: 0, punch: { hand, kind, target, power, t: 0 } });

function rig(opts = {}) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, payload) => log.push({ name, payload }));
  const act = new BagPractice({ bus, rng: 3, readyMs: 0, ...opts });
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
  return { act, run, log, events: (type) => log.filter((e) => e.name === Ev.TRAIN_EVENT && e.payload.type === type) };
}

test('training-bag: a displaced bag swings with the pendulum period and settles (damped)', () => {
  const { act, run } = rig();
  act.swing.ax = 0.15; act.swing.vx = 0;
  const L = BAG_TUNING.rig.chainLen + BAG_TUNING.rig.bagLen / 2;
  const T = 2 * Math.PI * Math.sqrt(L / BAG_TUNING.physics.g);
  let crossings = [], prev = act.swing.ax, maxLater = 0;
  for (let i = 0; i < 720; i++) {           // 6 s at 120 Hz
    run(1000 / 120);
    const a = act.swing.ax;
    if (prev > 0 && a <= 0) crossings.push(act.t);
    if (act.t > 4000) maxLater = Math.max(maxLater, Math.abs(a));
    prev = a;
  }
  assert(crossings.length >= 2, 'it swings back and forth');
  approx(crossings[1] - crossings[0], T * 1000, 80, 'period');
  assert(maxLater < 0.15 * 0.5, `amplitude decays (${maxLater.toFixed(3)})`);
});

test('training-bag: a punch kicks the bag away, deals damage, scores partial credit', () => {
  const { act, run, events } = rig();
  const hp0 = act.bag.hp;
  run(10, [punch('right', 'straight', 'head', 0.6)]);
  run(200);
  assert(act.swing.vx > 0 || act.swing.ax > 0.01, 'swinging away from the player');
  assert(act.bag.hp < hp0);
  const hits = events('bag-hit');
  assert.equal(hits.length, 1);
  assert(Array.isArray(hits[0].payload.pos) && hits[0].payload.pos.length === 3);
  approx(hits[0].payload.pos[2], -0.35, 0.08, 'spark on the bag surface');
  assert.equal(act.score, act.scoreFor(0, act.bag.hp, act.bag.maxHp));
  assert(act.score > 0 && act.score < 100);
  run(400);
  assert(act.swing.ax > 0.02, 'it reached out away from the player');
});

test('training-bag: a bag swung far out of reach makes punches whiff (no damage, combo broken)', () => {
  const { act, run, events } = rig();
  act.combo = 3;
  act.swing.ax = 0.4; act.swing.vx = 0.05;   // far away and still going
  const hp0 = act.bag.hp;
  run(10, [punch('left')]);
  run(220);
  assert.equal(act.bag.hp, hp0);
  assert.equal(act.combo, 0);
  assert.equal(events('bag-miss').length, 1);
  assert(Array.isArray(events('bag-miss')[0].payload.pos), 'a miss streak needs a position');
  assert(act.getView().popups.some((p) => p.text === 'TOO FAR'));
});

test('training-bag: meeting the bag on its way back earns the timing bonus', () => {
  const a = rig(), b = rig();
  // same punch: on a still bag …
  a.run(10, [punch('right', 'straight', 'head', 0.6)]);
  a.run(220);
  // … and on a bag swinging back toward the player
  b.act.swing.ax = 0.06; b.act.swing.vx = -0.4;
  b.run(10, [punch('right', 'straight', 'head', 0.6)]);
  b.run(220);
  const da = a.act.lastHit.damage, db = b.act.lastHit.damage;
  assert(!a.act.lastHit.meet && b.act.lastHit.meet, 'only the approaching bag is "met"');
  approx(db / da, BAG_TUNING.hit.meetMul, 0.05);
  assert(b.act.getView().popups.some((p) => p.text === 'NICE TIMING!'));
  assert(b.act.swing.vx > 0, 'the meeting punch sends it back out');
});

test('training-bag: combos build within the gap and reset after a pause', () => {
  const { act, run } = rig();
  // (the bag is reset between punches so every one connects cleanly — this checks the combo rule only)
  for (let i = 0; i < 3; i++) { act.swing = { ax: 0, vx: 0, az: 0, vz: 0, yaw: 0, vyaw: 0 }; run(10, [punch(i % 2 ? 'left' : 'right')]); run(300); }
  assert.equal(act.combo, 3);
  run(BAG_TUNING.combo.gapMs + 200);
  run(10, [punch('right')]);
  run(250);
  assert.equal(act.combo, 1, 'a pause longer than the gap starts a new combo');
  assert(act.bestCombo >= 3);
});

test('training-bag: at 0 strength the chain snaps, the bag falls, the next tougher bag is lowered in', () => {
  const { act, run, events } = rig();
  act.bag.hp = 1;
  run(10, [punch('right')]);
  run(200);
  assert.equal(act.bagsDone, 1);
  assert.equal(act.score, 100);
  assert.equal(events('bag-break').length, 1);
  assert(act.getView().popups.some((p) => p.text === 'BAG 1 DOWN!' && p.kind === 'break'));
  assert.equal(act.bag.n, 2);
  assert(act.bag.maxHp > act.hpFor(1), 'tougher');
  assert.equal(act.bag.state, 'waiting');
  assert(!act.hittable());
  // a punch into thin air between bags: no penalty, combo untouched
  const combo = act.combo;
  run(10, [punch('left')]);
  run(200);
  assert.equal(act.combo, combo);
  const waitStart = act.t;
  while (act.bag.state === 'waiting' && act.t - waitStart < 2000) run(10);
  assert(act.t - waitStart < BAG_TUNING.bags.nextDropDelayMs + 20, 'the next bag comes down soon after the snap');
  assert.equal(act.bag.state, 'dropping');
  assert.equal(events('bag-new').length, 1);
  assert(act.dropOffset() > 0.2, 'coming down from above');
  run(BAG_TUNING.bags.dropMs + 50);
  assert.equal(act.bag.state, 'hanging');
  assert(Math.abs(act.dropOffset()) < 1e-9);
  assert(act.hittable());
});

test('training-bag: the dropped bag falls, topples away from the player, rolls aside and fades', () => {
  const { act, run } = rig();
  act.bag.hp = 1;
  run(10, [punch('right')]);
  run(150);
  const f = act.fallen[0];
  assert(f && f.state === 'falling');
  const states = new Set();
  let minY = Infinity;
  for (let i = 0; i < 400 && act.fallen.length; i++) {
    run(10);
    if (act.fallen[0]) { states.add(act.fallen[0].state); minY = Math.min(minY, act.fallen[0].y); }
  }
  assert(states.has('tipping') && states.has('lying'), [...states].join());
  assert(minY >= BAG_TUNING.rig.radius - 1e-6, 'never sinks into the canvas');
  assert.equal(act.fallen.length, 0, 'removed after its life');
  // view shape for the renderer
  act.bag.hp = 1;
  run(10, [punch('left')]);
  run(900);
  const fv = act.getView().bag.fallen[0];
  assert(fv && Number.isFinite(fv.tilt) && fv.tilt < -0.3, 'toppling away from the player (top toward −Z)');
});

test('training-bag: partial credit = 100 per bag + % of the current bag knocked out', () => {
  const { act } = rig();
  assert.equal(act.scoreFor(0, 90, 90), 0);
  assert.equal(act.scoreFor(0, 45, 90), 50);
  assert.equal(act.scoreFor(3, 1, 100), 399);
  assert.equal(act.scoreFor(2, 0, 100), 300);
  assert(act.hpFor(2) > act.hpFor(1) && act.hpFor(5) > act.hpFor(4));
});

test('training-bag: result details report bags and partial credit', () => {
  const { act, run } = rig({ durationMs: 3000 });
  act.bag.hp = 1;
  run(10, [punch('right')]);
  run(2000);
  run(10, [punch('left')]);
  run(1500);
  assert(act.isDone());
  const r = act.getResult();
  assert.equal(r.details.bags, 1);
  assert(r.details.partial01 > 0 && r.details.partial01 < 1);
  assert(r.score > 100 && r.score < 200, `one bag and part of the next (${r.score})`);
  assert(Math.abs(r.score - 100 - r.details.partial01 * 100) <= 1);
  assert.equal(r.details.punches, 2);
});

test('training-bag: view carries everything the renderer and bots need', () => {
  const { act } = rig();
  const v = act.getView();
  assert.equal(v.kind, 'bag');
  for (const k of ['n', 'tier', 'state', 'hp', 'maxHp', 'hp01', 'drop01', 'swing', 'rig', 'reachD', 'approach', 'hittable', 'fallen', 'hitFlash']) assert(k in v.bag, k);
  assert(v.bag.inReach);
  assert(v.playerView && v.playerView.id === 'p1');
});
