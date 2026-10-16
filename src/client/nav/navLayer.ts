/**
 * The GPS as a map layer: the route as a bright line (with a dark casing so it reads on the pale freeways and the dark side streets)
 * and the waypoint's marker, drawn on the radar and on the full-screen map through `mapLayers` (src/client/ui/map/layers.ts).
 * Nothing here allocates per frame.
 */
import type { BigMapView, MapLayer, RadarView } from '../ui/map/layers';
import type { NavCore } from './core';
import type { Route } from './route';

export const ROUTE_COLOR = '#ff38d6';
export const ROUTE_CASING = 'rgba(30, 4, 36, 0.9)';
const ROUTE_DIM = 'rgba(255, 56, 214, 0.32)';

const pt = { x: 0, y: 0 };

/** A waypoint pin: a diamond with a white rim; `s` is its half size in px. */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pulse = 0) {
  if (pulse > 0) {
    ctx.beginPath();
    ctx.arc(x, y, s * (1.4 + pulse * 1.4), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 56, 214, ${0.35 * (1 - pulse)})`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(x, y - s * 1.25);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s * 1.25);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fillStyle = ROUTE_COLOR;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, s * 0.22);
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
}

export function createNavLayer(core: NavCore): MapLayer {
  return {
    id: 'gps',
    order: 100,
    radar(v: RadarView) {
      const route = core.route;
      const wp = core.waypoint;
      const ctx = v.ctx;
      const dpr = v.dpr;
      if (route && route.count > 0) {
        const s = core.track?.s ?? 0;
        const i0 = Math.max(0, route.indexAt(Math.max(0, s - 80)) - 1);
        const i1 = Math.min(route.count - 1, route.indexAt(s + v.span * 2.6) + 1);
        if (i1 > i0) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          for (let i = i0; i <= i1; i++) {
            v.place(route.xs[i], route.zs[i], pt);
            if (i === i0) ctx.moveTo(v.cx + pt.x, v.cy + pt.y);
            else ctx.lineTo(v.cx + pt.x, v.cy + pt.y);
          }
          ctx.strokeStyle = ROUTE_CASING;
          ctx.lineWidth = 6.6 * dpr;
          ctx.stroke();
          ctx.strokeStyle = ROUTE_COLOR;
          ctx.lineWidth = 3.6 * dpr;
          ctx.stroke();
        }
        if (route.tail && i1 >= route.count - 1) {
          v.place(route.xs[route.count - 1], route.zs[route.count - 1], pt);
          const tx = v.cx + pt.x, ty = v.cy + pt.y;
          v.place(route.tail.x, route.tail.z, pt);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(v.cx + pt.x, v.cy + pt.y);
          ctx.setLineDash(DASH_RADAR(dpr));
          ctx.strokeStyle = ROUTE_COLOR;
          ctx.lineWidth = 2.4 * dpr;
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
      }
      if (wp) {
        v.place(wp.x, wp.z, pt);
        const d = Math.hypot(pt.x, pt.y);
        const lim = v.R - 8 * dpr;
        if (d > lim) {
          // beyond the rim: pinned to it, pointing the way
          const k = lim / d;
          pt.x *= k;
          pt.y *= k;
        }
        drawPin(ctx, v.cx + pt.x, v.cy + pt.y, 5.5 * dpr);
      }
    },
    bigMap(v: BigMapView) {
      const route = core.route;
      const wp = core.waypoint;
      const ctx = v.ctx;
      if (route && route.count > 1) {
        const s = core.track?.s ?? 0;
        const mid = Math.min(route.count - 1, route.indexAt(s));
        v.setWorld();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const k = 1 / v.scale;
        strokeRange(ctx, route, 0, mid, ROUTE_CASING, 7.5 * k, ROUTE_DIM, 4.2 * k);
        strokeRange(ctx, route, mid, route.count - 1, ROUTE_CASING, 7.5 * k, ROUTE_COLOR, 4.2 * k);
        if (route.tail) {
          ctx.beginPath();
          ctx.moveTo(route.xs[route.count - 1], route.zs[route.count - 1]);
          ctx.lineTo(route.tail.x, route.tail.z);
          ctx.setLineDash([9 * k, 7 * k]);
          ctx.strokeStyle = ROUTE_COLOR;
          ctx.lineWidth = 3 * k;
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
        v.setScreen();
      }
      if (wp) {
        v.toScreen(wp.x, wp.z, pt);
        drawPin(ctx, pt.x, pt.y, 8, (v.time % 1600) / 1600);
      }
    },
  };
}

const NO_DASH: number[] = [];
const dashCache = new Map<number, number[]>();
function DASH_RADAR(dpr: number): number[] {
  let d = dashCache.get(dpr);
  if (!d) dashCache.set(dpr, (d = [5 * dpr, 4 * dpr]));
  return d;
}

function strokeRange(ctx: CanvasRenderingContext2D, route: Route, a: number, b: number, casing: string, casingW: number, color: string, w: number) {
  if (b <= a) return;
  ctx.beginPath();
  ctx.moveTo(route.xs[a], route.zs[a]);
  for (let i = a + 1; i <= b; i++) ctx.lineTo(route.xs[i], route.zs[i]);
  ctx.strokeStyle = casing;
  ctx.lineWidth = casingW;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}
