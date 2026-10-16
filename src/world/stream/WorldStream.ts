/**
 * The client side of a streamed city (docs/contracts/city-tiles.md section 8): the tiles near the camera drawn in full (their baked
 * meshes, or the fixture's), the tiles of the far ring as the skyline level of detail, and the city-wide sets that read tile data
 * (trees, lamps and furniture through the look, benches and bus stops, signal heads, the minimap's atlases, the street names) handed
 * the union of the loaded tiles whenever it changes. The client keeps its own rings by the camera (it does not wait for the sim).
 *
 * At most one tile's meshes are added, and one city-wide set is rebuilt, in a frame; a dropped tile's meshes are disposed at once.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fixtureOptions, RINGS, tilesWithin, type CityIndex, type CityTileEntry, type Rings } from '../../shared/city';
import { decodeFarTile, type FarTile } from '../../shared/farTile';
import { fixtureFar, fixtureTile } from '../../shared/fixture';
import { parseLanes, type LaneJunctionData } from '../../shared/lanes';
import { parseProps, parseRoads, type PropsData, type RoadData } from '../../shared/tile';
import { parseScenarios, type ScenarioPoint } from '../../shared/walk';
import { parseLandmarks, type LandmarkEntry } from '../../shared/landmarks';
import { Landmarks } from '../../client/render/Landmarks';
import type { Game, System } from '../../client/Game';
import { freezeStatic } from '../../client/render/freeze';
import type { Look } from '../../client/render/look';
import { ScenarioProps } from '../../client/render/ScenarioProps';
import { SignalHeads } from '../../client/render/SignalHeads';
import type { Minimap } from '../../client/ui/minimap';
import type { StreetName } from '../../client/ui/streetName';
import { createTileView, type WorldView } from '../WorldView';
import { farGeometry, farMaterial } from './farMeshes';
import { fixtureMaterials, fixtureTileGroup, type FixtureMaterials } from './fixtureMeshes';

/** What the city-wide sets need of a tile. */
export interface ClientTileData {
  id: string;
  bounds: CityTileEntry['bounds'];
  roads: RoadData[];
  anchors: PropsData | null;
  scenarios: ScenarioPoint[];
  junctions: LaneJunctionData[];
  /** the tile's landmarks.json (the heroes drawn by `Landmarks`, the names the street label shows) */
  landmarks?: LandmarkEntry[];
}

interface NearTile {
  entry: CityTileEntry;
  state: 'loading' | 'built' | 'failed';
  root: THREE.Object3D | null;
  view: WorldView | null;
  data: ClientTileData | null;
  /** Ready to be added (its meshes and data are in memory). */
  pending: { root: THREE.Object3D; view: WorldView | null; data: ClientTileData } | null;
  gone: boolean;
}

interface FarTileView {
  entry: CityTileEntry;
  geo: THREE.BufferGeometry | null;
  gone: boolean;
}

/** Far tiles are drawn merged, a mesh per block of `FAR_BLOCK` x `FAR_BLOCK` cells (a few draws for the whole far ring). */
const FAR_BLOCK = 4;

export interface StreamHooks {
  look?: Look | null;
  minimap?: Minimap | null;
  streetName?: StreetName | null;
}

export interface WorldStreamStats {
  near: number;
  built: number;
  far: number;
  farBuilt: number;
  adds: number;
  drops: number;
  unionBuilds: number;
  /** Most ms spent in one frame adding a tile or rebuilding a set, and the mean. */
  addMsMax: number;
  addMsMean: number;
  /** The worst ms of each kind of work: adding a tile's meshes, a far block, each city-wide set (props, benches, heads, minimap, names). */
  worst: { tile: number; block: number; sets: number[] };
}

export class WorldStream implements System {
  readonly name = 'worldStream';
  readonly priority = 200;
  readonly root = new THREE.Group();
  private readonly farRoot = new THREE.Group();
  private readonly near = new Map<string, NearTile>();
  private readonly far = new Map<string, FarTileView>();
  private readonly blocks = new Map<string, THREE.Mesh>();
  private readonly dirtyBlocks = new Set<string>();
  private readonly fixtureMats: FixtureMaterials | null;
  private readonly farMat = farMaterial();
  private unionDirty = false;
  private unionStep = 0;
  private props: ScenarioProps | null = null;
  /** the hero models of the loaded tiles (made with the first tile that has any; a hero, once loaded, stays: they are few) */
  private heroes: Landmarks | null = null;
  private readonly landmarkById = new Map<string, LandmarkEntry>();
  private heads: SignalHeads | null = null;
  private lastCheck = -Infinity;
  private readonly counters = { adds: 0, drops: 0, unionBuilds: 0, addMs: [] as number[], tileMs: 0, blockMs: 0, stepMs: [] as number[] };
  private disposed = false;
  /** Overrides the tier's rings (tests, the leak harness). */
  rings: Rings | null = null;

  constructor(
    private readonly game: Game,
    readonly index: CityIndex,
    /** The directory of index.json, or 'fixture'. */
    private readonly base: string,
    private readonly hooks: StreamHooks = {},
  ) {
    this.root.name = base.startsWith('fixture') ? 'world-fixture' : 'world';
    this.fixtureOpts = base.startsWith('fixture') ? fixtureOptions(base) : null;
    this.root.matrixAutoUpdate = false;
    this.farRoot.name = 'world-far';
    this.farRoot.matrixAutoUpdate = false;
    this.fixtureMats = this.fixtureOpts ? fixtureMaterials() : null;
    game.scene.add(this.root, this.farRoot);
  }

  private readonly fixtureOpts: { half: number } | null;

  private get fixture(): boolean {
    return this.fixtureOpts !== null;
  }

  private ringsNow(): Rings {
    return this.rings ?? RINGS[this.game.tier.name];
  }

  /** Centres the rings somewhere else than on the player (aerial shots). */
  centreOverride: { x: number; z: number } | null = null;

  /** Where the rings are centred: what the camera follows (the player). */
  private centre(): { x: number; z: number } {
    if (this.centreOverride) return this.centreOverride;
    const f = this.game.focus;
    return Number.isFinite(f.x) && (f.x !== 0 || f.z !== 0) ? { x: f.x, z: f.z } : { x: this.index.spawn.player.x, z: this.index.spawn.player.z };
  }

  lateUpdate(_dt: number) {
    if (this.disposed) return;
    const rings = this.ringsNow();
    // the camera has to reach the far ring
    const wantFar = Math.max(this.game.tier.far, rings.far + 300);
    if (this.game.camera.far !== wantFar) {
      this.game.camera.far = wantFar;
      this.game.camera.updateProjectionMatrix();
    }
    const now = performance.now();
    if (now - this.lastCheck > 250) {
      this.lastCheck = now;
      this.check(rings);
    }
    // one tile's meshes a frame
    for (const t of this.near.values()) {
      if (!t.pending) continue;
      const t0 = performance.now();
      this.addTile(t);
      const ms = performance.now() - t0;
      this.counters.addMs.push(ms);
      this.counters.tileMs = Math.max(this.counters.tileMs, ms);
      break;
    }
    // then one city-wide set a frame, after a change
    if (this.unionDirty) {
      const t0 = performance.now();
      const step = this.unionStep;
      this.unionDirty = !this.rebuildUnion();
      const ms = performance.now() - t0;
      this.counters.addMs.push(ms);
      this.counters.stepMs[step] = Math.max(this.counters.stepMs[step] ?? 0, ms);
    }
    // and one far block a frame
    const bk = this.dirtyBlocks.values().next();
    if (!bk.done) {
      const t0 = performance.now();
      this.dirtyBlocks.delete(bk.value);
      this.rebuildBlock(bk.value);
      const ms = performance.now() - t0;
      this.counters.addMs.push(ms);
      this.counters.blockMs = Math.max(this.counters.blockMs, ms);
    }
    if (this.counters.addMs.length > 400) this.counters.addMs.splice(0, 200);
    for (const t of this.near.values()) t.view?.update(this.game.camera, this.game.tier.lodScale);
    this.heads?.update();
  }

  private check(rings: Rings) {
    const c = this.centre();
    const want = tilesWithin(this.index, c.x, c.z, rings.near);
    for (const { tile } of want) if (!this.near.has(tile.id)) this.request(tile);
    const keep = new Set(tilesWithin(this.index, c.x, c.z, rings.drop).map((w) => w.tile.id));
    for (const [id, t] of this.near) if (!keep.has(id)) this.dropNear(id, t);
    // far: within the far ring and not near
    const wantFar = tilesWithin(this.index, c.x, c.z, rings.far).filter((w) => !this.near.has(w.tile.id) || this.near.get(w.tile.id)!.state !== 'built');
    const farIds = new Set(wantFar.map((w) => w.tile.id));
    for (const { tile } of wantFar) if (!this.far.has(tile.id) && (tile.far || this.fixture)) this.requestFar(tile);
    for (const [id, f] of this.far) {
      const nearBuilt = this.near.get(id)?.state === 'built';
      if (!farIds.has(id) || nearBuilt) this.dropFar(id, f);
    }
  }

  private request(entry: CityTileEntry) {
    const t: NearTile = { entry, state: 'loading', root: null, view: null, data: null, pending: null, gone: false };
    this.near.set(entry.id, t);
    void this.load(t).catch((e) => {
      t.state = 'failed';
      console.warn('[stream]', entry.id, (e as Error).message);
    });
  }

  private async load(t: NearTile) {
    const e = t.entry;
    if (this.fixture) {
      const ft = fixtureTile(e.i, e.j, this.fixtureOpts!);
      const root = fixtureTileGroup(ft, this.fixtureMats!);
      const ns = `${e.id}/`;
      const data: ClientTileData = {
        id: e.id,
        bounds: e.bounds,
        roads: ft.roads ?? [],
        anchors: ft.anchors ?? null,
        scenarios: ft.scenarios?.points ?? [],
        junctions: (ft.lanes?.junctions ?? []).map((j) => ({ ...j, id: ns + j.id })),
      };
      if (t.gone) return disposeTree(root);
      t.pending = { root, view: null, data };
      return;
    }
    const dir = new URL(e.path, this.base).href;
    const get = (name: string) =>
      fetch(new URL(name, dir).href)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const manifest = await get('tile.json');
    if (!manifest) throw new Error('no tile.json');
    const [view, roads, props, scen, lanes, marks] = await Promise.all([createTileView(manifest, dir, `tile:${e.id}`), get(manifest.roads ?? 'roads.json'), manifest.props ? get(manifest.props) : null, manifest.scenarios ? get(manifest.scenarios) : null, manifest.lanes ? get(manifest.lanes) : null, manifest.landmarks ? get(manifest.landmarks) : null]);
    if (t.gone) {
      view.dispose();
      return;
    }
    const lanesData = lanes ? parseLanes(lanes) : null;
    const data: ClientTileData = {
      id: e.id,
      bounds: e.bounds,
      roads: roads ? parseRoads(roads) : [],
      anchors: props ? parseProps(props) : null,
      scenarios: scen ? (parseScenarios(scen)?.points ?? []) : [],
      junctions: (lanesData?.junctions ?? []).map((j) => ({ ...j, id: `${e.id}/${j.id}` })),
      landmarks: marks ? (parseLandmarks(marks)?.landmarks ?? []) : [],
    };
    view.root.removeFromParent();
    t.pending = { root: view.root, view, data };
  }

  private addTile(t: NearTile) {
    const p = t.pending!;
    t.pending = null;
    t.root = p.root;
    t.view = p.view;
    t.data = p.data;
    t.state = 'built';
    if (!p.view) freezeStatic(p.root);
    this.root.add(p.root);
    this.counters.adds++;
    this.unionDirty = true;
    this.unionStep = 0;
    // its landmarks: the hero models (drawn once per id however many tiles list them) and the names the street label shows
    const marks = p.data.landmarks ?? [];
    if (marks.length && !this.base.startsWith('fixture')) {
      for (const m of marks) if (!this.landmarkById.has(m.id) || m.hero) this.landmarkById.set(m.id, m);
      if (marks.some((m) => m.hero) && this.game.params.get('landmarks') !== 'off') {
        if (!this.heroes) this.heroes = this.game.addSystem(new Landmarks(this.game));
        void this.heroes.load(marks, document.baseURI);
      }
      this.hooks.streetName?.setLandmarks([...this.landmarkById.values()]);
    }
    // its far mesh goes
    const f = this.far.get(t.entry.id);
    if (f) this.dropFar(t.entry.id, f);
  }

  private dropNear(id: string, t: NearTile) {
    t.gone = true;
    this.near.delete(id);
    if (t.view) t.view.dispose();
    else if (t.root) {
      t.root.removeFromParent();
      disposeTree(t.root);
    }
    if (t.state === 'built') {
      this.counters.drops++;
      this.unionDirty = true;
      this.unionStep = 0;
    }
  }

  private blockOf(e: CityTileEntry): string {
    return `${Math.floor(e.i / FAR_BLOCK)},${Math.floor(e.j / FAR_BLOCK)}`;
  }

  /** Merges the far tiles of a block into its one mesh (or drops the mesh when none is left). */
  private rebuildBlock(key: string) {
    const old = this.blocks.get(key);
    if (old) {
      old.removeFromParent();
      old.geometry.dispose();
      this.blocks.delete(key);
    }
    const geos = [...this.far.values()].filter((f) => f.geo && this.blockOf(f.entry) === key).map((f) => f.geo!);
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, this.farMat);
    mesh.name = `far-block:${key}`;
    mesh.matrixAutoUpdate = false;
    this.blocks.set(key, mesh);
    this.farRoot.add(mesh);
  }

  private requestFar(entry: CityTileEntry) {
    const f: FarTileView = { entry, geo: null, gone: false };
    this.far.set(entry.id, f);
    const build = (ft: FarTile) => {
      if (f.gone || this.disposed) return;
      f.geo = farGeometry(ft);
      this.dirtyBlocks.add(this.blockOf(entry));
    };
    if (this.fixture) {
      build(fixtureFar(entry.i, entry.j, this.fixtureOpts!));
      return;
    }
    void fetch(new URL(entry.far!, this.base).href)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => b && build(decodeFarTile(b)))
      .catch(() => {});
  }

  private dropFar(id: string, f: FarTileView) {
    f.gone = true;
    this.far.delete(id);
    if (f.geo) {
      f.geo.dispose();
      f.geo = null;
      this.dirtyBlocks.add(this.blockOf(f.entry));
    }
  }

  /** One step of handing the loaded tiles to the city-wide sets; true when every set is up to date. */
  private rebuildUnion(): boolean {
    const tiles = [...this.near.values()].filter((t) => t.state === 'built' && t.data).map((t) => t.data!);
    tiles.sort((a, b) => (a.id < b.id ? -1 : 1));
    const step = this.unionStep++;
    if (step === 0) {
      const anchors: PropsData = { version: 1, trees: [], lamps: [], hydrants: [], bins: [], bollards: [] };
      for (const t of tiles) {
        if (!t.anchors) continue;
        for (const k of ['trees', 'lamps', 'hydrants', 'bins', 'bollards'] as const) for (const a of t.anchors[k]) (anchors[k] as number[][]).push(a);
      }
      void this.hooks.look?.setCityProps(anchors);
      return false;
    }
    if (step === 1) {
      this.props?.dispose();
      this.props = new ScenarioProps(this.game.scene, tiles.flatMap((t) => t.scenarios));
      return false;
    }
    if (step === 2) {
      this.heads?.dispose();
      this.heads = new SignalHeads(this.game, tiles.flatMap((t) => t.junctions));
      return false;
    }
    if (step === 3) {
      this.hooks.minimap?.setRoadTiles(tiles.map((t) => ({ id: t.id, bounds: t.bounds, roads: t.roads })));
      return false;
    }
    this.hooks.streetName?.setRoads(tiles.flatMap((t) => t.roads), this.index.id);
    this.counters.unionBuilds++;
    return true;
  }

  /** The tile ids drawn in full, sorted. */
  builtIds(): string[] {
    return [...this.near.values()].filter((t) => t.state === 'built').map((t) => t.entry.id).sort();
  }

  stats(): WorldStreamStats {
    const ms = this.counters.addMs;
    return {
      near: this.near.size,
      built: this.builtIds().length,
      far: this.far.size,
      farBuilt: [...this.far.values()].filter((f) => f.geo).length,
      adds: this.counters.adds,
      drops: this.counters.drops,
      unionBuilds: this.counters.unionBuilds,
      addMsMax: ms.length ? Math.max(...ms) : 0,
      addMsMean: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0,
      worst: { tile: this.counters.tileMs, block: this.counters.blockMs, sets: [...this.counters.stepMs] },
    };
  }

  /** Whether nothing is loading, waiting to be added or waiting for a set to be rebuilt. */
  get settled(): boolean {
    for (const t of this.near.values()) if (t.state === 'loading' || t.pending) return false;
    return !this.unionDirty && this.dirtyBlocks.size === 0;
  }

  dispose() {
    this.disposed = true;
    for (const [id, t] of [...this.near]) this.dropNear(id, t);
    for (const [id, f] of [...this.far]) this.dropFar(id, f);
    for (const m of this.blocks.values()) m.geometry.dispose();
    this.blocks.clear();
    this.dirtyBlocks.clear();
    this.props?.dispose();
    this.heads?.dispose();
    this.heroes?.dispose();
    this.heroes = null;
    this.root.removeFromParent();
    this.farRoot.removeFromParent();
    this.farMat.dispose();
    if (this.fixtureMats) for (const m of Object.values(this.fixtureMats)) m.dispose();
  }
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
  });
}
