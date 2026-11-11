// PlayerAssigner — turns MediaPipe's detection-ordered poses into stable player slots.
//
//   assign(frame) → PoseFrame whose players[0] = P1, players[1] = P2 (2-player mode), null when
//   that player is not visible this frame; extra people/posters go to `frame.ignored`.
//
// How it decides (all thresholds in ASSIGNER_TUNING):
//  * Every detected person becomes a TRACK (centroid + velocity + size), matched frame to frame
//    with a minimum-cost assignment on velocity-predicted centroids, gated by distance and size
//    similarity → identities survive crossings and brief dropouts.
//  * A slot keeps its owner while the owner is matched or coasting for up to `dropoutMs`; a
//    person reappearing near where they vanished is re-matched to the same track (same slot).
//  * Free slot (1 player): the best candidate by  shoulder width × visibility × centre bias ×
//    liveness  — the real player is usually the biggest, most visible, most central person.
//    (2 players): the two best; P1 = LEFT side of the MIRRORED preview = larger raw x.
//  * Posters / cut-outs / photos: before a slot has ever had an owner, the first available
//    person claims it after `minHitsToClaim` frames. After that, a new track may only claim a
//    free slot once it has visibly moved (`movedRange`), or after `staticWindowMs` if it isn't
//    static (so a poster the detector only notices once the player has left is never picked). A track whose joints
//    have not moved beyond jitter for `staticWindowMs` is "static": it never claims a slot, loses
//    one it owns at once if it never moved, otherwise to any live challenger (or after
//    `ownerStaticMs`) → ERR02 still fires when the real player walks away and only the poster
//    remains. Hand-over after a dropout only goes to a newcomer near where the owner vanished.
//  * Coming back in place: a track (re-matched or new) that reappears where a live owner vanished after a
//    dropout longer than `dropoutMs` — within `handoverGateSizes`, about the same size — needs only a
//    short liveness proof (`reacquireMovedRange` of joint travel, or `reacquireLiveMs` without being
//    static) instead of `staticWindowMs`: a player whose detection dropped out (a passer-by, the light)
//    and who stays in their guard gets their slot back in about a second (ERR02), while a cut-out, which
//    never moves beyond jitter, still never claims it.
//  * A clearly better challenger (score × `switchRatio`) for `switchHoldMs` takes over a slot
//    (e.g. P1 was locked on a bystander before the player stepped in).
//
// Pure logic, no DOM: runs in Node.

import { LM } from '../core/types.js';

export const ASSIGNER_TUNING = Object.freeze({
  /** Ignore detections whose upper-body visibility (PlayerPose.score) is below this. */
  minScore: 0.3,
  /** A joint counts as visible above this visibility. */
  visibleAt: 0.4,
  /** Gate: max distance (in sizes = shoulder widths) between predicted and observed centroid. */
  gateSizes: 1.4,
  /** Gate floor in normalized-width units (small/far people jitter more). */
  gateMin: 0.05,
  /** Max size ratio between a track and a candidate for them to be the same person. */
  sizeRatioMax: 1.9,
  /** Cost of starting a new track instead of matching (in gate-normalized units, 0..1 = inside gate). */
  newTrackCost: 1.0,
  /** Weight of size mismatch in the matching cost. */
  sizeCostWeight: 0.35,
  /** Velocity EMA factor and max prediction horizon. */
  velAlpha: 0.5,
  maxPredictMs: 250,
  /** A slot stays reserved for a vanished owner this long (occlusion, crossing, glitch). */
  dropoutMs: 1200,
  /** Unmatched tracks are forgotten after this. */
  trackForgetMs: 2500,
  /** Frames a new track needs before it may claim a free slot (filters one-frame ghosts). */
  minHitsToClaim: 3,
  /** 1P: penalty for distance from frame centre (0 = none, 0.5 = edge scores half). */
  centreWeight: 0.45,
  /** A challenger must beat the owner's score by this factor... */
  switchRatio: 1.6,
  /** ...continuously for this long to take the slot. */
  switchHoldMs: 900,
  /** Liveness: smoothing time constant for joint positions (suppresses landmark jitter). */
  jointTauMs: 220,
  /** Liveness: window over which a track must stay still to count as static. */
  staticWindowMs: 3000,
  /** Liveness: max joint travel (in sizes) over the window for "static". */
  staticRange: 0.06,
  /** Liveness: joint travel (in sizes, smoothed) since a track appeared that proves it is a moving person. */
  movedRange: 0.15,
  /** A static owner that moved before (a player holding very still) loses its slot only to a live
   *  challenger or after being static this long; one that never moved (poster/photo) loses it at once. */
  ownerStaticMs: 10000,
  /** Score multiplier for static tracks. */
  staticPenalty: 0.35,
  /** Max tracks kept (oldest unmatched dropped first). */
  maxTracks: 8,
  /** Two detections closer than this (in sizes) with similar size are one person detected twice. */
  dedupSizes: 0.35,
  /** An owner missing for this long hands its slot to a newcomer that appeared since (re-detection)… */
  handoverAfterMs: 120,
  /** …but only if the newcomer is within this many sizes of where the owner vanished (scaled by time). */
  handoverGateSizes: 2.5,
  /** Coming back where a live owner vanished (within handoverGateSizes, size ratio ≤ reacquireSizeRatio, within
   *  reacquireWindowMs): proven alive by this much joint travel (sizes, smoothed) … */
  reacquireMovedRange: 0.04,
  /** … or by this long without being static (staticRange over that window). */
  reacquireLiveMs: 1000,
  reacquireSizeRatio: 1.25,
  reacquireWindowMs: 10000,
});

const JOINTS = [LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST];

/**
 * Geometry of one detected person (raw image space, normalized x units; y converted with the
 * frame aspect so distances are isotropic).
 * @param {import('../core/types.js').PlayerPose} pose
 * @param {number} aspect  height / width of the camera frame
 * @param {number} visibleAt
 * @returns {null|{cx:number, cy:number, size:number, vis:number}}
 */
export function analyzePose(pose, aspect, visibleAt = ASSIGNER_TUNING.visibleAt) {
  const im = pose && pose.image;
  if (!im || im.length < 25) return null;
  const v = (i) => im[i] && (im[i].visibility ?? 0) >= visibleAt;
  const ls = im[LM.LEFT_SHOULDER], rs = im[LM.RIGHT_SHOULDER];
  let cx, cy, size = 0;
  if (v(LM.LEFT_SHOULDER) && v(LM.RIGHT_SHOULDER)) {
    cx = (ls.x + rs.x) / 2;
    cy = ((ls.y + rs.y) / 2) * aspect;
    size = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * aspect);
  } else if (v(LM.NOSE)) {
    cx = im[LM.NOSE].x;
    cy = im[LM.NOSE].y * aspect + 0; // nose stands in for the shoulder centre
  } else {
    let n = 0; cx = 0; cy = 0;
    for (const j of JOINTS) if (v(j)) { cx += im[j].x; cy += im[j].y * aspect; n++; }
    if (!n) return null;
    cx /= n; cy /= n;
  }
  // Sideways bodies collapse the shoulder line; ear distance (≈0.45 shoulder width) keeps size sane.
  if (v(LM.LEFT_EAR) && v(LM.RIGHT_EAR)) {
    const le = im[LM.LEFT_EAR], re = im[LM.RIGHT_EAR];
    size = Math.max(size, 2.2 * Math.hypot(le.x - re.x, (le.y - re.y) * aspect));
  }
  if (!(size > 0)) size = 0.08; // unknown: assume a small, far person
  const vis = Number.isFinite(pose.score) ? pose.score : 0;
  return { cx, cy, size, vis };
}

let nextTrackId = 1;

class Track {
  constructor(geo, pose, t) {
    this.id = nextTrackId++;
    this.cx = geo.cx; this.cy = geo.cy; this.vx = 0; this.vy = 0;
    this.size = geo.size; this.vis = geo.vis;
    this.firstT = t; this.lastT = t; this.hits = 1;
    this.pose = pose;
    this.matchedNow = true;
    this.slot = -1;
    this.score = 0;
    this.static = false;
    // liveness
    this.joints = new Map();        // joint index → {x, y} smoothed
    this.samples = [];              // [{t, pts: [[joint, x, y], …]}] at ~10 Hz over the static window
    this.lastSampleT = -Infinity;
    this.staticSince = -1;
    this.extent = new Map();        // joint → [minX, maxX, minY, maxY] of smoothed positions since birth
    this.everMoved = false;
    this.travel = 0;                // largest joint travel (sizes, smoothed) since birth / re-acquisition
  }
}

export class PlayerAssigner {
  /**
   * @param {{players?:1|2, tuning?:Partial<typeof ASSIGNER_TUNING>}} [opts]
   */
  constructor({ players = 1, tuning = {} } = {}) {
    this.tuning = { ...ASSIGNER_TUNING, ...tuning };
    this.players = players === 2 ? 2 : 1;
    /** @type {Track[]} */
    this.tracks = [];
    /** slot → Track | null */
    this.slots = [null, null];
    /** slot → time the owner was last matched */
    this.slotSeenT = [-Infinity, -Infinity];
    /** slot → {id, since} of the challenger currently out-scoring the owner */
    this.challenge = [null, null];
    /** slot → has it had an owner since the last reset (then newcomers must prove liveness) */
    this.everOwned = [false, false];
    /** slot → where a live owner was last seen when the slot was released ({cx, cy, size, t}) */
    this.lost = [null, null];
    this.lastT = -Infinity;
    this.aspect = 0.75;
  }

  setPlayers(n) {
    const p = n === 2 ? 2 : 1;
    if (p === this.players) return;
    this.players = p;
    if (p === 1 && this.slots[1]) { this.slots[1].slot = -1; this.slots[1] = null; }
  }

  reset() {
    this.tracks = [];
    this.slots = [null, null];
    this.slotSeenT = [-Infinity, -Infinity];
    this.challenge = [null, null];
    this.everOwned = [false, false];
    this.lost = [null, null];
    this.lastT = -Infinity;
  }

  /** Per-slot presence from the last assign(): owner matched in that frame. */
  get presence() {
    const out = [];
    for (let s = 0; s < this.players; s++) out.push(!!(this.slots[s] && this.slots[s].matchedNow));
    return out;
  }

  /**
   * @param {import('../core/types.js').PoseFrame} frame  players in detection order
   * @returns {import('../core/types.js').PoseFrame & {ignored: import('../core/types.js').PlayerPose[], trackIds:(number|null)[]}}
   */
  assign(frame) {
    const T = this.tuning;
    const t = Number.isFinite(frame && frame.t) ? frame.t : this.lastT + 33;
    if (t < this.lastT - 1 || t - this.lastT > T.trackForgetMs * 4) this.reset(); // time jumped (replay loop, long pause)
    const dtFrame = Number.isFinite(this.lastT) ? Math.max(1, t - this.lastT) : 33;
    this.lastT = t;
    if (frame && frame.width > 0 && frame.height > 0) this.aspect = frame.height / frame.width;
    const aspect = this.aspect;

    // 1) candidates
    const cands = [];
    const ignored = [];
    for (const pose of (frame && frame.players) || []) {
      if (!pose) continue;
      const geo = (pose.score ?? 0) >= T.minScore ? analyzePose(pose, aspect, T.visibleAt) : null;
      if (geo) cands.push({ pose, geo, track: null });
      else ignored.push(pose);
    }
    dedupe(cands, T);

    // 2) match candidates to tracks (min total cost, gated)
    for (const tr of this.tracks) tr.matchedNow = false;
    const pairs = this._match(cands, t);
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      const tr = pairs[ci];
      if (tr) this._update(tr, c, t);
      else {
        const nt = new Track(c.geo, c.pose, t);
        this._sampleJoints(nt, c.pose, t, aspect);
        this.tracks.push(nt);
        c.track = nt;
      }
    }

    // 3) forget stale tracks, release slots of owners gone for too long
    this.tracks = this.tracks.filter((tr) => t - tr.lastT <= T.trackForgetMs);
    if (this.tracks.length > T.maxTracks) {
      this.tracks.sort((a, b) => (b.matchedNow - a.matchedNow) || (b.lastT - a.lastT));
      this.tracks.length = T.maxTracks;
    }
    for (let s = 0; s < 2; s++) {
      const owner = this.slots[s];
      if (!owner) continue;
      if (s >= this.players || !this.tracks.includes(owner) || t - owner.lastT > T.dropoutMs) {
        // remember where a live owner vanished: coming back right there needs only a short liveness proof
        if (s < this.players && (owner.everMoved || !owner.static)) this.lost[s] = { cx: owner.cx, cy: owner.cy, size: owner.size, t: owner.lastT };
        owner.slot = -1;
        this.slots[s] = null;
      }
    }

    // 4) scores + liveness
    for (const tr of this.tracks) {
      tr.static = this._isStatic(tr, t);
      tr.score = this._score(tr);
    }

    // 5) slot decisions
    this._revokeStaticOwners(t);
    this._handover(t);
    this._fillFreeSlots();
    this._challenge(t, dtFrame);

    // 6) build output
    const players = [];
    const trackIds = [];
    for (let s = 0; s < this.players; s++) {
      const owner = this.slots[s];
      if (owner && owner.matchedNow) { players.push(owner.pose); this.slotSeenT[s] = t; } else players.push(null);
      trackIds.push(owner ? owner.id : null);
    }
    for (const c of cands) if (!c.track || c.track.slot < 0 || !players.includes(c.pose)) ignored.push(c.pose);
    return { t, width: frame ? frame.width : 0, height: frame ? frame.height : 0, players, ignored, trackIds };
  }

  // ───────────────────────────── internals ─────────────────────────────

  _match(cands, t) {
    const T = this.tuning;
    const tracks = this.tracks;
    const nC = cands.length;
    /** cost[ci][ti] or Infinity if gated out */
    const cost = cands.map((c) => tracks.map((tr) => {
      const h = Math.min(t - tr.lastT, T.maxPredictMs) / 1000;
      const px = tr.cx + tr.vx * h, py = tr.cy + tr.vy * h;
      const d = Math.hypot(c.geo.cx - px, c.geo.cy - py);
      const scale = Math.max(tr.size, c.geo.size);
      // People move further between far-apart frames (slow machines, dropouts): widen the gate.
      const gapScale = 1 + Math.min(2, Math.max(0, t - tr.lastT - 100) / 250);
      const gate = Math.max(T.gateMin, T.gateSizes * scale) * gapScale;
      const ratio = Math.max(tr.size, c.geo.size) / Math.max(1e-6, Math.min(tr.size, c.geo.size));
      if (d > gate || ratio > T.sizeRatioMax) return Infinity;
      return d / gate + T.sizeCostWeight * (ratio - 1);
    }));
    let best = Infinity;
    let bestPick = new Array(nC).fill(-1);
    const pick = new Array(nC).fill(-1);
    const used = new Array(tracks.length).fill(false);
    const rec = (ci, acc) => {
      if (acc >= best) return;
      if (ci === nC) { best = acc; bestPick = pick.slice(); return; }
      for (let ti = 0; ti < tracks.length; ti++) {
        if (used[ti] || cost[ci][ti] === Infinity) continue;
        used[ti] = true; pick[ci] = ti;
        rec(ci + 1, acc + cost[ci][ti]);
        used[ti] = false; pick[ci] = -1;
      }
      rec(ci + 1, acc + T.newTrackCost);
    };
    rec(0, 0);
    return bestPick.map((ti) => (ti >= 0 ? tracks[ti] : null));
  }

  _update(tr, c, t) {
    const T = this.tuning;
    if (t - tr.lastT > T.dropoutMs) {
      // Re-acquired after a long gap: position continuity is weak evidence of identity now, so
      // the track must prove it is a live person again (a cut-out revealed where the player stood
      // must not inherit the player's history).
      tr.everMoved = false; tr.extent.clear(); tr.samples = []; tr.firstT = t; tr.hits = 0; tr.travel = 0;
      tr.joints.clear(); tr._jointT = t; tr.staticSince = -1; tr.vx = 0; tr.vy = 0;
    }
    const dt = Math.max(1, t - tr.lastT) / 1000;
    const vx = (c.geo.cx - tr.cx) / dt, vy = (c.geo.cy - tr.cy) / dt;
    // After a long gap the displacement is a poor velocity sample; trust it less.
    const a = dt > 0.2 ? T.velAlpha * 0.3 : T.velAlpha;
    tr.vx += a * (vx - tr.vx);
    tr.vy += a * (vy - tr.vy);
    tr.cx = c.geo.cx; tr.cy = c.geo.cy;
    tr.size += 0.3 * (c.geo.size - tr.size);
    tr.vis = c.geo.vis;
    tr.lastT = t;
    tr.hits++;
    tr.pose = c.pose;
    tr.matchedNow = true;
    c.track = tr;
    this._sampleJoints(tr, c.pose, t, this.aspect);
  }

  /** Smooth joint positions and keep ~10 Hz samples for the static test. */
  _sampleJoints(tr, pose, t, aspect) {
    const T = this.tuning;
    const im = pose.image;
    const prevT = tr._jointT ?? t;
    const a = 1 - Math.exp(-Math.max(0, t - prevT) / T.jointTauMs);
    tr._jointT = t;
    for (const j of JOINTS) {
      const l = im[j];
      if (!l || (l.visibility ?? 0) < 0.5) continue;
      const y = l.y * aspect;
      const s = tr.joints.get(j);
      if (!s) tr.joints.set(j, { x: l.x, y });
      else { s.x += a * (l.x - s.x); s.y += a * (y - s.y); }
    }
    if (!tr.everMoved && t - tr.firstT >= T.jointTauMs) { // let the smoother settle before measuring travel
      for (const [j, s] of tr.joints) {
        const e = tr.extent.get(j);
        if (!e) { tr.extent.set(j, [s.x, s.x, s.y, s.y]); continue; }
        if (s.x < e[0]) e[0] = s.x; if (s.x > e[1]) e[1] = s.x; if (s.y < e[2]) e[2] = s.y; if (s.y > e[3]) e[3] = s.y;
        const travel = Math.max(e[1] - e[0], e[3] - e[2]) / Math.max(1e-6, tr.size);
        if (travel > tr.travel) tr.travel = travel;
        if (travel > T.movedRange) tr.everMoved = true;
      }
    }
    if (t - tr.lastSampleT >= 100) {
      tr.lastSampleT = t;
      const pts = [];
      for (const [j, s] of tr.joints) pts.push([j, s.x, s.y]);
      tr.samples.push({ t, pts });
      const cutoff = t - T.staticWindowMs - 200;
      while (tr.samples.length && tr.samples[0].t < cutoff) tr.samples.shift();
    }
  }

  /** Joint travel range (in sizes) over the static window (or `windowMs`), or Infinity if not enough history. */
  _range(tr, t, windowMs = this.tuning.staticWindowMs) {
    if (t - tr.firstT < windowMs || tr.samples.length < 5) return Infinity;
    const from = t - windowMs;
    const box = new Map();
    for (const smp of tr.samples) {
      if (smp.t < from) continue;
      for (const [j, x, y] of smp.pts) {
        const b = box.get(j);
        if (!b) box.set(j, [x, x, y, y]);
        else { if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x; if (y < b[2]) b[2] = y; if (y > b[3]) b[3] = y; }
      }
    }
    let r = 0;
    for (const b of box.values()) r = Math.max(r, b[1] - b[0], b[3] - b[2]);
    return box.size ? r / Math.max(1e-6, tr.size) : Infinity;
  }

  _isStatic(tr, t) {
    const isStatic = this._range(tr, t) < this.tuning.staticRange;
    if (isStatic && tr.staticSince < 0) tr.staticSince = t - this.tuning.staticWindowMs;
    if (!isStatic) tr.staticSince = -1;
    return isStatic;
  }

  _score(tr) {
    const T = this.tuning;
    let s = tr.size * Math.max(0.05, tr.vis);
    if (this.players === 1) s *= 1 - T.centreWeight * Math.min(1, Math.abs(tr.cx - 0.5) / 0.5);
    if (tr.static) s *= T.staticPenalty;
    return s;
  }

  /** Unowned, seen this frame, confirmed over a few frames, not a known-static object. */
  _available(tr) {
    return tr.slot < 0 && tr.matchedNow && tr.hits >= this.tuning.minHitsToClaim && !tr.static;
  }

  /** May challenge an owner / claim a used slot: available AND proven alive (moved, or old enough without being static). */
  _eligible(tr) {
    return this._available(tr) && (tr.everMoved || this.lastT - tr.firstT >= this.tuning.staticWindowMs);
  }

  /** May claim free slot `s`: proven alive, or simply available if that slot never had an owner yet, or back where
   *  that slot's live owner vanished with a short liveness proof (INPUT-08). */
  _canClaim(tr, s) {
    if (!this.everOwned[s]) return this._available(tr);
    return this._eligible(tr) || this._reacquires(tr, s);
  }

  /** A track back where slot `s`'s live owner vanished, about the same size, that shows a little life. (Not while
   *  both versus slots are free: who is who is then unknown — two players may come back in swapped places.) */
  _reacquires(tr, s) {
    const T = this.tuning, L = this.lost[s], t = this.lastT;
    if (!L || t - L.t > T.reacquireWindowMs || !this._available(tr)) return false;
    if (this.players === 2 && !this.slots[1 - s]) return false;
    const ratio = Math.max(tr.size, L.size) / Math.max(1e-6, Math.min(tr.size, L.size));
    if (ratio > T.reacquireSizeRatio || Math.hypot(tr.cx - L.cx, tr.cy - L.cy) > T.handoverGateSizes * Math.max(tr.size, L.size)) return false;
    if (tr.travel >= T.reacquireMovedRange) return true;
    return t - tr.firstT >= T.reacquireLiveMs && this._range(tr, t, T.reacquireLiveMs) >= T.staticRange;
  }

  _revokeStaticOwners(t) {
    const T = this.tuning;
    const anyChallenger = this.tracks.some((tr) => this._eligible(tr));
    for (let s = 0; s < this.players; s++) {
      const o = this.slots[s];
      if (!o || !o.static) continue;
      if (!o.everMoved || anyChallenger || (o.staticSince >= 0 && t - o.staticSince >= T.ownerStaticMs)) {
        o.slot = -1;
        this.slots[s] = null;
      }
    }
  }

  _fillFreeSlots() {
    const free = [];
    for (let s = 0; s < this.players; s++) if (!this.slots[s]) free.push(s);
    if (!free.length) return;
    const byScore = (a, b) => b.score - a.score;
    if (free.length === 2) {
      const pool = this.tracks.filter((tr) => this._canClaim(tr, 0) && this._canClaim(tr, 1)).sort(byScore);
      if (pool.length >= 2) {
        // Both slots free: P1 = left of the mirrored preview = larger raw x.
        const [a, b] = pool;
        const [p1, p2] = a.cx >= b.cx ? [a, b] : [b, a];
        this._give(0, p1); this._give(1, p2);
        return;
      }
    }
    for (const s of free) {
      // A lone newcomer just takes a free slot (identity matters more than side).
      const tr = this.tracks.filter((q) => q.slot < 0 && this._canClaim(q, s)).sort(byScore)[0];
      if (tr) this._give(s, tr);
    }
  }

  /**
   * An owner that vanished (not matched for `handoverAfterMs`) while a NEW eligible track
   * appeared since → that newcomer is almost always the same person re-detected outside the
   * matching gate (fast move, occlusion during a crossing). Hand the slot over right away so the
   * player doesn't flicker to "lost".
   */
  _handover(t) {
    const T = this.tuning;
    for (let s = 0; s < this.players; s++) {
      const o = this.slots[s];
      if (!o || o.matchedNow || t - o.lastT < T.handoverAfterMs) continue;
      const h = Math.min(t - o.lastT, T.maxPredictMs) / 1000;
      const px = o.cx + o.vx * h, py = o.cy + o.vy * h;
      const gapScale = 1 + Math.min(2, Math.max(0, t - o.lastT - 100) / 400);
      let best = null, bestD = Infinity;
      for (const tr of this.tracks) {
        if (!this._available(tr) || tr.firstT < o.lastT - 1) continue;
        const d = Math.hypot(tr.cx - px, tr.cy - py);
        const ratio = Math.max(tr.size, o.size) / Math.max(1e-6, Math.min(tr.size, o.size));
        if (d > T.handoverGateSizes * Math.max(tr.size, o.size) * gapScale || ratio > T.sizeRatioMax * 1.2) continue;
        if (d < bestD) { best = tr; bestD = d; }
      }
      if (best) {
        o.slot = -1;
        this._give(s, best);
      }
    }
  }

  _challenge(t, dtFrame) {
    const T = this.tuning;
    for (let s = 0; s < this.players; s++) {
      const owner = this.slots[s];
      if (!owner || !owner.matchedNow) { this.challenge[s] = null; continue; }
      let best = null;
      for (const tr of this.tracks) {
        if (!this._eligible(tr)) continue;
        if (!best || tr.score > best.score) best = tr;
      }
      if (!best || best.score <= owner.score * T.switchRatio) { this.challenge[s] = null; continue; }
      const ch = this.challenge[s];
      if (!ch || ch.id !== best.id) { this.challenge[s] = { id: best.id, since: t - dtFrame }; continue; }
      if (t - ch.since >= T.switchHoldMs) {
        owner.slot = -1;
        this._give(s, best);
      }
    }
  }

  _give(s, tr) {
    tr.slot = s;
    this.slots[s] = tr;
    this.challenge[s] = null;
    this.everOwned[s] = true;
    this.lost[s] = null;
  }

  /** Debug snapshot for overlays/tests. */
  debug() {
    return this.tracks.map((tr) => ({
      id: tr.id, slot: tr.slot, cx: tr.cx, cy: tr.cy, size: tr.size, vis: tr.vis, score: tr.score,
      static: !!tr.static, moved: tr.everMoved, hits: tr.hits, matched: tr.matchedNow, lastT: tr.lastT,
    }));
  }
}

/**
 * Multi-pose detectors occasionally report the same person twice (tracker + fresh detection).
 * Keep the more visible of two near-identical candidates.
 */
function dedupe(cands, T) {
  for (let i = 0; i < cands.length; i++) {
    for (let j = cands.length - 1; j > i; j--) {
      const a = cands[i].geo, b = cands[j].geo;
      const big = Math.max(a.size, b.size), small = Math.max(1e-6, Math.min(a.size, b.size));
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < T.dedupSizes * big && big / small < 1.35) {
        if (b.vis > a.vis) cands[i] = cands[j];
        cands.splice(j, 1);
      }
    }
  }
}
