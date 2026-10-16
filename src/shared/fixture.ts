/**
 * The streaming test city (docs/contracts/city-tiles.md): a grid of procedural tiles (3 x 3 by default) in one frame, with a
 * street grid that crosses every seam, rolling hills, buildings, lanes, walk paths, props and scenario points. Each tile is made
 * on its own, clipped at its own edges the way the pipeline clips a baked tile (so a two-way road that leaves a tile gets a
 * turnaround there, and the runtime has to stitch the seams), and is a pure function of its cell: the sim and the client make the
 * same tiles without a file. The lane graph comes from the pipeline's own generator (`buildLanes`), so the fixture's lanes are
 * what a baked tile's are.
 */
import { buildLanes, type JunctionsInput, type RoadInput } from '../../tools/pipeline/src/world/lanes';
import { linkNeighbours, tileIdOf, type CityIndex, type CityTileEntry, type Rect } from './city';
import { encodeFarTile, type FarTile } from './farTile';
import { parseLanes } from './lanes';
import type { JunctionsData, PropsData, RoadData, TileData, TileManifest } from './tile';
import type { PathAttr, PathsData, ScenarioPoint, ScenariosData } from './walk';

export interface FixtureOptions {
  /** Side of a tile, m (default 384: 96 heightmap cells). */
  tileSize?: number;
  /** Cells run from -half to +half on both axes (default 1: a 3 x 3 grid). */
  half?: number;
  /** Height of the hills, m (default 3). */
  hills?: number;
  /** Leave out the buildings (a car test that only wants ground). */
  buildings?: boolean;
  /**
   * A freeway through every row of tiles: two one-way motorway carriageways of three lanes along the middle of the cell (z = S/2 +- 8),
   * eastbound on the south side, with no junction on them and no walk network along them. Its lanes cross the seams and leave the
   * loaded area at the ends of the city, so they do not loop (they are not in the main component).
   */
  freeway?: boolean;
}

const CELL = 4;
/** A building of the fixture: an axis-aligned box standing on the ground. */
export interface FixtureBuilding {
  x: number;
  z: number;
  sx: number;
  sz: number;
  h: number;
  kind: number;
}

export interface FixtureTile extends TileData {
  fixture: { i: number; j: number; buildings: FixtureBuilding[] };
}

interface Street {
  id: string;
  name: string;
  axis: 'x' | 'z';
  /** the line it runs along (z for an east-west street, x for a north-south one) */
  at: number;
  cls: string;
  lanes: number;
  width: number;
  oneway: boolean;
}

function opts(o: FixtureOptions = {}) {
  return { tileSize: o.tileSize ?? 384, half: o.half ?? 1, hills: o.hills ?? 3, buildings: o.buildings ?? true, freeway: o.freeway ?? false };
}

/** The ground of the whole city: smooth hills and a gentle tilt, under 7% everywhere. */
export function fixtureHeight(x: number, z: number, hills = 3): number {
  return hills * (0.8 * Math.sin(x / 70) * Math.cos(z / 90) + 0.5 * Math.sin((x + z) / 150)) + 0.012 * x - 0.008 * z;
}

/** The streets of the whole city: two each way through every cell, S/4 from its edges (none within S/4 of a seam). */
function streets(S: number, half: number): Street[] {
  const lines: number[] = [];
  for (let i = -half; i <= half; i++) lines.push(Math.round(i * S + S / 4), Math.round(i * S + (3 * S) / 4));
  const out: Street[] = [];
  lines.forEach((at, k) => {
    const avenue = k === 2 * half;
    out.push({ id: `fx:ew:${k}`, name: avenue ? 'Fixture Avenue' : `${ordinal(k + 1)} St`, axis: 'z', at, cls: avenue ? 'primary' : 'residential', lanes: avenue ? 4 : 2, width: avenue ? 14 : 9, oneway: false });
  });
  lines.forEach((at, k) => {
    const oneway = k === 2 * half + 2;
    out.push({ id: `fx:ns:${k}`, name: oneway ? 'One Way' : `${TREES_NAMES[k % TREES_NAMES.length]} Ave`, axis: 'x', at, cls: k === 2 * half ? 'secondary' : oneway ? 'tertiary' : 'residential', lanes: 2, width: k === 2 ? 11 : 9, oneway });
  });
  return out;
}

const TREES_NAMES = ['Elm', 'Oak', 'Pine', 'Ash', 'Maple', 'Birch', 'Cedar', 'Poplar'];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function fixtureBounds(i: number, j: number, S: number): Rect {
  return { minX: i * S, minZ: j * S, maxX: (i + 1) * S, maxZ: (j + 1) * S };
}

/** The city index of the fixture (no files: `path` names the cell for the fixture source). */
export function fixtureIndex(o: FixtureOptions = {}): CityIndex {
  const { tileSize: S, half } = opts(o);
  const tiles: CityTileEntry[] = [];
  for (let j = -half; j <= half; j++) {
    for (let i = -half; i <= half; i++) {
      tiles.push({ id: tileIdOf(i, j), i, j, bounds: fixtureBounds(i, j, S), path: `fixture/${tileIdOf(i, j)}/`, region: 'fixture', version: 'fixture-1' });
    }
  }
  linkNeighbours(tiles);
  const sp = fixtureSpawn(o);
  return {
    format: 'hood-city',
    version: 1,
    id: 'fixture/grid',
    city: 'fixture',
    origin: { lat: 33.7543, lon: -84.3898, E: 0, N: 0 },
    baseElevation: 0,
    tileSize: S,
    heightmapCellSize: CELL,
    tiles,
    spawn: { tile: tileIdOf(0, 0), ...sp },
    attribution: [],
  };
}

/** The player on the sidewalk of the avenue in the centre tile, the car at the curb beside them facing east. */
function fixtureSpawn(o: FixtureOptions) {
  const { tileSize: S, hills } = opts(o);
  const main = Math.round(S / 4);
  const vx = Math.round(S * 0.4), vz = main + 7 - 1.3;
  const px = vx - 4, pz = main + 7 + 3;
  return {
    player: { x: px, y: fixtureHeight(px, pz, hills), z: pz },
    vehicle: { x: vx, y: fixtureHeight(vx, vz, hills), z: vz, heading: -Math.PI / 2 },
  };
}

/** Clips the street `s` to the rectangle and samples it every `step` m (and at the ends), on the ground. */
function streetPiece(s: Street, b: Rect, hills: number, step = 8): [number, number, number][] | null {
  const lo = s.axis === 'z' ? b.minX : b.minZ;
  const hi = s.axis === 'z' ? b.maxX : b.maxZ;
  const across = s.axis === 'z' ? [b.minZ, b.maxZ] : [b.minX, b.maxX];
  if (s.at < across[0] || s.at >= across[1]) return null;
  const pts: [number, number, number][] = [];
  // one-way streets run toward -z (north): points ordered along the direction of travel
  const ts: number[] = [];
  for (let t = lo; t < hi; t += step) ts.push(t);
  ts.push(hi);
  if (s.oneway) ts.reverse();
  for (const t of ts) {
    const x = s.axis === 'z' ? t : s.at;
    const z = s.axis === 'z' ? s.at : t;
    pts.push([round2(x), round2(fixtureHeight(x, z, hills)), round2(z)]);
  }
  return pts;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Deterministic noise from a position (0..1). */
function hash(x: number, z: number, k = 0): number {
  let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 10) + k * 7919, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 100000) / 100000;
}

const inCell = (b: Rect, x: number, z: number) => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;

/** One tile of the fixture: everything a baked tile has, clipped to its cell. */
export function fixtureTile(i: number, j: number, o: FixtureOptions = {}): FixtureTile {
  const { tileSize: S, hills, buildings: withBuildings, freeway: withFreeway } = opts(o);
  const b = fixtureBounds(i, j, S);
  const id = `fixture/grid/${tileIdOf(i, j)}`;
  const all = streets(S, opts(o).half);

  // heightmap (both edges: neighbours share their seam samples exactly)
  const cols = Math.round(S / CELL) + 1;
  const heights = new Float32Array(cols * cols);
  for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = fixtureHeight(b.minX + c * CELL, b.minZ + r * CELL, hills);

  // roads: every street that crosses the cell, clipped to it
  const roads: RoadData[] = [];
  for (const s of all) {
    const pts = streetPiece(s, b, hills);
    if (!pts) continue;
    roads.push({ id: s.id, class: s.cls, name: s.name, lanes: s.lanes, oneway: s.oneway, bridge: false, layer: 0, width: s.width, points: pts });
  }

  // junctions where two streets cross inside the cell
  const ew = all.filter((s) => s.axis === 'z');
  const ns = all.filter((s) => s.axis === 'x');
  const junctions: JunctionsData = { junctions: [], signals: [], stops: [], crossings: [] };
  const jIn: JunctionsInput = { junctions: [] };
  let node = 1;
  for (const a of ew) {
    for (const c of ns) {
      const x = c.at, z = a.at;
      if (!inCell(b, x, z)) continue;
      const y = round2(fixtureHeight(x, z, hills));
      const control: 'signals' | 'stop' | 'none' = a.cls === 'primary' ? 'signals' : c.cls === 'secondary' ? 'stop' : 'none';
      const jid = `j${ew.indexOf(a)}_${ns.indexOf(c)}`;
      const legsSpec: { road: Street; dir: [number, number] }[] = [
        { road: a, dir: [-1, 0] },
        { road: a, dir: [1, 0] },
        { road: c, dir: [0, -1] },
        { road: c, dir: [0, 1] },
      ];
      const trim = Math.max(a.width, c.width) / 2 + 2.5;
      const legs = legsSpec.map(({ road, dir }) => {
        // a one-way street (toward -z) arrives from +z and departs toward -z
        const approach = !road.oneway || dir[1] > 0;
        const departure = !road.oneway || dir[1] < 0;
        // the stop line on the approach lanes: right of the centreline, looking toward the junction
        const half = road.width / 4;
        const sx = x + dir[0] * trim + (road.oneway ? 0 : dir[1] * half);
        const sz = z + dir[1] * trim - (road.oneway ? 0 : dir[0] * half);
        return {
          road: road.id,
          node,
          at: [x, z] as [number, number],
          dir,
          approach,
          departure,
          trim,
          control: approach ? control : ('none' as const),
          stopLine: approach ? ([round2(sx), round2(fixtureHeight(sx, sz, hills)), round2(sz)] as [number, number, number]) : null,
          crosswalk: true,
        };
      });
      const r = trim - 1;
      const polygon: [number, number][] = [
        [x - r, z - r],
        [x + r, z - r],
        [x + r, z + r],
        [x - r, z + r],
      ];
      junctions.junctions.push({ id: jid, x, y, z, control, nodes: [node], polygon, legs });
      jIn.junctions.push({ id: jid, x, y, z, control, polygon, legs });
      if (control === 'signals') junctions.signals.push({ node, x, y, z, junction: jid });
      node++;
    }
  }
  const streetRoads = roads.slice();
  if (withFreeway) {
    // (z grows to the south, and traffic keeps right: eastbound is the south carriageway)
    for (const [name, dz, dir] of [['e', 8, 1], ['w', -8, -1]] as const) {
      const z = Math.round(b.minZ + S / 2 + dz);
      const xs: number[] = [];
      for (let t = b.minX; t < b.maxX; t += 8) xs.push(t);
      xs.push(b.maxX);
      if (dir < 0) xs.reverse();
      roads.push({ id: `fx:fw:${name}`, class: 'motorway', name: 'Fixture Freeway', lanes: 3, oneway: true, bridge: false, layer: 0, width: 12, points: xs.map((x) => [round2(x), round2(fixtureHeight(x, z, hills)), z] as [number, number, number]) });
    }
  }
  const lanesFile = JSON.parse(JSON.stringify(buildLanes(roads as RoadInput[], jIn)));
  const lanes = parseLanes(lanesFile) ?? undefined;
  // signal heads stand on the kerb in a baked tile; these would stand in the road (the fixture's stop lines), so leave them out
  if (lanes) for (const jn of lanes.junctions) delete jn.heads;

  // the walk network: a sidewalk each side of every street, crossings round every junction, clipped to the cell
  const paths = buildPaths(streetRoads, junctions, b, hills);

  const buildings = withBuildings ? fixtureBuildings(b, all) : [];
  const mesh = buildingMesh(buildings, hills);

  // props and scenarios: only what stands in the cell (half-open)
  const anchors: PropsData = { version: 1, trees: [], lamps: [], hydrants: [], bins: [], bollards: [] };
  const points: ScenarioPoint[] = [];
  for (const s of all) {
    const span = s.axis === 'z' ? [b.minX, b.maxX] : [b.minZ, b.maxZ];
    for (const sideSign of [-1, 1]) {
      const off = s.width / 2 + 3.3;
      const first = Math.ceil((span[0] - 7) / 30) * 30 + 7;
      for (let t = first; t < span[1]; t += 30) {
        const x = s.axis === 'z' ? t : s.at + sideSign * off;
        const z = s.axis === 'z' ? s.at + sideSign * off : t;
        if (!inCell(b, x, z) || nearJunction(all, x, z, 14)) continue;
        const y = round2(fixtureHeight(x, z, hills));
        if (hash(x, z, 4) < 0.6) anchors.trees.push([round2(x), y, round2(z), 9 + hash(x, z, 5) * 5, 3 + hash(x, z, 6) * 1.5, 0, 0]);
        else {
          // a lamp, its arm toward the road
          const yaw = s.axis === 'z' ? (sideSign > 0 ? Math.PI : 0) : sideSign > 0 ? -Math.PI / 2 : Math.PI / 2;
          anchors.lamps.push([round2(x), y, round2(z), round2(yaw), 8, 0, 1]);
        }
        if (hash(x, z, 7) < 0.08) anchors.hydrants.push([round2(x + 1.2), y, round2(z + 1.2)]);
        if (hash(x, z, 8) < 0.1) points.push({ id: `s${points.length}`, type: 'bench', x: round2(x + 2), y, z: round2(z), yaw: s.axis === 'z' ? (sideSign > 0 ? 0 : Math.PI) : sideSign > 0 ? Math.PI / 2 : -Math.PI / 2, cap: 2, src: 'synth' });
      }
    }
  }
  const scenarios: ScenariosData = { version: 1, points };

  const sp = fixtureSpawn(o);
  const manifest: TileManifest = {
    format: 'hood-tile',
    version: 1,
    id,
    origin: { lat: 33.7543, lon: -84.3898, E: 0, N: 0 },
    baseElevation: 0,
    bounds: { ...b },
    heightmap: { file: 'height.bin', cols, rows: cols, cellSize: CELL, minX: b.minX, minZ: b.minZ },
    meshes: {},
    collision: { file: 'collision.bin', vertexCount: mesh.positions.length / 3, indexCount: mesh.indices.length, buildingTriangles: mesh.indices.length / 3 },
    roads: 'roads.json',
    junctions: 'junctions.json',
    lanes: 'lanes.json',
    paths: 'paths.json',
    scenarios: 'scenarios.json',
    props: 'props.json',
    spawns: { player: sp.player, vehicle: sp.vehicle },
    attribution: [],
  };
  return {
    manifest,
    heights,
    collisionPositions: new Float32Array(mesh.positions),
    collisionIndices: new Uint32Array(mesh.indices),
    roads,
    junctions,
    lanes,
    paths,
    scenarios,
    anchors,
    source: 'baked',
    fixture: { i, j, buildings },
  };
}


/** Boxes in the blocks between the streets of a cell, none within 6 m of a seam or 7 m of a street's edge. */
function fixtureBuildings(b: Rect, all: Street[]): FixtureBuilding[] {
  const ew = all.filter((s) => s.axis === 'z');
  const ns = all.filter((s) => s.axis === 'x');
  const buildings: FixtureBuilding[] = [];
  const lines = [b.minX, ...ns.map((s) => s.at).filter((v) => v > b.minX && v < b.maxX), b.maxX].sort((p, q) => p - q);
  const zl = [b.minZ, ...ew.map((s) => s.at).filter((v) => v > b.minZ && v < b.maxZ), b.maxZ].sort((p, q) => p - q);
  const roadHalf = (v: number, axis: 'x' | 'z') => (all.find((s) => s.axis === axis && s.at === v)?.width ?? 0) / 2;
  for (let xi = 0; xi + 1 < lines.length; xi++) {
    for (let zi = 0; zi + 1 < zl.length; zi++) {
      const x0 = lines[xi] + Math.max(6, roadHalf(lines[xi], 'x') + 7), x1 = lines[xi + 1] - Math.max(6, roadHalf(lines[xi + 1], 'x') + 7);
      const z0 = zl[zi] + Math.max(6, roadHalf(zl[zi], 'z') + 7), z1 = zl[zi + 1] - Math.max(6, roadHalf(zl[zi + 1], 'z') + 7);
      if (x1 - x0 < 14 || z1 - z0 < 14) continue;
      // a row of buildings along each long side of the block
      const nx = Math.max(1, Math.floor((x1 - x0) / 26));
      for (let k = 0; k < nx; k++) {
        for (const side of [0, 1]) {
          const w = (x1 - x0) / nx;
          const cx = x0 + w * (k + 0.5);
          const depth = Math.min(18, (z1 - z0) / 2 - 2);
          if (depth < 8) continue;
          const cz = side === 0 ? z0 + depth / 2 : z1 - depth / 2;
          const tall = hash(cx, cz) < 0.15;
          const h = tall ? 40 + hash(cx, cz, 1) * 80 : 8 + hash(cx, cz, 2) * 18;
          buildings.push({ x: cx, z: cz, sx: w - 4, sz: depth, h, kind: tall ? 2 : hash(cx, cz, 3) < 0.5 ? 3 : 9 });
        }
      }
    }
  }
  return buildings;
}

function nearJunction(all: Street[], x: number, z: number, r: number): boolean {
  const ew = all.filter((s) => s.axis === 'z').map((s) => s.at);
  const ns = all.filter((s) => s.axis === 'x').map((s) => s.at);
  return ew.some((zz) => Math.abs(zz - z) < r) && ns.some((xx) => Math.abs(xx - x) < r);
}

/**
 * The walk network: a sidewalk 2 m outside each side of every street, cut at the cell's edges, with nodes every 6 m and at the
 * kerb corners, joined by crossings across each leg of every junction.
 */
function buildPaths(roads: RoadData[], jd: JunctionsData, b: Rect, hills: number): PathsData {
  const nodes: [number, number, number][] = [];
  const attrs: PathAttr[] = [{ kind: 'sidewalk', width: 2 }];
  const edges: number[] = [];
  const key = new Map<string, number>();
  const nodeAt = (x: number, z: number): number => {
    const k = `${Math.round(x * 20)},${Math.round(z * 20)}`;
    let n = key.get(k);
    if (n === undefined) {
      n = nodes.length;
      nodes.push([round2(x), round2(fixtureHeight(x, z, hills) + 0.1), round2(z)]);
      key.set(k, n);
    }
    return n;
  };
  const crossAttr = (junction: string | null, leg: number | null, road: string, signals: boolean): number => {
    attrs.push({ kind: 'crossing', width: 3, crossing: { id: null, marked: true, signals, junction, leg, road } });
    return attrs.length - 1;
  };
  // the sidewalk lines: along each road at +-(half + 2), stopping at the kerb corners of each junction
  for (const r of roads) {
    const a = r.points[0], z1 = r.points[r.points.length - 1];
    const alongX = Math.abs(z1[0] - a[0]) > Math.abs(z1[2] - a[2]);
    const at = alongX ? a[2] : a[0];
    const lo = alongX ? Math.min(a[0], z1[0]) : Math.min(a[2], z1[2]);
    const hi = alongX ? Math.max(a[0], z1[0]) : Math.max(a[2], z1[2]);
    // the junctions this road passes: the sidewalk breaks where the cross street's sidewalk lines are
    const jcs: { c: number; half: number }[] = [];
    for (const j of jd.junctions) {
      if (!j.legs.some((l) => l.road === r.id)) continue;
      const cross = j.legs.find((l) => l.road !== r.id);
      const crossRoad = cross ? roads.find((q) => q.id === cross.road) : undefined;
      jcs.push({ c: alongX ? j.x : j.z, half: (crossRoad?.width ?? 9) / 2 + 2 });
    }
    const off = r.width / 2 + 2;
    for (const sideSign of [-1, 1]) {
      const line = at + sideSign * off;
      const marks = [lo, hi, ...jcs.flatMap(({ c, half }) => [c - half, c + half]).filter((m) => m > lo && m < hi)].sort((p, q) => p - q);
      for (let k = 0; k + 1 < marks.length; k++) {
        const s0 = marks[k], s1 = marks[k + 1];
        if (s1 - s0 < 0.5) continue;
        // not across the cross street (the crossings do that)
        const mid = (s0 + s1) / 2;
        if (jcs.some(({ c, half }) => Math.abs(mid - c) < half)) continue;
        const n = Math.max(1, Math.ceil((s1 - s0) / 6));
        let prev = -1;
        for (let q = 0; q <= n; q++) {
          const s = s0 + ((s1 - s0) * q) / n;
          const x = alongX ? s : line;
          const z = alongX ? line : s;
          if (x < b.minX - 1e-6 || x > b.maxX + 1e-6 || z < b.minZ - 1e-6 || z > b.maxZ + 1e-6) {
            prev = -1;
            continue;
          }
          const cur = nodeAt(x, z);
          if (prev >= 0 && prev !== cur) edges.push(prev, cur, 0);
          prev = cur;
        }
      }
    }
  }
  // crossings: across each leg, between the two sidewalk corners on that side of the junction
  for (const j of jd.junctions) {
    j.legs.forEach((l, li) => {
      const road = roads.find((q) => q.id === l.road);
      const cross = roads.find((q) => q.id === j.legs.find((m) => m.road !== l.road)!.road);
      if (!road || !cross) return;
      const d = cross.width / 2 + 2;
      const h = road.width / 2 + 2;
      // the leg runs along `dir`; the crossing lies across it, d metres from the centre
      const cx = j.x + l.dir[0] * d, cz = j.z + l.dir[1] * d;
      const ax = cx - l.dir[1] * h, az = cz + l.dir[0] * h;
      const bx = cx + l.dir[1] * h, bz = cz - l.dir[0] * h;
      if (!inRect(b, ax, az) || !inRect(b, bx, bz)) return;
      const na = nodeAt(ax, az), nb = nodeAt(bx, bz);
      edges.push(na, nb, crossAttr(j.id, li, road.id, j.control === 'signals'));
    });
  }
  return { version: 1, nodes, attrs, edges };
}

const inRect = (b: Rect, x: number, z: number) => x >= b.minX - 1e-6 && x <= b.maxX + 1e-6 && z >= b.minZ - 1e-6 && z <= b.maxZ + 1e-6;

/** Walls and a flat roof per building (no floor), as the pipeline writes `collision.bin`: the footprints come back from the roofs. */
function buildingMesh(list: FixtureBuilding[], hills: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const bd of list) {
    const x0 = bd.x - bd.sx / 2, x1 = bd.x + bd.sx / 2, z0 = bd.z - bd.sz / 2, z1 = bd.z + bd.sz / 2;
    let base = Infinity;
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) base = Math.min(base, fixtureHeight(x, z, hills));
    const y0 = base - 0.3, y1 = base + bd.h;
    // the ring counter-clockwise seen from above (+y): (x0,z1) (x1,z1) (x1,z0) (x0,z0) with +z south
    const ring: [number, number][] = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = ring[k];
      const [bx, bz] = ring[(k + 1) % 4];
      const v = positions.length / 3;
      positions.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const v = positions.length / 3;
    for (const [x, z] of ring) positions.push(x, y1, z);
    indices.push(v, v + 2, v + 1, v, v + 3, v + 2);
  }
  return { positions, indices };
}

/** The skyline level of detail of a fixture tile (`far.bin`, as the pipeline makes it). */
export function fixtureFar(i: number, j: number, o: FixtureOptions = {}): FarTile {
  const { tileSize: S, hills } = opts(o);
  const n = 33;
  const list = opts(o).buildings ? fixtureBuildings(fixtureBounds(i, j, S), streets(S, opts(o).half)) : [];
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = fixtureHeight(i * S + (c * S) / (n - 1), j * S + (r * S) / (n - 1), hills);
  return {
    grid: { n, minX: i * S, minZ: j * S, size: S, heights },
    buildings: list.map((bd) => ({
      kind: bd.kind,
      baseY: fixtureHeight(bd.x, bd.z, hills) - 0.3,
      topY: fixtureHeight(bd.x, bd.z, hills) + bd.h,
      ring: [bd.x - bd.sx / 2, bd.z - bd.sz / 2, bd.x - bd.sx / 2, bd.z + bd.sz / 2, bd.x + bd.sx / 2, bd.z + bd.sz / 2, bd.x + bd.sx / 2, bd.z - bd.sz / 2],
    })),
  };
}

export const fixtureFarBytes = (i: number, j: number, o: FixtureOptions = {}): Uint8Array => encodeFarTile(fixtureFar(i, j, o));
