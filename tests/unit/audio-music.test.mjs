// Audio: procedural music — theory helpers, step grid / swing math, song generation, stingers,
// and the lookahead scheduler (fake timers). All pure; no AudioContext needed.
import { test, assert, approx } from '../harness.mjs';
import {
  parseChord, voiceChord, bassRoot, bassToken, parsePattern, stepOffset, stepDur, barDuration, songBar,
  stingerLength, eventsInWindow, SONGS, STINGERS, MUSIC_NAMES, LookaheadScheduler, isLoop, isStinger,
} from '../../src/audio/music.js';
import { INSTR, mulberry32 } from '../../src/audio/synth.js';

const pcs = (notes) => notes.map((m) => ((m % 12) + 12) % 12);

test('music: chord symbols parse to pitch classes', () => {
  assert.deepEqual(parseChord('F').pcs, [5, 9, 0]);
  assert.deepEqual(parseChord('Dm7').pcs, [2, 5, 9, 0]);
  assert.deepEqual(parseChord('Bb').pcs, [10, 2, 5]);
  assert.deepEqual(parseChord('C7').pcs, [0, 4, 7, 10]);
  assert.deepEqual(parseChord('Dmaj7').pcs, [2, 6, 9, 1]);
  assert.deepEqual(parseChord('F#m').pcs, [6, 9, 1]);
  assert.equal(parseChord('C/E').bass, 4);
  assert.throws(() => parseChord('H7'));
  assert.throws(() => parseChord('Cwhatever'));
});

test('music: close voicings stay in range and only use chord tones', () => {
  const v = voiceChord(parseChord('Dm7'), { low: 57, high: 74, max: 4 });
  assert.deepEqual(v, [57, 60, 62, 65]);
  for (const sym of ['F', 'Bb', 'C7', 'Am7', 'Gm7', 'Em7', 'A7', 'Dmaj7', 'Bm7']) {
    const ch = parseChord(sym);
    const notes = voiceChord(ch, { low: 58, high: 74, max: 4 });
    assert(notes.length >= 3 && notes.every((m) => m >= 58 && m <= 74), sym);
    assert(pcs(notes).every((pc) => ch.pcs.includes(pc)), sym);
  }
  assert.equal(bassRoot(parseChord('F'), 36), 41);
  assert.equal(bassRoot(parseChord('C'), 36), 36);
  assert.equal(bassRoot(parseChord('Bb'), 36), 46);
  const am = parseChord('Am7');
  assert.equal(bassToken('3', 45, am), 48);
  assert.equal(bassToken('7', 45, am), 55);
  assert.equal(bassToken('O', 45, am), 57);
  assert.equal(bassToken('5', 45, am), 52);
});

test('music: drum patterns and the swung step grid', () => {
  assert.deepEqual(parsePattern('X.x.o.g.'), [{ step: 0, vel: 1 }, { step: 2, vel: 0.78 }, { step: 4, vel: 0.42 }, { step: 6, vel: 0.22 }]);
  const def = { bpm: 120, stepsPerBeat: 4, beatsPerBar: 4, swing: 0.2 };
  approx(stepDur(def), 0.125, 1e-12);
  approx(barDuration(def), 2, 1e-12);
  approx(stepOffset(0, def), 0, 1e-12);
  approx(stepOffset(1, def), 0.125 + 0.2 * 0.125, 1e-12, 'odd steps are swung late');
  approx(stepOffset(2, def), 0.25, 1e-12, 'even steps stay on the grid');
  approx(stepOffset(15, def), 15 * 0.125 + 0.025, 1e-12);
  assert(stepOffset(15, { ...def, swing: 0.5 }) < barDuration(def), 'swing never pushes a note into the next bar');
  approx(stepOffset(3, { ...def, swing: 0 }), 0.375, 1e-12);
});

test('music: song bars are deterministic, sorted, in-bar and playable', () => {
  for (const [name, def] of Object.entries(SONGS)) {
    const bd = barDuration(def);
    for (let b = 0; b < (def.period || def.bars); b++) {
      const a = songBar(def, b), again = songBar(def, b);
      assert.equal(a, again, 'cached');
      assert(a.length > 8, `${name} bar ${b} has content`);
      for (let i = 0; i < a.length; i++) {
        const e = a[i];
        assert(INSTR[e.inst], `${name}: unknown instrument ${e.inst}`);
        assert(e.t >= 0 && e.t < bd, `${name} bar ${b}: event inside the bar`);
        assert(e.dur > 0 && Number.isFinite(e.dur));
        assert(e.vel > 0 && e.vel <= 1.2);
        if (i) assert(a[i - 1].t <= e.t, 'sorted');
        for (const m of e.notes || (e.midi !== undefined ? [e.midi] : [])) assert(Number.isInteger(m) && m >= 24 && m <= 108, `${name}: midi ${m} in range`);
      }
    }
    // loops repeat with the period
    assert.equal(songBar(def, (def.period || def.bars) + 3), songBar(def, 3));
  }
});

test('music: the menu tune is in F major, the training tune in D major; bass follows the chords', () => {
  const inKey = (scale) => (m) => scale.includes(((m % 12) + 12) % 12);
  const F = [5, 7, 9, 10, 0, 2, 4], Dm = [2, 4, 6, 7, 9, 11, 1];
  for (let b = 0; b < 32; b++) {
    for (const e of songBar(SONGS.menu, b)) if (e.inst === 'lead' || e.inst === 'marimba') assert(inKey(F)(e.midi), `menu bar ${b}: ${e.midi}`);
    const chord = parseChord(SONGS.menu.chords[b % 16]);
    const firstBass = songBar(SONGS.menu, b).find((e) => e.inst === 'bass');
    assert.equal(((firstBass.midi % 12) + 12) % 12, chord.root, `menu bar ${b}: bass starts on the root`);
  }
  for (let b = 0; b < 16; b++) for (const e of songBar(SONGS.training, b)) if (e.inst === 'whistle' || e.inst === 'marimba') assert(inKey(Dm)(e.midi), `training bar ${b}: ${e.midi}`);
  // second pass of the menu loop varies the tune's instrument
  assert(songBar(SONGS.menu, 0).some((e) => e.inst === 'lead'));
  assert(songBar(SONGS.menu, 16).some((e) => e.inst === 'marimba') && !songBar(SONGS.menu, 16).some((e) => e.inst === 'lead'));
  approx(60 / SONGS.menu.bpm * 4, barDuration(SONGS.menu), 1e-12);
  assert.equal(SONGS.menu.bpm, 118);
});

test('music: stingers are finite, short and start on time', () => {
  const maxLen = { victory: 6, defeat: 6, draw: 3.5, 'between-rounds': 4, ko: 4, pro: 3.5 };
  for (const [name, def] of Object.entries(STINGERS)) {
    const len = stingerLength(def);
    assert(Number.isFinite(len) && len > 0.4, `${name} length ${len}`);
    assert(len <= (maxLen[name] ?? 3.2), `${name} is short enough (${len.toFixed(2)} s)`);
    const first = songBar(def, 0)[0];
    assert(first && first.t === 0, `${name} starts immediately`);
    assert.deepEqual(songBar(def, def.bars), [], 'nothing after the last bar');
  }
  assert.equal(stingerLength(SONGS.menu), Infinity);
  assert(isLoop('menu') && isLoop('training') && !isLoop('victory'));
  assert(isStinger('victory') && isStinger('medal-gold') && !isStinger('menu') && !isStinger('toString'));
  assert(MUSIC_NAMES.includes('between-rounds') && MUSIC_NAMES.includes('training'));
});

test('music: scheduling windows partition the timeline (no gaps, no duplicates)', () => {
  const def = SONGS.menu, start = 0.5;
  const whole = eventsInWindow(def, start, 0, 20);
  const cuts = [0, 0.11, 0.37, 1.9, 2.03, 4.4, 7.99, 12.5, 20];
  let pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) pieces = pieces.concat(eventsInWindow(def, start, cuts[i], cuts[i + 1]));
  assert.equal(pieces.length, whole.length);
  for (let i = 0; i < whole.length; i++) approx(pieces[i].at, whole[i].at, 1e-9);
  assert(whole.every((e) => e.at >= start), 'nothing before the start');
  const st = eventsInWindow(STINGERS.victory, 1, 0, 60);
  assert(st.length > 10 && st.every((e) => e.at < 1 + stingerLength(STINGERS.victory)));
});

test('music: lookahead scheduler ticks immediately, then on its interval, and stops', () => {
  let now = 0, id = 0;
  const intervals = new Map();
  const timers = {
    setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; },
    clearInterval: (i) => intervals.delete(i),
  };
  const calls = [];
  const s = new LookaheadScheduler({ now: () => now, pump: (a, b) => calls.push([a, b]), lookahead: 0.2, intervalMs: 25, timers });
  s.start();
  assert(s.running);
  assert.deepEqual(calls, [[0, 0.2]]);
  s.start();
  assert.equal(intervals.size, 1, 'start is idempotent');
  now = 1.5;
  [...intervals.values()][0].fn();
  assert.deepEqual(calls[1], [1.5, 1.7]);
  assert.equal([...intervals.values()][0].ms, 25);
  s.stop();
  assert(!s.running && intervals.size === 0);
  now = NaN;
  s.tick();
  assert.equal(calls.length, 2, 'a broken clock schedules nothing');
});

test('music: seeded variation is reproducible', () => {
  const a = mulberry32(5), b = mulberry32(5);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const r = mulberry32(9);
  for (let i = 0; i < 1000; i++) { const x = r(); assert(x >= 0 && x < 1); }
});
