/**
 * The weapon systems of the sim: the player's trigger, aim, reload, weapon switching and cover
 * (`playerWeaponInput`, called from the player control system with the tick's button edges), and the
 * per-tick upkeep for every armed ped (fire-rate cooldown, reloads, bloom, flinches, cover).
 *
 * The player's aim is rebuilt here from the camera angles the client sends with every command: the
 * crosshair ray goes from the camera through the screen centre (see shared/aim.ts), is cast against
 * the world, and the bullet leaves the muzzle for the point it hit. A soft lock-on then bends the
 * shot toward a threat near the crosshair by an amount the device decides (`Axis.AimAssist`).
 */
import { AIM, viewDirection, viewRight } from '../../../shared/aim';
import { clamp, type Vec3 } from '../../../shared/math';
import { Axis, Button } from '../../../shared/protocol';
import { LOCK_ON, WEAPONS, WEAPON_ORDER, lockOnFor } from '../../../shared/weapons';
import { PedEntity, VehicleEntity, type PlayerSlot } from '../../entities';
import type { Simulation } from '../../Simulation';
import type { SimSystem } from '../../systems';
import { newRawHit } from './ballistics';
import {
  carried,
  cycleWeapon,
  finishReload,
  muzzleOf,
  pullTrigger,
  selectWeapon,
  startReload,
} from './api';
import { coverYaw, enterCover, leaveCover, stepCover } from './cover';
import { assistDirection, pickLockTarget, type LockCandidate } from './lockOn';

const SLOT_BUTTONS = [Button.Slot1, Button.Slot2, Button.Slot3, Button.Slot4] as const;
/** A semi-automatic trigger press is remembered this long while the gun is not ready, s. */
const TRIGGER_BUFFER_S = 0.16;

const axis = (p: PlayerSlot, a: number) => {
  const v = p.axes[a];
  return Number.isFinite(v) ? v : 0;
};

const raw = newRawHit();
const skip = new Set<number>();

export interface PlayerAim {
  origin: Vec3;
  dir: Vec3;
  /** The point the crosshair is on (where the camera ray ended). */
  point: Vec3;
  lock: number;
  yaw: number;
  pitch: number;
}

/** Rebuilds the player's aim from the camera angles in their command. Sets `gun.aimYaw`, `aimPitch` and `lock`. */
export function solvePlayerAim(sim: Simulation, p: PlayerSlot, ped: PedEntity, veh: VehicleEntity | null): PlayerAim {
  const g = ped.gun!;
  const def = WEAPONS[g.weapon];
  const c = ped.controller;
  const yaw = axis(p, Axis.Yaw);
  const pitch = clamp(axis(p, Axis.Pitch), AIM.pitchMin - 0.2, AIM.pitchMax + 0.2);
  const f = viewDirection(yaw, pitch);
  const r = viewRight(yaw);
  const pivot = { x: c.x, y: c.y + (veh ? AIM.pivotCar : AIM.pivotFoot), z: c.z };
  // The crosshair ray: the camera is a shoulder to the right of the pivot, and the ray runs parallel to the view.
  const shoulder = veh ? AIM.shoulderCar : AIM.shoulder;
  const start = { x: pivot.x + r.x * shoulder, y: pivot.y, z: pivot.z + r.z * shoulder };
  skip.clear();
  skip.add(ped.id);
  if (veh) skip.add(veh.id);
  const maxDist = def.rangeM + 25;
  sim.weapons.cast(start, f, maxDist, skip, raw);
  const point = { x: raw.x, y: raw.y, z: raw.z };

  // The body faces where the camera looks; a drive-by shoots out of the window on that side.
  const bodyYaw = Math.atan2(f.x, f.z);
  if (veh) {
    const cr = veh.car.pose().q;
    // The car's right is -X in its own frame.
    const rx = -(1 - 2 * (cr.y * cr.y + cr.z * cr.z));
    const rz = -(2 * (cr.x * cr.z - cr.w * cr.y));
    g.side = f.x * rx + f.z * rz >= 0 ? 1 : -1;
  }
  const origin = muzzleOf(sim, ped, bodyYaw);
  let dx = point.x - origin.x;
  let dy = point.y - origin.y;
  let dz = point.z - origin.z;
  let dl = Math.hypot(dx, dy, dz);
  // A target closer than the muzzle's reach in front: shoot along the view.
  if (dl < 1.2 || dx * f.x + dy * f.y + dz * f.z < 0) {
    dx = f.x;
    dy = f.y;
    dz = f.z;
    dl = 1;
  }
  const dir: Vec3 = { x: dx / dl, y: dy / dl, z: dz / dl };

  // Soft lock-on.
  const assist = clamp(axis(p, Axis.AimAssist), 0, 1);
  let lock = 0;
  if (assist > 0.02) {
    const { coneDeg, pull } = lockOnFor(assist);
    const cands: LockCandidate[] = [];
    for (const o of sim.peds()) {
      if (o === ped || o.life !== 'alive' || o.vehicleId || o.busy) continue;
      const oc = o.controller;
      if (Math.abs(oc.x - c.x) > LOCK_ON.rangeM || Math.abs(oc.z - c.z) > LOCK_ON.rangeM) continue;
      const threat = o.role === 'police' ? 1 : o.brain?.state === 'fight' ? 0.8 : 0.3;
      cands.push({ id: o.id, x: oc.x, y: oc.y + 1.2, z: oc.z, threat });
    }
    for (let tries = 0; tries < 3 && cands.length; tries++) {
      const pick = pickLockTarget(pivot, f, cands, { coneDeg, rangeM: LOCK_ON.rangeM, current: g.lock, stickyMult: LOCK_ON.stickyMult });
      if (!pick) break;
      if (!sim.law.clearLine(origin, pick)) {
        cands.splice(cands.findIndex((x) => x.id === pick.id), 1);
        continue;
      }
      lock = pick.id;
      assistDirection(dir, origin, pick, coneDeg * (pick.id === g.lock ? LOCK_ON.stickyMult : 1), pull, dir);
      break;
    }
  }
  g.lock = lock;
  const aimPitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
  // The body (and the gun's drawn pose) follow the camera's heading, not the bent shot, so the character does not twitch between targets.
  g.aimYaw = bodyYaw;
  g.aimPitch = aimPitch;
  return { origin, dir, point, lock, yaw: bodyYaw, pitch: aimPitch };
}

/**
 * Handles the player's gun buttons for one tick: weapon switching, the aim state, reload and the
 * trigger, and cover. Called by the player control system before it clears the tick's button edges.
 * Returns true when it took the `Melee` press (aiming with a gun, that press reloads).
 */
export function playerWeaponInput(sim: Simulation, p: PlayerSlot, ped: PedEntity, veh: VehicleEntity | null): boolean {
  const edges = p.edges;
  const held = p.buttons;
  const g = ped.gun;
  let tookMelee = false;

  // Cover works with or without a gun.
  if (!veh && edges & Button.Cover) {
    if (ped.cover) leaveCover(sim, ped);
    else enterCover(sim, ped, -Math.sin(axis(p, Axis.Yaw)), -Math.cos(axis(p, Axis.Yaw)));
  }
  if (veh && ped.cover) leaveCover(sim, ped);
  if (!g) return false;

  // Which weapon.
  for (let i = 0; i < SLOT_BUTTONS.length; i++) {
    if (edges & SLOT_BUTTONS[i]) {
      const id = WEAPON_ORDER[i];
      if (id && g.inv[id] && (!veh || WEAPONS[id].driveBy)) selectWeapon(sim, ped, id);
    }
  }
  if (edges & Button.WeaponNext) cycleWeapon(sim, ped, 1, !!veh);
  if (edges & Button.WeaponPrev) cycleWeapon(sim, ped, -1, !!veh);

  // Whether the gun is up.
  let wantAim = (held & (Button.Aim | Button.Fire)) !== 0;
  if (wantAim && veh && !WEAPONS[g.weapon].driveBy) {
    // From a car only a pistol or an SMG will do: draw the last one in slot order (the SMG, when there is one).
    const alt = carried(ped).filter((w) => WEAPONS[w].driveBy).pop();
    if (alt) selectWeapon(sim, ped, alt);
    else wantAim = false;
  }
  if (ped.melee) wantAim = false;
  g.aiming = wantAim;

  if ((edges & Button.Reload) || (wantAim && edges & Button.Melee)) {
    startReload(sim, ped);
    if (edges & Button.Melee) tookMelee = true;
  }

  if (!wantAim) {
    g.lock = 0;
    g.buffer = 0;
    return tookMelee;
  }
  const aim = solvePlayerAim(sim, p, ped, veh);
  const def = WEAPONS[g.weapon];
  if (edges & Button.Fire) g.buffer = TRIGGER_BUFFER_S;
  const intent = def.auto ? (held & Button.Fire) !== 0 : g.buffer > 0;
  if (intent) {
    const r = pullTrigger(sim, ped, aim, { aimed: true });
    if (r.status === 'fired' || r.status === 'empty') g.buffer = 0;
  }
  return tookMelee;
}

/** Per-tick upkeep for every ped: weapon timers, flinches, cover and the walking pace while aiming. */
export class WeaponSystem implements SimSystem {
  readonly name = 'weapons';
  readonly priority = 11;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const ped of sim.peds()) {
      if (ped.flinchT > 0) ped.flinchT = Math.max(0, ped.flinchT - dt);
      const g = ped.gun;
      if (ped.cover) stepCover(sim, ped, dt, ped.role === 'player');
      if (!g) continue;
      if (g.cooldown > 0) g.cooldown = Math.max(0, g.cooldown - dt);
      if (g.equipLeft > 0) g.equipLeft = Math.max(0, g.equipLeft - dt);
      if (g.buffer > 0) g.buffer = Math.max(0, g.buffer - dt);
      if (g.bloom > 0) g.bloom = Math.max(0, g.bloom - WEAPONS[g.weapon].bloom.recoverPerS * dt);
      if (g.reloadLeft > 0) {
        g.reloadLeft -= dt;
        if (g.reloadLeft <= 0) finishReload(sim, ped);
      }
      if (ped.life !== 'alive') {
        g.aiming = false;
        g.lock = 0;
        g.reloadLeft = 0;
        if (ped.cover) leaveCover(sim, ped);
        continue;
      }
      if (ped.role !== 'player') {
        // An AI's raised gun comes down by itself unless it keeps aiming (aimAt / shootAt refresh it).
        if (g.aimHold > 0) {
          g.aimHold -= dt;
          if (g.aimHold <= 0) {
            g.aiming = false;
            g.lock = 0;
          }
        }
      } else if (g.aiming && !ped.vehicleId && !ped.cover) {
        // Aiming slows the walk and rules out sprinting.
        const i = ped.input;
        i.moveX *= AIM.moveScale;
        i.moveY *= AIM.moveScale;
        i.sprint = false;
      }
    }
  }
}

/** After the bodies have moved: turns a ped to face where its gun points, or to the wall it is in cover against. */
export class AimPoseSystem implements SimSystem {
  readonly name = 'aimPose';
  readonly priority = 21;

  fixedUpdate(sim: Simulation) {
    for (const ped of sim.peds()) {
      if (ped.life === 'dead') continue;
      const g = ped.gun;
      if (g?.aiming && !ped.busy) ped.controller.yaw = g.aimYaw;
      else if (ped.cover) ped.controller.yaw = coverYaw(ped);
    }
  }
}

