/**
 * The airport's part of the bake (world/aeroway*.ts) on small made-up airports: runway designators and ends, the ground under the
 * pavement (a narrow cut bridged as a deck, broad slopes kept), the pavement as one set of non-overlapping polygons clipped to the
 * tile, the paint, the taxi graph's stands, and the merged prefetch's cut of an Overpass answer into tiles.
 */
import { describe, expect, it } from 'vitest';
import { createProjector, type V2 } from '../src/geo.js';
import { parseAirport, runwayDesignators } from '../src/world/aeroway.js';
import { AirfieldField, airfieldClasses, buildAirfieldMarkings, markingSink, runwayTest, tessellate, DECK_MIN } from '../src/world/aerowaySurface.js';
import { makeHeightmap } from '../src/world/terrain.js';
import { MeshBuilder } from '../src/mesh/builder.js';
import { elementBox } from '../src/city/prefetch.js';
import type { OsmData, OsmElement } from '../src/sources/osm.js';

const proj = createProjector('+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m', { lat: 33.64, lon: -84.43 });
const ll = (x: number, z: number) => {
  const [lon, lat] = proj.toLonLat(x, z);
  return { lat, lon };
};
let nid = 1;
const way = (id: number, tags: Record<string, string>, pts: V2[], nodes?: number[]): OsmElement => ({ type: 'way', id, tags, nodes: nodes ?? pts.map(() => nid++), geometry: pts.map((p) => ll(p[0], p[1])) });

/** A 2 km east-west runway "09/27" at z = 0, a taxiway north of it joined at both ends, an apron, a stand's lead-in. */
function airport(): OsmData {
  const r1 = 9001, r2 = 9002;
  const t = [9101, 9102, 9103, 9104];
  return {
    elements: [
      way(1, { aeroway: 'runway', ref: '09/27', width: '45' }, [[-1000, 0], [0, 0], [1000, 0]], [r1, 9003, r2]),
      way(2, { aeroway: 'taxiway', ref: 'A' }, [[-1000, 0], [-1000, -200], [1000, -200], [1000, 0]], [r1, t[0], t[1], r2]),
      way(3, { aeroway: 'apron', ref: 'Ramp 1' }, [[-300, -260], [300, -260], [300, -500], [-300, -500], [-300, -260]], [t[2], 8001, 8002, 8003, t[2]]),
      way(4, { aeroway: 'parking_position', ref: 'A1' }, [[0, -260], [0, -320]]),
      { type: 'node', id: 7001, lat: ll(0, -320).lat, lon: ll(0, -320).lon, tags: { aeroway: 'parking_position', ref: 'A1' } },
    ],
  };
}

describe('aeroway', () => {
  it('reads the designators of both ends, the reciprocal when only one is given', () => {
    expect(runwayDesignators('09L/27R')).toEqual(['09L', '27R']);
    expect(runwayDesignators('10')).toEqual(['10', '28']);
    expect(runwayDesignators('8L')).toEqual(['08L', '26R']);
  });

  it('parses runways with the right end for each designator', () => {
    const ap = parseAirport(airport(), proj);
    expect(ap.runways).toHaveLength(1);
    const rw = ap.runways[0];
    expect(rw.length).toBeCloseTo(2000, -1);
    // 09 is landed on heading east: its end is the west one
    const e09 = rw.ends.find((e) => e.ref === '09')!;
    expect(e09.end[0]).toBeLessThan(0);
    expect(e09.dir[0]).toBeGreaterThan(0.99);
    expect(ap.areas.filter((a) => a.kind === 'apron')).toHaveLength(1);
  });

  it('levels the ground under the pavement and bridges a narrow cut as a deck, keeping a broad slope', () => {
    const ap = parseAirport(airport(), proj);
    const hm = makeHeightmap(601, 301, 4, -1200, -600);
    for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) {
      const x = hm.minX + c * 4, z = hm.minZ + r * 4;
      // a gentle slope east, a bump, and a 40 m wide, 12 m deep cut running north-south under the runway at x = 400
      hm.data[r * hm.cols + c] = 0.002 * x + 0.3 * Math.sin(x * 0.05) * Math.sin(z * 0.04) - (Math.abs(x - 400) < 20 ? 12 : 0);
    }
    const f = new AirfieldField(hm, ap);
    expect(f.deck(400, 0)).toBe(true);
    expect(f.deck(-500, 0)).toBe(false);
    // the surface keeps the slope (0.002 x 1000 m = 2 m east to west)
    expect(f.surface(900, 0) - f.surface(-900, 0)).toBeGreaterThan(2.5);
    f.apply(hm);
    const at = (x: number, z: number) => hm.data[Math.round((z - hm.minZ) / 4) * hm.cols + Math.round((x - hm.minX) / 4)];
    // the cut stays open under the deck, the pavement elsewhere is smooth
    expect(at(400, 0)).toBeLessThan(-8);
    expect(Math.abs(at(-500, 0) - f.surface(-500, 0))).toBeLessThan(0.05);
    expect(f.surface(400, 0) - f.dem0[Math.round((0 - hm.minZ) / 4) * hm.cols + Math.round((400 - hm.minX) / 4)]).toBeGreaterThan(DECK_MIN);
  });

  it('makes the pavement of a tile as classes that never overlap, clipped to it', () => {
    const ap = parseAirport(airport(), proj);
    const b = { minX: -512, minZ: -512, maxX: 512, maxZ: 512 };
    const cls = airfieldClasses(ap, b);
    const area = (mp: typeof cls.runway) => {
      let s = 0;
      tessellate(mp, 50, (a, q, c) => (s += Math.abs((q[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (q[1] - a[1])) / 2));
      return s;
    };
    // the runway across the tile: 1024 m x 45 m
    expect(area(cls.runway)).toBeCloseTo(1024 * 45, -2);
    // a point on the runway is in no other class
    const inMp = (mp: typeof cls.runway, x: number, z: number) => mp.some((poly) => {
      const r = poly[0];
      let c = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
      return c;
    });
    expect(inMp(cls.runway, 10, 5)).toBe(true);
    expect(inMp(cls.shoulder, 10, 5)).toBe(false);
    expect(inMp(cls.shoulder, 10, 26)).toBe(true);
    expect(inMp(cls.apron, 0, -400)).toBe(true);
    // nothing past the tile
    for (const k of ['runway', 'taxiway', 'apron', 'shoulder'] as const) for (const poly of cls[k]) for (const r of poly) for (const p of r) {
      expect(p[0]).toBeGreaterThanOrEqual(b.minX - 1e-6);
      expect(p[0]).toBeLessThanOrEqual(b.maxX + 1e-6);
    }
  });

  it('paints threshold bars, designators and centrelines, and taxiway lines that stop at the runway', () => {
    const ap = parseAirport(airport(), proj);
    const mb = new MeshBuilder();
    const b = { minX: -1100, minZ: -600, maxX: 1100, maxZ: 100 };
    const st = buildAirfieldMarkings(ap, markingSink(mb, b, () => 0), runwayTest(ap));
    expect(st.runways).toBe(1);
    expect(st.leadIns).toBe(1);
    expect(st.taxiwayM).toBeGreaterThan(1500);
    expect(mb.triangleCount).toBeGreaterThan(200);
    // no taxiway paint on the runway's pavement except the runway's own white paint: every yellow vertex is off the runway
    // (a 4 m piece of line may reach over the runway's edge: deeper than 3 m in is wrong)
    const onRw = runwayTest(ap, -3);
    for (let i = 0; i < mb.vertexCount; i++) {
      const yellow = mb.colors[i * 3 + 2] < 0.2;
      if (yellow) expect(onRw(mb.positions[i * 3], mb.positions[i * 3 + 2])).toBe(false);
    }
  });

  it('cuts a merged Overpass answer per tile by the boxes of its elements', () => {
    const n = { type: 'node', id: 1, lat: 33.6, lon: -84.4 } as OsmElement;
    expect(elementBox(n)).toEqual([-84.4, 33.6, -84.4, 33.6]);
    const w = { type: 'way', id: 2, geometry: [{ lat: 33.6, lon: -84.4 }, { lat: 33.62, lon: -84.38 }] } as OsmElement;
    expect(elementBox(w)).toEqual([-84.4, 33.6, -84.38, 33.62]);
    const wb = { ...w, bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 } } as OsmElement & { bounds: unknown };
    expect(elementBox(wb as never)).toEqual([2, 1, 4, 3]);
  });
});
