// On-hit health meters drawn in the 3D view (owner: view3d) — ARCHITECTURE §6.7.
//
// Our own graphic: a rounded badge of 10 capsule "cells" (one per wedge of health, partial cells
// drawn), NOT a pie or wedge disc. It behaves as research/mechanics.md §5 "How a pie behaves":
//   * it appears only when its fighter is hit;
//   * it first shows the pre-hit value (MATCH_HIT.hpBefore), then drains 0.5–0.8 s later;
//   * the lost part breaks into white shards with a ring pulse;
//   * the cell on the lost side of the edge blinks at ~10 Hz while the meter is visible;
//   * it hides 2.5–4 s after the last hit, but stays while health ≤ 3 wedges or empty;
//   * it is dark during the count, refills with a glowing sweep and sparkles (~1.25 s) on rising;
//   * it flashes and bursts when the knockdown blow lands.
// Placement: the opponent's meter floats beside its head (~64–69 % across, 22–30 % down); the
// player's own meter sits at left-centre near the lead glove (~25–32 % across, 58–65 % down).
// Versus: each viewport shows its own player's meter low-left and the foe's by the head.
//
// MeterState is pure logic (Node-testable); HealthMeters adds one clip-space quad per fighter
// whose fragment shader draws the badge, the shards, the ring pulse and the sparkles (one draw
// call per visible meter, no per-frame allocations).

import * as THREE from 'three';
import { PALETTE } from './style.js';

export const METER_TUNING = Object.freeze({
  cells: 10,
  drainDelay: 0.6,        // s — the pre-hit value shows this long before the drop (0.5–0.8 s)
  drainTime: 0.12,        // s — the drop itself
  hideAfter: 3.2,         // s after the last hit (2.5–4 s)
  stayAtOrBelow: 3,       // wedges — the meter stays up from here down (and when empty)
  blinkHz: 10, blinkDuty: 0.34, // the edge cell: lit one frame in three at 30 fps
  refillTime: 1.25,       // s — the glowing sweep on rising (1–1.5 s)
  shardLife: 0.62, ringLife: 0.42, flashLife: 0.55, sparkleLife: 1.4,
  fadeIn: 0.06, fadeOut: 0.3,
  // layout, as fractions of the viewport (x from the left, y from the top)
  foe: Object.freeze({ width: 0.085, dx: 0.165, dy: -0.04, clampX: [0.08, 0.92], clampY: [0.08, 0.8] }),
  own: Object.freeze({ width: 0.105, x: 0.285, y: 0.615, slack: 0.06 }),
  badgeAspect: 0.3,       // badge height / width
  quad: Object.freeze({ x: 1.55, y: 1.1 }), // quad half-size in badge half-widths (room for shards / ring)
});

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const IDS = ['p1', 'p2'];
const num = (x, d) => (Number.isFinite(x) ? x : d);

/**
 * One fighter's meter: what to show and when. All times in real seconds.
 */
export class MeterState {
  constructor(max = METER_TUNING.cells) {
    this.max = max;
    this.reset(max);
  }

  /** New bout / restart: hidden, full (or `hp`). */
  reset(hp = this.max) {
    this.t = 0;
    this.shown = clamp(num(hp, this.max), 0, this.max);   // what the cells display (wedges)
    this.target = this.shown;                             // where the next drain goes
    this.drainAt = -1;                                    // time of the pending drop (−1 = none)
    this.tweenFrom = this.shown; this.tweenT = -1;        // the 0.12 s drop
    this.lastHitAt = -1e9;
    this.everHit = false;
    this.alpha = 0;
    this.dark = 0;
    this.darkWanted = false;
    this.flashT = -1;
    this.shardT = -1; this.shardFrom = 0; this.shardTo = 0;
    this.ringT = -1;
    this.sweepT = -1; this.sweepFrom = 0; this.sweepTo = 0;
    this.sparkleT = -1;
    this.lastObserved = this.shown;
  }

  /** True when the meter wants to be on screen. */
  get visible() { return this.alpha > 0.01; }

  /** The cell value currently drawn (accounts for the drop tween and the refill sweep). */
  get value() {
    const M = METER_TUNING;
    if (this.sweepT >= 0) {
      const k = clamp(this.sweepT / M.refillTime, 0, 1);
      const e = 1 - Math.pow(1 - k, 2);
      return this.sweepFrom + (this.sweepTo - this.sweepFrom) * e;
    }
    if (this.tweenT >= 0) {
      const k = clamp(this.tweenT / M.drainTime, 0, 1);
      return this.tweenFrom + (this.shown - this.tweenFrom) * k;
    }
    return this.shown;
  }

  /** The refill sweep head in wedges (−1 = none). */
  get sweepHead() { return this.sweepT >= 0 ? this.value : -1; }

  /** 0..1 blink state of the edge cell (1 = lit). */
  get blinkOn() {
    const M = METER_TUNING;
    return ((this.t * M.blinkHz) % 1) < M.blinkDuty ? 1 : 0;
  }

  /**
   * A clean hit landed on this fighter.
   * @param {{hpBefore?:number, hpAfter?:number, knockdown?:boolean}} e  wedges (0..max)
   */
  hit({ hpBefore, hpAfter, knockdown = false } = {}) {
    const M = METER_TUNING;
    const before = clamp(num(hpBefore, this.drainAt >= 0 ? this.shown : this.lastObserved), 0, this.max);
    const after = clamp(num(hpAfter, before), 0, this.max);
    this.everHit = true;
    this.lastHitAt = this.t;
    this.sweepT = -1;
    if (this.drainAt < 0) {
      // show the pre-hit value first and drop later …
      this.shown = before;
      this.tweenT = -1;
      this.target = after;
      this.drainAt = this.t + M.drainDelay;
    } else {
      // … a follow-up inside the delay only moves where the drop goes
      this.target = Math.min(this.target, after);
    }
    if (knockdown) {
      this.flashT = 0;
      this.ringT = 0;
      // the knockdown blow bursts at once: everything that is left breaks off
      this.shardFrom = after; this.shardTo = Math.max(after, this.shown); this.shardT = 0;
      this.drainAt = this.t; // drop now
    }
  }

  /** Knocked down: the meter shows dark through the count. */
  down() { this.darkWanted = true; this.lastHitAt = this.t; }

  /** Rising: refill with a glowing sweep and sparkles up to `hp` wedges. */
  rise(hp) {
    const M = METER_TUNING;
    this.darkWanted = false;
    this.drainAt = -1; this.tweenT = -1;
    this.sweepFrom = Math.min(this.shown, num(hp, this.shown));
    this.sweepTo = clamp(num(hp, this.shown), 0, this.max);
    this.shown = this.sweepTo; this.target = this.sweepTo;
    this.sweepT = 0;
    this.sparkleT = 0;
    this.lastHitAt = this.t + M.refillTime; // stay up through the sweep, then the usual hide delay
  }

  /**
   * Follow the view's health when nothing is animating (between rounds, debug, older matches
   * without hit events). `hp` in wedges.
   */
  observe(hp) {
    if (!Number.isFinite(hp)) return;
    const h = clamp(hp, 0, this.max);
    this.lastObserved = h;
    if (this.drainAt >= 0 || this.sweepT >= 0 || this.tweenT >= 0 || this.darkWanted) return;
    if (Math.abs(h - this.shown) > 0.02) { this.shown = h; this.target = h; }
  }

  /** Advance (real seconds). `hidden` forces the meter away (intros, outros, other scenes). */
  update(dt, hidden = false) {
    const M = METER_TUNING;
    const d = Math.max(0, Math.min(0.1, num(dt, 0)));
    this.t += d;
    if (this.drainAt >= 0 && this.t >= this.drainAt) {
      const from = this.shown;
      const to = Math.min(this.target, from);
      this.drainAt = -1;
      if (to < from - 1e-4) {
        if (this.shardT < 0 || this.shardT > 0.05) { this.shardFrom = to; this.shardTo = from; this.shardT = 0; }
        this.ringT = this.ringT >= 0 && this.ringT < 0.05 ? this.ringT : 0;
        this.tweenFrom = from; this.tweenT = 0;
      }
      this.shown = to;
      this.target = to;
    }
    if (this.tweenT >= 0) { this.tweenT += d; if (this.tweenT >= M.drainTime) this.tweenT = -1; }
    if (this.sweepT >= 0) { this.sweepT += d; if (this.sweepT >= M.refillTime) this.sweepT = -1; }
    if (this.shardT >= 0) { this.shardT += d; if (this.shardT >= M.shardLife) this.shardT = -1; }
    if (this.ringT >= 0) { this.ringT += d; if (this.ringT >= M.ringLife) this.ringT = -1; }
    if (this.flashT >= 0) { this.flashT += d; if (this.flashT >= M.flashLife) this.flashT = -1; }
    if (this.sparkleT >= 0) { this.sparkleT += d; if (this.sparkleT >= M.sparkleLife) this.sparkleT = -1; }
    // dark during the count (after the knockdown flash has burst)
    const darkGoal = this.darkWanted && this.flashT < 0 ? 1 : 0;
    this.dark += (darkGoal - this.dark) * (1 - Math.exp(-10 * d));
    const want = !hidden && this.everHit && (
      this.t - this.lastHitAt < M.hideAfter || this.shown <= M.stayAtOrBelow + 1e-6 || this.darkWanted ||
      this.drainAt >= 0 || this.sweepT >= 0 || this.flashT >= 0);
    const rate = want ? 1 / M.fadeIn : 1 / M.fadeOut;
    this.alpha = clamp(this.alpha + (want ? 1 : -1) * rate * d, 0, 1);
  }
}

// ───────────────────────────── drawing ─────────────────────────────

const METER_VERT = /* glsl */`
uniform vec2 uCenter;
uniform vec2 uHalf;
varying vec2 vQ;
void main() {
  vQ = position.xy;
  gl_Position = vec4(uCenter + position.xy * uHalf, 0.0, 1.0);
}`;

const METER_FRAG = /* glsl */`
uniform vec2 uQuad;          // quad half-size in badge units (badge = [-1,1] × [-uBadgeH, uBadgeH])
uniform float uBadgeH;
uniform float uValue;        // cells shown (0..10)
uniform float uBlinkOn;
uniform float uBlink;        // 1 = blink the lost-side cell
uniform float uDark;
uniform float uFlash;        // 0..1
uniform float uSweep;        // refill sweep head (cells) or -1
uniform float uShardT;       // seconds since shards (-1 = none)
uniform float uShardFrom;
uniform float uShardTo;
uniform float uRingT;
uniform float uSparkleT;
uniform float uAlpha;
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uColorHi;
uniform vec3 uDarkCol;
uniform vec3 uRim;
varying vec2 vQ;

float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdCapsuleV(vec2 p, float h, float r) { p.y -= clamp(p.y, -h, h); return length(p) - r; }
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float sdTri(vec2 p, float s) {
  const float k = 1.7320508;
  p.x = abs(p.x) - s; p.y = p.y + s / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * s, 0.0);
  return -length(p) * sign(p.y);
}

void main() {
  vec2 p = vQ * uQuad;                     // badge units
  float px = fwidth(p.x) * 1.2 + 1e-4;     // ~1 pixel in badge units
  vec4 col = vec4(0.0);

  // ── backing plate + rim ──
  vec2 bh = vec2(1.0, uBadgeH);
  float plate = sdRound(p, bh, uBadgeH * 0.95);
  float plateA = 1.0 - smoothstep(-px, px, plate);
  float rimA = (1.0 - smoothstep(-px, px, plate)) * smoothstep(-0.06 - px, -0.06 + px, plate);
  vec3 back = mix(vec3(0.07, 0.08, 0.15), uDarkCol, 0.35);
  col = vec4(back, 0.82 * plateA);
  col.rgb = mix(col.rgb, uRim * mix(1.0, 0.55, uDark), rimA);
  col.a = max(col.a, rimA);

  // ── cells ──
  float cellW = 1.8 / 10.0;
  float idx = clamp(floor((p.x + 0.9) / cellW), 0.0, 9.0);
  float cx = -0.9 + (idx + 0.5) * cellW;
  float ch = uBadgeH * 0.52, cr = cellW * 0.34;
  float cell = sdCapsuleV(p - vec2(cx, 0.0), ch, cr);
  float cellA = 1.0 - smoothstep(-px, px, cell);
  // fill bottom-up inside the cell
  float level = clamp(uValue - idx, 0.0, 1.0);
  float yN = (p.y + ch + cr) / (2.0 * (ch + cr));          // 0 bottom … 1 top of the capsule
  float filled = step(yN, level) * step(0.001, level);
  // the lost-side cell blinks (the region [value, value+1])
  float lostLo = clamp(uValue - idx, 0.0, 1.0);
  float lostHi = clamp(uValue + 1.0 - idx, 0.0, 1.0);
  float inLost = step(lostLo, yN) * step(yN, lostHi) * step(0.001, lostHi - lostLo);
  vec3 empty = vec3(0.16, 0.18, 0.28);
  vec3 c = empty;
  vec3 lit = mix(uColor, uColorHi, smoothstep(0.55, 1.0, yN) * 0.6);
  c = mix(c, lit, filled);
  c = mix(c, mix(uColorHi, vec3(1.0), 0.35), inLost * uBlink * uBlinkOn * (1.0 - uDark));
  // refill sweep glow at the head
  if (uSweep >= 0.0) {
    float g = exp(-pow((p.x - (-0.9 + uSweep * cellW)) / 0.09, 2.0));
    c = mix(c, vec3(1.0), g * 0.75 * cellA);
  }
  c = mix(c, uDarkCol * 1.35, uDark);
  // glossy highlight on each cell
  float gloss = smoothstep(0.75, 0.95, yN) * (1.0 - smoothstep(0.0, cr * 0.8, abs(p.x - cx + cr * 0.25)));
  c += gloss * 0.22 * (1.0 - uDark);
  col.rgb = mix(col.rgb, c, cellA);
  col.a = max(col.a, cellA);

  // ── knockdown flash ──
  col.rgb = mix(col.rgb, vec3(1.0), uFlash * plateA);

  // ── ring pulse ──
  if (uRingT >= 0.0) {
    float k = uRingT / 0.42;
    float off = 0.04 + k * 0.32;
    float ring = abs(sdRound(p, bh + off, uBadgeH * 0.95 + off)) - (0.025 * (1.0 - k) + px);
    float ra = (1.0 - smoothstep(-px, px, ring)) * (1.0 - k);
    col.rgb = mix(col.rgb, vec3(1.0), ra);
    col.a = max(col.a, ra * 0.95);
  }

  // ── white shards from the lost cells ──
  if (uShardT >= 0.0) {
    float t = uShardT;
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float u = mix(uShardFrom, uShardTo, hash(fi + 1.3));
      vec2 start = vec2(-0.9 + u * cellW, (hash(fi + 4.7) - 0.5) * uBadgeH * 1.4);
      vec2 vel = vec2((hash(fi + 9.1) - 0.5) * 1.6 + 0.35, 0.8 + hash(fi + 2.2) * 1.4);
      vec2 pos = start + vel * t + vec2(0.0, -2.6 * t * t);
      float ang = hash(fi + 5.5) * 6.28 + t * (hash(fi + 8.8) - 0.5) * 18.0;
      vec2 d = p - pos;
      d = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
      float sz = 0.035 + hash(fi + 3.3) * 0.035;
      float tri = sdTri(d, sz);
      float a = (1.0 - smoothstep(-px, px, tri)) * (1.0 - smoothstep(0.35, 0.62, t));
      col.rgb = mix(col.rgb, vec3(1.0), a);
      col.a = max(col.a, a);
    }
  }

  // ── sparkles on the refill ──
  if (uSparkleT >= 0.0) {
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      float life = 0.5 + hash(fi + 1.9) * 0.5;
      float t0 = hash(fi + 6.1) * 0.9;
      float tt = (uSparkleT - t0) / life;
      if (tt < 0.0 || tt > 1.0) continue;
      vec2 pos = vec2(-0.9 + clamp(uSweep < 0.0 ? 10.0 * hash(fi) : uSweep - hash(fi + 2.0) * 1.5, 0.0, 10.0) * cellW,
                      (hash(fi + 7.3) - 0.5) * uBadgeH * 3.0 + tt * 0.12);
      vec2 d = abs(p - pos);
      float s = (0.07 + 0.05 * hash(fi + 3.1)) * sin(tt * 3.14159);
      float cross = max(1.0 - smoothstep(0.0, px * 1.5, d.x) , 1.0 - smoothstep(0.0, px * 1.5, d.y));
      float a = cross * (1.0 - smoothstep(0.0, s, max(d.x, d.y))) + (1.0 - smoothstep(0.0, s * 0.35, length(p - pos)));
      a = clamp(a, 0.0, 1.0);
      col.rgb = mix(col.rgb, vec3(1.0, 0.98, 0.85), a);
      col.a = max(col.a, a);
    }
  }

  col.a *= uAlpha;
  if (col.a < 0.004) discard;
  gl_FragColor = col;
  #include <colorspace_fragment>
}`;

const _p = new THREE.Vector3();

/**
 * Both fighters' meters: state (MeterState) + one clip-space quad each. The renderer calls
 * update() once per frame and prepare(viewer, camera, anchors, aspect) before each viewport draw.
 */
export class HealthMeters {
  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'health-meters';
    this.state = { p1: new MeterState(), p2: new MeterState() };
    this._geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = {};
    this._hidden = false;
    const M = METER_TUNING;
    for (const id of IDS) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uCenter: { value: new THREE.Vector2(0, 0) }, uHalf: { value: new THREE.Vector2(0.1, 0.1) },
          uQuad: { value: new THREE.Vector2(M.quad.x, M.quad.y) }, uBadgeH: { value: M.badgeAspect },
          uValue: { value: 10 }, uBlinkOn: { value: 0 }, uBlink: { value: 1 }, uDark: { value: 0 }, uFlash: { value: 0 },
          uSweep: { value: -1 }, uShardT: { value: -1 }, uShardFrom: { value: 0 }, uShardTo: { value: 0 }, uRingT: { value: -1 },
          uSparkleT: { value: -1 }, uAlpha: { value: 0 }, uTime: { value: 0 },
          uColor: { value: new THREE.Color(PALETTE.meterPlayer) }, uColorHi: { value: new THREE.Color(0xbfd6ff) },
          uDarkCol: { value: new THREE.Color(PALETTE.meterDark) }, uRim: { value: new THREE.Color(PALETTE.meterRim) },
        },
        vertexShader: METER_VERT, fragmentShader: METER_FRAG, transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 995;
      mesh.visible = false;
      mesh.name = `meter-${id}`;
      this.object3d.add(mesh);
      this.mesh[id] = mesh;
    }
    this._own = new THREE.Color(PALETTE.meterPlayer);
    this._ownHi = new THREE.Color(0xbfd6ff);
    this._foe = new THREE.Color(PALETTE.meterOpponent);
    this._foeHi = new THREE.Color(0xffc2b8);
  }

  /** New bout: hide both, full health. */
  reset(hp = { p1: METER_TUNING.cells, p2: METER_TUNING.cells }) {
    this.state.p1.reset(hp.p1);
    this.state.p2.reset(hp.p2);
    for (const id of IDS) this.mesh[id].visible = false;
  }

  /** Force both meters off (intros, round changes, outros, menus). */
  setHidden(on) { this._hidden = !!on; }

  /** A MATCH_HIT landed on `id` (hp in wedges). */
  hit(id, e) { this.state[id]?.hit(e); }
  down(id) { this.state[id]?.down(); }
  rise(id, hp) { this.state[id]?.rise(hp); }
  /** Follow the view's health (wedges) when nothing is animating. */
  observe(id, hp) { this.state[id]?.observe(hp); }

  update(dt) {
    for (const id of IDS) this.state[id].update(dt, this._hidden);
  }

  /**
   * Place and fill both meters for one viewport.
   * @param {'p1'|'p2'} viewer  whose viewport this is (own meter low-left, foe's by the head)
   * @param {THREE.Camera} camera
   * @param {{foeHead: THREE.Vector3, ownAnchor?: THREE.Vector3|null}} anchors  world points
   * @param {number} aspect  viewport width / height
   */
  prepare(viewer, camera, anchors, aspect) {
    const M = METER_TUNING;
    const foe = viewer === 'p1' ? 'p2' : 'p1';
    for (const id of IDS) {
      const st = this.state[id];
      const mesh = this.mesh[id];
      if (!st.visible) { mesh.visible = false; continue; }
      const own = id === viewer;
      const u = mesh.material.uniforms;
      let cx, cy, w;
      if (own) {
        w = M.own.width;
        cx = M.own.x * 2 - 1; cy = 1 - M.own.y * 2;
        if (anchors?.ownAnchor) {
          _p.copy(anchors.ownAnchor).project(camera);
          if (Number.isFinite(_p.x) && _p.z < 1) {
            cx = clamp(_p.x, cx - M.own.slack * 2, cx + M.own.slack * 2);
            cy = clamp(_p.y, cy - M.own.slack * 2, cy + M.own.slack * 2);
          }
        }
      } else {
        w = M.foe.width;
        if (!anchors?.foeHead) { mesh.visible = false; continue; }
        _p.copy(anchors.foeHead).project(camera);
        if (!Number.isFinite(_p.x) || _p.z > 1 || _p.z < -1) { mesh.visible = false; continue; }
        cx = clamp(_p.x + M.foe.dx * 2, M.foe.clampX[0] * 2 - 1, M.foe.clampX[1] * 2 - 1);
        cy = clamp(_p.y - M.foe.dy * 2, 1 - M.foe.clampY[1] * 2, 1 - M.foe.clampY[0] * 2);
      }
      const s = w; // badge half-width in NDC (w of the viewport width is the full badge width → half = w)
      u.uCenter.value.set(cx, cy);
      u.uHalf.value.set(M.quad.x * s, M.quad.y * s * aspect);
      u.uColor.value.copy(own ? this._own : this._foe);
      u.uColorHi.value.copy(own ? this._ownHi : this._foeHi);
      u.uValue.value = st.value;
      u.uBlinkOn.value = st.blinkOn;
      u.uDark.value = st.dark;
      u.uFlash.value = st.flashT >= 0 ? Math.max(0, 1 - st.flashT / M.flashLife) : 0;
      u.uSweep.value = st.sweepHead;
      u.uShardT.value = st.shardT; u.uShardFrom.value = st.shardFrom; u.uShardTo.value = st.shardTo;
      u.uRingT.value = st.ringT;
      u.uSparkleT.value = st.sparkleT;
      u.uAlpha.value = st.alpha;
      u.uTime.value = st.t;
      mesh.visible = true;
      void foe;
    }
  }

  /** Hide both meshes (e.g. while drawing a viewport that should not show them). */
  hideMeshes() { for (const id of IDS) this.mesh[id].visible = false; }

  dispose() {
    this.object3d.removeFromParent();
    this._geo.dispose();
    for (const id of IDS) this.mesh[id].material.dispose();
  }
}
