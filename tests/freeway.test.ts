/**
 * The freeways: lanes that leave the loaded area are sources and sinks, so a motorway that does not loop inside a tile still carries
 * traffic, at the density and speed the population table gives for the hour; and nobody walks on one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureTile } from '../src/shared/fixture';
import { loadBakedTile } from '../src/shared/tile';
import type { PedEntity } from '../src/sim/entities';
import { Simulation } from '../src/sim/Simulation';
import { FreewayMask } from '../src/sim/peds/freeway';
import { LaneGraph } from '../src/sim/traffic/LaneGraph';
import { TRAFFIC } from '../src/sim/traffic/TrafficManager';
import { DEFAULT_FREEWAY, freewayAt, GENERIC_TRAFFIC_POPULATION, parseTrafficPopulation } from '../src/sim/traffic/population';
import defaultPopulation from '../src/shared/data/defaultPopulation.json';
import { citySim, movePlayer } from './stream/streamHelpers';
import { lanesFor, road, laneTile } from './trafficHelpers';

const player = (sim: Simulation) => sim.registry.get(sim.playerPedId) as PedEntity;
const FW = (id: string, pts: [number, number][]) => road(id, pts, { class: 'motorway', lanes: 3, oneway: true, width: 12 });

/** A one-way motorway of three lanes straight through the flat tile (-1000 to 1000 along x), nothing else. */
function motorwayTile() {
  const lanes = lanesFor([FW('fw', [[-1000, 0], [1000, 0]])]);
  return laneTile(lanes);
}

const onFreeway = (sim: Simulation) => sim.traffic!.cars.filter((c) => sim.traffic!.graph.fwClass[c.edge] === 1 && c.mode !== 'free');

describe('sources and sinks', () => {
  it('a motorway that does not loop is a through route: not main, but driven on, from the edge it starts at to the edge it ends at', () => {
    const tile = motorwayTile();
    const flat = new LaneGraph(tile.lanes!);
    // (without the through routes a graph is as it was: no flow, and at most the one lane the old code called main)
    expect(Array.from(flat.flow).some((v) => v)).toBe(false);
    expect(Array.from(flat.drive).filter((v) => v).length).toBeLessThanOrEqual(1);
    const g = new LaneGraph(tile.lanes!, false, { flow: true, bounds: tile.manifest.bounds });
    const lanes = Array.from({ length: g.count }, (_, i) => i).filter((i) => !g.isConnector[i]);
    expect(lanes.length).toBe(3);
    for (const e of lanes) {
      expect(g.main[e]).toBe(0);
      expect(g.flow[e]).toBe(1);
      expect(g.drive[e]).toBe(1);
      expect(g.fwClass[e]).toBe(1);
      // starts at the western edge, ends at the eastern one
      expect(g.edgeKind[e]).toBe(3);
    }
    expect(g.sources.length).toBe(3);
    expect(g.usable).toBe(true);
    // spawn spots: not in the avenues' list, in the through routes' list
    expect(g.spotsAround(0, 0, 0, 300, []).length).toBe(0);
    const spots = g.spotsAround(0, 0, 0, 300, [], true);
    expect(spots.length).toBeGreaterThan(20);
    expect(spots.every((s) => s.fw === 1)).toBe(true);
  });

  it('a lane that merely stops short inside the tile is not a source or a sink', () => {
    const tile = laneTile(lanesFor([FW('fw', [[-500, 0], [500, 0]])]));
    const g = new LaneGraph(tile.lanes!, false, { flow: true, bounds: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 } });
    // the road ends 500 m inside the tile on both ends: dead ends in the middle of the world, not leaving it
    expect(g.sources.length).toBe(0);
    for (let e = 0; e < g.count; e++) expect(g.flow[e]).toBe(0);
  });

  it('the Connector is populated: cars enter at the edge and leave at the other, at the speed of the hour, and none is left stopped at the end', async () => {
    const results: Record<number, { cars: number; speed: number }> = {};
    for (const hour of [3, 8, 13, 17]) {
      const sim = await Simulation.create({ seed: 4, tile: motorwayTile(), driver: false, parkedCars: 0, traffic: 1, clock: { minutes: hour * 60, scale: 0 } });
      const g = sim.traffic!.graph;
      const me = player(sim);
      me.controller.teleport(0, sim.groundAt(0, 24) + 0.2, 24);
      let n = 0;
      let sumCars = 0;
      let sumSpeed = 0;
      let samples = 0;
      for (let t = 0; t < 70 * 60; t++) {
        sim.step();
        sim.drainEvents();
        if (t > 25 * 60 && t % 60 === 0) {
          const cars = onFreeway(sim);
          sumCars += cars.length;
          for (const c of cars) { sumSpeed += c.v; n++; }
          samples++;
        }
      }
      results[hour] = { cars: sumCars / samples, speed: sumSpeed / Math.max(1, n) };
      const tm = sim.traffic!;
      // cars were fed in at the start of the motorway and taken out at its end
      expect(tm.stats.spawned).toBeGreaterThan(5);
      expect(tm.stats.despawned).toBeGreaterThan(2);
      // nobody wrecked, nobody going the wrong way, nobody left parked at the end
      expect(tm.count('free')).toBe(0);
      for (const c of onFreeway(sim)) {
        const b = c.veh.car.body.translation();
        expect(Math.abs(b.z)).toBeLessThan(10);
        expect(c.veh.car.yaw).toBeGreaterThan(Math.PI / 2 - 0.4);
        expect(c.veh.car.yaw).toBeLessThan(Math.PI / 2 + 0.4);
      }
      console.log(`freeway ${hour}:00 -> ${results[hour].cars.toFixed(1)} cars within reach, ${(results[hour].speed * 2.237).toFixed(0)} mph, cap ${tm.freewayCap}`);
    }
    // never empty; the evening rush is the busiest and the slowest; the small hours the quietest
    expect(results[3].cars).toBeGreaterThan(2);
    expect(results[17].cars).toBeGreaterThan(results[3].cars * 1.5);
    expect(results[17].cars).toBeGreaterThan(results[13].cars - 3);
    expect(results[17].speed).toBeLessThan(results[3].speed * 0.8);
    // free flow is between 55 and 70 mph (24.6 to 31.3 m/s) for a good part of the cars
    expect(results[3].speed * 2.237).toBeGreaterThan(52);
    expect(results[3].speed * 2.237).toBeLessThan(75);
  }, 300_000);

  it('the freeway has its own cap, apart from the avenues, scaled by the tier and the hour', async () => {
    const mk = (hour: number, traffic: number) => Simulation.create({ seed: 4, tile: motorwayTile(), driver: false, parkedCars: 0, traffic, clock: { minutes: hour * 60, scale: 0 } });
    const rush = await mk(17, 1);
    rush.step();
    const night = await mk(3, 1);
    night.step();
    const phone = await mk(17, 0.5);
    phone.step();
    expect(rush.traffic!.freewayCap).toBe(TRAFFIC.freewayCap);
    expect(night.traffic!.freewayCap).toBeLessThan(rush.traffic!.freewayCap * 0.5);
    expect(phone.traffic!.freewayCap).toBe(Math.round(TRAFFIC.freewayCap / 4));
  });

  it('the freeway row of the population table: blended between slots, parsed, and defaulted', () => {
    const noon = freewayAt(GENERIC_TRAFFIC_POPULATION, 13 * 60, false);
    const rush = freewayAt(GENERIC_TRAFFIC_POPULATION, 17 * 60, false);
    const night = freewayAt(GENERIC_TRAFFIC_POPULATION, 3 * 60, false);
    expect(rush.cars).toBeGreaterThan(noon.cars);
    expect(rush.speed).toBeLessThan(noon.speed);
    expect(night.cars).toBeLessThan(noon.cars / 2);
    // 16:00 is the boundary of two slots: the middle of the two rows' values, not a step
    const edge = freewayAt(GENERIC_TRAFFIC_POPULATION, 16 * 60, false);
    expect(edge.cars).toBeCloseTo((DEFAULT_FREEWAY.weekday[7].cars + DEFAULT_FREEWAY.weekday[8].cars) / 2, 5);
    const custom = parseTrafficPopulation({ ...defaultPopulation, freeway: { weekday: Array.from({ length: 12 }, () => ({ cars: 7, speed: 0.5 })), weekend: Array.from({ length: 12 }, () => ({ cars: 3 })) } });
    expect(freewayAt(custom, 600, false).cars).toBe(7);
    expect(freewayAt(custom, 600, true).speed).toBe(1);
    expect(() => parseTrafficPopulation({ ...defaultPopulation, freeway: { weekday: [], weekend: [] } })).toThrow();
  });
});

describe('sources and sinks in a streamed city', () => {
  it('lie at the edge of the loaded area and not at a seam inside it, and the cars cross the seams', async () => {
    const sim = await citySim({ traffic: 1, fixture: { freeway: true }, rings: { near: 260, drop: 420, far: 1500 } });
    // the freeway runs through the middle of every row: stand on the middle tile's carriageways
    movePlayer(sim, 192, 192 + 30);
    for (let i = 0; i < 90; i++) sim.step();
    const st = sim.stream!;
    const g = st.lanes;
    const tm = sim.traffic!;
    const tiles = [...g.tiles.values()];
    expect(tiles.length).toBeGreaterThanOrEqual(5);
    // every source and sink is at the edge of the loaded tiles
    let sources = 0;
    let sinks = 0;
    for (let e = 0; e < g.count; e++) {
      if (!g.alive[e] || !g.edgeKind[e]) continue;
      const p = g.pts[e];
      if (g.edgeKind[e] & 1) {
        sources++;
        expect(g.outsideLoaded(p[0] - (p[3] - p[0]) / Math.hypot(p[3] - p[0], p[5] - p[2]) * 30, p[2] - (p[5] - p[2]) / Math.hypot(p[3] - p[0], p[5] - p[2]) * 30)).toBe(true);
      }
      if (g.edgeKind[e] & 2) sinks++;
    }
    expect(sources).toBeGreaterThan(0);
    expect(sinks).toBeGreaterThan(0);
    // a lane stitched across a seam is neither
    const links = g.seamLinks();
    expect(links.length).toBeGreaterThan(3);
    for (const [out, into] of links) {
      expect(g.edgeKind[out] & 2).toBe(0);
      expect(g.edgeKind[into] & 1).toBe(0);
    }
    // the freeway lanes are driven on, though none of them is in the main component
    const fwLanes = Array.from({ length: g.count }, (_, e) => e).filter((e) => g.alive[e] && g.fwClass[e] === 1 && !g.isConnector[e]);
    expect(fwLanes.length).toBeGreaterThan(6);
    expect(fwLanes.every((e) => g.drive[e] === 1 && g.main[e] === 0)).toBe(true);
    // cars drive along it from tile to tile
    const tileX = (x: number) => Math.floor(x / 384);
    const last = new Map<number, number>();
    let crossed = 0;
    for (let t = 0; t < 70 * 60; t++) {
      sim.step();
      sim.drainEvents();
      if (t % 10) continue;
      for (const c of onFreeway(sim)) {
        const b = c.veh.car.body.translation();
        const k = tileX(b.x);
        const prev = last.get(c.veh.id);
        if (prev !== undefined && prev !== k) crossed++;
        last.set(c.veh.id, k);
      }
    }
    expect(onFreeway(sim).length).toBeGreaterThan(6);
    expect(crossed).toBeGreaterThan(3);
    expect(tm.stats.spawned).toBeGreaterThan(20);
  }, 200_000);
});

describe('nobody walks on a freeway', () => {
  const tile = fixtureTile(0, 0, { freeway: true });

  it('the mask knows a carriageway, the height it is at, and a ramp from a street', () => {
    const m = new FreewayMask(tile.roads);
    // the eastbound carriageway: z = 192 + 8, 12 m wide
    expect(m.contains(100, 200, tile.roads!.find((r) => r.id === 'fx:fw:e')!.points[10][1])).toBe(true);
    expect(m.contains(100, 215)).toBe(false);
    // 9 m above it: a bridge over the freeway, not the freeway
    expect(m.contains(100, 200, tile.roads!.find((r) => r.id === 'fx:fw:e')!.points[10][1] + 9)).toBe(false);
    const hit = m.hit(100, 202, NaN)!;
    expect(hit.cls).toBe(1);
    expect(hit.depth).toBeGreaterThan(3);
    expect(Math.abs(hit.nz)).toBeCloseTo(1, 3);
  });

  it('closes the walk edges along or across a motorway, and nobody is made on them or ends up on the carriageway', async () => {
    const sim = await Simulation.create({ seed: 2, tile, ambientPeds: true, pedBudget: 60, parkedCars: 0, traffic: 1, clock: { minutes: 14 * 60, scale: 0 } });
    const A = sim.ambient!;
    const g = A.graph;
    let closed = 0;
    for (let e = 0; e < g.edgeCount; e++) {
      if (!A.freewayEdge(e)) continue;
      closed++;
      // a closed edge is not walkable, or spawnable
      expect(g.passable!(e)).toBe(false);
    }
    expect(closed).toBeGreaterThan(0);
    // the fixture's sidewalks across the carriageways were cut: no route from the north of the freeway to the south
    const north = g.nearestNode(150, 130, 60);
    const south = g.nearestNode(150, 260, 60);
    expect(north).toBeGreaterThanOrEqual(0);
    expect(south).toBeGreaterThanOrEqual(0);
    expect(g.route(north, south, 20000)).toBeNull();
    const mask = new FreewayMask(tile.roads);
    player(sim).controller.teleport(150, sim.groundAt(150, 130) + 0.2, 130);
    let spawned = 0;
    for (let t = 0; t < 120 * 60; t++) {
      sim.step();
      sim.drainEvents();
      if (t % 20) continue;
      for (const p of A.list) {
        if (p.vehicleId) continue;
        spawned++;
        const c = p.controller;
        expect(mask.contains(c.x, c.z, c.y)).toBe(false);
      }
    }
    expect(spawned).toBeGreaterThan(200);
  }, 120_000);

  it('a ped that runs from a threat across open ground never stays on the freeway: steered off it, or gone when unseen', async () => {
    const sim = await Simulation.create({ seed: 2, tile, ambientPeds: true, pedBudget: 50, parkedCars: 0, traffic: 0, clock: { minutes: 14 * 60, scale: 0 } });
    const A = sim.ambient!;
    const mask = new FreewayMask(tile.roads);
    // the player stands north of the freeway, on a sidewalk; everybody on the sidewalk near the freeway is scared from the north,
    // so the way "away" is over the carriageways
    player(sim).controller.teleport(150, sim.groundAt(150, 110) + 0.2, 110);
    for (let i = 0; i < 180; i++) sim.step();
    let onFor = new Map<number, number>();
    let maxOn = 0;
    let ran = 0;
    for (let round = 0; round < 6; round++) {
      A.scare(150, sim.groundAt(150, 110), 110, 120, 'gunfire');
      for (let t = 0; t < 12 * 60; t++) {
        sim.step();
        sim.drainEvents();
        if (t % 6) continue;
        for (const p of A.list) {
          if (p.vehicleId) continue;
          const c = p.controller;
          if (p.amb!.mode === 'flee') ran++;
          if (mask.contains(c.x, c.z, c.y)) {
            const s = (onFor.get(p.id) ?? 0) + 0.1;
            onFor.set(p.id, s);
            maxOn = Math.max(maxOn, s);
          } else onFor.delete(p.id);
        }
      }
    }
    expect(ran).toBeGreaterThan(50);
    // (a ped who is seen is walked off it in a few seconds)
    expect(maxOn).toBeLessThan(8);
  }, 120_000);
});

const DIR = 'public/tiles/atlanta/m1-five-points';
const have = existsSync(`${DIR}/tile.json`);
const fsFetch = async (url: string) => {
  const path = url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

describe.skipIf(!have)('the baked Five Points tile', () => {
  it('has through routes on the Downtown Connector, and no walk edge on a motorway carriageway at its level', async () => {
    const tile = await loadBakedTile(DIR, fsFetch);
    const g = new LaneGraph(tile.lanes!, false, { flow: true, bounds: tile.manifest.bounds });
    let fwLanes = 0;
    let fwFlow = 0;
    for (let e = 0; e < g.count; e++) {
      if (g.isConnector[e] || g.fwClass[e] !== 1) continue;
      fwLanes++;
      if (g.drive[e]) fwFlow++;
    }
    // most of the tile's motorway lanes are drivable; before, one of 218 was
    expect(fwFlow / fwLanes).toBeGreaterThan(0.6);
    const mask = new FreewayMask(tile.roads);
    const p = tile.paths!;
    let bad = 0;
    for (let i = 0; i < p.edges.length; i += 3) {
      const a = p.nodes[p.edges[i]], b = p.nodes[p.edges[i + 1]];
      const kind = p.attrs[p.edges[i + 2]].kind;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const h = mask.hit(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, a[1] + (b[1] - a[1]) * t);
        if (h && !(kind === 'crossing' && h.cls === 2)) { bad++; break; }
      }
    }
    // (a handful of edges may sit at the very rim of a carriageway; the sim closes those)
    expect(bad).toBeLessThan(5);
    // cutting the freeways out leaves the walk network in one piece: bridges' sidewalks and the real crossings keep it joined
    const par = p.nodes.map((_, i) => i);
    const find = (a: number): number => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let i = 0; i < p.edges.length; i += 3) par[find(p.edges[i])] = find(p.edges[i + 1]);
    const len = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < p.edges.length; i += 3) {
      const a = p.nodes[p.edges[i]], b = p.nodes[p.edges[i + 1]];
      const l = Math.hypot(a[0] - b[0], a[2] - b[2]);
      total += l;
      len.set(find(p.edges[i]), (len.get(find(p.edges[i])) ?? 0) + l);
    }
    expect(Math.max(...len.values()) / total).toBeGreaterThanOrEqual(0.97);
  });

  it('the Connector is full of cars at midday and at the evening rush, and no pedestrian is on it', async () => {
    for (const [hour, atLeast] of [[13, 25], [17, 35]] as const) {
      const tile = await loadBakedTile(DIR, fsFetch);
      const sim = await Simulation.create({ seed: 1, tile, ambientPeds: true, pedBudget: 60, traffic: 1, parkedCars: 0, clock: { minutes: hour * 60, scale: 0 } });
      const mask = new FreewayMask(tile.roads);
      // under the Capitol Avenue overpass, on the Connector
      player(sim).controller.teleport(214, sim.groundAt(214, 835) + 0.3, 835);
      const g = sim.traffic!.graph;
      let cars = 0;
      let samples = 0;
      let peds = 0;
      const since = new Map<number, number>();
      for (let t = 0; t < 60 * 60; t++) {
        sim.step();
        sim.drainEvents();
        if (t > 20 * 60 && t % 60 === 0) {
          let n = 0;
          for (const c of sim.traffic!.cars) {
            const b = c.veh.car.body.translation();
            if (g.fwClass[c.edge] && Math.hypot(b.x - 214, b.z - 835) < 200) n++;
          }
          cars += n;
          samples++;
        }
        if (t % 30 === 0) {
          for (const p of sim.peds()) {
            if (p.role === 'player' || p.vehicleId || p.life !== 'alive') continue;
            // (a runner may swing a step into the edge of one on its way along the pavement: it is walked off at once, so no more than a moment)
            if (!mask.contains(p.controller.x, p.controller.z, p.controller.y)) { since.delete(p.id); continue; }
            const from = since.get(p.id) ?? t;
            since.set(p.id, from);
            if (t - from > 4 * 60) peds++;
          }
        }
      }
      console.log(`Connector ${hour}:00 -> ${(cars / samples).toFixed(1)} freeway cars within 200 m, ${peds} pedestrian samples on a carriageway for over 4 s`);
      expect(cars / samples).toBeGreaterThan(atLeast);
      expect(peds).toBe(0);
    }
  }, 300_000);
});
