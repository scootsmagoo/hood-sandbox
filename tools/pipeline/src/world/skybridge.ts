/**
 * Skybridges: the covered walkways OSM maps as `building=bridge`. They float over the street (the heights are
 * `skybridgeHeights` in buildings.ts), so the ground under them is open: not a wall in the collision, not a building to the
 * paths and props, and in the occlusion field a roof over the street rather than a block down to it.
 */
import type { V2 } from '../geo.js';
import { minAreaObb } from './shape.js';
import { surfaceHeight, type Heightmap } from './terrain.js';
import type { OcclusionField } from './ao.js';

/** The highest ground under a footprint (its corners, the middle of its edges, and a line along its long axis): the height its clearance is measured from. */
export function skybridgeDatum(outer: V2[], hm: Heightmap, ground: (hm: Heightmap, x: number, z: number) => number = surfaceHeight): number {
  let top = -Infinity;
  const at = (x: number, z: number) => { top = Math.max(top, ground(hm, x, z)); };
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    at(a[0], a[1]);
    at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  const o = minAreaObb(outer);
  const steps = Math.max(2, Math.ceil((2 * o.L) / 3));
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * 2 - 1;
    at(o.cx + o.ax * o.L * t, o.cz + o.az * o.L * t);
  }
  return top;
}

/** Marks the ground under a raised piece (underside at absolute `undersideY`) in the occlusion field, as a deck is: a roof over the street. */
export function addRaisedToField(field: OcclusionField, rings: V2[][], undersideY: number): void {
  const o = minAreaObb(rings[0]);
  const half = Math.max(0, o.L - o.W);
  field.addDeck([o.cx - o.ax * half, o.cz - o.az * half], [o.cx + o.ax * half, o.cz + o.az * half], o.W, undersideY);
}

/**
 * The collision footprint of a floating building: its corners drawn in `d` m towards the middle. A skybridge's outline is often drawn
 * on the very nodes of the towers it joins, and the sim's footprint index (`src/shared/footprints.ts`) tells the height a footprint's
 * walls start at from the lowest wall that has a corner at the same place: a tube sharing a corner with a tower would start at the
 * ground, and the street under it would be "inside" it. The drawn mesh is not moved; the gap is a few cm, 7 m up.
 */
export function insetForCollision(rings: V2[][], d = 0.12): V2[][] {
  const outer = rings[0];
  const cx = outer.reduce((a, p) => a + p[0], 0) / outer.length;
  const cz = outer.reduce((a, p) => a + p[1], 0) / outer.length;
  const moved = outer.map((p): V2 => {
    const l = Math.hypot(cx - p[0], cz - p[1]);
    return l > 3 * d ? [p[0] + ((cx - p[0]) / l) * d, p[1] + ((cz - p[1]) / l) * d] : p;
  });
  return [moved, ...rings.slice(1)];
}
