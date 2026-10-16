/**
 * Where a streamed city's tiles come from: `index.json` and the tiles' files over HTTP (Workers static assets now, R2 later), or the
 * procedural fixture (`?tiles=fixture`, the tests), which needs no files and answers at once.
 */
import { parseCityIndex, type CityIndex, type CityTileEntry } from '../../shared/city';
import { fixtureIndex, fixtureTile, type FixtureOptions } from '../../shared/fixture';
import { parseSeams, type SeamsData } from '../../shared/seams';
import { loadBakedTile, type TileData } from '../../shared/tile';

/** A tile as the streamer gets it: the M1 data, and its seam ports when the bake wrote them. */
export interface StreamTile {
  entry: CityTileEntry;
  tile: TileData;
  seams?: SeamsData;
}

export interface TileSource {
  readonly index: CityIndex;
  /** The tile's data: at once (the fixture) or later (a fetch). A failed load rejects. */
  load(entry: CityTileEntry): StreamTile | Promise<StreamTile>;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** The tiles of a baked city, under the directory of its `index.json`. */
export class HttpTileSource implements TileSource {
  private constructor(
    readonly index: CityIndex,
    private readonly base: string,
    private readonly fetchFn: Fetch,
  ) {}

  /** Reads `<url>` (an index.json, or a directory that holds one). */
  static async open(url: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<HttpTileSource> {
    const file = url.endsWith('.json') ? url : `${url.endsWith('/') ? url : `${url}/`}index.json`;
    const res = await fetchFn(file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    let index: CityIndex;
    try {
      index = parseCityIndex(await res.json());
    } catch (e) {
      throw new Error(`no usable city index at ${file} (${(e as Error).message})`);
    }
    return new HttpTileSource(index, file.slice(0, file.lastIndexOf('/') + 1), fetchFn);
  }

  async load(entry: CityTileEntry): Promise<StreamTile> {
    const url = this.base + entry.path;
    const [tile, seams] = await Promise.all([
      loadBakedTile(url, this.fetchFn),
      this.fetchFn(url + 'seams.json')
        .then(async (r) => (r.ok ? parseSeams(await r.json()) : null))
        .catch(() => null),
    ]);
    return { entry, tile, seams: seams ?? undefined };
  }
}

/** The procedural test city (`src/shared/fixture.ts`): every tile at once. */
export class FixtureTileSource implements TileSource {
  readonly index: CityIndex;
  /** How many times each tile was made (tests: a dropped tile made again). */
  readonly loads = new Map<string, number>();

  constructor(private readonly opts: FixtureOptions = {}) {
    this.index = fixtureIndex(opts);
  }

  load(entry: CityTileEntry): StreamTile {
    this.loads.set(entry.id, (this.loads.get(entry.id) ?? 0) + 1);
    return { entry, tile: fixtureTile(entry.i, entry.j, this.opts) };
  }
}
