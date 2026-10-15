/**
 * WEAPONS API: guns for the player and for any NPC (the police build on this).
 *
 * The numbers are in `src/shared/data/weapons.json` (types and pure helpers: `src/shared/weapons.ts`,
 * re-exported here). The state of a gun lives on the ped: `ped.gun` (null when unarmed).
 *
 * ---- Arming an NPC ---------------------------------------------------------------------------
 *   giveWeapon(ped, 'pistol')                       // carry it, with the weapon's starting magazine and reserve; equips it if it is the first
 *   giveWeapon(ped, 'rifle', { equip: true, infinite: true })   // infinite: reloads are free, the reserve never runs out
 *   giveLoadout(ped, 'shotgun', { infinite: true }) // a dispatch row's `loadout` string ('none' | 'pistol' | 'shotgun' | 'rifle'): shotgun + pistol
 *   selectWeapon(sim, ped, 'pistol')                // draw another carried weapon (takes `equipS` before it fires)
 *
 * ---- Shooting ----------------------------------------------------------------------------------
 *   shootAt(sim, ped, target, { skill })     // the one call an AI needs: aim at a ped, vehicle or point, face it, and pull the trigger
 *                                            // if the gun is ready. Skill 0..1 narrows the spread (default 0.5). Returns a TriggerResult.
 *   aimAt(sim, ped, target)                  // raise the gun toward it without firing (stays up for ~1 s unless refreshed)
 *   holster(ped)                             // lower the gun
 *   pullTrigger(sim, ped, { origin, dir })   // fire along a ray you choose, with all the bookkeeping: cooldown (fire rate), magazine,
 *                                            // reload, bloom, equip time. Status: 'fired' | 'empty' | 'reloading' | 'cooldown' |
 *                                            // 'equipping' | 'unarmed' | 'incapable'. An empty magazine reloads by itself.
 *   startReload(sim, ped)                    // reload now (needs spare rounds, or `infinite`)
 *   fireWeapon(sim, { shooterId, weapon, origin, dir })   // the raw shot: hitscan only, no ammo, no cooldown, any weapon, any shooter
 *   muzzleOf(sim, ped, yaw?)                 // where a bullet leaves the ped: chest height, in front, at the window when seated
 *   enterCover(sim, ped, dirX?, dirZ?) / leaveCover(sim, ped)   // flush against / crouched behind a wall in reach (see cover.ts)
 *
 * ---- What a shot does ----------------------------------------------------------------------------
 * `fireWeapon` casts one ray per pellet (a Rapier ray against the world, cars and people, skipping
 * the shooter, their car and corpses), thrown into the spread cone, and:
 *   - emits `weapon:fire` (muzzle, direction, one impact per pellet) before anything else, so the law hears it first;
 *   - hurts peds through `damagePed(..., 'bullet', shooterId)`: damage x falloff by distance x headshot (above 1.42 m); one `damage`
 *     event per victim per volley (a shotgun's pellets are added up). A volley at or over the weapon's `knockdownAt` knocks a survivor
 *     down; a smaller hit makes them flinch; a kill throws the body;
 *   - hurts cars through `sim.damageVehicle` (`vehicle:damage`): body, and more to the engine on the bonnet; a hit in the cabin also
 *     hurts the occupant; a hit low by a wheel may flatten the tyre (`car.deflate`, `vehicle:tyre`);
 *   - returns a FireResult: every impact, the closest one (`primary`), the damage dealt and who died.
 * Crimes are decided by the law module from those events (`discharge`, `shoot_ped`, `kill_ped`, `assault_officer`), and only when the
 * shooter is the player.
 *
 * ---- Events ------------------------------------------------------------------------------------------
 * weapon:fire, weapon:empty, weapon:reload, weapon:reloaded, weapon:switch, vehicle:tyre, cover:enter, cover:exit (protocol.ts),
 * plus the existing damage, ped:down, ped:dead and vehicle:damage.
 */
import type { EntityId } from '../../../shared/entities';
import { clamp, lerp, rotateVec, rotateVecInv, type Vec3 } from '../../../shared/math';
import type { BulletImpact, HitKind } from '../../../shared/protocol';
import { LOADOUTS, PLAYER_WEAPONS, WEAPONS, WEAPON_ORDER, falloffMult, fireInterval, spreadDeg, type WeaponDef, type WeaponId } from '../../../shared/weapons';
import { PedEntity, VehicleEntity } from '../../entities';
import type { Simulation } from '../../Simulation';
import { damagePed, knockDown } from '../damage';
import { newRawHit, scatter, type RawHit } from './ballistics';
import { newGunState, type GunState, type Magazine } from './state';

export { WEAPONS, WEAPON_ORDER, LOADOUTS, PLAYER_WEAPONS, falloffMult, fireInterval, spreadDeg } from '../../../shared/weapons';
export type { WeaponDef, WeaponId } from '../../../shared/weapons';
export { enterCover, leaveCover } from './cover';
export type { GunState, CoverState, Magazine } from './state';

/** Height above which a hit on an upright ped is a headshot, m above their feet. */
export const HEAD_Y = 1.42;
/** Where a ped is aimed at: the chest, m above the feet. */
export const CHEST_Y = 1.2;
/** Seconds a raised gun stays up after an AI last aimed or fired it. */
export const AIM_HOLD_S = 1.1;

// ------------------------------------------------------------------------------------------------
// The raw shot

export interface FireRequest {
  shooterId: EntityId;
  weapon: WeaponId;
  /** The muzzle. */
  origin: Vec3;
  /** Where it points (need not be a unit vector). */
  dir: Vec3;
  /** Half-angle of the cone the bullet is thrown into, degrees. Left out: the weapon's aimed or hip spread plus the shooter's bloom. */
  spreadDeg?: number;
  /** Whether the shooter is aiming (picks the aimed or hip spread). Left out: the shooter's `gun.aiming`. */
  aimed?: boolean;
}

export interface ShotHit extends BulletImpact {
  /** Distance from the muzzle, m. */
  distance: number;
  /** Damage this bullet did (to a ped: after falloff and headshot; to a car: body damage). */
  damage: number;
  /** The ped it killed. */
  killed: boolean;
}

export interface FireResult {
  weapon: WeaponId;
  /** One entry per pellet. */
  hits: ShotHit[];
  /** The closest pellet that hit something (a ped, car or wall), else the first pellet's end point. */
  primary: ShotHit;
  /** Damage dealt to peds, summed. */
  damage: number;
  /** Peds this volley killed. */
  killed: EntityId[];
}

const raw = newRawHit();
const sdir = { x: 0, y: 0, z: 0 };
const skipSet = new Set<EntityId>();

/** Fires one volley (one bullet, or a shotgun's pellets) from `origin` along `dir`. No ammo, no cooldown: see `pullTrigger`. */
export function fireWeapon(sim: Simulation, req: FireRequest): FireResult {
  const def = WEAPONS[req.weapon];
  const shooter = sim.registry.get(req.shooterId) as PedEntity | undefined;
  const rt = sim.weapons;
  let dx = req.dir.x;
  let dy = req.dir.y;
  let dz = req.dir.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl;
  dy /= dl;
  dz /= dl;
  const base = { x: dx, y: dy, z: dz };
  const aimed = req.aimed ?? shooter?.gun?.aiming ?? false;
  const cone = req.spreadDeg ?? spreadDeg(def, aimed, shooter?.gun?.bloom ?? 0);
  skipSet.clear();
  skipSet.add(req.shooterId);
  if (shooter?.vehicleId) skipSet.add(shooter.vehicleId);

  const hits: ShotHit[] = [];
  // First pass: where every pellet goes. Damage is applied after the event, so the law hears the shot first.
  const pelletHits: { hit: ShotHit; ped: PedEntity | null; vehicle: VehicleEntity | null; headshot: boolean; lx: number; ly: number; lz: number }[] = [];
  for (let i = 0; i < def.pellets; i++) {
    const d = scatter(base, cone, rt.rng, sdir);
    rt.cast(req.origin, d, def.rangeM, skipSet, raw);
    const headshot = raw.kind === 'ped' && raw.ped!.life === 'alive' && raw.y - raw.ped!.controller.y > HEAD_Y;
    const hit: ShotHit = {
      kind: raw.kind as HitKind,
      x: raw.x, y: raw.y, z: raw.z, nx: raw.nx, ny: raw.ny, nz: raw.nz,
      targetId: raw.ped?.id ?? raw.vehicle?.id ?? 0,
      headshot,
      distance: raw.t,
      damage: 0,
      killed: false,
    };
    hits.push(hit);
    pelletHits.push({ hit, ped: raw.ped, vehicle: raw.vehicle, headshot, lx: d.x, ly: d.y, lz: d.z });
  }

  sim.emit({
    type: 'weapon:fire', tick: sim.tick, shooterId: req.shooterId, weapon: req.weapon,
    x: req.origin.x, y: req.origin.y, z: req.origin.z, dx, dy, dz,
    impacts: hits.map((h) => ({ kind: h.kind, x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz, targetId: h.targetId, headshot: h.headshot })),
  });

  // Second pass: what the hits do. Pellets that landed on the same ped or car are added up first.
  const byPed = new Map<PedEntity, { dmg: number; head: boolean; dir: Vec3; mine: ShotHit[] }>();
  const byCar = new Map<VehicleEntity, { body: number; engine: number; occupant: number; mine: ShotHit[]; tyre: number; dir: Vec3 }>();
  for (const p of pelletHits) {
    if (p.ped) {
      const dmg = def.damage * falloffMult(def, p.hit.distance) * (p.headshot ? def.headshotMult : 1);
      p.hit.damage = dmg;
      const e = byPed.get(p.ped) ?? { dmg: 0, head: false, dir: { x: p.lx, y: p.ly, z: p.lz }, mine: [] };
      e.dmg += dmg;
      e.head ||= p.headshot;
      e.mine.push(p.hit);
      byPed.set(p.ped, e);
    } else if (p.vehicle) {
      const v = p.vehicle;
      const wm = v.car.h.damage.weaponMult ?? 1;
      const f = falloffMult(def, p.hit.distance);
      const pose = v.car.pose();
      const l = rotateVecInv(pose.q, p.hit.x - pose.x, p.hit.y - pose.y, p.hit.z - pose.z);
      const c = v.car.h.chassis;
      const bonnet = l.z > c.halfExtents[2] * 0.35 && l.y > -0.05;
      const body = def.damage * f * def.vehicleBodyMult * wm;
      const engine = def.damage * f * (bonnet ? def.vehicleEngineMult : 0.2) * wm;
      p.hit.damage = body;
      const e = byCar.get(v) ?? { body: 0, engine: 0, occupant: 0, mine: [], tyre: -1, dir: { x: p.lx, y: p.ly, z: p.lz } };
      e.body += body;
      e.engine += engine;
      e.mine.push(p.hit);
      // The cabin: glass and thin doors, so the occupant is in the line of fire.
      const cab = c.cabin;
      if (v.occupantId && l.y > cab.offset[1] - cab.halfExtents[1] * 0.4 && Math.abs(l.z - cab.offset[2]) < cab.halfExtents[2] + 0.25 && rt.rng.chance(0.65)) e.occupant += def.damage * f * 0.7;
      // A hit low by a wheel.
      if (l.y < 0.24 && Math.abs(l.x) > 0.55 && e.tyre < 0) {
        const i = nearestWheel(v, l.x, l.z);
        if (i >= 0 && rt.rng.chance(def.tyreChance)) e.tyre = i;
      }
      byCar.set(v, e);
    }
  }

  const killed: EntityId[] = [];
  let total = 0;
  for (const [ped, e] of byPed) {
    total += e.dmg;
    const r = damagePed(sim, ped, e.dmg, 'bullet', req.shooterId);
    const c = ped.controller;
    const hl = Math.hypot(e.dir.x, e.dir.z) || 1;
    const ux = e.dir.x / hl;
    const uz = e.dir.z / hl;
    if (r.fatal) {
      killed.push(ped.id);
      for (const h of e.mine) h.killed = true;
      c.launch(ux * 3.4, 2.1, uz * 3.4);
    } else if (e.dmg >= def.knockdownAt) {
      knockDown(sim, ped, clamp(1.2 + e.dmg / 40, 1.4, 3), ux * 3.2, uz * 3.2, 1.4);
    } else {
      ped.flinchT = 0.4;
      c.launch(ux * 0.9, 0, uz * 0.9);
    }
    // Whoever was hit cannot carry on as they were.
    if (ped.life !== 'dead' && ped.brain && ped.role !== 'player' && ped.role !== 'police' && (ped.brain.state === 'idle' || ped.brain.state === 'calm')) {
      ped.brain.enter('flee');
      const o = req.origin;
      ped.brain.threat = { x: o.x, z: o.z };
    }
  }
  for (const [v, e] of byCar) {
    sim.damageVehicle(v, e.body, e.engine, req.shooterId);
    if (e.tyre >= 0 && v.car.deflate(e.tyre)) sim.emit({ type: 'vehicle:tyre', tick: sim.tick, vehicleId: v.id, wheel: e.tyre, shooterId: req.shooterId });
    if (e.occupant > 0) {
      const occ = sim.registry.get(v.occupantId) as PedEntity | undefined;
      if (occ && occ.life !== 'dead') {
        total += e.occupant;
        const r = damagePed(sim, occ, e.occupant, 'bullet', req.shooterId, v.id);
        if (r.fatal) killed.push(occ.id);
      }
    }
  }

  let primary = hits[0];
  for (const h of hits) if (h.kind !== 'none' && (primary.kind === 'none' || h.distance < primary.distance)) primary = h;
  return { weapon: req.weapon, hits, primary, damage: total, killed };
}

function nearestWheel(v: VehicleEntity, lx: number, lz: number): number {
  let best = -1;
  let bd = 0.9;
  for (let i = 0; i < 4; i++) {
    const w = v.car.wheels[i];
    const d = Math.hypot(w.mx - lx, w.mz - lz);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------
// Carrying weapons

export interface GiveOptions {
  /** Rounds in the magazine (default: full). */
  mag?: number;
  /** Spare rounds (default: the weapon's `startReserve`). */
  reserve?: number;
  /** Draw it now (default: only when the ped had no weapon). */
  equip?: boolean;
  /** Reloads are free and the reserve never runs out. */
  infinite?: boolean;
}

/** Puts a weapon in a ped's hands (or adds rounds when they have it already). */
export function giveWeapon(ped: PedEntity, id: WeaponId, opts: GiveOptions = {}): GunState {
  const def = WEAPONS[id];
  let gun = ped.gun;
  const first = !gun;
  if (!gun) gun = ped.gun = newGunState(id);
  const have = gun.inv[id];
  const reserve = opts.reserve ?? def.startReserve;
  if (have) {
    have.reserve = Math.min(def.reserveMax, have.reserve + reserve);
    if (opts.mag !== undefined) have.mag = clamp(opts.mag, 0, def.magazine);
  } else {
    gun.inv[id] = { mag: clamp(opts.mag ?? def.magazine, 0, def.magazine), reserve: Math.min(def.reserveMax, reserve) };
  }
  if (opts.infinite) gun.infinite = true;
  if (first || opts.equip) {
    gun.weapon = id;
    gun.reloadLeft = 0;
  }
  return gun;
}

/** Arms a ped with a dispatch `loadout` ('none', 'pistol', 'shotgun', 'rifle'; unknown names arm with a pistol). The first weapon of the list is drawn. */
export function giveLoadout(ped: PedEntity, loadout: string, opts: GiveOptions = {}): WeaponId[] {
  const list = LOADOUTS[loadout] ?? LOADOUTS.pistol ?? ['pistol'];
  list.forEach((w, i) => giveWeapon(ped, w, { ...opts, equip: i === 0 }));
  return [...list];
}

/** The player's starting weapons for a `?weapons=` choice. */
export function giveStarterWeapons(ped: PedEntity, mode: 'default' | 'all' | 'none'): void {
  if (mode === 'none') return;
  const list = mode === 'all' ? PLAYER_WEAPONS.all : PLAYER_WEAPONS.default;
  list.forEach((w, i) => giveWeapon(ped, w, { equip: i === 0, reserve: WEAPONS[w].startReserve }));
  if (PLAYER_WEAPONS.infiniteReserve && ped.gun) ped.gun.infinite = true;
}

/** The weapon in hand and its rounds, for a HUD or a test; null when unarmed. */
export function ammoStatus(ped: PedEntity): { weapon: WeaponId; mag: number; reserve: number; reloading: boolean; capacity: number } | null {
  const g = ped.gun;
  if (!g) return null;
  const m = g.inv[g.weapon];
  if (!m) return null;
  return { weapon: g.weapon, mag: m.mag, reserve: g.infinite ? Infinity : m.reserve, reloading: g.reloadLeft > 0, capacity: WEAPONS[g.weapon].magazine };
}

/** Draws a weapon the ped carries. Returns false when they do not have it. Cancels a reload. */
export function selectWeapon(sim: Simulation, ped: PedEntity, id: WeaponId): boolean {
  const g = ped.gun;
  if (!g || !g.inv[id]) return false;
  if (g.weapon === id) return true;
  g.weapon = id;
  g.reloadLeft = 0;
  g.cooldown = 0;
  g.buffer = 0;
  g.bloom = 0;
  g.equipLeft = WEAPONS[id].equipS;
  sim.emit({ type: 'weapon:switch', tick: sim.tick, pedId: ped.id, weapon: id });
  return true;
}

/** The weapons a ped carries, in slot order. */
export function carried(ped: PedEntity): WeaponId[] {
  const g = ped.gun;
  return g ? WEAPON_ORDER.filter((w) => g.inv[w]) : [];
}

/** Draws the next (`dir` 1) or previous (-1) carried weapon, skipping any that cannot be used from a car when `driveBy` is set. */
export function cycleWeapon(sim: Simulation, ped: PedEntity, dir: 1 | -1, driveBy = false): boolean {
  const g = ped.gun;
  if (!g) return false;
  const list = carried(ped).filter((w) => !driveBy || WEAPONS[w].driveBy);
  if (list.length < 2) return false;
  const i = list.indexOf(g.weapon);
  return selectWeapon(sim, ped, list[(i + dir + list.length) % list.length]);
}

/** Starts a reload. False when the magazine is full, there is nothing to load, or one is already running. */
export function startReload(sim: Simulation, ped: PedEntity): boolean {
  const g = ped.gun;
  if (!g || g.reloadLeft > 0 || g.equipLeft > 0) return false;
  const m = g.inv[g.weapon];
  const def = WEAPONS[g.weapon];
  if (!m || m.mag >= def.magazine || (!g.infinite && m.reserve <= 0)) return false;
  g.reloadLeft = def.reloadS;
  g.buffer = 0;
  sim.emit({ type: 'weapon:reload', tick: sim.tick, pedId: ped.id, weapon: g.weapon, durationS: def.reloadS });
  return true;
}

/** Called by the weapon system when a reload's time has run out. */
export function finishReload(sim: Simulation, ped: PedEntity) {
  const g = ped.gun!;
  const m = g.inv[g.weapon]!;
  const def = WEAPONS[g.weapon];
  const need = def.magazine - m.mag;
  const take = g.infinite ? need : Math.min(need, m.reserve);
  m.mag += take;
  if (!g.infinite) m.reserve -= take;
  g.reloadLeft = 0;
  sim.emit({ type: 'weapon:reloaded', tick: sim.tick, pedId: ped.id, weapon: g.weapon, mag: m.mag, reserve: g.infinite ? 999 : m.reserve });
}

// ------------------------------------------------------------------------------------------------
// Pulling the trigger

export type TriggerStatus = 'fired' | 'empty' | 'reloading' | 'cooldown' | 'equipping' | 'unarmed' | 'incapable';

export interface TriggerResult {
  status: TriggerStatus;
  fire?: FireResult;
}

export interface TriggerOptions {
  /** Multiplier on the spread (an NPC's skill; 1 by default). */
  spreadScale?: number;
  /** Override whether the aimed or hip spread applies. */
  aimed?: boolean;
}

/**
 * Pulls the trigger of the weapon in hand along a ray. Fires when the gun is ready: not reloading or
 * being drawn, past the fire-rate cooldown, with a round in the magazine. An empty magazine starts a
 * reload by itself (and says `empty` once).
 */
export function pullTrigger(sim: Simulation, ped: PedEntity, aim: { origin: Vec3; dir: Vec3 }, opts: TriggerOptions = {}): TriggerResult {
  const g = ped.gun;
  if (!g) return { status: 'unarmed' };
  const def = WEAPONS[g.weapon];
  if (ped.life !== 'alive' || (ped.vehicleId && !def.driveBy)) return { status: 'incapable' };
  if (g.equipLeft > 0) return { status: 'equipping' };
  if (g.reloadLeft > 0) return { status: 'reloading' };
  if (g.cooldown > 0) return { status: 'cooldown' };
  const m = g.inv[g.weapon]!;
  if (m.mag <= 0) {
    // The click, then the reload (a tenth of a second between clicks so a held trigger does not chatter).
    g.cooldown = 0.25;
    sim.emit({ type: 'weapon:empty', tick: sim.tick, pedId: ped.id, weapon: g.weapon });
    startReload(sim, ped);
    return { status: 'empty' };
  }
  m.mag--;
  g.cooldown = fireInterval(def);
  g.lastShotTick = sim.tick;
  g.shots++;
  const aimed = opts.aimed ?? g.aiming;
  const cone = spreadDeg(def, aimed, g.bloom) * (opts.spreadScale ?? 1);
  g.bloom = Math.min(def.bloom.max, g.bloom + def.bloom.perShot);
  const fire = fireWeapon(sim, { shooterId: ped.id, weapon: g.weapon, origin: aim.origin, dir: aim.dir, spreadDeg: cone, aimed });
  if (m.mag === 0) startReload(sim, ped);
  return { status: 'fired', fire };
}

// ------------------------------------------------------------------------------------------------
// Aiming and shooting for NPCs

export type AimTarget = PedEntity | VehicleEntity | Vec3;

/** The point to aim at on a target: a ped's chest, a car's middle (its driver, when someone is in it). */
export function aimPointOf(sim: Simulation, t: AimTarget, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  if (t instanceof PedEntity) {
    const c = t.controller;
    out.x = c.x;
    out.y = c.y + (t.life === 'alive' ? CHEST_Y : 0.4);
    out.z = c.z;
  } else if (t instanceof VehicleEntity) {
    const p = t.car.pose();
    out.x = p.x;
    out.y = p.y + 0.55;
    out.z = p.z;
  } else {
    out.x = t.x;
    out.y = t.y;
    out.z = t.z;
  }
  return out;
}

/** Where a bullet leaves the ped. Standing: chest height, in front and to the right of the body at `yaw` (default: its facing). Seated: at the window on the side `gun.side` says. */
export function muzzleOf(sim: Simulation, ped: PedEntity, yaw?: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const c = ped.controller;
  const veh = ped.vehicleId ? (sim.registry.get(ped.vehicleId) as VehicleEntity | undefined) : undefined;
  if (veh) {
    // Out of the window on the side the gun points: the seat is on the left, so the right window is further.
    const side = ped.gun?.side ?? 1;
    const w = rotateVec(veh.car.pose().q, side > 0 ? -1.25 : 0.55, 0, 0.25);
    out.x = c.x + w.x;
    out.y = c.y + 1.2;
    out.z = c.z + w.z;
    return out;
  }
  const a = yaw ?? ped.gun?.aimYaw ?? c.yaw;
  const sx = Math.sin(a);
  const cx = Math.cos(a);
  // A model faces (sin yaw, cos yaw) with +X to its left, so its right hand is at (-cos yaw, sin yaw).
  out.x = c.x + sx * 0.5 - cx * 0.2;
  out.y = c.y + 1.35;
  out.z = c.z + cx * 0.5 + sx * 0.2;
  // In cover the gun comes out over (low) or round (high) the wall.
  if (ped.cover) {
    const k = ped.cover;
    if (k.low) out.y = c.y + (ped.gun?.aiming ? 1.4 : 0.95);
    out.x += -k.nz * k.lean * 0.55;
    out.z += k.nx * k.lean * 0.55;
  }
  return out;
}

/** Raises the gun toward a target without firing, turning the body to face it. */
export function aimAt(sim: Simulation, ped: PedEntity, target: AimTarget): Vec3 {
  const g = ped.gun;
  const p = aimPointOf(sim, target);
  if (!g) return p;
  const c = ped.controller;
  const yaw = Math.atan2(p.x - c.x, p.z - c.z);
  const m = muzzleOf(sim, ped, yaw);
  const dx = p.x - m.x;
  const dy = p.y - m.y;
  const dz = p.z - m.z;
  g.aiming = true;
  g.aimHold = AIM_HOLD_S;
  g.aimYaw = yaw;
  g.aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
  if (!ped.vehicleId) c.yaw = yaw;
  else g.side = sideOfCar(sim, ped, dx, dz);
  return p;
}

function sideOfCar(sim: Simulation, ped: PedEntity, dx: number, dz: number): number {
  const veh = sim.registry.get(ped.vehicleId) as VehicleEntity | undefined;
  if (!veh) return 1;
  const r = rotateVec(veh.car.pose().q, -1, 0, 0);
  return dx * r.x + dz * r.z >= 0 ? 1 : -1;
}

/** Lowers the gun. */
export function holster(ped: PedEntity) {
  if (!ped.gun) return;
  ped.gun.aiming = false;
  ped.gun.aimHold = 0;
  ped.gun.lock = 0;
}

export interface ShootAtOptions {
  /** 0 (spray) to 1 (marksman): the spread is 3.2x at 0 and 0.9x at 1. Default 0.5. */
  skill?: number;
}

/**
 * Aim at a target and shoot if the gun is ready. Call it every tick you want the target shot at: it
 * keeps the gun raised, turns the body, and fires on the weapon's own rhythm. Returns what the trigger did.
 */
export function shootAt(sim: Simulation, ped: PedEntity, target: AimTarget, opts: ShootAtOptions = {}): TriggerResult {
  const g = ped.gun;
  if (!g) return { status: 'unarmed' };
  const p = aimAt(sim, ped, target);
  const m = muzzleOf(sim, ped, g.aimYaw);
  const skill = clamp(opts.skill ?? 0.5, 0, 1);
  return pullTrigger(sim, ped, { origin: m, dir: { x: p.x - m.x, y: p.y - m.y, z: p.z - m.z } }, { spreadScale: lerp(3.2, 0.9, skill), aimed: true });
}

export { newRawHit, type RawHit };
