/**
 * What moves an aircraft, kept apart from what an aircraft is, so a player-flown one can join later without touching the AI.
 *
 *   AircraftState   the pose, velocity and systems of one aircraft: what the snapshot writes, the colliders follow and the client
 *                   draws, whoever moves it
 *   Controller      moves a state one tick: `AiPlanController` evaluates a deterministic plan (plans.ts); a player's (not built)
 *                   would read `FlightControls` from the input and integrate a `FlightModel`
 *   FlightModel     the flight dynamics hook: forces from the controls and the state (lift, drag, thrust, gravity, the gear on
 *                   the ground), integrated by the sim's fixed tick. The AI never calls it: its pose is a function of time.
 *
 * To make aircraft flyable (later): give a parked aircraft an entry point (`anchor_doorL1` of the models, the stand's jet bridge),
 * let PlayerControlSystem hand the player's input to a `PlayerFlightController` that owns the aircraft's state (taking it out of
 * the AI's stand or plan, the way a car is taken from traffic), implement a `FlightModel` (`integrate`) with ground contact on the
 * heightmap and the runway, make the aircraft the controlled entity of the snapshot (an entity record or the aircraft block's id
 * in `H.Controlled`), and switch its collider from kinematic to dynamic (or keep it kinematic and move it from the model's
 * integration). The AI's conflict planning treats a player's aircraft as an obstacle it does not plan around: the AI flights it
 * meets keep their schedule, as they do round the player on foot.
 */
import type { AircraftClass } from '../../shared/aeroway';
import { newPose, poseAt, type AircraftPose, type Plan } from './plans';

/** One aircraft as the world sees it (the AI's pose, plus what a flight model needs). */
export interface AircraftState extends AircraftPose {
  id: number;
  cls: AircraftClass;
  livery: number;
  /** world velocity, m/s */
  vx: number;
  vy: number;
  vz: number;
  /** on its wheels */
  onGround: boolean;
}

export const newAircraftState = (id: number, cls: AircraftClass, livery: number): AircraftState => ({ ...newPose(), id, cls, livery, vx: 0, vy: 0, vz: 0, onGround: true });

/** The pilot's controls, -1..1 (throttle and brake 0..1), as a player's flight would read them from the input. */
export interface FlightControls {
  throttle: number;
  pitch: number;
  roll: number;
  yaw: number;
  brake: number;
  gearDown: boolean;
  flaps: number;
}

/** The flight dynamics hook (not used by the AI): advances `s` by `dt` under `c`. `ground(x, z)` is the surface height. */
export interface FlightModel {
  integrate(s: AircraftState, c: FlightControls, dt: number, ground: (x: number, z: number) => number): void;
}

export interface AircraftController {
  readonly kind: 'ai' | 'player';
  /** Moves the state to sim time `t` (seconds) over the tick `dt`. */
  step(s: AircraftState, t: number, dt: number): void;
}

/** The AI: the state is the plan's pose at the time (and the velocity from the last tick's position). */
export class AiPlanController implements AircraftController {
  readonly kind = 'ai' as const;
  constructor(readonly plan: Plan, readonly t0: number) {}

  step(s: AircraftState, t: number, dt: number) {
    const px = s.x, py = s.y, pz = s.z;
    poseAt(this.plan, t - this.t0, s);
    if (dt > 0) {
      s.vx = (s.x - px) / dt;
      s.vy = (s.y - py) / dt;
      s.vz = (s.z - pz) / dt;
    }
    s.onGround = s.gear > 0.99 && s.phase !== 1 && s.phase !== 8;
  }
}
