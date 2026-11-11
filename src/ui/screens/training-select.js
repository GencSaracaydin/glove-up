// TRN01 — pick a practice activity (Bag practice, Dodging drill, Target punching) and who takes
// turns (1–4 participants sharing the camera, one at a time).
//   params: { profile?: Profile }   (participant 1)
//   result: { action: 'start', kind: 'bag'|'dodge'|'mitts', participants: Profile[] } | { action: 'back' }
// Extra participants are other local boxers or guests (guests are created when you start).

import { TrainingKind } from '../../core/types.js';
import { h, button, icon, pageHeader, segmented, cycler, medalArt, formatNumber, TRAINING_INFO, clear } from './kit.js';

const KINDS = [TrainingKind.BAG, TrainingKind.DODGE, TrainingKind.MITTS];
const GUEST = '__guest__';

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'training-select',
  title: 'Training',
  create(ctx, params) {
    const storage = ctx.storage;
    const first = params.profile || null;
    let count = 1;
    /** slot → profile id or GUEST */
    const slots = [first?.id || GUEST, GUEST, GUEST, GUEST];
    const locals = () => (storage?.listProfiles?.() || []);

    const partHost = h('div', { class: 'gu-train__slots' });

    function candidates(slot) {
      const taken = new Set(slots.slice(0, count).filter((id, i) => i !== slot && id !== GUEST));
      return [...locals().filter((p) => !taken.has(p.id)).map((p) => p.id), GUEST];
    }

    function nameOf(id, slot) {
      if (id === GUEST) return `Guest ${slot + 1}`;
      return locals().find((p) => p.id === id)?.name || (first?.id === id ? first.name : 'Boxer');
    }

    function renderSlots() {
      clear(partHost);
      for (let i = 0; i < count; i++) {
        if (i === 0) {
          partHost.appendChild(h('div', { class: 'gu-train__slot gu-train__slot--fixed' },
            h('span', { class: 'gu-train__slotno', text: '1' }),
            first ? ctx.portrait(first.appearance, { size: 48, framing: 'head' }) : null,
            h('span', { class: 'gu-train__slotname', text: first?.name || 'Guest 1' })));
          continue;
        }
        const vals = candidates(i);
        if (!vals.includes(slots[i])) slots[i] = vals.find((v) => v !== GUEST) || GUEST;
        partHost.appendChild(h('div', { class: 'gu-train__slot' },
          h('span', { class: 'gu-train__slotno', text: String(i + 1) }),
          cycler({ label: `Player ${i + 1}`, values: vals, value: slots[i], format: (id) => nameOf(id, i), onChange: (id) => { slots[i] = id; } })));
      }
    }

    function participants() {
      const out = [];
      for (let i = 0; i < count; i++) {
        const id = slots[i];
        if (i === 0 && first) { out.push(first); continue; }
        if (id !== GUEST) {
          const p = storage?.getProfile?.(id);
          if (p) { out.push(p); continue; }
        }
        const g = storage?.guest?.({ name: `Guest ${i + 1}` });
        if (g) out.push(g);
      }
      return out;
    }

    function start(kind) {
      ctx.done({ action: 'start', kind, participants: participants() });
    }

    const cards = KINDS.map((kind) => {
      const info = TRAINING_INFO[kind];
      const rec = first?.records?.training?.[kind];
      const best = rec && rec.plays > 0 ? `Best ${formatNumber(rec.best)}` : 'Not tried yet';
      const b = button({
        kind: 'card', size: 'xl', cls: `gu-train__card gu-train__card--${kind}`, ariaLabel: `${info.title}. ${info.rule}`,
        onClick: () => start(kind),
        content: [
          h('span', { class: 'gu-train__icon' }, icon(info.icon)),
          h('span', { class: 'gu-train__title', text: info.title }),
          h('span', { class: 'gu-train__rule', text: info.rule }),
          h('span', { class: 'gu-train__best' }, rec?.medal && rec.medal !== 'none' ? medalArt(rec.medal, { size: 30 }) : null, h('span', { text: best })),
          h('span', { class: 'gu-train__watermark', 'aria-hidden': 'true' }, icon(info.icon)),
        ],
      });
      if (kind === KINDS[0]) b.dataset.autofocus = '';
      return b;
    });

    const countSeg = segmented({
      label: 'Players', value: count,
      options: [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })),
      onChange: (n) => { count = n; renderSlots(); },
    });
    renderSlots();

    const el = h('div', { class: 'gu-page gu-train' },
      pageHeader({ title: 'Training', sub: 'Pick a drill — each one trains a different skill', onBack: () => ctx.ui.back() }),
      h('div', { class: 'gu-train__cards' }, cards),
      h('div', { class: 'gu-panel gu-train__players' },
        h('div', { class: 'gu-train__count' }, h('span', { class: 'gu-field__label', text: 'Players taking turns' }), countSeg),
        partHost));
    return { el };
  },
};
