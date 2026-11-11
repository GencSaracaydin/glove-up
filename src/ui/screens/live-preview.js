// Mirrored webcam preview + skeleton for camera setup, calibration, tracking-lost and the HUD PiP.
// Uses input/preview.js drawPreview() when available; otherwise draws the (mirrored) video and a
// simple skeleton itself, so the screens always work.

import { LM } from '../../core/types.js';
import { h } from './kit.js';

const BONES = [
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST], [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP], [LM.LEFT_HIP, LM.RIGHT_HIP], [LM.LEFT_EAR, LM.NOSE], [LM.NOSE, LM.RIGHT_EAR],
];
const COLORS = ['#3d7bff', '#ff4d5e'];

/** Fallback drawing (no input/preview.js): mirrored video + simple skeleton. */
export function drawFallbackPreview(ctx, video, frame, { mirrored = true, highlight = null } = {}) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.fillStyle = '#14182b';
  ctx.fillRect(0, 0, cw, ch);
  const hasVideo = !!(video && video.readyState >= 2 && video.videoWidth > 0);
  const vw = hasVideo ? video.videoWidth : frame?.width || 640;
  const vh = hasVideo ? video.videoHeight : frame?.height || 480;
  const s = Math.max(cw / vw, ch / vh);
  const rect = { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  if (hasVideo) {
    ctx.save();
    if (mirrored) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
    try { ctx.drawImage(video, mirrored ? cw - rect.x - rect.w : rect.x, rect.y, rect.w, rect.h); } catch { /* not ready */ }
    ctx.restore();
  }
  const players = frame?.players || [];
  players.forEach((pose, i) => {
    if (!pose?.image) return;
    const P = (l) => ({ x: rect.x + (mirrored ? 1 - l.x : l.x) * rect.w, y: rect.y + l.y * rect.h });
    const dimmed = highlight !== null && highlight !== undefined && highlight !== true && highlight !== i;
    ctx.save();
    ctx.globalAlpha = dimmed ? 0.35 : 1;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, cw / 160);
    ctx.strokeStyle = COLORS[i] || '#ffffff';
    for (const [a, b] of BONES) {
      const la = pose.image[a], lb = pose.image[b];
      if (!la || !lb || (la.visibility ?? 1) < 0.35 || (lb.visibility ?? 1) < 0.35) continue;
      const pa = P(la), pb = P(lb);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    for (const j of [LM.LEFT_WRIST, LM.RIGHT_WRIST, LM.NOSE]) {
      const l = pose.image[j];
      if (!l || (l.visibility ?? 1) < 0.35) continue;
      const p = P(l);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(5, cw / 90), 0, Math.PI * 2);
      ctx.fillStyle = '#fffaf0'; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  });
  return rect;
}

/**
 * A preview canvas that redraws on demand.
 * @param {import('../ui.js').ScreenCtx} sctx
 * @param {{players?:1|2, highlight?:number|boolean, cls?:string, halves?:boolean, labels?:boolean, dim?:number}} [opts]
 * @returns {{el:HTMLElement, canvas:HTMLCanvasElement, draw:()=>any, setHighlight:(i:any)=>void}}
 */
export function livePreview(sctx, opts = {}) {
  const canvas = h('canvas', { class: 'gu-preview__canvas', 'aria-hidden': 'true' });
  const overlay = h('div', { class: 'gu-preview__overlay' });
  const el = h('div', { class: `gu-preview${opts.cls ? ' ' + opts.cls : ''}${opts.halves ? ' gu-preview--halves' : ''}` }, canvas, overlay);
  let highlight = opts.highlight ?? true;
  let lastW = 0, lastH = 0;
  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const hh = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (w !== lastW || hh !== lastH) { canvas.width = w; canvas.height = hh; lastW = w; lastH = hh; }
  }
  function draw() {
    if (!canvas.isConnected) return null;
    size();
    const c = canvas.getContext('2d');
    if (!c) return null;
    const video = sctx.ui.getVideo();
    // no new camera frame for a while (frozen / unplugged camera): don't keep drawing an old skeleton
    const st = sctx.input?.status;
    const frame = Number.isFinite(st?.frameAgeMs) && st.frameAgeMs > 600 ? null : sctx.ui.latestFrame();
    const mirrored = sctx.settings()?.mirror !== false;
    const mod = sctx.deps.peek('preview');
    try {
      if (mod && typeof mod.drawPreview === 'function') {
        return mod.drawPreview(c, video, frame, { mirrored, players: opts.players || 1, highlight, labels: opts.labels !== false, dim: opts.dim ?? 0.06 });
      }
    } catch (e) {
      if (!draw.warned) { console.warn('[ui] drawPreview failed — using built-in preview', e); draw.warned = true; }
    }
    return drawFallbackPreview(c, video, frame, { mirrored, highlight });
  }
  return { el, canvas, overlay, draw, setHighlight: (i) => { highlight = i; } };
}
