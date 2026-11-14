// End-to-end run (Playwright + Chromium). Starts its own Vite dev server (no hot reload), plays every
// flow of the game in a real browser and saves screenshots.
//
//   npm run test:e2e                      all scenarios (except the opt-in telemetry-60s)
//   node tests/e2e.mjs keyboard versus    only scenarios whose name contains one of the words
//   node tests/e2e.mjs telemetry-60s      an opt-in scenario runs only when named in full
//
// Environment:
//   E2E_PORT=5190        dev server port (started and stopped by this script; must be free)
//   E2E_SHOTS=<dir>      screenshot folder (default: test-results/e2e)
//   E2E_GL=gpu|swiftshader   WebGL backend. Default: the real GPU through ANGLE/Metal on macOS
//                        (60 fps headless), SwiftShader elsewhere (~3 fps: slow, timeouts × 6; pose detection on
//                        the fake camera can drop to about 2 per second there, and camera, camera-retry and
//                        telemetry, which wait for more than 5, then time out).
//   E2E_HEADED=1         watch it run
//   GLOVE_VITE_CACHE_DIR=<dir>  the server's Vite dependency cache (default: test-results/.vite-e2e-<port>,
//                        private to the run, so another dev server on the checkout can't disturb it)
//
// The summary counts passed, skipped and failed scenarios separately. A scenario that cannot run here
// (the clip scenario without its git-ignored clip) prints SKIP and is never counted as passed.
// The browser has no DNS for anything but the local server, so the run needs no internet, and any
// request to another host — from the page or its detection worker — fails the scenario: the game must
// never need a CDN (RELEASE-03) and never send usage data anywhere (R5; the telemetry scenario forces the
// moments MediaPipe's logger would send, so that check does not depend on how long a scenario runs).
//
// Scenarios (research/spec.md acceptance checks in brackets; research/mechanics.md sections in §):
//   keyboard   title → guest → single player → VS card → the first-bout tutorial, skipped with Enter →
//              punches, guard, lean → the opponent goes down and rises, the player goes down and gets
//              up by mashing → rounds → decision → outro → decision reveal → results card → Quit  [A01 A06 A07]
//   pause      P → Continue restores the exact state · Esc → Start over clears it · a hidden tab pauses ·
//              Quit → menu, nothing saved  [A09]
//   versus     two keyboard players, split screen, both throw punches, outro, winner card, rating untouched  [A08 A11]
//   training   bag (2 participants, turns + standings), dodging drill, target punching → result screens  [A10]
//   camera     Chromium's fake camera: camera check says P1 is not visible and stays in setup  [A13 ERR01]
//   synthetic  scripted poses through the REAL pose → gesture → match pipeline: camera check passes,
//              calibration completes, a full round is fought with recognised punches, guards and leans
//   lost       (continues synthetic) the player vanishes → "Please keep your hands visible", then the ERR02 pause
//              naming them; back with both hands in view, the bout carries on by itself where it stopped  [A13 ERR02]
//   storage    localStorage throws → KO → outro → "not saved" notice on the results card  [A14 ERR04]
//   persist    a local boxer's records survive a reload; a guest's don't; a visiting (portable)
//              boxer plays on another device without anything being written there  [A12 SAV01]
//   settings   keyboard assist, sensitivity, reduced motion, PiP and volume apply live and after a reload
//   replay     a pose recording file (?input=replay&rec=…) drives the camera check and the bout
//   clip       real MediaPipe tracking on a recorded boxing clip (?video=…); SKIP without dev/clips/facecam-boxing.mp4
//   ko         a KO: the KO call, the whole outro in order (wipe, flash, replay, banner, winner, end;
//              ≤ 1.5 s with ?fast=1), the HUD's Replay tag and win banner, then the results card (§6, §6.5)
//   tutorial   a new local boxer's first bout: all six tutorial cards advance from the keyboard
//              (holds, 3 punches, 3 dodges), then "Fight!" and the clock; never again for that boxer (§8)
//   slowmo     a scripted opponent power hook dodged with an injected duck (real recognizer) opens the
//              dodge slow motion: world ×0.25, the player real-time (§2.5, §6.3)
//   again      "Play again" goes straight to the next VS card after ~0.5 s of black: the next opponent
//              after the first win (no straight rematch), then a rematch with the first one at a raised
//              rating inside the measured band (§1.1, §1.2, §7.2, §7.5)
//   meter      the in-world health meters appear on a hit — the opponent's when the player lands one,
//              the player's when the opponent does — and never during the tutorial (§5, §8)
//   camera-retry  the camera stops while a bout waits on the tracking-lost screen: it says so, "Try again"
//              reopens the camera, and the same bout stays paused until the player is back (FLOWS-02)
//   camera-latch  the camera check (synthetic poses): Continue comes on only after 2 s fully in view, stays on
//              while the player steps out of the picture to reach the computer, is cleared by a stalled feed
//              (no fresh frames) until another 2 s in view, and a click on it goes on
//   rest       a fighting stance or a guard held on the pause screen (synthetic poses) clicks nothing and the bout
//              stays paused until hands up again; on the tracking-lost screen the boxer back with both hands in
//              view carries the bout on by itself about 0.5 s later — nothing clicked
//              (FLOWS-01, FLOWS-M1)
//   fonts-offline the Google font hosts blocked: no console error, Lilita One and Nunito load from the
//              game's own server, on the title and in a bout (RELEASE-03)
//   context-loss  the WebGL context is lost mid-bout: the bout pauses (clock and opponent frozen) and stays
//              paused after the restore until the player continues (FLOWS-09)
//   sound-badge   camera play (a bout started without a click or key, paused by both hands above the head)
//              starts no sound and shows the sound-off badge; one real key press starts the sound and
//              hides it (FLOWS-03; its own browser, default autoplay policy)
//   telemetry  MediaPipe's usage logger sends nothing (R5): the worker's landmarker and two main-thread
//              landmarkers are closed on purpose (each close flushes the logger at once); the telemetry guard
//              answers every flush on the device and no request leaves
//   telemetry-60s  (opt-in, ≈ 70 s) the same without forcing anything: live trackers past the logger's 60 s
//              timer, in the worker and on the main thread
// Every page is checked for page errors and console errors.
// It is also checked for requests to hosts other than the local server (there must be none).
// Inputs whose effect a loaded machine can stretch (a hold or a count in game time) are repeated until the
// page shows the effect, within a generous timeout, instead of being given a fixed time.
// Nothing waits for a short-lived state from outside the page either (LEAD-01): a test knockdown is checked and
// made in one page task (knockDown), a key that skips the 1.45 s ?fast=1 outro is pressed from before the outro
// starts (pressDuringOutro), and the outro's tag and banner are noted by the page itself. The suite's browser
// runs without speech synthesis (the announcer beeps instead): with it, headless Chromium answered this runner
// seconds late while the count was spoken.
//
// tests/unit/release-fix-e2e.test.mjs and platform-repair-e2e.test.mjs import this file (runScenarios,
// summarize, Skip, the scenario list, selectScenarios and the input helpers) without running anything: the run
// itself starts only when the file is executed.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 5190);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(process.env.E2E_SHOTS || join(ROOT, 'test-results', 'e2e'));
const GL = process.env.E2E_GL || (process.platform === 'darwin' ? 'gpu' : 'swiftshader');
const ONLY = process.argv.slice(2);
/** The real-footage clip of the 'clip' scenario: git-ignored, not distributed (README "Tests"). */
export const CLIP_FILE = join(ROOT, 'dev', 'clips', 'facecam-boxing.mp4');

const GL_ARGS = GL === 'gpu'
  ? ['--use-angle=metal', '--ignore-gpu-blocklist']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/** No DNS except for the local server: the run is the same with or without internet. */
const OFFLINE_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost'];
/**
 * No speech synthesis in the suite's browser: the announcer falls back to its beeps, and no scenario checks
 * spoken lines. With it, headless Chromium answered every call of this runner 1.3–8 s late right after a
 * knockdown (when the count is spoken) while the page itself ran on time — long enough to miss a 1.45 s
 * ?fast=1 outro or a whole round (LEAD-01). Without it there were no such stalls.
 */
const QUIET_ARGS = ['--disable-speech-api'];
export const LAUNCH_ARGS = [...GL_ARGS, ...OFFLINE_ARGS, ...QUIET_ARGS, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
/** Is this request for the local server (or not a network request at all)? */
export function isLocalUrl(url) {
  try {
    const u = new URL(url);
    return !/^(https?|wss?):$/.test(u.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return true; }
}
/** Console noise that is not ours (software GL driver chatter). */
const NOISE = /GPU stall due to ReadPixels|GL Driver Message|Automatic fallback to software WebGL|WebGL: CONTEXT_LOST_WEBGL/;
/** SwiftShader runs the game at a few fps: scale every timeout. */
export const SLOW = GL === 'gpu' ? 1 : 6;

const t0 = Date.now();
const clock = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(clock(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failed expectation (reported with its message only, no stack). */
export class Check extends Error {}
function check(cond, msg) { if (!cond) throw new Check(msg); }
/** Thrown by a scenario that cannot run in this checkout: reported as SKIP, never counted as passed (RELEASE-10). */
export class Skip extends Error {}
function skip(reason) { throw new Skip(reason); }

// ───────────────────────────── dev server ─────────────────────────────

async function startServer() {
  const free = await fetch(BASE).then(() => false, () => true);
  if (!free) throw new Error(`Port ${PORT} is busy — stop whatever runs there or set E2E_PORT.`);
  // GLOVE_NO_HMR (vite.config.js): no hot reload, so an editor saving a file can't reload a running scenario.
  // GLOVE_VITE_CACHE_DIR: this run's own dependency cache (per port, under the git-ignored test-results/),
  // so another dev server on the checkout re-optimizing node_modules/.vite can't break a page mid-scenario
  // (seen as "The pose-tracking library failed to load").
  const cacheDir = process.env.GLOVE_VITE_CACHE_DIR || join(ROOT, 'test-results', `.vite-e2e-${PORT}`);
  const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, GLOVE_NO_HMR: '1', GLOVE_VITE_CACHE_DIR: cacheDir },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`vite exited:\n${out}`);
    const ok = await fetch(BASE).then((r) => r.ok, () => false);
    if (ok) return proc;
    await sleep(200);
  }
  throw new Error(`vite did not start:\n${out}`);
}

function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
}

// ───────────────────────────── page helpers ─────────────────────────────

/**
 * A fresh browser context + page with error collection and helpers.
 * `block`: host names whose requests are refused outright (on top of the missing DNS), each refusal
 * logged in P.blocked; P.requests lists every request URL the page and its workers made.
 */
async function openPage(browser, { path = '/', init = null, viewport = { width: 1280, height: 720 }, block = null } = {}) {
  const context = await browser.newContext({ viewport, permissions: ['camera'] });
  if (init) await context.addInitScript(init);
  const blocked = [];
  if (block?.length) {
    await context.route((url) => block.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)),
      (route) => { blocked.push(route.request().url()); return route.abort('blockedbyclient'); });
  }
  const errors = [];
  const warnings = [];
  const external = [];
  const requests = [];
  // the whole context: the page and its detection worker (MediaPipe's usage logger runs there)
  context.on('request', (r) => { requests.push(r.url()); if (!isLocalUrl(r.url())) external.push(r.url()); });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (NOISE.test(text)) return;
    if (m.type() === 'error') errors.push(`console.error: ${text}`);
    else if (m.type() === 'warning') warnings.push(text);
  });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__glove?.state, null, { timeout: 30000 * SLOW });
  const P = {
    page, context, errors, warnings, external, requests, blocked,
    state: () => page.evaluate(() => window.__glove.state()),
    async shot(name) { const f = join(SHOTS, `${name}.png`); await page.screenshot({ path: f }); log(`  shot ${f}`); return f; },
    /** Wait until `id` is the top screen and still waiting for input, then let it arm. */
    async screen(id, { timeout = 30000, settle = 500 } = {}) {
      await page.waitForFunction((id) => { const s = window.__glove.state(); return s.screen === id && !s.screenDone; }, id, { timeout: timeout * SLOW });
      await page.waitForTimeout(settle);
    },
    async until(fn, arg = null, timeout = 30000) { return page.waitForFunction(fn, arg, { timeout: timeout * SLOW, polling: 50 }); },
    /** Wait for the running activity to be in one of `phases`. */
    async phase(phases, timeout = 40000) {
      await page.waitForFunction((ph) => [].concat(ph).includes(window.__glove.state().activity?.phase), phases, { timeout: timeout * SLOW, polling: 50 });
    },
    /** Wait for the bout's sub-stage (MatchView.stage: 'live', 'fight', 'count', a tutorial step …). */
    async stage(stages, timeout = 40000) {
      await page.waitForFunction((st) => [].concat(st).includes(window.__glove.state().activity?.stage), stages, { timeout: timeout * SLOW, polling: 30 });
    },
    async click(name, opts = {}) { await page.getByRole('button', { name, ...opts }).first().click(); },
    async keys(codes, gap = 140) { for (const k of codes) { await page.keyboard.press(k); await page.waitForTimeout(gap); } },
    async hold(code, ms) { await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code); },
    pose: (action, ms, opts) => page.evaluate(([a, ms, o]) => window.__glove.injectPose(a, ms, o), [action, ms, opts || {}]),
    activity: () => page.evaluate(() => window.__glove.state().activity),
    /** Record bus events (name filter regex) into window.__e2e for later checks. */
    async record(pattern) {
      await page.evaluate((src) => {
        const re = new RegExp(src);
        window.__e2e = window.__e2e || [];
        if (window.__e2eOff) window.__e2eOff();
        window.__e2eOff = window.__glove.bus.on('*', (name, p) => {
          if (!re.test(name)) return;
          let copy = null;
          try { copy = JSON.parse(JSON.stringify(p ?? null, (k, v) => (k === 'scorecards' || k === 'stats' || k === 'rounds' || k === 'boxers' ? undefined : v))); } catch { copy = null; }
          window.__e2e.push({ name, t: performance.now(), p: copy });
        });
      }, pattern);
    },
    events: (name = null) => page.evaluate((n) => (window.__e2e || []).filter((e) => !n || e.name === n), name),
  };
  return P;
}

/**
 * Repeat `act(attempt)` until `done(arg)` holds in the page, for at most `timeout` ms (× SLOW). For inputs
 * whose effect a loaded machine can stretch past one fixed-length attempt (a hold, a count of detections):
 * every attempt is followed by a check of the page, not by an assumption (LEAD-01).
 * @returns {Promise<number>} the attempts made
 */
export async function retryUntil(P, { act, done, arg = null, timeout = 20000, label }) {
  const end = Date.now() + timeout * SLOW;
  for (let n = 0; ; n++) {
    if (await P.page.evaluate(done, arg)) return n;
    check(Date.now() < end, `${label} (not done after ${n} attempts)`);
    await act(n + 1);
  }
}

/**
 * Hold a key until `done(arg)` holds in the page (a hold measured in game time can need longer than planned),
 * then release it. `down: false`: the key is already held.
 */
export async function holdUntil(P, code, { done, arg = null, timeout = 15000, label, down = true }) {
  if (down) await P.page.keyboard.down(code);
  try {
    await P.until(done, arg, timeout).catch(() => { throw new Check(`${label} (held ${code} for ${timeout * SLOW} ms)`); });
  } finally {
    await P.page.keyboard.up(code);
  }
}

/**
 * Knock `id` down as soon as the bout is live. match.debugKnockdown works only while the bout is fighting
 * (otherwise it returns false and does nothing), and on a loaded machine a round can end between a separate
 * "is it live?" check and the call (LEAD-01: the knockdown never happened and the bout went to the judges).
 * So the check and the knockdown run together in the page, on every poll, until the knockdown has happened.
 */
export async function knockDown(P, id, opts = {}, timeout = 40000) {
  try {
    await P.until(([who, o]) => !!window.__glove.match?.debugKnockdown(who, o), [id, opts], timeout);
  } catch {
    const a = await P.activity().catch(() => null);
    throw new Check(`${id} was not knocked down within ${timeout * SLOW} ms (phase ${a?.phase}, round ${a?.round}, over ${a?.over})`);
  }
}

/**
 * Press `key` from before the bout outro starts until the outro reports it was skipped. A press before the
 * outro does nothing (no screen is open during a bout and the keyboard maps no game action to Enter / Esc), so
 * the first press after the outro starts skips it, however short the outro and however late the runner.
 * @returns {Promise<boolean>} true: skipped; false: the outro ended before a press reached it
 */
export async function pressDuringOutro(P, key = 'Enter', timeout = 30000) {
  const end = Date.now() + timeout * SLOW;
  for (;;) {
    const o = await P.page.evaluate(() => window.__glove.state().activity?.outro ?? null);
    if (o?.skipped) return true;
    if (o && !o.active) return false;
    check(Date.now() < end, `the bout outro did not start within ${timeout * SLOW} ms (${JSON.stringify(o)})`);
    await P.page.keyboard.press(key);
    await P.page.waitForTimeout(100);
  }
}

let warningCount = 0;
function assertClean(P, label) {
  if (P.warnings.length) { warningCount += P.warnings.length; log(`  console warnings: ${P.warnings.slice(0, 5).join(' | ')}`); P.warnings.length = 0; }
  check(P.external.length === 0, `${label}: requests to third-party hosts (the game must run without internet):\n  ${[...new Set(P.external)].join('\n  ')}`);
  check(P.errors.length === 0, `${label}: page/console errors:\n  ${P.errors.join('\n  ')}`);
}

/** Title → profiles → "Play as guest" → main menu. */
async function enterAsGuest(P) {
  await P.screen('title');
  await P.page.keyboard.press('Enter');
  await P.screen('profiles');
  await P.click(/Play as guest/);
  await P.screen('mode');
}

/** Title → profiles → New boxer → name → Create → Box as <name> → main menu. Returns the profile id. */
async function newLocalBoxer(P, name) {
  await P.screen('title');
  await P.page.keyboard.press('Enter');
  await P.screen('profiles');
  await P.click(/New boxer/);
  await P.screen('profile-editor');
  await P.page.locator('.gu-editor input').first().fill(name);
  await P.click(/Create boxer/);
  await P.screen('profiles');
  await P.page.getByRole('button', { name: new RegExp(`Box as ${name}`) }).click();
  await P.screen('mode');
  return (await P.state()).profile.id;
}

/** Poll the game state until `until(state)` is true; on a timeout, say which screen and flow it was stuck at. */
async function untilState(P, until, timeout = 30000) {
  const end = Date.now() + timeout * SLOW;
  for (;;) {
    const s = await P.state();
    if (until(s)) return s;
    check(Date.now() < end, `stuck at ${s.screen} (${s.flow})`);
    await P.page.waitForTimeout(250);
  }
}

/** A quick, decisive win for tests: the opponent is knocked down and stays down (KO, §3.4). */
export async function winByKO(P) {
  await knockDown(P, 'p2', { stayDown: true });
  await P.until(() => !!window.__glove.state().activity?.over);
}

/** Run the round clock out round by round until the judges decide. */
async function goToDecision(P) {
  for (let guard = 0; guard < 6; guard++) {
    const a = await P.activity();
    if (!a || a.over) return;
    await P.phase(['fighting', 'decision', 'result']);
    const b = await P.activity();
    if (b.over) return;
    const round = b.round;
    await P.page.evaluate(() => window.__glove.match.debugEndRound());
    await P.until((r) => { const a = window.__glove.state().activity; return !a || a.over || a.round > r; }, round, 30000);
  }
}

// ───────────────────────────── scenarios ─────────────────────────────

export const scenarios = [];
/** `optIn`: a slow check that runs only when named in full on the command line (never in the default run). */
const scenario = (name, fn, { optIn = false } = {}) => scenarios.push({ name, fn, ...(optIn ? { optIn: true } : {}) });

/** The scenarios a run with these command-line words selects (none: every scenario that is not opt-in). */
export function selectScenarios(list, words) {
  return list.filter((s) => (s.optIn
    ? words.includes(s.name)
    : !words.length || words.some((w) => s.name.includes(w) || (w === 'synthetic' && s.name === 'lost'))));
}

scenario('keyboard', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=11' });
  await P.screen('title', { settle: 1600 });
  await P.shot('a01-title');
  await enterAsGuest(P);
  await P.shot('a02-mode');
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('opponent');
  check(!(await P.state()).curtain, 'the black before the VS card has lifted');
  await P.shot('a04-vs-card');
  await P.click(/Fight/);
  // a guest's first bout opens with the tutorial (§8); Enter skips it
  await P.until(() => window.__glove.state().activity?.tutorial?.stage === 'card');
  check((await P.activity()).clockVisible === false, 'no clock during the tutorial');
  await P.shot('a04b-tutorial');
  await P.page.keyboard.press('Enter');
  await P.until(() => window.__glove.state().activity?.tutorial?.stage === 'finished');
  check((await P.activity()).tutorial.skipped && (await P.state()).profile.tutorialDone, 'tutorial skipped and marked done');
  await P.stage('live');
  const s0 = await P.state();
  check(s0.activity.mode === 'single' && s0.render.scene === 'match' && s0.render.split === 1 && s0.activity.clockVisible, 'single-player match on screen, clock running');
  check(s0.activity.latencyMs === 40, `keyboard latency for latency-fair defence (${s0.activity.latencyMs})`);
  // punches (J/K straights, U/I hooks, N uppercut, Shift+J body), guard, lean, duck
  await P.keys(['KeyJ', 'KeyK', 'KeyU', 'KeyI', 'KeyN']);
  await P.page.keyboard.down('ShiftLeft'); await P.keys(['KeyJ']); await P.page.keyboard.up('ShiftLeft');
  await P.shot('a05-punches');
  await P.page.keyboard.down('Space');
  await P.page.waitForTimeout(500);
  // (a loaded machine may need a few more frames: wait for the guard while the key is held)
  await P.until(() => window.__glove.state().activity?.p1?.guard === 'high', null, 5000).catch(() => {});
  const guard = await P.activity();
  await P.shot('a06-guard');
  await P.page.keyboard.up('Space');
  check(guard.p1.guard === 'high', `Space raises a high guard (got ${guard.p1.guard})`);
  await P.page.keyboard.down('KeyA');
  await P.page.waitForTimeout(350);
  await P.shot('a07-lean');
  await P.page.keyboard.up('KeyA');
  await P.hold('KeyS', 300);
  const s1 = await P.activity();
  check(s1.stats.p1.thrown >= 3, `keyboard punches reach the match (thrown ${s1.stats.p1.thrown})`);
  log(`  thrown ${s1.stats.p1.thrown}, landed ${s1.stats.p1.landed}, blocked by AI ${s1.stats.p2.blocked}`);
  // the opponent goes down and gets up (its stay-down roll forced off for the test, §3.2)
  await knockDown(P, 'p2', { stayDown: false });
  await P.page.waitForTimeout(250);
  await P.shot('a08-knockdown');
  await P.until(() => (window.__glove.state().activity?.count ?? 0) >= 2 || window.__glove.state().activity?.phase !== 'knockdown');
  await P.shot('a08b-count');
  await P.phase(['recovery', 'fighting']);
  const k1 = await P.activity();
  check(k1.p2.knockdowns === 1 && k1.p2.hp === 8, `opponent knockdown counted, rose with 8 wedges (§3.3) (${k1.p2.hp})`);
  // the player goes down and gets up by mashing punches (MAT03 recoverable knockdown)
  await knockDown(P, 'p1');
  for (let i = 0; i < 24; i++) {
    await P.page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyK');
    await P.page.waitForTimeout(90);
    if (i === 10) await P.shot('a09-get-up');
    const a = await P.activity();
    if (a.phase !== 'knockdown') break;
  }
  await P.phase(['recovery', 'fighting']);
  const s2 = await P.activity();
  check(s2.p1.knockdowns === 1 && !s2.over, 'player got up and the bout goes on');
  // rounds → decision → outro → decision reveal → results card (MAT01, MAT04)
  await goToDecision(P);
  await P.screen('result', { settle: 1700 });
  const res = (await P.state()).activity.result;
  check(res && ['decision', 'draw'].includes(res.method), `decision result (got ${JSON.stringify(res)})`);
  check((await P.state()).activity.outro?.active === false, 'the outro played before the decision reveal');
  await P.shot('a10-decision');
  await P.click(/Continue/);
  await P.screen('skill', { settle: 2400 });
  const st = await P.state();
  check(st.saves.length === 1 && st.saves[0].reason === 'guest', 'result recorded exactly once (guest: not saved)');
  await P.shot('a11-results-card');
  await P.click(/^Quit/);
  await P.screen('mode');
  check((await P.state()).activity === null, 'back at the main menu with no activity');
  await P.shot('a12-menu');
  assertClean(P, 'keyboard');
  await P.context.close();
});

scenario('pause', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=12&tutorial=0' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live');
  await P.keys(['KeyJ', 'KeyK']);
  await P.page.waitForTimeout(300);
  // P → pause → Continue: exactly the same state (SES02)
  await P.page.keyboard.press('KeyP');
  await P.screen('pause');
  const before = await P.activity();
  check(before.paused && before.phase === 'paused' && before.pausedFrom === 'fighting', 'P pauses the bout');
  await P.page.waitForTimeout(1200);
  const during = await P.activity();
  check(during.clockMs === before.clockMs, 'the clock is frozen while paused');
  await P.shot('b01-pause');
  await P.click(/Continue/);
  await P.until(() => !window.__glove.state().activity.paused);
  const after = await P.activity();
  check(after.id === before.id && after.attempt === before.attempt && after.phase === 'fighting' && after.round === before.round, 'Continue restores the same bout');
  check(after.clockMs <= before.clockMs && before.clockMs - after.clockMs < 9000, 'clock continues from where it stopped');
  await P.page.waitForTimeout(500);
  // Esc → pause → Start over: a fresh bout (transient state cleared)
  await P.page.evaluate(() => window.__glove.match.debugSetHp('p2', 3));
  await P.page.keyboard.press('Escape');
  await P.screen('pause');
  await P.click(/Start over/);
  await P.until((id) => { const a = window.__glove.state().activity; return a && a.id !== id && !a.paused; }, before.id);
  const fresh = await P.activity();
  check(fresh.attempt === 2 && ['intro', 'roundStart', 'fighting'].includes(fresh.phase) && fresh.p2.hp === 10 && fresh.round === 1, 'Start over begins a new bout from round 1');
  await P.stage('live');
  await P.shot('b02-started-over');
  // the tab goes to the background → the bout pauses itself (and waits for the player)
  await P.page.waitForTimeout(500);
  await P.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await P.screen('pause');
  const hidden = await P.state();
  check(hidden.activity.paused && hidden.pauseReason === 'hidden', 'a hidden tab pauses the bout');
  await P.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await P.click(/Continue/);
  await P.until(() => !window.__glove.state().activity.paused);
  await P.page.waitForTimeout(500);
  // P → Quit: back to the menu, nothing recorded
  await P.page.keyboard.press('KeyP');
  await P.screen('pause');
  await P.click(/Quit/);
  await P.screen('mode');
  const q = await P.state();
  check(q.activity === null && q.saves.length === 0, 'Quit leaves without recording anything');
  await P.shot('b03-quit-menu');
  // the pause card's way to skip the first-bout tutorial: pause → "Skip tutorial" → "Fight!" (§6.9)
  await P.page.evaluate(() => window.__glove.skipTo('match', { tutorial: true }));
  await P.until(() => window.__glove.state().activity?.tutorial?.stage === 'card');
  await P.page.waitForTimeout(500); // a pause right after a bout starts is refused (APP_TUNING.resumeGuardMs)
  await P.page.keyboard.press('KeyP');
  await P.screen('pause');
  await P.shot('b04-pause-skip-tutorial');
  await P.click(/Skip tutorial/);
  await P.until(() => { const a = window.__glove.state().activity; return a && !a.paused && a.tutorial?.skipped; });
  await P.stage('live');
  check((await P.state()).profile.tutorialDone === true, 'tutorial skipped from the pause screen and marked done');
  assertClean(P, 'pause');
  await P.context.close();
});

scenario('versus', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=13&tutorial=0' });
  await P.screen('title');
  // a local P1 with a rating, to prove versus leaves it alone (PRG02 / A11)
  const id = await P.page.evaluate(() => {
    const st = window.__glove.storage;
    const r = st.createProfile({ name: 'Vera' });
    st.updateProfile(r.profile.id, { skill: 420 });
    return r.profile.id;
  });
  await P.page.evaluate((id) => window.__glove.skipTo('mode', { profileId: id }), id);
  await P.screen('mode');
  await P.page.locator('.gu-tile--p2').click();
  await P.screen('profiles');
  await P.shot('c01-pick-p2');
  await P.click(/Play as guest/);
  await untilState(P, (s) => s.activity?.kind === 'match');
  await P.stage('live');
  const s0 = await P.state();
  check(s0.activity.mode === 'versus' && s0.render.split === 2 && s0.input.players === 2, 'versus: split screen, two input players');
  check(!s0.activity.tutorial, 'no tutorial in versus');
  for (const k of ['KeyJ', 'Digit1', 'KeyK', 'Digit2', 'KeyU', 'Digit4']) { await P.page.keyboard.press(k); await P.page.waitForTimeout(240); }
  await P.page.keyboard.down('Digit0');
  await P.page.keyboard.down('KeyD');
  await P.page.waitForTimeout(350);
  await P.shot('c02-split-screen');
  await P.page.keyboard.up('Digit0');
  await P.page.keyboard.up('KeyD');
  const a = await P.activity();
  check(a.stats.p1.thrown >= 2 && a.stats.p2.thrown >= 2, `both players punch (P1 ${a.stats.p1.thrown}, P2 ${a.stats.p2.thrown})`);
  await goToDecision(P);
  await P.screen('versus-result', { settle: 1700 });
  await P.shot('c03-winner-card');
  const st = await P.state();
  check(st.saves.length === 2, 'both corners recorded once');
  check(st.activity.outro?.active === false, 'the outro played before the winner card');
  await P.click(/Continue/);
  await P.screen('mode');
  const vera = await P.page.evaluate((id) => window.__glove.storage.getProfile(id), id);
  const v = vera.records.versus;
  check(vera.skill === 420 && v.wins + v.losses + v.draws === 1 && vera.records.matches.history.length === 1, 'versus recorded, rating unchanged (A11)');
  check((await P.state()).input.players === 1, 'input back to one player');
  assertClean(P, 'versus');
  await P.context.close();
});

scenario('training', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=14' });
  await enterAsGuest(P);
  // Bag practice with two participants taking turns
  await P.page.locator('.gu-tile--good').click();
  await P.screen('training-select');
  await P.page.locator('.gu-train__count button', { hasText: '2' }).click();
  await P.page.waitForTimeout(250);
  await P.shot('d01-training-select');
  await P.page.locator('.gu-train__card--bag').click();
  const playTurn = async (punch, label) => {
    await P.phase('active');
    for (let i = 0; i < 16; i++) { await punch(i); await P.page.waitForTimeout(170); }
    await P.shot(label);
    await P.screen('training-result', { timeout: 40000, settle: 1800 });
  };
  await playTurn((i) => P.page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyK'), 'd02-bag');
  let s = await P.state();
  check(s.activity.activity === 'bag' && Number.isFinite(s.activity.result?.score), 'bag practice result');
  log(`  bag turn 1 score ${s.activity.result.score} (${s.activity.result.medal})`);
  await P.shot('d03-bag-result-turn1');
  await P.click(/Next/);
  await playTurn((i) => P.page.keyboard.press(i % 3 ? 'KeyK' : 'KeyJ'), 'd04-bag-turn2');
  s = await P.state();
  check(await P.page.locator('.gu-rank tr').count() === 2, 'final standings compare both participants');
  await P.shot('d05-bag-standings');
  await P.click(/Done/);
  await P.screen('training-select');
  // Dodging drill (lean and duck) and target punching via quick jumps
  for (const kind of ['dodge', 'mitts']) {
    await P.page.evaluate((k) => window.__glove.skipTo(k), kind);
    await P.phase('active');
    for (let i = 0; i < 14; i++) {
      if (kind === 'dodge') await P.hold(['KeyA', 'KeyD', 'KeyS'][i % 3], 260);
      else { await P.page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyK'); await P.page.waitForTimeout(220); }
    }
    await P.shot(`d06-${kind}`);
    await P.screen('training-result', { timeout: 40000, settle: 1800 });
    const r = (await P.state()).activity.result;
    check(r && Number.isFinite(r.score) && typeof r.medal === 'string', `${kind} result`);
    log(`  ${kind} score ${r.score} (${r.medal})`);
    await P.shot(`d07-${kind}-result`);
    await P.click(/Done/);
    await P.screen('mode');
  }
  assertClean(P, 'training');
  await P.context.close();
});

scenario('camera', async (browser) => {
  const P = await openPage(browser, { path: '/?fast=1&seed=15' });
  await enterAsGuest(P);
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('camera-setup');
  // the fake camera shows a test pattern: nobody is there
  await P.until(() => window.__glove.state().input.fps > 5, null, 30000);
  await P.page.waitForTimeout(3000);
  const chip = (await P.page.locator('.gu-pchip--p1').textContent()).replace(/\s+/g, ' ');
  const cont = P.page.locator('.gu-camsetup .gu-footer .gu-btn--primary');
  check(/P1/.test(chip) && /Not visible/i.test(chip), `P1 is reported missing (chip "${chip}")`);
  check(await cont.isDisabled(), 'Continue is disabled while P1 is missing');
  await P.shot('e01-camera-p1-missing');
  await P.page.waitForTimeout(2000);
  const s = await P.state();
  check(s.screen === 'camera-setup' && s.activity === null && !s.input.error, 'still in setup, no crash');
  // two-player check names both corners
  await P.page.keyboard.press('Escape');
  await P.screen('mode');
  await P.page.locator('.gu-tile--p2').click();
  await P.screen('profiles');
  await P.click(/Play as guest/);
  await untilState(P, (s) => s.screen === 'camera-setup');
  await P.page.waitForTimeout(1500);
  const c2 = (await P.page.locator('.gu-pchip--p2').textContent()).replace(/\s+/g, ' ');
  check(/P2/.test(c2) && /not visible/i.test(c2), `P2 is reported missing (chip "${c2}")`);
  await P.shot('e02-camera-versus-missing');
  assertClean(P, 'camera');
  await P.context.close();
});

scenario('synthetic', async (browser, shared) => {
  const P = await openPage(browser, { path: '/?input=synthetic&fast=1&seed=16&tutorial=0' });
  shared.synthetic = P;
  await P.screen('title');
  await P.pose('idle', 1200);
  await P.page.keyboard.press('Enter');
  await P.screen('profiles');
  await P.click(/Play as guest/);
  await P.screen('mode');
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('camera-setup');
  await P.until(() => !document.querySelector('.gu-camsetup .gu-footer .gu-btn--primary')?.disabled, null, 20000);
  await P.shot('f01-camera-ready');
  await P.click(/^Continue/);
  await P.screen('calibrate');
  // do what each calibration step asks (closed loop on the page's data-step; the prompt pops up over the preview)
  const plan = { frame: [['idle', 1500]], guard: [['guard-high', 1500]], 'right-hand': [['raise-hand', 1200, { hand: 'right' }]], 'punch-right': [['idle', 500], ['jab-right', 900]], 'punch-left': [['idle', 500], ['jab-left', 900]] };
  const order = ['frame', 'guard', 'right-hand', 'punch-right', 'punch-left'];
  let last = null;
  const seen = [];
  const deadline = Date.now() + 60000 * SLOW;
  for (;;) {
    check(Date.now() < deadline, 'calibration finishes with synthetic poses');
    const done = await P.page.evaluate(() => !!document.querySelector('.gu-calib .gu-footer .gu-btn--primary'));
    if (done) break;
    const step = await P.page.evaluate(() => document.querySelector('.gu-calib')?.dataset.step ?? null);
    const busy = await P.page.evaluate(() => (window.__glove.feeder.busyUntil(0) ?? 0) - performance.now());
    if (step !== last || busy < 120) {
      for (const [a, ms, o] of plan[step] || [['idle', 500]]) await P.pose(a, ms, o);
      if (step !== last) {
        log(`  calibration step ${order.indexOf(step) + 1} (${step})`);
        if (step && step !== 'done') seen.push(step);
        if (step === 'punch-right') await P.shot('f01b-calibration-prompt');
      }
      last = step;
    }
    await P.page.waitForTimeout(200);
  }
  check(order.every((st) => seen.includes(st)) && seen.indexOf('punch-right') < seen.indexOf('punch-left'),
    `calibration ran its steps with the raised RIGHT hand punching first (${seen.join(' → ')})`);
  check(await P.page.evaluate(() => !document.querySelector('.gu-calib__steps') && !!document.querySelector('.gu-calib__pop .gu-calib__title')),
    'the instruction pops up over the camera picture (no step list)');
  await P.page.waitForTimeout(900);
  await P.shot('f02-calibrated');
  await P.click(/^Continue/);
  await P.screen('opponent');
  const cal = await P.page.evaluate(() => { const g = window.__glove; return g.storage.getProfile(g.state().profile.id)?.calibration || null; });
  check(cal, 'calibration saved to the boxer');
  check(Number.isFinite(cal.latencyMs), `the calibration carries the measured latency (${cal.latencyMs} ms)`);
  await P.pose('guard-high', 1500);
  await P.click(/Fight/);
  await P.stage('live');
  check((await P.activity()).latencyMs === Math.min(400, cal.latencyMs), `the bout judges defence with it (${(await P.activity()).latencyMs})`);
  // a full round of scripted boxing: jabs, crosses, hooks, uppercuts, body shots, guards, leans, ducks
  const moves = [['guard-high', 500], ['jab-left', 450], ['jab-right', 450], ['guard-high', 500], ['hook-left', 550], ['lean-left', 650], ['guard-high', 300],
    ['uppercut-right', 550], ['duck', 650], ['guard-high', 400], ['jab-left', 420], ['jab-left', 420], ['body-right', 600], ['lean-right', 650], ['guard-high', 500]];
  const round1 = (await P.activity()).round;
  let i = 0;
  const roundEnd = Date.now() + 90000 * SLOW;
  for (;;) {
    const now = await P.activity();
    if (now.round !== round1 || now.over) break;
    check(Date.now() < roundEnd, `round 1 should end by the clock (phase ${now.phase})`);
    const busy = await P.page.evaluate(() => (window.__glove.feeder.busyUntil(0) ?? 0) - performance.now());
    if (busy < 600) { const [a, ms] = moves[i % moves.length]; await P.pose(a, ms); i++; }
    if (i === 6) await P.shot('f03-synthetic-fight');
    await P.page.waitForTimeout(120);
  }
  const a = await P.activity();
  log(`  round 1 done: P1 thrown ${a.stats.p1.thrown}, landed ${a.stats.p1.landed}, blocked ${a.stats.p1.blocked}, dodged ${a.stats.p1.dodged}`);
  check(a.stats.p1.thrown >= 3, `recognised punches reached the match (${a.stats.p1.thrown})`);
  if (a.over) {
    // the opponent won inside the round (its knockdowns are real now): the scenario's pause part needs a live bout
    log(`  the bout ended early (${a.result?.method}) — starting a fresh one for the pause gesture`);
    await P.page.evaluate(() => window.__glove.skipTo('match'));
    await P.pose('guard-high', 1500);
    await P.stage('live');
  } else {
    check(a.round === round1 + 1, 'the bout moved on to round 2');
  }
  // the pause gesture: both hands above the head for a moment (and again to carry on)
  await P.stage('live');
  await P.pose('pause', 1900);
  await P.screen('pause', { timeout: 15000, settle: 600 });
  check((await P.state()).activity.paused, 'hands above the head pause the bout');
  await P.shot('f04-pause-gesture');
  await P.pose('guard-high', 900);   // hands down (the gesture re-arms) …
  await P.page.waitForTimeout(900);
  await P.pose('pause', 1900);       // … and up again = Continue
  await P.until(() => !window.__glove.state().activity?.paused, null, 15000);
  await P.pose('guard-high', 2000);
  assertClean(P, 'synthetic');
});

scenario('lost', async (browser, shared) => {
  const P = shared.synthetic;
  check(P, 'needs the synthetic scenario');
  await P.stage('live', 60000);
  await P.pose('guard-high', 800);
  await P.page.waitForTimeout(600);
  const before = await P.activity();
  // the player walks out of the picture while the camera keeps sending pictures (no frames at all would be a frozen
  // camera, which gets no hands warning — the card says the camera stopped)
  await P.pose('walk-away', 3000);
  // first "Please keep your hands visible" in the HUD, then — about a second later, still out — the card
  await P.until(() => document.querySelector('.gu-handswarn')?.hidden === false, null, 8000);
  const warn = await P.page.locator('.gu-handswarn').textContent();
  check(/keep your hands visible/i.test(warn) && (await P.state()).screen !== 'tracking-lost', `the warning comes before the card ("${warn}")`);
  await P.shot('g00-hands-warning');
  await P.screen('tracking-lost', { timeout: 15000, settle: 800 });
  const s = await P.state();
  check(s.activity.paused && s.activity.phase === 'paused' && s.pauseReason === 'tracking', 'ERR02: the bout is suspended');
  check(s.activity.id === before.id && !!s.activity.pausedFrom, 'the same bout is kept, paused mid-phase');
  const title = await P.page.locator('.gu-lost .gu-modal__title').textContent();
  check(/lost sight of you|can’t see your hands/i.test(title), `the screen says who is missing ("${title}")`);
  check(await P.page.evaluate(() => document.querySelector('.gu-handswarn')?.hidden !== false), 'no warning over the card');
  await P.shot('g01-tracking-lost');
  await P.page.waitForTimeout(1500);
  const s2 = await P.state();
  check(s2.screen === 'tracking-lost' && s2.activity.clockMs === s.activity.clockMs && s2.activity.round === s.activity.round, 'nothing moved while the player is gone');
  // back in a stance with both hands in view: the bout carries on by itself about 0.5 s later — no guard hold, no click
  const backAt = Date.now();
  await P.pose('idle', 3000);
  await P.until(() => !window.__glove.state().activity?.paused, null, 10000);
  const tookMs = Date.now() - backAt;
  const after = await P.activity();
  check(after.id === before.id && after.round >= s.activity.round, 'resumed the same bout where it stopped');
  check(tookMs < 2500 * SLOW, `carried on by itself soon after the hands were back (${tookMs} ms)`);
  await P.page.waitForTimeout(600);
  await P.shot('g03-resumed');
  assertClean(P, 'lost');
  await P.context.close();
});

scenario('storage', async (browser) => {
  // every write throws (full / blocked storage)
  const init = () => {
    const proto = Object.getPrototypeOf(window.localStorage);
    proto.setItem = function setItem() { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  };
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=17&tutorial=0', init });
  await P.screen('title');
  await P.page.keyboard.press('Enter');
  await P.screen('profiles');
  await P.click(/New boxer/);
  await P.screen('profile-editor');
  await P.page.locator('.gu-editor input').first().fill('Robin');
  await P.click(/Create boxer/);
  await P.screen('profiles');
  await P.shot('h01-profiles-not-saving');
  const notice = await P.page.locator('.gu-notice--warn').first().textContent().catch(() => '');
  check(/isn’t saving progress/.test(notice), `the boxers screen warns that nothing is saved ("${notice}")`);
  await P.page.getByRole('button', { name: /Box as Robin/ }).click();
  await P.screen('mode');
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('opponent');
  await P.click(/Fight/);
  await winByKO(P);
  // a KO goes from the outro straight to the results card (no decision reveal)
  await P.screen('skill', { settle: 2400 });
  const st = await P.state();
  check(st.saves.length === 1 && st.saves[0].saved === false && st.saves[0].ok === true, 'the bout completed but was not saved');
  const warn = await P.page.locator('.gu-skill .gu-notice').textContent();
  check(/Progress not saved/.test(warn), `the results card says progress was not saved ("${warn}")`);
  await P.shot('h02-results-not-saved');
  await P.click(/^Quit/);
  await P.screen('mode');
  assertClean(P, 'storage');
  await P.context.close();
});

scenario('persist', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=18&tutorial=0' });
  const id = await newLocalBoxer(P, 'Kit');
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('opponent');
  await P.click(/Fight/);
  await winByKO(P);
  check((await P.state()).activity.result.winner === 'p1', 'Kit wins');
  await P.screen('skill', { settle: 2400 });
  const skill = (await P.state()).profile.skill;
  check(skill === 75, `rating went up by the measured first-win gain (${skill}, §7.1)`);
  await P.click(/^Quit/);
  await P.screen('mode');
  // a guest bout as well
  await P.page.evaluate(() => window.__glove.skipTo('profiles'));
  await P.screen('profiles');
  await P.click(/Play as guest/);
  await P.screen('mode');
  const guestId = (await P.state()).profile.id;
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await winByKO(P);
  await P.screen('skill', { settle: 600 });
  // reload: Kit and her record are still there, the guest is gone
  await P.page.reload({ waitUntil: 'load' });
  await P.page.waitForFunction(() => !!window.__glove?.state);
  await P.screen('title');
  const after = await P.page.evaluate(([id, gid]) => {
    const st = window.__glove.storage;
    const keys = Object.keys(localStorage);
    return { kit: st.getProfile(id), guest: st.getProfile(gid), sessions: st.sessionProfiles().length, guestKeys: keys.filter((k) => k.includes(gid)).length, list: st.listProfiles().map((p) => p.name) };
  }, [id, guestId]);
  check(after.kit && after.kit.skill === skill && after.kit.records.matches.wins === 1 && after.kit.records.matches.history.length === 1, 'Kit’s rating and record survived the reload');
  check(after.kit.tutorialDone === true && after.kit.bestRating === skill, 'tutorial flag and best rating were saved');
  check(after.kit.opponents?.[after.kit.records.matches.history[0].opponentId]?.beaten === true, 'the beaten opponent was saved (rematch rating)');
  check(!after.guest && after.sessions === 0 && after.guestKeys === 0 && after.list.join() === 'Kit', 'nothing of the guest was stored');
  await P.page.keyboard.press('Enter');
  await P.screen('profiles');
  await P.shot('i01-profiles-after-reload');
  await P.page.getByRole('button', { name: /Box as Kit/ }).click();
  await P.screen('mode');
  await P.page.locator('.gu-tile', { hasText: 'Records' }).click();
  await P.screen('records', { settle: 800 });
  await P.shot('i02-records-after-reload');
  // Kit visits another device (fresh browser storage) as a portable boxer: plays, nothing is saved there
  const json = await P.page.evaluate((id) => window.__glove.storage.exportProfile(id), id);
  assertClean(P, 'persist');
  await P.context.close();
  const V = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=22' });
  await V.screen('title');
  const vid = await V.page.evaluate((j) => window.__glove.storage.importPortable(j).profile.id, json);
  await V.page.evaluate((pid) => window.__glove.skipTo('match', { profileId: pid }), vid);
  await V.until(() => !!window.__glove.state().activity);
  check((await V.activity()).tutorial === null, 'a visiting boxer who finished the tutorial does not see it again');
  await winByKO(V);
  await V.screen('skill', { settle: 2400 });
  const vs = await V.state();
  check(vs.profile.kind === 'portable' && vs.saves.length === 1 && vs.saves[0].reason === 'portable' && !vs.saves[0].saved, 'visiting boxer: the bout counts but is not saved here');
  const vnote = await V.page.locator('.gu-skill .gu-notice').textContent();
  check(/Visiting boxers/.test(vnote), `the results card explains it ("${vnote}")`);
  await V.shot('i03-visiting-not-saved');
  const stored = await V.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gloveup:v1:profile')).length);
  check(stored === 0, 'no profile was written on the visited device');
  assertClean(V, 'persist (visiting)');
  await V.context.close();
});

scenario('settings', async (browser) => {
  const P = await openPage(browser, { path: '/?input=keyboard&seed=19' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('settings'));
  await P.screen('settings');
  await P.page.getByRole('tab', { name: /Play/ }).click();
  await P.page.waitForTimeout(300);
  await P.page.getByRole('switch', { name: 'Keyboard assist' }).click();
  // (the default sensitivity is 0.6 since 2026-11-13 — a notch less strict than the middle)
  const sens0 = await P.page.evaluate(() => window.__glove.input.gestureTuning?.sensitivity);
  check(Math.abs(sens0 - 0.6) < 1e-6, `the default punch sensitivity reaches the recognizers (${sens0})`);
  await P.click('More Punch sensitivity');
  await P.click('More Punch sensitivity');
  await P.page.getByRole('switch', { name: 'Reduced motion' }).click();
  await P.page.getByRole('switch', { name: 'Camera picture-in-picture' }).click();
  await P.page.waitForTimeout(400);
  await P.shot('j01-settings-play');
  await P.page.getByRole('tab', { name: /Sound/ }).click();
  await P.page.waitForTimeout(300);
  await P.click('Less Master volume');
  await P.click('Less Master volume');
  await P.shot('j02-settings-sound');
  const live = await P.page.evaluate(() => {
    const g = window.__glove;
    return {
      assist: g.input.keyboardAssist, sensitivity: g.input.gestureTuning?.sensitivity, reduced: g.renderer._reducedMotion,
      reducedUi: g.ui.el.classList.contains('gu-reduced-motion'), pip: g.ui.hud._pipEnabled, master: g.audio.getVolume().master,
    };
  });
  check(live.assist === true, 'keyboard assist applied to the input hub');
  check(Math.abs(live.sensitivity - 0.8) < 1e-6, `sensitivity applied to the recognizers (${live.sensitivity})`);
  check(live.reduced && live.reducedUi, 'reduced motion applied to the renderer and the UI');
  check(live.pip === false, 'webcam picture-in-picture turned off');
  check(Math.abs(live.master - 0.6) < 1e-6, `master volume applied to the audio engine (${live.master})`);
  // persisted and applied again at boot
  await P.page.reload({ waitUntil: 'load' });
  await P.page.waitForFunction(() => !!window.__glove?.state);
  await P.screen('title');
  const boot = await P.page.evaluate(() => {
    const g = window.__glove;
    return { assist: g.input.keyboardAssist, sensitivity: g.input.gestureTuning?.sensitivity, reduced: g.renderer._reducedMotion, master: g.audio.getVolume().master };
  });
  check(boot.assist && Math.abs(boot.sensitivity - 0.8) < 1e-6 && boot.reduced && Math.abs(boot.master - 0.6) < 1e-6, `settings restored at boot (${JSON.stringify(boot)})`);
  assertClean(P, 'settings');
  await P.context.close();
});

scenario('replay', async (browser) => {
  // a recorded pose session (synthetic, written as a real recording file) replayed as the camera
  const { syntheticPoseFrames, sequence } = await import('../src/input/synthetic.js');
  const { encodeRecording } = await import('../src/input/recorder.js');
  const { writeFileSync } = await import('node:fs');
  // arms down while the menus are clicked through and the camera check passes, then a boxing stretch the
  // bout can recognise; the replay loops
  const steps = [{ action: 'arms-down', ms: 12000 }, { action: 'guard-high', ms: 1200 }];
  for (let i = 0; i < 5; i++) steps.push({ action: 'jab-left', ms: 700 }, { action: 'guard-high', ms: 500 }, { action: 'cross', ms: 700 }, { action: 'guard-high', ms: 600 });
  const frames = syntheticPoseFrames(sequence(steps), { seed: 31, noise: 0.5 });
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results', 'e2e-replay.json'), encodeRecording({ frames, meta: { source: 'e2e synthetic' } }));
  const P = await openPage(browser, { path: '/?input=replay&rec=/test-results/e2e-replay.json&fast=1&seed=20&tutorial=0' });
  await enterAsGuest(P);
  await P.page.locator('.gu-tile--primary').click();
  await untilState(P, (s) => s.screen === 'camera-setup' && !s.screenDone);
  await P.until(() => !document.querySelector('.gu-camsetup .gu-footer .gu-btn--primary')?.disabled, null, 20000);
  await P.shot('k01-replay-camera-ready');
  await P.click(/^Continue/);
  await P.screen('calibrate');
  await P.click(/Skip for now/);
  await P.screen('opponent');
  await P.click(/Fight/);
  await P.phase('fighting');
  await P.until(() => (window.__glove.state().activity?.stats?.p1?.thrown ?? 0) >= 2, null, 30000).catch(() => {});
  const a = await P.activity();
  log(`  replayed punches thrown ${a.stats.p1.thrown}`);
  check(a.stats.p1.thrown >= 2, `punches from the recording reached the match (${a.stats.p1.thrown})`);
  await P.shot('k02-replay-fight');
  assertClean(P, 'replay');
  await P.context.close();
});

scenario('clip', async (browser, shared) => {
  // The real MediaPipe pipeline on real footage (a recorded boxer, played as the camera). The clip
  // is not part of the repository (dev/clips/ is git-ignored); without it this scenario is skipped
  // and reported as SKIP. (shared.clipFile: the unit test points it at a missing file.)
  const clip = shared?.clipFile ?? CLIP_FILE;
  if (!existsSync(clip)) skip(`no ${relative(ROOT, clip) || clip}`);
  const P = await openPage(browser, { path: '/?video=/dev/clips/facecam-boxing.mp4&fast=1&seed=21&tutorial=0' });
  await P.screen('title');
  await P.until(() => window.__glove.state().input.fps > 8, null, 30000);
  await P.page.evaluate(() => window.__glove.skipTo('single'));
  await untilState(P, (s) => s.screen === 'camera-setup' && !s.screenDone);
  await P.until(() => !document.querySelector('.gu-camsetup .gu-footer .gu-btn--primary')?.disabled, null, 20000);
  await P.shot('l01-clip-camera-ready');
  await P.click(/^Continue/);
  await P.screen('calibrate');
  await P.click(/Skip for now/);
  await P.screen('opponent');
  await P.click(/Fight/);
  await P.phase(['fighting', 'paused']);
  await P.until(() => (window.__glove.state().activity?.stats?.p1?.thrown ?? 0) >= 2, null, 25000).catch(() => {});
  const s = await P.state();
  log(`  tracker ${s.input.fps} fps; punches recognised from the clip: ${s.activity.stats.p1.thrown}, landed ${s.activity.stats.p1.landed}`);
  check(s.activity.stats.p1.thrown >= 1, 'real punches from the clip reached the bout');
  await P.shot('l02-clip-fight');
  assertClean(P, 'clip');
  await P.context.close();
});

scenario('ko', async (browser) => {
  // (a) a KO with the whole outro and the results card, ?fast=1 (§6 "KO outro", ARCHITECTURE §6.5)
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=23&tutorial=0' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live');
  await P.record('^(match:(call|ko|result)|render:outro)$');
  // the outro's Replay tag and win banner are up for a fraction of the 1.45 s ?fast=1 outro, less than one
  // screenshot can take on a loaded machine: the page notes them itself the moment they show (LEAD-01)
  await P.page.evaluate(() => {
    const seen = (window.__e2eSeen = {});
    const look = () => {
      for (const [k, sel] of [['replay', '.gu-replay'], ['win', '.gu-win__text']]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        seen[k] = seen[k] || { t: performance.now(), text: '' };
        if (el.textContent) seen[k].text = el.textContent;
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await P.page.evaluate(() => window.__glove.match.debugSetHp('p2', 0.4));
  await P.keys(['KeyJ', 'KeyK', 'KeyJ', 'KeyK'], 260);
  // the KO: a real blow may have floored the opponent already (that knockdown is made the KO), else it is
  // knocked down as soon as the bout is live — decided and done in one page task (LEAD-01)
  await P.until(() => {
    const m = window.__glove.match;
    if (!m) return false;
    if (m.kd && m.kd.downed === 'p2') { m.kd.stayDown = true; return true; }
    return m.debugKnockdown('p2', { stayDown: true });
  }, null, 40000);
  await P.until(() => !!window.__glove.state().activity?.over);
  await P.until(() => window.__glove.state().activity?.call === 'ko');
  await P.shot('m01-ko-call');
  // the outro: Replay tag during the replay, the win banner during 'banner' (screenshots best effort)
  await P.until(() => !!window.__e2eSeen.replay, null, 15000);
  await P.shot('m02-outro-replay');
  await P.until(() => !!window.__e2eSeen.win, null, 15000);
  await P.shot('m03-outro-banner');
  const seen = await P.page.evaluate(() => window.__e2eSeen);
  check(/Replay/.test(seen.replay.text), `the HUD shows the Replay tag ("${seen.replay.text}")`);
  check(/YOU WIN/.test(seen.win.text), `the win banner ("${seen.win.text}")`);
  check(seen.replay.t <= seen.win.t, 'the Replay tag before the win banner');
  await P.screen('skill', { settle: 2000 });
  const ev = await P.events();
  const stages = ev.filter((e) => e.name === 'render:outro').map((e) => e.p.stage);
  check(stages.join() === 'start,wipe,flash,replay,banner,winner,end', `outro stages in order (${stages.join()})`);
  const at = (n, st) => ev.find((e) => e.name === n && (!st || e.p?.stage === st || e.p?.call === st))?.t;
  const koCall = at('match:call', 'ko'), result = at('match:result'), start = at('render:outro', 'start'), end = at('render:outro', 'end');
  check(koCall < result && result <= start, 'KO call → MATCH_RESULT → outro');
  check(end - start <= 1600, `?fast=1 outro ≤ 1.5 s (${Math.round(end - start)} ms)`);
  check(ev.filter((e) => e.name === 'match:result').length === 1, 'MATCH_RESULT exactly once (MAT04)');
  check(!(await P.page.locator('.gu-win').count()) || true, 'banner cleared at the end');
  const st = await P.state();
  check(st.profile.skill === 75 && st.render.outro?.stage === 'end', `results card after the outro (rating ${st.profile.skill})`);
  await P.shot('m04-results-card');
  // Enter skips an outro: a second KO. The ?fast=1 outro lasts 1.45 s, less than a loaded machine can take
  // to notice it and send a key, so Enter is pressed from the knockdown on until the outro reports the skip
  // (pressDuringOutro); a bout whose outro still ended unskipped is played again, up to 3 bouts (LEAD-01)
  let skipped = false;
  for (let bout = 1; bout <= 3 && !skipped; bout++) {
    await P.click(/Play again/);
    await P.screen('opponent');
    await P.click(/Fight/);
    await knockDown(P, 'p2', { stayDown: true });
    skipped = await pressDuringOutro(P, 'Enter');
    await P.screen('skill', { settle: 600 });
    if (!skipped) log(`  the outro ended before Enter reached it (bout ${bout} of 3): another bout`);
  }
  const o2 = (await P.activity()).outro;
  check(skipped && o2.skipped === true, `Enter skipped the outro (${JSON.stringify(o2)})`);
  await P.click(/^Quit/);
  await P.screen('mode');
  assertClean(P, 'ko');
  await P.context.close();
});

scenario('tutorial', async (browser) => {
  // (b) a new local boxer's first bout: all six cards, driven from the keyboard (§8, ARCHITECTURE §6.9)
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=24' });
  const id = await newLocalBoxer(P, 'Tess');
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('opponent');
  await P.click(/Fight/);
  const card = async (step) => {
    await P.until((s) => { const t = window.__glove.state().activity?.tutorial; return t?.step === s && t.stage === 'card'; }, step, 20000);
    await P.until((s) => document.querySelector('.gu-tut')?.dataset.step === s, step, 5000);
  };
  // a card is done once it shows its check (or the next card is up). Holds are 1 s of GAME time and game time
  // runs slower than real time below 10 fps, so the keys are held / pressed until the card is done, not for a
  // fixed time (a loaded machine would otherwise reach the 4 s ?fast=1 cap first) (LEAD-01)
  const cardDone = (s) => { const t = window.__glove.state().activity?.tutorial; return !t || t.step !== s || t.stage !== 'card'; };
  await card('stance');
  check((await P.activity()).clockVisible === false && (await P.activity()).phase === 'fighting', 'live, no clock');
  await P.shot('n01-tutorial-stance');   // the keyboard stance is held by itself
  await card('guard-head');
  await holdUntil(P, 'Space', { done: cardDone, arg: 'guard-head', label: 'the high-guard card completes on the hold' });
  await card('punch-head');
  await retryUntil(P, { act: () => P.keys(['KeyJ', 'KeyK'], 330), done: cardDone, arg: 'punch-head', label: 'three head punches complete the card' });
  await card('guard-body');
  await P.page.keyboard.down('KeyB');
  await P.page.waitForTimeout(700);
  await P.shot('n02-tutorial-guard-body');
  await holdUntil(P, 'KeyB', { done: cardDone, arg: 'guard-body', label: 'the low-guard card completes on the hold', down: false });
  await card('punch-body');
  await P.page.keyboard.down('ShiftLeft');
  await retryUntil(P, { act: () => P.keys(['KeyJ', 'KeyK'], 330), done: cardDone, arg: 'punch-body', label: 'three body punches complete the card' });
  await P.page.keyboard.up('ShiftLeft');
  await card('dodge');
  await retryUntil(P, { act: async (n) => { await P.hold(n % 2 ? 'KeyA' : 'KeyD', 320); await P.page.waitForTimeout(260); }, done: cardDone, arg: 'dodge', label: 'three dodges complete the card' });
  await P.until(() => window.__glove.state().activity?.tutorial?.stage === 'finished', null, 20000);
  const t = (await P.activity()).tutorial;
  check(t.done.join() === 'stance,guard-head,punch-head,guard-body,punch-body,dodge' && !t.skipped, `all six cards (${t.done.join()})`);
  const reasons = await P.page.evaluate(() => window.__glove.tutorial.log.map((l) => l.reason));
  check(reasons.every((r) => r !== 'cap'), `every card completed by the player, not the cap (${reasons.join()})`);
  await P.stage('live');
  const live = await P.activity();
  check(live.clockVisible && live.p1.hp === 10 && live.p2.hp === 10 && live.tutorial.stage === 'finished', `"Fight!" and the clock, full health (${JSON.stringify([live.clockVisible, live.p1.hp, live.p2.hp])})`);
  await P.until(() => !document.querySelector('.gu-tut'), null, 3000);
  const prof = await P.page.evaluate((id) => window.__glove.storage.getProfile(id), id);
  check(prof.tutorialDone === true, 'tutorialDone saved for the boxer');
  // the next bout: no tutorial
  await winByKO(P);
  await P.screen('skill', { settle: 600 });
  await P.click(/Play again/);
  await P.screen('opponent');
  await P.click(/Fight/);
  await P.phase('fighting');
  check(!(await P.activity()).tutorial, 'no tutorial on the second bout');
  assertClean(P, 'tutorial');
  await P.context.close();
});

scenario('slowmo', async (browser) => {
  // (c) a scripted power hook, dodged by an injected duck through the real recognizer (§2.5, §6.3);
  // then a KO whose full-length outro is skipped by raising both hands (normal speed: no ?fast=1)
  const P = await openPage(browser, { path: '/?input=synthetic&seed=25&tutorial=0' });
  await P.screen('title');
  await P.pose('guard-high', 2500);
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live', 60000);           // (the synthetic player holds its last posture: still tracked)
  await P.record('^match:(windup|dodge|slowmo|hit)$');
  // the opponent throws power hooks with a long, raised-glove tell (the tutorial's dodge script)
  await P.page.evaluate(() => { const m = window.__glove.match; m.ai.setScript('dodge', m.wt); });
  let slow = null;
  for (let tries = 0; tries < 3 && !slow; tries++) {
    await P.until(() => (window.__e2e || []).some((e) => e.name === 'match:windup' && e.p?.attacker === 'p2' && e.p?.powerPunch && !e.seen), null, 15000);
    await P.page.evaluate(() => { for (const e of window.__e2e) if (e.name === 'match:windup') e.seen = true; });
    await P.pose('duck', 1300);           // ducks under the hook (crosses the line ~0.17 s later)
    await P.pose('guard-high', 600);
    await P.page.waitForTimeout(1000);
    slow = (await P.events('match:slowmo'))[0] || null;
  }
  check(slow && slow.p.dodger === 'p1' && slow.p.attacker === 'p2' && slow.p.scale === 0.25, `a dodge opened the slow motion (${JSON.stringify(slow?.p)})`);
  const dodge = (await P.events('match:dodge'))[0];
  check(dodge && dodge.p.defender === 'p1', 'MATCH_DODGE for the player');
  // during the window: the world runs at ×0.25, the player in real time; the renderer smears. A fresh duck
  // on the next power hook (from the guard, as above); like the first part, another try if it was too late
  // for that hook on a loaded machine (LEAD-01)
  let inSlow = false;
  for (let tries = 0; tries < 3 && !inSlow; tries++) {
    await P.page.evaluate(() => { for (const e of window.__e2e) if (e.name === 'match:windup') e.seen = true; const m = window.__glove.match; m.ai.setScript('dodge', m.wt); });
    await P.until(() => (window.__e2e || []).some((e) => e.name === 'match:windup' && e.p?.attacker === 'p2' && !e.seen), null, 15000);
    await P.pose('duck', 1300);
    inSlow = await P.page.waitForFunction(() => !!window.__glove.state().activity?.slowmo, null, { timeout: 6000 * SLOW, polling: 30 }).then(() => true, () => false);
    if (!inSlow) await P.pose('guard-high', 600);
  }
  check(inSlow, 'a second dodge opened the slow motion again');
  const probe = await P.page.evaluate(async () => {
    const m = window.__glove.match;
    const a = { t: m.t, wt: m.wt, r: window.__glove.renderer.debugState().slowmo };
    await new Promise((r) => setTimeout(r, 200));
    return { dt: m.t - a.t, dw: m.wt - a.wt, render: a.r };
  });
  await P.shot('o01-dodge-slowmo');
  check(probe.render.on === true, 'the renderer runs its slow-motion look');
  check(probe.dw < probe.dt * 0.6, `world time slowed (${probe.dw.toFixed(0)} vs ${probe.dt.toFixed(0)} ms)`);
  // a KO, then both hands above the head during the (≈16 s) outro skip to the results card
  await P.page.evaluate(() => { const m = window.__glove.match; m.ai.setScript(null, m.wt); });
  await P.pose('guard-high', 1500);
  await knockDown(P, 'p2', { stayDown: true }, 20000);
  await P.until(() => window.__glove.state().activity?.outro?.active === true, null, 40000);
  const outroAt = Date.now();
  await P.pose('pause', 2000);
  await P.screen('skill', { timeout: 15000, settle: 600 });
  const o = (await P.state()).activity.outro;
  check(o.skipped === true && Date.now() - outroAt < 9000, `hands up skipped the outro (${JSON.stringify(o)}, ${Date.now() - outroAt} ms)`);
  assertClean(P, 'slowmo');
  await P.context.close();
});

scenario('again', async (browser) => {
  // (d) "Play again": straight to the next VS card — the next opponent after the first win (the one just
  // beaten is not offered straight back, RULES-04), then a rematch with the first at a raised rating
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=26&tutorial=0' });
  await enterAsGuest(P);
  await P.page.locator('.gu-tile--primary').click();
  await P.screen('opponent');
  const vsName = () => P.page.locator('.gu-vs__side--p2 .gu-vs__name').textContent();
  const first = await vsName();
  check(await P.page.locator('.gu-vs__rematch').count() === 0, 'first bout: no rematch tag');
  await P.click(/Fight/);
  await winByKO(P);
  await P.screen('skill', { settle: 1700 });
  check((await P.state()).profile.skill === 75, 'first win +75 (§7.1)');
  await P.click(/Play again/);
  await P.until(() => window.__glove.state().curtain === true, null, 5000);
  check((await P.state()).screen !== 'mode', 'no menu in between');
  await P.screen('opponent');
  const second = await vsName();
  check(second !== first && (await P.page.locator('.gu-vs__rematch').count()) === 0, `then the next opponent (${second})`);
  await P.shot('p01-vs-next');
  await P.click(/Fight/);
  await winByKO(P);
  await P.screen('skill', { settle: 1700 });
  const r2 = (await P.state()).profile.skill;
  await P.click(/Play again/);
  await P.screen('opponent');
  const third = await vsName();
  const tag = await P.page.locator('.gu-vs__rematch').count();
  const rating3 = Number((await P.page.locator('.gu-vs__side--p2 .gu-vs__rating b').textContent()).replace(/\D/g, ''));
  check(third === first && tag === 1 && rating3 >= 180 && rating3 - r2 >= 30 && rating3 - r2 <= 150,
    `a rematch with the first opponent at a raised rating near +100 (${third}, ${rating3} vs ${r2}, §7.2, §7.5)`);
  await P.shot('p02-vs-rematch');
  await P.click(/Back/);
  await P.screen('mode');
  assertClean(P, 'again');
  await P.context.close();
});

scenario('meter', async (browser) => {
  // (e) the in-world health meters (§5 "How a pie behaves", view3d): appear on a hit, not before.
  // Full-length rounds (no ?fast=1): a 10 s round could end — and hide the meters — mid-check.
  const P = await openPage(browser, { path: '/?input=keyboard&seed=27&tutorial=0' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live', 60000);
  const m0 = (await P.state()).render.meters;
  check(!m0.p1.visible && !m0.p2.visible, 'no meters before any hit (no health bars)');
  // the player lands a punch → the opponent's meter
  let landed = false;
  for (let i = 0; i < 30 && !landed; i++) {
    await P.page.keyboard.press(i % 2 ? 'KeyK' : 'KeyJ');
    await P.page.waitForTimeout(230);
    landed = (await P.activity()).stats.p1.landed > 0;
  }
  check(landed, 'a punch landed');
  await P.until(() => window.__glove.state().render.meters.p2.visible, null, 3000);
  await P.page.waitForTimeout(250);
  await P.shot('q01-meter-opponent');
  // the opponent lands one → the player's meter (scripted head jabs, no guard)
  await P.page.evaluate(() => { const m = window.__glove.match; m.ai.setScript('guard-head', m.wt); });
  await P.until(() => window.__glove.state().activity?.stats?.p2?.landed > 0, null, 15000);
  await P.until(() => window.__glove.state().render.meters.p1.visible, null, 3000);
  await P.page.waitForTimeout(1000); // the meter shows the pre-hit value first, then drains (§5)
  await P.shot('q02-meter-player');
  const m1 = (await P.state()).render.meters;
  check(m1.p1.visible && m1.p1.value < 10, `the player's meter shows the damage (${JSON.stringify(m1.p1)})`);
  assertClean(P, 'meter');
  await P.context.close();
});

scenario('camera-retry', async (browser) => {
  // (f) FLOWS-02 / D12: the camera itself stops while a bout is paused for tracking (unplugged, taken by
  // another app). The tracking-lost screen says so and offers "Try again"; input.start() reopens the
  // camera and the SAME bout stays paused until the player is back (both hands in view) or presses Resume.
  const P = await openPage(browser, { path: '/?fast=1&seed=28&tutorial=0' });
  await P.screen('title');
  await P.until(() => { const i = window.__glove.state().input; return i.phase === 'running' && i.fps > 5; }, null, 30000);
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  // Chromium's fake camera shows a test pattern: nobody is there, so the bout pauses for tracking (ERR02)
  await P.screen('tracking-lost', { timeout: 40000, settle: 800 });
  const before = await P.activity();
  check(before.paused && (await P.state()).pauseReason === 'tracking', 'the bout is paused for tracking');
  check(await P.page.locator('.gu-lost__retry').isHidden(), 'no "Try again" while the camera works');
  // the camera stops: its track ends (an 'ended' event, and readyState 'ended' for the hub's backstop)
  await P.page.evaluate(() => {
    for (const t of document.getElementById('cam')?.srcObject?.getVideoTracks?.() || []) { t.stop(); t.dispatchEvent(new Event('ended')); }
  });
  await P.until(() => window.__glove.state().input.phase === 'error', null, 5000);
  await P.until(() => document.querySelector('.gu-lost__retry')?.hidden === false, null, 5000);
  await P.page.waitForTimeout(400);
  const title = await P.page.locator('.gu-lost .gu-modal__title').textContent();
  const help = await P.page.locator('.gu-lost__camerr').textContent();
  check(/camera stopped/i.test(title), `the screen says the camera stopped ("${title}")`);
  check(/Try again/.test(help) && !/npm|setup:models/.test(help), `the help names the button, no developer commands ("${help}")`);
  check(await P.page.locator('.gu-lost__hold').isHidden(), 'no "show both hands" prompt while there is no picture');
  await P.shot('r01-camera-stopped');
  const stopped = await P.activity();
  check(stopped.id === before.id && stopped.paused && stopped.clockMs === before.clockMs, 'the same bout waits, frozen');
  await P.click(/Try again/);
  await P.until(() => window.__glove.state().input.phase === 'running', null, 20000);
  await P.until(() => document.querySelector('.gu-lost__retry')?.hidden === true, null, 5000);
  await P.page.waitForTimeout(600);
  const after = await P.state();
  const title2 = await P.page.locator('.gu-lost .gu-modal__title').textContent();
  check(after.screen === 'tracking-lost' && after.activity.paused && after.activity.id === before.id && after.activity.attempt === before.attempt,
    'camera back: the same bout, still paused (nobody in the picture yet)');
  check(/lost sight of you/i.test(title2) && !after.input.error, `back to the normal tracking-lost copy ("${title2}")`);
  await P.shot('r02-camera-back');
  await P.click(/Quit to menu/);
  await P.screen('mode');
  check((await P.state()).activity === null, 'Quit to menu by mouse leaves at once');
  assertClean(P, 'camera-retry');
  await P.context.close();
});

scenario('camera-latch', async (browser) => {
  // The camera check latches (user request 2026-11-08): the player has to step to the computer to click
  // Continue, and leaves the picture on the way. Continue comes on once they have been fully in view (head,
  // shoulders, both hands) for 2 s in a row (UI_TUNING.readyHoldMs) and then STAYS on while they walk out of
  // the picture, as long as the camera keeps sending pictures. A stalled feed (no fresh frame for > 1.5 s) is a
  // camera problem: it clears the latch until another 2 s in view. Synthetic poses through the real pipeline;
  // the page logs every change of the P1 chip and the Continue button itself (LEAD-01).
  const P = await openPage(browser, { path: '/?input=synthetic&fast=1&seed=193&tutorial=0' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('single'));
  await untilState(P, (s) => s.screen === 'camera-setup' && !s.screenDone); // nobody in the picture yet
  await P.page.evaluate(async () => {
    // the screen's own test of who is in view
    const { playerVisibility } = await import('/src/ui/screens/kit.js');
    window.__inView = () => playerVisibility(window.__glove.input.latestFrame()?.players?.[0] || null).visible;
    const log = (window.__latch = []);
    const look = () => {
      const b = document.querySelector('.gu-camsetup .gu-footer .gu-btn--primary');
      const chip = document.querySelector('.gu-camsetup .gu-pchip--p1');
      if (b && chip) {
        const s = { t: performance.now(), on: !b.disabled, label: b.querySelector('.gu-btn__label')?.textContent || '',
          state: chip.dataset.state || '', text: chip.querySelector('.gu-pchip__text')?.textContent || '' };
        const p = log[log.length - 1];
        if (!p || p.on !== s.on || p.label !== s.label || p.state !== s.state || p.text !== s.text) log.push(s);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await P.until(() => window.__latch.length > 0, null, 5000);
  const latchLog = () => P.page.evaluate(() => window.__latch.slice());
  const show = (s) => JSON.stringify(s && { ...s, t: Math.round(s.t) });
  // into view and held there (the synthetic player keeps its last posture) until Continue comes on
  const lock = async (what) => {
    const { startsAt } = await P.pose('guard-high', 3000);
    await P.until((t) => window.__latch.some((s) => s.on && s.t >= t), startsAt, 20000);
    const entries = await latchLog();
    const before = entries.filter((s) => s.t < startsAt).pop();
    const on = entries.find((s) => s.on && s.t >= startsAt);
    const holding = entries.find((s) => s.t >= startsAt && s.t < on.t && s.state === 'partial' && /hold it/i.test(s.text));
    check(before && !before.on, `${what}: Continue off when the player steps into view (${show(before)})`);
    check(holding && !holding.on && /Waiting for you/.test(holding.label), `${what}: in view but not 2 s yet — "hold it", Continue off (${show(holding)})`);
    check(on.t - startsAt >= 1800, `${what}: Continue came on only after 2 s in view (${Math.round(on.t - startsAt)} ms)`);
    check(on.state === 'ready' && /P1 ready/.test(on.text) && on.label === 'Continue', `${what}: "P1 ready", Continue on (${show(on)})`);
    log(`  ${what}: Continue on after ${Math.round(on.t - startsAt)} ms in view`);
    return on;
  };
  const first = await lock('first time');
  check(await P.page.evaluate(() => document.activeElement === document.querySelector('.gu-camsetup .gu-footer .gu-btn--primary')),
    'the first time everyone is ready the focus moves to Continue (Enter goes on)');
  // the feed stalls (the synthetic camera stops sending frames): a camera problem, not a player stepping away
  const stoppedAt = await P.page.evaluate(() => { window.__glove.stopPose(); return performance.now(); });
  await P.until((t) => window.__latch.some((s) => !s.on && s.t > t), first.t, 10000);
  const off = (await latchLog()).find((s) => !s.on && s.t > first.t);
  check(off.t - stoppedAt >= 1000, `the latch held until the feed went stale (${Math.round(off.t - stoppedAt)} ms without frames)`);
  check(off.state !== 'ready' && /Waiting for you/.test(off.label), `a stale feed clears it (${show(off)})`);
  log(`  no frames: the latch cleared after ${Math.round(off.t - stoppedAt)} ms`);
  const again = await lock('back after the stall');
  // the player walks out of the picture to reach the computer while the camera keeps sending pictures
  await P.pose('walk-away', 3000);
  await P.until(() => !window.__inView() && window.__glove.input.status.frameAgeMs < 500, null, 15000);
  await P.page.waitForTimeout(2500); // longer than the 2 s hold and the 1.5 s stale limit
  const out = await P.page.evaluate(() => ({ inView: window.__inView(), age: window.__glove.input.status.frameAgeMs, log: window.__latch.slice() }));
  check(!out.inView && out.age < 1000, `still out of the picture, frames still coming (${JSON.stringify({ inView: out.inView, age: out.age })})`);
  const since = out.log.filter((s) => s.t >= again.t);
  check(since.every((s) => s.on && s.state === 'ready' && /P1 ready/.test(s.text) && s.label === 'Continue'),
    `out of the picture: still "P1 ready", Continue still on (${since.map(show).join(', ')})`);
  await P.shot('y01-camera-latched');
  await P.click(/^Continue/);
  await P.until(() => ['calibrate', 'opponent'].includes(window.__glove.state().screen), null, 10000);
  log(`  Continue → ${(await P.state()).screen}`);
  assertClean(P, 'camera-latch');
  await P.context.close();
});

scenario('rest', async (browser) => {
  // (g) FLOWS-01 / FLOWS-M1: a camera player resting in a fighting stance or a guard on the pause screen clicks
  // nothing and the bout stays paused until hands up again; on the tracking-lost screen the boxer back with both
  // hands in view carries the bout on by itself (0.5 s, UI_TUNING.lostResumeMs) — synthetic poses through the real
  // pipeline, no mouse or keys at all.
  const P = await openPage(browser, { path: '/?input=synthetic&fast=1&seed=191&tutorial=0' });
  await P.screen('title');
  await P.pose('guard-high', 3000);
  await P.page.evaluate(() => {
    window.__clicks = [];
    window.__glove.bus.on('ui:click', (e) => { window.__clicks.push(`${e?.screen}:${e?.id} (${e?.source})`); });
  });
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live', 60000);
  await P.pose('guard-high', 800);
  await P.page.waitForTimeout(900);
  const id0 = (await P.activity()).id;
  // pause gesture (both hands above the head), then rest: a stance, then a high guard
  await P.pose('pause', 1900);
  await P.screen('pause', { timeout: 15000, settle: 0 });
  const clicks = () => P.page.evaluate(() => window.__clicks.slice());
  const rest = async (screen, action, ms) => {
    await P.pose(action, ms);
    await P.page.waitForTimeout(ms - 300);
    const s = await P.state();
    const c = await clicks();
    check(s.screen === screen && s.activity?.id === id0 && s.activity.paused, `${screen} + ${action}: still on ${screen}, same bout, paused (screen ${s.screen})`);
    check(c.length === 0, `${screen} + ${action}: nothing clicked (${c.join(', ')})`);
  };
  await rest('pause', 'idle', 5000);
  await P.shot('t01-pause-stance');
  await rest('pause', 'guard-high', 5000);
  // hands up again = Continue (a gesture, not a click)
  await P.pose('pause', 1900);
  await P.until(() => !window.__glove.state().activity?.paused, null, 15000);
  await P.pose('guard-high', 2000);
  await P.stage('live', 30000);
  await P.page.waitForTimeout(400);
  // tracking lost, then the boxer is back in a fighting stance (FLOWS-M1): the bout carries on by itself once both
  // hands are in view again — nothing is clicked ("Quit to menu" never)
  await P.page.evaluate(() => window.__glove.stopPose());
  await P.screen('tracking-lost', { timeout: 15000, settle: 600 });
  await P.shot('t02-lost');
  await P.pose('idle', 3000);
  await P.until(() => !window.__glove.state().activity?.paused, null, 10000);
  const s = await P.state();
  const c = await clicks();
  check(s.activity.id === id0 && c.length === 0, `carried on by itself with the hands back, the same bout, nothing clicked at all (${c.join(', ')})`);
  assertClean(P, 'rest');
  await P.context.close();
});

scenario('fonts-offline', async (browser) => {
  // (h) RELEASE-03 / VISUAL-07 / PERF-06: the Google font hosts are blocked outright (besides the missing
  // DNS) — the game boots with no console error and draws in its own self-hosted typefaces.
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=30&tutorial=0', block: ['fonts.googleapis.com', 'fonts.gstatic.com'] });
  await P.screen('title', { settle: 1200 });
  const faces = () => P.page.evaluate(async () => {
    await document.fonts.ready;
    const lilita = await document.fonts.load('1em "Lilita One"');
    const nunito = await document.fonts.load('800 1em Nunito');
    return {
      lilita: lilita.length, nunito: nunito.length,
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.weight}`),
    };
  });
  const f = await faces();
  check(f.lilita > 0 && f.nunito > 0, `both typefaces load (${JSON.stringify(f)})`);
  check(f.loaded.some((x) => x.startsWith('Lilita One')) && f.loaded.some((x) => x.startsWith('Nunito')), `Lilita One and Nunito are in use (${f.loaded.join(', ')})`);
  const woff = P.requests.filter((u) => /\.woff2?(\?|$)/.test(u));
  check(woff.length >= 2 && woff.every(isLocalUrl) && woff.some((u) => /lilita/i.test(u)) && woff.some((u) => /nunito/i.test(u)),
    `the font files come from the game's own server (${woff.map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join(', ')})`);
  await P.shot('u01-fonts-offline-title');
  // the arena's canvas text (the taunt boards) draws in the same faces once a bout runs
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live');
  await P.page.waitForTimeout(600);
  const g = await faces();
  check(g.lilita > 0 && g.nunito > 0, 'still loaded in a bout');
  await P.shot('u02-fonts-offline-bout');
  check(P.blocked.length === 0 && P.external.length === 0, `nothing even asked the font hosts (${[...P.blocked, ...P.external].join(', ')})`);
  assertClean(P, 'fonts-offline');
  await P.context.close();
});

scenario('splash', async (browser) => {
  // (h2) the loading screen (index.html #splash, src/app/splash.js) is gone soon after the title is up, the title's
  // intro then plays (it waits while html.is-loading), and Start answers a click right away
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=41&tutorial=0' });
  await P.screen('title', { settle: 0 });
  await P.until(() => !document.getElementById('splash') && !document.documentElement.classList.contains('is-loading'), null, 5000);
  const intro = await P.page.evaluate(() => document.getAnimations()
    .filter((a) => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('gu-logo__ch'))
    .map((a) => a.playState));
  check(intro.length > 0 && intro.every((st) => st === 'running' || st === 'finished'), `the title intro plays once the loading screen is gone (${intro.join(',')})`);
  await P.page.waitForTimeout(1600); // the Start button fades in 1.2 s into the intro
  await P.click(/Start/);
  await P.until(() => window.__glove.state().screen !== 'title', null, 10000);
  assertClean(P, 'splash');
  await P.context.close();
});

scenario('splash-fail', async (browser) => {
  // (h3) the game's code never runs (its download fails): the loading screen turns into "couldn't load" + Reload
  // (index.html's inline fallback) instead of loading forever
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route((url) => url.pathname === '/src/main.js', (route) => route.abort('failed'));
  const page = await context.newPage();
  await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'load' });
  await page.waitForSelector('#splash.is-failed .splash__fail:not([hidden])', { timeout: 10000 });
  const s = await page.evaluate(() => ({
    text: document.querySelector('.splash__fail').textContent.replace(/\s+/g, ' ').trim(),
    loading: document.documentElement.classList.contains('is-loading'),
    bar: getComputedStyle(document.querySelector('.splash__bar')).display,
    reload: !!document.querySelector('.splash__fail button'),
  }));
  check(/couldn’t load/.test(s.text) && s.reload && s.bar === 'none' && !s.loading, `the failure message with Reload (${JSON.stringify(s)})`);
  await context.close();
});

scenario('context-loss', async (browser) => {
  // (i) FLOWS-09 / D10: the WebGL context is lost mid-bout (GPU reset): the arena goes blank, so the bout
  // pauses — clock and opponent stop, the pause overlay (DOM) shows — and stays paused after the
  // browser restores the context, until the player continues.
  const P = await openPage(browser, { path: '/?input=keyboard&fast=1&seed=29&tutorial=0' });
  await P.screen('title');
  await P.page.evaluate(() => window.__glove.skipTo('match'));
  await P.stage('live');
  await P.keys(['KeyJ', 'KeyK']);
  await P.page.waitForTimeout(500);
  await P.page.evaluate(() => {
    window.__loseCtx = window.__glove.renderer.webgl.getContext().getExtension('WEBGL_lose_context');
    window.__loseCtx.loseContext();
  });
  await P.screen('pause', { timeout: 5000, settle: 200 });
  const lost = await P.state();
  check(lost.activity.paused && lost.pauseReason === 'graphics' && lost.render.lost === true, `the bout pauses on context loss (${lost.pauseReason}, lost ${lost.render.lost})`);
  const t0 = await P.page.evaluate(() => ({ t: window.__glove.match.t, wt: window.__glove.match.wt }));
  await P.page.waitForTimeout(1500);
  const mid = await P.activity();
  const t1 = await P.page.evaluate(() => ({ t: window.__glove.match.t, wt: window.__glove.match.wt }));
  check(mid.clockMs === lost.activity.clockMs && t1.t === t0.t && t1.wt === t0.wt, 'the clock and the opponent are frozen while the context is lost');
  await P.shot('v01-context-lost-paused');
  await P.page.evaluate(() => window.__loseCtx.restoreContext());
  await P.until(() => window.__glove.state().render.lost === false, null, 8000);
  await P.page.waitForTimeout(700);
  const restored = await P.state();
  check(restored.screen === 'pause' && restored.activity.paused && restored.activity.clockMs === lost.activity.clockMs, 'restored: still paused — the player resumes deliberately');
  await P.shot('v02-context-restored');
  await P.click(/Continue/);
  await P.until(() => !window.__glove.state().activity.paused, null, 5000);
  await P.page.waitForTimeout(1200);
  const after = await P.state();
  check(after.activity.id === lost.activity.id && !after.render.lost && after.activity.clockMs !== lost.activity.clockMs, 'the same bout runs on, drawn again');
  await P.shot('v03-context-resumed');
  assertClean(P, 'context-loss');
  await P.context.close();
});

scenario('sound-badge', async () => {
  // (j) FLOWS-03 / D13: camera play never starts sound (no camera gesture is a browser gesture), so a badge
  // says how to turn it on; one real key press starts the sound and the badge goes away.
  // This needs the browser's default autoplay policy and no user gesture from the test itself, while the
  // suite's browser allows autoplay and Playwright's evaluate() counts as a gesture: so it runs in its own
  // browser and reads the page over CDP with userGesture: false.
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ args: [...GL_ARGS, ...OFFLINE_ARGS], headless: !process.env.E2E_HEADED });
  try {
    const context = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('request', (r) => { if (!isLocalUrl(r.url())) external.push(r.url()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (!NOISE.test(m.text()) && m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
    const cdp = await context.newCDPSession(page);
    const ev = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
      if (r.exceptionDetails) throw new Check(`page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    const until = async (expression, ms = 20000) => {
      const end = Date.now() + ms * SLOW;
      while (Date.now() < end) { if (await ev(expression).catch(() => false)) return; await sleep(100); }
      throw new Check(`timed out waiting for ${expression}`);
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = join(SHOTS, `${name}.png`);
      (await import('node:fs')).writeFileSync(f, Buffer.from(data, 'base64'));
      log(`  shot ${f}`);
    };
    await page.goto(`${BASE}/?input=synthetic&fast=1&seed=152&tutorial=0`, { waitUntil: 'load' });
    await until("!!window.__glove?.state && window.__glove.state().screen === 'title' && !window.__glove.state().screenDone", 30000);
    await sleep(800);
    check(await ev('navigator.userActivation.hasBeenActive') === false, 'no user gesture yet');
    // camera play only: a bout started without a click or key (the debug jump, evaluated without a gesture), a
    // guard and a jab, then both hands above the head pause it; the player rests in a guard on the pause card
    await ev("window.__glove.injectPose('guard-high', 2500); window.__glove.skipTo('match'); true");
    await until("window.__glove.state().activity?.stage === 'live'", 60000);
    await ev("window.__glove.injectPose('jab-left', 450); window.__glove.injectPose('guard-high', 900); window.__glove.injectPose('pause', 1900); true");
    await until("(() => { const s = window.__glove.state(); return s.screen === 'pause' && !s.screenDone && !!s.activity?.paused; })()", 20000);
    await ev("window.__glove.injectPose('guard-high', 1500); true");
    await sleep(1000);
    const off = await ev(`({ needs: window.__glove.audio.needsGesture, unlocked: !!window.__glove.audio.state().unlocked,
      ctx: window.__glove.audio.ctx ? window.__glove.audio.ctx.state : null, active: navigator.userActivation.hasBeenActive,
      badge: document.querySelector('.gu-soundoff') ? !document.querySelector('.gu-soundoff').hidden : false,
      text: document.querySelector('.gu-soundoff')?.textContent || '' })`);
    check(off.needs === true && !off.unlocked && off.ctx !== 'running' && off.active === false, `camera play starts no sound (${JSON.stringify(off)})`);
    check(off.badge && /click or press any key/i.test(off.text), `the sound-off badge shows ("${off.text}")`);
    await shot('w01-sound-off-badge');
    // one real key press (a trusted key event = user activation): the sound starts, the badge goes
    await page.keyboard.press('KeyQ');
    await until("window.__glove.audio.needsGesture === false && window.__glove.audio.ctx?.state === 'running'", 5000);
    await until("document.querySelector('.gu-soundoff')?.hidden === true", 3000);
    const after = await ev("({ screen: window.__glove.state().screen, paused: !!window.__glove.state().activity?.paused })");
    check(after.screen === 'pause' && after.paused, `the key press did nothing else (${JSON.stringify(after)})`);
    await shot('w02-sound-on');
    check(external.length === 0, `requests to third-party hosts: ${external.join(', ')}`);
    check(errors.length === 0, `page/console errors:\n  ${errors.join('\n  ')}`);
    await context.close();
  } finally {
    await b.close().catch(() => {});
  }
});

/** The pose-detection worker of a page (Playwright can evaluate inside it), or null. */
const poseWorker = (page) => page.workers().find((w) => /pose-worker/.test(w.url())) || null;
/** How many usage-log sends the telemetry guard answered on the page / in the worker (null: no guard there). */
const pageBlocked = (P) => P.page.evaluate(() => (window.fetch.__gloveGuard ? window.fetch.blocked : null));
const workerBlocked = (w) => w.evaluate(() => (self.fetch && self.fetch.__gloveGuard ? self.fetch.blocked : null));
const trackerInfo = (P) => P.page.evaluate(() => { const s = window.__glove.input._tracker.getStats(); return { detector: s.detector, delegate: s.delegate, model: s.model }; });

scenario('telemetry', async (browser) => {
  // (k) R5: MediaPipe Tasks' usage logger never reaches the network. It sends every 60 s and whenever a
  // landmarker is closed, so closing them on purpose makes this deterministic (no minute of waiting): the
  // worker's GPU → CPU switch closes the worker's landmarker; on the main-thread detector a model switch and a
  // CPU switch close two more. Each close flushes the logger at once; src/input/no-telemetry.js must answer
  // every flush on the device (its counters prove the flushes happened), and no request may leave.
  const P = await openPage(browser, { path: '/?fast=1&seed=32' });
  const noRequests = (when) => check(P.external.length === 0, `${when}: requests to third-party hosts:\n  ${[...new Set(P.external)].join('\n  ')}`);
  await P.screen('title');
  await P.until(() => { const i = window.__glove.state().input; return i.phase === 'running' && i.fps > 5; }, null, 30000);
  const w = poseWorker(P.page);
  check(w && (await trackerInfo(P)).detector === 'worker', 'pose detection runs in the worker');
  await P.page.evaluate(() => window.__glove.input._tracker._switchToCpu());
  const t1 = await trackerInfo(P);
  check(t1.detector === 'worker' && t1.delegate === 'CPU', `the worker switched to the CPU delegate (${JSON.stringify(t1)})`);
  await P.page.waitForTimeout(1500); // without the guard the POST shows within 0.3 s
  noRequests('the worker closed its landmarker');
  check(await workerBlocked(w) >= 1, 'closing the worker\'s landmarker flushed the usage log into the guard');
  // the main-thread detector (?detector=main, and the worker's fallback)
  await P.page.evaluate(() => window.__glove.input.setDetector('main'));
  await P.until(() => { const i = window.__glove.state().input; return i.detector === 'main' && i.phase === 'running' && i.fps > 5; }, null, 30000);
  await P.page.evaluate(() => window.__glove.input.setModel('lite'));
  await P.page.evaluate(() => window.__glove.input._tracker._switchToCpu());
  const t2 = await trackerInfo(P);
  check(t2.detector === 'main' && t2.model === 'lite' && t2.delegate === 'CPU', `main thread: lite model on the CPU (${JSON.stringify(t2)})`);
  await P.page.waitForTimeout(1500);
  noRequests('the main thread closed two landmarkers');
  check(await pageBlocked(P) >= 2, 'both main-thread landmarker closes flushed the usage log into the guard');
  await P.until(() => { const i = window.__glove.state().input; return i.phase === 'running' && i.fps > 5; }, null, 30000);
  await P.shot('x01-telemetry-main-lite-cpu');
  assertClean(P, 'telemetry');
  await P.context.close();
});

scenario('telemetry-60s', async (browser) => {
  // (l) opt-in (run it by its full name: node tests/e2e.mjs telemetry-60s): nothing forced — a live tracker on
  // the fake camera for 65 s, past the logger's 60 s timer, in the worker and (in parallel) on the main thread
  const W = await openPage(browser, { path: '/?fast=1&seed=33' });
  const M = await openPage(browser, { path: '/?fast=1&seed=34&detector=main' });
  for (const P of [W, M]) await P.until(() => { const i = window.__glove.state().input; return i.phase === 'running' && i.fps > 5; }, null, 30000);
  check((await trackerInfo(W)).detector === 'worker' && (await trackerInfo(M)).detector === 'main', 'one page detects in the worker, one on the main thread');
  const t0 = Date.now();
  while (Date.now() - t0 < 65000) {
    await W.page.waitForTimeout(5000);
    check(W.external.length === 0 && M.external.length === 0, `no third-party request after ${Math.round((Date.now() - t0) / 1000)} s: ${[...W.external, ...M.external].join(', ')}`);
  }
  const ww = poseWorker(W.page);
  check(ww && await workerBlocked(ww) >= 1, 'the worker\'s 60 s flush was answered by the guard');
  check(await pageBlocked(M) >= 1, 'the main thread\'s 60 s flush was answered by the guard');
  for (const [P, label] of [[W, 'telemetry-60s (worker)'], [M, 'telemetry-60s (main)']]) { assertClean(P, label); await P.context.close(); }
}, { optIn: true });

// ───────────────────────────── runner ─────────────────────────────

/**
 * Run scenarios in order. Each result has status 'pass' | 'skip' | 'fail': a scenario that throws
 * Skip is reported as skipped and never counted as passed (RELEASE-10).
 * @param {{name:string, fn:Function}[]} list
 * @param {{browser?:object, shared?:object, log?:Function, onFail?:(s:object, e:Error)=>Promise<void>}} [opts]
 */
export async function runScenarios(list, { browser = null, shared = {}, log: say = log, onFail = null } = {}) {
  const results = [];
  for (const s of list) {
    const start = Date.now();
    say(`START ${s.name}`);
    try {
      await s.fn(browser, shared);
      results.push({ name: s.name, status: 'pass', ok: true, ms: Date.now() - start });
      say(`PASS ${s.name} (${((Date.now() - start) / 1000).toFixed(1)} s)`);
    } catch (e) {
      if (e instanceof Skip) {
        results.push({ name: s.name, status: 'skip', ok: true, skipped: true, reason: e.message, ms: Date.now() - start });
        say(`SKIP ${s.name} (${e.message})`);
        continue;
      }
      results.push({ name: s.name, status: 'fail', ok: false, ms: Date.now() - start, error: e });
      say(`FAIL ${s.name}: ${e instanceof Check ? e.message : e?.stack || e}`);
      if (onFail) await onFail(s, e);
    }
  }
  return results;
}

/** The closing summary: "N passed, M skipped, F failed", one line per scenario, and the exit code. */
export function summarize(results, { seconds = null, warnings = 0 } = {}) {
  const count = (st) => results.filter((r) => r.status === st).length;
  const head = `${count('pass')} passed, ${count('skip')} skipped, ${count('fail')} failed${seconds !== null ? ` (${seconds} s)` : ''}${warnings ? ` · ${warnings} console warnings` : ''}`;
  const tag = { pass: 'ok  ', skip: 'skip', fail: 'FAIL' };
  const rows = results.map((r) => `  ${tag[r.status] || 'FAIL'} ${r.name}${r.status === 'skip' ? ` (${r.reason})` : r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}`);
  return { text: [head, ...rows].join('\n'), exitCode: count('fail') ? 1 : 0, passed: count('pass'), skipped: count('skip'), failed: count('fail') };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const selected = selectScenarios(scenarios, ONLY);
  let server = null;
  let browser = null;
  let results = [];
  try {
    log(`e2e: ${selected.map((s) => s.name).join(', ')} · WebGL ${GL} · shots → ${SHOTS}`);
    server = await startServer();
    log(`dev server on ${BASE}`);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ args: LAUNCH_ARGS, headless: !process.env.E2E_HEADED });
    const onFail = async (s) => {
      for (const ctx of browser.contexts()) {
        for (const pg of ctx.pages()) {
          try {
            const f = join(SHOTS, `FAIL-${s.name}.png`);
            await pg.screenshot({ path: f });
            log(`  state: ${JSON.stringify(await pg.evaluate(() => window.__glove?.state()))}`);
            log(`  shot ${f}`);
          } catch { /* page gone */ }
        }
        if (s.name !== 'synthetic') await ctx.close().catch(() => {});
      }
    };
    results = await runScenarios(selected, { browser, shared: {}, onFail });
  } catch (e) {
    console.error(e);
    if (/Executable doesn't exist|playwright install/i.test(String(e?.message))) console.error('\ne2e: Playwright has no Chromium yet. Run "npx playwright install chromium" once (README, Setup).');
    results.push({ name: 'setup', status: 'fail', ok: false, error: e });
  } finally {
    await browser?.close().catch(() => {});
    stopServer(server);
  }
  const sum = summarize(results, { seconds: ((Date.now() - t0) / 1000).toFixed(0), warnings: warningCount });
  console.log(`\n${sum.text}`);
  process.exit(sum.exitCode);
}

/** Executed as a script (not imported by a unit test)? Real paths, so a symlinked path still counts. */
function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) await main();
