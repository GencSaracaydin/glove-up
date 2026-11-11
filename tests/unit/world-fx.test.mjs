// View3d / FX: hit-stop tiers (§2.8), the hit vocabulary (§5), trails, speed lines, slow-motion
// particle time, shake, pooling, per-viewport flashes.
import * as THREE from 'three';
import { test, assert, approx } from '../harness.mjs';
import { FX, FX_TUNING, readVec3, hitStopMsFor } from '../../src/render/fx.js';

const seeded = (s = 1) => () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const P = new THREE.Vector3(0, 1.3, -0.4);
const step = (fx, ms, frame = 1000 / 120) => { for (let t = 0; t < ms - 1e-9; t += frame) fx.update(Math.min(frame, ms - t) / 1000); };

test('fx: timeScale is 1 at rest', () => {
  const fx = new FX({ random: seeded() });
  assert.equal(fx.timeScale, 1);
});

test('fx: hit-stop tiers from MATCH_HIT (§2.8, ARCHITECTURE §6.2)', () => {
  const human = (id) => id === 'p1';
  const H = FX_TUNING.hitStop;
  assert.equal(hitStopMsFor({ attacker: 'p1', defender: 'p2' }, human), 200, "player's clean hit 0.2 s");
  assert.equal(hitStopMsFor({ attacker: 'p1', defender: 'p2', counter: true }, human), 500, 'counter 0.5 s');
  assert.equal(hitStopMsFor({ attacker: 'p1', defender: 'p2', heavy: true }, human), 500, 'big hit 0.5 s');
  assert.equal(hitStopMsFor({ attacker: 'p1', defender: 'p2', knockdown: true }, human), 700, 'knockdown blow 0.7 s');
  assert.equal(hitStopMsFor({ attacker: 'p2', defender: 'p1' }, human), 0, 'ordinary hit on the human: none');
  assert.equal(hitStopMsFor({ attacker: 'p2', defender: 'p1', heavy: true }, human), 450, 'heavy hit on the human 0.45 s');
  assert.equal(hitStopMsFor({ attacker: 'p2', defender: 'p1', knockdown: true }, human), 700);
  assert.equal(hitStopMsFor({ attacker: 'p2', defender: 'p1' }, () => true), 200, 'versus: the attacker\'s tiers');
  assert.equal(hitStopMsFor(null, human), 0);
  assert.deepEqual([H.playerHit, H.big, H.knockdown, H.onHuman, H.onHumanHeavy], [200, 500, 700, 0, 450]);
});

test('fx: a 0.7 s knockdown stall freezes game time for exactly 0.7 s of real time', () => {
  const fx = new FX();
  fx.hitStop(700);
  assert(fx.timeScale <= 0.05, 'effectively frozen');
  step(fx, 690);
  assert(fx.timeScale <= 0.05, 'still frozen at 690 ms');
  step(fx, 20);
  assert.equal(fx.timeScale, 1, 'released by 710 ms');
  let game = 0;
  fx.hitStop(500);
  for (let i = 0; i < 60; i++) { game += (1 / 60) * fx.timeScale; fx.update(1 / 60); }
  assert(game < 0.52 && game > 0.49, `the round clock runs ${game.toFixed(3)} s of a 1 s window with a 0.5 s stall`);
});

test('fx: slow-motion particle time slows the particles, not the time control', () => {
  const fx = new FX({ random: seeded(4) });
  fx.hit(P, { kind: 'player', power: 0.5 });
  fx.hitStop(200);
  const n0 = fx.sprites.activeCount();
  for (let i = 0; i < 30; i++) fx.update(1 / 60, 0.25);
  assert.equal(fx.timeScale, 1, 'hit-stop ran out on real time');
  assert.equal(fx.sprites.activeCount(), n0, 'the burst is still playing at quarter speed');
  for (let i = 0; i < 30; i++) fx.update(1 / 60, 1);
  assert(fx.sprites.activeCount() < n0, 'normal speed finishes it');
});

test('fx: hit vocabulary — pink pop (bigger for a counter), blue/white + purple when the player is hit, quick green block ring', () => {
  const a = new FX({ random: seeded(9) }), b = new FX({ random: seeded(9) });
  a.hit(P, { kind: 'player', power: 0.6 }); b.hit(P, { kind: 'player', power: 0.6, counter: true });
  const maxS = (fx) => Math.max(...fx.sprites.items.filter((s) => s.active).map((s) => s.s1));
  const colors = (fx) => fx.sprites.items.filter((s) => s.active).map((s) => s.mat.color.getHex());
  assert(maxS(b) > maxS(a) * 1.3, 'counter pop is bigger');
  assert(colors(a).some((c) => c === new THREE.Color(0xff4fa0).getHex()), 'pink');
  const t1 = new FX({ random: seeded(2) }), t2 = new FX({ random: seeded(2) });
  t1.hit(P, { kind: 'taken', power: 0.6 }); t2.hit(P, { kind: 'taken', power: 0.6, heavy: true });
  const purple = new THREE.Color(0xa45cff).getHex();
  assert(!colors(t1).includes(purple) && colors(t2).includes(purple), 'purple only for heavy hits / counters');
  assert(colors(t1).includes(new THREE.Color(0x5fb8ff).getHex()), 'blue/white burst');
  const g = new FX({ random: seeded(3) });
  g.block(P);
  const ring = g.sprites.items.find((s) => s.active);
  assert(ring.life <= 0.2 + 1e-9, `green ring 0.07–0.2 s (${ring.life})`);
  assert(ring.mat.color.g > ring.mat.color.r && ring.mat.color.g > ring.mat.color.b, 'green');
});

test('fx: glove trails follow points, linger after a miss and recycle', () => {
  const fx = new FX();
  fx.trailStart('p2:right', 0xff3b3b);
  const p = new THREE.Vector3(0, 1.2, -0.4);
  for (let i = 0; i < 12; i++) { p.z += 0.06; fx.trailPoint('p2:right', p); fx.update(1 / 60); }
  assert.equal(fx.stats().trails, 1);
  const it = fx.trails.items.find((x) => x.key === 'p2:right');
  assert(it.mesh.visible && it.count === 12);
  fx.trailStop('p2:right', 0.5);
  step(fx, 300, 1000 / 60);
  assert.equal(fx.stats().trails, 1, 'the miss streak hangs on');
  step(fx, 400, 1000 / 60);
  assert.equal(fx.stats().trails, 0, 'then fades away');
  for (let i = 0; i < 20; i++) fx.trailStart(`k${i}`, 0x4aa8ff);
  assert(fx.stats().trails <= FX_TUNING.trail.slots, 'pool never grows');
});

test('fx: orange speed lines are per viewport channel and fade within ~0.3 s', () => {
  const fx = new FX();
  fx.speedLines('p2', 1);
  fx.setViewportChannel('p1');
  assert.equal(fx.speed.p1.mesh.visible, false);
  fx.setViewportChannel('p2');
  assert.equal(fx.speed.p2.mesh.visible, true);
  step(fx, 350);
  fx.setViewportChannel('p2');
  assert.equal(fx.speed.p2.mesh.visible, false, 'gone after the cut has begun');
});

test('fx: punch hit-stop for training pops is 45–70 ms scaled by power (counters a bit longer, capped)', () => {
  const fx = new FX();
  approx(fx.punchHitStopMs(0, false), 45, 1e-9);
  approx(fx.punchHitStopMs(1, false), 70, 1e-9);
  assert(fx.punchHitStopMs(1, true) > 70 && fx.punchHitStopMs(1, true) <= FX_TUNING.hitStop.maxMs);
  assert(fx.punchHitStopMs(5, true) <= FX_TUNING.hitStop.maxMs, 'power is clamped');
});

test('fx: hit-stop freezes game time for exactly its duration (real time)', () => {
  const fx = new FX();
  fx.hitStop(fx.punchHitStopMs(0.6, false)); // 60 ms
  approx(fx.timeScale, FX_TUNING.hitStop.scale, 1e-9);
  step(fx, 55);
  approx(fx.timeScale, FX_TUNING.hitStop.scale, 1e-9, 'still frozen at 55 ms');
  step(fx, 10);
  assert.equal(fx.timeScale, 1, 'released by 65 ms');
});

test('fx: hit-stops do not stack (a flurry never freezes the game for long)', () => {
  const fx = new FX();
  for (let i = 0; i < 10; i++) fx.hitStop(70);
  step(fx, 75);
  assert.equal(fx.timeScale, 1);
});

test('fx: knockdown slow-mo holds ~0.35 then eases back to 1 smoothly', () => {
  const fx = new FX();
  const S = FX_TUNING.slowMo;
  fx.slowMo(S.knockdownScale, S.knockdownMs);
  approx(fx.timeScale, S.knockdownScale, 1e-9);
  step(fx, S.knockdownMs - S.easeOutMs - 20);
  approx(fx.timeScale, S.knockdownScale, 1e-9, 'held');
  let prev = fx.timeScale;
  for (let i = 0; i < 40; i++) {
    fx.update(0.01);
    assert(fx.timeScale >= prev - 1e-9, 'monotonic ease-out');
    assert(fx.timeScale <= 1 && fx.timeScale >= S.knockdownScale - 1e-9);
    prev = fx.timeScale;
  }
  assert.equal(fx.timeScale, 1);
});

test('fx: hit-stop during slow-mo uses the smaller scale', () => {
  const fx = new FX();
  fx.slowMo(0.35, 1000);
  fx.hitStop(60);
  approx(fx.timeScale, FX_TUNING.hitStop.scale, 1e-9);
  step(fx, 70);
  approx(fx.timeScale, 0.35, 1e-9);
});

test('fx: bad dt values are ignored safely', () => {
  const fx = new FX();
  fx.hitStop(50);
  for (const dt of [NaN, -1, undefined, Infinity]) fx.update(dt);
  assert(Number.isFinite(fx.timeScale));
});

test('fx: shake trauma is per viewport channel and decays to zero', () => {
  const fx = new FX();
  const out = { x: 0, y: 0, roll: 0 };
  fx.shake(0.8, 'p2');
  fx.update(0.016);
  fx.getShake('p1', out);
  assert.equal(out.x, 0); assert.equal(out.y, 0); assert.equal(out.roll, 0);
  let moved = false;
  for (let i = 0; i < 10; i++) { fx.update(0.005); fx.getShake('p2', out); if (Math.abs(out.x) + Math.abs(out.y) > 1e-4) moved = true; }
  assert(moved, 'p2 shakes');
  assert(Math.abs(out.x) <= FX_TUNING.shake.maxOffset && Math.abs(out.roll) <= FX_TUNING.shake.maxRoll);
  step(fx, 1000);
  fx.getShake('p2', out);
  assert.equal(out.x, 0, 'decayed');
});

test('fx: reduced motion shrinks shake and flashes but keeps hit-stop', () => {
  const a = new FX(), b = new FX();
  b.setReducedMotion(true);
  for (const fx of [a, b]) { fx.shake(1, 'p1'); fx.screenFlash(0.5, 0xffffff, 'p1'); fx.hitStop(60); }
  assert(b._trauma.p1 < a._trauma.p1 * 0.5);
  assert(b.flashes.p1.mat.uniforms.uAlpha.value < a.flashes.p1.mat.uniforms.uAlpha.value);
  assert.equal(b.timeScale, a.timeScale);
});

test('fx: pools never grow — no objects are created after construction', () => {
  const fx = new FX({ random: seeded(3) });
  let count = 0;
  fx.object3d.traverse(() => count++);
  for (let i = 0; i < 200; i++) {
    fx.hit(P, { power: Math.random(), counter: i % 3 === 0 });
    fx.hit(P, { kind: i % 2 ? 'player' : 'taken', power: 0.7, counter: i % 3 === 0, heavy: i % 4 === 0 });
    fx.block(P); fx.whoosh(P, 1, 0); fx.sweat(P, new THREE.Vector3(0, 0, -1)); fx.miss(P, new THREE.Vector3(0, 0, -1));
    fx.missStreak(P, new THREE.Vector3(0, 0, 1)); fx.speedLines('p1', 1);
    fx.trailStart(`t${i % 9}`, 0xff3b3b); fx.trailPoint(`t${i % 9}`, P); if (i % 3 === 0) fx.trailStop(`t${(i + 4) % 9}`);
    if (i % 20 === 0) { fx.dust(P); fx.confetti(); fx.streaks(P); }
    fx.update(0.004);
  }
  let after = 0;
  fx.object3d.traverse(() => after++);
  assert.equal(after, count);
  const st = fx.stats();
  assert(st.sparks <= FX_TUNING.pools.sparks && st.drops <= FX_TUNING.pools.drops && st.sprites <= FX_TUNING.pools.sprites);
  assert(st.confetti <= FX_TUNING.confetti.count);
});

test('fx: every effect expires', () => {
  const fx = new FX({ random: seeded(5) });
  fx.hit(P, { power: 1, counter: true }); fx.block(P); fx.whoosh(P, 0, -1); fx.sweat(P, new THREE.Vector3(0, 0, 1));
  fx.hit(P, { kind: 'taken', heavy: true }); fx.missStreak(P, new THREE.Vector3(1, 0, 0)); fx.speedLines('all', 1);
  fx.trailStart('a', 0xff0000); fx.trailPoint('a', P); fx.trailStop('a');
  fx.dust(P); fx.confetti(); fx.screenFlash(0.6); fx.streaks(P, { duration: 2 });
  assert(fx.stats().sprites > 0 && fx.stats().sparks > 0 && fx.stats().confetti > 0 && fx.stats().streaks === 1);
  step(fx, 6000, 50);
  const st = fx.stats();
  assert.deepEqual([st.sprites, st.sparks, st.drops, st.arcs, st.dust, st.confetti, st.trails, st.streaks], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert(st.flash < 0.003 && st.speedLines < 0.003);
});

test('fx: counters are visibly bigger than normal hits', () => {
  const a = new FX({ random: seeded(9) }), b = new FX({ random: seeded(9) });
  a.hit(P, { power: 0.6 }); b.hit(P, { power: 0.6, counter: true });
  const maxScale = (fx) => Math.max(...fx.sprites.items.filter((s) => s.active).map((s) => s.s1));
  assert(maxScale(b) > maxScale(a) * 1.2);
  assert(b.sparks.count > a.sparks.count);
});

test('fx: screen flash is per viewport channel', () => {
  const fx = new FX();
  fx.screenFlash(0.5, 0xff0000, 'p2');
  fx.setViewportChannel('p1');
  assert.equal(fx.flashes.p1.mesh.visible, false);
  assert.equal(fx.flashes.p2.mesh.visible, false, 'only the drawn viewport channel is visible');
  fx.setViewportChannel('p2');
  assert.equal(fx.flashes.p2.mesh.visible, true);
  fx.clear();
  assert.equal(fx.flashes.p2.mesh.visible, false);
});

test('fx: readVec3 accepts arrays / objects and rejects junk', () => {
  const v = new THREE.Vector3();
  assert(readVec3([1, 2, 3], v) && v.x === 1 && v.z === 3);
  assert(readVec3({ x: 4, y: 5, z: 6 }, v) && v.y === 5);
  assert(!readVec3(null, v));
  assert(!readVec3([1, 2], v));
  assert(!readVec3({ x: 'a', y: 1, z: 1 }, v));
});
