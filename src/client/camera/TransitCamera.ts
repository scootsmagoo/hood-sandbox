/**
 * The camera while riding a train, GTA IV style, two views (the view button switches): out of the window (the camera at the
 * rider's eye, looking out of the window beside them, free to look about within reason) and the chase (outside, following the
 * train along its track: on the centreline behind it in a tunnel, where nothing else fits, and up and to the side in the open).
 * It takes over from the camera rig while the snapshot says the player is on a train (`SnapFlag.OnTrain`).
 */
import * as THREE from 'three';
import { clamp, damp, wrapAngle } from '../../shared/math';
import { H, SnapFlag, TransitInfo } from '../../shared/snapshot';
import { carMidAt, routePointExt, newRoutePoint } from '../../shared/transit';
import car from '../../shared/data/railcar.json';
import type { Game } from '../Game';

declare module '../Game' {
  interface Game {
    transitCamera?: TransitCamera;
  }
}

export type RideView = 'window' | 'chase';

export class TransitCamera {
  mode: RideView = 'window';
  /** A fixed camera for scripted screenshots (scripts/transit-shots.mjs): position and point looked at; null for the game's. */
  override: { pos: [number, number, number]; look: [number, number, number]; fov?: number } | null = null;

  /** Applies the override, if any; true when it has the camera. */
  applyOverride(): boolean {
    const o = this.override;
    if (!o) return false;
    const cam = this.game.camera;
    cam.position.set(o.pos[0], o.pos[1], o.pos[2]);
    cam.lookAt(o.look[0], o.look[1], o.look[2]);
    if (o.fov && Math.abs(cam.fov - o.fov) > 0.01) {
      cam.fov = o.fov;
      cam.updateProjectionMatrix();
    }
    return true;
  }
  private yawOff = 0;
  private pitch = -0.04;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly want = new THREE.Vector3();
  private readonly wantLook = new THREE.Vector3();
  private readonly pt = newRoutePoint();
  private wasRiding = false;
  private snapNext = true;

  constructor(private readonly game: Game) {
    game.transitCamera = this;
  }

  /** Whether the player rides a train (so this camera has the view). */
  active(): boolean {
    const s = this.game.view.sample?.b;
    return !!s && (s.u32[H.Flags] & SnapFlag.OnTrain) !== 0;
  }

  /** One frame. `look` is the rig's look input of this frame (radians). */
  apply(dt: number, look: { yaw: number; pitch: number }): void {
    const g = this.game;
    if (!this.wasRiding) {
      this.wasRiding = true;
      this.snapNext = true;
      this.yawOff = 0;
      this.pitch = -0.04;
    }
    if (g.input.pressed('toggleView')) {
      this.mode = this.mode === 'window' ? 'chase' : 'window';
      this.snapNext = true;
      this.yawOff = 0;
    }
    const tv = g.transit;
    const s = g.view.sample?.b;
    const ped = g.view.ped;
    const trains = tv?.trains;
    if (!tv || !s || !ped || !trains) return;
    const k = TransitInfo.car(s.u32[H.TransitInfo]);
    const cv = trains.ridden.find((c) => c.k === k) ?? trains.ridden[0];
    if (!cv) return;
    const p = cv.pose;
    // the route's left of the direction of travel
    const lx = p.fz, lz = -p.fx;
    const cam = g.camera;
    this.yawOff = clamp(this.yawOff + look.yaw, this.mode === 'window' ? -1.4 : -Math.PI, this.mode === 'window' ? 1.4 : Math.PI);
    this.pitch = clamp(this.pitch + look.pitch, -0.7, 0.5);
    const under = (s.u32[H.Flags] & SnapFlag.Underground) !== 0;
    if (this.mode === 'window') {
      // the rider's eye, out of the window on their side (sitting or standing)
      const across = (ped.x - p.x) * lx + (ped.z - p.z) * lz;
      const side = across >= 0 ? 1 : -1;
      const seated = TransitInfo.ride(s.u32[H.TransitInfo]) === 1;
      this.want.set(ped.x, ped.y + (seated ? 1.18 : 1.62), ped.z);
      // a little forward of square out of the window, and turned by the player
      const base = Math.atan2(lx * side + p.fx * 0.35, lz * side + p.fz * 0.35);
      const yaw = base + this.yawOff;
      this.wantLook.set(this.want.x + Math.sin(yaw) * 10 * Math.cos(this.pitch), this.want.y + Math.sin(this.pitch) * 10, this.want.z + Math.cos(yaw) * 10 * Math.cos(this.pitch));
      this.fov(68, dt);
    } else {
      // behind the train along its track: on the centreline in a tunnel, up and aside in the open
      const route = tv.data.routes[cv.route];
      const head = trains.heads.find((h) => h.id === cv.trainId);
      const sHead = head ? head.s : 0;
      const tail = carMidAt(sHead, 5, car.length, car.gap) - car.length / 2;
      const back = under ? 16 : 26;
      const q = routePointExt(route, tail - back, this.pt);
      if (under) {
        this.want.set(q.x, q.y + 3.7, q.z);
      } else {
        const orbit = this.yawOff;
        this.want.set(q.x + lx * 9 * Math.cos(orbit) - q.dx * 9 * Math.sin(orbit), q.y + 8 + this.pitch * 6, q.z + lz * 9 * Math.cos(orbit) - q.dz * 9 * Math.sin(orbit));
      }
      this.wantLook.set(p.x, p.y + 2.2, p.z);
      this.fov(60, dt);
    }
    if (this.snapNext) {
      this.pos.copy(this.want);
      this.look.copy(this.wantLook);
      this.snapNext = false;
    } else {
      // the window view rides with the car (no lag); the chase follows softly
      const f = this.mode === 'window' ? 1 : Math.min(1, damp(6, dt));
      this.pos.lerp(this.want, f);
      this.look.lerp(this.wantLook, this.mode === 'window' ? 1 : Math.min(1, damp(10, dt)));
    }
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    // what the sim probes (nothing: the camera is inside the car or on the track)
    g.cameraArm.yaw = wrapAngle(cam.rotation.y);
    g.cameraArm.pitch = 0;
    g.cameraArm.dist = 0.5;
    g.focus.set(ped.x, ped.y, ped.z);
  }

  /** The rig's camera has it back. */
  release(): void {
    this.wasRiding = false;
  }

  private fov(f: number, dt: number) {
    const cam = this.game.camera;
    const next = cam.fov + (f - cam.fov) * Math.min(1, damp(5, dt));
    if (Math.abs(next - cam.fov) > 0.01) {
      cam.fov = next;
      cam.updateProjectionMatrix();
    }
  }
}
