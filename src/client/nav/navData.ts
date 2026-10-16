/**
 * Keeps the GPS's graphs in step with the loaded tiles: for each tile in the wanted set it fetches `lanes.json`, `paths.json` and
 * `roads.json`, packs them into the compact tile forms, and re-joins the loaded tiles into one drive net and one walk net (a short
 * pause after the last change, so a burst of tiles is one rebuild). Tiles that leave the set are dropped. Nothing is fetched until
 * `setLoaded` is first called, which the Navigator does only once there is a waypoint or the map is open.
 */
import type { NavCore } from './core';
import { buildDriveTile, DriveNet, type DriveTile } from './driveNet';
import type { NavSource } from './source';
import { buildWalkTile, WalkNet, type WalkTile } from './walkNet';

export class NavData {
  private readonly drive = new Map<string, DriveTile>();
  private readonly walk = new Map<string, WalkTile>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private want: string[] = [];
  private wantKey = '';
  private builtKey = '\0';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private assembling = false;
  /** Milliseconds the last assembly took, and the worst. */
  assembleMs = { last: 0, worst: 0 };
  assemblies = 0;
  /** Resolves of waiters for "everything wanted is in and joined". */
  private waiters: (() => void)[] = [];

  constructor(
    private readonly source: NavSource,
    private readonly core: NavCore,
    /** Wait this long after the last tile came in before joining them (ms). */
    private readonly settleMs = 60,
  ) {}

  /** The tiles the graphs should cover (the loaded ones). */
  setLoaded(ids: readonly string[]) {
    const key = [...ids].sort().join('|');
    if (key === this.wantKey) return;
    this.wantKey = key;
    this.want = [...ids].sort();
    const keep = new Set(ids);
    for (const id of [...this.drive.keys()]) {
      if (keep.has(id)) continue;
      this.drive.delete(id);
      this.core.roads.dropTile(id, 'nav');
    }
    for (const id of [...this.walk.keys()]) if (!keep.has(id)) this.walk.delete(id);
    for (const id of ids) if (!this.drive.has(id) && !this.loading.has(id) && !this.failed.has(id)) void this.load(id);
    this.schedule();
  }

  private async load(id: string) {
    this.loading.add(id);
    try {
      const [roads, lanes, paths] = await Promise.all([this.source.roads(id), this.source.lanes(id), this.source.paths(id)]);
      if (this.disposed) return;
      this.core.roads.setTile(id, roads, 'nav');
      const bounds = this.source.tiles.find((t) => t.id === id)!.bounds;
      // (a tile that left the wanted set while it loaded is not kept)
      if (this.want.includes(id)) {
        // (the two tile forms are made a turn of the event loop apart, so a frame can run between them)
        const drive = lanes ? buildDriveTile(id, bounds, lanes, roads) : emptyDrive(id, bounds);
        await yieldTurn();
        const walk = paths ? buildWalkTile(id, bounds, paths) : emptyWalk(id, bounds);
        if (this.want.includes(id)) {
          this.drive.set(id, drive);
          this.walk.set(id, walk);
        }
      }
    } catch (e) {
      this.failed.add(id);
      console.warn('[nav]', id, (e as Error).message);
    } finally {
      this.loading.delete(id);
      this.schedule();
    }
  }

  private schedule() {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.assemble();
    }, this.settleMs);
  }

  private async assemble() {
    if (this.disposed || this.assembling) return;
    this.assembling = true;
    const ids = this.want.filter((id) => this.drive.has(id));
    const key = ids.join('|');
    if (key !== this.builtKey) {
      this.builtKey = key;
      const t0 = performance.now();
      const drive = DriveNet.assemble(ids.map((id) => this.drive.get(id)!));
      const m1 = performance.now() - t0;
      // (the walk net a turn later: each is a few ms, and the two together would be a visible hitch on a phone)
      await yieldTurn();
      const t1 = performance.now();
      const walk = WalkNet.assemble(ids.filter((id) => this.walk.has(id)).map((id) => this.walk.get(id)!));
      const ms = m1 + (performance.now() - t1);
      if (!this.disposed && this.builtKey === key) this.core.setNets(drive, walk);
      this.assemblies++;
      this.assembleMs = { last: ms, worst: Math.max(this.assembleMs.worst, ms) };
    }
    this.assembling = false;
    // (tiles that came while this ran)
    if (this.builtKey !== this.want.filter((id) => this.drive.has(id)).join('|')) return this.schedule();
    if (this.loading.size === 0 && ids.length === this.want.filter((id) => !this.failed.has(id)).length) {
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }

  /** Resolves once every wanted tile is loaded and joined (tests, the screenshot scripts). */
  settled(): Promise<void> {
    if (this.timer === null && !this.assembling && this.loading.size === 0 && this.builtKey === this.want.filter((id) => this.drive.has(id)).join('|')) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  get loadedIds(): string[] {
    return [...this.drive.keys()].sort();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function emptyDrive(id: string, bounds: DriveTile['bounds']): DriveTile {
  return buildDriveTile(id, bounds, { format: 'hood-lanes', version: 1, edges: [], junctions: [] });
}

function emptyWalk(id: string, bounds: WalkTile['bounds']): WalkTile {
  return buildWalkTile(id, bounds, { version: 1, nodes: [], attrs: [], edges: [] });
}

const yieldTurn = () => new Promise<void>((res) => setTimeout(res, 0));
