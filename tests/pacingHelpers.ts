import { rotateVec } from '../src/shared/math';
import { doorGeometry } from '../src/shared/doors';
import type { LawData } from '../src/shared/law';
import type { SimEvent } from '../src/shared/protocol';
import { damagePed } from '../src/sim/combat/damage';
import { giveWeapon, pullTrigger } from '../src/sim/combat/weapons/api';
import type { VehicleEntity } from '../src/sim/entities';
import { Simulation } from '../src/sim/Simulation';
import { addNpc, Button, cmd, gridTile, ped, run, vehicle } from './helpers';

export type PacingCrime = 'carjack' | 'gunshot' | 'kill' | 'rampage';

export interface Timeline {
  /** Seconds after the crime. null: it did not happen inside the window. */
  call: number | null;
  /** The first police car within `viewM` of the player with a clear line. */
  carInView: number | null;
  /** The first police car within `SCENE_M` of the player: on scene. */
  onScene: number | null;
  /** The first police car spawned. */
  carSpawned: number | null;
  heat1: number | null;
  heat2: number | null;
  heat3: number | null;
  /** The first police helicopter (it appears and flies in). */
  heli: number | null;
  /** How far from the player the first police car appeared, m, and how many police cars were out at once at most. */
  spawnDistance: number | null;
  peakCars: number;
  /** The number of calls that went through, and the number of witnesses that were found. */
  witnesses: number;
  calls: number;
  maxHeat: number;
  /** Police cars alive at once when the second one spawned (spacing), and the gap between the first two spawns. */
  secondSpawn: number | null;
  events: SimEvent[];
  /** Set when the player was busted or wasted before the window ended. */
  endedAt?: number;
}

const VIEW_M = 90;
const SCENE_M = 40;
/** The second kill of a rampage comes this long after the first, s. */
export const RAMPAGE_GAP_S = 8;

/** The procedural test ground (flat, no props) with the street grid: the police need roads to come from. */
export const pacingTile = gridTile;

/**
 * A scripted crime on the procedural tile: the player on foot at the origin of the grid with `bystanders`
 * standing 8 to 28 m away in the open (every one with a clear line), then one crime. The player stays put
 * and cannot die or be arrested for the length of the window.
 */
export async function pacingRun(kind: PacingCrime, o: { seed?: number; law?: LawData; bystanders?: number; seconds?: number; mutate?: (sim: Simulation) => void } = {}): Promise<Timeline> {
  const sim = await Simulation.create({ seed: o.seed ?? 1, tile: pacingTile(), driverMood: 'flee', parkedCars: 0, driver: kind === 'carjack', ...(o.law ? { law: o.law } : {}) });
  const car = vehicle(sim);
  // The tile's own car stands on a street of the grid; put it where nobody drives past (the carjack scene moves it back beside the player).
  const px = 14;
  const pz = 14;
  if (kind === 'carjack') {
    car.car.teleport(px + 4, 0.4, pz, Math.PI / 2);
    run(sim, 30, cmd());
    const pose = car.car.pose();
    const door = doorGeometry(car.car.h);
    const w = rotateVec(pose.q, door.stand.x, 0, door.stand.z);
    ped(sim).controller.teleport(pose.x + w.x, pose.y - 0.3, pose.z + w.z);
  } else {
    car.car.teleport(450, 0.4, 450, 0);
    ped(sim).controller.teleport(px, 0, pz, 0);
  }
  const n = o.bystanders ?? 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const d = 8 + (i % 3) * 8;
    addNpc(sim, px + Math.sin(a) * d, pz + Math.cos(a) * d);
  }
  o.mutate?.(sim);
  run(sim, 30, cmd());
  sim.drainEvents();
  const p = ped(sim);
  const events: SimEvent[] = [];
  const step = (c = cmd()) => {
    sim.pushInput(1, c);
    sim.step();
    events.push(...sim.drainEvents());
    p.armour = 1e9;
    if (p.life === 'alive') p.health = 100;
    // Nobody is arrested: the timeline is about how fast the response builds.
    for (const q of sim.peds()) if (q.officer) q.officer.arrestT = 0;
  };

  // The crime.
  let victim: ReturnType<typeof addNpc> | null = null;
  if (kind === 'gunshot') {
    giveWeapon(p, 'pistol', { equip: true });
    p.gun!.equipLeft = 0;
  } else if (kind === 'kill' || kind === 'rampage') {
    victim = addNpc(sim, px, pz + 1.2);
  }
  // A rampage: a second victim, killed `RAMPAGE_GAP_S` later.
  const second = kind === 'rampage' ? addNpc(sim, px + 1.2, pz) : null;
  const t0 = sim.tick;
  if (kind === 'carjack') for (let i = 0; i < 6; i++) step(cmd({ buttons: Button.Interact }));
  else if (kind === 'gunshot') {
    p.gun!.cooldown = 0;
    pullTrigger(sim, p, { origin: { x: px, y: 1.3, z: pz + 0.5 }, dir: { x: 0, y: 0, z: 1 } }, { spreadScale: 0 });
    step();
  } else {
    damagePed(sim, victim!, 500, 'melee', p.id);
    step();
  }

  const tl: Timeline = { call: null, carInView: null, onScene: null, carSpawned: null, heat1: null, heat2: null, heat3: null, heli: null, spawnDistance: null, peakCars: 0, witnesses: 0, calls: 0, maxHeat: 0, secondSpawn: null, events };
  const total = Math.round((o.seconds ?? 200) * 60);
  for (let t = 0; t < total; t++) {
    step();
    const s = (sim.tick - t0) / 60;
    if (second && t === Math.round(RAMPAGE_GAP_S * 60)) damagePed(sim, second, 500, 'melee', p.id);
    const h = sim.law.heat.level;
    tl.maxHeat = Math.max(tl.maxHeat, h);
    let cars = 0;
    for (const v of sim.vehicles()) if (v.police && !v.roadblock) cars++;
    tl.peakCars = Math.max(tl.peakCars, cars);
    if (tl.spawnDistance === null && cars > 0) {
      const me = sim.playerPosition();
      for (const v of sim.vehicles()) if (v.police) {
        const q = v.car.pose();
        tl.spawnDistance = Math.hypot(q.x - me.x, q.z - me.z);
      }
    }
    if (h >= 1) tl.heat1 ??= s;
    if (h >= 2) tl.heat2 ??= s;
    if (h >= 3) tl.heat3 ??= s;
    if (tl.carInView === null || tl.onScene === null) {
      const me = sim.playerPosition();
      for (const v of sim.vehicles()) {
        if (!v.police) continue;
        const q = v.car.pose();
        if (Math.hypot(q.x - me.x, q.z - me.z) <= SCENE_M) tl.onScene ??= s;
        if (tl.carInView === null && Math.hypot(q.x - me.x, q.z - me.z) <= VIEW_M && sim.law.clearLine({ x: q.x, y: q.y + 1, z: q.z }, { x: me.x, y: 1.4, z: me.z })) tl.carInView = s;
      }
    }
    if (t % 30 === 0 && sim.lifeOf(1).mode !== 'alive') {
      tl.endedAt = s;
      break;
    }
  }
  for (const e of events) {
    const s = (e.tick - t0) / 60;
    if (e.type === 'crime' && tl.witnesses === 0) tl.witnesses = e.witnesses;
    if (e.type === 'crime:reported' && !e.police) {
      tl.calls++;
      tl.call ??= s;
    }
    if (e.type === 'police:spawn') {
      if (tl.carSpawned === null) tl.carSpawned = s;
      else tl.secondSpawn ??= s;
    }
    if (e.type === 'police:helicopter' && e.state === 'inbound') tl.heli ??= s;
  }
  return tl;
}
