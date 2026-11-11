// Gesture benchmark (dev tool for the gesture lab): detection matrix — true positives per punch type ×
// height × start posture — kind / target confusion, latency vs. peak wrist speed, and false punches
// per minute of idle / menu movement, on random synthetic players (src/input/synthetic.js).
//
//   node dev/gesture-lab.bench.mjs [gesture.js path] [players=40] [--brief] [--json out.json] [--fps-rows] [--drop-rows]
//        [--preset real-like] [--tuning '{"sensitivity":0.7}'] [--synth '{"zNoise":0.006,"worldNoise":0.003,"zBias":0.008}']
//
// The DEFAULT run is the headline (comparable with earlier rounds): the generator's default noise was set to an
// earlier measurement of dev/clips/facecam-boxing.mp4 (still joints' world depth ≈ 20 mm per frame; the synthetic
// default ≈ 21 mm). The game's own VIDEO-mode tracker gives ≈ 2–10 mm on that clip and on three public shadowboxing
// clips (R5) — --preset real-like below. --synth overrides the generator's options for every player; the "clean
// depth" set above (≈ 3–4 mm) is a what-if for a much cleaner tracker, where the depth-led paths (low-guard body
// pushes, the 3D dip-less uppercut) switch on. Players run at 25–33 fps;
// --fps-rows adds one SUMMARY line each at 15, 20, 30 and 60 fps (dim rooms, the CPU fallback, fast webcams);
// --drop-rows one each with many single (15 %) and double (10 %) dropped camera frames.
// --preset real-like (R5) runs every player with synthetic.js's SYNTH_PRESETS['real-like']: what real MediaPipe
// output measured like on four real clips (less and correlated jitter, depth ≈ 3–9 mm and not compressed, ≈ 4 ms
// lag, the head and shoulders moving with every punch — see SYNTH_PRESETS). The default run stays the headline
// for comparisons with earlier rounds; run both.
// The LAT line: per punch type, onset (the fist starts moving) → fire and peak wrist speed → fire, p50 / p90 ms.
// Pass another gesture.js to compare versions (the generator is always this tree's).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeSyntheticPlayer, sequence, randomPlayerOptions, mulberry32 } from '../src/input/synthetic.js';

const argPath = process.argv[2] && !process.argv[2].startsWith('--') && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const gesturePath = argPath ? resolve(argPath) : fileURLToPath(new URL('../src/input/gesture.js', import.meta.url));
const NP = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 40);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const TUN = process.argv.includes('--tuning') ? JSON.parse(process.argv[process.argv.indexOf('--tuning') + 1]) : {};
const BRIEF = process.argv.includes('--brief');
const PRESET = process.argv.includes('--preset') ? process.argv[process.argv.indexOf('--preset') + 1] : null;
const SYN = { ...(PRESET ? { preset: PRESET } : {}), ...(process.argv.includes('--synth') ? JSON.parse(process.argv[process.argv.indexOf('--synth') + 1]) : {}) };
const FPS_ROWS = process.argv.includes('--fps-rows');
const DROP_ROWS = process.argv.includes('--drop-rows');
/** The same bench (brief) at other camera frame rates / with dropped frames, one SUMMARY (+ LAT) line each. */
function fpsRows() {
  const rows = [];
  if (FPS_ROWS) for (const fps of [15, 20, 30, 60]) rows.push([`FPS ${String(fps).padStart(2)}`, { fps }]);
  if (DROP_ROWS) rows.push(['DROP 1×15%', { frameDropRate: 0.15 }], ['DROP 2×10%', { frameDrop2Rate: 0.1 }]);
  for (const [name, extra] of rows) {
    const args = [fileURLToPath(import.meta.url), gesturePath, String(NP), '--brief', '--tuning', JSON.stringify(TUN), '--synth', JSON.stringify({ ...SYN, ...extra })];
    const lines = execFileSync(process.execPath, args, { encoding: 'utf8' }).split('\n');
    console.log(`${name}: ${lines.find((l) => l.startsWith('SUMMARY')) || '?'}`);
    console.log(`${name}: ${lines.find((l) => l.startsWith('LAT')) || '?'}`);
  }
}
const { GestureRecognizer } = await import(pathToFileURL(gesturePath).href);

const PUNCH_ACTIONS = ['jab-left', 'jab-right', 'body-left', 'body-right', 'hook-left', 'hook-right', 'uppercut-left', 'uppercut-right'];
const POSTURES = ['guard-high', 'idle', 'guard-low'];
const label = (a) => a.startsWith('jab') ? 'straight-head' : a.startsWith('body') ? 'straight-body' : a.startsWith('hook') ? 'hook' : a.startsWith('uppercut') ? 'uppercut' : a;

function recognise(frames, tuning = TUN) {
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return ev;
}

// ── detection matrix ──
const cells = {};   // key `${label}|${posture}` → {n, tp, kind:{}, tgt, tgtN, lat:[]}
const conf = {};    // performed label → recognised kind counts
const lat = [], latSpeed = [], powers = {};
const latKind = {};   // label → {onset: [], speed: []}  (fire − onset, fire − peak wrist speed)
let extraTotal = 0, dupTotal = 0, punchesTotal = 0;
for (let i = 0; i < NP; i++) {
  const o = randomPlayerOptions(7100 + i, SYN);
  const r = mulberry32(911 + i);
  const steps = [{ action: 'idle', ms: 1300 }];
  const meta = [];
  for (const post of POSTURES) {
    steps.push({ action: post, ms: 1100 });
    const order = [...PUNCH_ACTIONS].sort(() => r() - 0.5);
    for (const a of order) {
      steps.push({ action: a, ms: 1000 + r() * 250 });
      meta.push({ action: a, posture: post });
      steps.push({ action: post, ms: 500 + r() * 300 });
    }
  }
  steps.push({ action: 'idle', ms: 900 });
  const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
  const ev = recognise(frames);
  const used = new Set();
  truth.punches.forEach((p, j) => {
    const m = ev.filter((e, k) => !used.has(k) && e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
    m.forEach((e) => used.add(ev.indexOf(e)));
    const L = label(meta[j].action);
    const key = `${L}|${meta[j].posture}`;
    const c = cells[key] ||= { n: 0, tp: 0, kindOk: 0, tgtOk: 0, tgtN: 0 };
    c.n++; punchesTotal++;
    const row = conf[L] ||= { straight: 0, hook: 0, uppercut: 0, miss: 0 };
    if (!m.length) { row.miss++; return; }
    if (m.length > 1) dupTotal++;
    c.tp++;
    row[m[0].punch.kind]++;
    const wantKind = p.kind;
    if (m[0].punch.kind === wantKind) c.kindOk++;
    if (p.kind !== 'uppercut') { c.tgtN++; if (m[0].punch.target === p.target) c.tgtOk++; }
    lat.push(m[0].t - p.tPeak);
    latSpeed.push(m[0].t - (p.tStart + (p.tPeak - p.tStart) / 2));
    const lk = latKind[L] ||= { onset: [], speed: [] };
    lk.onset.push(m[0].t - p.tStart); lk.speed.push(m[0].t - (p.tStart + (p.tPeak - p.tStart) / 2));
    const pm = Math.round(o.punchMs / 50) * 50;
    (powers[pm] ||= []).push(m[0].punch.power);
  });
  extraTotal += ev.length - used.size;
}

// ── special cases: uppercut without a dip, body straight from a low guard ──
function special(name, mk) {
  let n = 0, tp = 0, right = 0;
  const kinds = {};
  for (let i = 0; i < NP; i++) {
    const o = randomPlayerOptions(5300 + i, SYN);
    const { steps, want } = mk(i);
    const { frames, truth } = makeSyntheticPlayer(o).run(sequence(steps));
    const ev = recognise(frames);
    for (const p of truth.punches) {
      n++;
      const m = ev.filter((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
      if (m.length) { tp++; kinds[m[0].punch.kind + '/' + m[0].punch.target] = (kinds[m[0].punch.kind + '/' + m[0].punch.target] || 0) + 1; if (want(m[0].punch)) right++; }
    }
  }
  return { name, n, tp, right, kinds };
}
const specials = [
  special('uppercut, no dip (from stance)', (i) => ({ steps: [{ action: 'idle', ms: 1300 }, { action: i % 2 ? 'uppercut-left' : 'uppercut-right', dip: false, ms: 1100 }, { action: 'idle', ms: 600 }, { action: i % 2 ? 'uppercut-right' : 'uppercut-left', dip: false, ms: 1100 }, { action: 'idle', ms: 800 }], want: (p) => p.kind === 'uppercut' })),
  special('uppercut, no dip (from high guard)', (i) => ({ steps: [{ action: 'guard-high', ms: 1300 }, { action: i % 2 ? 'uppercut-left' : 'uppercut-right', dip: false, ms: 1100 }, { action: 'guard-high', ms: 600 }, { action: i % 2 ? 'uppercut-right' : 'uppercut-left', dip: false, ms: 1100 }, { action: 'guard-high', ms: 800 }], want: (p) => p.kind === 'uppercut' })),
  special('body straight from low guard', (i) => ({ steps: [{ action: 'guard-low', ms: 1300 }, { action: i % 2 ? 'body-left' : 'body-right', ms: 1100 }, { action: 'guard-low', ms: 600 }, { action: i % 2 ? 'body-right' : 'body-left', ms: 1100 }, { action: 'guard-low', ms: 800 }], want: (p) => p.kind === 'straight' && p.target === 'body' })),
];

// ── false positives per minute ──
const FP = {
  'idle (stance)': [{ action: 'idle', ms: 12000 }],
  'hold high guard': [{ action: 'guard-high', ms: 12000 }],
  'hold low guard': [{ action: 'guard-low', ms: 12000 }],
  'guard changes': [{ action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'guard-low', ms: 1500 }, { action: 'idle', ms: 1500 }, { action: 'guard-high', ms: 1500 }, { action: 'idle', ms: 1500 }],
  'lean/duck/back/fwd': [{ action: 'guard-high', ms: 1500 }, { action: 'lean-left', ms: 900 }, { action: 'lean-right', ms: 900 }, { action: 'duck', ms: 900 }, { action: 'lean-forward', ms: 900 }, { action: 'lean-back', ms: 900 }, { action: 'guard-high', ms: 900 }],
  wave: [{ action: 'idle', ms: 1500 }, { action: 'wave', hand: 'right', ms: 3000 }, { action: 'idle', ms: 800 }],
  'wave (face height)': [{ action: 'idle', ms: 1500 }, { action: 'wave', hand: 'left', height: 'face', ms: 3000 }, { action: 'idle', ms: 800 }],
  'scratch face': [{ action: 'idle', ms: 1500 }, { action: 'scratch-face', hand: 'left', ms: 2400 }, { action: 'idle', ms: 800 }],
  glasses: [{ action: 'idle', ms: 1500 }, { action: 'adjust-glasses', hand: 'right', ms: 1500 }, { action: 'idle', ms: 800 }],
  'raise hand': [{ action: 'idle', ms: 1500 }, { action: 'raise-hand', hand: 'right', ms: 1800 }, { action: 'idle', ms: 800 }],
  pause: [{ action: 'idle', ms: 1500 }, { action: 'pause', ms: 2000 }, { action: 'idle', ms: 1000 }],
  'walk away': [{ action: 'idle', ms: 1500 }, { action: 'walk-away', ms: 3000 }],
  'point (slow)': [{ action: 'idle', ms: 1500 }, { action: 'point', hand: 'right', ms: 3000 }, { action: 'idle', ms: 800 }],
  'point (slow, left)': [{ action: 'idle', ms: 1500 }, { action: 'point', hand: 'left', ms: 3000 }, { action: 'idle', ms: 800 }],
  'reach slow': [{ action: 'idle', ms: 1500 }, { action: 'reach-slow', hand: 'right', ms: 3200 }, { action: 'idle', ms: 800 }],
  'reach slow (left)': [{ action: 'idle', ms: 1500 }, { action: 'reach-slow', hand: 'left', ms: 3200 }, { action: 'idle', ms: 800 }],
  'pull-back yank': [{ action: 'guard-high', ms: 1500 }, { action: 'pull-back', hand: 'left', ms: 2600 }, { action: 'guard-high', ms: 1200 }],
};
const fp = {};
for (const [name, steps] of Object.entries(FP)) {
  let trials = 0, fired = 0, events = 0, ms = 0;
  for (let i = 0; i < NP; i++) {
    const o = randomPlayerOptions(4400 + i, SYN);
    const { frames } = makeSyntheticPlayer(o).run(sequence(steps));
    const ev = recognise(frames).filter((e) => !name.startsWith('pull-back') || e.t >= 1500 + 1450);
    trials++; ms += frames[frames.length - 1].t - (name.startsWith('pull-back') ? 1500 + 1450 : 0);
    if (ev.length) fired++;
    events += ev.length;
  }
  fp[name] = { trials, fired, events, perMin: events / (ms / 60000), min: ms / 60000 };
}

// ── report ──
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };
const out = { gesturePath, NP, cells, conf, extraTotal, dupTotal, punchesTotal, lat: { p10: q(lat, 0.1), p50: q(lat, 0.5), p90: q(lat, 0.9) }, latSpeed: { p10: q(latSpeed, 0.1), p50: q(latSpeed, 0.5), p90: q(latSpeed, 0.9), within100: latSpeed.filter((x) => x <= 100).length / latSpeed.length }, specials, fp, powers: Object.fromEntries(Object.entries(powers).sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, { n: v.length, p10: q(v, 0.1), p50: q(v, 0.5), p90: q(v, 0.9), at1: v.filter((x) => x >= 0.99).length / v.length }])) };
const det0 = Object.values(cells).reduce((a, c) => a + c.tp, 0);
const kindOk0 = Object.values(cells).reduce((a, c) => a + c.kindOk, 0);
const tg0 = Object.values(cells).reduce((a, c) => [a[0] + c.tgtOk, a[1] + c.tgtN], [0, 0]);
const fpAll = Object.entries(fp).filter(([k]) => !/point|reach/.test(k)).reduce((a, [, v]) => a + v.events, 0);
const fpPoint = fp['point (slow)'].fired + fp['point (slow, left)'].fired, fpReach = fp['reach slow'].fired + fp['reach slow (left)'].fired;
const grp = (re) => { const e = Object.entries(fp).filter(([k]) => re.test(k)); const ev = e.reduce((a, [, v]) => a + v.events, 0), mn = e.reduce((a, [, v]) => a + v.min, 0); return `${(ev / mn).toFixed(2)}/min (${ev} in ${mn.toFixed(1)} min)`; };
console.log(`FPMIN in-bout idle (stance, holds, guard changes, leans) ${grp(/idle|hold|guard changes|lean/)} · menu/other gestures ${grp(/wave|scratch|glasses|raise|pause|walk|point|reach|pull/)} · all ${grp(/./)}`);
const latLine = ['straight-head', 'straight-body', 'hook', 'uppercut'].map((L) => { const v = latKind[L] || { onset: [], speed: [] }; return `${L} onset ${q(v.onset, 0.5).toFixed(0)}/${q(v.onset, 0.9).toFixed(0)} speed ${q(v.speed, 0.5).toFixed(0)}/${q(v.speed, 0.9).toFixed(0)}`; }).join(' · ');
out.latKind = Object.fromEntries(Object.entries(latKind).map(([k, v]) => [k, { onsetP50: q(v.onset, 0.5), onsetP90: q(v.onset, 0.9), speedP50: q(v.speed, 0.5), speedP90: q(v.speed, 0.9), n: v.onset.length }]));
console.log(`LAT (p50/p90 ms) ${latLine}`);
console.log(`SUMMARY det ${det0}/${punchesTotal} kind ${kindOk0} tgt ${tg0[0]}/${tg0[1]} dup ${dupTotal} extra ${extraTotal} | lowBody ${cells['straight-body|guard-low'].tp}/${cells['straight-body|guard-low'].n} | upNoDip ${specials[0].right}+${specials[1].right}/${specials[0].n * 2} | lat(speed) p50 ${out.latSpeed.p50.toFixed(0)} p90 ${out.latSpeed.p90.toFixed(0)} <100: ${(100 * out.latSpeed.within100).toFixed(0)}% | FP point ${fpPoint}/${2 * NP} reach ${fpReach}/${2 * NP} other ${fpAll} | ${JSON.stringify(TUN)} ${JSON.stringify(SYN)}`);
if (BRIEF) { fpsRows(); process.exit(0); }
console.log(`\n=== ${gesturePath} — ${NP} random players ===`);
console.log('TP per punch type × start posture (detected / thrown, kind ok, target ok):');
for (const L of ['straight-head', 'straight-body', 'hook', 'uppercut']) {
  console.log('  ' + L.padEnd(14) + POSTURES.map((p) => { const c = cells[`${L}|${p}`]; return `${p}: ${c.tp}/${c.n} k${c.kindOk} t${c.tgtOk}/${c.tgtN}`; }).join('   '));
}
console.log('confusion (performed → straight/hook/uppercut/miss):');
for (const [k, r] of Object.entries(conf)) console.log(`  ${k.padEnd(14)} ${r.straight} / ${r.hook} / ${r.uppercut} / ${r.miss}`);
const det = Object.values(cells).reduce((a, c) => a + c.tp, 0);
console.log(`detected ${det}/${punchesTotal} (${(100 * det / punchesTotal).toFixed(1)}%), duplicates ${dupTotal}, extra ${extraTotal}`);
console.log(`latency vs full extension p10/p50/p90: ${out.lat.p10.toFixed(0)}/${out.lat.p50.toFixed(0)}/${out.lat.p90.toFixed(0)} ms`);
console.log(`latency vs peak wrist speed p10/p50/p90: ${out.latSpeed.p10.toFixed(0)}/${out.latSpeed.p50.toFixed(0)}/${out.latSpeed.p90.toFixed(0)} ms; within 100 ms: ${(100 * out.latSpeed.within100).toFixed(0)}%`);
console.log('specials:');
for (const s of specials) console.log(`  ${s.name.padEnd(38)} detected ${s.tp}/${s.n}, right kind ${s.right}/${s.n}  ${JSON.stringify(s.kinds)}`);
console.log('false positives (trials with ≥1 / trials, events, per minute):');
let fpEv = 0, fpMs = 0;
for (const [k, v] of Object.entries(fp)) { console.log(`  ${k.padEnd(22)} ${v.fired}/${v.trials}  ev ${v.events}  ${v.perMin.toFixed(2)}/min`); fpEv += v.events; fpMs += v.events / Math.max(1e-9, v.perMin) * 60000 || 0; }
const totMin = Object.values(fp).reduce((a, v) => a + (v.events ? v.events / v.perMin : 0), 0);
console.log('power by punchMs (n, p10/p50/p90, share at 1):');
for (const [k, v] of Object.entries(out.powers)) console.log(`  ${k} ms: n ${v.n}  ${v.p10.toFixed(2)}/${v.p50.toFixed(2)}/${v.p90.toFixed(2)}  at1 ${(100 * v.at1).toFixed(0)}%`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
fpsRows();
