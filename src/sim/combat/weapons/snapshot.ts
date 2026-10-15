/** What a ped's record in the snapshot says about its gun, cover and flinch (the layout is `PB` in shared/snapshot.ts). */
import { PB, PedFlag, packGun, type SnapshotView } from '../../../shared/snapshot';
import { WEAPONS, spreadDeg } from '../../../shared/weapons';
import type { PedEntity } from '../../entities';

/** A shot this recent still shows in the pose (the gun kicks), ticks. */
const FIRING_TICKS = 6;

export function gunFlags(ped: PedEntity, tick: number): number {
  const g = ped.gun;
  const k = ped.cover;
  let f = 0;
  if (g) {
    f |= PedFlag.Armed;
    if (g.aiming) f |= PedFlag.Aiming;
    if (g.reloadLeft > 0) f |= PedFlag.Reloading;
    if (tick - g.lastShotTick < FIRING_TICKS) f |= PedFlag.Firing;
  }
  if (k) f |= k.low ? (g?.aiming ? 0 : PedFlag.Crouched) : PedFlag.InCover;
  if (ped.flinchT > 0) f |= PedFlag.Flinch;
  return f;
}

/** Fills the ped's weapon block (all of it: a record slot may have held a car's wheels before). */
export function writeGunBlock(view: SnapshotView, o: number, ped: PedEntity) {
  const u = view.u32;
  const f = view.f32;
  const g = ped.gun;
  const k = ped.cover;
  if (g) {
    const def = WEAPONS[g.weapon];
    const m = g.inv[g.weapon];
    u[o + PB.Gun] = packGun(def.index, m?.mag ?? 0, g.infinite ? 255 : (m?.reserve ?? 0));
    f[o + PB.AimYaw] = g.aimYaw;
    f[o + PB.AimPitch] = g.aimPitch;
    f[o + PB.Reload] = g.reloadLeft > 0 ? 1 - g.reloadLeft / def.reloadS : 0;
    f[o + PB.Bloom] = spreadDeg(def, g.aiming, g.bloom);
    u[o + PB.Lock] = g.lock;
  } else {
    u[o + PB.Gun] = 0;
    f[o + PB.AimYaw] = f[o + PB.AimPitch] = f[o + PB.Reload] = f[o + PB.Bloom] = 0;
    u[o + PB.Lock] = 0;
  }
  let owned = 0;
  if (g) for (const id of Object.keys(g.inv)) owned |= 1 << (WEAPONS[id as keyof typeof WEAPONS].index - 1);
  u[o + PB.Owned] = owned;
  f[o + PB.CoverNx] = k ? k.nx : 0;
  f[o + PB.CoverNz] = k ? k.nz : 0;
  f[o + PB.Lean] = k ? k.lean : 0;
  // The rest of the wheel block.
  for (let i = PB.Owned + 1; i < 32; i++) u[o + i] = 0;
}
