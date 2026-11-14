# Glove Up

A cartoon boxing game for the browser that you play with your body. Your webcam and
MediaPipe Pose Landmarker track your arms (punches, guard) and your head (leans, ducks). There
are no controllers. You stand in front of the camera, put your gloves up and box.

- **Single player:** box ten original opponents. The game picks your next opponent (or a
  rematch) from your rating; you turn PRO at 1,000 and can lose it again. New boxers start with a
  short live tutorial in their first bout. New glove colours unlock at 1,000 and 1,600.
- **Versus:** two people share one camera in split screen.
- **Training:** bag practice, a dodging drill and target punching (mitts). 1 to 4 players take
  turns and earn bronze, silver, gold or platinum medals.
- **Boxers:** local profiles keep their records on this device. You can also play as a guest
  (nothing is saved) or import a boxer exported from another device (a "visiting" boxer).

The game plays like a classic motion-controlled cartoon boxing game (called "the reference game"
here): its rules, timings, camera work and hit feel were measured frame by frame from footage
(`research/mechanics.md`). Everything you see and hear is our own: characters, faces, ring, HUD,
text, sounds and music. Sounds and music are synthesised in the browser and nothing is sampled.

## Setup

Requirements: Node.js 20.19+ or 22.12+ (Vite 7's minimum; `engines` in `package.json` says the
same) and a recent Chrome, Edge or Safari. The game needs WebGL 2. A webcam is optional, because
the keyboard works too.

```sh
npm ci                            # three.js, MediaPipe tasks-vision, the two fonts, Vite, Playwright
npm run setup:models              # copy the MediaPipe wasm runtime into public/, download the pose models
npx playwright install chromium   # once, only needed for npm run test:e2e and scripts/shot.mjs
npm run dev                       # → http://127.0.0.1:5180
```

`setup:models` puts `public/mediapipe/wasm/` (copied from `node_modules`) and
`public/models/pose_landmarker_{lite,full}.task` in place. The models come from Google's MediaPipe
model bucket, pinned to the exact files the gesture recognition was tuned on and checked by SHA-256
(`MODELS` in `scripts/fetch-models.mjs`). An existing file that does not match is replaced, and a
download that does not match is refused. Without internet the script stops with a one-line
message; run it again when you are online. Run it again too if those folders are missing.

After that the game requests nothing from another host. The MediaPipe runtime, the pose models and
the two typefaces (Lilita One and Nunito, self-hosted from the `@fontsource` packages through
`src/ui/fonts.css`) all come from the game's own server, so it plays offline. MediaPipe's built-in
usage statistics, which it would send to Google, are switched off (`src/input/no-telemetry.js`).
The public copy (see [Deploying](#deploying)) counts visits with Vercel Web Analytics: one page view
per visit, recorded on the game's own domain, with no cookies and nothing from the camera. Only a
build made with `VITE_VISITOR_COUNTS=1` has that counter, and it never runs on `localhost` or
`127.0.0.1`; `npm run build`, the dev server and the tests have none.
The announcer speaks through the browser's speech synthesis, with a voice the game picks by itself,
preferring one that runs on the device. In some browsers that can be an online voice (in Chrome, the
voices named "Google …", when the system has no English voice of its own), and the browser then
sends each spoken line to its speech service; with the Announcer volume at 0 (Settings → Sound)
nothing is spoken. A production build is `npm run build` (output in `dist/`,
with `THIRD_PARTY_NOTICES.txt`), and `npm run preview` serves it.

Camera access needs a secure page. `http://127.0.0.1` and `http://localhost` count as secure;
any other host needs HTTPS.

## How a bout goes

1. About half a second of black, then the **VS card**: both boxers, their ratings, PRO badges
   and a "Rematch" tag. Press **Fight!** (click it or press Enter).
2. The arena, the "Round 1" banner, the camera flies into the ring, **"Fight!"**, and the clock
   starts. The round clock shows 3:00 but runs three times as fast, so a round is about a minute.
3. Health is a 10-segment meter that pops up beside a fighter when they are hit. There is no
   health regeneration and no top-up between rounds. A clean hit on a nearly empty meter knocks
   the boxer down; they rise with 8, then 6, then 4 segments. A 4th knockdown is always a knockout.
4. A KO (or the judges after round 3) ends the bout. The replay of the final blow plays, then the
   win banner and the winner's pose (Enter, Esc or both hands up skips it). Decisions show the
   judges' cards. The results card shows your rating graph and change.
5. **Play again** goes straight to your next VS card; **Quit** returns to the menu.

**First bout.** A new boxer's first bout starts with six live cards against the first opponent,
before the clock runs: gloves up, high guard, head shots, low guard, body shots and slip the
punch. Each card moves on when you hold the pose for a second or do the move three
times (after 10 seconds at the latest). Press Enter, or pause and choose **Skip tutorial**, to
skip it. Guests see it once per session.

## Playing with the camera

**Space and distance.** Stand about 1 to 2 m back from the webcam. You need room to stretch
your arms forward and to lean a little to each side. Your head, shoulders and both hands must be
in the picture. The camera check screen tells you what is missing ("step back", "we can't see
your left hand"). Once you have been fully in view (head, shoulders and both hands) for 2 seconds,
**Continue** lights up and stays on, so you can step to the computer and click it (or press Enter)
even though your hands leave the picture; only a camera change or a camera problem turns it off
again. In versus, P1 stands in the left half of the picture and P2 in the right half, and
**Continue** waits until both of you have been in view for 2 seconds.

**Lighting.** Put the light in front of you, not behind you. A bright window behind you turns
you into a silhouette. Plain, uncluttered backgrounds track best. Posters of people are
ignored, but they cost a little accuracy.

**Calibration (about 20 seconds).** An uncalibrated boxer gets a quick calibration before their
first bout. Each instruction pops up over the camera picture, one at a time:

1. Step into the picture.
2. Hold your gloves up by your chin and keep still.
3. Raise your RIGHT hand.
4. Throw a few straight punches with that right hand, then with your left.

The result is saved with the boxer. It covers how your head sits over your shoulders, your arm
length and punch height, whether this camera swaps left and right (if you raised the wrong hand,
your punches put that right and the screen tells you; if your punches suggest a mirrored camera,
you are asked to raise your right hand once more), and the camera's delay (defence is judged a
little later by that much, so a guard that looked in time counts). Where you stand is learned
again at the start of every bout, so standing somewhere else or moving the laptop does not
matter. If a step will not finish (too far away, arms not seen), the screen offers to skip it
after 15 seconds. To redo it, press **Recalibrate** on the camera check screen, or add
`?calibrate=1` to the URL. You can also skip it and play with standard settings.

**Moves**

| Move | How |
|---|---|
| Straight punch | Thrust a fist straight at the screen. Your left arm throws the left glove, whichever hand you hold in front. Fast punches do a little more damage. |
| Head or body | Punch at face height to hit the head. Punch from belly height for a body shot. |
| Hook | Swing round from the side with your elbow up. |
| Uppercut | Scoop upward from below your chin. |
| High guard | Both fists up by your face. Blocks head punches; the body stays open. |
| Low guard | Both fists in front of your belly. Blocks body shots; hooks go over it. |
| Dodge | Lean your head and shoulders left or right (about a third of your shoulder width). Leaning away from a hook dodges it. A dodge you lean into as the punch comes slows the world down for a moment; a lean held all along, or dips made again and again with no punch coming, still dodge, but earn no slow motion and no counter. |
| Duck | Bend your knees and drop your head. Ducks straights and hooks, but not uppercuts (not even with a sideways lean as well) or body shots. Tipping your upper body forward does the same. |
| Lean back | Pull your head and shoulders back about a hand's width (10–15 cm) — at any distance from the camera. Dodges head punches. |
| Counter | Punch while the opponent's punch is out, or right after you dodged it as it came (not after a dodge held all along). Counters do much more damage. |
| Get up | When you are knocked down, throw punches (pump your arms) during the count. |
| Pause | Hold both hands above your head for about a second, or press P or Esc. |

Opponents raise their glove before a power punch: that is the one to dodge. Ordinary punches are
quick; keep your guard up against them. Punching into a guard is risky — the better opponents
counter right away, and from the fifth opponent on, if you keep punching into the guard, they catch
your next punch and counter while your glove is out.

**Menus.** Use the mouse, touch or the keyboard: arrows or Tab to move, Enter or Space to choose,
Esc or Backspace to go back.

**Sound** starts with your first click or key press, because browsers only allow sound after one.
Until then a small badge at the top says "Sound is off — click or press any key to turn it on".

**Small screens.** On a phone or in a narrow window a card suggests a bigger or sideways screen;
**Continue anyway** carries on. The camera starts once the card is gone.

**Tracking lost.** If the game loses a player's hands during a bout or drill (a hand out of the picture, or the
whole player), a "Please keep your hands visible" warning shows at the top; if they stay out for about another
second, the game pauses and names who must come back ("We can't see your hands" / "We lost sight of you"). It
carries on by itself half a second after both hands are back in view, or at once with **Resume**. If the camera itself stops (unplugged, or taken by another app), the same screen says so
and offers **Try again**, which restarts the camera and keeps the paused bout. If the browser's
graphics reset in the middle of a bout (the arena goes blank), the bout pauses and the pause card
says so; **Continue** comes back as soon as the picture does.

**Saving.** Local boxers save their rating, records, beaten opponents and medals automatically
in this browser. Guests and visiting boxers are never saved. If the browser refuses to store data
(private mode, full storage), the game tells you that progress was not saved and lets you keep
playing.

## Keyboard controls

Choose **Use keyboard instead** on the camera check screen, set Controls to Keyboard in
Settings, or open the game with `?input=keyboard`.

| Action | P1 | P2 (versus) |
|---|---|---|
| Left / right straight | J / K | 1 / 2 |
| Left / right hook | U / I | 4 / 5 |
| Left / right uppercut | N / M | 7 / 8 |
| Body shot | hold Shift while punching | hold 3 while punching |
| Power punch | hold E while punching | hold 6 while punching |
| High guard | hold Space | hold 0 |
| Low guard | hold B | hold 9 |
| Lean left / right | A / D | ← / → |
| Duck | S | ↓ |
| Lean back | X | / |
| Lean in | W | ↑ |
| Get up | mash the punch keys | mash the punch keys |
| Skip the tutorial / the outro | Enter | Enter |
| Pause | P or Esc | P or Esc |

The P2 number keys and / also work on the number pad: Num 0–9 and Num / do what 0–9 and / do,
and Num . (low guard) and Num − (lean back) work too. The leans, the duck and lean in stay on the
arrow keys. In single player the P2 keys drive P1 too. With
**Keyboard assist** (Settings → Play), keys keep working while the camera is on.

## Settings

- **Camera:** pick the webcam, choose camera or keyboard controls, pick the tracking model and
  mirror the preview. **Tracking: Auto** (the default) uses the Full model and switches to Lite,
  between rounds, only while your computer can't keep up (fewer than about 24 of 30 poses a second
  even after the arena has lowered its own quality), and back to Full once it can. If tracking stays
  below about 15 poses a second for 10 seconds, it switches to Lite in the middle of the round instead
  (tracking doesn't pause; with the main-thread fallback it still waits until the round is over).
  Undoing a trial that failed (Full back after Lite, or a CPU trial) happens at once, even mid-round and on
  the main-thread fallback: the previous model is still loaded, so tracking doesn't pause.
  **Full** or **Lite** is used as chosen and never changed. Settings saved before Auto existed had Full
  only because it was the default; they now get Auto (a saved Lite stays Lite).
- **Play:** punch sensitivity (default one notch above the middle, still "Normal"; applied at once and after a reload), the webcam
  picture-in-picture with your skeleton (and **Bigger camera picture** to enlarge it, e.g. for recording a
  video), keyboard assist and reduced motion.
- **Sound:** master, effects, music and announcer volumes.

Changes apply immediately and are saved.

## Measured from the reference vs. designed by us

**Measured** (research/mechanics.md, M/V values) and matched:
- the bout: up to 3 rounds, a 3:00 clock at 3× speed, about 0.5 s of black → VS card → arena →
  banner → fly-in → "Fight!" (7–10 s), 7.8–10 s breaks, "Play again" straight to the next VS card;
- health in 10 segments, no regeneration, no top-up, no chip damage; hit damage (about 1–1.5
  segments, counters 2.5–4); a knockdown from a clean hit on an empty-looking meter; refill 8 / 6 / 4;
  no TKO and a KO on the 4th knockdown; a 1.08 s count; the stoppage timeline; how often and when
  opponents of each tier stay down or rise;
- hit-stop tiers, the dodge slow-motion window, the player-hit camera cut and its lengths, the
  knockdown camera shots, the slow orbit, no referee, the order of the KO outro;
- what the HUD shows and hides (no health bars, no stats; the clock hidden during stoppages), the
  timing of the text calls, the meter's behaviour (pre-hit value, delayed drain, blinking edge);
- opponent behaviour per tier (tells, strings, guards, punishing, slips, cover-ups) and the rating
  change after a win (about +75, falling with your rating; −20 for being knocked down);
- the six tutorial steps of the first bout.

**Designed by us** (estimates where the footage shows nothing, and every asset):
- all characters, names, faces, the ring, the crowd, the HUD graphics, the meter design (our own
  10-segment badge, not a pie), the VS and results cards, sounds, music and voice lines;
- the webcam mapping of every move, the get-up meter (5 / 7 / 9 punches, or pump your arms), latency-fair defence,
  the judges and draws, rating losses (−40 KO / −25 decision), rematch ratings, glove unlocks;
- the tutorial's "hold 1 s or do it 3 times, 10 s cap" rule, the training drills and medals.

## Development

### Project map

`ARCHITECTURE.md` documents every module and its API. In short:

| Folder | What |
|---|---|
| `src/main.js`, `src/app/` | Boot, the app flow (menus → VS card → bout → outro → results), the game loop, sessions, the first-bout tutorial runner, debug hooks, visitor counts for the public copy |
| `src/input/` | Camera, MediaPipe tracker (with latency), player assignment, gesture recognition, calibration, keyboard, recorder, synthetic poses, tutorial detection |
| `src/game/` | Combat rules, boxer state machine, opponent AI, roster, match state machine, rating / PRO / matchmaking |
| `src/training/` | Bag practice, dodging drill, target punching, medals, turn-taking sessions |
| `src/render/` | Three.js renderer, arena, cameras, effects, health meters, replay and outro, procedural boxers, faces, training props, art direction (`style.js`) |
| `src/ui/` | Screens and menus, HUD, styles |
| `src/core/` | Event bus, shared types, seeded RNG, profile storage |
| `src/audio/` | Synthesised effects, crowd, announcer and music |
| `research/` | `spec.md` (functional spec, with requirement IDs cited in code comments) and `mechanics.md` (measured timings of the reference game) |

### URL parameters

| Parameter | Effect |
|---|---|
| `?input=keyboard` | Keyboard controls, no camera |
| `?input=synthetic` | No camera: poses come from `window.__glove.injectPose()` (scripted synthetic players run through the real recognizer) |
| `?input=replay&rec=/path/rec.json` | Replay a recorded pose session as the camera, looped (recordings come from the input lab) |
| `?video=/dev/clips/x.mp4` | Use a video clip as the camera |
| `?fast=1` | 10-second rounds, short intros and stoppages, a 1.5-second outro and 8-second drills (for tests) |
| `?seed=123` | Deterministic bouts and drills |
| `?tutorial=0` / `?tutorial=1` | First-bout tutorial never / always (default: a new boxer's first bout) |
| `?debug=1` | Overlay with fps, tracker status, the pose pipeline (camera and detection rates, capture → pose / game / punch, model, STARVED / BEHIND, a model or delegate switch under way), each player's control state, the bout's stage, latency, slow motion and tutorial (the backquote key hides it) |
| `?calibrate=1` | Always run calibration |
| `?quality=low` | Lighter arena (fewer crowd rows, smaller shadow map) |
| `?detector=main` | Pose detection on the main thread instead of the background worker (`?detector=worker` is the default) |
| `?skip=match` | Start at a screen: `title`, `profiles`, `mode`, `single`, `match`, `versus`, `training`, `bag`, `dodge`, `mitts`, `records`, `settings`, `help` |

`window.__glove` is always present:

```js
__glove.state()                      // flow, screen, input, activity (phase, stage, round, hp, tutorial, outro, slowmo), render (shot, meters, outro), saves
__glove.skipTo('match', { tutorial: false, opponentId: 'gus-hammerly' })   // jump anywhere (aborts what is running)
__glove.injectPose('jab-left', 400)  // queue a synthetic pose step (see src/input/synthetic.js SYNTH_ACTIONS)
__glove.injectPose('guard-high', 1500, { player: 1 })   // second synthetic player (versus)
__glove.stopPose()                   // synthetic players leave the picture
__glove.skipTutorial(); __glove.skipOutro()
__glove.match.debugKnockdown('p2', { stayDown: true })  // the running Match (also debugSetHp(id, wedges), debugEndRound)
__glove.match.ai.setScript('dodge', __glove.match.wt)   // a scripted opponent (tutorial scripts: power hooks to dodge …)
__glove.app, .bus, .input, .ui, .renderer, .audio, .storage, .feeder, .tutorial
```

### Dev pages

Run `npm run dev`, then open any of these:

| Page | What |
|---|---|
| `/dev/arena.html` | Ring, crowd, lights, cameras, effects, meters and the outro, with presets |
| `/dev/models.html` | Every boxer preset, punches, hit reactions, falls, faces |
| `/dev/ui.html` | Every screen and HUD state with mock data (`?screen=results`, `?hud=…`) |
| `/dev/training.html?kind=bag` | Each drill with the keyboard or a scripted bot (`&bot=0.6`) |
| `/dev/audio.html` | Every sound, the music and a demo bout |
| `/dev/gesture-lab.html` | Gesture recognizer on synthetic players (`?live=1` webcam, `?video=` clip) |
| `/dev/input-lab.html` | Camera, tracker, latency (camera and detection rates, p50 / p90 per pipeline stage, the auto model's choice, switches), player assignment, recording and replay |

`node dev/sim.mjs` plays modelled webcam players and scripted bots against every opponent
headlessly and prints the §4.5 tuning metrics (time to the first knockdown, hits per minute,
share blocked, knockdowns to KO, endings) next to their targets. It is the tool for tuning the
ladder. It runs on the renderer's hit-stop clock (the match stalls on hits while the player and
"live" time run on; `--no-hitstop` gives the old clock), and its webcam bot registers each punch
at full extension, after its move time plus a camera delay. Tables made before this change are
not comparable. `node dev/gesture-lab.bench.mjs` prints the gesture detection matrix and false
positives. Its headline is the generator's default noise (an earlier, noisier measurement of a real
clip); `--preset real-like` models what the game's own tracker gives, `--fps-rows` adds 15, 20, 30 and
60 fps rows, and `--drop-rows` rows with dropped camera frames.

### Tests

```sh
npm test                       # all unit tests (node tests/run-unit.mjs)
node tests/run-unit.mjs game   # only files whose name contains "game"
node tests/run-unit.mjs debrand
npm run build
npm run test:e2e               # Playwright end-to-end run (starts its own Vite on port 5190)
node tests/e2e.mjs pause versus   # only some scenarios
```

The e2e run and `scripts/shot.mjs` need Playwright's Chromium, installed once with
`npx playwright install chromium` (`npm ci` installs the Playwright package but no browser).
The unit tests were run on Node 22.14 and 25; Node 20.19 was checked by emulating its missing
built-ins (no Node 20 binary was at hand).

The e2e run plays every flow in Chromium:

- keyboard single player: VS card, the tutorial skipped with Enter, knockdowns both ways, a decision, the outro, the decision reveal and the results card
- pause, continue, start over, a hidden tab, quit, and skipping the tutorial from the pause screen
- versus in split screen, the winner card, the rating untouched
- all three drills (bag with two players taking turns)
- the fake-camera check
- synthetic poses through the real recognizer (camera check, calibration with latency, a full round, the pause gesture)
- tracking loss: the hands warning, the pause, and carrying on by itself 0.5 s after both hands are back
- storage failure, records persisting after a reload (guests not persisted), a visiting boxer
- settings applied live and after a reload
- a pose recording replayed as the camera
- real MediaPipe tracking on a recorded boxing clip (needs `dev/clips/facecam-boxing.mp4`, see below; skipped without it)
- a KO with the whole outro in order and the results card; skipping an outro with Enter
- all six tutorial cards from the keyboard, then never again for that boxer
- a scripted power hook dodged by an injected duck → the slow motion; a KO outro skipped with both hands up
- "Play again": the next opponent after the first win, then a rematch with the first one at a raised rating
- the on-hit health meters for both fighters
- the camera stopping while a bout waits for a lost player: the screen says so, **Try again** brings it back, the bout stays paused
- the camera check staying ready: **Continue** comes on only after 2 seconds fully in view, stays on while the player
  steps out of the picture to reach the computer, and goes off when the camera feed stalls (until another 2 seconds in view)
- a fighting stance or guard held on the pause screen never clicks anything and hands up again continues; on the
  tracking-lost screen the bout carries on by itself about half a second after the boxer is back with both hands in view
- the player walking out: the "Please keep your hands visible" warning comes before the tracking-lost screen
- the Google font hosts blocked: no console error, both typefaces load from the game's own server
- the loading screen: gone soon after the title is up, then the title's intro plays and **Start** answers a click
- the game's code failing to download: the loading screen says it couldn't load and offers **Reload**
- the WebGL context lost mid-bout: the bout pauses and stays paused after the restore until you continue
- camera play (a bout started and paused without a click or key): no sound and the sound-off badge, then sound and no
  badge after one real key press
- MediaPipe's usage logger made to send at once (pose models closed in the worker and on the main
  thread): every send is answered on the device and nothing leaves it. `node tests/e2e.mjs telemetry-60s`
  (not in the default run, about 70 s) waits past the logger's 60-second timer instead.

**The boxing clip.** The clip scenario plays a real recording through the real MediaPipe
pipeline as the camera. Our own clip is a cut of third-party footage, so it is not distributed
(`dev/clips/` is git-ignored). To run the check, save your own clip as
`dev/clips/facecam-boxing.mp4`: an H.264 MP4 of 15–30 s at about 640×480 showing one person
boxing (guard up, straight punches) 2–3 m from the camera, with head, shoulders and both hands in
the picture. Without it the run prints `SKIP clip` and the summary counts it as skipped, never as
passed (for example `22 passed, 1 skipped, 0 failed`).

Every scenario fails on any page or console error, and on any request to a host other than the
local server, from the page or its detection worker. The test browser cannot resolve other hosts,
so the run needs no internet, which also checks that the game itself never does. Steps whose effect
a busy machine can delay (a hold) are repeated until the screen shows the effect,
and nothing waits for a short-lived moment from outside the page: a test knockdown is checked and
made in one step, and the key that skips a short outro is pressed from before the outro starts.
The test browser has no speech synthesis (the announcer falls back to beeps): a headless browser
that speaks answered the test runner seconds late. Screenshots go to `test-results/e2e/`
(`E2E_SHOTS=<dir>` changes that). The run starts Vite with `GLOVE_NO_HMR=1` (no hot reload, so
editing files cannot reload a running scenario) and its own dependency cache in
`test-results/.vite-e2e-<port>/` (so a dev server running alongside cannot disturb it). On macOS it uses the real GPU through
ANGLE/Metal, so the game runs at 60 fps headless. Elsewhere, or with `E2E_GL=swiftshader`, it
uses software WebGL, which is slow: the timeouts are stretched, but pose detection on the fake
camera can drop to about 2 per second there, and then the scenarios that wait for live tracking
(camera, camera-retry, telemetry) time out. `E2E_HEADED=1` shows the browser.

### Tuning

Every number is a named, documented tunable:

| Area | Where |
|---|---|
| Combat (damage in segments, counters, travel and recovery, dodge thresholds, latency windows, slow motion, rate limits) | `COMBAT` in `src/game/combat.js` |
| Rounds, clock, stages and calls, count, get-up, refill, judges, tutorial | `RULES` in `src/game/match.js`. `FAST_RULES` holds the `?fast=1` values. |
| Opponents (tells, strings, guards, punishing, slips, stay-down, rise counts, ratings) | `src/game/roster.js` per opponent, defaults in `AI_DEFAULTS` (`ai.js`) and `AI_BODY_DEFAULTS` (`boxer.js`) |
| Rating, PRO, matchmaking, glove unlocks | `SKILL`, `PRO_THRESHOLD`, `GLOVE_UNLOCKS` in `src/game/progression.js` |
| Gesture recognition and leans | `DEFAULT_TUNING` in `src/input/gesture.js`. Every rule has a named switch whose comment gives its measurement: e.g. `displayLead` 0 (the gloves get no lead from the input side; the render springs handle their lag), `kindSteps` 'dw', `recover*` / `rearmFromPeak` / `rearmPeakMs`, `hookExtMinS` (a relabel only), `restLowMs` (a hand that pauses low before coming back up is no uppercut), `otherHookLeadMs`, `leanZFaceCap` 0. The Settings sensitivity slider scales the detection thresholds. |
| Tutorial detection | `TUTORIAL_DETECT` in `src/input/tutorial-detect.js`; the runner's cap and pacing in `TUTORIAL_TUNING` (`src/app/tutorial.js`) |
| Calibration | `CALIBRATION_DEFAULTS` in `src/input/calibration.js` |
| Tracking loss, latency, extra poses, staleness; the pose rate the game wants, when detection is behind or starved, the Auto model, delegate trials, safe moments for switches, the camera's 60 fps | `HUB_TUNING` in `src/input/input-hub.js` |
| Render quality (pixel ratio, shadows, the frame cap on fast displays) and how it gives a starved GPU pose detector its time back | `ADAPTIVE_TUNING` in `src/render/adaptive.js` |
| Camera check hold (time fully in view before Continue lights up) | `UI_TUNING.readyHoldMs` in `src/ui/screens/kit.js` |
| Cameras | `RIG_TUNING` in `src/render/camera-rig.js` |
| Your own boxer's follow of the tracked body (springs, tracking filter) and the own-part fade | `ANIM` (`w…Human`, `track`) in `src/render/boxer-model.js`, `OWN_FADE` in `src/render/own-fade.js` |
| Hit-stop, bursts, trails, shake | `FX_TUNING` in `src/render/fx.js` |
| Health meters | `METER_TUNING` in `src/render/meter.js` |
| Replay and outro | `REPLAY_TUNING`, `OUTRO_TUNING` in `src/render/replay.js` |
| Presentation staging, orbit, slow-motion look, how long a tracking dropout keeps your gloves where they were (`lostHoldMs`) | `RENDER_TUNING` in `src/render/renderer.js` |
| HUD calls and timings | `HUD_TUNING` in `src/ui/hud.js` |
| Training drills and medal cutoffs | `BAG_TUNING`, `DODGE_TUNING`, `MITTS_TUNING`, `MEDAL_CUTOFFS` in `src/training/` |
| Sound mix and cue timings | `AUDIO_TUNING` in `src/audio/audio.js` |
| App timings (black before the VS card, keyboard latency, tracking-loss grace, result linger) | `APP_TUNING` in `src/app/app.js`, `SESSION_TUNING` in `src/app/session.js` |

After you change combat or opponent numbers, re-run `node dev/sim.mjs` to check the
difficulty ramp against the §4.5 targets and the weaker bots' win floors (casual and mid, so the
top opponents stay beatable for a first-timer).

## Deploying

The game is a static site, so any HTTPS host works (the camera needs HTTPS). The public copy is on Vercel at
<https://glove-up-seven.vercel.app> (project `glove-up`), connected to this repository: every push to `main` deploys to
production, and other branches and pull requests get preview deployments. Vercel builds it as `vercel.json` says:
`npm ci`, `npm run setup:models` (the pinned pose models and the MediaPipe runtime), then `npm run build` with
`VITE_VISITOR_COUNTS=1` on production only (previews count no visits), plus the cache headers for the pose model, the
runtime and the hashed assets. A failed build never replaces the live site.

To deploy by hand instead (`npx vercel login` once first), from this folder:

```sh
VERCEL_ORG_ID=team_WC1fTCxcUHtgizSPtj84gJYF VERCEL_PROJECT_ID=prj_ZjVTvya6bhNdVKnDVK4LHPArQEgI npx vercel deploy --prod --yes
```

That uploads the source (`.vercelignore` keeps `node_modules/`, builds, recordings, `dev/clips/` and the downloaded models
out) and Vercel builds it the same way. The two IDs only name the project (they are not secrets), so there is no
`vercel link` step, which would write a `.vercel/` folder and a `.env.local` token here.
Visitor counts show in the project's Analytics tab on Vercel. Web Analytics has to be on for the project
(`npx vercel project web-analytics enable glove-up`); the free plan records up to 50,000 page views
a month across the account.

## Known limitations

- **Camera play needs real-world tuning.** The gesture recognizer was tuned on modelled webcam
  players, synthetic poses and labelled recordings of real people boxing, never with a live player;
  the opponent ladder on modelled players. Measured:
  - about 88 % of punches are recognised at the bench's default tracking noise (841 of 960 over 40
    simulated players; 873 at the measured real-camera noise); at 15 fps (a dim room or the CPU
    fallback) about 79 % (761), about 40 ms later;
  - on six labelled real recordings (649 punches) about 54 % of punches register within 250 ms of
    their peak, and about 40 % in time and as the right kind; about 4.6 false fires a minute,
    mostly the other hand moving while one punches;
  - on two close-webcam recordings (140 punches, not used for tuning) about 36 % register in time
    and 21 % in time and as the right kind;
  - uppercuts thrown close to the camera are still not recognised as uppercuts (0 of 18 on those
    recordings);
  - jabs thrown across the picture close to the camera are often read as hooks; the relabel that
    helps the test clip (`dev/clips/facecam-boxing.mp4`) does not help the other close recordings;
  - dropping a hand to your hip and snapping it straight back up to your guard, without a pause,
    can fire an uppercut (9 of 24 simulated tries at real-camera noise); with a pause of about a
    tenth of a second at the bottom it rarely does, unless the camera runs at 15 fps;
  - body straights thrown from a low guard are still recognised only about a third of the time at
    default noise;
  - slow pointing or reaching at the screen fires a punch in about 10 % of attempts, and other
    non-punch movement about 0.6 times a minute;
  - back and forward dodges are noisier than sideways ones: about one false back or forward
    dodge every 1–2 minutes for a player 2.5–3 m from the camera;
  - a lean, duck or back lean held for a while no longer makes standing up again read as a dodge,
    but if you start a bout leaning back or forward and then settle into your stance, your first
    dodge in that direction may not count;
  - a punch registers about 112 ms after the wrist's peak speed (about 39 ms after the labelled
    peak on the real recordings) and makes contact 30 ms later, plus the camera delay; the gloves on
    screen follow your hands 1:1.

  If punches are missed, raise **Punch sensitivity**; if punches fire by accident, lower it. The
  top opponents may floor real players more often than they floored the player in the footage.
- **Latency.** A webcam plus pose tracking adds a delay. On an M-series Mac with a Retina screen, a
  frame reached the game about 35–50 ms after the camera captured it at 30 poses a second, and the delay
  the game measures for judging your defence (capture → pose plus 30 ms of filtering) was about 65–80 ms —
  against 95–180 ms before the arena learned to give pose detection its GPU time back. The sensor's own
  delay comes on top (the page cannot see it). The measurement is stored per device during calibration and
  the bout judges your defence with it; power-punch tells stay at 0.55 s plus that latency. Ordinary
  punches are as quick as in the reference game — keep your guard up. `?debug=1` shows the live figures.
- **Not in the footage, so designed by us:** decisions and draws (the reference never went to
  the judges), losing, the get-up input, training, and opponents answering a dodge posture held
  for about a second with a punch it does not dodge (an uppercut under a duck or a lean-in, the
  other hook against a sideways lean, a body shot under a high guard, a step-in against a lean
  back); from the fifth opponent on, catching and countering the next punch of a player who keeps
  punching into the guard, and a body guard that follows a player who keeps going to the body;
  dodges made while dipping in and out with no punch coming earn no slow motion; in the live view,
  your own gloves and see-through head fade while they cover the opponent's face.
- **Hardware.** Pose detection runs in a background worker, so it does not cost the game frames;
  if the worker can't start or stops answering, detection moves to the main thread by itself
  (`?detector=main` forces that path). The arena and pose detection share the GPU, and on a Retina
  screen a sharp arena used to win: the game kept 60 fps while tracking fell to 12–18 poses a second.
  Now the renderer gives detection its GPU time back when it falls behind — first a 60 fps cap on 120 /
  144 Hz displays, then a lower pixel ratio (a bout at a Retina screen's ratio 2 usually settles at 1.25–1.5),
  then softer shadows — and takes it again only when detection has room; it remembers the level a bout
  needed for the next one, rarely tries a sharper level that already failed, and once another program stops
  using the GPU the arena gets its sharpness back, usually within a minute and at most in about two and a half. It
  also lowers them when rendering itself is too slow (pose-detection time is not counted). If detection still can't keep up, Auto tracking switches to the Lite model between rounds,
  and then tries the CPU (kept only if it is clearly faster). Either switch starts in the middle of a round
  only once tracking has stayed below about 15 poses a second for 10 seconds, and never on the main-thread
  fallback; undoing a trial that failed is immediate, even mid-round, because the previous model stays loaded. On machines without a usable GPU detection runs on the CPU from the start. A switch never
  pauses tracking (the new model starts in a second worker first). The worker path is verified in
  Chromium; other browsers may use the main-thread fallback. Not tried on a real 120 / 144 Hz display or
  a real 60 fps webcam.
- **Two players, one camera.** The pose models' model card lists several people in one picture as
  out of scope. Versus tracks two people anyway; keep a clear gap between you.
- The fitness assessment from the functional spec is out of scope.

## Credits and licenses

Glove Up's code, characters, art, text, sounds and music are our own. It is built on:

- [three.js](https://threejs.org) 0.186.1 (MIT) for the 3D view;
- MediaPipe Tasks Vision 1.1.1 and its WebAssembly runtime (Apache 2.0) for pose tracking, with
  Google's MediaPipe Pose Landmarker models, lite and full (Apache 2.0, per their model card);
  MediaPipe's built-in usage statistics are switched off, so they are never sent;
- the Lilita One and Nunito typefaces (SIL Open Font License 1.1), self-hosted from the
  `@fontsource` packages;
- Vite (MIT), whose small module-preload helper is part of the build.

[`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) holds each one's copyright notice
and the full licence texts. Every build gets a copy (`dist/THIRD_PARTY_NOTICES.txt`); keep it
with any deployment. When you add or upgrade a dependency, update that file:
`tests/unit/release-fix-notices.test.mjs` fails until every runtime dependency is listed at its
installed version.
