#!/usr/bin/env node
/**
 * Screenshots of the 911 cues into .shots/: the dialling marker over a witness who is calling, and the stars with
 * the "911, police notified" tag when the call goes through. A carjack on the procedural ground with three bystanders
 * ahead of the player (the sim runs on the main thread so the script can place them; everything the player does is a
 * real key press).
 *
 *   node scripts/call-shots.mjs [--url http://127.0.0.1:5180/]
 *
 * Writes: law-dialling.png, law-call-cue.png, law-call-cue-stars.png (the top right corner, enlarged),
 * law-call-stopped.png (a caller knocked down: the marker flashes red).
 */
import { createServer as createNetServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
let server = null;
let base = typeof args.url === 'string' ? args.url : null;
if (!base) {
  const { createServer } = await import('vite');
  const port = await new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  server = await createServer({ root, logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
  await server.listen();
  base = `http://127.0.0.1:${port}/`;
}
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
await page.goto(`${base}?tile=none&graphics=low&transport=loopback&ambient=0&driver=flee&parked=0&start=jack`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
await page.keyboard.press('Shift');
await page.keyboard.press('KeyH'); // help panel off
await page.waitForTimeout(800);
const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
const shot = async (name, clip, scale) => { await page.screenshot({ path: `.shots/${name}`, ...(clip ? { clip } : {}), ...(scale ? { scale: 'device' } : {}) }); console.log('shot', `.shots/${name}`); };

await page.evaluate(() => {
  window.__events = [];
  window.__hood.game.onSimEvent((e) => window.__events.push(e));
});
// Three bystanders in the open, ahead of where the camera looks; every one of them calls (the chance is data: this makes the shot repeatable).
const ids = await sim((S) => {
  const g = window.__hood.game;
  S.law.rules.callChance = S.law.rules.heardCallChance = S.law.rules.victimCallChance = 1;
  S.law.rules.callDelayS = [9, 9];
  const me = S.playerPosition();
  const yaw = g.cameraRig.yaw;
  const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const l = { x: -f.z, z: f.x };
  const out = [];
  for (const [d, side, outfit] of [[11, -3.5, 1], [15, 2.5, 3], [19, -1, 2]]) {
    const x = me.x + f.x * d + l.x * side;
    const z = me.z + f.z * d + l.z * side;
    const n = S.addPed(x, S.groundAt(x, z), z, Math.atan2(-f.x, -f.z), outfit, true);
    n.brain.enter('idle');
    out.push(n.id);
  }
  return out;
});
await page.waitForTimeout(500);
await page.keyboard.down('KeyE');
await page.waitForTimeout(100);
await page.keyboard.up('KeyE');
// Camera behind the player, looking toward the bystanders.
await page.waitForFunction(() => window.__events.some((e) => e.type === 'crime'), null, { timeout: 10000 });
await page.waitForTimeout(3000);
const dial = await page.evaluate(() => [...document.querySelectorAll('.law-dial:not(.off)')].length);
console.log('dialling markers on screen', dial);
await shot('law-dialling.png');

// A caller is knocked down: the marker flashes red as the call is cut.
await sim(async (S, ids) => {
  const { knockDown } = await import('/src/sim/combat/damage.ts');
  knockDown(S, S.registry.get(ids[0]), 5);
}, ids).catch(() => {});
await page.waitForTimeout(250);
await shot('law-call-stopped.png');

await page.waitForFunction(() => window.__events.some((e) => e.type === 'crime:reported' && !e.police && !e.duplicate), null, { timeout: 30000 });
await page.waitForTimeout(450);
await shot('law-call-cue.png');
await shot('law-call-cue-stars.png', { x: 1000, y: 0, width: 280, height: 110 });
console.log('events', JSON.stringify(await page.evaluate(() => window.__events.filter((e) => /^(crime|witness|heat)/.test(e.type)).map((e) => e.type + (e.reason ? ':' + e.reason : '') + (e.duplicate ? ':dup' : '')))));
await browser.close();
if (server) await server.close();
