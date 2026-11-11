// Input Lab — dev page for the input runtime: camera picker, auto/lite/full model, 1/2 players,
// mirrored preview + skeleton, fps / detect ms / delegate, live ControlState + event log,
// record / download / load / replay of raw pose frames.
//
// URL params: ?video=<url> (clip as camera) · ?input=camera|keyboard|replay · ?model=auto|lite|full
// PERF-06: the status badges show the per-stage pipeline timings (InputHub status.pipeline).
//             ?players=1|2 · ?delegate=CPU · ?autostart=1 · ?sens=0..1 (gesture sensitivity, Settings slider)
// Alignment pass: the status shows the measured camera → game latency (hub.latencyMs, stored in the
// calibration) and each player card the dodge the bout would see plus the tutorial detections
// (src/input/tutorial-detect.js: stance / guard hold times, punch targets, dodges).
//             ?softgl=allow (let the GPU delegate run on software WebGL, to watch the slow-GPU → CPU switch)
// Debug handle: window.__lab = { engine, bus, state() }

import { EventBus } from '../src/core/events.js';
import { Ev, InputMode } from '../src/core/types.js';
import { listCameras, openCamera, openVideoFile } from '../src/input/camera.js';
import { PoseTracker } from '../src/input/pose-tracker.js';
import { PlayerAssigner } from '../src/input/player-assigner.js';
import { KeyboardInput, neutralControl } from '../src/input/keyboard.js';
import { Recorder, ReplaySource } from '../src/input/recorder.js';
import { drawPreview, PLAYER_COLORS } from '../src/input/preview.js';
import { dodgeDetected, isStance, isGuard, punchMatches } from '../src/input/tutorial-detect.js';

const params = new URLSearchParams(location.search);
const TEST_CLIP = '/dev/clips/facecam-boxing.mp4';
const $ = (id) => document.getElementById(id);

// The hub pulls in the gesture recognizer; if that module isn't available the lab still shows
// raw tracking (camera → PoseTracker → PlayerAssigner) so the input runtime can be checked.
let InputHub = null;
let hubLoadError = null;
try {
  ({ InputHub } = await import('../src/input/input-hub.js'));
} catch (e) {
  hubLoadError = e;
  const s = document.createElement('style');
  s.textContent = 'vite-error-overlay{display:none!important}';
  document.head.appendChild(s);
}

/** Raw pipeline with the hub's interface subset — used only when the hub can't load. */
class RawEngine {
  constructor(o) {
    Object.assign(this, { bus: o.bus, mode: o.mode, players: o.players, video: o.video, model: o.model, delegate: o.delegate, deviceId: o.deviceId, videoSource: o.videoSource, trackerTuning: o.trackerTuning });
    this.recorder = new Recorder();
    this.keyboard = new KeyboardInput({ players: this.players });
    this.assigner = new PlayerAssigner({ players: this.players });
    this._phase = 'idle'; this._err = null; this._latest = null; this._walls = []; this._lastWall = -Infinity; this._now = 0;
    this._present = [false, false]; this._replay = null;
  }
  async start() {
    this._phase = 'starting';
    try {
      if (this.mode === InputMode.KEYBOARD) { this.keyboard.attach(window); this._phase = 'running'; return { ok: true }; }
      if (this.mode === InputMode.REPLAY) { this._phase = 'running'; return { ok: true }; }
      this._tracker = new PoseTracker({ numPoses: Math.min(3, this.players + 1), model: this.model, delegate: this.delegate, ...(this.trackerTuning ? { tuning: this.trackerTuning } : {}) });
      const camP = this.videoSource ? openVideoFile(this.videoSource, { video: this.video }) : openCamera({ deviceId: this.deviceId, video: this.video });
      const [cam] = await Promise.all([camP, this._tracker.init()]);
      this._cam = cam; this.video = cam.video; this._phase = 'running';
      return { ok: true };
    } catch (e) {
      this._phase = 'error'; this._err = e;
      this.bus.emit(Ev.INPUT_ERROR, { message: e.message, help: e.help, code: e.code, cause: e });
      return { ok: false, error: e.message };
    }
  }
  stop() { if (this._cam) this._cam.stop(); if (this._tracker) this._tracker.close(); this.keyboard.detach(); this._phase = 'stopped'; }
  setPlayers(n) { this.players = n; this.assigner.setPlayers(n); this.keyboard.setPlayers(n); if (this._tracker) this._tracker.setNumPoses(Math.min(3, n + 1)); }
  setKeyboardAssist() {}
  async replay(rec, { loop }) { this.stop(); this.mode = InputMode.REPLAY; this._replay = new ReplaySource(rec, { loop }); return this.start(); }
  _process(raw, now) {
    this.recorder.push(raw);
    this._latest = this.assigner.assign(raw);
    this._lastWall = now; this._walls.push(now);
    while (this._walls.length && this._walls[0] < now - 1000) this._walls.shift();
    for (let i = 0; i < this.players; i++) this._present[i] = !!this._latest.players[i];
  }
  update(now) {
    this._now = now;
    if (this._phase === 'running' && this.mode === InputMode.CAMERA && this._tracker) {
      const f = this._tracker.detect(this.video, now);
      if (f) this._process(f, now);
    } else if (this._phase === 'running' && this.mode === InputMode.REPLAY && this._replay) {
      for (const f of this._replay.next(now)) this._process(f, now);
    }
    if (now - this._lastWall > 500) this._present = [false, false];
    const players = [];
    for (let i = 0; i < this.players; i++) {
      const out = this.mode === InputMode.KEYBOARD ? this.keyboard.update(now, i) : { control: neutralControl({ tracked: this._present[i] }), events: [] };
      for (const ev of out.events) if (ev.type === 'punch') this.bus.emit(Ev.INPUT_PUNCH, { player: i, punch: ev.punch });
      players.push(out);
    }
    return { players, status: this.status };
  }
  get status() {
    const ts = this._tracker ? this._tracker.getStats() : null;
    const n = this._walls.length, span = n > 1 ? this._walls[n - 1] - this._walls[0] : 0;
    return {
      mode: this.mode, phase: this._phase, ready: this._phase === 'running', players: this.players,
      tracking: this.mode === InputMode.KEYBOARD ? [true, true].slice(0, this.players) : this._present.slice(0, this.players),
      presence: this._present.slice(0, this.players),
      fps: span > 0 ? (n - 1) * 1000 / span : 0, detectMs: ts ? ts.detectMs : 0, detectMsP95: ts ? ts.detectMsP95 : 0,
      delegate: ts ? ts.delegate : null, fallbackReason: ts ? ts.fallbackReason : null, model: this.model, numPoses: ts ? ts.numPoses : 0,
      error: this._err ? this._err.message : null, errorHelp: this._err ? this._err.help : null,
      camera: this._cam ? { label: this._cam.label, kind: this._cam.kind, width: this._cam.width, height: this._cam.height } : null,
      recording: this.recorder.recording, replaying: this.mode === InputMode.REPLAY, keyboardAssist: false,
    };
  }
  latestFrame() { return this._latest; }
  injectFrames(frames) { for (const f of frames) this._process(f, f.t); }
}

// ───────────────────────────── state ─────────────────────────────

const bus = new EventBus();
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
const ui = {
  players: params.get('players') === '2' ? 2 : 1,
  model: ['lite', 'full'].includes(params.get('model')) ? params.get('model') : 'auto',
  delegate: params.get('delegate') === 'CPU' ? 'CPU' : 'GPU',
  assist: false,
  source: params.get('video') ? 'clip' : params.get('input') === 'keyboard' ? 'keyboard' : 'camera',
  clipUrl: params.get('video') || TEST_CLIP,
};
let engine = null;
let running = false;
let lastRecording = null;
const logItems = [];
let evCount = 0;
let lastStatus = null;

// ───────────────────────────── controls ─────────────────────────────

async function fillSources(selectValue) {
  const cams = await listCameras();
  const sel = $('source');
  const opts = [];
  if (cams.length) cams.forEach((c) => opts.push([`cam:${c.deviceId}`, c.label]));
  else opts.push(['camera', 'Default camera']);
  opts.push(['clip', ui.clipUrl === TEST_CLIP ? 'Test clip (dev/clips)' : `Clip: ${ui.clipUrl.split('/').pop()}`]);
  opts.push(['keyboard', 'Keyboard only']);
  if (lastRecording) opts.push(['replay', `Replay (${lastRecording.frames.length} frames)`]);
  sel.innerHTML = '';
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
  const want = selectValue || (ui.source === 'camera' ? (opts[0][0]) : ui.source);
  sel.value = [...sel.options].some((o) => o.value === want) ? want : opts[0][0];
}

function sourceToOptions(v) {
  if (v === 'keyboard') return { mode: InputMode.KEYBOARD };
  if (v === 'replay') return { mode: InputMode.REPLAY };
  if (v === 'clip') return { mode: InputMode.CAMERA, videoSource: ui.clipUrl };
  if (v.startsWith('cam:')) return { mode: InputMode.CAMERA, deviceId: v.slice(4) || undefined };
  return { mode: InputMode.CAMERA };
}

async function start() {
  stop();
  const src = $('source').value;
  const o = sourceToOptions(src);
  const opts = {
    bus, mode: o.mode === InputMode.REPLAY ? InputMode.CAMERA : o.mode, players: ui.players, video,
    model: ui.model, delegate: ui.delegate, deviceId: o.deviceId, videoSource: o.videoSource, keyboardAssist: ui.assist,
    trackerTuning: params.get('softgl') === 'allow' ? { avoidSoftwareGL: false } : null,
  };
  engine = InputHub ? new InputHub(opts) : new RawEngine(opts);
  if (params.get('sens') !== null && typeof engine.setSensitivity === 'function') engine.setSensitivity(Number(params.get('sens')));
  window.__lab.engine = engine;
  running = true;
  setStartButton();
  $('idle').hidden = true;
  let res;
  if (o.mode === InputMode.REPLAY && lastRecording) res = await engine.replay(lastRecording, { loop: $('loop').checked });
  else res = await engine.start();
  if (res && res.ok && o.mode === InputMode.CAMERA && !o.videoSource) fillSources(src); // labels appear after permission
  if (res && res.ok) addLog('ui', `Started: ${$('source').selectedOptions[0]?.textContent || src}`); // failures arrive via Ev.INPUT_ERROR
}

function stop() {
  if (engine) { try { engine.stop(); } catch (e) { console.error(e); } }
  running = false;
  setStartButton();
}

function setStartButton() {
  const b = $('start');
  b.textContent = running ? 'Stop' : 'Start';
  b.classList.toggle('primary', !running);
}

$('start').addEventListener('click', () => {
  if (running && lastStatus && lastStatus.phase === 'error') start(); // Retry
  else if (running) { stop(); $('idle').hidden = false; } else start();
});
$('source').addEventListener('change', () => { if (running) start(); });
$('model').value = ui.model;
$('model').addEventListener('change', (e) => { ui.model = e.target.value; if (running) start(); });
$('delegate').value = ui.delegate;
$('delegate').addEventListener('change', (e) => { ui.delegate = e.target.value; if (running) start(); });
$('assist').addEventListener('change', (e) => { ui.assist = e.target.checked; if (engine) engine.setKeyboardAssist(ui.assist); });
for (const b of $('players').querySelectorAll('button')) {
  b.classList.toggle('on', Number(b.dataset.n) === ui.players);
  b.addEventListener('click', () => {
    ui.players = Number(b.dataset.n);
    for (const x of $('players').querySelectorAll('button')) x.classList.toggle('on', x === b);
    if (engine) engine.setPlayers(ui.players);
    buildCards();
  });
}

// ── record / replay ──
$('rec').addEventListener('click', () => {
  if (!engine) return;
  const r = engine.recorder;
  if (r.recording) {
    lastRecording = r.stop();
    addLog('ui', `Recorded ${lastRecording.frames.length} frames (${(r.durationMs / 1000).toFixed(1)} s)`);
    fillSources($('source').value);
  } else {
    r.start({ model: engine.model || ui.model, players: ui.players, source: $('source').value });
    addLog('ui', 'Recording…');
  }
});
$('download').addEventListener('click', () => { if (engine) addLog('ui', `Saved ${engine.recorder.download()}`); });
$('load').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    lastRecording = await Recorder.load(f);
    addLog('ui', `Loaded ${f.name}: ${lastRecording.frames.length} frames`);
    await fillSources('replay');
  } catch (err) { addLog('err', err.message); }
  e.target.value = '';
});
$('replay').addEventListener('click', async () => {
  if (!lastRecording) return;
  await fillSources('replay');
  $('source').value = 'replay';
  start();
});

// ───────────────────────────── side cards ─────────────────────────────

function buildCards() {
  for (let i = 0; i < 2; i++) {
    const card = $(`card${i}`);
    card.hidden = i >= ui.players;
    if (card.dataset.built) continue;
    card.dataset.built = '1';
    card.innerHTML = `
      <div class="head"><span class="dot" style="background:${PLAYER_COLORS[i]}"></span><h2>Player ${i + 1}</h2>
        <span class="sub" data-k="guard"></span><span class="state" data-k="state">not tracked</span></div>
      <canvas width="300" height="224"></canvas>
      <div class="meters">
        <span>Lean X</span><div class="bar center"><i data-k="lx"></i></div><span class="v" data-k="lxv"></span>
        <span>Duck</span><div class="bar"><i data-k="ly"></i></div><span class="v" data-k="lyv"></span>
        <span>Lean Z</span><div class="bar center"><i data-k="lz"></i></div><span class="v" data-k="lzv"></span>
        <span>Guard</span><div class="bar"><i data-k="ga" style="background:var(--good)"></i></div><span class="v" data-k="gav"></span>
        <span>Activity</span><div class="bar"><i data-k="ac" style="background:var(--warn)"></i></div><span class="v" data-k="acv"></span>
        <span>Conf.</span><div class="bar"><i data-k="cf" style="background:${PLAYER_COLORS[i]}"></i></div><span class="v" data-k="cfv"></span>
      </div>
      <div class="tut" data-k="tut"></div>`;
  }
}

function setBar(el, v, centered) {
  if (centered) {
    const c = Math.max(-1, Math.min(1, v));
    el.style.left = `${50 + Math.min(0, c) * 50}%`;
    el.style.width = `${Math.abs(c) * 50}%`;
  } else {
    el.style.left = '0';
    el.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  }
}

function updateCard(i, control, tracked) {
  const card = $(`card${i}`);
  const q = (k) => card.querySelector(`[data-k="${k}"]`);
  const st = q('state');
  st.textContent = tracked ? 'tracked' : 'not tracked';
  st.classList.toggle('on', tracked);
  q('guard').innerHTML = `guard <span class="guardtag">${control.guard}</span>`;
  setBar(q('lx'), control.lean.x, true); q('lxv').textContent = control.lean.x.toFixed(2);
  setBar(q('ly'), -Math.min(0, control.lean.y), false); q('lyv').textContent = control.lean.y.toFixed(2);
  setBar(q('lz'), control.lean.z, true); q('lzv').textContent = control.lean.z.toFixed(2);
  setBar(q('ga'), control.guardAmount, false); q('gav').textContent = control.guardAmount.toFixed(2);
  setBar(q('ac'), control.activity, false); q('acv').textContent = control.activity.toFixed(2);
  setBar(q('cf'), control.confidence, false); q('cfv').textContent = control.confidence.toFixed(2);
  // tutorial-detect view (what the first-bout tutorial would see)
  const tut = tutorialSeen[i];
  const d = dodgeDetected(control);
  if (d) tut.dodge = d;
  const sec = (ms) => `${((ms || 0) / 1000).toFixed(1)} s`;
  const html = [
    `<span class="${isStance(control) ? 'on' : ''}">stance ${isStance(control) ? sec(control.stanceMs) : '–'}</span>`,
    `<span class="${isGuard(control, 'high') ? 'on' : ''}">guard face ${isGuard(control, 'high') ? sec(control.guardMs) : '–'}</span>`,
    `<span class="${isGuard(control, 'low') ? 'on' : ''}">guard body ${isGuard(control, 'low') ? sec(control.guardMs) : '–'}</span>`,
    `<span>punches head ${tut.head} · body ${tut.body}</span>`,
    `<span class="${d ? 'on' : ''}">dodge ${d || (tut.dodge ? `(${tut.dodge})` : '–')}</span>`,
  ].join('');
  const el = q('tut');
  if (el.innerHTML !== html) el.innerHTML = html;
  drawControl(card.querySelector('canvas'), control, PLAYER_COLORS[i], tracked);
}

/** Per-player tallies of tutorial detections (punch targets, last dodge) for the cards. */
const tutorialSeen = [{ head: 0, body: 0, dodge: null }, { head: 0, body: 0, dodge: null }];
bus.on(Ev.INPUT_PUNCH, (e) => {
  const t = tutorialSeen[e && e.player === 1 ? 1 : 0];
  if (punchMatches(e, 'head')) t.head++; else if (punchMatches(e, 'body')) t.body++;
});

/** Player-perspective diagram (seen from behind): shoulders, head offset, gloves (size = reach). */
function drawControl(cv, c, color, tracked) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  drawControlIn(g, { x: 0, y: 0, w: cv.width, h: cv.height }, c, color, tracked, true);
}

function drawControlIn(g, R, c, color, tracked, grid) {
  const W = R.w, H = R.h;
  g.save();
  g.translate(R.x, R.y);
  g.fillStyle = '#0f1326'; g.fillRect(0, 0, W, H);
  if (grid) {
    g.strokeStyle = 'rgba(255,250,240,0.06)'; g.lineWidth = 1;
    for (let x = W / 6; x < W; x += W / 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  }
  g.globalAlpha = tracked ? 1 : 0.4;
  // lean in (lean.z > 0) draws the boxer nearer / bigger, lean back farther / smaller
  const lz = c.lean && Number.isFinite(c.lean.z) ? Math.max(-1, Math.min(1, c.lean.z)) : 0;
  const s = Math.min(W / 3.0, H / 2.3) * (1 + 0.18 * lz), cx = W / 2, sy = H * 0.55;
  const head = c.head || { x: 0, y: 0 };
  const bx = head.x * s * 0.8, by = -head.y * s * 0.9;
  g.fillStyle = 'rgba(255,250,240,0.12)';
  g.beginPath(); g.roundRect(cx + bx - s * 0.48, sy + by - 4, s * 0.96, H, s * 0.2); g.fill();
  g.strokeStyle = 'rgba(255,250,240,0.45)'; g.lineWidth = Math.max(4, s * 0.09); g.lineCap = 'round';
  g.beginPath(); g.moveTo(cx + bx - s / 2, sy + by); g.lineTo(cx + bx + s / 2, sy + by); g.stroke();
  const hx = cx + head.x * s * 1.3, hy = sy - 0.62 * s - head.y * s * 1.2;
  g.fillStyle = '#f2d4bd'; g.beginPath(); g.arc(hx, hy, s * 0.27, 0, Math.PI * 2); g.fill();
  for (const hand of ['left', 'right']) {
    const h = c.hands[hand];
    const x = cx + bx + h.x * s, y = sy + by - h.y * s;
    const r = s * (0.17 + 0.13 * Math.max(0, Math.min(1, h.reach)));
    if (h.punching) {
      g.fillStyle = color; g.globalAlpha = 0.35 * (tracked ? 1 : 0.4);
      g.beginPath(); g.arc(x, y, r * 1.6, 0, Math.PI * 2); g.fill();
      g.globalAlpha = tracked ? 1 : 0.4;
    }
    g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.lineWidth = Math.max(2, s * 0.05); g.strokeStyle = '#fffaf0'; g.stroke();
    g.fillStyle = '#fffaf0'; g.font = `900 ${Math.round(r * 0.9)}px Nunito, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(hand === 'left' ? 'L' : 'R', x, y + 1);
  }
  g.globalAlpha = 1;
  if (c.guard !== 'none') {
    g.fillStyle = c.guard === 'high' ? '#2bb3a3' : '#ffc94a';
    g.font = `900 ${Math.round(Math.max(14, s * 0.2))}px Nunito, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(c.guard === 'high' ? 'HIGH GUARD' : 'LOW GUARD', 10, 8);
  }
  g.restore();
}

/** Keyboard mode has no video: show each player's live ControlState big on the stage. */
function drawKeyboardStage(players, status) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#0f1326'; ctx.fillRect(0, 0, W, H);
  const n = ui.players, pad = Math.round(W * 0.02);
  const cw = (W - pad * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const R = { x: pad + i * (cw + pad), y: pad * 3, w: cw, h: H - pad * 4 };
    const c = players[i] ? players[i].control : neutralControl({ tracked: false });
    drawControlIn(ctx, R, c, PLAYER_COLORS[i], !!status.tracking[i], false);
    ctx.fillStyle = PLAYER_COLORS[i];
    ctx.font = `900 ${Math.round(H * 0.035)}px Nunito, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`P${i + 1} · keyboard`, R.x + R.w - 10, R.y + 8);
  }
}

// ───────────────────────────── event log ─────────────────────────────

const t0 = performance.now();
function addLog(kind, text, tagText) {
  evCount++;
  logItems.unshift({ kind, text, tag: tagText || { p1: 'P1', p2: 'P2', found: 'FOUND', lost: 'LOST', err: 'ERROR', ui: 'LAB' }[kind] || kind, t: (performance.now() - t0) / 1000 });
  if (logItems.length > 40) logItems.length = 40;
  const ol = $('log');
  ol.innerHTML = logItems.map((e) => `<li><time>${e.t.toFixed(1)}s</time><span class="tag ${e.kind}">${e.tag}</span><span>${escapeHtml(e.text)}</span></li>`).join('');
  $('evcount').textContent = `${evCount} total`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

bus.on(Ev.INPUT_PUNCH, ({ player, punch }) => addLog(player ? 'p2' : 'p1', `${punch.hand} ${punch.kind} → ${punch.target} · power ${punch.power.toFixed(2)}`, `P${player + 1} PUNCH`));
bus.on(Ev.INPUT_TRACKING_FOUND, ({ player }) => addLog('found', `Player ${player + 1} tracked`));
bus.on(Ev.INPUT_TRACKING_LOST, ({ player }) => addLog('lost', `Player ${player + 1} lost`));
bus.on(Ev.INPUT_ERROR, ({ message }) => addLog('err', message));

// ───────────────────────────── stage ─────────────────────────────

const canvas = $('preview');
const ctx = canvas.getContext('2d');
function fitCanvas() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
addEventListener('resize', fitCanvas);

function badge(label, value, cls = '') { return `<span class="badge ${cls}"><b>${label}</b>${escapeHtml(value)}</span>`; }

function renderStatus(st) {
  const items = [];
  if (hubLoadError) items.push(badge('mode', 'raw tracking (hub unavailable)', 'warn'));
  items.push(badge('source', st.mode === 'camera' ? (st.camera ? st.camera.label : '…') : st.mode));
  if (st.camera) items.push(badge('size', `${st.camera.width}×${st.camera.height}`));
  if (st.mode !== 'keyboard') {
    items.push(badge('fps', st.fps.toFixed(1), st.fps > 20 ? 'good' : st.fps > 0 ? 'warn' : ''));
    if (st.mode === 'camera') {
      items.push(badge('detect', `${st.detectMs.toFixed(1)} ms · p95 ${st.detectMsP95.toFixed(0)}`));
      items.push(badge('delegate', st.delegate || '…', st.delegate === 'GPU' ? 'good' : st.delegate ? 'warn' : ''));
      items.push(badge('model', `${st.model} · ${st.numPoses} poses`));
    }
    if (Number.isFinite(st.latencyMs)) items.push(badge('latency', `${st.latencyMs} ms (${st.latencySource || '?'})`, st.latencyMs <= 150 ? 'good' : 'warn'));
    // PERF-06: per-stage pipeline timings (InputHub status.pipeline)
    const p = st.pipeline;
    if (p && p.frames) {
      const ms = (x) => (x && Number.isFinite(x.p50) ? `${Math.round(x.p50)}/${Math.round(x.p90)}` : '–');
      items.push(badge('rates', `cam ${p.cameraFps ?? '–'} fps (seen ${p.camFps}) · det ${p.detFps} (min ${p.detFpsMin ?? '–'})`, p.behind ? 'warn' : 'good'));
      items.push(badge('ms p50/p90', `cap→seen ${ms(p.capToSeen)} · wait ${ms(p.waitMs)} · detect ${ms(p.detMs)} · cap→pose ${ms(p.capToPose)} · pose→game ${ms(p.poseToGame)} · cap→punch ${ms(p.capToEvent)}`));
      if (p.modelPref) items.push(badge('auto', `${p.modelPref} → ${p.model}${p.pendingModel ? ` (next: ${p.pendingModel})` : ''}${p.behind ? ' · behind' : p.headroom ? ' · headroom' : ''}${p.starved ? ' · starved' : ''}`));
      if (p.switching) items.push(badge('switch', `${p.switching.kind} → ${p.switching.to} · ${p.switching.phase}${p.switching.why ? ` (${p.switching.why})` : ''}`, 'warn'));
    }
  }
  if (st.recording) items.push(badge('rec', `${engine.recorder.frameCount} frames`, 'warn'));
  const html = items.join('');
  if ($('badges').innerHTML !== html) $('badges').innerHTML = html;
  $('badges').title = st.fallbackReason || '';

  const chips = [];
  for (let i = 0; i < st.players; i++) chips.push(`<span class="pchip p${i + 1} ${st.tracking[i] ? 'on' : ''}"><i></i>P${i + 1}</span>`);
  const ch = chips.join('');
  if ($('pchips').innerHTML !== ch) $('pchips').innerHTML = ch;

  // notice: errors first, then "who's missing" (ERR01) while the camera runs
  const n = $('notice');
  let html2 = '', cls = '';
  if (st.error) { html2 = `<strong>${escapeHtml(st.error)}</strong>${st.errorHelp ? `<small>${escapeHtml(st.errorHelp)}</small>` : ''}`; cls = 'error'; }
  else if (st.phase === 'starting') html2 = 'Starting camera and pose tracker…';
  else if (st.phase === 'running' && st.mode !== 'keyboard') {
    const missing = st.tracking.map((t, i) => (t ? null : `P${i + 1}`)).filter(Boolean);
    if (missing.length === st.players) html2 = `No player detected<small>Step back until your head, shoulders and both hands are in the picture.</small>`;
    else if (missing.length) html2 = `Waiting for ${missing.join(' & ')}<small>Stand side by side — P1 on the left of the picture, P2 on the right.</small>`;
  }
  n.hidden = !html2;
  if (html2 && n.innerHTML !== html2) n.innerHTML = html2;
  n.className = `notice ${cls}`;

  const sb = $('start');
  const label = st.phase === 'error' ? 'Retry' : 'Stop';
  if (sb.textContent !== label) { sb.textContent = label; sb.classList.toggle('primary', st.phase === 'error'); }
  $('rec').textContent = st.recording ? '■ Stop' : '● Record';
  $('rec').classList.toggle('rec-on', st.recording);
  $('download').disabled = !engine || engine.recorder.frameCount === 0 || st.recording;
  $('replay').disabled = !lastRecording;
  const r = engine.recorder;
  $('recmeta').textContent = r.frameCount ? `${r.frameCount} frames · ${(r.durationMs / 1000).toFixed(1)} s` : (lastRecording ? `loaded ${lastRecording.frames.length} frames` : '0 frames');
}

function tick(now) {
  fitCanvas();
  if (engine && running) {
    const { players, status } = engine.update(now);
    lastStatus = status;
    players.forEach((pl, i) => { for (const ev of pl.events) if (ev.type !== 'punch') addLog(i ? 'p2' : 'p1', `${ev.type} event`, `P${i + 1} ${ev.type.toUpperCase()}`); });
    if (status.mode === InputMode.KEYBOARD) drawKeyboardStage(players, status);
    else drawPreview(ctx, engine.video, engine.latestFrame(), { mirrored: true, fit: 'contain', players: ui.players, dim: 0.08, background: '#0f1326' });
    for (let i = 0; i < ui.players; i++) updateCard(i, players[i] ? players[i].control : neutralControl({ tracked: false }), !!status.tracking[i]);
    renderStatus(status);
  } else {
    ctx.fillStyle = '#0f1326'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < ui.players; i++) updateCard(i, neutralControl({ tracked: false }), false);
  }
  requestAnimationFrame(tick);
}

// ───────────────────────────── boot ─────────────────────────────

window.__lab = {
  bus, engine: null, hubLoadError,
  state: () => {
    const f = engine && engine.latestFrame();
    return {
      hub: !!InputHub, hubLoadError: hubLoadError ? String(hubLoadError.message || hubLoadError) : null, status: lastStatus,
      frame: f ? { t: f.t, width: f.width, height: f.height, players: f.players.map((p) => (p ? { score: p.score, shoulderX: (p.image[11].x + p.image[12].x) / 2, noseX: p.image[0].x } : null)), ignored: (f.ignored || []).map((p) => ({ score: p.score, shoulderX: (p.image[11].x + p.image[12].x) / 2 })) } : null,
      assigner: engine && engine.assigner ? engine.assigner.debug() : null,
      log: logItems.slice(0, 12),
    };
  },
};
buildCards();
await fillSources(ui.source === 'clip' ? 'clip' : ui.source === 'keyboard' ? 'keyboard' : undefined);
requestAnimationFrame(tick);
if (params.get('autostart') === '1' || params.get('video') || params.get('input') === 'keyboard') start();
