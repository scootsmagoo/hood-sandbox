#!/usr/bin/env node
/**
 * Builds the characters (part of `npm run assets`): runs headless Blender on characters/build.py
 * (every archetype at three levels of detail, one armature, the animation clips), then with
 * glTF-Transform:
 *   - joins each skinned mesh's primitives into one, with a per-vertex `_REGION` byte (which
 *     material slot the face was in: skin, hair, top, bottom, ...; the game paints each region from
 *     the person's palette, so a person is one draw),
 *   - drops the animation channels that never move (and all scale channels),
 *   - compresses with meshopt,
 * and writes public/assets/characters/characters.glb and src/client/render/characterAssets.manifest.json
 * (hash, size, triangles per mesh, the clips).
 *
 *   node tools/blender/characters/build.mjs [--preview <dir>]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accessor, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune as pruneUnused, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const blender = process.env.BLENDER ?? (existsSync('/snap/blender/current/blender') ? '/snap/blender/current/blender' : 'blender');
const SLOT_NAMES = ['skin', 'lip', 'eye', 'sclera', 'hair', 'top', 'top2', 'bottom', 'shoe', 'sole', 'belt', 'hat', 'gear', 'trim', 'stubble', 'face'];

function run(argv) {
  return new Promise((res, rej) => {
    const p = spawn(blender, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`blender exited ${code}\n${out.slice(-4000)}`))));
  });
}

/** Joins a mesh's primitives into one with a `_REGION` attribute. */
function joinPrimitives(doc, mesh, regionOf) {
  const all = mesh.listPrimitives();
  for (const p of all) if (!p.getIndices()) mesh.removePrimitive(p);
  const prims = mesh.listPrimitives();
  const names = ['POSITION', 'NORMAL', 'COLOR_0', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
  const total = prims.reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0);
  const idxTotal = prims.reduce((n, p) => n + p.getIndices().getCount(), 0);
  const buffer = doc.getRoot().listBuffers()[0];
  const out = {};
  for (const n of names) {
    const a = prims[0].getAttribute(n);
    if (!a) continue;
    const arr = new (a.getArray().constructor)(total * a.getElementSize());
    out[n] = { arr, size: a.getElementSize(), type: a.getComponentType(), normalized: a.getNormalized(), at: 0 };
  }
  const region = new Uint8Array(total);
  const indices = new Uint32Array(idxTotal);
  let vBase = 0;
  let iAt = 0;
  for (const p of prims) {
    const n = p.getAttribute('POSITION').getCount();
    for (const k of Object.keys(out)) {
      const src = p.getAttribute(k).getArray();
      out[k].arr.set(src, vBase * out[k].size);
    }
    const r = regionOf(p.getMaterial()?.getName() ?? 'skin');
    region.fill(r, vBase, vBase + n);
    const idx = p.getIndices().getArray();
    for (let i = 0; i < idx.length; i++) indices[iAt++] = idx[i] + vBase;
    vBase += n;
  }
  const prim = doc.createPrimitive();
  for (const [k, v] of Object.entries(out)) {
    const acc = doc.createAccessor().setArray(v.arr).setType(v.size === 1 ? 'SCALAR' : `VEC${v.size}`).setBuffer(buffer);
    if (v.normalized) acc.setNormalized(true);
    prim.setAttribute(k, acc);
  }
  prim.setAttribute('_REGION', doc.createAccessor().setArray(region).setType('SCALAR').setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setArray(indices).setType('SCALAR').setBuffer(buffer));
  prim.setMaterial(prims[0].getMaterial());
  const old = [...prims, ...all.filter((p) => !p.getIndices())];
  for (const p of old) mesh.removePrimitive(p);
  mesh.addPrimitive(prim);
  // (accessors can be shared between meshes: leave them to `prune`)
  for (const p of old) p.dispose();
}

function prune(doc) {
  const near = (a, b, e) => Math.abs(a - b) <= e;
  let kept = 0;
  let dropped = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const path = ch.getTargetPath();
      const node = ch.getTargetNode();
      const s = ch.getSampler();
      let drop = path === 'scale';
      if (!drop) {
        const v = s.getOutput().getArray();
        const rest = path === 'rotation' ? node.getRotation() : node.getTranslation();
        const k = path === 'rotation' ? 4 : 3;
        drop = true;
        for (let i = 0; i < v.length && drop; i += k) {
          for (let j = 0; j < k; j++) {
            // q and -q are the same rotation
            const sign = path === 'rotation' && v[i] * rest[0] + v[i + 1] * rest[1] + v[i + 2] * rest[2] + v[i + 3] * rest[3] < 0 ? -1 : 1;
            if (!near(sign * v[i + j], rest[j], 2e-4)) { drop = false; break; }
          }
        }
      }
      if (drop) { anim.removeChannel(ch); dropped++; } else kept++;
    }
    for (const s of anim.listSamplers()) if (!anim.listChannels().some((c) => c.getSampler() === s)) s.dispose();
  }
  return { kept, dropped };
}

const tmp = mkdtempSync(join(tmpdir(), 'hood-chars-'));
try {
  const raw = join(tmp, 'characters.raw.glb');
  const t0 = Date.now();
  const argv = ['--background', '--factory-startup', '--python', join(here, '..', 'build_asset.py'), '--', '--module', 'characters.build', '--asset', 'characters', '--out', raw];
  const log = await run(argv);
  const line = log.split('\n').find((l) => l.startsWith('ASSET_REPORT '));
  if (!line) throw new Error(`no report from blender\n${log.slice(-4000)}`);
  const report = JSON.parse(line.slice('ASSET_REPORT '.length));
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(raw);
  doc.getRoot().getAsset().generator = 'hood-sandbox tools/blender';
  const regionOf = (name) => Math.max(0, SLOT_NAMES.indexOf(name));
  for (const mesh of doc.getRoot().listMeshes()) {
    if (!mesh.listPrimitives().some((p) => p.getIndices())) console.log('empty mesh', mesh.getName(), mesh.listPrimitives().length);
    else joinPrimitives(doc, mesh, regionOf);
  }
  // one shared plain material: the game paints by region
  const mats = doc.getRoot().listMaterials();
  for (const m of mats.slice(1)) m.dispose();
  if (mats[0]) mats[0].setName('ped');
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) p.setMaterial(mats[0] ?? null);
  const pr = prune(doc);
  await doc.transform(pruneUnused({ keepLeaves: true }));
  // positions stay float (a skinned mesh's node transform is ignored, so they must not carry a quantisation scale); the rest is quantised
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ pattern: /^(NORMAL|COLOR_0|WEIGHTS_0)$/, quantizeNormal: 10, quantizeColor: 8, quantizeWeight: 8 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const bytes = await io.writeBinary(doc);
  const outDir = join(root, 'public', 'assets', 'characters');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'characters.glb'), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const manifest = { _comment: 'Written by tools/blender/characters/build.mjs (npm run assets). Do not edit.', file: 'assets/characters/characters.glb', hash, bytes: bytes.length, regions: report.regions, bones: report.bones, tris: report.tris, clips: report.clips };
  writeFileSync(join(root, 'src', 'client', 'render', 'characterAssets.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`characters ${bytes.length} B  tris ${Object.entries(report.tris).map(([k, v]) => `${k} ${v}`).join(', ')}  clips ${Object.keys(report.clips).length} (channels kept ${pr.kept}, dropped ${pr.dropped})  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (report.warnings?.length) console.log('WARN', report.warnings.join('; '));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
