/**
 * The client's end of the simulation: turns input into commands, feeds snapshots to the
 * interpolator, and publishes what the rest of the client needs to know (`game.view`).
 */
import type { EntityId } from '../../shared/entities';
import type { EntityDef } from '../../shared/entityDefs';
import { AXIS_COUNT, Axis, Button, type InputCommand, type SimEvent } from '../../shared/protocol';
import { PedFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import { blendEntity, newEntityState, SnapshotInterpolator, type EntityState, type Sample } from './Interpolator';

export interface ViewState {
  /** The interpolated world, once snapshots have arrived. */
  sample: Sample | null;
  /** Interpolated state of the player's ped and of every entity by id (reused objects). */
  entities: Map<EntityId, EntityState>;
  ped: EntityState | null;
  /** The vehicle the player drives, or the nearest one when on foot. */
  vehicle: EntityState | null;
  /** What each entity is (vehicle type and paint, ped outfit), from the sim's spawn definitions. */
  defs: Map<EntityId, EntityDef>;
  /** The entity the camera follows. */
  controlled: EntityState | null;
  inVehicle: boolean;
  /** Clear length of the camera arm reported by the sim, m. */
  camClear: number;
  /** The player's health and armour, the heat level (0 to 6) and its phase, and the WASTED or BUSTED overlay (see snapshot.ts). */
  health: number;
  armour: number;
  heat: number;
  heatPhase: number;
  overlay: number;
  overlayT: number;
  /** 0 to 1: how far the heat has cooled toward clearing. */
  cooldown: number;
  /** Newest snapshot tick and the last input tick the sim has applied. */
  tick: number;
  ack: number;
  /** Round trip in input ticks, a rough latency figure. */
  lagTicks: number;
}

declare module '../Game' {
  interface Game {
    net: NetSystem;
    view: ViewState;
    /** Subscribers to sim events (HUD, audio later). */
    onSimEvent(fn: (e: SimEvent) => void): void;
  }
}

/** Cap on how often commands are sent, ms. Display refresh rates above 60 Hz do not help the sim. */
const MIN_SEND_GAP = 14;

export class NetSystem implements System {
  readonly name = 'net';
  readonly priority = 10;
  readonly interpolator = new SnapshotInterpolator(2);
  private readonly sample: Sample = {} as Sample;
  private lastSent: InputCommand | null = null;
  private lastSendAt = -Infinity;
  private listeners: Array<(e: SimEvent) => void> = [];
  private pool = new Map<EntityId, EntityState>();
  /** Sent-command count, for diagnostics. */
  sent = 0;

  constructor(private readonly game: Game) {
    game.net = this;
    game.view = {
      sample: null, entities: new Map(), ped: null, vehicle: null, defs: new Map(), controlled: null, inVehicle: false, camClear: 99, health: 100, armour: 0, heat: 0, heatPhase: 0, overlay: 0, overlayT: 0, cooldown: 0, tick: 0, ack: 0, lagTicks: 0,
    };
    game.onSimEvent = (fn) => this.listeners.push(fn);
    for (const d of game.ready.entities ?? []) game.view.defs.set(d.id, d);
  }

  update(dt: number) {
    const g = this.game;
    const now = performance.now();
    for (const s of g.transport.drainSnapshots()) this.interpolator.push(s, now);
    for (const e of g.transport.drainEvents()) {
      if (e.type === 'entity:spawn') g.view.defs.set(e.def.id, e.def);
      else if (e.type === 'entity:despawn') {
        g.view.defs.delete(e.id);
        this.pool.delete(e.id);
      }
      for (const fn of this.listeners) fn(e);
    }

    const newest = this.interpolator.newest;
    if (!newest) return;
    this.send(now, dt);

    const v = g.view;
    v.tick = newest.tick;
    v.ack = newest.ack;
    v.lagTicks = Math.max(0, this.cmdTick - newest.ack);
    v.camClear = newest.camClear;
    v.inVehicle = newest.inVehicle;
    v.health = newest.health;
    v.armour = newest.armour;
    v.heat = newest.heat;
    v.heatPhase = newest.heatPhase;
    v.overlay = newest.overlay;
    v.overlayT = newest.overlayT;
    v.cooldown = newest.cooldown;

    const sample = this.interpolator.sample(now, this.sample);
    v.sample = sample;
    if (!sample) return;
    v.entities.clear();
    v.ped = v.vehicle = null;
    let nearest = Infinity;
    const b = sample.b;
    for (let i = 0; i < b.count; i++) {
      const id = b.u32[b.at(i)];
      let st = this.pool.get(id);
      if (!st) this.pool.set(id, (st = newEntityState()));
      if (!blendEntity(sample, id, st)) continue;
      v.entities.set(id, st);
      if (id === b.playerPed) v.ped = st;
    }
    // The car being driven, or else the one nearest the player on foot.
    for (const st of v.entities.values()) {
      if (st.kind !== 2) continue;
      if (st.id === b.controlled) {
        v.vehicle = st;
        break;
      }
      const d = v.ped ? Math.hypot(st.x - v.ped.x, st.z - v.ped.z) : 0;
      if (d < nearest) {
        nearest = d;
        v.vehicle = st;
      }
    }
    v.controlled = v.entities.get(b.controlled) ?? v.ped;
    v.inVehicle = !!v.ped && (v.ped.flags & PedFlag.InVehicle) !== 0;
    if (v.controlled) g.focus.set(v.controlled.x, v.controlled.y, v.controlled.z);
  }

  private cmdTick = 0;

  private send(now: number, dt: number) {
    const g = this.game;
    const input = g.input;
    const buttons =
      (input.down('jump') ? Button.Jump : 0) |
      (input.down('sprint') ? Button.Sprint : 0) |
      (input.down('interact') ? Button.Interact : 0) |
      (input.down('handbrake') ? Button.Handbrake : 0) |
      (input.down('reset') ? Button.Reset : 0) |
      (input.down('melee') ? Button.Melee : 0);
    if (buttons === (this.lastSent?.buttons ?? 0) && now - this.lastSendAt < MIN_SEND_GAP) return;
    const axes = new Array<number>(AXIS_COUNT).fill(0);
    const move = input.moveAxes();
    axes[Axis.MoveX] = move.x;
    axes[Axis.MoveY] = -move.z;
    axes[Axis.Yaw] = g.cameraArm.yaw;
    axes[Axis.Pitch] = g.cameraArm.pitch;
    axes[Axis.CamDist] = g.cameraArm.dist;
    const drive = input.driveAxes(Math.min(0.05, (now - this.lastSendAt) / 1000 || dt));
    axes[Axis.Throttle] = drive.throttle;
    axes[Axis.Brake] = drive.brake;
    axes[Axis.Steer] = drive.steer;
    const cmd: InputCommand = { tick: ++this.cmdTick, buttons, axes };
    g.transport.sendInput(cmd);
    this.lastSent = cmd;
    this.lastSendAt = now;
    this.sent++;
  }

  dispose() {
    this.game.transport.dispose();
  }
}
