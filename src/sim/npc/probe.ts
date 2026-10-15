import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import type { ClearProbe } from './flee';

let body: RAPIER.Capsule | null = null;

/**
 * How far a straight run from (x, y, z) is clear: a body-sized capsule swept against walls, decks, props and cars (from above
 * the kerbs a person steps over to a little over their head, so a low bridge they cannot stand under blocks the way), and drops or
 * climbs in the ground. The ground itself is left out of the sweep and judged by its height.
 */
export function probeFrom(sim: Simulation, x: number, y: number, z: number): ClearProbe {
  const R = sim.physics.R;
  body ??= new R.Capsule(0.4, 0.3);
  const b = body;
  return (heading, maxDist) => {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const hit = sim.physics.world.castShape({ x, y: y + 1.15, z }, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: 0, z: dz }, b, 0, maxDist, true, undefined, GROUPS.actorQuery, sim.physics.terrain);
    let clear = hit ? hit.time_of_impact : maxDist;
    for (let d = 1.5; d <= clear; d += 1.5) {
      if (Math.abs(sim.physics.groundHeight(x + dx * d, z + dz * d) - y) > 1.2) {
        clear = d - 1.5;
        break;
      }
    }
    return clear;
  };
}
