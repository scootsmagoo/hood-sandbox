/**
 * The vehicle assets (public/assets/vehicles/*.glb, built by `npm run assets` from tools/blender/):
 * each is checked against the physics (hull, wheels), the door and seat anchors of doors.ts, the
 * triangle budgets and the material slots. And the client's level-of-detail choice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLING } from '../src/shared/handling';
import { checkAsset } from '../tools/blender/verify.ts';
import manifest from '../src/client/render/carAssets.manifest.json';
import { CAR_LOD, assetFor, pickLod } from '../src/client/render/carLod';

const list = JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/assets.json'), 'utf8')).vehicles as { name: string; type: string; police?: boolean }[];

describe('vehicle assets', () => {
  for (const a of list) {
    it(`${a.name} matches its physics, anchors and budgets`, async () => {
      const path = resolve(__dirname, `../public/assets/vehicles/${a.name}.glb`);
      expect(existsSync(path), `${path} (run npm run assets)`).toBe(true);
      const h = HANDLING[a.type];
      const r = await checkAsset(path, h, { police: a.police });
      expect(r.problems).toEqual([]);
      // the manifest the game loads from describes this very file
      const m = (manifest.vehicles as Record<string, { tris: number[]; bytes: number; type: string }>)[a.name];
      expect(m.type).toBe(a.type);
      expect(m.bytes).toBe(r.stats.bytes);
      expect(m.tris).toEqual(r.stats.tris);
    });
  }

  it('every vehicle type the sim spawns has an asset, police included', () => {
    for (const id of Object.keys(HANDLING)) {
      expect(assetFor(id, false), id).toBeTruthy();
    }
    expect(assetFor('sedan', true)).toBe('sedan-police');
    expect(assetFor('coupe', true)).toBe('coupe-police');
    // a type without its own police model falls back to its plain body
    expect(assetFor('pickup', true)).toBe('pickup');
    expect(assetFor('no-such-type', false)).toBe('sedan');
  });
});

describe('car level of detail', () => {
  it('picks nearer levels for nearer cars and scales with the tier', () => {
    expect(pickLod(5, 1)).toBe(0);
    expect(pickLod(CAR_LOD.near - 1, 1)).toBe(0);
    expect(pickLod(CAR_LOD.near + 1, 1)).toBe(1);
    expect(pickLod(CAR_LOD.far + 1, 1)).toBe(2);
    // the Low tier (lodScale 0.55) drops detail sooner
    expect(pickLod(CAR_LOD.near * 0.8, 0.55)).toBe(1);
    expect(pickLod(CAR_LOD.far * 0.8, 0.55)).toBe(2);
  });

  it('holds a level near its boundary instead of flickering', () => {
    const b = CAR_LOD.near;
    expect(pickLod(b + 0.5, 1, 0)).toBe(0);
    expect(pickLod(b - 0.5, 1, 1)).toBe(1);
    expect(pickLod(b + 5, 1, 0)).toBe(1);
  });
});
