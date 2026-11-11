// Records per boxer: rating history graph (with the PRO line), W/L/D/KO, versus tally, recent bouts,
// training bests and medals (SAV01: guests/visitors are labelled as not saved).
//   params: { profile?: Profile }
//   result: { action: 'back' }

import { h, svg, icon, cycler, pageHeader, proBadge, formatNumber, formatSigned, skillSeries, linePath,
  medalArt, MEDAL_INFO, TRAINING_INFO, chip, clear, isProRating, proThreshold } from './kit.js';

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'records',
  title: 'Records',
  create(ctx, params) {
    const storage = ctx.storage;
    const proAt = proThreshold(ctx.deps.peek('progression'));
    const pool = () => {
      const list = storage?.listProfiles?.() || [];
      const given = params.profile ? (storage?.getProfile?.(params.profile.id) || params.profile) : null;
      if (given && !list.some((p) => p.id === given.id)) list.unshift(given);
      return list;
    };
    let profiles = pool();
    let currentId = params.profile?.id || profiles[0]?.id || null;
    const body = h('div', { class: 'gu-records__body' });
    const pickerHost = h('div', { class: 'gu-records__picker' });

    function graph(p) {
      const series = skillSeries(p.records?.matches?.history || [], p.skill);
      const W = 640, H = 260;
      if (series.length < 2) {
        return h('div', { class: 'gu-graph gu-graph--empty' }, icon('chart'), h('p', { text: 'Fight a single-player bout to start your rating graph.' }));
      }
      const top = Math.max(proAt * 1.1, ...series);
      const g = linePath(series, { w: W, h: H, pad: 22, min: 0, max: top });
      const proY = g.y(proAt);
      const last = g.points.at(-1);
      return h('div', { class: 'gu-graph' },
        svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gu-graph__svg', role: 'img', 'aria-label': `Rating over the last ${series.length - 1} bouts, now ${p.skill}` },
          svg('rect', { x: 0, y: 0, width: W, height: proY, class: 'gu-graph__prozone' }),
          svg('line', { x1: 0, x2: W, y1: proY, y2: proY, class: 'gu-graph__proline' }),
          svg('text', { x: 10, y: proY - 8, class: 'gu-graph__prolabel' }, `PRO ${formatNumber(proAt)}`),
          svg('path', { d: g.area, class: 'gu-graph__area' }),
          svg('path', { d: g.d, class: 'gu-graph__line' }),
          ...g.points.map((pt) => svg('circle', { cx: pt.x, cy: pt.y, r: 4.5, class: 'gu-graph__pt' })),
          svg('circle', { cx: last.x, cy: last.y, r: 9, class: 'gu-graph__last' }),
          svg('text', { x: Math.min(W - 8, last.x), y: Math.max(18, last.y - 16), 'text-anchor': last.x > W - 60 ? 'end' : 'middle', class: 'gu-graph__lastlabel' }, formatNumber(series.at(-1)))));
    }

    function tally(label, n, kind) {
      return h('div', { class: `gu-tally gu-tally--${kind}` }, h('span', { class: 'gu-tally__n', text: formatNumber(n) }), h('span', { class: 'gu-tally__label', text: label }));
    }

    function render() {
      profiles = pool();
      clear(pickerHost);
      if (profiles.length > 1) {
        pickerHost.appendChild(cycler({ label: 'Boxer', values: profiles.map((p) => p.id), value: currentId, format: (id) => profiles.find((p) => p.id === id)?.name || '—', onChange: (id) => { currentId = id; renderBody(); } }));
      }
      renderBody();
    }

    function renderBody() {
      clear(body);
      const p = profiles.find((x) => x.id === currentId) || profiles[0];
      if (!p) {
        body.appendChild(h('div', { class: 'gu-empty' }, h('p', { class: 'gu-empty__title', text: 'No boxers yet' }), h('p', { class: 'gu-empty__text', text: 'Make a boxer to start keeping records.' })));
        return;
      }
      const m = p.records?.matches || { wins: 0, losses: 0, draws: 0, kos: 0, history: [] };
      const v = p.records?.versus || { wins: 0, losses: 0, draws: 0 };
      const recent = (m.history || []).slice(-5).reverse();
      const left = h('div', { class: 'gu-panel gu-records__skill' },
        h('div', { class: 'gu-records__who' },
          ctx.portrait(p.appearance, { size: 72, framing: 'head' }),
          h('div', null, h('h2', { class: 'gu-records__name', text: p.name }),
            h('p', { class: 'gu-records__skillnow' }, `Rating ${formatNumber(p.skill || 0)}`, isProRating(p.skill || 0, proAt) ? proBadge() : null,
              p.kind !== 'local' ? chip(p.kind === 'guest' ? 'Guest — not saved' : 'Visiting — not saved here', 'muted') : null))),
        graph(p),
        h('div', { class: 'gu-tallies' }, tally('Wins', m.wins, 'win'), tally('Losses', m.losses, 'loss'), tally('Draws', m.draws, 'draw'), tally('KO wins', m.kos, 'ko')),
        (v.wins + v.losses + v.draws) > 0 ? h('p', { class: 'gu-records__versus' }, icon('gloves'), `Versus: ${v.wins} won · ${v.losses} lost · ${v.draws} drawn`) : null);
      const train = h('div', { class: 'gu-panel gu-records__train' },
        h('h2', { class: 'gu-panel__title', text: 'Training bests' }),
        ...['bag', 'dodge', 'mitts'].map((k) => {
          const r = p.records?.training?.[k] || { best: 0, medal: 'none', plays: 0 };
          return h('div', { class: 'gu-trainrow' },
            h('span', { class: 'gu-trainrow__icon' }, icon(TRAINING_INFO[k].icon)),
            h('span', { class: 'gu-trainrow__name', text: TRAINING_INFO[k].title }),
            h('span', { class: 'gu-trainrow__best', text: r.plays ? formatNumber(r.best) : '—' }),
            h('span', { class: 'gu-trainrow__medal', title: MEDAL_INFO[r.medal]?.label || '' }, r.medal && r.medal !== 'none' ? medalArt(r.medal, { size: 36 }) : h('span', { class: 'gu-trainrow__nomedal', text: r.plays ? 'No medal' : 'Not tried' })));
        }),
        h('h2', { class: 'gu-panel__title gu-panel__title--spaced', text: 'Recent bouts' }),
        recent.length ? h('ul', { class: 'gu-bouts' }, recent.map((b) => h('li', { class: `gu-bout gu-bout--${b.outcome}` },
          h('span', { class: 'gu-bout__res', text: b.outcome === 'win' ? 'W' : b.outcome === 'loss' ? 'L' : 'D' }),
          h('span', { class: 'gu-bout__opp', text: b.mode === 'versus' ? 'Versus bout' : (b.opponentName || 'Opponent') }),
          h('span', { class: 'gu-bout__how', text: b.method === 'decision' ? 'Pts' : b.method === 'draw' ? 'Draw' : 'KO' }),
          h('span', { class: `gu-bout__delta ${b.delta > 0 ? 'is-up' : b.delta < 0 ? 'is-down' : ''}`, text: b.mode === 'versus' ? '' : formatSigned(b.delta) }))))
          : h('p', { class: 'gu-panel__text', text: 'No bouts yet.' }));
      body.append(left, train);
    }

    render();
    const el = h('div', { class: 'gu-page gu-records' },
      pageHeader({ title: 'Records', onBack: () => ctx.ui.back(), right: pickerHost }),
      body);
    return { el, refresh: render };
  },
};
