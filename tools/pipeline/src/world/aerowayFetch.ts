/**
 * The airport's own OSM extract (the aeroway layer): runways, taxiways, aprons, terminals, gates, parking positions, holding
 * positions, jet bridges, the control tower, the people movers and the parking decks. The ordinary tile queries
 * (sources/osm.ts) carry none of the `aeroway` tags, so a grid with an airport fetches this once for the whole airport box
 * (one request, through the grid prefetch's polite client: one request at a time, backed off on 429/5xx/timeouts, endpoints
 * rotated) and every tile bake and the airport graph read the same file.
 *
 *   cache/<city>/<grid>/aeroway-<sha1 of the query, 8 hex>.json
 *
 * `npm run aeroway:fetch [-- --grid airport]` in tools/pipeline fetches it (the grid prefetch does too, `--lanes aeroway`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TileConfig } from '../config.js';
import type { OsmData } from '../sources/osm.js';

export type Box = TileConfig['queryBox'];

/** The aeroway query over a lon/lat box. */
export function aerowayQuery(box: Box): string {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:600];
(
  nwr["aeroway"](${b});
  nwr["man_made"="tower"]["tower:type"](${b});
  way["railway"~"^(monorail|light_rail|subway|rail|funicular)$"]["service"!="yard"](${b});
  way["railway"]["name"~"Train|SkyTrain|People Mover",i](${b});
  nwr["amenity"~"^(car_rental|parking)$"](${b});
  way["building"~"^(parking|transportation|terminal|hangar|train_station|office|commercial|industrial|warehouse|yes)$"]["name"](${b});
  way["building:part"](${b});
  nwr["public_transport"="station"](${b});
);
out geom;`;
}

export const aerowayCacheFile = (cacheRoot: string, query: string): string =>
  path.join(cacheRoot, `aeroway-${createHash('sha1').update(query).digest('hex').slice(0, 8)}.json`);

/** Reads the cached aeroway extract of a box, or null when it has not been fetched (a tile then bakes with no airport). */
export function readAeroway(cacheRoot: string, box: Box): OsmData | null {
  const f = aerowayCacheFile(cacheRoot, aerowayQuery(box));
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8')) as OsmData;
}
