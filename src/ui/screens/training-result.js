// TRN02 — practice result: score, medal, personal best, and a comparison table when several
// participants take turns; retry / next player / done. ERR04 save notice per participant.
//   params: { kind: 'bag'|'dodge'|'mitts',
//             results: Array<{ participant: Profile, result: TrainingResult, save?: SaveResult }>,  (turn order)
//             participants?: Profile[]  everyone taking turns, in order (for "Next: name" and the turn count)
//             current?: number   index of the turn that just finished (default: last)
//             final?: boolean    all turns done (default: current is the last participant) }
//   result: { action: 'retry' } | { action: 'next' } | { action: 'done' }
// Esc / Back ends the session ('done') on every turn — it never starts the next player's drill; a
// mid-session result also offers "End session" next to "Try again" (FLOWS-08).

import { saveNotice } from '../../core/storage.js';
import { h, button, icon, medalArt, formatNumber, MEDAL_INFO, TRAINING_INFO, medalRank, UI_TUNING, clamp01, chip } from './kit.js';

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'training-result',
  title: 'Training result',
  armDelayMs: UI_TUNING.postFightArmDelayMs,
  create(ctx, params) {
    const kind = params.kind || params.results?.[0]?.result?.kind || 'bag';
    const info = TRAINING_INFO[kind] || TRAINING_INFO.bag;
    const results = Array.isArray(params.results) ? params.results.filter((x) => x && x.result) : [];
    const cur = Number.isInteger(params.current) ? params.current : results.length - 1;
    const turns = Number.isInteger(params.turns) ? params.turns : Math.max(results.length, params.participants?.length || 0);
    const final = typeof params.final === 'boolean' ? params.final : cur >= turns - 1;
    const me = results[cur] || results[results.length - 1] || null;
    const score = Math.round(me?.result?.score || 0);
    const medal = me?.result?.medal || 'none';
    const save = me?.save || null;
    const prevBest = Number.isFinite(save?.prevBest) ? save.prevBest : null;
    const newBest = !!save?.newBest && score > 0;
    const reduced = ctx.settings()?.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    let t = reduced ? Infinity : -350;

    // next medal hint from training/medals.js cutoffs when available
    let nextHint = null;
    try {
      const medals = ctx.deps.peek('medals');
      const cuts = medals?.MEDAL_CUTOFFS?.[kind];
      if (cuts && typeof cuts === 'object') {
        const order = ['bronze', 'silver', 'gold', 'platinum'];
        const nextMedal = order.find((m) => medalRank(m) > medalRank(medal) && Number.isFinite(cuts[m]));
        if (nextMedal) nextHint = `${formatNumber(cuts[nextMedal] - score)} more for ${MEDAL_INFO[nextMedal].label}`;
      }
    } catch { /* optional */ }

    const num = h('span', { class: 'gu-tres__score', text: reduced ? formatNumber(score) : '0' });
    const medalEl = h('div', { class: `gu-tres__medal${medal !== 'none' ? ' has-medal' : ''}` }, medalArt(medal, { size: 132 }), h('span', { class: 'gu-tres__medalname', text: MEDAL_INFO[medal]?.label || 'No medal' }));

    let table = null;
    if (results.length > 1) {
      const ranked = results.map((x, i) => ({ ...x, i })).sort((a, b) => (b.result.score || 0) - (a.result.score || 0));
      table = h('div', { class: 'gu-panel gu-tres__table' },
        h('h2', { class: 'gu-panel__title', text: final ? 'Final standings' : 'Standings so far' }),
        h('table', { class: 'gu-rank' },
          h('tbody', null, ranked.map((x, place) => h('tr', { class: x.i === cur ? 'is-current' : '' },
            h('td', { class: 'gu-rank__place', text: String(place + 1) }),
            h('td', { class: 'gu-rank__who' }, ctx.portrait(x.participant?.appearance, { size: 40, framing: 'head', gloves: false }), h('span', { text: x.participant?.name || `Player ${x.i + 1}` })),
            h('td', { class: 'gu-rank__score', text: formatNumber(x.result.score || 0) }),
            h('td', { class: 'gu-rank__medal' }, x.result.medal && x.result.medal !== 'none' ? medalArt(x.result.medal, { size: 28 }) : h('span', { class: 'gu-rank__nomedal', text: '—' })))))),
        !final ? h('p', { class: 'gu-panel__text', text: `${turns - cur - 1} more ${turns - cur - 1 === 1 ? 'turn' : 'turns'} to go` }) : null);
    }

    const note = save ? saveNotice(save) : null;
    const buttons = [];
    const retry = button({ label: 'Try again', icon: 'restart', kind: final ? 'secondary' : 'ghost', size: 'md', onClick: () => ctx.done({ action: 'retry' }) });
    buttons.push(retry);
    if (!final) buttons.push(button({ label: 'End session', icon: 'exit', kind: 'ghost', size: 'md', sfx: 'ui-back', cls: 'gu-tres__end', onClick: () => ctx.done({ action: 'done' }) }));
    buttons.push(h('span', { class: 'gu-footer__spacer' }));
    let primary;
    if (!final) {
      const nextName = params.participants?.[cur + 1]?.name || params.nextName || null;
      primary = button({ label: nextName ? `Next: ${nextName}` : 'Next player', icon: 'next', kind: 'primary', size: 'lg', cls: 'gu-arming', onClick: () => ctx.done({ action: 'next' }) });
    } else {
      primary = button({ label: 'Done', icon: 'check', kind: 'primary', size: 'lg', cls: 'gu-arming', onClick: () => ctx.done({ action: 'done' }) });
    }
    primary.style.setProperty('--arm-ms', `${UI_TUNING.postFightArmDelayMs}ms`);
    primary.dataset.autofocus = '';
    buttons.push(primary);

    const el = h('div', { class: `gu-page gu-tres${table ? ' has-table' : ''}` },
      h('div', { class: 'gu-tres__head' },
        h('p', { class: 'gu-tres__kicker' }, icon(info.icon), info.title, turns > 1 ? h('span', { class: 'gu-chip gu-chip--muted', text: `Turn ${cur + 1} of ${turns}` }) : null),
        h('h1', { class: 'gu-tres__who', text: me?.participant?.name || 'Your score' })),
      h('div', { class: 'gu-tres__body' },
        h('div', { class: 'gu-panel gu-tres__main' },
          h('div', { class: 'gu-tres__scorebox' }, h('span', { class: 'gu-tres__label', text: 'Score' }), num,
            newBest ? h('span', { class: 'gu-tres__newbest' }, icon('star'), 'NEW BEST!') : null),
          medalEl,
          h('div', { class: 'gu-tres__facts' },
            prevBest !== null ? h('p', null, icon('trophy'), newBest ? `Old best: ${formatNumber(prevBest)}` : `Personal best: ${formatNumber(Math.max(prevBest, score))}`) : null,
            nextHint ? h('p', null, icon('target'), nextHint) : null,
            me?.participant?.kind && me.participant.kind !== 'local' ? chip(me.participant.kind === 'guest' ? 'Guest' : 'Visiting', 'muted') : null)),
        table),
      note ? h('p', { class: `gu-notice ${save?.reason ? 'gu-notice--info' : 'gu-notice--warn'}`, role: 'status' }, icon(save?.reason ? 'user' : 'eyeoff'), h('span', null, h('b', { text: save?.reason ? 'Not saved. ' : 'Progress not saved. ' }), note)) : null,
      h('div', { class: 'gu-footer' }, buttons));

    let sounded = false;
    return {
      el,
      focus: () => primary,
      update(dt) {
        if (t === Infinity) return;
        t += dt * 1000;
        if (t < 0) return;
        const k = clamp01(t / 1100);
        num.textContent = formatNumber(Math.round(score * (1 - Math.pow(1 - k, 3))));
        if (k >= 1) {
          t = Infinity;
          el.classList.add('is-counted');
          if (!sounded) { sounded = true; ctx.sfx(medal !== 'none' ? `medal-${medal}` : 'ui-ready'); }
        }
      },
      back() { ctx.done({ action: 'done' }); return true; },
    };
  },
};
