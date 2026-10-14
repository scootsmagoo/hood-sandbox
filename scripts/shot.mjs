#!/usr/bin/env node
/**
 * Boots the game in headless Chromium, runs scripted input, and saves screenshots to .shots/.
 *
 *   node scripts/shot.mjs [--url http://127.0.0.1:5180/] [--query "start=car&debug"] [--steps '<json>'] [--size 1280x720]
 *
 * Steps: {"wait":ms} {"hold":"KeyW","ms":1500} {"press":"KeyE"} {"down":"KeyW"} {"up":"KeyW"}
 *        {"eval":"expression"} {"shot":"name.png"}
 * Prints console errors and a few frame stats. Without --url it expects `npm run dev` on port 5180.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const query = typeof args.query === 'string' ? args.query : '';
const [w, h] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);
const steps = typeof args.steps === 'string' ? JSON.parse(args.steps) : [{ wait: 1500 }, { shot: 'boot.png' }];
mkdirSync('.shots', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});
const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
await page.goto(`${base}${query ? `?${query}` : ''}`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
const err = await page.evaluate(() => window.__hood.error);
if (err) { console.log('BOOT ERROR', err); }
await page.keyboard.press('Shift'); // a gesture, so the key sink and focus settle
for (const s of steps) {
  if (s.wait) await page.waitForTimeout(s.wait);
  else if (s.hold) { await page.keyboard.down(s.hold); await page.waitForTimeout(s.ms ?? 500); await page.keyboard.up(s.hold); }
  else if (s.press) { await page.keyboard.down(s.press); await page.waitForTimeout(s.ms ?? 80); await page.keyboard.up(s.press); }
  else if (s.down) await page.keyboard.down(s.down);
  else if (s.up) await page.keyboard.up(s.up);
  else if (s.eval) console.log('eval', s.eval.slice(0, 60), '=>', JSON.stringify(await page.evaluate(s.eval)));
  else if (s.shot) { await page.screenshot({ path: `.shots/${s.shot}` }); console.log('shot', `.shots/${s.shot}`); }
}
const stats = await page.evaluate(() => {
  const g = window.__hood?.game;
  return g ? { fps: Math.round(g.fps), isolated: crossOriginIsolated, transport: g.transport.kind, shared: g.transport.shared, tile: g.ready.tileSource, calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, tier: g.tier.name, gpu: g.gpuName } : null;
});
console.log('stats', JSON.stringify(stats));
console.log(errors.length ? `console problems:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
process.exit(err || errors.some((e) => e.startsWith('pageerror') || e.startsWith('error')) ? 1 : 0);
