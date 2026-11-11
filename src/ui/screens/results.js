// Results card after a single-player bout (research/mechanics.md §5 "Results card", §1.2, §7) — our own
// layout: a line graph of the rating history with a horizontal PRO line at 1000, the new rating
// counting up, the signed change with an up/down arrow, the boxer's name plate, a PRO gained / lost
// moment, a glove-unlock moment when a milestone is crossed, and (ERR04) "Progress not saved".
// "Play again" (the default) and "Quit" appear RESULTS_TUNING.buttonsDelayMs after the card (1–2.5 s).
//   params: { before:number, after:number, delta?:number, pro?:boolean, becamePro?:boolean, lostPro?:boolean,
//             unlocked?: Array<{id?, name?, color, at}>  (progression applySkill/applyBout/resultsSummary .unlocked),
//             bestBefore?:number, bestAfter?:number, history?: Array<{rating:number}>|number[],
//             save?: SaveResult|null, profile?: Profile, proThreshold?: number }
//   result: { action: 'next' }  ("Play again" → the next VS card)  |  { action: 'menu' }  ("Quit")

import { saveNotice } from '../../core/storage.js';
import {
  h, svg, button, icon, proBadge, formatNumber, formatSigned, clamp01, ratingSeries, ratingGraph, proThreshold,
  isProRating, normalizeGloveUnlocks, crossedGloveUnlocks,
} from './kit.js';

export const RESULTS_TUNING = Object.freeze({
  /** Pause before the rating starts counting (ms). */
  delayMs: 450,
  /** Count-up + last graph segment draw (ms). */
  countMs: 1400,
  /** "Play again" / "Quit" appear (and arm) this long after the card (§1.2: 1–2.5 s). */
  buttonsDelayMs: 1500,
  /** Rating points shown in the graph (oldest dropped). */
  graphPoints: 40,
});

/** Best rating ever reached BEFORE this bout (fallback when the caller does not pass bestBefore). */
function bestBeforeFrom(profile, before, after) {
  const hist = (profile?.records?.matches?.history || []).filter((m) => m && m.mode !== 'versus' && Number.isFinite(m.skillAfter));
  const last = hist[hist.length - 1];
  const rest = last && last.skillAfter === after && last.skillBefore === before ? hist.slice(0, -1) : hist;
  let best = before;
  for (const m of rest) best = Math.max(best, m.skillAfter, Number.isFinite(m.skillBefore) ? m.skillBefore : 0);
  return best;
}

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'results',
  title: 'Your rating',
  armDelayMs: RESULTS_TUNING.buttonsDelayMs,
  create(ctx, params) {
    const prog = ctx.deps.peek('progression');
    const proAt = Number(params.proThreshold) || proThreshold(prog);
    const before = Math.round(Number(params.before) || 0);
    const after = Math.round(Number.isFinite(params.after) ? params.after : before + (Number(params.delta) || 0));
    const delta = after - before;
    const pro = typeof params.pro === 'boolean' ? params.pro : isProRating(after, proAt);
    // PRO gained / lost moments: progression's flags when given, else the crossing of the PRO line
    const becamePro = typeof params.becamePro === 'boolean' ? params.becamePro : pro && !isProRating(before, proAt);
    const lostPro = typeof params.lostPro === 'boolean' ? params.lostPro : !pro && isProRating(before, proAt);
    const profile = params.profile || null;
    const reduced = ctx.settings()?.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    // ── unlocks crossed by this bout (progression passes them; else derive from GLOVE_UNLOCKS) ──
    let unlocked = Array.isArray(params.unlocked) ? normalizeGloveUnlocks(params.unlocked) : null;
    if (!unlocked && prog?.GLOVE_UNLOCKS) {
      const bestBefore = Number.isFinite(params.bestBefore) ? params.bestBefore : bestBeforeFrom(profile, before, after);
      const bestAfter = Number.isFinite(params.bestAfter) ? params.bestAfter : Math.max(bestBefore, after);
      unlocked = crossedGloveUnlocks(prog.GLOVE_UNLOCKS, bestBefore, bestAfter);
    }
    unlocked = unlocked || [];

    // ── graph ──
    let history = Array.isArray(params.history) ? params.history : null;
    if (!history && profile && typeof prog?.ratingHistory === 'function') {
      try { history = prog.ratingHistory(profile, { withStart: true, limit: RESULTS_TUNING.graphPoints }); } catch { history = null; }
    }
    const series = ratingSeries({ profile, before, after, history, limit: RESULTS_TUNING.graphPoints });
    const GW = 560, GH = 300;
    const g = ratingGraph(series, { w: GW, h: GH, pad: 26, proAt });
    const pts = g.points;
    const lastPt = pts[pts.length - 1];
    const prevPt = pts[pts.length - 2] || lastPt;
    const past = pts.slice(0, -1).map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
    const seg = svg('path', { d: `M${prevPt.x} ${prevPt.y} L${lastPt.x} ${lastPt.y}`, class: 'gu-rgraph__seg', pathLength: 100 });
    const lastDot = svg('circle', { cx: lastPt.x, cy: lastPt.y, r: 9, class: 'gu-rgraph__last' });
    const gridLines = [];
    for (let v = 500; v < g.top; v += 500) if (Math.abs(v - proAt) > 1) gridLines.push(svg('line', { x1: 0, x2: GW, y1: g.y(v), y2: g.y(v), class: 'gu-rgraph__grid' }));
    const graph = h('div', { class: 'gu-rgraph' },
      svg('svg', { viewBox: `0 0 ${GW} ${GH}`, class: 'gu-rgraph__svg', role: 'img', 'aria-label': `Rating history, now ${after}; PRO starts at ${proAt}` },
        svg('rect', { x: 0, y: 0, width: GW, height: Math.max(0, g.proY), class: 'gu-rgraph__prozone' }),
        ...gridLines,
        svg('line', { x1: 0, x2: GW, y1: g.proY, y2: g.proY, class: 'gu-rgraph__proline' }),
        svg('path', { d: g.area, class: 'gu-rgraph__area' }),
        past ? svg('path', { d: past, class: 'gu-rgraph__line' }) : null,
        seg,
        ...pts.slice(0, -1).map((p) => svg('circle', { cx: p.x, cy: p.y, r: 3.5, class: 'gu-rgraph__pt' })),
        lastDot),
      h('span', { class: 'gu-rgraph__prolabel', vars: { '--y': `${((g.proY / GH) * 100).toFixed(2)}%` } }, h('b', { text: 'PRO' }), h('small', { text: formatNumber(proAt) })));

    // ── name plate + number ──
    const num = h('span', { class: 'gu-results__num', text: formatNumber(before) });
    const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const deltaEl = h('span', { class: `gu-results__delta is-${dir}` },
      h('span', { text: formatSigned(delta) }), dir === 'flat' ? null : h('span', { class: 'gu-results__arrow' }, icon(dir)));
    const proSlot = h('span', { class: 'gu-results__proslot' }, pro && !becamePro ? proBadge() : null);
    const plate = h('div', { class: 'gu-results__plate' },
      profile?.appearance ? ctx.portrait(profile.appearance, { size: 72, framing: 'head', gloves: false, cls: 'gu-results__face' }) : h('span', { class: 'gu-results__face gu-results__face--none' }, icon('user')),
      h('span', { class: 'gu-results__name', text: profile?.name || 'You' }),
      proSlot);

    // ── moments ──
    const moments = h('div', { class: 'gu-results__moments' });
    let proMoment = null;
    if (becamePro) proMoment = h('div', { class: 'gu-moment gu-moment--pro' }, proBadge(true), h('span', { class: 'gu-moment__text', text: 'You turned PRO!' }));
    else if (lostPro) proMoment = h('div', { class: 'gu-moment gu-moment--lost' }, h('span', { class: 'gu-pro gu-pro--big gu-pro--lost' }, icon('star'), 'PRO'), h('span', { class: 'gu-moment__text', text: `PRO lost — climb back to ${formatNumber(proAt)}` }));
    else if (!pro) moments.appendChild(h('p', { class: 'gu-results__togo' }, `${formatNumber(Math.max(0, proAt - after))} to PRO`));
    if (proMoment) moments.appendChild(proMoment);
    const unlockEls = unlocked.map((u) => h('div', { class: 'gu-moment gu-moment--unlock', vars: { '--glove': u.color } },
      h('span', { class: 'gu-moment__glove', 'aria-hidden': 'true' }, icon('glove')),
      h('span', { class: 'gu-moment__col' },
        h('span', { class: 'gu-moment__text', text: `New gloves: ${u.name || 'a new colour'}!` }),
        h('span', { class: 'gu-moment__sub', text: 'Pick them under Kit when you edit your boxer' }))));
    for (const u of unlockEls) moments.appendChild(u);

    const note = params.save ? saveNotice(params.save) : null;
    const again = button({ label: 'Play again', icon: 'glove', kind: 'primary', size: 'lg', cls: 'gu-results__again', onClick: () => ctx.done({ action: 'next' }) });
    again.dataset.autofocus = '';
    const quit = button({ label: 'Quit', icon: 'exit', kind: 'secondary', size: 'lg', cls: 'gu-results__quit', sfx: 'ui-back', onClick: () => ctx.done({ action: 'menu' }) });
    const footer = h('div', { class: 'gu-footer gu-results__buttons is-waiting' }, again, quit);

    const el = h('div', { class: `gu-page gu-skill gu-results gu-results--${dir}` },
      h('h1', { class: 'gu-results__title', text: 'Rating' }),
      h('div', { class: 'gu-results__body' },
        h('div', { class: 'gu-panel gu-results__graph' }, graph),
        h('div', { class: 'gu-results__side' },
          plate,
          h('div', { class: 'gu-results__counter' }, num, deltaEl),
          moments)),
      note ? h('p', { class: `gu-notice ${params.save?.reason ? 'gu-notice--info' : 'gu-notice--warn'}`, role: 'status' }, icon(params.save?.reason ? 'user' : 'eyeoff'), h('span', null, h('b', { text: params.save?.reason ? 'Not saved. ' : 'Progress not saved. ' }), note)) : null,
      footer);

    function paint(k) {
      num.textContent = formatNumber(Math.round(before + (after - before) * k));
      seg.style.strokeDashoffset = String(100 - 100 * k);
    }
    let t = reduced ? Infinity : -RESULTS_TUNING.delayMs;
    let shownAt = 0;
    let revealed = false;
    let finished = false;
    paint(reduced ? 1 : 0);
    if (reduced) el.classList.add('is-counted');

    function finish() {
      if (finished) return;
      finished = true;
      el.classList.add('is-counted');
      if (proMoment) { proMoment.classList.add('is-in'); if (becamePro) proSlot.replaceChildren(proBadge()); }
      unlockEls.forEach((u, i) => setTimeout(() => u.classList.add('is-in'), reduced ? 0 : 350 + i * 250));
      if (becamePro) ctx.sfx('pro');
      else if (unlocked.length) ctx.sfx('medal-gold');
    }
    if (reduced) finish();

    return {
      el,
      focus: () => again,
      update(dt) {
        shownAt += dt * 1000;
        if (!revealed && shownAt >= RESULTS_TUNING.buttonsDelayMs) {
          revealed = true;
          footer.classList.remove('is-waiting');
          ctx.refocus();
        }
        if (t === Infinity) return;
        t += dt * 1000;
        if (t < 0) return;
        const k = clamp01(t / RESULTS_TUNING.countMs);
        paint(1 - Math.pow(1 - k, 3));
        if (k > 0 && !el.classList.contains('is-counting')) { el.classList.add('is-counting'); ctx.sfx(delta >= 0 ? 'skill-up' : 'skill-down'); }
        if (k >= 1) { t = Infinity; finish(); }
      },
      back() { ctx.done({ action: 'menu' }); return true; },
    };
  },
};
