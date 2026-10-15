/**
 * Police helicopters. From heat 3 one comes (two from heat 5): it flies in, then orbits the target at
 * 60 to 90 m, or sweeps the search area when it has lost them. It is a kinematic entity, not physics:
 * it cannot be shot down or hit. It sees through a cone that opens downward (`coneHalfDeg`); a clear
 * line to the target and the target inside the cone make the stars solid, whoever else is looking.
 * At night the cone shrinks to the searchlight and the street lamps (`nightSightScale`), and the
 * searchlight flag goes up for the client to draw.
 */
import { nightFactor } from '../../shared/daylight';
import { clamp, wrapAngle } from '../../shared/math';
import { POLICE_RULES, atHeat, heliFootprint } from '../../shared/policeRules';
import type { Rng } from '../../shared/rng';
import { HelicopterEntity } from '../entities';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import { inHeliCone, stepHeli, type HeliBody, type HeliGoal } from './tactics';

interface Brain {
  angle: number;
  dir: 1 | -1;
  radius: number;
  altitude: number;
  sightIn: number;
  roofIn: number;
  roofY: number;
  age: number;
  /** Time since it last saw the target, s. */
  lostT: number;
}

export class HelicopterDirector {
  readonly helis: HelicopterEntity[] = [];
  private readonly brains = new Map<number, Brain>();
  private nextAt = 0;
  /** When the heat first reached the helicopter's level the dispatch took this long to put one up; the time it comes (sim s), or -1 while the heat is below that level. */
  private comesAt = -1;
  /** True when any helicopter has the player in its cone and a clear line. */
  sees = false;
  /** Off: none comes (scripted scenes and tests that want one feature alone). */
  enabled = true;

  constructor(
    private readonly sim: Simulation,
    private readonly rng: Rng,
    private readonly paint: () => { agency: string; color: number },
  ) {}

  get count(): number {
    return this.helis.length;
  }

  /** Helicopters up that are not leaving. */
  get active(): number {
    return this.helis.filter((h) => !h.leaving).length;
  }

  private wanted(): number {
    const sim = this.sim;
    const heat = sim.law.heat.level;
    if (!this.enabled || heat < POLICE_RULES.helicopter.minHeat || sim.police.standingDown) {
      this.comesAt = -1;
      return 0;
    }
    // Not instantly: the air unit is scrambled when the heat reaches its level and takes about 30 s.
    const time = sim.tick / 60;
    if (this.comesAt < 0) {
      const d = POLICE_RULES.helicopter.delayS;
      this.comesAt = time + this.rng.range(d[0], d[1]);
    }
    return time >= this.comesAt ? atHeat(POLICE_RULES.helicopter.count, heat) : 0;
  }

  update(dt: number) {
    const sim = this.sim;
    const want = this.wanted();
    const time = sim.tick / 60;
    if (this.active < want && time >= this.nextAt && sim.registry.size < 250) {
      this.spawn();
      this.nextAt = time + POLICE_RULES.helicopter.respawnS;
    }
    // Too many (the heat dropped), or none wanted: send the extra ones away.
    let excess = this.active - want;
    for (let i = this.helis.length - 1; i >= 0 && excess > 0; i--) {
      const h = this.helis[i];
      if (!h.leaving) {
        h.leaving = true;
        excess--;
        sim.emit({ type: 'police:helicopter', tick: sim.tick, heliId: h.id, state: 'leaving' });
      }
    }
    const night = nightFactor(sim.clock.minutes);
    let any = false;
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      const b = this.brains.get(h.id)!;
      b.age += dt;
      this.step(h, b, dt, night);
      if (h.sees) any = true;
      if (h.leaving) {
        const p = sim.playerPosition();
        if (Math.hypot(h.x - p.x, h.z - p.z) > 520 || b.age > 400) this.remove(h);
      }
    }
    this.sees = any;
  }

  private spawn() {
    const sim = this.sim;
    const p = sim.playerPosition();
    const a = this.rng.range(0, Math.PI * 2);
    const dist = this.rng.range(320, 420);
    const x = p.x + Math.sin(a) * dist;
    const z = p.z + Math.cos(a) * dist;
    const alt = this.rng.range(POLICE_RULES.helicopter.altitudeM[0], POLICE_RULES.helicopter.altitudeM[1]);
    const reg = sim.registry;
    const { agency, color } = this.paint();
    const h = reg.add(new HelicopterEntity(reg.allocateId(), agency, color)) as HelicopterEntity;
    h.x = x;
    h.z = z;
    h.y = sim.groundAt(x, z) + alt + 40;
    h.yaw = Math.atan2(p.x - x, p.z - z);
    const idx = this.helis.length;
    this.helis.push(h);
    this.brains.set(h.id, {
      angle: this.rng.range(0, Math.PI * 2),
      dir: idx % 2 === 0 ? 1 : -1,
      radius: this.rng.range(POLICE_RULES.helicopter.orbitRadiusM[0], POLICE_RULES.helicopter.orbitRadiusM[1]),
      altitude: alt,
      sightIn: 0,
      roofIn: 0,
      roofY: -1e9,
      age: 0,
      lostT: 99,
    });
    sim.announceEntity(h);
    sim.emit({ type: 'police:helicopter', tick: sim.tick, heliId: h.id, state: 'inbound' });
  }

  private remove(h: HelicopterEntity) {
    const i = this.helis.indexOf(h);
    if (i >= 0) this.helis.splice(i, 1);
    this.brains.delete(h.id);
    this.sim.despawn(h.id);
  }

  clearAll() {
    for (const h of [...this.helis]) this.remove(h);
    this.sees = false;
    this.comesAt = -1;
  }

  /** The tallest roof under the helicopter and a little ahead of it. */
  private roofBelow(h: HelicopterEntity): number {
    const R = this.sim.physics.R;
    const world = this.sim.physics.world;
    let top = -1e9;
    for (const k of [0, 1.5, 3]) {
      const x = h.x + h.vx * k;
      const z = h.z + h.vz * k;
      const g = this.sim.groundAt(x, z);
      const hit = world.castRay(new R.Ray({ x, y: g + 520, z }, { x: 0, y: -1, z: 0 }), 560, true, undefined, GROUPS.cameraQuery);
      top = Math.max(top, hit ? g + 520 - hit.timeOfImpact : g);
    }
    return top;
  }

  private step(h: HelicopterEntity, b: Brain, dt: number, night: number) {
    const sim = this.sim;
    const H = POLICE_RULES.helicopter;
    const heat = sim.law.heat;
    const p = sim.playerPosition();
    const ground = sim.groundAt(h.x, h.z);
    if (b.roofIn <= 0) {
      b.roofY = this.roofBelow(h);
      b.roofIn = 0.25;
    }
    b.roofIn -= dt;

    // Where to be: over the player when it sees them, over the search area when not, away when sent off.
    let gx = p.x;
    let gz = p.z;
    let radius = b.radius;
    let speed = H.speed;
    if (h.leaving) {
      const a = Math.atan2(h.x - p.x, h.z - p.z);
      gx = h.x + Math.sin(a) * 800;
      gz = h.z + Math.cos(a) * 800;
      radius = 0;
    } else if (!h.sees && heat.lastKnown) {
      // Sweep the search area: a slow circle round where a car lost at that speed would be by now.
      const sr = Math.max(30, heat.searchRadius * 0.4);
      const c = sim.police.searchCentre() ?? heat.lastKnown;
      gx = c.x;
      gz = c.z;
      radius = Math.min(sr, 110);
      speed = H.speed;
    } else if (heat.lastKnown && !sim.police.seesPlayer) {
      gx = heat.lastKnown.x;
      gz = heat.lastKnown.z;
    }
    // It circles close enough to keep the target inside its cone: at night the cone is the searchlight, so tighter.
    if (!h.leaving && (h.sees || sim.police.seesPlayer)) {
      const scale = 1 - clamp(night, 0, 1) * (1 - H.nightSightScale);
      radius = Math.min(radius, Math.max(8, heliFootprint(Math.max(20, h.y - ground)) * scale * 0.5));
    }
    // Orbit: tangential speed about 14 m/s.
    b.angle = wrapAngle(b.angle + b.dir * (14 / Math.max(20, radius || 20)) * dt);
    const body: HeliBody = h;
    const goal: HeliGoal = { x: gx, z: gz, altitude: b.altitude, groundY: ground, roofY: b.roofY, radius, angle: b.angle };
    stepHeli(body, goal, speed * (h.leaving ? 1.1 : 1), H.accel, dt);
    h.agl = h.y - ground;
    h.rotor = Math.min(1, h.rotor + dt * 0.8);
    h.searchlight = night >= H.searchlightNight;

    // Sight.
    b.sightIn -= dt;
    if (b.sightIn <= 0) {
      b.sightIn = 0.15 + (h.id % 4) * 0.01;
      const live = sim.lifeOf(1).mode === 'alive' && heat.level > 0 && !h.leaving;
      const eye = sim.police.playerEye();
      const scale = 1 - clamp(night, 0, 1) * (1 - H.nightSightScale);
      let sees = false;
      if (live && inHeliCone({ hx: h.x, hy: h.y, hz: h.z, tx: eye.x, ty: eye.y, tz: eye.z, coneHalf: (H.coneHalfDeg * Math.PI) / 180, range: H.rangeM, scale })) {
        sees = sim.law.clearLine({ x: h.x, y: h.y - 1.5, z: h.z }, eye);
      }
      if (sees !== h.sees) {
        h.sees = sees;
        sim.emit({ type: 'police:helicopter', tick: sim.tick, heliId: h.id, state: sees ? 'sees' : 'lost' });
      }
      h.footprint = heliFootprint(Math.max(0, h.agl)) * scale;
    }
    if (h.sees) b.lostT = 0;
    else b.lostT += dt;
  }
}
