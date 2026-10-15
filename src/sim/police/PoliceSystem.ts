/**
 * The police. Units are a car and one or two officers. They are sent by the dispatch tables of the
 * city pack, appear out of the player's view on the road network, and go where the police believe the
 * player is (the crime scene, then the last place they saw them). A unit that may chase a car does,
 * in a role (chaser, flanker, blocker; `tactics.ts`) and with PIT and ramming where the agency and the
 * heat allow; one that may not (a restrictive agency, for a minor crime) gathers at the scene, and gets
 * out to chase on foot if the player is on foot. Officers on foot run at the player and arrest them if
 * they stand still within reach for two seconds, and from heat 3 shoot (`fire.ts`).
 *
 * Above that the manager runs the rest of the ladder: roadblocks (`roadblocks.ts`), spike strips
 * (`spikes.ts`) and helicopters (`helicopter.ts`). The driving is in `driving.ts`.
 *
 * Seeing is a cone plus a clear line (a ray against the static world). It feeds the heat model: any
 * officer (or helicopter) who sees the player makes the stars solid, and when none does they flash.
 */
import { LAW_RULES, agencyAt, dispatchFor, hasArea, type Agency, type DispatchLevel } from '../../shared/law';
import type { EntityId } from '../../shared/entities';
import { HANDLING } from '../../shared/handling';
import { quatFromYaw, wrapAngle, yawFromDir } from '../../shared/math';
import { POLICE_RULES, atHeat } from '../../shared/policeRules';
import { Axis } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { E, H, PoliceRole, type SnapshotView } from '../../shared/snapshot';
import { AI_OWNER, HelicopterEntity, PedEntity, SpikeStripEntity, VehicleEntity, type SimEntity } from '../entities';
import { leaveVehicle } from '../exit';
import { chooseSeekHeading } from '../npc/seek';
import { probeFrom } from '../npc/probe';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';
import { LaneGraph } from '../traffic/LaneGraph';
import { POLICE } from './constants';
import { agenciesWanting, mayPursueVehicle, ordersAt, type DispatchOrder } from './dispatch';
import { driveUnit } from './driving';
import { PoliceFire } from './fire';
import { HelicopterDirector } from './helicopter';
import { PoliceNav, pointAlong, polyline, type Polyline } from './nav';
import { GOVERNOR, type GovernorOptions } from './pursuit';
import { RoadblockDirector } from './roadblocks';
import { RoadGraph, polyLength } from './roadGraph';
import { SpikeStrips } from './spikes';
import { assignRoles, interceptAlong, type Intercept, type Kin, type Role } from './tactics';
import type { OfficerState, Roadblock, Unit } from './types';

export type { Unit } from './types';

export { POLICE };

/** What the police are after: the player as the police know them. */
export interface Target {
  /** Where the police believe the player is: their true position while seen, else the last known one. */
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  speed: number;
  /** Direction of travel (rad), and how fast it turns (rad/s, positive left). */
  heading: number;
  yawRate: number;
  /** In sight right now. */
  live: boolean;
  inCar: boolean;
  veh: VehicleEntity | null;
  ped: PedEntity;
  kin: Kin | null;
}

const hex = (s: string) => parseInt(s.replace('#', ''), 16) || 0;
/** A spawn spot on the lane graph (already facing along its lane) or the road centrelines. */
interface Spot {
  x: number;
  z: number;
  dx: number;
  dz: number;
  lane: boolean;
  oneway: boolean;
}

export class PoliceManager {
  readonly graph: RoadGraph;
  readonly nav: PoliceNav;
  readonly units: Unit[] = [];
  /** True when any officer or helicopter sees the player (updated every few ticks). */
  seesPlayer = false;
  standingDown = false;
  /** The police's picture of the player (null without heat). */
  tgt: Target | null = null;
  readonly governor: GovernorOptions = { ...GOVERNOR };
  readonly rng: Rng;
  readonly fire: PoliceFire;
  readonly spikes: SpikeStrips;
  readonly roadblocks: RoadblockDirector;
  readonly heli: HelicopterDirector;
  /** When each agency last put a car on the road (sim time, s): the next one waits out the interval of the row in force. */
  private readonly lastSpawnAt = new Map<string, number>();
  /** The heat level dispatch last saw, and the time before which it sends nothing because the radio is still working on a rise. */
  private dispatchLevel = 0;
  private holdUntil = 0;
  private dispatchClock = 0;
  private nextUnitId = 1;
  private prevHeading = 0;
  private yawRate = 0;
  private roleClock = 0;
  private route: { pl: Polyline; at: number } | null = null;
  /** Route searches left this tick (see `driveUnit`). */
  routeBudget = 0;
  /** Counters for tests and the report. */
  readonly stats = { spawned: 0, pitAttempts: 0, pitHits: 0, rams: 0, roadblocks: 0 };

  constructor(readonly sim: Simulation) {
    this.graph = new RoadGraph(sim.tile.roads ?? []);
    this.rng = sim.rng.fork('police');
    this.nav = new PoliceNav(this.graph, () => {
      if (sim.traffic) return sim.traffic.graph;
      if (!sim.tile.lanes) return null;
      const g = new LaneGraph(sim.tile.lanes);
      return g.usable ? g : null;
    });
    this.fire = new PoliceFire(sim, this.rng.fork('fire'));
    this.spikes = new SpikeStrips(sim);
    this.roadblocks = new RoadblockDirector(sim, this, this.rng.fork('roadblock'));
    this.heli = new HelicopterDirector(sim, this.rng.fork('heli'), () => {
      const p = sim.playerPosition();
      const a = agencyAt(sim.law.data, sim.tile.roads ?? [], p.x, p.z) ?? sim.law.data.agencies[0];
      return { agency: a.id, color: hex(a.livery.body) };
    });
  }

  get time(): number {
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

  playerEye() {
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
          const was = st.sees;
          st.sees = live && this.canSee(o, x, y, z);
          if (st.sees && !was) this.fire.newSighting(o);
        }
        st.unseenT = st.sees ? 0 : st.unseenT + dt;
        any ||= st.sees;
      }
    }
    this.seesPlayer = any;
  }

  // ---------------------------------------------------------------------------------------------
  // The target

  private refreshTarget(dt: number) {
    const sim = this.sim;
    const heat = sim.law.heat;
    if (heat.level === 0) {
      this.tgt = null;
      return;
    }
    const player = sim.registry.get(sim.playerPedId) as PedEntity;
    const veh = player.vehicleId ? (sim.registry.get(player.vehicleId) as VehicleEntity | undefined) ?? null : null;
    const c = player.controller;
    let x: number, y: number, z: number, vx: number, vz: number, yaw: number;
    if (veh) {
      const p = veh.car.pose();
      const lv = veh.car.body.linvel();
      x = p.x; y = p.y; z = p.z; vx = lv.x; vz = lv.z; yaw = veh.car.yaw;
    } else {
      x = c.x; y = c.y; z = c.z; vx = c.vel.x + c.ext.x; vz = c.vel.z + c.ext.z; yaw = c.yaw;
    }
    const speed = Math.hypot(vx, vz);
    const heading = speed > 2 ? Math.atan2(vx, vz) : yaw;
    this.yawRate += (wrapAngle(heading - this.prevHeading) / Math.max(dt, 1e-3) - this.yawRate) * Math.min(1, dt * 4);
    this.prevHeading = heading;
    const live = this.seesPlayer;
    const lk = heat.lastKnown;
    if (live || !lk) {
      let kin: Kin | null = null;
      if (veh) {
        const h = veh.car.h.chassis.halfExtents;
        kin = { x, z, yaw: veh.car.yaw, speed: veh.car.speedForward, halfLen: h[2], halfWid: h[0] };
      }
      this.tgt = { x, y, z, vx, vz, speed, heading, yawRate: this.yawRate, live, inCar: !!veh, veh, ped: player, kin };
    } else {
      this.tgt = { x: lk.x, y, z: lk.z, vx: 0, vz: 0, speed: 0, heading: 0, yawRate: 0, live: false, inCar: false, veh: null, ped: player, kin: null };
    }
  }

  /** The route the player is likely to take, as a polyline from where they are (recomputed twice a second). */
  predicted(): Polyline | null {
    const t = this.tgt;
    if (!t || !t.live || !t.inCar) return null;
    if (this.route && this.time - this.route.at < 0.5) return this.route.pl;
    const pts = this.nav.predict(t.x, t.z, t.heading, t.yawRate, 330);
    this.route = { pl: polyline(pts), at: this.time };
    this.lastLive = { at: this.time, speed: t.speed, route: this.route.pl };
    return this.route.pl;
  }

  /** The last time the police had the player in sight in a car: when, how fast, and the route they were on. */
  private lastLive: { at: number; speed: number; route: Polyline } | null = null;

  /**
   * Where the police would look for a car they have lost: the last known position carried along the route it
   * was on at the speed it had, for up to 20 s (dead reckoning), and no further than the search circle. The
   * last known position itself when it was on foot or stood still.
   */
  searchCentre(): { x: number; z: number } | null {
    const lk = this.sim.law.heat.lastKnown;
    if (!lk) return null;
    const l = this.lastLive;
    if (!l || l.speed < 3 || this.tgt?.live) return { x: lk.x, z: lk.z };
    const travelled = Math.min(l.route.length, l.speed * 0.85 * Math.min(20, this.time - l.at));
    const p = pointAlong(l.route, travelled);
    const r = Math.max(60, this.sim.law.heat.searchRadius);
    const d = Math.hypot(p.x - lk.x, p.z - lk.z);
    if (d > r) return { x: lk.x + ((p.x - lk.x) / d) * r, z: lk.z + ((p.z - lk.z) / d) * r };
    return { x: p.x, z: p.z };
  }

  // ---------------------------------------------------------------------------------------------
  // Dispatch

  private liveUnits(agency: string): number {
    let n = 0;
    for (const u of this.units) if (u.agency.id === agency && !u.block && this.hasLiveOfficer(u)) n++;
    return n;
  }

  private hasLiveOfficer(u: Unit): boolean {
    return u.officerIds.some((id) => {
      const l = (this.sim.registry.get(id) as PedEntity | undefined)?.life;
      return l === 'alive' || l === 'downed';
    });
  }

  /** Whether an agency has more cars out than its table row allows at this heat (roadblock cars that rejoin the chase are sent home if so). */
  overCap(agency: Agency): boolean {
    const row = dispatchFor(this.sim.law.data, agency.id, this.sim.law.heat.level);
    return !row || this.liveUnits(agency.id) > row.maxUnits;
  }

  /** The loadout the dispatch table gives an agency at a heat level. */
  loadoutFor(agency: Agency, heat: number): string {
    return dispatchFor(this.sim.law.data, agency.id, heat)?.loadout ?? 'pistol';
  }

  /** The most speed a pursuit asks of its cars, m/s: it climbs with the heat, and aggressive agencies drive harder. */
  speedCap(agency: Agency): number {
    const heat = this.sim.law.heat.level;
    return POLICE.pursueSpeed + Math.max(0, heat - 1) * 4.2 + (agency.pursuit === 'aggressive' ? 4 : 0);
  }

  private dispatch(dt: number) {
    const sim = this.sim;
    const heat = sim.law.heat;
    // A rise in the heat (the first report, or a worse one) takes the radio a few seconds to turn into a car.
    if (heat.level > this.dispatchLevel) {
      const d = POLICE_RULES.dispatch.delayS[Math.min(heat.level, POLICE_RULES.dispatch.delayS.length - 1)];
      this.holdUntil = Math.max(this.holdUntil, this.time + this.rng.range(d[0], d[1]));
    }
    this.dispatchLevel = heat.level;
    if (heat.level === 0) this.holdUntil = 0;
    if (heat.level === 0 || this.standingDown || this.nav.empty) return;
    this.dispatchClock += dt;
    if (this.dispatchClock < POLICE.dispatchEvery) return;
    this.dispatchClock = 0;
    const pursuit = this.units.filter((u) => !u.block).length;
    if (pursuit >= POLICE.maxUnits || sim.registry.size > POLICE.entityCap) return;

    if (this.time < this.holdUntil) return;

    const counts = new Map<string, number>();
    const nextAt = new Map<string, number>();
    for (const a of sim.law.data.agencies) {
      counts.set(a.id, this.liveUnits(a.id));
      const last = this.lastSpawnAt.get(a.id);
      const row = dispatchFor(sim.law.data, a.id, heat.level);
      if (last !== undefined && row) nextAt.set(a.id, last + row.spawnIntervalS);
    }
    const wanting = agenciesWanting(sim.law.data, heat.level, { nextAt, counts }, this.time);
    if (wanting.length === 0) return;

    // Who sends cars is decided where the police think the player is (a chase onto a freeway is the Highway Patrol's).
    const here = this.tgt ?? { x: this.playerEye().x, z: this.playerEye().z };
    const orders = ordersAt(sim.law.data, sim.tile.roads ?? [], here.x, here.z, wanting);
    if (orders.length === 0) return;
    for (const order of orders) {
      let spawned = 0;
      for (let i = 0; i < order.units; i++) {
        const spot = this.spawnSpot(order.agency, order.row);
        if (!spot) break;
        this.spawnUnit(spot, order);
        spawned++;
      }
      // (a failed search tries again at the next check; a spawn starts the interval)
      if (spawned > 0) this.lastSpawnAt.set(order.agency.id, this.time);
    }
  }

  /** A road point the player cannot see, and nothing stands on. */
  hidden(p: { x: number; z: number }, px: number, pz: number, camYaw: number, eye: { x: number; y: number; z: number }): boolean {
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d < POLICE.hiddenMin) return false;
    // The camera looks along (-sin yaw, -cos yaw).
    const ang = Math.abs(wrapAngle(Math.atan2(p.x - px, p.z - pz) - (camYaw + Math.PI)));
    if (ang < POLICE.cameraHalfFov) {
      const gy = this.sim.groundAt(p.x, p.z);
      if (this.sim.law.clearLine({ x: p.x, y: gy + 1.5, z: p.z }, eye)) return false;
    }
    return this.siteFree(p.x, p.z, 9);
  }

  /** Hidden from the player's camera at distance (the roadblocks' test). */
  hiddenPoint(x: number, z: number): boolean {
    const eye = this.playerEye();
    const camYaw = this.sim.players.get(1)?.axes[Axis.Yaw] ?? 0;
    return this.hidden({ x, z }, eye.x, eye.z, camYaw, eye);
  }

  /** No car within `r` metres of a point. */
  siteFree(x: number, z: number, r: number): boolean {
    for (const v of this.sim.vehicles()) {
      const q = v.car.body.translation();
      if (Math.abs(q.x - x) < r && Math.abs(q.z - z) < r && Math.hypot(q.x - x, q.z - z) < r) return false;
    }
    return true;
  }

  /**
   * Candidate spawn points out of the player's view, 250 to 330 m away at heat 1 down to 120 to 200 m at
   * heat 5 (`police.json` dispatch, or the agency's own row). A ring with no road in it widens inward, and
   * last falls back to the old 120 to 200 m. The agency's own area first where it has one on the road
   * classes; the lanes where the tile has them.
   */
  private spawnSpot(agency: Agency, row: DispatchLevel): Spot | null {
    const lv = this.sim.law.heat.level;
    const min = row.spawnMinM ?? atHeat(POLICE_RULES.dispatch.spawnMinM, lv);
    const max = row.spawnMaxM ?? atHeat(POLICE_RULES.dispatch.spawnMaxM, lv);
    const rings: [number, number][] = [[min, max], [min * 0.7, max], [POLICE.spawnMin, POLICE.spawnMax], [POLICE.hiddenMin, max]];
    // A spot far out is only worth it if the streets get a car from there to the scene without a detour
    // (one-way systems can turn 300 m into a kilometre): of a few candidates take the first with a direct route.
    const goal = this.sim.law.heat.lastKnown ?? this.playerEye();
    const direct = POLICE_RULES.dispatch.routeFactorMax;
    let best: { spot: Spot; len: number } | null = null;
    for (const [a, b] of rings) {
      for (let k = 0; k < 5; k++) {
        const spot = this.spawnSpotIn(agency, a, b);
        if (!spot) break;
        const straight = Math.hypot(spot.x - goal.x, spot.z - goal.z);
        const len = this.routeLength(spot, goal);
        if (len <= straight * direct) return spot;
        if (len < Infinity && (!best || len < best.len)) best = { spot, len };
      }
      if (best) return best.spot;
    }
    return null;
  }

  /** How far a car at a spawn spot has to drive to reach a point, m (Infinity when the streets do not connect them). */
  private routeLength(spot: Spot, goal: { x: number; z: number }): number {
    const pts = this.nav.route({ x: spot.x, z: spot.z }, yawFromDir(spot.dx, spot.dz), { x: goal.x, z: goal.z });
    return pts && pts.length > 1 ? polyLength(pts) : Infinity;
  }

  private spawnSpotIn(agency: Agency, ringMin: number, ringMax: number): Spot | null {
    const sim = this.sim;
    const eye = this.playerEye();
    const px = eye.x;
    const pz = eye.z;
    const camYaw = sim.players.get(1)?.axes[Axis.Yaw] ?? 0;
    const law = sim.law.data;
    const roads = sim.tile.roads ?? [];
    const area = law.areas.find((a) => a.agency === agency.id);
    const own = (p: { x: number; z: number }) => !hasArea(law, agency.id) || agencyAt(law, roads, p.x, p.z)?.id === agency.id;
    const accept = (p: { x: number; z: number }) => this.hidden(p, px, pz, camYaw, eye) && own(p);
    const lanes = this.nav.lanes;
    const tryLanes = (): Spot | null => {
      if (!lanes) return null;
      const spots = lanes.spotsAround(px, pz, ringMin, ringMax, []);
      const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
      for (let i = 0; i < 24 && spots.length > 0; i++) {
        const k = this.rng.int(0, spots.length - 1);
        const sp = spots[k];
        spots[k] = spots[spots.length - 1];
        spots.pop();
        if (!accept(sp)) continue;
        lanes.posAt(sp.edge, sp.s, pt);
        return { x: sp.x, z: sp.z, dx: pt.tx, dz: pt.tz, lane: true, oneway: true };
      }
      return null;
    };
    const tryRoads = (): Spot | null => {
      const p = this.graph.pickAround(this.rng, px, pz, ringMin, ringMax, accept);
      return p ? { x: p.x, z: p.z, dx: p.dx, dz: p.dz, lane: false, oneway: this.graph.edges[p.edge].oneway } : null;
    };
    // Areas drawn on road classes (the freeways) are not in the lane graph's connected part.
    const roadFirst = !!area?.roadClasses;
    return roadFirst ? tryRoads() ?? tryLanes() : tryLanes() ?? tryRoads();
  }

  private newOfficer(agency: Agency, uniform: number, vehicleId: EntityId, loadout: string, seat: number): OfficerState {
    return {
      agency: agency.id, unitId: 0, mode: 'seated', vehicleId, arrestT: 0, goal: null, goalT: 0, unseenT: 99, senseIn: 0, sees: false, uniform,
      loadout, seat, fireT: 0, fire: { seenT: 0, reactS: 0.8, burstLeft: 0, pauseT: 0, why: '' },
    };
  }

  private blankUnit(agency: Agency, veh: VehicleEntity, loadout: string): Unit {
    return {
      id: this.nextUnitId++, agency, vehicleId: veh.id, officerIds: [], mode: 'drive',
      follower: null, routeTo: null, routeAge: 99, stuckT: 0, reverseT: 0, reverseSteer: 0,
      loiterGoal: null, loiterWait: 0, leaveT: 0, arrivedT: 0, stuckCycles: 0, ramT: 0,
      loadout, role: 'responder', roleT: 0, block: null, meet: null, meetAt: -99, blockStage: 0, pit: null, pitCool: 0, ramCool: 0, grace: 0,
      ramming: false, ramClock: 0, lateral: 0, lateralWant: 0, lateralT: 0, spikesLaid: false, searchGoal: null, searchT: 0, chaseT: 0,
    };
  }

  private makeCar(agency: Agency, x: number, z: number, yaw: number): VehicleEntity {
    const sim = this.sim;
    const typeId = HANDLING[agency.vehicle] ? agency.vehicle : 'sedan';
    const gy = sim.groundAt(x, z);
    const body = hex(agency.livery.body);
    const strobe: [number, number] = [hex(agency.strobe[0]), hex(agency.strobe[1])];
    const livery = {
      agency: agency.id, body, stripe: agency.unmarked ? body : hex(agency.livery.stripe),
      lightbar: agency.unmarked ? strobe : ([hex(agency.livery.lightbar[0]), hex(agency.livery.lightbar[1])] as [number, number]),
      ...(agency.unmarked ? { unmarked: true } : {}),
    };
    return sim.spawnVehicle(typeId, x, gy, z, yaw, body, (v) => {
      v.police = livery;
      v.lightbar = !agency.unmarked;
      v.owner = AI_OWNER;
    });
  }

  private seatOfficer(agency: Agency, veh: VehicleEntity, loadout: string, seat: number): PedEntity {
    const sim = this.sim;
    const p = veh.car.pose();
    const officer = sim.addPed(p.x, p.y, p.z, veh.car.yaw, 0, false, (o) => {
      o.role = 'police';
      o.officer = this.newOfficer(agency, hex(agency.livery.body), veh.id, loadout, seat);
    });
    officer.controller.setEnabled(false);
    officer.vehicleId = veh.id;
    if (seat === 0) veh.occupantId = officer.id;
    this.fire.arm(officer, loadout);
    return officer;
  }

  private spawnUnit(spot: Spot, order: DispatchOrder) {
    const { x: px, z: pz } = this.playerEye();
    // Face along the road, toward the player where the street runs both ways.
    let dx = spot.dx;
    let dz = spot.dz;
    if (!spot.lane && !spot.oneway && dx * (px - spot.x) + dz * (pz - spot.z) < 0) {
      dx = -dx;
      dz = -dz;
    }
    this.deployUnit(order.agency, spot.x, spot.z, yawFromDir(dx, dz), order.row.loadout);
  }

  /**
   * Puts a unit of an agency on the road at (x, z) facing `yaw`: a car and its officer, and from the heat
   * where officers shoot a second one at the passenger window. Dispatch uses it; so do tests and scripted scenes.
   */
  deployUnit(agency: Agency, x: number, z: number, yaw: number, loadout = 'pistol'): Unit {
    const sim = this.sim;
    const veh = this.makeCar(agency, x, z, yaw);
    const unit = this.blankUnit(agency, veh, loadout);
    const driver = this.seatOfficer(agency, veh, loadout, 0);
    unit.officerIds.push(driver.id);
    driver.officer!.unitId = unit.id;
    const ids = [driver.id];
    if (sim.law.heat.level >= POLICE_RULES.fire.minHeat && loadout !== 'none') {
      const pass = this.seatOfficer(agency, veh, loadout, 1);
      pass.officer!.unitId = unit.id;
      unit.officerIds.push(pass.id);
      ids.push(pass.id);
    }
    this.units.push(unit);
    this.stats.spawned++;
    sim.emit({ type: 'police:spawn', tick: sim.tick, vehicleId: veh.id, officerIds: ids, agency: agency.id });
    return unit;
  }

  /**
   * A car and an officer standing behind it, laid by a roadblock. The car is parked where the layout
   * says with its handbrake on and its lights going; the officer stands holding, armed, until the
   * block is released.
   */
  spawnStatic(agency: Agency, loadout: string, car: { x: number; z: number; yaw: number }, stand: { x: number; z: number; yaw: number }, block: Roadblock): Unit {
    const sim = this.sim;
    const veh = this.makeCar(agency, car.x, car.z, car.yaw);
    veh.roadblock = true;
    veh.policeRole = PoliceRole.Roadblock;
    veh.lightbar = true;
    veh.input.handbrake = true;
    const unit = this.blankUnit(agency, veh, loadout);
    unit.block = block;
    unit.role = 'responder';
    const gy = sim.groundAt(stand.x, stand.z);
    const officer = sim.addPed(stand.x, gy, stand.z, stand.yaw, 0, false, (o) => {
      o.role = 'police';
      o.officer = this.newOfficer(agency, hex(agency.livery.body), veh.id, loadout, 0);
      o.officer.mode = 'hold';
    });
    officer.controller.yaw = stand.yaw;
    this.fire.arm(officer, loadout);
    officer.officer!.unitId = unit.id;
    unit.officerIds.push(officer.id);
    this.units.push(unit);
    this.stats.roadblocks++;
    sim.emit({ type: 'police:spawn', tick: sim.tick, vehicleId: veh.id, officerIds: [officer.id], agency: agency.id });
    return unit;
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
      u.block = null;
    }
    this.sim.emit({ type: 'police:stand-down', tick: this.sim.tick });
  }

  /** Removes everything police at once (a respawn after being wasted or busted). */
  clearAll() {
    for (const u of this.units) this.despawnUnit(u);
    this.units.length = 0;
    this.standingDown = false;
    this.seesPlayer = false;
    this.tgt = null;
    this.lastLive = null;
    this.lastSpawnAt.clear();
    this.dispatchLevel = 0;
    this.holdUntil = 0;
    this.roadblocks.clearAll();
    this.spikes.clearAll();
    this.heli.clearAll();
    this.fire.reset();
  }

  private despawnUnit(u: Unit) {
    this.sim.despawn(u.vehicleId);
    for (const id of u.officerIds) this.sim.despawn(id);
  }

  // ---------------------------------------------------------------------------------------------
  // The cooldown, and the snapshot

  /**
   * How fast the heat's cooldown runs: 1, slowed from heat 4 while the player is still inside the search
   * circle, and again while a helicopter hangs over them. Out of the circle and out of the sky's sight it
   * runs at full speed, which is how a high heat is shaken.
   */
  coolRate(): number {
    const sim = this.sim;
    const C = POLICE_RULES.cooldown;
    const heat = sim.law.heat;
    if (heat.level < C.minHeatForSlow || !heat.lastKnown) return 1;
    const p = sim.playerPosition();
    let f = 1;
    const r = heat.searchRadius;
    if (r > 0 && Math.hypot(p.x - heat.lastKnown.x, p.z - heat.lastKnown.z) < r) f *= C.insideSearchFactor;
    for (const h of this.heli.helis) {
      if (h.leaving) continue;
      if (Math.hypot(h.x - p.x, h.z - p.z) < C.heliOverheadM) {
        f *= C.heliOverheadFactor;
        break;
      }
    }
    return f;
  }

  /** Whether a car is still driving to the scene (the first response has not arrived yet): hollow stars do not cool meanwhile. */
  unitEnRoute(): boolean {
    const lk = this.sim.law.heat.lastKnown;
    if (!lk || this.standingDown) return false;
    for (const u of this.units) {
      if (u.block || u.mode !== 'drive') continue;
      const p = (this.sim.registry.get(u.vehicleId) as VehicleEntity | undefined)?.car.pose();
      if (p && Math.hypot(p.x - lk.x, p.z - lk.z) > 45) return true;
    }
    return false;
  }

  /** The police half of the snapshot header: where they are searching, and what is out there. */
  writeHeader(view: SnapshotView) {
    const heat = this.sim.law.heat;
    const f = view.f32;
    const u = view.u32;
    const lk = heat.level > 0 ? heat.lastKnown : null;
    f[H.SearchX] = lk ? lk.x : 0;
    f[H.SearchZ] = lk ? lk.z : 0;
    f[H.SearchR] = heat.searchRadius;
    u[H.Roadblocks] = this.roadblocks.blocks.length;
    u[H.Helicopters] = this.heli.helis.length;
    u[H.Strips] = this.spikes.count;
    let chasers = 0;
    for (const unit of this.units) if (unit.role !== 'responder' && !unit.block) chasers++;
    u[H.Chasers] = chasers;
  }

  /** The record of a helicopter or a spike strip. */
  writeEntity(view: SnapshotView, o: number, e: SimEntity) {
    const f = view.f32;
    const u = view.u32;
    if (e instanceof HelicopterEntity) {
      f[o + E.Px] = e.x;
      f[o + E.Py] = e.y;
      f[o + E.Pz] = e.z;
      const q = eulerYXZ(e.yaw, e.pitch, -e.bank);
      f[o + E.Qx] = q.x;
      f[o + E.Qy] = q.y;
      f[o + E.Qz] = q.z;
      f[o + E.Qw] = q.w;
      f[o + E.Vx] = e.vx;
      f[o + E.Vy] = e.vy;
      f[o + E.Vz] = e.vz;
      u[o + E.Flags] = (e.searchlight ? 1 : 0) | (e.sees ? 2 : 0) | (e.leaving ? 4 : 0);
      f[o + E.Speed] = Math.hypot(e.vx, e.vz);
      f[o + E.Aux0] = e.rotor;
      f[o + E.Aux1] = e.agl;
      f[o + E.Aux2] = e.footprint;
      f[o + E.Health] = e.health;
    } else if (e instanceof SpikeStripEntity) {
      f[o + E.Px] = e.x;
      f[o + E.Py] = e.y;
      f[o + E.Pz] = e.z;
      const q = quatFromYaw(e.yaw);
      f[o + E.Qx] = q.x;
      f[o + E.Qy] = q.y;
      f[o + E.Qz] = q.z;
      f[o + E.Qw] = q.w;
      u[o + E.Flags] = e.used ? 1 : 0;
      f[o + E.Aux0] = e.length;
      f[o + E.Aux1] = Math.max(0, 1 - e.age / e.life);
      f[o + E.Health] = 1;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Roles

  private assignRoles() {
    const t = this.tgt;
    const sim = this.sim;
    const rules = POLICE_RULES.roles;
    const cands = [];
    const fx = t ? Math.sin(t.heading) : 0;
    const fz = t ? Math.cos(t.heading) : 1;
    for (const u of this.units) {
      if (u.block) continue;
      const veh = sim.registry.get(u.vehicleId) as VehicleEntity | undefined;
      if (!veh) continue;
      const p = veh.car.body.translation();
      const engaged = !!t && t.live && t.inCar && u.mode === 'drive' && !this.standingDown && mayPursueVehicle(u.agency, sim.law.heat.severity);
      cands.push({
        id: u.id,
        dist: t ? Math.hypot(p.x - t.x, p.z - t.z) : 1e9,
        ahead: t ? (p.x - t.x) * fx + (p.z - t.z) * fz : 0,
        role: u.role,
        heldFor: u.roleT,
        engaged,
      });
    }
    const out = assignRoles(cands, rules);
    for (const u of this.units) {
      const r = out.get(u.id);
      if (!r || r === u.role) continue;
      u.role = r;
      u.roleT = 0;
      u.meet = null;
      u.blockStage = 0;
      const veh = sim.registry.get(u.vehicleId) as VehicleEntity | undefined;
      sim.emit({ type: 'police:role', tick: sim.tick, vehicleId: u.vehicleId, role: r, agency: u.agency.id });
      void veh;
    }
  }

  /** Where a unit can meet the target on its predicted route, with `margin` seconds to spare (cached for a second). */
  meetPoint(u: Unit, veh: VehicleEntity, margin: number): Intercept | null {
    const t = this.tgt;
    const route = this.predicted();
    if (!t || !route) return null;
    const p = veh.car.body.translation();
    const vAvg = Math.min(this.speedCap(u.agency), 20);
    return interceptAlong(route, { playerSpeed: t.speed, margin, eta: (q) => (Math.hypot(q.x - p.x, q.z - p.z) * 1.3) / vAvg });
  }

  // ---------------------------------------------------------------------------------------------
  // Per-tick

  update(dt: number) {
    const sim = this.sim;
    const heat = sim.law.heat;
    if (heat.level > 0) this.standingDown = false;
    else if (this.units.length > 0 || this.heli.count > 0 || this.spikes.count > 0) this.standDown();
    if (heat.level === 0) this.fire.reset();

    this.vision(dt);
    this.heli.update(dt);
    if (this.heli.sees) this.seesPlayer = true;
    this.refreshTarget(dt);
    this.dispatch(dt);
    this.roleClock += dt;
    if (this.roleClock >= POLICE_RULES.roles.reassignEveryS) {
      this.roleClock = 0;
      this.assignRoles();
    }
    this.roadblocks.update();
    this.spikes.update(dt);

    const player = sim.registry.get(sim.playerPedId) as PedEntity;
    this.routeBudget = 2;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      u.roleT += dt;
      u.pitCool = Math.max(0, u.pitCool - dt);
      u.ramCool = Math.max(0, u.ramCool - dt);
      u.grace = Math.max(0, u.grace - dt);
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
      if (veh) {
        driveUnit(this, u, veh, player, dt);
        veh.policeRole = u.block ? PoliceRole.Roadblock : roleBits(u.role);
      }
    }
    this.shooting(player, dt);
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

  chases(u: Unit, player: PedEntity): boolean {
    return !player.vehicleId || mayPursueVehicle(u.agency, this.sim.law.heat.severity);
  }

  /** Whether the unit's passenger seat is free for an officer to climb into. */
  private seatFree(u: Unit, veh: VehicleEntity, o: PedEntity): boolean {
    const st = o.officer!;
    if (st.seat === 0) return !veh.occupantId;
    for (const id of u.officerIds) {
      const p = this.sim.registry.get(id) as PedEntity | undefined;
      if (p && p !== o && p.vehicleId === veh.id && p.officer?.seat === 1) return false;
    }
    return true;
  }

  private officerThink(u: Unit, o: PedEntity, veh: VehicleEntity | undefined, player: PedEntity, dt: number) {
    const st = o.officer!;
    const sim = this.sim;
    const c = o.controller;
    const i = o.input;
    i.moveX = i.moveY = 0;
    i.sprint = i.jump = false;
    const pc = player.controller;
    const target = this.tgt;

    // A roadblock officer stands where he was put, facing the way the target comes, until the block is lifted.
    if (st.mode === 'hold') {
      if (u.block) {
        const b = u.block;
        c.yaw = Math.atan2(-b.dirX, -b.dirZ);
        if (st.sees) c.yaw = Math.atan2(pc.x - c.x, pc.z - c.z);
        return;
      }
      st.mode = 'remount';
    }

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

    if (st.mode === 'leave' || this.standingDown || u.mode === 'leave') {
      st.mode = 'remount';
    }
    if (st.mode === 'remount') {
      // Back to the car: enter it when near.
      if (!veh || veh.burnt || veh.engineDead || !this.seatFree(u, veh, o)) {
        st.mode = 'search';
      } else {
        const p = veh.car.pose();
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < 2.4) {
          o.vehicleId = veh.id;
          if (st.seat === 0) veh.occupantId = o.id;
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
    if (veh && !veh.burnt && !veh.engineDead && player.vehicleId && this.chases(u, player) && sim.law.heat.level > 0 && this.seatFree(u, veh, o)) {
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
      // Where they may shoot they stand off and fire, and close in only to make the arrest.
      const standOff = st.sees && this.fire.mayShoot() && d > 7 && d < 38 && !!o.gun;
      if (!standOff && d > POLICE.arrestRange * 0.8) this.walkToward(o, pc.x, pc.z, d > 14);
      return;
    }
    st.mode = 'search';
    const lk = sim.law.heat.lastKnown ?? sim.law.heat.anchor;
    if (!lk) return;
    st.goalT -= dt;
    if (!st.goal || st.goalT <= 0 || Math.hypot(st.goal.x - c.x, st.goal.z - c.z) < 1.5) {
      // First to the place they were sent to, then around the search area.
      const first = !st.goal;
      const a = this.rng.range(0, Math.PI * 2);
      const r = first ? 0 : this.rng.range(0, Math.max(22, Math.min(110, sim.law.heat.searchRadius * 0.6)));
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

  /** Every officer who may fire does, through the weapons API (see `fire.ts`). */
  private shooting(player: PedEntity, dt: number) {
    const sim = this.sim;
    for (const u of this.units) {
      const veh = sim.registry.get(u.vehicleId) as VehicleEntity | undefined;
      for (const id of u.officerIds) {
        const o = sim.registry.get(id) as PedEntity | undefined;
        if (!o?.officer || o.life !== 'alive') continue;
        const st = o.officer;
        const inCar = !!o.vehicleId;
        // The driver drives; only a passenger fires from a car.
        if (inCar && st.seat === 0) {
          st.fireT = Math.max(0, st.fireT - dt);
          continue;
        }
        if (st.mode === 'remount' || st.mode === 'leave') continue;
        this.fire.officerFire(o, player, dt, inCar, inCar && veh ? Math.abs(veh.car.speedForward) : 0);
      }
    }
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
  // Events from the rest of the sim

  /** The player shot at police (or hit them with a bullet): every agency answers fire from now until the heat is gone. */
  onEvent(e: import('../../shared/protocol').SimEvent) {
    const sim = this.sim;
    if (e.type === 'weapon:fire' && e.shooterId === sim.playerPedId) {
      for (const im of e.impacts) {
        const t = im.targetId ? sim.registry.get(im.targetId) : undefined;
        if ((t instanceof PedEntity && t.role === 'police') || (t instanceof VehicleEntity && t.police)) this.fire.firedOn = true;
      }
      // A shot past an officer's ear counts as much: anyone within 6 m of the line of fire near the muzzle.
      for (const u of this.units) {
        for (const id of u.officerIds) {
          const o = sim.registry.get(id) as PedEntity | undefined;
          if (!o || o.life === 'dead') continue;
          const c = o.controller;
          const ox = c.x - e.x;
          const oz = c.z - e.z;
          const along = ox * e.dx + oz * e.dz;
          if (along > 0 && along < 90 && Math.hypot(ox - e.dx * along, oz - e.dz * along) < 4) this.fire.firedOn = true;
        }
      }
    } else if (e.type === 'damage' && e.sourceId === sim.playerPedId) {
      const t = sim.registry.get(e.targetId);
      if (t instanceof PedEntity && t.role === 'police' && e.kind === 'bullet') this.fire.firedOn = true;
    }
  }
}

function roleBits(r: Role): number {
  return r === 'chaser' ? PoliceRole.Chaser : r === 'flanker' ? PoliceRole.Flanker : r === 'blocker' ? PoliceRole.Blocker : PoliceRole.Responder;
}

/** Rotation from yaw (about +Y), then pitch (nose down positive, about local X), then roll (about local Z). */
function eulerYXZ(yaw: number, pitch: number, roll: number) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  // q = qy * qx * qz
  const w1 = cy * cp, x1 = cy * sp, y1 = sy * cp, z1 = -sy * sp;
  return {
    w: w1 * cr - z1 * sr,
    x: x1 * cr + y1 * sr,
    y: y1 * cr - x1 * sr,
    z: z1 * cr + w1 * sr,
  };
}

export class PoliceSystem implements SimSystem {
  readonly name = 'police';
  readonly priority = 18;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.police.update(dt);
  }
}

