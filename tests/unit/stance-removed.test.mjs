// The southpaw configuration was removed on 2026-11-10: every boxer is orthodox (the left glove leads) and there is no
// stance choice anywhere — no stance screen, no stored stance, no setStance. These tests keep it removed. (The fighting
// POSTURE called "stance" — the tutorial's "Gloves up" card, ControlState.stanceMs, the synthetic idle arm posture — is a
// different thing and stays.)
// The scripted test players (src/input/synthetic.js) name their lead hand instead, lead: 'left'|'right', drawn exactly as
// the old option was, so every seed is the same player as before (a right-lead player is the former southpaw one). The
// pinned values below were taken from the generator before the change; with GLOVE_BEFORE_ROOT=<a copy of the project
// from before the change> the players are also compared with that copy's generator directly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, assert } from '../harness.mjs';
import * as types from '../../src/core/types.js';
import * as kit from '../../src/ui/screens/kit.js';
import { Storage, STORAGE_KEYS } from '../../src/core/storage.js';
import { InputHub } from '../../src/input/input-hub.js';
import { neutralControl } from '../../src/input/keyboard.js';
import { GestureRecognizer } from '../../src/input/gesture.js';
import { CalibrationSession } from '../../src/input/calibration.js';
import { Boxer } from '../../src/game/boxer.js';
import { humanCorner } from '../../src/app/session.js';
import { randomPlayerOptions, makeSyntheticPlayer, sequence, hashSeed } from '../../src/input/synthetic.js';
import { makeBackend, makeDeterministic } from './storage-fakes.test.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAL = { version: 1, shoulderWidth: 0.21, armLengthWorld: 0.58, neutralHead: { x: 0.5, y: 0.31 }, neutralShoulderY: 0.45, swapSides: false, createdAt: 5 };

test('stance removed: no stance screen, no Stance enum, no stance glove helper', () => {
  assert(!existsSync(join(ROOT, 'src/ui/screens/stance.js')), 'src/ui/screens/stance.js is gone');
  const ui = readFileSync(join(ROOT, 'src/ui/ui.js'), 'utf8');
  const block = /export const SCREENS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(ui);
  assert(block, 'the SCREENS table of src/ui/ui.js');
  const ids = block[1].replace(/\/\/.*$/gm, '').split(',').map((e) => e.split(':')[0].trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert(ids.includes('mode') && ids.includes('camera-setup'), `screen ids read: ${ids.join(' ')}`);
  assert(!ids.includes('stance'), 'no stance screen is registered (SCREENS / SCREEN_IDS)');
  assert(!/screens\/stance\.js/.test(ui), 'ui.js imports no stance screen');
  assert(!('Stance' in types), 'core/types.js exports no Stance enum');
  assert(!('stanceGloves' in kit), 'kit.js has no stanceGloves()');
});

test('stance removed: profiles carry no stance — one saved by an older build loads fine without it', () => {
  const old = {
    schema: 1, id: 'old1', name: 'Lefty', kind: 'local', appearance: {}, stance: 'southpaw', calibration: { ...CAL, stance: 'southpaw' },
    skill: 0, pro: false, records: { matches: { wins: 0, losses: 0, draws: 0, kos: 0, history: [] } }, createdAt: 1, updatedAt: 2,
  };
  const backend = makeBackend({ seed: { [STORAGE_KEYS.index]: JSON.stringify(['old1']), [STORAGE_KEYS.profile('old1')]: JSON.stringify(old) } });
  const store = new Storage({ backend, ...makeDeterministic() });
  assert.equal(store.status().issues.length, 0, 'the old profile loads without complaint');
  const p = store.getProfile('old1');
  assert(p && p.name === 'Lefty' && !('stance' in p), JSON.stringify(p));
  assert(p.calibration && p.calibration.shoulderWidth === CAL.shoulderWidth && !('stance' in p.calibration), 'its calibration loads, without the stance');
  const made = store.createProfile({ name: 'Newbie', stance: 'southpaw' }).profile;
  assert(made && !('stance' in made), 'createProfile ignores a stance');
  assert(store.updateProfile(made.id, { stance: 'southpaw' }).ok && !('stance' in store.getProfile(made.id)), 'updateProfile ignores a stance');
  assert(!('stance' in JSON.parse(store.exportProfile(made.id)).profile), 'an exported profile has none');
  assert(!('stance' in store.guest({ stance: 'southpaw' })), 'a guest has none');
});

class FakeRecognizer {
  constructor(opts) { this.opts = opts; FakeRecognizer.last = this; }
  update(pose) { return { control: neutralControl({ tracked: !!pose }), events: [] }; }
  setCalibration() {}
  reset() {}
}
class FakeCalibration {
  constructor(opts) { this.opts = opts; FakeCalibration.last = this; }
  update() { return { step: 'frame', progress: 0, message: '', ok: false, done: false, result: null }; }
}

test('stance removed: the input hub has no setStance; its profiles, recognizers and calibrations carry no stance', () => {
  FakeRecognizer.last = FakeCalibration.last = null;
  const hub = new InputHub({ players: 1, profiles: [{ calibration: CAL, stance: 'southpaw' }], deps: { GestureRecognizer: FakeRecognizer, CalibrationSession: FakeCalibration } });
  assert.equal(hub.setStance, undefined, 'no setStance');
  assert.deepEqual(hub.profiles, [{ calibration: CAL }, { calibration: null }]);
  hub.setProfiles([{ calibration: CAL, stance: 'southpaw' }, { stance: 'southpaw' }]);
  assert.deepEqual(hub.profiles, [{ calibration: CAL }, { calibration: null }], 'setProfiles keeps only the calibration');
  hub.injectFrames([{ t: 0, width: 640, height: 480, players: [makeSyntheticPlayer({ seed: 1, noise: 0 }).pose(500, 'guard-high')] }]);
  assert(FakeRecognizer.last && FakeRecognizer.last.opts.calibration === CAL && !('stance' in FakeRecognizer.last.opts), 'the recognizer is made without a stance');
  hub.calibrate(0);
  assert(FakeCalibration.last && !('stance' in FakeCalibration.last.opts), 'the calibration session is made without a stance');
  // the real ones: no stance option or field; a calibration saved with a stance is read without it
  const rec = new GestureRecognizer({ calibration: { ...CAL, stance: 'southpaw' } });
  assert(!('stance' in rec) && rec.setStance === undefined, 'GestureRecognizer: no stance, no setStance()');
  assert(!('stance' in new CalibrationSession()), 'CalibrationSession: no stance');
});

test('stance removed: every boxer is orthodox — the left glove leads, the right is the rear hand', () => {
  const b = new Boxer({ id: 'p1', isHuman: true, name: 'Lefty', stance: 'southpaw' });
  b.update(0);
  assert.equal(b.leadHand(), 'left');
  assert.equal(b.rearHand(), 'right');
  assert(!('stance' in b) && !('stance' in b.toView(0)), 'no stance on the boxer or its view');
  assert(!('stance' in humanCorner({ name: 'Ann', stance: 'southpaw' })), 'a human corner gets no stance from the profile');
});

// ── the scripted players: lead instead of stance, the same players per seed ──
const SEEDS = Array.from({ length: 40 }, (_, i) => i);
const LEADS_BEFORE = 'RRRLLLRLLRLLLLLLLRLLLLRLLRLRLLLLLLLRLLRR'; // seeds 0…39 before the change (R = southpaw then)
const OPTIONS_HASH = 2756448448; // the options of those players (+ the first 8 with preset 'real-like'), southpaw → lead 'right'
const FRAMES = { right: 2871808073, left: 1353573208, randomRight: 4000882327 }; // frames of seed 4 as southpaw / orthodox, and of seed 0
const optsHash = (opts) => opts.reduce((h, o) => hashSeed(h, JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))), 0);
const ACTS = sequence([{ action: 'idle', ms: 600 }, { action: 'guard-high', ms: 600 }, 'jab', 'cross', 'hook-left', 'uppercut-right', 'body-left',
  { action: 'twist-left', ms: 500 }, { action: 'duck', ms: 500 }]);
function framesHash(make, o) {
  let h = 0;
  for (const fr of make(o).run(ACTS).frames) {
    h = hashSeed(h, Math.round(fr.t * 1000));
    const p = fr.players[0];
    if (!p) { h = hashSeed(h, 'null'); continue; }
    for (const l of p.image) h = hashSeed(h, Math.round(l.x * 1e6), Math.round(l.y * 1e6));
    for (const l of p.world) h = hashSeed(h, Math.round(l.x * 1e6), Math.round(l.y * 1e6), Math.round(l.z * 1e6));
  }
  return h;
}

test('stance removed: synthetic players name their lead hand (left | right) — every seed the same player as before', async () => {
  const opts = SEEDS.map((s) => randomPlayerOptions(s));
  for (const o of opts) assert(!('stance' in o) && (o.lead === 'left' || o.lead === 'right'), JSON.stringify(o));
  assert.equal(opts.map((o) => (o.lead === 'right' ? 'R' : 'L')).join(''), LEADS_BEFORE, 'the same 70 / 30 draw as before');
  assert.equal(optsHash([...opts, ...SEEDS.slice(0, 8).map((s) => randomPlayerOptions(s, { preset: 'real-like' }))]), OPTIONS_HASH, 'otherwise the same options');
  assert.equal(framesHash(makeSyntheticPlayer, { seed: 4, lead: 'right' }), FRAMES.right, 'a right-lead player moves as before');
  assert.equal(framesHash(makeSyntheticPlayer, { seed: 4 }), FRAMES.left, 'the default (left lead) as before');
  assert.equal(framesHash(makeSyntheticPlayer, opts[0]), FRAMES.randomRight, 'a random right-lead player as before');
  const before = process.env.GLOVE_BEFORE_ROOT;
  if (!before) return;
  const B = await import(pathToFileURL(join(before, 'src/input/synthetic.js')).href);
  const asLead = ({ stance, ...rest }) => ({ ...rest, lead: stance === 'southpaw' ? 'right' : 'left' });
  for (const ov of [{}, { preset: 'real-like' }, { preset: 'real-like', distance: 1.5 }, { noise: 1 }]) {
    for (let s = 0; s < 120; s++) assert.deepEqual(randomPlayerOptions(s, ov), asLead(B.randomPlayerOptions(s, ov)), `seed ${s} ${JSON.stringify(ov)}`);
  }
  for (const s of [0, 1, 2, 6, 9]) {
    const o = randomPlayerOptions(s);
    assert.equal(framesHash(makeSyntheticPlayer, o), framesHash(B.makeSyntheticPlayer, B.randomPlayerOptions(s)), `frames of seed ${s} (${o.lead} lead)`);
  }
});

test('stance removed: no southpaw anywhere in src/, and none of the removed stance plumbing', () => {
  const removed = /setStance|ensureStance|stanceGloves|_stanceConfirmed|\bStance\.|screens\/stance/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/southpaw/i.test(line) || removed.test(line)) hits.push(`${relative(ROOT, p).split(sep).join('/')}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(hits, []);
});
