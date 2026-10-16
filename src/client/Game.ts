/**
 * The client's spine: the renderer, the scene, the camera, the input and the list of systems.
 *
 * A System has optional `update(dt)` and `lateUpdate(dt)` and a `priority` (lower runs first).
 * The simulation is not here: it runs in a worker and arrives through the `NetSystem`. Services
 * are added to `Game` by declaration merging in their own module, so shared files stay untouched:
 *
 *   declare module '../Game' { interface Game { foo: Foo } }
 */
import * as THREE from 'three';
import type { SimReady } from '../shared/protocol';
import type { Transport } from '../shared/transport';
import { GraphicsGovernor, pickTier, TIERS, tierBelow, type Tier } from './graphics';
import { Input } from './input/Input';
import { ownDepthAll } from './render/depthMaterials';

export interface System {
  readonly name: string;
  readonly priority: number;
  update?(dt: number): void;
  lateUpdate?(dt: number): void;
  dispose?(): void;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2600);
  readonly input: Input;
  readonly params: URLSearchParams;
  readonly governor = new GraphicsGovernor();
  transport!: Transport;
  ready!: SimReady;
  /** What the camera follows and what the shadows centre on (render position of the controlled entity). */
  readonly focus = new THREE.Vector3();
  /** The camera arm the sim probes for walls: written by the camera rig, sent with every input command. */
  readonly cameraArm = { yaw: 0, pitch: -0.25, dist: 5 };
  tier: Tier;
  readonly gpuName: string;

  /** Smoothed frames per second, and the last frame's wall time in ms. */
  fps = 0;
  frameMs = 16.7;
  /** CPU time of the last frame's update and render submit, ms (the GPU runs on after this; see docs/perf.md). */
  cpuMs = 0;
  frame = 0;
  private systems: System[] = [];
  private last = 0;
  private raf = 0;
  private tierListeners: Array<(t: Tier) => void> = [];
  paused = false;
  /** The full-screen map covers the view: the scene is not drawn (the systems still run). */
  renderPaused = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    params: URLSearchParams,
  ) {
    this.params = params;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    // Multisampling is the costliest default on a phone's tile-based GPU: off on touch devices and on Low.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse && params.get('graphics') !== 'low', powerPreference: 'high-performance' });
    // The scene never moves. With the default (an automatic matrix) it re-composes itself every frame, which marks its
    // world matrix as changed, and three.js then recomputes the world matrix of every object under it, thousands of
    // multiplications for a scene whose parts nearly all stand still. The things that do move set their own flag.
    this.scene.matrixAutoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.tier = pickTier(params, coarse, this.gpuName);
    this.governor.enabled = !params.get('graphics') && params.get('governor') !== '0';
    this.input = new Input(canvas);
    this.applyTier(this.tier);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  addSystem<T extends System>(s: T): T {
    this.systems.push(s);
    this.systems.sort((a, b) => a.priority - b.priority);
    return s;
  }

  onTierChange(fn: (t: Tier) => void) {
    this.tierListeners.push(fn);
  }

  applyTier(t: Tier) {
    this.tier = t;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.pixelRatio));
    this.renderer.shadowMap.enabled = t.shadowMap > 0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera.far = t.far;
    this.camera.updateProjectionMatrix();
    this.resize();
    for (const f of this.tierListeners) f(t);
  }

  /** The canvas size in CSS pixels, measured on resize. Read these rather than `clientWidth` in a frame: a layout read after the HUD's writes forces a synchronous reflow. */
  viewW = 1;
  viewH = 1;

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.viewW = w;
    this.viewH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    for (const s of this.systems) s.dispose?.();
  }

  /** One frame. Exposed for tests that drive frames by hand. */
  tick(now: number) {
    const rawMs = now - this.last;
    this.last = now;
    // A hidden tab can hand back one huge step; the sim keeps its own time, so just clamp ours.
    const dt = Math.min(rawMs, 100) / 1000;
    this.frameMs = rawMs;
    this.fps += (1000 / Math.max(rawMs, 0.1) - this.fps) * Math.min(1, dt * 4 + 0.02);
    this.frame++;

    const cpu0 = performance.now();
    this.input.beginFrame(dt);
    for (const s of this.systems) s.update?.(dt);
    for (const s of this.systems) s.lateUpdate?.(dt);
    // (about twice a second: instanced casters get a depth material of their own kind, see depthMaterials.ts)
    if ((this.frame & 31) === 0 && this.renderer.shadowMap.enabled) ownDepthAll(this.scene);
    if (!this.renderPaused) this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
    this.cpuMs = performance.now() - cpu0;

    if (this.governor.update(rawMs, dt)) {
      const below = tierBelow(this.tier.name);
      if (below) this.applyTier(TIERS[below]);
    }
  }
}
