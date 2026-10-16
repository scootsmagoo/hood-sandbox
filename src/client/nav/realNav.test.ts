/** The GPS on the real Downtown tile (skipped when no baked tile is in public/tiles). */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLanes } from '../../shared/lanes';
import { parseRoads } from '../../shared/tile';
import { parsePaths } from '../../shared/walk';
import { NavCore } from './core';
import { buildDriveTile, DriveNet } from './driveNet';
import { driveRoute, planDrive, planWalk, walkRoute } from './planner';
import { buildWalkTile, WalkNet } from './walkNet';

const dir = 'public/tiles/atlanta/m1-five-points/';
const have = existsSync(`${dir}lanes.json`);
const bounds = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };

describe.skipIf(!have)('the GPS on Downtown Atlanta', () => {
  // A skipped describe still runs its body to collect tests, so read the tile only when it is there (CI has no baked tiles).
  const rd = (f: string) => JSON.parse(readFileSync(dir + f, 'utf8'));
  const roads = have ? parseRoads(rd('roads.json')) : (undefined as never);
  const lanes = have ? parseLanes(rd('lanes.json'))! : (undefined as never);
  const paths = have ? parsePaths(rd('paths.json'))! : (undefined as never);
  const net = have ? DriveNet.assemble([buildDriveTile('m1', bounds, lanes, roads)]) : (undefined as never);
  const walk = have ? WalkNet.assemble([buildWalkTile('m1', bounds, paths)]) : (undefined as never);

  it('builds the graphs and finds the big connected part', () => {
    expect(net.count).toBeGreaterThan(5000);
    expect(net.mainSize).toBeGreaterThan(net.count * 0.5);
    expect(net.names.length).toBeGreaterThan(50);
    expect(walk.nodeCount).toBeGreaterThan(5000);
  });

  it('drives across the tile in a few ms of search, with named turns', () => {
    const to = { x: 600, z: -735 };
    const plan = planDrive(net, { x: 3, z: 9, heading: { x: 1, z: 0 } }, to);
    if ('error' in plan) throw new Error(plan.error);
    const t0 = performance.now();
    expect(plan.search.step(200)).toBe('found');
    expect(performance.now() - t0).toBeLessThan(100);
    const r = driveRoute(net, plan.search.result!, to);
    expect(r.length).toBeGreaterThan(Math.hypot(597, 744));
    expect(r.length).toBeLessThan(4000);
    expect(r.steps.some((s) => s.street.length > 0)).toBe(true);
    expect(r.steps[r.steps.length - 1].kind).toBe('arrive');
    // no jump in the line: every step of it is a lane's length or less
    for (let i = 1; i < r.count; i++) expect(Math.hypot(r.xs[i] - r.xs[i - 1], r.zs[i] - r.zs[i - 1])).toBeLessThan(260);
  });

  it('a waypoint on a freeway nothing in the tile leads onto is reached by the nearest street', () => {
    const core = new NavCore();
    core.roads.setTile('m1', roads);
    core.setNets(net, walk);
    const wp = core.setWaypoint(800, -800);
    expect(wp.snapped).toBe(true);
    for (let i = 0; i < 60; i++) core.update(1 / 30, { x: -800, y: 0, z: 600, heading: { x: 1, z: 0 }, inVehicle: true }, 50);
    expect(['ok', 'partial']).toContain(core.status);
    expect(core.route!.length).toBeGreaterThan(1500);
  });

  it('walks too, and a waypoint off the map ends the road at the tile edge and runs on straight', () => {
    const to = { x: 4000, z: 9 };
    const plan = planDrive(net, { x: 3, z: 9, heading: { x: 1, z: 0 } }, to);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.frontier).toBe(true);
    plan.search.step(200);
    const r = driveRoute(net, plan.search.result!, to);
    expect(r.partial).toBe(true);
    expect(r.tail).not.toBeNull();
    expect(Math.max(...r.xs)).toBeLessThanOrEqual(1000.5);
    const wplan = planWalk(walk, { x: 3, z: 9 }, { x: 300, z: 300 }, () => '');
    if (!('search' in wplan)) throw new Error('no walk search');
    expect(wplan.search.step(200)).toBe('found');
    const wr = walkRoute(walk, wplan.search.result!, wplan.start, wplan.goal, { x: 300, z: 300 }, () => '');
    expect(wr.length).toBeGreaterThan(400);
  });
});
