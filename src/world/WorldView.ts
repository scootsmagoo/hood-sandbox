/**
 * Draws the tile: the baked glTF meshes when there is a baked tile, and the procedural test ground
 * (rebuilt from the same seed the sim used) when there is not. The sim never sees any of this.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { generateProceduralTile, propsToMesh, type PropSpec } from '../shared/proceduralTile';
import type { SimReady } from '../shared/protocol';

export interface WorldView {
  root: THREE.Group;
  /** Meshes that should have shadows cast onto them (for the light's bookkeeping). */
  dispose(): void;
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
  if (name === 'bld_glass') {
    m.metalness = 0.6;
    m.roughness = 0.2;
  } else if (name.startsWith('bld_')) {
    m.metalness = 0;
    m.roughness = 0.9;
  } else {
    m.metalness = 0;
    m.roughness = name === 'road_asphalt' ? 0.95 : 0.85;
  }
  m.needsUpdate = true;
}

async function loadBaked(base: string, ready: SimReady, root: THREE.Group): Promise<string[]> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const errors: string[] = [];
  const files = ready.tile.meshes;
  const entries = (Object.entries(files) as [string, string | undefined][]).filter(([, f]) => !!f);
  await Promise.all(
    entries.map(async ([kind, file]) => {
      try {
        const gltf = await loader.loadAsync(new URL(file!, base).href);
        gltf.scene.name = kind;
        gltf.scene.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) styleMaterial(m);
          o.castShadow = kind === 'buildings';
          o.receiveShadow = true;
          // Static: compose each matrix once.
          o.updateMatrix();
          o.matrixAutoUpdate = false;
        });
        root.add(gltf.scene);
      } catch (e) {
        errors.push(`${file}: ${(e as Error).message}`);
      }
    }),
  );
  return errors;
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
  const root = new THREE.Group();
  root.name = 'world';
  if (ready.tileSource === 'baked' && tileBase) {
    const errors = await loadBaked(tileBase, ready, root);
    for (const e of errors) console.warn('[world]', e);
  } else {
    buildProcedural(seed, root);
  }
  return {
    root,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
}
