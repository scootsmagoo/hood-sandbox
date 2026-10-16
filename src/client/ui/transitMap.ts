/**
 * The rail lines on the radar and on the full-screen map: a map layer (map/layers.ts). Each line in its colour (lines that share
 * a track side by side), the stations as white discs with their names. The polylines are thinned once at load (a point every
 * 12 m) and drawn from preallocated scratch, so a frame allocates nothing.
 */
import type { TransitData } from '../../shared/transit';
import type { Game } from '../Game';
import { mapLayers, type BigMapView, type RadarView } from './map/layers';

interface LinePath {
  colour: string;
  /** flat x, z, already offset to the line's side of a shared track */
  pts: Float32Array;
}

const out = { x: 0, y: 0 };
const out2 = { x: 0, y: 0 };

export class TransitMapLayer {
  private readonly lines: LinePath[] = [];
  private readonly stations: { x: number; z: number; name: string }[] = [];
  private readonly remove: () => void;

  constructor(game: Game, data: TransitData) {
    const drawn = new Set<number>();
    for (const r of data.routes) {
      // one direction of each line: the two run side by side
      if (drawn.has(r.line)) continue;
      drawn.add(r.line);
      const share = data.routes.some((q) => q.line !== r.line && Math.abs(q.len - r.len) < 30 && Math.hypot(q.pts[0] - r.pts[0], q.pts[2] - r.pts[2]) < 30);
      const off = share ? (r.line % 2 ? 1 : -1) * 3 : 0;
      const pts: number[] = [];
      let last = -Infinity;
      for (let i = 0; i < r.cum.length; i++) {
        if (r.cum[i] - last < 12 && i < r.cum.length - 1) continue;
        last = r.cum[i];
        const j = Math.min(r.cum.length - 1, i + 1), k = Math.max(0, i - 1);
        const dx = r.pts[j * 3] - r.pts[k * 3], dz = r.pts[j * 3 + 2] - r.pts[k * 3 + 2];
        const l = Math.hypot(dx, dz) || 1;
        pts.push(r.pts[i * 3] + (dz / l) * off, r.pts[i * 3 + 2] - (dx / l) * off);
      }
      this.lines.push({ colour: data.lines[r.line]?.colour ?? '#888888', pts: Float32Array.from(pts) });
    }
    for (const st of data.stations) {
      const p = st.platforms[0];
      this.stations.push({ x: p ? p.c[0] : st.x, z: p ? p.c[1] : st.z, name: st.displayName });
    }
    this.remove = mapLayers(game).add({ id: 'transit', order: 40, radar: (v) => this.radar(v), bigMap: (v) => this.bigMap(v) });
  }

  private radar(v: RadarView): void {
    const g = v.ctx;
    const reach = v.span * 1.6;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2 * v.dpr, 3.2 * v.pxPerM);
    g.globalAlpha = 0.9;
    for (const ln of this.lines) {
      g.strokeStyle = ln.colour;
      g.beginPath();
      let pen = false;
      for (let i = 0; i < ln.pts.length; i += 2) {
        const x = ln.pts[i], z = ln.pts[i + 1];
        if (Math.abs(x - v.ox) > reach || Math.abs(z - v.oz) > reach) {
          pen = false;
          continue;
        }
        v.place(x, z, out);
        if (pen) g.lineTo(v.cx + out.x, v.cy + out.y);
        else g.moveTo(v.cx + out.x, v.cy + out.y);
        pen = true;
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#15181c';
    g.lineWidth = 1.5 * v.dpr;
    for (const s of this.stations) {
      if (Math.abs(s.x - v.ox) > reach || Math.abs(s.z - v.oz) > reach) continue;
      v.place(s.x, s.z, out);
      g.beginPath();
      g.arc(v.cx + out.x, v.cy + out.y, 4 * v.dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  private bigMap(v: BigMapView): void {
    const g = v.ctx;
    g.save();
    v.setWorld();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // a few pixels wide whatever the zoom
    g.lineWidth = Math.max(4, 3.5 / v.scale);
    g.globalAlpha = 0.92;
    for (const ln of this.lines) {
      g.strokeStyle = ln.colour;
      g.beginPath();
      for (let i = 0; i < ln.pts.length; i += 2) {
        if (i === 0) g.moveTo(ln.pts[i], ln.pts[i + 1]);
        else g.lineTo(ln.pts[i], ln.pts[i + 1]);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    v.setScreen();
    g.font = '600 12px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const s of this.stations) {
      if (s.x < v.minX - 50 || s.x > v.maxX + 50 || s.z < v.minZ - 50 || s.z > v.maxZ + 50) continue;
      v.toScreen(s.x, s.z, out2);
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#15181c';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(out2.x, out2.y, 6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(12, 14, 17, 0.85)';
      g.strokeText(s.name, out2.x + 10, out2.y);
      g.fillStyle = '#f2f1ec';
      g.fillText(s.name, out2.x + 10, out2.y);
    }
    g.restore();
  }

  dispose(): void {
    this.remove();
  }
}
