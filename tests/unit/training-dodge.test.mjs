// Dodging drill: throw timeline, dodge/hit determination with latency grace, streak scoring,
// aiming at the head, doubles that cover an escape, curve balls, end of drill.
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { DodgeDrill, DODGE_TUNING } from '../../src/training/dodge.js';
import { headWorld } from '../../src/training/activity.js';

const control = (x = 0, y = 0) => ({ tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x, y, z: 0 }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 });
const THROW_MS = DODGE_TUNING.throw.throwAnimMs;
const G = DODGE_TUNING.judge.graceMs;

function rig(opts = {}) {
  const bus = new EventBus();
  const log = [];
  bus.on('*', (name, payload) => log.push({ name, payload }));
  const act = new DodgeDrill({ bus, rng: 11, readyMs: 0, tuning: { throw: { firstDelayMs: 1e9 } }, ...opts });
  const clock = { now: 1000 };
  /** Advance until activity time `until`, with lean = leanAt(t). */
  const runTo = (until, leanAt = () => [0, 0], step = 1000 / 120) => {
    while (act.t < until - 1e-6) {
      clock.now += step;
      const [x, y] = leanAt(act.t + step);
      act.update(step / 1000, clock.now, { control: control(x, y), events: [] });
    }
  };
  runTo(20);
  const events = (type) => log.filter((e) => e.name === Ev.TRAIN_EVENT && e.payload.type === type);
  /** Throw now; returns {release, arrive} activity times. */
  const throwNow = (spec = {}) => {
    const plan = act.throwNow({ aimMs: 300, flightMs: 600, hand: 'right', ...spec });
    assert(plan, 'throw accepted');
    return { release: plan.release, arrive: plan.balls[0].arriveAt, plan };
  };
  return { act, log, events, runTo, throwNow };
}

test('training-dodge: standing still gets you hit — streak broken, flinch, no points', () => {
  const { act, runTo, throwNow, events } = rig();
  const { release, arrive } = throwNow();
  approx(release - act.t, 300 + THROW_MS, 20, 'aim + throw gesture before the release');
  runTo(release + 5);
  assert.equal(events('ball-throw').length, 1);
  assert.equal(act.getView().balls[0].state, 'flying');
  runTo(arrive + 10);
  assert.equal(act.getView().balls[0].state, 'contact', 'waits at your face during the grace period');
  runTo(arrive + G + 20);
  assert.equal(act.drill.hits, 1);
  assert.equal(act.score, 0);
  assert.equal(act.combo, 0);
  assert.equal(events('ball-hit').length, 1);
  assert(Array.isArray(events('ball-hit')[0].payload.pos));
  const pv = act.getView().playerView;
  assert(pv.hitReact && pv.hitReact.target === 'head', 'your boxer reacts');
  assert.equal(pv.phase, 'hitstun');
  assert(act.getView().popups.some((p) => p.text === 'OUCH!' && p.kind === 'bad'));
  assert.equal(pv.hp01, 1, 'training never costs health');
});

test('training-dodge: leaning out of the way before arrival is a dodge (+1)', () => {
  const { act, runTo, throwNow, events } = rig();
  const { release, arrive } = throwNow();
  runTo(arrive + 300, (t) => (t > release + 250 ? [1, 0] : [0, 0]));
  assert.equal(act.drill.dodged, 1);
  assert.equal(act.score, 1);
  assert.equal(events('ball-dodge').length, 1);
  assert.equal(events('ball-dodge')[0].payload.late, false);
  assert.equal(act.getView().balls[0].state, 'dodged');
});

test('training-dodge: a dodge the camera only sees within the grace window still counts (latency)', () => {
  const { act, runTo, throwNow, events } = rig();
  const { arrive } = throwNow();
  runTo(arrive + G + 200, (t) => (t >= arrive + G * 0.6 ? [-1, 0] : [0, 0]));
  assert.equal(act.drill.dodged, 1, 'late but in time');
  assert.equal(events('ball-dodge')[0].payload.late, true);
  assert(act.getView().popups.some((p) => p.text === 'JUST MADE IT!'));
});

test('training-dodge: a dodge after the grace window is too late', () => {
  const { act, runTo, throwNow } = rig();
  const { arrive } = throwNow();
  runTo(arrive + G + 300, (t) => (t >= arrive + G + 40 ? [1, 0] : [0, 0]));
  assert.equal(act.drill.hits, 1);
  assert.equal(act.drill.dodged, 0);
});

test('training-dodge: dodging too early and coming back before it arrives gets you hit', () => {
  const { act, runTo, throwNow } = rig();
  const { release, arrive } = throwNow();
  runTo(arrive + G + 100, (t) => (t > release + 50 && t < arrive - 200 ? [1, 0] : [0, 0]));
  assert.equal(act.drill.hits, 1);
});

test('training-dodge: a small lean is not enough; ducking works', () => {
  const a = rig();
  const t1 = a.throwNow();
  a.runTo(t1.arrive + G + 50, () => [0.3, 0]);
  assert.equal(a.act.drill.hits, 1, `|lean| 0.3 < clearRadius ${DODGE_TUNING.judge.clearRadius}`);
  const b = rig();
  const t2 = b.throwNow();
  b.runTo(t2.arrive + G + 50, (t) => (t > t2.release + 100 ? [0, -0.9] : [0, 0]));
  assert.equal(b.act.drill.dodged, 1);
});

test('training-dodge: the trainer aims where your head is at the release', () => {
  const { act, runTo, throwNow } = rig();
  const { release, arrive } = throwNow();
  // leaning right the whole time → the ball comes to the right → staying there gets you hit
  runTo(arrive + G + 50, () => [0.8, 0]);
  const b = act.getView().balls[0];
  approx(b.aim.x, 0.8, 0.01);
  const head = headWorld({ x: 0.8, y: 0 });
  approx(b.target[0], head[0], 1e-6);
  assert.equal(act.drill.hits, 1);
  // next one: lean right, then come back to centre after the release → dodge
  const n = throwNow();
  runTo(n.arrive + G + 50, (t) => (t > n.release + 150 ? [0, 0] : [0.8, 0]));
  assert.equal(act.drill.dodged, 1);
  void release;
});

test('training-dodge: the ball really reaches the target point at arrival (also curve balls)', () => {
  const { act, runTo, throwNow } = rig();
  const { arrive, plan } = throwNow({ curve: { amp: 0.45, dir: 1 } });
  const ball = plan.balls[0];
  runTo(plan.release + 300);
  const mid = act.getView().balls[0];
  assert(Math.abs(mid.pos[0] - mid.target[0]) > 0.1, 'bows out to one side mid-flight');
  runTo(arrive - 1000 / 120, () => [1, 0]);
  const p = [0, 0, 0];
  act._ballPos(ball, ball.arriveAt, p);
  approx(p[0], ball.C[0], 1e-6); approx(p[1], ball.C[1], 1e-6); approx(p[2], ball.C[2], 1e-6);
});

test('training-dodge: streaks — 5th dodge in a row is worth 2, 10th worth 3; a hit resets', () => {
  const { act, runTo, throwNow } = rig();
  const dodgeOne = (dir = 1) => { const s = throwNow(); runTo(s.arrive + G + 300, (t) => (t > s.release + 200 ? [dir, 0] : [0, 0])); };
  for (let i = 0; i < 4; i++) dodgeOne(i % 2 ? 1 : -1);
  assert.equal(act.score, 4);
  dodgeOne();
  assert.equal(act.score, 6, '5th dodge +2');
  assert.equal(act.combo, 5);
  assert(act.getView().popups.some((p) => p.text === '5 IN A ROW!'));
  for (let i = 0; i < 5; i++) dodgeOne(i % 2 ? 1 : -1);
  assert.equal(act.score, 6 + 4 * 2 + 3, '6th–9th +2, 10th +3');
  const s = throwNow();
  runTo(s.arrive + G + 300);
  assert.equal(act.combo, 0);
  assert.equal(act.score, 17, 'a hit costs the streak, not points (hitPenalty 0)');
  assert.equal(act.bestCombo, 10);
});

test('training-dodge: a double covers one escape — slipping into the cover ball gets you hit', () => {
  const { act, runTo, throwNow } = rig();
  // centred: the cover ball goes to one side; read which and go the other way
  const s = throwNow({ double: true, doubleGapMs: 200 });
  const [first, cover] = s.plan.balls;
  runTo(first.releaseAt + 2);
  runTo(cover.releaseAt + 2);
  const cov = act.getView().balls.find((b) => b.id === cover.id);
  assert(cov.aim && Math.abs(cov.aim.x) > 0.6, 'cover ball sits to one side');
  const wrong = Math.sign(cov.aim.x);
  runTo(Math.max(first.arriveAt, cover.arriveAt) + G + 100, () => [wrong, 0]);
  assert.equal(act.drill.dodged, 1, 'dodged the first ball');
  assert.equal(act.drill.hits, 1, '… straight into the second');
  // the open side clears both
  const s2 = throwNow({ double: true, doubleGapMs: 200 });
  runTo(s2.plan.balls[1].releaseAt + 2);
  const cov2 = act.getView().balls.find((b) => b.id === s2.plan.balls[1].id);
  const open = -Math.sign(cov2.aim.x - act.getView().balls.find((b) => b.id === s2.plan.balls[0].id).aim.x);
  runTo(Math.max(...s2.plan.balls.map((b) => b.arriveAt)) + G + 100, () => [open, 0]);
  assert.equal(act.drill.dodged, 3);
});

test('training-dodge: low cover ball — ducking is punished, a side lean clears both', () => {
  const { act, runTo, throwNow } = rig();
  const s = throwNow({ double: true, low: true, doubleGapMs: 150 });
  runTo(Math.max(...s.plan.balls.map((b) => b.arriveAt)) + G + 100, (t) => (t > s.release + 100 ? [0, -1] : [0, 0]));
  assert.equal(act.drill.hits, 1);
  const s2 = throwNow({ double: true, low: true, doubleGapMs: 150 });
  runTo(Math.max(...s2.plan.balls.map((b) => b.arriveAt)) + G + 100, (t) => (t > s2.release + 100 ? [1, 0] : [0, 0]));
  assert.equal(act.drill.dodged, 3);
});

test('training-dodge: full automatic drill — every ball is judged, nothing arrives after the bell', () => {
  const bus = new EventBus();
  let ends = 0;
  bus.on(Ev.TRAIN_END, () => ends++);
  const act = new DodgeDrill({ bus, rng: 99, readyMs: 500, durationMs: 30000 });
  let now = 0;
  for (let i = 0; i < 40 * 120 && !act.isDone(); i++) {
    now += 1000 / 120;
    const x = Math.sin(now / 300) > 0 ? 1 : -1;  // a frantic swayer
    act.update(1 / 120, now, { control: control(x, 0), events: [] });
  }
  assert(act.isDone());
  assert.equal(ends, 1);
  const d = act.getResult().details;
  assert(d.thrown >= 10, `thrown ${d.thrown}`);
  assert.equal(d.thrown, d.dodged + d.hits, 'every ball judged exactly once');
  assert(act.getResult().details.playedMs <= 30000);
  assert(act.getView().trainer && Array.isArray(act.getView().balls));
});

test('training-dodge: trainer view describes the telegraph for the renderer', () => {
  const { act, runTo, throwNow } = rig();
  const { release } = throwNow({ aimMs: 500 });
  runTo(act.t + 100);
  let tr = act.getView().trainer;
  assert.equal(tr.action, 'aim');
  assert(tr.holding.right && tr.msToRelease > 400);
  runTo(release - 100);
  tr = act.getView().trainer;
  assert.equal(tr.action, 'throw');
  runTo(release + 20);
  assert(!act.getView().trainer.holding.right, 'ball left the hand');
});

test('training-dodge: every telegraph (aim + throw) stays ≥ 0.7 s, even at full speed (mechanics §4.6)', () => {
  const P = DODGE_TUNING.throw;
  const worst = P.aimMs[1] * (1 - P.jitter) + P.throwAnimMs;
  assert(worst >= 700, `shortest wind-up ${worst.toFixed(0)} ms`);
  // and the automatic drill really schedules them that way
  const act = new DodgeDrill({ rng: 4, readyMs: 0 });
  let now = 0;
  const winds = [];
  for (let i = 0; i < 62 * 60 && !act.isDone(); i++) {
    now += 1000 / 60;
    act.update(1 / 60, now, null);
    if (act.plan && !winds.some((w) => w.id === act.plan.id)) winds.push({ id: act.plan.id, ms: act.plan.release - act.plan.aimStart });
  }
  assert(winds.length > 15);
  assert(Math.min(...winds.map((w) => w.ms)) >= 690, `min ${Math.min(...winds.map((w) => w.ms))}`);
});

test('training-dodge: the clear radius follows the match dodge threshold; measured latency widens the grace', () => {
  approx(DODGE_TUNING.judge.clearRadius, 0.45, 0.06);
  const slow = new DodgeDrill({ latencyMs: 260 });
  assert.equal(slow.graceMs(), 300);
  const fast = new DodgeDrill({ latencyMs: 40 });
  assert.equal(fast.graceMs(), DODGE_TUNING.judge.graceMs, 'never below the tuned grace');
  const fromCal = new DodgeDrill({ participant: { id: 'a', name: 'A', calibration: { latencyMs: 230 } } });
  assert.equal(fromCal.graceMs(), 270);
  // a dodge seen 250 ms after arrival counts for a 260 ms-latency player
  const bus = new EventBus();
  const act = new DodgeDrill({ bus, rng: 3, readyMs: 0, latencyMs: 260, tuning: { throw: { firstDelayMs: 1e9 } } });
  let now = 0;
  const step = (lean) => { now += 1000 / 120; act.update(1 / 120, now, { control: control(lean, 0), events: [] }); };
  for (let i = 0; i < 4; i++) step(0);
  const plan = act.throwNow({ aimMs: 300, flightMs: 600, hand: 'left' });
  const arrive = plan.balls[0].arriveAt;
  while (act.t < arrive + 250) step(0);
  while (act.t < arrive + 500) step(1);
  assert.equal(act.drill.dodged, 1);
});
