// Shared enums, event names and JSDoc typedefs. This file is the contract between
// modules — read ARCHITECTURE.md alongside it. Do not change existing names
// without updating every consumer; adding new optional fields is fine.

// ───────────────────────────── enums ─────────────────────────────

export const Hand = Object.freeze({ LEFT: 'left', RIGHT: 'right' });
/** Lateral sign of a hand in "player-perspective" space: player's right = +1. */
export const handSign = (hand) => (hand === Hand.RIGHT ? 1 : -1);

export const PunchKind = Object.freeze({ STRAIGHT: 'straight', HOOK: 'hook', UPPERCUT: 'uppercut' });
export const Target = Object.freeze({ HEAD: 'head', BODY: 'body' });
export const GuardKind = Object.freeze({ NONE: 'none', HIGH: 'high', LOW: 'low' });

/** Phases of a single boxer (what the renderer animates). */
export const BoxerPhase = Object.freeze({
  IDLE: 'idle',         // fighting stance, bobbing
  GUARD: 'guard',       // gloves raised (high or low, see BoxerView.guard)
  WINDUP: 'windup',     // telegraph before a punch (AI only; humans have none)
  PUNCH: 'punch',       // punch travelling / impact
  RECOVER: 'recover',   // pulling the glove back; cannot punch with that hand
  DODGE: 'dodge',       // leaning/ducking out of the way (lean values say where)
  HITSTUN: 'hitstun',   // short flinch after being hit
  DAZED: 'dazed',       // longer "open" state (e.g. after a big counter); guard dropped
  DOWN: 'down',         // knocked down, on the canvas during the count
  GETUP: 'getup',       // rising after a count
  KO: 'ko',             // knocked out, stays down
  VICTORY: 'victory',   // celebrating
  DEFEAT: 'defeat',     // lost on decision, dejected
});

/** Phases of a match (single player or versus). */
export const MatchPhase = Object.freeze({
  INTRO: 'intro',             // fighters introduced, camera flyover
  ROUND_START: 'roundStart',  // "ROUND n" banner, bell
  FIGHTING: 'fighting',
  KNOCKDOWN: 'knockdown',     // fighter down, referee counting, combat suspended
  RECOVERY: 'recovery',       // downed fighter rose; brief reset before fighting resumes
  ROUND_END: 'roundEnd',      // bell, fighters stop
  BETWEEN: 'between',         // short break before next round
  DECISION: 'decision',       // judges' scorecards revealed
  RESULT: 'result',           // final result locked (resolved once)
  PAUSED: 'paused',
});

export const ResultMethod = Object.freeze({ KO: 'KO', TKO: 'TKO', DECISION: 'decision', DRAW: 'draw' });
export const ProfileKind = Object.freeze({ LOCAL: 'local', GUEST: 'guest', PORTABLE: 'portable' });
export const TrainingKind = Object.freeze({ BAG: 'bag', DODGE: 'dodge', MITTS: 'mitts' });
export const Medal = Object.freeze({ NONE: 'none', BRONZE: 'bronze', SILVER: 'silver', GOLD: 'gold', PLATINUM: 'platinum' });

/** Where input comes from. */
export const InputMode = Object.freeze({ CAMERA: 'camera', KEYBOARD: 'keyboard', REPLAY: 'replay' });

/** MediaPipe Pose landmark indices (33-point BlazePose topology). Names are the PERSON's anatomical side. */
export const LM = Object.freeze({
  NOSE: 0, LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3, RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8, MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_ELBOW: 13, RIGHT_ELBOW: 14, LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18, LEFT_INDEX: 19, RIGHT_INDEX: 20, LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24, LEFT_KNEE: 25, RIGHT_KNEE: 26, LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30, LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
});

// ───────────────────────────── event names (EventBus) ─────────────────────────────
// Payload shapes are documented in ARCHITECTURE.md §Events.
export const Ev = Object.freeze({
  // input
  INPUT_TRACKING_LOST: 'input:tracking-lost',     // {player: 0|1}
  INPUT_TRACKING_FOUND: 'input:tracking-found',   // {player: 0|1}
  INPUT_PUNCH: 'input:punch',                     // {player, punch: PunchInput}
  INPUT_ERROR: 'input:error',                     // {message, cause}
  // match
  MATCH_INTRO: 'match:intro',                     // {p1Name, p2Name}
  MATCH_ROUND_START: 'match:round-start',         // {round}
  MATCH_BELL: 'match:bell',                       // {kind: 'start'|'end'|'final'}
  MATCH_PUNCH_THROWN: 'match:punch-thrown',       // {attacker:'p1'|'p2', hand, kind, target}
  MATCH_HIT: 'match:hit',                         // {attacker, defender, hand, kind, target, damage, counter, power, pos?,
                                                  //  heavy?:boolean, knockdown?:boolean, hpBefore?:number, hpAfter?:number}  (hp in wedges, 0..10)
                                                  //  game/match.js also sends dealt (wedges actually removed), powerPunch, into, combo, hp01
  MATCH_BLOCK: 'match:block',                     // {attacker, defender, hand, kind, target, chip}
  MATCH_DODGE: 'match:dodge',                     // {attacker, defender, hand, kind, counterWindowMs}
  MATCH_MISS: 'match:miss',                       // {attacker, hand, kind}
  MATCH_KNOCKDOWN: 'match:knockdown',             // {downed:'p1'|'p2', count: number(knockdowns this bout)}
  MATCH_COUNT: 'match:count',                     // {downed, n}  (1..10)
  MATCH_GETUP: 'match:getup',                     // {downed, atCount}
  MATCH_KO: 'match:ko',                           // {winner, loser, method}
  MATCH_ROUND_END: 'match:round-end',             // {round}
  MATCH_DECISION: 'match:decision',               // {scorecards}
  MATCH_RESULT: 'match:result',                   // MatchResult (emitted exactly once per match)
  MATCH_WINDUP: 'match:windup',                   // {attacker, hand, kind, target, windupMs, tell:{pullback,glint,grunt,shoulder}} AI telegraph started
                                                  //   (+ tellMs = wind-up + travel, powerPunch, counter; tell.power on power punches)
  MATCH_DAZED: 'match:dazed',                     // {boxer:'p1'|'p2'} daze meter filled → DAZED  (legacy: never emitted since the
                                                  //   alignment pass — nobody gets groggy, research/mechanics.md §4.1.8)
  // Extra fields sent by game/match.js (alignment pass): MATCH_PUNCH_THROWN +power, counter, powerPunch ·
  //   MATCH_BELL +round, restart (true for the "Fight!" after a knockdown) · MATCH_GETUP +hp (wedges), knockdown (#) ·
  //   MATCH_KNOCKDOWN +roundCount, by, round, blow ({attacker, defender, hand, kind, target, impactAt, counter,
  //   powerPunch, damage, synthetic} — the knockdown blow; synthetic for Match.debugKnockdown) ·
  //   MATCH_INTRO +mode, opponentId, tutorial · MATCH_DODGE +how ('lean'|'duck'|'forward'|'back'), fresh (false: a
  //   posture held longer than COMBAT.freshDodgeMs — it evaded, but no slow motion and no counter window; counterWindowMs 0) ·
  //   MATCH_HIT +synthetic (true only for debugKnockdown's stand-in knockdown blow; no stats were counted)
  // Added for the research/mechanics.md alignment pass (see ARCHITECTURE.md §6):
  MATCH_CALL: 'match:call',                       // {call:'round'|'final-round'|'fight'|'down'|'ko'|'time'|'decision', round?, boxer?:'p1'|'p2', winner?}
                                                  //   announcer moments, emitted exactly when the text call should appear (HUD shows it, audio voices it)
  MATCH_SLOWMO: 'match:slowmo',                   // {kind:'dodge', dodger:'p1'|'p2', attacker:'p1'|'p2', scale, durationMs}
                                                  //   a successful dodge opened the slow-motion counter window (world ×scale, the dodger stays real-time)
  // render → HUD / audio / app
  RENDER_CUT: 'render:cut',                       // {kind:'player-hit'|'player-hit-heavy'|'knockdown-wide'|'player-down'|'standoff'|'round-intro'|'fight', viewer:'p1'|'p2'|null, durationMs}
  RENDER_OUTRO: 'render:outro',                   // {stage:'start'|'wipe'|'replay'|'flash'|'banner'|'winner'|'end', winner:'p1'|'p2'|null, method}
                                                  //   bout outro progress driven by GameRenderer.playOutro() (HUD shows the Replay tag / win banner, audio follows)
  // training
  TRAIN_START: 'train:start',                     // {kind, participant}
  TRAIN_SCORE: 'train:score',                     // {kind, delta, total, reason, pos?}
  TRAIN_EVENT: 'train:event',                     // {kind, type, ...}  e.g. bag-break, ball-throw, ball-hit, mitt-hit, trainer-hit
  TRAIN_END: 'train:end',                         // TrainingResult (exactly once)
  // ui / app
  UI_NAV: 'ui:nav',                               // {action: 'confirm'|'back'|'up'|'down'|'left'|'right'}
  UI_CLICK: 'ui:click',                           // {id}
  APP_PAUSE: 'app:pause',                         // {reason: 'user'|'tracking'|'hidden'}
  APP_RESUME: 'app:resume',
  APP_SCREEN: 'app:screen',                       // {screen}
  SAVE_RESULT: 'save:result',                     // {ok, saved, error?, kind}
  SETTINGS_CHANGED: 'settings:changed',           // {settings: Settings (core/storage.js), changed: string[]} — emitted by ui/
});

// ───────────────────────────── typedefs ─────────────────────────────

/**
 * One MediaPipe landmark. Image landmarks are normalized to [0,1] of the RAW (non-mirrored) camera frame.
 * @typedef {{x:number, y:number, z:number, visibility?:number, presence?:number}} Landmark
 */

/**
 * One tracked person in one camera frame.
 * @typedef {Object} PlayerPose
 * @property {Landmark[]} image  33 normalized image landmarks (raw camera orientation, NOT mirrored)
 * @property {Landmark[]} world  33 world landmarks in meters, origin between hips; smaller z = closer to camera
 * @property {number} score     mean visibility of upper-body landmarks 0..1
 * @property {number} [aspect]  optional camera frame width/height (gesture.js assumes 4/3 when absent)
 */

/**
 * @typedef {Object} PoseFrame
 * @property {number} t          timestamp ms (performance.now() domain) the camera frame was captured/processed
 * @property {number} width      camera frame width px
 * @property {number} height     camera frame height px
 * @property {(PlayerPose|null)[]} players  index 0 = P1, 1 = P2 (after assignment); null = not visible
 * @property {PlayerPose[]} [ignored]  (assigned frames only) extra people/posters PlayerAssigner rejected — previews draw them faint
 * @property {{latencyMs:number|null, source:string, captureTime:number|null, readyTime:number}} [timing]
 *           (camera frames from PoseTracker) capture → pose-ready latency of this frame; source says which clock
 *           stood in for the capture time ('capture'|'receive'|'presentation'|'callback'|'poll'|'none')
 */

/**
 * Per-player calibration (stored in the profile).
 * @typedef {Object} Calibration
 * @property {number} version              1
 * @property {number} shoulderWidth        image-normalized distance between shoulders at neutral stance (metadata only:
 *                                         gesture.js learns where the player stands again in every bout, INPUT-01/02)
 * @property {number} armLengthWorld       meters, shoulder→wrist (upper+fore arm) measured from world landmarks
 * @property {{x:number,y:number}} neutralHead   raw-image nose position at neutral guard stance (metadata only)
 * @property {number} neutralShoulderY     raw-image shoulder line y at neutral stance (metadata only)
 * @property {boolean} swapSides           true if the landmark L/R labels had to be swapped (detected in calibration)
 * @property {number} createdAt
 * (neutralHead, neutralShoulderY and shoulderWidth stay required because storage.sanitizeCalibration checks them.)
 * Optional fields written by input/calibration.js (older profiles may lack them; gesture.js has fallbacks):
 * @property {{x:number,y:number}} [neutralHeadRel]  head centre over the shoulder centre in shoulder widths
 *                                           (raw-image x, y down) — gesture.js's sanity check for the per-bout neutral
 * @property {number} [aspect]               camera frame width/height during calibration
 * @property {number} [zScale]               estimated depth compression of the tracker's world z (≈0.5–1)
 * @property {number[]} [neutralUp]          world-space torso up vector at neutral stance (camera tilt)
 * @property {number} [neutralTilt]          shoulder-line tilt (rad, player perspective) at neutral stance
 * @property {{world:number, image:number}} [headPunchLevel]  wrist height at head punches (armLen units / shoulder widths)
 * @property {number} [suggestedSensitivity] 0..1 from the player's natural punch speed
 * @property {number} [latencyMs]            measured camera→game latency (training widens its latency graces with it)
 */

/**
 * Continuous control state for one player, produced by GestureRecognizer (camera) or KeyboardInput.
 * All lateral values are in PLAYER PERSPECTIVE: +x = toward the player's own right side.
 * @typedef {Object} ControlState
 * @property {boolean} tracked
 * @property {number} confidence                  0..1
 * @property {'none'|'high'|'low'} guard
 * @property {number} guardAmount                 0..1 (how convincingly both gloves are up)
 * @property {{x:number, y:number, z:number}} lean  x: -1..1 (player's right = +); y: -1..1 (duck = negative);
 *                                               z: -1..1 (lean toward the opponent/camera = +, lean back = -)
 * @property {{x:number, y:number}} head          head offset from neutral in shoulder-widths (player persp., +y up)
 * @property {{left: HandState, right: HandState}} hands
 * @property {number} activity                    0..1 smoothed arm-motion energy (used e.g. to get up during a count)
 * Optional (alignment pass; GestureRecognizer and KeyboardInput fill them — see input/tutorial-detect.js):
 * @property {number} [guardMs]                   how long the current guard (≠ 'none') has been held, ms (0 without a guard)
 * @property {number} [stanceMs]                  how long the player has been in a steady fighting stance (fists up, centred), ms
 */

/**
 * @typedef {Object} HandState
 * @property {number} x       lateral offset from the shoulder-center, in shoulder widths, player's right = +
 * @property {number} y       vertical offset from the shoulder line, in shoulder widths, up = +
 * @property {number} reach   0 = glove at chest/guard, 1 = arm fully extended toward the opponent
 * @property {boolean} punching  true while a recognized punch from this hand is in flight
 */

/**
 * A discrete punch recognized from input.
 * @typedef {Object} PunchInput
 * @property {'left'|'right'} hand
 * @property {'straight'|'hook'|'uppercut'} kind
 * @property {'head'|'body'} target
 * @property {number} power     0..1 (speed of the motion)
 * @property {number} t         ms timestamp of recognition
 * @property {boolean} [atExtension]  true when the punch was recognised AT (or near) FULL EXTENSION — every punch
 *           GestureRecognizer emits (the camera sees the arm out). game/combat.js then makes contact within
 *           COMBAT.atExtensionTravelMs (30 ms) instead of the humanTravelMs out-stroke (100/120/130 ms), which
 *           stays for punches recognised as they begin (keyboard: no flag). Decision D5.
 */

/**
 * @typedef {Object} InputEvent
 * @property {'punch'|'pause'|'confirm'|'back'} type
 * @property {PunchInput} [punch]
 * @property {number} t
 */

/**
 * What one player's input produces each tick.
 * @typedef {{control: ControlState, events: InputEvent[]}} PlayerInput
 */

/**
 * Boxer appearance (original character kit — see src/render/style.js for art direction).
 * @typedef {Object} Appearance
 * @property {string} skin        hex color
 * @property {{style:string, color:string}} hair   style ∈ APPEARANCE_OPTIONS.hairStyles
 * @property {string} eyes        ∈ APPEARANCE_OPTIONS.eyes
 * @property {string} brows       ∈ APPEARANCE_OPTIONS.brows
 * @property {string} mouth       ∈ APPEARANCE_OPTIONS.mouths
 * @property {string} nose        ∈ APPEARANCE_OPTIONS.noses
 * @property {string} accessory   ∈ APPEARANCE_OPTIONS.accessories
 * @property {string} top         hex (tank top / singlet color; 'none' for bare torso)
 * @property {string} trunks      hex
 * @property {string} trim        hex (waistband / piping)
 * @property {string} gloves      hex
 * @property {string} shoes       hex
 * @property {'slim'|'average'|'heavy'} build
 * @property {number} height      0.9..1.1 scale
 */

export const APPEARANCE_OPTIONS = Object.freeze({
  hairStyles: ['buzz', 'crew', 'spiky', 'mohawk', 'bun', 'ponytail', 'afro', 'curly', 'bald', 'flat-top', 'bob', 'cornrows'],
  eyes: ['dot', 'oval', 'sleepy', 'fierce', 'wide', 'happy', 'narrow'],
  brows: ['flat', 'arched', 'angry', 'thick', 'none', 'worried'],
  mouths: ['smile', 'grin', 'flat', 'smirk', 'open', 'gritted'],
  noses: ['button', 'round', 'long', 'none'],
  accessories: ['none', 'headband', 'shades', 'moustache', 'beard', 'mouthguard', 'bandage', 'earring', 'goggles'],
  builds: ['slim', 'average', 'heavy'],
  skinTones: ['#f6d7c3', '#eec1a0', '#d9a07a', '#b97a52', '#8d5a3b', '#5e3b26'],
  hairColors: ['#1d1a19', '#4a2f22', '#8a5a33', '#d8b26a', '#b8432f', '#e9e4dc', '#3b5bdb', '#e64980'],
});

/**
 * Snapshot of one boxer for rendering/HUD (produced by game/, consumed by render/ and ui/).
 * @typedef {Object} BoxerView
 * @property {string} id                 'p1' | 'p2'
 * @property {string} name
 * @property {boolean} isHuman
 * @property {Appearance} appearance
 * @property {string} phase              BoxerPhase
 * @property {number} phaseProgress      0..1 progress through the current phase (for animation)
 * @property {number} hp01               0..1 current health
 * @property {number} stamina01          0..1 (optional use)
 * @property {'none'|'high'|'low'} guard
 * @property {{x:number,y:number,z:number}} lean  -1..1 each, boxer-perspective (+x = boxer's right, -y = duck, +z = toward opponent)
 * @property {{left: HandState, right: HandState}} hands   glove targets (boxer perspective)
 * @property {null|{hand:string, kind:string, target:string, progress:number, impact:boolean}} punch
 * @property {null|{hand:string, kind:string, target:string, strength:number, age:number, blocked:boolean}} hitReact  most recent incoming hit (age seconds)
 * @property {number} knockdowns         this bout
 * @property {number} roundKnockdowns    this round
 * @property {boolean} counterReady      true during a post-dodge counter window
 * @property {string} expression         'neutral'|'focus'|'hurt'|'dazed'|'ko'|'happy'|'sad'
 * @property {number} [getUp01]          optional, while DOWN: 0..1 how close a human boxer is to rising (HUD "GET UP!" meter)
 * Optional extras filled by game/boxer.js:
 * @property {number} [hp] @property {number} [maxHp] @property {number} [daze01] 0..1 daze meter @property {number} [guardAmount]
 *           (alignment pass: hp is health in WEDGES, 0..maxHp, fractional, with maxHp = 10 — research/mechanics.md §2.6/§2.9)
 * @property {boolean} [dazed] @property {boolean} [stunned] @property {boolean} [taunting] AI showing off (guard down) @property {number} [activity]
 * @property {null|{id:number, hand:string, kind:string, target:string, progress:number, msLeft:number, tell:Object}} [windup]
 *           AI telegraph in progress (progress 0..1). During WINDUP `punch` also describes the coming punch with stage 'windup'.
 * @property {Array<Object>} [punches]   every active punch (≤1 per hand). Punch objects also carry
 *           {id, stage:'windup'|'travel'|'recover', outcome:null|'hit'|'blocked'|'dodged'|'miss', counter, power};
 *           progress goes 0→1 during travel (1 = contact) and back 1→0 during recover.
 * Alignment pass extras (game/boxer.js): punch/punches[] +powerPunch · windup +tellMs, held (cocked and held
 *           while the player leans), powerPunch · [reeling] AI reel with the guard open after a clean hit ·
 *           [covering] AI cover-up (high guard after two quick hits) · [resting] gloves dropped at the round-end hold.
 *           dazed is always false and daze01 always 0 now (no daze), stamina01 always 1 (no stamina).
 * @property {boolean} [tracked]         merge-fix (display only): false while a human's ControlState is not tracked (its hands,
 *           guard and lean then show the stance pose); the renderer holds the last tracked ones over a short dropout.
 *           true for the AI.
 */

/**
 * @typedef {Object} MatchView
 * @property {string} phase             MatchPhase
 * @property {number} phaseTime         seconds since phase began
 * @property {number} round             1-based
 * @property {number} maxRounds
 * @property {number} clockDisplayMs    the round clock as DISPLAYED (may run faster than real time)
 * @property {number} roundRealMsLeft   real milliseconds left in the round
 * @property {null|'p1'|'p2'} downed
 * @property {null|number} count        current referee count 1..10 during knockdown
 * @property {{p1: BoxerView, p2: BoxerView}} boxers
 * @property {null|{text:string, sub?:string, kind:string}} banner
 * @property {null|MatchResult} result
 * @property {'single'|'versus'} mode
 * @property {null|Object} opponent     roster entry in single-player mode
 * @property {null|number} [getUp01]    0..1 get-up meter of a downed HUMAN boxer during the count (null otherwise)
 * @property {null|string} [pausedFrom] phase to return to while PAUSED
 * @property {null|Array} [scorecards]  judges' cards once the decision is in
 * Added for the research/mechanics.md alignment pass:
 * @property {null|{kind:'dodge', dodger:'p1'|'p2', scale:number, t01:number, msLeft:number}} [slowmo]
 *           dodge slow-motion counter window (world ×scale while the dodging human stays real-time)
 * @property {null|{call:string, age:number, round?:number, boxer?:string, winner?:string}} [call]
 *           most recent announcer call (age in seconds) — same payload as Ev.MATCH_CALL
 * @property {boolean} [clockVisible]   false during intros, knockdown stoppages, breaks and outros (the HUD hides the clock)
 * @property {string} [stage]           sub-stage inside the current phase, so cameras/HUD/audio stay in sync (ARCHITECTURE.md §6.4):
 *           INTRO/ROUND_START/BETWEEN: 'arena'|'banner'|'flyin'|'ring'|'fight' · FIGHTING: 'live' · ROUND_END: 'bell'|'hold' ·
 *           KNOCKDOWN: 'fall'|'down-call'|'count'|'ko-call'|'ko-hold' · RECOVERY: 'rise'|'standoff'|'fight' · TUTORIAL steps: see §6.9
 * @property {number} [stageTime]       seconds since `stage` began
 * @property {null|{step:string, index:number, total:number}} [tutorial]  first-bout tutorial step while it runs (§6.9)
 *           game/match.js adds count (successful actions this step: blocks / hits / dodges), holdMs (the step's guard
 *           held continuously) and stepTime (s). While it runs: phase FIGHTING, stage = the step, clockVisible false.
 * @property {number} [worldT]          world clock (ms): the AI corner and the round clock (slower during the dodge slow motion)
 * @property {number} [latencyMs]       camera → game latency used to judge the human's defence
 */

/**
 * @typedef {Object} MatchResult
 * @property {string} id            unique per match (idempotency key for saving)
 * @property {'p1'|'p2'|null} winner   null = draw
 * @property {string} method        ResultMethod
 * @property {number} endRound
 * @property {number} endClockMs
 * @property {Array<{judge:string, p1:number, p2:number}>} scorecards   (decisions only)
 * @property {{p1: BoxerStats, p2: BoxerStats}} stats
 * @property {'single'|'versus'} mode
 * @property {null|string} opponentId
 * @property {null|'unanimous'|'majority'|'split'|'draw'} [decisionType]
 * @property {{p1:number, p2:number}} [knockdowns]   knockdowns suffered in the bout
 * @property {{p1:string, p2:string}} [names]
 * @property {Array<Object>} [rounds]   per-round tallies used by the judges
 * @property {null|Object} [finalBlow]  KO only: the knockdown blow that ended it (MATCH_KNOCKDOWN.blow shape)
 */

/**
 * @typedef {Object} BoxerStats
 * @property {number} thrown
 * @property {number} landed
 * @property {number} blocked     punches this boxer blocked
 * @property {number} dodged      punches this boxer dodged
 * @property {number} counters    counter-punches landed
 * @property {number} damageDealt
 * @property {number} knockdownsScored
 */

/**
 * @typedef {Object} TrainingResult
 * @property {string} id
 * @property {string} kind          TrainingKind
 * @property {number} score
 * @property {string} medal         Medal
 * @property {Object} details       activity-specific breakdown
 * @property {string} participantId profile id
 */

/**
 * Snapshot of a training activity for the renderer / HUD (training/activity.js getView()).
 * @typedef {Object} TrainingView
 * @property {string} kind            TrainingKind
 * @property {string} id              attempt id (= TrainingResult.id)
 * @property {'ready'|'active'|'done'} phase
 * @property {boolean} paused
 * @property {number} timeLeftMs      @property {number} durationMs  @property {number} readyLeftMs
 * @property {number} score           @property {number} combo        (streak shown by the HUD)
 * @property {Array<{id:number, text:string, kind:string, age:number, pos?:number[]}>} popups  age in seconds
 * @property {BoxerView} playerView   the participant's own boxer (ghosted by the renderer)
 * @property {null|TrainingResult} result
 * @property {Object} [bag]           bag practice: swing, strength, drop, fallen bags (see training/bag.js)
 * @property {Object} [trainer]       dodge / mitts: pos, yaw, action, hit reaction, look target
 * @property {Object[]} [balls]       dodging drill: tennis balls (see training/dodge.js)
 * @property {Object[]} [mitts]       target punching: both mitts (see training/mitts.js)
 */

export {};
