// Regression tests of the "recog" round (real-player feedback: missed jabs / hooks, uppercuts that never register, lag,
// frame rate): R1 the picture's dip-less uppercut, R2 the early decision, R3 frame-rate independence (60 fps used,
// dropped frames, 15 fps scoops), R4 lag-compensated display values, R5 the 'real-like' synthetic preset, plus the
// facing grace and the dodge "outpace" rule the real-like preset needed. Noise 1 = the generator's default (the bench's
// headline); 'real-like' = SYNTH_PRESETS['real-like'] (what four real MediaPipe clips measured like).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions, hashSeed, SYNTH_PRESETS, SYNTH_DEFAULTS, withPreset } from '../../src/input/synthetic.js';
import { LM } from '../../src/core/types.js';

function run(o, steps, tuning) {
  const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return { ev, truth, rec, frames };
}
const hitOf = (ev, p) => ev.find((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const noDip = (post, i) => [{ action: post, ms: 1300 }, { action: i % 2 ? 'uppercut-left' : 'uppercut-right', dip: false, ms: 1100 }, { action: post, ms: 600 },
  { action: i % 2 ? 'uppercut-right' : 'uppercut-left', dip: false, ms: 1100 }, { action: post, ms: 800 }];

// ── R5 ──
test('R5 synthetic: the new options leave the default generator exactly as it was; presets apply on top', () => {
  // fingerprint of six default players through a step list (frames, every landmark, the player options)
  const NEW = ['frameDrop2Rate', 'imageNoiseRho', 'worldNoiseRho', 'zNoiseRho', 'handLagMs', 'punchYawGain', 'punchShiftM'];
  const fingerprint = (pre, acts) => {
    let h = 0;
    for (let i = 0; i < 6; i++) {
      const o = randomPlayerOptions(9100 + i);
      const { frames } = makeSyntheticPlayer(o).run(sequence([...pre, ...acts.map((a) => (typeof a === 'string' ? { action: a, ms: 700 } : a))]));
      for (const f of frames) {
        h = hashSeed(h, Math.round(f.t * 1000));
        const p = f.players[0];
        if (!p) { h = hashSeed(h, 'null'); continue; }
        for (const l of p.image) h = hashSeed(h, Math.round(l.x * 1e6), Math.round(l.y * 1e6), Math.round(l.visibility * 1e4));
        for (const l of p.world) h = hashSeed(h, Math.round(l.z * 1e6));
      }
      h = hashSeed(h, JSON.stringify(Object.keys(o).sort().filter((k) => !NEW.includes(k)).map((k) => [k, o[k]])));
    }
    return h;
  };
  // every kind of action of the default players: BASE's frames (the player options in the hash name the lead hand,
  // lead: 'left'|'right' — one draw per player, so every seed gives the same player)
  const acts = ['jab-left', 'cross', 'hook-right', 'uppercut-left', 'body-right', 'lean-left', 'duck', 'wave', 'point', 'pull-back', 'scratch-face', 'guard-low', 'walk-away'];
  assert.equal(fingerprint([{ action: 'guard-high', ms: 900 }], acts), 3579520069, 'default synthetic output changed');
  // …EXCEPT the dip:false uppercuts, which R1 changed on purpose (from a high guard the fist now rises ≥ 12 cm, from the
  // stance it starts at the chest; the verification round found the list above does not cover them): pinned to the
  // current generator so any further change shows
  const nd = (post) => [{ action: 'uppercut-left', dip: false, ms: 1100 }, { action: post, ms: 600 }, { action: 'uppercut-right', dip: false, ms: 1100 }];
  assert.equal(fingerprint([{ action: 'guard-high', ms: 1300 }], nd('guard-high')), 436252905, 'dip:false uppercuts from a high guard changed');
  assert.equal(fingerprint([{ action: 'idle', ms: 1300 }], nd('idle')), 2282114814, 'dip:false uppercuts from the stance changed');
  for (const k of ['imageNoiseRho', 'worldNoiseRho', 'zNoiseRho']) assert(SYNTH_DEFAULTS[k] > 0, k);
  assert.equal(SYNTH_DEFAULTS.frameDrop2Rate, 0); assert.equal(SYNTH_DEFAULTS.punchShiftM, 0); assert.equal(SYNTH_DEFAULTS.punchYawGain, 1); assert.equal(SYNTH_DEFAULTS.handLagMs, 0);
  // presets: explicit options win; a preset player keeps the default player's body and camera draws
  const P = withPreset({ preset: 'real-like', zNoise: 0.02 });
  assert(P.zNoise === 0.02 && P.imageNoise === SYNTH_PRESETS['real-like'].imageNoise && P.preset === 'real-like');
  assert.throws(() => withPreset({ preset: 'nope' }));
  const a = randomPlayerOptions(7100), b = randomPlayerOptions(7100, { preset: 'real-like' });
  for (const k of ['distance', 'cameraHeight', 'focal', 'punchMs', 'lead', 'fps']) assert.equal(a[k], b[k], k);
  assert(b.zScale > 0.85 && b.zNoise < SYNTH_DEFAULTS.zNoise / 1.5 && b.punchShiftM > 0, JSON.stringify({ zScale: b.zScale, zNoise: b.zNoise }));
});

test('R5 real-like: depth jitter in the measured real range, much less image jitter, the head moves with the punch', () => {
  const depth = [];
  for (let i = 0; i < 6; i++) {
    const { rec } = run(randomPlayerOptions(8100 + i, { preset: 'real-like' }), [{ action: 'guard-high', ms: 2500 }]);
    depth.push(rec.depthNoiseMm);
  }
  // real MediaPipe (VIDEO mode, four clips): median |Δz| of still joints 2–10 mm; the default generator ≈ 20
  assert(depth.every((d) => d >= 1.5 && d <= 12), `real-like depth noise ${depth.join(', ')} mm`);
  // the head during a cross (image units of the shoulder width): real punches move it ≈ 0.15–0.35 SW
  const headTravel = (preset) => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const o = { ...randomPlayerOptions(5100 + i, preset ? { preset } : {}), noise: 0 };
      const sp = makeSyntheticPlayer(o);
      const seq = sequence([{ action: 'guard-high', ms: 1000 }, { action: 'cross', ms: 900 }]);
      const p0 = sp.pose(990, seq), p1 = sp.pose(1000 + o.punchMs, seq);
      const sw = Math.hypot(p0.image[LM.LEFT_SHOULDER].x - p0.image[LM.RIGHT_SHOULDER].x, p0.image[LM.LEFT_SHOULDER].y - p0.image[LM.RIGHT_SHOULDER].y);
      out.push(Math.hypot(p1.image[LM.NOSE].x - p0.image[LM.NOSE].x, p1.image[LM.NOSE].y - p0.image[LM.NOSE].y) / sw);
    }
    return median(out);
  };
  const hd = headTravel(null), hr = headTravel('real-like');
  assert(hr > 2 * hd && hr > 0.12, `head travel during a cross: default ${hd.toFixed(3)} SW, real-like ${hr.toFixed(3)} SW`);
  // double dropped frames (a loaded machine): gaps of three frame intervals appear only when asked for
  const sp = makeSyntheticPlayer({ seed: 4, fps: 30, frameDrop2Rate: 0.2, frameDropRate: 0 });
  const ts = sp.frameTimes(6000), gaps = ts.slice(1).map((t, i) => t - ts[i]);
  assert(gaps.some((g) => g > 85) && !makeSyntheticPlayer({ seed: 4, fps: 30, frameDropRate: 0 }).frameTimes(6000).slice(1).some((t, i, a) => t - (i ? a[i - 1] : 0) > 85 && i > 0), 'triple gaps');
});

// ── R1 ──
test('R1: dip-less uppercuts (from the stance and from a high guard) register as uppercuts with untrusted depth', () => {
  const tally = { idle: [0, 0], 'guard-high': [0, 0] };
  let trusted = 0;
  for (const post of ['idle', 'guard-high']) {
    for (let i = 0; i < 12; i++) {
      const { ev, truth, rec } = run(randomPlayerOptions(5300 + i, {}), noDip(post, i));
      if (rec.depthTrusted) trusted++;
      for (const p of truth.punches) { tally[post][1]++; const e = hitOf(ev, p); if (e && e.punch.kind === 'uppercut') tally[post][0]++; }
    }
  }
  const all = (tally.idle[0] + tally['guard-high'][0]) / (tally.idle[1] + tally['guard-high'][1]);
  console.log(`      dip-less uppercuts as uppercuts: stance ${tally.idle.join('/')}, high guard ${tally['guard-high'].join('/')} (depth trusted in ${trusted}/24 runs; before this round 0/48)`);
  assert(trusted === 0, 'the default noise must leave depth untrusted (the picture path is what is tested)');
  assert(all >= 0.65 && tally.idle[0] / tally.idle[1] >= 0.65, JSON.stringify(tally));
});

test('R1: no uppercuts from hands going to the face, raising the guard, waving, the pause or pointing', () => {
  const S = {
    glasses: [{ action: 'idle', ms: 1500 }, { action: 'adjust-glasses', hand: 'right', ms: 1500 }, { action: 'idle', ms: 800 }],
    scratch: [{ action: 'idle', ms: 1500 }, { action: 'scratch-face', hand: 'left', ms: 2400 }, { action: 'idle', ms: 800 }],
    'raise guard': [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1200 }, { action: 'idle', ms: 1200 }, { action: 'guard-high', ms: 1200 }],
    'wave (face)': [{ action: 'idle', ms: 1500 }, { action: 'wave', hand: 'left', height: 'face', ms: 3000 }, { action: 'idle', ms: 800 }],
    pause: [{ action: 'idle', ms: 1500 }, { action: 'pause', ms: 2000 }, { action: 'idle', ms: 1000 }],
    point: [{ action: 'idle', ms: 1500 }, { action: 'point', hand: 'right', ms: 3000 }, { action: 'idle', ms: 800 }],
  };
  const rows = [];
  let ups = 0, upsOff = 0;
  for (const [name, steps] of Object.entries(S)) {
    let n = 0, nOff = 0;
    for (let i = 0; i < 16; i++) {
      const o = randomPlayerOptions(4000 + i, {});
      n += run(o, steps).ev.filter((e) => e.punch.kind === 'uppercut').length;
      nOff += run(o, steps, { upImgRise: 99 }).ev.filter((e) => e.punch.kind === 'uppercut').length;   // the picture path off
    }
    rows.push(`${name} ${n} (path off ${nOff})`);
    ups += n; upsOff += nOff;
  }
  console.log(`      uppercut events in 16 players each: ${rows.join(' · ')}`);
  assert(ups <= upsOff + 2, `the picture path adds uppercuts on non-punches: ${rows.join(', ')}`);
});

// ── R2 ──
test('R2: strong straights and hooks fire before their drive peaks; hands going up never take that shortcut', () => {
  const lat = { on: [], off: [] };
  for (let i = 0; i < 20; i++) {
    const o = randomPlayerOptions(6100 + i, {});
    const steps = [{ action: i % 2 ? 'idle' : 'guard-high', ms: 1400 }];
    for (const a of ['jab-left', 'hook-right', 'jab-right', 'hook-left', 'cross']) steps.push({ action: a, ms: 900 }, { action: i % 2 ? 'idle' : 'guard-high', ms: 500 });
    for (const [k, tun] of [['on', {}], ['off', { earlyMinPeak: 0 }]]) {
      const { ev, truth } = run(o, steps, tun);
      for (const p of truth.punches) { const e = hitOf(ev, p); if (e) lat[k].push(e.t - (p.tStart + p.tPeak) / 2); }
    }
  }
  const on = median(lat.on), off = median(lat.off);
  console.log(`      peak wrist speed → fire p50: early decision ${on.toFixed(0)} ms, off ${off.toFixed(0)} ms (detected ${lat.on.length} / ${lat.off.length})`);
  assert(on <= off - 5 && lat.on.length >= lat.off.length - 1, `${on} vs ${off}`);
  let extra = 0;
  for (const action of ['raise-hand', 'wave', 'point']) {
    for (let i = 0; i < 12; i++) {
      const o = randomPlayerOptions(4400 + i, {});
      const steps = [{ action: 'idle', ms: 1500 }, { action, hand: 'right', ms: 2400 }, { action: 'idle', ms: 800 }];
      extra += run(o, steps).ev.length - run(o, steps, { earlyMinPeak: 0 }).ev.length;
    }
  }
  assert(extra <= 0, `the early decision fired on hands going up: +${extra}`);
});

// ── R3 ──
test('R3: a 60 fps camera is used (lower latency, same detection); single and double dropped frames keep the strokes', () => {
  const steps = [{ action: 'guard-high', ms: 1300 }];
  for (const a of ['jab-left', 'cross', 'hook-left', 'hook-right', 'uppercut-right', 'body-left']) steps.push({ action: a, ms: 1100 }, { action: 'guard-high', ms: 500 });
  const measure = (syn) => {
    let n = 0, hit = 0; const lat = [];
    for (let i = 0; i < 16; i++) {
      const { ev, truth } = run(randomPlayerOptions(7100 + i, syn), steps);
      for (const p of truth.punches) { n++; const e = hitOf(ev, p); if (e) { hit++; lat.push(e.t - (p.tStart + p.tPeak) / 2); } }
    }
    return { det: hit / n, lat: median(lat) };
  };
  // (real-like noise: the default generator's extra jitter hides the 60 fps gain — see the bench's FPS rows)
  const R = { preset: 'real-like' };
  const f30 = measure({ ...R, fps: 30 }), f60 = measure({ ...R, fps: 60 }), d1 = measure({ ...R, fps: 30, frameDropRate: 0.15 }), d2 = measure({ ...R, fps: 30, frameDrop2Rate: 0.1 });
  console.log(`      30 fps ${(100 * f30.det).toFixed(0)}% ${f30.lat.toFixed(0)} ms · 60 fps ${(100 * f60.det).toFixed(0)}% ${f60.lat.toFixed(0)} ms · 15 % single drops ${(100 * d1.det).toFixed(0)}% · 10 % double drops ${(100 * d2.det).toFixed(0)}%`);
  assert(f60.det >= f30.det - 0.05 && f60.lat <= f30.lat - 4, JSON.stringify({ f30, f60 }));
  assert(d1.det >= f30.det - 0.06 && d2.det >= f30.det - 0.06, JSON.stringify({ d1, d2 }));
});

test('R3: a 15 fps uppercut scoop from a high guard is not mistaken for a tracking glitch', () => {
  let glitch = 0, base = 0;
  for (let i = 0; i < 16; i++) {
    const o = randomPlayerOptions(7300 + i, { fps: 15 });
    const steps = [{ action: 'guard-high', ms: 1300 }, { action: 'uppercut-left', ms: 1100 }, { action: 'guard-high', ms: 500 }, { action: 'uppercut-right', ms: 1100 }, { action: 'guard-high', ms: 600 }];
    for (const [tun, k] of [[{}, 'lane'], [{ glitchSpikeSpeedSW: 0 }, 'off']]) {
      const { rec } = run(o, steps, tun);
      const n = ['left', 'right'].reduce((s, h) => s + rec.hands[h].rejects.filter((r) => r.reason === 'glitch').length, 0);
      if (k === 'lane') glitch += n; else base += n;
    }
  }
  console.log(`      15 fps uppercuts from a high guard rejected as glitches: ${glitch} (spike speed limit off: ${base})`);
  assert(glitch <= base / 2, `glitch rejections at 15 fps: ${glitch} (speed limit off: ${base})`);
});

// ── R4 ──
function slideLag(tuning, what, v) {
  const sp = makeSyntheticPlayer({ seed: 3, noise: 0, distance: 2.0, cameraHeight: 1.2 });
  const base = sp.pose(1200, 'guard-high');
  const a = base.aspect;
  const sw = Math.hypot(base.image[LM.LEFT_SHOULDER].x - base.image[LM.RIGHT_SHOULDER].x, (base.image[LM.LEFT_SHOULDER].y - base.image[LM.RIGHT_SHOULDER].y) / a);
  const pts = what === 'wrist' ? [15, 17, 19, 21] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const rec = new GestureRecognizer({ tuning });
  let ref = null; const lags = [];
  for (let t = 0; t <= 4700; t += 33.3) {
    const s = Math.max(0, Math.min(0.6, (t - 4000) / 1000));
    const image = base.image.map((l, i) => (pts.includes(i) ? { ...l, x: l.x + v * sw * s } : { ...l }));
    const { control } = rec.update({ ...base, image }, t);
    const out = what === 'wrist' ? control.hands.left.x : control.head.x;
    if (t > 3960 && t < 4000) ref = out;
    if (t > 4300 && t < 4600) lags.push((v * s - -(out - ref)) / v * 1000);
  }
  return lags.reduce((s, x) => s + x, 0) / lags.length;
}

test('R4: the gloves and the lean follow a steady slide with the filters\' lag added back; the punch logic is untouched', () => {
  // (V2-10: the gloves' lead is OFF by default since the verification round — it shook resting gloves on noisy real clips and
  // the render's glove springs are being re-tuned for lag; the mechanism stays, switched on here by displayLead 1)
  assert(DEFAULT_TUNING.displayLead === 0 && DEFAULT_TUNING.displayReachLeadMs === 0 && DEFAULT_TUNING.leanLead > 0);
  const ON = { displayLead: 1, displayReachLeadMs: 25 };
  const w = slideLag(ON, 'wrist', 1), wOff = slideLag({}, 'wrist', 1);
  const h = slideLag({}, 'head', 1), hOff = slideLag({ leanLead: 0 }, 'head', 1);
  console.log(`      1 SW/s slide: glove lag ${w.toFixed(0)} ms (lead off ${wOff.toFixed(0)}), head lag ${h.toFixed(0)} ms (off ${hOff.toFixed(0)})`);
  assert(Math.abs(w) <= 12 && wOff >= 18, `glove ${w} / ${wOff}`);
  assert(Math.abs(h) <= 12 && hOff >= 18, `head ${h} / ${hOff}`);
  // the display lead never reaches the punch logic: the same events with it on and off
  for (let i = 0; i < 6; i++) {
    const o = randomPlayerOptions(7100 + i, {});
    const steps = [{ action: 'guard-high', ms: 1300 }, { action: 'jab-left', ms: 900 }, { action: 'hook-right', ms: 900 }, { action: 'guard-low', ms: 900 }, { action: 'body-left', ms: 900 }, { action: 'idle', ms: 700 }];
    const a = run(o, steps, ON).ev.map((e) => `${e.t}:${e.punch.hand}:${e.punch.kind}`).join(',');
    const b = run(o, steps).ev.map((e) => `${e.t}:${e.punch.hand}:${e.punch.kind}`).join(',');
    assert.equal(a, b, `player ${i}`);
  }
  // a still hand gets no visible extra shake at real-like noise (frame-to-frame step of HandState.x)
  const step = (tun) => {
    const steps = [];
    for (let i = 0; i < 6; i++) {
      const o = randomPlayerOptions(4400 + i, { preset: 'real-like' });
      const { frames } = makeSyntheticPlayer({ ...o, bounce: 0 }).run(sequence([{ action: 'guard-high', ms: 5000 }]));
      const rec = new GestureRecognizer({ tuning: tun });
      let prev = null;
      for (const fr of frames) { const x = rec.update(fr.players[0], fr.t).control.hands.left.x; if (fr.t > 2500 && prev !== null) steps.push(Math.abs(x - prev)); prev = x; }
    }
    return median(steps);
  };
  const s1 = step(ON), s0 = step({});
  assert(s1 <= s0 * 1.2 + 1e-4, `still-hand frame step ${s1} vs ${s0}`);
});

// ── the real-like gates ──
test('facing grace and the dodge outpace rule: real-like punches that turn the shoulders and carry the head register; walking away does not', () => {
  let n = 0, hit = 0;
  for (let i = 0; i < 10; i++) {
    const o = randomPlayerOptions(7100 + i, { preset: 'real-like' });
    const { ev, truth } = run(o, [{ action: 'guard-high', ms: 1400 }, { action: 'hook-left', ms: 1000 }, { action: 'guard-high', ms: 500 }, { action: 'hook-right', ms: 1000 }, { action: 'guard-high', ms: 500 }, { action: 'cross', ms: 1000 }, { action: 'guard-high', ms: 600 }]);
    for (const p of truth.punches) { n++; if (hitOf(ev, p)) hit++; }
  }
  console.log(`      real-like hooks + crosses: ${hit}/${n} (before this round ≈ 1 in 2 hooks was lost as "not facing")`);
  assert(hit / n >= 0.85, `${hit}/${n}`);
  let fired = 0;
  for (let i = 0; i < 12; i++) {
    for (const steps of [[{ action: 'idle', ms: 1500 }, { action: 'walk-away', ms: 3000 }], [{ action: 'guard-high', ms: 1500 }, { action: 'twist-left', ms: 900 }, { action: 'twist-right', ms: 900 }, { action: 'guard-high', ms: 800 }]]) {
      if (run(randomPlayerOptions(4400 + i, { preset: 'real-like' }), steps).ev.length) fired++;
    }
  }
  assert(fired <= 1, `walking away / twisting fired in ${fired}/24 trials`);
  assert(DEFAULT_TUNING.facingPunchGraceMs > DEFAULT_TUNING.facingGraceMs && DEFAULT_TUNING.dodgeOutpace > 0);
});

test('one-euro (R3/R4): minDerivDtMs takes the speed over ≥ that span (a 60 fps feed is smoothed like 30 fps); lagMs is the ramp lag', async () => {
  const { OneEuroVector } = await import('../../src/input/one-euro.js');
  // white jitter at 60 fps: with the speed over ≥ 24 ms the cut-off opens less at rest
  const jitter = (minDerivDtMs) => {
    const f = new OneEuroVector(1, { minCutoff: 2.2, beta: 20, dCutoff: 2.5, minDerivDtMs });
    let s = 7, sum = 0, n = 0;
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let t = 0; t < 4000; t += 1000 / 60) { const v = f.filter([0.01 * r()], t)[0]; if (t > 500) { sum += v * v; n++; } }
    return Math.sqrt(sum / n);
  };
  const j0 = jitter(0), j24 = jitter(24);
  assert(j24 < j0, `rest jitter ${j24} vs ${j0}`);
  // at ≤ 41 fps every sample is ≥ 24 ms apart: identical to the plain filter
  const a = new OneEuroVector(2, { minCutoff: 1, beta: 0.5 }), b = new OneEuroVector(2, { minCutoff: 1, beta: 0.5, minDerivDtMs: 24 });
  for (let t = 0; t < 1000; t += 33.3) { const x = [Math.sin(t / 90), t / 500]; const va = a.filter(x, t).slice(), vb = b.filter(x, t).slice(); assert(Math.abs(va[0] - vb[0]) < 1e-12 && Math.abs(va[1] - vb[1]) < 1e-12, `t ${t}`); }
  // a steady ramp trails by velocity × lagMs (the first-order low-pass's steady state)
  const f = new OneEuroVector(1, { minCutoff: 3, beta: 0, dCutoff: 2 });
  let out = 0, last = 0;
  for (let t = 0; t <= 3000; t += 16.7) { out = f.filter([t / 1000], t)[0]; last = t; }
  const lag = (last / 1000 - out) * 1000;   // ms behind a 1 unit/s ramp
  assert(Math.abs(lag - f.lagMs) < 8, `ramp lag ${lag.toFixed(1)} ms vs lagMs ${f.lagMs.toFixed(1)}`);
});
