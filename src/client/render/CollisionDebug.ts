/**
 * `?debug=collision`: draws what the sim collides with, over the world, so a wall nobody can see (or a
 * visible one nobody can touch) shows up.
 *
 *   magenta  building walls and roofs (`collision.bin`, the first `buildingTriangles`)
 *   orange   elevated road decks and bridge piers (the rest of `collision.bin`)
 *   cyan     street furniture: signal poles with their arms, benches, bus stops (`shared/props.ts`: the same boxes the sim makes solid)
 *   green    the player's capsule, and a line from each person the safety net moves (logged to the console as `[unstick]`)
 *
 * The meshes are the files' own, read again here. Walls are depth tested, so a collision wall inside a drawn one is hidden by it.
 */
import * as THREE from 'three';
import { parseLanes } from '../../shared/lanes';
import { collectProps, worldSolids } from '../../shared/props';
import type { SimEvent } from '../../shared/protocol';
import { parseProps, type TileManifest } from '../../shared/tile';
import { PED, PED_FEET_OFFSET } from '../../sim/character/locomotion';
import { parseScenarios } from '../../shared/walk';
import type { Game, System } from '../Game';

const wire = (color: number, depthTest = true) => new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, depthTest, depthWrite: false });

export class CollisionDebug implements System {
  readonly name = 'collisionDebug';
  readonly priority = 95;
  private readonly group = new THREE.Group();
  private readonly owned: { dispose(): void }[] = [];
  private readonly player: THREE.Mesh;
  private readonly marks: { line: THREE.Line; until: number }[] = [];
  private disposed = false;

  constructor(
    private readonly game: Game,
    collision: { positions: Float32Array; indices: Uint32Array; buildingTriangles: number },
    boxes: Float32Array,
  ) {
    this.group.name = 'collision-debug';
    const own = <T extends { dispose(): void }>(x: T) => (this.owned.push(x), x);
    const pos = new THREE.BufferAttribute(collision.positions, 3);
    const split = Math.min(collision.indices.length, collision.buildingTriangles * 3);
    for (const [from, to, color] of [[0, split, 0xff2bd6], [split, collision.indices.length, 0xff9a1f]] as const) {
      if (to <= from) continue;
      const g = own(new THREE.BufferGeometry());
      g.setAttribute('position', pos);
      g.setIndex(new THREE.BufferAttribute(collision.indices.subarray(from, to), 1));
      const m = new THREE.Mesh(g, own(wire(color)));
      m.frustumCulled = false;
      this.group.add(m);
    }
    if (boxes.length) {
      const g = own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(boxes, 3));
      const l = new THREE.LineSegments(g, own(new THREE.LineBasicMaterial({ color: 0x22e6ff, depthTest: false, transparent: true, opacity: 0.9 })));
      l.frustumCulled = false;
      this.group.add(l);
    }
    // the player's capsule, as the sim has it
    const cap = own(new THREE.CapsuleGeometry(PED.radius, PED.halfHeight * 2, 4, 10));
    this.player = new THREE.Mesh(cap, own(new THREE.MeshBasicMaterial({ color: 0x3dff6b, wireframe: true, depthTest: false })));
    this.group.add(this.player);
    game.scene.add(this.group);
    game.onSimEvent((e) => this.onEvent(e));
  }

  private onEvent(e: SimEvent) {
    if (e.type !== 'ped:unstuck' || this.disposed) return;
    console.info(`[unstick] ped ${e.pedId} ${e.reason} -> ${e.action}: (${e.fromX.toFixed(1)}, ${e.fromZ.toFixed(1)}) to (${e.toX.toFixed(1)}, ${e.toZ.toFixed(1)})`);
    const y = this.game.view.ped?.y ?? 0;
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(e.fromX, y + 0.2, e.fromZ), new THREE.Vector3(e.toX, y + 0.2, e.toZ), new THREE.Vector3(e.toX, y + 3, e.toZ)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3dff6b, depthTest: false }));
    this.group.add(line);
    this.marks.push({ line, until: performance.now() + 8000 });
  }

  update() {
    const p = this.game.view.ped;
    this.player.visible = !!p && !this.game.view.inVehicle;
    if (p) this.player.position.set(p.x, p.y + PED_FEET_OFFSET, p.z);
    const now = performance.now();
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.marks[i].until > now) continue;
      const { line } = this.marks[i];
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this.marks.splice(i, 1);
    }
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.marks) {
      m.line.geometry.dispose();
      (m.line.material as THREE.Material).dispose();
    }
    for (const o of this.owned) o.dispose();
  }
}

/** The 12 edges of every prop box, as line segments (x, y, z pairs). */
function boxEdges(boxes: ReturnType<typeof worldSolids>): Float32Array {
  const out = new Float32Array(boxes.length * 24 * 3);
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  let o = 0;
  for (const b of boxes) {
    const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
    const corner = (i: number): [number, number, number] => {
      const lx = (i & 1 ? 1 : -1) * b.hx, ly = (i & 4 ? 1 : -1) * b.hy, lz = (i & 2 ? 1 : -1) * b.hz;
      return [b.cx + lx * c + lz * s, b.cy + ly, b.cz - lx * s + lz * c];
    };
    for (const [a, z] of edges) {
      for (const p of [corner(a), corner(z)]) {
        out[o++] = p[0];
        out[o++] = p[1];
        out[o++] = p[2];
      }
    }
  }
  return out;
}

/** Reads the collision mesh and the props beside the tile and builds the view, or nothing when there is no baked tile. */
export async function loadCollisionDebug(game: Game, tileBase: string | null, manifest: TileManifest): Promise<CollisionDebug | null> {
  if (!tileBase) return null;
  try {
    const get = (name: string) => fetch(new URL(name, tileBase).href);
    const [colRes, lanesRes, scenRes, propsRes] = await Promise.all([get(manifest.collision.file), manifest.lanes ? get(manifest.lanes) : null, manifest.scenarios ? get(manifest.scenarios) : null, manifest.props ? get(manifest.props) : null]);
    if (!colRes.ok) return null;
    const bytes = await colRes.arrayBuffer();
    const { vertexCount, indexCount } = manifest.collision;
    const positions = new Float32Array(bytes, 0, vertexCount * 3);
    const indices = new Uint32Array(bytes, vertexCount * 12, indexCount);
    const lanes = lanesRes?.ok ? parseLanes(await lanesRes.json()) : null;
    const scen = scenRes?.ok ? parseScenarios(await scenRes.json()) : null;
    const anchors = propsRes?.ok ? parseProps(await propsRes.json()) : null;
    const props = collectProps(lanes?.junctions, scen?.points, anchors ?? undefined);
    const boxes = boxEdges(props.flatMap(worldSolids));
    return new CollisionDebug(game, { positions, indices, buildingTriangles: manifest.collision.buildingTriangles ?? indexCount / 3 }, boxes);
  } catch (e) {
    console.warn('collision debug view:', e);
    return null;
  }
}
