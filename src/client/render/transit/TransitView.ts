/**
 * The transit layer on the client: the stations, tunnels and viaducts of `transit.glb` (the baked-light shell under the ground,
 * a lit structure in the open), the station kit at the anchors of `transit.json` (columns, benches, name signs, next-train
 * screens, fare gates, railings, lamps, entrance canopies and pylons, tunnel wall bays), the trains (TrainViews.ts), the wells of
 * the entrances cut out of the ground (groundHoles.ts), and the light: as the camera goes under the ground the sun and the sky
 * give way to the stations' own lamps (`lookState.interior`, applied by Atmosphere).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { colourNum, parseTransit, VolumeIndex, type TransitData } from '../../../shared/transit';
import { H, SnapFlag } from '../../../shared/snapshot';
import type { Game, System } from '../../Game';
import { lookState } from '../look/state';
import { lookMode } from '../../graphics';
import { nightFactor } from '../timeOfDay';
import { patchHoles, selectHoles } from './groundHoles';
import { mapTexture, nameSignTexture, pylonTexture, ScreenTexture } from './signs';
import { loadTransitAssets, type TransitAssets } from './transitAssets';
import { exteriorShellMaterial, interiorShellMaterial, INTERIOR, partMaterial } from './transitMaterials';
import { TrainViews } from './TrainViews';
import { TransitMapLayer } from '../../ui/transitMap';

declare module '../../Game' {
  interface Game {
    /** The transit layer's view, when the tile has one. */
    transit?: TransitView;
  }
}

/** Kit parts drawn from their far level everywhere (there are many and they are small). */
const FAR_PARTS = new Set(['tunnel_bay']);
/** A station's furniture is drawn within this of the camera, m (beyond it, it is under the ground or too small to see). */
const STATION_RANGE = 280;
const TUNNEL_RANGE = 360;

interface KitGroup {
  group: THREE.Group;
  x: number;
  z: number;
  range: number;
}

export class TransitView implements System {
  readonly name = 'transit';
  readonly priority = 145;
  readonly root = new THREE.Group();
  trains: TrainViews | null = null;
  readonly volumes: VolumeIndex;
  private readonly kitGroups: KitGroup[] = [];
  private readonly screens = new Map<number, ScreenTexture>();
  private screenT = 0;
  private holeT = 0;
  private patchT = 0;
  private interior = 0;

  private constructor(
    private readonly game: Game,
    readonly data: TransitData,
  ) {
    this.root.name = 'transit';
    this.volumes = new VolumeIndex(data.volumes);
    game.scene.add(this.root);
    game.transit = this;
  }

  /** Loads the tile's transit layer, or null when it has none. */
  static async load(game: Game, tileBase: string): Promise<TransitView | null> {
    const name = game.ready.tile.transit;
    if (!name) return null;
    let data: TransitData | null = null;
    try {
      const res = await fetch(new URL(name, tileBase).href);
      data = res.ok ? parseTransit(await res.json()) : null;
    } catch {
      data = null;
    }
    if (!data) return null;
    const view = new TransitView(game, data);
    // each part on its own: a part that fails leaves the others (and the game) as they are
    const [assets] = await Promise.all([loadTransitAssets(), view.loadShell(tileBase)]);
    view.guard('the station kit', () => view.buildKit(assets));
    if (assets.car) {
      view.guard('the trains', () => {
        view.trains = new TrainViews(game, data, assets.car!);
        view.carAsset = assets.car;
      });
    }
    view.guard('the map layer', () => (view.mapLayer = new TransitMapLayer(game, data)));
    return view;
  }

  carAsset: TransitAssets['car'] = null;
  private mapLayer: TransitMapLayer | null = null;
  /** Set when something of the transit view threw: it stops drawing and the rest of the game goes on. */
  broken = false;

  /** Runs `fn`; a throw is logged once and leaves the view off (never the game). */
  guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.warn(`transit: ${what} failed; the trains are off`, e);
      this.broken = true;
      this.root.visible = false;
      if (this.trains) this.trains.group.visible = false;
      lookState.interior = 0;
    }
  }

  private async loadShell(tileBase: string): Promise<void> {
    if (!this.data.mesh) return;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(new URL(this.data.mesh, tileBase).href);
      const int = interiorShellMaterial();
      const ext = exteriorShellMaterial();
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const old = mesh.material as THREE.Material;
        const interior = old.name === 'tr_int';
        mesh.material = interior ? int : ext;
        old.dispose();
        mesh.castShadow = !interior;
        mesh.receiveShadow = !interior;
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
      });
      gltf.scene.name = 'transit-shell';
      this.root.add(gltf.scene);
    } catch (e) {
      console.warn('transit: transit.glb did not load', e);
    }
  }

  /** The kit at its anchors: instanced, one group per station (and per stretch of tunnel), each drawn near the camera only. */
  private buildKit(assets: TransitAssets): void {
    const d = this.data;
    const shared = new Map<string, THREE.Material>();
    const mat = (name: string) => {
      let m = shared.get(name);
      if (!m) shared.set(name, (m = partMaterial(name, { car: false })));
      return m;
    };
    // per-station sign materials
    const signMats = d.stations.map((st) => partMaterial('tr_signface', { car: false, signTexture: nameSignTexture(st, d) }));
    const pylonMats = d.stations.map((st) => partMaterial('tr_signface', { car: false, signTexture: pylonTexture(st, d) }));
    const mapMats = d.stations.map((st) => partMaterial('tr_signface', { car: false, signTexture: mapTexture(st, d) }));
    const screenMats = d.stations.map((_, i) => {
      const s = new ScreenTexture();
      this.screens.set(i, s);
      return partMaterial('tr_screen', { car: false, signTexture: s.texture });
    });
    // group anchors by station (tunnels: by 256 m cell) and kind
    const groups = new Map<string, { station: number; kind: string; list: typeof d.anchors }>();
    for (const a of d.anchors) {
      const key = a.station >= 0 ? `s${a.station}|${a.kind}` : `t${Math.floor(a.x / 256)},${Math.floor(a.z / 256)}|${a.kind}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { station: a.station, kind: a.kind, list: [] }));
      g.list.push(a);
    }
    const holders = new Map<string, KitGroup>();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (const [key, g] of groups) {
      const part = assets.kit.get(g.kind);
      if (!part) continue;
      const lod = FAR_PARTS.has(g.kind) ? part.lods[part.lods.length - 1] : part.lods[0];
      const hk = key.split('|')[0];
      let h = holders.get(hk);
      if (!h) {
        const grp = new THREE.Group();
        grp.name = `transit-kit-${hk}`;
        const st = g.station >= 0 ? d.stations[g.station] : null;
        const cx = st ? st.x : g.list.reduce((a, b) => a + b.x, 0) / g.list.length;
        const cz = st ? st.z : g.list.reduce((a, b) => a + b.z, 0) / g.list.length;
        h = { group: grp, x: cx, z: cz, range: st ? STATION_RANGE : TUNNEL_RANGE };
        holders.set(hk, h);
        this.kitGroups.push(h);
        this.root.add(grp);
      }
      for (const [mname, geo] of lod) {
        let material: THREE.Material;
        if (mname === 'tr_signface') material = g.kind === 'pylon' ? pylonMats[g.station] ?? mat(mname) : g.kind === 'map_board' ? mapMats[g.station] ?? mat(mname) : signMats[g.station] ?? mat(mname);
        else if (mname === 'tr_screen') material = screenMats[g.station] ?? mat(mname);
        else material = mat(mname);
        const im = new THREE.InstancedMesh(geo, material, g.list.length);
        g.list.forEach((a, i) => {
          q.setFromAxisAngle(up, a.yaw);
          p.set(a.x, a.y, a.z);
          m4.compose(p, q, one);
          im.setMatrixAt(i, m4);
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = g.kind === 'canopy' || g.kind === 'pylon';
        im.receiveShadow = true;
        im.name = `kit_${g.kind}_${mname}`;
        h.group.add(im);
      }
    }
  }

  update(dt: number): void {
    if (this.broken) return;
    this.guard('the view', () => this.frame(dt));
  }

  private frame(dt: number): void {
    const g = this.game;
    const cam = g.camera.position;
    // the light under the ground
    const vi = this.volumes.at(cam.x, cam.y - 0.5, cam.z, 0.5);
    let target = vi >= 0 ? (this.data.volumes[vi].kind === 'interior' ? 1 : 0.35) : 0;
    const snap = g.view.sample?.b;
    if (snap && snap.u32[H.Flags] & SnapFlag.OnTrain && snap.u32[H.Flags] & SnapFlag.Underground && vi < 0) target = Math.max(target, 0.6);
    this.interior += (target - this.interior) * Math.min(1, dt * 2.5);
    lookState.interior = this.interior < 0.002 ? 0 : this.interior;
    INTERIOR.uNight.value = nightFactor(g.clockView?.minutes ?? 720);
    // the furniture near the camera only
    for (const k of this.kitGroups) k.group.visible = Math.hypot(k.x - cam.x, k.z - cam.z) < k.range;
    this.trains?.update();
    // the wells of the entrances
    this.holeT -= dt;
    if (this.holeT <= 0) {
      this.holeT = 0.25;
      selectHoles(this.data.holes, cam.x, cam.z);
    }
    this.patchT -= dt;
    if (this.patchT <= 0) {
      this.patchT = 2;
      const world = g.scene.getObjectByName('world');
      if (world) patchHoles(world, lookMode(g.params) === 'gta4');
    }
    this.screenT -= dt;
    if (this.screenT <= 0) {
      this.screenT = 0.5;
      this.updateScreens();
    }
  }

  /** The next-train screens of the player's station (from the snapshot header); the others show their standing message. */
  private updateScreens(): void {
    const s = this.game.view.sample?.b;
    if (!s) return;
    const info = s.u32[H.TransitInfo];
    const station = (info & 0xff) - 1;
    const routes = s.u32[H.EtaRoutes];
    for (const [i, scr] of this.screens) {
      if (i !== station) {
        scr.draw([]);
        continue;
      }
      const rows: [string, string, string][] = [];
      for (let k = 0; k < 2; k++) {
        const r = ((routes >>> (k * 8)) & 0xff) - 1;
        const eta = s.f32[k === 0 ? H.Eta0 : H.Eta1];
        if (r < 0 || eta < 0) continue;
        const route = this.data.routes[r];
        const line = this.data.lines[route.line];
        rows.push([line.colour, route.towards, etaText(eta)]);
      }
      scr.draw(rows);
    }
  }

  /** The station the player is in, by the snapshot (index), or -1. */
  stationOfPlayer(): number {
    const s = this.game.view.sample?.b;
    return s ? (s.u32[H.TransitInfo] & 0xff) - 1 : -1;
  }

  /** The line's colour as a number. */
  lineColour(line: number): number {
    return colourNum(this.data.lines[line]?.colour ?? '#888888');
  }

  dispose(): void {
    this.mapLayer?.dispose();
    this.trains?.dispose();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    lookState.interior = 0;
    if (this.game.transit === this) this.game.transit = undefined;
  }
}

/** "Arriving", "1 min", "4 min". */
export function etaText(s: number): string {
  if (s < 20) return 'NOW';
  return `${Math.max(1, Math.round(s / 60))} MIN`;
}
