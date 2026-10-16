#!/usr/bin/env node
/**
 * Writes tools/blender/landmarks/footprints.json: the real footprints the hero landmark models are built to,
 * read from the pipeline's cached Overture and OSM extracts (no network). The Blender scripts model in a frame
 * whose origin is the landmark's *anchor* (a game point, metres, +X east, +Z south, axes NOT rotated), so the
 * footprint a script draws is the real one, with the real orientation, and the model needs no yaw.
 *
 *   node tools/blender/landmarks/footprints.mjs
 *
 * For every landmark: `anchor` (game x, z and the lon/lat the pipeline places the model at), the Overture
 * building it replaces (`ring`, `parts`, `height`), and the ids of the buildings its cut-out covers.
 * Run it again when the cached Overture release changes; the file is committed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from '../../pipeline/node_modules/proj4/dist/proj4-src.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const city = JSON.parse(readFileSync(join(root, 'data/cities/atlanta/city.json'), 'utf8'));
const tile = city.tiles[0];
const fwd = proj4(city.projection);
const [E0, N0] = fwd.forward([tile.origin.lon, tile.origin.lat]);
const toGame = (lon, lat) => { const [e, n] = fwd.forward([lon, lat]); return [e - E0, -(n - N0)]; };
const toLonLat = (x, z) => { const [lon, lat] = fwd.inverse([x + E0, -z + N0]); return [lon, lat]; };
const cache = join(root, 'tools/pipeline/cache/atlanta/m1-five-points');
const overture = JSON.parse(readFileSync(join(cache, 'overture-buildings-v2.json'), 'utf8')).buildings;
const parts = JSON.parse(readFileSync(join(cache, 'overture-parts.json'), 'utf8')).parts;
const osm = JSON.parse(readFileSync(join(cache, 'osm-overpass-181aa8b1.json'), 'utf8'));
const osmWays = new Map(osm.elements.filter((e) => e.type === 'way').map((e) => [e.id, e]));

const r1 = (v) => Math.round(v * 10) / 10;
const centroid = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
function area(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function bbox(r) { const xs = r.map((p) => p[0]), zs = r.map((p) => p[1]); return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]; }
function inRing(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; }
const ovRing = (b) => b.polygons[0][0].map(([lo, la]) => toGame(lo, la)).slice(0, -1);
const byName = (name) => overture.find((b) => b.name === name);
const osmRing = (id) => osmWays.get(id).geometry.map((g) => toGame(g.lon, g.lat)).slice(0, -1);

/**
 * id: the landmark id of data/cities/<city>/landmarks.json.
 * from: the Overture building (by name) or OSM way whose footprint the model is built to; anchor: the bounding-box centre of it, rounded to the metre.
 * at: [x, z] to anchor somewhere else (a model that is not one building's footprint); cut: also replace every building whose centre is within the ring.
 */
const HEROES = [
  { id: 'mercedes-benz-stadium', ov: 'Mercedes-Benz Stadium' },
  { id: 'georgia-state-capitol', ov: 'The Georgia State Capitol' },
  { id: 'westin-peachtree-plaza', ov: 'The Westin Peachtree Plaza, Atlanta' },
  { id: 'hyatt-regency-atlanta', ov: 'Hyatt Regency Atlanta' },
  { id: 'state-farm-arena', ov: 'State Farm Arena' },
  { id: 'georgia-aquarium', ov: 'Georgia Aquarium' },
  { id: 'world-of-coca-cola', ov: 'World of Coca-Cola' },
  { id: 'skyview-atlanta', ov: 'SkyView Atlanta' },
  { id: 'fountain-of-rings', osmWay: 40697210 },
  { id: 'truist-plaza', ov: 'Truist Plaza Building' },
  { id: '191-peachtree-tower', ov: '191 Peachtree Tower' },
  { id: 'flatiron-building-atlanta', ov: 'FlatironCity' },
  { id: 'candler-building', ov: 'Candler Building' },
  { id: 'georgia-pacific-tower', ov: 'Georgia-Pacific Tower' },
  { id: 'marriott-marquis', ov: 'Atlanta Marriott Marquis' },
  { id: 'state-of-georgia-building', ov: 'State of Georgia Building' },
  { id: 'atlanta-city-hall', ov: 'Atlanta City Hall' },
  { id: 'hurt-building', ov: 'Hurt Building' },
  { id: 'atlanta-central-library', ov: 'Atlanta Central Library' },
  { id: 'basilica-of-the-sacred-heart', ov: 'Basilica of the Sacred Heart of Jesus' },
  { id: 'corey-tower', ov: 'Corey Tower' },
  { id: 'hilton-atlanta', ov: 'Hilton Atlanta' },
  { id: 'peachtree-center-harris-tower', ov: 'Peachtree Center Harris Tower' },
  { id: 'peachtree-center-international-tower', ov: 'Peachtree Center International Tower' },
  { id: 'peachtree-center-north-tower', ov: 'Peachtree Center North Tower' },
  { id: 'peachtree-center-south-tower', ov: 'Peachtree Center South Tower' },
  { id: 'rialto-center-for-the-arts', ov: 'Rialto Center for the Arts' },
];

const out = { _comment: 'Written by tools/blender/landmarks/footprints.mjs from the pipeline cache. Do not edit.', origin: tile.origin, landmarks: {} };
for (const h of HEROES) {
  let ring, b = null;
  if (h.ov) { b = byName(h.ov); if (!b) throw new Error(`no Overture building named ${h.ov}`); ring = ovRing(b); }
  else ring = osmRing(h.osmWay);
  const bb = bbox(ring);
  const anchor = [Math.round((bb[0] + bb[2]) / 2), Math.round((bb[1] + bb[3]) / 2)];
  const [lon, lat] = toLonLat(anchor[0], anchor[1]);
  const local = (r) => r.map((p) => [r1(p[0] - anchor[0]), r1(p[1] - anchor[1])]);
  const entry = { anchor: { x: anchor[0], z: anchor[1], lat: +lat.toFixed(7), lon: +lon.toFixed(7) }, ring: local(ring) };
  if (b) {
    entry.overture = b.id;
    entry.height = b.height;
    entry.floors = b.numFloors;
    entry.parts = parts.filter((p) => p.buildingId === b.id).map((p) => ({
      height: p.height, minHeight: p.minHeight, floors: p.numFloors, roof: p.roofShape,
      rings: p.polygons.map((poly) => local(poly[0].map(([lo, la]) => toGame(lo, la)).slice(0, -1))),
    }));
  }
  // every building whose centre lies inside the footprint goes with it
  const ids = [];
  for (const o of overture) {
    o.polygons.forEach((poly, pi) => {
      const r = poly[0].map(([lo, la]) => toGame(lo, la)).slice(0, -1);
      const c = centroid(r);
      if (inRing(c[0], c[1], ring) && (b ? o.id !== b.id : true)) ids.push(`overture:${o.id}${o.polygons.length > 1 ? '/' + pi : ''}`);
    });
  }
  entry.alsoInside = ids;
  out.landmarks[h.id] = entry;
  console.log(h.id.padEnd(28), 'anchor', anchor.join(','), 'ring', ring.length, 'h', b?.height, 'parts', entry.parts?.length ?? 0, 'also', ids.length);
}
writeFileSync(join(here, 'footprints.json'), `${JSON.stringify(out, null, 1)}\n`);
