#!/usr/bin/env node
/**
 * The street-name label at landmarks: walks the player (teleports, loopback transport) to the edge of a few heroes and
 * shoots the lower left of the screen with the label: `.shots/landmark-name-<id>.png`. The text of the label is printed too.
 *
 *   node scripts/landmark-names.mjs [--url http://127.0.0.1:5193/] [--only westin-peachtree-plaza,georgia-state-capitol]
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []));
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5193/';
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : new Set(['westin-peachtree-plaza', 'georgia-state-capitol', 'georgia-aquarium', 'state-farm-arena']);
const lms = JSON.parse(readFileSync('public/tiles/atlanta/m1-five-points/landmarks.json', 'utf8')).landmarks.filter((l) => only.has(l.id));
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto(`${base}?graphics=high&time=14:00&timescale=0&traffic=0&transport=loopback&ambient=0`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
await page.keyboard.press('KeyH');
for (const l of lms) {
  // a point on the sidewalk side of the footprint: the nearest edge point to the south-east of the centre
  const ring = l.ring ?? [];
  let best = [l.x, l.z];
  let bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const d = Math.hypot(mx - l.x, mz - l.z);
    if (d < bd) { bd = d; best = [mx + (mx - l.x) / d * 6, mz + (mz - l.z) / d * 6]; }
  }
  await page.evaluate(([x, z]) => {
    const s = window.__hood.game.transport.host.simulation;
    s.registry.get(s.playerPedId).controller.teleport(x, s.groundAt(x, z) + 0.3, z);
  }, best);
  await page.waitForTimeout(2200);
  const text = await page.evaluate(() => document.querySelector('.hud-street')?.innerText ?? '(no label)');
  console.log('  at', JSON.stringify(await page.evaluate(() => { const c = window.__hood.game.view.controlled; return c ? [Math.round(c.x), Math.round(c.z)] : null; })), 'target', best.map(Math.round));
  console.log(l.id, '->', JSON.stringify(text));
  await page.screenshot({ path: `.shots/landmark-name-${l.id}.png`, clip: { x: 0, y: 500, width: 640, height: 220 } });
}
await browser.close();
