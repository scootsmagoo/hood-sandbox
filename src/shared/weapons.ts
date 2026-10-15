/**
 * The weapon table (`data/weapons.json`): parsing, lookups and the pure ballistics numbers
 * (falloff, spread, lock-on strength). No I/O and no world, so the sim, the client's HUD and the
 * tests read the same numbers. The combat code that uses them is `src/sim/combat/weapons/api.ts`.
 */
import raw from './data/weapons.json';

export type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'rifle';
export type WeaponKind = 'pistol' | 'smg' | 'shotgun' | 'rifle';

export interface WeaponDef {
  id: WeaponId;
  /** 1-based slot and snapshot index (0 means unarmed). */
  index: number;
  name: string;
  kind: WeaponKind;
  /** Damage per pellet. */
  damage: number;
  headshotMult: number;
  rangeM: number;
  falloff: { startM: number; endM: number; minMult: number };
  /** Rounds per second. */
  fireRate: number;
  auto: boolean;
  magazine: number;
  reserveMax: number;
  startReserve: number;
  reloadS: number;
  equipS: number;
  /** Half-angle of the bullet cone, degrees. */
  spread: { hip: number; aimed: number };
  bloom: { perShot: number; max: number; recoverPerS: number };
  /** Camera kick per shot, degrees (applied by the client). */
  recoil: { pitch: number; yaw: number };
  pellets: number;
  /** Usable from a car (a drive-by). */
  driveBy: boolean;
  /** How far the shot carries to people who cannot see the shooter, as a multiple of a crime's hearRadius. */
  hearM: number;
  vehicleBodyMult: number;
  vehicleEngineMult: number;
  tyreChance: number;
  /** A volley doing this much to one ped knocks them down. */
  knockdownAt: number;
}

export interface LockOnRules {
  coneDeg: [number, number];
  pull: [number, number];
  rangeM: number;
  stickyMult: number;
}

export interface WeaponTable {
  weapons: Record<string, WeaponDef>;
  /** Weapon ids in slot order. */
  order: WeaponId[];
  loadouts: Record<string, WeaponId[]>;
  player: { default: WeaponId[]; all: WeaponId[] };
  lockOn: LockOnRules;
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`weapons.json: ${msg}`);
};
const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function parseWeapons(json: unknown): WeaponTable {
  const j = json as {
    weapons?: Record<string, Omit<WeaponDef, 'id' | 'index'>>;
    loadouts?: Record<string, unknown>;
    player?: Record<string, unknown>;
    lockOn?: Partial<LockOnRules>;
  };
  need(j?.weapons && typeof j.weapons === 'object', 'no weapons');
  const weapons: Record<string, WeaponDef> = {};
  const order: WeaponId[] = [];
  for (const [id, w] of Object.entries(j.weapons!)) {
    if (id.startsWith('_')) continue;
    need(pos(w.damage), `${id}: damage must be positive`);
    need(pos(w.rangeM), `${id}: rangeM must be positive`);
    need(pos(w.fireRate), `${id}: fireRate must be positive`);
    need(Number.isInteger(w.magazine) && w.magazine > 0, `${id}: magazine must be a positive integer`);
    need(pos(w.reloadS), `${id}: reloadS must be positive`);
    need(w.spread && w.spread.aimed >= 0 && w.spread.hip >= w.spread.aimed, `${id}: spread needs hip >= aimed >= 0`);
    need(w.falloff && w.falloff.startM >= 0 && w.falloff.endM > w.falloff.startM && w.falloff.minMult > 0 && w.falloff.minMult <= 1, `${id}: falloff needs startM < endM and 0 < minMult <= 1`);
    need(Number.isInteger(w.pellets) && w.pellets >= 1 && w.pellets <= 16, `${id}: pellets must be 1 to 16`);
    order.push(id as WeaponId);
    weapons[id] = { ...w, id: id as WeaponId, index: order.length };
  }
  need(order.length >= 4, 'needs at least pistol, smg, shotgun and rifle');
  for (const id of ['pistol', 'smg', 'shotgun', 'rifle']) need(weapons[id], `missing ${id}`);
  const ids = (list: unknown, where: string): WeaponId[] => {
    need(Array.isArray(list), `${where} must be a list`);
    return (list as string[]).map((s) => {
      need(weapons[s], `${where} names the unknown weapon ${s}`);
      return s as WeaponId;
    });
  };
  const loadouts: Record<string, WeaponId[]> = {};
  for (const [k, v] of Object.entries(j.loadouts ?? {})) if (!k.startsWith('_')) loadouts[k] = ids(v, `loadout ${k}`);
  const lo = j.lockOn ?? {};
  return {
    weapons,
    order,
    loadouts,
    player: { default: ids(j.player?.default ?? ['pistol'], 'player.default'), all: ids(j.player?.all ?? order, 'player.all') },
    lockOn: {
      coneDeg: lo.coneDeg ?? [4.5, 18],
      pull: lo.pull ?? [0.25, 1],
      rangeM: lo.rangeM ?? 80,
      stickyMult: lo.stickyMult ?? 1.4,
    },
  };
}

const table = parseWeapons(raw);
export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = table.weapons as Record<WeaponId, WeaponDef>;
export const WEAPON_ORDER: readonly WeaponId[] = table.order;
export const LOADOUTS: Readonly<Record<string, readonly WeaponId[]>> = table.loadouts;
export const PLAYER_WEAPONS = table.player;
export const LOCK_ON: Readonly<LockOnRules> = table.lockOn;

/** The weapon for a snapshot index (1-based), or undefined for 0 / unknown. */
export function weaponByIndex(index: number): WeaponDef | undefined {
  return WEAPONS[WEAPON_ORDER[index - 1]];
}

/** Damage multiplier at a distance: 1 up to `startM`, falling smoothly to `minMult` at `endM`. */
export function falloffMult(def: WeaponDef, distance: number): number {
  const f = def.falloff;
  if (distance <= f.startM) return 1;
  if (distance >= f.endM) return f.minMult;
  const t = (distance - f.startM) / (f.endM - f.startM);
  const s = t * t * (3 - 2 * t);
  return 1 + (f.minMult - 1) * s;
}

/** The half-angle (degrees) of the cone a shot is thrown into: the aimed or hip spread, widened by the current bloom. */
export function spreadDeg(def: WeaponDef, aimed: boolean, bloom = 0): number {
  return (aimed ? def.spread.aimed : def.spread.hip) + Math.max(0, bloom);
}

/** Seconds between shots. */
export function fireInterval(def: WeaponDef): number {
  return 1 / def.fireRate;
}

/** The lock-on cone (half-angle, degrees) and the share of the way a shot is bent toward the target, for an assist strength 0 to 1. */
export function lockOnFor(assist: number): { coneDeg: number; pull: number } {
  const a = Math.min(1, Math.max(0, assist));
  return {
    coneDeg: LOCK_ON.coneDeg[0] + (LOCK_ON.coneDeg[1] - LOCK_ON.coneDeg[0]) * a,
    pull: LOCK_ON.pull[0] + (LOCK_ON.pull[1] - LOCK_ON.pull[0]) * a,
  };
}
