/**
 * The airport's lights after dark: the runway edge, centreline, touchdown zone, threshold (green) and end (red) lights, the
 * taxiway centreline (green) and edge (blue) lights, the approach lights with their sequenced flashers running in to the
 * threshold (all from `aeroway.json`), and the aircraft's own: red and green wingtip lights, the white tail light, the red beacon
 * (flashing once a second), the white wingtip strobes (a double flash) and the landing lights (on approach and the takeoff roll).
 *
 * One Points draw for the fixed lights and one for the aircraft's, a shader sizes every light by distance (never under two pixels,
 * so a runway reads from the far side of the field) and fades them in at dusk. Additive, no depth writes.
 */
import * as THREE from 'three';
import type { AerowayData } from '../../../shared/aeroway';
import { AircraftFlag } from '../../../shared/snapshot';
import raw from '../../../shared/data/aircraft.json';
import type { Game, System } from '../../Game';
import { nightFactor } from '../timeOfDay';
import type { AircraftViews } from './AircraftViews';
import { CLASS_NAMES, FAR_SHARE } from './AircraftViews';

const TYPES = raw.types as unknown as Record<string, { lights: Record<string, number[]> }>;

/** Per kind of fixed light: its colour (linear) and size (m) and how bright by day (0: night only). */
const KINDS: Record<string, { color: number; size: number; flash?: boolean }> = {
  edge: { color: 0xfff2d8, size: 2.6 },
  centre: { color: 0xffffff, size: 1.6 },
  tdz: { color: 0xffffff, size: 0.8 },
  threshold: { color: 0x3cff6a, size: 2.6 },
  end: { color: 0xff2a1e, size: 2.4 },
  taxiCentre: { color: 0x2cff5a, size: 1.3 },
  taxiEdge: { color: 0x3a6cff, size: 1.5 },
  approach: { color: 0xffffff, size: 2.2, flash: true },
};

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aFlash;
uniform float uScale;
uniform float uTime;
uniform float uNight;
uniform float uMinPx;
varying vec3 vColor;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  // a sequenced flasher: one bright pulse a second, running in from 900 m to the threshold
  float fl = 1.0;
  if (aFlash > 0.0) {
    float ph = fract(uTime * 2.0 - aFlash / 900.0);
    fl = 0.55 + 4.0 * smoothstep(0.06, 0.0, ph);
  }
  // aircraft lights: aFlash < 0 is a blink pattern (-1 beacon, -2 strobe), its phase in the fraction
  if (aFlash < -0.5) {
    float kind = floor(-aFlash);
    float ph = fract(uTime + fract(-aFlash) * 7.0);
    fl = kind < 1.5 ? (ph < 0.12 ? 1.6 : 0.0) : ((ph < 0.05 || (ph > 0.12 && ph < 0.17)) ? 2.6 : 0.0);
  }
  vA = fl * mix(aFlash < -0.5 || aSize > 2.9 ? 0.55 : 0.0, 1.0, uNight);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
  float px = aSize * uScale / d;
  // a light smaller than its least size keeps that size but dims with distance, so the far field reads as lines of light, not a glare
  vA *= px < uMinPx ? mix(0.55, 1.0, px / uMinPx) * 1.6 : 1.0;
  gl_PointSize = max(uMinPx, px) * (aSize > 2.9 ? 1.6 : 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vA;
void main() {
  if (vA <= 0.001) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  float a = core * core * vA;
  gl_FragColor = vec4(vColor * a * 2.2, a);
}`;

function material(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uScale: { value: 600 }, uTime: { value: 0 }, uNight: { value: 0 }, uMinPx: { value: 2 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const MAX_AC_LIGHTS = 9 * 220;

export class AirfieldLights implements System {
  readonly name = 'airfield-lights';
  readonly priority = 167;
  private readonly fixed: THREE.Points;
  private readonly moving: THREE.Points;
  private readonly mat = material();
  private readonly matAc = material();
  private readonly acPos = new Float32Array(MAX_AC_LIGHTS * 3);
  private readonly acCol = new Float32Array(MAX_AC_LIGHTS * 3);
  private readonly acSize = new Float32Array(MAX_AC_LIGHTS);
  private readonly acFlash = new Float32Array(MAX_AC_LIGHTS);
  private t = 0;
  readonly stats = { fixed: 0, aircraft: 0 };

  constructor(
    private readonly game: Game,
    data: AerowayData,
    private readonly aircraft: AircraftViews | null,
  ) {
    const pos: number[] = [], col: number[] = [], size: number[] = [], flash: number[] = [];
    const c = new THREE.Color();
    for (const [k, spec] of Object.entries(KINDS)) {
      const L = data.lights[k];
      if (!L) continue;
      const stride = k === 'approach' ? 4 : 3;
      c.set(spec.color);
      for (let i = 0; i + 2 < L.length; i += stride) {
        pos.push(L[i], L[i + 1], L[i + 2]);
        col.push(c.r, c.g, c.b);
        size.push(spec.size);
        flash.push(spec.flash ? Math.max(1, L[i + 3] ?? 1) : 0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute('aFlash', new THREE.Float32BufferAttribute(flash, 1));
    g.computeBoundingSphere();
    this.fixed = new THREE.Points(g, this.mat);
    this.fixed.name = 'airfield-lights';
    this.fixed.frustumCulled = false;
    this.fixed.renderOrder = 5;
    this.stats.fixed = pos.length / 3;
    const ga = new THREE.BufferGeometry();
    ga.setAttribute('position', new THREE.BufferAttribute(this.acPos, 3).setUsage(THREE.DynamicDrawUsage));
    ga.setAttribute('aColor', new THREE.BufferAttribute(this.acCol, 3).setUsage(THREE.DynamicDrawUsage));
    ga.setAttribute('aSize', new THREE.BufferAttribute(this.acSize, 1).setUsage(THREE.DynamicDrawUsage));
    ga.setAttribute('aFlash', new THREE.BufferAttribute(this.acFlash, 1).setUsage(THREE.DynamicDrawUsage));
    ga.setDrawRange(0, 0);
    this.moving = new THREE.Points(ga, this.matAc);
    this.moving.name = 'aircraft-lights';
    this.moving.frustumCulled = false;
    this.moving.renderOrder = 5;
    game.scene.add(this.fixed, this.moving);
  }

  update(dt: number) {
    this.t += dt;
    const cv = this.game.clockView;
    const night = cv ? THREE.MathUtils.smoothstep(nightFactor(cv.minutes), 0.1, 0.6) : 0;
    const proj = this.game.camera.projectionMatrix.elements[5] * this.game.renderer.domElement.height * 0.5;
    for (const m of [this.mat, this.matAc]) {
      m.uniforms.uTime.value = this.t;
      m.uniforms.uNight.value = night;
      m.uniforms.uScale.value = proj;
      m.uniforms.uMinPx.value = Math.max(2.5, this.game.renderer.getPixelRatio() * 2.5);
    }
    this.fixed.visible = night > 0.01;
    // the aircraft's lights
    const av = this.aircraft;
    let n = 0;
    if (av) {
      const cam = this.game.camera.position;
      for (let k = 0; k < av.count && n + 9 <= MAX_AC_LIGHTS; k++) {
        const d = av.at(k);
        const L = TYPES[CLASS_NAMES[d.cls]]?.lights;
        if (!L) continue;
        const dist = Math.hypot(cam.x - d.x, cam.y - d.y, cam.z - d.z);
        const far = dist > 3000;
        const reach = this.game.camera.far * FAR_SHARE;
        const pull = dist > reach ? reach / dist : 1;
        const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw), cp = Math.cos(d.pitch), sp = Math.sin(d.pitch);
        const put = (p: number[], r: number, g: number, b: number, size: number, flash: number) => {
          // model (x left, y up, z forward) to world: pitch about x (nose up), then yaw
          const y1 = p[1] * cp + p[2] * sp, z1 = -p[1] * sp + p[2] * cp;
          let x = d.x + p[0] * cy + z1 * sy, y = d.y + y1, z = d.z - p[0] * sy + z1 * cy;
          // beyond the far plane: nearer along the line of sight (the shader sizes it by the distance it is drawn at, so it is a
          // little bigger than it would be: a light far out over the approach reads)
          if (pull < 1) {
            x = cam.x + (x - cam.x) * pull;
            y = cam.y + (y - cam.y) * pull;
            z = cam.z + (z - cam.z) * pull;
          }
          this.acPos[n * 3] = x;
          this.acPos[n * 3 + 1] = y;
          this.acPos[n * 3 + 2] = z;
          this.acCol[n * 3] = r;
          this.acCol[n * 3 + 1] = g;
          this.acCol[n * 3 + 2] = b;
          this.acSize[n] = size;
          this.acFlash[n] = flash;
          n++;
        };
        const parked = d.phase === 0;
        if ((d.flags & AircraftFlag.Nav) !== 0 && !far) {
          put(L.navLeft, 1, 0.08, 0.05, 0.9, 0);
          put(L.navRight, 0.08, 1, 0.15, 0.9, 0);
          put(L.tail, 1, 1, 1, 0.8, 0);
        }
        if ((d.flags & AircraftFlag.Beacon) !== 0 && !parked) {
          put(L.beaconTop, 1, 0.1, 0.05, 1.4, -1 - d.seed * 0.1);
          put(L.beaconBottom, 1, 0.1, 0.05, 1.4, -1 - ((d.seed + 0.5) % 1) * 0.1);
        }
        if ((d.flags & AircraftFlag.Strobe) !== 0) {
          put(L.strobeLeft, 1, 1, 1, 1.6, -2 - d.seed * 0.1);
          put(L.strobeRight, 1, 1, 1, 1.6, -2 - d.seed * 0.1);
        }
        if ((d.flags & AircraftFlag.Landing) !== 0) put(L.landing, 1, 0.97, 0.88, far ? 14 : 5, 0);
      }
    }
    const g = this.moving.geometry;
    g.setDrawRange(0, n);
    if (n) for (const k of ['position', 'aColor', 'aSize', 'aFlash']) (g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    this.stats.aircraft = n;
  }

  dispose() {
    this.fixed.removeFromParent();
    this.moving.removeFromParent();
    this.fixed.geometry.dispose();
    this.moving.geometry.dispose();
    this.mat.dispose();
    this.matAc.dispose();
  }
}
