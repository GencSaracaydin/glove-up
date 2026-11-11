// Webcam preview + skeleton overlay (2D canvas). Used by the camera-setup and calibration
// screens, the HUD picture-in-picture and the dev input lab.
//
//   drawPreview(ctx, video, frame, { mirrored: true, players, highlight, labels, fit, ... }) → rect
//   drawSkeleton(ctx, frameOrPose, { mirrored, rect, ... })                               → rect
//
// The preview is MIRRORED by default (move right → moves right on screen). Landmarks are raw
// camera-normalized, so both the image and the skeleton are flipped together. Each player has
// its own colour (P1 blue, P2 red — the corner colours of style.js); extra people/posters the
// PlayerAssigner ignored are drawn faint grey so players can see why they aren't picked.
//
// Pure module: only touches the canvas context it is given.

import { LM } from '../core/types.js';

/** Per-player colours (match PALETTE.p1Accent / p2Accent in render/style.js). */
export const PLAYER_COLORS = Object.freeze(['#3d7bff', '#ff4d5e']);
export const IGNORED_COLOR = 'rgba(214, 220, 236, 0.5)';
const OUTLINE = 'rgba(12, 14, 28, 0.55)';

/** Bones drawn for the preview skeleton. */
export const SKELETON_EDGES = Object.freeze([
  // head
  [LM.LEFT_EAR, LM.LEFT_EYE], [LM.LEFT_EYE, LM.NOSE], [LM.NOSE, LM.RIGHT_EYE], [LM.RIGHT_EYE, LM.RIGHT_EAR],
  [LM.MOUTH_LEFT, LM.MOUTH_RIGHT],
  // torso
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], [LM.LEFT_SHOULDER, LM.LEFT_HIP], [LM.RIGHT_SHOULDER, LM.RIGHT_HIP], [LM.LEFT_HIP, LM.RIGHT_HIP],
  // arms + hands
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST], [LM.LEFT_WRIST, LM.LEFT_INDEX], [LM.LEFT_WRIST, LM.LEFT_PINKY],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST], [LM.RIGHT_WRIST, LM.RIGHT_INDEX], [LM.RIGHT_WRIST, LM.RIGHT_PINKY],
  // legs
  [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE], [LM.LEFT_ANKLE, LM.LEFT_FOOT_INDEX],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE], [LM.RIGHT_ANKLE, LM.RIGHT_FOOT_INDEX],
]);
const ARM_EDGES = new Set([9, 10, 13, 14].map(String)); // indices into SKELETON_EDGES drawn thicker
const JOINTS = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_HIP, LM.RIGHT_HIP,
  LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];

/**
 * Where a `vw×vh` image lands inside a `cw×ch` canvas.
 * @param {'cover'|'contain'} fit
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function fitRect(cw, ch, vw, vh, fit = 'cover') {
  if (!(vw > 0 && vh > 0)) return { x: 0, y: 0, w: cw, h: ch };
  const s = fit === 'contain' ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh);
  const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** Raw normalized landmark → canvas pixel inside `rect`. */
export function toCanvas(l, rect, mirrored = true) {
  return { x: rect.x + (mirrored ? 1 - l.x : l.x) * rect.w, y: rect.y + l.y * rect.h };
}

/**
 * Draw the (mirrored) webcam image and the skeleton overlay.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLVideoElement|null} video
 * @param {import('../core/types.js').PoseFrame|null} frame   assigned frame (players[0]=P1); may carry `ignored`
 * @param {Object} [opts]
 * @param {boolean} [opts.mirrored=true]
 * @param {number|Array<string|{label?:string,color?:string}>} [opts.players]  count, or labels/colours per player
 * @param {boolean|number} [opts.highlight=true]  true = wrist/head markers; a number = emphasise that player, dim others
 * @param {boolean} [opts.labels=true]   "P1"/"P2" (or names) tags above heads
 * @param {'cover'|'contain'} [opts.fit='cover']
 * @param {boolean} [opts.showIgnored=true]
 * @param {number} [opts.dim=0]          0..1 darken the video so the skeleton pops
 * @param {string} [opts.background='#14182b']
 * @param {number} [opts.minVisibility=0.35]
 * @returns {{x:number, y:number, w:number, h:number}} where the camera image was drawn
 */
export function drawPreview(ctx, video, frame, opts = {}) {
  const { mirrored = true, fit = 'cover', dim = 0, background = '#14182b' } = opts;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const hasVideo = !!(video && video.readyState >= 2 && video.videoWidth > 0);
  const vw = hasVideo ? video.videoWidth : (frame && frame.width) || 640;
  const vh = hasVideo ? video.videoHeight : (frame && frame.height) || 480;
  const rect = fitRect(cw, ch, vw, vh, fit);
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cw, ch);
  if (hasVideo) {
    ctx.save();
    if (mirrored) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
    const rx = mirrored ? cw - rect.x - rect.w : rect.x;
    try { ctx.drawImage(video, rx, rect.y, rect.w, rect.h); } catch { /* frame not decodable yet */ }
    ctx.restore();
    if (dim > 0) { ctx.fillStyle = `rgba(20, 24, 43, ${Math.min(1, dim)})`; ctx.fillRect(0, 0, cw, ch); }
  } else if (frame) {
    // no picture (replay, keyboard PiP): show where the camera frame is so the skeleton has context
    ctx.fillStyle = 'rgba(255, 250, 240, 0.035)';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
  if (frame) drawSkeleton(ctx, frame, { ...opts, rect, mirrored });
  return rect;
}

/**
 * Draw skeleton(s) without video (or on top of something else).
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/types.js').PoseFrame|import('../core/types.js').PlayerPose|null} frameOrPose
 * @param {Object} [opts] as drawPreview, plus `rect` (target area; default = contain-fit of the frame in the canvas)
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function drawSkeleton(ctx, frameOrPose, opts = {}) {
  const { mirrored = true, labels = true, highlight = true, showIgnored = true, minVisibility = 0.35 } = opts;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const frame = !frameOrPose ? null
    : frameOrPose.image ? { t: 0, width: 640, height: 480, players: [frameOrPose] } : frameOrPose;
  const rect = opts.rect || fitRect(cw, ch, (frame && frame.width) || 640, (frame && frame.height) || 480, 'contain');
  if (!frame) return rect;
  const scale = Math.max(1, Math.min(rect.w, rect.h) / 240);
  const styles = playerStyles(opts.players, frame.players ? frame.players.length : 0);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (showIgnored && Array.isArray(frame.ignored)) {
    for (const pose of frame.ignored) drawBones(ctx, pose, rect, mirrored, minVisibility, IGNORED_COLOR, 1.4 * scale, false);
  }
  (frame.players || []).forEach((pose, i) => {
    if (!pose) return;
    const st = styles[i] || styles[styles.length - 1];
    const dimmed = typeof highlight === 'number' && highlight !== i;
    ctx.globalAlpha = dimmed ? 0.35 : 1;
    drawBones(ctx, pose, rect, mirrored, minVisibility, st.color, 3 * scale, true);
    drawJoints(ctx, pose, rect, mirrored, minVisibility, st.color, scale);
    if (highlight !== false && !dimmed) drawMarkers(ctx, pose, rect, mirrored, minVisibility, st.color, scale);
    if (labels) drawLabel(ctx, pose, rect, mirrored, minVisibility, st, scale);
  });
  ctx.restore();
  return rect;
}

function playerStyles(players, n) {
  const count = Math.max(2, typeof players === 'number' ? players : Array.isArray(players) ? players.length : n);
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = Array.isArray(players) ? players[i] : null;
    const label = typeof p === 'string' ? p : (p && p.label) || `P${i + 1}`;
    const color = (p && typeof p === 'object' && p.color) || PLAYER_COLORS[i % PLAYER_COLORS.length];
    out.push({ label, color });
  }
  return out;
}

const vis = (l, min) => !!l && (l.visibility ?? 1) >= min;

function drawBones(ctx, pose, rect, mirrored, minV, color, width, outline) {
  const im = pose.image;
  if (!im) return;
  const passes = outline ? [[OUTLINE, width + 2.5], [color, width]] : [[color, width]];
  for (const [stroke, w] of passes) {
    ctx.strokeStyle = stroke;
    SKELETON_EDGES.forEach(([a, b], k) => {
      const la = im[a], lb = im[b];
      if (!vis(la, minV) || !vis(lb, minV)) return;
      const pa = toCanvas(la, rect, mirrored), pb = toCanvas(lb, rect, mirrored);
      ctx.lineWidth = ARM_EDGES.has(String(k)) ? w * 1.35 : w;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    });
  }
}

function drawJoints(ctx, pose, rect, mirrored, minV, color, scale) {
  const im = pose.image;
  for (const j of JOINTS) {
    const l = im[j];
    if (!vis(l, minV)) continue;
    const p = toCanvas(l, rect, mirrored);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.2 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.6 * scale; ctx.strokeStyle = color; ctx.stroke();
  }
}

/** Big glove markers on the wrists and a ring around the head (what the game reads). */
function drawMarkers(ctx, pose, rect, mirrored, minV, color, scale) {
  const im = pose.image;
  for (const j of [LM.LEFT_WRIST, LM.RIGHT_WRIST]) {
    const l = im[j];
    if (!vis(l, minV)) continue;
    const p = toCanvas(l, rect, mirrored);
    ctx.beginPath(); ctx.arc(p.x, p.y, 8 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2.5 * scale; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  const nose = im[LM.NOSE];
  if (vis(nose, minV)) {
    const p = toCanvas(nose, rect, mirrored);
    const r = headRadius(im, rect, mirrored, minV) || 18 * scale;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2.5 * scale; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.lineWidth = 1.6 * scale; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
}

function headRadius(im, rect, mirrored, minV) {
  const le = im[LM.LEFT_EAR], re = im[LM.RIGHT_EAR];
  if (vis(le, minV) && vis(re, minV)) {
    const a = toCanvas(le, rect, mirrored), b = toCanvas(re, rect, mirrored);
    return Math.max(10, Math.hypot(a.x - b.x, a.y - b.y) * 0.75);
  }
  const ls = im[LM.LEFT_SHOULDER], rs = im[LM.RIGHT_SHOULDER];
  if (vis(ls, minV) && vis(rs, minV)) {
    const a = toCanvas(ls, rect, mirrored), b = toCanvas(rs, rect, mirrored);
    return Math.max(10, Math.hypot(a.x - b.x, a.y - b.y) * 0.32);
  }
  return 0;
}

function drawLabel(ctx, pose, rect, mirrored, minV, st, scale) {
  const im = pose.image;
  let anchor = null;
  if (vis(im[LM.NOSE], minV)) anchor = toCanvas(im[LM.NOSE], rect, mirrored);
  else if (vis(im[LM.LEFT_SHOULDER], minV) && vis(im[LM.RIGHT_SHOULDER], minV)) {
    const a = toCanvas(im[LM.LEFT_SHOULDER], rect, mirrored), b = toCanvas(im[LM.RIGHT_SHOULDER], rect, mirrored);
    anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (!anchor) return;
  const r = headRadius(im, rect, mirrored, minV) || 18 * scale;
  const fontPx = Math.round(11 * scale);
  ctx.font = `900 ${fontPx}px Nunito, system-ui, sans-serif`;
  const text = st.label;
  const tw = ctx.measureText(text).width;
  const padX = 6 * scale, h = fontPx + 6 * scale;
  const x = Math.min(Math.max(anchor.x - tw / 2 - padX, rect.x + 2), rect.x + rect.w - tw - padX * 2 - 2);
  const y = Math.max(rect.y + 2, anchor.y - r - h - 4 * scale);
  ctx.globalAlpha = Math.min(1, ctx.globalAlpha);
  ctx.fillStyle = st.color;
  roundRect(ctx, x, y, tw + padX * 2, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 0.5);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
