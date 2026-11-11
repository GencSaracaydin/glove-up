// Audio: engine + synthesis graphs against a strict fake AudioContext.
// The fake throws where browsers throw (non-finite automation values, exponential ramps to 0,
// starting a source twice, connecting to a non-node) and records connections, so the tests check
// that every recipe builds a valid graph, schedules nothing NaN, and disconnects every node of a
// finished one-shot (performance rule: short-lived nodes are cleaned up).
import { test, assert, approx } from '../harness.mjs';
import { EventBus } from '../../src/core/events.js';
import { Ev } from '../../src/core/types.js';
import { AudioEngine, AUDIO_TUNING, SOUND_NAMES, trainEventCues } from '../../src/audio/audio.js';
import {
  SFX, SFX_NAMES, INSTR, crowdReaction, drumRoll, getResources, mulberry32, makeSoftClipCurve, measure,
  volumeToGain, fillNoise, fillApplause, Voice, perc, adsr, EPS,
} from '../../src/audio/synth.js';
import { MusicPlayer, SONGS, STINGERS, eventsInWindow, MUSIC_TUNING, stingerLength } from '../../src/audio/music.js';
import { Match } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { Rng } from '../../src/core/rng.js';
import { makeBot, SIM_RULES } from '../../dev/sim.mjs';
import { createActivity } from '../../src/training/session.js';
import { FakeContext, fakeTimers, fakeSpeech } from './audio-fakes.mjs';

// The strict fake WebAudio, fake timers and fake speech live in ./audio-fakes.mjs.

const newCtxNodes = (ctx, from) => ctx.nodes.slice(from);
const engineWith = (o = {}) => {
  const ctx = o.ctx || new FakeContext();
  const timers = o.timers || fakeTimers();
  const e = new AudioEngine({ context: ctx, timers, rng: 3, speech: o.speech ?? null, ...o.extra });
  return { e, ctx, timers };
};

// ───────────────────────────── recipes ─────────────────────────────

test('audio engine: every SFX recipe builds a valid graph and disconnects itself when done', () => {
  const variants = {
    hit: [{}, { counter: true }, { target: 'body', power: 1 }, { perspective: 'taken', knockdown: true }, { power: -3, pan: 9 }],
    bell: [{ rings: 1 }, { rings: 5, spacing: 0.2 }],
    whistle: [{ pattern: 'start' }, { pattern: 'end' }, { pattern: 'short' }],
  };
  for (const name of SFX_NAMES) {
    for (const opts of [...(variants[name] || [{}]), { gain: 0 }, { gain: -1, power: 2, pan: -5 }]) {
      const ctx = new FakeContext();
      const res = getResources(ctx, mulberry32(1));
      const out = { dry: ctx.createGain(), send: ctx.createGain() };
      const n0 = ctx.nodes.length;
      const end = SFX[name](ctx, out, 0.1, opts, res);
      assert(Number.isFinite(end) && end > 0.1 && end < 12, `${name}: end ${end}`);
      const made = newCtxNodes(ctx, n0);
      assert(made.length > 0, `${name} made nodes`);
      assert(made.some((n) => n.outputs.has(out.dry) || [...n.outputs].some((d) => d === out.dry)), `${name} reaches the bus`);
      for (const s of ctx.sources) assert(s.stopAt !== undefined && s.stopAt >= s.startAt, `${name}: every source stops`);
      ctx.advance(end + 1);
      const leaks = made.filter((n) => !n.disconnected);
      assert.equal(leaks.length, 0, `${name}: ${leaks.length} nodes left connected (${leaks.map((n) => n.kind).join(',')})`);
    }
  }
});

test('audio engine: every music instrument and crowd reaction is valid and self-cleaning', () => {
  const ev = { midi: 64, notes: [60, 64, 67], dur: 0.4, vel: 0.9, glideFrom: 62 };
  for (const name of Object.keys(INSTR)) {
    const ctx = new FakeContext(), res = getResources(ctx, mulberry32(2));
    const out = { dry: ctx.createGain(), send: ctx.createGain(), echo: ctx.createGain() };
    const n0 = ctx.nodes.length;
    const end = INSTR[name](ctx, out, 0.05, ev, res);
    assert(Number.isFinite(end) && end > 0.05, `${name}: end`);
    ctx.advance(end + 1);
    assert.equal(newCtxNodes(ctx, n0).filter((n) => !n.disconnected).length, 0, `${name}: leaked nodes`);
  }
  for (const kind of ['ooh', 'cheer', 'roar', 'gasp', 'aww', 'shout', 'whistle']) {
    const ctx = new FakeContext(), res = getResources(ctx, mulberry32(3));
    const out = { dry: ctx.createGain(), send: ctx.createGain() };
    const n0 = ctx.nodes.length;
    const end = crowdReaction(ctx, out, 0.2, kind, { amount: 0.8 }, res);
    assert(end > 0.2, kind);
    ctx.advance(end + 1);
    assert.equal(newCtxNodes(ctx, n0).filter((n) => !n.disconnected).length, 0, `crowd ${kind}: leaked nodes`);
  }
});

test('audio engine: the drum roll can be cut short and still cleans up', () => {
  const ctx = new FakeContext(), res = getResources(ctx, mulberry32(4));
  const out = { dry: ctx.createGain(), send: ctx.createGain() };
  const n0 = ctx.nodes.length;
  const roll = drumRoll(ctx, out, 0, { dur: 3 }, res);
  const strokes = ctx.sources.filter((s) => s.kind === 'buffer').length;
  assert(strokes > 40 && strokes < 80, `about 14–22 strokes a second (${strokes})`);
  roll.stop(1.2);
  roll.stop(1.3); // idempotent
  ctx.advance(roll.end + 1);
  assert.equal(newCtxNodes(ctx, n0).filter((n) => !n.disconnected).length, 0);
});

test('audio engine: envelope helpers never ramp exponentially to zero and end where they say', () => {
  const ctx = new FakeContext();
  const g = ctx.createGain();
  approx(perc(g.gain, 1, 0, 0.01, 0.2), 1.21, 1e-9, 'perc end');
  assert(g.gain.events.every((e) => e.type !== 'exp' || e.v >= EPS));
  const g2 = ctx.createGain();
  const end = adsr(g2.gain, 0, 0.5, { a: 0.01, d: 0.1, s: 0.5, r: 0.2, peak: 0.8 });
  approx(end, 0.7, 1e-9);
  const last = g2.gain.events[g2.gain.events.length - 1];
  assert(last.type === 'linear' && last.v === 0, 'release lands on exactly 0');
});

test('audio engine: soft clip curve is transparent below the knee and bounded above it', () => {
  const c = makeSoftClipCurve({ n: 2049, headroom: 2, knee: 0.8, ceiling: 0.985 });
  assert.equal(c[1024], 0, 'zero maps to zero (no DC)');
  for (let i = 0; i < c.length; i++) {
    const s = ((i / (c.length - 1)) * 2 - 1) * 2;
    if (Math.abs(s) <= 0.8) approx(c[i], s, 1e-6, 'linear below the knee');
    assert(Math.abs(c[i]) <= 0.985 + 1e-9);
    if (i) assert(c[i] >= c[i - 1], 'monotonic');
  }
  assert(c[c.length - 1] > 0.97);
});

test('audio engine: noise/applause generators are normalised and the meter measures them', () => {
  const w = fillNoise(new Float32Array(4000), 'white', mulberry32(1));
  const p = fillNoise(new Float32Array(4000), 'pink', mulberry32(1));
  const b = fillNoise(new Float32Array(4000), 'brown', mulberry32(1));
  for (const d of [w, p, b]) approx(Math.max(...d.map(Math.abs)), 0.95, 1e-6);
  const L = new Float32Array(8000), R = new Float32Array(8000);
  fillApplause(L, R, 8000, { clapsPerSec: 40, rng: mulberry32(2) });
  const m = measure([L, R], 8000);
  approx(m.peak, 0.9, 1e-6);
  assert(m.rms > 0.02 && m.clipped === 0);
  const silent = measure([new Float32Array(100)], 8000);
  assert.equal(silent.peak, 0);
  assert.equal(silent.activeSec, 0);
  approx(volumeToGain(1), 1, 1e-12);
  assert.equal(volumeToGain(0), 0);
  assert(volumeToGain(0.5) < 0.5 && volumeToGain(0.5) > 0.2);
  assert.equal(volumeToGain('nope'), 0);
});

// ───────────────────────────── engine ─────────────────────────────

test('audio engine: constructing touches no audio; before unlock sounds are skipped but music/crowd requests are remembered', async () => {
  let made = 0;
  const ctx = new FakeContext({ state: 'suspended' });
  const timers = fakeTimers();
  const e = new AudioEngine({ createContext: () => { made++; return ctx; }, timers, speech: null, autoUnlock: false });
  assert.equal(made, 0, 'no context until unlock (avoids the autoplay warning)');
  assert.equal(e.playSfx('hit'), false);
  assert.equal(e.music('menu'), true);
  e.startCrowd();
  assert.equal(e.currentMusic, 'menu');
  assert(e.crowdRunning);
  assert.equal(e.state().context, 'none');
  const ok = await e.unlock();
  assert.equal(ok, true);
  assert.equal(made, 1);
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(e.currentMusic, 'menu', 'remembered request applied');
  assert(e.crowd, 'crowd started on unlock');
  assert(e.scheduler.running, 'scheduler runs once audio runs');
  assert.equal(e.playSfx('ui-confirm'), true);
  await e.unlock();
  assert.equal(made, 1, 'unlock is idempotent');
  e.dispose();
  assert.equal(ctx.state, 'closed', 'an owned context is closed on dispose');
});

test('audio engine: with sticky user activation (an earlier real click) audio starts without another gesture', async () => {
  const nav = globalThis.navigator;
  if (!nav) return; // very old Node: nothing to stub
  let made = 0;
  const mk = () => { made++; return new FakeContext({ state: 'suspended' }); };
  Object.defineProperty(nav, 'userActivation', { value: { hasBeenActive: false }, configurable: true });
  try {
    const bus = new EventBus();
    const e = new AudioEngine({ createContext: mk, timers: fakeTimers(), speech: null, bus });
    bus.emit(Ev.APP_SCREEN, { screen: 'title' });
    assert.equal(made, 0, 'no activation yet: no context (no autoplay warning)');
    nav.userActivation.hasBeenActive = true; // e.g. the player clicked "Start" on the title screen
    bus.emit(Ev.UI_NAV, { action: 'down' });  // unhandled event: still nothing
    assert.equal(made, 0);
    bus.emit(Ev.APP_SCREEN, { screen: 'mode' });
    assert.equal(made, 1, 'the next audio-relevant event unlocks');
    await Promise.resolve();
    assert.equal(e.currentMusic, 'menu');
    e.dispose();
    const e2 = new AudioEngine({ createContext: mk, timers: fakeTimers(), speech: null });
    assert.equal(made, 2, 'an engine created after the activation starts right away');
    e2.dispose();
  } finally {
    delete nav.userActivation;
  }
});

test('audio engine: master chain — buses → master → glue → limiter → soft clip → hide gain → speakers', () => {
  const { e, ctx } = engineWith();
  const kinds = (n) => [...n.outputs].map((o) => o.kind);
  assert(e.hideGain.outputs.has(ctx.destination));
  const comps = ctx.nodes.filter((n) => n.kind === 'compressor');
  assert.equal(comps.length, 2);
  assert(kinds(e.masterGain).includes('compressor'));
  assert.equal(e.limiter.ratio.value, AUDIO_TUNING.limiter.ratio);
  const shaper = ctx.nodes.find((n) => n.kind === 'shaper' && n.curve && n.curve.length === 2049);
  assert(shaper && shaper.outputs.has(e.hideGain), 'soft clipper feeds the output');
  for (const name of ['sfx', 'crowd', 'music', 'voice']) {
    assert(e.cat[name].dry.outputs.has(e.masterGain), `${name} → master`);
    assert(e.cat[name].send.outputs.has(e.verbIn), `${name} → reverb`);
  }
  e.dispose();
});

test('audio engine: volumes follow the settings sliders (crowd follows Effects); mute silences master', () => {
  const { e, ctx } = engineWith({ extra: { volumes: { master: 1, sfx: 1, music: 1, voice: 1 } } });
  const lastTarget = (p) => p.events.filter((x) => x.type === 'target').pop()?.v ?? p.value;
  approx(e.cat.sfx.dry.gain.value, AUDIO_TUNING.busLevel.sfx, 1e-9);
  e.setVolume({ music: 0.5, sfx: 0 });
  approx(lastTarget(e.cat.music.dry.gain), volumeToGain(0.5) * AUDIO_TUNING.busLevel.music, 1e-9);
  assert.equal(lastTarget(e.cat.sfx.dry.gain), 0);
  assert.equal(lastTarget(e.cat.crowd.dry.gain), 0, 'crowd uses the Effects volume');
  assert.deepEqual(e.getVolume(), { master: 1, sfx: 0, music: 0.5, voice: 1 });
  e.setVolume({ master: 'x', voice: 7 });
  assert.equal(e.getVolume().voice, 1, 'clamped');
  assert.equal(e.getVolume().master, 1, 'junk ignored');
  e.setMuted(true);
  assert.equal(lastTarget(e.masterGain.gain), 0);
  e.setMuted(false);
  approx(lastTarget(e.masterGain.gain), AUDIO_TUNING.masterTrim, 1e-9);
  void ctx;
  e.dispose();
});

test('audio engine: wired to the bus — a little legacy bout (no Ev.MATCH_CALL) still plays every moment, once', () => {
  const bus = new EventBus();
  const sp = fakeSpeech();
  const { e, ctx, timers } = engineWith({ speech: sp.speech, extra: { bus } });
  const names = () => e.log.map((l) => `${l.kind}:${l.name}`);
  const step = (t) => { ctx.advance(t); e.pump(0.25); timers.flush(); };
  bus.emit(Ev.MATCH_INTRO, { p1Name: 'Ana', p2Name: 'Rocco', mode: 'single' });
  assert(e.crowd, 'crowd on');
  assert(names().includes('react:cheer'));
  assert.equal(sp.spoken.length, 0, 'no intro line: the bout goes straight to the round call');
  bus.emit(Ev.MATCH_ROUND_START, { round: 1, maxRounds: 3 });
  assert(!sp.spoken.some((u) => u.text === 'Round one!'), 'the round call waits a moment for a MATCH_CALL');
  step(AUDIO_TUNING.calls.roundFallbackSec + 0.05);
  assert(sp.spoken.some((u) => u.text === 'Round one!'), 'no call came: the round start calls it itself');
  assert(names().includes('sfx:round-tone'), 'with the tone under the banner');
  bus.emit(Ev.MATCH_BELL, { kind: 'start', round: 1 });
  assert(names().includes('sfx:bell'));
  assert(sp.spoken.some((u) => u.text === 'Fight!'));
  assert.equal(e.state().phase, 'fighting');
  bus.emit(Ev.MATCH_PUNCH_THROWN, { attacker: 'p1', hand: 'left', kind: 'straight', target: 'head' });
  step(1.5);
  bus.emit(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2', hand: 'left', kind: 'straight', target: 'head', power: 0.6, counter: true, hp01: 0.5 });
  bus.emit(Ev.MATCH_BLOCK, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'hook', target: 'head', chip: 0 });
  step(1.9);
  bus.emit(Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'left', kind: 'straight', counterWindowMs: 600 });
  step(2.2);
  bus.emit(Ev.MATCH_MISS, { attacker: 'p1', hand: 'right', kind: 'straight' });
  for (const n of ['sfx:swish', 'sfx:hit', 'react:ooh', 'sfx:block', 'sfx:dodge', 'sfx:counter-ready', 'sfx:whoosh']) assert(names().includes(n), `missing ${n}`);
  assert(e.excitement > AUDIO_TUNING.crowd.phaseBase.fighting, 'exchanges excite the crowd');
  step(3);
  bus.emit(Ev.MATCH_KNOCKDOWN, { downed: 'p2', count: 1 });
  assert.equal(e.state().phase, 'knockdown');
  step(3 + AUDIO_TUNING.calls.downFallbackSec + 0.05);
  assert(sp.spoken.some((u) => u.text === 'Down!'), '"Down!" before the count');
  for (let n = 1; n <= 3; n++) bus.emit(Ev.MATCH_COUNT, { downed: 'p2', n });
  assert(sp.spoken.some((u) => u.text === 'Three!' && u.rate === AUDIO_TUNING.voice.countRate));
  assert.equal(sp.spoken.find((u) => u.text === 'Three!').voice.name, 'Daniel', 'a preferred English voice');
  bus.emit(Ev.MATCH_GETUP, { downed: 'p2', atCount: 3 });
  assert(names().includes('sfx:getup'));
  step(6);
  bus.emit(Ev.MATCH_KO, { winner: 'p1', loser: 'p2', method: 'KO' });
  bus.emit(Ev.MATCH_BELL, { kind: 'final' });
  assert(!names().includes('sfx:ko-slam'), 'the KO moment comes at the measured "10" → "KO" gap');
  for (let t = 6.1; t <= 9.6; t += 0.1) step(t);
  assert(names().includes('sfx:ko-slam') && sp.spoken.some((u) => u.text === 'Knockout!'));
  bus.emit(Ev.MATCH_RESULT, { id: 'm1', winner: 'p1', method: 'KO', mode: 'single' });
  for (let t = 9.7; t <= 9.6 + AUDIO_TUNING.outro.waitSec + 0.2; t += 0.1) step(t);
  const stingers = e.log.filter((l) => l.kind === 'stinger').map((l) => l.name);
  assert.deepEqual(stingers, ['ko', 'victory'], 'no outro started: the engine plays the result jingle itself');
  const voiced = sp.spoken.map((u) => u.text);
  for (const line of ['Round one!', 'Fight!', 'Down!', 'Knockout!']) assert.equal(voiced.filter((x) => x === line).length, 1, `${line} exactly once`);
  e.dispose();
});

test('audio engine: the decision roll ends with a reveal; a draw plays the draw jingle', () => {
  const bus = new EventBus();
  const { e, ctx } = engineWith({ extra: { bus } });
  bus.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B', mode: 'single' });
  bus.emit(Ev.MATCH_DECISION, { scorecards: [] });
  assert(e._roll, 'drum roll running');
  ctx.advance(2);
  bus.emit(Ev.MATCH_RESULT, { id: 'x', winner: null, method: 'draw', mode: 'single' });
  assert(!e._roll);
  for (let t = 2.1; t <= 2 + AUDIO_TUNING.outro.waitSec + 0.6; t += 0.1) { ctx.advance(t); e.pump(0.25); }
  const names = e.log.map((l) => l.name);
  assert(names.includes('drum-roll') && names.includes('reveal') && names.includes('draw'));
  e.dispose();
});

test('audio engine: menu music on menu screens, silence + crowd in a match, groove in training', () => {
  const bus = new EventBus();
  const { e, ctx } = engineWith({ extra: { bus } });
  bus.emit(Ev.APP_SCREEN, { screen: 'title' });
  assert.equal(e.currentMusic, 'menu');
  bus.emit(Ev.MATCH_INTRO, { p1Name: 'A', p2Name: 'B' });
  assert.equal(e.currentMusic, null, 'menu music fades for the fight');
  assert(e.crowd);
  bus.emit(Ev.APP_PAUSE, { reason: 'user' });
  assert(e.state().paused);
  bus.emit(Ev.APP_SCREEN, { screen: 'settings' });
  assert.equal(e.currentMusic, null, 'settings opened from pause keeps the arena');
  bus.emit(Ev.APP_SCREEN, { screen: 'mode' }); // quit to the menu
  assert.equal(e.currentMusic, 'menu');
  assert(!e.crowd && !e.state().paused, 'crowd gone, pause duck released');
  ctx.advance(3);
  bus.emit(Ev.TRAIN_START, { kind: 'mitts' });
  assert.equal(e.currentMusic, 'training');
  bus.emit(Ev.TRAIN_EVENT, { kind: 'mitts', type: 'mitt-hit', power: 0.8 });
  bus.emit(Ev.TRAIN_EVENT, { kind: 'mitts', type: 'trainer-hit' });
  ctx.advance(4);
  bus.emit(Ev.TRAIN_END, { kind: 'mitts', score: 300, medal: 'gold' });
  assert.equal(e.currentMusic, null);
  const names = e.log.map((l) => l.name);
  for (const n of ['whistle', 'mitt-smack', 'trainer-oof', 'medal-gold']) assert(names.includes(n), n);
  e.dispose();

  const manual = engineWith({ extra: { bus: new EventBus(), autoMusic: false } });
  manual.e.bus.emit(Ev.APP_SCREEN, { screen: 'title' });
  assert.equal(manual.e.currentMusic, null, 'autoMusic:false leaves music to the app');
  manual.e.dispose();
});

test('audio engine: the medal jingle plays once even if the result screen asks for it too', () => {
  const bus = new EventBus();
  const { e, ctx } = engineWith({ extra: { bus } });
  bus.emit(Ev.TRAIN_END, { medal: 'silver' });            // engine schedules it 1.3 s later
  assert.equal(e.playSfx('medal-silver'), true);           // screen asks earlier: it replaces the pending one
  ctx.advance(3);
  assert.equal(e.playSfx('medal-silver'), true);           // asked again later: deduped (already played)
  const count = e.log.filter((l) => l.name === 'medal-silver').length;
  assert.equal(count, 2, 'two scheduled, the first (pending automatic) one was cancelled');
  const live = e.player.tracks.filter((t) => t.name === 'medal-silver' && !t.dead);
  assert.equal(live.length, 1, 'exactly one silver jingle sounds');
  ctx.advance(30);
  assert.equal(e.playSfx('medal-silver'), true);
  assert.equal(e.log.filter((l) => l.name === 'medal-silver').length, 3, 'a new attempt later plays again');
  e.dispose();
});

test('audio engine: rate limits and the voice cap protect against spam', () => {
  const { e, ctx } = engineWith();
  assert.equal(e.playSfx('swish'), true);
  assert.equal(e.playSfx('swish'), false, 'swish spam within 40 ms is dropped');
  ctx.advance(0.1);
  assert.equal(e.playSfx('swish'), true);
  let ok = 0;
  for (let i = 0; i < 200; i++) if (e.playSfx('hit', { power: 0.5 })) ok++;
  assert(ok <= AUDIO_TUNING.maxVoices * 1.5 && ok >= AUDIO_TUNING.maxVoices, `voice cap (${ok})`);
  assert.equal(e.playSfx('ui-move'), false, 'low-priority sounds yield when busy');
  assert.equal(e.playSfx('no-such-sound'), false);
  assert.equal(e.playSfx(42), false);
  e.dispose();
});

test('audio engine: crowd follows excitement; reactions are rate-limited and never stack on a roar', () => {
  const { e, ctx } = engineWith();
  e.startCrowd();
  e.startCrowd();
  assert.equal(ctx.nodes.filter((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.frequency.events.some((x) => x.type === 'target')).length >= 1, true);
  const murmur = e.crowd.murmur.gain;
  const target = () => murmur.events.filter((x) => x.type === 'target').pop().v;
  e.setExcitement(0.1);
  const calm = target();
  e.setExcitement(1);
  const wild = target();
  assert(wild > calm * 2, `louder when excited (${calm.toFixed(3)} → ${wild.toFixed(3)})`);
  e.setExcitement(null);
  assert.equal(e.crowdReact('ooh'), true);
  assert.equal(e.crowdReact('ooh'), false, 'gap between identical reactions');
  assert.equal(e.crowdReact('roar'), true);
  assert.equal(e.crowdReact('cheer'), false, 'no cheer on top of a roar');
  ctx.advance(2);
  e.pump(0.5);
  assert.equal(e.crowdReact('cheer'), true);
  assert.equal(e.crowdReact('boo'), false, 'unknown reaction');
  const bed = e.crowd;
  e.stopCrowd({ fade: 0.5 });
  assert(!e.crowd);
  ctx.advance(10);
  assert(bed.nodes.length === 0, 'crowd bed disconnected after its fade');
  e.dispose();
});

test('audio engine: crowd blips are scheduled ahead and never in the past', () => {
  const { e, ctx } = engineWith();
  e.startCrowd();
  e.setExcitement(1);
  const before = ctx.sources.length;
  ctx.advance(5);
  e.pump(2);
  const fresh = ctx.sources.slice(before);
  assert(fresh.length > 0, 'shouts/whistles scheduled');
  assert(fresh.every((s) => s.startAt >= 5 - 0.02), 'nothing scheduled in the past after a stall');
  e.dispose();
});

test('audio engine: speech — counts interrupt; falls back to beeps without voices; muted voice stays quiet', () => {
  const sp = fakeSpeech();
  const { e } = engineWith({ speech: sp.speech });
  assert.equal(e.say('Round one!'), true);
  assert.equal(sp.spoken[0].pitch, AUDIO_TUNING.voice.pitch);
  assert.equal(sp.spoken[0].lang, 'en-GB');
  const c0 = sp.cancels;
  e.say('Two!', { interrupt: true, kind: 'count', n: 2 });
  assert.equal(sp.cancels, c0 + 1);
  assert(e.state().speech === 'speech');
  e.setVolume({ voice: 0 });
  assert.equal(e.say('Quiet'), false);
  e.dispose();

  const none = fakeSpeech({ voices: [] });
  const t = fakeTimers();
  const b = engineWith({ speech: none.speech, timers: t });
  t.flush(); // voice list settles empty
  assert.equal(b.e.state().speech, 'beeps');
  assert.equal(b.e.say('Seven!', { kind: 'count', n: 7 }), true);
  assert(b.e.log.some((l) => l.name === 'count-beep'));
  assert.equal(b.e.say('Knockout!'), true);
  assert(b.e.log.some((l) => l.name === 'voice-blips'));
  assert.equal(none.spoken.length, 0);
  b.e.dispose();

  const nospeech = engineWith({ speech: null });
  assert.equal(nospeech.e.state().speech, 'beeps');
  nospeech.e.dispose();
});

test('audio engine: speech blocked for lack of a user gesture never disables the announcer voice', () => {
  const spoken = [];
  class Utterance { constructor(text) { this.text = text; } }
  let allowed = false;
  const synth = {
    getVoices: () => [{ name: 'Daniel', lang: 'en-GB', localService: true }],
    speak: (u) => { spoken.push(u); if (allowed) u.onstart?.(); else u.onerror?.({ error: 'not-allowed' }); },
    cancel() {}, addEventListener() {},
  };
  const { e } = engineWith({ speech: { synth, Utterance } });
  for (let i = 0; i < 5; i++) e.say(`${i}`);
  assert.equal(e.state().speech, 'speech', 'still speech after five not-allowed errors');
  allowed = true;
  e.say('Fight!');
  assert.equal(spoken[spoken.length - 1].text, 'Fight!');
  const { e: e2 } = engineWith({ speech: { synth: { ...synth, speak: (u) => u.onerror?.({ error: 'synthesis-failed' }) }, Utterance } });
  e2.say('a'); e2.say('b');
  assert.equal(e2.state().speech, 'beeps', 'a really broken voice falls back to beeps');
  e.dispose(); e2.dispose();
});

test('audio engine: speech ducks the crowd and music while the announcer talks', () => {
  const sp = fakeSpeech();
  const { e } = engineWith({ speech: sp.speech });
  const lastTarget = (p) => p.events.filter((x) => x.type === 'target').pop()?.v ?? p.value;
  const before = lastTarget(e.cat.crowd.dry.gain);
  e.say('Five!');
  assert(lastTarget(e.cat.crowd.dry.gain) < before, 'ducked');
  sp.spoken[0].onend();
  approx(lastTarget(e.cat.crowd.dry.gain), before, 1e-9, 'released');
  e.dispose();
});

test('audio engine: a hidden tab fades out, suspends and resumes cleanly', async () => {
  const { e, ctx, timers } = engineWith();
  // adopt a "realtime" context: pretend it is not offline (FakeContext has no startRendering)
  await e.unlock();
  assert(e.scheduler.running);
  e._setHidden(true);
  assert.equal(e.playSfx('ui-confirm'), false, 'no sounds while hidden');
  assert(!e.scheduler.running, 'timers idle while hidden');
  timers.flush();
  assert.equal(ctx.state, 'suspended');
  e._setHidden(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.state, 'running');
  assert(e.scheduler.running);
  const hideTargets = e.hideGain.gain.events.filter((x) => x.type === 'target').map((x) => x.v);
  assert.deepEqual(hideTargets, [0, 1]);
  e.dispose();
});

test('audio engine: dispose detaches from the bus and stops everything', () => {
  const bus = new EventBus();
  const { e, timers } = engineWith({ extra: { bus } });
  e.music('menu');
  e.startCrowd();
  e.dispose();
  const n = e.log.length;
  bus.emit(Ev.MATCH_HIT, { attacker: 'p1', defender: 'p2' });
  assert.equal(e.log.length, n, 'no longer listening');
  assert.equal(e.playSfx('hit'), false);
  assert.equal(timers.intervalCount, 0);
  assert.equal(e.player.tracks.length, 0);
  e.dispose(); // twice is fine
});

// ───────────────────────────── music player ─────────────────────────────

test('music player: schedules exactly the song events, once, with lookahead', () => {
  const ctx = new FakeContext(), res = getResources(ctx, mulberry32(5));
  const out = { dry: ctx.createGain(), send: ctx.createGain() };
  const mp = new MusicPlayer({ ctx, out, res });
  assert.equal(mp.play('menu'), true);
  const tr = mp.loop;
  const start = tr.start;
  approx(start, MUSIC_TUNING.startDelay, 1e-9);
  let total = tr.scheduled;
  for (let t = 0; t <= 10; t += 0.03) {
    ctx.advance(t);
    total += mp.pump(t, t + MUSIC_TUNING.lookahead);
    total += mp.pump(t, t + MUSIC_TUNING.lookahead); // a second pump in the same window adds nothing
  }
  const expected = eventsInWindow(SONGS.menu, start, 0, 10 + MUSIC_TUNING.lookahead).length;
  assert.equal(tr.scheduled, expected, 'every event exactly once');
  assert.equal(total, expected);
  assert.equal(mp.play('menu'), true);
  assert.equal(mp.loop, tr, 'asking for the playing loop does not restart it');
  assert.equal(mp.play('nope'), false);
  mp.dispose();
});

test('music player: crossfade between loops retires the old track and its nodes', () => {
  const ctx = new FakeContext(), res = getResources(ctx, mulberry32(6));
  const out = { dry: ctx.createGain(), send: ctx.createGain() };
  const mp = new MusicPlayer({ ctx, out, res });
  mp.play('menu');
  ctx.advance(2);
  mp.pump(2, 2.25);
  const old = mp.loop;
  mp.play('training');
  assert.equal(mp.current, 'training');
  assert(old.stopAt <= 2 + MUSIC_TUNING.crossfade + 1e-9, 'old loop fades over the crossfade');
  const fadeEv = old.g.gain.events.filter((x) => x.t >= 2);
  assert.equal(fadeEv[fadeEv.length - 1].v, 0);
  ctx.advance(4);
  mp.pump(4, 4.25);
  assert(old.dead && old.g.disconnected, 'faded track disconnected');
  assert.equal(mp.active, 1);
  mp.stop();
  assert.equal(mp.current, null);
  mp.dispose();
});

test('music player: a stalled clock never bursts late notes — it re-syncs to the bar grid', () => {
  const ctx = new FakeContext(), res = getResources(ctx, mulberry32(7));
  const out = { dry: ctx.createGain(), send: ctx.createGain() };
  const mp = new MusicPlayer({ ctx, out, res });
  mp.play('training');
  const before = ctx.sources.length;
  ctx.advance(30);                       // e.g. the main thread froze for 30 s
  const n = mp.pump(30, 30.25);
  const fresh = ctx.sources.slice(before);
  assert(n < 40, `only the next quarter second is scheduled (${n} events)`);
  assert(fresh.every((s) => s.startAt >= 30 - MUSIC_TUNING.lateSlack), 'nothing scheduled in the past');
  mp.dispose();
});

test('music player: stingers duck the loop, replace each other and end on their own', () => {
  const ctx = new FakeContext(), res = getResources(ctx, mulberry32(8));
  const out = { dry: ctx.createGain(), send: ctx.createGain() };
  const mp = new MusicPlayer({ ctx, out, res });
  mp.play('menu');
  const h1 = mp.stinger('medal-gold');
  assert(h1 && h1.end > h1.start);
  approx(h1.end - h1.start, stingerLength(STINGERS['medal-gold']), 1e-9);
  const duck = mp.loopDry.gain.events.filter((x) => x.type === 'target');
  assert.equal(duck[0].v, MUSIC_TUNING.stingerDuck);
  assert.equal(duck[duck.length - 1].v, 1, 'loop restored after the stinger');
  ctx.advance(0.5);
  mp.pump(0.5, 0.75);
  const h2 = mp.stinger('victory');
  const first = mp.tracks.find((t) => t.name === 'medal-gold');
  assert(first.stopAt <= h2.start + MUSIC_TUNING.stingerCut + 1e-9, 'the newer stinger cuts the older one (short crossfade)');
  assert.equal(mp.stinger('nope'), null);
  ctx.advance(20);
  mp.pump(20, 20.25);
  assert.equal(mp.tracks.filter((t) => !t.def.loop).length, 0, 'finished stingers retired');
  mp.dispose();
});

test('audio engine: SOUND_NAMES covers every recipe and jingle', () => {
  for (const n of SFX_NAMES) assert(SOUND_NAMES.includes(n));
  for (const n of Object.keys(STINGERS)) assert(SOUND_NAMES.includes(n));
  assert(!SOUND_NAMES.includes('menu'), 'loops are music(), not playSfx()');
  void Voice;
});

// ───────────────────────────── end-to-end with the real game modules ─────────────────────────────

const liveNodes = (ctx) => ctx.nodes.filter((n) => !n.disconnected && n.outputs.size > 0).length;

function withErrors(fn) {
  const errors = [], orig = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return errors;
}

test('audio integration: real bouts (simulator bots vs roster opponents) sound right end-to-end', () => {
  for (const [tier, botKind, seed] of [[1, 'smart', 11], [5, 'beginner', 12], [8, 'average', 13]]) {
    const opp = ROSTER.find((o) => o.tier === tier) || ROSTER[0];
    const bus = new EventBus(), ctx = new FakeContext(), timers = fakeTimers();
    const counts = {};
    bus.on('*', (n) => { counts[n] = (counts[n] || 0) + 1; });
    let e, match, base;
    const said = [];
    let bells = 0;
    const errors = withErrors(() => {
      e = new AudioEngine({ context: ctx, timers, rng: seed, speech: fakeSpeech({ autoEnd: true }).speech, bus });
      const cue = e._cue.bind(e);
      e._cue = (c, now) => { if (c?.type === 'say') said.push({ text: c.text, at: now + (c.delay || 0) }); return cue(c, now); };
      const sfxAt = e._sfxAt.bind(e); // (e.log only keeps the last 80 cues: count bells here)
      e._sfxAt = (n, o, t) => { const ok = sfxAt(n, o, t); if (ok && n === 'bell') bells++; return ok; };
      bus.emit(Ev.APP_SCREEN, { screen: 'opponent' }); // menu music before the fight
      base = liveNodes(ctx);
      const rng = new Rng(seed);
      match = new Match({ bus, mode: 'single', p1: { name: 'Pat', isHuman: true }, p2: opp, rng: rng.fork('match'), rules: SIM_RULES, id: `audio-${seed}` });
      const bot = makeBot(botKind, rng.fork('bot'));
      match.start(0);
      let now = 0;
      while (match.phase !== 'result' && now < 12 * 60 * 1000) {
        now += 1000 / 30;
        ctx.advance(now / 1000);
        e.pump(MUSIC_TUNING.lookahead);
        const view = match.getView();
        match.update(1 / 30, now, { p1: bot.update(view.t, view, 'p1') });
      }
      for (let k = 0; k < 12; k++) { now += 1000; ctx.advance(now / 1000); e.pump(MUSIC_TUNING.lookahead); }
    });
    const label = `tier ${tier} ${botKind}`;
    assert.deepEqual(errors, [], `${label}: no errors`);
    assert.equal(match.phase, 'result', `${label}: bout finished`);
    const r = match.getResult();
    const jingle = r.winner === null ? 'draw' : r.winner === 'p1' ? 'victory' : 'defeat';
    assert(e._stingers.has(jingle), `${label}: the ${jingle} jingle played`);
    assert(!['victory', 'defeat', 'draw'].filter((n) => n !== jingle).some((n) => e._stingers.has(n)), `${label}: only one result jingle (MAT04)`);
    assert((counts[Ev.MATCH_HIT] || 0) > 0 && (counts[Ev.MATCH_BELL] || 0) + (counts[Ev.MATCH_CALL] || 0) >= 2, `${label}: a real fight happened`);
    assert(bells >= 1, `${label}: the bell rang`);
    for (let i = 1; i < said.length; i++) {
      const prev = said.slice(0, i).reverse().find((s) => s.text === said[i].text);
      assert(!prev || said[i].at - prev.at > 1.5, `${label}: "${said[i].text}" voiced twice for one moment`);
    }
    assert(said.some((s) => s.text === 'Fight!'), `${label}: "Fight!" was called`);
    assert.notEqual(e.currentMusic, 'menu', `${label}: no menu music during or after the fight`);
    assert.equal(e.currentMusic, 'results', `${label}: results music after the result jingle`);
    e.stopCrowd({ fade: 0.1 });
    ctx.advance(ctx.currentTime + 30);
    e.pump(0.1);
    assert(liveNodes(ctx) <= base + 2, `${label}: every short-lived node was released (${liveNodes(ctx)} vs ${base})`);
    e.dispose();
  }
});

test('audio integration: every sound the real bout asked for was scheduled (nothing silently dropped)', () => {
  const bus = new EventBus(), ctx = new FakeContext(), timers = fakeTimers();
  const e = new AudioEngine({ context: ctx, timers, rng: 4, speech: fakeSpeech({ autoEnd: true }).speech, bus });
  const asked = {}, played = {};
  const origSfx = e._sfxAt.bind(e);
  e._sfxAt = (name, opts, t) => { asked[name] = (asked[name] || 0) + 1; const ok = origSfx(name, opts, t); if (ok) played[name] = (played[name] || 0) + 1; return ok; };
  const rng = new Rng(21);
  const match = new Match({ bus, mode: 'single', p1: { name: 'Pat', isHuman: true }, p2: ROSTER[2], rng: rng.fork('match'), rules: SIM_RULES, id: 'audio-21' });
  const bot = makeBot('smart', rng.fork('bot'));
  match.start(0);
  let now = 0;
  while (match.phase !== 'result' && now < 12 * 60 * 1000) {
    now += 1000 / 30;
    ctx.advance(now / 1000);
    e.pump(MUSIC_TUNING.lookahead);
    const view = match.getView();
    match.update(1 / 30, now, { p1: bot.update(view.t, view, 'p1') });
  }
  for (const n of ['hit', 'block', 'bell', 'count-tick', 'thud']) {
    if (!asked[n]) continue;
    assert(played[n] / asked[n] >= 0.97, `${n}: ${played[n]}/${asked[n]} played`);
  }
  assert(asked.hit > 5, 'the bout had hits');
  e.dispose();
});

test('audio integration: real training drills (bag, dodge, mitts) sound right end-to-end', () => {
  const expect = { bag: ['bag-thump'], dodge: ['ball-throw', 'dodge-swish'], mitts: ['mitt-up', 'mitt-smack'] };
  for (const kind of ['bag', 'dodge', 'mitts']) {
    const bus = new EventBus(), ctx = new FakeContext(), timers = fakeTimers();
    const types = new Set();
    bus.on(Ev.TRAIN_EVENT, (p) => types.add(p.type));
    let e, act;
    const names = {};
    const errors = withErrors(() => {
      e = new AudioEngine({ context: ctx, timers, rng: 9, speech: null, bus });
      const orig = e._sfxAt.bind(e);
      e._sfxAt = (n, o, t) => { const ok = orig(n, o, t); if (ok) names[n] = (names[n] || 0) + 1; return ok; };
      act = createActivity(kind, { bus, rng: 5, participant: { id: 'p', name: 'Pat' }, durationMs: 15000, readyMs: 600 });
      act.start(0);
      let now = 0, k = 0;
      const step = 1000 / 60;
      while (!act.isDone() && now < 40000) {
        now += step;
        ctx.advance(now / 1000);
        e.pump(MUSIC_TUNING.lookahead);
        const events = [];
        const punch = (hand, target) => { k = now; events.push({ type: 'punch', t: now, punch: { hand, kind: 'straight', target, power: 0.7, t: now } }); };
        if (kind === 'mitts') { // a sensible pupil: hit the mitt that is shown, with the glove it asks for
          const m = (act.getView().mitts || []).find((x) => x.live && !x.claimed);
          if (m && now - k > 260) punch(m.hand, m.height === 'low' ? 'body' : 'head');
        } else if (now - k >= 380) punch(Math.round(now / 380) % 2 ? 'left' : 'right', 'head');
        const lean = kind === 'dodge' ? Math.sin(now / 260) : 0;
        const hand = (x) => ({ x, y: 0.3, reach: 0, punching: false });
        const control = { tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: lean, y: 0, z: 0 }, head: { x: lean * 0.4, y: 0 }, hands: { left: hand(-0.4), right: hand(0.4) }, activity: 0.3 };
        act.update(step / 1000, now, { control, events });
      }
      for (let j = 0; j < 6; j++) { now += 1000; ctx.advance(now / 1000); e.pump(MUSIC_TUNING.lookahead); }
    });
    assert.deepEqual(errors, [], `${kind}: no errors`);
    assert(act.isDone(), `${kind}: finished`);
    assert(types.has('go') && types.has('time-up'), `${kind}: emitted go/time-up (${[...types].join(',')})`);
    assert.equal(names.whistle, 2, `${kind}: whistle on go and on time-up only (got ${names.whistle})`);
    for (const n of expect[kind]) assert(names[n] > 0, `${kind}: ${n} played (${JSON.stringify(names)})`);
    const medal = act.getResult().medal;
    assert(e._stingers.has(medal === 'none' ? 'medal-none' : `medal-${medal}`), `${kind}: medal jingle for ${medal}`);
    assert.equal(e.currentMusic, null, `${kind}: the groove stopped at the end`);
    for (const t of types) assert(t === 'target-expire' || trainSoundFor(t), `${kind}: event type "${t}" has a sound`);
    e.dispose();
  }
});

function trainSoundFor(type) {
  return trainEventCues({ type }).some((c) => c.type === 'sfx');
}

// Repair round requests (combat R2, platform R5), applied by the integrator.
test('audio engine: the counter-ready cue plays only for a fresh dodge (a held posture opens no counter window, R2)', () => {
  const bus = new EventBus();
  const { e } = engineWith({ extra: { bus } });
  const ready = () => e.log.filter((l) => l.name === 'counter-ready').length;
  bus.emit(Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'left', kind: 'straight', counterWindowMs: 0, how: 'lean', fresh: false });
  assert.equal(ready(), 0, 'held posture: whoosh only, no counter cue');
  assert(e.log.some((l) => l.name === 'dodge'), 'the dodge whoosh still plays');
  bus.emit(Ev.MATCH_DODGE, { attacker: 'p2', defender: 'p1', hand: 'right', kind: 'hook', counterWindowMs: 600, how: 'duck', fresh: true });
  assert.equal(ready(), 1, 'fresh dodge: the counter cue');
  e.dispose();
});

test('audio engine: the announcer prefers an on-device voice over an online one (R5)', () => {
  const sp = fakeSpeech({ voices: [
    { name: 'Google UK English Male', lang: 'en-GB', localService: false },
    { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
  ] });
  const { e } = engineWith({ speech: sp.speech });
  e.say('Round one!');
  assert.equal(sp.spoken[0].voice.name, 'Microsoft David - English (United States)', 'the local voice, not the online one');
  e.dispose();
  const only = fakeSpeech({ voices: [{ name: 'Google UK English Male', lang: 'en-GB', localService: false }] });
  const { e: e2 } = engineWith({ speech: only.speech });
  e2.say('Fight!');
  assert.equal(only.spoken[0].voice.name, 'Google UK English Male', 'no local English voice: the online one is still used');
  e2.dispose();
});
