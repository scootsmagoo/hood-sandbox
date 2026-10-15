import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { Document } from '@gltf-transform/core';
import { loadTileConfig } from './config.js';
import { decodeGlb } from './io/glb.js';
import { readHeightmap } from './io/binary.js';

interface Tri { x: number[]; z: number[]; y: number; nx: number; ny: number; nz: number; rgb: [number, number, number]; /** a vertex attribute of the first vertex, when asked for */ attr?: number[]; ao: number }

const toSrgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

function trianglesOf(doc: Document, attrName?: string): Tri[] {
  const out: Tri[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if ((node.getExtras() as { lod?: number }).lod) continue; // coarse ground levels sit under the fine ones
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      const col = prim.getAttribute('COLOR_0');
      const extra = attrName ? prim.getAttribute(attrName) : null;
      const idx = prim.getIndices()!;
      const base = prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const P: number[][] = [];
      const C: number[][] = [];
      const tmp = [0, 0, 0];
      const ctmp = [0, 0, 0, 1];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, tmp);
        P.push([m[0] * tmp[0] + m[4] * tmp[1] + m[8] * tmp[2] + m[12], m[1] * tmp[0] + m[5] * tmp[1] + m[9] * tmp[2] + m[13], m[2] * tmp[0] + m[6] * tmp[1] + m[10] * tmp[2] + m[14]]);
        if (col) { col.getElement(i, ctmp); C.push([ctmp[0], ctmp[1], ctmp[2]]); } else C.push([1, 1, 1]);
      }
      for (let t = 0; t < idx.getCount(); t += 3) {
        const a = P[idx.getScalar(t)], b = P[idx.getScalar(t + 1)], c = P[idx.getScalar(t + 2)];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        const l = Math.hypot(nx, ny, nz) || 1;
        const ca = C[idx.getScalar(t)];
        const first = idx.getScalar(t);
        const cc = [0, 0, 0, 1];
        if (col) col.getElement(first, cc);
        out.push({
          x: [a[0], b[0], c[0]],
          z: [a[2], b[2], c[2]],
          y: (a[1] + b[1] + c[1]) / 3,
          nx: nx / l,
          ny: ny / l,
          nz: nz / l,
          rgb: [ca[0] * base[0], ca[1] * base[1], ca[2] * base[2]],
          attr: extra ? (extra.getElement(first, [0, 0, 0, 0]) as number[]) : undefined,
          ao: cc[3],
        });
      }
    }
  }
  return out;
}

export type PreviewMode = 'colour' | 'kind' | 'ao' | 'land' | 'roof';

/** Colours of the building kinds, the roof surfaces and the ground classes in the debug views. */
const KIND_RGB: [number, number, number][] = [[150, 150, 150], [90, 140, 220], [60, 220, 230], [190, 80, 60], [120, 120, 60], [230, 170, 60], [230, 230, 120], [180, 80, 200], [140, 100, 70], [80, 190, 90], [255, 140, 170], [200, 200, 200], [90, 60, 200]];
const SURF_RGB: [number, number, number][] = [[170, 170, 170], [200, 90, 60], [90, 120, 220], [250, 250, 90], [220, 160, 60], [60, 200, 90], [150, 60, 180], [240, 120, 200]];
const LAND_RGB: [number, number, number][] = [[120, 120, 120], [70, 170, 70], [30, 110, 40], [150, 110, 60], [220, 200, 150], [60, 60, 70], [140, 130, 120], [100, 80, 80], [50, 100, 200], [110, 220, 110], [90, 150, 90], [150, 170, 130], [160, 150, 170]];

export async function renderPreview(tileDir: string, outFile: string, view?: { cx: number; cz: number; half: number; px: number }, mode: PreviewMode = 'colour'): Promise<void> {
  const tile = JSON.parse(readFileSync(path.join(tileDir, 'tile.json'), 'utf8'));
  const b = tile.bounds;
  const half = view?.half ?? (b.maxX - b.minX) / 2;
  const cx = view?.cx ?? 0;
  const cz = view?.cz ?? 0;
  const size = view?.px ?? 2000;
  const s = size / (2 * half);
  const canvas = createCanvas(size, size);
  const g = canvas.getContext('2d');
  g.fillStyle = '#1a1a1a';
  g.fillRect(0, 0, size, size);
  const X = (x: number) => (x - cx + half) * s;
  const Z = (z: number) => (z - cz + half) * s;

  const light = (() => { const v = [-0.4, 0.8, -0.45]; const l = Math.hypot(...v); return v.map((c) => c / l); })() as [number, number, number];
  const draw = (tris: Tri[], shade: (t: Tri) => number, stroke = true) => {
    for (const t of tris) {
      const k = shade(t);
      g.fillStyle = `rgb(${Math.min(255, toSrgb(t.rgb[0]) * k) | 0},${Math.min(255, toSrgb(t.rgb[1]) * k) | 0},${Math.min(255, toSrgb(t.rgb[2]) * k) | 0})`;
      g.beginPath();
      g.moveTo(X(t.x[0]), Z(t.z[0]));
      g.lineTo(X(t.x[1]), Z(t.z[1]));
      g.lineTo(X(t.x[2]), Z(t.z[2]));
      g.closePath();
      g.fill();
      if (stroke) { g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke(); }
    }
  };
  const doc = async (f: string) => decodeGlb(new Uint8Array(readFileSync(path.join(tileDir, f))));

  const debugRgb = (t: Tri, table: [number, number, number][], i: number): [number, number, number] => {
    const c = table[Math.max(0, Math.min(table.length - 1, Math.round(t.attr?.[i] ?? 0)))];
    return [c[0], c[1], c[2]];
  };
  const drawRgb = (tris: Tri[], pick: (t: Tri) => [number, number, number], shade: (t: Tri) => number) => {
    for (const t of tris) {
      const k = shade(t);
      const c = pick(t);
      g.fillStyle = `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
      g.beginPath();
      g.moveTo(X(t.x[0]), Z(t.z[0]));
      g.lineTo(X(t.x[1]), Z(t.z[1]));
      g.lineTo(X(t.x[2]), Z(t.z[2]));
      g.closePath();
      g.fill();
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 0.6;
      g.stroke();
    }
  };
  const lambert = (t: Tri) => 0.55 + 0.6 * Math.max(0, t.nx * light[0] + t.ny * light[1] + t.nz * light[2]);
  const aoGrey = (t: Tri): [number, number, number] => [255 * t.ao, 255 * t.ao, 255 * t.ao];

  const ground = trianglesOf(await doc(tile.meshes.ground), mode === 'land' ? '_LAND' : undefined);
  if (mode === 'kind' || mode === 'roof') {
    draw(ground, () => 0.35, true);
  } else if (mode === 'land') {
    drawRgb(ground, (t) => debugRgb(t, LAND_RGB, 0), () => 1);
  } else if (mode === 'ao') {
    drawRgb(ground, aoGrey, () => 1);
  } else {
    // normals from the mesh: use ny only as a crude slope shade
    draw(ground, (t) => 0.55 + 0.6 * Math.max(0, (1 - t.ny) * 6) * -1 + 0.6 * Math.min(1, t.ny), true);
  }

  const roads = trianglesOf(await doc(tile.meshes.roads)).filter((t) => Math.abs(t.ny) > 0.3);
  roads.sort((a, c) => a.y - c.y);
  if (mode === 'ao') drawRgb(roads, aoGrey, (t) => (t.ny > 0 ? 1 : 0.5));
  else if (mode === 'kind' || mode === 'roof') draw(roads, (t) => (t.ny > 0 ? 0.5 : 0.3), true);
  else if (mode !== 'land') draw(roads, (t) => (t.ny > 0 ? 1 : 0.5) * (0.9 + 0.012 * Math.min(25, Math.max(0, t.y))), true);

  if (mode !== 'land') {
    const attr = mode === 'kind' ? '_BLD' : mode === 'roof' ? '_SRF' : undefined;
    const bld = trianglesOf(await doc(tile.meshes.buildings), attr).filter((t) => t.ny > 0.3);
    bld.sort((a, c) => a.y - c.y);
    if (mode === 'kind') drawRgb(bld, (t) => debugRgb(t, KIND_RGB, 0), (t) => 0.8 + Math.min(0.3, t.y / 300));
    else if (mode === 'roof') drawRgb(bld, (t) => debugRgb(t, SURF_RGB, 0), lambert);
    else if (mode === 'ao') drawRgb(bld, aoGrey, () => 1);
    else draw(bld, (t) => (t.ny > 0.95 ? 0.75 + Math.min(0.5, t.y / 120) : lambert(t)), true);
  }

  const sp = tile.spawns;
  g.fillStyle = '#00e060';
  g.beginPath();
  g.arc(X(sp.player.x), Z(sp.player.z), 6, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#000';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#ff3030';
  g.beginPath();
  g.arc(X(sp.vehicle.x), Z(sp.vehicle.z), 6, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(X(sp.vehicle.x), Z(sp.vehicle.z));
  g.lineTo(X(sp.vehicle.x - Math.sin(sp.vehicle.heading) * 25), Z(sp.vehicle.z - Math.cos(sp.vehicle.heading) * 25));
  g.strokeStyle = '#ff3030';
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = '#fff';
  g.font = '14px sans-serif';
  g.fillText('N', size - 20, 20);
  g.fillText(`${(2 * half).toFixed(0)} m across`, 10, size - 10);

  writeFileSync(outFile, canvas.toBuffer('image/png'));
  void readHeightmap;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadTileConfig();
  const cache = cfg.cacheDir.replace(/\/atlanta\/m1-five-points$/, '');
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const at = arg('at');
  const mode = (arg('mode') ?? 'colour') as PreviewMode;
  const tileDir = arg('tile') ?? cfg.outDir;
  if (at) {
    // a close-up: --at x,z [--half metres] [--px pixels] [--out file.png] [--mode colour|kind|roof|ao|land] [--tile dir]
    const [cx, cz] = at.split(',').map(Number);
    const out = arg('out') ?? path.join(cache, `preview-closeup${mode === 'colour' ? '' : '-' + mode}.png`);
    await renderPreview(tileDir, out, { cx, cz, half: Number(arg('half') ?? 40), px: Number(arg('px') ?? 1600) }, mode);
    console.log('wrote', out);
  } else if (mode !== 'colour') {
    const out = arg('out') ?? path.join(cache, `preview-${mode}.png`);
    await renderPreview(tileDir, out, undefined, mode);
    console.log('wrote', out);
  } else {
    await renderPreview(tileDir, path.join(cache, 'preview.png'));
    await renderPreview(tileDir, path.join(cache, 'preview-center.png'), { cx: 0, cz: 0, half: 300, px: 1800 });
    console.log('wrote', path.join(cache, 'preview.png'));
  }
}
