#!/usr/bin/env node
/**
 * The ground audit (tests/audit/ground/): every drivable lane of the tile driven by a physics car at 15, 25 and 35 m/s,
 * the surfaces the wheels see scanned along every lane, and every lane and road tested against the building footprints.
 * Writes .shots/ground/ground-audit.json and ground-heat.png. docs/ground-audit.md explains the output.
 *
 *   npm run audit:ground                         (the whole tile, all three speeds; about two minutes on 30 threads)
 *   npm run audit:ground -- --quick              (every 12th edge at 25 m/s)
 *   npm run audit:ground -- --tile <dir> --out <dir> --speeds 25 --workers 8 --gate
 *
 * The TypeScript is bundled with esbuild (a dependency of Vite) into node_modules/.cache, and the bundle is also the
 * worker script, so the audit needs no TypeScript runner.
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'node_modules/.cache/ground-audit');
mkdirSync(outDir, { recursive: true });
// one bundle per run, so two audits at once (a verify and a manual run) do not overwrite each other's worker script
const outfile = path.join(outDir, `run-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'tests/audit/ground/run.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
process.chdir(root);
const { main } = await import(pathToFileURL(outfile).href);
const argv = process.argv.slice(2);
let report;
try {
  report = await main(argv);
} finally {
  rmSync(outfile, { force: true });
}
if (argv.includes('--gate') && report.failed.length) process.exit(1);
process.exit(0);
