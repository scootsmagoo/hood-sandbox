/**
 * The character assets (public/assets/characters/characters.glb, built by `npm run assets` from
 * tools/blender/characters): structure, bones, weights, triangle budgets per level of detail, the
 * clips, against the manifest the game loads, and the client's tables that must agree with them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../src/client/render/characterAssets.manifest.json';
import { ARCHETYPES, CHAR_OUTFITS, CHAR_OUTFIT_COUNT, REGIONS } from '../src/client/render/chars/outfits';
import { OUTFIT_COUNT } from '../src/shared/entityDefs';
import { RAG_RIG } from '../src/shared/ragdoll';
import { BONES, CLIPS, RAG_BONES, checkCharacters, type CharManifest } from '../tools/blender/characters/verify.ts';

const path = resolve(__dirname, '../public/assets/characters/characters.glb');

describe('character assets', () => {
  it('match the skeleton, the budgets and the clips the game plays', async () => {
    expect(existsSync(path), `${path} (run npm run assets)`).toBe(true);
    const r = await checkCharacters(path, ARCHETYPES, manifest as unknown as CharManifest);
    expect(r.problems).toEqual([]);
    expect((manifest as { bytes: number }).bytes).toBe(r.stats.bytes);
  });

  it('every outfit names a body the file has, and the outfit table is as long as the sim thinks', () => {
    expect(CHAR_OUTFIT_COUNT).toBe(OUTFIT_COUNT);
    const have = new Set(Object.keys(manifest.tris).map((k) => k.replace(/_lod\d$/, '')));
    for (const a of ARCHETYPES) expect(have.has(a), a).toBe(true);
    for (const o of CHAR_OUTFITS) expect(ARCHETYPES).toContain(o.arch);
  });

  it('the regions the game paints are the ones the file names, in order', () => {
    expect([...REGIONS]).toEqual(manifest.regions);
  });

  it('every population group wears outfits the table has, and nobody but Kudzu wears his', () => {
    const pop = JSON.parse(readFileSync(resolve(__dirname, '../data/cities/atlanta/population.json'), 'utf8'));
    for (const g of Object.values(pop.pedGroups) as { outfits: number[] }[]) for (const o of g.outfits) {
      expect(o).toBeGreaterThanOrEqual(1);
      expect(o).toBeLessThan(CHAR_OUTFIT_COUNT);
    }
    expect(CHAR_OUTFITS[0].arch).toBe('kudzu');
    CHAR_OUTFITS.slice(1).forEach((o) => expect(o.arch).not.toBe('kudzu'));
  });

  it('has a bone for each of the ragdoll bodies, in the ragdoll\'s own order', () => {
    expect(RAG_BONES.length).toBe(RAG_RIG.length);
    for (const b of RAG_BONES) expect(BONES).toContain(b);
  });

  it('lists the same clips the checks expect', () => {
    expect(Object.keys(manifest.clips).sort()).toEqual(Object.keys(CLIPS).sort());
  });
});
