// Regression tests of the fix round (V3-*, gesture.js header item 13), each against the same recognizer with that one rule
// switched off (a test fails if the rule stops working). The real-clip numbers (the close-webcam clip's jabs, duplicates,
// false fires) are measured with PUNCH/tools/realbench.mjs — the clips are never part of the repository. The refix round's
// changes to these rules (R-B, R-C, R-D, the V3-3 twist check) are asserted here; its new rules are in gesture-refix.test.mjs.
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
/** the V2-1 rule set: no guard / at-end test in 'recovering', re-arm measured from the fire, no head-shot exemption in 'returning' */
const V2_RULES = { recoverFromGuard: 0, recoverAtEnd: 0, rearmFromPeak: false, returnOutXi: 0 };

test('V3-1: the second punch of a same-hand double-up (body then head, head then body, a double jab) registers — a retraction still never fires', () => {
  const pairs = { 'rear body -> cross': (o) => [`body-${rear(o)}`, 'cross'], 'lead body -> jab': (o) => [`body-${lead(o)}`, 'jab'],
    'cross -> rear body': (o) => ['cross', `body-${rear(o)}`], 'jab -> jab': () => ['jab', 'jab'] };
  const second = (tun) => {
    const r = {};
    for (const [name, pf] of Object.entries(pairs)) {
      let n = 0;
      for (const preset of [undefined, 'real-like']) for (let i = 0; i < 12; i++) {
        const o = randomPlayerOptions(5100 + i, preset ? { preset } : {});
        const [a, b] = pf(o);
        const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: a, ms: 550 }, { action: b, ms: 900 }, { action: 'guard-high', ms: 900 }]));
        if (hitOf(recog(frames, tun), truth.punches[1])) n++;
      }
      r[name] = n;
    }
    return r;
  };
  const on = second({}), off = second(V2_RULES);
  console.log(`      2nd punch at 550 ms (24 each): ${JSON.stringify(on)} (V2 rules: ${JSON.stringify(off)})`);
  const sum = (r) => Object.values(r).reduce((a, b) => a + b, 0);
  assert(sum(on) >= sum(off) + 8, `${sum(on)} vs ${sum(off)}`);
  for (const k of Object.keys(on)) assert(on[k] >= off[k], `${k}: ${on[k]} vs ${off[k]}`);
  // a single punch held out and pulled back: exactly one fire (COM07), with and without the rules
  for (const tun of [{}, V2_RULES]) {
    let extra = 0;
    for (let i = 0; i < 12; i++) {
      const o = randomPlayerOptions(5300 + i);
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: 'jab', ms: 1400 }, { action: 'guard-high', ms: 900 }]));
      const ev = recog(frames, tun).filter((e) => e.t >= 1250);
      extra += ev.filter((e) => !truth.punches.some((p) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350)).length;
      extra += Math.max(0, ev.filter((e) => truth.punches.some((p) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350)).length - 1);
    }
    assert(extra === 0, `retraction fires: ${extra} (${JSON.stringify(tun)})`);
  }
});

test('V3-1: the recovering gate judges where the stroke began — from the guard it is a fresh punch, from the punch\'s end its way back', () => {
  const R = new GestureRecognizer({});
  const ht = R.hands.right;
  ht.lastFireT = 1000;
  ht.lastHome = { t: 1150, w: [0.2, 0.3], from: [0.15, -0.7] };   // a body straight: the fist went 1 SW down in the picture
  const stroke = (a, b) => { ht.f = { w: b }; return { start: { t: 1300, w: a } }; };
  assert(R._recovering(ht, stroke([0.15, -0.5], [0.2, 0.3])), 'rising from down there (the return) is its way back');
  assert(!R._recovering(ht, stroke([0.2, 0.15], [0.05, 0.75])), 'rising from the guard (the head shot of a double-up) is a punch');
  const strokeAt = (t, a, b) => { ht.f = { w: b }; return { start: { t, w: a } }; };
  assert(R._recovering(ht, strokeAt(1100, [0.13, -0.65], [0.5, -0.3])), 'starting still at the punch\'s end right after the fire, any direction, continues it');
  // (refix R-D: …only as the punch's own follow-through — an uppercut ends at the chin, where a same-hand cross starts 130+ ms later)
  assert(R._recovering(ht, strokeAt(1100, [0.13, -0.65], [0.1, -1.15])), '…even on in the punch\'s own direction');
  assert(!R._recovering(ht, strokeAt(1300, [0.13, -0.65], [0.1, -1.15])), 'the same stroke begun 300 ms after the fire is a new one');
  assert(!R._recovering(ht, stroke([0.13, -0.65], [0.16, -0.6])), 'a short wobble has no direction');
  assert(DEFAULT_TUNING.recoverFromGuard > 0 && DEFAULT_TUNING.recoverAtEnd > 0 && DEFAULT_TUNING.rearmFromPeak && DEFAULT_TUNING.returnOutXi > 0, 'rules on by default');
});

// ── a straight thrown across the picture (a close or off-axis camera): the fist sweeps 1.2 SW toward and past the midline, the
//    elbow ends below the shoulder line and in front of the body, the arm straight; in 3D it goes sideways (the camera is not
//    its target) ──
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
function setPt(P, i, F, [pr, pu, f]) {
  const ti = F.img(pr, pu), tw = F.wld(pr, pu, f), L = P.image[i], W = P.world[i];
  const d = [ti[0] / F.a - L.x, ti[1] - L.y, tw[0] - W.x, tw[1] - W.y, tw[2] - W.z];
  L.x += d[0]; L.y += d[1]; W.x += d[2]; W.y += d[3]; W.z += d[4];
  return d;
}
const lerp = (a, b, u) => a.map((v, k) => v + (b[k] - v) * u);
function acrossKinds(tun) {
  const kinds = {};
  for (let i = 0; i < 12; i++) for (const preset of [undefined, 'real-like']) {
    const o = randomPlayerOptions(7300 + i, { preset });
    const hand = lead(o), s = hand === 'right' ? 1 : -1;
    const t0 = 1800, T2 = 260, T3 = 520;
    const { frames } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: t0 }, { action: 'guard-high', ms: 1600 }]));
    const f2 = clone(frames);
    const W0 = [s * 0.25, 0.25, 0.12], E0 = [s * 0.45, -0.5, 0.05], W1 = [-s * 0.95, -0.15, 0.15], E1 = [-s * 0.2, -0.36, 0.08];
    for (const f of f2) {
      const P = f.players[0]; if (!P || f.t < t0 - 200 || f.t > t0 + T3 + 300) continue;
      const F = frameOf(P);
      const u = f.t < t0 ? 0 : f.t < t0 + T2 ? minJerk((f.t - t0) / T2) : f.t < t0 + T3 ? 1 - minJerk((f.t - t0 - T2) / (T3 - T2)) : 0;
      setPt(P, EL[hand], F, lerp(E0, E1, u));
      const d = setPt(P, WR[hand], F, lerp(W0, W1, u));
      for (const k of HANDPTS[hand]) { P.image[k].x += d[0]; P.image[k].y += d[1]; P.world[k].x += d[2]; P.world[k].y += d[3]; P.world[k].z += d[4]; }
    }
    for (const e of recog(f2, tun)) if (e.t >= t0 && e.t <= t0 + 700 && e.punch.hand === hand) kinds[e.punch.kind] = (kinds[e.punch.kind] || 0) + 1;
  }
  return kinds;
}

test('V3-2: a straight thrown across the picture with a low elbow and a straightened arm is a straight; real hooks stay hooks', () => {
  const on = acrossKinds({}), off = acrossKinds({ hookExtMinS: 0 });
  console.log(`      across-the-picture straights (24): ${JSON.stringify(on)} (rule off: ${JSON.stringify(off)})`);
  // (refix R-B: clear cases only — straightness ≥ 0.65 and the picture elbow ≥ 0.05 SW under the limit — 5 of these 23, 9 before)
  assert((on.straight || 0) >= 4 && (off.straight || 0) === 0, `${JSON.stringify(on)} vs ${JSON.stringify(off)}`);
  // …a relabel only: the same strokes fire (refix R-B)
  const total = (k) => Object.values(k).reduce((a, b) => a + b, 0);
  assert(total(on) === total(off), `relabel only: ${total(on)} fires vs ${total(off)}`);
  // synthetic hooks (elbow up at shoulder height) keep their kind
  const hooks = (tun) => {
    let hook = 0, n = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 12; i++) {
      const o = randomPlayerOptions(7500 + i, preset ? { preset } : {});
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: 'hook-left', ms: 900 }, { action: 'guard-high', ms: 600 }, { action: 'hook-right', ms: 900 }, { action: 'guard-high', ms: 600 }]));
      const ev = recog(frames, tun);
      for (const p of truth.punches) { n++; const h = hitOf(ev, p); if (h && h.punch.kind === PunchKind.HOOK) hook++; }
    }
    return { hook, n };
  };
  const hOn = hooks({}), hOff = hooks({ hookExtMinS: 0 });
  console.log(`      synthetic hooks fired as hooks: ${hOn.hook}/${hOn.n} (rule off ${hOff.hook})`);
  assert(hOn.hook >= hOff.hook - 1, `${hOn.hook} vs ${hOff.hook}`);
});

test('V3-4: a body-height straight while the other hand\'s faster hook swings is its counter-rotation', () => {
  const R = new GestureRecognizer({});
  const ht = R.hands.left, oh = R.hands.right;
  const st = { peakRaw: 4, t0: 900 };
  oh.state = 'stroke'; oh.stroke = { peakH: 6, peakS: 2, peakU: 1, peakRaw: 6, t0: 900 };
  assert(R._otherHook(ht, st, 1000), 'the other hand\'s hook in flight, faster, begun together');
  oh.stroke = { peakH: 2, peakS: 6, peakU: 1, peakRaw: 6, t0: 900 };
  assert(!R._otherHook(ht, st, 1000), 'a straight of the other hand is no hook');
  oh.state = 'cooldown'; oh.stroke = null; oh.lastPunch = { kind: PunchKind.HOOK }; oh.lastFireT = 950; oh.lastStroke = { peak: 7, t0: 900 };
  assert(R._otherHook(ht, st, 1000), 'a hook fired 50 ms ago');
  assert(!R._otherHook(ht, st, 950 + DEFAULT_TUNING.otherHookMs + 20), '…but not long after');
  oh.lastStroke = { peak: 3, t0: 900 };
  assert(!R._otherHook(ht, st, 1000), 'a slower hook does not explain a faster stroke');
  // refix R-C: the counter-rotation moves with the hook's torso turn — a straight begun 80 ms after the hook is a combo's punch
  oh.lastStroke = { peak: 7, t0: 900 };
  assert(!R._otherHook(ht, { peakRaw: 4, t0: 980 }, 1000), 'a straight begun 80 ms after the hook is no counter-rotation');
  oh.state = 'stroke'; oh.stroke = { peakH: 6, peakS: 2, peakU: 1, peakRaw: 6, t0: 900 };
  assert(!R._otherHook(ht, { peakRaw: 4, t0: 980 }, 1000), '…nor while the hook is still in flight');
});

test('V3-5: a slow deep-scoop uppercut is not turned down as a pull-back (its arm un-foreshortens as the forearm stands up)', () => {
  const ups = (tun) => {
    let hit = 0, n = 0;
    for (const preset of [undefined, 'real-like']) for (let i = 0; i < 16; i++) {
      const o = randomPlayerOptions(4400 + i, preset ? { preset } : {});
      const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 1300 }, { action: 'uppercut-left', speedMs: 420, ms: 1300 }, { action: 'guard-high', ms: 900 }, { action: 'uppercut-right', speedMs: 420, ms: 1300 }, { action: 'guard-high', ms: 900 }]));
      const ev = recog(frames, tun);
      for (const p of truth.punches) { n++; if (hitOf(ev, p)) hit++; }
    }
    return { hit, n };
  };
  const on = ups({}), off = ups({ pullBackScoopDip: 0 });
  console.log(`      420 ms uppercuts: ${on.hit}/${on.n} (rule off ${off.hit})`);
  assert(on.hit >= off.hit + 2, `${on.hit} vs ${off.hit}`);
});

test('V3-3: the lean.z face-size gates are off by default (they cost noisy players\' back dodges); on, they only lower a twist-inflated reading', () => {
  assert(DEFAULT_TUNING.leanZFaceCap === 0 && DEFAULT_TUNING.leanZTwistFace === 0, 'off by default');
  // (refix: a twist the picture AND the depth read as 'back' — the shoulders narrow 15 % in the picture and move 8 cm back in the
  // tracker's depth, the face does not change: gates off it reads as a back lean, gates on the face's own size wins. The
  // synthetic 'twist-left' below reads 0 either way, so it alone cannot show the gate working.)
  const twistZ = (tun) => {
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const o = randomPlayerOptions(7100 + i, { noise: 0.3 });
      const f2 = clone(makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 6500 }])).frames);
      for (const f of f2) {
        const P = f.players[0], u = f.t < 4000 ? 0 : f.t < 4300 ? (f.t - 4000) / 300 : f.t < 5500 ? 1 : f.t < 5800 ? 1 - (f.t - 5500) / 300 : 0;
        if (!P || !(u > 0)) continue;
        const a = P.image[LM.LEFT_SHOULDER], b = P.image[LM.RIGHT_SHOULDER], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        for (const l of [a, b]) { l.x = cx + (l.x - cx) * (1 - 0.15 * u); l.y = cy + (l.y - cy) * (1 - 0.15 * u); }
        for (const k of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.NOSE]) P.world[k].z += 0.08 * u;
      }
      const rec = new GestureRecognizer({ tuning: tun });
      let mz = 0;
      for (const fr of f2) { const c = rec.update(fr.players[0], fr.t).control; if (fr.t >= 4000 && fr.t <= 5800) mz = Math.min(mz, c.lean.z); }
      sum += mz / 6;
    }
    return sum;
  };
  const twOff = twistZ({}), twOn = twistZ({ leanZFaceCap: 1, leanZTwistFace: 2 });
  console.log(`      shoulders-only twist read as back: lean.z min (mean of 6) ${twOff.toFixed(2)}, gates on ${twOn.toFixed(2)}`);
  assert(twOff <= -0.1, `the twist must read as a back lean with the gates off for this check to mean anything: ${twOff}`);
  assert(twOn >= twOff + 0.03 && twOn <= 0, `the gates lower the twist reading and never invert it: ${twOn} vs ${twOff}`);
  // a twist: the shoulders narrow (the picture's shoulder cue reads 'back'), the face does not change — and a back lean, where both shrink
  const zOf = (tun, twist) => {
    const o = randomPlayerOptions(7100, { noise: 0.3 });
    const seq = sequence([{ action: 'guard-high', ms: 2500 }, { action: twist ? 'twist-left' : 'lean-back', amount: twist ? 1 : 1.6, ms: 1500 }, { action: 'guard-high', ms: 600 }]);
    const { frames } = makeSyntheticPlayer(o).run(seq);
    const rec = new GestureRecognizer({ tuning: tun });
    let minZ = 0;
    for (const fr of frames) { const c = rec.update(fr.players[0], fr.t).control; if (fr.t >= 2600 && fr.t <= 4000) minZ = Math.min(minZ, c.lean.z); }
    return minZ;
  };
  const on = { leanZFaceCap: 1, leanZTwistFace: 2 };
  const leanOff = zOf({}, false), leanOn = zOf(on, false);
  console.log(`      held back lean: lean.z min ${leanOff.toFixed(2)} (gates on ${leanOn.toFixed(2)}); twist: ${zOf({}, true).toFixed(2)} (gates on ${zOf(on, true).toFixed(2)})`);
  assert(leanOn <= -DEFAULT_TUNING.leanDodgeLevelZ * 0.9 || leanOn <= leanOff + 0.15, `back lean with the gates on: ${leanOn}`);
  assert(zOf(on, true) >= zOf({}, true) - 1e-9, 'the gates never deepen a twist reading');
});
