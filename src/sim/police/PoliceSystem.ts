/**
 * The first police response. Units are a car and an officer. They are sent by the dispatch tables
 * of the city pack, appear out of the player's view on the road network, and drive to where the
 * police believe the player is (the crime scene, then the last place they saw them). A unit that may
 * chase a car does; one that may not (a restrictive agency, for a minor crime) gathers at the scene,
 * and gets out to chase on foot if the player is on foot. Officers on foot run at the player and arrest
 * them if they stand still within reach for two seconds.
 *
 * Seeing is a cone plus a clear line (a ray against the static world). It feeds the heat model: any
 * officer who sees the player makes the stars solid, and when none does they flash.
 */
import { LAW_RULES, type Agency } from '../../shared/law';
import type { EntityId } from '../../shared/entities';
import { HANDLING } from '../../shared/handling';
import { rotateVec, wrapAngle, yawFromDir } from '../../shared/math';
import { Axis } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { AI_OWNER, PedEntity, VehicleEntity } from '../entities';
import { leaveVehicle } from '../exit';
import { chooseSeekHeading } from '../npc/seek';
import { probeFrom } from '../npc/probe';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';
import { steerLock } from '../vehicles/dynamics';
import { agenciesWanting, mayPursueVehicle, ordersAt, type DispatchOrder } from './dispatch';
import { GOVERNOR, PathFollower, governSpeed, lookaheadDistance, pedalsFor, pursuitAngle, steerCommand, type GovernorOptions } from './pursuit';
import { RoadGraph, type PathPoint, type SamplePoint } from './roadGraph';
import type { OfficerState } from './types';

export const POLICE = {
  /** Spawn ring around the player, m. */
  spawnMin: 120,
  spawnMax: 200,
  /** A spawn must be at least this far from the player and out of the camera's view. */
  hiddenMin: 100,
  cameraHalfFov: (62 * Math.PI) / 180,
  /** An officer within this range of a player who stands still arrests them after `arrestS`. */
  arrestRange: 1.5,
  arrestS: 2,
  /** The player counts as resisting at or above this speed, m/s. */
  resistSpeed: 2,
  /** Driving speeds, m/s. */
  respondSpeed: 17,
  pursueSpeed: 23,
  loiterSpeed: 7,
  leaveSpeed: 14,
  /** An officer gets out within this of a player on foot, m. */
  dismountRange: 22,
  /** Dispatch is checked this often, s. */
  dispatchEvery: 0.5,
  /** Units that stood down despawn beyond this distance, m, or after this long, s. */
  leaveDespawnDist: 130,
  leaveDespawnS: 45,
  maxUnits: 8,
} as const;

type UnitMode = 'drive' | 'loiter' | 'leave';

export interface Unit {
  id: number;
  agency: Agency;
  vehicleId: EntityId;
  officerIds: EntityId[];
  mode: UnitMode;
  follower: PathFollower | null;
  /** What the route was planned to reach, and how old it is. */
  routeTo: PathPoint | null;
  routeAge: number;
  stuckT: number;
  reverseT: number;
  reverseSteer: number;
  loiterGoal: PathPoint | null;
  loiterWait: number;
  leaveT: number;
  /** Seconds the car has spent within reach of where it was sent. */
  arrivedT: number;
  /** Failed back-outs in a row, and the time left in which it pushes through whatever is in the way. */
  stuckCycles: number;
  ramT: number;
}

const hex = (s: string) => parseInt(s.replace('#', ''), 16) || 0;
const tmpPedals = { throttle: 0, brake: 0 };

export class PoliceManager {
  readonly graph: RoadGraph;
  readonly units: Unit[] = [];
  /** True when any officer sees the player (updated every few ticks). */
  seesPlayer = false;
  standingDown = false;
  private readonly rng: Rng;
  private readonly nextAt = new Map<string, number>();
  private dispatchClock = 0;
  private nextUnitId = 1;
  private readonly governor: GovernorOptions = { ...GOVERNOR };

  constructor(private readonly sim: Simulation) {
    this.graph = new RoadGraph(sim.tile.roads ?? []);
    this.rng = sim.rng.fork('police');
  }

  private get time(): number {
    return this.sim.tick / 60;
  }

  // ---------------------------------------------------------------------------------------------
  // Seeing

  /** Whether an officer can see a point: inside the range, in front of them or very close, and with a clear line. */
  canSee(officer: PedEntity, tx: number, ty: number, tz: number, range = LAW_RULES.visionRangeM): boolean {
    const c = officer.controller;
    const dx = tx - c.x;
    const dz = tz - c.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > LAW_RULES.closeSenseM) {
      const veh = officer.vehicleId ? (this.sim.registry.get(officer.vehicleId) as VehicleEntity | undefined) : undefined;
      const yaw = veh ? veh.car.yaw : c.yaw;
      // Inside a car they can turn their head: a wider view than the windscreen's.
      const half = (LAW_RULES.visionHalfAngleDeg * (veh ? 1.45 : 1) * Math.PI) / 180;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > half) return false;
    }
    return this.sim.law.clearLine({ x: c.x, y: c.y + 1.5, z: c.z }, { x: tx, y: ty, z: tz });
  }

  private playerEye() {
    const ped = this.sim.registry.get(this.sim.playerPedId) as PedEntity;
    const c = ped.controller;
    return { ped, x: c.x, y: c.y + (ped.vehicleId ? 1.2 : 1.4), z: c.z };
  }

  private vision(dt: number) {
    const { ped, x, y, z } = this.playerEye();
    const live = ped.life !== 'dead' && this.sim.lifeOf(1).mode === 'alive';
    let any = false;
    for (const u of this.units) {
      for (const id of u.officerIds) {
        const o = this.sim.registry.get(id) as PedEntity | undefined;
        if (!o || !o.officer || o.life !== 'alive') continue;
        const st = o.officer;
        st.senseIn -= dt;
        if (st.senseIn <= 0) {
          st.senseIn = 0.1 + (id % 5) * 0.004;
          st.sees = live && this.canSee(o, x, y, z);
        }
        st.unseenT = st.sees ? 0 : st.unseenT + dt;
        any ||= st.sees;
      }
    }
    this.seesPlayer = any;
  }

  // ---------------------------------------------------------------------------------------------
  // Dispatch

  private liveUnits(agency: string): number {
    let n = 0;
    for (const u of this.units) if (u.agency.id === agency && this.hasLiveOfficer(u)) n++;
    return n;
  }

  private hasLiveOfficer(u: Unit): boolean {
    return u.officerIds.some((id) => (this.sim.registry.get(id) as PedEntity | undefined)?.life === 'alive');
  }

  private dispatch(dt: number) {
    const sim = this.sim;
    const heat = sim.law.heat;
    if (heat.level === 0 || this.standingDown || this.graph.empty) return;
    this.dispatchClock += dt;
    if (this.dispatchClock < POLICE.dispatchEvery) return;
    this.dispatchClock = 0;
    if (this.units.length >= POLICE.maxUnits) return;

    const counts = new Map<string, number>();
    for (const a of sim.law.data.agencies) counts.set(a.id, this.liveUnits(a.id));
    const wanting = agenciesWanting(sim.law.data, heat.level, { nextAt: this.nextAt, counts }, this.time);
    if (wanting.length === 0) return;

    const { x: px, z: pz } = this.playerEye();
    const camYaw = sim.players.get(1)?.axes[Axis.Yaw] ?? 0;
    const eye = this.playerEye();
    const spot = this.graph.pickAround(this.rng, px, pz, POLICE.spawnMin, POLICE.spawnMax, (p) => this.hidden(p, px, pz, camYaw, eye));
    if (!spot) return;
    const orders = ordersAt(sim.law.data, sim.tile.roads ?? [], spot.x, spot.z, wanting);
    for (const order of orders) {
      for (let i = 0; i < order.units; i++) this.spawnUnit(spot, order, px, pz);
      this.nextAt.set(order.agency.id, this.time + order.row.spawnIntervalS);
    }
  }

  /** A road point the player cannot see, and nothing stands on. */
  private hidden(p: SamplePoint, px: number, pz: number, camYaw: number, eye: { x: number; y: number; z: number }): boolean {
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d < POLICE.hiddenMin) return false;
    // The camera looks along (-sin yaw, -cos yaw).
    const ang = Math.abs(wrapAngle(Math.atan2(p.x - px, p.z - pz) - (camYaw + Math.PI)));
    if (ang < POLICE.cameraHalfFov) {
      const gy = this.sim.groundAt(p.x, p.z);
      if (this.sim.law.clearLine({ x: p.x, y: gy + 1.5, z: p.z }, eye)) return false;
    }
    for (const v of this.sim.vehicles()) {
      const q = v.car.pose();
      if (Math.hypot(q.x - p.x, q.z - p.z) < 9) return false;
    }
    return true;
  }

  private spawnUnit(spot: SamplePoint, order: DispatchOrder, px: number, pz: number) {
    const sim = this.sim;
    const edge = this.graph.edges[spot.edge];
    // Face along the road, toward the player where the street runs both ways.
    let dx = spot.dx;
    let dz = spot.dz;
    if (!edge.oneway && dx * (px - spot.x) + dz * (pz - spot.z) < 0) {
      dx = -dx;
      dz = -dz;
    }
    const agency = order.agency;
    const typeId = HANDLING[agency.vehicle] ? agency.vehicle : 'sedan';
    const gy = sim.groundAt(spot.x, spot.z);
    const yaw = yawFromDir(dx, dz);
    const livery = { agency: agency.id, body: hex(agency.livery.body), stripe: hex(agency.livery.stripe), lightbar: [hex(agency.livery.lightbar[0]), hex(agency.livery.lightbar[1])] as [number, number] };
    const veh = sim.spawnVehicle(typeId, spot.x, gy, spot.z, yaw, livery.body, (v) => {
      v.police = livery;
      v.lightbar = true;
      v.owner = AI_OWNER;
    });
    const p = veh.car.pose();
    const officer = sim.addPed(p.x, p.y, p.z, yaw, 0, false, (o) => {
      o.role = 'police';
      o.officer = this.newOfficer(agency, hex(agency.livery.body), veh.id);
    });
    officer.controller.setEnabled(false);
    officer.vehicleId = veh.id;
    veh.occupantId = officer.id;
    const unit: Unit = {
      id: this.nextUnitId++, agency, vehicleId: veh.id, officerIds: [officer.id], mode: 'drive',
      follower: null, routeTo: null, routeAge: 99, stuckT: 0, reverseT: 0, reverseSteer: 0,
      loiterGoal: null, loiterWait: 0, leaveT: 0, arrivedT: 0, stuckCycles: 0, ramT: 0,
    };
    officer.officer!.unitId = unit.id;
    this.units.push(unit);
    sim.emit({ type: 'police:spawn', tick: sim.tick, vehicleId: veh.id, officerIds: [officer.id], agency: agency.id });
  }

  private newOfficer(agency: Agency, uniform: number, vehicleId: EntityId): OfficerState {
    return { agency: agency.id, unitId: 0, mode: 'seated', vehicleId, arrestT: 0, goal: null, goalT: 0, unseenT: 99, senseIn: 0, sees: false, uniform };
  }

  // ---------------------------------------------------------------------------------------------
  // Standing down

  standDown() {
    if (this.standingDown || this.units.length === 0) return;
    this.standingDown = true;
    for (const u of this.units) {
      u.mode = 'leave';
      u.follower = null;
      u.routeAge = 99;
    }
    this.sim.emit({ type: 'police:stand-down', tick: this.sim.tick });
  }

  /** Removes everything police at once (a respawn after being wasted or busted). */
  clearAll() {
    for (const u of this.units) this.despawnUnit(u);
    this.units.length = 0;
    this.standingDown = false;
    this.seesPlayer = false;
  }

  private despawnUnit(u: Unit) {
    this.sim.despawn(u.vehicleId);
    for (const id of u.officerIds) this.sim.despawn(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Per-tick

  update(dt: number) {
    const sim = this.sim;
    const heat = sim.law.heat;
    if (heat.level > 0) this.standingDown = false;
    else if (this.units.length > 0) this.standDown();

    this.vision(dt);
    this.dispatch(dt);

    const player = sim.registry.get(sim.playerPedId) as PedEntity;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const veh = sim.registry.get(u.vehicleId) as VehicleEntity | undefined;
      const officers = u.officerIds.map((id) => sim.registry.get(id) as PedEntity | undefined).filter((o): o is PedEntity => !!o);
      if (!veh && officers.length === 0) {
        this.units.splice(i, 1);
        continue;
      }
      if (u.mode === 'leave') {
        u.leaveT += dt;
        if (this.shouldVanish(u, veh, officers, player)) {
          this.despawnUnit(u);
          this.units.splice(i, 1);
          continue;
        }
      }
      for (const o of officers) if (o.life === 'alive' && o.officer) this.officerThink(u, o, veh, player, dt);
      if (veh) this.driveCar(u, veh, player, dt);
    }
    this.arrests(player, dt);
  }

  private shouldVanish(u: Unit, veh: VehicleEntity | undefined, officers: PedEntity[], player: PedEntity): boolean {
    const pc = player.controller;
    const ref = veh ? veh.car.pose() : officers[0]?.controller;
    if (!ref) return true;
    const d = Math.hypot(ref.x - pc.x, ref.z - pc.z);
    return d > POLICE.leaveDespawnDist || u.leaveT > POLICE.leaveDespawnS;
  }

  // ---------------------------------------------------------------------------------------------
  // Officers

  /** Where officers and cars aim: the player when in sight, otherwise where the police believe they are. */
  private target(): { x: number; z: number; live: boolean } | null {
    const heat = this.sim.law.heat;
    const lk = heat.lastKnown;
    if (this.seesPlayer) {
      const { x, z } = this.playerEye();
      return { x, z, live: true };
    }
    return lk ? { x: lk.x, z: lk.z, live: false } : null;
  }

  private chases(u: Unit, player: PedEntity): boolean {
    return !player.vehicleId || mayPursueVehicle(u.agency, this.sim.law.heat.severity);
  }

  private officerThink(u: Unit, o: PedEntity, veh: VehicleEntity | undefined, player: PedEntity, dt: number) {
    const st = o.officer!;
    const sim = this.sim;
    const c = o.controller;
    const i = o.input;
    i.moveX = i.moveY = 0;
    i.sprint = i.jump = false;
    const pc = player.controller;
    const target = this.target();

    if (st.mode === 'seated') {
      if (!veh) return;
      const car = veh.car;
      const dPlayer = Math.hypot(car.pose().x - pc.x, car.pose().z - pc.z);
      const slow = car.speed < 7;
      // The player is on foot nearby, and in sight (or the unit has reached the place and found them): get out and chase.
      const heatOn = sim.law.heat.level > 0 && !this.standingDown;
      if (heatOn && !player.vehicleId && slow && dPlayer < POLICE.dismountRange && (st.sees || this.seesPlayer)) this.dismount(o, veh);
      // Arrived at the scene on a restrictive call, nobody in sight: look around on foot.
      else if (heatOn && !player.vehicleId && slow && u.arrivedT > 1.2) this.dismount(o, veh);
      // The player is in the car and this unit has no reason to hold back: nothing to do on foot.
      return;
    }

    if (st.mode === 'leave' || this.standingDown) {
      st.mode = 'remount';
    }
    if (st.mode === 'remount') {
      // Back to the car: enter it when near.
      if (!veh || veh.occupantId || veh.burnt || veh.engineDead) {
        st.mode = 'search';
      } else {
        const p = veh.car.pose();
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < 2.4) {
          o.vehicleId = veh.id;
          veh.occupantId = o.id;
          c.setEnabled(false);
          st.mode = 'seated';
          st.arrestT = 0;
          sim.emit({ type: 'vehicle:enter', tick: sim.tick, pedId: o.id, vehicleId: veh.id });
          return;
        }
        this.walkToward(o, p.x, p.z, d > 14);
        return;
      }
    }

    // Want back in a car because the player is driving and this agency will chase them.
    if (veh && !veh.occupantId && !veh.burnt && !veh.engineDead && player.vehicleId && this.chases(u, player) && sim.law.heat.level > 0) {
      const p = veh.car.pose();
      if (Math.hypot(p.x - c.x, p.z - c.z) < 45) {
        st.mode = 'remount';
        return;
      }
    }

    // On foot: run at the player if seen, else go where they were last known and look around.
    if (st.sees || (this.seesPlayer && target?.live)) {
      st.mode = 'chase';
      const d = Math.hypot(pc.x - c.x, pc.z - c.z);
      c.yaw = d > 0.3 ? Math.atan2(pc.x - c.x, pc.z - c.z) : c.yaw;
      if (d > POLICE.arrestRange * 0.8) this.walkToward(o, pc.x, pc.z, d > 14);
      return;
    }
    st.mode = 'search';
    const lk = sim.law.heat.lastKnown ?? sim.law.heat.anchor;
    if (!lk) return;
    st.goalT -= dt;
    if (!st.goal || st.goalT <= 0 || Math.hypot(st.goal.x - c.x, st.goal.z - c.z) < 1.5) {
      // First to the place they were sent to, then around it.
      const first = !st.goal;
      const a = this.rng.range(0, Math.PI * 2);
      const r = first ? 0 : this.rng.range(0, 22);
      st.goal = { x: lk.x + Math.sin(a) * r, z: lk.z + Math.cos(a) * r };
      st.goalT = this.rng.range(4, 8);
    }
    const far = Math.hypot(lk.x - c.x, lk.z - c.z) > 40;
    this.walkToward(o, st.goal.x, st.goal.z, far);
  }

  private walkToward(o: PedEntity, tx: number, tz: number, sprint: boolean) {
    const c = o.controller;
    const h = chooseSeekHeading(c.x, c.z, tx, tz, null, probeFrom(this.sim, c.x, c.y, c.z));
    o.input.moveY = 1;
    // The camera-relative controller faces (-sin yaw, -cos yaw): aim it down the wanted heading.
    o.input.camYaw = Math.atan2(-Math.sin(h.heading), -Math.cos(h.heading));
    o.input.sprint = sprint;
  }

  private dismount(o: PedEntity, veh: VehicleEntity) {
    if (!leaveVehicle(this.sim, o, veh)) return;
    veh.owner = AI_OWNER;
    veh.input.throttle = 0;
    veh.input.brake = 0;
    const st = o.officer!;
    st.mode = 'chase';
    st.goal = null;
    this.sim.emit({ type: 'police:dismount', tick: this.sim.tick, pedId: o.id, vehicleId: veh.id });
  }

  private arrests(player: PedEntity, dt: number) {
    const sim = this.sim;
    const life = sim.lifeOf(1);
    const pc = player.controller;
    const speed = Math.hypot(pc.vel.x, pc.vel.z);
    const resisting = speed >= POLICE.resistSpeed || !!player.melee || pc.vy > 1;
    for (const u of this.units) {
      for (const id of u.officerIds) {
        const o = sim.registry.get(id) as PedEntity | undefined;
        if (!o?.officer) continue;
        const st = o.officer;
        if (o.life !== 'alive' || o.vehicleId || player.vehicleId || player.life !== 'alive' || life.mode !== 'alive' || sim.law.heat.level === 0) {
          st.arrestT = 0;
          continue;
        }
        const c = o.controller;
        const near = Math.hypot(c.x - pc.x, c.z - pc.z) <= POLICE.arrestRange && Math.abs(c.y - pc.y) < 1.5;
        if (near && !resisting) {
          st.arrestT += dt;
          if (st.arrestT >= POLICE.arrestS) {
            st.arrestT = 0;
            sim.beginBusted(1, o.id);
            return;
          }
        } else st.arrestT = Math.max(0, st.arrestT - dt * 2);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Cars

  private driveCar(u: Unit, veh: VehicleEntity, player: PedEntity, dt: number) {
    const sim = this.sim;
    const input = veh.input;
    // Someone else has taken the car (the player stole it): it is theirs to drive now.
    if (veh.owner !== AI_OWNER) {
      veh.lightbar = false;
      return;
    }
    const driver = veh.occupantId ? (sim.registry.get(veh.occupantId) as PedEntity | undefined) : undefined;
    const car = veh.car;
    veh.lightbar = !veh.burnt && sim.law.heat.level > 0 && !(this.standingDown && u.leaveT > 12);
    if (!driver || driver.role !== 'police' || driver.life !== 'alive' || veh.engineDead || veh.burnt) {
      input.throttle = 0;
      input.brake = 0.2;
      input.steer = 0;
      input.handbrake = true;
      return;
    }
    const pose = car.pose();
    const h = car.h;
    const heat = sim.law.heat;
    const chase = this.chases(u, player);
    u.routeAge += dt;

    // What to do, and where.
    let goal: PathPoint | null = null;
    let cruise: number = POLICE.respondSpeed;
    let stopAtEnd = true;
    let mode: UnitMode = u.mode;
    if (this.standingDown || u.mode === 'leave') {
      mode = 'leave';
      cruise = POLICE.leaveSpeed;
      if (!u.loiterGoal || u.routeAge > 30) {
        const far = this.graph.pickAround(this.rng, pose.x, pose.z, 150, 300, () => true, 8);
        u.loiterGoal = far ? { x: far.x, z: far.z } : null;
        u.follower = null;
      }
      goal = u.loiterGoal;
    } else {
      const t = this.target();
      const dTarget = t ? Math.hypot(t.x - pose.x, t.z - pose.z) : Infinity;
      if (chase && t && !(player.vehicleId === 0 && dTarget < 12)) {
        mode = 'drive';
        goal = { x: t.x, z: t.z };
        if (t.live && player.vehicleId) {
          // Chasing a car: keep after it, no faster than is sensible when close.
          const ps = Math.hypot(player.controller.vel.x, player.controller.vel.z);
          const pv = sim.registry.get(player.vehicleId) as VehicleEntity | undefined;
          const pspeed = pv ? pv.car.speed : ps;
          cruise = Math.min(POLICE.pursueSpeed, Math.max(6, pspeed + 5 + dTarget * 0.25));
          stopAtEnd = false;
        } else if (t.live) cruise = POLICE.respondSpeed;
      } else {
        // Hold the scene: drive to it, then roam its streets.
        const anchor = heat.anchor ?? heat.lastKnown;
        if (!anchor) return;
        const dA = Math.hypot(anchor.x - pose.x, anchor.z - pose.z);
        if (dA > 35 && mode !== 'loiter') {
          mode = 'drive';
          goal = anchor;
        } else {
          mode = 'loiter';
          cruise = POLICE.loiterSpeed;
          u.loiterWait -= dt;
          const gd = u.loiterGoal ? Math.hypot(u.loiterGoal.x - pose.x, u.loiterGoal.z - pose.z) : 0;
          if (!u.loiterGoal || gd < 6) {
            if (u.loiterGoal && u.loiterWait <= 0) u.loiterWait = this.rng.range(2, 4);
            if (!u.loiterGoal || u.loiterWait <= 0) {
              const p = this.graph.pickAround(this.rng, anchor.x, anchor.z, 10, 60, () => true, 8);
              u.loiterGoal = p ? { x: p.x, z: p.z } : null;
              u.follower = null;
            }
          }
          goal = u.loiterGoal;
        }
      }
    }
    u.mode = mode === 'drive' || mode === 'loiter' || mode === 'leave' ? mode : u.mode;

    if (!goal) {
      input.throttle = 0;
      input.brake = 0.5;
      input.handbrake = true;
      return;
    }

    // A route to the goal, replanned when it is old or the goal has moved.
    const moved = u.routeTo ? Math.hypot(u.routeTo.x - goal.x, u.routeTo.z - goal.z) : 1e9;
    if (!u.follower || u.follower.remaining < 3 || (u.routeAge > 1.2 && moved > 14) || u.routeAge > 6) {
      const pts = this.graph.route({ x: pose.x, z: pose.z }, car.yaw, goal);
      u.routeAge = 0;
      u.routeTo = { x: goal.x, z: goal.z };
      u.follower = pts && pts.length > 1 ? new PathFollower(pts) : null;
    }
    const f = u.follower;
    if (!f) {
      input.throttle = 0;
      input.brake = 0.4;
      input.handbrake = true;
      return;
    }
    f.advance(pose.x, pose.z);
    // Arrived: close to where it was sent, or at the end of the road with the goal off the road.
    if (mode === 'drive' && (Math.hypot(goal.x - pose.x, goal.z - pose.z) < 18 || (f.remaining < 8 && Math.abs(car.speedForward) < 3))) u.arrivedT += dt;
    else if (mode === 'drive') u.arrivedT = 0;
    else if (mode === 'loiter') u.arrivedT += dt;

    // Steering: pure pursuit on the path, aiming straight at the goal for the last stretch.
    const speed = car.speedForward;
    const look = lookaheadDistance(speed);
    let aim = f.lookahead(look);
    if (f.remaining < look + 4 && mode === 'drive' && Math.hypot(goal.x - pose.x, goal.z - pose.z) < 30 && this.sim.law.clearLine({ x: pose.x, y: pose.y + 0.6, z: pose.z }, { x: goal.x, y: pose.y + 0.6, z: goal.z })) aim = goal;
    const wheelbase = h.wheels.frontZ - h.wheels.rearZ;
    const lock = steerLock(speed, h.steering);
    let steer = steerCommand(pursuitAngle({ x: pose.x, z: pose.z, yaw: car.yaw, speed }, aim, wheelbase), lock);

    // Speed: the governor on the path, cut for whatever is in the way.
    this.governor.cruise = cruise;
    this.governor.stopAtEnd = stopAtEnd;
    let target = governSpeed(f, this.governor);
    const wanted = target;
    u.ramT = Math.max(0, u.ramT - dt);
    const gap = this.clearAhead(veh);
    target = u.ramT > 0 ? Math.min(target, 6) : Math.min(target, Math.max(0, gap - 4.5) * 1.6);
    if (mode === 'drive' && player.vehicleId === 0 && Math.hypot(goal.x - pose.x, goal.z - pose.z) < 14) target = Math.min(target, 4);

    // Stuck: wheels against something. Back out with the wheel the other way.
    if (u.reverseT > 0) {
      u.reverseT -= dt;
      input.throttle = 0;
      input.brake = 1;
      input.steer = u.reverseSteer;
      input.handbrake = false;
      // Brake input reverses once stopped.
      return;
    }
    pedalsFor(target, speed, tmpPedals);
    input.throttle = tmpPedals.throttle;
    input.brake = tmpPedals.brake;
    input.steer = steer;
    input.handbrake = false;
    // Stuck: it wants to go and is not going (against a wall, or boxed in by a car). Back out, and if that
    // does not help, push through.
    if (Math.abs(speed) < 0.6 && wanted > 2.5) u.stuckT += dt;
    else u.stuckT = Math.max(0, u.stuckT - dt * 2);
    if (u.stuckT > 1.6) {
      u.stuckT = 0;
      u.reverseT = 1.3;
      u.reverseSteer = -steer || 1;
      u.follower = null;
      u.routeAge = 99;
      if (++u.stuckCycles >= 2) {
        u.ramT = 5;
        u.stuckCycles = 0;
      }
    }
  }

  /** Distance to whatever is ahead of the car along its nose (walls, other cars), up to 14 m. */
  private clearAhead(veh: VehicleEntity): number {
    const R = this.sim.physics.R;
    const pose = veh.car.pose();
    const half = veh.car.h.chassis.halfExtents;
    const f = rotateVec(pose.q, 0, 0, 1);
    const hz = half[2];
    const ray = new R.Ray({ x: pose.x + f.x * (hz + 0.1), y: pose.y + 0.35, z: pose.z + f.z * (hz + 0.1) }, { x: f.x, y: 0, z: f.z });
    const hit = this.sim.physics.world.castRay(ray, 14, true, undefined, GROUPS.actorQuery, undefined, veh.car.body);
    return hit ? hit.timeOfImpact + hz : 99;
  }
}

export class PoliceSystem implements SimSystem {
  readonly name = 'police';
  readonly priority = 18;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.police.update(dt);
  }
}

