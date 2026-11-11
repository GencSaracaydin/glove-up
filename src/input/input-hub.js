// InputHub — the ONLY thing the app talks to for gameplay input (ARCHITECTURE.md §input-hub).
//
//   const hub = new InputHub({ bus, mode: InputMode.CAMERA, players: 1, video, profiles });
//   await hub.start();                         // → {ok, error?}; never throws
//   const { players, status } = hub.update(performance.now());   // every render tick
//   players[i] = { control: ControlState, events: InputEvent[] }   // each event returned exactly once
//
// Modes: camera (webcam or ?video clip → PoseTracker → PlayerAssigner → GestureRecognizer),
// keyboard (KeyboardInput, same output shape), replay (a recorded PoseFrame file through the
// full pipeline). Camera mode can add keyboard assist (keys add punches / override lean+guard).
//
// Latency (research/mechanics.md §4.6): hub.latencyMs (also status.latencyMs) = rolling median of the
// camera capture → pose-ready time of recent frames + the smoothing delay (HUB_TUNING.processingLagMs);
// hub.calibrate(i) stores it in the calibration result (Calibration.latencyMs) for the profile.
// Sensitivity: hub.setSensitivity(0..1) → every GestureRecognizer (keyboard input ignores it).
//
// Bus events: Ev.INPUT_PUNCH {player, punch} when a punch is recognised; Ev.INPUT_TRACKING_LOST
// / FOUND {player} debounced (ERR02: lost after `lostMs` of missing/low-confidence tracking,
// found after `foundMs` of good tracking); Ev.INPUT_ERROR {message, help, code, title, source, cause}
// (source 'camera' = the webcam failed; 'tracker' = the pose model/runtime failed, the camera may be fine).
//
// Detection (PERF-01): with `detector` 'worker' the PoseLandmarker runs in a dedicated worker
// (WorkerPoseTracker): update() only picks up the newest finished pose and never waits. With 'main'
// (PoseTracker) the inference runs inside update() whenever the camera delivered a new frame (≈30 Hz).
// Either way, between frames the last ControlState is returned. hub.lastDetectMs = main-thread ms the
// last update() spent on detection (0 if none ran), for the renderer's adaptive quality (PERF-03).
//
// How many people MediaPipe looks for (PERF-02, HUB_TUNING.extraPoses): `players + extraPoses` on
// setup (boot, the camera check, calibration) so posters and bystanders can be told apart;
// `players` during activities (from the VS card / bout intro / drill start until the next camera
// check) because the extra pose roughly doubles the GPU detect time. During an activity the extra
// pose comes back while a player is missing (to find them again even if a poster is in view) and for
// the rest of the activity once other people were seen. setActivityMode(on) switches explicitly; the
// hub also follows Ev.APP_SCREEN ('opponent' → on, 'camera-setup' / 'calibrate' → off),
// Ev.MATCH_INTRO and Ev.TRAIN_START (→ on). Each switch restarts MediaPipe's graph (≈240 ms first
// detect), so the planned switches sit behind the VS card / intro / drill countdown.
//
// Camera loss (FLOWS-02, ERR02): an ended track, or one muted for CAMERA_DEFAULTS.mutedErrorMs, sets
// phase 'error' (status.error / errorHelp, Ev.INPUT_ERROR); calling start() again reopens the camera and
// keeps the player slots (PlayerAssigner) — the paused activity resumes once the players are back.
//
// Pose rate and lag (PERF-06):
//  * Every detected frame is processed, in order, with its own capture timestamp (tracker.detect() +
//    takeFrames()): two poses finished between two game frames are no longer reduced to the newest one.
//  * renderPressure {behind, rateBehind, starved, headroom, gpu, …}: is detection keeping up (≥ behindRatio ×
//    min(camera, targetDetectFps) poses per second and, during activities, a median detect time ≤ behindDetectMs)?
//    The app hands it to the renderer's adaptive quality (render/adaptive.js), which lowers the frame-rate cap / pixel
//    ratio / shadows while a GPU detector is behind — the render and a GPU detector share one GPU — and only raises
//    them again while detection has headroom. The app hands back whether the render is at its floor (setRenderState).
//  * Only a STARVED detector (fewer than starvedRatio × the wanted poses per second — the recall cost of a slow full
//    model is measured above lite's, see HUB_TUNING.starvedRatio) moves the model or the delegate; lag alone never does.
//  * Model 'auto' (the default; Settings → Tracking): full, and lite once detection stays starved for liteAfterMs during an
//    activity with the render at its floor; full again once lite's median predicts that full keeps up (fullAfterMs), on
//    probation (fullProbationMs, lite stays loaded: starved again → back at once, next try waits twice as long). An
//    explicit 'full' / 'lite' is never changed by the hub.
//  * Delegate: a detector still starved delegateAfterMs after that (another program busy on the GPU) tries the other
//    delegate; the start-up slow-GPU verdict (RV-PERF-02) is handed to the hub the same way. Trials: kept only if clearly
//    faster; the old landmarker stays loaded, so a lost trial goes back at once (HUB_TUNING.delegateAuto).
//  * Switches never stop detection: the new landmarker is prepared next to the running one — in a second worker, which
//    is started, warmed up and primed with a real frame while the first keeps detecting — and the commit just sends the
//    next frame to it (no pause; the main-thread fallback pauses for one warm-up inference). Prepare and commit still
//    wait for a SAFE moment (a model or delegate change mid-exchange is not wanted): menus, between rounds, after a bout,
//    paused; never during a round, the first-bout tutorial (from MATCH_INTRO) or a drill — unless detection is URGENTLY
//    starved (below urgentRatio × the wanted rate for urgentAfterMs: another round at that rate costs far more). A
//    switch that fails backs off (doubling) and is given up after a few, at once for a missing model file.
//  * While the camera and detector start, renderPressure says {starting: true}: a fast display caps the render at once.
//  * Camera rate: the camera opens at its usual 30 fps; one that offers 60 runs at 60 only while the detector takes
//    every frame as it arrives (median ≤ camera60TryDetectMs to go up, ≤ camera60KeepDetectMs to stay) — a frame that
//    waits for a busy worker is no fresher than at 30. Instant applyConstraints changes, no gap.
//  * status.pipeline: camera / detection rates (and the slowest second of the last 10 s), p50/p90 per stage
//    (capture → frame available → handed over → inference → back on the main thread → game), capture → punch
//    event, model / delegate / camera rate, the render pressure, the switch under way and the switches made.
// Pure logic except start()/camera; runs in Node with injected frames.

import { Ev, InputMode } from '../core/types.js';
import { GestureRecognizer } from './gesture.js';
import { CalibrationSession } from './calibration.js';
import { openCamera, openVideoFile } from './camera.js';
import { PoseTracker } from './pose-tracker.js';
import { WorkerPoseTracker } from './pose-worker-tracker.js';
import { PlayerAssigner } from './player-assigner.js';
import { KeyboardInput, neutralControl } from './keyboard.js';
import { Recorder, ReplaySource } from './recorder.js';

export const HUB_TUNING = Object.freeze({
  /** ERR02: tracking must be missing/poor this long before INPUT_TRACKING_LOST. Meanwhile the HUD asks "Please keep
   *  your hands visible" (the recognizer reports a player untracked once a hand has been out of view for its
   *  lostAfterMs), so a player has a second to bring the hands back before the fight pauses. */
  lostMs: 1000,
  /** …and good again this long before INPUT_TRACKING_FOUND. */
  foundMs: 300,
  /** No new camera frame for this long ⇒ nobody counts as tracked (frozen/unplugged camera). */
  staleFrameMs: 500,
  /** Setup (camera check, calibration, boot) and while a player is missing: detect `players + extraPoses`
   *  people so posters/bystanders can be told apart from players. With 0, MediaPipe follows whoever it
   *  locked onto first (a poster can hide the player). Measured cost on an Apple M3, full model: the
   *  GPU delegate goes from ≈11 to ≈32 ms per frame with one extra pose (2 or 3 poses cost the same,
   *  because the person detector then runs every frame); the CPU delegate +≈10 ms. */
  extraPoses: 1,
  /** During activities (bouts, drills, the tutorial): `players + activityExtraPoses` (PERF-02). */
  activityExtraPoses: 0,
  /** Other people (PlayerAssigner `ignored` poses) seen this recently keep the extra pose for the activity. */
  othersMemoryMs: 8000,
  /** After a numPoses switch, missing frames don't count as a frozen camera until the first new frame,
   *  for at most this long (MediaPipe's restart: ≈240 ms on an M3, more on slow machines). */
  poseSwitchGraceMs: 2500,
  maxPoses: 3,
  /** Where pose detection runs: 'worker' (dedicated worker, main-thread fallback) or 'main'.
   *  Overridden by the constructor's `detector` option or the page's ?detector= parameter. */
  detector: 'worker',
  /** How often update() double-checks that the camera track is still live (ms). */
  cameraCheckMs: 250,
  /** PlayerPose.score below this counts as "not tracked" for the debounce. */
  minScore: 0.35,
  /** Per-player event queue cap (only reached if nobody calls update()). */
  maxQueuedEvents: 64,
  /** A BoundCalibration feeds itself from its own update(pose) only if the hub hasn't for this long. */
  calibrationSelfFeedMs: 250,
  /**
   * Latency (research/mechanics.md §4.6). hub.latencyMs = rolling median (latencyWindow frames) of
   * camera capture → pose ready (PoseFrame.timing from PoseTracker; for replayed / injected frames the
   * wall-clock age of the frame) + processingLagMs: the smoothing delay inside the tracker and the
   * gesture filters (≈ 18 ms tracker + ≈ 15 ms lean/punch filters, measured in simulation).
   */
  processingLagMs: 30,
  latencyWindow: 45,
  // ── PERF-06: pose rate and lag (see the header) ──
  /** Frames per second asked of the camera when it opens (the camera's own default mode, as before PERF-06). */
  cameraFps: 30,
  /** A camera that offers 60 fps runs at 60 while the detector keeps up with it (see camera60*); false: never. */
  camera60: true,
  /** The pose rate the game is built for: detection is "behind" below behindRatio × min(camera rate, this). */
  targetDetectFps: 30,
  behindRatio: 0.9,
  /** Activities (players' poses only): a median detect time above this is behind too (it is lag, frame by frame) —
   *  for the render's quality steps only, never for the model or the delegate (it costs no recall). */
  behindDetectMs: 25,
  /** Detection has headroom (the render may take more GPU) at ≥ 97 % of the wanted rate and a median at or below: */
  headroomDetectMs: 18,
  /** … in setup (players + extra poses: the person detector runs on every frame, ≈ 30 ms whatever the render does). */
  headroomDetectMsSetup: 30,
  /** Rates and medians come from at least this many recent frames before anything is judged. */
  minJudgedFrames: 15,
  /**
   * "Starved": fewer than starvedRatio × the wanted poses per second. Only this moves the model or the delegate. Measured on
   * five labelled real clips (661 punches, the full model through the hub): recall 27.5 % at 30 poses/s, 19.2 % at 20, 13.6 %
   * at 12, 2.9 % at 7; the lite model at 30 poses/s loses ≈ 17 % of the full model's recall (c1 + c3: 79 vs 95 of 326) and
   * fires ≈ 50 % more false punches — so lite only wins once full stays below ≈ 24 poses/s.
   */
  starvedRatio: 0.8,
  /** Model 'auto': starved this long during an activity, with the render at its floor (or for liteMaxWaitMs) → lite. */
  liteAfterMs: 8000,
  liteMaxWaitMs: 20000,
  /**
   * Model 'auto' on lite: full again once lite's median × the full / lite cost ratio (measured at the switch, clamped to
   * fullCostRatio*) stays at or below fullKeepsUpRatio × the frame interval of the wanted rate for fullAfterMs (activity).
   */
  fullAfterMs: 30000,
  fullKeepsUpRatio: 0.8,
  fullCostRatio: 1.6,
  fullCostRatioMin: 1.2,
  fullCostRatioMax: 2.2,
  /** Full is on probation this long after it came back (lite stays loaded): starved again → lite at once, and the next
   *  try waits twice as long (up to fullRetryMaxMs). */
  fullProbationMs: 30000,
  fullRetryMaxMs: 600000,
  /**
   * 60 fps camera: at 60 a frame is ≈ 6 ms fresher, but only while the detector is free when it arrives — a frame that waits
   * for a busy worker is no fresher than at 30 (measured: detect 19 ms → capture → game 42 ms at 60 vs 30 ms at 30). So: at 30,
   * a median at or below camera60TryDetectMs for camera60RetryMs during an activity → 60; at 60, a median above
   * camera60KeepDetectMs or fewer than camera60MinRatio × 60 poses per second for camera60BehindMs → 30 (doubling wait).
   */
  camera60TryDetectMs: 11,
  camera60KeepDetectMs: 14,
  camera60MinRatio: 0.85,
  camera60BehindMs: 3000,
  camera60RetryMs: 20000,
  camera60RetryMaxMs: 300000,
  /**
   * Delegate governor: a detector still starved delegateAfterMs after the render steps (and, with the auto model, lite) had
   * their chance — another program busy on the GPU — tries the other delegate (a CPU the hub or the slow-GPU check chose
   * tries the GPU the same way). A trial: the new landmarker is kept only if, delegateTrialMs after the switch, it detects
   * at least delegateGain × the old rate; the old one stays loaded meanwhile, so a lost trial goes back at once (doubling
   * the wait, up to delegateRetryMaxMs); a kept one waits delegateKeptMs before the opposite move is considered.
   */
  delegateAuto: true,
  delegateAfterMs: 15000,
  delegateTrialMs: 6000,
  delegateGain: 1.15,
  delegateKeptMs: 60000,
  delegateRetryMaxMs: 240000,
  /**
   * RG4 — like with like: a trial compares the two landmarkers' judged rates in the SAME context — in a round (fighting, not
   * paused) or not, with the same pose budget — never a rate from between rounds (a lighter render) with one from a round.
   * A trial whose old landmarker was measured in a round is judged in a round, delegateTrialMs into it (one tracker window
   * skipped, then the median of the samples); the old landmarker needs at least delegateBaselineMs of samples there. No such
   * verdict within delegateTrialMaxMs (the player left the activity): the most-sampled context against the old rates pooled.
   */
  delegateBaselineMs: 2000,
  delegateTrialMaxMs: 120000,
  /** A switch is prepared (built next to the running landmarker) and committed at safe moments; one not built by then is dropped. */
  switchPrepareMaxMs: 30000,
  /**
   * Urgent: detection below urgentRatio × the wanted rate for urgentAfterMs during an activity (recall ≈ 2.9 % at 7 poses/s,
   * 13.6 % at 12, vs 27.5 % at 30) — then a two-phase switch is built and committed without waiting for a safe moment (the
   * worker swap has no pause; the main-thread fallback pauses for one warm-up inference).
   */
  urgentRatio: 0.5,
  urgentAfterMs: 10000,
  /** A failed switch to the same model / delegate waits this long, doubling (up to switchFailMaxMs); after switchMaxFailures
   *  (or a missing model file) it is not tried again this session. */
  switchFailWaitMs: 60000,
  switchFailMaxMs: 600000,
  switchMaxFailures: 3,
  /** A commit restarts MediaPipe's graph: missing frames don't count as a frozen camera for this long. */
  modelSwitchGraceMs: 6000,
  /** How often the pipeline governor re-judges (ms). */
  governorMs: 250,
  /** After a pose-budget / model / camera-rate change, the figures start over and nothing is judged for this long (ms). */
  settleJudgeMs: 1000,
  /** Capture → punch event samples kept for status.pipeline. */
  eventWindow: 20,
});

/** renderPressure while the camera / detector start (PERF-06). */
const STARTING_PRESSURE = Object.freeze({ starting: true, behind: false, rateBehind: false, starved: false, headroom: false, gpu: true, judged: false, activity: false });

/** The cards shown over a PAUSED activity (app.requestPause): any other screen while paused means it was quit (RG1). */
const PAUSE_SCREENS = new Set(['pause', 'tracking-lost']);

/** Judged detection-rate samples kept per context for the delegate trials (RG4): 10 s at governorMs 250. */
const RATE_SAMPLES = 40;

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Settings / constructor model preference: 'auto' (default), 'full' or 'lite'. */
export function normModelPref(m) {
  return m === 'lite' || m === 'full' ? m : 'auto';
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Calibration bound to one player's pose stream. The hub feeds it every new camera frame;
 * `update()` mirrors CalibrationSession.update() but just returns the latest state, so UI code
 * can call it every tick without double-feeding. When it finishes, the hub applies the result
 * to that player's recognizer automatically (and the UI saves `result` to the profile).
 */
export class BoundCalibration {
  constructor(hub, player, session) {
    this.hub = hub;
    this.player = player;
    this.session = session;
    this.cancelled = false;
    /** latest CalibrationSession.update() result */
    this.state = { step: 'frame', progress: 0, message: 'Waiting for the camera…', ok: false, done: false, result: null };
    this.result = null;
    this._lastFeedWall = -Infinity;
  }
  get done() { return !!(this.state && this.state.done); }
  /** @internal called by the hub for every new frame */
  _feed(pose, tMs, wallMs) {
    if (this.cancelled || this.done) return;
    this._lastFeedWall = wallMs;
    const st = this.session.update(pose, tMs);
    if (st) this.state = st;
    if (st && st.done && st.result && !this.result) {
      // the measured camera → game latency travels with the calibration (research/mechanics.md §4.6)
      const lat = this.hub.latencyMs;
      if (!Number.isFinite(st.result.latencyMs) && Number.isFinite(lat)) st.result.latencyMs = lat;
      this.result = st.result;
      this.hub.setCalibration(this.player, st.result);
    }
  }
  /** Same signature as CalibrationSession.update; returns the latest state. */
  update(pose, tMs = nowMs()) {
    if (pose !== undefined && tMs - this._lastFeedWall > this.hub.tuning.calibrationSelfFeedMs) this._feed(pose, tMs, tMs);
    return this.state;
  }
  cancel() {
    this.cancelled = true;
    if (this.hub._calibrations[this.player] === this) this.hub._calibrations[this.player] = null;
  }
}

export class InputHub {
  /**
   * @param {Object} opts
   * @param {import('../core/events.js').EventBus} [opts.bus]
   * @param {string} [opts.mode]             InputMode
   * @param {1|2} [opts.players]
   * @param {HTMLVideoElement} [opts.video]  element the camera is attached to (created if absent)
   * @param {Array<{calibration?:object|null}>} [opts.profiles]
   * @param {'auto'|'full'|'lite'} [opts.model]  'auto' (default): full, lite while the machine can't keep up (PERF-06)
   * @param {'GPU'|'CPU'} [opts.delegate]
   * @param {string} [opts.deviceId]         camera to open
   * @param {string|Blob} [opts.videoSource] play this clip as a fake camera instead of the webcam
   * @param {string} [opts.basePath]         where /models and /mediapipe live
   * @param {boolean} [opts.keyboardAssist]  camera mode: keys also work
   * @param {EventTarget} [opts.keyboardTarget]
   * @param {object} [opts.keymap]           partial keymap override
   * @param {object} [opts.recording]        Recording for replay mode
   * @param {boolean} [opts.loopReplay]
   * @param {object} [opts.tuning]           HUB_TUNING overrides
   * @param {object} [opts.gestureTuning]    passed to GestureRecognizer
   * @param {object} [opts.trackerTuning]    passed to PoseTracker (TRACKER_DEFAULTS overrides)
   * @param {'worker'|'main'|'auto'} [opts.detector]  where pose detection runs (default: ?detector= or HUB_TUNING.detector)
   * @param {boolean} [opts.autoActivity]    follow the bus (VS card, bout intro, drill start, camera check) for
   *                                         the activity / setup number of poses (default true)
   * @param {object} [opts.deps]             test overrides: {GestureRecognizer, CalibrationSession, PoseTracker,
   *                                         WorkerPoseTracker, openCamera, openVideoFile}
   */
  constructor(opts = {}) {
    this.tuning = { ...HUB_TUNING, ...(opts.tuning || {}) };
    this.bus = opts.bus || null;
    this.mode = Object.values(InputMode).includes(opts.mode) ? opts.mode : InputMode.CAMERA;
    this.players = opts.players === 2 ? 2 : 1;
    this.video = opts.video || null;
    this.profiles = [0, 1].map((i) => ({ calibration: (opts.profiles || [])[i]?.calibration || null }));
    /** The player's choice (Settings): 'auto' | 'full' | 'lite'. */
    this.modelPref = normModelPref(opts.model);
    /** The model running: 'full' | 'lite' (the auto choice, or the explicit one). */
    this.model = this.modelPref === 'lite' ? 'lite' : 'full';
    this.delegate = opts.delegate === 'CPU' ? 'CPU' : 'GPU';
    this.deviceId = opts.deviceId;
    this.videoSource = opts.videoSource || null;
    this.basePath = opts.basePath;
    this.keyboardAssist = !!opts.keyboardAssist;
    this.keyboardTarget = opts.keyboardTarget || null;
    this.gestureTuning = opts.gestureTuning;
    this.trackerTuning = opts.trackerTuning || null;
    this.deps = {
      GestureRecognizer, CalibrationSession, PoseTracker, WorkerPoseTracker, openCamera, openVideoFile,
      ...(opts.deps || {}),
    };
    // an injected PoseTracker (tests) stands in for both detectors unless a worker one is injected too
    if (opts.deps && opts.deps.PoseTracker && !opts.deps.WorkerPoseTracker) this.deps.WorkerPoseTracker = opts.deps.PoseTracker;
    /** 'worker' | 'main' — where pose detection runs (see HUB_TUNING.detector). */
    this.detector = normDetector(opts.detector) || urlDetector() || normDetector(this.tuning.detector) || 'main';

    /** Records RAW PoseFrames while recorder.recording is true. */
    this.recorder = new Recorder();
    this.keyboard = new KeyboardInput({ keymap: opts.keymap, players: this.players });
    this.assigner = new PlayerAssigner({ players: this.players });

    this._recognizers = [null, null];
    this._calibrations = [null, null];
    this._controls = [null, null];
    this._events = [[], []];
    this._present = [false, false];
    this._deb = [0, 1].map(() => ({ state: false, raw: false, since: -Infinity }));
    this._latest = null;
    this._latestRaw = null;
    this._lastFrameWall = -Infinity;
    this._lastFrameT = 0;
    this._lastStaleFeed = -Infinity;
    this._frameWalls = [];
    this._replay = opts.recording ? new ReplaySource(opts.recording, { loop: !!opts.loopReplay }) : null;
    this._inject = null;
    this._injectAssigned = false;
    this._tracker = null;
    this._cam = null;
    this._token = 0;
    this._phase = 'idle';
    this._error = null;
    this._lastNow = 0;
    this._latencies = [];
    this._latencySource = null;
    this._aspect = 0;
    this._recognizerErrorLogged = false;
    // PERF-02: activity vs setup number of poses
    this._activity = false;
    this._searching = false;
    this._crowded = false;
    this._othersSeenAt = -Infinity;
    this._poseSwitch = null;
    this._poseSwitches = 0;
    // PERF-03 / D9
    this._lastDetectMs = 0;
    // FLOWS-02: the camera stopped (ended / muted) — start() recovers keeping the player slots
    this._cameraLost = false;
    this._interrupted = false;
    this._lastCamCheck = -Infinity;
    this._devHints = new Set();
    // PERF-06: the pipeline governor (render pressure, auto model, delegate, camera rate) and its readout
    this._govAt = -Infinity;
    this._judgeAfter = -Infinity;
    this._pressure = null;
    this._starvedSince = null;      // activity, judged: starved since (model / delegate decisions)
    this._urgentSince = null;       // … and below urgentRatio since (a switch may then commit mid-activity)
    this._liteOkSince = null;       // auto on lite: full predicted to keep up since
    this._fullWaitMs = this.tuning.fullAfterMs;
    this._fullCostRatio = this.tuning.fullCostRatio;
    this._fullMsAtLite = null;      // full's median when it went lite (→ the full / lite cost ratio)
    this._renderAtFloor = null;     // the app's render quality has nothing left to give back (null: unknown)
    /** The switch in progress (one at a time): {kind, to, from, why, phase, …} (see _startSwitch). */
    this._sw = null;
    this._wish = null;
    this._swFails = new Map();
    this._modelSwitches = [];
    this._delegateSwitches = [];
    this._delegateWait = this.tuning.delegateAfterMs;
    this._delegateMoved = false;
    /** The rate a camera is opened at (a reopened camera starts there too; 60 comes back through the governor). */
    this._camFpsWanted = this.tuning.cameraFps;
    this._cam60SlowSince = null;
    this._cam60FastSince = null;
    this._cam60Wait = this.tuning.camera60RetryMs;
    this._cam60TriedAt = -Infinity;
    this._cam60RetryAt = -Infinity;
    this._cameraSwitches = [];
    this._camFpsBusy = false;
    this._curTiming = null;
    this._eventLat = [];
    // RG4: judged rates of the running landmarker per context ('round:<poses>' / 'other:<poses>'), for the delegate trials
    this._rates = new Map();
    this._rateKey = null;
    this._rateKeySince = -Infinity;
    this._ratesFrom = -Infinity;
    this._statWindowMs = 2000;
    // safe moments for a switch: no round, tutorial or drill running, or the activity paused
    this._fighting = false;
    this._paused = false;
    // a bout or drill is under way (from its intro to its result, rounds and breaks alike): lag counts for the render
    this._session = false;
    this._off = [];
    if (this.bus && typeof this.bus.on === 'function') {
      const on = (ev, fn) => { const off = this.bus.on(ev, fn); if (typeof off === 'function') this._off.push(off); };
      if (opts.autoActivity !== false) {
        on(Ev.APP_SCREEN, (p) => {
          const s = p && p.screen;
          if (s === 'opponent' || s === 'vs') this.setActivityMode(true);
          else if (s === 'camera-setup' || s === 'calibrate') this.setActivityMode(false);
        });
        on(Ev.MATCH_INTRO, () => this.setActivityMode(true));
        on(Ev.TRAIN_START, () => this.setActivityMode(true));
      }
      const fight = (v) => () => { this._fighting = v; if (v) this._paused = false; };
      const session = (v) => () => { this._session = v; };
      // a bout is live from its intro: the first-bout tutorial runs between MATCH_INTRO and round 1 (its cards are live
      // steps), and without it the intro leads straight into round 1
      on(Ev.MATCH_INTRO, fight(true));
      on(Ev.MATCH_ROUND_START, fight(true));
      on(Ev.MATCH_BELL, (p) => { if (p && p.kind === 'start') fight(true)(); });
      on(Ev.TRAIN_START, fight(true));
      for (const ev of [Ev.MATCH_ROUND_END, Ev.MATCH_KO, Ev.MATCH_RESULT, Ev.TRAIN_END]) on(ev, fight(false));
      for (const ev of [Ev.MATCH_INTRO, Ev.MATCH_ROUND_START, Ev.TRAIN_START]) on(ev, session(true));
      for (const ev of [Ev.MATCH_RESULT, Ev.TRAIN_END]) on(ev, session(false));
      on(Ev.APP_PAUSE, () => { this._paused = true; });
      on(Ev.APP_RESUME, () => { this._paused = false; });
      // A screen over an activity ends it (results, menus, a jump) — except the pause and tracking-lost cards over a paused
      // one. Any other screen while paused means the player quit from such a card: the app's quit emits neither APP_RESUME
      // nor MATCH_RESULT, so without this the menus would be judged like a bout (RG1: lag counted, starvation timers on).
      on(Ev.APP_SCREEN, (p) => {
        const s = p && p.screen;
        if (!s || (this._paused && PAUSE_SCREENS.has(s))) return;
        this._fighting = false;
        this._session = false;
        this._paused = false;
      });
    }
  }

  /**
   * A moment where a pause in detection is not felt (PERF-06): menus, between rounds, after a bout and while paused —
   * never during a round, the first-bout tutorial or a drill. Switches are built next to the running landmarker and only
   * their commit (the new landmarker's warm-up) waits for this.
   */
  get safeToSwitch() { return !this._fighting || this._paused; }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /**
   * Open the input source for the current mode. Never throws: on failure returns
   * {ok:false, error, code, help}, sets status.error and emits Ev.INPUT_ERROR.
   * @returns {Promise<{ok:boolean, error?:string, code?:string, help?:string, delegate?:string|null}>}
   */
  async start() {
    const token = ++this._token;
    // FLOWS-02: the camera stopped mid-activity and the player asks to try again → keep who is P1/P2
    const recovering = this._cameraLost && this.mode === InputMode.CAMERA;
    this._closeCamera();
    this._error = null;
    this._cameraLost = false;
    this._interrupted = false;
    this._phase = 'starting';
    this._resetTracking();
    this.keyboard.detach();
    this.keyboard.reset();

    if (this.mode === InputMode.KEYBOARD) {
      this._attachKeyboard();
      this._phase = 'running';
      return { ok: true, delegate: null };
    }
    if (this.mode === InputMode.REPLAY) {
      if (!this._replay) return this._fail(token, Object.assign(new Error('No pose recording loaded to replay.'), { code: 'no-recording', help: 'Load a recording first.' }));
      this._replay.reset();
      this.assigner.reset();
      this._resetRecognizers();
      if (this.keyboardAssist) this._attachKeyboard();
      this._phase = 'running';
      return { ok: true, delegate: null };
    }

    // camera mode: tracker (cached across retries) + camera/clip in parallel
    const trackerP = this._ensureTracker();
    trackerP.catch(() => { /* reported below */ });
    let cam = null;
    try {
      cam = this.videoSource
        ? await this.deps.openVideoFile(this.videoSource, { video: this.video || undefined })
        : await this.deps.openCamera({ deviceId: this.deviceId, video: this.video || undefined, frameRate: this._camFpsWanted,
          onEnded: (err) => this._onCameraEnded(err, cam), onInterrupted: (err) => this._onCameraInterrupted(err, cam) });
      if (token !== this._token) { cam.stop(); return { ok: false, error: 'cancelled', code: 'cancelled' }; }
      await trackerP;
      if (token !== this._token) { cam.stop(); return { ok: false, error: 'cancelled', code: 'cancelled' }; }
    } catch (e) {
      if (cam) cam.stop();
      return this._fail(token, e);
    }
    this._cam = cam;
    this.video = cam.video;
    // a reopened camera is a new source on the same <video>: re-attach the frame callback
    if (this._tracker && typeof this._tracker.rewatch === 'function') this._tracker.rewatch();
    // PERF-06: the polling fallback may detect up to the camera's own rate (60 fps cameras)
    if (this._tracker && typeof this._tracker.setCameraFps === 'function') this._tracker.setCameraFps(cam.frameRate || 30);
    this._cam60SlowSince = null;
    this._cam60FastSince = null;
    if (!recovering) this.assigner.reset();
    this._resetRecognizers();
    if (this.keyboardAssist) this._attachKeyboard();
    this._phase = 'running';
    return { ok: true, delegate: this._tracker ? this._tracker.delegate : null };
  }

  _fail(token, e) {
    if (token !== this._token) return { ok: false, error: 'cancelled', code: 'cancelled' };
    this._phase = 'error';
    this._setError(e);
    return { ok: false, error: this._error.message, code: this._error.code, help: this._error.help, title: this._error.title, source: this._error.source };
  }

  /** The tracker class for this.detector ('worker' → WorkerPoseTracker, which falls back to the main thread itself). */
  _trackerClass() {
    return this.detector === 'worker' ? (this.deps.WorkerPoseTracker || this.deps.PoseTracker) : this.deps.PoseTracker;
  }

  async _ensureTracker() {
    const want = { numPoses: this._numPoses(), model: this.model, delegate: this.delegate };
    const Ctor = this._trackerClass();
    const t = this._tracker;
    if (t && this._trackerCtor === Ctor && t.model === want.model && t.requestedDelegate === want.delegate && !t.error) {
      if (t.numPoses !== want.numPoses) await t.setNumPoses(want.numPoses);
      await t.init();
      return t;
    }
    if (t) t.close();
    const tracker = new Ctor({ ...want, ...(this.basePath ? { basePath: this.basePath } : {}),
      ...(this.trackerTuning ? { tuning: this.trackerTuning } : {}) });
    // PERF-06: the start-up slow-GPU move waits for a safe moment, made by the delegate governor (R5)
    if (this.tuning.delegateAuto && 'switchGate' in tracker) tracker.switchGate = () => this.safeToSwitch;
    this._tracker = tracker;
    this._trackerCtor = Ctor;
    this._resetRates();
    try {
      await tracker.init();
    } catch (e) {
      if (this._tracker === tracker) this._tracker = null;
      throw e;
    }
    return tracker;
  }

  /**
   * People MediaPipe looks for (PERF-02): players + extraPoses on setup screens, while a player is
   * missing during an activity, or when others were seen; players + activityExtraPoses otherwise.
   */
  _numPoses() {
    const T = this.tuning;
    const extra = this._activity && !this._searching && !this._crowded ? T.activityExtraPoses : T.extraPoses;
    return Math.max(1, Math.min(T.maxPoses, this.players + Math.max(0, extra)));
  }

  /**
   * Tell a running tracker the current number of poses (no-op when unchanged). MediaPipe restarts its
   * graph: no pose arrives for ≈240 ms (longer on slow machines), which must not read as a frozen
   * camera — _checkStale waits for the first frame after the switch (at most poseSwitchGraceMs).
   */
  _applyNumPoses() {
    const t = this._tracker;
    if (!t || typeof t.setNumPoses !== 'function') return;
    const n = this._numPoses();
    if (t.numPoses === n) return;
    const sw = { since: this._lastNow, settled: false };
    this._poseSwitch = sw;
    this._poseSwitches++;
    const settle = () => { sw.settled = true; };
    const p = t.setNumPoses(n);
    if (p && typeof p.then === 'function') p.then(settle, settle); else settle();
  }

  /** A numPoses switch is under way (until the first frame after it, or poseSwitchGraceMs). */
  _poseSwitchActive(nowMs) {
    const sw = this._poseSwitch;
    if (!sw) return false;
    if (nowMs - sw.since > (sw.graceMs ?? this.tuning.poseSwitchGraceMs)) { this._poseSwitch = null; return false; }
    return true;
  }

  /**
   * Activity (true: bout, drill, tutorial — from the VS card / intro on) or setup (false: camera check,
   * calibration). Activities track `players` people, setup `players + extraPoses` (PERF-02). Call it
   * where a ≈240 ms detection stall is not seen (behind the black before the VS card, the VS card).
   */
  setActivityMode(on) {
    const v = !!on;
    if (v === this._activity) return;
    this._activity = v;
    // a player not found yet: keep looking with the extra pose (no switch now and another one at once)
    this._searching = v && this.mode === InputMode.CAMERA && this._deb.slice(0, this.players).some((d) => !d.state);
    // somebody else (a bystander, a poster) was in the picture just now: keep telling them apart
    this._crowded = v && this._lastNow - this._othersSeenAt <= this.tuning.othersMemoryMs;
    this._applyNumPoses();
  }

  /** @returns {boolean} activity (true) or setup (false) number of poses */
  get activityMode() { return this._activity; }

  /** During an activity: look for a missing player with the extra pose, drop it again once everyone is back. */
  _updateSearch() {
    if (!this._activity || this.mode !== InputMode.CAMERA) return;
    let lost = false;
    for (let i = 0; i < this.players; i++) if (!this._deb[i].state) lost = true;
    if (lost && !this._searching) {
      this._searching = true;
      this._applyNumPoses();
    } else if (!lost && this._searching && !this._crowded) {
      this._searching = false;
      this._applyNumPoses();
    }
  }

  /** Switch where detection runs ('worker' | 'main'); restarts the tracker when the camera runs. */
  async setDetector(kind) {
    const d = normDetector(kind);
    if (!d || d === this.detector) return { ok: true };
    this.detector = d;
    if (this.mode !== InputMode.CAMERA || this._phase !== 'running') return { ok: true };
    try {
      await this._ensureTracker();
      if (this._tracker && typeof this._tracker.rewatch === 'function') this._tracker.rewatch();
      return { ok: true };
    } catch (e) { this._setError(e); this._phase = 'error'; return { ok: false, error: this._error.message }; }
  }

  _closeCamera() {
    if (this._cam) { try { this._cam.stop(); } catch { /* ignore */ } }
    this._cam = null;
  }

  /** Release camera, tracker and keyboard listeners. The recorder keeps its take. */
  stop() {
    this._token++;
    this._closeCamera();
    this._sw = null;
    this._wish = null;
    if (this._tracker) { this._tracker.close(); this._tracker = null; }
    this.keyboard.detach();
    this._inject = null;
    this._phase = 'stopped';
    this._cameraLost = false;
    this._interrupted = false;
    this._lastDetectMs = 0;
    this._resetTracking();
  }

  /** stop() and drop the bus subscriptions (the hub can't be used afterwards). */
  dispose() {
    this.stop();
    for (const off of this._off.splice(0)) { try { off(); } catch { /* ignore */ } }
  }

  _attachKeyboard() {
    const target = this.keyboardTarget || (typeof window !== 'undefined' ? window : null);
    if (target) this.keyboard.attach(target);
  }

  /** The camera track ended (unplugged, taken by another app, stopped elsewhere). */
  _onCameraEnded(err, cam) {
    if (cam && this._cam && cam !== this._cam) return; // an old camera
    if (this._phase === 'stopped' || this._phase === 'idle') return;
    this._cameraLost = true;
    this._interrupted = false;
    this._setError(err);
    this._phase = 'error';
  }

  /** The track stopped delivering frames for a while (err) or delivers them again (null). */
  _onCameraInterrupted(err, cam) {
    if (cam && this._cam && cam !== this._cam) return;
    if (err) {
      if (this._phase !== 'running') return;
      this._cameraLost = true;
      this._interrupted = true;
      this._setError(err);
      this._phase = 'error';
    } else if (this._interrupted && this._phase === 'error') {
      // the same stream recovered by itself: carry on (tracking is found again as frames arrive)
      this._interrupted = false;
      this._cameraLost = false;
      this._error = null;
      this._phase = 'running';
    }
  }

  _setError(e) {
    const message = (e && e.message) || String(e);
    const code = (e && e.code) || 'unknown';
    const source = (e && e.source) || (e && e.name === 'TrackerError' ? 'tracker' : e && e.name === 'CameraError' ? 'camera' : 'unknown');
    const title = (e && e.title) || '';
    this._error = { message, help: (e && e.help) || '', code, title, source, cause: e };
    // the developer's remedy (e.g. "npm run setup:models") goes to the console, once
    if (e && e.devHint && !this._devHints.has(e.devHint)) {
      this._devHints.add(e.devHint);
      console.warn(`[input] ${message} ${e.devHint}`);
    }
    if (this.bus) this.bus.emit(Ev.INPUT_ERROR, { message, help: this._error.help, code, title, source, cause: e });
  }

  // ───────────────────────────── configuration ─────────────────────────────

  /** Switch input mode; restarts sources if the hub was running. @returns {Promise<object>} */
  async setMode(mode) {
    if (!Object.values(InputMode).includes(mode) || mode === this.mode) return { ok: true };
    const wasActive = this._phase === 'running' || this._phase === 'starting' || this._phase === 'error';
    this.stop();
    this.mode = mode;
    return wasActive ? this.start() : { ok: true };
  }

  setPlayers(n) {
    const p = n === 2 ? 2 : 1;
    if (p === this.players) return;
    this.players = p;
    this.assigner.setPlayers(p);
    this.keyboard.setPlayers(p);
    this._applyNumPoses();
    for (let i = p; i < 2; i++) {
      this._deb[i] = { state: false, raw: false, since: -Infinity };
      this._present[i] = false;
      this._events[i] = [];
    }
  }

  setCalibration(i, cal) {
    this.profiles[i].calibration = cal || null;
    const r = this._recognizers[i];
    if (r && typeof r.setCalibration === 'function') r.setCalibration(cal || null);
  }

  /** Replace both profiles ({calibration}; every boxer is orthodox — there is no stance any more). */
  setProfiles(profiles = []) {
    for (let i = 0; i < 2; i++) {
      const p = profiles[i] || {};
      this.profiles[i] = { calibration: p.calibration || null };
      this._recognizers[i] = null;
    }
  }

  /**
   * Merge GestureRecognizer tuning for both players (e.g. {sensitivity: 0.7} from Settings).
   * Applied live; also used for recognizers created later.
   */
  setGestureTuning(partial = {}) {
    this.gestureTuning = { ...(this.gestureTuning || {}), ...partial };
    for (const r of this._recognizers) {
      if (r && typeof r.setTuning === 'function') r.setTuning(partial);
    }
    if (this._recognizers.some((r) => r && typeof r.setTuning !== 'function')) this._recognizers = [null, null];
  }

  /** Trade poster/bystander robustness for speed on setup screens: detect players + n people (0..2). */
  setExtraPoses(n) {
    this.tuning = { ...this.tuning, extraPoses: Math.max(0, Math.min(2, Math.round(Number(n) || 0))) };
    this._applyNumPoses();
  }

  /** Settings slider convenience: gesture sensitivity 0..1. */
  setSensitivity(s) { this.setGestureTuning({ sensitivity: s }); }

  setKeyboardAssist(on) {
    this.keyboardAssist = !!on;
    if (this.mode === InputMode.KEYBOARD) return;
    if (this.keyboardAssist && this._phase === 'running') this._attachKeyboard();
    else this.keyboard.detach();
  }

  /**
   * The player's model choice ('auto' | 'full' | 'lite', Settings → Tracking). An explicit model takes effect
   * immediately in camera mode (the Settings screen is a safe moment) and the hub never changes it; 'auto' keeps
   * the running model and lets the governor choose from now on (PERF-06).
   */
  async setModel(model) {
    const pref = normModelPref(model);
    this.modelPref = pref;
    if (this._sw && this._sw.kind === 'model') this._dropSwitch('settings');
    if (pref === 'auto') { this._fullWaitMs = this.tuning.fullAfterMs; return { ok: true }; }
    if (pref === this.model) return { ok: true };
    this.model = pref;
    if (this.mode !== InputMode.CAMERA || this._phase !== 'running') return { ok: true };
    const t = this._tracker;
    // a running tracker swaps the model in place (no new worker); anything else is rebuilt
    if (t && t.ready && !t.error && this._trackerCtor === this._trackerClass() && typeof t.setModel === 'function') {
      if (this._sw) this._dropSwitch('settings');
      const grace = this._grace();
      try {
        await t.setModel(pref);
        this._noteSwitch('model', { from: pref === 'lite' ? 'full' : 'lite', to: pref, why: 'settings', ok: true });
        this._resetRates();
        return { ok: true };
      } catch (e) {
        console.warn(`[input] the ${pref} pose model could not start: ${(e && e.message) || e}`);
        if (this._tracker === t && !t.error) { this.model = t.model === 'lite' ? 'lite' : 'full'; return { ok: false, error: (e && e.message) || String(e) }; }
      } finally {
        grace.settled = true;
        this._resetGovernorTimers();
      }
      this.model = pref; // rebuild the tracker with the chosen model
    }
    try { await this._ensureTracker(); return { ok: true }; } catch (e) { this._setError(e); this._phase = 'error'; return { ok: false, error: this._error.message }; }
  }

  /** Use another webcam (restarts the camera if running). */
  async setCamera(deviceId) {
    this.deviceId = deviceId || undefined;
    this.videoSource = null;
    if (this.mode === InputMode.CAMERA && this._phase !== 'idle' && this._phase !== 'stopped') return this.start();
    return { ok: true };
  }

  /** Play a clip (URL/File) as the camera; null returns to the webcam. */
  async setVideoSource(src) {
    this.videoSource = src || null;
    if (this.mode === InputMode.CAMERA && this._phase !== 'idle' && this._phase !== 'stopped') return this.start();
    return { ok: true };
  }

  /** Load a Recording and switch to replay mode (starts immediately). */
  async replay(recording, { loop = true, speed = 1 } = {}) {
    this._replay = new ReplaySource(recording, { loop, speed });
    if (this.mode !== InputMode.REPLAY) { this.stop(); this.mode = InputMode.REPLAY; }
    return this.start();
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /**
   * Advance input to `nowMs`.
   * @param {number} [nowMs]
   * @returns {{players: import('../core/types.js').PlayerInput[], status: object}}
   */
  update(nowMs = nowMs_()) {
    this._lastNow = nowMs;
    this._lastDetectMs = 0;
    const running = this._phase === 'running';
    if (running && this.mode === InputMode.CAMERA && this._tracker && this.video) {
      const tracker = this._tracker;
      const t0 = nowMs_();
      const frame = tracker.detect(this.video, nowMs);
      // PERF-06: every pose finished since the last update, oldest first, each with its own capture time
      const more = frame && typeof tracker.takeFrames === 'function' ? tracker.takeFrames(nowMs) : null;
      const spent = nowMs_() - t0;
      const worked = typeof tracker.lastCallWorked === 'boolean' ? tracker.lastCallWorked : !!frame;
      this._lastDetectMs = worked ? spent : 0;
      if (frame && this._poseSwitch && this._poseSwitch.settled) {
        // first frame after a switch: the pipeline figures start over (the restart gap is not slowness, PERF-06)
        this._poseSwitch = null;
        this._settleJudgement(nowMs);
      }
      if (frame) this._process(frame, false, nowMs);
      if (more) for (const f of more) this._process(f, false, nowMs);
      if (tracker.error && (!this._error || this._error.cause !== tracker.error)) { this._setError(tracker.error); this._phase = 'error'; }
      else this._checkCamera(nowMs);
      this._govern(nowMs);
    } else if (running && this.mode === InputMode.REPLAY && this._replay) {
      for (const f of this._replay.next(nowMs)) this._process(f, false, nowMs);
    }
    if (this._inject) {
      for (const f of this._inject.next(nowMs)) this._process(f, this._injectAssigned, nowMs);
      if (this._inject.done) this._inject = null;
    }
    this._checkStale(nowMs);

    const players = [];
    for (let i = 0; i < this.players; i++) {
      let control, events, raw;
      if (this.mode === InputMode.KEYBOARD) {
        ({ control, events } = this.keyboard.update(nowMs, i));
        for (const ev of events) this._emitPunch(i, ev);
        raw = this._phase === 'running';
      } else {
        control = this._controls[i] || neutralControl({ tracked: false });
        events = this._events[i];
        this._events[i] = [];
        if (this.keyboardAssist && this.keyboard.attached) ({ control, events } = this._assist(i, control, events, nowMs));
        raw = this._present[i] && control.tracked !== false;
      }
      this._debounce(i, raw, nowMs, this.mode === InputMode.KEYBOARD);
      players.push({ control, events });
    }
    if (this._activity) this._updateSearch();
    return { players, status: this.status };
  }

  /**
   * Main-thread milliseconds the last update() spent on pose detection (0 if none ran): the whole
   * inference with the 'main' detector, only picking up the result with the 'worker' one (PERF-03, D9).
   */
  get lastDetectMs() { return this._lastDetectMs; }

  // ───────────────────────────── PERF-06: pipeline governor ─────────────────────────────

  /**
   * Is pose detection keeping up? {behind, rateBehind, starved, headroom, gpu, judged, activity, detFps, camFps, wantFps,
   * detMs, at}, or null when no camera detection runs (keyboard, replay, stopped, an error). For the renderer's adaptive
   * quality: while a GPU detector is behind, the render gives GPU time back (any step while the RATE is behind; for lag
   * alone only the frame cap and the pixel ratio, render/adaptive.js); it takes more only with headroom.
   */
  get renderPressure() {
    if (this.mode !== InputMode.CAMERA) return null;
    // the camera and the pose detector are starting: the worker builds its graph and runs its first inference on a GPU the
    // render shares — no figures yet, but a fast display should leave it room (render/adaptive.js: the start-up frame cap)
    if (this._phase === 'starting') return { ...STARTING_PRESSURE, session: this._session };
    const p = this._pressure;
    if (!p || this._phase !== 'running') return null;
    return p;
  }

  /**
   * The app's render quality, every frame (PERF-06): {atFloor} — nothing left to give back (or a fixed quality); null when
   * unknown. The auto model waits for the render's steps before it trades tracking accuracy for speed.
   */
  setRenderState(st) { this._renderAtFloor = st && typeof st.atFloor === 'boolean' ? st.atFloor : null; }

  /** Judge the detection pipeline (every governorMs), then steer the switches and the camera rate. */
  _govern(now) {
    if (now - this._govAt < this.tuning.governorMs && now >= this._govAt) return;
    this._govAt = now;
    const t = this._tracker;
    if (!t || typeof t.pipelineStats !== 'function') { this._pressure = null; return; }
    const T = this.tuning;
    const s = t.pipelineStats(now);
    const activity = (Number(t.numPoses) || 1) <= this.players;
    const want = Math.max(1, Math.min(this._cameraRate(s), T.targetDetectFps));
    const p50 = s.detMs ? s.detMs.p50 : null;
    // enough to go on: minJudgedFrames poses, or a whole window watched (a detector at a few poses per second is behind)
    const watched = s.frames >= T.minJudgedFrames || (s.ageMs >= 0.9 * (s.windowMs || 2000) && s.ageMs >= 1500 && s.camFps >= 5);
    const sw = this._sw;
    const busy = !!(sw && (sw.phase === 'committing' || sw.phase === 'reverting'));
    const judged = watched && now >= this._judgeAfter && !busy && !this._poseSwitchActive(now);
    // lag (a slow median at the full rate) only counts in a bout / drill: menus and the camera check judge the rate alone
    const bout = activity && this._session;
    const rateBehind = judged && s.detFps < T.behindRatio * want;
    const lagBehind = judged && bout && p50 !== null && p50 > T.behindDetectMs;
    const behind = rateBehind || lagBehind;
    const starved = judged && s.detFps < T.starvedRatio * want;
    const headroom = judged && !behind && s.detFps >= 0.97 * want && p50 !== null
      && p50 <= (bout ? T.headroomDetectMs : T.headroomDetectMsSetup);
    this._pressure = { behind, rateBehind, starved, headroom, gpu: t.delegate === 'GPU', judged, activity, session: this._session, detFps: s.detFps, camFps: s.camFps, wantFps: want, detMs: p50, at: now };
    // starvation that moves the model / delegate: in a bout or drill (players' poses only)
    if (judged && bout && starved) { if (this._starvedSince === null) this._starvedSince = now; }
    else if (judged) this._starvedSince = null;
    if (judged && bout && s.detFps < T.urgentRatio * want) { if (this._urgentSince === null) this._urgentSince = now; }
    else if (judged) this._urgentSince = null;
    // lite's first judged median after the switch: how much cheaper it is than full here (→ when full can come back)
    if (judged && bout && this.model === 'lite' && this._fullMsAtLite > 0 && p50 > 0) {
      this._fullCostRatio = Math.min(T.fullCostRatioMax, Math.max(T.fullCostRatioMin, this._fullMsAtLite / p50));
      this._fullMsAtLite = null;
    }
    this._noteRate(now, s, judged);
    if (this.mode === InputMode.CAMERA && this._phase === 'running') {
      this._advanceSwitch(now, s, judged);
      if (!this._sw) this._decideSwitch(now, s, judged, bout, starved, want, p50);
    }
    this._governCamera(now, s, bout, judged);
  }

  /**
   * What to switch, if anything (PERF-06; one switch at a time, started at a safe moment):
   *  1. the start-up slow-GPU verdict the tracker left to the hub (RV-PERF-02) → a CPU trial, unless the render's steps
   *     have freed the GPU meanwhile;
   *  2. model 'auto': full → lite once detection stayed starved (starvedRatio) for liteAfterMs in an activity with the render
   *     at its floor (liteMaxWaitMs at most); lite → full once full is predicted to keep up for fullAfterMs;
   *  3. the delegate: still starved after delegateWait (lite first with the auto model) → a trial of the other delegate.
   * A wish that no longer holds is simply not made again (status.pipeline.pendingModel / pendingDelegate show the live one).
   */
  _decideSwitch(now, s, judged, bout, starved, want, p50) {
    const T = this.tuning;
    const t = this._tracker;
    this._wish = null;
    if (!t) return;
    if (t.slowGpu && t.delegate === 'GPU') {
      const slowMs = (t.tuning && t.tuning.slowGpuMs) || 90;
      if (judged && p50 !== null && p50 <= slowMs) t.slowGpu = null; // the render gave the GPU its time back
      else { this._want('delegate', 'CPU', 'slow-gpu', now); return; }
    }
    // a switch given up for this session (a missing model file, repeated failures) is not wished for again
    const gone = (key) => (this._swFails.get(key) || {}).permanent === true;
    if (this.modelPref === 'auto' && !gone(this.model === 'full' ? 'model:lite' : 'model:full')) {
      if (this.model === 'full') {
        const since = this._starvedSince;
        const floor = this._renderAtFloor !== false || t.delegate !== 'GPU';
        if (since !== null && ((floor && now - since >= T.liteAfterMs) || now - since >= T.liteMaxWaitMs)) { this._want('model', 'lite', 'starved', now); return; }
      } else {
        const predicted = p50 !== null ? p50 * this._fullCostRatio : null;
        const ok = judged && bout && !starved && predicted !== null && predicted <= T.fullKeepsUpRatio * (1000 / want);
        if (ok) { if (this._liteOkSince === null) this._liteOkSince = now; }
        else if (judged) this._liteOkSince = null;
        if (this._liteOkSince !== null && now - this._liteOkSince >= this._fullWaitMs) { this._want('model', 'full', 'headroom', now); return; }
      }
    }
    if (T.delegateAuto && typeof t.setDelegate === 'function' && this._starvedSince !== null && now - this._starvedSince >= this._delegateWait) {
      const to = t.delegate === 'GPU' ? 'CPU' : 'GPU';
      // never a GPU the browser can't use; with the auto model, lite comes first (cheaper, and the delegate stays)
      const gpuUsable = to === 'CPU' || this._delegateMoved || /^GPU too slow/.test(t.fallbackReason || '');
      // (unless lite can't run here: a missing model file, or given up after failures)
      const liteFirst = this.modelPref === 'auto' && this.model === 'full' && !gone('model:lite');
      if (gpuUsable && !liteFirst && !gone(`delegate:${to}`)) this._want('delegate', to, 'starved', now);
    }
  }

  /**
   * A switch is wanted: start it if it may run now (not backing off after failures) and the moment is safe — or, for a
   * tracker that switches in two phases, when detection is urgently starved (urgentAfterMs below urgentRatio).
   */
  _want(kind, to, why, now) {
    this._wish = { kind, to, why };
    const t = this._tracker;
    if (!this._switchAllowed(`${kind}:${to}`, now) || (t && t.canPrepare === false)) return; // backing off / busy tracker
    if (!this.safeToSwitch && !(this._urgent(now) && this._gapless(t))) return;
    this._startSwitch(kind, to, why, now);
  }

  /** Detection has been below urgentRatio × the wanted rate for urgentAfterMs in an activity (see HUB_TUNING.urgentRatio). */
  _urgent(now) { return this._urgentSince !== null && now - this._urgentSince >= this.tuning.urgentAfterMs; }

  /** 'worker' | 'main': where this tracker detects right now (a worker tracker says 'main' after its fallback). */
  _detectsOn(t) { return t ? (typeof t.detector === 'string' ? t.detector : t.kind) || null : null; }

  /**
   * Does a switch on this tracker cost the render nothing (RG3)? The worker swap builds, warms up and primes the new
   * landmarker in a second worker and the commit only sends the next frame there. Main-thread detection (?detector=main, or
   * the worker's fallback under load) runs the new landmarker's warm-up inference on the page's own thread at the commit —
   * measured at idle, a 65–193 ms frozen frame — so its switches wait for safe moments even when detection is urgently
   * starved (going back from a trial stays immediate: no warm-up).
   */
  _gapless(t) {
    return !!t && typeof t.prepareSwitch === 'function' && typeof t.commitSwitch === 'function' && this._detectsOn(t) !== 'main';
  }

  /** Not backing off after failures of this switch (R8: a missing model file is never tried again this session). */
  _switchAllowed(key, now) {
    const f = this._swFails.get(key);
    return !f || (!f.permanent && now >= f.until);
  }

  /**
   * Start a switch (PERF-06). Two-phase where the tracker can (prepareSwitch → commitSwitch): the new landmarker is built
   * next to the running one, which keeps detecting; only the commit — the new landmarker's warm-up — pauses detection,
   * and it waits for a safe moment. A delegate trial and full on probation keep the old landmarker loaded, so going back
   * is immediate (no build, no warm-up) even mid-round. Trackers without it switch in one blocking step at a safe moment.
   */
  _startSwitch(kind, to, why, now) {
    const t = this._tracker;
    const from = kind === 'model' ? this.model : t.delegate;
    const entry = this._noteSwitch(kind, { from, to, why, ok: null });
    const sw = {
      kind, to, from, why, key: `${kind}:${to}`, entry, tracker: t, phase: 'preparing', at: now,
      trial: kind === 'delegate', probation: kind === 'model' && to === 'full', beforeFps: null, beforeMs: null, committedAt: null,
      two: typeof t.prepareSwitch === 'function' && typeof t.commitSwitch === 'function',
      detector: this._detectsOn(t), before: null,
    };
    this._sw = sw;
    this._wish = null;
    if (!this.safeToSwitch) { sw.urgent = true; entry.urgent = true; }
    if (!sw.two) { this._commitSwitch(sw); return; }
    Promise.resolve().then(() => t.prepareSwitch(kind === 'model' ? { model: to } : { delegate: to })).then((v) => {
      if (this._sw !== sw) { Promise.resolve(t.discardSwitch && t.discardSwitch({ kept: false })).catch(() => {}); return; }
      entry.buildMs = v && Number.isFinite(v.buildMs) ? Math.round(v.buildMs) : null;
      sw.phase = 'ready';
    }, (e) => { if (this._sw === sw) this._switchFailed(sw, e); });
  }

  /** Move the switch in progress along: commit when ready and safe; judge a trial / a probation; drop a stale one. */
  _advanceSwitch(now, s, judged) {
    const sw = this._sw;
    if (!sw) return;
    const T = this.tuning;
    const t = this._tracker;
    if (!t || sw.tracker !== t) { this._sw = null; return; } // the tracker was rebuilt (camera retry, detector change)
    // the worker gave way to main-thread detection meanwhile: whatever the switch prepared or kept went with the worker
    if (sw.two && sw.detector && this._detectsOn(t) !== sw.detector && sw.phase !== 'committing' && sw.phase !== 'reverting') {
      this._dropSwitch('detection moved to the main thread');
      return;
    }
    switch (sw.phase) {
      case 'preparing':
        if (now - sw.at > T.switchPrepareMaxMs) {
          this._switchFailed(sw, new Error(`not ready after ${Math.round(T.switchPrepareMaxMs / 1000)} s`));
          Promise.resolve(t.discardSwitch && t.discardSwitch({ kept: false })).catch(() => {});
        }
        return;
      case 'ready':
        if (!this._stillWanted(sw, judged, s)) { this._dropSwitch('no longer needed'); return; }
        // mid-activity only when urgent, never full's return (that waits for a calm moment), and only if gapless (RG3)
        if (this.safeToSwitch || (this._urgent(now) && sw.kind + sw.to !== 'modelfull' && this._gapless(t))) {
          if (!this.safeToSwitch) { sw.urgent = true; sw.entry.urgent = true; }
          this._commitSwitch(sw);
        }
        return;
      case 'trial': {
        if (!judged) return;
        // RG4: the trial's rate against the old landmarker's in the same context (a round or not, the same pose budget)
        const v = this._trialVerdict(sw, now);
        if (!v) return;
        const kept = v.kept;
        sw.entry.kept = kept;
        sw.entry.after = Math.round(v.after * 10) / 10;
        sw.entry.before = Math.round(v.before * 10) / 10;
        sw.entry.judgedIn = v.ctx;
        if (v.cross) sw.entry.crossContext = true;
        if (v.early) sw.entry.early = true;
        if (kept) {
          this._delegateWait = Math.max(this._delegateWait, T.delegateKeptMs);
          this._delegateMoved = true;
          this._finishSwitch(sw, { kept: true });
        } else {
          this._delegateWait = Math.min(T.delegateRetryMaxMs, this._delegateWait * 2);
          // RG4-SIDE (merge-refix): mid-round, a lost trial that is not clearly worse than the old landmarker (within the
          // delegateGain band) goes back at the next safe moment — no delegate change mid-exchange for nothing; a clearly
          // worse one goes back at once (the old one stays loaded: gapless in the worker)
          if (!this.safeToSwitch && v.after >= v.before / T.delegateGain) { sw.phase = 'revert-wait'; sw.entry.revertAt = 'safe'; }
          else this._revertSwitch(sw);
        }
        return;
      }
      case 'probation':
        // full is back after lite: starved again → lite at once (it is still loaded), and the next try waits twice as long
        if (this._starvedSince !== null && now - this._starvedSince >= T.liteAfterMs) {
          this._fullWaitMs = Math.min(T.fullRetryMaxMs, this._fullWaitMs * 2);
          sw.entry.kept = false;
          this._revertSwitch(sw);
        } else if (now - sw.committedAt >= T.fullProbationMs) {
          sw.entry.kept = true;
          this._finishSwitch(sw, { kept: true });
        }
        return;
      default:
        // committing / reverting run on their own; a blocking (one-step) revert, or a lost trial that was not clearly worse,
        // waits for a safe moment (urgent starvation meanwhile: the kept landmarker at once, if that can be done gaplessly)
        if (sw.phase === 'revert-wait' && (this.safeToSwitch || (this._urgent(now) && sw.two))) this._revertSwitch(sw);
    }
  }

  /** RG4: where a rate is measured — in a round (fighting, not paused) or not — and with how many poses. */
  _rateContext() {
    const t = this._tracker;
    return `${this._fighting && !this._paused ? 'round' : 'other'}:${(t && Number(t.numPoses)) || 1}`;
  }

  /**
   * RG4: one judged rate sample of the running landmarker in the current context. The tracker's figures cover its last window
   * (≈ 2 s), so none is taken for one window after a context change or a new landmarker (they would mix the two).
   */
  _noteRate(now, s, judged) {
    const key = this._rateContext();
    if (key !== this._rateKey) { this._rateKey = key; this._rateKeySince = now; }
    if (Number.isFinite(s.windowMs) && s.windowMs > 0) this._statWindowMs = s.windowMs;
    if (!judged || !Number.isFinite(s.detFps)) return;
    if (now - this._rateKeySince < this._statWindowMs || now < this._ratesFrom) return;
    let a = this._rates.get(key);
    if (!a) this._rates.set(key, (a = []));
    a.push(s.detFps);
    if (a.length > RATE_SAMPLES) a.shift();
  }

  /** Another landmarker detects from now on (a switch, a revert, a new tracker): its rates start over (RG4). */
  _resetRates(now = this._lastNow) {
    this._rates = new Map();
    this._ratesFrom = (Number.isFinite(now) ? now : 0) + this._statWindowMs;
  }

  /**
   * RG4: a delegate trial's verdict, like with like (HUB_TUNING.delegateBaselineMs / delegateTrialMaxMs), or null while it
   * cannot be judged yet. {kept, after, before, ctx, cross?}
   */
  _trialVerdict(sw, now) {
    const T = this.tuning;
    const per = Math.max(1, T.governorMs);
    // delegateTrialMs into the context: one tracker window skipped, then the samples
    const need = Math.max(4, Math.round((T.delegateTrialMs - this._statWindowMs) / per));
    const base = Math.max(1, Math.round(T.delegateBaselineMs / per));
    const before = sw.before instanceof Map ? sw.before : new Map();
    // starvation is judged in rounds: a trial whose old landmarker was measured in a round is judged only in a round
    const roundOnly = [...before].some(([k, a]) => k.startsWith('round:') && a.length >= base);
    for (const [k, a] of this._rates) {
      if (a.length < need || (roundOnly && !k.startsWith('round:'))) continue;
      const b = before.get(k);
      if (!b || b.length < base) continue;
      const after = median(a.slice(-need)), was = median(b);
      return { kept: after >= was * T.delegateGain, after, before: was, ctx: k };
    }
    // RG4-SIDE (merge-refix): a trial judged in rounds that cannot win there is lost already between rounds. A round's rate is
    // no higher than the rate between rounds (the render and the main thread are busier: GPU 16 in a round vs 22 between them in
    // the pipe verifier's case), so a trial whose rate between rounds stays under the bar — delegateGain × the old landmarker's
    // in-round rate, same pose budget — goes back at this safe moment instead of early in the next round.
    if (roundOnly && this.safeToSwitch) {
      for (const [k, a] of this._rates) {
        if (!k.startsWith('other:') || a.length < need) continue;
        const b = before.get(`round:${k.slice(6)}`);
        if (!b || b.length < base) continue;
        const after = median(a.slice(-need)), was = median(b);
        if (after < was * T.delegateGain) return { kept: false, after, before: was, ctx: k, early: true };
      }
    }
    if (!(now - sw.committedAt >= T.delegateTrialMaxMs)) return null;
    // the last resort (the player left the activity): the most-sampled context against everything the old one measured
    let best = null;
    for (const [k, a] of this._rates) if (a.length && (!best || a.length > best[1].length)) best = [k, a];
    const pooled = [].concat(...before.values());
    const was = pooled.length ? median(pooled) : (sw.beforeFps || 0);
    const after = best ? median(best[1]) : 0;
    return { kept: !!best && after >= was * T.delegateGain, after, before: was, ctx: best ? best[0] : null, cross: true };
  }

  /** Does a prepared switch still make sense at the safe moment? (Undecidable right now → keep it.) */
  _stillWanted(sw, judged, s) {
    const t = this._tracker;
    if (!judged) return true;
    if (sw.kind === 'model') {
      if (this.modelPref !== 'auto' || this.model === sw.to) return false;
      return sw.to === 'lite' ? this._starvedSince !== null : this._liteOkSince !== null;
    }
    if (t.delegate === sw.to) return false;
    if (sw.why === 'slow-gpu') {
      const p50 = s.detMs ? s.detMs.p50 : null;
      return !(p50 !== null && p50 <= ((t.tuning && t.tuning.slowGpuMs) || 90));
    }
    return this._starvedSince !== null;
  }

  _commitSwitch(sw) {
    const t = sw.tracker;
    const T = this.tuning;
    sw.phase = 'committing';
    const pr = this._pressure;
    if (pr && pr.judged) { sw.beforeFps = pr.detFps; sw.beforeMs = pr.detMs; }
    // RG4: the old landmarker's judged rates per context, for the trial's like-for-like verdict; the starvation that asked
    // for a CPU trial is the in-round rate (between rounds the render is lighter)
    sw.before = this._rates;
    const inRound = this._rates.get(`round:${(Number(t.numPoses) || 1)}`);
    if (sw.trial && inRound && inRound.length) sw.beforeFps = median(inRound);
    const grace = this._grace();
    const keep = sw.trial || sw.probation;
    const reason = sw.kind === 'delegate' && sw.to === 'CPU' && sw.why !== 'slow-gpu'
      ? `GPU starved (${Math.round(sw.beforeFps || 0)} poses/s) — trying the CPU` : null;
    const t0 = nowMs_();
    const run = sw.two
      ? Promise.resolve().then(() => t.commitSwitch({ keep, reason }))
      : Promise.resolve().then(() => (sw.kind === 'model' ? t.setModel(sw.to) : t.setDelegate(sw.to)));
    run.then((v) => {
      if (sw.kind === 'model' && this._tracker === t) this.model = t.model === 'lite' ? 'lite' : 'full';
      if (this._tracker === t) this._resetRates(this._lastNow); // another landmarker detects now (RG4)
      if (this._sw !== sw) return;
      sw.entry.ok = true;
      sw.entry.warmMs = v && Number.isFinite(v.warmMs) ? Math.round(v.warmMs) : Math.round(nowMs_() - t0);
      sw.committedAt = this._lastNow;
      if (sw.kind === 'model') {
        this.model = sw.to;
        if (sw.to === 'lite') this._fullMsAtLite = sw.beforeMs;
      }
      if (sw.kind === 'delegate' && sw.why === 'slow-gpu' && t.slowGpu) t.slowGpu = null;
      if (sw.trial) sw.phase = 'trial';
      else if (sw.probation) sw.phase = 'probation';
      else this._finishSwitch(sw, {});
    }, (e) => { if (this._sw === sw) this._switchFailed(sw, e); })
      .finally(() => { grace.settled = true; this._resetGovernorTimers(); });
    void T;
  }

  /** Back to the landmarker the trial / probation kept (two-phase: at once; one-step trackers: at a safe moment). */
  _revertSwitch(sw) {
    const t = sw.tracker;
    if (!sw.two && !this.safeToSwitch) { sw.phase = 'revert-wait'; return; }
    sw.phase = 'reverting';
    sw.entry.reverted = true;
    const grace = this._grace();
    const run = sw.two
      ? Promise.resolve().then(() => t.revertSwitch())
      : Promise.resolve().then(() => (sw.kind === 'model' ? t.setModel(sw.from) : t.setDelegate(sw.from)));
    run.then(() => {
      if (sw.kind === 'model' && this._tracker === t) this.model = t.model === 'lite' ? 'lite' : 'full';
      if (this._tracker === t) this._resetRates(this._lastNow);
      this._finishSwitch(sw, {});
    }, (e) => {
      console.warn(`[input] pose detection could not go back to the ${sw.from}: ${(e && e.message) || e}`);
      this._finishSwitch(sw, {});
    }).finally(() => { grace.settled = true; this._resetGovernorTimers(); });
  }

  /** The switch is over. kept: drop the landmarker it kept loaded (the new one won). */
  _finishSwitch(sw, { kept = false } = {}) {
    if (this._sw === sw) this._sw = null;
    if (sw.entry.ok) this._swFails.delete(sw.key);
    if (kept && sw.two && sw.tracker && typeof sw.tracker.discardSwitch === 'function') {
      Promise.resolve(sw.tracker.discardSwitch({ prepared: false, kept: true })).catch(() => {});
    }
  }

  /** Cancel the switch in progress (Settings, no longer needed); whatever it prepared or kept is dropped. */
  _dropSwitch(why) {
    const sw = this._sw;
    if (!sw || sw.phase === 'committing' || sw.phase === 'reverting') return;
    this._sw = null;
    if (sw.entry.ok === null) { sw.entry.ok = false; sw.entry.dropped = why; }
    const t = sw.tracker;
    if (sw.two && t && typeof t.discardSwitch === 'function') Promise.resolve(t.discardSwitch({ prepared: true, kept: true })).catch(() => {});
  }

  /** A switch failed: the running landmarker stays; the same switch backs off (doubling), and is given up after a few. */
  _switchFailed(sw, e) {
    const T = this.tuning;
    if (this._sw === sw) this._sw = null;
    sw.entry.ok = false;
    const msg = (e && e.message) || String(e);
    sw.entry.error = msg.slice(0, 160);
    const f = this._swFails.get(sw.key) || { n: 0, until: -Infinity, permanent: false };
    f.n++;
    const code = e && (e.code || (e.cause && e.cause.code));
    f.permanent = f.n >= T.switchMaxFailures || code === 'model-missing';
    const wait = Math.min(T.switchFailMaxMs, T.switchFailWaitMs * 2 ** (f.n - 1));
    f.until = this._lastNow + wait;
    this._swFails.set(sw.key, f);
    // once per switch, and once more when it is given up (not at every safe moment)
    if (f.n === 1 || f.permanent) {
      const what = sw.kind === 'model' ? `the ${sw.to} pose model` : `pose detection on the ${sw.to}`;
      console.warn(`[input] ${what} could not start (${msg}) — ${f.permanent ? 'not trying again this session' : `next try in ${Math.round(wait / 1000)} s at the earliest`}`);
    }
  }

  /** Frames missing while a commit / revert restarts the graph are not a frozen camera (modelSwitchGraceMs). */
  _grace() {
    const g = { since: this._lastNow, settled: false, graceMs: this.tuning.modelSwitchGraceMs };
    this._poseSwitch = g;
    return g;
  }

  /** The model or delegate changed: verdicts about the old one do not apply to the new one. */
  _resetGovernorTimers() {
    this._starvedSince = null;
    this._urgentSince = null;
    this._liteOkSince = null;
    this._cam60SlowSince = null;
    this._cam60FastSince = null;
  }

  /** A model / delegate switch for status.pipeline (the last 8 of each kind). */
  _noteSwitch(kind, e) {
    const list = kind === 'model' ? this._modelSwitches : this._delegateSwitches;
    const entry = { at: Math.round(this._lastNow), ...e };
    list.push(entry);
    if (list.length > 8) list.shift();
    return entry;
  }

  /** The camera's frame rate as far as detection is concerned: the track's rate, or fewer if fewer frames arrive. */
  _cameraRate(s) {
    const cfg = this._cam && Number.isFinite(this._cam.frameRate) && this._cam.frameRate > 0 ? this._cam.frameRate : 30;
    return s && s.camFps > 0 && s.frames >= this.tuning.minJudgedFrames ? Math.min(cfg, s.camFps * 1.05) : cfg;
  }

  /** The pipeline changed (pose budget, model, camera rate): its figures start over and are judged a second later. */
  _settleJudgement(now) {
    const t = this._tracker;
    if (t && typeof t.resetPipeline === 'function') t.resetPipeline();
    this._judgeAfter = (Number.isFinite(now) ? now : this._lastNow) + this.tuning.settleJudgeMs;
  }

  /**
   * Camera rate (PERF-06): a camera that offers 60 fps goes to 60 only while the detector is fast enough to take every
   * frame as it arrives (a median at or below camera60TryDetectMs for camera60RetryMs during an activity), and back to 30
   * as soon as it is not (camera60KeepDetectMs / camera60MinRatio for camera60BehindMs; the next try waits twice as
   * long). Both are instant applyConstraints changes (no gap). The tracking model is never changed for the camera's sake.
   */
  _governCamera(now, s, bout, judged) {
    const T = this.tuning;
    const cam = this._cam;
    if (!T.camera60 || !cam || cam.kind !== 'camera' || typeof cam.setFrameRate !== 'function' || !(cam.maxFrameRate >= 59) || this._camFpsBusy) return;
    if (cam.refusedFrameRate >= 59 && !((cam.frameRate || 0) >= 59)) return; // 60 only in another picture mode: never
    const sw = this._sw;
    if (sw && (sw.phase === 'committing' || sw.phase === 'reverting')) { this._cam60SlowSince = null; this._cam60FastSince = null; return; }
    const p50 = s.detMs ? s.detMs.p50 : null;
    if ((cam.frameRate || 0) >= 59) {
      const slow = judged && (s.detFps < T.camera60MinRatio * cam.frameRate || (p50 !== null && p50 > T.camera60KeepDetectMs));
      if (slow) { if (this._cam60SlowSince === null) this._cam60SlowSince = now; }
      else if (judged) this._cam60SlowSince = null;
      if (this._cam60SlowSince === null || now - this._cam60SlowSince < T.camera60BehindMs) return;
      if (now - this._cam60TriedAt < 2 * T.camera60RetryMs) this._cam60Wait = Math.min(T.camera60RetryMaxMs, this._cam60Wait * 2);
      this._cam60RetryAt = now + this._cam60Wait;
      this._setCameraFps(30, 'behind');
    } else {
      const fast = judged && bout && p50 !== null && p50 <= T.camera60TryDetectMs
        && s.detFps >= T.behindRatio * Math.min(cam.frameRate || 30, T.targetDetectFps);
      if (fast) { if (this._cam60FastSince === null) this._cam60FastSince = now; }
      else if (judged) this._cam60FastSince = null;
      if (this._cam60FastSince !== null && now >= this._cam60RetryAt && now - this._cam60FastSince >= T.camera60RetryMs) {
        this._cam60TriedAt = now;
        this._setCameraFps(60, 'headroom');
      }
    }
  }

  _setCameraFps(fps, why) {
    const cam = this._cam;
    if (!cam || typeof cam.setFrameRate !== 'function') return;
    this._camFpsBusy = true;
    this._cam60SlowSince = null;
    this._cam60FastSince = null;
    const entry = { at: Math.round(this._lastNow), from: cam.frameRate, to: fps, why, got: null };
    this._cameraSwitches.push(entry);
    if (this._cameraSwitches.length > 8) this._cameraSwitches.shift();
    const t = this._tracker;
    Promise.resolve()
      .then(() => cam.setFrameRate(fps))
      .then((got) => {
        entry.got = got;
        if (this._cam === cam && this._tracker && typeof this._tracker.setCameraFps === 'function') this._tracker.setCameraFps(got || fps);
      }, () => { /* the camera keeps its rate */ })
      .finally(() => {
        this._camFpsBusy = false;
        // rates measured at the old camera rate don't judge the new one
        if (t && this._tracker === t) this._settleJudgement(this._lastNow);
      });
  }

  /** One capture → punch event sample (status.pipeline): the frame that fired it, processed now. */
  _notePunchLatency() {
    const tm = this._curTiming;
    if (!tm) return;
    const at = Number.isFinite(this._curWall) ? this._curWall : this._lastNow;
    const cap = Number.isFinite(tm.captureTime) ? at - tm.captureTime : NaN;
    const pose = Number.isFinite(tm.arrivedTime) ? at - tm.arrivedTime : NaN;
    this._eventLat.push({ at, cap, pose });
    if (this._eventLat.length > this.tuning.eventWindow) this._eventLat.shift();
  }

  /** status.pipeline: the tracker's per-stage figures plus the hub's own (events, model, camera, pressure, switches). */
  _pipelineStatus(ts) {
    const p = ts && ts.pipeline ? ts.pipeline : null;
    const ev = this._eventLat;
    const pick = (k) => ({ p50: quantile(ev.map((e) => e[k]), 0.5), p90: quantile(ev.map((e) => e[k]), 0.9) });
    const pr = this._pressure;
    const cam = this._cam;
    const sw = this._sw;
    const wish = this._wish;
    const pending = (k) => (sw && sw.kind === k && (sw.phase === 'preparing' || sw.phase === 'ready') ? sw.to : wish && wish.kind === k ? wish.to : null);
    return {
      ...(p || {}),
      capToEvent: pick('cap'), poseToEvent: pick('pose'), events: ev.length,
      model: this.model, modelPref: this.modelPref, delegate: ts ? ts.delegate : null,
      detector: ts && ts.detector ? ts.detector : this.detector, numPoses: ts ? ts.numPoses : this._numPoses(),
      cameraFps: cam && Number.isFinite(cam.frameRate) ? cam.frameRate : null,
      cameraMaxFps: cam && Number.isFinite(cam.maxFrameRate) ? cam.maxFrameRate : null,
      behind: pr ? pr.behind : null, headroom: pr ? pr.headroom : null, starved: pr ? pr.starved : null,
      // a switch wanted (not started: a round runs, or it is backing off) or under way (preparing / ready / committing /
      // trial / probation / reverting)
      pendingModel: pending('model'), pendingDelegate: pending('delegate'), safeToSwitch: this.safeToSwitch,
      switching: sw ? { kind: sw.kind, to: sw.to, why: sw.why, phase: sw.phase } : null,
      renderAtFloor: this._renderAtFloor, fullCostRatio: Math.round(this._fullCostRatio * 100) / 100,
      modelSwitches: this._modelSwitches.slice(-4), cameraSwitches: this._cameraSwitches.slice(-4),
      delegateSwitches: this._delegateSwitches.slice(-4),
      droppedResults: this._tracker && Number.isFinite(this._tracker.droppedResults) ? this._tracker.droppedResults : 0,
    };
  }

  /** Backstop for a track that ended without an 'ended' event (checked every cameraCheckMs). */
  _checkCamera(nowMs) {
    const cam = this._cam;
    if (!cam || typeof cam.isEnded !== 'function' || nowMs - this._lastCamCheck < this.tuning.cameraCheckMs) return;
    this._lastCamCheck = nowMs;
    let ended = false;
    try { ended = cam.isEnded(); } catch { ended = false; }
    if (ended && typeof cam.endedError === 'function') this._onCameraEnded(cam.endedError(), cam);
  }

  /** Feed one frame through assigner → recognizers (+recorder, calibration). */
  _process(raw, preAssigned, wallMs) {
    if (!raw || !Array.isArray(raw.players)) return;
    this.recorder.push(raw);
    const frame = preAssigned ? normalizeAssigned(raw, this.players) : this.assigner.assign(raw);
    this._latestRaw = raw;
    this._latest = frame;
    // somebody besides the players (bystander, poster) is in the picture (PERF-02: keep the extra pose).
    // Only with every player slot filled: before the assigner claims a slot the player is `ignored` too.
    if (Array.isArray(frame.ignored) && frame.ignored.length && hasAll(frame.players, this.players)
      && frame.ignored.some((p) => p && (p.score ?? 0) >= this.tuning.minScore)) {
      this._othersSeenAt = wallMs;
      if (this._activity && this._searching) this._crowded = true;
    }
    this._recordLatency(raw, wallMs);
    this._lastFrameWall = wallMs;
    this._lastFrameT = frame.t;
    this._frameWalls.push(wallMs);
    while (this._frameWalls.length && this._frameWalls[0] < wallMs - 1000) this._frameWalls.shift();
    const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 0;
    if (aspect && aspect !== this._aspect) {
      this._aspect = aspect;
      for (const r of this._recognizers) if (r && typeof r.setAspect === 'function') r.setAspect(aspect);
    }
    this._curTiming = raw.timing || null;
    this._curWall = wallMs;
    for (let i = 0; i < this.players; i++) {
      const pose = frame.players[i] || null;
      this._present[i] = !!pose && (pose.score ?? 1) >= this.tuning.minScore;
      this._runRecognizer(i, pose, frame.t);
      const cal = this._calibrations[i];
      if (cal) cal._feed(pose, frame.t, wallMs);
    }
    this._curTiming = null;
  }

  /** One latency sample per processed frame: the tracker's capture → ready time, else the frame's age. */
  _recordLatency(raw, wallMs) {
    let lat = null, src = null;
    if (raw.timing && Number.isFinite(raw.timing.latencyMs)) { lat = raw.timing.latencyMs; src = raw.timing.source || 'tracker'; }
    else if (Number.isFinite(raw.t) && Number.isFinite(wallMs)) {
      const age = wallMs - raw.t;
      if (age >= 0 && age <= 1000) { lat = age; src = 'frame-age'; }
    }
    if (lat === null) return;
    this._latencies.push(lat);
    if (this._latencies.length > this.tuning.latencyWindow) this._latencies.shift();
    this._latencySource = src;
  }

  /**
   * Measured camera → game latency in ms (rolling median of capture → pose ready, plus the tracker's
   * and recognizer's smoothing delay, HUB_TUNING.processingLagMs), or null before any frame /
   * in keyboard mode. Stored in the calibration (Calibration.latencyMs).
   * @returns {number|null}
   */
  get latencyMs() {
    if (this.mode === InputMode.KEYBOARD) return null;
    const n = this._latencies.length;
    if (!n) return null;
    const s = [...this._latencies].sort((a, b) => a - b);
    return Math.round(s[Math.floor((n - 1) / 2)] + this.tuning.processingLagMs);
  }

  _runRecognizer(i, pose, tMs) {
    const rec = this._recognizer(i);
    let res = null;
    try { res = rec.update(pose, tMs); } catch (e) {
      if (!this._recognizerErrorLogged) { this._recognizerErrorLogged = true; console.error('[input] gesture recognizer failed', e); }
      return;
    }
    if (!res) return;
    if (res.control) this._controls[i] = res.control;
    const q = this._events[i];
    for (const ev of res.events || []) {
      q.push(ev);
      this._emitPunch(i, ev);
      if (ev && ev.type === 'punch') this._notePunchLatency();
    }
    if (q.length > this.tuning.maxQueuedEvents) q.splice(0, q.length - this.tuning.maxQueuedEvents);
  }

  _emitPunch(i, ev) {
    if (this.bus && ev && ev.type === 'punch' && ev.punch) this.bus.emit(Ev.INPUT_PUNCH, { player: i, punch: ev.punch });
  }

  _recognizer(i) {
    if (!this._recognizers[i]) {
      const p = this.profiles[i];
      this._recognizers[i] = new this.deps.GestureRecognizer({
        calibration: p.calibration || null,
        ...(this.gestureTuning ? { tuning: { ...this.gestureTuning } } : {}),
        ...(this._aspect ? { aspect: this._aspect } : {}),
      });
    }
    return this._recognizers[i];
  }

  _resetRecognizers() {
    for (let i = 0; i < 2; i++) {
      const r = this._recognizers[i];
      if (r && typeof r.reset === 'function') r.reset();
      this._controls[i] = null;
      this._events[i] = [];
      this._present[i] = false;
    }
  }

  /** Frames stopped arriving (camera froze/unplugged, replay ended): let recognizers see the loss. */
  _checkStale(nowMs) {
    if (!Number.isFinite(this._lastFrameWall)) return;
    if (this._poseSwitchActive(nowMs)) return; // MediaPipe is restarting for a new numPoses: not a frozen camera
    const age = nowMs - this._lastFrameWall;
    if (age <= this.tuning.staleFrameMs || nowMs - this._lastStaleFeed < 100) return;
    this._lastStaleFeed = nowMs;
    const t = this._lastFrameT + age;
    for (let i = 0; i < this.players; i++) {
      this._present[i] = false;
      if (this.mode !== InputMode.KEYBOARD) this._runRecognizer(i, null, t);
    }
  }

  _assist(i, control, events, nowMs) {
    const kb = this.keyboard.update(nowMs, i);
    for (const ev of kb.events) this._emitPunch(i, ev);
    const out = { ...control };
    const held = (a) => this.keyboard.isHeld(a, i);
    if (held('leanLeft') || held('leanRight') || held('duck') || held('leanIn') || held('leanBack')
      || Math.abs(kb.control.lean.x) > 0.02 || kb.control.lean.y < -0.02 || Math.abs(kb.control.lean.z) > 0.02) {
      out.lean = kb.control.lean;
      out.head = kb.control.head;
    }
    if (held('guardHigh') || held('guardLow') || kb.control.guardAmount > 0.02) {
      out.guard = kb.control.guard;
      out.guardAmount = Math.max(kb.control.guardAmount, control.guardAmount || 0);
      out.guardMs = kb.control.guardMs;
    }
    return { control: out, events: kb.events.length ? events.concat(kb.events) : events };
  }

  _debounce(i, raw, nowMs, immediate) {
    const d = this._deb[i];
    if (raw !== d.raw) { d.raw = raw; d.since = nowMs; }
    if (d.state && !raw && (immediate || nowMs - d.since >= this.tuning.lostMs)) {
      d.state = false;
      if (this.bus) this.bus.emit(Ev.INPUT_TRACKING_LOST, { player: i });
    } else if (!d.state && raw && (immediate || nowMs - d.since >= this.tuning.foundMs)) {
      d.state = true;
      if (this.bus) this.bus.emit(Ev.INPUT_TRACKING_FOUND, { player: i });
    }
  }

  _resetTracking() {
    for (let i = 0; i < 2; i++) { this._deb[i] = { state: false, raw: false, since: -Infinity }; this._present[i] = false; }
    this._poseSwitch = null;
    this._lastFrameWall = -Infinity;
    this._frameWalls = [];
    this._latencies = [];
    this._latencySource = null;
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** @returns {object} current status (also returned by update()) */
  get status() {
    const ts = this._tracker ? this._tracker.getStats() : null;
    const n = this._frameWalls.length;
    const span = n >= 2 ? this._frameWalls[n - 1] - this._frameWalls[0] : 0;
    return {
      mode: this.mode,
      phase: this._phase,
      ready: this._phase === 'running',
      players: this.players,
      tracking: this._deb.slice(0, this.players).map((d) => d.state),
      presence: this._present.slice(0, this.players),
      fps: span > 0 ? ((n - 1) * 1000) / span : 0,
      detectMs: ts ? ts.detectMs : 0,
      detectMsP95: ts ? ts.detectMsP95 : 0,
      delegate: ts ? ts.delegate : null,
      fallbackReason: ts ? ts.fallbackReason : null,
      model: this.model,
      /** the player's choice: 'auto' | 'full' | 'lite' (PERF-06) */
      modelPref: this.modelPref,
      numPoses: ts ? ts.numPoses : this._numPoses(),
      /** 'activity' (players) or 'setup' (players + extra) number of poses; `searching`: a player is missing */
      poseMode: this._activity ? 'activity' : 'setup',
      searching: this._searching,
      poseSwitches: this._poseSwitches,
      /** where detection runs right now: 'worker' | 'main' */
      detector: ts && ts.detector ? ts.detector : this.detector,
      lastDetectMs: this._lastDetectMs,
      error: this._error ? this._error.message : null,
      errorHelp: this._error ? this._error.help : null,
      errorCode: this._error ? this._error.code : null,
      /** player-facing title for the error ('' if none) and what failed: 'camera' | 'tracker' | 'unknown' */
      errorTitle: this._error ? this._error.title || '' : null,
      errorSource: this._error ? this._error.source || 'unknown' : null,
      camera: this._cam ? { label: this._cam.label, kind: this._cam.kind, width: this._cam.width, height: this._cam.height, deviceId: this._cam.deviceId } : null,
      frameAgeMs: Number.isFinite(this._lastFrameWall) ? Math.max(0, this._lastNow - this._lastFrameWall) : Infinity,
      recording: this.recorder.recording,
      replaying: this.mode === InputMode.REPLAY && !!this._replay,
      keyboardAssist: this.keyboardAssist,
      latencyMs: this.latencyMs,
      latencySource: this._latencySource,
      /** PERF-06 readout: rates, per-stage p50/p90, capture → punch event, model / camera rate, pressure, switches */
      pipeline: this.mode === InputMode.CAMERA ? this._pipelineStatus(ts) : null,
    };
  }

  /** Last ASSIGNED PoseFrame (players[0]=P1 …, plus `ignored`), for previews and calibration. */
  latestFrame() { return this._latest; }
  /** Last raw PoseFrame in detection order. */
  latestRawFrame() { return this._latestRaw; }

  /**
   * Start a guided calibration for one player, fed by that player's poses.
   * @returns {BoundCalibration}
   */
  calibrate(playerIndex = 0) {
    const i = playerIndex === 1 ? 1 : 0;
    this.setActivityMode(false); // calibration is a setup step: tell bystanders apart (PERF-02)
    if (this._calibrations[i]) this._calibrations[i].cancel();
    const session = new this.deps.CalibrationSession({ latency: () => this.latencyMs });
    const bound = new BoundCalibration(this, i, session);
    this._calibrations[i] = bound;
    return bound;
  }

  /**
   * Debug/test: push PoseFrames through the pipeline as if they came from the camera.
   * Immediate (default): processed now, in order; frame.t must use the same clock as update().
   * realtime: frames are scheduled by their relative t, starting at the next update() call.
   * assigned: frames already have players in slot order (skip PlayerAssigner).
   * @param {import('../core/types.js').PoseFrame[]} frames
   * @param {{assigned?:boolean, realtime?:boolean}} [opts]
   */
  injectFrames(frames, { assigned = false, realtime = false } = {}) {
    const list = (Array.isArray(frames) ? frames : [frames]).filter(Boolean);
    if (!list.length) return;
    if (realtime) {
      this._inject = new ReplaySource({ frames: list }, { loop: false });
      this._injectAssigned = assigned;
      return;
    }
    for (const f of list) this._process(f, assigned, Number.isFinite(f.t) ? f.t : this._lastNow);
  }
}

function nowMs_() { return nowMs(); }

/** p-quantile (nearest rank) of the finite values, rounded to 0.1; null when there are none. */
function quantile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return Math.round(a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))] * 10) / 10;
}

/** Every one of the first `n` player slots holds a pose. */
function hasAll(players, n) {
  if (!Array.isArray(players)) return false;
  for (let i = 0; i < n; i++) if (!players[i]) return false;
  return true;
}

/** 'worker' | 'main' | null for anything else ('auto' = 'worker': it falls back to the main thread itself). */
function normDetector(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'worker' || s === 'auto') return 'worker';
  if (s === 'main') return 'main';
  return null;
}

/** ?detector=worker|main on the page (a debug / test switch; app/params.js may pass it explicitly). */
function urlDetector() {
  try {
    if (typeof location === 'undefined' || !location.search) return null;
    return normDetector(new URLSearchParams(location.search).get('detector'));
  } catch { return null; }
}

/** Make an injected pre-assigned frame look like PlayerAssigner output. */
function normalizeAssigned(f, n) {
  const players = [];
  for (let i = 0; i < n; i++) players.push((f.players && f.players[i]) || null);
  return { t: f.t, width: f.width || 640, height: f.height || 480, players, ignored: f.ignored || [] };
}
