// Visitor counts for the public copy of the game (Vercel Web Analytics; user request 2026-11-10).
//
// Only in a build made for the deploy (VITE_VISITOR_COUNTS=1 at build time, README → "Deploying"), and only
// on a real host: never in development, the tests, `npm run preview` or a copy served from this computer.
// Vercel's own script then records one page view per visit on the game's own domain (/_vercel/insights/*):
// no cookies, no other host, nothing from the camera. The game is a single page (no navigation), so a page
// view is a visit. Vercel serves the script only while Web Analytics is on for the project.
// Pure module: nothing happens until startVisitorCounts() is called (src/main.js).

/** Vercel Web Analytics' script, on the game's own domain. */
export const VISITOR_COUNTS_SCRIPT = '/_vercel/insights/script.js';

/** This computer (local previews, test servers): never counted. */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$|\.localhost$/i;

/** Was this build made with VITE_VISITOR_COUNTS=1? (false in Node and in every other build) */
export function visitorCountsBuild() {
  try { return !!(import.meta.env && import.meta.env.VITE_VISITOR_COUNTS === '1'); } catch { return false; }
}

/** Does a page on `hostname` count visits? Only a deploy build on a real (not local) host. */
export function shouldCountVisits({ enabled, hostname }) {
  return !!enabled && typeof hostname === 'string' && hostname !== '' && !LOCAL_HOST.test(hostname);
}

/**
 * Start Vercel Web Analytics with its documented HTML snippet: a call queue (window.va / window.vaq) and the
 * deferred script. Idempotent.
 * @param {{enabled?: boolean, win?: any, doc?: any}} [o]  defaults: the build flag, window, document
 * @returns {boolean} whether this page counts visits
 */
export function startVisitorCounts({ enabled = visitorCountsBuild(), win = globalThis.window, doc = globalThis.document } = {}) {
  if (!win || !doc || !shouldCountVisits({ enabled, hostname: win.location && win.location.hostname })) return false;
  win.va = win.va || function va() { (win.vaq = win.vaq || []).push(arguments); };
  if (!doc.querySelector(`script[src="${VISITOR_COUNTS_SCRIPT}"]`)) {
    const s = doc.createElement('script');
    s.defer = true;
    s.src = VISITOR_COUNTS_SCRIPT;
    doc.head.appendChild(s);
  }
  return true;
}
