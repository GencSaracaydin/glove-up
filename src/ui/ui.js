// Screen manager + navigation for Glove Up menus.
//
// Usage (the app owns the flow, the UI owns screens):
//   const ui = new UI({ root, bus, storage, input, audio });
//   const r = await ui.show('mode', { profile });   // → { action: 'single' | 'versus' | … }
//   ui.hide();                                       // back to the 3D scene / HUD
//   ui.hud.show('match', { mode: 'single' }); …per frame… ui.hud.update(matchView);
//   ui.update(dt, now);                              // per frame (screen updates and animations)
//
// show() returns a Promise that resolves ONCE with the screen's result ({action, …}).
// A screen stays on display (inert) after resolving until the next show()/hide(), so async
// work between screens never flashes an empty frame. Calling show()/hide() while a screen is
// still waiting resolves that earlier promise with {action:'superseded'}.
//
// Input: mouse/touch click and keyboard (arrows/Tab move, Enter/Space confirm, Esc/Backspace
// back, P pause/continue). There is no camera pointer on the menus: the raised-hand pointer was
// removed on 2026-11-08 at the user's request. The camera drives only the in-game gestures (pause by
// both hands up, the tracking-lost guard hold, skipping the KO outro); screens get the per-player
// ControlState through update(dt, now, {controls}).
// Events: Ev.UI_CLICK {id, screen, source}, Ev.UI_NAV {action}, Ev.APP_SCREEN {screen}.
//
// Spec: SET01 (profiles), ERR01 (camera setup), ERR02 (tracking lost),
// SES01/SES02 (pause), MAT04 (result), PRG02 (results card), TRN01/TRN02 (training), ERR04 (saves).
// Alignment pass (ARCHITECTURE.md §6.7–6.9): 'vs' = VS card (old id 'opponent'), 'results' = rating card
// (old id 'skill'), 'result' = decision reveal / winner card (also 'decision', 'versus-result').

import { Ev } from '../core/types.js';
import { UI_TUNING, h, icon, button, pickNeighbor, clamp } from './screens/kit.js';
import { provideDeps, preloadDeps, loadDep, peekDep } from './screens/deps.js';
import { portraits } from './screens/portrait.js';
import { Hud } from './hud.js';

import title from './screens/title.js';
import profiles from './screens/profiles.js';
import profileEditor from './screens/profile-editor.js';
import mode from './screens/mode.js';
import cameraSetup from './screens/camera-setup.js';
import calibrate from './screens/calibrate.js';
import vs from './screens/vs.js';
import opponent from './screens/opponent.js';
import pause from './screens/pause.js';
import trackingLost from './screens/tracking-lost.js';
import result from './screens/result.js';
import results from './screens/results.js';
import skill from './screens/skill.js';
import trainingSelect from './screens/training-select.js';
import trainingResult from './screens/training-result.js';
import records from './screens/records.js';
import settings from './screens/settings.js';
import help from './screens/help.js';

/**
 * @typedef {Object} ScreenInstance
 * @property {HTMLElement} el
 * @property {(dt:number, now:number) => void} [update]   per frame while visible and on top
 * @property {() => (boolean|void)} [back]  Esc/Backspace/back gesture. Return true when handled; omit → done({action:'back'})
 * @property {(subResult:any) => void} [refresh]  a sub-screen returned (re-render with fresh data)
 * @property {() => (HTMLElement|null)} [focus]   element to focus first
 * @property {() => void} [destroy]
 */
/**
 * @typedef {Object} ScreenDef
 * @property {string} id
 * @property {string} title                     accessible name
 * @property {'menu'|'overlay'} [layer]          overlay = drawn over gameplay with a dim backdrop (HUD stays)
 * @property {number} [armDelayMs]               ignore activations right after entering
 * @property {boolean} [noBack]                  Esc/back does nothing (e.g. title)
 * @property {(ctx: ScreenCtx, params: any) => ScreenInstance} create
 */
/**
 * @typedef {Object} ScreenCtx
 * @property {UI} ui
 * @property {any} bus
 * @property {any} storage
 * @property {any} input
 * @property {any} audio
 * @property {(result:any) => void} done            resolve this screen
 * @property {(id:string, params?:any) => Promise<any>} sub   open a nested screen; resolves with its result
 * @property {(text:string, opts?:{kind?:string, ms?:number}) => void} toast
 * @property {(name:string) => void} sfx
 * @property {(appearance:any, opts?:any) => HTMLCanvasElement} portrait
 * @property {() => any} settings                   current settings (copy)
 * @property {{peek:(n:string)=>any, load:(n:string)=>Promise<any>}} deps
 * @property {(ms:number) => void} arm              (re)arm: ignore activations for ms
 * @property {() => void} refocus
 */

/** A screen registered under a second id (ui.current.id / Ev.APP_SCREEN report the id it was shown as). */
const alias = (def, id) => Object.freeze({ ...def, id });

/** All screens by id. */
export const SCREENS = Object.freeze({
  title, profiles, 'profile-editor': profileEditor, mode, 'camera-setup': cameraSetup, calibrate,
  vs, opponent,                                                     // VS card ('opponent' = original id)
  pause, 'tracking-lost': trackingLost,
  result, decision: alias(result, 'decision'), 'versus-result': alias(result, 'versus-result'), // decision reveal / winner card
  results, skill,                                                   // results card ('skill' = original id)
  'training-select': trainingSelect, 'training-result': trainingResult,
  records, settings, help,
});
export const SCREEN_IDS = Object.freeze(Object.keys(SCREENS));
/** Alternative ids → the screen they show. */
export const SCREEN_ALIASES = Object.freeze({ opponent: 'vs', skill: 'results', decision: 'result', 'versus-result': 'result' });

const SETTINGS_EVENT = Ev.SETTINGS_CHANGED || 'settings:changed';
/** D14 small-screen gate: shown over the menus below this width, or in portrait narrower than this aspect. */
const GATE = Object.freeze({ minWidth: 700, minPortraitAspect: 3 / 4, storageKey: 'gloveup.smallScreenOk' });
const FOCUSABLE = '[data-cursor]:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="slider"][tabindex]';
const TEXT_INPUT = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'file'].includes(el.type)));

export class UI {
  /**
   * @param {Object} o
   * @param {HTMLElement} [o.root]       container for menus + HUD (default #ui)
   * @param {any} [o.bus]                EventBus
   * @param {any} [o.storage]            core/storage.js Storage
   * @param {any} [o.input]              InputHub (latestFrame, calibrate, status, …) — optional
   * @param {any} [o.audio]              AudioEngine — optional
   * @param {Record<string, any>} [o.modules]  optional explicit modules: {boxerModel, preview, roster, progression, medals, camera}
   * @param {HTMLVideoElement} [o.video] camera video for previews (default input.video or #cam)
   */
  constructor({ root, bus, storage, input, audio, modules, video } = {}) {
    this.root = root || document.getElementById('ui') || document.body;
    this.bus = bus || null;
    this.storage = storage || null;
    this.input = input || null;
    this.audio = audio || null;
    this.video = video || null;
    provideDeps(modules || {});
    preloadDeps().then(() => {
      const bm = peekDep('boxerModel');
      if (bm && typeof bm.BoxerModel === 'function') portraits.setBoxerModel(bm.BoxerModel, { headWorldPosition: bm.headWorldPosition });
    });

    this._settings = this._readSettings();
    /** @type {any[]} stack of mounted screen entries (last = on top) */
    this._stack = [];
    this._leaving = new Set();
    this._lastExternal = -1e9;
    this._lastTick = performance.now();
    this._audioUnlocked = false;
    this._disposed = false;

    // ── DOM layers ──
    this.el = h('div', { class: 'gu-ui' });
    this.hudLayer = h('div', { class: 'gu-layer gu-layer--hud' });
    this.screenLayer = h('div', { class: 'gu-layer gu-layer--screens' });
    this.toastLayer = h('div', { class: 'gu-toasts', 'aria-live': 'polite' });
    this.loadingEl = h('div', { class: 'gu-loading', hidden: true }, h('div', { class: 'gu-loading__card' }, h('span', { class: 'gu-spinner', 'aria-hidden': 'true' }), h('span', { class: 'gu-loading__text' })));
    // D13: browsers start sound only after a real click or key press: until then a badge says how
    this.soundEl = h('div', { class: 'gu-soundoff', role: 'status', hidden: true },
      h('span', { class: 'gu-soundoff__icon', 'aria-hidden': 'true' }, icon('sound')),
      h('span', { class: 'gu-soundoff__text', text: 'Sound is off — click or press any key to turn it on' }));
    // D14: phones / narrow windows get a card instead of a squeezed desktop layout ("Continue anyway" carries on)
    this.gateBtn = button({ label: 'Continue anyway', icon: 'next', kind: 'secondary', size: 'lg', onClick: () => this._dismissGate() });
    this.gateTitle = h('h1', { class: 'gu-gate__title' });
    this.gateText = h('p', { class: 'gu-gate__text' });
    this.gateEl = h('div', { class: 'gu-gate', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Screen too small', hidden: true },
      h('div', { class: 'gu-gate__card' },
        h('div', { class: 'gu-gate__icon', 'aria-hidden': 'true' }, icon('camera')),
        this.gateTitle, this.gateText, this.gateBtn));
    this._gateOpen = false;
    this._gateDismissed = false;
    try { this._gateDismissed = sessionStorage.getItem(GATE.storageKey) === '1'; } catch { /* storage blocked */ }
    this._gateWaiters = [];
    this.el.append(this.hudLayer, this.screenLayer, this.toastLayer, this.loadingEl, this.soundEl, this.gateEl);
    this.root.appendChild(this.el);

    this.hud = new Hud({ root: this.hudLayer, bus: this.bus, input: this.input, ui: this, video: this.video, deps: { peek: peekDep } });
    this.applySettings(this._settings, { silent: true });

    // ── listeners ──
    this._onKeyDown = (e) => this._keydown(e);
    this._onKeyUp = (e) => {
      if ((e.key === ' ' || e.code === 'Space') && this._top() && e.target?.closest?.('.gu-btn')) e.preventDefault();
    };
    this._onClick = (e) => {
      const t = e.target instanceof Element ? e.target.closest('[data-cursor]') : null;
      if (!t || !this.el.contains(t)) return;
      e.preventDefault();
      this._activate(t, e.detail === 0 ? 'keyboard' : 'pointer');
    };
    this._onPointer = () => this._unlockAudio();
    this._onResize = () => this._checkGate();
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    this.el.addEventListener('click', this._onClick);
    window.addEventListener('pointerdown', this._onPointer, true);
    window.addEventListener('resize', this._onResize);
    this._offSettings = this.bus?.on?.(SETTINGS_EVENT, (p) => { if (p?.settings && p.source !== 'ui') this.applySettings(p.settings, { silent: true }); }) || null;

    // Self-driving fallback loop: if the app does not call update() every frame, the UI ticks itself.
    this._raf = 0;
    const loop = (t) => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(loop);
      if (t - this._lastExternal > 200) this._tick(t, null);
    };
    this._raf = requestAnimationFrame(loop);
    this._checkGate();
  }

  // ───────────────────────────── public API ─────────────────────────────

  /**
   * Show a screen. Resolves with the screen's result (each screen documents its actions).
   * @param {string} id      one of SCREEN_IDS
   * @param {object} [params]
   * @returns {Promise<{action:string, [k:string]:any}>}
   */
  show(id, params = {}) {
    const def = SCREENS[id];
    if (!def) {
      console.error(`[ui] unknown screen "${id}"`);
      return Promise.resolve({ action: 'error', error: `unknown screen ${id}` });
    }
    this._clearStack('superseded');
    return new Promise((resolve) => {
      const entry = this._mount(def, params, resolve, null);
      this._stack.push(entry);
      this._enter(entry);
      if ((def.layer || 'menu') === 'menu') {
        if (this.hud.visible) this.hud.hide();
        this.hud.clearOutro?.(); // the outro's win banner / Replay tag never sit over a menu
      }
      this.bus?.emit?.(Ev.APP_SCREEN, { screen: id });
    });
  }

  /** Hide every screen (e.g. to start a match). Pending show() promises resolve {action:'superseded'}. */
  hide() {
    const had = this._stack.length > 0;
    this._clearStack('superseded');
    this.loading(null);
    if (had) this.bus?.emit?.(Ev.APP_SCREEN, { screen: null });
  }

  /** The screen on top: {id, params, done} or null. */
  get current() {
    const e = this._top();
    return e ? { id: e.def.id, params: e.params, done: e.completed } : null;
  }

  /** True while any screen is displayed. */
  get isOpen() { return this._stack.length > 0; }

  /** True while a full menu screen (not a pause/tracking overlay) is displayed. */
  get menuOpen() {
    const top = this._top();
    return !!top && (top.def.layer || 'menu') === 'menu';
  }

  /** D14: the small-screen card is covering the menus (phone, narrow window, tall portrait). */
  get gateOpen() { return !!this._gateOpen; }

  /** Resolves once the small-screen card is not (or no longer) shown — for boot steps that should wait. */
  whenGateClear() {
    this._checkGate();
    return this._gateOpen ? new Promise((resolve) => this._gateWaiters.push(resolve)) : Promise.resolve();
  }

  /**
   * Programmatic navigation (forward InputEvents here: 'confirm' | 'back' | 'pause' | directions).
   * @param {'up'|'down'|'left'|'right'|'confirm'|'back'|'pause'} action
   */
  nav(action) {
    const top = this._top();
    if (action === 'pause') {
      if (top && top.def.id === 'pause') this.back();
      else this.bus?.emit?.(Ev.UI_NAV, { action: 'pause' });
      return;
    }
    if (!top) return;
    if (action === 'back') return this.back();
    if (action === 'confirm') {
      const el = this._focused() || this._initialFocus(top);
      if (el?.matches?.('[data-cursor]')) this._activate(el, 'keyboard');
      else el?.focus?.({ preventScroll: true });
      this.bus?.emit?.(Ev.UI_NAV, { action });
      return;
    }
    this._move(action);
  }

  /** Esc / Backspace / back gesture on the top screen. */
  back() {
    const top = this._top();
    if (!top || top.completed) return;
    if (top.def.noBack && !top.inst.back) return;
    if (performance.now() < top.armedAt) return;
    this.bus?.emit?.(Ev.UI_NAV, { action: 'back' });
    let handled = false;
    if (top.inst.back) {
      try { handled = !!top.inst.back(); } catch (e) { console.error('[ui] back handler failed', e); }
    }
    if (handled || top.def.noBack) return;
    if (performance.now() - (this._lastActivationAt || 0) > 80) this._sfx('ui-back'); // a Back button already played it
    this._done(top, { action: 'back' });
  }

  /**
   * Per-frame update from the app loop (screen updates and animations).
   * @param {number} dt      seconds
   * @param {number} now     ms (performance.now domain)
   * @param {{controls?: any[]}} [opts]
   *        controls: per-player ControlState for the screens
   */
  update(dt, now = performance.now(), opts = null) {
    this._lastExternal = performance.now();
    this._tick(now, opts, dt);
  }

  /** Small notification at the bottom of the screen. */
  toast(text, { kind = 'info', ms = UI_TUNING.toastMs } = {}) {
    if (!text) return;
    const el = h('div', { class: `gu-toast gu-toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
    this.toastLayer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
      el.classList.remove('is-in');
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 400);
    }, ms);
    while (this.toastLayer.children.length > 3) this.toastLayer.firstElementChild.remove();
  }

  /** Busy overlay ("Starting camera…"); null hides it. */
  loading(text) {
    if (!text) { this.loadingEl.hidden = true; return; }
    this.loadingEl.querySelector('.gu-loading__text').textContent = text;
    this.loadingEl.hidden = false;
  }

  /** Current settings (copy). */
  get settings() { return { ...this._settings, volumes: { ...(this._settings.volumes || {}) } }; }

  /**
   * Apply settings to UI-side features (reduced motion, PiP, volumes) and optionally announce them.
   * @param {object} s
   * @param {{silent?:boolean, changed?:string[]}} [opts] silent → don't emit SETTINGS_CHANGED
   */
  applySettings(s, { silent = false, changed = [] } = {}) {
    if (!s) return;
    this._settings = { ...this._settings, ...s, volumes: { ...(this._settings.volumes || {}), ...(s.volumes || {}) } };
    const reduced = !!this._settings.reducedMotion;
    this.el.classList.toggle('gu-reduced-motion', reduced);
    this.hud.setPip(this._settings.showSkeleton !== false);
    this.hud.setPipLarge(this._settings.pipLarge === true);
    this.hud.setMirror(this._settings.mirror !== false);
    this.hud.setReducedMotion(reduced);
    try { if (this._settings.volumes) this.audio?.setVolume?.(this._settings.volumes); } catch (e) { console.warn('[ui] setVolume failed', e); }
    if (!silent) this.bus?.emit?.(SETTINGS_EVENT, { settings: this.settings, changed, source: 'ui' });
  }

  /** Camera video element for previews. */
  getVideo() {
    return this.video || this.input?.video || document.getElementById('cam') || null;
  }

  /** Latest PoseFrame from the input hub (or null). */
  latestFrame() {
    try { return this.input?.latestFrame?.() ?? null; } catch { return null; }
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._clearStack('superseded');
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('pointerdown', this._onPointer, true);
    window.removeEventListener('resize', this._onResize);
    this.el.removeEventListener('click', this._onClick);
    this._offSettings?.();
    this.hud.dispose();
    this.el.remove();
  }

  // ───────────────────────────── screen lifecycle ─────────────────────────────

  _readSettings() {
    try {
      const s = this.storage?.settings?.();
      if (s) return s;
    } catch { /* fall through */ }
    return { reducedMotion: false, showSkeleton: true, pipLarge: false, mirror: true, volumes: { master: 0.8, sfx: 0.9, music: 0.6, voice: 0.9 } };
  }

  _top() { return this._stack[this._stack.length - 1] || null; }

  _mount(def, params, resolve, parent) {
    const entry = {
      def, params: params || {}, resolve, parent, inst: null, el: null, completed: false, result: undefined,
      armedAt: performance.now() + (def.armDelayMs ?? UI_TUNING.armDelayMs),
    };
    const ctx = this._ctx(entry);
    let inst;
    try {
      inst = def.create(ctx, entry.params) || {};
    } catch (e) {
      console.error(`[ui] screen "${def.id}" failed to build`, e);
      inst = { el: h('div', { class: 'gu-panel gu-error' }, h('h2', { text: 'Something went wrong' }), h('p', { text: String(e?.message || e) })) };
    }
    entry.inst = inst;
    const layer = def.layer || 'menu';
    entry.el = h('section', {
      class: ['gu-screen', `gu-screen--${def.id}`, `gu-screen--${layer}`, 'is-entering'],
      role: layer === 'overlay' ? 'alertdialog' : 'region',
      'aria-label': def.title || def.id,
      'aria-modal': layer === 'overlay' ? 'true' : undefined,
    }, inst.el);
    return entry;
  }

  _enter(entry) {
    this.screenLayer.appendChild(entry.el);
    // two frames so the entering styles apply before the transition starts; the screen may be replaced
    // within those frames (_leave nulls entry.el), so hold on to the element itself (FLOWS-10)
    const el = entry.el;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
    el.classList.add('is-active');
    this._focusInitial(entry);
  }

  _leave(entry) {
    if (!entry.el) return;
    try { entry.inst.destroy?.(); } catch (e) { console.error('[ui] destroy failed', e); }
    const el = entry.el;
    entry.el = null;
    el.classList.remove('is-active');
    el.classList.add('is-leaving');
    el.setAttribute('inert', '');
    const ms = this._settings.reducedMotion ? 0 : UI_TUNING.transitionMs;
    this._leaving.add(el);
    setTimeout(() => { el.remove(); this._leaving.delete(el); portraits.sweep(); }, ms);
  }

  _clearStack(action) {
    const old = this._stack.splice(0);
    for (const e of old.reverse()) {
      if (!e.completed) {
        e.completed = true;
        try { e.resolve({ action }); } catch { /* ignore */ }
      }
      this._leave(e);
    }
  }

  _ctx(entry) {
    const ui = this;
    return {
      ui,
      get bus() { return ui.bus; },
      get storage() { return ui.storage; },
      get input() { return ui.input; },
      get audio() { return ui.audio; },
      done: (r) => ui._done(entry, r),
      sub: (id, params) => ui._sub(entry, id, params),
      toast: (t, o) => ui.toast(t, o),
      sfx: (n) => ui._sfx(n),
      portrait: (a, o) => portraits.element(a, o),
      settings: () => ui.settings,
      deps: { peek: peekDep, load: loadDep },
      arm: (ms) => { entry.armedAt = performance.now() + ms; },
      refocus: () => ui._focusInitial(entry),
      get entry() { return entry; },
    };
  }

  /** Resolve a screen. Top-level: stays visible (inert) until the next show/hide. Sub: closes and returns to its parent. */
  _done(entry, r) {
    if (entry.completed) return;
    const result = r && typeof r === 'object' ? r : { action: String(r ?? 'done') };
    entry.completed = true;
    entry.result = result;
    if (entry.parent) {
      const i = this._stack.indexOf(entry);
      if (i >= 0) this._stack.splice(i, 1);
      this._leave(entry);
      const parent = entry.parent;
      if (parent.el) {
        parent.el.classList.remove('is-covered');
        parent.el.removeAttribute('inert');
        try { parent.inst.refresh?.(result); } catch (e) { console.error('[ui] refresh failed', e); }
        parent.armedAt = performance.now() + UI_TUNING.armDelayMs;
        this._focusInitial(parent, entry.returnFocusId);
        this.bus?.emit?.(Ev.APP_SCREEN, { screen: parent.def.id });
      }
      entry.resolve(result);
      return;
    }
    entry.el?.classList.add('is-done');
    entry.el?.setAttribute('inert', '');
    entry.resolve(result);
  }

  _sub(parent, id, params) {
    const def = SCREENS[id];
    if (!def) return Promise.resolve({ action: 'error' });
    return new Promise((resolve) => {
      const child = this._mount(def, params, resolve, parent);
      child.returnFocusId = document.activeElement?.dataset?.cursor || null;
      if (parent.el) {
        parent.el.classList.add('is-covered');
        parent.el.setAttribute('inert', '');
      }
      this._stack.push(child);
      this._enter(child);
      this.bus?.emit?.(Ev.APP_SCREEN, { screen: id });
    });
  }

  // ───────────────────────────── focus + keyboard ─────────────────────────────

  _focusables(entry = this._top()) {
    if (!entry?.el) return [];
    return [...entry.el.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null && !el.closest('[inert]') && !el.closest('[hidden]'));
  }

  _focused() {
    const a = document.activeElement;
    const top = this._top();
    return a && top?.el?.contains(a) ? a : null;
  }

  _initialFocus(entry) {
    let el = null;
    try { el = entry.inst.focus?.() || null; } catch { el = null; }
    if (!el || el.disabled) el = entry.el?.querySelector('[data-autofocus]:not([disabled])') || null;
    if (!el) el = this._focusables(entry)[0] || null;
    return el;
  }

  _focusInitial(entry, preferId) {
    const go = () => {
      if (entry !== this._top() || !entry.el) return;
      let el = preferId ? entry.el.querySelector(`[data-cursor="${CSS.escape(preferId)}"]`) : null;
      if (!el || el.disabled) el = this._initialFocus(entry);
      el?.focus?.({ preventScroll: true });
    };
    requestAnimationFrame(go);
  }

  _keydown(e) {
    if (this._gateOpen && !e.defaultPrevented) {
      // the small-screen card is up: only its "Continue anyway" button takes keys
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      this._unlockAudio();
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (!e.repeat) this._activate(this.gateBtn, 'keyboard');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.gateBtn.focus({ preventScroll: true });
      } else if (e.key === 'Escape' || e.key === 'Backspace' || e.key.startsWith('Arrow') || e.code === 'KeyP') {
        e.preventDefault();
      }
      return;
    }
    const top = this._top();
    if (!top || top.completed || e.defaultPrevented) {
      if (!top && (e.code === 'KeyP') && !TEXT_INPUT(e.target)) this.bus?.emit?.(Ev.UI_NAV, { action: 'pause' });
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    this._unlockAudio();
    const target = e.target;
    const inText = TEXT_INPUT(target);
    const key = e.key;
    const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (dirs[key]) {
      const dir = dirs[key];
      if (inText && (dir === 'left' || dir === 'right')) return; // caret movement
      e.preventDefault();
      const f = this._focused();
      if (f && typeof f.__guArrows === 'function' && f.__guArrows(dir)) return;
      this._move(dir);
      return;
    }
    if (key === 'Tab') {
      const list = this._focusables(top);
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(this._focused());
      const n = list.length;
      const next = list[((i < 0 ? (e.shiftKey ? 0 : -1) : i) + (e.shiftKey ? -1 : 1) + n) % n];
      next.focus({ preventScroll: true });
      this._sfx('ui-move');
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (e.repeat && !inText) { e.preventDefault(); return; } // holding Enter must not machine-gun buttons
      if (inText) {
        if (key === 'Enter') { e.preventDefault(); this._move('down') || this._move('right'); }
        return;
      }
      e.preventDefault();
      const f = this._focused() || this._initialFocus(top);
      if (!f) return;
      if (f.matches('[data-cursor]')) this._activate(f, 'keyboard');
      else f.focus({ preventScroll: true });
      this.bus?.emit?.(Ev.UI_NAV, { action: 'confirm' });
      return;
    }
    if (key === 'Escape' || key === 'Backspace') {
      if (inText) {
        if (key === 'Escape') { e.preventDefault(); target.blur(); this._focusInitial(top); }
        return;
      }
      e.preventDefault();
      this.back();
      return;
    }
    if (e.code === 'KeyP' && !inText) {
      if (top.def.id === 'pause') { e.preventDefault(); this.back(); }
    }
  }

  /** Move focus spatially; returns true if it moved. */
  _move(dir) {
    const list = this._focusables();
    if (!list.length) return false;
    const cur = this._focused();
    const i = list.indexOf(cur);
    if (i < 0) {
      list[0].focus({ preventScroll: true });
      this.bus?.emit?.(Ev.UI_NAV, { action: dir });
      return true;
    }
    const rects = list.map((el) => el.getBoundingClientRect());
    const j = pickNeighbor(rects, i, dir);
    this.bus?.emit?.(Ev.UI_NAV, { action: dir });
    if (j < 0) return false;
    list[j].focus({ preventScroll: true });
    list[j].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this._sfx('ui-move');
    return true;
  }

  // ───────────────────────────── activation ─────────────────────────────

  _entryFor(el) {
    for (let i = this._stack.length - 1; i >= 0; i--) if (this._stack[i].el?.contains(el)) return this._stack[i];
    return null;
  }

  /**
   * Run a button's action (mouse / touch: source 'pointer'; keyboard: 'keyboard').
   * @returns {boolean} whether it ran
   */
  _activate(el, source) {
    this._unlockAudio();
    if (this.gateEl.contains(el)) {
      if (el.disabled) return false;
      this._sfx('ui-confirm');
      this.bus?.emit?.(Ev.UI_CLICK, { id: el.dataset.cursor || null, screen: 'small-screen', source });
      try { el.__guAction?.(el, source); } catch (e) { console.error('[ui] action failed', e); }
      return true;
    }
    const entry = this._entryFor(el);
    if (!entry || entry !== this._top() || entry.completed) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      this._sfx('ui-deny');
      return false;
    }
    if (performance.now() < entry.armedAt) return false;
    el.classList.remove('is-pressed');
    void el.offsetWidth;
    el.classList.add('is-pressed');
    setTimeout(() => el.classList.remove('is-pressed'), 180);
    this._sfx(el.dataset.sfx || 'ui-confirm');
    this._lastActivationAt = performance.now();
    this.bus?.emit?.(Ev.UI_CLICK, { id: el.dataset.cursor || el.id || null, screen: entry.def.id, source });
    el.focus?.({ preventScroll: true });
    try {
      el.__guAction?.(el, source);
    } catch (e) {
      console.error('[ui] action failed', e);
      this.toast('That didn’t work — please try again.', { kind: 'error' });
    }
    return true;
  }

  _sfx(name) {
    try { this.audio?.playSfx?.(name); } catch { /* audio is optional */ }
  }

  /** Real input (key, click, tap) only. Latches once the engine no longer waits for a gesture. */
  _unlockAudio() {
    if (this._audioUnlocked) return;
    const a = this.audio;
    try { a?.unlock?.(); } catch { /* optional */ }
    if (!a || a.needsGesture !== true) this._audioUnlocked = true;
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  _tick(now, opts, dtIn) {
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 0.1) : clamp((now - this._lastTick) / 1000, 0, 0.1);
    this._lastTick = now;
    this._checkGate();
    // D13: the badge stays up until the audio engine runs (a click or a key press anywhere starts it)
    const soundOff = this.audio?.needsGesture === true;
    if (soundOff !== !this.soundEl.hidden) this.soundEl.hidden = !soundOff;
    const top = this._top();
    if (top && !top.completed) {
      try { top.inst.update?.(dt, now, opts || {}); } catch (e) { console.error(`[ui] ${top.def.id}.update failed`, e); top.inst.update = null; }
    }
    if (top && !top.completed) {
      // live portraits (editor) etc.
      for (const c of top.el?.querySelectorAll?.('canvas.gu-portrait--live') || []) c.tick?.();
    }
  }

  // ───────────────────────────── D14 small-screen gate ─────────────────────────────

  /** Phone, narrow window or tall portrait: cover the menus with a card (never over a running activity). */
  _checkGate() {
    const w = window.innerWidth || 0, hgt = window.innerHeight || 0;
    const small = w > 0 && hgt > 0 && (w < GATE.minWidth || (hgt > w && w / hgt < GATE.minPortraitAspect));
    const top = this._top();
    // menus only: never over a bout or a drill (HUD up, no screen) nor their pause / tracking-lost overlays
    const open = small && !this._gateDismissed && (top ? (top.def.layer || 'menu') === 'menu' : !this.hud?.visible);
    if (open) {
      const portrait = hgt > w;
      const title = portrait ? 'Turn your screen sideways' : 'Make the window bigger';
      if (this.gateTitle.textContent !== title) {
        this.gateTitle.textContent = title;
        this.gateText.textContent = portrait
          ? 'Glove Up is built for a wide screen — a computer or TV with a webcam, 1–2 m away. Sideways it fits much better.'
          : 'Glove Up is built for a wide screen — a computer or TV with a webcam, 1–2 m away. This window is too narrow for the ring and the menus.';
      }
    }
    if (open === this._gateOpen) return;
    this._gateOpen = open;
    this.gateEl.hidden = !open;
    this.screenLayer.toggleAttribute('inert', open);
    if (open) requestAnimationFrame(() => { if (this._gateOpen) this.gateBtn.focus({ preventScroll: true }); });
    else {
      const t = this._top();
      if (t) this._focusInitial(t);
      for (const r of this._gateWaiters.splice(0)) { try { r(); } catch { /* ignore */ } }
    }
  }

  _dismissGate() {
    this._gateDismissed = true;
    try { sessionStorage.setItem(GATE.storageKey, '1'); } catch { /* storage blocked */ }
    this._checkGate();
  }
}
