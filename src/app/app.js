// The Glove Up application: boots every module, runs the game loop and walks the player through
// every flow — title, boxers, main menu, single player, versus, training, records, settings,
// help — plus pause, tracking loss and saving.
//
// Shape: menus are awaited screens (ui.show() resolves with the player's choice), so each flow is
// a plain async function. Gameplay is a "session" (app/session.js) the loop advances every frame;
// play(session) resolves when the bout/drill has a result (or the player quits). Pausing is an
// overlay flow that freezes the session and resumes, restarts or quits it.
//
// Single player follows the reference's loop (research/mechanics.md §1.1, §1.2, §7): ~0.5 s of
// black → VS card (progression.nextBout + describeBout) → the bout (a new boxer's first bout opens
// with the six-card tutorial, app/tutorial.js) → the result locks and is saved at once → the bout
// outro (renderer.playOutro: replay, win banner, winner pose; skippable) → the decision reveal
// (decisions / draws only) → the results card (rating graph, change, PRO and glove-unlock moments)
// → "Play again" goes straight to the next VS card (the next opponent or a rematch), "Quit" → menu.
// Versus: the outro, then a winner card — no rating.
//
// Spec coverage here:
//   SET01 profiles (local / guest / portable) → the selected avatar is the player's boxer
//   SET03 InputHub players + per-player profiles (SET02, the stance choice, was removed on 2026-11-10 at the user's
//         request: every boxer is orthodox; players may still stand either way — punches are read per hand)
//   ERR01 camera setup gate (every required player visible before an activity starts)
//   ERR02 tracking lost during an activity → "Please keep your hands visible" in the HUD, then pause + "who must come back"
//         screen; it carries on by itself 0.5 s after the player is back with both hands in view (or on Resume)
//         (the camera itself stopping shows there too, with "Try again": input.start() keeps the bout)
//   FLOWS-09 a lost WebGL context (blank arena) pauses the activity; the player resumes once it is back
//   ERR04 saves that fail are reported; the activity result still counts
//   SES01/SES02 pause → Continue (same state) / Start over (fresh state) / Quit (nothing saved)
//   PRG01 next opponent (progression.nextBout, §7.5); PRG02 rating after single-player bouts only (A11)
//   MAT04 one locked result per bout, saved exactly once (also guarded here by result id)
//   TRN01/TRN02 training turns, results, medals, repeat attempts, comparison
//   SAV01 records saved for local profiles only (storage enforces it)

import { EventBus } from '../core/events.js';
import { Ev, InputMode, ProfileKind, ResultMethod } from '../core/types.js';
import { Storage, DEFAULT_SETTINGS } from '../core/storage.js';
import { AudioEngine } from '../audio/audio.js';
import { GameRenderer } from '../render/renderer.js';
import { UI } from '../ui/ui.js';
import { InputHub } from '../input/input-hub.js';
import { Recorder } from '../input/recorder.js';
import { nextBout, describeBout, applyBout, resultsSummary, needsTutorial } from '../game/progression.js';
import { opponentById } from '../game/roster.js';
import * as boxerModelModule from '../render/boxer-model.js';
import * as previewModule from '../input/preview.js';
import * as rosterModule from '../game/roster.js';
import * as progressionModule from '../game/progression.js';
import * as medalsModule from '../training/medals.js';
import * as cameraModule from '../input/camera.js';
import * as keyboardModule from '../input/keyboard.js';
import { MatchSession, TrainingRun } from './session.js';
import { PoseFeeder } from './pose-feeder.js';
import { Splash } from './splash.js';
import { DebugOverlay } from './debug-overlay.js';
import { parseParams } from './params.js';

export { parseParams };

/** App-level tunables (ms unless noted). */
export const APP_TUNING = Object.freeze({
  /** Longest frame step fed to the game (s): a hitch never makes the fight jump. */
  maxFrameDt: 0.1,
  /** ERR02: once the hub reports a player as lost (already debounced by HUB_TUNING.lostMs),
   *  pause after this much more — covers players who were never found when the activity began. */
  trackingGraceMs: 250,
  /** Pause InputEvents (keys / hands-above-head) older than the pause screen or the last resume
   *  are leftovers of the same press and are ignored. */
  pauseEventSlackMs: 60,
  /** Ignore a new pause request this soon after resuming (a held key or held hands). */
  resumeGuardMs: 350,
  /** The HUD's "Please keep your hands visible" for a pose missing altogether shows after this (one dropped frame
   *  is no reason to warn); a lost hand comes already debounced by the recognizer (ControlState.tracked). */
  handsWarnPoseMs: 200,
  /** Black before every VS card (research/mechanics.md §1.2: about 0.5 s; ?fast=1 too). */
  blackoutMs: 500,
  blackoutFastMs: 500,
  /** The black curtain fades off the VS card this fast. */
  curtainFadeMs: 180,
  /** Keyboard input's "latency" for latency-fair defence (key → ControlState crossing the dodge line,
   *  input/keyboard.js leanInTauMs); camera play uses the measured value (calibration.latencyMs). */
  keyboardLatencyMs: 40,
});

class Superseded extends Error {
  constructor() { super('superseded'); this.name = 'Superseded'; }
}

const nowMs = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRAINING_TARGETS = new Set(['bag', 'dodge', 'mitts']);
const isDecision = (r) => !!r && (r.method === ResultMethod.DECISION || r.method === ResultMethod.DRAW);

export class App {
  /**
   * @param {{params?: ReturnType<typeof parseParams>, canvas?: HTMLCanvasElement, uiRoot?: HTMLElement, video?: HTMLVideoElement}} [o]
   */
  constructor({ params = parseParams(location.search), canvas, uiRoot, video } = {}) {
    this.params = params;
    this.canvas = canvas || document.getElementById('scene');
    this.uiRoot = uiRoot || document.getElementById('ui');
    this.video = video || document.getElementById('cam');
    this.flow = 'boot';
    this.profile = null;
    this.session = null;        // running (or just finished, as a backdrop) MatchSession / TrainingRun
    this._play = null;          // {resolve, reject} of the activity being played
    this._token = 0;            // bumped when flows are aborted (skipTo)
    this._jump = null;
    this._pausing = false;
    this._pauseReason = null;
    this._pauseShownAt = -Infinity;
    this._resumedAt = -Infinity;
    this._lostSince = [null, null];
    this._noPoseSince = [null, null]; // the HUD hands warning: when each player's pose went missing
    this._calibSkipped = new Set();
    this._saved = new Map();    // `${profileId}|${resultId}` → SaveResult (never apply a result twice)
    this._saveLog = [];
    this._waits = new Set();    // pending awaits (outro, black) that skipTo must unwind
    this._guestTutorialSeen = false; // guests get the first-bout tutorial once per session
    this._curtain = null;
    this._last = null;
    this._lastPrewarm = null;   // renderer.prewarm's last report {programs, ms, skipped?} (PERF-04)
    this._errors = new Set();
    this.synthetic = params.input === 'synthetic';
  }

  // ───────────────────────────── boot ─────────────────────────────

  /** Create every module, wire the bus, start input and the loop, then run the flows. */
  async boot() {
    const P = this.params;
    this.splash = new Splash(); // the loading screen fades once the first frames are drawn (src/app/splash.js)
    this.bus = new EventBus();
    this.storage = new Storage();
    this.settings = this.storage.settings();
    const s = this.settings;

    this.audio = new AudioEngine({ bus: this.bus, volumes: s.volumes });
    this.renderer = new GameRenderer({ canvas: this.canvas, bus: this.bus, quality: P.quality, reducedMotion: !!s.reducedMotion, fast: !!P.fast });
    this.renderer.setFast?.(!!P.fast); // ?fast=1: the bout outro takes ≤ 1.5 s

    let mode = InputMode.CAMERA;
    if (P.input === 'keyboard') mode = InputMode.KEYBOARD;
    else if (P.input === 'replay') mode = InputMode.REPLAY;
    else if (!P.input && s.inputMode === 'keyboard') mode = InputMode.KEYBOARD;
    this.input = new InputHub({
      bus: this.bus, mode, players: 1, video: this.video,
      model: s.model, deviceId: s.cameraDeviceId || undefined, keyboardAssist: !!s.keyboardAssist,
      gestureTuning: { sensitivity: Number.isFinite(s.sensitivity) ? s.sensitivity : DEFAULT_SETTINGS.sensitivity },
      videoSource: P.video || null,
      // PERF-01: pose detection in a background worker by default; ?detector=main forces the main thread
      detector: P.detector || undefined,
    });
    this.feeder = new PoseFeeder(this.input);
    this.ui = new UI({
      root: this.uiRoot, bus: this.bus, storage: this.storage, input: this.input, audio: this.audio, video: this.video,
      // hand the UI the modules it would otherwise lazy-load (portraits, previews, ladder, medals)
      modules: {
        boxerModel: boxerModelModule, preview: previewModule, roster: rosterModule, progression: progressionModule,
        medals: medalsModule, camera: cameraModule, keyboard: keyboardModule,
      },
    });
    if (P.debug) this.overlay = new DebugOverlay(document.body);

    this._wire();
    this._exposeDebugHooks();
    // D14 / VISUAL-06: on a phone or a narrow window the small-screen card covers the menus first;
    // the camera (and its permission prompt) starts once the card is gone, not behind it
    if (this.ui.gateOpen && typeof this.ui.whenGateClear === 'function') this.ui.whenGateClear().then(() => this._startInput());
    else this._startInput();
    this._frame = (t) => this.frame(t);
    requestAnimationFrame(this._frame);
    if (P.skip) this._jump = { target: P.skip, opts: {} };
    this.run();
    return this;
  }

  _wire() {
    const bus = this.bus;
    bus.on(Ev.SETTINGS_CHANGED, (p) => {
      if (!p?.settings) return;
      this.settings = p.settings;
      const changed = Array.isArray(p.changed) ? p.changed : [];
      // model / camera / input mode / keyboard assist are applied by the Settings screen itself
      // (ui/screens/settings.js); volumes, PiP, mirror and reduced motion by UI.applySettings and the
      // renderer's own subscription. Sensitivity is ours to apply:
      if (changed.includes('sensitivity') && Number.isFinite(p.settings.sensitivity)) this.input.setSensitivity(p.settings.sensitivity);
      // a real input mode was chosen: injected poses no longer stand in for the camera
      if (changed.includes('inputMode')) { this.synthetic = false; this.feeder.stop(); }
    });
    // P with no screen open (ui/ui.js emits this) → pause the activity.
    bus.on(Ev.UI_NAV, (e) => {
      if (e?.action === 'pause' && !this.ui.isOpen && this._live()) this.requestPause('user');
    });
    // ERR02: tracking lost (the watchdog in frame() also covers players never found).
    bus.on(Ev.INPUT_TRACKING_LOST, (e) => {
      const i = e?.player === 1 ? 1 : 0;
      if (this._live() && this._camera() && i < this.session.humans && this.session.canPause) this.requestPause('tracking', { player: i });
    });
    // Esc (camera mode without keyboard assist has no other pause key besides P); Enter / Esc skip the
    // bout outro; Enter skips the first-bout tutorial. Keys a screen already handled (Enter on the VS
    // card's "Fight!") never reach the bout that screen starts.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.defaultPrevented || this.ui.isOpen) return;
      const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
      if (!enter && e.code !== 'Escape') return;
      const s = this.session;
      if (s?.outroActive) { e.preventDefault(); s.skipOutro(); return; }
      if (!this._live()) return;
      if (enter) {
        if (s.tutorialActive) { e.preventDefault(); s.skipTutorial(); }
        return;
      }
      this.requestPause('user'); // (refused within resumeGuardMs of a resume)
    });
    // tab hidden → pause (the activity must never run unattended)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this._live()) this.requestPause('hidden');
    });
    // FLOWS-04: settings saved in another tab of the game apply here too (storage already adopted them)
    this.storage.subscribe?.(() => this._adoptExternalSettings());
  }

  /**
   * Another tab changed the stored settings: announce the player-side ones (volumes, PiP, mirror,
   * reduced motion, sensitivity) so the UI, audio, renderer and input follow without a reload. The
   * camera, model and controls stay this tab's own (each tab has its own camera).
   */
  _adoptExternalSettings() {
    let next;
    try { next = this.storage.settings(); } catch { return; }
    const prev = this.settings || {};
    const keys = ['volumes', 'showSkeleton', 'mirror', 'reducedMotion', 'sensitivity'];
    const changed = keys.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next?.[k]));
    if (!changed.length) return;
    this.bus.emit(Ev.SETTINGS_CHANGED, { settings: next, changed, source: 'storage' });
  }

  /** Start the input source for the boot mode (the camera opens at boot: the camera check shows the picture at once). */
  _startInput() {
    const hub = this.input;
    if (this.synthetic) return; // frames come from window.__glove.injectPose (PoseFeeder)
    if (hub.mode === InputMode.REPLAY) {
      if (!this.params.rec) { console.warn('[app] ?input=replay needs &rec=<recording url>; using the keyboard instead'); hub.setMode(InputMode.KEYBOARD).then(() => hub.start()); return; }
      Recorder.load(this.params.rec)
        .then((rec) => hub.replay(rec, { loop: true }))
        .catch((e) => { console.error('[app] could not load the pose recording', e); this.ui.toast('Could not load that pose recording.', { kind: 'error' }); });
      return;
    }
    hub.start().then((r) => {
      if (r && r.ok === false && r.code !== 'cancelled') console.warn(`[app] input did not start: ${r.error}`);
    });
  }

  // ───────────────────────────── loop ─────────────────────────────

  frame(t) {
    requestAnimationFrame(this._frame);
    // PERF-06: on a fast display (120 / 144 Hz) the adaptive quality may render every Nth display frame (≈ 60 fps)
    // to give a GPU pose detector its time back
    const div = this._adaptiveQuality()?.frameDivisor || 1;
    if (div > 1 && (this._rafTick = ((this._rafTick || 0) + 1) % div) !== 0) return;
    const now = nowMs();
    const realDt = this._last === null ? 1 / 60 : Math.min(APP_TUNING.maxFrameDt, Math.max(0, (now - this._last) / 1000));
    this._last = now;

    // fake camera (tests / debugging) → real pipeline
    try { this.feeder.tick(now); } catch (e) { this._reportOnce('feeder', e); }

    // input: always polled so every event is consumed exactly once (menus discard punches)
    let res;
    try { res = this.input.update(now); } catch (e) { this._reportOnce('input', e); res = { players: [], status: this.input.status }; }
    // PERF-03 / D9: main-thread pose detection is not render time for the adaptive quality
    try { this.renderer.setExternalFrameCost?.(this.input.lastDetectMs ?? 0); } catch (e) { this._reportOnce('frame-cost', e); }
    // PERF-06: a GPU pose detector that falls behind gets GPU time back from the render (render/adaptive.js); the hub
    // learns whether the render has anything left to give (its auto model waits for that before trading accuracy)
    try {
      const aq = this._adaptiveQuality();
      aq?.setDetectionPressure(this.input.renderPressure ?? null);
      this.input.setRenderState?.(aq ? { atFloor: !aq.enabled || aq.atFloor } : null);
    } catch (e) { this._reportOnce('detection-pressure', e); }
    const players = res.players || [];
    for (const p of players) {
      for (const ev of p?.events || []) {
        if (ev?.type === 'pause') this._onPauseEvent(ev);
        else if (ev?.type === 'confirm' && !this.ui.isOpen && this.session?.outroActive) this.session.skipOutro();
      }
    }

    const s = this.session;
    if (s) {
      if (this._play && !s.paused) {
        // FLOWS-09 / D10: a lost WebGL context blanks the arena — the bout must not run on unseen.
        // The pause overlay is DOM, so it still shows; the player resumes once the picture is back.
        if (this.renderer.contextLost) this.requestPause('graphics');
        else this._watchTracking(now, res.status);
        if (this.session === s && !s.paused) s.update(realDt, now, players);
        // a bout hands over as soon as its result is locked (saved at once; its outro still plays),
        // a drill once its closing beat has played
        if (s.handoff && this._play && this.session === s) {
          const p = this._play;
          this._play = null;
          p.resolve({ result: s.result });
        }
      } else if (!this._play) {
        // the finished bout (KO call, outro, results backdrop) keeps animating; the players' figures
        // still mirror them but nothing they do counts any more (MatchSession drops their events)
        s.update(realDt, now, s.kind === 'match' ? players : []);
      }
    }

    try {
      if (this.session) this.session.render(realDt, this._hudExtras(res));
      else this.renderer.renderMenu(realDt);
    } catch (e) { this._reportOnce('render', e); }

    try { this.ui.update(realDt, now, { controls: players.map((p) => p?.control || null) }); } catch (e) { this._reportOnce('ui', e); }
    // the loading screen goes once something is on screen (the title, or a bout started with ?skip=)
    try { this.splash?.frameDrawn(this.ui.isOpen || !!this.session); } catch (e) { this._reportOnce('splash', e); }

    if (this.overlay) {
      this.overlay.update(now, {
        status: res.status, players, activity: this.session?.debug() || null, timeScale: this.renderer.timeScale,
        screen: this.ui.current?.id || null, flow: this.flow,
      });
    }
  }

  /** PERF-06: the renderer's adaptive quality (render/adaptive.js AdaptiveQuality via GameRenderer.adaptive), if it has one. */
  _adaptiveQuality() {
    const aq = this.renderer && this.renderer.adaptive;
    return aq && typeof aq.setDetectionPressure === 'function' ? aq : null;
  }

  _hudExtras(res) {
    if (!this._camera()) return {};
    const s = this.session;
    const st = res.status || {};
    const now = nowMs();
    // "Please keep your hands visible" while a human player's hands (or whole pose) are lost in a live activity that
    // could pause — the tracking-lost card follows HUB_TUNING.lostMs later if they stay out. Not when the camera itself
    // stopped or froze: the card says that.
    const age = st.frameAgeMs;
    const camOk = st.phase !== 'error' && !(typeof age === 'number' && (!Number.isFinite(age) || age > (this.input.tuning?.staleFrameMs ?? 500)));
    const warn = !!s && this._live() && s.canPause && !this._pausing && camOk;
    const presence = Array.isArray(st.presence) ? st.presence : [];
    const handsWarning = (res.players || []).map((p, i) => {
      if (!warn || i >= (s.humans ?? 1)) { this._noPoseSince[i] = null; return false; }
      if (presence[i] === false) this._noPoseSince[i] = this._noPoseSince[i] ?? now;
      else this._noPoseSince[i] = null;
      return p?.control?.tracked === false || (this._noPoseSince[i] !== null && now - this._noPoseSince[i] >= APP_TUNING.handsWarnPoseMs);
    });
    return {
      tracking: st.tracking || [],
      confidence: (res.players || []).map((p) => p?.control?.confidence ?? 0),
      handsWarning,
    };
  }

  /** A session is being played (not paused, not finished). */
  _live() { return !!(this.session && this._play && !this.session.paused); }
  /** Camera-like input (webcam, clip, replay or injected poses): tracking matters. */
  _camera() { return this.input.mode !== InputMode.KEYBOARD; }

  /** ERR02: a required player is not tracked → pause with the tracking-lost screen. */
  _watchTracking(now, status) {
    const s = this.session;
    if (!this._camera() || !s.canPause || this._pausing) { this._lostSince = [null, null]; return; }
    const tracking = status?.tracking || [];
    for (let i = 0; i < s.humans; i++) {
      if (tracking[i]) { this._lostSince[i] = null; continue; }
      if (this._lostSince[i] === null) this._lostSince[i] = now;
      if (now - this._lostSince[i] >= APP_TUNING.trackingGraceMs) {
        this._lostSince = [null, null];
        this.requestPause('tracking', { player: i });
        return;
      }
    }
  }

  /** 'pause' InputEvent (keyboard Esc/P or both hands above the head for 1.2 s). */
  _onPauseEvent(ev) {
    const t = Number.isFinite(ev.t) ? ev.t : nowMs();
    const top = this.ui.current;
    if (top && top.id === 'pause' && !top.done) {
      // hands up again on the pause screen = Continue (keys were already handled by the UI)
      if (t >= this._pauseShownAt + APP_TUNING.pauseEventSlackMs) this.ui.nav('pause');
      return;
    }
    // hands up during the bout outro: skip to the end of it
    if (!this.ui.isOpen && this.session?.outroActive) { this.session.skipOutro(); return; }
    if (!this.ui.isOpen && this._live() && t >= this._resumedAt + APP_TUNING.pauseEventSlackMs) this.requestPause('user');
  }

  // ───────────────────────────── pause / resume (SES01, SES02, ERR02) ─────────────────────────────

  /**
   * Freeze the running activity and show the pause menu (or the tracking-lost screen).
   * 'tracking' (ERR02) and 'graphics' (the WebGL context was lost, FLOWS-09) are never refused by
   * the resume guard: the game itself, not a held key, asks for them.
   * @param {'user'|'hidden'|'tracking'|'graphics'} reason
   * @param {{player?:0|1}} [o]
   */
  async requestPause(reason, { player = 0 } = {}) {
    const s = this.session;
    if (!s || !this._play || s.paused || this._pausing || !s.canPause) return false;
    if (reason !== 'tracking' && reason !== 'graphics' && nowMs() - this._resumedAt < APP_TUNING.resumeGuardMs) return false;
    this._pausing = true;
    this._pauseReason = reason;
    const token = this._token;
    s.pause();
    this.bus.emit(Ev.APP_PAUSE, { reason });
    this._pauseShownAt = nowMs();
    const kind = s.kind === 'training' ? 'training' : 'match';
    const graphicsLost = () => !!this.renderer?.contextLost;
    let r;
    try {
      for (;;) {
        r = reason === 'tracking'
          // VISUAL-14 (c): the screen says "The drill is paused." in training
          ? await this.ui.show('tracking-lost', { player, name: s.nameOf(player), players: s.humans, kind })
          // RV-FLOWS-04: the card says why when the picture dropped out, and offers Continue only once it is back
          : await this.ui.show('pause', { kind, canRestart: true, canSkipTutorial: !!s.tutorialActive, reason, graphicsLost });
        // D10: never resume onto a blank arena. A resume while the WebGL context is still lost would only pause
        // again a frame later, so the bout stays paused and the pause card comes back saying why. "Skip tutorial"
        // then ends the tutorial at once, but the bout still waits for the picture (RV-FLOWS-04).
        const live = token === this._token && this.session === s && !!this._play;
        if (!r || !live || !graphicsLost() || ['restart', 'quit', 'superseded'].includes(r.action)) break;
        if (r.action === 'skip-tutorial') s.skipTutorial?.();
        reason = 'graphics';
        this._pauseReason = reason;
        this._pauseShownAt = nowMs();
      }
    } finally {
      this._pausing = false;
      this._pauseReason = null;
    }
    if (token !== this._token || this.session !== s || !this._play || !r || r.action === 'superseded') return false;
    switch (r.action) {
      case 'restart':
        this.ui.hide();
        s.restart();
        this._afterResume();
        break;
      case 'skip-tutorial':
        // "Skip tutorial" on the pause card (§6.9): "Fight!" and the bout goes on
        s.skipTutorial?.();
        this.ui.hide();
        s.resume();
        this._afterResume();
        break;
      case 'quit':
        this._finishPlay({ quit: true });
        break;
      case 'continue':
      case 'resume':
      default:
        this.ui.hide();
        s.resume();
        this._afterResume();
        break;
    }
    return true;
  }

  _afterResume() {
    this._resumedAt = nowMs();
    this._lostSince = [null, null];
    this.bus.emit(Ev.APP_RESUME, {});
  }

  // ───────────────────────────── activities ─────────────────────────────

  /**
   * Put a session on screen and resolve when it has a result ({result}) or the player quits ({quit:true}).
   * @param {MatchSession|TrainingRun} session
   */
  play(session) {
    this._dropSession();
    this.session = session;
    this.ui.hide();
    session.begin();
    this.flow = session.kind;
    this._resumedAt = nowMs();
    this._lostSince = [null, null];
    return new Promise((resolve, reject) => { this._play = { resolve, reject }; });
  }

  /** Resolve the activity being played (quit) and leave its scene. */
  _finishPlay(value) {
    const p = this._play;
    this._play = null;
    this._dropSession();
    this.ui.hide();
    p?.resolve(value);
  }

  /** Forget the session (scene back to the menu backdrop). */
  _dropSession() {
    const s = this.session;
    this.session = null;
    if (s) {
      try { s.skipOutro?.(); } catch { /* ignore */ }
      try { s.releaseHud(); } catch { /* ignore */ }
    }
    this.renderer.setSplit(1);
  }

  /** After the result screens: back to the menu backdrop. */
  endScene() {
    if (!this._play) this._dropSession();
  }

  /** Await a promise unless the flow is superseded (skipTo) meanwhile. */
  _guard(promise) {
    const token = this._token;
    return new Promise((resolve, reject) => {
      const entry = { reject };
      this._waits.add(entry);
      Promise.resolve(promise).then((v) => {
        this._waits.delete(entry);
        if (token !== this._token) reject(new Superseded()); else resolve(v);
      }, (e) => { this._waits.delete(entry); reject(e); });
    });
  }

  /** The bout outro (renderer.playOutro, ARCHITECTURE.md §6.5) has played — or was skipped. */
  async awaitOutro(session) {
    this.flow = 'outro';
    await this._guard(session.whenFinished());
  }

  /** A full-screen black curtain over the scene and the menus (above screens, below toasts). */
  _setCurtain(on) {
    if (typeof document === 'undefined') return;
    if (!this._curtain) {
      const el = document.createElement('div');
      el.className = 'gu-curtain';
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none', zIndex: '30' });
      (this.uiRoot?.parentElement || document.body).appendChild(el);
      this._curtain = el;
    }
    const el = this._curtain;
    el.style.transition = on ? 'none' : `opacity ${APP_TUNING.curtainFadeMs}ms linear`;
    el.style.opacity = on ? '1' : '0';
    this._curtainOn = !!on;
  }

  /** ~0.5 s of black (§1.2); the finished bout leaves the stage behind it. */
  async blackout(ms = this.params.fast ? APP_TUNING.blackoutFastMs : APP_TUNING.blackoutMs) {
    this._setCurtain(true);
    this.endScene();
    // PERF-02: the activity's pose budget (one pose per player) from here on, switched behind the black
    // (the hub would also switch on the VS card's screen id)
    try { this.input.setActivityMode?.(true); } catch (e) { this._reportOnce('pose-budget', e); }
    await this._guard(sleep(ms));
  }

  /**
   * The VS card after ~0.5 s of black (research/mechanics.md §1.2, §5): both fighters, ratings,
   * PRO badges, "Rematch". 'opponent' is the card's original screen id (audio plays menu music on it).
   */
  async vsCard(params) {
    await this.blackout();
    const shown = this.screen('opponent', params); // mounts synchronously …
    this._setCurtain(false);                       // … then the black lifts off it
    // PERF-04 / D11: compile the bout's shaders while the card is up (never awaited: it never blocks the card)
    this._prewarm({ p1: params?.profile?.appearance ?? null, p2: params?.opponent?.appearance ?? null });
    return shown;
  }

  /**
   * PERF-04 / D11: build the bout's two boxer models and compile every shader program the bout
   * would otherwise compile on its first frames (renderer.prewarm). Fire and forget: it never
   * throws, never draws, and the flow never waits for it.
   * @param {{p1?:Object|null, p2?:Object|null, versus?:boolean}} looks
   */
  _prewarm(looks) {
    try {
      const p = this.renderer?.prewarm?.(looks);
      if (p && typeof p.then === 'function') p.then((r) => { this._lastPrewarm = r || null; }, () => {});
    } catch (e) { this._reportOnce('prewarm', e); }
  }

  // ───────────────────────────── flows ─────────────────────────────

  async run() {
    for (;;) {
      try {
        const jump = this._jump;
        this._jump = null;
        if (jump) await this._doJump(jump);
        else await this.flowTitle();
      } catch (e) {
        if (e instanceof Superseded) continue;
        console.error('[app] flow failed', e);
        try { this._finishPlay({ quit: true }); } catch { /* ignore */ }
        try { this._setCurtain(false); } catch { /* ignore */ }
        this.ui.toast('Something went wrong — back to the start.', { kind: 'error' });
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /** ui.show() that unwinds the flow when it is superseded (skipTo / abort). */
  async screen(id, params = {}) {
    const token = this._token;
    const r = await this.ui.show(id, params);
    if (token !== this._token || !r || r.action === 'superseded') throw new Superseded();
    return r;
  }

  /** await play() that unwinds the flow when aborted. */
  async playChecked(session) {
    const token = this._token;
    const out = await this.play(session);
    if (token !== this._token) throw new Superseded();
    return out;
  }

  _check(token) { if (token !== this._token) throw new Superseded(); }

  fresh(p) { return (p && this.storage.getProfile(p.id)) || p; }

  async flowTitle() {
    this.flow = 'title';
    await this.screen('title', {});
    await this.flowProfiles();
  }

  /** SET01: who's boxing → main menu; Back returns to the title. */
  async flowProfiles() {
    for (;;) {
      this.flow = 'profiles';
      const r = await this.screen('profiles', {});
      if (r.action !== 'select' || !r.profile) return;
      this.profile = r.profile;
      await this.flowMenu();
    }
  }

  /** Main menu loop; returns when the player wants another boxer. */
  async flowMenu() {
    for (;;) {
      this.profile = this.fresh(this.profile);
      // FLOWS-04: deleted in another tab → back to the boxers screen (it shows the current list)
      if (this._profileGone(this.profile)) return;
      this.flow = 'mode';
      const r = await this.screen('mode', { profile: this.profile });
      if (r.action === 'single') await this.flowSingle();
      else if (r.action === 'versus') await this.flowVersus();
      else if (r.action === 'training') await this.flowTraining();
      else if (r.action === 'change-profile' || r.action === 'back') return;
    }
  }

  /**
   * Single player (research/mechanics.md §1.1, §1.2, §7): camera (+ calibration) → black →
   * VS card → bout (first-bout tutorial for a new boxer) → result locked + saved → outro → decision
   * reveal (decisions / draws) → results card → "Play again" = the next VS card, "Quit" = menu.
   * @param {{direct?:boolean, opponent?:Object|null, tutorial?:boolean|null}} [o]
   *        direct: straight into the first bout (debug skipTo('match')); tutorial: force it on/off
   */
  async flowSingle({ direct = false, opponent: forced = null, tutorial = null } = {}) {
    let profile = this.fresh(this.profile);
    if (!direct) {
      if (!(await this.ensureCamera(1, [profile]))) return;
    }
    let first = true;
    for (;;) {
      profile = this.fresh(profile);
      this.profile = profile;
      // PRG01 / §7.5: the next unbeaten opponent within reach, else a rematch, else the best available
      const bout = first && forced ? { opponent: forced } : nextBout(profile);
      const opponent = bout.opponent;
      const card = describeBout({ profile, bout });
      if (!(direct && first)) {
        this.flow = 'opponent';
        const r = await this.vsCard({ opponent, profile, bout: card });
        if (r.action !== 'start') return;
      }
      // the direct path (skipTo('match')) has no VS card to hide the shader compiles behind: start them now
      if (direct && first) this._prewarm({ p1: profile?.appearance ?? null, p2: opponent?.appearance ?? null });
      const withTutorial = this._wantsTutorial(profile, first ? tutorial : null);
      first = false;
      this._useProfiles([profile]);
      const session = new MatchSession({
        bus: this.bus, renderer: this.renderer, hud: this.ui.hud, mode: 'single', players: [profile], opponent,
        seed: this.params.seed, fast: this.params.fast,
        latencyMs: () => this._latencyFor([profile]),
        tutorial: withTutorial, inputMode: () => this._hudInputMode(),
        onTutorialDone: () => this._tutorialDone(profile),
      });
      const out = await this.playChecked(session);
      if (out.quit) return;
      const result = out.result;
      // PRG02 + SAV01: rate and save once, the moment the result locks (closing the tab during the
      // outro keeps the record); applyBout = the same numbers storage.recordMatch stores
      const before = this.fresh(profile);
      const upd = applyBout(before, result, { playerId: 'p1', opponent });
      const save = this.saveMatch(before, result, 'p1', upd, opponent.name);
      await this.awaitOutro(session);
      session.releaseHud();
      if (isDecision(result)) {
        // the judges' cards first (MAT04); a KO goes straight to the results card
        this.flow = 'result';
        await this.screen('result', {
          result, names: { p1: profile.name, p2: opponent.name },
          appearances: { p1: profile.appearance, p2: opponent.appearance }, humanSide: 'p1',
        });
      }
      profile = save?.profile ? save.profile : this.fresh(profile);
      this.flow = 'skill';
      const summary = save?.summary || resultsSummary(upd);
      const r2 = await this.screen('skill', { ...summary, save, profile });
      // FLOWS-04: the boxer was deleted in another tab (the results card says so): no more bouts to save
      if (r2.action !== 'next' || save?.errorCode === 'deleted') { this.endScene(); return; }
      // "Play again": straight to the next VS card (the next opponent or a rematch) after the black
    }
  }

  /** FLOWS-04: a local boxer that another tab of the game deleted meanwhile. */
  _profileGone(p) {
    if (!p || p.kind !== ProfileKind.LOCAL) return false;
    try { return !this.storage.getProfile(p.id); } catch { return false; }
  }

  /** Does this boxer's next bout open with the first-bout tutorial (§8)? */
  _wantsTutorial(profile, forced = null) {
    const f = forced ?? this.params.tutorial;
    if (f === true || f === false) return f;
    if (!profile || (profile.skill || 0) !== 0 || !needsTutorial(profile)) return false;
    // guests (and visiting boxers that never finished it) see it once per session
    if (profile.kind !== ProfileKind.LOCAL && this._guestTutorialSeen) return false;
    return true;
  }

  /** The tutorial was finished or skipped: never again for this boxer (storage keeps the flag). */
  _tutorialDone(profile) {
    if (!profile) return;
    if (profile.kind !== ProfileKind.LOCAL) this._guestTutorialSeen = true;
    try { this.storage.markTutorialDone(profile.id); } catch (e) { console.warn('[app] could not mark the tutorial as done', e); }
  }

  /** 'keyboard' | 'camera' wording for the tutorial cards. */
  _hudInputMode() { return this.input.mode === InputMode.KEYBOARD ? 'keyboard' : 'camera'; }

  /**
   * Camera → game latency for latency-fair defence (research/mechanics.md §4.6): the boxers'
   * calibration.latencyMs, else the hub's live measurement, else null (the game's default, 100 ms).
   * Keyboard: APP_TUNING.keyboardLatencyMs.
   */
  _latencyFor(profiles) {
    if (!this._camera()) return APP_TUNING.keyboardLatencyMs;
    const cal = (profiles || []).map((p) => this.fresh(p)?.calibration?.latencyMs).filter((v) => Number.isFinite(v));
    if (cal.length) return Math.max(...cal);
    const live = this.input.latencyMs;
    return Number.isFinite(live) ? live : null;
  }

  /** Local versus: P2's boxer → 2-player camera + calibration → split-screen bout → result. */
  async flowVersus() {
    const p1 = this.fresh(this.profile);
    this.flow = 'versus-p2';
    const pick = await this.screen('profiles', {
      title: 'Who is P2?', sub: `${p1.name} boxes as P1 (left half)`, exclude: [p1.id], allowGuest: true, allowImport: true,
    });
    if (pick.action !== 'select' || !pick.profile) return;
    let p2 = pick.profile;
    // PERF-04 / D11: versus has no VS card — compile the bout's shaders during the camera screen
    this._prewarm({ p1: p1?.appearance ?? null, p2: p2?.appearance ?? null, versus: true });
    // picking a local P2 marks it as "last used"; the boxer who opened the menu stays the default
    if (p1.kind === ProfileKind.LOCAL) this.storage.saveSettings({ lastProfileId: p1.id });
    try {
      if (!(await this.ensureCamera(2, [p1, p2]))) return;
      const a = this.fresh(p1);
      p2 = this.fresh(p2);
      this._useProfiles([a, p2]);
      const session = new MatchSession({
        bus: this.bus, renderer: this.renderer, hud: this.ui.hud, mode: 'versus', players: [a, p2],
        seed: this.params.seed, fast: this.params.fast, latencyMs: () => this._latencyFor([a, p2]),
      });
      const out = await this.playChecked(session);
      if (out.quit) return;
      const result = out.result;
      // PRG02/A11: versus never changes the rating — records only (each boxer from their own corner).
      // The winner card has no save notice, so a failed save (ERR04) is announced with a toast.
      this.saveMatch(a, result, 'p1', null, p2.name, { notify: true });
      this.saveMatch(p2, result, 'p2', null, a.name, { notify: true });
      await this.awaitOutro(session);
      session.releaseHud();
      this.flow = 'result';
      await this.screen('versus-result', {
        result, names: { p1: a.name, p2: p2.name }, appearances: { p1: a.appearance, p2: p2.appearance }, humanSide: null,
      });
      this.endScene();
    } finally {
      this.input.setPlayers(1);
    }
  }

  /** Training: pick a drill + participants → camera check → each participant's turn → results. */
  async flowTraining({ kind: directKind = null } = {}) {
    for (;;) {
      let kind = directKind;
      let participants = [this.fresh(this.profile)];
      if (!kind) {
        this.flow = 'training-select';
        const sel = await this.screen('training-select', { profile: this.fresh(this.profile) });
        if (sel.action !== 'start') return;
        kind = sel.kind;
        participants = sel.participants?.length ? sel.participants : participants;
        if (!(await this.ensureCamera(1, [participants[0]], { calibrate: false }))) continue;
      }
      const run = new TrainingRun({
        bus: this.bus, renderer: this.renderer, hud: this.ui.hud, kind, participants, seed: this.params.seed, fast: this.params.fast,
        // the activity reads participant.calibration.latencyMs itself; an uncalibrated camera player
        // gets the hub's live measurement (keyboard: the drills' own graces)
        latencyMs: (part) => (this._camera() && !Number.isFinite(part?.calibration?.latencyMs) ? this._latencyFor([part]) : null),
      });
      for (;;) {
        const cur = run.session.current();
        if (!cur) break;
        let part = this.fresh(cur.participant);
        if (!directKind) {
          if (!(await this.ensureCalibration(part, 0))) break;
        }
        part = this.fresh(part);
        run.session.participants[cur.index] = part; // the drill uses the latest calibration
        this._useProfiles([part]);
        const out = await this.playChecked(run);
        if (out.quit) break;
        const result = out.result;
        const save = this.saveTraining(part, result);
        run.session.record(result, save);
        run.releaseHud();
        this.flow = 'training-result';
        const r = await this.screen('training-result', run.session.screenParams());
        if (r.action === 'retry') { run.session.retry(); continue; }
        if (r.action === 'next' && run.session.next()) continue;
        break;
      }
      this.endScene();
      if (directKind) return;
    }
  }

  /**
   * ERR01 camera gate (+ calibration for players who have none). Keyboard input skips it.
   * @returns {Promise<boolean>} false = the player backed out
   */
  async ensureCamera(players, profiles, { calibrate = true } = {}) {
    this.input.setPlayers(players);
    this._useProfiles(profiles);
    if (!this._camera()) return true;
    const hub = this.input;
    if (!this.synthetic && hub.mode === InputMode.CAMERA && (hub.status.phase === 'idle' || hub.status.phase === 'stopped')) {
      hub.start(); // the camera-setup screen shows progress and errors
    }
    setup: for (;;) {
      this.flow = 'camera-setup';
      const calibrated = profiles.every((p) => !!this.fresh(p)?.calibration);
      const r = await this.screen('camera-setup', { players, allowKeyboard: true, calibrated: calibrate && calibrated });
      if (r.action === 'back') return false;
      if (r.action === 'retry') continue;
      if (r.action === 'keyboard') { await this.useKeyboard(); return true; }
      if (!calibrate) return true;
      for (let i = 0; i < players; i++) {
        const ok = await this.ensureCalibration(profiles[i], i, { force: !!r.recalibrate || this.params.calibrate });
        if (!ok) continue setup;
      }
      return true;
    }
  }

  /** Calibrate a player who has no calibration yet (or when asked). false = backed out. */
  async ensureCalibration(profile, player, { force = false } = {}) {
    const p = this.fresh(profile);
    if (!this._camera()) return true;
    if (!force && (p.calibration || this._calibSkipped.has(p.id))) {
      if (p.calibration) this.input.setCalibration(player, p.calibration);
      return true;
    }
    this.flow = 'calibrate';
    const r = await this.screen('calibrate', { player, profile: p, name: p.name });
    if (r.action === 'back') return false;
    if (r.action === 'skip') this._calibSkipped.add(p.id);
    // 'done': the screen saved it to the profile and the hub applied it to the recognizer
    return true;
  }

  /** Switch this session to keyboard controls (camera-setup "Use keyboard instead"). */
  async useKeyboard() {
    const token = this._token;
    this.feeder.stop();
    this.synthetic = false;
    await this.input.setMode(InputMode.KEYBOARD);
    if (this.input.status.phase !== 'running') await this.input.start();
    this._check(token);
    this.ui.toast('Keyboard: J / K punch · Shift body · E power · Space / B guard · A / D lean · S duck · X lean back · P pause', { kind: 'info', ms: 6000 });
  }

  /** Give the input hub the boxers' calibration (P1, P2). */
  _useProfiles(profiles) {
    this.input.setProfiles(profiles.map((p) => ({ calibration: this.fresh(p)?.calibration || null })));
  }

  // ───────────────────────────── saving (SAV01, ERR04, SES02) ─────────────────────────────

  /**
   * Record a bout for one boxer exactly once.
   * @param {{notify?:boolean}} [o]  notify: toast a failed save (screens without their own save notice)
   */
  saveMatch(profile, result, side, skillUpdate, opponentName, { notify = false } = {}) {
    const key = `${profile.id}|${result.id}`;
    if (this._saved.has(key)) return this._saved.get(key);
    const save = this.storage.recordMatch(profile.id, result, skillUpdate, { side, opponentName });
    this._saved.set(key, save);
    this._afterSave('match', profile, save, notify);
    return save;
  }

  /** Record a training attempt exactly once (the training-result screen shows its save notice). */
  saveTraining(profile, result) {
    const key = `${profile.id}|${result.id}`;
    if (this._saved.has(key)) return this._saved.get(key);
    const save = this.storage.recordTraining(profile.id, result);
    this._saved.set(key, save);
    this._afterSave('training', profile, save, false);
    return save;
  }

  _afterSave(kind, profile, save, notify) {
    const entry = { kind, profileId: profile.id, profileKind: profile.kind, ok: !!save?.ok, saved: !!save?.saved, reason: save?.reason || null, error: save?.error || null };
    this._saveLog.push(entry);
    if (this._saveLog.length > 20) this._saveLog.shift();
    this.bus.emit(Ev.SAVE_RESULT, entry);
    // ERR04: a LOCAL boxer's record could not be written — say so, the result itself still stands
    if (notify && !entry.saved && profile.kind === ProfileKind.LOCAL) {
      this.ui.toast(`${profile.name}’s result was not saved: ${save?.error || 'storage is unavailable'}`, { kind: 'warn', ms: 5200 });
    }
  }

  // ───────────────────────────── debug & test hooks (ARCHITECTURE.md §4) ─────────────────────────────

  /** Abort whatever is running and go to `target` (title | profiles | mode | single | match | versus | training | bag | dodge | mitts | records | settings | help). */
  skipTo(target, opts = {}) {
    this._jump = { target: String(target || 'title'), opts: opts || {} };
    this._token++;
    const p = this._play;
    this._play = null;
    this._dropSession();
    this.ui.hide();
    this._setCurtain(false);
    p?.reject(new Superseded());
    for (const w of [...this._waits]) w.reject(new Superseded());
    this._waits.clear();
    return this._jump.target;
  }

  async _doJump({ target, opts }) {
    if (target === 'title') return this.flowTitle();
    if (target === 'profiles') { await this.flowProfiles(); return; }
    this.profile = this._jumpProfile(opts);
    const tutorial = typeof opts.tutorial === 'boolean' ? opts.tutorial : null;
    switch (target) {
      case 'mode': case 'menu': break;
      case 'single': await this.flowSingle({ tutorial }); break;
      case 'match': await this.flowSingle({ direct: true, opponent: opts.opponentId ? opponentById(opts.opponentId) : null, tutorial }); break;
      case 'versus': await this.flowVersus(); break;
      case 'training': await this.flowTraining(); break;
      case 'records': case 'settings': case 'help':
        this.flow = target;
        await this.screen(target, { profile: this.profile });
        break;
      default:
        if (TRAINING_TARGETS.has(target)) await this.flowTraining({ kind: target });
        else if (target.startsWith('training:') && TRAINING_TARGETS.has(target.slice(9))) await this.flowTraining({ kind: target.slice(9) });
        else console.warn(`[app] skipTo: unknown target "${target}"`);
    }
    await this.flowMenu();
    await this.flowProfiles();
  }

  _jumpProfile(opts) {
    if (opts?.profileId) {
      const p = this.storage.getProfile(opts.profileId);
      if (p) return p;
    }
    if (this.profile) return this.fresh(this.profile);
    return this.storage.sessionProfiles().find((p) => p.kind === ProfileKind.GUEST) || this.storage.guest();
  }

  /** Queue a scripted pose for the synthetic camera (switches keyboard input to injected poses). */
  injectPose(action, ms = 800, opts = {}) {
    if (this.input.mode === InputMode.KEYBOARD || (!this.synthetic && this.input.status.phase === 'running')) this._enterSynthetic();
    return this.feeder.push(action, ms, opts);
  }

  _enterSynthetic() {
    this.synthetic = true;
    this.input.stop();
    this.input.setMode(InputMode.CAMERA); // stopped hub: switches the mode without opening the camera
  }

  state() {
    const cur = this.ui.current;
    const st = this.input.status;
    const p = this.profile ? this.fresh(this.profile) : null;
    let rd = null;
    try {
      const d = this.renderer.debugState();
      rd = {
        scene: d.scene, split: d.split, shot: d.shot, shot2: d.shot2, timeScale: d.timeScale, hitStopMs: d.hitStopMs,
        meters: d.meters ?? null, slowmo: d.slowmo ?? null, outro: d.outro ?? null, cuts: d.cuts ?? null,
        lost: !!d.lost, quality: d.quality ?? null, prewarm: this._lastPrewarm ?? null,
      };
    } catch { rd = null; }
    return {
      flow: this.flow,
      screen: cur ? cur.id : null,
      screenDone: cur ? !!cur.done : null,
      inputMode: this.input.mode,
      synthetic: this.synthetic,
      curtain: !!this._curtainOn,
      profile: p ? { id: p.id, name: p.name, kind: p.kind, skill: p.skill, pro: p.pro, calibrated: !!p.calibration, tutorialDone: !!p.tutorialDone, bestRating: p.bestRating ?? null } : null,
      playing: !!this._play,
      pausing: this._pausing,
      pauseReason: this._pauseReason,
      activity: this.session ? this.session.debug() : null,
      input: {
        phase: st.phase, players: st.players, tracking: st.tracking, presence: st.presence, fps: Math.round(st.fps), error: st.error,
        errorTitle: st.errorTitle ?? null, detector: st.detector ?? null, poseMode: st.poseMode ?? null, numPoses: st.numPoses ?? null,
        frameAgeMs: Number.isFinite(st.frameAgeMs) ? Math.round(st.frameAgeMs) : null,
        // PERF-06: model / delegate and the per-stage pipeline timings (InputHub status.pipeline)
        model: st.model ?? null, modelPref: st.modelPref ?? null, delegate: st.delegate ?? null, latencyMs: st.latencyMs ?? null,
        pipeline: st.pipeline ?? null,
      },
      render: rd,
      saves: this._saveLog.slice(-6),
      errors: [...this._errors],
    };
  }

  _exposeDebugHooks() {
    const app = this;
    window.__glove = {
      app,
      bus: this.bus,
      input: this.input,
      ui: this.ui,
      renderer: this.renderer,
      audio: this.audio,
      storage: this.storage,
      feeder: this.feeder,
      /** Scripted pose through the real recognizer: injectPose('jab-left', 400) · ('guard-high', 1500, {player: 1}). */
      injectPose: (action, ms, opts) => app.injectPose(action, ms, opts),
      /** Everybody (or one player) leaves the fake camera's picture. */
      stopPose: (player = null) => app.feeder.stop(player),
      state: () => app.state(),
      skipTo: (target, opts) => app.skipTo(target, opts),
      pause: (reason = 'user') => app.requestPause(reason),
      /** Jump to the end of the bout outro / skip the first-bout tutorial (as Enter does). */
      skipOutro: () => !!app.session?.skipOutro?.(),
      skipTutorial: () => !!app.session?.skipTutorial?.(),
      get match() { return app.session?.kind === 'match' ? app.session.match : null; },
      get tutorial() { return app.session?.tutorial || null; },
      get training() { return app.session?.kind === 'training' ? app.session.act : null; },
      get session() { return app.session; },
    };
  }

  _reportOnce(key, e) {
    if (this._errors.has(key)) return;
    this._errors.add(key);
    console.error(`[app] ${key} failed`, e);
  }
}
