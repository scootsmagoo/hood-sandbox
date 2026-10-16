/**
 * The aircraft classes and liveries of `src/shared/data/aircraft.json` (the file the models are built to, the colliders and the
 * jet bridges read), typed, with the class indices the snapshot packs.
 */
import raw from '../../shared/data/aircraft.json';
import type { AircraftClass } from '../../shared/aeroway';

export interface AircraftTypeData {
  label: string;
  length: number;
  span: number;
  height: number;
  noseZ: number;
  tailZ: number;
  fuselage: { radius: number; centreY: number; cabinZ: number[] };
  wheelbase: number;
  mainGearHalfTrack: number;
  doorL1: { x: number; y: number; z: number };
  speeds: { taxi: number; turn: number; rotate: number; approach: number; touchdown: number; exit: number };
  /** collision boxes, model frame: centre and half extents */
  colliders: { c: number[]; h: number[] }[];
  lights: Record<string, number[]>;
}

export interface LiveryData {
  id: string;
  airline: string;
  real: string;
  crown: string;
  belly: string;
  fin: string;
  engine: string;
  stripe: string;
  accent: string;
  weight: number;
  classes: string[];
  cargo?: boolean;
}

export const CLASSES: readonly AircraftClass[] = ['narrowbody', 'widebody', 'regional'];
export const CLASS_INDEX: Record<AircraftClass, number> = { narrowbody: 0, widebody: 1, regional: 2 };
export const TYPES = raw.types as unknown as Record<AircraftClass, AircraftTypeData>;
export const LIVERIES = raw.liveries as unknown as LiveryData[];

/** The liveries that fly a class (cargo or not), with their weights. */
export function liveriesFor(cls: AircraftClass, cargo: boolean): { index: number; weight: number }[] {
  const out: { index: number; weight: number }[] = [];
  LIVERIES.forEach((l, i) => {
    if (!!l.cargo !== cargo || !l.classes.includes(cls)) return;
    out.push({ index: i, weight: cargo ? 1 : l.weight });
  });
  return out;
}
