/**
 * Entity definitions: what an entity is, as opposed to where it is. Snapshots carry only the state
 * that changes every tick (pose, velocity, flags); the definition travels once, in `SimReady.entities`
 * for what exists at the start and then as `entity:spawn` and `entity:despawn` events (events are
 * reliable, snapshots are not). The client draws nothing it has no definition for.
 */
import { EntityKind, type EntityId } from './entities';

export interface VehicleDef {
  readonly id: EntityId;
  readonly kind: typeof EntityKind.Vehicle;
  /** Key into the handling table. */
  readonly typeId: string;
  /** Paint, 0xRRGGBB. */
  readonly color: number;
  /** Registration plate (the description records it; the model may draw it later). */
  readonly plate: string;
  /** A police car: the agency's livery and lightbar colours (0xRRGGBB). An `unmarked` one has no stripe or lightbar until its lights are on, then two strobes in `lightbar`. */
  readonly police?: { agency: string; body: number; stripe: number; lightbar: [number, number]; unmarked?: boolean };
}

export interface PedDef {
  readonly id: EntityId;
  readonly kind: typeof EntityKind.Ped;
  /** Index into the client's outfit table (0 is the protagonist's). */
  readonly outfit: number;
  /** The player's own character. */
  readonly player: boolean;
  /** An officer: the agency and its uniform colour (0xRRGGBB). */
  readonly police?: { agency: string; uniform: number };
}

/** A police helicopter. Its pose, searchlight and rotor are in the snapshot (see `HeliFlag`). */
export interface HelicopterDef {
  readonly id: EntityId;
  readonly kind: typeof EntityKind.Helicopter;
  readonly typeId: 'helicopter';
  /** The agency's paint, 0xRRGGBB. */
  readonly color: number;
  readonly agency: string;
}

/** A spike strip: `length` metres across the lane, `yaw` is the direction it points along its length. */
export interface SpikeStripDef {
  readonly id: EntityId;
  readonly kind: typeof EntityKind.SpikeStrip;
  readonly length: number;
  readonly depth: number;
}

export type EntityDef = VehicleDef | PedDef | HelicopterDef | SpikeStripDef;

/** Paint colours the sim picks from for parked cars, 0xRRGGBB. */
export const PAINTS = [0xb23a2e, 0x2f5d8a, 0xd9d6cf, 0x1f2326, 0x6b7a4a, 0xc79a2a, 0x7a2f55, 0x8d949b] as const;
/** How many outfits the client has for pedestrians (src/client/render/chars/outfits.ts has one entry each; a test keeps them equal). */
export const OUTFIT_COUNT = 21;
