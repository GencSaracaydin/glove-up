// 'skill' is the results card's original screen id, kept so existing flows keep working — see results.js.
//   params / result: as results.js ({ before, after, … } → { action: 'next' (Play again) | 'menu' (Quit) })

import results, { RESULTS_TUNING } from './results.js';

export { RESULTS_TUNING as SKILL_TUNING };

/** @type {import('../ui.js').ScreenDef} */
export default Object.freeze({ ...results, id: 'skill' });
