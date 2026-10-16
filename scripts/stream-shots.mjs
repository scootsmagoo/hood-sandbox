#!/usr/bin/env node
/**
 * Screenshots of a streamed city (docs/contracts/city-tiles.md) into .shots/: fixed camera views, with the client's rings centred
 * where the camera looks so the tiles there are drawn, waiting until the stream has settled.
 *
 *   node scripts/stream-shots.mjs [--url http://127.0.0.1:5180/] [--tiles fixture:3] [--query "graphics=high"]
 *        [--views '[{"name":"aerial","eye":[0,900,600],"look":[0,0,0],"fov":50,"centre":[0,0],"near":1600,"far":4500}]']
 *        [--prefix stream] [--size 1600x900]
 *
 * A view may also be {"name":"drive","drive":{"ms":8000}}: get in the car and hold W, then shoot from the chase camera.
 * Without --url it starts its own Vite server.
 */
import { mkdirSync } from 'node:fs';
import { boot, launch, openProfile, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const tiles = String(args.tiles ?? 'fixture:3');
const prefix = String(args.prefix ?? 'stream');
const views = args.views ? JSON.parse(String(args.views)) : [
  { name: 'aerial', eye: [192, 1300, 1200], look: [192, 0, 192], fov: 50, centre: [192, 192], near: 1700, far: 5000 },
  { name: 'street', eye: [150, 4, 112], look: [600, 2, 96], fov: 60 },
];
mkdirSync('.shots', { recursive: true });
const server = await startServer(args);
const browser = await launch({});
const errors = [];
for (const v of views) {
  const { page, errors: errs } = await openProfile(browser, String(args.profile ?? 'desktop-high'), args);
  await boot(page, server.base, `tiles=${encodeURIComponent(tiles)}&start=car&timescale=0${args.query ? `&${args.query}` : ''}`);
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH');
  if (v.drive) {
    await page.keyboard.down('KeyE'); await page.waitForTimeout(120); await page.keyboard.up('KeyE');
    await page.waitForTimeout(1500);
    if (v.drive.teleport) {
      // (needs the sim on the main thread: --query transport=loopback) the car to a start, facing its way, then the tiles there settle
      await page.evaluate(async (t) => {
        const S = window.__hood.game.transport.host.simulation;
        const car = S.registry.get(S.vehicleId).car;
        car.teleport(t.x, S.groundAt(t.x, t.z) + 0.7, t.z, t.yaw);
        window.__hood.game.cameraArm.yaw = t.yaw + Math.PI;
        for (let i = 0; i < 200 && (S.playerHeld || !S.stream.settled || !window.__hood.stream.settled); i++) await new Promise((r) => setTimeout(r, 50));
      }, v.drive.teleport);
      await page.waitForTimeout(1500);
    }
    if (v.drive.yaw !== undefined) await page.evaluate((yaw) => { window.__hood.game.cameraArm.yaw = yaw; }, v.drive.yaw);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(v.drive.ms ?? 6000);
    if (!v.drive.hold) await page.keyboard.up('KeyW');
  } else {
    await page.evaluate((v) => {
      const h = window.__hood;
      const g = h.game;
      if (v.centre) h.stream.centreOverride = { x: v.centre[0], z: v.centre[1] };
      if (v.near) h.stream.rings = { near: v.near, drop: v.near + 250, far: v.far ?? v.near * 3 };
      g.addSystem({
        name: 'stream-shots-camera',
        priority: 900,
        lateUpdate: () => {
          g.camera.fov = v.fov ?? 60;
          if (v.camFar) g.camera.far = v.camFar;
          // an aerial sees past the haze (it would hide anything beyond 2 km)
          if (v.fogFar && g.scene.fog) g.scene.fog.far = v.fogFar;
          g.camera.position.set(v.eye[0], v.eye[1], v.eye[2]);
          g.camera.lookAt(v.look[0], v.look[1], v.look[2]);
          g.camera.updateProjectionMatrix();
          g.camera.updateMatrixWorld(true);
        },
      });
      for (const sel of ['.hud', '.hud-prompt', '#hud', 'canvas:not(#view)']) document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
    }, v);
  }
  // until every near tile is drawn and the city-wide sets are rebuilt (or 60 s)
  await page.waitForFunction(() => window.__hood.stream?.settled, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(v.wait ?? 2500);
  const stats = await page.evaluate(() => window.__hood.stream?.stats());
  await page.screenshot({ path: `.shots/${prefix}-${v.name}.png` });
  console.log('shot', `.shots/${prefix}-${v.name}.png`, JSON.stringify(stats));
  errors.push(...errs);
  await page.close();
}
await browser.close();
server.close?.();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
process.exit(errors.length ? 1 : 0);
