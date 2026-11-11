// Headless screenshot helper for visual checks (WebGL via SwiftShader).
//   node scripts/shot.mjs <url> <out.png> [--wait 2500] [--w 1280] [--h 720] [--eval "js expr"] [--clicks "sel1,sel2"] [--keys "KeyJ,KeyK"]
// Prints browser console errors/warnings and page errors to stdout so you can fix them.
// Start a dev server first, e.g.:  npx vite --host 127.0.0.1 --port 5181 --strictPort
import { chromium } from 'playwright';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node scripts/shot.mjs <url> <out.png> [--wait ms] [--w px] [--h px] [--eval js] [--keys codes]'); process.exit(2); }
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const wait = Number(opt.wait ?? 2500), w = Number(opt.w ?? 1280), h = Number(opt.h ?? 720);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
}).catch((e) => {
  if (/Executable doesn't exist|playwright install/i.test(String(e?.message))) {
    console.error('shot: Playwright has no Chromium yet. Run "npx playwright install chromium" once (README, Setup).');
    process.exit(1);
  }
  throw e;
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', (m) => {
  if (!['error', 'warning'].includes(m.type())) return;
  if (/GPU stall due to ReadPixels|GL Driver Message/.test(m.text())) return; // SwiftShader noise
  console.log(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(url, { waitUntil: 'load' });
// the game starts one frame after its code runs (src/main.js paints the loading screen first): wait for it
await page.waitForFunction(() => !!window.__glove?.state, null, { timeout: 30000 }).catch(() => {});
if (opt.clicks) for (const sel of opt.clicks.split(',')) { await page.click(sel); await page.waitForTimeout(300); }
if (opt.keys) for (const k of opt.keys.split(',')) { await page.keyboard.press(k); await page.waitForTimeout(120); }
if (opt.eval) console.log('[eval]', JSON.stringify(await page.evaluate(opt.eval)));
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
