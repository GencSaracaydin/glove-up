// Settings: camera, tracking model (auto/lite/full), punch sensitivity, mirror, input mode, webcam
// PiP with skeleton, keyboard assist, reduced motion and volumes. Every change is saved right away
// (ERR04: a failed save is shown, the change still applies for this session), applied to the UI,
// applied to the input hub / audio engine when they offer a method for it, and announced with
// Ev.SETTINGS_CHANGED {settings, changed, source:'ui'}.
//   params: {}
//   result: { action: 'back' }

import { h, button, icon, cycler, segmented, slider, toggle, tabs, pageHeader, clear } from './kit.js';

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'settings',
  title: 'Settings',
  create(ctx) {
    let s = ctx.settings();
    // the control mode actually in use (e.g. "Use keyboard instead" on the camera check is not saved): FLOWS-12
    const live = ctx.input?.mode;
    const controls = live === 'camera' || live === 'keyboard' ? live : s.inputMode;
    const savedNote = h('p', { class: 'gu-settings__saved', role: 'status' });
    let cameras = [];
    let noteTimer = 0;

    function note(text, kind) {
      savedNote.textContent = text;
      savedNote.dataset.kind = kind;
      clearTimeout(noteTimer);
      if (kind === 'ok') noteTimer = setTimeout(() => { savedNote.textContent = ''; }, 1600);
    }

    async function applyInput(key, value) {
      const inp = ctx.input;
      if (!inp) return;
      try {
        if (key === 'model') await inp.setModel?.(value);
        else if (key === 'cameraDeviceId') await inp.setCamera?.(value);
        else if (key === 'inputMode') await inp.setMode?.(value);
        else if (key === 'keyboardAssist') inp.setKeyboardAssist?.(value);
      } catch (e) {
        console.warn(`[ui] applying ${key} failed`, e);
        ctx.toast('That setting will apply next time the camera starts.', { kind: 'warn' });
      }
    }

    function change(key, value, { save = true } = {}) {
      const patch = key === 'volumes' ? { volumes: value } : { [key]: value };
      let res = null;
      if (save) res = ctx.storage?.saveSettings?.(patch) || null;
      const next = res?.settings || { ...s, ...patch, volumes: { ...s.volumes, ...(patch.volumes || {}) } };
      s = next;
      ctx.ui.applySettings(next, { changed: [key], silent: !save });
      if (save) {
        if (res && res.saved) note('Saved', 'ok');
        else note(res?.error ? `Not saved: ${res.error}` : 'Not saved — this browser isn’t storing settings. It still applies until you close the game.', 'warn');
        applyInput(key, next[key]);
      }
    }

    function row(label, desc, control) {
      return h('div', { class: 'gu-setting' },
        h('div', { class: 'gu-setting__text' }, h('span', { class: 'gu-setting__label', text: label }), desc ? h('span', { class: 'gu-setting__desc', text: desc }) : null),
        h('div', { class: 'gu-setting__control' }, control));
    }

    function cameraControl() {
      const host = h('div', { class: 'gu-setting__cam' });
      const render = () => {
        clear(host);
        if (cameras.length > 1) {
          const cur = s.cameraDeviceId && cameras.some((c) => c.deviceId === s.cameraDeviceId) ? s.cameraDeviceId : cameras[0].deviceId;
          host.appendChild(cycler({ label: '', values: cameras.map((c) => c.deviceId), value: cur, format: (id) => cameras.find((c) => c.deviceId === id)?.label || 'Camera', onChange: (id) => change('cameraDeviceId', id) }));
        } else {
          host.appendChild(h('span', { class: 'gu-setting__static' }, icon('camera'), cameras[0]?.label || ctx.input?.status?.camera?.label || 'Default camera'));
        }
      };
      render();
      ctx.deps.load('camera').then(async (mod) => {
        try { cameras = (await mod?.listCameras?.()) || []; } catch { cameras = []; }
        if (host.isConnected) render();
      });
      return host;
    }

    const vol = (key, label, desc) => row(label, desc, slider({
      label, value: s.volumes?.[key] ?? 0.8, min: 0, max: 1, step: 0.1,
      // only this slider's key: storage merges volume sub-keys, so another tab's slider is never overwritten (FLOWS-04)
      onChange: (v, final) => change('volumes', { [key]: v }, { save: final }),
    }));

    const panel = tabs({
      value: 'camera',
      tabs: [
        {
          id: 'camera', label: 'Camera', icon: 'camera',
          build: () => h('div', { class: 'gu-settings__list' },
            row('Camera', 'Which webcam to use', cameraControl()),
            row('Controls', 'Play with your body, or with the keyboard', segmented({ label: 'Controls', value: controls, onChange: (v) => change('inputMode', v), options: [{ value: 'camera', label: 'Camera', icon: 'camera' }, { value: 'keyboard', label: 'Keyboard', icon: 'keyboard' }] })),
            // PERF-06: Auto (the default) = Full, and Lite while this computer can't keep up (switched between rounds)
            row('Tracking', 'Auto picks Full, or Lite when your computer can’t keep up', segmented({ label: 'Tracking model', value: s.model, onChange: (v) => change('model', v), options: [{ value: 'auto', label: 'Auto' }, { value: 'lite', label: 'Lite' }, { value: 'full', label: 'Full' }] })),
            row('Mirror the camera', 'Show the webcam like a mirror', toggle({ label: 'Mirror the camera', value: s.mirror, onChange: (v) => change('mirror', v) }))),
        },
        {
          id: 'play', label: 'Play', icon: 'glove',
          build: () => h('div', { class: 'gu-settings__list' },
            row('Punch sensitivity', 'Lower if you throw punches by accident; raise if punches are missed', slider({ label: 'Punch sensitivity', value: s.sensitivity, min: 0, max: 1, step: 0.1, format: (v) => (v < 0.35 ? 'Steady' : v > 0.65 ? 'Twitchy' : 'Normal'), onChange: (v, final) => { if (final) change('sensitivity', v); } })),
            row('Camera picture-in-picture', 'A small webcam view with your skeleton while you box', toggle({ label: 'Camera picture-in-picture', value: s.showSkeleton, onChange: (v) => change('showSkeleton', v) })),
            row('Keyboard assist', 'Keys also punch and guard while the camera is on', toggle({ label: 'Keyboard assist', value: s.keyboardAssist, onChange: (v) => change('keyboardAssist', v) })),
            row('Reduced motion', 'Calmer screen effects and transitions', toggle({ label: 'Reduced motion', value: s.reducedMotion, onChange: (v) => change('reducedMotion', v) }))),
        },
        {
          id: 'sound', label: 'Sound', icon: 'sound',
          build: () => h('div', { class: 'gu-settings__list' },
            vol('master', 'Master volume', null),
            vol('sfx', 'Effects', 'Punches, bell and crowd'),
            vol('music', 'Music', 'Menu and result music'),
            vol('voice', 'Announcer', 'Round calls and the count'),
            h('div', { class: 'gu-row gu-row--end' }, button({ label: 'Test sound', icon: 'sound', kind: 'ghost', size: 'md', onClick: () => { try { ctx.audio?.playSfx?.('bell'); } catch { /* optional */ } } }))),
        },
      ],
    });

    const el = h('div', { class: 'gu-page gu-settings' },
      pageHeader({ title: 'Settings', onBack: () => ctx.ui.back(), right: savedNote }),
      h('div', { class: 'gu-panel gu-settings__panel' }, panel));
    return { el };
  },
};
