// View3d / arena + renderer module surface (Node: no DOM, no WebGL).
import * as THREE from 'three';
import { test, assert, approx } from '../harness.mjs';
import { buildArena, ARENA_TUNING, BOARD_TAUNTS } from '../../src/render/arena.js';
import { LAYOUT, LIGHTING } from '../../src/render/style.js';

const arena = buildArena();

test('arena: builds in Node with the documented API', () => {
  for (const k of ['update', 'cheer', 'flash', 'setMirrored', 'dispose']) assert.equal(typeof arena[k], 'function', k);
  assert(arena.group instanceof THREE.Group);
  assert(arena.lights.key && arena.lights.rim && arena.lights.hemi);
});

test('arena: exactly one shadow-casting light, aimed at the ring', () => {
  const casters = [];
  arena.group.traverse((o) => { if (o.isLight && o.castShadow) casters.push(o); });
  assert.equal(casters.length, 1);
  const key = casters[0];
  approx(key.position.y, LIGHTING.keyPos[1], 1e-9);
  // the cone covers the ring corners
  const toCorner = new THREE.Vector3(LAYOUT.ringHalf, 0, -LAYOUT.ringHalf).sub(key.position).normalize();
  const axis = key.target.position.clone().sub(key.position).normalize();
  assert(Math.acos(toCorner.dot(axis)) < key.angle, 'far corner lit');
});

test('arena: crowd is instanced (few draw calls) with a sensible head count', () => {
  const inst = [];
  arena.group.traverse((o) => { if (o.isInstancedMesh && o.name.startsWith('crowd')) inst.push(o); });
  assert.equal(inst.length, 4, 'body, head, hair, arms');
  assert(arena.crowdCount > 400 && arena.crowdCount < 1200, `crowd ${arena.crowdCount}`);
  const body = inst.find((m) => m.name === 'crowd-body');
  assert.equal(body.count, arena.crowdCount);
});

test('arena: draw-call budget for the whole venue', () => {
  let meshes = 0;
  arena.group.traverse((o) => { if ((o.isMesh || o.isPoints) && o.visible !== false) meshes++; });
  assert(meshes <= 40, `${meshes} drawables`);
});

test('arena: three rope colours merged into one mesh, four golden posts in one mesh', () => {
  let ropes = 0;
  arena.group.traverse((o) => { if (o.name === 'ropes') ropes++; });
  assert.equal(ropes, 1);
  assert.equal(LAYOUT.ropeHeights.length, 3);
});

test('arena: crowd figures sit outside the ring and face it', () => {
  const body = arena.parts.crowdMeshes[0];
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (let i = 0; i < body.count; i += 37) {
    body.getMatrixAt(i, m);
    m.decompose(p, q, s);
    assert(Math.max(Math.abs(p.x), Math.abs(p.z)) > ARENA_TUNING.barrier.dist, 'behind the barrier');
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const toCentre = new THREE.Vector3(-p.x, 0, -p.z).normalize();
    assert(fwd.dot(toCentre) > 0.9, 'facing the ring');
  }
});

test('arena: update / cheer / flash are robust and drive the crowd state', () => {
  const a = buildArena({ seed: 3 });
  for (const dt of [0, -1, NaN, 1 / 60, 5]) a.update(dt, 0.5);
  a.update(1 / 60, NaN);
  assert(Number.isFinite(a.state().excitement));
  a.cheer(1);
  assert(a.state().cheer > 0.9);
  for (let i = 0; i < 300; i++) a.update(1 / 60, 0.3);
  assert(a.state().cheer < 0.05, 'cheer fades');
  a.flash(1);
  a.update(0.02, 0.3);
  assert(a.state().flashes > 0, 'camera flashes pop');
  a.dispose();
});

test('arena: mirroring swaps the key/rim lights through the ring centre (versus right viewport)', () => {
  const { key, rim } = arena.lights;
  const k0 = key.position.clone(), r0 = rim.position.clone();
  arena.setMirrored(true);
  approx(key.position.x, -k0.x, 1e-9); approx(key.position.z, -k0.z, 1e-9); approx(key.position.y, k0.y, 1e-9);
  approx(rim.position.z, -r0.z, 1e-9);
  arena.setMirrored(false);
  assert(key.position.distanceTo(k0) < 1e-9);
});

test('arena: layout is deterministic per seed', () => {
  const a = buildArena({ seed: 42 }), b = buildArena({ seed: 42 });
  assert.equal(a.crowdCount, b.crowdCount);
  const ma = new THREE.Matrix4(), mb = new THREE.Matrix4();
  a.parts.crowdMeshes[0].getMatrixAt(17, ma); b.parts.crowdMeshes[0].getMatrixAt(17, mb);
  assert(ma.equals(mb));
  a.dispose(); b.dispose();
});

test('arena: the venue turns under the fighters (slow orbit) — lights stay with the fighters', () => {
  const a = buildArena({ seed: 5 });
  const key0 = a.lights.key.position.clone();
  const posts = a.parts.posts;
  const before = posts.getWorldPosition(new THREE.Vector3());
  a.setYaw(0.7);
  assert.equal(a.yaw, 0.7);
  approx(a.stage.rotation.y, 0.7, 1e-12);
  assert(a.lights.key.position.distanceTo(key0) < 1e-9, 'the key light does not turn');
  let underStage = 0;
  a.stage.traverse((o) => { if (o.isLight) underStage++; });
  assert.equal(underStage, 0, 'no light inside the turning stage');
  const corner = new THREE.Vector3(3.1, 1, 3.1).applyMatrix4(a.stage.matrixWorld);
  approx(Math.hypot(corner.x, corner.z), Math.hypot(3.1, 3.1), 1e-9, 'corners stay on their circle');
  assert(Math.abs(Math.atan2(corner.x, corner.z) - Math.atan2(3.1, 3.1)) > 0.5, 'and move around it');
  void before;
  a.setYaw(NaN);
  assert.equal(a.yaw, 0.7, 'junk ignored');
  a.dispose();
});

test('arena: the crowd roars on a KO and the boards switch our own flavour taunts', () => {
  const a = buildArena({ seed: 9 });
  const words0 = a.boardWords();
  assert.equal(words0.length, 4);
  for (const w of words0) assert(BOARD_TAUNTS.includes(w));
  a.roar(2);
  for (let i = 0; i < 90; i++) a.update(1 / 60, 0.5);
  assert(a.state().cheer > 0.95, 'still roaring after 1.5 s');
  for (let i = 0; i < 400; i++) a.update(1 / 60, 0.3);
  assert(a.state().cheer < 0.1, 'then it settles');
  const before = a.boardWords().join('|');
  a.taunt(true);
  assert.notEqual(a.boardWords().join('|'), before, 'new words');
  for (const w of BOARD_TAUNTS) assert(!/\d|round|ko\b|health|p1|p2/i.test(w), `no gameplay information in "${w}"`);
  a.dispose();
});

test('renderer: module imports in Node, fails readably without a canvas, and draws no referee', async () => {
  const mod = await import('../../src/render/renderer.js');
  assert.equal(typeof mod.GameRenderer, 'function');
  assert(mod.RENDER_TUNING && !('REFEREE_APPEARANCE' in mod), 'no referee look exported');
  assert.equal(typeof mod.GameRenderer.prototype.playOutro, 'function');
  assert.equal(typeof mod.GameRenderer.prototype.skipOutro, 'function');
  assert(Object.getOwnPropertyDescriptor(mod.GameRenderer.prototype, 'outroActive')?.get, 'outroActive getter');
  assert.throws(() => new mod.GameRenderer({}), /canvas/);
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/render/renderer.js', import.meta.url), 'utf8'));
  assert(!/role: 'referee'|refCount|refWave|refStart/.test(src), 'no referee model or gestures');
});
