"""A plain-Python geometry kit for the hero landmarks, in game coordinates (+X east, +Y up, +Z south: the
frame the .glb is read in, so what a script writes is what three.js loads).

A landmark is built in a frame whose origin is its *anchor* (a game point, see footprints.json) at the
ground datum, axes not rotated, so the real footprint is drawn as it is and the model needs no yaw.
Each landmark script fills one `Lod` per level of detail through the helpers below; `emit()` turns them
into Blender objects named `lod<N>_<material>` for the glTF exporter.

Materials are named for what the game does with them (src/client/render/Landmarks.ts):

  bld_wall    a facade: the look's window shader lays floors, bays and lit rooms over it, from the same
              per-vertex data the baked tile has (_WALL, _BLD, _BID, TEXCOORD_0), so a hero tower is lit and
              dirtied like any other building
  bld_glass   the same for a glass curtain wall (mirror windows reflecting the sky)
  bld_roof    flat roofs (the look's roof patch: grime, gravel)
  lm_stone    dressed stone, concrete and painted panels (rough, vertex-coloured, a little grime in the shader)
  lm_flood    stone that is floodlit after dark, warm (the Capitol's columns and drum)
  lm_lit      a pale surface lit from within after dark, cool (the stadium's roof)
  lm_metal    steel, aluminium, cladding (mid metalness)
  lm_gold     gilding (the Capitol's dome)
  lm_glass    glazing that is not a facade: skylights, canopies, domes, the stadium's glass wings
  lm_glow     emissive at night, plain by day (rings, halos, lanterns, floodlit crowns): colour is the vertex colour
  lm_dark     black glazing, shadow gaps, tyres: unlit dark
  lm_water    animated water jets (the fountain): COLOR_0 is data, not albedo: r = height along the jet (0 foot, 1 tip),
              g = the jet's phase in its show; the shader moves the vertices (Landmarks.ts)
  lm_interior an indoor surface (walls, ceilings, counters, seats): lit from within all day (it does not go dark in the roof's shadow)
  lm_floor    an indoor floor: polished terrazzo or carpet, lit from within, a soft sheen
  lm_window   see-through glazing (a hall's windows onto the apron): tinted, transparent, drawn both sides
  lm_screen   emissive panels (departure boards, shop signs without lettering): colour is the vertex colour, bright day and night

A model may have moving parts: `Lod.child(name, pivot, props)` makes a sub-level whose geometry (written in the model frame
like the rest) is exported as an empty `lod<N>_<name>` at `pivot` with the meshes under it, so the game can turn or scale it
about that point. `props` go to the node's glTF extras (what the game reads to drive it: see Landmarks.ts, "animated parts").

COLOR_0 is the albedo (linear) and its alpha the baked ambient occlusion (as the tile's).
Everything here is deterministic: no sets, no randomness.
"""
import math

import bpy
from mathutils import Vector

from hoodlib.frame import to_bl

MATERIALS = ['bld_wall', 'bld_glass', 'bld_roof', 'lm_stone', 'lm_flood', 'lm_lit', 'lm_metal', 'lm_gold', 'lm_glass', 'lm_glow', 'lm_dark', 'lm_water',
             # interiors (the airport's walk-in halls, tools/blender/airport): lit from within by day and night, a polished floor, see-through
             # windows, emissive screens and signs
             'lm_interior', 'lm_floor', 'lm_window', 'lm_screen']

# building kind ids (tools/pipeline/src/world/classify.ts BUILDING_KINDS)
K_GENERIC, K_OFFICE, K_GLASS, K_BRICK, K_PARKING, K_RETAIL, K_CIVIC, K_RELIGIOUS, K_INDUSTRIAL, K_RESID, K_HOUSE, K_SMALL, K_VENUE = range(13)


def srgb(h):
    """0xRRGGBB to a linear (r, g, b)."""
    out = []
    for sh in (16, 8, 0):
        c = ((h >> sh) & 255) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def shade(c, k):
    return tuple(min(1.0, x * k) for x in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a) if b != a else 1.0))
    return t * t * (3 - 2 * t)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    ln = math.sqrt(_dot(a, a))
    return (a[0] / ln, a[1] / ln, a[2] / ln) if ln > 1e-12 else (0.0, 1.0, 0.0)


def newell(pts):
    n = [0.0, 0.0, 0.0]
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return _norm(tuple(n))


def area2(ring):
    """Signed area (x, z) of a 2D ring."""
    a = 0.0
    for i in range(len(ring)):
        p, q = ring[i], ring[(i + 1) % len(ring)]
        a += p[0] * q[1] - q[0] * p[1]
    return a / 2


def triangulate(pts, normal):
    """Ear clipping of a simple polygon of 3D points that lie in a plane with `normal`; indices CCW about the normal."""
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
        return cross(a, b, p) >= -1e-9 and cross(b, c, p) >= -1e-9 and cross(c, a, p) >= -1e-9

    guard = 0
    while len(idx) > 3 and guard < 20000:
        guard += 1
        ear = False
        for i in range(len(idx)):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % len(idx)]
            if cross(q[a], q[b], q[c]) <= 1e-12:
                continue
            if any(inside(q[j], q[a], q[b], q[c]) for j in idx if j not in (a, b, c)):
                continue
            out.append((a, b, c))
            idx.pop(i)
            ear = True
            break
        if not ear:
            # degenerate: clip the flattest vertex
            i = min(range(len(idx)), key=lambda i: abs(cross(q[idx[i - 1]], q[idx[i]], q[idx[(i + 1) % len(idx)]])))
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % len(idx)]
            out.append((a, b, c))
            idx.pop(i)
    if len(idx) == 3:
        out.append((idx[0], idx[1], idx[2]))
    return out


class Part:
    """The vertices and triangles of one material at one level of detail."""

    def __init__(self):
        self.p, self.n, self.c, self.uv, self.w, self.b, self.d, self.t = [], [], [], [], [], [], [], []
        self.weld = {}

    def vert(self, p, n, c, uv, w, b, d):
        key = (round(p[0], 3), round(p[1], 3), round(p[2], 3), round(n[0], 2), round(n[1], 2), round(n[2], 2), tuple(round(x, 3) for x in c),
               round(uv[0], 3), round(uv[1], 3), w, b, d)
        i = self.weld.get(key)
        if i is None:
            i = len(self.p)
            self.weld[key] = i
            self.p.append(p)
            self.n.append(n)
            self.c.append(c)
            self.uv.append(uv)
            self.w.append(w)
            self.b.append(b)
            self.d.append(d)
        return i


class Lod:
    """One level of detail: geometry per material."""

    def __init__(self, index):
        self.index = index
        self.parts = {}
        self.floor_h = 4.0
        self.children = {}   # name -> (Lod, pivot, props): a moving part

    def child(self, name, pivot, props=None):
        """A sub-level for a moving part: its geometry is in the model frame; the export puts it under an empty `lod<N>_<name>`
        at `pivot` (vertices relative to it)."""
        c = Lod(self.index)
        c.floor_h = self.floor_h
        self.children[name] = (c, tuple(pivot), dict(props or {}))
        return c

    def part(self, mat):
        if mat not in self.parts:
            self.parts[mat] = Part()
        return self.parts[mat]

    def tris(self):
        return sum(len(p.t) for p in self.parts.values()) + sum(c.tris() for c, _, _ in self.children.values())

    def all_parts(self):
        """Every part of the level, the moving parts' included."""
        yield from self.parts.values()
        for c, _, _ in self.children.values():
            yield from c.all_parts()

    def merge(self, other, a=0.0, ox=0.0, oz=0.0, dy=0.0):
        """Adds another Lod's geometry, turned by `a` (the frame of `to_world`) about the origin, then moved by (ox, dy, oz).
        Facade data (metres along the wall) is unchanged by a turn."""
        c, s = math.cos(a), math.sin(a)
        for mat, op in other.parts.items():
            part = self.part(mat)
            ids = []
            for i in range(len(op.p)):
                p, n = op.p[i], op.n[i]
                q = (ox + p[0] * c - p[2] * s, p[1] + dy, oz + p[0] * s + p[2] * c)
                nn = (n[0] * c - n[2] * s, n[1], n[0] * s + n[2] * c)
                w = op.w[i]
                if w is not None and dy:
                    w = (w[0], w[1], w[2] + dy, w[3] + dy)
                uv = op.uv[i]
                if w is not None and dy:
                    uv = (uv[0], uv[1] + dy)
                ids.append(part.vert(q, nn, op.c[i], uv, w, op.b[i], op.d[i]))
            for t in op.t:
                part.t.append((ids[t[0]], ids[t[1]], ids[t[2]]))

    # ------------------------------------------------------------------ polygons
    def poly(self, mat, pts, col, hint=None, normals=None, ao=None, uvs=None, wall=None, bld=None, bid=(0, 0), flip=False):
        """A planar polygon (3 or more points). `hint` is the direction it must face (it is wound CCW seen from there);
        `normals` smooth per-point normals (else the face normal). `ao`: a function of the point giving the baked
        occlusion (alpha), default 1. `wall`/`bld`: the facade data (see `facade_quad`)."""
        pts = [tuple(float(x) for x in p) for p in pts]
        n = newell(pts)
        if hint is not None and _dot(n, hint) < 0:
            flip = not flip
        order = list(range(len(pts)))
        if flip:
            order.reverse()
            n = (-n[0], -n[1], -n[2])
        pp = [pts[i] for i in order]
        nn = [normals[i] for i in order] if normals else [n] * len(pp)
        uu = [uvs[i] for i in order] if uvs else [(0.0, 0.0)] * len(pp)
        part = self.part(mat)
        ids = []
        for k, p in enumerate(pp):
            c = col(p) if callable(col) else col
            a = 1.0 if ao is None else ao(p)
            ids.append(part.vert(p, nn[k], (c[0], c[1], c[2], a), uu[k], wall, bld, bid))
        for a, b, c in triangulate(pp, n):
            if len({ids[a], ids[b], ids[c]}) == 3:  # a pole of a lathe collapses a quad: no degenerate triangles
                part.t.append((ids[a], ids[b], ids[c]))

    def quad(self, mat, a, b, c, d, col, hint=None, **kw):
        self.poly(mat, [a, b, c, d], col, hint=hint, **kw)

    def tri(self, mat, a, b, c, col, hint=None, **kw):
        self.poly(mat, [a, b, c], col, hint=hint, **kw)

    # ------------------------------------------------------------------ facades
    def facade_quad(self, mat, p0, p1, p2, p3, col, u0, kind, floors, band=0, era=3, fid=0, ao=True, hint=None, flags=0):
        """A facade quad: p0 and p1 along the bottom (left to right seen from outside), p3 above p0 and p2 above p1.
        The shader reads `u` (metres along the wall, `u0` at p0), `v` (y), the quad's span and the building data
        (kind, era, floors, ground band in decimetres). Several quads of one wall share the floors' count."""
        ln = math.hypot(p1[0] - p0[0], p1[2] - p0[2])
        ys = [p0[1], p1[1], p2[1], p3[1]]
        wall = (round(u0, 3), round(ln, 3), round(min(ys), 3), round(max(ys), 3))
        bld = (kind, era, max(1, min(255, int(floors))), int(round(band * 10)))
        us = [u0, u0 + ln, u0 + ln, u0]
        uvs = [(us[i], ys[i]) for i in range(4)]
        occ = (lambda p: 0.55 + 0.45 * smoothstep(0.0, 14.0, p[1])) if ao else None
        self.poly(mat, [p0, p1, p2, p3], col, hint=hint, ao=occ, uvs=uvs, wall=wall, bld=bld, bid=(fid & 0xFFFF, flags))

    def ring_walls(self, mat, ring, y0, y1, col, kind, floor_h=None, band=0.0, era=3, fid=0, ao=True, taper=None, flags=0, centre=(0.0, 0.0)):
        """Facade quads round a ring of (x, z) points (any winding, closed implicitly) from y0 to y1; `u` is continuous
        round the ring. `taper(y) -> (scale, dx, dz)` leans the walls (a cone's slope): the top ring is `ring` scaled
        by `taper(y1)` about the origin. `floor_h` the storey height, `band` the ground floor's."""
        fh = floor_h or self.floor_h
        floors = max(1, int(round((y1 - y0 - band) / fh)))
        s = 1.0 if area2(ring) > 0 else -1.0
        u = 0.0
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            dx, dz = b[0] - a[0], b[1] - a[1]
            out = (dz * s, 0.0, -dx * s)
            sc0, sc1 = (1.0, 1.0) if taper is None else (taper(y0), taper(y1))
            c0 = col(a, b) if callable(col) else col
            ox, oz = centre

            def at(p, sc, y):
                return (ox + (p[0] - ox) * sc, y, oz + (p[1] - oz) * sc)

            self.facade_quad(mat, at(a, sc0, y0), at(b, sc0, y0), at(b, sc1, y1), at(a, sc1, y1), c0, u, kind, floors, band, era, fid, ao, hint=out, flags=flags)
            u += math.hypot(dx, dz) * sc0

    def cap(self, mat, ring, y, col, up=True, ao=None):
        """A flat polygon over a ring at height y (a roof, a floor)."""
        self.poly(mat, [(p[0], y, p[1]) for p in ring], col, hint=(0, 1 if up else -1, 0), ao=ao)

    def prism(self, wall_mat, ring, y0, y1, wall_col, roof_col, kind, floor_h=None, band=0.0, era=3, fid=0, roof_mat='bld_roof', cap=True, ao=True):
        self.ring_walls(wall_mat, ring, y0, y1, wall_col, kind, floor_h, band, era, fid, ao)
        if cap:
            self.cap(roof_mat, ring, y1, roof_col)

    # ------------------------------------------------------------------ solids of plain materials
    def box(self, mat, c, size, col, rot=0.0, y_is_base=False, skip=(), ao=None):
        """A box: centre c (or the centre of its base when y_is_base), full size, turned `rot` about Y. `skip` names faces
        left out ('+x', '-x', '+y', '-y', '+z', '-z'). `col` can be one colour or a function of the point."""
        cx, cy, cz = c
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        if y_is_base:
            cy += hy
        s, co = math.sin(rot), math.cos(rot)

        def at(x, y, z):
            return (cx + x * co + z * s, cy + y, cz - x * s + z * co)

        faces = {
            '+x': [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)],
            '-x': [(-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz), (-hx, -hy, -hz)],
            '+y': [(-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz)],
            '-y': [(-hx, -hy, hz), (-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz)],
            '+z': [(hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz), (-hx, -hy, hz)],
            '-z': [(-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz), (hx, -hy, -hz)],
        }
        for name, corners in faces.items():
            if name in skip:
                continue
            self.poly(mat, [at(*q) for q in corners], col, hint=_sub(at(*[sum(v) / 4 for v in zip(*corners)]), (cx, cy, cz)), ao=ao)

    def skin(self, mat, rings, col, closed=True, smooth=False, inside=None, ao=None, flip=False):
        """Quads between consecutive rings of 3D points (all the same length). `inside` is a point the surface faces away
        from (a solid's axis point per ring is used when None: the ring's mean). `smooth` averages normals round the
        rings. `col(i, j, p)` or a colour."""
        nr = len(rings)
        m = len(rings[0])
        # smooth normals per vertex
        norms = None
        if smooth:
            norms = [[(0.0, 0.0, 0.0)] * m for _ in range(nr)]
            for i in range(nr):
                for j in range(m):
                    j1, j0 = (j + 1) % m, (j - 1) % m
                    t = _sub(rings[i][j1], rings[i][j0])
                    ip, im = min(nr - 1, i + 1), max(0, i - 1)
                    u = _sub(rings[ip][j], rings[im][j])
                    nv = _norm(_cross(t, u))
                    norms[i][j] = nv
        for i in range(nr - 1):
            cen = (sum(p[0] for p in rings[i]) / m, sum(p[1] for p in rings[i]) / m, sum(p[2] for p in rings[i]) / m)
            for j in range(m if closed else m - 1):
                j2 = (j + 1) % m
                a, b, c, d = rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]
                cc = col(i, j, a) if callable(col) else col
                mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2)
                ref = inside if inside is not None else cen
                hint = _sub(mid, ref)
                kw = {}
                if smooth:
                    # degenerate quads (a pole) fall back to a triangle
                    kw['normals'] = [norms[i][j], norms[i][j2], norms[i + 1][j2], norms[i + 1][j]]
                if _dot(hint, hint) < 1e-12:
                    continue
                if _dist(a, d) < 1e-6:
                    self.poly(mat, [a, b, c], cc, hint=hint, ao=ao, **({'normals': kw['normals'][:3]} if smooth else {}), flip=flip)
                elif _dist(b, c) < 1e-6:
                    self.poly(mat, [a, b, d], cc, hint=hint, ao=ao, **({'normals': [kw['normals'][0], kw['normals'][1], kw['normals'][3]]} if smooth else {}), flip=flip)
                else:
                    self.poly(mat, [a, b, c, d], cc, hint=hint, ao=ao, flip=flip, **kw)

    def lathe(self, mat, profile, n, col, cx=0.0, cz=0.0, smooth=True, phase=0.0, ao=None, ring_fn=None):
        """A solid of revolution about the vertical axis through (cx, cz), from (radius, y) points bottom to top. `ring_fn(r, y, a)`
        may move a point (an ellipse: scale x). Colour: a colour or `col(k)` of the profile index."""
        rings = []
        for r, y in profile:
            ring = []
            for j in range(n):
                a = phase + 2 * math.pi * j / n
                x, z = r * math.cos(a), r * math.sin(a)
                if ring_fn:
                    x, z = ring_fn(r, y, a, x, z)
                ring.append((cx + x, y, cz + z))
            rings.append(ring)
        for i in range(len(rings) - 1):
            colf = (lambda ii, jj, pp, i=i: col(i)) if callable(col) else col
            self.skin(mat, [rings[i], rings[i + 1]], colf, smooth=False, inside=(cx, (profile[i][1] + profile[i + 1][1]) / 2, cz), ao=ao)
        return rings

    def disc(self, mat, cx, y, cz, r, n, col, up=True, ao=None):
        pts = [(cx + r * math.cos(2 * math.pi * j / n), y, cz + r * math.sin(2 * math.pi * j / n)) for j in range(n)]
        self.poly(mat, pts, col, hint=(0, 1 if up else -1, 0), ao=ao)

    def tube(self, mat, path, radii, sides, col, caps=True, phase=0.0):
        """A round tube along a path of 3D points (parallel-transported frame)."""
        P = [Vector(p) for p in path]
        n = len(P)
        rings = []
        t0 = (P[1] - P[0]).normalized()
        ref = Vector((1, 0, 0)) if abs(t0.x) < 0.9 else Vector((0, 0, 1))
        u = (ref - t0 * ref.dot(t0)).normalized()
        for i in range(n):
            t = (P[min(n - 1, i + 1)] - P[max(0, i - 1)]).normalized()
            u = (u - t * u.dot(t)).normalized()
            v = t.cross(u)
            ring = []
            for j in range(sides):
                a = phase + 2 * math.pi * j / sides
                p = P[i] + (u * math.cos(a) + v * math.sin(a)) * radii[i]
                ring.append((p.x, p.y, p.z))
            rings.append(ring)
        for i in range(n - 1):
            cen = tuple((P[i] + P[i + 1]) / 2)
            self.skin(mat, [rings[i], rings[i + 1]], col, inside=cen)
        if caps:
            for end, sign in ((0, -1), (n - 1, 1)):
                d = (P[min(n - 1, end + 1)] - P[max(0, end - 1)]).normalized() * sign
                self.poly(mat, rings[end], col, hint=(d.x, d.y, d.z))

    def beam(self, mat, a, b, w, d, col, up=(0, 1, 0), caps=True):
        """A square beam (w across, d deep) from a to b; `caps=False` leaves the ends open (members that end inside another)."""
        A, B = Vector(a), Vector(b)
        t = (B - A)
        if t.length < 1e-6:
            return
        t.normalize()
        ref = Vector(up) if abs(t.dot(Vector(up))) < 0.95 else Vector((1, 0, 0))
        s = t.cross(ref).normalized() * (w / 2)
        h = t.cross(s).normalized() * (d / 2)
        corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
        ra = [tuple(A + s * x + h * y) for x, y in corners]
        rb = [tuple(B + s * x + h * y) for x, y in corners]
        self.skin(mat, [ra, rb], col, inside=tuple((A + B) / 2))
        if caps:
            self.poly(mat, ra, col, hint=tuple(-t))
            self.poly(mat, rb, col, hint=tuple(t))


def _dist(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def circle(r, n, cx=0.0, cz=0.0, phase=0.0, ry=None):
    ry = r if ry is None else ry
    return [(cx + r * math.cos(phase + 2 * math.pi * j / n), cz + ry * math.sin(phase + 2 * math.pi * j / n)) for j in range(n)]


def rect(cx, cz, w, d, rot=0.0):
    s, c = math.sin(rot), math.cos(rot)
    return [(cx + x * c + z * s, cz - x * s + z * c) for x, z in [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]]


def rot_pts(pts, rot, cx=0.0, cz=0.0):
    s, c = math.sin(rot), math.cos(rot)
    return [(cx + (x - cx) * c + (z - cz) * s, cz - (x - cx) * s + (z - cz) * c) for x, z in pts]


def inset_ring(ring, d):
    """Offsets a simple ring inwards by d (miter, no self-intersection handling; for convex-ish rings)."""
    s = 1.0 if area2(ring) > 0 else -1.0
    n = len(ring)
    out = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        e0 = _norm2(p1[0] - p0[0], p1[1] - p0[1])
        e1 = _norm2(p2[0] - p1[0], p2[1] - p1[1])
        n0 = (-e0[1] * s, e0[0] * s)
        n1 = (-e1[1] * s, e1[0] * s)
        # inward normals for a CCW ring (s = 1) are (-ez, ex)... verified by the sign of the area
        bx, bz = n0[0] + n1[0], n0[1] + n1[1]
        bl = math.hypot(bx, bz)
        if bl < 1e-6:
            out.append(p1)
            continue
        k = d / max(0.3, (bx * n0[0] + bz * n0[1]) / bl)
        out.append((p1[0] + bx / bl * k, p1[1] + bz / bl * k))
    return out


def _norm2(x, z):
    ln = math.hypot(x, z) or 1.0
    return (x / ln, z / ln)


def min_obb(ring):
    """The smallest rectangle round a ring: (cx, cz, angle (rad), L, W). The frame of the rectangle is `to_world` below
    (u across with length L, v along with length W); a ring's own orientation (a building off the street grid)."""
    best = None
    for k in range(0, 180):
        a = math.radians(k * 0.5)
        c, s = math.cos(a), math.sin(a)
        us = [p[0] * c + p[1] * s for p in ring]
        vs = [-p[0] * s + p[1] * c for p in ring]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0] - 1e-6:
            best = (area, a, min(us), max(us), min(vs), max(vs))
    _, a, u0, u1, v0, v1 = best
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    c, s = math.cos(a), math.sin(a)
    return (cu * c - cv * s, cu * s + cv * c, a, u1 - u0, v1 - v0)


def to_world(u, v, cx, cz, a):
    """A point of the rectangle frame (u along e_u = (cos a, sin a), v along e_v = (-sin a, cos a)) to the model frame."""
    c, s = math.cos(a), math.sin(a)
    return (cx + u * c - v * s, cz + u * s + v * c)


def ring_bounds(ring):
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    return min(xs), min(zs), max(xs), max(zs)


# ---------------------------------------------------------------------------------------------- output
def _material(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    return m


# The far levels (index 1 and up) draw with fewer materials: fewer draw calls where the difference is not visible.
FAR_MATERIALS = {'lm_metal': 'lm_stone', 'lm_dark': 'lm_stone', 'bld_roof': 'lm_stone', 'lm_glass': 'lm_stone'}


def _merged_parts(lod):
    """The parts of a level by material, the far levels' lesser materials joined into the stone one (vertex colours carry the look)."""
    out = {}
    for mat in MATERIALS:
        part = lod.parts.get(mat)
        if part is None or not part.t:
            continue
        key = FAR_MATERIALS.get(mat, mat) if lod.index >= 1 else mat
        dst = out.get(key)
        if dst is None:
            out[key] = part
            continue
        if dst is lod.parts.get(key) and dst is not part:
            # do not change the level's own part: copy it first
            cp = Part()
            cp.p, cp.n, cp.c, cp.uv, cp.w, cp.b, cp.d, cp.t = list(dst.p), list(dst.n), list(dst.c), list(dst.uv), list(dst.w), list(dst.b), list(dst.d), list(dst.t)
            out[key] = dst = cp
        base = len(dst.p)
        dst.p += part.p
        dst.n += part.n
        dst.c += part.c
        dst.uv += part.uv
        dst.w += part.w
        dst.b += part.b
        dst.d += part.d
        dst.t += [(a + base, b + base, c + base) for a, b, c in part.t]
    return out


def _emit_meshes(lod, mat_parts, parent, prefix, origin=(0.0, 0.0, 0.0)):
    """The Blender objects of one level's (or one moving part's) parts, vertices taken relative to `origin`."""
    ox, oy, oz = origin
    for mat in MATERIALS:
        part = mat_parts.get(mat)
        if part is None or not part.t:
            continue
        me = bpy.data.meshes.new(f'{prefix}_{mat}')
        me.from_pydata([tuple(to_bl(p[0] - ox, p[1] - oy, p[2] - oz)) for p in part.p], [], [tuple(t) for t in part.t])
        me.update()
        me.normals_split_custom_set_from_vertices([tuple(to_bl(*n)) for n in part.n])
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        for i, c in enumerate(part.c):
            ca.data[i].color = c
        uvl = me.uv_layers.new(name='UVMap')
        for loop in me.loops:
            # the glTF exporter flips v (v' = 1 - v): store 1 - y so the file has y, metres above the ground, as the tile's walls do
            uvl.data[loop.index].uv = (part.uv[loop.vertex_index][0], 1.0 - part.uv[loop.vertex_index][1])
        if mat in ('bld_wall', 'bld_glass'):
            for name, vals in (('_WALL', part.w), ('_BLD', part.b)):
                at = me.attributes.new(name, 'QUATERNION', 'POINT')
                for i, v in enumerate(vals):
                    at.data[i].value = tuple(v) if v else (0, 0, 0, 0)
            at = me.attributes.new('_BID', 'QUATERNION', 'POINT')
            for i, v in enumerate(part.d):
                at.data[i].value = (v[0], v[1], 0, 0)
        me.materials.append(_material(mat))
        ob = bpy.data.objects.new(f'{prefix}_{mat}', me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent


def emit(lods, root_name='landmark'):
    """Makes Blender objects from the levels of detail: `lod<N>` empties holding one mesh per material (and one empty per
    moving part, `lod<N>_<name>`, holding its own). Returns the triangle counts."""
    from hoodlib import scene

    root = scene.empty(root_name)
    counts = []
    for lod in lods:
        grp = scene.empty(f'lod{lod.index}', parent=root)
        _emit_meshes(lod, _merged_parts(lod), grp, f'lod{lod.index}')
        for name in sorted(lod.children):
            sub, pivot, props = lod.children[name]
            node = scene.empty(f'lod{lod.index}_{name}', pos=pivot, parent=grp, props=props)
            _emit_meshes(sub, _merged_parts(sub), node, f'lod{lod.index}_{name}', origin=pivot)
        counts.append(lod.tris())
    return counts
