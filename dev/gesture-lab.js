// Gesture Lab — see what the gesture recognizer sees.
//   default      replay a synthetic scenario (src/input/synthetic.js) with ground truth
//   ?live=1      your webcam via src/input/camera.js + src/input/pose-tracker.js
//   ?video=URL   a clip as the camera, e.g. ?video=/dev/clips/facecam-boxing.mp4
// Other params: ?scenario=<id>&seed=&distance=&cam=&punchMs=&noise=&lead=&sens=&speed=&t=<ms>
//               ?depth=clean  a what-if: synthetic world depth much cleaner (≈ 3 mm per frame) than the
//               default (≈ 2 cm — what real MediaPipe output measured on dev/clips/facecam-boxing.mp4 does)
// The body plot marks the dodge lines (research/mechanics.md §2.1: nose ≥ 0.35 SW sideways; back /
// forward an ≈ 11 cm sway of the upper body at any distance); the readout shows the dodge / tutorial
// detections (src/input/tutorial-detect.js),
// whether the world depth is trusted, and (camera / clip) the capture → pose latency.
// window.__lab exposes the recorded samples/events for scripted inspection.
// Offline numbers for many random players: node dev/gesture-lab.bench.mjs

import { LM } from '../src/core/types.js';
import { GestureRecognizer, DEFAULT_TUNING, effectiveTuning } from '../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../src/input/synthetic.js';
import { dodgeDetected, isStance, isGuard } from '../src/input/tutorial-detect.js';

/** ?depth=clean: synthetic world landmarks much cleaner than real MediaPipe output (a what-if; real ≈ the default). */
const CLEAN_DEPTH = { zNoise: 0.006, worldNoise: 0.003, zBias: 0.008 };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MODE = params.get('video') ? 'video' : params.get('live') ? 'live' : 'synthetic';
const COLORS = { X: '#ff6b5a', drive: '#2bb3a3', wy: '#3d7bff', stroke: 'rgba(255, 201, 74, 0.28)', cooldown: 'rgba(111, 120, 158, 0.28)', grid: 'rgba(255, 250, 240, 0.07)', text: '#a9b1d3', paper: '#fffaf0' };

// ───────────────────────────── scenarios ─────────────────────────────
const S = (action, ms, extra = {}) => ({ action, ms, ...extra });
const SCENARIOS = {
  tour: { name: 'Punch tour', steps: () => [S('idle', 1200), S('guard-high', 900), S('jab-left', 1100), S('cross', 1100), S('hook-left', 1100), S('hook-right', 1100), S('uppercut-left', 1100), S('uppercut-right', 1100), S('body-left', 1100), S('body-right', 1100), S('idle', 1000)] },
  combos: { name: 'Fast combos (1-2-1-2)', steps: () => [S('idle', 1200), ...[0, 1, 2].flatMap(() => [S('jab-left', 300), S('cross', 300), S('jab-left', 300), S('cross', 300), S('idle', 1100)])] },
  hooks: { name: 'Hooks & uppercuts', steps: () => [S('idle', 1200), S('hook-left', 1000), S('hook-right', 1000), S('guard-high', 800), S('hook-left', 1000), S('uppercut-right', 1000), S('uppercut-left', 1000), S('guard-low', 900), S('uppercut-right', 1000), S('idle', 900)] },
  body: { name: 'Head vs body', steps: () => [S('idle', 1200), S('jab-left', 1000), S('body-left', 1000), S('cross', 1000), S('body-right', 1000), S('guard-low', 900), S('body-left', 1000), S('body-right', 1000), S('idle', 900)] },
  pullback: { name: 'Pull-backs (must not fire)', steps: () => [S('guard-high', 1200), S('cross', 1500), S('pull-back', 2600, { hand: 'right' }), S('guard-high', 800), S('pull-back', 2600, { hand: 'left' }), S('guard-high', 900)] },
  distract: { name: 'Distractors (must not fire)', steps: () => [S('idle', 1200), S('wave', 2600, { hand: 'right' }), S('idle', 700), S('scratch-face', 2200, { hand: 'left' }), S('idle', 600), S('adjust-glasses', 1400, { hand: 'right' }), S('idle', 600), S('reach-slow', 3000, { hand: 'right' }), S('idle', 700), S('pause', 1800), S('idle', 1200)] },
  dodge: { name: 'Guard & dodge', steps: () => [S('idle', 1200), S('guard-high', 1300), S('lean-left', 900), S('lean-right', 900), S('duck', 900), S('guard-low', 1100), S('lean-forward', 900), S('lean-back', 900), S('idle', 1000), S('walk-away', 2600)] },
  lowbody: { name: 'Low guard: body punches + dip-less uppercuts', steps: () => [S('idle', 1500), S('guard-low', 1500), S('body-left', 1100), S('guard-low', 600), S('body-right', 1100), S('guard-low', 600), S('body-left', 1100), S('idle', 1000), S('uppercut-left', 1100, { dip: false }), S('idle', 600), S('uppercut-right', 1100, { dip: false }), S('idle', 900)] },
  dodges: { name: 'Dodge lines (lean / duck / back / twist)', steps: () => [S('guard-high', 1800), S('lean-left', 1000, { amount: 0.5 }), S('guard-high', 700), S('lean-left', 1000, { amount: 1.3 }), S('guard-high', 700), S('lean-right', 1000, { amount: 1.3 }), S('guard-high', 700), S('duck', 1000, { amount: 1.3 }), S('guard-high', 700), S('lean-back', 1100, { amount: 3.4 }), S('guard-high', 800), S('twist-left', 1100), S('guard-high', 800), S('twist-right', 1100), S('guard-high', 900)] },
  pointing: { name: 'Slow pointing / reaching (must not fire)', steps: () => [S('idle', 1300), S('point', 3000, { hand: 'right' }), S('idle', 800), S('reach-slow', 3200, { hand: 'left' }), S('idle', 800), S('point', 3000, { hand: 'left' }), S('idle', 900)] },
  bout: { name: 'Mixed bout', steps: () => [S('idle', 1000), S('guard-high', 800), S('jab-left', 500), S('cross', 700), S('lean-left', 700), S('hook-right', 900), S('guard-high', 600), S('duck', 800), S('uppercut-left', 900), S('body-right', 900), S('guard-low', 800), S('scratch-face', 1800, { hand: 'left' }), S('jab-right', 800), S('jab-left', 500), S('cross', 900), S('idle', 900)] },
};

// ───────────────────────────── state ─────────────────────────────
const lab = {
  samples: [], events: [], rejects: [], truth: null, duration: 0, cursor: 0, playing: true,
  speed: Number(params.get('speed') || 1), frames: [], recognizer: null, source: null, tLast: 0, fps: 0,
  lastPose: null, lastFrame: null, video: null, notes: [],
};
window.__lab = lab;

function readOptions() {
  return {
    seed: Number($('seed').value) || 1, distance: Number($('distance').value), cameraHeight: Number($('camHeight').value),
    punchMs: Number($('punchMs').value), noise: Number($('noise').value), lead: $('lead').value,
    ...(params.get('depth') === 'clean' ? CLEAN_DEPTH : {}),
  };
}

function makeRecognizer(aspect) {
  const sens = Number($('sens').value);
  return new GestureRecognizer({ tuning: { sensitivity: sens }, aspect });
}

// ───────────────────────────── synthetic source ─────────────────────────────
function buildSynthetic() {
  const id = $('scenario').value;
  const opts = readOptions();
  const sp = makeSyntheticPlayer(opts);
  const seq = sequence(SCENARIOS[id].steps());
  const { frames, truth } = sp.run(seq);
  lab.frames = frames;
  lab.truth = truth;
  lab.duration = frames.length ? frames[frames.length - 1].t : 0;
  lab.cursor = Math.min(Number(params.get('t') || 0), lab.duration);
  // run the whole recognizer pass up-front so the plots show the complete timeline
  const rec = makeRecognizer(640 / 480);
  lab.samples = []; lab.events = []; lab.rejects = [];
  const seenRej = { left: new Set(), right: new Set() };
  for (const fr of frames) {
    const out = rec.update(fr.players[0], fr.t);
    record(rec, out, fr, seenRej);
  }
  lab.recognizer = rec;
  lab.notes = [`${SCENARIOS[id].name}: ${truth.punches.length} punches performed, ${lab.events.filter((e) => e.type === 'punch').length} recognised`];
}

function record(rec, out, fr, seenRej) {
  const d = rec.debug;
  const hs = {};
  for (const h of ['left', 'right']) {
    const x = d.hands[h];
    hs[h] = { X: x.X, drive: x.drive.max, ds: x.drive.straight, dh: x.drive.hook, du: x.drive.up, wy: x.w ? x.w[1] : null, state: x.state };
    for (const r of rec.hands[h].rejects) if (!seenRej[h].has(r)) { seenRej[h].add(r); lab.rejects.push({ t: r.t, hand: h, reason: r.reason, info: r.info }); }
  }
  lab.samples.push({ t: fr.t, vt: fr.vt ?? null, pose: fr.players[0], hands: hs, control: out.control,
    trusted: rec.depthTrusted, depthMm: rec.depthNoiseMm });
  for (const e of out.events) lab.events.push(e);
}

// ───────────────────────────── live / video sources ─────────────────────────────
async function startCameraSource() {
  const notice = $('notice');
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  lab.video = video;
  let camera = null, Tracker = null;
  try {
    camera = await import('../src/input/camera.js');
    ({ PoseTracker: Tracker } = await import('../src/input/pose-tracker.js'));
  } catch (e) {
    notice.hidden = false;
    notice.innerHTML = `<b>Camera input isn't available yet.</b> The live/video lab needs <code>src/input/camera.js</code> and <code>src/input/pose-tracker.js</code> (${e.message}). The synthetic lab works without them — remove <code>?live</code>/<code>?video</code> from the URL.`;
    return;
  }
  try {
    if (MODE === 'video') await camera.openVideoFile(params.get('video'), { video, loop: params.get('loop') !== '0' });
    else await camera.openCamera({ video });
  } catch (e) {
    notice.hidden = false;
    notice.innerHTML = `<b>${MODE === 'video' ? 'The clip' : 'The camera'} could not start.</b> ${e.fullMessage || e.message}`;
    return;
  }
  const tracker = new Tracker({ numPoses: 2, model: params.get('model') === 'lite' ? 'lite' : 'full', delegate: params.get('cpu') ? 'CPU' : 'GPU' });
  notice.hidden = false;
  notice.innerHTML = 'Loading the pose model…';
  try { await tracker.init(); } catch (e) {
    notice.innerHTML = `<b>Pose tracking could not start.</b> ${e.fullMessage || e.message}`;
    return;
  }
  notice.hidden = true;
  if (MODE === 'video') {
    // the clip kept playing while the model loaded: start it over so nothing is missed
    try { video.currentTime = 0; await video.play(); } catch { /* autoplay blocked: the Play button resumes */ }
  }
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  lab.recognizer = makeRecognizer(aspect);
  const seenRej = { left: new Set(), right: new Set() };
  lab.source = {
    tick(now) {
      const frame = tracker.detect(video, now);
      if (!frame) return;
      // the clip/room may contain other people (posters, cutouts): follow the largest person
      let best = null, bestSw = 0;
      for (const p of frame.players) {
        if (!p) continue;
        const a = p.image[LM.LEFT_SHOULDER], b = p.image[LM.RIGHT_SHOULDER];
        const sw = Math.hypot(a.x - b.x, a.y - b.y);
        if (sw > bestSw) { bestSw = sw; best = p; }
      }
      if (best) best.aspect = frame.width / frame.height;
      const out = lab.recognizer.update(best, frame.t);
      record(lab.recognizer, out, { t: frame.t, players: [best], vt: MODE === 'video' ? video.currentTime : null }, seenRej);
      lab.lastFrame = frame;
      if (lab.samples.length > 3000) lab.samples.splice(0, 600);
      const st = tracker.getStats ? tracker.getStats() : null;
      if (st) $('fps').textContent = `${st.fps.toFixed(0)} fps · detect ${st.detectMs.toFixed(0)} ms · ${st.delegate}`
        + (Number.isFinite(st.latencyMs) ? ` · capture→pose ${Math.round(st.latencyMs)} ms (${st.latencySource})` : '');
    },
  };
}

// ───────────────────────────── drawing ─────────────────────────────
const BONES = [[LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST], [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP], [LM.RIGHT_SHOULDER, LM.RIGHT_HIP], [LM.LEFT_HIP, LM.RIGHT_HIP], [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.RIGHT_HIP, LM.RIGHT_KNEE],
  [LM.LEFT_KNEE, LM.LEFT_ANKLE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE], [LM.LEFT_EAR, LM.LEFT_EYE], [LM.RIGHT_EAR, LM.RIGHT_EYE], [LM.LEFT_EYE, LM.NOSE], [LM.RIGHT_EYE, LM.NOSE]];

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { ctx: c.getContext('2d'), w, h, dpr };
}

function drawView(sample) {
  const { ctx, w, h } = fitCanvas($('view'));
  ctx.fillStyle = '#10142a';
  ctx.fillRect(0, 0, w, h);
  if (lab.video && lab.video.readyState >= 2) {
    // mirrored, like a mirror (ARCHITECTURE §1)
    ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);
    const vw = lab.video.videoWidth, vh = lab.video.videoHeight, s = Math.max(w / vw, h / vh);
    ctx.drawImage(lab.video, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
    ctx.restore();
    ctx.fillStyle = 'rgba(16, 20, 42, 0.35)';
    ctx.fillRect(0, 0, w, h);
  } else {
    // floor grid for the synthetic view
    ctx.strokeStyle = COLORS.grid;
    for (let x = 0; x <= w; x += w / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += h / 9) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }
  const pose = sample && sample.pose;
  if (!pose) {
    ctx.fillStyle = COLORS.text; ctx.font = `700 ${Math.round(h / 22)}px Nunito, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(sample ? 'nobody in the picture' : '', w / 2, h / 2);
    return;
  }
  const P = (i) => [(1 - pose.image[i].x) * w, pose.image[i].y * h];   // mirrored
  const vis = (i) => (pose.image[i].visibility ?? 1) >= 0.5;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (!pose.image[a] || !pose.image[b]) continue;
    const isL = [LM.LEFT_ELBOW, LM.LEFT_WRIST].includes(b), isR = [LM.RIGHT_ELBOW, LM.RIGHT_WRIST].includes(b);
    const punching = sample.control.hands[isL ? 'left' : 'right'].punching && (isL || isR);
    ctx.strokeStyle = punching ? '#ffc94a' : isL ? '#3d7bff' : isR ? '#ff4d5e' : 'rgba(255, 250, 240, 0.75)';
    ctx.globalAlpha = vis(a) && vis(b) ? 1 : 0.3;
    ctx.lineWidth = Math.max(3, w / 120);
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const [i, col] of [[LM.LEFT_WRIST, '#3d7bff'], [LM.RIGHT_WRIST, '#ff4d5e']]) {
    const [x, y] = P(i);
    const h2 = i === LM.LEFT_WRIST ? 'left' : 'right';
    const r = (w / 45) * (1 + 0.6 * sample.control.hands[h2].reach);
    ctx.fillStyle = col; ctx.globalAlpha = vis(i) ? 0.95 : 0.35;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // head + label
  const [nx, ny] = P(LM.NOSE);
  ctx.strokeStyle = 'rgba(255,250,240,0.8)'; ctx.lineWidth = Math.max(2, w / 200);
  ctx.beginPath(); ctx.arc(nx, ny, w / 28, 0, Math.PI * 2); ctx.stroke();
  // last punch banner
  const recent = lab.events.filter((e) => e.type === 'punch' && e.t <= sample.t && e.t > sample.t - 450).pop();
  if (recent) {
    ctx.font = `${Math.round(h / 12)}px 'Lilita One', sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = '#ffc94a';
    ctx.fillText(`${recent.punch.hand.toUpperCase()} ${recent.punch.kind}${recent.punch.target === 'body' ? ' · body' : ''}`, w / 2, h * 0.12);
  }
  const p = lab.events.filter((e) => e.type === 'pause' && e.t <= sample.t && e.t > sample.t - 800).pop();
  if (p) { ctx.fillStyle = '#ffc94a'; ctx.font = `${Math.round(h / 10)}px 'Lilita One', sans-serif`; ctx.textAlign = 'center'; ctx.fillText('PAUSE', w / 2, h * 0.5); }
}

function bar(value, lo = 0, hi = 1, centered = false) {
  if (centered) {
    const v = Math.max(-1, Math.min(1, value));
    const left = v < 0 ? 50 + v * 50 : 50, width = Math.abs(v) * 50;
    return `<div class="bar center"><i style="left:${left}%;width:${width}%"></i></div>`;
  }
  const u = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return `<div class="bar"><i style="left:0;width:${u * 100}%"></i></div>`;
}

function drawReadout(sample) {
  if (!sample) return;
  const c = sample.control;
  const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '–');
  const dodge = dodgeDetected(c);
  const hand = (h) => `<div class="kv"><span>${h} glove x / y</span><span>${f(c.hands[h].x)} / ${f(c.hands[h].y)}</span></div>
    <div class="kv"><span>${h} reach${c.hands[h].punching ? ' · PUNCHING' : ''}</span><span>${f(c.hands[h].reach)}</span></div>${bar(c.hands[h].reach)}`;
  const log = lab.events.filter((e) => e.t <= sample.t).slice(-9).reverse().map((e) => e.type === 'punch'
    ? `<div class="punch">${(e.t / 1000).toFixed(2)}s  ${e.punch.hand.padEnd(5)} ${e.punch.kind.padEnd(8)} ${e.punch.target.padEnd(4)} power ${e.punch.power}</div>`
    : `<div class="pause">${(e.t / 1000).toFixed(2)}s  ${e.type}</div>`);
  const rej = lab.rejects.filter((r) => r.t <= sample.t).slice(-4).reverse().map((r) => `<div class="rej">${(r.t / 1000).toFixed(2)}s  ${r.hand.padEnd(5)} ignored: ${r.reason}</div>`);
  $('readout').innerHTML = `
    <div class="kv"><span>tracked</span><span style="color:${c.tracked ? '#2bb3a3' : '#ff4d5e'}">${c.tracked ? 'yes' : 'NO'}</span></div>
    <div class="kv"><span>confidence</span><span>${f(c.confidence)}</span></div>
    <div class="kv"><span>guard</span><span>${c.guard}</span></div>
    <div class="kv"><span>guard amount</span><span>${f(c.guardAmount)}</span></div>
    <div class="wide">${bar(c.guardAmount)}</div>
    <div class="kv"><span>lean x (dodge)</span><span>${f(c.lean.x)}</span></div>
    <div class="kv"><span>lean y (duck)</span><span>${f(c.lean.y)}</span></div>
    <div>${bar(c.lean.x, 0, 0, true)}</div><div>${bar(c.lean.y, 0, 0, true)}</div>
    <div class="kv"><span>lean z (in/out)</span><span>${f(c.lean.z)}</span></div>
    <div class="kv"><span>activity</span><span>${f(c.activity)}</span></div>
    <div>${bar(c.lean.z, 0, 0, true)}</div><div>${bar(c.activity)}</div>
    <div class="kv"><span>dodge</span><span style="color:${dodge ? '#ffc94a' : '#a9b1d3'}">${dodge || '–'}</span></div>
    <div class="kv"><span>stance / guard held</span><span>${isStance(c) ? `${f((c.stanceMs || 0) / 1000, 1)} s` : '–'} / ${c.guard !== 'none' && isGuard(c, c.guard) ? `${f((c.guardMs || 0) / 1000, 1)} s` : '–'}</span></div>
    <div class="kv"><span>world depth</span><span style="color:${sample.trusted ? '#2bb3a3' : '#a9b1d3'}">${sample.trusted ? 'clean' : 'noisy'}${Number.isFinite(sample.depthMm) ? ` · ${f(sample.depthMm, 1)} mm` : ''}</span></div>
    <div class="kv"><span>sensitivity</span><span>${f(lab.recognizer ? lab.recognizer.tuning.sensitivity : 0.5)}</span></div>
    <div>${hand('left')}</div><div>${hand('right')}</div>
    <div class="log">${[...log, ...rej].join('') || '<div class="rej">no events yet</div>'}</div>`;
}

function drawHandPlot(canvasId, hand, t0, t1, tNow) {
  const { ctx, w, h, dpr } = fitCanvas($(canvasId));
  ctx.clearRect(0, 0, w, h);
  const pad = 30 * dpr, top = 6 * dpr, bottom = h - 16 * dpr;
  const X = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad - 6 * dpr);
  // y ranges: X and wrist height share −0.5..1.6 (left axis); drive 0..4 (right, scaled)
  const Y = (v) => bottom - ((v + 0.5) / 2.1) * (bottom - top);
  const YD = (v) => bottom - (Math.min(4, v) / 4) * (bottom - top);
  const samples = lab.samples.filter((s) => s.t >= t0 - 50 && s.t <= t1 + 50);
  // state bands
  for (let i = 1; i < samples.length; i++) {
    const st = samples[i].hands[hand].state;
    if (st === 'ready') continue;
    ctx.fillStyle = st === 'stroke' ? COLORS.stroke : COLORS.cooldown;
    ctx.fillRect(X(samples[i - 1].t), top, Math.max(1, X(samples[i].t) - X(samples[i - 1].t)), bottom - top);
  }
  // grid + thresholds
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = dpr;
  for (const v of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(pad, Y(v)); ctx.lineTo(w, Y(v)); ctx.stroke(); }
  ctx.fillStyle = COLORS.text; ctx.font = `${10 * dpr}px Nunito, sans-serif`; ctx.textAlign = 'right';
  for (const v of [0, 0.5, 1]) ctx.fillText(v.toFixed(1), pad - 4 * dpr, Y(v) + 3 * dpr);
  const T = lab.recognizer ? lab.recognizer.tuning : effectiveTuning(DEFAULT_TUNING);
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.strokeStyle = 'rgba(43, 179, 163, 0.6)';
  ctx.beginPath(); ctx.moveTo(pad, YD(1)); ctx.lineTo(w, YD(1)); ctx.stroke();                     // onset
  ctx.strokeStyle = 'rgba(43, 179, 163, 0.35)';
  ctx.beginPath(); ctx.moveTo(pad, YD(T.minPeakDrive)); ctx.lineTo(w, YD(T.minPeakDrive)); ctx.stroke();   // min peak
  ctx.setLineDash([]);
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(43, 179, 163, 0.85)';
  ctx.fillText('onset', w - 36 * dpr, YD(1) - 3 * dpr);
  // drive area
  ctx.fillStyle = 'rgba(43, 179, 163, 0.25)'; ctx.strokeStyle = COLORS.drive; ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(X(samples[0] ? samples[0].t : t0), YD(0));
  for (const s of samples) ctx.lineTo(X(s.t), YD(s.hands[hand].drive || 0));
  ctx.lineTo(X(samples.length ? samples[samples.length - 1].t : t1), YD(0)); ctx.closePath(); ctx.fill();
  const line = (key, color, map) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr; ctx.beginPath();
    let pen = false;
    for (const s of samples) {
      const v = s.hands[hand][key];
      if (v === null || v === undefined) { pen = false; continue; }
      const xy = [X(s.t), map(v)];
      if (pen) ctx.lineTo(...xy); else ctx.moveTo(...xy);
      pen = true;
    }
    ctx.stroke();
  };
  line('wy', COLORS.wy, Y);
  line('X', COLORS.X, Y);
  // truth (synthetic): triangles at the performed peak
  if (lab.truth) {
    for (const p of lab.truth.punches) {
      if (p.hand !== hand || p.tPeak < t0 || p.tPeak > t1) continue;
      const x = X(p.tPeak);
      ctx.fillStyle = 'rgba(255, 250, 240, 0.8)';
      ctx.beginPath(); ctx.moveTo(x, bottom + 2 * dpr); ctx.lineTo(x - 5 * dpr, bottom + 11 * dpr); ctx.lineTo(x + 5 * dpr, bottom + 11 * dpr); ctx.fill();
      ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.font = `${9 * dpr}px Nunito, sans-serif`;
      ctx.fillText(`${p.kind[0].toUpperCase()}${p.target === 'body' ? 'b' : ''}`, x, bottom + 20 * dpr > h ? bottom - 2 * dpr : bottom + 20 * dpr);
    }
  }
  // recognised punches
  for (const e of lab.events) {
    if (e.type !== 'punch' || e.punch.hand !== hand || e.t < t0 || e.t > t1) continue;
    const x = X(e.t);
    ctx.strokeStyle = '#ffc94a'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = '#ffc94a'; ctx.textAlign = 'left'; ctx.font = `900 ${11 * dpr}px Nunito, sans-serif`;
    ctx.fillText(`${e.punch.kind}${e.punch.target === 'body' ? ' · body' : ''}`, x + 3 * dpr, top + 11 * dpr);
  }
  // rejected strokes
  for (const r of lab.rejects) {
    if (r.hand !== hand || r.t < t0 || r.t > t1) continue;
    const x = X(r.t), y = top + 24 * dpr;
    ctx.strokeStyle = 'rgba(169, 177, 211, 0.85)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x - 4 * dpr, y - 4 * dpr); ctx.lineTo(x + 4 * dpr, y + 4 * dpr); ctx.moveTo(x + 4 * dpr, y - 4 * dpr); ctx.lineTo(x - 4 * dpr, y + 4 * dpr); ctx.stroke();
    ctx.fillStyle = 'rgba(169, 177, 211, 0.85)'; ctx.font = `${9 * dpr}px Nunito, sans-serif`;
    ctx.fillText(r.reason, x + 6 * dpr, y + 3 * dpr);
  }
  // playhead
  if (tNow !== null) { ctx.strokeStyle = 'rgba(255, 250, 240, 0.7)'; ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(X(tNow), top); ctx.lineTo(X(tNow), bottom); ctx.stroke(); }
}

function drawBodyPlot(t0, t1, tNow) {
  const { ctx, w, h, dpr } = fitCanvas($('plotB'));
  ctx.clearRect(0, 0, w, h);
  const pad = 30 * dpr, top = 6 * dpr, bottom = h - 34 * dpr;
  const X = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad - 6 * dpr);
  const Y = (v) => (top + bottom) / 2 - v * (bottom - top) / 2;
  const samples = lab.samples.filter((s) => s.t >= t0 - 50 && s.t <= t1 + 50);
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = dpr;
  for (const v of [-1, 0, 1]) { ctx.beginPath(); ctx.moveTo(pad, Y(v)); ctx.lineTo(w, Y(v)); ctx.stroke(); }
  ctx.fillStyle = COLORS.text; ctx.font = `${10 * dpr}px Nunito, sans-serif`; ctx.textAlign = 'right';
  for (const v of [-1, 0, 1]) ctx.fillText(String(v), pad - 4 * dpr, Y(v) + 3 * dpr);
  // dodge lines: lean x / duck at ±leanDodgeLevelX (nose 0.35 SW), lean z at ±leanDodgeLevelZ (a leanZDodgeM sway)
  const TT = lab.recognizer ? lab.recognizer.tuning : DEFAULT_TUNING;
  ctx.setLineDash([3 * dpr, 5 * dpr]); ctx.lineWidth = dpr;
  for (const [v, col] of [[TT.leanDodgeLevelX, 'rgba(255,107,90,0.55)'], [-TT.leanDodgeLevelX, 'rgba(255,107,90,0.55)'], [TT.leanDodgeLevelZ, 'rgba(199,125,255,0.55)'], [-TT.leanDodgeLevelZ, 'rgba(199,125,255,0.55)']]) {
    ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(pad, Y(v)); ctx.lineTo(w, Y(v)); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,107,90,0.8)';
  ctx.fillText(`dodge ±${TT.leanDodgeLevelX} (0.35 SW)`, pad + 4 * dpr, Y(TT.leanDodgeLevelX) - 3 * dpr);
  ctx.fillStyle = 'rgba(199,125,255,0.8)';
  ctx.fillText(`back/fwd ±${TT.leanDodgeLevelZ} (${Math.round((TT.leanZDodgeM ?? 0.11) * 100)} cm sway)`, pad + 4 * dpr, Y(TT.leanDodgeLevelZ) - 3 * dpr);
  // guard shading
  for (let i = 1; i < samples.length; i++) {
    const g = samples[i].control.guard;
    if (g === 'none') continue;
    ctx.fillStyle = g === 'high' ? 'rgba(61, 123, 255, 0.16)' : 'rgba(255, 77, 94, 0.14)';
    ctx.fillRect(X(samples[i - 1].t), top, Math.max(1, X(samples[i].t) - X(samples[i - 1].t)), bottom - top);
  }
  const line = (get, color, width = 2) => {
    ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.beginPath();
    samples.forEach((s, i) => { const v = get(s); if (i) ctx.lineTo(X(s.t), Y(v)); else ctx.moveTo(X(s.t), Y(v)); });
    ctx.stroke();
  };
  line((s) => s.control.guardAmount, 'rgba(255, 250, 240, 0.45)', 1.5);
  line((s) => s.control.activity, 'rgba(255, 201, 74, 0.7)', 1.5);
  line((s) => s.control.lean.z, '#c77dff');
  line((s) => s.control.lean.y, '#2bb3a3');
  line((s) => s.control.lean.x, '#ff6b5a');
  // dodges (the bout's thresholds)
  for (let i = 1; i < samples.length; i++) {
    const d = dodgeDetected(samples[i].control);
    if (!d || dodgeDetected(samples[i - 1].control) === d) continue;
    ctx.fillStyle = '#ffc94a'; ctx.font = `800 ${10 * dpr}px Nunito, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(`▲ ${d}`, X(samples[i].t), bottom - 6 * dpr);
  }
  // tracking loss
  for (const s of samples) if (!s.control.tracked) { ctx.fillStyle = 'rgba(255, 77, 94, 0.5)'; ctx.fillRect(X(s.t), bottom - 3 * dpr, 2 * dpr, 3 * dpr); }
  ctx.textAlign = 'left'; ctx.font = `700 ${10 * dpr}px Nunito, sans-serif`;
  const legend = [['lean x', '#ff6b5a'], ['duck y', '#2bb3a3'], ['in/out z', '#c77dff'], ['guard amt (blue = high, red = low)', 'rgba(255,250,240,0.6)'], ['activity', '#ffc94a']];
  let lx = pad;
  for (const [txt, col] of legend) { ctx.fillStyle = col; ctx.fillText(txt, lx, bottom + 14 * dpr); lx += ctx.measureText(txt).width + 14 * dpr; }
  if (tNow !== null) { ctx.strokeStyle = 'rgba(255, 250, 240, 0.7)'; ctx.lineWidth = dpr; ctx.beginPath(); ctx.moveTo(X(tNow), top); ctx.lineTo(X(tNow), bottom); ctx.stroke(); }
}

function sampleAt(t) {
  const s = lab.samples;
  if (!s.length) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid - 1; }
  return s[lo];
}

// ───────────────────────────── main loop ─────────────────────────────
let lastWall = performance.now();
function frame(now) {
  const dt = now - lastWall;
  lastWall = now;
  if (MODE === 'synthetic') {
    if (lab.playing) {
      lab.cursor += dt * lab.speed;
      if (lab.cursor > lab.duration) lab.cursor = 0;
      $('timeline').value = String(Math.round((lab.cursor / Math.max(1, lab.duration)) * 1000));
    }
    const s = sampleAt(lab.cursor);
    drawView(s);
    drawReadout(s);
    drawHandPlot('plotL', 'left', 0, lab.duration, lab.cursor);
    drawHandPlot('plotR', 'right', 0, lab.duration, lab.cursor);
    drawBodyPlot(0, lab.duration, lab.cursor);
    $('fps').textContent = lab.notes[0] || '';
    $('fps').title = lab.notes[0] || '';
  } else {
    if (lab.source && lab.playing) lab.source.tick(now);
    const s = lab.samples[lab.samples.length - 1] || null;
    drawView(s);
    drawReadout(s);
    const tEnd = s ? s.t : now, tStart = tEnd - 8000;
    drawHandPlot('plotL', 'left', tStart, tEnd, null);
    drawHandPlot('plotR', 'right', tStart, tEnd, null);
    drawBodyPlot(tStart, tEnd, null);
  }
  requestAnimationFrame(frame);
}

// ───────────────────────────── wiring ─────────────────────────────
function initControls() {
  const sel = $('scenario');
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = sc.name;
    sel.appendChild(o);
  }
  const p = (k, el) => { if (params.get(k) !== null) $(el).value = params.get(k); };
  p('scenario', 'scenario'); p('seed', 'seed'); p('distance', 'distance'); p('cam', 'camHeight'); p('punchMs', 'punchMs');
  p('noise', 'noise'); p('lead', 'lead'); p('sens', 'sens'); p('speed', 'speed');
  if (!SCENARIOS[sel.value]) sel.value = 'tour';
  lab.speed = Number($('speed').value) || 1;
  const rebuild = () => { if (MODE === 'synthetic') buildSynthetic(); };
  for (const id of ['scenario', 'seed', 'distance', 'camHeight', 'punchMs', 'noise', 'lead', 'sens']) $(id).addEventListener('change', rebuild);
  $('speed').addEventListener('change', () => { lab.speed = Number($('speed').value) || 1; });
  $('play').addEventListener('click', () => { lab.playing = !lab.playing; $('play').textContent = lab.playing ? 'Pause' : 'Play'; });
  $('restart').addEventListener('click', () => {
    if (MODE === 'synthetic') { lab.cursor = 0; return; }
    lab.samples = []; lab.events = []; lab.rejects = [];
    if (lab.recognizer) lab.recognizer.reset();
    if (lab.video) { try { lab.video.currentTime = 0; } catch { /* live stream */ } }
  });
  $('randomize').addEventListener('click', () => {
    const o = randomPlayerOptions(Math.floor(Math.random() * 1e6));
    $('seed').value = String(Math.floor(Math.random() * 999) + 1);
    $('distance').value = o.distance.toFixed(1); $('camHeight').value = o.cameraHeight.toFixed(1);
    $('punchMs').value = String(Math.round(o.punchMs / 10) * 10); $('lead').value = o.lead;
    rebuild();
  });
  $('timeline').addEventListener('input', () => { lab.cursor = (Number($('timeline').value) / 1000) * lab.duration; });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
    if (e.code === 'ArrowRight') lab.cursor = Math.min(lab.duration, lab.cursor + 33);
    if (e.code === 'ArrowLeft') lab.cursor = Math.max(0, lab.cursor - 33);
  });
}

async function main() {
  initControls();
  $('mode').textContent = MODE === 'synthetic' ? 'synthetic replay' : MODE === 'live' ? 'live webcam' : 'video clip';
  if (MODE !== 'synthetic') {
    $('mode').classList.add('live');
    $('synthControls').hidden = true;
    $('timelineWrap').hidden = true;
    await startCameraSource();
  } else {
    buildSynthetic();
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error('[gesture-lab]', e);
  const n = $('notice');
  n.hidden = false;
  n.innerHTML = `<b>The lab hit an error.</b> ${e.message}`;
});
