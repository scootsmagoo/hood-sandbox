/**
 * The radar: a GTA-style circle at the bottom left. The roads of the tile are pre-rendered once into
 * an offscreen atlas (1 px per metre, the tile's bounds); every frame the radar blits a rotated
 * window of it, then draws the blips (the player, police, empty cars, a helicopter, the wanted
 * search area) on top. Heading is the camera's, and the zoom widens with speed.
 *
 * Data: the road centrelines come from the tile's roads.json, read here (the client has no other
 * copy). Police, heat, the search area (last known position and radius, in the snapshot header),
 * helicopters, roadblock cars and spike strips all come from the snapshot.
 */
import { yawOfQuat } from '../../shared/math';
import { EntityKind } from '../../shared/entities';
import type { EntityDef } from '../../shared/entityDefs';
import { parseRoads, type RoadData } from '../../shared/tile';
import { officerCone } from '../../shared/policeRules';
import { HeatPhase, HeliFlag, PedFlag, VehicleFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import { mapLayers, type RadarView } from './map/layers';
import {
  flashPhase,
  facingVector,
  headingVector,
  radarTransform,
  withinRange,
  worldToRadar,
  zoomForSpeed,
  SPAN_REST_M,
} from './minimapMath';

/** Road atlas resolution: pixels per metre. */
const ATLAS_PX_PER_M = 1;
/** A streamed city's per-tile atlases: half a pixel a metre. */
const STREAM_PX_PER_M = 0.5;
const SIZE_DESKTOP = 180;
const SIZE_PHONE = 132;
/** Gap from the radar to the screen edge, css px (the left edge is the HUD's 12 px gutter). */
const RADAR_INSET = 14;
const LEFT_INSET = 12;

/** The radar's diameter in css px: smaller on a phone (a coarse pointer). */
export function radarSize(): number {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? SIZE_PHONE : SIZE_DESKTOP;
}

/** The bottom edge of the bars above the radar, css px (what the HUD lifts its bars to). */
export function radarTop(): number {
  return radarSize() + RADAR_INSET + 12;
}

const COLOR_BG = 'rgba(12, 14, 17, 0.8)';
const COLOR_RIM = 'rgba(255, 255, 255, 0.35)';
const COLOR_PLAYER = '#f4f4ef';
const COLOR_EMPTY_CAR = 'rgba(170, 176, 184, 0.75)';
const COLOR_HELI = '#e7f3ff';
const COLOR_POLICE_RED = '#ff3b30';
const COLOR_POLICE_BLUE = '#3a7bff';
const COLOR_CONE = 'rgba(255, 70, 60, 0.1)';
const COLOR_CONE_SEEN = 'rgba(255, 70, 60, 0.26)';
const COLOR_STRIP = '#ffd24a';
const COLOR_BLOCK = '#ff6a3a';
const COLOR_SEARCH_FILL = 'rgba(255, 190, 60, 0.16)';
const COLOR_SEARCH_LINE = 'rgba(255, 190, 60, 0.9)';

/** Road colour, draw order (higher on top) and width factor, by class. */
const ROAD_STYLE: Record<string, { rank: number; color: string; scale: number }> = {
  motorway: { rank: 5, color: '#f3c969', scale: 0.9 },
  trunk: { rank: 4, color: '#e7b35a', scale: 0.85 },
  primary: { rank: 3, color: '#cfd5dc', scale: 0.8 },
  secondary: { rank: 2, color: '#aeb7c1', scale: 0.75 },
  tertiary: { rank: 1, color: '#8f99a5', scale: 0.7 },
};
const ROAD_DEFAULT = { rank: 0, color: '#5a636e', scale: 0.6 };

function roadStyle(cls: string) {
  const base = cls.endsWith('_link') ? cls.slice(0, -5) : cls;
  return ROAD_STYLE[base] ?? ROAD_DEFAULT;
}

/** Scratch objects, reused every frame so the radar allocates nothing per frame. */
const tmp = { x: 0, y: 0 };
const NO_DASH: number[] = [];

declare module '../Game' {
  interface Game {
    minimap?: Minimap;
  }
}

export class Minimap implements System {
  readonly name = 'minimap';
  readonly priority = 205;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private readonly dpr: number;
  private atlas: HTMLCanvasElement | null = null;
  /** A streamed city's atlases, one per loaded tile (`setRoadTiles`), at `STREAM_PX_PER_M`. */
  private tileAtlases = new Map<string, { canvas: HTMLCanvasElement; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } }>();
  private span = SPAN_REST_M;
  private readonly tf = new Float64Array(6);
  private readonly fwd = new Float64Array(2);
  private readonly pf = new Float64Array(2);
  private readonly dash = new Float64Array(2);
  /** This frame's camera forward, zoom and player position, read by `place`. */
  private fx = 0;
  private fz = 0;
  private pxPerM = 1;
  private ox = 0;
  private oz = 0;
  private drawn = false;
  private lastX = 0;
  private lastZ = 0;
  private lastYaw = 0;
  private lastFacing = 0;
  private lastDraw = 0;
  private disposed = false;
  /** What map layers (the GPS route, the waypoint, transit lines) are handed to draw with; refilled every frame. */
  private readonly radarView: RadarView;
  private layersRev = -1;

  constructor(
    private readonly game: Game,
    tileBase: string | null,
  ) {
    game.minimap = this;
    this.size = radarSize();
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-radar';
    this.canvas.width = this.canvas.height = Math.round(this.size * this.dpr);
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: `${LEFT_INSET}px`,
      bottom: `${RADAR_INSET}px`,
      width: `${this.size}px`,
      height: `${this.size}px`,
    });
    (document.getElementById('hud') ?? document.body).appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.font = `bold ${Math.round(11 * this.dpr)}px system-ui, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.radarView = { ctx: this.ctx, cx: 0, cy: 0, R: 0, dpr: this.dpr, pxPerM: 1, span: SPAN_REST_M, ox: 0, oz: 0, place: (x, z, out) => (this.place(x, z), (out.x = tmp.x), (out.y = tmp.y), out) };
    // A click on the radar opens the full-screen map (a one-button mouse needs no key for it).
    Object.assign(this.canvas.style, { pointerEvents: 'auto', cursor: 'pointer' });
    this.canvas.addEventListener("click", () => this.game.bigMap?.open());

    void this.loadRoads(tileBase);
  }

  /** Reads roads.json and pre-renders it. Without roads (or on a failed read) the radar still shows blips. */
  private async loadRoads(tileBase: string | null) {
    if (!tileBase) return;
    try {
      const tile = this.game.ready.tile;
      const res = await fetch(new URL(tile.roads ?? 'roads.json', tileBase).href);
      if (!res.ok || this.disposed) return;
      const roads = parseRoads(await res.json());
      if (!this.disposed) this.atlas = this.buildAtlas(roads);
    } catch {
      /* no roads: the radar still works */
    }
  }

  /**
   * A streamed city (docs/contracts/city-tiles.md): the roads of each loaded tile, by tile. An atlas is drawn for each new tile (half
   * a pixel a metre: 1 MB for a 1 km tile) and dropped with it.
   */
  setRoadTiles(tiles: readonly { id: string; bounds: { minX: number; minZ: number; maxX: number; maxZ: number }; roads: RoadData[] }[]) {
    const want = new Set(tiles.map((t) => t.id));
    for (const id of [...this.tileAtlases.keys()]) if (!want.has(id)) this.tileAtlases.delete(id);
    for (const t of tiles) if (!this.tileAtlases.has(t.id)) this.tileAtlases.set(t.id, { canvas: this.buildAtlas(t.roads, t.bounds, STREAM_PX_PER_M), bounds: t.bounds });
    this.drawn = false;
  }

  private buildAtlas(roads: RoadData[], bounds?: { minX: number; minZ: number; maxX: number; maxZ: number }, A = ATLAS_PX_PER_M): HTMLCanvasElement {
    const b = bounds ?? this.game.ready.tile.bounds;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((b.maxX - b.minX) * A));
    c.height = Math.max(1, Math.ceil((b.maxZ - b.minZ) * A));
    const g = c.getContext('2d')!;
    // Metres in, pixels out: the atlas's pixel (0, 0) is the bounds' north-west corner.
    g.setTransform(A, 0, 0, A, -b.minX * A, -b.minZ * A);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Minor roads first, freeways last so they sit on top.
    for (let rank = 0; rank <= 5; rank++) {
      for (const r of roads) {
        const style = roadStyle(r.class);
        if (style.rank !== rank) continue;
        g.strokeStyle = style.color;
        g.lineWidth = Math.max(r.width * style.scale, 1.2 / A);
        g.beginPath();
        const p = r.points;
        g.moveTo(p[0][0], p[0][2]);
        for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][2]);
        g.stroke();
      }
    }
    return c;
  }

  update(dt: number) {
    const g = this.game;
    const v = g.view;
    const st = v.controlled;
    if (!st || !v.sample) {
      if (this.drawn) this.clear();
      return;
    }
    // Standing still with the camera still and no heat, nothing on the radar moves (only parked cars, and they are redrawn
    // four times a second): the canvas keeps the last picture and the page does not repaint it.
    const now = performance.now();
    const facing = yawOfQuat(st.q);
    const still =
      this.drawn &&
      v.heat < 1 &&
      Math.abs(st.x - this.lastX) < 0.02 &&
      Math.abs(st.z - this.lastZ) < 0.02 &&
      Math.abs(g.cameraArm.yaw - this.lastYaw) < 0.0004 &&
      Math.abs(facing - this.lastFacing) < 0.0004 &&
      Math.abs(zoomForSpeed(Math.hypot(st.vx, st.vz)) - this.span) < 0.05 &&
      this.layersRev === mapLayers(g).revision;
    if (still && now - this.lastDraw < 250) return;
    this.lastX = st.x;
    this.lastZ = st.z;
    this.lastYaw = g.cameraArm.yaw;
    this.lastFacing = facing;
    this.lastDraw = now;
    this.drawn = true;
    const dpr = this.dpr;
    const S = this.canvas.width;
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - 2 * dpr;

    // Heading: the camera's, so the top of the radar is where the camera looks.
    const f = headingVector(g.cameraArm.yaw, this.fwd);
    const fx = f[0];
    const fz = f[1];
    this.fx = fx;
    this.fz = fz;
    this.ox = st.x;
    this.oz = st.z;

    // Zoom eases toward the target span for the speed.
    const speed = Math.hypot(st.vx, st.vz);
    this.span += (zoomForSpeed(speed) - this.span) * Math.min(1, dt * 2.5);
    const span = this.span;
    const pxPerM = R / span;
    this.pxPerM = pxPerM;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);

    // The disc, then the roads clipped to it.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_BG;
    ctx.fill();
    ctx.save();
    ctx.clip();
    if (this.atlas) {
      const A = ATLAS_PX_PER_M;
      const b = g.ready.tile.bounds;
      const ax = (st.x - b.minX) * A;
      const ay = (st.z - b.minZ) * A;
      // Only the square that covers the rotated disc is drawn, clipped to the atlas.
      const h = span * Math.SQRT2 * A;
      const x0 = Math.max(0, ax - h);
      const y0 = Math.max(0, ay - h);
      const x1 = Math.min(this.atlas.width, ax + h);
      const y1 = Math.min(this.atlas.height, ay + h);
      if (x1 > x0 && y1 > y0) {
        radarTransform(fx, fz, ax, ay, cx, cy, pxPerM / A, this.tf);
        ctx.setTransform(this.tf[0], this.tf[1], this.tf[2], this.tf[3], this.tf[4], this.tf[5]);
        ctx.drawImage(this.atlas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    for (const t of this.tileAtlases.values()) {
      const A = STREAM_PX_PER_M;
      const b = t.bounds;
      const ax = (st.x - b.minX) * A;
      const ay = (st.z - b.minZ) * A;
      const h = span * Math.SQRT2 * A;
      const x0 = Math.max(0, ax - h);
      const y0 = Math.max(0, ay - h);
      const x1 = Math.min(t.canvas.width, ax + h);
      const y1 = Math.min(t.canvas.height, ay + h);
      if (x1 <= x0 || y1 <= y0) continue;
      radarTransform(fx, fz, ax, ay, cx, cy, pxPerM / A, this.tf);
      ctx.setTransform(this.tf[0], this.tf[1], this.tf[2], this.tf[3], this.tf[4], this.tf[5]);
      ctx.drawImage(t.canvas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Map layers (the GPS route and waypoint, transit lines): over the roads, under the police.
    const rv = this.radarView;
    rv.cx = cx;
    rv.cy = cy;
    rv.R = R;
    rv.pxPerM = pxPerM;
    rv.span = span;
    rv.ox = st.x;
    rv.oz = st.z;
    const layers = mapLayers(g);
    this.layersRev = layers.revision;
    layers.drawRadar(rv);

    const heatOn = v.heat >= 1;
    const flash = flashPhase(performance.now());

    // Wanted search area: the sim sends where the police think you are and how far they are sweeping (it grows while they have lost you).
    if (heatOn && v.searchR > 0 && (v.heatPhase === HeatPhase.Lost || v.heatPhase === HeatPhase.Reported)) {
      this.place(v.searchX, v.searchZ);
      ctx.beginPath();
      ctx.arc(cx + tmp.x, cy + tmp.y, v.searchR * pxPerM, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_SEARCH_FILL;
      ctx.fill();
      this.dash[0] = 4 * dpr;
      this.dash[1] = 3 * dpr;
      ctx.setLineDash(this.dash);
      ctx.strokeStyle = COLOR_SEARCH_LINE;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }

    // Vision cones of the police units (only once the police know there is heat).
    if (heatOn) {
      for (const e of v.entities.values()) {
        if (e === st || e.id === v.ped?.id) continue;
        const police = e.kind === EntityKind.Ped ? (e.flags & PedFlag.Police) !== 0 : (e.flags & VehicleFlag.Police) !== 0;
        // (the real cone the police see through: `officerCone`, wider from inside a car)
        const cone = officerCone(e.x, e.z, 0, e.kind === EntityKind.Vehicle);
        if (!police || !withinRange(e.x - st.x, e.z - st.z, span + cone.range)) continue;
        // Roadblock cars and parked units do not look anywhere.
        if (e.kind === EntityKind.Vehicle && (e.flags & VehicleFlag.Roadblock) !== 0) continue;
        const yaw = e.kind === EntityKind.Ped ? e.aux0 : yawOfQuat(e.q);
        const p = headingVector(yaw, this.pf);
        // The cone axis as a radar direction; its angle is the arc centre.
        worldToRadar(p[0], p[1], fx, fz, 1, tmp);
        const angle = Math.atan2(tmp.y, tmp.x);
        this.place(e.x, e.z);
        const bx = cx + tmp.x;
        const by = cy + tmp.y;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.arc(bx, by, cone.range * pxPerM, angle - cone.halfAngle, angle + cone.halfAngle);
        ctx.closePath();
        ctx.fillStyle = e.kind === EntityKind.Ped && (e.flags & PedFlag.Sees) !== 0 ? COLOR_CONE_SEEN : COLOR_CONE;
        ctx.fill();
      }
    }

    // Other entities: police, helicopters and empty cars. While there is heat, police beyond the
    // rim are pinned to it, so you can see which way they are coming from.
    for (const e of v.entities.values()) {
      if (e === st || e.id === v.ped?.id) continue;
      const isPed = e.kind === EntityKind.Ped;
      const isCar = e.kind === EntityKind.Vehicle;
      if (e.kind === EntityKind.Helicopter || e.kind === EntityKind.SpikeStrip) {
        if (!heatOn || !withinRange(e.x - st.x, e.z - st.z, span + 20)) continue;
        this.place(e.x, e.z);
        const hx = cx + tmp.x;
        const hy = cy + tmp.y;
        if (e.kind === EntityKind.Helicopter) {
          // Its footprint on the ground (what its cone covers), brighter while it has the player.
          ctx.beginPath();
          ctx.arc(hx, hy, Math.max(2, e.aux2) * pxPerM, 0, Math.PI * 2);
          ctx.fillStyle = e.flags & HeliFlag.Sees ? COLOR_CONE_SEEN : COLOR_CONE;
          ctx.fill();
          this.helicopter(hx, hy, performance.now() * 0.03);
        } else {
          this.dot(hx, hy, 2.4 * dpr, COLOR_STRIP);
        }
        continue;
      }
      if (!isPed && !isCar) continue;
      const police = isPed ? (e.flags & PedFlag.Police) !== 0 : (e.flags & VehicleFlag.Police) !== 0;
      const inside = withinRange(e.x - st.x, e.z - st.z, span);
      if (!inside && !(heatOn && police)) continue;
      this.place(e.x, e.z);
      if (!inside) this.pinToRim(R - 4 * dpr);
      const x = cx + tmp.x;
      const y = cy + tmp.y;
      if (police) {
        const lightbar = isPed || (e.flags & VehicleFlag.Lightbar) !== 0;
        // A roadblock car is drawn square-ish in orange: you can see where the block is.
        const block = isCar && (e.flags & VehicleFlag.Roadblock) !== 0;
        this.dot(x, y, (isPed ? 3 : 4) * dpr, block ? COLOR_BLOCK : lightbar && flash ? COLOR_POLICE_RED : COLOR_POLICE_BLUE);
      } else if (isHelicopter(v.defs.get(e.id))) {
        // The rotor turns: the angle is only for show.
        this.helicopter(x, y, performance.now() * 0.03);
      } else if (!(e.flags & VehicleFlag.Occupied)) {
        this.dot(x, y, 2.2 * dpr, COLOR_EMPTY_CAR);
      }
    }
    ctx.restore();

    // The player: an arrow pointing where they face, relative to the camera.
    const pfv = facingVector(yawOfQuat(st.q), this.pf);
    worldToRadar(pfv[0], pfv[1], fx, fz, 1, tmp);
    this.arrow(cx, cy, Math.atan2(tmp.x, -tmp.y), 11 * dpr);

    // Rim and the north marker.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = COLOR_RIM;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    worldToRadar(0, -1, fx, fz, 1, tmp);
    const nx = cx + tmp.x * (R - 9 * dpr);
    const ny = cy + tmp.y * (R - 9 * dpr);
    ctx.fillStyle = '#ff6b5e';
    ctx.fillText('N', nx, ny);
  }

  /** Redraws on the next frame even if nothing on the radar moved (a layer changed). */
  invalidate() {
    this.drawn = false;
  }

  private clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = false;
  }

  /** A world point as a radar point (device px, relative to the centre), into `tmp`. */
  private place(x: number, z: number) {
    worldToRadar(x - this.ox, z - this.oz, this.fx, this.fz, this.pxPerM, tmp);
  }

  /** Moves the point in `tmp` out to radius `r` along its own direction. */
  private pinToRim(r: number) {
    const len = Math.hypot(tmp.x, tmp.y);
    if (len < 1e-6) return;
    tmp.x = (tmp.x / len) * r;
    tmp.y = (tmp.y / len) * r;
  }

  private dot(x: number, y: number, r: number, color: string) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** A rotor glyph: a small ring with two blades. Drawn in place, no allocation. */
  private helicopter(x: number, y: number, angle: number) {
    const ctx = this.ctx;
    const r = 4 * this.dpr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_HELI;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - r * 2.2 * Math.cos(angle), y - r * 2.2 * Math.sin(angle));
    ctx.lineTo(x + r * 2.2 * Math.cos(angle), y + r * 2.2 * Math.sin(angle));
    ctx.strokeStyle = COLOR_HELI;
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.stroke();
  }

  private arrow(x: number, y: number, angle: number, s: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.72, s * 0.8);
    ctx.lineTo(0, s * 0.4);
    ctx.lineTo(-s * 0.72, s * 0.8);
    ctx.closePath();
    ctx.fillStyle = COLOR_PLAYER;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  dispose() {
    this.disposed = true;
    this.canvas.remove();
    this.atlas = null;
  }
}

/** A vehicle whose definition says it is a helicopter (none spawns yet; the shape is ready for it). */
function isHelicopter(def: EntityDef | undefined): boolean {
  return !!def && def.kind === EntityKind.Vehicle && (def as { typeId?: string }).typeId === 'helicopter';
}
