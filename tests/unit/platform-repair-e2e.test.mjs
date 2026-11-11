// R5 / LEAD-01: the e2e runner. Importing tests/e2e.mjs runs nothing (no server, no browser).
//  * The deterministic telemetry scenario is part of every default run; the ≥ 65 s variant is opt-in and runs
//    only when named in full (so `node tests/e2e.mjs telemetry` stays quick).
//  * Word selection is unchanged otherwise ('synthetic' also runs 'lost', which continues its page).
//  * The suite's browser runs without speech synthesis: a speaking headless browser answered the runner seconds late.
//  * The input helpers never depend on catching a short-lived state from outside the page (LEAD-01). They are
//    driven here against a scripted stand-in for the page: their predicates run against a fake `window`, and
//    every poll or wait of the runner moves the scripted game on by one step.
import { test, assert } from '../harness.mjs';

const { scenarios, selectScenarios, knockDown, winByKO, pressDuringOutro, holdUntil, retryUntil, Check, SLOW, LAUNCH_ARGS } = await import('../e2e.mjs');
const names = (list) => list.map((s) => s.name);

test('e2e: the telemetry scenario runs by default; telemetry-60s only when named in full', () => {
  const all = names(scenarios);
  assert(all.includes('telemetry') && all.includes('telemetry-60s'), all.join());
  assert(scenarios.find((s) => s.name === 'telemetry-60s').optIn === true);
  assert(!scenarios.find((s) => s.name === 'telemetry').optIn);
  const def = names(selectScenarios(scenarios, []));
  assert(def.includes('telemetry') && !def.includes('telemetry-60s'), def.join());
  assert.equal(def.length, all.length - 1, 'every other scenario runs by default');
  assert.deepEqual(names(selectScenarios(scenarios, ['telemetry'])), ['telemetry']);
  assert.deepEqual(names(selectScenarios(scenarios, ['telemetry-60s'])), ['telemetry-60s']);
  assert.deepEqual(names(selectScenarios(scenarios, ['synthetic'])), ['synthetic', 'lost']);
  const cam = names(selectScenarios(scenarios, ['camera']));
  assert(cam[0] === 'camera' && cam.includes('camera-retry'), cam.join()); // a word picks every scenario named with it
  assert.deepEqual(cam, all.filter((n) => n.includes('camera')));
});

test('e2e: the suite browser has no speech synthesis (it stalled the runner during spoken counts) and no DNS but the local server', () => {
  assert(LAUNCH_ARGS.includes('--disable-speech-api'), LAUNCH_ARGS.join(' '));
  assert(LAUNCH_ARGS.some((a) => /^--host-resolver-rules=MAP \* ~NOTFOUND , EXCLUDE 127\.0\.0\.1/.test(a)), LAUNCH_ARGS.join(' '));
});

/** A scripted game behind a fake `window.__glove`: `tick()` is one step of game time (one poll or wait). */
function fakeGame({ phases = ['fighting'], outroAfter = Infinity, outroFor = 10 } = {}) {
  const g = {
    i: 0, phase: phases[0], calls: [], downs: [], presses: [], over: false, outro: null, outroStep: null, step: 0,
    match: {
      debugKnockdown(id, o) {
        g.calls.push(g.phase);
        if (g.phase !== 'fighting') return false;
        g.downs.push({ id, o, step: g.step });
        g.phase = 'knockdown';
        return true;
      },
    },
    tick() {
      g.step++;
      if (g.downs.length) {
        // the count, then the result and the outro
        const since = g.step - g.downs[0].step;
        if (since >= 3) g.over = true;
        if (since === outroAfter) { g.outro = { active: true, skipped: false }; g.outroStep = g.step; }
        if (g.outro?.active && g.step - g.outroStep >= outroFor) g.outro = { active: false, skipped: false };
      } else if (g.phase !== 'knockdown') {
        g.phase = phases[Math.min(++g.i, phases.length - 1)];
      }
    },
    press(key) {
      g.presses.push({ key, outro: g.outro ? { ...g.outro } : null });
      if (key === 'Enter' && g.outro?.active) g.outro = { active: false, skipped: true };
    },
  };
  g.window = { __glove: { get match() { return g.match; }, state: () => ({ activity: { phase: g.phase, round: 1, over: g.over, outro: g.outro } }) } };
  return g;
}

/** The runner's view of a page (the parts the helpers use), on a scripted game. */
function fakeP(g, { maxPolls = 400 } = {}) {
  const keys = [];
  return {
    keys,
    page: {
      evaluate: async (fn, arg) => fn(arg),
      keyboard: {
        press: async (k) => { keys.push(k); g.press(k); },
        down: async (k) => { keys.push(`down:${k}`); },
        up: async (k) => { keys.push(`up:${k}`); },
      },
      waitForTimeout: async () => g.tick(),
    },
    async until(fn, arg = null) {
      for (let i = 0; i < maxPolls; i++) { if (await fn(arg)) return true; g.tick(); }
      throw new Error('page.waitForFunction: Timeout exceeded');
    },
    activity: async () => g.window.__glove.state().activity,
  };
}

async function withWindow(g, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = g.window;
  try { return await fn(); } finally { if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window; }
}

test('e2e helpers: knockDown checks and knocks down in one step, retrying through rounds that are not live', async () => {
  // the bout is between rounds when the runner asks (a round ended on a loaded machine), then live again
  const g = fakeGame({ phases: ['roundEnd', 'between', 'between', 'roundStart', 'fighting'] });
  await withWindow(g, () => knockDown(fakeP(g), 'p2', { stayDown: true }));
  assert.equal(g.downs.length, 1, 'knocked down exactly once');
  assert.deepEqual(g.downs[0], { id: 'p2', o: { stayDown: true }, step: 4 });
  assert.deepEqual(g.calls, ['roundEnd', 'between', 'between', 'roundStart', 'fighting'], 'every attempt is made where the phase is read');
  // never live: a clear failure that names the phase (not a later timeout on another screen)
  const g2 = fakeGame({ phases: ['decision'] });
  const err = await withWindow(g2, () => knockDown(fakeP(g2, { maxPolls: 5 }), 'p2').then(() => null, (e) => e));
  assert(err instanceof Check && /p2 was not knocked down .*phase decision/.test(err.message), String(err?.message));
});

test('e2e helpers: winByKO floors the opponent once the bout is live and waits for the result', async () => {
  const g = fakeGame({ phases: ['intro', 'roundStart', 'fighting'] });
  await withWindow(g, () => winByKO(fakeP(g)));
  assert(g.downs.length === 1 && g.downs[0].o.stayDown === true && g.over, JSON.stringify(g.downs));
});

test('e2e helpers: pressDuringOutro presses from before the outro and stops at the skip', async () => {
  const g = fakeGame({ outroAfter: 6, outroFor: 15 });
  g.match.debugKnockdown('p2', { stayDown: true });
  const P = fakeP(g);
  const skipped = await withWindow(g, () => pressDuringOutro(P, 'Enter'));
  assert.equal(skipped, true);
  assert(g.outro.skipped && !g.outro.active, JSON.stringify(g.outro));
  const before = g.presses.filter((p) => !p.outro);
  assert(before.length >= 3 && g.presses.at(-1).outro?.active === true, `pressed during the count (no-op) and once in the outro (${JSON.stringify(g.presses)})`);
  assert.equal(g.presses.filter((p) => p.outro).length, 1, 'no press after the skip');
});

test('e2e helpers: pressDuringOutro reports an outro that ended before a press reached it (the bout is replayed)', async () => {
  // a 1-step outro that starts and ends between two looks of a stalled runner (each wait is two steps)
  const g = fakeGame({ outroAfter: 3, outroFor: 1 });
  g.match.debugKnockdown('p2', { stayDown: true });
  const P = fakeP(g);
  P.page.waitForTimeout = async () => { g.tick(); g.tick(); };
  const skipped = await withWindow(g, () => pressDuringOutro(P, 'Enter'));
  assert.equal(skipped, false);
  assert(!g.outro.skipped && !g.outro.active, JSON.stringify(g.outro));
  // and no outro at all: a clear failure
  const g2 = fakeGame();
  const err = await withWindow(g2, () => pressDuringOutro(fakeP(g2), 'Enter', 0).then(() => null, (e) => e));
  assert(err instanceof Check && /did not start/.test(err.message), String(err?.message));
});

test('e2e helpers: holdUntil releases the key whether the effect came or not, and names the real timeout', async () => {
  const g = fakeGame();
  let ready = false;
  const P = fakeP(g);
  P.until = async () => { if (!ready) throw new Error('page.waitForFunction: Timeout exceeded'); return true; };
  ready = true;
  await holdUntil(P, 'Space', { done: () => true, label: 'guard card' });
  assert.deepEqual(P.keys, ['down:Space', 'up:Space']);
  ready = false;
  P.keys.length = 0;
  const err = await holdUntil(P, 'KeyB', { done: () => false, label: 'low guard card', timeout: 15000 }).then(() => null, (e) => e);
  assert(err instanceof Check && err.message === `low guard card (held KeyB for ${15000 * SLOW} ms)`, String(err?.message));
  assert.deepEqual(P.keys, ['down:KeyB', 'up:KeyB'], 'released after the failure too');
});

test('e2e helpers: retryUntil repeats the input until the page shows the effect', async () => {
  const g = fakeGame();
  let count = 0;
  const P = fakeP(g);
  const n = await retryUntil(P, { act: async () => { count++; }, done: () => count >= 3, label: 'three punches' });
  assert.equal(n, 3);
});
