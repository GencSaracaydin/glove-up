// Main menu: pick what to play.
//   params: { profile: Profile, handleInfoScreens?: boolean = true }
//   result: { action: 'single' | 'versus' | 'training' | 'change-profile' | 'back' }
//           (+ 'records' | 'settings' | 'help' when handleInfoScreens is false;
//            by default those three open as sub-screens and come back here)

import { h, button, pageHeader, proBadge, formatNumber, isProRating, proThreshold } from './kit.js';

const TILES = [
  { id: 'single', title: 'Single player', icon: 'glove', kind: 'primary', sub: 'Box rated rivals and turn PRO' },
  { id: 'versus', title: 'Versus', icon: 'gloves', kind: 'p2', sub: 'Two boxers, one camera, split screen' },
  { id: 'training', title: 'Training', icon: 'target', kind: 'good', sub: 'Bag, dodging and target drills · 1–4 players' },
  { id: 'records', title: 'Records', icon: 'chart', kind: 'plain', sub: 'Rating graph, wins and medals' },
  { id: 'settings', title: 'Settings', icon: 'gear', kind: 'plain', sub: 'Camera, sensitivity and sound' },
  { id: 'help', title: 'How to play', icon: 'help', kind: 'plain', sub: 'Punch, guard, dodge and duck' },
];

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'mode',
  title: 'Main menu',
  create(ctx, params) {
    const internal = params.handleInfoScreens !== false;
    let profile = params.profile || null;
    const root = h('div', { class: 'gu-page gu-mode' });

    const nextOpponentName = () => {
      const prog = ctx.deps.peek('progression');
      try {
        // nextBout(profile) knows rematches and beaten opponents; nextOpponent(rating) is the older, stateless pick
        const bout = profile && typeof prog?.nextBout === 'function' ? prog.nextBout(profile) : null;
        const opp = bout?.opponent || prog?.nextOpponent?.(profile?.skill ?? 0);
        return opp?.name || null;
      } catch { return null; }
    };

    function profileChip() {
      if (!profile) return null;
      const rating = profile.skill || 0;
      const skillLine = h('span', { class: 'gu-profile-chip__skill' }, `Rating ${formatNumber(rating)}`);
      const pro = isProRating(rating, proThreshold(ctx.deps.peek('progression')));
      return h('div', { class: 'gu-profile-chip' },
        ctx.portrait(profile.appearance, { size: 64, framing: 'head', cls: 'gu-profile-chip__portrait' }),
        h('div', { class: 'gu-profile-chip__text' },
          h('span', { class: 'gu-profile-chip__name', text: profile.name }),
          h('span', { class: 'gu-profile-chip__meta' }, skillLine, pro ? proBadge() : null,
            profile.kind !== 'local' ? h('span', { class: 'gu-chip gu-chip--muted', text: profile.kind === 'guest' ? 'Guest' : 'Visiting' }) : null)),
        button({ label: 'Switch', icon: 'user', kind: 'ghost', size: 'md', cls: 'gu-profile-chip__switch', onClick: () => ctx.done({ action: 'change-profile' }) }));
    }

    async function pick(id) {
      if (internal && (id === 'records' || id === 'settings' || id === 'help')) {
        await ctx.sub(id, { profile });
        return;
      }
      ctx.done({ action: id });
    }

    function render() {
      root.replaceChildren();
      root.appendChild(pageHeader({ title: 'Let’s box!', onBack: () => ctx.ui.back(), backLabel: 'Boxers', right: profileChip() }));
      const opp = nextOpponentName();
      const grid = h('div', { class: 'gu-mode__grid' }, TILES.map((t) => {
        const sub = t.id === 'single' && opp ? `Next up: ${opp}` : t.sub;
        const b = button({ label: t.title, sub, icon: t.icon, kind: 'tile', cls: `gu-tile gu-tile--${t.kind}`, size: 'xl', onClick: () => pick(t.id) });
        if (t.id === 'single') b.dataset.autofocus = '';
        return b;
      }));
      root.appendChild(grid);
    }
    const hadProgression = !!ctx.deps.peek('progression');
    render();
    // the progression module may still be loading on first paint: add "Next up" once it arrives
    if (!hadProgression) {
      ctx.deps.load('progression').then((mod) => {
        if (!mod || ctx.entry.completed || !ctx.entry.el) return;
        const focusedTile = document.activeElement?.closest?.('.gu-tile') ? [...root.querySelectorAll('.gu-tile')].indexOf(document.activeElement) : -1;
        render();
        const tiles = root.querySelectorAll('.gu-tile');
        (tiles[focusedTile] || tiles[0])?.focus?.({ preventScroll: true });
      });
    }

    return {
      el: root,
      refresh() {
        if (profile?.id) profile = ctx.storage?.getProfile?.(profile.id) || profile;
        render();
      },
    };
  },
};
