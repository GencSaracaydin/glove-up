// Guided calibration (drives input.calibrate(player) → CalibrationSession): the live preview + skeleton fills the
// page and each instruction POPS UP over it — one big prompt at a time with its own progress ring (2026-11-13: a
// player found the step checklist beside the picture hard to follow; the punch steps also start with the RIGHT
// hand now, the one just raised) — plus retry / skip.
//   params: { player?: 0|1, profile?: Profile, name?: string, session?: object, allowSkip?: boolean = true }
//   result: { action: 'done', calibration, save?: SaveResult } | { action: 'skip' } | { action: 'back' }
// The session's escalating advice (state.hint) shows under the prompt; state.stuck (a step that can't succeed)
// adds a way out ("Skip for now"). Mouse, touch and keyboard work throughout. The result is saved to the profile.
// The page carries data-step (the session's current step id, 'done' at the end) for tests.

import { h, button, icon, pageHeader, progressRing, clear } from './kit.js';
import { livePreview } from './live-preview.js';

const STEPS = [
  { id: 'frame', title: 'Step into the picture', hint: 'Head, shoulders and both hands in view', icon: 'move' },
  { id: 'guard', title: 'Gloves up!', hint: 'Hold both fists by your chin and keep still', icon: 'shield' },
  { id: 'right-hand', title: 'Raise your RIGHT hand', hint: 'Up high, like you’re asking a question', icon: 'glove' },
  { id: 'punch-right', title: 'Punch with your RIGHT', hint: 'Throw a straight punch at the screen', icon: 'bolt' },
  { id: 'punch-left', title: 'Now punch with your LEFT', hint: 'Same again with the other hand', icon: 'bolt' },
];

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'calibrate',
  title: 'Calibration',
  create(ctx, params) {
    const player = params.player === 1 ? 1 : 0;
    const profile = params.profile || null;
    const who = params.name || profile?.name || `Player ${player + 1}`;
    let session = null;
    let state = { step: 'frame', progress: 0, message: '', ok: false, done: false, result: null };
    let finished = false;
    let saveRes = null;

    const preview = livePreview(ctx, { players: player + 1, highlight: player, cls: 'gu-calib__preview' });
    const ring = progressRing({ size: 120, stroke: 11, cls: 'gu-calib__ring' });
    const ringIcon = h('span', { class: 'gu-calib__ringicon' });
    const stepNo = h('span', { class: 'gu-calib__stepno' });
    const stepTitle = h('h2', { class: 'gu-calib__title', 'aria-live': 'polite' });
    const stepMsg = h('p', { class: 'gu-calib__msg' });
    const tip = h('p', { class: 'gu-calib__tip', role: 'status', hidden: true });
    // the prompt that pops up over the camera picture (at its bottom: the head and a raised hand stay in view)
    const pop = h('div', { class: 'gu-calib__pop' },
      h('div', { class: 'gu-calib__ringwrap' }, ring, ringIcon),
      h('div', { class: 'gu-calib__text' }, stepNo, stepTitle, stepMsg, tip));
    preview.el.appendChild(pop);
    const footer = h('div', { class: 'gu-footer' });

    function start() {
      try { session?.cancel?.(); } catch { /* ignore */ }
      session = params.session && !session ? params.session : (ctx.input?.calibrate?.(player) || null);
      state = { step: 'frame', progress: 0, message: '', ok: false, done: false, result: null };
      finished = false;
      saveRes = null;
      renderFooter();
      render();
    }

    function stepIndex(id) {
      const i = STEPS.findIndex((s) => s.id === id);
      return id === 'done' ? STEPS.length : Math.max(0, i);
    }

    /** Restart a CSS animation class on an element (the pop-in for a new step, the bump for a new message). */
    function replay(node, cls) {
      node.classList.remove(cls);
      void node.offsetWidth;   // (reflow: the same class again restarts the animation)
      node.classList.add(cls);
    }

    function render() {
      const idx = stepIndex(state.step);
      const step = STEPS[Math.min(idx, STEPS.length - 1)];
      const finishedNow = !!state.done || state.step === 'done';
      let key, msg;
      if (finishedNow) {
        key = 'done';
        stepNo.textContent = 'Done';
        stepTitle.textContent = 'All set!';
        msg = `${who}’s punches, guard and dodges are tuned to your body.`;
        ring.set(1);
        if (ringIcon.dataset.icon !== 'check') { ringIcon.dataset.icon = 'check'; ringIcon.replaceChildren(icon('check')); }
      } else if (!session) {
        key = 'none';
        stepNo.textContent = '';
        stepTitle.textContent = 'Calibration isn’t available';
        msg = 'No camera input is running. You can skip this and play with default settings.';
        ring.set(0);
        if (ringIcon.dataset.icon !== 'camera') { ringIcon.dataset.icon = 'camera'; ringIcon.replaceChildren(icon('camera')); }
      } else {
        key = step.id;
        stepNo.textContent = `Step ${idx + 1} of ${STEPS.length}`;
        stepTitle.textContent = step.title;
        msg = state.message || step.hint;
        // (the ring shows this step's own progress: the hold, or the punches so far)
        ring.set(Number.isFinite(state.stepProgress) ? state.stepProgress : state.progress || 0);
        if (ringIcon.dataset.icon !== step.icon) { ringIcon.dataset.icon = step.icon; ringIcon.replaceChildren(icon(step.icon)); }
      }
      el.dataset.step = finishedNow ? 'done' : state.step;
      // a new step pops a new prompt up; a new message within the step gives it a little bump
      if (pop.dataset.key !== key) { pop.dataset.key = key; stepMsg.textContent = msg; replay(pop, 'is-pop'); }
      else if (stepMsg.textContent !== msg) { stepMsg.textContent = msg; replay(stepMsg, 'is-bump'); }
      // the session's concrete advice after a while in a step (INPUT-M2), and a way out when it is stuck
      const running = !!session && !state.done && state.step !== 'done';
      const tipText = running ? [typeof state.hint === 'string' ? state.hint : '', state.stuck && params.allowSkip !== false
        ? 'Or click “Skip for now” to play with standard settings.' : ''].filter(Boolean).join(' ') : '';
      if (tip.textContent !== tipText) tip.textContent = tipText;
      tip.hidden = !tipText;
      ring.classList.toggle('is-ok', !!state.ok || !!state.done);
      // (green once the step is actually being done — a hold running, a punch counted; a punch step reports ok throughout)
      pop.classList.toggle('is-ok', !!state.done || (!!state.ok && (state.stepProgress || 0) > 0));
    }

    function renderFooter() {
      clear(footer);
      footer.append(
        button({ label: 'Start again', icon: 'restart', kind: 'ghost', size: 'md', onClick: start }),
        h('span', { class: 'gu-footer__spacer' }));
      if (finished) {
        const go = button({ label: 'Continue', icon: 'check', kind: 'primary', size: 'lg', onClick: finish });
        go.dataset.autofocus = '';
        footer.appendChild(go);
      } else if (params.allowSkip !== false) {
        footer.appendChild(button({ label: 'Skip for now', sub: 'Use standard settings', kind: 'secondary', size: 'lg', onClick: skip }));
      }
    }

    function finish() {
      ctx.done({ action: 'done', calibration: state.result, save: saveRes });
    }
    function skip() {
      try { session?.cancel?.(); } catch { /* ignore */ }
      ctx.done({ action: 'skip' });
    }

    function onDone(result) {
      finished = true;
      if (result && profile?.id) saveRes = ctx.storage?.updateProfile?.(profile.id, { calibration: result }) || null;
      if (saveRes && !saveRes.saved && profile?.kind === 'local' && saveRes.error) ctx.toast(saveRes.error, { kind: 'warn' });
      try { if (result && typeof ctx.input?.setCalibration === 'function' && !session?.hub) ctx.input.setCalibration(player, result); } catch { /* hub-bound sessions apply it themselves */ }
      ctx.sfx('ui-ready');
      ctx.arm(500);
      renderFooter();
      render();
      ctx.refocus();
    }

    // While a calibration move is running nothing actionable holds focus (Enter can't leave by accident).
    const el = h('div', { class: 'gu-page gu-calib', tabindex: '-1' },
      pageHeader({ title: 'Quick calibration', sub: `${who} — about 20 seconds`, onBack: () => ctx.ui.back() }),
      h('div', { class: 'gu-calib__body' }, preview.el),
      footer);

    start();

    return {
      el,
      focus: () => (finished ? footer.querySelector('[data-autofocus]') : el),
      update(dt, now) {
        preview.draw();
        if (!session || finished) return;
        const frame = ctx.ui.latestFrame();
        const pose = frame?.players?.[player] ?? null;
        let st = null;
        try { st = session.update(pose, frame?.t ?? now); } catch (e) { console.error('[ui] calibration update failed', e); }
        if (st && typeof st === 'object') {
          // any new message, tip or stuck flag shows at once (event messages are short-lived: INPUT-M1)
          const changed = st.step !== state.step || Math.abs((st.progress || 0) - (state.progress || 0)) > 0.004 || st.message !== state.message
            || Math.abs((st.stepProgress || 0) - (state.stepProgress || 0)) > 0.004
            || st.ok !== state.ok || st.done !== state.done || (st.hint ?? null) !== (state.hint ?? null) || !!st.stuck !== !!state.stuck;
          state = { ...state, ...st };
          if (st.done) { onDone(st.result || session.result || null); return; }
          if (changed) render();
        }
      },
      back() {
        try { session?.cancel?.(); } catch { /* ignore */ }
        return false;
      },
      destroy() {
        if (!finished) { try { session?.cancel?.(); } catch { /* ignore */ } }
      },
    };
  },
};
