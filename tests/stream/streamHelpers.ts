/** Shared set-up for the streaming tests: a sim of the fixture city, a player moved by hand, and what to count. */
import { createHash } from 'node:crypto';
import type { Rings } from '../../src/shared/city';
import { SnapshotView } from '../../src/shared/snapshot';
import type { PedEntity, VehicleEntity } from '../../src/sim/entities';
import { Simulation } from '../../src/sim/Simulation';
import { FixtureTileSource } from '../../src/sim/stream/TileSource';
import type { FixtureOptions } from '../../src/shared/fixture';

/** Near and drop rings for the 384 m fixture tiles: from the middle of a tile the four edge neighbours are in, the corners not. */
export const SMALL_RINGS: Rings = { near: 260, drop: 420, far: 1500 };

export async function citySim(o: { traffic?: number; ambient?: boolean; seed?: number; rings?: Rings; budget?: number; fixture?: FixtureOptions; start?: 'spawn' | 'car' | 'jack'; parked?: number; pedBudget?: number } = {}): Promise<Simulation> {
  return Simulation.createCity({
    seed: o.seed ?? 1,
    source: new FixtureTileSource(o.fixture),
    traffic: o.traffic ?? 0,
    ambientPeds: o.ambient ?? false,
    pedBudget: o.pedBudget,
    start: o.start,
    parkedCars: o.parked ?? 0,
    clock: { minutes: 14 * 60, scale: 0 },
    streamOptions: { rings: o.rings ?? SMALL_RINGS, budget: o.budget },
  });
}

export const playerPed = (sim: Simulation) => sim.registry.get(sim.playerPedId) as PedEntity;
export const heroCar = (sim: Simulation) => sim.registry.get(sim.vehicleId) as VehicleEntity;

/** Puts the player (on foot) at (x, z) on the ground. */
export function movePlayer(sim: Simulation, x: number, z: number) {
  const p = playerPed(sim);
  p.controller.teleport(x, sim.groundAt(x, z) + 0.1, z);
}

/** Walks the player in a straight line to (x, z) at `speed` m/s (teleported a tick at a time), stepping the sim. */
export function travel(sim: Simulation, x: number, z: number, speed = 40) {
  const p = playerPed(sim).controller;
  const x0 = p.x, z0 = p.z;
  const d = Math.hypot(x - x0, z - z0);
  const n = Math.max(1, Math.ceil(d / (speed / 60)));
  for (let i = 1; i <= n; i++) {
    movePlayer(sim, x0 + ((x - x0) * i) / n, z0 + ((z - z0) * i) / n);
    sim.step();
    sim.drainEvents();
  }
}

/** A hash of the snapshot: every entity's state the client would see. */
export function snapshotHash(sim: Simulation): string {
  const v = new SnapshotView();
  sim.writeSnapshot(v);
  return createHash('sha1').update(new Uint8Array(v.buffer, 0, v.usedBytes)).digest('hex').slice(0, 12);
}

/** What must come back to where it was when the same tiles are loaded again. */
export function counts(sim: Simulation) {
  const st = sim.stream!;
  const w = sim.physics.world;
  let colliders = 0;
  w.forEachCollider(() => colliders++);
  let bodies = 0;
  w.forEachRigidBody(() => bodies++);
  let liveLanes = 0;
  for (let e = 0; e < st.lanes.count; e++) liveLanes += st.lanes.alive[e];
  let liveWalk = 0;
  for (let e = 0; e < st.walk.edgeCount; e++) liveWalk += st.walk.alive[e];
  return {
    tiles: st.readyIds().join(','),
    colliders,
    bodies,
    entities: sim.registry.size,
    liveLanes,
    laneIds: st.lanes.count,
    liveWalk,
    walkIds: st.walk.edgeCount,
    seamLinks: st.lanes.seamLinks().length,
    walkLinks: st.walk.linkCount,
    props: sim.physics.props.length,
    propCells: sim.physics.propCells.size,
    footprints: st.physics.footprints.partCount,
    meshes: sim.physics.staticMeshes.length,
    policeEdges: sim.police.graph.edges.filter((e) => e.pts.length > 0).length,
    junctions: st.lanes.junctionIndex.size,
  };
}
