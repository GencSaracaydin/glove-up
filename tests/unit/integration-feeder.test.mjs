// src/app/pose-feeder.js — the scripted "camera" behind window.__glove.injectPose — and the whole
// synthetic path in Node: PoseFeeder → InputHub (PlayerAssigner + GestureRecognizer) → MatchSession.
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, InputMode, MatchPhase } from '../../src/core/types.js';
import { PoseFeeder, FEEDER_DEFAULTS } from '../../src/app/pose-feeder.js';
import { InputHub } from '../../src/input/input-hub.js';
import { MatchSession } from '../../src/app/session.js';
import { ROSTER } from '../../src/game/roster.js';

function fakeHub() {
  return { frames: [], injectFrames(f) { this.frames.push(...f); } };
}

test('feeder: frames at the camera rate, in order, one pose per active player', () => {
  let now = 5000;
  const hub = fakeHub();
  const f = new PoseFeeder(hub, { now: () => now, noise: 0 });
  assert.equal(f.tick(), 0, 'idle feeder sends nothing');
  const step = f.push('guard-high', 1000);
  assert(step.startsAt === 5000 && step.endsAt === 6000);
  now += 1000;
  f.tick();
  const n = hub.frames.length;
  assert(n >= 29 && n <= 31, `${n} frames in 1 s`);
  for (let i = 1; i < n; i++) assert(hub.frames[i].t > hub.frames[i - 1].t, 'increasing timestamps');
  assert(hub.frames.every((fr) => fr.players.length === 1 && fr.width === FEEDER_DEFAULTS.width));
  // a second synthetic player joins
  f.push('guard-high', 500, { player: 1 });
  now += 300;
  f.tick();
  const last = hub.frames[hub.frames.length - 1];
  assert.equal(last.players.length, 2, 'both players in the picture');
  // raw camera space: P1 stands toward the image's right (= left of the mirrored preview)
  const noseX = (p) => p.image[0].x;
  assert(noseX(last.players[0]) > noseX(last.players[1]), 'P1 on the right of the raw frame');
  // everybody leaves → frames stop
  f.stop();
  const k = hub.frames.length;
  now += 500;
  assert.equal(f.tick(), 0);
  assert.equal(hub.frames.length, k);
});

test('feeder: steps continue from the previous pose and a stall is capped', () => {
  let now = 0;
  const hub = fakeHub();
  const f = new PoseFeeder(hub, { now: () => now, noise: 0 });
  f.push('guard-high', 400);
  now = 400; f.tick();
  const a = hub.frames[hub.frames.length - 1].players[0].image[15];
  // the script ran out 600 ms ago: the next step starts now and blends from the held guard
  now = 1000; f.tick();
  f.push('jab-left', 500);
  now = 1034; f.tick();
  const b = hub.frames[hub.frames.length - 1].players[0].image[15];
  assert(Math.hypot(a.x - b.x, a.y - b.y) < 0.05, 'no teleport between steps');
  assert(f.busyUntil(0) > now, 'busy with the jab');
  // a 5 s stall renders at most maxCatchUpMs of frames
  const before = hub.frames.length;
  now += 5000; f.tick();
  assert(hub.frames.length - before <= Math.ceil(FEEDER_DEFAULTS.maxCatchUpMs / (1000 / FEEDER_DEFAULTS.fps)) + 1);
  assert.throws(() => f.push('moonwalk', 300), /unknown action/);
});

test('feeder → InputHub → GestureRecognizer → Match: scripted punches land in a real bout; leaving the picture is noticed (ERR02)', () => {
  let now = 10000;
  const bus = new EventBus();
  const lost = [];
  const punches = [];
  bus.on(Ev.INPUT_TRACKING_LOST, (e) => lost.push(e.player));
  bus.on(Ev.INPUT_PUNCH, (e) => punches.push(e.punch));
  const hub = new InputHub({ bus, mode: InputMode.CAMERA, players: 1 }); // never started: no camera, frames are injected
  const feeder = new PoseFeeder(hub, { now: () => now, noise: 0.3 });
  const session = new MatchSession({ bus, renderer: null, hud: null, mode: 'single', players: [{ id: 'g', name: 'Gus' }], opponent: ROSTER[0], seed: 2, fast: true });
  feeder.push('guard-high', 1500);
  const tick = (ms) => {
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      feeder.tick(now);
      const { players } = hub.update(now);
      session.update(0.016, now, players);
    }
  };
  tick(1200);
  assert(hub.status.tracking[0] === true, 'the synthetic player is tracked');
  session.begin();
  for (let i = 0; i < 400 && session.match.phase !== MatchPhase.FIGHTING; i++) tick(16);
  assert.equal(session.match.phase, MatchPhase.FIGHTING);
  for (const a of ['jab-left', 'guard-high', 'cross', 'guard-high', 'jab-left', 'guard-high', 'hook-right', 'guard-high']) feeder.push(a, a.startsWith('guard') ? 450 : 650);
  tick(5500);
  assert(punches.length >= 3, `recognised punches: ${punches.length}`);
  assert(session.match.boxers.p1.stats.thrown >= 2, `thrown in the bout: ${session.match.boxers.p1.stats.thrown}`);
  // the player walks away: no more frames → tracking lost after the hub's debounce
  feeder.stop();
  tick(1600);
  assert(lost.includes(0) && hub.status.tracking[0] === false, 'tracking lost reported');
});
