// ERR01 — camera setup gate: pick a camera, get permission help, see the mirrored live preview
// with skeletons, and per-player chips ("P1 ready", "P2 not visible — step into the right half").
// Continue stays disabled until every required player has been fully in view (head, shoulders, both
// hands) for UI_TUNING.readyHoldMs (2 s) in a row. From then on that player STAYS ready on this screen,
// even out of the picture: the player has to step to the computer to click Continue, and their hands
// leave the camera on the way (user request 2026-11-08). Only a camera change, a newly shown camera /
// tracker error or a stale feed (no fresh frames) clears it.
//   params: { players?: 1|2, required?: number[], allowKeyboard?: boolean = true, error?: string,
//             calibrated?: boolean  (every boxer already has a calibration → also offer "Recalibrate") }
//   result: { action: 'continue', deviceId: string|null, recalibrate?: true } | { action: 'keyboard' } | { action: 'retry' } | { action: 'back' }
// Camera changes are saved to settings, applied with input.setCamera() and announced with
// Ev.SETTINGS_CHANGED. "Try again" calls input.start() (or resolves 'retry' without a hub).

import { Ev } from '../../core/types.js';
import { h, button, icon, cycler, pageHeader, playerVisibility, UI_TUNING, clear } from './kit.js';
import { livePreview } from './live-preview.js';

const ERROR_TITLES = {
  denied: 'Camera blocked',
  'not-found': 'No camera found',
  busy: 'Camera is busy',
  insecure: 'Camera needs a secure page',
  unsupported: 'This browser can’t use a camera',
  overconstrained: 'That camera can’t start',
  'no-frames': 'The camera isn’t sending pictures',
  // the pose tracker failed — the camera itself works (INPUT-11)
  'model-missing': 'Pose model missing',
  'wasm-missing': 'Pose-tracking files missing',
  'init-failed': 'Pose tracking couldn’t start',
};
/** Title for an error: the input layer's own player-facing title, else by code, else by what failed. */
const errorTitle = (err) => err.title || ERROR_TITLES[err.code] || (err.source === 'tracker' ? 'Pose tracking couldn’t start' : 'Camera problem');

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'camera-setup',
  title: 'Camera setup',
  create(ctx, params) {
    const players = params.players === 2 ? 2 : 1;
    const required = Array.isArray(params.required) ? params.required.filter((i) => i === 0 || i === 1) : players === 2 ? [0, 1] : [0];
    const preview = livePreview(ctx, { players, halves: players === 2, cls: 'gu-camsetup__preview' });
    const readySince = [null, null];
    // per player: has been fully in view for readyHoldMs → ready until the camera changes or fails
    const locked = [false, false];
    const unlock = () => { readySince[0] = readySince[1] = null; locked[0] = locked[1] = false; };
    // A long gap between two updates means the page was hidden, suspended or stalled (tab / app / desktop
    // switch): no frames were taken meanwhile. That is no camera failure, so for a moment after it a stale
    // reading (the first frame back can carry the old frame age) keeps the locks; and nobody was watched
    // during it, so a running 2 s hold starts over.
    const GAP_MS = 500, GAP_GRACE_MS = 1000;
    let lastUpdate = null;
    let staleGraceUntil = -Infinity;
    const openedAt = performance.now();
    let busError = params.error ? { message: params.error, help: '', code: 'unknown' } : null;
    let retrying = false;
    let focusedContinue = false;

    // overlay guides on the preview
    if (players === 2) {
      preview.overlay.append(
        h('span', { class: 'gu-preview__half gu-preview__half--l', text: 'P1 stands here' }),
        h('span', { class: 'gu-preview__half gu-preview__half--r', text: 'P2 stands here' }));
    }
    const waiting = h('div', { class: 'gu-preview__waiting', hidden: true }, h('span', { class: 'gu-spinner' }), h('span', { text: 'Waiting for the camera… if your browser asks, click Allow.' }));
    preview.overlay.appendChild(waiting);

    const chips = [];
    for (let i = 0; i < players; i++) {
      const text = h('span', { class: 'gu-pchip__text' });
      const el = h('div', { class: `gu-pchip gu-pchip--p${i + 1}`, role: 'status' }, h('span', { class: 'gu-pchip__tag', text: `P${i + 1}` }), h('span', { class: 'gu-pchip__icon' }), text);
      chips.push({ el, text, state: '' });
    }

    const continueBtn = button({ label: 'Continue', icon: 'check', kind: 'primary', size: 'lg', disabled: true, onClick: () => ctx.done({ action: 'continue', deviceId: currentDevice() }) });
    // Already-calibrated boxers can ask for a fresh calibration here (the app runs it next).
    const recalBtn = params.calibrated ? button({
      label: 'Recalibrate', icon: 'restart', kind: 'secondary', size: 'md', disabled: true,
      onClick: () => ctx.done({ action: 'continue', deviceId: currentDevice(), recalibrate: true }),
    }) : null;
    const keyboardBtn = params.allowKeyboard === false ? null
      : button({ label: 'Use keyboard instead', icon: 'keyboard', kind: 'ghost', size: 'md', onClick: () => ctx.done({ action: 'keyboard' }) });

    // camera picker
    const pickerHost = h('div', { class: 'gu-camsetup__picker' });
    let cameras = [];
    function currentDevice() {
      return ctx.settings()?.cameraDeviceId || ctx.input?.status?.camera?.deviceId || cameras[0]?.deviceId || null;
    }
    async function loadCameras() {
      const mod = await ctx.deps.load('camera');
      try { cameras = (await mod?.listCameras?.()) || []; } catch { cameras = []; }
      renderPicker();
    }
    function renderPicker() {
      clear(pickerHost);
      if (cameras.length > 1) {
        const cur = currentDevice();
        pickerHost.appendChild(cycler({
          label: 'Camera', values: cameras.map((c) => c.deviceId), value: cameras.some((c) => c.deviceId === cur) ? cur : cameras[0].deviceId,
          format: (id) => cameras.find((c) => c.deviceId === id)?.label || 'Camera',
          onChange: (id) => chooseCamera(id),
        }));
      } else {
        const label = ctx.input?.status?.camera?.label || cameras[0]?.label || null;
        if (label) pickerHost.appendChild(h('p', { class: 'gu-camsetup__cam' }, icon('camera'), h('span', { text: label })));
      }
    }
    async function chooseCamera(deviceId) {
      const res = ctx.storage?.saveSettings?.({ cameraDeviceId: deviceId });
      ctx.ui.applySettings(res?.settings || { cameraDeviceId: deviceId }, { changed: ['cameraDeviceId'] });
      unlock(); // another camera: the players have to be seen by it first
      try { await ctx.input?.setCamera?.(deviceId); } catch (e) { console.warn('[ui] setCamera failed', e); }
    }

    // error / permission help
    const errorHost = h('div', { class: 'gu-camsetup__error', hidden: true });
    let shownError = ''; // null = render on the next update whatever it shows (after Try again)
    function renderError(err) {
      const key = err ? `${err.code}|${err.message}` : '';
      if (key === shownError) return;
      shownError = key;
      clear(errorHost);
      errorHost.hidden = !err;
      tips.hidden = false;
      if (!err) return;
      unlock(); // a camera / tracker problem: whoever was ready has to be seen again once it works
      const help = err.help || (err.code === 'denied' ? 'Click the camera icon in the address bar, choose Allow, then press Try again.' : 'Check the camera is plugged in and not used by another app, then press Try again.');
      errorHost.append(
        h('h2', { class: 'gu-panel__title' }, icon('camera'), errorTitle(err)),
        h('p', { class: 'gu-panel__text', text: err.message || 'The camera could not start.' }),
        h('p', { class: 'gu-panel__text gu-panel__text--help', text: help }),
        h('div', { class: 'gu-row' },
          button({ label: retrying ? 'Starting…' : 'Try again', icon: 'restart', kind: 'primary', size: 'md', disabled: retrying, onClick: retry })));
      tips.hidden = true;
    }
    async function retry() {
      if (typeof ctx.input?.start !== 'function') { ctx.done({ action: 'retry' }); return; }
      retrying = true;
      busError = null;
      shownError = null;
      ctx.ui.loading('Starting the camera…');
      try {
        const r = await ctx.input.start();
        if (r && r.ok === false && r.error && r.code !== 'cancelled') {
          const st = ctx.input.status || {};
          busError = { message: r.error, help: r.help || st.errorHelp || '', code: r.code || st.errorCode || 'unknown', title: r.title || st.errorTitle || '', source: r.source || st.errorSource || '' };
        }
      } catch (e) {
        busError = { message: String(e?.message || e), help: '', code: 'unknown' };
      } finally {
        retrying = false;
        ctx.ui.loading(null);
        shownError = null; // the next update clears the old panel (camera works) or shows the new error
        loadCameras();
      }
    }
    const offErr = ctx.bus?.on?.(Ev.INPUT_ERROR, (p) => { busError = { message: p?.message || 'Camera error', help: p?.help || '', code: p?.code || 'unknown', title: p?.title || '', source: p?.source || '' }; });

    const tips = h('ul', { class: 'gu-tips' },
      h('li', null, icon('move'), h('span', { text: 'Stand about 1–2 m back from the camera' })),
      h('li', null, icon('user'), h('span', { text: 'Head, shoulders and both hands in the picture' })),
      h('li', null, icon('sparkle'), h('span', { text: 'Light in front of you, not behind' })),
      h('li', null, icon('shield'), h('span', { text: 'Gloves up for 2 seconds — then Continue stays on while you click it' })),
      players === 2 ? h('li', null, icon('gloves'), h('span', { text: 'Side by side: P1 on the left, P2 on the right' })) : null);

    // Until everyone is visible the page itself holds focus, so Enter can't switch to keyboard mode by accident.
    const el = h('div', { class: 'gu-page gu-camsetup', tabindex: '-1' },
      pageHeader({ title: 'Camera check', sub: players === 2 ? 'Both boxers step into view' : 'Step into view so we can see your gloves', onBack: () => ctx.ui.back() }),
      h('div', { class: 'gu-camsetup__body' },
        preview.el,
        h('div', { class: 'gu-panel gu-camsetup__side' },
          h('div', { class: 'gu-camsetup__chips' }, chips.map((c) => c.el)),
          errorHost,
          pickerHost,
          tips)),
      h('div', { class: 'gu-footer' }, keyboardBtn, h('span', { class: 'gu-footer__spacer' }), recalBtn, continueBtn));

    loadCameras();

    function setChip(c, state, text) {
      if (c.state !== state) {
        c.state = state;
        c.el.dataset.state = state;
        c.el.querySelector('.gu-pchip__icon').replaceChildren(icon(state === 'ready' ? 'check' : state === 'partial' ? 'help' : 'eyeoff'));
      }
      if (c.text.textContent !== text) c.text.textContent = text;
    }

    return {
      el,
      focus: () => (continueBtn.disabled ? el : continueBtn),
      update(dt, now) {
        if (lastUpdate !== null && now - lastUpdate > GAP_MS) {
          readySince[0] = readySince[1] = null;
          staleGraceUntil = now + GAP_GRACE_MS;
        }
        lastUpdate = now;
        preview.draw();
        const frame = ctx.ui.latestFrame();
        const status = ctx.input?.status || null;
        const err = status?.error ? { message: status.error, help: status.errorHelp || '', code: status.errorCode || 'unknown', title: status.errorTitle || '', source: status.errorSource || '' } : busError;
        renderError(err);
        const stale = !frame || (status && Number.isFinite(status.frameAgeMs) && status.frameAgeMs > 1500) || (status && status.frameAgeMs === Infinity);
        waiting.hidden = !(stale && !err && performance.now() - openedAt > 900);
        // a feed that stopped is a camera problem, not a player stepping away: nobody stays ready on it
        if (stale && now >= staleGraceUntil) unlock();
        let allReady = true;
        for (let i = 0; i < players; i++) {
          const pose = stale ? null : frame?.players?.[i] || null;
          const v = playerVisibility(pose);
          if (v.ready) readySince[i] = readySince[i] ?? now;
          else readySince[i] = null;
          if (!locked[i] && readySince[i] !== null && now - readySince[i] >= UI_TUNING.readyHoldMs) locked[i] = true;
          // once ready, a player stays ready here even out of the picture (reaching for the touchpad / mouse)
          const ready = locked[i];
          let text;
          let state;
          if (ready) { state = 'ready'; text = `P${i + 1} ready`; }
          else if (!v.visible) {
            state = 'missing';
            text = players === 2 ? `P${i + 1} not visible — step into the ${i === 0 ? 'left' : 'right'} half` : 'Not visible — step into the picture';
          } else if (v.ready) { state = 'partial'; text = 'Looking good — hold it…'; }
          else { state = 'partial'; text = v.hint; }
          setChip(chips[i], state, text);
          if (required.includes(i) && !ready) allReady = false;
        }
        const was = continueBtn.disabled;
        continueBtn.disabled = !allReady;
        if (recalBtn) recalBtn.disabled = !allReady;
        const label = continueBtn.querySelector('.gu-btn__label');
        const want = allReady ? 'Continue' : players === 2 ? 'Waiting for both boxers…' : 'Waiting for you…';
        if (label.textContent !== want) label.textContent = want;
        if (was && allReady) {
          ctx.sfx('ui-ready');
          // first time everyone is ready: put focus on Continue (Enter/Space goes straight on)
          if (!focusedContinue) { focusedContinue = true; continueBtn.focus({ preventScroll: true }); }
        }
      },
      destroy() { offErr?.(); },
    };
  },
};
