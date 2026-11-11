// Pooled visual effects for fights and training, plus the game's time control (owner: view3d).
//
// The hit vocabulary of research/mechanics.md §5 (functional colours, our own shapes), the visual
// half of UI03 ("give hits, guards and misses distinguishable feedback"):
//   the player's clean hit   → pink petal-burst + sparkles (bigger and longer for a counter)
//   any block                → a quick green ring at the contact point (no hit-stop, no cut)
//   the player is hit        → orange radial speed lines (speedLines) + a blue/white crackle burst
//   heavy hit / counter on   → … plus a purple burst
//     the player
//   opponent power punch /   → red trail along the glove path, also its miss streak
//     hook, opponent miss
//   the player's fast punch  → blue trail
//   knockdown                → dust ring on the canvas; result → confetti + light streaks
// No hit text is drawn in 3D.
//
// Time control (§2.8, ARCHITECTURE §6.2): `timeScale` is the multiplier the app applies to its
// GAME dt. hitStopMsFor() maps a MATCH_HIT to the measured stall: the player's clean hit 0.2 s,
// big hit / counter 0.5 s, knockdown blow 0.7 s, ordinary hit on the human none, heavy hit on the
// human 0.45 s — so the round clock stalls exactly that long.
//
// Everything is created once and pooled: spawning or updating effects never allocates.
// Timers run on REAL (unscaled) seconds; update(realDt, particleScale) can slow the particles
// themselves (dodge slow motion) without slowing the time control. Pure module: imports cleanly
// in Node (no DOM access at all — textures are generated procedurally as DataTextures).

import * as THREE from 'three';
import { PALETTE } from './style.js';

/** Feel knobs. Times are real (unscaled) seconds unless the name says ms. */
export const FX_TUNING = Object.freeze({
  hitStop: Object.freeze({
    scale: 0.02,      // game-time multiplier while frozen (the round clock effectively stalls)
    capMs: 1000,      // longest single stall accepted
    // measured tiers (§2.8, §2.10, ARCHITECTURE §6.2), in ms
    playerHit: 200, big: 500, knockdown: 700, onHuman: 0, onHumanHeavy: 450,
    // short training pops (bag / mitts): 45–70 ms by power
    baseMs: 45, powerMs: 25, counterMs: 10, maxMs: 80,
  }),
  slowMo: Object.freeze({
    knockdownScale: 0.35, knockdownMs: 1400,
    koScale: 0.35, koMs: 2300,
    easeOutMs: 320,   // smooth return to normal speed at the end of a slow-mo
  }),
  shake: Object.freeze({
    decayPerSec: 2.0, // trauma units lost per second (trauma is 0..1, offset ∝ trauma²)
    maxOffset: 0.085, // metres of camera offset at trauma 1
    maxRoll: 0.035,   // radians of camera roll at trauma 1
    freq: 23,         // noise speed
  }),
  spark: Object.freeze({
    starSize: 0.15, starGrow: 0.21, starLife: 0.16,   // star-burst grows from ~0.1 m to ~0.36 m
    glowSize: 0.3, glowLife: 0.1,
    counterMul: 1.35,
    streaks: 9, counterStreaks: 15, streakSpeed: [1.7, 3.4], streakLife: [0.14, 0.26],
    streakDrag: 9,
    streakWidth: 0.013, streakStretch: 6,
    pops: 5,          // little gravity-affected embers
  }),
  // §2.3: a green ring expands at the contact point for 2–3 frames, then fades (0.07–0.2 s in all)
  block: Object.freeze({ ringSize: [0.14, 0.5], ringLife: 0.18, dots: 5 }),
  // the player's clean hit: pink burst 0.3–0.5 s (§2.3), counter bigger and longer
  pop: Object.freeze({ size: 0.2, grow: 0.26, life: 0.34, counterMul: 1.45, counterLife: 0.48, sparkles: 9, streaks: 10 }),
  // the player is hit: blue/white crackle (+ purple for heavy / counters)
  taken: Object.freeze({ size: 0.24, grow: 0.36, life: 0.3, heavyMul: 1.35, purpleLife: 0.42, streaks: 12 }),
  trail: Object.freeze({ points: 26, life: 0.26, width: 0.15, linger: 0.32, slots: 6 }),
  speedLines: Object.freeze({ decayPerSec: 3.2, lines: 52 }),
  streaks: Object.freeze({ ribbons: 5, radius: 1.35, life: 3.6 }),
  whoosh: Object.freeze({ arcs: 3, radius: 0.26, radiusStep: 0.065, life: 0.32, stagger: 0.035 }),
  sweat: Object.freeze({ drops: 9, speed: [1.6, 3.2], life: [0.45, 0.75], size: 0.03, gravity: 7.5 }),
  dust: Object.freeze({ ringLife: 0.95, ringRadius: 2.1, puffs: 10, puffLife: 1.3 }),
  confetti: Object.freeze({ count: 220, life: [3.2, 5.0], gravity: 1.1, terminal: 0.9, flutter: 0.55 }),
  flash: Object.freeze({ decayPerSec: 3.2 }),
  reducedMotion: Object.freeze({ shake: 0.2, flash: 0.4 }), // multipliers when the player asks for less motion
  pools: Object.freeze({ sprites: 64, sparks: 520, drops: 220, arcs: 9, dust: 3 }),
});

// ───────────────────────────── helpers ─────────────────────────────

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const CHANNELS = ['p1', 'p2'];
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const easeOut = (t, p = 2) => 1 - Math.pow(1 - clamp01(t), p);

/** Accepts THREE.Vector3, {x,y,z} or [x,y,z]; writes into `out`. Returns false if unusable. */
export function readVec3(src, out) {
  if (!src) return false;
  if (Array.isArray(src)) { if (src.length < 3) return false; out.set(+src[0], +src[1], +src[2]); }
  else if (typeof src === 'object') out.set(+src.x, +src.y, +src.z);
  else return false;
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
}

/** White RGBA DataTexture whose alpha is fn(u,v) with u,v ∈ [-1,1]. No DOM needed. */
function maskTexture(size, fn) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(fn(u, v)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function makeTextures() {
  const star = maskTexture(128, (u, v) => {
    // comic "pow" burst: 4 long + 4 short spikes, soft halo
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const c = Math.cos(4 * th);
    const len = c > 0 ? 0.97 : 0.68;
    const R = 0.3 + (len - 0.3) * Math.pow(Math.abs(c), 3.2);
    const body = 1 - smooth(R - 0.03, R + 0.02, r);
    return Math.max(body, 0.35 * Math.exp(-r * r * 8));
  });
  const glow = maskTexture(64, (u, v) => {
    const r = Math.hypot(u, v);
    return Math.pow(Math.max(0, 1 - r), 2.2) + 0.55 * Math.exp(-r * r * 28);
  });
  const ring = maskTexture(128, (u, v) => {
    const r = Math.hypot(u, v);
    if (r > 1) return 0;
    return Math.exp(-Math.pow((r - 0.72) / 0.13, 2)) + 0.1 * (1 - r);
  });
  const blobs = [[0, 0, 0.56], [0.33, 0.17, 0.42], [-0.31, 0.2, 0.4], [0.12, -0.31, 0.41], [-0.22, -0.26, 0.38], [0.36, -0.16, 0.33], [-0.05, 0.36, 0.34]];
  const puff = maskTexture(64, (u, v) => {
    let a = 0;
    for (const [cx, cy, cr] of blobs) {
      const d = Math.hypot(u - cx, v - cy) / cr;
      if (d < 1) a = Math.max(a, Math.pow(1 - d * d, 1.4));
    }
    return a * 0.95;
  });
  // the player's clean hit: a round "pop" with ten rounded petals and a bright rim (our own shape)
  const pop = maskTexture(128, (u, v) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const petal = Math.pow(0.5 + 0.5 * Math.cos(10 * th), 2.2);
    const R = 0.5 + 0.42 * petal;
    return 1 - smooth(R - 0.04, R + 0.02, r);
  });
  // the player is hit: an irregular electric crackle (sharp, uneven spikes)
  const crackle = maskTexture(128, (u, v) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const spike = Math.pow(Math.abs(Math.sin(3.5 * th + 0.7 * Math.sin(7 * th + 1.3))), 6);
    const R = 0.36 + 0.6 * spike;
    const body = 1 - smooth(R - 0.03, R + 0.015, r);
    return Math.max(body, 0.45 * Math.exp(-r * r * 9));
  });
  return { star, glow, ring, puff, pop, crackle };
}

/**
 * Hit-stop for a MATCH_HIT (ms), research/mechanics.md §2.8 / ARCHITECTURE §6.2:
 * knockdown blow 0.7 s; the human's clean hit 0.2 s (0.5 s when big — heavy — or a counter);
 * a hit ON the human: none, or 0.45 s when heavy (heavy flag, counter, or a power punch).
 * Versus (both human): the attacker's tiers apply.
 * @param {Object} e  MATCH_HIT payload {attacker, defender, counter?, heavy?, knockdown?, power?}
 * @param {(id:string) => boolean} isHuman
 */
export function hitStopMsFor(e, isHuman) {
  const H = FX_TUNING.hitStop;
  if (!e) return 0;
  if (e.knockdown) return H.knockdown;
  const att = e.attacker === 'p2' ? 'p2' : 'p1';
  const def = e.defender === 'p1' || e.defender === 'p2' ? e.defender : (att === 'p1' ? 'p2' : 'p1');
  const big = !!e.heavy || !!e.counter;
  if (isHuman(att)) return big ? H.big : H.playerHit;
  if (isHuman(def)) return big ? H.onHumanHeavy : H.onHuman;
  return big ? H.big : H.playerHit;
}

// ───────────────────────────── sprite pool (billboards) ─────────────────────────────

class SpritePool {
  /** `defaultMap` is set up-front so every material compiles with a map (swapping maps is then free). */
  constructor(parent, size, defaultMap) {
    this.items = [];
    this.cursor = 0;
    for (let i = 0; i < size; i++) {
      const mat = new THREE.SpriteMaterial({
        map: defaultMap, transparent: true, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 52;
      sprite.frustumCulled = false;
      parent.add(sprite);
      this.items.push({
        sprite, mat, active: false, age: 0, life: 1, delay: 0,
        vel: new THREE.Vector3(), s0: 0.1, s1: 0.2, a0: 1, spin: 0, drag: 0, grav: 0,
        fadeIn: 0.05, fadeFrom: 0.35, growPow: 2.5,
      });
    }
  }

  /** Returns a free slot (or recycles the oldest one) already reset; caller fills it in. */
  take() {
    const n = this.items.length;
    let best = null, bestT = -1;
    for (let k = 0; k < n; k++) {
      const it = this.items[(this.cursor + k) % n];
      if (!it.active) { this.cursor = (this.cursor + k + 1) % n; return this._reset(it); }
      const t = it.age / it.life;
      if (t > bestT) { bestT = t; best = it; }
    }
    return this._reset(best);
  }

  _reset(it) {
    it.active = true; it.age = 0; it.delay = 0; it.vel.set(0, 0, 0); it.spin = 0; it.drag = 0; it.grav = 0;
    it.fadeIn = 0.05; it.fadeFrom = 0.35; it.growPow = 2.5; it.mat.rotation = 0; it.mat.depthTest = false;
    it.sprite.visible = false; // becomes visible on its first update (after any delay)
    return it;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.active) continue;
      if (it.delay > 0) { it.delay -= dt; if (it.delay > 0) continue; }
      it.age += dt;
      const t = it.age / it.life;
      if (t >= 1) { it.active = false; it.sprite.visible = false; continue; }
      if (it.drag > 0) it.vel.multiplyScalar(Math.exp(-it.drag * dt));
      it.vel.y -= it.grav * dt;
      it.sprite.position.addScaledVector(it.vel, dt);
      const s = lerp(it.s0, it.s1, easeOut(t, it.growPow));
      it.sprite.scale.set(s, s, 1);
      const fin = it.fadeIn > 0 ? clamp01(t / it.fadeIn) : 1;
      it.mat.opacity = it.a0 * fin * (1 - smooth(it.fadeFrom, 1, t));
      it.mat.rotation += it.spin * dt;
      it.sprite.visible = true;
    }
  }

  clear() { for (const it of this.items) { it.active = false; it.sprite.visible = false; } }
  activeCount() { let n = 0; for (const it of this.items) if (it.active) n++; return n; }
}

// ───────────────────────────── GPU point particles ─────────────────────────────

/** Shapes understood by the particle shader. */
export const PShape = Object.freeze({ DOT: 0, STREAK: 1, DROP: 2, TWINKLE: 3 });

const POINT_VERT = /* glsl */`
attribute vec3 aVel;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
attribute float aStretch;
uniform float uScale;
uniform float uAspect;
uniform float uMaxSize;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vStretch;
varying vec2 vDir;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;
  float depth = max(0.05, -mv.z);
  // screen-space direction of travel (streaks and droplets are stretched along it)
  vec4 clip2 = projectionMatrix * (modelViewMatrix * vec4(position + aVel * 0.016, 1.0));
  vec2 d = clip2.xy / max(1e-4, clip2.w) - clip.xy / max(1e-4, clip.w);
  d.x *= uAspect;
  float len = length(d);
  vDir = len > 1e-6 ? d / len : vec2(0.0, 1.0);
  float stretch = (aShape > 0.5 && aShape < 2.5) ? max(1.0, aStretch) : 1.0;
  vStretch = stretch;
  gl_PointSize = clamp(aSize * uScale / depth * stretch, 0.0, uMaxSize);
  vColor = aColor;
  vAlpha = aAlpha;
  vShape = aShape;
}`;

const POINT_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vStretch;
varying vec2 vDir;
void main() {
  vec2 p = vec2(gl_PointCoord.x * 2.0 - 1.0, 1.0 - gl_PointCoord.y * 2.0);
  float u = dot(p, vDir);                     // along travel (+ = leading end)
  float v = dot(p, vec2(-vDir.y, vDir.x));    // across
  float a;
  vec3 col = vColor;
  if (vShape < 0.5) {                         // soft round dot
    a = 1.0 - smoothstep(0.15, 1.0, length(p));
  } else if (vShape < 1.5) {                  // streak: thin ellipse, hot leading end
    float w = 1.0 / vStretch;
    float e = u * u + (v * v) / (w * w);
    a = 1.0 - smoothstep(0.3, 1.0, e);
    a *= 0.35 + 0.65 * smoothstep(-0.9, 0.7, u);
  } else if (vShape < 2.5) {                  // droplet: round head + tapering tail
    float w = 1.0 / vStretch;
    float head = length(vec2((u - (1.0 - w)) / w, v / w));
    float tailHalf = w * clamp((u + 1.0) / max(0.01, 2.0 - 2.0 * w), 0.0, 1.0);
    float tail = (u < 1.0 - w) ? 1.0 - smoothstep(tailHalf * 0.6, tailHalf, abs(v)) : 0.0;
    a = max(1.0 - smoothstep(0.75, 1.0, head), tail * smoothstep(-1.0, -0.2, u));
    float hl = 1.0 - smoothstep(0.0, 0.45, length(vec2((u - (1.0 - 1.35 * w)) / w, v / w - 0.35)));
    col = mix(col, vec3(1.0), hl * 0.8);
  } else {                                     // 4-point twinkle
    float r = length(p);
    float cross = max(1.0 - smoothstep(0.0, 0.13, abs(p.x)), 1.0 - smoothstep(0.0, 0.13, abs(p.y)));
    a = max(cross * (1.0 - smoothstep(0.2, 1.0, r)), 1.0 - smoothstep(0.0, 0.32, r));
  }
  a *= vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _vp = new THREE.Vector4();

class ParticleSystem {
  /**
   * @param {THREE.Object3D} parent
   * @param {number} capacity
   * @param {{additive:boolean, renderOrder:number}} opts
   */
  constructor(parent, capacity, { additive, renderOrder }) {
    const n = capacity;
    this.cap = n;
    this.count = 0;
    // struct-of-arrays; the GPU attributes *are* these arrays (packed active range [0,count))
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.shape = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.st0 = new Float32Array(n);
    this.delay = new Float32Array(n);

    const g = new THREE.BufferGeometry();
    const mk = (arr, size) => { const a = new THREE.BufferAttribute(arr, size); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.attrs = {
      position: mk(this.pos, 3), aVel: mk(this.vel, 3), aColor: mk(this.col, 3),
      aSize: mk(this.size, 1), aAlpha: mk(this.alpha, 1), aShape: mk(this.shape, 1), aStretch: mk(this.stretch, 1),
    };
    for (const [k, a] of Object.entries(this.attrs)) g.setAttribute(k, a);
    this.attrList = Object.values(this.attrs);
    // one reusable update range per attribute (three clears the list after each upload)
    this.ranges = this.attrList.map(() => ({ start: 0, count: 0 }));
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 600 }, uAspect: { value: 16 / 9 }, uMaxSize: { value: 256 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, depthTest: !additive, toneMapped: false, fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    // Per-viewport projection scale (versus renders two viewports with different sizes/FOVs).
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(_vp);
      const fov = camera.isPerspectiveCamera ? camera.fov : 50;
      this.uniforms.uScale.value = _vp.w / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
      this.uniforms.uAspect.value = _vp.w > 0 ? _vp.z / _vp.w : 1;
    };
    parent.add(this.points);
  }

  /** Emit one particle. Silently drops it when the pool is full (pools are sized generously). */
  emit(x, y, z, vx, vy, vz, life, s0, s1, alpha, color, shape, stretch = 1, drag = 0, grav = 0, delay = 0) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.age[i] = 0; this.life[i] = Math.max(0.01, life);
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha;
    this.shape[i] = shape; this.st0[i] = stretch; this.stretch[i] = stretch;
    this.drag[i] = drag; this.grav[i] = grav; this.delay[i] = delay;
    this.size[i] = 0; this.alpha[i] = 0;
  }

  _copy(dst, src) {
    const d3 = dst * 3, s3 = src * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[d3 + k] = this.pos[s3 + k]; this.vel[d3 + k] = this.vel[s3 + k]; this.col[d3 + k] = this.col[s3 + k];
    }
    this.size[dst] = this.size[src]; this.alpha[dst] = this.alpha[src]; this.shape[dst] = this.shape[src];
    this.stretch[dst] = this.stretch[src]; this.age[dst] = this.age[src]; this.life[dst] = this.life[src];
    this.s0[dst] = this.s0[src]; this.s1[dst] = this.s1[src]; this.a0[dst] = this.a0[src];
    this.drag[dst] = this.drag[src]; this.grav[dst] = this.grav[src]; this.st0[dst] = this.st0[src];
    this.delay[dst] = this.delay[src];
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.delay[i] > 0) { this.delay[i] -= dt; this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.count--; if (i !== this.count) this._copy(i, this.count); i--; continue; }
      const i3 = i * 3;
      const k = this.drag[i] > 0 ? Math.exp(-this.drag[i] * dt) : 1;
      this.vel[i3] *= k; this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt; this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = lerp(this.s0[i], this.s1[i], easeOut(t, 2));
      this.alpha[i] = this.a0[i] * clamp01(t / 0.06) * (1 - smooth(0.3, 1, t));
      this.stretch[i] = 1 + (this.st0[i] - 1) * (1 - 0.55 * t);
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    if (this.count > 0 || this._wasActive) {
      for (let k = 0; k < this.attrList.length; k++) {
        const a = this.attrList[k], r = this.ranges[k];
        r.start = 0; r.count = Math.max(1, this.count) * a.itemSize;
        a.updateRanges.length = 0;
        a.updateRanges.push(r);
        a.needsUpdate = true;
      }
    }
    this._wasActive = this.count > 0;
    this.points.visible = this.count > 0;
  }

  clear() { this.count = 0; this.points.geometry.setDrawRange(0, 0); this.points.visible = false; }
}

// ───────────────────────────── whoosh arcs ─────────────────────────────

function makeArcGeometry(segments = 32, span = 1.9, width = 0.16) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const th = -span / 2 + span * f;
    const c = Math.cos(th), s = Math.sin(th);
    pos.push(c * (1 - width / 2), s * (1 - width / 2), 0, c * (1 + width / 2), s * (1 + width / 2), 0);
    uv.push(f, 0, f, 1);
    if (i < segments) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const ARC_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FRAG = /* glsl */`
uniform float uHead;
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float u = vUv.x;
  float tail = smoothstep(uHead - 0.62, uHead, u);
  float head = 1.0 - smoothstep(uHead, uHead + 0.05, u);
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float thick = mix(0.75, 0.15, tail);           // thin tail, fat head
  float a = tail * head * smoothstep(thick - 0.2, thick + 0.05, across) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── dust ring ─────────────────────────────

const DUST_VERT = ARC_VERT;
const DUST_FRAG = /* glsl */`
uniform float uProgress;
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float c = mix(0.18, 0.86, uProgress);
  float w = mix(0.07, 0.16, uProgress);
  float a = exp(-pow((r - c) / w, 2.0)) * (1.0 - smoothstep(0.92, 1.0, r)) * uAlpha;
  a += (1.0 - smoothstep(0.0, c, r)) * 0.25 * uAlpha * (1.0 - uProgress);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── screen flash ─────────────────────────────

const FLASH_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FLASH_FRAG = /* glsl */`
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 1.41421;
  float a = uAlpha * mix(0.35, 1.0, smoothstep(0.15, 1.0, r));   // stronger at the edges ("impact frame")
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── orange radial speed lines ─────────────────────────────

const SPEED_FRAG = /* glsl */`
uniform float uAlpha;
uniform float uSeed;
uniform float uAspect;
uniform vec3 uColor;
varying vec2 vUv;
float hash(float n) { return fract(sin(n * 12.9898 + uSeed * 78.233) * 43758.5453); }
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uAspect;
  float r = length(p) / max(1.0, uAspect);
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  float n = 52.0;
  float id = floor(a * n);
  float f = fract(a * n);
  float h = hash(id);
  float on = step(0.32, h);
  float w = mix(0.08, 0.34, hash(id + 7.0));
  float line = 1.0 - smoothstep(0.0, w, abs(f - 0.5));
  float inner = mix(0.42, 0.78, hash(id + 13.0));
  float radial = smoothstep(inner, inner + 0.22, r);
  float alpha = line * radial * on * uAlpha;
  if (alpha < 0.004) discard;
  vec3 col = mix(uColor, vec3(1.0, 0.86, 0.45), hash(id + 3.0) * 0.45);
  gl_FragColor = vec4(col, alpha * 0.95);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── glove trails (camera-facing ribbons) ─────────────────────────────

const TRAIL_VERT = /* glsl */`
attribute vec3 aPrev;
attribute float aSide;
attribute float aAlpha;
attribute float aWidth;
varying float vAlpha;
varying float vSide;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 mp = modelViewMatrix * vec4(aPrev, 1.0);
  vec3 dir = mv.xyz - mp.xyz;
  vec3 viewDir = normalize(-mv.xyz);
  vec3 side = cross(dir, viewDir);
  float len = length(side);
  side = len > 1e-7 ? side / len : vec3(0.0, 1.0, 0.0);
  mv.xyz += side * aSide * aWidth;
  gl_Position = projectionMatrix * mv;
  vAlpha = aAlpha;
  vSide = aSide;
}`;
const TRAIL_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vAlpha;
varying float vSide;
void main() {
  float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
  float core = 1.0 - smoothstep(0.0, 0.45, abs(vSide));
  float a = min(1.0, vAlpha * edge * 1.15);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.3 * vAlpha), a);
  #include <colorspace_fragment>
}`;

class TrailPool {
  constructor(parent, slots, points) {
    this.n = points;
    this.items = [];
    for (let k = 0; k < slots; k++) {
      const N = points;
      const pos = new Float32Array(N * 2 * 3), prev = new Float32Array(N * 2 * 3);
      const side = new Float32Array(N * 2), alpha = new Float32Array(N * 2), width = new Float32Array(N * 2);
      for (let i = 0; i < N; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
      const idx = [];
      for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.BufferGeometry();
      const mk = (arr, sz) => new THREE.BufferAttribute(arr, sz).setUsage(THREE.DynamicDrawUsage);
      const attrs = { position: mk(pos, 3), aPrev: mk(prev, 3), aSide: mk(side, 1), aAlpha: mk(alpha, 1), aWidth: mk(width, 1) };
      for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
      g.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0xff3b3b) } }, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
        transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 51;
      parent.add(mesh);
      this.items.push({
        key: null, mesh, mat, attrs, attrList: Object.values(attrs),
        px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N), age: new Float32Array(N),
        count: 0, feeding: false, life: 0.24, width: 0.07, linger: 0, fade: 1, dirty: false,
      });
    }
  }

  _find(key) { for (const it of this.items) if (it.key === key) return it; return null; }

  start(key, color, width, life) {
    let it = this._find(key);
    if (!it) {
      it = this.items.find((x) => x.key === null) ?? this.items.reduce((a, b) => (a.fade < b.fade ? a : b));
      it.key = key; it.count = 0;
    }
    it.feeding = true; it.fade = 1; it.linger = 0;
    it.mat.uniforms.uColor.value.set(color);
    it.width = width; it.life = life;
    return it;
  }

  point(key, p) {
    const it = this._find(key);
    if (!it || !it.feeding || !Number.isFinite(p.x)) return;
    const N = this.n;
    it.px.copyWithin(1, 0, N - 1); it.py.copyWithin(1, 0, N - 1); it.pz.copyWithin(1, 0, N - 1); it.age.copyWithin(1, 0, N - 1);
    it.px[0] = p.x; it.py[0] = p.y; it.pz[0] = p.z; it.age[0] = 0;
    it.count = Math.min(N, it.count + 1);
    it.dirty = true;
  }

  stop(key, linger) {
    const it = this._find(key);
    if (!it) return;
    it.feeding = false; it.linger = Math.max(0.05, linger); it.fade = 1;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.key === null) continue;
      // a stopped trail keeps its shape (the miss streak hangs in the air) and just fades out
      if (it.feeding) for (let i = 0; i < it.count; i++) it.age[i] += dt;
      if (!it.feeding) {
        it.fade -= dt / it.linger;
        if (it.fade <= 0) { it.key = null; it.count = 0; it.mesh.visible = false; continue; }
      }
      const N = this.n, a = it.attrs;
      const pos = a.position.array, prev = a.aPrev.array, alpha = a.aAlpha.array, width = a.aWidth.array;
      let visible = 0;
      for (let i = 0; i < N; i++) {
        const j = Math.min(i, Math.max(0, it.count - 1));
        const k = Math.min(j + 1, Math.max(0, it.count - 1));
        const x = it.px[j], y = it.py[j], z = it.pz[j];
        // prev = the next-older point (or a tiny offset for the oldest so the ribbon stays oriented)
        let qx = it.px[k], qy = it.py[k], qz = it.pz[k];
        if (k === j && j > 0) { qx = 2 * x - it.px[j - 1]; qy = 2 * y - it.py[j - 1]; qz = 2 * z - it.pz[j - 1]; }
        const t = it.count > 0 && i < it.count ? it.age[j] / it.life : 2;
        const along = 1 - i / (N - 1);
        const al = t < 1 ? (1 - t) * (1 - t) * (0.35 + 0.65 * along) * it.fade : 0;
        if (al > 0.01) visible++;
        for (let s = 0; s < 2; s++) {
          const v = i * 2 + s;
          pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
          prev[v * 3] = qx; prev[v * 3 + 1] = qy; prev[v * 3 + 2] = qz;
          alpha[v] = al; width[v] = it.width * (0.35 + 0.65 * along);
        }
      }
      for (const attr of it.attrList) attr.needsUpdate = true;
      it.mesh.visible = visible > 1;
      if (!it.feeding && visible === 0) { it.key = null; it.count = 0; it.mesh.visible = false; }
    }
  }

  clear() { for (const it of this.items) { it.key = null; it.count = 0; it.feeding = false; it.mesh.visible = false; } }
  activeCount() { let n = 0; for (const it of this.items) if (it.key !== null) n++; return n; }
}

// ───────────────────────────── light streaks (win banner) ─────────────────────────────

const STREAK_VERT = /* glsl */`
uniform float uRadius;
uniform float uPhase;
uniform float uTilt;
uniform float uHeight;
varying vec2 vUv;
void main() {
  vUv = uv;
  float ang = uv.x * 6.2831853 * 0.85 + uPhase;
  float y = uHeight + sin(ang * 1.5 + uTilt) * 0.38 + (uv.y - 0.5) * 0.07;
  vec3 p = vec3(cos(ang) * uRadius, y, sin(ang) * uRadius);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const STREAK_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uHead;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float d = uHead - vUv.x;
  float tail = d >= 0.0 ? exp(-d * 5.5) : 0.0;
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = tail * smoothstep(0.0, 0.6, across) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), across * tail * 0.6), a);
  #include <colorspace_fragment>
}`;

class LightStreaks {
  constructor(parent, count) {
    this.group = new THREE.Group();
    this.group.name = 'light-streaks';
    this.group.visible = false;
    this.geo = new THREE.PlaneGeometry(1, 1, 96, 1);
    this.items = [];
    const colors = [PALETTE.ropeC, PALETTE.apronText, 0xffffff, PALETTE.ropeA, 0x8fe9ff];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uRadius: { value: 1.3 }, uPhase: { value: 0 }, uTilt: { value: 0 }, uHeight: { value: 1.2 },
          uColor: { value: new THREE.Color(colors[i % colors.length]) }, uHead: { value: 0 }, uAlpha: { value: 0 },
        },
        vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = 56;
      this.group.add(mesh);
      this.items.push({ mesh, mat, speed: 0.5, delay: 0 });
    }
    parent.add(this.group);
    this.t = 0; this.life = 0; this.active = false;
  }

  start(center, life, random) {
    this.group.position.set(center.x, 0, center.z);
    this.t = 0; this.life = life; this.active = true; this.group.visible = true;
    this.items.forEach((it, i) => {
      const u = it.mat.uniforms;
      u.uRadius.value = FX_TUNING.streaks.radius * (0.8 + 0.4 * random());
      u.uPhase.value = random() * 6.28; u.uTilt.value = random() * 6.28; u.uHeight.value = 0.75 + 0.9 * random();
      u.uHead.value = 0; u.uAlpha.value = 0;
      it.speed = 0.55 + 0.35 * random(); it.delay = i * 0.12 + random() * 0.15;
    });
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const fade = 1 - smooth(this.life * 0.75, this.life, this.t);
    for (const it of this.items) {
      const tt = Math.max(0, this.t - it.delay);
      it.mat.uniforms.uHead.value = (tt * it.speed) % 1.6;
      it.mat.uniforms.uAlpha.value = smooth(0, 0.25, tt) * fade * 0.9;
    }
    if (this.t >= this.life) this.clear();
  }

  clear() { this.active = false; this.group.visible = false; this.t = 0; }
}

// ───────────────────────────── FX ─────────────────────────────

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const COL = {
  spark: new THREE.Color(PALETTE.hitSpark),
  core: new THREE.Color(PALETTE.hitSparkCore),
  counter: new THREE.Color(PALETTE.counterSpark),
  block: new THREE.Color(PALETTE.blockRing ?? 0x37d67a),
  blockHi: new THREE.Color(PALETTE.blockRingHi ?? 0xb6ffcf).multiplyScalar(0.55),
  pink: new THREE.Color(PALETTE.hitPink ?? 0xff4fa0),
  pinkHi: new THREE.Color(PALETTE.hitPinkHi ?? 0xffb3d9),
  pinkDeep: new THREE.Color(0xc2185b),
  blue: new THREE.Color(PALETTE.takenBlue ?? 0x5fb8ff),
  purple: new THREE.Color(PALETTE.heavyPurple ?? 0xa45cff),
  trail: new THREE.Color(PALETTE.dodgeTrail),
  sweat: new THREE.Color(PALETTE.sweat),
  dust: new THREE.Color(0xcdbfa6),
  white: new THREE.Color(0xffffff),
};

/**
 * Pooled effects + time control. Add `fx.object3d` to the scene, call `update(realDt)` once per
 * frame, and multiply game dt by `fx.timeScale`.
 */
export class FX {
  /**
   * @param {{random?: () => number}} [opts]  random source (tests inject a seeded one)
   */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.object3d = new THREE.Group();
    this.object3d.name = 'fx';
    this.tex = makeTextures();
    const P = FX_TUNING.pools;

    this.sprites = new SpritePool(this.object3d, P.sprites, this.tex.glow);
    this.sparks = new ParticleSystem(this.object3d, P.sparks, { additive: true, renderOrder: 54 });
    this.drops = new ParticleSystem(this.object3d, P.drops, { additive: false, renderOrder: 53 });

    // whoosh arcs
    this._arcGeo = makeArcGeometry();
    this.arcs = [];
    for (let i = 0; i < P.arcs; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uHead: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(PALETTE.dodgeTrail) } },
        vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(this._arcGeo, mat);
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 55;
      this.object3d.add(mesh);
      this.arcs.push({ mesh, mat, active: false, age: 0, life: 0.3, delay: 0, alpha: 1 });
    }

    // knockdown dust rings (flat on the canvas)
    this._dustGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.dustRings = [];
    for (let i = 0; i < P.dust; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uProgress: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: COL.dust.clone() } },
        vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false,
        toneMapped: true, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(this._dustGeo, mat);
      mesh.visible = false; mesh.renderOrder = 20;
      this.object3d.add(mesh);
      this.dustRings.push({ mesh, mat, active: false, age: 0, life: 1, size: 1 });
    }

    // confetti (one instanced draw call)
    const C = FX_TUNING.confetti;
    this._confGeo = new THREE.PlaneGeometry(0.065, 0.04);
    this._confMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    this.confettiMesh = new THREE.InstancedMesh(this._confGeo, this._confMat, C.count);
    this.confettiMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.confettiMesh.frustumCulled = false;
    this.confettiMesh.count = 0;
    this.confettiMesh.visible = false;
    for (let i = 0; i < C.count; i++) this.confettiMesh.setColorAt(i, COL.white);
    this.object3d.add(this.confettiMesh);
    this.conf = {
      n: 0,
      pos: new Float32Array(C.count * 3), vel: new Float32Array(C.count * 3), rot: new Float32Array(C.count * 3),
      spin: new Float32Array(C.count * 3), age: new Float32Array(C.count), life: new Float32Array(C.count),
      phase: new Float32Array(C.count), col: new Float32Array(C.count * 3),
    };

    // trails (red: the opponent's power punch / hook and its miss streak; blue: the player's fast punch)
    this.trails = new TrailPool(this.object3d, FX_TUNING.trail.slots, FX_TUNING.trail.points);
    // light streaks for the win banner
    this.lightStreaks = new LightStreaks(this.object3d, FX_TUNING.streaks.ribbons);
    // orange radial speed lines (one frame before the player-hit cut, fading into it), per viewport
    this._speedGeo = new THREE.BufferGeometry();
    this._speedGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.speed = {};
    for (const ch of CHANNELS) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: 0 }, uSeed: { value: 1 }, uAspect: { value: 16 / 9 }, uColor: { value: new THREE.Color(PALETTE.speedLines ?? 0xff7a1f) } },
        vertexShader: FLASH_VERT, fragmentShader: SPEED_FRAG, transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(this._speedGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 998;
      mesh.visible = false;
      mesh.onBeforeRender = (renderer) => {
        renderer.getCurrentViewport(_vp);
        mat.uniforms.uAspect.value = _vp.w > 0 ? _vp.z / _vp.w : 16 / 9;
      };
      this.object3d.add(mesh);
      this.speed[ch] = { mesh, mat };
    }

    // full-screen flashes (clip-space triangle → covers whichever viewport is being drawn); one per
    // viewport channel so in versus a hit only flashes the screen of the player who took it
    this._flashGeo = new THREE.BufferGeometry();
    this._flashGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.flashes = {};
    for (const ch of CHANNELS) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) } },
        vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG, transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(this._flashGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1000;
      mesh.visible = false;
      this.object3d.add(mesh);
      this.flashes[ch] = { mesh, mat };
    }
    this._viewportChannel = 'p1';

    // time control & shake
    this._time = 0;
    this._hitStopMs = 0;
    this._slowMoMs = 0;
    this._slowMoScale = 1;
    this._trauma = { p1: 0, p2: 0 };
    this._shakeMul = 1;
    this._flashMul = 1;
  }

  /** Settings → reducedMotion: much smaller screen shake and dimmer screen flashes (hit-stop is kept). */
  setReducedMotion(on) {
    const R = FX_TUNING.reducedMotion;
    this._shakeMul = on ? R.shake : 1;
    this._flashMul = on ? R.flash : 1;
  }

  // ───────────── time control ─────────────

  /** Multiplier for GAME dt: 1 normally, ~0.05 during hit-stop, ~0.35 in knockdown/KO slow-mo. */
  get timeScale() {
    let s = 1;
    if (this._hitStopMs > 0) s = Math.min(s, FX_TUNING.hitStop.scale);
    if (this._slowMoMs > 0) {
      const ease = FX_TUNING.slowMo.easeOutMs;
      const k = this._slowMoMs >= ease ? 0 : 1 - this._slowMoMs / ease;
      s = Math.min(s, lerp(this._slowMoScale, 1, k * k * (3 - 2 * k)));
    }
    return s;
  }

  /** Freeze game time for `ms` real milliseconds (does not stack — the longer one wins). */
  hitStop(ms) { if (ms > 0) this._hitStopMs = Math.max(this._hitStopMs, Math.min(ms, FX_TUNING.hitStop.capMs)); }

  /** Real milliseconds of hit-stop still to run. */
  get hitStopLeftMs() { return this._hitStopMs; }

  /** Hit-stop length for a landed punch: 45–70 ms scaled by power, a bit longer for counters. */
  punchHitStopMs(power = 0.5, counter = false) {
    const H = FX_TUNING.hitStop;
    return Math.min(H.maxMs, H.baseMs + H.powerMs * clamp01(power) + (counter ? H.counterMs : 0));
  }

  /** Slow motion at `scale` for `ms` real ms (with a smooth ease back to 1). */
  slowMo(scale, ms) {
    if (!(ms > 0)) return;
    if (this._slowMoMs > 0) this._slowMoScale = Math.min(this._slowMoScale, scale);
    else this._slowMoScale = scale;
    this._slowMoMs = Math.max(this._slowMoMs, ms);
  }

  // ───────────── shake ─────────────

  /** Add camera trauma (0..1) to a viewport channel: 'p1', 'p2' or 'all'. */
  shake(amount, channel = 'all') {
    if (!(amount > 0)) return;
    amount *= this._shakeMul;
    if (channel === 'all' || channel === 'p1') this._trauma.p1 = Math.min(1, this._trauma.p1 + amount);
    if (channel === 'all' || channel === 'p2') this._trauma.p2 = Math.min(1, this._trauma.p2 + amount);
  }

  /** Current shake for a channel → out {x, y, roll} (camera-space metres / radians). */
  getShake(channel, out) {
    const S = FX_TUNING.shake;
    const tr = this._trauma[channel] ?? 0;
    const k = tr * tr;
    if (k === 0) { out.x = 0; out.y = 0; out.roll = 0; return out; }
    const t = this._time * S.freq;
    const seed = channel === 'p2' ? 5.3 : 0;
    out.x = S.maxOffset * k * noise(t, 1.1 + seed);
    out.y = S.maxOffset * k * noise(t, 7.7 + seed);
    out.roll = S.maxRoll * k * noise(t * 0.8, 3.3 + seed);
    return out;
  }

  // ───────────── spawners ─────────────

  /**
   * Landed punch. kind 'player' = the player's clean hit (pink pop + sparkles, bigger for a
   * counter); 'taken' = a hit on the player (blue/white crackle, + purple when `heavy`);
   * 'neutral' = the training spark (gold star-burst).
   * @param {THREE.Vector3} pos  world impact point
   * @param {{power?:number, counter?:boolean, scale?:number, kind?:'player'|'taken'|'neutral', heavy?:boolean}} [o]
   */
  hit(pos, { power = 0.6, counter = false, scale = 1, kind = 'neutral', heavy = false } = {}) {
    if (kind === 'player') return this._pop(pos, power, counter, scale);
    if (kind === 'taken') return this._taken(pos, power, heavy || counter, scale);
    const T = FX_TUNING.spark;
    const p = clamp01(power);
    const mul = (counter ? T.counterMul : 1) * scale * (0.85 + 0.3 * p);
    const tint = counter ? COL.counter : COL.spark;

    let s = this.sprites.take();
    s.mat.map = this.tex.star; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(tint);
    s.sprite.position.copy(pos);
    s.life = T.starLife * (counter ? 1.35 : 1); s.s0 = T.starSize * mul * 0.6; s.s1 = (T.starSize + T.starGrow) * mul;
    s.a0 = 1; s.fadeFrom = 0.25; s.growPow = 3; s.mat.rotation = this.random() * Math.PI; s.spin = (this.random() - 0.5) * 3;

    s = this.sprites.take();
    s.mat.map = this.tex.glow; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.core);
    s.sprite.position.copy(pos);
    s.life = T.glowLife; s.s0 = T.glowSize * mul; s.s1 = T.glowSize * mul * 1.25; s.a0 = 0.95; s.fadeIn = 0; s.fadeFrom = 0.1;

    if (counter) {
      s = this.sprites.take();
      s.mat.map = this.tex.ring; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.counter);
      s.sprite.position.copy(pos);
      s.life = 0.3; s.s0 = 0.15; s.s1 = 0.85 * scale; s.a0 = 0.85; s.growPow = 2; s.fadeFrom = 0.2;
    }

    const n = counter ? T.counterStreaks : T.streaks + Math.round(p * 4);
    for (let i = 0; i < n; i++) {
      randomDir(this.random, _v);
      const sp = lerp(T.streakSpeed[0], T.streakSpeed[1], this.random()) * (counter ? 1.25 : 1) * (0.8 + 0.4 * p);
      const life = lerp(T.streakLife[0], T.streakLife[1], this.random());
      _c.copy(this.random() < 0.35 ? COL.core : tint);
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, life,
        T.streakWidth * (counter ? 1.3 : 1), T.streakWidth * 0.6, 1, _c, PShape.STREAK, T.streakStretch, T.streakDrag, 0);
    }
    for (let i = 0; i < T.pops; i++) {
      randomDir(this.random, _v);
      const sp = 0.9 + this.random() * 1.3;
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp + 1.0, _v.z * sp, 0.3 + this.random() * 0.2,
        0.03, 0.012, 1, tint, PShape.DOT, 1, 3, 6);
    }
  }

  /**
   * Telegraph glint on a glove that is winding up (readable tell for early opponents): a quick
   * four-point twinkle with a soft halo.
   */
  glint(pos, { color = 0xfff6d8, size = 1 } = {}) {
    _c.set(color);
    this.sparks.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.32, 0.05 * size, 0.3 * size, 1, _c, PShape.TWINKLE, 1, 0, 0);
    const s = this.sprites.take();
    s.mat.map = this.tex.glow; s.mat.blending = THREE.AdditiveBlending; s.mat.color.set(color);
    s.sprite.position.copy(pos);
    s.life = 0.26; s.s0 = 0.08 * size; s.s1 = 0.26 * size; s.a0 = 0.7; s.fadeFrom = 0.3;
  }

  /** Any block (§2.3): a quick green ring at the contact point — no puff, no hit-stop. */
  block(pos, { power = 0.5 } = {}) {
    const B = FX_TUNING.block;
    const k = 0.9 + 0.3 * clamp01(power);
    let s = this.sprites.take();
    s.mat.map = this.tex.ring; s.mat.blending = THREE.NormalBlending; s.mat.color.copy(COL.block);
    s.sprite.position.copy(pos);
    s.life = B.ringLife; s.s0 = B.ringSize[0] * k; s.s1 = B.ringSize[1] * k; s.a0 = 1; s.growPow = 2.6; s.fadeIn = 0; s.fadeFrom = 0.35;
    s = this.sprites.take();
    s.mat.map = this.tex.ring; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.blockHi);
    s.sprite.position.copy(pos);
    s.life = B.ringLife * 0.8; s.s0 = B.ringSize[0] * k * 0.9; s.s1 = B.ringSize[1] * k * 0.92; s.a0 = 0.7; s.growPow = 2.6; s.fadeIn = 0; s.fadeFrom = 0.2;
    for (let i = 0; i < B.dots; i++) {
      randomDir(this.random, _v);
      const sp = 0.8 + this.random() * 0.8;
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, 0.16 + this.random() * 0.08,
        0.035, 0.015, 0.9, COL.blockHi, PShape.TWINKLE, 1, 4, 0);
    }
  }

  /** The player's clean hit: pink petal-pop with a white core, sparkles and short pink streaks. */
  _pop(pos, power, counter, scale) {
    const T = FX_TUNING.pop;
    const p = clamp01(power);
    const mul = scale * (counter ? T.counterMul : 1) * (0.9 + 0.25 * p);
    const life = counter ? T.counterLife : T.life;
    const rot = this.random() * Math.PI, spin = (this.random() - 0.5) * 2;
    // a darker rim under the bright pop gives it a crisp cartoon edge
    let s = this.sprites.take();
    s.mat.map = this.tex.pop; s.mat.blending = THREE.NormalBlending; s.mat.color.copy(COL.pinkDeep);
    s.sprite.position.copy(pos);
    s.life = life; s.s0 = T.size * mul * 0.62; s.s1 = (T.size + T.grow) * mul * 1.12; s.a0 = 1; s.fadeIn = 0; s.fadeFrom = 0.45; s.growPow = 3.2;
    s.mat.rotation = rot; s.spin = spin;
    s = this.sprites.take();
    s.mat.map = this.tex.pop; s.mat.blending = THREE.NormalBlending; s.mat.color.copy(COL.pink);
    s.sprite.position.copy(pos);
    s.life = life; s.s0 = T.size * mul * 0.55; s.s1 = (T.size + T.grow) * mul; s.a0 = 1; s.fadeIn = 0; s.fadeFrom = 0.45; s.growPow = 3.2;
    s.mat.rotation = rot; s.spin = spin;
    s = this.sprites.take();
    s.mat.map = this.tex.glow; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.white);
    s.sprite.position.copy(pos);
    s.life = life * 0.45; s.s0 = T.size * mul * 1.1; s.s1 = T.size * mul * 1.5; s.a0 = 0.95; s.fadeIn = 0; s.fadeFrom = 0.15;
    if (counter) {
      s = this.sprites.take();
      s.mat.map = this.tex.ring; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.pinkHi);
      s.sprite.position.copy(pos);
      s.life = 0.36; s.s0 = 0.2 * scale; s.s1 = 1.05 * scale; s.a0 = 0.9; s.growPow = 2; s.fadeFrom = 0.25;
    }
    const n = T.streaks + (counter ? 6 : 0);
    for (let i = 0; i < n; i++) {
      randomDir(this.random, _v);
      const sp = lerp(1.6, 3.2, this.random()) * (counter ? 1.25 : 1);
      _c.copy(this.random() < 0.4 ? COL.white : COL.pink);
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, lerp(0.14, 0.26, this.random()),
        0.016 * (counter ? 1.3 : 1), 0.008, 1, _c, PShape.STREAK, 6, 8, 0);
    }
    for (let i = 0; i < T.sparkles + (counter ? 6 : 0); i++) {
      randomDir(this.random, _v);
      const r = 0.12 + this.random() * 0.22 * mul;
      this.sparks.emit(pos.x + _v.x * r, pos.y + _v.y * r, pos.z + _v.z * r, _v.x * 0.35, _v.y * 0.35 + 0.25, _v.z * 0.35,
        0.32 + this.random() * 0.3, 0.02, 0.06 + this.random() * 0.03, 1, this.random() < 0.5 ? COL.white : COL.pinkHi, PShape.TWINKLE, 1, 1.5, 0, this.random() * 0.12);
    }
  }

  /** A hit on the player: blue/white crackle burst; `heavy` (heavy hit or counter) adds a purple burst. */
  _taken(pos, power, heavy, scale) {
    const T = FX_TUNING.taken;
    const mul = scale * (heavy ? T.heavyMul : 1) * (0.9 + 0.2 * clamp01(power));
    let s;
    if (heavy) {
      s = this.sprites.take();
      s.mat.map = this.tex.pop; s.mat.blending = THREE.NormalBlending; s.mat.color.copy(COL.purple);
      s.sprite.position.copy(pos);
      s.life = T.purpleLife; s.s0 = T.size * mul * 0.8; s.s1 = (T.size + T.grow) * mul * 1.35; s.a0 = 0.95; s.fadeIn = 0; s.fadeFrom = 0.4; s.growPow = 2.6;
      s.mat.rotation = this.random() * Math.PI; s.spin = (this.random() - 0.5) * 1.5;
    }
    s = this.sprites.take();
    s.mat.map = this.tex.crackle; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.blue);
    s.sprite.position.copy(pos);
    s.life = T.life; s.s0 = T.size * mul * 0.6; s.s1 = (T.size + T.grow) * mul; s.a0 = 1; s.fadeIn = 0; s.fadeFrom = 0.35; s.growPow = 3;
    s.mat.rotation = this.random() * Math.PI * 2; s.spin = (this.random() - 0.5) * 4;
    s = this.sprites.take();
    s.mat.map = this.tex.glow; s.mat.blending = THREE.AdditiveBlending; s.mat.color.copy(COL.white);
    s.sprite.position.copy(pos);
    s.life = T.life * 0.5; s.s0 = T.size * mul * 1.2; s.s1 = T.size * mul * 1.7; s.a0 = 1; s.fadeIn = 0; s.fadeFrom = 0.12;
    for (let i = 0; i < T.streaks + (heavy ? 8 : 0); i++) {
      randomDir(this.random, _v);
      const sp = lerp(1.8, 3.6, this.random());
      _c.copy(this.random() < 0.45 ? COL.white : heavy && this.random() < 0.5 ? COL.purple : COL.blue);
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, lerp(0.12, 0.24, this.random()),
        0.018, 0.008, 1, _c, PShape.STREAK, 7, 9, 0);
    }
  }

  /**
   * Orange radial speed lines on one viewport channel (the frame before the player-hit cut; they
   * fade over ~0.25 s into the cut).
   */
  speedLines(channel = 'p1', strength = 1) {
    for (const ch of CHANNELS) {
      if (channel !== 'all' && channel !== ch) continue;
      const u = this.speed[ch].mat.uniforms;
      u.uAlpha.value = Math.max(u.uAlpha.value, clamp01(strength));
      u.uSeed.value = 1 + this.random() * 50;
    }
    this.setViewportChannel(this._viewportChannel);
  }

  /** Start (or keep feeding) a glove trail. `key` identifies it (e.g. 'p2:right'). */
  trailStart(key, color, { width = FX_TUNING.trail.width, life = FX_TUNING.trail.life } = {}) {
    return this.trails.start(key, color, width, life);
  }
  /** Push the glove's current world position onto a running trail. */
  trailPoint(key, pos) { this.trails.point(key, pos); }
  /** Stop feeding a trail; it fades out over `linger` seconds (longer for a miss streak). */
  trailStop(key, linger = FX_TUNING.trail.linger) { this.trails.stop(key, linger); }

  /** An opponent's missed punch: a red streak along the punch direction that lingers a moment. */
  missStreak(pos, dir, { color = PALETTE.trailRed ?? 0xff3b3b, life = 0.5 } = {}) {
    _c.set(color);
    for (let i = 0; i < 7; i++) {
      const sp = 1.6 + this.random() * 1.6;
      this.sparks.emit(pos.x + (this.random() - 0.5) * 0.08, pos.y + (this.random() - 0.5) * 0.08, pos.z + (this.random() - 0.5) * 0.08,
        dir.x * sp, dir.y * sp + (this.random() - 0.5) * 0.3, dir.z * sp, life * (0.7 + this.random() * 0.5),
        0.03, 0.012, 0.85, _c, PShape.STREAK, 10, 3.5, 0, i * 0.015);
    }
  }

  /** Light streaks swirling around `center` (the win banner moment). */
  streaks(center = { x: 0, y: 0, z: 0 }, { duration = FX_TUNING.streaks.life } = {}) {
    this.lightStreaks.start(center, duration, this.random);
  }

  /**
   * Whoosh arcs around `pos` trailing opposite to the movement `dir` (x/y in the plane facing ±Z).
   * Used for dodges (head moved) and, smaller, for misses.
   */
  whoosh(pos, dirX, dirY, { strength = 1, color = null, arcs = FX_TUNING.whoosh.arcs } = {}) {
    const W = FX_TUNING.whoosh;
    const len = Math.hypot(dirX, dirY) || 1;
    const ang = Math.atan2(-dirY / len, -dirX / len); // trail behind the movement
    for (let i = 0; i < arcs; i++) {
      const a = this._takeArc();
      a.mesh.position.copy(pos);
      a.mesh.rotation.set(0, 0, ang + (this.random() - 0.5) * 0.35);
      const r = (W.radius + W.radiusStep * i) * (0.8 + 0.3 * strength);
      a.mesh.scale.set(r, r, r);
      a.life = W.life; a.delay = W.stagger * i; a.alpha = (0.95 - 0.18 * i) * Math.min(1.2, strength);
      a.mat.uniforms.uColor.value.copy(color ? _c2.set(color) : COL.trail);
    }
  }

  /** A punch that hit nothing: a faint air streak burst along the punch direction + a small arc. */
  miss(pos, dir) {
    for (let i = 0; i < 5; i++) {
      const sp = 2.2 + this.random() * 1.5;
      this.sparks.emit(pos.x + (this.random() - 0.5) * 0.1, pos.y + (this.random() - 0.5) * 0.1, pos.z,
        dir.x * sp, dir.y * sp + (this.random() - 0.5) * 0.4, dir.z * sp, 0.18 + this.random() * 0.08,
        0.012, 0.008, 0.55, COL.white, PShape.STREAK, 9, 6, 0, i * 0.012);
    }
    this.whoosh(pos, 0, 1, { strength: 0.55, color: 0xf4f1e8, arcs: 1 });
  }

  /** Sweat droplets thrown off a head along `dir` (unit-ish world vector). */
  sweat(pos, dir, { amount = 1 } = {}) {
    const S = FX_TUNING.sweat;
    const n = Math.round(S.drops * Math.max(0.3, Math.min(1.6, amount)));
    for (let i = 0; i < n; i++) {
      randomDir(this.random, _v);
      _v2.set(dir.x, dir.y, dir.z).normalize().multiplyScalar(1.4).add(_v).normalize();
      const sp = lerp(S.speed[0], S.speed[1], this.random());
      this.drops.emit(pos.x, pos.y, pos.z, _v2.x * sp, _v2.y * sp + 1.1, _v2.z * sp,
        lerp(S.life[0], S.life[1], this.random()), S.size * (0.7 + this.random() * 0.6), S.size * 0.8, 0.9,
        COL.sweat, PShape.DROP, 2.2, 0.6, S.gravity);
    }
  }

  /** Knockdown dust: expanding ring on the canvas + rising puffs. `pos.y` is ignored (canvas level). */
  dust(pos, { size = 1 } = {}) {
    const D = FX_TUNING.dust;
    let ring = this.dustRings.find((r) => !r.active) || this.dustRings[0];
    ring.active = true; ring.age = 0; ring.life = D.ringLife; ring.size = D.ringRadius * 2 * size;
    ring.mesh.position.set(pos.x, 0.012, pos.z);
    ring.mesh.visible = true;
    for (let i = 0; i < D.puffs; i++) {
      const a = (i / D.puffs) * Math.PI * 2 + this.random() * 0.5;
      const r = (0.35 + this.random() * 0.45) * size;
      const s = this.sprites.take();
      s.mat.map = this.tex.puff; s.mat.blending = THREE.NormalBlending; s.mat.color.copy(COL.dust);
      s.sprite.position.set(pos.x + Math.cos(a) * r, 0.12 + this.random() * 0.1, pos.z + Math.sin(a) * r);
      s.vel.set(Math.cos(a) * 0.9, 0.25 + this.random() * 0.25, Math.sin(a) * 0.9);
      s.drag = 2.2; s.life = D.puffLife * (0.8 + this.random() * 0.4);
      s.s0 = 0.25 * size; s.s1 = 0.75 * size; s.a0 = 0.6; s.fadeFrom = 0.3; s.growPow = 2;
      s.mat.rotation = this.random() * 6.28; s.spin = (this.random() - 0.5) * 0.8;
      s.mat.depthTest = true;
    }
  }

  /** Confetti: half rains from above `center`, half bursts up from two sides. */
  confetti(center = { x: 0, y: 0, z: 0 }, { amount = 1, colors = PALETTE.crowd } = {}) {
    const C = FX_TUNING.confetti;
    const cf = this.conf;
    const total = Math.min(C.count, Math.round(C.count * amount));
    for (let i = 0; i < total; i++) {
      const k = cf.n < C.count ? cf.n++ : Math.floor(this.random() * C.count);
      const k3 = k * 3;
      if (i % 2 === 0) { // rain
        const a = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * 2.8;
        cf.pos[k3] = center.x + Math.cos(a) * r; cf.pos[k3 + 1] = 3.6 + this.random() * 1.6; cf.pos[k3 + 2] = center.z + Math.sin(a) * r;
        cf.vel[k3] = (this.random() - 0.5) * 0.4; cf.vel[k3 + 1] = -0.2 - this.random() * 0.4; cf.vel[k3 + 2] = (this.random() - 0.5) * 0.4;
      } else { // cannons from two corners
        const sx = i % 4 === 1 ? 1 : -1;
        cf.pos[k3] = center.x + sx * 2.9; cf.pos[k3 + 1] = 1.3; cf.pos[k3 + 2] = center.z + sx * 2.9;
        cf.vel[k3] = -sx * (1.1 + this.random() * 1.2); cf.vel[k3 + 1] = 4.2 + this.random() * 2.2; cf.vel[k3 + 2] = -sx * (1.1 + this.random() * 1.2) + (this.random() - 0.5);
      }
      cf.rot[k3] = this.random() * 6.28; cf.rot[k3 + 1] = this.random() * 6.28; cf.rot[k3 + 2] = this.random() * 6.28;
      cf.spin[k3] = (this.random() - 0.5) * 12; cf.spin[k3 + 1] = (this.random() - 0.5) * 9; cf.spin[k3 + 2] = (this.random() - 0.5) * 12;
      cf.age[k] = 0; cf.life[k] = lerp(C.life[0], C.life[1], this.random()); cf.phase[k] = this.random() * 6.28;
      _c.setHex(colors[Math.floor(this.random() * colors.length)]);
      this.confettiMesh.setColorAt(k, _c);
    }
    if (this.confettiMesh.instanceColor) this.confettiMesh.instanceColor.needsUpdate = true;
    this.confettiMesh.visible = cf.n > 0;
  }

  /** Brief full-screen flash (impact frame) on a viewport channel: 'p1', 'p2' or 'all'. */
  screenFlash(strength = 0.5, color = 0xffffff, channel = 'all') {
    strength *= this._flashMul;
    for (const ch of CHANNELS) {
      if (channel !== 'all' && channel !== ch) continue;
      const u = this.flashes[ch].mat.uniforms;
      if (strength >= u.uAlpha.value) u.uColor.value.set(color);
      u.uAlpha.value = Math.max(u.uAlpha.value, Math.min(1, strength));
    }
    this.setViewportChannel(this._viewportChannel);
  }

  /** Call before drawing a viewport: only that channel's flash / speed lines are shown. */
  setViewportChannel(channel) {
    this._viewportChannel = channel === 'p2' ? 'p2' : 'p1';
    for (const ch of CHANNELS) {
      const f = this.flashes[ch];
      f.mesh.visible = ch === this._viewportChannel && f.mat.uniforms.uAlpha.value > 0.002;
      const sl = this.speed[ch];
      sl.mesh.visible = ch === this._viewportChannel && sl.mat.uniforms.uAlpha.value > 0.01;
    }
  }

  // ───────────── per frame ─────────────

  /**
   * Advance all effects by REAL seconds (never the scaled game dt). `particleScale` slows the
   * particles, sprites, trails and confetti (dodge slow motion, replays) while the time control,
   * shake and screen flashes keep real time.
   */
  update(realDt, particleScale = 1) {
    const dt = Math.max(0, Math.min(0.1, realDt || 0));
    const pdt = dt * (Number.isFinite(particleScale) ? Math.max(0, Math.min(1, particleScale)) : 1);
    this._time += dt;
    this._hitStopMs = Math.max(0, this._hitStopMs - dt * 1000);
    this._slowMoMs = Math.max(0, this._slowMoMs - dt * 1000);
    if (this._slowMoMs === 0) this._slowMoScale = 1;
    const decay = FX_TUNING.shake.decayPerSec * dt;
    this._trauma.p1 = Math.max(0, this._trauma.p1 - decay);
    this._trauma.p2 = Math.max(0, this._trauma.p2 - decay);

    this.sprites.update(pdt);
    this.sparks.update(pdt);
    this.drops.update(pdt);
    this._updateArcs(pdt);
    this._updateDust(pdt);
    this._updateConfetti(pdt);
    this.trails.update(pdt);
    this.lightStreaks.update(pdt);

    for (const ch of CHANNELS) {
      const u = this.flashes[ch].mat.uniforms;
      if (u.uAlpha.value > 0) u.uAlpha.value = Math.max(0, u.uAlpha.value - FX_TUNING.flash.decayPerSec * dt * Math.max(0.35, u.uAlpha.value));
      const sl = this.speed[ch].mat.uniforms;
      if (sl.uAlpha.value > 0) sl.uAlpha.value = Math.max(0, sl.uAlpha.value - FX_TUNING.speedLines.decayPerSec * dt);
    }
    this.setViewportChannel(this._viewportChannel);
  }

  _takeArc() {
    let best = this.arcs[0], bestT = -1;
    for (const a of this.arcs) {
      if (!a.active) { best = a; bestT = 2; break; }
      const t = a.age / a.life;
      if (t > bestT) { bestT = t; best = a; }
    }
    best.active = true; best.age = 0; best.delay = 0; best.mesh.visible = false;
    return best;
  }

  _updateArcs(dt) {
    for (const a of this.arcs) {
      if (!a.active) continue;
      if (a.delay > 0) { a.delay -= dt; if (a.delay > 0) continue; }
      a.age += dt;
      const t = a.age / a.life;
      if (t >= 1) { a.active = false; a.mesh.visible = false; continue; }
      a.mat.uniforms.uHead.value = easeOut(t, 2) * 1.6;
      a.mat.uniforms.uAlpha.value = a.alpha * (1 - smooth(0.55, 1, t));
      a.mesh.visible = true;
    }
  }

  _updateDust(dt) {
    for (const r of this.dustRings) {
      if (!r.active) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) { r.active = false; r.mesh.visible = false; continue; }
      const e = easeOut(t, 2.5);
      r.mesh.scale.setScalar(r.size * (0.35 + 0.65 * e));
      r.mat.uniforms.uProgress.value = e;
      r.mat.uniforms.uAlpha.value = 0.75 * (1 - smooth(0.35, 1, t));
    }
  }

  _updateConfetti(dt) {
    const cf = this.conf;
    if (cf.n === 0) return;
    const C = FX_TUNING.confetti;
    for (let i = 0; i < cf.n; i++) {
      cf.age[i] += dt;
      if (cf.age[i] >= cf.life[i]) { // swap-remove
        cf.n--;
        if (i !== cf.n) {
          const a = i * 3, b = cf.n * 3;
          for (let k = 0; k < 3; k++) {
            cf.pos[a + k] = cf.pos[b + k]; cf.vel[a + k] = cf.vel[b + k]; cf.rot[a + k] = cf.rot[b + k]; cf.spin[a + k] = cf.spin[b + k];
          }
          cf.age[i] = cf.age[cf.n]; cf.life[i] = cf.life[cf.n]; cf.phase[i] = cf.phase[cf.n];
          this.confettiMesh.getColorAt(cf.n, _c); this.confettiMesh.setColorAt(i, _c);
        }
        i--;
        continue;
      }
      const i3 = i * 3;
      const drag = Math.exp(-1.6 * dt);
      cf.vel[i3] *= drag; cf.vel[i3 + 2] *= drag;
      cf.vel[i3 + 1] = Math.max(-C.terminal, cf.vel[i3 + 1] - C.gravity * 3 * dt);
      const fl = Math.sin(cf.age[i] * 5 + cf.phase[i]) * C.flutter;
      cf.pos[i3] += (cf.vel[i3] + fl) * dt;
      cf.pos[i3 + 1] = Math.max(0.01, cf.pos[i3 + 1] + cf.vel[i3 + 1] * dt);
      cf.pos[i3 + 2] += (cf.vel[i3 + 2] + Math.cos(cf.age[i] * 4 + cf.phase[i]) * C.flutter * 0.6) * dt;
      for (let k = 0; k < 3; k++) cf.rot[i3 + k] += cf.spin[i3 + k] * dt;
      const fade = 1 - smooth(0.85, 1, cf.age[i] / cf.life[i]);
      _e.set(cf.rot[i3], cf.rot[i3 + 1], cf.rot[i3 + 2]);
      _q.setFromEuler(_e);
      _v.set(cf.pos[i3], cf.pos[i3 + 1], cf.pos[i3 + 2]);
      _s.setScalar(Math.max(0.001, fade));
      _m.compose(_v, _q, _s);
      this.confettiMesh.setMatrixAt(i, _m);
    }
    this.confettiMesh.count = cf.n;
    this.confettiMesh.instanceMatrix.needsUpdate = true;
    if (this.confettiMesh.instanceColor) this.confettiMesh.instanceColor.needsUpdate = true;
    this.confettiMesh.visible = cf.n > 0;
  }

  /** Remove every live effect and reset time control (e.g. when leaving a match). */
  clear() {
    this.sprites.clear();
    this.sparks.clear();
    this.drops.clear();
    for (const a of this.arcs) { a.active = false; a.mesh.visible = false; }
    for (const r of this.dustRings) { r.active = false; r.mesh.visible = false; }
    this.conf.n = 0; this.confettiMesh.count = 0; this.confettiMesh.visible = false;
    for (const ch of CHANNELS) {
      this.flashes[ch].mat.uniforms.uAlpha.value = 0; this.flashes[ch].mesh.visible = false;
      this.speed[ch].mat.uniforms.uAlpha.value = 0; this.speed[ch].mesh.visible = false;
    }
    this.trails.clear();
    this.lightStreaks.clear();
    this._hitStopMs = 0; this._slowMoMs = 0; this._slowMoScale = 1;
    this._trauma.p1 = 0; this._trauma.p2 = 0;
  }

  /** Live counts (debug / tests). */
  stats() {
    return {
      sprites: this.sprites.activeCount(), sparks: this.sparks.count, drops: this.drops.count,
      arcs: this.arcs.filter((a) => a.active).length, dust: this.dustRings.filter((r) => r.active).length,
      confetti: this.conf.n, flash: Math.max(this.flashes.p1.mat.uniforms.uAlpha.value, this.flashes.p2.mat.uniforms.uAlpha.value),
      trails: this.trails.activeCount(), streaks: this.lightStreaks.active ? 1 : 0,
      speedLines: Math.max(this.speed.p1.mat.uniforms.uAlpha.value, this.speed.p2.mat.uniforms.uAlpha.value),
    };
  }

  dispose() {
    this.object3d.removeFromParent();
    this.object3d.traverse((o) => {
      if (o.material) o.material.dispose();
      if (o.geometry && !o.isSprite) o.geometry.dispose();
    });
    for (const t of Object.values(this.tex)) t.dispose();
  }
}

/** Smooth pseudo-noise in about [-1, 1] (sum of incommensurate sines; no allocation). */
function noise(t, seed) {
  return 0.5 * Math.sin(t + seed) + 0.3 * Math.sin(t * 2.17 + seed * 1.7) + 0.2 * Math.sin(t * 4.31 + seed * 0.37);
}

/** Uniform random unit vector into `out`. */
function randomDir(random, out) {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}
