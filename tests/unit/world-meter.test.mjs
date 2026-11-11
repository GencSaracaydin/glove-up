// View3d / on-hit health meters (render/meter.js): research/mechanics.md §5 "How a pie behaves" with
// our own 10-capsule badge (ARCHITECTURE §6.7) — timing, blink, dark count, refill, placement.
import * as THREE from 'three';
import { test, assert, approx } from '../harness.mjs';
import { MeterState, HealthMeters, METER_TUNING as M } from '../../src/render/meter.js';
import { LAYOUT } from '../../src/render/style.js';

const run = (m, sec, dt = 1 / 60) => { for (let t = 0; t < sec - 1e-9; t += dt) m.update(dt); };

test('meter: hidden until its fighter is hit, then shows the PRE-hit value and drains 0.5–0.8 s later', () => {
  const m = new MeterState();
  run(m, 2);
  assert.equal(m.visible, false, 'nothing on screen before the first hit');
  m.hit({ hpBefore: 10, hpAfter: 8.8 });
  run(m, 0.1);
  assert(m.visible, 'appears on the hit');
  approx(m.value, 10, 1e-9, 'pre-hit value first');
  assert(M.drainDelay >= 0.5 && M.drainDelay <= 0.8);
  run(m, M.drainDelay - 0.15);
  approx(m.value, 10, 1e-9, 'still the pre-hit value just before the drain');
  run(m, 0.3);
  approx(m.value, 8.8, 1e-6, 'drained');
  assert(m.shardTo > m.shardFrom && Math.abs(m.shardFrom - 8.8) < 1e-6, 'the lost part breaks into shards');
});

test('meter: partial cells are drawn, follow-ups inside the delay deepen one drain, the edge cell blinks at ~10 Hz', () => {
  const m = new MeterState();
  m.hit({ hpBefore: 10, hpAfter: 8.6 });
  run(m, 0.2);
  m.hit({ hpBefore: 8.6, hpAfter: 7.3 });
  run(m, M.drainDelay + 0.2);
  approx(m.value, 7.3, 1e-6, 'one drop to the latest value (partial cell: 0.3)');
  let on = 0, flips = 0, prev = m.blinkOn;
  for (let i = 0; i < 60; i++) { m.update(1 / 60); on += m.blinkOn; if (m.blinkOn !== prev) flips++; prev = m.blinkOn; }
  assert(on > 12 && on < 30, `lit about a third of the time (${on}/60)`);
  assert(flips >= 16 && flips <= 22, `≈10 blinks per second (${flips} flips)`);
});

test('meter: hides 2.5–4 s after the last hit, but stays at ≤ 3 wedges or empty', () => {
  const m = new MeterState();
  m.hit({ hpBefore: 10, hpAfter: 8.9 });
  run(m, 2.4);
  assert(m.visible, 'still up at 2.4 s');
  assert(M.hideAfter >= 2.5 && M.hideAfter <= 4);
  run(m, M.hideAfter + 0.6 - 2.4);
  assert.equal(m.visible, false, 'gone after the hide delay');
  m.hit({ hpBefore: 4, hpAfter: 2.6 });
  run(m, 8);
  assert(m.visible, 'stays while health ≤ 3');
  m.hit({ hpBefore: 2.6, hpAfter: 0 });
  run(m, 8);
  assert(m.visible, 'stays while empty');
});

test('meter: knockdown blow flashes and bursts, the count shows it dark, rising refills with a sweep', () => {
  const m = new MeterState();
  m.hit({ hpBefore: 10, hpAfter: 1.2 });
  run(m, 1);
  m.hit({ hpBefore: 1.2, hpAfter: 0, knockdown: true });
  m.down();
  run(m, 0.05);
  assert(m.flashT >= 0 && m.shardT >= 0 && m.ringT >= 0, 'flash + burst + ring');
  run(m, M.drainTime);
  approx(m.value, 0, 1e-6, 'drops at once (no pre-hit hold for the knockdown blow)');
  run(m, 1.5);
  assert(m.dark > 0.95 && m.visible, 'dark during the count');
  m.rise(8);
  assert(m.sweepHead >= 0, 'glowing sweep running');
  run(m, M.refillTime * 0.5);
  assert(m.value > 2 && m.value < 8, `mid-sweep ${m.value.toFixed(2)}`);
  assert(m.sparkleT >= 0, 'sparkles');
  run(m, M.refillTime * 0.6);
  approx(m.value, 8, 1e-6, 'refilled to the rising value');
  assert(m.dark < 0.05, 'lit again');
  assert(M.refillTime >= 1 && M.refillTime <= 1.5);
});

test('meter: follows the view quietly when nothing animates; forced hidden in intros', () => {
  const m = new MeterState();
  m.observe(7.5);
  approx(m.value, 7.5, 1e-9);
  m.hit({ hpAfter: 6 }); // no hpBefore (older match builds): the last observed value is the pre-hit value
  run(m, 0.1);
  approx(m.value, 7.5, 1e-9);
  m.observe(6); // the view already shows the new value: ignored while the drain is pending
  approx(m.value, 7.5, 1e-9);
  run(m, 1);
  approx(m.value, 6, 1e-6);
  m.update(1 / 60, true);
  for (let i = 0; i < 30; i++) m.update(1 / 60, true);
  assert.equal(m.visible, false, 'hidden on request');
});

test('meters: own meter low-left near the lead glove, the foe\'s beside its head (versus: per viewport)', () => {
  const meters = new HealthMeters();
  meters.hit('p1', { hpBefore: 10, hpAfter: 8 });
  meters.hit('p2', { hpBefore: 10, hpAfter: 8 });
  meters.update(0.1);
  const cam = new THREE.PerspectiveCamera(46, 16 / 9, 0.05, 100);
  cam.position.set(0, 1.8, LAYOUT.p1Pos[2] + 0.62);
  cam.lookAt(0, 0.9, -1.2);
  cam.updateMatrixWorld();
  const foeHead = new THREE.Vector3(0, 1.19, LAYOUT.p2Pos[2]);
  meters.prepare('p1', cam, { foeHead, ownAnchor: null }, 16 / 9);
  const pct = (v) => [(v.x + 1) / 2, (1 - v.y) / 2];
  const own = pct(meters.mesh.p1.material.uniforms.uCenter.value);
  const foe = pct(meters.mesh.p2.material.uniforms.uCenter.value);
  assert(own[0] >= 0.22 && own[0] <= 0.34 && own[1] >= 0.55 && own[1] <= 0.68, `own meter at ${own.map((x) => x.toFixed(2))}`);
  const head = pct(foeHead.clone().project(cam));
  assert(foe[0] > head[0] + 0.1 && foe[0] < 0.75, `foe meter beside the head (${foe[0].toFixed(2)} vs head ${head[0].toFixed(2)})`);
  assert(Math.abs(foe[1] - head[1]) < 0.08, 'at head height');
  assert(meters.mesh.p1.visible && meters.mesh.p2.visible);
  // player blue, opponent coral/red
  const u1 = meters.mesh.p1.material.uniforms.uColor.value, u2 = meters.mesh.p2.material.uniforms.uColor.value;
  assert(u1.b > u1.r && u2.r > u2.b, 'own blue, foe red');
  // the other viewport swaps the roles
  meters.prepare('p2', cam, { foeHead, ownAnchor: null }, 16 / 9);
  const own2 = pct(meters.mesh.p2.material.uniforms.uCenter.value);
  assert(own2[0] < 0.4, 'P2 sees its own meter low-left in its viewport');
  meters.dispose();
});
