import type { Projector, V2 } from '../geo.js';
import type { OsmData } from '../sources/osm.js';

/** What OSM says about one node that matters to traffic. */
export interface NodeInfo {
  id: number;
  pos: V2;
  /** highway=traffic_signals (also when a crossing node says crossing=traffic_signals on a road) */
  signals?: boolean;
  /** a pedestrian crossing with its own signals (crossing=traffic_signals) */
  crossingSignals?: boolean;
  /** highway=stop; `direction` as OSM tags it ("forward" and "backward" are along the way), `all` for stop=all or all_way */
  stop?: { direction: 'forward' | 'backward' | 'both'; all: boolean };
  giveWay?: { direction: 'forward' | 'backward' | 'both' };
  /** highway=crossing or crossing=*: marked, zebra, uncontrolled, unmarked, traffic_signals ... */
  crossing?: string;
}

const dir = (v?: string): 'forward' | 'backward' | 'both' => (v === 'forward' ? 'forward' : v === 'backward' ? 'backward' : 'both');

export function parseNodeTags(data: OsmData | null, proj: Projector): Map<number, NodeInfo> {
  const out = new Map<number, NodeInfo>();
  if (!data) return out;
  for (const el of data.elements) {
    if (el.type !== 'node' || el.lat === undefined || el.lon === undefined || !el.tags) continue;
    const t = el.tags;
    const info: NodeInfo = { id: el.id, pos: proj.toGame(el.lon, el.lat) };
    const hw = (t.highway ?? '').split(';');
    if (hw.includes('traffic_signals')) info.signals = true;
    if (hw.includes('stop')) info.stop = { direction: dir(t.direction ?? t['stop:direction']), all: t.stop === 'all' || t.stop === 'all_way' };
    if (hw.includes('give_way')) info.giveWay = { direction: dir(t.direction) };
    if (hw.includes('crossing') || t.crossing) info.crossing = t.crossing ?? t['crossing:markings'] ?? 'yes';
    if (t.crossing === 'traffic_signals') info.crossingSignals = true;
    if (info.signals || info.crossingSignals || info.stop || info.giveWay || info.crossing) out.set(el.id, info);
  }
  return out;
}
