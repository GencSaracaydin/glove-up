// 'opponent' is the VS card's original screen id, kept so existing flows keep working — see vs.js.
//   params / result: as vs.js ({ opponent, profile, bout? } → { action: 'start' | 'back' })

import vs from './vs.js';

/** @type {import('../ui.js').ScreenDef} */
export default Object.freeze({ ...vs, id: 'opponent' });
