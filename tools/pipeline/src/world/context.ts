/**
 * Neighbourhood context for the buildings whose data says little: what stands around a building tells what it probably is.
 * A narrow low-rise that shares its walls with its neighbours is a brick commercial row; a block of towers dated 1965 to 1985
 * is a modern core; a street of mapped brick buildings is more likely brick all the way along.
 *
 * Only what the feeds state counts as evidence (a year, a material, a style from data), never what the pipeline inferred,
 * so a guess cannot feed another guess.
 */
import type { V2 } from '../geo.js';
import { ringBounds, ringCentroid } from '../geo.js';
import type { Building } from './buildings.js';
import { eraOfYear, ringsArea } from './classify.js';
import { minAreaObb } from './shape.js';
import type { Material } from './appearance.js';

export interface BuildingContext {
  /** the footprint shares a wall (within 0.8 m) with another building's */
  attached: boolean;
  /** the shorter side of the footprint's bounding box, m */
  frontage: number;
  /** buildings whose centre is within 70 m */
  density: number;
  /** mean height of those, m */
  meanHeight: number;
  /** the eras (1 to 4) of dated neighbours within 90 m, by count (index 0 unused) */
  eras: [number, number, number, number, number];
  /** the materials of neighbours with a material from data, within 90 m */
  materials: Partial<Record<Material, number>>;
}

const EVIDENCE_R = 90;
const DENSITY_R = 70;

function distToRing(p: V2, ring: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz)));
  }
  return best;
}

/** The context of every building, by id. */
export function buildContexts(buildings: Building[]): Map<string, BuildingContext> {
  const cell = 90;
  const centres = buildings.map((b) => ringCentroid(b.rings[0]));
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  centres.forEach((c, i) => {
    const k = key(c[0], c[1]);
    const a = grid.get(k);
    if (a) a.push(i); else grid.set(k, [i]);
  });
  const near = (i: number, r: number): number[] => {
    const [cx, cz] = centres[i];
    const out: number[] = [];
    for (let gx = Math.floor((cx - r) / cell); gx <= Math.floor((cx + r) / cell); gx++) {
      for (let gz = Math.floor((cz - r) / cell); gz <= Math.floor((cz + r) / cell); gz++) {
        for (const j of grid.get(`${gx},${gz}`) ?? []) if (j !== i && Math.hypot(centres[j][0] - cx, centres[j][1] - cz) <= r) out.push(j);
      }
    }
    return out;
  };

  const out = new Map<string, BuildingContext>();
  buildings.forEach((b, i) => {
    const ring = b.rings[0];
    const bb = ringBounds(ring);
    const obb = minAreaObb(ring);
    const frontage = Math.min(obb.L, obb.W) * 2;
    const around = near(i, EVIDENCE_R);
    let attached = false;
    for (const j of around) {
      const o = buildings[j];
      const ob = ringBounds(o.rings[0]);
      if (ob.minX > bb.maxX + 1 || ob.maxX < bb.minX - 1 || ob.minZ > bb.maxZ + 1 || ob.maxZ < bb.minZ - 1) continue;
      // two or more vertices of this footprint on the other's outline: a shared wall
      let on = 0;
      for (const p of ring) if (distToRing(p, o.rings[0]) < 0.8) on++;
      if (on >= 2) {
        attached = true;
        break;
      }
    }
    const dens = around.filter((j) => Math.hypot(centres[j][0] - centres[i][0], centres[j][1] - centres[i][1]) <= DENSITY_R);
    const eras: BuildingContext['eras'] = [0, 0, 0, 0, 0];
    const materials: BuildingContext['materials'] = {};
    for (const j of around) {
      const l = buildings[j].look;
      if (!l) continue;
      if (l.year && l.yearSrc) eras[eraOfYear(l.year)]++;
      if (l.material && l.materialSrc) materials[l.material] = (materials[l.material] ?? 0) + 1;
    }
    out.set(b.id, {
      attached,
      frontage,
      density: dens.length,
      meanHeight: dens.length ? dens.reduce((s, j) => s + buildings[j].height, 0) / dens.length : b.height,
      eras,
      materials,
    });
  });
  void ringsArea;
  return out;
}
