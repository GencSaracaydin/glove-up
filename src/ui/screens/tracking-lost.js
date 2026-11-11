// ERR02 — the game lost a player's hands, or the whole player: the activity is suspended (the app pauses it after
// the HUD has asked "Please keep your hands visible" for HUB_TUNING.lostMs). This screen names who must come back,
// shows the preview, and carries on BY ITSELF once that player is in the picture with both hands visible for
// UI_TUNING.lostResumeMs (0.5 s; user request 2026-11-10 — it used to wait for a 2 s guard hold), or at once on
// Resume. "We can't see your hands" when the player is in the picture without them, "We lost sight of you" else.
//   params: { player?: 0|1, name?: string, players?: 1|2, kind?: 'match'|'training' }
//   result: { action: 'resume', via: 'hands'|'button' } | { action: 'quit' }
// "Back" is the gesture recognizer's own rule (backCheck: head, both shoulders, both hands, not raised above the head),
// and the input hub must track every human player again (status.tracking), so a resumed activity never pauses
// again at once; with two players it waits for both.
// The camera itself stopped (unplugged, taken by another app: input phase 'error'): the screen says so
// and offers "Try again" (input.start() reopens it; the activity stays paused) — once frames come back the
// player's hands bring it back as above (FLOWS-02).

import { Ev, LM } from '../../core/types.js';
import { h, button, icon, progressRing, UI_TUNING, setButtonLabel } from './kit.js';
import { livePreview } from './live-preview.js';

/**
 * Is this player back the way the gesture recognizer needs them (src/input/gesture.js _observe/_updateTracking: head =
 * nose or both eyes, both shoulders, both wrists; visibility ≥ 0.5 inside the picture)? The card only carries on when
 * this holds, so it never claims "carrying on" while the hub still has the player lost. Both hands raised above the
 * head (the pause gesture) don't count: the hold would finish just after the card carried on and pause again.
 */
export function backCheck(pose) {
  const im = pose && Array.isArray(pose.image) ? pose.image : null;
  const ok = (i) => {
    const l = im && im[i];
    return !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && (l.visibility ?? l.presence ?? 1) >= 0.5
      && l.x > -0.03 && l.x < 1.03 && l.y > -0.03 && l.y < 1.03;
  };
  const headOk = ok(LM.NOSE) || (ok(LM.LEFT_EYE) && ok(LM.RIGHT_EYE));
  const shouldersOk = ok(LM.LEFT_SHOULDER) && ok(LM.RIGHT_SHOULDER);
  const handsOk = ok(LM.LEFT_WRIST) && ok(LM.RIGHT_WRIST);
  const inPicture = headOk || ok(LM.LEFT_SHOULDER) || ok(LM.RIGHT_SHOULDER);
  let handsUp = false;
  if (handsOk && shouldersOk) {
    const ls = im[LM.LEFT_SHOULDER], rs = im[LM.RIGHT_SHOULDER];
    const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    const headY = ok(LM.NOSE) ? im[LM.NOSE].y : (ls.y + rs.y) / 2 - 0.9 * sw;
    const up = (w) => im[w].y < headY - 0.5 * sw;
    handsUp = up(LM.LEFT_WRIST) && up(LM.RIGHT_WRIST);
  }
  return { inPicture, headOk, shouldersOk, handsOk, handsUp, back: headOk && shouldersOk && handsOk && !handsUp };
}

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'tracking-lost',
  title: 'Tracking lost',
  layer: 'overlay',
  noBack: true,
  armDelayMs: 600,
  create(ctx, params) {
    const player = params.player === 1 ? 1 : 0;
    const players = params.players === 2 || player === 1 ? 2 : 1;
    const tag = `P${player + 1}`;
    const who = params.name ? `${params.name}` : players === 2 ? tag : 'you';
    const paused = params.kind === 'training' ? 'The drill is paused.' : 'The fight is paused.';
    const thing = params.kind === 'training' ? 'drill' : 'fight';
    let visibleSince = null;
    let handsSince = null;
    let hubTracked = null;
    let done = false;
    let retrying = false;
    let retryError = null;   // a failed "Try again" (shown until the next attempt)
    let shownError = '';

    const preview = livePreview(ctx, { players, highlight: player, cls: 'gu-lost__preview', halves: players === 2 });
    if (players === 2) {
      preview.overlay.append(
        h('span', { class: `gu-preview__half gu-preview__half--l${player === 0 ? ' is-target' : ''}`, text: 'P1' }),
        h('span', { class: `gu-preview__half gu-preview__half--r${player === 1 ? ' is-target' : ''}`, text: 'P2' }));
    }
    const ring = progressRing({ size: 120, stroke: 12, cls: 'gu-lost__ring' });
    const status = h('p', { class: 'gu-lost__status', role: 'status' });
    const resume = button({ label: 'Resume', icon: 'play', kind: 'primary', size: 'lg', disabled: true, onClick: () => finish('button') });
    const quit = button({ label: 'Quit to menu', icon: 'exit', kind: 'ghost', size: 'md', sfx: 'ui-back', onClick: () => ctx.done({ action: 'quit' }) });
    const retry = button({ label: 'Try again', icon: 'restart', kind: 'primary', size: 'lg', cls: 'gu-lost__retry', onClick: () => tryAgain() });
    retry.hidden = true;

    const offFound = ctx.bus?.on?.(Ev.INPUT_TRACKING_FOUND, (p) => { if ((p?.player ?? 0) === player) hubTracked = true; });
    const offLost = ctx.bus?.on?.(Ev.INPUT_TRACKING_LOST, (p) => { if ((p?.player ?? 0) === player) hubTracked = false; });

    function finish(via) {
      if (done) return;
      done = true;
      ctx.done({ action: 'resume', via });
    }

    async function tryAgain() {
      if (retrying || typeof ctx.input?.start !== 'function') return;
      retrying = true;
      retryError = null;
      try {
        const r = await ctx.input.start();
        if (r && r.ok === false && r.code !== 'cancelled') {
          const st = ctx.input.status || {};
          retryError = { title: r.title || st.errorTitle || '', message: r.error || st.error || 'The camera could not start.', help: r.help || st.errorHelp || '' };
        }
      } catch (e) {
        retryError = { title: '', message: String(e?.message || e), help: '' };
      } finally {
        retrying = false;
      }
    }

    // the player is gone ('lost') or in the picture without both hands ('hands')
    const COPY = {
      lost: {
        title: players === 2 ? `We lost sight of ${tag}${params.name ? ` — ${params.name}` : ''}` : 'We lost sight of you',
        text: `${paused} ${players === 2 ? `${tag} needs to step back into the ${player === 0 ? 'left' : 'right'} half of the picture, both hands in view.` : 'Step back into the picture, about 1–2 m from the camera, with both hands in view.'}`,
      },
      hands: {
        title: players === 2 ? `We can’t see ${tag}’s hands` : 'We can’t see your hands',
        text: `${paused} Keep both hands in the picture — the ${thing} carries on as soon as we see them again.`,
      },
    };
    let copy = 'lost';
    const title = h('h1', { class: 'gu-modal__title', text: COPY.lost.title });
    const text = h('p', { class: 'gu-modal__text', text: COPY.lost.text });
    const setCopy = (k) => {
      if (k === copy) return;
      copy = k;
      title.textContent = COPY[k].title;
      text.textContent = COPY[k].text;
    };
    const hold = h('div', { class: 'gu-lost__hold' }, h('div', { class: 'gu-lost__ringwrap' }, ring, h('span', { class: 'gu-lost__ringicon' }, icon('glove'))),
      h('p', { class: 'gu-lost__holdtext' }, h('b', { text: 'Show both hands' }), h('span', { text: ` and the ${thing} carries on by itself — or press Resume.` })));
    const camHelp = h('div', { class: 'gu-lost__camerr', hidden: true, role: 'alert' });
    // Nothing actionable is focused until Resume (or Try again) is possible (an Enter press must never quit by accident).
    const el = h('div', { class: 'gu-modal gu-lost', tabindex: '-1' },
      h('div', { class: 'gu-modal__card gu-modal__card--wide' },
        h('div', { class: 'gu-lost__head' },
          h('div', { class: `gu-modal__icon gu-modal__icon--warn` }, icon('eyeoff')),
          h('div', null, title, text)),
        h('div', { class: 'gu-lost__body' },
          preview.el,
          h('div', { class: 'gu-lost__side' }, hold, camHelp, status)),
        h('div', { class: 'gu-row gu-row--end' }, quit, retry, resume)));

    /** The camera (or the pose tracker) stopped: say so, offer Try again; null = back to normal. */
    function renderCameraError(err) {
      const key = err ? `${err.title}|${err.message}|${err.help}|${retrying}` : '';
      if (key === shownError) return;
      const wasShown = !!shownError;
      shownError = key;
      el.classList.toggle('is-camera-error', !!err);
      hold.hidden = !!err;
      camHelp.hidden = !err;
      retry.hidden = !err;
      if (!err) {
        title.textContent = COPY[copy].title;
        text.textContent = COPY[copy].text;
        camHelp.replaceChildren();
        return;
      }
      title.textContent = err.title || 'The camera stopped';
      text.textContent = `${paused} ${err.message || 'The camera stopped sending pictures.'}`;
      camHelp.replaceChildren(
        h('p', { class: 'gu-lost__camhelp', text: err.help || 'Check the camera is plugged in and not used by another app, then choose Try again.' }));
      retry.disabled = retrying;
      setButtonLabel(retry, retrying ? 'Starting…' : 'Try again');
      if (!wasShown && !retrying) retry.focus({ preventScroll: true });
    }

    return {
      el,
      focus: () => (!retry.hidden && !retry.disabled ? retry : resume.disabled ? el : resume),
      update(dt, now) {
        preview.draw();
        if (done) return;
        const st = ctx.input?.status;
        const phase = st?.phase;
        // the camera stopped (FLOWS-02): explain, offer Try again; a failed retry keeps its own message
        const camErr = retrying ? { title: 'Starting the camera…', message: 'Hold on a moment.', help: ' ' }
          : phase === 'error' ? { title: st.errorTitle || '', message: st.error || '', help: st.errorHelp || '' }
            : retryError && phase !== 'running' ? retryError : null;
        renderCameraError(camErr);
        // a frozen / unplugged / restarting camera keeps its last frame: a stale pose is nobody (Infinity: no frame yet)
        const age = st?.frameAgeMs;
        const stale = typeof age === 'number' && (!Number.isFinite(age) || age > 600);
        const frame = ctx.ui.latestFrame();
        const pose = stale || camErr ? null : frame?.players?.[player] ?? null;
        const b = backCheck(pose);
        // (once back, the title stays as it was for the last 0.5 s — "Great — carrying on…" below says the rest)
        if (!camErr && !b.back) setCopy(b.inPicture && !b.handsOk ? 'hands' : 'lost');
        // the hub tracks the player again: resuming then can't pause again at once (with two players: both)
        const tracked = Array.isArray(st?.tracking) && st.tracking.length > player ? !!st.tracking[player] : hubTracked;
        const others = Array.isArray(st?.tracking) ? st.tracking.slice(0, players).map((t, i) => (i !== player && !t ? i : -1)).filter((i) => i >= 0) : [];
        const visible = (tracked ?? b.inPicture) && b.inPicture;
        if (visible) visibleSince = visibleSince ?? now;
        else visibleSince = null;
        const canResume = visible && now - visibleSince > 250;
        const wasDisabled = resume.disabled;
        resume.disabled = !canResume;
        if (wasDisabled && canResume) resume.focus({ preventScroll: true });
        // back the way the recognizer needs: carry on after lostResumeMs (the ring fills meanwhile)
        if (b.back) handsSince = handsSince ?? now;
        else handsSince = null;
        const held = handsSince === null ? 0 : now - handsSince;
        ring.set(held / UI_TUNING.lostResumeMs);
        ring.classList.toggle('is-ok', b.back);
        const ready = b.back && tracked !== false && !others.length;
        const msg = camErr ? (retrying ? 'Starting the camera…' : 'The camera isn’t sending pictures')
          : !b.inPicture ? (players === 2 ? `${who} isn’t in the picture yet` : 'We can’t see you yet')
            : !b.handsOk ? 'Now show both hands'
              : b.handsUp ? 'Bring your hands down to your guard'
                : !b.headOk ? 'Your head is out of the picture — step back a little'
                  : !b.shouldersOk ? 'Face the camera so we can see both shoulders'
                    : others.length ? `Waiting for P${others[0] + 1} to step back in`
                      : tracked === false ? 'Almost there…'
                        : 'Great — carrying on…';
        if (status.textContent !== msg) status.textContent = msg;
        status.dataset.state = b.back ? 'ok' : 'wait';
        if (held >= UI_TUNING.lostResumeMs && ready) { ctx.sfx('ui-confirm'); finish('hands'); }
      },
      destroy() { offFound?.(); offLost?.(); },
    };
  },
};
