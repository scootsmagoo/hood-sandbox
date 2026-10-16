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

/** The lon/lat box, image size and cache file of a tile's DEM request: the city-wide pixel grid with `cfg.demAlign`, else the tile's own (both square in degrees). */
export function demRequest(cfg: TileConfig): { box: { west: number; south: number; east: number; north: number }; w: number; h: number; file: string; url: string } {
  const src = cfg.city.sources.elevation;
  const a = cfg.demAlign;
  if (a) {
    // snap outward to the city-wide pixel grid, so two tiles sample the same pixels at their seam
    const q = cfg.queryBox;
    const i0 = Math.floor((q.west - a.lon0) / a.lonStep);
    const i1 = Math.ceil((q.east - a.lon0) / a.lonStep);
    const j0 = Math.floor((q.south - a.lat0) / a.latStep);
    const j1 = Math.ceil((q.north - a.lat0) / a.latStep);
    const w = i1 - i0;
    const h = j1 - j0;
    if (w > 4000 || h > 4000) throw new Error(`aligned DEM request of ${w}x${h} pixels is over the 4000 pixel limit`);
    // exportImage makes the pixels square in degrees (it stretches the y extent otherwise), so the steps must be equal
    if (Math.abs(a.lonStep - a.latStep) > 1e-12 * a.latStep) throw new Error('aligned DEM pixels must be square in degrees (lonStep = latStep)');
    const box = { west: a.lon0 + i0 * a.lonStep, east: a.lon0 + i1 * a.lonStep, south: a.lat0 + j0 * a.latStep, north: a.lat0 + j1 * a.latStep };
    return { box, w, h, file: path.join(cfg.cacheDir, `dem-3dep-${w}x${h}.tif`), url: demUrl(src.endpoint, box, w, h) };
  }
  // Pixels square in degrees, as the aligned (M2) request has them: exportImage keeps the x extent and stretches the y extent
  // about its centre to make them so, whatever the size asked for. The M1 request used to ask for metre-square pixels (1120 x 1117)
  // and label the image with the box it asked for, while the image covered 33.742233 to 33.766366 rather than 33.744193 to
  // 33.764406: the terrain was squeezed north to south by 0.84 about the centre (217 m off at the edges, heights metres off). The
  // box is now the query box's centre plus or minus whole pixels of `pixelSizeM / 110574` degrees each way, so what is asked for
  // is what comes back. (A new cache name: the old file is kept.)
  const q = cfg.queryBox;
  const step = src.pixelSizeM / 110574;
  const w = Math.min(4000, Math.ceil((q.east - q.west) / step));
  const h = Math.min(4000, Math.ceil((q.north - q.south) / step));
  const cx = (q.west + q.east) / 2, cy = (q.south + q.north) / 2;
  const box = { west: cx - (w * step) / 2, east: cx + (w * step) / 2, south: cy - (h * step) / 2, north: cy + (h * step) / 2 };
  return { box, w, h, file: path.join(cfg.cacheDir, `dem-3dep-sq-${w}x${h}.tif`), url: demUrl(src.endpoint, box, w, h) };
}

function demUrl(endpoint: string, box: { west: number; south: number; east: number; north: number }, w: number, h: number): string {
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
  return `${endpoint}?${params}`;
}

export async function fetchDem(cfg: TileConfig): Promise<Dem> {
  const src = cfg.city.sources.elevation;
  const { box, w, h, file, url } = demRequest(cfg);
  const buf = await cachedFile(file, async () => {
    // (the service is slow and sometimes fails: up to four tries, 5, 15 and 45 s apart)
    let last: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 5000 * 3 ** (attempt - 1)));
      try {
        console.log(`dem: GET ${src.endpoint} (${w}x${h})${attempt ? ` try ${attempt + 1}` : ''}`);
        const res = await fetch(url, { headers: { 'user-agent': 'hood-sandbox-pipeline/0.1' } });
        if (!res.ok) throw new Error(`3DEP HTTP ${res.status}`);
        const ab = Buffer.from(await res.arrayBuffer());
        if (ab.length < 1000 || ab[0] === 0x7b) throw new Error(`3DEP returned no image: ${ab.toString('utf8', 0, 200)}`);
        return ab;
      } catch (e) {
        last = e;
        console.log(`dem: ${String(e)}`);
      }
    }
    throw last;
  });
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const img = await tiff.getImage();
  const rast = (await img.readRasters({ interleave: false })) as unknown as ArrayLike<number>[];
  const band = rast[0];
  const data = new Float32Array(band.length);
  for (let i = 0; i < band.length; i++) data[i] = band[i];
  // the image's own georeferencing, where it has it, is the truth (and says so if the request was not what came back)
  let ext = box;
  try {
    const [bw, bs, be, bn] = img.getBoundingBox();
    if ([bw, bs, be, bn].every(Number.isFinite)) {
      const off = Math.max(Math.abs(bw - box.west), Math.abs(bs - box.south), Math.abs(be - box.east), Math.abs(bn - box.north));
      if (off > 1e-7) console.log(`dem: the image covers ${bw},${bs},${be},${bn}, not the box asked for (off by up to ${off.toExponential(2)} deg): using the image's`);
      ext = { west: bw, south: bs, east: be, north: bn };
    }
  } catch {
    // no georeferencing in the file: the box asked for
  }
  return { width: img.getWidth(), height: img.getHeight(), west: ext.west, east: ext.east, south: ext.south, north: ext.north, data, nodata: -9999 };
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
