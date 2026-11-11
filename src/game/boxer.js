// One boxer's state machine: health, phases, punches, defence, reels, stats → BoxerView.
//
// Pure logic (no DOM, runs in Node). Time is always the caller's millisecond clock `t`
// (the Match passes its own pausable time: real time for humans, world time for AI corners —
// see match.js "dodge slow motion"). Used by Match for both fighters and usable stand-alone
// (e.g. training) like this:
//
//   const me = new Boxer({ id: 'p1', isHuman: true, name, appearance });
//   each frame:  me.setControl(input.control, t);
//                for (const e of input.events) if (e.type === 'punch') me.tryPunch(e.punch, t);
//                const notes = me.update(t);           // [{type:'thrown', punch}, …]
//                for (const p of me.duePunches(t)) { … decide … me.onPunchResolved(p, res, t); }
//                view = me.toView(t);
//
// HEALTH is in wedges (research/mechanics.md §2.6): maxHp 10 by default, fractional, no
// regeneration, no top-up, no chip, no stamina, no daze (§2.4, §2.9, §4.1.8).
//
// HUMAN boxers: guard/lean/hands follow ControlState continuously (a clear lean shows as the
// DODGE phase) — the guard ALWAYS counts, even right after being hit (§2.7, §2.10). PunchInput
// events start a punch immediately — no wind-up; the glove travels COMBAT.punch[kind].humanTravelMs
// (0.1–0.13 s, §2.2) when the punch was recognised as it began (keyboard), or only
// COMBAT.atExtensionTravelMs when the camera recognised it at full extension (PunchInput.atExtension,
// decision D5); the impact resolves at the end of travel. Rate limit (§2.10): the same glove
// can start a new punch perHandMs (0.2 s) after its last one (once that one has resolved), and no
// two punches start closer than betweenHandsMs (0.1 s) — enough for the measured 5–6 punches/s
// flurries. A punch arriving just before it is allowed is buffered (COMBAT.inputBufferMs); during a
// hit-stop (tryPunch opts.stalled, passed down from MatchSession) every punch that cannot start yet
// is queued — one per hand, the newest wins — and fires once its glove is allowed (decision D6: the
// human stays on match time through the stall, but a recognised punch is never silently dropped).
// Punches are ignored while down or getting up; being hit only shows a flinch (humanHitLockMs).
//
// AI boxers: the OpponentAI requests a wind-up (WINDUP) → PUNCH travel → RECOVER. The whole tell
// (wind-up + travel) is never shorter than COMBAT.minTellMs (power punches: the AI passes its own,
// longer floor). A wind-up can be HELD cocked (extendWindup) while the player leans (§4.1.7).
// After a clean hit the AI REELS (reelMs: can't punch; §2.7). Its guard is knocked open for the
// first stunGuardMs[ordinary | heavy] game ms of the reel (fallback: stunGuardMul × the reel) — set
// net of the renderer's hit-stop so the guard comes back ~0.65–0.7 s (real) after the impact either
// way (§2.3, §2.7); a cover-up (cover()) ends a reel early with a high guard. A punch that is dodged
// leaves the glove out for whiffRecoverMs — the player's counter window (the slow motion stretches it
// in real time).

import { handSign } from '../core/types.js';
import { COMBAT, punchSpec, travelMs } from './combat.js';

/** Default stats for human boxers (hp = max health in wedges, power/speed multipliers, heart unused). */
export const HUMAN_STATS = Object.freeze({ hp: 10, power: 1, speed: 1, heart: 0.7 });
/** Fallback stats for AI boxers without a roster entry. */
export const AI_STATS = Object.freeze({ hp: 10, power: 1, speed: 1, heart: 0.6 });

/** AI body-mechanics defaults (overridable per opponent through def.ai). */
export const AI_BODY_DEFAULTS = Object.freeze({
  recoverMul: 1,          // × COMBAT.punch[kind].aiRecoverMs after a punch that hit or was blocked
  blockedRecoverMs: 80,   // extra recovery after a blocked punch (glove bounces off)
  whiffRecoverMs: 160,    // WORLD ms the glove stays out after a DODGED/missed punch (guard open: the
                          // counter window). The dodge slow motion (×0.25 for 0.75 s) stretches it to the
                          // measured 0.5–0.8 s in real time (roster missRecoveryMs → this; see roster.js).
  openAfterContactMs: 150, // after a punch that hit or was blocked, the guard is open this long
  guardRaiseMs: 90,       // time for the gloves to move to a new guard (open meanwhile)
  leanSpeed: 10,          // lean units per second (0 → 0.9 lean in ~90 ms)
  slipLeanSpeed: 16,      // lean speed when slipping a punch
  reelMs: 600,            // reel after a clean hit (§2.7: 0.5–0.7 s)
  windupArmor: true,      // an ordinary hit does not cancel a wind-up (only a counter does)
  stunGuardMul: 1,        // share of a reel with the guard open (the rest: still can't punch) …
  stunGuardMs: null,      // … or [ordinary, heavy]: game ms the guard stays open after an ordinary / a heavy
                          // (counter, power, combo) clean hit, capped at the reel. The renderer stalls the
                          // game 0.2 / 0.5 s on those hits (§2.8), so [450, 185] ≈ 0.65 / 0.69 s real.
  tells: { pullback: 1, glint: true, grunt: true, shoulder: 1 },
});

/** Nominal durations used for phaseProgress of open-ended phases. */
const PHASE_NOMINAL_MS = { idle: 400, guard: 220, dodge: 200, down: 900, ko: 1400, victory: 1600, defeat: 1600 };

// Glove poses in boxer perspective (shoulder widths; x is a magnitude, the sign comes from
// the hand: left = −, right = +; "lead" is the front hand: left for orthodox).
const POSES = {
  high:  { lead: { x: 0.2, y: 0.52, reach: 0.14 }, rear: { x: 0.26, y: 0.48, reach: 0.08 } },
  low:   { lead: { x: 0.24, y: -0.38, reach: 0.22 }, rear: { x: 0.3, y: -0.42, reach: 0.16 } },
  none:  { lead: { x: 0.32, y: 0.18, reach: 0.34 }, rear: { x: 0.36, y: 0.3, reach: 0.12 } },
  reel:  { lead: { x: 0.46, y: -0.05, reach: 0.1 }, rear: { x: 0.5, y: -0.12, reach: 0.06 } },
  rest:  { lead: { x: 0.4, y: -0.55, reach: 0.06 }, rear: { x: 0.44, y: -0.58, reach: 0.04 } },
  taunt: { lead: { x: 0.72, y: -0.22, reach: 0.04 }, rear: { x: 0.76, y: -0.26, reach: 0.04 } },
  down:  { lead: { x: 0.62, y: -0.62, reach: 0 }, rear: { x: 0.62, y: -0.62, reach: 0 } },
};
const WINDUP_POSES = {
  straight: { head: { x: 0.42, y: 0.34, reach: 0 }, body: { x: 0.42, y: -0.18, reach: 0 } },
  hook:     { head: { x: 0.95, y: 0.42, reach: 0.08 }, body: { x: 0.95, y: -0.28, reach: 0.08 } },
  uppercut: { head: { x: 0.32, y: -0.66, reach: 0.04 }, body: { x: 0.32, y: -0.78, reach: 0.04 } },
};
/** Power punches: the glove is raised high and far back (§4.3 "power hook with the glove raised"). */
const POWER_WINDUP_POSES = {
  straight: { head: { x: 0.5, y: 0.62, reach: -0.15 }, body: { x: 0.5, y: 0.1, reach: -0.15 } },
  hook:     { head: { x: 1.05, y: 0.78, reach: -0.05 }, body: { x: 1.05, y: 0.2, reach: -0.05 } },
  uppercut: { head: { x: 0.36, y: -0.82, reach: -0.05 }, body: { x: 0.36, y: -0.9, reach: -0.05 } },
};
const IMPACT_POSES = {
  straight: { head: { x: 0.06, y: 0.5, reach: 1 }, body: { x: 0.06, y: -0.32, reach: 0.95 } },
  hook:     { head: { x: -0.16, y: 0.5, reach: 0.85 }, body: { x: -0.12, y: -0.32, reach: 0.8 } },
  uppercut: { head: { x: 0.03, y: 0.66, reach: 0.78 }, body: { x: 0.03, y: -0.1, reach: 0.72 } },
};

const NEUTRAL_LEAN = Object.freeze({ x: 0, y: 0, z: 0 });
const SAMPLE_KEEP_MS = 1500;
const IMPACT_FLASH_MS = 150;
const HIT_REACT_KEEP_MS = 2000;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => { const x = clamp01(k); return x * x * (3 - 2 * x); };
const lerpPose = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), reach: lerp(a.reach, b.reach, k) });
const round2 = (v) => Math.round(v * 100) / 100;

export class Boxer {
  /**
   * @param {Object} o
   * @param {'p1'|'p2'} [o.id]
   * @param {string} [o.name]
   * @param {boolean} [o.isHuman=true]
   * @param {Object} [o.appearance]
   * @param {{hp?:number,power?:number,speed?:number,heart?:number}} [o.stats]  hp = max health in wedges (default 10)
   * @param {Object} [o.ai]       AI body params (AI_BODY_DEFAULTS keys), usually roster def.ai
   * @param {Object} [o.tuning]   COMBAT override
   * @param {number} [o.latencyMs] humans: camera → game latency used to judge their defence (default COMBAT.latencyMs)
   */
  constructor(o = {}) {
    this.id = o.id || 'p1';
    this.isHuman = o.isHuman !== false;
    this.name = o.name || (this.id === 'p1' ? 'Player 1' : 'Player 2');
    this.appearance = o.appearance || null;
    this.tuning = o.tuning || COMBAT;
    const st = { ...(this.isHuman ? HUMAN_STATS : AI_STATS), ...(o.stats || {}) };
    this.maxHp = Math.max(1, num(st.hp, this.tuning.maxHp ?? 10));
    this.power = num(st.power, 1);
    this.speed = clamp(num(st.speed, 1), 0.5, 2);
    /** Legacy (unused by the rules now; knockdown odds come from the roster's stayDown table). */
    this.heart = clamp01(num(st.heart, 0.6));
    this.body = { ...AI_BODY_DEFAULTS, ...(o.ai || {}), tells: { ...AI_BODY_DEFAULTS.tells, ...((o.ai && o.ai.tells) || {}) } };
    this.latencyMs = Math.max(0, num(o.latencyMs, this.tuning.latencyMs ?? 100));
    this.hp = this.maxHp;
    this.knockdowns = 0;
    this.roundKnockdowns = 0;
    /** @type {import('../core/types.js').BoxerStats & Object} */
    this.stats = {
      thrown: 0, landed: 0, blocked: 0, dodged: 0, counters: 0, damageDealt: 0, knockdownsScored: 0,
      missed: 0, damageTaken: 0, hitsTaken: 0, headLanded: 0, bodyLanded: 0, feints: 0, powerLanded: 0,
    };
    this._pid = 0;
    this.terminal = null;
    this.terminalAt = 0;
    this._clearTransient(0);
    this.phase = 'idle';
    this.phaseStart = 0;
  }

  /** Reset every transient combat state (not hp/stats/knockdowns). */
  _clearTransient(t) {
    this.guard = 'none';
    this.guardAmount = 0;
    this.lean = { x: 0, y: 0, z: 0 };
    this.activity = 0;
    this.control = null;
    this.hands = this._poseHands(this.isHuman ? 'none' : 'high');
    /** Active punches (≤ 1 per hand): {id, hand, kind, target, power, counter, powerPunch, damage,
     *  thrownAt, windupStart, impactAt, stepIn, stage:'travel'|'recover', outcome, resolvedAt, recoverUntil,
     *  heldDodge (the Match: dodged by a held posture — its hanging glove is no counter chance)} */
    this.punches = [];
    /** AI wind-up in progress: {id, hand, kind, target, power, powerPunch, damage, feint, counter, answer, stepIn, start, end, baseEnd, ms, tell} */
    this.windup = null;
    this.lastStartBy = { left: -1e9, right: -1e9 };
    this.handReadyAt = { left: t, right: t }; // legacy mirror of the per-hand rate limit
    this.lastPunchStartAt = -1e9;
    this.buffered = { left: null, right: null };
    this.guardBackAt = -1e9;
    this.stunStart = 0; this.stunUntil = 0; this.reelChainStart = -1e9; this.reelChainEnd = -1e9;
    this.guardOpenUntil = -1e9; // AI: the reel keeps the guard open until then (≤ stunUntil)
    this.coverUntil = 0;
    this.dazedStart = 0; this.dazedUntil = 0; // legacy: nobody gets dazed any more
    this.hitReact = null;
    this.counterUntil = 0; this.counterLeft = 0;
    this.combo = 0; this.lastLandAt = -1e9;
    this.takenCombo = 0; this.lastTakenAt = -1e9;
    this.lastDamageAt = -1e9;
    /** Human defence history for latency-fair resolution (see combat.js). */
    this.samples = [];
    /** Human: when the current dodging posture (isDodging) began, null while not leaning — only a FRESH dodge
     *  earns the slow motion and the counter window (COMBAT.freshDodgeMs, decision R2). */
    this.dodgeSince = null;
    this._dodgeOffAt = null;  // when the stance last came back from a posture (a posture ends after freshDodgeResetMs)
    this.down = false; this.downAt = 0;
    this.getupStart = 0; this.getupUntil = 0;
    this.feintRecoverUntil = 0;
    this.resting = false;
    // AI-only body state
    this.aiGuard = 'high'; this.aiGuardFrom = 'high'; this.aiGuardChangedAt = -1e9;
    this.aiLeanTarget = { x: 0, y: 0, z: 0 };
    this.aiLeanFast = false;
    this.taunting = false;
    this._lastUpdateT = t;
  }

  // ───────────────────────────── queries ─────────────────────────────

  get hp01() { return clamp01(this.hp / this.maxHp); }
  /** Legacy meters (no stamina, no daze in this game). */
  get stamina() { return 1; }
  get daze() { return 0; }
  /** Every boxer is orthodox (the stance choice was removed on 2026-11-10): the left glove leads. */
  leadHand() { return 'left'; }
  rearHand() { return 'right'; }
  isDown() { return this.down; }
  isStunned(t) { return t < this.stunUntil; }
  /** Legacy: nobody gets groggy (§4.1.8). Always false. */
  isDazed(t) { return t < this.dazedUntil; }
  isGettingUp(t) { return t < this.getupUntil; }
  isCovering(t) { return t < this.coverUntil; }
  counterReady(t) { return t < this.counterUntil && this.counterLeft > 0; }
  punchOn(hand) { return this.punches.find((p) => p.hand === hand) || null; }
  travelling() { return this.punches.find((p) => p.stage === 'travel') || null; }
  /**
   * Mid-punch (what makes the other side's clean hit a COUNTER, §2.3): a punch of ours is out
   * (travel), its glove hangs after a miss, or it is just pulling back (the first
   * openAfterContactMs after contact). Exactly the windows in which an AI's guard is open.
   * Without `t` (legacy): any punch at all.
   */
  /**
   * The punch of ours that makes the other side's hit a counter right now (see isMidPunch), or null.
   * A whiffed glove (or the guard still coming back after one) counts as the last whiffed punch — except a punch
   * dodged by a HELD posture (p.heldDodge, set by the Match): its glove still hangs open, but a held posture earns
   * no counter (decision R2: only a fresh dodge does).
   */
  midPunchFor(t, thrownBy) {
    const open = num(this.body.openAfterContactMs, 150);
    let whiff = null;
    for (const p of this.punches) {
      if (p.outcome === 'dodged' || p.outcome === 'miss') {
        if (p.heldDodge) continue;
        if (t < p.recoverUntil) return p;
        whiff = p;
        continue;
      }
      // our own counter-punches are not counterable: whoever started the exchange owns the counter
      if (!p.counter && (!Number.isFinite(thrownBy) || p.thrownAt <= thrownBy) && t < p.impactAt + open) return p;
    }
    if (t < this.guardBackAt) {
      const w = whiff || this._lastWhiff || null;
      return w && !w.heldDodge ? w : null;
    }
    return null;
  }

  isMidPunch(t, thrownBy) {
    if (!Number.isFinite(t)) return this.punches.length > 0;
    if (!Number.isFinite(thrownBy)) return this._punchOpensGuard(t);
    // counter-punching: only our punches already thrown by `thrownBy` count (or a whiff hanging)
    if (t < this.guardBackAt) return true;
    const open = num(this.body.openAfterContactMs, 150);
    for (const p of this.punches) {
      if (p.outcome === 'dodged' || p.outcome === 'miss') { if (t < p.recoverUntil) return true; continue; }
      if (p.thrownAt <= thrownBy && t < p.impactAt + open) return true;
    }
    return false;
  }
  /** Recovering from a dodged/missed punch (the glove hangs out). */
  isWhiffing(t) { return this.punches.some((p) => p.stage === 'recover' && (p.outcome === 'dodged' || p.outcome === 'miss') && t < p.recoverUntil); }
  /**
   * Standing, not getting up, no terminal state — and for an AI not reeling. A human's flinch after a
   * hit is visual only: motion keeps registering through the hit cut (§2.3, §2.10), so a human can
   * always throw (the rate limits still apply).
   */
  canAct(t) {
    if (this.terminal || this.down || t < this.getupUntil) return false;
    return this.isHuman || (t >= this.stunUntil && t >= this.dazedUntil);
  }
  /** Can the given hand start a punch right now (ignoring the input buffer)? */
  canPunch(hand, t) {
    if (!this.canAct(t)) return false;
    if (this.isHuman) return this._humanHandReady(hand, t);
    if (this.punchOn(hand)) return false;
    if (t < this.handReadyAt[hand]) return false;
    if (this.windup || this.travelling()) return false;
    return true;
  }
  /** AI: may a new wind-up start with this hand? */
  canStartWindup(t, hand) {
    if (this.isHuman || this.windup || this.travelling()) return false;
    if (t < this.feintRecoverUntil || t < this.coverUntil) return false;
    return this.canPunch(hand || this.leadHand(), t);
  }
  /** AI: busy with a wind-up, a punch in flight, or any glove still recovering. */
  isBusy(t) {
    return !!this.windup || this.punches.length > 0 || t < this.feintRecoverUntil;
  }
  isDodging() {
    const C = this.tuning, l = this.lean;
    const fwd = C.forwardLeanThreshold ?? C.backLeanThreshold;
    return Math.abs(l.x) >= C.dodgeLeanThreshold || l.y <= -C.duckThreshold || l.z <= -C.backLeanThreshold || l.z >= fwd;
  }

  /** AI: is a punch of ours leaving the guard open right now? (travel, a whiff's recovery,
   *  or the first openAfterContactMs after a punch that hit or was blocked) */
  _punchOpensGuard(t) {
    if (t < this.guardBackAt) return true; // gloves still coming back after a whiff
    const open = num(this.body.openAfterContactMs, 150);
    for (const p of this.punches) {
      if (p.outcome === 'dodged' || p.outcome === 'miss') { if (t < p.recoverUntil) return true; continue; }
      // out until contact, then pulling back for openAfterContactMs — keyed to the visual contact,
      // not to the (latency-deferred) resolution
      if (t < p.impactAt + open) return true;
    }
    return false;
  }

  /** AI: is the guard still knocked open by the current reel? */
  _stunOpensGuard(t) {
    if (t >= this.stunUntil) return false;
    return t < this.guardOpenUntil;
  }

  /**
   * Real ms of a clean hit's hit-stop on this (AI) boxer during which game time stands still: the
   * renderer stalls 0.2 s, 0.5 s when heavy / a counter (COMBAT.hitStop, render/fx.js), at ×scale.
   */
  _hitStallNet(res) {
    const H = this.tuning.hitStop || COMBAT.hitStop;
    if (!H) return 0;
    const stall = res && (res.heavy || res.counter) ? num(H.big, 500) : num(H.hit, 200);
    return stall * (1 - clamp01(num(H.scale, 0.02)));
  }

  /** AI: game ms a clean hit knocks the guard open (stunGuardMs[ordinary | heavy], else stunGuardMul × the reel). */
  _guardOpenMs(res) {
    const g = this.body.stunGuardMs;
    if (Array.isArray(g) && g.length) {
      const v = res && res.heavy ? (g.length > 1 ? g[1] : g[0]) : g[0];
      if (Number.isFinite(v)) return Math.max(0, v);
    }
    return Math.max(0, num(res && res.stunMs, 0)) * clamp01(num(this.body.stunGuardMul, 1));
  }

  /** The guard that actually protects right now (what combat uses). */
  effectiveGuard(t) {
    if (this.terminal || this.down || t < this.getupUntil) return 'none';
    if (this.isHuman) return this.guard;
    if (t < this.coverUntil && !this.travelling()) return 'high';
    if (this._stunOpensGuard(t) || this.taunting || this.resting || this._punchOpensGuard(t)) return 'none';
    if (this.aiGuard !== this.aiGuardFrom && t < this.aiGuardChangedAt + this.body.guardRaiseMs) return 'none';
    return this.aiGuard;
  }

  /** Snapshot consumed by combat.resolvePunch (see CombatSnapshot there). */
  combatSnapshot(t) {
    const C = this.tuning;
    return {
      id: this.id,
      isHuman: this.isHuman,
      phase: this.phase,
      guard: this.effectiveGuard(t),
      guardAmount: this.isHuman ? this.guardAmount : 1,
      lean: this.lean,
      power: this.power,
      hp: this.hp,
      maxHp: this.maxHp,
      reelMs: this.isHuman ? undefined : num(this.body.reelMs, C.aiReelMs),
      dazed: false,
      stamina01: 1,
      comboCount: t - this.lastLandAt <= C.comboWindowMs ? this.combo : 0,
      takenCombo: t - this.lastTakenAt <= C.comboWindowMs ? this.takenCombo : 0,
      invulnerable: !!this.terminal || this.down || t < this.getupUntil,
      samples: this.isHuman ? this.samples : null,
      latencyMs: this.isHuman ? this.latencyMs : undefined,
    };
  }

  // ───────────────────────────── human input ─────────────────────────────

  /**
   * Feed the latest ControlState (humans). Missing/untracked control → neutral (no guard, no lean).
   * @param {import('../core/types.js').ControlState|null} control
   * @param {number} t
   */
  setControl(control, t) {
    const c = control && control.tracked !== false ? control : null;
    this.control = c;
    if (c) {
      const g = c.guard === 'high' || c.guard === 'low' ? c.guard : 'none';
      this.guard = g;
      this.guardAmount = clamp01(num(c.guardAmount, g === 'none' ? 0 : 1));
      const l = c.lean || NEUTRAL_LEAN;
      this.lean = { x: clamp(num(l.x), -1, 1), y: clamp(num(l.y), -1, 1), z: clamp(num(l.z), -1, 1) };
      this.activity = clamp01(num(c.activity));
    } else {
      this.guard = 'none'; this.guardAmount = 0; this.lean = { x: 0, y: 0, z: 0 }; this.activity = 0;
    }
    // how long the dodging posture has been held (a lean, duck, back lean or forward tilt; any change between them
    // without coming back to the stance for freshDodgeResetMs is the same posture)
    const resetMs = num(this.tuning.freshDodgeResetMs, COMBAT.freshDodgeResetMs);
    if (this.isDodging()) {
      if (this.dodgeSince == null || (this._dodgeOffAt != null && t - this._dodgeOffAt >= resetMs)) this.dodgeSince = t;
      this._dodgeOffAt = null;
    } else if (this.dodgeSince != null) {
      if (this._dodgeOffAt == null) this._dodgeOffAt = t;
      if (t - this._dodgeOffAt >= resetMs) { this.dodgeSince = null; this._dodgeOffAt = null; }
    }
    // defence history (effective guard: none while down)
    const eff = this.effectiveGuard(t);
    this.samples.push({ t, guard: eff, guardAmount: this.guardAmount, lean: this.lean, since: this.dodgeSince });
    const cut = t - SAMPLE_KEEP_MS;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cut) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  /** Human: earliest time `hand` may start a punch by the rate limits (§2.10). */
  _humanReadyAt(hand) {
    const C = this.tuning;
    return Math.max(this.lastStartBy[hand] + num(C.perHandMs, 200), this.lastPunchStartAt + num(C.betweenHandsMs, num(C.minPunchGapMs, 100)));
  }
  /** …and the glove's previous punch must have been decided (no two punches in flight on one hand). */
  _humanHandReady(hand, t) {
    const cur = this.punchOn(hand);
    return t >= this._humanReadyAt(hand) && !(cur && cur.stage === 'travel');
  }

  /**
   * A recognized punch from the player (no wind-up). Returns the started punch, 'buffered'
   * if it was queued for a glove that is about to be allowed, or null if ignored.
   * @param {import('../core/types.js').PunchInput} input
   * @param {number} t
   * @param {{stalled?:boolean}} [opts]  stalled: the renderer's hit-stop is freezing game time right now —
   *        a punch that cannot start yet is queued (one per hand, the newest wins) instead of dropped (D6)
   */
  tryPunch(input, t, opts = null) {
    if (!input) return null;
    const C = this.tuning;
    if (!this.canAct(t)) return null; // down / getting up / hit lock / terminal
    const hand = input.hand === 'right' ? 'right' : 'left';
    const req = {
      hand,
      kind: C.punch[input.kind] ? input.kind : 'straight',
      target: input.target === 'body' ? 'body' : 'head',
      power: clamp01(num(input.power, C.defaultPower)),
      atExtension: input.atExtension === true,
    };
    const readyAt = this.isHuman ? this._humanReadyAt(hand) : Math.max(this.handReadyAt[hand], this.lastPunchStartAt + num(C.betweenHandsMs, 100));
    const cur = this.punchOn(hand);
    const unresolved = this.isHuman && !!cur && cur.stage === 'travel';
    if (readyAt > t || unresolved) {
      // close to allowed — or anything during a hit-stop: queue it (it fires as soon as the glove may go
      // and its last punch is decided)
      if (readyAt - t <= C.inputBufferMs || (opts && opts.stalled)) {
        this.buffered[hand] = { req, until: Math.max(t, readyAt) + C.inputBufferMs + (unresolved ? 200 : 0) };
        return 'buffered';
      }
      return null;
    }
    return this._startPunch(req, t);
  }

  // ───────────────────────────── AI body ─────────────────────────────

  /**
   * Apply an OpponentAI intent: {guard, lean, taunt?, leanFast?, rest?}. (A punch request is started
   * separately with startWindup so the caller can emit events.)
   */
  applyIntent(intent, t) {
    if (!intent || this.isHuman) return;
    const g = intent.guard === 'high' || intent.guard === 'low' ? intent.guard : 'none';
    if (g !== this.aiGuard) {
      // re-targeting mid-move restarts the move from wherever the gloves "were"
      this.aiGuardFrom = this.effectiveGuard(t) === 'none' && t < this.aiGuardChangedAt + this.body.guardRaiseMs ? 'none' : this.aiGuard;
      this.aiGuard = g;
      this.aiGuardChangedAt = t;
    }
    const l = intent.lean || NEUTRAL_LEAN;
    this.aiLeanTarget = { x: clamp(num(l.x), -1, 1), y: clamp(num(l.y), -1, 1), z: clamp(num(l.z), -1, 1) };
    this.aiLeanFast = !!intent.leanFast;
    this.taunting = !!intent.taunt;
    this.resting = !!intent.rest;
  }

  /**
   * AI: begin a telegraphed wind-up. The whole tell (wind-up + travel) is never shorter than
   * req.minTellMs (default COMBAT.minTellMs, power punches COMBAT.minPowerTellMs).
   * @param {{hand:string, kind:string, target:string, windupMs:number, power?:number, powerPunch?:boolean,
   *          damage?:number, feint?:boolean, counter?:boolean, minTellMs?:number}} req
   * @returns {null|Object} the wind-up
   */
  startWindup(req, t) {
    if (!req) return null;
    const C = this.tuning;
    const hand = req.hand === 'right' ? 'right' : 'left';
    if (!this.canStartWindup(t, hand)) return null;
    const kind = C.punch[req.kind] ? req.kind : 'straight';
    const powerPunch = !!req.powerPunch;
    const travel = travelMs(kind, false, this.speed, C, powerPunch);
    const minTell = Number.isFinite(req.minTellMs) ? req.minTellMs : powerPunch ? C.minPowerTellMs : C.minTellMs;
    const ms = Math.max(C.minWindupMs, num(req.windupMs, C.minWindupMs), minTell - travel);
    this.windup = {
      id: ++this._pid, hand, kind,
      target: req.target === 'body' ? 'body' : 'head',
      power: clamp01(num(req.power, powerPunch ? 0.95 : 0.6)),
      powerPunch,
      damage: Number.isFinite(req.damage) ? req.damage : undefined,
      feint: !!req.feint,
      counter: !!req.counter,
      answer: !!req.answer,     // it answers a held posture (ai.js, E)
      stepIn: !!req.stepIn,     // … stepping in: a real lean-in that eats into a back lean (combat.js, D4)
      start: t, end: t + ms, baseEnd: t + ms, ms, travelMs: travel, held: false,
      tell: { ...this.body.tells, power: powerPunch },
    };
    this.taunting = false;
    this.resting = false;
    if (this.windup.counter) this.counterLeft = Math.max(0, this.counterLeft - 1);
    return this.windup;
  }

  /** AI: keep the wind-up cocked at least until `untilT` (hold while the player leans, §4.1.7). */
  extendWindup(untilT) {
    const w = this.windup;
    if (!w || !Number.isFinite(untilT) || untilT <= w.end) return;
    w.end = untilT;
    w.held = true;
  }

  /** Cancel a wind-up (e.g. interrupted by a hit). */
  cancelWindup() { const w = this.windup; this.windup = null; return w; }

  /** AI: cover up — a high guard right now (ends a reel early) for `ms`; no attacks meanwhile (§2.7). */
  cover(t, ms) {
    if (this.isHuman || this.down || this.terminal) return;
    this.coverUntil = Math.max(this.coverUntil, t + Math.max(0, ms));
    if (this.stunUntil > t) this.stunUntil = t;
    if (this.windup) this.cancelWindup();
    this.aiGuardFrom = 'high'; this.aiGuard = 'high'; this.aiGuardChangedAt = -1e9;
  }

  // ───────────────────────────── punches ─────────────────────────────

  _startPunch(req, t) {
    const C = this.tuning;
    const counter = req.counter != null ? !!req.counter : this.counterReady(t);
    if (this.isHuman && counter) this.counterLeft = Math.max(0, this.counterLeft - 1);
    const powerPunch = !!req.powerPunch;
    const atExtension = this.isHuman && !!req.atExtension;
    const p = {
      id: ++this._pid,
      hand: req.hand, kind: req.kind, target: req.target,
      power: clamp01(num(req.power, C.defaultPower)),
      counter,
      powerPunch,
      damage: Number.isFinite(req.damage) ? req.damage : undefined,
      atExtension,
      thrownAt: t,
      // when the attack first showed: an AI punch's wind-up start (its tell), a human punch's start
      windupStart: Number.isFinite(req.windupStart) ? Math.min(t, req.windupStart) : t,
      stepIn: !this.isHuman && !!req.stepIn,
      impactAt: t + travelMs(req.kind, this.isHuman, this.speed, C, powerPunch, atExtension),
      stage: 'travel', outcome: null, resolvedAt: 0, recoverUntil: 0,
    };
    // the glove re-extends from wherever it was (a recovering punch on this hand is replaced)
    this.punches = this.punches.filter((q) => q.hand !== p.hand);
    this.punches.push(p);
    this.lastPunchStartAt = t;
    this.lastStartBy[p.hand] = t;
    if (this.isHuman) this.handReadyAt[p.hand] = t + num(C.perHandMs, 200);
    this.buffered[p.hand] = null;
    this.stats.thrown++;
    return p;
  }

  /** Punches whose contact time has come (minus an optional deferral for human defenders). */
  duePunches(t, deferMs = 0) {
    const out = [];
    for (const p of this.punches) if (p.stage === 'travel' && p.impactAt + deferMs <= t) out.push(p);
    return out;
  }

  /** Attacker bookkeeping after combat.resolvePunch decided a punch. */
  onPunchResolved(p, res, t) {
    const C = this.tuning;
    const spec = punchSpec(p.kind, C);
    p.outcome = res.result;
    p.resolvedAt = t;
    p.stage = 'recover';
    let rec;
    if (this.isHuman) {
      rec = spec.humanRecoverMs;
      if (res.result === 'blocked') rec += num(C.humanBlockedExtraMs);
      else if (res.result === 'dodged' || res.result === 'miss') rec += num(C.humanWhiffExtraMs);
    } else if (res.result === 'dodged' || res.result === 'miss') {
      rec = num(this.body.whiffRecoverMs, 160);
    } else {
      rec = spec.aiRecoverMs * num(this.body.recoverMul, 1) / Math.sqrt(this.speed);
      if (res.result === 'blocked') rec += num(this.body.blockedRecoverMs);
    }
    p.recoverUntil = t + rec;
    if (!this.isHuman) {
      this.handReadyAt[p.hand] = p.recoverUntil;
      // after a whiff the guard needs guardRaiseMs to get back up (counters can land just after the hang, §2.5)
      if (res.result === 'dodged' || res.result === 'miss') {
        this.guardBackAt = Math.max(this.guardBackAt, p.recoverUntil + num(this.body.guardRaiseMs, 90));
        this._lastWhiff = p;
      }
    }
    if (res.result === 'hit') {
      this.combo = t - this.lastLandAt <= C.comboWindowMs ? this.combo + 1 : 1;
      this.lastLandAt = t;
      this.stats.landed++;
      this.stats.damageDealt = round2(this.stats.damageDealt + num(res.dealt, num(res.damage)));
      if (res.counter) this.stats.counters++;
      if (p.powerPunch) this.stats.powerLanded++;
      if (p.target === 'body') this.stats.bodyLanded++; else this.stats.headLanded++;
    } else {
      this.combo = 0;
      this.stats.missed++;
    }
  }

  /**
   * Defender bookkeeping. Returns notes: [{type:'interrupted', windup}].
   * Health follows res.hpAfter when given (combat.js decides knockdowns); the Match knocks down.
   */
  receive(res, p, t) {
    const C = this.tuning;
    const notes = [];
    if (res.result === 'hit') {
      const before = this.hp;
      const after = Number.isFinite(res.hpAfter) ? res.hpAfter : before - Math.max(0, num(res.damage));
      this.hp = clamp(round2(after), 0, this.maxHp);
      const dealt = round2(Math.max(0, before - this.hp));
      if (dealt > 0) this.lastDamageAt = t;
      this.stats.damageTaken = round2(this.stats.damageTaken + dealt);
      this.stats.hitsTaken++;
      this.takenCombo = t - this.lastTakenAt <= C.comboWindowMs ? this.takenCombo + 1 : 1;
      this.lastTakenAt = t;
      this.hitReact = {
        hand: p.hand, kind: p.kind, target: p.target, strength: clamp01(num(res.damage) / 4), at: t,
        blocked: false, counter: !!res.counter, heavy: !!res.heavy,
      };
      this.taunting = false;
      if (this.isHuman) {
        // a flinch (the HITSTUN phase, for the camera cut and the animation): the guard keeps counting
        // and punches keep registering
        if (res.stunMs > 0) { this.stunStart = t; this.stunUntil = Math.max(this.stunUntil, t + res.stunMs); }
      } else {
        // Wind-up armor: a committed telegraph survives ordinary hits (no reel either) — the
        // player has to defend against it; counters always cut through.
        const armored = !!this.windup && this.body.windupArmor && !res.counter;
        if (this.windup && !armored) notes.push({ type: 'interrupted', windup: this.cancelWindup() });
        if (!armored && res.stunMs > 0) {
          // A reel chain (hits while still reeling) never keeps the guard down longer than maxReelChainMs of
          // REAL time from its first hit (no stun-lock, §2.7). Every clean hit stalls the game clock (the
          // renderer's hit-stop, COMBAT.hitStop) while real time runs on, so the windows already running are
          // pulled in by that stall: they keep their real-time end instead of being stretched by it.
          const fresh = t >= this.stunUntil;
          const net = this._hitStallNet(res);
          if (fresh) {
            this.reelChainStart = t;
            this.reelChainEnd = t + Math.max(res.stunMs, num(C.maxReelChainMs, 900) - net);
          } else {
            this.stunUntil = Math.max(t, this.stunUntil - net);
            this.guardOpenUntil = Math.max(Math.min(t, this.guardOpenUntil), this.guardOpenUntil - net);
            this.reelChainEnd -= net;
          }
          const until = Math.min(Math.max(this.stunUntil, t + res.stunMs), Math.max(this.reelChainEnd, this.stunUntil));
          if (until > t) {
            if (fresh) this.stunStart = t;
            this.stunUntil = until;
            // every clean hit knocks the gloves open for its own span (from this hit), within the reel
            const open = Math.min(until, t + this._guardOpenMs(res));
            this.guardOpenUntil = fresh ? open : Math.max(this.guardOpenUntil, open);
          } else this.guardOpenUntil = Math.min(this.guardOpenUntil, t);
          this.coverUntil = Math.min(this.coverUntil, t);
        }
      }
    } else if (res.result === 'blocked') {
      this.stats.blocked++;
      this.hitReact = { hand: p.hand, kind: p.kind, target: p.target, strength: 0, at: t, blocked: true, counter: false, heavy: false };
    } else if (res.result === 'dodged') {
      this.stats.dodged++;
      // only a fresh dodge opens the counter window (decision R2; the Match sets res.freshDodge for humans)
      if (res.freshDodge !== false) {
        this.counterUntil = t + C.counterWindowMs;
        this.counterLeft = C.counterMaxPunches;
      }
    }
    return notes;
  }

  /** Cancel every wind-up, punch and buffered input (exchange interrupted). */
  cancelAttacks(t) {
    this.windup = null;
    this.punches = [];
    this.guardBackAt = -1e9;
    this.buffered = { left: null, right: null };
    this.handReadyAt = { left: t, right: t };
    this.lastStartBy = { left: -1e9, right: -1e9 };
    this.lastPunchStartAt = -1e9;
  }

  /** Close the post-dodge counter window now (e.g. the counter landed). */
  endCounterWindow(t) { this.counterUntil = Math.min(this.counterUntil, t); this.counterLeft = 0; }

  /**
   * Debug / tests (Match.debugKnockdown): show a blow that landed at `t` — the glove at full extension,
   * pulling back over the normal recovery. No rate limit, no stats, no resolution. Returns the punch.
   * @param {{hand?:string, kind?:string, target?:string, power?:number}} req
   */
  showBlow(req = {}, t = 0) {
    const C = this.tuning;
    const kind = C.punch[req.kind] ? req.kind : 'straight';
    const spec = punchSpec(kind, C);
    const p = {
      id: ++this._pid,
      hand: req.hand === 'right' ? 'right' : 'left', kind, target: req.target === 'body' ? 'body' : 'head',
      power: clamp01(num(req.power, 0.8)), counter: false, powerPunch: false, damage: undefined, atExtension: false,
      thrownAt: t - travelMs(kind, this.isHuman, this.speed, C), impactAt: t,
      stage: 'recover', outcome: 'hit', resolvedAt: t,
      recoverUntil: t + (this.isHuman ? spec.humanRecoverMs : spec.aiRecoverMs), synthetic: true,
    };
    this.punches = this.punches.filter((q) => q.hand !== p.hand);
    this.punches.push(p);
    return p;
  }

  // ───────────────────────────── match-driven states ─────────────────────────────

  knockDown(t) {
    this.cancelAttacks(t);
    this.down = true;
    this.downAt = t;
    this.hp = 0;
    this.knockdowns++;
    this.roundKnockdowns++;
    this.stunUntil = 0; this.coverUntil = 0;
    this.counterUntil = 0; this.counterLeft = 0;
    this.taunting = false;
    this.resting = false;
    this.combo = 0; this.takenCombo = 0;
  }

  /** Rise from a knockdown with hp01 of max health (refill: 10 − 2k wedges, §3.3); GETUP phase for animMs. */
  getUp(t, hp01, animMs = 1200) {
    this.down = false;
    this.getupStart = t;
    this.getupUntil = t + animMs;
    this.hp = Math.max(this.hp, round2(this.maxHp * clamp01(hp01)));
    this.lastDamageAt = t;
    this.samples = [];
  }

  /** 'ko' | 'victory' | 'defeat' | null */
  setTerminal(kind, t) {
    this.cancelAttacks(t);
    this.terminal = kind || null;
    this.terminalAt = t;
    if (kind) { this.stunUntil = 0; this.coverUntil = 0; this.taunting = false; this.resting = false; }
  }

  /** Neutral reset of transient fight state (both boxers when a knockdown/round starts). */
  neutralize(t) {
    this.cancelAttacks(t);
    this.stunUntil = 0; this.coverUntil = 0;
    this.counterUntil = 0; this.counterLeft = 0;
    this.combo = 0; this.takenCombo = 0;
    this.taunting = false;
    this.feintRecoverUntil = 0;
    this.aiLeanTarget = { x: 0, y: 0, z: 0 };
  }

  /** Between rounds: no top-up by default (§1.1, V); clears round knockdowns and transient state. */
  resetForRound(t, heal01 = 0) {
    this.neutralize(t);
    this.hp = Math.min(this.maxHp, this.hp + (this.maxHp - this.hp) * clamp01(heal01));
    this.roundKnockdowns = 0;
    this.getupUntil = 0;
    this.samples = [];
    this.resting = false;
  }

  /** Heal by a fraction of max HP (clamped). Used by training only. */
  heal01(f) { this.hp = Math.min(this.maxHp, this.hp + this.maxHp * Math.max(0, f)); }

  // ───────────────────────────── per-frame ─────────────────────────────

  /**
   * Advance timers. Returns notes: {type:'thrown', punch} | {type:'feint', windup}.
   * @param {number} t
   * @param {Object} [opts]  (legacy `regen` option is accepted and ignored: there is no regeneration)
   */
  update(t, opts = {}) {
    void opts;
    const dt = clamp((t - this._lastUpdateT) / 1000, 0, 0.25);
    this._lastUpdateT = t;
    const notes = [];

    // wind-up → punch (or feint)
    if (this.windup && t >= this.windup.end) {
      const w = this.windup;
      this.windup = null;
      if (!this.canAct(t)) {
        // reeling at the last moment: the punch never leaves
      } else if (w.feint) {
        this.feintRecoverUntil = t + 180;
        this.stats.feints++;
        notes.push({ type: 'feint', windup: w });
      } else {
        const p = this._startPunch({ hand: w.hand, kind: w.kind, target: w.target, power: w.power, counter: w.counter, powerPunch: w.powerPunch, damage: w.damage, windupStart: w.start, stepIn: w.stepIn }, w.end);
        notes.push({ type: 'thrown', punch: p });
      }
    }

    // recover → done
    if (this.punches.length) this.punches = this.punches.filter((p) => !(p.stage === 'recover' && t >= p.recoverUntil));

    // buffered human punches
    if (this.isHuman) {
      for (const hand of ['left', 'right']) {
        const b = this.buffered[hand];
        if (!b) continue;
        if (t > b.until || !this.canAct(t)) { this.buffered[hand] = null; continue; }
        if (this._humanHandReady(hand, t)) {
          const p = this._startPunch(b.req, t);
          notes.push({ type: 'thrown', punch: p });
        }
      }
    }
    if (t >= this.counterUntil) this.counterLeft = 0;

    // AI body: lean follows intent at a capped speed; hands follow the pose
    if (!this.isHuman) {
      const target = this._aiLeanGoal(t);
      const step = (this.aiLeanFast ? num(this.body.slipLeanSpeed, 16) : this.body.leanSpeed) * dt;
      for (const k of ['x', 'y', 'z']) {
        const d = target[k] - this.lean[k];
        this.lean[k] += Math.abs(d) <= step ? d : Math.sign(d) * step;
      }
      this._updateAiHands(t, dt);
    } else {
      this._updateHumanHands(t);
    }

    // phase
    const ph = this._computePhase(t);
    if (ph !== this.phase) { this.phase = ph; this.phaseStart = t; }
    return notes;
  }

  _aiLeanGoal(t) {
    if (this.terminal || this.down) return NEUTRAL_LEAN;
    if (t < this.stunUntil) return { x: 0, y: 0, z: -0.3 };
    const w = this.windup;
    const tell = this.body.tells || {};
    if (w) {
      const k = smooth((t - w.start) / Math.max(1, (w.baseEnd - w.start) * 0.7));
      const big = w.powerPunch ? 1.5 : 1;
      return { x: handSign(w.hand) * 0.16 * big * num(tell.shoulder, 1) * k, y: w.kind === 'uppercut' ? -0.18 * k : 0, z: -0.18 * big * k };
    }
    const tr = this.travelling();
    // (a step-in shows as a bigger lean into the punch; it stays below the forward-tilt dodge threshold)
    if (tr) return { x: handSign(tr.hand) * -0.08, y: 0, z: tr.stepIn ? 0.5 : 0.28 };
    return this.aiLeanTarget;
  }

  _poseHands(name) {
    const pose = POSES[name] || POSES.none;
    const lead = this.leadHand();
    const mk = (hand) => {
      const src = hand === lead ? pose.lead : pose.rear;
      return { x: handSign(hand) * src.x, y: src.y, reach: src.reach, punching: false };
    };
    return { left: mk('left'), right: mk('right') };
  }

  _signed(pose, hand) { return { x: handSign(hand) * pose.x, y: pose.y, reach: pose.reach }; }

  /** The guard the gloves are showing (view): what the AI is holding or moving to. */
  _viewGuard(t) {
    if (this.terminal || this.down || t < this.getupUntil) return 'none';
    if (this.isHuman) return this.guard;
    if (t < this.coverUntil && !this.travelling()) return 'high';
    if (this._stunOpensGuard(t) || this.taunting || this.resting || this._punchOpensGuard(t)) return 'none';
    return this.aiGuard;
  }

  _basePoseName(t) {
    if (this.down || this.terminal === 'ko') return 'down';
    if (this.resting) return 'rest';
    if (this.taunting) return 'taunt';
    if (this._stunOpensGuard(t)) return 'reel';
    const g = this._viewGuard(t);
    return g === 'high' || g === 'low' ? g : 'none';
  }

  _updateAiHands(t, dt) {
    const base = this._poseHands(this._basePoseName(t));
    const tells = this.body.tells || {};
    const pull = clamp(num(tells.pullback, 1), 0.3, 1.3);
    const k = 1 - Math.exp(-16 * dt);
    for (const hand of ['left', 'right']) {
      let target = base[hand];
      let direct = false;
      let punching = false;
      const w = this.windup;
      const p = this.punchOn(hand);
      if (w && w.hand === hand) {
        const poses = w.powerPunch ? POWER_WINDUP_POSES : WINDUP_POSES;
        const cocked = lerpPose(target, this._signed(poses[w.kind][w.target], hand), pull);
        target = lerpPose(base[hand], cocked, smooth((t - w.start) / Math.max(1, (w.baseEnd - w.start) * 0.7)));
        direct = true;
      } else if (p) {
        const poses = p.powerPunch ? POWER_WINDUP_POSES : WINDUP_POSES;
        const from = lerpPose(base[hand], this._signed(poses[p.kind][p.target], hand), pull);
        const hit = this._signed(IMPACT_POSES[p.kind][p.target], hand);
        if (p.stage === 'travel') {
          target = lerpPose(from, hit, smooth((t - p.thrownAt) / Math.max(1, p.impactAt - p.thrownAt)));
          punching = true;
        } else if (p.outcome === 'dodged' || p.outcome === 'miss') {
          // the missed glove hangs out, then comes back over the last third of the recovery (§2.3)
          const span = Math.max(1, p.recoverUntil - p.resolvedAt);
          target = lerpPose(hit, base[hand], smooth(((t - p.resolvedAt) / span - 0.66) / 0.34));
        } else {
          target = lerpPose(hit, base[hand], smooth((t - p.resolvedAt) / Math.max(1, p.recoverUntil - p.resolvedAt)));
        }
        direct = true;
      }
      const cur = this.hands[hand];
      if (direct) this.hands[hand] = { x: target.x, y: target.y, reach: target.reach, punching };
      else this.hands[hand] = { x: lerp(cur.x, target.x, k), y: lerp(cur.y, target.y, k), reach: lerp(cur.reach, target.reach, k), punching: false };
    }
  }

  _updateHumanHands(t) {
    const c = this.control;
    const base = this._poseHands(this.down || this.terminal === 'ko' ? 'down' : this.guard === 'high' || this.guard === 'low' ? this.guard : 'none');
    for (const hand of ['left', 'right']) {
      const src = c && c.hands && c.hands[hand];
      let h = src && !this.down
        ? { x: clamp(num(src.x, base[hand].x), -2, 2), y: clamp(num(src.y, base[hand].y), -2, 2), reach: clamp01(num(src.reach, base[hand].reach)), punching: false }
        : { ...base[hand], punching: false };
      const p = this.punchOn(hand);
      if (p) {
        const hit = this._signed(IMPACT_POSES[p.kind][p.target], hand);
        const k = p.stage === 'travel'
          ? smooth((t - p.thrownAt) / Math.max(1, p.impactAt - p.thrownAt))
          : 1 - smooth((t - p.resolvedAt) / Math.max(1, p.recoverUntil - p.resolvedAt));
        h = { x: lerp(h.x, hit.x, k * 0.6), y: lerp(h.y, hit.y, k * 0.6), reach: Math.max(h.reach, k * hit.reach), punching: p.stage === 'travel' };
      }
      this.hands[hand] = h;
    }
    void t;
  }

  _computePhase(t) {
    if (this.terminal) return this.terminal;
    if (this.down) return 'down';
    if (t < this.getupUntil) return 'getup';
    if (t < this.stunUntil) return 'hitstun';
    if (this.travelling()) return 'punch';
    if (this.windup) return 'windup';
    if (this.isDodging()) return 'dodge';
    if (this.punches.length) return 'recover';
    if (this._viewGuard(t) !== 'none') return 'guard';
    return 'idle';
  }

  _phaseProgress(t) {
    const ph = this.phase;
    const span = (a, b) => clamp01((t - a) / Math.max(1, b - a));
    switch (ph) {
      case 'windup': return this.windup ? span(this.windup.start, this.windup.baseEnd) : 1;
      case 'punch': { const p = this.travelling(); return p ? span(p.thrownAt, p.impactAt) : 1; }
      case 'recover': {
        let best = 1;
        for (const p of this.punches) if (p.stage === 'recover') best = Math.min(best, span(p.resolvedAt, p.recoverUntil));
        return best;
      }
      case 'hitstun': return span(this.stunStart, this.stunUntil);
      case 'getup': return span(this.getupStart, this.getupUntil);
      default: return clamp01((t - this.phaseStart) / (PHASE_NOMINAL_MS[ph] || 400));
    }
  }

  _expression(t) {
    if (this.terminal === 'ko') return 'ko';
    if (this.terminal === 'victory') return 'happy';
    if (this.terminal === 'defeat') return 'sad';
    if (this.down) return 'dazed';
    if (t < this.getupUntil) return 'hurt';
    const hr = this.hitReact;
    // the face shows pain for 0.8–1 s after a clean hit (§2.3)
    if (t < this.stunUntil || (hr && !hr.blocked && t - hr.at < 900)) return 'hurt';
    if (this.taunting) return 'happy';
    if (this.windup || this.travelling() || this.counterReady(t)) return 'focus';
    if (this._viewGuard(t) !== 'none') return 'focus';
    if (this.hp01 < 0.25) return 'hurt';
    return 'neutral';
  }

  _punchView(p, t) {
    let progress;
    if (p.stage === 'travel') progress = clamp01((t - p.thrownAt) / Math.max(1, p.impactAt - p.thrownAt));
    else progress = 1 - clamp01((t - p.resolvedAt) / Math.max(1, p.recoverUntil - p.resolvedAt));
    return {
      id: p.id, hand: p.hand, kind: p.kind, target: p.target, progress,
      impact: p.stage === 'recover' && t - p.resolvedAt < IMPACT_FLASH_MS,
      stage: p.stage, outcome: p.outcome, counter: !!p.counter, power: p.power, powerPunch: !!p.powerPunch,
    };
  }

  /**
   * Complete BoxerView for this frame (see types.js; optional extras documented there).
   * @param {number} t
   * @returns {import('../core/types.js').BoxerView}
   */
  toView(t) {
    const punches = this.punches.map((p) => this._punchView(p, t));
    let punch = null;
    const tr = punches.filter((p) => p.stage === 'travel');
    if (tr.length) punch = tr.reduce((a, b) => (a.id > b.id ? a : b));
    else if (punches.length) punch = punches.reduce((a, b) => (a.id > b.id ? a : b));
    const w = this.windup;
    const windup = w ? {
      id: w.id, hand: w.hand, kind: w.kind, target: w.target,
      progress: clamp01((t - w.start) / Math.max(1, w.baseEnd - w.start)),
      msLeft: Math.max(0, w.end - t),
      tellMs: w.ms + w.travelMs,
      held: !!w.held,
      powerPunch: !!w.powerPunch,
      tell: { ...w.tell },
    } : null;
    if (!punch && windup) {
      // During a wind-up `punch` describes the coming punch at progress 0 (stage 'windup').
      punch = { id: w.id, hand: w.hand, kind: w.kind, target: w.target, progress: 0, impact: false, stage: 'windup', outcome: null, counter: !!w.counter, power: w.power, powerPunch: !!w.powerPunch };
    }
    const hr = this.hitReact && t - this.hitReact.at <= HIT_REACT_KEEP_MS ? {
      hand: this.hitReact.hand, kind: this.hitReact.kind, target: this.hitReact.target,
      strength: this.hitReact.strength, age: Math.max(0, (t - this.hitReact.at) / 1000),
      blocked: this.hitReact.blocked, counter: this.hitReact.counter, heavy: !!this.hitReact.heavy,
    } : null;
    const guard = this._viewGuard(t);
    return {
      id: this.id,
      name: this.name,
      isHuman: this.isHuman,
      // display only: this frame's ControlState was tracked (the renderer holds the last tracked hands / lean over a
      // short dropout instead of showing the stance pose; VIEW3D-LOST-FRAME) — nothing in combat reads it
      tracked: this.isHuman ? this.control !== null : true,
      appearance: this.appearance,
      phase: this.phase,
      phaseProgress: this._phaseProgress(t),
      hp01: this.hp01,
      hp: round2(this.hp),
      maxHp: this.maxHp,
      stamina01: 1,
      daze01: 0,
      guard,
      guardAmount: this.isHuman ? this.guardAmount : (guard === 'none' ? 0 : 1),
      lean: { x: this.lean.x, y: this.lean.y, z: this.lean.z },
      hands: {
        left: { ...this.hands.left },
        right: { ...this.hands.right },
      },
      punch,
      punches,
      windup,
      hitReact: hr,
      knockdowns: this.knockdowns,
      roundKnockdowns: this.roundKnockdowns,
      counterReady: this.counterReady(t),
      dazed: false,
      stunned: t < this.stunUntil,
      reeling: !this.isHuman && this._stunOpensGuard(t),
      covering: !this.isHuman && t < this.coverUntil,
      taunting: !!this.taunting,
      resting: !!this.resting,
      expression: this._expression(t),
      activity: this.activity,
    };
  }
}
