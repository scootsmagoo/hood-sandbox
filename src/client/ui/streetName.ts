/**
 * The street-name indicator: a two-line label beside the radar. The street (bold) is the nearest
 * named road centreline, the neighbourhood (dimmer) is the zone of the city pack's population.json
 * that holds the player. Both switch only after the new name has held for a moment (streetNameMath.ts),
 * and the label fades in when the street changes.
 *
 * Data: the roads come from the tile's roads.json, the zones from the city pack picked by the tile
 * id (the same `import.meta.glob` approach as src/sim/law/cityPack.ts, so the client names no city).
 */
import { yawOfQuat } from '../../shared/math';
import { parseRoads } from '../../shared/tile';
import { cityOfTile } from '../../shared/law';
import type { Game, System } from '../Game';
import { landmarkAt, parseLandmarks, type LandmarkEntry } from '../../shared/landmarks';
import { facingVector } from './minimapMath';
import { radarSize } from './minimap';
import {
  Debounced,
  Settled,
  TRAVEL_MIN_MPS,
  abbreviateStreet,
  buildStreetIndex,
  nearestNamedRoad,
  zoneIndexAt,
  type StreetIndex,
  type ZoneShape,
} from './streetNameMath';

const populations = import.meta.glob('/data/cities/*/population.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

/** The zones of the city pack for a tile id (none when the city has no pack). */
async function loadZones(tileId: string): Promise<ZoneShape[]> {
  const city = cityOfTile(tileId);
  const load = city ? populations[`/data/cities/${city}/population.json`] : undefined;
  if (!load) return [];
  const data = (await load()) as { zones?: ZoneShape[] };
  return (data.zones ?? []).filter((z) => z.default || Array.isArray(z.polygon));
}

/** Layout, in css px: the same left gutter as the radar, and the label beside it. */
const LEFT_INSET = 12;
const GAP = 12;
const BOTTOM = 14;

export class StreetName implements System {
  readonly name = 'street-name';
  readonly priority = 201;
  private readonly el: HTMLElement;
  private readonly streetEl: HTMLElement;
  private readonly areaEl: HTMLElement;
  private index: StreetIndex | null = null;
  private zones: ZoneShape[] = [];
  /** The tile's landmarks (landmarks.json: the city pack's, with the heroes' footprints); the area line shows the one you are at. */
  private landmarks: LandmarkEntry[] = [];
  private readonly landmark = new Settled<string>();
  private readonly street = new Debounced<string>();
  private readonly zone = new Debounced<string>();
  /** The text on screen, so the DOM is only touched on a change. */
  private shownStreet = '';
  private shownArea = '';
  private readonly facing = new Float64Array(2);
  private disposed = false;

  constructor(
    private readonly game: Game,
    tileBase: string | null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud-street';
    this.el.setAttribute('aria-live', 'polite');
    Object.assign(this.el.style, {
      position: 'absolute',
      left: `${LEFT_INSET + radarSize() + GAP}px`,
      bottom: `${BOTTOM}px`,
      display: 'none',
      maxWidth: 'min(280px, 60vw)',
      padding: '5px 10px',
      borderRadius: '6px',
      background: 'var(--panel)',
      color: 'var(--ink)',
      lineHeight: '1.25',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    this.streetEl = document.createElement('div');
    Object.assign(this.streetEl.style, { fontWeight: '700', fontSize: '15px', letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis' });
    this.areaEl = document.createElement('div');
    Object.assign(this.areaEl.style, { color: 'var(--dim)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' });
    this.areaEl.hidden = true;
    this.el.append(this.streetEl, this.areaEl);
    (document.getElementById('hud') ?? document.body).appendChild(this.el);

    void this.load(tileBase);
  }

  /** Reads the roads and the zones. Without them the label still shows what it can (or nothing). */
  private async load(tileBase: string | null) {
    if (!tileBase) return;
    const tile = this.game.ready.tile;
    const [roads, zones, landmarks] = await Promise.all([
      fetch(new URL(tile.roads ?? 'roads.json', tileBase).href)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => (json ? parseRoads(json) : []))
        .catch(() => []),
      loadZones(tile.id).catch(() => []),
      tile.landmarks
        ? fetch(new URL(tile.landmarks, tileBase).href)
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => parseLandmarks(json)?.landmarks ?? [])
            .catch(() => [])
        : Promise.resolve([] as LandmarkEntry[]),
    ]);
    if (this.disposed) return;
    this.index = buildStreetIndex(roads);
    this.zones = zones;
    this.landmarks = landmarks;
  }

  /** A streamed city: the street index of the loaded tiles' roads (rebuilt when they change), and the city pack's zones. */
  setRoads(roads: Parameters<typeof buildStreetIndex>[0], cityId?: string) {
    this.index = buildStreetIndex(roads);
    if (cityId && !this.zonesLoaded) {
      this.zonesLoaded = true;
      void loadZones(cityId).then((z) => (this.zones = z)).catch(() => {});
    }
  }

  private zonesLoaded = false;

  /** A streamed city: the landmarks of the loaded tiles (their landmarks.json, the heroes' footprints and the named places inside them). */
  setLandmarks(list: LandmarkEntry[]) {
    this.landmarks = list;
  }

  update(_dt: number) {
    const v = this.game.view;
    const st = v.controlled;
    if (this.disposed || !st || !v.sample || !this.index) return;
    const now = performance.now();

    // The direction of travel: the velocity when moving, the facing when standing still.
    let tx = st.vx;
    let tz = st.vz;
    if (Math.hypot(tx, tz) < TRAVEL_MIN_MPS) {
      const f = facingVector(yawOfQuat(st.q), this.facing);
      tx = f[0];
      tz = f[1];
    }

    const r = nearestNamedRoad(this.index, st.x, st.y, st.z, tx, tz);
    this.street.offer(r >= 0 ? abbreviateStreet(this.index.names[r]) : null, now);

    const zi = zoneIndexAt(this.zones, st.x, st.z);
    this.zone.offer(zi >= 0 ? this.zones[zi].name : null, now);
    // at a landmark (inside its footprint or within its radius): its name takes the area line, "Peachtree St NW" over "Peachtree Summit Plaza"
    // in a station (render/transit): its name takes the area line too, "Peachtree St NW" over "Peachtree Center station"
    const tv = this.game.transit;
    const si = tv && !tv.broken ? tv.stationOfPlayer() : -1;
    const sname = si >= 0 ? tv!.data.stations[si]?.displayName : undefined;
    const station = sname ? `${sname} station` : null;
    this.landmark.offer(station ?? (this.landmarks.length ? (landmarkAt(this.landmarks, st.x, st.z)?.displayName ?? null) : null), now);

    this.render();
  }

  /** Puts the shown names on the label. A street change fades the label in. */
  private render() {
    const landmark = this.landmark.value;
    // away from every named road the landmark itself is the label
    const street = this.street.value ?? landmark ?? undefined;
    if (street === undefined) {
      if (this.el.style.display !== 'none') this.el.style.display = 'none';
      return;
    }
    const area = (this.street.value !== undefined ? landmark : null) ?? this.zone.value ?? '';
    if (this.el.style.display === 'none') this.el.style.display = '';
    if (street !== this.shownStreet) {
      this.shownStreet = street;
      this.streetEl.textContent = street;
      this.fadeIn();
    }
    if (area !== this.shownArea) {
      this.shownArea = area;
      this.areaEl.textContent = area;
      this.areaEl.hidden = area === '';
    }
  }

  private fadeIn() {
    if (typeof this.el.animate !== 'function') return;
    this.el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], {
      duration: 500,
      easing: 'ease-out',
    });
  }

  dispose() {
    this.disposed = true;
    this.el.remove();
  }
}
