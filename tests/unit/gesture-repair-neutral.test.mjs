// Regression tests of the repair round for held postures (decision R1; RV-INPUT-01 and RV-INPUT-02): a lean,
// a duck or a back lean held long enough to become the neutral is undone as soon as the player is back upright
// ("home"), so coming back never reads as a dodge — while steps, a neutral learned in a lean and real dodges
// keep working. Synthetic players with tracker noise 0.5 (the in-app feeder's) and 1 (realistic).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING as T } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const lerp = (a, b, u) => a + (b - a) * u;
/** Blend two synthetic poses (image and world): a step from where `a` stands to where `b` stands. */
const blend = (a, b, u) => (!a || !b ? (u < 0.5 ? a : b) : { ...b,
  image: b.image.map((l, i) => ({ ...l, x: lerp(a.image[i].x, l.x, u), y: lerp(a.image[i].y, l.y, u) })),
  world: b.world.map((l, i) => ({ ...l, x: lerp(a.world[i].x, l.x, u), y: lerp(a.world[i].y, l.y, u), z: lerp(a.world[i].z, l.z, u) })) });

const sideDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX;
const anyDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX || l.y <= -T.duckDodgeLevel || Math.abs(l.z) >= T.leanDodgeLevelZ;

/** 4 s of guard, `action` held `holdMs`, then upright in a guard for `postMs`: the lean from `graceMs` after the return. */
function holdThenUpright(o, action, holdMs, { postMs = 6000, graceMs = 500, amount = 1 } = {}) {
  const tR = 4000 + holdMs;
  const fr = makeSyntheticPlayer(o).frames(sequence([{ action: 'guard-high', ms: 4000 }, { action, amount, ms: holdMs }, { action: 'guard-high', ms: postMs }]));
  const gr = new GestureRecognizer();
  const after = [];
  for (const f of fr) {
    const { control } = gr.update(f.players[0], f.t);
    if (f.t >= tR + graceMs) after.push({ t: f.t - tR, lean: control.lean });
  }
  return after;
}

/** The longest run of consecutive frames for which `pred` holds. */
const longestRun = (rows, pred) => { let best = 0, run = 0; for (const r of rows) { run = pred(r.lean) ? run + 1 : 0; best = Math.max(best, run); } return best; };

test('repair RV-INPUT-01: a sideways lean held 9 or 12 s, then upright, is never a dodge from 0.5 s after the return', () => {
  for (const noise of [0.5, 1]) {
    for (const action of ['lean-left', 'lean-right']) {
      for (const holdMs of [9000, 12000]) {
        for (let i = 0; i < 4; i++) {
          const o = randomPlayerOptions(3100 + i, { noise });
          const bad = holdThenUpright(o, action, holdMs).filter((r) => sideDodge(r.lean));
          assert(bad.length === 0, `noise ${noise}, ${action} held ${holdMs / 1000} s, player ${i}: |lean.x| ≥ 0.42 in ${bad.length} frames after the return (first at ${bad[0] && Math.round(bad[0].t)} ms, x ${bad[0] && bad[0].lean.x.toFixed(2)})`);
        }
      }
    }
  }
});

test('repair RV-INPUT-02: a duck or a back lean held 3 or 5 s, then upright, gives no dodge-level lean from 0.5 s after the return', () => {
  // noise 0.5: not a single frame on any axis
  for (const action of ['duck', 'lean-back']) {
    for (const holdMs of [3000, 5000]) {
      for (let i = 0; i < 6; i++) {
        const o = randomPlayerOptions(3100 + i, { noise: 0.5 });
        const bad = holdThenUpright(o, action, holdMs, { postMs: 5000 }).filter((r) => anyDodge(r.lean));
        assert(bad.length === 0, `noise 0.5, ${action} held ${holdMs / 1000} s, player ${i}: ${bad.length} dodge-level frames after the return (first at ${bad[0] && Math.round(bad[0].t)} ms: ${bad[0] && JSON.stringify(bad[0].lean)})`);
      }
    }
  }
  // noise 1: the forward/back cues jitter by several cm (and the tracker's depth wanders by a few), so an isolated
  // one- to three-frame blip can happen at any time (as when standing still), and for a player whose picture and
  // depth disagree while the posture is held there is no home to come back to (as before the repair). Three seed
  // blocks, 8 players each: before this repair 15–40 % of the frames and 14–20 of 24 players had the sustained
  // false back / forward dodge of a stale neutral.
  for (const action of ['duck', 'lean-back']) {
    for (const holdMs of [3000, 5000]) {
      let n = 0, bad = 0, sustained = 0;
      for (const block of [3100, 7700, 9300]) {
        for (let i = 0; i < 8; i++) {
          const o = randomPlayerOptions(block + i, { noise: 1 });
          const rows = holdThenUpright(o, action, holdMs, { postMs: 5000 });
          n += rows.length; bad += rows.filter((r) => anyDodge(r.lean)).length;
          if (longestRun(rows, anyDodge) > 4) sustained++;
        }
      }
      assert(bad / n < 0.03, `noise 1, ${action} held ${holdMs / 1000} s: ${(100 * bad / n).toFixed(1)}% of the frames after the return at a dodge level`);
      assert(sustained <= 3, `noise 1, ${action} held ${holdMs / 1000} s: ${sustained} of 24 players with a sustained false dodge after the return`);
    }
  }
});

test('repair R1: home follows a step — after a sideways step, a lean held 9 s and then upright reads upright', () => {
  for (const noise of [0.5, 1]) {
    for (let i = 0; i < 4; i++) {
      const o = randomPlayerOptions(8800 + i, { noise });
      const seq = sequence([{ action: 'guard-high', ms: 9000 }, { action: 'lean-right', ms: 9000 }, { action: 'guard-high', ms: 6000 }]);
      const A = makeSyntheticPlayer(o), B = makeSyntheticPlayer({ ...o, lateral: o.lateral + (o.lateral > 0 ? -0.3 : 0.3) });
      const gr = new GestureRecognizer();
      let bad = 0;
      for (const t of A.frameTimes(seq.totalMs)) {
        const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), Math.min(1, Math.max(0, (t - 3000) / 800))), t);
        if (t >= 18500 && sideDodge(control.lean)) bad++;
      }
      assert(bad === 0, `noise ${noise}, player ${i}: ${bad} side-dodge frames after coming back upright at the new spot`);
    }
  }
});

test('repair R1: a neutral learned in a lean is never brought back; the upright it was re-centred to is', () => {
  // the bout starts in a lean (weight on one leg), then upright 12 s (re-centred), then a real lean held 8 s and upright
  for (let i = 0; i < 4; i++) {
    const o = randomPlayerOptions(4100 + i, { noise: 0.5 });
    const fr = makeSyntheticPlayer(o).frames(sequence([{ action: 'lean-left', amount: 0.7, ms: 2500 }, { action: 'guard-high', ms: 12000 },
      { action: 'lean-left', ms: 8000 }, { action: 'guard-high', ms: 6000 }]));
    const gr = new GestureRecognizer();
    let bad = 0, homeOverLean = 0;
    for (const f of fr) {
      const { control } = gr.update(f.players[0], f.t);
      // while the first upright is being adopted, the learned lean must not be kept as "home"
      if (f.t > 3000 && f.t < 14500 && gr.debug.home) homeOverLean++;
      if (f.t >= 23000 && sideDodge(control.lean)) bad++;
    }
    assert(homeOverLean === 0, `player ${i}: the neutral learned in a lean was kept as home (${homeOverLean} frames)`);
    assert(bad === 0, `player ${i}: ${bad} side-dodge frames after the real lean was held and released`);
  }
});

test('repair R1: steps are not held postures — no home is kept, and dodges after them still register', () => {
  for (const [name, mk] of [['0.3 m to the side', (o) => ({ lateral: o.lateral + 0.3 })], ['0.4 m back', (o) => ({ distance: o.distance + 0.4 })], ['0.3 m forward', (o) => ({ distance: o.distance - 0.3 })]]) {
    for (let i = 0; i < 3; i++) {
      const o = randomPlayerOptions(5600 + i, { noise: 1 });
      const seq = sequence([{ action: 'guard-high', ms: 8000 }, { action: 'lean-left', ms: 600 }, { action: 'guard-high', ms: 1500 }, { action: 'duck', ms: 600 }, { action: 'guard-high', ms: 1500 }]);
      const A = makeSyntheticPlayer(o), B = makeSyntheticPlayer({ ...o, ...mk(o) });
      const gr = new GestureRecognizer();
      let kept = 0, leanMin = 0, duckMin = 0;
      for (const t of A.frameTimes(seq.totalMs)) {
        const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), Math.min(1, Math.max(0, (t - 2000) / 800))), t);
        if (t > 3000 && t < 8000 && gr.debug.home) kept++;
        if (t >= 8000 && t < 8900) leanMin = Math.min(leanMin, control.lean.x);
        if (t >= 10100 && t < 11000) duckMin = Math.min(duckMin, control.lean.y);
      }
      assert(kept === 0, `step ${name}, player ${i}: a home was kept for ${kept} frames after the step`);
      assert(leanMin <= -T.leanDodgeLevelX && duckMin <= -T.duckDodgeLevel, `step ${name}, player ${i}: dodges after the step reached x ${leanMin.toFixed(2)} y ${duckMin.toFixed(2)}`);
    }
  }
});
