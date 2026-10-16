/**
 * The transit layer in the sim: the tile's stations, tunnels and viaducts made solid, the spaces under the ground (where a person
 * leaves the ground out of their character controller's queries), the trains (trains.ts) as entities whose six cars are kinematic
 * bodies on the track, and the player's side of it, GTA IV style: walk down to the platform, wait for a train (the HUD shows when
 * it is due), get on with the use button when the doors are open, sit (or stand when the car is full), ride, get off at any
 * station with the same button, or skip to the next station (a short fade). Walking through a fare gate pays; jumping one is fare
 * evasion, a minor crime the transit police care about (a guard stands at the gates of the station the player is in). A train
 * hits whoever is on its track.
 *
 * Deterministic: the trains are plain state stepped at the sim's rate (trains.ts), nothing here draws a random number except the
 * station people's outfits (a forked stream).
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { EntityKind, type EntityId } from '../../shared/entities';
import { Button } from '../../shared/protocol';
import { E, H, SnapFlag, TR, TrainFlag, TransitInfo, type SnapshotView } from '../../shared/snapshot';
import { carPoseAt, inObb, newRoutePoint, VolumeIndex, type TransitData, type TransitStation } from '../../shared/transit';
import type { TransitTile } from '../../shared/tile';
import { damagePed, knockDown } from '../combat/damage';
import { PedEntity, TrainEntity, type PlayerSlot } from '../entities';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';
import { CAR, TrainModel, type TrainState } from './trains';
import { StationPeople } from './stationPeds';

/** Seconds the screen takes to go dark before a skip jumps. */
const SKIP_OUT_S = 0.7;
/** How close to a door (m, in plan) the player must stand to get on. */
const BOARD_REACH = 2.2;

interface CarBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

interface Pose {
  /** rail-top centre under the car's middle */
  x: number;
  y: number;
  z: number;
  /** unit forward (along the route) in plan, its grade, and the left (dz, -dx) */
  fx: number;
  fz: number;
  grade: number;
}

export class Transit {
  readonly data: TransitData;
  readonly model: TrainModel;
  readonly volumes: VolumeIndex;
  readonly people: StationPeople;
  private readonly staticCollider: RAPIER.Collider | null = null;
  private readonly bodies = new Map<TrainState, CarBody[]>();
  readonly byId = new Map<EntityId, TrainState>();
  private readonly entityOf = new Map<TrainState, TrainEntity>();
  private readonly pt = newRoutePoint();
  /** seats taken, by train id */
  private readonly taken = new Map<EntityId, Set<number>>();
  private skip: { trainId: EntityId; t: number; stop: number } | null = null;
  /** the player's last position, for the fare gates */
  private last: { x: number; y: number; z: number; grounded: boolean } | null = null;
  /** the station the player is in (index), or -1, and the guard standing at its gates */
  station = -1;
  private guard: { id: EntityId; station: number } | null = null;
  /**
   * Set when anything of the transit layer threw: it stops (the trains stand, nobody new boards) and the rest of the sim goes on.
   * A rider is put back on their feet where they are.
   */
  failed = false;

  /** Runs `fn` unless the layer has failed; a throw is logged once and stops the layer. */
  safe<T>(what: string, fn: () => T): T | undefined {
    if (this.failed) return undefined;
    try {
      return fn();
    } catch (e) {
      console.warn(`transit: ${what} failed; the trains stop`, e);
      // someone under the ground would be left under it (the ground is solid to them again): the player back to the spawn
      const me = this.sim.registry.get(this.sim.playerPedId) as PedEntity | undefined;
      let under = false;
      try {
        under = !!me && !me.ride && this.underground(me.controller.x, me.controller.y, me.controller.z);
      } catch {
        under = false;
      }
      this.failed = true;
      if (me && under) this.sim.respawnPed(me);
      for (const p of this.sim.peds()) {
        if (!p.ride) continue;
        p.ride = null;
        p.controller.setEnabled(true);
        if (p.role === 'player') this.sim.respawnPed(p);
        else this.sim.despawn(p.id);
      }
      for (const p of this.sim.peds()) if (p.controller.queryGroups !== GROUPS.actorQuery) p.controller.queryGroups = GROUPS.actorQuery;
      return undefined;
    }
  }

  /** counters, for tests and the report */
  readonly stats = { spawned: 0, gone: 0, boardings: 0, alightings: 0, fares: 0, evasions: 0, hits: 0, skips: 0, turnbacks: 0 };
  /** what the HUD shows: the next trains due at the player's platform */
  private eta: [number, number, number, number] = [-1, -1, 0, 0];

  constructor(
    private readonly sim: Simulation,
    tile: TransitTile,
  ) {
    this.data = tile.data;
    this.volumes = new VolumeIndex(this.data.volumes);
    const R = sim.physics.R;
    if (tile.indices.length >= 3) {
      this.staticCollider = sim.physics.world.createCollider(R.ColliderDesc.trimesh(tile.positions, tile.indices).setCollisionGroups(GROUPS.transit).setFriction(0.9));
    }
    const clock = sim.clock;
    const t0 = sim.tick / 60;
    this.model = new TrainModel(this.data, this.data.timetable, (t) => clock.minutes + (t - t0) * clock.scale, {
      arrive: (tr, k) => this.onArrive(tr, k),
      depart: (tr, k) => this.onDepart(tr, k),
      doors: (tr, state) => {
        if (tr.id) sim.emit({ type: 'transit:doors', tick: sim.tick, trainId: tr.id, state });
      },
    });
    // the network has been running for a while when the game starts
    this.model.warmUp(t0, 420);
    for (const tr of this.model.trains) this.spawned(tr, false);
    this.people = new StationPeople(sim, this);
    this.claimStations();
  }

  /**
   * The stations are the transit police's (`agency`, jurisdictions.json): an area round each (its platforms, its concourse and its
   * entrances, 25 m out) goes ahead of the city's own, so a crime in a station brings them. The sim's own copy of the law data.
   */
  private claimStations(): void {
    const law = this.sim.law;
    const agency = this.data.agency;
    if (!law.data.agencies.some((a) => a.id === agency)) return;
    const areas = this.data.stations.map((st) => {
      const pts: [number, number][] = [];
      const box = (c: [number, number], a: [number, number], hl: number, hw: number) => {
        for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([c[0] + a[0] * v * hl + a[1] * u * hw, c[1] + a[1] * v * hl - a[0] * u * hw]);
      };
      for (const p of st.platforms) box(p.c, p.axis, p.halfLen + 25, p.halfWidth + 25);
      if (st.concourse) box([st.concourse.c[0], st.concourse.c[2]], st.concourse.axis, st.concourse.halfLen + 25, st.concourse.halfWidth + 25);
      for (const e of st.entrances) box([e.x, e.z], [Math.sin(e.yaw), Math.cos(e.yaw)], 25, 25);
      return { agency, polygon: hull(pts) };
    });
    (law as unknown as { data: typeof law.data }).data = { ...law.data, areas: [...areas, ...law.data.areas] };
  }

  // -------------------------------------------------------------------------------------------
  // Spaces under the ground

  /** The volume at a point (feet), or -1. */
  zoneAt(x: number, y: number, z: number): number {
    return this.volumes.at(x, y + 0.3, z);
  }

  /** Under the ground (in a station, a tunnel, a stairwell, a trench): the ground and the buildings are not solid to them. */
  underground(x: number, y: number, z: number): boolean {
    return this.zoneAt(x, y, z) >= 0;
  }

  /** The camera arm's groups for the player (under the ground it sees only the transit layer). */
  cameraGroups(ped: PedEntity): number {
    if (ped.ride) return GROUPS.undergroundCamera;
    const c = ped.controller;
    return this.underground(c.x, c.y, c.z) ? GROUPS.undergroundCamera : GROUPS.cameraQuery;
  }

  /** Sets everyone's character controller to the groups of where they stand. */
  applyZones(): void {
    for (const p of this.sim.peds()) {
      const c = p.controller;
      if (!c.enabled) continue;
      const g = this.underground(c.x, c.y, c.z) ? GROUPS.undergroundQuery : GROUPS.actorQuery;
      if (c.queryGroups !== g) c.queryGroups = g;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Trains

  private spawned(tr: TrainState, announce = true): void {
    const sim = this.sim;
    const reg = sim.registry;
    const e = new TrainEntity(reg.allocateId(), this.model.trains.indexOf(tr));
    tr.id = e.id;
    reg.add(e);
    this.byId.set(e.id, tr);
    this.entityOf.set(tr, e);
    const R = sim.physics.R;
    const cars: CarBody[] = [];
    const hull = CAR.hull;
    for (let k = 0; k < this.model.tt.cars; k++) {
      const body = sim.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
      const collider = sim.physics.world.createCollider(R.ColliderDesc.cuboid(hull.halfWidth, (hull.top - hull.bottom) / 2, hull.halfLength).setCollisionGroups(GROUPS.transit), body);
      cars.push({ body, collider });
    }
    this.bodies.set(tr, cars);
    this.placeCars(tr, true);
    this.stats.spawned++;
    if (announce) {
      sim.announceEntity(e);
      sim.emit({ type: 'transit:train', tick: sim.tick, trainId: e.id, route: tr.route, state: 'in' });
    }
  }

  private gone(tr: TrainState): void {
    const sim = this.sim;
    for (const c of this.bodies.get(tr) ?? []) sim.physics.world.removeRigidBody(c.body);
    this.bodies.delete(tr);
    this.byId.delete(tr.id);
    this.entityOf.delete(tr);
    this.taken.delete(tr.id);
    sim.emit({ type: 'transit:train', tick: sim.tick, trainId: tr.id, route: tr.route, state: 'out' });
    sim.despawn(tr.id);
    this.stats.gone++;
  }

  /** Car k's pose: the rail under its middle and its direction (from its two bogies). */
  carPose(tr: TrainState, k: number, out: Pose): Pose {
    return carPoseAt(this.data.routes[tr.route], this.model.carMid(tr, k), CAR.bogieZ, out);
  }

  private readonly pose: Pose = { x: 0, y: 0, z: 0, fx: 0, fz: 1, grade: 0 };

  private placeCars(tr: TrainState, teleport = false): void {
    const cars = this.bodies.get(tr);
    if (!cars) return;
    const hull = CAR.hull;
    const cy = (hull.top + hull.bottom) / 2;
    for (let k = 0; k < cars.length; k++) {
      const p = this.carPose(tr, k, this.pose);
      const yaw = Math.atan2(p.fx, p.fz);
      const pitch = -Math.atan(p.grade);
      // yaw about Y, then pitch about the car's X
      const cyw = Math.cos(yaw / 2), syw = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      const q = { x: cyw * sp, y: syw * cp, z: -syw * sp, w: cyw * cp };
      const t = { x: p.x, y: p.y + cy, z: p.z };
      if (teleport) {
        cars[k].body.setTranslation(t, false);
        cars[k].body.setRotation(q, false);
      }
      cars[k].body.setNextKinematicTranslation(t);
      cars[k].body.setNextKinematicRotation(q);
    }
  }

  /** A point given in car k's own frame (+X its left, +Z its cab end; the odd cars of each married pair run cab last). */
  carPoint(tr: TrainState, k: number, lx: number, ly: number, lz: number): { x: number; y: number; z: number; yaw: number } {
    const p = this.carPose(tr, k, this.pose);
    const flip = k % 2 === 1 ? -1 : 1;
    // the route's left of the direction of travel: (fz, -fx)
    const lxw = p.fz, lzw = -p.fx;
    const u = lx * flip, w = lz * flip;
    return { x: p.x + lxw * u + p.fx * w, y: p.y + ly + p.grade * w, z: p.z + lzw * u + p.fz * w, yaw: Math.atan2(p.fx, p.fz) + (flip < 0 ? Math.PI : 0) };
  }

  /** Where car k's door d on the platform side opens onto the platform (a step out from the car's side). */
  doorOutside(tr: TrainState, k: number, d: number, out = 0.7): { x: number; y: number; z: number } {
    const stop = this.data.routes[tr.route].stops[tr.stop];
    const side = stop ? stop.side : 1;
    const p = this.carPose(tr, k, this.pose);
    const lxw = p.fz, lzw = -p.fx;
    const w = CAR.doors.z[d];
    const u = side * (CAR.halfWidth + out);
    return { x: p.x + lxw * u + p.fx * w, y: p.y + CAR.floorY, z: p.z + lzw * u + p.fz * w };
  }

  private onArrive(tr: TrainState, k: number): void {
    if (!tr.id) return;
    const st = this.data.routes[tr.route].stops[k];
    if (!st) return;
    this.sim.emit({ type: 'transit:arrive', tick: this.sim.tick, trainId: tr.id, route: tr.route, station: st.station, platform: st.platform });
    this.people?.trainArrived(tr, k);
  }

  private onDepart(tr: TrainState, k: number): void {
    if (!tr.id) return;
    const st = this.data.routes[tr.route].stops[k];
    if (!st) return;
    this.sim.emit({ type: 'transit:depart', tick: this.sim.tick, trainId: tr.id, route: tr.route, station: st.station });
  }

  /** The train the player rides, if any. */
  playerTrain(): TrainState | null {
    const ped = this.sim.registry.get(this.sim.playerPedId) as PedEntity | undefined;
    return ped?.ride ? (this.byId.get(ped.ride.trainId) ?? null) : null;
  }

  /** One tick: the trains, their cars' bodies, who rides them, who they hit, the gates, the guard, the station people. */
  update(dt: number): void {
    const sim = this.sim;
    const now = sim.tick / 60;
    if (this.skip) this.stepSkip(dt);
    const riding = this.playerTrain();
    // a train with the player aboard that has passed its last stop turns back at the edge of the map (a terminus past it): the
    // screen fades, and it comes back in on the other direction's track and runs to its first stop
    if (riding && !this.skip && riding.phase === 'run' && riding.stop >= this.data.routes[riding.route].stops.length && riding.s > this.data.routes[riding.route].len - 70) {
      this.skip = { trainId: riding.id, t: 0, stop: this.data.routes[riding.route].stops.length };
      sim.emit({ type: 'transit:skip', tick: sim.tick, trainId: riding.id, phase: 'out', station: -1 });
    }
    this.model.stepAll(now, dt, (tr) => this.spawned(tr));
    this.model.reap((tr) => this.gone(tr));
    for (const tr of this.model.trains) this.placeCars(tr);
    this.placeRiders();
    this.hits();
    this.fares();
    this.guardStation();
    this.updateEta();
  }

  /** The riders sit (or stand) where their seat is in the car, every tick. */
  private placeRiders(): void {
    for (const p of this.sim.peds()) {
      const r = p.ride;
      if (!r) continue;
      const tr = this.byId.get(r.trainId);
      if (!tr) {
        // the train is gone with them on it (it should not be): put them back at the spawn
        p.ride = null;
        p.controller.setEnabled(true);
        if (p.role === 'player') this.sim.respawnPed(p);
        else this.sim.despawn(p.id);
        continue;
      }
      const spot = r.stand ? CAR.stands[r.seat] : CAR.seats[r.seat];
      const q = this.carPoint(tr, r.car, spot[0], CAR.floorY, spot[2]);
      const c = p.controller;
      c.x = q.x;
      c.y = q.y;
      c.z = q.z;
      c.yaw = q.yaw + spot[3];
      c.vel.x = c.vel.z = 0;
    }
  }

  /** Whoever stands on the track in front of a moving train is hit. */
  private hits(): void {
    const sim = this.sim;
    const hw = CAR.halfWidth + 0.35;
    const L = this.model.len;
    for (const tr of this.model.trains) {
      if (tr.v < 1.2) continue;
      const head = this.model.pointAt(tr.route, tr.s, this.pt);
      const hx = head.x, hz = head.z;
      for (const p of sim.peds()) {
        if (p.ride || p.life === 'dead' || !p.controller.enabled || p.carHitCool > 0) continue;
        const c = p.controller;
        if (Math.abs(c.x - hx) > L + 10 || Math.abs(c.z - hz) > L + 10) continue;
        for (let k = 0; k < this.model.tt.cars; k++) {
          const pose = this.carPose(tr, k, this.pose);
          const dx = c.x - pose.x, dz = c.z - pose.z;
          const along = dx * pose.fx + dz * pose.fz;
          const across = dx * pose.fz - dz * pose.fx;
          const dy = c.y - pose.y;
          if (Math.abs(along) > CAR.length / 2 + 0.4 || Math.abs(across) > hw || dy < -1.6 || dy > CAR.roofY) continue;
          const v = tr.v;
          const side = across >= 0 ? 1 : -1;
          p.carHitCool = 1.5;
          sim.emit({ type: 'transit:hit', tick: sim.tick, trainId: tr.id, pedId: p.id, speed: v });
          this.stats.hits++;
          tr.horn = 1.5;
          const r = damagePed(sim, p, v * 9, 'vehicle', 0);
          const push = { x: pose.fx * v * 0.9 + pose.fz * side * 3, z: pose.fz * v * 0.9 - pose.fx * side * 3 };
          if (r.fatal) c.launch(push.x, 2 + v * 0.15, push.z);
          else knockDown(sim, p, 3, push.x, push.z, 2);
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The player

  /** The use button: get on at an open door, or off at a station. True when it was ours. */
  interact(p: PlayerSlot, ped: PedEntity): boolean {
    void p;
    if (ped.ride) return this.alight(ped);
    const door = this.doorInReach(ped);
    if (!door) return false;
    this.board(ped, door.tr, door.car, door.door);
    return true;
  }

  /** The open door the player stands at, if any. */
  doorInReach(ped: PedEntity): { tr: TrainState; car: number; door: number } | null {
    const c = ped.controller;
    let best: { tr: TrainState; car: number; door: number } | null = null;
    let bd = BOARD_REACH;
    for (const tr of this.model.trains) {
      if ((tr.phase !== 'open' && tr.phase !== 'opening') || tr.doors < 0.6) continue;
      const head = this.model.pointAt(tr.route, tr.s, this.pt);
      if (Math.hypot(head.x - c.x, head.z - c.z) > this.model.len + 20) continue;
      for (let k = 0; k < this.model.tt.cars; k++) {
        for (let d = 0; d < CAR.doors.z.length; d++) {
          const o = this.doorOutside(tr, k, d, 0.5);
          if (Math.abs(o.y - c.y) > 1.2) continue;
          const dist = Math.hypot(o.x - c.x, o.z - c.z);
          if (dist < bd) {
            bd = dist;
            best = { tr, car: k, door: d };
          }
        }
      }
    }
    return best;
  }

  /** Gets a person on: a free seat near their door, or a standing spot when the car is full. */
  board(ped: PedEntity, tr: TrainState, car: number, door: number): void {
    const sim = this.sim;
    let taken = this.taken.get(tr.id);
    if (!taken) this.taken.set(tr.id, (taken = new Set()));
    const dz = CAR.doors.z[door];
    // seats by their distance to the door; standing spots after
    const order = CAR.seats.map((s, i) => ({ i, d: Math.abs(s[2] - dz) + Math.abs(s[0]) * 0.2 })).sort((a, b) => a.d - b.d || a.i - b.i);
    let seat = -1, stand = false;
    for (const o of order) if (!taken.has(car * 1000 + o.i)) {
      seat = o.i;
      break;
    }
    if (seat < 0) {
      stand = true;
      seat = CAR.stands.map((s, i) => ({ i, d: Math.abs(s[2] - dz) })).sort((a, b) => a.d - b.d)[0].i;
    } else taken.add(car * 1000 + seat);
    ped.ride = { trainId: tr.id, car, seat, stand };
    ped.controller.setEnabled(false);
    ped.melee = null;
    if (ped.role === 'player') {
      this.stats.boardings++;
      // a person in the doorway keeps the doors open a moment
      tr.hold = Math.max(tr.hold, 2);
    }
    sim.emit({ type: 'transit:board', tick: sim.tick, pedId: ped.id, trainId: tr.id, car, seat: stand ? -1 : seat });
  }

  /** Gets the player off at the station the train stands at (out of the door nearest their seat). */
  alight(ped: PedEntity): boolean {
    const r = ped.ride;
    if (!r) return false;
    const tr = this.byId.get(r.trainId);
    if (!tr || (tr.phase !== 'open' && tr.phase !== 'opening') || tr.doors < 0.5) return true;
    const stop = this.data.routes[tr.route].stops[tr.stop];
    if (!stop) return true;
    const spot = r.stand ? CAR.stands[r.seat] : CAR.seats[r.seat];
    let d = 0;
    for (let k = 1; k < CAR.doors.z.length; k++) if (Math.abs(CAR.doors.z[k] - spot[2]) < Math.abs(CAR.doors.z[d] - spot[2])) d = k;
    // the odd cars run reversed: their door order along the route is mirrored, the positions are symmetric
    const o = this.doorOutside(tr, r.car, d, 1.1);
    const plat = this.data.stations[stop.station]?.platforms[stop.platform];
    const y = plat ? plat.y : o.y;
    this.taken.get(tr.id)?.delete(r.car * 1000 + r.seat);
    ped.ride = null;
    const c = ped.controller;
    c.setEnabled(true);
    c.teleport(o.x, y + 0.05, o.z, Math.atan2(o.x - this.carPose(tr, r.car, this.pose).x, o.z - this.pose.z));
    c.queryGroups = GROUPS.undergroundQuery;
    this.stats.alightings++;
    this.sim.emit({ type: 'transit:alight', tick: this.sim.tick, pedId: ped.id, trainId: tr.id, station: stop.station });
    return true;
  }

  /** While riding: the skip button. */
  rideInput(p: PlayerSlot, ped: PedEntity): void {
    if (!ped.ride) return;
    if (p.edges & Button.Interact) this.alight(ped);
    else if (p.edges & Button.Skip && !this.skip) {
      const tr = this.byId.get(ped.ride.trainId);
      if (!tr) return;
      const next = tr.phase === 'run' ? tr.stop : tr.stop + 1;
      const st = this.data.routes[tr.route].stops[next];
      this.skip = { trainId: tr.id, t: 0, stop: next };
      this.sim.emit({ type: 'transit:skip', tick: this.sim.tick, trainId: tr.id, phase: 'out', station: st ? st.station : -1 });
    }
  }

  /** The skip: the screen goes dark, then the player's stream runs on until their train stands at the next station. */
  private stepSkip(dt: number): void {
    const sk = this.skip!;
    sk.t += dt;
    if (sk.t < SKIP_OUT_S) return;
    const sim = this.sim;
    let tr = this.byId.get(sk.trainId) ?? null;
    if (!tr) {
      this.skip = null;
      return;
    }
    const si = tr.stream;
    const st = this.model.streams[si];
    const step = 1 / 30;
    let guard = 0;
    const now = sim.tick / 60;
    // until it has stopped at the stop after the one it was at (or, past the last, turned back and stopped at the reverse's first)
    for (; guard < 9000; guard++) {
      if (tr.phase === 'opening' && tr.stop >= sk.stop) break;
      st.shift += step;
      this.model.stepStream(si, now, step, (t) => this.spawned(t));
      this.model.reap((t) => this.gone(t));
      if (tr.s - this.model.len > this.data.routes[tr.route].len - 30) {
        this.turnBack(tr);
        tr = this.byId.get(sk.trainId)!;
        sk.stop = 0;
        const s2 = this.model.streams[tr.stream];
        // carry on in the stream it now belongs to
        if (s2 !== st) {
          for (let g2 = 0; g2 < 9000 && !(tr.phase === 'opening' && tr.stop >= sk.stop); g2++) {
            s2.shift += step;
            this.model.stepStream(tr.stream, now, step, (t) => this.spawned(t));
            this.model.reap((t) => this.gone(t));
          }
          break;
        }
      }
    }
    this.stats.skips++;
    const stop = this.data.routes[tr.route].stops[tr.stop];
    sim.emit({ type: 'transit:skip', tick: sim.tick, trainId: tr.id, phase: 'in', station: stop ? stop.station : -1 });
    this.skip = null;
  }

  /**
   * The player's train has come to the end of its route (the edge of the loaded area): it turns back as if at a terminus past the
   * edge, coming back in on the other direction's track with the player in the same seat.
   */
  private turnBack(tr: TrainState): void {
    const r = this.data.routes[tr.route];
    const back = r.reverse;
    if (back < 0) return;
    const rb = this.data.routes[back];
    tr.route = back;
    tr.stream = this.model.streamOf[back];
    tr.line = rb.line;
    tr.s = 0;
    tr.v = Math.min(rb.speed[0]?.[1] ?? 10, 12);
    tr.stop = 0;
    tr.phase = 'run';
    tr.t = 0;
    tr.limitAt = 0;
    tr.doors = 0;
    this.placeCars(tr, true);
    this.stats.turnbacks++;
  }

  // -------------------------------------------------------------------------------------------
  // Fares, the guard

  /** Which station a point is in (its volumes, or by its gates and entrances when it has no space under the ground), or -1. */
  stationAt(x: number, y: number, z: number): number {
    const vi = this.zoneAt(x, y, z);
    if (vi >= 0) return this.data.volumes[vi].station;
    for (let i = 0; i < this.data.stations.length; i++) {
      const st = this.data.stations[i];
      if (st.underground) continue;
      for (const pl of st.platforms) {
        if (Math.abs(y - pl.y) > 3) continue;
        const b = { c: [pl.c[0], pl.y, pl.c[1]] as [number, number, number], h: [pl.halfWidth + 1, 3, pl.halfLen + 2] as [number, number, number], yaw: Math.atan2(pl.axis[0], pl.axis[1]) };
        if (inObb(b, x, y, z)) return i;
      }
      for (const g of st.gates) if (Math.hypot(g[0] - x, g[1] - z) < 12) return i;
    }
    return -1;
  }

  /** The player crossing a gate line inward: walked through (paid) or jumped it (evasion). */
  private fares(): void {
    const sim = this.sim;
    const ped = sim.registry.get(sim.playerPedId) as PedEntity;
    const c = ped.controller;
    const now = { x: c.x, y: c.y, z: c.z, grounded: c.grounded };
    const prev = this.last;
    this.last = now;
    this.station = ped.ride ? -1 : this.stationAt(c.x, c.y, c.z);
    if (!prev || ped.ride || !c.enabled) return;
    for (let si = 0; si < this.data.stations.length; si++) {
      const st = this.data.stations[si];
      for (const g of st.gates) {
        const [gx, gz, nx, nz] = g;
        if (Math.abs(gx - c.x) > 3 || Math.abs(gz - c.z) > 3) continue;
        const a = (prev.x - gx) * nx + (prev.z - gz) * nz;
        const b = (now.x - gx) * nx + (now.z - gz) * nz;
        if (!(a < 0 && b >= 0)) continue;
        const t = a / (a - b);
        const mx = prev.x + (now.x - prev.x) * t, mz = prev.z + (now.z - prev.z) * t;
        const lateral = Math.abs((mx - gx) * -nz + (mz - gz) * nx);
        if (lateral > 0.75) continue;
        const gy = this.gateY(st, gx, gz);
        if (Math.abs(c.y - gy) > 2) continue;
        // through the gap on their feet pays; over the gate, or airborne through it, is jumping it
        const jumped = !prev.grounded || !now.grounded || lateral > 0.45 || c.y - gy > 0.4;
        if (jumped) {
          this.stats.evasions++;
          sim.emit({ type: 'transit:evade', tick: sim.tick, pedId: ped.id, station: si, x: c.x, y: c.y, z: c.z });
        } else {
          this.stats.fares++;
          sim.emit({ type: 'transit:fare', tick: sim.tick, pedId: ped.id, station: si });
        }
        return;
      }
    }
  }

  /** The floor height at a gate (the concourse's, or the street's at an elevated station's stair). */
  private gateY(st: TransitStation, x: number, z: number): number {
    if (st.concourse) return st.concourse.c[1];
    return this.sim.groundAt(x, z);
  }

  /** A transit police officer stands at the gates of the station the player is in (one at a time). */
  private guardStation(): void {
    const sim = this.sim;
    const g = this.guard;
    if (g) {
      const ped = sim.registry.get(g.id) as PedEntity | undefined;
      const pp = sim.playerPosition();
      const st = this.data.stations[g.station];
      if (!ped || ped.life === 'dead') {
        if (!ped) this.guard = null;
        if (ped && ped.life === 'dead' && Math.hypot(st.x - pp.x, st.z - pp.z) > 160) {
          sim.despawn(ped.id);
          this.guard = null;
        }
        return;
      }
      if (this.station !== g.station && Math.hypot(st.x - pp.x, st.z - pp.z) > 160) {
        sim.despawn(ped.id);
        this.guard = null;
      }
      return;
    }
    if (this.station < 0) return;
    const st = this.data.stations[this.station];
    if (st.gates.length === 0) return;
    // beside the gate bank, on the free side, facing the gates
    const gt = st.gates[Math.min(st.gates.length - 1, 1)];
    const [gx, gz, nx, nz] = gt;
    const x = gx - nx * 2.2 + -nz * 2.2, z = gz - nz * 2.2 + nx * 2.2;
    const y = this.gateY(st, gx, gz);
    if (sim.physics.blockedAt(x, y, z)) return;
    const agency = this.data.agency;
    const law = sim.law.data.agencies.find((a) => a.id === agency);
    const uniform = law ? parseInt(law.livery.body.replace('#', ''), 16) : 0x333333;
    const ped = sim.addPed(x, y, z, Math.atan2(nx, nz), 0, false, (o) => {
      o.role = 'police';
      o.officer = {
        agency, unitId: 0, mode: 'hold', vehicleId: 0, arrestT: 0, goal: null, goalT: 0, unseenT: 99, senseIn: 0, sees: false, uniform,
        loadout: 'pistol', seat: 0, fireT: 0, fire: { seenT: 0, reactS: 0.8, burstLeft: 0, pauseT: 0, why: '' },
      };
    });
    ped.controller.queryGroups = this.underground(x, y, z) ? GROUPS.undergroundQuery : GROUPS.actorQuery;
    this.guard = { id: ped.id, station: this.station };
  }

  /** Whether an entity is the station guard (the police system leaves them be). */
  isGuard(id: EntityId): boolean {
    return this.guard?.id === id;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots

  /** The next trains due at the platform nearest the player in their station, by stream. */
  private updateEta(): void {
    const sim = this.sim;
    if (sim.tick % 15 !== 0) return;
    this.eta[0] = this.eta[1] = -1;
    this.eta[2] = this.eta[3] = 0;
    if (this.station < 0) return;
    const st = this.data.stations[this.station];
    const pp = sim.playerPosition();
    let best = -1, bd = Infinity;
    st.platforms.forEach((pl, i) => {
      const d = Math.hypot(pl.c[0] - pp.x, pl.c[1] - pp.z) + Math.abs(pl.y - pp.y) * 3;
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return;
    const pl = st.platforms[best];
    const streams = [...new Set(pl.routes.map((r) => this.model.streamOf[r]))].sort((a, b) => a - b).slice(0, 2);
    streams.forEach((si, k) => {
      let eta = Infinity, route = -1;
      for (const ri of this.model.streams[si].routes) {
        const r = this.data.routes[ri];
        const stopIdx = r.stops.findIndex((s) => s.station === this.station && s.platform === best);
        if (stopIdx < 0) continue;
        const stop = r.stops[stopIdx];
        for (const tr of this.model.trains) {
          if (tr.route !== ri || tr.stop > stopIdx) continue;
          if (tr.stop === stopIdx && tr.phase !== 'run') {
            if (tr.phase !== 'closing' && 0 < eta) { eta = 0; route = ri; }
            continue;
          }
          // the distance over a mean speed, and the dwells on the way
          const t = (stop.s - tr.s) / 13 + (stopIdx - tr.stop) * this.model.tt.dwellS;
          if (t < eta) { eta = t; route = ri; }
        }
      }
      if (!Number.isFinite(eta)) {
        // none on the line yet: the next one in, and its run from the edge
        const s = this.model.streams[si];
        const ri = s.routes[s.seq % s.routes.length];
        const r = this.data.routes[ri];
        const stop = r.stops.find((q) => q.station === this.station && q.platform === best);
        if (stop) { eta = Math.max(0, s.next - (sim.tick / 60 + s.shift)) + stop.s / 13; route = ri; }
      }
      if (Number.isFinite(eta)) {
        this.eta[k] = eta;
        this.eta[2 + k] = route + 1;
      }
    });
  }

  writeEntity(view: SnapshotView, o: number, e: TrainEntity): void {
    const tr = this.byId.get(e.id);
    const f = view.f32, u = view.u32;
    if (!tr) return;
    const head = this.carPose(tr, 0, this.pose);
    f[o + E.Px] = head.x;
    f[o + E.Py] = head.y;
    f[o + E.Pz] = head.z;
    const yaw = Math.atan2(head.fx, head.fz);
    f[o + E.Qx] = 0;
    f[o + E.Qy] = Math.sin(yaw / 2);
    f[o + E.Qz] = 0;
    f[o + E.Qw] = Math.cos(yaw / 2);
    f[o + E.Vx] = head.fx * tr.v;
    f[o + E.Vy] = head.grade * tr.v;
    f[o + E.Vz] = head.fz * tr.v;
    const stop = this.data.routes[tr.route].stops[tr.stop];
    const dwelling = tr.phase !== 'run';
    const riding = this.playerTrain() === tr;
    u[o + E.Flags] =
      (dwelling && stop ? (stop.side > 0 ? TrainFlag.DoorsLeft : TrainFlag.DoorsRight) : 0) |
      (dwelling ? TrainFlag.Dwelling : 0) |
      (!dwelling && stop && stop.s - tr.s < 250 ? TrainFlag.Arriving : 0) |
      (riding ? TrainFlag.PlayerAboard : 0) |
      (tr.horn > 0 ? TrainFlag.Horn : 0) |
      (tr.phase === 'closing' ? TrainFlag.Closing : 0);
    f[o + E.Speed] = tr.v;
    f[o + E.Aux0] = tr.s;
    f[o + E.Aux1] = tr.doors;
    f[o + E.Aux2] = tr.route;
    u[o + TR.NextStop] = tr.stop;
    f[o + TR.Eta] = this.model.eta(tr);
    u[o + TR.Line] = tr.line;
    u[o + TR.Cars] = this.model.tt.cars;
    f[o + E.Health] = 1;
    f[o + E.Health2] = 1;
  }

  writeHeader(view: SnapshotView): void {
    const sim = this.sim;
    const u = view.u32, f = view.f32;
    const ped = sim.registry.get(sim.playerPedId) as PedEntity;
    const r = ped.ride;
    u[H.Train] = r ? r.trainId : 0;
    const c = ped.controller;
    const under = r ? this.underground(c.x, c.y, c.z) || this.underground(c.x, c.y - CAR.floorY, c.z) : this.underground(c.x, c.y, c.z);
    if (r) u[H.Flags] |= SnapFlag.OnTrain;
    if (under) u[H.Flags] |= SnapFlag.Underground;
    let door = 0;
    if (!r && this.doorInReach(ped)) door = 1;
    if (r) {
      const tr = this.byId.get(r.trainId);
      if (tr && (tr.phase === 'open' || tr.phase === 'opening') && tr.doors > 0.5) door = 2;
    }
    u[H.TransitInfo] = TransitInfo.pack(this.station, r ? (r.stand ? 2 : 1) : 0, this.skip ? 1 : 0, door, r ? r.car : 0);
    f[H.Eta0] = this.eta[0];
    f[H.Eta1] = this.eta[1];
    u[H.EtaRoutes] = (this.eta[2] & 0xff) | ((this.eta[3] & 0xff) << 8);
  }

  /** Everything the transit layer made, out of the world (a sim being thrown away). */
  dispose(): void {
    const w = this.sim.physics.world;
    for (const cars of this.bodies.values()) for (const c of cars) w.removeRigidBody(c.body);
    this.bodies.clear();
    if (this.staticCollider) w.removeCollider(this.staticCollider, false);
  }
}

/** Under-the-ground groups for everyone, before the bodies move. */
export class TransitZoneSystem implements SimSystem {
  readonly name = 'transitZones';
  readonly priority = 17;
  fixedUpdate(sim: Simulation) {
    const t = sim.transit;
    t?.safe('the zones', () => t.applyZones());
  }
}

/** The station people's feet: after the brains (which stop everyone first), before the bodies move. */
export class TransitPeopleSystem implements SimSystem {
  readonly name = 'transitPeople';
  readonly priority = 18;
  fixedUpdate(sim: Simulation, dt: number) {
    const t = sim.transit;
    t?.safe("the station's people", () => t.people.update(dt));
  }
}

/** The trains and the riders: after the people have moved (the riders follow their seats), before the world steps. */
export class TransitSystem implements SimSystem {
  readonly name = 'transit';
  readonly priority = 25;
  fixedUpdate(sim: Simulation, dt: number) {
    const t = sim.transit;
    t?.safe('the trains', () => t.update(dt));
  }
}

export { EntityKind };

/** The convex hull of points (monotone chain). */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
