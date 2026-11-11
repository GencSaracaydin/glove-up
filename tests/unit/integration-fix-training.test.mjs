// Integrator (fix pass): decision D6 carried into training — combat's request. TrainingRun passes
// {stalled: renderer.timeScale < 1} to the drill, and a punch recognised during a hit-stop pop whose
// glove may not go yet is queued (one per hand) instead of dropped, as in bouts.
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { TrainingActivity, TrainingPhase, TRAINING_TIMING } from '../../src/training/activity.js';
import { TrainingRun } from '../../src/app/session.js';

/** Minimal drill: every punch that arrives counts as a hit. */
class Probe extends TrainingActivity {
  static KIND = 'bag';
  _resolvePunch() { this.stats.landed++; return { result: 'hit' }; }
}

const control = () => ({ tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 }, hands: { left: { x: -0.3, y: 0.2, reach: 0.1 }, right: { x: 0.3, y: 0.2, reach: 0.1 } }, activity: 0 });
const punch = () => ({ type: 'punch', t: 0, punch: { hand: 'right', kind: 'straight', target: 'head', power: 0.7, t: 0, atExtension: true } });

/** Two right-hand punches 20 ms apart (the second well inside the 200 ms per-hand limit). */
function twoQuickPunches(stalled) {
  const act = new Probe({ bus: new EventBus(), rng: 3 });
  let now = 1000;
  const step = (ms, input = null, opts = null) => { now += ms; act.update(ms / 1000, now, input || { control: control(), events: [] }, opts); };
  for (let t = 0; t < TRAINING_TIMING.readyMs + 100; t += 16) step(16);
  assert.equal(act.phase, TrainingPhase.ACTIVE, 'the drill is running');
  step(16, { control: control(), events: [punch()] }, { stalled });
  step(20, { control: control(), events: [punch()] }, { stalled });
  for (let t = 0; t < 800; t += 16) step(16, null, { stalled: false });
  return act.stats.punches;
}

test('training (D6): a punch recognised during a hit-stop is queued and thrown, not dropped', () => {
  assert.equal(twoQuickPunches(false), 1, 'without a stall the second punch is too early (outside the buffer) and dropped');
  assert.equal(twoQuickPunches(true), 2, 'during a stall it is queued and thrown once the glove may go');
});

test('training (D6): TrainingRun tells the drill when the renderer is in a hit-stop', () => {
  const seen = [];
  const run = new TrainingRun({ bus: new EventBus(), renderer: { timeScale: 1 }, hud: null, kind: 'bag', participants: [{ id: 'g', name: 'G' }], seed: 1 });
  run.act = { update: (dt, now, input, opts) => { seen.push(!!opts?.stalled); }, isDone: () => false };
  run.update(1 / 60, 1000, []);
  run.renderer.timeScale = 0.02;
  run.update(1 / 60, 1016, []);
  assert.deepEqual(seen, [false, true]);
});
