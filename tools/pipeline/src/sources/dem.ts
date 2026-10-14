import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { cachedFile } from '../cache.js';
import type { TileConfig } from '../config.js';

export interface Dem {
  width: number;
  height: number;
  west: number;
  east: number;
  south: number;
  north: number;
  data: Float32Array; // row 0 is the north edge
  nodata: number;
}

export async function fetchDem(cfg: TileConfig): Promise<Dem> {
  const box = cfg.queryBox;
  const src = cfg.city.sources.elevation;
  const midLat = (box.south + box.north) / 2;
  const widthM = (box.east - box.west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (box.north - box.south) * 110574;
  const w = Math.min(4000, Math.round(widthM / src.pixelSizeM));
  const h = Math.min(4000, Math.round(heightM / src.pixelSizeM));
  const params = new URLSearchParams({
    bbox: `${box.west},${box.south},${box.east},${box.north}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${w},${h}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    noData: '-9999',
    f: 'image',
  });
  const file = path.join(cfg.cacheDir, `dem-3dep-${w}x${h}.tif`);
  const buf = await cachedFile(file, async () => {
    const url = `${src.endpoint}?${params}`;
    console.log(`dem: GET ${src.endpoint} (${w}x${h})`);
    const res = await fetch(url, { headers: { 'user-agent': 'hood-sandbox-pipeline/0.1' } });
    if (!res.ok) throw new Error(`3DEP HTTP ${res.status}`);
    const ab = Buffer.from(await res.arrayBuffer());
    if (ab.length < 1000 || ab[0] === 0x7b) throw new Error(`3DEP returned no image: ${ab.toString('utf8', 0, 200)}`);
    return ab;
  });
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const img = await tiff.getImage();
  const rast = (await img.readRasters({ interleave: false })) as unknown as ArrayLike<number>[];
  const band = rast[0];
  const data = new Float32Array(band.length);
  for (let i = 0; i < band.length; i++) data[i] = band[i];
  return { width: img.getWidth(), height: img.getHeight(), west: box.west, east: box.east, south: box.south, north: box.north, data, nodata: -9999 };
}

/** Bilinear lookup in lon/lat. Returns NaN outside or on nodata. */
export function sampleDem(dem: Dem, lon: number, lat: number): number {
  const fx = ((lon - dem.west) / (dem.east - dem.west)) * dem.width - 0.5;
  const fy = ((dem.north - lat) / (dem.north - dem.south)) * dem.height - 0.5;
  const x0 = Math.max(0, Math.min(dem.width - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(dem.height - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (x: number, y: number) => dem.data[y * dem.width + x];
  const a = v(x0, y0), b = v(x0 + 1, y0), c = v(x0, y0 + 1), d = v(x0 + 1, y0 + 1);
  const bad = (n: number) => !(n > -500 && n < 5000);
  if (bad(a) || bad(b) || bad(c) || bad(d)) return NaN;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
