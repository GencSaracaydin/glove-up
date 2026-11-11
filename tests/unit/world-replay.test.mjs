// View3d / bout outro: the replay recorder (render/replay.js) and the outro timeline
// (ARCHITECTURE §6.5, research/mechanics.md §6 "KO outro, in order"), plus the screen overlays.
import { test, assert, approx } from '../harness.mjs';
import { ViewRecorder, planOutro, makeSnap, writeSnap, lerpSnap, makeViewOut, snapToView, REPLAY_TUNING, OUTRO_TUNING } from '../../src/render/replay.js';
import { ScreenFX } from '../../src/render/screen-fx.js';

const slots = { p1: { pos: { x: 0, y: 0, z: 0.575 }, yaw: Math.PI }, p2: { pos: { x: 0, y: 0, z: -0.575 }, yaw: 0 } };
const view = (phase, extra = {}) => ({
  p1: { phase: 'guard', lean: { x: 0.1, y: 0, z: 0 }, isHuman: true, hp01: 1, hp: 10, hands: { left: { x: -0.3, y: 0.6, reach: 0.1 }, right: { x: 0.3, y: 0.6, reach: 0.1 } } },
  p2: { phase, lean: { x: 0, y: 0, z: 0 }, hp01: 0.2, hp: 2, punches: [{ id: 4, hand: 'right', kind: 'hook', target: 'head', stage: 'travel', progress: 0.5, power: 1 }], ...extra },
});

test('replay: the recorder is a fixed ring buffer (no growth) holding ~6 s', () => {
  const r = new ViewRecorder();
  const frames = r.frames, cap = r.cap;
  for (let i = 0; i < 2000; i++) r.record(1 / 60, 1 / 60, slots, view('idle'));
  assert.equal(r.frames, frames, 'same storage');
  assert.equal(r.frames.length, cap);
  assert.equal(r.count, cap);
  assert(cap >= REPLAY_TUNING.seconds * 60, `holds ≥ ${REPLAY_TUNING.seconds} s at 60 fps`);
});

test('replay: the clip around a knockdown blow survives the count and keeps the fall', () => {
  const r = new ViewRecorder();
  for (let i = 0; i < 300; i++) r.record(1 / 60, 1 / 60, slots, view('punch'));
  r.event('hit', { x: 0, y: 1.2, z: -0.3 }, { attacker: 'p1', defender: 'p2', knockdown: true });
  r.markBlow({ attacker: 'p1', defender: 'p2' });
  // 0.7 s hit-stop (game time barely moves), then the fall, then a long count
  for (let i = 0; i < 42; i++) r.record(1 / 60, (1 / 60) * 0.02, slots, view('down'));
  for (let i = 0; i < 900; i++) r.record(1 / 60, 1 / 60, slots, view('down'));
  const c = r.latestClip();
  assert(c && c.count > 100, 'a clip was stored');
  approx(c.blowTau - c.tau0, REPLAY_TUNING.pre, 0.05, 'keeps the lead-up');
  assert(c.tau1 - c.blowTau >= REPLAY_TUNING.post - 0.05, 'and the fall after the blow');
  assert(c.eventCount >= 1 && c.events[0].knockdown, 'the knockdown hit is replayable');
  const o = {};
  r.sample(c.blowTau - 1, o);
  assert.equal(o.a.snap.p2.phase, 'punch');
  r.sample(c.blowTau + 1, o);
  assert.equal(o.a.snap.p2.phase, 'down');
  assert(o.t >= 0 && o.t <= 1);
});

test('replay: snapshots copy what the model reads and interpolate safely', () => {
  const a = makeSnap(), b = makeSnap(), out = makeSnap();
  writeSnap(a, { phase: 'punch', phaseProgress: 0.2, lean: { x: 0, y: 0, z: 0 }, hands: { left: { x: 0, y: 0, reach: 0 }, right: { x: 1, y: 0, reach: 0.2 } },
    punches: [{ id: 1, hand: 'right', kind: 'hook', stage: 'travel', progress: 0.2 }], hitReact: { hand: 'left', kind: 'straight', age: 0.25 } });
  writeSnap(b, { phase: 'punch', phaseProgress: 0.6, lean: { x: 1, y: 0, z: 0 }, hands: { left: { x: 0, y: 0, reach: 0 }, right: { x: 1, y: 0, reach: 1 } },
    punches: [{ id: 1, hand: 'right', kind: 'hook', stage: 'travel', progress: 0.6 }], hitReact: { hand: 'left', kind: 'straight', age: 0.0 } });
  lerpSnap(out, a, b, 0.25);
  approx(out.phaseProgress, 0.3, 1e-9); approx(out.lean.x, 0.25, 1e-9); approx(out.hands.right.reach, 0.4, 1e-9);
  approx(out.punches[0].progress, 0.3, 1e-9);
  approx(out.hitReact.age, 0.25, 1e-9, 'a new hit (age reset) is not blended — the model must see one impact');
  const v = snapToView(makeViewOut(), out);
  assert(v.punches.length === 1 && v.hands === out.hands && v.hitReact);
  writeSnap(a, { phase: 'idle' });
  assert(snapToView(makeViewOut(), a).punches === null && snapToView(makeViewOut(), a).hands === null);
});

test('outro: KO plan — start, wipe, flash, replay (side, low, overhead at ~0.2×; 6–9 s; the fall ~3 s), banner, winner, end', () => {
  const clip = { tau0: 10 - REPLAY_TUNING.pre, tau1: 10 + REPLAY_TUNING.post, blowTau: 10 };
  const p = planOutro({ ko: true, clip });
  assert.deepEqual(p.stages.map((s) => s.stage), ['start', 'wipe', 'flash', 'replay', 'banner', 'winner', 'end']);
  for (let i = 1; i < p.stages.length; i++) assert(p.stages[i].at >= p.stages[i - 1].at, 'in order');
  assert.deepEqual(p.replay.map((r) => r.angle), ['side', 'low', 'overhead']);
  const replay = p.bannerAt - p.replay[0].at;
  assert(replay >= 6 && replay <= 9, `replay ${replay.toFixed(2)} s`);
  const blowSeg = p.replay.find((r) => r.from < 0 && r.to > 0);
  approx(blowSeg.speed, 0.2, 0.01, 'the final blow at ~0.2×');
  const fall = p.replay[p.replay.length - 1];
  assert(fall.dur >= 2.5 && fall.dur <= 3.5, `the fall takes ~3 s (${fall.dur.toFixed(2)})`);
  assert(p.winnerAt - p.bannerAt >= 3 && p.winnerAt - p.bannerAt <= 5, 'win banner 3–5 s');
  const winner = p.stages.find((s) => s.stage === 'end').at - p.winnerAt;
  assert(winner >= 3 && winner <= 4, 'winner pose 3–4 s');
  assert(p.fade && Math.abs(p.fade.at + p.fade.dur / 2 - p.bannerAt) < 1e-9, 'the white fade peaks as the banner is staged');
});

test('outro: decision / draw skip the wipe and the replay; no clip → no replay; fast ≤ 1.5 s; reduced motion is short', () => {
  const d = planOutro({ ko: false });
  assert.deepEqual(d.stages.map((s) => s.stage), ['start', 'flash', 'banner', 'winner', 'end']);
  assert.equal(d.wipe, null); assert.equal(d.replay.length, 0);
  const noClip = planOutro({ ko: true, clip: null });
  assert(!noClip.stages.some((s) => s.stage === 'replay'), 'resolves without a recorded clip');
  const clip = { tau0: 7, tau1: 12, blowTau: 10 };
  for (const ko of [true, false]) {
    const f = planOutro({ ko, clip, fast: true });
    assert(f.total <= 1.5 + 1e-9, `fast outro ${f.total.toFixed(2)} s`);
    assert.equal(f.stages[f.stages.length - 1].stage, 'end');
  }
  const full = planOutro({ ko: true, clip }), rm = planOutro({ ko: true, clip, reducedMotion: true });
  assert(rm.total < full.total - 3, 'reduced motion is shorter');
  assert(!rm.replay.some((r) => r.angle === 'overhead'), 'no overhead swoop');
  assert(OUTRO_TUNING.ko.banner >= 3 && OUTRO_TUNING.ko.banner <= 5);
});

test('screen overlays: per-viewport slow-motion layers, logo wipe and fades toggle cleanly', () => {
  const s = new ScreenFX();
  s.setSlow('p2', 1);
  s.setChannel('p1');
  assert.equal(s.slow.p2.smear.visible, false); assert.equal(s.slow.p1.tint.visible, false);
  s.setChannel('p2');
  assert.equal(s.slow.p2.smear.visible, true); assert.equal(s.slow.p2.tint.visible, true);
  s.setSlow('p2', 0); s.setChannel('p2');
  assert.equal(s.slow.p2.smear.visible, false);
  s.setWipe(0.5); assert.equal(s.wipe.visible, true);
  s.setWipe(1); assert.equal(s.wipe.visible, false);
  s.setFade(0.8, 0xffffff, 2); assert(s.fade.visible);
  for (let i = 0; i < 40; i++) s.update(1 / 60);
  assert.equal(s.fade.visible, false, 'a decaying fade clears itself');
  s.clear(); s.dispose();
});
