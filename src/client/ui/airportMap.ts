/**
 * The airport on the radar and the full-screen map (through the map-layer hook, layers.ts): the aprons, the taxiways, the
 * runways with their centrelines, the terminal and concourse outlines, and on the big map the names (the runways, the terminals,
 * the concourses, the tower). Drawn from the city's `aeroway.json`; the paths are made once, in world metres, and drawn with the
 * view's transform (no allocation per frame).
 */
import type { AerowayData } from '../../shared/aeroway';
import type { Game } from '../Game';
import { mapLayers, type BigMapView, type RadarView } from './map/layers';

const APRON = 'rgba(150, 152, 160, 0.42)';
const TAXI = 'rgba(176, 178, 186, 0.75)';
const RUNWAY = 'rgba(52, 54, 60, 0.95)';
const RUNWAY_LINE = 'rgba(240, 240, 240, 0.9)';
const BUILDING = 'rgba(122, 132, 150, 0.95)';
const BUILDING_EDGE = 'rgba(210, 216, 228, 0.7)';

function ringPath(r: number[], p = new Path2D()): Path2D {
  for (let i = 0; i + 1 < r.length; i += 2) (i ? p.lineTo(r[i], r[i + 1]) : p.moveTo(r[i], r[i + 1]));
  p.closePath();
  return p;
}

export class AirportLayer {
  private readonly aprons = new Path2D();
  private readonly runways = new Path2D();
  private readonly centre = new Path2D();
  private readonly buildings = new Path2D();
  private readonly taxi: { w: number; path: Path2D }[] = [];
  private readonly labels: { name: string; x: number; z: number; kind: string }[];
  private readonly box: { minX: number; minZ: number; maxX: number; maxZ: number };
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };
  private readonly c = { x: 0, y: 0 };
  private readonly remove: () => void;

  constructor(game: Game, data: AerowayData) {
    const m = data.map;
    for (const r of m.aprons) ringPath(r, this.aprons);
    for (const r of m.runways) ringPath(r, this.runways);
    for (const rw of data.runways) {
      const [e0, e1] = rw.ends;
      this.centre.moveTo(e0.threshold[0], e0.threshold[2]);
      this.centre.lineTo(e1.threshold[0], e1.threshold[2]);
    }
    for (const bld of m.buildings) ringPath(bld.ring, this.buildings);
    // taxiways by width (a stroke width each)
    const byW = new Map<number, Path2D>();
    for (const t of m.taxiways) {
      const w = Math.round(t.w);
      let p = byW.get(w);
      if (!p) byW.set(w, (p = new Path2D()));
      for (let i = 0; i + 1 < t.pts.length; i += 2) (i ? p.lineTo(t.pts[i], t.pts[i + 1]) : p.moveTo(t.pts[i], t.pts[i + 1]));
    }
    for (const [w, path] of [...byW].sort((x, y) => x[0] - y[0])) this.taxi.push({ w, path });
    this.labels = m.labels;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const r of [...m.aprons, ...m.runways]) for (let i = 0; i + 1 < r.length; i += 2) {
      minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]); minZ = Math.min(minZ, r[i + 1]); maxZ = Math.max(maxZ, r[i + 1]);
    }
    this.box = { minX, minZ, maxX, maxZ };
    this.remove = mapLayers(game).add({ id: 'airport', order: -20, radar: (v) => this.radar(v), bigMap: (v) => this.bigMap(v) });
  }

  private draw(ctx: CanvasRenderingContext2D, pxPerM: number, detail: boolean) {
    ctx.fillStyle = APRON;
    ctx.fill(this.aprons);
    ctx.strokeStyle = TAXI;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const t of this.taxi) {
      ctx.lineWidth = Math.max(t.w, 1.5 / pxPerM);
      ctx.stroke(t.path);
    }
    ctx.fillStyle = RUNWAY;
    ctx.fill(this.runways);
    if (detail) {
      ctx.strokeStyle = RUNWAY_LINE;
      ctx.lineWidth = Math.max(1.2, 1 / pxPerM);
      ctx.setLineDash([36, 24]);
      ctx.stroke(this.centre);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = BUILDING;
    ctx.fill(this.buildings);
    ctx.strokeStyle = BUILDING_EDGE;
    ctx.lineWidth = 1 / pxPerM;
    ctx.stroke(this.buildings);
  }

  private radar(v: RadarView) {
    const span = v.span * 1.5;
    if (v.ox + span < this.box.minX || v.ox - span > this.box.maxX || v.oz + span < this.box.minZ || v.oz - span > this.box.maxZ) return;
    // the radar's transform from three placed points: (0,0), (1,0) and (0,1) metres from the player
    v.place(v.ox, v.oz, this.a);
    v.place(v.ox + 1, v.oz, this.b);
    v.place(v.ox, v.oz + 1, this.c);
    const ctx = v.ctx;
    ctx.save();
    const ax = v.cx + this.a.x, ay = v.cy + this.a.y;
    const ux = this.b.x - this.a.x, uy = this.b.y - this.a.y, wx = this.c.x - this.a.x, wy = this.c.y - this.a.y;
    ctx.setTransform(ux, uy, wx, wy, ax - ux * v.ox - wx * v.oz, ay - uy * v.ox - wy * v.oz);
    this.draw(ctx, v.pxPerM, v.pxPerM > 0.6);
    ctx.restore();
  }

  private bigMap(v: BigMapView) {
    if (v.maxX < this.box.minX || v.minX > this.box.maxX || v.maxZ < this.box.minZ || v.minZ > this.box.maxZ) return;
    const ctx = v.ctx;
    v.setWorld();
    this.draw(ctx, v.scale, v.scale > 0.15);
    v.setScreen();
    if (v.scale < 0.08) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of this.labels) {
      // (the buildings' names come from the landmarks the map labels itself: only the runways here)
      if (l.kind !== 'runway' || v.scale < 0.12) continue;
      v.toScreen(l.x, l.z, this.a);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10, 12, 16, 0.75)';
      ctx.strokeText(l.name, this.a.x, this.a.y);
      ctx.fillStyle = '#f3f3f3';
      ctx.fillText(l.name, this.a.x, this.a.y);
    }
    ctx.restore();
  }

  dispose() {
    this.remove();
  }
}
