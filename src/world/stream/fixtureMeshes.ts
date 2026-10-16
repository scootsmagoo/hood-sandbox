/**
 * Draws a tile of the fixture city (`src/shared/fixture.ts`): the ground from its heightmap, the roads and their sidewalks as
 * ribbons, the buildings as boxes. Plain vertex-coloured meshes: the fixture is for seeing the streaming, not the look.
 */
import * as THREE from 'three';
import type { FixtureTile } from '../../shared/fixture';

export interface FixtureMaterials {
  ground: THREE.Material;
  road: THREE.Material;
  walk: THREE.Material;
  building: THREE.Material;
}

export function fixtureMaterials(): FixtureMaterials {
  const road = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const walk = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  return {
    ground: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
    road,
    walk,
    building: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
  };
}

/** The meshes of one fixture tile, under a group (positions are the city's; the group stays at the origin). */
export function fixtureTileGroup(t: FixtureTile, mats: FixtureMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = `tile:${t.fixture.i}_${t.fixture.j}`;
  // ground: the heightmap at full resolution, coloured by a checker of 32 m so the seams can be seen not to be there
  const { cols, rows, cellSize, minX, minZ } = t.manifest.heightmap;
  const pos = new Float32Array(cols * rows * 3);
  const col = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = minX + c * cellSize, z = minZ + r * cellSize;
      pos[i * 3] = x;
      pos[i * 3 + 1] = t.heights[i];
      pos[i * 3 + 2] = z;
      const check = (Math.floor(x / 32) + Math.floor(z / 32)) & 1;
      const k = 0.36 + check * 0.05 + t.heights[i] * 0.01;
      col[i * 3] = k * 0.85;
      col[i * 3 + 1] = k;
      col[i * 3 + 2] = k * 0.75;
    }
  }
  const idx: number[] = [];
  // the south-west to north-east diagonal of every cell, as the physics cuts it
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const nw = r * cols + c, ne = nw + 1, sw = nw + cols, se = sw + 1;
      idx.push(nw, sw, ne, ne, sw, se);
    }
  }
  const ground = new THREE.BufferGeometry();
  ground.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  ground.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ground.setIndex(idx);
  ground.computeVertexNormals();
  const gm = new THREE.Mesh(ground, mats.ground);
  gm.receiveShadow = true;
  g.add(gm);
  // roads and sidewalks: ribbons along the centrelines, on the ground
  const ribbon = (lift: number, widen: number, shade: (cls: string) => [number, number, number]) => {
    const p: number[] = [], cl: number[] = [], ix: number[] = [];
    for (const r of t.roads ?? []) {
      const half = r.width / 2 + widen;
      const [cr, cg, cb] = shade(r.class);
      for (let k = 0; k + 1 < r.points.length; k++) {
        const a = r.points[k], b = r.points[k + 1];
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l, nz = dx / l;
        const v = p.length / 3;
        p.push(a[0] + nx * half, a[1] + lift, a[2] + nz * half, a[0] - nx * half, a[1] + lift, a[2] - nz * half, b[0] + nx * half, b[1] + lift, b[2] + nz * half, b[0] - nx * half, b[1] + lift, b[2] - nz * half);
        for (let q = 0; q < 4; q++) cl.push(cr, cg, cb);
        ix.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
    geo.setIndex(ix);
    geo.computeVertexNormals();
    return geo;
  };
  const walk = new THREE.Mesh(ribbon(0.05, 3.2, () => [0.55, 0.55, 0.53]), mats.walk);
  walk.receiveShadow = true;
  g.add(walk);
  const road = new THREE.Mesh(ribbon(0.08, 0, (cls) => (cls === 'primary' ? [0.13, 0.13, 0.14] : [0.18, 0.18, 0.19])), mats.road);
  road.receiveShadow = true;
  g.add(road);
  // buildings
  const bp: number[] = [], bc: number[] = [], bi: number[] = [];
  const P = t.collisionPositions, I = t.collisionIndices;
  for (let k = 0; k < I.length; k++) {
    const v = I[k];
    bp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  }
  for (const bd of t.fixture.buildings) {
    const shade = bd.kind === 2 ? [0.42, 0.5, 0.58] : bd.kind === 3 ? [0.55, 0.36, 0.28] : [0.62, 0.6, 0.55];
    // 8 wall triangles and 2 roof triangles each, as the collision mesh (unwelded: flat shading)
    for (let q = 0; q < 30; q++) bc.push(shade[0], shade[1], shade[2]);
  }
  for (let k = 0; k < bp.length / 3; k++) bi.push(k);
  if (bp.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(bc.length === bp.length ? bc : new Array(bp.length).fill(0.6), 3));
    geo.computeVertexNormals();
    const bm = new THREE.Mesh(geo, mats.building);
    bm.castShadow = true;
    bm.receiveShadow = true;
    g.add(bm);
  }
  g.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  });
  return g;
}
