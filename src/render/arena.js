// The fight venue: ring, ropes, posts, corner pads, steps, tiered crowd, hanging light rig,
// fake-volumetric spotlight cones, camera-flash sparkles and the arena lights.
//
// Owner: view3d. Art direction and palette come from ./style.js (our own design: warm ivory canvas,
// teal medallion with "GLOVE UP" lettering, navy apron with golden text, coral/cream/teal ropes,
// golden posts, blue/red/neutral corner pads). UI01: the ring is lit like a bright stage inside a
// dark navy hall so both boxers and their gloves always read clearly.
//
// Alignment pass (research/mechanics.md §6):
//   * the slow orbit of the live view ("a corner post crosses the frame in about 20 s") is the
//     venue turning under the fighters: everything but the lights sits in a `stage` group that
//     setYaw() rotates, so cameras, fighters and effects keep their simple fixed frame;
//   * the crowd reacts to hits (cheer), swells on knockdowns and roars on a KO (roar);
//   * boards above the stands show our own flavour taunts — never gameplay information.
//
// Performance (≥60 fps on a laptop): the whole crowd is 4 instanced draw calls animated entirely in
// the vertex shader (no per-frame CPU work per figure); ropes/tiers/truss are merged; one shadow
// casting light (the key spot) with a cone that only covers the ring.
//
// Imports cleanly in Node (no DOM at import time). Canvas-drawn textures are only created when a
// `document` exists; otherwise plain colours are used (unit tests).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PALETTE, VENUE_LIGHTING as LIGHTING, LAYOUT, FONTS, css } from './style.js';
import { APPEARANCE_OPTIONS } from '../core/types.js';

/** Every visual knob of the venue. Distances in metres. */
export const ARENA_TUNING = Object.freeze({
  platformHalf: 3.62,        // canvas/apron edge (ropes are at LAYOUT.ringHalf = 3.0)
  postOffset: 0.1,           // posts sit this far outside the rope square (diagonally per axis)
  postRadius: 0.072,
  postTop: 1.34,
  ropeRadius: 0.027,
  ropeSag: 0.04,             // vertical sag at mid-span
  padSize: [0.3, 1.0, 0.17], // corner pad (w, h, d)
  padBottom: 0.26,
  floorY: -LAYOUT.apronDrop, // arena floor height
  barrier: { dist: 5.15, height: 0.86 },
  crowd: {
    rows: 7, firstRow: 6.15, rowDepth: 0.95, rowRise: 0.43, stepBase: 0.3,
    spacing: 0.6, emptyChance: 0.09, scale: [0.86, 1.14],
    bodyBrightness: 0.78, skinBrightness: 0.9, baldChance: 0.18,
    dim: 0.26, dimExcited: 0.4,  // overall crowd brightness (shader multiplier) calm → roaring (a dark hall: VISUAL-10)
    excitementLambda: 2.5,   // how fast the crowd follows the excitement level (1/s)
    cheerDecaySec: 2.4,      // a cheer fades over this long
  },
  rig: { height: 6.35, half: 3.95, lampsPerSide: 4 },
  cones: { intensity: 0.1, radius: 1.45 },
  flashes: { idleRate: 0.45, excitedRate: 5.5, burst: 36, burstSec: 1.4, life: [0.07, 0.17], size: 0.55, cap: 72 },
  // a tighter, softer spot: full light on the fighters, falling off toward the ring's corners (spotlit ring, VISUAL-10)
  key: { angle: 0.48, penumbra: 0.7, shadowMap: 2048, shadowRadius: 4, bias: -0.00035, normalBias: 0.025 },
  envIntensity: 0.22,        // scene.environmentIntensity the renderer should use (glossy gloves)
  canvasTexSize: 2048,
  boards: { dist: 12.35, y: 2.75, w: 6.2, h: 1.45, cycleSec: 5.5 },
  roar: { holdSec: 2.6 },
});

/** Our own flavour taunts for the arena boards (no gameplay information, no names). */
export const BOARD_TAUNTS = Object.freeze(['WHAM!', 'OOF!', 'POW!', 'GLOVES UP!', 'WHAT A JAB!', 'ROAR!', 'BIG ONE!', 'GO GO GO!']);

// ───────────────────────────── small utilities ─────────────────────────────

/** mulberry32 — tiny seeded PRNG so the crowd layout is identical every run. */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hasDOM = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

/** Adds a constant vertex colour so differently coloured parts can be merged into one draw call. */
function paint(geo, hex, mul = 1) {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Strip to position/normal/uv/color so merges never fail on attribute mismatches. */
function normalizeAttrs(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

function merge(geos) {
  const m = mergeGeometries(geos.map(normalizeAttrs), false);
  for (const g of geos) g.dispose();
  return m;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasTexture(canvas, { repeatX = 1, anisotropy = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeatX !== 1) { t.wrapS = THREE.RepeatWrapping; t.repeat.x = repeatX; }
  return t;
}

/** 5-point star path. */
function starPath(ctx, cx, cy, rOut, rIn, points = 5, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = rot + (i * Math.PI) / points;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

/** Text along the TOP of a circle, upright when the image is viewed normally. */
function arcText(ctx, text, cx, cy, radius, px, spacing = 0.06) {
  ctx.font = `${px}px ${FONTS.display}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const widths = [...text].map((ch) => ctx.measureText(ch).width + px * spacing);
  const total = widths.reduce((a, b) => a + b, 0);
  let acc = 0;
  const start = -Math.PI / 2 - total / radius / 2;
  [...text].forEach((ch, i) => {
    const a = start + (acc + widths[i] / 2) / radius;
    acc += widths[i];
    ctx.save();
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(a + Math.PI / 2);
    ctx.strokeText(ch, 0, 0);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
}

// ───────────────────────────── textures (browser only) ─────────────────────────────

function drawCanvasMat(canvas) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const half = ARENA_TUNING.platformHalf;
  const m = S / (2 * half);                  // px per metre
  const C = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = css(PALETTE.canvasEdge);
  ctx.fillRect(0, 0, S, S);
  // apron edge band
  ctx.fillStyle = css(PALETTE.apron);
  ctx.fillRect(0, 0, S, 0.06 * m); ctx.fillRect(0, S - 0.06 * m, S, 0.06 * m);
  ctx.fillRect(0, 0, 0.06 * m, S); ctx.fillRect(S - 0.06 * m, 0, 0.06 * m, S);
  // inside the ropes
  const ip = (half - LAYOUT.ringHalf) * m;
  ctx.fillStyle = css(PALETTE.canvas);
  ctx.fillRect(ip, ip, S - 2 * ip, S - 2 * ip);
  // very soft vignette toward the ropes so the centre glows under the lights
  const g = ctx.createRadialGradient(C, C, 0.6 * m, C, C, 3.4 * m);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(160,140,110,0.10)');
  ctx.fillStyle = g;
  ctx.fillRect(ip, ip, S - 2 * ip, S - 2 * ip);
  // thin teal inner border
  ctx.strokeStyle = css(PALETTE.canvasLogo);
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 0.045 * m;
  const bi = ip + 0.3 * m;
  ctx.strokeRect(bi, bi, S - 2 * bi, S - 2 * bi);
  ctx.globalAlpha = 1;
  // corner quarter-circles in corner colours: P1 corner (+X,+Z) = image bottom-right, P2 (-X,-Z) = top-left
  const cr = 0.62 * m;
  const corner = (x, y, col, a0) => {
    ctx.fillStyle = col; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, cr, a0, a0 + Math.PI / 2); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  };
  corner(S - ip, S - ip, css(PALETTE.turnbuckleP1), Math.PI);
  corner(ip, ip, css(PALETTE.turnbuckleP2), 0);
  const neutral = '#' + new THREE.Color(PALETTE.turnbuckleN).multiplyScalar(0.9).getHexString();
  corner(S - ip, ip, neutral, Math.PI / 2);
  corner(ip, S - ip, neutral, -Math.PI / 2);
  // centre medallion
  const R = 1.28 * m;
  ctx.fillStyle = css(PALETTE.canvasLogo);
  ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = css(PALETTE.canvasLogo); ctx.lineWidth = 0.035 * m;
  ctx.beginPath(); ctx.arc(C, C, R + 0.14 * m, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = css(PALETTE.canvas); ctx.lineWidth = 0.05 * m;
  ctx.beginPath(); ctx.arc(C, C, R - 0.1 * m, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(C, C, 0.62 * m, 0, Math.PI * 2); ctx.stroke();
  // centre star
  ctx.fillStyle = css(PALETTE.apronText);
  starPath(ctx, C, C, 0.36 * m, 0.16 * m);
  ctx.fill();
  ctx.strokeStyle = css(PALETTE.canvas); ctx.lineWidth = 0.025 * m; ctx.stroke();
  // lettering: once readable from P1's side (far half), once from P2's side (rotated 180°)
  ctx.fillStyle = css(PALETTE.canvas);
  ctx.strokeStyle = css(0x17807a); ctx.lineWidth = 0.035 * m; ctx.lineJoin = 'round';
  const px = Math.round(0.34 * m);
  arcText(ctx, 'GLOVE UP', C, C, R - 0.38 * m, px, 0.08);
  ctx.save(); ctx.translate(C, C); ctx.rotate(Math.PI); ctx.translate(-C, -C);
  arcText(ctx, 'GLOVE UP', C, C, R - 0.38 * m, px, 0.08);
  ctx.restore();
  // small stars at the medallion sides
  ctx.fillStyle = css(PALETTE.apronText);
  for (const sx of [-1, 1]) { starPath(ctx, C + sx * (R - 0.38 * m), C, 0.1 * m, 0.045 * m); ctx.fill(); }
}

function drawApron(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = css(PALETTE.apron);
  ctx.fillRect(0, 0, W, H);
  // subtle vertical gradient for depth
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css(PALETTE.apronText);
  ctx.fillRect(0, H * 0.07, W, H * 0.035);
  ctx.fillRect(0, H * 0.895, W, H * 0.035);
  ctx.font = `${Math.round(H * 0.46)}px ${FONTS.display}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = H * 0.03; ctx.strokeStyle = css(0x14182b); ctx.lineJoin = 'round';
  ctx.strokeText('GLOVE UP', W / 2, H * 0.52);
  ctx.fillText('GLOVE UP', W / 2, H * 0.52);
  const tw = ctx.measureText('GLOVE UP').width;
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = W / 2 + sx * (tw / 2 + H * 0.38 + k * H * 0.55);
      starPath(ctx, x, H * 0.5, H * (0.13 - k * 0.02), H * (0.055 - k * 0.008));
      ctx.fill();
    }
  }
}

function drawLedRibbon(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, css(0x1f3b73)); g.addColorStop(1, css(0x16264d));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.font = `${Math.round(H * 0.56)}px ${FONTS.display}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const words = ['GLOVE UP', 'GLOVE UP'];
  const cols = [css(PALETTE.apronText), css(PALETTE.ropeC)];
  const step = W / words.length;
  words.forEach((w, i) => {
    ctx.fillStyle = cols[i % cols.length];
    ctx.fillText(w, step * (i + 0.5), H * 0.54);
    ctx.fillStyle = css(PALETTE.ropeA);
    starPath(ctx, step * (i + 1), H * 0.5, H * 0.16, H * 0.07); ctx.fill();
  });
}

function drawCrowdFace(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  // sphere UV: u = 0.25 faces local +Z (toward the ring); v = 0.5 is the equator
  const cx = W * 0.25, cy = H * 0.5;
  ctx.fillStyle = '#2a2230';
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * W * 0.03, cy - H * 0.04, W * 0.011, H * 0.035, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#7a3a3a'; ctx.lineWidth = W * 0.007; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy + H * 0.035, W * 0.026, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
  // cheek blush
  ctx.fillStyle = 'rgba(255,120,120,0.22)';
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * W * 0.05, cy + H * 0.04, W * 0.014, H * 0.03, 0, 0, Math.PI * 2); ctx.fill(); }
}

/** Radial gradient (DataTexture, no DOM) for the arena floor: lighter pool under the ring. */
function floorTexture() {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  const inner = new THREE.Color(0x343f6b), outer = new THREE.Color(PALETTE.floor);
  const tmp = new THREE.Color();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1;
    const r = Math.hypot(u, v);
    const t = clamp01((r - 0.06) / 0.35);
    tmp.copy(inner).lerp(outer, t * t * (3 - 2 * t));
    const i = (y * S + x) * 4;
    data[i] = tmp.r * 255; data[i + 1] = tmp.g * 255; data[i + 2] = tmp.b * 255; data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ───────────────────────────── shaders ─────────────────────────────

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DOME_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uTime;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uBottom, uTop, smoothstep(-0.12, 0.5, h));
  // distant upper-deck crowd: a softly speckled band with a few twinkling phone lights
  float az = atan(d.z, d.x);
  vec2 g = vec2(az * 70.0, h * 150.0);
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float r = hash(id);
  float band = smoothstep(-0.03, 0.05, h) * (1.0 - smoothstep(0.17, 0.32, h));
  float dotm = (1.0 - smoothstep(0.16, 0.34, length(f))) * step(0.42, r);
  vec3 dc = mix(vec3(0.55, 0.5, 0.78), vec3(1.0, 0.72, 0.5), fract(r * 7.13));
  col += dc * dotm * band * 0.07;
  float tw = step(0.988, r) * (0.5 + 0.5 * sin(uTime * (1.5 + r * 4.0) + r * 50.0));
  col += vec3(1.0, 0.96, 0.88) * tw * band * dotm * 0.55;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const CONE_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;
const CONE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float along = vUv.y;                                    // 1 at the lamp, 0 at the canvas
  float fall = pow(along, 1.7) * (1.0 - smoothstep(0.95, 1.0, along)) + 0.1 * along;
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float a = uIntensity * fall * pow(facing, 2.0);
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const GLOW_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
uniform float uMaxSize;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.05, -mv.z), 0.0, uMaxSize);
  vAlpha = aAlpha;
}`;
const GLOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uStar;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float a = pow(max(0.0, 1.0 - r), 2.2) + 0.6 * exp(-r * r * 30.0);
  float cross = max(1.0 - smoothstep(0.0, 0.1, abs(p.x)), 1.0 - smoothstep(0.0, 0.1, abs(p.y))) * (1.0 - smoothstep(0.1, 1.0, r));
  a = mix(a, max(a * 0.7, cross), uStar) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const CROWD_PARS = /* glsl */`
uniform float uTime;
uniform float uExcite;
uniform float uCheer;
uniform float uWave;
attribute vec4 aFig;   // x: phase (0..2π)  y: energy (0.6..1.4)  z: angle around the ring  w: arm side (±1, 0 = not an arm)
float crowdLift(vec4 f) {
  float idle = 0.016 * f.y * (0.5 + 0.5 * sin(uTime * (1.2 + 0.9 * f.y) + f.x));
  float bounce = uExcite * 0.055 * max(0.0, sin(uTime * (4.4 + 2.0 * f.y) + f.x));
  float jumper = step(0.32, fract(f.x * 1.37 + f.y * 3.1));
  float jump = uCheer * jumper * 0.2 * max(0.0, sin(uTime * (8.0 + 2.6 * f.y) + f.x * 3.0));
  float wave = uWave * 0.26 * smoothstep(0.8, 1.0, sin(f.z - uTime * 2.1));
  return idle + bounce + jump + wave;
}
float crowdArms(vec4 f) {
  float raiser = step(0.22, fract(f.x * 2.71 + f.y * 1.3));
  float fan = step(0.62, fract(f.x * 5.3));
  float r = clamp(uExcite * 0.9 - 0.3, 0.0, 1.0) * fan + uCheer * 1.35 * raiser;
  float wave = uWave * smoothstep(0.7, 1.0, sin(f.z - uTime * 2.1 + 0.25));
  return clamp(max(r, wave), 0.0, 1.0);
}
`;
const CROWD_FRAG_PARS = /* glsl */`
uniform float uDim;
uniform vec3 uHaze;
varying float vCrowdDist;
`;

function crowdMaterial(kind, uniforms, map = null) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, map });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms); // shared uniform objects → one update drives all crowd meshes
    // the crowd sits back in the dim hall: global dimmer (brighter when roaring) + darker toward the back rows
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CROWD_FRAG_PARS}`)
      .replace('#include <dithering_fragment>', `float crowdBack = smoothstep(6.0, 12.5, vCrowdDist);\n  gl_FragColor.rgb = mix(gl_FragColor.rgb * uDim, uHaze, 0.22 + 0.33 * crowdBack);\n#include <dithering_fragment>`);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CROWD_PARS}\nvarying float vCrowdDist;`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n#ifdef USE_INSTANCING\n  vCrowdDist = length((instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz);\n#else\n  vCrowdDist = 8.0;\n#endif`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        ${kind === 'arm' ? `
        float armA = aFig.w * mix(0.16, 2.7 + 0.22 * sin(uTime * 9.0 + aFig.x * 2.0), crowdArms(aFig));
        float armC = cos(armA), armS = sin(armA);
        objectNormal.xy = vec2(armC * objectNormal.x - armS * objectNormal.y, armS * objectNormal.x + armC * objectNormal.y);` : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${kind === 'arm' ? 'transformed.xy = vec2(armC * transformed.x - armS * transformed.y, armS * transformed.x + armC * transformed.y);' : ''}
        transformed.y += crowdLift(aFig);`);
  };
  mat.customProgramCacheKey = () => `glove-crowd-${kind}`;
  return mat;
}

// ───────────────────────────── glow points (lamp halos, camera flashes) ─────────────────────────────

const _vp = new THREE.Vector4();

function glowPoints(capacity, color, { star = 0, maxSize = 220 } = {}) {
  const pos = new Float32Array(capacity * 3);
  const size = new Float32Array(capacity);
  const alpha = new Float32Array(capacity);
  const g = new THREE.BufferGeometry();
  const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const sa = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const aa = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pa); g.setAttribute('aSize', sa); g.setAttribute('aAlpha', aa);
  const uniforms = { uScale: { value: 600 }, uMaxSize: { value: maxSize }, uColor: { value: new THREE.Color(color) }, uStar: { value: star } };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  points.onBeforeRender = (renderer, _s, camera) => {
    renderer.getCurrentViewport(_vp);
    uniforms.uScale.value = _vp.w / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2));
  };
  return { points, pos, size, alpha, attrs: [pa, sa, aa] };
}

// ───────────────────────────── builders ─────────────────────────────

function buildRing(group, mats, textures) {
  const T = ARENA_TUNING;
  const half = T.platformHalf;
  const fy = T.floorY;

  // platform body (sides are covered by the apron skirt)
  const platform = new THREE.Mesh(new THREE.BoxGeometry(half * 2, -fy, half * 2), mats.apronBody);
  platform.position.y = fy / 2 - 0.004;
  platform.castShadow = true; platform.receiveShadow = true;
  group.add(platform);

  // canvas mat
  const canvas = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2), mats.canvas);
  canvas.receiveShadow = true;
  canvas.name = 'canvas';
  group.add(canvas);

  // apron skirt (4 sides, golden lettering)
  const skirtH = -fy - 0.03;
  const skirtGeo = new THREE.PlaneGeometry(half * 2 + 0.01, skirtH);
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(skirtGeo, mats.apron);
    const a = (i * Math.PI) / 2;
    m.position.set(Math.sin(a) * (half + 0.006), -0.015 - skirtH / 2, Math.cos(a) * (half + 0.006));
    m.rotation.y = a;
    group.add(m);
  }
  // rounded canvas lip along the edge (catches the light, hides the seam)
  const lips = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.CylinderGeometry(0.035, 0.035, half * 2 + 0.07, 8).rotateZ(Math.PI / 2);
    const a = (i * Math.PI) / 2;
    g.rotateY(a); g.translate(Math.sin(a) * half, -0.02, Math.cos(a) * half);
    lips.push(paint(g, PALETTE.canvasEdge));
  }
  group.add(new THREE.Mesh(merge(lips), mats.vertexStd));

  // posts + caps (one merged draw call)
  const postR = LAYOUT.ringHalf + T.postOffset;
  const postGeos = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const pg = new THREE.CylinderGeometry(T.postRadius, T.postRadius * 1.15, T.postTop + 0.06, 14);
    pg.translate(sx * postR, T.postTop / 2 - 0.03, sz * postR);
    postGeos.push(paint(pg, PALETTE.post));
    const cap = new THREE.SphereGeometry(T.postRadius * 1.35, 14, 10);
    cap.translate(sx * postR, T.postTop + 0.02, sz * postR);
    postGeos.push(paint(cap, PALETTE.post));
  }
  const posts = new THREE.Mesh(merge(postGeos), mats.gold);
  posts.castShadow = true;
  group.add(posts);

  // corner pads: P1 (blue) at (+X,+Z), P2 (red) at (-X,-Z), neutral at the other two
  const [pw, ph, pd] = T.padSize;
  const padGeos = [];
  const corners = [[1, 1, PALETTE.turnbuckleP1], [-1, -1, PALETTE.turnbuckleP2], [1, -1, PALETTE.turnbuckleN], [-1, 1, PALETTE.turnbuckleN]];
  for (const [sx, sz, col] of corners) {
    const g = new RoundedBoxGeometry(pw, ph, pd, 3, 0.06);
    g.translate(0, 0, -pd / 2 + 0.01);
    g.rotateY(Math.atan2(sx, sz)); // local -Z (pad front) → toward the ring centre
    g.translate(sx * (LAYOUT.ringHalf + 0.02), T.padBottom + ph / 2, sz * (LAYOUT.ringHalf + 0.02));
    padGeos.push(paint(g, col));
  }
  const pads = new THREE.Mesh(merge(padGeos), mats.vertexStd);
  pads.castShadow = true;
  group.add(pads);

  // ropes: top coral, middle cream, bottom teal, each slightly sagging between the corners
  const ropeCols = [PALETTE.ropeC, PALETTE.ropeB, PALETTE.ropeA]; // bottom → top
  const ropeGeos = [];
  const rh = LAYOUT.ringHalf;
  const cornersXZ = [[rh, rh], [-rh, rh], [-rh, -rh], [rh, -rh]];
  LAYOUT.ropeHeights.forEach((hgt, k) => {
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = cornersXZ[i];
      const [x1, z1] = cornersXZ[(i + 1) % 4];
      const sag = T.ropeSag * (0.75 + 0.25 * k);
      const p0 = new THREE.Vector3(x0, hgt, z0), p2 = new THREE.Vector3(x1, hgt, z1);
      const p1 = new THREE.Vector3((x0 + x1) / 2, hgt - 2 * sag, (z0 + z1) / 2);
      const tube = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(p0, p1, p2), 36, T.ropeRadius, 8, false);
      ropeGeos.push(paint(tube, ropeCols[k]));
      // little tape bands at the thirds (cartoon detail)
      for (const f of [1 / 3, 2 / 3]) {
        const c = new THREE.QuadraticBezierCurve3(p0, p1, p2).getPoint(f);
        const band = new THREE.CylinderGeometry(T.ropeRadius * 1.25, T.ropeRadius * 1.25, 0.06, 10);
        if (Math.abs(x1 - x0) > 0.1) band.rotateZ(Math.PI / 2); else band.rotateX(Math.PI / 2);
        band.translate(c.x, c.y, c.z);
        ropeGeos.push(paint(band, k === 1 ? PALETTE.ropeC : PALETTE.ropeB));
      }
    }
  });
  const ropes = new THREE.Mesh(merge(ropeGeos), mats.rope);
  ropes.castShadow = true;
  ropes.name = 'ropes';
  group.add(ropes);

  // steps up to the apron beside the blue and the red corner
  const stepGeos = [];
  for (const [sx, sz] of [[1, 1], [-1, -1]]) {
    for (let i = 0; i < 3; i++) {
      const h = (-fy) * (i + 1) / 3.2;
      const d = 0.32;
      const g = new THREE.BoxGeometry(d, h, 0.95);
      g.translate(sx * (half + d * (3 - i) - d / 2), fy + h / 2, sz * 2.15);
      stepGeos.push(paint(g, 0x2b3762));
      const nose = new THREE.BoxGeometry(0.05, 0.03, 0.95);
      nose.translate(sx * (half + d * (3 - i) - 0.03), fy + h + 0.012, sz * 2.15);
      stepGeos.push(paint(nose, PALETTE.post));
    }
  }
  const steps = new THREE.Mesh(merge(stepGeos), mats.vertexStd);
  steps.receiveShadow = true;
  group.add(steps);

  return { canvas, platform, ropes, posts, pads };
}

function buildHall(group, mats, textures) {
  const T = ARENA_TUNING;
  const fy = T.floorY;

  // floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90).rotateX(-Math.PI / 2), mats.floor);
  floor.position.y = fy;
  floor.receiveShadow = true;
  group.add(floor);

  // barrier wall with an LED ribbon facing the ring
  const B = T.barrier;
  const wallGeos = [];
  const ribbonGeos = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const len = B.dist * 2 + 0.25;
    const wall = new THREE.BoxGeometry(len, B.height, 0.22);
    wall.translate(0, fy + B.height / 2, -B.dist - 0.11).rotateY(a);
    wallGeos.push(paint(wall, 0x1a2547));
    const trim = new THREE.BoxGeometry(len, 0.05, 0.26);
    trim.translate(0, fy + B.height + 0.02, -B.dist - 0.11).rotateY(a);
    wallGeos.push(paint(trim, PALETTE.post));
    const rib = new THREE.PlaneGeometry(len - 0.2, B.height * 0.62);
    rib.translate(0, fy + B.height * 0.52, -B.dist + 0.005).rotateY(a);
    ribbonGeos.push(rib);
  }
  group.add(new THREE.Mesh(merge(wallGeos), mats.vertexStd));
  const ribbon = new THREE.Mesh(merge(ribbonGeos), mats.ribbon);
  group.add(ribbon);

  // judges' table with a golden bell beside the blue corner side (+X)
  const tableGeos = [];
  const tb = new THREE.BoxGeometry(0.7, 0.75, 2.2); tb.translate(4.45, fy + 0.375, -0.6);
  tableGeos.push(paint(tb, 0x26325c));
  const top = new THREE.BoxGeometry(0.8, 0.05, 2.3); top.translate(4.45, fy + 0.77, -0.6);
  tableGeos.push(paint(top, PALETTE.canvasEdge));
  const bell = new THREE.SphereGeometry(0.14, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2); bell.translate(4.45, fy + 0.8, 0.25);
  tableGeos.push(paint(bell, PALETTE.post));
  group.add(new THREE.Mesh(merge(tableGeos), mats.vertexStd));

  // tiered stands (concentric square steps)
  const C = T.crowd;
  const tierGeos = [];
  for (let r = 0; r < C.rows; r++) {
    const d = C.firstRow + r * C.rowDepth;
    const topY = fy + C.stepBase + r * C.rowRise;
    const h = topY - fy;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const g = new THREE.BoxGeometry(2 * (d + C.rowDepth / 2), h, C.rowDepth);
      g.translate(0, fy + h / 2, -d).rotateY(a);
      tierGeos.push(paint(g, r % 2 ? 0x2a3157 : 0x30385f));
      const edge = new THREE.BoxGeometry(2 * (d - C.rowDepth / 2) + 0.02, 0.035, 0.04);
      edge.translate(0, topY + 0.004, -d + C.rowDepth / 2 - 0.02).rotateY(a);
      tierGeos.push(paint(edge, r % 2 ? PALETTE.ropeC : 0x3d7bff, 0.55));
    }
  }
  const tiers = new THREE.Mesh(merge(tierGeos), mats.tiers);
  group.add(tiers);

  // background dome
  const dome = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 18), mats.dome);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  return { floor, ribbon, tiers, dome };
}

function buildCrowd(group, uniforms, faceTex, quality, seed) {
  const T = ARENA_TUNING.crowd;
  const fy = ARENA_TUNING.floorY;
  const rand = rng32(seed);
  const density = quality === 'low' ? 0.62 : 1;
  const rows = quality === 'low' ? T.rows - 2 : T.rows;
  const figs = [];
  for (let r = 0; r < rows; r++) {
    const d = T.firstRow + r * T.rowDepth;
    const baseY = fy + T.stepBase + r * T.rowRise;
    const sp = T.spacing / density;
    const n = Math.floor((2 * d) / sp);
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < n; i++) {
        if (rand() < T.emptyChance) continue;
        const t = -d + (i + 0.5) * ((2 * d) / n) + (rand() - 0.5) * 0.1;
        const depthJit = (rand() - 0.5) * 0.12;
        let x, z;
        if (side === 0) { x = t; z = -(d + depthJit); }
        else if (side === 1) { x = d + depthJit; z = t; }
        else if (side === 2) { x = -t; z = d + depthJit; }
        else { x = -(d + depthJit); z = -t; }
        figs.push({
          x, y: baseY, z,
          yaw: Math.atan2(-x, -z) + (rand() - 0.5) * 0.35,
          s: T.scale[0] + rand() * (T.scale[1] - T.scale[0]),
          body: PALETTE.crowd[Math.floor(rand() * PALETTE.crowd.length)],
          skin: APPEARANCE_OPTIONS.skinTones[Math.floor(rand() * APPEARANCE_OPTIONS.skinTones.length)],
          hair: APPEARANCE_OPTIONS.hairColors[Math.floor(rand() * APPEARANCE_OPTIONS.hairColors.length)],
          bald: rand() < T.baldChance,
          phase: rand() * Math.PI * 2,
          energy: 0.6 + rand() * 0.8,
          ang: Math.atan2(z, x),
        });
      }
    }
  }
  const n = figs.length;

  // low tessellation: figures are small on screen (≈300 triangles per fan)
  const bodyGeo = new THREE.CapsuleGeometry(0.16, 0.26, 3, 9).translate(0, 0.29, 0);
  const headGeo = new THREE.SphereGeometry(0.15, 12, 8).translate(0, 0.7, 0);
  const hairGeo = new THREE.SphereGeometry(0.159, 12, 4, 0, Math.PI * 2, 0, Math.PI * 0.46).rotateX(-0.32).translate(0, 0.705, -0.006);
  const armGeo = new THREE.CapsuleGeometry(0.048, 0.2, 2, 5).translate(0, -0.148, 0);

  const mk = (geo, kind, count, map) => {
    const mesh = new THREE.InstancedMesh(geo, crowdMaterial(kind, uniforms, map), count);
    mesh.frustumCulled = false; // instances span the whole hall; the bounding sphere would be the hall anyway
    mesh.name = `crowd-${kind}`;
    group.add(mesh);
    return mesh;
  };
  const body = mk(bodyGeo, 'body', n);
  const head = mk(headGeo, 'head', n, faceTex);
  const hair = mk(hairGeo, 'hair', n);
  const arms = mk(armGeo, 'arm', n * 2);

  const figAttr = new Float32Array(n * 4);
  const armAttr = new Float32Array(n * 8);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const armM = new THREE.Matrix4();
  const c = new THREE.Color();
  const heads = new Float32Array(n * 3);
  const up = new THREE.Vector3(0, 1, 0);
  figs.forEach((f, i) => {
    q.setFromAxisAngle(up, f.yaw);
    p.set(f.x, f.y, f.z);
    sc.setScalar(f.s);
    m.compose(p, q, sc);
    body.setMatrixAt(i, m);
    head.setMatrixAt(i, m);
    if (f.bald) { sc.setScalar(0); m.compose(p, q, sc); }
    hair.setMatrixAt(i, m);
    sc.setScalar(f.s);
    m.compose(p, q, sc);
    for (const [k, side] of [[0, -1], [1, 1]]) {
      armM.makeTranslation(side * 0.17, 0.5, 0.0);
      arms.setMatrixAt(i * 2 + k, armM.premultiply(m));
      const o = (i * 2 + k) * 4;
      armAttr[o] = f.phase; armAttr[o + 1] = f.energy; armAttr[o + 2] = f.ang; armAttr[o + 3] = side;
    }
    body.setColorAt(i, c.setHex(f.body).multiplyScalar(T.bodyBrightness));
    head.setColorAt(i, c.set(f.skin).multiplyScalar(T.skinBrightness));
    hair.setColorAt(i, c.set(f.hair).multiplyScalar(0.85));
    arms.setColorAt(i * 2, c.setHex(f.body).multiplyScalar(T.bodyBrightness));
    arms.setColorAt(i * 2 + 1, c.setHex(f.body).multiplyScalar(T.bodyBrightness));
    figAttr[i * 4] = f.phase; figAttr[i * 4 + 1] = f.energy; figAttr[i * 4 + 2] = f.ang; figAttr[i * 4 + 3] = 0;
    heads[i * 3] = f.x; heads[i * 3 + 1] = f.y + 0.75 * f.s; heads[i * 3 + 2] = f.z;
  });
  const figBuf = new THREE.InstancedBufferAttribute(figAttr, 4);
  bodyGeo.setAttribute('aFig', figBuf);
  headGeo.setAttribute('aFig', figBuf);
  hairGeo.setAttribute('aFig', figBuf);
  armGeo.setAttribute('aFig', new THREE.InstancedBufferAttribute(armAttr, 4));
  for (const mesh of [body, head, hair, arms]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  return { count: n, heads, meshes: [body, head, hair, arms] };
}

function buildRig(group, mats) {
  const R = ARENA_TUNING.rig;
  const y = R.height, h = R.half;
  const truss = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    for (const dy of [-0.14, 0.14]) for (const dz of [-0.14, 0.14]) {
      const rail = new THREE.BoxGeometry(2 * h + 0.32, 0.05, 0.05);
      rail.translate(0, y + dy, -h + dz).rotateY(a);
      truss.push(paint(rail, 0x3a4060));
    }
    for (let k = 0; k <= 14; k++) {
      const x = -h + (2 * h * k) / 14;
      for (const dz of [-0.14, 0.14]) {
        const strut = new THREE.BoxGeometry(0.03, 0.3, 0.03);
        strut.rotateX(0); strut.translate(x, y, -h + dz).rotateY(a);
        truss.push(paint(strut, 0x3a4060));
      }
    }
  }
  // drop cables up into the darkness
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const cable = new THREE.CylinderGeometry(0.012, 0.012, 14, 4);
    cable.translate(sx * h, y + 7, sz * h);
    truss.push(paint(cable, 0x222842));
  }
  const trussMesh = new THREE.Mesh(merge(truss), mats.truss);
  group.add(trussMesh);

  // lamp cans aimed at the ring, with bright lenses
  const lamps = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    for (let k = 0; k < R.lampsPerSide; k++) {
      const x = -h * 0.75 + (1.5 * h * k) / (R.lampsPerSide - 1);
      const p = new THREE.Vector3(x, y - 0.32, -h).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      lamps.push(p);
    }
  }
  const canGeo = new THREE.CylinderGeometry(0.11, 0.15, 0.3, 12, 1, true).rotateX(Math.PI / 2);
  const lensGeo = new THREE.CircleGeometry(0.13, 16);
  const cans = new THREE.InstancedMesh(canGeo, mats.can, lamps.length);
  const lenses = new THREE.InstancedMesh(lensGeo, mats.lens, lamps.length);
  const o = new THREE.Object3D();
  const target = new THREE.Vector3();
  lamps.forEach((p, i) => {
    target.set(p.x * 0.15, 0.6, p.z * 0.15);
    o.position.copy(p); o.lookAt(target); o.updateMatrix();
    cans.setMatrixAt(i, o.matrix);
    o.translateZ(0.155); o.updateMatrix();
    lenses.setMatrixAt(i, o.matrix);
  });
  group.add(cans, lenses);

  // soft glow halo at every lens
  const glow = glowPoints(lamps.length, PALETTE.spotlight, { maxSize: 160 });
  lamps.forEach((p, i) => {
    const dir = new THREE.Vector3(p.x * 0.15, 0.6, p.z * 0.15).sub(p).normalize();
    glow.pos[i * 3] = p.x + dir.x * 0.2; glow.pos[i * 3 + 1] = p.y + dir.y * 0.2; glow.pos[i * 3 + 2] = p.z + dir.z * 0.2;
    glow.size[i] = 0.95; glow.alpha[i] = 0.75;
  });
  for (const a of glow.attrs) a.needsUpdate = true;
  glow.points.renderOrder = 5;
  group.add(glow.points);

  // fake volumetric cones from the corner and mid lamps down onto the ring
  const coneMat = mats.cone;
  const cones = [];
  const coneLamps = [lamps[0], lamps[3], lamps[4], lamps[7], lamps[8], lamps[11], lamps[12], lamps[15]].filter(Boolean);
  const C = ARENA_TUNING.cones;
  for (const p of coneLamps) {
    const tgt = new THREE.Vector3(p.x * 0.18, 0, p.z * 0.18);
    const len = p.distanceTo(tgt);
    // apex at the origin (= the lamp) so the gentle sway pivots at the lamp
    const geo = new THREE.ConeGeometry(C.radius, len, 28, 1, true).translate(0, -len / 2, 0);
    const mesh = new THREE.Mesh(geo, coneMat);
    mesh.position.copy(p);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), tgt.clone().sub(p).normalize());
    mesh.renderOrder = 6;
    mesh.userData.baseQuat = mesh.quaternion.clone();
    mesh.userData.phase = cones.length * 1.7;
    group.add(mesh);
    cones.push(mesh);
  }
  return { truss: trussMesh, cans, lenses, glow, cones, lamps };
}

// ───────────────────────────── taunt boards ─────────────────────────────

const BOARD_COLS = 2, BOARD_ROWS = 4;

function drawBoards(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cw = W / BOARD_COLS, chh = H / BOARD_ROWS;
  ctx.clearRect(0, 0, W, H);
  const inks = [PALETTE.apronText, PALETTE.uiPaper, PALETTE.ropeC, PALETTE.ropeA];
  BOARD_TAUNTS.forEach((word, i) => {
    const x = (i % BOARD_COLS) * cw, y = Math.floor(i / BOARD_COLS) * chh;
    ctx.fillStyle = css(0x16264d);
    ctx.beginPath(); ctx.roundRect(x + 6, y + 6, cw - 12, chh - 12, chh * 0.22); ctx.fill();
    ctx.lineWidth = chh * 0.06; ctx.strokeStyle = css(PALETTE.post); ctx.stroke();
    ctx.font = `${Math.round(chh * 0.56)}px ${FONTS.display}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = chh * 0.08; ctx.strokeStyle = css(0x0b1022);
    ctx.strokeText(word, x + cw / 2, y + chh * 0.54, cw * 0.86);
    ctx.fillStyle = css(inks[i % inks.length]);
    ctx.fillText(word, x + cw / 2, y + chh * 0.54, cw * 0.86);
  });
}

/** Four boards (one per side) above the stands, merged into one mesh; words switch by UV. */
function buildBoards(parent, mat) {
  const B = ARENA_TUNING.boards;
  const geos = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.PlaneGeometry(B.w, B.h);
    g.translate(0, B.y, -B.dist).rotateY((i * Math.PI) / 2); // faces +Z before the rotation → toward the centre
    geos.push(g);
  }
  const geo = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'taunt-boards';
  parent.add(mesh);
  return mesh;
}

/** Point board `i` (0..3) at taunt `w` in the atlas. */
function setBoardWord(mesh, i, w) {
  const uv = mesh.geometry.attributes.uv;
  const col = w % BOARD_COLS, row = Math.floor(w / BOARD_COLS) % BOARD_ROWS;
  const u0 = col / BOARD_COLS, u1 = (col + 1) / BOARD_COLS;
  const v1 = 1 - row / BOARD_ROWS, v0 = 1 - (row + 1) / BOARD_ROWS;
  // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right
  const o = i * 4;
  uv.setXY(o, u0, v1); uv.setXY(o + 1, u1, v1); uv.setXY(o + 2, u0, v0); uv.setXY(o + 3, u1, v0);
  uv.needsUpdate = true;
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Build the venue.
 * @param {{quality?:'high'|'low', seed?:number}} [opts]
 * @returns {{
 *   group: THREE.Group,
 *   lights: {hemi: THREE.HemisphereLight, key: THREE.SpotLight, rim: THREE.DirectionalLight},
 *   update: (dt:number, excitement:number, opts?:{wave?:number}) => void,
 *   cheer: (intensity?:number) => void,
 *   flash: (intensity?:number) => void,
 *   setMirrored: (mirrored:boolean) => void,
 *   setAnisotropy: (n:number) => void,
 *   setShadowMapSize: (n:number) => void,
 *   refreshText: () => void,
 *   crowdCount: number,
 *   state: () => {excitement:number, cheer:number, flashes:number},
 *   dispose: () => void,
 * }}
 */
export function buildArena({ quality = 'high', seed = 1907 } = {}) {
  const T = ARENA_TUNING;
  const group = new THREE.Group();
  group.name = 'arena';
  // everything except the lights turns with setYaw() (the slow orbit of the live view)
  const stage = new THREE.Group();
  stage.name = 'arena-stage';
  group.add(stage);
  const dom = hasDOM();

  // textures
  const textures = {};
  if (dom) {
    const S = quality === 'low' ? 1024 : T.canvasTexSize;
    textures.canvasEl = makeCanvas(S, S); drawCanvasMat(textures.canvasEl);
    textures.canvas = canvasTexture(textures.canvasEl, { anisotropy: 8 });
    textures.apronEl = makeCanvas(2048, 304); drawApron(textures.apronEl);
    textures.apron = canvasTexture(textures.apronEl);
    textures.ribbonEl = makeCanvas(1024, 96); drawLedRibbon(textures.ribbonEl);
    // repeat so the lettering keeps its aspect on the ribbon (plane ≈ 10.4 m × 0.53 m)
    const ribbonLen = T.barrier.dist * 2 + 0.05, ribbonH = T.barrier.height * 0.62;
    textures.ribbon = canvasTexture(textures.ribbonEl, { repeatX: Math.max(1, Math.round(ribbonLen / (ribbonH * 1024 / 96))) });
    textures.faceEl = makeCanvas(256, 128); drawCrowdFace(textures.faceEl);
    textures.face = canvasTexture(textures.faceEl, { anisotropy: 1 });
    textures.boardsEl = makeCanvas(1024, 512); drawBoards(textures.boardsEl);
    textures.boards = canvasTexture(textures.boardsEl, { anisotropy: 4 });
  }
  textures.floor = floorTexture();

  const mats = {
    canvas: new THREE.MeshStandardMaterial({ color: textures.canvas ? LIGHTING.canvasTone : PALETTE.canvas, map: textures.canvas ?? null, roughness: 0.88 }),
    apron: new THREE.MeshStandardMaterial({ color: textures.apron ? 0xffffff : PALETTE.apron, map: textures.apron ?? null, roughness: 0.75 }),
    apronBody: new THREE.MeshStandardMaterial({ color: PALETTE.apron, roughness: 0.8 }),
    vertexStd: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
    gold: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.35, emissive: PALETTE.post, emissiveIntensity: 0.08 }),
    rope: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xffffff, map: textures.floor, roughness: 0.92 }),
    tiers: new THREE.MeshLambertMaterial({ vertexColors: true }),
    ribbon: new THREE.MeshBasicMaterial({ color: textures.ribbon ? 0xffffff : PALETTE.apron, map: textures.ribbon ?? null, toneMapped: false }),
    truss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }),
    can: new THREE.MeshStandardMaterial({ color: 0x2b3050, roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide }),
    lens: new THREE.MeshBasicMaterial({ color: PALETTE.spotlight, toneMapped: false }),
    dome: new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color(LIGHTING.hallTop) }, uBottom: { value: new THREE.Color(LIGHTING.hallBottom) }, uTime: { value: 0 } },
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    }),
    boards: new THREE.MeshBasicMaterial({ color: textures.boards ? 0xffffff : 0x16264d, map: textures.boards ?? null, toneMapped: false, transparent: true }),
    cone: new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(PALETTE.spotlight) }, uIntensity: { value: T.cones.intensity } },
      vertexShader: CONE_VERT, fragmentShader: CONE_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }),
  };

  const ring = buildRing(stage, mats, textures);
  const hall = buildHall(stage, mats, textures);
  const crowdUniforms = {
    uTime: { value: 0 }, uExcite: { value: 0.3 }, uCheer: { value: 0 }, uWave: { value: 0 },
    // applied after tone mapping / sRGB encoding, so the haze colour is given in sRGB
    uDim: { value: T.crowd.dim }, uHaze: { value: new THREE.Color(LIGHTING.crowdHaze).convertLinearToSRGB() },
  };
  const crowd = buildCrowd(stage, crowdUniforms, textures.face ?? null, quality, seed);
  const rig = buildRig(stage, mats);
  const boards = buildBoards(stage, mats.boards);
  const boardWord = [0, 3, 6, 4];
  for (let i = 0; i < 4; i++) setBoardWord(boards, i, boardWord[i]);
  let boardClock = 0, boardNext = 0;
  const brand = rng32(seed * 13 + 5);

  // camera-flash sparkles in the stands
  const F = T.flashes;
  const flashes = glowPoints(F.cap, 0xffffff, { star: 1, maxSize: 120 });
  flashes.points.renderOrder = 7;
  stage.add(flashes.points);
  const flashAge = new Float32Array(F.cap).fill(1);
  const flashLife = new Float32Array(F.cap).fill(1);
  let flashCursor = 0;
  let burstLeft = 0, burstRate = 0, flashAcc = 0;
  const frand = rng32(seed * 7 + 3);
  const spawnFlash = () => {
    const i = flashCursor; flashCursor = (flashCursor + 1) % F.cap;
    const h = Math.floor(frand() * crowd.count);
    flashes.pos[i * 3] = crowd.heads[h * 3] + (frand() - 0.5) * 0.2;
    flashes.pos[i * 3 + 1] = crowd.heads[h * 3 + 1] + 0.05 + frand() * 0.25;
    flashes.pos[i * 3 + 2] = crowd.heads[h * 3 + 2] + (frand() - 0.5) * 0.2;
    flashAge[i] = 0; flashLife[i] = F.life[0] + frand() * (F.life[1] - F.life[0]);
    flashes.size[i] = F.size * (0.7 + frand() * 0.6);
  };

  // lights
  const hemi = new THREE.HemisphereLight(LIGHTING.hemiSky, LIGHTING.hemiGround, LIGHTING.hemiIntensity);
  hemi.position.set(0, 10, 0);
  const K = T.key;
  const key = new THREE.SpotLight(LIGHTING.keyColor, LIGHTING.keyIntensity, 0, K.angle, K.penumbra, 0);
  key.position.set(...LIGHTING.keyPos);
  key.target.position.set(0, 0.5, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(K.shadowMap, K.shadowMap);
  key.shadow.camera.near = 3.5;
  key.shadow.camera.far = 16;
  key.shadow.bias = K.bias;
  key.shadow.normalBias = K.normalBias;
  key.shadow.radius = K.shadowRadius;
  const rim = new THREE.DirectionalLight(LIGHTING.rimColor, LIGHTING.rimIntensity);
  rim.position.set(...LIGHTING.rimPos);
  rim.target.position.set(0, 0.8, 0);
  group.add(hemi, key, key.target, rim, rim.target);
  const keyBase = new THREE.Vector3(...LIGHTING.keyPos);
  const rimBase = new THREE.Vector3(...LIGHTING.rimPos);

  // animation state
  let time = 0, excite = 0.3, cheerLevel = 0, roarLeft = 0, yaw = 0;
  const coneQ = new THREE.Quaternion(), coneE = new THREE.Euler();

  function update(dt, excitement = 0.3, opts = {}) {
    const d = Math.max(0, Math.min(0.1, dt || 0));
    time += d;
    const want = Number.isFinite(excitement) ? clamp01(excitement) : excite;
    excite += (want - excite) * (1 - Math.exp(-T.crowd.excitementLambda * d));
    if (roarLeft > 0) { roarLeft = Math.max(0, roarLeft - d); cheerLevel = 1; }
    else cheerLevel = Math.max(0, cheerLevel - d / T.crowd.cheerDecaySec);
    // boards: one word changes now and then
    boardClock += d;
    if (boardClock >= T.boards.cycleSec) {
      boardClock = 0;
      boardNext = (boardNext + 1) % 4;
      boardWord[boardNext] = (boardWord[boardNext] + 1 + Math.floor(brand() * (BOARD_TAUNTS.length - 1))) % BOARD_TAUNTS.length;
      setBoardWord(boards, boardNext, boardWord[boardNext]);
    }
    crowdUniforms.uTime.value = time;
    crowdUniforms.uExcite.value = excite;
    crowdUniforms.uCheer.value = Math.min(1, cheerLevel * 1.15);
    crowdUniforms.uWave.value += ((opts.wave ?? 0) - crowdUniforms.uWave.value) * (1 - Math.exp(-1.5 * d));
    crowdUniforms.uDim.value = T.crowd.dim + (T.crowd.dimExcited - T.crowd.dim) * Math.min(1, excite * 0.8 + cheerLevel * 0.4);
    mats.dome.uniforms.uTime.value = time;
    if (textures.ribbon) textures.ribbon.offset.x = (time * 0.035) % 1;

    // camera flashes: Poisson idle rate rising with excitement, plus bursts
    const rate = F.idleRate + F.excitedRate * excite * excite + (burstLeft > 0 ? burstRate : 0);
    burstLeft = Math.max(0, burstLeft - d);
    flashAcc += rate * d;
    while (flashAcc >= 1) { spawnFlash(); flashAcc -= 1; }
    let live = 0;
    for (let i = 0; i < F.cap; i++) {
      if (flashAge[i] >= flashLife[i]) { flashes.alpha[i] = 0; continue; }
      flashAge[i] += d;
      const t = flashAge[i] / flashLife[i];
      flashes.alpha[i] = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
      live++;
    }
    for (let k = 0; k < flashes.attrs.length; k++) flashes.attrs[k].needsUpdate = true;
    flashes.points.visible = live > 0;

    // gentle sway of the light cones
    for (const c of rig.cones) {
      const ph = c.userData.phase;
      coneE.set(Math.sin(time * 0.37 + ph) * 0.025, 0, Math.cos(time * 0.29 + ph) * 0.025);
      coneQ.setFromEuler(coneE);
      c.quaternion.copy(c.userData.baseQuat).multiply(coneQ);
    }
  }

  /** Long, loud crowd roar (KO): everyone jumps for `seconds`, the boards all shout. */
  function roar(seconds = T.roar.holdSec) {
    roarLeft = Math.max(roarLeft, seconds);
    cheer(1);
    flash(1);
    taunt(true);
  }

  /** Switch the boards to fresh hype words (all of them when `all`). */
  function taunt(all = false) {
    for (let i = 0; i < 4; i++) {
      if (!all && i !== boardNext) continue;
      boardWord[i] = (boardWord[i] + 1 + Math.floor(brand() * (BOARD_TAUNTS.length - 1))) % BOARD_TAUNTS.length;
      setBoardWord(boards, i, boardWord[i]);
    }
    boardClock = 0;
  }

  /** Turn the venue (not the lights) about the ring centre — the slow orbit of the live view. */
  function setYaw(rad) {
    if (!Number.isFinite(rad)) return;
    yaw = rad;
    stage.rotation.y = rad;
    stage.updateMatrixWorld(true);
  }

  function cheer(intensity = 1) {
    cheerLevel = Math.max(cheerLevel, clamp01(intensity));
    burstLeft = Math.max(burstLeft, 0.5 * intensity);
    burstRate = Math.max(burstRate * (burstLeft > 0 ? 1 : 0), 10 * intensity);
  }

  function flash(intensity = 1) {
    const k = clamp01(intensity);
    burstLeft = F.burstSec * (0.5 + 0.5 * k);
    burstRate = (F.burst * k) / F.burstSec;
    for (let i = 0; i < Math.round(8 * k); i++) spawnFlash();
  }

  /** Mirror key/rim through the ring centre (versus: the right-hand viewport sees its opponent lit the same way). */
  function setMirrored(mirrored) {
    const s = mirrored ? -1 : 1;
    key.position.set(keyBase.x * s, keyBase.y, keyBase.z * s);
    rim.position.set(rimBase.x * s, rimBase.y, rimBase.z * s);
    key.updateMatrixWorld(); rim.updateMatrixWorld();
  }

  function setAnisotropy(n) {
    for (const t of [textures.canvas, textures.apron, textures.ribbon]) if (t) { t.anisotropy = n; t.needsUpdate = true; }
  }

  function setShadowMapSize(n) {
    if (key.shadow.mapSize.x === n) return;
    key.shadow.mapSize.set(n, n);
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
  }

  /** Redraw the lettering (call once the display web-font has loaded). */
  function refreshText() {
    if (!dom) return;
    drawCanvasMat(textures.canvasEl); textures.canvas.needsUpdate = true;
    drawApron(textures.apronEl); textures.apron.needsUpdate = true;
    drawLedRibbon(textures.ribbonEl); textures.ribbon.needsUpdate = true;
    drawBoards(textures.boardsEl); textures.boards.needsUpdate = true;
  }
  if (dom && document.fonts && typeof document.fonts.load === 'function') {
    const fam = FONTS.display.split(',')[0].trim();
    document.fonts.load(`64px ${fam}`).then(() => refreshText()).catch(() => {});
  }

  function dispose() {
    group.removeFromParent();
    group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of Object.values(mats)) m.dispose();
    for (const mesh of crowd.meshes) mesh.material.dispose();
    flashes.points.material.dispose();
    rig.glow.points.material.dispose();
    for (const t of Object.values(textures)) if (t && t.isTexture) t.dispose();
    key.shadow.map?.dispose();
  }

  return {
    group,
    lights: { hemi, key, rim },
    update, cheer, flash, roar, taunt, setYaw, setMirrored, setAnisotropy, setShadowMapSize, refreshText, dispose,
    crowdCount: crowd.count,
    stage,
    get yaw() { return yaw; },
    parts: { ...ring, ...hall, rig, boards, crowdMeshes: crowd.meshes },
    boardWords: () => boardWord.map((w) => BOARD_TAUNTS[w]),
    state: () => ({ excitement: excite, cheer: cheerLevel, roar: roarLeft, yaw, flashes: flashes.alpha.reduce((n, a) => n + (a > 0 ? 1 : 0), 0) }),
  };
}
