// preview.js: cover/contain fitting, mirrored landmark mapping, per-player colours, ignored
// people drawn faint, video drawn mirrored — against a recording fake 2D context.
import { test, assert, approx } from '../harness.mjs';
import { fitRect, toCanvas, drawPreview, drawSkeleton, PLAYER_COLORS, IGNORED_COLOR } from '../../src/input/preview.js';

function fakeCtx(w = 640, h = 480) {
  const calls = [];
  const state = { strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, font: '' };
  const rec = (name) => (...args) => calls.push({ name, args, strokeStyle: state.strokeStyle, fillStyle: state.fillStyle, alpha: state.globalAlpha });
  const ctx = {
    canvas: { width: w, height: h }, calls,
    save: rec('save'), restore: rec('restore'), translate: rec('translate'), scale: rec('scale'),
    fillRect: rec('fillRect'), drawImage: rec('drawImage'), beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), fill: rec('fill'), arc: rec('arc'), arcTo: rec('arcTo'), closePath: rec('closePath'), fillText: rec('fillText'),
    measureText: (s) => ({ width: s.length * 7 }),
  };
  for (const k of Object.keys(state)) Object.defineProperty(ctx, k, { get: () => state[k], set: (v) => { state[k] = v; } });
  ctx.lineCap = ''; ctx.lineJoin = ''; ctx.textBaseline = '';
  return ctx;
}

const pose = (x, vis = 0.95) => {
  const image = Array.from({ length: 33 }, () => ({ x, y: 0.5, z: 0, visibility: vis }));
  image[11] = { x: x + 0.1, y: 0.4, z: 0, visibility: vis }; image[12] = { x: x - 0.1, y: 0.4, z: 0, visibility: vis };
  image[15] = { x: x + 0.15, y: 0.3, z: 0, visibility: vis }; image[16] = { x: x - 0.15, y: 0.3, z: 0, visibility: vis };
  image[0] = { x, y: 0.25, z: 0, visibility: vis };
  return { image, world: image.map(() => ({ x: 0, y: 0, z: 0 })), score: vis };
};

test('preview: cover and contain fitting', () => {
  const c = fitRect(1280, 720, 640, 480, 'cover');
  approx(c.w, 1280, 1e-9); approx(c.h, 960, 1e-9); approx(c.y, -120, 1e-9);
  const k = fitRect(1280, 720, 640, 480, 'contain');
  approx(k.h, 720, 1e-9); approx(k.w, 960, 1e-9); approx(k.x, 160, 1e-9);
  const z = fitRect(100, 100, 0, 0);
  assert(z.w === 100 && z.h === 100);
});

test('preview: landmarks are mirrored like the image (raw x 0.2 → right side of the canvas)', () => {
  const r = { x: 0, y: 0, w: 1000, h: 500 };
  approx(toCanvas({ x: 0.2, y: 0.5 }, r, true).x, 800, 1e-9);
  approx(toCanvas({ x: 0.2, y: 0.5 }, r, false).x, 200, 1e-9);
  approx(toCanvas({ x: 0.2, y: 0.5 }, r, true).y, 250, 1e-9);
});

test('preview: per-player colours, faint ignored people, labels, dimmed non-highlighted player', () => {
  const ctx = fakeCtx();
  const frame = { t: 0, width: 640, height: 480, players: [pose(0.7), pose(0.3)], ignored: [pose(0.5, 0.9)] };
  drawSkeleton(ctx, frame, { rect: { x: 0, y: 0, w: 640, h: 480 }, players: ['Ana', 'Ben'], highlight: 1 });
  const strokes = ctx.calls.filter((c) => c.name === 'stroke').map((c) => c.strokeStyle);
  assert(strokes.includes(PLAYER_COLORS[0]) && strokes.includes(PLAYER_COLORS[1]) && strokes.includes(IGNORED_COLOR));
  const labels = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert(labels.includes('Ana') && labels.includes('Ben'));
  const p1Strokes = ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === PLAYER_COLORS[0]);
  assert(p1Strokes.every((c) => c.alpha < 0.5), 'P1 dimmed when P2 is highlighted');
  // P1 (raw x 0.7) is drawn on the LEFT half of the mirrored preview
  const p1Moves = ctx.calls.filter((c) => c.name === 'moveTo' && c.strokeStyle === PLAYER_COLORS[0]);
  assert(p1Moves.length && p1Moves.every((c) => c.args[0] < 320 + 70));
});

test('preview: invisible landmarks are skipped; null players are fine', () => {
  const ctx = fakeCtx();
  drawSkeleton(ctx, { t: 0, width: 640, height: 480, players: [pose(0.5, 0.1), null] });
  assert(!ctx.calls.some((c) => c.name === 'stroke'), 'nothing drawn for low-visibility pose');
  drawSkeleton(ctx, null);
});

test('preview: video is drawn mirrored and the camera rect is returned', () => {
  const ctx = fakeCtx(1280, 720);
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
  const rect = drawPreview(ctx, video, { t: 0, width: 640, height: 480, players: [pose(0.6)] }, { fit: 'contain', dim: 0.2 });
  approx(rect.w, 960, 1e-9);
  const scale = ctx.calls.find((c) => c.name === 'scale');
  assert(scale && scale.args[0] === -1, 'mirrored');
  assert(ctx.calls.some((c) => c.name === 'drawImage'));
  const noVideo = fakeCtx();
  drawPreview(noVideo, null, null);
  assert(!noVideo.calls.some((c) => c.name === 'drawImage') && noVideo.calls.some((c) => c.name === 'fillRect'));
});
