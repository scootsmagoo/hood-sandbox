/**
 * The engine's escalation rules (`data/police.json`): what each heat level adds on top of the city
 * pack's dispatch table. Pure data and lookups; nothing here names a city or an agency.
 */
import raw from './data/police.json';
import { LAW_RULES } from './law';

export interface FireLoadout {
  rangeM: number;
  intervalS: number;
  burst: [number, number];
  pauseS: [number, number];
  spreadDeg: number;
}

export interface PoliceRules {
  /** Where the first cars appear (m from the player) and how long dispatch takes (s, min and max), by heat level 0 to 6; a spawn spot's route to the scene may be at most `routeFactorMax` times the straight line before another is tried. */
  dispatch: { spawnMinM: number[]; spawnMaxM: number[]; delayS: [number, number][]; routeFactorMax: number };
  roles: { reassignEveryS: number; holdS: number; maxChasers: number; maxBlockers: number; flankerMinGapM: number };
  pit: {
    minHeat: number;
    targetSpeed: [number, number];
    rangeM: number;
    approachOffsetM: number;
    sideOffsetM: number;
    matchSpeedBand: number;
    strikeSteer: number;
    attemptS: number;
    cooldownS: number;
    graceAfterHitS: number;
    warnS: number;
    contactSpin: number;
  };
  ram: { minHeat: number; rangeM: number; cooldownS: number; graceAfterHitS: number; maxPlayerSpeedAdvantage: number };
  roadblock: {
    minHeat: number;
    maxActive: number[];
    intervalS: number[];
    distanceM: [number, number];
    cars: [number, number];
    gapChance: number[];
    gapWidthM: number;
    lifeS: number;
    officersPerCar: number;
  };
  spikes: { minHeat: number; maxActive: number[]; intervalS: number[]; lifeS: number; lengthM: number; depthM: number; beforeRoadblockM: number; deployDistanceM: [number, number] };
  helicopter: {
    minHeat: number;
    /** It comes this long (s, min and max) after the heat first reaches `minHeat`. */
    delayS: [number, number];
    count: number[];
    altitudeM: [number, number];
    speed: number;
    accel: number;
    orbitRadiusM: [number, number];
    coneHalfDeg: number;
    rangeM: number;
    searchlightNight: number;
    nightSightScale: number;
    respawnS: number;
  };
  fire: {
    minHeat: number;
    reactionS: [number, number];
    blockMarginM: number;
    loadouts: Record<string, FireLoadout>;
    spreadPerMeterDeg: number;
    spreadPerMpsDeg: number;
    driveBySpeedPenaltyDeg: number;
  };
  cooldown: { insideSearchFactor: number; heliOverheadFactor: number; heliOverheadM: number; minHeatForSlow: number };
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`police.json: ${msg}`);
};

export function parsePoliceRules(json: unknown): PoliceRules {
  const j = json as PoliceRules;
  for (const k of ['dispatch', 'roles', 'pit', 'ram', 'roadblock', 'spikes', 'helicopter', 'fire', 'cooldown'] as const) need(j && typeof j[k] === 'object', `missing "${k}"`);
  for (const [name, arr] of [
    ['roadblock.maxActive', j.roadblock.maxActive], ['roadblock.intervalS', j.roadblock.intervalS], ['roadblock.gapChance', j.roadblock.gapChance],
    ['spikes.maxActive', j.spikes.maxActive], ['spikes.intervalS', j.spikes.intervalS], ['helicopter.count', j.helicopter.count],
  ] as const) need(Array.isArray(arr) && arr.length >= 7, `${name} needs an entry for each heat level 0 to 6`);
  for (const [name, arr] of [['dispatch.spawnMinM', j.dispatch.spawnMinM], ['dispatch.spawnMaxM', j.dispatch.spawnMaxM], ['dispatch.delayS', j.dispatch.delayS]] as const) need(Array.isArray(arr) && arr.length >= 7, `${name} needs an entry for each heat level 0 to 6`);
  need(j.helicopter.delayS.length === 2 && j.helicopter.delayS[0] <= j.helicopter.delayS[1], 'helicopter.delayS must be [min, max]');
  need(j.roadblock.cars[0] >= 1 && j.roadblock.cars[1] >= j.roadblock.cars[0], 'roadblock.cars must be [min, max]');
  need(j.helicopter.altitudeM[0] > 0 && j.helicopter.altitudeM[1] >= j.helicopter.altitudeM[0], 'helicopter.altitudeM must be [min, max]');
  for (const [id, l] of Object.entries(j.fire.loadouts)) need(l.rangeM > 0 && l.intervalS > 0 && l.burst[1] >= l.burst[0], `fire.loadouts.${id} is malformed`);
  return j;
}

export const POLICE_RULES: Readonly<PoliceRules> = parsePoliceRules(raw);

/** A value from a per-heat array at a heat level (clamped to 0 to 6). */
export const atHeat = (arr: readonly number[], heat: number): number => arr[Math.max(0, Math.min(arr.length - 1, heat))] ?? 0;

/** The loadout table entry for a weapon id; a pistol's numbers for one it does not know. */
export function loadoutFor(id: string): FireLoadout {
  return POLICE_RULES.fire.loadouts[id] ?? POLICE_RULES.fire.loadouts.pistol;
}

/** A police vision cone on the ground plane, for the minimap: apex, facing yaw (the entity's own convention), half-angle and range. */
export interface VisionCone {
  x: number;
  z: number;
  yaw: number;
  halfAngle: number;
  range: number;
}

/**
 * The cone an officer on foot or a police car sees along. `inCar` widens it (a driver can turn their
 * head, `PoliceManager.canSee`). Anything closer than `LAW_RULES.closeSenseM` is seen whichever way
 * the officer faces.
 */
export function officerCone(x: number, z: number, yaw: number, inCar: boolean): VisionCone {
  return { x, z, yaw, halfAngle: (LAW_RULES.visionHalfAngleDeg * (inCar ? 1.45 : 1) * Math.PI) / 180, range: LAW_RULES.visionRangeM };
}

/** The circle a helicopter sees on the ground at an altitude (its cone's footprint), m. */
export function heliFootprint(altitude: number): number {
  return Math.tan((POLICE_RULES.helicopter.coneHalfDeg * Math.PI) / 180) * altitude;
}
