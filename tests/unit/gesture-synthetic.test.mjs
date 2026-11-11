// Synthetic player generator (src/input/synthetic.js): conventions, determinism, noise model.
import { test, assert } from '../harness.mjs';
import { LM } from '../../src/core/types.js';
import {
  makeSyntheticPlayer, sequence, syntheticPoseFrames, randomPlayerOptions, fitsInFrame, SYNTH_ACTIONS,
} from '../../src/input/synthetic.js';

test('synthetic: PlayerPose shape (33 image + 33 world landmarks, score, aspect)', () => {
  const p = makeSyntheticPlayer({ seed: 1 }).pose(500, 'idle');
  assert(p && p.image.length === 33 && p.world.length === 33);
  for (const l of [...p.image, ...p.world]) assert(Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z) && l.visibility >= 0 && l.visibility <= 1);
  assert(p.score > 0.8 && p.score <= 1);
  assert(Math.abs(p.aspect - 4 / 3) < 1e-9);
});

test('synthetic: raw-camera conventions (person\'s right at smaller x, y down, world hip-centred)', () => {
  const p = makeSyntheticPlayer({ seed: 1, noise: 0 }).pose(500, 'idle');
  assert(p.image[LM.RIGHT_SHOULDER].x < p.image[LM.LEFT_SHOULDER].x, 'right shoulder at smaller image x');
  assert(p.image[LM.NOSE].y < p.image[LM.LEFT_SHOULDER].y, 'image y grows downward');
  assert(p.world[LM.NOSE].y < -0.4, 'world y grows downward (head is negative)');
  assert(p.world[LM.RIGHT_SHOULDER].x < 0 && p.world[LM.LEFT_SHOULDER].x > 0, 'world x follows image x');
  const hipMid = [(p.world[LM.LEFT_HIP].x + p.world[LM.RIGHT_HIP].x) / 2, (p.world[LM.LEFT_HIP].y + p.world[LM.RIGHT_HIP].y) / 2];
  assert(Math.hypot(...hipMid) < 0.01, 'world origin between the hips');
});

test('synthetic: a jab brings the wrist toward the camera (world z decreases, compressed)', () => {
  const sp = makeSyntheticPlayer({ seed: 1, noise: 0, zScale: 0.6 });
  const rel = (p) => p.world[LM.LEFT_WRIST].z - p.world[LM.LEFT_SHOULDER].z;
  const rest = rel(sp.pose(0, 'jab-left'));
  const peak = rel(sp.pose(sp.truth('jab-left').punches[0].tPeak, 'jab-left'));
  assert(peak < rest - 0.08, `wrist z ${rest.toFixed(3)} → ${peak.toFixed(3)}`);
  assert(rest - peak < 0.3, 'depth motion is compressed (MediaPipe-like)');
});

test('synthetic: deterministic by seed', () => {
  const a = makeSyntheticPlayer({ seed: 42 }).frames(sequence([{ action: 'jab-left', ms: 600 }]));
  const b = makeSyntheticPlayer({ seed: 42 }).frames(sequence([{ action: 'jab-left', ms: 600 }]));
  const c = makeSyntheticPlayer({ seed: 43 }).frames(sequence([{ action: 'jab-left', ms: 600 }]));
  assert.deepEqual(a, b);
  assert(JSON.stringify(a) !== JSON.stringify(c));
});

test('synthetic: frame timing is irregular but plausible (25–33 fps)', () => {
  for (const fps of [25, 30, 33]) {
    const sp = makeSyntheticPlayer({ seed: 3, fps });
    const fr = sp.frames(sequence([{ action: 'idle', ms: 4000 }]));
    for (let i = 1; i < fr.length; i++) assert(fr[i].t > fr[i - 1].t);
    const mean = (fr[fr.length - 1].t - fr[0].t) / (fr.length - 1);
    assert(mean > 1000 / fps && mean < 1.12 * 1000 / fps, `mean interval ${mean} at ${fps} fps`);
    const ints = fr.slice(1).map((f, i) => f.t - fr[i].t);
    assert(Math.max(...ints) - Math.min(...ints) > 0.1 * 1000 / fps, 'jitter present');
    assert(fr.every((f) => f.width === 640 && f.height === 480 && Array.isArray(f.players)));
  }
});

test('synthetic: ground truth matches the script', () => {
  const sp = makeSyntheticPlayer({ seed: 2, punchMs: 200 });
  const seq = sequence([{ action: 'idle', ms: 500 }, { action: 'cross', ms: 700 }, { action: 'hook-left', ms: 700 }, { action: 'body-right', ms: 700 }]);
  const t = sp.truth(seq);
  assert(t.punches.length === 3);
  assert.deepEqual(t.punches.map((p) => [p.hand, p.kind, p.target]), [['right', 'straight', 'head'], ['left', 'hook', 'head'], ['right', 'straight', 'body']]);
  for (const p of t.punches) assert(p.tPeak - p.tStart > 150 && p.tPeak - p.tStart < 260 && p.tEnd > p.tPeak);
  const rightLead = makeSyntheticPlayer({ seed: 2, lead: 'right' }).truth(sequence(['jab', 'cross']));
  assert.deepEqual(rightLead.punches.map((p) => p.hand), ['right', 'left'], 'jab / cross follow the lead hand');
});

test('synthetic: walk-away leaves the picture (pose becomes null)', () => {
  const fr = makeSyntheticPlayer({ seed: 5 }).frames(sequence([{ action: 'idle', ms: 800 }, { action: 'walk-away', ms: 3000 }]));
  assert(fr[5].players[0] !== null);
  assert(fr.slice(-10).every((f) => f.players[0] === null), 'gone at the end');
});

test('synthetic: mirrored camera mirrors x and swaps left/right labels', () => {
  const a = makeSyntheticPlayer({ seed: 1, noise: 0 }).pose(500, 'idle');
  const b = makeSyntheticPlayer({ seed: 1, noise: 0, mirrorCamera: true }).pose(500, 'idle');
  assert(Math.abs(b.image[LM.LEFT_WRIST].x - (1 - a.image[LM.RIGHT_WRIST].x)) < 1e-9);
  assert(Math.abs(b.world[LM.LEFT_WRIST].x + a.world[LM.RIGHT_WRIST].x) < 1e-9);
  // labels still look "normal" geometrically (RIGHT_* at smaller x) — only calibration can tell
  assert(b.image[LM.RIGHT_SHOULDER].x < b.image[LM.LEFT_SHOULDER].x);
});

test('synthetic: noise model — jitter, compressed noisy depth, glitches only when noisy', () => {
  const still = (noise) => makeSyntheticPlayer({ seed: 9, noise }).frames(sequence([{ action: 'guard-high', ms: 6000 }]));
  const jump = (frames, i) => {
    let mx = 0;
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1].players[0], b = frames[k].players[0];
      if (a && b) mx = Math.max(mx, Math.hypot(a.image[i].x - b.image[i].x, a.image[i].y - b.image[i].y));
    }
    return mx;
  };
  const clean = still(0), noisy = still(1);
  assert(jump(clean, LM.NOSE) < 0.004, 'noise-free is smooth');
  assert(jump(noisy, LM.NOSE) > 0.004, 'noisy has jitter');
  const zs = noisy.filter((f) => f.players[0]).map((f) => f.players[0].world[LM.LEFT_WRIST].z);
  const m = zs.reduce((a, b) => a + b, 0) / zs.length;
  const sdz = Math.sqrt(zs.reduce((a, b) => a + (b - m) ** 2, 0) / zs.length);
  assert(sdz > 0.02 && sdz < 0.08, `world z jitter σ ${sdz.toFixed(3)} m`);
});

test('synthetic: every action renders; unknown actions throw', () => {
  const sp = makeSyntheticPlayer({ seed: 4 });
  for (const a of SYNTH_ACTIONS) {
    const fr = sp.frames(sequence([{ action: 'idle', ms: 300 }, { action: a, ms: 900 }]));
    assert(fr.length > 20, a);
  }
  let threw = false;
  try { sequence([{ action: 'moonwalk' }]); } catch { threw = true; }
  assert(threw);
});

test('synthetic: random player options fit in the frame and vary widely', () => {
  const opts = Array.from({ length: 30 }, (_, i) => randomPlayerOptions(100 + i));
  for (const o of opts) assert(fitsInFrame(o), JSON.stringify(o));
  const span = (k) => Math.max(...opts.map((o) => o[k])) - Math.min(...opts.map((o) => o[k]));
  assert(span('distance') > 1 && span('cameraHeight') > 0.8 && span('punchMs') > 150 && span('bodyHeight') > 0.25);
  assert.deepEqual([...new Set(opts.map((o) => o.lead))].sort(), ['left', 'right'], 'left- and right-lead players');
});

test('synthetic: syntheticPoseFrames produces InputHub-ready PoseFrames at a start time', () => {
  const frames = syntheticPoseFrames('hook-right', { seed: 8, ms: 800, startMs: 10000 });
  assert(frames.length > 20 && frames[0].t === 10000);
  assert(frames.every((f) => f.players.length === 1 && f.width === 640));
});
