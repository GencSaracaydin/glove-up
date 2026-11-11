// Regression tests of item 15 (the place the player boxes at, see neutralPlaceMs in src/input/gesture.js): the neutral
// ("upright" head position) of a player who never stands still for the steadiness test follows a sideways step taken in
// the middle of a combo, so the new spot stops reading as a side dodge. Held dodges (a sideways lean with the shoulders
// tilted, a duck) held WHILE punching still read as dodges, and the return from them never does (decision R1).
// Synthetic 'real-like' players at 1.5 m. Before item 15 the step test failed: the neutral stayed at the old spot for the
// rest of the bout.
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING as T } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions, mulberry32 } from '../../src/input/synthetic.js';

const lerp = (a, b, u) => a + (b - a) * u;
/** Blend two synthetic poses (image and world): a step from where `a` stands to where `b` stands. */
const blend = (a, b, u) => (u <= 0 ? a : u >= 1 ? b : (!a || !b ? (u < 0.5 ? a : b) : { ...b,
  image: b.image.map((l, i) => ({ ...l, x: lerp(a.image[i].x, l.x, u), y: lerp(a.image[i].y, l.y, u) })),
  world: b.world.map((l, i) => ({ ...l, x: lerp(a.world[i].x, l.x, u), y: lerp(a.world[i].y, l.y, u), z: lerp(a.world[i].z, l.z, u) })) }));

const sideDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX;
const anyDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX || l.y <= -T.duckDodgeLevel || Math.abs(l.z) >= T.leanDodgeLevelZ;
const PUNCHES = ['jab', 'cross', 'hook-left', 'hook-right', 'uppercut-left', 'uppercut-right', 'body-left', 'body-right'];

/** Boxing that never stands still for long: a punch every 400–1000 ms, now and then a guard pause of at most 500 ms. */
function boxing(rand, ms) {
  const steps = [];
  let t = 0;
  while (t < ms) {
    const g = 400 + 600 * rand();
    steps.push({ action: PUNCHES[Math.floor(rand() * PUNCHES.length) % PUNCHES.length], ms: g });
    t += g;
    if (rand() < 0.3) { const p = 100 + 400 * rand(); steps.push({ action: 'guard-high', ms: p }); t += p; }
  }
  return steps;
}

/** The player stands as `A` until `tShift`, then moves to where `B` stands over 700 ms; the lean of every frame. */
function runShift(o, A, B, steps, tShift) {
  const seq = sequence(steps);
  const pa = makeSyntheticPlayer({ ...o, ...A }), pb = makeSyntheticPlayer({ ...o, ...B });
  const gr = new GestureRecognizer();
  const rows = [];
  for (const t of pa.frameTimes(seq.totalMs)) {
    const a = pa.pose(t, seq);
    const pose = t < tShift ? a : blend(a, pb.pose(t, seq), Math.min(1, (t - tShift) / 700));
    rows.push({ t, lean: gr.update(pose, t).control.lean });
  }
  return rows;
}

test('item 15: a sideways step in the middle of a combo is followed — the new spot stops reading as a side dodge', () => {
  for (const seed of [3, 4]) {
    const o = { ...randomPlayerOptions(1600 + seed, { preset: 'real-like', distance: 1.5 }), bounce: 3 };
    const step = (seed === 3 ? 1 : -1) * 0.25;
    const script = () => [{ action: 'guard-high', ms: 3000 }, ...boxing(mulberry32(1600 + seed), 30000)];
    // the same bout without the step: the share of side-dodge-level frames the punches alone give (the floor)
    const share = (rows) => { const late = rows.filter((r) => r.t >= 15000 + 8000); return late.filter((r) => sideDodge(r.lean)).length / late.length; };
    const floor = share(runShift(o, {}, {}, script(), Infinity));
    const moved = share(runShift(o, {}, { lateral: (o.lateral || 0) + step }, script(), 15000));
    assert(moved - floor < 0.08, `seed ${seed}, step ${step} m: |lean.x| ≥ 0.42 in ${(100 * moved).toFixed(1)} % of the frames from 8 s after the step (${(100 * floor).toFixed(1)} % without the step)`);
  }
});

test('item 15: hands down while waiting, then a lean or a duck held right after the guard comes up — a dodge while held, never on the return (R1)', () => {
  // (the bout start: the player waits with the hands down, raises the guard at the bell and dodges within a second; the
  // first steady window in guard is then the dodge itself — it must not become the neutral)
  for (const [action, amount] of [['lean-left', 1.5], ['lean-right', 1.5], ['duck', 1.2]]) {
    for (const seed of [1, 2]) {
      const o = randomPlayerOptions(1700 + seed, { preset: 'real-like', distance: 1.5 });
      const tA = 4000 + 300, tB = tA + 3000;
      const rows = runShift(o, {}, {}, [{ action: 'arms-down', ms: 4000 }, { action: 'guard-high', ms: 300 }, { action, amount, ms: 3000 }, { action: 'guard-high', ms: 6000 }], Infinity);
      const at = (l) => (action === 'lean-left' ? l.x <= -T.leanDodgeLevelX : action === 'lean-right' ? l.x >= T.leanDodgeLevelX : l.y <= -T.duckDodgeLevel);
      const hold = rows.filter((r) => r.t >= tA + 500 && r.t < tB);
      const share = hold.filter((r) => at(r.lean)).length / hold.length;
      assert(share >= 0.5, `${action} held 3 s right after the guard came up, seed ${seed}: at the dodge level in only ${(100 * share).toFixed(0)} % of the hold`);
      const bad = rows.filter((r) => r.t >= tB + 500 && anyDodge(r.lean));
      assert(bad.length === 0, `${action} held 3 s right after the guard came up, seed ${seed}: ${bad.length} dodge-level frames after the return (first: ${bad[0] && JSON.stringify(bad[0].lean)})`);
    }
  }
});

test('item 15: a tilted sideways lean or a duck held while punching stays a dodge, and the return from it never reads as one', () => {
  for (const [action, holdMs] of [['lean-left', 4000], ['lean-right', 4000], ['duck', 3000]]) {
    for (const seed of [5, 6]) {
      const o = randomPlayerOptions(1700 + seed, { preset: 'real-like', distance: 1.5 });
      const rand = mulberry32(1700 + seed);
      // the posture first, then punches thrown from it (the head stays in the posture between them)
      const steps = [{ action: 'guard-high', ms: 4000 }, { action, ms: 400 }];
      let t = 400;
      while (t < holdMs - 300) {
        const g = Math.min(500 + 400 * rand(), holdMs - t);
        steps.push({ action: PUNCHES[Math.floor(rand() * 4)], ms: g });
        t += g;
      }
      if (t < holdMs) steps.push({ action, ms: holdMs - t });
      steps.push({ action: 'guard-high', ms: 6000 });
      const rows = runShift(o, {}, {}, steps, Infinity);
      const at = (l) => (action === 'lean-left' ? l.x <= -T.leanDodgeLevelX : action === 'lean-right' ? l.x >= T.leanDodgeLevelX : l.y <= -T.duckDodgeLevel);
      // (a punch thrown from the posture pulls the head back toward the guard for a moment: most of the hold, not all of it)
      const hold = rows.filter((r) => r.t >= 4000 + 250 && r.t <= 4000 + holdMs);
      const share = hold.filter((r) => at(r.lean)).length / hold.length;
      assert(share >= 0.4, `${action} held ${holdMs / 1000} s while punching, seed ${seed}: at the dodge level in only ${(100 * share).toFixed(0)} % of the hold`);
      const after = rows.filter((r) => r.t >= 4000 + holdMs + 500);
      const bad = after.filter((r) => anyDodge(r.lean));
      assert(bad.length === 0, `${action} held ${holdMs / 1000} s while punching, seed ${seed}: ${bad.length} dodge-level frames after the return (first at ${bad[0] && Math.round(bad[0].t - 4000 - holdMs)} ms: ${bad[0] && JSON.stringify(bad[0].lean)})`);
    }
  }
});
