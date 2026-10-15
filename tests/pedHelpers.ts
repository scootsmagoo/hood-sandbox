import type { JunctionsData } from '../src/shared/tile';
import type { TileData } from '../src/shared/tile';
import type { PathsData } from '../src/shared/walk';
import { parsePaths } from '../src/shared/walk';
import { parsePopulation, type PopulationData } from '../src/sim/peds/population';
import { Simulation } from '../src/sim/Simulation';
import { flatTile } from './helpers';

const ARM = 280;
const CURB = 8;

/**
 * An avenue along x and a street along z crossing at the origin, each with a sidewalk either side
 * (8 m from the middle) and a crossing across every leg, joining the four corners. The crossings
 * belong to junction `j0`, signalised, one leg each (east, west, north, south).
 */
export function crossroads(signals = true): { paths: PathsData; junctions: JunctionsData } {
  const nodes: [number, number, number][] = [];
  const at = (x: number, z: number) => {
    nodes.push([x, 0.1, z]);
    return nodes.length - 1;
  };
  const ne = at(CURB, -CURB), nw = at(-CURB, -CURB), se = at(CURB, CURB), sw = at(-CURB, CURB);
  const edges: number[] = [];
  const attrs: PathsData['attrs'] = [{ kind: 'sidewalk', width: 2 }];
  const arm = (from: number, tx: number, tz: number) => {
    // an arm of sidewalk out of a corner, in 40 m pieces
    const [x0, , z0] = nodes[from];
    const n = Math.round(Math.hypot(tx - x0, tz - z0) / 40);
    let prev = from;
    for (let i = 1; i <= n; i++) {
      const k = at(x0 + ((tx - x0) * i) / n, z0 + ((tz - z0) * i) / n);
      edges.push(prev, k, 0);
      prev = k;
    }
  };
  arm(ne, ARM, -CURB); arm(ne, CURB, -ARM);
  arm(nw, -ARM, -CURB); arm(nw, -CURB, -ARM);
  arm(se, ARM, CURB); arm(se, CURB, ARM);
  arm(sw, -ARM, CURB); arm(sw, -CURB, ARM);
  const cross = (a: number, b: number, leg: number) => {
    attrs.push({ kind: 'crossing', width: 3, crossing: { id: null, marked: true, signals, junction: signals ? 'j0' : null, leg: signals ? leg : null, road: 'osm:way/1' } });
    edges.push(a, b, attrs.length - 1);
  };
  cross(ne, se, 0); // across the east leg
  cross(nw, sw, 1); // west
  cross(nw, ne, 2); // north
  cross(sw, se, 3); // south
  const paths = parsePaths({ version: 1, nodes, attrs, edges })!;
  const leg = (dx: number, dz: number) => ({ road: 'osm:way/1', node: 1, dir: [dx, dz] as [number, number], approach: true, departure: true, trim: 6, control: 'signals' as const, stopLine: null, crosswalk: true });
  const junctions: JunctionsData = {
    junctions: [{ id: 'j0', x: 0, y: 0, z: 0, control: 'signals', nodes: [1], polygon: [[-6, -6], [6, -6], [6, 6], [-6, 6]], legs: [leg(1, 0), leg(-1, 0), leg(0, -1), leg(0, 1)] }],
    signals: [], stops: [], crossings: [],
  };
  return { paths, junctions };
}

/** A table with one zone whose density is `peds` per 100 m of sidewalk in every slot, or per slot when given twelve numbers. */
export function population(peds: number | number[]): PopulationData {
  const slots = (Array.isArray(peds) ? peds : new Array<number>(12).fill(peds)).map((p) => ({ peds: p, cars: 0, pedGroups: { locals: 1 }, vehicleGroups: {} }));
  return parsePopulation({
    pedGroups: { locals: { outfits: [1, 2, 3], walkSpeed: [1.2, 1.5], behaviour: { wander: 1, scenario: 0 } } },
    vehicleGroups: {},
    zones: [{ id: 'z', name: 'z', kind: 'business', default: true, weekday: slots, weekend: slots }],
  });
}

/** The flat test tile with a crossroads walk network, optional scenario points and the junction. */
export function pedTile(opts: { signals?: boolean; scenarios?: TileData['scenarios'] } = {}): TileData {
  const { paths, junctions } = crossroads(opts.signals ?? true);
  return { ...flatTile(), paths, junctions, scenarios: opts.scenarios };
}

export interface PedSimOptions {
  peds?: number | number[];
  minutes?: number;
  day?: number;
  budget?: number;
  tile?: TileData;
  start?: 'spawn' | 'car' | 'jack';
  seed?: number;
  driverMood?: 'flee' | 'fight';
}

/** A sim with ambient pedestrians on the crossroads. The player is at the tile's player spawn (flat tile: near the origin). */
export function pedSim(o: PedSimOptions = {}): Promise<Simulation> {
  return Simulation.create({
    seed: o.seed ?? 1,
    tile: o.tile ?? pedTile(),
    ambientPeds: true,
    population: population(o.peds ?? 8),
    pedBudget: o.budget ?? 60,
    clock: { minutes: o.minutes ?? 12 * 60, day: o.day ?? 2, scale: 0 },
    parkedCars: 0,
    driver: o.start === 'jack',
    start: o.start,
    driverMood: o.driverMood,
  });
}
