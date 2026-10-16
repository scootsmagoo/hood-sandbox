/**
 * Checks of a tile's transit layer (`npm run verify`, test/transit.test.ts): the routes' grades, every stop on a platform of
 * its station with the doors on the platform's side, every platform of a station reachable over the station's walk network from
 * each of its entrances, the spaces under the ground present, the collision present.
 */
import type { TransitData } from '../../../../src/shared/transit.js';

export interface TransitReport {
  routes: number;
  stations: number;
  maxGrade: number;
  worstGradeAt: [number, number] | null;
  stopsOff: string[];
  unreachable: string[];
  volumes: number;
  collisionTris: number;
}

export function checkTransit(t: TransitData): TransitReport {
  let maxGrade = 0;
  let worst: [number, number] | null = null;
  for (const r of t.routes) {
    // grades over 12 m windows (the 3 m points are rounded to the centimetre)
    for (let i = 0; i < r.cum.length; i++) {
      let j = i;
      while (j + 1 < r.cum.length && r.cum[j] - r.cum[i] < 12) j++;
      const L = r.cum[j] - r.cum[i];
      if (L < 11) continue;
      const g = Math.abs(r.pts[j * 3 + 1] - r.pts[i * 3 + 1]) / L;
      if (g > maxGrade) {
        maxGrade = g;
        worst = [r.pts[i * 3], r.pts[i * 3 + 2]];
      }
    }
  }
  const stopsOff: string[] = [];
  t.routes.forEach((r) => {
    for (const s of r.stops) {
      const st = t.stations[s.station];
      const pl = st?.platforms[s.platform];
      if (!pl) {
        stopsOff.push(`${r.id}: stop at a missing platform`);
        continue;
      }
      // the train's middle (half a train behind the head) should be within the platform's half length of its centre
      let k = 0;
      while (k + 1 < r.cum.length && r.cum[k + 1] < s.s - 71) k++;
      const x = r.pts[k * 3], z = r.pts[k * 3 + 2];
      const along = (x - pl.c[0]) * pl.axis[0] + (z - pl.c[1]) * pl.axis[1];
      if (Math.abs(along) > pl.halfLen + 3) stopsOff.push(`${r.id} at ${st.displayName}: the train stands ${along.toFixed(0)} m off the platform's middle`);
    }
  });
  // the walk network: every platform's walk line from every entrance's street end
  const n = t.walk.nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i + 2 < t.walk.edges.length; i += 3) {
    adj[t.walk.edges[i]].push(t.walk.edges[i + 1]);
    adj[t.walk.edges[i + 1]].push(t.walk.edges[i]);
  }
  const nearest = (x: number, y: number, z: number, within: number) => {
    let best = -1, bd = within;
    t.walk.nodes.forEach((p, i) => {
      const d = Math.hypot(p[0] - x, (p[1] - y) * 3, p[2] - z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const unreachable: string[] = [];
  for (const st of t.stations) {
    if (st.entrances.length === 0) {
      unreachable.push(`${st.displayName}: no entrance`);
      continue;
    }
    // (a station of two side platforms may have an entrance for each: every platform from some entrance, every entrance to some platform)
    const reached = new Set<number>();
    st.entrances.forEach((e, ei) => {
      const from = nearest(e.x, e.y, e.z, 5);
      if (from < 0) {
        unreachable.push(`${st.displayName} entrance ${ei}: no walk node at its top`);
        return;
      }
      const seen = new Uint8Array(n);
      const q = [from];
      seen[from] = 1;
      while (q.length) {
        const u = q.pop()!;
        for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); }
      }
      let any = false;
      st.platforms.forEach((pl, pi) => {
        const to = nearest(pl.c[0], pl.y, pl.c[1], pl.halfLen);
        if (to >= 0 && seen[to]) {
          reached.add(pi);
          any = true;
        } else if (st.underground) unreachable.push(`${st.displayName} entrance ${ei}: platform ${pi} not reached`);
      });
      if (!any) unreachable.push(`${st.displayName} entrance ${ei}: no platform reached`);
    });
    st.platforms.forEach((_, pi) => {
      if (!reached.has(pi)) unreachable.push(`${st.displayName}: platform ${pi} not reached from any entrance`);
    });
  }
  return { routes: t.routes.length, stations: t.stations.length, maxGrade, worstGradeAt: worst, stopsOff, unreachable, volumes: t.volumes.length, collisionTris: (t.collision?.indexCount ?? 0) / 3 };
}
