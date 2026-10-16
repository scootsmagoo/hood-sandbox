/**
 * Writes tools/blender/airport/airport.json: what the Hartsfield-Jackson hero models are built to, read from the pipeline's
 * cached airport extract (tools/pipeline/cache/atlanta/airport/aeroway-*.json, world/aerowayFetch.ts) and its DEM (no network):
 *
 *   cd tools/pipeline && npx tsx ../blender/airport/footprints.ts
 *
 * - `heroes`: per model, its anchor (a game point, metres, +X east, +Z south, axes not rotated: the model needs no yaw), the
 *   real outlines it stands on (model frame: metres from the anchor), the OSM ways it replaces, its floor `elevation` (metres above
 *   sea level: the mean ground under the main outline, which the bake levels the floor to, the same in every tile it touches) and
 *   what the map says of its height.
 * - `gates`: every gate with a stand: the gate on the concourse wall, the jet bridge's root (on the wall), the stand (where the
 *   nose gear stops), the parked `yaw` (as a ped's: the nose faces (sin yaw, cos yaw) in x, z; the model's +Z is its nose), the stand's size
 *   class (from the room it has: the distance to the next stands) and the jet bridge's tip (the L1 door of that class parked there,
 *   from src/shared/data/aircraft.json), all in game coordinates.
 * - `skytrain`: the people mover's guideway (game x, z, the layer) and its stations; `marta`: the rail station and track ends that
 *   the transit layer brings into the Domestic Terminal (the model leaves that room open).
 * The file is committed; run it again when the cache changes.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjector, type V2 } from '../../pipeline/src/geo.js';
import { cellBakeConfig, loadGrid } from '../../pipeline/src/city/grid.js';
import { fetchDem, sampleDem, type Dem } from '../../pipeline/src/sources/dem.js';
import { classifyWay } from '../../pipeline/src/world/osm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const grid = loadGrid('atlanta', 'airport');
const proj = createProjector(grid.city.projection, grid.spec.origin);
const cacheRoot = grid.cacheRoot;
const file = readdirSync(cacheRoot).find((f) => /^aeroway-[0-9a-f]{8}\.json$/.test(f));
if (!file) throw new Error(`no aeroway extract in ${cacheRoot} (npm run prefetch:m2 -- --grid airport --lanes aeroway)`);
type El = { type: string; id: number; tags?: Record<string, string>; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[]; members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[] };
const els = (JSON.parse(readFileSync(path.join(cacheRoot, file), 'utf8')) as { elements: El[] }).elements;
const AC = JSON.parse(readFileSync(path.join(root, 'src/shared/data/aircraft.json'), 'utf8')) as { types: Record<string, { doorL1: { x: number; y: number; z: number }; wheelbase: number; span: number; length: number }> };

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const game = (g: { lat: number; lon: number }): V2 => proj.toGame(g.lon, g.lat);
const way = (id: number) => {
  const e = els.find((x) => x.type === 'way' && x.id === id);
  if (!e?.geometry) throw new Error(`way ${id} is not in the extract`);
  return e;
};
const ringOf = (id: number): V2[] => {
  const g = way(id).geometry!.map(game);
  if (g.length > 1 && Math.hypot(g[0][0] - g[g.length - 1][0], g[0][1] - g[g.length - 1][1]) < 0.01) g.pop();
  return orient(g);
};
const area = (r: V2[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
/** Rings counter-clockwise in (x, z) as the landmark kit expects (positive signed area). */
const orient = (r: V2[]) => (area(r) < 0 ? [...r].reverse() : r);
const bbox = (rs: V2[][]) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rs) for (const p of r) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  return { x0, z0, x1, z1 };
};
const inRing = (x: number, z: number, r: V2[]) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
};

// ---- the DEM of the grid's cells, for the floor elevations
const dems = new Map<string, Dem>();
async function elevation(x: number, z: number): Promise<number> {
  const i = Math.floor(x / grid.spec.tileSizeM), j = Math.floor(z / grid.spec.tileSizeM);
  const cell = grid.cells.find((c) => c.i === i && c.j === j);
  if (!cell) return NaN;
  let d = dems.get(cell.id);
  if (!d) {
    d = await fetchDem(cellBakeConfig(grid, cell).cfg);
    dems.set(cell.id, d);
  }
  const [lon, lat] = proj.toLonLat(x, z);
  return sampleDem(d, lon, lat);
}
/** The mean ground under a set of rings, sampled on a 6 m grid (metres above sea level). */
async function meanGround(rs: V2[][]): Promise<number> {
  const b = bbox(rs);
  let s = 0, n = 0;
  for (let z = b.z0 + 3; z < b.z1; z += 6) for (let x = b.x0 + 3; x < b.x1; x += 6) {
    if (!rs.some((r) => inRing(x, z, r))) continue;
    const e = await elevation(x, z);
    if (Number.isFinite(e)) { s += e; n++; }
  }
  return n ? r2(s / n) : NaN;
}

interface HeroDef {
  id: string;
  name: string;
  /** OSM ways whose outlines make the model (the first is the main one) */
  ways: number[];
  /** extra OSM ways the model replaces (not drawn from) */
  also?: number[];
  height?: number;
  levels?: number;
  kind: string;
}
const HEROES: HeroDef[] = [
  { id: 'atl-domestic-terminal', name: 'Domestic Terminal', ways: [264678569, 44488347, 44488346], kind: 'terminal', height: 26 },
  { id: 'atl-concourse-t', name: 'Concourse T', ways: [24445333], kind: 'concourse', height: 16 },
  { id: 'atl-concourse-a', name: 'Concourse A', ways: [24445165], kind: 'concourse', height: 16 },
  { id: 'atl-concourse-b', name: 'Concourse B', ways: [24445168], kind: 'concourse', height: 16 },
  { id: 'atl-concourse-c', name: 'Concourse C', ways: [24445167], kind: 'concourse', height: 16 },
  { id: 'atl-concourse-d', name: 'Concourse D', ways: [24445166], kind: 'concourse', height: 16 },
  { id: 'atl-concourse-e', name: 'Concourse E', ways: [24445175, 1375871784, 1375871788], kind: 'concourse', height: 18 },
  { id: 'atl-concourse-f', name: 'Concourse F', ways: [169784353], kind: 'concourse', height: 22 },
  { id: 'atl-international-terminal', name: 'Maynard H. Jackson Jr. International Terminal', ways: [328278997], kind: 'terminal', height: 30 },
  { id: 'atl-control-tower', name: 'Atlanta Tower', ways: [169785102], kind: 'tower', height: 121 },
  { id: 'atl-north-hourly-deck', name: 'North Hourly Parking', ways: [449350801], kind: 'parking', levels: 4 },
  { id: 'atl-north-daily-deck', name: 'North Daily Parking', ways: [166825340], kind: 'parking', levels: 4 },
  { id: 'atl-south-hourly-deck', name: 'South Hourly Parking', ways: [144043678], kind: 'parking', levels: 4 },
  { id: 'atl-south-daily-deck', name: 'South Daily Parking', ways: [92994684], kind: 'parking', levels: 4 },
  { id: 'atl-west-parking-deck', name: 'ATL West Parking Deck', ways: [901848459], kind: 'parking', levels: 7 },
  { id: 'atl-rental-car-center', name: 'Rental Car Center', ways: [62331392, 62331390], also: [575614361, 575620089, 575620097, 575620098, 575620103, 575620104, 561065977], kind: 'parking', levels: 4 },
];

const out: Record<string, unknown> = {
  _comment: 'Written by tools/blender/airport/footprints.ts from the pipeline cache. Do not edit.',
  origin: grid.spec.origin,
  projection: grid.city.projection,
  heroes: {} as Record<string, unknown>,
};
const heroRings = new Map<string, { anchor: V2; rings: V2[][] }>();
for (const h of HEROES) {
  const rings = h.ways.map(ringOf);
  const b = bbox(rings);
  const anchor: V2 = [Math.round((b.x0 + b.x1) / 2), Math.round((b.z0 + b.z1) / 2)];
  const [lon, lat] = proj.toLonLat(anchor[0], anchor[1]);
  heroRings.set(h.id, { anchor, rings });
  const local = (r: V2[]) => r.map((p) => [r2(p[0] - anchor[0]), r2(p[1] - anchor[1])]);
  const tags = way(h.ways[0]).tags ?? {};
  (out.heroes as Record<string, unknown>)[h.id] = {
    name: h.name,
    kind: h.kind,
    anchor: { x: anchor[0], z: anchor[1], lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 },
    elevation: await meanGround([rings[0]]),
    rings: rings.map(local),
    osm: [...h.ways, ...(h.also ?? [])].map((id) => `osm:way/${id}`),
    ...(h.also ? { alsoRings: h.also.map((id) => local(ringOf(id))) } : {}),
    height: h.height ?? (tags.height ? Number(tags.height) : null),
    levels: h.levels ?? (tags['building:levels'] ? Number(tags['building:levels']) : null),
    size: { x: r1(b.x1 - b.x0), z: r1(b.z1 - b.z0) },
  };
}

// the Domestic Terminal and Concourse T are one walk-in building (the hall runs on into the concourse): one floor for both
{
  const hs = out.heroes as Record<string, { elevation: number }>;
  const shared = r2((hs['atl-domestic-terminal'].elevation + hs['atl-concourse-t'].elevation) / 2);
  hs['atl-domestic-terminal'].elevation = shared;
  hs['atl-concourse-t'].elevation = shared;
  // Concourse F and the international terminal touch at the terminal's west end: one floor for both too
  const intl = r2((hs['atl-concourse-f'].elevation + hs['atl-international-terminal'].elevation) / 2);
  hs['atl-concourse-f'].elevation = intl;
  hs['atl-international-terminal'].elevation = intl;
}

// ---- gates: gate node, jet bridge root, stand, heading, class, jet bridge tip
const concourseOf = (x: number, z: number): string | null => {
  let best: string | null = null, bd = 60;
  for (const [id, h] of heroRings) {
    if (!id.startsWith('atl-concourse') && id !== 'atl-international-terminal' && id !== 'atl-domestic-terminal') continue;
    for (const r of h.rings) {
      if (inRing(x, z, r)) return id;
      for (let i = 0; i < r.length; i++) {
        const a = r[i], c = r[(i + 1) % r.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
        if (d < bd) { bd = d; best = id; }
      }
    }
  }
  return best;
};
const byRef = new Map<string, El[]>();
for (const e of els) {
  const t = e.tags ?? {};
  if (!t.ref || !['gate', 'jet_bridge', 'parking_position'].includes(t.aeroway ?? '')) continue;
  const list = byRef.get(t.ref) ?? [];
  list.push(e);
  byRef.set(t.ref, list);
}
interface Gate { ref: string; hero: string; gate: V2; root: V2; bridgeOsm: V2[]; stand: V2; yaw: number; leadIn: V2[]; size: string; tip?: [number, number, number] }
const gates: Gate[] = [];
for (const [ref, list] of [...byRef].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const gate = list.find((e) => e.type === 'node' && e.tags!.aeroway === 'gate');
  const jb = list.find((e) => e.type === 'way' && e.tags!.aeroway === 'jet_bridge');
  const standNode = list.find((e) => e.type === 'node' && e.tags!.aeroway === 'parking_position');
  if (!gate || !jb || !standNode) continue;
  const g: V2 = game(gate as { lat: number; lon: number });
  const hero = concourseOf(g[0], g[1]);
  if (!hero) continue;
  const stand: V2 = game(standNode as { lat: number; lon: number });
  // the lead-in line: the parking_position way of this ref that ends at (or nearest) the stand
  let lead: V2[] | null = null, ld = 25;
  for (const e of list) {
    if (e.type !== 'way' || e.tags!.aeroway !== 'parking_position') continue;
    const pts = e.geometry!.map(game);
    for (const cand of [pts, [...pts].reverse()]) {
      const end = cand[cand.length - 1];
      const d = Math.hypot(end[0] - stand[0], end[1] - stand[1]);
      if (d < ld) { ld = d; lead = cand; }
    }
  }
  if (!lead || lead.length < 2) continue;
  // the nose points along the last stretch of the lead-in (towards the stand)
  const a = lead[lead.length - 2], b = lead[lead.length - 1];
  const fx = b[0] - a[0], fz = b[1] - a[1];
  // yaw: forward (sin yaw, cos yaw)
  const yaw = Math.atan2(fx, fz);
  const bpts = jb.geometry!.map(game);
  const hr = heroRings.get(hero)!;
  const dIn = (p: V2) => Math.min(...hr.rings.map((r) => (inRing(p[0], p[1], r) ? 0 : Math.min(...r.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]))))));
  const root = dIn(bpts[0]) <= dIn(bpts[bpts.length - 1]) ? bpts[0] : bpts[bpts.length - 1];
  gates.push({ ref, hero, gate: [r2(g[0]), r2(g[1])], root: [r2(root[0]), r2(root[1])], bridgeOsm: bpts.map((p) => [r2(p[0]), r2(p[1])] as V2), stand: [r2(stand[0]), r2(stand[1])], yaw: Math.round(yaw * 1e4) / 1e4, leadIn: lead.map((p) => [r2(p[0]), r2(p[1])] as V2), size: 'narrowbody' });
}
// the size class from the room a stand has: half the distance to the nearest other stand of its concourse, either side
for (const g of gates) {
  let near = Infinity;
  for (const o of gates) if (o !== g && o.hero === g.hero) near = Math.min(near, Math.hypot(o.stand[0] - g.stand[0], o.stand[1] - g.stand[1]));
  // (the international concourses E and F take the widebodies wherever there is room for one)
  const intl = g.hero === 'atl-concourse-f' || g.hero === 'atl-concourse-e' || g.hero === 'atl-international-terminal';
  g.size = near >= 66 || (intl && near >= 56) ? 'widebody' : near < 40 ? 'regional' : 'narrowbody';
}
// the jet bridge reaches the L1 door of that class parked on the stand: nose gear on the stand, heading as above
for (const g of gates) {
  const t = AC.types[g.size];
  const fwd: V2 = [Math.sin(g.yaw), Math.cos(g.yaw)];
  // the model's +X is the aircraft's left: (cos yaw, -sin yaw) in the game's x-east, z-south frame
  const left: V2 = [Math.cos(g.yaw), -Math.sin(g.yaw)];
  const dz = t.doorL1.z - t.wheelbase;
  const tip: [number, number, number] = [r2(g.stand[0] + fwd[0] * dz + left[0] * (t.doorL1.x + 0.6)), r2(t.doorL1.y), r2(g.stand[1] + fwd[1] * dz + left[1] * (t.doorL1.x + 0.6))];
  g.tip = tip;
}
out.gates = gates;

// ---- the people movers and the rail station
const sky = els.filter((e) => e.type === 'way' && e.tags?.railway === 'monorail' && /SkyTrain/i.test(e.tags?.name ?? ''));
// (with the ground under every point, metres above sea level: the guideway's columns stand on it)
const skyWays = [];
for (const e of sky) {
  const pts = e.geometry!.map((g) => game(g).map(r2) as V2);
  const ground: number[] = [];
  for (const p of pts) ground.push(r2(await elevation(p[0], p[1])));
  skyWays.push({ id: `osm:way/${e.id}`, layer: Number(e.tags!.layer ?? 0), pts, ground });
}
out.skytrain = {
  ways: skyWays,
  stations: els.filter((e) => e.type === 'node' && e.tags?.public_transport === 'station' && !/Metropolitan/.test(e.tags?.operator ?? '')).map((e) => ({ name: e.tags!.name, at: game(e as { lat: number; lon: number }).map(r2) })),
};
// the roads and railways the SkyTrain crosses (from the pipeline's merged OSM extract): its columns keep off their carriageways
{
  const merged = path.join(cacheRoot, 'merged');
  const f = readdirSync(merged).filter((x) => /^osm-overpass-[0-9a-f]{8}\.json$/.test(x)).sort()[0];
  const avoid: { id: string; highway: string; layer: number; halfWidth: number; pts: V2[] }[] = [];
  if (f) {
    const osm = (JSON.parse(readFileSync(path.join(merged, f), 'utf8')) as { elements: El[] }).elements;
    const segs = skyWays.flatMap((w) => w.pts.slice(1).map((p, i) => [w.pts[i], p] as [V2, V2]));
    const near = (p: V2) => segs.some(([a, b]) => {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]) < 45;
    });
    for (const e of osm) {
      if (e.type !== 'way' || !e.geometry) continue;
      const c = classifyWay(e as never);
      if (!c || c.kind === 'ped') continue;
      const pts = e.geometry.map(game).map((p) => [r2(p[0]), r2(p[1])] as V2);
      // densify so a long straight way crossing the guideway has a point near it
      const dense: V2[] = [];
      for (let i = 0; i < pts.length; i++) {
        if (i) {
          const a = pts[i - 1], b = pts[i];
          const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20);
          for (let k = 1; k < n; k++) dense.push([r2(a[0] + ((b[0] - a[0]) * k) / n), r2(a[1] + ((b[1] - a[1]) * k) / n)]);
        }
        dense.push(pts[i]);
      }
      const keep = dense.map(near);
      // the stretches near the guideway (with one point either side)
      let run: V2[] = [];
      for (let i = 0; i < dense.length; i++) {
        const k = keep[i] || keep[i - 1] || keep[i + 1];
        if (k) run.push(dense[i]);
        if ((!k || i === dense.length - 1) && run.length >= 2) {
          avoid.push({ id: `osm:way/${e.id}`, highway: c.highway, layer: c.layer, halfWidth: r2(c.width / 2), pts: run });
        }
        if (!k) run = [];
      }
    }
  }
  (out.skytrain as Record<string, unknown>).avoid = avoid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.pts[0][0] - b.pts[0][0]));
}
// the SkyTrain's own hero (tools/blender/airport/skytrain.py): the guideway is overhead, so it replaces nothing (osm [], the
// model's overlap 0); its rings are thin outlines of every way (the longest first: the cut-out), which keep trees and lamps
// out from under it. Its y = 0 is the LOWEST ground under the guideway, so every column's hull prism (from y = 0 up) reaches
// the ground wherever it stands; the columns are drawn from the ground under each (ground - elevation) up.
if (skyWays.length) {
  const all = skyWays.flatMap((w) => w.pts);
  const b = bbox([all]);
  const anchor: V2 = [Math.round((b.x0 + b.x1) / 2), Math.round((b.z0 + b.z1) / 2)];
  const [lon, lat] = proj.toLonLat(anchor[0], anchor[1]);
  const half = 3.4;
  const buffer = (pts: V2[]): V2[] => {
    const left: V2[] = [], right: V2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const ln = Math.hypot(dx, dz) || 1;
      const nx = -dz / ln, nz = dx / ln;
      left.push([r2(pts[i][0] + nx * half - anchor[0]), r2(pts[i][1] + nz * half - anchor[1])]);
      right.push([r2(pts[i][0] - nx * half - anchor[0]), r2(pts[i][1] - nz * half - anchor[1])]);
    }
    return orient([...left, ...right.reverse()]);
  };
  const len = (pts: V2[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const ordered = [...skyWays].sort((p, q) => len(q.pts) - len(p.pts) || (p.id < q.id ? -1 : 1));
  const rings = ordered.map((w) => buffer(w.pts));
  (out.heroes as Record<string, unknown>)['atl-skytrain'] = {
    name: 'SkyTrain',
    kind: 'guideway',
    anchor: { x: anchor[0], z: anchor[1], lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 },
    elevation: Math.min(...skyWays.flatMap((w) => w.ground)),
    groundAtAnchor: r2(await elevation(anchor[0], anchor[1])),
    rings,
    osm: [],
    height: null,
    levels: null,
    size: { x: r1(b.x1 - b.x0), z: r1(b.z1 - b.z0) },
  };
}
const marta = els.filter((e) => e.type === 'way' && e.tags?.railway === 'subway' && /MARTA/.test(e.tags?.name ?? '') && e.tags?.tunnel === 'building_passage');
const martaStation = els.find((e) => e.type === 'node' && e.tags?.public_transport === 'station' && e.tags?.name === 'Airport' && /Metropolitan/.test(e.tags?.operator ?? ''));
out.marta = {
  station: martaStation ? game(martaStation as { lat: number; lon: number }).map(r2) : null,
  tracks: marta.map((e) => ({ id: `osm:way/${e.id}`, ref: e.tags!['railway:track_ref'] ?? null, pts: e.geometry!.map((g) => game(g).map(r2)) })),
};
const planeTrain = els.find((e) => e.type === 'way' && /Plane Train/i.test(e.tags?.name ?? ''));
out.planeTrain = planeTrain ? { id: `osm:way/${planeTrain.id}`, pts: planeTrain.geometry!.map((g) => game(g).map(r2)) } : null;

writeFileSync(path.join(here, 'airport.json'), `${JSON.stringify(out, null, 1)}\n`);
const counts: Record<string, Record<string, number>> = {};
for (const g of gates) ((counts[g.hero] ??= {})[g.size] = (counts[g.hero][g.size] ?? 0) + 1);
console.log(`airport.json: ${HEROES.length} heroes, ${gates.length} gates`, counts);
