// Boxer portraits for menus and the HUD.
//
//  * drawPortrait2D(ctx, appearance, opts) — our own flat, friendly bust drawing from the
//    Appearance kit (egg head, simple painted features, singlet, chunky gloves). Always
//    available, instant, used everywhere as the base layer.
//  * PortraitStudio — when render/boxer-model.js is available, renders the real 3D BoxerModel
//    in ONE small shared WebGL renderer (portraits never cost more than one extra GL context)
//    and copies the image into 2D canvases. Live mode (editor) re-renders every frame.
//  * portraits.element(appearance, opts) — a <canvas> that shows the 2D drawing immediately
//    and upgrades itself to the 3D render as soon as the studio is ready.
//
// No DOM/WebGL is touched at import time.

import * as THREE from 'three';
import { LIGHTING, PALETTE, css } from '../../render/style.js';
import { validLook, contrastInk } from './kit.js';

/** Portrait tunables. */
export const PORTRAIT_TUNING = Object.freeze({
  /** Yaw (radians) added so the model faces the portrait camera (models face +Z by convention). */
  modelFacingYaw: 0,
  /** Default three-quarter turn of portraits (radians, + = model turns to its left). */
  yaw: 0.32,
  /** Field of view of the portrait camera (deg). */
  fov: 24,
  /** Max cached BoxerModels (LRU). */
  maxModels: 6,
  /** Max cached portrait renders (each renderSize² RGBA). */
  maxSnapshots: 40,
  /** Internal render size for portraits (px, square). */
  renderSize: 320,
  /** Right-glove target for the portrait pose (boxer perspective, shoulder widths); left is mirrored. */
  hand: Object.freeze({ x: 0.5, y: -0.3, reach: 0.18 }),
  /** Framing reference when render/boxer-model.js exports headWorldPosition: "top" = head centre + this (m),
   *  so tall hair (afro, mohawk) never pushes the face out of the frame. */
  headToTop: 0.215,
});

// ───────────────────────────── colour helpers ─────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Lighten (amt > 0) or darken (amt < 0) a hex colour, amt in -1..1. */
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

// ───────────────────────────── 2D portrait ─────────────────────────────

/**
 * Draw a bust portrait.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../../core/types.js').Appearance} appearance
 * @param {{size?:number, x?:number, y?:number, bg?:string|null, ring?:string|null, gloves?:boolean, mirror?:boolean, expression?:string}} [opts]
 */
export function drawPortrait2D(ctx, appearance, opts = {}) {
  const a = validLook(appearance);
  const S = opts.size ?? Math.min(ctx.canvas.width, ctx.canvas.height);
  const ox = opts.x ?? 0, oy = opts.y ?? 0;
  ctx.save();
  ctx.translate(ox, oy);
  if (opts.mirror) { ctx.translate(S, 0); ctx.scale(-1, 1); }
  // Circular frame + background
  const bg = opts.bg === undefined ? shade(a.top === 'none' ? a.trunks : a.top, 0.55) : opts.bg;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  if (bg) { ctx.fillStyle = bg; ctx.fill(); }
  ctx.clip();
  if (bg) {
    // soft floor glow
    const g = ctx.createRadialGradient(S * 0.5, S * 0.35, S * 0.05, S * 0.5, S * 0.45, S * 0.7);
    g.addColorStop(0, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  const lw = Math.max(1, S * 0.014);
  const ink = '#14182b';
  const cx = S * 0.5, cy = S * 0.44;
  const rx = S * 0.205, ry = S * 0.235;
  const skin = a.skin;
  const skinDark = shade(skin, -0.28);
  const hair = a.hair.color;
  const hairDark = shade(hair, -0.35);
  const buildW = a.build === 'heavy' ? 0.98 : a.build === 'slim' ? 0.74 : 0.86;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ── torso (singlet or bare) ──
  const topCol = a.top === 'none' ? skin : a.top;
  const tw = S * buildW;
  const ty = S * 0.79;
  ctx.beginPath();
  roundedTop(ctx, cx - tw / 2, ty, tw, S * 0.45, S * 0.16);
  ctx.fillStyle = topCol;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = shade(topCol, -0.45);
  ctx.stroke();
  if (a.top !== 'none') {
    // singlet neckline + straps in skin, trimmed with the trim colour
    ctx.beginPath();
    ctx.moveTo(cx - S * 0.13, ty - 1);
    ctx.quadraticCurveTo(cx, ty + S * 0.12, cx + S * 0.13, ty - 1);
    ctx.closePath();
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.lineWidth = lw * 1.4;
    ctx.strokeStyle = a.trim;
    ctx.stroke();
    // arm holes
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * tw * 0.47, ty + S * 0.16, S * 0.075, S * 0.15, 0, 0, Math.PI * 2);
      ctx.fillStyle = skin;
      ctx.fill();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(cx - S * 0.1, ty + S * 0.09);
    ctx.quadraticCurveTo(cx, ty + S * 0.13, cx + S * 0.1, ty + S * 0.09);
    ctx.lineWidth = lw;
    ctx.strokeStyle = skinDark;
    ctx.stroke();
  }

  // ── neck ──
  ctx.beginPath();
  ctx.rect(cx - S * 0.075, cy + ry * 0.55, S * 0.15, S * 0.16);
  ctx.fillStyle = skin;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - S * 0.075, cy + ry * 0.8);
  ctx.quadraticCurveTo(cx, cy + ry * 0.98, cx + S * 0.075, cy + ry * 0.8);
  ctx.lineWidth = lw;
  ctx.strokeStyle = skinDark;
  ctx.stroke();

  // ── hair behind the head ──
  hairBack(ctx, a, { cx, cy, rx, ry, S, lw, hair, hairDark });

  // ── ears ──
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * rx * 0.98, cy + ry * 0.08, rx * 0.17, ry * 0.17, 0, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = skinDark;
    ctx.stroke();
  }
  if (a.accessory === 'earring') {
    ctx.beginPath();
    ctx.arc(cx - rx * 1.0, cy + ry * 0.3, S * 0.018, 0, Math.PI * 2);
    ctx.fillStyle = '#ffc94a';
    ctx.fill();
    ctx.lineWidth = lw * 0.7;
    ctx.strokeStyle = shade('#ffc94a', -0.45);
    ctx.stroke();
  }

  // ── head (egg) ──
  eggPath(ctx, cx, cy, rx, ry);
  ctx.fillStyle = skin;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = skinDark;
  ctx.stroke();
  // cheeks
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * rx * 0.55, cy + ry * 0.36, rx * 0.16, ry * 0.08, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 110, 110, 0.22)';
    ctx.fill();
  }

  // ── beard sits under the face features ──
  if (a.accessory === 'beard') {
    ctx.save();
    eggPath(ctx, cx, cy, rx * 1.02, ry * 1.02);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx - rx * 1.1, cy + ry * 0.15);
    ctx.quadraticCurveTo(cx - rx * 0.6, cy + ry * 0.5, cx, cy + ry * 0.42);
    ctx.quadraticCurveTo(cx + rx * 0.6, cy + ry * 0.5, cx + rx * 1.1, cy + ry * 0.15);
    ctx.lineTo(cx + rx * 1.1, cy + ry * 1.2);
    ctx.lineTo(cx - rx * 1.1, cy + ry * 1.2);
    ctx.closePath();
    ctx.fillStyle = hair;
    ctx.fill();
    ctx.restore();
  }

  // ── hair on top ──
  hairFront(ctx, a, { cx, cy, rx, ry, S, lw, hair, hairDark, skin });

  // ── face ──
  const eyeY = cy + ry * 0.06, eyeDX = rx * 0.4;
  drawBrows(ctx, a.brows, { cx, eyeY, eyeDX, rx, ry, lw, col: hairDark });
  drawEyes(ctx, a.eyes, { cx, eyeY, eyeDX, rx, ry, lw, ink, skin, expression: opts.expression });
  drawNose(ctx, a.nose, { cx, cy, rx, ry, lw, skin, skinDark });
  if (a.accessory === 'moustache') {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * rx * 0.2, cy + ry * 0.44, rx * 0.22, ry * 0.075, s * -0.25, 0, Math.PI * 2);
      ctx.fillStyle = hair;
      ctx.fill();
    }
  }
  drawMouth(ctx, a.accessory === 'mouthguard' ? 'guard' : a.mouth, { cx, cy, rx, ry, lw, ink, trim: a.trim });
  drawAccessory(ctx, a, { cx, cy, rx, ry, lw, ink, S, eyeY, eyeDX });

  // ── chunky gloves peeking in at the bottom ──
  if (opts.gloves !== false) {
    for (const s of [-1, 1]) {
      const gx = cx + s * S * 0.36, gy = S * 0.93;
      ctx.beginPath();
      ctx.ellipse(gx, gy, S * 0.135, S * 0.12, s * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = a.gloves;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = shade(a.gloves, -0.45);
      ctx.stroke();
      // highlight
      ctx.beginPath();
      ctx.ellipse(gx - s * S * 0.03, gy - S * 0.05, S * 0.045, S * 0.025, s * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();
      // thumb seam (inner side)
      ctx.beginPath();
      ctx.moveTo(gx - s * S * 0.075, gy - S * 0.075);
      ctx.quadraticCurveTo(gx - s * S * 0.005, gy - S * 0.01, gx - s * S * 0.06, gy + S * 0.065);
      ctx.lineWidth = lw * 0.8;
      ctx.strokeStyle = shade(a.gloves, -0.35);
      ctx.stroke();
    }
  }
  ctx.restore();
  // ring outline
  if (opts.ring) {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - lw * 1.2, 0, Math.PI * 2);
    ctx.lineWidth = lw * 2.4;
    ctx.strokeStyle = opts.ring;
    ctx.stroke();
    ctx.restore();
  }
}

function roundedTop(ctx, x, y, w, h, r) {
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** Egg: rounder crown, slightly narrower chin. */
function eggPath(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry);
  ctx.bezierCurveTo(cx + rx * 0.56, cy - ry, cx + rx, cy - ry * 0.6, cx + rx, cy - ry * 0.05);
  ctx.bezierCurveTo(cx + rx, cy + ry * 0.55, cx + rx * 0.58, cy + ry, cx, cy + ry);
  ctx.bezierCurveTo(cx - rx * 0.58, cy + ry, cx - rx, cy + ry * 0.55, cx - rx, cy - ry * 0.05);
  ctx.bezierCurveTo(cx - rx, cy - ry * 0.6, cx - rx * 0.56, cy - ry, cx, cy - ry);
  ctx.closePath();
}

/** Fill the scalp above a hairline (clipped to an enlarged head). */
function cap(ctx, g, { hairlineY = 0.38, templeY = 0.02, grow = 1.07, lift = 0.02 } = {}) {
  const { cx, cy, rx, ry } = g;
  ctx.save();
  eggPath(ctx, cx, cy - ry * lift, rx * grow, ry * grow);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(cx - rx * 1.3, cy + ry * templeY);
  ctx.lineTo(cx - rx * 1.3, cy - ry * 1.4);
  ctx.lineTo(cx + rx * 1.3, cy - ry * 1.4);
  ctx.lineTo(cx + rx * 1.3, cy + ry * templeY);
  ctx.quadraticCurveTo(cx, cy - ry * (hairlineY * 2 - templeY), cx - rx * 1.3, cy + ry * templeY);
  ctx.closePath();
  ctx.fillStyle = g.hair;
  ctx.fill();
  ctx.restore();
}

function hairBack(ctx, a, g) {
  const { cx, cy, rx, ry, S, lw, hair, hairDark } = g;
  ctx.fillStyle = hair;
  ctx.strokeStyle = hairDark;
  ctx.lineWidth = lw;
  switch (a.hair.style) {
    case 'afro':
      ctx.beginPath();
      ctx.arc(cx, cy - ry * 0.28, rx * 1.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 'bob':
      ctx.beginPath();
      ctx.moveTo(cx - rx * 1.18, cy + ry * 0.62);
      ctx.lineTo(cx - rx * 1.2, cy - ry * 0.3);
      ctx.quadraticCurveTo(cx - rx * 1.15, cy - ry * 1.18, cx, cy - ry * 1.16);
      ctx.quadraticCurveTo(cx + rx * 1.15, cy - ry * 1.18, cx + rx * 1.2, cy - ry * 0.3);
      ctx.lineTo(cx + rx * 1.18, cy + ry * 0.62);
      ctx.quadraticCurveTo(cx, cy + ry * 0.72, cx - rx * 1.18, cy + ry * 0.62);
      ctx.fill();
      ctx.stroke();
      break;
    case 'ponytail':
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.7, cy - ry * 0.7);
      ctx.quadraticCurveTo(cx + rx * 1.75, cy - ry * 0.5, cx + rx * 1.45, cy + ry * 0.75);
      ctx.quadraticCurveTo(cx + rx * 1.2, cy + ry * 0.2, cx + rx * 0.85, cy - ry * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // band
      ctx.beginPath();
      ctx.arc(cx + rx * 1.12, cy - ry * 0.52, S * 0.02, 0, Math.PI * 2);
      ctx.fillStyle = a.trim;
      ctx.fill();
      break;
    case 'bun':
      ctx.beginPath();
      ctx.arc(cx, cy - ry * 1.12, rx * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 'curly':
      for (let i = 0; i < 9; i++) {
        const t = Math.PI * (1.02 + (i / 8) * 0.96);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(t) * rx * 1.02, cy - ry * 0.12 + Math.sin(t) * ry * 0.98, rx * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    default:
      break;
  }
}

function hairFront(ctx, a, g) {
  const { cx, cy, rx, ry, S, lw, hair, hairDark } = g;
  const style = a.hair.style;
  switch (style) {
    case 'buzz':
      ctx.save();
      ctx.globalAlpha = 0.78;
      cap(ctx, g, { hairlineY: 0.48, templeY: -0.08, grow: 1.02, lift: 0.0 });
      ctx.restore();
      break;
    case 'crew':
      cap(ctx, g, { hairlineY: 0.42, templeY: 0.0, grow: 1.08 });
      // little fringe flick
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.25, cy - ry * 0.52);
      ctx.quadraticCurveTo(cx + rx * 0.05, cy - ry * 0.32, cx + rx * 0.35, cy - ry * 0.5);
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      ctx.stroke();
      break;
    case 'spiky': {
      cap(ctx, g, { hairlineY: 0.42, templeY: -0.02, grow: 1.06 });
      const n = 7;
      const at = (t, k) => [cx + Math.cos(t) * rx * k, cy - ry * 0.18 + Math.sin(t) * ry * k * 0.95];
      ctx.beginPath();
      const [x0, y0] = at(Math.PI, 0.96);
      ctx.moveTo(x0, y0);
      for (let i = 0; i < n; i++) {
        const t0 = Math.PI * (1 + i / n), t1 = Math.PI * (1 + (i + 1) / n);
        const [px, py] = at((t0 + t1) / 2, 1.36);
        const [qx, qy] = at(t1, 0.96);
        ctx.lineTo(px, py);
        ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.fillStyle = hair;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      ctx.stroke();
      break;
    }
    case 'mohawk':
      ctx.save();
      ctx.globalAlpha = 0.25;
      cap(ctx, g, { hairlineY: 0.48, templeY: -0.1, grow: 1.01, lift: 0 });
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.2, cy - ry * 0.55);
      ctx.quadraticCurveTo(cx - rx * 0.28, cy - ry * 1.55, cx, cy - ry * 1.5);
      ctx.quadraticCurveTo(cx + rx * 0.28, cy - ry * 1.55, cx + rx * 0.2, cy - ry * 0.55);
      ctx.closePath();
      ctx.fillStyle = hair;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      ctx.stroke();
      break;
    case 'bun':
      cap(ctx, g, { hairlineY: 0.46, templeY: -0.02, grow: 1.05 });
      break;
    case 'ponytail':
      cap(ctx, g, { hairlineY: 0.44, templeY: 0.0, grow: 1.06 });
      break;
    case 'afro':
      cap(ctx, g, { hairlineY: 0.46, templeY: 0.05, grow: 1.08 });
      break;
    case 'curly':
      cap(ctx, g, { hairlineY: 0.42, templeY: 0.0, grow: 1.08 });
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(cx - rx * 0.6 + i * rx * 0.3, cy - ry * 0.48 + (i % 2) * ry * 0.06, rx * 0.17, 0, Math.PI * 2);
        ctx.fillStyle = hair;
        ctx.fill();
      }
      break;
    case 'bald':
      ctx.beginPath();
      ctx.ellipse(cx - rx * 0.3, cy - ry * 0.68, rx * 0.22, ry * 0.1, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
      break;
    case 'flat-top':
      cap(ctx, g, { hairlineY: 0.44, templeY: -0.02, grow: 1.04 });
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.92, cy - ry * 0.55);
      ctx.lineTo(cx - rx * 0.88, cy - ry * 1.38);
      ctx.lineTo(cx + rx * 0.88, cy - ry * 1.38);
      ctx.lineTo(cx + rx * 0.92, cy - ry * 0.55);
      ctx.closePath();
      ctx.fillStyle = hair;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      ctx.stroke();
      break;
    case 'bob':
      cap(ctx, g, { hairlineY: 0.3, templeY: 0.08, grow: 1.1 });
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.95, cy - ry * 0.28);
      ctx.lineTo(cx + rx * 0.95, cy - ry * 0.28);
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      ctx.stroke();
      break;
    case 'cornrows':
      cap(ctx, g, { hairlineY: 0.46, templeY: -0.04, grow: 1.04 });
      ctx.save();
      eggPath(ctx, cx, cy, rx * 1.04, ry * 1.04);
      ctx.clip();
      ctx.lineWidth = lw;
      ctx.strokeStyle = hairDark;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + i * rx * 0.24, cy - ry * 0.5 + Math.abs(i) * ry * 0.06);
        ctx.quadraticCurveTo(cx + i * rx * 0.3, cy - ry * 0.95, cx + i * rx * 0.2, cy - ry * 1.3);
        ctx.stroke();
      }
      ctx.restore();
      break;
    default:
      cap(ctx, g, {});
  }
}

function drawEyes(ctx, style, g) {
  const { cx, eyeY, eyeDX, rx, ry, lw, ink } = g;
  for (const s of [-1, 1]) {
    const x = cx + s * eyeDX, y = eyeY;
    ctx.save();
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw * 1.6;
    switch (style) {
      case 'dot':
        ctx.beginPath(); ctx.arc(x, y, rx * 0.085, 0, Math.PI * 2); ctx.fill();
        break;
      case 'sleepy':
        ctx.beginPath(); ctx.ellipse(x, y + ry * 0.02, rx * 0.12, ry * 0.07, 0, 0, Math.PI); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x - rx * 0.15, y + ry * 0.01); ctx.lineTo(x + rx * 0.15, y + ry * 0.01); ctx.stroke();
        break;
      case 'fierce':
        ctx.beginPath();
        ctx.moveTo(x - s * rx * 0.15, y - ry * 0.06);
        ctx.lineTo(x + s * rx * 0.15, y + ry * 0.0);
        ctx.lineTo(x + s * rx * 0.08, y + ry * 0.08);
        ctx.lineTo(x - s * rx * 0.13, y + ry * 0.06);
        ctx.closePath();
        ctx.fill();
        break;
      case 'wide':
        ctx.beginPath(); ctx.arc(x, y, rx * 0.17, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.lineWidth = lw; ctx.stroke();
        ctx.beginPath(); ctx.arc(x + s * rx * 0.02, y + ry * 0.01, rx * 0.085, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill();
        break;
      case 'happy':
        ctx.beginPath(); ctx.arc(x, y + ry * 0.05, rx * 0.12, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
        break;
      case 'narrow':
        ctx.beginPath(); ctx.moveTo(x - rx * 0.13, y); ctx.lineTo(x + rx * 0.13, y); ctx.lineWidth = lw * 2.2; ctx.stroke();
        break;
      case 'oval':
      default:
        ctx.beginPath(); ctx.ellipse(x, y, rx * 0.085, ry * 0.11, 0, 0, Math.PI * 2); ctx.fill();
        break;
    }
    if (style === 'oval' || style === 'dot' || style === 'wide') {
      ctx.beginPath();
      ctx.arc(x + rx * 0.03, y - ry * 0.035, rx * 0.03, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawBrows(ctx, style, g) {
  if (style === 'none') return;
  const { cx, eyeY, eyeDX, rx, ry, lw, col } = g;
  const y = eyeY - ry * 0.25;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  ctx.lineWidth = style === 'thick' ? lw * 3.4 : lw * 2.1;
  for (const s of [-1, 1]) {
    const x = cx + s * eyeDX;
    const inner = x - s * rx * 0.16, outer = x + s * rx * 0.16;
    ctx.beginPath();
    switch (style) {
      case 'arched':
        ctx.moveTo(inner, y + ry * 0.02);
        ctx.quadraticCurveTo(x, y - ry * 0.09, outer, y + ry * 0.03);
        break;
      case 'angry':
        ctx.moveTo(inner, y + ry * 0.06);
        ctx.lineTo(outer, y - ry * 0.04);
        break;
      case 'worried':
        ctx.moveTo(inner, y - ry * 0.05);
        ctx.lineTo(outer, y + ry * 0.04);
        break;
      default:
        ctx.moveTo(inner, y);
        ctx.lineTo(outer, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawNose(ctx, style, g) {
  const { cx, cy, rx, ry, lw, skin, skinDark } = g;
  const y = cy + ry * 0.26;
  ctx.save();
  switch (style) {
    case 'none':
      break;
    case 'round':
      ctx.beginPath(); ctx.arc(cx, y, rx * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = shade(skin, -0.08); ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = skinDark; ctx.stroke();
      break;
    case 'long':
      ctx.beginPath(); ctx.moveTo(cx, y - ry * 0.2); ctx.quadraticCurveTo(cx + rx * 0.12, y + ry * 0.05, cx - rx * 0.02, y + ry * 0.06);
      ctx.lineWidth = lw * 1.3; ctx.strokeStyle = skinDark; ctx.stroke();
      break;
    case 'button':
    default:
      ctx.beginPath(); ctx.ellipse(cx, y, rx * 0.075, ry * 0.055, 0, 0, Math.PI * 2);
      ctx.fillStyle = skinDark; ctx.fill();
  }
  ctx.restore();
}

function drawMouth(ctx, style, g) {
  const { cx, cy, rx, ry, lw, ink, trim } = g;
  const y = cy + ry * 0.55, w = rx * 0.3;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = lw * 1.4;
  ctx.lineCap = 'round';
  switch (style) {
    case 'grin':
      ctx.beginPath(); ctx.moveTo(cx - w * 1.1, y - ry * 0.04); ctx.quadraticCurveTo(cx, y + ry * 0.3, cx + w * 1.1, y - ry * 0.04); ctx.closePath();
      ctx.fillStyle = '#7a2b35'; ctx.fill(); ctx.stroke();
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - w * 1.2, y - ry * 0.06, w * 2.4, ry * 0.07);
      ctx.restore();
      break;
    case 'flat':
      ctx.beginPath(); ctx.moveTo(cx - w * 0.8, y + ry * 0.02); ctx.lineTo(cx + w * 0.8, y + ry * 0.02); ctx.stroke();
      break;
    case 'smirk':
      ctx.beginPath(); ctx.moveTo(cx - w * 0.8, y + ry * 0.04); ctx.quadraticCurveTo(cx + w * 0.3, y + ry * 0.08, cx + w * 0.95, y - ry * 0.06); ctx.stroke();
      break;
    case 'open':
      ctx.beginPath(); ctx.ellipse(cx, y + ry * 0.04, w * 0.5, ry * 0.11, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#7a2b35'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, y + ry * 0.1, w * 0.3, ry * 0.045, 0, 0, Math.PI * 2); ctx.fillStyle = '#ff7b8a'; ctx.fill();
      break;
    case 'gritted':
      roundRectPath(ctx, cx - w, y - ry * 0.05, w * 2, ry * 0.15, ry * 0.05);
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = lw * 1.2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - w, y + ry * 0.025); ctx.lineTo(cx + w, y + ry * 0.025);
      for (let i = -2; i <= 2; i++) { ctx.moveTo(cx + i * w * 0.4, y - ry * 0.05); ctx.lineTo(cx + i * w * 0.4, y + ry * 0.1); }
      ctx.lineWidth = lw * 0.7; ctx.stroke();
      break;
    case 'guard':
      roundRectPath(ctx, cx - w * 1.05, y - ry * 0.06, w * 2.1, ry * 0.16, ry * 0.07);
      ctx.fillStyle = trim; ctx.fill(); ctx.lineWidth = lw * 1.1; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - w * 0.8, y + ry * 0.02); ctx.lineTo(cx + w * 0.8, y + ry * 0.02); ctx.lineWidth = lw * 0.7; ctx.strokeStyle = shade(trim, -0.4); ctx.stroke();
      break;
    case 'smile':
    default:
      ctx.beginPath(); ctx.moveTo(cx - w, y - ry * 0.02); ctx.quadraticCurveTo(cx, y + ry * 0.16, cx + w, y - ry * 0.02); ctx.stroke();
  }
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawAccessory(ctx, a, g) {
  const { cx, cy, rx, ry, lw, eyeY, eyeDX } = g;
  ctx.save();
  switch (a.accessory) {
    case 'headband': {
      ctx.save();
      eggPath(ctx, cx, cy, rx * 1.06, ry * 1.06);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(cx - rx * 1.2, cy - ry * 0.36);
      ctx.quadraticCurveTo(cx, cy - ry * 0.6, cx + rx * 1.2, cy - ry * 0.36);
      ctx.lineTo(cx + rx * 1.2, cy - ry * 0.2);
      ctx.quadraticCurveTo(cx, cy - ry * 0.44, cx - rx * 1.2, cy - ry * 0.2);
      ctx.closePath();
      ctx.fillStyle = a.trim;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.98, cy - ry * 0.3);
      ctx.lineTo(cx + rx * 1.35, cy - ry * 0.12);
      ctx.lineTo(cx + rx * 1.28, cy - ry * 0.38);
      ctx.closePath();
      ctx.fillStyle = a.trim;
      ctx.fill();
      break;
    }
    case 'shades':
      for (const s of [-1, 1]) {
        roundRectPath(ctx, cx + s * eyeDX - rx * 0.26, eyeY - ry * 0.12, rx * 0.52, ry * 0.24, ry * 0.1);
        ctx.fillStyle = '#1b2033';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + s * eyeDX - rx * 0.12, eyeY - ry * 0.06);
        ctx.lineTo(cx + s * eyeDX - rx * 0.02, eyeY - ry * 0.06);
        ctx.lineWidth = lw * 1.2;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - eyeDX + rx * 0.26, eyeY - ry * 0.04);
      ctx.lineTo(cx + eyeDX - rx * 0.26, eyeY - ry * 0.04);
      ctx.lineWidth = lw * 1.4;
      ctx.strokeStyle = '#1b2033';
      ctx.stroke();
      break;
    case 'goggles':
      ctx.beginPath();
      ctx.moveTo(cx - rx * 1.05, eyeY - ry * 0.02);
      ctx.lineTo(cx + rx * 1.05, eyeY - ry * 0.02);
      ctx.lineWidth = lw * 2.4;
      ctx.strokeStyle = a.trim;
      ctx.stroke();
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cx + s * eyeDX, eyeY, rx * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(160, 240, 255, 0.45)';
        ctx.fill();
        ctx.lineWidth = lw * 2;
        ctx.strokeStyle = a.trim;
        ctx.stroke();
      }
      break;
    case 'bandage': {
      ctx.translate(cx + rx * 0.52, cy + ry * 0.24);
      ctx.rotate(-0.6);
      roundRectPath(ctx, -rx * 0.22, -ry * 0.06, rx * 0.44, ry * 0.12, ry * 0.05);
      ctx.fillStyle = '#f7e3c6';
      ctx.fill();
      ctx.lineWidth = lw * 0.8;
      ctx.strokeStyle = '#c9a77c';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-rx * 0.04, -ry * 0.04); ctx.lineTo(rx * 0.04, ry * 0.04);
      ctx.moveTo(rx * 0.04, -ry * 0.04); ctx.lineTo(-rx * 0.04, ry * 0.04);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

// ───────────────────────────── 3D studio ─────────────────────────────

/** A relaxed "ready" pose for portraits: gloves at chest height, face fully visible. */
function idleView(appearance, expression = 'happy') {
  return {
    id: 'p2', name: '', isHuman: false, appearance,
    phase: 'idle', phaseProgress: 0, hp01: 1, stamina01: 1, guard: 'none',
    lean: { x: 0, y: 0, z: 0 },
    hands: { left: { ...PORTRAIT_TUNING.hand, x: -PORTRAIT_TUNING.hand.x, punching: false }, right: { ...PORTRAIT_TUNING.hand, punching: false } },
    punch: null, hitReact: null, knockdowns: 0, roundKnockdowns: 0, counterReady: false, expression,
  };
}

/** Renders BoxerModels to images with one shared WebGL renderer. */
export class PortraitStudio {
  /** @param {{BoxerModel: any}} opts */
  constructor({ BoxerModel, headWorldPosition = null }) {
    this.BoxerModel = BoxerModel;
    this.headWorldPosition = typeof headWorldPosition === 'function' ? headWorldPosition : null;
    this.size = PORTRAIT_TUNING.renderSize;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.size, this.size, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LIGHTING.exposure;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(LIGHTING.hemiSky, LIGHTING.hemiGround, LIGHTING.hemiIntensity * 1.1));
    const key = new THREE.DirectionalLight(LIGHTING.keyColor, LIGHTING.keyIntensity);
    key.position.set(1.6, 3.2, 3.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(LIGHTING.rimColor, LIGHTING.rimIntensity);
    rim.position.set(-2.5, 2.5, -2.5);
    this.scene.add(rim);
    this.camera = new THREE.PerspectiveCamera(PORTRAIT_TUNING.fov, 1, 0.05, 30);
    /** @type {Map<string, {model:any, used:number, top:number}>} */
    this.models = new Map();
    /** @type {Map<string, string>} */
    this.snapshots = new Map();
    this.failed = false;
    this._box = new THREE.Box3();
  }

  _key(a) { return JSON.stringify(a); }

  _model(appearance) {
    const key = this._key(appearance);
    let m = this.models.get(key);
    if (!m) {
      const model = new this.BoxerModel(appearance, { ghost: false, role: 'boxer' });
      model.object3d.rotation.y = PORTRAIT_TUNING.modelFacingYaw;
      const view = idleView(appearance);
      for (let i = 0; i < 12; i++) model.update(view, 1 / 15);
      this._box.setFromObject(model.object3d);
      let top = Number.isFinite(this._box.max.y) && this._box.max.y > 0.3 ? this._box.max.y : 1.55;
      if (this.headWorldPosition) {
        try {
          const hy = this.headWorldPosition(model).y;
          if (Number.isFinite(hy) && hy > 0.3) top = hy + PORTRAIT_TUNING.headToTop;
        } catch { /* keep the bounding-box framing */ }
      }
      m = { model, used: 0, top, view };
      this.models.set(key, m);
      if (this.models.size > PORTRAIT_TUNING.maxModels) {
        let oldestKey = null, oldest = Infinity;
        for (const [k, v] of this.models) if (v !== m && v.used < oldest) { oldest = v.used; oldestKey = k; }
        if (oldestKey) {
          const old = this.models.get(oldestKey);
          this.models.delete(oldestKey);
          try { old.model.dispose?.(); } catch { /* ignore */ }
        }
      }
    }
    m.used = performance.now();
    return m;
  }

  /**
   * Render a portrait into the shared GL canvas.
   * @param {object} appearance
   * @param {{framing?:'bust'|'head'|'full', yaw?:number, t?:number, dt?:number}} [opts]
   * @returns {HTMLCanvasElement}
   */
  render(appearance, opts = {}) {
    const a = validLook(appearance);
    const m = this._model(a);
    for (const c of this.scene.children.filter((o) => o.userData.__portraitModel)) this.scene.remove(c);
    m.model.object3d.userData.__portraitModel = true;
    this.scene.add(m.model.object3d);
    if (opts.dt) m.model.update(m.view, opts.dt);
    const yaw = (opts.yaw ?? PORTRAIT_TUNING.yaw) + Math.sin((opts.t ?? 0) * 0.6) * (opts.t ? 0.12 : 0);
    const framing = opts.framing || 'bust';
    const top = m.top;
    const look = framing === 'full' ? top * 0.52 : framing === 'head' ? top - 0.17 : top - 0.3;
    const span = framing === 'full' ? top * 1.15 : framing === 'head' ? 0.52 : 0.9;
    const dist = span / (2 * Math.tan(THREE.MathUtils.degToRad(PORTRAIT_TUNING.fov / 2)));
    this.camera.position.set(Math.sin(yaw) * dist, look + 0.05, Math.cos(yaw) * dist);
    this.camera.lookAt(0, look, 0);
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }

  /** Cached data URL of a portrait. */
  snapshot(appearance, opts = {}) {
    const a = validLook(appearance);
    const key = `${this._key(a)}|${opts.framing || 'bust'}|${opts.yaw ?? ''}`;
    const hit = this.snapshots.get(key);
    if (hit) return hit;
    this.render(a, opts);
    const url = this.canvas.toDataURL('image/png');
    this.snapshots.set(key, url);
    if (this.snapshots.size > PORTRAIT_TUNING.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value);
    return url;
  }

  dispose() {
    for (const m of this.models.values()) { try { m.model.dispose?.(); } catch { /* ignore */ } }
    this.models.clear();
    this.renderer.dispose();
  }
}

// ───────────────────────────── portrait elements ─────────────────────────────

const state = {
  /** BoxerModel class (from render/boxer-model.js) once known. */
  BoxerModel: null,
  /** render/boxer-model.js headWorldPosition (optional: hair-independent framing). */
  headWorldPosition: null,
  /** @type {PortraitStudio|null} created lazily on the first 3D portrait (one WebGL context, only if needed) */
  studio: null,
  failed: false,
  /** @type {Set<HTMLCanvasElement>} */
  waiting: new Set(),
};

function studio() {
  if (state.studio || state.failed || !state.BoxerModel) return state.studio;
  try {
    state.studio = new PortraitStudio({ BoxerModel: state.BoxerModel, headWorldPosition: state.headWorldPosition });
  } catch (e) {
    console.warn('[ui] could not start the portrait renderer — using 2D portraits', e);
    state.failed = true;
    state.studio = null;
  }
  return state.studio;
}

function canvasFor(size) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  return c;
}

/** Cached 3D renders (key → offscreen canvas) so the same boxer is rendered once per framing. */
const renders = new Map();
/** Canvases waiting for their first 3D render (processed one per animation frame). */
const queue = [];
let pumping = false;

function renderKey(info) {
  return `${JSON.stringify(info.look)}|${info.framing}|${info.yaw ?? ''}`;
}

/** Background disc + 3D image + ring into a portrait canvas. */
function composite(canvas, img) {
  const info = canvas.__portrait;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  ctx.fillStyle = info.bg || shade(info.look.top === 'none' ? info.look.trunks : info.look.top, 0.55);
  ctx.fill();
  ctx.clip();
  const g = ctx.createRadialGradient(S * 0.5, S * 0.35, S * 0.05, S * 0.5, S * 0.45, S * 0.7);
  g.addColorStop(0, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img, 0, 0, S, S);
  ctx.restore();
  if (info.ring) {
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - S * 0.017, 0, Math.PI * 2);
    ctx.lineWidth = S * 0.034;
    ctx.strokeStyle = info.ring;
    ctx.stroke();
  }
  info.is3d = true;
}

function paint2D(canvas) {
  const info = canvas.__portrait;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  drawPortrait2D(ctx, info.look, { size: S, bg: info.bg, ring: info.ring, gloves: info.gloves, expression: info.expression });
  info.is3d = false;
}

/** Render one portrait in 3D now (returns false if 3D is unavailable). */
function render3D(canvas) {
  const info = canvas.__portrait;
  const st = info.use3d !== false ? studio() : null;
  if (!st || st.failed) return false;
  try {
    if (info.live) {
      composite(canvas, st.render(info.look, { framing: info.framing, yaw: info.yaw, t: performance.now() / 1000, dt: 1 / 30 }));
      return true;
    }
    const key = renderKey(info);
    let img = renders.get(key);
    if (!img) {
      const src = st.render(info.look, { framing: info.framing, yaw: info.yaw });
      img = document.createElement('canvas');
      img.width = src.width;
      img.height = src.height;
      img.getContext('2d')?.drawImage(src, 0, 0);
      renders.set(key, img);
      if (renders.size > PORTRAIT_TUNING.maxSnapshots) renders.delete(renders.keys().next().value);
    }
    composite(canvas, img);
    return true;
  } catch (e) {
    console.warn('[ui] 3D portrait failed — using 2D portraits', e);
    st.failed = true;
    state.failed = true;
    return false;
  }
}

function pump() {
  pumping = false;
  // Render at most one new portrait per frame so screens appear instantly and stay smooth.
  while (queue.length) {
    const c = queue.shift();
    c.__portrait.queued = false;
    if (!c.isConnected && !c.__portrait.live) continue;
    render3D(c);
    break;
  }
  if (queue.length) schedule();
}

function schedule() {
  if (pumping) return;
  pumping = true;
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16))(pump);
}

function paint(canvas) {
  const info = canvas.__portrait;
  if (!info) return;
  const can3d = info.use3d !== false && state.BoxerModel && !state.failed;
  if (can3d) {
    if (info.live && info.is3d) { render3D(canvas); return; }
    const cached = !info.live && renders.get(renderKey(info));
    if (cached) { composite(canvas, cached); return; }
    if (!info.is3d) paint2D(canvas);
    if (!info.queued) { info.queued = true; queue.push(canvas); schedule(); }
    return;
  }
  paint2D(canvas);
}

export const portraits = {
  /** Install the 3D backend (BoxerModel class). Safe to call more than once. */
  setBoxerModel(BoxerModel, { headWorldPosition = null } = {}) {
    if (typeof headWorldPosition === 'function' && !state.studio) state.headWorldPosition = headWorldPosition;
    if (state.BoxerModel || typeof BoxerModel !== 'function') return;
    state.BoxerModel = BoxerModel;
    // Upgrade every portrait already on screen (creates the renderer only if there is one).
    for (const c of [...state.waiting]) {
      if (!c.isConnected) { state.waiting.delete(c); continue; }
      paint(c);
    }
  },
  get has3d() { return !!state.BoxerModel && !state.failed; },

  /**
   * A portrait canvas (2D immediately, upgraded to 3D when available).
   * @param {object} appearance
   * @param {{size?:number, bg?:string|null, ring?:string|null, framing?:'bust'|'head'|'full', yaw?:number, live?:boolean, cls?:string, use3d?:boolean, gloves?:boolean, expression?:string, label?:string}} [opts]
   * @returns {HTMLCanvasElement & {setLook:(a:object)=>void, tick:()=>void}}
   */
  element(appearance, opts = {}) {
    const size = opts.size ?? 160;
    const c = canvasFor(size);
    c.className = `gu-portrait${opts.cls ? ' ' + opts.cls : ''}`;
    c.style.setProperty('--portrait-size', `${size / 16}rem`);
    c.setAttribute('role', 'img');
    if (opts.label) c.setAttribute('aria-label', opts.label);
    c.__portrait = { look: validLook(appearance), bg: opts.bg, ring: opts.ring ?? null, framing: opts.framing || 'bust', yaw: opts.yaw, live: !!opts.live, use3d: opts.use3d, gloves: opts.gloves, expression: opts.expression };
    state.waiting.add(c);
    paint(c);
    c.setLook = (a) => { c.__portrait.look = validLook(a); paint(c); };
    c.tick = () => { if (c.__portrait.live && c.__portrait.is3d) paint(c); };
    c.release = () => state.waiting.delete(c);
    return c;
  },

  /** Repaint (e.g. after layout changes). */
  repaint(canvas) { paint(canvas); },

  /** Forget detached canvases (called by the UI between screens). */
  sweep() {
    for (const c of [...state.waiting]) if (!c.isConnected) state.waiting.delete(c);
  },
};

/** Paint a small 2D portrait into an existing canvas context (HUD helper). */
export function paintPortraitInto(ctx, appearance, size, ring) {
  drawPortrait2D(ctx, appearance, { size, ring });
}

// Keep an explicit reference so tree-shaking never drops palette helpers used in docs/tests.
export const PORTRAIT_DEFAULT_RING = css(PALETTE.uiInk);
export const portraitInk = contrastInk;
