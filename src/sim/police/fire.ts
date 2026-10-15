/**
 * Police gunfire. Officers on foot and passengers in a car fire at the player with their loadout's
 * weapon through the weapons API (`weaponsPort.ts`), with a reaction delay after they first see the
 * target, short bursts with a pause between, and an aim that gets worse with range and with how fast the
 * target is moving. They do not fire through a civilian (a ray and a distance test against everyone
 * standing in the line); a bystander just off the line is the risk they accept.
 *
 * When they may shoot: at heat 3 and above, or at once when the player has shot at them. The numbers
 * are in `data/police.json` ("fire").
 */
import { GROUPS } from '../physics/rapier';
import { loadoutFor, POLICE_RULES } from '../../shared/policeRules';
import type { PedEntity, VehicleEntity } from '../entities';
import type { Simulation } from '../Simulation';
import { aimPointOf, muzzleOf } from '../combat/weapons/api';
import { aimErrorDeg, civilianInLine, type Bystander } from './tactics';
import { armOfficer, readyFor, shoot, weaponInHand } from './weaponsPort';
import type { Rng } from '../../shared/rng';

/** Counters for tests and the report. */
export interface FireStats {
  shots: number;
  withheldCivilian: number;
  withheldWorld: number;
}

export class PoliceFire {
  /** The player has shot at police: every agency shoots back, whatever the heat. */
  firedOn = false;
  readonly stats: FireStats = { shots: 0, withheldCivilian: 0, withheldWorld: 0 };
  private readonly bystanders: Bystander[] = [];
  private bystanderTick = -1;

  constructor(
    private readonly sim: Simulation,
    private readonly rng: Rng,
  ) {}

  reset() {
    this.firedOn = false;
  }

  /** Whether officers may shoot at the player now. */
  mayShoot(): boolean {
    const heat = this.sim.law.heat.level;
    return heat > 0 && (heat >= POLICE_RULES.fire.minHeat || this.firedOn);
  }

  arm(officer: PedEntity, loadout: string) {
    armOfficer(officer, loadout);
  }

  /** Everyone a bullet must not go through: living people who are neither police nor the player. Rebuilt once a tick. */
  private civilians(): Bystander[] {
    if (this.bystanderTick === this.sim.tick) return this.bystanders;
    this.bystanderTick = this.sim.tick;
    this.bystanders.length = 0;
    for (const p of this.sim.peds()) {
      if (p.role !== 'civilian' || p.life === 'dead') continue;
      const c = p.controller;
      this.bystanders.push({ id: p.id, x: c.x, y: c.y, z: c.z });
    }
    return this.bystanders;
  }

  /** Whether a ray from the muzzle to the target reaches it: not a wall, not another car (the shooter's own car and the target's do not count). */
  private lineReaches(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, shooterCar: number, targetCar: number): 'ok' | 'world' | 'car' {
    const R = this.sim.physics.R;
    const world = this.sim.physics.world;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return 'ok';
    const ray = new R.Ray(from, { x: dx / d, y: dy / d, z: dz / d });
    const skip = new Set<number>();
    for (const id of [shooterCar, targetCar]) {
      const v = id ? (this.sim.registry.get(id) as VehicleEntity | undefined) : undefined;
      if (v) skip.add(v.car.body.handle);
    }
    const hit = world.castRay(ray, d - 0.2, true, undefined, GROUPS.actorQuery, undefined, undefined, (c) => !skip.has(c.parent()?.handle ?? -1));
    if (!hit) return 'ok';
    const body = hit.collider.parent();
    for (const v of this.sim.vehicles()) if (body && v.car.body.handle === body.handle) return 'car';
    return 'world';
  }

  /**
   * One officer's trigger discipline for this tick. `sees` says they have the target in sight; `moving`
   * whether they (or their car) are travelling (a drive-by shoots worse). Returns true when a shot left.
   */
  officerFire(o: PedEntity, player: PedEntity, dt: number, drivingBy: boolean, carSpeed: number): boolean {
    const st = o.officer!;
    const f = st.fire;
    const sim = this.sim;
    st.fireT = Math.max(0, st.fireT - dt);
    if (!this.mayShoot() || !o.gun || o.life !== 'alive' || player.life !== 'alive' || sim.lifeOf(1).mode !== 'alive') {
      f.seenT = 0;
      f.burstLeft = 0;
      f.why = 'not allowed';
      return false;
    }
    const lo = loadoutFor(weaponInHand(o) ?? st.loadout);
    const tgtVeh = player.vehicleId ? (sim.registry.get(player.vehicleId) as VehicleEntity | undefined) : undefined;
    const target = tgtVeh ?? player;
    const aim = aimPointOf(sim, target);
    const c = o.controller;
    const range = Math.hypot(aim.x - c.x, aim.z - c.z);
    const speed = tgtVeh ? Math.hypot(tgtVeh.car.body.linvel().x, tgtVeh.car.body.linvel().z) : Math.hypot(player.controller.vel.x, player.controller.vel.z);
    const rangeMax = lo.rangeM;
    if (!st.sees || range > rangeMax || (drivingBy && !readyFor(sim, o, true))) {
      f.seenT = Math.max(0, f.seenT - dt * 2);
      f.burstLeft = 0;
      f.why = !st.sees ? 'no sight' : range > rangeMax ? 'range' : 'no driveby weapon';
      return false;
    }
    if (!drivingBy && o.vehicleId) readyFor(sim, o, true);
    f.seenT += dt;
    if (f.seenT < f.reactS) {
      f.why = 'reacting';
      return false;
    }
    if (f.pauseT > 0) {
      f.pauseT -= dt;
      f.why = 'pause';
      return false;
    }
    // The line: no civilian between, no car, no wall.
    const m = muzzleOf(sim, o);
    const blocker = civilianInLine(m, aim, this.civilians(), POLICE_RULES.fire.blockMarginM);
    if (blocker !== null) {
      this.stats.withheldCivilian++;
      f.why = `civilian ${blocker} in line`;
      return false;
    }
    const line = this.lineReaches(m, aim, o.vehicleId, player.vehicleId);
    if (line !== 'ok') {
      if (line === 'world') this.stats.withheldWorld++;
      else this.stats.withheldCivilian++;
      f.why = line === 'world' ? 'wall in line' : 'car in line';
      return false;
    }
    if (f.burstLeft <= 0) f.burstLeft = this.rng.int(lo.burst[0], lo.burst[1]);
    // How wide the shot is thrown: the officer's own error, bigger for a drive-by and for a faster target.
    const cone = aimErrorDeg({ loadout: lo, range, targetSpeed: speed, drivingBy: drivingBy && carSpeed > 3, rules: POLICE_RULES.fire });
    const shot = shoot(sim, o, target, cone);
    if (!shot) {
      f.why = 'unarmed';
      return false;
    }
    if (shot.status === 'fired') {
      this.stats.shots++;
      st.fireT = 0.18;
      f.burstLeft--;
      f.why = 'fired';
      if (f.burstLeft <= 0) f.pauseT = this.rng.range(lo.pauseS[0], lo.pauseS[1]);
      sim.emit({
        type: 'police:fire', tick: sim.tick, officerId: o.id, weapon: shot.weapon, x: shot.muzzle.x, y: shot.muzzle.y, z: shot.muzzle.z,
        dx: shot.dir.x, dy: shot.dir.y, dz: shot.dir.z, targetId: target.id, passenger: !!o.vehicleId,
      });
      return true;
    }
    f.why = shot.status;
    return false;
  }

  /** A fresh sighting redraws the reaction time. */
  newSighting(o: PedEntity) {
    const f = o.officer!.fire;
    f.seenT = 0;
    f.reactS = this.rng.range(POLICE_RULES.fire.reactionS[0], POLICE_RULES.fire.reactionS[1]);
  }
}
