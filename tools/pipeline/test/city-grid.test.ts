import { describe, expect, it } from 'vitest';
import { cellBakeConfig, gridCells, loadGrid, MAX_RESIDUAL, selectCells } from '../src/city/grid';
import { demRequest } from '../src/sources/dem';
import type { CityGridSpec } from '../src/config';
import { loadTileConfig } from '../src/config';

const spec = (regions: CityGridSpec['regions']): CityGridSpec => ({
  id: 't', name: 't', origin: { lat: 33.7543, lon: -84.3898 }, baseElevation: 300, tileSizeM: 1024, heightmapCellSizeM: 4, queryMarginM: 160, out: 'x', regions,
});

describe('city grid', () => {
  it('lists cells in region order, rows north to south, a cell once (the first region wins)', () => {
    const cells = gridCells(spec([
      { id: 'a', name: 'a', cells: [[0, 0], [1, 1]] },
      { id: 'b', name: 'b', cells: [[1, 1], [2, 1]] },
    ]));
    expect(cells.map((c) => `${c.region}:${c.id}`)).toEqual(['a:0_0', 'a:1_0', 'a:0_1', 'a:1_1', 'b:2_1']);
    expect(cells[3].bounds).toEqual({ minX: 1024, minZ: 1024, maxX: 2048, maxZ: 2048 });
  });

  it('reads the M2 grid of city.json', () => {
    const g = loadGrid();
    expect(g.spec.id).toBe('m2');
    expect(g.cells.length).toBe(80);
    expect(g.cells[0].region).toBe('downtown');
    const regions = [...new Set(g.cells.map((c) => c.region))];
    expect(regions).toEqual(['downtown', 'midtown', 'eastside', 'peachtree', 'buckhead', 'west-paces', 'vinings']);
    expect(selectCells(g, { only: ['0_0', '-1_-1'] }).map((c) => c.id)).toEqual(['-1_-1', '0_0']);
    expect(selectCells(g, { regions: ['vinings'] }).length).toBe(6);
    expect(() => selectCells(g, { only: ['99_99'] })).toThrow();
    // landmarks fall in their regions
    const at = (lat: number, lon: number) => {
      const [x, z] = g.projector.toGame(lon, lat);
      return g.cells.find((c) => c.i === Math.floor(x / 1024) && c.j === Math.floor(z / 1024))?.region;
    };
    expect(at(33.7543, -84.3898)).toBe('downtown');
    expect(at(33.7726, -84.3655)).toBe('midtown'); // Ponce City Market
    expect(at(33.7645, -84.3493)).toBe('eastside'); // Little Five Points
    expect(at(33.8463, -84.3621)).toBe('buckhead'); // Lenox
    expect(at(33.865, -84.468)).toBe('vinings');
  });

  it('bakes each cell in a frame centred on it, a translation of the city frame (residual under 1e-6 m)', () => {
    const g = loadGrid();
    for (const c of g.cells) {
      const cb = cellBakeConfig(g, c);
      expect(cb.residual).toBeLessThan(MAX_RESIDUAL);
      expect(cb.dx).toBe(c.i * 1024 + 512);
      expect(cb.dz).toBe(c.j * 1024 + 512);
      // a point of the local frame maps to the same lon/lat as the translated point of the city frame
      const [lon, lat] = cb.cfg.projector.toLonLat(-300, 211);
      const [x, z] = g.projector.toGame(lon, lat);
      expect(Math.abs(x - (-300 + cb.dx))).toBeLessThan(1e-6);
      expect(Math.abs(z - (211 + cb.dz))).toBeLessThan(1e-6);
    }
    const cb = cellBakeConfig(g, g.cells.find((c) => c.id === '0_0')!);
    expect(cb.cfg.bounds).toEqual({ minX: -512, minZ: -512, maxX: 512, maxZ: 512 });
    expect(cb.cfg.cols).toBe(257);
    expect(cb.cfg.id).toBe('atlanta/m2/0_0');
    expect(cb.cfg.cacheDir).toMatch(/cache\/atlanta\/m2\/tiles\/0_0$/);
    expect(cb.cfg.outDir).toMatch(/cache\/atlanta\/m2\/build\/0_0$/);
  });

  it('snaps the DEM of neighbours to one pixel grid (their shared edges are the same numbers), and the M1 pixels are square in degrees too', () => {
    const g = loadGrid();
    const a = demRequest(cellBakeConfig(g, g.cells.find((c) => c.id === '0_0')!).cfg);
    const b = demRequest(cellBakeConfig(g, g.cells.find((c) => c.id === '1_0')!).cfg);
    const al = cellBakeConfig(g, g.cells[0]).cfg.demAlign!;
    // b starts on a pixel edge of a's grid
    const k = (b.box.west - a.box.west) / al.lonStep;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    expect(a.w).toBeGreaterThan(600);
    expect(Math.abs((a.box.east - a.box.west) / a.w - al.lonStep)).toBeLessThan(1e-12);
    // M1: no alignment, but its pixels square in degrees too (exportImage makes them so: asked for metre-square ones, it stretched
    // the y extent, and the image was labelled with a box it did not cover), the query box within whole pixels of it
    const m1 = demRequest(loadTileConfig());
    const q = loadTileConfig().queryBox;
    expect(Math.abs((m1.box.east - m1.box.west) / m1.w - (m1.box.north - m1.box.south) / m1.h)).toBeLessThan(1e-12);
    expect(m1.box.west).toBeLessThanOrEqual(q.west);
    expect(m1.box.north).toBeGreaterThanOrEqual(q.north);
    expect(m1.file).toMatch(/m1-five-points\/dem-3dep-sq-\d+x\d+\.tif$/);
  });
});
