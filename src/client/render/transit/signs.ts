/**
 * Text on the transit layer's signs, drawn into canvases (no font file, no texture to license): a generic sans-serif, white on
 * the dark brown of the system's signs, with the lines' coloured discs. No logo and no wordmark of the real agency: the brand is
 * the city pack's parody, written out in letters.
 */
import * as THREE from 'three';
import type { TransitData, TransitStation } from '../../../shared/transit';

const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const tex = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 700): number {
  let s = size;
  for (; s > 10; s -= 2) {
    g.font = `${weight} ${s}px ${FONT}`;
    if (g.measureText(text).width <= maxW) break;
  }
  return s;
}

/** The hanging station-name sign: the name, and the discs of the lines that stop there. */
export function nameSignTexture(st: TransitStation, data: TransitData): THREE.Texture {
  const [c, g] = canvas(1024, 188);
  g.fillStyle = '#2a1d16';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#d6a35c';
  g.fillRect(0, c.height - 10, c.width, 10);
  const name = st.displayName;
  const discs = st.lines.length;
  const textW = c.width - 80 - discs * 70;
  fitText(g, name, textW, 104);
  g.fillStyle = '#f4f1ea';
  g.textBaseline = 'middle';
  g.fillText(name, 40, c.height / 2 - 4);
  st.lines.forEach((li, i) => {
    g.fillStyle = data.lines[li]?.colour ?? '#888';
    g.beginPath();
    g.arc(c.width - 50 - (discs - 1 - i) * 70, c.height / 2 - 4, 26, 0, Math.PI * 2);
    g.fill();
  });
  return tex(c);
}

/** The pylon over an entrance: the brand in letters, the station, the line discs. */
export function pylonTexture(st: TransitStation, data: TransitData): THREE.Texture {
  const [c, g] = canvas(256, 512);
  g.fillStyle = '#20252b';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#f08a4b';
  g.fillRect(0, 0, c.width, 120);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitText(g, data.brandShort || data.brand, 220, 86, 800);
  g.fillText(data.brandShort || data.brand, c.width / 2, 62);
  g.fillStyle = '#e9e6df';
  const words = st.displayName.split(/[\s/]+/);
  words.slice(0, 4).forEach((w, i) => {
    fitText(g, w, 230, 44, 700);
    g.fillText(w, c.width / 2, 190 + i * 54);
  });
  st.lines.forEach((li, i) => {
    g.fillStyle = data.lines[li]?.colour ?? '#888';
    g.beginPath();
    g.arc(c.width / 2 + (i - (st.lines.length - 1) / 2) * 52, 450, 20, 0, Math.PI * 2);
    g.fill();
  });
  return tex(c);
}

/** The wall map: the lines of the tile as a schematic, this station marked. */
export function mapTexture(st: TransitStation | null, data: TransitData): THREE.Texture {
  const [c, g] = canvas(512, 320);
  g.fillStyle = '#efe9dc';
  g.fillRect(0, 0, c.width, c.height);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of data.routes) for (let i = 0; i < r.pts.length; i += 3) {
    x0 = Math.min(x0, r.pts[i]); x1 = Math.max(x1, r.pts[i]);
    z0 = Math.min(z0, r.pts[i + 2]); z1 = Math.max(z1, r.pts[i + 2]);
  }
  const s = Math.min((c.width - 60) / (x1 - x0 || 1), (c.height - 90) / (z1 - z0 || 1));
  const P = (x: number, z: number): [number, number] => [30 + (x - x0) * s, 60 + (z - z0) * s];
  g.lineCap = 'round';
  data.routes.forEach((r, ri) => {
    if (data.routes.findIndex((q) => q.line === r.line) !== ri) return;
    g.strokeStyle = data.lines[r.line]?.colour ?? '#888';
    g.lineWidth = 7;
    g.beginPath();
    for (let i = 0; i < r.pts.length; i += 3 * 4) {
      const [x, y] = P(r.pts[i], r.pts[i + 2]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  });
  g.font = `600 13px ${FONT}`;
  g.textBaseline = 'middle';
  for (const q of data.stations) {
    const [x, y] = P(q.x, q.z);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#222';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, q === st ? 10 : 7, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#222';
    g.fillText(q.displayName, x + 12, y);
  }
  g.fillStyle = '#20252b';
  g.fillRect(0, 0, c.width, 40);
  g.fillStyle = '#ffffff';
  g.font = `700 22px ${FONT}`;
  g.fillText(data.brand, 16, 21);
  return tex(c);
}

/** A next-train display: amber text on black, redrawn when what it says changes. */
export class ScreenTexture {
  readonly texture: THREE.CanvasTexture;
  private readonly c: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private last = '';

  constructor() {
    [this.c, this.g] = canvas(512, 170);
    this.texture = tex(this.c) as THREE.CanvasTexture;
    this.draw([]);
  }

  /** Lines: [colour, destination, when]. */
  draw(rows: [string, string, string][]): void {
    const key = JSON.stringify(rows);
    if (key === this.last) return;
    this.last = key;
    const g = this.g;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, this.c.width, this.c.height);
    g.textBaseline = 'middle';
    if (rows.length === 0) {
      g.fillStyle = '#ffae1a';
      g.font = `600 40px ${FONT}`;
      g.fillText('PLEASE STAND BACK', 24, 85);
    }
    rows.slice(0, 2).forEach(([col, dest, when], i) => {
      const y = 46 + i * 78;
      g.fillStyle = col;
      g.beginPath();
      g.arc(34, y, 16, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffae1a';
      fitText(g, dest.toUpperCase(), 330, 42, 600);
      g.fillText(dest.toUpperCase(), 62, y);
      g.font = `700 42px ${FONT}`;
      const w = g.measureText(when).width;
      g.fillText(when, this.c.width - 20 - w, y);
    });
    this.texture.needsUpdate = true;
  }
}
