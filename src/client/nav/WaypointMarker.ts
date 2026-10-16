/**
 * The waypoint in the world: a tall beacon of light over the spot, a pulsing ring on the ground and a slowly turning diamond above
 * it, in the GPS colour. Three meshes and three draw calls, unlit (so it reads at night and through the bloom) and not fogged (so it
 * is there at a distance). It grows with distance so it stays a few pixels wide however far away, and past the camera's far plane it
 * is drawn on the same bearing, nearer, so there is always something to steer by.
 */
import * as THREE from 'three';

const COLOR = new THREE.Color('#ff38d6');
/** The bright core of the beam. */
const CORE = new THREE.Color('#ffd6f6');

/** An open cylinder of unit radius and height standing on y = 0, bright at the foot and clear at the top. */
function beamGeometry(color: THREE.Color, foot: number): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
  geo.translate(0, 0.5, 0);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) col.set([color.r, color.g, color.b, pos.getY(i) > 0.5 ? 0 : foot], i * 4);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return geo;
}

export class WaypointMarker {
  readonly group = new THREE.Group();
  private readonly beam: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly gem: THREE.Mesh;
  private readonly mats: THREE.Material[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private t = 0;
  private shown = false;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'waypoint-marker';
    this.group.visible = false;

    // the beam: a wide soft column round a narrow bright core, both fading out toward the top
    const beamGeo = beamGeometry(COLOR, 0.8);
    const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    const coreGeo = beamGeometry(CORE, 1);
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.core = new THREE.Mesh(coreGeo, coreMat);

    const ringGeo = new THREE.RingGeometry(0.72, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.ring = new THREE.Mesh(ringGeo, ringMat);

    const gemGeo = new THREE.OctahedronGeometry(1, 0);
    gemGeo.scale(0.6, 1, 0.6);
    const gemMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
    this.gem = new THREE.Mesh(gemGeo, gemMat);

    this.geos.push(beamGeo, coreGeo, ringGeo, gemGeo);
    this.mats.push(beamMat, coreMat, ringMat, gemMat);
    for (const m of [this.beam, this.core, this.ring, this.gem]) {
      m.frustumCulled = false;
      m.renderOrder = 8;
      this.group.add(m);
    }
    scene.add(this.group);
  }

  /** The distance past which the marker is drawn nearer, on the same bearing. */
  static readonly MAX_DRAW_M = 1700;

  /**
   * Places the marker at (x, y, z) and sizes it for the camera at `cam`. Call every frame while a waypoint is set; `hide()` when not.
   */
  update(dt: number, x: number, y: number, z: number, cam: THREE.Vector3, farM = WaypointMarker.MAX_DRAW_M) {
    if (this.disposed) return;
    this.t += dt;
    if (!this.shown) {
      this.shown = true;
      this.group.visible = true;
    }
    const dx = x - cam.x, dz = z - cam.z;
    const dist = Math.hypot(dx, dz, y - cam.y);
    const maxDraw = Math.min(farM, WaypointMarker.MAX_DRAW_M);
    // beyond the far plane: the same direction, nearer, and scaled so it looks the same size
    const k = dist > maxDraw ? maxDraw / dist : 1;
    const gx = cam.x + dx * k, gy = cam.y + (y - cam.y) * k, gz = cam.z + dz * k;
    const d = dist * k;
    const radius = Math.max(1.4, d * 0.011);
    const height = (120 + d * 0.35) ;
    this.group.position.set(gx, gy, gz);
    this.beam.scale.set(radius * 0.9, height, radius * 0.9);
    this.core.scale.set(radius * 0.28, height * 0.8, radius * 0.28);
    // the ring breathes outward and fades
    const pulse = (this.t % 1.6) / 1.6;
    const rs = radius * (1.2 + pulse * 1.6);
    this.ring.scale.set(rs, 1, rs);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - pulse * pulse);
    this.ring.position.y = 0.25 * Math.max(1, d / 80);
    const bob = Math.sin(this.t * 2.2) * 0.5;
    this.gem.position.y = radius * 2.6 + 4 + bob * radius * 0.3;
    this.gem.scale.setScalar(Math.max(1.1, radius * 0.95));
    this.gem.rotation.y = this.t * 1.4;
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.shown;
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
