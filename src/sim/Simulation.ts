/**
 * The headless game simulation. It owns the physics world, the entity registry and the players,
 * advances them one fixed tick at a time, and writes snapshots. It imports no three.js and no DOM,
 * so it runs the same in a Web Worker, on the main thread (loopback), in Node tests and, later, on
 * a server.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { EntityRegistry, EntityKind, type EntityId } from '../shared/entities';
import { DEFAULT_VEHICLE, HANDLING } from '../shared/handling';
import { quatFromYaw, yawFromTileHeading, yawOfQuat } from '../shared/math';
import { AXIS_COUNT, SIM_DT, type InputCommand, type SimEvent } from '../shared/protocol';
import { Rng } from '../shared/rng';
import { E, H, PedFlag, SnapFlag, VehicleFlag, WHEEL_FLOATS, MAX_ENTITIES, SnapshotView } from '../shared/snapshot';
import type { TileData } from '../shared/tile';
import { PedController } from './character/PedController';
import { PedEntity, PlayerSlot, VehicleEntity, type SimEntity } from './entities';
import { initRapier } from './physics/rapier';
import { defaultSystems, type SimSystem } from './systems';
import { RaycastCar } from './vehicles/RaycastCar';
import { PhysicsWorld } from './World';

export interface SimOptions {
  seed: number;
  tile: TileData;
  /** Key into the handling table. */
  vehicleType?: string;
  /** Start the player beside the vehicle instead of at the tile's player spawn. */
  startAtVehicle?: boolean;
}

export class Simulation {
  tick = 0;
  readonly dt = SIM_DT;
  readonly registry = new EntityRegistry<SimEntity>();
  readonly players = new Map<number, PlayerSlot>();
  readonly rng: Rng;
  readonly physics: PhysicsWorld;
  readonly vehicleType: string;
  private readonly startAtVehicle: boolean;
  private readonly systems: SimSystem[];
  private events: SimEvent[] = [];
  private queued: { slot: number; cmd: InputCommand }[] = [];

  constructor(R: typeof RAPIER, opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.physics = new PhysicsWorld(R, opts.tile);
    this.startAtVehicle = !!opts.startAtVehicle;
    this.vehicleType = opts.vehicleType && HANDLING[opts.vehicleType] ? opts.vehicleType : DEFAULT_VEHICLE;
    this.systems = defaultSystems();
    this.spawnWorld();
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

  private spawnWorld() {
    const R = this.physics.R;
    const world = this.physics.world;
    const sp = this.tile.manifest.spawns;
    const reg = this.registry;

    const vy = Math.max(sp.vehicle.y, this.groundAt(sp.vehicle.x, sp.vehicle.z));
    const vh = HANDLING[this.vehicleType];
    const spawnY = vy + this.restHeight(vh) + 0.05;
    const car = new RaycastCar(R, world, vh, { x: sp.vehicle.x, y: spawnY, z: sp.vehicle.z, yaw: yawFromTileHeading(sp.vehicle.heading) });
    const vehicle = reg.add(new VehicleEntity(reg.allocateId(), this.vehicleType, car)) as VehicleEntity;

    const vyaw = yawFromTileHeading(sp.vehicle.heading);
    // Beside the driver's door (the car's left), when asked to start next to it.
    const px = this.startAtVehicle ? sp.vehicle.x + Math.cos(vyaw) * 2.6 : sp.player.x;
    const pz = this.startAtVehicle ? sp.vehicle.z - Math.sin(vyaw) * 2.6 : sp.player.z;
    const py = Math.max(this.startAtVehicle ? -Infinity : sp.player.y, this.groundAt(px, pz));
    const ctrl = new PedController(R, world, px, py + 0.1, pz, vyaw);
    const ped = reg.add(new PedEntity(reg.allocateId(), ctrl)) as PedEntity;
    ped.owner = 1;
    this.players.set(1, new PlayerSlot(1, ped.id));
    this.vehicleId = vehicle.id;
  }

  /** Where the body origin sits above flat ground when the car is at rest on its suspension. */
  private restHeight(h: (typeof HANDLING)[string]): number {
    const sus = h.suspension;
    const omega = 2 * Math.PI * sus.frequencyHz;
    const len = sus.travel * sus.restRatio - 9.81 / (omega * omega);
    return h.wheels.radius + len - h.wheels.mountY;
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
  }

  respawnVehicle(v: VehicleEntity) {
    const sp = this.tile.manifest.spawns.vehicle;
    const y = Math.max(sp.y, this.groundAt(sp.x, sp.z)) + this.restHeight(v.car.h) + 0.05;
    v.car.teleport(sp.x, y, sp.z, yawFromTileHeading(sp.heading));
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
    view.u32[o + E.Flags] = (c.grounded ? PedFlag.Grounded : 0) | (c.sprinting ? PedFlag.Sprinting : 0) | (e.vehicleId ? PedFlag.InVehicle : 0);
    f[o + E.Speed] = c.speed;
    f[o + E.Aux0] = c.yaw;
    f[o + E.Aux1] = 0;
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
      (car.airborne ? VehicleFlag.Airborne : 0);
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
