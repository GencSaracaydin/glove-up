// Fix pass (combat): timing with the renderer's hit-stop — D5 camera punches at extension (RULES-08), D6 punches
// recognised during a stall are queued, never dropped (RULES-01), the guard comes back ~0.65 s (real) after an
// ordinary hit (RULES-02), knockdown calls and the cover-up net of the stall (RULES-05).
import { test, assert } from '../harness.mjs';
import { COMBAT, stallMsFor, travelMs } from '../../src/game/combat.js';
import { Boxer } from '../../src/game/boxer.js';
import { Match, RULES } from '../../src/game/match.js';
import { ROSTER } from '../../src/game/roster.js';
import { MatchSession } from '../../src/app/session.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';

const FPS = 60, DT = 1000 / FPS;
const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.1, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.1, punching: false } },
  activity: 0, ...o,
});
const jab = (hand, o = {}) => ({ type: 'punch', t: 0, punch: { hand, kind: 'straight', target: 'head', power: 0.6, t: 0, ...o } });
const passive = (base, ai = {}) => ({ ...base, id: `${base.id}-fix`, ai: { ...base.ai, firstAttackMs: 1e9, attackGapMs: 1e9, ...ai } });

/** MatchSession on a fake renderer whose hit-stop follows MATCH_HIT exactly like render/fx.js (stall, ×0.02). */
function stallSession(opponent, seed = 5) {
  const bus = new EventBus();
  let stall = 0, real = 0;
  const renderer = {
    get timeScale() { return stall > 0 ? COMBAT.hitStop.scale : 1; },
    resetMatch() {}, setSplit() {}, setScene() {}, renderMatch() {},
  };
  const log = [];
  bus.on('*', (n, p) => {
    log.push({ n, p, real });
    if (n === Ev.MATCH_HIT) { const ms = stallMsFor(p, (id) => id === 'p1'); if (ms > 0) stall = Math.max(stall, ms); }
  });
  const s = new MatchSession({ bus, renderer, hud: null, mode: 'single', players: [{ id: 'x', name: 'Pat' }], opponent, seed, fast: false });
  s.begin();
  const frame = (input) => { real += DT; s.update(DT / 1000, real, [input || { control: ctl(), events: [] }]); stall = Math.max(0, stall - DT); };
  const until = (pred, fn = () => null, max = 60000) => { const end = real + max; while (!pred() && real < end) frame(fn()); return pred(); };
  const run = (ms, fn = () => null) => { const end = real + ms; while (real < end - 1e-6) frame(fn()); };
  return { s, log, frame, until, run, get real() { return real; }, get stall() { return stall; } };
}

test('combat-fix D5: a camera punch (atExtension) makes contact within 30 ms; a keyboard punch keeps the 100/120/130 ms out-stroke (RULES-08)', () => {
  for (const kind of ['straight', 'hook', 'uppercut']) {
    const cam = new Boxer({ isHuman: true });
    cam.setControl(ctl(), 1000);
    const p = cam.tryPunch({ hand: 'left', kind, target: 'head', power: 0.6, atExtension: true }, 1000);
    assert(p && p.impactAt - p.thrownAt <= 30 && p.impactAt - p.thrownAt >= 17, `${kind}: camera contact ${p.impactAt - p.thrownAt} ms`);
    const key = new Boxer({ isHuman: true });
    key.setControl(ctl(), 1000);
    const q = key.tryPunch({ hand: 'left', kind, target: 'head', power: 0.6 }, 1000);
    assert.equal(q.impactAt - q.thrownAt, COMBAT.punch[kind].humanTravelMs, `${kind}: keyboard`);
  }
  assert.equal(travelMs('straight', true, 1, COMBAT, false, true), COMBAT.atExtensionTravelMs);
  assert.equal(travelMs('straight', false, 1, COMBAT, false, true), COMBAT.punch.straight.aiTravelMs, 'AI punches ignore the flag');
});

test('combat-fix D5: the AI still slips a camera punch, and a camera punch into a punch that is out is a counter', () => {
  // slip: the AI reads the punch as it starts and leans out within the 30 ms
  let slipped = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const bus = new EventBus(); const out = [];
    bus.on('*', (n, p) => { if (p && p.attacker === 'p1' && [Ev.MATCH_HIT, Ev.MATCH_DODGE, Ev.MATCH_BLOCK].includes(n)) out.push(n); });
    const m = new Match({ bus, seed, p2: passive(ROSTER[4], { slipPct: 1, headGuard: 0, punishPct: 0 }), fast: true });
    let now = 0; m.start(0);
    while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
    for (let i = 0; i < 20; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
    now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [jab('left', { atExtension: true })] } });
    for (let i = 0; i < 20; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
    if (out[0] === Ev.MATCH_DODGE) slipped++;
  }
  assert.equal(slipped, 5, `slipped ${slipped}/5 camera punches`);
  // counter: the AI's punch is out (travel) when the camera punch is recognised
  const bus = new EventBus(); const hits = [];
  bus.on(Ev.MATCH_HIT, (p) => { if (p.attacker === 'p1') hits.push(p); });
  const m = new Match({ bus, seed: 3, p2: passive(ROSTER[4], { headGuard: 0, slipPct: 0, punishPct: 0, firstAttackMs: 300, stringWeights: [1], tellMs: 400, powerPct: 0 }), fast: true });
  let now = 0; m.start(0);
  while (!(m.boxers.p2.travelling()) && now < 20000) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ guard: 'high', guardAmount: 1 }), events: [] } }); }
  now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [jab('right', { atExtension: true })] } });
  for (let i = 0; i < 10; i++) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl(), events: [] } }); }
  assert(hits.length === 1 && hits[0].counter, 'a counter');
});

test('combat-fix D6: during a hit-stop a recognised punch is queued (one per hand) and never silently dropped (RULES-01)', () => {
  // unit: the same glove 20 ms later is dropped normally, queued when the match is stalled
  const b = new Boxer({ isHuman: true });
  b.setControl(ctl(), 0);
  b.tryPunch({ hand: 'left', kind: 'straight', target: 'head' }, 0);
  assert.equal(b.tryPunch({ hand: 'left', kind: 'straight', target: 'head' }, 20), null, 'unstalled: too early even for the buffer');
  assert.equal(b.tryPunch({ hand: 'left', kind: 'hook', target: 'body' }, 20, { stalled: true }), 'buffered');
  assert.equal(b.tryPunch({ hand: 'left', kind: 'uppercut', target: 'head' }, 21, { stalled: true }), 'buffered', 'one per hand: the newest wins');
  for (const q of b.duePunches(200)) b.onPunchResolved(q, { result: 'hit', damage: 1.2 }, q.impactAt);
  const fired = b.update(200).filter((n) => n.type === 'thrown').map((n) => n.punch);
  assert(fired.length === 1 && fired[0].kind === 'uppercut' && fired[0].thrownAt === 200, 'fires once the glove is allowed (200 ms)');
  // session: a 12-punch flurry 170 ms apart (real) at an open opponent — the renderer stalls 0.2 / 0.5 s per hit
  const h = stallSession(passive(ROSTER[0], { headGuard: 0, bodyGuard: 0, slipPct: 0, coverUpPct: 0, streakBlock: 0, postReelGuardMs: 0 }));
  assert(h.until(() => h.s.match.phase === MatchPhase.FIGHTING && h.s.view.stage === 'live'));
  h.run(500);
  const p1 = h.s.match.boxers.p1;
  const results = [];
  const orig = p1.tryPunch.bind(p1);
  p1.tryPunch = (input, t, opts) => { const r = orig(input, t, opts); results.push({ r, stalled: !!(opts && opts.stalled) }); return r; };
  const t0 = h.real; let sent = 0;
  h.run(12 * 170 + 2500, () => {
    if (h.s.match.boxers.p2.hp < 3) h.s.match.debugSetHp('p2', 10);
    if (sent < 12 && h.real - t0 >= sent * 170) { sent++; return { control: ctl(), events: [jab(sent % 2 ? 'left' : 'right')] }; }
    return { control: ctl(), events: [] };
  });
  assert.equal(results.length, 12);
  assert(results.some((x) => x.stalled), 'the session told the Match it was stalled');
  assert.equal(results.filter((x) => x.r === null).length, 0, `dropped: ${results.map((x) => (x.r === null ? 'null' : typeof x.r === 'string' ? x.r : 'start')).join(',')}`);
  const hits = h.log.filter((e) => e.n === Ev.MATCH_HIT && e.p.attacker === 'p1');
  const thrown = h.log.filter((e) => e.n === Ev.MATCH_PUNCH_THROWN && e.p.attacker === 'p1').length;
  assert(thrown >= 7 && hits.length >= 6, `${thrown} thrown, ${hits.length} hits (before the fix 6 of 12 were thrown)`);
  const gaps = hits.slice(1).map((e, i) => e.real - hits[i].real);
  assert(gaps.every((g) => g >= 250) && gaps.slice(1).every((g) => g >= 450), `the human stays on match time: hits ${gaps.map(Math.round).join(',')} ms apart`);
});

test('combat-fix RULES-02: after an ORDINARY hit a top opponent keeps the guard open ~0.65 s (real); after a counter as before', () => {
  for (const tier of [5, 7, 10]) {
    const base = ROSTER[tier - 1];
    for (const big of [false, true]) {
      const h = stallSession(passive(base), 11 + tier);
      assert(h.until(() => h.s.match.phase === MatchPhase.FIGHTING && h.s.view.stage === 'live'));
      h.run(1200, () => ({ control: ctl({ guard: 'high', guardAmount: 1 }), events: [] }));
      const ai = h.s.match.ais.p2; const read = ai.readFor.bind(ai); let first = true;
      ai.readFor = (p, t, self) => { if (first) { first = false; return 'open'; } return read(p, t, self); };
      if (big) h.s.match.boxers.p1.counterUntil = h.s.match.t + 2000; // the first hit lands as a counter (0.5 s hit-stop)
      let impact = null, back = null, sent = false;
      h.run(2500, () => {
        const hit = h.log.find((e) => e.n === Ev.MATCH_HIT && e.p.attacker === 'p1');
        if (hit && impact == null) impact = hit.real;
        const m = h.s.match;
        if (impact != null && back == null && h.real > impact && m.boxers.p2.effectiveGuard(m.wt) !== 'none' && !m.boxers.p2.isCovering(m.wt)) back = h.real - impact;
        if (!sent) { sent = true; return { control: ctl(), events: [jab('left')] }; }
        return { control: ctl(), events: [] };
      });
      assert(impact != null && back != null, `#${tier} ${big ? 'counter' : 'ordinary'}: hit and guard back`);
      assert(back >= 560 && back <= 760, `#${tier} ${big ? 'counter' : 'ordinary'} hit: guard back ${Math.round(back)} ms (real) after the impact`);
    }
  }
});

test('combat-fix RULES-02: a second head jab 0.4 s (real) after an ordinary first hit lands on #5/#7/#8 (t-reel-big)', () => {
  for (const tier of [5, 7, 8]) {
    let landed = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const h = stallSession(passive(ROSTER[tier - 1]), seed * 31);
      assert(h.until(() => h.s.match.phase === MatchPhase.FIGHTING && h.s.view.stage === 'live'));
      h.run(1200, () => ({ control: ctl({ guard: 'high', guardAmount: 1 }), events: [] }));
      const ai = h.s.match.ais.p2; const read = ai.readFor.bind(ai); let first = true;
      ai.readFor = (p, t, self) => { if (first) { first = false; return 'open'; } return read(p, t, self); };
      let impact = null, sent1 = false, sent2 = false;
      h.run(2500, () => {
        const hit = h.log.find((e) => e.n === Ev.MATCH_HIT && e.p.attacker === 'p1');
        if (hit && impact == null) impact = hit.real;
        if (!sent1) { sent1 = true; return { control: ctl(), events: [jab('left')] }; }
        if (impact != null && !sent2 && h.real - impact >= 400) { sent2 = true; return { control: ctl(), events: [jab('right')] }; }
        return { control: ctl(), events: [] };
      });
      const outs = h.log.filter((e) => e.p && e.p.attacker === 'p1' && [Ev.MATCH_HIT, Ev.MATCH_BLOCK, Ev.MATCH_DODGE].includes(e.n));
      if (outs.length >= 2 && outs[1].n === Ev.MATCH_HIT) landed++;
    }
    assert.equal(landed, 4, `#${tier}: ${landed}/4 second jabs landed`);
  }
});

test('combat-fix RULES-05: "Down" ~0.9 s and "1" inside 1.3–2.9 s after a real knockdown blow (the 0.7 s stall counted once)', () => {
  const downs = [], ones = [];
  for (let seed = 1; seed <= 12; seed++) {
    const h = stallSession(passive(ROSTER[0], { headGuard: 0, bodyGuard: 0, slipPct: 0, coverUpPct: 0, streakBlock: 0, postReelGuardMs: 0 }), seed * 7);
    assert(h.until(() => h.s.match.phase === MatchPhase.FIGHTING && h.s.view.stage === 'live'));
    h.run(800);
    h.s.match.debugSetHp('p2', 0.5);
    let sent = false;
    h.until(() => h.log.some((e) => e.n === Ev.MATCH_COUNT), () => { if (!sent) { sent = true; return { control: ctl(), events: [jab('left')] }; } return null; }, 8000);
    const blow = h.log.find((e) => e.n === Ev.MATCH_HIT && e.p.knockdown);
    const down = h.log.find((e) => e.n === Ev.MATCH_CALL && e.p.call === 'down');
    const one = h.log.find((e) => e.n === Ev.MATCH_COUNT);
    assert(blow && down && one, 'a real knockdown blow, "Down" and "1"');
    assert(!blow.p.synthetic, 'a real blow');
    downs.push(down.real - blow.real); ones.push(one.real - blow.real);
  }
  downs.sort((a, b) => a - b); ones.sort((a, b) => a - b);
  const med = downs[downs.length >> 1];
  assert(downs[0] >= 650 && downs[downs.length - 1] <= 1450, `blow → "Down" ${downs.map(Math.round).join(',')}`);
  assert(med >= 750 && med <= 1150, `median ${Math.round(med)} ms (§3.1: ≈ 0.9 s)`);
  assert(ones[0] >= 1300 && ones[ones.length - 1] <= 2900, `blow → "1" ${ones.map(Math.round).join(',')}`);
  assert.deepEqual(RULES.downCallMs, [0, 700, 100], 'game ms, net of the knockdown hit-stop');
});

test('combat-fix RULES-05: the AI cover-up lasts ~0.9 s of REAL time after the second quick hit (its hit-stop netted out)', () => {
  for (const gapReal of [250, 820]) { // the 2nd hit: a combo hit (heavy, 0.5 s stall) / an ordinary one (0.2 s)
    const h = stallSession(passive(ROSTER[6], { coverUpPct: 1, slipPct: 0, punishPct: 0 }), 7);
    assert(h.until(() => h.s.match.phase === MatchPhase.FIGHTING && h.s.view.stage === 'live'));
    h.run(1000, () => ({ control: ctl({ guard: 'high', guardAmount: 1 }), events: [] }));
    const ai = h.s.match.ais.p2; const read = ai.readFor.bind(ai); let forced = 0;
    ai.readFor = (p, t, self) => (forced++ < 2 ? 'open' : read(p, t, self));
    let first = null, sent = 0, start = null, end = null;
    h.run(3500, () => {
      const m = h.s.match; const cov = m.boxers.p2.isCovering(m.wt);
      if (cov && start == null) start = h.real;
      if (!cov && start != null && end == null) end = h.real;
      const hit = h.log.find((e) => e.n === Ev.MATCH_HIT && e.p.attacker === 'p1');
      if (hit && first == null) first = hit.real;
      if (sent === 0) { sent = 1; return { control: ctl(), events: [jab('left')] }; }
      if (sent === 1 && first != null && h.real - first >= gapReal) { sent = 2; return { control: ctl(), events: [jab('right')] }; }
      return { control: ctl(), events: [] };
    });
    const hits = h.log.filter((e) => e.n === Ev.MATCH_HIT && e.p.attacker === 'p1');
    assert(hits.length === 2 && start != null && end != null, `${gapReal}: covered`);
    assert(end - start >= 820 && end - start <= 1000, `cover after a ${hits[1].p.heavy ? 'heavy' : 'ordinary'} 2nd hit lasts ${Math.round(end - start)} ms real (§2.7: 0.9–1.0 s)`);
  }
});
