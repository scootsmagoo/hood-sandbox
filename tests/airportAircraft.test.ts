/**
 * The airport's airliners and airside vehicles (public/assets/airport/ac-*.glb with their sidecars, built by `npm run assets`
 * from tools/blender/airport/aircraft.py and ground.py): listed, in the manifest the game loads, built to
 * src/shared/data/aircraft.json (the numbers the sim's colliders and the jet bridges read), within their budgets, with the
 * node names, materials and anchors the game reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAircraft, checkGround, type AircraftType, type GroundDims } from '../tools/blender/airport/verifyAircraft.ts';
import manifest from '../src/client/render/airportAssets.manifest.json';

const dir = resolve(__dirname, '../public/assets/airport');
const data = JSON.parse(readFileSync(resolve(__dirname, '../src/shared/data/aircraft.json'), 'utf8')) as { types: Record<string, AircraftType>; ground: Record<string, GroundDims> };
const list = (JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/assets.json'), 'utf8')).airport as { name: string; module: string; kind?: string }[]).filter((a) => a.kind === 'aircraft' || a.kind === 'ground');
type Entry = { file: string; sidecar: string; kind: string; hash: string; bytes: number; tris: number[] };
const entries = manifest.airport as Record<string, Entry>;
const TYPES: Record<string, string> = { 'ac-narrowbody': 'narrowbody', 'ac-widebody': 'widebody', 'ac-regional': 'regional' };

describe('airport aircraft and ground vehicles', () => {
  it('are listed and in the manifest the game loads', () => {
    expect(list.map((a) => a.name).sort()).toEqual(['ac-ground', 'ac-narrowbody', 'ac-regional', 'ac-widebody']);
    for (const a of list) {
      const e = entries[a.name];
      expect(e, `${a.name} is not in airportAssets.manifest.json (run npm run assets)`).toBeTruthy();
      expect(e.kind).toBe(a.kind);
      expect(e.file).toBe(`assets/airport/${a.name}.glb`);
      const glb = resolve(dir, `${a.name}.glb`);
      expect(existsSync(glb), `${glb} (run npm run assets)`).toBe(true);
      const side = JSON.parse(readFileSync(resolve(dir, `${a.name}.json`), 'utf8'));
      expect(e.bytes).toBe(readFileSync(glb).length);
      expect(side.hash).toBe(e.hash);
      expect(side.bytes).toBe(e.bytes);
      expect(side.model).toBe(e.file);
    }
    // every aircraft or ground entry of the manifest is one of ours and exists
    for (const [name, e] of Object.entries(entries)) {
      if (e.kind !== 'aircraft' && e.kind !== 'ground') continue;
      expect(list.some((a) => a.name === name), `${name} is in the manifest but not in assets.json`).toBe(true);
      expect(existsSync(resolve(__dirname, '../public', e.file))).toBe(true);
    }
  });

  for (const [asset, type] of Object.entries(TYPES)) {
    it(`${asset} is built to aircraft.json ${type}, within its budgets, with its nodes and anchors`, async () => {
      const r = await checkAircraft(asset, resolve(dir, `${asset}.glb`), resolve(dir, `${asset}.json`), type, data.types[type]);
      expect(r.problems).toEqual([]);
      expect(entries[asset].tris).toEqual(r.tris);
    });
  }

  it('ac-ground has every airside vehicle at its size, within its budgets', async () => {
    const r = await checkGround('ac-ground', resolve(dir, 'ac-ground.glb'), resolve(dir, 'ac-ground.json'), data.ground as Record<string, GroundDims>);
    expect(r.problems).toEqual([]);
  });

  it('aircraft.json is consistent with itself', () => {
    for (const [type, T] of Object.entries(data.types)) {
      expect(T.noseZ - T.tailZ, type).toBeCloseTo(T.length, 1);
      expect(T.wheelbase, type).toBeLessThan(T.noseZ);
      expect(T.lights.navLeft[0], type).toBeLessThanOrEqual(T.span / 2);
      expect(T.lights.navLeft[0], type).toBeCloseTo(-T.lights.navRight[0], 6);
      expect(T.doorL1.z, type).toBeLessThan(T.noseZ - 2.5);
    }
  });
});
