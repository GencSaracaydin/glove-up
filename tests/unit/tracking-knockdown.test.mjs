// Opponent down (a player's request, 2026-11-13): while a player's opponent is down for the count, the player may leave
// the picture — no "Please keep your hands visible", no tracking-lost card. Once the opponent is up, a player still out
// of sight gets the usual warning (HUB_TUNING.lostMs) and then the card. The player who is down still needs tracking
// (pumping the arms gets them up). A real MatchSession + Match, and the real App methods on a shell object.
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { MatchPhase } from '../../src/core/types.js';
import { ROSTER } from '../../src/game/roster.js';
import { MatchSession, TrainingRun } from '../../src/app/session.js';
import { HUB_TUNING } from '../../src/input/input-hub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// app.js pulls in the screen registry, whose import.meta.glob only Vite understands (as in ui-repair-flows.test.mjs)
const GLOB_HOOK = 'data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!/\\/src\\/ui\\/screens\\/deps\\.js$/.test(url)) return r;
  const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  return { ...r, source: src.replace(/import\\.meta\\.glob\\(\\[[\\s\\S]*?\\]\\)/, '({})') };
}`);
let App, APP_TUNING, loadError = null;
try {
  if (typeof nodeModule.register !== 'function') throw new Error('node:module register() is missing (Node ≥ 20.6 needed)');
  nodeModule.register(GLOB_HOOK);
  ({ App, APP_TUNING } = await import('../../src/app/app.js'));
} catch (e) { loadError = e; }
const loaded = () => assert(!loadError, `could not load src/app/app.js in Node: ${loadError?.message}`);

const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.1, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.1, reach: 0.1, punching: false } },
  activity: 0, ...o,
});
const profile = (id, name) => ({ id, name, kind: 'guest', appearance: null, skill: 0, records: {} });
const fakeRenderer = () => ({ timeScale: 1, resetMatch() {}, setSplit() {}, setScene() {}, renderMatch() {}, renderTraining() {} });
const fakeHud = () => ({ show() {}, hide() {}, update() {}, updateTraining() {} });

function bout(mode = 'single', seed = 5) {
  const players = mode === 'versus' ? [profile('a', 'Ann'), profile('b', 'Bo')] : [profile('a', 'Ann')];
  const s = new MatchSession({ bus: new EventBus(), renderer: fakeRenderer(), hud: fakeHud(), mode, players, opponent: ROSTER[0], seed, fast: true });
  s.begin();
  return s;
}

/**
 * The real App methods (_watchTracking, _hudExtras, _trackingFree) on a shell around a real session, frame by frame on a
 * fake clock (performance.now() is the app's clock). away(t) says whether player 0 is out of the picture at time t: the
 * recognizer then reports tracked:false and no pose; the hub's debounced state follows HUB_TUNING.lostMs later.
 */
function drive(s, { away }) {
  const app = Object.create(App.prototype);
  const pauses = [];
  Object.assign(app, {
    session: s, _play: { resolve() {}, reject() {} }, _pausing: false,
    _lostSince: [null, null], _noPoseSince: [null, null], _freeEnd: [null, null],
    input: { mode: 'camera', tuning: { lostMs: HUB_TUNING.lostMs, staleFrameMs: 500 } },
    requestPause(reason, o = {}) { pauses.push({ reason, player: o.player ?? 0, t: clock }); this._pausing = true; return Promise.resolve(true); },
  });
  let clock = 10000, awaySince = null;
  const realNow = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { value: () => clock, configurable: true, writable: true });
  const frames = [];
  const step = (ms = 16) => {
    clock += ms;
    const out = !!away(clock, s);
    awaySince = out ? (awaySince ?? clock) : null;
    const hubTracked = !(out && clock - awaySince >= HUB_TUNING.lostMs);
    if (!app._pausing) app._watchTracking(clock, { tracking: [hubTracked, true] });
    const input = { control: ctl({ tracked: !out }), events: [] };
    if (!s.paused) s.update(ms / 1000, clock, s.humans === 2 ? [input, { control: ctl(), events: [] }] : [input]);
    const ex = app._hudExtras({
      players: [{ control: { tracked: !out, confidence: out ? 0 : 1 } }, ...(s.humans === 2 ? [{ control: { tracked: true, confidence: 1 } }] : [])],
      status: { phase: 'running', frameAgeMs: 30, presence: [!out, true], tracking: [hubTracked, true] },
    });
    frames.push({ t: clock, phase: s.match.phase, warn: !!ex.handsWarning?.[0], hubTracked });
  };
  const restore = () => { if (realNow) Object.defineProperty(performance, 'now', realNow); else delete performance.now; };
  return { app, pauses, frames, step, restore, get clock() { return clock; } };
}

function toFighting(s) {
  for (let i = 0; i < 4000 && s.match.phase !== MatchPhase.FIGHTING; i++) s.update(0.016, 1000 + i * 16, [{ control: ctl(), events: [] }, { control: ctl(), events: [] }]);
  assert.equal(s.match.phase, MatchPhase.FIGHTING, 'the bout is live');
}

test('opponent down: the player may leave the picture — no hands warning, no tracking-lost card during the count', () => {
  loaded();
  const s = bout();
  toFighting(s);
  const d = drive(s, { away: () => true });
  try {
    assert(s.match.debugKnockdown('p2', { stayDown: false, riseCount: 6 }), 'the opponent is down');
    assert.equal(s.trackingOptional(0), true, 'the player may leave the picture');
    let guard = 0;
    while (s.match.phase === MatchPhase.KNOCKDOWN && guard++ < 1000) d.step();
    const count = d.frames.filter((f) => f.phase === MatchPhase.KNOCKDOWN);
    assert(count.length > 60, `a real count went by (${count.length} frames)`);
    assert(count.some((f) => !f.hubTracked), 'the hub lost the player during the count (the path was exercised)');
    assert(count.every((f) => !f.warn), 'no hands warning while the opponent is down');
    assert.equal(d.pauses.length, 0, 'no tracking-lost card while the opponent is down');
    assert.equal(s.match.phase, MatchPhase.RECOVERY, 'the opponent got up');
  } finally { d.restore(); }
});

test('opponent up again: a player still out of sight gets the warning at once, then the card after the usual second', () => {
  loaded();
  const s = bout('single', 7);
  toFighting(s);
  const d = drive(s, { away: () => true });
  try {
    s.match.debugKnockdown('p2', { stayDown: false, riseCount: 4 });
    let guard = 0;
    while (s.match.phase === MatchPhase.KNOCKDOWN && guard++ < 1000) d.step();
    const upAt = d.clock;
    while (!d.pauses.length && d.clock - upAt < 4000) d.step();
    const after = d.frames.filter((f) => f.t > upAt);
    assert(after[0].warn, 'the warning shows as soon as the opponent is up');
    assert.equal(d.pauses.length, 1, 'then the tracking-lost card');
    const wait = d.pauses[0].t - upAt;
    assert.equal(d.pauses[0].reason, 'tracking');
    assert(wait >= HUB_TUNING.lostMs && wait <= HUB_TUNING.lostMs + APP_TUNING.trackingGraceMs + 50,
      `the card ${wait} ms after the opponent got up (the usual ${HUB_TUNING.lostMs} ms of warning first)`);
  } finally { d.restore(); }
});

test('opponent up again: a player who is back within that second is never paused', () => {
  loaded();
  const s = bout('single', 9);
  toFighting(s);
  let upAt = null;
  const d = drive(s, { away: (t, ses) => { if (upAt === null && ses.match.phase === MatchPhase.RECOVERY) upAt = t; return upAt === null || t - upAt < 600; } });
  try {
    s.match.debugKnockdown('p2', { stayDown: false, riseCount: 4 });
    for (let i = 0; i < 400; i++) d.step();
    assert(upAt !== null, 'the opponent got up');
    assert.equal(d.pauses.length, 0, 'back 0.6 s after the opponent got up: no card');
  } finally { d.restore(); }
});

test('the player who is down still needs tracking: out of sight during their own count → the warning and the card', () => {
  loaded();
  const s = bout('single', 11);
  toFighting(s);
  const d = drive(s, { away: () => true });
  try {
    s.match.debugKnockdown('p1');
    assert.equal(s.trackingOptional(0), false);
    for (let i = 0; i < 200 && !d.pauses.length; i++) d.step();
    assert(d.frames.some((f) => f.warn), 'the hands warning shows');
    assert.equal(d.pauses.length, 1, 'and the card follows');
  } finally { d.restore(); }
});

test('trackingOptional: per player in versus, never once the bout is decided, never while paused, never in drills', () => {
  const v = bout('versus', 13);
  toFighting(v);
  assert(v.match.debugKnockdown('p2', { stayDown: false }));
  assert.deepEqual([v.trackingOptional(0), v.trackingOptional(1)], [true, false], 'P2 is down: P1 may leave, P2 must pump');
  v.pause();
  assert.equal(v.trackingOptional(0), false, 'paused');
  v.resume();
  const k = bout('single', 15);
  toFighting(k);
  // a 4th knockdown always stays down: counted out → the result is locked
  for (let n = 0; n < 3; n++) {
    k.match.debugKnockdown('p2', { stayDown: false, riseCount: 1 });
    for (let i = 0; i < 3000 && k.match.phase !== MatchPhase.FIGHTING; i++) k.update(0.016, 50000 + n * 60000 + i * 16, [{ control: ctl(), events: [] }]);
  }
  k.match.debugKnockdown('p2');
  for (let i = 0; i < 3000 && !k.match.isOver(); i++) k.update(0.016, 300000 + i * 16, [{ control: ctl(), events: [] }]);
  assert(k.match.isOver(), 'counted out');
  assert.equal(k.trackingOptional(0), false, 'a decided bout: no exemption (nor any pause)');
  assert.equal(TrainingRun.prototype.trackingOptional.call({}), false, 'drills have no knockdowns');
});

test('the tracking-lost event (the hub\'s debounced "lost") respects the exemption too', () => {
  const app = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  assert(/bus\.on\(Ev\.INPUT_TRACKING_LOST, \(e\) => \{[\s\S]{0,300}!this\._trackingFree\(i, nowMs\(\)\)\) this\.requestPause\('tracking'/.test(app),
    'INPUT_TRACKING_LOST pauses only when the player\'s tracking is not optional (nor just after)');
});
