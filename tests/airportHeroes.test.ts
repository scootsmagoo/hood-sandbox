/**
 * The Hartsfield-Jackson hero buildings (public/assets/airport/<id>.glb and their sidecars, built by `npm run assets` from
 * tools/blender/airport/): structure, budgets, hull, flattening, reach, and for the walk-in halls their walk network; and
 * that the manifest the game loads describes each very file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHero, type HeroOutline } from '../tools/blender/airport/verifyHeroes.ts';
import manifest from '../src/client/render/airportAssets.manifest.json';

type Entry = { file: string; sidecar: string; kind: string; hash: string; bytes: number; tris: number[] };
const entries = Object.entries((manifest as { airport: Record<string, Entry> }).airport).filter(([, e]) => e.kind === 'hero');
const outlines = (JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/airport/airport.json'), 'utf8')) as { heroes: Record<string, HeroOutline> }).heroes;
const listed = (JSON.parse(readFileSync(resolve(__dirname, '../tools/blender/assets.json'), 'utf8')).airport ?? []) as { name: string; kind?: string }[];

describe('airport hero buildings', () => {
  it('every hero listed in assets.json is in the manifest', () => {
    for (const a of listed.filter((x) => x.kind === 'hero')) expect(entries.map(([k]) => k), `${a.name} (run npm run assets)`).toContain(a.name);
  });
  for (const [id, e] of entries) {
    it(`${id} is built, within its budgets, on its outline, with a valid hull and flattening`, async () => {
      const glb = resolve(__dirname, `../public/${e.file}`);
      const json = resolve(__dirname, `../public/${e.sidecar}`);
      expect(existsSync(glb), `${glb} (run npm run assets)`).toBe(true);
      const r = await checkHero(id, glb, json, outlines[id]);
      expect(r.problems).toEqual([]);
      expect(e.bytes).toBe(r.bytes);
      expect(e.tris).toEqual(r.tris);
      expect(JSON.parse(readFileSync(json, 'utf8')).hash).toBe(e.hash);
    });
  }
});
