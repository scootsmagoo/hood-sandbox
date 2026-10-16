/**
 * The airport's part of a tile bake (bake.ts calls these at the steps below; a tile of a grid without an airport, or with no
 * aeroway extract in the cache, bakes exactly as before: `loadAerowayTile` returns null).
 *
 *   prepareOsm   before the roads are parsed: roads under a terminal's overhang (`tunnel=building_passage`: the curbs) are
 *                built at grade, and a freeway "tunnel" under the pavement (I-285 under runway 10/28) is built in its cut, the
 *                pavement bridging it as a deck (aerowaySurface.ts)
 *   level        before the roads are designed: the airfield's ground (aerowaySurface.ts AirfieldField) and the airport heroes'
 *                floors (`flatten` rings of their sidecars, to their `elevation`)
 *   meshes       after the roads: the pavement, its decks and its paint (into the bake's own road builders)
 *   land         the infield is mown grass where nothing else is mapped
 *   props        no trees on the airfield, no lamps or furniture on the pavement; floodlight masts round the aprons
 *   interiors    the walk-in heroes' walk networks (joined to the streets' at their doors), scenario points and named places
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, REPO_ROOT, type CityGridSpec, type TileConfig } from '../config.js';
import type { Rect, V2 } from '../geo.js';
import { pointInRing } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import type { OsmData } from '../sources/osm.js';
import { inAerodrome, parseAirport, type Airport } from './aeroway.js';
import { readAeroway } from './aerowayFetch.js';
import { AirfieldField, airfieldClasses, buildAirfieldMarkings, buildAirfieldMeshes, linePieces, markingSink, pavementPieces, runwayTest, type Drape } from './aerowaySurface.js';
import type { HeroSidecar, TileLandmark } from './landmarks.js';
import { loadHeroSidecars } from './landmarks.js';
import type { PathsFile } from './paths.js';
import type { PropsFile } from './props.js';
import type { ScenariosFile, ScenarioPoint } from './scenarios.js';
import { landCode, surfaceHeight, type Heightmap } from './terrain.js';

/** Where the airport heroes' models and sidecars are (tools/blender/airport, `npm run assets`). */
export const AIRPORT_ASSETS = path.join(REPO_ROOT, 'public', 'assets', 'airport');

/** The interior of a walk-in hero (the sidecar's `interior`, model frame: see tools/blender/airport/apt.py). */
export interface HeroInterior {
  walk?: { nodes: [number, number, number][]; edges: [number, number, number][]; doors?: number[] };
  scenarios?: { type: string; x: number; y: number; z: number; yaw: number; cap: number }[];
  places?: { name: string; x: number; z: number; r: number }[];
  zones?: { ring: V2[]; ceiling: number }[];
}
export type AirportSidecar = HeroSidecar & { elevation?: number; flatten?: { ring: V2[]; margin: number }[]; interior?: HeroInterior; hooks?: Record<string, unknown> };

export interface AerowayTile {
  grid: CityGridSpec;
  ap: Airport;
  heroes: AirportSidecar[];
  field: AirfieldField | null;
  stats: Record<string, unknown>;
}

/** The grid spec of a grid tile's config (`<city>/<grid>/<cell>`), if it has an airport. */
function gridOf(cfg: TileConfig): CityGridSpec | null {
  const parts = cfg.id.split('/');
  if (parts.length < 3) return null;
  return cfg.city.grids?.find((g) => g.id === parts[1] && g.aeroway) ?? null;
}

/** The airport of a tile bake, or null (no airport in its grid, or its extract is not cached: the tile bakes without one). */
export function loadAerowayTile(cfg: TileConfig, log: (m: string) => void = () => {}): AerowayTile | null {
  const grid = gridOf(cfg);
  if (!grid?.aeroway) return null;
  const data = readAeroway(path.join(CACHE_DIR, cfg.city.id, grid.id), grid.aeroway.box);
  if (!data) {
    log(`aeroway: no ${grid.aeroway.icao} extract cached for grid ${grid.id} (npm run prefetch:m2 -- --grid ${grid.id} --lanes aeroway); baking without the airport`);
    return null;
  }
  const ap = parseAirport(data, cfg.projector);
  const heroes = loadHeroSidecars(AIRPORT_ASSETS) as AirportSidecar[];
  log(`aeroway ${grid.aeroway.icao}: ${ap.runways.length} runways (${ap.runways.map((r) => r.ref).join(', ')}), ${ap.lines.filter((l) => l.kind === 'taxiway' || l.kind === 'taxilane').length} taxiways and taxilanes, ${ap.areas.length} aprons, ${ap.stands.length} stands, ${ap.holding.length + ap.holdingLines.length} holding positions; ${heroes.length} airport hero sidecars`);
  return { grid, ap, heroes, field: null, stats: {} };
}

/** The terminal outlines of the airport (airport.json, tools/blender/airport), in the bake's frame: no road is opened up inside them. */
function terminalRings(cfg: TileConfig): V2[][] {
  const f = path.join(REPO_ROOT, 'tools', 'blender', 'airport', 'airport.json');
  if (!existsSync(f)) return [];
  const j = JSON.parse(readFileSync(f, 'utf8')) as { heroes: Record<string, { kind: string; anchor: { lat: number; lon: number }; rings: V2[][] }> };
  const out: V2[][] = [];
  for (const h of Object.values(j.heroes)) {
    if (h.kind !== 'terminal' && h.kind !== 'concourse') continue;
    const [ax, az] = cfg.projector.toGame(h.anchor.lon, h.anchor.lat);
    for (const r of h.rings) out.push(r.map((p) => [p[0] + ax, p[1] + az] as V2));
  }
  return out;
}

/** Before the OSM roads are parsed (see the module header). Returns how many ways were opened. */
export function prepareOsm(at: AerowayTile, cfg: TileConfig, osm: OsmData): { passages: number; underPavement: number } {
  // (service roads mostly on the pavement are dropped: see below)
  const pieces = pavementPieces(at.ap);
  const term = terminalRings(cfg);
  // the pieces bucketed by 64 m cells of their bounds (a point tests only the few round it)
  const G = 64;
  const cells = new Map<string, V2[][]>();
  for (const r of pieces) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of r) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    for (let cz = Math.floor(z0 / G); cz <= Math.floor(z1 / G); cz++) for (let cx = Math.floor(x0 / G); cx <= Math.floor(x1 / G); cx++) {
      const k = `${cx},${cz}`;
      const l = cells.get(k);
      if (l) l.push(r);
      else cells.set(k, [r]);
    }
  }
  const under = (x: number, z: number) => (cells.get(`${Math.floor(x / G)},${Math.floor(z / G)}`) ?? []).some((r) => pointInRing(x, z, r));
  let passages = 0, underPavement = 0, onApron = 0;
  for (const e of osm.elements) {
    const t = e.tags;
    // the airside service lanes painted on the aprons are not streets: no dark asphalt over the concrete, no traffic lanes
    if (e.type === 'way' && t?.highway === 'service' && e.geometry && e.geometry.length >= 2 && !(t.bridge && t.bridge !== 'no')) {
      const pts = e.geometry.map((g) => cfg.projector.toGame(g.lon, g.lat));
      let n = 0, hit = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
        for (let j = 0; j < k; j++) {
          n++;
          if (under(a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k)) hit++;
        }
      }
      if (n && hit / n >= 0.6) {
        delete t.highway;
        onApron++;
        continue;
      }
    }
    if (e.type !== 'way' || !t?.highway || !e.geometry || !t.tunnel || t.tunnel === 'no') continue;
    const pts = e.geometry.map((g) => cfg.projector.toGame(g.lon, g.lat));
    if (t.tunnel === 'building_passage' && /^(primary|secondary|tertiary|unclassified|residential|service|primary_link|secondary_link|tertiary_link)$/.test(t.highway)) {
      if (pts.some((p) => term.some((r) => pointInRing(p[0], p[1], r)))) continue;
      delete t.tunnel;
      passages++;
      continue;
    }
    if (/^(motorway|motorway_link|trunk|trunk_link|primary)$/.test(t.highway) && t.tunnel === 'yes') {
      // sampled every 5 m: a way that runs under the pavement anywhere
      let hit = false;
      for (let i = 0; i + 1 < pts.length && !hit; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
        for (let k = 0; k <= n && !hit; k++) hit = under(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      }
      if (!hit) continue;
      delete t.tunnel;
      delete t.covered;
      delete t.layer;
      underPavement++;
    }
  }
  at.stats.prepareOsm = { passages, underPavement, onApron };
  return { passages, underPavement };
}

/** The hero's anchor in the bake's frame. */
const anchorOf = (h: AirportSidecar, cfg: TileConfig): V2 => cfg.projector.toGame(h.anchor.lon, h.anchor.lat);

/** Distance from (x, z) to a ring's edges (0 inside). */
function ringDistance(x: number, z: number, r: V2[]): number {
  if (pointInRing(x, z, r)) return 0;
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    d = Math.min(d, Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z));
  }
  return d;
}

/** Levels the airfield and the heroes' floors on the design heightmap (before the roads are designed on it). */
export function level(at: AerowayTile, cfg: TileConfig, planHm: Heightmap, baseElevation: number): void {
  const field = new AirfieldField(planHm, at.ap);
  field.apply(planHm);
  at.field = field;
  let floors = 0, cells = 0;
  for (const h of at.heroes) {
    if (!h.flatten?.length || typeof h.elevation !== 'number') continue;
    const datum = h.elevation - baseElevation;
    const [ax, az] = anchorOf(h, cfg);
    for (const f of h.flatten) {
      const ring = f.ring.map((p) => [p[0] + ax, p[1] + az] as V2);
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
      const m = Math.max(0, f.margin);
      const c0 = Math.max(0, Math.floor((x0 - m - planHm.minX) / planHm.cellSize)), c1 = Math.min(planHm.cols - 1, Math.ceil((x1 + m - planHm.minX) / planHm.cellSize));
      const r0 = Math.max(0, Math.floor((z0 - m - planHm.minZ) / planHm.cellSize)), r1 = Math.min(planHm.rows - 1, Math.ceil((z1 + m - planHm.minZ) / planHm.cellSize));
      if (c1 < c0 || r1 < r0) continue;
      floors++;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const x = planHm.minX + c * planHm.cellSize, z = planHm.minZ + r * planHm.cellSize;
        const d = ringDistance(x, z, ring);
        if (d > m) continue;
        const i = r * planHm.cols + c;
        const t = m > 0 ? d / m : 0;
        const w = t * t * (3 - 2 * t);
        planHm.data[i] = datum + (planHm.data[i] - datum) * w;
        cells++;
      }
    }
  }
  at.stats.level = { ...field.stats, heroFloors: floors, heroCells: cells };
}

/** The surface the pavement stands on: the heightmap, or the airfield surface over a cut. */
export function drapeOf(at: AerowayTile, hm: Heightmap): Drape {
  const f = at.field!;
  return {
    top: (x, z) => (f.deck(x, z) ? f.surface(x, z) : surfaceHeight(hm, x, z)),
    deck: (x, z) => f.deck(x, z),
  };
}

/** The tile's pavement and paint, and the decks over cuts (their undersides into `concrete`, their slabs into `collision`). */
export function meshes(at: AerowayTile, hm: Heightmap, b: Rect, roads: { concrete: MeshBuilder; collision: MeshBuilder }): { surface: MeshBuilder; markings: MeshBuilder } {
  const surface = new MeshBuilder();
  const markings = new MeshBuilder();
  const drape = drapeOf(at, hm);
  const classes = airfieldClasses(at.ap, b);
  const ms = buildAirfieldMeshes(at.ap, classes, drape, { surface, concrete: roads.concrete, collision: roads.collision });
  const mk = buildAirfieldMarkings(at.ap, markingSink(markings, b, drape.top), runwayTest(at.ap));
  at.stats.meshes = { ...ms.stats, markings: mk, markingTris: markings.triangleCount };
  return { surface, markings };
}

/** Mown grass on the airfield where no land use is mapped (the land raster of the tile's heightmap). */
export function land(at: AerowayTile, landRaster: Uint8Array, hm: Heightmap): number {
  const grass = landCode('pitch');
  let n = 0;
  for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) {
    const i = r * hm.cols + c;
    if (landRaster[i] !== 0) continue;
    if (!inAerodrome(at.ap, hm.minX + c * hm.cellSize, hm.minZ + r * hm.cellSize)) continue;
    landRaster[i] = grass;
    n++;
  }
  at.stats.grassCells = n;
  return n;
}

/** Keeps the airfield clear (no synthetic trees inside the aerodrome, nothing on the pavement) and adds the apron masts. */
export function props(at: AerowayTile, p: PropsFile, ground: (x: number, z: number) => number, b: Rect): void {
  const f = at.field;
  const onPave = (x: number, z: number) => {
    if (!f) return false;
    const c = Math.round((x - f.minX) / f.cell), r = Math.round((z - f.minZ) / f.cell);
    return c >= 0 && r >= 0 && c < f.cols && r < f.rows && f.M[r * f.cols + c] === 1;
  };
  const before = { trees: p.trees.length, lamps: p.lamps.length };
  p.trees = p.trees.filter((t) => !onPave(t[0], t[2]) && !((t[6] === 0 || t[6] === 3) && inAerodrome(at.ap, t[0], t[2])));
  p.lamps = p.lamps.filter((l) => !onPave(l[0], l[2]));
  p.hydrants = p.hydrants.filter((q) => !onPave(q[0], q[2]));
  p.bins = p.bins.filter((q) => !onPave(q[0], q[2]));
  p.bollards = p.bollards.filter((q) => !onPave(q[0], q[2]));
  // floodlight masts round the aprons, every 90 m along their edges a few metres in, clear of every taxi line and stand
  const lines: V2[][] = [];
  for (const l of at.ap.lines) if (l.kind !== 'runway' && l.kind !== 'stopway') lines.push(l.pts);
  const clearOf = (x: number, z: number) => {
    for (const s of at.ap.stands) if (Math.hypot(s.x - x, s.z - z) < 42) return false;
    for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], q = pts[i + 1];
      const dx = q[0] - a[0], dz = q[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z) < 38) return false;
    }
    for (const rw of at.ap.runways) {
      const a = rw.ends[0].end, d = rw.ends[0].dir;
      const along = (x - a[0]) * d[0] + (z - a[1]) * d[1];
      if (along > -300 && along < rw.length + 300 && Math.abs((x - a[0]) * -d[1] + (z - a[1]) * d[0]) < 160) return false;
    }
    return true;
  };
  let masts = 0;
  for (const a of at.ap.areas) {
    if (a.kind !== 'apron') continue;
    const ring = a.rings[0];
    let carry = 45;
    for (let i = 0; i < ring.length; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (len < 1e-6) continue;
      const ux = (p1[0] - p0[0]) / len, uz = (p1[1] - p0[1]) / len;
      for (let s = carry; s < len; s += 90) {
        let x = p0[0] + ux * s, z = p0[1] + uz * s;
        // step 6 m inside
        const ix = x - uz * 6, iz = z + ux * 6;
        if (pointInRing(ix, iz, ring)) { x = ix; z = iz; } else { x = x + uz * 6; z = z - ux * 6; }
        if (x < b.minX || x >= b.maxX || z < b.minZ || z >= b.maxZ) continue;
        if (!pointInRing(x, z, ring) || !clearOf(x, z)) continue;
        p.lamps.push([Math.round(x * 100) / 100, Math.round(ground(x, z) * 100) / 100, Math.round(z * 100) / 100, Math.round(Math.atan2(-uz, ux) * 1000) / 1000, 24, 2, 1]);
        masts++;
      }
      carry = Math.max(0, carry - len) || (90 - ((len - carry) % 90));
    }
  }
  p.stats.lamps.synthetic += masts;
  p.stats.lamps.byKind[2] = (p.stats.lamps.byKind[2] ?? 0) + masts;
  at.stats.props = { treesRemoved: before.trees - p.trees.length, lampsRemoved: before.lamps - p.lamps.length + masts, masts };
}

/** Does the segment a-b cross any ring's edge? */
function crossesRings(a: V2, b: V2, rings: V2[][]): boolean {
  const cross = (p: V2, q: V2, r: V2, s: V2) => {
    const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
    const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  };
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), z0 = Math.min(a[1], b[1]), z1 = Math.max(a[1], b[1]);
  for (const r of rings) {
    let rx0 = Infinity, rx1 = -Infinity, rz0 = Infinity, rz1 = -Infinity;
    for (const p of r) { rx0 = Math.min(rx0, p[0]); rx1 = Math.max(rx1, p[0]); rz0 = Math.min(rz0, p[1]); rz1 = Math.max(rz1, p[1]); }
    if (rx1 < x0 || rx0 > x1 || rz1 < z0 || rz0 > z1) continue;
    for (let i = 0; i < r.length; i++) if (cross(a, b, r[i], r[(i + 1) % r.length])) return true;
  }
  return false;
}

/** The walk-in heroes' interiors: their walk networks (cut at the tile's edges, doors joined to the streets'), scenario points and places. */
export function interiors(
  at: AerowayTile,
  cfg: TileConfig,
  datums: Map<string, number>,
  b: Rect,
  paths: PathsFile,
  scenarios: ScenariosFile,
  walls: V2[][],
): { places: TileLandmark[]; zones: Map<string, { ring: V2[]; ceiling: number }[]> } {
  const places: TileLandmark[] = [];
  const zones = new Map<string, { ring: V2[]; ceiling: number }[]>();
  let nodesAdded = 0, edgesAdded = 0, links = 0, points = 0;
  const attr = (kind: 'footway' | 'link', width: number) => {
    let i = paths.attrs.findIndex((a) => a.kind === kind && a.width === width && !a.crossing && !a.bridge);
    if (i < 0) { i = paths.attrs.length; paths.attrs.push({ kind, width }); }
    return i;
  };
  const inside = (x: number, z: number) => x >= b.minX - 1e-6 && x <= b.maxX + 1e-6 && z >= b.minZ - 1e-6 && z <= b.maxZ + 1e-6;
  for (const h of at.heroes) {
    const it = h.interior;
    if (!it) continue;
    const datum = datums.get(h.id);
    if (datum == null) continue;
    const [ax, az] = anchorOf(h, cfg);
    const W = (p: { x: number; z: number } | [number, number]): V2 => (Array.isArray(p) ? [p[0] + ax, p[1] + az] : [p.x + ax, p.z + az]);
    // the walk network, cut at the tile's edges (the cut ends are seam ports: both tiles make the same node there)
    const first = paths.nodes.length;
    const key = new Map<string, number>();
    const node = (x: number, y: number, z: number) => {
      const k = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      let i = key.get(k);
      if (i == null) {
        i = paths.nodes.length;
        paths.nodes.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100]);
        key.set(k, i);
        nodesAdded++;
      }
      return i;
    };
    const wn = it.walk?.nodes ?? [];
    const world = wn.map((n) => [n[0] + ax, datum + n[1], n[2] + az] as [number, number, number]);
    for (const [ia, ib, width] of it.walk?.edges ?? []) {
      const A = world[ia], B = world[ib];
      if (!A || !B) continue;
      // Liang-Barsky against the tile
      let t0 = 0, t1 = 1;
      const dx = B[0] - A[0], dz = B[2] - A[2];
      const clip = (p: number, q: number) => {
        if (Math.abs(p) < 1e-12) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
      };
      if (!(clip(-dx, A[0] - b.minX) && clip(dx, b.maxX - A[0]) && clip(-dz, A[2] - b.minZ) && clip(dz, b.maxZ - A[2]))) continue;
      if (t1 - t0 < 1e-6) continue;
      const P = (t: number) => node(A[0] + dx * t, A[1] + (B[1] - A[1]) * t, A[2] + dz * t);
      paths.edges.push(P(t0), P(t1), attr('footway', Math.max(1, Math.min(6, width || 3))));
      edgesAdded++;
    }
    // doors: joined to the nearest node outside this hero (the streets' network or another hero's) within 30 m, in a clear line
    for (const d of it.walk?.doors ?? []) {
      const p = world[d];
      if (!p || !inside(p[0], p[2])) continue;
      const di = key.get(`${Math.round(p[0] * 100)},${Math.round(p[2] * 100)}`);
      if (di == null) continue;
      let best = -1, bd = 30;
      for (let i = 0; i < paths.nodes.length; i++) {
        // (not this hero's own nodes)
        if (i >= first) continue;
        const q = paths.nodes[i];
        const dd = Math.hypot(q[0] - p[0], q[2] - p[2]);
        if (dd >= bd || Math.abs(q[1] - p[1]) > 1.2) continue;
        if (crossesRings([p[0], p[2]], [q[0], q[2]], walls)) continue;
        best = i;
        bd = dd;
      }
      if (best >= 0) {
        paths.edges.push(di, best, attr('link', 2));
        links++;
      }
    }
    for (const s of it.scenarios ?? []) {
      const [x, z] = W(s);
      if (!inside(x, z)) continue;
      const pt: ScenarioPoint = { id: `${h.id}:${points}`, type: s.type as ScenarioPoint['type'], x: Math.round(x * 100) / 100, y: Math.round((datum + s.y) * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(s.yaw * 1000) / 1000, cap: s.cap, src: 'synth' };
      scenarios.points.push(pt);
      scenarios.stats.byType[pt.type] = (scenarios.stats.byType[pt.type] ?? 0) + 1;
      scenarios.stats.total++;
      scenarios.stats.synth++;
      points++;
    }
    for (const pl of it.places ?? []) {
      const [x, z] = W(pl);
      if (x < b.minX - pl.r || x > b.maxX + pl.r || z < b.minZ - pl.r || z > b.maxZ + pl.r) continue;
      places.push({ id: `${h.id}:${pl.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: pl.name, displayName: pl.name, kind: 'place', x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, radius: Math.round(pl.r) });
    }
    if (it.zones?.length) zones.set(h.id, it.zones.map((zn) => ({ ring: zn.ring.map((p) => { const w = W(p as [number, number]); return [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10] as V2; }), ceiling: zn.ceiling })));
  }
  paths.stats.nodes = paths.nodes.length;
  paths.stats.edges = paths.edges.length / 3;
  at.stats.interiors = { nodesAdded, edgesAdded, links, scenarios: points, places: places.length };
  return { places, zones };
}
