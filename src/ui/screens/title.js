// Title screen: the animated GLOVE UP logo, "Step into the ring" and one big Start button.
//   params: { version?: string }
//   result: { action: 'start' }

import { h, button, icon } from './kit.js';

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'title',
  title: 'Glove Up — title',
  noBack: true,
  armDelayMs: 500,
  create(ctx, params) {
    const start = button({
      label: 'Start', sub: 'Click or press Enter', icon: 'glove', kind: 'primary', size: 'xl',
      cls: 'gu-title__start', onClick: () => ctx.done({ action: 'start' }),
    });
    start.dataset.autofocus = '';
    const letters = (word, cls) => h('span', { class: `gu-logo__word ${cls}` },
      [...word].map((c, i) => h('span', { class: 'gu-logo__ch', vars: { '--i': i } }, c)));
    const el = h('div', { class: 'gu-page gu-title-screen' },
      h('div', { class: 'gu-title__spot', 'aria-hidden': 'true' }),
      h('div', { class: 'gu-logo', role: 'img', 'aria-label': 'Glove Up' },
        h('span', { class: 'gu-logo__glove gu-logo__glove--l', 'aria-hidden': 'true' }, icon('glove')),
        h('span', { class: 'gu-logo__text', 'aria-hidden': 'true' }, letters('GLOVE', 'gu-logo__word--a'), letters('UP', 'gu-logo__word--b')),
        h('span', { class: 'gu-logo__glove gu-logo__glove--r', 'aria-hidden': 'true' }, icon('glove'))),
      h('p', { class: 'gu-tagline', text: 'Step into the ring' }),
      start,
      h('ul', { class: 'gu-title__hints' },
        h('li', null, icon('camera'), h('span', { text: 'Stand 1–2 m back from your webcam' })),
        h('li', null, icon('keyboard'), h('span', { text: 'No camera? The keyboard works too' }))),
      params?.version ? h('p', { class: 'gu-title__version', text: params.version }) : null);
    return { el, focus: () => start };
  },
};
