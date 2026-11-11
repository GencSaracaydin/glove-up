// TrainingScene (render/training-props.js) driven by real activity views in Node: the view ↔ props
// contract holds for all three activities (no throws, props follow the logic).
import { test, assert, approx } from '../harness.mjs';
import { TrainingScene, TRAINING_PROPS_TUNING } from '../../src/render/training-props.js';
import { createActivity, makeTrainingBot } from '../../src/training/session.js';

function drive(kind, ms, { skill = 0.8, seed = 2, scene = new TrainingScene(null, { drawPlayer: true }), each } = {}) {
  const act = createActivity(kind, { rng: seed, readyMs: 300 });
  const bot = makeTrainingBot(kind, { skill, seed });
  let now = 0;
  for (let i = 0; i < ms / (1000 / 60); i++) {
    now += 1000 / 60;
    act.update(1 / 60, now, bot.update(act.getView()));
    const v = act.getView();
    scene.update(v, 1 / 60);
    each?.(v, scene);
  }
  return { act, scene };
}

test('training-props: builds in Node with a trainer, mitts, ball pool and a camera focus', () => {
  const s = new TrainingScene(null);
  assert(s.object3d && s.object3d.isObject3D);
  assert(s.trainer, 'trainer BoxerModel');
  assert(s.mitts && s.mitts.left && s.mitts.right);
  assert.equal(s.balls.length, 6);
  assert(s.focus && s.focus.isVector3);
  assert(s.cameraPose && Array.isArray(s.cameraPose.offset));
  s.dispose();
});

test('training-props: bag mode follows the pendulum, swaps tiers, animates dropped bags', () => {
  let sawFallen = false, sawTier2 = false;
  const { act, scene } = drive('bag', 26000, {
    skill: 0.95,
    each: (v, s) => {
      approx(s.bagPivot.rotation.x, v.bag.swing.ax, 1e-9);
      approx(s.bagPivot.rotation.z, v.bag.swing.az, 1e-9);
      if (v.bag.fallen.length) sawFallen = sawFallen || s.fallenMeshes.some((m) => m.visible);
      if (v.bag.tier === 2 && v.bag.state === 'hanging') sawTier2 = sawTier2 || s._bagTier === 2;
      assert.equal(s.hanger.visible, v.bag.state === 'hanging' || v.bag.state === 'dropping');
    },
  });
  assert(act.bagsDone >= 1, 'a bag dropped during the run');
  assert(sawFallen && sawTier2);
  assert(scene.chain.count > 5, 'chain drawn');
  assert(scene.bagRig.visible && !scene.ballsGroup.visible);
  scene.dispose();
});

test('training-props: dodge mode shows balls in flight and positions the trainer on his spot', () => {
  let sawBall = false, sawHeld = false;
  const { scene } = drive('dodge', 20000, {
    each: (v, s) => {
      if (v.balls.some((b) => b.state === 'flying')) sawBall = sawBall || s.balls.some((b) => b.mesh.visible && b.blob.visible);
      if (v.balls.some((b) => b.state === 'held')) sawHeld = sawHeld || s.balls.some((b) => b.mesh.visible && !b.blob.visible);
      approx(s.trainer.object3d.position.x, v.trainer.pos[0], 1e-9);
      approx(s.trainer.object3d.position.z, v.trainer.pos[2], 1e-9);
    },
  });
  assert(sawBall && sawHeld);
  assert(scene.ballsGroup.visible && !scene.bagRig.visible);
  approx(scene.focus.z, TRAINING_PROPS_TUNING.camera.dodge.focus[2], 0.05, 'camera aims down the ring at the trainer');
  scene.dispose();
});

test('training-props: mitts mode shows raised targets with a countdown and pops on hits', () => {
  let sawLive = false, sawPop = false;
  const { scene } = drive('mitts', 15000, {
    each: (v, s) => {
      for (const side of ['left', 'right']) {
        const mv = v.mitts.find((m) => m.side === side);
        const M = s.mitts[side];
        if (mv.live) sawLive = sawLive || (M.segs.count > 0 && M.glowMat.opacity > 0.3);
        if (mv.hitAge != null && mv.hitAge < 0.2) sawPop = sawPop || M.burstMat.opacity > 0.1;
      }
    },
  });
  assert(sawLive && sawPop);
  assert(scene.mitts.left.group.visible && scene.mitts.left.group.parent, 'attached to the trainer hand anchor');
  scene.dispose();
});

test('training-props: switching activities and restarting reset transient props; paused views freeze', () => {
  const s = new TrainingScene(null);
  const a = createActivity('dodge', { rng: 1, readyMs: 0 });
  a.update(0.016, 16, null); a.update(0.016, 32, null);
  s.update(a.getView(), 0.016);
  s.setActivity('mitts');
  assert(!s.ballsGroup.visible && s.mitts.left.group.visible);
  const v = a.getView();
  v.paused = true;
  const before = s._time;
  s.update(v, 0.5);
  assert.equal(s._time, before, 'paused view: no animation time passes');
  s.dispose();
});
