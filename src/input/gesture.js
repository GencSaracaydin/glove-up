// GestureRecognizer: turns noisy MediaPipe pose landmarks of ONE player into boxing input —
// a continuous ControlState (gloves, guard, lean/duck, activity) plus discrete punch events.
//
// Spec coverage: COM01 (punch on a fast forward thrust), COM02 (head/body from punch
// height), COM03 (high/low guard), COM04 (lean/duck/forward-back from the head),
// COM07 + A05 (one punch per thrust; the pull-back never fires), ERR02 (tracking-lost
// flag), ERR03 (waving, scratching, reaching, walking … never fire).
//
// How it works (per frame):
//  1. Landmarks are read with the calibrated label swap, checked for visibility, cleaned of
//     one-frame glitches and smoothed with One-Euro filters.
//  2. Everything is expressed in PLAYER units: image positions in shoulder widths relative
//     to the shoulder-line centre (+x = player's right, +y = up), world vectors in arm
//     lengths with the tracker's compressed depth undone (the compression factor is
//     estimated online from bone-length consistency).
//  3. Per hand, an "extension" X fuses four independent cues — 2D foreshortening of the arm
//     (an arm pointing at the camera looks short), 3D elbow straightness, forward depth of
//     the wrist and its image distance from its resting "home". A punch is a fast,
//     ballistic stroke: it starts when X rises fast (or the wrist sweeps toward the midline
//     / upward fast), is fired ONCE when the motion decelerates at the peak — or, for a strong
//     stroke that already classifies as a clear straight or hook, while it is still speeding up
//     (R2, earlyMinPeak) — and the hand must retract before it can fire again.
//  4. The stroke is classified (straight / hook / uppercut) from its shape, gated against
//     non-punch motions, and assigned a head/body target and a power (from its own speed).
//     Uppercuts: a scoop (dip / low start), a dip-less 3D shape (clean depth) or — R1 — the
//     picture's dip-less shape (a fast upward drive of a forearm standing up under the fist, at
//     any depth quality; in front of the face it is confirmed by its way back down).
//  5. Weak (slow) straights only fire once the retraction that follows every punch shows up —
//     a deliberate reach or pointing at the screen holds still instead (COM07).
//  6. Lean / duck come from the RAW head centre, smoothed once, against a NEUTRAL pose that is
//     learned in the bout (the first steady second of guard / stance — never an image position
//     stored in the calibration) and re-centred whenever the player has stood steadily somewhere
//     else (stepped sideways / nearer / farther, the camera was nudged), judged on block means over
//     a time window so landmark jitter never looks like a step. Forward / back is a PHYSICAL
//     displacement (metres): the apparent shoulder-width change × the estimated camera distance,
//     fused with the tracker's hip-relative world depth of the shoulders and head only where the
//     two agree (a step or a torso twist moves only the first, so neither reads as a lean), so the
//     same sway dodges at 1.5 m and at 3 m. Each axis is mapped so the dodge movements of
//     research/mechanics.md §2.1 land exactly on the combat dodge thresholds; a back/forward lean
//     must persist leanZHoldMs.
//  7. The tracker's world-depth jitter is measured on still joints. An earlier measurement of
//     dev/clips/facecam-boxing.mp4 gave ≈ 20 mm (full) / ≈ 23 mm (lite) per frame — the synthetic generator's
//     default noise (≈ 21 mm), still the bench's headline. Extracted with the game's own VIDEO-mode tracker
//     (R5, this round) that clip and three public shadowboxing clips give only ≈ 2–10 mm (this recognizer
//     reads 1.8 / 7.2 / 8.4 / 9.8 mm), so depthTrusted is ON for many real players and OFF for others —
//     the 'real-like' synthetic preset (synthetic.js SYNTH_PRESETS) models that. Depth-led detection
//     (short body punches from a low guard, the 3D dip-less uppercut) and lighter world smoothing switch on
//     only when the depth is measured clean enough (≤ depthTrustNoise); the picture's dip-less uppercut
//     works either way.
//  8. Frame rate (R3): every frame of a 60 fps camera is used (minFrameIntervalMs 10); differences,
//     noise estimates and window extremes are taken on a ≤ 42 Hz view (diffBaseMs), every EMA is per
//     time, glitch confirmations are timed, and a 15 fps scoop is not a "spike".
//  9. Real punches turn the shoulders and carry the head (R5): a short narrowing during a punch is not
//     "turning away" (facingPunchGraceMs), and a stroke during head motion fires when the fist clearly
//     outpaced the head (dodgeOutpace).
// 10. Display values (R4): HandState x / y / reach and lean x / y add back the lag their filters have on
//     a moving hand / head (displayLead*, leanLead*) — the punch logic keeps the filtered features.
// 11. Real people (RT, tuned on the TUNE side of the labelled real clips, PUNCH/data/splits.json): real MediaPipe
//     world depth gets a punch's direction wrong (the wrist's 3D forward reach FALLS in 3 of 4 real straights while
//     the picture shows the arm foreshortening; elbow height, elbow angle and wrist height fail the 3D uppercut tests
//     for 3 of 4 real uppercuts). So: the picture decides the pull-back (RT-1, pullBackImgOut), a stroke whose depth
//     contradicts its picture is judged like one without world landmarks (depthContra*), a FAST stroke the 3D tests
//     turn down is classified from the picture alone (RT-11, imgPath*; confirmed by its retraction / way back down
//     where a gesture could look the same), and the KIND of every punch is read from the picture's forearm shape,
//     foreshortening and dominant drive (RT-14, kind*). Also: the facing test compares the shoulder width with the
//     face size (a step back is no turn, RT-2) at facingMinRatio 0.45 (real boxers blade), a fast stroke may end
//     higher (regionFast*), a hook's wind-up is no early motion (ballisticImg*), a dropping other hand is no
//     "both hands" (bilateralOpposedSW), an uppercut may drive to the chin (upMedial*) but not with the other hand
//     rising too (upOtherRise*, the guard coming up), a parked-then-snapping wrist landmark of low visibility is no
//     stroke (visStroke*, RT-13), and a straight held as a possible hook is judged once hookPendingMs has passed.
// 12. Verification round (V2, measured on all labelled real clips and adversarial synthetic probes; thresholds chosen on the
//     TUNE clips): the real-clip false fires of round 11 came from a few mechanisms, each closed where it arises —
//     V2-1 a stroke soon after this hand's punch heading AGAINST that punch's picture direction is its way back
//     (recover*; the duplicate fires on retractions), V2-2 a picture-only straight that began no earlier than a faster
//     stroke of the other hand is that punch's torso turn (otherLead*; the other-hand fires), V2-3 a picture-only uppercut
//     needs some punch speed (imgUpMinPower; guard resets), V2-5 a picture-only uppercut whose arm then went out is a
//     straight (imgUpStraightX; 60 fps jabs from a low guard), V2-6 an uppercut that sweeps in ends in front of the body's
//     middle (upMedialMaxLat; the rear hand bouncing back beside the chin), V2-7 no early decision for a fist at body
//     height or out by the hip and no picture-only straight going out to the side (earlyNotLow, imgStraightMaxOut; side
//     reaches), V2-8 no picture-only classification during a duck and RT-8's picture pass only for hook-like strokes
//     (imgNoDuck, ballisticImgHook), V2-9 a picture-only straight needs a straightened elbow and the facing test is back at
//     0.72 (imgStraightMinS; turned-torso gestures), V2-10 the shoulder-width unit follows a face-explained narrowing only
//     once it has lasted facingDistHoldMs (a blading boxer's unit no longer shakes) and the gloves' display lead is off by
//     default (displayLead), V2-11 uppercuts need a sensitivity-independent minimum speed (upMinPeakRaw; eager settings).
//     RT-14's kind-from-picture keeps only its steps that helped on TUNE (kindSteps 'dw').
// 13. Fix round (V3, measured on the labelled real clips, synthetic same-hand double-ups and the adversarial probes):
//     V3-1 a same-hand second punch is no retraction: 'recovering' needs a stroke that began out where the punch ended (not back
//     at its guard; recoverFromGuard) or still at that end (recoverAtEnd); the re-arm measures how far the hand came back from the
//     punch's own peak — the early decision fires before full extension (rearmFromPeak); and after a body punch a rising stroke
//     that extends the arm in the picture and in 3D is the head shot, not the return (returnOutXi, returnOut3). V3-2 a 'hook'
//     whose arm ended extended with the elbow low in 3D and in the picture is a straight thrown across the picture — a close or
//     off-axis camera's perspective sweeps a jab toward the image centre (hookExtMinS). V3-3 (off by default) lean.z gates on the
//     face's own size (leanZFaceCap, leanZTwistFace). V3-4 a body-height straight while the other hand's faster hook swings is
//     its counter-rotation (otherHookMs). V3-5 a slow deep scoop is spared the picture's pull-back test like a fast upright
//     rise (pullBackScoopDip).
// 14. Refix round (the fix round's verifier: synthetic probes, the six labelled clips, a blind close-camera set): R-A a fist
//     that RESTED at its low point away from its home and rises back to the guard is judged by the pull-back test (restLow*:
//     a hand dropped to the hip or the belly fired an uppercut since RECOG-FINAL), and a picture-only straight that went down
//     and out to its own side is a drop (imgDropOut*); R-B V3-2 only relabels (clear cases, hookExtElbowImgMargin; the
//     early decision and the dodge test judge the hook it fires as); R-C V3-4 needs the straight to begin with the hook
//     (otherHookLeadMs); R-D V3-1's 'still at the end' is the punch's own follow-through (recoverAtEndMs); R-E the re-arm's
//     picture span is the punch's own (rearmPeakMs).
// 15. Dodge-neutral round: the head's "upright" neutral sat 0.3–0.5 SW off for tens of seconds on the real clips (a player
//     who never stands still is never re-centred by the steadiness test), so the guard read as a side lean or a duck. The
//     neutral now also follows the PLACE the player boxes at (neutralPlaceMs: the weighted median of quiet-weighted block
//     means over 3 s, its height taken at its sideways position, neutralPlaceAgreeSW) — never toward a held lean or duck,
//     which stay with the steadiness path and home (R1); frames with the head moved over the shoulders (a slip) count like
//     a punch in the place (neutralPlaceLeanRel*). A player who boxes from the start gets a provisional first neutral from
//     that place, learned again at the first steady window in guard unless that window is a held lean or duck. The
//     steadiness streak ends after neutralSteadyStaleMs without a verdict instead of carrying through a busy stretch.
//     Noise-free hub replay of the 12 labelled recordings: neutral error 0.223 → 0.160 SW sideways and 0.141 → 0.110
//     up/down; false side-dodge frames 4206 → 2918, false duck frames 703 → 686; dodge frames in a still guard 282 → 145;
//     must-catch dodges 241 → 260 (x) and 63 → 67 (y). Punch events are unchanged (the punch machine never reads the
//     lean). Known costs (synthetic): a player who slips mostly to one side gets the neutral ≈ 0.1 SW toward it, so
//     borderline slips that way register less often (≈ 80 → 72 %); a dodge-sized lean held ≥ 8 s while punching can, for
//     some players, read as a lean the other way for seconds after the return; a knee-bend duck (no forward bend) held
//     ≥ 2 s while moving becomes the neutral (the steadiness path already did that for a player standing still).
//  ControlState also carries guardMs / stanceMs (hold times for the first-bout tutorial,
//  src/input/tutorial-detect.js). One knob for players: `sensitivity` (effectiveTuning()).
//
// Offline evaluation over random synthetic players: node dev/gesture-lab.bench.mjs
// Pure module (no DOM): runs in Node for tests. Time stamps are milliseconds.

import { LM, Hand, PunchKind, Target, GuardKind } from '../core/types.js';
import { OneEuroVector } from './one-euro.js';

// ───────────────────────────── MediaPipe axis conventions (the ONE place) ─────────────────────────────
//
// Image landmarks (NormalizedLandmark, vision.d.ts): x,y normalised to [0,1] by the frame
// width/height; x grows to the RIGHT of the raw (non-mirrored) frame, y grows DOWN.
// World landmarks (Landmark, vision.d.ts): metres, origin at the centre between the hips,
// "the smaller the value the closer the world landmark is to the camera" (z AWAY from the
// camera). x and y follow the image axes (x toward the image's right, y DOWN — the head has
// negative world y). Landmark names are the PERSON's anatomical sides, so in a raw webcam
// frame the person's right side appears at SMALLER x. Player perspective (ARCHITECTURE §1):
// +x = player's right, +y = up, +forward = toward the camera.
export const MP_AXES = Object.freeze({
  /** image y grows downward → player up = −image y */
  imageUp: -1,
  /** world y grows downward → player up = −world y */
  worldUp: -1,
  /** world z grows away from the camera → toward camera (forward) = −world z */
  worldForward: -1,
  /**
   * Sign mapping raw image/world x to "player right" BEFORE any data is seen: the person's
   * right appears at smaller x (−1). When the camera mirrors frames the tracker also swaps
   * the labels (Calibration.swapSides) and the sign becomes +1. At runtime the sign is
   * confirmed from the (label-swapped) shoulder order.
   */
  defaultSideSign: -1,
});

/** Sign that maps raw x to player-right for a given calibration. */
export const sideSignFor = (swapSides) => (swapSides ? 1 : -1);

// ───────────────────────────── tuning ─────────────────────────────

/**
 * Every threshold of the recognizer. Units: SW = the player's shoulder width in the image,
 * AL = the player's arm length (shoulder→wrist) in world space, X = fused extension
 * (≈0 at guard, ≈1 at a full straight punch), drive = multiples of the onset threshold.
 * `sensitivity` (0..1, default 0.5) scales the detection thresholds — see effectiveTuning().
 */
export const DEFAULT_TUNING = Object.freeze({
  /** Settings slider: 0 = strict (only clear punches), 1 = eager (lighter punches count). */
  sensitivity: 0.5,
  /** Camera frame width/height used when PlayerPose.aspect is not set. */
  aspect: 4 / 3,

  // ── tracking (ERR02) ──
  /** Landmarks below this visibility are treated as missing. */
  minVisibility: 0.5,
  /** tracked=false once shoulders, nose or a wrist have been missing this long. */
  lostAfterMs: 500,
  /** No punches during the first moments after tracking is (re)acquired. */
  warmupMs: 450,
  /** Frame gaps longer than this reset motion state (no velocities across the gap). */
  maxGapMs: 300,
  /** Frames closer than this to the last processed one are skipped (only duplicates and > 100 fps: a 60 fps camera's
   *  frames are all used — R3; before: 24 ms, which threw every other 60 fps frame away). */
  minFrameIntervalMs: 10,
  /** Frame-to-frame differences (hand velocities, the speed envelopes, the depth-noise and lean-jitter estimates, the
   *  ballistic test, power) are taken over samples at least this far apart, so a 60 fps camera's twice-as-noisy
   *  per-frame differences mean what they mean at 30 fps (≤ 42 Hz views; at 15–40 fps every frame is used, as before). */
  diffBaseMs: 24,
  /** A stroke survives this long without fresh wrist data (blur dropouts); longer aborts it. */
  holdMissingMs: 220,

  // ── smoothing (One-Euro; image speeds in SW/s, world speeds in m/s) ──
  imgMinCutoff: 2.2,
  imgBeta: 2.4,
  imgDCutoff: 2.5,
  /** World points: low-pass cutoff (Hz) = worldMinCutoff + worldBetaImg × image speed of that body part (SW/s).
   *  With clean depth (see depthTrustNoise) the world points may follow faster: worldBetaImgTrusted. */
  worldMinCutoff: 1.0,
  worldBetaImg: 1.3,
  worldBetaImgTrusted: 2.0,
  /** Release time of the image-speed envelope that steers the world smoothing. */
  worldEnvReleaseMs: 120,
  /** EMA weight of the newest frame-to-frame velocity (1 = raw differences) per 30 fps frame — applied per
   *  unit of time, so 15 and 60 fps cameras smooth alike; …Trusted with clean depth. */
  velAlpha: 0.75,
  velAlphaTrusted: 0.9,

  // ── glitch rejection ──
  /** Image speed (SW/s) above which a single-frame jump is suspicious. */
  glitchSpeedSW: 22,
  /** …but jumps smaller than this (SW) are always accepted (unless implausible, below). */
  glitchMinJumpSW: 0.5,
  /** A 2D forearm longer than this (SW) is anatomically impossible (≈0.7 SW in the image plane,
   *  ≈0.8 when closer to the camera): the wrist landmark glitched. */
  glitchForeMaxSW: 1.2,
  /** A wrist landing within this (SW) of the other wrist, which was far away, is a label glitch. */
  glitchSnapSW: 0.15,
  /** A stroke with a confirmed glitch on its arm within this long before its start is discarded. */
  glitchTaintMs: 120,
  /** RT-13: …and a stroke whose wrist samples have a mean visibility below this × the wrist's typical one (0 = off). */
  visStrokeRatio: 0.8,
  visHeldWeight: 0,
  visMinRise: 0.5,
  visStrokeShare: 0.6,
  /** Spike = out by more than glitchSpikeSW and back within glitchSpikeReturnSW (SW) over three
   *  consecutive accepted frames, each step at most glitchSpikeLegMs and all three within
   *  glitchSpikeMaxMs (room for one dropped or held frame; a real punch spends ≳ 200 ms away
   *  from where it started). */
  glitchSpikeSW: 0.6,
  glitchSpikeReturnSW: 0.2,
  glitchSpikeLegMs: 110,
  glitchSpikeMaxMs: 175,
  /** …and, from a slow camera (both legs ≥ 55 ms), each leg faster than this (SW/s): out and back by 0.6 SW in two 30 fps
   *  frames is no human motion, but in two 15 fps frames (133 ms) it is an uppercut's scoop (R3: the 15 fps bench lost
   *  ≈ 1 in 8 of the uppercuts from a high guard as "glitches"). One dropped frame at 30 fps keeps the plain test. */
  glitchSpikeSpeedSW: 12,
  /** A suspicious jump is real (fast motion, a re-acquired hand) once it has persisted this long — the next frame at
   *  30 fps, two frames at 60 fps (a tracker glitch often lasts two 60 fps frames). */
  glitchConfirmMs: 25,

  // ── depth model ──
  /** Prior for the tracker's world-depth compression (MediaPipe underestimates depth motion). */
  zScalePrior: 0.62,
  zScaleMin: 0.35,
  zScaleMax: 1.25,
  /** Memory of the online depth-compression estimate (s). */
  zScaleTauS: 25,

  // ── fused extension X ──
  /**
   * Weights of the four cues (sum 1): 2D foreshortening, 3D elbow straightness, forward
   * depth, image distance from home. The image cues are ~5× less noisy than the depth-based
   * ones, so they carry most of the weight; depth mainly validates (see straightMinFwd).
   */
  wCollapse: 0.32,
  wStraight: 0.24,
  wForward: 0.16,
  wDisplace: 0.28,
  /** HandState.reach = X / reachFullX (a full straight punch reaches X ≈ 0.75–0.9). */
  reachFullX: 0.75,
  /** Arm length / shoulder width (2D length of an arm lying in the image plane, in SW). */
  armToShoulder: 1.5,
  /** Cue change that counts as "one full punch" for each cue. */
  collapseRange: 0.42,
  straightRange: 0.55,
  forwardRange: 0.42,
  displaceRange: 0.9,
  /** The resting posture (home) follows a hand that has been still (speed < settleSpeed SW/s,
   *  |dX/dt| < settleRate) for settleMs, with time constant baseTauMs. */
  settleSpeed: 1.0,
  settleRate: 1.0,
  settleMs: 150,
  baseTauMs: 450,
  /** While the hand moves slowly the resting posture may drift at most this many "punch
   *  ranges" per second (a slow reach must not be absorbed); a hand that is static in the image
   *  over the last 300 ms (moved < staticMaxMoveImg SW, foreshortening changed < staticMaxCollapse)
   *  is followed freely. */
  baseMaxRate: 0.1,
  staticMaxMoveImg: 0.07,
  staticMaxCollapse: 0.06,
  /** A stroke's start is the least-extended frame within this long before the onset. */
  startLookbackMs: 250,
  /** Elbow angle (deg, 3D) mapped to straightness 0 … 1. */
  elbowBentDeg: 70,
  elbowStraightDeg: 160,

  // ── stroke detection (COM01) ──
  /** dX/dt (1/s) that starts a stroke. */
  xOnsetRate: 1.8,
  /** Wrist speed toward the body midline (SW/s) that starts a stroke (hooks). */
  hookOnsetSpeed: 3.0,
  /** Upward wrist speed (SW/s) that starts a stroke (uppercuts). */
  upOnsetSpeed: 3.2,
  /** A stroke's peak drive (× onset) must reach this to count as a punch. */
  minPeakDrive: 1.15,
  /** Classify (and fire) once the drive has dropped below this fraction of its peak: the
   *  fist has passed its top speed, and the smoothed features trail it by ~1–2 frames, so
   *  this lands near full extension. (0.7 cost ~15 ms and ~1.5 % of detections in the matrix.) */
  decayFrac: 0.95,
  /** A stroke ends (without firing) when the drive falls below this fraction of its peak. */
  endFrac: 0.25,
  /** After the drive has died, keep judging this long (the 3D cues trail the image). */
  postEndMs: 80,
  /** Strokes longer than this are slow reaches, not punches. */
  maxStrokeMs: 520,
  /**
   * R2 — early decision: a strong stroke (peak speed ≥ earlyMinPeak × the default onset, sensitivity-independent) that is
   * still speeding up (not yet decayed) fires as soon as the classifier, with every gate, already calls it a straight
   * (with at most earlyStraightMaxHook × its forward drive sideways: not a hook still sweeping in) or a hook — about one
   * to two frames (≈ 35 ms) before the drive's peak would have shown. Uppercuts wait for the peak (an early "uppercut"
   * is a rising straight 1 in 4 times), as do strokes overlapping a dodge, low-guard pushes and weak strokes.
   * earlyMinMs from the stroke's start. 0 = off.
   */
  earlyMinPeak: 2.0,
  earlyMinMs: 40,
  earlyStraightMaxHook: 0.5,
  /** …and with at most this × its own drive upward, and (straights) the wrist risen at most earlyMaxRiseImg SW in the
   *  picture so far: a hand going up to wave, to call the pointer or to stretch straightens the arm fast and looks like a
   *  straight or a hook at first — the decision at the peak then sees it rise above the head. */
  earlyMaxUp: 0.8,
  earlyMaxRiseImg: 0.45,
  /** …and only with at least this punch power so far (a reach that speeds up for a moment has a strong peak but a low
   *  power; 0.3 cost ≈ 2–5 ms of the gain at 20 fps and removed the early fires on slow reaches there). */
  earlyMinPower: 0.3,
  /** V2-7: …and not for a fist that is already at body height (the lazy-body height test) or out beside its own hip (more than
   *  earlyMaxLateral SW out toward its side): a fast reach down to the phone or a drink on the desk speeds up like a body
   *  shot — such a stroke waits for its peak, where the reach shows (true = on). */
  earlyNotLow: true,
  earlyMaxLateral: 0.8,
  /** Minimum time from onset to fire. */
  minStrokeMs: 25,

  // ── straight validation ──
  /** X must rise at least this much during the stroke … */
  straightMinRise: 0.3,
  /** … and reach at least this. */
  straightMinX: 0.15,
  /** Forward evidence: rise of (foreshortening + forward depth) cues, in "punch" units … */
  straightMinFwd: 0.2,
  /** … or the 3D shoulder→wrist distance grew by this much (AL). */
  straightMinExtGain: 0.06,
  /** Image evidence: the wrist moved this far in the picture (SW) … or the arm's 2D length
   *  shrank by this fraction of its length (foreshortening toward the camera). */
  straightMinImgTravel: 0.15,
  straightMinCollapse: 0.12,
  /** Weak image evidence (≥ weakImageEvidence) suffices when the 3D stroke is fast (m/s), has a
   *  big extension rise and ends with a fairly straight arm (on-axis punches from a high guard). */
  weakImageEvidence: 0.5,
  depthBackedSpeed: 0.9,
  depthBackedRise: 0.45,
  depthBackedStraight: 0.35,
  /**
   * Body punches from a LOW guard are short forward pushes (the fist starts in front of the stomach).
   * Used only while the tracker's world depth is clean (median per-frame jitter of still joints ≤
   * depthTrustNoise m — real MediaPipe output measured ≈ 2–10 mm in VIDEO mode (R5), so this path is on for some players; off, a
   * body straight from a low guard is recognised less often: ≈ 1/3 in the default-noise bench, vs ≈ 3/5
   * with clean depth): a hand at least lowStartY SW below the shoulder line and not extended
   * (X < lowStartMaxX) starts a stroke at lowStartOnset × the usual drive; if it ends at body height
   * with the 3D reach growing (forward evidence ≥ lowPushFwdEv, shoulder→wrist +lowPushExtGain AL,
   * forward depth +lowPushFwd AL) the travel thresholds are × lowPushRelax. Such pushes are weak
   * strokes, so their retraction still confirms them (weakStraightPeak).
   */
  depthTrustNoise: 0.008,
  lowStartY: -0.3,
  /** …and only when the low guard is up, or was within this long (a punch drops the guard first). */
  lowGuardRecentMs: 400,
  lowStartMaxX: 0.35,
  lowStartOnset: 0.65,
  lowPushFwdEv: 0.35,
  lowPushExtGain: 0.05,
  lowPushFwd: 0.1,
  lowPushRelax: 0.5,
  /** …and their retraction may take this much longer to show (a short push retracts slowly). */
  lowPushConfirmMul: 1.35,
  /** At fire the arm points mostly toward the camera (forward part / 3D length). */
  straightMinFwdDir: 0.45,
  /** At fire the wrist is at least this far from the shoulder in 3D (AL). */
  straightMinExt: 0.58,
  /** The wrist travelled at least this far in 3D during the stroke (AL). */
  straightMinTravel: 0.22,
  /**
   * "Arm is out" score at fire = Σ (feature − centre)/scale over fused extension X, forward
   * depth (AL), elbow straightness and 3D extension (AL). Centres sit between straight punches
   * and guard changes (lowering the guard looks like a body punch until you check how far
   * out the arm is). Straights need score ≥ straightMinExtScore.
   */
  extScoreX: 0.5,
  extScoreFwd: 0.52,
  extScoreStraight: 0.33,
  extScoreExt: 0.75,
  straightMinExtScore: 0,
  /**
   * Scores in [straightAmbiguousExtScore, straightMinExtScore) are ambiguous (short body punch
   * vs. lowering the guard): wait up to pendingMaxMs; fire as soon as the hand comes back
   * (X drops by pendingRetractX or the wrist returns pendingRetractFrac of the way), reject
   * if it holds still.
   */
  straightAmbiguousExtScore: -2.6,
  /** A low (body-height) straight with peak drive below lazyBodyPeak that took longer than
   *  lazyBodyDurMs or crept in (ballistic ratio above lazyBodyEarly) waits for its retraction. */
  lazyBodyPeak: 1.9,
  lazyBodyDurMs: 280,
  lazyBodyEarly: 0.25,
  pendingMaxMs: 130,
  pendingRetractX: 0.08,
  pendingRetractFrac: 0.25,
  /**
   * WEAK straights — peak speed below weakStraightPeak (in multiples of the default onset, i.e. the
   * same physical speed at every sensitivity; scaled by the sensitivity like the onsets) — are only
   * fired once the retraction that follows a punch shows up within weakConfirmMs: the fused
   * extension drops weakRetractX below its peak AND the 3D reach drops weakRetractFwd (AL) or the
   * wrist comes weakRetractFrac of the way back in the picture. A deliberate reach / pointing at the
   * screen holds its position and is dropped (COM07). 0 = off.
   */
  weakStraightPeak: 2.0,
  /** …a straight is also weak when its speed index gives power < weakStraightPower, and a low peak
   *  only makes it weak while its power is below weakStraightPowerMax (see _power). */
  weakStraightPower: 0.12,
  weakStraightPowerMax: 0.4,
  weakConfirmMs: 320,
  weakRetractX: 0.12,
  weakRetractFwd: 0.1,
  weakRetractFrac: 0.35,
  /** …with untrusted depth: or the image-only extension dropped this much (0 = use the 3D reach as with clean depth).
   *  A stroke that starts within lowGuardRecentMs of a held LOW guard may also be confirmed by its 3D reach: a push
   *  from there comes back along the camera's axis, which the picture hardly shows (RV-INPUT-04). */
  weakRetractImgX: 0.15,
  /** …and at least this share of the stroke's own rise (in X and in 3D reach) must come back. */
  weakRetractShare: 0.3,
  /** At fire the elbow is at least this straight (0..1). */
  straightMinStraight: 0.15,
  /** At fire the fist is at most this far above the shoulder (AL) — higher is a wave / reach up. */
  straightMaxUp: 0.45,
  /** A 3D stroke of at least straightFwdShareFrom (AL) must be at least this much forward
   *  (bringing a hand down from / up to the face is not a punch). */
  straightFwdShareFrom: 0.35,
  straightMinFwdShare: 0.4,
  /** A straight ending within ~faceTouchSW of the head centre must be this far in front of the
   *  nose (AL); otherwise the hand went to the face. */
  straightMinNoseFwd: 0.3,

  // ── hook validation ──
  /** Wrist travel toward the midline (SW) from its most lateral point. */
  hookMinDisp: 0.42,
  /** Elbow raised at fire: world height relative to the shoulder (AL) above this, or image height (SW) above hookElbowImgMin. */
  hookElbowMin: -0.12,
  hookElbowImgMin: -0.3,
  /** Forearm in the image at fire: points toward the midline by at least this (SW) … */
  hookMinForeMed: 0.5,
  /** … and is roughly horizontal: |vertical| ≤ this × medial part (a wave's forearm is vertical). */
  hookForeSlope: 0.6,
  /** The fused extension still rises a little (the fist comes forward around the arc). */
  hookMinRise: 0.08,
  /** A would-be straight with the elbow out (≥ this, SW, image) and raised is held back for up
   *  to hookPendingMs after the stroke started, in case the fist then sweeps in (a hook). */
  hookPendingElbowOut: 0.12,
  hookPendingMs: 260,
  /** RT-6: …and fired as a straight once its drive has died without the sweep (false = dropped, the old rule). */
  hookPendingFire: true,
  /** V3-2: a hook whose arm ended extended — 3D elbow straightness ≥ this (≈ 128°) — with the elbow below the hook test's own
   *  "raised" limits in 3D (hookElbowMin) and in the picture (hookElbowImgMin − hookExtElbowImgMargin) is RELABELLED a straight
   *  thrown across the picture (0 = off). Relabel only (refix R-B): it changes the kind of a stroke that fires as a hook, never
   *  whether or when it fires — the first version sent such strokes down the straight's confirmation paths, and a real looping
   *  hook of the blind close-camera set (close-1 p111) was converted and then dropped (a miss). Clear cases only: the TUNE
   *  hook c2 p075 at 20 fps sat on both limits (straightness 0.61, picture elbow −0.32) and was converted; the close-webcam
   *  clip's jabs that fired as hooks have straightness 0.66–0.97 and the picture elbow at −0.36 … −0.54 SW (3D −0.12 … −0.24 AL).
   *  On the blind close-camera set it changes no straight: its straights that fire as hooks are bent at the decision (0.12–0.46). */
  hookExtMinS: 0.65,
  hookExtElbowImgMargin: 0.05,
  /** Body hooks (2026-11-13, a player's report: body shots registered less — people hook to the body, nobody throws
   *  straights there). A hook to the body is thrown with the elbow LOW: bent about 90° and kept by the side, the fist at
   *  rib height. The "elbow raised" test (hookElbowMin / hookElbowImgMin, imgHookElbow on the picture path) and the
   *  wrist floor 1.1 SW below the shoulder line are the head hook's: with them every body hook failed (synthetic body
   *  hooks: 0 of 240 recognised as hooks; the fist then came back up to the guard and fired as an uppercut to the HEAD).
   *  A fist that ends at body height — the target's own split (bodySplit) — needs instead the elbow out to its side by at
   *  least bodyHookElbowOut SW (the picture, elbow vs. its shoulder) and the fist above bodyHookMinY SW; the forearm's
   *  shape (long, flat, pointing at the midline), the sweep, the speed and every other hook gate stay. false = off. */
  bodyHook: true,
  bodyHookElbowOut: 0,
  bodyHookMinY: -1.7,

  // ── uppercut validation ──
  /** Upward wrist travel from its lowest point (image SW and world AL). */
  upMinRiseImg: 0.38,
  upMinRiseWorld: 0.1,
  /** Peak upward drive (× onset). */
  upMinPeak: 1.15,
  /** V2-11: …and the stroke's peak speed in DEFAULT-onset units at least this (sensitivity-independent; 0 = off): the eager
   *  settings lower the onsets, and a slow upward drift of a hand then passes as an uppercut (the new false fires at
   *  sensitivity 0.8: peak 1.29–1.80; timely uppercuts on the TUNE clips: ≥ 2.6; 1.6 cost the bench's slow synthetic
   *  uppercuts at 10 % double frame drops 12 detections, 1.3 none) */
  upMinPeakRaw: 1.3,
  /** The wrist must end at least this high relative to the shoulder (AL). */
  upMinEndWorld: -0.06,
  /** …and must not have come back toward the body by more than this (AL of forward depth): an
   *  uppercut drives up and slightly forward; yanking an extended arm back to the guard rises too. */
  upMinFwd: -0.22,
  /** Elbow stays low (AL relative to the shoulder) and the arm bent (straightness). */
  upMaxElbow: -0.17,
  upMaxStraight: 0.35,
  /** Little travel toward the midline (that would be a hook / a hand to the face). */
  upMaxMedial: 0.35,
  /** RT-15: an uppercut whose other hand rose ≥ this share of its own rise (since its lowest point) is the guard coming up (0 = off). */
  upOtherRiseMax: 0.45,
  upOtherRisePeak: 3.0,
  /** RT-7: …or more, with the forearm upright (vertical part ≥ upMedialForeRatio × |sideways part|) and the rise ≥
   *  upMedialRiseRatio × the sweep (0 = off). */
  upMedialForeRatio: 1.2,
  upMedialRiseRatio: 1.0,
  upMedialMinPeak: 2.5,
  /** V2-6: …and ending in front of the body's middle: at most this far (SW) out toward its own side (an uppercut that sweeps in
   *  drives to the chin; the rear hand bouncing back up to the guard beside the chin after a lead punch ends 0.2–0.4 SW out —
   *  TUNE c5's 'guard-drop' hard negatives; 9 = off). */
  upMedialMaxLat: 0.2,
  /** A scoop: the wrist first dips this far (SW) … or starts this low (SW, from a low guard). */
  upMinDip: 0.12,
  upLowStart: -0.55,
  /** Uppercuts WITHOUT a scoop (driven straight up from the chest; clean depth only, see
   *  depthTrustNoise — with untrusted depth the picture's path below, upImg*, takes them)
   *  need a clearly upright shape:
   *  elbow bent (straightness ≤), a 3D rise (AL), the forearm upright in the picture (vertical part
   *  ≥ upNoDipForeUp SW and ≥ upNoDipForeRatio × its part toward the midline), the uppercut-vs-straight
   *  discriminant ≥ upNoDipMinScore, and the fist ending in front of the face (AL ahead of the nose).
   *  Their image rise and up-drive may be smaller (× …Frac) since the travel is shorter. */
  upNoDipMaxStraight: 0.25,
  upNoDipRiseWorld: 0.14,
  upNoDipForeUp: 0.45,
  upNoDipForeRatio: 1.6,
  upNoDipMinScore: 0.5,
  upNoDipNoseFwd: 0.12,
  upNoDipRiseFrac: 0.75,
  /** …and it ends at chin height: at least this far (SW) below the head centre (a hand going up to
   *  the eyes — glasses, waving at face height — ends higher). */
  upNoDipBelowHead: 0.12,
  /** …in front of the body: the fist at most this far (SW) out from the body midline toward its own
   *  side (a wave or a raised hand ends out beside the shoulder). */
  upNoDipMaxLateral: 0.45,
  /** …and the other hand rose less than this share of its rise (both rising = raising the guard). */
  upNoDipOtherRise: 0.45,
  /** …and the fist travelled at least this far forward (AL; a hand going to the face comes back). */
  upNoDipMinFwd: 0.03,
  upNoDipPeakFrac: 0.7,
  /**
   * R1 — the PICTURE's dip-less uppercut (any depth quality: real MediaPipe depth is clean enough for the path above on
   * some machines, not on others): a fast upward drive of a bent arm, judged in the image at the decision —
   *  · the wrist rose ≥ upImgRise SW from its lowest point with an upward drive of ≥ upImgPeak × the onset,
   *  · the forearm stands up in the picture: the wrist ≥ upImgForeUp SW above its elbow and ≥ upImgForeRatio × its
   *    sideways offset (elbow below and roughly under the fist; a jab's forearm leans toward the midline, a hook's lies
   *    flat, a wave's elbow is out beside the head),
   *  · the elbow at most upImgElbowMax SW above the shoulder line,
   *  · the fist in front of the body (between upImgMinLateral and upNoDipMaxLateral SW out from the body midline toward
   *    its own side), at most upImgMaxAboveHead SW above the head centre (not above the head) and at least
   *    upImgMinBelowHead SW … i.e. not lower than that below it (chest to face height),
   *  · little sweep toward the midline (≤ upImgMaxMedial SW), the other hand not rising with it (upNoDipOtherRise),
   *  · with world landmarks, the 3D elbow not straightened (straightness ≤ upImgMaxStraight: a jab ends ≥ 0.5) and
   *    the fused extension ≤ upImgMaxX,
   *  · ending on the face (within faceTouchSW · 1.15 of the head centre in the picture) only in front of the nose
   *    (≥ upImgNoseFwd AL — even noisy depth sees a fist 15–30 cm in front of the face) or, without world landmarks, fast
   *    (peak drive ≥ faceTouchMaxDrive): glasses and scratching end on the face.
   * The usual gates (pull-back, slow / creeping, both hands, raised start, pause, region, face touch) apply as for every
   * stroke. Its 3D elbow-height limit is upImgElbowWorldMax (the fist ends higher than a scoop's).
   */
  upImgRise: 0.25,
  upImgPeak: 0.6,
  upImgForeUp: 0.4,
  upImgForeRatio: 2.5,
  upImgElbowMax: 0.35,
  upImgMinLateral: -0.15,
  upImgMaxAboveHead: 0.6,
  upImgMinBelowHead: 0.75,
  upImgMaxMedial: 0.3,
  upImgMaxStraight: 0.5,
  upImgMaxX: 0.8,
  upImgNoseFwd: 0.15,
  /** …and with world landmarks the fist at least this far in front of the nose (AL) wherever it ends: a hand on its way
   *  to the face (glasses) is level with the face, an uppercut's fist 15–30 cm in front of it. */
  upImgNoseFwdMin: 0.08,
  upImgElbowWorldMax: 0.08,
  /** A picture-only uppercut that ends within upImgFaceSW of the head centre (in the picture) waits for its way back
   *  down: the wrist drops ≥ upImgRetractSW below its highest point within upImgConfirmMs, else it was a hand going to
   *  the face (glasses, scratching, a hand to the mouth — they stop there) and is dropped. At the decision (the upward
   *  drive's peak) such a hand is still on its way up in front of the face, exactly like an uppercut. */
  upImgFaceSW: 0.45,
  upImgRetractSW: 0.1,
  /** …and at least this share of its rise (a hand settling at the face wobbles; a punch comes back). */
  upImgRetractShare: 0.3,
  upImgConfirmMs: 400,
  /** Discriminant vs. straights must exceed this; centres of its terms (straightness, elbow
   *  height AL, elbow image height SW, fused extension X) sit between uppercuts and straights. */
  upMinScore: 0,
  upCentreStraight: 0.38,
  upCentreElbow: -0.2,
  upCentreElbowImg: -0.3,
  upCentreX: 0.55,

  // ── retraction / re-arm (COM07, A05) ──
  /** No re-arm before this long after firing. */
  minCooldownMs: 120,
  /** Fraction of the stroke that must be undone before the hand re-arms. */
  retractFrac: 0.7,
  /** V3-1: …measured from the punch's own peak (the most extended point it reached, also after an early decision) instead of
   *  the fire's position (false = the old rule). */
  rearmFromPeak: true,
  /** R-E (refix): …and the punch's picture span (its fist's farthest distance from where it started) counts only within this long
   *  after the fire (ms; 0 = the whole cooldown, the V3-1 rule): tracked over the whole cooldown, a hand that wandered on after
   *  the punch (dropping, swinging aside) set a farther 'span' and then re-armed on its way back (−1 false fire at 20 fps on the
   *  real clips, no hit lost). The fused extension's peak keeps the whole cooldown: limited to 150 ms too it lost 5–10 timely
   *  real punches per condition (c3's and c4's fast series peak later). */
  rearmPeakMs: 150,
  /** For this long after re-arming, a stroke heading back (cosine ≥ returnMinCos) to where the
   *  previous punch started, and ending within returnNearSW of it, is the pull-back. */
  returnWindowMs: 900,
  returnNearSW: 0.4,
  returnMinCos: 0.6,
  /** V3-1: …but after this hand's BODY punch, a rising stroke whose picture shows the arm extending (its own extension rose ≥
   *  returnOutXi with the arm foreshortening, collapse +depthContraCol) is no return: the head shot of a body-then-head
   *  double-up (the synthetic ones lost it here: dXi 0.37–0.80, collapse +0.21–0.52); a return folds the arm back. 0 = off. */
  returnOutXi: 0.3,
  /** …and the 3D reach (shoulder→wrist distance or forward depth) grew at least this (AL; the real-clip returns the picture alone
   *  let through: ≤ 0.21 but one; the synthetic head shots after a body shot: ≥ 0.34). */
  returnOut3: 0.25,
  /** A hand that has been still this long after a punch re-arms where it is. */
  rearmStillMs: 250,
  /** V2-1: a stroke starting within recoverMs of this hand's punch whose picture direction opposes that punch's (cosine ≤
   *  recoverCos; the punch moved ≥ recoverMinPrev SW in the picture, the stroke ≥ recoverMinMove SW) is its way back (0 = off).
   *  Real clips: legit same-hand repeats within 700 ms (flurries, double jabs, jab-hook) have cosine ≥ 0.7 but for 3 of 45
   *  (−0.3 … 0.3); the duplicate fires on retractions −1 … −0.4. */
  recoverMs: 600,
  recoverCos: -0.35,
  recoverMinPrev: 0.3,
  recoverMinMove: 0.25,
  /** V3-1: …only for a stroke that began nearer the punch's END than this × its distance from the punch's start (the hand
   *  still out: its way back). A stroke from the guard the punch started at is a fresh punch whatever its direction — the
   *  second punch of a same-hand double-up (body then head, head then body): the synthetic double-ups' swallowed second
   *  punches all started at the guard (s0 0.0–0.3 SW from the punch's start, X fully retracted), the real-clip duplicates the
   *  rule exists for 0.35–1.05 SW from the punch's end and 1.8–2.3 SW from its start (0 = any start, the V2-1 rule). */
  recoverFromGuard: 1,
  /** V3-1: …and a stroke that starts still at the punch's end (the punch moved ≥ recoverMinPrev SW in the picture; the stroke's
   *  start within this × its distance from the punch's start of where the punch fired) continues that punch in any direction:
   *  the hand never came back (TUNE c4: an uppercut re-rising from its own top 120 ms after firing; real repeats start back
   *  near the guard — ≥ 0.4 of the way. 0 = off). R-D: 0.35 (was 0.25) now that the window below bounds it: TUNE c4's
   *  uppercut re-rises at sensitivity 0.2 started 0.31–0.34 of the way, 120 ms after the fire (2 duplicates). */
  recoverAtEnd: 0.35,
  /** R-D (refix): …only for a stroke that began within this long of the fire (ms; 0 = any time, the V3-1 rule): the punch's own
   *  follow-through. An uppercut ends at the chin — where a same-hand cross starts — so 'still at the end' alone swallowed
   *  that cross (synthetic rear uppercut → cross: its stroke began 130–480 ms after the uppercut fired); the TUNE c4 re-rises
   *  the rule is for began 80–120 ms after the fire. (Real flurries start their next punch 33–200 ms after the fire too, but
   *  back near the guard — toEnd/toStart ≥ 1 on c3 — so the window alone would not do.) */
  recoverAtEndMs: 125,
  /** After this long a slow-moving hand re-arms even if it never retracted. */
  maxCooldownMs: 1200,
  /** HandState.punching stays true this long after a punch fires (or until retraction). */
  punchFlagMs: 280,

  // ── plausibility gates (ERR03) ──
  /** Wrist above the head top by more than this (SW) … */
  maxWristAboveHead: 0.15,
  /** … and above the shoulder by more than this in 3D (AL) = hands up / waving: no punches. */
  maxWristUpWorld: 0.5,
  /** Wrist below this (SW, relative to the shoulder line) = hands down: no punches. */
  minWristY: -1.9,
  /** RT-5: a stroke whose sensitivity-independent peak speed reached regionFastPeak may end up to regionFastExtra SW higher
   *  (a real uppercut, or a jab seen by a low camera, ends ≈ 1.5 SW above the shoulder line in the picture and in 3D;
   *  waving, stretching and the pointer call are slow). 0 = off. */
  regionFastPeak: 3.5,
  regionFastExtra: 0.5,
  /** Current shoulder width must be ≥ this × the long-term one (player faces the camera) … (RT-2 had lowered it to 0.45 for
   *  real boxers who blade — a real straight's shoulders drop to p10 0.53 of the guard's width on the TUNE clips — but the
   *  punch's own turn is covered by facingPunchGraceMs: 0.45 recognised no more real punches than 0.72 on any clip and let
   *  turned-away gestures fire (V2-9), so it is back at 0.72) */
  facingMinRatio: 0.72,
  /** RT-2: face-size smoothing (ms) for the facing test's distance compensation (0 = off: the plain shoulder width), and the
   *  time constant (ms) with which the long-term shoulder width follows a narrowing the face explains (a step back). */
  facingHeadTauMs: 200,
  facingDistTauMs: 400,
  /** V2-10: …once the face-explained narrowing has lasted this long (ms; 0 = at once). */
  facingDistHoldMs: 2000,
  /** … unless the narrowing is brief: it must last this long to count (a twist, a turn of the head) — and while a
   *  punch is in flight or this hand just punched, facingPunchGraceMs: real punches turn the shoulders (their picture
   *  width drops below 0.72 of the guard's in 13–59 % of the punches of four real clips, R5), walking away or standing
   *  sideways lasts far longer. */
  facingGraceMs: 150,
  facingPunchGraceMs: 700,
  /** Torso yaw (3D shoulders) this far from its recent average for turnAwayMs = turning away / walking off. */
  turnAwayRad: 0.7,
  turnAwayMs: 250,
  /** Head speed (SW/s, image) above this = dodging (lean / duck): the gloves ride along with the body,
   *  so a stroke overlapping it (or starting within dodgeHoldMs after) only fires when the fist clearly
   *  moved on its own relative to the shoulders — the counter thrown while coming back upright, the
   *  punch thrown while slipping (COM06; INPUT-04): peak speed ≥ dodgeStrokeMinPeak × the default onset,
   *  and a straight's extension rose ≥ dodgeStrokeMinRise / a hook's or uppercut's fist travelled
   *  ≥ dodgeStrokeMinImg SW in the picture. Riding-along strokes are far weaker. */
  maxHeadSpeed: 1.8,
  dodgeHoldMs: 150,
  dodgeStrokeMinPeak: 2.0,
  /** …and such a stroke only starts once its drive reaches this (× onset). */
  dodgeStartDrive: 1.5,
  dodgeStrokeMinRise: 0.45,
  dodgeStrokeMinImg: 0.3,
  /** …or the fist clearly outpaced the head: its peak drive (sensitivity-independent) ≥ dodgeOutpace × the head's (or the
   *  whole body's, a duck) peak speed during the stroke (≥ maxHeadSpeed; in hook-onset units, SW/s ÷ 3) — a real punch
   *  carries the head along (≈ 2 SW/s at its peak
   *  in 60–70 % of the punches of three real clips, R5) far slower than the fist, while gloves riding along with a lean
   *  move about as fast as the head — and travelled at least dodgeOutpaceTravel × the strong-stroke distances
   *  (0 = off: only dodgeStroke* decide). */
  dodgeOutpace: 2.5,
  dodgeOutpaceTravel: 0.6,
  /** Whole-body (shoulder centre) speed above this (SW/s) = walking / repositioning — unless the motion is
   *  mostly vertical (|up/down| > duckBodyVertical × |sideways|): ducking, a dodge (see maxHeadSpeed). */
  maxBodySpeed: 2.6,
  duckBodyVertical: 1.5,
  /** A stroke ending this close to the face (SW, 2D) … */
  faceTouchSW: 0.28,
  /** … with the wrist less than this far in front of the face (AL) … */
  faceTouchForward: 0.22,
  /** … and a peak drive below this (× onset; real punches are faster) is a face touch. */
  faceTouchMaxDrive: 2.2,
  /** Other hand moved ≥ this fraction of this hand's 2D travel … */
  bilateralMinRatio: 0.55,
  /** … in the mirrored same direction (cosine ≥ this) → posture change, not a punch. */
  bilateralMinCos: 0.6,
  /** During a dodge (both hands ride along with the body) only a closer match counts: ≥ this ratio and cosine,
   *  or the other hand's extension rose as much. */
  bilateralDodgeRatio: 0.8,
  bilateralDodgeCos: 0.85,
  /** RT-9: …but not when the other hand moved at least this far (SW) in the picture against this one (0 = off). */
  bilateralOpposedSW: 0.3,
  /** A stroke is a pull-back (never a punch) when the fused extension X dropped by more than
   *  pullBackX, or the 3D shoulder→wrist distance by pullBackExt (AL), or the wrist's forward
   *  depth by pullBackFwd (AL). */
  pullBackX: 0.12,
  pullBackExt: 0.2,
  pullBackFwd: 0.25,
  /** RT-1 …the fused extension and the 3D reach only while the picture's own extension (foreshortening + leaving home)
   *  rose less than this; the picture's own extension dropping by pullBackX always counts (0 = old rule). */
  pullBackImgOut: 0.15,
  /** V3-5: a deep scoop (the wrist first dropped ≥ this, SW; then rise ≥ upMinRiseImg, speed ≥ upMinPeakRaw) with the forearm
   *  standing up is spared the picture-extension pull-back test like a fast upright rise (0 = only fast ones, imgPathMinPeak):
   *  slow 420 ms synthetic uppercuts (dip 0.68–0.79) were turned down as 'pulling-back' — their arm un-foreshortens as the
   *  forearm stands up. With shallower dips allowed (upMinDip 0.12) the real clips gained no punch and 2–4 false fires
   *  (dips 0.16–0.39). */
  pullBackScoopDip: 0.5,
  /** …from a start at most this far below the shoulder line (SW), with the fused extension at the scoop's bottom ≤ pullBackScoopMaxX
   *  and the picture's extension dropping at most pullBackScoopMaxDrop: synthetic slow uppercuts start −0.22 … +0.11 SW, X at
   *  the bottom −0.00 … 0.46, dXi −0.02 … −0.27; the returns from body shots that passed a looser version start −0.23 … −1.39,
   *  X 0.36 … 0.68 at the bottom, dXi −0.25 … −0.86 */
  pullBackScoopMinY: -0.3,
  pullBackScoopMaxX: 0.5,
  pullBackScoopMaxDrop: 0.35,
  /** R-A (refix, PRE-DROP-RETURN): neither exemption (the fast upright rise, the slow scoop) holds for a fist that RESTED at its
   *  lowest point away from its home: within max(restBandMin SW, restBandShare × its dip) of that point for ≥ restLowMs, with
   *  the fused extension there ≥ restAwayX (the hand had not settled there — the home follows a hand that rests). An uppercut's
   *  dip is its wind-up and flows into the drive; a hand dropped to the hip or the belly that pauses and comes back up to the
   *  guard is a return home, and the pull-back test judges it like one (the RECOG-FINAL / V3 trees fired 17–22 of 24 such
   *  returns with the real-like noise model, BASE 0–1). Measured rests (ms): synthetic uppercuts ≤ 134 (native and 420 ms, 15–60
   *  fps, both noise models); real uppercuts the exemption spares ≤ 133 (TUNE c4's swinging uppercuts drop the arm straight to
   *  the side too — their low point looks like the hip — but never pause: 0–120); drops to the hip 186–514 with a 150 ms
   *  pause, 60–217 (median 180) with an 80 ms one. 0 = off. */
  restLowMs: 150,
  restBandMin: 0.1,
  restBandShare: 0.1,
  restAwayX: 0.3,
  /** …and not where the fist rested out in front (3D forward reach ≥ this, AL; ∞ = no check) or within recoverMs of this hand's own
   *  punch: that low point is a body shot's hold (synthetic body straight → same-hand uppercut 450 ms later: the fist paused at
   *  0.26–0.76 AL, mostly ≥ 0.44, in front of the body; a hand dropped to the hip ≈ 0.1, onto the belly ≈ 0.3). */
  restMaxFwd: 0.4,
  /** …and the picture's extension dropping counts only while the 3D reach and extension did not both grow by this × the
   *  pull-back margins (a jab seen by a close, low camera un-foreshortens; 0 = always counts). */
  pullBackOut3: 2,
  /** RT-1: a stroke whose arm foreshortened in the picture (collapse rose ≥ depthContraCol) while its 3D forward reach
   *  shrank (≥ depthContraFwd AL) has contradictory depth: its straight test uses the picture only (0 = off). */
  depthContraCol: 0.05,
  depthContraFwd: 0.1,
  /** …and only for a fist that ends at least this high (SW from the shoulder line) or dropped at most depthContraMaxDrop SW. */
  depthContraMinY: -0.6,
  depthContraMaxDrop: 0.35,
  /** Straights: the (noisy) 3D shoulder→wrist distance may not shrink by more than this (AL). */
  maxExtensionLoss: 0.2,
  /** A hand that starts a stroke already extended (X above this, far from home) is not ready to punch. */
  maxStartX: 0.6,
  /**
   * Ballistic test: wrist motion (in the punch direction) during the 350 ms before the last
   * 250 ms may be at most this fraction of the motion in the last 250 ms before the stroke's
   * peak speed (a punch starts from a still hand; a slow reach or pointing gesture creeps).
   */
  maxEarlyRise: 0.55,
  /** …stricter for strokes that end low (body height: reaching for the desk, a slow reach that speeds up) — except
   *  a stroke that starts within lowGuardRecentMs of a held LOW guard: a body push from the low guard, where
   *  pointing and reaching never start (RV-INPUT-04). */
  maxEarlyRiseLow: 0.3,
  /** A stroke that started within this long after the wrist was above the head (a raised hand coming down —
   *  the menu pointer's call, a wave, a stretch) is not a punch. 0 = off. */
  raisedStartMs: 350,
  /** Straights: minimum average wrist speed (m/s) over the 250 ms before the decision. Lazy
   *  punches go ≥ ~0.5; a deliberate reach / pointing / easing the arm out ≈ 0.4–0.8, so this
   *  only trims the slowest of those (kept low on purpose: missed punches hurt more). */
  minPunchSpeed: 0.5,
  /** …a stroke whose wrist path in the last 250 ms is at least this long (SW) counts as fast
   *  even when its net displacement is small (scoops, arcs). */
  ballisticMinPathSW: 0.6,
  /** The ballistic test is anchored this long after the stroke's peak speed. */
  earlyAnchorMs: 90,
  /** RT-11: the picture's own classification of a fast stroke (sensitivity-independent peak speed ≥ imgPathMinPeak; 0 = off)
   *  that the 3D-supported tests turned down — hook / uppercut / straight shapes (see _classify). */
  imgPathMinPeak: 2.5,
  imgHookForeMed: 0.35,
  imgHookSlope: 0.8,
  imgHookElbow: -0.55,
  imgUpRise: 0.4,
  imgUpRiseVsMed: 0.8,
  imgUpForeUp: 0.55,
  imgUpForeRatio: 1.2,
  imgUpForeLen: 0.6,
  imgStraightRise: 0.3,
  imgStraightCol: 0.08,
  /** V2-9: …and, with world landmarks, the 3D elbow at least this straight at the decision (0 = off): a straight straightens
   *  the arm (real image-path straights: S ≥ 0.25 for 70 of 75), while a torso turning back toward the camera shrinks the
   *  picture's arm in shoulder-width units with the elbow still bent (synthetic turned-torso gestures: S ≤ 0.17). */
  imgStraightMinS: 0.2,
  /** V2-7: a straight judged on the picture alone (RT-11's, or RT-1's with contradicted depth) moved its fist at most this
   *  far (SW) OUT toward its own side in the picture: a punch goes at the camera or in toward the middle (real image-path /
   *  contradicted-depth straights: ≤ 0.32 but for two hooks' wind-ups), a reach to the phone or a drink beside the hip goes
   *  out (9 = off). */
  imgStraightMaxOut: 0.45,
  /** R-A (refix): …and no picture-only straight whose fist went DOWN ≥ imgDropOutY SW and OUT toward its own side ≥ imgDropOutX
   *  SW: a hand dropping to the hip foreshortens the arm in the picture on the way (the verifier's drop-to-hip gestures fired
   *  such 'straights' early in the drop). A punch drives toward the target, in front of the body: of the real picture-only
   *  straights that matched a labelled straight (six main clips, full 30 / 20 fps, lite), none moved like that; 5 of 8
   *  unmatched ones did (0 = off). */
  imgDropOutY: 0.3,
  imgDropOutX: 0.1,
  /** V2-2: no picture-only straight while the other hand's stroke — in flight or fired within otherLeadFiredMs — began no later
   *  than this one (+ otherLeadMs) and was at least as fast: the torso turn of that punch (false = off). */
  otherLeadOn: true,
  otherLeadMs: 0,
  otherLeadFiredMs: 150,
  /** V3-4: no straight at body height while the other hand's faster hook is in flight or fired within this long (ms): the rear
   *  arm drawing back to the body as the torso turns through the hook (0 = off). */
  otherHookMs: 80,
  /** R-C (refix): …only for a straight whose stroke began no later than this after the hook's (ms; Infinity = any time, the V3-4
   *  rule): the counter-rotation moves with the torso turn, at once (real clips: the hook's onset frame, 0 ms), while a body
   *  straight thrown after a hook begins after it — the V3-4 rule swallowed such combos 80–150 ms apart (synthetic lead hook →
   *  rear body at 80 ms: 104 vs 123 of 144). */
  otherHookLeadMs: 20,
  /** V2-8: no picture-only classification (RT-11's image path, RT-1's contradicted depth) for a stroke that overlapped a duck
   *  (the whole upper body moving down or up fast, see duckBodyVertical): bending the torso foreshortens both arms in the
   *  picture with the gloves riding along — the 3D tests judge such a stroke (false = allowed). */
  imgNoDuck: true,
  /** …and an image-path uppercut's upward drive reached imgUpDriveLead × the extension's. */
  imgUpDriveLead: 0.8,
  /** …an image-path uppercut fires on its way back down (≥ max(upImgRetractSW, this share of its rise) within upImgConfirmMs),
   *  an image-path straight that rose ≥ imgRiseConfirm SW on its retraction (weakConfirmMs): raising a hand, waving and
   *  stretching rise fast too but stay up. 0 = fire at once. */
  imgUpRetractShare: 0.2,
  /** V2-5: …and fires as a STRAIGHT when the fused extension reached this meanwhile (the arm went out: a straight thrown up from a
   *  low guard rises fast with an upright forearm at first — 60 fps synthetic: X 0.58–1.04 for those, ≤ 0.53 for 9 in 10 real
   *  uppercuts; 0 = off) */
  imgUpStraightX: 0.72,
  /** V2-3: a picture-only uppercut needs at least this punch power (the speed index of _power; 0 = off). */
  imgUpMinPower: 0.1,
  /** RT-14: the kind of every accepted stroke from the picture (see _classify; false = the tests' own kind). */
  kindFromImage: true,
  /** which RT-14 steps run: d = an uppercut that foreshortened or is not upright becomes a straight / hook, u = upright drive →
   *  uppercut, c = a hook with the elbow in front → straight, h = a straight that swept flat → hook, w = wind-up rejection */
  kindSteps: 'dw',
  kindUpForeUp: 0.5,
  kindUpForeRatio: 1.2,
  kindUpDrive: 1.0,
  kindUpMaxCol: 0.3,
  kindUpColStraight: true,
  kindHookDrive: 0.8,
  kindHookSlope: 0.45,
  kindHookRiseRatio: 1.3,
  kindWindupForeMed: -0.15,
  /** …a hook found by the tests becomes a straight only with its elbow ending this far (SW) in front of the shoulder or more. */
  kindCrossElbowOut: -0.1,
  /** RT-12: …and every other uppercut waits for its way back down too (this share of its rise; 0 = fire at once). */
  upAllRetractShare: 0,
  imgRiseConfirm: 0.45,
  /** RT-8: the picture's view decides alone when it saw the last 250 ms clearly (≥ this × its noise) with an early-motion
   *  ratio ≤ ballisticImgMaxR (0 = off). */
  ballisticImgSnr: 8,
  ballisticImgMaxR: 0.2,
  /** V2-8: …only for a hook-like stroke (its medial drive ≥ this × its extension drive; 0 = every stroke): RT-8 is for a
   *  hook's wind-up — a hand gesturing back and forth while talking swings the other way before each stroke too, and the
   *  picture's override let ≈ 5 % more of those fire as straights. */
  ballisticImgHook: 0.5,

  // ── target (COM02) ──
  /** Wrist height relative to the punching shoulder at a head punch (AL, world / SW, image). */
  headLevelWorld: 0.12,
  headLevelImage: 0.35,
  /** Typical drop from a head punch to a body punch (AL / SW). */
  bodyDropWorld: 0.62,
  bodyDropImage: 1.15,
  /** Body when the punch is below this fraction of the head→body drop. */
  bodySplit: 0.45,
  /** How fast the head-punch height reference adapts to this player/camera (0 = never). */
  headLevelAdapt: 0.18,

  // ── power ── (see _power(): sensitivity-independent, log-spread so the speed bonus differentiates)
  /** Punch speed index (geometric mean of the peak extension rate, 1/s, and 3D wrist speed, AL/s)
   *  that maps to power 0 … */
  powerSlowSpeed: 2.6,
  /** … and to power 1. */
  powerFastSpeed: 9,

  // ── guard (COM03) ──
  /** High guard: wrist height relative to the head centre (SW) — from … to. */
  guardHighMinRelHead: -0.75,
  guardHighMaxRelHead: 0.45,
  /** High guard: wrist within this lateral distance (SW) of the head centre. */
  guardHighMaxDx: 0.62,
  /** High guard: wrist at least this far above the shoulder line (SW). */
  guardHighMinY: 0.05,
  /** Low guard: wrist height band (SW, relative to the shoulder line). */
  guardLowMaxY: -0.3,
  guardLowMinY: -1.6,
  /** Low guard: wrist within this lateral distance (SW) of the body centre. */
  guardLowMaxDx: 0.62,
  /** Low guard: arm bent (straightness below this) and hand in front of the body (forward AL above this). */
  guardLowMaxStraight: 0.62,
  guardLowMinForward: 0.12,
  /** Hands moving faster than this (SW/s) are not holding a guard. */
  guardMaxSpeed: 3.0,
  /** Guard on/off hysteresis on the smoothed amount. */
  guardOn: 0.55,
  guardOff: 0.4,
  /** Smoothing time constant of guardAmount (ms). */
  guardTauMs: 70,

  // ── lean / duck / forward (COM04, research/mechanics.md §2.1 dodge table) ──
  // Each axis maps a PHYSICAL movement to lean units with a power curve that is exactly
  // `…Level` at the dodge movement (so ControlState.lean crosses game/combat.js's dodge
  // thresholds right there) and 1 at the `…Full` movement:
  //   sideways  the head (nose + eyes + ears) moves ≥ 0.35 shoulder widths from neutral
  //   back/fwd  the upper body moves ≥ leanZDodgeM metres away from / toward the camera (§2.1's
  //             "shoulders 12 % narrower" is that sway at ≈ 1 m; a fixed size change would need a
  //             3× bigger sway at 3 m than at 1 m — INPUT-10)
  //   duck      the head drops ≥ 0.35 shoulder widths
  /** Sideways head offset (SW) below which lean.x stays 0 (stance sway). */
  leanDeadzoneSW: 0.05,
  /** Sideways head offset (SW) at which lean.x reaches leanDodgeLevelX (§2.1: 0.35). */
  leanDodgeSW: 0.35,
  /** lean.x at the dodge movement — keep equal to COMBAT.dodgeLeanThreshold (game/combat.js). */
  leanDodgeLevelX: 0.42,
  /** Sideways head offset (SW) that reads as a full lean (lean.x = ±1). */
  leanFullSW: 0.6,
  /** Head drop (SW) below which lean.y stays 0. */
  duckDeadzoneSW: 0.06,
  /** Head drop (SW) at which lean.y reaches −duckDodgeLevel. */
  duckDodgeSW: 0.35,
  /** lean.y at the duck movement — keep equal to COMBAT.duckThreshold (game/combat.js). */
  duckDodgeLevel: 0.42,
  /** Head drop (SW) that reads as a full duck (lean.y = −1). */
  duckFullSW: 0.75,
  /** Head rise (SW) that reads as lean.y = +1 (linear above the deadzone). */
  riseFull: 0.6,
  /** Forward/back displacement (m) below which lean.z stays 0. */
  leanZDeadzoneM: 0.035,
  /** Displacement (m) at which |lean.z| reaches leanDodgeLevelZ — the same at every camera distance. */
  leanZDodgeM: 0.11,
  /** |lean.z| at that sway — keep equal to COMBAT.backLeanThreshold (game/combat.js). */
  leanDodgeLevelZ: 0.62,
  /** Displacement (m) that reads as a full forward/back lean (lean.z = ±1). */
  leanZFullM: 0.18,
  /** Image cue: the camera distance is estimated as focal × world shoulder width / image shoulder width.
   *  The focal length (frame widths) is not known; webcams are ≈ 0.7–1.0 (60–70° wide). */
  leanZFocal: 0.8,
  /** World shoulder width (m) assumed when the tracker gives no world landmarks. */
  leanZShoulderM: 0.36,
  /** Time constant (ms) of the low-pass on each forward/back cue (the cues jitter by several cm per frame). */
  leanZTauMs: 90,
  /** The world depth's slow wander is followed with this time constant while the picture shows no
   *  forward/back movement. */
  leanZWorldTrackMs: 2000,
  /** The cues are averaged only when they agree — shoulders with head size (see leanZAgreeHeadRatio), then the
   *  picture with the world depth: same direction, and within leanZAgreeSigma × their measured (filtered)
   *  jitter + leanZAgreeM (m) of each other or the smaller at least leanZAgreeRatio of the larger (once
   *  agreeing: until even leanZAgreeKeep has failed for leanZAgreeOffMs).
   *  Otherwise there is no lean: a torso twist narrows only the shoulders, a step changes the picture but
   *  not the hip-relative depth, a nod moves only the nose's depth. */
  leanZAgreeSigma: 2.5,
  leanZAgreeM: 0.03,
  leanZAgreeRatio: 0.35,
  leanZAgreeKeep: 0.25,
  leanZAgreeOffMs: 150,
  /** Shoulders and head size start agreeing only when the smaller movement is at least this share of the larger
   *  (and the larger is beyond twice the deadzone); they stop leanZAgreeHeadOffMs after that fails for good. */
  leanZAgreeHeadRatio: 0.4,
  leanZAgreeHeadOffMs: 80,
  /** A forward/back lean must persist this long before lean.z shows it (a torso twist narrows the
   *  shoulders for a moment just like leaning back does): lean.z = the smallest same-sign value of
   *  the last leanZHoldMs. The release is immediate. */
  leanZHoldMs: 110,
  /** Head filter (One-Euro on the RAW head centre, speeds in SW/s): steady at rest, ~10 Hz while
   *  leaning fast — the lean signal must stay fast (the view has to move within 150 ms end to end). */
  leanMinCutoff: 1.5,
  leanBeta: 3.2,
  leanDCutoff: 2.0,
  /** Without world landmarks the shoulder-width cue is confirmed by the head's own apparent size (spread of
   *  the face landmarks) instead: a torso twist narrows only the shoulders. The smaller of the shoulder
   *  movement and headScaleGain × the head movement counts. */
  headScaleGain: 1.15,
  /** V3-3 (off by default — see below): the tracker's depth cue counts at most leanZFaceCap × the face size's own forward/back
   *  estimate + leanZFaceSigma × the face cue's measured jitter, when it reads more than both picture cues (the head travels at
   *  least as far as the shoulders in a sway; the lite model's depth overstates a small one), and the picture's estimate is the
   *  face's own when the shoulders' size changed leanZTwistFace × as much as the face's and beyond their jitter (the excess is
   *  the torso twisting). 0 = off. Measured (refix-recog lean-gate probe: the recognizer straight on the close-webcam clip's
   *  recorder frames, and the repair-R1 test's own players): leanZFaceCap 1 + leanZTwistFace 2 cut the lite model's frames at
   *  lean.z ≤ −0.3 from 33 to 24 (≤ −0.62: 3 → 1; the full model 10 → 9), but noisy synthetic players' back dodges after a
   *  15 cm step reach the dodge level in 35.7 % of their frames instead of 39.5 % (the repair-R1 test's floor is 38 %). The
   *  twist rule alone gives the same clip counts and 37.9 %; the face cap alone changes nothing on the clip (37.2 %). (The fix
   *  round's "33 → 15, 3 → 0" did not reproduce: no setting of the two gives it.) The lite clip's forward reading the combat lane reported (64 frames ≥ 0.62) does not occur on this
   *  recognizer: its neutral is learned at 2.3 s like the full model's, where BASE's lite run learned it only at 11.6 s, in a
   *  posture farther back (a steady window with 0.59 of its frames 'ready' — the floor is neutralReadyShare 0.6 — then busy). */
  leanZFaceCap: 0,
  leanZFaceSigma: 1.0,
  leanZTwistFace: 0,
  /** lean.z cannot fall while a punch is in flight or the punching hand is still coming back — the torso
   *  twist narrows the shoulders — nor leanTwistHoldMs after (leanTwistHandSpeed > 0 also counts any hand moving faster than that,
   *  SW/s; 0 = off: the world-depth check covers wind-ups, and hands riding along with a lean must
   *  not block it). */
  leanTwistHandSpeed: 0,
  leanTwistHoldMs: 150,
  /** …or a stroke whose drive already reached this (× onset) is in flight. */
  leanTwistStrokeDrive: 1.6,

  // ── neutral pose (where "no lean" is; INPUT-01 / INPUT-02) ──
  /** Steadiness is judged on the last neutralWindowMs of quiet frames (no punch in flight) within the
   *  last neutralWindowMaxMs: split into 3 blocks, the block means of the head position (SW), the log
   *  shoulder width, the shoulder tilt (rad) and the hip-relative world depth (tracker m) may differ by
   *  at most these beyond what the measured jitter explains (2.5 standard errors of a block mean):
   *  landmark jitter averages out in a block; a step, a lean or a duck does not. */
  neutralWindowMs: 1000,
  neutralWindowMaxMs: 2200,
  neutralSteadySW: 0.08,
  neutralSteadyScale: 0.03,
  neutralSteadyTilt: 0.04,
  neutralSteadyDepthM: 0.04,
  /** The first neutral is learned from a steady window in which the hands were up (guard or stance) in
   *  at least this share of the frames (and, with a calibration, the shoulder tilt within
   *  neutralUprightTilt of the calibrated one) — or after neutralNoReadyMs of steadiness anyway.
   *  Until then lean = 0. */
  neutralReadyShare: 0.6,
  neutralUprightTilt: 0.15,
  /** "Hands up": both fists at least this high (SW from the shoulder line; a low guard ≈ −0.8, arms down ≈ −1.4). */
  neutralReadyMinY: -1.1,
  neutralNoReadyMs: 2500,
  /** Once steady for neutralSettleMs (after the window itself), the neutral follows the steady pose with
   *  this time constant: a step, a nudged camera or a lean held that long becomes the new "upright". */
  neutralSettleMs: 1000,
  neutralAdoptTauMs: 400,
  /** …except a held sideways lean (shoulders tilted ≥ neutralLeanTilt toward a head offset ≥ neutralLeanSW),
   *  which is only adopted after neutralLeanHoldMaxMs (nobody dodges that long). */
  neutralLeanTilt: 0.07,
  neutralLeanSW: 0.15,
  neutralLeanHoldMaxMs: 6000,
  /** Home (decision R1; RV-INPUT-01/02). The last neutral the player stood upright at (the lean below
   *  0.25 / 0.25 / 0.3 for neutralUprightMs, the neutral not being moved) is remembered. When the re-centring
   *  adopts a held POSTURE against it — a sideways lean (shoulders tilted by neutralLeanTilt), a duck (the head
   *  neutralTrackSW lower and the upper body neutralSwayM nearer in the hip-relative depth) or a forward / back
   *  sway (shoulders and head size moved together and the depth agrees — a step changes only the picture — by at
   *  least neutralSwayHomeM, a dodge-sized sway: coming back from a smaller one never reads as a dodge) — and that
   *  upright neutral looks the more upright of the two (a neutral learned in a sideways lean or a crouch does not),
   *  it is kept as home. As soon as the player is back near home — head within neutralHomeSW, shoulders as level as
   *  then, the picture's size and the depth within neutralHomeM, and for a sway also the lean's own forward / back
   *  estimate halfway back — on two frames over neutralHomeConfirmMs, home is the neutral again: coming back
   *  upright never reads as a dodge. Home is forgotten after neutralHomeKeepMs, or once the player stands upright
   *  somewhere else (a sideways lean: re-centred on the first steady half window; otherwise after neutralSettleMs).
   *  Forward / back has no absolute "upright" (the camera's pitch changes with every laptop lid): a home restored
   *  only by the forward / back cues is on probation for neutralHomeProbationMs — when the player goes straight back
   *  to the pose it was restored from, that pose was the upright one (e.g. the neutral was learned in a sway at the
   *  bout start and this was a real dodge toward it), so it is the neutral again at once and no forward / back home
   *  is kept any more in this bout. */
  neutralUprightMs: 300,
  neutralSwayM: 0.04,
  neutralSwayHomeM: 0.06,
  /** (standing up out of a crouch: the upper body back and the head this much higher — never a posture to keep home for) */
  neutralRiseSW: 0.245,
  neutralHomeSW: 0.2,
  neutralHomeM: 0.16,
  neutralHomeConfirmMs: 60,
  neutralHomeKeepMs: 20000,
  neutralHomeProbationMs: 1500,
  neutralHomeRevertMs: 250,
  neutralHomeRelapseMs: 6000,
  neutralHomeElsewhereMs: 100,
  /** Just back home, the neutral's forward/back references are refreshed once, from the first steady half window
   *  within this long (they are seconds old: the cues' slow wander has moved on). */
  neutralHomeRefreshMs: 2000,
  /** Small offsets (under neutralTrackSW on both axes, shoulders level with the neutral: stance sway, slow drift — never a
   *  dodge) are followed on quiet frames with this time constant (the place follow below leaves offsets under
   *  neutralFollowDeadSW to it). neutralTrackSW is also the "clearly lower" of a duck (see the home tunables). */
  neutralTrackSW: 0.3,
  neutralTrackMs: 5000,
  /** Item 15 — the PLACE the player boxes at. A player who never stands still for the steadiness test (an active
   *  boxer: the head bobs, slips and moves with every punch) is never re-centred by it, and the old small-offset tracking
   *  could not follow an offset of 0.3 SW or more: a neutral learned off the guard (square with the hands down, in a dip,
   *  before a step) stayed 0.3–0.5 SW off for tens of seconds on the real clips. So the neutral follows the place pose —
   *  per neutralPlaceBlockMs block the quiet-weighted mean of the pose, over the last neutralPlaceMs the weighted median
   *  of the block means (NeutralWindow.placePose: a slip, a duck or a combo filling less than half the window does not
   *  move it) — with time constant neutralFollowMs, on every frame while the window has samples for neutralPlaceCover of
   *  its time. Not toward a held posture: a sideways lean (the shoulders tilted ≥ neutralLeanTilt toward a head offset ≥
   *  neutralLeanSW AND the head moved over the shoulders that way by ≥ neutralFollowLeanRel of the offset — a step, a
   *  stance change or a wandering guard moves the shoulders with the head: the real clips' stuck offsets kept the head
   *  over the shoulders within ±0.09 SW, their real leans moved it 0.25–0.5 SW) or a duck (the head neutralTrackSW lower
   *  and the upper body neutralSwayM nearer): those stay with the steadiness path and its home (R1). Not while a home is
   *  kept or on probation, nor while the steadiness path is re-centring. Only the position and the posture references
   *  (shoulder tilt, head over the shoulders, torso side lean) follow; the forward / back references stay with the
   *  steadiness path. neutralPlaceMs 0 turns the place off (the steadiness path and the small-offset tracking only, as
   *  before item 15). */
  neutralPlaceMs: 3000,
  neutralPlaceBlockMs: 200,
  neutralPlaceCover: 0.8,
  neutralFollowMs: 1500,
  neutralFollowLeanRel: 0.15,
  /** …and only once the place has stayed off the neutral by more than neutralFollowDeadSW on that axis for
   *  neutralFollowHoldMs (counted up while it stays on that side, down twice as fast otherwise): a slip or a duck that fills
   *  the window for a moment is not followed. Smaller offsets are left to the small-offset tracking (neutralTrackMs). A
   *  provisional neutral follows at once: no hold, and inside the deadband too. */
  neutralFollowDeadSW: 0.1,
  neutralFollowHoldMs: 1000,
  /** Without a steadiness verdict (too few quiet samples left in the window: a busy stretch) the steadiness streak
   *  (steadyMs, the settle time of a re-centre) is kept for at most this long, then ends: a long combo is no evidence of
   *  standing still (before item 15 the streak carried through it). */
  neutralSteadyStaleMs: 1500,
  /** A frame's weight in the place pose: 1 when quiet, falling to neutralPlaceBusyW as the larger hand drive rises from
   *  neutralQuietDriveFrom to neutralQuietDriveTo (× the punch onset) and as the head speed rises from neutralQuietHeadFrom
   *  to neutralQuietHeadTo (SW/s) — the head between punches counts most, like the reference's guard baseline (frames
   *  without a punch and with a slow head). Measured on the real clips: drive median 0.3–0.4 on the recognizer's quiet
   *  frames, 1.0–1.45 on its busy ones; head speed median 0.7–1.3 on both. */
  neutralPlaceBusyW: 0.25,
  neutralQuietDriveFrom: 0.6,
  neutralQuietDriveTo: 1.2,
  neutralQuietHeadFrom: 0.8,
  neutralQuietHeadTo: 2.0,
  neutralQuietHoldMs: 200,
  /** …and as the head moves over the shoulders, against the neutral's, from neutralPlaceLeanRelFrom to neutralPlaceLeanRelTo
   *  (SW): a slip or a lean (the real clips' leans moved it 0.25–0.5 SW, their stuck offsets within ±0.09 SW).
   *  neutralPlaceLeanRelTo 0 = off. */
  neutralPlaceLeanRelFrom: 0.1,
  neutralPlaceLeanRelTo: 0.2,
  /** The first neutral of a player who never stands still: the place pose, once the hands were up for neutralReadyShare
   *  of its window and its older and newer halves agree within neutralPlaceDriftSW (boxing in place, not walking in).
   *  Such a first neutral is provisional: it is followed with neutralFollowFirstMs instead, and learned again from the
   *  first steady window in guard (no settle time, no home) — unless that window is a held lean or duck against it
   *  (_heldPosture: the steadiness path decides then, with its held-lean rule and home). One learned with the hands down
   *  (neutralNoReadyMs) is not provisional: the guard right after it may already be a dodge. */
  neutralPlaceDriftSW: 0.12,
  neutralFollowFirstMs: 500,
  neutralPlaceNearSW: 0.1,
  /** The place's height is the weighted median of only the blocks within neutralPlaceAgreeSW of its sideways median: a
   *  sideways lean also lowers the head, so slips to both sides around the guard would pull the place (and the neutral)
   *  down. */
  neutralPlaceAgreeSW: 0.2,
  /** After the player has been out of tracking this long, the neutral is learned again. */
  neutralForgetMs: 1500,

  // ── fighting stance (ControlState.stanceMs; tutorial step 1) ──
  /** Both fists at least this high (SW relative to the shoulder line; −0.6 ≈ mid-chest) … */
  stanceMinY: -0.6,
  /** … within this lateral distance of the body centre (SW) … */
  stanceMaxDx: 0.95,
  /** … not reaching out (HandState.reach) … */
  stanceMaxReach: 0.6,
  /** … hands moving slower than this (SW/s), and |lean| below this on every axis. */
  stanceMaxHandSpeed: 2.2,
  stanceMaxLean: 0.3,

  // ── pause gesture ──
  /** Both wrists this far above the head centre (SW) … */
  pauseAboveHead: 0.45,
  /** … for this long fires one pause event. */
  pauseHoldMs: 1200,

  // ── display values (R4): HandState x / y / reach drive the on-screen gloves, lean the dodge camera — their smoothing is
  //    visible lag. The punch features keep their own filtering; the OUTPUT values add back the lag each filter has right
  //    now on a steady motion (velocity × 1/(2π·cut-off) for the One-Euro filters, velocity × a fixed lead for the fused
  //    reach), faded in between …SpeedFrom and 2 × that speed (no extra jitter on a still hand) and capped at …MaxLead. ──
  /** Hands: on (1) / off (0); lead as a share of the wrist filter's current lag. (V2-10: off by default — on the real clips it
   *  gained 5–10 ms on two clips and none on two noisy ones, where it shook the resting gloves by up to +10 mSW per frame; and
   *  the render's own glove springs are being re-tuned for lag (polish R11), which would compensate the same lag twice.) */
  displayLead: 0,
  displayLeadSpeedFrom: 0.3,
  displayMaxLeadSW: 0.15,
  /** Reach: lead (ms) on the fused extension's rate (its world cues trail the picture by ≈ 25 ms on a jab; V2-10: 0 = off, as
   *  displayLead). */
  displayReachLeadMs: 0,
  displayReachRateFrom: 0.8,
  displayMaxLeadReach: 0.15,
  /** Lean x / y (the dodge camera AND combat's dodges): lead as a share of the head filter's current lag. */
  leanLead: 0.8,
  leanLeadSpeedFrom: 0.4,
  leanMaxLeadSW: 0.08,

  // ── activity ──
  /** Arm-motion energy (SW/s) that maps to activity 1. */
  activityFull: 4.5,
  activityTauMs: 350,
});

/**
 * Tuning with the Settings `sensitivity` (0..1, default 0.5) applied — the ONE knob players get
 * (InputHub.setSensitivity → GestureRecognizer.setSensitivity → here). With
 *   q = 2^((0.5 − sensitivity) · 1.3)     (0 → 1.57 strict · 0.5 → 1 · 1 → 0.64 eager)
 * the stroke onsets (xOnsetRate, hookOnsetSpeed, upOnsetSpeed) and the weak-straight speed
 * (weakStraightPeak) scale by q, and the travel a punch needs (straightMinRise, straightMinFwd,
 * hookMinDisp, upMinRiseImg, upMinRiseWorld) by √q. 0.5 is exactly DEFAULT_TUNING. Everything else
 * (lean/dodge mapping, guard, power, plausibility gates) is not affected; keyboard input ignores it.
 * A missing / non-numeric sensitivity counts as 0.5.
 * @param {Partial<typeof DEFAULT_TUNING>} [tuning]
 */
export function effectiveTuning(tuning = {}) {
  const t = { ...DEFAULT_TUNING, ...tuning };
  const raw = Number(t.sensitivity);
  const s = Number.isFinite(raw) && t.sensitivity !== null && t.sensitivity !== '' ? Math.min(1, Math.max(0, raw)) : DEFAULT_TUNING.sensitivity;
  const q = sensitivityScale(s);
  const rq = Math.sqrt(q);
  return {
    ...t,
    sensitivity: s,
    xOnsetRate: t.xOnsetRate * q,
    hookOnsetSpeed: t.hookOnsetSpeed * q,
    upOnsetSpeed: t.upOnsetSpeed * q,
    weakStraightPeak: t.weakStraightPeak * q,
    straightMinRise: t.straightMinRise * rq,
    straightMinFwd: t.straightMinFwd * rq,
    hookMinDisp: t.hookMinDisp * rq,
    upMinRiseImg: t.upMinRiseImg * rq,
    upMinRiseWorld: t.upMinRiseWorld * rq,
  };
}

/** Threshold multiplier for a sensitivity 0..1: 2^((0.5 − s)·1.3) (1 at the default 0.5). */
export function sensitivityScale(s) {
  return Math.pow(2, (0.5 - Math.min(1, Math.max(0, s))) * 1.3);
}

// ───────────────────────────── helpers ─────────────────────────────

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
/** Smooth 0→1 ramp between a and b (a may be > b for a falling ramp). */
const ramp = (x, a, b) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const emaK = (dtMs, tauMs) => (tauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tauMs));
/** The samples of a time-ordered history at least `minDtMs` apart, newest kept (a ≤ 42 Hz view of a 60 fps history;
 *  at 15–40 fps every sample stays). */
function thin(hist, minDtMs) {
  if (hist.length < 2 || !(minDtMs > 0)) return hist;
  const out = [hist[hist.length - 1]];
  for (let i = hist.length - 2; i >= 0; i--) if (out[out.length - 1].t - hist[i].t >= minDtMs) out.push(hist[i]);
  return out.reverse();
}
/** The newest sample of a time-ordered history at least `minDtMs` before tMs (null if none). */
function refBefore(hist, tMs, minDtMs) {
  for (let i = hist.length - 1; i >= 0; i--) if (tMs - hist[i].t >= minDtMs) return hist[i];
  return null;
}
/** Per-frame EMA weight `a` (tuned at 30 fps) for a frame `dtMs` long: the same smoothing per second at any rate. */
const emaA = (dtMs, a) => 1 - Math.pow(1 - a, Math.min(4, Math.max(0.25, dtMs / 33.3)));
/**
 * Physical offset → lean units (−1..1): 0 inside the deadzone `dz`, exactly `level` at `at`
 * (the dodge movement), 1 at `full`, a smooth power curve in between (gentle near the centre so
 * stance sway stays quiet, steeper toward the dodge). Monotonic; saturates at ±1.
 */
export function leanCurve(v, dz, at, level, full) {
  const a = Math.abs(v);
  if (!(a > dz)) return 0;
  const u = (a - dz) / Math.max(1e-6, at - dz);
  const span = Math.max(1 + 1e-6, (full - dz) / Math.max(1e-6, at - dz));
  const g = Math.log(1 / Math.min(0.999, Math.max(1e-3, level))) / Math.log(span);
  return Math.sign(v) * Math.min(1, level * Math.pow(u, g));
}

const SWAP_PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
function indexMap(swap) {
  const m = Array.from({ length: 33 }, (_, i) => i);
  if (swap) for (const [a, b] of SWAP_PAIRS) { m[a] = b; m[b] = a; }
  return m;
}

const HANDS = [Hand.LEFT, Hand.RIGHT];
const IDX = {
  left: { sh: LM.LEFT_SHOULDER, el: LM.LEFT_ELBOW, wr: LM.LEFT_WRIST },
  right: { sh: LM.RIGHT_SHOULDER, el: LM.RIGHT_ELBOW, wr: LM.RIGHT_WRIST },
};
/** Image points we smooth (anatomical indices, after the label swap). */
const IMG_POINTS = [LM.NOSE, LM.LEFT_EYE, LM.RIGHT_EYE, LM.LEFT_EAR, LM.RIGHT_EAR, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST, LM.LEFT_HIP, LM.RIGHT_HIP];
const WORLD_POINTS = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST,
  LM.LEFT_HIP, LM.RIGHT_HIP];
/** Face landmarks (nose, eyes, ears, mouth): their spread measures the head's apparent size (lean.z). */
const HEAD_SIZE_POINTS = [LM.NOSE, LM.LEFT_EYE_INNER, LM.LEFT_EYE, LM.LEFT_EYE_OUTER, LM.RIGHT_EYE_INNER, LM.RIGHT_EYE, LM.RIGHT_EYE_OUTER,
  LM.LEFT_EAR, LM.RIGHT_EAR, LM.MOUTH_LEFT, LM.MOUTH_RIGHT];
/** Points that get glitch rejection (fast, error-prone). */
const GLITCHY = new Set([LM.LEFT_WRIST, LM.RIGHT_WRIST, LM.LEFT_ELBOW, LM.RIGHT_ELBOW]);

/**
 * Fixed-size rolling window with quantiles (running estimates). Sorting is amortised: the
 * sorted copy is refreshed at most every `refreshEvery` pushes (quantiles of slowly varying
 * running estimates do not need per-frame precision).
 */
class RollingQuantile {
  constructor(size, refreshEvery = 15) {
    this.buf = new Float64Array(size); this.n = 0; this.i = 0;
    this.refreshEvery = refreshEvery; this._cache = null; this._since = 0;
  }
  push(x) {
    if (!Number.isFinite(x)) return;
    this.buf[this.i] = x; this.i = (this.i + 1) % this.buf.length; this.n = Math.min(this.n + 1, this.buf.length);
    this._since++;
  }
  quantile(q, fallback) {
    if (this.n === 0) return fallback;
    if (!this._cache || this._since >= this.refreshEvery || this._cache.length < Math.min(this.n, 20)) {
      this._cache = Array.from(this.buf.subarray(0, this.n)).sort((a, b) => a - b);
      this._since = 0;
    }
    const c = this._cache;
    return c[Math.min(c.length - 1, Math.max(0, Math.round(q * (c.length - 1))))];
  }
  reset() { this.n = 0; this.i = 0; this._cache = null; this._since = 0; }
}

/** Mean of field `k` over buf[i0 .. i1) (non-finite values skipped), or null when there is none. */
function avgOf(buf, i0, i1, k) {
  let s = 0, n = 0;
  for (let i = i0; i < i1; i++) { const v = buf[i][k]; if (v !== null && v !== undefined && Number.isFinite(v)) { s += v; n++; } }
  return n ? s / n : null;
}
/** Weighted median of vals[0..n) with weights wts (insertion sort of an index list: n ≤ ~20); null when no weight. */
function wMedian(vals, wts, n, idx) {
  let m = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    if (!(wts[i] > 0) || !Number.isFinite(vals[i])) continue;
    let j = m++;
    while (j > 0 && vals[idx[j - 1]] > vals[i]) { idx[j] = idx[j - 1]; j--; }
    idx[j] = i; tot += wts[i];
  }
  if (!m) return null;
  let acc = 0;
  for (let j = 0; j < m; j++) { acc += wts[idx[j]]; if (acc >= tot / 2) return vals[idx[j]]; }
  return vals[idx[m - 1]];
}
const PLACE_KEYS = ['hx', 'hy', 'tilt', 'relX', 'relY', 'lsw', 'lhs', 'wz', 'ts'];

/**
 * Recent upper-body samples for the neutral pose (lean, COM04).
 * - judge(): is the player standing still? On block means over the newest quiet samples (frames with a punch in flight
 *   are left out: the torso twist), so per-frame landmark jitter (≈ 2–4 % of the shoulder width per frame at 2–3 m)
 *   neither looks like motion nor hides a step; it gives the steady pose. No verdict while too few quiet samples are left
 *   (a busy stretch): the caller ends the steadiness streak after neutralSteadyStaleMs of that (item 15).
 * - placePose(): where the player boxes — for a player who never stands still. Per neutralPlaceBlockMs block, the
 *   quiet-weighted mean of every pose value (a frame's weight falls with the hands' punch drive and the head's speed, down
 *   to neutralPlaceBusyW: from motion, not from the punch state); over the last neutralPlaceMs, the weighted median of the
 *   block means — a slip, a duck or a combo that fills less than half of the window does not move it (the head's height
 *   from the blocks at its sideways position only, neutralPlaceAgreeSW).
 */
class NeutralWindow {
  constructor() { this.reset(); }
  reset() { this.buf = []; this.steadySince = null; this.lastVerdictT = null; this.blocks = []; this.cur = null; this.seq = 0; this._place = null; this._placeSeq = -1; this._idx = new Int32Array(64); }
  /** @param {{t:number, hx:number, hy:number, scx:number, scy:number, lsw:number, lhs:number|null, tilt:number,
   *           wz:number|null, ts:number|null, w:number, ready:boolean}} s */
  push(s, minDtMs = 0, T = null) {
    // (a ≤ 42 Hz view: a 60 fps camera's extra, correlated samples would shrink the block means' standard errors)
    const last = this.buf[this.buf.length - 1];
    if (last && s.t - last.t < minDtMs) return;
    this.buf.push(s);
    while (this.buf.length && s.t - this.buf[0].t > 3200) this.buf.shift();
    if (T && T.neutralPlaceMs > 0) this._toBlock(s, last ? Math.min(100, s.t - last.t) : 33, T);
  }
  _toBlock(s, dt, T) {
    let c = this.cur;
    if (!c || s.t - c.t0 >= T.neutralPlaceBlockMs) {
      if (c) {
        this.blocks.push(c); this.seq++;
        const keep = Math.ceil(T.neutralPlaceMs / T.neutralPlaceBlockMs) + 1;
        while (this.blocks.length > keep) this.blocks.shift();
      }
      c = this.cur = { t0: s.t, t1: s.t, dt: 0, ready: 0, w: {}, v: {} };
      for (const k of PLACE_KEYS) { c.w[k] = 0; c.v[k] = 0; }
    }
    c.t1 = s.t; c.dt += dt;
    if (s.ready) c.ready += dt;
    const w = Math.max(1e-3, s.w) * dt;
    const rel = 1 / Math.exp(s.lsw);
    const val = { hx: s.hx, hy: s.hy, tilt: s.tilt, relX: (s.hx - s.scx) * rel, relY: (s.hy - s.scy) * rel, lsw: s.lsw, lhs: s.lhs, wz: s.wz, ts: s.ts };
    for (const k of PLACE_KEYS) { const v = val[k]; if (v !== null && v !== undefined && Number.isFinite(v)) { c.w[k] += w; c.v[k] += w * v; } }
  }
  /**
   * The place pose: weighted medians (block weight = its quiet-weighted time) of the block means over the last
   * neutralPlaceMs, or null while less than neutralPlaceCover of that time has samples. {hx, hy, tilt, relX, relY, lsw,
   * lhs, wz, ts, readyShare, drift: how far (SW) the older and the newer half of the window disagree on the head}.
   * Recomputed only when a block closes.
   */
  placePose(T, tMs) {
    if (!(T.neutralPlaceMs > 0)) return null;
    if (this._placeSeq === this.seq) return this._place;
    this._placeSeq = this.seq;
    this._place = null;
    const B = this.blocks;
    let i0 = B.length;
    while (i0 > 0 && B[i0 - 1].t0 >= tMs - T.neutralPlaceMs - T.neutralPlaceBlockMs) i0--;
    const n = B.length - i0;
    if (n < 3) return null;
    let cover = 0, ready = 0;
    for (let i = i0; i < B.length; i++) { cover += B[i].dt; ready += B[i].ready; }
    if (cover < T.neutralPlaceCover * T.neutralPlaceMs) return null;
    const vals = new Float64Array(n), wts = new Float64Array(n);
    const idx = this._idx.length >= n ? this._idx : (this._idx = new Int32Array(n));
    const med = (k, a, b) => {
      for (let i = a; i < b; i++) { const bl = B[i0 + i]; wts[i - a] = bl.w[k]; vals[i - a] = bl.w[k] > 0 ? bl.v[k] / bl.w[k] : NaN; }
      return wMedian(vals, wts, b - a, idx);
    };
    const P = { readyShare: ready / cover, cover: cover / T.neutralPlaceMs, t: tMs };
    for (const k of PLACE_KEYS) P[k] = med(k, 0, n);
    if (P.hx === null || P.hy === null || P.lsw === null || P.tilt === null) return null;
    const h = n >> 1, sw = Math.exp(P.lsw);
    // the head's height: of the blocks at the place's sideways position only (within neutralPlaceAgreeSW) — a sideways lean
    // also lowers the head, so slips to both sides around the guard would pull the height of the place down
    {
      const ra = T.neutralPlaceAgreeSW * sw;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const bl = B[i0 + i];
        if (bl.w.hx > 0 && bl.w.hy > 0 && Math.abs(bl.v.hx / bl.w.hx - P.hx) <= ra) { wts[m] = bl.w.hy; vals[m] = bl.v.hy / bl.w.hy; m++; }
      }
      const hy = m >= 3 ? wMedian(vals, wts, m, idx) : null;
      if (hy !== null) P.hy = hy;
    }
    // the posture values (shoulder tilt, head over the shoulders, size, depth, torso side lean) of the blocks AT the place —
    // the head within neutralPlaceNearSW of the medians — so they describe one pose: separate medians could take the head
    // from guard blocks and the depth from duck blocks
    const r = T.neutralPlaceNearSW * sw, acc = {}, wsum = {};
    for (let i = i0; i < B.length; i++) {
      const bl = B[i];
      if (!(bl.w.hx > 0) || Math.abs(bl.v.hx / bl.w.hx - P.hx) > r || Math.abs(bl.v.hy / bl.w.hy - P.hy) > r) continue;
      for (const k of PLACE_KEYS) if (k !== 'hx' && k !== 'hy' && bl.w[k] > 0) { acc[k] = (acc[k] || 0) + bl.v[k]; wsum[k] = (wsum[k] || 0) + bl.w[k]; }
    }
    for (const k in acc) P[k] = acc[k] / wsum[k];
    const ox = med('hx', 0, h), oy = med('hy', 0, h), nx = med('hx', h, n), ny = med('hy', h, n);
    P.drift = ox === null || nx === null ? Infinity : Math.max(Math.abs(nx - ox), Math.abs(ny - oy)) / sw;
    this._place = P;
    return P;
  }
  /**
   * The steady test over the newest quiet samples (no punch in flight; windowMs of them, within neutralWindowMaxMs).
   * Returns null when there are not enough of them (the bout start, after a gap, a busy stretch), else {steady, mean
   * (computed when first read), readyShare, ranges}.
   */
  judge(T, tMs, windowMs = T.neutralWindowMs) {
    // (the newest quiet samples — no punch in flight — back to windowMs of them, within neutralWindowMaxMs)
    const all = this.buf, q = [];
    let span = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i];
      if (tMs - s.t > T.neutralWindowMaxMs) break;
      if (s.busy) continue;
      q.push(s);
      span = q[0].t - s.t;
      if (span >= windowMs) break;
    }
    q.reverse();
    const buf = q, end = q.length, i0 = 0;
    const n = end - i0;
    if (span < windowMs * 0.9 || n < 9) return null;
    const b = Math.floor(n / 3);
    const cut = [i0, i0 + b, end - b, end];
    // range of the block means beyond what the jitter alone explains: the standard error of a block mean
    // from the scatter inside the blocks (× 1.6 for the frame-to-frame correlation of tracker noise), so a
    // noisier tracker loosens the test instead of never letting it pass
    const excess = (k) => {
      let lo = Infinity, hi = -Infinity, ss = 0, cnt = 0;
      for (let j = 0; j < 3; j++) {
        const mu = avgOf(buf, cut[j], cut[j + 1], k);
        if (mu === null) return null;
        if (mu < lo) lo = mu;
        if (mu > hi) hi = mu;
        for (let i = cut[j]; i < cut[j + 1]; i++) { const v = buf[i][k]; if (v !== null && v !== undefined && Number.isFinite(v)) { ss += (v - mu) ** 2; cnt++; } }
      }
      const se = cnt > 3 ? 1.6 * Math.sqrt(ss / (cnt - 3)) / Math.sqrt(cnt / 3) : 0;
      return Math.max(0, hi - lo - 2.5 * se);
    };
    const lsw = avgOf(buf, i0, end, 'lsw');
    const sw = Math.exp(lsw);
    const rh = Math.max(excess('hx'), excess('hy')) / sw;
    const rs = excess('lsw');
    const rt = excess('tilt');
    const rz = excess('wz');
    const steady = rh <= T.neutralSteadySW && rs <= T.neutralSteadyScale && rt <= T.neutralSteadyTilt
      && (rz === null || rz <= T.neutralSteadyDepthM);
    let ready = 0;
    for (let i = i0; i < end; i++) if (buf[i].ready) ready++;
    let mean = null;
    const meanOf = () => {
      // (the head position as the median: robust to a short movement the steadiness test still let through)
      const med = (k) => { const v = []; for (let i = i0; i < end; i++) v.push(buf[i][k]); v.sort((a, c) => a - c); return v[v.length >> 1]; };
      let rx = 0, ry = 0;
      for (let i = i0; i < end; i++) { const s = buf[i], r = 1 / Math.exp(s.lsw); rx += (s.hx - s.scx) * r; ry += (s.hy - s.scy) * r; }
      return { hx: med('hx'), hy: med('hy'), lsw, lhs: avgOf(buf, i0, end, 'lhs'), tilt: avgOf(buf, i0, end, 'tilt'), wz: avgOf(buf, i0, end, 'wz'),
        relX: rx / n, relY: ry / n, ts: avgOf(buf, i0, end, 'ts') };
    };
    return { steady, readyShare: ready / n, ranges: { head: rh, scale: rs, tilt: rt, depth: rz }, get mean() { return mean || (mean = meanOf()); } };
  }
}

/** Neutral HandState. */
const restHand = (hand) => ({ x: hand === Hand.RIGHT ? 0.3 : -0.3, y: -0.1, reach: 0, punching: false });

// ───────────────────────────── per-hand tracker ─────────────────────────────

class HandTracker {
  constructor(hand) {
    this.hand = hand;
    this.sign = hand === Hand.RIGHT ? 1 : -1;
    this.reset();
  }

  reset() {
    this.state = 'ready';
    this.f = null;            // latest features
    this.prev = null;         // previous frame's features
    this.hist = [];           // recent features (≈ 600 ms) for stroke shape
    this.base = null;         // resting posture: {c: foreshortening, s: straightness, f: forward, w: wrist pos}
    this.stillSince = null;
    this.vel = [0, 0];
    this.xRate = 0;
    this.imgRate = 0;
    this.drive = { straight: 0, hook: 0, up: 0, max: 0 };
    this.stroke = null;
    this.fire = null;
    this.punchingUntil = 0;
    this.lastSeen = -Infinity;
    this.heldSince = null;
    this.refractory = false;
    this.lastFireT = -Infinity;
    this.lastStroke = null;   // {t0, peak, tFire} of this hand's last punch (V2-2)
    this.visTyp = null;       // this wrist's typical landmark visibility (RT-13)
    /** Why recent strokes did not fire (newest last) — for the lab and tests. */
    this.rejects = [];
  }
}

// ───────────────────────────── the recognizer ─────────────────────────────

export class GestureRecognizer {
  /**
   * @param {{calibration?: import('../core/types.js').Calibration|null,
   *          tuning?: Partial<typeof DEFAULT_TUNING>, aspect?: number}} [opts]
   *  (punches are read per hand: there is no stance — the choice was removed on 2026-11-10)
   */
  constructor({ calibration = null, tuning = {}, aspect } = {}) {
    this._tuningIn = { ...tuning };
    this.tuning = effectiveTuning(this._tuningIn);
    this._aspect = aspect || this.tuning.aspect;
    this.calibration = null;
    this.hands = { left: new HandTracker(Hand.LEFT), right: new HandTracker(Hand.RIGHT) };
    this.debug = null;
    this._fullReset();
    this.setCalibration(calibration);
  }

  // ── configuration ──

  /**
   * Apply (or clear) a calibration. Keeps motion state; resets references that depend on it.
   * Only player / tracker properties are taken from it (label swap, arm length, depth compression,
   * head-punch height, the upright shoulder tilt and head-over-shoulders offset): never an image
   * position or size — the player may stand elsewhere or the camera may have moved since (INPUT-01).
   * The neutral pose is learned in the bout (see _updateLean).
   */
  setCalibration(cal) {
    const prevSwap = this.calibration ? !!this.calibration.swapSides : null;
    this.calibration = cal || null;
    const swap = !!(cal && cal.swapSides);
    this._map = indexMap(swap);
    this._side = sideSignFor(swap);
    this._sideAcc = this._side * 0.5;
    if (prevSwap !== null && prevSwap !== swap) { this._neutral = null; this._clearHome(); if (this._nw) this._nw.reset(); }
    this._neutralPrior = null;
    if (cal) {
      if (cal.aspect) this._aspect = cal.aspect;
      if (Number.isFinite(cal.zScale)) this._kz = clamp(cal.zScale, this.tuning.zScaleMin, this.tuning.zScaleMax);
      if (Number.isFinite(cal.armLengthWorld) && cal.armLengthWorld > 0.2) this._armLen = cal.armLengthWorld;
      if (Array.isArray(cal.neutralUp) && cal.neutralUp.length === 3) this._up = v3norm(cal.neutralUp);
      const rel = cal.neutralHeadRel;
      this._neutralPrior = {
        tilt: Number.isFinite(cal.neutralTilt) ? cal.neutralTilt : null,
        relX: rel && Number.isFinite(rel.x) ? rel.x : null,
      };
      if (cal.headPunchLevel) {
        this._headRefW = cal.headPunchLevel.world ?? this.tuning.headLevelWorld;
        this._headRefI = cal.headPunchLevel.image ?? this.tuning.headLevelImage;
      }
    }
  }

  /** Merge new tuning values (e.g. {sensitivity: 0.7} from the settings slider). */
  setTuning(partial) {
    this._tuningIn = { ...this._tuningIn, ...partial };
    this.tuning = effectiveTuning(this._tuningIn);
  }

  setSensitivity(s) { this.setTuning({ sensitivity: s }); }

  /** Camera frame aspect (width/height); PlayerPose.aspect overrides it per frame. */
  setAspect(aspect) { if (aspect > 0) this._aspect = aspect; }

  /** Forget all motion state and running estimates (calibration and tuning are kept). */
  reset() {
    this._fullReset();
    this.setCalibration(this.calibration);
  }

  _fullReset() {
    this._t = null;
    this._img = new Map();
    this._wld = new Map();
    this._raw = new Map();      // last accepted raw image point (for glitch checks)
    this._prevRaw = new Map();  // recent accepted raw image points [{p, t}] (for the speed envelopes)
    this._env = {};
    this._suspect = new Map();
    this._raw2 = new Map();     // accepted raw point two frames ago (spike detection)
    this._rawT = new Map();
    this._rawT2 = new Map();
    this._headF = new OneEuroVector(2, { minCutoff: this.tuning.leanMinCutoff, beta: this.tuning.leanBeta, dCutoff: this.tuning.leanDCutoff });
    this._nw = new NeutralWindow(); // recent upper-body samples: steadiness + the steady pose (neutral)
    this._zf = null;                // low-passed forward/back cues (lean.z)
    this._zAgree = null;            // agreement state of those cues (hysteresis)
    this._zJit = null;              // per-frame jitter of the forward/back cues (for their weighting)
    this._wswQ = new RollingQuantile(90, 15);   // world shoulder width (m, image plane)
    this._lostSince = null;
    this._leanZ = null;             // debug: the forward/back cues of the last frame (m)
    this._zHist = [];               // lean.z persistence window
    this._twistUntil = -Infinity;   // lean.z twist guard (see _updateLean)
    this._driveHold = 0;            // the hands' punch drive, held with a decay (the place pose's frame weights)
    this._placeAcc = { x: 0, y: 0 };  // how long the place has been off the neutral, per axis (ms, signed; _followPlace)
    this._zFloor = null;
    for (const h of HANDS) this.hands[h].reset();
    this._lastOk = { shoulders: -Infinity, head: -Infinity, left: -Infinity, right: -Infinity };
    this._tracked = false;
    this._trackedSince = 0;
    this._everTracked = false;
    this._confidence = 0;
    this._swSlow = null;
    this._swFast = null;
    this._lhsF = null; this._lhsT = undefined; this._lrSlow = null; this._lr = null;
    this._side = MP_AXES.defaultSideSign;
    this._sideAcc = this._side * 0.5;
    this._map = indexMap(false);
    this._kz = this.tuning.zScalePrior;
    this._kzAcc = null;
    this._dzNoise = new RollingQuantile(150, 15);   // per-frame world-depth jitter of still joints (m)
    this._dzPrev = null;
    this._depthTrusted = false;
    this._armLen = null;
    this._armSamples = new RollingQuantile(240, 60);
    this._up = [0, -1, 0];
    this._neutral = null;
    this._clearHome();
    this._resetHomeProbation();
    this._headRefW = this.tuning.headLevelWorld;
    this._headRefI = this.tuning.headLevelImage;
    this._guard = { high: 0, low: 0, kind: GuardKind.NONE };
    this._lean = { x: 0, y: 0, z: 0 };
    this._head = { x: 0, y: 0 };
    this._activity = 0;
    this._pause = { since: null, latched: false };
    this._bodyPrev = null;
    this._bodySpeed = 0;
    this._bodyVel = [0, 0];
    this._headPrev = null;
    this._headSpeed = 0;
    this._yawSlow = null;
    this._turnSince = null;
    this._guardShown = GuardKind.NONE;
    this._guardSince = null;
    this._stanceSince = null;
    this._control = this._neutralControl();
  }

  _neutralControl() {
    return {
      tracked: false, confidence: 0, guard: GuardKind.NONE, guardAmount: 0,
      lean: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0 },
      hands: { left: restHand(Hand.LEFT), right: restHand(Hand.RIGHT) }, activity: 0,
      guardMs: 0, stanceMs: 0,
    };
  }

  // ───────────────────────────── per-frame entry point ─────────────────────────────

  /**
   * @param {import('../core/types.js').PlayerPose|null} pose
   * @param {number} tMs
   * @returns {{control: import('../core/types.js').ControlState, events: import('../core/types.js').InputEvent[]}}
   */
  update(pose, tMs) {
    const T = this.tuning;
    /** @type {import('../core/types.js').InputEvent[]} */
    const events = [];
    if (!Number.isFinite(tMs)) return { control: this._control, events };
    if (this._t !== null && tMs <= this._t) return { control: this._control, events };
    // only duplicates and > 100 fps are skipped (R3): a 60 fps camera's frames are all used — the frame-to-frame
    // differences that would double their per-second jitter are taken on a ≤ 42 Hz view instead (diffBaseMs)
    if (this._t !== null && tMs - this._t < T.minFrameIntervalMs) return { control: this._control, events };
    const dtMs = this._t === null ? 33 : tMs - this._t;
    if (this._t !== null && dtMs > T.maxGapMs) this._motionReset(dtMs);
    this._t = tMs;
    const dt = Math.min(dtMs, T.maxGapMs) / 1000;

    const obs = this._observe(pose);
    this._updateTracking(obs, tMs, dtMs);
    if (!obs || !obs.core) {
      for (const h of HANDS) this._abortStroke(this.hands[h]);
      this._control = this._composeControl(tMs, false);
      this._setDebug(tMs, obs, events);
      return { control: this._control, events };
    }

    this._smooth(obs, tMs, dtMs);
    const geo = this._geometry(obs, tMs, dtMs);
    for (const h of HANDS) this._handFeatures(this.hands[h], obs, geo, tMs, dt);
    this._estimateDepthScale(obs, dtMs);
    this._estimateDepthNoise(obs);
    for (const h of HANDS) {
      const ev = this._punchMachine(this.hands[h], geo, tMs);
      if (ev) events.push(ev);
    }
    this._updateGuard(geo, dtMs);
    this._updateLean(obs, geo, tMs, dtMs);
    this._updateActivity(dtMs);
    const pauseEv = this._updatePause(geo, tMs, obs);
    if (pauseEv) events.push(pauseEv);
    this._control = this._composeControl(tMs, true);
    this._setDebug(tMs, obs, events, geo);
    return { control: this._control, events };
  }

  /** Reset filters and motion state after a long frame gap (keeps running estimates; the neutral pose
   *  only when the gap was short — the player may stand elsewhere after a long one). */
  _motionReset(gapMs = 0) {
    this._img.clear(); this._wld.clear(); this._raw.clear(); this._raw2.clear(); this._rawT.clear(); this._rawT2.clear(); this._suspect.clear(); this._prevRaw.clear(); this._env = {}; this._envT = undefined; this._envPrevT = undefined;
    this._headF.reset();
    this._zf = null; this._zAgree = null;
    this._nw.reset();
    if (gapMs >= this.tuning.neutralForgetMs) this._neutral = null;
    this._zHist = [];
    this._bodyPrev = null;
    this._headPrev = null;
    this._headSpeed = 0;
    this._speedHist = [];
    for (const h of HANDS) {
      const ht = this.hands[h];
      ht.state = 'ready'; ht.stroke = null; ht.fire = null; ht.prev = null; ht.f = null; ht.hist = [];
      ht.vel = [0, 0]; ht.xRate = 0; ht.imgRate = 0; ht.refractory = true; ht.punchingUntil = 0;
    }
  }

  // ───────────────────────────── observation ─────────────────────────────

  _observe(pose) {
    if (!pose || !Array.isArray(pose.image) || pose.image.length < 25) return null;
    const T = this.tuning;
    const aspect = pose.aspect > 0 ? pose.aspect : this._aspect;
    const m = this._map;
    const img = pose.image;
    const wld = Array.isArray(pose.world) && pose.world.length >= 25 ? pose.world : null;
    const vis = (l) => (l ? (l.visibility ?? l.presence ?? 1) : 0);
    const ok = (i) => {
      const l = img[m[i]];
      return !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && vis(l) >= T.minVisibility
        && l.x > -0.03 && l.x < 1.03 && l.y > -0.03 && l.y < 1.03;
    };
    const o = { aspect, ok: {}, raw: {}, world: {}, vis: {} };
    for (const i of IMG_POINTS) {
      o.ok[i] = ok(i);
      const l = img[m[i]];
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y)) o.raw[i] = [l.x, l.y / aspect];
      o.vis[i] = vis(l);
    }
    // world landmarks are optional (some trackers omit them); zeros mean "absent"
    let worldOk = false;
    if (wld) {
      const a = wld[m[LM.LEFT_SHOULDER]], b = wld[m[LM.RIGHT_SHOULDER]];
      worldOk = !!a && !!b && Number.isFinite(a.x) && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.08;
      if (worldOk) {
        for (const i of WORLD_POINTS) {
          const l = wld[m[i]];
          if (l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z)) o.world[i] = [l.x, l.y, l.z];
        }
      }
    }
    o.hasWorld = worldOk;
    // head-size landmarks (lean.z confirmation): raw only, never smoothed
    o.headPts = {};
    for (const i of HEAD_SIZE_POINTS) {
      const l = img[m[i]];
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y) && vis(l) >= T.minVisibility) o.headPts[i] = [l.x, l.y / aspect];
    }
    // a wrist above the top of the picture with its elbow raised above the shoulder is a hand
    // held up (pause gesture, stretching) — not a lost hand
    o.upOut = {};
    for (const [w, e, sh] of [[LM.LEFT_WRIST, LM.LEFT_ELBOW, LM.LEFT_SHOULDER], [LM.RIGHT_WRIST, LM.RIGHT_ELBOW, LM.RIGHT_SHOULDER]]) {
      const lw = img[m[w]], le = img[m[e]], ls = img[m[sh]];
      o.upOut[w] = !o.ok[w] && !!lw && !!le && !!ls && lw.y < 0.03 && vis(le) >= T.minVisibility && le.y < ls.y;
    }
    o.headOk = o.ok[LM.NOSE] || (o.ok[LM.LEFT_EYE] && o.ok[LM.RIGHT_EYE]);
    o.shouldersOk = o.ok[LM.LEFT_SHOULDER] && o.ok[LM.RIGHT_SHOULDER];
    o.core = o.shouldersOk && o.headOk;
    return o;
  }

  _updateTracking(obs, tMs, dtMs = 33) {
    const T = this.tuning;
    if (obs) {
      if (obs.shouldersOk) this._lastOk.shoulders = tMs;
      if (obs.headOk) this._lastOk.head = tMs;
      if (obs.ok[LM.LEFT_WRIST] || obs.upOut[LM.LEFT_WRIST]) this._lastOk.left = tMs;
      if (obs.ok[LM.RIGHT_WRIST] || obs.upOut[LM.RIGHT_WRIST]) this._lastOk.right = tMs;
    }
    const fresh = (k) => tMs - this._lastOk[k] <= T.lostAfterMs;
    const all = fresh('shoulders') && fresh('head') && fresh('left') && fresh('right');
    // out of the picture for a while: where they come back is a new neutral (learned again, INPUT-02)
    if (this._neutral && tMs - Math.min(this._lastOk.shoulders, this._lastOk.head) >= T.neutralForgetMs) {
      this._neutral = null;
      this._nw.reset();
    }
    if (all) this._everTracked = true;
    if (all && !this._tracked) this._trackedSince = tMs;
    this._tracked = all;
    // confidence: visibility of the core landmarks, smoothed
    let c = 0;
    if (obs) {
      const core = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST];
      for (const i of core) c += clamp01(obs.vis[i] ?? 0);
      c /= core.length;
    }
    if (!all) c *= 0.5;
    this._confidence += (c - this._confidence) * emaA(dtMs, 0.25);
  }

  /** Glitch-checked One-Euro smoothing of image (shoulder-width units) and world points. */
  _smooth(obs, tMs, dtMs) {
    const T = this.tuning;
    const sw = this._swSlow || this._swFast || 0.15;
    const beta = T.imgBeta / sw;
    obs.held = {};
    for (const i of IMG_POINTS) {
      const raw = obs.raw[i];
      if (!raw || !obs.ok[i]) { obs.held[i] = true; continue; }
      let f = this._img.get(i);
      if (!f) { f = new OneEuroVector(2, { minCutoff: T.imgMinCutoff, beta, dCutoff: T.imgDCutoff, minDerivDtMs: T.diffBaseMs }); this._img.set(i, f); }
      f.setParams({ beta });
      if (GLITCHY.has(i) && f.initialized) {
        const last = this._raw.get(i);
        const lim = Math.max(T.glitchMinJumpSW, T.glitchSpeedSW * dtMs / 1000) * sw;
        const pred = last ? [last[0] + f.velocity[0] * dtMs / 1000, last[1] + f.velocity[1] * dtMs / 1000] : f.value;
        const jump = Math.hypot(raw[0] - pred[0], raw[1] - pred[1]);
        let suspicious = jump > lim;
        if (!suspicious && (i === LM.LEFT_WRIST || i === LM.RIGHT_WRIST)) suspicious = this._implausibleWrist(i, raw, obs, sw, dtMs);
        const sus = this._suspect.get(i);
        if (suspicious) {
          if (sus && Math.hypot(raw[0] - sus.raw[0], raw[1] - sus.raw[1]) < 0.35 * sw + lim * 0.5) {
            if (tMs - sus.t >= T.glitchConfirmMs) {
              // the jump persisted (two frames at 30 fps, three at 60): it is real (fast motion or re-acquired), re-seed
              this._suspect.delete(i);
              f.seed(raw, tMs);
              this._acceptRaw(i, raw, tMs, sw, f);
              obs.reseeded = obs.reseeded || {};
              obs.reseeded[i] = true;
              continue;
            }
            obs.held[i] = true;   // still where it jumped to, not long enough yet (a fast camera): keep holding
            obs.glitch = true;
            continue;
          }
          this._suspect.set(i, { raw, t: tMs });
          obs.held[i] = true;   // ignore this frame for this point
          obs.glitch = true;
          continue;
        }
        // the previous frame jumped away and this one is back: that frame was a glitch. It was
        // held, so it never reached the features — nothing to taint (tainting here only dropped
        // ~4 % of real punches at random in the synthetic matrix, without removing false ones)
        if (sus) this._suspect.delete(i);
      }
      f.filter(raw, tMs);
      if (GLITCHY.has(i)) this._acceptRaw(i, raw, tMs, sw, f); else this._raw.set(i, raw);
    }
    // image-speed envelopes (SW/s) per arm and for the body: they steer the world smoothing
    const dtS = Math.max(1e-3, dtMs / 1000);
    // (speeds over ≥ diffBaseMs: a 60 fps camera's frame-to-frame jitter would double them; updated only on the ≤ 42 Hz
    // grid — a peak follower fed twice as many noisy samples would ride higher, R3)
    const envGrid = this._envT === undefined || tMs - this._envT >= T.diffBaseMs;
    if (envGrid) { this._envPrevT = this._envT; this._envT = tMs; }
    const envOf = (pts, key) => {
      if (!envGrid) return this._env[key] || 0;   // (held between grid frames)
      let v = 0;
      for (const i of pts) {
        const r = obs.raw[i], qs = this._prevRaw.get(i);
        const q = qs && (refBefore(qs, tMs, T.diffBaseMs) || qs[0]);
        // (over the time back to that sample — at 60 fps two frames — but at most 2 × diffBaseMs: after a held frame the
        // 15–40 fps speeds stay what they were tuned on)
        if (r && q && obs.ok[i] && !obs.held[i]) v = Math.max(v, Math.hypot(r[0] - q.p[0], r[1] - q.p[1]) / sw / Math.max(dtS, Math.min(tMs - q.t, T.diffBaseMs * 2) / 1000));
      }
      const prev = this._env[key] || 0;
      const dg = Math.max(dtMs, tMs - (this._envPrevT ?? (tMs - dtMs)));   // time since the last grid update
      // (attack 0.8 per grid update — ≥ diffBaseMs apart, so a 60 fps feed updates like 30 fps — as tuned; release per time)
      this._env[key] = v > prev ? prev + (v - prev) * 0.8 : prev + (v - prev) * emaK(dg, T.worldEnvReleaseMs);
      return this._env[key];
    };
    const envL = envOf([LM.LEFT_ELBOW, LM.LEFT_WRIST], 'left');
    const envR = envOf([LM.RIGHT_ELBOW, LM.RIGHT_WRIST], 'right');
    const envB = envOf([LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.NOSE], 'body');
    for (const i of IMG_POINTS) {
      if (!(obs.raw[i] && obs.ok[i] && !obs.held[i])) continue;
      // (the last few accepted raw points: the speed reference is the newest one ≥ diffBaseMs old — two frames at 60 fps)
      const qs = this._prevRaw.get(i) || [];
      qs.push({ p: obs.raw[i], t: tMs });
      while (qs.length > 4) qs.shift();
      this._prevRaw.set(i, qs);
    }
    if (obs.hasWorld) {
      const kz = this._kz;
      const trusted = this.depthTrusted;
      for (const i of WORLD_POINTS) {
        const w = obs.world[i];
        if (!w) continue;
        if (GLITCHY.has(i) && obs.held[i]) continue;   // same frame rejected in the image
        const x = [w[0], w[1], w[2] / kz];        // undo the depth compression
        let f = this._wld.get(i);
        if (!f || (obs.reseeded && obs.reseeded[i])) { this._wld.set(i, { value: x, initialized: true }); continue; }
        // world depth is noisy: smooth hard while the image says this part is still, lightly while it moves
        const env = (i === LM.LEFT_ELBOW || i === LM.LEFT_WRIST) ? envL : (i === LM.RIGHT_ELBOW || i === LM.RIGHT_WRIST) ? envR : envB;
        const a = 1 / (1 + 1 / (2 * Math.PI * (T.worldMinCutoff + (trusted ? T.worldBetaImgTrusted : T.worldBetaImg) * env) * dtS));
        for (let k = 0; k < 3; k++) f.value[k] += (x[k] - f.value[k]) * a;
      }
    }
  }

  /**
   * Record an accepted raw point and catch A→B→A spikes: back within glitchSpikeReturnSW of the
   * position two accepted frames ago while the middle one was far from both — no human motion
   * goes out and back in two frames. The middle frame was a glitch: re-seed and taint the arm.
   */
  _acceptRaw(i, raw, tMs, sw, f) {
    const T = this.tuning;
    const p1 = this._raw.get(i), p2 = this._raw2.get(i);
    const t1 = this._rawT.get(i), t2 = this._rawT2.get(i);
    // only (nearly) consecutive frames — not across a dropout — can form a spike
    if (p1 && p2 && t1 !== undefined && t2 !== undefined && t1 - t2 <= T.glitchSpikeLegMs
      && tMs - t1 <= T.glitchSpikeLegMs && tMs - t2 <= T.glitchSpikeMaxMs) {
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / sw;
      // (both legs long = a slow camera, not one dropped frame: then the spike must also be faster than glitchSpikeSpeedSW)
      const slowCam = Math.min(t1 - t2, tMs - t1) >= 55;
      const outMin = slowCam ? Math.max(T.glitchSpikeSW, T.glitchSpikeSpeedSW * (t1 - t2) / 1000) : T.glitchSpikeSW;
      const backMin = slowCam ? Math.max(T.glitchSpikeSW, T.glitchSpikeSpeedSW * (tMs - t1) / 1000) : T.glitchSpikeSW;
      if (d(raw, p2) < T.glitchSpikeReturnSW && d(p1, raw) > backMin && d(p1, p2) > outMin) {
        f.seed(raw, tMs);
        if (i === LM.LEFT_WRIST || i === LM.LEFT_ELBOW) this.hands.left.glitchT = t1;
        if (i === LM.RIGHT_WRIST || i === LM.RIGHT_ELBOW) this.hands.right.glitchT = t1;
      }
    }
    if (p1) { this._raw2.set(i, p1); this._rawT2.set(i, t1); }
    this._raw.set(i, raw);
    this._rawT.set(i, tMs);
  }

  /**
   * Geometric plausibility of a raw wrist position (catches one-frame glitches that are small
   * enough to pass the speed limit, which must allow very fast hooks): the 2D forearm
   * suddenly much longer than any recent pose, or the wrist snapping onto the other wrist.
   */
  _implausibleWrist(i, raw, obs, sw, dtMs) {
    const T = this.tuning;
    const el = obs.raw[i === LM.LEFT_WRIST ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW];
    if (el && obs.ok[i === LM.LEFT_WRIST ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW]) {
      const fore = Math.hypot(raw[0] - el[0], raw[1] - el[1]) / sw;
      if (fore > T.glitchForeMaxSW) return true;
    }
    const oi = i === LM.LEFT_WRIST ? LM.RIGHT_WRIST : LM.LEFT_WRIST;
    const o = obs.raw[oi], last = this._raw.get(i), oLast = this._raw.get(oi);
    if (o && last && oLast && Math.hypot(raw[0] - o[0], raw[1] - o[1]) < T.glitchSnapSW * sw
      && Math.hypot(last[0] - oLast[0], last[1] - oLast[1]) > 3 * T.glitchSnapSW * sw) return true;
    return false;
  }

  /** Smoothed image point in uniform units (or null). */
  _ip(i) { const f = this._img.get(i); return f && f.initialized ? f.value : null; }
  /** Smoothed, depth-corrected world point (or null). */
  _wp(i) { const f = this._wld.get(i); return f && f.initialized ? f.value : null; }

  /** Body frame, scale and reference quantities shared by both hands. */
  _geometry(obs, tMs, dtMs) {
    const T = this.tuning;
    const lS = this._ip(LM.LEFT_SHOULDER), rS = this._ip(LM.RIGHT_SHOULDER);
    const sc = [(lS[0] + rS[0]) / 2, (lS[1] + rS[1]) / 2];
    const swCur = Math.hypot(rS[0] - lS[0], rS[1] - lS[1]);
    // side sign from the shoulder order (robust to mirrored feeds), with strong hysteresis
    const order = Math.sign(rS[0] - lS[0]) * clamp01(Math.abs(rS[0] - lS[0]) / Math.max(1e-4, swCur));
    this._sideAcc += (order - this._sideAcc) * emaK(dtMs, 1500);
    if (Math.sign(this._sideAcc) !== this._side && Math.abs(this._sideAcc) > 0.5) this._side = Math.sign(this._sideAcc);
    // long-term shoulder width (does not follow quick turns)
    if (this._swSlow === null) this._swSlow = swCur;
    // RT-2: …but a change of the camera distance at once: stepping back or forward shrinks / grows the face with the
    // shoulders, a turn narrows only the shoulders (a real player who started the bout next to the camera and stepped
    // back read as "turned away" for 6 s, every punch blocked, and every distance in the picture looked half as big).
    // r = log(shoulder width / face size) and its slow average: the facing test compares r (see _facing).
    const lhs = T.facingHeadTauMs > 0 ? this._headSize(obs) : null;
    if (lhs !== null) { this._lhsF = this._lhsF === null || this._lhsF === undefined ? lhs : this._lhsF + (lhs - this._lhsF) * emaK(dtMs, T.facingHeadTauMs); this._lhsT = tMs; }
    else if (this._lhsT !== undefined && tMs - this._lhsT > 600) { this._lhsF = null; this._lrSlow = null; }
    const lr = this._lhsF !== null && this._lhsF !== undefined ? Math.log(Math.max(1e-4, swCur)) - this._lhsF : null;
    if (lr !== null) {
      if (this._lrSlow === null || this._lrSlow === undefined) this._lrSlow = lr;
      this._lrSlow += (lr - this._lrSlow) * emaK(dtMs, lr >= this._lrSlow + Math.log(0.8) ? 1200 : 6000);
    }
    this._lr = lr;
    // (a narrowing the face explains — the ratio steady — is a step back: the long-term width follows it quickly)
    // (V2-10: only once that has lasted facingDistHoldMs — a step back stays; a boxer blading for a punch turns the head
    // with the shoulders, the face 'explains' the narrowing for a moment, and a unit following that shakes every position)
    const distNow = lr !== null && swCur < this._swSlow * 0.8 && lr >= this._lrSlow + Math.log(0.85);
    if (!distNow) this._distSince = null; else if (this._distSince === null || this._distSince === undefined) this._distSince = tMs;
    const distMove = distNow && tMs - this._distSince >= T.facingDistHoldMs;
    const facingNow = swCur >= this._swSlow * 0.8;
    this._swSlow += (swCur - this._swSlow) * emaK(dtMs, facingNow ? 1200 : distMove ? T.facingDistTauMs : 6000);
    this._swFast = swCur;
    const sw = Math.max(swCur, this._swSlow * 0.85, 1e-3);
    const side = this._side;
    const toP = (p) => [side * (p[0] - sc[0]) / sw, -(p[1] - sc[1]) / sw];
    // head centre (nose + eye midpoint + ear midpoint, whichever are visible)
    const head = this._headCentre(obs);
    // body speed (walking / repositioning) and head speed (dodging: leaning, ducking); the smoothing is per
    // time, not per frame, so it means the same at 15 and at 60 fps (INPUT-07)
    if (this._bodyPrev) {
      const dts = dtMs / 1000;
      const vx = (sc[0] - this._bodyPrev[0]) / sw / dts, vy = (sc[1] - this._bodyPrev[1]) / sw / dts;
      const kb = emaA(dtMs, 0.5);
      this._bodySpeed += (Math.hypot(vx, vy) - this._bodySpeed) * kb;
      this._bodyVel = [this._bodyVel[0] + (vx - this._bodyVel[0]) * kb, this._bodyVel[1] + (vy - this._bodyVel[1]) * kb];
    }
    this._bodyPrev = sc.slice();
    if (head && this._headPrev) {
      const v = Math.hypot(head[0] - this._headPrev[0], head[1] - this._headPrev[1]) / sw / (dtMs / 1000);
      this._headSpeed += (v - this._headSpeed) * emaA(dtMs, 0.45);
    }
    if (head) this._headPrev = head.slice();
    // (the last ~400 ms of head / body speeds: a stroke right after a dodge is judged against the dodge's speed)
    const sh = this._speedHist || (this._speedHist = []);
    sh.push([tMs, this._headSpeed, this._bodySpeed]);
    while (sh.length && tMs - sh[0][0] > 400) sh.shift();
    const g = {
      sc, sw, swCur, side, toP, head, headP: head ? toP(head) : [0, 0.5],
      facing: this._facing(swCur, tMs) && !this._turnedAway(obs, dtMs),
      bodySpeed: this._bodySpeed,
      bodyVel: this._bodyVel,
      headSpeed: this._headSpeed,
      shoulderP: { left: toP(lS), right: toP(rS) },
      world: null,
    };
    // world frame: up from the torso (camera tilt), forward = toward the camera
    if (obs.hasWorld) {
      const wl = this._wp(LM.LEFT_SHOULDER), wr = this._wp(LM.RIGHT_SHOULDER);
      const hl = this._wp(LM.LEFT_HIP), hr = this._wp(LM.RIGHT_HIP);
      if (wl && wr) {
        const wsc = [(wl[0] + wr[0]) / 2, (wl[1] + wr[1]) / 2, (wl[2] + wr[2]) / 2];
        const hip = hl && hr ? [(hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2, (hl[2] + hr[2]) / 2] : [0, 0, 0];
        const torso = v3sub(wsc, hip);
        if (v3len(torso) > 0.2) {
          const tu = v3norm(torso);
          const k = emaK(dtMs, 3000);
          let up = v3norm([this._up[0] + (tu[0] - this._up[0]) * k, this._up[1] + (tu[1] - this._up[1]) * k, this._up[2] + (tu[2] - this._up[2]) * k]);
          // camera tilt + posture rarely exceed ~35°: keep the estimate sane
          if (-up[1] < Math.cos(0.61)) up = v3norm([up[0] * 0.5, -Math.cos(0.61), up[2] * 0.5]);
          this._up = up;
        }
        const up = this._up;
        let fwd = [0, 0, MP_AXES.worldForward];
        fwd = v3norm(v3sub(fwd, up.map((u) => u * v3dot(fwd, up))));
        // up × forward points to the image's right; the player's right is `side` times that
        const right = v3cross(up, fwd).map((c) => c * side);
        const wsw = Math.hypot(wl[0] - wr[0], wl[1] - wr[1], wl[2] - wr[2]);
        // arm length: calibration, else running median of the (depth-corrected) bone sums
        let armLen = this.calibration && this.calibration.armLengthWorld > 0.2 ? this.calibration.armLengthWorld : null;
        if (!armLen) armLen = this._armSamples.quantile(0.6, Math.max(0.42, Math.min(0.75, wsw * 1.5)));
        this._armLen = armLen;
        g.world = { up, fwd, right, wsw, armLen, nose: this._wp(LM.NOSE), sc: wsc };
      }
    }
    return g;
  }

  /** Facing the camera: the shoulders' picture width ≥ facingMinRatio × the long-term one, or narrower only for a
   *  moment (facingGraceMs; facingPunchGraceMs while a punch is in flight or just fired — the punch's own turn). */
  _facing(swCur, tMs) {
    const T = this.tuning;
    // (RT-2: with the face measured, the shoulder width relative to the face size — a step back is no turn)
    const wide = this._lr !== null && this._lr !== undefined && this._lrSlow !== null && this._lrSlow !== undefined
      ? this._lr >= this._lrSlow + Math.log(T.facingMinRatio) : swCur >= this._swSlow * T.facingMinRatio;
    if (wide) { this._narrowSince = null; return true; }
    if (this._narrowSince === null || this._narrowSince === undefined) this._narrowSince = tMs;
    const punching = HANDS.some((h) => { const ht = this.hands[h]; return ht.state === 'stroke' || ht.punchingUntil > tMs || tMs - ht.lastFireT < T.facingPunchGraceMs; });
    return tMs - this._narrowSince < (punching ? T.facingPunchGraceMs : T.facingGraceMs);
  }

  /**
   * Torso yaw from the (depth-corrected) world shoulders compared with its slow average:
   * walking away or turning sideways rotates it far beyond a punch's shoulder twist.
   */
  _turnedAway(obs, dtMs) {
    const T = this.tuning;
    if (!obs.hasWorld) return false;
    const a = this._wp(LM.LEFT_SHOULDER), b = this._wp(LM.RIGHT_SHOULDER);
    if (!a || !b) return false;
    const yaw = Math.atan2(b[2] - a[2], Math.abs(b[0] - a[0]) + 1e-6);
    if (this._yawSlow === undefined || this._yawSlow === null) this._yawSlow = yaw;
    const off = Math.abs(yaw - this._yawSlow) > T.turnAwayRad;
    this._yawSlow += (yaw - this._yawSlow) * emaK(dtMs, off ? 4000 : 1500);
    // depth noise jitters the 3D shoulder yaw by ~10°, and punches twist the torso: only a
    // sustained turn counts (walking away / standing sideways)
    if (!off) this._turnSince = null; else if (this._turnSince === null || this._turnSince === undefined) this._turnSince = this._t;
    return off && this._t - this._turnSince >= T.turnAwayMs;
  }

  _headCentre(obs) {
    const pts = [];
    const add = (p, w) => { if (p) pts.push([p, w]); };
    if (obs.ok[LM.NOSE]) add(this._ip(LM.NOSE), 2);
    if (obs.ok[LM.LEFT_EYE] && obs.ok[LM.RIGHT_EYE]) {
      const a = this._ip(LM.LEFT_EYE), b = this._ip(LM.RIGHT_EYE);
      if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1);
    }
    if (obs.ok[LM.LEFT_EAR] && obs.ok[LM.RIGHT_EAR]) {
      const a = this._ip(LM.LEFT_EAR), b = this._ip(LM.RIGHT_EAR);
      if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1);
    }
    if (!pts.length) return this._lastHead || null;
    let x = 0, y = 0, w = 0;
    for (const [p, k] of pts) { x += p[0] * k; y += p[1] * k; w += k; }
    this._lastHead = [x / w, y / w];
    return this._lastHead;
  }

  // ───────────────────────────── hand features ─────────────────────────────

  _handFeatures(ht, obs, g, tMs, dt) {
    const T = this.tuning;
    const ix = IDX[ht.hand];
    const fresh = obs.ok[ix.wr] && !obs.held[ix.wr];
    if (fresh) { ht.lastSeen = tMs; ht.heldSince = null; } else if (ht.heldSince === null) ht.heldSince = tMs;
    const W = this._ip(ix.wr), E = this._ip(ix.el), S = this._ip(ix.sh);
    if (!W || !S) { ht.prev = ht.f; ht.f = null; return; }
    const w = g.toP(W), s = g.toP(S);
    const e = E ? g.toP(E) : [s[0], s[1] - 0.8];
    // ── image cues ──
    const L2 = Math.hypot(e[0] - s[0], e[1] - s[1]) + Math.hypot(w[0] - e[0], w[1] - e[1]);
    const lexp = T.armToShoulder;
    const collapse = clamp(1 - L2 / lexp, -0.5, 1);
    // ── world cues (depth-corrected) ──
    let fwd = null, up = null, lat = null, elbowUp = null, straight = null, ext3 = null, noseFwd = null;
    if (g.world) {
      const Sw = this._wp(ix.sh), Ew = this._wp(ix.el), Ww = this._wp(ix.wr);
      if (Sw && Ew && Ww) {
        const A = g.world.armLen;
        const a = v3sub(Ww, Sw), eu = v3sub(Ew, Sw), fo = v3sub(Ww, Ew);
        fwd = v3dot(a, g.world.fwd) / A;
        up = v3dot(a, g.world.up) / A;
        lat = v3dot(a, g.world.right) / A;
        elbowUp = v3dot(eu, g.world.up) / A;
        ext3 = v3len(a) / A;
        const c = -v3dot(eu, fo) / Math.max(1e-6, v3len(eu) * v3len(fo));
        const ang = Math.acos(clamp(c, -1, 1)) * 180 / Math.PI;
        straight = clamp01((ang - T.elbowBentDeg) / (T.elbowStraightDeg - T.elbowBentDeg));
        if (obs.ok[ix.el] && obs.ok[ix.wr] && fresh) this._armSamples.push(v3len(eu) + v3len(fo));
        if (g.world.nose) noseFwd = v3dot(v3sub(Ww, g.world.nose), g.world.fwd) / A;
      }
    }
    // ── resting posture ("home"): follows the hand whenever it has settled, so a high guard,
    //    a low guard or a relaxed stance all read as "not extended" ──
    const speed = Math.hypot(ht.vel[0], ht.vel[1]);
    // soft stillness from the image only (jitter of far players reaches ~1.3 SW/s, so no hard
    // cut-off; depth noise must not keep a still hand "moving")
    const stillness = fresh && ht.state === 'ready'
      ? ramp(speed, T.settleSpeed * 2, T.settleSpeed) * ramp(Math.abs(ht.imgRate), T.settleRate * 2, T.settleRate) : 0;
    if (stillness < 0.3) ht.stillSince = null; else if (ht.stillSince === null) ht.stillSince = tMs;
    if (!ht.base && fresh) ht.base = { c: collapse, s: straight ?? 0.1, f: fwd ?? 0.35, w: w.slice() };
    if (!ht.base) { ht.prev = ht.f; ht.f = null; return; }
    if (stillness > 0 && ht.stillSince !== null && tMs - ht.stillSince >= T.settleMs) {
      // exponential approach, but rate-limited: a slow deliberate reach must not be absorbed
      // into the baseline (that would turn its last, faster part into a punch-like spike)
      const k = emaK(dt * 1000, T.baseTauMs) * stillness;
      // static in the picture (position and foreshortening) for 300 ms? then catch up quickly
      // after a posture change. (Depth is not consulted: tracker depth noise swings by 20 cm
      // while the hand is still; a slow reach straight at the lens being absorbed is harmless.)
      let lim = T.baseMaxRate * dt;
      const old = ht.hist.find((x) => x.t >= tMs - 300);
      if (old && tMs - old.t > 200) {
        const movedImg = Math.hypot(w[0] - old.w[0], w[1] - old.w[1]);
        if (movedImg < T.staticMaxMoveImg && Math.abs(collapse - old.collapse) < T.staticMaxCollapse) lim = Infinity;
      }
      const step = (cur, target, range) => cur + clamp((target - cur) * k, -lim * range, lim * range);
      const B = ht.base;
      B.c = step(B.c, collapse, T.collapseRange);
      if (straight !== null) B.s = step(B.s, straight, T.straightRange);
      if (fwd !== null) B.f = step(B.f, fwd, T.forwardRange);
      B.w = [step(B.w[0], w[0], T.displaceRange), step(B.w[1], w[1], T.displaceRange)];
    }
    const B = ht.base;
    const dHome = Math.hypot(w[0] - B.w[0], w[1] - B.w[1]);
    // ── fused extension X ──
    const cn = (collapse - B.c) / T.collapseRange;
    const sn = straight === null ? null : (straight - B.s) / T.straightRange;
    const fn = fwd === null ? null : (fwd - B.f) / T.forwardRange;
    const dn = dHome / T.displaceRange;
    let num = T.wCollapse * clamp(cn, -0.5, 1.4) + T.wDisplace * clamp(dn, 0, 1.4);
    let den = T.wCollapse + T.wDisplace;
    if (sn !== null) { num += T.wStraight * clamp(sn, -0.5, 1.4); den += T.wStraight; }
    if (fn !== null) { num += T.wForward * clamp(fn, -0.8, 1.6); den += T.wForward; }
    const X = num / den;
    // image-only part of the extension (for stillness: depth noise must not count as motion)
    const Ximg = (T.wCollapse * clamp(cn, -0.5, 1.4) + T.wDisplace * clamp(dn, 0, 1.4)) / (T.wCollapse + T.wDisplace);
    // ── velocities (from smoothed positions) ──
    // differences over ≥ diffBaseMs (the previous frame at 15–33 fps, two frames back at 60 fps: R3), EMA per frame
    const p = refBefore(ht.hist, tMs, T.diffBaseMs) || ht.f;
    const dtd = p ? (tMs - p.t) / 1000 : 0;
    if (p && dt > 0 && dtd > 0 && fresh) {
      // (the EMA weights are per 30 fps frame, converted to the actual frame interval: INPUT-07)
      const a = emaA(dt * 1000, this.depthTrusted ? T.velAlphaTrusted : T.velAlpha);
      ht.vel = [ht.vel[0] + ((w[0] - p.w[0]) / dtd - ht.vel[0]) * a, ht.vel[1] + ((w[1] - p.w[1]) / dtd - ht.vel[1]) * a];
      ht.xRate += ((X - p.X) / dtd - ht.xRate) * a;
      ht.imgRate += ((Ximg - p.Ximg) / dtd - ht.imgRate) * a;
    } else if (!fresh) {
      const decay = 1 - emaA(dt * 1000, 0.5);
      ht.vel = [ht.vel[0] * decay, ht.vel[1] * decay];
      ht.xRate *= decay;
      ht.imgRate *= decay;
    }
    ht.prev = ht.f;
    // (RT-13: the wrist landmark's visibility and its typical value for this player — a hidden wrist that the tracker parks on
    // the stomach and then snaps back up is a fast "stroke" made of low-visibility samples)
    const vis = obs.vis[ix.wr] ?? 1;
    if (fresh) ht.visTyp = ht.visTyp === null ? vis : ht.visTyp + (vis - ht.visTyp) * emaK(dt * 1000, 3000);
    ht.f = { t: tMs, w, e, s, X, Ximg, collapse, cn, sn, fn, dn, straight, fwd, up, lat, elbowUp, ext3, noseFwd, dHome, fresh, vis };
    ht.hist.push(ht.f);
    while (ht.hist.length && tMs - ht.hist[0].t > 800) ht.hist.shift();
    // ── drives (multiples of the onset thresholds) ──
    const medial = -ht.sign * ht.vel[0];
    ht.drive.straight = Math.max(0, ht.xRate) / T.xOnsetRate;
    ht.drive.hook = Math.max(0, medial) / T.hookOnsetSpeed;
    ht.drive.up = Math.max(0, ht.vel[1]) / T.upOnsetSpeed;
    ht.drive.max = Math.max(ht.drive.straight, ht.drive.hook, ht.drive.up);
    // the same motion in sensitivity-independent units (multiples of the DEFAULT onsets): the
    // stroke's speed profile, used for the ballistic-onset test and for punch power
    const raw = Math.max(Math.max(0, ht.xRate) / DEFAULT_TUNING.xOnsetRate, Math.max(0, medial) / DEFAULT_TUNING.hookOnsetSpeed,
      Math.max(0, ht.vel[1]) / DEFAULT_TUNING.upOnsetSpeed);
    ht.f.dm = ht.drive.max;
    ht.f.dr = raw;
    ht.f.spd = Math.hypot(ht.vel[0], ht.vel[1]);
  }

  /**
   * Online estimate of the tracker's depth compression kz (MediaPipe underestimates how far
   * a limb points toward the camera). Bones have constant length L: when a bone lies in the
   * image plane its in-plane length² a ≈ L²; when it points toward the camera the raw depth
   * part b = dz² ≈ kz²·(L² − a). So kz² = median of b / (L² − a) over frames where the bone
   * points substantially toward the camera (robust to jitter, unlike a regression).
   */
  /**
   * How noisy is this tracker's world depth? Median frame-to-frame change of the raw world z of
   * joints that are still in the picture (shoulders, still wrists). Real MediaPipe output measured
   * on dev/clips/facecam-boxing.mp4 (a close subject, hips out of frame) once gave ≈ 20 mm with the full model,
   * ≈ 23 mm with lite (the synthetic default ≈ 21 mm); the game's VIDEO-mode tracker gives ≈ 2–10 mm on it and on three
   * public clips (R5; the samples are pairs ≥ diffBaseMs apart, so a 60 fps feed reads like 30 fps). Depth-reliant
   * detection (short forward pushes from a low guard, the 3D dip-less uppercut) is only used while this
   * stays at or below depthTrustNoise (8 mm) — right in the middle of the real range, so a tuner should look at it.
   */
  _estimateDepthNoise(obs) {
    if (!obs.hasWorld) return;
    const cur = {};
    for (const i of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_WRIST, LM.RIGHT_WRIST]) {
      if (obs.world[i] && obs.raw[i] && obs.ok[i] && !obs.held[i]) cur[i] = { z: obs.world[i][2], img: obs.raw[i] };
    }
    const prev = this._dzPrev;
    const sw = this._swSlow || 0.2;
    // (frame pairs ≥ diffBaseMs apart: a 60 fps camera's neighbouring frames share more of their jitter, R3)
    if (prev && this._t - prev.t < this.tuning.diffBaseMs) return;
    if (prev && this._t - prev.t <= 150) {
      for (const k of Object.keys(cur)) {
        const a = cur[k], b = prev.pts[k];
        if (!b) continue;
        if (Math.hypot(a.img[0] - b.img[0], a.img[1] - b.img[1]) / sw < 0.03) this._dzNoise.push(Math.abs(a.z - b.z));
      }
    }
    this._dzPrev = { t: this._t, pts: cur };
    // trusted below depthTrustNoise, distrusted again only above 1.4× that (no flicker)
    if (this._dzNoise.n >= 30) {
      const m = this._dzNoise.quantile(0.5, 1);
      if (m <= this.tuning.depthTrustNoise) this._depthTrusted = true;
      else if (m > this.tuning.depthTrustNoise * 1.4) this._depthTrusted = false;
    }
  }

  /** True while the world depth has been measured to be clean enough for depth-led detection. */
  get depthTrusted() { return !!this._depthTrusted; }

  /** Measured world-depth jitter (median per-frame |Δz| of still joints, mm), or null before enough frames. */
  get depthNoiseMm() { return this._dzNoise && this._dzNoise.n >= 30 ? Math.round(this._dzNoise.quantile(0.5, 0) * 10000) / 10 : null; }

  _estimateDepthScale(obs, dtMs) {
    if (!obs.hasWorld) return;
    const T = this.tuning;
    if (!this._kzEst) this._kzEst = { a: [new RollingQuantile(900, 120), new RollingQuantile(900, 120)], r: new RollingQuantile(600, 60), n: 0 };
    const est = this._kzEst;
    const kz = this._kz;
    for (const h of HANDS) {
      const ix = IDX[h];
      if (!(obs.ok[ix.sh] && obs.ok[ix.el] && obs.ok[ix.wr]) || obs.held[ix.wr] || obs.held[ix.el]) continue;
      const S = this._wp(ix.sh), E = this._wp(ix.el), W = this._wp(ix.wr);
      if (!S || !E || !W) continue;
      for (const [seg, P, Q] of [[0, S, E], [1, E, W]]) {
        const a = (P[0] - Q[0]) ** 2 + (P[1] - Q[1]) ** 2;
        const bz = ((P[2] - Q[2]) * kz) ** 2;          // back to the tracker's raw depth scale
        est.a[seg].push(a);
        if (est.a[seg].n < 60) continue;
        const L2 = est.a[seg].quantile(0.9, a);
        if (a < 0.55 * L2) { est.r.push(bz / Math.max(1e-4, L2 - a)); est.n++; }
      }
    }
    if (est.r.n >= 40) {
      const target = clamp(Math.sqrt(est.r.quantile(0.5, kz * kz)), T.zScaleMin, T.zScaleMax);
      this._kz += (target - this._kz) * emaK(dtMs, 1500);   // move slowly: filters are scaled by kz
    }
  }

  // ───────────────────────────── punch state machine ─────────────────────────────

  _punchMachine(ht, g, tMs) {
    const T = this.tuning;
    const f = ht.f;
    if (!f) return null;
    const stale = ht.heldSince !== null && tMs - ht.heldSince > T.holdMissingMs;
    // no punches until the body has been tracked for a moment (baselines settle after the
    // player (re)enters the picture)
    const warm = this._tracked && tMs - this._trackedSince >= T.warmupMs;
    // dodging (head moving fast) carries the gloves along: a stroke during it must be strong (see _fire).
    // The whole body moving fast is walking / repositioning — unless it moves up or down: a duck (or coming
    // back up from one), which is a dodge too.
    const bodyMoving = g.bodySpeed >= T.maxBodySpeed;
    const ducking = bodyMoving && Math.abs(g.bodyVel[1]) > T.duckBodyVertical * Math.abs(g.bodyVel[0]);
    if (g.headSpeed > T.maxHeadSpeed || ducking) ht.dodgeT = tMs;
    const dodging = ht.dodgeT !== undefined && tMs - ht.dodgeT < T.dodgeHoldMs;
    const plausibleBody = g.facing && (!bodyMoving || ducking) && warm;
    const headTop = g.headP[1] + 0.35;
    // hands up (waving, stretching, pause): above the head in the image AND in 3D — a jab seen
    // by a low camera rises above the head in the picture by perspective alone
    const above = f.w[1] > headTop + T.maxWristAboveHead && (f.up === null || f.up > T.maxWristUpWorld);
    const regionOk = !above && f.w[1] < headTop + 1.2 && f.w[1] > T.minWristY;

    if (ht.state === 'cooldown') {
      if (tMs >= ht.punchingUntil) ht.punchingUntil = 0;
      const fr = ht.fire;
      const since = tMs - fr.t;
      // V3-1: how far back is measured from the punch's own peak — the most extended point it reached after firing (the
      // early decision, R2, fires before full extension: measured from the fire's X, a double jab's hand that came back to
      // its guard read only ≈ 0.65 of the way and never re-armed for the second jab)
      // (R-E: …reached within rearmPeakMs of the fire — the punch itself, not where the hand wandered afterwards)
      if (T.rearmFromPeak) {
        if (fr.peakX === undefined) { fr.peakX = fr.X; fr.peakSpan = Math.hypot(fr.w[0] - fr.wStart[0], fr.w[1] - fr.wStart[1]); }
        if (f.X > fr.peakX) fr.peakX = f.X;
        if (!(T.rearmPeakMs > 0) || since <= T.rearmPeakMs) {
          const dw = Math.hypot(f.w[0] - fr.wStart[0], f.w[1] - fr.wStart[1]);
          if (dw > fr.peakSpan) fr.peakSpan = dw;
        }
      }
      const pX = T.rearmFromPeak ? fr.peakX : fr.X;
      const xBack = (pX - f.X) / Math.max(0.12, pX - fr.xStart);
      const span = T.rearmFromPeak ? fr.peakSpan : Math.hypot(fr.w[0] - fr.wStart[0], fr.w[1] - fr.wStart[1]);
      const pBack = span > 0.15 ? 1 - Math.hypot(f.w[0] - fr.wStart[0], f.w[1] - fr.wStart[1]) / span : 0;
      const back = Math.max(xBack, pBack);
      const settled = ht.drive.max < 0.8;
      const speed = Math.hypot(ht.vel[0], ht.vel[1]);
      // a hand that has come to rest is ready again wherever it is (the pull-back gates keep a
      // later retraction from firing)
      if (speed < T.settleSpeed && Math.abs(ht.xRate) < T.settleRate) { if (fr.stillSince === undefined) fr.stillSince = tMs; } else fr.stillSince = undefined;
      const restedMs = fr.stillSince === undefined ? 0 : tMs - fr.stillSince;
      if ((since >= T.minCooldownMs && back >= T.retractFrac && settled)
        || (since >= T.minCooldownMs + T.rearmStillMs && restedMs >= T.rearmStillMs)
        || (since >= T.maxCooldownMs && speed < 1.5)) {
        ht.state = 'ready';
        ht.lastHome = { t: tMs, w: fr.wStart.slice(), from: fr.w.slice() };
        ht.fire = null;
        ht.punchingUntil = Math.min(ht.punchingUntil, tMs);
        ht.refractory = ht.drive.max > 0.5;
      }
      return null;
    }

    if (ht.state === 'ready') {
      if (ht.refractory) { if (ht.drive.max < 0.5) ht.refractory = false; return null; }
      if (!f.fresh || stale || !plausibleBody || !regionOk) return null;
      // a hand held in the LOW GUARD has only a short forward push to a body punch: with clean
      // depth, a lower onset is safe there (the push is confirmed by its retraction, see below).
      // Hands merely hanging low (talking, holding something) are not a low guard.
      const lowGuard = this._guard.kind === GuardKind.LOW || tMs - (this._lowGuardT ?? -Infinity) <= T.lowGuardRecentMs;
      const low = this.depthTrusted && lowGuard && f.w[1] <= T.lowStartY && f.X < T.lowStartMaxX;
      // (while dodging, a stroke starts only on a clearly faster motion than the hands riding along)
      if (ht.drive.max >= (low ? T.lowStartOnset : dodging ? T.dodgeStartDrive : 1) && tMs - ht.lastFireT > 150) {
        // the motion began a little before the drive crossed the threshold: start = the
        // least-extended frame of the last ~250 ms
        // (fresh samples only, RT-13: a dropout's frozen samples are where the tracker lost the wrist, not where it was)
        let start = ht.prev && ht.prev.fresh ? ht.prev : f;
        for (const h of thin(ht.hist, T.diffBaseMs)) if (h.t >= tMs - T.startLookbackMs && h.fresh && h.X < start.X) start = h;
        ht.state = 'stroke';
        ht.stroke = {
          t0: tMs, start, peak: ht.drive.max, tPeak: tMs, peakS: ht.drive.straight, peakH: ht.drive.hook, peakU: ht.drive.up,
          peakRaw: f.dr || 0, maxX: f.X, pending: null, low, dodge: dodging,
        };
      }
      return null;
    }

    // ── stroke ──
    const st = ht.stroke;
    if (!st) { ht.state = 'ready'; return null; }
    if (stale || !plausibleBody) { this._abortStroke(ht, stale ? 'lost-wrist' : !g.facing ? 'not-facing' : 'body-moving', tMs); return null; }
    if (dodging) st.dodge = true;
    if (ducking) st.duck = true;
    if (st.headPeak === undefined) {
      // (from dodgeHoldMs before the stroke began: the hands coming back after a slip start right after the head stopped)
      st.headPeak = 0; st.bodyPeak = 0;
      for (const [t, hv, bv] of this._speedHist || []) if (t >= st.t0 - T.dodgeHoldMs) { st.headPeak = Math.max(st.headPeak, hv); st.bodyPeak = Math.max(st.bodyPeak, bv); }
    }
    st.headPeak = Math.max(st.headPeak, g.headSpeed);
    st.bodyPeak = Math.max(st.bodyPeak, g.bodySpeed);
    const d = ht.drive;
    if (d.max > st.peak) { st.peak = d.max; st.tPeak = tMs; }
    st.peakRaw = Math.max(st.peakRaw || 0, f.dr || 0);
    st.peakS = Math.max(st.peakS, d.straight);
    st.peakH = Math.max(st.peakH, d.hook);
    st.peakU = Math.max(st.peakU, d.up);
    st.maxX = Math.max(st.maxX, f.X);
    const age = tMs - st.t0;
    if (age > T.maxStrokeMs) { this._abortStroke(ht, 'too-long', tMs); return null; }
    if (!f.fresh) return null;            // wait for data (brief dropout)
    // RT-5: a FAST stroke may end higher above the head: a real uppercut or a jab seen by a low camera (a phone on the
    // floor) ends 1.5 SW above the shoulder line in the picture, and the 3D reads it as raised too; waving, stretching and
    // calling the pointer are slow (sensitivity-independent peak speed below regionFastPeak)
    const regionOkS = regionOk || (T.regionFastPeak > 0 && (st.peakRaw ?? 0) >= T.regionFastPeak
      && f.w[1] <= headTop + T.maxWristAboveHead + T.regionFastExtra && f.w[1] > T.minWristY);
    if (st.pending) return this._resolvePending(ht, g, tMs, regionOkS);
    const decayed = d.max <= T.decayFrac * st.peak;
    if (!decayed && T.earlyMinPeak > 0 && (st.peakRaw ?? 0) >= T.earlyMinPeak && age >= Math.max(T.earlyMinMs, T.minStrokeMs) && !st.low) {
      // R2: already a clear straight / hook while still accelerating — fire now (see earlyMinPeak); a stroke overlapping
      // a dodge only once it already passes the dodge test (_fire would drop it for good otherwise)
      const c = this._classify(ht, g, tMs, regionOkS);
      // (not for a stroke only the picture accepted (RT-11) or one whose depth contradicts its picture (RT-1): a hand
      // starting a gesture speeds up like a jab — it waits for its peak like every weak or uncertain stroke)
      // (V2-7: nor for a fist already at body height or out beside the hip — see earlyNotLow)
      const lowNow = T.earlyNotLow && (f.up !== null ? f.up < this._headRefW - T.bodyDropWorld * 0.5 : f.w[1] < this._headRefI - T.bodyDropImage * 0.5);
      const outNow = T.earlyNotLow && ht.sign * f.w[0] > T.earlyMaxLateral;
      // (a hook V3-2 relabelled a straight is judged as the hook it fires as: R-B)
      const ck = c && c.extArm ? PunchKind.HOOK : c && c.kind;
      if (c && !c.imgPath && !c.depthContra && !lowNow && !outNow && (c.power ?? 0) >= T.earlyMinPower && ((ck === PunchKind.STRAIGHT && st.peakH <= T.earlyStraightMaxHook * st.peakS && st.peakU <= T.earlyMaxUp * st.peakS
        && c.riseImg <= T.earlyMaxRiseImg)
        || (ck === PunchKind.HOOK && st.peakU <= T.earlyMaxUp * st.peakH))
        && (!st.dodge || this._strongAgainstBody(c, st) || this._outpacesHead(c, st))) {
        return this._fire(ht, g, { ...c, confirmedBy: 'early' }, tMs);
      }
    }
    if (!decayed || age < T.minStrokeMs) return null;
    if (st.peak < T.minPeakDrive * (st.low ? T.lowStartOnset : 1)) {
      if (d.max <= T.endFrac * st.peak) {
        this._reject(ht, tMs, 'weak', { peak: st.peak });
        ht.state = 'ready'; ht.stroke = null;
      }
      return null;
    }
    const cls = this._classify(ht, g, tMs, regionOkS);
    if (cls && cls.kind) return this._fire(ht, g, cls, tMs);
    // (V2-2: the torso turn of the other hand's punch — the rest of this arm's motion is part of it: refractory until still)
    if (cls && cls.why === 'other-hand') { this._abortStroke(ht, 'other-hand', tMs); return null; }
    st.lastWhy = cls;
    if (cls && cls.why === 'ambiguous') {
      // looks like a short straight OR like settling into a guard: decide on what happens next
      st.pending = { t: tMs, X: f.X, w: f.w.slice(), info: cls };
      return null;
    }
    // RT-6: a straight held back as a possible hook stays alive until the whole hookPendingMs has passed even when its drive
    // died — then it is judged as what it is (a straight, unless the sweep came: a lazy hook's sweep follows its elbow-out
    // phase); before, these were dropped as 'hook-pending' — a square stance flares the elbow on every jab
    if (cls && cls.why === 'hook-pending' && T.hookPendingFire) return null;
    if (d.max <= T.endFrac * st.peak) {
      // the 3D cues trail the image by a frame or two: keep judging briefly after the motion
      // stopped, as long as the hand is not already coming back
      if (st.endT === undefined) { st.endT = tMs; st.endX = f.X; }
      const retracting = f.X < st.maxX - T.pendingRetractX;
      if (tMs - st.endT >= T.postEndMs || retracting || (cls && cls.why !== 'no-kind' && cls.why !== 'hook-pending')) {
        this._reject(ht, tMs, cls ? cls.why : 'unknown', cls);
        ht.state = 'ready'; ht.stroke = null;
      }
    }
    return null;
  }

  _abortStroke(ht, reason = 'aborted', tMs = this._t) {
    if (ht.state === 'stroke') {
      this._reject(ht, tMs, reason);
      ht.state = 'ready'; ht.stroke = null; ht.refractory = true;
    }
  }

  /**
   * An ambiguous straight (arm only half out — a short body punch or lowering the guard) is
   * confirmed by what follows: a punch comes back (fire now), a guard change holds still
   * (reject). Bounded by pendingMaxMs so latency stays small.
   */
  _resolvePending(ht, g, tMs, regionOk) {
    const T = this.tuning;
    const st = ht.stroke, f = ht.f, p = st.pending;
    const cls = this._classify(ht, g, tMs, regionOk);
    if (cls && cls.kind && !p.info.lazy && !p.info.upFace) return this._fire(ht, g, cls, tMs);
    const s0 = st.start;
    const span = Math.hypot(p.w[0] - s0.w[0], p.w[1] - s0.w[1]);
    const backPos = span > 0.2 ? 1 - Math.hypot(f.w[0] - s0.w[0], f.w[1] - s0.w[1]) / span : 0;
    p.maxX = Math.max(p.maxX ?? p.X, f.X);
    if (f.fwd !== null) p.maxFwd = Math.max(p.maxFwd ?? f.fwd, f.fwd);
    if (p.info.upFace) {
      // a picture-only uppercut in front of the face: fire on its way back down; a hand that stays at the face, keeps
      // rising (above the head) or turns into something else is dropped
      p.topY = Math.max(p.topY ?? p.w[1], f.w[1]);
      if (!regionOk) { this._reject(ht, tMs, 'region', p.info); ht.state = 'ready'; ht.stroke = null; return null; }
      if (f.w[1] <= p.topY - Math.max(T.upImgRetractSW, (p.info.upRetShare ?? T.upImgRetractShare) * (p.info.riseImg || 0))) {
        // (V2-5: …unless the arm went OUT meanwhile — the fused extension reached imgUpStraightX: a straight thrown up from a low
        // guard rises like an uppercut at first; an uppercut's arm stays bent, X ≤ 0.53 for 9 in 10 synthetic ones)
        const out = T.imgUpStraightX > 0 && Math.max(p.maxX ?? p.X, p.X) >= T.imgUpStraightX;
        return this._fire(ht, g, { ...p.info, kind: out ? PunchKind.STRAIGHT : PunchKind.UPPERCUT, confirmedBy: 'retraction' }, tMs);
      }
      if (tMs - p.t > T.upImgConfirmMs) { this._reject(ht, tMs, 'held', p.info); ht.state = 'ready'; ht.stroke = null; }
      return null;
    }
    if (p.info.weak) {
      // weak straights: a clear retraction — the fused extension AND the 3D reach (or the picture)
      // come back — within weakConfirmMs; small wobbles of a held, pointing arm do not count
      const share = T.weakRetractShare;
      const small = p.info.lowPush ? T.lowPushRelax : 1;   // a short push has a short retraction
      const xBack = f.X <= p.maxX - Math.max(T.weakRetractX * small, share * (p.maxX - s0.X));
      const fwd0 = s0.fwd ?? p.maxFwd;
      // (with untrusted depth — the default generator jitters ≈ 2 cm per frame — the 3D reach "coming back"
      // is mostly noise: then the picture must show the retraction, in position or in foreshortening)
      // (a push from a held low guard may also be confirmed by its 3D reach: see weakRetractImgX)
      p.maxXimg = Math.max(p.maxXimg ?? f.Ximg, f.Ximg);
      const imgBack = backPos >= T.weakRetractFrac || (T.weakRetractImgX > 0 && f.Ximg <= p.maxXimg - T.weakRetractImgX * small);
      const back3 = f.fwd === null || p.maxFwd === undefined ? backPos >= T.weakRetractFrac
        : f.fwd <= p.maxFwd - Math.max(T.weakRetractFwd * small, share * (p.maxFwd - fwd0)) || backPos >= T.weakRetractFrac;
      const fwdBack = !this.depthTrusted && T.weakRetractImgX > 0 ? imgBack || (this._fromLowGuard(s0) && back3) : back3;
      if (xBack && fwdBack) return this._fire(ht, g, { ...p.info, kind: PunchKind.STRAIGHT, confirmedBy: 'retraction' }, tMs);
      if (tMs - p.t > T.weakConfirmMs * (p.info.lowPush ? T.lowPushConfirmMul : 1)) {
        this._reject(ht, tMs, 'held', p.info);
        ht.state = 'ready'; ht.stroke = null;
      }
      return null;
    }
    if (f.X <= p.X - T.pendingRetractX || backPos >= T.pendingRetractFrac) {
      return this._fire(ht, g, { ...p.info, kind: PunchKind.STRAIGHT, confirmedBy: 'retraction' }, tMs);
    }
    if (tMs - p.t > T.pendingMaxMs || (cls && cls.why !== 'ambiguous' && cls.why !== 'no-kind')) {
      this._reject(ht, tMs, 'held', p.info);
      ht.state = 'ready'; ht.stroke = null;
    }
    return null;
  }

  /** The stroke began within lowGuardRecentMs of a held LOW guard (both fists low and still): a body push from the
   *  low guard — pointing and reaching never start there (RV-INPUT-04). */
  _fromLowGuard(s0) {
    return s0.t - (this._lowGuardT ?? -Infinity) <= this.tuning.lowGuardRecentMs;
  }

  _reject(ht, tMs, reason, info = null) {
    ht.rejects.push({ t: tMs, reason, info });
    if (ht.rejects.length > 12) ht.rejects.shift();
  }

  /**
   * Decide whether the decelerating stroke is a punch and which kind. Returns the measured
   * features plus `kind` (null for non-punches, with `why`).
   *  - straight: the arm ends far out and fairly straight, pointing toward the camera, after
   *    a big rise of the fused extension and real 3D wrist travel;
   *  - hook: large travel toward the body midline with the elbow raised, the arm bent and the
   *    forearm roughly horizontal;
   *  - uppercut: a scoop — upward travel from a dip or a low start, elbow kept low and bent,
   *    little extension (separates it from straights that rise in the image by perspective).
   */
  _classify(ht, g, tMs, regionOk) {
    const T = this.tuning;
    const st = ht.stroke, f = ht.f, s0 = st.start;
    const no = (why, extra) => ({ kind: null, why, ...extra });
    if (!regionOk) return no('region');
    // pause / hands-up: both wrists above the head is never a punch
    const other = this.hands[ht.hand === Hand.LEFT ? Hand.RIGHT : Hand.LEFT].f;
    const headTop = g.headP[1] + 0.35;
    if (other && other.w[1] > headTop && f.w[1] > headTop - 0.2) return no('hands-up');
    // ── stroke shape (window includes the motion just before the onset) ──
    // (extremes over the ≤ 42 Hz view: a 60 fps history's extra noisy samples would deepen every minimum, R3)
    const H = thin(ht.hist, T.diffBaseMs);
    const win = H.filter((h) => h.t >= Math.min(s0.t, st.t0 - 260));
    let minY = f.w[1], minUp = f.up, mostLateral = f.w[0] * ht.sign, tMin = tMs;
    for (const h of win) {
      if (h.w[1] < minY) { minY = h.w[1]; tMin = h.t; }
      if (h.up !== null && (minUp === null || h.up < minUp)) minUp = h.up;
      if (h.w[0] * ht.sign > mostLateral) mostLateral = h.w[0] * ht.sign;
    }
    // scoop depth: how far the wrist dropped (from its highest point in the preceding
    // ~400 ms) before the lowest point of the stroke
    let preTop = s0.w[1];
    for (const h of H) if (h.t <= tMin && h.t >= tMin - 400 && h.w[1] > preTop) preTop = h.w[1];
    const has = (v) => v !== null && v !== undefined;
    const medialDisp = mostLateral - f.w[0] * ht.sign;
    const riseImg = f.w[1] - minY;
    const riseW = has(f.up) && has(minUp) ? f.up - minUp : null;
    const dip = preTop - minY;
    const dX = f.X - s0.X;
    const fwdEv = (f.cn - s0.cn) + (has(f.fn) && has(s0.fn) ? f.fn - s0.fn : 0);
    const dFwd = has(f.fwd) && has(s0.fwd) ? f.fwd - s0.fwd : 0;
    const dExt = has(f.ext3) && has(s0.ext3) ? f.ext3 - s0.ext3 : null;
    const d3 = has(f.fwd) && has(s0.fwd) && has(f.up) && has(s0.up) && has(f.lat) && has(s0.lat)
      ? Math.hypot(f.fwd - s0.fwd, f.up - s0.up, f.lat - s0.lat) : null;
    const pointsForward = has(f.fwd) && f.ext3 > 0.2 ? f.fwd / f.ext3 : null;
    const S = f.straight;
    // the picture's own extension (foreshortening + leaving home) and foreshortening of this stroke
    const dXi = f.Ximg - s0.Ximg, dCol = f.collapse - s0.collapse;
    // RT-1: real MediaPipe world depth reads an arm thrown at the camera as raised or pulled back about as often as thrust
    // forward (TUNE clips: the wrist's 3D forward reach FELL in 3 of 4 labelled straights — median −0.23 AL — while the
    // picture showed the arm foreshortening; the correlation of the two per 100 ms is ≈ 0). When this stroke's 3D forward
    // reach contradicts its own picture (the arm foreshortened, the 3D reach shrank), the stroke is judged on the picture.
    // (Foreshortening is two-faced: an arm swung BACK — a hand sinking to the waist or behind the hip — shortens in the
    // picture too, and there the 3D is right: a fist that ends low after dropping keeps the 3D tests.)
    const depthContra = T.depthContraCol > 0 && !(T.imgNoDuck && st.duck) && has(f.fwd) && has(s0.fwd) && dCol >= T.depthContraCol && dFwd <= -T.depthContraFwd
      && (f.w[1] >= T.depthContraMinY || f.w[1] - s0.w[1] >= -T.depthContraMaxDrop);
    const info = {
      kind: null, medialDisp, riseImg, riseW, dip, dX, dXi, dCol, depthContra, X: f.X, fwdEv, dFwd, dExt, d3, ext3: f.ext3, pointsForward,
      straight: S, elbowUp: f.elbowUp, startY: s0.w[1], peakS: st.peakS, peakH: st.peakH, peakU: st.peakU,
      img: Math.hypot(f.w[0] - s0.w[0], f.w[1] - s0.w[1]), dur: tMs - s0.t,
      // image-plane arm shape at fire: forearm toward the midline / vertical, elbow out / up
      fwd: f.fwd, fwd0: s0.fwd, up: f.up, wy: f.w[1], peak: st.peak,
      foreMed: -ht.sign * (f.w[0] - f.e[0]), foreUp: f.w[1] - f.e[1],
      elbowOut: ht.sign * (f.e[0] - f.s[0]), elbowImgUp: f.e[1] - f.s[1],
    };
    // ── things that are never a punch ──
    // pull-backs never fire (COM07/A05) — judged on the fused extension AND on absolute 3D
    // measures (the baseline may have adapted to an arm that was held out before retracting); RT-1: the fused extension
    // and the 3D reach only while the picture does not show the arm going out (dXi ≥ pullBackImgOut: real 3D depth often
    // reads a jab or a hook as the fist coming back), the picture's own extension always
    const back3 = dX < -T.pullBackX || (has(dExt) && dExt < -T.pullBackExt) || (has(f.fwd) && has(s0.fwd) && dFwd < -T.pullBackFwd);
    // (an uppercut un-foreshortens the arm — the forearm stands up in the picture — so the picture's own extension drops
    // for every real one: a fast upright rise is judged by the uppercut tests and 'returning', not by this)
    info.foreLen = Math.hypot(f.w[0] - f.e[0], f.w[1] - f.e[1]);
    // (V3-5: …and so does a SLOWER deep scoop — the classic uppercut: a dip of ≥ pullBackScoopDip SW, then the uppercut test's own rise and
    // speed floor (upMinRiseImg, upMinPeakRaw) with the forearm standing up: a slow uppercut un-foreshortens the arm too, and the
    // uppercut tests still decide whether it is one)
    // (…but not the hand coming back up from a body shot — it has dropped and rises just like that, its 'scoop' being the body shot
    // itself (COM07): the scoop starts at the guard (at most pullBackScoopMinY below the shoulder line), the arm stays bent at its
    // bottom (fused extension ≤ pullBackScoopMaxX; a body shot's bottom has the arm out) and the picture's extension drops at most
    // pullBackScoopMaxDrop (an uppercut's forearm standing up un-foreshortens the arm a little; the return from a body shot folds
    // it back); nor within recoverMs of this hand's own punch)
    const bottom = win.find((h) => h.t === tMin);
    info.xAtLow = bottom ? bottom.X : null;
    const scoopRise = T.pullBackScoopDip > 0 && dip >= T.pullBackScoopDip && (st.peakRaw ?? 0) >= T.upMinPeakRaw && riseImg >= T.upMinRiseImg
      && s0.w[1] >= T.pullBackScoopMinY && (!bottom || bottom.X <= T.pullBackScoopMaxX) && dXi >= -T.pullBackScoopMaxDrop
      && tMs - ht.lastFireT > T.recoverMs;
    // (R-A: …but neither for a fist that RESTED at its lowest point away from its home — the hand dropped to the hip or the belly,
    // paused and comes back up to the guard: a return home, judged by the pull-back test; an uppercut's dip flows into its drive)
    // (…nor where the low point is a punch's end — within recoverMs of this hand's own punch, or with the fist out in front in 3D
    // (forward reach ≥ restMaxFwd AL: a body shot's hold, fired or not); the rise is then a new punch — an uppercut after a body
    // shot — or that punch's return, which 'returning' / 'recovering' judge. A dropped hand hangs beside the hip or rests on the belly)
    info.restLow = 0;
    if (T.restLowMs > 0 && bottom && bottom.X >= T.restAwayX && tMs - ht.lastFireT > T.recoverMs && !(has(bottom.fwd) && bottom.fwd >= T.restMaxFwd)) {
      const band = Math.max(T.restBandMin, T.restBandShare * dip), k0 = H.indexOf(bottom);
      let ta = bottom.t, tb = bottom.t;
      for (let k = k0; k >= 0; k--) { if (Math.hypot(H[k].w[0] - bottom.w[0], H[k].w[1] - bottom.w[1]) > band) break; ta = H[k].t; }
      for (let k = k0; k >= 0 && k < H.length; k++) { if (Math.hypot(H[k].w[0] - bottom.w[0], H[k].w[1] - bottom.w[1]) > band) break; tb = H[k].t; }
      info.restLow = tb - ta;
    }
    const restedAway = T.restLowMs > 0 && info.restLow >= T.restLowMs;
    const uprightRise = ((T.imgPathMinPeak > 0 && (st.peakRaw ?? 0) >= T.imgPathMinPeak && riseImg >= T.imgUpRise) || scoopRise) && !restedAway
      && info.foreUp >= T.imgUpForeUp && info.foreUp >= T.imgUpForeRatio * Math.abs(info.foreMed);
    // (the picture's "going out" = its extension rose with the arm foreshortening or the fist sweeping in like a hook: a
    // hand rising away from home raises the extension too, and there the 3D is right)
    const imgOut = T.pullBackImgOut > 0 && dXi >= T.pullBackImgOut && (dCol >= T.depthContraCol || medialDisp >= T.hookMinDisp);
    // (…and the picture's own extension dropping only while the 3D does not clearly say the arm went out — forward reach
    // and shoulder→wrist distance both up by the pull-back margins: a jab seen by a close, low camera un-foreshortens)
    const out3 = T.pullBackOut3 > 0 && has(dExt) && dExt >= T.pullBackOut3 * T.pullBackExt && has(f.fwd) && has(s0.fwd) && dFwd >= T.pullBackOut3 * T.pullBackFwd;
    // (an upright rise is spared the 3D test only while the 3D extension did not collapse — yanking an extended arm back to
    // the guard also ends with the forearm upright)
    const upright3 = uprightRise && (!has(dExt) || dExt >= -2 * T.pullBackExt);
    if ((dXi < -T.pullBackX && !uprightRise && !out3) || (back3 && !imgOut && !upright3)) {
      return no('pulling-back', info);
    }
    // a tracking glitch on this arm during the stroke (or just before) can fake a whole motion
    if (ht.glitchT !== undefined && ht.glitchT >= s0.t - T.glitchTaintMs) return no('glitch', info);
    // RT-13: a stroke made of the tracker's low-confidence wrist samples (mean visibility from its start below visStrokeRatio ×
    // this wrist's typical one) is the landmark finding the hidden fist again — real punches keep ≥ 0.91 on two TUNE clips
    // (rising strokes only — the parked landmark snaps back UP to the guard; a straight is judged by its other tests)
    if (T.visStrokeRatio > 0 && ht.visTyp !== null && riseImg >= T.visMinRise) {
      let vs = 0, vn = 0;
      // (over the stroke's first part, up to visStrokeShare of its time: the hidden wrist is at the start, where it was
      // parked — a short blur dropout later in a real punch must not sink it; a dropout's frozen samples count visHeldWeight)
      const tEnd = s0.t + T.visStrokeShare * (tMs - s0.t);
      for (const h of ht.hist) if (h.t >= s0.t && h.t <= tEnd) { const wv = h.fresh ? 1 : T.visHeldWeight; vs += wv * (h.vis ?? 1); vn += wv; }
      info.visMean = vn ? vs / vn : null;
      if (vn && vs / vn < T.visStrokeRatio * ht.visTyp) return no('low-visibility', info);
    }
    if (s0.X > T.maxStartX && s0.dn > 0.8) return no('not-ready', info);
    // a fist coming down from a hand raised above the head (calling the menu pointer, waving, stretching) is
    // not a punch: punches start from a guard or stance at most head high
    // (above the head in the picture AND in 3D — a jab seen by a low camera rises above the head in the picture
    // by perspective alone — and not this hand's own punch of a moment ago: a flurry)
    if (T.raisedStartMs > 0 && tMs - ht.lastFireT > T.raisedStartMs + 300
      && ht.hist.some((h) => h.t >= s0.t - T.raisedStartMs && h.t <= s0.t + 40 && h.w[1] > g.headP[1] + 0.35 + T.maxWristAboveHead
        && (h.up === null || h.up > T.maxWristUpWorld))) return no('from-raised', info);
    // the rest of a return to where the previous punch started is still the pull-back
    // (V3-1: …unless it is the head shot of a body-then-head double-up: after this hand's BODY punch the fist rises AND the arm
    // goes out — in the picture (its own extension rose ≥ returnOutXi with the arm foreshortening toward the camera) and in 3D
    // (the shoulder→wrist reach or the forward depth grew ≥ returnOut3 AL). Such a jab heads up toward the guard and ends near
    // it in the picture, but extends the arm; the return from a body shot folds it back. The picture alone is not enough, nor
    // any direction: a hand dropping below the guard after a head punch foreshortens too. 0 = off)
    const extending = T.returnOutXi > 0 && !!ht.lastPunch && ht.lastPunch.target === Target.BODY && f.w[1] > s0.w[1]
      && dXi >= T.returnOutXi && dCol >= T.depthContraCol
      && ((has(dExt) && dExt >= T.returnOut3) || (has(f.fwd) && has(s0.fwd) && dFwd >= T.returnOut3));
    if (!extending && this._returning(ht, st, tMs)) return no('returning', info);
    // V2-1: …and so is a stroke soon after this hand's punch that heads AGAINST that punch's own picture direction, even past
    // where it started (a hook swinging back out, a fist rising back to the guard after a body shot, the hand dropping after
    // a high punch): COM07 — the retraction never fires. A double jab or a flurry repeats the punch's direction.
    if (this._recovering(ht, st)) return no('recovering', info);
    const tRef = Math.min(tMs, st.tPeak + T.earlyAnchorMs);
    info.early = this._earlyRise(ht, tRef, (st.peakH ?? 0) >= T.ballisticImgHook * (st.peakS ?? 0));
    if (info.early > T.maxEarlyRise) return no('slow', info);
    // a slow reach toward the desk / the screen that speeds up midway looks like a body straight: a fist that
    // already crept toward the target before it sped up is not one (true body punches start from rest:
    // early-rise p98 ≈ 0.2–0.27 in the bench) — unless this hand punched a moment ago (its retraction
    // then reads as early motion) or the stroke starts from a held low guard (RV-INPUT-04)
    const endsLowEarly = has(f.up) ? f.up < this._headRefW - T.bodyDropWorld * 0.5 : f.w[1] < this._headRefI - T.bodyDropImage * 0.5;
    if (endsLowEarly && info.early > T.maxEarlyRiseLow && tMs - ht.lastFireT > 1500 && !this._fromLowGuard(s0)) return no('slow', info);
    info.speed = this._recentSpeed(ht, g, tRef);
    if (this._bilateral(ht, st)) return no('both-hands', info);
    // a slow-ish motion ending on the face (scratching, glasses, raising the guard)
    const nearFace = !!g.head && st.peak < T.faceTouchMaxDrive
      && Math.hypot(f.w[0] - g.headP[0], f.w[1] - g.headP[1]) < T.faceTouchSW
      && (!has(f.noseFwd) || f.noseFwd < T.faceTouchForward);
    info.nearFace = nearFace;
    info.noseFwd = f.noseFwd;   // (AL in front of the nose; the lab and the R1 checks)
    // a fist that ends on the face (2D) and not in front of it (3D) touched the face
    info.endsOnFace = !!g.head && Math.hypot(f.w[0] - g.headP[0], f.w[1] - g.headP[1]) < T.faceTouchSW * 1.15
      && has(f.noseFwd) && f.noseFwd < T.straightMinNoseFwd;
    // ── hook ── (image-plane shape: the forearm ends long, horizontal and pointing at the
    //    midline with the elbow out and up — robust where 3D elbow angles are not)
    const elbowRaised = (has(f.elbowUp) && f.elbowUp >= T.hookElbowMin) || info.elbowImgUp >= T.hookElbowImgMin;
    // (a body hook keeps the elbow low, by the side: at body height the elbow only has to be out to its side — bodyHook*)
    info.bodyLow = !!T.bodyHook && this._targetZ(f) < -T.bodySplit && info.elbowOut >= T.bodyHookElbowOut && f.w[1] > T.bodyHookMinY;
    const hookOk = medialDisp >= T.hookMinDisp && st.peakH >= T.minPeakDrive
      && info.foreMed >= T.hookMinForeMed && Math.abs(info.foreUp) <= T.hookForeSlope * info.foreMed
      && (elbowRaised || info.bodyLow) && dX >= T.hookMinRise && (f.w[1] > -1.1 || info.bodyLow) && !nearFace;
    // ── uppercut ── end-state score vs. straights (a straight seen by a low camera also rises
    //    in the picture): bent elbow, elbow kept low (3D and image), arm not pushed out.
    //    Measured at the end only — an uppercut's dip makes start-relative travel look big.
    const zs = [];
    if (has(S)) zs.push((T.upCentreStraight - S) / 0.12);
    if (has(f.elbowUp)) zs.push((T.upCentreElbow - f.elbowUp) / 0.07);
    zs.push((T.upCentreElbowImg - info.elbowImgUp) / 0.15);
    zs.push((T.upCentreX - f.X) / 0.15);
    info.upScore = zs.reduce((a, b) => a + b, 0) / zs.length;
    // a scoop (dip or low start) is the classic uppercut; without one (fist driven straight up from
    // the chest), the 3D shape must say "uppercut" clearly: bent elbow, upright forearm, a real
    // upward rise in 3D, ending in front of the chin (not on the face: scratching / glasses)
    const scoop = dip >= T.upMinDip || s0.w[1] <= T.upLowStart;
    info.upright = !scoop && this.depthTrusted && has(S) && S <= T.upNoDipMaxStraight && has(riseW) && riseW >= T.upNoDipRiseWorld
      && info.foreUp >= T.upNoDipForeUp && info.foreUp >= T.upNoDipForeRatio * Math.max(0, info.foreMed)
      && info.upScore >= T.upNoDipMinScore && has(f.noseFwd) && f.noseFwd >= T.upNoDipNoseFwd && !nearFace
      && f.w[1] <= g.headP[1] - T.upNoDipBelowHead && ht.sign * f.w[0] <= T.upNoDipMaxLateral
      && this._otherHandRise(ht, minY, tMin) < T.upNoDipOtherRise * riseImg
      && has(f.fwd) && has(s0.fwd) && dFwd >= T.upNoDipMinFwd;
    // R1: the same dip-less uppercut judged in the PICTURE (see upImg*): works at any depth quality
    const onFace = !!g.head && Math.hypot(f.w[0] - g.headP[0], f.w[1] - g.headP[1]) < T.faceTouchSW * 1.15;
    info.uprightImg = !scoop && !info.upright && riseImg >= T.upImgRise && st.peakU >= T.upImgPeak
      && info.foreUp >= T.upImgForeUp && info.foreUp >= T.upImgForeRatio * Math.abs(info.foreMed)
      && info.elbowImgUp <= T.upImgElbowMax
      && ht.sign * f.w[0] >= T.upImgMinLateral && ht.sign * f.w[0] <= T.upNoDipMaxLateral
      && f.w[1] <= g.headP[1] + T.upImgMaxAboveHead && f.w[1] >= g.headP[1] - T.upImgMinBelowHead
      && medialDisp <= T.upImgMaxMedial && !nearFace
      && (!onFace || (has(f.noseFwd) ? f.noseFwd >= T.upImgNoseFwd : st.peak >= T.faceTouchMaxDrive))
      && (!has(f.noseFwd) || f.noseFwd >= T.upImgNoseFwdMin)
      && (!has(S) || S <= T.upImgMaxStraight) && f.X <= T.upImgMaxX
      && this._otherHandRise(ht, minY, tMin) < T.upNoDipOtherRise * riseImg;
    // RT-7: a real uppercut from a square stance drives up AND to the chin: 0.7–1.2 SW toward the midline (TUNE c4: all 34
    // over upMaxMedial). That is still an uppercut while the forearm stands upright (vertical part ≥ upMedialForeRatio × its
    // sideways part; a hook's lies flat) and the fist rose at least upMedialRiseRatio × as far as it swept in
    // (fast strokes only, ≥ upMedialMinPeak sensitivity-independent: a hand going to the face — glasses — sweeps in and up too)
    info.upMedialOk = T.upMedialForeRatio > 0 && (st.peakRaw ?? 0) >= T.upMedialMinPeak
      && info.foreUp >= T.upMedialForeRatio * Math.abs(info.foreMed) && riseImg >= T.upMedialRiseRatio * medialDisp
      && ht.sign * f.w[0] <= T.upMedialMaxLat;
    let upOk = (st.peakRaw ?? st.peak) >= T.upMinPeakRaw && riseImg >= (info.uprightImg ? T.upImgRise : T.upMinRiseImg * (scoop ? 1 : T.upNoDipRiseFrac))
      && st.peakU >= (info.uprightImg ? T.upImgPeak : T.upMinPeak * (scoop ? 1 : T.upNoDipPeakFrac))
      && (!has(riseW) || riseW >= T.upMinRiseWorld)
      && (!has(f.elbowUp) || f.elbowUp <= (info.uprightImg ? T.upImgElbowWorldMax : T.upMaxElbow))
      && (!has(S) || S <= (info.uprightImg ? T.upImgMaxStraight : T.upMaxStraight))
      && (medialDisp <= T.upMaxMedial || info.upMedialOk)
      && (scoop || info.upright || info.uprightImg)
      && (!has(f.fwd) || !has(s0.fwd) || dFwd >= T.upMinFwd)
      && (!this.depthTrusted || !has(f.fwd) || !win.length || !has(win[0].fwd) || f.fwd - win[0].fwd >= T.upMinFwd)
      && (!has(f.up) || f.up >= T.upMinEndWorld)
      && (info.uprightImg || info.upScore >= T.upMinScore) && (!nearFace || dip >= T.upMinDip * 2);
    // ── straight ── "is the arm out?": forward depth, elbow straightness, 3D extension and
    //    fused extension at fire, each centred between straight punches and guard changes
    const world = has(f.ext3);
    // (RT-1: a stroke whose 3D reach contradicts its picture is judged like a player without world landmarks — the
    // picture's extension instead of the fused one, no 3D reach / direction / travel / height tests)
    const w3 = world && !depthContra;
    // (V2-7: the fist's travel OUT toward its own side in the picture — see imgStraightMaxOut)
    info.picOut = ht.sign * (f.w[0] - s0.w[0]);
    const Xs = w3 ? f.X : Math.max(f.X, f.Ximg), dXs = w3 ? dX : Math.max(dX, dXi);
    info.extScore = (Xs - T.extScoreX) / 0.13
      + (w3 ? (f.fwd - T.extScoreFwd) / 0.15 + ((S ?? 0) - T.extScoreStraight) / 0.15 + (f.ext3 - T.extScoreExt) / 0.1 : 3 * (Xs - T.extScoreX) / 0.13);
    const fwdOk = w3 || !world ? fwdEv >= T.straightMinFwd || (has(dExt) && dExt >= T.straightMinExtGain) : f.cn - s0.cn >= T.straightMinFwd;
    // the image must show the punch: wrist travel, or the arm foreshortening toward the camera
    info.dCollapse = f.collapse - s0.collapse;
    info.imageEvidence = Math.max(info.img / T.straightMinImgTravel, info.dCollapse / T.straightMinCollapse);
    // (depth alone is never enough: the tracker's depth noise can fake a 25 cm "extension";
    // but a punch thrown straight down the lens from a high guard barely shows in 2D, so weak
    // image evidence is accepted when the 3D stroke is fast, large and straight-armed)
    // a short forward push from a low guard to body height (clean depth only): the 3D reach grew,
    // but the picture and the fused extension move less than for other straights
    const endsLow = has(f.up) ? f.up < this._headRefW - T.bodyDropWorld * 0.5 : f.w[1] < this._headRefI - T.bodyDropImage * 0.5;
    info.lowPush = !!st.low && endsLow && world && fwdEv >= T.lowPushFwdEv && has(dExt) && dExt >= T.lowPushExtGain && dFwd >= T.lowPushFwd;
    const lp = info.lowPush ? T.lowPushRelax : 1;
    const minRise = (!world ? T.straightMinRise * 1.5 : T.straightMinRise) * lp;
    info.depthBacked = w3 && info.imageEvidence >= T.weakImageEvidence && info.speed !== null && info.speed >= T.depthBackedSpeed
      && dX >= T.depthBackedRise && has(S) && S >= T.depthBackedStraight;
    const straightOk = (info.imageEvidence >= 1 || info.depthBacked || info.lowPush) && dXs >= minRise
      && (info.speed === null || info.speed >= T.minPunchSpeed * lp)
      && Xs >= T.straightMinX * lp && st.peakS >= T.minPeakDrive * 0.85 * (st.low ? T.lowStartOnset : 1) && fwdOk
      && (!w3 || f.ext3 >= T.straightMinExt)
      && (!w3 || !has(d3) || d3 >= T.straightMinTravel * lp)
      && (!has(S) || S >= T.straightMinStraight)
      && (!w3 || !has(f.up) || f.up <= T.straightMaxUp)
      && (!w3 || !has(d3) || d3 < T.straightFwdShareFrom || dFwd >= T.straightMinFwdShare * d3)
      && !info.endsOnFace
      && (!w3 || !has(pointsForward) || pointsForward >= T.straightMinFwdDir)
      && (!w3 || !has(dExt) || -dExt <= T.maxExtensionLoss)
      && !(nearFace && dFwd < 0.15)
      // (judged on the picture, a long upright forearm that rose is a hand going up — a raise, a wave — or an uppercut)
      && (w3 || !world || !(info.foreUp >= T.imgUpForeUp && info.foreLen >= T.imgUpForeLen && riseImg >= T.imgUpRise))
      && (w3 || !world || info.picOut <= T.imgStraightMaxOut);
    if (!straightOk) {
      const fails = [];
      if (!(info.imageEvidence >= 1)) fails.push('img');
      if (!(dXs >= (world ? T.straightMinRise : T.straightMinRise * 1.5))) fails.push('dX');
      if (!(st.peakS >= T.minPeakDrive * 0.85)) fails.push('peakS');
      if (!fwdOk) fails.push('fwd');
      if (w3 && !(f.ext3 >= T.straightMinExt)) fails.push('ext3');
      if (w3 && has(d3) && !(d3 >= T.straightMinTravel)) fails.push('d3');
      if (has(S) && !(S >= T.straightMinStraight)) fails.push('S');
      if (w3 && has(f.up) && !(f.up <= T.straightMaxUp)) fails.push('up');
      if (w3 && has(d3) && !(d3 < T.straightFwdShareFrom || dFwd >= T.straightMinFwdShare * d3)) fails.push('fwdShare');
      if (info.speed !== null && !(info.speed >= T.minPunchSpeed * lp)) fails.push('speed');
      if (info.endsOnFace) fails.push('onFace');
      if (w3 && has(pointsForward) && !(pointsForward >= T.straightMinFwdDir)) fails.push('dir');
      if (w3 && has(dExt) && !(-dExt <= T.maxExtensionLoss)) fails.push('extLoss');
      if (nearFace && dFwd < 0.15) fails.push('face');
      info.straightFails = fails.join(',');
    } else if (info.extScore < T.straightMinExtScore) info.straightFails = 'extScore';
    // elbow flared out at shoulder height but the fist has not swept in yet: a hook may still be
    // coming — let the stroke continue a little before calling it a straight
    info.hookPending = straightOk && !hookOk && (info.elbowOut >= T.hookPendingElbowOut) && info.elbowImgUp >= T.hookElbowImgMin
      && (!has(f.elbowUp) || f.elbowUp >= T.hookElbowMin) && info.foreMed < T.hookMinForeMed && (tMs - st.t0) < T.hookPendingMs;
    // RT-15: raising the guard lifts both hands — not always at once, and a rise's least-extended start frame can be late
    // (the both-hands test above compares from there): an uppercut slower than upOtherRisePeak (sensitivity-independent)
    // whose other hand rose ≥ upOtherRiseMax × its own rise since its lowest point is the guard coming up (a fast one may be
    // thrown while the other hand comes back up to the guard — alternating uppercuts from a square stance)
    info.otherRise = this._otherHandRise(ht, minY, tMin);
    const guardUp = T.upOtherRiseMax > 0 && riseImg > 0.2 && info.otherRise >= T.upOtherRiseMax * riseImg && (st.peakRaw ?? 0) < T.upOtherRisePeak;
    if (guardUp) upOk = false;
    let kind = null;
    if (hookOk && upOk) kind = medialDisp / T.hookMinDisp >= riseImg / T.upMinRiseImg ? PunchKind.HOOK : PunchKind.UPPERCUT;
    else if (hookOk) kind = PunchKind.HOOK;
    else if (upOk) kind = PunchKind.UPPERCUT;
    else if (straightOk && info.extScore >= T.straightMinExtScore && !info.hookPending) kind = PunchKind.STRAIGHT;
    // RT-11 — the PICTURE's classification of a FAST stroke the 3D-supported tests above turned down: real MediaPipe world
    // landmarks get a real punch's elbow height, elbow angle, wrist height and forward reach wrong often enough (TUNE clips:
    // 3 of 4 real uppercuts fail a 3D uppercut test, half the real straights a 3D straight test) that a fast stroke whose
    // picture shows a clear punch shape is a punch. Fast = sensitivity-independent peak speed ≥ imgPathMinPeak (the slow
    // gestures the 3D tests exist for — pointing, reaching, scratching, glasses — never get there). Same gates as above
    // (pull-back, glitch, raised start, returning, slow, both hands, face touch, region); kind from the picture:
    //  · hook: the fist swept ≥ hookMinDisp toward the midline with a flat forearm (|vertical| ≤ imgHookSlope × medial part,
    //    medial part ≥ imgHookForeMed SW) and the elbow no lower than imgHookElbow SW below the shoulder line;
    //  · uppercut: the fist rose ≥ imgUpRise SW (and ≥ imgUpRiseVsMed × its sweep) and ends on an upright, long forearm
    //    (vertical part ≥ imgUpForeUp SW and ≥ imgUpForeRatio × |sideways part|, length ≥ imgUpForeLen SW: a straight's forearm
    //    points at the camera and looks short);
    //  · straight: the picture's extension rose ≥ imgStraightRise with the arm foreshortening (collapse +imgStraightCol) and
    //    the usual image travel, not ending low after a drop (depthContraMinY / depthContraMaxDrop: a hand sinking to the waist).
    info.imgPath = false;
    // the picture's own straight: its extension rose with the arm foreshortening and the usual image travel, not ending low
    // after a drop (a hand sinking to the waist), not ending with a long upright forearm (that is an uppercut's shape)
    const notDrop = f.w[1] >= T.depthContraMinY || f.w[1] - s0.w[1] >= -T.depthContraMaxDrop;
    // (R-A: …nor a fist that went down and out toward its own side — a hand dropping to the hip; a punch drives in front of the body)
    const dropOut = T.imgDropOutY > 0 && f.w[1] - s0.w[1] <= -T.imgDropOutY && info.picOut >= T.imgDropOutX;
    const straightI = dXi >= T.imgStraightRise && dCol >= T.imgStraightCol && info.imageEvidence >= 1 && notDrop && !dropOut
      && (!has(S) || S >= T.imgStraightMinS) && info.picOut <= T.imgStraightMaxOut
      && st.peakS >= T.minPeakDrive * 0.85 && (info.speed === null || info.speed >= T.minPunchSpeed) && !info.endsOnFace
      && !(nearFace && dFwd < 0.15) && !(info.foreUp >= T.imgUpForeUp && info.foreLen >= T.imgUpForeLen && riseImg >= T.imgUpRise);
    if (!kind && !info.hookPending && T.imgPathMinPeak > 0 && (st.peakRaw ?? 0) >= T.imgPathMinPeak && !(T.imgNoDuck && st.duck)) {
      const hookI = medialDisp >= T.hookMinDisp && st.peakH >= T.minPeakDrive && info.foreMed >= T.imgHookForeMed
        && Math.abs(info.foreUp) <= T.imgHookSlope * info.foreMed && (info.elbowImgUp >= T.imgHookElbow || info.bodyLow)
        && (f.w[1] > -1.1 || info.bodyLow) && !nearFace;
      // (an uppercut's upward drive must lead: ≥ imgUpDriveLead × the extension's)
      const upI = riseImg >= T.imgUpRise && riseImg >= T.imgUpRiseVsMed * medialDisp && st.peakU >= T.minPeakDrive && st.peakU >= T.imgUpDriveLead * st.peakS
        && !guardUp && (medialDisp <= T.upMaxMedial || ht.sign * f.w[0] <= T.upMedialMaxLat)
        && info.foreUp >= T.imgUpForeUp && info.foreUp >= T.imgUpForeRatio * Math.abs(info.foreMed) && info.foreLen >= T.imgUpForeLen
        && (!nearFace || dip >= T.upMinDip * 2);
      if (hookI && upI) kind = medialDisp / T.hookMinDisp >= riseImg / T.upMinRiseImg ? PunchKind.HOOK : PunchKind.UPPERCUT;
      else if (hookI) kind = PunchKind.HOOK;
      else if (upI) kind = PunchKind.UPPERCUT;
      else if (straightI) kind = PunchKind.STRAIGHT;
      info.imgPath = !!kind;
    }
    // a picture-only uppercut in front of the face: confirmed by its way back down (see upImgFaceSW)
    if (kind === PunchKind.UPPERCUT && info.uprightImg && !!g.head && Math.hypot(f.w[0] - g.headP[0], f.w[1] - g.headP[1]) < T.upImgFaceSW) {
      info.why = 'ambiguous';
      info.upFace = true;
      return info;
    }
    // RT-14 — the KIND of an accepted stroke is read from the picture at the decision, whichever path accepted it: the
    // 3D tests mistake a square stance's cross (the fist sweeps 1 SW toward the midline) for a hook and a jab seen by a low
    // camera (the fist rises 0.7–1 SW) for an uppercut. Uppercut: the forearm stands up (vertical part ≥ kindUpForeUp SW and
    // ≥ kindUpForeRatio × |sideways part|), the upward drive reached ≥ kindUpDrive × the extension's, and the arm did not
    // foreshorten (collapse rose ≤ kindUpMaxCol: a straight's arm points at the camera). Hook: the medial drive reached
    // ≥ kindHookDrive × the extension's, the forearm lies flat (|vertical| ≤ kindHookSlope × medial part + 0.05) and the fist
    // swept ≥ hookMinDisp and ≥ kindHookRiseRatio × its rise. Else a straight — unless the forearm ends pointing AWAY from
    // the midline (medial part < kindWindupForeMed SW): that is a hook's wind-up swinging out, not a punch.
    if (kind && T.kindFromImage) {
      const upK = info.foreUp >= T.kindUpForeUp && info.foreUp >= T.kindUpForeRatio * Math.abs(info.foreMed)
        && st.peakU >= T.kindUpDrive * st.peakS && dCol <= T.kindUpMaxCol;
      const hookK = st.peakH >= T.kindHookDrive * st.peakS && Math.abs(info.foreUp) <= T.kindHookSlope * Math.max(info.foreMed, 0.01) + 0.05
        && medialDisp >= T.hookMinDisp && medialDisp >= T.kindHookRiseRatio * riseImg;
      // (an uppercut the tests found stays one unless its arm foreshortened or its forearm is not upright: the 3D dip-less
      // uppercut's drives look like a straight's)
      // (a stroke becomes a straight only if a straight test — the 3D one or the picture's — passes: a hand going to the
      // face that the uppercut test caught is no straight either, and keeps the uppercut's own checks)
      const straightAny = (straightOk && info.extScore >= T.straightMinExtScore) || straightI;
      let k2 = kind;
      const KS = T.kindSteps;
      if (kind === PunchKind.UPPERCUT) {
        // (an arm that foreshortened is pointing at the camera: a jab seen by a low camera, however upright it looks — for a
        // stroke only the picture accepted; one the 3D uppercut test accepted needs a straight test to pass)
        if (KS.includes('d') && (dCol > T.kindUpMaxCol || info.foreUp < T.kindUpForeUp * 0.6)) k2 = hookK ? PunchKind.HOOK : straightAny || (T.kindUpColStraight && info.imgPath && dCol > T.kindUpMaxCol) ? PunchKind.STRAIGHT : kind;
      } else if (KS.includes('u') && upK) k2 = PunchKind.UPPERCUT;
      else if (KS.includes('c') && kind === PunchKind.HOOK && !hookK && info.elbowOut <= T.kindCrossElbowOut && straightAny) k2 = PunchKind.STRAIGHT;   // (a cross: the elbow ends in front of the body)
      else if (KS.includes('h') && kind === PunchKind.STRAIGHT && hookK) k2 = PunchKind.HOOK;
      info.kind3 = kind;
      if (KS.includes('w') && k2 === PunchKind.STRAIGHT && info.foreMed < T.kindWindupForeMed) { info.why = 'wind-up'; return info; }
      kind = k2;
    }
    // V2-2: a straight judged on the picture alone (RT-11's, or RT-1's with contradicted depth) that began no earlier than a
    // stroke of the OTHER hand at least as fast is that punch's torso turn foreshortening this arm in the picture (or the
    // other arm crossing it) — real clips: 10 of 12 such other-hand false fires, 1 of 97 timely picture-only straights
    if (kind === PunchKind.STRAIGHT && (info.imgPath || depthContra) && this._otherLeads(ht, st)) { info.why = 'other-hand'; return info; }
    // V3-4: a straight ending at body height while the OTHER hand's faster hook swings (in flight, or fired within otherHookMs) is
    // that hook's counter-rotation — the rear arm drawing back and down to the body as the torso turns through the hook
    // (TUNE/HOLDOUT real clips: three such 'body straights' fired with the other hand's hook within 0–67 ms; no labelled body
    // punch was thrown with a hook of the other hand)
    if (kind === PunchKind.STRAIGHT && T.otherHookMs > 0 && this._targetZ(f) < -T.bodySplit && this._otherHook(ht, st, tMs)) { info.why = 'other-hand'; return info; }
    // …and an image-path stroke is confirmed by what follows, like the picture-only uppercut in front of the face: an
    // uppercut fires on its way back down, a straight that rose ≥ imgRiseConfirm SW (a hand going up to wave, to call
    // the pointer or to stretch straightens the arm fast and rises just like a jab seen by a low camera) on its retraction
    // V2-3: …a picture-only uppercut with no punch speed at all (power index < imgUpMinPower: neither the extension nor the 3D
    // wrist moved fast — the hands coming back up to the guard after a reset, real clips: 5 of 5 such false fires, 1 of 71
    // timely picture-only uppercuts) is no punch
    if (info.imgPath && kind === PunchKind.UPPERCUT && T.imgUpMinPower > 0 && this._power(ht, st, tMs) < T.imgUpMinPower) { info.why = 'weak'; return info; }
    if (info.imgPath && kind === PunchKind.UPPERCUT && T.imgUpRetractShare > 0) {
      info.why = 'ambiguous'; info.upFace = true; info.upRetShare = T.imgUpRetractShare; info.kind = null;
      return info;
    }
    if (info.imgPath && kind === PunchKind.STRAIGHT && T.imgRiseConfirm > 0 && riseImg >= T.imgRiseConfirm) {
      info.why = 'ambiguous'; info.lazy = true; info.weak = true; info.kind = null;
      return info;
    }
    // RT-12: every uppercut that ends with the fist high in front of the body, from a hand that rose out of a low position
    // (scoop from the waist: raising the guard after stepping back looks the same until the hands stay up) waits for its way
    // back down (upAllRetractShare of its rise, 0 = off)
    if (kind === PunchKind.UPPERCUT && T.upAllRetractShare > 0 && !info.upFace) {
      info.why = 'ambiguous'; info.upFace = true; info.upRetShare = T.upAllRetractShare; info.kind = null;
      return info;
    }
    // a weak, creeping straight that ends low looks like reaching for the desk: confirm it by
    // the retraction that follows a punch (a reach holds still)
    const low = has(f.up) ? f.up < this._headRefW - T.bodyDropWorld * 0.5 : f.w[1] < this._headRefI - T.bodyDropImage * 0.5;
    if (kind === PunchKind.STRAIGHT && low && st.peak < T.lazyBodyPeak && (info.dur > T.lazyBodyDurMs || info.early > T.lazyBodyEarly)) {
      kind = null;
      info.why = 'ambiguous';
      info.lazy = true;
      return info;
    }
    // a WEAK straight (low peak speed) is held back until the retraction that follows every punch
    // confirms it: a deliberate reach or pointing at the screen holds its position (COM07). Low
    // pushes always take this path (their shape alone is not enough).
    info.power = this._power(ht, st, tMs);
    const weak = (info.power < T.weakStraightPower)
      || (T.weakStraightPeak > 0 && (st.peakRaw ?? st.peak) < T.weakStraightPeak && info.power < T.weakStraightPowerMax);
    if ((kind === PunchKind.STRAIGHT || (info.lowPush && straightOk && !hookOk && !upOk)) && (weak || info.lowPush)) {
      kind = null;
      info.why = 'ambiguous';
      info.lazy = true;
      info.weak = true;
      return info;
    }
    // V3-2: a "hook" whose arm ended EXTENDED (3D elbow straightness ≥ hookExtMinS) with its elbow LOW — under the hook test's own
    // "elbow raised" limits in 3D (hookElbowMin) AND, clearly, in the picture (hookElbowImgMin − hookExtElbowImgMargin) — is a
    // straight thrown across the picture: a hook swings a bent arm around an elbow held up at shoulder height; an extended arm
    // with a low elbow drove forward along its own line, and only the camera made it sweep toward the midline (a close or
    // off-axis camera's perspective, a turned torso). The elbow angle is 3D shape, which perspective and distance do not change.
    // R-B: a relabel only, after every gate — the stroke fires exactly when and whether the hook would have (the straight's own
    // confirmation paths are not for it: a real looping hook sent down them was dropped)
    if (kind === PunchKind.HOOK && T.hookExtMinS > 0 && has(S) && S >= T.hookExtMinS && has(f.elbowUp) && f.elbowUp < T.hookElbowMin
      && info.elbowImgUp < T.hookElbowImgMin - T.hookExtElbowImgMargin) {
      kind = PunchKind.STRAIGHT;
      info.extArm = true;
    }
    info.kind = kind;
    if (!kind) info.why = info.hookPending ? 'hook-pending' : straightOk && info.extScore >= T.straightAmbiguousExtScore ? 'ambiguous' : 'no-kind';
    return info;
  }

  /**
   * Ballistic test on RAW positions (not the adaptive baseline): how much the wrist already
   * moved in the punch direction during [tRef − 600, tRef − 250] compared with the last 250 ms
   * up to tRef, in 3D (relative to the shoulder, AL), in the image (SW) and in the fused
   * extension. Returns the largest ratio among views that saw a clear recent motion. A punch
   * from rest ≈ 0; a 0.7–1.5 s reach / pointing gesture ≳ 0.6.
   */
  _earlyRise(ht, tRef, hookLike = true) {
    const T = this.tuning;
    const h = thin(ht.hist, T.diffBaseMs);
    if (h.length < 5) return 0;
    // a slow camera (median frame gap over 45 ms: 15–20 fps) — not a single dropped frame at 30 fps
    const gaps = h.slice(1).map((e, k) => e.t - h[k].t).sort((x, y) => x - y);
    const slowCam = gaps.length > 2 && gaps[gaps.length >> 1] > 45;
    const avgAt = (t) => {
      // mean of the two samples closest to t (halves the jitter) — from a slow camera the value interpolated at t
      // instead: a 67 ms pair's mean smears the punch's start into "early" motion (R3)
      let i = 0;
      while (i < h.length - 1 && h[i + 1].t <= t) i++;
      const a = h[i], b = h[Math.min(h.length - 1, i + 1)];
      const u = slowCam && b.t > a.t ? clamp01((t - a.t) / (b.t - a.t)) : 0.5;
      const L = (x, y) => x + (y - x) * u;
      const p3 = a.fwd !== null && b.fwd !== null ? [L(a.lat, b.lat), L(a.up, b.up), L(a.fwd, b.fwd)] : null;
      return { t: a.t, img: [L(a.w[0], b.w[0]), L(a.w[1], b.w[1])], p3 };
    };
    // right after this hand's previous punch (a flurry) judge only from its most retracted
    // point on: that out-and-back is not a hand creeping forward
    let tFrom = tRef - 600;
    if (ht.lastFireT > tRef - 900) {
      let back = null;
      for (const e of h) if (e.t > ht.lastFireT && e.t < tRef - 120 && (!back || e.X < back.X)) back = e;
      if (back && back.t > tFrom) tFrom = back.t;
      if (tFrom > tRef - 250 - 60) return 0;
    }
    const now = avgAt(tRef), mid = avgAt(tRef - 250), old = avgAt(tFrom);   // (h: the ≤ 42 Hz view, see diffBaseMs)
    if (old.t >= mid.t || mid.t >= now.t) return 0;   // not enough history yet (just started tracking)
    const ratio = (A, B, C, noise, minSnr = 3) => {
      const late = A.map((v, k) => v - B[k]);
      const ll = Math.hypot(...late);
      if (ll < minSnr * noise) return null;
      const early = B.map((v, k) => v - C[k]);
      return { r: Math.max(0, early.reduce((s2, v, k) => s2 + v * late[k], 0) / ll) / ll, snr: ll / noise };
    };
    const cands = [ratio(now.img, mid.img, old.img, 0.04)];
    if (now.p3 && mid.p3 && old.p3) cands.push(ratio(now.p3, mid.p3, old.p3, 0.12, 3.5));
    // fused extension (its baseline barely follows a moving hand, so slow motions accumulate)
    const xAt = (t) => { let x = h[0]; for (const e of h) if (e.t <= t) x = e; return x.X; };
    const xl = xAt(tRef) - xAt(tRef - 250), xe = xAt(tRef - 250) - xAt(tFrom);
    if (xl > 0.2) cands.push({ r: Math.max(0, xe) / xl, snr: xl / 0.06 });
    const ok = cands.filter(Boolean);
    if (ok.length) {
      // RT-8: a picture that clearly saw the last 250 ms of motion (signal ≥ ballisticImgSnr × the noise) and no creep in
      // that direction before it overrules the other views: a hook's wind-up swings the fist OUT before it sweeps in —
      // the fused extension (distance from home, either way) and the real tracker's depth read that as early motion
      if (T.ballisticImgSnr > 0 && hookLike && cands[0] && cands[0].snr >= T.ballisticImgSnr && cands[0].r <= T.ballisticImgMaxR) return cands[0].r;
      // any view that saw the hand creeping beforehand vetoes (the 3D path is the most linear
      // measure of a reach's progress)
      return Math.max(...ok.map((c) => c.r));
    }
    // no view saw a clear net displacement in the last 250 ms: a punch that curved (an
    // uppercut's scoop, a hook's arc) still travelled a long path — otherwise not ballistic
    // (path over three ~83 ms legs between anchors that are the median of the three nearest
    // samples, so neither landmark jitter of far players nor a one-frame glitch add up to a
    // "long path")
    const medAt = (t) => {
      let i = 0;
      while (i < h.length - 1 && h[i + 1].t <= t) i++;
      const s3 = [h[Math.max(0, i - 1)], h[i], h[Math.min(h.length - 1, i + 1)]];
      const med = (k) => s3.map((e) => e.w[k]).sort((a, b) => a - b)[1];
      return [med(0), med(1)];
    };
    const anchors = [0, 83, 167, 250].map((dt) => medAt(tRef - dt));
    let path = 0;
    for (let k = 1; k < anchors.length; k++) path += Math.hypot(anchors[k][0] - anchors[k - 1][0], anchors[k][1] - anchors[k - 1][1]);
    return path >= T.ballisticMinPathSW ? 0 : 1;
  }

  /**
   * Average wrist speed (m/s) over the 250 ms up to tRef: the larger of the 3D view (wrist
   * relative to the shoulder × arm length) and the image view (× world shoulder width).
   * Displacement over 250 ms, not per-frame speed, so landmark jitter mostly cancels.
   * Even a lazy punch moves ≳ 1.2 m/s here; a deliberate 1 s reach ≈ 0.5 m/s.
   */
  _recentSpeed(ht, g, tRef) {
    const h = thin(ht.hist, this.tuning.diffBaseMs);
    if (!g.world || h.length < 4) return null;
    const at = (t) => {
      let i = 0;
      while (i < h.length - 1 && h[i + 1].t <= t) i++;
      return [h[i], h[Math.min(h.length - 1, i + 1)]];
    };
    const [a1, a2] = at(tRef), [b1, b2] = at(tRef - 250);
    const dt = ((a1.t + a2.t) - (b1.t + b2.t)) / 2000;
    if (!(dt > 0.15)) return null;
    const m = (p, q, k) => (p[k] + q[k]) / 2;
    let d3 = 0;
    if (a1.fwd !== null && a2.fwd !== null && b1.fwd !== null && b2.fwd !== null) {
      d3 = Math.hypot(m(a1, a2, 'fwd') - m(b1, b2, 'fwd'), m(a1, a2, 'up') - m(b1, b2, 'up'), m(a1, a2, 'lat') - m(b1, b2, 'lat')) * g.world.armLen;
    }
    const di = Math.hypot((a1.w[0] + a2.w[0] - b1.w[0] - b2.w[0]) / 2, (a1.w[1] + a2.w[1] - b1.w[1] - b2.w[1]) / 2) * g.world.wsw;
    return Math.max(d3, di) / dt;
  }

  /**
   * True when this stroke is the tail of the previous punch's return: soon after that punch,
   * moving toward the spot it was thrown from and ending near it (COM07 / A05).
   */
  _returning(ht, st, tMs) {
    const T = this.tuning;
    const H = ht.lastHome;
    if (!H || tMs - H.t > T.returnWindowMs) return false;
    const f = ht.f;
    const dEnd = Math.hypot(f.w[0] - H.w[0], f.w[1] - H.w[1]);
    // judged from the stroke start AND from the start of the window the classifier looks at (an
    // upward stroke's least-extended frame can be its own onset, hiding the pull-back before it)
    const w0 = ht.hist.find((h) => h.t >= st.t0 - 260) || st.start;
    for (const s0 of [st.start, w0]) {
      // …or the stroke began where that punch ended and heads home: the retraction leg itself,
      // judged before it gets there (a fast pull-back to a different guard can look like a scoop)
      const fromEnd = H.from && Math.hypot(s0.w[0] - H.from[0], s0.w[1] - H.from[1]) <= T.returnNearSW;
      if (dEnd > T.returnNearSW && !fromEnd) continue;
      const mv = [f.w[0] - s0.w[0], f.w[1] - s0.w[1]];
      const toHome = [H.w[0] - s0.w[0], H.w[1] - s0.w[1]];
      const lm = Math.hypot(mv[0], mv[1]), lh = Math.hypot(toHome[0], toHome[1]);
      if (lm < 0.15 || lh < 0.15) continue;
      if ((mv[0] * toHome[0] + mv[1] * toHome[1]) / (lm * lh) >= T.returnMinCos) return true;
    }
    return false;
  }

  /** V2-1: the stroke starts within recoverMs of this hand's last punch and its picture direction opposes that punch's
   *  (cosine ≤ recoverCos; the punch moved ≥ recoverMinPrev SW and the stroke ≥ recoverMinMove SW in the picture).
   *  V3-1: …and it began out where that punch ENDED, not back at the guard it started from (the stroke's start is nearer the
   *  punch's end than recoverFromGuard × its distance from the punch's start; 0 = any start): a retraction begins where the
   *  punch ended, while the second punch of a same-hand double-up (a body shot then a head shot) starts from the guard. */
  _recovering(ht, st) {
    const T = this.tuning;
    const H = ht.lastHome;
    if (!(T.recoverMs > 0) || !H || !H.from || st.start.t - ht.lastFireT > T.recoverMs) return false;
    const f = ht.f, s0 = st.start;
    const dp = [H.from[0] - H.w[0], H.from[1] - H.w[1]], dn = [f.w[0] - s0.w[0], f.w[1] - s0.w[1]];
    const lp = Math.hypot(dp[0], dp[1]), ln = Math.hypot(dn[0], dn[1]);
    const toEnd = Math.hypot(s0.w[0] - H.from[0], s0.w[1] - H.from[1]), toStart = Math.hypot(s0.w[0] - H.w[0], s0.w[1] - H.w[1]);
    // (V3-1: a stroke that starts still AT the punch's end — the hand never came back: within recoverAtEnd × its distance from the
    // punch's start of where the punch fired — continues that punch whatever its direction)
    if (lp < T.recoverMinPrev || ln < T.recoverMinMove) return false;
    // (R-D: …and began within recoverAtEndMs of the fire: the punch's own follow-through — an uppercut ends where a cross starts)
    if (T.recoverAtEnd > 0 && toEnd <= T.recoverAtEnd * toStart && (!(T.recoverAtEndMs > 0) || s0.t - ht.lastFireT <= T.recoverAtEndMs)) return true;
    if ((dp[0] * dn[0] + dp[1] * dn[1]) / (lp * ln) > T.recoverCos) return false;
    return !(T.recoverFromGuard > 0) || toEnd < T.recoverFromGuard * toStart;
  }

  /** V2-2: the other hand's stroke — in flight, or fired within otherLeadFiredMs — started no later than this one (otherLeadMs
   *  slack) and was at least as fast (sensitivity-independent peak speed). */
  _otherLeads(ht, st) {
    const T = this.tuning;
    if (!T.otherLeadOn) return false;
    const oh = this.hands[ht.hand === Hand.LEFT ? Hand.RIGHT : Hand.LEFT];
    const o = oh.state === 'stroke' && oh.stroke ? { t0: oh.stroke.t0, peak: oh.stroke.peakRaw ?? 0 }
      : oh.lastStroke && this._t - oh.lastStroke.tFire <= T.otherLeadFiredMs ? oh.lastStroke : null;
    return !!o && o.t0 <= st.t0 + T.otherLeadMs && o.peak >= (st.peakRaw ?? 0);
  }

  /** V3-4: the other hand's hook — a stroke in flight whose sweep drive leads (peakH ≥ peakS, peakU) or a hook it fired within
   *  otherHookMs — at least as fast as this stroke (sensitivity-independent peak speed). R-C: …and this stroke began no later
   *  than otherHookLeadMs after that hook's (the counter-rotation moves with the torso turn; a combo's body straight follows). */
  _otherHook(ht, st, tMs) {
    const T = this.tuning;
    const oh = this.hands[ht.hand === Hand.LEFT ? Hand.RIGHT : Hand.LEFT];
    const mine = st.peakRaw ?? 0;
    const lead = T.otherHookLeadMs ?? Infinity;
    if (oh.state === 'stroke' && oh.stroke) {
      const o = oh.stroke;
      return (o.peakH ?? 0) >= Math.max(o.peakS ?? 0, o.peakU ?? 0) && (o.peakRaw ?? 0) >= mine && st.t0 <= o.t0 + lead;
    }
    return !!oh.lastPunch && oh.lastPunch.kind === PunchKind.HOOK && tMs - oh.lastFireT <= T.otherHookMs
      && !!oh.lastStroke && oh.lastStroke.peak >= mine && st.t0 <= oh.lastStroke.t0 + lead;
  }

  /** How far (SW) the other hand rose in the picture since this hand's lowest point (raising the guard
   *  lifts both hands; an uppercut lifts one). */
  _otherHandRise(ht, minY, tMin) {
    const oh = this.hands[ht.hand === Hand.LEFT ? Hand.RIGHT : Hand.LEFT];
    if (!oh.f) return 0;
    const b0 = oh.hist.find((h) => h.t >= tMin - 60);
    return b0 ? Math.max(0, oh.f.w[1] - b0.w[1]) : 0;
  }

  /**
   * True when the other hand made the same (x-mirrored) move during this stroke — raising or
   * lowering the guard, the pause gesture, clapping. Measured over the same span the
   * classifier uses (from the stroke start), with a little slack for the other hand.
   */
  _bilateral(ht, st) {
    const T = this.tuning;
    const oh = this.hands[ht.hand === Hand.LEFT ? Hand.RIGHT : Hand.LEFT];
    if (!oh.f || !ht.f) return false;
    const s0 = st.start;
    const b0 = oh.hist.find((h) => h.t >= s0.t - 100);
    if (!b0) return false;
    const da = [ht.f.w[0] - s0.w[0], ht.f.w[1] - s0.w[1]];
    const db = [-(oh.f.w[0] - b0.w[0]), oh.f.w[1] - b0.w[1]];   // mirror the other hand
    const la = Math.hypot(da[0], da[1]), lb = Math.hypot(db[0], db[1]);
    const dxa = ht.f.X - s0.X, dxb = oh.f.X - b0.X;
    // (RT-9: the extension is a distance from home either way — the other hand dropping or swinging back raises it too: a
    // clear picture motion of the other hand AGAINST this one's mirrored direction is no "same extension")
    const la0 = Math.hypot(da[0], da[1]), lb0 = Math.hypot(db[0], db[1]);
    const opposed = T.bilateralOpposedSW > 0 && la0 >= 0.15 && lb0 >= T.bilateralOpposedSW && (da[0] * db[0] + da[1] * db[1]) / (la0 * lb0) < 0;
    const sameExtension = dxa > 0.2 && dxb >= T.bilateralMinRatio * dxa && !opposed;
    // little image motion (on-axis camera): compare the fused extension instead
    if (la < 0.2) return sameExtension;
    // a dodge carries both hands along in the picture: only the same extension, or the very same move
    // (both fists rising together out of a duck) counts there
    const ratio = st.dodge ? T.bilateralDodgeRatio : T.bilateralMinRatio, minCos = st.dodge ? T.bilateralDodgeCos : T.bilateralMinCos;
    if (st.dodge && sameExtension) return true;
    if (lb < ratio * la) return false;
    const cos = (da[0] * db[0] + da[1] * db[1]) / (la * lb);
    return cos >= minCos;
  }

  _fire(ht, g, cls, tMs) {
    const T = this.tuning;
    const st = ht.stroke, f = ht.f;
    // a stroke that overlapped a dodge fires only if the fist moved clearly on its own (INPUT-04)
    if (st.dodge && !this._strongAgainstBody(cls, st) && !this._outpacesHead(cls, st)) {
      this._reject(ht, tMs, 'dodging', cls);
      ht.state = 'ready'; ht.stroke = null;
      return null;
    }
    // ── target (COM02): height vs. this player's head-punch level, world + image ──
    const z = this._targetZ(f);
    let target = z < -T.bodySplit ? Target.BODY : Target.HEAD;
    if (cls.kind === PunchKind.UPPERCUT) target = Target.HEAD;
    if (target === Target.HEAD && cls.kind !== PunchKind.UPPERCUT && T.headLevelAdapt > 0) {
      const a = T.headLevelAdapt;
      if (f.up !== null) this._headRefW = clamp(this._headRefW + (f.up - this._headRefW) * a, T.headLevelWorld - 0.45, T.headLevelWorld + 0.45);
      this._headRefI = clamp(this._headRefI + (f.w[1] - this._headRefI) * a, T.headLevelImage - 0.8, T.headLevelImage + 0.8);
    }
    const power = this._power(ht, st, tMs);
    // atExtension: recognised at (or near) full extension — the camera already saw the punch travel, so the
    // game gives it only a short travel time (D5; keyboard punches carry no flag)
    /** @type {import('../core/types.js').PunchInput} */
    const punch = { hand: ht.hand, kind: cls.kind, target, power: Math.round(power * 100) / 100, t: tMs, atExtension: true };
    ht.state = 'cooldown';
    ht.fire = { t: tMs, X: f.X, xStart: st.start.X, w: f.w.slice(), wStart: st.start.w.slice(), cls, punch, z };
    ht.stroke = null;
    ht.lastFireT = tMs;
    ht.lastStroke = { t0: st.t0, peak: st.peakRaw ?? st.peak, tFire: tMs };
    ht.punchingUntil = tMs + T.punchFlagMs;
    ht.lastPunch = punch;
    return { type: 'punch', punch, t: tMs };
  }

  /** The fist's height against this player's head-punch level, in head→body drops (world and image averaged; < −bodySplit = body). */
  _targetZ(f) {
    const T = this.tuning;
    let z = 0, n = 0;
    if (f.up !== null) { z += (f.up - this._headRefW) / T.bodyDropWorld; n++; }
    z += (f.w[1] - this._headRefI) / T.bodyDropImage; n++;
    return z / n;
  }

  /** Strong enough to be a punch while the body moves (dodging): see maxHeadSpeed. Sensitivity-independent. */
  _outpacesHead(cls, st) {
    const T = this.tuning;
    if (!(T.dodgeOutpace > 0)) return false;
    // (a duck moves the whole body rather than the head: the faster of the two counts)
    const head = Math.max(st.headPeak || 0, st.bodyPeak || 0, T.maxHeadSpeed) / DEFAULT_TUNING.hookOnsetSpeed;
    if ((st.peakRaw ?? st.peak) < T.dodgeOutpace * head) return false;
    const k = T.dodgeOutpaceTravel;
    // (a hook V3-2 relabelled a straight is judged as the hook it fires as: R-B)
    if (cls.kind === PunchKind.STRAIGHT && !cls.extArm) return (cls.dX ?? 0) >= k * T.dodgeStrokeMinRise;
    return (cls.img ?? 0) >= k * T.dodgeStrokeMinImg;
  }

  _strongAgainstBody(cls, st) {
    const T = this.tuning;
    if ((st.peakRaw ?? st.peak) < T.dodgeStrokeMinPeak) return false;
    if (cls.kind === PunchKind.STRAIGHT && !cls.extArm) return (cls.dX ?? 0) >= T.dodgeStrokeMinRise;
    return (cls.img ?? 0) >= T.dodgeStrokeMinImg;
  }

  /**
   * Punch power 0..1 from the punch's own speed, independent of the sensitivity setting: the peak
   * 2-frame rate of the fused extension (1/s) and, with world data, of the 3D wrist relative to the
   * shoulder (arm lengths/s), combined as a geometric mean and mapped log-linearly between
   * powerSlowSpeed (→ 0) and powerFastSpeed (→ 1). In simulation a lazy 380 ms punch lands around
   * 0.3, a normal 200 ms one around 0.65, a snappy 110 ms one around 0.85 (fast ones reach 1).
   */
  _power(ht, st, tMs) {
    const T = this.tuning;
    let vx = 0, v3 = 0, n3 = 0;
    let a = null;
    for (const b of thin(ht.hist, T.diffBaseMs)) {
      if (b.t < st.start.t - 40 || b.t > tMs) continue;
      if (a && b.fresh && a.fresh) {
        const dt = (b.t - a.t) / 1000;
        if (dt > 0.008) {
          vx = Math.max(vx, (b.X - a.X) / dt);
          if (a.fwd !== null && b.fwd !== null) { v3 = Math.max(v3, Math.hypot(b.fwd - a.fwd, b.up - a.up, b.lat - a.lat) / dt); n3++; }
        }
      }
      a = b;
    }
    const sp = n3 ? Math.sqrt(Math.max(1e-3, vx) * Math.max(1e-3, v3)) : vx;
    const p = Math.log(Math.max(1e-3, sp) / T.powerSlowSpeed) / Math.log(T.powerFastSpeed / T.powerSlowSpeed);
    return Number.isFinite(p) ? clamp01(p) : 0.5;
  }

  // ───────────────────────────── guard (COM03) ─────────────────────────────

  _updateGuard(g, dtMs) {
    const T = this.tuning;
    let high = 1, low = 1;
    for (const h of HANDS) {
      const ht = this.hands[h];
      const f = ht.f;
      if (!f) { high = 0; low = 0; continue; }
      const speed = Math.hypot(ht.vel[0], ht.vel[1]);
      const still = ramp(speed, T.guardMaxSpeed, T.guardMaxSpeed * 0.6);
      const notPunching = ht.state === 'cooldown' && ht.punchingUntil > 0 ? 0 : 1;
      const relHead = f.w[1] - g.headP[1];
      const mH = ramp(relHead, T.guardHighMinRelHead - 0.12, T.guardHighMinRelHead + 0.12)
        * ramp(relHead, T.guardHighMaxRelHead + 0.15, T.guardHighMaxRelHead - 0.05)
        * ramp(Math.abs(f.w[0] - g.headP[0]), T.guardHighMaxDx + 0.12, T.guardHighMaxDx - 0.12)
        * ramp(f.w[1], T.guardHighMinY - 0.12, T.guardHighMinY + 0.12)
        * ramp(f.X, 0.75, 0.5);
      const mL = ramp(f.w[1], T.guardLowMaxY + 0.12, T.guardLowMaxY - 0.12)
        * ramp(f.w[1], T.guardLowMinY - 0.15, T.guardLowMinY + 0.1)
        * ramp(Math.abs(f.w[0]), T.guardLowMaxDx + 0.12, T.guardLowMaxDx - 0.12)
        * (f.straight === null ? 1 : ramp(f.straight, T.guardLowMaxStraight + 0.12, T.guardLowMaxStraight - 0.12))
        * (f.fwd === null ? 1 : ramp(f.fwd, T.guardLowMinForward - 0.1, T.guardLowMinForward + 0.1));
      high = Math.min(high, mH * still * notPunching);
      low = Math.min(low, mL * still * notPunching);
    }
    const k = emaK(dtMs, T.guardTauMs);
    this._guard.high += (high - this._guard.high) * k;
    this._guard.low += (low - this._guard.low) * k;
    const cur = this._guard.kind;
    const gh = this._guard.high, gl = this._guard.low;
    let kind = cur;
    if (cur === GuardKind.HIGH && gh < T.guardOff) kind = GuardKind.NONE;
    if (cur === GuardKind.LOW && gl < T.guardOff) kind = GuardKind.NONE;
    if (kind === GuardKind.NONE) {
      if (gh >= T.guardOn && gh >= gl) kind = GuardKind.HIGH;
      else if (gl >= T.guardOn) kind = GuardKind.LOW;
    }
    this._guard.kind = kind;
    if (kind === GuardKind.LOW) this._lowGuardT = this._t;
  }

  // ───────────────────────────── lean / duck / head (COM04) ─────────────────────────────

  /**
   * Lean / duck / forward-back (COM04).
   * Fast path on purpose: the head centre is taken from the RAW landmarks and smoothed once by a
   * speed-adaptive One-Euro filter (≈10 Hz cut-off while leaning, ≈2 Hz at rest), so the view can
   * follow a lean within the 150 ms of research/mechanics.md §2.1. Each axis then maps the
   * physical movement through leanCurve() so the dodge movements of §2.1 land exactly on the
   * combat dodge thresholds (see the lean tunables).
   *
   * Neutral ("no lean"): learned from the first steady window with the hands up in this recognizer's
   * life (each bout gets a new recognizer), then re-centred whenever the player has stood steadily
   * somewhere else for neutralSettleMs (a step sideways / nearer / farther, a nudged camera) — except a
   * held sideways lean (tilted shoulders toward the head offset). Steadiness is judged on block means
   * over neutralWindowMs (NeutralWindow), not on per-frame velocities, which landmark jitter swamps.
   * A held posture that does get adopted (a lean after neutralLeanHoldMaxMs, a duck or a sway after
   * neutralSettleMs) keeps the upright neutral from before it as "home", and coming back to home restores
   * it at once (R1; see the neutralHome* tunables and _homeRestore).
   *
   * Forward / back: independent estimates of the upper body's displacement toward the camera (metres) —
   * the apparent shoulder width and head size (each change × the estimated camera distance) and the
   * tracker's hip-relative world depth of the shoulders and nose — averaged only where they agree,
   * otherwise there is no lean: a step back shrinks the picture but not the hip-relative depth, a torso
   * twist narrows the shoulders but changes neither the head nor the depth, so neither reads as a lean,
   * and the same sway gives the same lean.z at 1.5 m and at 3 m. Without world landmarks the head's
   * apparent size confirms the shoulders instead.
   */
  _updateLean(obs, g, tMs, dtMs) {
    const T = this.tuning;
    const headRaw = this._headCentreRaw(obs) || g.head;
    if (!headRaw) return;
    const swSlow = this._swSlow || g.sw;
    this._headF.setParams({ minCutoff: T.leanMinCutoff, beta: T.leanBeta / swSlow, dCutoff: T.leanDCutoff });
    const hf = this._headF.filter(headRaw, tMs);
    const head = [hf[0], hf[1]];
    // raw shoulders (uniform units) for the scale; smoothed ones for the tilt
    const lr = obs.raw[LM.LEFT_SHOULDER], rr = obs.raw[LM.RIGHT_SHOULDER];
    const swRaw = lr && rr ? Math.hypot(rr[0] - lr[0], rr[1] - lr[1]) : g.swCur;
    const scRaw = lr && rr ? [(lr[0] + rr[0]) / 2, (lr[1] + rr[1]) / 2] : g.sc;
    const lS = g.shoulderP.left, rS = g.shoulderP.right;
    const tilt = Math.atan2(lS[1] - rS[1], rS[0] - lS[0]);
    const side = g.side;
    const unit = Math.max(swSlow, 1e-3);
    // world: hip-relative depth of the upper body (shoulder centre + nose, raw), world shoulder width
    const wz = this._upperBodyDepth(obs);
    const W = obs.hasWorld ? obs.world : null;
    if (W && W[LM.LEFT_SHOULDER] && W[LM.RIGHT_SHOULDER]) {
      const a = W[LM.LEFT_SHOULDER], b = W[LM.RIGHT_SHOULDER];
      this._wswQ.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    // head size: RMS spread of the face landmarks (a lean moves the head more than the shoulders and,
    // unlike them, a torso twist does not change it)
    const lhsRaw = this._headSize(obs);
    // ── the neutral pose ──
    // (busy — a stroke in flight or a punch still flagged — gates the home checks, the z jitter estimates, the depth
    // wander and the upright record below; the steadiness and the place weigh motion instead, see NeutralWindow)
    const busy = HANDS.some((h) => { const ht = this.hands[h]; return ht.state === 'stroke' || ht.punchingUntil > tMs; });
    const ready = this._guard.kind !== GuardKind.NONE || this._handsUp(tMs);
    const nw = this._nw;
    // a frame's weight in the place pose: from the hands' punch drive and the head's speed (neutralPlaceBusyW … 1)
    // (the drive held with a decay of neutralQuietHoldMs: the frames right after a punch, while the body still unwinds,
    // count as little as the punch itself)
    let drive = 0;
    for (const h of HANDS) drive = Math.max(drive, this.hands[h].drive.max || 0);
    this._driveHold = Math.max(drive, (this._driveHold || 0) * (T.neutralQuietHoldMs > 0 ? Math.exp(-dtMs / T.neutralQuietHoldMs) : 0));
    let quiet = (1 - ramp(this._driveHold, T.neutralQuietDriveFrom, T.neutralQuietDriveTo)) * (1 - ramp(g.headSpeed || 0, T.neutralQuietHeadFrom, T.neutralQuietHeadTo));
    // (a slip or a lean moves the head over the shoulders, a step or a stance change does not: such frames count like a
    // punch, so a player who slips mostly to one side does not pull the place — and the neutral — toward that side)
    if (this._neutral && T.neutralPlaceLeanRelTo > 0) {
      const relX = (headRaw[0] - scRaw[0]) / Math.max(1e-4, swRaw);
      quiet *= 1 - ramp(Math.abs(relX - this._neutral.relX), T.neutralPlaceLeanRelFrom, T.neutralPlaceLeanRelTo);
    }
    nw.push({ t: tMs, hx: headRaw[0], hy: headRaw[1], scx: scRaw[0], scy: scRaw[1], lsw: Math.log(Math.max(1e-4, swRaw)), lhs: lhsRaw, tilt, wz, ts: this._torsoSide(obs),
      w: T.neutralPlaceBusyW + (1 - T.neutralPlaceBusyW) * quiet, ready, busy }, T.diffBaseMs, T);
    const J = nw.judge(T, tMs);
    // (no verdict — too few quiet samples left in the window, a busy stretch — is no evidence of steadiness: the streak ends,
    // it does not carry through the combo)
    if (J) nw.lastVerdictT = tMs;
    if (J ? !J.steady : tMs - (nw.lastVerdictT ?? -Infinity) > T.neutralSteadyStaleMs) nw.steadySince = null;
    else if (J && nw.steadySince === null) nw.steadySince = tMs;
    const steadyMs = nw.steadySince === null ? 0 : tMs - nw.steadySince;
    const P = nw.placePose(T, tMs);
    // (with a calibration: shoulders about as level, head about as centred over them as then — a stance seen from a
    // high or low camera tilts the shoulder line by itself, so not without one)
    const prior = this._neutralPrior || {};
    const upright = (m) => (!Number.isFinite(prior.tilt) || Math.abs(m.tilt - prior.tilt) <= T.neutralUprightTilt)
      && (!Number.isFinite(prior.relX) || Math.abs(m.relX - prior.relX) <= 2 * T.neutralLeanSW);
    const inGuard = J && J.steady && J.readyShare >= T.neutralReadyShare && upright(J.mean);
    if (!this._neutral) {
      let m = null, provisional = false;
      if (inGuard) m = J.mean;
      else if (J && J.steady && steadyMs >= T.neutralNoReadyMs) m = J.mean;   // low hands / a calibration from elsewhere
      else if (P && P.readyShare >= T.neutralReadyShare && P.drift <= T.neutralPlaceDriftSW && upright(P)) { m = P; provisional = true; }   // boxing in place
      if (!m) {
        this._lean = { x: 0, y: 0, z: 0 }; this._head = { x: 0, y: 0 }; this._zHist = []; this._zf = null; this._zAgree = null;
        return;
      }
      this._learnNeutral(m, tMs, provisional);
    } else if (this._neutral.provisional && inGuard && !this._heldPosture(J.mean, side, unit)) {
      // a provisional first neutral (from the place of a player who never stood still): the first steady window in guard
      // is the neutral, at once — unless that window is a held lean or duck against it: then the steadiness path below
      // decides, with its held-lean rule and home (R1)
      this._learnNeutral(J.mean, tMs, false);
    } else if (J && J.steady && steadyMs >= T.neutralSettleMs) {
      // re-centre on the steady pose (stepped elsewhere, camera nudged, a posture held for good) —
      // a held sideways dodge (shoulders tilted toward the head offset) only after neutralLeanHoldMaxMs
      const N = this._neutral, m = J.mean;
      const dx = side * (m.hx - N.u) / unit, dTilt = m.tilt - N.tilt;   // both in the player's perspective
      let heldLean = Math.abs(dTilt) >= T.neutralLeanTilt && Math.abs(dx) >= T.neutralLeanSW && Math.sign(dTilt) === Math.sign(dx)
        && steadyMs < T.neutralLeanHoldMaxMs;
      // a held posture became the neutral and home was kept (see _homeRestore): standing upright again but not
      // where home is (a step on the way back) is re-centred at once — it is never a held lean against the
      // adopted posture — and home is forgotten once that has lasted neutralSettleMs
      const H = this._home;
      if (H) {
        if (!this._uprightLike(m, H, unit)) this._homeUpSince = null;
        else {
          heldLean = false;
          if (this._homeUpSince === null) this._homeUpSince = tMs;
          else if (tMs - this._homeUpSince >= T.neutralSettleMs) this._clearHome();
        }
      }
      if (!heldLean) {
        // the neutral is about to follow the steady pose: when that is a held POSTURE (a lean, a duck, a sway)
        // against the last neutral the player stood upright at (see _noteUpright), and that one worth coming back
        // to (_homeWorthy), keep it as home
        if (!this._home) {
          if (this._poseDiffers(m, N)) this._adoptingUntil = tMs + T.neutralWindowMs;   // the neutral really moves
          const U = this._upright && tMs - this._upright.at <= T.neutralHomeKeepMs ? this._upright : N;
          if (this._poseDiffers(m, U)) {
            const kind = this._postureKind(m, U, unit);
            if (kind && this._homeWorthy(kind, U, m, unit, tMs)) { this._home = { ...U, kind, at: tMs }; this._homeUpSince = null; this._homeNear = null; }
          }
        }
        const k = emaK(dtMs, T.neutralAdoptTauMs);
        N.u += (m.hx - N.u) * k; N.v += (m.hy - N.v) * k; N.lsw += (m.lsw - N.lsw) * k; N.tilt += (m.tilt - N.tilt) * k;
        N.relX += (m.relX - N.relX) * k; N.relY += (m.relY - N.relY) * k;
        if (m.ts !== null) N.ts = N.ts === null || N.ts === undefined ? m.ts : N.ts + (m.ts - N.ts) * k;
        if (m.wz !== null) N.wz = N.wz === null ? m.wz : N.wz + (m.wz - N.wz) * k;
        if (m.lhs !== null) N.lhs = N.lhs === null ? m.lhs : N.lhs + (m.lhs - N.lhs) * k;
        N.adopted += k;
      }
    } else if (!busy) {
      // just back home: refresh the forward/back references once (see _homeRefresh); back upright after a held
      // sideways lean but not where home is: re-centre at once (see _homeElsewhere)
      if (tMs < this._homeQuickUntil) this._homeRefresh(tMs);
      if (this._home && this._home.kind === 'side') this._homeElsewhere(unit, tMs);
    }
    // back at home (the pose from before a held posture was adopted): home is the neutral again at once — and a home
    // brought back by the forward / back cues alone is on probation (see _homeProbation)
    if (this._home && !busy) this._homeRestore(head, tilt, side, unit, tMs, { relX: (head[0] - scRaw[0]) / Math.max(1e-4, swRaw), relY: (head[1] - scRaw[1]) / Math.max(1e-4, swRaw) });
    else if (this._away && !busy) this._homeProbation(head, tilt, side, unit, tMs);
    const N = this._neutral;
    // ── sideways / up-down: the head against the neutral, in the player's (slow) shoulder widths ──
    let dxAbs = side * (head[0] - N.u) / unit;
    let dyAbs = -(head[1] - N.v) / unit;
    // R4: the head filter's lag on a moving head, added back for the lean output (see leanLead); the neutral logic above
    // keeps the filtered head
    let leadX = 0, leadY = 0;
    if (T.leanLead > 0 && this._headF.initialized) {
      const v = this._headF.velocity, spd = Math.hypot(v[0], v[1]) / unit;
      const gate = ramp(spd, T.leanLeadSpeedFrom, 2 * T.leanLeadSpeedFrom) * T.leanLead * this._headF.lagMs / 1000;
      leadX = clamp(side * v[0] / unit * gate, -T.leanMaxLeadSW, T.leanMaxLeadSW);
      leadY = clamp(-v[1] / unit * gate, -T.leanMaxLeadSW, T.leanMaxLeadSW);
    }
    // a player who never stands still for long (a busy bout) still moves about and may have been learned off: the
    // neutral follows the place they box at (item 15; see neutralPlaceMs) — not toward a held lean or duck, not while a
    // home is kept or on probation, not while the steadiness path is re-centring
    if (T.neutralPlaceMs > 0 && P && !this._home && !this._away && tMs >= this._adoptingUntil && !(J && J.steady && steadyMs >= T.neutralSettleMs)
      && this._followPlace(P, side, unit, dtMs)) {
      dxAbs = side * (head[0] - N.u) / unit; dyAbs = -(head[1] - N.v) / unit;
    }
    // small offsets — stance sway, slow drift, no dodge (|x|, |y| under neutralTrackSW, shoulders level with the neutral) —
    // are followed slowly on quiet frames
    if (!busy && Math.abs(dxAbs) < T.neutralTrackSW && Math.abs(dyAbs) < T.neutralTrackSW && Math.abs(tilt - N.tilt) < T.neutralLeanTilt) {
      const kt = emaK(dtMs, T.neutralTrackMs);
      N.u += (head[0] - N.u) * kt; N.v += (head[1] - N.v) * kt;
      dxAbs = side * (head[0] - N.u) / unit; dyAbs = -(head[1] - N.v) / unit;
    }
    // ── forward / back (m, + = toward the camera) ──
    const swRefN = Math.exp(N.lsw);
    const wsw = this._wswQ.quantile(0.5, T.leanZShoulderM);
    const dist = T.leanZFocal * (wsw > 0.15 && wsw < 0.7 ? wsw : T.leanZShoulderM) / Math.max(1e-3, swRefN);
    const k = emaK(dtMs, T.leanZTauMs);
    const lsw = Math.log(Math.max(1e-4, swRaw)) - N.lsw;
    const lhs = lhsRaw !== null && N.lhs !== null ? lhsRaw - N.lhs : null;
    const zw = wz !== null && N.wz !== null ? wz - N.wz : null;
    // per-frame jitter of each cue (second differences on quiet frames) → the agreement tolerances
    const Jt = this._zJit || (this._zJit = { ls: new RollingQuantile(90, 15), lh: new RollingQuantile(90, 15), wz: new RollingQuantile(90, 15), prev: [] });
    const cur = { t: tMs, ls: Math.log(Math.max(1e-4, swRaw)), lh: lhsRaw, wz };
    const pv = Jt.prev;
    // (second differences over ≥ diffBaseMs steps: the 30 fps meaning at 60 fps, R3)
    if (!pv.length || tMs - pv[pv.length - 1].t >= T.diffBaseMs) {
      if (pv.length === 2 && !busy && tMs - pv[0].t < 150) {
        for (const key of ['ls', 'lh', 'wz']) {
          if (cur[key] !== null && pv[0][key] !== null && pv[1][key] !== null) Jt[key].push(Math.abs(pv[1][key] - (pv[0][key] + cur[key]) / 2));
        }
      }
      pv.push(cur); if (pv.length > 2) pv.shift();
    }
    const zf = this._zf || (this._zf = { lsw, zw, lhs });
    zf.lsw += (lsw - zf.lsw) * k;
    if (zw !== null) zf.zw = zf.zw === null ? zw : zf.zw + (zw - zf.zw) * k; else zf.zw = null;
    if (lhs !== null) zf.lhs = zf.lhs === null ? lhs : zf.lhs + (lhs - zf.lhs) * k; else zf.lhs = null;
    // three estimates of the forward displacement (m): shoulder width, head size (both × the distance),
    // hip-relative world depth (compression undone). Filtered jitter ≈ 0.6 × the per-frame σ (≈ median |Δ²| / 0.83).
    const sig = (q, scale) => Math.max(0.01, scale * 0.6 * q.quantile(0.5, 0.02) / 0.83);
    const fwdS = dist * (1 - Math.exp(-zf.lsw)), sS = sig(Jt.ls, dist);
    const fwdH = zf.lhs === null ? null : dist * (1 - Math.exp(-zf.lhs)), sH = sig(Jt.lh, dist);
    // (the depth compression: the calibrated one, else the prior — the online estimate follows the arms and
    // drifts while the player leans)
    const kzN = this.calibration && Number.isFinite(this.calibration.zScale) ? clamp(this.calibration.zScale, T.zScaleMin, T.zScaleMax) : T.zScalePrior;
    const fwdW = zf.zw === null ? null : MP_AXES.worldForward * zf.zw / kzN, sW = sig(Jt.wz, 1 / kzN);
    // two cues agree when they point the same way and are within the jitter of each other or within a factor
    // (they see different body parts: in a lean the head travels further than the shoulders); once they
    // agree, they keep agreeing until a looser test has failed for leanZAgreeOffMs (no flicker while a lean
    // is held: each cue jitters by several cm)
    const ag = this._zAgree || (this._zAgree = { sh: { on: false, bad: null }, iw: { on: false, bad: null } });
    const agree = (st, a, b, sa, sb) => {
      const lo = Math.min(Math.abs(a), Math.abs(b)), hi = Math.max(Math.abs(a), Math.abs(b));
      const near = hi - lo <= T.leanZAgreeSigma * Math.hypot(sa, sb) + T.leanZAgreeM;
      const strict = a * b > 0 && (near || lo >= T.leanZAgreeRatio * hi);
      const loose = a * b > 0 && (near || lo >= T.leanZAgreeKeep * hi);
      if (hi < T.leanZDeadzoneM) { st.on = false; st.bad = null; return strict; }   // at rest: no carry-over
      if (strict || (st.on && loose)) { st.on = true; st.bad = null; }
      else if (st.on) { if (st.bad === null) st.bad = tMs; if (tMs - st.bad >= T.leanZAgreeOffMs) st.on = false; }
      return st.on;
    };
    // the picture: shoulders and head must move together (a torso twist narrows only the shoulders, a head
    // turn shrinks only the head; in a lean the head travels as far or further). They start agreeing on a
    // clear joint movement (the smaller ≥ leanZAgreeHeadRatio of the larger, beyond the deadzone) and keep
    // agreeing while the smaller stays ≥ leanZAgreeKeep of the larger or within their jitter of it (a far
    // player's head size jitters a lot)
    let img = fwdS, sImg = sS;
    if (fwdH !== null) {
      const st = ag.sh;
      const lo = Math.min(Math.abs(fwdS), Math.abs(fwdH)), hi = Math.max(Math.abs(fwdS), Math.abs(fwdH));
      const same = fwdS * fwdH > 0;
      if (same && lo >= T.leanZAgreeHeadRatio * hi && hi >= 2 * T.leanZDeadzoneM) { st.on = true; st.bad = null; }
      else if (hi < T.leanZDeadzoneM) { st.on = false; st.bad = null; }   // back at rest: each new movement must agree anew
      else if (st.on && same && (lo >= T.leanZAgreeKeep * hi || hi - lo <= T.leanZAgreeSigma * Math.hypot(sS, sH))) st.bad = null;
      else if (st.on) { if (st.bad === null) st.bad = tMs; if (tMs - st.bad >= T.leanZAgreeHeadOffMs) st.on = false; }
      // (V3-3: in a sway the head travels at least as far as the shoulders: when the shoulders' size changed MORE than the face's,
      // the excess is the torso twisting — the picture's estimate is then the face's own)
      // (beyond their jitter: leanZAgreeSigma × the two cues' combined σ)
      const twist = T.leanZTwistFace > 0 && Math.abs(fwdS) > T.leanZTwistFace * Math.abs(fwdH)
        && Math.abs(fwdS) - Math.abs(fwdH) > T.leanZAgreeSigma * Math.hypot(sS, sH);
      img = st.on && same ? (twist ? fwdH : (fwdS + fwdH) / 2) : 0;
      sImg = Math.hypot(sS, sH) / 2;
    }
    let fwd;
    if (fwdW !== null) {
      // the depth's slow wander (a few cm over seconds) is followed while the picture says the upper body has
      // not moved toward or away from the camera
      // (the wander is the tracker's, not the player's: a kept home follows it as well)
      if (!busy && Math.abs(fwdS) < T.leanZDeadzoneM && (fwdH === null || Math.abs(fwdH) < T.leanZDeadzoneM)) {
        const dW = (wz - N.wz) * emaK(dtMs, T.leanZWorldTrackMs);
        N.wz += dW;
        for (const Hk of [this._home, this._upright]) if (Hk && Hk.wz !== null) Hk.wz += dW;
      }
      // …and the depth must agree with the picture: a step moves only the picture, a nod only the nose's depth
      // (a plain mean: the measured frame-to-frame jitter misses the depth's slow wander, so jitter weights
      // would trust the depth too much)
      // V3-3: …and the depth counts only as far as the face's own apparent size confirms it (leanZFaceCap × the face's estimate +
      // leanZFaceSigma × the face cue's measured jitter: a far player's face size jitters by several cm): the head travels at
      // least as far as the shoulders in a sway, and the face's size changes by that sway over the distance at any camera
      // distance — measured, not inferred like the depth. The lite model's depth reads a 5–8 cm sway the face shows as
      // 13–17 cm (the close-webcam clip). 0 = off.
      // (only when the depth reads MORE than both picture cues — in a sway the face moves furthest)
      const wC = T.leanZFaceCap > 0 && fwdH !== null && Math.abs(fwdW) > Math.max(Math.abs(fwdS), Math.abs(fwdH))
        ? Math.sign(fwdW) * Math.min(Math.abs(fwdW), T.leanZFaceCap * Math.abs(fwdH) + T.leanZFaceSigma * sH) : fwdW;
      fwd = agree(ag.iw, img, wC, sImg, sW) && img * wC > 0 ? (img + wC) / 2 : 0;
    } else if (fwdH !== null) {
      // no world landmarks: the shoulders, confirmed by the head's own size
      fwd = Math.sign(fwdH) === Math.sign(fwdS) ? Math.sign(fwdS) * Math.min(Math.abs(fwdS), T.headScaleGain * Math.abs(fwdH)) : 0;
    } else fwd = fwdS;
    this._leanZ = { shoulders: fwdS, head: fwdH, world: fwdW, img, fwd, sS, sH, sW, dist };
    let z = leanCurve(fwd, T.leanZDeadzoneM, T.leanZDodgeM, T.leanDodgeLevelZ, T.leanZFullM);
    // a punch twists the torso, which narrows the shoulders in the picture just like leaning
    // back does: while a stroke is in flight, until the punching hand has come back (the torso
    // unwinds with it), and leanTwistHoldMs after, lean.z may rise (stepping in) but not drop
    // below where it stood when that began (or 0). Leaning back keeps the hands still on the body.
    if (HANDS.some((h) => {
      const ht = this.hands[h];
      // (a stroke that never fires is often the hands riding along with a lean: only strokes that
      // already look like a punch count; the depth check above handles the rest)
      const dodging = ht.dodgeT !== undefined && tMs - ht.dodgeT < T.dodgeHoldMs;
      return ht.punchingUntil > tMs || ht.state === 'cooldown'
        || (!dodging && ht.state === 'stroke' && ht.stroke && ht.stroke.peak >= T.leanTwistStrokeDrive)
        || (!dodging && T.leanTwistHandSpeed > 0 && Math.hypot(ht.vel[0], ht.vel[1]) >= T.leanTwistHandSpeed);
    })) {
      this._twistUntil = tMs + T.leanTwistHoldMs;
    }
    if (tMs < this._twistUntil) {
      if (this._zFloor === null) this._zFloor = Math.min(0, this._lean.z);
      z = Math.max(z, this._zFloor);
    } else this._zFloor = null;
    // persistence: the smallest same-sign |z| over the last leanZHoldMs, counting the value that
    // held at the start of that window (a brief twist or one noisy frame never counts)
    const zh = this._zHist;
    zh.push({ t: tMs, z });
    while (zh.length > 1 && zh[1].t <= tMs - T.leanZHoldMs) zh.shift();
    let zOut = z;
    if (T.leanZHoldMs > 0) {
      if (zh[0].t > tMs - T.leanZHoldMs) zOut = 0;   // not enough history yet
      else {
        for (const s of zh) {
          if (s.z === 0 || Math.sign(s.z) !== Math.sign(z)) { zOut = 0; break; }
          if (Math.abs(s.z) < Math.abs(zOut)) zOut = s.z;
        }
      }
    }
    const lx = dxAbs + leadX, ly = dyAbs + leadY;
    this._lean = {
      x: leanCurve(lx, T.leanDeadzoneSW, T.leanDodgeSW, T.leanDodgeLevelX, T.leanFullSW),
      y: ly < 0
        ? leanCurve(ly, T.duckDeadzoneSW, T.duckDodgeSW, T.duckDodgeLevel, T.duckFullSW)
        : clamp(Math.max(0, ly - T.duckDeadzoneSW) / (T.riseFull - T.duckDeadzoneSW), 0, 1),
      z: zOut,
    };
    this._head = { x: lx, y: ly };
    this._noteUpright(busy, tMs);
  }

  /** The neutral is pose `m` (a steady window's or the place's): learned for the first time, or again (a provisional one
   *  in the first steady window in guard). The forward/back filters start over; no home, no restore on probation. */
  _learnNeutral(m, tMs, provisional) {
    this._neutral = { u: m.hx, v: m.hy, lsw: m.lsw, lhs: m.lhs ?? null, tilt: m.tilt, relX: m.relX, relY: m.relY, wz: m.wz ?? null, ts: m.ts ?? null,
      t: tMs, adopted: 0, provisional };
    this._placeAcc = { x: 0, y: 0 };
    this._zf = null; this._zAgree = null;
    this._clearHome();
    this._resetHomeProbation();
  }

  /**
   * Item 15: the neutral follows the place pose `P` (NeutralWindow.placePose) — position and posture references, with
   * neutralFollowMs (neutralFollowFirstMs while provisional) — unless P is a held lean against it (the shoulders tilted
   * toward the head offset and the head moved over them that way) or a held duck (the head clearly lower and the upper
   * body nearer): those are the steadiness path's (and home's, R1). Returns whether the neutral moved.
   */
  /** Is pose `m` (a place or a steady window's mean) a held lean or duck against the neutral? A sideways lean: the
   *  shoulders tilted ≥ neutralLeanTilt toward a head offset ≥ neutralLeanSW and the head moved over the shoulders that way
   *  by ≥ neutralFollowLeanRel of the offset (a step, a stance change or a wandering guard moves the shoulders with the
   *  head). A duck: the head neutralTrackSW lower and the upper body neutralSwayM nearer. */
  _heldPosture(m, side, unit) {
    const T = this.tuning, N = this._neutral;
    const dx = side * (m.hx - N.u) / unit, dy = -(m.hy - N.v) / unit;
    const dTilt = m.tilt - N.tilt, dRel = side * (m.relX - N.relX);   // the player's perspective
    if (Math.abs(dx) >= T.neutralLeanSW && Math.abs(dTilt) >= T.neutralLeanTilt && Math.sign(dTilt) === Math.sign(dx)
      && Math.sign(dRel) === Math.sign(dx) && Math.abs(dRel) >= T.neutralFollowLeanRel * Math.abs(dx)) return true;
    if (dy <= -T.neutralTrackSW) {
      const f = this._fwdFrom(N, m.lsw, m.lhs, m.wz);
      const fwd = f.depth !== null ? f.depth : f.fH;
      return fwd !== null && fwd >= T.neutralSwayM;
    }
    return false;
  }

  _followPlace(P, side, unit, dtMs) {
    const T = this.tuning, N = this._neutral;
    const dx = side * (P.hx - N.u) / unit, dy = -(P.hy - N.v) / unit;
    const acc = this._placeAcc;
    const held = this._heldPosture(P, side, unit);
    // persistence, per axis and time-integrated: an offset beyond neutralFollowDeadSW counts up toward neutralFollowHoldMs
    // while it stays on its side and counts down twice as fast otherwise; the neutral follows that axis in proportion — a
    // slip or a duck that fills the window for a moment is not followed, a new place is (a provisional neutral at once)
    const H = N.provisional ? 0 : T.neutralFollowHoldMs;
    const count = (a, d) => {
      if (held || Math.abs(d) < T.neutralFollowDeadSW) return Math.sign(a) * Math.max(0, Math.abs(a) - 2 * dtMs);
      if (a * d < 0) { const r = Math.abs(a) - 2 * dtMs; return r > 0 ? Math.sign(a) * r : 0; }
      return Math.sign(d) * Math.min(H, Math.abs(a) + dtMs);
    };
    acc.x = count(acc.x, dx); acc.y = count(acc.y, dy);
    if (held) return false;
    // (an offset under the deadband — the place's own wander as slips and ducks come and go — is the small-offset tracking's)
    const k = emaK(dtMs, N.provisional ? T.neutralFollowFirstMs : T.neutralFollowMs);
    const rate = (a, d) => (Math.abs(d) < T.neutralFollowDeadSW ? (N.provisional ? k : 0) : !(H > 0) ? k : a * d > 0 ? k * Math.abs(a) / H : 0);
    const kx = rate(acc.x, dx), ky = rate(acc.y, dy);
    if (!(kx > 0) && !(ky > 0)) return false;
    const kp = Math.max(kx, ky);
    N.u += (P.hx - N.u) * kx; N.v += (P.hy - N.v) * ky;
    N.tilt += (P.tilt - N.tilt) * kp; N.relX += (P.relX - N.relX) * kp; N.relY += (P.relY - N.relY) * kp;
    if (P.ts !== null && Number.isFinite(N.ts)) N.ts += (P.ts - N.ts) * kp;
    // (provisional until it has caught up with the place of a player in guard)
    if (N.provisional && P.readyShare >= T.neutralReadyShare && Math.max(Math.abs(dx), Math.abs(dy)) < 0.1) N.provisional = false;
    return true;
  }

  // ── home: the neutral from before a held posture was adopted (R1, RV-INPUT-01/02) ──

  _clearHome() {
    this._home = null;          // frozen: the upright neutral a held posture was adopted over (+ kind: side/duck/sway)
    this._homeNear = null;      // since when the pose has been back near home
    this._homeUpSince = null;   // since when the steady pose has been upright elsewhere (away from home)
    this._upright = null;       // the last neutral the player stood upright at (lean ≈ 0, the neutral not moving)
    this._uprightSince = null;
    this._adoptingUntil = -Infinity;   // the re-centring is moving the neutral to a different pose until then
    this._homeQuickUntil = -Infinity;  // just restored: the forward/back references may be refreshed until then
    this._homeQuickPos = false;        // …and the head position too (upright again elsewhere: _homeUpElsewhere)
    this._homeUpAt = null;             // since when the player has looked upright elsewhere (a sideways home)
  }

  /** A new neutral (first learned, or learned again): no restore on probation, forward / back homes allowed. */
  _resetHomeProbation() {
    this._away = null;          // a home just restored by the forward/back cues, on probation: {pose: the neutral it
                                // replaced, home, at, settled, backSince} (see _homeProbation)
    this._swayHomeOff = false;  // such a restore was taken back: no more forward / back homes (see _homeProbation)
    this._swayLeft = null;      // the last such restore that held: {pose it replaced, at} (see _homeWorthy)
  }

  /** The last neutral the player stood upright at: the lean ≈ 0 for neutralUprightMs (no punch, no re-centring
   *  onto another pose in progress, no home kept, no restore on probation). A held posture adopted later is
   *  measured against it — not against a neutral that has already begun to follow the posture. */
  _noteUpright(busy, tMs) {
    const T = this.tuning, L = this._lean;
    const up = !busy && !this._home && !this._away && tMs > this._adoptingUntil && Math.abs(L.x) < 0.25 && Math.abs(L.y) < 0.25 && Math.abs(L.z) < 0.3;
    if (!up) { this._uprightSince = null; return; }
    if (this._uprightSince === null) this._uprightSince = tMs;
    if (tMs - this._uprightSince >= T.neutralUprightMs) this._upright = { ...this._neutral, at: tMs };
  }

  /** The steady pose differs from a neutral beyond the steadiness tolerances (the re-centring really moves it). */
  _poseDiffers(m, R) {
    const T = this.tuning, sw = Math.max(1e-3, Math.exp(m.lsw));
    return Math.abs(m.hx - R.u) / sw > T.neutralSteadySW || Math.abs(m.hy - R.v) / sw > T.neutralSteadySW
      || Math.abs(m.tilt - R.tilt) > T.neutralSteadyTilt || Math.abs(m.lsw - R.lsw) > T.neutralSteadyScale
      || (m.wz !== null && R.wz !== null && Math.abs(m.wz - R.wz) > T.neutralSteadyDepthM);
  }

  /**
   * Forward (+, toward the camera) / back displacement (m) of the upper body from a reference pose `R`:
   * `fS` from the apparent shoulder width, `img` the shoulders confirmed by the head size (0 when they
   * disagree), `depth` from the tracker's hip-relative depth (null without world landmarks).
   */
  _fwdFrom(R, lsw, lhs, wz) {
    const T = this.tuning;
    const wsw = this._wswQ.quantile(0.5, T.leanZShoulderM);
    const dist = T.leanZFocal * (wsw > 0.15 && wsw < 0.7 ? wsw : T.leanZShoulderM) / Math.max(1e-3, Math.exp(R.lsw));
    const fS = dist * (1 - Math.exp(-(lsw - R.lsw)));
    const fH = lhs !== null && lhs !== undefined && R.lhs !== null && R.lhs !== undefined ? dist * (1 - Math.exp(-(lhs - R.lhs))) : null;
    const img = fH === null ? fS : fS * fH > 0 ? Math.sign(fS) * Math.min(Math.abs(fS), Math.abs(fH)) : 0;
    const kz = this.calibration && Number.isFinite(this.calibration.zScale) ? clamp(this.calibration.zScale, T.zScaleMin, T.zScaleMax) : T.zScalePrior;
    const depth = wz !== null && wz !== undefined && R.wz !== null && R.wz !== undefined ? MP_AXES.worldForward * (wz - R.wz) / kz : null;
    return { fS, fH, img, depth };
  }

  /**
   * Is the steady pose `m` a held POSTURE relative to the reference pose `R` (not a step or a nudged camera)?
   * 'side' (a sideways lean), 'duck', 'sway' (forward / back), or null.
   */
  _postureKind(m, R, unit) {
    const T = this.tuning;
    if (Math.abs(m.tilt - R.tilt) >= T.neutralLeanTilt) return 'side';
    const f = this._fwdFrom(R, m.lsw, m.lhs, m.wz);
    // a duck: the head clearly lower and the upper body pitched toward the camera (in the depth; without world
    // landmarks in the head's size) — a nudged camera or a step moves the head in the picture, not the depth
    const fwdEvidence = f.depth !== null ? f.depth : f.fH;
    if (-(m.hy - R.v) / unit <= -T.neutralTrackSW && fwdEvidence !== null && fwdEvidence >= T.neutralSwayM) return 'duck';
    // a sway: the picture (shoulders AND head size, which a sway moves at least as far — a step to the side changes
    // the shoulders' apparent width alone) and the depth agree on it; without world landmarks it cannot be told from
    // a step and counts as a sway. (The depth's window mean wanders by a few cm: it must show a good part of it. A
    // step of 10–15 cm toward or away from the camera can still show 3–9 cm by itself — such a "home" is on probation
    // when it is brought back, see _homeProbation.)
    if (Math.abs(f.img) < T.neutralSwayM) return null;
    if (f.fH !== null && Math.abs(f.fH) < T.leanZAgreeHeadRatio * Math.abs(f.fS)) return null;
    if (f.depth === null) return 'sway';
    return f.img * f.depth > 0 && Math.abs(f.depth) >= Math.max(0.75 * T.neutralSwayM, 0.3 * Math.abs(f.img)) ? 'sway' : null;
  }

  /** Is the steady pose `m` shaped like home `H` — i.e. upright again, wherever the player now stands? Shoulders as
   *  level as at home, and:
   *  - home kept over a sideways lean: the head over the shoulders as then (not where it is in the picture: a step
   *    toward or away from a low or high camera moves it), not swayed forward / back by a dodge-sized
   *    neutralSwayHomeM — in the hip-relative depth when the tracker gives it (a step moves only the picture), else
   *    in the picture;
   *  - over a duck or a sway (whose posture IS forward / back): neither forward nor back of home by neutralSwayM in
   *    the picture nor in the depth (the depth alone wanders by a few cm), the head not dropped. */
  _uprightLike(m, H, unit) {
    const T = this.tuning;
    if (Math.abs(m.tilt - H.tilt) >= T.neutralLeanTilt) return false;
    const f = this._fwdFrom(H, m.lsw, m.lhs, m.wz);
    if (H.kind === 'side') {
      return Math.abs(m.relX - H.relX) < T.neutralLeanSW && m.relY - H.relY < T.neutralLeanSW
        && Math.abs(f.depth !== null ? f.depth : f.fS) < T.neutralSwayHomeM;
    }
    return Math.abs(f.fS) < T.neutralSwayM && (f.depth === null || Math.abs(f.depth) < T.neutralSwayM)
      && -(m.hy - H.v) / unit > -T.neutralTrackSW;
  }

  /** Forward / back displacement (m) of pose `B` from pose `A` (steady means), picture and depth fused as lean.z
   *  does it (their mean when they agree). */
  _fwdBetween(A, B) {
    const f = this._fwdFrom(A, B.lsw, B.lhs, B.wz);
    if (f.depth === null) return f.img;
    return f.img * f.depth > 0 ? (f.img + f.depth) / 2 : 0.5 * (Math.abs(f.img) > Math.abs(f.depth) ? f.img : f.depth);
  }

  /** Is the pose before (`P`) worth coming back to from the held posture `m` (of `kind`)? Sideways: when it is the
   *  more upright of the two — the torso over the hips (world landmarks), else shoulders level and the head over
   *  them, against the calibration's upright when there is one (a neutral learned in a sideways lean is not).
   *  Standing up out of a crouch (the upper body back, the head higher) is not a posture to come back from. A
   *  forward / back sway: only a dodge-sized one (coming back from less never reads as a dodge), and none after a
   *  restore on probation was taken back (_homeProbation) or the player went back within neutralHomeRelapseMs to the
   *  pose a restore had left. */
  _homeWorthy(kind, P, m, unit, tMs) {
    const T = this.tuning;
    if (kind === 'side') {
      // the torso's own sideways lean in the tracker's hip-centred world (shoulders over the hips: the camera's height
      // and pitch do not change it — they do change the shoulder line in the picture, by 10° for a low camera close by)
      if (Number.isFinite(P.ts) && Number.isFinite(m.ts)) return Math.abs(P.ts) < Math.abs(m.ts);
      const prior = this._neutralPrior || {};
      const tRef = Number.isFinite(prior.tilt) ? prior.tilt : 0, rRef = Number.isFinite(prior.relX) ? prior.relX : 0;
      const off = (p) => Math.abs(p.tilt - tRef) + Math.abs(p.relX - rRef);
      return off(P) < off(m);
    }
    const f = this._fwdFrom(P, m.lsw, m.lhs, m.wz);
    if (f.img < 0 && -(m.hy - P.v) / unit >= T.neutralRiseSW) return false;
    if (kind === 'duck') return true;
    if (this._swayHomeOff || Math.abs(this._fwdBetween(P, m)) < T.neutralSwayHomeM) return false;
    // back in the very pose a forward / back restore left only seconds ago (a dodge toward that home held longer than
    // the probation, the player then went straight back): the two take turns — neither is known to be upright
    const L = this._swayLeft;
    if (L && tMs - L.at < T.neutralHomeRelapseMs && Math.abs(this._fwdBetween(L.pose, m)) < 0.35 * Math.abs(this._fwdBetween(P, L.pose))) {
      this._swayHomeOff = true;
      return false;
    }
    return true;
  }

  /** The neutral becomes pose `P` at once; the forward/back filters keep their absolute values, re-referenced to it
   *  (no jump, no re-learning). */
  _moveNeutral(P) {
    const N = this._neutral, zf = this._zf;
    if (zf) {
      zf.lsw += N.lsw - P.lsw;
      zf.lhs = zf.lhs !== null && N.lhs !== null && P.lhs !== null ? zf.lhs + N.lhs - P.lhs : null;
      zf.zw = zf.zw !== null && N.wz !== null && P.wz !== null ? zf.zw + N.wz - P.wz : null;
    }
    Object.assign(N, { u: P.u, v: P.v, lsw: P.lsw, lhs: P.lhs, tilt: P.tilt, relX: P.relX, relY: P.relY, wz: P.wz, ts: P.ts ?? N.ts });
  }

  /** Just back home (for neutralHomeRefreshMs): home's forward/back references (shoulder width, head size, depth)
   *  are seconds old and the cues' slow wander has moved on, so they are refreshed ONCE from the first steady HALF
   *  window after the restore — the head still where home is, shoulders as level (and, for a home told apart by the
   *  forward / back cues alone, once the player has been seen standing there). Only those references: nothing else
   *  is adopted, and no home is kept (a dodge right after the return must still read as one). */
  _homeRefresh(tMs) {
    const T = this.tuning, N = this._neutral;
    if (!N || tMs - this._homeQuickFrom < T.neutralWindowMs / 2) return;
    // (a home brought back by the forward / back cues alone: not before the player is seen standing there — the
    // restore may have been a noise blip during the held posture, see _homeProbation)
    if (this._away && this._away.settled === null) return;
    const Jq = this._nw.judge(T, tMs, T.neutralWindowMs / 2);
    if (!Jq || !Jq.steady) return;
    const m = Jq.mean, sw = Math.max(1e-3, Math.exp(m.lsw)), pos = this._homeQuickPos;
    const near = pos ? T.neutralTrackSW : T.neutralSteadySW;
    if (Math.abs(m.hx - N.u) / sw > near || Math.abs(m.hy - N.v) / sw > near || Math.abs(m.tilt - N.tilt) > T.neutralSteadyTilt) return;
    this._moveNeutral({ ...N, ...(pos ? { u: m.hx, v: m.hy } : {}), lsw: m.lsw, lhs: m.lhs !== null ? m.lhs : N.lhs, wz: m.wz !== null ? m.wz : N.wz });
    this._homeQuickUntil = -Infinity; this._homeQuickPos = false;
  }

  /** A held sideways lean became the neutral (home kept); the player is upright again — shoulders as level as at
   *  home, the head over them, not swayed (_uprightLike) — but not where home is (a step on the way back): the
   *  neutral is that pose at once, from the first steady HALF window (its position and size; home's shoulder line
   *  and head offset), and home is forgotten. (The full steady window plus neutralSettleMs would read the upright
   *  pose as a lean for seconds.) */
  _homeElsewhere(unit, tMs) {
    const T = this.tuning, H = this._home, N = this._neutral;
    if (!N) return;
    const Jq = this._nw.judge(T, tMs, T.neutralWindowMs / 2);
    if (!Jq || !Jq.steady || !this._uprightLike(Jq.mean, H, unit)) return;
    const m = Jq.mean;
    this._moveNeutral({ u: m.hx, v: m.hy, lsw: m.lsw, lhs: m.lhs !== null ? m.lhs : N.lhs, wz: m.wz !== null ? m.wz : N.wz,
      tilt: H.tilt, relX: H.relX, relY: H.relY, ts: H.ts });
    this._clearHome();
    this._upright = { ...N, at: tMs };
  }

  /** Back upright after a held sideways lean but not where home is (a step on the way back): shoulders as level as
   *  at home and the head over them as then (`cur`: this frame's head offset over the shoulder centre, shoulder
   *  widths), and no forward / back lean (lean.z's own estimate, picture and depth agreeing — a step toward or away
   *  moves the picture alone, and close to a low camera it also tilts the hip-relative depth by several cm), on
   *  every frame for neutralHomeElsewhereMs — the neutral is that pose at once: the head where it is now, home's
   *  shoulder line and head offset, the forward/back references from the low-passed cues; position and those
   *  references are refreshed once from the first steady half window (_homeRefresh). */
  _homeUpElsewhere(head, tilt, cur, tMs) {
    const T = this.tuning, H = this._home, N = this._neutral, zf = this._zf;
    const up = Math.abs(tilt - H.tilt) < T.neutralLeanTilt / 2 && Math.abs(cur.relX - H.relX) < T.neutralLeanSW / 2
      && cur.relY - H.relY < T.neutralLeanSW && !(this._leanZ && Math.abs(this._leanZ.fwd) >= T.neutralSwayHomeM);
    if (!up) { this._homeUpAt = null; return; }
    if (this._homeUpAt === null) this._homeUpAt = tMs;
    if (tMs - this._homeUpAt < T.neutralHomeElsewhereMs) return;
    this._moveNeutral({ u: head[0], v: head[1], lsw: N.lsw + (zf ? zf.lsw : 0),
      lhs: zf && zf.lhs !== null && N.lhs !== null ? N.lhs + zf.lhs : N.lhs,
      wz: zf && zf.zw !== null && N.wz !== null ? N.wz + zf.zw : N.wz, tilt: H.tilt, relX: H.relX, relY: H.relY, ts: H.ts });
    this._clearHome();
    this._upright = { ...N, at: tMs };
    this._homeQuickFrom = tMs; this._homeQuickUntil = tMs + T.neutralHomeRefreshMs; this._homeQuickPos = true;
    this._nw.steadySince = null;
  }

  /** Back near home (head, shoulder tilt, forward/back) for neutralHomeConfirmMs: home is the neutral again. */
  _homeRestore(head, tilt, side, unit, tMs, cur) {
    const T = this.tuning, H = this._home, N = this._neutral;
    if (!N) return;
    if (tMs - H.at > T.neutralHomeKeepMs) { this._clearHome(); return; }
    // the head (filtered) and the shoulder line against home; and the upper body about as far from the camera as
    // at home, in the picture and in the depth (the low-passed cues of the previous frame; generous — they jitter
    // by several cm — but a home from somewhere else never fits)
    const hx = side * (head[0] - H.u) / unit, hy = -(head[1] - H.v) / unit;
    let near = Math.abs(hx) < T.neutralHomeSW && Math.abs(hy) < T.neutralHomeSW && Math.abs(tilt - H.tilt) < T.neutralLeanTilt;
    const zf = this._zf;
    if (near && zf) {
      const f = this._fwdFrom(H, N.lsw + zf.lsw, null, zf.zw !== null && N.wz !== null ? N.wz + zf.zw : null);
      near = Math.abs(f.fS) < T.neutralHomeM && (f.depth === null || Math.abs(f.depth) < T.neutralHomeM);
    }
    if (!near) {
      this._homeNear = null;
      if (H.kind === 'side') this._homeUpElsewhere(head, tilt, cur, tMs);
      return;
    }
    this._homeUpAt = null;
    // Home and the adopted posture apart in the picture (a sideways lean, a duck): that tells them apart. Apart
    // only forward / back (a sway): the upper body must also have come at least half way back toward home, as the
    // lean's own forward/back estimate (picture and depth agreeing, previous frame) sees it — the moment a false
    // forward / back dodge would start. While that estimate has nothing (the cues disagree: 0) it neither starts
    // nor stops the confirmation.
    // (a duck's home is the higher of the two by neutralTrackSW: told apart by the head's height, not on probation)
    const apart = Math.max(Math.abs(side * (H.u - N.u) / unit), Math.abs((H.v - N.v) / unit)) >= 2 * T.neutralHomeSW
      || Math.abs(H.tilt - N.tilt) >= T.neutralLeanTilt || (H.kind === 'duck' && (N.v - H.v) / unit >= T.neutralTrackSW);
    let vote = 1;
    if (!apart) {
      const d = this._fwdBetween(N, H), fwd = this._leanZ ? this._leanZ.fwd : 0;
      // (not yet apart at all: the neutral has only begun to follow the posture — nothing to come back from)
      if (Math.abs(d) < T.neutralSwayM) { this._homeNear = null; return; }
      if (fwd === 0) { if (this._homeNear === null) return; vote = 0; }
      else if (fwd * d < 0 || Math.abs(fwd) < 0.5 * Math.abs(d)) { this._homeNear = null; return; }
    }
    if (this._homeNear === null) this._homeNear = { t: tMs, votes: 0 };
    this._homeNear.votes += vote;
    // (two frames that see it, none against, over neutralHomeConfirmMs)
    if (tMs - this._homeNear.t < T.neutralHomeConfirmMs || this._homeNear.votes < 2) return;
    const before = { u: N.u, v: N.v, lsw: N.lsw, lhs: N.lhs, tilt: N.tilt, relX: N.relX, relY: N.relY, wz: N.wz, ts: N.ts };
    this._moveNeutral(H);
    this._clearHome();
    // (told apart by the forward / back cues alone: on probation — see _homeProbation)
    if (apart) this._upright = { ...N, at: tMs };
    else this._away = { pose: before, home: { ...H }, at: tMs, settled: null, backSince: null };
    this._homeQuickFrom = tMs;
    this._homeQuickUntil = tMs + T.neutralHomeRefreshMs;
    // (the steady window still shows the posture just left: it must not be adopted again)
    this._nw.steadySince = null;
  }

  /**
   * A home brought back by the forward / back cues alone (a sway, a shallow duck) is on probation. Forward / back has
   * no absolute upright, so a real dodge toward a home that was itself a sway (the neutral learned in a sway at the
   * bout start, a sway the player then left for good) looks exactly like coming back from a held posture.
   * - The player must first stand at home: a steady half window there within neutralHomeProbationMs. Else the
   *   restore was a noise blip (the cues jitter by several cm, far more at 3 m) during the held posture: it is
   *   undone — the neutral and home as they were.
   * - Going back from there, within neutralHomeProbationMs, to the pose the neutral was restored from — head and
   *   shoulders where they were, lean.z three quarters of the way there on every frame for neutralHomeRevertMs, or a
   *   steady full window there (shoulder width and depth each: at 3 m either cue alone jitters by more than a sway
   *   within half a second) — means it was a dodge from there: that pose is the neutral again, and no forward / back
   *   home is kept any more in this bout.
   */
  _homeProbation(head, tilt, side, unit, tMs) {
    const T = this.tuning, A = this._away, N = this._neutral, P = A.pose;
    if (!N) { this._away = null; return; }
    const d = this._fwdBetween(N, P), fwd = this._leanZ ? this._leanZ.fwd : 0;
    const Jq = this._nw.judge(T, tMs, T.neutralWindowMs / 2);
    const near = (R) => Jq && Jq.steady && Math.abs(side * (Jq.mean.hx - R.u) / unit) < T.neutralHomeSW
      && Math.abs((Jq.mean.hy - R.v) / unit) < T.neutralHomeSW && Math.abs(Jq.mean.tilt - R.tilt) < T.neutralLeanTilt;
    if (A.settled === null) {
      // (at home — or beyond it: a dodge from there goes further than the sway it came back from)
      if (near(N) && tMs - A.at >= T.neutralWindowMs / 2 && Math.sign(d) * this._fwdBetween(N, Jq.mean) < 0.3 * Math.abs(d)) A.settled = tMs;
      else if (tMs - A.at > T.neutralHomeProbationMs) {
        // never stood at home: undo the restore
        this._moveNeutral(P);
        this._home = { ...A.home }; this._homeNear = null; this._homeUpSince = null;
        this._away = null; this._homeQuickUntil = -Infinity;
      }
      return;
    }
    if (tMs - A.settled > T.neutralHomeProbationMs) { this._swayLeft = { pose: P, at: A.at }; this._away = null; return; }
    const hx = side * (head[0] - P.u) / unit, hy = -(head[1] - P.v) / unit;
    const back = Math.abs(hx) < T.neutralHomeSW && Math.abs(hy) < T.neutralHomeSW && Math.abs(tilt - P.tilt) < T.neutralLeanTilt
      && fwd * d > 0 && Math.abs(fwd) >= 0.75 * Math.abs(d);
    if (back) { if (A.backSince === null) A.backSince = tMs; } else A.backSince = null;
    // (or a steady FULL window there: in the shoulders' width AND in the depth, each — at 3 m either cue alone
    // jitters by more than a sway within half a second)
    const Jf = this._nw.judge(T, tMs);
    const nearF = Jf && Jf.steady && Math.abs(side * (Jf.mean.hx - P.u) / unit) < T.neutralHomeSW
      && Math.abs((Jf.mean.hy - P.v) / unit) < T.neutralHomeSW && Math.abs(Jf.mean.tilt - P.tilt) < T.neutralLeanTilt;
    const fB = nearF ? this._fwdFrom(P, Jf.mean.lsw, Jf.mean.lhs, Jf.mean.wz) : null;
    const steadyBack = !!fB && Math.abs(fB.fS) < 0.3 * Math.abs(d) && (fB.depth === null || Math.abs(fB.depth) < 0.3 * Math.abs(d));
    if (!steadyBack && (A.backSince === null || tMs - A.backSince < T.neutralHomeRevertMs)) return;
    this._moveNeutral(P);
    this._away = null;
    this._swayHomeOff = true;
    this._homeQuickUntil = -Infinity;
    this._upright = { ...N, at: tMs };
    this._nw.steadySince = null;
  }

  /** Both fists in front of the body, from a low guard up to the face, not reaching out — "ready to box"
   *  (not walking to the spot with the arms down, not bent over the keyboard). */
  _handsUp(tMs) {
    const T = this.tuning;
    for (const h of HANDS) {
      const ht = this.hands[h], f = ht.f;
      if (!f || !f.fresh || ht.punchingUntil > tMs) return false;
      if (f.w[1] < T.neutralReadyMinY || f.w[1] > 1.2 || Math.abs(f.w[0]) > T.stanceMaxDx || f.X / T.reachFullX > T.stanceMaxReach) return false;
    }
    return true;
  }

  /** Log of the head's apparent size: RMS distance of the visible face landmarks (≥ 9 of 11) from their
   *  centroid, raw, uniform image units; null when too few are visible. */
  _headSize(obs) {
    const P = obs.headPts || {};
    const pts = HEAD_SIZE_POINTS.map((i) => P[i]).filter(Boolean);
    if (pts.length < 9) return null;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    let ss = 0;
    for (const p of pts) ss += (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    const r = Math.sqrt(ss / pts.length);
    return r > 1e-4 ? Math.log(r) : null;
  }

  /** Hip-relative world depth (raw tracker units, + = away from the camera) of the upper body: the mean
   *  of the shoulder centre and the nose, or null without world landmarks. */
  _upperBodyDepth(obs) {
    if (!obs.hasWorld) return null;
    const W = obs.world;
    const a = W[LM.LEFT_SHOULDER], b = W[LM.RIGHT_SHOULDER];
    if (!a || !b) return null;
    const hl = W[LM.LEFT_HIP], hr = W[LM.RIGHT_HIP];
    const hip = hl && hr ? (hl[2] + hr[2]) / 2 : 0;
    const sc = (a[2] + b[2]) / 2;
    const nose = W[LM.NOSE];
    return (nose ? (sc + nose[2]) / 2 : sc) - hip;
  }

  /** Sideways lean of the torso: the shoulder centre's offset from the hip centre across the picture, over the torso's
   *  length, in the tracker's hip-centred world (null without world landmarks). Upright ≈ 0 whatever the camera's
   *  height or pitch (they tilt the torso toward / away from the camera, not sideways). */
  _torsoSide(obs) {
    if (!obs.hasWorld) return null;
    const W = obs.world;
    const a = W[LM.LEFT_SHOULDER], b = W[LM.RIGHT_SHOULDER], c = W[LM.LEFT_HIP], d = W[LM.RIGHT_HIP];
    if (!a || !b || !c || !d) return null;
    const t = [(a[0] + b[0] - c[0] - d[0]) / 2, (a[1] + b[1] - c[1] - d[1]) / 2, (a[2] + b[2] - c[2] - d[2]) / 2];
    const l = Math.hypot(t[0], t[1], t[2]);
    return l > 0.2 ? t[0] / l : null;
  }

  /** Head centre (nose ×2 + eye midpoint + ear midpoint) from the RAW landmarks of this frame. */
  _headCentreRaw(obs) {
    const pts = [];
    const add = (p, w) => { if (p) pts.push([p, w]); };
    if (obs.ok[LM.NOSE]) add(obs.raw[LM.NOSE], 2);
    if (obs.ok[LM.LEFT_EYE] && obs.ok[LM.RIGHT_EYE]) {
      const a = obs.raw[LM.LEFT_EYE], b = obs.raw[LM.RIGHT_EYE];
      if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1);
    }
    if (obs.ok[LM.LEFT_EAR] && obs.ok[LM.RIGHT_EAR]) {
      const a = obs.raw[LM.LEFT_EAR], b = obs.raw[LM.RIGHT_EAR];
      if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1);
    }
    if (!pts.length) return null;
    let x = 0, y = 0, w = 0;
    for (const [p, k] of pts) { x += p[0] * k; y += p[1] * k; w += k; }
    return [x / w, y / w];
  }

  _updateActivity(dtMs) {
    const T = this.tuning;
    let e = 0;
    for (const h of HANDS) {
      const ht = this.hands[h];
      if (!ht.f || !ht.f.fresh) continue;
      e += Math.hypot(ht.vel[0], ht.vel[1]) + 0.5 * Math.abs(ht.xRate);
    }
    const a = clamp01(e / 2 / T.activityFull);
    this._activity += (a - this._activity) * emaK(dtMs, T.activityTauMs);
  }

  _updatePause(g, tMs, obs) {
    const T = this.tuning;
    const l = this.hands.left.f, r = this.hands.right.f;
    if (!l || !r) { this._pause.since = null; return null; }
    const lim = g.headP[1] + T.pauseAboveHead;
    const up = (l.w[1] > lim || obs.upOut[LM.LEFT_WRIST]) && (r.w[1] > lim || obs.upOut[LM.RIGHT_WRIST]);
    const down = l.w[1] < g.headP[1] && r.w[1] < g.headP[1];
    if (this._pause.latched) { if (down) this._pause.latched = false; this._pause.since = null; return null; }
    if (!up) { this._pause.since = null; return null; }
    if (this._pause.since === null) this._pause.since = tMs;
    if (tMs - this._pause.since >= T.pauseHoldMs) {
      this._pause.latched = true;
      this._pause.since = null;
      return { type: 'pause', t: tMs };
    }
    return null;
  }

  // ───────────────────────────── output ─────────────────────────────

  _composeControl(tMs, fresh) {
    const prev = this._control;
    const hands = {};
    for (const h of HANDS) {
      const ht = this.hands[h];
      const f = ht.f;
      const punching = ht.state === 'cooldown' && ht.punchingUntil > tMs;
      if (f && fresh) {
        const d = this._displayHand(ht, f);
        hands[h] = {
          x: Math.round(d.x * 1000) / 1000,
          y: Math.round(d.y * 1000) / 1000,
          reach: Math.round(clamp01(d.X / this.tuning.reachFullX) * 1000) / 1000,
          punching,
        };
      } else {
        hands[h] = { ...(prev ? prev.hands[h] : restHand(h)), punching: false };
      }
    }
    const tracked = this._tracked;
    const gAmt = Math.max(this._guard.high, this._guard.low);
    const guard = tracked ? this._guard.kind : GuardKind.NONE;
    // how long the guard / the fighting stance have been held (tutorial steps: input/tutorial-detect.js)
    if (guard !== this._guardShown) { this._guardShown = guard; this._guardSince = guard === GuardKind.NONE ? null : tMs; }
    const inStance = tracked && fresh && this._inStance(hands, tMs);
    if (!inStance) this._stanceSince = null; else if (this._stanceSince === null) this._stanceSince = tMs;
    return {
      tracked,
      confidence: Math.round(clamp01(this._confidence) * 1000) / 1000,
      guard,
      guardAmount: tracked ? Math.round(gAmt * 1000) / 1000 : 0,
      lean: { x: this._lean.x, y: this._lean.y, z: this._lean.z },
      head: { x: this._head.x, y: this._head.y },
      hands,
      activity: Math.round(this._activity * 1000) / 1000,
      guardMs: this._guardSince === null ? 0 : Math.round(tMs - this._guardSince),
      stanceMs: this._stanceSince === null ? 0 : Math.round(tMs - this._stanceSince),
    };
  }

  /**
   * R4 display position of a hand: the features' smoothed wrist (player units) and fused extension with the lag their
   * filters have right now added back — the wrist's One-Euro lag times the hand's velocity (relative to the shoulders),
   * the fused extension's displayReachLeadMs times its rate — faded in with the speed (a still hand gets no extra jitter)
   * and capped (displayMaxLead…). The punch logic never sees these values.
   */
  _displayHand(ht, f) {
    const T = this.tuning;
    let x = f.w[0], y = f.w[1], X = f.X;
    if (T.displayLead > 0) {
      const flt = this._img.get(IDX[ht.hand].wr);
      const lag = flt && flt.initialized ? flt.lagMs / 1000 : 0;
      const spd = Math.hypot(ht.vel[0], ht.vel[1]);
      const k = ramp(spd, T.displayLeadSpeedFrom, 2 * T.displayLeadSpeedFrom) * T.displayLead * lag;
      x += clamp(ht.vel[0] * k, -T.displayMaxLeadSW, T.displayMaxLeadSW);
      y += clamp(ht.vel[1] * k, -T.displayMaxLeadSW, T.displayMaxLeadSW);
    }
    if (T.displayReachLeadMs > 0) {
      const k = ramp(Math.abs(ht.xRate), T.displayReachRateFrom, 2 * T.displayReachRateFrom) * T.displayReachLeadMs / 1000;
      X += clamp(ht.xRate * k, -T.displayMaxLeadReach, T.displayMaxLeadReach);
    }
    return { x, y, X };
  }

  /**
   * The fighting stance (tutorial step `stance`, research/mechanics.md §2.1 "fists up"): both fists up in
   * front of the body (between stanceMinY SW below the shoulder line and the top of the head, within
   * stanceMaxDx SW of the body centre), neither punching nor reaching out, the body roughly
   * centred (no clear lean) and the hands steady.
   */
  _inStance(hands, tMs) {
    const T = this.tuning;
    for (const h of HANDS) {
      const s = hands[h], ht = this.hands[h];
      if (!s || s.punching || s.reach > T.stanceMaxReach) return false;
      if (s.y < T.stanceMinY || s.y > 1.2 || Math.abs(s.x) > T.stanceMaxDx) return false;
      if (Math.hypot(ht.vel[0], ht.vel[1]) > T.stanceMaxHandSpeed) return false;
    }
    const l = this._lean;
    return Math.abs(l.x) < T.stanceMaxLean && Math.abs(l.y) < T.stanceMaxLean && Math.abs(l.z) < T.stanceMaxLean;
  }

  _setDebug(tMs, obs, events, g) {
    const hands = {};
    for (const h of HANDS) {
      const ht = this.hands[h];
      const f = ht.f;
      hands[h] = {
        state: ht.state,
        X: f ? f.X : null, xRate: ht.xRate,
        drive: { ...ht.drive },
        w: f ? f.w : null, e: f ? f.e : null, home: ht.base ? ht.base.w : null,
        collapse: f ? f.collapse : null, straight: f ? f.straight : null, fwd: f ? f.fwd : null,
        up: f ? f.up : null, elbowUp: f ? f.elbowUp : null, ext3: f ? f.ext3 : null,
        cn: f ? f.cn : null, sn: f ? f.sn : null, fn: f ? f.fn : null, dn: f ? f.dn : null,
        vel: ht.vel.slice(), fresh: f ? f.fresh : false,
        lastPunch: ht.lastPunch || null,
        rejects: ht.rejects.slice(-4),
        fireInfo: ht.fire ? { ...ht.fire.cls, z: ht.fire.z } : null,
      };
    }
    this.debug = {
      t: tMs, tracked: this._tracked, core: !!(obs && obs.core), glitch: !!(obs && obs.glitch),
      sw: g ? g.sw : null, side: this._side, kz: this._kz, armLen: this._armLen, up: this._up,
      facing: g ? g.facing : null, bodySpeed: this._bodySpeed,
      headP: g ? g.headP : null, shoulderP: g ? g.shoulderP : null,
      headRef: { world: this._headRefW, image: this._headRefI },
      guard: { ...this._guard }, lean: { ...this._lean }, neutral: this._neutral ? { ...this._neutral } : null,
      home: this._home ? { ...this._home } : null, homeProbation: !!this._away, swayHomeOff: !!this._swayHomeOff,
      leanZ: this._leanZ ? { ...this._leanZ } : null, steadyMs: this._nw.steadySince === null ? 0 : tMs - this._nw.steadySince,
      hands, events: events.slice(),
    };
  }
}

/** Solve a 3×3 linear system (Gaussian elimination with partial pivoting); null if singular. */
function solve3(A, b) {
  const M = [[A[0][0], A[0][1], A[0][2], b[0]], [A[1][0], A[1][1], A[1][2], b[1]], [A[2][0], A[2][1], A[2][2], b[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
