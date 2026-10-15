/**
 * The client's view of the player's gun: whether the aim camera is up, what is in the gun, the
 * recoil kick owed to the camera, the hit marker. It reads the player's ped from the interpolated
 * snapshot (the sim owns the truth) and the input for intent, and publishes `game.aim` for the
 * camera rig, the crosshair and the sound.
 */
import { PedFlag, gunMag, gunReserve, gunWeapon } from '../../shared/snapshot';
import type { SimEvent } from '../../shared/protocol';
import { WEAPONS, weaponByIndex, type WeaponDef } from '../../shared/weapons';
import type { Game, System } from '../Game';

export interface AimView {
  /** Aim or fire is held. */
  intent: boolean;
  /** The aim camera is up: the player has a gun, wants it up, and the gun can be used from where they are. */
  active: boolean;
  /** The weapon in hand, or null when unarmed. */
  weapon: WeaponDef | null;
  mag: number;
  reserve: number;
  /** 0 to 1 through a reload; 0 when not reloading. */
  reload: number;
  /** The crosshair's spread, degrees (half-angle). */
  spreadDeg: number;
  /** The entity the aim is locked onto, or 0. */
  lock: number;
  /** A bit for each weapon carried (bit n: the weapon with index n + 1). */
  owned: number;
  inCover: boolean;
  crouched: boolean;
  /** Camera kick owed, degrees: the rig takes it and sets it to zero. */
  kickPitch: number;
  kickYaw: number;
  /** Seconds left of the hit marker and the kill marker. */
  hit: number;
  kill: number;
  /** Seconds left of showing the weapon strip. */
  strip: number;
  /** Seconds since the last dry click. */
  empty: number;
}

declare module '../Game' {
  interface Game {
    aim: AimView;
  }
}

export class AimSystem implements System {
  readonly name = 'aim';
  readonly priority = 12;

  constructor(private readonly game: Game) {
    game.aim = {
      intent: false, active: false, weapon: null, mag: 0, reserve: 0, reload: 0, spreadDeg: 0, lock: 0, owned: 0, inCover: false, crouched: false,
      kickPitch: 0, kickYaw: 0, hit: 0, kill: 0, strip: 0, empty: 0,
    };
    game.onSimEvent((e) => this.onEvent(e));
  }

  private onEvent(e: SimEvent) {
    const me = this.game.view.ped?.id;
    if (!me) return;
    const a = this.game.aim;
    switch (e.type) {
      case 'weapon:fire':
        if (e.shooterId !== me) break;
        {
          const def = WEAPONS[e.weapon];
          a.kickPitch += def.recoil.pitch;
          a.kickYaw += (Math.random() - 0.5) * 2 * def.recoil.yaw;
          for (const im of e.impacts) if (im.kind === 'ped') a.hit = im.headshot ? 0.32 : 0.2;
        }
        break;
      case 'damage':
        if (e.sourceId === me && e.kind === 'bullet' && e.fatal) a.kill = 0.5;
        break;
      case 'weapon:switch':
        if (e.pedId === me) a.strip = 2.6;
        break;
      case 'weapon:empty':
        if (e.pedId === me) a.empty = 0.25;
        break;
      default:
        break;
    }
  }

  update(dt: number) {
    const g = this.game;
    const a = g.aim;
    const v = g.view;
    const input = g.input;
    const ped = v.ped;
    a.hit = Math.max(0, a.hit - dt);
    a.kill = Math.max(0, a.kill - dt);
    a.strip = Math.max(0, a.strip - dt);
    a.empty = Math.max(0, a.empty - dt);
    a.intent = input.down('aim') || input.down('fire');
    if (!ped) {
      a.active = false;
      a.weapon = null;
      return;
    }
    const idx = gunWeapon(ped.gun);
    const def = weaponByIndex(idx) ?? null;
    a.weapon = def;
    a.mag = gunMag(ped.gun);
    a.reserve = gunReserve(ped.gun);
    a.reload = ped.reload;
    a.spreadDeg = ped.bloom;
    a.lock = ped.lock;
    a.owned = ped.owned;
    a.inCover = (ped.flags & PedFlag.InCover) !== 0;
    a.crouched = (ped.flags & PedFlag.Crouched) !== 0;
    const alive = (ped.flags & (PedFlag.Dead | PedFlag.Downed | PedFlag.Busy)) === 0 && v.overlay === 0;
    a.active = a.intent && !!def && alive && (!v.inVehicle || def.driveBy);
  }
}
