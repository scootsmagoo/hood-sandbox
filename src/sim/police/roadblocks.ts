/**
 * Roadblocks. From heat 3, while the player is driving, the police lay two or three cars angled across
 * the road on the route the player is likely to take, 150 to 250 m ahead and out of view, with an
 * officer standing behind each car. Sometimes one opening is left to thread. At the same time a spike
 * strip may go down in front of it. The block stays until the player has passed it (then its officers
 * get back in their cars and join the chase), or its time runs out.
 *
 * Where: `PoliceManager.predicted()` (the route the player is on, from the lane graph or the road
 * centrelines), swept for a straight stretch of road clear of junctions and of traffic, hidden from the
 * player's camera, with room for the cars.
 */
import { HANDLING } from '../../shared/handling';
import { POLICE_RULES, atHeat } from '../../shared/policeRules';
import { quatFromYaw } from '../../shared/math';
import type { Rng } from '../../shared/rng';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import { agencyAt } from '../../shared/law';
import { pointAlong } from './nav';
import type { PoliceManager } from './PoliceSystem';
import { layoutRoadblock } from './tactics';
import type { Roadblock } from './types';

export class RoadblockDirector {
  readonly blocks: Roadblock[] = [];
  private nextAt = 0;
  private nextId = 1;
  /** Since when a laying has been wanted but no hidden site was found, s (sim time). */
  private waitFrom = -1;
  /** Blocks laid so far, for tests and the report. */
  laid = 0;
  /** Off: no new roadblocks (scripted scenes and tests that want one feature alone). */
  enabled = true;

  constructor(
    private readonly sim: Simulation,
    private readonly mgr: PoliceManager,
    private readonly rng: Rng,
  ) {}

  private get time(): number {
    return this.sim.tick / 60;
  }

  update() {
    const sim = this.sim;
    const R = POLICE_RULES.roadblock;
    const heat = sim.law.heat.level;
    const tgt = this.mgr.tgt;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      // Alive units only.
      b.unitIds = b.unitIds.filter((id) => this.mgr.units.some((u) => u.id === id));
      if (this.mgr.standingDown || b.unitIds.length === 0) {
        this.release(b, 'stand-down');
        this.blocks.splice(i, 1);
        continue;
      }
      if (b.passedAt === 0 && tgt && tgt.inCar) {
        const along = (tgt.x - b.x) * b.dirX + (tgt.z - b.z) * b.dirZ;
        const lateral = Math.abs((tgt.x - b.x) * b.dirZ - (tgt.z - b.z) * b.dirX);
        if (along > 10 && lateral < 40) b.passedAt = this.time;
      }
      const expired = this.time - b.t0 > R.lifeS && (!tgt || Math.hypot(tgt.x - b.x, tgt.z - b.z) > 100);
      if (b.passedAt > 0 || expired) {
        this.release(b, b.passedAt > 0 ? 'passed' : 'expired');
        this.blocks.splice(i, 1);
      }
    }
    if (!this.enabled || heat < R.minHeat || this.mgr.standingDown) return;
    if (this.blocks.length >= atHeat(R.maxActive, heat) || this.time < this.nextAt) return;
    if (!tgt || !tgt.inCar || tgt.speed < 6 || !tgt.live) return;
    if (sim.registry.size > 236) return;
    if (this.tryLay()) {
      this.nextAt = this.time + atHeat(R.intervalS, heat);
      this.waitFrom = -1;
    } else if (this.waitFrom < 0) this.waitFrom = this.time;
  }

  /** The officers get back in their cars and the cars become ordinary units of the chase. */
  private release(b: Roadblock, reason: 'passed' | 'expired' | 'stand-down') {
    for (const u of this.mgr.units) {
      if (u.block !== b) continue;
      u.block = null;
      // Back in the chase if the agency's table has room for the car; otherwise it goes home.
      if (this.mgr.overCap(u.agency)) u.mode = 'leave';
    }
    this.sim.emit({ type: 'police:roadblock-clear', tick: this.sim.tick, id: b.id, reason });
  }

  clearAll() {
    for (const b of this.blocks) this.release(b, 'stand-down');
    this.blocks.length = 0;
    this.waitFrom = -1;
  }

  private tryLay(): boolean {
    const sim = this.sim;
    const R = POLICE_RULES.roadblock;
    const m = this.mgr;
    const route = m.predicted();
    if (!route || route.length < R.distanceM[0] + 20) return false;
    const nav = m.nav;
    const patient = this.waitFrom >= 0 && this.time - this.waitFrom > 6;
    const lo = R.distanceM[0];
    const hi = Math.min(R.distanceM[1], route.length - 15);
    const span = Math.max(1, Math.floor((hi - lo) / 10));
    const first = this.rng.int(0, span);
    const heat = sim.law.heat.level;
    for (let k = 0; k <= span; k++) {
      const s = lo + ((first + k) % (span + 1)) * 10;
      const p = pointAlong(route, s);
      // Straight: the route does not bend within 20 m either side.
      const a = pointAlong(route, s - 20);
      const b = pointAlong(route, s + 20);
      if (a.dx * b.dx + a.dz * b.dz < 0.97) continue;
      const road = nav.roadAt(p.x, p.z, 12);
      if (!road || road.width < 5) continue;
      if (nav.nearJunction(road.x, road.z, 24)) continue;
      if (!m.siteFree(road.x, road.z, 16)) continue;
      const d = Math.hypot(road.x - m.playerEye().x, road.z - m.playerEye().z);
      if (!(m.hiddenPoint(road.x, road.z) || (patient && d > 185))) continue;
      // Oriented with the target's travel.
      let dx = road.dx;
      let dz = road.dz;
      if (dx * p.dx + dz * p.dz < 0) {
        dx = -dx;
        dz = -dz;
      }
      const width = Math.min(road.width, 22);
      const agency = agencyAt(sim.law.data, sim.tile.roads ?? [], road.x, road.z) ?? sim.law.data.agencies[0];
      const hand = HANDLING[agency.vehicle] ?? HANDLING.sedan;
      const carLen = hand.chassis.halfExtents[2] * 2;
      const carWid = hand.chassis.halfExtents[0] * 2;
      const wantGap = this.rng.chance(atHeat(R.gapChance, heat));
      const layout = layoutRoadblock(
        { x: road.x, z: road.z },
        { x: dx, z: dz },
        width,
        carLen,
        carWid,
        this.rng.int(R.cars[0], R.cars[1]),
        wantGap ? { width: R.gapWidthM, side: this.rng.chance(0.5) ? 1 : -1 } : null,
        this.rng,
      );
      if (!this.roomFor(layout.cars, hand.chassis.halfExtents)) continue;
      this.lay(layout, agency, road.x, road.z, dx, dz, width);
      return true;
    }
    return false;
  }

  /** No wall, kerb furniture or parked car where a car would stand. */
  private roomFor(cars: { x: number; z: number; yaw: number }[], half: number[]): boolean {
    const sim = this.sim;
    const shape = new sim.physics.R.Cuboid(half[0] + 0.1, 0.7, half[2] + 0.1);
    for (const c of cars) {
      const gy = sim.groundAt(c.x, c.z);
      if (sim.physics.world.intersectionWithShape({ x: c.x, y: gy + 1.05, z: c.z }, quatFromYaw(c.yaw), shape, undefined, GROUPS.actorQuery)) return false;
    }
    return true;
  }

  private lay(layout: ReturnType<typeof layoutRoadblock>, agency: import('../../shared/law').Agency, cx: number, cz: number, dx: number, dz: number, width: number) {
    const sim = this.sim;
    const block: Roadblock = {
      id: this.nextId++, x: cx, z: cz, dirX: dx, dirZ: dz, width, unitIds: [], t0: this.time, passedAt: 0,
      gap: layout.gap, stripId: 0,
    };
    const heat = sim.law.heat.level;
    const loadout = this.mgr.loadoutFor(agency, heat);
    layout.cars.forEach((c, i) => {
      const o = layout.officers[i];
      const u = this.mgr.spawnStatic(agency, loadout, c, o, block);
      block.unitIds.push(u.id);
    });
    this.blocks.push(block);
    this.laid++;
    sim.emit({ type: 'police:roadblock', tick: sim.tick, id: block.id, x: cx, z: cz, cars: layout.cars.length, gap: layout.gap ? layout.gap.width : 0, agency: agency.id });
    // A strip down in front of it (the target reaches it first), when the heat calls for them.
    this.mgr.spikes.maybeLayBefore(block);
  }
}
