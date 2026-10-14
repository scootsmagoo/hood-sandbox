/**
 * Shared plumbing for the perf, soak and leak harnesses (and `check:controls`): argument parsing, a
 * dev or preview server, browser launching with the device profiles, and page boot.
 *
 * Profiles (`--profile`): the graphics tier plus a device.
 *   desktop-high | desktop-medium | desktop-low   1280x720, mouse and keyboard
 *   phone-low                                     iPhone 15 Pro: 393x659 at 3x, touch, Low tier, and
 *                                                 the CPU slowed down through CDP (`--throttle`, default 4)
 */
import { createServer as createNetServer } from 'node:net';
import { loadavg, cpus } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness } from './page.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArgs(argv = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

export const PROFILES = {
  'desktop-high': { tier: 'high', device: 'desktop' },
  'desktop-medium': { tier: 'medium', device: 'desktop' },
  'desktop-low': { tier: 'low', device: 'desktop' },
  'phone-low': { tier: 'low', device: 'iphone', throttle: 4 },
};

/** Starts a Vite dev server (default) or a preview of dist/ (`--dist`), or uses `--url`. */
export async function startServer(args) {
  if (typeof args.url === 'string') return { base: args.url.endsWith('/') ? args.url : `${args.url}/`, close: async () => {} };
  const { createServer, preview } = await import('vite');
  const port = await freePort();
  if (args.dist) {
    const server = await preview({ root, logLevel: 'error', preview: { port, strictPort: true, host: '127.0.0.1' } });
    return { base: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.httpServer.close(() => r())) };
  }
  const server = await createServer({ root, logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
  await server.listen();
  return { base: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/**
 * Launches a browser. Chromium gets the GPU flags, precise memory info and gc(). With `uncapped` the
 * display's frame-rate limit is lifted; a headless GPU then lets the main thread run far ahead of it,
 * so animation-frame times stop meaning anything (use the CPU and GPU numbers); it is for experiments.
 */
export async function launch({ browserName = 'chromium', uncapped = false } = {}) {
  const pw = await import('playwright');
  // WEBKIT_PATH: a Playwright WebKit build other than the one this Playwright version wants (an older install works).
  if (browserName === 'webkit') return pw.webkit.launch({ headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
  return pw.chromium.launch({
    headless: true,
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan']),
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      ...(uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ],
  });
}

/** A page for a profile, with CPU throttling applied when the profile asks for it. Returns { page, cdp, errors }. */
export async function openProfile(browser, profileName, args = {}) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile ${profileName} (${Object.keys(PROFILES).join(', ')})`);
  const pw = await import('playwright');
  const ctxOptions = profile.device === 'iphone'
    ? (({ defaultBrowserType, ...rest }) => rest)(pw.devices['iPhone 15 Pro'])
    : { viewport: { width: 1280, height: 720 } };
  const ctx = await browser.newContext(ctxOptions);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e?.message ?? e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  let cdp = null;
  if (browser.browserType().name() === 'chromium') {
    cdp = await ctx.newCDPSession(page);
    const rate = Number(args.throttle ?? profile.throttle ?? 1);
    if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  }
  return { page, ctx, cdp, errors, profile, isCrashed: () => crashed };
}

/** Loads the game and waits until it is ready; returns the boot time in ms. */
export async function boot(page, base, query, { harness = true, timeout = 180000 } = {}) {
  const t0 = Date.now();
  await page.goto(`${base}?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout, polling: 100 });
  const err = await page.evaluate(() => window.__hood.error);
  if (err) throw new Error(`boot error: ${err}`);
  const bootMs = Date.now() - t0;
  if (harness) await page.evaluate(installHarness, { seed: 1 });
  return bootMs;
}

export async function gc(cdp) {
  if (!cdp) return;
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
}

/** The load-average warning every timing harness prints. */
export function busyWarning() {
  const load = loadavg()[0];
  const cores = cpus().length;
  return load > cores * 0.5 ? `warning: the machine is busy (load ${load.toFixed(1)} on ${cores} cores): timings run high; counts are exact.` : null;
}

export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
