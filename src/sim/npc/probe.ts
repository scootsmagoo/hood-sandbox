import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import type { ClearProbe } from './flee';

let ball: RAPIER.Ball | null = null;

/** How far a straight run from (x, y, z) is clear: walls and cars at chest height, and drops or climbs in the ground. */
export function probeFrom(sim: Simulation, x: number, y: number, z: number): ClearProbe {
  const R = sim.physics.R;
  ball ??= new R.Ball(0.3);
  const b = ball;
  return (heading, maxDist) => {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const hit = sim.physics.world.castShape({ x, y: y + 0.9, z }, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: 0, z: dz }, b, 0, maxDist, true, undefined, GROUPS.actorQuery);
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
