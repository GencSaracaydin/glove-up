// Recorder / ReplaySource: compact JSON round trip (4 decimals), loading, real-time replay.
import { test, assert, approx } from '../harness.mjs';
import { Recorder, ReplaySource, encodeRecording, decodeRecording, RECORDING_FORMAT } from '../../src/input/recorder.js';

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randPose(r) {
  const image = Array.from({ length: 33 }, () => ({ x: r(), y: r(), z: r() - 0.5, visibility: r(), presence: r() }));
  const world = Array.from({ length: 33 }, () => ({ x: r() - 0.5, y: r() - 0.5, z: r() - 0.5, visibility: r() }));
  return { image, world, score: r() };
}
function makeFrames(n, { start = 1000, people = 1, seed = 1 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    t: start + i * 33.3333, width: 640, height: 480,
    players: Array.from({ length: people }, () => randPose(r)),
  }));
}

test('recorder: round trip keeps landmarks to 4 decimals, timing, size and scores', () => {
  const frames = makeFrames(20, { people: 2 });
  frames[7] = { ...frames[7], width: 1280, height: 720 }; // resolution change mid-take
  const json = encodeRecording({ frames, meta: { model: 'full' } });
  const rec = decodeRecording(json);
  assert(rec.format === RECORDING_FORMAT && rec.width === 640 && rec.height === 480 && rec.meta.model === 'full');
  assert(rec.frames.length === 20);
  approx(rec.frames[0].t, 0, 1e-9, 't relative to the first frame');
  approx(rec.frames[19].t, 19 * 33.3333, 0.06);
  assert(rec.frames[7].width === 1280 && rec.frames[7].height === 720 && rec.frames[8].width === 640);
  for (let f = 0; f < 20; f++) {
    for (let p = 0; p < 2; p++) {
      const a = frames[f].players[p], b = rec.frames[f].players[p];
      approx(b.score, a.score, 5.1e-5);
      for (let i = 0; i < 33; i++) {
        for (const k of ['x', 'y', 'z']) approx(b.image[i][k], a.image[i][k], 5.1e-5, `image ${f}/${p}/${i}.${k}`);
        approx(b.image[i].visibility, a.image[i].visibility, 5.1e-5);
        for (const k of ['x', 'y', 'z']) approx(b.world[i][k], a.world[i][k], 5.1e-5, `world ${f}/${p}/${i}.${k}`);
      }
    }
  }
});

test('recorder: JSON is compact (≤4 decimals, flat arrays)', () => {
  const json = encodeRecording({ frames: makeFrames(30) });
  const decimals = (json.match(/\d+\.(\d+)/g) || []).map((s) => s.split('.')[1].length);
  assert(decimals.length > 0 && Math.max(...decimals) <= 4, `max decimals ${Math.max(...decimals)}`);
  const perFrame = json.length / 30;
  assert(perFrame < 2600, `~${Math.round(perFrame)} bytes per single-person frame`);
});

test('recorder: start/push/stop records raw frames with relative times; skips non-increasing t', () => {
  const r = new Recorder();
  const frames = makeFrames(10);
  r.push(frames[0]);
  assert(r.frameCount === 0, 'not recording yet');
  r.start({ who: 'test' });
  for (const f of frames) r.push(f);
  r.push({ ...frames[9] }); // duplicate timestamp
  r.push(null);
  assert(r.recording && r.frameCount === 10);
  approx(r.durationMs, 9 * 33.3333, 1e-6);
  const rec = r.stop();
  assert(!r.recording && rec.frames.length === 10 && rec.frames[0].t === 0 && rec.meta.who === 'test');
  // copies, not references
  frames[0].players[0].image[0].x = 42;
  assert(r.frames[0].players[0].image[0].x !== 42);
  const back = decodeRecording(r.toJSON());
  assert(back.frames.length === 10);
});

test('recorder: maxFrames truncates and stops recording', () => {
  const r = new Recorder({ maxFrames: 5 });
  r.start();
  for (const f of makeFrames(8)) r.push(f);
  assert(r.frameCount === 5 && !r.recording && r.truncated);
  assert(r.toRecording().meta.truncated === true);
});

test('recorder: load from JSON text and object; readable errors for garbage', async () => {
  const json = encodeRecording({ frames: makeFrames(3) });
  assert((await Recorder.load(json)).frames.length === 3);
  assert((await Recorder.load(JSON.parse(json))).frames.length === 3);
  if (typeof Blob !== 'undefined') assert((await Recorder.load(new Blob([json]))).frames.length === 3);
  for (const bad of ['{nope', '{"format":"other"}', JSON.stringify({ format: RECORDING_FORMAT, version: 1, frames: [[0, [{ s: 1, i: [1, 2, 3] }]]] })]) {
    let msg = '';
    try { await Recorder.load(bad); } catch (e) { msg = e.message; }
    assert(/pose recording|bad pose/i.test(msg), `unclear error: ${msg}`);
  }
});

test('replay: yields frames in real time, re-timestamped into the caller clock', () => {
  const rec = decodeRecording(encodeRecording({ frames: makeFrames(10) }));
  const src = new ReplaySource(rec);
  const now0 = 50000;
  assert(src.next(now0).length === 1, 'first frame immediately');
  assert(src.next(now0 + 10).length === 0);
  const got = src.next(now0 + 100);
  assert(got.length === 3, `got ${got.length}`);
  approx(got[0].t, now0 + 33.3333, 0.06);
  const rest = src.next(now0 + 400);
  assert(rest.length === 6 && src.done, `rest ${rest.length}`);
  assert(src.next(now0 + 2000).length === 0);
});

test('replay: loop keeps timestamps strictly increasing across laps', () => {
  const rec = decodeRecording(encodeRecording({ frames: makeFrames(5) }));
  const src = new ReplaySource(rec, { loop: true });
  const all = [];
  for (let t = 0; t <= 1000; t += 16) all.push(...src.next(t));
  assert(all.length > 20, `got ${all.length}`);
  for (let i = 1; i < all.length; i++) assert(all[i].t > all[i - 1].t, 'monotonic');
  assert(!src.done);
});

test('replay: a stalled caller skips old frames instead of flooding', () => {
  const rec = decodeRecording(encodeRecording({ frames: makeFrames(300) })); // 10 s
  const src = new ReplaySource(rec);
  src.next(0);
  const burst = src.next(8000);
  assert(burst.length < 30, `flooded with ${burst.length} frames`);
});

test('replay: speed scales playback', () => {
  const rec = decodeRecording(encodeRecording({ frames: makeFrames(31) })); // 1 s
  const src = new ReplaySource(rec, { speed: 2 });
  src.next(0);
  src.next(400);
  src.next(520);
  assert(src.done, 'double speed finishes in ~0.5 s');
});
