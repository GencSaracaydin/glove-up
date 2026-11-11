// MAT04 — the adjudicated outcome, shown after the bout outro (research/mechanics.md §5, §9.1):
//  * decisions and draws: the winner, the decision type (unanimous / majority / split / draw) and each
//    judge's totals, revealed card by card — no punch-stats table;
//  * versus bouts: a winner card with no rating (decision details when it went to the cards);
//  * a single-player KO normally goes straight to the results card (integration wires the flow) —
//    if it is routed here anyway, it shows a plain winner card.
// The result is already locked by the Match; this screen only presents it (buttons arm late so
// post-fight arm-waving can't skip it).
//   ids: 'result' (also 'decision' and 'versus-result')
//   params: { result: MatchResult, names?: {p1, p2}, appearances?: {p1, p2}, humanSide?: 'p1'|'p2'|null }
//           (humanSide defaults to 'p1' in single player, null in versus)
//   result: { action: 'continue' }

import { h, button, icon, describeResult, decisionReveal, UI_TUNING } from './kit.js';

export const RESULT_TUNING = Object.freeze({
  /** First judge's card flips in after this (ms); each next one this much later. */
  cardDelayMs: 500,
  cardStepMs: 420,
});

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'result',
  title: 'Fight result',
  armDelayMs: UI_TUNING.postFightArmDelayMs,
  create(ctx, params) {
    const r = params.result || {};
    const names = { p1: params.names?.p1 || r.names?.p1 || 'P1', p2: params.names?.p2 || r.names?.p2 || 'P2' };
    const versus = r.mode === 'versus';
    const humanSide = params.humanSide !== undefined ? params.humanSide : versus ? null : 'p1';
    const d = describeResult(r, { names, humanSide });
    const dec = decisionReveal(r);
    const isDecision = dec.cards.length > 0 && d.method !== 'KO';
    const tone = d.outcome === 'win' ? 'win' : d.outcome === 'loss' ? 'loss' : d.winner ? 'win' : 'draw';

    const fighter = (id) => {
      const won = d.winner === id;
      const ap = params.appearances?.[id];
      return h('div', { class: `gu-dec__boxer gu-dec__boxer--${id}${won ? ' is-winner' : ''}${d.winner && !won ? ' is-loser' : ''}` },
        won ? h('span', { class: 'gu-dec__crown', 'aria-hidden': 'true' }, icon('crown')) : null,
        ap ? ctx.portrait(ap, { size: won ? 208 : 176, label: names[id], ring: won ? '#ffc94a' : '#14182b', yaw: id === 'p1' ? 0.3 : -0.3 }) : h('span', { class: 'gu-dec__noportrait' }, icon('user')),
        h('span', { class: `gu-dec__name gu-dec__name--${id}`, text: names[id] }),
        won ? h('span', { class: 'gu-chip gu-chip--gold', text: 'Winner' }) : null);
    };

    let center;
    if (isDecision) {
      center = h('div', { class: 'gu-panel gu-dec__cards' },
        h('p', { class: 'gu-dec__cardstitle' }, icon('star'), h('span', { text: 'The judges’ cards' })),
        h('div', { class: 'gu-dec__list' }, dec.cards.map((c, i) => h('div', {
          class: `gu-judge${c.winner ? ` is-${c.winner}` : ' is-even'}`,
          vars: { '--delay': `${RESULT_TUNING.cardDelayMs + i * RESULT_TUNING.cardStepMs}ms` },
        },
        h('span', { class: 'gu-judge__name', text: c.judge }),
        h('span', { class: 'gu-judge__score' },
          h('b', { class: `gu-judge__n gu-judge__n--p1${c.winner === 'p1' ? ' is-best' : ''}`, text: String(c.p1) }),
          h('span', { class: 'gu-judge__dash', text: '–' }),
          h('b', { class: `gu-judge__n gu-judge__n--p2${c.winner === 'p2' ? ' is-best' : ''}`, text: String(c.p2) }))))),
        h('div', { class: 'gu-dec__legend' },
          h('span', { class: 'gu-dec__key gu-dec__key--p1', text: names.p1 }),
          h('span', { class: 'gu-dec__key gu-dec__key--p2', text: names.p2 })));
    } else {
      center = h('div', { class: 'gu-dec__vs', 'aria-hidden': 'true' }, h('span', { text: d.method === 'KO' ? 'KO' : 'VS' }));
    }

    const cont = button({ label: 'Continue', icon: 'next', kind: 'primary', size: 'lg', cls: 'gu-arming', onClick: () => ctx.done({ action: 'continue' }) });
    cont.style.setProperty('--arm-ms', `${UI_TUNING.postFightArmDelayMs}ms`);
    cont.dataset.autofocus = '';

    const chipText = isDecision ? dec.label : d.method === 'KO' ? 'KO' : d.methodShort;
    const when = Number.isFinite(r.endRound) && r.endRound > 0 ? `Round ${r.endRound}` : '';
    const el = h('div', { class: `gu-page gu-result gu-dec gu-dec--${tone}${isDecision ? ' gu-dec--decision' : ''}${versus ? ' gu-dec--versus' : ''}` },
      h('div', { class: 'gu-dec__head' },
        h('h1', { class: 'gu-dec__headline', text: d.headline }),
        h('div', { class: 'gu-dec__method' },
          h('span', { class: `gu-chip gu-chip--big ${isDecision ? 'gu-chip--neutral' : 'gu-chip--accent'}`, text: chipText }),
          when ? h('span', { class: 'gu-chip gu-chip--muted gu-chip--big', text: when }) : null)),
      h('div', { class: 'gu-dec__body' }, fighter('p1'), center, fighter('p2')),
      h('div', { class: 'gu-footer' }, h('span', { class: 'gu-footer__spacer' }), cont));
    return { el, focus: () => cont, back() { ctx.done({ action: 'continue' }); return true; } };
  },
};
