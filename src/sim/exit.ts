/**
 * Getting out of a car: where the body lands, and the hand-off of seat and ownership. Shared by the
 * player's exit button, an officer stepping out, and a death or explosion that throws the occupant out.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { rotateVec } from '../shared/math';
import { PED, PED_FEET_OFFSET } from './character/locomotion';
import { AI_OWNER, type PedEntity, type VehicleEntity } from './entities';
import { GROUPS } from './physics/rapier';
import type { Simulation } from './Simulation';

let capsule: RAPIER.Capsule | null = null;

/** The first clear spot beside, behind or in front of the car; the roof if none is. */
export function findExitSpot(sim: Simulation, veh: VehicleEntity) {
  const R = sim.physics.R;
  const world = sim.physics.world;
  const car = veh.car;
  const pose = car.pose();
  const half = car.h.chassis.halfExtents;
  const side = half[0] + 0.8;
  const ends = half[2] + 0.9;
  const candidates: [number, number][] = [
    [side, 0.3], [-side, 0.3], [0, -ends], [0, ends], [side, -1.5], [-side, -1.5],
  ];
  capsule ??= new R.Capsule(PED.halfHeight, PED.radius);
  for (const [lx, lz] of candidates) {
    const w = rotateVec(pose.q, lx, 0, lz);
    const x = pose.x + w.x;
    const z = pose.z + w.z;
    // Find the floor below a point a little above the car's floor.
    const from = pose.y + 1.0;
    const hit = world.castRay(new R.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 3, true, undefined, GROUPS.cameraQuery);
    if (!hit) continue;
    const y = from - hit.timeOfImpact;
    const blocked = world.intersectionWithShape(
      { x, y: y + PED_FEET_OFFSET + 0.08, z },
      { x: 0, y: 0, z: 0, w: 1 },
      capsule,
      undefined,
      GROUPS.actorQuery,
      undefined,
      car.body,
    );
    if (!blocked) return { x, y: y + 0.02, z };
  }
  const up = rotateVec(pose.q, 0, 1, 0);
  return { x: pose.x + up.x * 2.2, y: pose.y + up.y * 2.2, z: pose.z + up.z * 2.2 };
}

/** Puts a ped that sits in a car onto the ground beside it. Returns false if the ped is not in `veh`. */
export function leaveVehicle(sim: Simulation, ped: PedEntity, veh: VehicleEntity): boolean {
  if (ped.vehicleId !== veh.id) return false;
  const spot = findExitSpot(sim, veh);
  const c = ped.controller;
  c.setEnabled(true);
  c.teleport(spot.x, spot.y, spot.z, veh.car.yaw);
  ped.vehicleId = 0;
  if (veh.occupantId === ped.id) {
    veh.occupantId = 0;
    if (veh.owner !== AI_OWNER) veh.owner = 0;
  }
  ped.owner = ped.role === 'player' ? ped.owner : 0;
  sim.emit({ type: 'vehicle:exit', tick: sim.tick, pedId: ped.id, vehicleId: veh.id });
  return true;
}
