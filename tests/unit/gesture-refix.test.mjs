// Regression tests of the refix round (R-A … R-E, gesture.js header item 14): the verifier's regressions of the fix round, each
// against the same recognizer with that one rule switched off (a test fails if the rule stops working). The real-clip numbers
// (six labelled clips, the blind close-camera set) are measured with PUNCH/tools/realbench.mjs — the clips are never part of
// the repository.
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';
import { LM, PunchKind } from '../../src/core/types.js';

const hitOf = (ev, p) => ev.find((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
const clone = (frames) => frames.map((f) => ({ ...f, players: f.players.map((p) => (p ? { ...p, image: p.image.map((l) => ({ ...l })), world: p.world.map((l) => ({ ...l })) } : p)) }));
function recog(frames, tuning = {}) {
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return ev;
}
const lead = (o) => (o.lead === 'right' ? 'right' : 'left'), rear = (o) => (o.lead === 'right' ? 'left' : 'right');

// ── keyframed one-hand overlays on a synthetic player (player frame: r = toward the player's right, u = up, in shoulder widths;
//    f = metres toward the camera), as the verifier's false-punch probe drew them ──
const minJerk = (u) => { u = Math.min(1, Math.max(0, u)); return u * u * u * (10 - 15 * u + 6 * u * u); };
const HANDPTS = { left: [LM.LEFT_PINKY, LM.LEFT_INDEX, LM.LEFT_THUMB], right: [LM.RIGHT_PINKY, LM.RIGHT_INDEX, LM.RIGHT_THUMB] };
const WR = { left: LM.LEFT_WRIST, right: LM.RIGHT_WRIST }, EL = { left: LM.LEFT_ELBOW, right: LM.RIGHT_ELBOW };
function frameOf(P) {
  const a = P.aspect || 4 / 3; const I = (l) => [l.x * a, l.y];
  const sL = I(P.image[LM.LEFT_SHOULDER]), sR = I(P.image[LM.RIGHT_SHOULDER]);
  const C = [(sL[0] + sR[0]) / 2, (sL[1] + sR[1]) / 2], sw = Math.hypot(sR[0] - sL[0], sR[1] - sL[1]) || 0.1;
  const r = [(sR[0] - sL[0]) / sw, (sR[1] - sL[1]) / sw];
  const wl = (l) => [l.x, l.y, l.z]; const wL = wl(P.world[LM.LEFT_SHOULDER]), wR = wl(P.world[LM.RIGHT_SHOULDER]);
  const Cw = [(wL[0] + wR[0]) / 2, (wL[1] + wR[1]) / 2, (wL[2] + wR[2]) / 2], swW = Math.hypot(wR[0] - wL[0], wR[1] - wL[1], wR[2] - wL[2]) || 0.35;
  const rw = [(wR[0] - wL[0]) / swW, (wR[1] - wL[1]) / swW, (wR[2] - wL[2]) / swW];
  return { a, img: (pr, pu) => [C[0] + pr * r[0] * sw, C[1] + pr * r[1] * sw - pu * sw], wld: (pr, pu, f) => [Cw[0] + pr * rw[0] * swW, Cw[1] + pr * rw[1] * swW - pu * swW, Cw[2] + pr * rw[2] * swW - f] };
}
function moveTo(P, i, F, [pr, pu, f], b) {
  const ti = F.img(pr, pu), tw = F.wld(pr, pu, f), L = P.image[i], W = P.world[i];
  const d = [(ti[0] / F.a - L.x) * b, (ti[1] - L.y) * b, (tw[0] - W.x) * b, (tw[1] - W.y) * b, (tw[2] - W.z) * b];
  L.x += d[0]; L.y += d[1]; W.x += d[2]; W.y += d[3]; W.z += d[4];
  return d;
}
/** wrist + elbow along keyframes [[tRel, wrist, elbow], …] (min-jerk between keys), mirrored for the left hand */
function keyOverlay(frames, hand, t0, keys, inMs = 100, outMs = 100) {
  const s = hand === 'right' ? 1 : -1, dur = keys[keys.length - 1][0];
  const at = (tr) => {
    if (tr <= keys[0][0]) return [keys[0][1], keys[0][2]];
    for (let i = 1; i < keys.length; i++) if (tr <= keys[i][0]) {
      const u = minJerk((tr - keys[i - 1][0]) / Math.max(1, keys[i][0] - keys[i - 1][0]));
      const L = (a, b) => a.map((x, k) => x + (b[k] - x) * u);
      return [L(keys[i - 1][1], keys[i][1]), L(keys[i - 1][2], keys[i][2])];
    }
    return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  };
  const out = clone(frames);
  for (const f of out) {
    const P = f.players[0];
    if (!P || f.t < t0 || f.t > t0 + dur) continue;
    const b = Math.min(minJerk((f.t - t0) / inMs), minJerk((t0 + dur - f.t) / outMs));
    if (!(b > 0)) continue;
    const F = frameOf(P), [w, e] = at(f.t - t0), M = (v) => [s * v[0], v[1], v[2]];
    moveTo(P, EL[hand], F, M(e), b);
    const d = moveTo(P, WR[hand], F, M(w), b);
    for (const k of HANDPTS[hand]) { P.image[k].x += d[0]; P.image[k].y += d[1]; P.world[k].x += d[2]; P.world[k].y += d[3]; P.world[k].z += d[4]; }
  }
  return out;
}
const GUARD = [0.1, 0.25, 0.25], GUARD_E = [0.45, -0.45, 0.12];
const DROPS = {
  // one hand drops to the hip, pauses 150 ms, snaps back up to the guard (the verifier's PRE-DROP-RETURN probe)
  'hip 900': { dur: 900, keys: [[0, GUARD, GUARD_E], [350, [0.55, -1.7, 0.05], [0.62, -0.9, 0.0]], [500, [0.55, -1.7, 0.05], [0.62, -0.9, 0.0]], [900, GUARD, GUARD_E]], io: [120, 120] },
  // …to the belly, 80 ms, and back up to the chin
  'belly -> chin': { dur: 700, keys: [[0, GUARD, GUARD_E], [280, [0.2, -1.0, 0.18], [0.55, -0.85, 0.02]], [360, [0.2, -1.0, 0.18], [0.55, -0.85, 0.02]], [700, [0.05, 0.4, 0.18], [0.4, -0.4, 0.1]]], io: [90, 200] },
};
// one hand drops down and out to its own side (beside the hip, 0.6 SW out), rests, comes back to the guard
const SIDE_DROP = { dur: 900, keys: [[0, GUARD, GUARD_E], [260, [0.7, -1.0, 0.12], [0.7, -0.5, 0.0]], [500, [0.7, -1.0, 0.12], [0.7, -0.5, 0.0]], [900, GUARD, GUARD_E]], io: [80, 120] };
DROPS['side'] = SIDE_DROP;
function dropFires(name, tun, presets = [undefined, 'real-like']) {
  const D = DROPS[name];
  let up = 0, straight = 0, n = 0;
  for (const preset of presets) for (let i = 0; i < 12; i++) {
    const o = randomPlayerOptions(9700 + i, preset ? { preset } : {});
    const hand = i % 2 ? 'left' : 'right', t0 = 1800;
    const { frames } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: t0 }, { action: 'guard-high', ms: D.dur + 1200 }]));
    const ev = recog(keyOverlay(frames, hand, t0, D.keys, ...D.io), tun).filter((e) => e.t >= t0 - 100);
    n++;
    up += ev.filter((e) => e.punch.kind === PunchKind.UPPERCUT).length;
    straight += ev.filter((e) => e.punch.kind === PunchKind.STRAIGHT && e.t <= t0 + 400).length;
  }
  return { up, straight, n };
}

test('R-A: a hand dropped to the hip or the belly that pauses and snaps back up to the guard is no uppercut', () => {
  // (the belly with the real-like noise only: the default generator's ≈ 2 cm depth jitter often reads that fist as out in front,
  // where a body shot's hold is exempt — restMaxFwd)
  for (const [name, presets] of [['hip 900', [undefined, 'real-like']], ['belly -> chin', ['real-like']]]) {
    const on = dropFires(name, {}, presets), off = dropFires(name, { restLowMs: 0 }, presets);
    console.log(`      ${name}: uppercuts ${on.up}/${on.n} trials (rest rule off ${off.up})`);
    assert(on.up <= 2 && off.up >= on.up + 5, `${name}: ${on.up} vs ${off.up}`);
  }
});

test('R-A: an uppercut thrown from where a body shot paused (fired or not) is not judged as a hand coming back', () => {
  const ups = (tun) => {
    let hit = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 24; i++) {
      const o = randomPlayerOptions(5100 + i, preset ? { preset } : {});
      const h = i % 2 ? lead(o) : rear(o);
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: `body-${h}`, ms: 450 }, { action: `uppercut-${h}`, ms: 900 }, { action: 'guard-high', ms: 900 }]));
      const ev = recog(frames, tun).filter((e) => e.t >= 1200);
      const m1 = hitOf(ev, truth.punches[0]);
      if (ev.some((e) => e !== m1 && e.punch.hand === h && e.t >= truth.punches[1].tStart - 40 && e.t <= truth.punches[1].tPeak + 350)) hit++;
    }
    return hit;
  };
  const on = ups({}), off = ups({ restLowMs: 0 }), noFwd = ups({ restMaxFwd: 9 });
  console.log(`      body shot → uppercut at 450 ms (48): ${on} (rest rule off ${off}, without the out-in-front exemption ${noFwd})`);
  assert(on >= off - 1 && on >= noFwd + 2, `${on} vs ${off} / ${noFwd}`);
});

test('R-A: real uppercuts are untouched — from the high guard, from the stance (hands down) and from the low guard', () => {
  const ups = (tun) => {
    let hit = 0, n = 0;
    for (const preset of [undefined, 'real-like']) for (const posture of ['guard-high', 'idle', 'guard-low']) for (let i = 0; i < 8; i++) {
      const o = randomPlayerOptions(6600 + i, preset ? { preset } : {});
      const steps = [{ action: posture, ms: 1400 }];
      for (const a of ['uppercut-left', 'uppercut-right']) steps.push({ action: a, ms: 1100 }, { action: posture, ms: 700 });
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
      const ev = recog(frames, tun);
      for (const p of truth.punches) { n++; const h = hitOf(ev, p); if (h && h.punch.kind === PunchKind.UPPERCUT) hit++; }
    }
    return { hit, n };
  };
  const on = ups({}), off = ups({ restLowMs: 0 });
  console.log(`      uppercuts registered as uppercuts: ${on.hit}/${on.n} (rest rule off ${off.hit})`);
  assert(on.hit === off.hit, `${on.hit} vs ${off.hit}`);
});

test('R-A: a picture-only "straight" whose fist went down and out to its own side (a hand dropping) does not fire', () => {
  const on = dropFires('side', {}), off = dropFires('side', { imgDropOutY: 0 });
  console.log(`      straights fired early in a drop beside the hip (24 trials): ${on.straight} (rule off ${off.straight})`);
  assert(on.straight <= off.straight - 3, `${on.straight} vs ${off.straight}`);
  // the geometry: down 0.5 SW and 0.2 SW out is a drop; down and in (a body straight) is not
  const T = DEFAULT_TUNING;
  assert(T.imgDropOutY > 0 && T.imgDropOutX > 0 && T.imgDropOutY <= 0.5 && T.imgDropOutX <= 0.2, 'rule on by default');
});

test('R-B: V3-2 only relabels — the across-the-picture hook fires when and whether it would as a hook; a dodge is judged as for the hook', () => {
  const R = new GestureRecognizer({});
  const st = { peakRaw: 9, peak: 9, headPeak: 0, bodyPeak: 0 };
  // a hook's dodge strength is its picture travel, a straight's its extension rise: the relabelled one keeps the hook's test
  const cls = { kind: PunchKind.STRAIGHT, extArm: true, img: 2, dX: 0.05 };
  assert(R._strongAgainstBody(cls, st) && R._outpacesHead(cls, st), 'a relabelled hook passes the dodge test on its travel');
  assert(!R._strongAgainstBody({ ...cls, extArm: false }, st), 'a plain straight with that little extension does not');
});

test('R-C: a body straight thrown 80 ms after the other hand\'s hook is a punch, not that hook\'s counter-rotation', () => {
  const body = (tun) => {
    let hit = 0, n = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 24; i++) {
      const o = randomPlayerOptions(6100 + i, preset ? { preset } : {});
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: `hook-${lead(o)}`, ms: 80 }, { action: `body-${rear(o)}`, ms: 900 }, { action: 'guard-high', ms: 900 }]));
      const ev = recog(frames, tun).filter((e) => e.t >= 1200);
      const m1 = hitOf(ev, truth.punches[0]);
      n++;
      if (ev.some((e) => e !== m1 && e.punch.hand === truth.punches[1].hand && e.t >= truth.punches[1].tStart - 40 && e.t <= truth.punches[1].tPeak + 350)) hit++;
    }
    return { hit, n };
  };
  const on = body({}), off = body({ otherHookLeadMs: 1e9 });
  console.log(`      lead hook → rear body at 80 ms, body straights: ${on.hit}/${on.n} (onset rule off ${off.hit})`);
  assert(on.hit >= off.hit + 2, `${on.hit} vs ${off.hit}`);
});

test('R-D: a same-hand cross thrown from where an uppercut ended is a punch, not that uppercut\'s follow-through', () => {
  const cross = (tun) => {
    let hit = 0, n = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 24; i++) {
      const o = randomPlayerOptions(5100 + i, preset ? { preset } : {});
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: `uppercut-${rear(o)}`, ms: 450 }, { action: 'cross', ms: 900 }, { action: 'guard-high', ms: 900 }]));
      const ev = recog(frames, tun).filter((e) => e.t >= 1200);
      const m1 = hitOf(ev, truth.punches[0]);
      n++;
      if (ev.some((e) => e !== m1 && e.punch.hand === truth.punches[1].hand && e.t >= truth.punches[1].tStart - 40 && e.t <= truth.punches[1].tPeak + 350)) hit++;
    }
    return { hit, n };
  };
  const on = cross({}), off = cross({ recoverAtEndMs: 0 });
  console.log(`      rear uppercut → cross at 450 ms, crosses: ${on.hit}/${on.n} (follow-through window off ${off.hit})`);
  assert(on.hit >= off.hit + 2, `${on.hit} vs ${off.hit}`);
});

test('R-E: the re-arm\'s picture span is the punch\'s own (within rearmPeakMs of the fire), not where the hand wandered afterwards', () => {
  const run = (tun) => {
    const R = new GestureRecognizer({ tuning: tun });
    const ht = R.hands.right;
    const g = { bodySpeed: 0, bodyVel: [0, 0], headSpeed: 0, facing: true, headP: [0, 1] };
    R._tracked = true; R._trackedSince = -1e6;
    ht.state = 'cooldown'; ht.punchingUntil = 0; ht.drive = { max: 0, straight: 0, hook: 0, up: 0 }; ht.vel = [2, 0]; ht.xRate = 0;
    // a short jab (0.2 SW in the picture) fired at t = 1000 …
    ht.fire = { t: 1000, X: 0.6, xStart: 0, w: [0, 0.3], wStart: [0.2, 0.3] };
    const at = (t, w, X) => { ht.f = { t, w, X, fresh: true, up: null }; R._punchMachine(ht, g, t); return ht.state; };
    at(1050, [0, 0.3], 0.6);
    // … then the hand swings 1 SW out to the side (300 ms later) and comes most of the way back toward the guard
    at(1300, [-0.8, 0.3], 0.55);
    return at(1420, [-0.05, 0.3], 0.5);
  };
  assert(run({}) === 'cooldown', 'the wandering is no part of the punch: no re-arm on its way back');
  assert(run({ rearmPeakMs: 0 }) === 'ready', 'measured from the wandering (the V3-1 rule) it re-armed');
});
