// Pure HUD logic (src/ui/hud.js) for the alignment pass (ARCHITECTURE.md §6.4, §6.7, §6.9;
// research/mechanics.md §5): text calls from view.call / view.count (and the older view.banner),
// clock visibility, round lamps, the outro win banner, tutorial texts, the get-up hint and the
// training popup stack (no overlapping texts).
import { test, assert } from '../harness.mjs';
import {
  hudCall, hudBanner, clockVisibleFor, roundLamps, outroBannerText, tutorialText, tutorialSkipHint, getUpHint,
  PopupStack, TUTORIAL_STEPS, HUD_TUNING, tutorialProgress,
} from '../../src/ui/hud.js';

const boxers = (o = {}) => ({ p1: { name: 'Sam', knockdowns: 0, ...o.p1 }, p2: { name: 'Pip', knockdowns: 0, ...o.p2 } });
/** A MatchView as the aligned match produces it (call / stage / clockVisible present). */
const view = (over = {}) => ({
  phase: 'fighting', phaseTime: 5, stage: 'live', round: 1, maxRounds: 3, downed: null, count: null, result: null,
  clockVisible: true, call: null, boxers: boxers(), banner: null, ...over,
});
/** The older match (first build): no call / stage / clockVisible fields. */
const legacy = (over = {}) => {
  const v = view(over);
  if (!('call' in over)) delete v.call;
  if (!('stage' in over)) delete v.stage;
  if (!('clockVisible' in over)) delete v.clockVisible;
  return v;
};

test('hud: measured call timings (research/mechanics.md §5 "Text calls")', () => {
  const C = HUD_TUNING.callMs;
  assert(C.round >= 1500 && C.round <= 2500, '"Round N" 1.5–2.5 s');
  assert(C['final-round'] >= 1500 && C['final-round'] <= 2500, 'final-round banner 1.5–2.5 s');
  assert(C.fight >= 750 && C.fight <= 1000, '"Fight!" 0.75–1 s');
  assert(C.down >= 750 && C.down <= 1000, '"Down" 0.75–1 s');
  assert(HUD_TUNING.countMs >= 400 && HUD_TUNING.countMs <= 650, 'each number visible ~0.5 s');
  assert(HUD_TUNING.countMs < 1080, 'a number is gone before the next one (1.08 s apart)');
  assert(C.ko >= 1300 && C.ko <= 2000, '"KO" letters bounce ~1.5 s');
  assert(HUD_TUNING.winBannerMaxMs >= 3000 && HUD_TUNING.winBannerMaxMs <= 5000, 'win banner 3–5 s');
});

test('hud: view.call drives the calls; each lives for its measured time', () => {
  const r = hudCall(view({ phase: 'roundStart', round: 2, clockVisible: false, call: { call: 'round', round: 2, age: 0.4 } }));
  assert.equal(r.kind, 'round');
  assert.equal(r.text, 'ROUND 2');
  assert.equal(r.final, false);
  assert.equal(hudCall(view({ phase: 'roundStart', round: 2, call: { call: 'round', round: 2, age: 2.6 } })), null, 'expired by age');
  const fin = hudCall(view({ phase: 'roundStart', round: 3, call: { call: 'final-round', round: 3, age: 0.1 } }));
  assert.equal(fin.text, 'FINAL ROUND');
  assert.equal(fin.final, true);
  assert.equal(hudCall(view({ round: 3, call: { call: 'round', round: 3, age: 0 } })).final, true, 'round 3 of 3 is the final round');
  const f = hudCall(view({ call: { call: 'fight', age: 0.2 } }));
  assert.equal(f.text, 'FIGHT!');
  assert.equal(f.lifeMs, HUD_TUNING.callMs.fight);
  assert.equal(hudCall(view({ call: { call: 'fight', age: 1.2 } })), null);
  assert.equal(hudCall(view({ phase: 'knockdown', downed: 'p2', stage: 'down-call', call: { call: 'down', boxer: 'p2', age: 0.3 } })).text, 'DOWN!');
  assert.equal(hudCall(view({ phase: 'roundEnd', call: { call: 'time', age: 0.2 } })).text, 'TIME!');
  assert.equal(hudCall(view({ phase: 'decision', call: { call: 'decision', age: 0.2 } })).text, 'DECISION');
  assert.equal(hudCall(view({ call: { call: 'mystery', age: 0 } })), null, 'unknown calls show nothing');
  assert.equal(hudCall(view()), null, 'no call while fighting');
  assert.equal(hudCall(null), null);
});

test('hud: count numbers pop one by one; "KO" wins; no number after the bout is decided', () => {
  const kd = (n, over = {}) => view({ phase: 'knockdown', stage: 'count', downed: 'p2', count: n, clockVisible: false, boxers: boxers({ p2: { knockdowns: 1 } }), call: { call: 'down', boxer: 'p2', age: 0.5 }, ...over });
  const one = hudCall(kd(1));
  assert.equal(one.kind, 'count', 'the count supersedes a "Down" still on screen');
  assert.equal(one.text, '1');
  assert.equal(one.lifeMs, HUD_TUNING.countMs);
  const keys = [1, 2, 3, 10].map((n) => hudCall(kd(n)).key);
  assert.equal(new Set(keys).size, 4, 'every number is a new pop');
  const again = hudCall(view({ phase: 'knockdown', stage: 'count', downed: 'p2', count: 1, boxers: boxers({ p2: { knockdowns: 2 } }), call: { call: 'down', age: 3 } }));
  assert.notEqual(again.key, one.key, 'the next knockdown counts afresh');
  const ko = hudCall(kd(10, { stage: 'ko-call', call: { call: 'ko', winner: 'p1', age: 0.2 }, result: { winner: 'p1', method: 'KO' } }));
  assert.equal(ko.kind, 'ko');
  assert.equal(ko.text, 'KO');
  assert.equal(hudCall(kd(10, { stage: 'ko-hold', call: { call: 'ko', winner: 'p1', age: 5 }, result: { winner: 'p1', method: 'KO' } })), null, 'no "10" again after the KO call');
  assert.equal(hudCall(kd(4, { phase: 'recovery', stage: 'rise', call: { call: 'down', age: 6 } })), null, 'no numbers once rising');
  assert.equal(hudCall(kd(4, { stage: 'fall', call: { call: 'down', age: 6 } })), null, 'no numbers outside the count stage');
});

test('hud: Ev.MATCH_CALL (extra.call) works when the view has no call field', () => {
  const v = legacy({ phase: 'roundStart', round: 2 });
  const r = hudCall(v, { call: { call: 'round', round: 2, age: 0.3 } });
  assert.equal(r.text, 'ROUND 2');
  assert.equal(hudCall(legacy({ phase: 'fighting', phaseTime: 9 }), { call: { call: 'fight', age: 3 } }), null, 'expired event call');
});

test('hud: fallback to view.banner (older match) — own wording, no TKO, no referee', () => {
  assert.equal(hudCall(legacy({ banner: { text: 'Gloves up!', kind: 'fight' } })).text, 'FIGHT!');
  assert.equal(hudCall(legacy({ phase: 'roundStart', round: 3, banner: { text: 'Round 3', kind: 'round' } })).text, 'FINAL ROUND');
  assert.equal(hudCall(legacy({ phase: 'knockdown', downed: 'p2', banner: { text: 'Down!', kind: 'knockdown' } })).text, 'DOWN!');
  assert.equal(hudCall(legacy({ phase: 'knockdown', downed: 'p2', count: 7, banner: { text: '7', kind: 'count' } })).text, '7');
  assert.equal(hudCall(legacy({ phase: 'knockdown', result: { winner: 'p1', method: 'TKO' }, banner: { text: 'T.K.O.!', kind: 'tko' } })).text, 'KO');
  assert.equal(hudCall(legacy({ phase: 'roundEnd', banner: { text: 'End of round 1', kind: 'roundEnd' } })).text, 'TIME!');
  assert.equal(hudCall(legacy({ phase: 'result', result: { winner: 'p2', method: 'decision' }, banner: { text: 'Pip wins!', kind: 'result' } })).text, 'PIP WINS!');
  for (const kind of ['intro', 'between', 'getup', 'paused']) assert.equal(hudCall(legacy({ banner: { text: 'x', kind } })), null, `${kind}: the reference shows no text`);
  const phaseOnly = legacy({ phase: 'fighting', phaseTime: 0.2 });
  delete phaseOnly.banner;
  assert.equal(hudCall(phaseOnly).text, 'FIGHT!');
  const all = ['round', 'fight', 'knockdown', 'count', 'ko', 'tko', 'roundEnd', 'decision', 'result'].map((kind) => hudCall(legacy({ phase: 'knockdown', result: { winner: 'p1', method: 'TKO' }, banner: { text: 'T.K.O.!', kind } })));
  for (const c of all) if (c) assert(!/T\.?K\.?O|referee/i.test(`${c.text} ${c.sub || ''}`), `no TKO / referee text (${c.text})`);
  assert.equal(hudBanner, hudCall, 'older name kept');
});

test('hud: plates + clock show only while live (view.clockVisible), with a phase fallback', () => {
  assert.equal(clockVisibleFor(view({ clockVisible: true })), true);
  assert.equal(clockVisibleFor(view({ clockVisible: false })), false);
  assert.equal(clockVisibleFor(legacy({ phase: 'fighting' })), true);
  for (const phase of ['intro', 'roundStart', 'knockdown', 'recovery', 'between', 'decision', 'result']) assert.equal(clockVisibleFor(legacy({ phase })), false, phase);
  assert.equal(clockVisibleFor(legacy({ phase: 'roundEnd', phaseTime: 0.4 })), true, 'clock at 0:00 with the bell');
  assert.equal(clockVisibleFor(legacy({ phase: 'roundEnd', phaseTime: 3 })), false);
  assert.equal(clockVisibleFor(legacy({ phase: 'paused', pausedFrom: 'fighting' })), true);
  assert.equal(clockVisibleFor(legacy({ phase: 'fighting', tutorial: { step: 'stance' } })), false, 'no clock during the tutorial');
  assert.equal(clockVisibleFor(null), false);
});

test('hud: three round lamps — done / current / future', () => {
  assert.deepEqual(roundLamps(1, 3), ['now', 'next', 'next']);
  assert.deepEqual(roundLamps(2, 3), ['done', 'now', 'next']);
  assert.deepEqual(roundLamps(3, 3), ['done', 'done', 'now']);
  assert.equal(roundLamps(1, undefined).length, 3);
});

test('hud: outro win banner text', () => {
  assert.equal(outroBannerText({ winner: 'p1' }, { humanSide: 'p1', names: { p1: 'Sam', p2: 'Pip' } }).text, 'YOU WIN!');
  const lost = outroBannerText({ winner: 'p2' }, { humanSide: 'p1', names: { p1: 'Sam', p2: 'Pip' } });
  assert.equal(lost.text, 'PIP WINS!');
  assert.equal(lost.kind, 'loss');
  assert.equal(outroBannerText({ winner: 'p2' }, { humanSide: null, names: { p1: 'Sam', p2: 'Ana' } }).text, 'ANA WINS!', 'versus names the winner');
  assert.equal(outroBannerText({ winner: null }).text, 'DRAW!');
});

test('hud: first-bout tutorial — six steps with a title and a 2-line caption, camera and keyboard', () => {
  assert.deepEqual([...TUTORIAL_STEPS], ['stance', 'guard-head', 'punch-head', 'guard-body', 'punch-body', 'dodge']);
  for (const mode of ['camera', 'keyboard']) {
    for (const step of TUTORIAL_STEPS) {
      const t = tutorialText(step, mode);
      assert.equal(t.step, step);
      assert(t.title.length > 3, `${mode}/${step} title`);
      assert.equal(t.caption.length, 2, `${mode}/${step} has 2 caption lines`);
      for (const line of t.caption) assert(line.length > 3 && line.length <= 70, `${mode}/${step} caption line fits: "${line}"`);
    }
  }
  assert.match(tutorialText('guard-head', 'keyboard').caption.join(' '), /Hold Space to cover your face/);
  assert.match(tutorialText('guard-body', 'keyboard').caption.join(' '), /\bB\b/);
  assert.match(tutorialText('punch-body', 'keyboard').caption.join(' '), /Shift/);
  assert.match(tutorialText('dodge', 'camera').caption.join(' '), /[Ll]ean/);
  assert.equal(tutorialText('nope').step, 'stance');
  assert.match(tutorialSkipHint('keyboard'), /Skip tutorial/);
  assert.match(tutorialSkipHint('camera'), /Skip tutorial/);
});

test('hud: auto tutorial progress from the match’s view.tutorial (hold or 3 detections)', () => {
  assert.equal(tutorialProgress(null), null);
  assert.equal(tutorialProgress({ step: 'guard-head', holdMs: HUD_TUNING.tutorialHoldMs / 2 }), 0.5);
  assert.equal(tutorialProgress({ step: 'guard-body', holdMs: 99999 }), 1);
  assert.equal(tutorialProgress({ step: 'punch-head', count: 2 }), 2 / 3);
  assert.equal(tutorialProgress({ step: 'dodge', count: 5 }), 1);
  assert.equal(tutorialProgress({ step: 'punch-body', count: 1, progress01: 0.9 }), 0.9, 'an explicit value wins');
  assert.equal(tutorialProgress({ step: 'stance' }), null, 'unknown → no bar');
});

test('hud: get-up hint for a downed human', () => {
  assert.equal(getUpHint('camera'), 'Pump your arms!');
  assert.match(getUpHint('keyboard'), /punch keys/);
  assert.equal(getUpHint('camera', { versus: true, name: 'Ana' }), 'Ana: pump your arms!');
});

test('hud: training popups stack in slots — the same text restarts in place, never overlapping', () => {
  const s = new PopupStack({ slots: 3 });
  const a = s.add({ text: '+50', kind: 'hit' }, 0);
  const b = s.add({ text: 'BLOCKED', kind: 'miss' }, 100);
  assert.notEqual(a.slot, b.slot, 'two texts at once take different slots');
  const a2 = s.add({ text: '+50', kind: 'hit' }, 200);
  assert.equal(a2.slot, a.slot, 'the same text reuses its slot…');
  assert.equal(a2.replaces, a.id, '…replacing the old popup');
  assert.equal(a2.n, 2, '…and counts it (×2)');
  const c = s.add({ text: 'OUCH!', kind: 'bad', lane: 'self' }, 250);
  assert.equal(c.slot, 0, 'lanes are independent');
  const d = s.add({ text: '+120 BAG DOWN!', kind: 'counter', big: true }, 300);
  const slots = new Set(s.items.filter((i) => i.lane === 'opp').map((i) => i.slot));
  assert.equal(slots.size, s.items.filter((i) => i.lane === 'opp').length, 'one popup per slot');
  const e = s.add({ text: 'MISS', kind: 'miss' }, 350);
  assert.notEqual(e.evicts, null, 'a full lane recycles its oldest slot');
  assert(e.slot >= 0 && e.slot < 3);
  assert.equal(d.replaces, null);
  s.prune(10000);
  assert.equal(s.items.length, 0, 'expired popups free their slots');
  assert.equal(s.add({ text: 'x' }, 10000).slot, 0);
});
