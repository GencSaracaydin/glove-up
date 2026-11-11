// Audio: event → sound mapping (pure). What each bus event sounds like, relative to the local player.
import { test, assert, approx } from '../harness.mjs';
import { Ev } from '../../src/core/types.js';
import {
  cuesForEvent, trainEventCues, punchPan, roundLine, resultLine, resultJingle, numberWord, speechText,
  medalJingle, AUDIO_TUNING, SOUND_NAMES, TRAIN_EVENT_RULES,
} from '../../src/audio/audio.js';
import { SFX } from '../../src/audio/synth.js';
import { isStinger, isLoop } from '../../src/audio/music.js';
import { flatCues } from './audio-fakes.mjs';

// cue groups ('once' / 'fallback' / 'later') are expanded so the checks see every sound inside them
const of = (cues, type) => flatCues(cues).filter((c) => c.type === type);
const sfx = (cues, name) => flatCues(cues).filter((c) => c.type === 'sfx' && c.name === name);
const has = (cues, pred) => flatCues(cues).some(pred);

test('audio cues: a landed head punch is a "hit" with the punch power, panned by hand', () => {
  const c = cuesForEvent(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'right', kind: 'straight', target: 'head', power: 0.5, counter: false }, { local: 'p1' });
  const [h] = sfx(c, 'hit');
  assert(h, 'hit sound');
  approx(h.opts.power, 0.5, 1e-9);
  assert.equal(h.opts.target, 'head');
  assert.equal(h.opts.counter, false);
  assert.equal(h.opts.perspective, 'dealt');
  assert(h.opts.pan > 0, 'my right hand lands right of centre');
  assert(!has(c, (x) => x.type === 'react'), 'an ordinary hit does not make the crowd react');
  assert(of(c, 'excite')[0].add > 0);
});

test('audio cues: counters are bigger and make the crowd "ooh"; body shots are tagged body', () => {
  const c = cuesForEvent(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', kind: 'hook', target: 'body', power: 0.7, counter: true }, { local: 'p1' });
  const [h] = sfx(c, 'hit');
  assert.equal(h.opts.counter, true);
  assert.equal(h.opts.target, 'body');
  assert(has(c, (x) => x.type === 'react' && x.kind === 'ooh'));
  const plain = cuesForEvent(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', kind: 'hook', target: 'body', power: 0.7 }, { local: 'p1' });
  assert(of(c, 'excite')[0].add > of(plain, 'excite')[0].add, 'counters excite the crowd more');
});

test('audio cues: being hit uses the heavier "taken" perspective; the knockdown blow gasps', () => {
  const c = cuesForEvent(Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'straight', target: 'head', power: 0.4, knockdown: true }, { local: 'p1' });
  const [h] = sfx(c, 'hit');
  assert.equal(h.opts.perspective, 'taken');
  assert(h.opts.power >= 0.9, 'the blow that drops someone is played at full weight');
  assert(h.opts.pan < 0, "the opponent's right hand lands on my left");
  assert(has(c, (x) => x.type === 'react' && x.kind === 'gasp'));
  assert(has(c, (x) => x.type === 'lastHit' && x.id === 'p1' && x.target === 'head'));
});

test('audio cues: blocks, dodges and misses sound different from hits (UI03)', () => {
  const st = { local: 'p1' };
  const b = cuesForEvent(Ev.MATCH_BLOCK, { attacker: 'p2', defender: 'p1', hand: 'left', kind: 'straight', target: 'head', chip: 1 }, st);
  const d = cuesForEvent(Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'left', kind: 'straight' }, st);
  const m = cuesForEvent(Ev.MATCH_MISS, { attacker: 'p1', hand: 'right', kind: 'straight' }, st);
  assert(sfx(b, 'block').length === 1 && !sfx(b, 'hit').length);
  assert(sfx(d, 'dodge').length === 1);
  assert(sfx(d, 'counter-ready').length === 1, 'my dodge opens a counter window: soft cue');
  assert(sfx(m, 'whoosh').length === 1);
  const theirDodge = cuesForEvent(Ev.MATCH_DODGE, { attacker: 'p1', defender: 'p2', hand: 'left', kind: 'straight' }, st);
  assert(!sfx(theirDodge, 'counter-ready').length, 'no counter cue when the opponent dodges');
});

test('audio cues: bells — two rings to start (+ "Fight!" when no call exists), three at 0:00, five final; no crowd stacking after a KO', () => {
  const s = cuesForEvent(Ev.MATCH_BELL, { kind: 'start' }, {});
  assert.equal(sfx(s, 'bell')[0].opts.rings, 2);
  approx(sfx(s, 'bell')[0].delay, AUDIO_TUNING.fightBellDelay, 1e-9, 'the bell follows the call');
  assert.equal(of(s, 'say')[0].text, 'Fight!', 'no MATCH_CALL seen yet: the bell voices "Fight!" itself');
  assert(has(s, (x) => x.type === 'phase' && x.phase === 'fighting'));
  const withCalls = cuesForEvent(Ev.MATCH_BELL, { kind: 'start' }, { calls: true });
  assert.equal(sfx(withCalls, 'bell').length, 1, 'still rings (once — shared with the call)');
  assert.equal(of(withCalls, 'say').length, 0, 'the "Fight!" call owns the voice');
  assert(has(withCalls, (x) => x.type === 'once' && x.key === 'bell:start'));
  const e = cuesForEvent(Ev.MATCH_BELL, { kind: 'end' }, {});
  assert.equal(sfx(e, 'bell')[0].opts.rings, 3);
  assert(has(e, (x) => x.type === 'once' && x.key === 'bell:end'));
  assert(!has(e, (x) => x.type === 'stinger'), 'the break is bell → banner tone → round call (no extra jingle)');
  const eSting = cuesForEvent(Ev.MATCH_BELL, { kind: 'end' }, { T: { ...AUDIO_TUNING, betweenSting: true } });
  assert(has(eSting, (x) => x.type === 'stinger' && x.name === 'between-rounds'), 'the old jingle is one tunable away');
  const fKo = cuesForEvent(Ev.MATCH_BELL, { kind: 'final' }, { phase: 'ko' });
  assert.equal(sfx(fKo, 'bell')[0].opts.rings, 5);
  assert(!has(fKo, (x) => x.type === 'react'));
  const fDec = cuesForEvent(Ev.MATCH_BELL, { kind: 'final' }, { phase: 'fighting' });
  assert(has(fDec, (x) => x.type === 'react' && x.kind === 'cheer'));
});

test('audio cues: the announcer counts "One" … "Ten" with a tick, interrupting the previous number; the crowd roars 1.8 s after "Ten"', () => {
  for (let n = 1; n <= 10; n++) {
    const c = cuesForEvent(Ev.MATCH_COUNT, { downed: 'p2', n }, {});
    assert.equal(sfx(c, 'count-tick').length, 1);
    const [say] = of(c, 'say');
    assert.equal(say.text, `${numberWord(n)}!`);
    assert.equal(say.opts.interrupt, true);
    assert.equal(say.opts.kind, 'count');
    const roar = of(c, 'react').find((x) => x.kind === 'roar');
    if (n < 10) assert(!roar, `no roar at ${n}`);
    else approx(roar.delay, AUDIO_TUNING.koRoarAfterTen, 1e-9, 'the KO roar follows "Ten"');
  }
  assert(has(cuesForEvent(Ev.MATCH_COUNT, { n: 1 }, {}), (x) => x.type === 'cancel' && x.key === 'down'), 'a late "Down!" never talks over the count');
  assert.equal(numberWord(10), 'Ten');
  assert.deepEqual(cuesForEvent(Ev.MATCH_COUNT, { n: 0 }, {}), []);
});

test('audio cues: knockdown → roar + canvas thud timed to the fall (body shots fall sooner); "Down!" only waits when no calls exist', () => {
  const head = cuesForEvent(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1 }, { lastHitTarget: { p2: 'head' } });
  const body = cuesForEvent(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1 }, { lastHitTarget: { p2: 'body' } });
  approx(sfx(head, 'thud')[0].delay, AUDIO_TUNING.knockdownThudSec.head, 1e-9);
  approx(sfx(body, 'thud')[0].delay, AUDIO_TUNING.knockdownThudSec.body, 1e-9);
  assert(has(head, (x) => x.type === 'react' && x.kind === 'roar'));
  assert(has(head, (x) => x.type === 'phase' && x.phase === 'knockdown'));
  assert(has(head, (x) => x.type === 'kd' && x.id === 'p2' && x.count === 1));
  const fb = head.find((x) => x.type === 'fallback' && x.key === 'down');
  approx(fb.delay, AUDIO_TUNING.calls.downFallbackSec, 1e-9, 'measured blow → "Down" gap');
  assert.equal(of(fb.cues, 'say')[0].text, 'Down!');
  const withCalls = cuesForEvent(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1 }, { calls: true });
  assert.equal(of(withCalls, 'say').length, 0, 'the "down" call owns the voice');
});

test('audio cues: KO → the KO moment (slam heavier than any punch, "Knockout!", KO stinger) at the measured "10" → "KO" gap, or when its call is late', () => {
  const K = AUDIO_TUNING.calls;
  const ko = cuesForEvent(Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' }, {});
  const moment = ko.find((x) => x.type === 'fallback' && x.key === 'ko');
  approx(moment.delay, K.koFallbackSec, 1e-9);
  assert.equal(sfx(moment.cues, 'ko-slam').length, 1);
  assert.equal(of(moment.cues, 'say')[0].text, 'Knockout!');
  assert(has(moment.cues, (x) => x.type === 'stinger' && x.name === 'ko'));
  const roar = ko.find((x) => x.type === 'fallback' && x.key === 'roar:ko');
  assert(roar && of(roar.cues, 'react')[0].kind === 'roar', 'a KO without a ten-count still roars');
  const late = cuesForEvent(Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' }, { calls: true });
  approx(late.find((x) => x.key === 'ko').delay, K.koCallWaitSec, 1e-9, 'calls exist: wait for the "ko" call');
  const tko = cuesForEvent(Ev.MATCH_KO, { winner: 'p2', loser: 'p1', method: 'TKO' }, {});
  assert.equal(of(tko, 'say')[0].text, 'Technical knockout!');
});

test('audio cues: decision drum roll, then one result jingle relative to the local player (MAT04)', () => {
  const d = cuesForEvent(Ev.MATCH_DECISION, { scorecards: [] }, {});
  assert(has(d, (x) => x.type === 'roll' && x.on === true));
  const jingleOf = (r, st) => of(cuesForEvent(Ev.MATCH_RESULT, r, st), 'stinger').map((x) => x.name);
  assert.deepEqual(jingleOf({ winner: 'p1', method: 'decision', mode: 'single' }, { local: 'p1' }), ['victory']);
  assert.deepEqual(jingleOf({ winner: 'p2', method: 'KO', mode: 'single' }, { local: 'p1' }), ['defeat']);
  assert.deepEqual(jingleOf({ winner: 'p2', method: 'KO', mode: 'single' }, { local: 'p2' }), ['victory']);
  assert.deepEqual(jingleOf({ winner: null, method: 'draw', mode: 'single' }, { local: 'p1' }), ['draw']);
  assert.deepEqual(jingleOf({ winner: 'p2', method: 'decision', mode: 'versus' }, { local: 'p1' }), ['victory'], 'versus: somebody local won');
  const r = cuesForEvent(Ev.MATCH_RESULT, { winner: 'p1', method: 'decision', mode: 'single', names: { p1: 'Sunny Day' } }, { local: 'p1', rollActive: true });
  assert(has(r, (x) => x.type === 'roll' && x.on === false), 'the roll ends with the reveal');
  assert.equal(of(r, 'say')[0].text, 'The winner, by decision: Sunny Day!');
  assert.equal(resultJingle(null), null);
});

test('audio cues: AI wind-up tells — grunt early, glint in sync with the visual glint; none for my own punches', () => {
  const tell = { grunt: true, glint: true };
  const c = cuesForEvent(Ev.MATCH_WINDUP, { attacker: 'p2', hand: 'left', kind: 'hook', target: 'head', windupMs: 600, tell }, { local: 'p1' });
  approx(sfx(c, 'grunt')[0].delay, 0.6 * AUDIO_TUNING.gruntAt, 1e-9);
  approx(sfx(c, 'glint')[0].delay, 0.6 * AUDIO_TUNING.glintAt, 1e-9);
  assert(sfx(c, 'glint')[0].opts.pan > 0, "the opponent's left glove is on my right");
  const quiet = cuesForEvent(Ev.MATCH_WINDUP, { attacker: 'p2', hand: 'left', windupMs: 300, tell: { grunt: false, glint: false } }, { local: 'p1' });
  assert.deepEqual(quiet, []);
  assert.deepEqual(cuesForEvent(Ev.MATCH_WINDUP, { attacker: 'p1', hand: 'left', windupMs: 300, tell }, { local: 'p1' }), []);
});

test('audio cues: only the local player\'s thrown punches swish (instant feedback)', () => {
  assert(sfx(cuesForEvent(Ev.MATCH_PUNCH_THROWN, { attacker: 'p1', hand: 'left', kind: 'straight' }, { local: 'p1' }), 'swish').length === 1);
  assert.deepEqual(cuesForEvent(Ev.MATCH_PUNCH_THROWN, { attacker: 'p2', hand: 'left', kind: 'straight' }, { local: 'p1' }), []);
  assert(sfx(cuesForEvent(Ev.MATCH_PUNCH_THROWN, { attacker: 'p2', hand: 'left' }, { mode: 'versus' }), 'swish').length === 1, 'both players are local in versus');
});

test('audio cues: intro starts the crowd and stops menu music; the round start only calls the round when no call exists', () => {
  const c = cuesForEvent(Ev.MATCH_INTRO, { p1Name: 'Ana', p2Name: 'Big Barry', mode: 'single' }, {});
  assert(has(c, (x) => x.type === 'crowd' && x.on === true));
  assert(has(c, (x) => x.type === 'music' && x.name === null));
  assert(has(c, (x) => x.type === 'activity' && x.value === 'match'));
  assert.equal(of(c, 'say').length, 0, 'VS card → arena → the round call: no extra intro line by default');
  const named = cuesForEvent(Ev.MATCH_INTRO, { p1Name: 'Ana', p2Name: 'Big Barry' }, { T: { ...AUDIO_TUNING, introLine: true } });
  assert.equal(of(named, 'say')[0].text, 'Ana versus Big Barry!', 'the intro line is one tunable away');
  const rs = cuesForEvent(Ev.MATCH_ROUND_START, { round: 3, maxRounds: 3 }, {});
  const fb = rs.find((x) => x.type === 'fallback');
  assert.equal(fb.key, 'round:3');
  approx(fb.delay, AUDIO_TUNING.calls.roundFallbackSec, 1e-9);
  assert.equal(of(rs, 'say')[0].text, 'Final round!');
  assert.equal(sfx(rs, 'round-tone')[0].opts.final, true);
  assert(has(rs, (x) => x.type === 'round' && x.round === 3 && x.maxRounds === 3));
  assert.equal(of(cuesForEvent(Ev.MATCH_ROUND_START, { round: 2, maxRounds: 3 }, { calls: true }), 'say').length, 0, 'calls exist: the round call owns it');
  assert.equal(roundLine(1, 3), 'Round one!');
  assert.equal(roundLine(2, 3), 'Round two!');
});

test('audio cues: training — groove during READY, whistle on "go" and "time-up", medal jingle at the end', () => {
  const s = cuesForEvent(Ev.TRAIN_START, { kind: 'bag' }, {});
  assert(has(s, (x) => x.type === 'music' && x.name === 'training'));
  assert(!sfx(s, 'whistle').length, 'no whistle while the READY countdown runs');
  assert(has(s, (x) => x.type === 'crowd' && x.on === false));
  assert(has(s, (x) => x.type === 'flag' && x.name === 'trainTimeUp' && x.value === false));
  const go = cuesForEvent(Ev.TRAIN_EVENT, { kind: 'bag', type: 'go' }, {});
  assert.equal(sfx(go, 'whistle')[0].opts.pattern, 'start');
  const up = cuesForEvent(Ev.TRAIN_EVENT, { kind: 'bag', type: 'time-up' }, {});
  assert.equal(sfx(up, 'whistle')[0].opts.pattern, 'end');
  assert(has(up, (x) => x.type === 'flag' && x.name === 'trainTimeUp' && x.value === true));
  const e = cuesForEvent(Ev.TRAIN_END, { kind: 'bag', score: 120, medal: 'gold' }, { trainTimeUp: true });
  assert(!sfx(e, 'whistle').length, 'the time-up whistle already blew');
  assert(has(e, (x) => x.type === 'stinger' && x.name === 'medal-gold' && x.delay > 0));
  assert(has(e, (x) => x.type === 'music' && x.name === null));
  const early = cuesForEvent(Ev.TRAIN_END, { kind: 'bag', medal: 'none' }, { trainTimeUp: false });
  assert.equal(sfx(early, 'whistle')[0].opts.pattern, 'end', 'ended early: whistle now');
  assert.equal(medalJingle('none'), 'medal-none');
  assert.equal(medalJingle('platinum'), 'medal-platinum');
});

test('audio cues: training score sounds by reason — quiet for ordinary bag hits, chime for points, bwomp for penalties', () => {
  const snd = (reason, delta) => cuesForEvent(Ev.TRAIN_SCORE, { kind: 'x', delta, total: 10, reason }, {}).map((c) => c.name);
  assert.deepEqual(snd('dodge', 1), ['score-up']);
  assert.deepEqual(snd('mitt-hit', 120), ['score-up']);
  assert.deepEqual(snd('mitt-double', 200), ['combo']);
  assert.deepEqual(snd('bag-complete', 100), ['combo']);
  assert.deepEqual(snd('bag-hit', 12), [], 'the bag thump already says it');
  assert.deepEqual(snd('something-new', 5), ['score-up']);
  assert.deepEqual(snd('ball-hit', -1), ['score-down']);
  assert.deepEqual(snd('trainer-hit', -50), ['score-down']);
  assert.deepEqual(snd('dodge', 0), []);
});

test('audio cues: the training module\'s event types map to the right props', () => {
  const names = (type, extra) => trainEventCues({ kind: 'x', type, ...extra }).filter((c) => c.type === 'sfx').map((c) => c.name);
  // exactly what src/training emits
  assert.deepEqual(names('go'), ['whistle']);
  assert.deepEqual(names('time-up'), ['whistle']);
  assert.deepEqual(names('bag-new'), ['chain-rattle']);
  assert.deepEqual(names('bag-hit', { power: 0.8, meet: true }), ['bag-thump']);
  assert.deepEqual(names('bag-miss'), ['whoosh'], 'a whiff never thumps');
  assert.deepEqual(names('bag-break'), ['chain-snap', 'bag-fall']);
  assert.deepEqual(names('ball-throw', { arriveInMs: 900 }), ['ball-throw']);
  assert.equal(trainEventCues({ type: 'ball-throw', arriveInMs: 900, pos: [-0.5, 1.6, -2] })[0].opts.dur, 0.9, 'the whoosh lasts the flight');
  assert(trainEventCues({ type: 'ball-throw', pos: [-0.5, 1.6, -2] })[0].opts.pan < 0, 'thrown from my left');
  assert.deepEqual(names('ball-dodge'), ['dodge-swish']);
  assert.deepEqual(names('ball-hit'), ['ball-hit']);
  assert.deepEqual(names('target-up', { side: 'left' }), ['mitt-up']);
  assert(trainEventCues({ type: 'target-up', side: 'right' })[0].opts.pan > 0);
  assert.deepEqual(names('target-expire'), [], 'an expired mitt is silent');
  assert.deepEqual(names('mitt-absorb'), ['block']);
  assert.deepEqual(names('glove-miss'), ['whoosh']);
  assert.deepEqual(names('mitt-hit', { side: 'left', power: 0.6 }), ['mitt-smack']);
  assert.deepEqual(names('trainer-hit'), ['mitt-smack', 'trainer-oof']);
  // tolerant of close variants
  assert.deepEqual(names('bag-hit'), ['bag-thump']);
  assert.deepEqual(names('bag-break'), ['chain-snap', 'bag-fall']);
  assert.deepEqual(names('chain-snap'), ['chain-snap', 'bag-fall']);
  assert.deepEqual(names('bag-new'), ['chain-rattle']);
  assert.deepEqual(names('ball-throw'), ['ball-throw']);
  assert.deepEqual(names('ball-hit'), ['ball-hit']);
  assert.deepEqual(names('ball-dodge'), ['dodge-swish']);
  assert.deepEqual(names('ball-miss'), ['dodge-swish'], 'a ball that misses you is a dodge');
  assert.deepEqual(names('mitt-hit'), ['mitt-smack']);
  assert.deepEqual(names('mitts-up'), ['mitt-up']);
  assert.deepEqual(names('mitt-miss'), ['whoosh']);
  assert.deepEqual(names('trainer-hit'), ['mitt-smack', 'trainer-oof']);
  assert.deepEqual(names('double-hit'), ['mitt-smack', 'mitt-smack', 'combo']);
  assert.deepEqual(names('combo'), ['combo']);
  assert.deepEqual(names('hit', { kind: 'bag' }), ['bag-thump']);
  assert.deepEqual(names('something-else'), []);
  assert.deepEqual(trainEventCues({}), []);
  const [chain, fall] = trainEventCues({ type: 'bag-break' });
  assert(fall.delay > chain.delay, 'the bag falls after the chain snaps');
  assert(TRAIN_EVENT_RULES.length > 10);
});

test('audio cues: app events — pause ducking, screens, volumes, tracking alerts only during play', () => {
  assert.deepEqual(cuesForEvent(Ev.APP_PAUSE, { reason: 'user' }, {}), [{ type: 'pause', on: true }]);
  assert.deepEqual(cuesForEvent(Ev.APP_RESUME, {}, {}), [{ type: 'pause', on: false }]);
  assert.deepEqual(cuesForEvent(Ev.APP_SCREEN, { screen: 'mode' }, {}), [{ type: 'screen', screen: 'mode' }]);
  assert.deepEqual(cuesForEvent(Ev.SETTINGS_CHANGED, { settings: { volumes: { music: 0.2 } } }, {}), [{ type: 'volume', volumes: { music: 0.2 } }]);
  assert.deepEqual(cuesForEvent(Ev.SETTINGS_CHANGED, { settings: {} }, {}), []);
  assert.deepEqual(cuesForEvent(Ev.INPUT_TRACKING_LOST, { player: 0 }, { activity: null }), []);
  assert.equal(sfx(cuesForEvent(Ev.INPUT_TRACKING_LOST, { player: 0 }, { activity: 'match' }), 'ui-alert').length, 1);
  assert.deepEqual(cuesForEvent('nope:event', {}, {}), []);
  assert.deepEqual(cuesForEvent(Ev.MATCH_HIT, null, {}).filter((c) => c.type === 'sfx').length, 1, 'a missing payload still maps safely');
});

test('audio cues: every sound a cue or the UI asks for exists', () => {
  const events = [
    [Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' }], [Ev.MATCH_ROUND_START, { round: 1 }], [Ev.MATCH_BELL, { kind: 'start' }],
    [Ev.MATCH_BELL, { kind: 'end' }], [Ev.MATCH_BELL, { kind: 'final' }], [Ev.MATCH_PUNCH_THROWN, { attacker: 'p1', hand: 'left' }],
    [Ev.MATCH_WINDUP, { attacker: 'p2', hand: 'left', windupMs: 400, tell: { grunt: true, glint: true } }],
    [Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', counter: true }], [Ev.MATCH_HIT, { attacker: 'p2', defender: 'p1', heavy: true, knockdown: true }],
    [Ev.MATCH_BLOCK, {}], [Ev.MATCH_DODGE, { defender: 'p1' }], [Ev.MATCH_SLOWMO, { kind: 'dodge', dodger: 'p1', attacker: 'p2', scale: 0.25, durationMs: 750 }],
    [Ev.MATCH_MISS, {}], [Ev.MATCH_DAZED, {}], [Ev.MATCH_KNOCKDOWN, { downed: 'p2' }], [Ev.MATCH_COUNT, { n: 4 }], [Ev.MATCH_COUNT, { n: 10 }],
    [Ev.MATCH_GETUP, { downed: 'p1' }], [Ev.MATCH_KO, { method: 'KO' }], [Ev.MATCH_DECISION, {}],
    [Ev.MATCH_RESULT, { winner: 'p1', method: 'decision' }], [Ev.TRAIN_START, {}], [Ev.TRAIN_END, { medal: 'silver' }],
    [Ev.TRAIN_SCORE, { delta: 1 }], [Ev.TRAIN_SCORE, { delta: -1 }], [Ev.INPUT_TRACKING_LOST, {}],
    ...['round', 'final-round', 'fight', 'down', 'ko', 'time', 'decision'].map((call) => [Ev.MATCH_CALL, { call, round: 2 }]),
    [Ev.RENDER_CUT, { kind: 'player-hit', viewer: 'p1', durationMs: 350 }], [Ev.RENDER_CUT, { kind: 'player-hit-heavy', viewer: 'p1', durationMs: 650 }],
    ...['start', 'wipe', 'replay', 'flash', 'banner', 'winner', 'end'].map((stage) => [Ev.RENDER_OUTRO, { stage, winner: 'p1', method: 'KO' }]),
  ];
  for (const [ev, p] of events) {
    for (const c of flatCues(cuesForEvent(ev, p, { activity: 'match', local: 'p1', maxRounds: 3 }))) {
      if (c.type === 'sfx') assert(SFX[c.name], `${ev}: unknown sfx ${c.name}`);
      if (c.type === 'stinger') assert(isStinger(c.name), `${ev}: unknown stinger ${c.name}`);
      if (c.type === 'react') assert(AUDIO_TUNING.reactGapSec[c.kind] !== undefined, `${ev}: unknown reaction ${c.kind}`);
      if (c.type === 'say') assert(typeof c.text === 'string' && c.text.length > 0);
      if (c.type === 'music' && c.name) assert(isLoop(c.name), `${ev}: unknown loop ${c.name}`);
    }
  }
  for (const [, make] of TRAIN_EVENT_RULES) for (const c of make({})) if (c.type === 'sfx') assert(SFX[c.name], `train rule → unknown sfx ${c.name}`);
  // names the UI module plays through playSfx()
  const ui = ['ui-move', 'ui-confirm', 'ui-back', 'ui-deny', 'ui-ready', 'bell',
    'medal-none', 'medal-bronze', 'medal-silver', 'medal-gold', 'medal-platinum', 'skill-up', 'skill-down', 'pro'];
  for (const n of ui) assert(SOUND_NAMES.includes(n), `UI sound ${n} missing`);
});

test('audio cues: stereo geometry — seen from behind the local boxer; split-screen versus by defender', () => {
  assert(punchPan('p1', 'right', 'straight', { local: 'p1' }) > 0);
  assert(punchPan('p1', 'left', 'straight', { local: 'p1' }) < 0);
  assert(punchPan('p2', 'right', 'straight', { local: 'p1' }) < 0);
  assert(Math.abs(punchPan('p1', 'right', 'hook', { local: 'p1' })) > Math.abs(punchPan('p1', 'right', 'straight', { local: 'p1' })), 'hooks swing wider');
  assert(punchPan('p2', 'left', 'straight', { versus: true }) < 0, 'p2 hits p1 → p1 (left) half');
  assert(punchPan('p1', 'left', 'straight', { versus: true }) > 0, 'p1 hits p2 → p2 (right) half');
});

test('audio cues: speech text is sanitised and result lines are sensible', () => {
  assert.equal(speechText('  <b>Hi</b> {there}! '), 'b Hi b there !');
  assert.equal(speechText(null), '');
  assert(speechText('x'.repeat(500)).length <= 90);
  assert.equal(resultLine({ winner: null, method: 'draw' }), "It's a draw!");
  assert.equal(resultLine({ winner: 'p2', method: 'KO' }), null, 'KOs were already called');
  assert.equal(resultLine({ winner: 'p2', method: 'decision' }, { p2: 'Mo' }), 'The winner, by decision: Mo!');
  assert.equal(resultLine({ winner: 'p2', method: 'decision' }), 'We have a winner, by decision!');
});
