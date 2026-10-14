/**
 * The carjacking: walk up to the driver's door of a car with someone in it, press the use button,
 * and for about a second and a half the sim runs the scene on a script (the stand-in timing is in
 * shared/doors.ts): the door opens, the driver is dragged out onto the road and let go, and the
 * player climbs in and takes the wheel. The driver then flees or fights, by the personality they
 * rolled when they were created.
 *
 * Everything here is the sim moving two bodies by hand while their physics is off.
 */
import type { EntityId } from '../shared/entities';
import { carjackPhase, doorGeometry, SEAT_DROP, type CarjackPhase } from '../shared/doors';
import { lerp, rotateVec, yawFromDir, wrapAngle } from '../shared/math';
import { GROUPS } from './physics/rapier';
import type { PedEntity, VehicleEntity } from './entities';
import type { Reaction } from './npc/brain';
import type { Simulation } from './Simulation';

export interface CarjackState {
  jackerId: EntityId;
  victimId: EntityId;
  vehicleId: EntityId;
  /** Seconds since it began. */
  t: number;
  reaction: Reaction;
  /** The jacker's feet when it began. */
  from: { x: number; y: number; z: number };
  /** The victim's feet in the seat and on the ground where they land. */
  landing: { x: number; y: number; z: number };
  phase: CarjackPhase;
  victimFreed: boolean;
}

const MAX_JACK_SPEED = 2.5;

/** Whether a ped is standing at an occupied car's driver door, ready to pull the driver out. */
export function findJackable(sim: Simulation, ped: PedEntity): VehicleEntity | null {
  const c = ped.controller;
  let best: VehicleEntity | null = null;
  let bestDist = Infinity;
  for (const v of sim.vehicles()) {
    if (!v.occupantId || v.occupantId === ped.id || sim.isReserved(v.id)) continue;
    const occupant = sim.registry.get(v.occupantId) as PedEntity | undefined;
    if (!occupant?.brain) continue; // never pull out a player
    if (v.car.speed > MAX_JACK_SPEED) continue;
    const h = v.car.h;
    const pose = v.car.pose();
    const l = rotateVecInvLocal(pose.q, c.x - pose.x, c.y - pose.y, c.z - pose.z);
    if (Math.abs(l.y) > 2.2) continue;
    const g = doorGeometry(h);
    const d = Math.hypot(l.x - g.stand.x, l.z - g.stand.z);
    if (l.x > 0 && d < (best ? bestDist : 1.45)) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

function rotateVecInvLocal(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number) {
  return rotateVec({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z);
}

/** Floor height under (x, z), looking down from `fromY`. Falls back to the heightmap. */
function floorY(sim: Simulation, x: number, fromY: number, z: number): number {
  const R = sim.physics.R;
  const hit = sim.physics.world.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 4, true, undefined, GROUPS.cameraQuery);
  return hit ? fromY - hit.timeOfImpact : sim.physics.groundHeight(x, z);
}

/** Begins the scene. Returns false if it cannot (no driver, or one already going). */
export function startCarjack(sim: Simulation, jacker: PedEntity, veh: VehicleEntity): boolean {
  const victim = sim.registry.get(veh.occupantId) as PedEntity | undefined;
  if (!victim?.brain || sim.isReserved(veh.id)) return false;
  const g = doorGeometry(veh.car.h);
  const pose = veh.car.pose();
  const land = rotateVec(pose.q, g.eject.x, 0, g.eject.z);
  const lx = pose.x + land.x;
  const lz = pose.z + land.z;
  const ly = floorY(sim, lx, pose.y + 1.2, lz);
  const c = jacker.controller;
  const st: CarjackState = {
    jackerId: jacker.id,
    victimId: victim.id,
    vehicleId: veh.id,
    t: 0,
    reaction: victim.brain.personality.reaction,
    from: { x: c.x, y: c.y, z: c.z },
    landing: { x: lx, y: ly, z: lz },
    phase: carjackPhase(0),
    victimFreed: false,
  };
  sim.carjacks.push(st);
  jacker.busy = true;
  jacker.input.moveX = jacker.input.moveY = 0;
  c.setEnabled(false);
  victim.brain.enter('dragged');
  victim.busy = true;
  sim.emit({ type: 'carjack', tick: sim.tick, pedId: jacker.id, victimId: victim.id, vehicleId: veh.id, x: pose.x, y: pose.y, z: pose.z, reaction: st.reaction });
  return true;
}

/** Advances one carjack by a tick. Returns true when it is over. */
export function stepCarjack(sim: Simulation, st: CarjackState, dt: number): boolean {
  const jacker = sim.registry.get(st.jackerId) as PedEntity | undefined;
  const victim = sim.registry.get(st.victimId) as PedEntity | undefined;
  const veh = sim.registry.get(st.vehicleId) as VehicleEntity | undefined;
  if (!jacker || !veh) return true; // something vanished: let the player have control back
  st.t += dt;
  const ph = carjackPhase(st.t, st.phase);
  const pose = veh.car.pose();
  const g = doorGeometry(veh.car.h);
  const at = (lx: number, ly: number, lz: number) => {
    const w = rotateVec(pose.q, lx, ly, lz);
    return { x: pose.x + w.x, y: pose.y + w.y, z: pose.z + w.z };
  };
  const seat = at(g.seat.x, g.seat.y - SEAT_DROP, g.seat.z);
  const stand = at(g.stand.x, 0, g.stand.z);
  const standY = floorY(sim, stand.x, pose.y + 1.2, stand.z);
  veh.doorOpen = st.t > 0.02 && st.t < 1.3;

  // The jacker steps to the door, then climbs across to the seat.
  const c = jacker.controller;
  const toDoor = Math.min(1, st.t / 0.25);
  const sx = lerp(st.from.x, stand.x, toDoor);
  const sz = lerp(st.from.z, stand.z, toDoor);
  const sy = lerp(st.from.y, standY, toDoor);
  c.x = lerp(sx, seat.x, ph.climb);
  c.z = lerp(sz, seat.z, ph.climb);
  c.y = lerp(sy, seat.y, ph.climb);
  // Face the seat.
  c.yaw = yawFromDir(seat.x - stand.x, seat.z - stand.z);

  if (victim && !st.victimFreed) {
    const vc = victim.controller;
    if (!ph.released) {
      vc.x = lerp(seat.x, st.landing.x, ph.pull);
      vc.z = lerp(seat.z, st.landing.z, ph.pull);
      // Up and over the sill on the way out.
      vc.y = lerp(seat.y, st.landing.y, ph.pull) + Math.sin(ph.pull * Math.PI) * 0.25;
      vc.yaw = veh.car.yaw + Math.PI / 2;
    } else {
      st.victimFreed = true;
      victim.vehicleId = 0;
      victim.busy = false;
      veh.occupantId = 0;
      vc.setEnabled(true);
      vc.teleport(st.landing.x, st.landing.y, st.landing.z, wrapAngle(veh.car.yaw + Math.PI / 2));
      victim.brain!.release();
    }
  }

  if (!ph.done) return false;

  // In the seat, hands on the wheel.
  jacker.vehicleId = veh.id;
  veh.occupantId = jacker.id;
  veh.owner = 1;
  jacker.owner = 1;
  veh.doorOpen = false;
  jacker.busy = false;
  sim.emit({ type: 'vehicle:enter', tick: sim.tick, pedId: jacker.id, vehicleId: veh.id });
  return true;
}
