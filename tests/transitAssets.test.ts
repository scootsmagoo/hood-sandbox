/**
 * The transit models (public/assets/transit/railcar.glb and station-kit.glb with their sidecars, built by `npm run assets`
 * from tools/blender/transit/): structure, budgets, material names, the railcar drawn to src/shared/data/railcar.json (the
 * numbers the sim boards, seats and collides by), door leaves that slide clear, and the kit parts at their sizes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkKit, checkRailcar, type RailcarDims } from '../tools/blender/transit/verify.ts';
import manifest from '../src/client/render/transitAssets.manifest.json';

const dir = resolve(__dirname, '../public/assets/transit');
const dims = JSON.parse(readFileSync(resolve(__dirname, '../src/shared/data/railcar.json'), 'utf8')) as RailcarDims;
const list = JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/assets.json'), 'utf8')).transit as { name: string; module: string }[];
type Entry = { file: string; sidecar: string; hash: string; bytes: number; tris: number[] };
const entries = manifest.transit as Record<string, Entry>;

describe('transit assets', () => {
  it('are listed and in the manifest the game loads', () => {
    expect(list.map((a) => a.name)).toEqual(['railcar', 'station-kit']);
    for (const a of list) {
      const glb = resolve(dir, `${a.name}.glb`);
      expect(existsSync(glb), `${glb} (run npm run assets)`).toBe(true);
      const side = JSON.parse(readFileSync(resolve(dir, `${a.name}.json`), 'utf8'));
      expect(entries[a.name].bytes).toBe(readFileSync(glb).length);
      expect(side.hash).toBe(entries[a.name].hash);
      expect(side.bytes).toBe(entries[a.name].bytes);
    }
  });

  it('the railcar is built to railcar.json, within its budgets, with sliding doors and its anchors', async () => {
    const r = await checkRailcar(resolve(dir, 'railcar.glb'), resolve(dir, 'railcar.json'), dims);
    expect(r.problems).toEqual([]);
    expect(entries.railcar.tris).toEqual(r.tris);
  });

  it('the station kit has every part at its size, within its budgets', async () => {
    const r = await checkKit(resolve(dir, 'station-kit.glb'), resolve(dir, 'station-kit.json'));
    expect(r.problems).toEqual([]);
    const lod0 = Object.values(r.tris).reduce((t, v) => t + v[0], 0);
    expect(entries['station-kit'].tris[0]).toBe(lod0);
  });

  it('seats sit inside the car and clear of the doorways', () => {
    const dhw = dims.doors.width / 2;
    for (const [x, , z] of dims.seats) {
      expect(Math.abs(x)).toBeLessThan(dims.halfWidth - 0.25);
      expect(Math.abs(z)).toBeLessThan(dims.length / 2 - 0.3);
      for (const c of dims.doors.z) expect(Math.abs(z - c)).toBeGreaterThan(dhw + 0.3);
    }
  });
});
