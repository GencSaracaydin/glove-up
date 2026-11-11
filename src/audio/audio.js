// AudioEngine — every sound in Glove Up, synthesized live with WebAudio (no samples).
//
//   const audio = new AudioEngine({ bus });   // wires itself to bus events
//   audio.unlock();                           // on the first user gesture (also automatic)
//   audio.setVolume({ master, sfx, music, voice });   // 0..1 sliders
//   audio.playSfx('ui-confirm'); audio.music('menu'); audio.say('Round one!');
//
// What it plays by itself (auto-wiring, see cuesForEvent). Timings follow research/mechanics.md
// §6 "Audio cue moments" (WHEN a sound plays — every sound itself is our own synthesis):
//   MATCH_CALL       the single source of every announcer line (ARCHITECTURE.md §6.4):
//                    'round'/'final-round' → tone under the banner, then "Round two!"/"Final round!";
//                    'fight' → "Fight!" + two rings (round starts AND restarts after knockdowns);
//                    'down' → "Down!"; 'ko' → the KO slam (heavier than any punch) + "Knockout!" +
//                    KO stinger; 'time' → the 0:00 bell; 'decision' → "It goes to the judges!".
//                    Legacy events (ROUND_START / BELL start / KNOCKDOWN / KO) only voice a moment
//                    while no MATCH_CALL has ever been seen, and a call never repeats a moment
//                    that was already voiced (no double voices, no double bells).
//   MATCH_INTRO      crowd starts + cheer, menu music fades
//   MATCH_BELL       start = two rings (same bell as the "Fight!" call, played once), end = three
//                    rings at 0:00, final = rapid five-ring bell
//   MATCH_PUNCH_THROWN quiet swish for the local player's own punches (instant feedback)
//   MATCH_WINDUP     AI tells: effort grunt (tell.grunt) and glove "shing" (tell.glint)
//   MATCH_HIT        layered thump (low sine drop + noise transient + leathery click); distinct
//                    families for a clean hit, a counter (crack + ping) and a heavy hit on the
//                    player (crunch + whump); crowd "ooh" for counters/big shots
//   MATCH_BLOCK      muffled pad          MATCH_DODGE / MATCH_MISS  filtered-noise whoosh
//   MATCH_SLOWMO     time-slow whoosh; the crowd is muffled and pitched down for the window
//   MATCH_DAZED      dizzy chirps + "ooh" MATCH_KNOCKDOWN  gasp → roar, body thud on the canvas
//   MATCH_COUNT      the announcer counts "One" … "Ten" + wood-block tick; the crowd roars ≈1.8 s
//                    after "Ten"
//   MATCH_GETUP      rising whoosh + cheer
//   MATCH_KO         KO state (the slam/voice/stinger come from the 'ko' call)
//   MATCH_DECISION   drum roll           MATCH_RESULT  reveal hit; the result jingle waits for the
//                                        outro's win banner (or plays by itself if no outro starts)
//   RENDER_CUT       'player-hit'/'player-hit-heavy': the impact + a short muffled thud
//   RENDER_OUTRO     wipe → swoosh, replay → slowed ambience + drone, flash → sting, banner → win
//                    fanfare + crowd (relative to the local player), winner → winner sting,
//                    end → results music
//   TRAIN_START/END  training groove on/off, medal jingle (whistle on TRAIN_EVENT 'go' / 'time-up')
//   TRAIN_EVENT      bag thump, chain snap + bag fall, ball throw (builds until it arrives) / pop,
//                    dodge swish, mitts up, mitt smack, trainer "oof" … (TRAIN_EVENT_RULES)
//   TRAIN_SCORE      point chime for dodges / mitt hits / bonuses, down-bwomp for penalties
//   APP_PAUSE/RESUME duck crowd + music, cancel speech   APP_SCREEN  menu music on menu screens
//   SETTINGS_CHANGED volumes        INPUT_TRACKING_LOST  alert tone during an activity
//
// Mix: category buses (sfx, crowd, music, voice; crowd follows the Effects slider) →
// master → glue compressor → limiter → soft clipper (nothing can exceed ±0.985) → tab-hidden
// mute → speakers. A small generated arena reverb is fed by per-sound sends. The context is
// suspended while the tab is hidden (music/crowd silent, timers idle). Short-lived nodes are
// disconnected when their sound ends (synth.js Voice).
//
// Spec notes: UI03 (hits, guards and misses have distinguishable sounds; round/result
// transitions are also shown on screen, sound is never the only cue), MAT01/MAT03 (bells, count),
// MAT04 (one result jingle per MATCH_RESULT), TRN01/TRN02 (training sounds, medal jingles),
// ERR02 (tracking-lost alert), SES01 (pause ducks the arena).

import { Ev } from '../core/types.js';
import {
  SFX, SFX_NAMES, crowdReaction, drumRoll, slowDrone, getResources, makeSoftClipCurve, volumeToGain,
  clamp, clamp01, num, makeRng, smoothstep, jit, rand,
} from './synth.js';
import { MusicPlayer, LookaheadScheduler, isLoop, isStinger, MUSIC_NAMES, MUSIC_TUNING, STINGERS, stingerLength } from './music.js';

// ───────────────────────────── tunables ─────────────────────────────

/** Every audio knob in one place (seconds unless the name says ms). */
export const AUDIO_TUNING = Object.freeze({
  // ── mix ──
  masterTrim: 0.72,            // pre-compressor trim (glue + limiter add ≈ +4 dB of make-up gain)
  busLevel: Object.freeze({ sfx: 1, crowd: 0.85, music: 0.5, voice: 0.9 }),
  reverbReturn: 0.3,
  volumeCurve: 1.6,            // slider → gain exponent (synth.volumeToGain)
  defaultVolumes: Object.freeze({ master: 0.8, sfx: 0.9, music: 0.6, voice: 0.9 }),
  glue: Object.freeze({ threshold: -10, knee: 10, ratio: 2, attack: 0.008, release: 0.2 }),
  limiter: Object.freeze({ threshold: -2.5, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }),
  clipHeadroom: 2,             // soft clipper handles ±2 before hard-limiting at 0.985
  // ── voices / rate limits ──
  maxVoices: 56,               // concurrent one-shot sounds before low-priority ones are dropped
  minGapMs: Object.freeze({
    'ui-hover': 45, 'ui-move': 30, 'ui-dwell-tick': 60, swish: 40, 'count-tick': 120, 'score-up': 30,
    'score-down': 60, 'ui-deny': 90, 'ui-alert': 2500, grunt: 120, glint: 120, 'counter-ready': 150,
    whoosh: 30, dodge: 40, block: 25, 'voice-blip': 40, 'time-slow': 250, 'time-resume': 150, 'cut-thud': 90,
    'round-tone': 500, 'ko-slam': 1000, 'outro-wipe': 300, 'flash-sting': 300,
  }),
  lowPriority: Object.freeze(['ui-hover', 'ui-move', 'ui-dwell-tick', 'swish', 'score-up', 'glint', 'counter-ready']),
  // ── combat cues ──
  punchPan: 0.24,              // stereo offset of a straight punch's impact (hooks × hookPanMul)
  hookPanMul: 1.6,
  versusPan: 0.3,              // split screen: sounds sit on the defender's half
  throwSwish: true,            // quiet swish when the local player's punch registers
  counterReadyCue: true,       // soft "ting" when the local player dodges fresh (counter window open; not for a held posture)
  windupGrunt: true,           // AI tell.grunt → effort grunt …
  gruntAt: 0.12,               // … this far into the wind-up
  windupGlint: true,           // AI tell.glint → "shing" …
  glintAt: 0.45,               // … in sync with the renderer's glint (RENDER_TUNING.glintAt)
  bigHitPower: 0.85,           // power at/above which a clean hit gets a crowd "ooh"
  comboOoh: 4,                 // combo length that gets an "ooh"
  knockdownThudSec: Object.freeze({ head: 1.25, body: 1.15 }), // body meets canvas: ≈0.7 s knockdown hit-stop + the fall (§2.8, §3.1)
  koOnKnockdown: 4,            // the bout's 4th knockdown is always a KO (§3.4): its blow also gets the KO boom (0 = off)
  koBlowBoomGain: 0.55,
  countTo: 10,                 // the count's last number ("Ten" = KO)
  koRoarAfterTen: 1.8,         // the crowd roars this long after "Ten" (§6 "Audio cue moments")
  koRoarFallbackSec: 0.15,     // MATCH_KO without a ten-count → roar this soon
  maxHp: 10,                   // MATCH_HIT.hpBefore/hpAfter are in wedges of 10 (§2.6)
  // ── announcer ──
  voice: Object.freeze({
    rate: 1.05, countRate: 1.2, pitch: 0.82, level: 1,
    // preferred system voices (first match wins; any English voice otherwise)
    preferred: Object.freeze([/Daniel/i, /Google UK English Male/i, /\bAlex\b/i, /Aaron/i, /Arthur/i, /\bFred\b/i,
      /Microsoft (Guy|Davis|Andrew|Christopher|Eric|Roger|Brian|Ryan|David|Mark)/i, /\bMale\b/i]),
    failuresBeforeBeeps: 2,
    settleMs: 1500,            // wait this long for the voice list before deciding speech is unavailable
    maxDuckMs: 4000,           // safety: release the speech duck even if 'end' never fires
  }),
  sayFight: true,              // "Fight!" is spoken with its bell (every round start and every restart)
  fightBellDelay: 0.22,        // the bell follows the call by this much
  introLine: false,            // "A versus B!" at MATCH_INTRO (off: the bout goes VS card → arena → the round call, §1.2)
  introSayDelay: 0.7,
  /** Announcer calls. Ev.MATCH_CALL is the single source (ARCHITECTURE.md §6.4); each moment is voiced once. */
  calls: Object.freeze({
    roundVoiceDelay: 0.2,      // the banner tone sounds at the call; the spoken round call follows as its chord lands
                               //   (measured: round call 3.5–4 s before "Fight!", tone ≈ 3.95 s before — §6, M 25:24.46 / 55:18.0;
                               //   game/match.js draws banner → "Fight!" from 3.55–4.55 s, so the call lands ≈ 3.35–4.35 s, mean 3.85)
    koVoiceDelay: 0.25,        // "Knockout!" right after the KO slam
    koStingerDelay: 0.1,       // the KO stinger's timpani roll runs under the call; its chord lands ≈1.3 s later (≈ the logo wipe)
    timeVoice: false,          // also say "Time!" at 0:00 (the reference only rings the bell there)
    // Fallbacks for a match that emits no Ev.MATCH_CALL (legacy events voice the moment themselves):
    roundFallbackSec: 1.0,     // MATCH_ROUND_START → round call, unless a 'round' call arrives first
    downFallbackSec: 0.9,      // MATCH_KNOCKDOWN → "Down!" (measured blow → "Down": median 0.9 s, §3.1)
    koFallbackSec: 1.3,        // MATCH_KO ("Ten") → the KO moment (measured "10" → "KO": median 1.3 s, §3.1)
    koCallWaitSec: 3.0,        // a match that does emit calls: MATCH_KO waits this long for its 'ko' call
    staleSec: 1.5,             // a deferred announcer cue this late (stalled or hidden tab) is dropped, never played late
    // the same moment is voiced/rung once: a repeat within this window (s) is ignored. Duplicates come
    // in the same tick (a call + its MATCH_BELL) or as a late call after a fallback, so the windows
    // stay short enough for genuine back-to-back moments (?fast=1: "Fight!" → knockdown → "Fight!" ≈ 2.2 s)
    dedupeSec: Object.freeze({ round: 8, fight: 1.2, down: 1.5, ko: 30, decision: 30, bell: 1.2 }),
  }),
  betweenSting: false,         // 'between-rounds' jingle after the 0:00 bell (off: the break is bell → banner tone → round call, §1.2)
  betweenStingDelay: 1.7,
  rollSec: 4.2,                // decision drum roll (cut short by MATCH_RESULT)
  // ── dodge slow motion (Ev.MATCH_SLOWMO, ARCHITECTURE.md §6.3, mechanics.md §2.5) ──
  slowmo: Object.freeze({
    defaultMs: 750,            // window length when the event carries none
    whooshMaxSec: 0.7,         // the time-slow whoosh never outlasts this
    crowdRate: 0.55,           // crowd bed playback rate inside the window (pitched down ≈ 10 semitones)
    crowdCutoff: 650,          // … and muffled below this (Hz)
    formant: 0.72,             // the crowd's voices slide down with it
    attackSec: 0.04,           // time constant into the warp
    releaseSec: 0.14,          // … and back out
    resumeSwish: true,         // a soft upward swish when real time resumes
  }),
  // ── player-hit camera cut (Ev.RENDER_CUT 'player-hit' | 'player-hit-heavy', mechanics.md §6) ──
  cut: Object.freeze({
    thudDelay: 0.03,           // the muffled thud lands just after the cut
    impactWaitSec: 0.12,       // no MATCH_HIT on that player within this → the cut plays the impact itself
    impactWindowSec: 0.35,     // a MATCH_HIT on that player this recent already was the impact
  }),
  // ── bout outro (Ev.RENDER_OUTRO stages, ARCHITECTURE.md §6.5, mechanics.md §6 "KO outro, in order") ──
  outro: Object.freeze({
    waitSec: 2.5,              // MATCH_RESULT → wait this long for RENDER_OUTRO 'start' before playing the result jingle itself
    seenWaitSec: 4,            // … once this engine has seen an outro (we know one is coming)
    resultWindowSec: 60,       // the result jingle plays once per bout
    replayWhooshSec: 1.2,      // deep time-slow whoosh as the replay starts
    replayRate: 0.45,          // slowed ambience under the replay: crowd playback rate …
    replayCutoff: 520,         // … low-pass (Hz) …
    replayFormant: 0.65,       // … and voice colour
    replayAttackSec: 0.3,
    replayReleaseSec: 0.6,
    replayMaxSec: 40,          // safety: the slowed ambience and drone end by themselves after this
    drone: 0.22,               // replay drone level (a bed under the replay, below the crowd)
    winnerStingDelay: 0.05,
    resultsFadeIn: 1.6,        // results music fade-in
    crowdFadeSec: 2.5,         // the crowd fades away under the results music
  }),
  resultsMusic: true,          // results loop after the result jingle (outro 'end', or after the jingle when there is no outro)
  resultsAfterJingle: 0.3,
  trainEndJingleDelay: 1.3,
  bagFallSec: 0.45,            // a broken-off bag hits the floor (≈ free fall from its chain height)
  dedupeStingers: Object.freeze(['medal-none', 'medal-bronze', 'medal-silver', 'medal-gold', 'medal-platinum', 'victory', 'defeat', 'draw', 'pro']),
  jingleDedupeSec: 8,          // same jingle requested twice within this window plays once
  speechDuck: Object.freeze({ crowd: 0.55, music: 0.6, sfx: 1, voice: 1 }),
  pauseDuck: Object.freeze({ crowd: 0.3, music: 0.5, sfx: 0.7, voice: 1 }),
  hiddenFadeSec: 0.06,
  suspendWhenHiddenMs: 150,
  // ── crowd ──
  crowd: Object.freeze({
    // excitement baseline per match phase (matches the renderer's crowd animation)
    phaseBase: Object.freeze({
      idle: 0.25, intro: 0.6, roundStart: 0.5, fighting: 0.3, knockdown: 0.9, recovery: 0.6, roundEnd: 0.45,
      between: 0.3, decision: 0.55, ko: 0.95, result: 0.85, paused: 0.2,
    }),
    boost: Object.freeze({ hit: 0.05, hitPower: 0.1, counter: 0.18, block: 0.015, dodge: 0.04, dazed: 0.15, knockdown: 0.6, ko: 0.8 }),
    decayPerSec: 0.55,         // boost decay rate
    maxBoost: 0.8,
    tension: 0.18,             // extra excitement while someone is hurt (× missing hp)
    murmur: Object.freeze([0.16, 0.42]),  // bed gain = a + b·e^1.3
    babble: Object.freeze([0.09, 0.2]),   // talkers gain = a + b·e
    applause: 0.32,            // × smoothstep(0.45, 1, e)
    tone: Object.freeze([700, 3000]),     // low-pass cutoff = a + b·e^1.4 (excited crowds are brighter)
    blipRate: Object.freeze([0.35, 4.5]), // individual shouts per second = a + b·e²
    fadeIn: 1.2,
    fadeOut: 1.5,
  }),
  reactGapSec: Object.freeze({ ooh: 0.9, cheer: 1.2, roar: 1.5, gasp: 0.6, aww: 1.2, shout: 0, whistle: 0 }),
});

/** Which category bus each SFX plays on (default 'sfx'). */
export const SFX_BUS = Object.freeze({ 'voice-blip': 'voice', 'count-beep': 'voice' });

export const CROWD_REACTIONS = Object.freeze(['ooh', 'cheer', 'roar', 'gasp', 'aww']);

/** Every name playSfx() accepts: SFX recipes plus musical jingles (stingers). */
export const SOUND_NAMES = Object.freeze([...SFX_NAMES, ...MUSIC_NAMES.filter((n) => isStinger(n))]);

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const HUB_SCREENS = new Set(['title', 'mode', 'profiles', 'training-select', 'opponent', 'records']);
const MENU_SCREENS = new Set([...HUB_SCREENS, 'settings', 'help', 'camera-setup', 'calibrate', 'profile-editor']);

// ───────────────────────────── pure mapping helpers ─────────────────────────────

/** The announcer's count word for 1..10 ('One' … 'Ten'). */
export function numberWord(n) {
  const k = Math.round(num(n, 0));
  return NUMBER_WORDS[k] || String(k);
}

/** Every Ev.MATCH_CALL kind the engine voices or rings. */
export const CALL_KINDS = Object.freeze(['round', 'final-round', 'fight', 'down', 'ko', 'time', 'decision']);

/**
 * The announcer's words for one call (our own wording). null = the call has no spoken line by default.
 * @param {string} call   Ev.MATCH_CALL kind
 * @param {{round?:number, maxRounds?:number, method?:string, timeVoice?:boolean}} [o]
 */
export function callLine(call, { round, maxRounds, method, timeVoice = false } = {}) {
  switch (call) {
    case 'final-round': return 'Final round!';
    case 'round': return roundLine(num(round, 1), maxRounds);
    case 'fight': return 'Fight!';
    case 'down': return 'Down!';
    case 'ko': return method === 'TKO' ? 'Technical knockout!' : 'Knockout!';
    case 'time': return timeVoice ? 'Time!' : null;
    case 'decision': return 'It goes to the judges!';
    default: return null;
  }
}

/** Make arbitrary text safe and short for speech synthesis. */
export function speechText(text) {
  return String(text ?? '').replace(/[^\p{L}\p{N}\s.,!?'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * Stereo position of a punch's impact as heard by the local player (behind their own boxer).
 * Their own right hand lands right of centre; the opponent faces them, so the opponent's right
 * lands on the left. Split-screen versus: the sound sits on the defender's half (P1 left).
 */
export function punchPan(attacker, hand, kind, { local = 'p1', versus = false, T = AUDIO_TUNING } = {}) {
  if (versus) return (attacker === 'p1' ? 1 : -1) * T.versusPan;
  const hs = hand === 'right' ? 1 : -1;
  const sign = attacker === local ? hs : -hs;
  return clamp(sign * T.punchPan * (kind === 'hook' ? T.hookPanMul : 1), -0.9, 0.9);
}

/** Announcer line for a round start. */
export function roundLine(round, maxRounds) {
  const r = Math.round(num(round, 1));
  if (num(maxRounds, 0) > 1 && r === Math.round(maxRounds)) return 'Final round!';
  return `Round ${numberWord(r).toLowerCase()}!`;
}

/** Announcer line for MATCH_RESULT (KOs were already called by the 'ko' call → null). */
export function resultLine(r, names = {}) {
  if (!r || typeof r !== 'object') return null;
  if (!r.winner || r.method === 'draw') return "It's a draw!";
  if (r.method !== 'decision') return null;
  const n = speechText(r.names?.[r.winner] || names?.[r.winner] || '');
  return n ? `The winner, by decision: ${n}!` : 'We have a winner, by decision!';
}

/** Which result jingle the local player hears. */
export function resultJingle(r, { local = 'p1', mode } = {}) {
  if (!r || typeof r !== 'object') return null;
  if (!r.winner) return 'draw';
  if ((r.mode || mode) === 'versus') return 'victory';
  return r.winner === local ? 'victory' : 'defeat';
}

/** Medal → jingle name. */
export const medalJingle = (medal) => (['bronze', 'silver', 'gold', 'platinum'].includes(medal) ? `medal-${medal}` : 'medal-none');

const S = (name, opts, delay) => ({ type: 'sfx', name, opts: opts || {}, delay: delay || 0 });
const SAY = (text, opts, delay) => ({ type: 'say', text, opts: opts || {}, delay: delay || 0 });

// ── reusable cue groups (each announcer/bell moment is a {type:'once', key} group: played once) ──

/** Tone under the "Round N" banner, then the spoken round call (+ a crowd lift). */
function roundCallCues(r, maxRounds, final, T) {
  const fin = !!final || (num(maxRounds, 0) > 1 && r === Math.round(maxRounds));
  return [
    S('round-tone', { final: fin }),
    SAY(fin ? callLine('final-round') : callLine('round', { round: r, maxRounds }), { interrupt: true }, T.calls.roundVoiceDelay),
    { type: 'react', kind: 'cheer', amount: 0.45, delay: 0.1 },
  ];
}

/** The start bell — rung once per "Fight!" moment, whichever of Ev.MATCH_CALL 'fight' / MATCH_BELL 'start' comes first. */
const startBell = (T) => ({ type: 'once', key: 'bell:start', window: T.calls.dedupeSec.bell, cues: [S('bell', { rings: 2, spacing: 0.3 }, T.sayFight ? T.fightBellDelay : 0)] });

/** The bell at 0:00 (three rings) or the final bell (five quick rings), rung once. */
const endBell = (final, T) => ({ type: 'once', key: 'bell:end', window: T.calls.dedupeSec.bell, cues: [S('bell', final ? { rings: 5, spacing: 0.2 } : { rings: 3, spacing: 0.3 })] });

/** "Fight!" + its bell: every round start and every restart after a knockdown. */
function fightMoment(T) {
  const cues = [];
  if (T.sayFight) cues.push(SAY(callLine('fight'), { interrupt: true }));
  cues.push(startBell(T));
  return { type: 'once', key: 'fight', window: T.calls.dedupeSec.fight, cues };
}

/** The KO call: a slam heavier than any punch, "Knockout!" and the KO stinger. */
function koMomentCues(method, T) {
  return [
    S('ko-slam'),
    SAY(callLine('ko', { method }), { interrupt: true }, T.calls.koVoiceDelay),
    { type: 'stinger', name: 'ko', delay: T.calls.koStingerDelay },
  ];
}

/** Results music (+ the crowd fading away under it), optionally after `delay` s. */
function resultsMusicCues(T, delay = 0) {
  if (!T.resultsMusic) return [];
  const cues = [{ type: 'music', name: 'results', opts: { fadeIn: T.outro.resultsFadeIn } }, { type: 'crowd', on: false, fade: T.outro.crowdFadeSec }];
  return delay > 0 ? [{ type: 'later', delay, cues }] : cues;
}

/** The result moment (outro win banner, or MATCH_RESULT without an outro): jingle relative to the local player + crowd. */
function resultMomentCues(r, { local, mode, T, music = false }) {
  const versus = (r?.mode || mode) === 'versus';
  const jingle = resultJingle(r, { local, mode });
  const won = !!r?.winner && (versus || r.winner === local);
  const out = [];
  if (jingle) out.push({ type: 'stinger', name: jingle });
  out.push({ type: 'react', kind: !r?.winner ? 'cheer' : won ? 'roar' : 'cheer', amount: !r?.winner ? 0.6 : won ? 0.95 : 0.7, delay: 0.15 });
  out.push({ type: 'excite', add: 0.25 });
  if (music) out.push(...resultsMusicCues(T, (jingle && STINGERS[jingle] ? stingerLength(STINGERS[jingle]) : 0) + T.resultsAfterJingle));
  return out;
}

/**
 * Ev.MATCH_CALL → cues. The call is the single source of the announcer: each moment is a 'once'
 * group, so a legacy event that already voiced it (or a repeated call) never doubles it.
 * Payload: {call:'round'|'final-round'|'fight'|'down'|'ko'|'time'|'decision', round?, boxer?, winner?, method?}
 */
function callCues(p, st, T) {
  const K = T.calls, out = [{ type: 'calls' }];
  const max = num(st.maxRounds, 0);
  switch (p.call) {
    case 'round':
    case 'final-round': {
      // the banner may show during the break, before MATCH_ROUND_START: without a round number, it is the next round
      const between = st.phase === 'roundEnd' || st.phase === 'between';
      const r = Number.isFinite(p.round) ? Math.max(1, Math.round(p.round))
        : p.call === 'final-round' && max > 0 ? max : Math.max(1, Math.round(num(st.round, 1)) + (between ? 1 : 0));
      out.push({ type: 'phase', phase: 'roundStart' }, { type: 'once', key: `round:${r}`, window: K.dedupeSec.round, cues: roundCallCues(r, max, p.call === 'final-round', T) });
      return out;
    }
    case 'fight':
      out.push({ type: 'phase', phase: 'fighting' }, { type: 'cancel', prefix: 'round:' }, fightMoment(T));
      return out;
    case 'down':
      out.push({ type: 'once', key: 'down', window: K.dedupeSec.down, cues: [SAY(callLine('down'), { interrupt: true })] });
      return out;
    case 'ko':
      out.push({ type: 'phase', phase: 'ko' }, { type: 'once', key: 'ko', window: K.dedupeSec.ko, cues: koMomentCues(p.method || st.koMethod, T) });
      return out;
    case 'time': {
      const r = Number.isFinite(p.round) ? p.round : num(st.round, 1);
      out.push(endBell(max > 0 && r >= max, T));
      const line = callLine('time', { timeVoice: K.timeVoice });
      if (line) out.push(SAY(line, { interrupt: true }));
      return out;
    }
    case 'decision':
      out.push({ type: 'once', key: 'decision', window: K.dedupeSec.decision, cues: [SAY(callLine('decision'), { interrupt: true })] });
      return out;
    default:
      return out;
  }
}

/**
 * Ev.RENDER_OUTRO {stage, winner, method} → cues (ARCHITECTURE.md §6.5; mechanics.md §6 "KO outro,
 * in order"): wipe → swoosh; replay → slowed ambience (deep time-slow whoosh, crowd pitched down and
 * muffled, a low drone); flash → sting; banner → the win fanfare + crowd (relative to the local
 * player, played once per bout); winner → winner sting; end → results music.
 */
function outroCues(p, st, T, { local, mode }) {
  const O = T.outro;
  const r = {
    winner: p.winner !== undefined ? p.winner : st.result ? st.result.winner : null,
    method: p.method ?? st.result?.method,
    mode: st.result?.mode || mode,
  };
  const versus = r.mode === 'versus';
  const replayOff = [{ type: 'warp', id: 'replay', on: false, release: O.replayReleaseSec }, { type: 'drone', on: false }];
  const result = { type: 'once', key: 'result', window: O.resultWindowSec, cues: resultMomentCues(r, { local, mode, T }) };
  const out = [{ type: 'outro', stage: p.stage }];
  switch (p.stage) {
    case 'start':
      out.push({ type: 'cancel', key: 'result' }, { type: 'phase', phase: 'result' });
      break;
    case 'wipe':
      out.push(S('outro-wipe'));
      break;
    case 'replay':
      out.push(
        S('time-slow', { deep: true, dur: O.replayWhooshSec }),
        { type: 'warp', id: 'replay', on: true, dur: O.replayMaxSec, rate: O.replayRate, cutoff: O.replayCutoff, formant: O.replayFormant, attack: O.replayAttackSec, release: O.replayReleaseSec },
        { type: 'drone', on: true, dur: O.replayMaxSec },
      );
      break;
    case 'flash':
      out.push(S('flash-sting'), ...replayOff);
      break;
    case 'banner':
      out.push(...replayOff, result);
      break;
    case 'winner': {
      const won = !!r.winner && (versus || r.winner === local);
      out.push({ type: 'once', key: 'winner', window: O.resultWindowSec, cues: [{ type: 'stinger', name: won ? 'winner' : 'winner-soft', delay: O.winnerStingDelay }] });
      break;
    }
    case 'end':
      out.push(...replayOff, result, ...resultsMusicCues(T));
      break;
    default:
      break;
  }
  return out;
}

/** Stereo position of a training prop: `side` ('left'|'right', the player's), a world `pos` (+X = the player's right) or a hand. */
const sidePan = (p, k = 0.3) => {
  if (p.side === 'left' || p.side === 'right') return p.side === 'right' ? k : -k;
  if (Array.isArray(p.pos) && Number.isFinite(p.pos[0])) return clamp(p.pos[0] * 0.8, -0.7, 0.7);
  if (p.hand === 'left' || p.hand === 'right') return p.hand === 'right' ? k * 0.5 : -k * 0.5;
  return 0;
};

/**
 * Training event type → sounds (TRN01). The training module emits: go, time-up, bag-new, bag-hit,
 * bag-miss, bag-break, ball-throw, ball-dodge, ball-hit, target-up, target-expire, mitt-absorb,
 * glove-miss, mitt-hit, trainer-hit. Types are matched by pattern (first match wins), so close
 * variants ('mitts-up', 'ball-miss', 'double-hit', 'chain-snap' …) sound right too.
 */
export const TRAIN_EVENT_RULES = Object.freeze([
  [/^go$|^start$/, () => [S('whistle', { pattern: 'start' })]],
  [/^times?-?(up|over)$/, () => [S('whistle', { pattern: 'end' }), { type: 'flag', name: 'trainTimeUp', value: true }]],
  [/chain|snap|break/, (p) => [S('chain-snap', { pan: sidePan(p) }), S('bag-fall', { pan: sidePan(p) }, AUDIO_TUNING.bagFallSec)]],
  [/fall|drop|land/, (p) => [S('bag-fall', { pan: sidePan(p) })]],
  [/(new|next|spawn|enter|arrive|swap|hang).*bag|bag.*(new|next|spawn|enter|arrive|swap|hang)/, () => [S('chain-rattle')]],
  [/expire|timeout|lower|retract/, () => []],
  [/throw|toss|launch|serve|pitch/, (p) => [S('ball-throw', { pan: sidePan(p), dur: num(p.arriveInMs, 450) / 1000 })]],
  [/trainer|penalty|foul|ouch/, () => [S('mitt-smack', { gain: 0.7, power: 0.5 }), S('trainer-oof', {}, 0.04)]],
  [/ball.*(hit|bonk|struck|contact|smack|tag)|(hit|bonk|struck|tag).*ball|player-hit|got-hit|hit-player/, (p) => [S('ball-hit', { pan: sidePan(p) })]],
  [/dodge|avoid|evade|duck|slip|ball-?miss|whizz/, (p) => [S('dodge-swish', { dir: num(p.dir, 1) })]],
  [/absorb|catch|cushion/, (p) => [S('block', { power: 0.35, gain: 0.75, pan: sidePan(p) })]],
  [/miss|whiff/, (p) => [S('whoosh', { gain: 0.55, pan: sidePan(p) })]],
  [/(double|both).*(hit|punch|smack)|(hit|punch|smack).*(double|both)/, (p) => [S('mitt-smack', { power: num(p.power, 0.8), pan: -0.25 }), S('mitt-smack', { power: num(p.power, 0.8), pan: 0.25 }, 0.05), S('combo', {}, 0.08)]],
  [/double|both/, () => [S('mitt-up', { pan: -0.3 }), S('mitt-up', { pan: 0.3 }, 0.06)]],
  [/(mitt|pad|target).*(up|raise|show|present|ready|appear)|(up|raise|show|present|ready|appear).*(mitt|pad|target)/, (p) => [S('mitt-up', { pan: sidePan(p) })]],
  [/mitt|pad|target/, (p) => [S('mitt-smack', { power: num(p.power, 0.7), pan: sidePan(p) })]],
  [/bag|thump/, (p) => [S('bag-thump', { power: num(p.power, 0.6) * (p.meet ? 1.1 : 1), pan: sidePan(p, 0.25) })]],
  [/hit|punch|strike|smack/, (p) => [S(p.kind === 'bag' ? 'bag-thump' : p.kind === 'mitts' ? 'mitt-smack' : 'ball-hit', { power: num(p.power, 0.6) })]],
  [/combo|streak|bonus/, () => [S('combo')]],
  [/countdown|tick/, () => [S('count-tick')]],
  [/whistle/, () => [S('whistle', { pattern: 'short' })]],
]);

/** Cues for one TRAIN_EVENT payload ({kind, type, …}). */
export function trainEventCues(p = {}) {
  const type = String(p?.type ?? '').toLowerCase();
  if (!type) return [];
  for (const [re, make] of TRAIN_EVENT_RULES) if (re.test(type)) return make(p || {});
  return [];
}

/**
 * TRAIN_SCORE reason → sound. Dodges and mitt hits get a point chime; bonuses a two-note combo
 * chime; ordinary bag hits stay quiet (the thump already says it); penalties go "bwomp".
 */
export const TRAIN_SCORE_SOUNDS = Object.freeze({
  dodge: ['score-up', 0], 'mitt-hit': ['score-up', 3], 'bag-meet': ['score-up', 5],
  'mitt-double': ['combo'], 'bag-complete': ['combo'], 'bag-hit': null,
});

/**
 * Pure event → cue mapping (the whole "what does this event sound like" table).
 * Announcer and bell moments come out as {type:'once', key, window, cues} groups so the engine
 * plays each moment exactly once whichever event announces it first (Ev.MATCH_CALL, or a legacy
 * event while no call has ever been seen — st.calls); legacy events that should wait for a call
 * use {type:'fallback', key, delay, window, cues}.
 * @param {string} name   Ev.* event name
 * @param {object} payload
 * @param {{local?:'p1'|'p2', mode?:'single'|'versus', phase?:string, activity?:string|null,
 *          lastHitTarget?:{p1?:string, p2?:string}, names?:object, rollActive?:boolean, T?:object,
 *          calls?:boolean, round?:number, maxRounds?:number, knockdowns?:{p1?:number, p2?:number},
 *          koMethod?:string, result?:object|null, outroActive?:boolean, outroSeen?:boolean}} [st]
 * @returns {Array<object>} cues: {type:'sfx', name, opts, delay} | {type:'react', kind, amount, delay} |
 *   {type:'say', text, opts, delay} | {type:'music', name, opts, delay?} | {type:'stinger', name, delay, dedupe} |
 *   {type:'crowd', on, fade?} | {type:'roll', on} | {type:'phase', phase, next?} | {type:'excite', add} |
 *   {type:'activity', value, mode?} | {type:'hp', id, hp01} | {type:'lastHit', id, target} |
 *   {type:'names', names} | {type:'pause', on} | {type:'screen', screen} | {type:'volume', volumes} | {type:'reset'} |
 *   {type:'once', key, window, cues} | {type:'fallback', key, delay, window, cues, stale?} | {type:'later', delay, cues} |
 *   {type:'mark', key} | {type:'cancel', key?, prefix?} | {type:'calls'} | {type:'round', round, maxRounds} |
 *   {type:'kd', id, count} | {type:'koMethod', method} | {type:'result', result} | {type:'outro', stage} |
 *   {type:'warp', id, on, dur?, rate?, cutoff?, formant?, attack?, release?} | {type:'drone', on, dur?}
 */
export function cuesForEvent(name, payload, st = {}) {
  const T = st.T || AUDIO_TUNING;
  const K = T.calls;
  const p = payload && typeof payload === 'object' ? payload : {};
  const local = st.local === 'p2' ? 'p2' : 'p1';
  const versus = (p.mode || st.mode) === 'versus';
  const mine = (id) => (versus ? id === 'p1' || id === 'p2' : id === local);
  const B = T.crowd.boost;
  switch (name) {
    // ── match ──
    case Ev.MATCH_INTRO: {
      const out = [
        { type: 'reset' },
        { type: 'activity', value: 'match', mode: p.mode === 'versus' ? 'versus' : 'single' },
        { type: 'names', names: { p1: p.p1Name, p2: p.p2Name } },
        { type: 'pause', on: false },
        { type: 'music', name: null, opts: { fadeOut: 1.2 } },
        { type: 'crowd', on: true },
        { type: 'phase', phase: 'intro' },
        { type: 'react', kind: 'cheer', amount: 0.85, delay: 0.15 },
      ];
      const a = speechText(p.p1Name), b = speechText(p.p2Name);
      if (T.introLine && a && b) out.push(SAY(`${a} versus ${b}!`, {}, T.introSayDelay));
      return out;
    }
    case Ev.MATCH_ROUND_START: {
      const r = Math.max(1, Math.round(num(p.round, 1))), max = num(p.maxRounds, num(st.maxRounds, 0));
      const out = [{ type: 'round', round: r, maxRounds: max }, { type: 'phase', phase: 'roundStart' }];
      // no MATCH_CALL seen yet: call the round ourselves, unless its 'round' call arrives first
      if (!st.calls) out.push({ type: 'fallback', key: `round:${r}`, delay: K.roundFallbackSec, window: K.dedupeSec.round, cues: roundCallCues(r, max, false, T) });
      return out;
    }
    case Ev.MATCH_CALL:
      return callCues(p, st, T);
    case Ev.MATCH_BELL: {
      // (a round call still waiting is pointless once "Fight!" is called — compressed timings, ?fast=1)
      if (p.kind === 'start') return [{ type: 'phase', phase: 'fighting' }, { type: 'cancel', prefix: 'round:' }, st.calls ? startBell(T) : fightMoment(T)];
      if (p.kind === 'end') {
        const out = [
          endBell(false, T),
          { type: 'phase', phase: 'roundEnd', next: { phase: 'between', after: 2.4 } },
          { type: 'react', kind: 'cheer', amount: 0.5, delay: 0.4 },
        ];
        if (T.betweenSting) out.push({ type: 'stinger', name: 'between-rounds', delay: T.betweenStingDelay });
        return out;
      }
      // 'final' — after a KO, or at the end of the last round (a decision follows)
      const out = [endBell(true, T)];
      if (st.phase !== 'ko' && st.phase !== 'result') out.push({ type: 'phase', phase: 'roundEnd' }, { type: 'react', kind: 'cheer', amount: 0.6, delay: 0.4 });
      return out;
    }
    case Ev.MATCH_PUNCH_THROWN:
      if (!T.throwSwish || !mine(p.attacker)) return [];
      return [S('swish', { pan: punchPan(p.attacker, p.hand, p.kind, { local, versus, T }) * 0.6 })];
    case Ev.MATCH_WINDUP: {
      if (mine(p.attacker)) return [];
      const ms = num(p.windupMs, 450) / 1000;
      const pan = clamp((p.attacker === local ? 1 : -1) * (p.hand === 'right' ? 1 : -1) * 0.3, -0.6, 0.6);
      const out = [];
      if (T.windupGrunt && p.tell?.grunt) out.push(S('grunt', { pan, pitch: p.kind === 'uppercut' ? 112 : 128 }, ms * T.gruntAt));
      if (T.windupGlint && p.tell?.glint) out.push(S('glint', { pan }, ms * T.glintAt));
      return out;
    }
    case Ev.MATCH_HIT: {
      const power = clamp01(num(p.power, 0.6)), counter = !!p.counter, ko = !!p.knockdown, heavy = !!p.heavy;
      const perspective = versus ? null : p.defender === local ? 'taken' : p.attacker === local ? 'dealt' : null;
      const boxer = p.defender === 'p1' || p.defender === 'p2';
      const out = [
        S('hit', {
          power: ko ? Math.max(power, 0.9) : heavy ? Math.max(power, 0.8) : power, target: p.target, counter, knockdown: ko, heavy,
          kind: p.kind, perspective, pan: punchPan(p.attacker, p.hand, p.kind, { local, versus, T }),
        }),
        { type: 'excite', add: B.hit + B.hitPower * power + (counter || heavy ? B.counter : 0) },
        { type: 'lastHit', id: p.defender, target: p.target === 'body' ? 'body' : 'head' },
      ];
      if (boxer) out.push({ type: 'mark', key: `impact:${p.defender}` }); // the camera cut on this hit must not add a second impact
      const hp01 = Number.isFinite(p.hp01) ? p.hp01 : Number.isFinite(p.hpAfter) ? p.hpAfter / num(p.maxHp, T.maxHp) : null;
      if (boxer && hp01 !== null) out.push({ type: 'hp', id: p.defender, hp01: clamp01(hp01) });
      // the bout's 4th knockdown is always a KO (§3.4): that blow is the KO blow — add the KO boom
      if (ko && T.koOnKnockdown > 0 && boxer && num(st.knockdowns?.[p.defender], 0) + 1 >= T.koOnKnockdown) out.push(S('ko-boom', { gain: T.koBlowBoomGain }, 0.02));
      if (ko) out.push({ type: 'react', kind: 'gasp', amount: 0.9 });
      else if (counter) out.push({ type: 'react', kind: 'ooh', amount: 0.85, delay: 0.05 });
      else if (heavy || power >= T.bigHitPower || num(p.combo, 0) >= T.comboOoh) out.push({ type: 'react', kind: 'ooh', amount: heavy ? 0.7 : 0.5, delay: 0.08 });
      return out;
    }
    case Ev.MATCH_BLOCK:
      return [
        S('block', { power: num(p.power, 0.5) + (num(p.chip, 0) > 0 ? 0.1 : 0), pan: punchPan(p.attacker, p.hand, p.kind, { local, versus, T }) }),
        { type: 'excite', add: B.block },
      ];
    case Ev.MATCH_DODGE: {
      const pan = punchPan(p.attacker, p.hand, p.kind, { local, versus, T });
      const out = [S('dodge', { pan, dir: pan >= 0 ? -1 : 1 }), { type: 'excite', add: B.dodge }];
      // only a fresh dodge opens the counter window (R2): a held posture's dodge carries fresh:false and no cue
      if (T.counterReadyCue && !versus && p.defender === local && p.fresh !== false) out.push(S('counter-ready', {}, 0.07));
      return out;
    }
    case Ev.MATCH_MISS: {
      const pan = punchPan(p.attacker, p.hand, p.kind, { local, versus, T });
      return [S('whoosh', { pan, dir: pan >= 0 ? -1 : 1, power: num(p.power, 0.6) })];
    }
    case Ev.MATCH_SLOWMO: {
      // a successful dodge opened the slow-motion counter window: time-slow whoosh, then the crowd
      // is muffled and pitched down until real time resumes (§2.5, ARCHITECTURE.md §6.3)
      const S2 = T.slowmo, dur = clamp(num(p.durationMs, S2.defaultMs) / 1000, 0.2, 3);
      const pan = versus ? (p.dodger === 'p2' ? T.versusPan : p.dodger === 'p1' ? -T.versusPan : 0) : 0;
      const out = [
        S('time-slow', { dur: Math.min(S2.whooshMaxSec, dur), pan }),
        { type: 'warp', id: 'dodge', on: true, dur, rate: S2.crowdRate, cutoff: S2.crowdCutoff, formant: S2.formant, attack: S2.attackSec, release: S2.releaseSec },
      ];
      if (S2.resumeSwish) out.push(S('time-resume', { pan }, dur));
      return out;
    }
    case Ev.MATCH_DAZED:
      return [S('dazed'), { type: 'react', kind: 'ooh', amount: 0.6 }, { type: 'excite', add: B.dazed }];
    case Ev.MATCH_KNOCKDOWN: {
      const target = st.lastHitTarget?.[p.downed] === 'body' ? 'body' : 'head';
      const count = Math.round(num(p.count, num(st.knockdowns?.[p.downed], 0) + 1));
      const out = [
        { type: 'phase', phase: 'knockdown' },
        { type: 'excite', add: B.knockdown },
        { type: 'kd', id: p.downed, count },
        { type: 'react', kind: 'roar', amount: 1, delay: 0.3 },
        S('thud', { power: 1, pan: versus ? (p.downed === 'p1' ? -T.versusPan : T.versusPan) : 0 }, T.knockdownThudSec[target]),
      ];
      if (!st.calls) out.push({ type: 'fallback', key: 'down', delay: K.downFallbackSec, window: K.dedupeSec.down, cues: [SAY(callLine('down'), { interrupt: true })] });
      return out;
    }
    case Ev.MATCH_COUNT: {
      const n = Math.round(num(p.n, 0));
      if (n < 1) return [];
      const out = [S('count-tick'), SAY(`${numberWord(n)}!`, { interrupt: true, kind: 'count', n })];
      if (n === 1) out.push({ type: 'cancel', key: 'down' }); // the count started: a late "Down!" would talk over it
      if (n >= T.countTo) out.push({ type: 'once', key: 'roar:ko', window: K.dedupeSec.ko, cues: [{ type: 'react', kind: 'roar', amount: 1, delay: T.koRoarAfterTen }] });
      return out;
    }
    case Ev.MATCH_GETUP: {
      // health after rising (crowd tension): the event's hp in wedges, else the refill 10 − 2k (§3.3)
      const k = Math.max(1, Math.round(num(p.knockdown, num(st.knockdowns?.[p.downed], 1))));
      const hp = Number.isFinite(p.hp) ? p.hp : T.maxHp - 2 * k;
      return [
        { type: 'cancel', key: 'down' },
        { type: 'phase', phase: 'recovery', next: { phase: 'fighting', after: 1.6 } },
        { type: 'hp', id: p.downed, hp01: clamp01(hp / T.maxHp) },
        S('getup'),
        { type: 'react', kind: 'cheer', amount: mine(p.downed) ? 1 : 0.75, delay: 0.1 },
      ];
    }
    case Ev.MATCH_KO: {
      const ko = koMomentCues(p.method, T);
      return [
        { type: 'phase', phase: 'ko' },
        { type: 'excite', add: B.ko },
        { type: 'koMethod', method: p.method },
        // the roar normally follows "Ten" (MATCH_COUNT); a KO without a ten-count roars right away
        { type: 'fallback', key: 'roar:ko', delay: T.koRoarFallbackSec, window: K.dedupeSec.ko, cues: [{ type: 'react', kind: 'roar', amount: 1 }] },
        // the slam + "Knockout!" belong to the 'ko' call; without calls, play them at the measured "10" → "KO" gap
        { type: 'fallback', key: 'ko', delay: st.calls ? K.koCallWaitSec : K.koFallbackSec, window: K.dedupeSec.ko, cues: ko },
      ];
    }
    case Ev.MATCH_DECISION:
      return [{ type: 'phase', phase: 'decision' }, { type: 'roll', on: true }];
    case Ev.MATCH_RESULT: {
      const out = [{ type: 'roll', on: false }, { type: 'phase', phase: 'result' }, { type: 'result', result: p }];
      const line = resultLine(p, st.names);
      if (line) out.push(SAY(line, {}, 0.3));
      // the jingle belongs to the outro's win banner (RENDER_OUTRO 'banner'); if no outro starts
      // within the wait, play it here (and the results music after it)
      if (!st.outroActive) {
        const wait = (st.outroSeen ? T.outro.seenWaitSec : T.outro.waitSec) + (st.rollActive ? 0.35 : 0);
        out.push({ type: 'fallback', key: 'result', delay: wait, window: T.outro.resultWindowSec, stale: T.outro.resultWindowSec, cues: resultMomentCues(p, { local, mode: st.mode, T, music: true }) });
      }
      return out;
    }
    // ── render → audio ──
    case Ev.RENDER_CUT: {
      if (p.kind !== 'player-hit' && p.kind !== 'player-hit-heavy') return [];
      const viewer = p.viewer === 'p1' || p.viewer === 'p2' ? p.viewer : local;
      if (!mine(viewer)) return [];
      const heavy = p.kind === 'player-hit-heavy';
      const pan = versus ? (viewer === 'p1' ? -T.versusPan : T.versusPan) : 0;
      return [
        // the impact is MATCH_HIT's; only if none arrives around the cut does the cut play it
        { type: 'fallback', key: `impact:${viewer}`, delay: T.cut.impactWaitSec, window: T.cut.impactWindowSec, cues: [S('hit', { power: heavy ? 0.95 : 0.7, perspective: 'taken', heavy, pan })] },
        S('cut-thud', { heavy, pan }, T.cut.thudDelay),
      ];
    }
    case Ev.RENDER_OUTRO:
      return outroCues(p, st, T, { local, mode: st.mode });
    // ── training ──
    case Ev.TRAIN_START: // the READY countdown begins (the whistle blows at TRAIN_EVENT 'go')
      return [
        { type: 'activity', value: 'training' },
        { type: 'flag', name: 'trainTimeUp', value: false },
        { type: 'pause', on: false },
        { type: 'crowd', on: false },
        { type: 'music', name: 'training', opts: { fadeIn: 0.8 } },
      ];
    case Ev.TRAIN_EVENT:
      return trainEventCues(p);
    case Ev.TRAIN_SCORE: {
      const d = num(p.delta ?? p.applied, 0);
      if (d < 0) return [S('score-down')];
      if (d <= 0) return [];
      const known = Object.prototype.hasOwnProperty.call(TRAIN_SCORE_SOUNDS, p.reason);
      const snd = known ? TRAIN_SCORE_SOUNDS[p.reason] : ['score-up', 0];
      return snd ? [S(snd[0], snd[1] !== undefined ? { step: snd[1] } : {})] : [];
    }
    case Ev.TRAIN_END: {
      const out = [
        { type: 'music', name: null, opts: { fadeOut: 1 } },
        { type: 'stinger', name: medalJingle(p.medal), delay: T.trainEndJingleDelay },
        { type: 'activity', value: null },
      ];
      if (!st.trainTimeUp) out.unshift(S('whistle', { pattern: 'end' })); // ended early (no 'time-up' whistle yet)
      return out;
    }
    // ── app / ui ──
    case Ev.APP_PAUSE:
      return [{ type: 'pause', on: true }];
    case Ev.APP_RESUME:
      return [{ type: 'pause', on: false }];
    case Ev.APP_SCREEN:
      return [{ type: 'screen', screen: p.screen ?? null }];
    case Ev.SETTINGS_CHANGED:
      return p.settings?.volumes ? [{ type: 'volume', volumes: p.settings.volumes }] : [];
    case Ev.INPUT_TRACKING_LOST:
      return st.activity ? [S('ui-alert')] : [];
    default:
      return [];
  }
}

const HANDLED = new Set([
  Ev.MATCH_INTRO, Ev.MATCH_ROUND_START, Ev.MATCH_BELL, Ev.MATCH_PUNCH_THROWN, Ev.MATCH_WINDUP, Ev.MATCH_HIT,
  Ev.MATCH_BLOCK, Ev.MATCH_DODGE, Ev.MATCH_MISS, Ev.MATCH_DAZED, Ev.MATCH_KNOCKDOWN, Ev.MATCH_COUNT,
  Ev.MATCH_GETUP, Ev.MATCH_KO, Ev.MATCH_DECISION, Ev.MATCH_RESULT, Ev.MATCH_CALL, Ev.MATCH_SLOWMO,
  Ev.RENDER_CUT, Ev.RENDER_OUTRO, Ev.TRAIN_START, Ev.TRAIN_EVENT,
  Ev.TRAIN_SCORE, Ev.TRAIN_END, Ev.APP_PAUSE, Ev.APP_RESUME, Ev.APP_SCREEN, Ev.SETTINGS_CHANGED,
  Ev.INPUT_TRACKING_LOST,
].filter(Boolean));

// ───────────────────────────── crowd bed ─────────────────────────────

/**
 * Continuous arena crowd: murmur + formant "talkers" + applause bed, shaped by excitement 0..1.
 * setWarp() slows it down for slow motion: every looping source plays slower (pitched down, the
 * talkers' level wander slows too), the voice formants slide down and the bed is muffled.
 */
class CrowdBed {
  constructor(ctx, out, res, T, rng) {
    this.ctx = ctx;
    this.out = out;
    this.res = res;
    this.C = T.crowd;
    this.rng = rng;
    this.nodes = [];
    this.srcs = [];
    this.formants = [];
    this.e = 0;
    this.warp = { rate: 1, cutoff: Infinity, formant: 1 };
    this.stopped = false;
    const t = ctx.currentTime;
    const gain = (v) => { const g = this._n(ctx.createGain()); g.gain.value = v; return g; };
    const filt = (type, f, q) => { const n = this._n(ctx.createBiquadFilter()); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const formant = (f, q) => { const n = filt('bandpass', f, q); n.__f = f; this.formants.push(n); return n; };
    const pan = (p) => {
      if (typeof ctx.createStereoPanner !== 'function') return gain(1);
      const n = this._n(ctx.createStereoPanner()); n.pan.value = p; return n;
    };
    this.master = gain(0);
    this.master.connect(out.dry);
    if (out.send) { const s = gain(0.22); this.master.connect(s); s.connect(out.send); }
    this.tone = filt('lowpass', 1200, 0);
    this.tone.connect(this.master);
    // murmur: two decorrelated pink-noise beds, band-limited to the "room roar" of voices
    this.murmur = gain(0);
    this.murmur.connect(this.tone);
    for (const [p, rate] of [[-0.6, 0.93], [0.6, 1.07]]) {
      const s = this._src(res.pink, rate), bp = formant(430, 0.55), pn = pan(p);
      s.connect(bp); bp.connect(pn); pn.connect(this.murmur);
    }
    // talkers: vowel formants whose levels wander like many overlapping conversations
    this.babble = gain(0);
    this.babble.connect(this.tone);
    for (const p of [-0.35, 0.35]) {
      const s = this._src(res.pink, 1), pn = pan(p);
      pn.connect(this.babble);
      for (const [f, q] of [[520, 2.2], [1150, 2.8], [2350, 3.5]]) {
        const bp = formant(f * jit(rng, 0.06), q), bg = gain(0.5), depth = gain(0.5);
        const lfo = this._src(res.lfo, rand(rng, 0.6, 1.4));
        s.connect(bp); bp.connect(bg); bg.connect(pn);
        lfo.connect(depth); depth.connect(bg.gain);
      }
    }
    // applause bed (only audible when excited)
    this.clap = gain(0);
    this.clap.connect(this.master);
    this._src(res.applause, 1).connect(this.clap);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(1, t + this.C.fadeIn);
    this.nextBlip = t + 0.6;
  }

  _n(node) { this.nodes.push(node); return node; }

  _src(buffer, rate) {
    const s = this._n(this.ctx.createBufferSource());
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.__rate = rate;
    s.start(this.ctx.currentTime, this.rng() * Math.max(0, (buffer.duration || 1) - 0.05));
    this.srcs.push(s);
    return s;
  }

  /** Low-pass cutoff for the current excitement, capped by an active slow-motion warp. */
  _cutoff() {
    const C = this.C;
    return Math.min(C.tone[0] + C.tone[1] * Math.pow(this.e, 1.4), this.warp.cutoff);
  }

  setExcitement(e, now, tau = 0.35) {
    if (this.stopped) return;
    const C = this.C;
    this.e = clamp01(num(e, 0));
    this.murmur.gain.setTargetAtTime(C.murmur[0] + C.murmur[1] * Math.pow(this.e, 1.3), now, tau);
    this.babble.gain.setTargetAtTime(C.babble[0] + C.babble[1] * this.e, now, tau);
    this.clap.gain.setTargetAtTime(C.applause * smoothstep(0.45, 1, this.e), now, tau * 1.3);
    if (this.warp.cutoff === Infinity) this.tone.frequency.setTargetAtTime(this._cutoff(), now, tau); // a warp owns the tone while it lasts
  }

  /**
   * Slow-motion warp: {rate, cutoff, formant} (rate 1, cutoff Infinity, formant 1 = normal), eased
   * in/out with time constant `tau`.
   */
  setWarp(w, now, tau = 0.1) {
    if (this.stopped) return;
    this.warp = {
      rate: clamp(num(w?.rate, 1), 0.1, 2),
      cutoff: Number.isFinite(w?.cutoff) && w.cutoff > 0 ? w.cutoff : Infinity,
      formant: clamp(num(w?.formant, 1), 0.3, 2),
    };
    const k = Math.max(0.001, num(tau, 0.1));
    for (const s of this.srcs) s.playbackRate.setTargetAtTime(s.__rate * this.warp.rate, now, k);
    for (const f of this.formants) f.frequency.setTargetAtTime(f.__f * this.warp.formant, now, k);
    this.tone.frequency.setTargetAtTime(this._cutoff(), now, k);
  }

  /** Schedule individual fans (shouts, whistles) due before `until`. */
  pump(now, until) {
    if (this.stopped) return;
    if (this.nextBlip < now - 0.5) this.nextBlip = now + 0.05;
    for (let guard = 0; guard < 32 && this.nextBlip < until; guard++) {
      const at = this.nextBlip, e = this.e;
      if (at >= now - 0.02 && this.warp.rate > 0.9) { // no single fans shout through slow motion
        const kind = e > 0.55 && this.rng() < 0.22 ? 'whistle' : 'shout';
        crowdReaction(this.ctx, this.out, at, kind, { amount: 0.45 + 0.55 * e }, this.res);
      }
      const rate = this.C.blipRate[0] + this.C.blipRate[1] * e * e;
      this.nextBlip += -Math.log(1 - this.rng() * 0.98) / rate;
    }
  }

  stop(fade) {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime, d = Math.max(0.05, num(fade, this.C.fadeOut));
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + d);
    const end = t + d + 0.05;
    for (const s of this.srcs) s.stop(end);
    const last = this.srcs[this.srcs.length - 1];
    const cleanup = () => { for (const n of this.nodes) { try { n.disconnect(); } catch { /* gone */ } } this.nodes.length = 0; };
    if (last) last.onended = cleanup; else cleanup();
  }
}

// ───────────────────────────── engine ─────────────────────────────

/**
 * Has the page had a real user activation (click, tap, key press)? true / false, or null when the browser
 * can't tell (no navigator.userActivation). A browser that allows audio without a gesture counts as true.
 * Camera gestures never activate the page.
 */
function userActivated() {
  const nav = globalThis.navigator;
  if (!nav) return null;
  try { if (typeof nav.getAutoplayPolicy === 'function' && nav.getAutoplayPolicy('audiocontext') === 'allowed') return true; } catch { /* ignore */ }
  const ua = nav.userActivation;
  return ua && typeof ua.hasBeenActive === 'boolean' ? ua.hasBeenActive : null;
}

function detectSpeech() {
  const g = globalThis;
  if (g.speechSynthesis && typeof g.SpeechSynthesisUtterance === 'function') return { synth: g.speechSynthesis, Utterance: g.SpeechSynthesisUtterance };
  return null;
}

function pickVolumes(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of ['master', 'sfx', 'music', 'voice']) {
    const x = typeof v[k] === 'string' ? Number(v[k]) : v[k];
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = clamp01(x);
  }
  return out;
}

function mergeTuning(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? { ...base[k], ...v } : v;
  }
  return out;
}

/**
 * The game's audio. Safe to construct anywhere (Node included): nothing touches WebAudio until
 * unlock() runs on a user gesture (Chrome would otherwise warn about autoplay).
 */
export class AudioEngine {
  /**
   * @param {object} [o]
   * @param {import('../core/events.js').EventBus} [o.bus]  auto-wired to match/training/app events
   * @param {BaseAudioContext} [o.context]   use this context (e.g. an OfflineAudioContext for analysis)
   * @param {() => BaseAudioContext} [o.createContext]  factory used by unlock() (default: new AudioContext)
   * @param {boolean} [o.autoWire=true]      subscribe to the bus
   * @param {boolean} [o.autoMusic=true]     menu music on menu screens, training groove in training,
   *                                          silence (crowd) in matches; set false to drive music() yourself
   * @param {boolean} [o.autoCrowd=true]     crowd on at MATCH_INTRO, off on menus / training
   * @param {boolean} [o.autoUnlock=true]    also unlock on the first pointer/key/touch anywhere
   * @param {object} [o.volumes]             initial {master, sfx, music, voice} 0..1
   * @param {'p1'|'p2'} [o.local='p1']       whose perspective result jingles / "hit taken" use
   * @param {number|Function} [o.rng]        seed or () => [0,1) (variation)
   * @param {{synth, Utterance}|null} [o.speech]  speech synthesis (default: window.speechSynthesis)
   * @param {object} [o.timers]              {setTimeout, clearTimeout, setInterval, clearInterval}
   * @param {object} [o.tuning]              overrides for AUDIO_TUNING (shallow per section)
   */
  constructor({ bus = null, context = null, createContext = null, autoWire = true, autoMusic = true, autoCrowd = true,
    autoUnlock = true, volumes = null, local = 'p1', rng = null, speech, timers = null, tuning = null } = {}) {
    this.T = mergeTuning(AUDIO_TUNING, tuning);
    this.rng = makeRng(rng);
    this.timers = timers || globalThis;
    this.opts = { autoMusic: !!autoMusic, autoCrowd: !!autoCrowd, autoWire: !!autoWire };
    this.ctx = null;
    this.res = null;
    this.player = null;
    this.crowd = null;
    this.scheduler = null;
    this.cat = null;
    this.bus = null;
    this._createContext = typeof createContext === 'function' ? createContext : null;
    this._ownsCtx = false;
    this._offline = false;
    this._vol = { ...AUDIO_TUNING.defaultVolumes, ...this.T.defaultVolumes, ...pickVolumes(volumes) };
    this._muted = false;
    this._local = local === 'p2' ? 'p2' : 'p1';
    this._mode = 'single';
    this._phase = 'idle';
    this._phaseNext = null;
    this._boost = 0;
    this._boostT = 0;
    this._ext = null;
    this._hp = { p1: 1, p2: 1 };
    this._names = {};
    this._flags = {};
    this._lastHitTarget = { p1: 'head', p2: 'head' };
    this._activity = null;
    this._paused = false;
    this._hidden = false;
    this._unlocked = false;
    this._musicWanted = null;
    this._crowdWanted = false;
    this._roll = null;
    this._voices = [];
    this._lastPlay = new Map();
    this._lastReact = new Map();
    this._stingers = new Map();
    this._log = [];
    this._pending = new Set();
    this._failed = new Set();
    this._lastE = -1;
    this._lastEAt = -Infinity;
    this._speakingUntil = 0;
    this._speaking = false;
    this._speechFails = 0;
    this._voicesList = [];
    this._voicesSettled = false;
    this._voice = null;
    this._speechWarm = false;
    // announcer / presentation bookkeeping (see cuesForEvent: 'once' / 'fallback' groups)
    this._moments = new Map();   // moment key → engine time (s) it was last voiced/played
    this._deferred = [];         // fallback / later cue lists waiting on the audio clock: {key, at, window, stale, cues}
    this._callsSeen = false;     // sticky: the match emits Ev.MATCH_CALL, so calls own every announcer line
    this._outroSeen = false;     // sticky: the renderer plays bout outros (Ev.RENDER_OUTRO)
    this._outroActive = false;
    this._warps = new Map();     // crowd slow-motion warps by id ('dodge', 'replay'): {until, rate, cutoff, formant, release}
    this._drone = null;          // replay drone {end, stop(at)}
    this._kd = { p1: 0, p2: 0 }; // knockdowns this bout
    this._round = 1;
    this._maxRounds = 0;
    this._koMethod = null;
    this._result = null;
    this._disposed = false;
    this._speech = speech !== undefined ? speech : detectSpeech();
    this._initSpeech();
    this._installVisibility();
    this._autoUnlock = !context && !!autoUnlock;
    if (context) this._adopt(context, false);
    else if (autoUnlock) this._installUnlockListeners();
    if (bus && autoWire) this.attach(bus);
    this._maybeAutoUnlock();
  }

  // ───────────── lifecycle ─────────────

  /**
   * Create/resume the AudioContext. Call from a user gesture (first click/key). Resolves to
   * true when audio is running. Safe to call repeatedly.
   * Without real user activation (e.g. called before any click or key press) it does nothing — the browser
   * would refuse and warn ("The AudioContext was not allowed to start") — and `needsGesture` stays
   * true; the pointerdown / keydown / touchend listeners stay installed until audio runs (D13).
   * @returns {Promise<boolean>}
   */
  unlock() {
    if (this._disposed) return Promise.resolve(false);
    if (!this._offline && !(this.ctx && this.ctx.state === 'running') && userActivated() === false) return Promise.resolve(false);
    if (!this._ensureContext()) return Promise.resolve(false);
    this._unlocked = true;
    this._warmSpeech();
    const ctx = this.ctx;
    if (this._offline) return Promise.resolve(true);
    const done = () => { const ok = ctx.state === 'running'; if (ok) this._onRunning(); return ok; };
    if (ctx.state === 'running') return Promise.resolve(done());
    if (this._hidden || typeof ctx.resume !== 'function') return Promise.resolve(false);
    try { return Promise.resolve(ctx.resume()).then(done, () => false); }
    catch { return Promise.resolve(false); }
  }

  /** Subscribe to a bus (replaces any previous one). */
  attach(bus) {
    this.detach();
    if (!bus || typeof bus.on !== 'function') return;
    this.bus = bus;
    this._off = bus.on('*', (name, payload) => this.handle(name, payload));
  }

  detach() {
    if (this._off) { try { this._off(); } catch { /* ignore */ } }
    this._off = null;
    this.bus = null;
  }

  /** Feed one event by hand (what the bus subscription does). */
  handle(name, payload) {
    if (this._disposed || !HANDLED.has(name)) return;
    this._maybeAutoUnlock();
    let cues;
    try { cues = cuesForEvent(name, payload, this._cueState()); }
    catch (e) { this._fail(`map:${name}`, e); return; }
    this._exec(cues);
  }

  dispose() {
    if (this._disposed) return;
    this.detach();
    this._removeUnlockListeners();
    if (this._onVis && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    for (const id of this._pending) this.timers.clearTimeout(id);
    this._pending.clear();
    this._deferred = [];
    this._cancelSpeech();
    this.scheduler?.stop();
    this._stopDrone(this.ctx ? this.ctx.currentTime : 0);
    if (this.crowd) { this.crowd.stop(0.05); this.crowd = null; }
    this.player?.dispose();
    this._disposed = true;
    if (this.ctx && this._ownsCtx && typeof this.ctx.close === 'function') { try { this.ctx.close(); } catch { /* ignore */ } }
  }

  // ───────────── volume ─────────────

  /** Settings volumes, each 0..1 (missing keys keep their value). */
  setVolume(v) {
    Object.assign(this._vol, pickVolumes(v));
    this._applyVolumes();
  }

  getVolume() { return { ...this._vol }; }

  setMuted(m) {
    this._muted = !!m;
    if (this._muted) this._cancelSpeech();
    this._applyVolumes();
  }

  get muted() { return this._muted; }

  // ───────────── sounds ─────────────

  /**
   * Play a sound effect (or a musical jingle such as 'medal-gold', 'victory', 'pro').
   * @param {string} name   one of SOUND_NAMES
   * @param {{power?:number, pan?:number, gain?:number, delay?:number, target?:string, counter?:boolean, [k:string]:any}} [opts]
   * @returns {boolean} whether it was scheduled
   */
  playSfx(name, opts = {}) {
    if (typeof name !== 'string' || this._disposed) return false;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (isStinger(name)) return this.stinger(name, o);
    if (!SFX[name]) { this._unknown(name); return false; }
    if (!this._canPlay()) return false;
    return this._sfxAt(name, o, this.ctx.currentTime + Math.max(0, num(o.delay, 0)));
  }

  /** Musical one-shot (victory, defeat, draw, between-rounds, ko, medal-*, skill-up/down, pro). */
  stinger(name, { delay = 0, dedupe = true } = {}) {
    if (!isStinger(name) || !this.player || !this._canPlay()) return false;
    const now = this.ctx.currentTime, at = now + Math.max(0, num(delay, 0));
    if (dedupe && this.T.dedupeStingers.includes(name)) {
      const prev = this._stingers.get(name);
      if (prev && Math.abs(at - prev.at) < this.T.jingleDedupeSec) {
        if (prev.at > now + 0.02 && at < prev.at) prev.handle?.cancel(); // an earlier explicit request replaces a pending automatic one
        else return true;
      }
    }
    const handle = this.player.stinger(name, { when: at });
    if (!handle) return false;
    this._stingers.set(name, { at: handle.start, handle });
    this._logPush('stinger', name);
    return true;
  }

  /**
   * Background music: 'menu' | 'training' (loops, crossfaded) | null (fade out). Stinger
   * names play once. Before unlock() the request is remembered and applied when audio starts.
   */
  music(name, opts = {}) {
    if (name != null && !isLoop(name)) {
      if (isStinger(name)) return this.stinger(name, opts || {});
      this._unknown(name);
      return false;
    }
    this._musicWanted = name ?? null;
    if (!this.player) return true;
    if (name == null) this.player.stop(opts || {});
    else this.player.play(name, opts || {});
    this._logPush('music', name ?? 'stop');
    return true;
  }

  /** Name of the loop playing (or requested before unlock), else null. */
  get currentMusic() { return this.player ? this.player.current : this._musicWanted; }

  /** Start the arena crowd ambience (idempotent). */
  startCrowd() {
    this._crowdWanted = true;
    if (!this.ctx || this.crowd || this._disposed) return;
    this.crowd = new CrowdBed(this.ctx, this.cat.crowd, this.res, this.T, this.rng);
    const now = this.ctx.currentTime;
    if (this._warps.size) this.crowd.setWarp(this._warpNow(), now, 0.05);
    this.crowd.setExcitement(this._excitement(now), now, 0.05);
    this._lastE = this.crowd.e;
    this._lastEAt = now;
    this._logPush('crowd', 'start');
  }

  /** Fade the crowd out. */
  stopCrowd({ fade } = {}) {
    this._crowdWanted = false;
    if (!this.crowd) return;
    this.crowd.stop(num(fade, this.T.crowd.fadeOut));
    this.crowd = null;
    this._logPush('crowd', 'stop');
  }

  get crowdRunning() { return !!this.crowd || (!this.ctx && this._crowdWanted); }

  /**
   * One crowd reaction: 'ooh' | 'cheer' | 'roar' | 'gasp' | 'aww' (also 'shout', 'whistle').
   * @returns {boolean}
   */
  crowdReact(kind, { amount = 1, delay = 0 } = {}) {
    if (!this._canPlay()) return false;
    const now = this.ctx.currentTime, at = now + Math.max(0, num(delay, 0));
    const gap = this.T.reactGapSec[kind];
    if (gap === undefined) { this._unknown(`crowd:${kind}`); return false; }
    const last = this._lastReact.get(kind);
    if (gap > 0 && last !== undefined && Math.abs(at - last) < gap) return false;
    const roar = this._lastReact.get('roar');
    if (kind !== 'roar' && kind !== 'gasp' && roar !== undefined && at - roar >= 0 && at - roar < 1.2) return false; // don't stack on a roar
    this._lastReact.set(kind, at);
    try {
      const end = crowdReaction(this.ctx, this.cat.crowd, at, kind, { amount: clamp01(num(amount, 1)) }, this.res);
      this._voices.push({ end, name: `crowd:${kind}` });
      this._logPush('react', kind);
      return true;
    } catch (e) { this._fail(`crowd:${kind}`, e); return false; }
  }

  /** Override the crowd's excitement baseline (0..1); null returns control to the match events. */
  setExcitement(v) {
    this._ext = v == null ? null : clamp01(num(v, 0));
    if (this.ctx) this._control(this.ctx.currentTime, true);
  }

  /** Current crowd excitement 0..1 (phase baseline + decaying boosts). */
  get excitement() { return this._excitement(this.ctx ? this.ctx.currentTime : 0); }

  /** Whose perspective result jingles and "hit taken" sounds use. */
  setLocalPlayer(id) { this._local = id === 'p2' ? 'p2' : 'p1'; }

  /**
   * Announcer line via speech synthesis (a punchy, low, slightly fast voice). Falls back to a
   * formant "gibberish" voice (or pitched count beeps) where speech is unavailable.
   * @param {string} text
   * @param {{interrupt?:boolean, kind?:'announce'|'count', n?:number, delayMs?:number}} [o]
   * @returns {boolean}
   */
  say(text, { interrupt = false, kind = 'announce', n, delayMs = 0 } = {}) {
    const s = speechText(text);
    if (!s || this._disposed) return false;
    if (delayMs > 0) { this._later(delayMs, () => this.say(s, { interrupt, kind, n })); return true; }
    if (this._hidden || this._muted || this._voiceGain() <= 0) return false;
    this._logPush('say', s);
    if (this._speechMode() === 'speech' && this._speak(s, { interrupt, kind })) return true;
    return this._beepSpeak(s, { kind, n });
  }

  /** Schedule music/crowd up to `seconds` ahead of the clock (offline rendering, tests). */
  pump(seconds = MUSIC_TUNING.lookahead) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._pump(now, now + Math.max(0, num(seconds, 0)));
  }

  /** AnalyserNode tapping the final output (dev meters). */
  analyser() {
    if (!this.ctx) return null;
    if (!this._analyser) {
      this._analyser = this.ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this.hideGain.connect(this._analyser);
    }
    return this._analyser;
  }

  /**
   * True while sound can't start until the player clicks, taps or presses a key (browser autoplay rules;
   * camera gestures don't count). The UI shows a "Sound is off" badge meanwhile (D13).
   */
  get needsGesture() {
    if (this._disposed || this._offline || this._hidden) return false;
    if (this.ctx && this.ctx.state === 'running') return false;
    if (!this.ctx && !this._createContext && !(globalThis.AudioContext || globalThis.webkitAudioContext)) return false; // no WebAudio at all
    return userActivated() !== true;
  }

  /** Debug snapshot. */
  state() {
    const ctx = this.ctx;
    return {
      context: ctx ? (this._offline ? 'offline' : ctx.state) : 'none',
      unlocked: this._unlocked, needsGesture: this.needsGesture, hidden: this._hidden, paused: this._paused, muted: this._muted,
      volumes: { ...this._vol }, music: this.currentMusic, crowd: !!this.crowd,
      excitement: Math.round(this.excitement * 100) / 100, phase: this._phase, activity: this._activity,
      local: this._local, mode: this._mode,
      voices: ctx ? this._voices.filter((v) => v.end > ctx.currentTime).length : 0,
      speech: this._speechMode(), voiceName: this._voice ? this._voice.name : null,
      calls: this._callsSeen, outro: this._outroActive ? 'active' : this._outroSeen ? 'seen' : 'none',
      warp: [...this._warps.keys()].join('+') || null, drone: !!this._drone, pendingCues: this._deferred.length,
    };
  }

  /** Recent cues (newest last): {t, kind, name}. */
  get log() { return this._log.slice(); }

  // ───────────── internals: context + graph ─────────────

  _ensureContext() {
    if (this.ctx) return true;
    let ctx = null;
    try {
      if (this._createContext) ctx = this._createContext();
      else {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return false;
        ctx = new AC({ latencyHint: 'interactive' });
      }
    } catch (e) {
      if (!this._failed.has('context')) { this._failed.add('context'); console.warn('[audio] WebAudio is unavailable — the game will be silent', e); }
      return false;
    }
    if (!ctx) return false;
    this._adopt(ctx, true);
    return true;
  }

  _adopt(ctx, owned) {
    this.ctx = ctx;
    this._ownsCtx = owned;
    this._moments.clear(); // the engine clock switches to ctx.currentTime
    this._deferred = [];
    this._offline = typeof ctx.startRendering === 'function';
    this.res = getResources(ctx, this.rng);
    this._buildGraph();
    this.player = new MusicPlayer({ ctx, out: this.cat.music, res: this.res });
    if (this._offline) this._unlocked = true;
    else {
      this.scheduler = new LookaheadScheduler({ now: () => this.ctx.currentTime, pump: (n, u) => this._pump(n, u), timers: this.timers });
      this._onState = () => { if (ctx.state === 'running') this._onRunning(); };
      if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', this._onState);
      if (ctx.state === 'running') this._onRunning();
    }
    // requests made before audio existed
    if (this._crowdWanted) this.startCrowd();
    if (this._musicWanted) this.player.play(this._musicWanted);
  }

  _buildGraph() {
    const ctx = this.ctx, T = this.T;
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const comp = (c) => {
      const n = ctx.createDynamicsCompressor();
      n.threshold.value = c.threshold; n.knee.value = c.knee; n.ratio.value = c.ratio; n.attack.value = c.attack; n.release.value = c.release;
      return n;
    };
    this.hideGain = gain(this._hidden && !this._offline ? 0 : 1);
    this.hideGain.connect(ctx.destination);
    const clipIn = gain(1 / T.clipHeadroom);
    const clip = ctx.createWaveShaper();
    clip.curve = makeSoftClipCurve({ headroom: T.clipHeadroom });
    clipIn.connect(clip);
    clip.connect(this.hideGain);
    const lim = comp(T.limiter);
    lim.connect(clipIn);
    const glue = comp(T.glue);
    glue.connect(lim);
    this.masterGain = gain(this._masterLevel());
    this.masterGain.connect(glue);
    const verb = ctx.createConvolver();
    verb.normalize = true;
    verb.buffer = this.res.impulse();
    const ret = gain(T.reverbReturn);
    verb.connect(ret);
    ret.connect(this.masterGain);
    this.verbIn = gain(1);
    this.verbIn.connect(verb);
    this.cat = {};
    for (const name of ['sfx', 'crowd', 'music', 'voice']) {
      const level = this._catLevel(name) * this._duckFactor(name);
      const dry = gain(level), send = gain(level);
      dry.connect(this.masterGain);
      send.connect(this.verbIn);
      this.cat[name] = { dry, send };
    }
    this.limiter = lim;
    this.glue = glue;
  }

  _masterLevel() {
    return this._muted ? 0 : volumeToGain(this._vol.master, this.T.volumeCurve) * this.T.masterTrim;
  }

  _catLevel(name) {
    const key = name === 'crowd' ? 'sfx' : name;
    return volumeToGain(this._vol[key], this.T.volumeCurve) * num(this.T.busLevel[name], 1);
  }

  _duckFactor(name) {
    let k = 1;
    if (this._speaking) k *= num(this.T.speechDuck[name], 1);
    if (this._paused) k *= num(this.T.pauseDuck[name], 1);
    return k;
  }

  _applyVolumes(tau = 0.04) {
    if (!this.ctx || !this.cat) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(this._masterLevel(), now, tau);
    for (const name of Object.keys(this.cat)) {
      const v = this._catLevel(name) * this._duckFactor(name);
      this.cat[name].dry.gain.setTargetAtTime(v, now, tau);
      this.cat[name].send.gain.setTargetAtTime(v, now, tau);
    }
  }

  _canPlay() {
    if (!this.ctx || !this.cat || this._disposed) return false;
    if (this._offline) return true;
    return this.ctx.state === 'running' && !this._hidden;
  }

  _onRunning() {
    this._removeUnlockListeners();
    if (!this._hidden) this.scheduler?.start();
  }

  /**
   * If the page already has sticky user activation (any earlier real click/key/tap — e.g. before
   * this engine existed), starting audio is allowed, so do it without waiting for another gesture
   * that may never come (a camera player may not touch the keyboard again for a while).
   */
  _maybeAutoUnlock() {
    if (this.ctx || this._disposed || !this._autoUnlock) return;
    if (userActivated() === true) this.unlock();
  }

  _installUnlockListeners() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._unlockHandler = () => { this.unlock(); };
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, this._unlockHandler, { capture: true, passive: true });
  }

  _removeUnlockListeners() {
    if (!this._unlockHandler || typeof window === 'undefined') return;
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.removeEventListener(ev, this._unlockHandler, { capture: true });
    this._unlockHandler = null;
  }

  _installVisibility() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    this._onVis = () => this._setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', this._onVis);
    this._hidden = document.visibilityState === 'hidden';
  }

  /** Tab hidden → fade out, cancel speech, suspend the context; visible → resume + fade in. */
  _setHidden(hidden) {
    if (hidden === this._hidden) return;
    this._hidden = hidden;
    if (!this.ctx || this._offline) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (hidden) {
      this._cancelSpeech();
      this.hideGain.gain.setTargetAtTime(0, now, this.T.hiddenFadeSec / 3);
      this.scheduler?.stop();
      this._later(this.T.suspendWhenHiddenMs, () => {
        if (this._hidden && ctx.state === 'running' && typeof ctx.suspend === 'function') Promise.resolve(ctx.suspend()).catch(() => {});
      });
    } else {
      const fadeIn = () => {
        this.hideGain.gain.setTargetAtTime(1, ctx.currentTime, 0.08);
        if (ctx.state === 'running') this.scheduler?.start();
      };
      if (this._unlocked && ctx.state !== 'running' && typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).then(fadeIn, () => {});
      } else fadeIn();
    }
  }

  // ───────────── internals: scheduling + control ─────────────

  /** Engine clock (s) for moments and deferred cues: the audio clock, or wall time before audio exists. */
  _now() {
    if (this.ctx) return this.ctx.currentTime;
    const perf = globalThis.performance;
    return (perf && typeof perf.now === 'function' ? perf.now() : Date.now()) / 1000;
  }

  _pump(now, until) {
    this.player?.pump(now, until);
    this.crowd?.pump(now, until);
    this._control(now, false);
    this._runDeferred(now);
  }

  /** Run fallback / later cue lists that are due; drop ones that went stale (stall, hidden tab). */
  _runDeferred(now) {
    if (!this._deferred.length) return;
    const due = this._deferred.filter((d) => d.at <= now);
    if (!due.length) return;
    this._deferred = this._deferred.filter((d) => d.at > now);
    for (const d of due) {
      if (now - d.at > num(d.stale, this.T.calls.staleSec)) continue; // never play an announcer cue late
      try {
        if (d.key) this._cue({ type: 'once', key: d.key, window: d.window, cues: d.cues }, now);
        else this._exec(d.cues, now);
      } catch (e) { this._fail(`deferred:${d.key || 'later'}`, e); }
    }
  }

  /** True when moment `key` was voiced/played less than `window` s ago. */
  _recent(key, window) {
    const at = this._moments.get(key);
    if (at === undefined) return false;
    const age = this._now() - at;
    return age >= -0.001 && age < num(window, 2);
  }

  /** Record moment `key` now; it also cancels any fallback still waiting to play that moment. */
  _mark(key) {
    this._moments.set(key, this._now());
    if (this._deferred.length) this._deferred = this._deferred.filter((d) => d.key !== key);
  }

  /** Combined crowd warp of every active slow-motion window (the slowest wins). */
  _warpNow() {
    let rate = 1, cutoff = Infinity, formant = 1;
    for (const w of this._warps.values()) {
      rate = Math.min(rate, num(w.rate, 1));
      cutoff = Math.min(cutoff, Number.isFinite(w.cutoff) ? w.cutoff : Infinity);
      formant = Math.min(formant, num(w.formant, 1));
    }
    return { rate, cutoff, formant };
  }

  _applyWarp(now, tau) {
    if (this.crowd) this.crowd.setWarp(this._warpNow(), now, tau);
  }

  _clearWarps(now, tau = 0.3) {
    if (!this._warps.size) return;
    this._warps.clear();
    this._applyWarp(now, tau);
  }

  _stopDrone(at) {
    if (!this._drone) return;
    try { this._drone.stop(at); } catch { /* gone */ }
    this._drone = null;
  }

  /** Forget the bout: moments, waiting cues, warps, the drone, knockdowns and the result. */
  _resetBout(now) {
    this._moments.clear();
    this._deferred = [];
    this._clearWarps(now, 0.1);
    this._stopDrone(now);
    this._kd = { p1: 0, p2: 0 };
    this._round = 1;
    this._koMethod = null;
    this._result = null;
    this._outroActive = false;
  }

  _boostAt(now) {
    return this._boost * Math.exp(-Math.max(0, now - this._boostT) * this.T.crowd.decayPerSec);
  }

  _excitement(now) {
    const C = this.T.crowd;
    const base = this._ext ?? num(C.phaseBase[this._paused ? 'paused' : this._phase], C.phaseBase.idle);
    const tension = this._phase === 'fighting' ? C.tension * (1 - Math.min(this._hp.p1, this._hp.p2)) : 0;
    return clamp01(base + this._boostAt(now) + tension);
  }

  _control(now, force) {
    if (this._phaseNext && now >= this._phaseNext.at) {
      this._phase = this._phaseNext.phase;
      this._phaseNext = null;
      force = true;
    }
    if (this._speaking && Date.now() > this._speakingUntil) this._setSpeaking(false);
    if (this._warps.size) { // a slow-motion window ran out: ease the crowd back to real time
      let release = 0;
      for (const [id, w] of this._warps) if (now >= w.until) { this._warps.delete(id); release = Math.max(release, num(w.release, 0.15)); }
      if (release > 0) this._applyWarp(now, release);
    }
    if (!this.crowd) return;
    const e = this._excitement(now);
    if (force || Math.abs(e - this._lastE) > 0.012 || now - this._lastEAt > 0.5) {
      this.crowd.setExcitement(e, now);
      this._lastE = e;
      this._lastEAt = now;
    }
  }

  _cueState() {
    return {
      T: this.T, local: this._local, mode: this._mode, phase: this._phase, activity: this._activity,
      lastHitTarget: { ...this._lastHitTarget }, names: { ...this._names }, rollActive: !!this._roll,
      trainTimeUp: !!this._flags.trainTimeUp,
      calls: this._callsSeen, round: this._round, maxRounds: this._maxRounds, knockdowns: { ...this._kd },
      koMethod: this._koMethod, result: this._result, outroActive: this._outroActive, outroSeen: this._outroSeen,
    };
  }

  _exec(cues, at) {
    if (!Array.isArray(cues) || !cues.length) return;
    const now = Number.isFinite(at) ? at : this.ctx ? this.ctx.currentTime : 0;
    for (const c of cues) {
      if (!c || typeof c !== 'object') continue;
      try { this._cue(c, now); } catch (e) { this._fail(`cue:${c?.type}`, e); }
    }
  }

  _cue(c, now) {
    const delay = Math.max(0, num(c.delay, 0));
    switch (c.type) {
      case 'sfx':
        if (this._canPlay() && SFX[c.name]) this._sfxAt(c.name, c.opts || {}, now + delay);
        break;
      case 'react':
        this.crowdReact(c.kind, { amount: c.amount, delay });
        break;
      case 'excite':
        this._boost = Math.min(this.T.crowd.maxBoost, this._boostAt(now) + num(c.add, 0));
        this._boostT = now;
        if (this.ctx) this._control(now, true);
        break;
      case 'phase':
        this._phase = c.phase;
        this._phaseNext = c.next ? { phase: c.next.phase, at: now + num(c.next.after, 1) } : null;
        if (this.ctx) this._control(now, true);
        break;
      case 'say':
        this.say(c.text, { ...(c.opts || {}), delayMs: delay * 1000 });
        break;
      case 'music':
        if (this.opts.autoMusic) this.music(c.name, delay > 0 && this.ctx ? { ...(c.opts || {}), when: now + delay } : c.opts || {});
        break;
      case 'stinger':
        this.stinger(c.name, { delay, dedupe: c.dedupe !== false });
        break;
      case 'crowd':
        if (this.opts.autoCrowd) { if (c.on) this.startCrowd(); else this.stopCrowd({ fade: c.fade }); }
        break;
      // ── moments: each announcer / bell / jingle moment plays once (see cuesForEvent) ──
      case 'once':
        if (!c.key || this._recent(c.key, c.window)) break;
        this._mark(c.key);
        this._exec(c.cues, now);
        break;
      case 'mark':
        if (c.key) this._mark(c.key);
        break;
      case 'cancel': // by key, or every waiting moment whose key starts with `prefix`
        if (this._deferred.length) this._deferred = this._deferred.filter((d) => !(d.key && (d.key === c.key || (c.prefix && d.key.startsWith(c.prefix)))));
        break;
      case 'fallback':
        if (!c.key) break;
        this._deferred = this._deferred.filter((d) => d.key !== c.key);
        this._deferred.push({ key: c.key, at: this._now() + delay, window: c.window, stale: c.stale, cues: c.cues || [] });
        break;
      case 'later':
        this._deferred.push({ key: null, at: this._now() + delay, stale: num(c.stale, Infinity), cues: c.cues || [] });
        break;
      case 'calls':
        this._callsSeen = true;
        break;
      case 'round':
        this._round = Math.max(1, Math.round(num(c.round, this._round)));
        if (num(c.maxRounds, 0) > 0) this._maxRounds = Math.round(c.maxRounds);
        break;
      case 'kd':
        if (c.id === 'p1' || c.id === 'p2') this._kd[c.id] = Math.max(this._kd[c.id], Math.round(num(c.count, this._kd[c.id] + 1)));
        break;
      case 'koMethod':
        this._koMethod = typeof c.method === 'string' ? c.method : null;
        break;
      case 'result':
        this._result = c.result && typeof c.result === 'object' ? { winner: c.result.winner ?? null, method: c.result.method, mode: c.result.mode } : null;
        break;
      case 'outro':
        this._outroSeen = true;
        this._outroActive = c.stage !== 'end';
        break;
      // ── slow motion: the crowd bed is pitched down and muffled while a warp lasts ──
      case 'warp':
        if (!c.id) break;
        if (c.on) {
          this._warps.set(c.id, { until: now + delay + Math.max(0.05, num(c.dur, 1)), rate: c.rate, cutoff: c.cutoff, formant: c.formant, release: num(c.release, 0.15) });
        } else if (!this._warps.delete(c.id)) break;
        this._applyWarp(now + delay, c.on ? num(c.attack, 0.05) : num(c.release, 0.15));
        break;
      case 'drone':
        if (!c.on) { this._stopDrone(now + delay); break; }
        if (this._drone || !this._canPlay()) break;
        try {
          this._drone = slowDrone(this.ctx, this.cat.sfx, now + delay, { dur: num(c.dur, this.T.outro.replayMaxSec), vel: this.T.outro.drone }, this.res);
          this._logPush('sfx', 'replay-drone');
        } catch (e) { this._fail('replay-drone', e); }
        break;
      case 'roll':
        if (c.on) this._startRoll(now + delay); else this._endRoll(now + delay);
        break;
      case 'activity':
        this._activity = c.value ?? null;
        if (c.mode) this._mode = c.mode;
        break;
      case 'hp':
        if (c.id === 'p1' || c.id === 'p2') this._hp[c.id] = clamp01(num(c.hp01, 1));
        break;
      case 'lastHit':
        if (c.id === 'p1' || c.id === 'p2') this._lastHitTarget[c.id] = c.target;
        break;
      case 'names':
        this._names = { ...(c.names || {}) };
        break;
      case 'flag':
        if (typeof c.name === 'string') this._flags[c.name] = c.value;
        break;
      case 'pause':
        this._setPaused(!!c.on);
        break;
      case 'screen':
        this._onScreen(c.screen);
        break;
      case 'volume':
        this.setVolume(c.volumes);
        break;
      case 'reset':
        this._hp = { p1: 1, p2: 1 };
        this._boost = 0;
        this._lastHitTarget = { p1: 'head', p2: 'head' };
        this._endRoll(now, false);
        this._resetBout(now);
        break;
      default:
        break;
    }
  }

  _sfxAt(name, opts, t) {
    const gap = this.T.minGapMs[name];
    if (gap) {
      const last = this._lastPlay.get(name);
      if (last !== undefined && Math.abs(t - last) * 1000 < gap) return false;
    }
    const now = this.ctx.currentTime;
    if (this._voices.length > 16) this._voices = this._voices.filter((v) => v.end > now);
    if (this._voices.length >= this.T.maxVoices && this.T.lowPriority.includes(name)) return false;
    if (this._voices.length >= this.T.maxVoices * 1.5) return false;
    this._lastPlay.set(name, t);
    try {
      const end = SFX[name](this.ctx, this.cat[SFX_BUS[name] || 'sfx'], t, opts, this.res);
      this._voices.push({ end: num(end, t + 1), name });
      this._logPush('sfx', name);
      return true;
    } catch (e) {
      this._fail(name, e);
      return false;
    }
  }

  _startRoll(at) {
    if (this._roll || !this._canPlay()) return;
    try {
      this._roll = drumRoll(this.ctx, this.cat.sfx, at, { dur: this.T.rollSec }, this.res);
      this._logPush('sfx', 'drum-roll');
    } catch (e) { this._fail('drum-roll', e); }
  }

  _endRoll(at, reveal = true) {
    if (!this._roll) return;
    this._roll.stop(at);
    this._roll = null;
    if (reveal && this._canPlay()) this._sfxAt('reveal', {}, at);
  }

  _setPaused(on) {
    if (on === this._paused) return;
    this._paused = on;
    if (on) {
      this._cancelSpeech();
      this._endRoll(this.ctx ? this.ctx.currentTime : 0, false);
      this._deferred = []; // a fallback call must not speak over the pause screen (or late after it)
    }
    this._applyVolumes(0.12);
    if (this.ctx) this._control(this.ctx.currentTime, true);
  }

  _onScreen(screen) {
    if (HUB_SCREENS.has(screen)) {
      // back at a menu hub: no activity is running any more (also covers quitting from pause)
      this._activity = null;
      this._phase = 'idle';
      this._phaseNext = null;
      this._setPaused(false);
      this._endRoll(this.ctx ? this.ctx.currentTime : 0, false);
      this._resetBout(this.ctx ? this.ctx.currentTime : 0); // nothing from the bout may follow us into the menu
    }
    if (MENU_SCREENS.has(screen) && !this._activity) {
      if (this.opts.autoCrowd) this.stopCrowd();
      if (this.opts.autoMusic) this.music('menu');
    }
  }

  _later(ms, fn) {
    const id = this.timers.setTimeout(() => { this._pending.delete(id); if (!this._disposed) fn(); }, ms);
    this._pending.add(id);
    return id;
  }

  _logPush(kind, name) {
    this._log.push({ t: this.ctx ? Math.round(this.ctx.currentTime * 1000) / 1000 : 0, kind, name });
    if (this._log.length > 80) this._log.splice(0, this._log.length - 80);
  }

  _unknown(name) {
    const key = `unknown:${name}`;
    if (this._failed.has(key)) return;
    this._failed.add(key);
    console.debug(`[audio] unknown sound "${name}"`);
  }

  _fail(name, e) {
    if (this._failed.has(name)) return;
    this._failed.add(name);
    console.error(`[audio] "${name}" failed`, e);
  }

  // ───────────── internals: speech ─────────────

  _voiceGain() {
    return volumeToGain(this._vol.voice, this.T.volumeCurve) * volumeToGain(this._vol.master, this.T.volumeCurve);
  }

  _initSpeech() {
    const sp = this._speech;
    if (!sp?.synth) return;
    const load = () => {
      try { this._voicesList = sp.synth.getVoices?.() || []; } catch { this._voicesList = []; }
      this._voice = null;
      if (this._voicesList.length) this._voicesSettled = true;
    };
    load();
    try {
      if (typeof sp.synth.addEventListener === 'function') sp.synth.addEventListener('voiceschanged', () => { load(); this._voicesSettled = true; });
    } catch { /* ignore */ }
    this._later(this.T.voice.settleMs, () => { load(); this._voicesSettled = true; });
  }

  _speechMode() {
    if (!this._speech?.synth) return 'beeps';
    if (this._speechFails >= this.T.voice.failuresBeforeBeeps) return 'beeps';
    if (this._voicesSettled && !this._voicesList.length) return 'beeps';
    return 'speech';
  }

  _pickVoice() {
    if (this._voice) return this._voice;
    const en = this._voicesList.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
    // on-device voices first: with an online voice (Chrome's "Google …", Edge's "… Online") the browser
    // sends every announcer line to a speech service, and the game contacts no host but its own (R5)
    const local = en.filter((v) => v.localService !== false);
    const pool = local.length ? local : en;
    for (const re of this.T.voice.preferred) {
      const m = pool.find((v) => re.test(v.name || ''));
      if (m) return (this._voice = m);
    }
    this._voice = pool.find((v) => /en[-_](US|GB)/i.test(v.lang || '')) || pool[0] || null;
    return this._voice;
  }

  _warmSpeech() {
    // iOS/Safari only allow speech that started inside a user gesture once: speak a silent blank.
    if (this._speechWarm || !this._speech?.synth) return;
    this._speechWarm = true;
    try { const u = new this._speech.Utterance(' '); u.volume = 0; this._speech.synth.speak(u); } catch { /* ignore */ }
  }

  _speak(text, { interrupt, kind }) {
    const { synth, Utterance } = this._speech;
    try {
      if (interrupt) synth.cancel();
      const u = new Utterance(text);
      const v = this._pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      const V = this.T.voice;
      u.rate = kind === 'count' ? V.countRate : V.rate;
      u.pitch = V.pitch;
      u.volume = clamp01(this._voiceGain() * V.level);
      u.onstart = () => this._setSpeaking(true, text);
      u.onend = () => this._setSpeaking(false);
      u.onerror = (e) => {
        this._setSpeaking(false);
        const err = e?.error;
        if (!err || err === 'interrupted' || err === 'canceled') return;
        // 'not-allowed' = no user activation yet: not a broken voice, so it never disables speech
        if (err !== 'not-allowed') this._speechFails++;
        this._beepSpeak(text, { kind });
      };
      synth.speak(u);
      return true;
    } catch {
      this._speechFails++;
      return false;
    }
  }

  _setSpeaking(on, text = '') {
    if (on) this._speakingUntil = Date.now() + Math.min(this.T.voice.maxDuckMs, 600 + text.length * 90);
    if (on === this._speaking) return;
    this._speaking = on;
    this._applyVolumes(on ? 0.05 : 0.25);
  }

  _cancelSpeech() {
    try { this._speech?.synth?.cancel?.(); } catch { /* ignore */ }
    if (this._speaking) this._setSpeaking(false);
  }

  /** Formant syllables (or a pitched beep for counts) on the voice bus. */
  _beepSpeak(text, { kind, n } = {}) {
    if (!this._canPlay()) return false;
    const t = this.ctx.currentTime;
    if (kind === 'count') {
      const k = num(n, NUMBER_WORDS.findIndex((w) => text.toLowerCase().startsWith(w.toLowerCase())));
      return this._sfxAt('count-beep', { n: k > 0 ? k : 1 }, t);
    }
    const syl = (text.toLowerCase().match(/[aeiouy]+/g) || ['a']).slice(0, 10);
    const vmap = { a: 'ah', e: 'eh', i: 'ee', o: 'oh', u: 'oo', y: 'ee' };
    syl.forEach((g, i) => {
      const last = i === syl.length - 1;
      const pitch = 150 * (1.12 - (i / Math.max(1, syl.length)) * 0.25) * (last && /[!?]$/.test(text) ? 1.15 : 1);
      SFX['voice-blip'](this.ctx, this.cat.voice, t + i * 0.13, { vowel: vmap[g[0]] || 'ah', pitch, dur: last ? 0.22 : 0.11 }, this.res);
    });
    this._logPush('sfx', 'voice-blips');
    return true;
  }
}

/**
 * Render sounds offline (browser only) and measure them — used by dev/audio.html to check that
 * nothing clips or is silent. `fn(engine)` schedules sounds at engine.ctx.currentTime or later.
 * The master chain first runs `warmup` seconds of silence: a fresh DynamicsCompressorNode starts
 * in heavy gain reduction for ~0.1 s, which would make the first sound measure far too quiet (in
 * the game the context is long-running, so this only ever touches the click that unlocked audio).
 * @returns {Promise<{buffer: AudioBuffer, engine: AudioEngine, start: number}>} start = when fn ran
 */
export async function renderOffline(fn, { seconds = 3, sampleRate = 48000, volumes, rng = 7, tuning, warmup = 0.25 } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('OfflineAudioContext unavailable');
  const quantum = 128 / sampleRate;
  const start = typeof OAC.prototype.suspend === 'function' ? Math.ceil(Math.max(0, warmup) / quantum) * quantum : 0;
  const ctx = new OAC(2, Math.max(1, Math.round((start + seconds) * sampleRate)), sampleRate);
  const engine = new AudioEngine({ context: ctx, autoUnlock: false, autoWire: false, volumes, rng, speech: null, tuning });
  const schedule = async () => {
    try { await fn(engine); engine.pump(seconds); }
    finally { if (start > 0) ctx.resume(); }
  };
  if (start > 0) {
    const ready = ctx.suspend(start).then(schedule);
    const buffer = await ctx.startRendering();
    await ready;
    return { buffer, engine, start };
  }
  await schedule();
  return { buffer: await ctx.startRendering(), engine, start };
}

