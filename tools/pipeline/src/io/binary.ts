/** Little-endian binary writers and readers for the tile files. */

export function heightmapBytes(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) dv.setFloat32(i * 4, data[i], true);
  return out;
}

export function readHeightmap(bytes: Uint8Array): Float32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** Float32 xyz positions followed by Uint32 triangle indices. */
export function collisionBytes(positions: ArrayLike<number>, indices: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(positions.length * 4 + indices.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < positions.length; i++) dv.setFloat32(i * 4, positions[i], true);
  const off = positions.length * 4;
  for (let i = 0; i < indices.length; i++) dv.setUint32(off + i * 4, indices[i], true);
  return out;
}

export function readCollision(bytes: Uint8Array, vertexCount: number, indexCount: number): { positions: Float32Array; indices: Uint32Array } {
  if (bytes.byteLength !== vertexCount * 12 + indexCount * 4) throw new Error('collision.bin size does not match its counts');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = dv.getFloat32(i * 4, true);
  const indices = new Uint32Array(indexCount);
  const off = vertexCount * 12;
  for (let i = 0; i < indexCount; i++) indices[i] = dv.getUint32(off + i * 4, true);
  return { positions, indices };
}
