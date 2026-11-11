// Screen-space overlays drawn inside the 3D pass (owner: view3d):
//   * dodge slow motion (ARCHITECTURE §6.3): an afterimage smear (the previous frame blended over
//     the new one) plus a cool tint and vignette, per viewport channel;
//   * the bout outro's own Glove Up logo wipe (§6 "KO outro, in order") and full-screen fades
//     (white flash / white fade, the dip to the arena between rounds).
// All quads are clip-space triangles in the main scene (one draw each, only when active).
// The smear copies the viewport into a FramebufferTexture right after the smear quad itself is
// drawn (onAfterRender), so the HUD-like overlays drawn later (meters, speed lines) never smear.
// Imports cleanly in Node (canvas textures only when a document exists).

import * as THREE from 'three';
import { PALETTE, FONTS, css } from './style.js';

export const SCREEN_TUNING = Object.freeze({
  smear: 0.62,          // share of the previous frame blended in at full strength
  tint: 0.28,           // tint / vignette strength at full slow motion
});

const CLIP_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SMEAR_FRAG = /* glsl */`
uniform sampler2D uHistory;
uniform vec4 uRect;       // viewport x, y, w, h in drawing-buffer pixels
uniform float uAmount;
void main() {
  vec2 uv = (gl_FragCoord.xy - uRect.xy) / uRect.zw;
  vec4 h = texture2D(uHistory, uv);
  gl_FragColor = vec4(h.rgb, uAmount);
}`;

const TINT_FRAG = /* glsl */`
uniform float uAmount;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 1.41421;
  float vig = smoothstep(0.35, 1.05, r);
  float a = uAmount * (0.35 + 0.65 * vig);
  gl_FragColor = vec4(mix(uTint, vec3(0.08, 0.06, 0.2), vig * 0.6), a);
  #include <colorspace_fragment>
}`;

const FADE_FRAG = /* glsl */`
uniform float uAlpha;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, uAlpha);
  #include <colorspace_fragment>
}`;

const WIPE_FRAG = /* glsl */`
uniform float uProgress;
uniform float uAspect;
uniform sampler2D uLogo;
uniform float uHasLogo;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float x = p.x + p.y * 0.32;
  float c = mix(-3.1, 3.1, uProgress);
  float d = x - c;
  float w = 1.6;
  if (abs(d) > w) discard;
  float e = w - abs(d);
  vec3 col = e < 0.07 ? uC1 : e < 0.13 ? uC2 : e < 0.19 ? uC3 : uC4;
  col += step(0.5, fract((x - c) * 2.5 + p.y * 0.4)) * 0.035 * step(0.19, e);
  if (uHasLogo > 0.5) {
    vec2 lp = vec2(p.x * uAspect / 1.25, p.y / 0.62) * 0.5 + 0.5;
    if (lp.x > 0.0 && lp.x < 1.0 && lp.y > 0.0 && lp.y < 1.0) {
      vec4 L = texture2D(uLogo, lp);
      float vis = 1.0 - smoothstep(0.55, 1.15, abs(c));
      col = mix(col, L.rgb, L.a * vis);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const _vp = new THREE.Vector4();
const _pos = new THREE.Vector2();
const CHANNELS = ['p1', 'p2'];

/** Our own logo for the wipe: a glove emblem on a golden badge + the "GLOVE UP" wordmark. */
function drawLogo(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const cx = H * 0.5, cy = H * 0.5, R = H * 0.4;
  // badge: a rounded 12-point star in gold with a cream rim
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = R * (0.9 + 0.1 * Math.cos(a * 12));
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = css(PALETTE.post); ctx.fill();
  ctx.lineWidth = H * 0.03; ctx.strokeStyle = css(PALETTE.uiPaper); ctx.stroke();
  // glove: mitt + thumb + cuff, coral with a navy outline
  ctx.lineJoin = 'round';
  ctx.lineWidth = H * 0.025; ctx.strokeStyle = css(PALETTE.uiInk);
  ctx.fillStyle = css(PALETTE.ropeA);
  ctx.beginPath(); ctx.ellipse(cx + H * 0.02, cy - H * 0.04, H * 0.2, H * 0.17, -0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx - H * 0.15, cy + H * 0.03, H * 0.07, H * 0.1, -0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = css(PALETTE.uiPaper);
  ctx.beginPath(); ctx.roundRect(cx - H * 0.11, cy + H * 0.1, H * 0.24, H * 0.11, H * 0.04); ctx.fill(); ctx.stroke();
  // wordmark
  ctx.font = `${Math.round(H * 0.3)}px ${FONTS.display}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.lineWidth = H * 0.045; ctx.strokeStyle = css(PALETTE.uiInk);
  ctx.fillStyle = css(PALETTE.uiPaper);
  ctx.strokeText('GLOVE', H * 0.98, H * 0.33); ctx.fillText('GLOVE', H * 0.98, H * 0.33);
  ctx.fillStyle = css(PALETTE.apronText);
  ctx.strokeText('UP!', H * 0.98, H * 0.68); ctx.fillText('UP!', H * 0.98, H * 0.68);
}

export class ScreenFX {
  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'screen-fx';
    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = (mat, order) => {
      const m = new THREE.Mesh(this._geo, mat);
      m.frustumCulled = false; m.renderOrder = order; m.visible = false;
      this.object3d.add(m);
      return m;
    };

    // ── slow-motion smear + tint, per viewport channel ──
    this.slow = {};
    for (const ch of CHANNELS) {
      const smearMat = new THREE.ShaderMaterial({
        uniforms: { uHistory: { value: null }, uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uAmount: { value: 0 } },
        vertexShader: CLIP_VERT, fragmentShader: SMEAR_FRAG, transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false,
      });
      const tintMat = new THREE.ShaderMaterial({
        uniforms: { uAmount: { value: 0 }, uTint: { value: new THREE.Color(PALETTE.slowTint ?? 0x9d8cff) } },
        vertexShader: CLIP_VERT, fragmentShader: TINT_FRAG, transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false,
      });
      const smear = quad(smearMat, 980);
      const tint = quad(tintMat, 981);
      const st = { smear, smearMat, tint, tintMat, strength: 0, tex: null, valid: false, w: 0, h: 0, x: 0, y: 0 };
      smear.onBeforeRender = (renderer) => {
        renderer.getCurrentViewport(_vp);
        const w = Math.max(1, _vp.z | 0), h = Math.max(1, _vp.w | 0);
        if (!st.tex || st.w !== w || st.h !== h) {
          st.tex?.dispose();
          st.tex = new THREE.FramebufferTexture(w, h);
          st.tex.minFilter = THREE.LinearFilter; st.tex.magFilter = THREE.LinearFilter;
          st.w = w; st.h = h; st.valid = false;
        }
        st.x = _vp.x | 0; st.y = _vp.y | 0;
        smearMat.uniforms.uHistory.value = st.tex;
        smearMat.uniforms.uRect.value.set(st.x, st.y, w, h);
        smearMat.uniforms.uAmount.value = st.valid ? SCREEN_TUNING.smear * st.strength : 0;
      };
      smear.onAfterRender = (renderer) => {
        try {
          renderer.copyFramebufferToTexture(st.tex, _pos.set(st.x, st.y));
          st.valid = true;
        } catch { st.valid = false; }
      };
      this.slow[ch] = st;
    }

    // ── the logo wipe ──
    this._logo = null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      try {
        const c = document.createElement('canvas');
        c.width = 1024; c.height = 400;
        drawLogo(c);
        this._logoCanvas = c;
        this._logo = new THREE.CanvasTexture(c);
        this._logo.colorSpace = THREE.SRGBColorSpace;
        if (document.fonts?.load) document.fonts.load(`64px ${FONTS.display.split(',')[0].trim()}`).then(() => { drawLogo(c); this._logo.needsUpdate = true; }).catch(() => {});
      } catch { this._logo = null; }
    }
    this._wipeMat = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 }, uAspect: { value: 16 / 9 }, uLogo: { value: this._logo }, uHasLogo: { value: this._logo ? 1 : 0 },
        uC1: { value: new THREE.Color(PALETTE.ropeA) }, uC2: { value: new THREE.Color(PALETTE.post) },
        uC3: { value: new THREE.Color(PALETTE.ropeC) }, uC4: { value: new THREE.Color(PALETTE.apron) },
      },
      vertexShader: CLIP_VERT, fragmentShader: WIPE_FRAG, transparent: true, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false,
    });
    this.wipe = quad(this._wipeMat, 1010);
    this.wipe.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_vp);
      this._wipeMat.uniforms.uAspect.value = _vp.w > 0 ? _vp.z / _vp.w : 16 / 9;
    };

    // ── full-screen fade (white flash / white fade / navy dip) ──
    this._fadeMat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: CLIP_VERT, fragmentShader: FADE_FRAG, transparent: true, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false,
    });
    this.fade = quad(this._fadeMat, 1020);
    this._fadeDecay = 0;
    this._channel = 'p1';
  }

  /** Slow-motion look for one viewport channel (0..1). 0 turns it off (and drops the history). */
  setSlow(channel, strength) {
    const st = this.slow[channel === 'p2' ? 'p2' : 'p1'];
    const k = Math.max(0, Math.min(1, strength || 0));
    st.strength = k;
    if (k <= 0.001) st.valid = false;
  }

  /** The logo wipe: progress 0..1 (0 and 1 = off screen). */
  setWipe(progress) {
    const p = Number.isFinite(progress) ? progress : 0;
    this._wipeMat.uniforms.uProgress.value = p;
    this.wipe.visible = p > 0.001 && p < 0.999;
  }

  /** Full-screen colour overlay (alpha 0..1). `decayPerSec` > 0 fades it out by itself. */
  setFade(alpha, color = 0xffffff, decayPerSec = 0) {
    this._fadeMat.uniforms.uAlpha.value = Math.max(0, Math.min(1, alpha || 0));
    this._fadeMat.uniforms.uColor.value.set(color);
    this._fadeDecay = decayPerSec;
    this.fade.visible = this._fadeMat.uniforms.uAlpha.value > 0.002;
  }

  get fadeAlpha() { return this._fadeMat.uniforms.uAlpha.value; }

  update(realDt) {
    if (this._fadeDecay > 0 && this.fade.visible) {
      const u = this._fadeMat.uniforms.uAlpha;
      u.value = Math.max(0, u.value - this._fadeDecay * Math.max(0, Math.min(0.1, realDt || 0)));
      if (u.value <= 0.002) { this.fade.visible = false; this._fadeDecay = 0; }
    }
  }

  /** Call before drawing a viewport: only that channel's slow-motion layers are shown. */
  setChannel(channel) {
    this._channel = channel === 'p2' ? 'p2' : 'p1';
    for (const ch of CHANNELS) {
      const st = this.slow[ch];
      const on = ch === this._channel && st.strength > 0.001;
      st.smear.visible = on;
      st.tint.visible = on;
      st.tintMat.uniforms.uAmount.value = SCREEN_TUNING.tint * st.strength;
    }
  }

  clear() {
    for (const ch of CHANNELS) this.setSlow(ch, 0);
    this.setWipe(0);
    this.setFade(0);
    this.setChannel(this._channel);
  }

  dispose() {
    this.object3d.removeFromParent();
    this._geo.dispose();
    for (const ch of CHANNELS) { const st = this.slow[ch]; st.smearMat.dispose(); st.tintMat.dispose(); st.tex?.dispose(); }
    this._wipeMat.dispose(); this._fadeMat.dispose(); this._logo?.dispose();
  }
}
