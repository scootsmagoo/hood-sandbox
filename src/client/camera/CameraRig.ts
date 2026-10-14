/**
 * Two cameras in one rig. On foot it orbits the character: the mouse, arrow keys, right stick or a
 * drag turn it, and it stays where it is put. In a car it chases: it settles behind the car (leaning
 * toward the direction of travel in a slide), widens with speed, and the player can look around and
 * look back; it drifts home when the player lets go.
 *
 * Wall avoidance: the rig reports its wanted arm (yaw, pitch, length) in `game.cameraArm`; the sim
 * probes the world with it and answers with how much is clear, which comes back as
 * `game.view.camClear`.
 */
import { clamp, damp, wrapAngle, yawOfQuat } from '../../shared/math';
import type { Game, System } from '../Game';
import { armDirection, armLength, chaseDistance, chaseFov, chaseYaw, followAngle } from './cameraMath';

const FOOT_DISTANCES = [2.6, 4.2, 6.5];
const FOOT_PIVOT_HEIGHT = 1.55;
const CAR_PIVOT_HEIGHT = 1.35;
const PITCH_MIN = -1.3;
const PITCH_MAX = 0.8;
/** Seconds without look input before the chase camera starts drifting home. */
const RECENTER_AFTER = 1.2;

declare module '../Game' {
  interface Game {
    cameraRig: CameraRig;
  }
}

const dir = { x: 0, y: 0, z: 0 };

export class CameraRig implements System {
  readonly name = 'cameraRig';
  readonly priority = 100;
  yaw = 0;
  pitch = -0.22;
  /** Preset index for both modes: 0 near, 1 mid, 2 far. */
  preset = 1;
  private arm = 4.2;
  private offYaw = 0;
  private offPitch = 0;
  private idle = 0;
  private fov = 62;
  private wasInVehicle = false;
  private lookBack = false;
  private initialised = false;
  private look = { yaw: 0, pitch: 0 };

  constructor(private readonly game: Game) {
    game.cameraRig = this;
  }

  update(dt: number) {
    const { input } = this.game;
    this.look = input.consumeLook(dt);
    if (input.pressed('toggleView')) this.preset = (this.preset + 1) % 3;
    if (input.pressed('zoomIn')) this.preset = Math.max(0, this.preset - 1);
    if (input.pressed('zoomOut')) this.preset = Math.min(2, this.preset + 1);
    this.lookBack = input.down('lookBack');
  }

  lateUpdate(dt: number) {
    const g = this.game;
    const v = g.view;
    const st = v.controlled;
    if (!st) return;
    const camera = g.camera;

    if (!this.initialised) {
      // Start behind the character, looking the way it faces.
      this.yaw = yawOfQuat(st.q) - Math.PI;
      // On foot with the car far away, look toward it.
      const car = v.vehicle;
      if (!v.inVehicle && car && Math.hypot(car.x - st.x, car.z - st.z) > 20) this.yaw = Math.atan2(st.x - car.x, st.z - car.z);
      this.initialised = true;
    }

    let pivotY: number;
    let wanted: number;
    if (v.inVehicle) {
      if (!this.wasInVehicle) this.offYaw = wrapAngle(this.yaw - chaseYaw(yawOfQuat(st.q), st.vx, st.vz, st.speed));
      const speed = Math.hypot(st.vx, st.vz);
      if (this.look.yaw || this.look.pitch) {
        this.offYaw += this.look.yaw;
        this.offPitch = clamp(this.offPitch + this.look.pitch, -0.7, 0.9);
        this.idle = 0;
      } else this.idle += dt;
      if (this.idle > RECENTER_AFTER) {
        this.offYaw -= this.offYaw * damp(2.2, dt);
        this.offPitch -= this.offPitch * damp(2.2, dt);
      }
      const back = this.lookBack ? Math.PI : 0;
      this.offYaw = wrapAngle(this.offYaw);
      const target = chaseYaw(yawOfQuat(st.q), st.vx, st.vz, st.speed) + (this.lookBack ? back : this.offYaw);
      // Follow quicker at speed so a fast turn does not leave the car behind.
      this.yaw = followAngle(this.yaw, target, 3 + Math.min(speed, 30) * 0.08, dt);
      this.pitch = clamp(-0.2 + this.offPitch, PITCH_MIN, PITCH_MAX);
      pivotY = CAR_PIVOT_HEIGHT;
      wanted = chaseDistance(speed, this.preset);
      const fovTarget = chaseFov(speed);
      this.fov += (fovTarget - this.fov) * damp(4, dt);
    } else {
      this.yaw += this.look.yaw;
      this.pitch = clamp(this.pitch + this.look.pitch, PITCH_MIN, PITCH_MAX);
      this.idle = 0;
      pivotY = FOOT_PIVOT_HEIGHT;
      wanted = FOOT_DISTANCES[this.preset];
      this.fov += (62 - this.fov) * damp(4, dt);
      if (this.wasInVehicle) this.offYaw = this.offPitch = 0;
    }
    this.wasInVehicle = v.inVehicle;

    // The arm the sim will probe next, and the clear length it reported for the last one.
    g.cameraArm.yaw = this.yaw;
    g.cameraArm.pitch = this.pitch;
    g.cameraArm.dist = wanted + 0.4;
    this.arm = armLength(this.arm, wanted, v.camClear - 0.4, dt);

    armDirection(this.yaw, this.pitch, dir);
    camera.position.set(st.x + dir.x * this.arm, st.y + pivotY + dir.y * this.arm, st.z + dir.z * this.arm);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}
