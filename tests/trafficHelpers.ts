import { buildLanes, type JunctionsInput, type RoadInput } from '../tools/pipeline/src/world/lanes';
import { parseLanes, type LanesData } from '../src/shared/lanes';
import type { TileData } from '../src/shared/tile';
import { Simulation } from '../src/sim/Simulation';
import type { TrafficCar } from '../src/sim/traffic/TrafficManager';
import type { SimEvent } from '../src/shared/protocol';
import { flatTile } from './helpers';

export const road = (id: string, pts: [number, number][], over: Partial<RoadInput> = {}): RoadInput => ({
  id, class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 7, points: pts.map(([x, z]) => [x, 0, z]), ...over,
});

const leg = (roadId: string, dir: [number, number], control: 'signals' | 'stop' | 'none', trim = 9) => ({
  road: roadId, node: 1, at: [0, 0] as [number, number], dir, approach: true, departure: true, trim, control,
  stopLine: [-dir[0] * 0, 0, 0] as [number, number, number], crosswalk: false,
});

/** Two two-way streets crossing at the origin, `half` metres long each way. */
export function crossroads(control: 'signals' | 'stop' | 'none' = 'signals', half = 400): { roads: RoadInput[]; junctions: JunctionsInput } {
  const roads = [road('ew', [[-half, 0], [half, 0]]), road('ns', [[0, -half], [0, half]])];
  const junctions: JunctionsInput = {
    junctions: [{
      id: 'j0', x: 0, y: 0, z: 0, control,
      legs: [leg('ew', [-1, 0], control), leg('ew', [1, 0], control), leg('ns', [0, -1], control), leg('ns', [0, 1], control)],
    }],
  };
  return { roads, junctions };
}

/** Lane graph data, built by the pipeline's generator and read back the way the game reads it. */
export function lanesFor(roads: RoadInput[], junctions: JunctionsInput = { junctions: [] }): LanesData {
  const file = JSON.parse(JSON.stringify(buildLanes(roads, junctions)));
  const data = parseLanes(file);
  if (!data) throw new Error('lanes did not parse');
  return data;
}

export function laneTile(lanes: LanesData): TileData {
  // The fixtures' stop lines are laid out at the junction's middle, so the signal heads generated from them would stand (solid) in the
  // road. Real tiles put them on the kerb; these tests are about the cars, not the poles.
  const bare = { ...lanes, junctions: lanes.junctions.map(({ heads: _heads, ...j }) => j) };
  return { ...flatTile(), lanes: bare };
}

export async function trafficSim(lanes: LanesData, opts: { traffic?: number; seed?: number; clockMinutes?: number } = {}): Promise<Simulation> {
  return Simulation.create({
    seed: opts.seed ?? 1, tile: laneTile(lanes), driver: false, parkedCars: 0, traffic: opts.traffic ?? 1,
    clock: { minutes: opts.clockMinutes ?? 14 * 60, scale: 0 },
  });
}

/** The lane edge of a road in a direction (1 along its points) and lane index, the first that ends at a junction when `atJunction`. */
export function laneOf(sim: Simulation, roadId: string, dir: 1 | -1, k = 0, which: 'first' | 'last' = 'first'): number {
  const g = sim.traffic!.graph;
  const out: number[] = [];
  g.data.edges.forEach((e, i) => { if (e.t === 0 && e.road === roadId && e.dir === dir && e.k === k) out.push(i); });
  if (out.length === 0) throw new Error(`no lane ${roadId} ${dir} ${k}`);
  // order along the direction of travel
  out.sort((a, b) => (dir === 1 ? g.pts[a][0] + g.pts[a][2] - (g.pts[b][0] + g.pts[b][2]) : g.pts[b][0] + g.pts[b][2] - (g.pts[a][0] + g.pts[a][2])));
  return which === 'first' ? out[0] : out[out.length - 1];
}

export function stepAll(sim: Simulation, ticks: number, each?: (tick: number) => void): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    events.push(...sim.drainEvents());
    each?.(i);
  }
  return events;
}

export const carsOn = (sim: Simulation): TrafficCar[] => sim.traffic!.cars;
