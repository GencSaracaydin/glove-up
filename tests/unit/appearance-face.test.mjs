// Painted faces (render/face.js): projection maths + every feature/expression painted through
// a recording 2D-context mock (no DOM needed).
import { test, assert, approx } from '../harness.mjs';
import { APPEARANCE_OPTIONS as O } from '../../src/core/types.js';
import {
  faceUV, paintFaceTexture, paintFaceFeatures, drawPortrait, acquireFaceTexture, releaseFaceTexture, faceKey,
  normalizeExpression, EXPRESSIONS, BLINK_EXPRESSIONS, FACE_TEX_SIZE, mixHex, shadeHex, luminance,
} from '../../src/render/face.js';
import { PRESETS, DEFAULT_APPEARANCE } from '../../src/render/appearance.js';

/** Canvas 2D stand-in: accepts any call/property, records calls, rejects non-finite numbers. */
function mockCtx() {
  const calls = [];
  const gradient = { addColorStop(o, c) { if (!Number.isFinite(o)) throw new Error('bad stop'); void c; } };
  const target = {};
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return (...args) => { check(k, args); calls.push(k); return gradient; };
      }
      return (...args) => { check(k, args); calls.push(k); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  function check(name, args) {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${String(name)} got ${a}`);
    if ((name === 'ellipse' || name === 'arc') && (args[2] < 0 || args[3] < 0)) throw new Error(`${name} negative radius`);
  }
  return { ctx, calls };
}

test('face: projection is centred, continuous and maps the back to the border', () => {
  const [u0, v0] = faceUV(0, 0, 1);
  approx(u0, 0.5); approx(v0, 0.5);
  const [ur, vr] = faceUV(1, 0, 0); // viewer's right at 90°
  approx(ur, 1, 1e-9); approx(vr, 0.5, 1e-9);
  const [uu, vu] = faceUV(0, 1, 0);
  approx(uu, 0.5, 1e-9); approx(vu, 1, 1e-9);
  for (const dir of [[0, 0, -1], [0.3, 0.2, -0.93], [-0.5, -0.5, -0.7]]) {
    const n = Math.hypot(...dir);
    const [u, v] = faceUV(dir[0] / n, dir[1] / n, dir[2] / n, 1.0);
    approx(Math.hypot(u - 0.5, v - 0.5), 0.5, 1e-9, 'back hemisphere on the border');
  }
  // small steps on the face move the UV a little (no seams/jumps)
  let prev = faceUV(0, 0, 1);
  for (let i = 1; i <= 60; i++) {
    const a = (i / 60) * 1.4;
    const cur = faceUV(Math.sin(a) * 0.6, Math.sin(a) * 0.8, Math.cos(a));
    assert(Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) < 0.02, `jump at ${a}`);
    prev = cur;
  }
  // near the face the projection is ~conformal: eye-distance angles map almost linearly
  const r1 = Math.hypot(faceUV(Math.sin(0.2), 0, Math.cos(0.2))[0] - 0.5, 0);
  const r2 = Math.hypot(faceUV(Math.sin(0.4), 0, Math.cos(0.4))[0] - 0.5, 0);
  approx(r2 / r1, 2, 1e-6, 'equidistant radial mapping');
});

test('face: every expression × every face option paints cleanly', () => {
  const exprs = [...EXPRESSIONS, ...BLINK_EXPRESSIONS];
  let n = 0;
  for (const expr of exprs) {
    for (const eyes of O.eyes) for (const brows of O.brows) {
      const { ctx, calls } = mockCtx();
      paintFaceTexture(ctx, { ...DEFAULT_APPEARANCE, eyes, brows }, expr, FACE_TEX_SIZE);
      assert(calls.length > 20, `${expr}/${eyes}/${brows} painted`);
      n++;
    }
    for (const mouth of O.mouths) for (const nose of O.noses) for (const accessory of O.accessories) {
      const { ctx } = mockCtx();
      paintFaceTexture(ctx, { ...DEFAULT_APPEARANCE, mouth, nose, accessory }, expr, 256);
      n++;
    }
  }
  assert(n > 2000, `${n} combinations`);
});

test('face: presets + extreme colours paint; unknown expression falls back', () => {
  for (const p of PRESETS) for (const e of EXPRESSIONS) paintFaceFeatures(mockCtx().ctx, p, e);
  paintFaceFeatures(mockCtx().ctx, { ...DEFAULT_APPEARANCE, skin: '#000000', hair: { style: 'bald', color: '#ffffff' } }, 'hurt');
  assert.equal(normalizeExpression('furious'), 'neutral');
  assert.equal(normalizeExpression('ko'), 'ko');
  assert.equal(normalizeExpression('neutral-blink'), 'neutral-blink');
});

test('face: expressions actually differ (eyes are the first thing that changes)', () => {
  const sig = (e) => { const { ctx, calls } = mockCtx(); paintFaceFeatures(ctx, PRESETS[0], e); return calls.join(','); };
  const all = EXPRESSIONS.map(sig);
  assert.equal(new Set(all).size, EXPRESSIONS.length, 'each expression paints a distinct sequence');
});

test('face: 2D portrait draws every preset', () => {
  for (const p of PRESETS) {
    const { ctx, calls } = mockCtx();
    drawPortrait(ctx, p, { size: 128, expression: 'happy' });
    assert(calls.length > 30, p.label);
  }
});

test('face: texture cache is safe without a DOM (returns null, no throw)', () => {
  const t = acquireFaceTexture(PRESETS[1], 'hurt');
  assert(t === null || typeof t === 'object');
  releaseFaceTexture(PRESETS[1], 'hurt');
  releaseFaceTexture(PRESETS[1], 'never-acquired');
  assert.equal(faceKey(PRESETS[1]), faceKey({ ...PRESETS[1], gloves: '#000000', height: 0.95 }), 'clothes do not change the face key');
  assert.notEqual(faceKey(PRESETS[1]), faceKey({ ...PRESETS[1], eyes: 'dot' }));
});

test('face: colour helpers', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(shadeHex('#808080', 1), '#ffffff');
  assert.equal(shadeHex('#808080', -1), '#000000');
  assert(luminance('#ffffff') > 0.99 && luminance('#000000') < 0.01);
});
