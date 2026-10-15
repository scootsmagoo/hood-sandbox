/**
 * Spike strips. A strip lies across a lane for `lifeS` seconds; a wheel of any car that is not
 * police that passes over it goes flat (`RaycastCar.deflate`: the wheel sits lower, grips less and
 * drags). The test is the wheel's path over the tick against the strip's rectangle (`crossesStrip`),
 * so no speed skips it. Spike strips are entities (`EntityKind.SpikeStrip`), so the client draws
 * them and the minimap can mark them.
 */
import { POLICE_RULES, atHeat } from '../../shared/policeRules';
import { SpikeStripEntity } from '../entities';
import type { Simulation } from '../Simulation';
import { crossesStrip } from './tactics';
import type { Roadblock } from './types';

export class SpikeStrips {
  readonly strips: SpikeStripEntity[] = [];
  /** Wheels flattened, for tests and the report. */
  flattened = 0;

  constructor(private readonly sim: Simulation) {}

  get count(): number {
    return this.strips.length;
  }

  private nextAt = 0;
  /** Off: no strips are laid on their own (scripted scenes and tests; `lay` still works). */
  enabled = true;

  /** Whether the heat allows another strip now. */
  private mayLay(): boolean {
    const sim = this.sim;
    const heat = sim.law.heat.level;
    const R = POLICE_RULES.spikes;
    return this.enabled && heat >= R.minHeat && !sim.police.standingDown && this.strips.length < atHeat(R.maxActive, heat) && sim.tick / 60 >= this.nextAt && sim.registry.size < 246;
  }

  /** Lays a strip across a road at (x, z) for a target travelling along (dirX, dirZ), if the heat and the timer allow. */
  layAcross(x: number, z: number, dirX: number, dirZ: number, width: number): SpikeStripEntity | null {
    if (!this.mayLay()) return null;
    const sim = this.sim;
    this.nextAt = sim.tick / 60 + atHeat(POLICE_RULES.spikes.intervalS, sim.law.heat.level);
    // The strip runs across the road: perpendicular to the direction of travel.
    const yaw = Math.atan2(dirZ, -dirX);
    return this.lay(x, z, yaw, Math.max(POLICE_RULES.spikes.lengthM, Math.min(width, 12)));
  }

  /** A strip in front of a roadblock, on the side the target comes from. */
  maybeLayBefore(b: Roadblock): void {
    const d = POLICE_RULES.spikes.beforeRoadblockM;
    const s = this.layAcross(b.x - b.dirX * d, b.z - b.dirZ * d, b.dirX, b.dirZ, b.width);
    if (s) b.stripId = s.id;
  }

  /** Lays a strip with its middle at (x, z), running along `yaw` (the direction of its length). */
  lay(x: number, z: number, yaw: number, length = POLICE_RULES.spikes.lengthM): SpikeStripEntity {
    const sim = this.sim;
    const reg = sim.registry;
    const s = reg.add(new SpikeStripEntity(reg.allocateId(), x, sim.groundAt(x, z), z, yaw, length, POLICE_RULES.spikes.depthM, POLICE_RULES.spikes.lifeS)) as SpikeStripEntity;
    this.strips.push(s);
    sim.announceEntity(s);
    sim.emit({ type: 'police:spikes', tick: sim.tick, id: s.id, x, z, yaw, length });
    return s;
  }

  remove(s: SpikeStripEntity) {
    const i = this.strips.indexOf(s);
    if (i >= 0) this.strips.splice(i, 1);
    this.sim.despawn(s.id);
    this.sim.emit({ type: 'police:spikes-clear', tick: this.sim.tick, id: s.id, used: s.used });
  }

  clearAll() {
    for (const s of [...this.strips]) this.remove(s);
  }

  update(dt: number) {
    if (this.strips.length === 0) return;
    const sim = this.sim;
    for (let i = this.strips.length - 1; i >= 0; i--) {
      const s = this.strips[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.remove(s);
        continue;
      }
      const reach = s.length / 2 + 8;
      for (const v of sim.vehicles()) {
        // Police are given a way round their own strips; a spline follower has no wheels on the road.
        if (v.police || v.kinematic || v.burnt) continue;
        const car = v.car;
        const t = car.body.translation();
        if (Math.abs(t.x - s.x) > reach || Math.abs(t.z - s.z) > reach) continue;
        const lv = car.body.linvel();
        for (let w = 0; w < 4; w++) {
          const wh = car.wheels[w];
          if (wh.flat >= 1 || !wh.grounded) continue;
          // Where the wheel touches the road now, and where it was one tick ago.
          const bx = wh.ox;
          const bz = wh.oz;
          const ax = bx - lv.x * dt;
          const az = bz - lv.z * dt;
          if (crossesStrip(s, ax, az, bx, bz) && car.deflate(w)) {
            s.used = true;
            this.flattened++;
            sim.emit({ type: 'vehicle:tyre', tick: sim.tick, vehicleId: v.id, wheel: w, shooterId: 0 });
          }
        }
      }
    }
  }
}
