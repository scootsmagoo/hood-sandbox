/**
 * Map layers: the hook that lets a feature put something on the radar and on the full-screen map without editing either. The GPS
 * route and the waypoint are layers; so are, say, a rail line and its stations. A layer may draw on the radar (`radar`), on the map
 * (`bigMap`), or both; both are optional.
 *
 *   const layers = mapLayers(game);                 // one per game, made on first ask
 *   const remove = layers.add({
 *     id: 'transit',
 *     order: 40,                                    // ascending; roads are 0, the route is 100, the player's arrow is above them all
 *     radar(v)  { ... v.place(x, z, out) ... },     // inside the radar's circular clip; draw with v.ctx
 *     bigMap(v) { v.setWorld(); ...; v.setScreen(); ... },
 *   });
 *   layers.invalidate();                            // something changed that the radar would not otherwise redraw for
 *
 * Draw calls must not allocate (they run every frame): use the `out` parameters and keep scratch objects. Anything the radar draws
 * is inside a circular clip centred on the player; the big map's layers draw under the player's arrow and the police.
 */
import type { Game } from '../../Game';

export interface RadarView {
  readonly ctx: CanvasRenderingContext2D;
  /** The centre of the radar and its radius, device px. */
  cx: number;
  cy: number;
  R: number;
  /** Device pixels per CSS pixel. */
  dpr: number;
  /** Device pixels per metre, and the half width the radar shows, m. */
  pxPerM: number;
  span: number;
  /** The player, world frame. */
  ox: number;
  oz: number;
  /** A world point as radar px relative to the centre (the radar turns with the camera). */
  place(x: number, z: number, out: { x: number; y: number }): { x: number; y: number };
}

export interface BigMapView {
  readonly ctx: CanvasRenderingContext2D;
  /** Size in CSS px, and device pixels per CSS px. */
  w: number;
  h: number;
  dpr: number;
  /** CSS px per metre, and the world point at the centre of the map. */
  scale: number;
  cx: number;
  cz: number;
  /** The world rectangle on screen. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Milliseconds, for animation. */
  time: number;
  toScreen(x: number, z: number, out: { x: number; y: number }): { x: number; y: number };
  /** After this call the context draws in metres (x east, z south); line widths are metres. */
  setWorld(): void;
  /** After this call the context draws in CSS px. */
  setScreen(): void;
}

export interface MapLayer {
  id: string;
  order?: number;
  radar?(v: RadarView): void;
  bigMap?(v: BigMapView): void;
}

declare module '../../Game' {
  interface Game {
    mapLayers?: MapLayers;
  }
}

export class MapLayers {
  private list: MapLayer[] = [];
  /** Bumped by `invalidate`; the radar redraws when it sees it change. */
  revision = 0;
  private listeners = new Set<() => void>();

  add(layer: MapLayer): () => void {
    this.list = this.list.filter((l) => l.id !== layer.id);
    this.list.push(layer);
    this.list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this.invalidate();
    return () => this.remove(layer.id);
  }

  remove(id: string) {
    this.list = this.list.filter((l) => l.id !== id);
    this.invalidate();
  }

  get ids(): string[] {
    return this.list.map((l) => l.id);
  }

  drawRadar(v: RadarView) {
    for (const l of this.list) l.radar?.(v);
  }

  drawBigMap(v: BigMapView) {
    for (const l of this.list) l.bigMap?.(v);
  }

  /** The picture changed: the radar and the map redraw even if the player stands still. */
  invalidate() {
    this.revision++;
    for (const f of this.listeners) f();
  }

  onInvalidate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** The game's layer registry (made on first ask, so layers can be added before the radar exists). */
export function mapLayers(game: Game): MapLayers {
  return (game.mapLayers ??= new MapLayers());
}
