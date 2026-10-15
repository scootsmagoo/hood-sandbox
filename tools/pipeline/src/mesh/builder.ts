/** One optional per-vertex channel of a mesh: `width` numbers per vertex, `fill` where a vertex never set it. */
export interface Channel {
  width: number;
  fill: number[];
  data: number[];
}

/**
 * Growable vertex arrays for one material: positions, normals and linear RGB colours, plus any number of named extra
 * channels (UVs, ids, ambient occlusion ...). A channel only has to be written for the vertices that have a value; the
 * others read as the channel's `fill` once `pad()` has run (every reader of a finished mesh calls it first).
 */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  channels = new Map<string, Channel>();

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r = 1, g = 1, b = 1): number {
    const i = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.colors.push(r, g, b);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A quad a,b,c,d in order; split into (a,b,c) and (a,c,d). */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Declares a channel (idempotent); `fill` is what unset vertices read as. */
  channel(name: string, width: number, fill: number[] = new Array(width).fill(0)): Channel {
    let c = this.channels.get(name);
    if (!c) {
      c = { width, fill, data: [] };
      this.channels.set(name, c);
    }
    return c;
  }

  /** Sets the values of one vertex in a declared channel. */
  set(name: string, vertex: number, ...values: number[]): void {
    const c = this.channels.get(name);
    if (!c) throw new Error(`mesh channel ${name} is not declared`);
    const at = vertex * c.width;
    while (c.data.length < at) c.data.push(...c.fill);
    for (let k = 0; k < c.width; k++) c.data[at + k] = values[k];
  }

  /** Reads the values of one vertex of a channel (the fill when unset). */
  get(name: string, vertex: number): number[] {
    const c = this.channels.get(name)!;
    const at = vertex * c.width;
    return at + c.width <= c.data.length ? c.data.slice(at, at + c.width) : c.fill.slice();
  }

  /** Makes every channel exactly `vertexCount * width` long. */
  pad(): this {
    const n = this.vertexCount;
    for (const c of this.channels.values()) {
      while (c.data.length < n * c.width) c.data.push(...c.fill);
      if (c.data.length > n * c.width) c.data.length = n * c.width;
    }
    return this;
  }
}
