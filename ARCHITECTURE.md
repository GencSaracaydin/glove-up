# Glove Up — architecture & module contracts

A browser boxing game played with your body. A webcam + **MediaPipe Pose Landmarker**
tracks your arms (punches, guard) and your head (dodging, ducking). No controllers.
It should **play and feel** as close as possible to a classic motion-controlled cartoon
boxing game ("the reference game"; `research/mechanics.md` holds the frame-by-frame
measurements) while every asset — characters, faces, ring, HUD, sound, music, names — is
**our own original design** (see `src/render/style.js` for the art direction and originality rules).

Functional spec this implements: `research/spec.md`. Requirement IDs (SET01, COM01 …) are
referenced in code comments where they are implemented. **Out of scope by product decision: the
fitness assessment.** The stance choice (SET02, play style) was removed on 2026-11-10 at the user's
request: every boxer is orthodox (the left glove leads). Players may still stand either way, because
punches are read per hand (the left arm always throws the left glove).

Stack: Vite 7, plain ES modules (no framework), Three.js 0.186, `@mediapipe/tasks-vision`
1.1.1 (PoseLandmarker, VIDEO mode, GPU delegate with CPU fallback, run in a dedicated worker by
default). Model + wasm are served locally from `public/models/` and `public/mediapipe/wasm/`
(`npm run setup:models`: the models are pinned and SHA-256-checked, `MODELS` in
`scripts/fetch-models.mjs`). The two typefaces (Lilita One 400, Nunito 400/700/800/900) are
self-hosted from the `@fontsource` packages through `src/ui/fonts.css`, linked from index.html
before styles.css: at play time the game requests nothing from another host. MediaPipe Tasks'
built-in usage logger (it POSTs to odml.pa.googleapis.com every 60 s and whenever a landmarker is
closed) is answered on the device by `src/input/no-telemetry.js`, installed at module scope in
pose-worker.js (`self`) and pose-tracker.js (`globalThis`) (R5). The announcer prefers an on-device
system voice; only when the browser has no local English voice can it use an online one, which the
browser itself contacts (README says so). Third-party
notices and licence texts: `public/THIRD_PARTY_NOTICES.txt`, copied into every build
(vite.config.js also keeps three's `@license` comment and stamps a MediaPipe Apache banner on the
chunks that bundle it, the main build and the worker). The build splits the app into chunks by module
layer so that none crosses Vite's 1000 kB warning (BUILD-HEADROOM, input round): `three` and `mediapipe`
(the libraries, as before), `core` (src/core types / events / rng: leaf modules), `input` (src/input),
`game` (src/game and src/training), and `main` (app, render, ui, audio and core/storage.js, which imports
game/progression.js). Every import points down that list, so there is no chunk cycle
(tests/unit/build-chunks.test.mjs scans the import graph); the pose worker is its own build and is not
split. `package.json` `engines.node` is Vite 7's range, `^20.19.0 || >=22.12.0`.

Owners below are the alignment-pass owners (§6); training/* had no owner in that pass.

```
src/
  main.js                 bootstrap                                       — integration
  app/app.js              app flows (menus, single, versus, training), loop, pause, saving, hooks — integration
  app/session.js          MatchSession / TrainingRun: game clock, outro hand-off — integration
  app/tutorial.js         first-bout tutorial runner (six live cards)    — integration
  app/params.js           URL parameters                                  — integration
  app/pose-feeder.js      scripted "camera" for tests (injectPose)        — integration
  app/debug-overlay.js    ?debug=1 overlay                                — integration
  app/visitor-counts.js   visitor counts on the public deploy (Vercel Web Analytics) — integration
  app/splash.js           the loading screen (index.html #splash): fades once the title has drawn — integration
  core/events.js          EventBus                                        — given
  core/types.js           enums, Ev names, typedefs                       — shared (extend, don't break)
  core/rng.js             seeded RNG                                      — combat
  core/storage.js         profiles, records, rating, tutorial flag        — progression
  input/camera.js         getUserMedia / video-file source                — input
  input/pose-tracker.js   MediaPipe wrapper (+ per-frame latency), main-thread detector — input
  input/pose-worker-tracker.js WorkerPoseTracker: the same model in a worker (default), main-thread fallback, worker-swap switches — input
  input/pose-worker.js    the detection worker (message protocol in its header) — input
  input/pose-worker-codec.js result packing between worker and page, MP_NOISE, keepModuleFactory — input
  input/no-telemetry.js   fetch guard: MediaPipe's usage logger answered locally; blockMediapipeTelemetry(scope), TELEMETRY_HOSTS, fetchHost (R5) — platform
  input/player-assigner.js multi-person → P1/P2 identity                  — input
  input/input-hub.js      one place the app reads input from              — input
  input/keyboard.js       keyboard controls / debug input                 — input
  input/recorder.js       record/replay PoseFrames (JSON)                 — input
  input/preview.js        draws webcam + skeleton to canvas               — input
  input/one-euro.js       One-Euro filter                                 — input
  input/gesture.js        landmarks → ControlState + punches              — input
  input/calibration.js    guided calibration state machine               — input
  input/synthetic.js      synthetic landmark generator                    — input
  input/tutorial-detect.js tutorial step detection (holds, 3 detections)  — input
  game/boxer.js           boxer state machine (health in wedges)          — combat
  game/combat.js          punch resolution (pure)                         — combat
  game/ai.js              opponent brains (+ tutorial scripts)            — combat
  game/roster.js          our 10 original opponents, §4.5 tuning          — combat
  game/match.js           match state machine, stages, calls, slow motion — combat
  game/progression.js     rating Δ, PRO, matchmaking, glove unlocks       — progression
  training/*.js           bag, dodge drill, mitts, medals, sessions       — (unowned)
  render/style.js         palette, materials, layout, LIGHTING / VENUE_LIGHTING — view3d
  render/adaptive.js      adaptive render quality (detection time excluded; gives GPU time to a starved pose detector; per-context memory) — view3d
  render/renderer.js      Three.js renderer, viewports, hit-stop, outro   — view3d
  render/arena.js         ring, ropes, crowd, lights, taunt boards        — view3d
  render/camera-rig.js    gameplay + cinematic cameras, hard cuts         — view3d
  render/own-fade.js      own-part fade: the viewer's own gloves / see-through head while they cover the opponent's face (R8) — view3d
  render/fx.js            bursts, rings, trails, shake, hit-stop clock    — view3d
  render/meter.js         on-hit health meters (10 segments, in 3D)       — view3d
  render/replay.js        replay recorder + outro planner                 — view3d
  render/screen-fx.js     smear, tint, logo wipe, fades                   — view3d
  render/boxer-model.js   procedural boxer + animation                    — view3d
  render/face.js          painted face CanvasTextures                     — view3d
  render/appearance.js    presets, randomizer, validation                 — view3d
  render/training-props.js bag, chain, balls, mitts                       — (training)
  ui/ui.js                screen manager + navigation                     — hud
  ui/screens/*.js         individual screens                              — hud
  ui/hud.js               in-bout HUD, text calls, outro banner, tutorial card — hud
  ui/styles.css           all CSS                                         — hud
  ui/fonts.css            the self-hosted typefaces (@fontsource imports)  — integration
  audio/audio.js          synthesized SFX, crowd, bell, announcer         — audio
  audio/synth.js, music.js sound recipes, loops and stingers              — audio
dev/                      standalone dev pages (arena, models, gesture/input labs, ui, audio, sim)
tests/unit/*.test.mjs     node unit tests (`npm test`)
tests/e2e.mjs             Playwright run of every flow                    — integration
public/THIRD_PARTY_NOTICES.txt  third-party copyright notices and licence texts (every build) — integration
scripts/fetch-models.mjs  setup:models (pinned, checksummed models; wasm copy) — integration
vite.config.js            build: licence banners, the chunk split by module layer (BUILD-HEADROOM) — integration
```

**Ownership rule:** only edit files you own. If you need something from another module,
code against the API below; if it's missing, note it in your report rather than editing
their file. `core/types.js` may be *extended* (new optional fields/enums) by anyone, never
broken.

---

## 1. Coordinate conventions (read this twice)

* **Raw camera space**: MediaPipe image landmarks are normalized `[0,1]` in the RAW,
  non-mirrored camera frame. MediaPipe names landmarks by the *person's anatomical side*
  (`LEFT_WRIST` = the person's left wrist). In a raw front-facing webcam image the person's
  RIGHT side appears on the image's LEFT (smaller x). Calibration verifies this with a
  "raise your RIGHT hand" step and sets `Calibration.swapSides` if the labels come out
  reversed on some device.
* **Preview**: anything showing the webcam to the player is **mirrored** (like a mirror),
  so moving right moves right on screen.
* **Player perspective** (`ControlState`, `HandState`): `+x` = toward the player's own
  right, `+y` = up, units = the player's shoulder width (measured live in every frame),
  origin = shoulder-line centre (hands) or the neutral head position learned in each bout
  (head/lean; §3 gesture.js).
* **Boxer perspective** (`BoxerView`): same convention for each boxer: `+x` = that boxer's
  right. The human boxer's view values are copied straight from ControlState.
* **World** (Three.js): metres, Y up, ring centre at origin. P1 at `+Z` facing `-Z`,
  P2 at `-Z` facing `+Z`. So P1's right is world `+X`; P2's right is world `-X`.
  Use `LAYOUT` from `render/style.js`.
* **World landmarks**: metres, origin between the hips, **smaller z = closer to camera**
  (i.e. toward the opponent, since the player faces the screen).

## 2. Data flow per frame

```
camera video ──► WorkerPoseTracker (PoseLandmarker in pose-worker.js) ──► PoseFrame (+timing) ──► PlayerAssigner ──► per player PlayerPose
                                                                    │
                     KeyboardInput (fallback / debug) ─────────┐    ▼
                                                               ├─► GestureRecognizer.update()
                                                               ▼        → {control, events}
                                                          InputHub.update(now) → PlayerInput[]
                                                               │
            ┌──────────────────────────────────────────────────┤
            ▼                                                  ▼
  MatchSession.update(realDt, now, inputs)          TrainingRun.update(realDt, now, inputs)
     game dt = realDt × renderer.timeScale (hit-stop)     (same game clock)
     Match.update(dt, gameNow, {p1, p2})                 TrainingActivity.update(dt, gameNow, input)
     TutorialRunner.update(gameNow, p1, view)            (emits Ev.TRAIN_* on bus)
     (emits Ev.MATCH_* on bus)                                │
            │ getView() → MatchView                           │ getView() → TrainingView
            ▼                                                  ▼
  GameRenderer.renderMatch(view, realDt)          GameRenderer.renderTraining(view, realDt)
  Hud.update(view)                                Hud.updateTraining(view)
  AudioEngine, Hud and FX also listen on the bus (MATCH_CALL, MATCH_SLOWMO, RENDER_CUT, RENDER_OUTRO …)
```

Detection runs at the camera rate (~30 Hz, via `requestVideoFrameCallback` when
available) **in a dedicated worker** (PERF-01): frames go from the rVFC callback to
`input/pose-worker.js` as transferred VideoFrames (ImageBitmaps where VideoFrame can't be
made) with their capture metadata, so `PoseFrame.timing` and the latency stay right; the
model's init and warm-up run there too (no main-thread freeze after the title). `InputHub.update`
picks up every pose finished since the last frame, oldest first, each with its own capture time
(`detect()` + `takeFrames()`, PERF-06), and never waits for one. The main-thread `PoseTracker` is
the fallback — no Worker / OffscreenCanvas / VideoFrame-or-ImageBitmap support, a worker that
fails to start (45 s), stops answering (5 s of live page time: a `detect()` call more than
`workerPageStallMs` (1 s) after the previous one takes that gap out of the in-flight frame's age,
so a frozen page is not taken for a dead worker, while a dead worker is still caught after 5 s of
live time even if the page keeps stalling; RV-PERF-01) or crashes, frames that can't be passed, a
failed GPU → CPU switch — and `?detector=main` forces it. The worker runs one QoS class below the
main thread, so under heavy CPU contention it delivers fewer poses rather than costing frames; its
one-time slow-GPU check therefore needs two slow 12-frame windows `slowGpuRecheckMs` (8 s since
PERF-06) apart, unless the first window is above `slowGpuSevereMs` (1000 ms per frame since PERF-06:
on a Retina screen the title arena starved healthy GPU windows to 220–430 ms) (RV-PERF-02). With the
input hub's switch gate (`tracker.switchGate`) the tracker only records the verdict in
`tracker.slowGpu`; the hub turns it into a CPU trial at a safe moment (PERF-06, below), or drops it
once the render's steps have freed the GPU. Main-thread detection decides on its first window. The gesture
recognizer uses every frame that arrives at least 10 ms after the last one it processed
(`minFrameIntervalMs`: only duplicates and > 100 fps are skipped, so a 60 fps camera's frames are all used —
input round R3). Its frame-to-frame differences, noise estimates, speed envelopes and window extremes are
taken over samples at least 24 ms apart (`diffBaseMs`, a ≤ 42 Hz view), and every EMA is per time, so a
60 fps feed means what a 30 fps one does. Rendering and game logic run at
display rate (`requestAnimationFrame`); each frame the app hands `input.lastDetectMs` (the
main-thread ms the frame spent on detection: 0–1 with the worker) to
`renderer.setExternalFrameCost()`, so adaptive quality never counts detection as render time
(PERF-03). The input hub returns the latest ControlState (smoothed) every render tick and each
discrete event exactly once. Once a bout's result is locked, MatchSession passes the players'
controls on (their figures keep mirroring them) but drops their events.

**Pose rate and lag (PERF-06, input round).** The finding behind it: on a Retina screen (device pixel
ratio 2) the game's own render starved GPU pose detection. The render and a GPU detector share one
GPU and the render wins; a bout drawn at pixel ratio 2 kept 60 fps while detection fell to 7–18 poses
per second (detect 50–130 ms, capture → game ≈ 95–160 ms). The frame interval never shows it, so:
* the hub judges detection every `governorMs` (250 ms) over the tracker's last 2 s (`pipelineStats`) and
  publishes `hub.renderPressure` {behind, rateBehind, starved, headroom, gpu, judged, activity, session,
  starting, detFps, camFps, wantFps, detMs}: **behind** = fewer than `behindRatio` (0.9) × the wanted rate
  (min(camera, `targetDetectFps` 30)), or — only in a bout or drill (`session`) — a median above
  `behindDetectMs` (25 ms, "lag"); **starved** = fewer than `starvedRatio` (0.8) × the wanted rate;
  **headroom** = ≥ 97 % of it with a median ≤ `headroomDetectMs` (18 ms; 30 ms with setup's extra pose);
  **starting** while the camera and the detector start;
* every frame the app hands that to the render's adaptive quality (`renderer.adaptive.setDetectionPressure`,
  render/adaptive.js) and tells the hub whether the render has anything left to give
  (`hub.setRenderState({atFloor})`). A GPU detector that is behind gets GPU time back: on a display of
  105 Hz or more first a frame cap (`frameDivisor`: the app renders every Nth display frame, ≈ 60 fps;
  also at once while the detector starts), then the pixel ratio, then the shadows; lag alone (enough poses,
  a slow median) only takes the frame cap and the pixel ratio down to 1.25. The quality comes back only
  with detection headroom, and fast once no GPU detector reports (the CPU delegate, keyboard play). Each
  hub context (menus or a bout × setup or activity poses) keeps its own memory — a flat ceiling for a level
  that starved detection (120 s; 480 s for a probe that starved the rate within 20 s, 100 s for one that held
  20 s first), the continuous detection headroom it needs before its next probe (10 s, doubling up to 80 s
  with each quick probe failure) and the level it settled at — so a bout ending, a tracking-lost search or the
  menus in between no longer restart the probing, and the sharpness after a load ends waits about one ceiling
  at most (RG2, §3 renderer.js);
* only **starvation** moves the model or the delegate — lag alone never does (the recall cost of a slow
  full model is measured above lite's: on five labelled real clips full recalls 27.5 % at 30 poses/s,
  19.2 % at 20, 13.6 % at 12, while lite at 30 loses ≈ 17 % of full's recall — so lite only wins below
  ≈ 24 poses/s). Model **'auto'** (the default, Settings → Tracking: Auto / Lite / Full) runs full and goes
  lite after `liteAfterMs` (8 s) starved in a bout with the render at its floor (`liteMaxWaitMs` 20 s at
  most); it returns to full once lite's median × the measured full / lite cost ratio stays ≤
  `fullKeepsUpRatio` × the frame interval for `fullAfterMs` (30 s), then on probation (`fullProbationMs`,
  lite still loaded: starved again → back at once, the next try waits twice as long). An explicit 'full' or
  'lite' is never changed by the hub. A detector still starved `delegateAfterMs` (15 s) later (with auto,
  after lite had its chance) tries the other delegate as a **trial**: kept only at ≥ `delegateGain` (1.15) ×
  the old rate, judged like with like — in-round rate against in-round rate with the same pose budget (RG4);
  a trial whose rate between rounds already misses that bar is lost there (a round's rate is never higher), and
  a lost trial goes back at once only when it is clearly worse (below the old rate ÷ 1.15), otherwise at the
  next safe moment (RG4-SIDE);
* switches never stop detection: `prepareSwitch` builds the new landmarker next to the running one — for the
  worker, a SECOND worker that loads, warms up and is primed with one real frame while the first keeps
  detecting — and `commitSwitch` sends the next frame to it (no pause); `revertSwitch` goes back to a kept
  one at once, `discardSwitch` drops either. Prepare and commit wait for a **safe moment**: menus, between
  rounds, after a bout, paused — never from MATCH_INTRO (the first-bout tutorial included) or a round start /
  start bell until the round ends, nor during a drill. The exception is **urgent** starvation (below
  `urgentRatio` 0.5 × the wanted rate for `urgentAfterMs` 10 s in an activity), and only for the gapless
  worker swap: main-thread detection (`?detector=main`, the worker's fallback) runs the new landmarker's
  warm-up on the page's thread (65–193 ms frozen at idle), so its switches always wait (RG3). A switch that
  fails backs off (`switchFailWaitMs` 60 s, doubling up to `switchFailMaxMs`, given up after
  `switchMaxFailures` 3, at once for a missing model file) with one warning; a prepare not ready after
  `switchPrepareMaxMs` (30 s) is dropped;
* the camera opens at its usual 30 fps (`HUB_TUNING.cameraFps`, BASE's getUserMedia constraints). One that
  offers 60 goes to 60 only after `camera60RetryMs` (20 s) in a bout with a detect median ≤
  `camera60TryDetectMs` (11 ms) — a frame that waits for a busy worker is no fresher than at 30 — and back
  to 30 after `camera60BehindMs` (3 s) above `camera60KeepDetectMs` (14 ms) or below `camera60MinRatio` ×
  60 poses per second (the next try waits twice as long). Both are instant `applyConstraints` changes; a
  60 fps mode that changes the picture size is refused and undone, and never asked for again (the mode
  guard, `cam.refusedFrameRate`). The model never changes for the camera's sake;
* `status.pipeline` reads it all out: camera / detection rates and the slowest second of the last 10 s,
  p50 / p90 per stage (capture → frame seen → handed to the worker → inference → back → game), capture →
  punch event, model / modelPref / delegate / camera rate, behind / headroom / **starved**, the pending
  model or delegate, `safeToSwitch`, `switching` {kind, to, why, phase}, `renderAtFloor`, `fullCostRatio`,
  and the last switches (each with ok, urgent, kept, reverted, buildMs, warmMs; a trial also before /
  after / judgedIn). The `?debug=1` overlay prints a `pipe …` line from it (STARVED / BEHIND, a switch under
  way) and the input lab shows it as badges.

Measured on an M-series Mac at DSF 2 (1512×860), the facecam clip as the camera, interleaved: the polish
build 10 poses/s (min 8), hub latency 164–179 ms, pixel ratio 2; the input round's build 30 poses/s (min 29),
capture → game 33.5–50 ms (one camera frame apart), hub latency 64–80 ms, pixel ratio 1.25; render 60 fps in
both. At DSF 1 (1280×720) 27–29 against 30 poses/s, hub latency 63–80 against 47–63 ms (merge-fix report).

**Pose budget (PERF-02).** MediaPipe looks for `players + 1` people during setup (boot, the
camera check, calibration: bystanders and posters are told apart) and for `players` during
activities (from the black before the VS card, the VS card, the bout intro or a drill's start,
until the next camera check). The extra pose comes back while a player is missing (behind the
tracking-lost pause) and stays for the rest of the activity once other people were seen. A
switch's frame gap (MediaPipe restarting) never counts as a frozen camera. With the worker a
switch costs the main thread nothing; with `?detector=main` it is a ≈ 240 ms stall, which the
app places behind the black before the VS card (`input.setActivityMode(true)` in `blackout()`).

## 3. Module APIs (as built)

### input/gesture.js — owner: input (pure; runs in Node)
```js
export const DEFAULT_TUNING = { /* every threshold, documented */ };
export function effectiveTuning(tuning)   // sensitivity → scaled thresholds (s = 0.5 = DEFAULT_TUNING)
export function leanCurve(v, dz, at, level, full)
export class GestureRecognizer {
  constructor({ calibration, tuning })
  update(pose /*PlayerPose|null*/, tMs) /* → {control: ControlState, events: InputEvent[]} */
  setCalibration(cal); setTuning(partial); reset();
  depthTrusted /*getter*/; depthNoiseMm /*getter*/
}
```
* COM01/COM07/ERR03: one event per punch near peak extension; retraction never fires; pointing,
  reaching and yanks rarely fire (about 10 % of slow pointing or reaching attempts at real-camera
  noise; strokes that start from a raised, pointing hand are rejected; weak straights confirm on
  their retraction, which must show in the picture while the tracker's depth is untrusted). A stroke
  that starts within `lowGuardRecentMs` (400 ms) of a held LOW guard skips the stricter body-height
  early-rise limit (`maxEarlyRiseLow`), and with untrusted depth its 3D retraction may confirm it in
  addition to the picture's (RV-INPUT-04; bench lowBody 26/80, FP point 8/80, reach 9/80).
* Every camera `PunchInput` carries `atExtension: true` (D5: recognised at or near full extension;
  combat makes contact 30 ms later). Keyboard punches carry no flag.
* Frames closer than 10 ms to the last processed one are skipped (`minFrameIntervalMs`: duplicates and
  feeds over 100 fps; a 60 fps camera's frames are all used, R3).
  - Differences, noise estimates and window extremes are taken on a ≤ 42 Hz view (`diffBaseMs` 24 ms).
  - Every EMA (velocity, rates, dropout decay, confidence, body and head speed) is per time.
  - Glitch confirmations are timed (`glitchConfirmMs`), and a 15 fps scoop is not a 'spike'
    (`glitchSpikeSpeedSW`).
  - So recognition does not depend on the frame rate (INPUT-07; `dev/gesture-lab.bench.mjs --fps-rows`).
* A stroke that overlaps fast head motion (> 1.8 SW/s) or a duck is a dodge stroke: it fires only
  if it is strong (peak ≥ 2× onset; a straight's rise ≥ 0.45, a hook's or uppercut's travel ≥ 0.3
  SW), so counters thrown while slipping or coming back up count (INPUT-04).
* The tracker's world-depth jitter on still joints is measured live (`depthNoiseMm`).
  - MediaPipe in the game's VIDEO mode gives about 2–10 mm on the facecam clip
    (`dev/clips/facecam-boxing.mp4`) and on three public boxing clips.
  - An earlier non-VIDEO extraction of the facecam clip gave ≈ 20 mm (full) / ≈ 23 mm (lite). That is still
    the synthetic bench's default noise; the 'real-like' preset models the VIDEO-mode output.
  - The depth-led low-guard body straight and the 3D dip-less uppercut work only with clean depth
    (`depthTrusted`: on at ≤ `depthTrustNoise` 8 mm, off again above 11 mm).
  - The picture's dip-less uppercut (R1) works at any depth quality.
* COM02: wrist height at the punch → head / body; hooks and uppercuts recognised as `kind`.
  - Body hooks (`bodyHook`, 2026-11-13): a hook whose fist ends at body height (below `bodySplit`) may keep
    the elbow low by the side — only out to its side (`bodyHookElbowOut` 0 SW) and the fist above
    `bodyHookMinY` −1.7 SW; the head hook's "elbow raised" test and its −1.1 SW wrist floor rejected every
    body hook, and the fist's way back up to the guard then fired as an uppercut to the head. Synthetic
    body hooks (20 players × 2 hands × 6, 'real-like'): 0 → 205 of 240 hooks to the body (217 body punches),
    phantom head uppercuts 80 → 10; head hooks, jabs and the non-punch gestures unchanged.
* `PunchInput.power` 0..1 comes from the punch's own speed (log-spread; ~0.47 / 0.63 / 0.82 for
  360 / 200 / 110 ms punches), never from the sensitivity setting.
* COM03 guard high / low with `guardAmount`; COM04 lean per research/mechanics.md §2.1: `lean.x`
  reaches ±0.42 at a 0.35-shoulder-width head shift (±1 at 0.6), `lean.y` −0.42 at a 0.35 SW drop,
  `lean.z` ±0.62 at an ≈ 11 cm forward/back sway of the upper body at any camera distance (deadzone
  3.5 cm, ±1 at 18 cm). lean.z is a physical sway in metres from three cues — shoulder width and
  face-landmark spread, each times the estimated distance, and the tracker's hip-relative world
  depth — and counts only when shoulders and head agree (no twists or head turns) and the picture
  and the depth agree (a step nearer or farther, or a nod, never reads as a lean). 0.42 / 0.42 /
  0.62 are combat's dodge thresholds.
* The neutral (lean origin) is learned in every bout, from the first steady second with the hands
  up (guard or stance; lean = 0 until then, ≈ 1 s). "Steady" = head position, log shoulder width,
  shoulder tilt and hip-relative depth agree across the window within a noise-adaptive tolerance.
  It re-centres about 2 s after the player stands elsewhere (sideways, nearer, farther, or a nudged
  camera); a held sideways lean is kept for up to 6 s, a duck or back lean held longer than about
  2 s becomes the new neutral, but the upright neutral from before it is kept as **home** (R1), and
  as soon as the player is back near it, it is the neutral again, so coming back upright never reads
  as a dodge. A sideways home is chosen by the torso's own sideways lean over the hips (world
  landmarks); coming back upright at another distance re-centres at once (`neutralHomeElsewhereMs`
  100 ms: shoulders as level as at home, the head over them as then, no forward/back sway). Forward /
  back has no absolute upright (the camera's pitch changes with every laptop lid, and the depth
  wanders), so a home told apart only by the forward / back cues (a sway) is on probation for
  `neutralHomeProbationMs` (1.5 s) once the player has stood there: going straight back to the pose it
  replaced (lean.z three quarters of the way for `neutralHomeRevertMs` 250 ms, or a steady 1 s window
  in shoulder width and depth) takes the restore back and ends forward / back homes for the bout, and
  a restore the player never stood at is undone. A sway home needs a dodge-sized sway
  (`neutralSwayHomeM` 0.06 m) and is refused when the player is back, within `neutralHomeRelapseMs`
  (6 s), in the pose a restore had left; a crouch start (`neutralRiseSW` 0.245) is never kept; a
  duck home (told apart by the head height) is not on probation. Just back home, only the
  forward/back references (shoulder width, head size, depth) are refreshed once, within
  `neutralHomeRefreshMs` (2 s). `neutralHomeM` (0.16) is the full tolerance. Known cost: when the
  neutral was learned in a dodge-sized sway at the bout start, the first real dodge in that direction
  is lost. It is re-learned after 1.5 s out of tracking. No image position from the calibration is
  used (INPUT-01/02/10). A player who never stands still for the steadiness test (an active boxer)
  is followed by the **place** instead (item 15, `neutralPlaceMs` 3 s): the weighted median of
  200 ms block means, with frames weighted down while a hand punches, the head moves fast or the head
  has moved over the shoulders (a slip, `neutralPlaceLeanRel*`), and the head's height taken at the
  place's sideways position (`neutralPlaceAgreeSW`), so slips to both sides do not lower it. The
  neutral follows the place with a 1.5 s time constant once it has stayed more than 0.1 SW off for
  1 s, never toward a held lean or duck (those stay with the steadiness path and home), and not while
  a home is kept. A player who boxes from the start gets a provisional first neutral from the place
  (hands up, the window's halves agree), learned again from the first steady window in guard unless
  that window is a held lean or duck (`_heldPosture`); a neutral learned with the hands down is not
  provisional. Without a steadiness verdict (a busy stretch) the steady streak ends after
  `neutralSteadyStaleMs` (1.5 s) instead of carrying through the combo. Known costs: a player who
  slips mostly to one side pulls the neutral about 0.1 SW that way (borderline slips that way register
  less often); a dodge-sized lean held 8 s or more while punching can, for some players, read as a lean
  the other way for seconds after the return. `debug.leanZ` and
  `debug.steadyMs` are new; the repair round adds `debug.home`, `debug.homeProbation` and
  `debug.swayHomeOff`.
* ControlState also carries `guardMs` (current guard held) and `stanceMs` (steady fighting stance
  held) for the tutorial; the hands-above-the-head gesture (1.2 s) emits a `'pause'` InputEvent.
* Structural round (input round, R1–R5):
  - R1: the picture's dip-less uppercut — a fast upward drive of a forearm standing up under the fist. In
    front of the face it is confirmed by its way back down (`upImg*`).
  - R2: early decision — a strong straight or hook that already classifies fires before its drive peaks
    (`earlyMinPeak` 2.0 × the default onset, `earlyMinMs` 40). Not for uppercuts, dodge strokes, low pushes,
    weak or picture-only strokes, or a fist at body height or out beside the hip (V2-7).
  - R3: frame rate (above).
  - R4: display values. HandState x / y / reach and lean x / y can add back their filters' lag
    (`displayLead*`, `leanLead*`).
    - The gloves' lead is OFF by default (`displayLead` 0; V2-10: it shook resting gloves on noisy clips).
      The render springs own the glove lag (polish R11, re-tuned in the input round: §3 boxer-model); do not
      turn both on.
    - The lean lead stays on (`leanLead` 0.8).
  - R5: real punches turn the shoulders and carry the head. A short narrowing during a punch is no turn
    (`facingPunchGraceMs` 700). A stroke during head motion fires when the fist clearly outpaced the head
    (`dodgeOutpace` 2.5).
* Real people (RT): tuned on a labelled benchmark of real boxing recordings that is kept outside the
  repository (TUNE clips c2 / c4 / c5 for choosing, HOLDOUT c1 / c3 / facecam to confirm):
  - Real MediaPipe depth often reads a punch's direction wrong. So:
    - the picture decides the pull-back (RT-1: `pullBackImgOut`, `pullBackOut3`);
    - a stroke whose 3D reach contradicts its picture is judged on the picture (`depthContra*`);
    - a fast stroke the 3D tests turn down is classified from the picture alone (RT-11: `imgPath*`),
      confirmed by its retraction or way back down where a gesture could look the same.
  - The facing test compares the shoulder width with the face size, so a step back is no turn (RT-2:
    `facingHeadTauMs`, `facingDistTauMs`), at `facingMinRatio` 0.72 (V2-9). The unit follows a
    face-explained narrowing only after `facingDistHoldMs` 2 s (V2-10).
  - A fast stroke may end higher (`regionFast*`).
  - A hook's wind-up is no early motion (`ballisticImg*`, hook-like strokes only, V2-8).
  - A dropping other hand is no 'both hands' (`bilateralOpposedSW`).
  - An uppercut may drive to the chin (`upMedial*`), but must end in front of the body's middle
    (`upMedialMaxLat`, V2-6) and not with the other hand rising too (`upOtherRise*`).
  - A parked-then-snapping wrist landmark of low visibility is no stroke (`visStroke*`, RT-13).
  - A straight held as a possible hook fires once `hookPendingMs` has passed (`hookPendingFire`, RT-6).
  - The kind read from the picture (RT-14) keeps only steps 'd' (a foreshortened or not-upright uppercut is
    a straight / hook) and 'w' (a straight whose forearm ends pointing away from the midline is a wind-up):
    `kindSteps` 'dw'.
* Verification round (V2):
  - V2-1: a stroke soon after this hand's punch that heads against its picture direction is its way back
    (`recover*`; refined by V3-1 and R-D).
  - V2-2: a picture-only straight that began no earlier than the other hand's faster stroke is that
    punch's torso turn (`otherLead*`).
  - V2-3: a picture-only uppercut needs some punch speed (`imgUpMinPower`).
  - V2-5: a picture-only uppercut whose arm then went out is a straight (`imgUpStraightX`).
  - V2-7: no early decision at body height or out by the hip, and no picture-only straight going out to the
    side (`earlyNotLow`, `earlyMaxLateral`, `imgStraightMaxOut`).
  - V2-8: no picture-only classification during a duck (`imgNoDuck`).
  - V2-9: a picture-only straight needs a straightened elbow (`imgStraightMinS`), and `facingMinRatio` is
    back at 0.72.
  - V2-11: uppercuts need a sensitivity-independent minimum speed (`upMinPeakRaw` 1.3).
* Fix round (V3):
  - V3-1: the second punch of a same-hand double-up is no retraction.
    - 'Recovering' needs a stroke that began out where the punch ended, not back at its guard
      (`recoverFromGuard` 1).
    - Or one still at that end, in any direction (`recoverAtEnd` 0.35), but only as the punch's own
      follow-through: begun within `recoverAtEndMs` 125 ms of the fire (R-D).
    - The re-arm measures how far the hand came back from the punch's own peak, because the early decision
      fires before full extension (`rearmFromPeak`). The picture span counts only within `rearmPeakMs`
      150 ms of the fire (R-E).
    - After a body punch, a rising stroke that extends the arm in the picture and in 3D is the head shot,
      not the return (`returnOutXi` 0.3, `returnOut3` 0.25).
    - Its cost is kept on purpose (§7, lead decisions): +0.9 to +2.5 points of in-time recall on the six
      labelled clips for +1 to +4 false fires per condition, mostly from the from-the-guard rule.
  - V3-2: a 'hook' whose arm ended clearly extended (3D elbow straightness ≥ `hookExtMinS` 0.65), with the
    elbow below the hook test's 'raised' limits in 3D (`hookElbowMin`) and clearly in the picture
    (`hookElbowImgMin` − `hookExtElbowImgMargin` 0.05), is RELABELLED a straight.
    - It is a relabel only (R-B): the stroke fires exactly when and whether the hook would, and the early
      decision and the dodge test judge it as that hook.
    - It helps the jabs of the facecam clip, a close webcam (in time and right kind 1 → 6 of 24). It converts
      no straight of the blind close-camera set (their straights that fire as hooks are bent at the decision),
      and there it turns one real looping hook into a straight: 29 instead of 30 of 140 in time and of the
      right kind. Kept until the user's own recordings can judge it (§7, lead decisions).
  - V3-3: lean.z gates on the face's own size (`leanZFaceCap`, `leanZFaceSigma`, `leanZTwistFace`). Off by
    default.
    - With cap 1 + twist 2, the lite model's frames at lean.z ≤ −0.3 on the facecam clip drop 33 → 24
      (≤ −0.62: 3 → 1; full 10 → 9).
    - But noisy players' back dodges after a 15 cm step reach the dodge level in 35.7 % of their frames
      instead of 39.5 % (test floor 38 %).
  - V3-4: a body-height straight while the other hand's faster hook swings is its counter-rotation
    (`otherHookMs` 80). Only for a straight begun with the hook: within `otherHookLeadMs` 20 ms of its onset
    (R-C). A combo's body straight follows the hook, so it counts again (thrown 80 ms after the other hand's
    hook: 119 of 144 synthetic combos, 123 without V3-4).
  - V3-5: a slow, deep scoop from the guard, with the arm bent at its bottom, is spared the picture's
    pull-back test like a fast upright rise (`pullBackScoopDip` 0.5, `pullBackScoopMinY` −0.3,
    `pullBackScoopMaxX` 0.5, `pullBackScoopMaxDrop` 0.35). Never the hand coming back up from a body shot.
  - COM07 still holds: a retraction never fires (tests: gesture-recognizer COM07, gesture-real-fix V2-1,
    gesture-v3-fix V3-1).
* Refix round (R):
  - R-A: neither upright-rise exemption holds for a fist that RESTED at its lowest point away from its home,
    so the pull-back test judges such a rise like any return home.
    - Rested = within max(`restBandMin` 0.1 SW, `restBandShare` 0.1 × its dip) of that point for ≥
      `restLowMs` 150 ms, with the fused extension there ≥ `restAwayX` 0.3.
    - Not within `recoverMs` of this hand's own punch, and not with the fist out in front in 3D
      (`restMaxFwd` 0.4 AL): those are a body shot's hold.
    - An uppercut's dip flows into its drive (real uppercuts rest at most ≈ 133 ms at the bottom). A hand
      dropped to the hip or the belly that pauses there and comes back up is a return: with the real-like
      noise the synthetic drop-to-hip gestures, which pause at the bottom, fire 3 punches in 24 trials
      instead of 17, and at most one of the 3 is an uppercut (13–15 of the 17 were).
    - Only drops that pause (about 80 ms or more) are fixed. A hand dropped to the hip and snapped straight
      back up to the guard WITHOUT a pause still fires an uppercut as often as before: 9 of 24 trials with the
      real-like noise, 12 of 24 at 60 fps (BASE 0). At 15 fps the rule barely helps (13 → 10 of 24 for a paused
      drop), and with the bench's default noise a drop to the belly still fires 20 of 24 (BASE 12: that noise
      reads the fist as out in front). A fix needs real recordings of such drops and would trade against
      uppercut recall (§7, lead decisions).
    - Cost: an uppercut that pauses 120–250 ms at the bottom of a belly-deep dip registers 3–4 of 96
      synthetic trials less often.
  - R-A: no picture-only straight whose fist went down ≥ `imgDropOutY` 0.3 SW and out to its own side ≥
    `imgDropOutX` 0.1 SW — a hand dropping to the hip. None of the 161 picture-only fires that matched a
    labelled real straight moved like that, but the rule shifts a few neighbouring fires on the real clips:
    with the lite model two right-kind straights of one clip are lost while three uppercuts become timely
    (pooled hits unchanged).
  - R-B … R-E: see V3-2, V3-4 and V3-1 above.

### input/calibration.js — owner: input
```js
export class CalibrationSession {
  constructor({ latency /* number | () => number */ })
  update(pose, tMs) /* → {step:'frame'|'guard'|'right-hand'|'punch-right'|'punch-left'|'done', progress, stepProgress, message,
                          ok, done, result, hint, stuck} */
}
```
Steps: framing; a 1 s guard hold (the head's offset over the shoulders, tilt); raise your RIGHT
hand (label swap, arm length); three punches per hand, the raised RIGHT hand first (head height, depth
scale, suggested sensitivity). The calibrate screen shows one instruction at a time, popping up over
the live preview with the step's own progress ring (no step list; the page carries `data-step`). `result.latencyMs` stores the measured camera → game latency (§4.6);
`result.neutralHeadRel` the head over the shoulder centre in SW (gesture.js's sanity check for the
per-bout neutral). `neutralHead`, `neutralShoulderY` and `shoulderWidth` stay in the result as
metadata only (storage.sanitizeCalibration requires them). The punch steps cross-check the raise
step: two punches with the other hand and none with the asked one contradict it. If the raise step
found swapped labels and the first (right) punch step had not already confirmed them (two or more of its
punches), left and right are swapped back to the default, once ("Left and right looked swapped —
fixed!"). Otherwise the punch steps never swap by themselves (R1, RV-INPUT-03): the right hand is
asked for once more (step 'right-hand' again, in our own body-only words: "Quick check: raise your
own RIGHT hand high above your head …"), with hands not judged for the first `recheckSettleMs`
(600 ms); only a second raise that agrees with the punches changes the labels, and then that punch
step starts over. Event messages (wrong hand, swap fixed) skip the 300 ms
debounce and stay up 1.5 s. The frame and guard steps return `stuck: true` after 15 s with a skip
hint (the calibrate screen's tip then suggests its "Skip for now" button).
`tooFarSW` is 0.07, the same as the camera check.
A punch step's depth-compression sample keeps the largest raw depth extent of that hand within
`punchDepthFollowMs` (150 ms) before and after the fire, and the step waits for its last sample. The
recognizer's early decision fires before full extension, and a retraction-confirmed punch fires after it.

### input/synthetic.js — owner: input
`makeSyntheticPlayer({seed, noise, distance, lateral, lead})`, `sequence([{action, ms}])`,
`syntheticPoseFrames(script, opts)`, `SYNTH_ACTIONS` (idle, guard-high/low, jab/cross, hooks,
uppercuts, body straights, body hooks (`hook-body-left/right`: the elbow low by the side), lean-left/right, duck, twist-left/right, raise-hand, pause, wave,
scratch-face, walk-away, arms-down, point …). Used by unit tests, the e2e run and `injectPose`.
`lead: 'left'|'right'` (default 'left') is the hand the scripted player holds forward: 'jab' throws
with it and 'cross' with the other hand, and a right-lead player's torso and feet turn the other way.
Real players may stand either way and the recognizer reads each hand by itself, so it stays tested on
right-lead players too.
'point' is a deliberate one-handed point at the screen, kept as a false-punch test move: the hand
goes up high first (about the top of the head) for ~1 s, then aims at the screen a little below
shoulder height (steady for 1.5 s, then wandering a little) while the free arm hangs down. The
recognizer must not fire on it (§3 gesture.js: strokes that start from a raised hand are rejected).
R5: `{preset: 'real-like'}` (`SYNTH_PRESETS`, `withPreset`) models MediaPipe VIDEO-mode output.
- `randomPlayerOptions(seed, {preset})` keeps every default draw (about 30 % of the players lead with the
  right hand) and varies a few preset values on its own stream.
- The model: less and correlated jitter, depth ≈ 3–9 mm and not compressed, ≈ 4 ms lag, the head and
  shoulders moving with every punch.
- New knobs, whose defaults keep the old generator (the three jitter correlations at the values it always
  used, the others off): `imageNoiseRho` / `worldNoiseRho` / `zNoiseRho`, `handLagMs`, `punchYawGain`,
  `punchShiftM`, `frameDrop2Rate` (two frames dropped in a row).
- `dip: false` uppercuts from a high guard drive at least 12 cm up (R1).
- The defaults are unchanged and stay the gesture bench's headline.

### input/tutorial-detect.js — owner: input (pure)
`TUTORIAL_STEPS` (`stance, guard-face, punch-face, guard-body, punch-body, dodge`),
`TUTORIAL_DETECT` (1 s holds, 3 detections, 10 s cap, dodge thresholds 0.42 / 0.42 / 0.62),
`isStance`, `stanceHeld`, `isGuard`, `guardHeld`, `punchMatches(event, 'head'|'body')`,
`dodgeDetected(control)`, `leanReleased(control)`, and
`new TutorialStepTracker().setStep(step, t)` / `.update(playerInput, t) → {step, progress01, count,
need, heldMs, done, reason:'hold'|'count'|'cap'|null, ok, dodge}`.

### input/camera.js, pose-tracker.js, player-assigner.js — owner: input
```js
export async function listCameras()
export async function openCamera({ deviceId, width=640, height=480, video, onEnded, onInterrupted, mutedErrorMs })
  // → cam {…, stop(), isEnded(), endedError()}
export async function openVideoFile(urlOrFile, { video })        // loops a clip as a fake camera
export class CameraError { code, message, help, source:'camera', title }; export const CAMERA_ERROR_TITLES; export function cameraStoppedError()
export class PoseTracker { constructor({numPoses, model, delegate, basePath}); async init(); detect(video, tMs); close();
                           latencyMs /*rolling median*/; getStats() /* {…, detector} */; kind /*'main'*/; lastCallWorked; rewatch() }
export class WorkerPoseTracker extends PoseTracker { kind /*'worker'*/ }; export function workerDetectionSupported()
export class TrackerError { code, message, help, source:'tracker', title, devHint }; export const TRACKER_ERROR_TITLES, SETUP_DEV_HINT
export class PlayerAssigner { constructor({ players:1|2 }); assign(frame) }
```
Every PoseFrame from the tracker carries `timing {latencyMs, source, captureTime, readyTime}`.
TRACKER_DEFAULTS (repair round): `workerStallMs` 5000 counts live page time only, `workerPageStallMs`
1000 (a `detect()` gap longer than this is page time, taken out of the in-flight frame's age;
RV-PERF-01), `slowGpuMs` 90 with `slowGpuRecheckMs` 3000 (the worker's second look) and
`slowGpuSevereMs` 270 (switch at once; RV-PERF-02). Importing pose-tracker.js wraps `globalThis.fetch`
with the telemetry guard (`blockMediapipeTelemetry`; a pass-through for every other host), and
pose-worker.js installs it on the worker's `self` at module scope (R5).
A camera that stops mid-session (FLOWS-02): the track's 'ended' event calls `onEnded(err)`; a track
muted for longer than `mutedErrorMs` (2.5 s) calls `onInterrupted(err)`, and `onInterrupted(null)`
once frames come back; `cam.isEnded()` lets the hub catch a track that ended without an event
(checked every 250 ms). Errors carry a player-facing `title` and `source` ('camera' | 'tracker');
help texts name the screens' "Try again" button and never tell players to run npm scripts (the
developer remedy, `devHint`, goes to the console once). The assigner remembers where a live owner
vanished: the same-size track back in place within 10 s reclaims the slot in about 0.5 s after a
dropout over 1.2 s (0.04 SW of joint travel or 1 s not static, instead of 3 s), except while both
versus slots are free (INPUT-08).

PERF-06 (input round), the trackers:
```js
openCamera({ …, frameRate /*30*/ }) → cam {…, frameRate, maxFrameRate, refusedFrameRate, async setFrameRate(fps) /*→ the rate it runs at*/}
tracker.takeFrames(tMs)        // every other finished pose, oldest first (detect() returns the oldest); maxQueuedResults 6
tracker.pipelineStats(now)     // {camFps, detFps, detFpsMin, detMs, waitMs, queueMs, returnMs, capToSeen, capToPose, poseToGame,
                               //  capToGame, frames, windowMs, ageMs} (stages {p50, p90}, the last pipelineWindowMs 2 s); resetPipeline()
tracker.setCameraFps(fps)      // the polling fallback may detect up to the camera's rate
tracker.canPrepare; async prepareSwitch({model?, delegate?}) → {model, delegate, buildMs}; async commitSwitch({keep, reason}) → {…, warmMs}
async revertSwitch(); async discardSwitch({prepared, kept}); detector /*'worker' | 'main' after a fallback*/
tracker.switchGate /*() => safe to switch now (the hub's)*/; tracker.slowGpu /*{median, reason} — the verdict left to the hub*/
```
`setFrameRate` keeps the size (a 60 fps mode that changes the picture is undone and remembered in
`refusedFrameRate`). The worker tracker's `prepareSwitch` starts a second pose-worker.js (the same
telemetry guard), primes it with a real frame and keeps it; `commitSwitch` activates it (the frame in
flight still answers through the old worker), `keep` holds the old one for `revertSwitch`; a fallback to
the main thread stops every worker (the hub then drops a switch it had under way). The main-thread
PoseTracker builds the prepared landmarker on the page's thread and its `commitSwitch` runs one warm-up
inference there (the freeze RG3 keeps out of rounds). `workerInitTimeoutMs` 45000,
`workerRequestTimeoutMs` 15000; `slowGpuRecheckMs` 8000 and `slowGpuSevereMs` 1000 (were 3000 / 270:
the adaptive render quality frees a starved GPU within ≈ 5 s, before the second look).

### input/input-hub.js — owner: input
The **only** thing the app talks to for gameplay input.
```js
export class InputHub {
  constructor({ bus, mode, players, video, profiles, model, deviceId, keyboardAssist, gestureTuning, videoSource,
                detector /*'worker'|'main', default ?detector= or 'worker'*/, autoActivity /*follow the bus, default true*/ })
  async start(); stop(); dispose(); async setMode(mode); setPlayers(n); setCalibration(i, cal); setProfiles([{ calibration }, …])
  setActivityMode(on); activityMode   // PERF-02 pose budget (§2); also follows APP_SCREEN 'opponent' / 'camera-setup' / 'calibrate', MATCH_INTRO, TRAIN_START
  async setDetector('worker'|'main'); lastDetectMs   // main-thread ms of the last update()'s detection (0 if none; 0–1 with the worker)
  setSensitivity(0..1)             // every recognizer, live and future (Settings → app → here)
  setGestureTuning(partial); setKeyboardAssist(on); async setModel(m); async setCamera(id); async setVideoSource(src)
  update(nowMs)                    // → { players: PlayerInput[], status }
  latencyMs                        // camera → game ms (median capture→pose + 30 ms processing), null for the keyboard
  latestFrame(); calibrate(i) /* CalibrationSession bound to player i, fills result.latencyMs */
  recorder; injectFrames(frames); async replay(recording)
}
```
Emits `Ev.INPUT_TRACKING_LOST/FOUND` (debounced), `Ev.INPUT_PUNCH` and `Ev.INPUT_ERROR` (now with
`title` and `source`). `status` adds `poseMode` ('setup'|'activity'), `searching`, `poseSwitches`,
`detector`, `lastDetectMs`, `errorTitle` and `errorSource`. `start()` is re-callable after phase
'error' (D12): it reopens the camera, re-attaches the tracker's frame callback and keeps the player
slots (same bout, same corner); a tracker failure mid-bout is recovered the same way with a fresh
tracker; a muted camera that recovers returns to 'running' by itself. HUB_TUNING adds
`activityExtraPoses` 0, `othersMemoryMs` 8000, `poseSwitchGraceMs` 2500, `detector` 'worker',
`cameraCheckMs` 250.

PERF-06 (input round; the mechanism is in §2 "Pose rate and lag"):
```js
hub.modelPref /*'auto' | 'full' | 'lite' (Settings)*/; hub.model /*'full' | 'lite' running*/; async setModel(pref)
hub.renderPressure   // {behind, rateBehind, starved, headroom, gpu, judged, activity, session, starting?, detFps, camFps, wantFps, detMs, at} | null
hub.setRenderState({atFloor})   // the app, every frame: the render has nothing left to give (or a fixed quality)
hub.safeToSwitch     // menus, between rounds, after a bout, paused
status.pipeline      // §2; the model / camera / delegate switches each {at, from, to, why, ok, urgent?, kept?, reverted?, buildMs?, warmMs?,
                     //  before? after? judgedIn? crossContext?, dropped?, error?}
```
HUB_TUNING keys: `cameraFps` 30, `camera60` true, `targetDetectFps` 30, `behindRatio` 0.9, `behindDetectMs` 25,
`headroomDetectMs` 18 / `headroomDetectMsSetup` 30, `minJudgedFrames` 15, `starvedRatio` 0.8, `liteAfterMs` 8000,
`liteMaxWaitMs` 20000, `fullAfterMs` 30000, `fullKeepsUpRatio` 0.8, `fullCostRatio` 1.6 (`…Min` 1.2, `…Max` 2.2),
`fullProbationMs` 30000, `fullRetryMaxMs` 600000, `camera60TryDetectMs` 11, `camera60KeepDetectMs` 14, `camera60MinRatio`
0.85, `camera60BehindMs` 3000, `camera60RetryMs` 20000 (`…MaxMs` 300000), `delegateAuto` true, `delegateAfterMs` 15000,
`delegateTrialMs` 6000, `delegateGain` 1.15, `delegateKeptMs` 60000, `delegateRetryMaxMs` 240000, `delegateBaselineMs`
2000, `delegateTrialMaxMs` 120000, `switchPrepareMaxMs` 30000, `urgentRatio` 0.5, `urgentAfterMs` 10000,
`switchFailWaitMs` 60000 (`…MaxMs` 600000), `switchMaxFailures` 3, `modelSwitchGraceMs` 6000, `governorMs` 250,
`settleJudgeMs` 1000, `eventWindow` 20. Merge-fix (the second pipe verification's RG1–RG4):
* **RG1** the hub follows the activity from the bus (MATCH_INTRO / ROUND_START / the start bell / TRAIN_START on;
  ROUND_END / KO / RESULT / TRAIN_END off; APP_PAUSE / APP_RESUME). Any screen other than the pause or
  tracking-lost card ends the activity — also while paused: quitting from those cards emits neither APP_RESUME nor
  MATCH_RESULT, and the menus used to be judged like a bout (lag counted, starvation timers running).
* **RG3** a mid-activity (urgent) switch only for a gapless tracker: `_gapless(t)` = two-phase and detecting off the
  main thread (`tracker.detector` / `kind` not 'main'). A switch prepared in a worker that then fell back is dropped
  (not counted as a failure) and wished for again at the next safe moment.
* **RG4** a delegate trial is judged like with like: the hub keeps the running landmarker's judged rates per context
  ('round:<poses>' while fighting and not paused, 'other:<poses>' otherwise; one tracker window skipped after a
  context change or a new landmarker; 40 samples kept), the commit keeps the old landmarker's, and the verdict
  compares the trial's median (delegateTrialMs into a context) with the old one's in the same context (≥
  `delegateBaselineMs` of samples). A trial whose old landmarker was measured in a round is judged only in a round;
  none within `delegateTrialMaxMs` (the player left) → the most-sampled context against the old rates pooled
  (`crossContext`). The verifier's case (GPU 16 poses/s in the round, 22 between rounds; the CPU 24 in the round) is
  now kept, judged in 'round:1' against 16.
* **RG4-SIDE** (merge-refix; the merge verifier: judging in the next round made lost trials revert mid-round — its heavy
  governor run 5 mid-round changes against MERGED's 1, its fluctuating-load grid 81 against 56). A round's rate is no
  higher than the rate between rounds (busier render and main thread), so a trial that must be judged in a round but
  whose rate between rounds (`other:<poses>`, the same `need` samples) stays under `delegateGain` × the old landmarker's
  in-round rate is lost already at that safe moment (`entry.early`, judgedIn 'other:…'). An in-round verdict that loses
  goes back at once only when the trial is clearly worse (below the old rate ÷ `delegateGain`); otherwise it waits for
  the next safe moment (`entry.revertAt` 'safe', phase 'revert-wait'; urgent starvation meanwhile reverts a gapless
  tracker at once). The verifier's runs: heavy 1 mid-round change (worker) and 0 (main thread), the fluctuating grid
  57, MERGED 1 / 1 / 58; its trialAcrossPhases case is still kept (16 → 24 in 'round:1').

### input/keyboard.js — owner: input
Same output shape as GestureRecognizer (`DEFAULT_KEYMAP`, `describe()` for help screens).
P1: `J`/`K` straights, `U`/`I` hooks, `N`/`M` uppercuts; hold `Shift` → body, hold `E` → power punch;
hold `Space` high guard, `B` low guard; hold `A`/`D` lean, `S` duck, `X` lean back, `W` lean in;
`Esc`/`P` pause; mash punch keys to get up. P2 (versus): `1`/`2` straights, `4`/`5` hooks, `7`/`8`
uppercuts, hold `3` body, `6` power, `0` high guard, `9` low guard, arrows lean/duck/lean in,
`/` lean back. In single player the P2 keys drive P1 too. The P2 keys also work on the number pad:
Num 0–9 and Num / like 0–9 and /, plus Num . (low guard) and Num − (lean back); the top-row key is
the first key of each action (help.js names it).

### input/preview.js — owner: input
`drawPreview(ctx, video, frame, { mirrored, players, highlight })`.
The menu hand pointer (`input/hand-cursor.js`) was removed on 2026-11-08 at the user's request; menus are
mouse / touch / keyboard.

### game/combat.js — owner: combat (pure)
```js
export const COMBAT = { /* health 10 wedges, damage, counters, latency windows, slow motion, rate limits */ };
export function resolvePunch({ attacker, defender, punch, now, rng, tuning, noDamage })
  // → {result:'hit'|'blocked'|'dodged'|'miss', damage, dealt, counter, heavy, powerPunch, knockdown, hpBefore, hpAfter, stunMs, chip: 0}
export function punchSpec, travelMs, guardFor, openTarget, humanDamage, evasionFor, isLeaning, isDuck, dodgeLeanFor
export function travelMs(kind, isHuman, speed, tuning, powerPunch, atExtension)   // atExtension → COMBAT.atExtensionTravelMs (30 ms)
export function stallMsFor(e, isHuman)      // the renderer's hit-stop for a hit (mirror of render/fx.js FX_TUNING.hitStop)
export function netOfStall(realMs, stallMs) // a real-time span expressed in game ms after that stall
```
New COMBAT fields: `hitStop` (the fx tiers — a unit test keeps the two tables equal),
`atExtensionTravelMs` 30, `forwardLeanThreshold` 0.62, `leanInMin` 0.42; repair round (R2):
`freshDodgeMs` 700 and `freshDodgeResetMs` 400 (below); polish round: `duckSlipK` 0.25 (below);
`freshDodgeBobMs` 6000, `freshDodgeBobOnsets` 2, `freshDodgeProvokeMs` 900 (bobbing, §3 game/match.js).
Health is in **wedges** (10). Player ordinary hit 1.2 + 0.5·power², counter ×2.5 capped at 4,
±30 % variance; a knockdown when a clean hit's damage ≥ the health left (an ordinary hit never
floors a fighter above 1.5 wedges). Blocks do 0 damage. Guards cover zones (high = head, low =
body); a sideways lean dodges straights either way, uppercuts either way unless the head is also
ducked or tilted forward (a ducked or forward head stays in an uppercut's path — so every dodge
posture leaves some punch open, R2 / RV-RULES-01), and hooks when it leans away
from the arriving glove, a duck dodges straights and hooks, a forward tilt (lean.z ≥ 0.62, D3)
dodges what a duck dodges (straights and hooks, not uppercuts), a back lean (lean.z ≤ −0.62, an
≈ 11 cm sway) dodges head punches; only a real attacker lean-in (lean.z ≥ `leanInMin` 0.42) eats
into the back lean — the AI's +0.28 travel animation does not (D4). `PunchResolution.dodge` and
`MATCH_DODGE.how` can be 'forward'; `isLeaning` and `Boxer.isDodging` count the forward tilt;
body shots can't be leaned away from. During a clear sideways lean only a real duck counts: lean.y ≤
−(0.42 + `duckSlipK`·|lean.x|) (`isDuck`; −0.67 at |x| 1). A webcam slip's natural head dip (−0.46 at
|x| 1 in the real clip) is a slip for every punch kind; a keyboard A/D + S (y −1) stays a duck
(polish round). A camera punch (`atExtension`) makes contact 30 ms after
recognition (two 60 fps steps: the AI's slip still works against it); keyboard punches keep the
100 / 120 / 130 ms out-stroke (D5). A human's defence is judged at impact + `latencyMs` (−60 / +60 ms). Rate limit 0.2 s
per hand, 0.1 s between hands. A counter needs the opponent's punch out / its glove hanging, or
the post-dodge window of a FRESH dodge (one per opponent punch / per dodge): the dodging posture
was entered ≤ `freshDodgeMs` (700 ms) before the deciding defence sample, or after the punch's tell
began; a posture ends only after `freshDodgeResetMs` (400 ms) back in the stance. A held posture
still evades (the D3 geometry is unchanged) but opens neither the slow motion, nor the counter
window, nor a glove-hang counter (R2). `PunchResolution.leanSince` (dodged: when the deciding
sample's posture began) feeds that rule; `resolvePunch`'s `punch.stepIn` (an AI step-in, below)
reaches like a full attacker lean-in (D4).

### game/boxer.js — owner: combat
`new Boxer({id, name, isHuman, appearance, stats, ai, tuning, latencyMs})` (every boxer is orthodox:
`leadHand()` 'left', `rearHand()` 'right'); `toView()` →
`BoxerView` with `hp` in wedges (0..10), `maxHp` 10, `hp01`, `reeling`, `covering`, `resting`,
`windup {tellMs, held, powerPunch}`, `punches[]`. No daze, no stamina, no regeneration.
`tryPunch(input, t, {stalled})` → punch | 'buffered' | null: during a hit-stop (`stalled`) a punch
whose glove may not go yet is queued, one per hand, the newest wins (D6). `showBlow(req, t)` shows a
glove at full extension pulling back (debug knockdowns). Body parameter `stunGuardMs [ordinary,
heavy]`: the game-ms span the reel keeps the guard open after an ordinary or a heavy hit; each hit's
stall pulls in the reel, guard-open and chain ends already running, so the 900 ms reel-chain cap is
real time. Repair round (R2): `Boxer.dodgeSince` — when the human's current dodging posture began
(null while not leaning; a posture ends only after `freshDodgeResetMs` back in the stance), carried on
every defence sample as `since`. Punches carry `windupStart` (an AI punch's tell start), `stepIn` and
`heldDodge` (set by the Match when a held posture dodged it); `midPunchFor` skips a `heldDodge` punch,
so its hanging glove is no counter chance. Wind-ups carry `answer` and `stepIn`. `receive()` opens
the counter window only when `res.freshDodge !== false`. Merge-fix: the view adds `tracked` (display
only: false while a human's ControlState is untracked, when its hands show the stance pose and its guard and
lean are none — combat sees exactly that, as before; the renderer holds the last tracked hands over a short
dropout, §3 renderer.js; always true for the AI).

### game/ai.js, game/roster.js — owner: combat
```js
export const ROSTER = [ /* 10 original opponents in ladder order */ ]  // {id, name, nickname, tier, rating, appearance, stats:{hp:10, power, speed}, ai:{§4.5a/b fields …}, intro}
export const RATINGS = [120, 280, 450, 600, 750, 900, 1050, 1200, 1400, 1600]
export function opponentById(id); export const CHAMPION
export class OpponentAI { constructor(def, rng, {latencyMs, tuning}); update(dt, now, self, foe, view) → {guard, lean, punch|null};
                          readFor(punch, t, self); reset(t); newRound(n); setScript(step|null, t); setLatency(ms) }
export const AI_DEFAULTS, SCRIPT   // SCRIPT: passive tutorial opponents per step (jabs into the guard, power hooks to dodge)
```
Per-opponent first attack, gaps, tells (ordinary ≥ 0.17 s, power ≥ 0.55 s + latency), strings,
body/power share, read chances, slips, punishes, punch-into, cover-ups, reel, miss recovery,
stay-down chances and rise counts follow research/mechanics.md §4.5 (re-tuned E values listed in
roster.js). Names and looks are our own. Repair round, then the polish round:
* **One punish per blocked exchange (RV-RULES-03).** The first block of an exchange rolls
  `punishPct`; later blocks within `exchangeMs` (700 ms) share that roll, and nothing rolls while a
  punish is planned, cocked or in the air (until its impact + `punishedMs` 300 ms). A punish that can
  only start late keeps the opponent's normal tell (it never collapses to `COMBAT.minTellMs`).
  Against a held dodge posture every blocked punch may roll as soon as no punish is pending
  (`turtlePunishEach`).
* **Punishing a masher (polish round, R10, §2.4; our own design, E).** From #5 up (`punishIntoGlove`
  1; #1–#4 0), a blocked punch that comes within `punishMashMs` (1.0 s) of an earlier green ring, or
  on a steady beat (the last three gaps within `punishBeatTol` ±25 % of their median, at most
  `punishBeatMaxMs` 1.6 s), is not punished
  at the measured delay, because a keyboard guard is back up by then. The punish waits unseen for the
  next punch, within `punishArmMs` (1.3 s) of the ring (1.2 × the beat when longer); if no punch
  comes, none is thrown. A player who mashes (`punishMashChain` 3 punches in a row, each within 1.0 s
  of the last, with a guard shown in between) is treated this way on every punch, also right after
  the last counter, and stays a masher across clock restarts. When the opponent is free as the punch
  starts, it catches it (max(read, `streakBlock`), even if its counter is already out) and counters
  into it, landing `punchIntoMs` (0.17–0.23 s) after that punch started, while the glove is out.
  Every other punish is thrown as measured; no wind-up is cocked and lowered.
* **Body reads follow the player (polish round, R10, E).** From #5 up (`bodyReadAdapt` 1; #1–#4 0),
  when more than `bodyReadFree` (0.55) of the player's recent punches go to the body (EMA
  `bodyReadEma` 0.15 per punch, start 0.2), the body read rises toward the head read, all the way at
  100 %. While that holds, the opponent's resting guard is low, a cover-up covers the body, and the
  guard set after a reel covers the body.
* **Held-posture answer (our own design, E; R2).** A dodge posture held `postureAnswerMs` (1000 ms) is
  answered: every planned counter (punish, slip, punch-into) and `postureAnswerPct` (0.5) of the
  other punches become a punch that posture does not evade and the guard does not block (an uppercut
  under a duck or a forward tilt, the other hook against a sideways lean, a body shot under a high
  guard, a step-in against a back lean), using only kinds in the opponent's `punchMix`. A zone counts
  as guarded if the guard covers it now or the player keeps it there between punches ('none' only
  after 700 ms without a guard). Opponents with `holdWhileLeanMs` pull a held punch back and re-throw
  it as the answer, but only when an answer exists (no cock-and-pull-back loop); `answerNext` is spent
  only when the answering punch is returned. The reference does not show this answer. So is a
  posture the player keeps bobbing back into (in a posture ≥ `postureDutyPct` 0.55 of the recent
  time, EMA over `postureDutyMs` 2 s), answered as the posture it bobs into, also between two dips.
  The posture and that share are followed across clock restarts (the share moves at most 100 ms per
  look).
* **Two-sided roster (R3).** `node dev/sim.mjs` checks three bots: 'player' keeps the §4.5c
  targets no worse than before; `FLOORS`: 'casual' ≥ 90 % against #1–#4, ≥ 25 % against each of
  #5–#9 and ≥ 15 % against #10 (R9), 'mid' ≥ 55 % against #7 and #8. The re-tune eased the knobs that
  hurt weak players most (#7 body guard, #7/#8/#10 cover-ups, #8 flurry guard, #7/#10 punish delays
  and damage); the values and the repair round → polish round tables are in research/mechanics.md
  §4.5 d. Polish
  round: #10 at §4.5a's damage (25 % power at 3.5, ordinary 1.1) with 3.8 s gaps in round 1 and 1.7 s
  after; #5 head guard 0.94; #9 head guard 0.69, `attackGuardMul` 0.85, attack gap 5.1 s
  (research/mechanics.md §4.5 d).

### game/match.js — owner: combat
```js
export const RULES, FAST_RULES; export function mergeRules(...), drawTiming(rng, spec)
export class Match {
  constructor({ bus, mode:'single'|'versus', p1, p2, rng|seed, rules, fast, combat, id, latencyMs, tutorial })
  start(now); update(dt, now, {p1, p2}, {stalled}); pause(); resume(); isPaused(); isOver(); getResult(); getView()
  setLatency(ms); setTutorialStep(step) → bool; endTutorial() → bool
  debugSetHp(id, wedges); debugKnockdown(id, {stayDown?, riseCount?, hand?, kind?, target?}); debugEndRound()
  lastBlow   // the last clean blow (attacker, hand, kind, target)
}
```
`{stalled}` (MatchSession passes `renderer.timeScale < 1`) goes on to `Boxer.tryPunch`.
`debugKnockdown` records a synthetic blow (Q6): `MATCH_HIT {knockdown, synthetic: true, attacker, hand,
kind, target, hpBefore, hpAfter: 0}` (default: the scorer's rear straight to the head), then
`MATCH_KNOCKDOWN {blow}`; the scorer's glove shows at full extension, the renderer's hit-stop, burst and
KO replay follow as for a real blow; stats are untouched. A KO `MatchResult` carries `finalBlow`.
Up to 3 rounds; the clock shows 3:00 and runs 1 game-s per 0.333 s (`roundRealMs` 60 s). Stages
(`view.stage`): INTRO `arena` · ROUND_START `banner → flyin → ring → fight` · FIGHTING `live` (or the
tutorial step) · KNOCKDOWN `fall → down-call → count → ko-call → ko-hold` · RECOVERY `rise →
standoff → fight` · ROUND_END `bell → hold` · BETWEEN `arena` · DECISION `decision` · RESULT `result`.
Count 1.08 s per number; refill on rising 8 / 6 / 4 wedges; **no TKO** — the 4th knockdown is
always a KO; the clock never cuts a count short; human get-up meter 5 / 7 / 9 punches (arm pumping,
activity ≥ 0.3, adds up to 2.5 a second) with the earliest rise at counts 4 / 5 / 7; opponents roll their stay-down chance, else rise at
normal(mean, 1.2) clamped 3–9. A FRESH dodge of an AI punch by a human opens the slow motion
(§6.3, decision R2): `MATCH_DODGE` carries `fresh` (and `how`), with `counterWindowMs` 0 when not
fresh; a non-fresh dodge marks the AI punch `heldDodge` (no glove-hang counter either).
Judges score decisions (never observed in the footage); draws possible. `getResult()` locks once
(MAT04): at the KO call for KOs, at the decision otherwise.
Bobbing (polish round, R10, our own design E). The Match notes each start of a human dodge posture
(`Boxer.dodgeSince` moved) made while the clock runs (FIGHTING, after the clock started; never in the
tutorial or a stoppage), in live fight time (`liveT`), and whether an attack was coming: the AI had a
wind-up or a punch out, or began a wind-up at most `COMBAT.freshDodgeProvokeMs` (900 ms) before. A
dodge is not fresh (no slow motion, no counter window) when, in the last `freshDodgeBobMs` (6 s) of
live time up to its posture's start, `freshDodgeBobOnsets` (2) or more posture starts had no attack
coming, this one included: dips on a rhythm, not dodges (`_trackOnset`, `_bobbing`).

### game/progression.js — owner: progression (pure)
```js
export const PRO_THRESHOLD = 1000, SKILL, BASE_RATINGS, GLOVE_UNLOCKS   // unlocks at best rating 1000 and 1600
export function skillDelta({result, playerId, opponent, playerSkill}); applySkill(profile, delta)
export function applyBout(profile, result, {playerId, opponent})  // → applySkill fields + opponent state; pass to storage.recordMatch
export function nextBout(profile) → {opponent, rating, rematch, reason:'first'|'next'|'rematch'|'fallback', index, wins, base}
export function describeBout({profile, bout}) → {player:{name, rating, pro}, opponent:{id, name, nickname, rating, pro}, rematch, reason}
export function resultsSummary(update | before, after) → {before, after, delta, pro, becamePro, lostPro, bestBefore, bestAfter, unlocked}
export function ratingHistory(profile, {limit, withStart}); needsTutorial(profile); isNewProfile(profile)
export function isPro(x); ratingOf(x); bestRatingOf(x); isGloveColorAllowed(profile, hex); unlockedGloveColors(x); nextOpponent(rating|profile)
```
Win Δ = round(75 − R/135) − 20 if knocked down once − 35 if twice − 10 if it went to round 3
(minimum −10); loss −40 KO / −25 decision; draw +5; PRO at ≥ 1000 (losable). New exports
`ratingCap(def|id)` (an opponent's raised-rating cap: the next rung's base + 100, so #1 380 … #9
1700; the champion and anyone outside the roster 1725) and `recentOpponents(profile, n)` (the last n
single-player opponent ids, oldest first). SKILL: `nextWithin` 150, `rematchWithin` 150,
`rematchTarget` 100, `cooldown` 2, `fitTolerance` 100, `capAboveNext` 100.
Matchmaking (§7.2 band, RULES-04): the next unbeaten opponent once rated ≤ R + 150; else the beaten
opponent rated R + 50 … R + 150 nearest R + 100, skipping those met in the last 2 bouts while another
fits; once every opponent is beaten and rated below R + 50, the top three take turns (the
highest-rated not met in the last 2 bouts — the champion every third bout); else the nearest fit
within 100 of the band; else a straight in-band rematch. Beaten opponents rise 60–125 per win,
capped at `ratingCap`; ratings saved above the cap read as the cap. `reason` 'next' is always
≤ R + 150, 'rematch' always inside the band, otherwise 'fallback'. After the first win the next
card is the next rung (#2), then the first opponent returns inside the band.
Versus never changes the rating (PRG02).

### core/storage.js — owner: progression
```js
export class Storage {
  constructor({ backend, now, idGen, watch })   // watch: follow window 'storage' events (automatic for window.localStorage)
  syncExternal(key|null) → boolean; subscribe(fn) → unsubscribe; dispose()   // FLOWS-04: other tabs
  listProfiles(); sessionProfiles(); getProfile(id); createProfile(data); updateProfile(id, patch); deleteProfile(id)
  guest(); exportProfile(id); importPortable(json)
  recordMatch(profileId, result, skillUpdate, {side, opponentName})
    // → {ok, saved, error?, reason?, outcome, skillBefore, skillAfter, summary:{before, after, delta, pro, becamePro,
    //    lostPro, bestBefore, bestAfter, unlocked, opponent}, profile}   idempotent by result.id (SES02), one write
  markTutorialDone(profileId); recordTraining(profileId, result); settings(); saveSettings(patch); status()
}
export function saveNotice(saveResult)
export function graphemes(s), clampName(s, max)   // user-perceived characters (Intl.Segmenter, code-point fallback)
```
Profiles carry `skill` (the rating), `pro` (always isPro(skill)), `bestRating`, `tutorialDone`,
`opponents {[id]: {wins, losses, draws, beaten, rating}}`. ERR04: a failing backend returns
`{ok:true, saved:false, error}`; guests and visiting (portable) boxers are never written (SAV01).
Two tabs (FLOWS-04): every write re-reads its key first (adopts another tab's newer copy; a rating
update computed from an older copy is applied as a delta); settings saves merge only the patched
keys over a fresh read (volume sub-keys too); the index merges boxers created or deleted elsewhere;
a boxer deleted elsewhere is forgotten and never written back (SaveResult `errorCode: 'deleted'`,
and the results card says why). Subscribers hear about every external change; the app re-applies
another tab's player-side settings live and leaves a deleted boxer's menu for the boxers screen.
Names (FLOWS-11): strings only (anything else → "Boxer"); ZWJ/ZWNJ kept inside names, bidi controls,
ZWSP and the BOM stripped; at most 16 user-perceived characters (and 64 code points); the profile
editor applies the same limit in an IME-safe input handler (no `maxlength`). Deleting needs a
second press at least 600 ms after arming (FLOWS-07). Settings (PERF-06): `rev` = `SETTINGS_REV` 2 and
`model` 'auto' (the default) | 'full' | 'lite'; a save without `rev` holds 'full' whenever anything was saved
(it was the default), so that 'full' becomes 'auto' while an old 'lite' (a real choice) stays; from rev 2 an
explicit 'full' is kept.

### training/* — no owner this pass
```js
// training/activity.js  TrainingActivity({bus, rng, participant, latencyMs}); start(now); update(dt, now, input); getView(); isDone(); getResult(); pause(); resume()
// training/bag.js, dodge.js, mitts.js   BagPractice, DodgeDrill, TargetPunching (TRN01)
// training/medals.js    MEDAL_CUTOFFS, medalFor(kind, score), nextMedal (TRN02)
// training/session.js   TrainingSession({participants, kind, seed}); current(); createActivity(opts); record(); retry(); next(); screenParams()
```
Training uses the bout's punch timings (TRAINEE_COMBAT, so camera punches make contact 30 ms after
recognition there too); `latencyMs` widens its judged graces. `TrainingActivity.update(dt, now,
input, {stalled})`: TrainingRun passes `renderer.timeScale < 1`, so a punch recognised during a
drill's hit-stop pop is queued like in bouts (D6).

### render/renderer.js — owner: view3d
```js
export class GameRenderer {
  constructor({ canvas, bus, quality, reducedMotion, fast })
  setScene('menu'|'match'|'training'); setSplit(1|2); setFast(bool); setReducedMotion(bool)
  renderMenu(dt); renderMatch(view, dt); renderTraining(view, dt)   // dt = REAL seconds
  timeScale                 // game-dt multiplier during hit-stop (the session applies it)
  playOutro({result, view, fast?}) → Promise<void>; skipOutro(); outroActive
  resetMatch(); resize(); dispose(); debugState() /* {scene, shot, hitStopMs, meters:{p1,p2:{visible,value}}, slowmo, outro, cuts,
                                                      quality, lost, ownFade:{p1,p2:{left,right,head}} …}
                                                      (ownFade: 0 = the normal look, 1 = faded; R8) */
  three /* {scene, renderer, camera, cameras, arena, fx, rigs, meters, screen} */
  contextLost               // the WebGL context is lost (the app pauses the activity meanwhile, D10)
  setExternalFrameCost(ms)  // main-thread ms this frame spent outside rendering (InputHub.lastDetectMs); also opts.externalMs on the render calls
  async prewarm({p1, p2, versus}) → {programs, ms, skipped?}   // D11: build both models, compile every program; never throws
  adaptive                  // the AdaptiveQuality (PERF-06): the app calls setDetectionPressure(), reads frameDivisor / atFloor / enabled
}
export function replayCameraPose(angle, A, L, k, pose), outroStagePose(moment, W, k, pose), harmless(hitEvent)   // pure, for tests and tools
export function holdLostView(boxerView, mem, nowMs, holdMs = RENDER_TUNING.lostHoldMs)   // VIEW3D-LOST-FRAME (below), pure
```
Adaptive quality (`render/adaptive.js` AdaptiveQuality, PERF-03): it judges the frame interval minus
the external main-thread cost, steps down only after two slow windows (pixel ratio, then shadows
2048 → 1024), and steps back up after 10 s of headroom (shadows first; a step-up that has to be
undone doubles the wait, up to 80 s). PERF-06 adds the pose detector's pressure (§2; ADAPTIVE_TUNING):
a GPU detector behind for `detBehindShare` (0.6) of two `detWindowSec` (1 s) windows in a row takes one
step (one window and two pixel-ratio notches when below `detFarBehind` 0.5 of the wanted rate), then
`detSettleSec` (1 s) passes before the next judgement; on displays of `capAboveHz` (105 Hz) or more the first
step is the frame cap (`frameDivisor`, ≈ `frameCapHz` 60) and it is the last one lifted; lag alone stops at
`detLagMinRatio` (1.25) and never lowers the shadows; while the detector starts a fast display is capped at
once; steps up need `detHeadroomShare` (0.8) of a window's reports with headroom, and without a GPU detector
reporting the detection steps come back after `detReleaseSec` (2.5 s) each, and nothing learnt for the GPU
detector (ceilings, a context's headroom requirement) holds them back; every notch of a far step counts as a
detection step (a far step took two and counted one, so the quick release stopped one notch short — the merge
verifier's RG2-CPU-CEILING: the pixel ratio held at 1.5 for the rest of a GPU ceiling after detection moved to
the CPU, now back at 2 in 2.5 s steps), and a far step at 1.25 takes the last pixel-ratio notch only (it used to
flag the shadows as lowered without lowering the shadow map). RG2, per hub context ('<session>/<activity>';
merge-fix, flat ceilings and evidence in the merge-refix): a level that starved detection after a fair chance —
reached by a step up (a probe), or held for `detFairSec` (6 s); a descent's quicker steps, taken while the hub's
2 s figures still held the level above, set none — is off-limits in that context for a flat `detCeilingSec`
(120 s), `detCeilingRateSec` (480 s) when a probe starved the RATE within `detQuickSec` (20 s: a big cost jump,
e.g. the step to pixel ratio 2 on a Retina screen) and `detCeilingSlowSec` (100 s) when the probe held 20 s
first (a borderline level). Each horizon belongs to its level (a long one for 2 and a short one for 1.75 end on
their own); none grows. Quick probe failures instead double the continuous headroom the context needs before its
next probe (10 → 80 s, `upMaxSec`; back to 10 once a probe holds `detProbeOkSec` 60 s or a ceiling is lifted):
at a borderline level the headroom comes and goes with the scene and a long requirement is rarely met, while after
a load ends the level below runs freely and meets it (headroom counted while a ceiling blocks carries over). The
level a context held `detGoodSec` (20 s) without a detection step down — detection keeping up, or nothing left to
give, like lag at the 1.25 floor — is the level it settled at; entering a context that settled lower within
`detMemorySec` (600 s), or whose ceiling holds lower, goes straight there (one change, `why: 'context'`) unless
nothing changed while away. A ceiling is lifted early once its level's median stays at or below `detLiftRatio`
(0.7) × the median measured there while the ceiling's load ran (`detLiftRefWindows` 5 windows) for `detLiftSec`
(8 s) with headroom. Modelled (the merge verifier's own sim-rg2-vm.mjs, 10 seeds; MERGED → previous merge →
now): the L1 run's changes in 101.5 s 2–8 → 2–4 → 2–4; recovery after a 180 s load ends, worst / median, ×1.15
163 / 81 → 246 / 12 → 151 / 31 s, ×1.25 163 / 15 → 143 / 20 → 133 / 20 s, ×1.35 138 / 50 → 261 / 40 → 141 / 48 s,
×1.5 151 / 95 → 271 / 26 → 131 / 41 s, ×1.6 and ×2 equal or better; realistic bouts (90 s rounds, menus between)
at detector speeds 0.6 / 0.9 / 1.1: 3.38 / 0.54 / 0.66 → 1.59 / 1.00 / 1.13 → 1.42 / 0.71 / 0.92 changes per 100 s,
the most in any 100 s 8–9 / 2–5 / 2–6 → 5–6 / 4 / 4 → 5–6 / 2–4 / 2–4, mid-round changes and the share of
round time with detection behind below MERGED's in each (the extra changes against MERGED at 0.9 / 1.1 are the
menus climbing and the bout's entry going straight back down). A detection step says why on the console
(`[render] pose detection on the GPU is behind (22 of 30 poses/s, median 38 ms) — giving it GPU time: pixel
ratio 1.5`), and the renderer's own `(render share)` line names it (`… (for pose detection: rate)`); a change
may carry the pixel ratio and the shadows together. `debugState().quality` adds frameDivisor, displayHz,
detSteps, detDown, detection, ceiling {steps, sec, of, refMs, levels} (the binding level, its seconds left and
length, every running horizon), context, remembered {settled (also as `good`), waitSec} and lifts.
**VIEW3D-LOST-FRAME** (merge-fix): a human BoxerView from an untracked frame (`tracked: false`, §3 boxer.js)
shows the stance pose, which made the stiff own gloves (R11) twitch there and back and slid the live camera.
Within `RENDER_TUNING.lostHoldMs` (250 ms) of the last tracked frame the renderer keeps that frame's hands,
guard, lean and phase (idle / guard / dodge) for the model and the camera (`holdLostView`, one memory per boxer
slot; nothing is held over a punch, a hit or a fall); a longer loss shows the stance pose as before (the
tracking-lost pause follows). On the real clips' 10 short dropouts the gloves stayed 92 mm (max 331) from where
a perfect tracker would have put them, against 306 mm (max 539) snapping, with the path's frame-to-frame
acceleration at the no-dropout level (6.3 against 14.3 mm/frame²; the merge-refix springs). `prewarm` builds both boxer models for the bout's looks (the
match reuses them) and compiles the scene, FX pools, meters, screen overlays and both material sets
of each model (solid and ghost) through `compileAsync`, then restores the ghost states: the app
calls it while the VS card is up (and early in versus and on the direct `skipTo('match')` path), so
bout 1 compiles no program at the arena intro or at "Fight!" (PERF-04).
Listens on the bus: MATCH_HIT (hit-stop tiers, bursts, hit cut, meters), MATCH_BLOCK (green ring),
MATCH_DODGE / MISS (red streak), MATCH_SLOWMO (smear), MATCH_KNOCKDOWN / COUNT / GETUP / KO / RESULT,
MATCH_CALL, MATCH_WINDUP (power tell). Emits `Ev.RENDER_CUT {kind, viewer, durationMs}` on each
hard cut (`player-hit` 350 ms / 1600 ms on a knockdown blow, `player-hit-heavy` 650 ms,
`knockdown-wide`, `player-down`, `standoff`, `round-intro`, `fight`) and `Ev.RENDER_OUTRO
{stage, winner, method}` (KO: start, wipe, flash, replay, banner, winner, end; decision / draw:
start, flash, banner, winner, end). No referee is drawn.

### render/boxer-model.js, camera-rig.js, fx.js, meter.js, replay.js, screen-fx.js — owner: view3d
`BoxerModel(appearance, {ghost, role})` (always orthodox: left lead, left foot forward) with
`update(view, dt)`, `setGhost`, `setFallStyle`,
`snapTo`, `setOwnFade({left, right, head})` (fades only the ghost material set: each glove to
`OWN_FADE_LOOK.glove` 0.3 opacity, without depth writes; the head set to `OWN_FADE_LOOK.head` 0.1 × its
ghost opacity), `partSpheres(out)` (world spheres of the skull, each glove and, with `out.face`, the
face), `handBusy(hand)`, `attacking()` (from a punch's wind-up until the glove is home), `ownFade`;
`gloveWorldPosition` / `headWorldPosition`. The player's own boxer (R11): its gloves sit where
HandState puts them (hands weight 1; a guard adds only its posture cues — elbows, chin, crouch — and
pulls the gloves `guardGloveHuman` 0 toward the drawn guard pose), and its gloves, head, spine and hips
run a one-euro style tracking filter (`ANIM.track`): the stiff springs `w…Human` (gloves 50, head 40,
spine 31, hips 30 since the input round — total lag no worse than the polish build's: the gloves keep its
ω 50 as the recognizer's hand lag is unchanged and its glove display lead is off (`displayLead` 0, §3
gesture.js R4: these springs own the glove lag), and the spine and hips are as soft as the 10 ms the merged
recognizer's lean lead (`leanLead`) gained allows; measured ramp lag at 30 Hz input ≈ 30–35 ms for the
gloves from 0.12 m/s,
≈ 57–61 ms for a lean from 0.5/s, the head showing a lean ≈ 65 ms after the pose with the recognizer's own
4 ms (polish ≈ 68); curve in ANIM's comment) while the input moves, and calm still springs while it holds still (gloves ω 15,
9 in a held guard — the default is 26; head 15, spine 14, hips 12 as before), capped below 24 Hz input
so a slow camera's samples never show as steps. Hands drifting as slowly as tracking noise (≈ 0.06 m/s;
≈ 0.12 m/s in a held guard) are smoothed like a still pose (≈ 90–100 ms, 6–11 mm behind). Punches, hit
reactions (0.7 s after a blow), falls, the get-up, the outro poses and every AI boxer keep their
springs. `CameraRig` (methods `hitCut`, `takeCut`; getter `ownShift`; module exports `RIG_TUNING`,
`Shot`, `CINE_SIDE`, `leanSlide`, `leanDeadzone`, `viewportFollowScale(fov, aspect, cap = true)`;
`clampInRing` is module-private). `render/own-fade.js`: `OwnFade` (`update(dt, camera, own, foe,
shift)`, `reset()`, `value`, `cover`), `OWN_FADE`, `circleCover`. `FX` (`hitStop(ms)`, `hit`, `block`, `trails`,
`speedLines`, `hitStopMsFor`; `FX_TUNING.hitStop` must equal combat's `COMBAT.hitStop`, which nets
real-time timers against it). `style.js`: `VENUE_LIGHTING` (the arena: a warm spotlit key, low
fill, a near-black navy hall and warm dark stands) vs `LIGHTING` (neutral studio light for the
portraits and dev pages).
`HealthMeters` (on-hit meters: show the pre-hit value, drain 0.6 s later, shards, blinking edge
cell, hide 3.2 s after a hit unless ≤ 3 wedges, dark during the count, refill sweep on rising).
`ViewRecorder` + `planOutro` (the KO replay clip and the outro timeline). `ScreenFX` (smear,
tint, logo wipe, white fades).

### ui/* — owner: hud
```js
export class UI {
  constructor({ root, bus, storage, input, audio, modules, video })
  show(screen, params) → Promise<{action, …}>; hide(); toast(text, opts); nav(action); update(dt, now, opts)
  current /* {id, params, done} */; isOpen; menuOpen; hud /* Hud */
  gateOpen; whenGateClear() → Promise   // D14 small-screen card
}
```
* **Activation:** menus are mouse / touch (`source` 'pointer') and keyboard (`source` 'keyboard':
  arrows or Tab move, Enter or Space choose, Esc or Backspace go back, P pauses / continues); an
  activation emits `Ev.UI_CLICK {id, screen, source}`. Start over, Skip tutorial, Quit (pause) and
  Quit to menu (tracking-lost) act at once. Buttons keep the `data-cursor` attribute as their control
  id (focus, keyboard navigation, return focus, `UI_CLICK` ids; the name is historical and kept, so
  `[data-cursor]` selectors keep working). `update(dt, now, {controls})` hands the per-player
  ControlState to the screens. The camera clicks nothing; besides boxing, its only gestures are pause
  (both hands above the head), Continue on the pause card (hands up again), the tracking-lost card
  carrying on by itself `UI_TUNING.lostResumeMs` (0.5 s) after the player's hands are back in view
  (2026-11-10; it used to need a 2 s guard hold) and skipping the KO outro (both hands up).
* **Hands warning (2026-11-10):** while a human player's hands are lost in a live activity that can pause
  (`ControlState.tracked === false`: the recognizer drops a player once a hand has been out of view for its
  `lostAfterMs`), `App._hudExtras` sets `handsWarning[i]` and the HUD shows "Please keep your hands visible"
  (`.gu-handswarn`, top centre; `handsWarningText()` names the player in versus). The hub's
  `HUB_TUNING.lostMs` (1000 ms, was 600) is that warning's window before INPUT_TRACKING_LOST pauses the
  activity; the card then says "We can't see your hands" when the player is in the picture without them.
* **Sound-off badge (D13):** while `audio.needsGesture` the UI shows "Sound is off — click or press
  any key to turn it on" at the top centre, until a real click, tap or key press unlocks audio.
* **Small-screen gate (D14):** below 700 px wide, or in portrait narrower than 3:4, a full-screen
  card ("Turn your screen sideways" / "Make the window bigger") covers the menus (never a running
  activity or its overlays), blocks keys and clicks behind it, re-checks on resize and offers
  "Continue anyway" (remembered for the session). The app starts the camera once it is gone.
* **Pause card and the lost picture (repair round, RV-FLOWS-04):** `pause` params add `reason`
  ('user'|'hidden'|'tracking'|'graphics') and `graphicsLost` (a getter). While `graphicsLost()`: the
  line "The picture dropped out — the game waits here until it comes back.", Continue
  `aria-disabled` (keeps the keyboard focus), and `back()` (Esc, P, the hands-up
  gesture) a no-op with one "no" sound per press (≥ 250 ms apart). Once restored: "The picture is
  back.", Continue enabled and focused unless the focus was moved to another card button. Start over,
  Skip tutorial and Quit work. On windows ≤ 480 px tall the card is tighter and the hint under the
  buttons gives way to that line.
* **Screens changed in the fix pass:** `tracking-lost` takes `kind` ('match'|'training': "The drill
  is paused.") and, while `input.status.phase === 'error'`, shows the camera error (its `errorTitle`,
  message and help) with a focused "Try again" that awaits `input.start()` (FLOWS-02); the bout stays
  paused until the player is back with both hands in view (0.5 s) or Resume. `training-result`: back → `{action:'done'}` on every turn,
  non-final turns add "End session". `calibrate`: a `.gu-calib__tip` line shows `state.hint` (when
  `stuck`, it also suggests "Skip for now"). `camera-setup`: tracker errors get
  their own titles (prefers `errorTitle`; "Pose model missing", "Pose-tracking files missing", "Pose
  tracking couldn't start"). `settings`: Controls follows the hub's live mode; a volume slider saves
  only its own key; Tracking is Auto / Lite / Full (PERF-06: "Auto picks Full, or Lite when your computer
  can't keep up"; an explicit choice is applied at once and never changed by the hub). `profiles`: re-renders on another tab's changes and focuses a boxer just
  created or edited (FLOWS-06). `help.js` exports `MOVES`, `calibrationText(n)`, `setupCards()`,
  `keyRows()`, `p2KeysText()`; its keyboard tab and calibration card read the real keymap and
  `CALIBRATION_DEFAULTS` (through the new `deps.js` entry 'calibration').
* **Camera check stays ready (ERR01, `camera-setup`; user request 2026-11-08):** a player becomes
  ready once fully in view (`playerVisibility(pose).ready`: head, shoulders, both hands, a sensible
  size) for `UI_TUNING.readyHoldMs` (2000 ms) in a row, and then STAYS ready on this screen — chip
  "P1 ready" (`data-state="ready"`), Continue and Recalibrate enabled, label "Continue" — even after
  stepping out, dropping a hand or turning away (to reach the touchpad or mouse). Only a camera change
  in the picker, a camera / tracker error being shown, or a stale feed (no fresh frames for > 1.5 s,
  the screen's `stale` test) clears it; then the player needs 2 s in view again. Fully in view but not
  yet 2 s: chip `partial`, "Looking good — hold it…"; otherwise as before (`missing`, or `partial` with
  the visibility hint). Continue reads "Waiting for you…" (1 player) / "Waiting for both boxers…" (2)
  until every required player is ready. Each required player locks on their own (versus: both must;
  a locked P1 stays locked while P2 gets ready). The first time everyone is ready, focus moves to
  Continue, so Enter / Space continues too. The e2e `camera-latch` scenario plays it through.
Screens: `title`, `profiles` (+ `profile-editor` with glove unlocks), `mode`,
`camera-setup`, `calibrate`, `vs` (alias `opponent`: the VS card — {opponent, profile, bout} →
`start`|`back`), `pause` (Continue / Skip tutorial / Start over / Quit), `tracking-lost`, `result`
(aliases `decision`, `versus-result`: decision reveal / winner card → `continue`), `results` (alias
`skill`: rating graph, Δ, PRO and unlock moments, ERR04 notice → `next` = Play again | `menu` =
Quit), `training-select`, `training-result`, `records`, `settings`, `help`.
```js
export class Hud {
  show('match'|'training', opts); hide(); update(view, extras); updateTraining(view)
  showTutorial({step, index, total, title?, caption?, progress01?, mode?, skipHint?}); hideTutorial()
  outroStage({stage, winner, method}) /* subscribed to Ev.RENDER_OUTRO itself */; clearOutro()
  banner(text, opts); setPip(on); setMirror(on)
}
```
The HUD draws name plates, our round clock with three lamps (hidden when `view.clockVisible` is
false), the text calls (from `view.call` / `Ev.MATCH_CALL`, count numbers from `view.count`), the
get-up hint for a downed human, the tutorial card, the outro's Replay tag and win banner, and the
webcam picture-in-picture. No health bars: health is the 3D meters. The Replay tag is our own
marker (`.gu-replay > .gu-replay__mark`: a coral badge with a replay arrow that turns backwards,
then `.gu-replay__text` "Replay", in the dark pill at the bottom left). During the whole outro the
HUD root carries `.is-outro`, which hides the versus divider and the P1/P2 tags (FLOWS-05). A new
tutorial card starts with no check and an empty bar (`.is-resetting`, VISUAL-12).

### audio/* — owner: audio
```js
export class AudioEngine { constructor({ bus, volumes }); unlock(); setVolume({master, sfx, music, voice});
  playSfx(name, opts); music(name|null); say(text); startCrowd(); stopCrowd({fade}); getVolume(); state() /* {…, needsGesture} */
  needsGesture /* true until the context can run */ }
export const CALL_KINDS; export function callLine(call, opts)
```
Every sound is synthesized live (WebAudio). `unlock()` never creates or resumes the AudioContext
without real user activation (`navigator.userActivation.hasBeenActive`, or an 'allowed' autoplay
policy) and never reports unlocked while silent; the pointerdown / keydown / touchend listeners stay
until the context runs (D13). It follows the bus: MATCH_CALL (one voice line and one
bell per moment), MATCH_SLOWMO (time-slow whoosh, crowd pitched down), RENDER_CUT (cut thud),
RENDER_OUTRO (wipe, flash sting, replay drone, result jingle at 'banner', the `results` loop at
'end'), APP_SCREEN (menu music on hub screens such as `opponent` and `mode`). Repair round: the
"counter ready" cue on MATCH_DODGE plays only for a fresh dodge (`fresh !== false`, R2), and the
announcer picks among on-device voices first (`localService !== false`), using an online voice only
when there is no local English one (R5).

### app/* — owner: integration
```js
// app/session.js
export const SESSION_TUNING; export function deriveSeed(base, n), humanCorner(profile)
export class MatchSession {
  constructor({ bus, renderer, hud, mode, players, opponent, seed, fast, latencyMs /* number|fn */, tutorial, inputMode, onTutorialDone })
  begin(); restart(); pause(); resume(); update(realDt, now, inputs); render(realDt, hudExtras); releaseHud()
  // update() passes Match.update(…, {stalled: renderer.timeScale < 1}); TrainingRun does the same for drills
  over /* result locked */; handoff; result; view; finished /* outro over */; whenFinished() → Promise
  tutorialActive; skipTutorial(); outroActive; skipOutro(); canPause; humans; nameOf(i); debug()
}
export class TrainingRun { constructor({ bus, renderer, hud, kind, participants, seed, fast, latencyMs /* fn(participant) */ }) … }
// app/tutorial.js
export const TUTORIAL_TUNING   // steps, capMs 10000, doneMs 1100, holdMs 1000, count 3, fast {capMs 4000, doneMs 200}
export class TutorialRunner { constructor({ match, hud, mode, fast, onDone, onStep }); update(now, input, view); skip(); state(); active; finished; log }
// app/app.js
export const APP_TUNING; export class App { constructor({params}); async boot(); flowSingle({direct, opponent, tutorial}); … }
```
The app (fix pass): pauses the activity while `renderer.contextLost` (pause reason 'graphics',
never refused by the resume guard; the player continues once the picture is back — FLOWS-09);
passes `kind` to tracking-lost; hands `input.lastDetectMs` to `renderer.setExternalFrameCost()`
every frame; calls `renderer.prewarm()` on the VS card (and early in versus, and on the direct
path); switches the hub to the activity pose budget in `blackout()`; starts input after the
small-screen card is gone; passes `?detector=` to the hub; re-applies settings saved in another tab
(volumes, PiP, mirror, reduced motion, sensitivity) and returns to the boxers screen when another
tab deleted the boxer in play. Repair round (RV-FLOWS-04): `requestPause` passes `reason` and
`graphicsLost` to the pause card and never resumes while `renderer.contextLost`: a resume while lost
(Continue, or the tracking-lost resume) shows the card again with reason 'graphics', and "Skip
tutorial" while lost ends the tutorial at once and brings the card back without that button. (Start
over while lost restarts the bout, which then pauses again about 30 ms later — allowed.) PERF-06 (input
round): every frame the app hands `hub.renderPressure` to `renderer.adaptive.setDetectionPressure()` (the public
getter since the merge; app.js no longer reaches into `renderer._adaptive`), tells the hub
`setRenderState({atFloor: !aq.enabled || aq.atFloor})`, and renders only every `aq.frameDivisor`-th display
frame (the frame cap on fast displays); `state().input` adds model, modelPref, delegate, latencyMs and
`pipeline` (the hub's status.pipeline). The debug overlay (`app/debug-overlay.js`) prints the pipeline line
after the detector line: `pipe cam 30 (seen 30) det 30 (min 29) fps  cap→pose 18  pose→game 3  cap→punch 25 ms
auto→full GPU`, with `STARVED` or `BEHIND` and a switch under way (`delegate→CPU ready`).

## 4. Debug & test hooks
* URL params (`app/params.js`): `?detector=worker|main` (where pose detection runs; default the
  worker), `?input=keyboard|camera|replay|synthetic` (synthetic: no camera,
  frames only from `injectPose`), `?debug=1` (overlay: input, ControlState, stage, latency, slow
  motion, tutorial, outro), `?fast=1` (10 s rounds, short stages, a ≤ 1.5 s outro, 8 s drills),
  `?seed=123`, `?tutorial=0|1` (first-bout tutorial never / always; default: a new boxer's first
  single-player bout), `?rec=<url>` (with input=replay), `?video=<clip>`, `?quality=low|high`,
  `?calibrate=1`, `?skip=<screen>`.
* `window.__glove` (present once the app has started, one frame after src/main.js runs, so the loading screen
  paints first; tests poll for it): `{ app, bus, input, ui, renderer, audio, storage, feeder,
  injectPose(action, ms, {player}), stopPose(player?), state(), skipTo(target, opts), pause(),
  skipOutro(), skipTutorial() }` plus the getters `match`, `training`, `session`, `tutorial`.
  `skipTo` targets: `title | profiles | mode | single | match | versus | training | bag | dodge |
  mitts | records | settings | help`; opts `{profileId, opponentId, tutorial}`. `state()` returns
  `{flow, screen, screenDone, inputMode, curtain, profile {…, tutorialDone, bestRating},
  activity {phase, stage, round, clockMs, clockVisible, count, call, slowmo, latencyMs, tutorial,
  outro, over, finished, result, p1/p2 {hp, phase, knockdowns, guard}, stats}, render {shot,
  hitStopMs, meters, slowmo, outro, cuts, lost, quality, prewarm}, input {phase, tracking, fps, error,
  errorTitle, detector, poseMode, numPoses, …, model, modelPref, delegate, latencyMs, pipeline}, saves, errors}`
  (PERF-06: `input.pipeline` is the hub's status.pipeline, §2; `render.quality` is the adaptive quality's state,
  with frameDivisor, detSteps, detDown, ceiling, context, remembered and lifts).
* `?debug=1` also shows where detection runs, the pose count and mode, the main-thread
  detection ms, and (PERF-06) the pose pipeline: camera / detection rates, capture → pose, pose → game and
  capture → punch medians, the model choice and delegate, `STARVED` / `BEHIND`, a switch under way.
* `dev/input-lab.html` shows the same pipeline as badges (rates; p50 / p90 per stage; auto → model with the
  pending one; behind / headroom / starved; a switch under way) next to the measured latency, and its Settings
  row picks Auto / Full / Lite.
* tests/e2e.mjs is importable (`runScenarios`, `summarize`, `Skip`, `Check`, `scenarios`,
  `isLocalUrl`, `CLIP_FILE`) and runs only when executed. Its summary is `N passed, M skipped, F
  failed` (a scenario can `skip()`; the clip scenario does without its git-ignored clip). Its browser
  resolves no host but the local server and a scenario fails on any request to another host; each
  e2e server uses its own Vite dependency cache (`GLOVE_VITE_CACHE_DIR`, default
  `test-results/.vite-e2e-<port>`). The `sound-badge` scenario runs in its own browser with the
  default autoplay policy and reads the page over CDP without a user gesture. Repair round:
  - tests/e2e.mjs also exports `selectScenarios`, `SLOW`, `LAUNCH_ARGS` and the input helpers
    `retryUntil`, `holdUntil`, `knockDown`, `winByKO`, `pressDuringOutro`.
  - Requests are collected for the whole browser context (page and detection worker). The
    `telemetry` scenario closes landmarkers on purpose and checks the guard counters (R5);
    `telemetry-60s` (opt-in: `scenario(name, fn, {optIn: true})`) waits past the logger's 60 s timer.
  - Nothing waits for a short-lived state from outside the page (LEAD-01): `knockDown` checks the
    phase and knocks down in one page task; `ko` presses Enter from the knockdown until the outro
    reports the skip and plays another bout (up to 3) if a fast outro still ended unskipped; the page
    records the outro's Replay tag and win banner itself; steps a loaded machine can delay (a hold)
    are repeated until the page shows the effect.
  - The suite browser runs with `--disable-speech-api`: with speech, headless Chromium answered the
    runner seconds late during spoken counts (the announcer falls back to beeps there).
  - With `E2E_GL=swiftshader`, camera, camera-retry and telemetry can time out (detection at about
    2 per second).
* `scripts/fetch-models.mjs` exports `MODELS` (pinned URL, bytes, sha256), `setupModels`,
  `fetchModel`, `copyWasm`, `SetupError` and takes `--root DIR`; pins: lite `float16/1`, full
  `float16/latest?generation=1682642787774579` (full's `float16/1` is a different file).
* Pose injection runs through the real PlayerAssigner → GestureRecognizer (`app/pose-feeder.js`).
* `GLOVE_NO_HMR=1 npx vite …` serves without hot reload or file watching (the e2e run sets it).

## 5. Look & feel checklist (all render/ui owners)
Bright, soft, toy-like characters in a spotlit night arena (dark warm stands, the ring under a warm
key); chunky gloves; opponent always readable; the player's own body ~50 %
see-through from behind with solid gloves (they and the see-through head fade while they cover the
opponent's face in the live view, R8), following the tracked body with little lag (R11); hit-stop
tiers per §2.8 (0.2 s player hit, 0.5 s big hit / counter, 0.7 s knockdown blow, 0.45 s heavy hit on
the player); a pink starburst on
your clean hit, a green ring on any block, a red streak on a dodged punch, orange speed lines + a
hard over-the-shoulder cut + a blue/white burst when you are hit (purple when heavy); smeared
slow motion after a fresh dodge (R2); the knockdown wide shot; the crowd reacts. All text big and rounded.
60 fps on an M-series laptop with detection on — measured in the fix pass: a live bout on the
real clip as the camera holds 60 fps at 1× and 4× CPU throttle with the worker detector (main-thread
JS 1.3–1.5 ms per frame with or without a detection). On a Retina screen the render gives a starved GPU
pose detector its time back (PERF-06): a bout at device pixel ratio 2 settles around pixel ratio 1.25–1.5
with 30 poses per second instead of drawing at 2 with 12–18.

## 6. Alignment pass — matching research/mechanics.md (contracts between owners, as built)

The first build used guessed numbers because `research/mechanics.md` landed late. This pass
makes the game play like the measured reference game. **`research/mechanics.md` is the source of
truth for feel and rules** (sections cited as §n below are its sections). Where it says E
(estimated) it is a recommendation; M/V values are measured — match them.

Owners in this pass: **combat** (game/ except progression.js), **progression**
(game/progression.js, core/storage.js), **view3d** (render/*), **hud** (ui/*), **input**
(input/*), **audio** (audio/*), **integration** (app/*, main.js, tests/e2e.mjs, README,
this file). training/* is unchanged except where integration recalibrated it.

### 6.1 Health, damage and knockdowns (combat)
* Health is counted in **wedges**: `BoxerView.hp` 0..10 (fractional), `maxHp` 10, `hp01 = hp/10`.
* No regeneration, no between-round top-up, **no chip damage** (`MATCH_BLOCK.chip` is always 0).
* Damage per §2.6/§2.10 (player ordinary 1.2 + 0.5·power², counter ×2.5 capped at 4; opponent
  ordinary per roster 1.0–1.2, power 2–4). Knockdown when a clean hit's damage ≥ the health left
  (±30 % per-hit variance, §2.9; an ordinary hit leaves 0.1 wedge on a fighter above 1.5). Refill
  on rising 8 / 6 / 4. **No TKO**; a 4th knockdown is always a KO; the clock never cuts a count
  short; no saved-by-the-bell.
* Count 1.08 s per number; stoppage per §3.1; stand-off 3.3–5.7 s after rising, then "Fight!".
* Human get-up: 5 / 7 / 9 punches for knockdowns 1 / 2 / 3, earliest rise at counts 4 / 5 / 7
  (§3.6); arm-pumping activity (≥ 0.3) adds 2.5 × activity punches a second, so pumping alone gets a
  player up in time (eased 2026-11-13 from 8 / 12 / 16 with a slow trickle: the second get-up was
  near impossible on a real webcam). Opponent rise: stay-down roll + normal(mean,
  1.2) clamped 3–9 (§3.2, §4.5b).
* `MATCH_HIT` carries `heavy`, `knockdown`, `hpBefore`, `hpAfter` (wedges), `dealt`, `powerPunch`
  (and `synthetic` for a debug knockdown's blow).
* Opponent AI per §4.1–4.6 and the roster tables in §4.5 (re-tuned E values in roster.js; the
  reasons are in its header, and research/mechanics.md §4.5 d lists the deviations and residual
  misses). Fix pass: the AI's guard comes back about 0.6–0.7 s (real) after any clean hit (per-hit
  `stunGuardMs` spans, net of the hit-stop); a reel chain is capped at 0.9 s of real time from its
  first hit; the PRO tier (#7–#10) punishes 70–85 % of blocked exchanges, once per exchange (a
  flurry into the guard is one exchange; repair round, RV-RULES-03), and a punish replaces a
  pending attack (a cocked wind-up landing 0.2–0.82 s after the green ring becomes the counter); from
  #5 up, a player who keeps punching into the guard has the next punch caught and countered while the
  glove is out, and the body read follows a player who keeps going to the body (polish round, R10);
  the cover-up lasts 0.9 s of real time. The tuning is two-sided (R3): `node dev/sim.mjs` checks the
  skilled 'player' bot against §4.5c and the 'casual' and 'mid' bots against their win floors
  (`FLOORS`; casual ≥ 15 % against the champion, R9), so the PRO tier stays beatable for weaker
  players.

### 6.2 Hit-stop (view3d) — timeScale in render/fx.js
Player's clean hit 0.2 s; big hit / counter 0.5 s; knockdown blow 0.7 s; ordinary hit on the human
none; heavy hit on the human 0.45 s (§2.8, §2.10). During a stop `renderer.timeScale` is 0.02 and
the session multiplies game dt by it, so the round clock stalls as measured; the human's own model
keeps following the player's hands. The human corner stays on match time through a stall (D6:
exempting it would make flurries far too fast); MatchSession passes `{stalled: timeScale < 1}` and a
punch recognised during a stall is queued — one per hand, the newest wins — and fires as soon as its
glove may go: it is never dropped. combat's `COMBAT.hitStop` mirrors these tiers to net its
real-time timers (reel chain, guard re-open, cover-up, the "Down" call) against them.

### 6.3 Dodge slow motion (combat owns the rule, view3d/audio the look/sound)
A human's FRESH dodge of an AI punch (decision R2: the posture entered ≤ `COMBAT.freshDodgeMs`
700 ms before the deciding sample, or after the punch's tell began, and not made while bobbing — two
or more dips with no attack coming in the last 6 s of live time, R10) emits `Ev.MATCH_SLOWMO
{kind:'dodge', dodger, attacker, scale: 0.25, durationMs: 750}` and sets `view.slowmo` (a held
posture still evades, with `MATCH_DODGE {fresh: false, counterWindowMs: 0}` and no slow motion): Match runs the AI corner, its brain and the
round clock on a separate world clock at ×0.25 while the dodging human stays real-time (the
session does not scale dt for it). A counter ends it. Versus has no slow motion. view3d: frame
smear and tint, slowed crowd and particles, the red miss streak; audio: a time-slow whoosh.

### 6.4 Text calls, stages and the clock
`Ev.MATCH_CALL {call, round, boxer?, winner?}` fires when a call should appear ('round',
'final-round', 'fight', 'down', 'ko', 'time', 'decision'); `view.call` mirrors the latest (age in s).
`view.stage` / `view.stageTime` name the sub-stage of each phase (§3 game/match.js). `view.clockVisible`
is false during intros, stoppages, breaks, the tutorial and outros. `MATCH_BELL 'start'` comes with
every "Fight!" (`restart: true` after a knockdown); no bell at a KO. Timings: §1.2, §3.1, §5.
"Down" comes 0–0.7 game-s after the knockdown blow, net of its 0.7 s hit-stop (0.7–1.4 s real,
median about 0.9 s); the stand-off median is 4.8 s; 0.4–2.2 game-s of clock are lost during the fall.

### 6.5 Bout outro (view3d + integration)
`renderer.playOutro({result, view, fast}) → Promise<void>` plays §6 "KO outro, in order": our own
logo wipe → white flash → slow-motion multi-angle replay of the final knockdown blow → white fade →
win banner moment with 3D confetti and light streaks → the winner faces the camera with the beaten
opponent behind (KO ≈ 15.8 s; decision / draw ≈ 7 s, no replay; reduced motion ≈ 9.5 s; `?fast=1`
1.45 s, a KO still keeping ≥ 0.3 s between 'wipe' and the first replay frame so the HUD's KO letters
have faded). `skipOutro()` jumps to 'end'. It emits `Ev.RENDER_OUTRO {stage}`: the HUD shows the Replay
tag and the win banner text, audio follows. **Integration**: the result is saved the moment it
locks; when the Match reaches RESULT, MatchSession calls playOutro and is `finished` when it
resolves (Enter, Esc, a `confirm` event or the hands-up gesture skip it); then decisions / draws
show the decision reveal (`result`), single player the results card (`skill`), versus the winner
card (`versus-result`). Without a renderer outro (headless tests) the session lingers 1.8 s.

### 6.6 Camera (view3d) — §6 table
Live (D18, VISUAL-03): just behind the player's head at about head height, 0.5 m off the left
shoulder (`RIG_TUNING.play`: offset [-0.5, 1.25, 0.72], fov 58; versus fov 64): the player's own
see-through head sits high in the frame beside the opponent's head, the solid gloves mid-frame and
clear of the round clock, the opponent seen whole (head to feet); body ~50 % transparent, **gloves
solid**, slow orbit of the venue. A dodge-level lean (0.42) slides the opponent about 1/4 of the
width, a full lean about 1/3 (16:9: 24 % / 33 % to the right, 23 % / 30 % to the left), as a share of
each view's own width — 16:9, 21:9, 4:3 and versus halves alike (R6) — and a dodge reaches ≥ 94 % of
that slide within 0.15 s (§2.5; the sideways lean is smoothed at `lambdaX` 20/s: 94.6–95.1 % at the
dodge level, 97–100 % at 0.7 and full; the duck and in / back terms keep `lambda` 18, and so does the
training view). A lean to the left is the mirror image of a lean to the right (R8): the camera slides
`follow.x` 0.45 m per unit of the shaped lean (`leanSlide`) and turns by the angle a look target
swinging `lookX` 1.4 m would turn it in the rest geometry, toward the lean either way; both are scaled
by `viewportFollowScale(fov, aspect)` = min(1, tan(fov/2)·aspect / (tan 29°·16/9)) (versus half ≈
0.56, 4:3 0.75; knee gain raised by `kneeNarrow` 0.1·(1 − scale)), the turn also by the uncapped ratio
in views wider than 16:9 (21:9: 22–23 % / 29–32 %). The horizon stays LEVEL, as in the reference: the
look target keeps its rest distance and height, so a sideways lean never pitches, rolls (`follow.roll`
0; training keeps its own), raises or pushes the camera; the duck / rise and back / forward terms
(`follow.duck`, `up`, `z`) are unchanged. The right lean keeps the repair round's camera position and
turn. A lean toward the camera's own side (each player's left) therefore carries the opponent's face
behind the player's own see-through head and guard: in the live shot the viewer's own gloves fade to
0.3 opacity and the see-through head to 0.1 × its ghost opacity while they overlap the opponent's
face on screen (`render/own-fade.js`: circles of view directions around the face and each own part;
~80 ms each way, two frames to fade in while the view turns toward its own side or the opponent's
punch comes; looking ahead while the view turns and, for the gloves, while the opponent lunges; held
from the opponent's wind-up until 0.25 s after its punch; during a held own-side lean a faded part
only comes back after 0.6 s clearly apart from the face, so idle drift and webcam noise never switch
it on and off; a punching glove never fades; the gloves only while the view follows a left lean, so
a resting guard never fades; only the viewer's own model in its own viewport, and never in the
round-start settle shot; tunables in `OWN_FADE`: `ms` 80, `msFast` 35, `lookahead` 0.1 s, `hold` and
`afterPunch` 0.25 s, `releaseGap` 0.3, `releaseHeld` 0.6 s, the gloves' cover thresholds `on` 0.13 /
`off` 0.09 and the head's 0.3 / 0.2; the looks in boxer-model.js `OWN_FADE_LOOK`). At the dodge level the own head stays in frame at the upper right (16:9:
≈ 92 %, 24 %). A camera-only soft deadzone (`follow.dead` 0.03–0.15, `leanDeadzone`) drops a webcam
player's lean noise; combat's lean is untouched. A damped keep-in turn (`follow.keep`) aims to hold
the opponent's head within a soft edge — identity within 0.5 ± 0.28 of a versus half's width, never
aiming past 0.5 ± 0.34 (16–84 %); in the single view 0.5 ± 0.38 and 0.5 ± 0.44 (6–94 %) — through a
critically damped turn (τ 0.12 s) of at most 16°/s (`follow.keep` `soft` 0.28, `edge` 0.34,
`softSingle` 0.38, `edgeSingle` 0.44, `tau` 0.12, `rate` 16). A held lean settles inside that edge (a single
full lean in a versus half lands at ≈ 18 % / 79 % and is pulled in by under half a degree), and it
keeps the opponent's head in view when both players lean the same way and in portrait views.
Because the turn is rate-capped, an opponent's slip or lunge never swings the arena under the
player: when the opponent slips the same way the player is leaning, its head runs on toward the edge
of the half for a moment instead (≈ 3–6 % for ≈ 0.5–0.7 s; even 25°/s would leave ≈ 8–9 %).
Player hit: hard cut to a tight, solid shot just
behind the head (alternately over the right shoulder and tight off the left cheek) for 0.35 s (0.65 s
heavy, 1.6 s for a knockdown blow), then a hard cut back (`Ev.RENDER_CUT`); the "Fight!" settle shot
starts close behind the head on the live side and settles exactly into the live pose. Opponent
knockdown: the fall plays in the fight view, then a high wide shot (≈ 2.35 m, ≈ 40° down) from
behind the standing player's left shoulder: the standing player large under the count, the downed
fighter high in the frame beside its head. Player knockdown: a raised shot (≈ 2.4 m) over the player
face-down in the foreground, the opponent waiting upright at the far side in the upper part of the
frame, the count between them. Decision: a hard cut to a side-on two-shot from inside the ropes,
the heads above the DECISION call. KO replay 'low' angle: behind the loser, 1.25 m off the punch
line at waist height, aimed at the contact point, so the loser never hides the attacker. Win banner:
the winner's face above the banner text. Round change / intro shots per §1.2. **No referee is drawn.**

### 6.7 HUD (hud) — §5, function only, our own graphics
No health bars, no stats, combos, damage numbers or hit-text popups in bouts. Name plates (face
icon, name, coloured underline). Our own round clock with three round lamps, hidden with the plates
when `view.clockVisible` is false. Text calls per §5 (count numbers centred, 47 % down). Health is
shown **in the 3D view** by view3d: an on-hit meter of 10 rounded segments beside each fighter (our
own design, not a pie), behaving as in §5 "How a pie behaves" (hidden during the tutorial; a hit
that costs no health — damage 0, like the tutorial's — never shows a meter). VS card and results card
per §5 (our own layouts). The Replay tag and the outro's `.is-outro` class: §3 ui. Menu pages get a
centred ~16:9 page in windows wider than 1.8:1 (VISUAL-15); from 1000 px wide the extra gutter grows
in with the width, with no media query and no jump: `padding-inline: max(2.5rem, min((100vw −
1.8·100vh)/2 + 2.5rem, 100vw − 1000px + 2.5rem))`. Landscape phones keep 2.5rem gutters, and the
help cards are trimmed so no help tab clips from 1024×768 to 2560×1080 (RV-VISUAL-03).

### 6.8 Progression (progression + hud + integration) — §7.5
Rating Δ formula, losses −40 KO / −25 decision, PRO at ≥ 1000 (losable), rematch ratings +60–125,
`nextBout(profile)` picks the next opponent (§7.2 band: +50…+150, nearest +100, no lock-on on one
opponent; the top three rotate once the pool is out-climbed; §3 progression.js), glove colours unlock at best ratings 1000
and 1600 (the profile editor offers them). **Integration flow**: ~0.5 s of black → VS card
(`describeBout`) → bout → `applyBout` + `storage.recordMatch` at the result → outro → results card
from `save.summary` (rating graph, Δ, PRO gained/lost, unlocks, ERR04 notice) → "Play again" goes
straight to the next VS card (the next opponent or a rematch), "Quit" to the menu. Versus: no rating.

### 6.9 First-bout tutorial (integration runs it; combat, input, hud support it) — §8
A profile's first single-player bout (rating 0 and `!tutorialDone`; guests once per session) runs
six live cards before the clock starts: `stance` → `guard-head` → `punch-head` → `guard-body` →
`punch-body` → `dodge`. The card titles are our own words (RELEASE-01): Gloves up, High guard, Head
shots, Low guard, Body shots, Slip the punch; the card sits at the lower left, directly above the
2-line caption band (D17). The keyboard captions name E (power) and X (lean back). A forward tilt
and a back lean count for the dodge card, and they dodge in bouts too (D3/D4). No caption line or
skip hint repeats a reference card title either (RV-RELEASE-05; the body-step captions read "Hold B
to cover your belly." and "Hold Shift and tap J or K for body shots.").
`app/tutorial.js` TutorialRunner drives them: `match.setTutorialStep(step)` (no clock, no
damage, a scripted passive opponent per step), `input/tutorial-detect.js` TutorialStepTracker on the
player's input plus the match's own `view.tutorial {count, holdMs}`; a card completes on a 1 s hold
or 3 detections (whichever source first), or after the 10 s cap; a completed card shows its check
mark for 1.1 s, then the next card. `hud.showTutorial({step, index, total, progress01, mode})` /
`hud.hideTutorial()`. Skip: Enter (keyboard) or pause → "Skip tutorial" (camera). Then
`match.endTutorial()` → "Fight!" (no round banner) and the clock; `storage.markTutorialDone`. The
webcam calibration stays a separate quick step before the bout for an uncalibrated boxer: its
label-swap and arm-length steps have no tutorial counterpart, so folding it into the stance card
would not be safe; the stance card re-checks framing and the steady stance.

## 7. Cross-module decisions (as built): fix pass D1–D18, repair round R1–R7, polish round R8–R11, input round

The fix pass after the alignment pass settled these between owners (D1–D18); the repair round after
its adversarial re-verify added R1–R7 (below D18), the polish round R8–R11, and the input round its own
block (at the end). Module details are in §3.

* **D1/D2 hand pointer.** A guard, a fighting stance or two raised hands never point; the pointer
  needs one hand raised high with the other arm down. Destructive buttons (Quit, Start over, Skip
  tutorial, Quit to menu) need a second dwell by hand; a hand still up from the previous screen
  can't click the next one. Resting on the pause or tracking-lost screen therefore clicks nothing.
  (removed 2026-11-08: the hand pointer was taken out at the user's request)
* **D3/D4 leans.** Thresholds stay 0.42 sideways, 0.42 duck, 0.62 back/forward. A forward tilt
  dodges straights and hooks; the back lean is a physical ≈ 11 cm sway at any distance, and the AI's
  travel animation no longer raises it.
* **D5 camera punch timing.** `PunchInput.atExtension` (camera punches) → contact 30 ms after
  recognition; keyboard punches keep their out-stroke.
* **D6 hit-stop.** The human stays on match time; punches recognised in a stall are queued.
* **D7 fonts.** Self-hosted; no third-party host at play time.
* **D8 detection worker.** Default, with the main-thread fallback (§2).
* **D9 detection cost.** `InputHub.lastDetectMs` → `renderer.setExternalFrameCost()` every frame.
* **D10 context loss.** The activity pauses while the WebGL context is lost.
* **D11 shader prewarm.** `renderer.prewarm()` while the VS card is up.
* **D12 camera retry.** `input.start()` after phase 'error' keeps the bout and the player slots;
  tracking-lost offers "Try again".
* **D13 audio unlock.** Only real user activation starts sound; a badge says so.
* **D14 small screens.** The gate card over the menus below 700 px or narrow portrait.
* **D15 docs.** This file and research/*.md are kept by the integration owner.
* **D16 our own words and graphics.** Tutorial titles and the Replay marker (§3 ui, §6.9).
* **D17 tutorial card** at the lower left above the caption band.
* **D18 live camera** at head height off the left shoulder (§6.6).

**Repair round.** The re-verify of the fix pass found that several of its changes had side effects
(a held lean or duck adopted as "upright", the PRO re-tune walling off weaker players, the wider lean
follow hiding the opponent, corner buttons out of the cursor's reach). The repair round decided:

* **R1 held postures (gesture).** Keep the head-neutral re-centring (INPUT-01/02), but remember the
  pre-adoption "home" neutral and restore it as soon as the steady pose comes back near it, so a held
  lean, duck or back lean never makes "upright" read as a dodge. Sideways homes are judged by the
  torso's world lean; forward / back (sway) homes are on probation, because forward / back has no
  absolute upright (§3 gesture.js; known cost: the first dodge toward a sway the neutral was learned
  in). Calibration's punch steps only swap left and right back to the default when nothing confirmed
  the raise; any other contradiction asks for the right hand once more (§3 calibration.js).
* **R2 fresh dodges (combat).** A held posture still evades (D3 geometry), but only a dodge entered
  ≤ `COMBAT.freshDodgeMs` (700 ms) before impact — or after the punch's tell began — earns the slow
  motion, the counter window and a glove-hang counter. A ducked or forward head stays in an uppercut's
  path even with a side lean, so every posture leaves some punch open, and as our own design (E) an
  opponent answers a posture held about 1 s with a punch it does not evade (§3 ai.js). Turtling
  (holding a dodge key plus a guard and tapping punches) no longer beats the PRO tier more easily than
  ordinary play.
* **R3 two-sided difficulty (combat).** 'player' keeps the §4.5c targets no worse than before (11 / 9
  / 11 misses of 40 cells at seeds 1 / 7 / 3, before 11 / 9 / 12); 'casual' ≥ 25 % at each of #5–#10
  and ≥ 90 % at #1–#4; 'mid' ≥ 55 % at #7 / #8. Checked by `node dev/sim.mjs` (research/mechanics.md
  §4.5 d). (Polish round, R9: the casual floor against #10 is ≥ 15 %.)
* **R4 cursor (ui; RV-FLOWS-01/02/03/05).** `boxTop` back to 1.2 (`pointAt` 0.8 stays); a hand
  resting on the head never points; while a fresh raise is required, a wrist that drops below the
  shoulder line ends the point; the small-screen card opening or closing requires a fresh raise (§3
  hand-cursor.js, ui). (removed 2026-11-08: the hand pointer was taken out at the user's request)
* **R5 no third-party traffic (platform).** tasks-vision's usage logger is answered on the device in
  both detection paths (`src/input/no-telemetry.js`); the e2e `telemetry` scenario proves it
  deterministically; README and the notices say so truthfully. The D7 line stays as is.
* **R6 lean follow (view3d).** The lateral follow is a share of the viewport's own width
  (`viewportFollowScale`), with a limited swing toward the camera's own side while the camera moves
  out, forward and up past the own head and guard, and a versus keep-in-half turn (§6.6). (Polish
  round, R8: the own-side move was replaced by a mirrored, level follow and an own-part fade, and the
  keep-in turn is damped.)
* **R7 docs.** Only the integration owner edits this file and research/*.md (the platform owner
  cleaned the research/mechanics.md Appendix B/C paths); README.md was the platform owner's this round.
* Also in the repair round: the graphics pause card says why and keeps Continue off until the picture
  is back (RV-FLOWS-04, §3 ui / app); the worker watchdog counts live page time only and the worker's
  slow-GPU check takes a second look (RV-PERF-01/02, §2); the centred menu page grows in from 1000 px
  without a jump (RV-VISUAL-03, §6.7).

**Polish round.** After the repair round's re-verify and a playtest with a real webcam (the left
dodge's camera felt out of character next to the right one; lower lag and more accurate tracking
wanted), the polish round decided (only the view3d and combat owners changed code):

* **R8 camera language (view3d).** The live camera keeps a level horizon and slides and turns on a
  lean, a left lean the mirror image of a right one (the repair round's own-side move — out, forward
  and up, pitching the view down 9–13° — read as out of character); a dodge reaches ≥ 94 % of its
  slide within 0.15 s; the own see-through head stays in view near the top; a webcam player's lean
  noise is dropped by a camera-only deadzone; the opponent's face stays readable by fading the
  viewer's OWN gloves and see-through head while they overlap it in the live shot (held through the
  opponent's wind-up and punch, steady through a held lean); the versus keep-in turn is damped and
  rate-capped (§6.6).
* **R9 champion (combat).** #10 uses §4.5a's damage again (25 % power punches at 3.5 wedges,
  ordinary 1.1). Its gaps are 3.8 s in round 1 and 1.7 s after (§4.5a 3.5 / 1.6): with §4.5a's exact
  gaps a first-timer won only 14.5–19 % against it. The casual floor against it is 15 % (dev/sim.mjs
  `FLOORS`); every other R3 floor stays.
* **R10 degenerate keyboard play (combat).** From #5 up: a player who keeps punching into the guard
  (blocked again within 1 s of a green ring, on a steady beat, or mashing with a guard shown between
  quick punches) has the next punch caught and countered while the glove is out, with nothing shown
  before and no punish thrown if no punch comes; the body read follows a player who goes to the body;
  a held posture's every blocked punch may be punished and a bobbing posture is answered; dips into a
  posture with no attack coming are bobbing, and their dodges earn no slow motion. Every ordinary
  punish is thrown as measured (§2.3); nothing is cocked and lowered. Measured over 145 strategies ×
  #5–#10, 48 bouts a cell: head, body or mixed mashing behind a held guard (every 0.45–1.5 s), single
  and combined postures plus a guard (taps or mashing), and long or short pulse turtles each win at
  most the casual rate + 10 points and are floored in ≥ 30 % of bouts against #8–#10. Open: a single
  jab every 2 s against #8 / #9 (50–56 %, as before).
* **R11 the player's own boxer (view3d).** It follows the tracked body with little lag and
  accurately: the gloves at HandState (no stance or guard-pose pull), a one-euro style tracking filter
  on its springs (stiff while the input moves, calm while it holds still, capped below 24 Hz input);
  punches, hit reactions, falls and the AI unchanged (§3 boxer-model). Trade-off left to the lead: on a
  constantly moving real replay the gloves and head show about twice the repair round's frame-to-frame
  motion. (Input round: re-tuned for the merged recognizer, below.)

**Input round.** After the polish round's playtest the user's priorities were frame rate, then lag, then
tracking and punch accuracy (jabs and hooks missed, uppercuts not working). Two lanes changed the input — the
recognizer (§3 gesture.js) and the pipe (§2) — and the merge put them together. They decided:

* **Recognizer (input).**
  - Every frame of a 60 fps camera is used.
  - Strong straights and hooks fire before their drive peaks.
  - On real people, the picture decides the pull-back, a contradicted depth is ignored, and a fast stroke may
    be classified from the picture alone.
  - The facing test uses the face size.
  - The gloves' display lead is off: the render springs own the glove lag (R11, re-tuned below).
  - The fix round (V3) and its refix (R): a same-hand double-up's second punch counts; a straight thrown
    across the picture at close range is relabelled from a hook (it helps the facecam clip only); the
    lean.z face-size gates stay off; a hand dropped to the hip or the belly that pauses there rarely fires
    an uppercut when it comes back up at 30 fps (R-A; at 15 fps a paused 600 ms drop still fires 10 of 24,
    and one snapped straight back up without a pause still can); V3-4
    only takes straights begun with the hook (R-C); 'still at the end' is only the punch's own
    follow-through (R-D).
  - Judged on a labelled benchmark of real boxing recordings kept outside the repository (TUNE c2 / c4 / c5
    for choosing, HOLDOUT c1 / c3 / facecam to confirm) and checked on a blind close-camera set (2 clips,
    140 labels). "In time" = fired at most 250 ms after the label's peak. On all six clips (649 punches),
    full model, 30 fps, from the polish build to now: in time 19.1 % → 54.4 %; in time and the right kind
    11.9 % → 39.9 %; false fires 42 → 45 (4.3 → 4.6 a minute). On the close-camera set: in time 19 % → 36 %;
    in time and the right kind 9 % → 21 %.
  - Still open: uppercuts thrown close to the camera are not recognised as uppercuts (0 of 18 in time on the
    close-camera set), close-range jabs often fire as hooks, and the drop-and-snap-back above.
* **PERF-06 pose rate and lag (input, view3d).** The render gives GPU time back to a GPU pose detector that
  falls behind (frame cap, pixel ratio, shadows; lag alone only the cheap steps), and only detection
  starvation (below 24 of 30 poses per second) moves the model ('auto': full, lite while starved at the
  render's floor) or the delegate (a trial, kept only if clearly faster). Switches are a worker swap with no
  pause, made at safe moments (from MATCH_INTRO — the tutorial — until a round ends is never one; urgent
  starvation excepted for the gapless swap only). The camera opens at 30 and goes to 60 only with a detector
  fast enough to take every frame; every detected frame reaches the game in order with its capture time
  (§2, §3 camera / input-hub / renderer).
* **Merge (integration).** The overlay's pipeline line and the public `renderer.adaptive`; the build split into
  layer chunks (core / input / game / main) under the 1000 kB warning without raising it; the second pipe
  verification's residuals: a quit from the pause or tracking-lost card returns the hub to menu state (RG1),
  the render keeps each context's memory instead of re-probing its pixel ratio after every bout or search
  (RG2), main-thread detection never starts a switch mid-round (RG3; going back from a failed trial stays immediate,
  since the kept landmarker needs no warm-up), delegate trials compare like with like (RG4).
  The merge verifier's residuals (merge-refix): GPU ceilings no longer hold the render down once detection runs
  on the CPU, ceilings are flat (no doubling: sharpness after a load ends waits about one ceiling at most) with
  quick probe failures raising the headroom a probe needs instead, a bout settled at the lag floor is remembered
  (bout → menus → bout goes straight back), and lost delegate trials go back between rounds unless clearly worse.
* **Own boxer (view3d).** With the merged recognizer the springs follow the brief's rule — total lag no worse
  than the polish build's, then as little motion as that allows: `w…Human` 50 / 40 / 36 / 32 → 50 / 40 / 31 / 30
  (the merge-fix's 47 / 40 / 28 / 25 met a 2.1× moving-jitter limit at 3 ms more glove and 9 ms more head lag
  than the polish build). Gloves as in the polish build (ramp lag 35 ms; the recognizer's hand lag is unchanged
  and its glove display lead is off, so these springs own the glove lag); a lean 54 → 61 ms in the model,
  ≈ 65 ms in all with the recognizer's own lean lag down 14 → 4 ms (polish ≈ 68);
  moving jitter on the replayed real clip 1.89 / 2.21 / 2.27× BASE for the left / right glove and the head
  (polish on its own recognizer 2.04 / 2.10 / 1.92×), still poses with dropouts 0.77–1.15× (head 1.0×). A short
  tracking dropout (≤ 250 ms) holds the last tracked hands, guard and lean in the render instead of snapping to
  the stance pose (VIEW3D-LOST-FRAME). The jitter figures were measured with the merged recognizer. On that
  replay (the clip played twice) this build's recognizer gives the same hands, guard and lean in every frame, so
  the rendered motion is the same; it fires 26 punches instead of 23, and as the measurement leaves out the
  frames near a punch, it scores 962 frames instead of 1054 and reads 1.71 / 2.27 / 2.18× (1.89 / 2.21 / 2.27×
  on the same frames). The lag is unchanged.

**Lead decisions (input round integration).** Final for this round:

* **Lag before smoothness for the own boxer.** The springs stay `w…Human` 50 / 40 / 31 / 30: the gloves' and
  the head-on-a-lean total lag must be no worse than the polish build's, because lag is the user's second
  priority. The moving jitter that costs (1.89 / 2.21 / 2.27× BASE for the left glove, the right glove and the
  head, measured with the merged recognizer) is accepted. With this build's recognizer the same measurement reads
  1.71 / 2.27 / 2.18×: on that replay the rendered motion is the same, but a different set of punch-free frames
  is scored (the Own boxer bullet above).
* **The close-range jab relabel stays** (V3-2, `hookExtMinS` 0.65): on the facecam clip 6 instead of 1 of 24
  punches register in time and as the right kind; on the blind close-camera set it costs one right-kind punch
  of 140. To be revisited with the user's own recordings.
* **The from-the-guard re-arm trade-off stays** (V3-1): +0.9 to +2.5 points of in-time recall for +1 to +4
  false fires.
* **Known limitation, not fixed this round:** a hand dropped to the hip and snapped straight back up without a
  pause can fire an uppercut, as often as in the input round's first merged build. Fixing it needs real
  recordings and would trade against uppercut recall.
* **Known limitation:** uppercuts thrown close to the camera are not recognised as uppercuts (0 of 18 on the
  close-camera set). Fixing it needs a labelled close-range tuning set, such as the user's own input-lab
  recording.
* **Both pipe defaults stay:** `HUB_TUNING.urgentAfterMs` switches the model or delegate mid-round only after
  10 s below 15 poses a second (`urgentRatio` 0.5 × 30), and `camera60` stays on, with the 60 fps camera
  tried only at a detect median ≤ 11 ms (`camera60TryDetectMs`).
