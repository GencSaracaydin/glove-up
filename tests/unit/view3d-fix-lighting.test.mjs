// view3d fix pass — VISUAL-10: the venue is lit like a spotlit night arena (darker, warmer, a tight
// key on the ring) while our own hues stay as they are. The rendered-frame numbers (mean luma, dark
// share, stands' tint, knockdown-shot highlights) are measured in the browser and listed with
// VENUE_LIGHTING in src/render/style.js (ARCHITECTURE.md §3 describes it); these tests pin the
// lighting design that produces them.
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { PALETTE, LIGHTING, VENUE_LIGHTING as V, LAYOUT } from '../../src/render/style.js';
import { buildArena, ARENA_TUNING } from '../../src/render/arena.js';

const srgb = (hex) => new THREE.Color(hex).convertLinearToSRGB();
const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * 255;

test('view3d-fix VISUAL-10: the ring canvas albedo is toned down to ~185–200 luma; our ivory hue is kept', () => {
  const canvas = srgb(PALETTE.canvas);
  const tone = new THREE.Color(V.canvasTone);             // multiplies the texture in linear space
  const lit = new THREE.Color(PALETTE.canvas).multiply(tone).convertLinearToSRGB();
  assert(luma(canvas) > 230, 'the palette ivory itself is unchanged');
  assert(luma(lit) >= 175 && luma(lit) <= 200, `canvas albedo luma ${luma(lit).toFixed(0)} (was ${luma(canvas).toFixed(0)})`);
  assert(tone.r === tone.g && tone.g === tone.b, 'a neutral multiplier: the hue stays');
});

test('view3d-fix VISUAL-10: a spotlit key — low ambient fill, a strong warm spot that keeps the fighters in full light and falls off toward the corners', () => {
  assert(V.hemiIntensity <= 0.6 && V.hemiIntensity < LIGHTING.hemiIntensity * 0.6, `ambient fill ${V.hemiIntensity} (was ${LIGHTING.hemiIntensity})`);
  assert(V.keyIntensity / V.hemiIntensity >= 6, `key/fill ratio ${(V.keyIntensity / V.hemiIntensity).toFixed(1)} (was ${(LIGHTING.keyIntensity / LIGHTING.hemiIntensity).toFixed(1)})`);
  const key = srgb(V.keyColor);
  assert(key.r - key.b >= 0.25, 'a warm key');
  assert(V.rimIntensity < LIGHTING.rimIntensity && V.exposure <= 1, 'softer rim, no over-exposure');
  const arena = buildArena();
  const { key: spot, hemi } = arena.lights;
  assert.equal(spot.intensity, V.keyIntensity); assert.equal(hemi.intensity, V.hemiIntensity);
  const axis = spot.target.position.clone().sub(spot.position).normalize();
  const angleTo = (x, z, y = 1) => Math.acos(new THREE.Vector3(x, y, z).sub(spot.position).normalize().dot(axis));
  const full = spot.angle * (1 - spot.penumbra);
  for (const [x, z] of [[0, LAYOUT.p1Pos[2]], [0, LAYOUT.p2Pos[2]], [0.4, 0.9], [-0.4, -0.9]]) {
    assert(angleTo(x, z) <= full + 0.02, `fighters' area at (${x}, ${z}) in full light`);
  }
  // the far corner still sits inside the cone, but well down the falloff
  const corner = angleTo(LAYOUT.ringHalf, -LAYOUT.ringHalf, 0);
  assert(corner < spot.angle, 'corners lit');
  const fall = (Math.cos(corner) - Math.cos(spot.angle)) / (Math.cos(full) - Math.cos(spot.angle));
  const s = Math.max(0, Math.min(1, fall));
  assert(s * s * (3 - 2 * s) <= 0.3, `far corner gets ${(100 * s * s * (3 - 2 * s)).toFixed(0)} % of the key (spotlit ring)`);
  arena.dispose();
});

test('view3d-fix VISUAL-10: the hall falls away to near-black navy and the crowd into warm dark', () => {
  const top = srgb(V.hallTop), bottom = srgb(V.hallBottom), fog = srgb(V.fogColor);
  assert(luma(top) < 16 && luma(bottom) < 26, `dome luma ${luma(top).toFixed(1)} / ${luma(bottom).toFixed(1)} (was ${luma(srgb(PALETTE.skyTop)).toFixed(1)} / ${luma(srgb(PALETTE.skyBottom)).toFixed(1)})`);
  for (const c of [top, bottom]) assert(c.b > c.r, 'still our navy (blue dominant)');
  assert(luma(fog) <= luma(top) + 1, 'the fog matches the dark hall');
  const haze = new THREE.Color(V.crowdHaze);
  assert(luma(haze) < 10 && haze.r >= haze.b, 'the back rows fade into a warm near-black, not navy');
  assert(ARENA_TUNING.crowd.dim <= 0.3 && ARENA_TUNING.crowd.dimExcited <= 0.45, 'a dimmer crowd (calm / roaring)');
  assert(ARENA_TUNING.envIntensity <= 0.25, 'less environment wash');
  // the studio lighting the portrait renders use is unchanged
  assert.equal(LIGHTING.hemiIntensity, 1.1); assert.equal(LIGHTING.keyIntensity, 2.4); assert.equal(LIGHTING.exposure, 1.05);
});
