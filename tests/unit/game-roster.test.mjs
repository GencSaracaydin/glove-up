// game/roster.js — the ten original opponents mapped onto research/mechanics.md §4.5 (ladder order,
// base ratings, offence / defence / knockout numbers) and the derived counter windows.
import { test, assert } from '../harness.mjs';
import { ROSTER, ROSTER_BY_ID, RATINGS, opponentById, opponentByTier, CHAMPION, whiffRecoverForHang } from '../../src/game/roster.js';
import { OpponentAI, AI_DEFAULTS, aiParams } from '../../src/game/ai.js';
import { Boxer } from '../../src/game/boxer.js';
import { COMBAT } from '../../src/game/combat.js';
import { APPEARANCE_OPTIONS } from '../../src/core/types.js';
import { Rng } from '../../src/core/rng.js';

const HEX = /^#[0-9a-f]{6}$/i;

test('roster: ten original opponents, tiers 1..10, unique ids and names, one-line intros', () => {
  assert.equal(ROSTER.length, 10);
  ROSTER.forEach((d, i) => {
    assert.equal(d.tier, i + 1);
    for (const k of ['id', 'name', 'nickname', 'intro', 'style']) assert(typeof d[k] === 'string' && d[k].length > 1, `${d.id}.${k}`);
    assert(d.intro.length <= 90, `${d.id} intro is a one-liner`);
  });
  assert.equal(new Set(ROSTER.map((d) => d.id)).size, 10);
  assert.equal(new Set(ROSTER.map((d) => d.name)).size, 10);
  assert.equal(opponentById(ROSTER[3].id), ROSTER[3]);
  assert.equal(opponentById('nobody'), null);
  assert.equal(opponentByTier(99), CHAMPION);
  assert.equal(ROSTER_BY_ID[CHAMPION.id].tier, 10);
});

test('roster: base ratings follow §4.5 in ladder order (120 … 1600); skillRequired still climbs', () => {
  assert.deepEqual(ROSTER.map((d) => d.rating), [120, 280, 450, 600, 750, 900, 1050, 1200, 1400, 1600]);
  assert.deepEqual([...RATINGS], ROSTER.map((d) => d.rating));
  assert.equal(ROSTER[0].skillRequired, 0);
  for (let i = 1; i < ROSTER.length; i++) assert(ROSTER[i].skillRequired > ROSTER[i - 1].skillRequired);
});

test('roster: appearances only use our own feature kit', () => {
  const O = APPEARANCE_OPTIONS;
  for (const d of ROSTER) {
    const a = d.appearance;
    assert(HEX.test(a.skin) && O.hairStyles.includes(a.hair.style) && HEX.test(a.hair.color), d.id);
    assert(O.eyes.includes(a.eyes) && O.brows.includes(a.brows) && O.mouths.includes(a.mouth), d.id);
    assert(O.noses.includes(a.nose) && O.accessories.includes(a.accessory) && O.builds.includes(a.build), d.id);
    for (const k of ['trunks', 'trim', 'gloves', 'shoes']) assert(HEX.test(a[k]), `${d.id}.${k}`);
    assert(a.top === 'none' || HEX.test(a.top), `${d.id}.top`);
    assert(a.height >= 0.9 && a.height <= 1.1, `${d.id}.height`);
  }
});

test('roster: every opponent carries the §4.5a/b numbers in sane ranges, in wedges', () => {
  for (const d of ROSTER) {
    const a = d.ai, id = d.id;
    assert.equal(d.stats.hp, 10, `${id}: a 10-wedge pie`);
    assert(a.firstAttackMs >= 300 && a.firstAttackMs <= 3500, `${id} first attack`);
    assert(a.attackGapMs >= 1000 && a.attackGapMs <= 8000, `${id} gap`);
    assert(a.tellMs >= COMBAT.minTellMs && a.tellMs <= 450, `${id} ordinary tell 0.17–0.45 s`);
    assert(Array.isArray(a.stringWeights) && a.stringWeights.length >= 1 && a.stringWeights.length <= 4, `${id} strings of 1–4`);
    assert(a.bodyPct > 0 && a.bodyPct <= 0.6, `${id} body %`);
    assert(a.ordinaryDamage >= 1 && a.ordinaryDamage <= 1.2, `${id} ordinary damage 1.0–1.2 wedges (§2.6)`);
    if (a.powerPct > 0) assert(a.powerDamage >= 2 && a.powerDamage <= 4 && a.powerTellMs >= 400, `${id} power punch`);
    for (const k of ['headGuard', 'bodyGuard', 'slipPct', 'punishPct', 'punchIntoPct', 'coverUpPct']) assert(a[k] >= 0 && a[k] <= 1, `${id}.${k}`);
    assert(a.bodyGuard <= a.headGuard, `${id}: the head is guarded more than the body`);
    assert(a.reelMs >= 500 && a.reelMs <= 700, `${id} reel 0.5–0.7 s (§2.7)`);
    assert(a.missRecoveryMs >= 300 && a.missRecoveryMs <= 800, `${id} miss recovery`);
    assert.equal(a.whiffRecoverMs, whiffRecoverForHang(a.missRecoveryMs), `${id} derived counter window`);
    assert(a.stayDown.length === 3 && a.riseMean.length === 3, `${id} KO table`);
    for (let k = 0; k < 3; k++) assert(a.stayDown[k] >= 0 && a.stayDown[k] <= 1 && a.riseMean[k] >= 3 && a.riseMean[k] <= 9, `${id} KO row ${k}`);
    for (let k = 1; k < 3; k++) assert(a.stayDown[k] >= a.stayDown[k - 1], `${id}: more likely to stay down each time`);
  }
});

test('roster: the ramp — KO resistance, mean knockdowns to KO, shorter tells, punishment and power from the middle on (§4.4)', () => {
  const kdToKo = (d) => { // expected knockdowns to a KO from the stay-down table (4th always)
    let alive = 1, e = 0;
    for (let k = 0; k < 3; k++) { e += (k + 1) * alive * d.ai.stayDown[k]; alive *= 1 - d.ai.stayDown[k]; }
    return e + 4 * alive;
  };
  const ladder = ROSTER.map(kdToKo);
  assert(ladder[0] < 2 && ladder[9] > 3.2, `1.6 → 3.4 knockdowns to KO: ${ladder.map((x) => x.toFixed(2))}`);
  for (let i = 4; i < 10; i++) assert(ladder[i] > ladder[0] + 1, `${ROSTER[i].id} is much harder to keep down`);
  assert(ROSTER[0].ai.stayDown[0] >= 0.3 && CHAMPION.ai.stayDown[0] === 0, 'the champion never stays down on the first knockdown');
  assert(CHAMPION.ai.tellMs < ROSTER[0].ai.tellMs, 'tells barely shorten (§4.4), but they do');
  assert(ROSTER[0].ai.punishPct === 0 && ROSTER.slice(4).every((d) => d.ai.punishPct >= 0.3), 'punishing blocked punches from the middle on');
  assert(ROSTER[0].ai.powerPct === 0 && ROSTER[1].ai.powerPct === 0 && ROSTER.slice(2).every((d) => d.ai.powerPct > 0), 'power punches from #3');
  assert(CHAMPION.ai.attackGapByRound[0] > CHAMPION.ai.attackGapByRound[1], 'the champion is cagey in round 1, then presses');
  assert(ROSTER[0].ai.guardStyle === 'open', 'the sparring partner keeps the gloves open (§4.1.2)');
  assert(ROSTER[5].ai.holdWhileLeanMs === 1000, 'the patient power puncher holds a cocked punch up to 1 s (§4.3)');
  assert(ROSTER[8].ai.punchIntoPct > 0 && CHAMPION.ai.punchIntoPct > 0 && ROSTER[3].ai.punchIntoPct === 0, 'punching into your punches only at the top');
  for (const d of ROSTER) {
    const p = aiParams(d);
    for (const k of Object.keys(AI_DEFAULTS)) assert(p[k] !== undefined, `${d.id} ${k}`);
  }
});

test('roster: the derived counter window — the missed glove hangs as long as measured, slow motion included', () => {
  // hang = judging delay (latency + grace) + the world-time recovery stretched by the slow motion
  for (const hang of [500, 650, 800]) {
    const w = whiffRecoverForHang(hang);
    const real = COMBAT.latencyMs + COMBAT.defenseGraceMs + w / COMBAT.slowmoScale;
    assert(Math.abs(real - hang) < 5, `${hang} → ${w} world ms → ${real} real`);
  }
  assert(whiffRecoverForHang(100) >= 40);
});

test('ai: OpponentAI only requests legal, telegraphed punches against an idle foe', () => {
  for (const d of [ROSTER[0], ROSTER[5], CHAMPION]) {
    const ai = new OpponentAI(d, new Rng(d.tier));
    const self = new Boxer({ id: 'p2', isHuman: false, stats: d.stats, ai: d.ai });
    const foe = new Boxer({ id: 'p1', isHuman: true });
    let t = 0, n = 0, body = 0;
    for (let i = 0; i < 3000; i++) {
      t += 20;
      foe.setControl({ tracked: true, guard: 'high', guardAmount: 1, lean: { x: 0, y: 0, z: 0 }, hands: null, activity: 0 }, t);
      const intent = ai.update(0.02, t, self, foe, { phase: 'fighting' });
      self.applyIntent(intent, t);
      if (intent.punch) {
        assert(intent.punch.windupMs >= COMBAT.minWindupMs && intent.punch.tellMs >= COMBAT.minTellMs);
        assert(['left', 'right'].includes(intent.punch.hand) && ['straight', 'hook', 'uppercut'].includes(intent.punch.kind));
        if (self.startWindup(intent.punch, t)) { n++; if (intent.punch.target === 'body') body++; }
      }
      for (const note of self.update(t)) if (note.type === 'thrown') { ai.onPunchThrown(note.punch); self.onPunchResolved(note.punch, { result: 'blocked' }, note.punch.impactAt); }
    }
    assert(n >= 5, `${d.id} attacked ${n} times in 60 s`);
    assert(body / n < d.ai.bodyPct + 0.25, `${d.id} body share near its bodyPct (${body}/${n})`);
  }
});
