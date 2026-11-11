// Bag practice (TRN01): pound a heavy bag hanging on a chain until the chain snaps and the bag
// drops; the next, tougher bag is lowered in; repeat until the clock runs out.
//
// Owner: training. Pure logic (no DOM / three.js).
//
// Feel (spec §6 "Strike hanging bags until they fall from their chains. Present subsequent bags
// during the timed activity. Reward completed bags."):
//   * The bag is a damped pendulum (forward/back + sideways swing, plus a little twist). Every
//     landed punch kicks it away; it swings back toward you. A punch only connects if the bag is
//     within reach when the glove gets there — so after a flurry the bag swings out of reach and
//     you wait for it to come back.
//   * MEETING the bag as it swings back toward you is the skill: ×1.5 damage ("NICE TIMING!").
//     It takes a bag that is really swinging (a lone jab's return is too slow): a combo sends it
//     away, you meet it on the way back, and go again.
//   * Combos: clean punches less than combo.gapMs (1 s) apart build a combo that multiplies damage
//     (+8 % per hit, up to ×1.96); a graze keeps it alive, a whiff or a pause breaks it — so keep
//     punching, but time the flurries so the bag is there when the gloves arrive.
//   * Each bag has its own strength (hp); bag n has baseHp·growth^(n−1). At 0 the chain snaps,
//     the bag falls and topples away, and the next bag is lowered in.
//   * Score = 100 per completed bag + partial credit: the % of the current bag's strength knocked
//     out (shown live in the HUD score and on the bag's strength meter). "Reward completed bags."
//   * Latency fairness: a punch connects if the bag was in reach at ANY point between the punch
//     being recognised and the glove arriving, and the "meeting" bonus uses the best moment too —
//     webcam recognition lags the real punch by ~100–150 ms.

import { TrainingActivity, TrainingPhase, TRAINING_LAYOUT, punchContact, clamp, clamp01, lerp, num } from './activity.js';

/** Every bag-practice tunable (metres, seconds, radians unless noted). */
export const BAG_TUNING = Object.freeze({
  durationMs: 60000,
  pointsPerBag: 100,
  rig: Object.freeze({
    pivot: Object.freeze([0, 2.62, -0.56]), // chain swivel under the stand's beam (world)
    chainLen: 0.78,         // swivel → top of the bag
    bagLen: 1.15,
    radius: 0.21,           // resting front surface at pivot.z + radius = the punch plane (−0.35)
  }),
  physics: Object.freeze({
    g: 9.81,
    damping: 0.5,           // forward/back swing damping (1/s) — a heavy bag settles in a few swings
    sideDamping: 0.8,
    twistStiffness: 16,     // chain torsion (1/s²) and its damping (1/s)
    twistDamping: 2.2,
    maxSwing: 0.55,         // rad
    bumpAngle: -0.3,        // a bag swinging into the player bounces off their guard here (rad)
    bumpRestitution: 0.3,
  }),
  hit: Object.freeze({
    reachSlack: 0.12,       // m past the bag's resting surface a glove still connects (stretch + step-in)
    glanceExtra: 0.1,       // … plus this much where it only grazes
    glanceMul: 0.35,        // damage / kick of a grazing punch
    sideSlack: 0.06,        // m past the bag's radius sideways
    // forward kick (rad/s) for a punch of power 0.5 at the pendulum's centre of mass; scaled by
    // the contact arm (body shots swing it more) and by power (0.7 … 1.3)
    kick: Object.freeze({ straight: 0.2, hook: 0.1, uppercut: 0.17 }),
    sideKick: Object.freeze({ straight: 0.02, hook: 0.3, uppercut: 0.03 }), // hooks push it sideways
    twistKick: Object.freeze({ straight: 0.6, hook: 2.2, uppercut: 0.4 }),  // rad/s yaw (visual)
    restitution: 0.2,       // an incoming bag's velocity, reversed, is kept at this fraction
    chaseMul: 0.6,          // a bag already swinging away takes less of the kick
    damage: Object.freeze({ straight: 5, hook: 6.5, uppercut: 7 }),
    bodyMul: 1.0,
    powerMul: Object.freeze([0.8, 1.2]), // power 0 → ×0.8 … power 1 → ×1.2
    // m/s toward the player at the contact height that counts as "meeting" it. A lone jab's
    // return swing is slower than this — send it away with a combo, then meet it coming back.
    meetSpeed: 0.3,
    meetMul: 1.5,
  }),
  combo: Object.freeze({ gapMs: 1000, perHit: 0.08, maxSteps: 12, milestones: Object.freeze([5, 10, 15, 20, 30, 40, 50]) }),
  bags: Object.freeze({
    baseHp: 90,             // strength of bag 1
    growth: 1.28,           // each next bag is this much tougher
    nextDropDelayMs: 650,   // chain snaps → the next bag starts coming down
    dropMs: 800,            // lowering it on its chain
    dropHeight: 1.2,        // m it starts above its hanging spot
    hittableAt: 0.8,        // drop progress from which it can be hit
    fallenLifeMs: 3400,     // a dropped bag lies, rolls aside and fades out over this long
    tipKick: 1.3,           // rad/s it starts toppling over (away from the player) on landing
    rollSpeed: 0.85,        // m/s it rolls aside once lying
    rollDecel: 0.45,        // m/s²
    maxFallen: 3,
  }),
});

const HEAD_PROBE_Y = TRAINING_LAYOUT.punch.headY;

export class BagPractice extends TrainingActivity {
  static KIND = 'bag';
  static TUNING = BAG_TUNING;

  _init() {
    const R = this.tuning.rig;
    this.rig = { pivot: [...R.pivot], chainLen: R.chainLen, bagLen: R.bagLen, radius: R.radius, L: R.chainLen + R.bagLen / 2 };
    /** Pendulum: ax = forward/back angle (+ = bottom swings AWAY from the player, toward −Z),
     *  az = sideways (+ = toward the player's right, +X), yaw = twist; v* are rates (rad/s). */
    this.swing = { ax: 0, vx: 0, az: 0, vz: 0, yaw: 0, vyaw: 0 };
    this.bag = this._newBag(1, 'hanging');
    this.bag.drop01 = 1;
    this.bagsDone = 0;
    this.fallen = [];
    this.lastLandAt = -1e9;
    this.lastHit = null;
    this.hitFlash = 0;
    this._throwInfo = new Map();
    this._lastFarPopup = -1e9;
    this.bagStats = { whiffs: 0, glancing: 0, meets: 0, damage: 0, bestHit: 0 };
  }

  /** Strength of bag n (1-based). */
  hpFor(n) {
    const B = this.tuning.bags;
    return Math.round(B.baseHp * Math.pow(B.growth, Math.max(0, n - 1)));
  }

  _newBag(n, state) {
    const hp = this.hpFor(n);
    return { n, tier: n, hp, maxHp: hp, state, drop01: 0, dropStart: 0, dropAt: 0 };
  }

  /** Score for `done` completed bags and the current bag's remaining strength (partial credit). */
  scoreFor(done, hp, maxHp) {
    const P = this.tuning.pointsPerBag;
    return done * P + Math.floor(P * clamp01(1 - hp / Math.max(1, maxHp)) + 1e-9);
  }

  // ───────────── geometry helpers (world metres) ─────────────

  /** Vertical offset of the bag while it is being lowered in (m, ≥ ~−0.04). */
  dropOffset() {
    const b = this.bag;
    if (b.state === 'hanging') return 0;
    if (b.state !== 'dropping') return this.tuning.bags.dropHeight;
    const k = clamp01(b.drop01);
    // lowered steadily, slowing down, and a little dip as the chain takes the weight
    const e = 1 - Math.pow(1 - k, 3) + 0.06 * Math.sin(Math.PI * k) * k * k;
    return this.tuning.bags.dropHeight * (1 - e);
  }

  /**
   * The bag at height y: how far its front surface has swung away from the resting spot (d, m,
   * + = farther from the player), the axis' sideways position (x) and how fast the surface moves
   * toward the player (v, m/s).
   */
  surfaceAt(y) {
    const s = this.swing, r = Math.max(0.05, this.rig.pivot[1] - y);
    const R = this.rig.radius;
    return {
      d: r * Math.sin(s.ax) + R * (1 - Math.cos(s.ax)),
      x: this.rig.pivot[0] + r * Math.sin(s.az),
      v: -s.vx * r,
      r,
    };
  }

  /** Is the bag there to be hit at all (not falling / being lowered)? */
  hittable() {
    const b = this.bag;
    return b.state === 'hanging' || (b.state === 'dropping' && b.drop01 >= this.tuning.bags.hittableAt);
  }

  /** World point on the bag's front surface at height y (where sparks go). */
  contactPoint(y, gx) {
    const s = this.swing, p = this.rig.pivot;
    const r = Math.max(0.05, p[1] - y);
    const R = this.rig.radius;
    const axisX = p[0] + r * Math.sin(s.az);
    const x = clamp(gx, axisX - R * 0.8, axisX + R * 0.8);
    return [x, p[1] - r * Math.cos(s.ax), p[2] - r * Math.sin(s.ax) + R * Math.cos(s.ax)];
  }

  /** Centre of the bag (world); a bag being lowered in hangs `dropOffset` higher. */
  bagCentre() {
    const s = this.swing, p = this.rig.pivot, L = this.rig.L - this.dropOffset();
    return [p[0] + L * Math.sin(s.az), p[1] - L * Math.cos(s.ax) * Math.cos(s.az), p[2] - L * Math.sin(s.ax)];
  }

  // ───────────── simulation ─────────────

  _step(h, t) {
    const dt = h / 1000;
    if (dt > 0) {
      this._stepSwing(dt);
      this._stepBagState(t);
      this._stepFallen(dt);
      this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    }
  }

  _stepSwing(dt) {
    const s = this.swing, P = this.tuning.physics;
    const w2 = P.g / this.rig.L;
    s.vx += (-w2 * Math.sin(s.ax) - P.damping * s.vx) * dt;
    s.ax += s.vx * dt;
    s.vz += (-w2 * Math.sin(s.az) - P.sideDamping * s.vz) * dt;
    s.az += s.vz * dt;
    s.vyaw += (-P.twistStiffness * s.yaw - P.twistDamping * s.vyaw) * dt;
    s.yaw += s.vyaw * dt;
    if (s.ax > P.maxSwing) { s.ax = P.maxSwing; if (s.vx > 0) s.vx = 0; }
    if (s.ax < P.bumpAngle) { s.ax = P.bumpAngle; if (s.vx < 0) s.vx = -s.vx * P.bumpRestitution; }
    if (Math.abs(s.az) > P.maxSwing) { s.az = Math.sign(s.az) * P.maxSwing; s.vz = 0; }
  }

  _stepBagState(t) {
    const b = this.bag, B = this.tuning.bags;
    if (b.state === 'waiting' && t >= b.dropAt) {
      b.state = 'dropping';
      b.dropStart = t;
      b.drop01 = 0;
      this._event('bag-new', { bag: b.n, tier: b.tier, hp: b.maxHp });
    }
    if (b.state === 'dropping') {
      const was = b.drop01;
      b.drop01 = clamp01((t - b.dropStart) / B.dropMs);
      if (was < B.hittableAt && b.drop01 >= B.hittableAt) this.lastLandAt = Math.max(this.lastLandAt, t - 200); // combos carry over bags
      if (b.drop01 >= 1) {
        b.state = 'hanging';
        // the chain catching the bag sets it swinging a touch
        this.swing.vx += (this.rng.float() - 0.5) * 0.12;
        this.swing.vz += (this.rng.float() - 0.5) * 0.08;
      }
    }
  }

  /**
   * A dropped bag: free fall → lands on its bottom → topples over AWAY from the player (pivoting on
   * its bottom rim) → lies on its side and rolls aside → fades out. Orientation for the renderer:
   * Euler XYZ (tilt, roll, 0) — tilt about world X (−π/2 = lying with its top away from the
   * player), roll about the bag's own long axis.
   */
  _stepFallen(dt) {
    const B = this.tuning.bags, g = this.tuning.physics.g, half = this.rig.bagLen / 2, R = this.rig.radius;
    for (const f of this.fallen) {
      f.age += dt * 1000;
      if (f.state === 'falling') {
        f.vy -= g * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        f.tilt += f.tiltV * dt;
        if (f.y - half * Math.cos(f.tilt) <= 0) {
          f.state = 'tipping';
          f.landings++;
          f.bx = f.x;
          f.bz = f.z - half * Math.sin(f.tilt);
          f.tiltV = Math.min(f.tiltV, 0) - B.tipKick;
          f.vx *= 0.3;
        }
      } else if (f.state === 'tipping') {
        f.tiltV += (g / half) * Math.sin(f.tilt) * 0.75 * dt;
        f.tilt += f.tiltV * dt;
        f.bx += f.vx * dt;
        if (f.tilt <= -Math.PI / 2) {
          f.tilt = -Math.PI / 2;
          f.state = 'lying';
          f.landings++;
          f.rollV = B.rollSpeed * f.rollDir;
        }
        f.x = f.bx;
        f.y = half * Math.cos(f.tilt) + R * Math.abs(Math.sin(f.tilt));
        f.z = f.bz + half * Math.sin(f.tilt);
      } else {
        const sp = Math.max(0, Math.abs(f.rollV) - B.rollDecel * dt);
        f.rollV = Math.sign(f.rollV) * sp;
        f.x += f.rollV * dt;
        f.roll += (f.rollV / R) * dt;
        f.y = R;
      }
      f.alpha = 1 - clamp01((f.age - (B.fallenLifeMs - 900)) / 900);
    }
    if (this.fallen.some((f) => f.age >= B.fallenLifeMs)) this.fallen = this.fallen.filter((f) => f.age < B.fallenLifeMs);
  }

  // ───────────── punches ─────────────

  _onThrown(p, t) {
    void t;
    const c = punchContact(p, [0, 0, 0], undefined, this.trainee.lean);
    const s = this.surfaceAt(c[1]);
    this._throwInfo.set(p.id, { d: s.d, x: s.x, v: s.v, hittable: this.hittable(), gx: c[0], reach: TRAINING_LAYOUT.punch.planeZ - c[2] });
    if (this._throwInfo.size > 16) this._throwInfo.delete(this._throwInfo.keys().next().value);
  }

  _resolvePunch(p, t) {
    const H = this.tuning.hit, C = this.tuning.combo;
    const info = this._throwInfo.get(p.id) || null;
    this._throwInfo.delete(p.id);
    const contact = punchContact(p, [0, 0, 0], undefined, this.trainee.lean);
    if (info) contact[0] = info.gx; // where the glove was headed when the punch left
    const y = contact[1];
    const extra = info ? info.reach : TRAINING_LAYOUT.punch.planeZ - contact[2]; // leaning in reaches further
    const canNow = this.hittable();
    if (!canNow && !(info && info.hittable && this.bag.state !== 'waiting')) {
      // nothing hanging there (between bags): a free swing — no penalty, no combo break
      return { result: 'miss' };
    }
    const now = this.surfaceAt(y);
    const d = info ? Math.min(now.d, info.d) : now.d;
    const vToward = info ? Math.max(now.v, info.v) : now.v;
    const R = this.rig.radius;
    const side = Math.min(Math.abs(contact[0] - now.x), info ? Math.abs(contact[0] - info.x) : Infinity);
    const slack = H.reachSlack + extra;
    let quality = d <= slack ? 1 : d <= slack + H.glanceExtra ? H.glanceMul : 0;
    if (side > R + H.sideSlack) quality = 0;
    if (quality <= 0) {
      this.bagStats.whiffs++;
      this._comboBreak();
      if (t - this._lastFarPopup > 700) { this._lastFarPopup = t; this._popup('TOO FAR', 'miss'); }
      this._event('bag-miss', { hand: p.hand, punch: p.kind, pos: contact });
      return { result: 'miss' };
    }

    // combo: clean punches build it, a graze keeps it alive, a whiff (above) or a pause breaks it
    if (t - this.lastLandAt > C.gapMs) this.combo = 0;
    if (quality >= 1 || this.combo === 0) this._comboUp();
    this.lastLandAt = t;
    const comboMul = 1 + C.perHit * Math.min(this.combo - 1, C.maxSteps);
    const meet = quality >= 1 && vToward >= H.meetSpeed;
    const power = clamp01(num(p.power, 0.6));
    const powerMul = lerp(H.powerMul[0], H.powerMul[1], power);
    let damage = (H.damage[p.kind] ?? H.damage.straight) * powerMul * (p.target === 'body' ? H.bodyMul : 1) * quality * comboMul;
    if (meet) damage *= H.meetMul;
    damage = Math.round(damage * 10) / 10;

    // physics: the kick
    const s = this.swing;
    const arm = now.r / this.rig.L;
    const pk = 0.7 + 0.6 * power;
    const kick = (H.kick[p.kind] ?? H.kick.straight) * pk * arm * quality * (meet ? 1.15 : 1);
    if (s.vx < 0) s.vx = -s.vx * H.restitution + kick;   // met on its way back: stopped and sent away
    else if (s.vx < 0.05) s.vx += kick;                    // (nearly) still
    else s.vx += kick * H.chaseMul;                        // chasing a bag that already swings away
    const handSide = p.hand === 'left' ? 1 : -1; // a left hook sweeps toward the player's right (+X)
    s.vz += handSide * (H.sideKick[p.kind] ?? 0) * pk * arm * quality;
    s.vyaw += -handSide * (H.twistKick[p.kind] ?? 0) * pk * quality;

    // strength + score (partial credit)
    const b = this.bag;
    const dealt = Math.min(b.hp, damage);
    b.hp = Math.max(0, b.hp - damage);
    this.bagStats.damage += dealt;
    this.bagStats.bestHit = Math.max(this.bagStats.bestHit, damage);
    if (quality < 1) this.bagStats.glancing++;
    if (meet) this.bagStats.meets++;
    this.stats.landed++;
    this.hitFlash = 1;
    const pos = this.contactPoint(y, contact[0]);
    this.lastHit = { t, hand: p.hand, kind: p.kind, target: p.target, y, quality, meet, damage, pos };
    const strength = clamp01(damage / 14);
    this._event('bag-hit', {
      pos, power: clamp01(0.35 + strength * 0.65), hand: p.hand, punch: p.kind, target: p.target,
      damage, meet, glancing: quality < 1, combo: this.combo, hp01: b.hp / b.maxHp, bag: b.n,
    });
    const target = b.hp <= 0 ? (this.bagsDone + 1) * this.tuning.pointsPerBag : this.scoreFor(this.bagsDone, b.hp, b.maxHp);
    if (target !== this.score) this._score(target - this.score, b.hp <= 0 ? 'bag-complete' : meet ? 'bag-meet' : 'bag-hit', { pos });
    if (meet) this._popup('NICE TIMING!', 'good', pos);
    else if (quality < 1 && t - this._lastFarPopup > 700) { this._lastFarPopup = t; this._popup('GRAZE', 'ok', pos); }
    if (C.milestones.includes(this.combo)) this._popup(`${this.combo} COMBO!`, 'bonus', pos);
    if (b.hp <= 0) this._breakBag(t, p);
    return { result: 'hit' };
  }

  _breakBag(t, p) {
    const b = this.bag, B = this.tuning.bags, s = this.swing, L = this.rig.L;
    this.bagsDone++;
    const c = this.bagCentre();
    const top = [this.rig.pivot[0] + this.rig.chainLen * Math.sin(s.az), this.rig.pivot[1] - this.rig.chainLen, this.rig.pivot[2] - this.rig.chainLen * Math.sin(s.ax)];
    this._event('bag-break', { pos: top, bag: b.n, tier: b.tier, bagsDone: this.bagsDone, hand: p?.hand });
    this._popup(`BAG ${b.n} DOWN!`, 'break', c);
    this.fallen.push({
      n: b.n, tier: b.tier, state: 'falling', age: 0, alpha: 1, landings: 0,
      x: c[0], y: c[1], z: c[2],
      vx: s.vz * L * 0.6, vy: 0, vz: -s.vx * L * 0.6,
      tilt: s.ax, tiltV: s.vx * 0.5, roll: 0, rollV: 0, rollDir: this.rng.float() < 0.5 ? -1 : 1, yaw: s.yaw,
      bx: 0, by: 0, bz: 0,
    });
    while (this.fallen.length > B.maxFallen) this.fallen.shift();
    this.swing = { ax: 0, vx: 0, az: 0, vz: 0, yaw: 0, vyaw: 0 };
    this.bag = this._newBag(b.n + 1, 'waiting');
    this.bag.dropAt = t + B.nextDropDelayMs;
  }

  _details() {
    const b = this.bag;
    const partial01 = b.state === 'hanging' || b.state === 'dropping' ? clamp01(1 - b.hp / b.maxHp) : 0;
    return {
      bags: this.bagsDone,
      partial01: Math.round(partial01 * 100) / 100,
      whiffs: this.bagStats.whiffs,
      glancing: this.bagStats.glancing,
      meets: this.bagStats.meets,
      damage: Math.round(this.bagStats.damage),
      bestHit: this.bagStats.bestHit,
    };
  }

  _fillView(view) {
    const b = this.bag, s = this.swing, H = this.tuning.hit;
    const head = this.surfaceAt(HEAD_PROBE_Y);
    const hit = this.lastHit;
    view.bag = {
      n: b.n, tier: b.tier, state: b.state,
      hp: Math.round(b.hp * 10) / 10, maxHp: b.maxHp, hp01: b.hp / b.maxHp,
      drop01: b.state === 'hanging' ? 1 : b.drop01, dropOffset: this.dropOffset(),
      hittable: this.hittable(),
      swing: { ax: s.ax, az: s.az, yaw: s.yaw, vx: s.vx, vz: s.vz },
      rig: { pivot: this.rig.pivot, chainLen: this.rig.chainLen, bagLen: this.rig.bagLen, radius: this.rig.radius },
      reachD: head.d,               // how far (m) the bag has swung past its resting surface (≤ reachSlack: in reach)
      inReach: head.d <= H.reachSlack,
      approach: head.v,             // m/s toward the player (≥ meetSpeed: meeting it now earns the bonus)
      meetReady: this.hittable() && head.d <= H.reachSlack && head.v >= H.meetSpeed,
      hitFlash: this.hitFlash,
      lastHit: hit ? { age: (this.t - hit.t) / 1000, hand: hit.hand, kind: hit.kind, y: hit.y, meet: hit.meet, quality: hit.quality, pos: hit.pos, damage: hit.damage } : null,
      bagsDone: this.bagsDone,
      fallen: this.fallen.map((f) => ({
        n: f.n, tier: f.tier, state: f.state, x: f.x, y: f.y, z: f.z, tilt: f.tilt, roll: f.roll, yaw: f.yaw,
        alpha: f.alpha, age: f.age / 1000, landings: f.landings,
      })),
    };
    view.bagsDone = this.bagsDone;
  }
}

/** Phases re-exported for convenience. */
export { TrainingPhase };
