// Regression tests of the real-data tuning round (RT-*, gesture.js header item 11): failure modes the labelled real
// clips showed, rebuilt on synthetic players by editing their landmarks the way the real MediaPipe output differed —
// RT-2 a player who steps back from the camera (the face shrinks with the shoulders: no turn). RT-1 (real world depth
// reading a jab as pulled back) and RT-13 (a hidden wrist parked low at low visibility snapping back up) are not rebuilt
// here — the generator's jabs from a guard barely foreshorten in the picture, and its dropouts freeze the landmark instead
// of parking it — they are measured on the labelled real clips (PUNCH/tools/realbench.mjs, c5's hard negatives).
import { test, assert } from '../harness.mjs';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { makeSyntheticPlayer, sequence, randomPlayerOptions } from '../../src/input/synthetic.js';

function punches(frames, tuning) {
  const rec = new GestureRecognizer({ tuning });
  const ev = [];
  for (const fr of frames) for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
  return { ev, rec };
}
const hitOf = (ev, p) => ev.find((e) => e.punch.hand === p.hand && e.t >= p.tStart - 40 && e.t <= p.tPeak + 350);
const clone = (frames) => frames.map((f) => ({ ...f, players: f.players.map((p) => (p ? { ...p, image: p.image.map((l) => ({ ...l })), world: p.world.map((l) => ({ ...l })) } : p)) }));

test('RT-2: stepping back from the camera (face and shoulders shrink together) is no turn — the next jab registers at once', () => {
  let hit = 0, hitOld = 0, n = 0, notFacing = 0, notFacingOld = 0, frames0 = 0;
  // (facing frames from the step back to the jab's end, read from the recognizer's debug output)
  const facingRun = (f2, tuning, from, to) => {
    const rec = new GestureRecognizer({ tuning });
    const ev = []; let off = 0, cnt = 0;
    for (const fr of f2) {
      for (const e of rec.update(fr.players[0], fr.t).events) if (e.type === 'punch') ev.push(e);
      if (fr.t >= from && fr.t <= to && rec.debug && rec.debug.facing !== null) { cnt++; if (rec.debug.facing === false) off++; }
    }
    return { ev, off, cnt };
  };
  for (let i = 0; i < 12; i++) {
    const o = randomPlayerOptions(5400 + i, {});
    const h = i % 2 ? 'left' : 'right';
    const { frames, truth } = makeSyntheticPlayer(o).run(sequence([{ action: 'guard-high', ms: 2000 }, { action: 'guard-high', ms: 1200 }, { action: `jab-${h}`, ms: 1000 }, { action: 'guard-high', ms: 700 }]));
    const p = truth.punches[0];
    // the player steps back between 2.0 and 2.6 s: every image landmark moves toward the frame centre to 55 % of its
    // size (the face too — a turn would narrow only the shoulders)
    const f2 = clone(frames);
    for (const f of f2) {
      const P = f.players[0];
      if (!P) continue;
      const k = f.t < 2000 ? 1 : f.t > 2600 ? 0.55 : 1 - 0.45 * (f.t - 2000) / 600;
      for (const l of P.image) { l.x = 0.5 + (l.x - 0.5) * k; l.y = 0.5 + (l.y - 0.5) * k; }
    }
    n++;
    const a = facingRun(f2, {}, 2000, p.tPeak + 300), b = facingRun(f2, { facingHeadTauMs: 0 }, 2000, p.tPeak + 300);
    if (hitOf(a.ev, p)) hit++;
    if (hitOf(b.ev, p)) hitOld++;
    notFacing += a.off; notFacingOld += b.off; frames0 += a.cnt;
  }
  console.log(`      jab 0.6 s after a step back to 55 % size: ${hit}/${n} (shoulder width alone: ${hitOld}/${n}); 'not facing' frames from the step to the jab ${notFacing}/${frames0} (alone: ${notFacingOld})`);
  // (V2-10: the shoulder-width UNIT follows a face-explained narrowing only after facingDistHoldMs 2 s — a boxer blading for a
  // punch must not shake every position — so the jab right after the step is measured in a unit still ≈ 1/0.65 too large:
  // 7/12 here, 8/12 with an immediate follow; the facing test itself never blocks it)
  assert(notFacing === 0 && notFacingOld >= frames0 / 2, `not facing ${notFacing} / alone ${notFacingOld} of ${frames0}`);
  assert(hit >= 0.55 * n && hit >= hitOld + 4, `${hit}/${n} vs ${hitOld}/${n}`);
});
