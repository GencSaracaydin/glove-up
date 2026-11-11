// Lazy, failure-tolerant access to modules owned by other engineers that the UI can use but
// must never depend on to work: the 3D boxer model (portraits), the webcam preview drawer,
// the opponent roster, progression constants, training medal cutoffs, the keyboard map and the
// calibration defaults (the help screen's key table and calibration card).
//
// `import.meta.glob` (Vite) lists only files that exist: a missing module is simply absent
// (no dev/build error) and present ones are bundled for production. Every loader is
// guarded, so a module that throws while loading, or lacks an export, makes the UI fall back
// (2D portraits, built-in skeleton preview, generic texts) instead of breaking.
// The app may also inject modules explicitly: new UI({ modules: { boxerModel: {BoxerModel}, … } }).
//
// Browser-only (uses import.meta.glob); pure helpers live in kit.js.

const FILES = import.meta.glob([
  '../../render/boxer-model.js',
  '../../input/preview.js',
  '../../game/roster.js',
  '../../game/progression.js',
  '../../training/medals.js',
  '../../input/camera.js',
  '../../input/keyboard.js',
  '../../input/calibration.js',
]);

/** Logical name → source file. */
const PATHS = Object.freeze({
  boxerModel: '../../render/boxer-model.js',
  preview: '../../input/preview.js',
  roster: '../../game/roster.js',
  progression: '../../game/progression.js',
  medals: '../../training/medals.js',
  camera: '../../input/camera.js',
  keyboard: '../../input/keyboard.js',
  calibration: '../../input/calibration.js',
});

/** @type {Map<string, Promise<any>>} */
const pending = new Map();
/** @type {Map<string, any>} */
const loaded = new Map();
const overrides = Object.create(null);

/**
 * Provide modules explicitly (tests, dev pages, or an app that already imported them).
 * @param {Record<string, any>} mods  e.g. { boxerModel: { BoxerModel }, preview: { drawPreview } }
 */
export function provideDeps(mods) {
  if (!mods || typeof mods !== 'object') return;
  for (const [name, mod] of Object.entries(mods)) {
    if (!mod) continue;
    overrides[name] = mod;
    loaded.set(name, mod);
    pending.set(name, Promise.resolve(mod));
  }
}

/**
 * Load a dependency by logical name. Resolves to the module namespace or null (never rejects).
 * @param {keyof typeof PATHS} name
 */
export function loadDep(name) {
  if (pending.has(name)) return pending.get(name);
  const path = PATHS[name];
  const loader = path ? FILES[path] : null;
  const p = loader
    ? Promise.resolve()
      .then(() => loader())
      .then((mod) => { loaded.set(name, mod); return mod; })
      .catch((e) => { console.warn(`[ui] optional module "${name}" failed to load — using fallback`, e); loaded.set(name, null); return null; })
    : Promise.resolve(null).then(() => { loaded.set(name, null); return null; });
  pending.set(name, p);
  return p;
}

/** Synchronous peek: the module if already loaded, else null (and starts loading it). */
export function peekDep(name) {
  if (loaded.has(name)) return loaded.get(name);
  loadDep(name);
  return null;
}

/** Start loading everything the UI can use (called once by UI). */
export function preloadDeps() {
  return Promise.all(Object.keys(PATHS).map((n) => loadDep(n)));
}

/** Names of known optional dependencies. */
export const DEP_NAMES = Object.freeze(Object.keys(PATHS));
