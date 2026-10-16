import { describe, expect, it } from 'vitest';
import { MapLayers, type BigMapView, type RadarView } from './layers';

describe('map layers', () => {
  it('draw in order of their `order`, on the radar and on the map, and only the ones that have a drawer', () => {
    const layers = new MapLayers();
    const calls: string[] = [];
    layers.add({ id: 'route', order: 100, radar: () => calls.push('route:radar'), bigMap: () => calls.push('route:map') });
    layers.add({ id: 'transit', order: 40, radar: () => calls.push('transit:radar'), bigMap: () => calls.push('transit:map') });
    layers.add({ id: 'mapOnly', bigMap: () => calls.push('mapOnly:map') });
    layers.drawRadar({} as RadarView);
    layers.drawBigMap({} as BigMapView);
    expect(calls).toEqual(['transit:radar', 'route:radar', 'transit:map', 'route:map', 'mapOnly:map']);
    expect(layers.ids).toEqual(['transit', 'route', 'mapOnly']);
  });

  it('adding a layer with the same id replaces it, and the returned function removes it', () => {
    const layers = new MapLayers();
    let n = 0;
    layers.add({ id: 'a', radar: () => n++ });
    const off = layers.add({ id: 'a', radar: () => (n += 10) });
    layers.drawRadar({} as RadarView);
    expect(n).toBe(10);
    off();
    layers.drawRadar({} as RadarView);
    expect(n).toBe(10);
    expect(layers.ids).toEqual([]);
  });

  it('says when the picture changed', () => {
    const layers = new MapLayers();
    let heard = 0;
    const off = layers.onInvalidate(() => heard++);
    const r0 = layers.revision;
    layers.add({ id: 'x' });
    layers.invalidate();
    expect(layers.revision).toBe(r0 + 2);
    expect(heard).toBe(2);
    off();
    layers.invalidate();
    expect(heard).toBe(2);
  });
});
