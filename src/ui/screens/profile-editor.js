// Make or edit a boxer: name + appearance over APPEARANCE_OPTIONS with a live portrait
// (3D BoxerModel when available, 2D drawing otherwise), presets and a randomizer (SET01).
// Special glove colours (progression.GLOVE_UNLOCKS, research/mechanics.md §7.4–7.5) stay locked —
// with the rating they need shown — until the boxer's best rating reaches their milestone.
//   params: { profile?: Profile }   (omit to create a new local boxer)
//   result: { action: 'saved', profile, save: SaveResult } | { action: 'deleted', id } | { action: 'back' }
// ERR04: a failed save still returns the profile for this session and says it wasn't saved.

import { APPEARANCE_OPTIONS } from '../../core/types.js';
import { saveNotice, clampName, sanitizeName } from '../../core/storage.js';
import {
  h, button, icon, cycler, segmented, slider, tabs, pageHeader, optionLabel, SWATCHES, validLook, defaultLook,
  randomLook, presetLooks, randomName, downloadText, fileSafe, clear, gloveSwatches, formatNumber,
} from './kit.js';

/**
 * FLOWS-07: the confirming press of the two-step Delete must come at least this long after it armed.
 * A double-click's second press lands ~100–300 ms after the first and must not erase a boxer.
 */
export const DELETE_CONFIRM_MIN_MS = 600;
/** How long Delete stays armed ("Tap again to delete") after the first press. */
export const DELETE_ARMED_MS = 3000;

const KIT_PARTS = [
  { id: 'top', label: 'Top', swatches: 'cloth', allowNone: true },
  { id: 'trunks', label: 'Trunks', swatches: 'cloth' },
  { id: 'trim', label: 'Waistband', swatches: 'trim' },
  { id: 'gloves', label: 'Gloves', swatches: 'gloves' },
  { id: 'shoes', label: 'Shoes', swatches: 'shoes' },
];

/** @type {import('../ui.js').ScreenDef} */
export default {
  id: 'profile-editor',
  title: 'Boxer editor',
  create(ctx, params) {
    const storage = ctx.storage;
    const existing = params.profile || null;
    const isNew = !existing;
    let look = validLook(existing?.appearance || defaultLook());
    let name = existing?.name || '';
    let dirty = false;
    let kitPart = 'top';
    let confirmDelete = -Infinity;
    let confirmLeave = -Infinity;
    let seed = (Date.now() % 100000) | 0;

    const portrait = ctx.portrait(look, { size: 304, live: true, cls: 'gu-editor__portrait gu-portrait--live', framing: 'bust', label: 'Your boxer' });
    // FLOWS-11: no maxlength — it counts UTF-16 units and cuts an emoji sequence in half. The limit
    // (16 user-perceived characters, storage's clampName) is kept here instead, after any IME composition.
    const nameInput = h('input', {
      class: 'gu-input gu-editor__name', type: 'text', value: name, placeholder: 'Boxer name',
      'aria-label': 'Boxer name', autocomplete: 'off', spellcheck: 'false',
    });
    const keepName = () => {
      const v = nameInput.value;
      const kept = clampName(v);
      if (kept !== v) {
        const caret = Math.min(nameInput.selectionStart ?? kept.length, kept.length);
        nameInput.value = kept;
        try { nameInput.setSelectionRange(caret, caret); } catch { /* not focused */ }
      }
      name = nameInput.value;
      dirty = true;
    };
    nameInput.addEventListener('input', (e) => {
      if (e.isComposing) { name = nameInput.value; dirty = true; return; }
      keepName();
    });
    nameInput.addEventListener('compositionend', keepName);

    // ── glove unlocks (feature-detected: no progression module → every colour is open) ──
    const ownGloves = String(existing?.appearance?.gloves || '').toLowerCase();
    const gloveList = () => {
      const prog = ctx.deps.peek('progression');
      let best = Number(existing?.skill) || 0;
      try { if (typeof prog?.bestRatingOf === 'function') best = prog.bestRatingOf(existing || 0); } catch { /* keep the plain rating */ }
      const isAllowed = typeof prog?.isGloveColorAllowed === 'function' ? (c) => prog.isGloveColorAllowed(existing || 0, c) : null;
      return gloveSwatches({ base: SWATCHES.gloves, unlocks: prog?.GLOVE_UNLOCKS || [], best, isAllowed })
        .map((g) => ({ ...g, locked: g.locked && g.color !== ownGloves })); // never take away what the boxer already wears
    };
    const gloveLocked = (c) => !!gloveList().find((g) => g.color === String(c || '').toLowerCase())?.locked;

    function set(patch) {
      let next = validLook({ ...look, ...patch, hair: { ...look.hair, ...(patch.hair || {}) } });
      if (gloveLocked(next.gloves)) next = { ...next, gloves: look.gloves }; // presets / randomize never hand out locked gloves
      look = next;
      dirty = true;
      portrait.setLook(look);
    }

    function swatchGrid(colors, current, onPick, { allowNone = false, label = '' } = {}) {
      const grid = h('div', { class: 'gu-swatches', role: 'radiogroup', 'aria-label': label });
      const items = allowNone ? ['none', ...colors] : colors;
      for (const c of items) {
        const isNone = c === 'none';
        const b = button({
          kind: 'swatch', size: 'md', cls: `gu-swatch${isNone ? ' gu-swatch--none' : ''}`, ariaLabel: isNone ? 'No top' : `Colour ${c}`,
          sfx: 'ui-move', onClick: () => { onPick(c); for (const x of grid.children) x.classList.toggle('is-selected', x.__c === c); },
          content: isNone ? [h('span', { class: 'gu-swatch__none', text: 'None' })] : [],
        });
        b.__c = c;
        if (!isNone) b.style.setProperty('--swatch', c);
        b.setAttribute('role', 'radio');
        if (c === current) b.classList.add('is-selected');
        grid.appendChild(b);
      }
      return grid;
    }

    function row(label, control) {
      return h('div', { class: 'gu-field' }, h('span', { class: 'gu-field__label', text: label }), control);
    }

    function buildLooks() {
      const presets = presetLooks();
      const grid = h('div', { class: 'gu-presets' });
      for (const p of presets) {
        grid.appendChild(button({
          kind: 'card', size: 'md', cls: 'gu-preset', ariaLabel: `Look: ${p.label}`,
          onClick: () => set(p.look),
          content: [ctx.portrait(p.look, { size: 72, framing: 'head', gloves: false, cls: 'gu-preset__portrait' }), h('span', { class: 'gu-preset__label', text: p.label })],
        }));
      }
      if (!presets.length) grid.appendChild(h('p', { class: 'gu-panel__text', text: 'Use Randomize or the tabs to build your look.' }));
      return h('div', { class: 'gu-editor__tab' }, grid);
    }

    function buildFace() {
      const O = APPEARANCE_OPTIONS;
      return h('div', { class: 'gu-editor__tab gu-editor__grid2' },
        cycler({ label: 'Eyes', values: O.eyes, value: look.eyes, onChange: (v) => set({ eyes: v }) }),
        cycler({ label: 'Brows', values: O.brows, value: look.brows, onChange: (v) => set({ brows: v }) }),
        cycler({ label: 'Nose', values: O.noses, value: look.nose, onChange: (v) => set({ nose: v }) }),
        cycler({ label: 'Mouth', values: O.mouths, value: look.mouth, onChange: (v) => set({ mouth: v }) }));
    }

    function buildHair() {
      return h('div', { class: 'gu-editor__tab' },
        cycler({ label: 'Hair style', values: APPEARANCE_OPTIONS.hairStyles, value: look.hair.style, onChange: (v) => set({ hair: { style: v } }) }),
        row('Hair colour', swatchGrid(SWATCHES.hair, look.hair.color, (c) => set({ hair: { color: c } }), { label: 'Hair colour' })));
    }

    function buildBody() {
      return h('div', { class: 'gu-editor__tab' },
        row('Skin tone', swatchGrid(SWATCHES.skin, look.skin, (c) => set({ skin: c }), { label: 'Skin tone' })),
        row('Build', segmented({ label: 'Build', value: look.build, onChange: (v) => set({ build: v }), options: APPEARANCE_OPTIONS.builds.map((b) => ({ value: b, label: optionLabel(b) })) })),
        row('Height', slider({ label: 'Height', value: look.height, min: 0.9, max: 1.1, step: 0.02, format: (v) => (v < 0.96 ? 'Short' : v > 1.04 ? 'Tall' : 'Medium'), onChange: (v) => set({ height: v }) })));
    }

    function gloveGrid() {
      const list = gloveList();
      const grid = h('div', { class: 'gu-swatches gu-swatches--gloves', role: 'radiogroup', 'aria-label': 'Gloves' });
      const current = String(look.gloves || '').toLowerCase();
      for (const g of list) {
        const at = Number.isFinite(g.at) ? formatNumber(g.at) : null;
        const b = button({
          kind: 'swatch', size: 'md', cls: `gu-swatch${g.locked ? ' is-locked' : ''}${g.at !== null ? ' is-special' : ''}`,
          ariaLabel: g.locked ? `${g.name || 'Special gloves'}: unlock at rating ${at || '—'}` : `${g.name ? `${g.name} ` : ''}gloves ${g.color}`,
          sfx: g.locked ? 'ui-deny' : 'ui-move',
          onClick: () => {
            if (g.locked) { ctx.toast(`${g.name || 'These gloves'} unlock at rating ${at || '—'}. Keep winning!`, { kind: 'info' }); return; }
            set({ gloves: g.color });
            for (const x of grid.children) x.classList.toggle('is-selected', x.__c === g.color);
          },
          content: g.locked ? [h('span', { class: 'gu-swatch__lock' }, icon('lock'), at ? h('b', { text: at }) : null)]
            : g.at !== null ? [h('span', { class: 'gu-swatch__star', 'aria-hidden': 'true' }, icon('star'))] : [],
        });
        b.__c = g.color;
        b.style.setProperty('--swatch', g.color);
        b.setAttribute('role', 'radio');
        if (g.color === current) b.classList.add('is-selected');
        grid.appendChild(b);
      }
      const milestones = [...new Set(list.filter((g) => g.locked && Number.isFinite(g.at)).map((g) => g.at))].sort((a, b) => a - b);
      const note = milestones.length
        ? h('p', { class: 'gu-editor__unlocknote' }, icon('lock'), h('span', { text: `Special gloves unlock at rating ${milestones.map(formatNumber).join(' and ')}.` }))
        : null;
      return h('div', null, grid, note);
    }

    function buildKit() {
      const host = h('div', { class: 'gu-editor__kitgrid' });
      const renderGrid = () => {
        clear(host);
        const part = KIT_PARTS.find((p) => p.id === kitPart) || KIT_PARTS[0];
        if (part.id === 'gloves') {
          host.appendChild(gloveGrid());
          // the progression module may still be loading (lazy deps): redraw once it arrives
          if (!ctx.deps.peek('progression')) ctx.deps.load('progression').then((m) => { if (m && kitPart === 'gloves' && host.isConnected) renderGrid(); });
        } else host.appendChild(swatchGrid(SWATCHES[part.swatches], look[part.id], (c) => set({ [part.id]: c }), { allowNone: !!part.allowNone, label: part.label }));
      };
      const seg = segmented({ label: 'Kit part', value: kitPart, options: KIT_PARTS.map((p) => ({ value: p.id, label: p.label })), onChange: (v) => { kitPart = v; renderGrid(); } });
      renderGrid();
      return h('div', { class: 'gu-editor__tab' }, seg, host);
    }

    function buildExtras() {
      const grid = h('div', { class: 'gu-options', role: 'radiogroup', 'aria-label': 'Extra' });
      for (const acc of APPEARANCE_OPTIONS.accessories) {
        const b = button({
          label: optionLabel(acc), kind: 'ghost', size: 'md', cls: 'gu-option', sfx: 'ui-move',
          onClick: () => { set({ accessory: acc }); for (const x of grid.children) x.classList.toggle('is-selected', x.__v === acc); },
        });
        b.__v = acc;
        b.setAttribute('role', 'radio');
        if (acc === look.accessory) b.classList.add('is-selected');
        grid.appendChild(b);
      }
      return h('div', { class: 'gu-editor__tab' }, grid);
    }

    const tabStrip = tabs({
      value: 'looks',
      tabs: [
        { id: 'looks', label: 'Looks', icon: 'sparkle', build: buildLooks },
        { id: 'face', label: 'Face', build: buildFace },
        { id: 'hair', label: 'Hair', build: buildHair },
        { id: 'body', label: 'Body', build: buildBody },
        { id: 'kit', label: 'Kit', build: buildKit },
        { id: 'extras', label: 'Extras', build: buildExtras },
      ],
    });

    function save() {
      // nothing visible typed (only spaces or joiners) → a random name, as for an empty field
      const finalName = sanitizeName(clampName(nameInput.value || ''), '') || randomName(seed);
      let res;
      if (isNew) res = storage?.createProfile?.({ name: finalName, appearance: look });
      else res = storage?.updateProfile?.(existing.id, { name: finalName, appearance: look });
      if (!res) { ctx.toast('Saving isn’t available.', { kind: 'error' }); return; }
      if (!res.ok) { ctx.toast(res.error || 'Couldn’t save that boxer.', { kind: 'error' }); return; }
      if (!res.saved && res.profile?.kind === 'local') ctx.toast(saveNotice(res), { kind: 'warn', ms: 5200 });
      dirty = false;
      ctx.done({ action: 'saved', profile: res.profile || storage.getProfile?.(existing?.id), save: res });
    }

    function del() {
      const now = performance.now();
      if (now - confirmDelete > DELETE_ARMED_MS) {
        confirmDelete = now;
        delBtn.querySelector('.gu-btn__label').textContent = 'Tap again to delete';
        delBtn.classList.add('is-armed');
        setTimeout(() => {
          if (performance.now() - confirmDelete >= DELETE_ARMED_MS - 100 && delBtn.isConnected) {
            delBtn.querySelector('.gu-btn__label').textContent = 'Delete';
            delBtn.classList.remove('is-armed');
          }
        }, DELETE_ARMED_MS);
        return;
      }
      // FLOWS-07: too soon after arming — the second press of a double-click (or a bounce), not a
      // decision. Stay armed; only a press after "Tap again to delete" has been seen deletes.
      if (now - confirmDelete < DELETE_CONFIRM_MIN_MS) return;
      const r = storage?.deleteProfile?.(existing.id);
      if (!r?.ok) { ctx.toast(r?.error || 'Couldn’t delete that boxer.', { kind: 'error' }); return; }
      if (!r.saved && existing.kind === 'local') ctx.toast(saveNotice(r) || 'Deleted for now, but this browser could not update its saved data.', { kind: 'warn' });
      else ctx.toast(`${existing.name} and all their records were deleted.`);
      ctx.done({ action: 'deleted', id: existing.id });
    }

    function exportFile() {
      const json = storage?.exportProfile?.(existing.id);
      if (!json) { ctx.toast('Couldn’t export that boxer.', { kind: 'error' }); return; }
      const ok = downloadText(`glove-up-${fileSafe(existing.name)}.json`, json);
      try { navigator.clipboard?.writeText?.(json).catch(() => {}); } catch { /* clipboard is optional */ }
      ctx.toast(ok ? 'Boxer file saved to your downloads (and copied). Import it on another device to visit.' : 'Your browser blocked the download — the boxer was copied instead.', { kind: ok ? 'good' : 'warn', ms: 5200 });
    }

    const delBtn = !isNew && existing.kind === 'local' ? button({ label: 'Delete', icon: 'trash', kind: 'danger', size: 'md', onClick: del }) : null;
    const exportBtn = !isNew ? button({ label: 'Export', icon: 'export', kind: 'ghost', size: 'md', onClick: exportFile }) : null;
    const saveBtn = button({ label: isNew ? 'Create boxer' : 'Save', icon: 'check', kind: 'primary', size: 'lg', onClick: save });

    const left = h('div', { class: 'gu-editor__left' },
      h('div', { class: 'gu-editor__stage' }, portrait),
      h('div', { class: 'gu-field gu-field--name' }, h('span', { class: 'gu-field__label', text: 'Name' }),
        h('div', { class: 'gu-editor__namerow' }, nameInput,
          button({ icon: 'dice', kind: 'ghost', size: 'md', ariaLabel: 'Pick a random name', cls: 'gu-editor__namedice', onClick: () => { seed++; name = randomName(seed, [name]); nameInput.value = name; dirty = true; } }))),
      button({ label: 'Randomize look', icon: 'dice', kind: 'secondary', size: 'md', cls: 'gu-editor__rand', onClick: () => { seed++; set(randomLook(`look-${seed}-${Date.now()}`)); tabStrip.select(tabStrip.current()); } }));

    const root = h('div', { class: 'gu-page gu-editor' },
      pageHeader({ title: isNew ? 'New boxer' : `Edit ${existing.name}`, onBack: () => ctx.ui.back(), backLabel: 'Cancel' }),
      h('div', { class: 'gu-editor__body' }, left, h('div', { class: 'gu-panel gu-editor__right' }, tabStrip)),
      h('div', { class: 'gu-footer' }, delBtn, exportBtn, h('span', { class: 'gu-footer__spacer' }), saveBtn));

    return {
      el: root,
      focus: () => (isNew ? nameInput : saveBtn),
      back() {
        if (!dirty) return false;
        const now = performance.now();
        if (now - confirmLeave < 3000) return false;
        confirmLeave = now;
        ctx.toast('Unsaved changes — press Back again to discard them.', { kind: 'warn' });
        return true;
      },
    };
  },
};
