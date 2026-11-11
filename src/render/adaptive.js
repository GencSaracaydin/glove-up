// Adaptive render quality (owner: view3d) — PERF-03, PERF-06.
//
// GameRenderer feeds one sample per frame: the wall-clock interval since the previous frame, minus
// the main-thread time that frame spent on work that is not rendering (pose detection: the app
// passes InputHub.lastDetectMs through renderer.setExternalFrameCost). Only the remainder is
// judged, so a camera session whose frame interval is dominated by a synchronous detection no
// longer walks the pixel ratio and the shadow map down for nothing.
//
//   * windows of `windowSec` wall time (after a `warmupSec` warm-up); a window is slow when its
//     average adjusted frame exceeds `slowFrameMs`;
//   * hysteresis: `slowWindows` slow windows in a row before one step down (pixel ratio
//     2 → 1.75 → 1.5 → 1.25 → 1, then the shadow map 2048 → 1024);
//   * recovery: `upAfterSec` of continuous headroom (every window at or under `headroomMs`) takes
//     one step back up (shadow first, then the pixel ratio, never above the starting ratio); when
//     a step up has to be undone soon after, the wait before the next try doubles (`upBackoff`,
//     capped at `upMaxSec`), so a borderline machine does not oscillate.
//
// Pose detection shares the GPU (PERF-06). The render and a GPU pose detector (MediaPipe in its worker)
// run on one GPU, and the render wins: measured on an Apple M3 at a Retina viewport (device pixel ratio 2),
// a bout drawn at pixel ratio 2 kept 60 fps while detection fell to 7–17 poses per second (detect 60–130 ms);
// at 1.25 it was back at 30 (18–20 ms). The frame interval never shows it, so the app also hands over the
// input hub's verdict every frame (setDetectionPressure(InputHub.renderPressure)):
//   * a GPU detector that is behind for `detBehindShare` of a `detWindowSec` window takes one step down,
//     then the next judgement waits `detSettleSec` (the hub's figures need that long to show the step): on a
//     display faster than `capAboveHz` first a frame-rate cap (frameDivisor: the app renders every Nth display
//     frame, ≈ `frameCapHz`), then the pixel ratio steps, then the shadows;
//   * the quality only goes back up while detection has headroom too (render windows with pressure reports
//     count toward the wait only if `detHeadroomShare` of their frames had headroom); the frame cap is the
//     last thing lifted;
//   * a step down needs `detStepWindows` behind windows in a row (one when detection is far behind: below
//     `detFarBehind` of its wanted rate, then two pixel-ratio notches at once — never a pixel-ratio notch and the
//     shadows), so a one-off main-thread stall is not taken for GPU contention;
//   * lag alone (enough poses per second, but a slow median during a bout: pressure.rateBehind false) only takes the
//     cheap steps — the frame cap and the pixel ratio down to `detLagMinRatio`: below that a GPU detector gains ≈ 2–3 ms
//     for a visibly softer picture; a rate that falls behind may take every step;
//   * while the detector starts (pressure.starting: the worker's graph build and first inference) a fast display is
//     capped at once — at 144 fps the render can starve that start-up for tens of seconds;
//   * only a GPU detector's reports gate the steps back up (a CPU detector does not share the GPU), and steps taken for
//     detection come back after `detReleaseSec` of render headroom once no GPU detector reports (detection moved to the
//     CPU, keyboard play): the render no longer competes with anything, so nothing learnt for the GPU detector (ceilings,
//     the headroom a context needs) holds them back.
// No pixel-ratio pumping (RG2; the second pipe verification's L1 run: 10 changes in 100 s at moderate load), per context of
// the hub ('<session>/<activity>': menus or a bout / drill × setup or activity pose budget). Each context keeps:
//   * a ceiling: a level that starved detection after a fair chance — reached by a step up (a probe), or held for
//     `detFairSec` — is not tried again in that context for `detCeilingSec`; `detCeilingRateSec` when a probe starved the
//     RATE within `detQuickSec` (a big cost jump, e.g. the step to pixel ratio 2 on a Retina screen), `detCeilingSlowSec`
//     when the probe held `detQuickSec` first (a borderline level). Flat: they never grow, so they bound how long sharpness
//     waits after a load ends (the merge verifier's RG2-TAIL: doubling ceilings held it up to 271 s). Each level keeps its
//     own horizon (a long one for 2 and a short one for 1.75 end on their own). A further step of a descent, taken while
//     the hub's ≈ 2 s figures still held frames from the level above, sets none. Leaving the context keeps them; coming
//     back restores them;
//   * the headroom it needs before a probe: `upAfterSec`, doubled (up to `upMaxSec`) each time a probe starves detection
//     within `detQuickSec` (a quick failure: clear evidence that level does not fit), back to `upAfterSec` once a probe
//     holds `detProbeOkSec` or a ceiling is lifted early. Headroom is continuous evidence, not a timer: at a borderline
//     level (headroom on and off with the scene) a long requirement is rarely met, while after a load ends it is met as
//     soon as the level below runs freely (headroom counted while a ceiling blocks the step carries over);
//   * the level it settled at: the last level held `detGoodSec` without a detection step down (detection keeping up, or
//     nothing left to give, e.g. lag at the `detLagMinRatio` floor). Entering a context that settled lower than the current
//     level within `detMemorySec` (or whose ceiling holds lower) goes straight there: one change instead of a descent with
//     detection behind on the way (bout → menus → bout); a context entered where it was left carries on;
//   * a ceiling is lifted early when the load really drops: once its level's detection median stays at or below
//     `detLiftRatio` × the median measured there when the ceiling was set (`detLiftRefWindows` windows) for `detLiftSec`
//     with headroom, the next step up follows the usual `upAfterSec` (sharpness back within ≈ 20–30 s after a heavy load).
// A CPU detector, no camera (keyboard) or a fixed quality ('high' / 'low') take no detection steps.
//
// Pure (no DOM / WebGL) so it runs in Node tests.

export const ADAPTIVE_TUNING = Object.freeze({
  warmupSec: 3,
  windowSec: 2.5,
  slowFrameMs: 21,     // a window averaging more than this (adjusted) is slow
  slowWindows: 2,      // consecutive slow windows before a step down
  headroomMs: 17.5,    // a window averaging at most this (≈ every frame on a 60 Hz vsync) has headroom
  upAfterSec: 10,      // continuous headroom before a step back up
  upBackoff: 2,        // × the wait when a step up had to be undone within 2 × upAfterSec …
  upMaxSec: 80,        // … up to this
  ratios: Object.freeze([1.75, 1.5, 1.25, 1]),
  skipFrameSec: 0.1,   // frames this long (tab switches, hitches) are not samples
  // PERF-06: pose detection shares the GPU
  detWarmupSec: 1,       // detection is judged from this long after the start (the render's warm-up is about frame hitches)
  detWindowSec: 1,       // detection pressure judged over windows of this length
  detBehindShare: 0.6,   // … a window is behind when at least this share of its frames had a GPU detector behind
  detStepWindows: 2,     // behind windows in a row before one step (1 when far behind): a one-off main-thread stall is not GPU contention
  detSettleSec: 1,       // after a detection step, wait this long before judging again
  detHeadroomShare: 0.8, // a render window counts toward a step up only if this share of its pressure reports had headroom
  // RG2, per hub context
  detCeilingSec: 120,    // a level that starved detection after a fair chance is not tried again for this long (flat) …
  detCeilingRateSec: 480, // … a probe that starved the RATE within detQuickSec (a big cost jump, e.g. the step to pixel ratio 2) …
  detCeilingSlowSec: 100, // … a probe that held detQuickSec before it starved detection (a borderline level)
  detFairSec: 6,         // a fair chance: reached by a step up (a probe), or held this long; quicker steps are a descent's overshoot
  detQuickSec: 20,       // a probe that starves detection within this long: the context's headroom requirement doubles …
  detProbeOkSec: 60,     // … and goes back to upAfterSec once a probe holds this long
  detGoodSec: 20,        // a level held this long without a detection step down is the level the context settled at …
  detMemorySec: 600,     // … used to go straight there on entering the context, if learnt within this long
  detLiftRefWindows: 5,  // detection windows at a ceiling's level that make its reference median …
  detLiftRatio: 0.7,     // … and a median at or below this share of it (with headroom) …
  detLiftSec: 8,         // … for this long lifts the ceiling early: the load that set it is gone
  detFarBehind: 0.5,     // detection below this share of its wanted rate: two pixel-ratio steps at once
  frameCapHz: 60,        // the frame-rate cap's target …
  capAboveHz: 105,       // … on displays at least this fast (120 / 144 Hz; slower ones would drop well below 60)
  detLagMinRatio: 1.25,  // lag alone never takes the pixel ratio below this, nor the shadows
  detReleaseSec: 2.5,    // no GPU detector reporting: steps taken for detection come back after this much render headroom (one window)
  log: true,             // say why a detection step was taken (browser console only)
});

const msOrZero = (x) => (Number.isFinite(x) && x > 0 ? x : 0);

export class AdaptiveQuality {
  /**
   * @param {{maxRatio?:number, enabled?:boolean, tuning?:Partial<typeof ADAPTIVE_TUNING>}} [o]
   *   maxRatio: the starting (and highest) pixel ratio; enabled: false = a fixed quality ('high'/'low').
   */
  constructor({ maxRatio = 2, enabled = true, tuning = null } = {}) {
    this.T = { ...ADAPTIVE_TUNING, ...(tuning || {}) };
    this.enabled = !!enabled;
    this.maxRatio = maxRatio;
    this.pixelRatio = maxRatio;
    this.shadowLowered = false;
    /** PERF-06: render every Nth display frame (1 = every frame); the app applies it. */
    this.frameDivisor = 1;
    this._ext = 0;
    this._run = 0;
    this._wall = 0; this._own = 0; this._n = 0;
    this._slowN = 0;
    this._fastSec = 0;
    this._upWait = this.T.upAfterSec;
    this._sinceUp = Infinity;
    this.lastAvgMs = null;
    this.steps = 0;
    // PERF-06: detection pressure
    this._det = null;
    this._dWall = 0; this._dN = 0; this._dBehind = 0; this._dRate = 0; this._dFar = 0; this._dSlowN = 0; this._dOwn = 0;
    this._sinceDet = Infinity;
    this._wDetN = 0; this._wDetHead = 0;
    this._dn = 0;                 // quality steps currently taken down (every kind)
    this._ceiling = null;         // {levels, ref}: levels: dn → {until, sec} — no step up to fewer than dn steps down before until
                                  // (run time); the deepest running one binds. ref: per level under it, the detection median
                                  // measured there {n, ms, liftSec} (early lift)
    this._ceilBlocked = false;    // the last step up was held back by the ceiling (its headroom carries over)
    this._activity = undefined;   // the hub's pose budget …
    this._session = undefined;    // … and session (a bout / drill, or menus): together the context
    // RG2: per context ('<session>/<activity>'): {ceiling, wait, settled, settledAt, leftDn}; the current one's key
    this._mem = new Map();
    this._ctxKey = null;
    this._lastDn = 0;
    this._levelSince = 0;         // run time the current level (_dn) started in this context
    this._probed = false;         // the current level was reached by a step up with a GPU detector reporting (a probe)
    this.lifts = 0;
    this._detDn = 0;              // steps currently taken down for detection (released quickly without a GPU detector)
    this._startCapped = false;    // the start-up frame cap was applied (once)
    this._intervals = [];         // recent frame intervals (ms) → displayHz
    this.displayHz = null;
    this.detSteps = 0;
  }

  /** Main-thread ms spent this frame outside rendering (e.g. pose detection); used by the next sample. */
  setExternalCost(ms) { this._ext += msOrZero(ms); }

  /**
   * The page's pose detection, once per frame (InputHub.renderPressure; PERF-06): {behind, headroom, gpu,
   * activity} or null when nothing is detected.
   * @param {null|{behind?:boolean, headroom?:boolean, gpu?:boolean, activity?:boolean}} p
   */
  setDetectionPressure(p) { this._det = p && typeof p === 'object' ? p : null; }

  /** Is the render at its lowest quality (nothing left to give back)? */
  get atFloor() {
    const capOpen = this.frameDivisor === 1 && Number.isFinite(this.displayHz) && this.displayHz >= this.T.capAboveHz;
    return this.pixelRatio <= this.T.ratios[this.T.ratios.length - 1] + 0.01 && this.shadowLowered && !capOpen;
  }

  /**
   * One frame.
   * @param {number} realSec  wall-clock seconds since the previous frame
   * @returns {null | {pixelRatio?:number, shadow?:'low'|'high', frameDivisor?:number, dir:'down'|'up', avgMs:number, reason?:'detection', why?:string}}
   */
  frame(realSec) {
    const T = this.T;
    const ext = this._ext / 1000;
    this._ext = 0;
    if (!this.enabled || !(realSec > 0)) return null;
    this._run += realSec;
    this._sinceUp += realSec;
    this._sinceDet += realSec;
    if (realSec >= T.skipFrameSec) return null;
    // the part of the interval rendering (and everything else on the main thread) can own
    const own = Math.max(0, realSec - Math.min(ext, realSec));
    if (this._run >= T.detWarmupSec) {
      this._noteInterval(realSec);
      const det = this._judgeDetection(realSec, own);
      if (det) return det;
    }
    if (this._run < T.warmupSec) return null;
    this._own += own;
    this._wall += realSec;
    this._n++;
    if (this._wall < T.windowSec) return null;
    const avgMs = (this._own / this._n) * 1000;
    const winSec = this._wall;
    const detN = this._wDetN, detHead = this._wDetHead;
    this._wall = 0; this._own = 0; this._n = 0;
    this._wDetN = 0; this._wDetHead = 0;
    this.lastAvgMs = avgMs;
    if (avgMs > T.slowFrameMs) {
      this._fastSec = 0;
      if (++this._slowN < T.slowWindows) return null;
      this._slowN = 0;
      return this._down(avgMs);
    }
    this._slowN = 0;
    if (avgMs > T.headroomMs) { this._fastSec = 0; return null; }
    // PERF-06: while a GPU pose detector reports in, it must have headroom too; without one, the steps taken for
    // detection come back soon (nothing on the GPU competes with the render any more)
    if (detN > 0 && detHead < T.detHeadroomShare * detN) { this._fastSec = 0; return null; }
    this._fastSec += winSec;
    const noGpu = detN === 0;
    const release = noGpu && this._detDn > 0;
    // RG2: with a GPU detector reporting, the headroom this context needs before a probe (it grows with quick failures)
    const ctxWait = !noGpu && this._ctxKey !== null ? this._ctxMem(this._ctxKey).wait : 0;
    const wait = release ? Math.min(this._upWait, T.detReleaseSec) : Math.max(this._upWait, ctxWait);
    if (this._fastSec < wait - 1e-9) return null;
    const c = this._up(avgMs, noGpu);
    // headroom counted while a ceiling held the step back carries over: the step follows as soon as the ceiling ends
    if (c || !this._ceilBlocked) this._fastSec = 0;
    return c;
  }

  /** RG2: the memory of one hub context (menus or a bout × setup or activity poses). */
  _ctxMem(key) {
    let m = this._mem.get(key);
    if (!m) this._mem.set(key, (m = { ceiling: null, wait: this.T.upAfterSec, settled: null, settledAt: -Infinity, leftDn: null }));
    return m;
  }

  /**
   * RG2: the hub's context changed. The one left keeps its memory; the one entered gets its ceiling back, and when it
   * settled lower recently (or its ceiling holds lower) the render goes straight there.
   * @returns {null|object} the change (one, every step at once)
   */
  _enterContext(d) {
    const T = this.T;
    if (this._ctxKey !== null) {
      const left = this._ctxMem(this._ctxKey);
      left.ceiling = this._ceiling;
      left.leftDn = this._dn;
    }
    this._activity = d.activity;
    this._session = d.session;
    this._ctxKey = `${!!this._session}/${!!this._activity}`;
    const m = this._ctxMem(this._ctxKey);
    this._ceiling = this._liveCeiling(m.ceiling);
    if (!this._ceiling) m.ceiling = null;
    this._levelSince = this._run;
    this._fastSec = 0; // a step up needs its headroom in this context
    // back where it left (a results card in between): carry on; otherwise the level this context needs, at once
    if (m.leftDn === this._dn) return null;
    const settled = m.settled != null && this._run - m.settledAt <= T.detMemorySec ? m.settled : 0;
    const b = this._binding();
    const want = Math.max(b ? b.dn : 0, settled);
    return d.gpu && want > this._dn ? this._jumpDown(want) : null;
  }

  /** RG2: the ceiling level that binds now — the deepest of its running horizons ({dn, until, sec}) — or null. */
  _binding(c = this._ceiling) {
    if (!c) return null;
    let b = null;
    for (const [dn, h] of c.levels) if (this._run < h.until && (!b || dn > b.dn)) b = { dn, until: h.until, sec: h.sec };
    return b;
  }

  /** RG2: a ceiling without the horizons that ended (null when none is left). */
  _liveCeiling(c) {
    if (!c) return null;
    for (const [dn, h] of [...c.levels]) if (this._run >= h.until) c.levels.delete(dn);
    return c.levels.size ? c : null;
  }

  /** RG2: straight down to `dn` steps (the level this context needs): one change carrying every step. */
  _jumpDown(dn) {
    const T = this.T;
    const c = { dir: 'down', avgMs: this.lastAvgMs ?? 0, reason: 'detection', why: 'context' };
    let n = 0;
    while (this._dn < dn) {
      const capOpen = this.frameDivisor === 1 && Number.isFinite(this.displayHz) && this.displayHz >= T.capAboveHz;
      if (capOpen) {
        this.frameDivisor = Math.max(2, Math.round(this.displayHz / T.frameCapHz));
        this._intervals = [];
        c.frameDivisor = this.frameDivisor;
      } else {
        const next = T.ratios.find((x) => x < this.pixelRatio - 0.01);
        if (next) { this.pixelRatio = next; c.pixelRatio = next; }
        else if (!this.shadowLowered) { this.shadowLowered = true; c.shadow = 'low'; }
        else break;
      }
      this._dn++; this.steps++; this._detDn++; n++;
    }
    if (!n) return null;
    this.detSteps++;
    this._sinceDet = 0;
    this._fastSec = 0;
    this._probed = false;
    this._logDet(c);
    return c;
  }

  /**
   * RG2, once per detection window with a GPU detector: remember the level the context settled at, reset its headroom
   * requirement once a probe holds, and lift a ceiling early once its level's detection is clearly faster than when the
   * ceiling was set (the load that set it is gone).
   */
  _learn(d, winSec) {
    const T = this.T;
    if (!d || !d.gpu || this._ctxKey === null) return;
    const m = this._ctxMem(this._ctxKey);
    const held = this._run - this._levelSince;
    if (held >= T.detGoodSec) { m.settled = this._dn; m.settledAt = this._run; }
    if (this._probed && held >= T.detProbeOkSec) m.wait = T.upAfterSec;
    const c = this._ceiling, b = this._binding();
    if (!b || this._dn < b.dn || this._sinceDet < T.detSettleSec || !Number.isFinite(d.detMs)) return;
    // each level under the ceiling gets its own reference median (measured while the load that set the ceiling ran)
    let r = c.ref.get(this._dn);
    if (!r) c.ref.set(this._dn, (r = { n: [], ms: null, liftSec: 0 }));
    if (r.ms == null) {
      r.n.push(d.detMs);
      if (r.n.length >= T.detLiftRefWindows) r.ms = [...r.n].sort((a, b) => a - b)[r.n.length >> 1];
      return;
    }
    if (d.headroom && d.detMs <= T.detLiftRatio * r.ms) r.liftSec += winSec; else r.liftSec = 0;
    if (r.liftSec < T.detLiftSec) return;
    this._ceiling = null;
    m.ceiling = null;
    m.wait = T.upAfterSec;
    m.settled = null;
    this._upWait = T.upAfterSec;
    this.lifts++;
  }

  /** Recent frame intervals → the display's refresh rate (taking a frame cap into account). */
  _noteInterval(realSec) {
    const iv = this._intervals;
    iv.push(realSec * 1000);
    if (iv.length > 31) iv.shift();
    if (iv.length < 15) return;
    const s = [...iv].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    if (med > 0) this.displayHz = Math.round((1000 * this.frameDivisor) / med);
  }

  /** PERF-06: judge the detection pressure of the last detWindowSec; one step down when a GPU detector is behind. */
  _judgeDetection(realSec, own = realSec) {
    const T = this.T;
    const d = this._det;
    // the pose detector is starting (its worker builds the graph and runs the first inference on the GPU the render
    // shares): on a fast display, cap the frame rate right away — at 144 fps the render can starve the start-up for
    // tens of seconds. Lifted later like any detection step (last, with detection headroom).
    if (d && d.starting && d.gpu !== false && !this._startCapped && this.frameDivisor === 1
      && Number.isFinite(this.displayHz) && this.displayHz >= T.capAboveHz && !this.atFloor) {
      this._startCapped = true;
      const c = this._downDet(false, 'start', this.lastAvgMs ?? 0);
      if (c) return c;
    }
    if (this._dn !== this._lastDn) { this._lastDn = this._dn; this._levelSince = this._run; }
    if (d && ((d.activity !== undefined && d.activity !== this._activity) || (d.session !== undefined && d.session !== this._session))) {
      // the hub's pose budget or session changed (setup ↔ activity, menus ↔ bout): that context's own memory applies (RG2)
      const c = this._enterContext(d);
      if (c) { this._lastDn = this._dn; this._levelSince = this._run; return c; }
    }
    if (d && d.gpu) {
      this._wDetN++;
      if (d.headroom) this._wDetHead++;
    }
    this._dWall += realSec;
    this._dOwn += own;
    this._dN++;
    if (d && d.gpu && d.behind) {
      this._dBehind++;
      // the rate itself is behind (a hub that does not tell lag from rate counts as rate): every step is allowed
      if (d.rateBehind !== false) this._dRate++;
      if (Number.isFinite(d.detFps) && Number.isFinite(d.wantFps) && d.wantFps > 0 && d.detFps < T.detFarBehind * d.wantFps) this._dFar++;
    }
    if (this._dWall < T.detWindowSec) return null;
    const share = this._dN ? this._dBehind / this._dN : 0;
    const rate = this._dN ? this._dRate / this._dN >= T.detBehindShare : false;
    const far = this._dN ? this._dFar / this._dN >= T.detBehindShare : false;
    const avgMs = this._dN ? (this._dOwn / this._dN) * 1000 : 0;
    const winSec = this._dWall;
    this._dWall = 0; this._dN = 0; this._dBehind = 0; this._dRate = 0; this._dFar = 0; this._dOwn = 0;
    this._learn(d, winSec);
    if (this._sinceDet < T.detSettleSec) return null;
    if (share < T.detBehindShare) { this._dSlowN = 0; return null; }
    if (++this._dSlowN < (far ? 1 : T.detStepWindows)) return null;
    this._dSlowN = 0;
    return this._downDet(far, rate || far ? 'rate' : 'lag', avgMs);
  }

  /**
   * One detection-driven step down (two pixel-ratio notches when detection is far behind). why 'lag' (enough poses per
   * second, a slow median): only the frame cap and the pixel ratio down to detLagMinRatio.
   */
  _downDet(far = false, why = 'rate', avgMs = this.lastAvgMs ?? 0) {
    const T = this.T;
    if (this.atFloor) return null; // nothing left to give back
    const capOpen = this.frameDivisor === 1 && Number.isFinite(this.displayHz) && this.displayHz >= T.capAboveHz;
    if (why === 'lag' && !capOpen && !(this.pixelRatio > T.detLagMinRatio + 0.01)) return null;
    if (why === 'start' && !capOpen) return null;
    this._sinceDet = 0;
    const left = { probed: this._probed, heldSec: this._run - this._levelSince };
    this._probed = false;
    const dn0 = this._dn;
    let c = null;
    if (capOpen) {
      this.frameDivisor = Math.max(2, Math.round(this.displayHz / T.frameCapHz));
      this._intervals = []; // the frame intervals change with the cap: measure again
      this.steps++; this._dn++;
      if (this._sinceUp >= 2 * T.upAfterSec) this._upWait = T.upAfterSec;
      this._sinceUp = Infinity;
      c = { frameDivisor: this.frameDivisor, dir: 'down', avgMs };
    } else {
      c = this._down(avgMs, true);
      // far behind: a second pixel-ratio notch in the same change (never the shadows: that is the next step's job)
      if (c && far && why !== 'lag' && c.pixelRatio != null && T.ratios.some((x) => x < this.pixelRatio - 0.01)) {
        const c2 = this._down(avgMs, true);
        if (c2 && c2.pixelRatio != null) c.pixelRatio = c2.pixelRatio;
      }
    }
    if (!c) return null;
    c.reason = 'detection';
    c.why = why;
    this.detSteps++;
    this._detDn += this._dn - dn0; // every step this change took (a far step takes two)
    this._fastSec = 0;
    // RG2: the level just left starved detection after a fair chance — off-limits in this context for a while; a probe that
    // failed quickly also doubles the headroom this context needs before the next probe. A further step of a descent (the
    // hub's figures still held frames from the level above) and the start-up cap set nothing.
    if (why !== 'start' && (left.probed || left.heldSec >= T.detFairSec)) {
      const quick = left.probed && left.heldSec < T.detQuickSec;
      if (quick && this._ctxKey !== null) {
        const m = this._ctxMem(this._ctxKey);
        m.wait = Math.min(T.upMaxSec, Math.max(T.upAfterSec, m.wait) * T.upBackoff);
      }
      this._setCeiling(quick && why === 'rate' ? T.detCeilingRateSec : left.probed && !quick ? T.detCeilingSlowSec : T.detCeilingSec);
    }
    this._logDet(c);
    return c;
  }

  /**
   * A level starved detection (a detection step down left it): no step up to fewer than the current steps down in this
   * context for `sec` — a horizon of its own, next to any running one for a sharper level (each ends on its own).
   */
  _setCeiling(sec = this.T.detCeilingSec) {
    const c = this._liveCeiling(this._ceiling) || { levels: new Map(), ref: new Map() };
    const h = c.levels.get(this._dn);
    const until = this._run + sec;
    c.levels.set(this._dn, { until: h ? Math.max(h.until, until) : until, sec: h ? Math.max(h.sec, sec) : sec });
    this._ceiling = c;
    if (this._ctxKey !== null) this._ctxMem(this._ctxKey).ceiling = c;
  }

  /** The renderer logs the change itself as "(render share)": say once why it happened (browser console only). */
  _logDet(c) {
    if (!this.T.log || typeof window === 'undefined' || typeof console === 'undefined') return;
    const d = this._det || {};
    const fps = Number.isFinite(d.detFps) ? Math.round(d.detFps) : '?';
    const want = Number.isFinite(d.wantFps) ? Math.round(d.wantFps) : '?';
    const ms = Number.isFinite(d.detMs) ? Math.round(d.detMs) : '?';
    const what = [c.frameDivisor != null ? `rendering every ${c.frameDivisor}${c.frameDivisor === 2 ? 'nd' : 'th'} display frame` : null,
      c.pixelRatio != null ? `pixel ratio ${c.pixelRatio}` : null, c.shadow === 'low' ? 'lower shadow resolution' : null].filter(Boolean).join(', ');
    const state = c.why === 'start' ? 'starting' : c.why === 'context' ? 'known to need it here (the level this bout / menu settled at)'
      : c.why === 'lag' ? `slow (median ${ms} ms)` : `behind (${fps} of ${want} poses/s, median ${ms} ms)`;
    console.info(`[render] pose detection on the GPU is ${state} — giving it GPU time: ${what}`);
  }

  /** One step down. det: taken for pose detection — its ceiling / the context's headroom requirement keep that level off-limits. */
  _down(avgMs, det = false) {
    const T = this.T;
    // undoing a recent step up: wait longer before trying again; otherwise start fresh
    if (this._sinceUp >= 2 * T.upAfterSec) this._upWait = T.upAfterSec;
    else if (!det) this._upWait = Math.min(T.upMaxSec, this._upWait * T.upBackoff);
    this._sinceUp = Infinity;
    this._probed = false;
    const next = T.ratios.find((x) => x < this.pixelRatio - 0.01);
    if (next) { this.pixelRatio = next; this.steps++; this._dn++; return { pixelRatio: next, dir: 'down', avgMs }; }
    if (!this.shadowLowered) { this.shadowLowered = true; this.steps++; this._dn++; return { shadow: 'low', dir: 'down', avgMs }; }
    return null;
  }

  /**
   * One step back up. noGpu: no GPU detector reports (detection moved to the CPU, or none runs) — nothing learnt for it (the
   * ceiling) applies, and the level reached is not a probe.
   */
  _up(avgMs, noGpu = false) {
    const b = this._binding();
    this._ceilBlocked = false;
    if (b && !noGpu && this._dn <= b.dn) { this._ceilBlocked = true; return null; }
    const c = this._ceiling;
    this._ceiling = this._liveCeiling(c);
    if (c && !this._ceiling && this._ctxKey !== null && this._ctxMem(this._ctxKey).ceiling === c) this._ctxMem(this._ctxKey).ceiling = null;
    const detDn = this._detDn > 0 && (this.shadowLowered || this.pixelRatio < this.maxRatio - 0.01 || this.frameDivisor > 1);
    let out = null;
    if (this.shadowLowered) {
      this.shadowLowered = false;
      out = { shadow: 'high', dir: 'up', avgMs };
    } else if (this.pixelRatio < this.maxRatio - 0.01) {
      const up = [...this.T.ratios].reverse().find((x) => x > this.pixelRatio + 0.01);
      this.pixelRatio = up != null && up < this.maxRatio ? up : this.maxRatio;
      out = { pixelRatio: this.pixelRatio, dir: 'up', avgMs };
    } else if (this.frameDivisor > 1) {
      this.frameDivisor = 1; this._intervals = [];
      out = { frameDivisor: 1, dir: 'up', avgMs };
    }
    if (!out) return null;
    if (detDn) this._detDn--;
    this._sinceUp = 0; this.steps++; this._dn = Math.max(0, this._dn - 1);
    this._detDn = Math.min(this._detDn, this._dn);
    this._probed = !noGpu; // the level this step reaches is a probe (RG2: a ceiling if it starves detection)
    return out;
  }

  /** Debug snapshot. */
  state() {
    const m = this._ctxKey !== null ? this._ctxMem(this._ctxKey) : null;
    const settled = m && m.settled != null && this._run - m.settledAt <= this.T.detMemorySec ? m.settled : null;
    const b = this._binding();
    return {
      enabled: this.enabled, pixelRatio: this.pixelRatio, maxRatio: this.maxRatio, shadowLowered: this.shadowLowered,
      lastAvgMs: this.lastAvgMs == null ? null : +this.lastAvgMs.toFixed(1), slowWindows: this._slowN,
      headroomSec: +this._fastSec.toFixed(1), upWaitSec: this._upWait, steps: this.steps,
      // PERF-06
      frameDivisor: this.frameDivisor, displayHz: this.displayHz, detSteps: this.detSteps, detDown: this._detDn,
      detection: this._det ? { behind: !!this._det.behind, headroom: !!this._det.headroom, gpu: !!this._det.gpu } : null,
      // the binding ceiling level (steps down), its seconds left and length, the reference medians, every running horizon
      ceiling: b
        ? { steps: b.dn, sec: +(b.until - this._run).toFixed(1), of: b.sec,
          refMs: Object.fromEntries([...this._ceiling.ref].map(([dn, r]) => [dn, r.ms])),
          levels: Object.fromEntries([...this._ceiling.levels].filter(([, h]) => this._run < h.until).map(([dn, h]) => [dn, +(h.until - this._run).toFixed(1)])) }
        : null,
      // RG2: the hub context ('<bout or drill>/<activity poses>') and what it remembers (the level it settled at — `good` is
      // the older name — and the headroom it needs before a probe); early ceiling lifts so far
      context: this._ctxKey,
      remembered: m ? { settled, good: settled, waitSec: m.wait } : null,
      lifts: this.lifts,
    };
  }
}
