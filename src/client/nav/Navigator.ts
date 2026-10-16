/**
 * The GPS in the game: a system that owns the waypoint and its route and ties them to everything the player sees and hears.
 *
 *  - `NavCore` (pure) decides what to compute; `NavData` keeps its graphs in step with the loaded tiles.
 *  - The route and the waypoint are drawn on the radar and the full-screen map as a map layer (`navLayer`).
 *  - A beacon, a ring and a diamond stand over the waypoint in the world (`WaypointMarker`).
 *  - The turn prompt beside the radar says the next turn and the distance left (`NavPrompt`).
 *  - A chime sounds when a waypoint is set or cleared, and a bell on arrival; the last waypoint is remembered in localStorage.
 *
 * Nothing is fetched or computed until there is a waypoint or the map is open.
 */
import { yawOfQuat } from '../../shared/math';
import type { Game, System } from '../Game';
import { mapLayers } from '../ui/map/layers';
import { facingVector } from '../ui/minimapMath';
import { radarSize } from '../ui/minimap';
import { NavCore, type NavEvent, type NavPlayer } from './core';
import { NavData } from './navData';
import { createNavLayer } from './navLayer';
import { NavPrompt } from './NavPrompt';
import { formatDistance } from './route';
import type { NavSource } from './source';
import { WaypointMarker } from './WaypointMarker';

const STORAGE_KEY = 'hood-sandbox.waypoint';

declare module '../Game' {
  interface Game {
    nav?: Navigator;
  }
}

export class Navigator implements System {
  readonly name = 'nav';
  readonly priority = 150;
  readonly core = new NavCore();
  readonly data: NavData;
  readonly marker: WaypointMarker;
  readonly prompt: NavPrompt;
  /** The full-screen map is open (the graphs are then loaded even without a waypoint). */
  mapOpen = false;
  private readonly player: NavPlayer = { x: 0, y: 0, z: 0, heading: { x: 0, z: 1 }, inVehicle: false };
  private readonly fwd = new Float64Array(2);
  private pollAcc = 99;
  private restoring = false;
  private disposed = false;
  private readonly offLayer: () => void;
  private readonly offEvents: () => void;

  constructor(
    private readonly game: Game,
    readonly source: NavSource,
    /** The ids of the tiles that are loaded (and drawn) now. */
    private readonly loadedIds: () => string[],
    /** Identifies the city in the saved waypoint. */
    private readonly cityKey: string,
  ) {
    game.nav = this;
    this.data = new NavData(source, this.core);
    this.marker = new WaypointMarker(game.scene);
    const root = document.getElementById('hud') ?? document.body;
    // beside the radar, above the street name
    this.prompt = new NavPrompt(this.core, root, 12 + radarSize() + 12, 14 + 54);
    this.offLayer = mapLayers(game).add(createNavLayer(this.core));
    this.offEvents = this.core.on((e) => this.onEvent(e));
    void this.restore();
  }

  private onEvent(e: NavEvent) {
    const hud = this.game.hud;
    mapLayers(this.game).invalidate();
    this.game.minimap?.invalidate();
    switch (e.type) {
      case 'set':
        this.save();
        if (!this.restoring) {
          this.game.audio?.chime('set');
          hud?.toast(e.waypoint.name ? `Waypoint set · ${e.waypoint.name}` : 'Waypoint set', 1600);
        }
        break;
      case 'clear':
        this.save();
        if (e.reason === 'arrived') {
          this.game.audio?.chime('arrive');
          hud?.toast('You have arrived', 2600);
        } else this.game.audio?.chime('clear');
        break;
    }
  }

  /** Sets or clears a waypoint at a world point (a click on the map): near the waypoint it clears, elsewhere it sets. */
  toggleWaypointAt(x: number, z: number, nearM?: number): 'set' | 'cleared' {
    this.ensureLoaded();
    return this.core.toggleAt(x, z, nearM, this.game.view.controlled?.y ?? 0);
  }

  clearWaypoint() {
    this.core.clearWaypoint('user');
  }

  /** Loads the graphs of the loaded tiles now (the map opens). */
  ensureLoaded() {
    this.pollAcc = 99;
    this.pollTiles();
  }

  private pollTiles() {
    const ids = this.loadedIds();
    if (ids.length) this.data.setLoaded(ids);
  }

  update(dt: number) {
    if (this.disposed) return;
    const g = this.game;
    const core = this.core;
    const st = g.view.controlled;
    const wp = core.waypoint;
    if (wp || this.mapOpen) {
      this.pollAcc += dt;
      if (this.pollAcc >= 0.5) {
        this.pollAcc = 0;
        this.pollTiles();
      }
    }
    if (st && g.view.sample) {
      const p = this.player;
      p.x = st.x;
      p.y = st.y;
      p.z = st.z;
      p.inVehicle = g.view.inVehicle;
      if (p.inVehicle) {
        const f = facingVector(yawOfQuat(st.q), this.fwd);
        p.heading!.x = f[0];
        p.heading!.z = f[1];
      }
      core.update(dt, p);
    }
    if (core.waypoint) {
      const w = core.waypoint;
      this.marker.update(dt, w.x, w.snapped ? w.y : (st?.y ?? w.y), w.z, g.camera.position, g.camera.far);
    } else this.marker.hide();
    this.prompt.update(dt);
  }

  /** Metres from the player to the waypoint along the route (straight when there is no route), or null without a waypoint. */
  distanceLeft(): number | null {
    const w = this.core.waypoint;
    if (!w) return null;
    const t = this.core.track;
    if (this.core.route && t) return t.remaining;
    const st = this.game.view.controlled;
    return st ? Math.hypot(w.x - st.x, w.z - st.z) : null;
  }

  distanceText(): string {
    const d = this.distanceLeft();
    return d === null ? '' : formatDistance(d);
  }

  private save() {
    try {
      const w = this.core.waypoint;
      if (!w) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify({ k: this.cityKey, x: Math.round(w.x * 10) / 10, z: Math.round(w.z * 10) / 10 }));
    } catch {
      /* private window or blocked storage: the waypoint still works for this visit */
    }
  }

  /** Puts the last waypoint back (the same city, a place the map knows). */
  private async restore() {
    let saved: { k?: string; x?: number; z?: number } | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    if (!saved || saved.k !== this.cityKey || !Number.isFinite(saved.x) || !Number.isFinite(saved.z)) return;
    const { x, z } = saved as { x: number; z: number };
    const tile = this.source.tiles.find((t) => x >= t.bounds.minX && x <= t.bounds.maxX && z >= t.bounds.minZ && z <= t.bounds.maxZ);
    if (!tile) return;
    try {
      this.core.roads.setTile(tile.id, await this.source.roads(tile.id), 'nav');
    } catch {
      return;
    }
    if (this.disposed || this.core.waypoint) return;
    this.restoring = true;
    this.core.setWaypoint(x, z, this.game.view.controlled?.y ?? 0);
    this.restoring = false;
    this.ensureLoaded();
  }

  dispose() {
    this.disposed = true;
    this.offLayer();
    this.offEvents();
    this.data.dispose();
    this.marker.dispose();
    this.prompt.dispose();
  }
}
