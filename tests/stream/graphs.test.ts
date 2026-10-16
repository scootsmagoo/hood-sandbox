/** The tile-aware graphs on their own: stable id ranges, seams joined and undone, the main component recomputed in slices. */
import { describe, expect, it } from 'vitest';
import { fixtureTile } from '../../src/shared/fixture';
import { matchLanePorts, seamPorts } from '../../src/shared/seams';
import { WalkGraph } from '../../src/sim/peds/graph';
import { RoadGraph } from '../../src/sim/police/roadGraph';
import { LaneGraph, RangeAlloc } from '../../src/sim/traffic/LaneGraph';

describe('id ranges', () => {
  it('reuse what was freed, first fit, and give the tail back', () => {
    const a = new RangeAlloc();
    expect(a.alloc(10)).toBe(0);
    expect(a.alloc(5)).toBe(10);
    a.release(0, 10);
    expect(a.alloc(4)).toBe(0);
    expect(a.alloc(7)).toBe(15);
    a.release(15, 7);
    expect(a.high).toBe(15);
  });
});

describe('the lane graph across tiles', () => {
  const t00 = fixtureTile(0, 0), t10 = fixtureTile(1, 0);

  it('keeps the ids of a tile that stays when its neighbour goes and comes back', () => {
    const g = LaneGraph.streaming();
    const a = g.addTile('0_0', t00.lanes!, '0_0');
    const b = g.addTile('1_0', t10.lanes!, '1_0');
    const ptsA = Array.from(g.pts[a.base + 5]);
    g.removeTile('1_0');
    for (let e = b.base; e < b.base + b.n; e++) expect(g.alive[e]).toBe(0);
    const b2 = g.addTile('1_0', t10.lanes!, '1_0');
    expect(b2.base).toBe(b.base);
    expect(Array.from(g.pts[a.base + 5])).toEqual(ptsA);
    expect(g.junctionIndex.has('0_0/j2_2')).toBe(true);
  });

  it('joins the lanes of a seam, routes across it, and undoes the join when the neighbour drops', () => {
    const g = LaneGraph.streaming();
    const a = g.addTile('0_0', t00.lanes!, '0_0');
    const b = g.addTile('1_0', t10.lanes!, '1_0');
    const pa = seamPorts('0_0', t00.manifest.bounds, t00).sides.e!;
    const pb = seamPorts('1_0', t10.manifest.bounds, t10).sides.w!;
    const m = matchLanePorts(
      pa.lanes.map((p) => ({ ...p, edge: p.edge + a.base })),
      pb.lanes.map((p) => ({ ...p, edge: p.edge + b.base })),
    );
    expect(m.unmatched).toEqual([]);
    const before = new Map(m.pairs.map((p) => [p.out.edge, Array.from(g.next[p.out.edge])]));
    for (const p of m.pairs) g.stitch(p.out.edge, p.into.edge);
    // the main component, a little at a time
    const job = g.mainJob();
    let steps = 0;
    while (!job.step(50)) steps++;
    expect(steps).toBeGreaterThan(3);
    let mainA = 0, mainB = 0;
    for (let e = 0; e < g.count; e++) if (g.main[e]) e < b.base ? mainA++ : mainB++;
    expect(mainA).toBeGreaterThan(20);
    expect(mainB).toBeGreaterThan(20);
    g.removeTile('1_0');
    for (const [out, next] of before) if (out < b.base) expect(Array.from(g.next[out])).toEqual(next);
    expect(g.seamLinks().length).toBe(0);
  });
});

describe('the walk graph across tiles', () => {
  it('links the seam nodes and unlinks them with the tile', () => {
    const t00 = fixtureTile(0, 0), t10 = fixtureTile(1, 0);
    const w = WalkGraph.streaming();
    const a = w.addTile('0_0', t00.paths!);
    const b = w.addTile('1_0', t10.paths!);
    const pa = seamPorts('0_0', t00.manifest.bounds, t00).sides.e!.walk;
    const pb = seamPorts('1_0', t10.manifest.bounds, t10).sides.w!.walk;
    expect(pa.length).toBe(pb.length);
    for (let i = 0; i < pa.length; i++) w.stitch(pa[i].node + a.nodeBase, pb[i].node + b.nodeBase);
    expect(w.linkCount).toBe(pa.length);
    const from = pa[0].node + a.nodeBase;
    const route = w.route(w.nearestNode(150, 100), w.nearestNode(500, 100), 20000);
    expect(route).not.toBeNull();
    const length = w.totalLength;
    w.removeTile('1_0');
    expect(w.linkCount).toBe(0);
    expect(w.degree(from)).toBeGreaterThan(0);
    expect(w.totalLength).toBeLessThan(length);
  });
});

describe('the police road graph across tiles', () => {
  it('joins a road cut by a seam at its shared end, and forgets a dropped tile', () => {
    const t00 = fixtureTile(0, 0), t10 = fixtureTile(1, 0);
    const g = new RoadGraph([]);
    g.addRoads('0_0', t00.roads!);
    g.addRoads('1_0', t10.roads!);
    const route = g.route({ x: 150, z: 96 }, Math.PI / 2, { x: 600, z: 96 });
    expect(route).not.toBeNull();
    expect(route![route!.length - 1].x).toBeGreaterThan(590);
    g.removeTile('1_0');
    const r2 = g.route({ x: 150, z: 96 }, Math.PI / 2, { x: 600, z: 96 });
    // only as far as the seam now
    expect(Math.max(...(r2 ?? []).map((p) => p.x))).toBeLessThanOrEqual(384.5);
  });
});
