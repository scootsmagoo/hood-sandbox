import { describe, expect, it } from 'vitest';
import { Authority, EntityKind, EntityRegistry, type EntityBase } from './entities';
import { HANDLING, loadHandlingTable, parseHandling } from './handling';
import { approachAngle, lerpAngle, nlerpQuat, quatFromYaw, rotateVec, rotateVecInv, wrapAngle, yawFromTileHeading, yawOfQuat } from './math';
import { generateProceduralTile, propsToMesh } from './proceduralTile';
import { Rng } from './rng';
import { SnapshotRing } from './ring';
import { SNAPSHOT_BYTES, SnapshotView, E, H } from './snapshot';
import { decodeTile, heightAt, loadBakedTile, loadTileOrFallback, parseProps, parseRoads, parseTileManifest } from './tile';

describe('Rng', () => {
  it('repeats for the same seed and differs for another', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 8 }, () => a.next());
    expect(Array.from({ length: 8 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 8 }, () => c.next())).not.toEqual(sa);
    for (const v of sa) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });

  it('forks independent streams', () => {
    const r = new Rng(7);
    const traffic1 = r.fork('traffic');
    r.next();
    r.next();
    const traffic2 = r.fork('traffic');
    expect(traffic2.next()).toBe(traffic1.next());
    expect(new Rng(7).fork('peds').next()).not.toBe(new Rng(7).fork('traffic').next());
  });

  it('is roughly uniform and honours int ranges', () => {
    const r = new Rng(1);
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += r.next();
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });
});

describe('EntityRegistry', () => {
  const mk = (id: number, kind: EntityBase['kind'] = EntityKind.Ped): EntityBase => ({ id, kind, owner: 0, authority: Authority.Local, health: 100 });

  it('hands out increasing IDs that are never reused', () => {
    const reg = new EntityRegistry();
    const a = reg.allocateId();
    reg.add(mk(a));
    reg.remove(a);
    const b = reg.allocateId();
    expect(b).toBeGreaterThan(a);
    expect(reg.get(a)).toBeUndefined();
  });

  it('refuses duplicates and filters by kind', () => {
    const reg = new EntityRegistry();
    reg.add(mk(1));
    reg.add(mk(2, EntityKind.Vehicle));
    expect(() => reg.add(mk(1))).toThrow();
    expect(reg.ofKind(EntityKind.Vehicle).map((e) => e.id)).toEqual([2]);
    expect(reg.size).toBe(2);
  });
});

describe('math', () => {
  it('wraps and approaches angles the short way', () => {
    expect(wrapAngle(2.5 * Math.PI)).toBeCloseTo(Math.PI / 2, 9);
    expect(wrapAngle(-2.5 * Math.PI)).toBeCloseTo(-Math.PI / 2, 9);
    expect(approachAngle(3, -3, 0.1)).toBeCloseTo(3.1, 9);
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(3 + (2 * Math.PI - 6) / 2, 9);
  });

  it('rotates by a yaw quaternion and back, and recovers the yaw', () => {
    const q = quatFromYaw(0.8);
    const v = rotateVec(q, 0, 0, 1);
    expect(v.x).toBeCloseTo(Math.sin(0.8), 9);
    expect(v.z).toBeCloseTo(Math.cos(0.8), 9);
    const back = rotateVecInv(q, v.x, v.y, v.z);
    expect(back.z).toBeCloseTo(1, 9);
    expect(yawOfQuat(q)).toBeCloseTo(0.8, 9);
  });

  it('turns a tile heading into a model yaw', () => {
    // heading 0 faces north (-Z): model forward (sin yaw, cos yaw) = (0, -1)
    expect(Math.cos(yawFromTileHeading(0))).toBeCloseTo(-1, 9);
    // heading PI/2 turns toward west, forward (-sin h, -cos h) = (-1, 0)
    expect(Math.sin(yawFromTileHeading(Math.PI / 2))).toBeCloseTo(-1, 9);
    expect(Math.cos(yawFromTileHeading(Math.PI / 2))).toBeCloseTo(0, 9);
  });

  it('interpolates quaternions along the short arc', () => {
    const q = nlerpQuat(quatFromYaw(0.2), quatFromYaw(0.6), 0.5);
    expect(yawOfQuat(q)).toBeCloseTo(0.4, 3);
    // the same rotation as yaw 0.2, written with the opposite sign: the short arc is still taken
    const neg = { x: 0, y: -Math.sin(0.1), z: 0, w: -Math.cos(0.1) };
    expect(yawOfQuat(nlerpQuat(quatFromYaw(0.6), neg, 0.5))).toBeCloseTo(0.4, 3);
  });
});

describe('snapshot ring', () => {
  it('delivers the newest write once and reports nothing new after that', () => {
    const ring = SnapshotRing.create(64);
    const rd = new Uint8Array(64);
    expect(ring.read(rd)).toBe(false);
    ring.write(new Uint8Array(64).fill(1));
    ring.write(new Uint8Array(64).fill(2));
    expect(ring.read(rd)).toBe(true);
    expect(rd[0]).toBe(2);
    expect(rd[63]).toBe(2);
    expect(ring.read(rd)).toBe(false);
    ring.write(new Uint8Array(64).fill(3));
    expect(ring.read(rd)).toBe(true);
    expect(rd[10]).toBe(3);
  });

  it('works through a second view of the same buffer', () => {
    const a = SnapshotRing.create(SNAPSHOT_BYTES);
    const b = new SnapshotRing(a.buffer, SNAPSHOT_BYTES);
    const view = new SnapshotView();
    view.u32[H.Tick] = 99;
    a.write(new Uint8Array(view.buffer));
    const into = new SnapshotView();
    expect(b.read(new Uint8Array(into.buffer))).toBe(true);
    expect(into.tick).toBe(99);
  });
});

describe('snapshot view', () => {
  it('finds entities by id', () => {
    const v = new SnapshotView();
    v.u32[H.Count] = 2;
    v.u32[v.at(0) + E.Id] = 5;
    v.u32[v.at(1) + E.Id] = 9;
    expect(v.indexOf(9)).toBe(1);
    expect(v.indexOf(4)).toBe(-1);
  });
});

describe('tile manifest', () => {
  const good = () => JSON.parse(JSON.stringify(generateProceduralTile(1).manifest));

  it('accepts the procedural manifest', () => {
    expect(parseTileManifest(good()).id).toBe('procedural/test-ground');
  });

  it('rejects things the sim could not use', () => {
    expect(() => parseTileManifest(null)).toThrow(/not an object/);
    expect(() => parseTileManifest({ ...good(), format: 'other' })).toThrow(/format/);
    expect(() => parseTileManifest({ ...good(), version: 2 })).toThrow(/version/);
    const m = good();
    m.heightmap.cols = 1;
    expect(() => parseTileManifest(m)).toThrow(/heightmap/);
    const n = good();
    n.collision.indexCount = 4;
    expect(() => parseTileManifest(n)).toThrow(/multiple of 3/);
    const s = good();
    delete s.spawns;
    expect(() => parseTileManifest(s)).toThrow(/spawns/);
  });
});

describe('tile data', () => {
  function files() {
    const t = generateProceduralTile(1);
    const col = new ArrayBuffer(t.collisionPositions.byteLength + t.collisionIndices.byteLength);
    new Float32Array(col, 0, t.collisionPositions.length).set(t.collisionPositions);
    new Uint32Array(col, t.collisionPositions.byteLength, t.collisionIndices.length).set(t.collisionIndices);
    return { t, height: t.heights.buffer.slice(0) as ArrayBuffer, col };
  }

  it('decodes the files the manifest describes', () => {
    const { t, height, col } = files();
    const d = decodeTile(t.manifest, height, col);
    expect(d.collisionPositions.length).toBe(t.collisionPositions.length);
    expect(Array.from(d.collisionIndices.slice(0, 12))).toEqual(Array.from(t.collisionIndices.slice(0, 12)));
    expect(d.source).toBe('baked');
  });

  it('notices files that do not match the manifest', () => {
    const { t, height, col } = files();
    expect(() => decodeTile(t.manifest, height.slice(4), col)).toThrow(/height\.bin/);
    expect(() => decodeTile(t.manifest, height, col.slice(4))).toThrow(/collision\.bin/);
    const bad = new Uint32Array(col.slice(0));
    bad[t.collisionPositions.length] = t.manifest.collision.vertexCount + 5;
    expect(() => decodeTile(t.manifest, height, bad.buffer)).toThrow(/index/);
  });

  it('loads over fetch, and falls back to the procedural ground with a reason', async () => {
    const { t, height, col } = files();
    const store: Record<string, unknown> = { '/t/tile.json': t.manifest, '/t/height.bin': height, '/t/collision.bin': col };
    const fetchFn = async (url: string) => {
      const v = store[url];
      return { ok: v !== undefined, status: v !== undefined ? 200 : 404, json: async () => v, arrayBuffer: async () => v as ArrayBuffer };
    };
    const baked = await loadBakedTile('/t', fetchFn);
    expect(baked.manifest.id).toBe(t.manifest.id);
    expect((await loadTileOrFallback('/t', 1, fetchFn)).source).toBe('baked');

    const missing = await loadTileOrFallback('/nope', 1, fetchFn);
    expect(missing.source).toBe('procedural');
    expect(missing.fallbackReason).toMatch(/no usable tile/);

    // a dev server answering with index.html
    const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, arrayBuffer: async () => new ArrayBuffer(0) });
    expect((await loadTileOrFallback('/x', 1, html)).fallbackReason).toMatch(/Unexpected token/);
    expect((await loadTileOrFallback(null, 1)).source).toBe('procedural');
  });

  it('reads the roads when the manifest names them, and carries on without them when it cannot', async () => {
    const { t, height, col } = files();
    const manifest = { ...t.manifest, roads: 'roads.json' };
    const roads = { roads: [
      { id: 'a', class: 'residential', width: 8, lanes: 2, oneway: false, bridge: false, layer: 0, points: [[0, 0, 0], [10, 0, 0]] },
      { id: 'bad', class: 'residential', width: 8, points: [[0, 0, 0]] },
      { id: 'worse', width: 'wide', points: [[0, 0, 0], [1, 0, 1]] },
    ] };
    const store: Record<string, unknown> = { '/t/tile.json': manifest, '/t/height.bin': height, '/t/collision.bin': col, '/t/roads.json': roads };
    const fetchFn = async (url: string) => {
      const v = store[url];
      return { ok: v !== undefined, status: v !== undefined ? 200 : 404, json: async () => v, arrayBuffer: async () => v as ArrayBuffer };
    };
    const tile = await loadBakedTile('/t', fetchFn);
    expect(tile.roads?.map((r) => r.id)).toEqual(['a']);
    expect(parseRoads({}).length).toBe(0);
    expect(parseRoads(null).length).toBe(0);
    delete store['/t/roads.json'];
    const without = await loadBakedTile('/t', fetchFn);
    expect(without.roads).toBeUndefined();
    expect(without.manifest.id).toBe(t.manifest.id);
  });

  it('reads heights off the triangles the ground is cut into (south-west to north-east diagonal), and clamps at the edges', () => {
    const t = generateProceduralTile(1);
    const { cols, rows } = t.manifest.heightmap;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) t.heights[r * cols + c] = c * 0.5 + r;
    expect(heightAt(t, -1000, -1000)).toBe(0);
    expect(heightAt(t, -1000 + 4, -1000)).toBeCloseTo(0.5, 6);
    expect(heightAt(t, -1000, -1000 + 4)).toBeCloseTo(1, 6);
    expect(heightAt(t, -1000 + 2, -1000 + 2)).toBeCloseTo(0.25 + 0.5, 6);
    expect(heightAt(t, 5000, 5000)).toBeCloseTo((cols - 1) * 0.5 + (rows - 1), 6);
    // a twisted cell (north-west and south-east high): the middle is on the diagonal, the average of south-west and north-east, not of all four
    t.heights.fill(0);
    t.heights[0] = 4;
    t.heights[cols + 1] = 4;
    expect(heightAt(t, -1000 + 2, -1000 + 2)).toBeCloseTo(0, 6);
    expect(heightAt(t, -1000 + 1, -1000 + 1)).toBeCloseTo(2, 6);
    expect(heightAt(t, -1000 + 3, -1000 + 3)).toBeCloseTo(2, 6);
  });
});

describe('procedural tile', () => {
  it('is the same for the same seed and differs for another', () => {
    const a = generateProceduralTile(1);
    const b = generateProceduralTile(1);
    const c = generateProceduralTile(2);
    expect(Array.from(a.collisionPositions.slice(0, 50))).toEqual(Array.from(b.collisionPositions.slice(0, 50)));
    expect(a.props.length).toBe(b.props.length);
    expect(Array.from(a.collisionPositions.slice(0, 200))).not.toEqual(Array.from(c.collisionPositions.slice(0, 200)));
  });

  it('keeps its manifest honest', () => {
    const t = generateProceduralTile(1);
    const m = t.manifest;
    expect(t.heights.length).toBe(m.heightmap.cols * m.heightmap.rows);
    expect(t.collisionPositions.length).toBe(m.collision.vertexCount * 3);
    expect(t.collisionIndices.length).toBe(m.collision.indexCount);
    expect(Math.max(...t.collisionIndices)).toBeLessThan(m.collision.vertexCount);
    expect(parseTileManifest(JSON.parse(JSON.stringify(m)))).toBeTruthy();
  });

  it('builds closed solids wound outward', () => {
    for (const kind of ['box', 'wedge'] as const) {
      const m = propsToMesh([{ kind, x: 3, y: 1, z: -2, sx: 2, sy: 3, sz: 4, yaw: 0.7, color: [1, 1, 1] }]);
      let vol = 0;
      const p = m.positions;
      for (let i = 0; i < m.indices.length; i += 3) {
        const a = m.indices[i] * 3;
        const b = m.indices[i + 1] * 3;
        const c = m.indices[i + 2] * 3;
        vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
      }
      expect(vol).toBeCloseTo(kind === 'box' ? 24 : 12, 6);
    }
  });

  it('leaves the spawns clear', () => {
    const t = generateProceduralTile(1);
    for (const p of t.props) {
      if (p.sy < 5) continue;
      for (const s of [t.manifest.spawns.player, t.manifest.spawns.vehicle]) {
        expect(Math.abs(p.x - s.x) > p.sx / 2 + 3 || Math.abs(p.z - s.z) > p.sz / 2 + 3).toBe(true);
      }
    }
  });
});

describe('handling table', () => {
  it('loads the shipped vehicles with sedan as the base', () => {
    expect(Object.keys(HANDLING)).toEqual(['sedan', 'coupe', 'pickup']);
    expect(HANDLING.coupe.drive.driveForce).toBeGreaterThan(HANDLING.sedan.drive.driveForce);
    expect(HANDLING.coupe.wheels.radius).toBe(HANDLING.sedan.wheels.radius);
    expect(HANDLING.coupe.id).toBe('coupe');
  });

  it('rejects nonsense', () => {
    const base = JSON.parse(JSON.stringify(HANDLING.sedan));
    expect(() => parseHandling('x', { ...base, mass: 5 })).toThrow(/mass/);
    expect(() => parseHandling('x', { ...base, suspension: { ...base.suspension, restRatio: 1.5 } })).toThrow(/restRatio/);
    expect(() => parseHandling('x', { ...base, mass: Number.NaN })).toThrow(/finite/);
    expect(() => loadHandlingTable({ coupe: {} })).toThrow(/sedan/);
  });
});

describe('props.json', () => {
  it('keeps well formed anchors and drops the rest', () => {
    const p = parseProps({ version: 1, trees: [[1, 2, 3, 10, 4, 0, 1], [1, 2, 3], [1, 2, 3, 10, 4, 0, Number.NaN]], lamps: [[0, 0, 0, 1, 9, 0, 1]], hydrants: [[1, 2, 3]] })!;
    expect(p.trees.length).toBe(1);
    expect(p.lamps.length).toBe(1);
    expect(p.hydrants.length).toBe(1);
    expect(p.bins).toEqual([]);
    expect(parseProps({ version: 2 })).toBeNull();
    expect(parseProps(null)).toBeNull();
  });
});
