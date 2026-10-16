/**
 * From a classified building to the pieces the mesh writer draws: one piece for a plain building, several for a stepped
 * one (Overture `building_part`s, with the part of the footprint that no part covers as a podium of its own). Each piece
 * gets its roof (flat with a parapet, or pitched) and its ids. See "Mesh attributes (meshFormat 2)" in the contract.
 */
import polygonClipping from 'polygon-clipping';
import type { V2 } from '../geo.js';
import { ringBounds } from '../geo.js';
import type { Building, PartIn } from './buildings.js';
import { bandFor, classifyBuilding, floorsFor, paletteColour, styleOf, type BuildingKind, type Classification } from './classify.js';
import { LOOK_FLAG, MATERIAL_ID, ROOF_MATERIAL_ID, STYLE_ID, parseColour, parseMaterial, plausibleWallColour, type Material } from './appearance.js';
import type { BuildingContext } from './context.js';
import type { PieceInput } from './buildingMesh.js';
import { FLAG } from './buildingMesh.js';
import { normaliseRoofShape, planDome, planPitchedRoof, type RoofPlan, type RoofShape } from './roofs.js';
import { hash32, inPolygon, minAreaObb, rng } from './shape.js';
import { hash01 } from './buildings.js';

type Ring = [number, number][];
const closed = (r: V2[]): Ring => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const opened = (r: Ring): V2[] => r.slice(0, -1).map((p) => [p[0], p[1]] as V2);
const polyAreaOf = (poly: polygonClipping.Polygon): number => {
  let a = 0;
  poly.forEach((r, i) => {
    let t = 0;
    for (let k = 0; k + 1 < r.length; k++) t += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
    a += (i === 0 ? 1 : -1) * Math.abs(t / 2);
  });
  return a;
};
const multiArea = (mp: polygonClipping.MultiPolygon): number => mp.reduce((s, p) => s + polyAreaOf(p), 0);

export interface PlannedBuilding {
  cls: Classification;
  pieces: PieceInput[];
  /** the highest point of any piece above the datum (what the collision prism is as tall as) */
  maxTopH: number;
  /**
   * How far above the datum the solid part of the building begins: 0 for anything that stands on the ground; for a building that
   * is only floating pieces (a skybridge, a raised hall) the lowest underside, so the collision prism leaves the way under it open.
   */
  solidBaseH: number;
  stats: { parts: number; podium: boolean; pitched: number };
}

interface RawPiece {
  polys: polygonClipping.MultiPolygon;
  baseH: number;
  topH: number;
  part?: PartIn;
  residual?: boolean;
}

const FLOOR_FALLBACK = 3.4;

/** Heights of the parts of a building (m above the datum), filling in what the data lacks. */
export function resolvePartHeights(bd: Building, parts: PartIn[]): { baseH: number; topH: number }[] {
  const raw = parts.map((p) => (p.height != null && p.height > 0.5 ? p.height : p.numFloors ? p.numFloors * FLOOR_FALLBACK + 1 : null));
  const anyExplicit = parts.some((p) => p.height != null && p.height > 0.5);
  const maxFloors = Math.max(0, ...parts.map((p) => p.numFloors ?? 0));
  let k = 1;
  if (!anyExplicit && maxFloors >= 5 && bd.heightSource !== 'default') {
    // the parts only know their floors: fit the tallest to the building's height
    k = Math.max(0.85, Math.min(1.35, bd.height / (maxFloors * FLOOR_FALLBACK + 1)));
  }
  return parts.map((p, i) => {
    let h = raw[i];
    if (h != null && !(p.height != null && p.height > 0.5)) h *= k;
    if (h == null) h = parts.length === 1 ? bd.height : Math.min(bd.height, 14);
    if (bd.heightSource !== 'default') h = Math.min(h, bd.height * 1.08 + 1);
    const base = p.minHeight != null && p.minHeight > 3 ? p.minHeight : 0;
    return { baseH: base, topH: Math.max(h, base + 3) };
  });
}

function splitPieces(bd: Building): RawPiece[] | null {
  const parts = bd.parts;
  if (!parts || !parts.length) return null;
  const outline: polygonClipping.Polygon = bd.rings.map(closed);
  const heights = resolvePartHeights(bd, parts);
  const raws: RawPiece[] = [];
  parts.forEach((p, i) => {
    for (const poly of p.polygons) {
      let res: polygonClipping.MultiPolygon;
      try {
        res = polygonClipping.intersection(outline, poly.map(closed));
      } catch {
        continue;
      }
      if (res.length && multiArea(res) >= 6) raws.push({ polys: res, baseH: heights[i].baseH, topH: heights[i].topH, part: p });
    }
  });
  if (!raws.length) return null;
  const ground = raws.filter((r) => r.baseH <= 2);
  const maxPart = Math.max(...ground.map((r) => r.topH), 0);
  // what no ground part covers is a podium (or the whole building, if the parts float)
  let residual: polygonClipping.MultiPolygon = [outline];
  try {
    for (const r of ground) residual = polygonClipping.difference(residual, ...r.polys);
  } catch {
    residual = [];
  }
  const outlineArea = multiArea([outline]);
  const resArea = multiArea(residual);
  if (resArea >= 25 && resArea >= outlineArea * 0.04) {
    let h = bd.height;
    if (ground.length && bd.heightSource !== 'default' && bd.height >= maxPart * 0.9) h = Math.max(9, Math.min(24, maxPart * 0.2));
    else if (ground.length) h = Math.min(bd.height, maxPart);
    raws.push({ polys: residual, baseH: 0, topH: Math.max(h, 3), residual: true });
  }
  return raws;
}

/** A closure that says whether an edge lies against the faces of the taller pieces already placed (so it is inside the building). */
function hiddenTest(covered: polygonClipping.MultiPolygon): PieceInput['hidden'] | undefined {
  if (!covered.length) return undefined;
  const polys = covered.map((p) => ({ rings: p.map(opened), bb: ringBounds(opened(p[0])) }));
  return (a, b, n) => {
    const mx = (a[0] + b[0]) / 2 + n[0] * 0.18;
    const mz = (a[1] + b[1]) / 2 + n[1] * 0.18;
    for (const p of polys) {
      if (mx < p.bb.minX || mx > p.bb.maxX || mz < p.bb.minZ || mz > p.bb.maxZ) continue;
      if (inPolygon(mx, mz, p.rings)) return true;
    }
    return false;
  };
}

function parapetFor(kind: BuildingKind, h: number): number {
  if (kind === 'house' || kind === 'small' || kind === 'religious') return 0;
  if (h < 6) return 0;
  if (h >= 40) return 1.2;
  if (kind === 'parking') return 0.6;
  if (kind === 'brick') return 0.9;
  return 0.8;
}

/** The roof of a piece: pitched or domed where the data or the kind and size say so and the footprint allows, else null (flat). */
export function chooseRoof(rings: V2[][], height: number, kind: BuildingKind, dataShape: string | null | undefined, roofHeight: number | null | undefined, hash: number, isPart: boolean): RoofPlan | null {
  const outer = rings[0];
  const hasHoles = rings.length > 1;
  const obb = minAreaObb(outer);
  const area = 4 * obb.L * obb.W * obb.fill;
  let shape: RoofShape | null = normaliseRoofShape(dataShape);
  const explicit = shape !== null;
  if (shape === 'flat') return null;
  if (!shape) {
    // defaults by kind: Atlanta's downtown is flat-roofed, its houses, sheds and small churches are not
    switch (kind) {
      case 'house': shape = area <= 650 ? (hash < 0.55 ? 'gabled' : 'hipped') : null; break;
      case 'small': shape = area >= 20 && area <= 400 && height <= 8 ? (hash < 0.45 ? 'gabled' : hash < 0.7 ? 'skillion' : null) : null; break;
      case 'religious': shape = height <= 30 && area <= 1500 ? 'gabled' : null; break;
      case 'residential': shape = height <= 12 && area <= 700 ? (hash < 0.5 ? 'gabled' : 'hipped') : null; break;
      case 'retail': case 'brick': case 'generic': shape = height <= 8 && area <= 260 && hash < 0.3 ? 'gabled' : null; break;
      default: shape = null;
    }
    void isPart;
  }
  if (!shape) return null;
  if (shape === 'dome') {
    if (hasHoles || height < 6) return null;
    const plan = planDome(outer, obb);
    return plan && plan.rise < height - 2.5 ? plan : null;
  }
  if (hasHoles || (area > 3500 && !explicit)) return null;
  const maxRise = Math.min(roofHeight && roofHeight > 0.5 ? roofHeight : 7, height - 2.4, 0.6 * height);
  if (maxRise < 0.9) return null;
  const slopeDeg = shape === 'skillion' ? 8 + 6 * hash : shape === 'gabled' ? 30 + 8 * hash : 22 + 8 * hash;
  return planPitchedRoof(outer, shape, obb, { slopeDeg, maxRise });
}

export function planBuilding(bd: Building, ctx?: BuildingContext): PlannedBuilding {
  const cls = classifyBuilding(bd, ctx);
  const hash = hash01(bd.id + 'r');
  const hash16 = Math.floor(hash01(bd.id + 'h') * 65535);
  const raws: RawPiece[] = splitPieces(bd) ?? [{ polys: [bd.rings.map(closed)], baseH: bd.minHeight && bd.minHeight > 3 ? bd.minHeight : 0, topH: bd.height }];
  const multi = raws.length > 1 || !!bd.parts?.length;
  const maxTop = Math.max(...raws.map((r) => r.topH));

  // ground pieces from the tallest down; each hides the walls of the lower ones that touch it
  const order = raws.map((r, i) => ({ r, i })).sort((a, b) => (a.r.baseH > 2 ? 1 : 0) - (b.r.baseH > 2 ? 1 : 0) || b.r.topH - a.r.topH || multiArea(b.r.polys) - multiArea(a.r.polys));
  let covered: polygonClipping.MultiPolygon = [];
  const pieces: PieceInput[] = [];
  let pitched = 0;
  let podium = false;
  for (const { r, i } of order) {
    const floating = r.baseH > 2;
    let geom = r.polys;
    let hidden: PieceInput['hidden'];
    if (!floating && covered.length) {
      hidden = hiddenTest(covered);
      try {
        geom = polygonClipping.difference(r.polys, covered);
      } catch {
        geom = r.polys;
      }
    }
    if (!floating) {
      try {
        covered = covered.length ? polygonClipping.union(covered, r.polys) : r.polys;
      } catch {
        /* keep what was covered */
      }
    }
    // pieces that are not the tallest of a glass tower are its podium (stone or concrete, not curtain wall)
    let kind = cls.kind;
    let material: Material = cls.material;
    let podiumOfGlass = false;
    if (kind === 'glass' && r.topH < maxTop * 0.5) {
      kind = 'office';
      material = cls.bandMaterial === 'metal' || cls.bandMaterial === 'glass' ? 'concrete' : cls.bandMaterial;
      podiumOfGlass = true;
    }
    const piece = r.part;
    // a part with a facade of its own (Overture says so) is dressed as it says
    const partMaterial = parseMaterial(piece?.facadeMaterial);
    if (partMaterial && !podiumOfGlass && !(cls.kind === 'glass' && partMaterial !== 'glass')) material = partMaterial;
    const partColour = plausibleWallColour(parseColour(piece?.facadeColor), material === 'glass');
    const crown = r.topH >= maxTop - 0.5 && !r.residual ? cls.crown : 0;
    let k = 0;
    for (const poly of geom) {
      if (polyAreaOf(poly) < 6) continue;
      const rings = poly.map(opened).filter((x) => x.length >= 3);
      if (!rings.length) continue;
      const sub = `${bd.id}#${i}.${k++}`;
      const roof = chooseRoof(rings, r.topH - r.baseH, kind, piece?.roofShape ?? (multi && !piece ? null : bd.roofShape), piece?.roofHeight ?? (multi ? null : bd.roofHeight), hash, multi);
      const wallTop = r.topH - (roof ? roof.rise : 0);
      const parapet = roof ? 0 : parapetFor(kind, r.topH - r.baseH);
      const band = floating ? 0 : Math.min(bandFor(kind, r.topH, cls.era), (wallTop - r.baseH) * 0.45);
      const dataFloors = bd.skybridge ? 1 : (piece?.numFloors ?? (multi ? null : (bd.facadeFloors ?? bd.look?.floors ?? bd.numFloors)));
      const fl = floorsFor(kind, wallTop - r.baseH - crown, band, dataFloors, cls.era, bd.look?.heightKnown && !multi ? 7 : 5.6);
      const wallSrgb = partColour ?? (podiumOfGlass || material !== cls.material ? paletteColour(material, kind, hash01(bd.id + 'c')) : cls.colour);
      const st = styleOf(cls, bd.id, { kind, wall: wallSrgb });
      let flags = 0;
      if (roof) flags |= FLAG.pitched;
      if (parapet > 0) flags |= FLAG.parapet;
      if (multi) flags |= FLAG.part;
      if (bd.name) flags |= FLAG.named;
      if (cls.eraFromData) flags |= FLAG.eraKnown;
      if (rings.length > 1) flags |= FLAG.courtyard;
      if (floating) flags |= FLAG.floating;
      if (cls.kindFromData) flags |= FLAG.kindKnown;
      if (roof) pitched++;
      if (r.residual && maxTop > r.topH * 1.5) podium = true;
      let lookFlags = 0;
      if (cls.colourFromData && !podiumOfGlass) lookFlags |= LOOK_FLAG.colour;
      if (cls.materialFromData && !podiumOfGlass) lookFlags |= LOOK_FLAG.material;
      if (cls.styleFromData) lookFlags |= LOOK_FLAG.style;
      if (fl.fromData) lookFlags |= LOOK_FLAG.floors;
      if (bd.look?.heightKnown) lookFlags |= LOOK_FLAG.height;
      if (cls.roofColourFromData) lookFlags |= LOOK_FLAG.roofColour;
      if (bd.look?.curated) lookFlags |= LOOK_FLAG.curated;
      if (cls.fromContext) lookFlags |= LOOK_FLAG.context;
      // a pitched roof is never the flat membrane's
      const roofMat = roof && (cls.roofMaterial === 'membrane' || cls.roofMaterial === 'white') ? 'shingle' : cls.roofMaterial;
      pieces.push({
        rings, baseH: r.baseH, topH: r.topH, roof, parapet, kind, era: cls.era, floors: fl.floors, band: Math.round(band * 10) / 10,
        hash16, flags, wall: st.wall, roofColor: st.roof, glass: kind === 'glass', seed: hash32(sub), hidden, equipment: !floating,
        look: {
          material: MATERIAL_ID[material], style: STYLE_ID[cls.style], bandMaterial: MATERIAL_ID[podiumOfGlass ? material : cls.bandMaterial],
          crown: Math.round(crown), roofMaterial: ROOF_MATERIAL_ID[roofMat], flags: lookFlags,
        },
      });
    }
  }
  void rng;
  // a building with nothing on the ground is solid only from its lowest underside up
  const lowest = Math.min(...raws.map((r) => r.baseH));
  const solidBaseH = lowest > 2 ? lowest : 0;
  return { cls, pieces, maxTopH: maxTop, solidBaseH, stats: { parts: multi ? raws.length : 0, podium, pitched } };
}
