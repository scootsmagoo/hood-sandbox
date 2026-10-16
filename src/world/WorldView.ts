/**
 * Draws the tile: the baked glTF meshes when there is a baked tile, and the procedural test ground
 * (rebuilt from the same seed the sim used) when there is not. The sim never sees any of this.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { generateProceduralTile, propsToMesh, type PropSpec } from '../shared/proceduralTile';
import type { SimReady } from '../shared/protocol';
import type { TileManifest } from '../shared/tile';
import { freezeStatic } from '../client/render/freeze';
import { buildEdge, EdgeSampler } from './edgeSkirt';
import { mergeable, mergeMeshes } from './mergeChunks';

export interface WorldView {
  root: THREE.Group;
  /** Picks the ground level of detail for each chunk. Call once a frame, after the camera has moved. */
  update(camera: THREE.Camera, lodScale: number): void;
  /** Number of ground chunks and how many currently show the coarse level (diagnostics). */
  stats(): { chunks: number; coarse: number };
  dispose(): void;
}

/** Beyond this distance (divided by the tier's lodScale) a ground chunk switches to its coarse mesh. */
export const GROUND_LOD_DISTANCE = 400;
const LOD_HYSTERESIS = 0.06;

/** Road markings (lane lines, crosswalks, stop bars) are thin: beyond this distance (divided by the tier's lodScale) a chunk's markings are not drawn. */
export const MARKINGS_DISTANCE = 320;

/**
 * Roads and buildings are merged at load, `MERGE_BLOCK` x `MERGE_BLOCK` chunks to a mesh per material (`mergeChunks.ts`):
 * about 60% fewer draws for 40% more triangles. `?mergeblock=1` keeps the tile's own chunks (A/B tests).
 */
export const MERGE_BLOCK = 2;

/** The markings mesh of one chunk. */
interface MarkingsChunk {
  mesh: THREE.Mesh;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One ground chunk with its fine (level 0) and coarse (level 1) meshes. */
interface GroundChunk {
  fine: THREE.Mesh;
  coarse: THREE.Mesh | null;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  isCoarse: boolean;
}

/** Materials of the baked tile (docs/contracts/m1-tile-format.md) and how to treat them. */
function styleMaterial(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  m.vertexColors = true;
  const name = m.name;
  if (name.startsWith('road_')) {
    // At-grade roads sit 4 to 14 cm above the ground mesh; keep them from fighting it at distance.
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  if (name === 'road_markings') {
    // Lane lines, crosswalks and stop bars lie 3 cm over the asphalt (14 cm over the ground for crosswalks):
    // pull them further towards the camera than the road itself so they never z-fight with it at distance.
    m.polygonOffsetFactor = -4;
    m.polygonOffsetUnits = -4;
  }
  if (name === 'bld_glass') {
    m.metalness = 0.6;
    m.roughness = 0.2;
  } else if (name.startsWith('bld_')) {
    m.metalness = 0;
    m.roughness = 0.9;
  } else {
    m.metalness = 0;
    m.roughness = name === 'road_asphalt' ? 0.95 : name === 'road_markings' ? 0.7 : 0.85;
  }
  m.needsUpdate = true;
}

async function loadBaked(base: string, manifest: TileManifest, root: THREE.Group, chunks: GroundChunk[], markings: MarkingsChunk[], mergeBlock: number, edge: EdgeSampler | null): Promise<string[]> {
  const grid = manifest.chunks;
  const byKey = new Map<number, GroundChunk>();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const errors: string[] = [];
  /** Chunk meshes that can be merged into bigger blocks: the roads and buildings (not the ground, which has levels of detail, nor the markings, which hide by distance). */
  const blocks = new Map<string, THREE.Mesh[]>();
  const files = manifest.meshes;
  const entries = (Object.entries(files) as [string, string | undefined][]).filter(([, f]) => !!f);
  await Promise.all(
    entries.map(async ([kind, file]) => {
      try {
        const gltf = await loader.loadAsync(new URL(file!, base).href);
        gltf.scene.name = kind;
        gltf.scene.updateMatrix();
        gltf.scene.matrixAutoUpdate = false;
        gltf.scene.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) styleMaterial(m);
          o.castShadow = kind === 'buildings';
          o.receiveShadow = true;
          // Static: compose each matrix once.
          o.updateMatrix();
          o.matrixAutoUpdate = false;
          // Ground chunks come in two levels of detail (docs/contracts/m1-tile-format.md, "Chunks").
          const u = o.userData as { kind?: string; chunk?: [number, number]; lod?: number };
          if (kind === 'roads' && u.kind === 'markings' && grid && u.chunk) {
            const minX = grid.minX + u.chunk[0] * grid.size;
            const minZ = grid.minZ + u.chunk[1] * grid.size;
            markings.push({ mesh: o, minX, minZ, maxX: minX + grid.size, maxZ: minZ + grid.size });
            o.castShadow = false;
          }
          if (mergeBlock > 1 && grid && u.chunk && kind !== 'ground' && u.kind !== 'markings') {
            const key = `${kind}|${(Array.isArray(o.material) ? o.material[0] : o.material).name}|${Math.floor(u.chunk[0] / mergeBlock)},${Math.floor(u.chunk[1] / mergeBlock)}`;
            const list = blocks.get(key);
            if (list) list.push(o);
            else blocks.set(key, [o]);
          }
          if (kind === 'ground' && grid && u.chunk) {
            const key = u.chunk[1] * grid.cols + u.chunk[0];
            let c = byKey.get(key);
            if (!c) {
              const minX = grid.minX + u.chunk[0] * grid.size;
              const minZ = grid.minZ + u.chunk[1] * grid.size;
              c = { fine: o, coarse: null, minX, minZ, maxX: minX + grid.size, maxZ: minZ + grid.size, isCoarse: false };
              byKey.set(key, c);
              chunks.push(c);
            }
            if (u.lod === 1) {
              c.coarse = o;
              o.visible = false;
              o.receiveShadow = false;
            } else {
              c.fine = o;
              if (edge) sampleEdge(o, manifest.bounds, edge);
            }
          }
        });
        root.add(gltf.scene);
      } catch (e) {
        errors.push(`${file}: ${(e as Error).message}`);
      }
    }),
  );
  if (blocks.size > 0) mergeBlocks(root, blocks);
  return errors;
}

/** Feeds the vertices of a ground chunk that lies on the tile's edge to the sampler of the edge's skirt. */
function sampleEdge(o: THREE.Mesh, b: TileManifest['bounds'], edge: EdgeSampler) {
  const g = o.geometry;
  // (the baked positions are quantised: the node's matrix puts them in the world)
  g.computeBoundingBox();
  const bb = g.boundingBox!.clone().applyMatrix4(o.matrix);
  const band = 41;
  if (bb.min.x > b.minX + band && bb.max.x < b.maxX - band && bb.min.z > b.minZ + band && bb.max.z < b.maxZ - band) return;
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(o.matrix);
    if (v.x > b.minX + band && v.x < b.maxX - band && v.z > b.minZ + band && v.z < b.maxZ - band) continue;
    edge.add(v.x, v.y, v.z, col ? col.getX(i) : 0.4, col ? col.getY(i) : 0.4, col ? col.getZ(i) : 0.38);
  }
}

/** The footprints of the tile's hero landmarks, for the far skyline to keep out of (none when the file is missing). */
async function heroRings(base: string): Promise<[number, number][][]> {
  try {
    const r = await fetch(new URL('landmarks.json', base).href);
    if (!r.ok) return [];
    const j = (await r.json()) as { landmarks?: { hero?: unknown; ring?: [number, number][] }[] };
    return (j.landmarks ?? []).filter((l) => l.hero && Array.isArray(l.ring)).map((l) => l.ring!);
  } catch {
    return [];
  }
}

/** Replaces each list of chunk meshes by one mesh (see `mergeChunks.ts`). A list that cannot be merged stays as it was. */
function mergeBlocks(root: THREE.Group, blocks: Map<string, THREE.Mesh[]>) {
  root.updateMatrixWorld(true);
  for (const [key, list] of blocks) {
    if (!mergeable(list)) continue;
    const first = list[0];
    const parent = first.parent;
    if (!parent || list.some((m) => m.parent !== parent || Array.isArray(m.material))) continue;
    const merged = new THREE.Mesh(mergeMeshes(list), first.material);
    merged.name = key;
    merged.userData = { kind: first.userData.kind, merged: list.length };
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;
    merged.matrixAutoUpdate = false;
    parent.add(merged);
    for (const m of list) {
      m.removeFromParent();
      m.geometry.dispose();
    }
  }
}

/** The sim's fallback tile, drawn: a grid-textured ground and boxes. */
function buildProcedural(seed: number, root: THREE.Group) {
  const tile = generateProceduralTile(seed);
  const { bounds } = tile.manifest;
  const w = bounds.maxX - bounds.minX;
  const d = bounds.maxZ - bounds.minZ;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#5d6a58';
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = '#4d5a49';
  c.fillRect(0, 0, 128, 128);
  c.fillRect(128, 128, 128, 128);
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = 3;
  c.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(w / 20, d / 20); // 10 m squares
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  ground.receiveShadow = true;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  root.add(ground);

  // Props: one mesh with a colour per vertex.
  const parts: { p: PropSpec; first: number; count: number }[] = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const p of tile.props) {
    const m = propsToMesh([p]);
    const base = positions.length / 3;
    positions.push(...m.positions);
    for (let i = 0; i < m.positions.length / 3; i++) colors.push(...p.color);
    for (const i of m.indices) indices.push(base + i);
    parts.push({ p, first: base, count: m.positions.length / 3 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  // Faceted look: unweld so each face gets its own normal.
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const mesh = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  root.add(mesh);
}

export async function createWorldView(ready: SimReady, tileBase: string | null, seed: number): Promise<WorldView> {
  return createView(ready.tileSource === 'baked' && tileBase ? { manifest: ready.tile, base: tileBase } : null, seed, 'world');
}

/**
 * One tile of a streamed city (docs/contracts/city-tiles.md), drawn from its baked files: the same view as a single tile's, with a
 * root named after the tile (the city's `world` group holds the tiles).
 */
export function createTileView(manifest: TileManifest, base: string, name: string): Promise<WorldView> {
  return createView({ manifest, base }, 0, name);
}

async function createView(baked: { manifest: TileManifest; base: string } | null, seed: number, name: string): Promise<WorldView> {
  const root = new THREE.Group();
  root.name = name;
  root.matrixAutoUpdate = false; // (identity; nothing in the tile moves)
  const chunks: GroundChunk[] = [];
  const markings: MarkingsChunk[] = [];
  if (baked) {
    const asked = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('mergeblock')) : NaN;
    // A tile on its own gets a skirt of ground and a far skyline past its edges (`edgeSkirt.ts`); a streamed city's tiles do not.
    const wantEdge = name === 'world' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('edge') !== 'off';
    const sampler = wantEdge ? new EdgeSampler(baked.manifest.bounds) : null;
    const errors = await loadBaked(baked.base, baked.manifest, root, chunks, markings, Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : MERGE_BLOCK, sampler);
    for (const e of errors) console.warn('[world]', e);
    if (sampler) {
      const edge = buildEdge(sampler, baked.manifest.bounds, await heroRings(baked.base));
      if (edge) root.add(edge);
    }
  } else {
    buildProcedural(seed, root);
  }
  freezeStatic(root);
  return {
    root,
    update(camera, lodScale) {
      const cx = camera.position.x;
      const cz = camera.position.z;
      const limit = GROUND_LOD_DISTANCE * lodScale;
      const markLimit = MARKINGS_DISTANCE * lodScale;
      for (const m of markings) {
        const dx = Math.max(m.minX - cx, 0, cx - m.maxX);
        const dz = Math.max(m.minZ - cz, 0, cz - m.maxZ);
        const d = Math.hypot(dx, dz);
        m.mesh.visible = m.mesh.visible ? d <= markLimit * (1 + LOD_HYSTERESIS) : d <= markLimit * (1 - LOD_HYSTERESIS);
      }
      for (const c of chunks) {
        if (!c.coarse) continue;
        // Distance to the chunk's square (zero inside it).
        const dx = Math.max(c.minX - cx, 0, cx - c.maxX);
        const dz = Math.max(c.minZ - cz, 0, cz - c.maxZ);
        const d = Math.hypot(dx, dz);
        const coarse = c.isCoarse ? d > limit * (1 - LOD_HYSTERESIS) : d > limit * (1 + LOD_HYSTERESIS);
        if (coarse !== c.isCoarse) {
          c.isCoarse = coarse;
          c.fine.visible = !coarse;
          c.coarse.visible = coarse;
        }
      }
    },
    stats() {
      return { chunks: chunks.length, coarse: chunks.filter((c) => c.isCoarse).length };
    },
    dispose() {
      root.removeFromParent();
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          // Textures of the procedural ground (the baked materials have none).
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m.dispose();
        }
      });
      chunks.length = 0;
      markings.length = 0;
    },
  };
}
