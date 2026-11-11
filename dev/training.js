// Training lab: run each practice activity with the real GameRenderer, TrainingScene and HUD —
// played with the keyboard or by a scripted bot — and freeze key moments for screenshots.
//
//   /dev/training.html?kind=bag|dodge|mitts            live (keyboard; buttons at the bottom)
//   &bot=0.6                                           a scripted player of that skill (0..1) plays
//   &seed=7  &dur=60000  &ready=3000  &hud=0
//   &shot=<scenario>                                   fast-forward to a moment, freeze, set window.__shotReady
//      scenarios: t=<seconds> (any kind), bag-swing, bag-break, bag-drop, bag-weak, dodge-aim,
//      dodge-flight, dodge-double, dodge-hit, dodge-dodge, mitts-up, mitts-both, mitts-low, mitts-hit,
//      mitts-trainer, done
//
// Keys (input/keyboard.js): J/K punch · U/I hooks · N/M uppercuts · hold Shift → body ·
// A/D lean · S duck · Space guard · P pause. Lab keys: 1/2/3 activity · R restart · F finish ·
// 0 bot off · 7/8/9 bot beginner/average/expert.

import { EventBus } from '../src/core/events.js';
import { Ev } from '../src/core/types.js';
import { GameRenderer } from '../src/render/renderer.js';
import { createActivity, makeTrainingBot } from '../src/training/session.js';
import { MEDAL_CUTOFFS } from '../src/training/medals.js';

const params = new URLSearchParams(location.search);
const shot = params.get('shot');
if (shot) document.body.classList.add('shot');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const keysEl = document.getElementById('keys');

// optional siblings (dev page: fall back gracefully while other engineers are still working)
const OPTIONAL = import.meta.glob(['../src/input/keyboard.js', '../src/ui/hud.js'], { eager: true });
const KeyboardInput = OPTIONAL['../src/input/keyboard.js']?.KeyboardInput ?? null;
const Hud = OPTIONAL['../src/ui/hud.js']?.Hud ?? null;

/** Tiny local key handler used only when input/keyboard.js is missing (dev page fallback). */
class LocalKeys {
  constructor() {
    this.down = new Set(); this.events = [];
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      const map = { KeyJ: ['left', 'straight'], KeyK: ['right', 'straight'], KeyU: ['left', 'hook'], KeyI: ['right', 'hook'], KeyN: ['left', 'uppercut'], KeyM: ['right', 'uppercut'] };
      const m = map[e.code];
      if (m) this.events.push({ type: 'punch', t: performance.now(), punch: { hand: m[0], kind: m[1], target: e.shiftKey ? 'body' : 'head', power: 0.8, t: performance.now() } });
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
  }
  update() {
    const x = (this.down.has('KeyD') ? 1 : 0) - (this.down.has('KeyA') ? 1 : 0);
    const y = this.down.has('KeyS') ? -1 : 0;
    const events = this.events; this.events = [];
    return { control: { tracked: true, confidence: 1, guard: this.down.has('Space') ? 'high' : 'none', guardAmount: this.down.has('Space') ? 1 : 0, lean: { x, y, z: 0 }, head: { x: x * 0.5, y: y * 0.45 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 }, events };
  }
}

// ───────────────────────────── setup ─────────────────────────────

const bus = new EventBus();
let simNow = 0;
const clock = shot ? () => simNow : null;
let renderer;
try {
  renderer = new GameRenderer({ canvas: document.getElementById('scene'), bus, clock });
  renderer.setScene('training');
} catch (e) {
  statusEl.textContent = String(e?.message || e);
  throw e;
}
const keyboard = KeyboardInput ? new KeyboardInput({ players: 1 }).attach(window) : new LocalKeys();
const hud = Hud && params.get('hud') !== '0' ? new Hud({ root: document.getElementById('ui'), bus }) : null;

const state = {
  kind: ['bag', 'dodge', 'mitts'].includes(params.get('kind')) ? params.get('kind') : 'bag',
  botSkill: params.has('bot') ? Number(params.get('bot')) : null,
  seed: params.has('seed') ? Number(params.get('seed')) : 7,
  attempt: 0,
  act: null, bot: null, ended: null,
};
const participant = { id: 'lab', name: 'Lab Boxer', kind: 'guest' };
const trainEvents = [];
bus.on(Ev.TRAIN_EVENT, (e) => { trainEvents.push(e); if (trainEvents.length > 200) trainEvents.shift(); });
bus.on(Ev.TRAIN_END, (r) => { state.ended = r; showResult(r); });

function start(kind = state.kind) {
  state.kind = kind;
  state.attempt++;
  state.ended = null;
  resultEl.style.display = 'none';
  const opts = { bus, rng: state.seed * 1000 + state.attempt, participant };
  if (params.has('dur')) opts.durationMs = Number(params.get('dur'));
  if (params.has('ready')) opts.readyMs = Number(params.get('ready'));
  state.act = createActivity(kind, opts);
  state.bot = Number.isFinite(state.botSkill) ? makeTrainingBot(kind, { skill: state.botSkill, seed: state.seed + state.attempt }) : null;
  hud?.show('training', { training: kind, participant });
  renderButtons();
}

function inputFor(act, now) {
  if (state.bot) return state.bot.update(act.getView());
  return keyboard.update(now);
}

function showResult(r) {
  const next = ['bronze', 'silver', 'gold', 'platinum'].find((m) => r.score < MEDAL_CUTOFFS[r.kind][m]);
  const d = r.details || {};
  const extra = r.kind === 'bag' ? `${d.bags} ${d.bags === 1 ? 'bag' : 'bags'} + ${Math.round((d.partial01 || 0) * 100)}% · ${d.meets} timed · ${d.whiffs} whiffs`
    : r.kind === 'dodge' ? `${d.dodged}/${d.thrown} dodged · best streak ${d.bestStreak}`
      : `${d.hits}/${d.mitts} mitts · ${d.trainerHits} trainer hits · ${d.doublesHit}/${d.doubles} doubles`;
  resultEl.innerHTML = `<h2>${r.score}</h2><div class="medal" style="color:${({ none: '#9aa3c0', bronze: '#d98b4f', silver: '#c9d2e3', gold: '#ffc94a', platinum: '#b9f3ff' })[r.medal]}">${r.medal === 'none' ? 'no medal' : r.medal}</div>`
    + `<div class="details">${extra}${next ? `<br>${MEDAL_CUTOFFS[r.kind][next] - r.score} more for ${next}` : ''}</div>`;
  if (!shot || shot === 'done') resultEl.style.display = 'block';
}

// ───────────────────────────── panel ─────────────────────────────

const panel = document.getElementById('panel');
const buttons = {};
function addButton(id, label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { fn(); e.currentTarget.blur(); });
  panel.appendChild(b);
  buttons[id] = b;
}
function sep() { const s = document.createElement('span'); s.className = 'sep'; panel.appendChild(s); }
addButton('bag', 'Bag', () => start('bag'));
addButton('dodge', 'Dodge', () => start('dodge'));
addButton('mitts', 'Mitts', () => start('mitts'));
sep();
const bots = [['off', 'You (keys)', null], ['b', 'Bot: beginner', 0.2], ['a', 'Bot: average', 0.5], ['e', 'Bot: expert', 0.95]];
for (const [id, label, skill] of bots) addButton('bot-' + id, label, () => { state.botSkill = skill; start(); });
sep();
addButton('restart', 'Restart', () => start());
addButton('pause', 'Pause', () => { const a = state.act; if (a.isPaused()) a.resume(); else a.pause(); renderButtons(); });
addButton('finish', 'Finish', () => state.act.endNow('lab'));
sep();
addButton('script', 'Script!', () => scriptMoment());
panel.appendChild(statusEl);

function renderButtons() {
  for (const k of ['bag', 'dodge', 'mitts']) buttons[k].classList.toggle('on', state.kind === k);
  for (const [id, , skill] of bots) buttons['bot-' + id].classList.toggle('on', state.botSkill === skill || (skill === null && !Number.isFinite(state.botSkill)));
  buttons.pause.textContent = state.act?.isPaused() ? 'Resume' : 'Pause';
  buttons.script.textContent = state.kind === 'bag' ? 'Weaken bag' : state.kind === 'dodge' ? 'Throw double' : 'Both mitts';
}

/** Force an interesting moment for the current activity. */
function scriptMoment() {
  const a = state.act;
  if (!a || a.phase !== 'active') return;
  if (a.kind === 'bag' && a.bag.state === 'hanging') a.bag.hp = Math.min(a.bag.hp, a.bag.maxHp * 0.12);
  if (a.kind === 'dodge') a.throwNow({ double: true });
  if (a.kind === 'mitts') a.presentNow({ kind: 'both' });
}

keysEl.innerHTML = `<b>J/K</b> punch · <b>U/I</b> hook · <b>N/M</b> uppercut · hold <b>Shift</b> body<br><b>A/D</b> lean · <b>S</b> duck · <b>P</b> pause<br>`
  + `<b>1/2/3</b> bag/dodge/mitts · <b>R</b> restart · <b>F</b> finish · <b>X</b> script<br><b>0</b> you · <b>7/8/9</b> bot beginner/average/expert`
  + (KeyboardInput ? '' : '<br><i>(local key fallback: input/keyboard.js missing)</i>');
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const map = { Digit1: () => start('bag'), Digit2: () => start('dodge'), Digit3: () => start('mitts'), KeyR: () => start(), KeyF: () => state.act.endNow('lab'), KeyX: scriptMoment,
    Digit0: () => { state.botSkill = null; start(); }, Digit7: () => { state.botSkill = 0.2; start(); }, Digit8: () => { state.botSkill = 0.5; start(); }, Digit9: () => { state.botSkill = 0.95; start(); },
    KeyP: () => { const a = state.act; if (a.isPaused()) a.resume(); else a.pause(); renderButtons(); }, Escape: () => { const a = state.act; if (a.isPaused()) a.resume(); else a.pause(); renderButtons(); } };
  if (map[e.code]) { map[e.code](); e.preventDefault(); }
});

// ───────────────────────────── loop ─────────────────────────────

let fps = 60, lastReal = null;
function status(view) {
  const a = state.act;
  const b = view.bag, tr = view.trainer;
  const sub = a.kind === 'bag' && b ? `bag ${b.n} ${b.state} hp ${b.hp}/${b.maxHp} reach ${b.reachD.toFixed(2)} approach ${b.approach.toFixed(2)}`
    : a.kind === 'dodge' ? `trainer ${tr?.action} balls ${view.balls.map((x) => x.state[0]).join('')} streak ${view.drill.streak}`
      : `mitts ${view.mitts?.map((m) => `${m.side[0]}:${m.state}${m.height === 'low' ? '↓' : ''}`).join(' ')} trainer ${tr?.action}`;
  statusEl.textContent = `${a.kind} ${view.phase}${view.paused ? ' (paused)' : ''} · ${(view.timeLeftMs / 1000).toFixed(1)}s · score ${view.score} · combo ${view.combo} · ${state.bot ? 'bot ' + state.bot.skill : 'keys'} · ${fps.toFixed(0)} fps\n${sub}`;
}

function step(dt, draw = true, now = simNow + dt * 1000) {
  simNow = now;
  const a = state.act;
  a.update(dt, simNow, inputFor(a, simNow));
  const view = a.getView();
  renderer.renderTraining(view, dt, { draw });
  if (draw) { hud?.updateTraining(view); status(view); }
  return view;
}

function loop(real) {
  const dt = lastReal == null ? 1 / 60 : Math.min(0.1, (real - lastReal) / 1000);
  lastReal = real;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  step(dt, true, real);
  requestAnimationFrame(loop);
}

// ───────────────────────────── screenshot scenarios ─────────────────────────────

const SCENARIOS = {
  'bag-swing': { kind: 'bag', bot: 0.6, until: (v) => v.phase === 'active' && v.elapsedMs > 6500 && Math.abs(v.bag.swing.ax) > 0.06 },
  'bag-weak': { kind: 'bag', bot: 0.6, until: (v) => v.phase === 'active' && v.bag.state === 'hanging' && v.bag.hp01 < 0.15 && v.bag.lastHit && v.bag.lastHit.age < 0.05 },
  'bag-break': { kind: 'bag', bot: 0.6, until: (v) => v.bag.fallen.length > 0 && v.bag.fallen[0].age > 0.32 },
  'bag-drop': { kind: 'bag', bot: 0.6, until: (v) => v.bag.state === 'dropping' && v.bag.drop01 > 0.45 },
  'dodge-aim': { kind: 'dodge', bot: 0.6, until: (v) => v.trainer?.action === 'aim' && v.trainer.aim01 > 0.7 },
  'dodge-flight': { kind: 'dodge', bot: 0.6, until: (v) => v.balls.some((b) => b.state === 'flying' && b.flight01 > 0.55 && b.flight01 < 0.65) },
  'dodge-double': { kind: 'dodge', bot: 0.6, prep: (a) => { if (a.phase === 'active' && !a.plan && !a.balls.length) a.throwNow({ double: true, aimMs: 400, flightMs: 700 }); }, until: (v) => v.balls.length === 2 && v.balls.every((b) => b.state === 'flying') && v.balls[1].flight01 > 0.5 },
  'dodge-hit': { kind: 'dodge', bot: null, until: (v) => v.balls.some((b) => b.state === 'contact') },
  'dodge-dodge': { kind: 'dodge', bot: 0.95, until: (v) => v.balls.some((b) => b.state === 'dodged' && b.judgedAge > 0.03 && b.judgedAge < 0.08) },
  'mitts-up': { kind: 'mitts', bot: null, prep: (a) => { if (a.phase === 'active' && !a.pres) a.presentNow({ kind: 'single', side: 'left', heights: 'high', showMs: 1400 }); }, until: (v) => v.mitts.some((m) => m.live && m.timeLeft01 < 0.62) },
  'mitts-both': { kind: 'mitts', bot: null, prep: (a) => { if (a.phase === 'active' && !a.pres) a.presentNow({ kind: 'both', heights: ['high', 'high'], showMs: 1400 }); }, until: (v) => v.mitts.every((m) => m.live && m.up01 >= 1) && v.mitts[0].timeLeft01 < 0.8 },
  'mitts-low': { kind: 'mitts', bot: null, prep: (a) => { if (a.phase === 'active' && !a.pres) a.presentNow({ kind: 'single', side: 'right', heights: 'low', showMs: 1400 }); }, until: (v) => v.mitts.some((m) => m.live && m.up01 >= 1) },
  'mitts-hit': { kind: 'mitts', bot: 0.9, until: (v) => v.mitts.some((m) => m.hitAge != null && m.hitAge > 0.03 && m.hitAge < 0.07) },
  'mitts-trainer': { kind: 'mitts', bot: null, punchAt: 1.2, until: (v) => v.trainer?.phase === 'hitstun' && v.trainer.phaseProgress > 0.15 },
  done: { kind: null, bot: 0.7, dur: 12000, until: (v) => v.phase === 'done' && state.act.t - state.act.endedAt > 1200 },
};

async function runShot(name) {
  const dt = 1 / 60;
  let sc;
  if (name.startsWith('t=')) {
    const secs = Number(name.slice(2));
    sc = { kind: null, bot: Number.isFinite(state.botSkill) ? state.botSkill : 0.6, until: (v) => v.elapsedMs >= secs * 1000 };
  } else sc = SCENARIOS[name];
  if (!sc) { statusEl.textContent = `unknown shot "${name}"`; return; }
  if (sc.kind) state.kind = sc.kind;
  if (!params.has('bot')) state.botSkill = sc.bot;
  if (sc.dur && !params.has('dur')) params.set('dur', String(sc.dur));
  start(state.kind);
  let punched = false;
  for (let i = 0; i < 90 * 60; i++) {
    if (sc.prep) sc.prep(state.act);
    if (sc.punchAt && !punched && state.act.phase === 'active' && state.act.t - state.act.activeStart > sc.punchAt * 1000) {
      punched = true;
      const kb = state.bot;
      state.bot = { skill: 'script', update: () => ({ control: null, events: [{ type: 'punch', t: simNow, punch: { hand: 'right', kind: 'straight', target: 'head', power: 0.8, t: simNow } }] }) };
      step(dt, false);
      state.bot = kb;
      continue;
    }
    const v = step(dt, false);
    if (sc.until(v)) break;
    if (i % 600 === 599) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  step(0, true);
  const v = state.act.getView();
  hud?.updateTraining(v);
  status(v);
  window.__shotReady = true;
  window.__shotView = { phase: v.phase, score: v.score, kind: v.kind, t: v.t };
}

window.__training = {
  get activity() { return state.act; }, renderer, bus, start, events: trainEvents,
  setBot(skill) { state.botSkill = skill; start(); },
};

if (shot) runShot(shot);
else { start(state.kind); requestAnimationFrame(loop); }
