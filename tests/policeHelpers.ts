import { readFileSync } from 'node:fs';
import { parseJurisdictions, type LawData } from '../src/shared/law';
import type { SimEvent } from '../src/shared/protocol';
import type { RoadData, TileData } from '../src/shared/tile';
import { Simulation } from '../src/sim/Simulation';
import { Button, cmd, flatTile, gridRoads, ped, run, vehicle } from './helpers';
import { quickResponse } from './quickResponse';

// These helpers serve the tests about what the police do once they are there: no radio delay, no 30 s wait for the helicopter.
quickResponse();

/** The Atlanta pack, as the game reads it. */
export const atlanta: LawData = parseJurisdictions(JSON.parse(readFileSync('data/cities/atlanta/jurisdictions.json', 'utf8')));

/** The pack with every agency but one silenced, and that one allowed `units` cars at every heat (for staging one unit by hand). */
export function onlyAgency(law: LawData, id: string, over: Partial<LawData['agencies'][number]> = {}, units = 1): LawData {
  return {
    ...law,
    agencies: law.agencies.map((a) => (a.id === id ? { ...a, ...over } : a)),
    dispatch: { [id]: [{ heat: 1, maxUnits: units, spawnIntervalS: 9999, unitsPerSpawn: 1, loadout: 'pistol' }] },
  };
}

export const agency = (law: LawData, id: string) => law.agencies.find((a) => a.id === id)!;

/** A grid tile with a motorway through it along z = 0 (one-way, 3 lanes) and the surface streets as they were. */
export function highwayTile(): TileData {
  const roads: RoadData[] = gridRoads().filter((r) => !r.id.startsWith('h2-'));
  roads.push({ id: 'i-285', class: 'motorway', lanes: 3, oneway: true, bridge: false, layer: 0, width: 12, points: [[-600, 0, 0], [0, 0, 0], [600, 0, 0]] });
  return { ...flatTile(), roads };
}

export interface Chase {
  sim: Simulation;
  hero: ReturnType<typeof vehicle>;
  /** Events since the start of the chase. */
  events: SimEvent[];
  /** Advances `ticks` with the hero holding its lane at `speed`, collecting events. */
  drive(ticks: number, speed?: number, each?: (tick: number) => void): void;
  /** The same without the lane keeping: the wheel straight. */
  coast(ticks: number, speed?: number): void;
}

/**
 * A hero in a car on the grid's east-west street z = 3.5 (beside the centre line), heading east from `x`, at `speed`,
 * with `heat` just reported and the police told where they are. The hero cannot be killed (armour that never runs out).
 */
export async function chase(opts: { law?: LawData; heat?: number; severity?: number; x?: number; z?: number; speed?: number; seed?: number; tile?: TileData; minutes?: number; vehicleType?: string; invulnerable?: boolean; camYaw?: number } = {}): Promise<Chase> {
  const z = opts.z ?? 3.5;
  const x = opts.x ?? -560;
  const sim = await Simulation.create({
    seed: opts.seed ?? 5, tile: opts.tile ?? { ...flatTile(), roads: gridRoads() }, driver: false, parkedCars: 0, law: opts.law ?? atlanta,
    vehicleType: opts.vehicleType ?? 'coupe', clock: { minutes: opts.minutes ?? 14 * 60, scale: 0 },
  });
  const hero = vehicle(sim);
  hero.car.teleport(x, 0.4, z, Math.PI / 2);
  ped(sim).controller.teleport(x - 2.5, 0, z, 0);
  run(sim, 30, cmd());
  run(sim, 4, cmd({ buttons: Button.Interact }));
  run(sim, 4, cmd());
  if (ped(sim).vehicleId !== hero.id) throw new Error('the hero did not get in');
  sim.drainEvents();
  if ((opts.heat ?? 0) > 0) sim.law.heat.report(opts.heat!, opts.severity ?? 4, x, 0, true);
  const speed = opts.speed ?? 20;
  hero.car.body.setLinvel({ x: speed, y: 0, z: 0 }, true);
  hero.car.adopt();
  const events: SimEvent[] = [];
  const control = (target: number, hold: boolean) => {
    const p = hero.car.pose();
    const v = hero.car.speedForward;
    const steer = hold ? Math.max(-1, Math.min(1, (z - p.z) * 0.1 + (Math.PI / 2 - hero.car.yaw) * 1.2)) : 0;
    if (target <= 0) return cmd({ buttons: Button.Handbrake });
    const throttle = Math.max(0, Math.min(1, (target - v) * 0.5));
    const brake = Math.max(0, Math.min(1, (v - target - 1.5) * 0.3));
    return cmd({ axes: { Throttle: throttle, Brake: brake, Steer: -steer, Yaw: opts.camYaw ?? 0 } });
  };
  const go = (ticks: number, target: number, hold: boolean, each?: (tick: number) => void) => {
    for (let t = 0; t < ticks; t++) {
      sim.pushInput(1, control(target, hold));
      sim.step();
      events.push(...sim.drainEvents());
      if (opts.invulnerable !== false) {
        const p = ped(sim);
        p.armour = 1e9;
        if (p.life === 'alive') p.health = 100;
      }
      each?.(t);
    }
  };
  return {
    sim, hero, events,
    drive: (ticks, s = speed, each) => go(ticks, s, true, each),
    coast: (ticks, s = speed) => go(ticks, s, false),
  };
}

export const ofKind = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T) => events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Angle difference wrapped to (-PI, PI]. */
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
