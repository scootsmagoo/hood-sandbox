"""The geometry kit of the airport's vehicles (aircraft.py, ground.py): plain-Python meshes in the game's frame (+X left,
+Y up, +Z forward, metres), welded and deterministic (no sets, no randomness, no bmesh operators), self-contained so a change
to another family's kit cannot move these files.

  Geo        triangles per material; `poly` takes any planar-ish polygon (ear-clipped), drops repeated points (poles)
  sheet      a quad grid of points with per-point normals (lofts, lifting surfaces); `grid_normals` gives smooth ones
  lathe      a profile of (r, t) points revolved about an axis, smooth round it and along the profile except at creases
  tube, box, obox, hexa      bars and blocks
  strip      a thin band lifted off a surface along a polyline (door outlines)
  mirror     the copy across x = 0 (the right-hand half of a symmetric part)
  bake_ao    per-vertex ambient occlusion by ray casts against the opaque parts and the ground (COLOR_0 alpha)
  emit       one Blender mesh per node, one material slot (one glTF primitive) per material, custom normals, COLOR_0

Materials, in slot order (the game swaps each for its own by name):
  ac_paint   painted skin: COLOR_0.r = livery region k/7 (REGIONS), g = 1, b = 1, a = baked occlusion
  ac_grey    unpainted grey (wings, tailplane, fairings): COLOR_0 = linear albedo, a = occlusion
  ac_metal   bare metal (intake lips, struts, leading edges): albedo, occlusion
  ac_dark    tyres, fan faces, wells, shadow gaps: albedo, occlusion
  ac_window  cockpit and cabin glass: albedo, a = 1
  ac_light   lamp lenses: COLOR_0 = the lamp's colour, a = 1
"""
import math

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from hoodlib import scene
from hoodlib.frame import to_bl

MATERIALS = ['ac_paint', 'ac_grey', 'ac_metal', 'ac_dark', 'ac_window', 'ac_light']
REGIONS = {'crown': 0, 'belly': 1, 'fin': 2, 'engine': 3, 'stripe': 4, 'accent': 5}
NO_AO = ('ac_window', 'ac_light')


def paint(region):
    """The COLOR_0 of a painted face: the livery region in red (k/7), green 1."""
    return (REGIONS[region] / 7.0, 1.0, 1.0, 1.0)


def srgb(h):
    """0xRRGGBB to a linear (r, g, b)."""
    out = []
    for sh in (16, 8, 0):
        c = ((h >> sh) & 255) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def shade(c, k):
    return tuple(min(1.0, x * k) for x in c[:3])


# ---------------------------------------------------------------------------------------------- vectors
def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vmul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def vlen(a):
    return math.sqrt(vdot(a, a))


def vnorm(a, fallback=(0.0, 1.0, 0.0)):
    ln = vlen(a)
    return (a[0] / ln, a[1] / ln, a[2] / ln) if ln > 1e-12 else fallback


def vlerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n)


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a) if b != a else 1.0))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def pwl(points, x):
    """Piecewise-linear y(x) through sorted (x, y) points, constant outside."""
    if x <= points[0][0]:
        return points[0][1]
    for i in range(len(points) - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        if x <= x1:
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0) if x1 > x0 else 1.0)
    return points[-1][1]


def newell(pts):
    n = [0.0, 0.0, 0.0]
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return tuple(n)


def triangulate(pts, normal):
    """Ear clipping of a simple polygon of 3D points about `normal` (projected on its dominant plane); CCW about it."""
    n = len(pts)
    if n == 3:
        return [(0, 1, 2)]
    ax = max(range(3), key=lambda k: abs(normal[k]))
    k0, k1 = [(1, 2), (2, 0), (0, 1)][ax]
    sgn = 1.0 if normal[ax] >= 0 else -1.0
    q = [(p[k0] * sgn, p[k1]) for p in pts]
    idx = list(range(n))
    out = []

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-12 and cross(b, c, p) >= -1e-12 and cross(c, a, p) >= -1e-12

    guard = 0
    while len(idx) > 3 and guard < 50000:
        guard += 1
        ear = False
        for i in range(len(idx)):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % len(idx)]
            if cross(q[a], q[b], q[c]) <= 1e-14:
                continue
            if any(inside(q[j], q[a], q[b], q[c]) for j in idx if j not in (a, b, c)):
                continue
            out.append((a, b, c))
            idx.pop(i)
            ear = True
            break
        if not ear:
            i = min(range(len(idx)), key=lambda i: abs(cross(q[idx[i - 1]], q[idx[i]], q[idx[(i + 1) % len(idx)]])))
            out.append((idx[i - 1], idx[i], idx[(i + 1) % len(idx)]))
            idx.pop(i)
    if len(idx) == 3:
        out.append((idx[0], idx[1], idx[2]))
    return out


# ---------------------------------------------------------------------------------------------- geometry
class Part:
    """The welded vertices (position, normal, COLOR_0) and triangles of one material."""

    def __init__(self):
        self.p, self.n, self.c, self.t = [], [], [], []
        self.weld = {}

    def vert(self, p, n, c):
        key = (round(p[0], 4), round(p[1], 4), round(p[2], 4), round(n[0], 3), round(n[1], 3), round(n[2], 3),
               round(c[0], 4), round(c[1], 4), round(c[2], 4), round(c[3], 4))
        i = self.weld.get(key)
        if i is None:
            i = len(self.p)
            self.weld[key] = i
            self.p.append(tuple(p))
            self.n.append(tuple(n))
            self.c.append(tuple(c))
        return i


def _c4(c):
    return (c[0], c[1], c[2], c[3] if len(c) > 3 else 1.0)


class Geo:
    """Triangles per material, in one frame."""

    def __init__(self):
        self.parts = {}

    def part(self, mat):
        if mat not in MATERIALS:
            raise ValueError(f'unknown material {mat}')
        if mat not in self.parts:
            self.parts[mat] = Part()
        return self.parts[mat]

    def tris(self):
        return sum(len(p.t) for p in self.parts.values())

    def poly(self, mat, pts, col, normals=None, hint=None):
        """A polygon of 3D points: repeated points are dropped (a pole), wound CCW seen from `hint` (else as given),
        flat-shaded unless `normals` gives one per point. `col` is a colour or a function of the point."""
        P, N = [], []
        for k, p in enumerate(pts):
            p = (float(p[0]), float(p[1]), float(p[2]))
            if P and vlen(vsub(p, P[-1])) < 1e-6:
                continue
            P.append(p)
            N.append(normals[k] if normals else None)
        while len(P) > 1 and vlen(vsub(P[0], P[-1])) < 1e-6:
            P.pop()
            N.pop()
        if len(P) < 3:
            return
        nw = newell(P)
        if vlen(nw) < 1e-10:
            return
        n = vnorm(nw)
        if hint is not None and vdot(n, hint) < 0:
            P.reverse()
            N.reverse()
            n = (-n[0], -n[1], -n[2])
        part = self.part(mat)
        ids = []
        for k, p in enumerate(P):
            c = col(p) if callable(col) else col
            ids.append(part.vert(p, N[k] if N[k] is not None else n, _c4(c)))
        for a, b, c in triangulate(P, n):
            if ids[a] != ids[b] and ids[b] != ids[c] and ids[a] != ids[c]:
                part.t.append((ids[a], ids[b], ids[c]))

    def add(self, other):
        for mat in MATERIALS:
            op = other.parts.get(mat)
            if op is None:
                continue
            part = self.part(mat)
            ids = [part.vert(op.p[i], op.n[i], op.c[i]) for i in range(len(op.p))]
            for a, b, c in op.t:
                part.t.append((ids[a], ids[b], ids[c]))

    def mirrored(self):
        """The copy across x = 0 (normals mirrored, triangles re-wound)."""
        g = Geo()
        for mat in MATERIALS:
            op = self.parts.get(mat)
            if op is None:
                continue
            part = g.part(mat)
            ids = [part.vert((-op.p[i][0], op.p[i][1], op.p[i][2]), (-op.n[i][0], op.n[i][1], op.n[i][2]), op.c[i]) for i in range(len(op.p))]
            for a, b, c in op.t:
                part.t.append((ids[a], ids[c], ids[b]))
        return g

    def both(self):
        """This part and its mirror image, together."""
        g = Geo()
        g.add(self)
        g.add(self.mirrored())
        return g


def tris(g):
    return g.tris()


def bounds(gs):
    lo, hi = [1e9] * 3, [-1e9] * 3
    for g in gs:
        for part in g.parts.values():
            for p in part.p:
                for k in range(3):
                    lo[k] = min(lo[k], p[k])
                    hi[k] = max(hi[k], p[k])
    return lo, hi


# ---------------------------------------------------------------------------------------------- grids
def grid_normals(P, closed_v=False, flip=False):
    """Smooth normals of a grid P[i][j] (i along u, j along v) by central differences (one-sided at open edges).
    A collapsed row (a pole) takes the direction away from the next row's centre."""
    nu, nv = len(P), len(P[0])
    N = [[None] * nv for _ in range(nu)]
    for i in range(nu):
        i0, i1 = max(0, i - 1), min(nu - 1, i + 1)
        for j in range(nv):
            if closed_v:
                j0, j1 = (j - 1) % nv, (j + 1) % nv
            else:
                j0, j1 = max(0, j - 1), min(nv - 1, j + 1)
            du = vsub(P[i1][j], P[i0][j])
            dv = vsub(P[i][j1], P[i][j0])
            n = vcross(du, dv)
            if vlen(n) < 1e-10:
                # a pole or a fold: away from the neighbouring row's centre
                k = i1 if i1 != i else i0
                d = vsub(centroid(P[i]), centroid(P[k]))
                N[i][j] = vnorm(d) if vlen(d) > 1e-9 else (0.0, 1.0, 0.0)
                continue
            n = vnorm(n)
            N[i][j] = (-n[0], -n[1], -n[2]) if flip else n
    return N


def sheet(g, P, N, cell, closed_v=False):
    """Quads between consecutive rows and columns of the grid; `cell(i, j)` gives (material, colour) or None (a hole)."""
    nu, nv = len(P), len(P[0])
    for i in range(nu - 1):
        for j in range(nv if closed_v else nv - 1):
            got = cell(i, j)
            if got is None:
                continue
            mat, col = got
            j2 = (j + 1) % nv
            pts = [P[i][j], P[i][j2], P[i + 1][j2], P[i + 1][j]]
            nn = [N[i][j], N[i][j2], N[i + 1][j2], N[i + 1][j]]
            hint = vnorm(vadd(vadd(nn[0], nn[1]), vadd(nn[2], nn[3])))
            g.poly(mat, pts, col, normals=nn, hint=hint)


# ---------------------------------------------------------------------------------------------- solids
def frame_of(axis):
    ax = vnorm(axis)
    ref = (0.0, 1.0, 0.0) if abs(ax[1]) < 0.9 else (1.0, 0.0, 0.0)
    u = vnorm(vcross(ref, ax))
    v = vcross(ax, u)
    return ax, u, v


def lathe(g, centre, axis, profile, n, segs, phase=0.0, crease=38.0, smooth_round=True):
    """A profile of (r, t) points (r from the axis, t along `axis` from `centre`) revolved `n` times. Trace a solid's outline
    with its material on the right (from the axis at the low t round the outside): the faces point outwards. `segs[k]` is
    (material, colour) of segment k (profile[k] to profile[k + 1]), or None to leave it out. Normals are smooth round the axis
    and along the profile, except where two segments meet at more than `crease` degrees."""
    ax, u, v = frame_of(axis)
    dirs = [vadd(vmul(u, math.cos(phase + 2 * math.pi * j / n)), vmul(v, math.sin(phase + 2 * math.pi * j / n))) for j in range(n)]
    m = len(profile)
    sn = []
    for k in range(m - 1):
        (r0, t0), (r1, t1) = profile[k], profile[k + 1]
        dr, dt = r1 - r0, t1 - t0
        ln = math.hypot(dr, dt)
        sn.append((dt / ln, -dr / ln) if ln > 1e-12 else None)
    cosc = math.cos(math.radians(crease))

    def vn(k, seg):
        """The (radial, axial) normal at profile point k for segment `seg` (k or k - 1)."""
        own = sn[seg]
        other_seg = seg - 1 if k == seg else seg + 1
        if 0 <= other_seg < m - 1 and sn[other_seg] is not None and own is not None:
            o = sn[other_seg]
            if own[0] * o[0] + own[1] * o[1] >= cosc:
                a = (own[0] + o[0], own[1] + o[1])
                ln = math.hypot(*a)
                return (a[0] / ln, a[1] / ln)
        return own

    for k in range(m - 1):
        if segs[k] is None or sn[k] is None:
            continue
        mat, col = segs[k]
        (r0, t0), (r1, t1) = profile[k], profile[k + 1]
        n0, n1 = vn(k, k), vn(k + 1, k)
        for j in range(n):
            j2 = (j + 1) % n

            def at(r, t, jj):
                return vadd(vadd(centre, vmul(ax, t)), vmul(dirs[jj], r))

            def nrm(nr, jj, mid=False):
                d = vnorm(vadd(dirs[j], dirs[j2])) if (mid or not smooth_round) else dirs[jj]
                return vnorm(vadd(vmul(d, nr[0]), vmul(ax, nr[1])))

            pts = [at(r0, t0, j), at(r0, t0, j2), at(r1, t1, j2), at(r1, t1, j)]
            nm = [nrm(n0, j), nrm(n0, j2), nrm(n1, j2), nrm(n1, j)]
            hint = vnorm(vadd(vmul(vnorm(vadd(dirs[j], dirs[j2])), sn[k][0]), vmul(ax, sn[k][1])))
            g.poly(mat, pts, col, normals=nm, hint=hint)


def tube(g, mat, a, b, r, n, col, caps=True, phase=0.0, r1=None):
    """A straight round bar from a to b (radius r, or r to r1: a taper)."""
    d = vsub(b, a)
    ln = vlen(d)
    if ln < 1e-6:
        return
    r1 = r if r1 is None else r1
    prof = [(0.0, 0.0), (r, 0.0), (r1, ln), (0.0, ln)] if caps else [(r, 0.0), (r1, ln)]
    segs = [(mat, col)] * (len(prof) - 1)
    lathe(g, a, d, prof, n, segs, phase=phase)


def hexa(g, mat, c, col, skip=()):
    """A six-sided solid from 8 corners: c[0..3] one face, c[4..7] the opposite one (corner k opposite k + 4)."""
    cen = centroid(c)
    faces = {'a': [c[0], c[1], c[2], c[3]], 'b': [c[4], c[5], c[6], c[7]],
             's0': [c[0], c[1], c[5], c[4]], 's1': [c[1], c[2], c[6], c[5]], 's2': [c[2], c[3], c[7], c[6]], 's3': [c[3], c[0], c[4], c[7]]}
    for k, f in faces.items():
        if k in skip:
            continue
        g.poly(mat, f, col, hint=vsub(centroid(f), cen))


def box(g, mat, lo, hi, col, skip=()):
    """An axis-aligned box from its min and max corners; `skip` names faces left out ('-x', '+x', '-y', '+y', '-z', '+z')."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    faces = {
        '-x': [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
        '+x': [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
        '-y': [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
        '+y': [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
        '-z': [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)],
        '+z': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
    }
    cen = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    for k, f in faces.items():
        if k in skip:
            continue
        g.poly(mat, f, col, hint=vsub(centroid(f), cen))


def obox(g, mat, c, ex, ey, ez, col, skip=()):
    """An oriented box: centre c and its three half-extent vectors."""
    corners = []
    for sz in (-1, 1):
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corners.append(vadd(vadd(vadd(c, vmul(ex, sx)), vmul(ey, sy)), vmul(ez, sz)))
    hexa(g, mat, corners, col, skip=skip)


def beam(g, mat, a, b, w, d, col, up=(0.0, 1.0, 0.0), caps=True):
    """A rectangular bar (w across, d deep) from a to b."""
    t = vsub(b, a)
    if vlen(t) < 1e-6:
        return
    t = vnorm(t)
    ref = up if abs(vdot(t, up)) < 0.95 else (1.0, 0.0, 0.0)
    s = vmul(vnorm(vcross(t, ref)), w / 2)
    h = vmul(vnorm(vcross(t, s)), d / 2)
    c = vmul(vadd(a, b), 0.5)
    half = vmul(vsub(b, a), 0.5)
    obox(g, mat, c, s, h, half, col, skip=() if caps else ('a', 'b'))


def strip(g, mat, pts, normals, width, lift, col):
    """A thin band of `width` along a polyline on a surface, lifted `lift` along the surface normals (an outline)."""
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        na, nb = normals[k], normals[k + 1]
        t = vnorm(vsub(b, a))
        sa = vmul(vnorm(vcross(na, t)), width / 2)
        sb = vmul(vnorm(vcross(nb, t)), width / 2)
        pa, pb = vadd(a, vmul(na, lift)), vadd(b, vmul(nb, lift))
        quad = [vsub(pa, sa), vsub(pb, sb), vadd(pb, sb), vadd(pa, sa)]
        g.poly(mat, quad, col, normals=[na, nb, nb, na], hint=vnorm(vadd(na, nb)))


# ---------------------------------------------------------------------------------------------- ambient occlusion
def hemisphere(n):
    """n fixed directions over +Z (cosine-weighted Fibonacci spiral)."""
    out = []
    for i in range(n):
        t = (i + 0.5) / n
        r = math.sqrt(t)
        a = i * 2.399963229728653
        out.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1.0 - t))))
    return out


def bake_ao(items, dist, rays=16, ground=True, strength=1.0, floor=0.3, ground_size=200.0):
    """Writes occlusion into COLOR_0 alpha of every vertex of `items` (Geos in one frame): the share of a hemisphere of rays
    out to `dist` that hit an opaque surface of any of them (or the ground at y = 0). Glass and lenses keep alpha 1."""
    verts, polys = [], []
    for g in items:
        for mat in MATERIALS:
            part = g.parts.get(mat)
            if part is None or mat in NO_AO:
                continue
            base = len(verts)
            verts.extend(Vector(p) for p in part.p)
            polys.extend((a + base, b + base, c + base) for a, b, c in part.t)
    if ground:
        s = ground_size
        base = len(verts)
        verts.extend([Vector((-s, 0.0, -s)), Vector((s, 0.0, -s)), Vector((s, 0.0, s)), Vector((-s, 0.0, s))])
        polys.extend([(base, base + 1, base + 2), (base, base + 2, base + 3)])
    if not polys:
        return
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=True)
    hemi = hemisphere(rays)
    for g in items:
        for mat in MATERIALS:
            part = g.parts.get(mat)
            if part is None:
                continue
            for i, p in enumerate(part.p):
                c = part.c[i]
                if mat in NO_AO:
                    part.c[i] = (c[0], c[1], c[2], 1.0)
                    continue
                n = Vector(part.n[i])
                if n.length < 1e-6:
                    continue
                n.normalize()
                t = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
                b = n.cross(t)
                o = Vector(p) + n * 0.004
                occ = 0.0
                for (x, y, z) in hemi:
                    hit = bvh.ray_cast(o, t * x + b * y + n * z, dist)
                    if hit[0] is not None:
                        occ += 1.0 - hit[3] / dist
                a = max(floor, 1.0 - strength * occ / len(hemi))
                part.c[i] = (c[0], c[1], c[2], round(a, 3))


def flat_ao(items, fn):
    """A cheap occlusion for the far level: alpha = fn(point, normal)."""
    for g in items:
        for mat in MATERIALS:
            part = g.parts.get(mat)
            if part is None:
                continue
            for i, p in enumerate(part.p):
                c = part.c[i]
                part.c[i] = (c[0], c[1], c[2], 1.0 if mat in NO_AO else round(fn(p, part.n[i]), 3))


# ---------------------------------------------------------------------------------------------- output
def material(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    return m


def emit(name, g, parent, pivot=(0.0, 0.0, 0.0), props=None):
    """One Blender mesh object for a Geo: one material slot per material it uses (in MATERIALS order), the vertices taken
    relative to `pivot` (the object sits there), custom normals, COLOR_0 from a float colour attribute. None when empty."""
    ox, oy, oz = pivot
    P, N, C, F, M, mats = [], [], [], [], [], []
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
        F.extend((a + base, b + base, c + base) for a, b, c in part.t)
        M.extend([k] * len(part.t))
    if not F:
        return None
    me = bpy.data.meshes.new(name)
    me.from_pydata(P, [], F)
    me.update()
    for poly, k in zip(me.polygons, M):
        poly.material_index = k
    me.normals_split_custom_set_from_vertices(N)
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(C):
        ca.data[i].color = c
    me.color_attributes.active_color = ca
    for mat in mats:
        me.materials.append(material(mat))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = to_bl(*pivot)
    for k, v in (props or {}).items():
        ob[k] = v
    return ob


def empty(name, pos=(0.0, 0.0, 0.0), parent=None, props=None):
    return scene.empty(name, pos, parent, props)
