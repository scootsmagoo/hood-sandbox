#!/usr/bin/env node
/**
 * `npm run assets`: rebuilds every asset of tools/blender/assets.json from its Blender script,
 * compresses it, and writes the results the game loads.
 *
 *   node tools/blender/build.mjs [--only sedan,pickup] [--preview <dir>] [--jobs 4]
 *
 * For each asset: headless Blender runs tools/blender/build_asset.py (the asset's Python module
 * builds the model and exports an uncompressed .glb), then glTF-Transform applies meshopt
 * compression with quantised attributes (as the tile pipeline does) and the file is written to
 * public/assets/vehicles/<name>.glb. A manifest with each file's content hash, size and triangles
 * per level of detail goes to src/client/render/carAssets.manifest.json: the game imports it, so
 * a rebuilt model gets a new URL (`?v=<hash>`) past the year-long cache on /assets/*.
 * `--preview <dir>` also renders a few Cycles views of each asset into <dir> (slow-ish, CPU).
 * The checks (bounds against handling.json, anchors against doors.ts, triangle budgets, material
 * names) are tests/carAssets.test.ts, which `npm run assets` runs after this.
 *
 * Blender: $BLENDER, else /snap/blender/current/blender, else `blender` on the PATH.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []));
const assetsJson = JSON.parse(readFileSync(join(here, 'assets.json'), 'utf8'));
// vehicles -> public/assets/vehicles + carAssets.manifest.json; props (trees, street furniture) -> public/assets/props + propAssets.manifest.json
// landmarks -> public/assets/landmarks (the .glb and a <name>.json sidecar: placement, collision hull, levels of detail) + landmarkAssets.manifest.json
const list = [
  ...assetsJson.vehicles.map((a) => ({ ...a, group: 'vehicles' })),
  ...(assetsJson.props ?? []).map((a) => ({ ...a, group: 'props' })),
  ...(assetsJson.landmarks ?? []).map((a) => ({ ...a, group: 'landmarks' })),
];
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const jobs = Math.max(1, Number(args.jobs ?? 4));
const outDirs = { vehicles: join(root, 'public', 'assets', 'vehicles'), props: join(root, 'public', 'assets', 'props'), landmarks: join(root, 'public', 'assets', 'landmarks') };
const manifestPaths = {
  vehicles: join(root, 'src', 'client', 'render', 'carAssets.manifest.json'),
  props: join(root, 'src', 'client', 'render', 'propAssets.manifest.json'),
  landmarks: join(root, 'src', 'client', 'render', 'landmarkAssets.manifest.json'),
};

const blender = process.env.BLENDER ?? (existsSync('/snap/blender/current/blender') ? '/snap/blender/current/blender' : 'blender');

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} exited ${code}\n${out.slice(-4000)}`))));
  });
}

async function buildOne(a, tmp) {
  const raw = join(tmp, `${a.name}.raw.glb`);
  const argv = ['--background', '--factory-startup', '--python', join(here, 'build_asset.py'), '--', '--module', a.module, '--asset', a.name, '--out', raw];
  if (typeof args.preview === 'string') {
    mkdirSync(resolve(args.preview), { recursive: true });
    argv.push('--preview', join(resolve(args.preview), a.name));
  }
  const log = await run(blender, argv);
  if (/Traceback|Error:/.test(log) && !log.includes('ASSET_REPORT')) throw new Error(`${a.name}: blender failed\n${log.slice(-4000)}`);
  const line = log.split('\n').find((l) => l.startsWith('ASSET_REPORT '));
  if (!line) throw new Error(`${a.name}: no report from blender\n${log.slice(-4000)}`);
  const report = JSON.parse(line.slice('ASSET_REPORT '.length));
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(raw);
  // the exporter's generator string carries Blender's version; keep the file stable across patch releases
  doc.getRoot().getAsset().generator = 'hood-sandbox tools/blender';
  // a landmark is up to 300 m across and carries the facade shader's attributes (metres along the wall, the quad's span): more bits for them
  const q = a.group === 'landmarks' ? { quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 16, quantizeGeneric: 16 } : { quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 };
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', ...q }));
  if (a.group === 'landmarks') {
    // the file's own triangle counts per level (the compression drops degenerate triangles)
    const count = (n) => (n.getMesh()?.listPrimitives() ?? []).reduce((t, p) => t + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0) + n.listChildren().reduce((t, c) => t + count(c), 0);
    report.tris = report.tris.map((_, i) => {
      const g = doc.getRoot().listNodes().find((n) => n.getName() === `lod${i}`);
      return g ? count(g) : 0;
    });
    report.sidecar.lods.forEach((l, i) => (l.tris = report.tris[i]));
  }
  const bytes = await io.writeBinary(doc);
  writeFileSync(join(outDirs[a.group], `${a.name}.glb`), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  if (a.group === 'landmarks') {
    // the sidecar: where the model stands, what it replaces, its collision hull and its levels of detail (docs/contracts/m1-tile-format.md, "landmarks.json")
    const side = { ...report.sidecar, id: a.name, model: `assets/landmarks/${a.name}.glb`, hash, bytes: bytes.length };
    writeFileSync(join(outDirs.landmarks, `${a.name}.json`), `${JSON.stringify(side, null, 1)}\n`);
  }
  return { report, bytes: bytes.length, hash };
}

for (const d of Object.values(outDirs)) mkdirSync(d, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'hood-assets-'));
const readManifest = (g) => (existsSync(manifestPaths[g]) ? JSON.parse(readFileSync(manifestPaths[g], 'utf8')) : { [g]: {} });
const manifests = { vehicles: readManifest('vehicles'), props: readManifest('props'), landmarks: readManifest('landmarks') };
const todo = list.filter((a) => !only || only.has(a.name));
let failed = 0;
try {
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const t0 = Date.now();
        try {
          const r = await buildOne(a, tmp);
          if (a.group === 'landmarks') manifests.landmarks.landmarks[a.name] = { file: `assets/landmarks/${a.name}.glb`, hash: r.hash, bytes: r.bytes, tris: r.report.tris };
          else if (a.group === 'props') manifests.props.props[a.name] = { file: `assets/props/${a.name}.glb`, hash: r.hash, bytes: r.bytes, tris: r.report.tris };
          else manifests.vehicles.vehicles[a.name] = { file: `assets/vehicles/${a.name}.glb`, type: a.type, police: !!a.police, hash: r.hash, bytes: r.bytes, tris: r.report.tris };
          const warn = r.report.warnings?.length ? `  WARN ${r.report.warnings.join('; ')}` : '';
          console.log(`${a.name.padEnd(14)} ${String(r.bytes).padStart(7)} B  tris ${r.report.tris.join(' / ')}  ${((Date.now() - t0) / 1000).toFixed(1)} s${warn}`);
        } catch (e) {
          failed++;
          console.error(`${a.name}: FAILED\n${e.message}`);
        }
      }
    }),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const sortedBy = (m, key, comment) => ({ _comment: comment, [key]: Object.fromEntries(Object.keys(m[key]).sort().map((k) => [k, m[key][k]])) });
const comment = 'Written by tools/blender/build.mjs (npm run assets). Do not edit.';
writeFileSync(manifestPaths.vehicles, `${JSON.stringify(sortedBy(manifests.vehicles, 'vehicles', comment), null, 2)}\n`);
writeFileSync(manifestPaths.props, `${JSON.stringify(sortedBy(manifests.props, 'props', comment), null, 2)}\n`);
writeFileSync(manifestPaths.landmarks, `${JSON.stringify(sortedBy(manifests.landmarks, 'landmarks', comment), null, 2)}\n`);
console.log(`manifests: ${manifestPaths.vehicles}, ${manifestPaths.props}, ${manifestPaths.landmarks}`);
process.exit(failed ? 1 : 0);
