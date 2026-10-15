import { createHash } from 'node:crypto';
import path from 'node:path';
import { cachedFile } from '../cache.js';
import type { TileConfig } from '../config.js';

export interface OsmGeomNode { lat: number; lon: number }
export interface OsmElement {
  type: 'way' | 'relation' | 'node';
  lat?: number;
  lon?: number;
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: OsmGeomNode[];
  members?: { type: string; ref: number; role: string; geometry?: OsmGeomNode[] }[];
}
export interface OsmData { elements: OsmElement[] }

export function overpassQuery(box: TileConfig['queryBox']): string {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:120];
(
  way["highway"](${b});
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"](${b});
  way["natural"="water"](${b});
  way["waterway"~"^(river|stream|canal|drain)$"](${b});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|recreation_ground|nature_reserve)$"](${b});
  way["landuse"](${b});
  way["amenity"="parking"](${b});
  way["building"](${b});
  relation["building"](${b});
  relation["natural"="water"](${b});
  relation["leisure"~"^(park|garden)$"](${b});
  relation["landuse"](${b});
);
out geom;`;
}

/** Tagged points that matter to traffic: signals, stop and give-way signs, marked crossings. Ways do not carry the tags of their nodes, so these need their own query. */
export function overpassNodeQuery(box: TileConfig['queryBox']): string {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:120];
(
  node["highway"~"^(traffic_signals|stop|give_way|crossing|mini_roundabout|turning_circle|turning_loop)$"](${b});
  node["crossing"](${b});
  node["railway"="level_crossing"](${b});
);
out;`;
}

/** Street furniture and storefront points that scenario points (sitting, waiting, queueing, chatting) are made from. */
export function overpassPoiQuery(box: TileConfig['queryBox']): string {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:180];
(
  node["amenity"~"^(bench|atm|restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|bicycle_rental|fountain|marketplace|bank|pharmacy|vending_machine|shelter)$"](${b});
  node["bench"="yes"](${b});
  node["leisure"="picnic_table"](${b});
  node["highway"="bus_stop"](${b});
  node["public_transport"="platform"](${b});
  node["shop"](${b});
  node["tourism"~"^(information|attraction|artwork|viewpoint|museum|gallery)$"](${b});
  way["amenity"~"^(bench|shelter|restaurant|cafe|fast_food|bar|pub|atm)$"](${b});
  way["public_transport"="platform"](${b});
  way["highway"="pedestrian"]["area"="yes"](${b});
  way["place"="square"](${b});
);
out geom;`;
}

/** Trees, street lamps and street furniture that props.json is made from. */
export function overpassPropsQuery(box: TileConfig['queryBox']): string {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:180];
(
  node["natural"="tree"](${b});
  way["natural"="tree_row"](${b});
  node["highway"="street_lamp"](${b});
  node["man_made"="street_lamp"](${b});
  node["emergency"="fire_hydrant"](${b});
  node["amenity"~"^(waste_basket|waste_disposal)$"](${b});
  node["barrier"="bollard"](${b});
);
out geom;`;
}

export async function fetchOsm(cfg: TileConfig): Promise<OsmData> {
  return fetchOverpass(cfg, overpassQuery(cfg.queryBox));
}

/** Tagged nodes of the tile (cached next to the main extract, so a re-bake stays offline). */
export async function fetchOsmNodes(cfg: TileConfig): Promise<OsmData> {
  return fetchOverpass(cfg, overpassNodeQuery(cfg.queryBox), 'osm-nodes');
}

/** Scenario-point sources (cached, so a re-bake stays offline). Overpass fails a lot, so this retries each endpoint with a backoff; null if all fail. */
export async function fetchOsmPois(cfg: TileConfig): Promise<OsmData | null> {
  const query = overpassPoiQuery(cfg.queryBox);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchOverpass(cfg, query, 'osm-pois');
    } catch (e) {
      const wait = 4000 * 2 ** attempt;
      console.warn(`osm pois: attempt ${attempt + 1} failed (${(e as Error).message}); ${attempt < 3 ? `retrying in ${wait / 1000}s` : 'giving up, scenario points will be synthesised'}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}

/** Tree and street furniture sources (cached, so a re-bake stays offline). Retried with a backoff; null if all attempts fail (the props are then synthetic only). */
export async function fetchOsmProps(cfg: TileConfig): Promise<OsmData | null> {
  const query = overpassPropsQuery(cfg.queryBox);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchOverpass(cfg, query, 'osm-props');
    } catch (e) {
      const wait = 4000 * 2 ** attempt;
      console.warn(`osm props: attempt ${attempt + 1} failed (${(e as Error).message}); ${attempt < 3 ? `retrying in ${wait / 1000}s` : 'giving up, props will be synthetic only'}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}

async function fetchOverpass(cfg: TileConfig, query: string, prefix = 'osm-overpass'): Promise<OsmData> {
  const hash = createHash('sha1').update(query).digest('hex').slice(0, 8);
  const file = path.join(cfg.cacheDir, `${prefix}-${hash}.json`);
  const buf = await cachedFile(file, async () => {
    let lastErr: unknown;
    for (const url of cfg.city.sources.osm.endpoints) {
      try {
        console.log(`osm: POST ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'hood-sandbox-pipeline/0.1 (offline tile bake)' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        JSON.parse(text);
        return text;
      } catch (e) {
        lastErr = e;
        console.warn(`osm: ${url} failed: ${(e as Error).message}`);
      }
    }
    throw new Error(`all Overpass endpoints failed: ${(lastErr as Error)?.message}`);
  });
  return JSON.parse(buf.toString('utf8')) as OsmData;
}
