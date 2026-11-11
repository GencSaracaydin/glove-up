// KeyboardInput — keyboard fallback / debug input with EXACTLY the output shape of
// GestureRecognizer: update(tMs, player) → {control: ControlState, events: InputEvent[]}.
// The game is fully playable and testable with no camera (`?input=keyboard`).
//
// Default map (ARCHITECTURE.md §keyboard; every mechanic of research/mechanics.md §2.1 is reachable):
//   P1: J/K left/right punch · U/I left/right hook · N/M left/right uppercut ·
//       hold Shift while punching → body · hold E while punching → power punch (power 1) ·
//       hold Space → high guard · hold B → low guard ·
//       hold A/D → lean (dodge) left/right · hold S → duck · hold X → lean back · hold W → lean in ·
//       Esc/P → pause. Getting up from a knockdown: mash the punch keys (every press is a punch).
//   P2 (versus): 1/2 punches · 4/5 hooks · 7/8 uppercuts · hold 3 → body · hold 6 → power ·
//       hold 0 → high guard · hold 9 → low guard · ←/→ lean · ↓ duck · ↑ lean in · / lean back
//       (top row or number pad: Num 0–9 and Num / work like 0–9 and /; Num . is also low guard and
//       Num − also lean back. The first key of each action is the top-row one: help.js names it).
//   In single-player, P2's keys also drive P1 (so arrows lean too).
//
// Hand positions animate plausibly (gloves rise for guard, extend on punches with per-kind
// paths and the game's per-kind travel/recovery times, lean/duck ease in/out) so the boxer
// looks alive exactly as with the camera.
// Key repeat is ignored (holding J throws one punch). Keys typed into text fields are ignored.
//
// Pure logic; DOM is only touched in attach()/detach().

import { Hand, PunchKind, Target, GuardKind } from '../core/types.js';

/** Animation + feel tunables. Punch timings follow the measured ~0.12–0.2 s glove travel. */
export const KEYBOARD_TUNING = Object.freeze({
  /** PunchInput.power for keyboard punches (keys carry no speed information) — about a normal
   *  camera punch (a 200 ms extension reads ≈ 0.6) … */
  punchPower: 0.6,
  /** … and while the power key is held (a snappy camera punch reads ≈ 0.85–1). */
  powerPunchPower: 1,
  /** Glove travel out to full extension per punch kind (ms) — mirrors COMBAT.punch[kind].humanTravelMs
   *  (game/combat.js) so the animated glove peaks when the game resolves the punch. A number = all kinds. */
  extendMs: Object.freeze({ straight: 140, hook: 175, uppercut: 195 }),
  /** Time held at full extension (ms). */
  holdMs: 50,
  /** Pull back to the guard per kind (ms) — mirrors COMBAT.punch[kind].humanRecoverMs. */
  retractMs: Object.freeze({ straight: 200, hook: 250, uppercut: 290 }),
  /** Time constant for raising/lowering the guard (ms). */
  guardTauMs: 70,
  /** Time constant for leaning/ducking into a dodge (ms). */
  leanInTauMs: 70,
  /** Time constant for returning to centre (ms). */
  leanOutTauMs: 110,
  /** Activity added per punch keypress (mash punches to get up during a count). */
  activityPerPunch: 0.3,
  /** Activity decay time constant (ms). */
  activityTauMs: 800,
  /** Head offset (shoulder widths) at full lean / full duck. */
  headPerLean: 0.5,
  headPerDuck: 0.45,
  /** In 1-player mode, the P2 bindings also control P1. */
  p2KeysDriveP1WhenSingle: true,
});

/** Actions a keymap can bind. Values are KeyboardEvent.code strings. */
export const KEY_ACTIONS = Object.freeze(['punchLeft', 'punchRight', 'hookLeft', 'hookRight', 'uppercutLeft', 'uppercutRight',
  'body', 'power', 'guardHigh', 'guardLow', 'leanLeft', 'leanRight', 'duck', 'leanBack', 'leanIn', 'pause', 'confirm', 'back']);

export const DEFAULT_KEYMAP = Object.freeze({
  p1: Object.freeze({
    punchLeft: ['KeyJ'], punchRight: ['KeyK'],
    hookLeft: ['KeyU'], hookRight: ['KeyI'],
    uppercutLeft: ['KeyN'], uppercutRight: ['KeyM'],
    body: ['ShiftLeft', 'ShiftRight'], power: ['KeyE'],
    guardHigh: ['Space'], guardLow: ['KeyB'],
    leanLeft: ['KeyA'], leanRight: ['KeyD'], duck: ['KeyS'], leanBack: ['KeyX'], leanIn: ['KeyW'],
    pause: ['Escape', 'KeyP'], confirm: [], back: [],
  }),
  p2: Object.freeze({
    punchLeft: ['Digit1', 'Numpad1'], punchRight: ['Digit2', 'Numpad2'],
    hookLeft: ['Digit4', 'Numpad4'], hookRight: ['Digit5', 'Numpad5'],
    uppercutLeft: ['Digit7', 'Numpad7'], uppercutRight: ['Digit8', 'Numpad8'],
    body: ['Digit3', 'Numpad3'], power: ['Digit6', 'Numpad6'],
    guardHigh: ['Digit0', 'Numpad0'], guardLow: ['Digit9', 'Numpad9', 'NumpadDecimal'],
    leanLeft: ['ArrowLeft'], leanRight: ['ArrowRight'], duck: ['ArrowDown'], leanBack: ['Slash', 'NumpadDivide', 'NumpadSubtract'], leanIn: ['ArrowUp'],
    pause: [], confirm: [], back: [],
  }),
});

const PUNCH_ACTIONS = Object.freeze({
  punchLeft: [Hand.LEFT, PunchKind.STRAIGHT], punchRight: [Hand.RIGHT, PunchKind.STRAIGHT],
  hookLeft: [Hand.LEFT, PunchKind.HOOK], hookRight: [Hand.RIGHT, PunchKind.HOOK],
  uppercutLeft: [Hand.LEFT, PunchKind.UPPERCUT], uppercutRight: [Hand.RIGHT, PunchKind.UPPERCUT],
});
const EVENT_ACTIONS = Object.freeze({ pause: 'pause', confirm: 'confirm', back: 'back' });
/** Keys whose browser default (page scroll) must be suppressed while playing. */
const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

/** Glove rest poses (player perspective, shoulder widths; y up from the shoulder line). */
export const HAND_POSES = Object.freeze({
  idle: { left: { x: -0.32, y: 0.08, reach: 0.14 }, right: { x: 0.3, y: 0.02, reach: 0.08 } },
  high: { left: { x: -0.19, y: 0.44, reach: 0.06 }, right: { x: 0.19, y: 0.44, reach: 0.06 } },
  low: { left: { x: -0.24, y: -0.58, reach: 0.18 }, right: { x: 0.24, y: -0.58, reach: 0.18 } },
});

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const lerp = (a, b, k) => a + (b - a) * k;
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));

/** Human-readable label for a KeyboardEvent.code ("KeyJ" → "J", "ArrowLeft" → "←"). */
export function keyLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  const named = {
    Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', NumpadDecimal: 'Num .', Tab: 'Tab',
    Slash: '/', NumpadDivide: 'Num /', NumpadSubtract: 'Num −', Minus: '−',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  };
  return named[code] || code;
}

/** Merge a partial keymap over the defaults. */
export function mergeKeymap(partial = {}) {
  const out = {};
  for (const p of ['p1', 'p2']) {
    out[p] = {};
    for (const a of KEY_ACTIONS) {
      const v = partial[p] && partial[p][a];
      out[p][a] = Array.isArray(v) ? [...v] : [...(DEFAULT_KEYMAP[p][a] || [])];
    }
  }
  return out;
}

/** Fresh neutral ControlState (also used as the "no input" value by the hub). */
export function neutralControl({ tracked = true } = {}) {
  return {
    tracked,
    confidence: tracked ? 1 : 0,
    guard: GuardKind.NONE,
    guardAmount: 0,
    lean: { x: 0, y: 0, z: 0 },
    head: { x: 0, y: 0 },
    hands: {
      left: { ...HAND_POSES.idle.left, punching: false },
      right: { ...HAND_POSES.idle.right, punching: false },
    },
    activity: 0,
  };
}

class KeyPlayer {
  constructor() { this.reset(); }
  reset() {
    /** action → number of bound keys currently held */
    this.held = new Map();
    /** @type {{left:null|{kind:string,target:string,start:number}, right:null|{kind:string,target:string,start:number}}} */
    this.punch = { left: null, right: null };
    this.guardAmt = 0;
    this.guardKind = GuardKind.HIGH;
    this.lean = { x: 0, y: 0, z: 0 };
    this.activity = 0;
    this.activityT = null;
    this.events = [];
    this.lastT = null;
    this.lastPunchT = -Infinity;
    this.guardSince = null;    // when the current non-'none' guard began (ControlState.guardMs)
    this.guardShown = GuardKind.NONE;
    this.stanceSince = null;   // when the boxer last settled into the stance (ControlState.stanceMs)
  }
  /** Decay activity up to time t. */
  decayActivity(t, tauMs) {
    if (this.activityT !== null && t > this.activityT) this.activity *= Math.exp(-(t - this.activityT) / tauMs);
    if (this.activityT === null || t > this.activityT) this.activityT = t;
  }
  isHeld(action) { return (this.held.get(action) || 0) > 0; }
}

export class KeyboardInput {
  /**
   * @param {{keymap?:object, players?:1|2, tuning?:object, target?:EventTarget|null}} [opts]
   */
  constructor({ keymap = {}, players = 1, tuning = {}, target = null } = {}) {
    this.tuning = { ...KEYBOARD_TUNING, ...tuning };
    this.players = players === 2 ? 2 : 1;
    this.keymap = mergeKeymap(keymap);
    this._state = [new KeyPlayer(), new KeyPlayer()];
    /** code → the bindings ({p, action}) that key pressed — released together on keyup */
    this._down = new Map();
    this._target = null;
    this._onKeyDown = (e) => this._dom(e, true);
    this._onKeyUp = (e) => this._dom(e, false);
    this._onBlur = () => this.releaseAll();
    this._onVis = () => { if (typeof document !== 'undefined' && document.hidden) this.releaseAll(); };
    this._index();
    if (target) this.attach(target);
  }

  setKeymap(partial) { this.releaseAll(); this.keymap = mergeKeymap(partial); this._index(); }
  setPlayers(n) { this.players = n === 2 ? 2 : 1; this.releaseAll(); this._index(); }

  /** Build code → [{p, action}] lookup. */
  _index() {
    /** @type {Map<string, Array<{p:number, action:string}>>} */
    this._byCode = new Map();
    const add = (code, p, action) => {
      if (!this._byCode.has(code)) this._byCode.set(code, []);
      const list = this._byCode.get(code);
      if (!list.some((b) => b.p === p && b.action === action)) list.push({ p, action });
    };
    for (const a of KEY_ACTIONS) for (const code of this.keymap.p1[a]) add(code, 0, a);
    for (const a of KEY_ACTIONS) {
      for (const code of this.keymap.p2[a]) {
        if (this.players === 2) add(code, 1, a);
        else if (this.tuning.p2KeysDriveP1WhenSingle && !this._byCode.has(code)) add(code, 0, a);
      }
    }
  }

  /** Listen to keydown/keyup on `target` (default: window). */
  attach(target = (typeof window !== 'undefined' ? window : null)) {
    if (!target || this._target === target) return this;
    this.detach();
    this._target = target;
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    if (typeof window !== 'undefined') window.addEventListener('blur', this._onBlur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVis);
    return this;
  }

  detach() {
    const t = this._target;
    if (!t) return;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this._onBlur);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    this._target = null;
    this.releaseAll();
  }

  get attached() { return !!this._target; }

  _dom(e, down) {
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) { if (down) return; }
    const used = this.handleKey(e.code, down, { repeat: !!e.repeat, t: nowMs() });
    if (used && SCROLL_KEYS.has(e.code) && typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * Feed one key transition (DOM-free; used by tests and by attach()).
   * @param {string} code KeyboardEvent.code
   * @param {boolean} down
   * @param {{repeat?:boolean, t?:number}} [opts]
   * @returns {boolean} true if the key is bound
   */
  handleKey(code, down, { repeat = false, t = nowMs() } = {}) {
    const binds = this._byCode.get(code);
    if (!binds) return false;
    if (down) {
      if (repeat || this._down.has(code)) return true; // auto-repeat: ignore
      this._down.set(code, binds);
      for (const { p, action } of binds) {
        if (p >= this.players) continue;
        const st = this._state[p];
        if (st.lastT === null) st.lastT = t; // first input: start easing from the key press
        st.held.set(action, (st.held.get(action) || 0) + 1);
        this._press(st, action, t);
      }
    } else {
      const was = this._down.get(code);
      if (!was) return true;
      this._down.delete(code);
      for (const { p, action } of was) {
        const st = this._state[p];
        const n = (st.held.get(action) || 0) - 1;
        if (n > 0) st.held.set(action, n); else st.held.delete(action);
      }
    }
    return true;
  }

  _press(st, action, t) {
    const pa = PUNCH_ACTIONS[action];
    if (pa) {
      const [hand, kind] = pa;
      const target = st.isHeld('body') ? Target.BODY : Target.HEAD;
      const power = st.isHeld('power') ? this.tuning.powerPunchPower : this.tuning.punchPower;
      st.punch[hand] = { kind, target, start: t };
      st.lastPunchT = t;
      st.decayActivity(t, this.tuning.activityTauMs);
      st.activity = Math.min(1, st.activity + this.tuning.activityPerPunch);
      st.events.push({ type: 'punch', t, punch: { hand, kind, target, power, t } });
      return;
    }
    const ev = EVENT_ACTIONS[action];
    if (ev) st.events.push({ type: ev, t });
    if (action === 'guardHigh') st.guardKind = GuardKind.HIGH;
    if (action === 'guardLow') st.guardKind = GuardKind.LOW;
  }

  /** Release every held key (window blur, tab hidden, mode switch). */
  releaseAll() {
    this._down.clear();
    for (const st of this._state) st.held.clear();
  }

  /** Forget everything (held keys, punches in flight, queued events). */
  reset() {
    this._down.clear();
    for (const st of this._state) st.reset();
  }

  /** @returns {boolean} whether `action` is held for `player`. */
  isHeld(action, player = 0) { return this._state[player].isHeld(action); }

  /**
   * Advance animation to `tMs` and drain this player's events.
   * @param {number} [tMs]
   * @param {number} [player] 0 = P1, 1 = P2
   * @returns {{control: import('../core/types.js').ControlState, events: import('../core/types.js').InputEvent[]}}
   */
  update(tMs = nowMs(), player = 0) {
    const T = this.tuning;
    const st = this._state[player];
    const dt = st.lastT === null ? 0 : Math.max(0, tMs - st.lastT);
    st.lastT = tMs;

    // punches in flight
    const punching = { left: false, right: false };
    const ext = { left: 0, right: 0 };
    const back = { left: false, right: false };
    for (const h of [Hand.LEFT, Hand.RIGHT]) {
      const p = st.punch[h];
      if (!p) continue;
      const out = kindMs(T.extendMs, p.kind), ret = kindMs(T.retractMs, p.kind);
      const flight = out + T.holdMs;
      const age = tMs - p.start;
      if (age >= flight + ret) { st.punch[h] = null; continue; }
      if (age < out) ext[h] = easeOut(Math.max(0, age) / out);
      else if (age < flight) ext[h] = 1;
      else { ext[h] = 1 - easeInOut((age - flight) / ret); back[h] = true; }
      punching[h] = age < flight;
    }

    // guard: held key raises the gloves; throwing a punch drops the guard (as with the camera)
    const highHeld = st.isHeld('guardHigh'), lowHeld = st.isHeld('guardLow');
    if (highHeld && !lowHeld) st.guardKind = GuardKind.HIGH;
    else if (lowHeld && !highHeld) st.guardKind = GuardKind.LOW;
    const anyPunch = !!(st.punch.left || st.punch.right);
    const guardTarget = (highHeld || lowHeld) && !anyPunch ? 1 : 0;
    st.guardAmt = approach(st.guardAmt, guardTarget, dt, T.guardTauMs);
    const guard = st.guardAmt >= 0.5 ? st.guardKind : GuardKind.NONE;

    // lean / duck
    const tx = (st.isHeld('leanRight') ? 1 : 0) - (st.isHeld('leanLeft') ? 1 : 0);
    const ty = st.isHeld('duck') ? -1 : 0;
    const tz = (st.isHeld('leanIn') ? 1 : 0) - (st.isHeld('leanBack') ? 1 : 0);
    st.lean.x = approach(st.lean.x, tx, dt, tx !== 0 ? T.leanInTauMs : T.leanOutTauMs);
    st.lean.y = approach(st.lean.y, ty, dt, ty !== 0 ? T.leanInTauMs : T.leanOutTauMs);
    st.lean.z = approach(st.lean.z, tz, dt, tz !== 0 ? T.leanInTauMs : T.leanOutTauMs);

    st.decayActivity(tMs, T.activityTauMs);

    // hands: rest pose (idle ↔ guard) + punch path
    const guardPose = HAND_POSES[st.guardKind === GuardKind.LOW ? 'low' : 'high'];
    const hands = {};
    for (const h of [Hand.LEFT, Hand.RIGHT]) {
      const idle = HAND_POSES.idle[h], gp = guardPose[h];
      const base = {
        x: lerp(idle.x, gp.x, st.guardAmt),
        y: lerp(idle.y, gp.y, st.guardAmt),
        reach: lerp(idle.reach, gp.reach, st.guardAmt),
      };
      const p = st.punch[h];
      hands[h] = p ? punchPath(base, h, p.kind, p.target, ext[h], back[h]) : base;
      hands[h].punching = punching[h];
    }

    // how long the guard / the plain stance have been held (tutorial steps, input/tutorial-detect.js)
    if (guard !== st.guardShown) { st.guardShown = guard; st.guardSince = guard === GuardKind.NONE ? null : tMs; }
    const settled = !anyPunch && Math.abs(st.lean.x) < 0.1 && Math.abs(st.lean.y) < 0.1 && Math.abs(st.lean.z) < 0.1;
    if (!settled) st.stanceSince = null; else if (st.stanceSince === null) st.stanceSince = tMs;
    const control = {
      tracked: true,
      confidence: 1,
      guard,
      guardAmount: st.guardAmt,
      lean: { x: st.lean.x, y: st.lean.y, z: st.lean.z },
      head: { x: st.lean.x * T.headPerLean, y: st.lean.y * T.headPerDuck },
      hands,
      activity: st.activity,
      guardMs: st.guardSince === null ? 0 : tMs - st.guardSince,
      stanceMs: st.stanceSince === null ? 0 : tMs - st.stanceSince,
    };
    const events = st.events;
    st.events = [];
    return { control, events };
  }

  /** update() for every active player → PlayerInput[] (length = players). */
  updateAll(tMs = nowMs()) {
    const out = [];
    for (let i = 0; i < this.players; i++) out.push(this.update(tMs, i));
    return out;
  }

  /** Bindings for help screens: [{player:1|2, action, keys:['J', …]}]. */
  describe() {
    const rows = [];
    for (let p = 0; p < this.players; p++) {
      const map = this.keymap[p === 0 ? 'p1' : 'p2'];
      for (const a of KEY_ACTIONS) if (map[a].length) rows.push({ player: p + 1, action: a, keys: [...new Set(map[a].map(keyLabel))] });
    }
    return rows;
  }
}

/** Per-kind timing value (a plain number applies to every kind). */
function kindMs(v, kind) {
  return typeof v === 'number' ? v : (v[kind] ?? v.straight);
}

/** Exponential approach of `v` toward `target` with time constant `tau` over `dt` ms. */
function approach(v, target, dt, tau) {
  if (dt <= 0) return v;
  const k = 1 - Math.exp(-dt / Math.max(1, tau));
  const n = v + (target - v) * k;
  return Math.abs(n - target) < 1e-4 ? target : n;
}

/**
 * Glove position along a punch. e = extension 0..1; `back` = retracting (straight line home).
 * Straights drive to the centre line; hooks arc wide then across; uppercuts dip then rise.
 */
function punchPath(base, hand, kind, target, e, back) {
  const side = hand === Hand.RIGHT ? 1 : -1;
  const head = target === Target.HEAD;
  let tx, ty, treach;
  switch (kind) {
    case PunchKind.HOOK: tx = side * 0.05; ty = head ? 0.32 : -0.3; treach = 0.72; break;
    case PunchKind.UPPERCUT: tx = side * 0.1; ty = head ? 0.58 : -0.05; treach = 0.62; break;
    default: tx = side * 0.12; ty = head ? 0.3 : -0.32; treach = 1;
  }
  let x = lerp(base.x, tx, e), y = lerp(base.y, ty, e);
  if (!back && kind === PunchKind.HOOK) {
    x += side * 0.55 * Math.sin(Math.PI * e);            // swing out wide, then across
  } else if (!back && kind === PunchKind.UPPERCUT) {
    const DIP = 0.3, SPLIT = 0.3;                        // drop the glove first, then drive up
    y = e < SPLIT ? base.y - DIP * Math.sin((e / SPLIT) * Math.PI / 2)
      : lerp(base.y - DIP, ty, (e - SPLIT) / (1 - SPLIT));
  }
  return { x, y, reach: lerp(base.reach, treach, e) };
}
