// PERF-06 governor, second pipe verification's residuals (merge-fix round):
//  * RG1 — quitting a bout or drill from the pause / tracking-lost card puts the hub back in menu state (the app's quit emits
//    neither APP_RESUME nor MATCH_RESULT): no bout lag on the menus, no starvation timers there.
//  * RG3 — with main-thread detection (?detector=main, the worker's fallback) an urgent switch never commits mid-round (its
//    warm-up inference freezes the render); a switch prepared in a worker that then falls back is dropped, not failed.
//  * RG4 — a delegate trial compares like with like: in-round rate against in-round rate with the same pose budget, never a
//    rate from between rounds against one from a round.
import { test, assert } from '../harness.mjs';
import { Ev } from '../../src/core/types.js';
import { HUB_TUNING } from '../../src/input/input-hub.js';
import { GovTracker, TwoPhaseTracker, govHub, run, intoActivity, flush } from './helpers/hub-fakes.mjs';

const T = HUB_TUNING;
const S = (o) => GovTracker.stats(o);

async function intoBout(hub, bus, t, from = 0) {
  let now = await intoActivity(hub, t, from);
  bus.emit(Ev.MATCH_INTRO, { tutorial: false });
  bus.emit(Ev.MATCH_ROUND_START, { round: 1 });
  bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  return run(hub, t, now, 1200);
}
const roundEnd = (bus, round = 1) => { bus.emit(Ev.MATCH_BELL, { kind: 'end', round }); bus.emit(Ev.MATCH_ROUND_END, { round }); };
const roundStart = (bus, round = 2) => { bus.emit(Ev.MATCH_ROUND_START, { round }); bus.emit(Ev.MATCH_BELL, { kind: 'start', round }); };
async function runAsync(hub, t, now, ms) {
  const end = now + ms;
  while (now < end) { now = run(hub, t, now, Math.min(500, end - now)); await flush(); }
  return now;
}

// ───────────────────────────── RG1 ─────────────────────────────

test('RG1 quit from the pause card: the hub is back in menu state (no bout lag, no starvation timers on the menus)', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  bus.emit(Ev.APP_PAUSE, { reason: 'user' });
  bus.emit(Ev.APP_SCREEN, { screen: 'pause' });
  assert(hub._paused && hub._fighting && hub._session && hub.safeToSwitch, 'paused over the bout');
  bus.emit(Ev.APP_SCREEN, { screen: 'pause' }); // the card again (the picture dropped out): still the same paused bout
  assert(hub._paused && hub._session);
  // Quit: ui.hide() (screen null), then the menu; no APP_RESUME, no MATCH_RESULT
  bus.emit(Ev.APP_SCREEN, { screen: null });
  assert(hub._paused && hub._session, 'hiding the card alone decides nothing (a resume hides it too)');
  bus.emit(Ev.APP_SCREEN, { screen: 'mode' });
  assert(!hub._fighting && !hub._paused && !hub._session && hub.safeToSwitch, JSON.stringify({ f: hub._fighting, p: hub._paused, s: hub._session }));
  // the verifier's quitFromPause: 30 poses/s at a 28 ms median on the menu is fine (lag counts only in a bout)
  t.stats = S({ detFps: 30, p50: 28 });
  now = run(hub, t, now, 2500);
  const p = hub.renderPressure;
  assert(!p.behind && !p.session && p.headroom, JSON.stringify(p));
  // starved on the menu: nothing is timed, nothing wished
  t.stats = S({ detFps: 16, p50: 60 });
  now = await runAsync(hub, t, now, T.liteAfterMs + 2000);
  assert(hub._starvedSince === null && hub.status.pipeline.pendingModel === null && t.calls.length === 0, JSON.stringify(t.calls));
  hub.stop();
});

test('RG1 the tracking-lost card: resume keeps the bout, "Quit to menu" ends it; a drill the same', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  await intoBout(hub, bus, t);
  bus.emit(Ev.APP_PAUSE, { reason: 'tracking' });
  bus.emit(Ev.APP_SCREEN, { screen: 'tracking-lost' });
  bus.emit(Ev.APP_SCREEN, { screen: null });
  bus.emit(Ev.APP_RESUME, {});
  assert(hub._fighting && !hub._paused && hub._session && !hub.safeToSwitch, 'resumed: the round goes on');
  bus.emit(Ev.APP_PAUSE, { reason: 'tracking' });
  bus.emit(Ev.APP_SCREEN, { screen: 'tracking-lost' });
  bus.emit(Ev.APP_SCREEN, { screen: null });
  bus.emit(Ev.APP_SCREEN, { screen: 'title' });
  assert(!hub._fighting && !hub._paused && !hub._session, 'quit to the menu');
  // a drill quit from its pause card
  bus.emit(Ev.TRAIN_START, { kind: 'bag' });
  assert(hub._fighting && hub._session && !hub.safeToSwitch);
  bus.emit(Ev.APP_PAUSE, { reason: 'user' });
  bus.emit(Ev.APP_SCREEN, { screen: 'pause' });
  bus.emit(Ev.APP_SCREEN, { screen: null });
  bus.emit(Ev.APP_SCREEN, { screen: 'training-select' });
  assert(!hub._fighting && !hub._paused && !hub._session && hub.safeToSwitch);
  hub.stop();
});

// ───────────────────────────── RG3 ─────────────────────────────

/** The two-phase fake detecting on the page's main thread (?detector=main, or a worker tracker after its fallback). */
class MainThreadTwoPhase extends TwoPhaseTracker {
  get detector() { return 'main'; }
}

test('RG3 main-thread detection: an urgent switch is neither built nor committed mid-round; it waits for the round end', async () => {
  const { hub, bus, t } = await govHub({ Tracker: MainThreadTwoPhase });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 6, p50: 160 }); // far below urgentRatio × 30
  now = await runAsync(hub, t, now, T.urgentAfterMs + T.delegateAfterMs + 2000);
  assert(t.calls.length === 0 && hub.status.pipeline.pendingModel === 'lite', `nothing mid-round (${JSON.stringify(t.calls)})`);
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert.deepEqual(t.calls.slice(0, 2), [['prepare', 'lite'], ['commit', false]], JSON.stringify(t.calls));
  assert(hub.model === 'lite' && !hub.status.pipeline.modelSwitches.at(-1).urgent, 'a safe-moment switch, not an urgent one');
  // still starved on lite: the CPU trial also waits for a safe moment
  roundStart(bus, 2);
  now = await runAsync(hub, t, now, T.urgentAfterMs + T.delegateAfterMs + 2000);
  assert(t.did('prepare').length === 1, `no CPU build mid-round (${JSON.stringify(t.calls)})`);
  roundEnd(bus, 2);
  now = await runAsync(hub, t, now, 1500);
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching.phase === 'trial', JSON.stringify(t.calls));
  roundStart(bus, 3);
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  // merge-refix RG4-SIDE: lost, but no worse than the GPU (6 against 6): it goes back at the next safe moment …
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.kept === false && e.revertAt === 'safe' && t.delegate === 'CPU' && !t.did('revert').length, JSON.stringify({ e, calls: t.calls }));
  // … or, as detection stays urgently starved, at once (the kept landmarker needs no warm-up)
  now = await runAsync(hub, t, now, T.urgentAfterMs);
  assert(t.delegate === 'GPU' && t.did('revert').length === 1 && !hub.safeToSwitch, `urgent: back mid-round (${JSON.stringify(t.calls)})`);
  hub.stop();

  // the same load with the worker swap: urgent commits mid-round (gapless) — unchanged
  const g = await govHub({ Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 6, p50: 160 });
  n = await runAsync(g.hub, g.t, n, T.urgentAfterMs + 1500);
  assert(!g.hub.safeToSwitch && g.hub.model === 'lite' && g.hub.status.pipeline.modelSwitches.at(-1).urgent === true, JSON.stringify(g.t.calls));
  g.hub.stop();
});

test('RG3 a worker that falls back to the main thread while a switch is prepared: the switch is dropped (not a failure), nothing commits', async () => {
  class Falls extends TwoPhaseTracker {
    constructor(o) { super(o); this.where = 'worker'; }
    get detector() { return this.where; }
  }
  const { hub, bus, t } = await govHub({ Tracker: Falls });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 17, p50: 58 }); // starved, not urgent
  now = await runAsync(hub, t, now, T.liteAfterMs + 1000);
  t.hold = true;
  roundEnd(bus);
  now = await runAsync(hub, t, now, 600);
  assert.deepEqual(t.calls, [['prepare', 'lite']]);
  t.where = 'main'; // the worker stopped answering: main-thread detection (the prepared worker went with it)
  t.hold = false;
  now = await runAsync(hub, t, now, 300);
  const e = hub.status.pipeline.modelSwitches[0];
  assert(e.ok === false && /main thread/.test(e.dropped) && !hub._swFails.size, JSON.stringify({ e, calls: t.calls }));
  // still a safe moment: the wish is made again and built for the main-thread detector (its commit waits for safe moments)
  now = await runAsync(hub, t, now, 1500);
  assert(t.did('commit').length === 1 && hub.model === 'lite' && hub.status.pipeline.modelSwitches.at(-1).ok === true, JSON.stringify(t.calls));
  hub.stop();
});

// ───────────────────────────── RG4 ─────────────────────────────

test('RG4 the verifier\'s trialAcrossPhases: GPU 16 poses/s in the round (22 in the break), CPU 24 in the round → kept', async () => {
  const { hub, bus, t } = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 16, p50: 60 });
  now = await runAsync(hub, t, now, 17000);
  roundEnd(bus);
  t.stats = S({ detFps: 22, p50: 40 }); // the break renders less: GPU detection recovers a bit
  now = await runAsync(hub, t, now, 1500);
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching.phase === 'trial', JSON.stringify(t.calls));
  roundStart(bus, 2);
  t.stats = S({ detFps: 24, p50: 38 }); // better than the GPU's 16 in a round
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.kept === true && e.before === 16 && e.after === 24 && e.judgedIn === 'round:1' && !e.crossContext, JSON.stringify(e));
  assert(t.delegate === 'CPU' && t.kept === null);
  hub.stop();

  // the same, but the CPU only reaches 18 in the round (below 16 × delegateGain): lost — and as it is no worse than the GPU's 16,
  // back to the GPU at the round's end, not mid-round (merge-refix RG4-SIDE)
  const g = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 16, p50: 60 });
  n = await runAsync(g.hub, g.t, n, 17000);
  roundEnd(g.bus);
  g.t.stats = S({ detFps: 22, p50: 40 });
  n = await runAsync(g.hub, g.t, n, 1500);
  roundStart(g.bus, 2);
  g.t.stats = S({ detFps: 18, p50: 48 });
  n = await runAsync(g.hub, g.t, n, T.delegateTrialMs + 1500);
  const f = g.hub.status.pipeline.delegateSwitches.at(-1);
  assert(f.kept === false && f.revertAt === 'safe' && f.before === 16 && g.t.delegate === 'CPU' && !g.hub.safeToSwitch, JSON.stringify(f));
  roundEnd(g.bus, 2);
  n = await runAsync(g.hub, g.t, n, 600);
  assert(f.reverted === true && g.t.delegate === 'GPU', JSON.stringify(f));
  g.hub.stop();

  // clearly worse in the round (12 against 16: below 16 ÷ delegateGain): back at once, mid-round — detection first
  const h = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let m = await intoBout(h.hub, h.bus, h.t);
  h.t.stats = S({ detFps: 16, p50: 60 });
  m = await runAsync(h.hub, h.t, m, 17000);
  roundEnd(h.bus);
  h.t.stats = S({ detFps: 22, p50: 40 });
  m = await runAsync(h.hub, h.t, m, 1500);
  roundStart(h.bus, 2);
  h.t.stats = S({ detFps: 12, p50: 75 });
  m = await runAsync(h.hub, h.t, m, T.delegateTrialMs + 1500);
  const k = h.hub.status.pipeline.delegateSwitches.at(-1);
  assert(k.kept === false && k.reverted === true && !k.revertAt && h.t.delegate === 'GPU' && !h.hub.safeToSwitch, JSON.stringify(k));
  h.hub.stop();
});

test('RG4-SIDE a trial that cannot win in a round is lost already between rounds: back at that safe moment, no change mid-round', async () => {
  // the merge verifier's heavy governor run: lite/GPU 20 poses/s, a CPU trial at 14 everywhere — it used to be judged (and
  // reverted) early in the next round; a round's rate is no higher than the rate between rounds, so 14 < 20 × delegateGain
  // between rounds already decides it
  const { hub, bus, t } = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 16, p50: 60 });
  now = await runAsync(hub, t, now, 17000);
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching.phase === 'trial', JSON.stringify(t.calls));
  t.stats = S({ detFps: 14, p50: 70 }); // the CPU between rounds: under 16 × delegateGain = 18.4
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.kept === false && e.early === true && e.judgedIn === 'other:1' && e.reverted === true && t.delegate === 'GPU' && hub.safeToSwitch, JSON.stringify(e));
  // a CPU that may still win in a round (22 between rounds ≥ 18.4) waits for the round (RG4: like with like)
  const g = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 16, p50: 60 });
  n = await runAsync(g.hub, g.t, n, 17000);
  roundEnd(g.bus);
  g.t.stats = S({ detFps: 22, p50: 40 });
  n = await runAsync(g.hub, g.t, n, T.delegateTrialMs + 6000);
  assert(g.t.delegate === 'CPU' && g.hub.status.pipeline.switching.phase === 'trial', 'judged in the round');
  hub.stop(); g.hub.stop();
});

test('RG4 the same pose budget: a round searching for a lost player (an extra pose) is not compared with a normal round', async () => {
  const { hub, bus, t } = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 16, p50: 60 });
  now = await runAsync(hub, t, now, 17000);
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert(t.delegate === 'CPU');
  roundStart(bus, 2);
  t.numPoses = 2; // the pose budget changed (a missing player is searched for)
  t.stats = S({ detFps: 12, p50: 70 });
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  assert(hub.status.pipeline.switching.phase === 'trial', 'no 2-pose figures of the GPU to compare with: not judged');
  t.numPoses = 1;
  t.stats = S({ detFps: 25, p50: 35 });
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.kept === true && e.judgedIn === 'round:1' && e.before === 16, JSON.stringify(e));
  hub.stop();
});

test('RG4 a start-up slow-GPU trial on the menus is judged on the menus; with no comparable figures at all, the last resort decides', async () => {
  const { hub, t } = await govHub({ Tracker: TwoPhaseTracker }); // setup: players + 1 poses, menus
  t.stats = S({ detFps: 10, p50: 120 });
  let now = await runAsync(hub, t, 0, 5000);
  t.slowGpu = { median: 120, reason: 'GPU too slow (120 ms per frame) — using CPU' };
  now = await runAsync(hub, t, now, 1500);
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching.phase === 'trial', JSON.stringify(t.calls));
  t.stats = S({ detFps: 20, p50: 45 });
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.kept === true && e.judgedIn === 'other:2' && e.before === 10, JSON.stringify(e));
  hub.stop();

  // committed between rounds, then the player quits from the pause card and stays on the menus: no round figures for the
  // CPU ever come
  const g = await govHub({ model: 'full', Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 16, p50: 60 });
  n = await runAsync(g.hub, g.t, n, 17000);
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 1500);
  assert(g.t.delegate === 'CPU' && g.hub.status.pipeline.switching.phase === 'trial');
  g.bus.emit(Ev.APP_PAUSE, { reason: 'user' }); g.bus.emit(Ev.APP_SCREEN, { screen: 'pause' });
  g.bus.emit(Ev.APP_SCREEN, { screen: null }); g.bus.emit(Ev.APP_SCREEN, { screen: 'mode' });
  g.t.stats = S({ detFps: 28, p50: 30 });
  n = await runAsync(g.hub, g.t, n, T.delegateTrialMaxMs - 10000);
  assert(g.hub.status.pipeline.switching.phase === 'trial', 'waits for a round');
  n = await runAsync(g.hub, g.t, n, 12000);
  const f = g.hub.status.pipeline.delegateSwitches.at(-1);
  assert(f.kept === true && f.crossContext === true && g.t.kept === null, JSON.stringify(f));
  g.hub.stop();
});

// ───────────────────────────── RG2: no pixel-ratio pumping ─────────────────────────────
// merge-fix: each hub context keeps its memory (a results card or the menus no longer restart the probing).
// merge-refix (the merge verifier's RG2-CPU-CEILING, RG2-TAIL, RG2-CTX):
//  * ceilings are flat — detCeilingSec; detCeilingSlowSec for a probe that held detQuickSec; detCeilingRateSec for a probe
//    that starved the RATE within detQuickSec — and never double, so sharpness after a load ends waits at most about that long;
//  * a quick probe failure doubles the continuous headroom the context needs before its next probe (evidence, not a timer);
//  * a far step counts both of its notches as detection steps and never flags the shadows without lowering them; with no GPU
//    detector reporting, nothing learnt for it (ceilings, the headroom requirement) holds the steps back;
//  * the level a context settled at is the one it held detGoodSec without a detection step — also at the lag floor with
//    detection still behind (the verifier's live bout) — so bout → menus → bout goes straight back, in one change.

import { AdaptiveQuality, ADAPTIVE_TUNING as AT } from '../../src/render/adaptive.js';

/** Frames at 60 fps for `sec`, the pressure fixed or computed per frame; returns the changes with their run time. */
function feed(q, sec, p) {
  const out = [];
  for (let t = 0; t < sec; t += 1 / 60) {
    q.setDetectionPressure(typeof p === 'function' ? p(q) : p);
    const c = q.frame(1 / 60);
    if (c) out.push({ at: +q._run.toFixed(2), ...c });
  }
  return out;
}
const P = (o = {}) => ({ behind: false, rateBehind: false, headroom: false, gpu: true, judged: true, activity: true, session: true, detFps: 30, wantFps: 30, detMs: 20, ...o });
const RATE = P({ behind: true, rateBehind: true, detFps: 20, detMs: 45 });
const LAG = P({ behind: true, detMs: 28 });
const HEAD = P({ headroom: true, detMs: 14 });
const OKP = P({ detMs: 21 });
const quiet = () => new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } });
const ups = (ch) => ch.filter((c) => c.dir === 'up');

/**
 * The modelled GPU detector of the merge-fix / merge verifier simulations (their sim-adaptive.mjs / sim-rg2-vm.mjs): the median
 * per render level from the second pipe verification's live L1 run, a slowly varying scene picking within the range, an
 * external load and a detector speed multiplying it; the hub's real judgement (2 s window, behind < 27 poses/s or a bout
 * median > 25 ms, headroom ≥ 29.1 poses/s and ≤ 18 ms in a bout / 30 ms elsewhere). ctxAt(t) → {session, activity, load?}.
 * Returns the changes' times and pixel ratios.
 */
function model(q, secs, ctxAt, { seed = 1, speed = 1 } = {}) {
  const RANGE = { 2: [55, 75], 1.75: [25, 32], 1.5: [16.5, 28], 1.25: [14.5, 18], 1: [12, 15] };
  const SETUP = { 2: [24, 30], 1.75: [22, 28], 1.5: [20, 26], 1.25: [19, 24], 1: [18, 22] };
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let sc = 0.4, lastAct = null, judgeAt = 0, gov = 0, pr = null, busy = 0, cam = 0;
  const dets = [], changes = [];
  for (let t = 0; t < secs; t += 1 / 60) {
    const ctx = ctxAt(t);
    sc = Math.max(0, Math.min(1, sc + (0.4 - sc) / 360 + (rnd() - 0.5) * 0.09));
    if (ctx.activity !== lastAct) { judgeAt = t + 1; dets.length = 0; lastAct = ctx.activity; }
    while (cam <= t) {
      if (cam >= busy) {
        const [lo, hi] = (ctx.activity ? RANGE : SETUP)[q.pixelRatio] || RANGE[1];
        const ms = (lo + (hi - lo) * sc) * (q.shadowLowered ? 0.9 : 1) * (ctx.load ?? 1) * speed;
        busy = cam + ms / 1000; dets.push([busy, ms]);
      }
      cam += 1 / 30;
    }
    if (t - gov >= 0.25) {
      gov = t;
      while (dets.length && dets[0][0] < t - 2) dets.shift();
      const done = dets.filter((d) => d[0] <= t);
      const judged = t >= judgeAt && done.length >= 15;
      const fps = done.length / 2, p50 = done.length ? done.map((d) => d[1]).sort((a, b) => a - b)[done.length >> 1] : null;
      const bout = ctx.activity && ctx.session;
      const behind = judged && (fps < 27 || (bout && p50 > 25));
      pr = P({ behind, rateBehind: judged && fps < 27, headroom: judged && !behind && fps >= 29.1 && p50 <= (bout ? 18 : 30), judged, session: ctx.session, activity: ctx.activity, detFps: fps, detMs: p50 });
    }
    q.setDetectionPressure(pr);
    const c = q.frame(1 / 60);
    if (c && (c.pixelRatio != null || c.shadow)) changes.push({ t: +t.toFixed(2), pr: q.pixelRatio });
  }
  return changes;
}

test('RG2 a probe that holds detQuickSec and then starves detection: off-limits for detCeilingSlowSec, then retried as soon as that ends', () => {
  const q = quiet();
  feed(q, 3.2, RATE);
  assert(q.pixelRatio === 1.75 && q.state().ceiling === null, 'a first step from a level just entered: no ceiling');
  const up = feed(q, 13, HEAD);
  assert(up.length === 1 && q.pixelRatio === 2);
  feed(q, 40, OKP); // the probe holds 40 s (past detQuickSec) …
  feed(q, 3.2, LAG); // … then a heavier scene starves detection (it used to be retried every ≈ 25 s)
  const c = q.state().ceiling;
  assert(q.pixelRatio === 1.75 && c && c.steps === 1 && c.of === AT.detCeilingSlowSec, JSON.stringify(c));
  assert(q.state().remembered.waitSec === AT.upAfterSec, 'a slow failure does not raise the headroom the context needs');
  const until = q._run + c.sec;
  assert.deepEqual(ups(feed(q, c.sec - 5, HEAD)), [], 'not retried while the ceiling holds');
  // the headroom counted while the ceiling held the step back carries over: the step comes right when it ends
  const after = ups(feed(q, 20, HEAD));
  assert(after.length === 1 && after[0].at >= until && after[0].at - until <= AT.windowSec + 0.05, `${JSON.stringify(after)} vs ${until}`);
});

test('RG2 a probe that starves detection within detQuickSec: detCeilingSec, twice the headroom before the next probe (up to upMaxSec); a probe that holds detProbeOkSec resets it', () => {
  const q = quiet();
  feed(q, 3.2, RATE);
  feed(q, 13, HEAD);
  assert(q.pixelRatio === 2);
  feed(q, 3.2, LAG); // undone within a few seconds (lag)
  const c = q.state().ceiling;
  assert(c && c.of === AT.detCeilingSec && q.state().remembered.waitSec === 2 * AT.upAfterSec, JSON.stringify(q.state()));
  // after the ceiling the probe needs 2 × upAfterSec of continuous headroom: headroom broken every 15 s never gets there
  let n = 0;
  const broken = feed(q, AT.detCeilingSec + 60, () => ((n++ % 900) < 840 ? HEAD : OKP));
  assert.deepEqual(ups(broken), [], JSON.stringify(broken));
  const steady = ups(feed(q, 2 * AT.upAfterSec + 6, HEAD));
  assert(steady.length === 1 && q.pixelRatio === 2, JSON.stringify(steady));
  feed(q, 3.2, LAG); // quick again: four times upAfterSec …
  assert(q.state().remembered.waitSec === 4 * AT.upAfterSec);
  // headroom until the next probe, then starved again right away
  const probe = () => feed(q, AT.detCeilingSec + AT.upMaxSec + 5, (qq) => (qq.pixelRatio === 2 ? LAG : HEAD));
  for (let i = 0; i < 4; i++) probe();
  assert(q.state().remembered.waitSec === AT.upMaxSec, `… capped at upMaxSec (${q.state().remembered.waitSec})`);
  feed(q, AT.detCeilingSec + AT.upMaxSec + 5, (qq) => (qq.pixelRatio === 2 ? OKP : HEAD));
  assert(q.pixelRatio === 2);
  feed(q, AT.detProbeOkSec + 2, OKP); // this probe holds
  assert(q.state().remembered.waitSec === AT.upAfterSec, 'back to upAfterSec once a probe holds detProbeOkSec');
});

test('RG2 a probe that starves the RATE within detQuickSec (e.g. the step to pixel ratio 2 on a Retina screen): off-limits for detCeilingRateSec', () => {
  const q = quiet();
  feed(q, 3.2, RATE);
  feed(q, 13, HEAD);
  assert(q.pixelRatio === 2);
  feed(q, 3.2, RATE);
  const c = q.state().ceiling;
  assert(q.pixelRatio === 1.75 && c && c.of === AT.detCeilingRateSec, JSON.stringify(c));
  assert.deepEqual(ups(feed(q, AT.detCeilingSec + 60, HEAD)), [], 'still off-limits after detCeilingSec');
  // … unless the load that starved it goes away (the early lift): 1.75's median falls well below its reference
  feed(q, 6, P({ headroom: true, detMs: 16 }));
  const lifted = ups(feed(q, 30, P({ headroom: true, detMs: 9 })));
  assert(lifted.length === 1 && q.lifts === 1, JSON.stringify({ lifted, st: q.state() }));
});

test('RG2 ceiling horizons per level: a long one for pixel ratio 2 and a short one for 1.75 end on their own', () => {
  const q = quiet();
  feed(q, 3.2, RATE);
  feed(q, 13, HEAD);
  feed(q, 3.2, RATE); // the probe of 2 starved the rate: 2 off-limits for detCeilingRateSec
  assert(q.pixelRatio === 1.75 && q.state().ceiling.of === AT.detCeilingRateSec);
  feed(q, 10, OKP);
  feed(q, 3.2, LAG); // later 1.75 (held 10 s) starves too: a detCeilingSec horizon of its own
  const c = q.state().ceiling;
  assert(q.pixelRatio === 1.5 && c.steps === 2 && c.of === AT.detCeilingSec && Object.keys(c.levels).length === 2, JSON.stringify(c));
  const head = P({ headroom: true, detMs: 17 }); // headroom, but not the drop that lifts a ceiling early (the load stays)
  const mid = ups(feed(q, AT.detCeilingSec + 15, head));
  assert(mid.length === 1 && mid[0].pixelRatio === 1.75, `1.75 comes back after its own horizon (${JSON.stringify(mid)})`);
  assert(q.state().ceiling.steps === 1 && q.state().ceiling.of === AT.detCeilingRateSec, JSON.stringify(q.state().ceiling));
  assert.deepEqual(ups(feed(q, AT.detCeilingRateSec - AT.detCeilingSec - 40, head)), [], '2 still off-limits');
  assert(ups(feed(q, 60, head)).length === 1 && q.pixelRatio === 2 && q.lifts === 0, 'then 2');
});

test('RG2 the merge verifier\'s CPU case: a far step counts both notches; once detection runs on the CPU every step comes back despite the GPU ceiling', () => {
  // verify-merge/scripts/repro-cpu-ceiling.mjs: TREE stayed at pixel ratio 1.5 for the rest of a 120 s ceiling, MERGED went back to 2
  const q = quiet();
  feed(q, 4, P({ detMs: 15, headroom: true }));
  const f1 = feed(q, 1.1, P({ behind: true, rateBehind: true, detFps: 12, detMs: 80 }));
  assert(f1.length === 1 && f1[0].pixelRatio === 1.5 && q.state().detDown === 2, `far behind: two notches, both detection steps (${JSON.stringify(f1)} ${q.state().detDown})`);
  feed(q, 2, P({ detMs: 20 }));
  feed(q, 2.2, P({ behind: true, rateBehind: true, detFps: 26, detMs: 30 }));
  feed(q, 10, P({ detMs: 20 }));
  const f2 = feed(q, 1.1, P({ behind: true, rateBehind: true, detFps: 8, detMs: 150 }));
  // at 1.25 a far step has one pixel-ratio notch left: it takes that one only (it used to flag the shadows as lowered without
  // ever lowering the shadow map)
  assert(f2.length === 1 && f2[0].pixelRatio === 1 && !f2[0].shadow && !q.shadowLowered, JSON.stringify(f2));
  feed(q, 5, P({ behind: true, rateBehind: true, detFps: 8, detMs: 150 }));
  assert(q.shadowLowered && q.state().ceiling && q.state().detDown === 5, JSON.stringify(q.state()));
  const t0 = q._run;
  feed(q, 5, P({ gpu: false, behind: true, rateBehind: true, detFps: 13, detMs: 75 })); // the CPU trial was kept
  const back = feed(q, 15, P({ gpu: false, headroom: true, detFps: 30, detMs: 15 }));
  assert(q.pixelRatio === 2 && !q.shadowLowered && q.state().detDown === 0, JSON.stringify({ back, st: q.state() }));
  assert(Math.max(...back.map((c) => c.at)) - t0 <= 5 * AT.detReleaseSec + 2 * AT.windowSec, 'one detReleaseSec window per step');
  assert(q.state().ceiling, 'the GPU ceiling is kept (it applies again if detection goes back to the GPU) but does not block');
});

test('RG2 the merge verifier\'s live bout: held at the lag floor with detection still behind, that is the level it settled at — bout → menus → bout goes straight back, in one change', () => {
  const q = quiet();
  const boutLag = P({ behind: true, rateBehind: false, detMs: 31 }); // 30 poses/s, median 31 ms at every level (the live run)
  feed(q, 12, boutLag);
  assert(q.pixelRatio === AT.detLagMinRatio, `lag alone stops at detLagMinRatio (${q.pixelRatio})`);
  feed(q, AT.detGoodSec + 4, boutLag);
  assert(q.state().remembered.settled === 3, JSON.stringify(q.state().remembered));
  feed(q, 32, P({ session: false, headroom: true, detMs: 24 })); // quit to the menus: they climb (lag does not count there)
  assert(q.pixelRatio >= 1.75, `${q.pixelRatio}`);
  const entry = feed(q, 3, boutLag);
  assert(entry.length === 1 && entry[0].why === 'context' && entry[0].pixelRatio === 1.25 && entry[0].dir === 'down', JSON.stringify(entry));
  // a settled level older than detMemorySec is not jumped to (the machine may have changed)
  const r = quiet();
  feed(r, 12, boutLag);
  feed(r, AT.detGoodSec + 4, boutLag);
  feed(r, AT.detMemorySec + 10, P({ session: false, headroom: true, detMs: 24 }));
  assert(r.pixelRatio === 2);
  assert.deepEqual(feed(r, 1, boutLag).filter((c) => c.why === 'context'), []);
});

test('RG2 each context keeps its own ceiling: a results card or the menus in between restore it; nothing steps up there in passing', () => {
  const q = quiet();
  feed(q, 10, OKP);
  feed(q, 3.2, LAG); // a level held 10 s starves: ceiling
  const c0 = q.state().ceiling;
  assert(c0 && q.pixelRatio === 1.75);
  feed(q, 12, HEAD); // headroom builds up …
  const card = feed(q, 0.4, P({ headroom: true, detMs: 14, session: false })); // … a results card for 0.4 s
  assert(q.state().ceiling === null && card.length === 0, 'its own (no) ceiling, and no step up in passing');
  const back = feed(q, 2, HEAD);
  const c1 = q.state().ceiling;
  assert(back.length === 0 && c1 && c1.steps === c0.steps && q.pixelRatio === 1.75, `restored (${JSON.stringify(c1)})`);
  // the pose budget too: a tracking-lost search (setup poses) and back
  feed(q, 1, P({ headroom: true, detMs: 14, activity: false }));
  feed(q, 1, HEAD);
  assert(q.state().ceiling && q.state().ceiling.steps === c0.steps);
});

test('RG2 a quick descent (steps while the hub still shows the level above) sets no further ceiling; the overshoot is probed again after upAfterSec', () => {
  const q = quiet();
  feed(q, 10, OKP);
  const down = feed(q, 7, RATE);
  assert(down.length >= 2 && q.pixelRatio <= 1.5, JSON.stringify(down));
  const c = q.state().ceiling;
  assert(c && c.steps === 1, `only the level held ≥ detFairSec (2) gets one: ${JSON.stringify(c)}`);
  const pr = q.pixelRatio;
  const up = feed(q, 14, HEAD);
  const next = [...AT.ratios].reverse().find((x) => x > pr + 0.01);
  assert(up.length === 1 && up[0].pixelRatio === next && q.state().ceiling, `${next} was an overshoot: probed again after upAfterSec (${JSON.stringify(up)})`);
  feed(q, 60, HEAD);
  assert(q.pixelRatio === 1.75, `up to the level under the ceiling, not above (${q.pixelRatio})`);
});

test('RG2 the load that set a ceiling goes away: lifted early, sharpness back within ≈ 30 s; a load that stays keeps it', () => {
  const q = quiet();
  let load = true;
  // the detector's median at the render's level: 1.75 → 20 ms under the load, 12 ms without; 2 → 28 / 16 ms
  const p = (qq) => {
    const ms = (qq.pixelRatio > 1.9 ? 28 : 20) * (load ? 1 : 0.6);
    return P({ detMs: ms, behind: ms > 25, headroom: ms <= 18 });
  };
  feed(q, 10, OKP);
  feed(q, 6, p); // the load arrives at pixel ratio 2: lag → 1.75, ceiling
  assert(q.pixelRatio === 1.75 && q.state().ceiling, JSON.stringify(q.state()));
  feed(q, 20, p); // the load stays: reference median 20 ms at 1.75
  assert(q.state().ceiling.refMs[q.state().ceiling.steps] === 20, JSON.stringify(q.state().ceiling));
  load = false;
  const t0 = q._run;
  const up = ups(feed(q, 40, p))[0];
  assert(up && up.pixelRatio === 2 && up.at - t0 <= 30, `back at 2 after ${up && (up.at - t0).toFixed(1)} s`);
  assert(q.lifts === 1 && q.state().ceiling === null);
  const r = quiet();
  feed(r, 10, OKP);
  load = true;
  feed(r, 6, p);
  assert(ups(feed(r, 100, p)).length === 0 && r.lifts === 0);
});

test('RG2 back in a bout from the menus: straight to the level the bout settled at, in one change (a change can carry the shadows too)', () => {
  const q = quiet();
  feed(q, 12, (qq) => (qq.pixelRatio > 1.3 ? RATE : OKP)); // bout: 2 → 1.25 (three steps) …
  assert(q.pixelRatio === 1.25 && !q.shadowLowered, `${q.pixelRatio}`);
  feed(q, AT.detGoodSec + 4, OKP); // … held: remembered
  assert(q.state().remembered.settled === 3, JSON.stringify(q.state().remembered));
  const menus = feed(q, 60, P({ headroom: true, detMs: 22, session: false })); // the menus climb back up
  assert(q.pixelRatio === 2 && menus.length === 3, JSON.stringify(menus.map((c) => c.pixelRatio)));
  const entry = feed(q, 0.5, OKP);
  assert(entry.length === 1 && entry[0].pixelRatio === 1.25 && entry[0].why === 'context' && entry[0].dir === 'down', `one change (${JSON.stringify(entry)})`);
  assert(q.pixelRatio === 1.25 && q.state().steps === 3 + 3 + 3);
  const r = quiet();
  feed(r, 16, RATE);
  assert(r.shadowLowered && r.pixelRatio === 1, `${r.pixelRatio} ${r.shadowLowered}`);
  feed(r, AT.detGoodSec + 4, OKP);
  feed(r, 80, P({ headroom: true, detMs: 22, session: false }));
  assert(r.pixelRatio === 2 && !r.shadowLowered);
  const e2 = feed(r, 0.5, OKP);
  assert(e2.length === 1 && e2[0].pixelRatio === 1 && e2[0].shadow === 'low', JSON.stringify(e2));
});

test('RG2 no GPU detector reporting (it moved to the CPU): the steps come back despite a ceiling learnt for the GPU', () => {
  const q = quiet();
  feed(q, 10, OKP);
  feed(q, 3.2, LAG);
  assert(q.state().ceiling && q.pixelRatio === 1.75);
  const up = feed(q, 8, P({ gpu: false, detMs: 30, headroom: false }));
  assert(up.length === 1 && q.pixelRatio === 2, JSON.stringify(up));
});

test('RG2 the second pipe verification\'s L1 model: at most 2 pixel-ratio changes per 100 s once settled (bouts, results cards, a search between)', () => {
  const ctxAt = (s) => { const b = (s - 1.5) % 34; return s < 1.5 ? { session: false, activity: false } : b < 0.7 ? { session: true, activity: false } : b < 33.6 ? { session: true, activity: true } : { session: false, activity: true }; };
  for (const seed of [1, 4, 9]) {
    const changes = model(quiet(), 300, ctxAt, { seed }).map((c) => c.t).filter((x) => x >= 16.5);
    for (let from = 16.5; from + 100 <= 278; from += 10) {
      const n = changes.filter((x) => x >= from && x < from + 100).length;
      assert(n <= 2, `seed ${seed}: ${n} changes in ${from}–${from + 100} s (${JSON.stringify(changes)})`);
    }
  }
});

test('RG2 the merge verifier\'s RG2-TAIL model: after a 180 s load (×1.15 … ×1.5) ends, the pre-load sharpness is back within ≈ detCeilingSec + 40 s (it was up to 271 s)', () => {
  // a faster detector (speed 0.75: the bout settles at 1.75), the load from 60 to 240 s; the merge verifier's worst seeds
  const cases = [[1.15, 6], [1.35, 7], [1.35, 9], [1.5, 5], [1.5, 10], [1.25, 2]];
  for (const [X, seed] of cases) {
    const ch = model(quiet(), 700, (t) => ({ session: true, activity: true, load: t >= 60 && t < 240 ? X : 1 }), { seed, speed: 0.75 });
    const prAt = (t) => { let pr = 2; for (const c of ch) if (c.t <= t) pr = c.pr; return pr; };
    const steady = prAt(59.9);
    const back = prAt(240.01) >= steady ? 240 : (ch.find((c) => c.t > 240 && c.pr >= steady) || { t: Infinity }).t;
    assert(back - 240 <= AT.detCeilingSec + 40, `×${X} seed ${seed}: back at ${steady} after ${(back - 240).toFixed(1)} s (${JSON.stringify(ch)})`);
  }
});
