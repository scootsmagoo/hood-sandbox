/**
 * The train model (src/sim/transit/trains.ts) on a made-up line: trains come in at the source on the headway, run to the limit,
 * stop with the head at the stop, open and close their doors, keep their distance, and leave at the sink; the same ticks give the
 * same trains.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMETABLE, type TransitData, type TransitRoute } from '../../src/shared/transit';
import { CAR, TrainModel, buildStreams, trainLength } from '../../src/sim/transit/trains';

function route(len: number, stops: number[], line = 0): TransitRoute {
  const n = Math.ceil(len / 3) + 1;
  const pts: number[] = [];
  const cum: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.min(len, i * 3);
    pts.push(s, 0, 0);
    cum.push(s);
  }
  return { id: `l${line}`, line, osm: 1, towards: 'End', pts, cum, len, stops: stops.map((s) => ({ station: 0, platform: 0, s, side: 1 })), enter: 'w', exit: 'e', speed: [[0, 20]], reverse: -1 };
}

function data(routes: TransitRoute[]): TransitData {
  return {
    format: 'hood-transit', version: 1, brand: 'Test', brandShort: 'T', agency: 'tap', lines: [{ id: 'a', ref: 'A', name: 'A Line', colour: '#ff0000' }, { id: 'b', ref: 'B', name: 'B Line', colour: '#0000ff' }],
    tracks: [], routes, stations: [{ id: 's', name: 'S', displayName: 'S', osm: 1, x: 0, y: 0, z: 0, underground: true, lines: [0], platforms: [], concourse: null, paid: null, entrances: [], gates: [] }],
    volumes: [], holes: [], anchors: [], walk: { nodes: [], edges: [] }, timetable: { ...DEFAULT_TIMETABLE, headways: [{ from: '00:00', to: '24:00', minutes: 6 }] }, collision: null, mesh: null, stats: {},
  };
}

function run(model: TrainModel, seconds: number, onStep?: (t: number) => void) {
  const dt = 1 / 60;
  for (let k = 0; k < seconds * 60; k++) {
    const t = k * dt;
    model.stepAll(t, dt, () => {});
    model.reap();
    onStep?.(t);
  }
}

describe('trains', () => {
  it('come in on the headway, stop with the head at the stop, cycle the doors and leave', () => {
    const d = data([route(1600, [800])]);
    const events: string[] = [];
    const model = new TrainModel(d, d.timetable, () => 720, {
      arrive: (tr) => events.push(`arrive ${tr.s.toFixed(2)}`),
      depart: () => events.push('depart'),
      doors: (_tr, s) => events.push(`doors ${s}`),
    });
    let maxV = 0;
    let stoppedAt = -1;
    run(model, 200, () => {
      for (const tr of model.trains) {
        maxV = Math.max(maxV, tr.v);
        if (tr.phase === 'open') stoppedAt = tr.s;
      }
    });
    expect(maxV).toBeLessThanOrEqual(20 + 1e-6);
    expect(maxV).toBeGreaterThan(15);
    expect(stoppedAt).toBeCloseTo(800, 3);
    // a full cycle: arrive, doors open, closing, closed, depart
    expect(events.slice(0, 5)).toEqual(['arrive 800.00', 'doors open', 'doors closing', 'doors closed', 'depart']);
    // 6 minutes of timetable at 20 s a minute: a train every 120 s
    expect(model.streams[0].seq).toBe(2);
  });

  it('keeps its distance from the train ahead, and lines on one track take turns', () => {
    // two lines on the same track (the same polyline): one stream, trains alternating between them
    const d = data([route(3000, [600, 1800], 0), route(3000, [600, 1800], 1)]);
    const { streams } = buildStreams(d);
    expect(streams.length).toBe(1);
    const model = new TrainModel(d, d.timetable, () => 720);
    let minGap = Infinity;
    const lines: number[] = [];
    run(model, 600, () => {
      const t = [...model.trains].sort((a, b) => b.s - a.s);
      for (let i = 0; i + 1 < t.length; i++) minGap = Math.min(minGap, t[i].s - trainLength(6) - t[i + 1].s);
      for (const tr of model.trains) if (!lines.includes(tr.id) && tr.s < 1) lines.push(tr.line);
    });
    expect(minGap).toBeGreaterThan(TrainModel.GAP - 5);
    expect(new Set(model.trains.map((t) => t.line)).size).toBe(2);
  });

  it('is deterministic', () => {
    const snap = () => {
      const d = data([route(2500, [700, 1500])]);
      const m = new TrainModel(d, d.timetable, () => 480);
      m.warmUp(0, 300);
      run(m, 120);
      return JSON.stringify(m.trains.map((t) => [t.s.toFixed(6), t.v.toFixed(6), t.phase, t.stop]));
    };
    expect(snap()).toBe(snap());
  });

  it('lays a train out: six cars, couplers between', () => {
    expect(trainLength(6)).toBeCloseTo(6 * CAR.length + 5 * CAR.gap, 6);
  });
});
