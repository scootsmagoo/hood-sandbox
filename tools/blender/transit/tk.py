"""The transit geometry kit: plain-Python meshes in game coordinates (+X left, +Y up, +Z forward), built on the landmarks'
`lm.Lod` (welded, deterministic, no bmesh operators), with what the railcar and the station kit add to it:

  Geo          an `lm.Lod` whose polygons get box-projected UVs (1/32 per metre, centred on 0.5: inside [0, 1] for anything
               up to 32 m, so they quantise) unless the caller gives its own (sign faces: 0..1 across the face)
  sign_quad    a quad with 0..1 UVs, u to the viewer's right, v up (the file's TEXCOORD_0: v = 0 at the bottom edge)
  prism_x      a closed (z, y) profile extruded along X (seats, door leaves' edges)
  revolve      a profile of (r, t) points revolved about any axis, smooth round it (wheels, poles, tubes, bins)
  bake_ao      per-vertex ambient occlusion by ray casts against every opaque surface of a set of levels (COLOR_0 alpha)
  emit         one Blender object per named piece, one material slot (one glTF primitive) per material it uses; a moving
               piece is an empty at its pivot with the mesh as a child `<name>_mesh` (the compression moves the mesh node's
               transform, never the empty's, so the named node stays where the game expects it)

COLOR_0 is the linear albedo and its alpha the baked occlusion, as the landmarks'. No sets, no randomness without a seed.
"""
import math

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from hoodlib import scene
from hoodlib.frame import to_bl
from landmarks import lm
from landmarks.lm import mix, newell, shade, srgb  # noqa: F401  (re-exported for the asset scripts)

# Every material slot either transit file uses, in the order the objects carry them.
CAR_MATERIALS = ['tr_steel', 'tr_band', 'tr_cab', 'tr_glass', 'tr_dark', 'tr_interior', 'tr_floor', 'tr_light', 'tr_head', 'tr_tail', 'tr_sign']
KIT_MATERIALS = ['tr_steel', 'tr_dark', 'tr_glass', 'tr_interior', 'tr_light', 'tr_concrete', 'tr_tile', 'tr_signface', 'tr_screen', 'tr_lightface']
MATERIALS = CAR_MATERIALS + [m for m in KIT_MATERIALS if m not in CAR_MATERIALS]

UV_SCALE = 1.0 / 32.0


def _box_uv(pts, n):
    ax = max(range(3), key=lambda k: abs(n[k]))
    out = []
    for x, y, z in pts:
        if ax == 0:
            u, v = (z if n[0] < 0 else -z), y
        elif ax == 1:
            u, v = x, (z if n[1] < 0 else -z)
        else:
            u, v = (x if n[2] > 0 else -x), y
        out.append((u * UV_SCALE + 0.5, v * UV_SCALE + 0.5))
    return out


class Geo(lm.Lod):
    """One level of detail of one piece: triangles per material."""

    def poly(self, mat, pts, col, hint=None, normals=None, ao=None, uvs=None, flip=False, **kw):
        if uvs is None:
            pf = [tuple(float(x) for x in p) for p in pts]
            uvs = _box_uv(pf, newell(pf))
        super().poly(mat, pts, col, hint=hint, normals=normals, ao=ao, uvs=uvs, flip=flip, **kw)

    def add(self, other):
        """Appends another Geo's triangles (same frame)."""
        self.merge(other)


# ---------------------------------------------------------------------------------------------- vectors
def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vmul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def vnorm(a):
    ln = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return (a[0] / ln, a[1] / ln, a[2] / ln) if ln > 1e-12 else (0.0, 1.0, 0.0)


def centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n)


# ---------------------------------------------------------------------------------------------- shapes
def box(g, mat, lo, hi, col, skip=()):
    """An axis-aligned box from its min and max corners."""
    c = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    g.box(mat, c, (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), col, skip=skip)


def hexa(g, mat, c, col, skip=()):
    """A six-sided solid from 8 corners: c[0..3] the bottom ring, c[4..7] the top ring above them (same order)."""
    cen = centroid(c)
    faces = {'-y': [c[0], c[1], c[2], c[3]], '+y': [c[4], c[5], c[6], c[7]],
             's0': [c[0], c[1], c[5], c[4]], 's1': [c[1], c[2], c[6], c[5]], 's2': [c[2], c[3], c[7], c[6]], 's3': [c[3], c[0], c[4], c[7]]}
    for k, f in faces.items():
        if k in skip:
            continue
        g.poly(mat, f, col, hint=vsub(centroid(f), cen))


def sign_quad(g, mat, centre, right, up, w, h, col=(1.0, 1.0, 1.0)):
    """A sign face: a w x h quad about `centre`, facing right x up, with 0..1 UVs (u to the viewer's right, v up)."""
    r, u = vmul(vnorm(right), w / 2), vmul(vnorm(up), h / 2)
    p0 = vsub(vsub(centre, r), u)
    p1 = vsub(vadd(centre, r), u)
    p2 = vadd(vadd(centre, r), u)
    p3 = vadd(vsub(centre, r), u)
    g.poly(mat, [p0, p1, p2, p3], col, hint=vcross(right, up), uvs=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])


def prism_x(g, mat, profile, x0, x1, col, caps=True, cap_mat=None, side_col=None):
    """A closed profile of (z, y) points extruded along X from x0 to x1. `col`: a colour or a function of the point;
    `side_col(i)` instead colours side i (profile[i] to [i+1]), and the caps with side_col(-1)."""
    n = len(profile)
    a = 0.0
    for i in range(n):
        p, q = profile[i], profile[(i + 1) % n]
        a += p[0] * q[1] - q[0] * p[1]
    s = 1.0 if a > 0 else -1.0
    for i in range(n):
        (z0, y0), (z1, y1) = profile[i], profile[(i + 1) % n]
        dz, dy = z1 - z0, y1 - y0
        if abs(dz) + abs(dy) < 1e-9:
            continue
        out = (0.0, -dz * s, dy * s)   # the outward normal in (x, y, z)
        c = side_col(i) if side_col else col
        g.poly(mat, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)], c, hint=out)
    if caps:
        cc = side_col(-1) if side_col else col
        g.poly(cap_mat or mat, [(x0, y, z) for z, y in profile], cc, hint=(-1.0, 0.0, 0.0))
        g.poly(cap_mat or mat, [(x1, y, z) for z, y in profile], cc, hint=(1.0, 0.0, 0.0))


def prism_y(g, mat, ring, y0, y1, col, top=True, bottom=False, top_mat=None, side_col=None):
    """A ring of (x, z) points extruded up from y0 to y1 (any winding). `col`: a colour or a function of the point;
    `side_col(i)` instead colours side i (and the caps with side_col(-1))."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        p, q = ring[i], ring[(i + 1) % n]
        a += p[0] * q[1] - q[0] * p[1]
    s = 1.0 if a > 0 else -1.0
    for i in range(n):
        (x0, z0), (x1, z1) = ring[i], ring[(i + 1) % n]
        out = ((z1 - z0) * s, 0.0, -(x1 - x0) * s)
        c = side_col(i) if side_col else col
        g.poly(mat, [(x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0)], c, hint=out)
    cc = side_col(-1) if side_col else col
    if top:
        g.poly(top_mat or mat, [(x, y1, z) for x, z in ring], cc, hint=(0.0, 1.0, 0.0))
    if bottom:
        g.poly(top_mat or mat, [(x, y0, z) for x, z in ring], cc, hint=(0.0, -1.0, 0.0))


def chamfer_rect(hx, hz, c):
    """A rectangle's ring (x, z) with its corners cut by c."""
    return [(hx, -hz + c), (hx, hz - c), (hx - c, hz), (-hx + c, hz), (-hx, hz - c), (-hx, -hz + c), (-hx + c, -hz), (hx - c, -hz)]


def _frame(axis):
    ax = vnorm(axis)
    ref = (0.0, 1.0, 0.0) if abs(ax[1]) < 0.9 else (1.0, 0.0, 0.0)
    u = vnorm(vcross(ref, ax))
    v = vcross(ax, u)
    return ax, u, v


def revolve(g, mat, centre, axis, profile, n, col, phase=0.0, smooth=True):
    """A profile of (r, t) points (r from the axis, t along it from `centre`) revolved `n` times about `axis`. Trace a solid's
    profile from the axis at its low end, round the outside, back to the axis at its high end: the faces point outwards.
    Smooth round the axis (radial normals), flat along the profile. `col(k)` colours segment k."""
    ax, u, v = _frame(axis)
    angles = [phase + 2 * math.pi * j / n for j in range(n)]
    dirs = [vadd(vmul(u, math.cos(a)), vmul(v, math.sin(a))) for a in angles]

    def at(r, t, j):
        return vadd(vadd(centre, vmul(ax, t)), vmul(dirs[j], r))

    for k in range(len(profile) - 1):
        (r0, t0), (r1, t1) = profile[k], profile[k + 1]
        dr, dt = r1 - r0, t1 - t0
        if abs(dr) + abs(dt) < 1e-9:
            continue
        ln = math.hypot(dr, dt)
        nr, nt = dt / ln, -dr / ln
        c = col(k) if callable(col) else col
        for j in range(n):
            j2 = (j + 1) % n
            pts = [at(r0, t0, j), at(r0, t0, j2), at(r1, t1, j2), at(r1, t1, j)]
            nm = [vnorm(vadd(vmul(dirs[jj], nr), vmul(ax, nt))) for jj in (j, j2, j2, j)]
            mid = vnorm(vadd(vmul(vnorm(vadd(dirs[j], dirs[j2])), nr), vmul(ax, nt)))
            if r0 < 1e-9:
                pts, nm = [pts[0], pts[2], pts[3]], [nm[0], nm[2], nm[3]]
            elif r1 < 1e-9:
                pts, nm = [pts[0], pts[1], pts[2]], [nm[0], nm[1], nm[2]]
            if abs(nr) < 1e-6 or not smooth:
                nm = None
            g.poly(mat, pts, c, hint=mid, normals=nm)


def tube(g, mat, a, b, r, n, col, caps=True, phase=0.0):
    """A straight round bar from a to b."""
    d = vsub(b, a)
    ln = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
    prof = [(0.0, 0.0), (r, 0.0), (r, ln), (0.0, ln)] if caps else [(r, 0.0), (r, ln)]
    revolve(g, mat, a, d, prof, n, col, phase=phase)


def polyline_tube(g, mat, pts, r, n, col):
    """A bent bar through points (a grab rail with its drops): straight tubes joined at the corners."""
    for i in range(len(pts) - 1):
        tube(g, mat, pts[i], pts[i + 1], r, n, col, caps=(i == 0 or i == len(pts) - 2))


# ---------------------------------------------------------------------------------------------- face grids
def grid(g, plane, us, vs, cell, hint, umin=None, umax=None):
    """A planar face cut into cells: `plane(u, v)` -> 3D point; `us`, `vs` the sorted breakpoints; `cell(i, j, u0, u1, v0, v1)`
    -> (material, colour) or None for a hole. `umin(v)`/`umax(v)` replace the outer columns' edges (an outline that narrows:
    a car's end under its roof). Every cell is its own quad, so neighbours share their corners (no T-junctions)."""
    for j in range(len(vs) - 1):
        v0, v1 = vs[j], vs[j + 1]
        if v1 - v0 < 1e-6:
            continue
        for i in range(len(us) - 1):
            u0, u1 = us[i], us[i + 1]
            if u1 - u0 < 1e-6:
                continue
            got = cell(i, j, u0, u1, v0, v1)
            if got is None:
                continue
            mat, col = got
            a0, a1 = u0, u0
            b0, b1 = u1, u1
            if i == 0 and umin is not None:
                a0, a1 = umin(v0), umin(v1)
            if i == len(us) - 2 and umax is not None:
                b0, b1 = umax(v0), umax(v1)
            pts = [plane(a0, v0), plane(b0, v0), plane(b1, v1), plane(a1, v1)]
            if abs(b0 - a0) < 1e-6:
                pts = [pts[0], pts[2], pts[3]]
            elif abs(b1 - a1) < 1e-6:
                pts = [pts[0], pts[1], pts[2]]
            g.poly(mat, pts, col, hint=hint)


def interp(points, y):
    """x at height y along a polyline of (x, y) points with y rising."""
    for i in range(len(points) - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        if y0 - 1e-9 <= y <= y1 + 1e-9:
            t = 0.0 if y1 == y0 else (y - y0) / (y1 - y0)
            return x0 + (x1 - x0) * t
    return points[-1][0] if y > points[-1][1] else points[0][0]


# ---------------------------------------------------------------------------------------------- ambient occlusion
def hemisphere(n):
    """n directions over the +Z hemisphere (cosine-weighted Fibonacci spiral): fixed, no randomness."""
    out = []
    for i in range(n):
        t = (i + 0.5) / n
        r = math.sqrt(t)
        a = i * 2.399963229728653
        out.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1.0 - t))))
    return out


def bake_ao(items, dist, rays=20, skip=('tr_glass', 'tr_light', 'tr_lightface', 'tr_screen'), extra=(), strength=1.0, floor=0.25):
    """Writes occlusion into the alpha of every vertex of `items` (a list of Geo, all in one frame): the share of a short
    hemisphere of rays (out to `dist`) that hits an opaque surface of any of them. `extra` adds occluders only (a ground)."""
    verts, polys = [], []
    for g in items:
        for mat in sorted(g.parts):
            if mat in skip:
                continue
            part = g.parts[mat]
            base = len(verts)
            verts.extend(Vector(p) for p in part.p)
            polys.extend((a + base, b + base, c + base) for a, b, c in part.t)
    for tri in extra:
        base = len(verts)
        verts.extend(Vector(p) for p in tri)
        polys.append((base, base + 1, base + 2))
    if not polys:
        return
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=True)
    hemi = hemisphere(rays)
    for g in items:
        for mat in sorted(g.parts):
            part = g.parts[mat]
            for i, p in enumerate(part.p):
                c = part.c[i]
                if mat in skip:
                    part.c[i] = (c[0], c[1], c[2], 1.0)
                    continue
                n = Vector(part.n[i])
                if n.length < 1e-6:
                    continue
                n.normalize()
                t = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
                b = n.cross(t)
                o = Vector(p) + n * 0.006
                occ = 0.0
                for (x, y, z) in hemi:
                    hit = bvh.ray_cast(o, t * x + b * y + n * z, dist)
                    if hit[0] is not None:
                        occ += 1.0 - hit[3] / dist
                a = max(floor, 1.0 - strength * occ / len(hemi))
                part.c[i] = (c[0], c[1], c[2], round(a * c[3], 4))


# ---------------------------------------------------------------------------------------------- output
def material(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    return m


def tris(g):
    return sum(len(p.t) for p in g.parts.values())


def emit(name, g, parent, pivot=(0.0, 0.0, 0.0), wrap=False, props=None):
    """A Blender object for one piece. Its vertices are taken relative to `pivot`; with `wrap` the named node is an empty at
    the pivot (props in its extras) holding the mesh as `<name>_mesh`. Returns the named object (None when empty)."""
    ox, oy, oz = pivot
    P, N, C, UV, F, M, mats = [], [], [], [], [], [], []
    for mat in MATERIALS:
        part = g.parts.get(mat)
        if part is None or not part.t:
            continue
        base = len(P)
        k = len(mats)
        mats.append(mat)
        P.extend(tuple(to_bl(p[0] - ox, p[1] - oy, p[2] - oz)) for p in part.p)
        N.extend(tuple(to_bl(*n)) for n in part.n)
        C.extend(part.c)
        UV.extend(part.uv)
        F.extend((a + base, b + base, c + base) for a, b, c in part.t)
        M.extend([k] * len(part.t))
    if not F:
        return None
    mesh_name = f'{name}_mesh' if wrap else name
    me = bpy.data.meshes.new(mesh_name)
    me.from_pydata(P, [], F)
    me.update()
    for poly, k in zip(me.polygons, M):
        poly.material_index = k
    me.normals_split_custom_set_from_vertices(N)
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(C):
        ca.data[i].color = c
    me.color_attributes.active_color = ca
    uvl = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        # the exporter writes v' = 1 - v: store 1 - v so the file holds v as built (sign faces: v = 0 at the bottom edge)
        uv = UV[loop.vertex_index]
        uvl.data[loop.index].uv = (uv[0], 1.0 - uv[1])
    for mat in mats:
        me.materials.append(material(mat))
    if wrap:
        node = scene.empty(name, pos=pivot, parent=parent, props=props)
        ob = bpy.data.objects.new(mesh_name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = node
        return node
    ob = bpy.data.objects.new(mesh_name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = to_bl(*pivot)
    for k, v in (props or {}).items():
        ob[k] = v
    return ob


def bounds(gs):
    lo, hi = [1e9] * 3, [-1e9] * 3
    for g in gs:
        for part in g.parts.values():
            for p in part.p:
                for k in range(3):
                    lo[k] = min(lo[k], p[k])
                    hi[k] = max(hi[k], p[k])
    return lo, hi
