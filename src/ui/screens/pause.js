// SES01 — pause menu over the paused fight or drill.
//   params: { kind?: 'match'|'training', canRestart?: boolean = true, title?: string, canSkipTutorial?: boolean,
//             reason?: 'user'|'hidden'|'tracking'|'graphics', graphicsLost?: () => boolean }
//   result: { action: 'continue' | 'restart' | 'quit' | 'skip-tutorial' }
//   canSkipTutorial (first-bout tutorial running, ARCHITECTURE §6.9) adds "Skip tutorial" — the way to skip
//   it from the pause card; the app ends the tutorial ("Fight!") and resumes.
// SES02: Continue restores the same participants and state (the app resumes the paused
// Match/activity); Start over clears the transient state; Quit leaves without saving a result.
// Esc / Backspace / P = Continue.
// D10 / RV-FLOWS-04: while graphicsLost() is true (the WebGL context is gone, the arena behind the card is
// blank) the card says so and Continue is unavailable: aria-disabled (it keeps the keyboard focus, so Enter
// can't fall through to Start over), and Esc, P and the hands-up gesture do nothing but a
// "no" sound (once per press: a key reaches back() both from the UI and as an input event). Once the picture
// is back, Continue is enabled — and focused, unless the player had moved the focus to another button of the
// card meanwhile. Start over, Skip tutorial (the app keeps the bout paused) and Quit keep working.

import { h, button, icon } from './kit.js';

/** The card's words while the picture is gone / once it is back (our own wording). */
export const PAUSE_TEXT = Object.freeze({
  hint: 'Hands up above your head again, or press P / Esc, to continue',
  lost: 'The picture dropped out — the game waits here until it comes back.',
  lostHint: 'Continue comes back as soon as the picture does',
  back: 'The picture is back.',
});

/** One Esc / P press reaches back() twice (the UI's key handler, then the app's 'pause' input event, ≈ 10–20 ms
 *  apart): the "no" sound plays once per this long. */
const DENY_REPEAT_MS = 250;

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'pause',
  title: 'Paused',
  layer: 'overlay',
  armDelayMs: 400,
  create(ctx, params) {
    const training = params.kind === 'training';
    const lostFn = typeof params.graphicsLost === 'function' ? params.graphicsLost : null;
    const isLost = () => { try { return !!lostFn?.(); } catch { return false; } };
    const cont = button({
      label: 'Continue', sub: 'Pick up exactly where you left off', icon: 'play', kind: 'primary', size: 'lg',
      onClick: () => { if (!isLost()) ctx.done({ action: 'continue' }); },
    });
    cont.dataset.autofocus = '';
    const restart = params.canRestart === false ? null : button({
      label: 'Start over', sub: training ? 'Restart this drill from the beginning' : 'Restart this bout from round 1',
      icon: 'restart', kind: 'secondary', size: 'lg', onClick: () => ctx.done({ action: 'restart' }),
    });
    const skipTut = params.canSkipTutorial ? button({
      label: 'Skip tutorial', sub: 'Go straight to the fight', icon: 'next', kind: 'secondary', size: 'lg',
      onClick: () => ctx.done({ action: 'skip-tutorial' }),
    }) : null;
    const quit = button({
      label: 'Quit', sub: training ? 'Back to the menu — this attempt won’t count' : 'Back to the menu — this bout won’t count',
      icon: 'exit', kind: 'secondary', size: 'lg', sfx: 'ui-back', onClick: () => ctx.done({ action: 'quit' }),
    });
    // why the bout stopped, when the game stopped it for the picture (D10)
    const why = h('p', { class: 'gu-pause__why', role: 'status', hidden: true });
    const hint = h('p', { class: 'gu-modal__hint', text: PAUSE_TEXT.hint });
    const el = h('div', { class: 'gu-modal gu-pause' },
      h('div', { class: 'gu-modal__card' },
        h('div', { class: 'gu-modal__icon' }, icon('pause')),
        h('h1', { class: 'gu-modal__title', text: params.title || 'Paused' }),
        why,
        h('div', { class: 'gu-stack' }, cont, skipTut, restart, quit),
        hint));

    let lost = null; // the state last shown (null = not yet)
    const show = (now) => {
      if (now === lost) return;
      const wasLost = lost === true;
      lost = now;
      if (now) cont.setAttribute('aria-disabled', 'true');
      else cont.removeAttribute('aria-disabled');
      el.classList.toggle('is-picture-lost', now);
      const line = now ? PAUSE_TEXT.lost : (wasLost || params.reason === 'graphics') ? PAUSE_TEXT.back : '';
      why.textContent = line;
      why.hidden = !line;
      hint.textContent = now ? PAUSE_TEXT.lostHint : PAUSE_TEXT.hint;
      // the picture is back: Continue is ready — focused, unless the player moved on to Start over / Quit
      if (wasLost && !now) {
        const doc = typeof document !== 'undefined' ? document : null;
        const at = doc ? doc.activeElement : null;
        if (!at || at === doc.body || at === cont || !el.contains(at)) cont.focus?.({ preventScroll: true });
      }
    };
    show(isLost());
    let deniedAt = -Infinity;
    return {
      el,
      focus: () => cont,
      update() { show(isLost()); },
      back() {
        // Esc / P / the hands-up gesture = Continue — not while the picture is gone (it would only pause again)
        if (isLost()) {
          show(true);
          const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (t - deniedAt > DENY_REPEAT_MS) { deniedAt = t; ctx.sfx('ui-deny'); }
          return true;
        }
        ctx.done({ action: 'continue' });
        return true;
      },
    };
  },
};
