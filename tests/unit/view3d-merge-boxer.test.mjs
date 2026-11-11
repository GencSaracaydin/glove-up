// merge-fix (input round) — the player's own boxer after the input lanes were merged:
//  * VIEW3D-LOST-FRAME: a human view from an untracked frame (the recognizer lost a wrist, the shoulders or the head for a
//    moment) showed the stance pose, so the stiff own gloves twitched there and back and the live camera slid; the renderer
//    now keeps the last tracked hands, guard and lean for RENDER_TUNING.lostHoldMs. Display only: game/boxer.js's combat
//    state (guard, lean, punches) is what it was; its view only adds `tracked`.
//  * the R11 springs (ANIM.w…Human) re-tuned to the lead's jitter limit with the merged recognizer's input (boxer-model.js).
import * as THREE from 'three';
import { test, assert } from '../harness.mjs';
import { RENDER_TUNING, holdLostView, GameRenderer } from '../../src/render/renderer.js';
import { BoxerModel, placeBoxer, gloveWorldPosition, ANIM } from '../../src/render/boxer-model.js';
import { DEFAULT_PLAYER } from '../../src/render/appearance.js';
import { Boxer } from '../../src/game/boxer.js';

const HANDS_UP = { left: { x: -0.18, y: 0.46, reach: 0.08, punching: false }, right: { x: 0.2, y: 0.42, reach: 0.1, punching: false } };
const view = (o = {}) => ({ id: 'p1', isHuman: true, tracked: true, phase: 'guard', phaseProgress: 0, guard: 'high', guardAmount: 1, lean: { x: 0.2, y: -0.1, z: 0 }, hands: HANDS_UP, punch: null, punches: [], windup: null, hitReact: null, hp01: 1, hp: 10, expression: 'neutral', ...o });
const STANCE = { left: { x: -0.14, y: 0.05, reach: 0.1, punching: false }, right: { x: 0.14, y: 0.05, reach: 0.1, punching: false } };
const mem = () => ({ at: -Infinity, hands: null, guard: 'none', guardAmount: 0, lean: null, phase: null });
const untracked = (o = {}) => view({ tracked: false, phase: 'idle', guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, hands: STANCE, ...o });

test('lost frame: within lostHoldMs an untracked human view keeps the last tracked hands, guard and lean; after it, the stance pose as before', () => {
  assert(RENDER_TUNING.lostHoldMs >= 150 && RENDER_TUNING.lostHoldMs <= 250, `${RENDER_TUNING.lostHoldMs}`);
  const m = mem();
  const t1 = view();
  assert.equal(holdLostView(t1, m, 1000), t1, 'a tracked view passes through (and is remembered)');
  const h = holdLostView(untracked(), m, 1100);
  assert(h.held === true && h.hands === HANDS_UP && h.guard === 'high' && h.guardAmount === 1 && h.lean.x === 0.2 && h.tracked === false, JSON.stringify(h));
  assert(h.phase === 'guard' && h.punches.length === 0, 'the phase those made (guard), everything else the frame\'s own');
  const late = untracked();
  assert.equal(holdLostView(late, m, 1000 + RENDER_TUNING.lostHoldMs + 1), late, 'a longer loss shows the stance pose');
  // the AI, a missing view and views without the flag (other callers) pass through
  const ai = view({ isHuman: false, tracked: false });
  assert.equal(holdLostView(ai, m, 1100), ai);
  assert.equal(holdLostView(null, m, 1100), null);
  const legacy = view({ tracked: undefined });
  assert.equal(holdLostView(legacy, mem(), 1100), legacy);
});

test('lost frame: nothing is held over a punch, a hit or a fall (those draw their own hands)', () => {
  const m = mem();
  holdLostView(view(), m, 1000);
  const punching = untracked({ phase: 'punch' });
  assert.equal(holdLostView(punching, m, 1050), punching, 'the untracked frame itself is a punch: as is');
  holdLostView(view({ phase: 'recover' }), m, 1100); // a tracked frame mid-punch clears what was remembered
  const after = untracked();
  assert.equal(holdLostView(after, m, 1150), after);
  const m2 = mem();
  holdLostView(view(), m2, 1000);
  const hit = untracked({ phase: 'hitstun' });
  assert.equal(holdLostView(hit, m2, 1050), hit);
});

test('lost frame: game/boxer.js marks untracked frames in its view only — guard, lean and punches as before', () => {
  const b = new Boxer({ id: 'p1', isHuman: true, latencyMs: 0 });
  const control = (tracked) => ({ tracked, confidence: 1, guard: 'high', guardAmount: 1, lean: { x: 0.5, y: 0, z: 0 }, head: { x: 0, y: 0 }, hands: { left: { x: -0.2, y: 0.4, reach: 0.1, punching: false }, right: { x: 0.2, y: 0.4, reach: 0.1, punching: false } }, activity: 0, guardMs: 500, stanceMs: 0 });
  b.setControl(control(true), 1000); b.update(1000);
  let v = b.toView(1000);
  assert(v.tracked === true && v.guard === 'high' && v.lean.x === 0.5 && v.hands.left.y === 0.4, JSON.stringify(v.hands));
  b.setControl(control(false), 1033); b.update(1033);
  v = b.toView(1033);
  assert(v.tracked === false, 'flagged');
  assert(b.guard === 'none' && b.lean.x === 0 && b.control === null, 'combat sees an untracked player exactly as before (no guard, no lean)');
  assert(v.hands.left.y !== 0.4, 'and the view still shows the stance pose — the renderer decides what to draw');
  const ai = new Boxer({ id: 'p2', isHuman: false });
  assert(ai.toView(0).tracked === true);
});

test('lost frame: the renderer holds per boxer slot, and the stiff own gloves no longer jump to the stance pose and back', () => {
  // the renderer's per-frame hook, without WebGL
  const R = Object.create(GameRenderer.prototype);
  let now = 0;
  R._clock = () => now;
  R._slots = { p1: { held: mem() }, p2: { held: mem() } };
  const foe = view({ id: 'p2', isHuman: false });
  const frame = (p1) => R._holdLost({ phase: 'fighting', boxers: { p1, p2: foe } });
  const v0 = { phase: 'fighting', boxers: { p1: view(), p2: foe } };
  assert.equal(R._holdLost(v0), v0, 'nothing to hold: the same view object');
  now = 100;
  const v1 = frame(untracked());
  assert(v1.boxers.p1.held && v1.boxers.p1.hands === HANDS_UP && v1.boxers.p2 === foe, 'the human held, the opponent untouched');
  // through the real model: two untracked camera frames (67 ms) in a held guard
  const run = (hold, drop = true) => {
    const m = new BoxerModel(DEFAULT_PLAYER, { ghost: true, seed: 1 }); placeBoxer(m, 'p1');
    const mm = mem();
    let worst = 0, rest = null;
    for (let i = 0; i < 120; i++) {
      const t = i * (1000 / 60);
      const camFrame = Math.floor(t / (1000 / 30));
      const lost = drop && (camFrame === 40 || camFrame === 41);
      let v = lost ? untracked() : view();
      if (hold) v = holdLostView(v, mm, t);
      m.update(v, 1 / 60);
      const p = gloveWorldPosition(m, 'left', new THREE.Vector3());
      if (i === 78) rest = p.clone();
      if (i > 78 && rest) worst = Math.max(worst, p.distanceTo(rest));
    }
    return worst * 1000;
  };
  const calm = run(false, false), snap = run(false), held = run(true);
  assert(snap > calm + 40 && held <= calm + 1, `over the same frames the glove moves ${calm.toFixed(1)} mm with no dropout (the idle bob), ${snap.toFixed(1)} mm with two lost frames, ${held.toFixed(1)} mm with them held`);
});

test('R11 springs after the merge (merge-refix): total lag no worse than the polish build, then the least motion that allows (recorded in boxer-model.js)', () => {
  // gloves: the polish ω (the recognizer's hand lag is unchanged); spine / hips softer by the 10 ms the recognizer's lean gained
  assert.deepEqual([ANIM.wGloveHuman, ANIM.wHeadHuman, ANIM.wSpineHuman, ANIM.wBodyHuman], [50, 40, 31, 30]);
  // every one still stiffer than the shared (AI) springs, so the player's own boxer keeps following closely
  assert(ANIM.wGloveHuman > ANIM.wGlove && ANIM.wHeadHuman > ANIM.wHead && ANIM.wSpineHuman > ANIM.wSpine && ANIM.wBodyHuman > ANIM.wBody);
});
