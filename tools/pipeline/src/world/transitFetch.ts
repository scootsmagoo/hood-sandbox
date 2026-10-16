/**
 * The transit layer's OpenStreetMap source (docs/contracts/m1-tile-format.md, "transit.json"): one Overpass query for the whole
 * rail network of a city (the lines are tens of kilometres long and cross every tile of a grid), cached once per city under
 * `cache/<city>/transit/` and cut per tile by the bake. Tunnels and bridges are kept: the roads drop them, the transit layer is
 * where they live.
 *
 * Overpass is overloaded: the query goes through the grid prefetch's polite client (one request at a time, a gap between
 * requests, endpoint rotation, exponential backoff with jitter on 429/5xx/timeouts, validated before anything is cached).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../config.js';
import type { OsmData } from '../sources/osm.js';
import { fetchOverpassToCache, OVERPASS_POLICY, PoliteClient } from '../city/http.js';

/** A lon/lat box. */
export interface LonLatBox { south: number; west: number; north: number; east: number }

/**
 * The rail network inside `box`: the route relations (their ordered members, no geometry), every subway and light-rail track
 * way with its geometry (tunnels, bridges, crossovers, yards), the platforms, stations and entrances.
 */
export function transitQuery(box: LonLatBox): string {
  const b = `${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`;
  return `[out:json][timeout:240];
relation["type"="route"]["route"~"^(subway|light_rail)$"](${b})->.routes;
.routes out body;
(
  way["railway"~"^(subway|light_rail)$"](${b});
  way["railway"="platform"](${b});
  way["public_transport"="platform"]["subway"="yes"](${b});
  way["railway"="station"](${b});
  way["public_transport"="station"]["subway"="yes"](${b});
  way["building"="train_station"](${b});
);
out geom;
(
  node["railway"~"^(station|halt|stop|subway_entrance|train_station_entrance)$"](${b});
  node["public_transport"~"^(station|stop_position)$"]["subway"="yes"](${b});
  node["station"="subway"](${b});
);
out body;`;
}

/** The cache file of a transit query. */
export function transitCacheFile(cityId: string, query: string): string {
  const hash = createHash('sha1').update(query).digest('hex').slice(0, 8);
  return path.join(CACHE_DIR, cityId, 'transit', `osm-transit-${hash}.json`);
}

/** The city's rail network from the cache, or fetched politely (null when Overpass could not be reached: the tile then has no transit). */
export async function fetchTransit(cityId: string, endpoints: readonly string[], box: LonLatBox, client = new PoliteClient(OVERPASS_POLICY)): Promise<OsmData | null> {
  const query = transitQuery(box);
  const file = transitCacheFile(cityId, query);
  if (!existsSync(file)) {
    const r = await fetchOverpassToCache(client, endpoints, query, file, 'transit');
    if (r.status === 'failed') {
      console.warn(`transit: the Overpass query failed (${r.error}); the tile is baked without transit`);
      return null;
    }
  }
  return JSON.parse(readFileSync(file, 'utf8')) as OsmData;
}

/** The box the network query covers: the whole metro rail network of the city pack (`transit.json` `box`). */
export function transitBox(pack: { box: [number, number, number, number] }): LonLatBox {
  const [south, west, north, east] = pack.box;
  return { south, west, north, east };
}
