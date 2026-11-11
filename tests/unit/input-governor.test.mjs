// PERF-06 governor (pipe-refix: the verifier's R1–R9):
//  * R1 — the auto model goes lite only when detection is STARVED (rate), never for lag at the full rate; it waits for the
//    render's steps (atFloor) first; it comes back to full when lite's median predicts that full keeps up; full is on
//    probation with lite still loaded (starved again → back at once, the next try waits twice as long).
//  * R2 — no safe moment from MATCH_INTRO (the first-bout tutorial, the intro) until a round ends; MATCH_BELL 'start' too.
//  * R3 — two-phase switches: the new landmarker is prepared while the running one keeps detecting (poses keep flowing) —
//    for the worker tracker in a second worker, primed with a real frame, swapped in with no pause —, the commit waits for
//    a safe moment (or severe starvation), a lost delegate trial goes back at once (mid-round), a stuck prepare is dropped.
//  * R4 / R6 — the camera opens at 30; 60 only while the detector takes every frame as it arrives; the model never
//    changes for the camera's sake (no stale 'lite' wish).
//  * R5 — the start-up slow-GPU verdict is left to the hub (switch gate) and made at a safe moment, as a trial.
//  * R7 / R9 — adaptive: lag alone only takes the cheap steps; a CPU detector opens the step-up gate and detection steps
//    come back quickly; another session is another context (its own ceiling; merge-fix RG2 keeps each context's ceiling
//    for when it comes back, input-governor-rg.test.mjs); a detection step reports the real frame time.
//  (merge-fix RG4: a delegate trial is judged in a round when its old landmarker was measured in one — the won trial below.)
//  * R8 — a failed switch backs off (doubling) and is given up after a few; a missing model file at once; one warning.
import { test, assert } from '../harness.mjs';
import { Ev } from '../../src/core/types.js';
import { HUB_TUNING } from '../../src/input/input-hub.js';
import { PoseTracker, TrackerError } from '../../src/input/pose-tracker.js';
import { WorkerPoseTracker } from '../../src/input/pose-worker-tracker.js';
import { packResult } from '../../src/input/pose-worker-codec.js';
import { AdaptiveQuality, ADAPTIVE_TUNING } from '../../src/render/adaptive.js';
import { FakeRecognizer, GovTracker, TwoPhaseTracker, fakeCam, govHub, run, intoActivity, flush } from './helpers/hub-fakes.mjs';

const T = HUB_TUNING;
const S = (o) => GovTracker.stats(o);

/** Into a bout: the activity pose budget, the intro (a live session, not a safe moment), then round 1. */
async function intoBout(hub, bus, t, from = 0) {
  let now = await intoActivity(hub, t, from);
  bus.emit(Ev.MATCH_INTRO, { tutorial: false });
  bus.emit(Ev.MATCH_ROUND_START, { round: 1 });
  bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  now = run(hub, t, now, 1200); // past the pose switch's settle time
  return now;
}
const roundEnd = (bus, round = 1) => { bus.emit(Ev.MATCH_BELL, { kind: 'end', round }); bus.emit(Ev.MATCH_ROUND_END, { round }); };
const roundStart = (bus, round = 2) => { bus.emit(Ev.MATCH_ROUND_START, { round }); bus.emit(Ev.MATCH_BELL, { kind: 'start', round }); };
/** Run, letting the switch promises settle every half second. */
async function runAsync(hub, t, now, ms) {
  const end = now + ms;
  while (now < end) { now = run(hub, t, now, Math.min(500, end - now)); await flush(); }
  return now;
}
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(() => fn(lines)).finally(() => { console.warn = orig; });
}

// ───────────────────────────── R1: the auto model ─────────────────────────────

test('R1 auto model: 30 poses/s at a 26 ms median (lag, not starvation) never goes lite; the render pressure still reports the lag', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 30, p50: 26 });
  now = await runAsync(hub, t, now, 9000);
  const p = hub.renderPressure;
  assert(p.behind && !p.rateBehind && !p.starved && p.session, `lag reported for the render (${JSON.stringify(p)})`);
  assert(hub.status.pipeline.pendingModel === null, 'no lite wish');
  roundEnd(bus);
  now = await runAsync(hub, t, now, 2000);
  for (let r = 2; r <= 3; r++) { roundStart(bus, r); now = await runAsync(hub, t, now, 60000); roundEnd(bus, r); now = await runAsync(hub, t, now, 3000); }
  assert(t.did('prepare').length === 0 && hub.model === 'full', `full kept (${JSON.stringify(t.calls)})`);
  hub.stop();
});

test('R1 auto model: starved → lite after liteAfterMs only with the render at its floor (or liteMaxWaitMs), switched at a safe moment', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  hub.setRenderState({ atFloor: false });
  t.stats = S({ detFps: 18, p50: 55 });
  now = await runAsync(hub, t, now, T.liteAfterMs + 2000);
  assert(hub.status.pipeline.pendingModel === null, 'the render still has steps to give: no lite yet');
  hub.setRenderState({ atFloor: true });
  now = await runAsync(hub, t, now, 600);
  assert(hub.status.pipeline.pendingModel === 'lite' && t.did('prepare').length === 0, 'wanted, nothing built during the round');
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert.deepEqual(t.calls.slice(0, 2), [['prepare', 'lite'], ['commit', false]], JSON.stringify(t.calls));
  assert(hub.model === 'lite' && hub.modelPref === 'auto');
  const sw = hub.status.pipeline.modelSwitches.at(-1);
  assert(sw.from === 'full' && sw.to === 'lite' && sw.why === 'starved' && sw.ok === true && sw.buildMs === 1500 && sw.warmMs === 300, JSON.stringify(sw));
  hub.stop();

  // the render never reaches its floor (a fixed-quality build would say atFloor: true): liteMaxWaitMs is the limit
  const g = await govHub({ Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.hub.setRenderState({ atFloor: false });
  g.t.stats = S({ detFps: 18, p50: 55 });
  n = await runAsync(g.hub, g.t, n, T.liteMaxWaitMs - 2000);
  assert(g.hub.status.pipeline.pendingModel === null);
  n = await runAsync(g.hub, g.t, n, 3000);
  assert(g.hub.status.pipeline.pendingModel === 'lite', 'starved for liteMaxWaitMs: lite anyway');
  // the starvation ends before a safe moment: the wish is withdrawn (nothing stale switches later)
  g.t.stats = S({ detFps: 29, p50: 30 });
  n = await runAsync(g.hub, g.t, n, 1000);
  assert(g.hub.status.pipeline.pendingModel === null, 'withdrawn');
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 2000);
  assert(g.t.calls.length === 0 && g.hub.model === 'full', JSON.stringify(g.t.calls));
  g.hub.stop();
});

test('R1 auto model: back to full when lite predicts it keeps up; full on probation, starved again → lite at once mid-round, next try waits twice as long', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 16, p50: 55 });
  now = await runAsync(hub, t, now, T.liteAfterMs + 1000);
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert(hub.model === 'lite');
  roundStart(bus, 2);
  // lite at 20 ms: full / lite measured as 55 / 20 → the ratio is capped at fullCostRatioMax (2.2): 44 ms predicted, too slow
  t.stats = S({ detFps: 30, p50: 20 });
  now = await runAsync(hub, t, now, 3000);
  assert(Math.abs(hub.status.pipeline.fullCostRatio - T.fullCostRatioMax) < 0.01, `ratio ${hub.status.pipeline.fullCostRatio}`);
  now = await runAsync(hub, t, now, T.fullAfterMs + 5000);
  assert(hub.status.pipeline.pendingModel === null, 'full would not keep up');
  // the load goes away: lite at 11 ms → full predicted at 24 ms ≤ 0.8 × 33 ms
  t.stats = S({ detFps: 30, p50: 11 });
  now = await runAsync(hub, t, now, T.fullAfterMs + 1000);
  assert(hub.status.pipeline.pendingModel === 'full' && t.did('prepare').length === 1, 'wanted, not during the round');
  roundEnd(bus, 2);
  now = await runAsync(hub, t, now, 1500);
  assert(hub.model === 'full' && t.kept && t.kept.model === 'lite', 'full is back, lite kept loaded (probation)');
  assert(hub.status.pipeline.switching && hub.status.pipeline.switching.phase === 'probation');
  roundStart(bus, 3);
  t.stats = S({ detFps: 17, p50: 50 });
  now = await runAsync(hub, t, now, T.liteAfterMs + 1500);
  assert(!hub.safeToSwitch && hub.model === 'lite' && t.did('revert').length === 1, `back to lite at once, mid-round (${JSON.stringify(t.calls)})`);
  assert(hub._fullWaitMs === 2 * T.fullAfterMs, `next try waits ${hub._fullWaitMs}`);
  hub.stop();

  // a full that keeps up through its probation stays, and lite is dropped
  const g = await govHub({ Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 16, p50: 40 });
  n = await runAsync(g.hub, g.t, n, T.liteAfterMs + 1000);
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 1500);
  g.t.stats = S({ detFps: 30, p50: 10 });
  n = await runAsync(g.hub, g.t, n, T.fullAfterMs + 3000);
  assert(g.hub.model === 'full');
  n = await runAsync(g.hub, g.t, n, T.fullProbationMs + 1000);
  assert(g.hub.status.pipeline.switching === null && g.t.kept === null && g.hub.status.pipeline.modelSwitches.at(-1).kept === true, JSON.stringify(g.t.calls));
  g.hub.stop();
});

// ───────────────────────────── R2: safe moments ─────────────────────────────

test('R2 safe moments: none from MATCH_INTRO (tutorial or not) until a round ends; the bell starts rounds and restarts; pause and results are safe', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoActivity(hub, t);
  assert(hub.safeToSwitch, 'menus');
  bus.emit(Ev.MATCH_INTRO, { tutorial: true });
  assert(!hub.safeToSwitch, 'the first-bout tutorial is live');
  t.stats = S({ detFps: 18, p50: 55 }); // starved (< 24 poses/s), not urgent (≥ 15)
  now = await runAsync(hub, t, now, 25000);
  assert(hub.status.pipeline.pendingModel === 'lite' && t.calls.length === 0, `wanted, never during the tutorial (${JSON.stringify(t.calls)})`);
  bus.emit(Ev.APP_PAUSE, { reason: 'user' });
  assert(hub.safeToSwitch, 'paused');
  bus.emit(Ev.APP_RESUME, {});
  assert(!hub.safeToSwitch);
  // the tutorial ends: round 1 starts at once ("Fight!"), still no safe moment; its end is one
  bus.emit(Ev.MATCH_ROUND_START, { round: 1 }); bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  assert(!hub.safeToSwitch);
  roundEnd(bus);
  assert(hub.safeToSwitch, 'between rounds');
  bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1, restart: true });
  assert(!hub.safeToSwitch, 'a restart after a knockdown is live');
  bus.emit(Ev.MATCH_RESULT, {});
  assert(hub.safeToSwitch, 'after the bout');
  // the verifier's repro: MATCH_INTRO without a payload is not safe either
  bus.emit(Ev.MATCH_INTRO, {});
  assert(!hub.safeToSwitch);
  hub.stop();
});

// ───────────────────────────── R3: two-phase switches ─────────────────────────────

test('R3 two-phase: poses keep flowing while the new landmarker builds; the commit waits for a safe moment; a lost trial goes back at the round end (at once when clearly worse)', async () => {
  const { hub, bus, t } = await govHub({ model: 'lite', Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 17, p50: 58 }); // starved, not urgent
  now = await runAsync(hub, t, now, T.delegateAfterMs + 1000);
  assert(hub.status.pipeline.pendingDelegate === 'CPU' && t.calls.length === 0, 'wanted, not during the round');
  t.hold = true;
  roundEnd(bus);
  now = await runAsync(hub, t, now, 500);
  assert.deepEqual(t.calls, [['prepare', 'CPU']], 'built at the safe moment');
  roundStart(bus, 2); // the round starts while it builds
  const before = FakeRecognizer.last.calls.length;
  now = await runAsync(hub, t, now, 2000);
  assert(FakeRecognizer.last.calls.length - before >= 35, `poses kept flowing while it built (${FakeRecognizer.last.calls.length - before})`);
  t.release();
  now = await runAsync(hub, t, now, 3000);
  assert(t.did('commit').length === 0 && hub.status.pipeline.switching.phase === 'ready', 'ready mid-round: not committed');
  roundEnd(bus, 2);
  now = await runAsync(hub, t, now, 600);
  assert.deepEqual(t.did('commit'), [['commit', true]], 'committed at the round end, the GPU landmarker kept');
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching.phase === 'trial');
  roundStart(bus, 3);
  t.stats = S({ detFps: 18, p50: 52 }); // not clearly faster than the GPU's 17 — nor worse
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  // merge-refix RG4-SIDE: lost, but no worse than the GPU: back at the round's end, not mid-round
  assert(!hub.safeToSwitch && t.delegate === 'CPU' && t.did('revert').length === 0, `lost trial: waits for the round end (${JSON.stringify(t.calls)})`);
  assert(hub._delegateWait === 2 * T.delegateAfterMs, `wait doubled (${hub._delegateWait})`);
  const e = hub.status.pipeline.delegateSwitches.at(-1);
  assert(e.from === 'GPU' && e.to === 'CPU' && e.kept === false && e.revertAt === 'safe' && !e.reverted, JSON.stringify(e));
  roundEnd(bus, 3);
  now = await runAsync(hub, t, now, 600);
  assert(t.delegate === 'GPU' && t.did('revert').length === 1 && e.reverted === true, `back at the round end (${JSON.stringify(t.calls)})`);
  hub.stop();

  // a won trial keeps the CPU and drops the GPU landmarker (RG4: judged in the next round, like the GPU's 17 poses/s)
  const g = await govHub({ model: 'lite', Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 17, p50: 58 });
  n = await runAsync(g.hub, g.t, n, T.delegateAfterMs + 1000);
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 1500);
  assert(g.t.delegate === 'CPU', 'committed with the GPU\'s 17 poses/s as the bar');
  g.t.stats = S({ detFps: 26, p50: 30 });
  n = await runAsync(g.hub, g.t, n, T.delegateTrialMs + 1500);
  assert(g.hub.status.pipeline.switching.phase === 'trial', 'a long break is not a round: no verdict there');
  roundStart(g.bus, 2);
  n = await runAsync(g.hub, g.t, n, T.delegateTrialMs + 1500);
  assert(g.t.delegate === 'CPU' && g.t.kept === null && g.hub.status.pipeline.delegateSwitches.at(-1).kept === true, JSON.stringify(g.t.calls));
  const won = g.hub.status.pipeline.delegateSwitches.at(-1);
  assert(won.before === 17 && won.after === 26 && won.judgedIn === 'round:1', JSON.stringify(won));
  assert(/starved/.test(g.t.fallbackReason), `the CPU says why (${g.t.fallbackReason})`);
  g.hub.stop();
});

test('R3/R8 a prepare that never finishes is dropped after switchPrepareMaxMs; failures back off, a missing model file is never retried, one warning', async () => {
  await captureWarn(async (warns) => {
    const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
    let now = await intoBout(hub, bus, t);
    t.hold = true;
    t.stats = S({ detFps: 16, p50: 60 });
    now = await runAsync(hub, t, now, T.liteAfterMs + 1000);
    roundEnd(bus);
    now = await runAsync(hub, t, now, T.switchPrepareMaxMs + 2000);
    const e = hub.status.pipeline.modelSwitches.at(-1);
    assert(e.ok === false && /not ready after/.test(e.error) && t.did('discard').length >= 1 && hub.model === 'full', JSON.stringify(e));
    hub.stop();

    // a missing lite model: one try, one warning, never again
    const g = await govHub({ Tracker: TwoPhaseTracker });
    let n = await intoBout(g.hub, g.bus, g.t);
    g.t.fail = new TrackerError('model-missing', 'This copy of the game is missing its pose model (models/pose_landmarker_lite.task, HTTP 404).');
    g.t.failOnly = 'lite';
    g.t.stats = S({ detFps: 16, p50: 60 });
    warns.length = 0;
    for (let r = 1; r <= 4; r++) {
      n = await runAsync(g.hub, g.t, n, T.liteAfterMs + 1000);
      roundEnd(g.bus, r); n = await runAsync(g.hub, g.t, n, 3000); roundStart(g.bus, r + 1);
    }
    assert(g.t.did('prepare').filter((c) => c[1] === 'lite').length === 1 && g.hub.model === 'full', `lite tried once (${JSON.stringify(g.t.calls)})`);
    assert(warns.length === 1 && /not trying again this session/.test(warns[0]), JSON.stringify(warns));
    // with lite out of the picture, the delegate governor does not wait for it: the CPU gets its trial
    assert(g.t.did('prepare').some((c) => c[1] === 'CPU'), `the CPU was tried (${JSON.stringify(g.t.calls)})`);
    g.hub.stop();

    // other failures: the next try waits switchFailWaitMs, then twice that; given up after switchMaxFailures
    const h = await govHub({ Tracker: TwoPhaseTracker });
    let m = await intoBout(h.hub, h.bus, h.t);
    h.t.fail = new Error('wasm aborted');
    h.t.failOnly = 'lite';
    h.t.stats = S({ detFps: 16, p50: 60 });
    h.bus.emit(Ev.APP_PAUSE, { reason: 'user' }); // a long safe stretch: every allowed try happens
    warns.length = 0;
    const lites = () => h.t.did('prepare').filter((c) => c[1] === 'lite').length;
    m = await runAsync(h.hub, h.t, m, T.liteAfterMs + 1000);
    assert(lites() === 1);
    m = await runAsync(h.hub, h.t, m, T.switchFailWaitMs - 2000);
    assert(lites() === 1, 'backing off');
    m = await runAsync(h.hub, h.t, m, 4000);
    assert(lites() === 2, 'second try after switchFailWaitMs');
    m = await runAsync(h.hub, h.t, m, 2 * T.switchFailWaitMs + 2000);
    assert(lites() === 3, `third try after twice that (${JSON.stringify(h.t.calls)})`);
    m = await runAsync(h.hub, h.t, m, 10 * T.switchFailWaitMs);
    assert(lites() === T.switchMaxFailures, `given up after ${T.switchMaxFailures}`);
    assert(warns.length === 2 && /next try in 60 s/.test(warns[0]) && /not trying again/.test(warns[1]), JSON.stringify(warns));
    assert(h.t.did('prepare').some((c) => c[1] === 'CPU') && h.t.did('commit').length >= 1, `then the delegate governor went on without lite (${JSON.stringify(h.t.calls.slice(0, 8))})`);
    h.hub.stop();
  });
});

test('R3 trackers without the two-phase switch: one blocking step at a safe moment; a lost trial waits for the next one', async () => {
  const { hub, bus, t } = await govHub({ model: 'lite' });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 6, p50: 160 });
  now = await runAsync(hub, t, now, T.delegateAfterMs + 1000);
  assert(!t.delegateCalls, 'not during the round');
  roundEnd(bus);
  now = await runAsync(hub, t, now, 600);
  assert.deepEqual(t.delegateCalls, ['CPU']);
  roundStart(bus, 2);
  t.stats = S({ detFps: 6, p50: 160 });
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  assert.deepEqual(t.delegateCalls, ['CPU'], 'a rebuild is not done mid-round');
  roundEnd(bus, 2);
  now = await runAsync(hub, t, now, 600);
  assert.deepEqual(t.delegateCalls, ['CPU', 'GPU'], 'back at the next safe moment');
  hub.stop();
});

// ───────────────────────────── R4 / R6: the camera rate ─────────────────────────────

test('R4/R6 camera: opens at 30; 60 only while the detector takes every frame; never a model change for the camera; doubling retry', async () => {
  const cam = fakeCam({ fps: 30, max: 60 });
  const { hub, bus, t, opened } = await govHub({ Tracker: TwoPhaseTracker, cam });
  assert(opened().frameRate === 30, `opened at the usual 30 (${opened().frameRate})`);
  // setup (camera check: an extra pose) at a fast median: no 60 there
  t.stats = S({ detFps: 30, p50: 9 });
  let now = await runAsync(hub, t, 0, T.camera60RetryMs + 2000);
  assert(cam.rates.length === 0, 'not in setup');
  now = await intoBout(hub, bus, t, now);
  now = await runAsync(hub, t, now, T.camera60RetryMs + 2000);
  assert.deepEqual(cam.rates, [60], 'a fast detector in a bout → 60');
  // the detector slows to 16 ms: frames would wait for it → 30 after camera60BehindMs
  t.stats = S({ detFps: 55, camFps: 60, p50: 16 });
  now = await runAsync(hub, t, now, T.camera60BehindMs + 1000);
  assert.deepEqual(cam.rates, [60, 30]);
  assert(hub.status.pipeline.cameraSwitches.at(-1).why === 'behind' && t.calls.length === 0 && hub.status.pipeline.pendingModel === null, 'no lite for the camera');
  // fast again: the retry waits twice as long (the try just failed); at 60 a fast detector delivers ≈ 60 poses/s and stays
  let fast = S({ detFps: 30, p50: 9 });
  Object.defineProperty(t, 'stats', { configurable: true, get: () => (cam.frameRate >= 59 ? S({ detFps: 58, camFps: 60, p50: 9 }) : fast), set: (v) => { fast = v; } });
  now = await runAsync(hub, t, now, T.camera60RetryMs + 2000);
  assert.deepEqual(cam.rates, [60, 30], 'not yet');
  now = await runAsync(hub, t, now, T.camera60RetryMs + 2000);
  assert.deepEqual(cam.rates, [60, 30, 60]);
  now = await runAsync(hub, t, now, 20000);
  assert.deepEqual(cam.rates, [60, 30, 60], 'kept at 60 while the detector keeps up');
  hub.stop();

  // the verifier's staleCamera60Wish: 40 poses/s at 18 ms on a 60 fps camera, then 55 at 15 ms
  const cam2 = fakeCam({ fps: 60, max: 60 });
  const g = await govHub({ Tracker: TwoPhaseTracker, cam: cam2 });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 40, camFps: 60, p50: 18 });
  n = await runAsync(g.hub, g.t, n, 6000);
  assert(g.hub.status.pipeline.pendingModel === null && cam2.rates[0] === 30, `30 at once, no lite wish (${cam2.rates})`);
  g.t.stats = S({ detFps: 30, camFps: 30, p50: 15 });
  n = await runAsync(g.hub, g.t, n, 20000);
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 1000);
  assert(g.hub.status.pipeline.pendingModel === null && g.t.calls.length === 0 && g.hub.model === 'full', JSON.stringify(g.t.calls));
  g.hub.stop();
});

// ───────────────────────────── R5: the start-up slow-GPU verdict ─────────────────────────────

/** A worker that answers frames with a slow GPU (ms per detection) and records the switch requests. */
function slowWorker(ms) {
  const w = {
    received: [], frames: [], onmessage: null, delegate: 'GPU',
    postMessage(m) {
      if (m.type === 'frame') { w.frames.push(m); return; }
      w.received.push(m.type);
      let value = {};
      if (m.type === 'init') value = { delegate: 'GPU', fallbackReason: null, initMs: 5, timeOrigin: performance.timeOrigin };
      if (m.type === 'switch') { w.delegate = 'CPU'; value = { delegate: 'CPU' }; }
      queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ok: true, value } }));
    },
    flush() {
      for (const f of w.frames.splice(0)) {
        const { n, data } = packResult({ landmarks: [], worldLandmarks: [] });
        w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms, n, data } });
      }
    },
    terminate() {},
  };
  return w;
}

test('R5 slow GPU: with the hub\'s gate the tracker only records the verdict; the hub makes it a CPU trial at a safe moment (or drops it if the GPU recovered)', async () => {
  const origFetch = globalThis.fetch;
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => { const b = new Uint8Array(200000); b.set([0, 0, 0x50, 0x4b, 3, 4]); return b.buffer; } });
  globalThis.VideoFrame = class { close() {} };
  try {
    const w = slowWorker(400);
    const tr = new WorkerPoseTracker({ forceWorker: true, workerFactory: () => w, tuning: { warmup: false, slowGpuRecheckMs: 0 } });
    tr.switchGate = () => false; // a round is running
    await tr.init();
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, srcObject: {}, requestVideoFrameCallback(cb) { v.cb = cb; return 1; }, cancelVideoFrameCallback() {} };
    tr.detect(v, 0);
    for (let i = 1; i <= 14; i++) { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; if (cb) cb(i * 33, { captureTime: i * 33 - 10 }); w.flush(); tr.detect(v, i * 33 + 5); }
    assert(tr.slowGpu && /GPU too slow \(400 ms per frame\)/.test(tr.slowGpu.reason) && !w.received.includes('switch') && tr.delegate === 'GPU', JSON.stringify({ slow: tr.slowGpu, got: w.received }));
    tr.close();
  } finally {
    globalThis.fetch = origFetch;
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
  }

  // the hub: verdict mid-round → nothing until the round ends → a CPU trial (kept only if faster)
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  assert(typeof t.switchGate === 'function' && t.switchGate() === true, 'the hub installs its gate');
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 8, p50: 120 });
  t.slowGpu = { median: 120, reason: 'GPU too slow (120 ms per frame) — using CPU' };
  now = await runAsync(hub, t, now, 5000);
  assert(t.calls.length === 0 && hub.status.pipeline.pendingDelegate === 'CPU', 'not mid-round');
  roundEnd(bus);
  now = await runAsync(hub, t, now, 1500);
  assert.deepEqual(t.calls, [['prepare', 'CPU'], ['commit', true]], JSON.stringify(t.calls));
  assert(t.delegate === 'CPU' && /GPU too slow/.test(t.fallbackReason) && hub.status.pipeline.switching.phase === 'trial');
  hub.stop();

  // the render steps freed the GPU before the safe moment: no switch
  const g = await govHub({ Tracker: TwoPhaseTracker });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.slowGpu = { median: 120, reason: 'GPU too slow (120 ms per frame) — using CPU' };
  g.t.stats = S({ detFps: 29, p50: 24 });
  n = await runAsync(g.hub, g.t, n, 1000);
  roundEnd(g.bus);
  n = await runAsync(g.hub, g.t, n, 1000);
  assert(g.t.calls.length === 0 && g.t.slowGpu === null && g.t.delegate === 'GPU', JSON.stringify(g.t.calls));
  g.hub.stop();
});

// ───────────────────────────── the trackers' two-phase switch ─────────────────────────────

test('R3 worker tracker: prepare starts a second worker (the running one keeps detecting every frame), primes it with a real frame, commit swaps with no pause; revert / discard', async () => {
  const origFetch = globalThis.fetch;
  const hadVF = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => { const b = new Uint8Array(200000); b.set([0, 0, 0x50, 0x4b, 3, 4]); return b.buffer; } });
  globalThis.VideoFrame = class { close() {} };
  const workers = [];
  /** A fake pose worker: init answers when release() is called (or at once), frames are answered by flush(). */
  const makeWorker = () => {
    const w = {
      n: workers.length + 1, received: [], frames: [], onmessage: null, terminated: false, hold: workers.length > 0, initReply: null, delegate: 'GPU',
      postMessage(m, transfer) {
        w.received.push({ m, transfer });
        if (m.type === 'frame') { w.frames.push(m); return; }
        const send = (r) => queueMicrotask(() => w.onmessage && w.onmessage({ data: { type: 'reply', id: m.id, ...r } }));
        if (m.type === 'init') {
          const reply = () => send(w.initError ? { ok: false, error: w.initError } : { ok: true, value: { delegate: w.startOn || m.delegate || 'GPU', initMs: 5, timeOrigin: performance.timeOrigin + w.n } });
          if (w.hold) w.initReply = reply; else reply();
        } else send({ ok: true, value: {} });
      },
      flush() { for (const f of w.frames.splice(0)) { const { n, data } = packResult({ landmarks: [], worldLandmarks: [] }); w.onmessage && w.onmessage({ data: { type: 'result', seq: f.seq, ts: f.ts, ms: 12, n, data, t0: 100, t1: 112 } }); } },
      terminate() { w.terminated = true; },
    };
    workers.push(w);
    return w;
  };
  try {
    const tr = new WorkerPoseTracker({ model: 'full', forceWorker: true, workerFactory: makeWorker, tuning: { warmup: false } });
    await tr.init();
    const [w1] = workers;
    const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, srcObject: {}, requestVideoFrameCallback(cb) { v.cb = cb; return 1; }, cancelVideoFrameCallback() {} };
    const present = (t) => { const cb = v.cb; v.cb = null; v.currentTime += 1 / 30; if (cb) cb(t, { captureTime: t - 10 }); };
    tr.detect(v, 0);
    assert(tr.canPrepare);
    const p = tr.prepareSwitch({ model: 'lite' });
    await new Promise((r) => setTimeout(r, 0));
    const w2 = workers[1];
    const init2 = w2 && w2.received.find((r) => r.m.type === 'init');
    assert(init2 && init2.m.model instanceof ArrayBuffer && init2.transfer.includes(init2.m.model) && init2.m.delegate === 'GPU', 'a second worker starts with the lite model');
    assert(!tr.canPrepare, 'one switch at a time');
    let got = 0;
    for (let i = 1; i <= 4; i++) { present(i * 33); w1.flush(); if (tr.detect(v, i * 33 + 2)) got++; got += tr.takeFrames(i * 33 + 2).length; }
    assert(w1.received.filter((r) => r.m.type === 'frame').length === 4 && got >= 3, `the running worker kept detecting (${got} poses)`);
    w2.initReply();
    await new Promise((r) => setTimeout(r, 0));
    const prime = w2.frames[0];
    assert(prime && prime.image, 'primed with a real camera frame');
    w2.flush(); // its first full inference (shaders) happens before the swap
    const pv = await p;
    assert(pv.model === 'lite' && tr.model === 'full' && !w2.terminated, 'prepared; still detecting with full');
    present(200); tr.detect(v, 202); // a frame in flight to the old worker at the swap …
    const cv = await tr.commitSwitch({ keep: true });
    assert(tr.model === 'lite' && cv.warmMs === 0, 'lite runs: no warm-up pause');
    w1.flush(); // … still answers through the old worker
    assert(tr.takeFrames(240).length + (tr.detect(v, 240) ? 1 : 0) >= 0 && !w1.terminated, 'the old worker is kept (keep)');
    present(266); tr.detect(v, 268);
    assert(w2.received.filter((r) => r.m.type === 'frame').length === 2, 'the next frame went to the new worker');
    w2.flush();
    await tr.revertSwitch();
    assert(tr.model === 'full' && w2.terminated && !w1.terminated, 'back to the kept worker; the trial one stops');
    present(300); tr.detect(v, 302);
    assert(w1.received.filter((r) => r.m.type === 'frame').length === 6, 'frames go to the first worker again');
    w1.flush();
    // a prepare whose worker can only start on another delegate is not the switch asked for
    const p3 = tr.prepareSwitch({ delegate: 'CPU' });
    await new Promise((r) => setTimeout(r, 0));
    const w3 = workers[2];
    w3.startOn = 'GPU';
    w3.initReply();
    let err = null;
    try { await p3; } catch (e) { err = e; }
    assert(err instanceof TrackerError && w3.terminated && tr.delegate === 'GPU', `refused (${err && err.message})`);
    // discard while a prepare is still starting
    const p4 = tr.prepareSwitch({ delegate: 'CPU' });
    await new Promise((r) => setTimeout(r, 0));
    await tr.discardSwitch();
    let err4 = null;
    try { await p4; } catch (e) { err4 = e; }
    assert(err4 && workers[3].terminated && tr.canPrepare, 'discarded');
    tr.close();
    assert(workers.every((w) => w.terminated), 'close stops every worker');
  } finally {
    globalThis.fetch = origFetch;
    if (hadVF) Object.defineProperty(globalThis, 'VideoFrame', hadVF); else delete globalThis.VideoFrame;
  }
});

test('R3 main-thread tracker: prepare builds while the running landmarker keeps detecting; commit (keep) / revert / discard close the right ones', async () => {
  const made = [];
  const fakeLm = (tag) => {
    const lm = { tag, closed: false, detects: 0, opts: null, detectForVideo() { lm.detects++; return { landmarks: [], worldLandmarks: [] }; }, async setOptions(o) { lm.opts = o; }, close() { lm.closed = true; } };
    made.push(lm);
    return lm;
  };
  let release = null;
  const t = new PoseTracker({ numPoses: 1, model: 'full', tuning: { warmup: true } });
  t._vision = { PoseLandmarker: { createFromOptions: (fs, o) => new Promise((r) => { release = () => r(fakeLm(`${o.baseOptions.delegate}`)); }) } };
  t._fileset = {};
  t._modelBuffer = new Uint8Array(1);
  t._loadModel = async () => new Uint8Array(1);
  const running = fakeLm('GPU-full');
  t._landmarker = running; t.delegate = 'GPU';
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, paused: false };
  const p = t.prepareSwitch({ delegate: 'CPU' });
  for (let i = 1; i <= 3; i++) { v.currentTime = i / 30; t.detect(v, i * 34); }
  assert(running.detects === 3, `the running landmarker kept detecting (${running.detects})`);
  await new Promise((r) => setTimeout(r, 0));
  release();
  const pv = await p;
  assert(pv.delegate === 'CPU' && t.delegate === 'GPU');
  await t.setNumPoses(2); // the pose budget changes before the commit: applied to the prepared one
  const cpu = made.at(-1);
  await t.commitSwitch({ keep: true, reason: 'GPU starved (8 poses/s) — trying the CPU' });
  assert(t.delegate === 'CPU' && cpu.opts && cpu.opts.numPoses === 2 && !running.closed, 'CPU runs (with the new budget); the GPU one kept');
  assert(t.fallbackReason === 'GPU starved (8 poses/s) — trying the CPU');
  await t.revertSwitch();
  assert(t.delegate === 'GPU' && cpu.closed && !running.closed && t.fallbackReason === null, 'back to the kept GPU landmarker');
  const p2 = t.prepareSwitch({ model: 'lite' });
  await new Promise((r) => setTimeout(r, 0));
  release();
  await p2;
  const lite = made.at(-1);
  await t.discardSwitch();
  assert(lite.closed && t.model === 'full' && !running.closed, 'discarded');
  t.close();
  assert(running.closed);
});

// ───────────────────────────── R7 / R9: the render's steps ─────────────────────────────

function feed(q, sec, { ms = 16.7, p = null } = {}) {
  const changes = [];
  let t = 0;
  while (t < sec) {
    q.setDetectionPressure(typeof p === 'function' ? p(q) : p);
    const c = q.frame(ms / 1000);
    if (c) changes.push({ at: +t.toFixed(2), ...c });
    t += ms / 1000;
  }
  return changes;
}
const RATE = { behind: true, rateBehind: true, headroom: false, gpu: true, activity: true, session: true, detFps: 20, wantFps: 30, detMs: 45 };
const LAG = { behind: true, rateBehind: false, headroom: false, gpu: true, activity: true, session: true, detFps: 30, wantFps: 30, detMs: 28 };
const OK = { behind: false, rateBehind: false, headroom: false, gpu: true, activity: true, session: true, detFps: 30, wantFps: 30, detMs: 20 };

test('R7 adaptive: lag alone takes the pixel ratio down to 1.25 and no further, never the shadows; a rate behind takes every step', () => {
  const lag = feed(new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } }), 60, { p: LAG });
  assert.deepEqual(lag.map((c) => c.pixelRatio ?? c.shadow), [1.75, 1.5, 1.25], JSON.stringify(lag));
  assert(lag.every((c) => c.why === 'lag'));
  const rate = feed(new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } }), 60, { p: RATE });
  assert.deepEqual(rate.map((c) => c.pixelRatio ?? c.shadow), [1.75, 1.5, 1.25, 1, 'low']);
  // a non-Retina screen (pixel ratio 1) has nothing cheap to give for lag
  assert.deepEqual(feed(new AdaptiveQuality({ maxRatio: 1, tuning: { log: false } }), 30, { p: LAG }), []);
});

test('R7 adaptive: once detection is on the CPU (or gone), the steps taken for it come back after detReleaseSec windows — not after upAfterSec each', () => {
  const q = new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } });
  feed(q, 40, { p: RATE });
  assert(q.pixelRatio === 1 && q.shadowLowered && q.state().detDown === 5);
  // detection moved to the CPU: its reports no longer gate (it does not share the GPU) and the steps come back fast
  const up = feed(q, 20, { p: { ...RATE, gpu: false } });
  assert(q.pixelRatio === 2 && !q.shadowLowered && up.length === 5, `all back within 20 s (${JSON.stringify(up.map((c) => [c.at, c.pixelRatio ?? c.shadow]))})`);
  assert(up.at(-1).at < 20 && up[1].at - up[0].at <= ADAPTIVE_TUNING.windowSec * 2 + 0.1, 'one render window apart');
  // a GPU detector with headroom still needs upAfterSec per step
  const g = new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } });
  feed(g, 5, { p: RATE });
  const slow = feed(g, 8, { p: { ...OK, headroom: true } });
  assert(slow.length === 0, 'not before upAfterSec');
});

test('R7 adaptive: a new session (menus ↔ bout) is another context, without the bout\'s ceiling; R9: a detection step reports the real frame time, not 0', () => {
  const q = new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } });
  const first = feed(q, 3.2, { p: RATE });
  assert(first.length === 1 && Math.abs(first[0].avgMs - 16.7) < 0.5, `avgMs ${first[0] && first[0].avgMs}`);
  feed(q, 13, { p: { ...OK, headroom: true } });
  feed(q, 3.2, { p: RATE });
  assert(q.state().ceiling, 'ceiling after an undone step up');
  feed(q, 0.5, { p: { ...OK, headroom: true, session: false } });
  assert(q.state().ceiling === null, 'the menus are another context');
});

// ───────────────────────────── the session for lag ─────────────────────────────

test('hub pressure: lag counts only in a bout or drill (menus judge the rate, with the setup headroom)', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoActivity(hub, t);
  t.stats = S({ detFps: 30, p50: 28 });
  now = run(hub, t, now, 1500);
  let p = hub.renderPressure;
  assert(!p.behind && p.headroom && !p.session, `menus: 28 ms at 30 poses/s is fine (${JSON.stringify(p)})`);
  bus.emit(Ev.MATCH_INTRO, {});
  now = run(hub, t, now, 600);
  p = hub.renderPressure;
  assert(p.behind && !p.rateBehind && !p.headroom && p.session, JSON.stringify(p));
  bus.emit(Ev.MATCH_RESULT, {});
  now = run(hub, t, now, 600);
  assert(!hub.renderPressure.behind && !hub.renderPressure.session, 'the bout is over');
  // a rate behind counts everywhere
  t.stats = S({ detFps: 20, p50: 48 });
  now = run(hub, t, now, 600);
  assert(hub.renderPressure.behind && hub.renderPressure.rateBehind);
  hub.stop();
});

// ───────────────────────────── R6: 60 fps only in the same picture mode ─────────────────────────────

test('R6 camera: a camera that reaches 60 fps only in another mode (another size: cropped or scaled) is put back; the hub never asks again', async () => {
  const { openCamera } = await import('../../src/input/camera.js');
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'mediaDevices');
  let settings = { deviceId: 'c', width: 640, height: 480, frameRate: 30 };
  const applied = [];
  const track = {
    label: 'Cam', readyState: 'live', addEventListener() {}, stop() {}, getSettings: () => settings,
    getCapabilities: () => ({ frameRate: { min: 1, max: 60 } }),
    // 60 fps exists only as 1280 × 720 here
    async applyConstraints(c) { applied.push(c); settings = c.frameRate.max >= 60 && c.frameRate.ideal >= 60 ? { ...settings, width: 1280, height: 720, frameRate: 60 } : { ...settings, width: 640, height: 480, frameRate: 30 }; },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  Object.defineProperty(nav, 'mediaDevices', { value: { getUserMedia: async () => stream }, configurable: true });
  try {
    const video = { readyState: 4, videoWidth: 640, videoHeight: 480, addEventListener() {}, removeEventListener() {}, async play() {}, pause() {} };
    const cam = await openCamera({ video, frameRate: 30 });
    assert(cam.frameRate === 30 && cam.maxFrameRate === 60);
    const got = await cam.setFrameRate(60);
    assert(got === 30 && cam.frameRate === 30 && cam.refusedFrameRate === 60 && settings.width === 640, `put back (${JSON.stringify(settings)})`);
    assert(applied.length === 2 && applied[1].frameRate.ideal === 30, JSON.stringify(applied));
  } finally {
    if (had) Object.defineProperty(nav, 'mediaDevices', had); else delete nav.mediaDevices;
    if (!hadNav) delete globalThis.navigator;
  }
  // the hub: a refused 60 is not asked for again
  const cam = fakeCam({ fps: 30, max: 60 });
  cam.setFrameRate = async (f) => { cam.rates.push(f); cam.refusedFrameRate = f >= 59 ? f : cam.refusedFrameRate; return 30; };
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker, cam });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 30, p50: 9 });
  now = await runAsync(hub, t, now, 3 * T.camera60RetryMs);
  assert.deepEqual(cam.rates, [60], `asked once (${cam.rates})`);
  hub.stop();
});

// ───────────────────────────── the start-up frame cap (fast displays) ─────────────────────────────

test('start-up: while the detector starts, a 120 Hz display is capped at once (the worker\'s start-up shares the GPU); 60 Hz and keyboard play are not', async () => {
  const START = { starting: true, behind: false, rateBehind: false, starved: false, headroom: false, gpu: true, judged: false, activity: false };
  const q = new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } });
  const ch = feed(q, 2, { ms: 8.33, p: START });
  assert(ch.length === 1 && ch[0].frameDivisor === 2 && ch[0].why === 'start' && ch[0].at < 1.5, JSON.stringify(ch));
  assert(q.pixelRatio === 2 && !q.shadowLowered, 'only the cap');
  assert.deepEqual(feed(new AdaptiveQuality({ maxRatio: 2, tuning: { log: false } }), 3, { ms: 16.7, p: START }), [], '60 Hz: nothing');
  // running with headroom: the cap is lifted after upAfterSec of it
  const up = feed(q, 16, { ms: 16.66, p: { ...OK, headroom: true } });
  assert(up.length === 1 && up[0].frameDivisor === 1 && q.frameDivisor === 1, JSON.stringify(up));
  // the hub reports 'starting' while the camera / detector start, nothing in keyboard mode
  const { InputHub } = await import('../../src/input/input-hub.js');
  const { InputMode } = await import('../../src/core/types.js');
  let release;
  const hub = new InputHub({ mode: InputMode.CAMERA, players: 1, deps: { GestureRecognizer: FakeRecognizer, PoseTracker: class extends TwoPhaseTracker { init() { return new Promise((r) => { release = r; }); } }, openCamera: async () => fakeCam() } });
  const started = hub.start();
  await flush();
  assert(hub.renderPressure && hub.renderPressure.starting === true && hub.renderPressure.gpu === true, JSON.stringify(hub.renderPressure));
  release({ delegate: 'GPU' });
  await started;
  assert(!hub.renderPressure || !hub.renderPressure.starting, 'running: the real figures');
  hub.stop();
  const kb = new InputHub({ mode: InputMode.KEYBOARD, players: 1 });
  await kb.start();
  assert(kb.renderPressure === null);
  kb.stop();
});

// ───────────────────────────── urgent: severe starvation does not wait for a safe moment ─────────────────────────────

test('urgent: below half the wanted rate for urgentAfterMs, a two-phase switch is built and committed mid-round (its pause is the warm-up); one-step trackers still wait', async () => {
  const { hub, bus, t } = await govHub({ Tracker: TwoPhaseTracker });
  let now = await intoBout(hub, bus, t);
  t.stats = S({ detFps: 6, p50: 160 });
  now = await runAsync(hub, t, now, T.urgentAfterMs - 1500);
  assert(t.calls.length === 0, 'not yet urgent');
  now = await runAsync(hub, t, now, 3000);
  assert(!hub.safeToSwitch && hub.model === 'lite' && t.did('commit').length === 1, `lite mid-round (${JSON.stringify(t.calls)})`);
  const e = hub.status.pipeline.modelSwitches.at(-1);
  assert(e.urgent === true && e.ok === true, JSON.stringify(e));
  // lite is still at 6 poses/s: after delegateAfterMs (urgent again) the CPU is tried mid-round; the lost trial (no worse than
  // the GPU) would wait for the round end (merge-refix RG4-SIDE), but detection stays urgently starved: back mid-round
  now = await runAsync(hub, t, now, T.delegateAfterMs + 1500);
  assert(t.delegate === 'CPU' && hub.status.pipeline.switching && hub.status.pipeline.switching.phase === 'trial', JSON.stringify(t.calls));
  t.stats = S({ detFps: 6.2, p50: 155 });
  now = await runAsync(hub, t, now, T.delegateTrialMs + 1500);
  const v = hub.status.pipeline.delegateSwitches.at(-1);
  assert(v.kept === false && v.revertAt === 'safe', JSON.stringify(v));
  now = await runAsync(hub, t, now, T.urgentAfterMs);
  assert(t.delegate === 'GPU' && t.did('revert').length === 1 && !hub.safeToSwitch, JSON.stringify(t.calls));
  hub.stop();
  // a tracker that switches in one blocking step never does it mid-round
  const g = await govHub({ model: 'lite' });
  let n = await intoBout(g.hub, g.bus, g.t);
  g.t.stats = S({ detFps: 6, p50: 160 });
  n = await runAsync(g.hub, g.t, n, T.delegateAfterMs + T.urgentAfterMs);
  assert(!g.t.delegateCalls, 'waits for the round end');
  g.hub.stop();
});
