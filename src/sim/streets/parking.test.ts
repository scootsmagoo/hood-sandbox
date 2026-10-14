import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/rng';
import { parseRoads, type RoadData } from '../../shared/tile';
import { planParking, type ParkingOptions } from './parking';

const road = (id: string, a: [number, number], b: [number, number], over: Partial<RoadData> = {}): RoadData => ({
  id, class: 'residential', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[a[0], 0, a[1]], [b[0], 0, b[1]]], ...over,
});

const opts = (over: Partial<ParkingOptions> = {}): ParkingOptions => ({ around: { x: 0, z: 0 }, avoid: [], count: 4, ...over });

describe('parking planner', () => {
  const street = [road('main', [-150, 20], [150, 20], { oneway: true })];

  it('parks at the right-hand curb, facing the way traffic goes', () => {
    // a one-way street running east (+X): right is south (+Z); cars face east
    const slots = planParking(street, opts(), new Rng(1));
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.z).toBeGreaterThan(20);
      expect(s.z).toBeCloseTo(20 + (8 / 2 - 1.35), 6);
      // yaw of a car facing +X is PI/2 (it faces (sin yaw, cos yaw))
      expect(s.yaw).toBeCloseTo(Math.PI / 2, 6);
    }
    // the same street the other way round parks on the other side
    const west = planParking([road('main', [150, 20], [-150, 20], { oneway: true })], opts(), new Rng(1));
    for (const s of west) {
      expect(s.z).toBeLessThan(20);
      expect(Math.abs(s.yaw + Math.PI / 2)).toBeLessThan(1e-6);
    }
  });

  it('keeps its distance from the player, from each other and from what it is told to avoid', () => {
    const slots = planParking(street, opts({ avoid: [{ x: 30, z: 24, r: 12 }], minDist: 20, maxDist: 100, spacing: 11, count: 5, perRoad: 5 }), new Rng(2));
    expect(slots.length).toBe(5);
    for (const s of slots) {
      const d = Math.hypot(s.x, s.z);
      expect(d).toBeGreaterThanOrEqual(20);
      expect(d).toBeLessThanOrEqual(100);
      expect(Math.hypot(s.x - 30, s.z - 24)).toBeGreaterThanOrEqual(12);
    }
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) expect(Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z)).toBeGreaterThanOrEqual(11);
  });

  it('stays out of junctions, off the ends of a street, and off roads that are not for parking', () => {
    const roads = [road('main', [-150, 20], [150, 20]), road('cross', [0, -150], [0, 150])];
    const slots = planParking(roads, opts({ count: 20, minDist: 5, spacing: 6, perRoad: 20 }), new Rng(3));
    expect(slots.length).toBeGreaterThan(3);
    for (const s of slots) {
      if (s.roadId === 'main') expect(Math.abs(s.x)).toBeGreaterThan(4 + 9 - 0.01);
      if (s.roadId === 'cross') expect(Math.abs(s.z - 20)).toBeGreaterThan(4 + 9 - 0.01);
      expect(Math.abs(s.x) < 136 || s.roadId === 'cross').toBe(true);
    }
    const bad = [road('hwy', [-150, 20], [150, 20], { class: 'motorway' }), road('alley', [-150, 40], [150, 40], { class: 'service' }), road('deck', [-150, 60], [150, 60], { bridge: true, layer: 1 })];
    expect(planParking(bad, opts(), new Rng(1))).toEqual([]);
  });

  it('is seeded: the same seed parks the same cars and another seed parks different ones', () => {
    const a = planParking(street, opts(), new Rng(5));
    const b = planParking(street, opts(), new Rng(5));
    const c = planParking(street, opts(), new Rng(6));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('limits the cars on one road', () => {
    const slots = planParking(street, opts({ count: 10, perRoad: 2 }), new Rng(4));
    expect(slots.length).toBe(2);
  });

  const real = 'public/tiles/atlanta/m1-five-points';
  it.skipIf(!existsSync(`${real}/roads.json`))('finds curb spots near the Five Points spawn on the real roads', () => {
    const roads = parseRoads(JSON.parse(readFileSync(`${real}/roads.json`, 'utf8')));
    const tile = JSON.parse(readFileSync(`${real}/tile.json`, 'utf8'));
    const sp = tile.spawns;
    const slots = planParking(roads, { around: sp.player, avoid: [{ x: sp.vehicle.x, z: sp.vehicle.z, r: 9 }], count: 6 }, new Rng(1));
    expect(slots.length).toBe(6);
    const ids = new Set(slots.map((s) => s.roadId));
    expect(ids.size).toBeGreaterThanOrEqual(3);
    for (const s of slots) expect(Math.hypot(s.x - sp.player.x, s.z - sp.player.z)).toBeLessThan(141);
  });
});
