// Bout replay recording and the outro timeline (owner: view3d) — ARCHITECTURE §6.5,
// research/mechanics.md §6 "KO outro, in order".
//
// ViewRecorder keeps a ring buffer of the last few seconds of what the boxer models need (a
// compact copy of each BoxerView plus the root position / yaw) without allocating per frame.
// When a knockdown blow lands it keeps recording a short post-roll and then copies the window
// around the blow into a separate clip, so the KO's final blow can be replayed many seconds
// later (the count takes ~11 s). planOutro() turns a result into the timed stage list:
//   KO:        start → wipe (our own logo wipe) → flash → replay (side, low, overhead at ~0.2×;
//              the fall takes ~3 s) → white fade → banner → winner → end
//   decision / draw (or no clip): start → flash → banner → winner → end
// Pure module (no DOM / WebGL) — Node-testable.

/** Recording / replay knobs (seconds). */
export const REPLAY_TUNING = Object.freeze({
  seconds: 6,          // live ring buffer length
  maxFps: 120,         // frames per second the buffers are sized for
  pre: 3.2,            // game seconds kept before the blow
  post: 2.2,           // game seconds recorded after the blow
  postRealMax: 5,      // … or at most this many real seconds
  events: 48,          // recorded FX events (hits, blocks) in the ring
});

/** Outro stage timings (seconds). Replay segments are relative to the blow, in game seconds. */
export const OUTRO_TUNING = Object.freeze({
  ko: Object.freeze({
    wipeAt: 0.25, wipe: 0.9,
    replay: Object.freeze([
      Object.freeze({ angle: 'side', from: -1.25, to: -0.22, speed: 0.45 }),
      Object.freeze({ angle: 'low', from: -0.22, to: 0.3, speed: 0.2 }),
      Object.freeze({ angle: 'overhead', from: 0.3, to: 1.15, speed: 0.3 }),
    ]),
    impactHold: 0.3,   // real seconds the replay freezes on the blow
    fade: 0.75,        // white fade (out of the replay, into the banner)
    banner: 3.6, winner: 3.4,
  }),
  decision: Object.freeze({ flashAt: 0.15, fade: 0.6, banner: 3.4, winner: 3.2 }),
  fastTotal: 1.45,     // ?fast=1 keeps the whole outro ≤ 1.5 s
  // ?fast=1 KO: at least this long from the 'wipe' stage (the HUD clears its calls there; they take
  // 0.26 s to fade) to the first replay frame, so the replay starts clean of the "KO" letters (Q2)
  fastCleanLead: 0.3,
  reduced: Object.freeze({ replaySpeed: 0.4, banner: 2.4, winner: 2.4 }),
});

// ───────────────────────────── view snapshots ─────────────────────────────

const mkHand = () => ({ x: 0, y: 0, reach: 0, punching: false });
const mkPunch = () => ({ id: null, hand: 'left', kind: 'straight', target: 'head', progress: 0, impact: false, stage: null, outcome: null, power: 0, counter: false, heavy: false });

/** A preallocated copy of what BoxerModel reads from a BoxerView. */
export function makeSnap() {
  return {
    valid: false, phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 },
    hasHands: false, hands: { left: mkHand(), right: mkHand() },
    hasPunch: false, punch: mkPunch(),
    nPunches: 0, punches: [mkPunch(), mkPunch()],
    taunting: false,
    hasWindup: false, windup: { hand: 'left', kind: 'straight', target: 'head', progress: 0, tell: { pullback: 1, shoulder: 1 } },
    hasHit: false, hitReact: { hand: 'left', kind: 'straight', target: 'head', strength: 0.6, age: 0, blocked: false },
    expression: 'neutral', isHuman: false, hp01: 1, hp: 10,
  };
}

const num = (x, d = 0) => (Number.isFinite(x) ? x : d);

function copyPunch(dst, q) {
  dst.id = q.id ?? null; dst.hand = q.hand === 'right' ? 'right' : 'left'; dst.kind = q.kind ?? 'straight';
  dst.target = q.target === 'body' ? 'body' : 'head'; dst.progress = num(q.progress); dst.impact = !!q.impact;
  dst.stage = typeof q.stage === 'string' ? q.stage : null; dst.outcome = typeof q.outcome === 'string' ? q.outcome : null;
  dst.power = num(q.power); dst.counter = !!q.counter; dst.heavy = !!q.heavy;
}

function copyHand(dst, src) { dst.x = num(src.x); dst.y = num(src.y); dst.reach = num(src.reach); dst.punching = !!src.punching; }
const SIDES = ['left', 'right'];
const IDS = ['p1', 'p2'];

/** Copy a BoxerView into a snapshot (no allocation). */
export function writeSnap(s, v) {
  s.valid = !!v;
  if (!v) return s;
  s.phase = v.phase ?? 'idle'; s.phaseProgress = num(v.phaseProgress); s.guard = v.guard ?? 'none';
  s.lean.x = num(v.lean?.x); s.lean.y = num(v.lean?.y); s.lean.z = num(v.lean?.z);
  const hl = v.hands?.left, hr = v.hands?.right;
  s.hasHands = !!(hl && hr);
  if (s.hasHands) { copyHand(s.hands.left, hl); copyHand(s.hands.right, hr); }
  s.hasPunch = !!(v.punch && v.punch.hand);
  if (s.hasPunch) copyPunch(s.punch, v.punch);
  s.nPunches = 0;
  if (Array.isArray(v.punches)) {
    for (let i = 0; i < v.punches.length && s.nPunches < 2; i++) {
      const q = v.punches[i];
      if (!q || !q.hand) continue;
      copyPunch(s.punches[s.nPunches++], q);
    }
  }
  s.taunting = !!v.taunting;
  const w = v.windup;
  s.hasWindup = !!(w && w.hand);
  if (s.hasWindup) {
    s.windup.hand = w.hand; s.windup.kind = w.kind ?? 'straight'; s.windup.target = w.target === 'body' ? 'body' : 'head';
    s.windup.progress = num(w.progress); s.windup.tell.pullback = num(w.tell?.pullback, 1); s.windup.tell.shoulder = num(w.tell?.shoulder, 1);
  }
  const h = v.hitReact;
  s.hasHit = !!(h && typeof h === 'object');
  if (s.hasHit) {
    s.hitReact.hand = h.hand === 'right' ? 'right' : 'left'; s.hitReact.kind = h.kind ?? 'straight'; s.hitReact.target = h.target === 'body' ? 'body' : 'head';
    s.hitReact.strength = num(h.strength, 0.6); s.hitReact.age = num(h.age); s.hitReact.blocked = !!h.blocked;
  }
  s.expression = v.expression ?? 'neutral';
  s.isHuman = !!v.isHuman; s.hp01 = num(v.hp01, 1); s.hp = num(v.hp, s.hp01 * 10);
  return s;
}

/** Deep copy snapshot → snapshot (no allocation). */
export function copySnap(d, s) {
  d.valid = s.valid; d.phase = s.phase; d.phaseProgress = s.phaseProgress; d.guard = s.guard;
  d.lean.x = s.lean.x; d.lean.y = s.lean.y; d.lean.z = s.lean.z;
  d.hasHands = s.hasHands;
  for (const k of SIDES) { const a = d.hands[k], b = s.hands[k]; a.x = b.x; a.y = b.y; a.reach = b.reach; a.punching = b.punching; }
  d.hasPunch = s.hasPunch; Object.assign(d.punch, s.punch);
  d.nPunches = s.nPunches; Object.assign(d.punches[0], s.punches[0]); Object.assign(d.punches[1], s.punches[1]);
  d.taunting = s.taunting;
  d.hasWindup = s.hasWindup;
  d.windup.hand = s.windup.hand; d.windup.kind = s.windup.kind; d.windup.target = s.windup.target; d.windup.progress = s.windup.progress;
  d.windup.tell.pullback = s.windup.tell.pullback; d.windup.tell.shoulder = s.windup.tell.shoulder;
  d.hasHit = s.hasHit; Object.assign(d.hitReact, s.hitReact);
  d.expression = s.expression; d.isHuman = s.isHuman; d.hp01 = s.hp01; d.hp = s.hp;
  return d;
}

const lerp = (a, b, t) => a + (b - a) * t;
const samePunch = (a, b) => a.hand === b.hand && a.kind === b.kind && a.id === b.id && a.stage === b.stage;

/** out = a→b at t (numbers interpolate when the discrete state matches; otherwise the nearer frame). */
export function lerpSnap(out, a, b, t) {
  const near = t < 0.5 ? a : b;
  copySnap(out, near);
  if (!a.valid || !b.valid) return out;
  if (a.phase === b.phase) out.phaseProgress = lerp(a.phaseProgress, b.phaseProgress, t);
  out.lean.x = lerp(a.lean.x, b.lean.x, t); out.lean.y = lerp(a.lean.y, b.lean.y, t); out.lean.z = lerp(a.lean.z, b.lean.z, t);
  if (a.hasHands && b.hasHands) {
    for (const k of SIDES) {
      const o = out.hands[k], p = a.hands[k], q = b.hands[k];
      o.x = lerp(p.x, q.x, t); o.y = lerp(p.y, q.y, t); o.reach = lerp(p.reach, q.reach, t);
    }
  }
  if (a.hasPunch && b.hasPunch && samePunch(a.punch, b.punch)) out.punch.progress = lerp(a.punch.progress, b.punch.progress, t);
  if (a.nPunches === b.nPunches) {
    for (let i = 0; i < a.nPunches; i++) if (samePunch(a.punches[i], b.punches[i])) out.punches[i].progress = lerp(a.punches[i].progress, b.punches[i].progress, t);
  }
  if (a.hasWindup && b.hasWindup && a.windup.hand === b.windup.hand && a.windup.kind === b.windup.kind) {
    out.windup.progress = lerp(a.windup.progress, b.windup.progress, t);
  }
  if (a.hasHit && b.hasHit && a.hitReact.hand === b.hitReact.hand && a.hitReact.kind === b.hitReact.kind && b.hitReact.age >= a.hitReact.age) {
    out.hitReact.age = lerp(a.hitReact.age, b.hitReact.age, t);
  }
  out.hp01 = lerp(a.hp01, b.hp01, t); out.hp = lerp(a.hp, b.hp, t);
  return out;
}

/**
 * A reusable BoxerView-shaped object filled from a snapshot (what BoxerModel.update reads).
 * `appearance` is passed through by reference.
 */
export function makeViewOut() {
  return {
    id: 'p1', isHuman: false, appearance: null, phase: 'idle', phaseProgress: 0, guard: 'none', lean: { x: 0, y: 0, z: 0 },
    hands: null, punch: null, punches: null, windup: null, hitReact: null, taunting: false, expression: 'neutral',
    hp01: 1, hp: 10, _p1: [], _p2: [],
  };
}

export function snapToView(out, s, appearance = null) {
  out.appearance = appearance;
  out.isHuman = s.isHuman; out.phase = s.phase; out.phaseProgress = s.phaseProgress; out.guard = s.guard;
  out.lean = s.lean;
  out.hands = s.hasHands ? s.hands : null;
  out.punch = s.hasPunch ? s.punch : null;
  if (s.nPunches === 0) out.punches = null;
  else {
    const arr = s.nPunches === 1 ? out._p1 : out._p2;
    arr.length = s.nPunches;
    for (let i = 0; i < s.nPunches; i++) arr[i] = s.punches[i];
    out.punches = arr;
  }
  out.windup = s.hasWindup ? s.windup : null;
  out.hitReact = s.hasHit ? s.hitReact : null;
  out.taunting = s.taunting; out.expression = s.expression; out.hp01 = s.hp01; out.hp = s.hp;
  return out;
}

// ───────────────────────────── recorder ─────────────────────────────

function makeFrame() {
  return {
    t: 0, tau: 0,
    pos: { p1: [0, 0, 0], p2: [0, 0, 0] }, yaw: { p1: 0, p2: 0 },
    snap: { p1: makeSnap(), p2: makeSnap() },
  };
}

function copyFrame(d, s) {
  d.t = s.t; d.tau = s.tau;
  for (const id of IDS) {
    d.pos[id][0] = s.pos[id][0]; d.pos[id][1] = s.pos[id][1]; d.pos[id][2] = s.pos[id][2];
    d.yaw[id] = s.yaw[id];
    copySnap(d.snap[id], s.snap[id]);
  }
}

function makeEvent() { return { tau: 0, kind: 'hit', x: 0, y: 0, z: 0, counter: false, heavy: false, knockdown: false, power: 0.6, attacker: 'p1', defender: 'p2' }; }

/**
 * Ring buffer of the last REPLAY_TUNING.seconds of boxer views + the clip around the latest
 * knockdown blow. All storage is preallocated.
 */
export class ViewRecorder {
  constructor({ seconds = REPLAY_TUNING.seconds, fps = REPLAY_TUNING.maxFps } = {}) {
    this.cap = Math.max(8, Math.ceil(seconds * fps));
    this.frames = Array.from({ length: this.cap }, makeFrame);
    this.clipFrames = Array.from({ length: this.cap }, makeFrame);
    this.events = Array.from({ length: REPLAY_TUNING.events }, makeEvent);
    this.clipEvents = Array.from({ length: REPLAY_TUNING.events }, makeEvent);
    this.reset();
  }

  reset() {
    this.head = -1;          // index of the newest frame
    this.count = 0;
    this.tau = 0;            // accumulated game time
    this.t = 0;              // accumulated real time
    this.evHead = -1; this.evCount = 0;
    this.pending = null;     // a blow waiting for its post-roll
    this.clip = null;        // {count, blowIndex, blowTau, blow, events, eventCount}
  }

  /**
   * Record one rendered frame.
   * @param {number} realDt  real seconds since the last frame
   * @param {number} gameDt  game seconds (realDt × timeScale)
   * @param {{p1:{pos:{x,y,z}, yaw:number}, p2:{pos:{x,y,z}, yaw:number}}} slots
   * @param {{p1:Object, p2:Object}} views  BoxerViews
   */
  record(realDt, gameDt, slots, views) {
    this.t += Math.max(0, num(realDt));
    this.tau += Math.max(0, num(gameDt));
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
    const f = this.frames[this.head];
    f.t = this.t; f.tau = this.tau;
    for (const id of IDS) {
      const s = slots[id];
      f.pos[id][0] = num(s?.pos?.x); f.pos[id][1] = num(s?.pos?.y); f.pos[id][2] = num(s?.pos?.z);
      f.yaw[id] = num(s?.yaw);
      writeSnap(f.snap[id], views?.[id] ?? null);
    }
    if (this.pending) {
      const P = this.pending;
      if (this.tau - P.tau >= REPLAY_TUNING.post || this.t - P.t >= REPLAY_TUNING.postRealMax) this.finalize();
    }
  }

  /** Note an FX moment (hit / block) at the current game time so the replay can show it again. */
  event(kind, pos, e = {}) {
    this.evHead = (this.evHead + 1) % this.events.length;
    this.evCount = Math.min(this.events.length, this.evCount + 1);
    const ev = this.events[this.evHead];
    ev.tau = this.tau; ev.kind = kind; ev.x = num(pos?.x); ev.y = num(pos?.y); ev.z = num(pos?.z);
    ev.counter = !!e.counter; ev.heavy = !!e.heavy; ev.knockdown = !!e.knockdown; ev.power = num(e.power, 0.6);
    ev.attacker = e.attacker === 'p2' ? 'p2' : 'p1'; ev.defender = e.defender === 'p1' ? 'p1' : e.defender === 'p2' ? 'p2' : (ev.attacker === 'p1' ? 'p2' : 'p1');
  }

  /** The knockdown blow landed now: keep recording the fall, then store the clip around it. */
  markBlow(info = {}) {
    if (this.pending) this.finalize();
    this.pending = { tau: this.tau, t: this.t, info: { ...info } };
  }

  /** Copy the window around the pending blow into the clip (also called when the outro starts). */
  finalize() {
    const P = this.pending;
    if (!P) return this.clip;
    this.pending = null;
    if (this.count === 0) return this.clip;
    // walk back from the newest frame to the first frame inside [blow − pre, now]
    let n = 0, idx = this.head;
    const from = P.tau - REPLAY_TUNING.pre;
    while (n < this.count) {
      const f = this.frames[idx];
      if (f.tau < from && n > 0) break;
      n++;
      idx = (idx - 1 + this.cap) % this.cap;
    }
    const start = (this.head - n + 1 + this.cap) % this.cap;
    let blowIndex = 0;
    for (let i = 0; i < n; i++) {
      const src = this.frames[(start + i) % this.cap];
      copyFrame(this.clipFrames[i], src);
      if (src.tau <= P.tau + 1e-9) blowIndex = i;
    }
    let ec = 0;
    for (let i = 0; i < this.evCount; i++) {
      const ev = this.events[(this.evHead - i + this.events.length) % this.events.length];
      if (ev.tau < from - 0.05) continue;
      Object.assign(this.clipEvents[ec++], ev);
    }
    this.clip = { count: n, blowIndex, blowTau: P.tau, blow: P.info, events: this.clipEvents, eventCount: ec,
      tau0: this.clipFrames[0].tau, tau1: this.clipFrames[n - 1].tau };
    return this.clip;
  }

  /** The latest knockdown clip (finalizing a pending one first), or null. */
  latestClip() { if (this.pending) this.finalize(); return this.clip && this.clip.count > 1 ? this.clip : null; }

  /**
   * Find the clip frames around game time `tau` → {a, b, t} (interpolation weights).
   * Writes into `out` (no allocation).
   */
  sample(tau, out) {
    const c = this.clip;
    if (!c || c.count === 0) { out.a = null; out.b = null; out.t = 0; return out; }
    const F = this.clipFrames;
    if (tau <= F[0].tau) { out.a = F[0]; out.b = F[0]; out.t = 0; return out; }
    if (tau >= F[c.count - 1].tau) { out.a = F[c.count - 1]; out.b = F[c.count - 1]; out.t = 0; return out; }
    let lo = 0, hi = c.count - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (F[mid].tau <= tau) lo = mid; else hi = mid; }
    const a = F[lo], b = F[hi];
    out.a = a; out.b = b;
    out.t = b.tau > a.tau ? (tau - a.tau) / (b.tau - a.tau) : 0;
    return out;
  }
}

// ───────────────────────────── outro plan ─────────────────────────────

/**
 * Build the outro timeline.
 * @param {{ko:boolean, clip:null|{tau0:number,tau1:number,blowTau:number}, fast?:boolean, reducedMotion?:boolean}} o
 * @returns {{kind:'ko'|'decision', stages:Array<{stage:string, at:number}>, total:number,
 *           wipe:null|{at:number, dur:number}, flashAt:number, fade:null|{at:number, dur:number},
 *           replay:Array<{angle:string, at:number, dur:number, from:number, to:number, speed:number}>,
 *           impactHold:number, bannerAt:number, winnerAt:number}}
 */
export function planOutro({ ko, clip = null, fast = false, reducedMotion = false }) {
  const K = OUTRO_TUNING.ko, D = OUTRO_TUNING.decision, R = OUTRO_TUNING.reduced;
  const stages = [];
  const plan = { kind: ko ? 'ko' : 'decision', stages, total: 0, wipe: null, flashAt: 0, fade: null, replay: [], impactHold: 0, bannerAt: 0, winnerAt: 0 };
  let t = 0;
  stages.push({ stage: 'start', at: 0 });
  if (ko) {
    // logo wipe (a plain fade when motion is reduced), then the white flash as the replay starts
    const wipeDur = reducedMotion ? 0.5 : K.wipe;
    plan.wipe = { at: K.wipeAt, dur: wipeDur };
    stages.push({ stage: 'wipe', at: K.wipeAt });
    t = K.wipeAt + wipeDur / 2;
    plan.flashAt = t;
    stages.push({ stage: 'flash', at: t });
    // the replay (only with a recorded clip)
    if (clip) {
      let at = t + 0.05;
      const segs = reducedMotion ? K.replay.filter((s) => s.angle !== 'overhead') : K.replay;
      for (const s of segs) {
        const from = Math.max(s.from, clip.tau0 - clip.blowTau);
        const to = Math.min(s.to, clip.tau1 - clip.blowTau);
        if (to - from < 0.02) continue;
        const speed = reducedMotion ? R.replaySpeed : s.speed;
        const hold = from <= 0 && to > 0 ? K.impactHold : 0;
        const dur = (to - from) / speed + hold;
        plan.replay.push({ angle: s.angle, at, dur, from, to, speed });
        at += dur;
      }
      if (plan.replay.length) {
        plan.impactHold = K.impactHold;
        stages.push({ stage: 'replay', at: plan.replay[0].at });
        t = at;
      }
    }
    // the white fade peaks exactly when the banner moment is staged
    plan.fade = { at: t - K.fade * 0.5, dur: K.fade };
  } else {
    plan.flashAt = D.flashAt;
    stages.push({ stage: 'flash', at: D.flashAt });
    plan.fade = { at: D.flashAt, dur: D.fade };
    t = D.flashAt + D.fade * 0.5;
  }
  plan.bannerAt = t;
  stages.push({ stage: 'banner', at: t });
  t += reducedMotion ? R.banner : ko ? K.banner : D.banner;
  plan.winnerAt = t;
  stages.push({ stage: 'winner', at: t });
  t += reducedMotion ? R.winner : ko ? K.winner : D.winner;
  stages.push({ stage: 'end', at: t });
  plan.total = t;
  if (fast) {
    const F = OUTRO_TUNING.fastTotal;
    const rAt = plan.replay.length ? plan.replay[0].at : null;
    const k = F / t;
    if (rAt != null && plan.wipe && (rAt - plan.wipe.at) * k < OUTRO_TUNING.fastCleanLead) {
      // keep the lead-in (wipe → replay) long enough for the HUD's KO letters to fade (Q2), and
      // fit the replay, banner and winner into the rest of the ≤ 1.5 s
      const lead = OUTRO_TUNING.fastCleanLead * rAt / (rAt - plan.wipe.at);
      timeMap(plan, (x) => (x <= rAt ? x * lead / rAt : lead + (x - rAt) * (F - lead) / (t - rAt)), (F - lead) / (t - rAt));
    } else timeMap(plan, (x) => x * k, k);
  }
  return plan;
}

/**
 * Re-time a plan through a monotonic map `f` of its clock (stage times, wipe, fade, replay
 * segments); `kAfter` is the local scale after the replay starts (segment speeds, the impact hold).
 */
function timeMap(plan, f, kAfter) {
  const span = (o) => { if (!o) return; const a = f(o.at), b = f(o.at + o.dur); o.at = a; o.dur = b - a; };
  for (const s of plan.stages) s.at = f(s.at);
  span(plan.wipe);
  span(plan.fade);
  for (const r of plan.replay) { const a = f(r.at), b = f(r.at + r.dur); r.speed *= r.dur / Math.max(1e-9, b - a); r.at = a; r.dur = b - a; }
  plan.impactHold *= kAfter;
  plan.flashAt = f(plan.flashAt); plan.bannerAt = f(plan.bannerAt); plan.winnerAt = f(plan.winnerAt); plan.total = f(plan.total);
  return plan;
}
