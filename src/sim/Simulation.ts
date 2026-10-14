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
import { Rng } from '../shared/rng';
import { E, H, PedFlag, SnapFlag, VehicleFlag, WHEEL_FLOATS, MAX_ENTITIES, SnapshotView } from '../shared/snapshot';
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
}

/** Colour of the car the player starts beside. */
const HERO_PAINT = 0xb23a2e;
/** Types the parked cars cycle through, besides the starting car's. */
const PARKED_TYPES = ['sedan', 'coupe', 'pickup'] as const;

export class Simulation {
  tick = 0;
  readonly dt = SIM_DT;
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
  private queued: { slot: number; cmd: InputCommand }[] = [];

  constructor(R: typeof RAPIER, opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.physics = new PhysicsWorld(R, opts.tile);
    this.start = opts.start ?? (opts.startAtVehicle ? 'car' : 'spawn');
    this.driverMood = opts.driverMood;
    this.hasDriver = opts.driver ?? this.start !== 'car';
    this.vehicleType = opts.vehicleType && HANDLING[opts.vehicleType] ? opts.vehicleType : DEFAULT_VEHICLE;
    this.systems = defaultSystems();
    this.spawnWorld(opts.parkedCars ?? 6);
    this.announce = true;
  }

  static async create(opts: SimOptions): Promise<Simulation> {
    return new Simulation(await initRapier(), opts);
  }

  get tile(): TileData {
    return this.physics.tile;
  }

  private groundAt(x: number, z: number): number {
    return this.physics.groundHeight(x, z);
  }

  private spawnWorld(parked: number) {
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
    const ped = this.addPed(px, Math.max(py, this.groundAt(px, pz)), pz, pyaw, 0, false);
    ped.owner = 1;
    this.players.set(1, new PlayerSlot(1, ped.id));

    if (this.hasDriver) this.seatDriver(hero);
    if (parked > 0) this.parkCars(parked);
  }

  /** Where the body origin sits above flat ground when the car is at rest on its suspension. */
  private restHeight(h: (typeof HANDLING)[string]): number {
    const sus = h.suspension;
    const omega = 2 * Math.PI * sus.frequencyHz;
    const len = sus.travel * sus.restRatio - 9.81 / (omega * omega);
    return h.wheels.radius + len - h.wheels.mountY;
  }

  /** Adds a car resting on the ground at (x, z). `groundY` is the road surface there. */
  spawnVehicle(typeId: string, x: number, groundY: number, z: number, yaw: number, color: number): VehicleEntity {
    const h = HANDLING[typeId] ?? HANDLING[DEFAULT_VEHICLE];
    const y = Math.max(groundY, this.groundAt(x, z)) + this.restHeight(h) + 0.05;
    const reg = this.registry;
    const car = new RaycastCar(this.physics.R, this.physics.world, h, { x, y, z, yaw });
    const v = reg.add(new VehicleEntity(reg.allocateId(), h.id, car, color)) as VehicleEntity;
    v.home = { x, y, z, yaw };
    this.announceSpawn(v);
    return v;
  }

  /** Adds a ped standing with its feet at (x, y, z). Non-players get a brain with a seeded personality. */
  addPed(x: number, y: number, z: number, yaw: number, outfit: number, npc: boolean): PedEntity {
    const reg = this.registry;
    const ctrl = new PedController(this.physics.R, this.physics.world, x, y + 0.1, z, yaw);
    const ped = reg.add(new PedEntity(reg.allocateId(), ctrl)) as PedEntity;
    ped.outfit = outfit % OUTFIT_COUNT;
    if (npc) ped.brain = new PedBrain(rollPersonality(this.rng.fork(`ped:${ped.id}`), this.driverMood));
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
    if (e instanceof VehicleEntity) return { id: e.id, kind: EntityKind.Vehicle, typeId: e.typeId, color: e.color };
    return { id: e.id, kind: EntityKind.Ped, outfit: e.outfit, player: e.brain === null };
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
    for (const s of this.systems) s.fixedUpdate(this, this.dt);
    if (this.toDespawn.size) this.flushDespawns();
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
      (b ? PedFlag.Npc : 0) |
      (b?.state === 'flee' ? PedFlag.Fleeing : 0) |
      (b?.state === 'fight' ? PedFlag.Fighting : 0) |
      (b?.state === 'dragged' ? PedFlag.Dragged : 0) |
      (e.busy ? PedFlag.Busy : 0);
    f[o + E.Speed] = c.speed;
    f[o + E.Aux0] = c.yaw;
    f[o + E.Aux1] = b?.swing ?? 0;
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
      (e.doorOpen ? VehicleFlag.DoorOpen : 0);
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
