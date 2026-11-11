// Art direction for Glove Up — shared by every render module so the game reads as one world.
//
// Mood: a bright, friendly Sunday-afternoon exhibition bout. Clean, saturated, soft light,
// toy-like characters with chunky gloves. Readability first: gloves and the opponent's
// face must pop against the background at all times.
//
// CHARACTER STYLE: very basic and simple, built from a handful of smooth primitives —
//  a rounded egg-shaped head on a short visible neck, a simple tapered torso (shoulders a bit
//  wider than hips), plain capsule arms ending in oversized round gloves, simple trunks with a
//  contrasting waistband, short capsule legs, rounded shoes. Smooth matte surfaces, no texture
//  detail except the face. Faces are a few flat painted marks on a CanvasTexture from our own
//  feature kit (see APPEARANCE_OPTIONS): eyes, brows, nose, mouth. Simple and readable.
//
// ORIGINALITY / DEBRANDING RULES (non-negotiable):
//  - No brand names anywhere: never write the reference game's name, its console's name, its
//    maker's name or its avatar system's name in code, comments, UI, file names or docs
//    (tests/unit/debrand.test.mjs enforces this). Call it "the reference game".
//  - Never imitate a specific existing avatar system's face parts or proportions, or the
//    reference game's ring colour scheme, timer graphic, HUD layout, logos, fonts or music.
//    Simple-and-friendly is a broad style; ours has its own palette, ring and HUD (below).
//
// Camera language (gameplay feel, research/mechanics.md §6): just behind the player's head, at
// about head height and a little to the left, so the own boxer's see-through head sits high in
// the frame beside the opponent's (its body is drawn about half transparent while the gloves stay
// solid); the opponent is seen whole and readable (its guard sits beside the jaw). Hard cuts during play (the player-hit
// over-the-shoulder, knockdown shots), the venue turning slowly as if the fighters circle, an
// arena → fly-in → ring-level → behind-the-player sequence for intros and round changes, and our
// own logo wipe + slow-motion replay for the KO outro. There is no referee: the count is numbers
// (HUD) and voice (audio).

import * as THREE from 'three';

export const PALETTE = Object.freeze({
  // arena
  skyTop: 0x1b2340,        // deep evening navy behind the crowd
  skyBottom: 0x2d3a66,
  canvas: 0xf2ece0,        // ring canvas: warm ivory
  canvasLogo: 0x2bb3a3,    // teal centre medallion
  canvasEdge: 0xe9dfcc,
  apron: 0x1f3b73,         // ring apron skirt: royal navy
  apronText: 0xffd166,
  ropeA: 0xff6b5a,         // coral
  ropeB: 0xf7f3ea,         // cream
  ropeC: 0x2bb3a3,         // teal
  post: 0xffc94a,          // golden corner posts
  turnbuckleP1: 0x3d7bff,  // blue corner pad
  turnbuckleP2: 0xff4d5e,  // red corner pad
  turnbuckleN: 0xf7f3ea,   // neutral corners
  floor: 0x232a45,
  crowd: [0xff8a5b, 0xffd166, 0x5bd1b8, 0x6c8dff, 0xc77dff, 0xff5d8f, 0x9be564, 0xf4f1e8],
  spotlight: 0xfff1d6,
  // fighters (defaults; per-character colours come from Appearance)
  p1Accent: 0x3d7bff,
  p2Accent: 0xff4d5e,
  // effects
  hitSpark: 0xfff3b0,
  hitSparkCore: 0xffffff,
  counterSpark: 0xffb703,
  blockPuff: 0xbfd7ff,
  dodgeTrail: 0xa0f0ff,
  sweat: 0xdff6ff,
  // hit vocabulary (research/mechanics.md §5 — functional colours, our own shapes)
  hitPink: 0xff4fa0,       // the player's clean hit
  hitPinkHi: 0xffb3d9,
  blockRing: 0x22d65e,     // any block
  blockRingHi: 0x9dffb8,
  takenBlue: 0x5fb8ff,     // the player was hit (blue/white burst)
  heavyPurple: 0xa45cff,   // heavy hit or counter on the player
  speedLines: 0xff7a1f,    // orange radial lines before the player-hit cut
  trailRed: 0xff3b3b,      // opponent power punch / hook trail and miss streak
  trailBlue: 0x4aa8ff,     // the player's fast punch
  slowTint: 0x9d8cff,      // dodge slow-motion tint
  // on-hit health meters (10 rounded capsules; our own graphic, not a pie)
  meterPlayer: 0x3d7bff,
  meterOpponent: 0xff5a4f,
  meterDark: 0x232842,
  meterRim: 0xfffaf0,
  // ui (CSS uses the same values; see src/ui/styles.css :root)
  uiInk: 0x14182b,
  uiPaper: 0xfffaf0,
  uiAccent: 0xff6b5a,
  uiGood: 0x2bb3a3,
  uiWarn: 0xffc94a,
});

export const css = (hex) => '#' + hex.toString(16).padStart(6, '0');

/** Matte "vinyl toy" material for skin/clothes. */
export function vinyl(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.55, metalness: 0.0,
    transparent: !!opts.transparent, opacity: opts.opacity ?? 1,
    depthWrite: opts.transparent ? false : true,
    ...opts.extra,
  });
}

/** Glossy leather for gloves (clearcoat sheen so gloves pop). */
export function leather(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.32, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25,
    transparent: !!opts.transparent, opacity: opts.opacity ?? 1,
    depthWrite: opts.transparent ? false : true,
  });
}

/** Flat unlit material for crowd silhouettes / far background. */
export function flat(color, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, transparent: !!opts.transparent, opacity: opts.opacity ?? 1 });
}

/** Opacity used for the local player's own boxer when the camera is behind them. */
export const PLAYER_GHOST_OPACITY = 0.5;

/** Neutral "studio" lighting (character portraits and other renders outside the venue). */
export const LIGHTING = Object.freeze({
  hemiSky: 0xfff4e0, hemiGround: 0x2a3150, hemiIntensity: 1.1,
  keyColor: 0xfff1d6, keyIntensity: 2.4, keyPos: [2.5, 7, 4],
  rimColor: 0x9fc4ff, rimIntensity: 1.2, rimPos: [-3, 4, -5],
  exposure: 1.05,
  fogColor: 0x1b2340, fogNear: 14, fogFar: 40,
});

/**
 * The venue's light (renderer + arena; VISUAL-10): a spotlit night arena like the reference's —
 * a tight, warm spot carries the ring (ARENA_TUNING.key sets its cone), a low hemisphere fill, a
 * soft cool rim, the hall falling away to near-black navy and the crowd fading into warm dark.
 * Our hues are unchanged; only how they are lit. Measured on a live frame (HUD band cropped):
 * mean luma ~97 (was 126–148; reference 82–104), ≥ 35 % dark pixels (was 6 %), stands ~52 luma
 * with a warm tint (was 78–88, cool); knockdown wide shot ≤ ~45 % pixels above 200 (was 66–75 %).
 */
export const VENUE_LIGHTING = Object.freeze({
  hemiSky: 0xfff4e0, hemiGround: 0x2a2028, hemiIntensity: 0.45,
  keyColor: 0xffdcae, keyIntensity: 3.6, keyPos: [2.5, 7, 4],
  rimColor: 0x9fc4ff, rimIntensity: 0.55, rimPos: [-3, 4, -5],
  exposure: 0.95,
  hallTop: 0x0a0d1c, hallBottom: 0x13182e,  // the dome and clear colour: our navy, near black
  fogColor: 0x0a0d1c, fogNear: 14, fogFar: 40,
  crowdHaze: 0x050201,   // sRGB colour the back rows fade into (near-black, warm)
  canvasTone: 0xcbcbcb,  // multiplies the ring canvas texture: the ivory's albedo luma ~236 → ~186
});

/** World layout (meters). Ring centre at origin, Y up. P1 stands at +Z facing -Z; P2 at -Z facing +Z. */
export const LAYOUT = Object.freeze({
  ringHalf: 3.0,          // ring is 6m x 6m inside the ropes
  ringHeight: 0.0,        // canvas surface at y = 0 (the floor of the arena is below at -1.1)
  apronDrop: 1.1,
  fighterGap: 1.15,       // distance between fighters' centres at neutral
  p1Pos: [0, 0, 0.575],
  p2Pos: [0, 0, -0.575],
  boxerHeight: 1.55,      // top of head at height scale 1.0 (toy proportions)
  ropeHeights: [0.45, 0.8, 1.15],
});

/** Camera presets (relative to P1 position, looking at P2's chest). */
export const CAMERA = Object.freeze({
  fov: 52,
  overShoulder: { offset: [0.0, 1.55, 1.25], lookAt: [0, 1.05, -0.6] },
  // versus viewports are about square: a little wider than the single view's 58° so the own
  // see-through head (high on the right) leaves the opponent room
  versusFov: 64,
});

/** Typography for in-world and DOM text. Display font is loaded in index.html (Google Fonts). */
export const FONTS = Object.freeze({
  display: "'Lilita One', 'Arial Rounded MT Bold', system-ui, sans-serif",
  body: "'Nunito', system-ui, sans-serif",
});
