/** A minimal RGBA PNG writer (no dependencies) and a few raster helpers for the audit's heat map. */
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export class Raster {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: [number, number, number] = [0, 0, 0]) {
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = bg[0]; this.px[i * 4 + 1] = bg[1]; this.px[i * 4 + 2] = bg[2]; this.px[i * 4 + 3] = 255; }
  }

  /** Blends a colour into one pixel with opacity `a`. */
  plot(x: number, y: number, c: [number, number, number], a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    for (let k = 0; k < 3; k++) this.px[o + k] = Math.round(this.px[o + k] * (1 - a) + c[k] * a);
  }

  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], a = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) this.plot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c, a);
  }

  disc(x: number, y: number, r: number, c: [number, number, number], a = 1) {
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) if (dx * dx + dy * dy <= r * r) this.plot(x + dx, y + dy, c, a);
  }

  ring(x: number, y: number, r: number, c: [number, number, number], a = 1) {
    const n = Math.max(8, Math.ceil(r * 7));
    for (let i = 0; i < n; i++) this.plot(x + Math.cos((i / n) * Math.PI * 2) * r, y + Math.sin((i / n) * Math.PI * 2) * r, c, a);
  }

  triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: [number, number, number], a = 1) {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(this.h - 1, Math.ceil(Math.max(ay, by, cy)));
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(d) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) this.plot(x, y, c, a);
      }
    }
  }

  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0;
      raw.set(this.px.subarray(y * this.w * 4, (y + 1) * this.w * 4), y * (this.w * 4 + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.w);
    dv.setUint32(4, this.h);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}
