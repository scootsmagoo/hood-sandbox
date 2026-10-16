import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, fetchOverpassToCache, OVERPASS_POLICY, PoliteClient, retryAfterMs, validateOverpass, type HttpDeps } from '../src/city/http';
import { bboxHits, overpassCacheFile, overpassJobs } from '../src/city/prefetch';
import { cellBakeConfig, loadGrid } from '../src/city/grid';
import { fetchOsm, fetchOsmBuildingParts as fetchOsmParts, fetchOsmNodes, fetchOsmPois, fetchOsmProps } from '../src/sources/osm';

/** A fake clock: sleep advances it, nothing waits. */
function fakeDeps(responses: (() => Response | Promise<Response>)[]) {
  let t = 1_000_000;
  const waits: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const deps: HttpDeps = {
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    random: () => 0.5,
    log: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error('no more responses');
      return r();
    },
  };
  return { deps, waits, calls, time: () => t };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const tmp = () => mkdtempSync(path.join(tmpdir(), 'hood-prefetch-'));
const ENDPOINTS = ['https://a.example/api/interpreter', 'https://b.example/api/interpreter', 'https://c.example/api/interpreter'];

describe('prefetch backoff', () => {
  it('grows the backoff from 5 s, with jitter, capped at 5 min', () => {
    const p = OVERPASS_POLICY;
    expect(backoffMs(0, p, () => 0.5)).toBe(5000);
    expect(backoffMs(1, p, () => 0.5)).toBe(10000);
    expect(backoffMs(2, p, () => 0)).toBe(15000);
    expect(backoffMs(10, p, () => 0.99)).toBe(300000);
  });

  it('reads Retry-After in seconds and as a date', () => {
    expect(retryAfterMs('30', 0)).toBe(30000);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
  });

  it('treats a remark that the query timed out as a failure', () => {
    expect(validateOverpass('{"elements":[]}').ok).toBe(true);
    expect(validateOverpass('{"elements":[],"remark":"runtime error: Query timed out in \\"query\\" at line 3 after 120 seconds."}').ok).toBe(false);
    expect(validateOverpass('{"elements":[],"remark":"runtime error: Query run out of memory"}').ok).toBe(false);
    expect(validateOverpass('<html>busy</html>').ok).toBe(false);
    expect(validateOverpass('{"foo":1}').ok).toBe(false);
  });

  it('retries a 429 on the next endpoint after Retry-After, then caches the 200', async () => {
    const f = fakeDeps([() => new Response('rate limited', { status: 429, headers: { 'retry-after': '42' } }), ok({ elements: [{ type: 'node', id: 1, lat: 0, lon: 0 }] })]);
    const client = new PoliteClient(OVERPASS_POLICY, f.deps);
    const file = path.join(tmp(), 'osm-x.json');
    const r = await fetchOverpassToCache(client, ENDPOINTS, '[out:json];node(1);out;', file, 'test');
    expect(r.status).toBe('fetched');
    expect(f.calls.map((c) => c.url)).toEqual([ENDPOINTS[0], ENDPOINTS[1]]);
    expect(Math.max(...f.waits)).toBeGreaterThanOrEqual(42000);
    expect(JSON.parse(readFileSync(file, 'utf8')).elements.length).toBe(1);
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/hood-sandbox/);
    // a second run fetches nothing
    const again = await fetchOverpassToCache(client, ENDPOINTS, '[out:json];node(1);out;', file, 'test');
    expect(again.status).toBe('cached');
    expect(f.calls.length).toBe(2);
  });

  it('spaces requests at least 2 s apart, one at a time', async () => {
    const f = fakeDeps([ok({ elements: [] }), ok({ elements: [] }), ok({ elements: [] })]);
    const client = new PoliteClient(OVERPASS_POLICY, f.deps);
    const dir = tmp();
    const starts: number[] = [];
    const orig = f.deps.fetch;
    f.deps.fetch = async (u, i) => {
      starts.push(f.time());
      return orig(u, i);
    };
    await Promise.all([0, 1, 2].map((k) => fetchOverpassToCache(client, ENDPOINTS, `q${k}`, path.join(dir, `f${k}.json`), 't')));
    expect(starts.length).toBe(3);
    for (let k = 1; k < 3; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThanOrEqual(2000);
  });

  it('never caches a failed answer: a remark timeout on every attempt gives up after 6 tries', async () => {
    const bad = ok({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 120 seconds.' });
    const f = fakeDeps([bad, bad, bad, bad, bad, bad, bad]);
    const client = new PoliteClient(OVERPASS_POLICY, f.deps);
    const file = path.join(tmp(), 'osm-y.json');
    const r = await fetchOverpassToCache(client, ENDPOINTS, 'q', file, 'test');
    expect(r.status).toBe('failed');
    expect(f.calls.length).toBe(6);
    expect(existsSync(file)).toBe(false);
    // the endpoints were rotated
    expect(new Set(f.calls.map((c) => c.url)).size).toBe(3);
    // 5, 10, 20, 40, 80 s
    expect(f.waits.filter((w) => w >= 5000)).toEqual([5000, 10000, 20000, 40000, 80000]);
  });

  it('gives up at once on a 400 (the query is wrong), and retries network errors and timeouts', async () => {
    const f = fakeDeps([() => new Response('bad', { status: 400 })]);
    const r = await fetchOverpassToCache(new PoliteClient(OVERPASS_POLICY, f.deps), ENDPOINTS, 'q', path.join(tmp(), 'z.json'), 't');
    expect(r.status).toBe('failed');
    expect(f.calls.length).toBe(1);
    const g = fakeDeps([() => Promise.reject(new TypeError('fetch failed')), () => new Promise<Response>(() => {}), ok({ elements: [] })]);
    const client = new PoliteClient({ ...OVERPASS_POLICY, timeoutMs: 20 }, g.deps);
    const file = path.join(tmp(), 'w.json');
    const r2 = await fetchOverpassToCache(client, ENDPOINTS, 'q', file, 't');
    expect(r2.status).toBe('fetched');
    expect(g.calls.length).toBe(3);
    expect(existsSync(file)).toBe(true);
  });
});

describe('prefetch cache files', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the files the tile bake reads, so it runs offline', async () => {
    const g = loadGrid();
    const { cfg } = cellBakeConfig(g, g.cells[0]);
    const dir = tmp();
    const c = { ...cfg, cacheDir: dir };
    const jobs = overpassJobs(c.queryBox);
    expect(jobs.map((j) => j.prefix)).toEqual(['osm-overpass', 'osm-nodes', 'osm-pois', 'osm-props', 'osm-parts']);
    jobs.forEach((j, k) => writeFileSync(overpassCacheFile(dir, j.prefix, j.query), JSON.stringify({ elements: [{ type: 'node', id: k + 1, lat: 0, lon: 0 }] })));
    vi.stubGlobal('fetch', () => {
      throw new Error('the network must not be used');
    });
    expect((await fetchOsm(c)).elements[0].id).toBe(1);
    expect((await fetchOsmNodes(c)).elements[0].id).toBe(2);
    expect((await fetchOsmPois(c))!.elements[0].id).toBe(3);
    expect((await fetchOsmProps(c))!.elements[0].id).toBe(4);
    expect((await fetchOsmParts(c))!.elements[0].id).toBe(5);
  });

  it('cuts Overture features by the per-tile query box', () => {
    const q = { south: 1, west: 10, north: 2, east: 11 };
    expect(bboxHits([10.5, 1.5, 10.6, 1.6], q)).toBe(true);
    expect(bboxHits([9, 0, 10.01, 1.01], q)).toBe(true);
    expect(bboxHits([9, 0, 10, 1], q)).toBe(false);
    expect(bboxHits([11, 1.5, 12, 1.6], q)).toBe(false);
  });
});
