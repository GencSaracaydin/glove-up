// PlayerAssigner: picks the real player among posters/bystanders, keeps P1/P2 identities
// through crossings and dropouts, P1 = left of the mirrored preview (larger raw x).
import { test, assert } from '../harness.mjs';
import { PlayerAssigner, ASSIGNER_TUNING, analyzePose } from '../../src/input/player-assigner.js';

const ASPECT = 0.75; // 640x480

/** Deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * A person facing the camera in RAW image coords (their left side at larger x).
 * x,y = shoulder centre; sw = shoulder width (normalized x units). live = arms move over time.
 */
function person({ x = 0.5, y = 0.42, sw = 0.22, vis = 0.95, t = 0, live = true, jitter = 0.0015, rand = Math.random, who = '?' } = {}) {
  const ya = 1 / ASPECT;
  const j = () => (rand() - 0.5) * 2 * jitter;
  const P = (dx, dy, v = vis) => ({ x: x + dx * sw + j(), y: y + dy * sw * ya + j(), z: 0, visibility: v });
  const w = live ? 0.35 * Math.sin(t / 260) : 0;
  const L = [];
  L[0] = P(0, -0.55);
  L[1] = P(0.06, -0.62); L[2] = P(0.09, -0.62); L[3] = P(0.12, -0.62);
  L[4] = P(-0.06, -0.62); L[5] = P(-0.09, -0.62); L[6] = P(-0.12, -0.62);
  L[7] = P(0.2, -0.58); L[8] = P(-0.2, -0.58);
  L[9] = P(0.05, -0.45); L[10] = P(-0.05, -0.45);
  L[11] = P(0.5, 0); L[12] = P(-0.5, 0);
  L[13] = P(0.62, 0.62 + w * 0.5); L[14] = P(-0.62, 0.62 - w * 0.5);
  L[15] = P(0.25, -0.25 + w); L[16] = P(-0.25, -0.25 - w);
  L[17] = P(0.28, -0.32 + w); L[18] = P(-0.28, -0.32 - w);
  L[19] = P(0.24, -0.36 + w); L[20] = P(-0.24, -0.36 - w);
  L[21] = P(0.2, -0.3 + w); L[22] = P(-0.2, -0.3 - w);
  L[23] = P(0.3, 1.45); L[24] = P(-0.3, 1.45);
  for (let i = 25; i < 33; i++) L[i] = P(i % 2 ? 0.3 : -0.3, 2.4, 0.2);
  return { image: L, world: L.map((l) => ({ x: 0, y: 0, z: 0, visibility: l.visibility })), score: vis, who };
}

const frame = (t, players) => ({ t, width: 640, height: 480, players });
const whoOf = (out, i) => (out.players[i] ? out.players[i].who : null);

/** Run a scenario: fn(t) → array of poses (detection order); returns outputs. */
function run(assigner, fromMs, toMs, fn, dt = 33) {
  const outs = [];
  for (let t = fromMs; t <= toMs; t += dt) outs.push(assigner.assign(frame(t, fn(t))));
  return outs;
}

test('assigner: analyzePose gives shoulder centre and width', () => {
  const g = analyzePose(person({ x: 0.4, y: 0.5, sw: 0.25, jitter: 0 }), ASPECT);
  assert(Math.abs(g.cx - 0.4) < 1e-9 && Math.abs(g.size - 0.25) < 1e-9, JSON.stringify(g));
});

test('assigner: a moving player becomes P1 within ~0.7 s and stays stable', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(1);
  const outs = run(a, 0, 3000, (t) => [person({ t, rand: r, who: 'me' })]);
  assert(outs[0].players[0] === null, 'needs a few frames before claiming');
  const firstIdx = outs.findIndex((o) => whoOf(o, 0) === 'me');
  assert(firstIdx >= ASSIGNER_TUNING.minHitsToClaim - 1 && firstIdx * 33 <= 700, `claimed at ${firstIdx * 33} ms`);
  assert(outs.slice(firstIdx).every((o) => whoOf(o, 0) === 'me'), 'P1 flickered');
  assert(a.presence[0] === true);
});

test('assigner: before anyone was found, the first person is trusted after a few frames', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(17);
  const outs = run(a, 0, 600, () => [person({ live: false, rand: r, who: 'still' })]);
  const firstIdx = outs.findIndex((o) => whoOf(o, 0) === 'still');
  assert(firstIdx >= 0 && firstIdx < ASSIGNER_TUNING.minHitsToClaim, `claimed at frame ${firstIdx}`);
});

test('assigner: after a player left, a still newcomer must first prove it is alive', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(15);
  run(a, 0, 1500, (t) => [person({ x: 0.5, t, rand: r, who: 'player' })]);
  run(a, 1533, 3500, () => []);
  // subtle sway only (not "moved", not static), and not the player coming back (another size): claimed once
  // the static window has passed
  const sway = (t) => { const p = person({ x: 0.45, sw: 0.15, t, rand: r, live: false, who: 'still' }); for (const i of [13, 14, 15, 16]) p.image[i].y += 0.011 * Math.sin(t / 400); return p; };
  const outs = run(a, 3533, 8000, (t) => [sway(t)]);
  const firstIdx = outs.findIndex((o) => whoOf(o, 0) === 'still');
  const ms = firstIdx * 33;
  assert(firstIdx >= 0 && ms >= ASSIGNER_TUNING.staticWindowMs - 50 && ms <= ASSIGNER_TUNING.staticWindowMs + 300, `claimed at ${ms} ms`);
});

test('assigner: the player detected again in place after a long dropout gets the slot back within ~1 s (INPUT-08)', () => {
  for (const seed of [15, 16, 17]) {
    const a = new PlayerAssigner({ players: 1 });
    const r = rng(seed);
    run(a, 0, 1500, (t) => [person({ x: 0.5, t, rand: r, who: 'player' })]);
    run(a, 1533, 4000, () => []);
    // back where they were, holding their guard: only a little sway
    const sway = (t) => { const p = person({ x: 0.5, t, rand: r, live: false, who: 'back' }); for (const i of [13, 14, 15, 16]) p.image[i].y += 0.011 * Math.sin(t / 400); return p; };
    const outs = run(a, 4033, 8000, (t) => [sway(t)]);
    const ms = outs.findIndex((o) => whoOf(o, 0) === 'back') * 33;
    assert(ms >= 0 && ms <= 1300, `seed ${seed}: slot back after ${ms} ms (a slow 2.5 s sway; before the fix ≈ 3 s)`);
  }
  // …but a cut-out of the player standing there (only jitter) still never gets it
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(19);
  run(a, 0, 1500, (t) => [person({ x: 0.5, t, rand: r, who: 'player' })]);
  run(a, 1533, 4000, () => []);
  const outs = run(a, 4033, 12000, () => [person({ x: 0.5, live: false, rand: r, who: 'poster' })]);
  assert(outs.every((o) => whoOf(o, 0) !== 'poster'), 'a static cut-out where the player stood claimed P1');
});

test('assigner: a poster alone at startup is dropped as soon as it proves static', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(18);
  const outs = run(a, 0, 4500, () => [person({ x: 0.3, sw: 0.15, live: false, rand: r, who: 'poster' })]);
  const lastP = outs.map((o) => whoOf(o, 0)).lastIndexOf('poster');
  assert(lastP * 33 <= ASSIGNER_TUNING.staticWindowMs + 100, `poster held P1 until ${lastP * 33} ms`);
  assert(outs[outs.length - 1].players[0] === null);
});

test('assigner: real player beats a smaller off-centre poster visible from the start', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(2);
  // detection order puts the poster first on purpose
  const outs = run(a, 0, 5000, (t) => [
    person({ x: 0.22, y: 0.4, sw: 0.13, live: false, rand: r, who: 'poster' }),
    person({ x: 0.58, y: 0.45, sw: 0.3, t, rand: r, who: 'player' }),
  ]);
  assert(outs.every((o) => whoOf(o, 0) !== 'poster'), 'poster chosen as P1');
  const settled = outs.filter((o, i) => i * 33 >= 800);
  assert(settled.every((o) => whoOf(o, 0) === 'player'), 'player should hold P1');
  assert(settled.every((o) => o.ignored.some((p) => p.who === 'poster')), 'poster should be reported as ignored');
});

test('assigner: player leaves and a poster appears only now (new track) — it never becomes P1', () => {
  // Real-detection regression: with the player present the detector often misses a small
  // poster; once the player is gone it suddenly reports it as a brand-new person.
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(16);
  run(a, 0, 3000, (t) => [person({ x: 0.68, sw: 0.3, t, rand: r, who: 'player' })]);
  const outs = run(a, 3033, 12000, () => [person({ x: 0.22, y: 0.4, sw: 0.09, live: false, rand: r, who: 'poster' })]);
  assert(outs.every((o) => whoOf(o, 0) !== 'poster'), `poster became P1 at ${outs.findIndex((o) => whoOf(o, 0) === 'poster') * 33} ms`);
  // the player walking back in (moving) gets P1 again
  const back = run(a, 12033, 13500, (t) => [person({ x: 0.22, y: 0.4, sw: 0.09, live: false, rand: r, who: 'poster' }), person({ x: 0.6, sw: 0.3, t, rand: r, who: 'player' })]);
  assert(whoOf(back[back.length - 1], 0) === 'player');
});

test('assigner: a poster alone is released after the static window (ERR02 can fire)', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(3);
  const outs = run(a, 0, 12000, () => [person({ x: 0.4, sw: 0.2, live: false, rand: r, who: 'poster' })]);
  const last = outs[outs.length - 1];
  assert(last.players[0] === null, 'static poster must not stay P1 forever');
  // and it never re-claims once known to be static
  const lastClaim = outs.map((o) => whoOf(o, 0)).lastIndexOf('poster');
  assert(lastClaim < outs.length - 30, 'poster re-claimed P1');
});

test('assigner: when the player walks away, the poster does NOT become P1', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(4);
  const poster = (t) => person({ x: 0.2, sw: 0.14, live: false, rand: r, who: 'poster', t });
  run(a, 0, 6000, (t) => [poster(t), person({ x: 0.55, sw: 0.28, t, rand: r, who: 'player' })]);
  assert(whoOf(a.assign(frame(6033, [poster(6033), person({ x: 0.55, sw: 0.28, t: 6033, rand: r, who: 'player' })])), 0) === 'player');
  const outs = run(a, 6066, 10000, (t) => [poster(t)]);
  assert(outs.every((o) => whoOf(o, 0) !== 'poster'), 'poster took over P1 after the player left');
  assert(outs[outs.length - 1].players[0] === null);
});

test('assigner: a player holding perfectly still (calibration "hold guard") keeps P1 next to a poster', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(14);
  const poster = () => person({ x: 0.18, sw: 0.13, live: false, rand: r, who: 'poster' });
  run(a, 0, 2000, (t) => [poster(), person({ x: 0.55, sw: 0.27, t, rand: r, who: 'player' })]);
  // now the player freezes for 6 s (only landmark jitter)
  const outs = run(a, 2033, 8000, () => [poster(), person({ x: 0.55, sw: 0.27, live: false, rand: r, who: 'player' })]);
  assert(outs.every((o) => whoOf(o, 0) === 'player'), 'still player lost P1');
});

test('assigner: a small bystander walking behind never steals P1', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(5);
  const outs = run(a, 0, 6000, (t) => {
    const ps = [person({ x: 0.5, sw: 0.26, t, rand: r, who: 'player' })];
    if (t > 1500 && t < 4500) ps.unshift(person({ x: 0.1 + (t - 1500) / 3000 * 0.8, y: 0.35, sw: 0.1, t, rand: r, who: 'bystander' }));
    return ps;
  });
  assert(outs.every((o) => whoOf(o, 0) !== 'bystander'), 'bystander stole P1');
  assert(outs.filter((o, i) => i * 33 >= 800).every((o) => whoOf(o, 0) === 'player'), 'player should hold P1');
});

test('assigner: a much better candidate takes over a slot after the hold time', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(6);
  // a bystander is alone first (gets P1), then the real player steps in close to the camera
  run(a, 0, 1500, (t) => [person({ x: 0.75, sw: 0.1, t, rand: r, who: 'bystander' })]);
  const outs = run(a, 1533, 4000, (t) => [person({ x: 0.75, sw: 0.1, t, rand: r, who: 'bystander' }), person({ x: 0.45, sw: 0.32, t, rand: r, who: 'player' })]);
  const switchIdx = outs.findIndex((o) => whoOf(o, 0) === 'player');
  assert(switchIdx >= 0, 'player never took P1');
  const ms = switchIdx * 33;
  // the newcomer first has to show it is a moving person, then out-score the owner for switchHoldMs
  assert(ms >= ASSIGNER_TUNING.switchHoldMs && ms <= ASSIGNER_TUNING.switchHoldMs + 700, `switched after ${ms} ms`);
  assert(outs.slice(switchIdx).every((o) => whoOf(o, 0) === 'player'), 'did not stay switched');
});

test('assigner: brief dropout keeps the same player, presence false meanwhile', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(7);
  run(a, 0, 1000, (t) => [person({ t, rand: r, who: 'me' })]);
  const gap = run(a, 1033, 1500, () => []);
  assert(gap.every((o) => o.players[0] === null) && a.presence[0] === false);
  const back = a.assign(frame(1533, [person({ x: 0.53, t: 1533, rand: r, who: 'me' })]));
  assert(whoOf(back, 0) === 'me', 'should re-acquire immediately after a short gap');
  assert(back.trackIds[0] === a.slots[0].id);
});

test('assigner: duplicate detections of one person collapse into one', () => {
  const a = new PlayerAssigner({ players: 2 });
  const r = rng(8);
  const outs = run(a, 0, 1500, (t) => [person({ t, rand: r, who: 'me' }), person({ x: 0.505, t, rand: r, who: 'dup', vis: 0.8 })]);
  const last = outs[outs.length - 1];
  assert(whoOf(last, 0) === 'me' && last.players[1] === null, `got ${whoOf(last, 0)} / ${whoOf(last, 1)}`);
  assert(!last.ignored.some((p) => p.who === 'dup'), 'duplicate should be dropped, not shown as ignored');
});

test('assigner: 2P start — P1 is the person on the LEFT of the mirrored preview (larger raw x)', () => {
  const a = new PlayerAssigner({ players: 2 });
  const r = rng(9);
  const outs = run(a, 0, 1000, (t) => [person({ x: 0.28, t, rand: r, who: 'rawLeft' }), person({ x: 0.72, t, rand: r, who: 'rawRight' })]);
  const last = outs[outs.length - 1];
  assert(whoOf(last, 0) === 'rawRight' && whoOf(last, 1) === 'rawLeft', `${whoOf(last, 0)} / ${whoOf(last, 1)}`);
});

test('assigner: 2P identities survive a crossing (and detection order flips)', () => {
  const a = new PlayerAssigner({ players: 2 });
  const r = rng(10);
  const posA = (t) => (t < 1000 ? 0.72 : t > 2600 ? 0.28 : 0.72 - (t - 1000) / 1600 * 0.44);
  const posB = (t) => (t < 1000 ? 0.28 : t > 2600 ? 0.72 : 0.28 + (t - 1000) / 1600 * 0.44);
  const outs = run(a, 0, 3600, (t) => {
    const A = person({ x: posA(t), sw: 0.2, t, rand: r, who: 'A' });
    const B = person({ x: posB(t), sw: 0.17, y: 0.4, t, rand: r, who: 'B' });
    // while overlapping, the one behind is often lost for a few frames
    if (Math.abs(posA(t) - posB(t)) < 0.06) return [A];
    return t % 2 ? [A, B] : [B, A];
  });
  const settled = outs.slice(5);
  const p1 = settled.filter((o) => o.players[0]).map((o) => o.players[0].who);
  const p2 = settled.filter((o) => o.players[1]).map((o) => o.players[1].who);
  assert(p1.every((w) => w === 'A'), `P1 changed identity: ${[...new Set(p1)]}`);
  assert(p2.every((w) => w === 'B'), `P2 changed identity: ${[...new Set(p2)]}`);
  const last = outs[outs.length - 1];
  assert(whoOf(last, 0) === 'A' && whoOf(last, 1) === 'B', 'final slots wrong');
});

test('assigner: 2P — a player who vanishes is re-acquired in the same slot', () => {
  const a = new PlayerAssigner({ players: 2 });
  const r = rng(11);
  run(a, 0, 1000, (t) => [person({ x: 0.7, t, rand: r, who: 'A' }), person({ x: 0.3, t, rand: r, who: 'B' })]);
  // A ducks out of frame for 600 ms and comes back somewhat displaced (outside the gate)
  const gap = run(a, 1033, 1633, (t) => [person({ x: 0.3, t, rand: r, who: 'B' })]);
  assert(gap.every((o) => o.players[0] === null && whoOf(o, 1) === 'B'));
  const back = run(a, 1666, 2200, (t) => [person({ x: 0.3, t, rand: r, who: 'B' }), person({ x: 0.95, t, rand: r, who: 'A' })]);
  const last = back[back.length - 1];
  assert(whoOf(last, 0) === 'A' && whoOf(last, 1) === 'B', `${whoOf(last, 0)} / ${whoOf(last, 1)}`);
});

test('assigner: switching 2 → 1 player keeps P1', () => {
  const a = new PlayerAssigner({ players: 2 });
  const r = rng(12);
  run(a, 0, 600, (t) => [person({ x: 0.7, t, rand: r, who: 'A' }), person({ x: 0.3, t, rand: r, who: 'B' })]);
  a.setPlayers(1);
  const o = a.assign(frame(633, [person({ x: 0.7, t: 633, rand: r, who: 'A' }), person({ x: 0.3, t: 633, rand: r, who: 'B' })]));
  assert(o.players.length === 1 && whoOf(o, 0) === 'A');
});

test('assigner: time going backwards (replay loop) resets cleanly', () => {
  const a = new PlayerAssigner({ players: 1 });
  const r = rng(13);
  run(a, 0, 1000, (t) => [person({ t, rand: r, who: 'me' })]);
  const outs = run(a, 0, 500, (t) => [person({ t, rand: r, who: 'me' })]);
  assert(whoOf(outs[outs.length - 1], 0) === 'me');
});

test('assigner: low-visibility detections are ignored, empty frames are fine', () => {
  const a = new PlayerAssigner({ players: 1 });
  const out = a.assign(frame(0, [person({ vis: 0.1 }), null]));
  assert(out.players[0] === null && out.ignored.length === 1);
  const empty = a.assign(frame(33, []));
  assert(empty.players.length === 1 && empty.players[0] === null);
});
