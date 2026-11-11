// VS card before a single-player bout (research/mechanics.md §5 "VS card", §1.2, §7.2–7.3) — our own
// layout: the two fighters on blue and coral slabs split by a diagonal lightning band, a VS medallion,
// each side's name, rating and a PRO badge at 1000+, a "Rematch" tag when it is one, and a confirm
// prompt (Enter or a click on "Fight!"). No stat bars and no ladder row.
//   params: { opponent?: RosterEntry, profile?: Profile,
//             bout?: progression.describeBout() result {player, opponent, rematch} or a nextBout() result }
//           Without `bout`, progression.describeBout({profile, bout: {opponent}}) is used when available.
//   result: { action: 'start' } | { action: 'back' }

import { h, svg, button, icon, proBadge, formatNumber, vsCardModel, proThreshold } from './kit.js';

/** Zig-zag centre line of the bolt (percent of the card, top → bottom); slabs follow it. */
const BOLT = [[57, 0], [53, 25], [56, 27], [50, 55], [53, 57], [45, 100]];
const W = 1.3; // half width of the bolt band (percent)

function boltSvg() {
  const band = (w) => [...BOLT.map(([x, y]) => `${x - w},${y}`), ...BOLT.slice().reverse().map(([x, y]) => `${x + w},${y}`)].join(' ');
  return svg('svg', { class: 'gu-vs__bolt', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('polygon', { class: 'gu-vs__bolt-glow', points: band(W) }),
    svg('polygon', { class: 'gu-vs__bolt-band', points: band(W) }),
    svg('polygon', { class: 'gu-vs__bolt-core', points: band(W * 0.35) }));
}

const clipFor = (side) => {
  const edge = BOLT.map(([x, y]) => `${x}% ${y}%`);
  return side === 'p1'
    ? `polygon(0 0, ${edge.join(', ')}, 0 100%)`
    : `polygon(100% 0, ${edge.join(', ')}, 100% 100%)`;
};

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'vs',
  title: 'Next bout',
  armDelayMs: 400,
  create(ctx, params) {
    const profile = params.profile || null;
    const root = h('div', { class: 'gu-page gu-vs' });
    const start = button({ label: 'Fight!', icon: 'glove', kind: 'primary', size: 'xl', cls: 'gu-vs__go', onClick: () => ctx.done({ action: 'start' }) });
    start.dataset.autofocus = '';
    const back = button({ icon: 'back', label: 'Back', kind: 'ghost', size: 'md', cls: 'gu-vs__back', sfx: 'ui-back', onClick: () => ctx.ui.back() });
    const prompt = h('div', { class: 'gu-vs__prompt' },
      start,
      h('p', { class: 'gu-vs__hint' }, icon('glove'), h('span', { text: 'Click Fight! or press Enter' })));

    function model() {
      const prog = ctx.deps.peek('progression');
      const rosterMod = ctx.deps.peek('roster');
      let bout = params.bout || null;
      if (!bout && profile && typeof prog?.describeBout === 'function') {
        try { bout = prog.describeBout({ profile, bout: params.opponent ? { opponent: params.opponent } : null }); } catch (e) { console.warn('[ui] describeBout failed', e); bout = null; }
      }
      const ratingOf = typeof prog?.opponentRating === 'function' ? (o) => prog.opponentRating(o, profile) : null;
      return vsCardModel({ profile, opponent: params.opponent || null, bout, proAt: proThreshold(prog), roster: rosterMod?.ROSTER || [], ratingOf });
    }

    function side(id, data, rematch) {
      const flip = id === 'p2';
      return h('div', { class: `gu-vs__side gu-vs__side--${id}` },
        h('div', { class: 'gu-vs__slab', style: { clipPath: clipFor(id) }, 'aria-hidden': 'true' }),
        h('div', { class: 'gu-vs__fighter' },
          data.appearance
            ? ctx.portrait(data.appearance, { size: 300, cls: 'gu-vs__portrait', label: data.name, yaw: flip ? -0.38 : 0.38, ring: '#14182b' })
            : h('span', { class: 'gu-vs__noportrait' }, icon('user'))),
        h('div', { class: 'gu-vs__plate' },
          flip && rematch ? h('span', { class: 'gu-vs__rematch' }, icon('restart'), 'Rematch') : null,
          h('span', { class: 'gu-vs__name', text: data.name }),
          data.nickname ? h('span', { class: 'gu-vs__nick', text: `“${data.nickname}”` }) : null,
          h('span', { class: 'gu-vs__meta' },
            Number.isFinite(data.rating) ? h('span', { class: 'gu-vs__rating' }, h('small', { text: 'Rating' }), h('b', { text: formatNumber(data.rating) })) : null,
            data.pro ? proBadge() : null)));
    }

    function render() {
      const m = model();
      root.setAttribute('aria-label', `${m.player.name} versus ${m.opponent.name}`);
      root.replaceChildren(
        side('p1', m.player, false),
        side('p2', m.opponent, m.rematch),
        boltSvg(),
        h('div', { class: 'gu-vs__medal', 'aria-hidden': 'true' }, h('span', { text: 'VS' })),
        back,
        prompt);
    }
    render();
    // Lazy deps (dev pages): ratings and the rematch flag come from progression — redraw once it loads.
    if (!params.bout && !ctx.deps.peek('progression')) {
      ctx.deps.load('progression').then((mod) => { if (mod && !ctx.entry.completed && ctx.entry.el) { render(); ctx.refocus(); } });
    }
    return { el: root, focus: () => start };
  },
};
