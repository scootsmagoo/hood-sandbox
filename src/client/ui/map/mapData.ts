/**
 * What the full-screen map draws, kept per tile: the roads grouped for fast stroking (a `Path2D` for each class and width), a label
 * place for every named road, the building footprints (the roof triangles of `collision.bin`, one path), and the landmarks. Tiles are
 * fetched when they come into view (nearest the centre first, two at a time), the roads feed the nearest-road index the waypoint
 * snaps with, and the least recently seen are dropped beyond a cap so a long journey over a big city does not grow without limit.
 */
import type { Rect } from '../../../shared/city';
import type { LandmarkEntry } from '../../../shared/landmarks';
import type { NavSource } from '../../nav/source';
import type { RoadIndex } from '../../nav/roadIndex';
import { groupRoads, roadLabels, type RoadLabel } from './mapRoads';

export interface GfxGroup {
  rank: number;
  width: number;
  path: Path2D;
}

export interface MapTileGfx {
  id: string;
  bounds: Rect;
  state: 'loading' | 'ready' | 'failed';
  groups: GfxGroup[];
  labels: RoadLabel[];
  landmarks: LandmarkEntry[];
  buildings: Path2D | null;
  buildingsState: 'none' | 'loading' | 'ready' | 'missing';
  seen: number;
}

/** Tiles kept at once, and tiles whose footprints are kept (they are the heavy part). */
const MAX_TILES = 36;
const MAX_BUILDINGS = 14;
const CONCURRENT = 2;

const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

export class MapData {
  readonly tiles = new Map<string, MapTileGfx>();
  private active = 0;
  private queue: { id: string; kind: 'roads' | 'buildings' }[] = [];
  private landmarkList: LandmarkEntry[] = [];
  private landmarkRev = -1;
  rev = 0;
  private disposed = false;

  constructor(
    private readonly source: NavSource,
    private readonly roadIndex: RoadIndex,
    private readonly onChange: () => void,
  ) {}

  /** Asks for the tiles that touch `view` (nearest the middle first); footprints too when `buildings` is set. */
  request(view: Rect, buildings: boolean, now: number) {
    const cx = (view.minX + view.maxX) / 2;
    const cz = (view.minZ + view.maxZ) / 2;
    const hit = this.source.tiles
      .filter((t) => overlaps(t.bounds, view))
      .map((t) => ({ t, d: Math.hypot((t.bounds.minX + t.bounds.maxX) / 2 - cx, (t.bounds.minZ + t.bounds.maxZ) / 2 - cz) }))
      .sort((a, b) => a.d - b.d);
    let want = 0;
    for (const { t } of hit) {
      let g = this.tiles.get(t.id);
      if (!g) {
        g = { id: t.id, bounds: t.bounds, state: 'loading', groups: [], labels: [], landmarks: [], buildings: null, buildingsState: 'none', seen: now };
        this.tiles.set(t.id, g);
        this.queue.push({ id: t.id, kind: 'roads' });
      }
      g.seen = now;
      if (buildings && g.buildingsState === 'none' && want < MAX_BUILDINGS) {
        g.buildingsState = 'loading';
        this.queue.push({ id: t.id, kind: 'buildings' });
      }
      want++;
    }
    this.pump();
    this.evict(now);
  }

  /** The tiles with data, that touch `view`. */
  visible(view: Rect, out: MapTileGfx[]): MapTileGfx[] {
    out.length = 0;
    for (const g of this.tiles.values()) if (g.state === 'ready' && overlaps(g.bounds, view)) out.push(g);
    return out;
  }

  /** Every landmark of the loaded tiles (the same array until a tile comes or goes). */
  get landmarks(): LandmarkEntry[] {
    if (this.landmarkRev !== this.rev) {
      this.landmarkRev = this.rev;
      const seen = new Set<string>();
      this.landmarkList = [];
      for (const g of this.tiles.values()) {
        for (const l of g.landmarks) {
          // (a hero that spans a seam is listed by every tile it touches)
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          this.landmarkList.push(l);
        }
      }
    }
    return this.landmarkList;
  }

  private pump() {
    while (this.active < CONCURRENT && this.queue.length && !this.disposed) {
      const job = this.queue.shift()!;
      const g = this.tiles.get(job.id);
      if (!g) continue;
      this.active++;
      const run = job.kind === 'roads' ? this.loadRoads(g) : this.loadBuildings(g);
      void run.finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async loadRoads(g: MapTileGfx) {
    try {
      const [roads, landmarks] = await Promise.all([this.source.roads(g.id), this.source.landmarks(g.id).catch(() => [])]);
      if (this.disposed || this.tiles.get(g.id) !== g) return;
      this.roadIndex.setTile(g.id, roads, 'map');
      g.groups = groupRoads(roads).map((grp) => {
        const path = new Path2D();
        for (const l of grp.lines) {
          path.moveTo(l[0], l[1]);
          for (let i = 2; i < l.length; i += 2) path.lineTo(l[i], l[i + 1]);
        }
        return { rank: grp.rank, width: grp.width, path };
      });
      g.labels = roadLabels(roads);
      g.landmarks = landmarks;
      g.state = 'ready';
      this.rev++;
      this.onChange();
    } catch {
      g.state = 'failed';
    }
  }

  private async loadBuildings(g: MapTileGfx) {
    try {
      const tris = await this.source.buildings(g.id);
      if (this.disposed || this.tiles.get(g.id) !== g) return;
      if (!tris || tris.length === 0) {
        g.buildingsState = 'missing';
        return;
      }
      const path = new Path2D();
      for (let i = 0; i + 5 < tris.length; i += 6) {
        path.moveTo(tris[i], tris[i + 1]);
        path.lineTo(tris[i + 2], tris[i + 3]);
        path.lineTo(tris[i + 4], tris[i + 5]);
        path.closePath();
      }
      g.buildings = path;
      g.buildingsState = 'ready';
      this.onChange();
    } catch {
      g.buildingsState = 'missing';
    }
  }

  private evict(now: number) {
    if (this.tiles.size > MAX_TILES) {
      const old = [...this.tiles.values()].filter((g) => g.state !== 'loading' && g.seen < now).sort((a, b) => a.seen - b.seen);
      for (const g of old.slice(0, this.tiles.size - MAX_TILES)) {
        this.tiles.delete(g.id);
        this.roadIndex.dropTile(g.id, 'map');
        this.rev++;
      }
    }
    let withB = [...this.tiles.values()].filter((g) => g.buildings).length;
    if (withB > MAX_BUILDINGS) {
      for (const g of [...this.tiles.values()].filter((x) => x.buildings && x.seen < now).sort((a, b) => a.seen - b.seen)) {
        if (withB <= MAX_BUILDINGS) break;
        g.buildings = null;
        g.buildingsState = 'none';
        withB--;
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.tiles.clear();
  }
}
