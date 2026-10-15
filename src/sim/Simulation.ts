/**
 * The headless game simulation. It owns the physics world, the entity registry and the players,
 * advances them one fixed tick at a time, and writes snapshots. It imports no three.js and no DOM,
 * so it runs the same in a Web Worker, on the main thread (loopback), in Node tests and, later, on
 * a server.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { EntityRegistry, EntityKind, type EntityId } from '../shared/entities';
import { PAINTS, OUTFIT_COUNT, type EntityDef } from '../shared/entityDefs';
import { doorGeometry } from '../shared/doors';
import { DEFAULT_VEHICLE, HANDLING } from '../shared/handling';
import { quatFromYaw, rotateVec, yawFromDir, yawFromTileHeading, yawOfQuat } from '../shared/math';
import { AXIS_COUNT, SIM_DT, type InputCommand, type SimEvent } from '../shared/protocol';
import type { LawData } from '../shared/law';
import { MAX_HEALTH } from './entities';
import { COMBAT, damagePed, knockDown } from './combat/damage';
import { WRECK } from './combat/vehicleDamage';
import { blastFalloff, overlayOf } from './combat/systems';
import { leaveVehicle } from './exit';
import { Law } from './law/Law';
import { GENERIC_LAW, loadLawForTile } from './law/cityPack';
import { PoliceManager } from './police/PoliceSystem';
import { Rng } from '../shared/rng';
import { E, H, HeatPhase, PedFlag, SnapFlag, VehicleFlag, WHEEL_FLOATS, MAX_ENTITIES, SnapshotView } from '../shared/snapshot';
import type { TileData } from '../shared/tile';
import { PedController } from './character/PedController';
import type { CarjackState } from './carjack';
import { PedEntity, PlayerSlot, VehicleEntity, type SimEntity } from './entities';
import { PedBrain, rollPersonality, type Reaction } from './npc/brain';
import { GROUPS, initRapier } from './physics/rapier';
import { defaultSystems, type SimSystem } from './systems';
import { RaycastCar } from './vehicles/RaycastCar';
import { planParking } from './streets/parking';
import { PhysicsWorld } from './World';
import { GameClock, type ClockOptions } from './clock';
import { LaneGraph } from './traffic/LaneGraph';
import { TrafficManager } from './traffic/TrafficManager';
import { GENERIC_TRAFFIC_POPULATION, loadTrafficPopulationForTile, type TrafficPopulation } from './traffic/population';
import { AmbientPeds } from './peds/AmbientPeds';
import { WalkGraph } from './peds/graph';
import { GENERIC_POPULATION, loadPopulationForTile, type PopulationData } from './peds/population';
import { ScenarioIndex } from './peds/scenarios';

export interface SimOptions {
  seed: number;
  tile: TileData;
  /** Key into the handling table. */
  vehicleType?: string;
  /** Where the player starts: the tile's player spawn (default), beside the empty car, or beside the occupied car. */
  start?: 'spawn' | 'car' | 'jack';
  /** Legacy alias for `start: 'car'`. */
  startAtVehicle?: boolean;
  /** Whether the starting car has a stand-in driver. Defaults to yes unless the player starts at an empty car (`start: 'car'`). */
  driver?: boolean;
  /** Forces how drivers react to a carjacking. Left out, each one rolls a personality from the seed. */
  driverMood?: Reaction;
  /** Empty cars to park along nearby curbs (default 6). */
  parkedCars?: number;
  /** Idle pedestrians standing about on nearby sidewalks (default 0). */
  bystanders?: number;
  /** The player's starting armour (default 0). */
  armour?: number;
  /** The law tables (a city pack's jurisdictions). Left out, the pack of the tile's city is loaded, or a generic one. */
  law?: LawData;
  /** Ambient pedestrians from the tile's walk network (default off here, on in the game; see `SimInit.ambientPeds`). Needs `paths.json`. */
  ambientPeds?: boolean;
  /** Most ambient pedestrians at once (default 60). */
  pedBudget?: number;
  /** The population table (a city pack's `population.json`). Left out, the generic one. */
  population?: PopulationData;
  /** Ambient traffic density, 0 to 1 (default 0: none here, the game asks for it by graphics tier). Needs `lanes.json`. */
  traffic?: number;
  /** The traffic half of the population table. Left out, the generic one. */
  trafficPopulation?: TrafficPopulation;
  /** Start time and pace of the game clock (default Wednesday 14:00, half a game minute per real second). */
  clock?: ClockOptions;
}

/** Where the player is while the WASTED or BUSTED screen runs. */
export interface PlayerLife {
  mode: 'alive' | 'wasted' | 'busted';
  /** Seconds into it. */
  t: number;
}

/** Colour of the car the player starts beside. */
const HERO_PAINT = 0xb23a2e;
/** Types the parked cars cycle through, besides the starting car's. */
const PARKED_TYPES = ['sedan', 'coupe', 'pickup'] as const;

const clampArmour = (a: number) => Math.max(0, Math.min(100, a));

/** The generic law, for a sim built without `await Simulation.create` and without a pack. */
function loadedLaw(_opts: SimOptions): LawData {
  return GENERIC_LAW;
}

export class Simulation {
  tick = 0;
  readonly dt = SIM_DT;
  /** Time of day and day of the week; population and lighting follow it. */
  clock!: GameClock;
  readonly registry = new EntityRegistry<SimEntity>();
  readonly players = new Map<number, PlayerSlot>();
  readonly rng: Rng;
  readonly physics: PhysicsWorld;
  readonly vehicleType: string;
  readonly start: 'spawn' | 'car' | 'jack';
  readonly driverMood: Reaction | undefined;
  private readonly hasDriver: boolean;
  /** Carjackings in progress. */
  readonly carjacks: CarjackState[] = [];
  /** Peds still to be removed at the end of the tick. */
  private readonly toDespawn = new Set<EntityId>();
  private announce = false;
  private readonly systems: SimSystem[];
  private events: SimEvent[] = [];
  /** The same events, for the rules module to read once per tick. */
  private ruleEvents: SimEvent[] = [];
  readonly law: Law;
  readonly police: PoliceManager;
  /** The ambient pedestrian director, when the tile has a walk network and ambient peds are on. */
  readonly ambient: AmbientPeds | null = null;
  /** Ambient traffic, when the tile has a lane graph and a density was asked for. */
  readonly traffic: TrafficManager | null = null;
  /** Listeners that see every event as it is emitted. */
  private readonly eventTaps: ((e: SimEvent) => void)[] = [];
  readonly fireRng: Rng;
  private readonly plateRng: Rng;
  private readonly lives = new Map<number, PlayerLife>();
  private queued: { slot: number; cmd: InputCommand }[] = [];

  constructor(R: typeof RAPIER, opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.physics = new PhysicsWorld(R, opts.tile);
    this.start = opts.start ?? (opts.startAtVehicle ? 'car' : 'spawn');
    this.driverMood = opts.driverMood;
    this.hasDriver = opts.driver ?? this.start !== 'car';
    this.vehicleType = opts.vehicleType && HANDLING[opts.vehicleType] ? opts.vehicleType : DEFAULT_VEHICLE;
    this.systems = defaultSystems();
    this.fireRng = this.rng.fork('fire');
    this.plateRng = this.rng.fork('plates');
    this.clock = new GameClock(opts.clock);
    this.law = new Law(this, opts.law ?? loadedLaw(opts));
    this.police = new PoliceManager(this);
    this.spawnWorld(opts.parkedCars ?? 6, opts.bystanders ?? 0, opts.armour ?? 0);
    if (opts.ambientPeds && opts.tile.paths) {
      this.ambient = new AmbientPeds(this, {
        graph: new WalkGraph(opts.tile.paths),
        scenarios: new ScenarioIndex(opts.tile.scenarios),
        population: opts.population ?? GENERIC_POPULATION,
        junctions: opts.tile.junctions,
        roads: opts.tile.roads,
        budget: opts.pedBudget,
      });
    }
    if ((opts.traffic ?? 0) > 0 && opts.tile.lanes) {
      const graph = new LaneGraph(opts.tile.lanes);
      if (graph.usable) {
        this.traffic = new TrafficManager(this, graph, opts.trafficPopulation ?? GENERIC_TRAFFIC_POPULATION, Math.min(1, opts.traffic!));
        this.eventTaps.push((e) => this.traffic?.onEvent(e));
      }
    }
    this.announce = true;
  }

  static async create(opts: SimOptions): Promise<Simulation> {
    const law = opts.law ?? (await loadLawForTile(opts.tile.manifest.id));
    const population = opts.population ?? (opts.ambientPeds ? await loadPopulationForTile(opts.tile.manifest.id) : undefined);
    const trafficPopulation = opts.trafficPopulation ?? ((opts.traffic ?? 0) > 0 ? await loadTrafficPopulationForTile(opts.tile.manifest.id) : undefined);
    return new Simulation(await initRapier(), { ...opts, law, population, trafficPopulation });
  }

  get tile(): TileData {
    return this.physics.tile;
  }

  groundAt(x: number, z: number): number {
    return this.physics.groundHeight(x, z);
  }

  private spawnWorld(parked: number, bystanders: number, armour: number) {
    const sp = this.tile.manifest.spawns;
    const yaw = yawFromTileHeading(sp.vehicle.heading);
    const hero = this.spawnVehicle(this.vehicleType, sp.vehicle.x, Math.max(sp.vehicle.y, this.groundAt(sp.vehicle.x, sp.vehicle.z)), sp.vehicle.z, yaw, HERO_PAINT);
    this.vehicleId = hero.id;

    // The player: on the sidewalk at the tile's spawn, or at the driver's door for quick tests.
    let px = sp.player.x;
    let pz = sp.player.z;
    let py = sp.player.y;
    // On foot at the spawn, facing the car.
    let pyaw = yawFromDir(sp.vehicle.x - px, sp.vehicle.z - pz);
    if (this.start !== 'spawn') {
      const stand = doorGeometry(hero.car.h).stand;
      const w = rotateVec(hero.car.pose().q, stand.x, 0, stand.z);
      px = sp.vehicle.x + w.x;
      pz = sp.vehicle.z + w.z;
      py = -Infinity;
      pyaw = yaw - Math.PI / 2;
    }
    const ped = this.addPed(px, Math.max(py, this.groundAt(px, pz)), pz, pyaw, 0, false, (p) => {
      p.role = 'player';
      p.armour = clampArmour(armour);
    });
    ped.owner = 1;
    this.players.set(1, new PlayerSlot(1, ped.id));

    if (this.hasDriver) this.seatDriver(hero);
    if (parked > 0) this.parkCars(parked);
    if (bystanders > 0) this.placeBystanders(bystanders);
  }

  /** Where the body origin sits above flat ground when the car is at rest on its suspension. */
  restHeight(h: (typeof HANDLING)[string]): number {
    const sus = h.suspension;
    const omega = 2 * Math.PI * sus.frequencyHz;
    const len = sus.travel * sus.restRatio - 9.81 / (omega * omega);
    return h.wheels.radius + len - h.wheels.mountY;
  }

  /** Adds a car resting on the ground at (x, z). `groundY` is the road surface there. */
  spawnVehicle(typeId: string, x: number, groundY: number, z: number, yaw: number, color: number, init?: (v: VehicleEntity) => void): VehicleEntity {
    const h = HANDLING[typeId] ?? HANDLING[DEFAULT_VEHICLE];
    const y = Math.max(groundY, this.groundAt(x, z)) + this.restHeight(h) + 0.05;
    const reg = this.registry;
    const car = new RaycastCar(this.physics.R, this.physics.world, h, { x, y, z, yaw });
    const v = reg.add(new VehicleEntity(reg.allocateId(), h.id, car, color)) as VehicleEntity;
    v.home = { x, y, z, yaw };
    v.plate = this.makePlate();
    init?.(v);
    this.announceSpawn(v);
    return v;
  }

  /** Adds a ped standing with its feet at (x, y, z). Non-players get a brain with a seeded personality. */
  addPed(x: number, y: number, z: number, yaw: number, outfit: number, npc: boolean, init?: (p: PedEntity) => void): PedEntity {
    const reg = this.registry;
    const ctrl = new PedController(this.physics.R, this.physics.world, x, y + 0.1, z, yaw);
    const ped = reg.add(new PedEntity(reg.allocateId(), ctrl)) as PedEntity;
    ped.outfit = outfit % OUTFIT_COUNT;
    if (npc) ped.brain = new PedBrain(rollPersonality(this.rng.fork(`ped:${ped.id}`), this.driverMood));
    init?.(ped);
    this.announceSpawn(ped);
    return ped;
  }

  /** Puts a stand-in driver at the wheel of a car, idling. */
  seatDriver(veh: VehicleEntity): PedEntity {
    const p = veh.car.pose();
    const outfit = 1 + (this.registry.size % (OUTFIT_COUNT - 1));
    const ped = this.addPed(p.x, p.y, p.z, veh.car.yaw, outfit, true);
    ped.brain!.enter('seated');
    ped.controller.setEnabled(false);
    ped.vehicleId = veh.id;
    veh.occupantId = ped.id;
    return ped;
  }

  /** Leaves empty cars along nearby curbs, of mixed types, wherever the world has room. */
  private parkCars(count: number) {
    const tile = this.tile;
    const roads = tile.roads ?? [];
    if (roads.length === 0) return;
    const sp = tile.manifest.spawns;
    const rng = this.rng.fork('parking');
    const slots = planParking(
      roads,
      {
        around: sp.player,
        avoid: [
          { x: sp.vehicle.x, z: sp.vehicle.z, r: 9 },
          { x: sp.player.x, z: sp.player.z, r: 5 },
        ],
        count: count * 3,
      },
      rng,
    );
    const R = this.physics.R;
    const types = [...PARKED_TYPES];
    for (let i = types.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [types[i], types[j]] = [types[j], types[i]];
    }
    let placed = 0;
    for (const slot of slots) {
      if (placed >= count) break;
      const typeId = types[placed % types.length];
      const h = HANDLING[typeId];
      const [hx, , hz] = h.chassis.halfExtents;
      const gy = this.groundAt(slot.x, slot.z);
      // The ground under the whole car must be nearly level.
      const f = rotateVec(quatFromYaw(slot.yaw), 0, 0, hz);
      const l = rotateVec(quatFromYaw(slot.yaw), hx, 0, 0);
      const spread = Math.max(
        ...[[f.x, f.z], [-f.x, -f.z], [l.x, l.z], [-l.x, -l.z]].map(([dx, dz]) => Math.abs(this.groundAt(slot.x + dx, slot.z + dz) - gy)),
      );
      if (spread > 0.3) continue;
      // And clear of buildings, signs and other cars.
      const shape = new R.Cuboid(hx + 0.15, 0.7, hz + 0.15);
      const q = quatFromYaw(slot.yaw);
      const blocked = this.physics.world.intersectionWithShape({ x: slot.x, y: gy + 1.05, z: slot.z }, q, shape, undefined, GROUPS.actorQuery);
      if (blocked) continue;
      this.spawnVehicle(typeId, slot.x, gy, slot.z, slot.yaw, PAINTS[rng.int(0, PAINTS.length - 1)]);
      placed++;
    }
  }

  /** The definition of an entity (what the client needs to draw it). */
  defOf(e: SimEntity): EntityDef {
    if (e instanceof VehicleEntity) return { id: e.id, kind: EntityKind.Vehicle, typeId: e.typeId, color: e.color, plate: e.plate, ...(e.police ? { police: e.police } : {}) };
    return { id: e.id, kind: EntityKind.Ped, outfit: e.outfit, player: e.role === 'player', ...(e.officer ? { police: { agency: e.officer.agency, uniform: e.officer.uniform } } : {}) };
  }

  /** Definitions of everything that exists, in creation order. */
  entityDefs(): EntityDef[] {
    const out: EntityDef[] = [];
    for (const e of this.registry.values()) out.push(this.defOf(e));
    return out;
  }

  private announceSpawn(e: SimEntity) {
    if (this.announce) this.emit({ type: 'entity:spawn', tick: this.tick, def: this.defOf(e) });
  }

  /** Removes a ped or a car from the world at the end of the tick. */
  despawn(id: EntityId) {
    this.toDespawn.add(id);
  }

  private flushDespawns() {
    for (const id of this.toDespawn) {
      const e = this.registry.get(id);
      if (!e) continue;
      if (e instanceof PedEntity) {
        if (e.vehicleId) {
          const v = this.registry.get(e.vehicleId) as VehicleEntity | undefined;
          if (v && v.occupantId === id) v.occupantId = 0;
        }
        e.controller.dispose();
      } else {
        e.car.dispose();
      }
      this.registry.remove(id);
      this.emit({ type: 'entity:despawn', tick: this.tick, id });
    }
    this.toDespawn.clear();
  }

  /** The nearest human player's position (the car's, when driving), for pedestrians to react to. */
  playerPosition(slot = 1): { x: number; y: number; z: number } {
    const ped = this.registry.get(this.players.get(slot)!.pedId) as PedEntity;
    return { x: ped.controller.x, y: ped.controller.y, z: ped.controller.z };
  }

  /** Whether a carjack is using this car right now. */
  isReserved(vehicleId: EntityId): boolean {
    return this.carjacks.some((c) => c.vehicleId === vehicleId);
  }

  vehicleId: EntityId = 0;

  get playerPedId(): EntityId {
    return this.players.get(1)!.pedId;
  }

  *vehicles(): IterableIterator<VehicleEntity> {
    for (const e of this.registry.values()) if (e.kind === EntityKind.Vehicle) yield e as VehicleEntity;
  }

  emit(e: SimEvent) {
    this.events.push(e);
    this.ruleEvents.push(e);
    this.ambient?.onEvent(e);
    for (const tap of this.eventTaps) tap(e);
  }

  /** The events since the rules module last looked (it looks once a tick). */
  takeRuleEvents(): SimEvent[] {
    if (this.ruleEvents.length === 0) return this.ruleEvents;
    const out = this.ruleEvents;
    this.ruleEvents = [];
    return out;
  }

  *peds(): IterableIterator<PedEntity> {
    for (const e of this.registry.values()) if (e.kind === EntityKind.Ped) yield e as PedEntity;
  }

  lifeOf(slot: number): PlayerLife {
    let l = this.lives.get(slot);
    if (!l) this.lives.set(slot, (l = { mode: 'alive', t: 0 }));
    return l;
  }

  /** A Georgia-style plate: three letters, four digits. */
  private makePlate(): string {
    const r = this.plateRng;
    const L = () => String.fromCharCode(65 + r.int(0, 25));
    return `${L()}${L()}${L()}${r.int(1000, 9999)}`;
  }

  /** Events produced since the last call. */
  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return this.events;
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Queues a command for the next tick. Commands apply in arrival order; stale ones are dropped. */
  pushInput(slot: number, cmd: InputCommand) {
    this.queued.push({ slot, cmd });
  }

  private applyQueuedInput() {
    for (const { slot, cmd } of this.queued) {
      const p = this.players.get(slot);
      if (!p || cmd.tick < p.ack) continue;
      p.ack = cmd.tick;
      // A press that came and went between two ticks still counts.
      p.edges |= cmd.buttons & ~p.prevButtons;
      p.prevButtons = cmd.buttons;
      p.buttons = cmd.buttons;
      p.axes = cmd.axes.length === AXIS_COUNT ? cmd.axes : [...cmd.axes, ...new Array(AXIS_COUNT).fill(0)].slice(0, AXIS_COUNT);
    }
    this.queued.length = 0;
  }

  /** Advances the world by one fixed tick. */
  step() {
    this.applyQueuedInput();
    this.tick++;
    this.clock.step(this.dt);
    for (const s of this.systems) s.fixedUpdate(this, this.dt);
    if (this.toDespawn.size) this.flushDespawns();
  }

  /** Puts a ped that is sitting in a car onto the ground beside it. */
  ejectPed(ped: PedEntity) {
    const v = ped.vehicleId ? (this.registry.get(ped.vehicleId) as VehicleEntity | undefined) : undefined;
    if (v) leaveVehicle(this, ped, v);
  }

  /** Damages a car's body and engine, and reports it. */
  damageVehicle(v: VehicleEntity, body: number, engine: number, sourceId: EntityId) {
    if (v.burnt || (body <= 0 && engine <= 0)) return;
    v.health = Math.max(-200, v.health - body);
    v.engine = Math.max(-500, v.engine - engine);
    this.emit({ type: 'vehicle:damage', tick: this.tick, vehicleId: v.id, amount: body, body: v.health, engine: v.engine, sourceId });
  }

  /** The stand-in explosion: a flash, a blast that hurts what is near, and a burnt-out shell that never drives again. */
  explodeVehicle(v: VehicleEntity) {
    if (v.burnt) return;
    v.burnt = true;
    v.onFire = false;
    v.engineDead = true;
    v.smoking = true;
    v.health = 0;
    v.engine = Math.min(v.engine, 0);
    const p = v.car.pose();
    this.emit({ type: 'vehicle:explode', tick: this.tick, vehicleId: v.id, x: p.x, y: p.y, z: p.z });
    v.car.body.applyImpulse({ x: 0, y: v.car.h.mass * 3.5, z: 0 }, true);
    for (const ped of this.peds()) {
      if (ped.life === 'dead') continue;
      const c = ped.controller;
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const f = blastFalloff(Math.hypot(dx, dz, c.y - p.y));
      if (f <= 0) continue;
      const inside = ped.vehicleId === v.id;
      const d = Math.hypot(dx, dz) || 1;
      if (!inside) {
        const r = damagePed(this, ped, WRECK.blastDamage * f, 'explosion', 0, v.id);
        if (r.fatal) c.launch((dx / d) * 6 * f, 3 * f, (dz / d) * 6 * f);
        else knockDown(this, ped, 2.5, (dx / d) * 7 * f, (dz / d) * 7 * f, 3.5 * f);
      } else {
        damagePed(this, ped, WRECK.blastDamage * 2, 'explosion', 0, v.id);
      }
    }
    for (const o of this.vehicles()) {
      if (o === v || o.burnt) continue;
      const q = o.car.pose();
      const f = blastFalloff(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
      if (f > 0) this.damageVehicle(o, WRECK.blastDamage * WRECK.blastCar * 3 * f, WRECK.blastDamage * 4 * f, 0);
    }
  }

  /** The player was arrested by an officer: the booking screen runs, then the respawn. */
  beginBusted(slot: number, officerId: EntityId) {
    const life = this.lifeOf(slot);
    if (life.mode !== 'alive') return;
    const ped = this.registry.get(this.players.get(slot)!.pedId) as PedEntity;
    life.mode = 'busted';
    life.t = 0;
    ped.melee = null;
    this.emit({ type: 'player:busted', tick: this.tick, pedId: ped.id, officerId });
  }

  /** The stand-in for a hospital or a police station: back to the tile's player spawn, healed, with the heat gone. */
  respawnPlayer(slot: number, reason: 'wasted' | 'busted') {
    const life = this.lifeOf(slot);
    const ped = this.registry.get(this.players.get(slot)!.pedId) as PedEntity;
    if (ped.vehicleId) this.ejectPed(ped);
    const sp = this.tile.manifest.spawns.player;
    const y = Math.max(sp.y, this.groundAt(sp.x, sp.z)) + 0.1;
    ped.controller.teleport(sp.x, y, sp.z);
    ped.health = MAX_HEALTH;
    ped.armour = 0;
    ped.life = 'alive';
    ped.downT = 0;
    ped.melee = null;
    ped.airVy = 0;
    ped.busy = false;
    life.mode = 'alive';
    life.t = 0;
    this.law.clear(reason);
    this.police.clearAll();
    this.emit({ type: 'player:respawn', tick: this.tick, pedId: ped.id, reason, x: sp.x, y, z: sp.z });
  }

  /** Stands idle pedestrians on sidewalks near the player's spawn: witnesses, and something to punch or run over. */
  private placeBystanders(count: number) {
    const roads = this.tile.roads ?? [];
    const sp = this.tile.manifest.spawns;
    const rng = this.rng.fork('bystanders');
    const slots = planParking(
      roads,
      { around: sp.player, avoid: [{ x: sp.vehicle.x, z: sp.vehicle.z, r: 6 }, { x: sp.player.x, z: sp.player.z, r: 4 }], count: count * 4, minDist: 12, maxDist: 70 },
      rng,
    );
    let placed = 0;
    for (const slot of slots) {
      if (placed >= count) break;
      // Stand on the kerb side of the slot, off the car line.
      const x = slot.x - Math.cos(slot.yaw) * 2.6;
      const z = slot.z + Math.sin(slot.yaw) * 2.6;
      const gy = this.groundAt(x, z);
      if (Math.abs(gy - this.groundAt(slot.x, slot.z)) > 0.6) continue;
      const capsule = new this.physics.R.Capsule(0.55, 0.32);
      if (this.physics.world.intersectionWithShape({ x, y: gy + 0.95, z }, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, GROUPS.actorQuery)) continue;
      const ped = this.addPed(x, gy, z, rng.range(-Math.PI, Math.PI), 1 + (placed % (OUTFIT_COUNT - 1)), true);
      ped.brain!.enter('idle');
      placed++;
    }
  }

  respawnVehicle(v: VehicleEntity) {
    const h = v.home;
    const y = Math.max(h.y, this.groundAt(h.x, h.z)) + this.restHeight(v.car.h) + 0.05;
    v.car.teleport(h.x, y, h.z, h.yaw);
  }

  respawnPed(p: PedEntity) {
    const sp = this.tile.manifest.spawns.player;
    p.controller.teleport(sp.x, Math.max(sp.y, this.groundAt(sp.x, sp.z)) + 0.1, sp.z);
  }

  /** Writes the current state into a snapshot view. */
  writeSnapshot(view: SnapshotView) {
    const u = view.u32;
    const f = view.f32;
    const player = this.players.get(1)!;
    const ped = this.registry.get(player.pedId) as PedEntity;
    u[H.Tick] = this.tick;
    u[H.Ack] = player.ack;
    u[H.Controlled] = ped.vehicleId || ped.id;
    u[H.Flags] = ped.vehicleId ? SnapFlag.InVehicle : 0;
    f[H.CamClear] = player.camClear;
    u[H.PlayerPed] = ped.id;
    f[H.Health] = ped.health;
    f[H.Armour] = ped.armour;
    const heat = this.law.heat;
    u[H.Heat] = heat.level;
    u[H.HeatPhase] = heat.phase === 'reported' ? HeatPhase.Reported : heat.phase === 'seen' ? HeatPhase.Seen : heat.phase === 'lost' ? HeatPhase.Lost : HeatPhase.None;
    const life = this.lifeOf(1);
    u[H.Overlay] = overlayOf(life.mode);
    f[H.OverlayT] = life.t;
    f[H.Cooldown] = heat.cooldownFrac;
    f[H.ClockMinutes] = this.clock.minutes;
    u[H.Day] = this.clock.day;
    let n = 0;
    for (const e of this.registry.values()) {
      if (n >= MAX_ENTITIES) break;
      const o = view.at(n++);
      u[o + E.Id] = e.id;
      u[o + E.Kind] = e.kind;
      if (e instanceof PedEntity) this.writePed(view, o, e);
      else this.writeVehicle(view, o, e as VehicleEntity);
    }
    u[H.Count] = n;
  }

  private writePed(view: SnapshotView, o: number, e: PedEntity) {
    const f = view.f32;
    const c = e.controller;
    f[o + E.Px] = c.x;
    f[o + E.Py] = c.y;
    f[o + E.Pz] = c.z;
    const q = quatFromYaw(c.yaw);
    f[o + E.Qx] = q.x;
    f[o + E.Qy] = q.y;
    f[o + E.Qz] = q.z;
    f[o + E.Qw] = q.w;
    f[o + E.Vx] = c.vel.x;
    f[o + E.Vy] = c.vy;
    f[o + E.Vz] = c.vel.z;
    const b = e.brain;
    view.u32[o + E.Flags] =
      (c.grounded ? PedFlag.Grounded : 0) |
      (c.sprinting ? PedFlag.Sprinting : 0) |
      (e.vehicleId ? PedFlag.InVehicle : 0) |
      (e.role !== 'player' ? PedFlag.Npc : 0) |
      (e.role === 'police' ? PedFlag.Police : 0) |
      (e.life === 'downed' ? PedFlag.Downed : 0) |
      (e.life === 'dead' ? PedFlag.Dead : 0) |
      (e.melee ? PedFlag.Punching : 0) |
      (b?.state === 'flee' ? PedFlag.Fleeing : 0) |
      (b?.state === 'fight' ? PedFlag.Fighting : 0) |
      (b?.state === 'dragged' ? PedFlag.Dragged : 0) |
      (e.busy ? PedFlag.Busy : 0) |
      ((e.pose & 7) << PedFlag.PoseShift);
    f[o + E.Speed] = c.speed;
    f[o + E.Aux0] = c.yaw;
    f[o + E.Aux1] = e.melee ? Math.min(1, e.melee.t / COMBAT.swingTime) : (b?.swing ?? 0);
    f[o + E.Health] = e.health;
    f[o + E.Health2] = e.armour;
  }

  private writeVehicle(view: SnapshotView, o: number, e: VehicleEntity) {
    const f = view.f32;
    const car = e.car;
    const b = car.body;
    const t = b.translation();
    const r = b.rotation();
    const v = b.linvel();
    f[o + E.Px] = t.x;
    f[o + E.Py] = t.y;
    f[o + E.Pz] = t.z;
    f[o + E.Qx] = r.x;
    f[o + E.Qy] = r.y;
    f[o + E.Qz] = r.z;
    f[o + E.Qw] = r.w;
    f[o + E.Vx] = v.x;
    f[o + E.Vy] = v.y;
    f[o + E.Vz] = v.z;
    view.u32[o + E.Flags] =
      (e.occupantId ? VehicleFlag.Occupied : 0) |
      (car.handbraking ? VehicleFlag.Handbraking : 0) |
      (car.braking ? VehicleFlag.Braking : 0) |
      (car.reversing ? VehicleFlag.Reversing : 0) |
      (car.skidding ? VehicleFlag.Skidding : 0) |
      (car.airborne ? VehicleFlag.Airborne : 0) |
      (e.doorOpen ? VehicleFlag.DoorOpen : 0) |
      (e.smoking ? VehicleFlag.Smoking : 0) |
      (e.engineDead ? VehicleFlag.EngineDead : 0) |
      (e.onFire ? VehicleFlag.OnFire : 0) |
      (e.burnt ? VehicleFlag.Burnt : 0) |
      (e.police ? VehicleFlag.Police : 0) |
      (e.lightbar ? VehicleFlag.Lightbar : 0) |
      (e.trafficCar ? VehicleFlag.Traffic : 0);
    f[o + E.Health] = e.health;
    f[o + E.Health2] = e.engine;
    f[o + E.Aux2] = e.onFire ? Math.min(1, e.burnT / e.burnFor) : 0;
    f[o + E.Speed] = car.speedForward;
    f[o + E.Aux0] = car.steerAngle;
    f[o + E.Aux1] = car.throttleApplied;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const k = o + E.Wheels + i * WHEEL_FLOATS;
      f[k] = w.steer;
      f[k + 1] = w.roll;
      f[k + 2] = w.length;
      f[k + 3] = w.slip;
    }
  }

  /** Yaw of the vehicle (convenience for tests and tools). */
  vehicleYaw(): number {
    const v = this.registry.get(this.vehicleId) as VehicleEntity;
    return yawOfQuat(v.car.body.rotation());
  }
}
