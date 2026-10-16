/**
 * The hero landmark models (public/assets/landmarks/*.glb and their sidecars, built by `npm run assets` from
 * tools/blender/landmarks/): structure, budgets, hull, and that each one is a landmark of the Atlanta city pack
 * with a name (and a parody display name where the real one is a brand).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLandmark } from '../tools/blender/landmarks/verify.ts';
import manifest from '../src/client/render/landmarkAssets.manifest.json';

const list = JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/assets.json'), 'utf8')).landmarks as { name: string; module: string }[];
const pack = JSON.parse(readFileSync(resolve(__dirname, '../data/cities/atlanta/landmarks.json'), 'utf8')).landmarks as { id: string; name: string; displayName?: string; lat: number; lon: number }[];

describe('hero landmark models', () => {
  it('has a list', () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
  });
  for (const a of list) {
    it(`${a.name} is built, within its budgets, with a hull, and a landmark of the city pack`, async () => {
      const glb = resolve(__dirname, `../public/assets/landmarks/${a.name}.glb`);
      const json = resolve(__dirname, `../public/assets/landmarks/${a.name}.json`);
      expect(existsSync(glb), `${glb} (run npm run assets)`).toBe(true);
      const r = await checkLandmark(a.name, glb, json);
      expect(r.problems).toEqual([]);
      // the manifest the game loads from describes this very file
      const m = (manifest.landmarks as Record<string, { tris: number[]; bytes: number; hash: string }>)[a.name];
      expect(m.bytes).toBe(r.bytes);
      expect(m.tris).toEqual(r.tris);
      expect(JSON.parse(readFileSync(json, 'utf8')).hash).toBe(m.hash);
      const entry = pack.find((p) => p.id === a.name);
      expect(entry, `${a.name} is not in data/cities/atlanta/landmarks.json`).toBeTruthy();
      expect(entry!.displayName ?? entry!.name).toBeTruthy();
    });
  }
});
