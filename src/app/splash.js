// The loading screen (#splash in index.html). It is painted before any script runs and keeps moving (its
// animations are transform-only, so they run off the main thread) while the page builds the game and draws its
// first frame — about 0.4 s of busy main thread on a fast Mac, longer on a slow one — then fades into the title.
// The title's intro waits for it: html.is-loading pauses the title's animations (styles.css), so its letters
// pop in as the loading screen fades instead of half-way through behind it.
//
// The app calls frameDrawn() after every frame it draws. The loading screen goes once a screen is up and
// `framesBeforeHide` frames have been drawn (the first one compiles the arena's shaders, the next is a plain one)
// and the faces the title draws first are in; a slow font never holds it longer than `fontWaitMs`. A fatal
// start-up error (main.js) and `safetyMs` remove it too; if the game's code never runs at all, index.html's own
// inline script turns it into a "couldn't load" message with a Reload button.
// No DOM access at import time.

export const SPLASH = Object.freeze({
  framesBeforeHide: 2,
  fontWaitMs: 1200,
  /** The fade (index.html #splash transition); the element is removed after it. */
  fadeMs: 400,
  safetyMs: 15000,
  /** The faces the title and the loading screen draw first (fonts.css declares them; index.html preloads them). */
  fonts: Object.freeze(['1em "Lilita One"', '700 1em "Nunito"', '800 1em "Nunito"']),
});

/** Fade the loading screen out and let the title's intro play. Idempotent; false if there was nothing to hide. */
export function hideSplash(doc = globalThis.document) {
  if (!doc) return false;
  doc.documentElement?.classList?.remove('is-loading');
  const el = doc.getElementById?.('splash');
  if (!el || el.classList.contains('is-done')) return false;
  el.classList.add('is-done');
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.remove?.();
  };
  // its own fade only (transitionend bubbles up from the name's fade-in)
  el.addEventListener?.('transitionend', (e) => { if (!e || e.target === el) remove(); });
  setTimeout(remove, SPLASH.fadeMs + 250);
  return true;
}

export class Splash {
  /** @param {{doc?: Document, now?: () => number}} [o] */
  constructor({ doc = globalThis.document, now = () => performance.now() } = {}) {
    this.doc = doc || null;
    this.now = now;
    this.frames = 0;
    this.firstAt = null;
    this.fontsReady = false;
    this.done = !this.doc || !this.doc.getElementById?.('splash');
    if (this.done) { this.doc?.documentElement?.classList?.remove('is-loading'); return; }
    const fonts = this.doc.fonts;
    if (fonts && typeof fonts.load === 'function') {
      Promise.all(SPLASH.fonts.map((f) => fonts.load(f).catch(() => null)))
        .then(() => { this.fontsReady = true; }, () => { this.fontsReady = true; });
    } else {
      this.fontsReady = true;
    }
  }

  /**
   * After each drawn frame.
   * @param {boolean} screenUp  a menu screen (the title on start-up) is displayed
   * @returns {boolean} true on the frame that started the fade
   */
  frameDrawn(screenUp) {
    if (this.done || !screenUp) return false;
    const t = this.now();
    this.frames++;
    if (this.firstAt === null) this.firstAt = t;
    if (this.frames < SPLASH.framesBeforeHide) return false;
    if (!this.fontsReady && t - this.firstAt < SPLASH.fontWaitMs) return false;
    this.done = true;
    hideSplash(this.doc);
    return true;
  }
}
