// Regression tests of the verification round (V2-*, gesture.js header item 12): the false fires and kind errors the
// verifier found on the labelled real clips and on adversarial synthetic probes, each rebuilt on synthetic players and
// checked against the same recognizer with that one rule switched off (so a test fails if the rule stops working).
// The real-clip numbers themselves (other-hand fires, duplicates, c5's rear-hand rebounds, the display jitter) are
// measured with PUNCH/tools/realbench.mjs — the clips are never part of the repository.
import { test, assert } from '../harness.mjs';
import { GestureRecognizer, DEFAULT_TUNING } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';
import { LM } from '../../src/core/types.js';

const hitOf = (ev, p) => ev.find((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
const clone = (frames) => frames.map((f) => ({ ...f, players: f.players.map((p) => (p ? { ...p, image: p.image.map((l) => ({ ...l })), world: p.world.map((l) => ({ ...l })) } : p)) }));
/** punches of a frame list, each with the classifier's info of its stroke (cls) */
function recog(frames, tuning = {}) {
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push({ ...e, cls: rec.hands[e.punch.hand].fire ? rec.hands[e.punch.hand].fire.cls : null });
  return ev;
}
const run = (o, steps, tuning) => { const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps)); return { ev: recog(frames, tuning), truth, frames }; };

// ── overlay gestures: move a wrist (and elbow) to a target in a shoulder-based player frame (image + world), as the
//    verifier's probes did — right = toward the player's right, up, forward (m) ──
const minJerk = (u) => { u = Math.min(1, Math.max(0, u)); return u * u * u * (10 - 15 * u + 6 * u * u); };
const env = (t, t0, t1, inMs, outMs) => (t < t0 || t > t1 ? 0 : Math.min(minJerk((t - t0) / inMs), minJerk((t1 - t) / outMs)));
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
function moveTo(P, i, F, ti, tw, b) {
  const L = P.image[i], W = P.world[i];
  const d = [(ti[0] / F.a - L.x) * b, (ti[1] - L.y) * b, (tw[0] - W.x) * b, (tw[1] - W.y) * b, (tw[2] - W.z) * b];
  L.x += d[0]; L.y += d[1]; W.x += d[2]; W.y += d[3]; W.z += d[4];
  return d;
}
function moveHand(P, hand, F, wrist, elbow, b) {
  if (!(b > 0)) return;
  if (elbow) moveTo(P, EL[hand], F, F.img(elbow[0], elbow[1]), F.wld(elbow[0], elbow[1], elbow[2]), b);
  const d = moveTo(P, WR[hand], F, F.img(wrist[0], wrist[1]), F.wld(wrist[0], wrist[1], wrist[2]), b);
  for (const k of HANDPTS[hand]) { P.image[k].x += d[0]; P.image[k].y += d[1]; P.world[k].x += d[2]; P.world[k].y += d[3]; P.world[k].z += d[4]; }
}
/** fires of an overlay gesture on a held base posture (from 100 ms before the gesture on) */
function overlayFires(o, base, dur, fn, tuning) {
  const t0 = 1800;
  const { frames } = makeSyntheticPlayer(o).run(sequence([{ action: base, ms: t0 }, { action: base, ms: dur + 1200 }]));
  const f2 = clone(frames);
  for (const f of f2) { const P = f.players[0]; if (!P || f.t < t0 - 50 || f.t > t0 + dur + 50) continue; fn(P, frameOf(P), f.t, t0); }
  return recog(f2, tuning).filter((e) => e.t >= t0 - 100);
}

test('V2-1: a stroke right after this hand\'s punch that heads against that punch\'s picture direction is its way back (not a 2nd punch)', () => {
  const R = new GestureRecognizer({});
  const ht = R.hands.right;
  const T = R.tuning;
  ht.lastFireT = 1000;
  ht.lastHome = { t: 1150, w: [0.6, 0.2], from: [-0.4, 0.3] };   // the hook swept 1 SW toward the midline
  const stroke = (t0, a, b) => { ht.f = { w: b }; return { start: { t: t0, w: a } }; };
  assert(R._recovering(ht, stroke(1300, [-0.3, 0.3], [0.7, 0.1])), 'swinging back out past the start 300 ms later');
  assert(!R._recovering(ht, stroke(1300, [0.5, 0.2], [-0.4, 0.35])), 'the same sweep again (a double hook) is a punch');
  assert(!R._recovering(ht, stroke(1000 + T.recoverMs + 50, [-0.3, 0.3], [0.7, 0.1])), 'after recoverMs it is judged as a new stroke');
  assert(!R._recovering(ht, stroke(1300, [-0.3, 0.3], [-0.2, 0.2])), 'a short wobble has no direction');
  ht.lastHome = { t: 1150, w: [0.6, 0.2], from: [0.55, 0.3] };   // a straight at the camera: no picture direction
  assert(!R._recovering(ht, stroke(1300, [0.5, 0.3], [0.9, 0.0])), 'a punch that hardly moved in the picture gives no direction');
  // and same-hand combos (double jab, jab-hook-uppercut) register exactly as without the rule
  const combo = (tun) => {
    let hit = 0;
    for (let i = 0; i < 10; i++) {
      const o = randomPlayerOptions(6100 + i, { preset: i % 2 ? 'real-like' : undefined });
      const h = i % 4 < 2 ? 'left' : 'right';
      const { ev, truth } = run(o, [{ action: 'guard-high', ms: 1300 }, { action: `jab-${h}`, ms: 520 }, { action: `jab-${h}`, ms: 700 }, { action: 'guard-high', ms: 600 }, { action: `hook-${h}`, ms: 700 }, { action: `uppercut-${h}`, ms: 800 }, { action: 'guard-high', ms: 600 }], tun);
      for (const p of truth.punches) if (hitOf(ev, p)) hit++;
    }
    return hit;
  };
  const on = combo({}), off = combo({ recoverMs: 0 });
  console.log(`      same-hand combos registered: ${on} (rule off ${off})`);
  assert(on === off, `${on} vs ${off}`);
});

test('V2-7: a fast reach down to the side (phone, drink) is no body punch — no early decision down there, no picture straight going out', () => {
  const fires = (tun) => {
    let n = 0;
    for (const fps of [30, 60]) for (let i = 0; i < 12; i++) {
      const o = randomPlayerOptions(9700 + i, { preset: 'real-like', fps });
      n += overlayFires(o, 'idle', 1800, (P, F, t, t0) => moveHand(P, 'right', F, [1.3, -1.3, 0.25], [0.85, -0.75, 0.05], env(t, t0, t0 + 1800, 500, 500)), tun).length;
    }
    return n;
  };
  const on = fires({}), off = fires({ earlyNotLow: false, imgStraightMaxOut: 9 });
  console.log(`      side reaches at 30 + 60 fps (24): ${on} fires (both rules off: ${off})`);
  assert(on <= 3 && off >= on + 6, `${on} vs ${off}`);
});

test('V2-8: ducking and bobbing with the guard up never fires a picture-only punch; gesturing with both hands gets no hook-style ballistic pass', () => {
  const duck = (tun) => {
    let all = 0, img = 0;
    for (const extra of [{ preset: 'real-like' }, { preset: 'real-like', frameDropRate: 0.15 }, { frameDropRate: 0.15 }]) for (let i = 0; i < 12; i++) {
      const o = randomPlayerOptions(9700 + i, extra);
      for (const steps of [[{ action: 'guard-high', ms: 1500 }, { action: 'duck', ms: 380 }, { action: 'guard-high', ms: 350 }, { action: 'duck', ms: 380 }, { action: 'guard-high', ms: 350 }, { action: 'duck', ms: 380 }, { action: 'guard-high', ms: 1000 }],
        [{ action: 'guard-high', ms: 1500 }, { action: 'duck', ms: 420 }, { action: 'lean-left', ms: 320 }, { action: 'duck', ms: 420 }, { action: 'lean-right', ms: 320 }, { action: 'guard-high', ms: 1000 }]]) {
        const ev = run(o, steps, tun).ev.filter((e) => e.t >= 1400);
        all += ev.length; img += ev.filter((e) => e.cls && (e.cls.imgPath || e.cls.depthContra)).length;
      }
    }
    return { all, img };
  };
  const a = duck({}), b = duck({ imgNoDuck: false });
  console.log(`      duck flurries / bob and weave (72): ${a.all} fires, ${a.img} picture-only (rule off: ${b.all}, ${b.img})`);
  assert(a.img <= 1 && b.img >= a.img + 3 && a.all <= b.all, JSON.stringify({ a, b }));
  // two hands gesturing back and forth (talking): RT-8's picture-only ballistic pass is for hook-like strokes only
  const talk = (tun) => {
    let n = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 12; i++) {
      n += overlayFires(randomPlayerOptions(9700 + i, { preset }), 'idle', 3000, (P, F, t, t0) => {
        for (const h of ['left', 'right']) {
          const s = h === 'right' ? 1 : -1, q = Math.sin((t - t0) / 1000 * 2 * Math.PI * 2.4 + (h === 'left' ? Math.PI : 0));
          moveHand(P, h, F, [s * (0.3 + 0.3 * q), -0.4 + 0.2 * q, 0.25 + 0.15 * q], [s * 0.7, -0.7, 0.05], env(t, t0, t0 + 3000, 300, 300));
        }
      }, tun).length;
    }
    return n;
  };
  const t1 = talk({}), t0 = talk({ ballisticImgHook: 0 });
  console.log(`      fast two-hand gesturing (24 trials): ${t1} fires (any stroke may take the pass: ${t0})`);
  assert(t1 < t0, `${t1} vs ${t0}`);
});

test('V2-9: a picture-only straight needs a straightened elbow — turning back from a twist shrinks the arms in shoulder widths, the elbow stays bent', () => {
  const GEST = [['wave', { hand: 'right', ms: 3000 }], ['scratch-face', { hand: 'left', ms: 2400 }], ['reach-slow', { hand: 'right', ms: 3200 }], ['point', { hand: 'right', ms: 3000 }], ['adjust-glasses', { hand: 'left', ms: 1500 }], ['raise-hand', { hand: 'right', ms: 1800 }], ['wave', { hand: 'left', height: 'face', ms: 3000 }]];
  const go = (tun) => {
    let fp = 0, hit = 0, nP = 0;
    for (let i = 0; i < 8; i++) {
      const o = randomPlayerOptions(6600 + i, {}); const tw = i % 2 ? 'twist-left' : 'twist-right';
      for (const [g, extra] of GEST) fp += run(o, [{ action: 'idle', ms: 1500 }, { action: tw, amount: 2.2, ms: 900 }, { action: g, ...extra }, { action: 'idle', ms: 1000 }], tun).ev.filter((e) => e.t >= 1400).length;
      const steps = [{ action: 'guard-high', ms: 1500 }, { action: tw, amount: 1.6, ms: 900 }];
      for (const p of ['jab', 'cross', 'hook-left', 'hook-right', 'uppercut-left', 'body-right']) steps.push({ action: p }, { action: tw, amount: 1.6, ms: 700 });
      const { ev, truth } = run(o, steps, tun);
      for (const p of truth.punches) { nP++; if (hitOf(ev, p)) hit++; }
    }
    return { fp, hit, nP };
  };
  const a = go({}), b = go({ imgStraightMinS: 0 });
  console.log(`      gestures after a 57° twist (56): ${a.fp} fires (elbow test off: ${b.fp}); punches while turned 41°: ${a.hit}/${a.nP} (off: ${b.hit})`);
  assert(a.fp <= b.fp - 6 && a.hit >= b.hit - 1, JSON.stringify({ a, b }));
  assert(DEFAULT_TUNING.facingMinRatio === 0.72, 'the facing test is back at 0.72 (0.45 recognised no more real punches)');
});

test('V2-5: at 60 fps a jab thrown up from a low guard whose arm then goes out is a straight, not a picture-only uppercut', () => {
  const go = (tun) => {
    let n = 0, ok = 0, up = 0;
    for (let i = 0; i < 16; i++) {
      const o = randomPlayerOptions(7100 + i, { fps: 60 });
      const steps = [{ action: 'guard-low', ms: 1400 }];
      for (const a of ['jab-left', 'jab-right', 'jab-left', 'jab-right']) steps.push({ action: a, ms: 1050 }, { action: 'guard-low', ms: 650 });
      const { ev, truth } = run(o, steps, tun);
      for (const p of truth.punches) { const e = hitOf(ev, p); if (!e) continue; n++; if (e.punch.kind === 'straight') ok++; if (e.punch.kind === 'uppercut') up++; }
    }
    return { n, ok, up };
  };
  const a = go({}), b = go({ imgUpStraightX: 0 });
  console.log(`      60 fps jabs from a low guard: ${a.ok}/${a.n} straights, ${a.up} uppercuts (rule off: ${b.ok}/${b.n}, ${b.up})`);
  assert(a.up <= b.up - 3 && a.ok >= 0.8 * a.n, JSON.stringify({ a, b }));
});

test('V2-6: an uppercut that sweeps in must end in front of the body\'s middle — the rear hand bouncing back up beside the chin is no uppercut', () => {
  // the rear hand dips out and down during the lead jab and snaps back up to its guard beside the chin (TUNE c5's
  // 'guard-drop' hard negatives); a real uppercut thrown with the same sweep ends at the chin, in front of the middle
  const go = (tun, endLat) => {
    let n = 0;
    for (let i = 0; i < 16; i++) {
      const o = randomPlayerOptions(5600 + i, { preset: i % 2 ? 'real-like' : undefined });
      const rear = o.lead === 'right' ? 'left' : 'right', s = rear === 'right' ? 1 : -1;
      n += overlayFires(o, 'guard-high', 700, (P, F, t, t0) => {
        const u = (t - t0) / 700;
        // dip 0.9 SW down and 0.5 SW out over 300 ms, then up and in to the guard height in 220 ms, then hold
        const dip = u < 0.43 ? minJerk(u / 0.43) : 1 - minJerk((u - 0.43) / 0.31);
        const wr = [s * (endLat + 0.5 * dip + 0.45 * Math.max(0, dip)), 0.3 - 1.0 * dip, 0.15];
        const el = [s * (endLat + 0.25 + 0.3 * dip), -0.45 - 0.5 * dip, -0.05];
        moveHand(P, rear, F, wr, el, env(t, t0, t0 + 700, 120, 1));
      }, tun).filter((e) => e.punch.kind === 'uppercut').length;
    }
    return n;
  };
  const beside = go({}, 0.32), besideOff = go({ upMedialMaxLat: 9 }, 0.32), middle = go({}, 0.0);
  console.log(`      rear-hand bounce back to beside the chin: ${beside} uppercuts (lateral limit off: ${besideOff}); the same sweep ending at the chin: ${middle}`);
  assert(beside <= besideOff - 3 && middle >= besideOff - 2, `${beside} / ${besideOff} / ${middle}`);
});
