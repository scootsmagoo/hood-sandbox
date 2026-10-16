/**
 * Ambient pedestrians: the people who make the sidewalks look lived in. A director keeps a
 * population around the player that follows the city's population table (zone, time slot, weekday or
 * weekend), spawning people 60 to 120 m out where the camera cannot see them and removing them
 * again when they are far and unseen. Each person walks the walk network (crossing streets on the
 * walk light, or in a gap in the traffic), or is already doing something at a scenario point: on a
 * bench, at the stop, at the cash machine, chatting on a corner.
 *
 * Violence, explosions, crashes, wrecks and cars on the pavement change what they do (run, cower,
 * film it on a phone, stare, jump back), through the same brain as the carjacked driver's (`npc/brain.ts`),
 * which does the running and the fighting. Anyone the player touched is persistent: never removed
 * while they could be seen.
 *
 * Everything is a function of the seed, the tick and what happened, so it replays exactly.
 */
import { clamp, approachAngle } from '../../shared/math';
import type { PedCause, PedReaction, SimEvent } from '../../shared/protocol';
import { WEAPONS } from '../../shared/weapons';
import { Axis, SIM_DT } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import { MAX_ENTITIES } from '../../shared/snapshot';
import type { JunctionsData, RoadData } from '../../shared/tile';
import { walkState, type SignalJunction } from '../../shared/signals';
import type { ScenarioType } from '../../shared/walk';
import { PED } from '../character/locomotion';
import { PedEntity, type VehicleEntity } from '../entities';
import type { PedBrain } from '../npc/brain';
import type { Simulation } from '../Simulation';
import { EdgeClearance } from './clearance';
import { cellKey, PAVEMENT_KINDS, WalkGraph } from './graph';
import { RoadMask, RoadMaskSet } from './roadMask';
import type { StreamListener } from '../stream/TileStreamer';
import { namespaceJunctions } from '../stream/TileStreamer';
import { slotOf, zoneAt, type PedGroup, type PopulationData, type PopSlot } from './population';
import { ScenarioIndex, slotPosition } from './scenarios';
import { newAmbientState, type AmbientState, type ScenarioAction } from './state';

export const AMBIENT = {
  /** Spawn band round the player, m. A person is only spawned where the camera cannot see, so the near end can be close behind it. */
  ringMin: 42,
  ringMax: 120,
  /** Beyond this and unseen, a person is removed; beyond `hardR` they are removed even if seen (a speck on a long street). */
  despawnR: 135,
  hardR: 230,
  /** Entity slots left for police, traffic and the player when the snapshot is full. */
  reserve: 28,
  /** Most spawned per director step (10 a second). */
  perStep: 3,
  /** Nearer than this a person is always counted as seen, whichever way the camera points. */
  nearSeen: 28,
  /** Half the angle of the camera cone that counts as seen. */
  coneHalf: (64 * Math.PI) / 180,
  /** A reaction starts this long after the event, s (min, max). */
  reactDelay: [0.15, 0.7] as const,
  /** Distance to the player at which people step out of the way. */
  stepAside: 2.3,
} as const;

/** Scenario types, how likely each is to be picked, and the zone kinds that favour them. */
const TYPE_WEIGHT: Record<ScenarioType, number> = { bench: 3, busstop: 4, atm: 1, shopfront: 3, eatery: 3, lawn: 2, plaza: 2, corner: 2 };
const KIND_BOOST: Record<string, Partial<Record<ScenarioType, number>>> = {
  park: { lawn: 4, bench: 2, plaza: 2 },
  transit: { busstop: 4, corner: 1.5 },
  venue: { plaza: 2.5, eatery: 2, corner: 1.5 },
  nightlife: { eatery: 3, corner: 2 },
  business: { atm: 3, eatery: 1.5, shopfront: 1.5 },
  residential: { bench: 1.5, corner: 1.5 },
};

interface Poi {
  id: number;
  x: number;
  z: number;
  /** Seconds left. */
  left: number;
  cause: PedCause;
}

/** How much more of the budget goes to the streets near the player: what you can see should be the busy part. */
const nearBias = (d: number) => (d < 45 ? 3.2 : d < 75 ? 1.2 : d < 105 ? 0.35 : 0.1);

const moveMag = (v: number) => (v <= PED.walkSpeed ? (0.5 * v) / PED.walkSpeed : 0.5 + (0.5 * (v - PED.walkSpeed)) / (PED.runSpeed - PED.walkSpeed));

export interface AmbientOptions {
  graph: WalkGraph;
  scenarios: ScenarioIndex;
  population: PopulationData;
  junctions?: JunctionsData;
  /** The streets, to tell a car on the pavement from a car on the road. */
  roads?: RoadData[];
  budget?: number;
  /** A streamed city: the tiles' junctions, streets and scenario points come and go (`streamListener`). */
  stream?: boolean;
}

export class AmbientPeds {
  /** Most ambient people at once (the graphics tier sets it). */
  budget: number;
  readonly graph: WalkGraph;
  readonly scenarios: ScenarioIndex;
  readonly population: PopulationData;
  /** The people the director has made, oldest first. */
  list: PedEntity[] = [];
  /** What the director aimed for at its last step (diagnostics and tests). */
  target = 0;
  spawned = 0;
  removed = 0;
  private readonly rng: Rng;
  private readonly junctionOf = new Map<string, SignalJunction>();
  private readonly roadMask: RoadMask | RoadMaskSet;
  /** How far off the middle of each edge a person can walk (measured against the real walls and props as edges are first used). */
  readonly clearance: EdgeClearance;
  private inbox: SimEvent[] = [];
  private pois: Poi[] = [];
  private filled = false;
  private n = 0;
  private readonly doomed = new Set<number>();
  // what is round the player and the cars, refreshed a few times a second
  private ox: number[] = [];
  private oz: number[] = [];
  private oplayer: boolean[] = [];
  private vx: number[] = [];
  private vz: number[] = [];
  private vvx: number[] = [];
  private vvz: number[] = [];
  private vspd: number[] = [];
  private vside: boolean[] = [];

  constructor(
    private readonly sim: Simulation,
    opts: AmbientOptions,
  ) {
    this.graph = opts.graph;
    this.scenarios = opts.scenarios;
    this.population = opts.population;
    this.budget = opts.budget ?? 60;
    this.rng = sim.rng.fork('ambient');
    for (const j of opts.junctions?.junctions ?? []) this.junctionOf.set(j.id, j);
    this.roadMask = opts.stream ? new RoadMaskSet() : new RoadMask(opts.roads, opts.junctions);
    this.clearance = new EdgeClearance(opts.graph, sim.physics);
    opts.graph.passable = (e) => !this.clearance.isBlocked(e);
  }

  get count(): number {
    return this.list.length;
  }

  /** How the pedestrians follow a streamed city's tiles (docs/contracts/city-tiles.md section 9). */
  streamListener(): StreamListener {
    return {
      tileAdded: (key, r, tile) => {
        if (tile.scenarios) this.scenarios.addTile(key, tile.scenarios);
        const jd = namespaceJunctions(tile.junctions, r.ns);
        for (const j of jd?.junctions ?? []) this.junctionOf.set(j.id, j);
        if (this.roadMask instanceof RoadMaskSet) this.roadMask.add(key, tile.roads, jd);
        this.tileJunctions.set(key, (jd?.junctions ?? []).map((j) => j.id));
      },
      tileDropping: (_key, rect) => {
        for (const p of this.list) {
          const c = p.controller;
          if (c.x >= rect.minX && c.x <= rect.maxX && c.z >= rect.minZ && c.z <= rect.maxZ) this.remove(p);
        }
      },
      tileRemoved: (key) => {
        this.scenarios.removeTile(key);
        for (const id of this.tileJunctions.get(key) ?? []) this.junctionOf.delete(id);
        this.tileJunctions.delete(key);
        if (this.roadMask instanceof RoadMaskSet) this.roadMask.remove(key);
        // anyone standing on what went (a dead edge) goes too
        for (const p of this.list) {
          const a = p.amb;
          if (a && a.node >= 0 && this.graph.degree(a.node) === 0) this.remove(p);
        }
      },
    };
  }

  private readonly tileJunctions = new Map<string, string[]>();

  // ----------------------------------------------------------------------------------------------
  // The tick

  update(dt: number) {
    this.n++;
    this.processInbox();
    if (!this.filled) {
      this.filled = true;
      this.fill(true);
    }
    if (this.n % 3 === 0) this.refreshAround();
    if (this.n % 6 === 0) this.direct();
    for (const p of this.list) this.step(p, dt);
  }

  /** May this person be removed from the world now? Used when they ran out of sight. */
  mayRemove(ped: PedEntity): boolean {
    const a = ped.amb;
    if (!a) return true;
    const c = ped.controller;
    const p = this.sim.playerPosition();
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    if (d > AMBIENT.hardR && !a.persistent) return true;
    if (a.persistent) return d > 170 && !this.visible(c.x, c.y, c.z);
    return !this.visible(c.x, c.y, c.z);
  }

  // ----------------------------------------------------------------------------------------------
  // Seeing and being seen

  /** Whether the camera could see a point: near, or inside the camera's cone with a clear line to it. */
  visible(x: number, y: number, z: number): boolean {
    const sim = this.sim;
    const p = sim.playerPosition();
    const dx = x - p.x, dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < AMBIENT.nearSeen) return true;
    const slot = sim.players.get(1);
    const yaw = slot?.axes[Axis.Yaw] ?? 0;
    // The camera looks along (-sin yaw, -cos yaw).
    const cos = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d;
    if (cos < Math.cos(AMBIENT.coneHalf)) return false;
    return sim.law.clearLine({ x: p.x, y: p.y + 1.7, z: p.z }, { x, y: y + 1.4, z });
  }

  // ----------------------------------------------------------------------------------------------
  // The director: how many, where, who

  private capacity(): number {
    const sim = this.sim;
    const others = sim.registry.size - this.list.length;
    return Math.max(0, Math.min(this.budget, MAX_ENTITIES - AMBIENT.reserve - others));
  }

  private direct() {
    const sim = this.sim;
    // forget the removed
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (sim.registry.get(p.id) !== p) {
        this.leaveScenario(p.amb!);
        this.list.splice(i, 1);
        this.removed++;
      }
    }
    // those the law is waiting on to make a call stay where they are
    for (const call of sim.law.pending) {
      const w = sim.registry.get(call.witnessId) as PedEntity | undefined;
      if (w?.amb) w.amb.persistent = true;
    }
    this.scanPois();
    const cap = this.capacity();
    const { total, scale } = this.demand(cap);
    this.target = Math.min(cap, Math.round(total));
    const me = sim.playerPosition();

    // too many (the budget fell, the clock moved on to a quiet hour): remove the farthest unseen
    let removed = 0;
    if (this.list.length > this.target + 2 || this.list.length > cap) {
      const order = this.list.filter((p) => !this.doomed.has(p.id)).map((p) => ({ p, d: Math.hypot(p.controller.x - me.x, p.controller.z - me.z) })).sort((a, b) => b.d - a.d);
      for (const o of order) {
        if (removed >= 2 || this.list.length - removed <= this.target) break;
        if (o.p.amb!.persistent || !this.mayRemove(o.p)) continue;
        this.remove(o.p);
        removed++;
      }
    }
    // the far, unseen ones
    for (const p of this.list) {
      if (this.doomed.has(p.id)) continue;
      const c = p.controller;
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (d > AMBIENT.despawnR && this.mayRemove(p)) this.remove(p);
    }
    if (this.list.length < this.target) this.fill(false, scale);
  }

  private remove(p: PedEntity) {
    if (this.doomed.has(p.id)) return;
    this.doomed.add(p.id);
    this.sim.despawn(p.id);
  }

  /** How many people the zones round the player ask for, and the factor that brings that down to the budget. */
  private demand(cap: number): { total: number; scale: number } {
    const g = this.graph;
    const me = this.sim.playerPosition();
    const clock = this.sim.clock;
    const r = Math.ceil(AMBIENT.ringMax / 32);
    const cx = Math.floor(me.x / 32), cz = Math.floor(me.z / 32);
    let total = 0;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const len = g.cellLength.get(cellKey(ix, iz));
        if (!len) continue;
        const x = (ix + 0.5) * 32, z = (iz + 0.5) * 32;
        if (Math.hypot(x - me.x, z - me.z) > AMBIENT.ringMax + 16) continue;
        total += (len / 100) * this.slotAt(x, z, clock.slot, clock.weekend).peds * nearBias(Math.hypot(x - me.x, z - me.z));
      }
    }
    return { total, scale: total > cap ? cap / total : 1 };
  }

  private slotAt(x: number, z: number, slot: number, weekend: boolean): PopSlot {
    return slotOf(zoneAt(this.population, x, z), slot, weekend);
  }

  /** Spawns people where the cells round the player have fewer than the table asks for. */
  private fill(initial: boolean, scaleIn?: number) {
    const sim = this.sim;
    const g = this.graph;
    const clock = sim.clock;
    const cap = this.capacity();
    const { total, scale: s0 } = this.demand(cap);
    const scale = scaleIn ?? s0;
    this.target = Math.min(cap, Math.round(total));
    const me = sim.playerPosition();
    const lo = initial ? 14 : AMBIENT.ringMin - 8;
    const hi = initial ? AMBIENT.ringMax + 6 : AMBIENT.ringMax + 12;
    const r = Math.ceil(hi / 32) + 1;
    const cx = Math.floor(me.x / 32), cz = Math.floor(me.z / 32);
    const have = new Map<number, number>();
    for (const p of this.list) {
      const k = cellKey(Math.floor(p.controller.x / 32), Math.floor(p.controller.z / 32));
      have.set(k, (have.get(k) ?? 0) + 1);
    }
    interface Cand { key: number; deficit: number; x: number; z: number }
    const cands: Cand[] = [];
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const key = cellKey(ix, iz);
        const len = g.cellLength.get(key);
        if (!len) continue;
        const x = (ix + 0.5) * 32, z = (iz + 0.5) * 32;
        const d = Math.hypot(x - me.x, z - me.z);
        if (d < lo || d > hi) continue;
        const want = (len / 100) * this.slotAt(x, z, clock.slot, clock.weekend).peds * nearBias(d) * scale;
        const deficit = want - (have.get(key) ?? 0);
        if (deficit > 0.2) cands.push({ key, deficit, x, z });
      }
    }
    let budget = initial ? 400 : AMBIENT.perStep;
    let guard = initial ? 900 : 12;
    while (this.list.length < this.target && budget > 0 && guard-- > 0 && cands.length) {
      let sum = 0;
      for (const c of cands) sum += c.deficit;
      let pick = this.rng.next() * sum;
      let ci = 0;
      for (; ci < cands.length - 1; ci++) {
        pick -= cands[ci].deficit;
        if (pick <= 0) break;
      }
      const cell = cands[ci];
      const made = this.spawnIn(cell.key, cell.x, cell.z, initial);
      if (made > 0) {
        budget--;
        cell.deficit -= made;
        if (cell.deficit <= 0.2) cands.splice(ci, 1);
      } else {
        cell.deficit -= 0.5;
        if (cell.deficit <= 0.2) cands.splice(ci, 1);
      }
    }
  }

  private pickGroup(slot: PopSlot): { id: string; g: PedGroup } {
    const ids = Object.keys(slot.pedGroups);
    if (ids.length === 0) {
      const first = Object.keys(this.population.pedGroups)[0];
      return { id: first, g: this.population.pedGroups[first] };
    }
    let sum = 0;
    for (const id of ids) sum += slot.pedGroups[id];
    let pick = this.rng.next() * sum;
    for (const id of ids) {
      pick -= slot.pedGroups[id];
      if (pick <= 0) return { id, g: this.population.pedGroups[id] };
    }
    const id = ids[ids.length - 1];
    return { id, g: this.population.pedGroups[id] };
  }

  /** Makes one person (or a group at a scenario point) in a cell. Returns how many. */
  private spawnIn(key: number, mx: number, mz: number, initial: boolean): number {
    const sim = this.sim;
    const g = this.graph;
    const me = sim.playerPosition();
    const zone = zoneAt(this.population, mx, mz);
    const slot = slotOf(zone, sim.clock.slot, sim.clock.weekend);
    const { id: gid, g: group } = this.pickGroup(slot);
    const wantScenario = this.rng.next() * (group.behaviour.wander + group.behaviour.scenario) < group.behaviour.scenario;
    const ok = (x: number, y: number, z: number) => {
      const d = Math.hypot(x - me.x, z - me.z);
      if (d < (initial ? 12 : AMBIENT.ringMin - 4) || d > AMBIENT.ringMax + 20) return false;
      if (!initial && this.visible(x, y, z)) return false;
      for (const p of this.list) if (Math.abs(p.controller.x - x) < 1.4 && Math.abs(p.controller.z - z) < 1.4) return false;
      return true;
    };

    if (wantScenario) {
      const idxs = (this.scenarios.cells.get(key) ?? []).filter((i) => this.scenarios.free(i) > 0);
      if (idxs.length) {
        let sum = 0;
        const w = idxs.map((i) => {
          const t = this.scenarios.points[i].type;
          const v = TYPE_WEIGHT[t] * (KIND_BOOST[zone.kind]?.[t] ?? 1) * (this.scenarios.free(i) > 1 ? 1.3 : 1);
          sum += v;
          return v;
        });
        let pick = this.rng.next() * sum;
        let k = 0;
        for (; k < idxs.length - 1; k++) {
          pick -= w[k];
          if (pick <= 0) break;
        }
        const i = idxs[k];
        const pt = this.scenarios.points[i];
        if (ok(pt.x, pt.y, pt.z)) return this.spawnScenario(i, gid, group);
      }
    }
    // a walker on a sidewalk of the cell
    const edges = g.cells.get(key);
    if (!edges) return 0;
    for (let tries = 0; tries < 8; tries++) {
      const e = edges[this.rng.int(0, edges.length - 1)];
      if (!g.isSpawnEdge(e)) continue;
      const t = this.rng.range(0.1, 0.9);
      const a = g.ea[e], b = g.eb[e];
      const x = g.x[a] + (g.x[b] - g.x[a]) * t, z = g.z[a] + (g.z[b] - g.z[a]) * t;
      const y = g.yAt(e, t);
      if (!ok(x, y, z) || !this.standable(x, y, z, true)) continue;
      // not on an edge a pole, a low deck or a wall blocks, nor in a pocket of the network that is cut off by one
      if (this.clearance.isBlocked(e) || !g.hasRoom(e)) continue;
      const forward = this.rng.chance(0.5);
      this.makePed(gid, group, x, y, z, forward ? a : b, forward ? b : a, null);
      return 1;
    }
    return 0;
  }

  /** Puts a group of people at a scenario point, already doing it (public for tests and tools). */
  spawnScenario(i: number, gid: string, group: PedGroup): number {
    const pt = this.scenarios.points[i];
    const free = this.scenarios.free(i);
    const cap = Math.min(free, pt.type === 'atm' ? 1 : pt.type === 'bench' ? 2 : pt.type === 'shopfront' ? 2 : 3);
    const n = Math.max(1, this.rng.int(1, Math.max(1, cap)));
    const action = this.actionFor(pt.type, n, gid);
    const chat = action === 'chat';
    const node = this.graph.nearestNode(pt.x, pt.z, 40);
    if (node < 0) return 0;
    this.scenarios.take(i, n);
    const dur = this.rng.range(60, 240);
    let made = 0;
    for (let s = 0; s < n; s++) {
      const sp = slotPosition(pt, s, n, chat);
      // a slot beside a wall may be inside it: nudge it clear, or leave that place empty
      let { x: sx, z: sz } = sp;
      let sy = pt.y;
      if (!this.standable(sx, sy, sz, false)) {
        const near = this.sim.physics.clearSpot(sx, sy, sz, 1.0, { props: false });
        if (!near || !this.standable(near.x, near.y, near.z, false)) {
          this.scenarios.release(i);
          continue;
        }
        sx = near.x; sy = near.y; sz = near.z;
      }
      const ped = this.makePed(gid, group, sx, sy, sz, node, -1, { yaw: sp.yaw + this.rng.range(-0.15, 0.15), point: i, slot: s, count: n, action, dur: dur * this.rng.range(0.8, 1.25), type: pt.type });
      if (!ped) this.scenarios.release(i);
      else made++;
    }
    return made;
  }

  /**
   * Whether somebody can be put at (x, y, z): not in a building, clear of walls (and of the street furniture, unless they are to sit or
   * stand at it), with the ground under their feet. Every spawn is checked; nobody is made in a wall.
   */
  standable(x: number, y: number, z: number, props: boolean): boolean {
    const phys = this.sim.physics;
    const floor = phys.floorBelow(x, y + 0.6, z, 1.6);
    if (Number.isNaN(floor) || Math.abs(floor - y) > 0.6) return false;
    return !phys.blockedAt(x, y, z, { props });
  }

  private actionFor(type: ScenarioType, n: number, group: string): ScenarioAction {
    const r = this.rng.next();
    switch (type) {
      case 'bench': return 'sit';
      case 'busstop': return r < 0.55 ? 'phone' : 'wait';
      case 'atm': return 'atm';
      case 'shopfront': return n > 1 ? 'chat' : 'browse';
      case 'eatery': return n > 1 ? 'chat' : r < 0.5 ? 'phone' : 'wait';
      case 'lawn': return n > 1 ? 'chat' : 'sit';
      case 'plaza': return n > 1 ? (r < 0.6 ? 'chat' : 'photo') : group === 'tourists' && r < 0.7 ? 'photo' : 'wait';
      case 'corner': return n > 1 ? 'chat' : r < 0.6 ? 'phone' : 'wait';
    }
  }

  /** Makes one pedestrian at a place (public for tests and tools; the director calls it). */
  makePed(
    gid: string,
    group: PedGroup,
    x: number,
    y: number,
    z: number,
    node: number,
    next: number,
    sc: { yaw: number; point: number; slot: number; count: number; action: ScenarioAction; dur: number; type: ScenarioType } | null,
  ): PedEntity | null {
    const sim = this.sim;
    const g = this.graph;
    const outfit = group.outfits[this.rng.int(0, group.outfits.length - 1)];
    const speed = this.rng.range(group.walkSpeed[0], group.walkSpeed[1]);
    const lane = this.rng.range(-0.55, 0.55);
    let yaw = sc ? sc.yaw : this.rng.range(-Math.PI, Math.PI);
    if (!sc && next >= 0) yaw = Math.atan2(g.x[next] - x, g.z[next] - z);
    const ped = sim.addPed(x, y, z, yaw, outfit, true, (p) => {
      const a = newAmbientState(gid, speed, lane, sim.tick);
      a.node = node;
      a.next = next;
      a.heading = yaw;
      if (sc) {
        a.mode = 'scenario';
        a.sc = sc.point;
        a.scSlot = sc.slot;
        a.scCount = sc.count;
        a.scAction = sc.action;
        a.scUntil = sc.dur;
        a.scType = sc.type;
        a.poseT = this.rng.range(1, 5);
      }
      p.amb = a;
    });
    ped.brain!.enter('idle');
    this.list.push(ped);
    this.spawned++;
    return ped;
  }

  // ----------------------------------------------------------------------------------------------
  // Around the player: other bodies and the traffic

  private refreshAround() {
    const sim = this.sim;
    this.ox.length = this.oz.length = this.oplayer.length = 0;
    const playerId = sim.playerPedId;
    for (const p of sim.peds()) {
      if (p.vehicleId) continue;
      this.ox.push(p.controller.x);
      this.oz.push(p.controller.z);
      this.oplayer.push(p.id === playerId);
    }
    this.vx.length = this.vz.length = this.vvx.length = this.vvz.length = this.vspd.length = this.vside.length = 0;
    const me = sim.playerPosition();
    for (const v of sim.vehicles()) {
      const t = v.car.body.translation();
      if (Math.abs(t.x - me.x) > 160 || Math.abs(t.z - me.z) > 160) continue;
      const lv = v.car.body.linvel();
      let lvx = lv.x, lvz = lv.z;
      let spd = Math.hypot(lvx, lvz);
      // a car that follows a lane by script (traffic far from the player) may not report a body velocity: take it from the speed it drives at
      const sf = v.car.speedForward;
      if (spd < 0.5 && Math.abs(sf) > 0.8) {
        const yaw = v.car.yaw;
        lvx = Math.sin(yaw) * sf;
        lvz = Math.cos(yaw) * sf;
        spd = Math.abs(sf);
      }
      this.vx.push(t.x);
      this.vz.push(t.z);
      this.vvx.push(lvx);
      this.vvz.push(lvz);
      this.vspd.push(spd);
      this.vside.push(spd > 3 && !v.burnt && this.graph.nearestEdge(t.x, t.z, 1.0, PAVEMENT_KINDS) !== null && !this.roadMask.contains(t.x, t.z, 0.3));
    }
  }

  // ----------------------------------------------------------------------------------------------
  // One person

  private step(ped: PedEntity, dt: number) {
    const a = ped.amb!;
    const b = ped.brain!;
    const sim = this.sim;
    ped.pose = 0;
    a.lite = false;
    if (a.lookCool > 0) a.lookCool -= dt;
    if (a.startleCool > 0) a.startleCool -= dt;
    if (ped.life !== 'alive' || ped.busy || ped.vehicleId) {
      this.leaveScenario(a);
      a.reactKind = '';
      return;
    }
    switch (b.state) {
      case 'flee':
      case 'fight':
        this.violent(ped, a, b.state);
        if (b.state === 'flee') this.steerFlee(ped, a, b, dt);
        return;
      case 'dragged':
      case 'seated':
        return;
      case 'calm':
        a.mode = 'calm';
        a.calmT += dt;
        if (a.calmT > 6) {
          a.calmT = 0;
          b.enter('idle');
          this.resumeWalk(ped, a);
        }
        return;
      default:
        break;
    }
    a.calmT = 0;
    if (a.reactKind && sim.tick >= a.reactAt) this.beginReaction(ped, a);
    if (this.n % 6 === ped.id % 6) this.checkTraffic(ped, a);
    if (a.mode === 'walk' || a.mode === 'wait' || a.mode === 'scenario') this.chooseLite(ped, a);
    switch (a.mode) {
      case 'walk': this.stepWalk(ped, a, dt); break;
      case 'wait': this.stepWait(ped, a, dt); break;
      case 'scenario': this.stepScenario(ped, a, dt); break;
      case 'cower':
      case 'film':
      case 'look': this.stepHold(ped, a, dt); break;
      default: this.resumeWalk(ped, a); break;
    }
  }

  /** Far-off walkers and anyone standing still skip the character controller (the walk network is clear of walls, and the move keeps out of the ones it is not). */
  private chooseLite(ped: PedEntity, a: AmbientState) {
    const c = ped.controller;
    const me = this.sim.playerPosition();
    const d = Math.hypot(c.x - me.x, c.z - me.z);
    if (a.mode !== 'scenario' && d < (a.lite ? 38 : 46)) return;
    if (!a.lite || (this.n + ped.id) % 6 === 0) {
      // the floor under the feet (ground, deck, a step up onto one), asked of the physics world a few times a second; the network's heights are the guide
      const est = a.mode === 'scenario' ? c.y : this.surfaceY(c, a);
      const f = this.sim.physics.floorBelow(c.x, Math.max(c.y, est) + 0.5, c.z, 1.8);
      a.liteY = !Number.isNaN(f) && Math.abs(f - est) < 1.5 ? f : est;
    }
    a.lite = true;
  }

  /**
   * The height somebody walking the network stands at: the ground, or, on a deck (a footbridge, a bridge's sidewalk), the deck,
   * read off the edge they are on at the point they have got to.
   */
  private surfaceY(c: { x: number; z: number; y: number }, a: AmbientState): number {
    const g = this.graph;
    const gy = this.sim.groundAt(c.x, c.z);
    const from = a.node >= 0 ? a.node : a.prev;
    const to = a.next >= 0 ? a.next : a.node;
    let ny: number;
    if (from >= 0 && to >= 0 && from !== to) {
      const ax = g.x[from], az = g.z[from], dx = g.x[to] - ax, dz = g.z[to] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / l2)) : 0;
      ny = g.y[from] + (g.y[to] - g.y[from]) * t;
    } else if (to >= 0) ny = g.y[to];
    else return gy;
    // network heights are the sidewalk's (the ground plus 10 cm) or a deck's
    return Math.abs(ny - 0.1 - gy) > 0.15 ? ny : gy;
  }

  /** The brain is running or fighting this person: note it, and let the brain do it. */
  private violent(ped: PedEntity, a: AmbientState, state: 'flee' | 'fight') {
    if (a.mode === state) return;
    this.leaveScenario(a);
    a.mode = state;
    a.crossAttr = -1;
    a.reactKind = '';
    if (state === 'fight') a.persistent = true;
    if (state === 'flee') {
      a.route = null;
      a.fleeT = 3;
      const p = this.sim.playerPosition();
      this.sim.emit({ type: 'ped:react', tick: this.sim.tick, pedId: ped.id, reaction: 'flee', cause: 'violence', x: p.x, z: p.z });
    }
  }

  private resumeWalk(ped: PedEntity, a: AmbientState) {
    const c = ped.controller;
    this.leaveScenario(a);
    let n = this.graph.nearestNode(c.x, c.z, 40);
    if (n < 0) n = this.graph.nearestNode(c.x, c.z, 160);
    if (n < 0) {
      // nowhere to walk to: gone if nobody can see it, else it stands there
      if (this.mayRemove(ped)) this.remove(ped);
      else {
        ped.brain!.enter('calm');
        a.mode = 'calm';
      }
      return;
    }
    a.mode = 'walk';
    a.node = n;
    a.prev = -1;
    a.next = -1;
    a.route = null;
    a.crossAttr = -1;
    a.waitEdge = -1;
  }

  private leaveScenario(a: AmbientState) {
    if (a.sc >= 0) {
      this.scenarios.release(a.sc);
      a.sc = -1;
    }
  }

  /** Walks `ped` in direction `h` at `speed`, with the body's own turning. */
  private move(ped: PedEntity, a: AmbientState, h: number, speed: number, dt: number) {
    a.heading = approachAngle(a.heading, h, 7 * dt);
    const i = ped.input;
    i.moveX = 0;
    i.moveY = moveMag(speed);
    i.camYaw = a.heading + Math.PI;
    i.sprint = false;
  }

  private face(ped: PedEntity, tx: number, tz: number, dt: number) {
    const c = ped.controller;
    c.yaw = approachAngle(c.yaw, Math.atan2(tx - c.x, tz - c.z), 4 * dt);
  }

  // -- walking ----------------------------------------------------------------------------------

  private stepWalk(ped: PedEntity, a: AmbientState, dt: number) {
    const g = this.graph;
    const c = ped.controller;
    if (a.node < 0 && a.next < 0) {
      this.resumeWalk(ped, a);
      return;
    }
    if (a.next < 0 && !this.chooseNext(ped, a)) return;
    const from = a.node >= 0 ? a.node : a.prev;
    const n = a.next;
    let tx = g.x[n], tz = g.z[n];
    const ex = tx - (from >= 0 ? g.x[from] : c.x), ez = tz - (from >= 0 ? g.z[from] : c.z);
    const el = Math.hypot(ex, ez) || 1;
    const onCrossing = a.crossAttr >= 0;
    let lane = onCrossing ? 0 : a.lane;
    if (lane !== 0 && from >= 0) {
      // keep to where the edge is clear of walls and poles
      let e = a.edge;
      if (e < 0 || !((g.ea[e] === from && g.eb[e] === n) || (g.eb[e] === from && g.ea[e] === n))) e = a.edge = g.edgeBetween(from, n);
      if (e >= 0) lane = this.clearance.lane(e, from, lane);
    }
    tx += (ez / el) * lane;
    tz += (-ex / el) * lane;
    const dx = tx - c.x, dz = tz - c.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.75) {
      a.prev = a.node;
      a.node = a.next;
      a.next = -1;
      return;
    }
    // the way to go, nudged round other people and the player
    let ux = dx / dist, uz = dz / dist;
    let slow = 1;
    const side = ped.id & 1 ? 0.9 : -0.9;
    for (let k = 0; k < this.ox.length; k++) {
      const ddx = c.x - this.ox[k], ddz = c.z - this.oz[k];
      const d = Math.hypot(ddx, ddz);
      if (d < 0.05) continue;
      const reach = this.oplayer[k] ? AMBIENT.stepAside : 1.3;
      if (d >= reach) continue;
      const push = ((reach - d) / reach) * (this.oplayer[k] ? 1.9 : 0.9);
      // away from them, and to one side (each person has a side they pass on), so two people face to face go round each other instead of stalling
      ux += (ddx / d) * push - (ddz / d) * push * side;
      uz += (ddz / d) * push + (ddx / d) * push * side;
      // someone in the way ahead: ease off
      if ((-ddx * ux - ddz * uz) / d > 0.6 && d < 0.9) slow = 0.55;
    }
    const ul = Math.hypot(ux, uz) || 1;
    let speed = a.speed * slow;
    if (onCrossing) speed *= this.crossingHurry(ped) ? 1.9 : 1.25;
    this.move(ped, a, Math.atan2(ux / ul, uz / ul), Math.min(speed, 3.4), dt);
    // stuck: no progress for a while
    a.stuckT += dt;
    if (a.stuckT >= 2.5) {
      const moved = Math.hypot(c.x - a.stuckX, c.z - a.stuckZ);
      a.stuckT = 0;
      a.stuckX = c.x;
      a.stuckZ = c.z;
      if (moved < 0.4) {
        a.stuckN++;
        if (a.stuckN === 1 && a.prev >= 0) {
          // turn round
          a.edge = -1;
          a.next = a.prev;
          a.prev = a.node;
          a.crossAttr = -1;
        } else if (a.stuckN >= 2) {
          a.stuckN = 0;
          if (this.mayRemove(ped)) this.remove(ped);
          else this.resumeWalk(ped, a);
        }
      } else a.stuckN = 0;
    }
  }

  /** Picks the next node from where the walker stands. Returns false when it began waiting at a crossing instead. */
  private chooseNext(ped: PedEntity, a: AmbientState): boolean {
    const g = this.graph;
    const n = a.node;
    if (n < 0) return false;
    if (a.route && a.routeI < a.route.length) {
      const m = a.route[a.routeI++];
      const e = g.edgeBetween(n, m);
      if (e >= 0) return this.takeEdge(a, e, m);
      a.route = null;
    }
    const at = g.edgesAt(n);
    const s = 0, t = at.length;
    if (t === s) {
      this.remove(ped);
      return false;
    }
    const pdx = a.prev >= 0 ? g.x[n] - g.x[a.prev] : 0, pdz = a.prev >= 0 ? g.z[n] - g.z[a.prev] : 0;
    const pl = Math.hypot(pdx, pdz);
    let sum = 0;
    const ws: number[] = [];
    for (let k = s; k < t; k++) {
      const e = at[k];
      const m = g.other(e, n);
      let w = 1;
      if (m === a.prev && t - s > 1) w = 0.03;
      if (e === a.avoidEdge && t - s > 1) w = 0;
      // a pole, a low deck or a wall across the middle of an edge: never that way (unless it is the only way)
      const shut = this.clearance.isBlocked(e);
      if (shut) w = 0;
      const kind = g.kindOf(e);
      if (kind === 'crossing') w *= 0.6;
      else if (kind === 'steps') w *= 0.4;
      if (pl > 0.01) {
        const ex = g.x[m] - g.x[n], ez = g.z[m] - g.z[n];
        const el = Math.hypot(ex, ez) || 1;
        const cos = (pdx * ex + pdz * ez) / (pl * el);
        w *= 0.35 + 1.3 * Math.max(0, cos);
      }
      ws.push(w);
      sum += w;
    }
    if (sum <= 0) {
      // nowhere they like: the way back, or any way that is open, or any way
      for (let k = s; k < t; k++) ws[k - s] = this.clearance.isBlocked(at[k]) ? 0 : 1;
      sum = ws.reduce((x, y) => x + y, 0);
      if (sum <= 0) {
        ws.fill(1);
        sum = ws.length;
      }
    }
    let pick = this.rng.next() * sum;
    let k = 0;
    for (; k < ws.length - 1; k++) {
      pick -= ws[k];
      if (pick <= 0) break;
    }
    const e = at[s + k];
    return this.takeEdge(a, e, g.other(e, n));
  }

  private takeEdge(a: AmbientState, e: number, m: number): boolean {
    const g = this.graph;
    const meta = g.crossingOf(e);
    if (meta && a.crossAttr !== g.eattr[e]) {
      a.mode = 'wait';
      a.waitEdge = e;
      a.waitT = 0;
      a.next = -1;
      return false;
    }
    if (!meta) a.crossAttr = -1;
    a.next = m;
    a.edge = e;
    return true;
  }

  // -- crossing ----------------------------------------------------------------------------------

  private stepWait(ped: PedEntity, a: AmbientState, dt: number) {
    const g = this.graph;
    const e = a.waitEdge;
    if (e < 0 || a.node < 0) {
      this.resumeWalk(ped, a);
      return;
    }
    const m = g.other(e, a.node);
    this.face(ped, g.x[m], g.z[m], dt);
    a.waitT += dt;
    if ((this.n + ped.id) % 8 === 0 && this.canCross(a, e)) {
      a.crossAttr = g.eattr[e];
      a.next = m;
      a.mode = 'walk';
      a.waitEdge = -1;
      return;
    }
    if (a.waitT > 60) {
      // it never cleared: try another way
      a.avoidEdge = e;
      a.mode = 'walk';
      a.next = -1;
      a.waitEdge = -1;
    }
  }

  /** The walk light says go (and nobody is running the red), or, with no light, there is a gap. */
  canCross(a: AmbientState, e: number): boolean {
    const g = this.graph;
    const meta = g.crossingOf(e)!;
    const from = a.node;
    const to = g.other(e, from);
    const ax = g.x[from], az = g.z[from], bx = g.x[to], bz = g.z[to];
    const len = g.len[e];
    const speed = a.speed * 1.25;
    if (meta.signals && meta.junction && meta.leg !== null) {
      const j = this.junctionOf.get(meta.junction);
      if (j) {
        if (walkState(j, meta.leg, this.sim.tick * SIM_DT) !== 'walk') return false;
        return this.gapSafe(ax, az, bx, bz, 1.5 + len / speed * 0.2);
      }
    }
    // no light: a gap in the traffic. Marked crossings are crossed more boldly; the longer one waits, the bolder.
    const bold = meta.marked ? 0.55 : 1;
    const waited = a.waitT > 10 ? 0.7 : 1;
    return this.gapSafe(ax, az, bx, bz, (bold * (len / speed) + (meta.marked ? 1.2 : 2.5)) * waited);
  }

  /** True when no car will reach the crossing segment within `horizon` seconds, and none stands on it. */
  private gapSafe(ax: number, az: number, bx: number, bz: number, horizon: number): boolean {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const half = Math.hypot(bx - ax, bz - az) / 2;
    for (let k = 0; k < this.vx.length; k++) {
      const px = this.vx[k], pz = this.vz[k];
      if (Math.abs(px - mx) > 80 || Math.abs(pz - mz) > 80) continue;
      const spd = this.vspd[k];
      if (spd < 1.2) {
        // a car stopped on the crossing blocks it
        if (distSeg(px, pz, ax, az, bx, bz) < 2.2) return false;
        continue;
      }
      const hx = this.vvx[k] / spd, hz = this.vvz[k] / spd;
      const along = (mx - px) * hx + (mz - pz) * hz;
      if (along < -4) continue;
      // where its path meets the crossing line
      const qx = px + hx * Math.max(along, 0), qz = pz + hz * Math.max(along, 0);
      if (distSeg(qx, qz, ax, az, bx, bz) > 2.4 + (spd > 6 ? 0.8 : 0)) {
        if (Math.hypot(px - mx, pz - mz) > half + 3) continue;
      }
      const t = Math.max(0, along - 4) / spd;
      if (t < horizon) return false;
    }
    return true;
  }

  /** A car is coming on someone halfway across: hurry. */
  private crossingHurry(ped: PedEntity): boolean {
    const c = ped.controller;
    for (let k = 0; k < this.vx.length; k++) {
      if (this.vspd[k] < 2.5) continue;
      const dx = c.x - this.vx[k], dz = c.z - this.vz[k];
      const d = Math.hypot(dx, dz);
      if (d < 14 && (dx * this.vvx[k] + dz * this.vvz[k]) / (d * this.vspd[k] || 1) > 0.5) return true;
    }
    return false;
  }

  // -- standing about ------------------------------------------------------------------------------

  private stepScenario(ped: PedEntity, a: AmbientState, dt: number) {
    ped.input.moveX = ped.input.moveY = 0;
    a.scUntil -= dt;
    a.poseT -= dt;
    if (a.scUntil <= 0) {
      // done: someone nobody is looking at goes (so the director makes new people for the benches and the stops, and the
      // street keeps its mix); someone in view walks off
      if (this.mayRemove(ped)) this.remove(ped);
      else this.resumeWalk(ped, a);
      return;
    }
    const talk = a.poseT > 0;
    if (a.poseT <= -2.5 - (ped.id % 3)) a.poseT = this.rng.range(1.5, 5);
    switch (a.scAction) {
      case 'sit': ped.pose = 1; break;
      case 'phone': ped.pose = 2; break;
      case 'wait': ped.pose = talk ? 0 : 2; break;
      case 'chat': ped.pose = talk && (ped.id + this.n / 90) % 2 < 1.4 ? 5 : 0; break;
      case 'atm': ped.pose = 6; break;
      case 'browse': ped.pose = talk ? 7 : 0; break;
      case 'photo': ped.pose = 3; break;
    }
  }

  private stepHold(ped: PedEntity, a: AmbientState, dt: number) {
    ped.input.moveX = ped.input.moveY = 0;
    this.face(ped, a.faceX, a.faceZ, dt);
    a.until -= dt;
    ped.pose = a.mode === 'cower' ? 4 : a.mode === 'film' ? 3 : 0;
    if (a.until > 0) return;
    if (a.mode === 'cower') {
      // up again: run, if it looked as bad as it did
      if (this.rng.chance(0.55)) {
        this.startFlee(ped, a, a.faceX, a.faceZ);
        return;
      }
    }
    this.resumeWalk(ped, a);
  }

  // ----------------------------------------------------------------------------------------------
  // Reactions

  private beginReaction(ped: PedEntity, a: AmbientState) {
    const kind = a.reactKind;
    a.reactKind = '';
    if (!kind || a.mode === 'cower') return;
    const cause = a.reactCause as PedCause;
    const c = ped.controller;
    switch (kind) {
      case 'flee':
        this.startFlee(ped, a, a.reactX, a.reactZ);
        break;
      case 'cower':
        this.leaveScenario(a);
        a.mode = 'cower';
        a.crossAttr = -1;
        a.until = this.rng.range(3, 7);
        a.faceX = a.reactX;
        a.faceZ = a.reactZ;
        break;
      case 'film':
        this.leaveScenario(a);
        a.mode = 'film';
        a.crossAttr = -1;
        a.until = this.rng.range(6, 14);
        a.faceX = a.reactX;
        a.faceZ = a.reactZ;
        break;
      case 'look':
        this.leaveScenario(a);
        a.mode = 'look';
        a.crossAttr = -1;
        a.until = this.rng.range(3, 6.5);
        a.faceX = a.reactX;
        a.faceZ = a.reactZ;
        a.lookCool = 12;
        break;
      case 'startle': {
        const dx = c.x - a.reactX, dz = c.z - a.reactZ;
        const d = Math.hypot(dx, dz) || 1;
        c.launch((dx / d) * 2.8, 0, (dz / d) * 2.8);
        a.startleCool = 3;
        break;
      }
    }
    this.sim.emit({ type: 'ped:react', tick: this.sim.tick, pedId: ped.id, reaction: kind as PedReaction, cause, x: a.reactX, z: a.reactZ });
  }

  private startFlee(ped: PedEntity, a: AmbientState, fx: number, fz: number) {
    const b = ped.brain!;
    this.leaveScenario(a);
    a.mode = 'flee';
    a.crossAttr = -1;
    a.route = null;
    a.fleeT = 3;
    b.enter('flee');
    b.threat = { x: fx, z: fz };
  }

  /**
   * A runner heads for a far stretch of the walk network: the brain is steered to the next node of
   * its escape route. Replanned every few seconds (sooner when it has no route). Off the network, or
   * with nowhere clearly farther to go, there is no waypoint and the brain runs by open ground.
   */
  private steerFlee(ped: PedEntity, a: AmbientState, b: PedBrain, dt: number) {
    const g = this.graph;
    const c = ped.controller;
    const threat = b.threat ?? this.sim.playerPosition();
    a.fleeT += dt;
    const r = a.route;
    if (r && a.routeI < r.length && Math.hypot(g.x[r[a.routeI]] - c.x, g.z[r[a.routeI]] - c.z) < 1.6) a.routeI++;
    const spent = r !== null && a.routeI >= r.length;
    if (spent || a.fleeT >= 3 || (a.route === null && a.fleeT >= 1)) {
      a.route = g.escapeRoute(c.x, c.z, threat.x, threat.z);
      a.routeI = 0;
      a.fleeT = 0;
    }
    const next = a.route && a.routeI < a.route.length ? a.route[a.routeI] : -1;
    b.waypoint = next >= 0 ? { x: g.x[next], z: g.z[next] } : null;
  }

  /** Decides what someone at distance `d` from something frightening does, and when it starts. */
  private decide(ped: PedEntity, a: AmbientState, cause: PedCause, x: number, z: number, d: number, strength = 0) {
    const b = ped.brain!;
    if (a.mode === 'flee' || a.mode === 'fight' || a.mode === 'cower' || a.mode === 'calm') return;
    const courage = b.personality.courage;
    const r = this.rng.next();
    let kind: AmbientState['reactKind'];
    switch (cause) {
      case 'explosion':
        kind = d < 14 && courage < 0.5 && r < 0.45 ? 'cower' : 'flee';
        break;
      case 'crash':
        kind = strength > 11 && d < 9 ? 'flee' : courage > 0.6 && r < 0.3 ? 'film' : r < 0.75 ? 'look' : '';
        break;
      case 'wreck':
        kind = r < 0.7 ? 'look' : courage > 0.6 && r < 0.9 ? 'film' : '';
        break;
      case 'gunfire':
        // Shots: most run, the timid drop where they stand, and now and then somebody holds a phone up.
        if (courage < 0.4 && d < 14 && r < 0.5) kind = 'cower';
        else if (courage > 0.88 && d > 12 && r < 0.2) kind = 'film';
        else if (d > 45 && r < 0.35) kind = 'look';
        else kind = 'flee';
        break;
      default:
        // violence and carjacking
        if (courage > 0.78 && d > 5 && r < 0.5) kind = 'film';
        else if (courage < 0.3 && d < 16 && r < 0.6) kind = 'cower';
        else if (d > 18 && r < 0.25) kind = 'look';
        else kind = 'flee';
    }
    if (!kind) return;
    a.reactKind = kind;
    a.reactCause = cause;
    a.reactX = x;
    a.reactZ = z;
    a.reactAt = this.sim.tick + Math.round(this.rng.range(AMBIENT.reactDelay[0], AMBIENT.reactDelay[1]) * 60);
  }

  /** Everyone within `radius` who can see the spot reacts. */
  scare(x: number, y: number, z: number, radius: number, cause: PedCause, strength = 0) {
    const law = this.sim.law;
    for (const ped of this.list) {
      if (ped.life !== 'alive' || ped.vehicleId || ped.busy) continue;
      const a = ped.amb!;
      const c = ped.controller;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d > radius) continue;
      // A burst of fire is dozens of shots: whoever is already running, hiding or fighting has made up their mind (and costs no ray).
      if (cause === 'gunfire' && (a.mode === 'flee' || a.mode === 'cower' || a.mode === 'fight' || a.mode === 'calm')) continue;
      // Gunfire is heard through walls within a share of its range; everything else has to be seen.
      const heard = cause === 'gunfire' && d <= radius * 0.6;
      if (d > 6 && !heard && !law.clearLine({ x: c.x, y: c.y + 1.5, z: c.z }, { x, y: y + 1.2, z })) continue;
      this.decide(ped, a, cause, x, z, d, strength);
    }
  }

  private checkTraffic(ped: PedEntity, a: AmbientState) {
    if (a.mode === 'flee' || a.mode === 'fight' || a.mode === 'cower') return;
    const c = ped.controller;
    for (let k = 0; k < this.vx.length; k++) {
      const spd = this.vspd[k];
      if (spd < 3) continue;
      const dx = c.x - this.vx[k], dz = c.z - this.vz[k];
      const d = Math.hypot(dx, dz);
      if (d > 12) continue;
      const ahead = (dx * this.vvx[k] + dz * this.vvz[k]) / (d * spd || 1);
      if (this.vside[k] && d < 11 && ahead > -0.2) {
        a.reactKind = 'flee';
        a.reactCause = 'car-on-sidewalk';
        a.reactX = this.vx[k];
        a.reactZ = this.vz[k];
        a.reactAt = this.sim.tick + 6;
        return;
      }
      if (spd > 8 && d < 2.8 && a.startleCool <= 0 && a.crossAttr < 0 && !a.reactKind) {
        a.reactKind = 'startle';
        a.reactCause = 'fast-car';
        a.reactX = this.vx[k];
        a.reactZ = this.vz[k];
        a.reactAt = this.sim.tick;
        return;
      }
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Events

  /** Called by the sim for every event it emits; handled at the start of the ambient system's tick. */
  onEvent(e: SimEvent) {
    switch (e.type) {
      case 'weapon:fire':
      case 'damage':
      case 'carjack':
      case 'vehicle:explode':
      case 'vehicle:impact':
      case 'vehicle:fire':
      case 'vehicle:smoke':
        this.inbox.push(e);
        break;
      default:
        break;
    }
  }

  private processInbox() {
    if (this.inbox.length === 0) return;
    const sim = this.sim;
    const events = this.inbox;
    this.inbox = [];
    for (const e of events) {
      switch (e.type) {
        case 'damage': {
          const v = sim.registry.get(e.targetId) as PedEntity | undefined;
          if (v?.amb) v.amb.persistent = true;
          if (e.kind === 'melee' || e.kind === 'vehicle') this.scare(e.x, e.y, e.z, 26, 'violence');
          break;
        }
        case 'weapon:fire':
          // Gunfire: everyone within earshot reacts (the weapon says how far it carries).
          this.scare(e.x, e.y, e.z, 60 * WEAPONS[e.weapon].hearM, 'gunfire');
          break;
        case 'carjack': {
          const v = sim.registry.get(e.victimId) as PedEntity | undefined;
          if (v?.amb) v.amb.persistent = true;
          this.scare(e.x, e.y, e.z, 24, 'carjack');
          break;
        }
        case 'vehicle:explode':
          this.pois.push({ id: 100000 + e.vehicleId, x: e.x, z: e.z, left: 25, cause: 'wreck' });
          this.scare(e.x, e.y, e.z, 48, 'explosion');
          break;
        case 'vehicle:impact': {
          if (e.strength < 6) break;
          const v = sim.registry.get(e.vehicleId) as VehicleEntity | undefined;
          if (!v) break;
          const t = v.car.body.translation();
          this.pois.push({ id: 200000 + sim.tick, x: t.x, z: t.z, left: 12, cause: 'crash' });
          this.scare(t.x, t.y, t.z, 32, 'crash', e.strength);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Wrecks and recent crashes draw stares from people who walk past. */
  private scanPois() {
    const sim = this.sim;
    for (const p of this.pois) p.left -= 0.1;
    this.pois = this.pois.filter((p) => p.left > 0);
    for (const v of sim.vehicles()) {
      if (!(v.smoking || v.onFire || v.burnt)) continue;
      const t = v.car.body.translation();
      const id = 100000 + v.id;
      const poi = this.pois.find((q) => q.id === id);
      if (poi) poi.left = Math.max(poi.left, 5);
      else this.pois.push({ id, x: t.x, z: t.z, left: 5, cause: 'wreck' });
    }
    if (this.pois.length === 0) return;
    for (const ped of this.list) {
      const a = ped.amb!;
      if (a.mode !== 'walk' || a.lookCool > 0 || a.reactKind || ped.life !== 'alive') continue;
      const c = ped.controller;
      for (const poi of this.pois) {
        if (poi.id === a.seenPoi) continue;
        const d = Math.hypot(c.x - poi.x, c.z - poi.z);
        if (d > 30) continue;
        if (d > 6 && !sim.law.clearLine({ x: c.x, y: c.y + 1.5, z: c.z }, { x: poi.x, y: c.y + 1.2, z: poi.z })) continue;
        a.seenPoi = poi.id;
        if (this.rng.chance(0.55)) this.decide(ped, a, poi.cause, poi.x, poi.z, d);
        break;
      }
    }
  }
}

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

