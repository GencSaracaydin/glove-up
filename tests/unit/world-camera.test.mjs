// View3d / camera rig: the research/mechanics.md §6 camera table keyed on phase / stage / stageTime,
// the player-hit cut, knockdown shots, cut announcements, lean slide, versus per-player cuts.
import * as THREE from 'three';
import { test, assert, approx } from '../harness.mjs';
import { CameraRig, Shot, RIG_TUNING } from '../../src/render/camera-rig.js';
import { LAYOUT } from '../../src/render/style.js';
import { MatchPhase } from '../../src/core/types.js';

function ctx(over = {}) {
  return {
    mode: 'match', phase: MatchPhase.FIGHTING, phaseTime: 1, stage: null, stageTime: 0, versus: false, downed: null, koLoser: null, winner: null,
    pos: { p1: new THREE.Vector3(...LAYOUT.p1Pos), p2: new THREE.Vector3(...LAYOUT.p2Pos) }, yaw: { p1: Math.PI, p2: 0 },
    lean: { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 0 } }, focus: null,
    shake: { x: 0, y: 0, roll: 0 }, ...over,
  };
}
const run = (rig, c, sec, dt = 1 / 60) => { for (let t = 0; t < sec - 1e-9; t += dt) rig.update(dt, c); };
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const proj = (rig, x, y, z) => new THREE.Vector3(x, y, z).project(rig.camera);
const P2_HEAD = [0, 1.19, LAYOUT.p2Pos[2]];

test('camera: shot table keyed on phase + stage (§6)', () => {
  const rig = new CameraRig({ side: 'p1' });
  const P = MatchPhase;
  const cases = [
    [{ mode: 'menu' }, Shot.MENU], [{ mode: 'training' }, Shot.TRAINING],
    [{ phase: P.INTRO, stage: 'arena' }, Shot.ARENA], [{ phase: P.ROUND_START, stage: 'banner' }, Shot.ARENA],
    [{ phase: P.ROUND_START, stage: 'flyin' }, Shot.FLYIN], [{ phase: P.ROUND_START, stage: 'ring' }, Shot.RING],
    [{ phase: P.ROUND_START, stage: 'fight' }, Shot.BEHIND], [{ phase: P.BETWEEN, stage: 'arena' }, Shot.ARENA],
    [{ phase: P.FIGHTING, stage: 'live' }, Shot.PLAY], [{ phase: P.FIGHTING, stage: 'guard-head' }, Shot.PLAY],
    [{ phase: P.ROUND_END, stage: 'hold' }, Shot.PLAY],
    [{ phase: P.KNOCKDOWN, stage: 'fall', downed: 'p2' }, Shot.PLAY],
    [{ phase: P.KNOCKDOWN, stage: 'down-call', downed: 'p2' }, Shot.KD_WIDE],
    [{ phase: P.KNOCKDOWN, stage: 'count', downed: 'p1' }, Shot.PLAYER_DOWN],
    [{ phase: P.KNOCKDOWN, stage: 'ko-hold', downed: 'p2' }, Shot.KD_WIDE],
    [{ phase: P.RECOVERY, stage: 'standoff' }, Shot.PLAY],
    [{ phase: P.DECISION, stage: 'decision' }, Shot.DECISION],
    [{ phase: P.RESULT, koLoser: 'p2' }, Shot.KD_WIDE], [{ phase: P.RESULT, winner: 'p1' }, Shot.RESULT],
    [{ phase: P.PAUSED }, Shot.HOLD],
  ];
  for (const [over, want] of cases) {
    rig.update(1 / 60, ctx(over));
    assert.equal(rig.shot, want, JSON.stringify(over));
  }
});

test('camera: without stage fields the table runs on phase + phaseTime', () => {
  const rig = new CameraRig({ side: 'p1' });
  const F = RIG_TUNING.fallback;
  const cases = [
    [{ phase: MatchPhase.INTRO, phaseTime: F.intro.arena * 0.5 }, Shot.ARENA],
    [{ phase: MatchPhase.INTRO, phaseTime: (F.intro.arena + F.intro.flyin) / 2 }, Shot.FLYIN],
    [{ phase: MatchPhase.INTRO, phaseTime: F.intro.flyin + 0.5 }, Shot.RING],
    [{ phase: MatchPhase.ROUND_START, phaseTime: 0.2 }, Shot.BEHIND],
    [{ phase: MatchPhase.BETWEEN, phaseTime: 0.2 }, Shot.ARENA],
    [{ phase: MatchPhase.KNOCKDOWN, downed: 'p2', phaseTime: 0.2 }, Shot.PLAY],
    [{ phase: MatchPhase.KNOCKDOWN, downed: 'p2', phaseTime: RIG_TUNING.kdWide.fallSec + 0.1 }, Shot.KD_WIDE],
  ];
  for (const [over, want] of cases) {
    rig.update(1 / 60, ctx(over));
    assert.equal(rig.shot, want, JSON.stringify(over));
  }
});

test('camera: live view is just behind P1 at about head height, off the left shoulder; the opponent is readable', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 1);
  const cam = rig.camera;
  assert(cam.position.z > LAYOUT.p1Pos[2], 'behind P1');
  // D18 / VISUAL-03: at about head height (head centre ≈ 1.28 m) and to the player's left
  assert(Math.abs(cam.position.y - 1.28) < 0.15, `about head height (${cam.position.y.toFixed(2)})`);
  assert(cam.position.x < -0.25, `off the left shoulder (${cam.position.x.toFixed(2)})`);
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  assert(fwd.z < -0.85, 'looking toward P2');
  const face = proj(rig, ...P2_HEAD);
  assert(Math.abs(face.x) < 0.08, `opponent centred (${face.x.toFixed(2)})`);
  const yFromTop = (1 - face.y) / 2;
  assert(yFromTop > 0.15 && yFromTop < 0.45, `opponent's head in the upper part (${yFromTop.toFixed(2)} down)`);
  // framed from about mid-thigh / knee up: the opponent's knee is still near the bottom of the frame
  const knee = proj(rig, 0, 0.33, LAYOUT.p2Pos[2]);
  assert(knee.y > -1.05 && knee.y < -0.2, `knee at ${((1 - knee.y) / 2).toFixed(2)} down`);
  assert.equal(rig.wantsGhost, true);
});

test('camera: a lean slides the view 1/4–1/3 of the screen width within 0.15 s (§2.5)', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 1);
  const x0 = proj(rig, ...P2_HEAD).x;
  run(rig, ctx({ lean: { p1: { x: 1, y: 0, z: 0 }, p2: null } }), 0.15);
  const x15 = proj(rig, ...P2_HEAD).x;
  run(rig, ctx({ lean: { p1: { x: 1, y: 0, z: 0 }, p2: null } }), 1);
  const x1 = proj(rig, ...P2_HEAD).x;
  const settled = Math.abs(x1 - x0) / 2, early = Math.abs(x15 - x0) / 2;
  assert(settled >= 0.25 && settled <= 0.34, `slide ${settled.toFixed(3)} of the width`);
  assert(early >= 0.85 * settled, `most of it within 0.15 s (${early.toFixed(3)})`);
  assert(x1 < x0, 'leaning right moves the opponent left on screen');
  // ducking drops the view; the opponent stays on screen while dodging
  run(rig, ctx({ lean: { p1: { x: 0, y: -1, z: 0 }, p2: null } }), 0.5);
  const yDuck = rig.camera.position.y;
  run(rig, ctx(), 0.6);
  assert(rig.camera.position.y - yDuck > 0.25, 'duck lowers the camera');
  run(rig, ctx({ lean: { p1: { x: -1, y: -0.7, z: 0 }, p2: null } }), 0.5);
  const f = proj(rig, ...P2_HEAD);
  assert(Math.abs(f.x) < 0.9 && Math.abs(f.y) < 0.95, 'opponent still on screen');
});

test('camera: player-hit cut — one live frame, a hard cut to a solid over-the-shoulder, a hard cut back', () => {
  const rig = new CameraRig({ side: 'p1' });
  const c = ctx();
  run(rig, c, 1);
  const live = rig.camera.position.clone();
  rig.takeCut();
  assert.equal(rig.hitCut({ heavy: false }), RIG_TUNING.hit.ms);
  rig.update(1 / 60, c);
  assert.equal(rig.shot, Shot.PLAY, 'the event frame stays live (it carries the orange radial lines)');
  rig.update(1 / 60, c);
  assert.equal(rig.shot, Shot.HIT);
  assert.deepEqual(rig.takeCut(), { kind: 'player-hit', durationMs: RIG_TUNING.hit.ms });
  assert(rig.camera.position.distanceTo(live) > 0.4, 'hard cut, not a pan');
  const ownHead = new THREE.Vector3(LAYOUT.p1Pos[0], 1.2, LAYOUT.p1Pos[2]);
  assert(rig.camera.position.distanceTo(ownHead) < live.distanceTo(ownHead), 'tighter than the live view');
  assert(Math.abs(rig.camera.position.y - ownHead.y) < 0.2, 'at head height');
  assert.equal(rig.wantsGhost, false, 'the player is solid during the cut');
  // the opponent's head is in view (over the shoulder)
  const f = proj(rig, ...P2_HEAD);
  assert(Math.abs(f.x) < 0.9 && Math.abs(f.y) < 0.9 && f.z < 1, 'opponent framed');
  run(rig, c, RIG_TUNING.hit.ms / 1000 - 0.05);
  assert.equal(rig.shot, Shot.HIT, 'still in the cut');
  run(rig, c, 0.1);
  assert.equal(rig.shot, Shot.PLAY, 'back to the fight view');
  assert(rig.camera.position.distanceTo(live) < 0.05, 'hard cut back to the same live pose');
});

test('camera: heavy cut lasts 0.65 s and swings back; hits during the cut extend it; cinematics cancel it', () => {
  const rig = new CameraRig({ side: 'p1' });
  const c = ctx();
  run(rig, c, 1);
  rig.hitCut({ heavy: true });
  rig.update(1 / 60, c); rig.update(1 / 60, c);
  assert.deepEqual(rig.takeCut(), { kind: 'player-hit-heavy', durationMs: RIG_TUNING.hit.heavyMs });
  run(rig, c, 0.4);
  rig.hitCut({ heavy: false }); // follow-up during the cut
  run(rig, c, 0.3);
  assert.equal(rig.shot, Shot.HIT, 'extended by the follow-up');
  let n = 0;
  while (rig.shot === Shot.HIT && n++ < 120) rig.update(1 / 60, c);
  assert.equal(rig.shot, Shot.PLAY);
  assert(rig.settled < 0.2, 'heavy cuts swing back (a short blend) instead of a hard cut');
  assert(n * (1 / 60) < 0.12, `ended on time (${n} frames after the extension)`);
  run(rig, c, 0.5);
  // a knockdown cinematic drops a pending cut
  rig.hitCut({ heavy: true, durationMs: 1600 });
  rig.update(1 / 60, c); rig.update(1 / 60, c);
  assert.equal(rig.shot, Shot.HIT);
  rig.update(1 / 60, ctx({ phase: MatchPhase.KNOCKDOWN, stage: 'down-call', downed: 'p1' }));
  assert.equal(rig.shot, Shot.PLAYER_DOWN);
  assert.equal(rig.hitCutActive, false);
});

test('camera: opponent down — the fall plays live, then a high wide shot from behind the standing player', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 1);
  rig.takeCut();
  const body = { p1: new THREE.Vector3(0, 0.2, 0.575), p2: new THREE.Vector3(0, 0.2, -1.2) };
  rig.update(1 / 60, ctx({ phase: MatchPhase.KNOCKDOWN, stage: 'fall', downed: 'p2', body }));
  assert.equal(rig.shot, Shot.PLAY);
  rig.update(1 / 60, ctx({ phase: MatchPhase.KNOCKDOWN, stage: 'down-call', downed: 'p2', body }));
  assert.equal(rig.shot, Shot.KD_WIDE);
  assert.equal(rig.takeCut()?.kind, 'knockdown-wide');
  const cam = rig.camera.position;
  assert(cam.y > 2.0, `high (${cam.y.toFixed(2)})`);
  assert(cam.z > LAYOUT.p1Pos[2] + 0.8, 'behind the standing player');
  assert(cam.x < -0.4, 'from behind the standing player\'s left shoulder (VISUAL-09)');
  const fwd = rig.camera.getWorldDirection(new THREE.Vector3());
  assert(fwd.y < -0.5, 'looking down at the canvas');
  const b = body.p2.clone().project(rig.camera);
  assert(Math.abs(b.x) < 0.5 && Math.abs(b.y) < 0.8, 'the downed opponent is in the middle of the frame');
  assert.equal(rig.wantsGhost, false, 'the standing player is drawn solid');
  // rising: hard cut back to the fight view (stand-off)
  rig.update(1 / 60, ctx({ phase: MatchPhase.RECOVERY, stage: 'rise' }));
  assert.equal(rig.shot, Shot.PLAY);
  assert.equal(rig.takeCut()?.kind, 'standoff');
  assert.equal(rig.settled, 1, 'hard cut');
});

test('camera: player down — raised shot, the player in the foreground, the opponent upright at the far side', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 1);
  rig.takeCut();
  const pos = { p1: new THREE.Vector3(0, 0, 0.575), p2: new THREE.Vector3(0, 0, -1.875) };
  const body = { p1: new THREE.Vector3(0, 0.18, 0.15), p2: new THREE.Vector3() };
  rig.update(1 / 60, ctx({ phase: MatchPhase.KNOCKDOWN, stage: 'count', downed: 'p1', pos, body }));
  assert.equal(rig.shot, Shot.PLAYER_DOWN);
  assert.equal(rig.takeCut()?.kind, 'player-down');
  // Q1: raised and looking down (as in the reference), so the centred count lands between them
  assert(rig.camera.position.y > 1.5, 'raised');
  assert(rig.camera.getWorldDirection(new THREE.Vector3()).y < -0.4, 'looking down past the player');
  const opp = new THREE.Vector3(pos.p2.x, 1.0, pos.p2.z).project(rig.camera);
  assert(Math.abs(opp.x) < 0.8 && Math.abs(opp.y) < 0.8, 'opponent upright in frame');
  const me = body.p1.clone().project(rig.camera);
  assert(me.y < opp.y, 'the downed player sits lower in the frame (foreground)');
  assert(rig.camera.position.distanceTo(body.p1) < rig.camera.position.distanceTo(pos.p2), 'player nearer the lens than the opponent');
});

test('camera: intro / round change — arena, fly-in, ring level, close-up behind the player, then live', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 1);
  rig.takeCut();
  rig.update(1 / 60, ctx({ phase: MatchPhase.BETWEEN, stage: 'arena' }));
  assert.equal(rig.shot, Shot.ARENA);
  assert.equal(rig.takeCut()?.kind, 'round-intro');
  assert(rig.camera.position.y > 4, 'high wide arena shot');
  run(rig, ctx({ phase: MatchPhase.ROUND_START, stage: 'banner' }), 1);
  assert.equal(rig.takeCut(), null, 'the banner keeps the same arena shot');
  const arena = rig.camera.position.clone();
  rig.update(1 / 60, ctx({ phase: MatchPhase.ROUND_START, stage: 'flyin' }));
  assert(rig.camera.position.distanceTo(arena) < 0.3, 'the fly-in starts where the arena shot was');
  run(rig, ctx({ phase: MatchPhase.ROUND_START, stage: 'flyin' }), RIG_TUNING.flyin.dur + 0.05);
  const end = rig.camera.position.clone();
  rig.update(1 / 60, ctx({ phase: MatchPhase.ROUND_START, stage: 'ring' }));
  assert(rig.camera.position.distanceTo(end) < 0.1, 'the fly-in lands on the ring-level shot');
  assert(rig.camera.position.y < 1.4, 'ring level');
  const both = [proj(rig, 0, 1.0, LAYOUT.p1Pos[2]), proj(rig, 0, 1.0, LAYOUT.p2Pos[2])];
  assert(both.every((p) => Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9), 'both fighters in frame');
  rig.update(1 / 60, ctx({ phase: MatchPhase.ROUND_START, stage: 'fight' }));
  assert.equal(rig.shot, Shot.BEHIND);
  assert.equal(rig.takeCut()?.kind, 'fight');
  run(rig, ctx({ phase: MatchPhase.ROUND_START, stage: 'fight' }), RIG_TUNING.behind.dur + 0.1);
  const settledBehind = rig.camera.position.clone();
  run(rig, ctx({ phase: MatchPhase.FIGHTING, stage: 'live' }), 1);
  assert(rig.camera.position.distanceTo(settledBehind) < 0.02, 'the close-up settles exactly into the live view');
});

test('camera: versus — each rig cuts for its own player', () => {
  const a = new CameraRig({ side: 'p1' }), b = new CameraRig({ side: 'p2' });
  const c = ctx({ versus: true, lean: { p1: { x: 0.5, y: -0.2, z: 0.1 }, p2: { x: 0.5, y: -0.2, z: 0.1 } } });
  run(a, c, 1); run(b, c, 1);
  approx(a.camera.position.x, -b.camera.position.x, 1e-6);
  approx(a.camera.position.z, -b.camera.position.z, 1e-6);
  approx(a.camera.fov, RIG_TUNING.play.versusFov, 1e-6);
  b.hitCut({ heavy: false });
  a.update(1 / 60, c); b.update(1 / 60, c); a.update(1 / 60, c); b.update(1 / 60, c);
  assert.equal(b.shot, Shot.HIT); assert.equal(a.shot, Shot.PLAY, 'only the player who was hit cuts');
  const kd = ctx({ versus: true, phase: MatchPhase.KNOCKDOWN, stage: 'count', downed: 'p2' });
  a.update(1 / 60, kd); b.update(1 / 60, kd);
  assert.equal(a.shot, Shot.KD_WIDE); assert.equal(b.shot, Shot.PLAYER_DOWN);
});

test('camera: canvas-level cinematics stay inside the ropes and finite (any arena yaw)', () => {
  for (const side of ['p1', 'p2']) {
    for (const downed of ['p1', 'p2']) {
      const rig = new CameraRig({ side });
      const pos = { p1: new THREE.Vector3(0.35, 0, 1.6), p2: new THREE.Vector3(-0.2, 0, -1.9) };
      for (const stage of ['count', 'ko-hold']) {
        for (let i = 0; i < 60; i++) {
          rig.update(0.05, ctx({ phase: MatchPhase.KNOCKDOWN, stage, downed, pos }));
          const p = rig.camera.position;
          assert(finite(p), 'finite');
          if (p.y < 1.5) assert(Math.hypot(p.x, p.z) <= RIG_TUNING.insideRadius + 1e-6, `${rig.shot} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
        }
      }
      for (const stage of ['ring', 'flyin']) {
        rig.update(0.05, ctx({ phase: MatchPhase.ROUND_START, stage, pos }));
        assert(finite(rig.camera.position));
      }
      // VISUAL-01: the decision two-shot too (0–2.5 s after the bout ends)
      for (let i = 0; i < 50; i++) {
        rig.update(0.05, ctx({ phase: MatchPhase.DECISION, stage: 'decision', phaseTime: i * 0.05, stageTime: i * 0.05, pos }));
        const p = rig.camera.position;
        assert(finite(p));
        if (p.y < 1.5) assert(Math.hypot(p.x, p.z) <= RIG_TUNING.insideRadius + 1e-6, `decision at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      }
    }
  }
});

test('camera: pausing freezes the camera; resuming continues', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx({ phase: MatchPhase.ROUND_START, stage: 'flyin' }), 0.5);
  rig.update(1 / 60, ctx({ phase: MatchPhase.PAUSED }));
  const frozen = rig.camera.position.clone();
  run(rig, ctx({ phase: MatchPhase.PAUSED }), 2);
  assert(rig.camera.position.distanceTo(frozen) < 1e-9);
  run(rig, ctx({ phase: MatchPhase.ROUND_START, stage: 'flyin' }), 0.05);
  assert.equal(rig.shot, Shot.FLYIN);
  assert(rig.camera.position.distanceTo(frozen) < 0.3, 'no jump on resume');
});

test('camera: the outro drives the pose through setOverride; menu orbit keeps moving', () => {
  const rig = new CameraRig({ side: 'p1' });
  run(rig, ctx(), 0.5);
  const pose = { pos: new THREE.Vector3(1, 1, 3), target: new THREE.Vector3(0, 1, 0), fov: 40, roll: 0 };
  rig.setOverride(pose);
  rig.update(1 / 60, ctx({ phase: MatchPhase.RESULT }));
  assert.equal(rig.shot, Shot.OUTRO);
  assert(rig.camera.position.distanceTo(pose.pos) < 1e-6 && rig.hasOverride);
  approx(rig.camera.fov, 40, 1e-6);
  rig.setOverride(null);
  rig.update(1 / 60, ctx({ phase: MatchPhase.RESULT, winner: 'p1' }));
  assert.equal(rig.shot, Shot.RESULT);
  const menu = new CameraRig({ side: 'p1' });
  menu.update(1 / 60, ctx({ mode: 'menu' }));
  const a = menu.camera.position.clone();
  run(menu, ctx({ mode: 'menu' }), 3);
  assert(menu.camera.position.distanceTo(a) > 0.5);
});
