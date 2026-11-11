// Dev viewer for the boxer models (owner: characters). Open /dev/models.html.
//
// URL parameters (all optional):
//   phase=<BoxerPhase>     show that state (idle, guard, windup, punch, recover, dodge, hitstun,
//                          dazed, down, getup, ko, victory, defeat) — frozen for screenshots
//   progress=0..1          where in that phase to freeze (phaseProgress)
//   t=<seconds>            alternatively: freeze this many seconds into the scripted animation
//   kind=straight|hook|uppercut  target=head|body  hand=left|right   (punch / windup / hitstun)
//   blocked=1  strength=0..1.2  (hitstun)      guard=high|low      lx= ly= lz=  (lean, −1..1)
//   fall=back|knees        (down / getup / ko)
//   preset=<n>             subject look (PRESETS index); seed=<n> for a random look
//   expr=<expression>      force an expression        ghost=1   P1 (the player's boxer) translucent
//   cam=front|side|behind|play|3q|close|top   subject=p1|p2 (default p2, the opponent)
//   foe=0|1                show the other boxer       human=1 (hands-driven)
//   role=trainer   gesture=throw     phase=taunt (AI taunting)     fall=front (face-down knockdown)
//   lineup=1&from=0&count=8   all presets side by side      faces=1  all expressions for one look
//   facetex=1  raw face textures       portraits=1  2D portraits       ui=0  hide the panel
// Buttons in the panel play every animation live.

import * as THREE from 'three';
import { BoxerModel, placeBoxer, gloveWorldPosition, headWorldPosition } from '../src/render/boxer-model.js';
import { PRESETS, DEFAULT_PLAYER, TRAINER, randomAppearance } from '../src/render/appearance.js';
import { drawPortrait, paintFaceTexture, EXPRESSIONS, FACE_TEX_SIZE } from '../src/render/face.js';
import { LAYOUT, LIGHTING, CAMERA, PALETTE, css } from '../src/render/style.js';
import { RIG_TUNING } from '../src/render/camera-rig.js';

const Q = new URLSearchParams(location.search);
const P = (k, d) => (Q.has(k) ? Q.get(k) : d);
const PN = (k, d) => (Q.has(k) && Q.get(k) !== '' && Number.isFinite(+Q.get(k)) ? +Q.get(k) : d);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ───────────────────────────── scene ─────────────────────────────

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = LIGHTING.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
{
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, css(PALETTE.skyTop));
  grad.addColorStop(1, css(PALETTE.skyBottom));
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}
scene.add(new THREE.HemisphereLight(LIGHTING.hemiSky, LIGHTING.hemiGround, LIGHTING.hemiIntensity));
const key = new THREE.DirectionalLight(LIGHTING.keyColor, LIGHTING.keyIntensity);
key.position.fromArray(LIGHTING.keyPos);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(LIGHTING.rimColor, LIGHTING.rimIntensity);
rim.position.fromArray(LIGHTING.rimPos);
scene.add(rim);

// simple ring floor for context (the real ring is render/arena.js)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.002; floor.receiveShadow = true;
scene.add(floor);
const mat = new THREE.Mesh(new THREE.PlaneGeometry(LAYOUT.ringHalf * 2, LAYOUT.ringHalf * 2), new THREE.MeshStandardMaterial({ color: PALETTE.canvas, roughness: 0.85 }));
mat.rotation.x = -Math.PI / 2; mat.receiveShadow = true;
scene.add(mat);
const medal = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 64), new THREE.MeshStandardMaterial({ color: PALETTE.canvasLogo, roughness: 0.8 }));
medal.rotation.x = -Math.PI / 2; medal.position.y = 0.001; medal.receiveShadow = true;
scene.add(medal);

const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 80);

// ───────────────────────────── models ─────────────────────────────

const role = P('role', 'boxer');
const subjectId = P('subject', 'p2');
const presetIdx = clamp(PN('preset', 3) | 0, 0, PRESETS.length - 1);
const subjectLook = Q.has('seed') ? randomAppearance(P('seed')) : role === 'trainer' ? TRAINER : PRESETS[presetIdx];
// the other boxer: DEFAULT_PLAYER unless ?other=<preset index>
const otherLook = Q.has('other') ? PRESETS[clamp(PN('other', 0) | 0, 0, PRESETS.length - 1)] : DEFAULT_PLAYER;
const models = [];
let subject = null, foe = null;

function makeModel(look, opts) {
  const m = new BoxerModel(look, opts);
  scene.add(m.object3d);
  models.push(m);
  return m;
}

const lineup = Q.has('lineup');
const facesSheet = Q.has('faces');
if (lineup) {
  const from = PN('from', 0) | 0, count = PN('count', 8) | 0;
  const list = [...PRESETS.map((p) => ({ look: p, role: 'boxer' })), { look: TRAINER, role: 'trainer' }].slice(from, from + count);
  const gap = 0.78;
  list.forEach((e, i) => {
    const m = makeModel(e.look, { role: e.role, seed: i * 7 + 1 });
    m.object3d.position.set((i - (list.length - 1) / 2) * gap, 0, 0);
    if (P('expr')) m.setExpression(P('expr'));
  });
} else if (facesSheet) {
  const exprs = [...EXPRESSIONS];
  exprs.forEach((e, i) => {
    const m = makeModel(subjectLook, { role, seed: i + 3 });
    m.object3d.position.set((i - (exprs.length - 1) / 2) * 0.6, 0, 0);
    m.setExpression(e);
  });
} else {
  subject = makeModel(subjectLook, { role, seed: 11 });
  if (role === 'boxer') {
    foe = makeModel(otherLook, { seed: 5 });
    // subject = the one we animate; P1 is the player's boxer (ghost-able)
    const p1 = subjectId === 'p1' ? subject : foe;
    const p2 = subjectId === 'p1' ? foe : subject;
    placeBoxer(p1, 'p1');
    placeBoxer(p2, 'p2');
    p1.setGhost(P('ghost') === '1');
    subject.setFoe(foe); foe.setFoe(subject);
  } else {
    placeBoxer(subject, 'p2');
    if (role === 'trainer') attachMitts(subject);
  }
  if (P('expr')) subject.setExpression(P('expr'));
}

/** Simple focus mitts on the trainer's hand anchors (proves the anchor API). */
function attachMitts(m) {
  const padGeo = new THREE.CylinderGeometry(0.1, 0.11, 0.06, 28);
  padGeo.rotateX(Math.PI / 2);
  const pad = new THREE.MeshStandardMaterial({ color: PALETTE.turnbuckleP2, roughness: 0.4 });
  const ring = new THREE.MeshStandardMaterial({ color: 0xf7f3ea, roughness: 0.5 });
  for (const h of ['left', 'right']) {
    const g = new THREE.Group();
    const a = new THREE.Mesh(padGeo, pad); a.position.z = 0.035; a.castShadow = true;
    const b = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 24), ring); b.position.z = 0.068;
    g.add(a, b);
    m.handAnchor(h).add(g);
  }
}

// ───────────────────────────── scripted views ─────────────────────────────

const DUR = { lead: 0.45, windup: 0.45, punch: 0.17, recover: 0.3, tail: 0.65, hitstun: 0.42, getup: 1.25 };

function view(extra = {}) {
  return {
    id: subjectId, name: 'Subject', isHuman: P('human') === '1', appearance: null, phase: 'idle', phaseProgress: 0, hp01: 1,
    stamina01: 1, guard: 'none', lean: { x: 0, y: 0, z: 0 }, hands: null, punch: null, hitReact: null, knockdowns: 0,
    roundKnockdowns: 0, counterReady: false, expression: 'neutral', ...extra,
  };
}

/** A script maps time → BoxerView for the subject (and optionally the foe). */
function segmented(name, segs, build, opts = {}) {
  const last = segs[segs.length - 1];
  const length = (last ? last.start + last.dur : 0) + (opts.tail ?? DUR.tail);
  return {
    name, segs, length, loop: opts.loop !== false,
    view(t) {
      let seg = null;
      for (const s of segs) if (t >= s.start && t < s.start + s.dur) seg = s;
      if (!seg && last && t >= last.start + last.dur && opts.hold) seg = last;
      const phase = seg ? seg.phase : 'idle';
      const p = seg ? clamp((t - seg.start) / seg.dur, 0, 1) : 0;
      return build(phase, p, t, seg);
    },
    foeView: opts.foeView,
  };
}

function punchScript(hand, kind, target, ai = true) {
  const segs = [];
  let t = DUR.lead;
  if (ai) { segs.push({ phase: 'windup', start: t, dur: DUR.windup }); t += DUR.windup; }
  segs.push({ phase: 'punch', start: t, dur: DUR.punch }); t += DUR.punch;
  segs.push({ phase: 'recover', start: t, dur: DUR.recover });
  const impactT = segs.find((s) => s.phase === 'punch').start + DUR.punch * 0.88;
  return segmented(`${hand} ${kind} → ${target}`, segs, (phase, p) => view({
    phase, phaseProgress: p,
    punch: phase === 'idle' ? null : { hand, kind, target, progress: phase === 'punch' ? p : phase === 'recover' ? 1 : 0, impact: phase === 'punch' && p >= 0.88 },
  }), { foeView: (t) => hitView(t - impactT, other(hand), kind, target, P('blocked') === '1', 0.8) });
}

function comboScript() {
  // jab – cross – left hook (no windups, like a human), each hand recovers on its own
  const steps = [['left', 'straight', 'head'], ['right', 'straight', 'head'], ['left', 'hook', 'head'], ['right', 'uppercut', 'body']];
  const segs = [];
  let t = DUR.lead;
  for (const [hand, kind, target] of steps) {
    segs.push({ phase: 'punch', start: t, dur: DUR.punch, hand, kind, target }); t += DUR.punch;
    segs.push({ phase: 'recover', start: t, dur: 0.14, hand, kind, target }); t += 0.2;
  }
  return segmented('combo', segs, (phase, p, _t, seg) => view({
    phase, phaseProgress: p,
    punch: seg ? { hand: seg.hand, kind: seg.kind, target: seg.target, progress: phase === 'punch' ? p : 1, impact: phase === 'punch' && p > 0.88 } : null,
  }), { tail: 0.8 });
}

const other = (h) => (h === 'left' ? 'right' : 'left');

function hitView(age, hand, kind, target, blocked, strength) {
  const hit = age >= 0 && age < 1.5;
  return view({
    id: 'foe',
    phase: hit && !blocked && age < DUR.hitstun ? 'hitstun' : blocked ? 'guard' : 'idle',
    phaseProgress: hit ? clamp(age / DUR.hitstun, 0, 1) : 0,
    guard: blocked ? (target === 'body' ? 'low' : 'high') : 'none',
    hitReact: hit ? { hand, kind, target, strength, age, blocked } : null,
    isHuman: false,
  });
}

function hitScript(hand, kind, target, blocked, strength = 0.85) {
  const t0 = 0.5;
  return segmented(`hit ${kind} ${target}${blocked ? ' (blocked)' : ''}`, [{ phase: blocked ? 'guard' : 'hitstun', start: t0, dur: DUR.hitstun }],
    (phase, p, t) => {
      const v = hitView(t - t0, hand, kind, target, blocked, strength);
      if (blocked) v.guard = target === 'body' ? 'low' : 'high';
      v.phaseProgress = p;
      return v;
    }, { tail: 0.9 });
}

function holdScript(phase, extra = {}, dur = 6) {
  return segmented(phase, [{ phase, start: 0.25, dur }], (ph, p, t) => view({ phase: ph, phaseProgress: p, ...extra, ...(typeof extra.fn === 'function' ? extra.fn(t) : {}) }), { tail: 0.3 });
}

function downScript(style = 'back', ko = false) {
  // 'front' = the player's own face-down knockdown (BoxerModel.setFallStyle)
  if (subject) subject.setFallStyle?.(style === 'front' ? 'front' : null);
  const tHit = 0.35, tDown = tHit + 0.12, downDur = ko ? 1.6 : 3.4;
  const segs = [{ phase: 'hitstun', start: tHit, dur: tDown - tHit }, { phase: 'down', start: tDown, dur: downDur }];
  if (ko) segs.push({ phase: 'ko', start: tDown + downDur, dur: 6 });
  else segs.push({ phase: 'getup', start: tDown + downDur, dur: DUR.getup });
  const target = style === 'knees' ? 'body' : 'head';
  return segmented(ko ? 'knockout' : `knockdown (${style}) + get up`, segs, (phase, p, t) => view({
    phase, phaseProgress: p, hp01: phase === 'getup' ? 0.3 : 0.05,
    hitReact: t >= tHit ? { hand: 'right', kind: style === 'knees' ? 'hook' : 'uppercut', target, strength: 1.1, age: t - tHit, blocked: false } : null,
  }), { tail: 1.2, loop: !ko, hold: ko });
}

function leanScript(kind) {
  return segmented(`lean ${kind}`, [{ phase: 'dodge', start: 0, dur: 4 }], (phase, p, t) => {
    const w = Math.sin(t * 2.4);
    const lean = kind === 'duck' ? { x: 0, y: -Math.max(0, w), z: 0 } : kind === 'side' ? { x: w, y: 0, z: 0 } : { x: 0, y: 0, z: w };
    return view({ phase: Math.abs(w) > 0.3 ? 'dodge' : 'idle', lean, guard: 'none' });
  }, { tail: 0 });
}

function humanScript() {
  // hands-driven like a camera player: guard up, jab with the real reach, drop hands, guard low
  return segmented('human hands', [{ phase: 'idle', start: 0, dur: 6 }], (phase, p, t) => {
    const k = (t % 6);
    const jab = k > 1.2 && k < 1.6 ? Math.sin(((k - 1.2) / 0.4) * Math.PI) : 0;
    const cross = k > 2.2 && k < 2.6 ? Math.sin(((k - 2.2) / 0.4) * Math.PI) : 0;
    const drop = k > 3.2 && k < 4.4 ? Math.sin(((k - 3.2) / 1.2) * Math.PI) : 0;
    const low = k > 4.6 && k < 5.8;
    const hand = (x, y, r) => ({ x, y, reach: r, punching: r > 0.6 });
    return view({
      isHuman: true, phase: low ? 'guard' : 'idle', guard: low ? 'low' : k < 1 ? 'high' : 'none',
      hands: {
        left: hand(-0.3 + jab * 0.2, 0.45 - drop * 1.6 - (low ? 0.9 : 0), jab),
        right: hand(0.32 - cross * 0.25, 0.4 - drop * 1.7 - (low ? 0.9 : 0), cross),
      },
      punch: jab > 0.2 ? { hand: 'left', kind: 'straight', target: 'head', progress: Math.min(1, jab * 1.2), impact: false }
        : cross > 0.2 ? { hand: 'right', kind: 'straight', target: 'head', progress: Math.min(1, cross * 1.2), impact: false } : null,
      lean: { x: Math.sin(t * 0.9) * 0.25, y: 0, z: 0 },
    });
  }, { tail: 0 });
}

/** Map URL ?phase= to a script; also returns the default freeze time. */
function scriptForPhase(phase) {
  const hand = P('hand', 'right'), kind = P('kind', 'straight'), target = P('target', 'head');
  const fall = P('fall', 'back');
  const lean = { x: PN('lx', 0), y: PN('ly', 0), z: PN('lz', 0) };
  switch (phase) {
    case 'windup': case 'punch': case 'recover': return punchScript(hand, kind, target, P('ai', '1') !== '0' || phase === 'windup');
    case 'hitstun': return hitScript(P('hand', 'left'), kind, target, P('blocked') === '1', PN('strength', 0.85));
    case 'dazed': return holdScript('dazed', { guard: 'none' });
    case 'down': case 'getup': return downScript(fall, false);
    case 'ko': return downScript(fall, true);
    case 'victory': return holdScript('victory', { expression: 'happy' });
    case 'defeat': return holdScript('defeat', { expression: 'sad' });
    case 'guard': return holdScript('guard', { guard: P('guard', 'high') });
    case 'taunt': return holdScript('idle', { taunting: true, expression: 'happy' });
    case 'dodge': return holdScript('dodge', { lean });
    case 'combo': return comboScript();
    case 'human': return humanScript();
    default: return holdScript(phase || 'idle', { guard: P('guard', 'none'), lean });
  }
}

// ───────────────────────────── staff gestures ─────────────────────────────

function staffScript(gesture) {
  let last = -1;
  return {
    name: `${role} ${gesture}`, segs: [], length: 2.6, loop: true,
    view: () => null,
    tick(t) {
      if (t > 0.3 && last < 0) {
        last = 1;
        if (gesture === 'throw') subject.trainerThrow('right');
      }
    },
    reset() { last = -1; },
  };
}

// ───────────────────────────── camera ─────────────────────────────

function aimCamera(mode) {
  const W = innerWidth, H = innerHeight;
  camera.aspect = W / H;
  camera.fov = CAMERA.fov;
  if (lineup) {
    const n = models.length;
    const width = n * 0.78 + 0.6;
    const dist = Math.max(3.2, (width / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.aspect + 0.4);
    if (mode === '3q') camera.position.set(dist * 0.35, 1.25, dist * 0.95); else camera.position.set(0, 1.05, dist);
    camera.lookAt(0, 0.8, 0);
  } else if (facesSheet) {
    camera.fov = 30;
    camera.position.set(0, 1.36, 4.3 / Math.max(0.6, camera.aspect / 1.6));
    camera.lookAt(0, 1.22, 0);
  } else {
    const s = subject.object3d.position;
    const facing = subject.object3d.rotation.y === 0 ? 1 : -1; // +1 → faces +Z
    const p1 = LAYOUT.p1Pos;
    switch (mode) {
      case 'behind': case 'play': {
        // 'behind' = style.CAMERA.overShoulder; 'play' = the in-game live camera (render/camera-rig.js
        // RIG_TUNING.play, [right, up, back] / [right, up, forward] in P1's frame → P1 faces −Z, right = +X)
        const R = RIG_TUNING.play;
        const o = mode === 'play' ? { offset: [R.offset[0], R.offset[1], R.offset[2]], lookAt: [R.lookAt[0], R.lookAt[1], -R.lookAt[2]] } : CAMERA.overShoulder;
        if (mode === 'play') camera.fov = R.fov;
        camera.position.set(p1[0] + o.offset[0], p1[1] + o.offset[1], p1[2] + o.offset[2]);
        camera.lookAt(p1[0] + o.lookAt[0], p1[1] + o.lookAt[1], p1[2] + o.lookAt[2]);
        break;
      }
      case 'side':
        camera.position.set(3.1, 1.05, 0);
        camera.lookAt(0, 0.85, 0);
        break;
      case '3q':
        camera.position.set(s.x + 1.7, 1.35, s.z + facing * 2.2);
        camera.lookAt(s.x, 0.9, s.z);
        break;
      case 'close':
        camera.position.set(s.x + 0.25, 1.42, s.z + facing * 1.05);
        camera.lookAt(s.x, 1.3, s.z);
        break;
      case 'top':
        camera.position.set(s.x + 0.4, 3.4, s.z + facing * 1.6);
        camera.lookAt(s.x, 0.3, s.z + facing * 0.2);
        break;
      default: // front
        camera.position.set(s.x, 1.12, s.z + facing * 2.75);
        camera.lookAt(s.x, 0.88, s.z);
    }
  }
  camera.updateProjectionMatrix();
  renderer.setSize(W, H, false);
}

// ───────────────────────────── run / freeze ─────────────────────────────

let camMode = P('cam', 'front');
let script = null;
let scriptT = 0;
let frozen = false;
const statusEl = document.getElementById('status');

function foeVisible() {
  if (!foe) return;
  const want = P('foe');
  foe.object3d.visible = want != null ? want === '1' : camMode !== 'front' && camMode !== 'close' && camMode !== '3q';
}

function stepAll(dt) {
  if (script && subject) {
    if (script.tick) script.tick(scriptT);
    subject.update(script.view(scriptT), dt);
    if (foe) foe.update(script.foeView ? script.foeView(scriptT) : view({ id: 'foe', isHuman: P('ghost') === '1' }), dt);
  } else {
    // lineup / expression sheet: relaxed low guard so faces stay visible
    const v = facesSheet ? view({ guard: 'low' }) : null;
    for (const m of models) m.update(v, dt);
  }
}

function setScript(s) {
  script = s;
  scriptT = 0;
  if (s && s.reset) s.reset();
  frozen = false;
}

/** Deterministically simulate the current script up to time t and freeze there. */
function freezeAt(t) {
  scriptT = 0;
  const dt = 1 / 60;
  const steps = Math.max(1, Math.round(t / dt));
  for (let i = 0; i < steps; i++) { stepAll(dt); scriptT += dt; }
  frozen = true;
  renderOnce();
}

function renderOnce() {
  foeVisible();
  aimCamera(camMode);
  renderer.render(scene, camera);
  const sv = script && subject ? script.view(scriptT) : null;
  statusEl.textContent = `${script ? script.name : lineup ? 'lineup' : facesSheet ? 'expressions' : 'idle'}  ·  t=${scriptT.toFixed(2)}s` +
    (sv ? `  ·  phase=${sv.phase} p=${(sv.phaseProgress ?? 0).toFixed(2)}` : '') + (frozen ? '  ·  frozen' : '');
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!frozen) {
    stepAll(dt);
    scriptT += dt;
    if (script && script.loop && scriptT > script.length) { scriptT = 0; if (script.reset) script.reset(); }
    renderOnce();
  }
  requestAnimationFrame(loop);
}

// initial state from the URL
if (!lineup && !facesSheet && subject) {
  if (role !== 'boxer') {
    setScript(staffScript(P('gesture', 'throw')));
    if (Q.has('t')) freezeAt(PN('t', 0.5));
  } else if (Q.has('phase')) {
    const ph = P('phase');
    setScript(scriptForPhase(ph));
    let t = Q.has('t') ? PN('t', 1) : null;
    if (t == null && Q.has('progress')) {
      const seg = script.segs.find((s) => s.phase === ph) ?? script.segs[0];
      t = seg ? seg.start + clamp(PN('progress', 0.5), 0, 0.999) * seg.dur : 1;
    }
    if (t == null) t = { down: 2.2, ko: 4.5, getup: 4.4, victory: 1.0, defeat: 1.5, dazed: 1.3, hitstun: 0.62 }[ph] ?? 1.2;
    freezeAt(t);
  } else {
    setScript(scriptForPhase('idle'));
  }
} else if (Q.has('t')) {
  freezeAt(PN('t', 1));
}
requestAnimationFrame(loop);
addEventListener('resize', renderOnce);

// ───────────────────────────── extra 2D panels ─────────────────────────────

const extra = document.getElementById('extra');
if (Q.has('facetex')) {
  for (const e of [...EXPRESSIONS, 'neutral-blink']) {
    const c = document.createElement('canvas');
    c.width = c.height = FACE_TEX_SIZE;
    paintFaceTexture(c.getContext('2d'), subjectLook, e, FACE_TEX_SIZE);
    const f = document.createElement('figure');
    f.append(c, Object.assign(document.createElement('figcaption'), { textContent: e }));
    extra.append(f);
  }
}
if (Q.has('portraits')) {
  PRESETS.forEach((p, i) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    drawPortrait(c.getContext('2d'), p, { size: 256, expression: P('expr', 'neutral') });
    const f = document.createElement('figure');
    f.append(c, Object.assign(document.createElement('figcaption'), { textContent: `${i} ${p.label}` }));
    extra.append(f);
  });
}

// ───────────────────────────── control panel ─────────────────────────────

const panel = document.getElementById('panel');
if (P('ui') === '0') panel.classList.add('hidden');
function group(title, buttons) {
  const h = document.createElement('h2');
  h.textContent = title;
  panel.append(h);
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { fn(); renderOnce(); };
    panel.append(b);
  }
}
const nav = (patch) => {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) (v == null ? q.delete(k) : q.set(k, v));
  location.search = q.toString();
};
if (subject && role === 'boxer' && !lineup && !facesSheet) {
  group('Stance', [['Idle', () => setScript(scriptForPhase('idle'))], ['Guard high', () => setScript(holdScript('guard', { guard: 'high' }))],
    ['Taunt', () => setScript(scriptForPhase('taunt'))],
    ['Guard low', () => setScript(holdScript('guard', { guard: 'low' }))], ['Human hands', () => setScript(humanScript())], ['Combo', () => setScript(comboScript())]]);
  const pb = [];
  for (const kind of ['straight', 'hook', 'uppercut']) for (const target of ['head', 'body']) for (const hand of ['left', 'right']) {
    pb.push([`${hand[0].toUpperCase()} ${kind}${target === 'body' ? ' body' : ''}`, () => setScript(punchScript(hand, kind, target, P('ai', '1') !== '0'))]);
  }
  group('Punches (AI windup first; ai=0 → none)', pb);
  group('Hit reactions', [['Jab', () => setScript(hitScript('left', 'straight', 'head', false, 0.6))], ['Cross', () => setScript(hitScript('right', 'straight', 'head', false, 1))],
    ['Hook from L', () => setScript(hitScript('left', 'hook', 'head', false, 1))], ['Hook from R', () => setScript(hitScript('right', 'hook', 'head', false, 1))],
    ['Uppercut', () => setScript(hitScript('right', 'uppercut', 'head', false, 1))], ['Body', () => setScript(hitScript('left', 'hook', 'body', false, 1))],
    ['Blocked', () => setScript(hitScript('right', 'straight', 'head', true, 1))]]);
  group('States', [['Dazed', () => setScript(holdScript('dazed'))], ['Down (back) + up', () => setScript(downScript('back'))],
    ['Down (knees) + up', () => setScript(downScript('knees'))], ['Down (face-down) + up', () => setScript(downScript('front'))],
    ['KO', () => setScript(downScript('back', true))], ['KO from knees', () => setScript(downScript('knees', true))],
    ['Victory', () => setScript(holdScript('victory', { expression: 'happy' }))], ['Defeat', () => setScript(holdScript('defeat', { expression: 'sad' }))]]);
  group('Dodges', [['Slip L/R', () => setScript(leanScript('side'))], ['Duck', () => setScript(leanScript('duck'))], ['Fwd/back', () => setScript(leanScript('fwd'))]]);
}
if (subject && role !== 'boxer') {
  group('Trainer', [['Throw', () => setScript(staffScript('throw'))], ['Mitts idle', () => setScript(null)]]);
}
group('Camera', ['front', 'side', 'behind', 'play', '3q', 'close', 'top'].map((c) => [c, () => { camMode = c; }]));
group('Look', [
  ['◀ preset', () => nav({ preset: (presetIdx + PRESETS.length - 1) % PRESETS.length, seed: null })],
  ['preset ▶', () => nav({ preset: (presetIdx + 1) % PRESETS.length, seed: null })],
  ['random', () => nav({ seed: Math.floor(Math.random() * 1e6) })],
  ['ghost P1', () => { const p1 = models.find((m) => m.object3d.position.z > 0); if (p1) p1.setGhost(!p1.ghost); }],
  ['lineup', () => nav({ lineup: 1, phase: null })], ['faces', () => nav({ faces: 1, phase: null })],
  ['trainer', () => nav({ role: 'trainer', phase: null })], ['boxer', () => nav({ role: null })],
]);
{
  const sel = document.createElement('select');
  for (const e of ['(auto)', ...EXPRESSIONS]) sel.append(new Option(e, e));
  sel.onchange = () => { for (const m of models) m.setExpression(sel.value === '(auto)' ? null : sel.value); renderOnce(); };
  const h = document.createElement('h2'); h.textContent = 'Expression';
  panel.append(h, sel);
}

// debug hook for screenshots / console poking
window.__models = { THREE, scene, camera, renderer, models, get subject() { return subject; }, get foe() { return foe; }, setScript, freezeAt, renderOnce,
  scripts: { punchScript, hitScript, holdScript, downScript, leanScript, humanScript, comboScript, scriptForPhase },
  gloveWorldPosition, headWorldPosition, setCam: (c) => { camMode = c; renderOnce(); } };
