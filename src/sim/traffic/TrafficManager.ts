/**
 * Ambient traffic. Cars drive on the lane graph (`lanes.json`) with IDM car following, MOBIL lane
 * changes, signals, stop signs and yielding by the graph's conflict data, along random turns or to
 * a destination. Each car lives in one of three modes:
 *
 *  - `kin`: a kinematic follower on the lane spline. It is still a vehicle entity in the snapshot, but
 *    nothing is simulated except its speed along the lane. Cars farther than ~80 m from the player.
 *  - `phys`: a full raycast-physics car steered along the lane by pure pursuit, with a driver ped at
 *    the wheel. Near the player, near other physical cars, and for good after any contact.
 *  - `free`: no longer driven (it crashed and stopped, or was jacked): it only waits to be cleaned up.
 *
 * The switch keeps the car's pose and speed, so nothing jumps. Cars spawn 120 to 250 m from the
 * player, out of view, in numbers the city's population table asks for, and are removed when far and unseen.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { HANDLING } from '../../shared/handling';
import { EntityKind, type EntityId } from '../../shared/entities';
import { clamp, lerp, rotateVec, smoothstep, wrapAngle, yawFromDir, type Quat } from '../../shared/math';
import { SIM_DT, Axis, type SimEvent } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { WEAPONS } from '../../shared/weapons';
import { legState } from '../../shared/signals';
import { AI_OWNER, PedEntity, VehicleEntity } from '../entities';
import { PedBrain, rollPersonality, type Personality } from '../npc/brain';
import { GROUPS } from '../physics/rapier';
import { pedalsFor, pursuitAngle, steerCommand } from '../police/pursuit';
import type { Simulation } from '../Simulation';
import { steerLock } from '../vehicles/dynamics';
import type { WalkGraph } from '../peds/graph';
import { Ctl, LaneGraph, type EdgePoint, type SpawnSpot } from './LaneGraph';
import { YIELD, crossingBusy, indexCrossingRange, indexCrossings, type LaneCrossing } from './crossings';
import type { StreamListener } from '../stream/TileStreamer';
import type { StreamJob } from '../stream/StreamPhysics';
import { DEFAULT_IDM, MAX_BRAKE, freeAccel, idmAccel, mobilChange, stoppingDistance, type IdmParams } from './idm';
import { Arbiter, type Probe } from './junction';
import { carSlot, carZoneAt, pickVehicle, type TrafficPopulation } from './population';
import { pickNext, planRoute } from './route';

export const TRAFFIC = {
  /** Most ambient cars on the High tier; the tier's density factor scales it. */
  cap: 40,
  /** Most full-physics cars at once. */
  maxPhys: 16,
  /** A car closer than this to the player (m) is a physics car; farther than `demoteDist` it goes back to a spline follower. */
  promoteDist: 82,
  demoteDist: 112,
  /** Spawn ring around the player (m). */
  spawnMin: 120,
  spawnMax: 230,
  /** A car farther than this (m) is removed once the player cannot see it; farther than `forceDespawnDist` always. */
  despawnDist: 320,
  forceDespawnDist: 450,
  /** Where the front bumper stops before the end of a lane, m. */
  stopOffset: 3.2,
  /** Cars per km at which a zone is "full", for choosing where to spawn. */
  densityRef: 14,
  /** The most cars that have been jacked or wrecked and left behind. */
  maxFree: 10,
  /** Hold a wreck this long (s) before a driver who can drive on resumes. */
  recoverS: 3.5,
  /** Entities the sim keeps free for everything else in the 256-entity snapshot. */
  entityReserve: 40,
} as const;

export type CarMode = 'kin' | 'phys' | 'free';

interface Entry {
  car: TrafficCar;
  s: number;
}

interface Obstacle {
  gap: number;
  v: number;
  /** how far to the left of the car's heading it lies (negative: to the right), m */
  lat: number;
  /** a pedestrian, a car that is not part of the traffic, or something fixed */
  kind: 'ped' | 'veh' | 'static';
  /** it is the player (on foot or in a car) */
  byPlayer: boolean;
  /** where it stands and how long it is, for edging round it */
  x: number;
  z: number;
  half: number;
}

export class TrafficCar {
  mode: CarMode = 'kin';
  edge = 0;
  s = 0;
  v = 0;
  acc = 0;
  route: number[] = [];
  dest = -1;
  readonly idm: IdmParams = { ...DEFAULT_IDM };
  speedFactor = 1;
  politeness = 0.3;
  /** will run a red light when frightened */
  reckless = false;
  readonly len: number;
  readonly width: number;
  readonly wheelbase: number;
  lc: { to: number; p: number } | null = null;
  lcCool = 0;
  /** seconds stopped at a stop line / waiting at a gate */
  dwell = 0;
  waitT = 0;
  panic = 0;
  touched = false;
  contactCool = 0;
  recoverT = 0;
  honkCool = 0;
  blockedT = 0;
  swerve = 0;
  pullOver = false;
  /** a physics car that is being driven as a spline follower for a manoeuvre it cannot drive (a tight turn or a U-turn) */
  pinned = false;
  /** edging round something parked in the lane */
  dodging = false;
  /** what it is edging round (kept until the car is by it), and how far over to stay */
  dodgeAt: { x: number; z: number; half: number; want: number; until: number } | null = null;
  stuckT = 0;
  offT = 0;
  flippedT = 0;
  reactCool = 0;
  /** game seconds until the fright from a contact wears off */
  panicUntil = 0;
  /** the pose error left over from a physics car going back to a spline: fades out */
  errX = 0;
  errZ = 0;
  errYaw = 0;
  driverId: EntityId = 0;
  /** last drawn heading and steering, for the kinematic wheels */
  yaw = 0;
  steer = 0;
  obs: Obstacle | null = null;
  obsTick = -99;
  /** seeded stream for this car's own choices */
  readonly rng: Rng;
  /** set when a jacked or taken car should be dropped from the traffic for good */
  jacked = false;
  /** why the car was handed over to the world, for tests and debugging */
  handReason = '';
  /** what limited the car's speed on the last tick: free, car, gate, obstacle (debugging) */
  why = 'free';
  /** the last verdict at a junction gate (debugging) */
  gateWhy = '';
  /** seconds spent stopped for people on a crossing; the crossing it gave way to; and the one it has given up waiting for */
  crossT = 0;
  crossWait = -1;
  crossSkip = -1;

  constructor(
    readonly serial: number,
    readonly veh: VehicleEntity,
    readonly personality: Personality,
    rng: Rng,
  ) {
    const h = veh.car.h;
    this.len = h.chassis.halfExtents[2] * 2;
    this.width = h.chassis.halfExtents[0] * 2;
    this.wheelbase = h.wheels.frontZ - h.wheels.rearZ;
    this.rng = rng;
  }
}

const tmpPt: EdgePoint = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
const tmpPt2: EdgePoint = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
const tmpPt3: EdgePoint = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
const proj = { s: 0, dist: 0 };
const tmpProj = { s: 0, dist: 0 };
const pedals = { throttle: 0, brake: 0 };

/** Rotation from a heading and pitch (nose up positive). */
function poseQuat(yaw: number, pitch: number, out: Quat): Quat {
  const cp = Math.cos(pitch);
  const fx = Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = Math.cos(yaw) * cp;
  // left = up x forward, up' = forward x left
  let lx = fz;
  let lz = -fx;
  const ll = Math.hypot(lx, lz) || 1;
  lx /= ll;
  lz /= ll;
  const ux = fy * lz;
  const uy = fz * lx - fx * lz;
  const uz = -fy * lx;
  // columns: left, up, forward
  const m00 = lx, m10 = 0, m20 = lz;
  const m01 = ux, m11 = uy, m21 = uz;
  const m02 = fx, m12 = fy, m22 = fz;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = s / 4;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = s / 4;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = s / 4;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = s / 4;
  }
  return out;
}

interface Danger {
  x: number;
  z: number;
  /** tick it started, and how far it frightens (m) and for how long (s) */
  t0: number;
  r: number;
  s: number;
}

export class TrafficManager implements Probe {
  readonly cars: TrafficCar[] = [];
  readonly arbiter: Arbiter;
  /** Cars the density asks for right now (for tests and the debug overlay). */
  target = 0;
  /** Density factor 0..1 from the graphics tier. */
  density: number;
  private readonly rng: Rng;
  private nextSerial = 1;
  private readonly edgeCars = new Map<number, Entry[]>();
  private readonly arrivals = new Map<number, number>();
  private readonly dangers: Danger[] = [];
  private readonly spotBuf: SpawnSpot[] = [];
  private readonly walkers: { x: number; z: number; vx: number; vz: number; player: boolean }[] = [];
  /** the unsignalled crossings each lane crosses (none without the walk network) */
  private readonly crossings: LaneCrossing[][] | null;
  private readonly walk: WalkGraph | undefined;
  /** Vehicles that are not driven by the traffic and stand still: parked cars, wrecks, the player's car at rest. */
  private readonly statics: { x: number; z: number; fx: number; fz: number; hl: number; hw: number; player: boolean }[] = [];
  private box: RAPIER.Cuboid | null = null;
  private rest = new Map<string, number>();
  private px = 0;
  private pz = 0;
  private camYaw = 0;
  private now = 0;
  private firstFill = true;
  /** counters for tests and reports */
  readonly stats = { spawned: 0, despawned: 0, promoted: 0, demoted: 0, honks: 0, released: 0 };

  constructor(
    private readonly sim: Simulation,
    readonly graph: LaneGraph,
    private readonly pop: TrafficPopulation,
    density = 1,
    walk?: WalkGraph,
  ) {
    this.rng = sim.rng.fork('traffic');
    this.arbiter = new Arbiter(graph);
    this.density = density;
    this.walk = walk;
    this.crossings = walk ? indexCrossings(graph, walk) : null;
  }

  /**
   * How the traffic follows a streamed city's tiles (docs/contracts/city-tiles.md section 9): a new tile's lanes get their crossings
   * indexed (a job per 400 lanes), the cars on a dropping tile go, and so do the cars whose lane went; routes stop where they would
   * have run into a dropped tile.
   */
  streamListener(): StreamListener {
    return {
      tileAdded: (_key, r) => {
        const range = r.lanes;
        if (!range || !this.crossings || !this.walk) return;
        const jobs: StreamJob[] = [];
        for (let a = range.base; a < range.base + range.n; a += 400) {
          const b = Math.min(range.base + range.n, a + 400);
          jobs.push({ name: `traffic:crossings:${a}`, cost: (b - a) * 6, run: () => (indexCrossingRange(this.graph, this.walk!, a, b, this.crossings!), true) });
        }
        return jobs;
      },
      tileDropping: (_key, rect) => {
        for (const c of [...this.cars]) {
          const p = c.veh.car.body.translation();
          if (p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ) this.remove(c);
        }
      },
      tileRemoved: () => this.pruneDead(),
    };
  }

  /** Cars on dead edges go; routes are cut before the first dead edge. */
  pruneDead() {
    const g = this.graph;
    for (const c of [...this.cars]) {
      if (c.mode !== 'free' && !g.alive[c.edge]) {
        this.remove(c);
        continue;
      }
      const k = c.route.findIndex((e) => !g.alive[e]);
      if (k >= 0) {
        c.route.length = k;
        if (c.dest >= 0 && !g.alive[c.dest]) c.dest = -1;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reading the world

  get cap(): number {
    return Math.max(0, Math.round(TRAFFIC.cap * this.density));
  }

  /** Seconds until the nearest car bound for `conn` reaches the end of its lane. */
  arrivalTime(conn: number): number {
    return this.arrivals.get(conn) ?? Infinity;
  }

  carOf(vehicleId: EntityId): TrafficCar | undefined {
    for (const c of this.cars) if (c.veh.id === vehicleId) return c;
    return undefined;
  }

  count(mode?: CarMode): number {
    let n = 0;
    for (const c of this.cars) if (!mode || c.mode === mode) n++;
    return n;
  }

  private restHeight(typeId: string): number {
    let r = this.rest.get(typeId);
    if (r === undefined) {
      r = this.sim.restHeight(HANDLING[typeId] ?? HANDLING.sedan);
      this.rest.set(typeId, r);
    }
    return r;
  }

  private player(): PedEntity {
    return this.sim.registry.get(this.sim.playerPedId) as PedEntity;
  }

  /** Feeds the events the other systems emit (called as they are emitted). */
  onEvent(e: SimEvent) {
    const tick = this.sim.tick;
    switch (e.type) {
      case 'vehicle:explode':
        this.dangers.push({ x: e.x, z: e.z, t0: tick, r: 90, s: 25 });
        break;
      case 'crime':
        this.dangers.push({ x: e.x, z: e.z, t0: tick, r: e.severity >= 3 ? 80 : 55, s: 20 });
        break;
      case 'damage':
        if (e.kind === 'melee') this.dangers.push({ x: e.x, z: e.z, t0: tick, r: 30, s: 8 });
        break;
      case 'weapon:fire': {
        // Shots: drivers within earshot floor it (or swerve); one who is shot at, or sees it close, may abandon the car.
        const hear = 70 * WEAPONS[e.weapon].hearM;
        this.dangers.push({ x: e.x, z: e.z, t0: tick, r: hear, s: 14 });
        for (const im of e.impacts) {
          if (im.kind !== 'vehicle') continue;
          const c = this.carOf(im.targetId);
          if (c) this.shotAt(c);
        }
        break;
      }
      case 'carjack': {
        const c = this.carOf(e.vehicleId);
        if (c) this.hand(c, 'jacked');
        break;
      }
      case 'vehicle:enter': {
        const c = this.carOf(e.vehicleId);
        if (c) this.release(c);
        break;
      }
      default:
        break;
    }
  }

  /** A bullet hit this traffic car: the driver panics for a good while, and the timid get out and run. */
  private shotAt(c: TrafficCar) {
    c.touched = true;
    c.panic = 1;
    c.panicUntil = this.now + 20;
    const driver = c.veh.occupantId ? (this.sim.registry.get(c.veh.occupantId) as PedEntity | undefined) : undefined;
    if (!driver || driver.role === 'player' || driver.life === 'dead' || c.mode === 'free') return;
    // Bold drivers floor it; the rest stop, get out and run. Decided by the same roll each time (the personality), not by chance per bullet.
    if (driver.brain && driver.brain.personality.courage < 0.55) {
      this.hand(c, 'wreck', 'shot-at');
      this.sim.ejectPed(driver);
      driver.brain.release();
      driver.brain.enter('flee');
      driver.brain.threat = { x: this.px, z: this.pz };
    }
  }

  // -------------------------------------------------------------------------------------------
  // The tick

  update(dt: number) {
    const sim = this.sim;
    this.now = sim.tick * SIM_DT;
    const player = this.player();
    const pc = player.controller;
    const pveh = player.vehicleId ? (sim.registry.get(player.vehicleId) as VehicleEntity | undefined) : undefined;
    if (pveh) {
      const p = pveh.car.pose();
      this.px = p.x;
      this.pz = p.z;
    } else {
      this.px = pc.x;
      this.pz = pc.z;
    }
    this.camYaw = sim.players.get(1)?.axes[Axis.Yaw] ?? 0;
    for (let i = this.dangers.length - 1; i >= 0; i--) if (sim.tick - this.dangers[i].t0 > this.dangers[i].s * 60) this.dangers.splice(i, 1);

    this.collectWalkers();
    this.collectStatics();
    if (this.firstFill || sim.tick % 24 === 0) {
      this.spawnAndDespawn();
      this.firstFill = false;
    }
    if (sim.tick % 6 === 0) this.levelOfDetail();

    // where every car is, on its lane
    for (const c of this.cars) {
      if (c.mode !== 'kin') this.readPhysState(c);
      if (c.contactCool > 0) c.contactCool -= dt;
    }
    this.sortEdges();
    this.computeArrivals();

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.veh.owner !== AI_OWNER && c.mode !== 'free') {
        this.release(c);
        continue;
      }
      if (c.mode === 'free') this.stepFree(c);
      else this.step(c, dt);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Spawn and despawn

  /** The cars the zones around the player want, from the population table. */
  private wantedCars(): number {
    const sim = this.sim;
    const slot = sim.clock.slot;
    const weekend = sim.clock.weekend;
    const spots = this.graph.spotsAround(this.px, this.pz, 0, TRAFFIC.spawnMax, this.spotBuf);
    let total = 0;
    for (const sp of spots) total += carSlot(carZoneAt(this.pop, sp.x, sp.z), slot, weekend).cars * sp.weight * 0.02;
    return total * this.density;
  }

  private spawnAndDespawn() {
    const sim = this.sim;
    // remove what is far and unseen
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const p = c.veh.car.body.translation();
      const d = Math.hypot(p.x - this.px, p.z - this.pz);
      if (c.mode === 'free') {
        // a wreck or a stuck car goes once nobody can see it
        if (c.veh.playerOwned || c.jacked) {
          if (d > 250 && !this.inView(p.x, p.z, 60) && !c.veh.playerOwned) this.remove(c);
        } else if ((d > 45 && !this.inView(p.x, p.z, 25)) || d > 180) this.remove(c);
        continue;
      }
      if (d > TRAFFIC.forceDespawnDist || (d > TRAFFIC.despawnDist && !this.inView(p.x, p.z, 40))) this.remove(c);
    }
    while (this.count('free') > TRAFFIC.maxFree) {
      const old = this.cars.find((c) => c.mode === 'free' && !this.inView(c.veh.car.body.translation().x, c.veh.car.body.translation().z, 60));
      if (!old) break;
      this.remove(old);
    }

    const target = Math.min(this.cap, Math.round(this.wantedCars()));
    this.target = target;
    const live = this.cars.filter((c) => c.mode !== 'free').length;
    if (live >= target) return;
    if (sim.registry.size > 256 - TRAFFIC.entityReserve) return;
    const budget = this.firstFill ? target - live : Math.min(2, target - live);
    for (let i = 0; i < budget; i++) this.trySpawn(this.firstFill ? 60 : TRAFFIC.spawnMin);
  }

  /** Whether a point is in front of the camera (a loose cone), within `slack` degrees of its edge. */
  private inView(x: number, z: number, slackDeg = 0): boolean {
    const d = Math.hypot(x - this.px, z - this.pz);
    if (d < 25) return true;
    // the camera looks along (-sin yaw, -cos yaw)
    const ang = Math.abs(wrapAngle(Math.atan2(x - this.px, z - this.pz) - (this.camYaw + Math.PI)));
    return ang < ((62 + slackDeg) * Math.PI) / 180;
  }

  private trySpawn(minDist: number): boolean {
    const sim = this.sim;
    const spots = this.graph.spotsAround(this.px, this.pz, minDist, TRAFFIC.spawnMax, this.spotBuf);
    if (spots.length === 0) return false;
    const slotIdx = sim.clock.slot;
    const weekend = sim.clock.weekend;
    for (let attempt = 0; attempt < 14; attempt++) {
      const sp = spots[this.rng.int(0, spots.length - 1)];
      const zone = carZoneAt(this.pop, sp.x, sp.z);
      const slot = carSlot(zone, slotIdx, weekend);
      const d = Math.hypot(sp.x - this.px, sp.z - this.pz);
      // busier roads first, and nearer the player when the cap is what limits the count
      const near = 1 - 0.45 * clamp((d - TRAFFIC.spawnMin) / (TRAFFIC.spawnMax - TRAFFIC.spawnMin), 0, 1);
      if (this.rng.next() * TRAFFIC.densityRef * 1.7 >= slot.cars * sp.weight * near) continue;
      // out of view when close; far enough out, anywhere
      if (d < 200 && this.inView(sp.x, sp.z, 12)) continue;
      // room on the lane
      const list = this.edgeCars.get(sp.edge);
      if (list && list.some((e) => Math.abs(e.s - sp.s) < 16)) continue;
      let crowded = false;
      for (const v of sim.vehicles()) {
        const b = v.car.body.translation();
        if (Math.abs(b.x - sp.x) < 9 && Math.abs(b.z - sp.z) < 9) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;
      this.spawnAt(sp.edge, sp.s, pickVehicle(this.pop, slot, this.rng));
      return true;
    }
    return false;
  }

  /** Puts a car on a lane as a spline follower, driving at about the speed of the lane. */
  spawnAt(edge: number, s: number, kind: { type: string; color: number }, init?: (c: TrafficCar) => void): TrafficCar {
    const sim = this.sim;
    const g = this.graph;
    g.posAt(edge, s, tmpPt);
    const yaw = yawFromDir(tmpPt.tx, tmpPt.tz);
    const veh = sim.spawnVehicle(kind.type, tmpPt.x, tmpPt.y, tmpPt.z, yaw, kind.color, (v) => {
      v.owner = AI_OWNER;
    });
    const serial = this.nextSerial++;
    const rng = this.rng.fork(`car:${serial}`);
    const car = new TrafficCar(serial, veh, rollPersonality(rng.fork('driver')), rng);
    car.edge = edge;
    car.s = s;
    car.speedFactor = rng.range(0.82, 1.08);
    car.politeness = rng.range(0.1, 0.6);
    car.reckless = rng.chance(0.4);
    car.idm.T = rng.range(1.2, 1.8);
    car.idm.a = rng.range(1.4, 2.0);
    car.idm.b = rng.range(1.9, 2.6);
    car.idm.s0 = rng.range(1.8, 2.8);
    car.v = Math.min(g.speed[edge] * car.speedFactor, 12) * rng.range(0.6, 0.95);
    car.yaw = yaw;
    veh.trafficCar = car;
    veh.kinematic = true;
    veh.car.body.setBodyType(sim.physics.R.RigidBodyType.KinematicPositionBased, true);
    this.cars.push(car);
    if (rng.chance(0.65)) this.pickDestination(car);
    this.ensureRoute(car);
    this.stats.spawned++;
    init?.(car);
    this.placeKinematic(car, true);
    return car;
  }

  private pickDestination(car: TrafficCar) {
    const p = car.veh.car.body.translation();
    const spots = this.graph.spotsAround(p.x, p.z, 260, 900, this.spotBuf);
    if (spots.length === 0) return;
    const danger = this.dangerOf(p.x, p.z);
    for (let i = 0; i < 4; i++) {
      const sp = spots[car.rng.int(0, spots.length - 1)];
      // frightened drivers head away
      if (danger && Math.hypot(sp.x - danger.x, sp.z - danger.z) < Math.hypot(p.x - danger.x, p.z - danger.z)) continue;
      const route = planRoute(this.graph, car.route.length ? car.route[car.route.length - 1] : car.edge, sp.edge);
      if (route && route.length) {
        car.route.push(...route);
        car.dest = sp.edge;
        return;
      }
    }
  }

  /** Removes a car and its driver from the world. */
  private remove(c: TrafficCar) {
    const sim = this.sim;
    this.arbiter.forget(c.serial);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    if (c.veh.occupantId) sim.despawn(c.veh.occupantId);
    sim.despawn(c.veh.id);
    c.veh.trafficCar = null;
    this.stats.despawned++;
  }

  /** The car stops being traffic for good (the player took it, or it was jacked). */
  private release(c: TrafficCar) {
    this.arbiter.forget(c.serial);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    const v = c.veh;
    v.trafficCar = null;
    if (v.kinematic) this.makeDynamic(c);
    this.stats.released++;
  }

  /** A jacked or wrecked car is handed over to the world: it holds still until somebody takes it. */
  private hand(c: TrafficCar, why: 'jacked' | 'wreck', reason = why as string) {
    c.handReason = reason;
    this.arbiter.forget(c.serial);
    if (c.veh.kinematic) this.makeDynamic(c);
    c.mode = 'free';
    c.jacked = why === 'jacked';
    c.lc = null;
  }

  // -------------------------------------------------------------------------------------------
  // Level of detail

  private levelOfDetail() {
    const sim = this.sim;
    let phys = this.count('phys');
    // other vehicles that move and are not ours (the player's, the police's): a spline follower near one would be a wall
    const movers: { x: number; z: number }[] = [];
    for (const v of sim.vehicles()) {
      if (v.trafficCar || v.burnt) continue;
      if (v.occupantId === 0 && v.car.speed < 1) continue;
      const b = v.car.body.translation();
      movers.push({ x: b.x, z: b.z });
    }
    const near = (x: number, z: number, r: number) => movers.some((m) => Math.hypot(m.x - x, m.z - z) < r);
    const wantPhys: { c: TrafficCar; d: number }[] = [];
    for (const c of this.cars) {
      if (c.mode === 'free') continue;
      const b = c.veh.car.body.translation();
      const dp = Math.hypot(b.x - this.px, b.z - this.pz);
      if (c.mode === 'kin') {
        if (c.pinned) continue;
        const d = near(b.x, b.z, 32) ? Math.min(dp, TRAFFIC.promoteDist - 1) : dp;
        if (d < TRAFFIC.promoteDist) wantPhys.push({ c, d });
      } else if (!c.touched && c.recoverT <= 0 && dp > TRAFFIC.demoteDist && !near(b.x, b.z, 48) && !this.arbiter.holders(c.edge).length) {
        this.demote(c);
        phys--;
      }
    }
    wantPhys.sort((a, b) => a.d - b.d);
    for (const w of wantPhys) {
      if (phys >= TRAFFIC.maxPhys) break;
      this.promote(w.c);
      phys++;
    }
  }

  /** Turns a spline follower into a physics car at the same pose and speed, with a driver at the wheel. */
  private promote(c: TrafficCar) {
    const sim = this.sim;
    const v = c.veh;
    const car = v.car;
    this.makeDynamic(c);
    // at speed along the lane
    this.graph.posAt(c.edge, c.s, tmpPt);
    const vx = Math.sin(car.yaw) * c.v;
    const vz = Math.cos(car.yaw) * c.v;
    car.body.setLinvel({ x: vx, y: 0, z: vz }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.adopt();
    c.mode = 'phys';
    if (!(v.occupantId && sim.registry.get(v.occupantId))) {
      const driver = sim.seatDriver(v);
      driver.brain = new PedBrain(c.personality, 'seated');
      c.driverId = driver.id;
    }
    c.stuckT = c.offT = 0;
    this.stats.promoted++;
  }

  private makeDynamic(c: TrafficCar) {
    c.veh.kinematic = false;
    c.veh.car.body.setBodyType(this.sim.physics.R.RigidBodyType.Dynamic, true);
  }

  private demote(c: TrafficCar, keepDriver = false) {
    const sim = this.sim;
    const v = c.veh;
    const car = v.car;
    // where it is against where the lane says: the difference fades out
    this.graph.posAt(c.edge, c.s, tmpPt);
    const p = car.body.translation();
    c.errX = p.x - tmpPt.x;
    c.errZ = p.z - tmpPt.z;
    c.errYaw = wrapAngle(car.yaw - yawFromDir(tmpPt.tx, tmpPt.tz));
    c.v = Math.max(0, car.speedForward);
    if (v.occupantId && !keepDriver) sim.despawn(v.occupantId);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.impactSpeedLoss = 0;
    v.kinematic = true;
    v.input.throttle = 0;
    v.input.brake = 0;
    v.input.handbrake = true;
    car.body.setBodyType(sim.physics.R.RigidBodyType.KinematicPositionBased, true);
    c.mode = 'kin';
    c.pinned = keepDriver;
    if (!keepDriver) c.driverId = 0;
    this.stats.demoted++;
  }

  // -------------------------------------------------------------------------------------------
  // State of the cars on their lanes

  private readPhysState(c: TrafficCar) {
    const g = this.graph;
    const car = c.veh.car;
    const p = car.body.translation();
    c.v = car.speedForward;
    g.project(c.edge, p.x, p.z, c.s, 4, 12 + Math.abs(c.v) * 0.2, proj);
    // past the end of the edge: on to the next (very short connectors are passed through at once)
    for (let guard = 0; guard < 6 && c.route.length > 0 && proj.s >= g.len[c.edge] - 0.35; guard++) {
      const here = proj.dist;
      const next = c.route[0];
      g.project(next, p.x, p.z, 0, 0, 14, tmpProj);
      if (g.len[c.edge] > 1.5 && tmpProj.dist > here + 3.5) break; // not actually there yet
      if (g.isConnector[c.edge] && !g.isConnector[next]) this.arbiter.release(c.serial);
      c.route.shift();
      c.edge = next;
      c.lc = null;
      proj.s = tmpProj.s;
      proj.dist = tmpProj.dist;
    }
    c.s = proj.s;
    c.offT = proj.dist > 5.5 && !c.lc ? c.offT + SIM_DT : 0;
  }

  private sortEdges() {
    for (const list of this.edgeCars.values()) list.length = 0;
    for (const c of this.cars) {
      this.entries(c.edge).push({ car: c, s: c.s });
      if (c.lc) {
        const g = this.graph;
        this.entries(c.lc.to).push({ car: c, s: c.s * (g.len[c.lc.to] / g.len[c.edge]) });
      }
    }
    for (const list of this.edgeCars.values()) if (list.length > 1) list.sort((a, b) => a.s - b.s || a.car.serial - b.car.serial);
  }

  private entries(edge: number): Entry[] {
    let l = this.edgeCars.get(edge);
    if (!l) this.edgeCars.set(edge, (l = []));
    return l;
  }

  private computeArrivals() {
    this.arrivals.clear();
    const g = this.graph;
    for (const c of this.cars) {
      if (c.mode === 'free' || g.isConnector[c.edge]) continue;
      const next = c.route[0];
      if (next === undefined || !g.isConnector[next]) continue;
      if (this.arbiter.reservation(c.serial) >= 0) continue;
      const d = g.len[c.edge] - c.s;
      if (d > 60) continue;
      if (c.v < 0.5 && d > 4) continue; // queued behind something, not arriving
      const t = d / Math.max(c.v, 3);
      if (t < (this.arrivals.get(next) ?? Infinity)) this.arrivals.set(next, t);
    }
  }

  private collectStatics() {
    this.statics.length = 0;
    for (const v of this.sim.vehicles()) {
      const tc = v.trafficCar;
      if (tc && tc.mode !== 'free') continue;
      if (v.car.speed > 1.5) continue;
      const b = v.car.body.translation();
      if (Math.abs(b.x - this.px) > 420 || Math.abs(b.z - this.pz) > 420) continue;
      const yaw = v.car.yaw;
      const h = v.car.h.chassis.halfExtents;
      this.statics.push({ x: b.x, z: b.z, fx: Math.sin(yaw), fz: Math.cos(yaw), hl: h[2], hw: h[0], player: v.occupantId === this.sim.playerPedId });
    }
  }

  private collectWalkers() {
    this.walkers.length = 0;
    for (const p of this.sim.peds()) {
      if (p.vehicleId || p.life === 'dead' || p.busy) continue;
      const c = p.controller;
      if (Math.abs(c.x - this.px) > 130 || Math.abs(c.z - this.pz) > 130) continue;
      this.walkers.push({ x: c.x, z: c.z, vx: c.vel.x + c.ext.x, vz: c.vel.z + c.ext.z, player: p.role === 'player' });
    }
  }

  private dangerOf(x: number, z: number): Danger | null {
    let best: Danger | null = null;
    let bd = Infinity;
    for (const d of this.dangers) {
      const dist = Math.hypot(x - d.x, z - d.z);
      if (dist < d.r && dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Routes

  private ensureRoute(c: TrafficCar) {
    const g = this.graph;
    const danger = c.panic > 0.3 ? this.dangerOf(c.veh.car.body.translation().x, c.veh.car.body.translation().z) : null;
    if (c.dest >= 0 && c.route.length === 0) {
      // arrived (or the plan ran out): a new destination, or wander
      c.dest = -1;
      if (c.rng.chance(0.65)) this.pickDestination(c);
    }
    let last = c.route.length ? c.route[c.route.length - 1] : c.edge;
    for (let guard = 0; c.route.length < 4 && guard < 8; guard++) {
      const nx = pickNext(g, last, c.rng, danger);
      if (nx < 0) break;
      c.route.push(nx);
      last = nx;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Following the lane: what's ahead

  /** The nearest car ahead on the path, as a gap (bumper to bumper) and its speed. */
  private findLeader(c: TrafficCar): { gap: number; v: number } | null {
    const g = this.graph;
    const horizon = 40 + Math.abs(c.v) * 5;
    let best: { gap: number; v: number } | null = null;
    // a car changing into our lane from beside
    if (c.lc) {
      const list = this.edgeCars.get(c.lc.to);
      if (list) {
        const sTo = c.s * (g.len[c.lc.to] / g.len[c.edge]);
        for (const e of list) {
          if (e.car === c || e.s <= sTo) continue;
          best = { gap: e.s - sTo - (c.len + e.car.len) / 2, v: e.car.v };
          break;
        }
      }
    }
    let acc = -c.s;
    let edge = c.edge;
    for (let k = 0; ; k++) {
      const list = this.edgeCars.get(edge);
      if (list) {
        for (const e of list) {
          if (e.car === c || (k === 0 && e.s <= c.s + 0.01)) continue;
          const gap = acc + e.s - (c.len + e.car.len) / 2;
          if (!best || gap < best.gap) best = { gap, v: e.car.v };
          break; // the list is sorted: the first one that counts is the nearest on this edge
        }
      }
      if (best && best.gap < acc + g.len[edge]) return best;
      acc += g.len[edge];
      if (acc > horizon || k >= c.route.length) return best;
      edge = c.route[k];
    }
  }

  /**
   * What the next junction asks of this car. Returns the distance along the path to where the car's
   * front bumper must stop, or Infinity when it may carry on. Works out the reservation too.
   */
  private gate(c: TrafficCar): number {
    const g = this.graph;
    let edge = c.edge;
    let dist = -c.s;
    let idx = 0;
    // The next lane end on the path (a car already on a connector looks at the lane after it).
    for (let guard = 0; guard < 5; guard++) {
      dist += g.len[edge];
      if (!g.isConnector[edge]) break;
      if (idx >= c.route.length) return Infinity;
      edge = c.route[idx++];
    }
    if (g.isConnector[edge]) return Infinity;
    const lane = edge;
    const conn = c.route[idx];
    if (conn === undefined || !g.isConnector[conn]) return Infinity;
    const horizon = 55 + (c.v * c.v) / 4;
    if (dist > horizon) return Infinity;
    const ctl = g.ctl[lane];
    const hasConflicts = g.conflicts[conn].length > 0;
    if (ctl === Ctl.None && !hasConflicts) return Infinity;

    const held = this.arbiter.reservation(c.serial) === conn;
    if (held) return Infinity;

    const stopLine = dist - TRAFFIC.stopOffset; // centre of the lane end minus the offset: where the front bumper stops
    const frontGap = stopLine - c.len / 2;
    const comfortable = stoppingDistance(c.v, 4) + 0.5;

    let allow = true;
    let forced = false;
    if (ctl === Ctl.Signals && g.leg[lane] >= 0) {
      const j = g.junctions[g.junction[lane]];
      const st = j ? legState(j, g.leg[lane], this.now) : 'green';
      if (st === 'red') allow = c.panic > 0.5 && c.reckless && frontGap < comfortable;
      else if (st === 'amber') allow = frontGap < comfortable;
      // in the final stretch of a green nobody enters a junction they cannot clear: the exit check below
    } else if (ctl === Ctl.Stop) {
      allow = c.dwell >= 1.1;
    }
    if (allow) {
      // the exit must have room for the car
      if (this.exitBlocked(g.to[conn], c)) allow = false;
    }
    c.gateWhy = `${ctl === Ctl.Signals ? 'signal' : ctl === Ctl.Stop ? 'stop' : 'free'} ${allow ? 'open' : 'closed'}`;
    if (allow) {
      const why = this.arbiter.why(c.serial, conn, this.now, this, c.waitT);
      allow = why === 'ok';
      if (!allow) c.gateWhy = `${why} conn ${conn} held-by ${this.arbiter.conflictingHolders(conn, c.serial).join(',')}`;
    } else {
      // can't pass the signal: stand in line for the arbitration at stop signs (arrival order)
    }
    if (!allow && frontGap < Math.max(0.3, stoppingDistance(c.v, MAX_BRAKE)) - 0.2 && !g.isConnector[c.edge]) {
      // too late to stop: take the junction (unless something holds it)
      forced = !this.arbiter.conflictHeld(conn, c.serial) && ctl !== Ctl.Stop;
      allow = forced;
    }
    if (ctl === Ctl.Stop || (!allow && frontGap < 6 && c.v < 1)) {
      if (frontGap < 2 && c.v < 0.5) {
        c.dwell += SIM_DT;
        this.arbiter.queue(c.serial, conn, this.now - c.dwell);
      }
    }
    if (allow) {
      // commit when close
      if (frontGap < Math.max(2.2, c.v * 0.7)) this.arbiter.reserve(c.serial, conn);
      return Infinity;
    }
    c.waitT += c.v < 0.5 ? SIM_DT : 0;
    return stopLine;
  }

  /**
   * Where a car must stop for people on an unsignalled crossing ahead on its path: the distance from
   * its centre to the stop, or Infinity. Only lanes (not junctions) are yielded on, and only where the
   * car can still stop comfortably; a car that has already given way to a crossing for too long skips it.
   */
  private crossingStop(c: TrafficCar): number {
    if (!this.crossings || c.mode === 'free' || this.graph.isConnector[c.edge]) return Infinity;
    const g = this.graph;
    const horizon = 60;
    let edge = c.edge;
    let dist = -c.s;
    for (let k = 0; k <= c.route.length && k < 6; k++) {
      if (!g.isConnector[edge]) {
        for (const x of this.crossings[edge]) {
          const d = dist + x.s;
          if (d < 0.5) continue;
          if (d > horizon) return Infinity;
          if (x.s < YIELD.minS || x.walk === c.crossSkip || !crossingBusy(x, this.walkers)) continue;
          const stop = d - YIELD.gap;
          if (stop - c.len / 2 < stoppingDistance(c.v, MAX_BRAKE)) return Infinity;
          c.crossWait = x.walk;
          return stop;
        }
      }
      dist += g.len[edge];
      if (k >= c.route.length) break;
      edge = c.route[k];
    }
    return Infinity;
  }

  /** Whether the lane after a junction has no room for `c` at its start. */
  private exitBlocked(outLane: number, c: TrafficCar): boolean {
    const list = this.edgeCars.get(outLane);
    if (!list) return false;
    for (const e of list) {
      if (e.car === c) continue;
      if (e.s - e.car.len / 2 < c.len + 3 && e.car.v < 2.5) return true;
      break;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // One car, one tick

  private step(c: TrafficCar, dt: number) {
    const g = this.graph;
    const sim = this.sim;
    const v = c.veh;
    const car = v.car;
    c.reactCool -= dt;
    c.honkCool -= dt;
    c.lcCool -= dt;
    this.updatePanic(c, dt);
    this.ensureRoute(c);

    // dead engine, wreck, flipped over: it is the world's now
    if (v.engineDead || v.burnt) {
      this.hand(c, 'wreck', 'engine');
      return;
    }
    if (c.mode === 'phys') {
      const pose = car.pose();
      const up = rotateVec(pose.q, 0, 1, 0);
      c.flippedT = up.y < 0.35 ? c.flippedT + dt : 0;
      if (c.flippedT > 2.5 || c.offT > 2) {
        this.hand(c, 'wreck', c.flippedT > 2.5 ? 'flipped' : 'off-lane');
        return;
      }
      this.contact(c);
      if (c.recoverT > 0) {
        c.recoverT -= dt;
        v.input.throttle = 0;
        v.input.brake = 0;
        v.input.steer = 0;
        v.input.handbrake = true;
        if (c.recoverT <= 0) c.touched = true;
        return;
      }
    }

    // a turn too tight to drive is taken as a spline follower, then the car is a physics car again
    if (c.mode === 'phys') {
      const ahead = c.route[0];
      const onTight = g.isConnector[c.edge] && g.tight[c.edge] === 1;
      const nearTight = ahead !== undefined && g.isConnector[ahead] && g.tight[ahead] === 1 && g.len[c.edge] - c.s < 9;
      if ((onTight || nearTight) && !c.touched && !c.lc) {
        this.demote(c, true);
        c.pinned = true;
      }
    } else if (c.pinned && !g.isConnector[c.edge] && c.s > 5 && !(c.route[0] !== undefined && g.isConnector[c.route[0]] && g.tight[c.route[0]] === 1)) {
      c.pinned = false;
    }

    // --- what limits speed
    const limit = g.speed[c.edge] * c.speedFactor * (1 + 0.45 * c.panic);
    let v0 = limit;
    // slow before bends and turns ahead
    {
      let d = g.len[c.edge] - c.s;
      let k = 0;
      while (d < 70 && k < c.route.length) {
        const e = c.route[k++];
        const vmax = g.isConnector[e] ? g.speed[e] : g.speed[e] * c.speedFactor;
        v0 = Math.min(v0, Math.sqrt(vmax * vmax + 2 * 2.6 * Math.max(0, d)));
        d += g.len[e];
      }
    }
    if (c.pullOver) v0 = Math.min(v0, 3);
    else if (c.dodging) v0 = Math.min(v0, 5.5);
    const idm = c.idm;
    idm.v0 = Math.max(1.5, v0);
    const panicKick = 1 + 0.7 * c.panic;
    const base = { v0: idm.v0, T: idm.T / (1 + 0.5 * c.panic), a: idm.a * panicKick, b: idm.b, s0: idm.s0 };

    let acc = freeAccel(base, c.v);
    let binding: 'free' | 'car' | 'gate' | 'crossing' | 'obstacle' = 'free';
    const lead = this.findLeader(c);
    if (lead) {
      const a = idmAccel(base, c.v, lead.gap, lead.v);
      if (a < acc) {
        acc = a;
        binding = 'car';
      }
    }
    const gateStop = this.gate(c);
    const crossStop = this.crossingStop(c);
    if (crossStop === Infinity) c.crossT = 0;
    else {
      // people on an unsignalled crossing: give way, but not for ever
      c.crossT += SIM_DT;
      if (c.crossT > YIELD.patience) {
        c.crossSkip = c.crossWait;
        c.crossT = 0;
      }
    }
    const stop = Math.min(gateStop, crossStop);
    if (stop !== Infinity) {
      // (the stop line is a thing to stop at, not a car: the stand-still gap is shorter)
      const a = idmAccel(base, c.v, Math.max(0.1, stop - c.len / 2 + idm.s0 * 0.8), 0);
      if (a < acc) {
        acc = a;
        binding = crossStop < gateStop ? 'crossing' : 'gate';
      }
    }
    if (gateStop === Infinity && !g.isConnector[c.edge]) {
      c.dwell = 0;
      c.waitT = 0;
    }
    {
      const ob = this.obstacleAhead(c);
      if (ob) {
        // edging round a parked car: it no longer blocks once the car has moved over
        const gap = c.dodging && Math.abs(c.swerve) > 0.7 && ob.kind === 'veh' ? ob.gap + 8 : ob.gap;
        const a = idmAccel(base, c.v, gap, ob.v);
        if (a < acc) {
          acc = a;
          binding = 'obstacle';
        }
        this.noteBlocked(c, ob, binding === 'obstacle', dt);
      } else c.blockedT = Math.max(0, c.blockedT - dt * 2);
      this.avoid(c);
    }
    // close up and nearly stopped: stop, rather than creep the last metre
    if (c.v < 0.7 && ((lead && lead.gap < idm.s0 + 0.9) || (stop !== Infinity && stop - c.len / 2 < 0.9))) acc = Math.min(acc, -2);
    c.acc = acc;
    c.why = binding;

    if (c.lc) this.advanceLaneChange(c, dt);
    else if (c.lcCool <= 0 && sim.tick % 9 === c.serial % 9) this.considerLaneChange(c, lead);

    if (c.mode === 'kin') this.driveKinematic(c, acc, dt);
    else this.drivePhysical(c, acc, dt);
  }

  // -------------------------------------------------------------------------------------------
  // Kinematic cars

  private driveKinematic(c: TrafficCar, acc: number, dt: number) {
    const g = this.graph;
    c.v = Math.max(0, c.v + acc * dt);
    if (c.v < 0.02 && acc < 0) c.v = 0;
    c.s += c.v * dt;
    while (c.s >= g.len[c.edge]) {
      if (c.route.length === 0) {
        // the lane runs off the map: the car is gone
        this.remove(c);
        return;
      }
      c.s -= g.len[c.edge];
      const next = c.route.shift()!;
      if (g.isConnector[c.edge] && !g.isConnector[next]) this.arbiter.release(c.serial);
      if (c.lc) {
        // changed lane while crossing the end: finish it
        c.lc = null;
      }
      c.edge = next;
    }
    this.placeKinematic(c, false, dt);
  }

  /** Writes the pose of a spline follower into its body and the fields the snapshot reads. */
  private placeKinematic(c: TrafficCar, teleport: boolean, dt = SIM_DT) {
    const g = this.graph;
    const sim = this.sim;
    const car = c.veh.car;
    g.posAt(c.edge, c.s, tmpPt);
    let x = tmpPt.x;
    let z = tmpPt.z;
    let tx = tmpPt.tx;
    let tz = tmpPt.tz;
    let y = tmpPt.y;
    // heading toward a point a wheelbase ahead along the path (into the next edges), so corners round off
    {
      const sw = c.swerve;
      c.swerve = 0;
      const ahead = this.aimPoint(c, Math.max(1.5, c.wheelbase), tmpPt2);
      c.swerve = sw;
      const hx = ahead.x - x;
      const hz = ahead.z - z;
      if (hx * hx + hz * hz > 0.04) {
        const l = Math.hypot(hx, hz);
        tx = hx / l;
        tz = hz / l;
      } else if (tx === 0 && tz === 0) {
        tx = Math.sin(c.yaw);
        tz = Math.cos(c.yaw);
      }
    }
    // edging round something in the lane (left of travel is (tz, -tx))
    if (c.swerve !== 0) {
      x += tz * c.swerve;
      z -= tx * c.swerve;
    }
    if (c.lc) {
      const t = smoothstep(0, 1, c.lc.p);
      const sTo = c.s * (g.len[c.lc.to] / g.len[c.edge]);
      g.posAt(c.lc.to, sTo, tmpPt2);
      x = lerp(x, tmpPt2.x, t);
      z = lerp(z, tmpPt2.z, t);
      y = lerp(y, tmpPt2.y, t);
      const h2x = lerp(tx, tmpPt2.tx, t);
      const h2z = lerp(tz, tmpPt2.tz, t);
      const l = Math.hypot(h2x, h2z) || 1;
      tx = h2x / l;
      tz = h2z / l;
    }
    let yaw = yawFromDir(tx, tz);
    if (c.errX !== 0 || c.errZ !== 0 || c.errYaw !== 0) {
      const f = Math.exp(-dt / 0.9);
      c.errX *= f;
      c.errZ *= f;
      c.errYaw *= f;
      if (Math.abs(c.errX) + Math.abs(c.errZ) + Math.abs(c.errYaw) < 0.01) c.errX = c.errZ = c.errYaw = 0;
      x += c.errX;
      z += c.errZ;
      yaw += c.errYaw;
    }
    // the road surface under the car (decks carry their own height)
    const onDeck = g.bridge[c.edge] === 1;
    const rest = this.restHeight(c.veh.typeId) - 0.005; // where a car's suspension settles on flat ground
    const ground = onDeck ? y : sim.groundAt(x, z);
    const gy = onDeck ? y : ground;
    const half = c.wheelbase * 0.5;
    const yF = onDeck ? y : sim.groundAt(x + Math.sin(yaw) * half, z + Math.cos(yaw) * half);
    const yB = onDeck ? y : sim.groundAt(x - Math.sin(yaw) * half, z - Math.cos(yaw) * half);
    const pitch = Math.atan2(yF - yB, c.wheelbase);
    const q = poseQuat(yaw, pitch, { x: 0, y: 0, z: 0, w: 1 });
    const py = gy + rest;
    const body = car.body;
    if (teleport) {
      body.setTranslation({ x, y: py, z }, true);
      body.setRotation(q, true);
    } else {
      body.setNextKinematicTranslation({ x, y: py, z });
      body.setNextKinematicRotation(q);
    }
    // what the snapshot and the lights read
    const turn = wrapAngle(yaw - c.yaw) / Math.max(dt, 1e-3);
    c.yaw = yaw;
    const steer = clamp(Math.atan2(c.wheelbase * turn, Math.max(c.v, 0.5)), -0.55, 0.55);
    c.steer += (steer - c.steer) * Math.min(1, dt * 10);
    car.speedForward = c.v;
    car.speed = c.v;
    car.steerAngle = c.steer;
    car.throttleApplied = c.acc > 0.3 ? clamp(c.acc / 2, 0, 1) : 0;
    car.braking = c.acc < -1.2 || (c.v < 0.3 && c.acc <= 0.05);
    car.reversing = false;
    car.handbraking = false;
    car.skidding = false;
    car.airborne = false;
    const r = car.h.wheels.radius;
    const rest0 = car.h.suspension.travel * car.h.suspension.restRatio;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      w.steer = w.front ? c.steer : 0;
      w.roll = (w.roll + (c.v / r) * dt) % (Math.PI * 2);
      w.length = rest0;
      w.slip = 0;
      w.grounded = true;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Physics cars

  /** Where along the path to aim, m ahead of the car (crossing into the next edges). */
  private aimPoint(c: TrafficCar, dist: number, out: EdgePoint): EdgePoint {
    const g = this.graph;
    let edge = c.edge;
    let s = c.s + dist;
    let k = 0;
    while (s > g.len[edge] && k < c.route.length) {
      s -= g.len[edge];
      edge = c.route[k++];
    }
    g.posAt(edge, Math.min(s, g.len[edge]), out);
    if (c.lc && edge === c.edge) {
      const t = smoothstep(0, 1, c.lc.p);
      const sTo = Math.min(g.len[c.lc.to], s * (g.len[c.lc.to] / g.len[c.edge]));
      g.posAt(c.lc.to, sTo, tmpPt3);
      out.x = lerp(out.x, tmpPt3.x, t);
      out.z = lerp(out.z, tmpPt3.z, t);
    }
    // a swerve moves the aim sideways (left of travel is +x' = (tz, -tx))
    if (c.swerve !== 0) {
      out.x += out.tz * c.swerve;
      out.z -= out.tx * c.swerve;
    }
    return out;
  }

  private drivePhysical(c: TrafficCar, acc: number, dt: number) {
    const g = this.graph;
    const v = c.veh;
    const car = v.car;
    const h = car.h;
    const pose = car.pose();
    const speed = car.speedForward;
    // steering by pure pursuit on the lane
    const look = g.isConnector[c.edge] ? clamp(2.4 + Math.abs(speed) * 0.35, 3.2, 9) : clamp(3.5 + Math.abs(speed) * 0.45, 4.5, 16);
    const aim = this.aimPoint(c, look, tmpPt);
    const lock = steerLock(speed, h.steering);
    const steer = steerCommand(pursuitAngle({ x: pose.x, z: pose.z, yaw: car.yaw, speed }, aim, c.wheelbase), lock);
    // pedals: ask for the speed this tick's acceleration leads to
    let want = Math.max(0, speed + acc * 0.45);
    // creep forward when the model says there is room: a held handbrake would keep the car at the standstill gap for good
    if (acc > 0.1 && speed < 3) want = Math.max(want, speed + 1.1);
    const input = v.input;
    if (want < 0.25 && Math.abs(speed) < 1.6) {
      input.throttle = 0;
      input.brake = 0;
      input.handbrake = true;
    } else {
      pedalsFor(want, speed, pedals);
      // a firm stop when the model asks for hard braking
      if (acc < -3) pedals.brake = Math.max(pedals.brake, clamp(-acc / MAX_BRAKE, 0, 1));
      if (speed < 1.2) pedals.brake = Math.min(pedals.brake, 0); // never let the brake pedal reverse the car
      input.throttle = pedals.throttle;
      input.brake = pedals.brake;
      input.handbrake = false;
    }
    input.steer = steer;
    // stuck: wanting to go and not going
    // (waiting at a gate or behind a car is not being stuck; an obstacle that never goes away is)
    const waiting = c.why === 'gate' || c.why === 'car';
    if (acc > 0.05 && Math.abs(speed) < 0.3 && !c.lc && !waiting) c.stuckT += dt;
    else c.stuckT = Math.max(0, c.stuckT - dt);
    if (c.stuckT > 25) this.hand(c, 'wreck', 'stuck');
  }

  /** A hit: the car keeps driving if it can, after a pause; either way it stays a physics car. */
  private contact(c: TrafficCar) {
    const car = c.veh.car;
    if (car.impactSpeedLoss < 1.8 || c.contactCool > 0) return;
    c.contactCool = 0.8;
    c.touched = true;
    c.panic = 1;
    c.panicUntil = this.now + 12;
    if (car.impactSpeedLoss >= 4.5) c.recoverT = TRAFFIC.recoverS;
  }

  // -------------------------------------------------------------------------------------------
  // Obstacles beyond the lane model

  private obstacleAhead(c: TrafficCar): Obstacle | null {
    const sim = this.sim;
    if (c.mode === 'kin') return (c.obs = this.staticAhead(c));
    if (sim.tick - c.obsTick < 3) return c.obs;
    c.obsTick = sim.tick;
    const R = sim.physics.R;
    const car = c.veh.car;
    const pose = car.pose();
    const yaw = car.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const speed = Math.max(0, car.speedForward);
    const look = clamp(8 + speed * 2.8, 12, 45);
    const front = c.len / 2;
    let best: Obstacle | null = null;

    // vehicles that are not part of the lane model (the player's, the police's, parked, wrecked): a box swept along the nose
    this.box ??= new R.Cuboid(1, 0.45, 0.15);
    const shape = this.box;
    shape.halfExtents = { x: c.width * 0.4, y: 0.45, z: 0.15 };
    const origin = { x: pose.x + fx * (front - 0.1), y: pose.y + 0.5, z: pose.z + fz * (front - 0.1) };
    const hit = sim.physics.world.castShape(origin, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, { x: fx, y: 0, z: fz }, shape, 0, look, true, undefined, GROUPS.vehicleQuery, undefined, car.body);
    if (hit) {
      const parent = hit.collider.parent();
      let ours = false;
      if (parent) for (const o of this.cars) if (o !== c && o.mode !== 'free' && o.veh.car.body.handle === parent.handle) { ours = true; break; }
      if (parent && !ours) {
        const lv = parent.linvel();
        const pt = parent.translation();
        let byPlayer = false;
        for (const o of sim.vehicles()) if (o.car.body.handle === parent.handle) { byPlayer = o.occupantId === sim.playerPedId; break; }
        best = { gap: Math.max(0.05, hit.time_of_impact), v: lv.x * fx + lv.z * fz, kind: 'veh', lat: (pt.x - pose.x) * fz - (pt.z - pose.z) * fx, byPlayer, x: pt.x, z: pt.z, half: 2.3 };
      }
    }

    // pedestrians (the player on foot too): a person in the lane, or about to step into it
    const half = c.width * 0.5 + 0.5;
    for (const w of this.walkers) {
      const dx = w.x - pose.x;
      const dz = w.z - pose.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < front - 0.2 || ahead > look + front) continue;
      const lat = dx * fz - dz * fx;
      const vlat = w.vx * fz - w.vz * fx;
      const t = Math.min(2, (ahead - front) / Math.max(speed, 2));
      if (Math.abs(lat) > half && Math.abs(lat + vlat * t) > half) continue;
      const gap = Math.max(0.05, ahead - front - 0.35);
      if (!best || gap < best.gap) best = { gap, v: 0, kind: 'ped', lat, byPlayer: w.player, x: w.x, z: w.z, half: 0.4 };
    }
    c.obs = best;
    return best;
  }

  /** The spline follower's version of `obstacleAhead`: parked cars and wrecks in or beside its lane, by geometry alone. */
  private staticAhead(c: TrafficCar): Obstacle | null {
    if (this.statics.length === 0) return null;
    const b = c.veh.car.body.translation();
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const look = clamp(8 + c.v * 2.8, 12, 45);
    const front = c.len / 2;
    let best: Obstacle | null = null;
    for (const o of this.statics) {
      const dx = o.x - b.x;
      const dz = o.z - b.z;
      if (Math.abs(dx) > look + 8 || Math.abs(dz) > look + 8) continue;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0) continue;
      const lat = dx * fz - dz * fx;
      // the extent of the other car along and across our heading
      const cos = Math.abs(o.fx * fx + o.fz * fz);
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      const along = o.hl * cos + o.hw * sin;
      const across = o.hl * sin + o.hw * cos;
      if (Math.abs(lat) > across + c.width * 0.5 + 0.08) continue;
      const gap = ahead - along - front;
      if (gap > look || gap < -2) continue;
      if (!best || gap < best.gap) best = { gap: Math.max(0.05, gap), v: 0, kind: 'veh', lat, byPlayer: o.player, x: o.x, z: o.z, half: o.hl };
    }
    return best;
  }

  private noteBlocked(c: TrafficCar, ob: Obstacle, binding: boolean, dt: number) {
    if (binding && ob.byPlayer && c.v < 0.6 && ob.gap < 9) c.blockedT += dt;
    else c.blockedT = Math.max(0, c.blockedT - dt);
    if (c.blockedT > 2.4 && c.honkCool <= 0) {
      c.honkCool = 3 + c.rng.range(0, 2);
      this.stats.honks++;
      const p = c.veh.car.body.translation();
      this.sim.emit({ type: 'traffic:honk', tick: this.sim.tick, vehicleId: c.veh.id, x: p.x, z: p.z });
    }
  }

  /** Swerves or brakes hard for a car coming at this one, and edges over for a police car with its lights on. */
  private avoid(c: TrafficCar) {
    const sim = this.sim;
    const car = c.veh.car;
    const pose = car.pose();
    const yaw = car.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    let swerve = 0;
    let emergency = false;
    c.pullOver = false;
    // only cars with real bodies see what is coming at them; spline followers are far from anything that moves
    for (const o of c.mode === 'phys' ? sim.vehicles() : []) {
      if (o === c.veh || o.burnt) continue;
      const other = o.trafficCar;
      if (other && other.mode !== 'free') continue; // the lane model keeps traffic apart
      const op = o.car.body.translation();
      const dx = op.x - pose.x;
      const dz = op.z - pose.z;
      const d = Math.hypot(dx, dz);
      if (d > 45) continue;
      const ov = o.car.body.linvel();
      // police with lights on, behind and closing: pull over
      if (o.police && o.lightbar) {
        const back = dx * fx + dz * fz;
        const lat = dx * fz - dz * fx;
        const closing = (ov.x - car.body.linvel().x) * -dx + (ov.z - car.body.linvel().z) * -dz;
        if (back < 8 && back > -45 && Math.abs(lat) < 9 && closing > 0) {
          c.pullOver = true;
          swerve = this.pullOverSide(c, lat);
          if (c.reactCool <= 0) this.react(c, 'pullover');
        }
        continue;
      }
      // anything moving that is coming at us: closest approach in the next two seconds (what stands still is edged round)
      if (Math.hypot(ov.x, ov.z) < 1.5) continue;
      const rvx = ov.x - car.body.linvel().x;
      const rvz = ov.z - car.body.linvel().z;
      const rv2 = rvx * rvx + rvz * rvz;
      if (rv2 < 4) continue;
      const tca = clamp(-(dx * rvx + dz * rvz) / rv2, 0, 2.2);
      const cx = dx + rvx * tca;
      const cz = dz + rvz * tca;
      if (Math.hypot(cx, cz) > 2.9) continue;
      const ahead = dx * fx + dz * fz;
      if (ahead < -1) continue;
      emergency = true;
      const lat = cx * fz - cz * fx;
      swerve = lat > 0 ? -1.4 : 1.4;
    }
    // something parked or stopped in the lane, on the right: edge round it, if the road to the left is clear
    c.dodging = false;
    const ob = c.obs;
    // (a car with the player in it is waited behind, and honked at, for a while before it is gone round)
    const patient = !ob || !ob.byPlayer || c.blockedT > 5.5 || c.dodgeAt !== null;
    if (!emergency && !c.pullOver && patient && ob && ob.kind === 'veh' && Math.abs(ob.v) < 1.2 && ob.lat < 0.8 && c.v < 14 && (ob.gap < 18 || (c.swerve > 0.2 && ob.gap < 25))) {
      // far enough to the left that the car clears it, with a little to spare
      const lp = this.graph.posAt(c.edge, c.s, tmpPt);
      const laneLat = (ob.x - lp.x) * lp.tz - (ob.z - lp.z) * lp.tx; // where it lies against the lane's centre
      const want = Math.max(0.6, Math.min(2.0, c.width * 0.5 + 0.92 + 0.2 + laneLat));
      c.dodgeAt = { x: ob.x, z: ob.z, half: ob.half, want, until: this.now + 25 };
    }
    // keep out to the side until the car is by it (the box that finds it no longer does once the car has moved over)
    const d = c.dodgeAt;
    if (d) {
      const rel = (pose.x - d.x) * fx + (pose.z - d.z) * fz;
      if (this.now > d.until || rel > d.half + c.len / 2 + 1.3 || emergency || c.pullOver) c.dodgeAt = null;
      else {
        c.dodging = true;
        swerve = d.want;
      }
    }
    if (emergency) {
      c.acc = Math.min(c.acc, -MAX_BRAKE);
      if (c.reactCool <= 0) this.react(c, swerve !== 0 ? 'swerve' : 'brake');
    }
    c.swerve += (swerve - c.swerve) * 0.12;
    if (Math.abs(c.swerve) < 0.02) c.swerve = 0;
  }

  /**
   * Which way to edge over for a police car with its lights on that is `lat` m to the car's left (negative: right):
   * toward the kerb. The right kerb in the rightmost lane; on a one-way street the leftmost lane's kerb is on the
   * left; in the lanes between (or the leftmost lane of a two-way street, whose left is the centre line) away from the
   * police. The offset is bigger where there is a lane to give up.
   */
  pullOverSide(c: TrafficCar, lat: number): number {
    const g = this.graph;
    const e = c.edge;
    const lane = g.isConnector[e] ? -1 : e;
    if (lane < 0) return lat >= 0 ? -1.3 : 1.3;
    const rightKerb = g.right[lane] < 0;
    const leftKerb = g.left[lane] < 0 && g.oneWay[lane] === 1;
    // Police to the right of a car that has the left kerb: go left; otherwise right where a right kerb is.
    if (rightKerb && !(leftKerb && lat < -1.5)) return -1.3;
    if (leftKerb) return 1.3;
    // (the inner lane of a two-way street has the centre line on its left: never that way)
    if (g.left[lane] < 0) return -1.6;
    return lat >= 0 ? -1.6 : 1.6;
  }

  private react(c: TrafficCar, reaction: 'brake' | 'swerve' | 'flee' | 'pullover') {
    c.reactCool = 4;
    const p = c.veh.car.body.translation();
    this.sim.emit({ type: 'traffic:react', tick: this.sim.tick, vehicleId: c.veh.id, reaction, x: p.x, z: p.z });
  }

  // -------------------------------------------------------------------------------------------
  // Fear

  private updatePanic(c: TrafficCar, dt: number) {
    const sim = this.sim;
    const b = c.veh.car.body.translation();
    let target = 0;
    const d = this.dangerOf(b.x, b.z);
    if (d) {
      target = 1 - 0.5 * (Math.hypot(b.x - d.x, b.z - d.z) / d.r);
    }
    // the heat is on and the player is near: nervous, not fleeing
    if (sim.law.heat.level > 0 && Math.hypot(b.x - this.px, b.z - this.pz) < 70) target = Math.max(target, 0.4 + 0.1 * sim.law.heat.level);
    if (this.now < c.panicUntil) target = Math.max(target, 0.8);
    if (target > c.panic) {
      if (c.panic < 0.3 && target >= 0.3 && c.reactCool <= 0) this.react(c, 'flee');
      c.panic = Math.min(1, c.panic + dt * 3);
    } else c.panic = Math.max(target, c.panic - dt * 0.15);
  }

  // -------------------------------------------------------------------------------------------
  // Lane changes (MOBIL)

  private considerLaneChange(c: TrafficCar, lead: { gap: number; v: number } | null) {
    const g = this.graph;
    if (g.isConnector[c.edge] || c.v < 4 || c.mode === 'free') return;
    const left = g.len[c.edge] - c.s;
    if (c.s < 10 || left < 40) return;
    const connNow = c.route[0];
    if (connNow === undefined || !g.isConnector[connNow]) return;
    const dummy: IdmParams = { ...c.idm };
    dummy.v0 = Math.max(1.5, g.speed[c.edge] * c.speedFactor);
    const accOld = lead ? idmAccel(dummy, c.v, lead.gap, lead.v) : freeAccel(dummy, c.v);
    for (const side of [g.right[c.edge], g.left[c.edge]]) {
      if (side < 0 || !g.main[side]) continue;
      const isRight = side === g.right[c.edge];
      // the new lane must still lead where the route goes
      const keep = this.matchingConnector(side, connNow);
      if (keep < 0) continue;
      const sTo = c.s * (g.len[side] / g.len[c.edge]);
      const list = this.edgeCars.get(side);
      let ahead: Entry | null = null;
      let behind: Entry | null = null;
      if (list) {
        for (const e of list) {
          if (e.car === c) continue;
          if (e.s > sTo) { ahead = e; break; }
          behind = e;
        }
      }
      const gapAhead = ahead ? ahead.s - sTo - (c.len + ahead.car.len) / 2 : Infinity;
      const gapBehind = behind ? sTo - behind.s - (c.len + behind.car.len) / 2 : Infinity;
      if (gapAhead < 6 || gapBehind < 6) continue;
      const accNew = ahead ? idmAccel(dummy, c.v, gapAhead, ahead.car.v) : freeAccel(dummy, c.v);
      let nfBefore = 0;
      let nfAfter = 0;
      if (behind) {
        const p = behind.car.idm;
        nfBefore = ahead ? idmAccel(p, behind.car.v, sTo + gapAhead + c.len - behind.s - (behind.car.len + c.len) / 2 - c.len, ahead.car.v) : freeAccel(p, behind.car.v);
        nfAfter = idmAccel(p, behind.car.v, gapBehind, c.v);
      }
      // the follower in the lane being left
      const list0 = this.edgeCars.get(c.edge);
      let ofBefore = 0;
      let ofAfter = 0;
      if (list0) {
        let f: Entry | null = null;
        for (const e of list0) {
          if (e.car === c) break;
          f = e;
        }
        if (f) {
          const gapToMe = c.s - f.s - (c.len + f.car.len) / 2;
          ofBefore = idmAccel(f.car.idm, f.car.v, gapToMe, c.v);
          ofAfter = lead ? idmAccel(f.car.idm, f.car.v, gapToMe + c.len + lead.gap, lead.v) : freeAccel(f.car.idm, f.car.v);
        }
      }
      const go = mobilChange({
        meOld: accOld, meNew: accNew, newFollowerBefore: nfBefore, newFollowerAfter: nfAfter, oldFollowerBefore: ofBefore, oldFollowerAfter: ofAfter,
        politeness: c.politeness, threshold: 0.4, bias: isRight ? 0.15 : -0.05, safe: 4,
      });
      if (go) {
        this.startLaneChange(c, side, keep);
        return;
      }
    }
    c.lcCool = 1.5;
  }

  /** The connector leaving `lane` that goes where `conn` goes (same junction, same turn, same out road), or -1. */
  private matchingConnector(lane: number, conn: number): number {
    const g = this.graph;
    const want = g.to[conn];
    for (const n of g.next[lane]) {
      if (!g.isConnector[n]) continue;
      if (g.to[n] === want) return n;
    }
    // a different lane of the same road out of the junction is as good
    for (const n of g.next[lane]) {
      if (!g.isConnector[n] || g.junction[n] !== g.junction[conn] || g.turn[n] !== g.turn[conn]) continue;
      if (g.cls[g.to[n]] === g.cls[want] && g.leg[n] === g.leg[conn] && this.sameRoadOut(g.to[n], want)) return n;
    }
    return -1;
  }

  private sameRoadOut(a: number, b: number): boolean {
    const g = this.graph;
    const pa = g.pts[a];
    const pb = g.pts[b];
    return Math.hypot(pa[0] - pb[0], pa[2] - pb[2]) < 9;
  }

  private startLaneChange(c: TrafficCar, to: number, conn: number) {
    const g = this.graph;
    c.lc = { to, p: 0 };
    // the route now leaves from the new lane
    const old = c.route[0];
    c.route[0] = conn;
    if (g.to[conn] !== g.to[old]) {
      c.route.length = 1;
      c.route.push(g.to[conn]);
      if (c.dest >= 0) {
        const plan = planRoute(g, g.to[conn], c.dest);
        if (plan) c.route.push(...plan);
        else c.dest = -1;
      }
    }
    const reserved = this.arbiter.reservation(c.serial);
    if (reserved >= 0) this.arbiter.release(c.serial);
  }

  private advanceLaneChange(c: TrafficCar, dt: number) {
    const lc = c.lc!;
    lc.p += dt / 2.6;
    if (lc.p >= 1) {
      const g = this.graph;
      c.s = c.s * (g.len[lc.to] / g.len[c.edge]);
      c.edge = lc.to;
      c.lc = null;
      c.lcCool = 3 + c.rng.range(0, 3);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Cars left behind

  private stepFree(c: TrafficCar) {
    const v = c.veh;
    // nobody drives it: brakes on, unless the player has taken it
    if (v.owner === AI_OWNER) {
      v.input.throttle = 0;
      v.input.brake = 0;
      v.input.steer = 0;
      v.input.handbrake = true;
    } else if (v.occupantId && (this.sim.registry.get(v.occupantId) as PedEntity | undefined)?.role === 'player') {
      this.release(c);
      return;
    }
    // a driver the damage system threw out of a dead car is on foot, still thinking they are seated: they run
    if (c.driverId) {
      const d = this.sim.registry.get(c.driverId) as PedEntity | undefined;
      if (!d) c.driverId = 0;
      else if (!d.vehicleId && d.brain?.state === 'seated' && !d.busy) {
        d.brain.release();
        c.driverId = 0;
      }
    }
    // a driver left in a car that was wrecked gets out and runs
    const driver = v.occupantId ? (this.sim.registry.get(v.occupantId) as PedEntity | undefined) : undefined;
    if (driver && driver.role !== 'player' && !c.jacked && (c.flippedT > 2.5 || v.engineDead || v.burnt)) {
      this.sim.ejectPed(driver);
    }
  }
}
