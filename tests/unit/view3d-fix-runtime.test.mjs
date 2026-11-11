// view3d fix pass — renderer runtime: adaptive quality that ignores detection time (PERF-03, D9),
// the shader prewarm API (PERF-04, D11), damage-0 hits and the meters (Q3), and a clean start of
// the KO replay in ?fast=1 (Q2). GameRenderer needs WebGL, so its methods run on a stub instance
// built from the prototype with the real FX / meters / recorder / camera rig / boxer models.
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { AdaptiveQuality, ADAPTIVE_TUNING } from '../../src/render/adaptive.js';
import { GameRenderer, RENDER_TUNING, harmless } from '../../src/render/renderer.js';
import { FX } from '../../src/render/fx.js';
import { HealthMeters } from '../../src/render/meter.js';
import { ViewRecorder, planOutro, OUTRO_TUNING, REPLAY_TUNING } from '../../src/render/replay.js';
import { CameraRig } from '../../src/render/camera-rig.js';
import { BoxerModel } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER, PRESETS } from '../../src/render/appearance.js';
import { LAYOUT } from '../../src/render/style.js';

/** Feed `sec` seconds of frames: interval `ms`, of which `extMs` were detection (every `every`-th frame). */
function feed(q, sec, { ms, extMs = 0, every = 1, slowMs = null, slowEvery = 0 }) {
  const changes = [];
  let t = 0, i = 0;
  while (t < sec) {
    const det = every > 0 && i % every === 0 ? extMs : 0;
    const dt = (slowEvery && i % slowEvery === 0 ? slowMs : ms) + det;
    q.setExternalCost(det);
    const c = q.frame(dt / 1000);
    if (c) changes.push({ at: +t.toFixed(2), ...c });
    t += dt / 1000; i++;
  }
  return changes;
}

test('view3d-fix PERF-03: detection time is not render time — 30 Hz detection (30 ms) between plain frames never steps down', () => {
  // camera mode on a capable GPU: render ~1–5 ms, a ~30 ms synchronous detection on every other frame
  const q = new AdaptiveQuality({ maxRatio: 2 });
  const ch = feed(q, 40, { ms: 16.7, extMs: 30, every: 2 });
  assert.deepEqual(ch, [], `no quality change (${JSON.stringify(ch)})`);
  assert.equal(q.pixelRatio, 2);
  assert.equal(q.shadowLowered, false);
  // the old judge (wall-clock interval only) would have stepped: the same stream averages > 21 ms
  const old = new AdaptiveQuality({ maxRatio: 2 });
  const oldCh = feed(old, 40, { ms: 16.7, extMs: 0, every: 2, slowMs: 46.7, slowEvery: 2 });
  assert(oldCh.length >= 3 && oldCh[0].dir === 'down', 'without the detection cost the same intervals read as slow');
});

test('view3d-fix PERF-03: genuinely slow rendering still steps down — after two slow windows, one notch at a time', () => {
  const q = new AdaptiveQuality({ maxRatio: 2 });
  const ch = feed(q, 3 + 2.5 * 2 + 0.2, { ms: 33.4 });
  assert.equal(ch.length, 1, `one step after two slow windows (${JSON.stringify(ch)})`);
  assert.equal(ch[0].pixelRatio, 1.75);
  const one = new AdaptiveQuality({ maxRatio: 2 });
  assert.deepEqual(feed(one, 3 + 2.5 + 0.2, { ms: 33.4 }), [], 'hysteresis: a single slow window is not enough');
  const all = feed(new AdaptiveQuality({ maxRatio: 2 }), 60, { ms: 40 });
  assert.deepEqual(all.map((c) => c.pixelRatio ?? c.shadow), [1.75, 1.5, 1.25, 1, 'low'], 'the full ladder, shadows last');
  // a detection that is cheaper than the slowness is subtracted, the rest still counts
  const mixed = feed(new AdaptiveQuality({ maxRatio: 2 }), 12, { ms: 30, extMs: 5, every: 1 });
  assert(mixed.length >= 1 && mixed[0].dir === 'down', 'slow render + detection still steps down');
});

test('view3d-fix PERF-03: a transient hitch never downgrades for good — the quality steps back up after ~10 s of headroom', () => {
  const q = new AdaptiveQuality({ maxRatio: 2 });
  feed(q, 3 + 5.2, { ms: 33.4 });                       // a slow spell → 1.75
  assert.equal(q.pixelRatio, 1.75);
  const up = feed(q, ADAPTIVE_TUNING.upAfterSec + 3, { ms: 16.7, extMs: 25, every: 2 });
  assert(up.length === 1 && up[0].dir === 'up' && up[0].pixelRatio === 2, `back to 2 (${JSON.stringify(up)})`);
  assert.deepEqual(feed(q, 30, { ms: 16.7 }), [], 'never above the starting ratio');
  // a step up that has to be undone right away doubles the wait before the next try (no oscillation)
  const b = new AdaptiveQuality({ maxRatio: 2 });
  feed(b, 3 + 5.2, { ms: 33.4 });
  assert.equal(feed(b, 13, { ms: 16.7 }).length, 1);    // up to 2
  assert.equal(b.pixelRatio, 2);
  feed(b, 5.2, { ms: 33.4 });                           // too slow again → 1.75
  assert.equal(b.pixelRatio, 1.75);
  assert.equal(b.state().upWaitSec, 2 * ADAPTIVE_TUNING.upAfterSec);
  assert.deepEqual(feed(b, 12, { ms: 16.7 }), [], 'waits longer this time');
  assert.equal(feed(b, 10, { ms: 16.7 }).length, 1);
  // shadows come back before the pixel ratio
  const s = new AdaptiveQuality({ maxRatio: 1 });
  feed(s, 3 + 5.2, { ms: 40 });
  assert.equal(s.shadowLowered, true);
  const back = feed(s, 13, { ms: 16.7 });
  assert(back.length === 1 && back[0].shadow === 'high', `shadows back first (${JSON.stringify(back)})`);
  // quality 'high' / 'low' never adapts
  assert.deepEqual(feed(new AdaptiveQuality({ maxRatio: 2, enabled: false }), 30, { ms: 50 }), []);
});

test('view3d-fix PERF-03: the renderer API — setExternalFrameCost / opts.externalMs feed the judge, changes apply to the drawing buffer and shadows', () => {
  const R = Object.create(GameRenderer.prototype);
  R._adaptive = new AdaptiveQuality({ maxRatio: 2 });
  R._pixelRatio = 2; R._shadowLowered = false;
  let resized = 0, shadow = null;
  R.resize = () => { resized++; };
  R.arena = { setShadowMapSize: (n) => { shadow = n; } };
  R.canvas = { clientWidth: 0, clientHeight: 0 };
  let now = 0;
  R._clock = () => now; R._lastNow = null; R._w = 0; R._h = 0;
  const info = console.info; console.info = () => {};
  try {
    for (let i = 0; i < 2400; i++) { now += 46.7; R.setExternalFrameCost(30); R._tick(0.0467); }
    assert.equal(R._pixelRatio, 2, 'detection-heavy frames: no step');
    for (let i = 0; i < 2400; i++) { now += 46.7; R._tick(0.0467, { externalMs: 30 }); }
    assert.equal(R._pixelRatio, 2, 'opts.externalMs works the same');
    for (let i = 0; i < 400; i++) { now += 40; R._tick(0.04); }
    assert(R._pixelRatio < 2 && resized > 0, 'slow rendering steps the pixel ratio down');
    R._adapt = GameRenderer.prototype._adapt;
    R._adaptive = new AdaptiveQuality({ maxRatio: 1 });
    for (let i = 0; i < 400; i++) { now += 40; R._tick(0.04); }
    assert.equal(shadow, RENDER_TUNING.shadowMapLow);
    for (let i = 0; i < 1200; i++) { now += 16.7; R._tick(0.0167); }
    assert.equal(shadow, RENDER_TUNING.shadowMapHigh, 'and back up');
  } finally { console.info = info; }
});

function stubRenderer({ BoxerModelCls = BoxerModel } = {}) {
  const R = Object.create(GameRenderer.prototype);
  const slot = () => ({ model: null, key: null, appRef: undefined, failedKey: null, ghost: null, view: null, human: null,
    anchor: new THREE.Vector3(), leanOff: new THREE.Vector3(), pos: new THREE.Vector3(), yaw: 0, placed: false,
    head: new THREE.Vector3(), body: new THREE.Vector3(), meterAnchor: new THREE.Vector3(),
    trail: { left: { on: false, id: null }, right: { on: false, id: null } }, pendingRise: false });
  R._slots = { p1: slot(), p2: slot(), trainee: slot() };
  R._slots.p1.pos.fromArray(LAYOUT.p1Pos); R._slots.p1.yaw = Math.PI; R._slots.p2.pos.fromArray(LAYOUT.p2Pos);
  R._BoxerModel = BoxerModelCls;
  R._boxerGroup = new THREE.Group();
  R.scene = new THREE.Scene(); R.scene.add(R._boxerGroup);
  R._rigs = [new CameraRig({ side: 'p1' }), null]; R._split = 1;
  R._clock = () => 0; R._lost = false; R._scene = 'match'; R._outro = null; R.bus = null;
  R.fx = new FX(); R.meters = new HealthMeters(); R._recorder = new ViewRecorder();
  R.arena = { cheer() {}, taunt() {}, roar() {}, flash() {} };
  R._exciteBoost = 0; R._freezeId = null; R._headWorldPosition = null; R._bodyWorldPosition = null;
  return R;
}

test('view3d-fix PERF-04: prewarm builds both models and compiles their solid AND ghost material sets, then restores them', async () => {
  const R = stubRenderer();
  const calls = [];
  const programs = [];
  R.renderer = {
    info: { programs },
    compileAsync: (scene, cam) => {
      const ghosts = R._boxerGroup.children.length;
      const sets = [R._slots.p1.model?.ghost, R._slots.p2.model?.ghost];
      calls.push({ scene, cam, ghosts, sets });
      programs.push({}, {});
      return Promise.resolve();
    },
  };
  const look2 = PRESETS[4];
  const res = await R.prewarm({ p1: DEFAULT_PLAYER, p2: look2 });
  assert(R._slots.p1.model && R._slots.p2.model, 'both boxer models built for the bout');
  assert.equal(R._boxerGroup.children.length, 2);
  assert.equal(calls.length, 2, 'two compile passes');
  assert(calls.every((c) => c.scene === R.scene && c.cam === R._rigs[0].camera));
  assert.deepEqual(calls[0].sets, [true, false], 'pass 1: the human as a ghost (single player), the opponent solid');
  assert.deepEqual(calls[1].sets, [false, true], 'pass 2: the other material set of each');
  assert.equal(R._slots.p1.model.ghost, true, 'restored');
  assert.equal(R._slots.p2.model.ghost, false, 'restored');
  assert.equal(res.programs, 4);
  // the match reuses the prewarmed models (same appearance, a different object)
  const m2 = R._slots.p2.model;
  assert.equal(R._ensureModel(R._slots.p2, JSON.parse(JSON.stringify(look2)), 'boxer', false, R._boxerGroup), m2);
  // a lost context or a failing compile never throws
  R._lost = true;
  assert.equal((await R.prewarm({})).skipped, 'context-lost');
  R._lost = false;
  R.renderer.compileAsync = () => Promise.reject(new Error('boom'));
  const err = console.error; console.error = () => {};
  try { const r2 = await R.prewarm({ p1: DEFAULT_PLAYER, p2: look2 }); assert.equal(r2.programs, 0); } finally { console.error = err; }
  assert.equal(R._slots.p1.model.ghost, true, 'ghost state restored after a failure');
});

test('view3d-fix Q3: a damage-0 hit (tutorial) keeps its burst but never wakes the health meter', () => {
  assert.equal(harmless({ damage: 0, hpBefore: 10, hpAfter: 10 }), true);
  assert.equal(harmless({ damage: 1.4, hpBefore: 10, hpAfter: 8.6 }), false);
  assert.equal(harmless({ hpBefore: 6, hpAfter: 6 }), true);
  assert.equal(harmless({}), false, 'unknown: treat as a real hit');
  const R = stubRenderer();
  R._slots.p1.view = { isHuman: true }; R._slots.p2.view = { isHuman: false };
  const hit = (o) => R._onHit({ attacker: 'p1', defender: 'p2', hand: 'left', kind: 'straight', target: 'head', power: 0.6, pos: [0, 1.2, -0.4], ...o });
  hit({ damage: 0, dealt: 0, hpBefore: 10, hpAfter: 10 });
  R.meters.update(0.1);
  assert.equal(R.meters.state.p2.everHit, false, 'tutorial hit: meter not armed');
  // after the tutorial (meters no longer forced hidden) nothing fades in
  for (let i = 0; i < 20; i++) R.meters.update(0.05);
  assert.equal(R.meters.state.p2.visible, false);
  assert(R.fx.stats().active > 0 || R.fx.hitStopLeftMs > 0, 'the hit still shows its burst / hit-stop');
  hit({ damage: 1.4, dealt: 1.4, hpBefore: 10, hpAfter: 8.6 });
  R.meters.update(0.1);
  assert.equal(R.meters.state.p2.visible, true, 'a real hit shows the meter');
});

test('view3d-fix Q2: ?fast=1 KO outro — the replay starts after the HUD\'s KO letters have faded, still ≤ 1.5 s in total', () => {
  const clip = { tau0: 10 - REPLAY_TUNING.pre, tau1: 10 + REPLAY_TUNING.post, blowTau: 10 };
  const HUD_CALL_FADE = 0.26; // HUD_TUNING.callOutMs: the calls fade out from the 'wipe' stage
  for (const reducedMotion of [false, true]) {
    const p = planOutro({ ko: true, clip, fast: true, reducedMotion });
    const wipe = p.stages.find((s) => s.stage === 'wipe').at;
    const replay = p.stages.find((s) => s.stage === 'replay').at;
    assert(replay - wipe >= HUD_CALL_FADE, `rm ${reducedMotion}: ${(replay - wipe).toFixed(3)} s from the wipe to the replay (was 0.05)`);
    assert(Math.abs(p.total - OUTRO_TUNING.fastTotal) < 1e-9 && p.total <= 1.5);
    assert.deepEqual(p.stages.map((s) => s.stage), ['start', 'wipe', 'flash', 'replay', 'banner', 'winner', 'end']);
    for (let i = 1; i < p.stages.length; i++) assert(p.stages[i].at >= p.stages[i - 1].at - 1e-9, 'in order');
    let at = p.replay[0].at;
    for (const r of p.replay) { assert(Math.abs(r.at - at) < 1e-9 && r.dur > 0 && r.speed > 0); at += r.dur; }
    assert(Math.abs(at - p.bannerAt) < 1e-6, 'the replay segments still tile up to the banner');
    const seg = p.replay.find((r) => r.from < 0 && r.to > 0);
    assert(Math.abs((seg.to - seg.from) / seg.speed + p.impactHold - seg.dur) < 1e-6, 'segment speeds match their new lengths');
  }
  // the normal-speed and decision plans are unchanged
  const normal = planOutro({ ko: true, clip });
  assert(normal.replay[0].at - normal.wipe.at > 0.4);
  const dec = planOutro({ ko: false, fast: true });
  assert(Math.abs(dec.total - OUTRO_TUNING.fastTotal) < 1e-9);
});
