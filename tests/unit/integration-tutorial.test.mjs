// src/app/tutorial.js — the first-bout tutorial runner (research/mechanics.md §8, ARCHITECTURE.md §6.9)
// against the real Match in tutorial mode: six live cards (stance → guard face → punch face → guard
// body → punch body → dodge), each advancing on a 1 s hold or 3 detections with a 10 s cap, then
// "Fight!" and the clock. Also through MatchSession (skip, restart, onTutorialDone).
import { test, assert } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { TutorialRunner, TUTORIAL_TUNING } from '../../src/app/tutorial.js';
import { MatchSession } from '../../src/app/session.js';

const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.1, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.1, reach: 0.1, punching: false } },
  activity: 0, guardMs: 0, stanceMs: 0, ...o,
});
const punch = (target, t, hand = 'left') => ({ type: 'punch', t, punch: { hand, kind: 'straight', target, power: 0.6, t } });

function fakeHud() {
  const calls = [];
  return {
    calls,
    showTutorial: (t) => calls.push({ k: 'show', step: t.step, index: t.index, total: t.total, p: t.progress01, mode: t.mode }),
    hideTutorial: () => calls.push({ k: 'hide' }),
  };
}

/** A scripted player who does what each card asks (keyboard-like ControlStates). */
function diligentPlayer() {
  let lastPunch = -1e9, leanOut = false, lastLean = -1e9;
  return (step, now) => {
    switch (step) {
      case 'stance': return { control: ctl({ stanceMs: 5000 }), events: [] };
      case 'guard-head': return { control: ctl({ guard: 'high', guardAmount: 1, guardMs: 5000 }), events: [] };
      case 'guard-body': return { control: ctl({ guard: 'low', guardAmount: 1, guardMs: 5000 }), events: [] };
      case 'punch-head':
      case 'punch-body':
        if (now - lastPunch >= 450) { lastPunch = now; return { control: ctl(), events: [punch(step === 'punch-head' ? 'head' : 'body', now, Math.random() < 0.5 ? 'left' : 'right')] }; }
        return { control: ctl(), events: [] };
      case 'dodge':
        if (now - lastLean >= 300) { leanOut = !leanOut; lastLean = now; }
        return { control: ctl({ lean: { x: leanOut ? -1 : 0, y: 0, z: 0 } }), events: [] };
      default: return { control: ctl(), events: [] };
    }
  };
}

function rig({ fast = true, player = null } = {}) {
  const bus = new EventBus();
  const calls = [];
  bus.on(Ev.MATCH_CALL, (e) => calls.push(e.call));
  const match = new Match({ bus, mode: 'single', p1: { name: 'Pat', isHuman: true }, p2: ROSTER[0], rng: 7, fast, rules: { tutorial: true } });
  const hud = fakeHud();
  const done = [];
  const tut = new TutorialRunner({ match, hud, fast, mode: 'keyboard', onDone: (i) => done.push(i) });
  let now = 0;
  match.start(now);
  const act = player || (() => ({ control: ctl(), events: [] }));
  return {
    match, hud, tut, done, calls,
    get now() { return now; },
    step(ms) {
      for (let t = 0; t < ms; t += 16) {
        now += 16;
        const input = act(tut.step || match.getView().stage, now);
        match.update(0.016, now, { p1: input });
        tut.update(now, input, match.getView());
      }
    },
    until(pred, maxMs = 120000) {
      const end = now + maxMs;
      while (!pred() && now < end) this.step(16);
      return pred();
    },
  };
}

test('tutorial: six live cards advance on holds and detections, then "Fight!" and the clock (§8)', () => {
  const r = rig({ player: diligentPlayer() });
  assert.equal(r.tut.stage, 'waiting');
  r.step(100);
  assert.equal(r.match.phase, MatchPhase.INTRO, 'the arena shot first');
  assert(r.until(() => r.tut.stage === 'card'), 'the first card appears when the tutorial begins');
  assert.equal(r.tut.step, 'stance');
  const v0 = r.match.getView();
  assert(v0.phase === MatchPhase.FIGHTING && v0.tutorial && v0.clockVisible === false, 'live, no clock');
  assert(r.until(() => r.tut.finished, 60000), 'the tutorial finishes');
  assert.deepEqual(r.tut.log.map((l) => l.step), [...TUTORIAL_TUNING.steps], 'all six cards in order');
  assert.deepEqual(r.tut.log.map((l) => l.reason), ['hold', 'hold', 'count', 'hold', 'count', 'count'], JSON.stringify(r.tut.log));
  for (const l of r.tut.log) assert(l.ms < TUTORIAL_TUNING.fast.capMs, `${l.step} completed before the cap (${l.ms} ms)`);
  assert(r.tut.log.find((l) => l.step === 'stance').ms >= 1000 - 20, 'a 1 s hold');
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].skipped, false);
  // the HUD saw every card in order (with the keyboard wording) and a check mark before the next
  const shown = [];
  for (const c of r.hud.calls) if (c.k === 'show' && shown[shown.length - 1] !== c.step) shown.push(c.step);
  assert.deepEqual(shown, [...TUTORIAL_TUNING.steps]);
  assert(r.hud.calls.every((c) => c.k !== 'show' || (c.total === 6 && c.mode === 'keyboard')));
  assert(r.hud.calls.some((c) => c.k === 'show' && c.step === 'guard-head' && c.p === 1), 'a completed card shows full progress');
  assert.equal(r.hud.calls[r.hud.calls.length - 1].k, 'hide', 'the card closes at "Fight!"');
  // "Fight!" (no round banner) → the clock runs
  assert(r.calls.includes('fight'), 'Fight! call');
  assert(!r.calls.includes('round'), 'no round banner after the tutorial');
  assert(r.until(() => r.match.phase === MatchPhase.FIGHTING && r.match.getView().clockVisible), 'round 1 is live');
  const v = r.match.getView();
  assert(!v.tutorial && v.stage === 'live' && v.boxers.p1.hp === 10 && v.boxers.p2.hp === 10, 'fresh health, no tutorial left');
  const c0 = v.clockDisplayMs;
  r.step(1000);
  assert(r.match.getView().clockDisplayMs < c0, 'the clock counts down');
});

test('tutorial: every card advances after the cap when nothing is detected; nobody gets hurt', () => {
  const r = rig();
  assert(r.until(() => r.tut.finished, 60000));
  assert.deepEqual(r.tut.log.map((l) => l.reason), ['cap', 'cap', 'cap', 'cap', 'cap', 'cap']);
  for (const l of r.tut.log) assert(Math.abs(l.ms - TUTORIAL_TUNING.fast.capMs) < 40, `${l.step}: ${l.ms} ms`);
  const v = r.match.getView();
  assert.equal(v.boxers.p1.hp, 10, 'tutorial punches do no damage');
  // full-length tuning: the 10 s cap of §8
  assert.equal(TUTORIAL_TUNING.capMs, 10000);
  assert.equal(TUTORIAL_TUNING.holdMs, 1000);
  assert.equal(TUTORIAL_TUNING.count, 3);
});

test('tutorial: skip ends it at once ("Fight!"), even before it began', () => {
  const r = rig({ player: diligentPlayer() });
  assert(r.until(() => r.tut.step === 'punch-head'));
  assert.equal(r.tut.skip(), true);
  assert(r.tut.finished && r.done.length === 1 && r.done[0].skipped === true);
  assert.equal(r.tut.skip(), false, 'skipping twice does nothing');
  r.step(50);
  assert(!r.match.getView().tutorial, 'the match left tutorial mode');
  assert(r.calls.includes('fight'));
  // before the tutorial began (the arena shot): the bout starts normally with its round banner
  const q = rig();
  q.step(30);
  assert.equal(q.match.phase, MatchPhase.INTRO);
  q.tut.skip();
  assert(q.until(() => q.match.phase === MatchPhase.FIGHTING));
  assert(q.calls.includes('round') && !q.match.getView().tutorial);
});

test('tutorial: MatchSession runs it for a first bout, skipTutorial() works, restart never repeats a finished one', () => {
  const bus = new EventBus();
  const hud = { ...fakeHud(), show() {}, hide() {}, update() {} };
  const done = [];
  const s = new MatchSession({
    bus, renderer: null, hud, mode: 'single', players: [{ id: 'g', name: 'Gus' }], opponent: ROSTER[0],
    seed: 3, fast: true, tutorial: true, inputMode: 'keyboard', onTutorialDone: (i) => done.push(i),
  });
  s.begin();
  assert(s.tutorialActive, 'tutorial pending');
  let now = 0;
  const idle = [{ control: ctl({ stanceMs: 5000 }), events: [] }];
  for (let i = 0; i < 200 && s.tutorial.stage !== 'card'; i++) { now += 16; s.update(0.016, now, idle); }
  assert.equal(s.tutorial.step, 'stance');
  assert.equal(s.view.tutorial.step, 'stance');
  // a restart DURING the tutorial runs it again from the first card
  s.restart();
  assert(s.tutorialActive && s.tutorial.stage === 'waiting', 'tutorial again after Start over');
  for (let i = 0; i < 200 && s.tutorial.stage !== 'card'; i++) { now += 16; s.update(0.016, now, idle); }
  assert(s.skipTutorial(), 'skipped');
  assert(!s.tutorialActive && done.length === 1 && done[0].skipped);
  for (let i = 0; i < 100 && s.match.phase !== MatchPhase.FIGHTING; i++) { now += 16; s.update(0.016, now, idle); }
  assert(s.match.phase === MatchPhase.FIGHTING && !s.view.tutorial, 'the bout is live');
  // restart AFTER it was skipped: no tutorial again
  s.restart();
  assert(!s.tutorial && !s.match.rules.tutorial, 'not repeated');
  assert.equal(done.length, 1);
  // versus never runs it
  const v = new MatchSession({ bus, renderer: null, hud, mode: 'versus', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 1, fast: true, tutorial: true });
  v.begin();
  assert(!v.tutorialActive && !v.match.rules.tutorial);
});
