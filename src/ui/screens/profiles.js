// Who's boxing? Pick a local boxer, play as a guest, import a portable boxer, or make a new one
// (SET01). Local boxers can be edited (opens the profile editor as a sub-screen).
//   params: { title?: string, sub?: string, exclude?: string[]  (profile ids already taken, e.g. P1 in versus),
//             selectedId?: string, allowGuest?: boolean = true, allowImport?: boolean = true }
//   result: { action: 'select', profile: Profile } | { action: 'back' }
// SAV01/ERR04: shows a notice when this browser can't save progress.

import { h, button, icon, pageHeader, proBadge, formatNumber, chip, clear, isProRating, proThreshold } from './kit.js';

const PER_PAGE = 4;

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'profiles',
  title: 'Choose your boxer',
  create(ctx, params) {
    const storage = ctx.storage;
    const exclude = new Set(params.exclude || []);
    let page = 0;
    let importing = false;
    let focusId = params.selectedId || ctx.settings()?.lastProfileId || null;
    const root = h('div', { class: 'gu-page gu-profiles' });

    const list = () => {
      const local = storage?.listProfiles?.() || [];
      const visiting = (storage?.sessionProfiles?.() || []).filter((p) => p.kind === 'portable');
      return [...local, ...visiting].filter((p) => !exclude.has(p.id));
    };

    function select(profile) {
      if (!profile) return;
      if (profile.kind === 'local') storage?.saveSettings?.({ lastProfileId: profile.id });
      ctx.done({ action: 'select', profile });
    }

    // The editor's result is handled in refresh(): UI._done calls it (and then focuses inst.focus())
    // BEFORE this await resumes, so anything set after the await would come too late (FLOWS-06).
    function edit(profile) { return ctx.sub('profile-editor', { profile }); }
    function create() { return ctx.sub('profile-editor', {}); }

    /** After the editor closes: show and focus the boxer just saved (a new one may sit on another page). */
    function afterEditor(r) {
      if (r?.action === 'saved' && r.profile?.id) focusId = r.profile.id; // render() turns to its page
      else if (r?.action === 'deleted') { if (focusId === r.id) focusId = null; }
    }

    function guest() {
      const existing = (storage?.sessionProfiles?.() || []).find((p) => p.kind === 'guest' && !exclude.has(p.id));
      const g = existing || storage?.guest?.() || null;
      if (g) select(g);
      else ctx.toast('Couldn’t make a guest boxer.', { kind: 'error' });
    }

    function card(p) {
      const isLocal = p.kind === 'local';
      const pick = button({
        kind: 'card', size: 'xl', cls: 'gu-boxer-card__pick', ariaLabel: `Box as ${p.name}`, onClick: () => select(p),
        content: [
          ctx.portrait(p.appearance, { size: 176, label: p.name, cls: 'gu-boxer-card__portrait' }),
          h('span', { class: 'gu-boxer-card__name', text: p.name }),
          h('span', { class: 'gu-boxer-card__meta' },
            h('span', { text: `Rating ${formatNumber(p.skill || 0)}` }),
            isProRating(p.skill || 0, proThreshold(ctx.deps.peek('progression'))) ? proBadge() : null,
            !isLocal ? chip('Visiting', 'muted') : null),
        ],
      });
      pick.dataset.profileId = p.id;
      const kids = [pick];
      if (isLocal) kids.push(button({ label: 'Edit', icon: 'edit', kind: 'ghost', size: 'md', cls: 'gu-boxer-card__edit', ariaLabel: `Edit ${p.name}`, onClick: () => edit(p) }));
      else kids.push(h('p', { class: 'gu-boxer-card__note', text: 'Records not saved here' }));
      return h('div', { class: 'gu-boxer-card' }, kids);
    }

    function importPanel() {
      const area = h('textarea', { class: 'gu-input gu-import__text', rows: 5, placeholder: 'Paste a Glove Up boxer file here…', 'aria-label': 'Boxer file contents' });
      const file = h('input', { type: 'file', accept: '.json,application/json', class: 'gu-import__file', 'aria-label': 'Choose a boxer file' });
      const status = h('p', { class: 'gu-import__status', role: 'status' });
      const doImport = (text) => {
        const r = storage?.importPortable?.(text) || { ok: false, error: 'Importing isn’t available.' };
        if (!r.ok) {
          status.textContent = r.error;
          status.className = 'gu-import__status is-error';
          ctx.sfx('ui-deny');
          return;
        }
        importing = false;
        ctx.toast(`${r.profile.name} is visiting — records stay on their own device.`, { kind: 'good' });
        focusId = r.profile.id;
        render();
      };
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        try { doImport(await f.text()); } catch { status.textContent = 'Couldn’t read that file.'; status.className = 'gu-import__status is-error'; }
      });
      const chooseBtn = button({ label: 'Choose file…', icon: 'import', kind: 'secondary', size: 'md', onClick: () => file.click() });
      return h('div', { class: 'gu-panel gu-import' },
        h('h2', { class: 'gu-panel__title', text: 'Import a visiting boxer' }),
        h('p', { class: 'gu-panel__text', text: 'Bring a boxer from another device: choose the file they exported (Edit → Export), or paste its text. Visiting boxers play here but their records are not saved on this device.' }),
        area, file,
        h('div', { class: 'gu-row' },
          chooseBtn,
          button({ label: 'Import pasted text', icon: 'check', kind: 'primary', size: 'md', onClick: () => doImport(area.value.trim()) }),
          button({ label: 'Cancel', kind: 'ghost', size: 'md', sfx: 'ui-back', onClick: () => { importing = false; render(); } })),
        status);
    }

    function render() {
      clear(root);
      root.appendChild(pageHeader({ title: params.title || 'Who’s boxing?', sub: params.sub || null, onBack: () => ctx.ui.back() }));
      const st = storage?.status?.();
      if (st && (!st.available || !st.writable)) {
        root.appendChild(h('p', { class: 'gu-notice gu-notice--warn', role: 'status' }, icon('eyeoff'),
          'This browser isn’t saving progress right now (private browsing, blocked site data or full storage). You can still play — records just won’t be kept.'));
      } else if (st?.issues?.length) {
        root.appendChild(h('p', { class: 'gu-notice gu-notice--warn', role: 'status' }, icon('help'), 'Some saved data was damaged and has been set aside. Everything else loaded fine.'));
      }
      if (importing) {
        root.appendChild(importPanel());
        return;
      }
      const all = list();
      const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
      if (focusId) {
        const i = all.findIndex((p) => p.id === focusId);
        if (i >= 0) page = Math.floor(i / PER_PAGE);
      }
      page = Math.min(page, pages - 1);
      const shown = all.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
      const grid = h('div', { class: 'gu-profiles__grid' });
      if (pages > 1) grid.appendChild(button({ icon: 'back', kind: 'ghost', size: 'md', cls: 'gu-pager', ariaLabel: 'Previous boxers', disabled: page === 0, sfx: 'ui-move', onClick: () => { page--; focusId = null; render(); ctx.refocus(); } }));
      for (const p of shown) grid.appendChild(card(p));
      if (!all.length) {
        // with exclusions (e.g. picking P2 while P1 is taken) other boxers may exist — say "other"
        const others = exclude.size > 0;
        grid.appendChild(h('div', { class: 'gu-empty' },
          h('p', { class: 'gu-empty__title', text: others ? 'No other boxers yet' : 'No boxers yet' }),
          h('p', { class: 'gu-empty__text', text: others ? 'Make a new boxer for this corner — or jump in as a guest.' : 'Make a boxer to keep your rating, wins and medals — or jump in as a guest.' })));
      }
      if (pages > 1) grid.appendChild(button({ icon: 'next', kind: 'ghost', size: 'md', cls: 'gu-pager', ariaLabel: 'More boxers', disabled: page >= pages - 1, sfx: 'ui-move', onClick: () => { page++; focusId = null; render(); ctx.refocus(); } }));
      root.appendChild(grid);
      if (pages > 1) root.appendChild(h('p', { class: 'gu-pager__label', text: `Page ${page + 1} of ${pages}` }));
      const actions = [
        button({ label: 'New boxer', icon: 'plus', kind: all.length ? 'secondary' : 'primary', size: 'lg', onClick: create }),
      ];
      if (params.allowGuest !== false) actions.push(button({ label: 'Play as guest', sub: 'Nothing is saved', icon: 'guest', kind: 'secondary', size: 'lg', onClick: guest }));
      if (params.allowImport !== false) actions.push(button({ label: 'Import boxer', sub: 'From another device', icon: 'import', kind: 'secondary', size: 'lg', onClick: () => { importing = true; render(); ctx.refocus(); } }));
      root.appendChild(h('div', { class: 'gu-profiles__actions' }, actions));
    }

    render();
    // FLOWS-04: a boxer made, renamed or deleted in another tab of the game shows up here at once
    const unsubscribe = storage?.subscribe?.(() => {
      if (importing || !root.isConnected) return;
      render();
      ctx.refocus(); // only takes effect while this screen is on top
    }) || null;
    return {
      el: root,
      refresh(result) { afterEditor(result); render(); },
      destroy() { unsubscribe?.(); },
      back() {
        if (importing) { importing = false; render(); ctx.refocus(); return true; }
        return false;
      },
      focus() {
        if (focusId) {
          const el = root.querySelector(`[data-profile-id="${CSS.escape(focusId)}"]`);
          if (el) return el;
        }
        return root.querySelector('.gu-boxer-card__pick') || root.querySelector('.gu-profiles__actions .gu-btn');
      },
    };
  },
};
