// Glove Up — bootstrap. Creates the App (src/app/app.js), which builds every module and runs the
// game. If something essential cannot start (no WebGL, a broken build), a readable message is
// shown instead of a blank page.
//
// URL parameters (ARCHITECTURE.md §4): ?input=keyboard|camera|replay|synthetic  ?debug=1  ?fast=1
// ?seed=123  ?video=/dev/clips/x.mp4 (clip as camera)  ?rec=/rec.json (with input=replay)
// ?calibrate=1  ?skip=<screen>  ?tutorial=0|1.  window.__glove exposes {app, bus, input, injectPose,
// state, skipTo, skipOutro, skipTutorial, …}. Visitor counts run only in the public deploy's build
// (src/app/visitor-counts.js).

import { App, parseParams } from './app/app.js';
import { startVisitorCounts } from './app/visitor-counts.js';
import { hideSplash, SPLASH } from './app/splash.js';

window.__gloveMain = true; // the game's code runs (index.html's fallback message checks this)

function showFatal(err) {
  hideSplash(); // never leave the loading screen over the error
  console.error('[glove-up] could not start', err);
  const root = document.getElementById('ui') || document.body;
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  Object.assign(box.style, {
    position: 'fixed', inset: '0', display: 'grid', placeItems: 'center', pointerEvents: 'auto',
    background: 'radial-gradient(ellipse at 50% 40%, #2d3a66 0%, #1b2340 70%)', color: '#fffaf0',
    font: '600 18px/1.45 Nunito, system-ui, sans-serif', padding: '24px', textAlign: 'center',
  });
  const card = document.createElement('div');
  Object.assign(card.style, { maxWidth: '560px', background: 'rgba(20,24,43,0.85)', border: '3px solid #fffaf0', borderRadius: '24px', padding: '28px 32px' });
  const h = document.createElement('h1');
  h.textContent = 'Glove Up can’t start';
  Object.assign(h.style, { font: '32px/1.1 "Lilita One", system-ui, sans-serif', margin: '0 0 12px', color: '#ffc94a' });
  const p = document.createElement('p');
  p.textContent = String(err?.message || err || 'Unknown error');
  p.style.margin = '0 0 18px';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  Object.assign(btn.style, { font: '20px "Lilita One", system-ui, sans-serif', padding: '10px 28px', borderRadius: '999px', border: '3px solid #14182b', background: '#ff6b5a', color: '#14182b', cursor: 'pointer' });
  btn.addEventListener('click', () => location.reload());
  card.append(h, p, btn);
  box.appendChild(card);
  root.appendChild(box);
}

const params = parseParams(location.search);
setTimeout(() => hideSplash(), SPLASH.safetyMs); // the loading screen can never hide the page for good
try { startVisitorCounts(); } catch (e) { console.warn('[glove-up] visitor counts unavailable', e); }
// Start one frame later, so the loading screen is painted first: on a repeat visit (code in the cache) this module
// can run before the browser's first paint, and the start-up work would hold the loading screen back.
const start = () => {
  try {
    const app = new App({ params });
    app.boot().catch(showFatal);
  } catch (e) {
    showFatal(e);
  }
};
if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(() => setTimeout(start, 0));
else start();
