/**
 * Getting out of a car: where the body lands, and the hand-off of seat and ownership. Shared by the
 * player's exit button, an officer stepping out, and a death or explosion that throws the occupant out.
 */
import { rotateVec } from '../shared/math';
import { PED } from './character/locomotion';
import { AI_OWNER, type PedEntity, type VehicleEntity } from './entities';
import { GROUPS } from './physics/rapier';
import type { Simulation } from './Simulation';

/**
 * The first clear spot beside, behind or in front of the car: on the floor, not inside a building, clear of walls, props
 * and other cars, and with nothing solid between it and the car (a wall the car is parked against does not have a spot
 * on its far side). Failing those, the nearest clear spot round the car; the roof only when there is none.
 */
export function findExitSpot(sim: Simulation, veh: VehicleEntity, preferred?: { x: number; z: number }) {
  const phys = sim.physics;
  const car = veh.car;
  const pose = car.pose();
  const half = car.h.chassis.halfExtents;
  const side = half[0] + 0.8;
  const ends = half[2] + 0.9;
  const candidates: [number, number][] = [
    [side, 0.3], [-side, 0.3], [0, -ends], [0, ends], [side, -1.5], [-side, -1.5],
    [side + 0.7, 0.3], [-side - 0.7, 0.3], [side, 1.5], [-side, 1.5], [0, -ends - 0.8], [0, ends + 0.8],
  ];
  const test = { vehicles: true, ignoreBody: car.body, radius: PED.radius } as const;
  const ok = (x: number, z: number) => {
    // Find the floor below a point a little above the car's floor.
    const from = pose.y + 1.0;
    const y = phys.floorBelow(x, from, z, 3);
    if (Number.isNaN(y)) return null;
    if (phys.blockedAt(x, y + 0.02, z, test)) return null;
    // Nothing solid between the car and the spot, at hip height.
    const dx = x - pose.x, dz = z - pose.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.01 && sim.physics.world.castRay(new phys.R.Ray({ x: pose.x, y: y + 0.9, z: pose.z }, { x: dx / d, y: 0, z: dz / d }), d, true, undefined, GROUPS.cameraQuery)) return null;
    return { x, y: y + 0.02, z };
  };
  if (preferred) {
    const spot = ok(preferred.x, preferred.z);
    if (spot) return spot;
  }
  for (const [lx, lz] of candidates) {
    const w = rotateVec(pose.q, lx, 0, lz);
    const spot = ok(pose.x + w.x, pose.z + w.z);
    if (spot) return spot;
  }
  const near = phys.clearSpot(pose.x, pose.y - 0.35, pose.z, 6, test);
  if (near) return near;
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
