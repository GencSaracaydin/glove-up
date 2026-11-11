// Painted faces for the boxers: a few flat marks (eyes, brows, nose, mouth, cheeks and
// painted accessories) from our own feature kit (APPEARANCE_OPTIONS), drawn on a 2D canvas
// and used as the head's colour map.
//
// How the face sits on the head without distortion
// ------------------------------------------------
// The head mesh (render/boxer-model.js) is a sphere whose poles point front/back. Its UVs
// come from faceUV(): an azimuthal-equidistant projection centred on the face. A point at
// angle θ from "straight ahead" lands at radius θ/FACE_THETA_MAX·0.5 from the texture
// centre, so arc length on the head maps linearly to texture distance. Near the face the
// projection is practically conformal (≤4 % tangential squeeze at the eyes), the whole
// back of the head collapses onto the plain-skin texture border, and there is no seam.
// Features are painted in "face units": arc length on the unit head sphere, 1 unit ≈ the
// head's horizontal radius, +x = the VIEWER's right (the boxer's left), +y = up. The
// head's vertical stretch (HEAD_SHAPE) is pre-compensated so round eyes stay round.
//
// Expressions: neutral, focus, hurt (squint + open mouth), dazed (spiral eyes),
// ko (X eyes), happy, sad, plus internal blink variants ('neutral-blink', 'focus-blink').
// Textures are cached by face-relevant appearance fields + expression and ref-counted.
//
// No DOM access at import time. Without a DOM (Node tests) acquireFaceTexture() returns
// null and the model renders a plain-skin head.

import * as THREE from 'three';
import { validateAppearance } from './appearance.js';

/** Texture edge length in px (power of two → mipmaps). Crisp at this size. */
export const FACE_TEX_SIZE = 512;
/** Angle from the face centre that maps to the texture's inscribed circle (90° = front hemisphere). */
export const FACE_THETA_MAX = Math.PI / 2;
/**
 * Head proportions shared with boxer-model.js: radii relative to the horizontal radius.
 * The face painter pre-compensates `y` so features keep their designed proportions.
 */
export const HEAD_SHAPE = Object.freeze({ x: 1.0, y: 1.13, z: 1.05 });

/** Public expression names (BoxerView.expression). */
export const EXPRESSIONS = Object.freeze(['neutral', 'focus', 'hurt', 'dazed', 'ko', 'happy', 'sad']);
/** Internal variants the model may request for blinking. */
export const BLINK_EXPRESSIONS = Object.freeze(['neutral-blink', 'focus-blink']);
const ALL_EXPRESSIONS = new Set([...EXPRESSIONS, ...BLINK_EXPRESSIONS]);

/** Feature layout in face units (tunable). */
export const FACE_LAYOUT = Object.freeze({
  eyeX: 0.31, eyeY: 0.0,
  browY: 0.25,
  noseY: -0.15,
  mouthY: -0.37,
  cheekX: 0.5, cheekY: -0.2,
  eyeScale: 1.4, mouthScale: 1.3, noseScale: 1.3, browScale: 1.25,
});

const INK = '#2b211f';
const EYE_WHITE = '#fffdf8';
const MOUTH_IN = '#6e2730';
const TONGUE = '#ea7c86';
const TEETH = '#fffdf8';
const SHADES = '#1d2233';
const PLASTER = '#f1d0a5';
const PLASTER_PAD = '#ddb284';
const TEAR = '#9fd8ff';

// ───────────────────────────── projection ─────────────────────────────

/**
 * Face-texture UV for a direction on the unit head sphere (+z = straight out of the face,
 * +y up, +x = viewer's right). Continuous everywhere; the back of the head maps onto the
 * texture's border circle (plain skin).
 * @param {number} x @param {number} y @param {number} z  unit direction
 * @param {number} [azimuthFallback] azimuth (radians) to use exactly at the back pole
 * @returns {[number, number]} [u, v] with v up (three.js convention, flipY textures)
 */
export function faceUV(x, y, z, azimuthFallback = Math.PI / 2) {
  const theta = Math.acos(Math.max(-1, Math.min(1, z)));
  const r = 0.5 * Math.min(theta / FACE_THETA_MAX, 1);
  const rho = Math.hypot(x, y);
  let cx, cy;
  if (rho > 1e-7) { cx = x / rho; cy = y / rho; } else { cx = Math.cos(azimuthFallback); cy = Math.sin(azimuthFallback); }
  return [0.5 + r * cx, 0.5 + r * cy];
}

// ───────────────────────────── colour helpers ─────────────────────────────

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** Mix two hex colours (t=0 → a, t=1 → b). */
export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
/** Lighten (amt>0, toward white) or darken (amt<0, toward black). */
export function shadeHex(hex, amt) { return amt >= 0 ? mixHex(hex, '#ffffff', amt) : mixHex(hex, '#000000', -amt); }
/** Relative luminance 0..1 (sRGB, approximate). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

/** Colours derived from an appearance for painting. */
function paletteFor(A) {
  const skin = A.skin;
  const hair = A.hair.color;
  const skinLum = luminance(skin);
  // Brows/beard: hair colour, darkened when the hair is very light so marks stay readable.
  const lum = luminance(hair);
  const brow = lum > 0.45 ? mixHex(hair, '#5b4a3f', 0.45) : lum > 0.25 ? shadeHex(hair, -0.2) : hair;
  const guard = A.trim && luminance(A.trim) > 0.04 ? A.trim : '#3d7bff';
  return {
    skin,
    hair,
    brow,
    beard: lum > 0.6 ? shadeHex(hair, -0.08) : hair,
    noseShade: skinLum > 0.3 ? shadeHex(skin, -0.12) : shadeHex(skin, -0.2),
    noseLight: shadeHex(skin, skinLum > 0.3 ? 0.18 : 0.12),
    blush: skinLum > 0.3 ? '#ff7d7d' : '#ff6b6b',
    blushAlpha: skinLum > 0.3 ? 0.2 : 0.16,
    lid: shadeHex(skin, -0.06),
    guard,
  };
}

// ───────────────────────────── expression model ─────────────────────────────

/**
 * Per-expression modifiers applied to the base features.
 * eye: 'open' uses the appearance eye style; others replace it.
 * lid: fraction of an open eye covered from the top; lidTilt: + lowers the INNER corner.
 * brow: dy (shift), inner (inner-end lift), arch (extra arch), squeeze (toward centre).
 */
const EXPR = {
  neutral: { eye: 'open', lid: 0, lidTilt: 0, look: [0, 0], brow: { dy: 0, inner: 0, arch: 0 }, mouth: 'base' },
  focus: { eye: 'open', lid: 0.3, lidTilt: 0.35, look: [0, 0.1], brow: { dy: -0.03, inner: -0.05, arch: -0.01 }, mouth: 'set' },
  hurt: { eye: 'squeeze', brow: { dy: -0.005, inner: 0.075, arch: 0, squeeze: 0.02 }, mouth: 'wince', sweat: true, blush: 'hit' },
  dazed: { eye: 'spiral', brow: { dy: 0.03, inner: 0, arch: 0.01, uneven: 0.05 }, mouth: 'wavy' },
  ko: { eye: 'x', brow: { dy: 0.04, inner: 0.02, arch: 0 }, mouth: 'slack' },
  happy: { eye: 'arc', brow: { dy: 0.045, inner: 0.01, arch: 0.025 }, mouth: 'beam', blush: 'happy' },
  sad: { eye: 'open', lid: 0.36, lidTilt: -0.45, look: [0, -0.45], brow: { dy: 0.015, inner: 0.07, arch: 0 }, mouth: 'frown', tear: true },
  'neutral-blink': { eye: 'closed', brow: { dy: -0.005, inner: 0, arch: 0 }, mouth: 'base' },
  'focus-blink': { eye: 'closed', brow: { dy: -0.035, inner: -0.05, arch: -0.01 }, mouth: 'set' },
};

/** Normalise an expression name (unknown → 'neutral'). */
export function normalizeExpression(name) { return ALL_EXPRESSIONS.has(name) ? name : 'neutral'; }

// ───────────────────────────── painter ─────────────────────────────

/**
 * Paint a full face texture (skin background + features) into a 2D context of `size` px.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/types.js').Appearance} appearance
 * @param {string} expression
 * @param {number} [size=FACE_TEX_SIZE]
 */
export function paintFaceTexture(ctx, appearance, expression, size = FACE_TEX_SIZE) {
  const A = validateAppearance(appearance);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = A.skin;
  ctx.fillRect(0, 0, size, size);
  const k = (size * 0.5) / FACE_THETA_MAX; // px per face unit
  // y up; vertical pre-squash so the head's vertical stretch restores true proportions
  ctx.setTransform(k, 0, 0, -k / HEAD_SHAPE.y, size / 2, size / 2);
  paintFaceFeatures(ctx, A, expression);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Paint only the features in face units. The caller sets a transform where 1 unit = the
 * head's horizontal radius and +y is up (e.g. setTransform(r,0,0,-r,cx,cy)).
 * Used by the texture painter and by drawPortrait().
 */
export function paintFaceFeatures(ctx, appearance, expression) {
  const A = validateAppearance(appearance);
  const ex = EXPR[normalizeExpression(expression)];
  const P = paletteFor(A);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  paintCheeks(ctx, P, ex);
  if (A.accessory === 'beard') paintBeard(ctx, P);
  paintNose(ctx, A.nose, P);
  if (A.accessory === 'moustache' || A.accessory === 'beard') paintMoustache(ctx, P, A.accessory === 'beard');
  paintMouth(ctx, A, P, ex);
  for (const side of [-1, 1]) paintEye(ctx, A.eyes, side, ex, P);
  if (A.brows !== 'none') for (const side of [-1, 1]) paintBrow(ctx, A.brows, side, ex, P);
  if (A.accessory === 'shades') paintShades(ctx, ex);
  if (A.accessory === 'bandage') paintBandage(ctx);
  if (ex.sweat) paintSweat(ctx);
  if (ex.tear) paintTear(ctx);
  ctx.restore();
}

function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(1e-4, rx), Math.max(1e-4, ry), rot, 0, Math.PI * 2);
}

function paintCheeks(ctx, P, ex) {
  const L = FACE_LAYOUT;
  let alpha = P.blushAlpha;
  if (ex.blush === 'happy') alpha *= 1.7;
  for (const side of [-1, 1]) {
    let a = alpha;
    let color = P.blush;
    // 'hurt': one reddened cheek (where the punch landed, viewer's right by convention)
    if (ex.blush === 'hit' && side === 1) { a = alpha * 2.2; color = '#ff4d4d'; }
    const cx = side * L.cheekX, cy = L.cheekY, r = 0.125;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ellipse(ctx, cx, cy, r, r);
    ctx.fill();
  }
}

// ── eyes ──

/** Outline path of an open eye of the given style centred at the origin (viewer-right eye shape; mirrored by caller). */
function eyeShape(ctx, style) {
  switch (style) {
    case 'wide': ellipse(ctx, 0, 0, 0.088, 0.1); break;
    case 'fierce': {
      // almond with the top edge sloping down toward the inner corner (inner = -x here)
      ctx.beginPath();
      ctx.moveTo(-0.085, -0.012);
      ctx.bezierCurveTo(-0.05, 0.035, 0.03, 0.075, 0.085, 0.03);
      ctx.bezierCurveTo(0.07, -0.05, -0.04, -0.07, -0.085, -0.012);
      ctx.closePath();
      break;
    }
    case 'narrow': {
      ctx.beginPath();
      ctx.moveTo(-0.085, 0);
      ctx.bezierCurveTo(-0.04, 0.042, 0.04, 0.042, 0.085, 0.004);
      ctx.bezierCurveTo(0.04, -0.034, -0.04, -0.034, -0.085, 0);
      ctx.closePath();
      break;
    }
    case 'sleepy': ellipse(ctx, 0, 0, 0.076, 0.082); break;
    case 'oval':
    default: ellipse(ctx, 0, 0, 0.074, 0.094); break;
  }
}

/**
 * @param {number} side -1 = viewer-left eye (boxer's right), +1 = viewer-right eye
 */
function paintEye(ctx, style, side, ex, P) {
  const L = FACE_LAYOUT;
  ctx.save();
  ctx.translate(side * L.eyeX, L.eyeY);
  // Draw every eye as the viewer-right version; mirror for the left so "inner" = toward the nose.
  ctx.scale(side * L.eyeScale, L.eyeScale);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  switch (ex.eye) {
    case 'closed': {
      ctx.lineWidth = 0.028;
      ctx.beginPath();
      ctx.moveTo(-0.07, 0.0);
      ctx.quadraticCurveTo(0, -0.04, 0.072, 0.004);
      ctx.stroke();
      // tiny lash flick at the outer corner
      ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.moveTo(0.068, 0.004); ctx.lineTo(0.092, 0.02); ctx.stroke();
      break;
    }
    case 'arc': { // happy closed eyes (upward arcs)
      ctx.lineWidth = 0.034;
      ctx.beginPath();
      ctx.moveTo(-0.075, -0.025);
      ctx.quadraticCurveTo(0, 0.085, 0.075, -0.025);
      ctx.stroke();
      break;
    }
    case 'squeeze': { // hurt: tight chevrons pointing at the nose (">  <")
      ctx.lineWidth = 0.032;
      ctx.beginPath();
      ctx.moveTo(0.075, 0.055);
      ctx.lineTo(-0.055, 0.0);
      ctx.lineTo(0.075, -0.05);
      ctx.stroke();
      break;
    }
    case 'x': { // KO
      ctx.lineWidth = 0.034;
      const s = 0.062;
      ctx.beginPath();
      ctx.moveTo(-s, s); ctx.lineTo(s, -s);
      ctx.moveTo(-s, -s); ctx.lineTo(s, s);
      ctx.stroke();
      break;
    }
    case 'spiral': { // dazed: spirals turning opposite ways
      ctx.lineWidth = 0.02;
      ctx.beginPath();
      const turns = 2.35, rmax = 0.088, n = 90;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = t * turns * Math.PI * 2 + (side > 0 ? 0.6 : 2.2);
        const r = 0.006 + rmax * t;
        const x = r * Math.cos(a), y = r * Math.sin(a) * 1.05;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'open':
    default:
      paintOpenEye(ctx, style, ex, P);
      break;
  }
  ctx.restore();
}

function paintOpenEye(ctx, style, ex, P) {
  const lookX = (ex.look?.[0] ?? 0) * 0.02, lookY = (ex.look?.[1] ?? 0) * 0.025;
  if (style === 'dot') {
    // solid ink bead; focus/sad lids are drawn as skin over the top
    ellipse(ctx, 0, 0, 0.054, 0.068);
    ctx.fillStyle = INK; ctx.fill();
    highlight(ctx, 0.017 + lookX, 0.024, 0.017);
  } else if (style === 'happy') {
    // smiling open eye: bead with the lower part hidden by a raised cheek
    ellipse(ctx, 0, 0.004, 0.058, 0.07);
    ctx.fillStyle = INK; ctx.fill();
    highlight(ctx, 0.018, 0.03, 0.017);
    ctx.fillStyle = P.skin;
    ctx.beginPath();
    ctx.moveTo(-0.09, -0.09);
    ctx.lineTo(-0.09, -0.035);
    ctx.quadraticCurveTo(0, 0.025, 0.09, -0.035);
    ctx.lineTo(0.09, -0.09);
    ctx.closePath();
    ctx.fill();
  } else if (style === 'narrow') {
    eyeShape(ctx, 'narrow');
    ctx.fillStyle = INK; ctx.fill();
    highlight(ctx, 0.02, 0.012, 0.011);
  } else {
    // sclera + iris styles: oval, wide, fierce, sleepy
    eyeShape(ctx, style);
    ctx.fillStyle = EYE_WHITE; ctx.fill();
    ctx.save();
    eyeShape(ctx, style);
    ctx.clip();
    const irisR = style === 'wide' ? 0.04 : style === 'fierce' ? 0.042 : 0.048;
    const irisY = (style === 'sleepy' ? -0.022 : style === 'fierce' ? 0.0 : -0.008) + lookY;
    const irisX = -0.006 + lookX; // a touch toward the nose: friendly, focused gaze
    ellipse(ctx, irisX, irisY, irisR, irisR * 1.18);
    ctx.fillStyle = INK; ctx.fill();
    highlight(ctx, irisX + irisR * 0.38, irisY + irisR * 0.5, irisR * 0.36);
    ctx.restore();
    eyeShape(ctx, style);
    ctx.lineWidth = style === 'fierce' ? 0.02 : 0.016;
    ctx.strokeStyle = INK; ctx.stroke();
    if (style === 'fierce') {
      // heavy upper lash line
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(-0.085, -0.012);
      ctx.bezierCurveTo(-0.05, 0.035, 0.03, 0.075, 0.09, 0.034);
      ctx.stroke();
    }
    if (style === 'sleepy') lid(ctx, 0.46, 0.04, P, 0.082, 0.078);
  }
  const lidAmt = ex.lid ?? 0;
  if (lidAmt > 0) {
    const h = style === 'wide' ? 0.1 : style === 'narrow' ? 0.04 : style === 'dot' || style === 'happy' ? 0.07 : 0.094;
    lid(ctx, style === 'sleepy' ? Math.max(lidAmt, 0.5) : lidAmt, ex.lidTilt ?? 0, P, h, style === 'wide' ? 0.092 : 0.082);
  }
}

/**
 * Cover the top `amt` of an eye of half-height `h` with skin and draw the lid line.
 * tilt > 0 lowers the inner corner (determined); tilt < 0 lowers the outer corner (droopy).
 */
function lid(ctx, amt, tilt, P, h, w) {
  const yMid = h - 2 * h * amt;
  const dy = tilt * h * 0.9;
  const yIn = yMid - dy, yOut = yMid + dy; // inner corner at -x
  ctx.fillStyle = P.skin;
  ctx.beginPath();
  ctx.moveTo(-w - 0.02, yIn);
  ctx.lineTo(w + 0.02, yOut);
  ctx.lineTo(w + 0.02, h + 0.05);
  ctx.lineTo(-w - 0.02, h + 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.024;
  ctx.beginPath();
  ctx.moveTo(-w * 0.95, yIn);
  ctx.lineTo(w * 0.95, yOut);
  ctx.stroke();
}

function highlight(ctx, x, y, r) {
  ellipse(ctx, x, y, r, r);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// ── brows ──

const BROW_BASE = {
  flat: { w: 0.036, inner: 0, arch: 0.012 },
  arched: { w: 0.034, inner: -0.012, arch: 0.05 },
  angry: { w: 0.042, inner: -0.065, arch: 0.004 },
  thick: { w: 0.066, inner: -0.008, arch: 0.016 },
  worried: { w: 0.034, inner: 0.05, arch: 0.012 },
};

function paintBrow(ctx, style, side, ex, P) {
  const L = FACE_LAYOUT;
  const B = BROW_BASE[style] ?? BROW_BASE.flat;
  const m = ex.brow ?? { dy: 0, inner: 0, arch: 0 };
  let dy = m.dy ?? 0;
  if (m.uneven) dy += side > 0 ? m.uneven : -m.uneven * 0.6;
  const squeeze = m.squeeze ?? 0;
  const bs = L.browScale;
  const half = 0.095 * bs;
  const cx = side * (L.eyeX - squeeze);
  const xIn = cx - side * half, xOut = cx + side * half;
  const y0 = L.browY + dy;
  const yIn = y0 + (B.inner + (m.inner ?? 0)) * bs;
  const yOut = y0;
  const arch = (B.arch + (m.arch ?? 0)) * bs;
  ctx.strokeStyle = P.brow;
  ctx.lineWidth = B.w * bs;
  ctx.beginPath();
  ctx.moveTo(xIn, yIn);
  ctx.quadraticCurveTo(cx, (yIn + yOut) / 2 + arch, xOut, yOut);
  ctx.stroke();
  if (style === 'thick') {
    // taper toward the outer end for a bold-but-soft look
    ctx.lineWidth = B.w * 0.55 * bs;
    ctx.beginPath();
    ctx.moveTo(xOut, yOut);
    ctx.lineTo(xOut + side * 0.03, yOut - 0.014);
    ctx.stroke();
  }
}

// ── nose ──

function paintNose(ctx, style, P) {
  if (style === 'none') return;
  ctx.save();
  ctx.translate(0, FACE_LAYOUT.noseY);
  ctx.scale(FACE_LAYOUT.noseScale, FACE_LAYOUT.noseScale);
  ctx.fillStyle = P.noseShade;
  switch (style) {
    case 'round':
      ellipse(ctx, 0, 0, 0.068, 0.06); ctx.fill();
      ellipse(ctx, 0.022, 0.02, 0.018, 0.015); ctx.fillStyle = P.noseLight; ctx.fill();
      break;
    case 'long':
      ctx.beginPath();
      ctx.moveTo(-0.02, 0.15);
      ctx.quadraticCurveTo(-0.03, 0.02, -0.055, -0.015);
      ctx.quadraticCurveTo(0, -0.06, 0.055, -0.015);
      ctx.quadraticCurveTo(0.03, 0.02, 0.02, 0.15);
      ctx.closePath();
      ctx.fill();
      ellipse(ctx, 0.012, 0.04, 0.009, 0.04); ctx.fillStyle = P.noseLight; ctx.fill();
      break;
    case 'button':
    default:
      ellipse(ctx, 0, 0, 0.05, 0.038); ctx.fill();
      ellipse(ctx, 0.016, 0.012, 0.014, 0.011); ctx.fillStyle = P.noseLight; ctx.fill();
  }
  ctx.restore();
}

// ── mouth ──

function mouthKind(A, ex) {
  const guard = A.accessory === 'mouthguard';
  switch (ex.mouth) {
    case 'set': return guard || A.mouth === 'gritted' ? 'gritted' : A.mouth === 'smirk' ? 'smirk' : 'set';
    case 'wince': return 'wince';
    case 'wavy': return 'wavy';
    case 'slack': return 'slack';
    case 'beam': return 'beam';
    case 'frown': return 'frown';
    default: return A.mouth;
  }
}

function paintMouth(ctx, A, P, ex) {
  const kind = mouthKind(A, ex);
  const guard = A.accessory === 'mouthguard';
  const teeth = guard ? P.guard : TEETH;
  ctx.save();
  ctx.translate(0, FACE_LAYOUT.mouthY);
  ctx.scale(FACE_LAYOUT.mouthScale, FACE_LAYOUT.mouthScale);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  switch (kind) {
    case 'smile':
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(-0.12, 0.025); ctx.quadraticCurveTo(0, -0.075, 0.12, 0.025); ctx.stroke();
      break;
    case 'flat':
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(-0.09, 0); ctx.lineTo(0.09, 0); ctx.stroke();
      break;
    case 'set':
      ctx.lineWidth = 0.032;
      ctx.beginPath(); ctx.moveTo(-0.08, -0.012); ctx.quadraticCurveTo(0, 0.012, 0.08, -0.012); ctx.stroke();
      break;
    case 'smirk':
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(-0.1, -0.005); ctx.quadraticCurveTo(0.03, -0.045, 0.115, 0.04); ctx.stroke();
      ctx.lineWidth = 0.022;
      ctx.beginPath(); ctx.moveTo(0.112, 0.036); ctx.lineTo(0.13, 0.058); ctx.stroke();
      break;
    case 'frown':
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(-0.1, -0.03); ctx.quadraticCurveTo(0, 0.05, 0.1, -0.03); ctx.stroke();
      break;
    case 'wavy': {
      ctx.lineWidth = 0.026;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40, x = -0.12 + t * 0.24, y = Math.sin(t * Math.PI * 3) * 0.02;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // tongue poking out of one corner
      ellipse(ctx, 0.07, -0.035, 0.032, 0.04, 0.3); ctx.fillStyle = TONGUE; ctx.fill();
      ctx.lineWidth = 0.014; ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'grin':
    case 'beam': {
      const w = kind === 'beam' ? 0.16 : 0.145, d = kind === 'beam' ? 0.13 : 0.1;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-w, 0.035);
        ctx.quadraticCurveTo(0, 0.06, w, 0.035);
        ctx.quadraticCurveTo(w * 0.9, -d, 0, -d);
        ctx.quadraticCurveTo(-w * 0.9, -d, -w, 0.035);
        ctx.closePath();
      };
      path(); ctx.fillStyle = MOUTH_IN; ctx.fill();
      ctx.save(); path(); ctx.clip();
      ctx.fillStyle = teeth; ctx.fillRect(-w, -0.005, w * 2, 0.08);
      ellipse(ctx, 0, -d - 0.02, w * 0.55, d * 0.55); ctx.fillStyle = TONGUE; ctx.fill();
      ctx.restore();
      path(); ctx.lineWidth = 0.022; ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'open': {
      ellipse(ctx, 0, -0.02, 0.068, 0.058); ctx.fillStyle = MOUTH_IN; ctx.fill();
      ctx.save(); ellipse(ctx, 0, -0.02, 0.068, 0.058); ctx.clip();
      if (guard) { ctx.fillStyle = teeth; ctx.fillRect(-0.07, 0.008, 0.14, 0.04); }
      ellipse(ctx, 0, -0.075, 0.05, 0.035); ctx.fillStyle = TONGUE; ctx.fill();
      ctx.restore();
      ellipse(ctx, 0, -0.02, 0.068, 0.058); ctx.lineWidth = 0.022; ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'slack': {
      ellipse(ctx, -0.01, -0.03, 0.06, 0.075, -0.12); ctx.fillStyle = MOUTH_IN; ctx.fill();
      ctx.save(); ellipse(ctx, -0.01, -0.03, 0.06, 0.075, -0.12); ctx.clip();
      ellipse(ctx, 0.02, -0.1, 0.05, 0.045); ctx.fillStyle = TONGUE; ctx.fill();
      ctx.restore();
      ellipse(ctx, -0.01, -0.03, 0.06, 0.075, -0.12); ctx.lineWidth = 0.022; ctx.strokeStyle = INK; ctx.stroke();
      // lolling tongue tip outside the mouth
      ellipse(ctx, 0.045, -0.11, 0.03, 0.036, 0.4); ctx.fillStyle = TONGUE; ctx.fill();
      ctx.lineWidth = 0.012; ctx.stroke();
      break;
    }
    case 'wince': {
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-0.13, 0.02);
        ctx.quadraticCurveTo(0, 0.07, 0.13, 0.02);
        ctx.quadraticCurveTo(0.12, -0.1, 0, -0.095);
        ctx.quadraticCurveTo(-0.12, -0.1, -0.13, 0.02);
        ctx.closePath();
      };
      path(); ctx.fillStyle = MOUTH_IN; ctx.fill();
      ctx.save(); path(); ctx.clip();
      ctx.fillStyle = teeth;
      ctx.fillRect(-0.14, 0.0, 0.28, 0.08);
      ctx.fillRect(-0.14, -0.13, 0.28, 0.055);
      ctx.restore();
      path(); ctx.lineWidth = 0.022; ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'gritted': {
      const w = 0.13, h = 0.048, r = 0.035;
      roundRect(ctx, -w, -h, w * 2, h * 2, r); ctx.fillStyle = teeth; ctx.fill();
      ctx.lineWidth = 0.02; ctx.strokeStyle = INK; ctx.stroke();
      ctx.lineWidth = 0.012;
      ctx.beginPath();
      ctx.moveTo(-w + 0.01, 0); ctx.lineTo(w - 0.01, 0);
      for (const x of [-0.065, 0, 0.065]) { ctx.moveTo(x, -h + 0.006); ctx.lineTo(x, h - 0.006); }
      ctx.stroke();
      break;
    }
    default:
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(-0.1, 0); ctx.lineTo(0.1, 0); ctx.stroke();
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
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

// ── painted accessories ──

function paintMoustache(ctx, P, withBeard) {
  const y = 0;
  ctx.save();
  ctx.translate(0, (FACE_LAYOUT.noseY + FACE_LAYOUT.mouthY) / 2 + 0.005);
  ctx.scale(1.2, 1.2);
  ctx.fillStyle = withBeard ? P.beard : P.brow;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.03);
  ctx.bezierCurveTo(-0.07, y + 0.07, -0.17, y + 0.03, -0.2, y - 0.045);
  ctx.bezierCurveTo(-0.15, y - 0.03, -0.07, y - 0.045, 0, y - 0.02);
  ctx.bezierCurveTo(0.07, y - 0.045, 0.15, y - 0.03, 0.2, y - 0.045);
  ctx.bezierCurveTo(0.17, y + 0.03, 0.07, y + 0.07, 0, y + 0.03);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function paintBeard(ctx, P) {
  ctx.fillStyle = P.beard;
  ctx.beginPath();
  ctx.moveTo(-0.95, 0.1);
  ctx.bezierCurveTo(-0.98, -0.35, -0.75, -0.82, 0, -0.98);
  ctx.bezierCurveTo(0.75, -0.82, 0.98, -0.35, 0.95, 0.1);
  ctx.lineTo(0.8, 0.1);
  ctx.bezierCurveTo(0.74, -0.12, 0.62, -0.3, 0.3, -0.36);
  ctx.bezierCurveTo(0.12, -0.39, 0.05, -0.52, 0, -0.53);
  ctx.bezierCurveTo(-0.05, -0.52, -0.12, -0.39, -0.3, -0.36);
  ctx.bezierCurveTo(-0.62, -0.3, -0.74, -0.12, -0.8, 0.1);
  ctx.closePath();
  ctx.fill();
}

function paintShades(ctx, ex) {
  const L = FACE_LAYOUT;
  const knocked = ex.eye === 'squeeze' || ex.eye === 'spiral' || ex.eye === 'x';
  ctx.save();
  if (knocked) { ctx.translate(0.02, -0.09); ctx.rotate(-0.2); }
  ctx.strokeStyle = SHADES;
  ctx.lineWidth = 0.045;
  ctx.beginPath();
  ctx.moveTo(-L.eyeX + 0.16, L.eyeY + 0.05); ctx.quadraticCurveTo(0, L.eyeY + 0.09, L.eyeX - 0.16, L.eyeY + 0.05);
  ctx.moveTo(-L.eyeX - 0.16, L.eyeY + 0.06); ctx.lineTo(-1.25, L.eyeY + 0.09);
  ctx.moveTo(L.eyeX + 0.16, L.eyeY + 0.06); ctx.lineTo(1.25, L.eyeY + 0.09);
  ctx.stroke();
  for (const side of [-1, 1]) {
    const cx = side * L.eyeX;
    roundRect(ctx, cx - 0.175, L.eyeY - 0.12, 0.35, 0.23, 0.085);
    ctx.fillStyle = SHADES; ctx.fill();
    // glint
    ctx.save();
    roundRect(ctx, cx - 0.175, L.eyeY - 0.12, 0.35, 0.23, 0.085);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(cx - 0.01, L.eyeY + 0.12); ctx.lineTo(cx + 0.05, L.eyeY + 0.12);
    ctx.lineTo(cx - 0.04, L.eyeY - 0.12); ctx.lineTo(cx - 0.1, L.eyeY - 0.12);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function paintBandage(ctx) {
  // crossed sticking plaster on the boxer's right cheek (viewer's left)
  const cx = -0.53, cy = -0.12;
  for (const rot of [0.55, -0.55]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    roundRect(ctx, -0.14, -0.042, 0.28, 0.084, 0.035);
    ctx.fillStyle = PLASTER; ctx.fill();
    ctx.lineWidth = 0.008; ctx.strokeStyle = shadeHex(PLASTER, -0.18); ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(cx, cy);
  roundRect(ctx, -0.045, -0.04, 0.09, 0.08, 0.02);
  ctx.fillStyle = PLASTER_PAD; ctx.fill();
  ctx.restore();
}

function paintSweat(ctx) {
  const x = 0.6, y = 0.36;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.08);
  ctx.bezierCurveTo(x + 0.02, y + 0.03, x + 0.05, y - 0.005, x + 0.045, y - 0.03);
  ctx.bezierCurveTo(x + 0.04, y - 0.06, x - 0.04, y - 0.06, x - 0.045, y - 0.03);
  ctx.bezierCurveTo(x - 0.05, y - 0.005, x - 0.02, y + 0.03, x, y + 0.08);
  ctx.closePath();
  ctx.fillStyle = TEAR; ctx.fill();
  ctx.lineWidth = 0.012; ctx.strokeStyle = '#4f9ccf'; ctx.stroke();
}

function paintTear(ctx) {
  const x = -FACE_LAYOUT.eyeX - 0.02, y = FACE_LAYOUT.eyeY - 0.13;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.05);
  ctx.bezierCurveTo(x + 0.015, y + 0.02, x + 0.035, y, x + 0.032, y - 0.02);
  ctx.bezierCurveTo(x + 0.028, y - 0.045, x - 0.028, y - 0.045, x - 0.032, y - 0.02);
  ctx.bezierCurveTo(x - 0.035, y, x - 0.015, y + 0.02, x, y + 0.05);
  ctx.closePath();
  ctx.fillStyle = TEAR; ctx.fill();
  ctx.lineWidth = 0.01; ctx.strokeStyle = '#4f9ccf'; ctx.stroke();
}

// ───────────────────────────── texture cache ─────────────────────────────

/** Key of the appearance fields that change the painted face. */
export function faceKey(appearance) {
  const A = validateAppearance(appearance);
  return [A.skin, A.hair.color, A.eyes, A.brows, A.mouth, A.nose, A.accessory, A.trim].join('|');
}

/** @type {Map<string, {texture: THREE.CanvasTexture, refs: number}>} */
const cache = new Map();

function createCanvas(size) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  return null;
}

/** True when this environment can paint face textures (has a canvas). */
export function canPaintFaces() {
  return (typeof document !== 'undefined' && typeof document.createElement === 'function') || typeof OffscreenCanvas !== 'undefined';
}

/**
 * Get (and add a reference to) the face texture for an appearance + expression.
 * Returns null when no canvas is available (e.g. Node). Pair every call with
 * releaseFaceTexture() using the same arguments.
 * @returns {THREE.CanvasTexture|null}
 */
export function acquireFaceTexture(appearance, expression = 'neutral') {
  const expr = normalizeExpression(expression);
  const key = faceKey(appearance) + '#' + expr;
  const hit = cache.get(key);
  if (hit) { hit.refs++; return hit.texture; }
  const canvas = createCanvas(FACE_TEX_SIZE);
  const ctx = canvas && canvas.getContext('2d');
  if (!ctx) return null;
  paintFaceTexture(ctx, appearance, expr, FACE_TEX_SIZE);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.name = 'face:' + expr;
  texture.needsUpdate = true;
  cache.set(key, { texture, refs: 1 });
  return texture;
}

/** Drop one reference; the texture is disposed when nobody uses it any more. */
export function releaseFaceTexture(appearance, expression = 'neutral') {
  const key = faceKey(appearance) + '#' + normalizeExpression(expression);
  const hit = cache.get(key);
  if (!hit) return;
  hit.refs--;
  if (hit.refs <= 0) {
    hit.texture.dispose();
    cache.delete(key);
  }
}

/** Number of live cached face textures (debug/tests). */
export function faceCacheSize() { return cache.size; }

// ───────────────────────────── 2D portrait ─────────────────────────────

/**
 * Draw a flat front-view bust portrait (for profile cards / menus) into a 2D context.
 * Pure canvas drawing, no WebGL. The bust fills a `size`×`size` square at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/types.js').Appearance} appearance
 * @param {{x?:number, y?:number, size?:number, expression?:string, background?:string|null}} [opts]
 */
export function drawPortrait(ctx, appearance, opts = {}) {
  const A = validateAppearance(appearance);
  const size = opts.size ?? 256;
  const ox = opts.x ?? 0, oy = opts.y ?? 0;
  const expr = normalizeExpression(opts.expression ?? 'neutral');
  ctx.save();
  ctx.translate(ox, oy);
  if (opts.background !== null) {
    ctx.fillStyle = opts.background ?? '#fffaf0';
    ctx.fillRect(0, 0, size, size);
  }
  const r = size * 0.24;              // head horizontal radius in px
  const cx = size / 2, cy = size * 0.43;
  const ry = r * HEAD_SHAPE.y;
  const skin = A.skin;
  const hair = A.hair.color;
  const top = A.top === 'none' ? A.skin : A.top;
  const buildW = A.build === 'heavy' ? 1.12 : A.build === 'slim' ? 0.9 : 1;
  // shoulders + neck
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.ellipse(cx, size * 1.02, size * 0.42 * buildW, size * 0.3, 0, Math.PI, 0);
  ctx.fill();
  if (A.top !== 'none') {
    ctx.strokeStyle = A.trim; ctx.lineWidth = size * 0.018;
    ctx.beginPath(); ctx.ellipse(cx, size * 0.76, size * 0.09, size * 0.04, 0, 0, Math.PI); ctx.stroke();
  }
  ctx.fillStyle = shadeHex(skin, -0.06);
  ctx.fillRect(cx - r * 0.36, cy + ry * 0.6, r * 0.72, size * 0.2);
  // hair behind the head
  portraitHairBack(ctx, A.hair.style, hair, cx, cy, r, ry);
  // ears
  ctx.fillStyle = skin;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + s * r * 0.97, cy + ry * 0.06, r * 0.17, r * 0.24, 0, 0, Math.PI * 2); ctx.fill(); }
  if (A.accessory === 'earring') {
    ctx.strokeStyle = '#ffc94a'; ctx.lineWidth = size * 0.012;
    ctx.beginPath(); ctx.arc(cx - r * 0.98, cy + ry * 0.3, r * 0.08, 0, Math.PI * 2); ctx.stroke();
  }
  // head
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.ellipse(cx, cy, r, ry, 0, 0, Math.PI * 2); ctx.fill();
  // face (true proportions in face units)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(r, -r);
  paintFaceFeatures(ctx, A, expr);
  ctx.restore();
  portraitHairFront(ctx, A.hair.style, hair, cx, cy, r, ry);
  if (A.accessory === 'headband') {
    ctx.strokeStyle = A.trim; ctx.lineWidth = r * 0.16;
    ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.42, r * 0.97, r * 0.2, 0, 0.05, Math.PI - 0.05); ctx.stroke();
  }
  if (A.accessory === 'goggles') {
    ctx.strokeStyle = '#3a3f55'; ctx.lineWidth = r * 0.1;
    ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.52, r * 0.96, r * 0.16, 0, 0.1, Math.PI - 0.1); ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#9fe3ff'; ctx.strokeStyle = '#3a3f55'; ctx.lineWidth = r * 0.07;
      ctx.beginPath(); ctx.ellipse(cx + s * r * 0.33, cy - ry * 0.55, r * 0.22, r * 0.17, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

function portraitHairBack(ctx, style, color, cx, cy, r, ry) {
  ctx.fillStyle = color;
  switch (style) {
    case 'afro':
      ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.25, r * 1.45, ry * 1.05, 0, 0, Math.PI * 2); ctx.fill(); break;
    case 'bob':
      ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.05, r * 1.17, ry * 1.08, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(cx - r * 1.17, cy - ry * 0.05, r * 2.34, ry * 0.75); break;
    case 'ponytail':
      ctx.beginPath(); ctx.ellipse(cx + r * 0.95, cy + ry * 0.2, r * 0.22, ry * 0.55, -0.25, 0, Math.PI * 2); ctx.fill(); break;
    case 'bun':
      ctx.beginPath(); ctx.arc(cx, cy - ry * 1.05, r * 0.36, 0, Math.PI * 2); ctx.fill(); break;
    case 'curly':
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * (0.05 + 0.9 * (i / 8));
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r * 0.98, cy - Math.sin(a) * ry * 0.95, r * 0.26, 0, Math.PI * 2); ctx.fill();
      }
      break;
    default: break;
  }
}

function portraitHairFront(ctx, style, color, cx, cy, r, ry) {
  ctx.fillStyle = color;
  const cap = (top, line, dip = 0.12) => {
    // hair cap from above the crown down to a hairline at `line` (fraction of ry above centre);
    // control points are lifted so the curve's peak clears the head by `top`
    const peak = (1 + top + 0.25 * (line - dip)) / 0.75;
    ctx.beginPath();
    ctx.moveTo(cx - r * 1.02, cy - ry * (line - dip));
    ctx.bezierCurveTo(cx - r * 1.08, cy - ry * peak, cx + r * 1.08, cy - ry * peak, cx + r * 1.02, cy - ry * (line - dip));
    ctx.bezierCurveTo(cx + r * 0.7, cy - ry * line, cx - r * 0.7, cy - ry * line, cx - r * 1.02, cy - ry * (line - dip));
    ctx.closePath();
    ctx.fill();
  };
  switch (style) {
    case 'bald': break;
    case 'buzz': ctx.globalAlpha = 0.55; cap(0.04, 0.5); ctx.globalAlpha = 1; break;
    case 'crew': cap(0.12, 0.5); break;
    case 'flat-top':
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.0, cy - ry * 0.35);
      ctx.lineTo(cx - r * 0.95, cy - ry * 1.32); ctx.lineTo(cx + r * 0.95, cy - ry * 1.32);
      ctx.lineTo(cx + r * 1.0, cy - ry * 0.35);
      ctx.bezierCurveTo(cx + r * 0.6, cy - ry * 0.52, cx - r * 0.6, cy - ry * 0.52, cx - r * 1.0, cy - ry * 0.35);
      ctx.fill(); break;
    case 'spiky':
      cap(0.1, 0.48);
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const x = cx - r * 0.85 + i * r * 0.283;
        ctx.moveTo(x - r * 0.16, cy - ry * 0.9);
        ctx.lineTo(x + r * 0.05, cy - ry * (1.35 + (i % 2) * 0.12));
        ctx.lineTo(x + r * 0.2, cy - ry * 0.9);
      }
      ctx.fill(); break;
    case 'mohawk':
      ctx.globalAlpha = 0.35; cap(0.03, 0.5); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.ellipse(cx, cy - ry * 1.02, r * 0.2, ry * 0.42, 0, 0, Math.PI * 2); ctx.fill(); break;
    case 'afro': cap(0.18, 0.55, 0.05); break;
    case 'bob':
      cap(0.1, 0.42, 0.02);
      break;
    case 'cornrows':
      cap(0.06, 0.52);
      ctx.strokeStyle = shadeHex(color, 0.25); ctx.lineWidth = r * 0.04;
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(cx + i * r * 0.3, cy - ry * 0.62); ctx.lineTo(cx + i * r * 0.38, cy - ry * 1.05); ctx.stroke(); }
      break;
    case 'curly': cap(0.12, 0.5); break;
    case 'ponytail': case 'bun': default: cap(0.1, 0.5); break;
  }
}
