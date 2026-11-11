// Audio: the alignment-pass cue schedule (research/mechanics.md §6 "Audio cue moments",
// ARCHITECTURE.md §6.3–6.5) — announcer calls from Ev.MATCH_CALL with no double voices or bells,
// the knockdown / KO timeline, dodge slow motion, the player-hit camera cut and the bout outro.
// Driven by synthetic bus events through a strict fake AudioContext, fake timers and fake speech.
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { AudioEngine, AUDIO_TUNING, cuesForEvent, callLine, CALL_KINDS } from '../../src/audio/audio.js';
import { STINGERS, stingerLength } from '../../src/audio/music.js';
import { FakeContext, fakeTimers, fakeSpeech, flatCues } from './audio-fakes.mjs';

const T = AUDIO_TUNING, K = T.calls;

/**
 * An engine on a fake context with spies:
 *   sfx    [{name, t, opts}]     every sound actually scheduled (t = its audio-clock start)
 *   said   [{text, at}]          every announcer line asked for (at = when it is due)
 *   reacts [{kind, at}]          crowd reactions scheduled
 *   stings [{name, at}]          jingles scheduled
 */
function rig({ seenCalls = false } = {}) {
  const bus = new EventBus(), ctx = new FakeContext(), timers = fakeTimers(), sp = fakeSpeech({ autoEnd: true });
  const e = new AudioEngine({ context: ctx, timers, rng: 5, speech: sp.speech, bus });
  const sfx = [], said = [], reacts = [], stings = [];
  const sfxAt = e._sfxAt.bind(e);
  e._sfxAt = (name, opts, t) => { const ok = sfxAt(name, opts, t); if (ok) sfx.push({ name, t, opts }); return ok; };
  const cue = e._cue.bind(e);
  e._cue = (c, now) => {
    if (c?.type === 'say') said.push({ text: c.text, at: now + (c.delay || 0) });
    return cue(c, now);
  };
  const react = e.crowdReact.bind(e);
  e.crowdReact = (kind, o = {}) => { const ok = react(kind, o); if (ok) reacts.push({ kind, at: ctx.currentTime + (o.delay || 0) }); return ok; };
  const sting = e.stinger.bind(e);
  e.stinger = (name, o = {}) => { const ok = sting(name, o); if (ok) stings.push({ name, at: ctx.currentTime + (o.delay || 0) }); return ok; };
  if (seenCalls) e._callsSeen = true;
  /** Advance the audio clock to `t` in small steps (the real scheduler pumps every 30 ms). */
  const to = (t, dt = 0.02) => {
    for (let x = ctx.currentTime + dt; x < t; x += dt) { ctx.advance(x); e.pump(0.25); }
    ctx.advance(t); e.pump(0.25);
    timers.flush();
  };
  const emit = (ev, p) => bus.emit(ev, p);
  const count = (arr, pred) => arr.filter(pred).length;
  return { bus, ctx, timers, sp, e, sfx, said, reacts, stings, to, emit, count };
}

const liveNodes = (ctx) => ctx.nodes.filter((n) => !n.disconnected && n.outputs.size > 0).length;

// ───────────────────────────── calls ─────────────────────────────

test('audio calls: our own lines for every call kind; "time" is silent by default (the 0:00 bell speaks)', () => {
  assert.deepEqual([...CALL_KINDS], ['round', 'final-round', 'fight', 'down', 'ko', 'time', 'decision']);
  assert.equal(callLine('round', { round: 2, maxRounds: 3 }), 'Round two!');
  assert.equal(callLine('round', { round: 3, maxRounds: 3 }), 'Final round!');
  assert.equal(callLine('final-round'), 'Final round!');
  assert.equal(callLine('fight'), 'Fight!');
  assert.equal(callLine('down'), 'Down!');
  assert.equal(callLine('ko'), 'Knockout!');
  assert.equal(callLine('time'), null);
  assert.equal(callLine('time', { timeVoice: true }), 'Time!');
  assert.equal(typeof callLine('decision'), 'string');
  assert.equal(callLine('nope'), null);
  for (const call of CALL_KINDS) {
    const cues = flatCues(cuesForEvent(Ev.MATCH_CALL, { call, round: 1 }, { maxRounds: 3 }));
    assert(cues.some((c) => c.type === 'calls'), `${call}: marks calls as present`);
    const official = new RegExp(['ref', 'eree'].join(''), 'i'); // the reference has no ring official: announcer wording only
    for (const c of cues) if (c.type === 'say') assert(!official.test(c.text), 'announcer wording only');
  }
});

test('audio calls: round start — banner tone at the call, the spoken round call 0.4 s later, then "Fight!" + ONE bell 3.5–4 s on', () => {
  const r = rig();
  r.emit(Ev.MATCH_INTRO, { p1Name: 'Ana', p2Name: 'Rocco', mode: 'single' });
  r.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  r.to(0.6);
  r.emit(Ev.MATCH_CALL, { call: 'round', round: 1 });           // banner shows (≈4 s before "Fight!")
  const tone = r.sfx.find((s) => s.name === 'round-tone');
  approx(tone.t, 0.6, 1e-6, 'tone under the banner, at the call');
  const roundSay = r.said.find((s) => s.text === 'Round one!');
  approx(roundSay.at, 0.6 + K.roundVoiceDelay, 1e-6, 'the spoken call follows the tone');
  r.to(1.5);
  assert.equal(r.count(r.said, (s) => s.text === 'Round one!'), 1, 'the round start\'s fallback was cancelled by the call');
  r.to(4.55);
  r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 });           // both arrive in the same tick …
  r.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  r.to(6);
  const fight = r.said.filter((s) => s.text === 'Fight!');
  assert.equal(fight.length, 1, 'one "Fight!"');
  const bells = r.sfx.filter((s) => s.name === 'bell');
  assert.equal(bells.length, 1, 'one bell for the call + MATCH_BELL start');
  assert.equal(bells[0].opts.rings, 2);
  approx(bells[0].t - fight[0].at, T.fightBellDelay, 1e-6, 'the bell follows the call');
  const lead = fight[0].at - roundSay.at;
  assert(lead >= 3.5 && lead <= 4, `round call ${lead.toFixed(2)} s before "Fight!" (measured 3.5–4 s)`);
  assert.deepEqual([...new Set(r.sp.spoken.map((u) => u.text))], ['Round one!', 'Fight!']);
  assert.equal(r.e.state().calls, true);
  r.e.dispose();
});

test('audio calls: MATCH_BELL start before the "fight" call in the same tick still makes one "Fight!" and one bell', () => {
  for (const seenCalls of [false, true]) {
    const r = rig({ seenCalls });
    r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
    r.to(1);
    r.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
    r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 });
    r.to(3);
    assert.equal(r.count(r.said, (s) => s.text === 'Fight!'), 1, `seenCalls=${seenCalls}: one "Fight!"`);
    assert.equal(r.count(r.sfx, (s) => s.name === 'bell'), 1, `seenCalls=${seenCalls}: one bell`);
    r.e.dispose();
  }
});

test('audio calls: a round call that comes during the break (before MATCH_ROUND_START) is not repeated; a late call after a fallback is not either', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  r.to(1);
  r.emit(Ev.MATCH_BELL, { kind: 'end', round: 1 });             // 0:00
  r.to(4.5);
  r.emit(Ev.MATCH_CALL, { call: 'round', round: 2 });            // banner during the break
  r.to(6);
  r.emit(Ev.MATCH_ROUND_START, { round: 2, maxRounds: 3 });
  r.to(9);
  assert.equal(r.count(r.said, (s) => s.text === 'Round two!'), 1);
  assert.equal(r.count(r.sfx, (s) => s.name === 'round-tone'), 1);
  r.emit(Ev.MATCH_CALL, { call: 'final-round', round: 3 });
  r.to(10);
  const final = r.sfx.filter((s) => s.name === 'round-tone').pop();
  assert.equal(final.opts.final, true, 'the final round has its own darker tone');
  assert.equal(r.count(r.said, (s) => s.text === 'Final round!'), 1);
  r.e.dispose();

  // legacy order: the round start voiced its own call (no call within the grace) → a late call is deduplicated
  const l = rig();
  l.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  l.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  l.to(K.roundFallbackSec + 0.1);
  assert.equal(l.count(l.said, (s) => s.text === 'Round one!'), 1, 'fallback voiced it');
  l.emit(Ev.MATCH_CALL, { call: 'round', round: 1 });
  l.to(3);
  assert.equal(l.count(l.said, (s) => s.text === 'Round one!'), 1, 'no double voice');
  assert.equal(l.count(l.sfx, (s) => s.name === 'round-tone'), 1, 'no double tone');
  l.e.dispose();
});

test('audio calls: compressed timings (?fast=1, simulations) never call the round after "Fight!"', () => {
  const r = rig();
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  r.to(0.2);
  r.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  r.to(3);
  assert.deepEqual(r.said.map((s) => s.text), ['Fight!']);
  r.e.dispose();
});

test('audio calls: genuine back-to-back moments (?fast=1: "Fight!" → knockdown → "Fight!" in ≈2.2 s) are all voiced and rung', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.to(0.5);
  r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 }); r.emit(Ev.MATCH_BELL, { kind: 'start', round: 1, restart: false });
  r.to(0.6);
  r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1 });
  r.to(0.8);
  r.emit(Ev.MATCH_CALL, { call: 'down', boxer: 'p2' });
  r.to(2.7);
  r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 }); r.emit(Ev.MATCH_BELL, { kind: 'start', round: 1, restart: true });
  r.to(2.75);
  r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 2 });
  r.to(2.95);
  r.emit(Ev.MATCH_CALL, { call: 'down', boxer: 'p2' });
  r.to(4);
  assert.equal(r.count(r.said, (s) => s.text === 'Fight!'), 2);
  assert.equal(r.count(r.said, (s) => s.text === 'Down!'), 2);
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell'), 2, 'one bell per "Fight!", none doubled');
  r.e.dispose();
});

test('audio calls: knockdown → "Down!", one call per number every 1.08 s, a 4th-knockdown KO blow with the boom, the KO slam + "Knockout!" and a roar 1.8 s after "Ten"', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B', mode: 'single' });
  r.emit(Ev.MATCH_ROUND_START, { round: 2, maxRounds: 3 });
  for (let k = 1; k <= 3; k++) r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: k }); // three earlier knockdowns this bout
  r.emit(Ev.MATCH_GETUP, { downed: 'p2', atCount: 7 });
  r.to(2);
  r.emit(Ev.MATCH_CALL, { call: 'fight' });
  r.to(5);
  r.emit(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'right', kind: 'hook', target: 'head', power: 0.9, knockdown: true, hpBefore: 0.3, hpAfter: 0 });
  r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 4 });
  const blow = r.sfx.filter((s) => s.t >= 5 && s.t < 5.1).map((s) => s.name);
  assert(blow.includes('hit') && blow.includes('ko-boom'), `the 4th knockdown's blow is the KO blow (${blow})`);
  r.to(5.9);
  r.emit(Ev.MATCH_CALL, { call: 'down', boxer: 'p2' });
  const ten = 5.9 + 1.3 + 9 * 1.08;
  for (let n = 1; n <= 10; n++) { r.to(5.9 + 1.3 + (n - 1) * 1.08); r.emit(Ev.MATCH_COUNT, { downed: 'p2', n }); }
  r.emit(Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' });
  r.emit(Ev.MATCH_BELL, { kind: 'final' });
  r.to(ten + 1.3);
  r.emit(Ev.MATCH_CALL, { call: 'ko', winner: 'p1' });
  const slam = r.sfx.find((s) => s.name === 'ko-slam');
  approx(slam.t, ten + 1.3, 1e-6, 'the KO slam lands with the "KO" call');
  r.to(ten + 1.3 + K.koCallWaitSec + 1);
  assert.equal(r.count(r.said, (s) => s.text === 'Down!'), 1);
  const numbers = r.said.filter((s) => /^(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)!$/.test(s.text));
  assert.deepEqual(numbers.map((s) => s.text), ['One!', 'Two!', 'Three!', 'Four!', 'Five!', 'Six!', 'Seven!', 'Eight!', 'Nine!', 'Ten!']);
  for (let i = 1; i < numbers.length; i++) approx(numbers[i].at - numbers[i - 1].at, 1.08, 1e-6, 'one call per number');
  assert.equal(r.count(r.sfx, (s) => s.name === 'count-tick'), 10);
  assert.equal(r.count(r.said, (s) => s.text === 'Knockout!'), 1, 'one "Knockout!" (the MATCH_KO fallback stood down)');
  assert.equal(r.count(r.sfx, (s) => s.name === 'ko-slam'), 1);
  const roars = r.reacts.filter((x) => x.kind === 'roar' && x.at > ten - 0.01);
  assert.equal(roars.length, 1, 'one KO roar');
  approx(roars[0].at - ten, T.koRoarAfterTen, 1e-6, 'the roar ≈1.8 s after "Ten"');
  assert(r.stings.some((s) => s.name === 'ko'), 'KO stinger under the call');
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell' && s.opts.rings === 5), 1, 'the final bell');
  r.e.dispose();
});

test('audio calls: restarts after a knockdown get "Fight!" + the bell; 0:00 gets one bell whichever of "time" / MATCH_BELL comes first', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  r.to(1);
  r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 });
  r.to(5);
  r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p1', count: 1 });
  r.to(9);
  r.emit(Ev.MATCH_GETUP, { downed: 'p1', atCount: 4 });
  r.to(13.6);
  r.emit(Ev.MATCH_CALL, { call: 'fight', round: 1 });           // the restart: no MATCH_BELL at all
  r.to(15);
  assert.equal(r.count(r.said, (s) => s.text === 'Fight!'), 2);
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell' && s.opts.rings === 2), 2, 'a bell on every "Fight!"');
  r.to(40);
  r.emit(Ev.MATCH_CALL, { call: 'time', round: 1 });
  r.emit(Ev.MATCH_BELL, { kind: 'end', round: 1 });
  r.to(42);
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell' && s.opts.rings === 3), 1, 'one 0:00 bell');
  assert(!r.said.some((s) => s.text === 'Time!'), 'the 0:00 call only rings the bell');
  r.emit(Ev.MATCH_ROUND_START, { round: 3, maxRounds: 3 });
  r.to(60);
  r.emit(Ev.MATCH_BELL, { kind: 'final', round: 3 });
  r.emit(Ev.MATCH_CALL, { call: 'time', round: 3 });
  r.to(62);
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell' && s.opts.rings === 5), 1, 'one final bell at the last 0:00');
  r.e.dispose();
});

test('audio calls: the decision call is voiced once next to the drum roll', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.to(1);
  r.emit(Ev.MATCH_CALL, { call: 'decision' });
  r.emit(Ev.MATCH_DECISION, { scorecards: [] });
  r.emit(Ev.MATCH_CALL, { call: 'decision' });
  r.to(2);
  assert.equal(r.count(r.said, (s) => s.text === callLine('decision')), 1);
  assert(r.e._roll, 'drum roll running');
  r.e.dispose();
});

// ───────────────────────────── hits, slow motion, camera cut ─────────────────────────────

test('audio hits: clean hit, counter, block and a heavy hit on the player are four distinct sounds', () => {
  const st = { local: 'p1' };
  const one = (ev, p) => flatCues(cuesForEvent(ev, p, st)).find((c) => c.type === 'sfx');
  const clean = one(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', target: 'head', power: 0.6 });
  const counter = one(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', target: 'head', power: 0.6, counter: true });
  const block = one(Ev.MATCH_BLOCK, { attacker: 'p1', defender: 'p2', hand: 'left', target: 'head', chip: 0 });
  const heavy = one(Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', hand: 'right', target: 'head', power: 0.7, heavy: true, hpBefore: 6, hpAfter: 3 });
  assert.equal(clean.name, 'hit');
  assert(!clean.opts.counter && !clean.opts.heavy);
  assert.equal(counter.opts.counter, true);
  assert.equal(block.name, 'block');
  assert.equal(heavy.opts.heavy, true);
  assert.equal(heavy.opts.perspective, 'taken');
  assert(heavy.opts.power >= 0.8, 'heavy hits play at weight');
  const all = cuesForEvent(Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', heavy: true, hpAfter: 3 }, st);
  assert(all.some((c) => c.type === 'hp' && c.id === 'p1' && Math.abs(c.hp01 - 0.3) < 1e-9), 'hp from wedges');
  assert(all.some((c) => c.type === 'react' && c.kind === 'ooh'), 'the crowd reacts to a big shot on the player');
  assert(all.some((c) => c.type === 'mark' && c.key === 'impact:p1'));
});

test('audio slow motion: a time-slow whoosh, the crowd pitched down and muffled for the window, then real time again', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.emit(Ev.MATCH_CALL, { call: 'fight' });
  r.to(2);
  const bed = r.e.crowd;
  assert(bed, 'crowd running');
  const rateOf = (s) => s.playbackRate.lastTarget / s.__rate;
  r.emit(Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'hook', counterWindowMs: 750 });
  r.emit(Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 });
  const whoosh = r.sfx.find((s) => s.name === 'time-slow');
  assert(whoosh && whoosh.opts.dur <= T.slowmo.whooshMaxSec, 'time-slow whoosh');
  assert.equal(r.e.state().warp, 'dodge');
  for (const s of bed.srcs) approx(rateOf(s), T.slowmo.crowdRate, 1e-9, 'crowd pitched down');
  approx(bed.tone.frequency.lastTarget, T.slowmo.crowdCutoff, 1e-9, 'crowd muffled');
  for (const f of bed.formants) approx(f.frequency.lastTarget / f.__f, T.slowmo.formant, 1e-9);
  r.to(2.5);
  approx(bed.tone.frequency.lastTarget, T.slowmo.crowdCutoff, 1e-9, 'excitement updates never un-muffle the window');
  r.to(2.8);
  assert.equal(r.e.state().warp, null, 'window over');
  for (const s of bed.srcs) approx(rateOf(s), 1, 1e-9, 'crowd back to real time');
  assert(bed.tone.frequency.lastTarget > T.slowmo.crowdCutoff * 1.2, 'and bright again');
  const resume = r.sfx.find((s) => s.name === 'time-resume');
  approx(resume.t - whoosh.t, 0.75, 1e-6, 'the resume swish marks the end of the window');
  r.e.dispose();
});

test('audio camera cut: the player-hit cut adds a muffled thud to the hit — never a second impact, in either event order', () => {
  // MATCH_HIT first (the usual order) …
  const a = rig({ seenCalls: true });
  a.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  a.to(1);
  a.emit(Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', hand: 'left', target: 'head', power: 0.6 });
  a.to(1.04);
  a.emit(Ev.RENDER_CUT, { kind: 'player-hit', viewer: 'p1', durationMs: 350 });
  a.to(2);
  assert.equal(a.count(a.sfx, (s) => s.name === 'hit'), 1, 'one impact');
  const thud = a.sfx.find((s) => s.name === 'cut-thud');
  assert(thud && !thud.opts.heavy);
  approx(thud.t, 1.04 + T.cut.thudDelay, 1e-6);
  a.e.dispose();
  // … RENDER_CUT emitted from inside the renderer's MATCH_HIT handler (reaches '*' listeners first)
  const b = rig({ seenCalls: true });
  b.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  b.to(1);
  b.bus.on(Ev.MATCH_HIT, (p) => { if (p.defender === 'p1') b.bus.emit(Ev.RENDER_CUT, { kind: p.heavy ? 'player-hit-heavy' : 'player-hit', viewer: 'p1', durationMs: p.heavy ? 650 : 350 }); });
  b.emit(Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', hand: 'right', target: 'body', power: 0.8, heavy: true });
  b.to(2);
  assert.equal(b.count(b.sfx, (s) => s.name === 'hit'), 1, 'one impact');
  assert.equal(b.sfx.find((s) => s.name === 'hit').opts.heavy, true, 'the real (heavy) hit, not a stand-in');
  assert.equal(b.sfx.find((s) => s.name === 'cut-thud').opts.heavy, true);
  b.e.dispose();
  // a cut with no hit at all (renderer-only) plays its own impact
  const c = rig({ seenCalls: true });
  c.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  c.to(1);
  c.emit(Ev.RENDER_CUT, { kind: 'player-hit-heavy', viewer: 'p1', durationMs: 650 });
  c.to(1.5);
  const own = c.sfx.find((s) => s.name === 'hit');
  assert(own && own.opts.heavy && own.opts.perspective === 'taken', 'impact + thud');
  assert(c.sfx.some((s) => s.name === 'cut-thud'));
  c.emit(Ev.RENDER_CUT, { kind: 'knockdown-wide', viewer: null });
  c.emit(Ev.RENDER_CUT, { kind: 'player-hit', viewer: 'p2' }); // single player: not my viewport
  c.to(2.5);
  assert.equal(c.count(c.sfx, (s) => s.name === 'cut-thud'), 1);
  c.e.dispose();
});

// ───────────────────────────── outro ─────────────────────────────

function koOutro(r, { winner = 'p1', local = 'p1' } = {}) {
  r.e.setLocalPlayer(local);
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B', mode: 'single' });
  r.emit(Ev.MATCH_CALL, { call: 'fight' });
  r.to(1);
  r.emit(Ev.MATCH_KO, { winner, loser: winner === 'p1' ? 'p2' : 'p1', method: 'KO' });
  r.emit(Ev.MATCH_CALL, { call: 'ko', winner });
  r.to(3);
  r.emit(Ev.MATCH_RESULT, { id: 'b1', winner, method: 'KO', mode: 'single' });
  r.to(3.6);
  r.emit(Ev.RENDER_OUTRO, { stage: 'start', winner, method: 'KO' });
  r.to(3.7);
  r.emit(Ev.RENDER_OUTRO, { stage: 'wipe', winner, method: 'KO' });
  r.to(4.4);
  r.emit(Ev.RENDER_OUTRO, { stage: 'flash', winner, method: 'KO' });
  r.to(4.6);
  r.emit(Ev.RENDER_OUTRO, { stage: 'replay', winner, method: 'KO' });
}

test('audio outro: swoosh on the wipe, slowed ambience + drone under the replay, a flash sting, the win fanfare with crowd, the winner sting, then results music', () => {
  const r = rig({ seenCalls: true });
  const base = liveNodes(r.ctx);
  koOutro(r);
  assert(!r.stings.some((s) => s.name === 'victory'), 'no result jingle before the banner');
  assert(r.sfx.some((s) => s.name === 'outro-wipe') && r.sfx.some((s) => s.name === 'flash-sting'));
  assert(r.sfx.some((s) => s.name === 'time-slow' && s.opts.deep), 'deep time-slow as the replay starts');
  assert.equal(r.e.state().warp, 'replay');
  assert(r.e.state().drone, 'replay drone');
  for (const s of r.e.crowd.srcs) approx(s.playbackRate.lastTarget / s.__rate, T.outro.replayRate, 1e-9, 'slowed crowd');
  const droneSrcs = r.ctx.sources.filter((s) => s.startAt >= 4.6 - 1e-9 && s.stopAt > 30);
  assert(droneSrcs.length >= 4, 'drone sources running');
  r.to(9);
  r.emit(Ev.RENDER_OUTRO, { stage: 'flash', winner: 'p1', method: 'KO' }); // white fade
  assert.equal(r.e.state().warp, null, 'ambience back');
  assert(!r.e.state().drone);
  assert(droneSrcs.every((s) => s.stopAt < 11), 'the drone ends its sources early (nothing runs silently)');
  r.to(10);
  r.emit(Ev.RENDER_OUTRO, { stage: 'banner', winner: 'p1', method: 'KO' });
  const fanfare = r.stings.filter((s) => s.name === 'victory');
  assert.equal(fanfare.length, 1, 'the win fanfare at the banner');
  approx(fanfare[0].at, 10, 1e-6);
  assert(r.reacts.some((x) => x.kind === 'roar' && x.at >= 10 && x.at < 10.5), 'with the crowd');
  r.to(14);
  r.emit(Ev.RENDER_OUTRO, { stage: 'winner', winner: 'p1', method: 'KO' });
  assert(r.stings.some((s) => s.name === 'winner'), 'winner sting');
  r.to(17);
  r.emit(Ev.RENDER_OUTRO, { stage: 'end', winner: 'p1', method: 'KO' });
  assert.equal(r.e.currentMusic, 'results', 'results music');
  assert(!r.e.crowd, 'the crowd fades away under it');
  assert.equal(r.e.state().outro, 'seen');
  r.to(40);
  assert.equal(r.count(r.stings, (s) => s.name === 'victory'), 1, 'the MATCH_RESULT fallback never played a second jingle');
  r.e.music(null);
  r.to(80, 0.5);
  assert(liveNodes(r.ctx) <= base + 2, `every outro node released (${liveNodes(r.ctx)} vs ${base})`);
  r.e.dispose();
});

test('audio outro: when the local player lost — the gentle jingle and the soft winner sting; a skipped outro still plays the jingle once', () => {
  const r = rig({ seenCalls: true });
  koOutro(r, { winner: 'p2', local: 'p1' });
  r.to(8);
  r.emit(Ev.RENDER_OUTRO, { stage: 'banner', winner: 'p2', method: 'KO' });
  r.to(12);
  r.emit(Ev.RENDER_OUTRO, { stage: 'winner', winner: 'p2', method: 'KO' });
  r.to(14);
  assert.deepEqual(r.stings.filter((s) => s.name !== 'ko').map((s) => s.name), ['defeat', 'winner-soft']);
  r.e.dispose();

  const s = rig({ seenCalls: true });
  s.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  s.to(1);
  s.emit(Ev.MATCH_RESULT, { id: 'b2', winner: 'p1', method: 'decision', mode: 'single' });
  s.to(1.5);
  s.emit(Ev.RENDER_OUTRO, { stage: 'start', winner: 'p1', method: 'decision' });
  s.to(2);
  s.emit(Ev.RENDER_OUTRO, { stage: 'end', winner: 'p1', method: 'decision' }); // skipOutro(): straight to the end
  s.to(20);
  assert.equal(s.count(s.stings, (x) => x.name === 'victory'), 1);
  assert.equal(s.e.currentMusic, 'results');
  s.e.dispose();
});

test('audio outro: no outro at all — the result jingle plays by itself after the wait, then the results music', () => {
  const r = rig({ seenCalls: true });
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.to(1);
  r.emit(Ev.MATCH_RESULT, { id: 'b3', winner: 'p1', method: 'KO', mode: 'single' });
  r.to(1 + T.outro.waitSec - 0.1);
  assert(!r.stings.some((s) => s.name === 'victory'), 'waits for an outro first');
  r.to(1 + T.outro.waitSec + 0.1);
  assert(r.stings.some((s) => s.name === 'victory'));
  r.to(1 + T.outro.waitSec + stingerLength(STINGERS.victory) + T.resultsAfterJingle + 0.2);
  assert.equal(r.e.currentMusic, 'results');
  r.e.dispose();
});

test('audio outro: pausing drops a waiting call; quitting to a menu mid-outro clears the slowed ambience, the drone and every waiting cue', () => {
  const r = rig();
  r.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  r.to(1);
  r.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p1', count: 1 }); // legacy: "Down!" would follow in 0.9 s …
  r.emit(Ev.APP_PAUSE, { reason: 'user' });
  r.to(3);
  assert(!r.said.some((s) => s.text === 'Down!'), '… but never over the pause screen');
  r.emit(Ev.APP_RESUME, {});
  koOutro(r);
  assert(r.e.state().drone && r.e.state().warp === 'replay');
  r.emit(Ev.APP_SCREEN, { screen: 'mode' });
  assert(!r.e.state().drone && r.e.state().warp === null && r.e.state().pendingCues === 0);
  r.to(20);
  assert(!r.stings.some((s) => s.name === 'victory'), 'no jingle on the menu');
  assert.equal(r.e.currentMusic, 'menu');
  r.e.dispose();
});

test('audio calls: a whole bout as the new match emits it — every announcer line exactly once, in order', () => {
  const r = rig();
  const ev = [];
  const at = (t, name, p) => ev.push([t, name, p]);
  at(0, Ev.MATCH_INTRO, { p1Name: 'Sunny', p2Name: 'Rocco', mode: 'single' });
  at(1.0, Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  at(1.2, Ev.MATCH_CALL, { call: 'round', round: 1 });
  at(5.2, Ev.MATCH_CALL, { call: 'fight', round: 1 });
  at(5.2, Ev.MATCH_BELL, { kind: 'start', round: 1 });
  at(8.0, Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', target: 'head', power: 0.5, hpAfter: 8.8 });
  at(9.0, Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'hook', counterWindowMs: 750 });
  at(9.0, Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 });
  at(9.4, Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'right', target: 'head', power: 0.9, counter: true, heavy: true, hpAfter: 5.5 });
  at(11.0, Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', hand: 'left', target: 'body', power: 0.8, heavy: true, hpAfter: 6.8 });
  at(11.03, Ev.RENDER_CUT, { kind: 'player-hit-heavy', viewer: 'p1', durationMs: 650 });
  at(14.0, Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', target: 'head', power: 1, knockdown: true, hpAfter: 0 });
  at(14.0, Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1, roundCount: 1, by: 'p1', round: 1 });
  at(14.9, Ev.MATCH_CALL, { call: 'down', boxer: 'p2' });
  for (let n = 1; n <= 5; n++) at(16.2 + (n - 1) * 1.08, Ev.MATCH_COUNT, { downed: 'p2', n });
  at(20.9, Ev.MATCH_GETUP, { downed: 'p2', atCount: 5 });
  at(25.5, Ev.MATCH_CALL, { call: 'fight', round: 1 });
  at(70.0, Ev.MATCH_CALL, { call: 'time', round: 1 });
  at(70.0, Ev.MATCH_BELL, { kind: 'end', round: 1 });
  at(73.5, Ev.MATCH_CALL, { call: 'round', round: 2 });
  at(75.0, Ev.MATCH_ROUND_START, { round: 2, maxRounds: 3 });
  at(77.5, Ev.MATCH_CALL, { call: 'fight', round: 2 });
  at(77.5, Ev.MATCH_BELL, { kind: 'start', round: 2 });
  for (const [t, name, p] of ev) { r.to(t); r.emit(name, p); }
  r.to(80);
  const lines = r.said.map((s) => s.text);
  assert.deepEqual(lines, ['Round one!', 'Fight!', 'Down!', 'One!', 'Two!', 'Three!', 'Four!', 'Five!', 'Fight!', 'Round two!', 'Fight!']);
  assert.equal(r.count(r.sfx, (s) => s.name === 'bell'), 4, 'start, restart, 0:00, start');
  assert.equal(r.count(r.sfx, (s) => s.name === 'round-tone'), 2);
  assert.equal(r.count(r.sfx, (s) => s.name === 'time-slow'), 1);
  assert.equal(r.count(r.sfx, (s) => s.name === 'cut-thud'), 1);
  assert.equal(r.count(r.sfx, (s) => s.name === 'hit'), 4, 'four landed punches, no stand-in impact for the cut');
  r.e.dispose();
});
