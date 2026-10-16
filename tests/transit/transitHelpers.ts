/** Helpers for the transit tests: the baked tile from disk, and a sim on it with the trains running. */
import { existsSync, readFileSync } from 'node:fs';
import { loadBakedTile, type TileData } from '../../src/shared/tile';
import { Simulation } from '../../src/sim/Simulation';
import type { PedEntity } from '../../src/sim/entities';

export const TILE_DIR = 'public/tiles/atlanta/m1-five-points';
export const haveTransitTile = existsSync(`${TILE_DIR}/tile.json`) && existsSync(`${TILE_DIR}/transit.json`);

/** Reads the baked tile straight from disk, the way the worker reads it over HTTP. */
export const fsFetch = async (url: string) => {
  const path = url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

let cached: TileData | null = null;
export async function transitTile(): Promise<TileData> {
  cached ??= await loadBakedTile(TILE_DIR, fsFetch);
  return cached;
}

export async function transitSim(over: Partial<Parameters<typeof Simulation.create>[0]> = {}): Promise<Simulation> {
  const tile = await transitTile();
  return Simulation.create({ seed: 7, tile, parkedCars: 0, ...over });
}

export const playerOf = (sim: Simulation) => sim.registry.get(sim.playerPedId) as PedEntity;

/** The station's index by its real name. */
export const stationIndex = (sim: Simulation, name: string) => sim.transit!.data.stations.findIndex((s) => s.name === name);
