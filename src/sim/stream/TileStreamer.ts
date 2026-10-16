/**
 * Loads and drops a streamed city's tiles round the player, in the sim worker (docs/contracts/city-tiles.md sections 4, 5, 8, 9).
 *
 * Every few ticks it compares the tiles within the near ring of the player with what it has: tiles that come into the ring are
 * fetched (the source may answer at once), and an arrived tile is integrated by jobs (its physics a piece at a time, then its lane
 * graph, walk network and the systems' indices, then the seams to its loaded neighbours, then the main component of the lane
 * graph, resumable) that run at most `budget` work units a tick, after the systems. A tile beyond the drop ring is dropped in one
 * job: whatever is on it (or routed through it) is despawned, its graphs and seams are undone, and its colliders removed.
 *
 * The work units are counted, not timed, so a given sequence of player positions and arrivals gives the same ticks everywhere: with
 * a source that answers at once (the fixture), the whole streaming is deterministic.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { RINGS, tilesWithin, type CityIndex, type CityTileEntry, type Rect, type Rings } from '../../shared/city';
import { matchLanePorts, matchWalkPorts, OPPOSITE, seamPorts, SIDES, type SeamsData } from '../../shared/seams';
import type { JunctionsData, RoadData, TileData, TileManifest } from '../../shared/tile';
import type { PathsData } from '../../shared/walk';
import { LaneGraph, type LaneTileRange } from '../traffic/LaneGraph';
import { WalkGraph, type WalkTileRange } from '../peds/graph';
import { PhysicsWorld } from '../World';
import { FootprintSet } from './FootprintSet';
import { StreamPhysics, type StreamJob } from './StreamPhysics';
import type { StreamTile, TileSource } from './TileSource';

export type TileState = 'loading' | 'queued' | 'ready' | 'dropping' | 'failed';

export interface ResidentTile {
  entry: CityTileEntry;
  state: TileState;
  /** Junction ids of the tile are `<ns>/<id>`. */
  ns: string;
  data?: StreamTile;
  ports?: SeamsData;
  lanes?: LaneTileRange;
  walk?: WalkTileRange;
  /** The graphs are in (and its seams can be stitched). */
  graphs: boolean;
  requestedTick: number;
  readyTick: number;
  /** Ticks its integration took (first job to ready). */
  buildTicks: number;
  firstJobTick: number;
  /** Set when the tile left the ring before it was ready: it is dropped as soon as it is. */
  dropWhenReady: boolean;
  error?: string;
}

/** What a system does when a tile comes and goes (the traffic, the pedestrians, the police). */
export interface StreamListener {
  /** The tile's graphs are in: index it (return jobs to spread the work). */
  tileAdded?(key: string, r: ResidentTile, tile: TileData): StreamJob[] | void;
  /** Before the tile's graphs and colliders go: remove what is on it. */
  tileDropping?(key: string, rect: Rect): void;
  /** After its graphs went: forget it. */
  tileRemoved?(key: string): void;
}

export interface StreamOptions {
  rings?: Rings;
  /** Work units a tick (about a microsecond each on the dev box): default 1500. */
  budget?: number;
  /** Ticks between ring checks (default 15: four times a second). */
  checkEvery?: number;
  /** Namespace junction ids by tile (default true; a city of one tile keeps them as they are). */
  namespace?: boolean;
}

export interface StreamStats {
  resident: number;
  ready: number;
  loading: number;
  queuedJobs: number;
  loads: number;
  drops: number;
  failed: number;
  /** Seam ports joined and left alone. */
  seams: { lanes: number; walk: number; unmatched: number };
  /** The largest number of work units run in one tick, and the ticks that ran any. */
  maxUnitsPerTick: number;
  busyTicks: number;
  colliders: number;
  carGroundBuilds: number;
}

const DEFAULT_BUDGET = 1500;

export class TileStreamer {
  readonly pw: PhysicsWorld;
  readonly physics: StreamPhysics;
  readonly lanes = LaneGraph.streaming();
  readonly walk = WalkGraph.streaming();
  readonly tiles = new Map<string, ResidentTile>();
  /** The composite tile the sim sees as `sim.tile`: the city's manifest and the union of the loaded tiles' roads. */
  readonly composite: TileData;
  readonly rings: Rings;
  readonly budget: number;
  private readonly checkEvery: number;
  private readonly namespace: boolean;
  private readonly queue: StreamJob[] = [];
  private readonly arrived: StreamTile[] = [];
  private readonly listeners: StreamListener[] = [];
  private mainRunning = false;
  private tick = 0;
  private lastCheck = -Infinity;
  /** Events for the sim to emit (stream:tile). */
  readonly events: { id: string; state: 'ready' | 'dropped' | 'failed'; tick: number }[] = [];
  readonly counters = { loads: 0, drops: 0, failed: 0, seamLanes: 0, seamWalk: 0, unmatched: 0, maxUnitsPerTick: 0, busyTicks: 0 };
  /** Keep each tile's parsed files after it is in (for systems that attach later, and tests); `releaseData` stops it. */
  private retain = true;
  /** The player's last position the streamer saw. */
  readonly at = { x: 0, z: 0 };

  constructor(
    R: typeof RAPIER,
    readonly source: TileSource,
    opts: StreamOptions = {},
  ) {
    const index = source.index;
    this.rings = opts.rings ?? RINGS.high;
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.checkEvery = opts.checkEvery ?? 15;
    this.namespace = opts.namespace ?? index.tiles.length > 1;
    this.composite = compositeTile(index);
    this.pw = new PhysicsWorld(R, this.composite, { stream: true, footprints: new FootprintSet() });
    this.physics = new StreamPhysics(this.pw, index.tileSize);
  }

  get index(): CityIndex {
    return this.source.index;
  }

  /** Adds a system's hooks, and replays the tiles already in for it. */
  listen(l: StreamListener) {
    this.listeners.push(l);
    for (const [key, r] of this.tiles) {
      if (!r.graphs || !r.data) continue;
      const jobs = l.tileAdded?.(key, r, r.data.tile);
      if (jobs) for (const j of jobs) while (!j.run(Infinity));
    }
  }

  /**
   * From now on, a tile's parsed lanes, walk network, junctions, anchors, scenarios and collision mesh are let go once it is in
   * (the graphs, colliders and indices hold their own copies; the heightmap and the roads stay): about two thirds of a tile's heap.
   * The sim calls it once its systems are listening (a listener added later would see the tiles without them).
   */
  releaseData() {
    this.retain = false;
    for (const r of this.tiles.values()) if (r.state === 'ready') release(r);
  }

  /** Whether the ground under (x, z) is solid (its tile is in). */
  solidAt(x: number, z: number): boolean {
    return this.physics.solidAt(x, z);
  }

  /** Loads everything within the near ring of (x, z) and builds it at once (boot: before anything stands on it). */
  async preload(x: number, z: number): Promise<void> {
    this.at.x = x;
    this.at.z = z;
    this.check(x, z, true);
    await Promise.all([...this.pending]);
    this.takeArrived();
    this.drain();
    this.physics.buildCarGround(x, z);
  }

  /** Runs every queued job now (tests, boot). */
  drain() {
    for (let guard = 0; guard < 1e6 && this.queue.length; guard++) {
      const j = this.queue[0];
      if (j.run(Infinity)) this.queue.shift();
    }
  }

  private readonly pending = new Set<Promise<void>>();

  /** The ring check: requests what came into the near ring, drops what left the drop ring. */
  private check(x: number, z: number, now = false) {
    const want = tilesWithin(this.index, x, z, this.rings.near);
    for (const { tile: entry } of want) {
      const r = this.tiles.get(entry.id);
      if (r) {
        r.dropWhenReady = false;
        continue;
      }
      this.request(entry, now);
    }
    const keep = new Set(tilesWithin(this.index, x, z, this.rings.drop).map((w) => w.tile.id));
    for (const [id, r] of this.tiles) {
      if (keep.has(id)) continue;
      if (r.state === 'ready') this.enqueueDrop(id);
      else if (r.state === 'loading' || r.state === 'queued') r.dropWhenReady = true;
      else if (r.state === 'failed') this.tiles.delete(id);
    }
  }

  private request(entry: CityTileEntry, _now: boolean) {
    const r: ResidentTile = { entry, state: 'loading', ns: this.namespace ? entry.id : '', graphs: false, requestedTick: this.tick, readyTick: -1, buildTicks: 0, firstJobTick: -1, dropWhenReady: false };
    this.tiles.set(entry.id, r);
    this.counters.loads++;
    let got: StreamTile | Promise<StreamTile>;
    try {
      got = this.source.load(entry);
    } catch (e) {
      this.fail(r, e);
      return;
    }
    if (got instanceof Promise) {
      const p = got.then(
        (st) => {
          this.arrived.push(st);
        },
        (e) => this.fail(r, e),
      );
      const tracked = p.finally(() => this.pending.delete(tracked));
      this.pending.add(tracked);
    } else this.arrived.push(got);
  }

  private fail(r: ResidentTile, e: unknown) {
    r.state = 'failed';
    r.error = e instanceof Error ? e.message : String(e);
    this.counters.failed++;
    this.events.push({ id: r.entry.id, state: 'failed', tick: this.tick });
  }

  /** Arrived tiles join the job queue in the order they were asked for. */
  private takeArrived() {
    if (!this.arrived.length) return;
    const order = [...this.tiles.keys()];
    this.arrived.sort((a, b) => order.indexOf(a.entry.id) - order.indexOf(b.entry.id));
    for (const st of this.arrived.splice(0)) {
      const r = this.tiles.get(st.entry.id);
      if (!r || r.state !== 'loading') continue;
      r.data = st;
      r.state = 'queued';
      this.enqueueAdd(r);
    }
  }

  private enqueueAdd(r: ResidentTile) {
    const key = r.entry.id;
    const st = r.data!;
    const tile = st.tile;
    const mark = (j: StreamJob): StreamJob => ({
      name: j.name,
      cost: j.cost,
      run: (b) => {
        if (r.firstJobTick < 0) r.firstJobTick = this.tick;
        return j.run(b);
      },
    });
    for (const j of this.physics.plan(key, tile)) this.queue.push(mark(j));
    // the graphs, one job each (the lane graph is the biggest: about 2.5 us a lane)
    this.queue.push({
      name: `${key}:lanes`,
      cost: (tile.lanes?.edges.length ?? 0) * 5 + 20,
      run: () => {
        if (tile.lanes) r.lanes = this.lanes.addTile(key, tile.lanes, r.ns);
        return true;
      },
    });
    this.queue.push({
      name: `${key}:walk`,
      cost: (tile.paths?.edges.length ?? 0) * 0.8 + (tile.paths?.nodes.length ?? 0) * 0.5 + 20,
      run: () => {
        if (tile.paths) r.walk = this.walk.addTile(key, r.ns ? namespacePaths(tile.paths, r.ns) : tile.paths);
        return true;
      },
    });
    this.queue.push({
      name: `${key}:graphs`,
      cost: (tile.roads?.length ?? 0) * 2 + (tile.scenarios?.points.length ?? 0) * 0.5 + 50,
      run: () => {
        r.ports = st.seams ?? seamPorts(key, r.entry.bounds, tile);
        r.graphs = true;
        this.updateComposite();
        // the systems' own indices of the tile
        const more: StreamJob[] = [];
        for (const l of this.listeners) {
          const jobs = l.tileAdded?.(key, r, tile);
          if (jobs) more.push(...jobs);
        }
        // (they run next, before the seams)
        this.queue.splice(1, 0, ...more);
        return true;
      },
    });
    this.queue.push({
      name: `${key}:seams`,
      cost: 40,
      run: () => {
        this.stitchTile(r);
        // the main component over what is in now (after the jobs already queued: they are this tile's and the next ones')
        this.enqueueMain(true);
        return true;
      },
    });
    this.queue.push({
      name: `${key}:ready`,
      cost: 1,
      run: () => {
        r.state = 'ready';
        r.readyTick = this.tick;
        r.buildTicks = this.tick - Math.max(0, r.firstJobTick) + 1;
        if (!this.retain) release(r);
        this.events.push({ id: key, state: 'ready', tick: this.tick });
        if (r.dropWhenReady) this.enqueueDrop(key);
        return true;
      },
    });
  }

  /** The main component of the lane graph, recomputed over everything loaded (one job, resumable; at most one queued). */
  private enqueueMain(next = false) {
    // a job already waiting, or running, sees the change (it restarts on a change of topology)
    if (this.mainRunning) return;
    this.mainRunning = true;
    let job: { step(budget: number): boolean } | null = null;
    const at = next ? 1 : this.queue.length;
    this.queue.splice(at, 0, {
      name: 'lanes:main',
      cost: Math.max(50, this.lanes.count * 0.15),
      run: (budget) => {
        job ??= this.lanes.mainJob();
        // a budget in units: about 7 edge visits a unit
        const done = job.step(Number.isFinite(budget) ? Math.max(500, budget * 7) : Infinity);
        if (done) this.mainRunning = false;
        return done;
      },
    });
  }

  /** Joins the tile's seam ports to every neighbour whose graphs are in. */
  private stitchTile(r: ResidentTile) {
    for (const side of SIDES) {
      const nid = r.entry.neighbours?.[side];
      if (!nid) continue;
      const n = this.tiles.get(nid);
      if (!n || !n.graphs || !n.ports) continue;
      const a = r.ports?.sides[side];
      const b = n.ports.sides[OPPOSITE[side]];
      if (!a || !b) continue;
      if (r.lanes && n.lanes) {
        const ra = r.lanes, rb = n.lanes;
        const tag = (p: (typeof a.lanes)[number], base: number) => ({ ...p, edge: p.edge + base });
        const m = matchLanePorts(
          a.lanes.map((p) => tag(p, ra.base)),
          b.lanes.map((p) => tag(p, rb.base)),
        );
        for (const pr of m.pairs) this.lanes.stitch(pr.out.edge, pr.into.edge);
        this.counters.seamLanes += m.pairs.length;
        this.counters.unmatched += m.unmatched.length;
      }
      if (r.walk && n.walk) {
        const wa = r.walk, wb = n.walk;
        const m = matchWalkPorts(
          a.walk.map((p) => ({ ...p, node: p.node + wa.nodeBase })),
          b.walk.map((p) => ({ ...p, node: p.node + wb.nodeBase })),
        );
        for (const [p, q] of m.pairs) this.walk.stitch(p.node, q.node);
        this.counters.seamWalk += m.pairs.length;
        this.counters.unmatched += m.unmatched.length;
      }
    }
  }

  private enqueueDrop(key: string) {
    const r = this.tiles.get(key);
    if (!r || r.state === 'dropping') return;
    r.state = 'dropping';
    this.queue.push({
      name: `${key}:drop`,
      cost: 200,
      run: () => {
        const rect = r.entry.bounds;
        for (const l of this.listeners) l.tileDropping?.(key, rect);
        this.lanes.removeTile(key);
        this.walk.removeTile(key);
        for (const l of this.listeners) l.tileRemoved?.(key);
        this.physics.remove(key);
        this.tiles.delete(key);
        this.updateComposite();
        this.counters.drops++;
        this.events.push({ id: key, state: 'dropped', tick: this.tick });
        this.enqueueMain(true);
        return true;
      },
    });
  }

  /** One tick: the ring check (every `checkEvery` ticks), the arrivals, the car-ground window, then jobs up to the budget. */
  update(tick: number, x: number, z: number) {
    this.tick = tick;
    this.at.x = x;
    this.at.z = z;
    if (tick - this.lastCheck >= this.checkEvery) {
      this.lastCheck = tick;
      this.check(x, z);
    }
    this.takeArrived();
    if (this.physics.carGroundStale(x, z) && !this.queue.some((j) => j.name === 'car-ground')) this.queue.push(this.physics.carGroundJob(x, z));
    let used = 0;
    while (this.queue.length) {
      const j = this.queue[0];
      const left = this.budget - used;
      // a job bigger than what is left waits for the next tick, unless nothing has run this tick (then it runs alone)
      if (j.cost > left && used > 0) break;
      const done = j.run(Math.max(left, 1));
      used += done ? j.cost : left;
      if (done) this.queue.shift();
      if (!done || used >= this.budget) break;
    }
    if (used > 0) {
      this.counters.busyTicks++;
      if (used > this.counters.maxUnitsPerTick) this.counters.maxUnitsPerTick = used;
    }
  }

  /** The ring check now (a teleport: the respawn). */
  checkNow(x: number, z: number) {
    this.lastCheck = this.tick;
    this.check(x, z);
  }

  /** Whether nothing is loading or queued. */
  get settled(): boolean {
    return this.queue.length === 0 && this.pending.size === 0 && this.arrived.length === 0;
  }

  /** Waits for the fetches in flight (tests with a slow source). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  stats(): StreamStats {
    let ready = 0, loading = 0;
    for (const r of this.tiles.values()) {
      if (r.state === 'ready') ready++;
      else if (r.state === 'loading' || r.state === 'queued') loading++;
    }
    return {
      resident: this.tiles.size,
      ready,
      loading,
      queuedJobs: this.queue.length,
      loads: this.counters.loads,
      drops: this.counters.drops,
      failed: this.counters.failed,
      seams: { lanes: this.counters.seamLanes, walk: this.counters.seamWalk, unmatched: this.counters.unmatched },
      maxUnitsPerTick: this.counters.maxUnitsPerTick,
      busyTicks: this.counters.busyTicks,
      colliders: this.physics.stats.colliders,
      carGroundBuilds: this.physics.stats.carGroundBuilds,
    };
  }

  /** The ids of the ready tiles, sorted. */
  readyIds(): string[] {
    return [...this.tiles.values()].filter((r) => r.state === 'ready').map((r) => r.entry.id).sort();
  }

  /** The loaded tile whose cell holds (x, z). */
  tileAt(x: number, z: number): ResidentTile | null {
    for (const r of this.tiles.values()) {
      const b = r.entry.bounds;
      if (r.graphs && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return r;
    }
    return null;
  }

  /** Keeps `composite.roads` the union of the loaded tiles' roads, in load order. */
  private updateComposite() {
    const roads: RoadData[] = [];
    for (const r of this.tiles.values()) if (r.graphs && r.data?.tile.roads) for (const rd of r.data.tile.roads) roads.push(rd);
    this.composite.roads = roads;
  }
}

/** Lets go of what a tile's graphs, colliders and indices copied (see `releaseData`). */
function release(r: ResidentTile) {
  const t = r.data?.tile;
  if (!t) return;
  t.lanes = undefined;
  t.paths = undefined;
  t.junctions = undefined;
  t.anchors = undefined;
  t.scenarios = undefined;
  t.collisionPositions = new Float32Array(0);
  t.collisionIndices = new Uint32Array(0);
}

/** The tile the sim sees as `sim.tile` in a streamed city: the index's frame, extent and spawn, and nothing of its own. */
function compositeTile(index: CityIndex): TileData {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const t of index.tiles) {
    minX = Math.min(minX, t.bounds.minX);
    minZ = Math.min(minZ, t.bounds.minZ);
    maxX = Math.max(maxX, t.bounds.maxX);
    maxZ = Math.max(maxZ, t.bounds.maxZ);
  }
  const manifest: TileManifest = {
    format: 'hood-tile',
    version: 1,
    id: index.id,
    origin: index.origin,
    baseElevation: index.baseElevation,
    bounds: { minX, minZ, maxX, maxZ },
    heightmap: { file: '', cols: 2, rows: 2, cellSize: 1, minX, minZ },
    meshes: {},
    collision: { file: '', vertexCount: 0, indexCount: 0 },
    spawns: { player: index.spawn.player, vehicle: index.spawn.vehicle },
    attribution: index.attribution,
    // (a baked city's tiles carry the attributes of meshFormat 2: the look reads it from here)
    ...(index.city !== 'fixture' ? { meshFormat: 2 } : {}),
  };
  return { manifest, heights: new Float32Array(4), collisionPositions: new Float32Array(0), collisionIndices: new Uint32Array(0), roads: [], source: 'baked' };
}

/** The walk network with its crossings' junction ids in the tile's namespace (as the lane graph's and the signals'). */
export function namespacePaths(p: PathsData, ns: string): PathsData {
  return {
    ...p,
    attrs: p.attrs.map((a) => (a.crossing?.junction ? { ...a, crossing: { ...a.crossing, junction: `${ns}/${a.crossing.junction}` } } : a)),
  };
}

/** `junctions.json` with its ids in the tile's namespace. */
export function namespaceJunctions(j: JunctionsData | undefined, ns: string): JunctionsData | undefined {
  if (!j || !ns) return j;
  return {
    ...j,
    junctions: j.junctions.map((x) => ({ ...x, id: `${ns}/${x.id}` })),
    signals: j.signals.map((s) => ({ ...s, junction: s.junction ? `${ns}/${s.junction}` : null })),
    stops: j.stops.map((s) => ({ ...s, junction: s.junction ? `${ns}/${s.junction}` : null })),
  };
}
