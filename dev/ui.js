// UI lab: render any screen or HUD state with mock data (no camera, no game needed).
//   /dev/ui.html                         → index of everything
//   /dev/ui.html?screen=<id>[&…]         → one screen (see SCREEN_PARAMS below for extras)
//   /dev/ui.html?hud=<state>             → live | round | final | fight | down | count | player-down | ko | time | decision |
//                                          replay | win | tutorial (&step=…&keyboard=1&auto=1) | versus | versus-count | training |
//                                          legacy-count | legacy-fighting   (&freeze=<ms> pauses every animation for screenshots)
//   &players=2  &cam=clip  &empty=1  &broken=1  &reduced=1  &flow=1
// window.__ui = { ui, storage, bus, input, emit } for scripted screenshots.

import { EventBus } from '../src/core/events.js';
import { Ev, ResultMethod } from '../src/core/types.js';
import { Storage } from '../src/core/storage.js';
import { UI, SCREEN_IDS } from '../src/ui/ui.js';
import { drawPortrait2D } from '../src/ui/screens/portrait.js';
import { randomLook } from '../src/ui/screens/kit.js';

const q = new URLSearchParams(location.search);
const has = (k) => q.has(k) && q.get(k) !== '0';

// ───────────────────────────── optional real modules ─────────────────────────────
const optional = async (path) => { try { return await import(/* @vite-ignore */ path); } catch { return null; } };
const [synthMod, rosterMod] = await Promise.all([optional('../src/input/synthetic.js'), optional('../src/game/roster.js')]);
const ROSTER = rosterMod?.ROSTER || [];

// ───────────────────────────── mock storage ─────────────────────────────
function memoryBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (has('broken')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
  };
}
const backend = memoryBackend();
const storage = new Storage({ backend });
let seeded = [];
if (!has('empty')) {
  const mk = (name, look) => storage.createProfile({ name, appearance: look }).profile;
  const sam = mk('Sam', { skin: '#d9a07a', hair: { style: 'curly', color: '#1d1a19' }, eyes: 'oval', brows: 'arched', mouth: 'grin', nose: 'button', accessory: 'headband', top: '#3d7bff', trunks: '#1f3b73', trim: '#ffd166', gloves: '#ff4d5e', shoes: '#f7f3ea', build: 'average', height: 1 });
  const ana = mk('Ana', { skin: '#f6d7c3', hair: { style: 'ponytail', color: '#b8432f' }, eyes: 'happy', brows: 'flat', mouth: 'smile', nose: 'round', accessory: 'none', top: '#2bb3a3', trunks: '#14182b', trim: '#ffc94a', gloves: '#ffc94a', shoes: '#14182b', build: 'slim', height: 0.96 });
  const bo = mk('Bo', { skin: '#8d5a3b', hair: { style: 'afro', color: '#1d1a19' }, eyes: 'wide', brows: 'thick', mouth: 'open', nose: 'round', accessory: 'beard', top: 'none', trunks: '#ff6b5a', trim: '#f7f3ea', gloves: '#3d7bff', shoes: '#ff6b5a', build: 'heavy', height: 1.05 });
  // Sam: a history climbing past Pro
  let skill = 0;
  const steps = [62, 55, -20, 71, 64, 80, -35, 90, 77, 102, 88, -40, 120, 95, 110, 98, 76, -30, 85, 100];
  steps.forEach((d, i) => {
    skill = Math.max(0, skill + d);
    const opp = ROSTER[Math.min(ROSTER.length - 1, Math.floor(i / 2))] || { id: `opp${i}`, name: `Rival ${i + 1}` };
    storage.recordMatch(sam.id, { id: `seed-${i}`, winner: d > 0 ? 'p1' : 'p2', method: d > 90 ? ResultMethod.KO : ResultMethod.DECISION, mode: 'single', endRound: 1 + (i % 3), opponentId: opp.id },
      { skill, pro: skill > 1000 }, { opponentName: opp.name });
  });
  storage.recordMatch(sam.id, { id: 'seed-v1', winner: 'p1', method: 'KO', mode: 'versus', endRound: 2 }, null);
  storage.recordTraining(sam.id, { id: 'st1', kind: 'bag', score: 1840, medal: 'gold' });
  storage.recordTraining(sam.id, { id: 'st2', kind: 'dodge', score: 31, medal: 'silver' });
  storage.recordTraining(ana.id, { id: 'at1', kind: 'mitts', score: 920, medal: 'bronze' });
  storage.recordMatch(ana.id, { id: 'a1', winner: 'p1', method: 'decision', mode: 'single', endRound: 3, opponentId: ROSTER[0]?.id }, { skill: 420 });
  storage.recordMatch(bo.id, { id: 'b1', winner: 'p2', method: 'KO', mode: 'single', endRound: 1, opponentId: ROSTER[0]?.id }, { skill: 60 });
  storage.saveSettings({ lastProfileId: sam.id });
  seeded = [storage.getProfile(sam.id), storage.getProfile(ana.id), storage.getProfile(bo.id)];
}
const [SAM, ANA, BO] = seeded;

// ───────────────────────────── fake camera + synthetic poses ─────────────────────────────
const players = q.get('players') === '2' ? 2 : 1;
const synth = synthMod?.makeSyntheticPlayer
  ? [0, 1].map((i) => synthMod.makeSyntheticPlayer({ seed: 11 + i, noise: 0, lateral: players === 2 ? (i === 0 ? -0.55 : 0.55) : 0, distance: players === 2 ? 2.6 : 2.1 }))
  : null;
let poseAction = q.get('pose') || 'guard-high';
const missing = new Set((q.get('missing') || '').split(',').filter(Boolean).map(Number));
const t0 = performance.now();
let frame = null;
function makeFrame(now) {
  const t = now - t0;
  const ps = [];
  for (let i = 0; i < players; i++) {
    if (missing.has(i)) { ps.push(null); continue; }
    ps.push(synth ? synth[i].pose(t + i * 333, poseAction) : null);
  }
  return { t: now, width: 640, height: 480, players: ps };
}

// a painted "webcam" picture (room + people shapes from the synthetic landmarks)
const camCanvas = document.createElement('canvas');
camCanvas.width = 640;
camCanvas.height = 480;
const camCtx = camCanvas.getContext('2d');
Object.defineProperties(camCanvas, { readyState: { value: 4 }, videoWidth: { value: 640 }, videoHeight: { value: 480 } });
function paintCam(f) {
  const c = camCtx;
  const g = c.createLinearGradient(0, 0, 0, 480);
  g.addColorStop(0, '#d9cbb5'); g.addColorStop(0.62, '#c2b195'); g.addColorStop(0.63, '#8c7a63'); g.addColorStop(1, '#6f604f');
  c.fillStyle = g; c.fillRect(0, 0, 640, 480);
  c.fillStyle = 'rgba(255,255,240,0.55)'; c.fillRect(470, 60, 120, 150); // window (raw frame; mirrored on screen)
  c.fillStyle = '#7a8a9c'; c.fillRect(40, 250, 180, 70); // sofa
  for (const pose of f?.players || []) {
    if (!pose) continue;
    const P = (i) => ({ x: pose.image[i].x * 640, y: pose.image[i].y * 480 });
    const ls = P(11), rs = P(12), lh = P(23), rh = P(24), nose = P(0);
    c.fillStyle = '#3f5d8a';
    c.beginPath(); c.moveTo(ls.x, ls.y); c.lineTo(rs.x, rs.y); c.lineTo(rh.x, rh.y + 40); c.lineTo(lh.x, lh.y + 40); c.closePath(); c.fill();
    c.strokeStyle = '#c9946d'; c.lineCap = 'round'; c.lineWidth = 26;
    for (const [a, b, d] of [[11, 13, 15], [12, 14, 16]]) {
      const A = P(a), B = P(b), D = P(d);
      c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.lineTo(D.x, D.y); c.stroke();
    }
    c.fillStyle = '#d9a07a';
    c.beginPath(); c.ellipse(nose.x, nose.y - 4, 34, 42, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#2a201b';
    c.beginPath(); c.ellipse(nose.x, nose.y - 30, 36, 22, 0, Math.PI, Math.PI * 2); c.fill();
  }
}

// ───────────────────────────── mock input hub ─────────────────────────────
const hubStatus = {
  mode: has('keyboard') ? 'keyboard' : 'camera', phase: 'running', ready: true, players,
  tracking: Array.from({ length: players }, (_, i) => !missing.has(i)),
  error: q.get('error') ? 'Camera access was blocked.' : null,
  errorHelp: q.get('error') ? 'Allow camera access for this site, then try again.' : null,
  errorCode: q.get('error') || null,
  camera: { label: 'FaceTime HD Camera', deviceId: 'cam-1' }, frameAgeMs: 0, fps: 30,
};
const calStep = q.get('calstep');
const input = {
  video: camCanvas,
  get status() { return hubStatus; },
  latestFrame() { return q.get('error') ? null : frame; },
  calibrate() {
    const steps = ['frame', 'guard', 'right-hand', 'punch-left', 'punch-right'];
    const start = performance.now();
    const msgs = { frame: 'Great — we can see your head, shoulders and both hands.', guard: 'Hold still… measuring your shoulders', 'right-hand': 'Raise your RIGHT hand up high', 'punch-left': 'Throw a straight LEFT at the screen', 'punch-right': 'Now a straight RIGHT' };
    return {
      state: null,
      update() {
        if (calStep === 'done') return { step: 'done', progress: 1, message: 'All set!', ok: true, done: true, result: { version: 1, shoulderWidth: 0.2, armLengthWorld: 0.58, neutralHead: { x: 0.5, y: 0.3 }, neutralShoulderY: 0.45, swapSides: false, createdAt: Date.now() } };
        if (calStep) return { step: calStep, progress: Number(q.get('progress') || 0.62), message: msgs[calStep], ok: true, done: false, result: null };
        const k = (performance.now() - start) / 3000;
        const i = Math.floor(k) % steps.length;
        return { step: steps[i], progress: k % 1, message: msgs[steps[i]], ok: k % 1 > 0.3, done: false, result: null };
      },
      cancel() {},
    };
  },
  setCamera: async (id) => console.debug('[dev] setCamera', id),
  setModel: async (m) => console.debug('[dev] setModel', m),
  setMode: async (m) => console.debug('[dev] setMode', m),
  setKeyboardAssist: (on) => console.debug('[dev] keyboardAssist', on),
  setCalibration: (i, c) => console.debug('[dev] setCalibration', i, c),
  start: async () => { hubStatus.error = null; return { ok: true }; },
};
const audio = { unlock() {}, playSfx: (n) => console.debug('[sfx]', n), setVolume: (v) => console.debug('[dev] volume', v), music() {} };
const bus = new EventBus();
const cameraModule = { listCameras: async () => [{ deviceId: 'cam-1', label: 'FaceTime HD Camera' }, { deviceId: 'cam-2', label: 'USB Webcam (1080p)' }] };

if (has('reduced')) storage.saveSettings({ reducedMotion: true });
const ui = new UI({ root: document.getElementById('ui'), bus, storage, input, audio, modules: { camera: cameraModule, ...(has('no3d') ? { boxerModel: { none: true } } : {}) } });
window.__ui = { ui, storage, bus, input, emit: (ev, p) => bus.emit(ev, p) };

// ───────────────────────────── backdrop (stand-in for the 3D scene) ─────────────────────────────
const bd = document.getElementById('backdrop-canvas');
function paintBackdrop(opponentLook) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  bd.width = innerWidth * dpr; bd.height = innerHeight * dpr;
  const c = bd.getContext('2d');
  const W = bd.width, H = bd.height;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1b2340'); g.addColorStop(0.55, '#2d3a66'); g.addColorStop(0.56, '#e9dfcc'); g.addColorStop(1, '#f2ece0');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // crowd dots
  const colors = ['#ff8a5b', '#ffd166', '#5bd1b8', '#6c8dff', '#c77dff', '#ff5d8f', '#9be564', '#f4f1e8'];
  for (let i = 0; i < 420; i++) {
    const x = (i * 97.3) % W, y = H * 0.18 + ((i * 53.1) % (H * 0.3));
    c.fillStyle = colors[i % colors.length]; c.globalAlpha = 0.35; c.beginPath(); c.arc(x, y, 6 * dpr, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  // ropes
  ['#ff6b5a', '#f7f3ea', '#2bb3a3'].forEach((col, i) => { c.fillStyle = col; c.fillRect(0, H * (0.42 + i * 0.045), W, 6 * dpr); });
  // spotlight
  const s = c.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, W * 0.45);
  s.addColorStop(0, 'rgba(255,241,214,0.35)'); s.addColorStop(1, 'rgba(255,241,214,0)');
  c.fillStyle = s; c.fillRect(0, 0, W, H);
  if (opponentLook) {
    const size = H * 0.62;
    drawPortrait2D(c, opponentLook, { size, x: W / 2 - size / 2, y: H * 0.16, bg: null, gloves: true });
  }
}
addEventListener('resize', () => paintBackdrop(currentOpponentLook));
let currentOpponentLook = null;

// ───────────────────────────── screen params ─────────────────────────────
const opp = ROSTER[3] || ROSTER[0] || { id: 'x', name: 'Pepper Quill', nickname: 'The Whirlwind', tier: 4, intro: 'Fast hands, faster mouth.', appearance: randomLook(4), stats: { hp: 90, power: 1, speed: 1.1 }, ai: { guardHabit: 'switch' } };
const champ = ROSTER[ROSTER.length - 1] || opp;
const cards = (a, b, c) => [{ judge: 'Judge Marlow', p1: a[0], p2: a[1] }, { judge: 'Judge Ito', p1: b[0], p2: b[1] }, { judge: 'Judge Brennan', p1: c[0], p2: c[1] }];
const decisionResult = {
  id: 'r1', winner: 'p1', method: ResultMethod.DECISION, decisionType: 'split', endRound: 3, endClockMs: 0, mode: 'single', opponentId: opp.id,
  scorecards: cards([29, 28], [28, 29], [30, 27]),
  stats: { p1: { thrown: 112, landed: 61, blocked: 18, dodged: 9, counters: 6, damageDealt: 240, knockdownsScored: 1 }, p2: { thrown: 98, landed: 37, blocked: 22, dodged: 4, counters: 2, damageDealt: 170, knockdownsScored: 0 } },
};
const koResult = { ...decisionResult, id: 'r2', method: ResultMethod.KO, decisionType: null, endRound: 2, endClockMs: 83000, scorecards: [] };
const variant = q.get('variant') || '';
const RESULT_VARIANTS = {
  '': decisionResult,
  unanimous: { ...decisionResult, decisionType: 'unanimous', scorecards: cards([30, 27], [29, 28], [29, 28]) },
  majority: { ...decisionResult, decisionType: 'majority', scorecards: cards([29, 28], [28, 28], [30, 28]) },
  loss: { ...decisionResult, winner: 'p2', decisionType: 'unanimous', scorecards: cards([27, 30], [28, 29], [28, 29]) },
  draw: { ...decisionResult, winner: null, method: ResultMethod.DRAW, decisionType: 'draw', scorecards: cards([29, 28], [28, 29], [28, 28]) },
  ko: koResult,
  versus: { ...decisionResult, mode: 'versus', opponentId: null, winner: 'p2', decisionType: 'unanimous', scorecards: cards([27, 30], [28, 29], [27, 29]) },
  'versus-ko': { ...koResult, mode: 'versus', opponentId: null },
};
// rating histories for the results card (oldest first), as progression.ratingHistory() would return
const climb = (n, start = 0) => { const out = [start]; let r = start; for (let i = 0; i < n; i++) { r += Math.round(75 - r / 135 - (i % 6 === 3 ? 22 : 0)); out.push(r); } return out; };
const RESULTS_VARIANTS = {
  '': () => { const h = climb(20); return { before: h.at(-2), after: h.at(-1), pro: true, profile: SAM, history: h, save: { ok: true, saved: true } }; },
  pro: () => { const h = [...climb(13).filter((v) => v < 968), 968, 1041]; return { before: 968, after: 1041, pro: true, becamePro: true, profile: SAM, history: h, save: { ok: true, saved: true } }; },
  lost: () => { const h = [...climb(14), 1012, 972]; return { before: 1012, after: 972, pro: false, lostPro: true, profile: SAM, history: h, save: { ok: true, saved: true } }; },
  unlock: () => { const h = [...climb(22).filter((v) => v < 1541), 1541, 1604]; return { before: 1541, after: 1604, pro: true, profile: SAM, history: h, unlocked: [{ id: 'star-cyan', name: 'Star Cyan', color: '#15d1f0', at: 1600 }, { id: 'royal-violet', name: 'Royal Violet', color: '#6741d9', at: 1600 }], save: { ok: true, saved: true } }; },
  down: () => { const h = [...climb(9), 640, 600]; return { before: 640, after: 600, pro: false, profile: ANA, history: h, save: { ok: true, saved: true } }; },
  first: () => ({ before: 0, after: 75, pro: false, profile: BO, history: [0, 75], save: { ok: true, saved: true } }),
  unsaved: () => ({ before: 420, after: 474, pro: false, profile: ANA, history: [0, 75, 149, 225, 299, 372, 420, 474], save: { ok: true, saved: false, errorCode: 'quota', error: 'Browser storage is full, so progress could not be saved.' } }),
  guest: () => ({ before: 75, after: 149, pro: false, profile: { ...(BO || {}), name: 'Guest', kind: 'guest' }, history: [0, 75, 149], save: { ok: true, saved: false, reason: 'guest' } }),
};
const resultsParams = () => (RESULTS_VARIANTS[variant] || RESULTS_VARIANTS[''])();
const vsParams = () => (variant === 'rematch'
  ? { opponent: opp, profile: SAM, bout: { player: { name: SAM?.name || 'Sam', rating: 1017, pro: true }, opponent: { id: opp.id, name: opp.name, nickname: opp.nickname, rating: 1125, pro: true }, rematch: true } }
  : variant === 'rookie'
    ? { opponent: ROSTER[0] || opp, profile: BO }
    : variant === 'champ'
      ? { opponent: champ, profile: SAM }
      : { opponent: opp, profile: SAM });
const SCREEN_PARAMS = {
  title: () => ({ version: 'dev build' }),
  profiles: () => ({}),
  'profile-editor': () => (variant === 'new' ? {} : { profile: variant === 'rookie' ? BO : SAM }),
  mode: () => ({ profile: SAM }),
  'camera-setup': () => ({ players }),
  calibrate: () => ({ player: 0, profile: SAM }),
  vs: vsParams,
  opponent: vsParams,
  pause: () => ({ kind: variant === 'training' ? 'training' : 'match', canSkipTutorial: variant === 'tutorial' }),
  'tracking-lost': () => ({ player: players === 2 ? 1 : 0, players, name: players === 2 ? 'Ana' : 'Sam' }),
  result: () => {
    const r = RESULT_VARIANTS[variant] || decisionResult;
    const vs = r.mode === 'versus';
    return {
      result: r, names: { p1: 'Sam', p2: vs ? 'Ana' : opp.name },
      appearances: { p1: SAM?.appearance, p2: vs ? ANA?.appearance : opp.appearance }, humanSide: vs ? null : 'p1',
    };
  },
  decision: () => SCREEN_PARAMS.result(),
  'versus-result': () => SCREEN_PARAMS.result(),
  results: resultsParams,
  skill: resultsParams,
  'training-select': () => ({ profile: SAM }),
  'training-result': () => (variant === 'solo'
    ? { kind: 'bag', results: [{ participant: SAM, result: { id: 't', kind: 'bag', score: 2140, medal: 'gold' }, save: { ok: true, saved: true, newBest: true, prevBest: 1840 } }] }
    : { kind: 'mitts', participants: [SAM, ANA, BO], current: 1, results: [
      { participant: SAM, result: { id: 'a', kind: 'mitts', score: 1310, medal: 'silver' }, save: { ok: true, saved: true, newBest: false, prevBest: 1500 } },
      { participant: ANA, result: { id: 'b', kind: 'mitts', score: 1580, medal: 'gold' }, save: { ok: true, saved: true, newBest: true, prevBest: 920 } },
    ] }),
  records: () => ({ profile: SAM }),
  settings: () => ({}),
  help: () => ({}),
};

// ───────────────────────────── HUD mock views ─────────────────────────────
// Views follow the alignment-pass MatchView (view.call / stage / clockVisible / count / tutorial);
// ?hud=legacy-* states use only view.banner (the older match) to check the HUD's fallback.
const P1LOOK = SAM?.appearance || randomLook(1);
const P2LOOK = opp.appearance;
function bv(id, over = {}) {
  return {
    id, name: id === 'p1' ? 'Sam' : opp.name, isHuman: id === 'p1', appearance: id === 'p1' ? P1LOOK : P2LOOK,
    phase: 'idle', phaseProgress: 0, hp01: 1, hp: 10, maxHp: 10, stamina01: 1, guard: 'high', lean: { x: 0, y: 0, z: 0 },
    hands: { left: { x: -0.2, y: 0.4, reach: 0, punching: false }, right: { x: 0.2, y: 0.4, reach: 0, punching: false } },
    punch: null, hitReact: null, knockdowns: 0, roundKnockdowns: 0, counterReady: false, expression: 'neutral', ...over,
  };
}
function mv(over = {}) {
  return {
    phase: 'fighting', phaseTime: 8, stage: 'live', stageTime: 8, round: 2, maxRounds: 3, clockDisplayMs: 83000, roundRealMsLeft: 27000,
    clockVisible: true, call: null, slowmo: null, tutorial: null,
    downed: null, count: null, banner: null, result: null, mode: 'single', opponent: opp, getUp01: null,
    boxers: { p1: bv('p1', { hp01: 0.72 }), p2: bv('p2', { hp01: 0.44, knockdowns: 1 }) }, ...over,
  };
}
const COUNT_MS = 1080;
const countAt = (el, startDelay = 0.4) => Math.max(1, Math.min(10, 1 + Math.floor(Math.max(0, el - startDelay) * 1000 / COUNT_MS)));
// each state: (elapsed seconds) → MatchView
const HUD_STATES = {
  live: () => mv(),
  fighting: () => mv(),
  round: (el) => mv({ phase: 'roundStart', stage: 'banner', clockVisible: false, round: 2, clockDisplayMs: 180000, call: { call: 'round', round: 2, age: el } }),
  final: (el) => mv({ phase: 'roundStart', stage: 'banner', clockVisible: false, round: 3, clockDisplayMs: 180000, call: { call: 'final-round', round: 3, age: el } }),
  fight: (el) => mv({ phase: 'fighting', stage: 'live', clockVisible: el > 0.8, round: 2, clockDisplayMs: 180000, call: { call: 'fight', round: 2, age: el } }),
  down: (el) => mv({ phase: 'knockdown', stage: 'down-call', clockVisible: false, downed: 'p2', call: { call: 'down', boxer: 'p2', age: el }, boxers: { p1: bv('p1', { hp01: 0.72 }), p2: bv('p2', { hp01: 0, knockdowns: 2, phase: 'down' }) } }),
  count: (el) => mv({ phase: 'knockdown', stage: 'count', clockVisible: false, downed: 'p2', count: countAt(el, 0), call: { call: 'down', boxer: 'p2', age: 1.4 + el }, boxers: { p1: bv('p1', { hp01: 0.72 }), p2: bv('p2', { hp01: 0, knockdowns: 2, phase: 'down' }) } }),
  'player-down': (el) => mv({ phase: 'knockdown', stage: 'count', clockVisible: false, downed: 'p1', count: countAt(el, 0), getUp01: Math.min(1, 0.15 + el * 0.22), call: { call: 'down', boxer: 'p1', age: 1.4 + el }, boxers: { p1: bv('p1', { hp01: 0, knockdowns: 1, phase: 'down' }), p2: bv('p2', { hp01: 0.51, knockdowns: 1 }) } }),
  ko: (el) => mv({ phase: 'knockdown', stage: 'ko-call', clockVisible: false, downed: 'p2', count: 10, result: koResult, call: { call: 'ko', winner: 'p1', age: el }, boxers: { p1: bv('p1', { hp01: 0.63, phase: 'victory' }), p2: bv('p2', { hp01: 0, knockdowns: 4, phase: 'ko' }) } }),
  time: (el) => mv({ phase: 'roundEnd', stage: 'bell', clockVisible: el < 1.2, round: 2, clockDisplayMs: 0, roundRealMsLeft: 0, call: { call: 'time', round: 2, age: el } }),
  decision: (el) => mv({ phase: 'decision', stage: null, clockVisible: false, round: 3, clockDisplayMs: 0, roundRealMsLeft: 0, call: { call: 'decision', age: el } }),
  replay: () => mv({ phase: 'result', clockVisible: false, result: koResult }),
  win: () => mv({ phase: 'result', clockVisible: false, result: koResult }),
  tutorial: () => mv({ phase: 'intro', stage: 'tutorial', clockVisible: false, round: 1, clockDisplayMs: 180000, tutorial: { step: tutStep, index: Math.max(0, TUT_STEPS.indexOf(tutStep)), total: 6, count: 2, holdMs: 600 } }),
  versus: () => mv({ mode: 'versus', opponent: null, boxers: { p1: bv('p1', { name: 'Sam' }), p2: bv('p2', { isHuman: true, name: 'Ana', appearance: ANA?.appearance || randomLook(9), knockdowns: 2 }) } }),
  'versus-count': (el) => mv({ mode: 'versus', opponent: null, phase: 'knockdown', stage: 'count', clockVisible: false, downed: 'p2', count: countAt(el, 0), getUp01: Math.min(1, el * 0.3), call: { call: 'down', boxer: 'p2', age: 2 + el }, boxers: { p1: bv('p1', { name: 'Sam' }), p2: bv('p2', { isHuman: true, name: 'Ana', appearance: ANA?.appearance || randomLook(9), knockdowns: 1, phase: 'down' }) } }),
  // older match.js (no call / clockVisible / stage): banners only
  'legacy-count': (el) => { const v = mv({ phase: 'knockdown', downed: 'p2', count: countAt(el, 0), banner: { text: String(countAt(el, 0)), kind: 'count' } }); delete v.call; delete v.clockVisible; delete v.stage; return v; },
  'legacy-fighting': () => { const v = mv(); delete v.call; delete v.clockVisible; delete v.stage; return v; },
};
const TUT_STEPS = ['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge'];
const tutStep = TUT_STEPS.includes(q.get('step')) ? q.get('step') : 'guard-head';
// &delay=<ms>: show the live HUD first (headless WebGL warm-up), then start the state's timeline;
// &freeze=<ms>: pause every animation that long after the timeline started (stable screenshots);
// &at=<ms>: after the warm-up, render the state once at that time and seek the call / outro / tutorial
//           animations to it (deterministic screenshots even when a headless GPU stalls the page).
const delayMs = Number(q.get('delay') || 0);
let frozen = false;
if (q.get('freeze')) {
  setTimeout(() => { frozen = true; for (const a of document.getAnimations?.() || []) a.pause(); }, delayMs + Number(q.get('freeze')));
}

function runHud(state) {
  if (state === 'training') return runTraining();
  const make = HUD_STATES[state] || HUD_STATES.live;
  const versus = state.startsWith('versus');
  if (has('keyboard')) hubStatus.mode = 'keyboard';
  ui.hud.show('match', { mode: versus ? 'versus' : 'single' });
  currentOpponentLook = versus ? null : P2LOOK;
  paintBackdrop(currentOpponentLook);
  const start = performance.now() + delayMs;
  const base = make(0);
  let began = false;
  const startExtras = () => {
    if (state === 'tutorial' && !has('auto')) {
      // explicit calls, as integration makes them (progress fills, then the check pops)
      const idx = TUT_STEPS.indexOf(tutStep);
      const p0 = Number(q.get('progress') ?? 0.66);
      ui.hud.showTutorial({ step: tutStep, index: idx, total: 6, progress01: p0, mode: has('keyboard') ? 'keyboard' : 'camera' });
    }
    if (state === 'replay' || state === 'win') {
      const emit = (stage) => bus.emit(Ev.RENDER_OUTRO, { stage, winner: q.get('winner') === 'p2' ? 'p2' : q.get('winner') === 'none' ? null : 'p1', method: 'KO' });
      emit('start');
      const later = (fn) => (q.has('at') ? fn() : setTimeout(fn, 120));
      if (state === 'replay') { emit('wipe'); later(() => emit('replay')); }
      else later(() => emit('banner'));
    }
  };
  const atMs = q.has('at') ? Number(q.get('at')) : null;
  let atFrames = 0;
  const loop = () => {
    if (frozen) return;
    const now = performance.now();
    let el = Math.max(0, (now - start) / 1000);
    if (atMs !== null && now >= start) {
      el = atMs / 1000;
      if (++atFrames > 1) { frozen = true; seekAnimations(atMs); return; }
    }
    frame = makeFrame(now);
    paintCam(frame);
    if (!began && now >= start) { began = true; startExtras(); }
    const v = began ? make(el) : HUD_STATES.live(0);
    if (v.phase === 'fighting' && v.stage === 'live' && !v.call) {
      v.clockDisplayMs = Math.max(0, base.clockDisplayMs - el * 3000);
      v.roundRealMsLeft = Math.max(0, base.roundRealMsLeft - el * 1000);
    }
    ui.hud.update(v, { tracking: versus ? [true, true] : [true], confidence: [0.9, 0.5] });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** Pause HUD animations at `ms` (calls, outro, tutorial, get-up hint, popups); finish the rest. */
function seekAnimations(ms) {
  const live = '.gu-hud__calls, .gu-outro, .gu-hud__tutorial, .gu-getup, .gu-hud__popups';
  for (const a of document.getAnimations?.() || []) {
    const t = a.effect?.target;
    a.pause();
    if (t?.closest?.(live)) a.currentTime = ms;
    else { try { a.finish(); } catch { a.currentTime = 0; } }
  }
}
window.__seekHud = seekAnimations;

function runTraining() {
  ui.hud.show('training', { training: 'bag', participant: { name: 'Sam', appearance: P1LOOK }, turn: 0, turns: 3 });
  currentOpponentLook = null;
  paintBackdrop(null);
  const start = performance.now();
  const popups = [];
  let id = 0;
  // bursts like the real drills: several texts within a second (they must stack, never overlap)
  const script = [['+50', 'hit'], ['+50', 'hit'], ['BLOCKED', 'miss'], ['+120 BAG DOWN!', 'bonus'], ['OUCH!', 'penalty'], ['OUCH!', 'penalty'], ['+50', 'hit']];
  setInterval(() => {
    const [text, kind] = script[id % script.length];
    popups.push({ id: ++id, text, kind, bornAt: performance.now() });
  }, 260);
  const loop = () => {
    if (frozen) return;
    const now = performance.now();
    frame = makeFrame(now);
    paintCam(frame);
    const el = (now - start) / 1000;
    ui.hud.updateTraining({
      kind: 'bag', phase: el < 0.2 ? 'ready' : 'active', timeLeftMs: Math.max(0, 42000 - el * 1000), score: 1240 + Math.floor(el * 4) * 50, combo: 4,
      popups: popups.filter((p) => now - p.bornAt < 900).map((p) => ({ id: p.id, text: p.text, kind: p.kind, age: (now - p.bornAt) / 1000 })),
    }, { tracking: [true] });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ───────────────────────────── flow demo ─────────────────────────────
async function flow() {
  paintBackdrop(null);
  for (;;) {
    await ui.show('title');
    let profile = null;
    while (!profile) {
      const r = await ui.show('profiles');
      if (r.action === 'select') profile = r.profile;
      else break;
    }
    if (!profile) continue;
    for (;;) {
      const r = await ui.show('mode', { profile });
      if (r.action === 'back' || r.action === 'change-profile') break;
      if (r.action === 'training') { await ui.show('training-select', { profile }); continue; }
      if (r.action === 'single') {
        const o = await ui.show('vs', { opponent: opp, profile });
        if (o.action === 'back') continue;
        ui.hide();
        runHud('fighting');
        return;
      }
    }
  }
}

// ───────────────────────────── boot ─────────────────────────────
function tickFrames() {
  frame = makeFrame(performance.now());
  paintCam(frame);
  requestAnimationFrame(tickFrames);
}

const screen = q.get('screen');
const hud = q.get('hud');
if (screen) {
  tickFrames();
  paintBackdrop(null);
  if (!SCREEN_IDS.includes(screen)) document.getElementById('ui').textContent = `unknown screen ${screen}`;
  else {
    if (screen === 'pause' || screen === 'tracking-lost') {
      ui.hud.show('match', { mode: players === 2 ? 'versus' : 'single' });
      ui.hud.update(HUD_STATES[players === 2 ? 'versus' : 'fighting']());
      paintBackdrop(P2LOOK);
    }
    if (screen === 'profiles' && variant === 'import') {
      ui.show('profiles', {}).then((r) => console.debug('[dev] result', r));
      requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.gu-profiles__actions .gu-btn:last-child')?.__guAction?.()));
    } else {
      ui.show(screen, { ...(SCREEN_PARAMS[screen]?.() || {}) }).then((r) => console.debug('[dev] result', r));
    }
    if (q.get('tab')) {
      setTimeout(() => {
        const tab = [...document.querySelectorAll('.gu-tabs__tab')].find((b) => b.textContent.trim().toLowerCase() === q.get('tab'));
        tab?.__guAction?.();
      }, 100);
    }
  }
} else if (hud) {
  runHud(hud);
} else if (has('flow')) {
  tickFrames();
  flow();
} else {
  tickFrames();
  paintBackdrop(null);
  const idx = document.createElement('div');
  idx.className = 'dev-index';
  const link = (href, text) => `<a href="${href}">${text}</a>`;
  idx.innerHTML = `<h1>Glove Up — UI lab</h1>
    <p>Every screen and HUD state with mock data. Add <b>&amp;players=2</b> for two players, <b>&amp;broken=1</b> to make saving fail (ERR04), <b>&amp;reduced=1</b> for reduced motion.</p>
    <h2>Screens</h2>${SCREEN_IDS.map((s) => link(`?screen=${s}`, s)).join('')}
    <h2>Variants</h2>${[
    ['?screen=profile-editor&variant=new', 'new boxer'], ['?screen=profiles&variant=import', 'import'], ['?screen=profiles&empty=1', 'no profiles'],
    ['?screen=camera-setup&players=2&missing=1', 'versus: P2 missing'], ['?screen=camera-setup&error=denied', 'camera blocked'],
    ['?screen=calibrate&calstep=done', 'calibration done'], ['?screen=tracking-lost&players=2&missing=1', 'P2 lost'],
    ['?screen=vs&variant=rematch', 'VS rematch'], ['?screen=vs&variant=rookie', 'VS first bout'], ['?screen=vs&variant=champ', 'VS champion'],
    ['?screen=result&variant=unanimous', 'decision: unanimous'], ['?screen=result&variant=majority', 'decision: majority'],
    ['?screen=result&variant=draw', 'decision: draw'], ['?screen=result&variant=loss', 'decision: loss'], ['?screen=result&variant=ko', 'result KO'],
    ['?screen=versus-result&variant=versus', 'versus: decision'], ['?screen=versus-result&variant=versus-ko', 'versus: KO'],
    ['?screen=results&variant=pro', 'results: turned PRO'], ['?screen=results&variant=lost', 'results: PRO lost'], ['?screen=results&variant=unlock', 'results: glove unlock'],
    ['?screen=results&variant=down', 'results: rating down'], ['?screen=results&variant=first', 'results: first bout'], ['?screen=results&variant=unsaved', 'results: not saved (ERR04)'],
    ['?screen=profile-editor&tab=kit', 'editor: kit (glove locks)'], ['?screen=pause&variant=tutorial', 'pause: skip tutorial'],
    ['?screen=training-result&variant=solo', 'training solo'], ['?screen=settings&tab=sound', 'settings: sound'], ['?screen=help&tab=keyboard', 'help: keys'],
    ['?flow=1', 'flow demo'],
  ].map(([h, t]) => link(h, t)).join('')}
    <h2>HUD</h2>${Object.keys(HUD_STATES).concat(['training']).map((s) => link(`?hud=${s}`, s)).join('')}`;
  document.getElementById('app').appendChild(idx);
}

// Screenshot helpers wait for this (dev/ui.js loads optional modules first).
window.__uiReady = true;
