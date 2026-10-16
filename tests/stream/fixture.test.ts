/** The streaming test city itself: tiles meet at their seams (heights, lanes, walk paths), and the index is well formed. */
import { describe, expect, it } from 'vitest';
import { parseCityIndex } from '../../src/shared/city';
import { decodeFarTile } from '../../src/shared/farTile';
import { fixtureFarBytes, fixtureIndex, fixtureTile } from '../../src/shared/fixture';
import { matchLanePorts, matchWalkPorts, OPPOSITE, seamPorts, SIDES } from '../../src/shared/seams';

describe('the fixture city', () => {
  const index = parseCityIndex(fixtureIndex());
  const tiles = new Map(index.tiles.map((t) => [t.id, fixtureTile(t.i, t.j)]));

  it('is a 3 x 3 grid with neighbours', () => {
    expect(index.tiles.length).toBe(9);
    const c = index.tiles.find((t) => t.id === '0_0')!;
    expect(c.neighbours).toEqual({ n: '0_-1', e: '1_0', s: '0_1', w: '-1_0' });
  });

  it('shares its seam samples exactly', () => {
    const a = tiles.get('0_0')!, b = tiles.get('1_0')!;
    const n = a.manifest.heightmap.cols;
    for (let r = 0; r < n; r++) expect(a.heights[r * n + n - 1]).toBe(b.heights[r * n]);
  });

  it('has lanes, paths and buildings in every tile', () => {
    for (const t of tiles.values()) {
      expect(t.lanes!.edges.length).toBeGreaterThan(40);
      expect(t.paths!.nodes.length).toBeGreaterThan(40);
      expect(t.fixture.buildings.length).toBeGreaterThan(4);
    }
  });

  it('matches every lane and walk port across every seam', () => {
    let lanePairs = 0, walkPairs = 0;
    for (const e of index.tiles) {
      const pe = seamPorts(e.id, e.bounds, tiles.get(e.id)!);
      for (const side of SIDES) {
        const nb = e.neighbours?.[side];
        if (!nb || nb < e.id) continue;
        const ne = index.tiles.find((t) => t.id === nb)!;
        const pn = seamPorts(nb, ne.bounds, tiles.get(nb)!);
        const a = pe.sides[side]!, b = pn.sides[OPPOSITE[side]]!;
        const lm = matchLanePorts(a.lanes, b.lanes);
        expect(lm.unmatched.map((p) => p.key)).toEqual([]);
        lanePairs += lm.pairs.length;
        const wm = matchWalkPorts(a.walk, b.walk);
        expect(wm.unmatched.length).toBe(0);
        walkPairs += wm.pairs.length;
      }
    }
    // 12 seams, each crossed by 2 streets (4-lane avenue or 2-lane streets)
    expect(lanePairs).toBeGreaterThanOrEqual(12 * 2 * 2);
    expect(walkPairs).toBeGreaterThanOrEqual(12 * 2 * 2);
  });

  it('round-trips its far level of detail', () => {
    const far = decodeFarTile(fixtureFarBytes(0, 0).slice().buffer);
    expect(far.grid.n).toBe(33);
    expect(far.buildings.length).toBe(tiles.get('0_0')!.fixture.buildings.length);
  });
});
