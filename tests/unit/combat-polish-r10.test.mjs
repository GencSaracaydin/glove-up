// Polish round (combat), decision R10 — degenerate keyboard play must not beat a first-timer's results (each strategy wins
// at most the casual bot's rate + 10 points against #5–#10 and is floored in ≥ 30 % of bouts against #8–#10), without
// costing ordinary play (research/mechanics.md §2.3 / §4.2: PRO opponents punish nearly every blocked punch, 0.2–0.82 s
// after the green ring; no cock-and-lower feints).
//
// Mashing into the guard. The reference's own answer (§2.4): "the main way the player gets hurt is an AI counter 0.2–0.82 s
// after a green ring, which lands while the player's glove is still out". A keyboard guard is back up 0.3 s after each
// punch, so a punish at the measured delay lands on it. From #5 up, against a player who keeps punching into the guard
// (blocked again within 1.3 s of an earlier green ring, or on a steady beat), the punish waits unseen for the next punch:
// the opponent's gloves are set for it, it is caught, and the counter lands while that glove is out (punch-into timing,
// §4.1.4). Every other punish goes as measured. (Our own design, E.)
//
// Going to the body every time. From #5 up the body read follows the player's habit: when most recent punches go to the
// body it rises toward the head read, the gloves rest low and a cover-up covers the body (§2.4 "dropping one glove can
// block a body shot"; E). Before, Space or B + Shift with J/K every 0.45–1.2 s beat every PRO opponent 96–100 %.
//
// Bobbing. A dodge is a reaction to an attack. Dipping into a posture again and again with no attack coming (a key pulsed
// on a rhythm) is bobbing: those dodges evade but earn neither the slow motion nor a counter (Match._bobbing,
// COMBAT.freshDodgeBob*). Only postures begun while the clock runs count (a crouch during a stoppage is no bobbing).
import { test, assert } from '../harness.mjs';
import { Match } from '../../src/game/match.js';
import { Boxer } from '../../src/game/boxer.js';
import { COMBAT } from '../../src/game/combat.js';
import { ROSTER } from '../../src/game/roster.js';
import { OpponentAI, AI_DEFAULTS } from '../../src/game/ai.js';
import { EventBus } from '../../src/core/events.js';
import { Ev, MatchPhase } from '../../src/core/types.js';
import { Rng } from '../../src/core/rng.js';
import { hitStopMsFor } from '../../src/render/fx.js';
import { KeyboardInput } from '../../src/input/keyboard.js';
import { simulateBout } from '../../dev/sim.mjs';

// ── the R10 bout: degenerate keyboard play with the real KeyboardInput module, on the renderer's hit-stop clock
// (fx.hitStopMsFor, game dt ×0.02 while stalled), the real presentation RULES and latency 40 ms at 60 fps — the loop of
// the repair verifier's v-turtle.mjs ─────────────────────────────────────────────────────────────────────────────────
const KEYS = { S: 'KeyS', W: 'KeyW', A: 'KeyA', D: 'KeyD', X: 'KeyX', B: 'KeyB', Space: 'Space', Sh: 'ShiftLeft' };
const DT = 1000 / 60;

/**
 * @param {Object} opp roster entry
 * @param {string} keys held all bout, e.g. 'Space', 'S+B', 'A+S+B', 'Space+Sh' (Shift: every punch to the body)
 * @param {number} seed
 * @param {{mash?:number, tap?:boolean, pulse?:[number, number]}} [o]  mash: J/K every this many ms while live; tap: J/K
 *        220–420 ms after each dodge it sees; pulse: the first key on for [0] ms, off for [1] ms
 */
function kbBout(opp, keys, seed, o = {}) {
  const bus = new EventBus();
  let real = 0, game = 0, stall = 0;
  const m = new Match({ bus, mode: 'single', p1: { name: 'K', isHuman: true }, p2: opp, rng: seed, id: 'kb', latencyMs: 40 });
  const c = { dodges: 0, fresh: 0, aiHits: 0 };
  bus.on('*', (name, p) => {
    if (name === Ev.MATCH_HIT) {
      const ms = hitStopMsFor(p, (id) => id === 'p1');
      if (ms > 0) stall = Math.max(stall, Math.min(ms, 1000));
      if (p.attacker === 'p2') c.aiHits++;
    } else if (name === Ev.MATCH_DODGE && p.defender === 'p1') { c.dodges++; if (p.fresh !== false) c.fresh++; }
  });
  const kb = new KeyboardInput({ players: 1 });
  const rng = new Rng(seed * 11 + 5);
  const holds = keys.split('+').map((k) => KEYS[k]);
  const taps = [];
  let held = false, seen = 0, hand = 0, mashNext = 0, downNext = 0, on = true, flip = 0;
  m.start(0);
  while (m.phase !== 'result' && real < 30 * 60 * 1000) {
    const v = m.getView();
    const live = v.phase === 'fighting' && v.stage === 'live';
    if (!held && v.phase === 'fighting') { for (const k of holds) kb.handleKey(k, true, { t: real }); held = true; if (o.pulse) flip = real + o.pulse[0]; }
    if (o.pulse && held && v.phase === 'fighting' && real >= flip) { on = !on; kb.handleKey(holds[0], on, { t: real }); flip = real + (on ? o.pulse[0] : o.pulse[1]); }
    if (c.dodges > seen) { seen = c.dodges; if (o.tap) taps.push({ at: real + 220 + rng.float() * 200, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); }
    if (o.mash > 0 && live && real >= mashNext) { taps.push({ at: real, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); mashNext = real + o.mash; }
    if (m.boxers.p1.down && real >= downNext) { taps.push({ at: real, code: hand++ % 2 ? 'KeyJ' : 'KeyK' }); downNext = real + 150; }
    for (const tp of taps) {
      if (!tp.sent && real >= tp.at) { kb.handleKey(tp.code, true, { t: real }); tp.sent = true; }
      else if (tp.sent && !tp.up && real >= tp.at + 45) { kb.handleKey(tp.code, false, { t: real }); tp.up = true; }
    }
    if (taps.length > 64) for (let i = taps.length - 1; i >= 0; i--) if (taps[i].up) taps.splice(i, 1);
    const scale = stall > 0 ? 0.02 : 1;
    game += DT * scale;
    m.update((DT * scale) / 1000, game, { p1: kb.update(real, 0) }, { stalled: scale < 1 });
    stall = Math.max(0, stall - DT);
    real += DT;
  }
  return { result: m.getResult(), ...c, ai: m.ais.p2 };
}

/** Wins and floored bouts of a strategy against one opponent over n bouts (seeds as the R10 matrix: 9001 + 97 i + 7 tier). */
function kbCell(opp, keys, n, o = {}) {
  let win = 0, floored = 0, fresh = 0, dodges = 0;
  for (let i = 0; i < n; i++) {
    const b = kbBout(opp, keys, 9001 + i * 97 + opp.tier * 7, o);
    if (b.result.winner === 'p1') win++;
    if (b.result.knockdowns.p1 > 0) floored++;
    fresh += b.fresh; dodges += b.dodges;
  }
  return { win, floored, fresh, dodges, n };
}

// ── punishes: as measured for ordinary play, into the glove for a masher ──────────────────────────────────────────────

const guardCtl = (guard) => ({
  tracked: true, confidence: 1, guard, guardAmount: guard === 'none' ? 0 : 1, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.25, y: 0.5, reach: 0.1, punching: false }, right: { x: 0.25, y: 0.5, reach: 0.1, punching: false } },
  activity: 0.2,
});
/** #7 that reads every head punch as a block and punishes every blocked one 0.4 s after the green ring (to the head),
 *  and never attacks on its own (not even a guard left down). */
const wall = { ...ROSTER[6], ai: { ...ROSTER[6].ai, punishPct: 1, headGuard: 1, punishDelayMs: [400, 400], firstAttackMs: 1e9, attackGapMs: 1e9, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, feintChance: 0, smartTargeting: 0, openFoePressure: 0 } };

/** Head jabs at the given times (ms after the clock starts); the guard drops for 450 ms with each (as a keyboard
 *  punch drops it), otherwise high. Returns the event log with times relative to the clock start. */
function jabs(at, { ms = 4000, seed = 1 } = {}) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed, p2: wall, fast: true, id: 'glove', latencyMs: 60 });
  let t0 = 0;
  bus.on('*', (name, p) => log.push({ name, p, t: m.t - t0 }));
  let now = 0;
  m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: guardCtl('high'), events: [] } }); }
  t0 = m.t;
  let i = 0, off = -1;
  while (m.t - t0 < ms && m.phase === MatchPhase.FIGHTING) {
    now += DT;
    const events = [];
    if (i < at.length && m.t - t0 >= at[i]) { events.push({ type: 'punch', punch: { hand: i % 2 ? 'right' : 'left', kind: 'straight', target: 'head', power: 0.6 } }); off = m.t - t0 + 450; i++; }
    m.update(DT / 1000, now, { p1: { control: guardCtl(m.t - t0 < off ? 'none' : 'high'), events } });
  }
  const of = (n, f = () => true) => log.filter((e) => e.name === n && f(e.p));
  return {
    m, log,
    aiHits: of(Ev.MATCH_HIT, (p) => p.attacker === 'p2'),
    aiThrown: of(Ev.MATCH_PUNCH_THROWN, (p) => p.attacker === 'p2'),
    aiWindups: of(Ev.MATCH_WINDUP, (p) => p.attacker === 'p2'),
    rings: of(Ev.MATCH_BLOCK, (p) => p.attacker === 'p1'),
  };
}

test('combat-polish R10: an isolated blocked jab is punished as measured — the counter is thrown 0.2–0.82 s after the green ring, nothing is cocked and lowered', () => {
  const r = jabs([500], { ms: 2600 });
  assert.equal(r.rings.length, 1, 'the jab is blocked');
  const ring = r.rings[0].t;
  const thrown = r.aiThrown.filter((e) => e.p.counter);
  assert.equal(thrown.length, 1, `one counter thrown (before, in the first polish pass: none — it was cocked, held and lowered)`);
  const travel = COMBAT.punch.straight.aiTravelMs;
  assert(thrown[0].t + travel - ring >= 200 && thrown[0].t + travel - ring <= 820, `impact ${Math.round(thrown[0].t + travel - ring)} ms after the ring (§2.3: 0.2–0.82 s)`);
  assert.equal(r.aiWindups.length, r.aiThrown.length, `every wind-up is thrown (${r.aiWindups.length} wind-ups, ${r.aiThrown.length} thrown)`);
});

test('combat-polish R10: a player who keeps punching into the guard — the next jab is caught and countered while its glove is out, and nothing shows before', () => {
  // jabs 0.6 s apart: the first green ring is punished as measured (on the raised guard); the third comes within 1.3 s of an
  // earlier ring — mashing — so its punish waits, unseen, for the fourth jab
  const r = jabs([500, 1100, 1700, 2300], { ms: 3200 });
  const third = r.rings.find((e) => e.t > 1700 && e.t < 1900);
  assert(third, `the third jab is blocked (${r.rings.map((e) => Math.round(e.t)).join(', ')})`);
  const shown = r.aiWindups.filter((e) => e.t > third.t && e.t < 2300);
  assert.equal(shown.length, 0, `no wind-up between the third ring and the fourth jab (${shown.map((e) => Math.round(e.t)).join(', ')})`);
  const caught = r.rings.find((e) => e.t > 2300 && e.t < 2500);
  assert(caught, 'the fourth jab is caught (its gloves were set for it)');
  const hit = r.aiHits.find((e) => e.t >= 2300 && e.t <= 2300 + 450);
  assert(hit && hit.p.counter && hit.p.heavy, `it is countered while the glove is out (${r.aiHits.map((e) => Math.round(e.t)).join(', ')}); before, the punish landed on the raised guard`);
  assert.equal(r.aiWindups.length, r.aiThrown.length, 'every wind-up is thrown');
});

test('combat-polish R10: the wait ends — with no punch inside the window no punish is thrown (nothing cocked, nothing lowered)', () => {
  const r = jabs([500, 1100, 1700], { ms: 3800 });
  const third = r.rings.find((e) => e.t > 1700 && e.t < 1900);
  assert(third, 'the third jab is blocked');
  assert.equal(r.aiWindups.filter((e) => e.t > third.t).length, 0, 'no wind-up after the third ring');
  assert.equal(r.aiWindups.length, r.aiThrown.length, `every wind-up is thrown (${r.aiWindups.length}/${r.aiThrown.length})`);
  // the armed punish has expired: a jab long after it is a fresh exchange, punished as measured
  const ai = r.m.ais.p2;
  assert.equal(ai.punishArmed, null, 'nothing is still waiting');
});

test('combat-polish R10: a steady beat is read (a jab on a metronome is mashing too)', () => {
  const ai = new OpponentAI(ROSTER[9], 1);
  ai.foeBeat = [0, 1200, 2400, 3600];
  assert.equal(ai._foeBeatMs(), 1200, 'a 1.2 s beat');
  assert.equal(ai._armMs(), 1440, 'the wait: 1.2 × the beat');
  ai.foeBeat = [0, 600, 1200, 1800];
  assert.equal(ai._armMs(), AI_DEFAULTS.punishArmMs, 'never shorter than punishArmMs');
  ai.foeBeat = [0, 400, 2400, 2700];
  assert.equal(ai._foeBeatMs(), 0, 'no beat');
  ai.foeBeat = [0, 2200, 4400, 6600];
  assert.equal(ai._foeBeatMs(), 0, `slower than punishBeatMaxMs (${AI_DEFAULTS.punishBeatMaxMs} ms) is no masher's beat`);
  // the low tiers never wait: they punish as measured (rarely)
  for (let tier = 1; tier <= 4; tier++) assert.equal(ROSTER[tier - 1].ai.punishIntoGlove, 0, `#${tier}`);
});

test('combat-polish R10: guard-only mashers (Space + J/K every 0.55–1.2 s) lose to the PRO tier and get floored', () => {
  // the R10 matrix's own seeds (9001 + 97 i + 7 tier), 8 bouts each; before (repair round): 8, 7, 6, 8, 6 and 6 wins of 8
  for (const [tier, mash] of [[9, 600], [10, 600], [7, 700], [9, 550], [8, 1200], [10, 1200]]) {
    const c = kbCell(ROSTER[tier - 1], 'Space', 8, { mash });
    assert(c.win <= 2, `Space + J/K every ${mash} ms vs #${tier}: won ${c.win}/8`);
    assert(c.floored >= 6, `floored ${c.floored}/8`);
  }
});

test('combat-polish R10: in ordinary play every wind-up is thrown — no cock-and-lower feints (sim bots vs #7 and #10)', () => {
  // the first polish pass lowered 4–6 cocked punishes per live minute against these bots (0–0.3 before it)
  for (const tier of [7, 10]) for (const bot of ['casual', 'player']) {
    let lowered = 0, liveMs = 0;
    for (const seed of [1, 2, 3]) {
      const b = simulateBout({ opponent: ROSTER[tier - 1], bot, seed: 700 + seed * 13 + tier });
      lowered += b.windups.length - b.metrics.aiThrown;
      liveMs += b.metrics.liveMs;
    }
    const perMin = lowered / (liveMs / 60000);
    assert(perMin <= 1, `${bot} vs #${tier}: ${perMin.toFixed(2)} wind-ups per live minute never became a punch`);
  }
});

/** Punches at the given times (ms after the clock starts) against `opp`: each [at, 'head'|'body']; the guard drops for 450 ms
 *  with each and is high in between — or never shown (guardBetween false). */
function punchRun(opp, list, { ms = 4500, guardBetween = true } = {}) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed: 2, p2: opp, fast: true, id: 'mash', latencyMs: 60 });
  let t0 = 0;
  bus.on('*', (name, p) => log.push({ name, p, t: m.t - t0 }));
  let now = 0;
  m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: guardCtl('high'), events: [] } }); }
  t0 = m.t;
  let i = 0, off = -1;
  while (m.t - t0 < ms && m.phase === MatchPhase.FIGHTING) {
    now += DT;
    const events = [];
    if (i < list.length && m.t - t0 >= list[i][0]) { events.push({ type: 'punch', punch: { hand: i % 2 ? 'right' : 'left', kind: 'straight', target: list[i][1], power: 0.6 } }); off = m.t - t0 + 450; i++; }
    m.update(DT / 1000, now, { p1: { control: guardCtl(m.t - t0 < off || !guardBetween ? 'none' : 'high'), events } });
  }
  return { m, log };
}

test('combat-polish R10: a masher — a guard shown between quick punches, three times running — has every punch caught and countered, head or body', () => {
  // an opponent that blocks nothing by itself (head and body read 0, no set guard after a reel), punishes no green ring and
  // never attacks: only the mashing rule can make it catch. Head and body alternate every 0.6 s (before: all six landed)
  const sponge = { ...ROSTER[6], ai: { ...ROSTER[6].ai, headGuard: 0, bodyGuard: 0, streakBlock: 1, postReelGuardMs: 0, punishPct: 0, guardStyle: 'open',
    firstAttackMs: 1e9, attackGapMs: 1e9, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, feintChance: 0, openFoePressure: 0, bodyReadAdapt: 0 } };
  const list = [500, 1100, 1700, 2300, 2900, 3500].map((at, i) => [at, i % 2 ? 'body' : 'head']);
  const r = punchRun(sponge, list);
  const mine = r.log.filter((e) => (e.name === Ev.MATCH_HIT || e.name === Ev.MATCH_BLOCK) && e.p.attacker === 'p1');
  assert.equal(mine.length, 6, 'six punches decided');
  assert(mine.slice(0, 3).every((e) => e.name === Ev.MATCH_HIT), `the first three land (${mine.map((e) => e.name.split(':')[1]).join(' ')})`);
  assert(mine.slice(3).every((e) => e.name === Ev.MATCH_BLOCK), `from the fourth on every punch is caught (${mine.map((e) => e.name.split(':')[1]).join(' ')})`);
  const counters = r.log.filter((e) => e.name === Ev.MATCH_HIT && e.p.attacker === 'p2' && e.p.counter);
  assert(counters.length >= 2, `and countered while the glove is out (${counters.length} counters landed)`);
  // a burst with no guard between its punches is no mashing (a camera flurry): nothing is caught
  const burst = punchRun(sponge, list, { guardBetween: false });
  assert(!burst.log.some((e) => e.name === Ev.MATCH_BLOCK && e.p.attacker === 'p1'), 'no guard shown in between: nothing caught');
  // nor are punches 1.5 s apart (slower than punishMashMs), guard or not
  const slow = punchRun(sponge, [500, 2000, 3500, 5000, 6500].map((at) => [at, 'head']), { ms: 7200 });
  assert(!slow.log.some((e) => e.name === Ev.MATCH_BLOCK && e.p.attacker === 'p1'), 'punches 1.5 s apart: nothing caught');
});

// ── going to the body every time ──────────────────────────────────────────────────────────────────────────────────

test('combat-polish R10 (E): the body read follows the foe — a foe who only goes to the body meets the head read there; a normal mix does not', () => {
  const def = ROSTER[9];
  const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  const foe = new Boxer({ id: 'p1', isHuman: true });
  const body = (id, t) => ({ id, target: 'body', kind: 'straight', hand: 'left', thrownAt: t, impactAt: t + 100 });
  const ai = new OpponentAI(def, new Rng(1));
  assert(Math.abs(ai._readChance(false) - def.ai.bodyGuard) < 1e-9, 'a fresh bout: the roster body read');
  // (two or three body shots in a row — a normal mix has those — change nothing)
  for (let i = 0; i < 3; i++) ai._onFoePunch(1000 + 600 * i, self, foe, body(i + 1, 1000 + 600 * i));
  assert(Math.abs(ai._readChance(false) - def.ai.bodyGuard) < 1e-9 && ai._idleGuard(3000) === 'high', `three body shots: body read ${ai._readChance(false).toFixed(2)}`);
  for (let i = 3; i < 20; i++) ai._onFoePunch(1000 + 600 * i, self, foe, body(i + 1, 1000 + 600 * i));
  assert(ai._readChance(false) > def.ai.bodyGuard + 0.8 * (def.ai.headGuard - def.ai.bodyGuard), `twenty body shots in a row: body read ${ai._readChance(false).toFixed(2)} → head read ${def.ai.headGuard}`);
  assert.equal(ai._idleGuard(13000), 'low', 'the gloves rest low');
  // a normal mix (one body shot in five) keeps the roster value
  const mix = new OpponentAI(def, new Rng(2));
  for (let i = 0; i < 20; i++) mix._onFoePunch(1000 + 600 * i, self, foe, { ...body(i + 1, 1000 + 600 * i), target: i % 5 === 4 ? 'body' : 'head' });
  assert(Math.abs(mix._readChance(false) - def.ai.bodyGuard) < 1e-9 && mix._idleGuard(13000) === 'high', `a normal mix: body read ${mix._readChance(false).toFixed(2)}, guard high`);
  // the low tiers keep their open body
  const low = new OpponentAI(ROSTER[2], new Rng(3));
  for (let i = 0; i < 20; i++) low._onFoePunch(1000 + 600 * i, self, foe, body(i + 1, 1000 + 600 * i));
  assert(Math.abs(low._readChance(false) - ROSTER[2].ai.bodyGuard) < 1e-9, '#3 never adapts');
});

test('combat-polish R10: body mashers (Space or B held + Shift, J/K every 0.6 s) lose to the PRO tier and get floored', () => {
  // before: 8 of 8 against every one of these (the verifier's matrix: 96–100 % against all of #5–#10)
  for (const [keys, tier] of [['Space+Sh', 10], ['Space+Sh', 7], ['Space+Sh', 9], ['B+Sh', 8]]) {
    const c = kbCell(ROSTER[tier - 1], keys, 8, { mash: 600 });
    assert(c.win <= 2, `${keys} + J/K every 600 ms vs #${tier}: won ${c.win}/8`);
    assert(c.floored >= 6, `floored ${c.floored}/8`);
  }
});

// ── bobbing ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const ctl = (o = {}) => ({
  tracked: true, confidence: 1, guard: 'none', guardAmount: 0, lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
  hands: { left: { x: -0.3, y: 0.2, reach: 0.2, punching: false }, right: { x: 0.3, y: 0.2, reach: 0.2, punching: false } },
  activity: 0, ...o,
});
const DUCK = { x: 0, y: -1, z: 0 };
const UP = { x: 0, y: 0, z: 0 };
/** in a pulse: the duck for onMs, the stance for offMs */
const pulse = (t, onMs = 1100, offMs = 500) => (t % (onMs + offMs)) < onMs;
/** an opponent that jabs at the head about every 1.2 s and does nothing else (the dodge rules alone) */
const jabber = { ...ROSTER[4], id: 'jabber', ai: { ...ROSTER[4].ai, firstAttackMs: 600, attackGapMs: 1200, stringWeights: [1], powerPct: 0, bodyPct: 0,
  punchMix: { straight: 1, hook: 0, uppercut: 0 }, punishPct: 0, slipPct: 0, punchIntoPct: 0, coverUpPct: 0, feintChance: 0, holdWhileLeanMs: 0,
  postureAnswerPct: 0, postureDutyPct: 0, headGuard: 0, bodyGuard: 0 } };

/** 12 s of live fight against the jabber: lean(tLive, windupAge) → the player's lean; returns the dodges after 3 s. */
function dodgeRun(leanFn, seed = 4) {
  const bus = new EventBus();
  const log = [];
  const m = new Match({ bus, seed, p2: jabber, fast: true, id: 'bob' });
  bus.on('*', (name, p) => log.push({ name, p, t: m.t }));
  let now = 0;
  m.start(0);
  while (m.phase !== MatchPhase.FIGHTING) { now += DT; m.update(DT / 1000, now, { p1: { control: ctl({ guard: 'low', guardAmount: 1 }), events: [] } }); }
  const t0 = m.t;
  let tell = null;
  while (m.t - t0 < 12000 && m.phase === MatchPhase.FIGHTING) {
    now += DT;
    const w = m.boxers.p2.windup;
    if (w && (!tell || tell.id !== w.id)) tell = { id: w.id, at: m.t };
    if (m.boxers.p1.hp < 3) m.debugSetHp('p1', 10);
    const lean = leanFn(m.t - t0, tell ? m.t - tell.at : Infinity);
    m.update(DT / 1000, now, { p1: { control: ctl({ guard: 'low', guardAmount: 1, lean }), events: [] } });
  }
  const after = (e) => e.t - t0 > 3000;
  return {
    dodges: log.filter((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1' && after(e)),
    slowmos: log.filter((e) => e.name === Ev.MATCH_SLOWMO && after(e)),
  };
}

test('combat-polish R10: short dips on a rhythm are bobbing — they still evade, but no dodge is fresh and no slow motion follows', () => {
  // S pulsed 0.45 s on / 0.9 s off: before, 7 dips in 10 were fresh (the share of time in postures stayed under the old bar)
  for (const [on, off] of [[450, 900], [400, 800], [1100, 500]]) {
    const r = dodgeRun((t) => (pulse(t, on, off) ? DUCK : UP));
    assert(r.dodges.length >= 2, `${on}/${off}: dips still evade (${r.dodges.length})`);
    assert(r.dodges.every((e) => e.p.fresh === false), `${on}/${off}: bobbing dodges are not fresh (${r.dodges.map((e) => e.p.fresh).join(' ')})`);
    assert.equal(r.slowmos.length, 0, `${on}/${off}: no slow motion`);
  }
});

test('combat-polish R10: a dodge that answers an attack stays fresh — ducking every jab on its tell earns every slow motion', () => {
  // the duck goes in 120 ms after each wind-up appears and is held 0.6 s: as busy as the pulse above, but every dip answers
  // a punch (before, the share of time spent ducking made half of these "bobbing")
  const r = dodgeRun((t, age) => (age >= 120 && age < 720 ? DUCK : UP));
  assert(r.dodges.length >= 4, `dodges ${r.dodges.length}`);
  assert(r.dodges.every((e) => e.p.fresh !== false), `all fresh (${r.dodges.map((e) => e.p.fresh).join(' ')})`);
  assert.equal(r.slowmos.length, r.dodges.length, 'a slow motion for each');
});

test('combat-polish R10: a posture taken while the clock is stopped is no bobbing — crouched before "Fight!", the first dodge is fresh', () => {
  // the verifier's case: the player rests in a duck before the clock starts (or between rounds), stands in a high guard at
  // "Fight!", and ducks the first head attack on its tell. Before (an EMA of the time spent in postures that ran through the
  // stoppage): 2 of 9 such dodges were fresh against #10, 2 of 18 against #5.
  let tried = 0, fresh = 0;
  for (const [tier, seed] of [[10, 1], [10, 2], [5, 3], [5, 4], [8, 5], [10, 6]]) {
    const bus = new EventBus();
    const log = [];
    const m = new Match({ bus, mode: 'single', p1: { name: 'Cam', isHuman: true }, p2: ROSTER[tier - 1], rng: 700 + seed * 11, id: 'bp', latencyMs: 110 });
    bus.on('*', (name, p) => log.push({ name, p }));
    let now = 0, dodgeAt = null, seenW = 0, done = false;
    m.start(0);
    while (!done && now < 60000 && m.phase !== MatchPhase.RESULT) {
      now += DT;
      const v = m.getView();
      let lean = UP;
      if (v.phase !== MatchPhase.FIGHTING) lean = DUCK; // resting crouched through the intro and the "Fight!" call
      else {
        const w = v.boxers.p2.windup;
        if (w && w.id !== seenW && dodgeAt == null && w.target !== 'body') { seenW = w.id; dodgeAt = now + 250; }
        if (dodgeAt != null && now >= dodgeAt && now < dodgeAt + 600) lean = { x: 0.8, y: 0, z: 0 };
        if (dodgeAt != null && now >= dodgeAt + 900) done = true;
      }
      m.update(DT / 1000, now, { p1: { control: ctl({ guard: 'high', guardAmount: 1, lean }), events: [] } });
    }
    const d = log.find((e) => e.name === Ev.MATCH_DODGE && e.p.defender === 'p1');
    if (d) { tried++; if (d.p.fresh !== false) fresh++; }
  }
  assert(tried >= 3, `dodges made (${tried})`);
  assert.equal(fresh, tried, `every first dodge after "Fight!" is fresh (${fresh}/${tried})`);
});

test('combat-polish R10: pulse turtles (S held 1.1 s / 0.5 s, 0.8 / 0.45 or 0.45 / 0.9, a guard, a tap after each dodge) lose and get floored', () => {
  // before (repair round, the same 8 bouts): 8, 7 and 7 wins of 8 with the long pulses; the first polish pass still lost
  // 7–8 of 8 against #5 to the short ones (0.45 s dips)
  for (const [keys, tier, p] of [['S+B', 5, [1100, 500]], ['S+B', 9, [800, 450]], ['S+B', 5, [450, 950]], ['S+Space', 5, [500, 900]], ['S+Space', 7, [500, 900]], ['S+B', 9, [400, 800]]]) {
    const c = kbCell(ROSTER[tier - 1], keys, 6, { pulse: p, tap: true });
    assert(c.win <= 1, `${keys} pulsed ${p.join('/')} vs #${tier}: won ${c.win}/6`);
    if (tier >= 8) assert(c.floored >= 4, `floored ${c.floored}/6`);
    // (a dip right after the clock starts, before any bobbing shows, may still be fresh)
    assert(c.fresh <= 2 * c.n, `fresh dodges ${c.fresh} in ${c.n} bouts (before: up to ~9 a bout)`);
  }
});

test('combat-polish R10: combined postures with a low guard that mash J/K every 0.6 s lose to the champion and to #7', () => {
  // before: A+S+B 3/8 vs #10 and 5/8 vs #7, A+S+X+B 5/8 vs #10
  for (const [keys, tier] of [['A+S+B', 10], ['D+W+B', 10], ['A+S+X+B', 10], ['A+S+B', 7]]) {
    const c = kbCell(ROSTER[tier - 1], keys, 8, { mash: 600 });
    assert(c.win <= 1, `${keys} + J/K every 600 ms vs #${tier}: won ${c.win}/8`);
    assert(c.floored >= 7, `floored ${c.floored}/8`);
  }
});

test('combat-polish R10 (E): a posture the foe keeps bobbing back into is answered as that posture, also between two dips', () => {
  const def = { ...ROSTER[6], ai: { ...ROSTER[6].ai } };
  const ai = new OpponentAI(def, new Rng(3));
  const foe = new Boxer({ id: 'p1', isHuman: true });
  let t = 0;
  for (; t <= 8000; t += DT) { foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: pulse(t) ? DUCK : UP }), t); ai._trackPosture(t, foe); }
  // stand up between two dips: not leaning now, yet the posture counts as held and its answer is the uppercut
  while (pulse(t)) { t += DT; foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: pulse(t) ? DUCK : UP }), t); ai._trackPosture(t, foe); }
  t += 100; foe.setControl(ctl({ guard: 'low', guardAmount: 1 }), t); ai._trackPosture(t, foe);
  assert(ai.foeDuty >= AI_DEFAULTS.postureDutyPct, `duty ${ai.foeDuty.toFixed(2)}`);
  assert(ai._postureHeld(t), 'held while standing between two dips');
  const opts = ai._answerOptions(t, foe);
  assert(opts.length && opts.every(([o]) => o.kind === 'uppercut' && o.target === 'head'), `answers: ${opts.map(([o]) => `${o.target}:${o.kind}`).join(' ')}`);
  // a single dodge never reaches the duty bar
  const ai2 = new OpponentAI(def, new Rng(4));
  const foe2 = new Boxer({ id: 'p1', isHuman: true });
  for (let s = 0; s <= 4000; s += DT) { foe2.setControl(ctl({ lean: s >= 2000 && s < 2800 ? DUCK : UP }), s); ai2._trackPosture(s, foe2); }
  assert(ai2.foeDuty < AI_DEFAULTS.postureDutyPct && !ai2._postureHeld(4000), `one 0.8 s dodge: duty ${ai2.foeDuty.toFixed(2)}`);
});

test('combat-polish R10 (E): a posture held through a stoppage is still held at "Fight!" — the opponent follows it across clock restarts', () => {
  const ai = new OpponentAI(ROSTER[9], new Rng(5));
  const foe = new Boxer({ id: 'p1', isHuman: true });
  for (let t = 0; t <= 1300; t += DT) { foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: DUCK }), t); ai._trackPosture(t, foe); }
  assert(ai._postureHeld(1300), 'held');
  ai.reset(6000); // the clock restarts after a knockdown: the keys never left the duck
  foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: DUCK }), 6000);
  ai._trackPosture(6000, foe);
  assert(ai._postureHeld(6000), 'still held right after the restart (before: one more second of plain punches)');
  // the bobbing share (EMA over postureDutyMs) is not run down by a stoppage the opponent did not watch: a pulse turtle
  // whose key happens to be up at "Fight!" is still answered as bobbing (the share moves at most 100 ms per look)
  const ai2 = new OpponentAI(ROSTER[9], new Rng(9));
  const foe2 = new Boxer({ id: 'p1', isHuman: true });
  let t = 0;
  for (; t <= 8000; t += DT) { foe2.setControl(ctl({ guard: 'low', guardAmount: 1, lean: pulse(t) ? DUCK : UP }), t); ai2._trackPosture(t, foe2); }
  const before = ai2.foeDuty;
  assert(before >= AI_DEFAULTS.postureDutyPct, `bobbing before the stoppage (duty ${before.toFixed(2)})`);
  t += 12000; // a knockdown and its count: no FIGHTING frames, no looks
  ai2.reset(t);
  foe2.setControl(ctl({ guard: 'low', guardAmount: 1 }), t);
  ai2._trackPosture(t, foe2);
  assert(ai2.foeDuty >= before - 0.05 && ai2._postureHeld(t), `duty ${ai2.foeDuty.toFixed(2)} right after the restart (uncapped: ~0)`);
});

test('combat-polish R10 (E): against a held posture every blocked punch may be punished — not once per exchange', () => {
  const def = { ...ROSTER[9], ai: { ...ROSTER[9].ai, punishPct: 1 } };
  const ai = new OpponentAI(def, new Rng(6));
  const self = new Boxer({ id: 'p2', isHuman: false, ai: def.ai });
  self.applyIntent({ guard: 'high', lean: UP }, 0);
  const foe = new Boxer({ id: 'p1', isHuman: true });
  for (let t = 0; t <= 1300; t += DT) { foe.setControl(ctl({ guard: 'low', guardAmount: 1, lean: { x: -1, y: -1, z: 0 } }), t); ai._trackPosture(t, foe); }
  ai._onFoeOutcome(1300, self, foe, { id: 1, outcome: 'blocked', resolvedAt: 1300 });
  assert(ai.counterPlan && ai.counterPlan.reason === 'punish', 'the first block is punished');
  ai.counterPlan = null; // … that punish has been thrown and has landed
  ai._onFoeOutcome(1600, self, foe, { id: 2, outcome: 'blocked', resolvedAt: 1600 });
  assert(ai.punishArmed || (ai.counterPlan && ai.counterPlan.reason === 'punish'), 'the next blocked punch 0.3 s later is punished too (before: shared the exchange)');
  // without a held posture the exchange rule stands (RV-RULES-03)
  const ai2 = new OpponentAI(def, new Rng(7));
  ai2._onFoeOutcome(1300, self, null, { id: 1, outcome: 'blocked', resolvedAt: 1300 });
  ai2.counterPlan = null;
  ai2._onFoeOutcome(1600, self, null, { id: 2, outcome: 'blocked', resolvedAt: 1600 });
  assert.equal(ai2.counterPlan, null, 'one punish per blocked exchange otherwise');
  assert.equal(ai2.punishArmed, null, '(nothing waiting either)');
});
