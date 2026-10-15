#!/usr/bin/env node
/**
 * What the look costs the GPU, on fixed cameras (docs/perf.md). For each tier, view and variant it
 * draws 150 frames with the frame-rate limit off and times `renderer.render` plus `gl.finish()` (so
 * the GPU's work is in the number), and prints the mean in ms. Variants are URL queries:
 * `classic` (the old renderer), `default` (the look), and the look with one part off.
 *
 *   node scripts/gfx-cost.mjs [--tiers high,medium,low] [--views street-day,aerial-day,street-night]
 *                             [--variants classic,default,post,facade,surface,haze,lamps] [--phone]
 *
 * `--phone` uses the iPhone 15 Pro viewport (393x659 at 3x, touch) instead of 1280x720. The numbers
 * are for this machine's GPU only, a floor for any phone (see docs/perf.md); they say how the parts
 * compare, not what a phone will do. Traffic and people are off, so every run draws the same scene.
 */
import { boot, launch, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const tiers = String(args.tiers ?? 'high,medium,low').split(',');
const views = String(args.views ?? 'street-day,aerial-day,street-night').split(',');
const variants = String(args.variants ?? 'classic,default,post,facade,surface,haze,lamps').split(',');
const VIEWS = {
  'street-day': { time: '14:00', eye: [-74, 3.8, -66], look: [-165, 16, -185], fov: 62 },
  'street-night': { time: '23:30', eye: [-74, 3.8, -66], look: [-165, 16, -185], fov: 62 },
  'aerial-day': { time: '14:00', eye: [150, 150, 210], look: [-80, 20, -160], fov: 55 },
  'aerial-night': { time: '23:30', eye: [150, 150, 210], look: [-80, 20, -160], fov: 55 },
};
const QUERY = { classic: 'gfx=classic', default: '', post: 'gfxoff=post', facade: 'gfxoff=facade', surface: 'gfxoff=surface', haze: 'gfxoff=haze', lamps: 'gfxoff=lamps', bloom: 'gfxoff=bloom' };

const server = await startServer(args);
const browser = await launch({ uncapped: true });
const pw = await import('playwright');
const rows = [];
try {
  for (const tier of tiers) {
    for (const view of views) {
      const v = VIEWS[view];
      const row = { tier, view };
      for (const variant of variants) {
        const ctxOptions = args.phone ? (({ defaultBrowserType, ...rest }) => rest)(pw.devices['iPhone 15 Pro']) : { viewport: { width: 1280, height: 720 } };
        const ctx = await browser.newContext(ctxOptions);
        const page = await ctx.newPage();
        try {
          const q = `graphics=${tier}&time=${v.time}&timescale=0&traffic=0&ambient=0${QUERY[variant] ? `&${QUERY[variant]}` : ''}`;
          await boot(page, server.base, q, { harness: false });
          await page.evaluate(({ eye, look, fov }) => {
            const g = window.__hood.game;
            g.addSystem({
              name: 'gfx-cost-camera',
              priority: 900,
              lateUpdate: () => {
                g.camera.fov = fov;
                g.camera.position.set(eye[0], eye[1], eye[2]);
                g.camera.lookAt(look[0], look[1], look[2]);
                g.camera.updateProjectionMatrix();
                g.camera.updateMatrixWorld(true);
              },
            });
            const gl = g.renderer.getContext();
            const inner = g.renderer.render;
            const times = [];
            g.renderer.render = function (...a) {
              const t0 = performance.now();
              inner.apply(this, a);
              gl.finish();
              times.push(performance.now() - t0);
            };
            window.__cost = times;
          }, v);
          await page.waitForTimeout(2500);
          await page.evaluate(() => { window.__cost.length = 0; });
          await page.waitForFunction(() => window.__cost.length >= 150, null, { timeout: 60000 });
          const mean = await page.evaluate(() => {
            const t = window.__cost.slice(0, 150).sort((a, b) => a - b);
            // the middle 80%, so one slow frame does not move it
            const mid = t.slice(15, 135);
            return mid.reduce((x, y) => x + y, 0) / mid.length;
          });
          row[variant] = mean;
        } finally {
          await ctx.close();
        }
      }
      rows.push(row);
      console.log(`${tier.padEnd(7)} ${view.padEnd(13)} ${variants.map((x) => `${x} ${row[x].toFixed(2)}`).join('  ')}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
