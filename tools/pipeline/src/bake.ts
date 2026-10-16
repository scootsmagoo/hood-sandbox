import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig, REPO_ROOT, type TileConfig } from './config.js';
import { signedArea, type V2 } from './geo.js';
import { collisionBytes, heightmapBytes } from './io/binary.js';
import { encodeGlb, type GlbAttribute, type GlbPart, type MaterialSpec } from './io/glb.js';
import { MeshBuilder } from './mesh/builder.js';
import { makeChunkGrid, splitMesh, type ChunkGrid } from './mesh/chunks.js';
import { extrudeFootprint } from './mesh/extrude.js';
import { fetchDem, type Dem } from './sources/dem.js';
import { fetchOsm, fetchOsmBuildingParts, fetchOsmNodes, fetchOsmPois, fetchOsmProps } from './sources/osm.js';
import { fetchWikidataFacts } from './sources/wikidata.js';
import { fetchOvertureBuildings, fetchOvertureParts, type OvertureBuilding, type OvertureBuildingPart } from './sources/overture.js';
import { buildBuildings } from './world/buildings.js';
import { OcclusionField } from './world/ao.js';
import { declareRoofChannels, declareWallChannels, writePiece } from './world/buildingMesh.js';
import { BUILDING_KINDS } from './world/classify.js';
import { MATERIALS, ROOF_MATERIALS, STYLES } from './world/appearance.js';
import { buildContexts } from './world/context.js';
import { loadFacts } from './world/facts.js';
import { planBuilding } from './world/plan.js';
import { addRaisedToField, insetForCollision, skybridgeDatum } from './world/skybridge.js';
import { buildProps, type PropsRoad } from './world/props.js';
import { RoadMask } from './world/markings.js';
import { clipBuildingsToRoads } from './world/clip.js';
import { collisionRings } from './world/collisionRings.js';
import { heroDatum, hullBuildings, loadHeroSidecars, loadPack, placeHeroes, suppressReplaced, tileLandmarks } from './world/landmarks.js';
import { parseNodeTags } from './world/nodes.js';
import { parseOsm } from './world/osm.js';
import { buildRoads, planRoads } from './world/roads.js';
import { buildLanes } from './world/lanes.js';
import { addSyntheticSidewalkMesh, buildPaths } from './world/paths.js';
import { buildScenarios } from './world/scenarios.js';
import { areaInside, bakeTransit, footprintTest, shareInside, transitOutlines } from './world/transitBake.js';
import { pickSpawns } from './world/spawns.js';
import { buildGroundMesh, heightmapFromDem, LAND_CLASSES, minMax, rasterizeAreas, surfaceHeight } from './world/terrain.js';
import { DEFAULT_DECK_OPTIONS } from './world/decks.js';
import * as aero from './world/aerowayBake.js';

/** A grid tile builds no junction polygon this close (m) to its edges (see buildRoads). */
const SEAM_CLEAR = 30;
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const gray = (v: number): [number, number, number, number] => [linear(v), linear(v), linear(v), 1];

const MAT: Record<string, MaterialSpec> = {
  ground: { name: 'ground', baseColor: [1, 1, 1, 1], roughness: 1 },
  asphalt: { name: 'road_asphalt', baseColor: [1, 1, 1, 1], roughness: 0.95 },
  sidewalk: { name: 'road_sidewalk', baseColor: gray(0.62), roughness: 0.95 },
  crosswalk: { name: 'road_crosswalk', baseColor: gray(0.88), roughness: 0.9 },
  markings: { name: 'road_markings', baseColor: [1, 1, 1, 1], roughness: 0.7 },
  rail: { name: 'road_rail', baseColor: [linear(0.30), linear(0.26), linear(0.22), 1], roughness: 1 },
  concrete: { name: 'road_concrete', baseColor: [1, 1, 1, 1], roughness: 0.9 },
  // the airport's pavement and paint (world/aerowaySurface.ts)
  airfield: { name: 'road_airfield', baseColor: [1, 1, 1, 1], roughness: 0.92 },
  aeromark: { name: 'road_aeromark', baseColor: [1, 1, 1, 1], roughness: 0.75 },
  wall: { name: 'bld_wall', baseColor: [1, 1, 1, 1], roughness: 0.9 },
  roof: { name: 'bld_roof', baseColor: [1, 1, 1, 1], roughness: 0.95 },
  glass: { name: 'bld_glass', baseColor: [1, 1, 1, 1], metallic: 0.35, roughness: 0.25 },
};

/** How far either side of a lane's or a junction curve's centreline no pole, trunk or bollard may stand, m. */
const PROP_CLEAR = 1.6;
/** How far either side of a lane's or a junction curve's centreline no building may stand, m (a car's half width and a little). */
const LANE_CLEAR = 1.3;

/** Ground level of detail 1: every Nth heightmap sample, lowered and skirted (see the contract). */
export const GROUND_LOD1 = { step: 4, lower: 0.5, skirt: 3 };

/** Which builder channels become which glTF attributes, and in what storage type. */
type AttrSpec = { channel: string; name: string; type: 'f32' | 'u8' | 'u16'; width: 1 | 2 | 3 | 4; snap?: number };
const BUILDING_WALL_ATTRS: AttrSpec[] = [
  { channel: 'uv', name: 'TEXCOORD_0', type: 'f32', width: 2, snap: 32 },
  { channel: 'wall', name: '_WALL', type: 'f32', width: 4, snap: 32 },
  { channel: 'bld', name: '_BLD', type: 'u8', width: 4 },
  { channel: 'bid', name: '_BID', type: 'u16', width: 2 },
  { channel: 'look', name: '_LOOK', type: 'u8', width: 4 },
];
const BUILDING_ROOF_ATTRS: AttrSpec[] = [
  { channel: 'uv', name: 'TEXCOORD_0', type: 'f32', width: 2, snap: 32 },
  { channel: 'bld', name: '_BLD', type: 'u8', width: 4 },
  { channel: 'bid', name: '_BID', type: 'u16', width: 2 },
  { channel: 'look', name: '_LOOK', type: 'u8', width: 4 },
  { channel: 'srf', name: '_SRF', type: 'u8', width: 4 },
];
const ROAD_ATTRS: AttrSpec[] = [
  { channel: 'uv', name: 'TEXCOORD_0', type: 'f32', width: 2, snap: 32 },
  { channel: 'uv1', name: 'TEXCOORD_1', type: 'f32', width: 2, snap: 32 },
];

/** The glTF attributes (and the COLOR_0 alpha) of a finished builder: its channels in their storage types. */
function attributesOf(mb: MeshBuilder, specs: AttrSpec[]): { attributes: GlbAttribute[]; alpha?: number[] } {
  mb.pad();
  const attributes: GlbAttribute[] = [];
  for (const sp of specs) {
    const ch = mb.channels.get(sp.channel);
    if (!ch) continue;
    const n = ch.data.length;
    if (sp.type === 'f32') {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = sp.snap ? Math.round(ch.data[i] * sp.snap) / sp.snap : ch.data[i];
      attributes.push({ name: sp.name, array: a, width: sp.width });
    } else {
      const a = sp.type === 'u8' ? new Uint8Array(n) : new Uint16Array(n);
      const max = sp.type === 'u8' ? 255 : 65535;
      for (let i = 0; i < n; i++) a[i] = Math.max(0, Math.min(max, Math.round(ch.data[i])));
      attributes.push({ name: sp.name, array: a, width: sp.width });
    }
  }
  return { attributes, alpha: mb.channels.get('ao')?.data };
}

/** One glTF node per chunk and material. The chunk is in the node's extras, and the name too. */
function chunked(kind: string, mat: MaterialSpec, mb: MeshBuilder, grid: ChunkGrid, specs: AttrSpec[] = []): GlbPart[] {
  const parts: GlbPart[] = [];
  for (const [key, m] of [...splitMesh(mb, grid)].sort((a, b) => a[0] - b[0])) {
    const cx = key % grid.cols;
    const cz = Math.floor(key / grid.cols);
    parts.push({ name: `${kind}_${cx}_${cz}`, material: mat, positions: m.positions, normals: m.normals, colors: m.colors, indices: m.indices, ...attributesOf(m, specs), extras: { kind, chunk: [cx, cz] } });
  }
  return parts;
}

function write(file: string, data: Uint8Array | string): number {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return statSync(file).size;
}

export interface BakeReport {
  outDir: string;
  sizes: Record<string, number>;
  totalBytes: number;
  [k: string]: unknown;
}

export async function bake(cfg: TileConfig = loadTileConfig()): Promise<BakeReport> {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const used = { osm: false, overture: false, dem: false };

  log(`bake ${cfg.id}`);
  const osm = await fetchOsm(cfg);
  used.osm = true;
  log(`osm: ${osm.elements.length} elements`);
  // an airport in the tile's grid (world/aerowayBake.ts): its roads under overhangs and its freeway under the pavement are opened up
  const airport = aero.loadAerowayTile(cfg, log);
  if (airport) {
    const r = aero.prepareOsm(airport, cfg, osm);
    log(`aeroway: ${r.passages} roads under building overhangs built at grade, ${r.underPavement} freeway tunnels under the pavement built in their cuts`);
  }

  let dem: Dem | null = null;
  try {
    dem = await fetchDem(cfg);
    used.dem = true;
    log(`dem: ${dem.width}x${dem.height}`);
  } catch (e) {
    console.warn(`dem unavailable, writing a flat heightmap: ${(e as Error).message}`);
  }

  let overture: OvertureBuilding[] | null = null;
  let overtureRelease = '';
  try {
    const o = await fetchOvertureBuildings(cfg);
    overture = o.buildings;
    overtureRelease = o.release;
    used.overture = overture.length > 0;
    log(`overture ${o.release}: ${overture.length} buildings`);
  } catch (e) {
    console.warn(`overture unavailable, falling back to OSM buildings: ${(e as Error).message}`);
  }

  let overtureParts: OvertureBuildingPart[] = [];
  if (overture) {
    overtureParts = await fetchOvertureParts(cfg);
    log(`overture building parts: ${overtureParts.length}`);
  }

  const world = parseOsm(osm, cfg.projector);
  const nodeTags = parseNodeTags(await fetchOsmNodes(cfg), cfg.projector);
  log(`osm nodes: ${nodeTags.size} tagged (signals, stops, crossings)`);
  log(`parsed: ${world.roads.length} ways, ${world.areas.length} areas, ${world.buildings.length} osm buildings`);

  const b = cfg.bounds;
  const { hm, baseElevation, flat } = heightmapFromDem(dem, cfg.projector, cfg.origin, cfg.cols, cfg.rows, cfg.cellSize, b.minX, b.minZ);
  const mm = minMax(hm);
  log(`heightmap ${hm.cols}x${hm.rows}, base ${baseElevation} m, relief ${mm.min.toFixed(1)}..${mm.max.toFixed(1)} m`);

  // the roads' vertical profiles first: they cut and fill the heightmap, which everything else stands on. A tile of a grid designs
  // them over its cell and `planMarginM` beyond (its neighbours' roads, as they will design them too), so the two designs agree
  // where a road crosses the seam; the cell's part of the carved ground is then the tile's.
  const pm = Math.round((cfg.planMarginM ?? 0) / cfg.cellSize);
  let planHm = hm;
  if (pm > 0) {
    planHm = heightmapFromDem(dem, cfg.projector, cfg.origin, cfg.cols + 2 * pm, cfg.rows + 2 * pm, cfg.cellSize, b.minX - pm * cfg.cellSize, b.minZ - pm * cfg.cellSize).hm;
  }
  if (airport) {
    // the airfield's ground and the airport buildings' floors, before the roads are designed on it
    aero.level(airport, cfg, planHm, baseElevation);
    log(`aeroway: ground levelled ${JSON.stringify(airport.stats.level)}`);
  }
  const plan = planRoads(world.roads, planHm);
  if (pm > 0) {
    for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) hm.data[r * hm.cols + c] = planHm.data[(r + pm) * planHm.cols + c + pm];
    log(`road design over the cell and ${pm * cfg.cellSize} m beyond it (${planHm.cols}x${planHm.rows} samples)`);
  }
  log(`profiles: ${plan.stats.nodes} nodes, ${plan.stats.dipNodes} in dips, ${plan.stats.ties} side-by-side ties, ${plan.stats.clearances} clearances under car decks (short by up to ${plan.stats.clearanceShort.toFixed(2)} m), ${plan.stats.relaxedCurves} vertical curves eased and ${plan.stats.softTies} ties loosened to keep a grade or clearance, ${plan.stats.atGradeBridges} mapped bridges at grade built on the ground, ${plan.stats.deadDeckEnds} deck ends where no road goes on brought down to the ground, ${plan.stats.deckSpans} bridged spans (${plan.stats.embankedSpans} more with nothing under them are embankments; ${Math.round(plan.stats.deckMetres)} m designed), terrain moved at ${plan.stats.carvedVertices} vertices (cut up to ${plan.stats.maxCut.toFixed(1)} m, fill up to ${plan.stats.maxFill.toFixed(1)} m; ground cut away under decks up to ${plan.stats.underDeckCut.toFixed(1)} m); corridor smoothed at ${plan.stats.smoothedVertices} vertices (up to ${plan.stats.smoothMaxChange.toFixed(2)} m); bridges grown by ${plan.stats.deckNodesExtended} nodes to land (${plan.stats.mappedEndsExtended} mapped bridge ends carried on), ${plan.stats.deckEndsUnlanded} ends still off the ground`);

  const land = rasterizeAreas(world.areas, hm);
  if (airport) aero.land(airport, land, hm);
  const grid = makeChunkGrid(b, cfg.chunkSize);
  const cellsPerChunk = cfg.chunkSize / hm.cellSize;
  const l1Step = GROUND_LOD1.step * cfg.groundMeshStep;
  if (!Number.isInteger(cellsPerChunk) || cellsPerChunk % l1Step !== 0) throw new Error(`chunk size ${cfg.chunkSize} m must be a multiple of ${l1Step} heightmap cells`);
  const groundParts: GlbPart[] = [];
  const groundTris = [0, 0];
  for (let cz = 0; cz < grid.rows; cz++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const range = { c0: cx * cellsPerChunk, c1: (cx + 1) * cellsPerChunk, r0: cz * cellsPerChunk, r1: (cz + 1) * cellsPerChunk };
      const levels = [
        buildGroundMesh(hm, land, cfg.groundMeshStep, range),
        buildGroundMesh(hm, land, l1Step, range, { lower: GROUND_LOD1.lower, skirt: GROUND_LOD1.skirt }),
      ];
      levels.forEach((g, lod) => {
        groundTris[lod] += g.indices.length / 3;
        groundParts.push({ name: `ground_${cx}_${cz}_L${lod}`, material: MAT.ground, positions: g.positions, normals: g.normals, colors: g.colors, indices: g.indices, attributes: [{ name: '_LAND', array: g.land as Uint8Array<ArrayBuffer>, width: 4 }], extras: { kind: 'ground', chunk: [cx, cz], lod } });
      });
    }
  }
  log(`ground: ${grid.cols}x${grid.rows} chunks, ${groundTris[0]} triangles at full resolution, ${groundTris[1]} at level 1`);

  const roads = buildRoads(plan, hm, b, nodeTags, { seamClear: (cfg.planMarginM ?? 0) > 0 ? SEAM_CLEAR : 0 });
  log(`markings: ${roads.markingStats.lines} lines, ${roads.markingStats.crosswalks} crosswalks (${roads.markingStats.bars} bars), ${roads.markingStats.stopBars} stop bars, ${roads.markings.triangleCount} triangles; ${roads.controls.signals.length} signals, ${roads.controls.stops.length} stop signs, ${roads.controls.junctions.filter((c) => c.control === "signals").length} signalised and ${roads.controls.junctions.filter((c) => c.control === "stop").length} stop-controlled junctions`);
  log(`junctions: ${roads.junctionStats.built} polygons from ${roads.junctionStats.candidates} junction nodes (${roads.junctionStats.clusters} clusters); not built: ${JSON.stringify(roads.junctionStats.rejected)}`);
  log(`roads: ${roads.stats.ways} pieces, ${roads.stats.drivableWays} drivable, ${roads.stats.deckWays} decks (${Math.round(roads.stats.deckMetres)} m), ${roads.stats.piers} piers`);
  // the airport's pavement and paint, and its decks over cuts (their slabs into the road collision)
  const airfield = airport ? aero.meshes(airport, hm, b, roads) : null;
  if (airport) log(`aeroway: pavement ${JSON.stringify(airport.stats.meshes)}`);

  // what the sources say of how buildings look beyond their footprints: OSM building parts, Wikidata facts, the known heights and looks
  const osmPartsData = await fetchOsmBuildingParts(cfg);
  const osmParts = osmPartsData ? parseOsm(osmPartsData, cfg.projector).parts ?? [] : [];
  const wikidata = await fetchWikidataFacts(cfg, world.buildings.map((ob) => ob.tags.wikidata).filter((q): q is string => !!q && /^Q\d+$/.test(q)));
  const facts = loadFacts(path.join(REPO_ROOT, 'data', 'cities', cfg.city.id));
  const built = buildBuildings(overture, world.buildings, cfg.projector, b, overtureParts, { wikidata, facts, osmParts });
  const bstats = built.stats;
  log(`building looks from the feeds (colour ${JSON.stringify(bstats.look.colour)}, roof colour ${JSON.stringify(bstats.look.roofColour)}, material ${JSON.stringify(bstats.look.material)}, style ${JSON.stringify(bstats.look.style)}, year ${JSON.stringify(bstats.look.year)}, floors ${JSON.stringify(bstats.look.floors)}; ${bstats.look.bare} of ${bstats.total} buildings have none of it); ${bstats.osmPartsAdded} OSM building parts added, ${bstats.osmHeightRefused} OSM heights refused for a piece inside a bigger outline; known heights: ${bstats.facts?.heights.applied ?? 0} fixed, ${bstats.facts?.heights.mismatched.length ?? 0} still below the known height; curated looks: ${bstats.facts?.looks.applied ?? 0}`);
  // the lane graph comes from the roads alone; its lanes and junction curves also cut the buildings they would run into
  const lanes = buildLanes(roads.json, roads.exported, (cfg.planMarginM ?? 0) > 0 ? { bounds: b } : {});
  const lanePaths: { pts: V2[]; half: number }[] = [];
  for (const e of lanes.edges) {
    // (a lane on a deck too: a building that stands up through a deck is a wall in it)
    const pts: V2[] = [];
    for (let k = 0; k + 2 < e.pts.length; k += 3) pts.push([e.pts[k], e.pts[k + 2]]);
    lanePaths.push({ pts, half: LANE_CLEAR });
  }
  // hero landmarks (world/landmarks.ts): the generic buildings they replace go before anything else sees them
  const heroes = placeHeroes([...loadHeroSidecars(path.join(REPO_ROOT, 'public', 'assets', 'landmarks')), ...(airport?.heroes ?? [])], cfg.projector, b);
  const suppressedHeroes = suppressReplaced(built.buildings, heroes);
  // the elevated stations' structures (world/transitBake.ts): the generic building the map draws round a platform goes
  const outlines = transitOutlines(cfg.city.id, cfg.projector, b);
  const transitDropped = outlines.grown.length ? suppressedHeroes.buildings.filter((bd) => shareInside(bd.rings[0], outlines.grown) >= 0.3 || areaInside(bd.rings[0], outlines.deck) > 4).map((bd) => bd.id) : [];
  const suppressed = transitDropped.length ? { ...suppressedHeroes, buildings: suppressedHeroes.buildings.filter((bd) => !transitDropped.includes(bd.id)) } : suppressedHeroes;
  if (transitDropped.length) log(`transit: ${transitDropped.length} buildings over elevated stations left out (${transitDropped.join(', ')})`);
  const clip = clipBuildingsToRoads(suppressed.buildings, world.roads, 0.3, 6, lanePaths);
  // where cars drive (lanes and junction curves, a car's half width and a little either side): no pole, trunk or shelter stands there
  const laneMask = new RoadMask();
  for (const p of lanePaths) laneMask.addPolyline(p.pts, PROP_CLEAR);
  const heroDatums = heroes.map((h) => heroDatum(h, (x, z) => surfaceHeight(hm, x, z), baseElevation));
  // a hero's hull is a building of the bake that is not drawn (its model is): collision, occlusion, footprints
  // (the airport's heroes stand at their curbs: a hull prism a lane runs through, a vestibule or a canopy's column, is cut by it as a building is)
  const hulls = heroes.flatMap((h, i) => hullBuildings(h, heroDatums[i]));
  const airportHulls = hulls.filter((bd) => typeof airport?.heroes.find((s) => s.id === bd.hero?.id)?.elevation === 'number');
  const cutHulls = airportHulls.length ? clipBuildingsToRoads(airportHulls, [], 0.3, 0.2, lanePaths).buildings : [];
  const buildings = [...clip.buildings, ...hulls.filter((bd) => !airportHulls.includes(bd)), ...cutHulls];
  if (heroes.length) log(`heroes: ${heroes.map((h, i) => `${h.side.id} (replaces ${suppressed.replaced.get(h.side.id)!.length} buildings, ${h.hull.length} hull prisms)`).join(', ')}`);
  log(`buildings on streets: ${clip.stats.clipped} cut by a road or a lane (${Math.round(clip.stats.removedAreaM2)} m2 removed, ${clip.stats.pieces} pieces, ${clip.stats.dropped} slivers dropped, ${clip.stats.failed ?? 0} the clipper could not cut)`);
  const contexts = buildContexts(buildings);
  const wall = declareWallChannels(new MeshBuilder());
  const roof = declareRoofChannels(new MeshBuilder());
  const glassWall = declareWallChannels(new MeshBuilder());
  const collision = new MeshBuilder();
  let skipped = 0;
  let holed = 0;
  const kept: V2[][][] = [];

  // pass 1: classify and plan every building (its ground datum, kind, pieces and roofs), and stamp the occlusion field
  const field = new OcclusionField(b);
  const planned: { bd: (typeof buildings)[number]; datum: number; plan: ReturnType<typeof planBuilding> }[] = [];
  const kindCounts: Record<string, number> = Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0]));
  const look = { material: {} as Record<string, number>, style: {} as Record<string, number>, era: {} as Record<string, number>, roof: {} as Record<string, number>, materialData: 0, styleData: 0, colourData: 0, floorsData: 0, context: 0, crown: 0 };
  const bstat = { kindFromData: 0, eraFromData: 0, withParts: 0, pieces: 0, podiums: 0, pitchedBuildings: 0, pitchedPieces: 0, glass: 0, floating: 0 };
  for (const bd of buildings) {
    const outer = bd.rings[0];
    // (a hero's hull prism may be small: a wall, a counter, a post)
    if (Math.abs(signedArea(outer)) < (bd.hero ? 0.2 : 6)) { skipped++; continue; }
    let minY = Infinity;
    for (const p of outer) minY = Math.min(minY, surfaceHeight(hm, p[0], p[1]));
    const cx = outer.reduce((a, p) => a + p[0], 0) / outer.length;
    const cz = outer.reduce((a, p) => a + p[1], 0) / outer.length;
    minY = Math.min(minY, surfaceHeight(hm, cx, cz));
    // a skybridge floats over the street: its clearance is measured from the highest ground under it (the ring, its edges' middles and a line along it)
    if (bd.skybridge) minY = skybridgeDatum(outer, hm);
    if (bd.hero) minY = bd.hero.datum;
    const plan = planBuilding(bd, contexts.get(bd.id));
    planned.push({ bd, datum: minY, plan });
    kindCounts[plan.cls.kind]++;
    if (plan.cls.kindFromData) bstat.kindFromData++;
    look.material[plan.cls.material] = (look.material[plan.cls.material] ?? 0) + 1;
    look.style[plan.cls.style] = (look.style[plan.cls.style] ?? 0) + 1;
    look.era[plan.cls.era] = (look.era[plan.cls.era] ?? 0) + 1;
    look.roof[plan.cls.roofMaterial] = (look.roof[plan.cls.roofMaterial] ?? 0) + 1;
    if (plan.cls.materialFromData) look.materialData++;
    if (plan.cls.styleFromData) look.styleData++;
    if (plan.cls.colourFromData) look.colourData++;
    if (plan.cls.floorsFromData) look.floorsData++;
    if (plan.cls.fromContext) look.context++;
    if (plan.cls.crown > 0) look.crown++;
    if (plan.cls.eraFromData) bstat.eraFromData++;
    if (plan.stats.parts > 0) bstat.withParts++;
    bstat.pieces += plan.pieces.length;
    if (plan.stats.podium) bstat.podiums++;
    if (plan.stats.pitched > 0) { bstat.pitchedBuildings++; bstat.pitchedPieces += plan.stats.pitched; }
    if (plan.pieces.some((p) => p.kind === 'glass')) bstat.glass++;
    for (const pc of plan.pieces) {
      if (pc.baseH > 2) bstat.floating++;
      // a raised piece shades the ground under it like a deck, not like a wall down to the ground
      if (pc.baseH > 2) addRaisedToField(field, pc.rings, minY + pc.baseH);
      else field.addBuilding(pc.rings, minY + pc.topH);
    }
  }
  // the undersides of the decks shade the ground below them
  for (const r of roads.json) {
    if (!r.bridge) continue;
    for (let i = 0; i + 1 < r.points.length; i++) field.addDeck([r.points[i][0], r.points[i][2]], [r.points[i + 1][0], r.points[i + 1][2]], r.width / 2 + 0.5, Math.min(r.points[i][1], r.points[i + 1][1]) - DEFAULT_DECK_OPTIONS.thickness);
  }
  const ao = (x: number, y: number, z: number, n?: V2) => field.ao(x, y, z, n);

  // pass 2: the meshes and the collision prisms
  const equipment: Record<string, number> = {};
  let wallTris = 0;
  let roofTris = 0;
  const heroHullTris = new Map<string, number>();
  for (const { bd, datum: minY, plan } of planned) {
    const tris0 = collision.triangleCount;
    for (const pc of bd.hero ? [] : plan.pieces) {
      const st = writePiece({ datumY: minY, wall, glass: glassWall, roof, ao }, pc);
      wallTris += st.wallTris;
      roofTris += st.roofTris;
      for (const [k, v] of Object.entries(st.equipment)) equipment[k] = (equipment[k] ?? 0) + v;
    }
    // (a floating building leaves the ground under it open: paths, spawns and props may use it)
    if (plan.solidBaseH <= 0) kept.push(bd.rings);
    // The collision footprint is the drawn one, courtyards included (a hole left out would be an invisible solid in a
    // courtyard and leave its inner walls to walk through), simplified a little so the trimesh stays small. It stays one prism
    // as tall as the highest point of the drawn building (a ridge, the top of the tallest part).
    const solid = plan.solidBaseH > 0 ? insetForCollision(collisionRings(bd.rings)) : collisionRings(bd.rings);
    if (solid.length > 1) holed++;
    const scratchRoof = new MeshBuilder();
    // the prism of a floating building (a skybridge) runs from its underside to its top: walls and a roof as any building's (the sim recovers the
    // footprint from the roof triangles, so there is no floor; nothing can reach the open underside), and nothing below it, so the way under it is open
    const floatY = plan.solidBaseH > 0 ? minY + plan.solidBaseH : null;
    extrudeFootprint(solid, { baseY: floatY ?? minY - 0.3, topY: minY + plan.maxTopH, wall: collision, roof: scratchRoof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const base = collision.vertexCount;
    for (let i = 0; i < scratchRoof.vertexCount; i++) collision.vertex(scratchRoof.positions[i * 3], scratchRoof.positions[i * 3 + 1], scratchRoof.positions[i * 3 + 2], 0, 1, 0);
    for (const i of scratchRoof.indices) collision.indices.push(base + i);
    if (bd.hero) heroHullTris.set(bd.hero.id, (heroHullTris.get(bd.hero.id) ?? 0) + collision.triangleCount - tris0);
  }
  const buildingCollisionTris = collision.triangleCount;
  log(`buildings: ${kept.length} on the ground (${skipped} tiny skipped, ${holed} with courtyards), ${planned.filter((p) => p.bd.skybridge).length} skybridges floating (${planned.filter((p) => p.plan.solidBaseH > 0).length} with the ground under them open), heights ${JSON.stringify(bstats.heightSources)}`);
  log(`building looks: material ${JSON.stringify(look.material)} (${look.materialData} from data), style ${JSON.stringify(look.style)} (${look.styleData} from data), era ${JSON.stringify(look.era)}, roof ${JSON.stringify(look.roof)}; wall colour from data ${look.colourData}, floors from data ${look.floorsData}, ${look.context} decided by the neighbours, ${look.crown} with a crown`);
  log(`building kinds: ${JSON.stringify(kindCounts)}; ${bstat.kindFromData} classified from data, ${bstat.eraFromData} dated; ${bstat.withParts} stepped (${bstat.pieces} pieces, ${bstat.podiums} podiums), ${bstat.pitchedBuildings} with pitched roofs; rooftop equipment ${JSON.stringify(equipment)}; ${wallTris} wall and ${roofTris} roof triangles`);

  // collision: buildings then elevated deck slabs and piers
  const cbase = collision.vertexCount;
  for (let i = 0; i < roads.collision.vertexCount; i++) {
    collision.vertex(roads.collision.positions[i * 3], roads.collision.positions[i * 3 + 1], roads.collision.positions[i * 3 + 2], 0, 1, 0);
  }
  for (const i of roads.collision.indices) collision.indices.push(cbase + i);

  const spawns = pickSpawns({ roads: roads.json, ways: world.roads, footprints: kept, hm, bounds: b });
  log(`spawns: player ${JSON.stringify(spawns.player)}, vehicle ${JSON.stringify(spawns.vehicle)}`);

  // the walk network (paths.json); the synthetic sidewalks it adds also get a ribbon in the sidewalk mesh
  const deckY = new Map<number, number>();
  plan.deckWays.forEach((di, k) => plan.dense[di].nodeIds.forEach((id, i) => { if (id > 0 && plan.dense[di].w.kind === 'ped') deckY.set(id, plan.deckY[k][i]); }));
  const crossingSignals = new Map(roads.crossings.map((c) => [c.id, c.signals]));
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const paths = buildPaths({ ways: world.roads, roads: roads.json, junctions: roads.exported, crossingSignals, footprints: kept, bounds: b, ground, deckY });
  const ps = paths.file.stats;
  addSyntheticSidewalkMesh(roads.sidewalk, paths.syntheticLines, ground, (x, z) => roads.mask.contains(x, z));
  log(`paths: ${ps.nodes} nodes, ${ps.edges} edges, ${(ps.lengthM / 1000).toFixed(1)} km (${(ps.syntheticM / 1000).toFixed(1)} km synthetic), ${ps.components} components (largest ${(ps.largestShare * 100).toFixed(1)}%), ${ps.crossings.total} crossings (${ps.crossings.signals} signalised, ${ps.crossings.atJunctions} at junctions, ${ps.crossings.made} made), ${ps.droppedByBuildings} vertices cut by buildings`);

  const pois = await fetchOsmPois(cfg);
  const scenarios = buildScenarios({ pois, projector: cfg.projector, paths: paths.file, roads: roads.json, areas: world.areas, footprints: kept, bounds: b, ground });
  {
    // a bus stop's shelter and a bench are solid: none where a car's path runs (the shelter reaches about 1.6 m from its point)
    const before = scenarios.points.length;
    scenarios.points = scenarios.points.filter((p) => !(p.type === 'busstop' && laneMask.contains(p.x, p.z, -1.6)) && !(p.type === 'bench' && laneMask.contains(p.x, p.z, -0.6)));
    if (scenarios.points.length !== before) {
      scenarios.stats.total = scenarios.points.length;
      const byType: Record<string, number> = {};
      for (const q of scenarios.points) byType[q.type] = (byType[q.type] ?? 0) + 1;
      scenarios.stats.byType = byType as typeof scenarios.stats.byType;
      scenarios.stats.osm = scenarios.points.filter((q) => q.src === 'osm').length;
      scenarios.stats.synth = scenarios.points.filter((q) => q.src === 'synth').length;
      log(`scenarios: ${before - scenarios.points.length} bus stops and benches in a car's path left out`);
    }
  }
  // the walk-in heroes' interiors (the airport's terminal and concourse): walk network, scenario points, named places
  const inside = airport ? aero.interiors(airport, cfg, new Map(heroes.map((h, i) => [h.side.id, heroDatums[i]])), b, paths.file, scenarios, kept.map((r) => r[0])) : null;
  if (airport) log(`aeroway: interiors ${JSON.stringify(airport.stats.interiors)}`);
  log(`scenarios: ${scenarios.stats.total} points (${scenarios.stats.osm} from OSM, ${scenarios.stats.synth} synthesised${pois ? '' : '; the POI query failed'}) ${JSON.stringify(scenarios.stats.byType)}`);

  // tree, street lamp and furniture anchors (props.json): OSM where mapped, synthetic placements elsewhere
  const osmProps = await fetchOsmProps(cfg);
  const pathMask = new RoadMask();
  {
    const pn = paths.file.nodes;
    const pe = paths.file.edges;
    for (let i = 0; i + 2 < pe.length; i += 3) pathMask.addPolyline([[pn[pe[i]][0], pn[pe[i]][2]], [pn[pe[i + 1]][0], pn[pe[i + 1]][2]]], 0);
  }
  const propsRoads: PropsRoad[] = roads.json.map((r) => ({ class: r.class, width: r.width, oneway: r.oneway, bridge: r.bridge, points: r.points }));
  const props = buildProps({
    osm: osmProps,
    projector: cfg.projector,
    roads: propsRoads,
    pedestrianWays: world.roads.filter((w) => w.highway === 'pedestrian' && w.kind === 'ped' && w.sub !== 'crossing'),
    areas: world.areas,
    // (a hero's cut-out is kept clear too: the fountain's plaza has no walls, so no hull)
    footprints: [...kept, ...heroes.flatMap((h) => h.clearRings.map((r) => [r]))],
    roadMask: roads.mask,
    pathMask,
    laneMask,
    ground,
    bounds: b,
  });
  if (airport) {
    aero.props(airport, props, ground, b);
    log(`aeroway: props ${JSON.stringify(airport.stats.props)}`);
  }
  log(`props: ${props.trees.length} trees ${JSON.stringify(props.stats.trees)}, ${props.lamps.length} lamps ${JSON.stringify(props.stats.lamps)}, ${props.hydrants.length} hydrants, ${props.bins.length} bins, ${props.bollards.length} bollards${osmProps ? '' : '; the OSM props query failed, synthetic only'}`);

  // baked ambient occlusion: the alpha of COLOR_0 on the ground and the road meshes
  const aoOf = (positions: ArrayLike<number>, normals?: ArrayLike<number>): number[] => {
    const out = new Array<number>(positions.length / 3);
    for (let i = 0; i < out.length; i++) out[i] = ao(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    void normals;
    return out;
  };
  for (const gp of groundParts) gp.alpha = aoOf(gp.positions);
  for (const mb of [roads.asphalt, roads.sidewalk, roads.crosswalk, roads.rail, roads.markings, ...(airfield ? [airfield.surface, airfield.markings] : [])]) {
    const ch = mb.channel('ao', 1, [1]);
    ch.data = aoOf(mb.positions);
  }
  {
    // deck undersides are dark, their skirts and piers a little less
    const mb = roads.concrete;
    const ch = mb.channel('ao', 1, [1]);
    const base = aoOf(mb.positions);
    ch.data = base.map((v, i) => v * (mb.normals[i * 3 + 1] < -0.5 ? 0.4 : 0.75));
  }

  // write
  const out = cfg.outDir;
  const sizes: Record<string, number> = {};
  sizes['height.bin'] = write(path.join(out, 'height.bin'), heightmapBytes(hm.data));
  sizes['ground.glb'] = write(path.join(out, 'ground.glb'), await encodeGlb(groundParts));
  sizes['roads.glb'] = write(
    path.join(out, 'roads.glb'),
    await encodeGlb([
      ...chunked('asphalt', MAT.asphalt, roads.asphalt, grid, ROAD_ATTRS),
      ...chunked('sidewalk', MAT.sidewalk, roads.sidewalk, grid, ROAD_ATTRS),
      ...chunked('crosswalk', MAT.crosswalk, roads.crosswalk, grid),
      ...chunked('markings', MAT.markings, roads.markings, grid),
      ...chunked('rail', MAT.rail, roads.rail, grid),
      ...chunked('concrete', MAT.concrete, roads.concrete, grid),
      ...(airfield ? [...chunked('airfield', MAT.airfield, airfield.surface, grid), ...chunked('aeromarkings', MAT.aeromark, airfield.markings, grid)] : []),
    ]),
  );
  sizes['buildings.glb'] = write(
    path.join(out, 'buildings.glb'),
    await encodeGlb([
      ...chunked('walls', MAT.wall, wall, grid, BUILDING_WALL_ATTRS),
      ...chunked('roofs', MAT.roof, roof, grid, BUILDING_ROOF_ATTRS),
      ...chunked('glass_walls', MAT.glass, glassWall, grid, BUILDING_WALL_ATTRS),
    ]),
  );
  sizes['collision.bin'] = write(path.join(out, 'collision.bin'), collisionBytes(collision.positions, collision.indices));
  sizes['roads.json'] = write(path.join(out, 'roads.json'), JSON.stringify({ roads: roads.json, barriers: roads.barriers }));
  sizes['junctions.json'] = write(path.join(out, 'junctions.json'), JSON.stringify(roads.exported));
  sizes['lanes.json'] = write(path.join(out, 'lanes.json'), JSON.stringify(lanes));
  log(`lanes: ${lanes.stats.lanes} lanes (${lanes.stats.laneKm} km), ${lanes.stats.connectors} connectors, ${lanes.stats.junctions} junctions and ${lanes.stats.implicitJunctions} places where roads meet without one; largest strongly connected part ${(lanes.stats.largestComponent * 100).toFixed(1)}% of lane length (${(lanes.stats.largestComponentStreets * 100).toFixed(1)}% of surface streets)`);
  sizes['paths.json'] = write(path.join(out, 'paths.json'), JSON.stringify(paths.file));
  sizes['scenarios.json'] = write(path.join(out, 'scenarios.json'), JSON.stringify(scenarios));
  sizes['props.json'] = write(path.join(out, 'props.json'), JSON.stringify(props));
  const landmarkPack = loadPack(path.join(REPO_ROOT, 'data', 'cities', cfg.city.id));
  const landmarkFile = landmarkPack.length || heroes.length
    ? tileLandmarks(landmarkPack, heroes.map((h, i) => ({ place: h, datum: heroDatums[i], replaced: suppressed.replaced.get(h.side.id)!, hullTris: heroHullTris.get(h.side.id) ?? 0 })), cfg.projector, b)
    : null;
  if (landmarkFile && inside) {
    // the interiors' named places, and their indoor zones on their heroes
    landmarkFile.landmarks.push(...inside.places);
    for (const l of landmarkFile.landmarks) {
      const zn = inside.zones.get(l.id);
      if (zn && l.hero) l.zones = zn;
    }
  }
  if (landmarkFile) {
    sizes['landmarks.json'] = write(path.join(out, 'landmarks.json'), JSON.stringify(landmarkFile));
    log(`landmarks: ${landmarkFile.landmarks.length} in the tile, ${heroes.length} with a hero model`);
  }

  // the transit layer (world/transit*.ts): the rail lines, tunnels and stations under and over the tile, in files of their own
  const kitObstacles: V2[] = [...props.trees, ...props.lamps, ...props.hydrants, ...props.bins, ...props.bollards].map((t) => [t[0], t[2]] as V2);
  for (const q of scenarios.points) if (q.type === 'busstop' || q.type === 'bench') kitObstacles.push([q.x, q.z]);
  const transit = await bakeTransit({
    repoRoot: REPO_ROOT,
    cityId: cfg.city.id,
    endpoints: cfg.city.sources.osm.endpoints,
    projector: cfg.projector,
    bounds: b,
    chunkSize: cfg.chunkSize,
    outDir: out,
    ground,
    roads: roads.json,
    inBuilding: footprintTest(kept),
    obstacles: kitObstacles,
    log,
  }).catch((e) => {
    console.warn(`transit: failed (${(e as Error).message}); the tile is baked without transit`);
    return null;
  });
  if (transit) Object.assign(sizes, transit.sizes);

  const attribution = [cfg.city.sources.osm.attribution];
  if (used.overture) attribution.push(cfg.city.sources.overture.attribution);
  if (used.dem) attribution.push(cfg.city.sources.elevation.attribution);
  if (wikidata.size || facts.heights.length) attribution.push('Building heights and dates: Wikidata (CC0) and Wikipedia (CC BY-SA)');

  const tile = {
    format: 'hood-tile',
    version: 1,
    id: cfg.id,
    projection: cfg.projection,
    origin: { lat: cfg.origin.lat, lon: cfg.origin.lon, E: round(cfg.projector.E0, 3), N: round(cfg.projector.N0, 3) },
    baseElevation,
    bounds: { ...b },
    heightmap: { file: 'height.bin', cols: hm.cols, rows: hm.rows, cellSize: hm.cellSize, minX: hm.minX, minZ: hm.minZ },
    meshes: { ground: 'ground.glb', roads: 'roads.glb', buildings: 'buildings.glb' },
    chunks: {
      size: grid.size,
      minX: grid.minX,
      minZ: grid.minZ,
      cols: grid.cols,
      rows: grid.rows,
      groundLevels: [{ lod: 0, step: cfg.groundMeshStep }, { lod: 1, step: l1Step, lower: GROUND_LOD1.lower, skirt: GROUND_LOD1.skirt }],
    },
    collision: { file: 'collision.bin', vertexCount: collision.vertexCount, indexCount: collision.indices.length, buildingTriangles: buildingCollisionTris },
    roads: 'roads.json',
    junctions: 'junctions.json',
    lanes: 'lanes.json',
    paths: 'paths.json',
    scenarios: 'scenarios.json',
    props: 'props.json',
    ...(landmarkFile ? { landmarks: 'landmarks.json' } : {}),
    ...(transit ? { transit: transit.field } : {}),
    meshFormat: 3,
    buildingKinds: [...BUILDING_KINDS],
    buildingMaterials: [...MATERIALS],
    buildingStyles: [...STYLES],
    roofMaterials: [...ROOF_MATERIALS],
    landClasses: [...LAND_CLASSES],
    spawns,
    attribution,
    sources: {
      osm: used.osm,
      overtureBuildings: used.overture ? overtureRelease : false,
      overtureParts: overtureParts.length,
      osmProps: !!osmProps,
      elevation: used.dem ? 'usgs-3dep' : 'flat',
    },
  };
  sizes['tile.json'] = write(path.join(out, 'tile.json'), JSON.stringify(tile, null, 2));

  const totalBytes = Object.values(sizes).reduce((a, v) => a + v, 0);
  const report: BakeReport = {
    outDir: out,
    sizes,
    totalBytes,
    baseElevation,
    flatHeightmap: flat,
    heightRange: mm,
    ground: { chunks: grid.cols * grid.rows, trianglesLod0: groundTris[0], trianglesLod1: groundTris[1] },
    roads: { ...roads.stats, triangles: roads.asphalt.triangleCount + roads.sidewalk.triangleCount + roads.crosswalk.triangleCount + roads.rail.triangleCount + roads.concrete.triangleCount + roads.markings.triangleCount, markings: roads.markingStats, junctions: roads.junctionStats },
    buildings: { count: kept.length, skipped, sources: bstats, kinds: kindCounts, classification: bstat, rooftopEquipment: equipment, triangles: { walls: wall.triangleCount, roofs: roof.triangleCount, glass: glassWall.triangleCount } },
    props: props.stats,
    collision: { vertices: collision.vertexCount, triangles: collision.triangleCount, buildingTriangles: buildingCollisionTris },
    lanes: lanes.stats,
    spawns,
    seconds: (Date.now() - t0) / 1000,
  };
  log('done');
  console.log(JSON.stringify(report, null, 2));
  if (totalBytes > 15 * 1024 * 1024) console.warn(`WARNING: tile is ${(totalBytes / 1048576).toFixed(1)} MB, over the 15 MB budget`);
  return report;
}

function round(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bake().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
