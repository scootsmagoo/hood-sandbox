/** Growable vertex arrays for one material. */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

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
}
