// Regression tests of the repair round's second pass on the "home" neutral (decision R1): forward / back has no
// absolute upright, so a home told apart from the adopted posture by the forward / back cues alone is on probation —
// a neutral learned in a sway at the bout start must never be kept as the home that real dodges toward it "come back"
// to for the rest of the bout; small steps toward or away from the camera are not held postures; and coming back
// upright after a held sideways lean at a different distance re-centres at once. Synthetic players, tracker noise
// 0.5 (the in-app feeder's) and 1 (realistic).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING as T } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

const lerp = (a, b, u) => a + (b - a) * u;
/** Blend two synthetic poses (image and world): a step from where `a` stands to where `b` stands. */
const blend = (a, b, u) => (!a || !b ? (u < 0.5 ? a : b) : { ...b,
  image: b.image.map((l, i) => ({ ...l, x: lerp(a.image[i].x, l.x, u), y: lerp(a.image[i].y, l.y, u) })),
  world: b.world.map((l, i) => ({ ...l, x: lerp(a.world[i].x, l.x, u), y: lerp(a.world[i].y, l.y, u), z: lerp(a.world[i].z, l.z, u) })) });
const dodgeOf = (a, l) => (a === 'lean-back' ? l.z <= -T.leanDodgeLevelZ : l.z >= T.leanDodgeLevelZ);
const anyDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX || l.y <= -T.duckDodgeLevel || Math.abs(l.z) >= T.leanDodgeLevelZ;
const sideDodge = (l) => Math.abs(l.x) >= T.leanDodgeLevelX;

test('repair R1: a neutral learned in a sway at the bout start is not a home for the rest of the bout — dodges toward it keep registering', () => {
  // the bout starts swayed back / forward (×0.5 and ×1) for 3 s (the neutral is learned there), then upright 5 s, then
  // 6 real dodges in that direction (1.2 s, 3 s apart). Before this pass every one of them was "a return home" and
  // eaten (0–47 % of their frames at dodge level against 40–76 % before the repair), with false dodges in 0.3–28 % of
  // the gaps. The first may still be taken for a return (the restore on probation); from the second on as before.
  for (const noise of [0.5, 1]) {
    for (const [start, amount] of [['lean-back', 0.5], ['lean-forward', 0.5], ['lean-back', 1]]) {
      let ok = 0, n = 0, gapN = 0, gapF = 0;
      for (let i = 0; i < 8; i++) {
        const o = randomPlayerOptions(3100 + i, { noise });
        const steps = [{ action: start, amount, ms: 3000 }, { action: 'guard-high', ms: 5000 }];
        const win = [];
        for (let k = 0, t = 8000; k < 6; k++, t += 4200) { steps.push({ action: start, ms: 1200 }, { action: 'guard-high', ms: 3000 }); win.push({ t0: t, t1: t + 1200, g1: t + 4200 }); }
        const gr = new GestureRecognizer();
        for (const f of makeSyntheticPlayer(o).frames(sequence(steps))) {
          const { control } = gr.update(f.players[0], f.t);
          win.forEach((w, k) => {
            if (k === 0) return;
            if (f.t >= w.t0 + 250 && f.t < w.t1) { n++; if (dodgeOf(start, control.lean)) ok++; }
            if (f.t >= w.t1 + 500 && f.t < w.g1) { gapN++; if (anyDodge(control.lean)) gapF++; }
          });
        }
      }
      const floor = noise === 0.5 ? 0.55 : 0.3;
      assert(ok / n >= floor, `noise ${noise}, neutral learned in ${start} ×${amount}: dodges 2–6 at dodge level in ${(100 * ok / n).toFixed(1)}% of their frames`);
      assert(gapF / gapN <= 0.01, `noise ${noise}, neutral learned in ${start} ×${amount}: false dodges in ${(100 * gapF / gapN).toFixed(2)}% of the gaps`);
    }
  }
});

test('repair R1: a step of 10–15 cm toward or away from the camera is not a held posture — forward / back dodges after it register', () => {
  // noise 1: the hip-relative depth wanders by a few cm, so a small step can show 3–7 cm of "sway" by itself. Before
  // this pass, back dodges after a 15 cm step forward were at dodge level in 33 % of their frames (45 % before the
  // repair) on these players.
  for (const d of [-0.15, -0.1, 0.1, 0.15]) {
    for (const dodge of ['lean-back', 'lean-forward']) {
      let ok = 0, n = 0, gapN = 0, gapF = 0;
      for (let i = 0; i < 12; i++) {
        const o = randomPlayerOptions(7700 + i, { noise: 1 });
        const steps = [{ action: 'guard-high', ms: 12000 }];
        const win = [];
        for (let k = 0, t = 12000; k < 3; k++, t += 4200) { steps.push({ action: dodge, ms: 1200 }, { action: 'guard-high', ms: 3000 }); win.push({ t0: t, t1: t + 1200, g1: t + 4200 }); }
        const seq = sequence(steps);
        const A = makeSyntheticPlayer(o), B = makeSyntheticPlayer({ ...o, distance: o.distance + d });
        const gr = new GestureRecognizer();
        for (const t of A.frameTimes(seq.totalMs)) {
          const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), Math.min(1, Math.max(0, (t - 6000) / 800))), t);
          for (const w of win) {
            if (t >= w.t0 + 250 && t < w.t1) { n++; if (dodgeOf(dodge, control.lean)) ok++; }
            if (t >= w.t1 + 500 && t < w.g1) { gapN++; if (anyDodge(control.lean)) gapF++; }
          }
        }
      }
      const floor = dodge === 'lean-back' ? 0.38 : 0.45;
      assert(ok / n >= floor, `step ${d} m, then ${dodge}: at dodge level in ${(100 * ok / n).toFixed(1)}% of the frames`);
      // (a step that the picture AND the depth both read as a sway — the synthetic camera re-aims at the new spot —
      // can still be taken for one: then at most the first dodge toward the old spot is a "return", briefly)
      assert(gapF / gapN <= 0.015, `step ${d} m, then ${dodge}: false dodges in ${(100 * gapF / gapN).toFixed(2)}% of the gaps`);
    }
  }
});

test('repair RV-INPUT-01: a sideways lean held 9 s, then upright 0.3 m nearer or farther, re-centres at once', () => {
  // the way back includes the step (blended over 600 ms, ending 0.4 s after the return). Before this pass the upright
  // pose read as a full lean for seconds (24–48 % of the frames from 0.5 s on at noise 0.5; before the repair 73–100 %).
  for (const noise of [0.5, 1]) {
    for (const action of ['lean-left', 'lean-right']) {
      for (const d of [0.3, -0.3]) {
        let bad = 0, n = 0, worst = 0;
        for (let i = 0; i < 8; i++) {
          const o = randomPlayerOptions(3100 + i, { noise });
          const tR = 13000;
          const seq = sequence([{ action: 'guard-high', ms: 4000 }, { action, ms: 9000 }, { action: 'guard-high', ms: 6000 }]);
          const A = makeSyntheticPlayer(o), B = makeSyntheticPlayer({ ...o, distance: o.distance + d });
          const gr = new GestureRecognizer();
          let run = 0;
          for (const t of A.frameTimes(seq.totalMs)) {
            const { control } = gr.update(blend(A.pose(t, seq), B.pose(t, seq), Math.min(1, Math.max(0, (t - (tR - 200)) / 600))), t);
            if (t < tR + 500) continue;
            n++;
            if (sideDodge(control.lean)) { bad++; run++; worst = Math.max(worst, run); } else run = 0;
          }
        }
        assert(bad / n <= 0.01 && worst <= 10, `noise ${noise}, ${action}, back ${d} m farther: |lean.x| ≥ 0.42 in ${(100 * bad / n).toFixed(2)}% of the frames from 0.5 s, longest ${worst} frames`);
      }
    }
  }
});
