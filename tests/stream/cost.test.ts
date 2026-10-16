/**
 * What streaming costs in the sim (docs/perf.md, "Streaming"). Not part of `npm test` (timings): `STREAM_COST=1 npx vitest run
 * tests/stream/cost.test.ts`. For each city it can find (the fixture; the baked M2 tiles in public/tiles/atlanta/m2 when there are
 * some; the M1 tile as a single 2 km tile, four 1 km tiles' worth), it integrates every tile with the job budget and reports the
 * slowest job, the worst tick, the ticks to ready, the total, and the heap and buffers held with the tiles resident.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { parseCityIndex, type CityIndex } from '../../src/shared/city';
import { initRapier } from '../../src/sim/physics/rapier';
import { HttpTileSource, FixtureTileSource, type TileSource } from '../../src/sim/stream/TileSource';
import { TileStreamer } from '../../src/sim/stream/TileStreamer';

// the Rapier WASM instance's memory, to count what the colliders hold (it grows and never shrinks)
const wasmMemories: WebAssembly.Memory[] = [];
{
  const inst = WebAssembly.instantiate.bind(WebAssembly) as (...a: unknown[]) => Promise<unknown>;
  (WebAssembly as unknown as { instantiate: unknown }).instantiate = async (...a: unknown[]) => {
    const r = (await inst(...a)) as { instance?: WebAssembly.Instance; exports?: WebAssembly.Exports };
    const ex = r.instance?.exports ?? (r as unknown as WebAssembly.Instance).exports;
    for (const v of Object.values(ex ?? {})) if (v instanceof WebAssembly.Memory) wasmMemories.push(v);
    return r;
  };
}
const wasmBytes = () => wasmMemories.reduce((a, m) => a + m.buffer.byteLength, 0);

const fileFetch = async (url: string) => {
  const path = url.replace(/^file:\/\//, '');
  if (!existsSync(path)) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
  const b = readFileSync(path);
  return { ok: true, status: 200, json: async () => JSON.parse(b.toString()), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};

/** The M1 tile as a city of one tile. */
function m1Source(): TileSource | null {
  const dir = 'public/tiles/atlanta/m1-five-points/';
  if (!existsSync(dir + 'tile.json')) return null;
  const t = JSON.parse(readFileSync(dir + 'tile.json', 'utf8'));
  const index: CityIndex = parseCityIndex({
    format: 'hood-city', version: 1, id: 'atlanta/m1', city: 'atlanta', origin: t.origin, baseElevation: t.baseElevation, tileSize: 2000,
    tiles: [{ id: 'm1', i: 0, j: 0, bounds: t.bounds, path: '' }], spawn: { player: t.spawns.player, vehicle: t.spawns.vehicle }, attribution: [],
  });
  return { index, load: async (e) => ({ entry: e, tile: await (await import('../../src/shared/tile')).loadBakedTile(dir, fileFetch as never) }) };
}

const mb = (b: number) => +(b / 1048576).toFixed(1);

async function measure(name: string, source: TileSource, budget = 1500) {
  const R = await initRapier();
  (globalThis as { gc?: () => void }).gc?.();
  const m0 = process.memoryUsage();
  const w0 = wasmBytes();
  const st = new TileStreamer(R, source, { rings: { near: 1e6, drop: 2e6, far: 3e6 }, budget });
  // time every job as the streamer runs it, a tick at a time
  const jobs: { name: string; ms: number; cost: number }[] = [];
  const q = (st as unknown as { queue: { name: string; cost: number; run: (b: number) => boolean }[] }).queue;
  const sp = source.index.spawn.player;
  // load everything (fetches), then integrate tick by tick
  (st as unknown as { check(x: number, z: number): void }).check(sp.x, sp.z);
  await st.idle();
  let ticks = 0;
  let worstTick = 0;
  const tickMs: number[] = [];
  const t0 = performance.now();
  for (; ticks < 100000 && !st.settled; ticks++) {
    for (const j of q) {
      if ((j as { wrapped?: boolean }).wrapped) continue;
      const run = j.run;
      (j as { wrapped?: boolean }).wrapped = true;
      j.run = (b: number) => {
        const a = performance.now();
        const done = run(b);
        jobs.push({ name: j.name.replace(/:\d+$/, ''), ms: performance.now() - a, cost: j.cost });
        return done;
      };
    }
    const a = performance.now();
    st.update(ticks, sp.x, sp.z);
    const ms = performance.now() - a;
    tickMs.push(ms);
    worstTick = Math.max(worstTick, ms);
  }
  const total = performance.now() - t0;
  (globalThis as { gc?: () => void }).gc?.();
  const m1 = process.memoryUsage();
  const byKind = new Map<string, { n: number; ms: number; max: number; cost: number }>();
  for (const j of jobs) {
    const k = j.name.replace(/^[^:]+:/, '');
    const e = byKind.get(k) ?? { n: 0, ms: 0, max: 0, cost: 0 };
    e.n++;
    e.ms += j.ms;
    e.max = Math.max(e.max, j.ms);
    e.cost += j.cost;
    byKind.set(k, e);
  }
  tickMs.sort((x, y) => x - y);
  const tiles = st.tiles.size;
  console.log(`\n== ${name}: ${tiles} tiles, budget ${budget} units a tick`);
  console.log(`  integrate: ${ticks} ticks, ${total.toFixed(0)} ms in all (${(total / tiles).toFixed(1)} ms a tile), worst tick ${worstTick.toFixed(2)} ms, p95 tick ${tickMs[Math.floor(tickMs.length * 0.95)]?.toFixed(2)} ms`);
  for (const [k, e] of [...byKind].sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${k.padEnd(18)} ${String(e.n).padStart(4)} jobs  ${e.ms.toFixed(1).padStart(8)} ms  max ${e.max.toFixed(2).padStart(6)} ms  (${(e.ms * 1000 / Math.max(1, e.cost)).toFixed(2)} us a unit)`);
  const w1 = wasmBytes();
  console.log(`  resident: heap +${mb(m1.heapUsed - m0.heapUsed)} MB, array buffers +${mb(m1.arrayBuffers - m0.arrayBuffers)} MB, Rapier WASM memory ${mb(w0)} -> ${mb(w1)} MB, rss +${mb(m1.rss - m0.rss)} MB; a tile: heap ${mb((m1.heapUsed - m0.heapUsed) / tiles)} MB, WASM ${mb((w1 - w0) / tiles)} MB`);
  st.releaseData();
  (globalThis as { gc?: () => void }).gc?.();
  const m2 = process.memoryUsage();
  console.log(`  with the parsed files let go (as in the game): heap +${mb(m2.heapUsed - m0.heapUsed)} MB (${mb((m2.heapUsed - m0.heapUsed) / tiles)} MB a tile), array buffers +${mb(m2.arrayBuffers - m0.arrayBuffers)} MB`);
  console.log(`  stats ${JSON.stringify(st.stats())}`);
}

describe.skipIf(!process.env.STREAM_COST)('streaming cost (sim)', () => {
  it('fixture 3 x 3', async () => measure('fixture 3 x 3 (384 m tiles)', new FixtureTileSource()), 600_000);
  it('M2 tiles baked so far', async () => {
    if (!existsSync('public/tiles/atlanta/m2/index.json')) return;
    const base = `file://${process.cwd()}/public/tiles/atlanta/m2/index.json`;
    const src = await HttpTileSource.open(base, fileFetch as never);
    await measure(`M2 (${src.index.tiles.length} tiles of ${src.index.tileSize} m)`, src);
  }, 600_000);
  it('M1 as one 2 km tile', async () => {
    const s = m1Source();
    if (s) await measure('M1 Five Points as one tile (2 x 2 km)', s);
  }, 600_000);
});
