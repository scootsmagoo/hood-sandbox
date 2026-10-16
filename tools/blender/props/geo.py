"""A plain-Python geometry accumulator for trees and street furniture, in game coordinates
(+X left, +Y up, +Z forward: the glTF frame, so what is written here is what three.js loads).

Unlike the cars (hoodlib.mesh, bmesh with material slots by name) these models carry per-vertex data:
position, a smooth custom normal (a crown shades as a soft volume, not as facets), a linear colour
with an alpha that the game decodes (see `LEAF` below) and a UV for leaf cards. Everything is
deterministic: no sets, a seeded `random.Random` per model.

Vertex alpha code (COLOR_0.a, 8 bits): a solid vertex is 0 to 0.45 (0.5 x the wind weight); a leaf
card vertex is 0.55 to 0.95 (0.5 + 0.5 x the wind weight). The shader reads `leaf = a > 0.5`.
"""
import math

import bpy
from mathutils import Vector

from hoodlib.frame import to_bl


def srgb(hexv):
    """0xRRGGBB to a linear (r, g, b)."""
    out = []
    for sh in (16, 8, 0):
        c = ((hexv >> sh) & 255) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale(c, k):
    return tuple(x * k for x in c)


def norm(v):
    v = Vector(v)
    return v.normalized() if v.length > 1e-9 else Vector((0, 1, 0))


def wind_alpha(leaf, w):
    w = max(0.0, min(1.0, w))
    return 0.5 + 0.45 * w + 0.05 if leaf else 0.44 * w


class Geo:
    def __init__(self):
        self.p, self.n, self.c, self.uv, self.t = [], [], [], [], []

    def vert(self, p, n, rgb, alpha, uv=(0.0, 0.0)):
        self.p.append((float(p[0]), float(p[1]), float(p[2])))
        nn = norm(n)
        self.n.append((nn.x, nn.y, nn.z))
        self.c.append((rgb[0], rgb[1], rgb[2], alpha))
        self.uv.append(uv)
        return len(self.p) - 1

    def tri(self, a, b, c):
        self.t.append((a, b, c))

    def tris(self):
        return len(self.t)

    def bounds(self):
        xs, ys, zs = zip(*self.p)
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    # ---- shapes
    def tube(self, path, radii, sides, color, wind=lambda y: 0.0, normal_fn=None, cap_end=False, cap_color=None, phase=0.0):
        """A tube along `path` (game points) with `radii` per point. `color(i, a)` gives the colour of ring i at angle a.
        Winding is outward (CCW seen from outside)."""
        P = [Vector(p) for p in path]
        n = len(P)
        rings = []
        t0 = (P[1] - P[0]).normalized()
        ref = Vector((1, 0, 0)) if abs(t0.x) < 0.9 else Vector((0, 0, 1))
        u = ref - t0 * ref.dot(t0)
        u.normalize()
        for i in range(n):
            t = (P[min(n - 1, i + 1)] - P[max(0, i - 1)]).normalized()
            # parallel transport
            u = u - t * u.dot(t)
            u.normalize()
            v = t.cross(u)  # (u, v, t) right-handed, so a ring's winding is outward
            ring = []
            for j in range(sides):
                a = phase + 2 * math.pi * j / sides
                d = u * math.cos(a) + v * math.sin(a)
                pos = P[i] + d * radii[i]
                nrm = d if normal_fn is None else normal_fn(pos, d)
                ring.append(self.vert(pos, nrm, color(i, a), wind_alpha(False, wind(pos.y))))
            rings.append(ring)
        for i in range(n - 1):
            for j in range(sides):
                j2 = (j + 1) % sides
                a, b, c, d = rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]
                self.tri(a, b, c)
                self.tri(a, c, d)
        if cap_end:
            tip = P[-1] + (P[-1] - P[-2]).normalized() * radii[-1] * 0.4
            col = cap_color or (0.1, 0.1, 0.1)
            ti = self.vert(tip, tip - P[-2], col, wind_alpha(False, wind(tip.y)))
            for j in range(sides):
                self.tri(rings[-1][j], rings[-1][(j + 1) % sides], ti)
        return rings

    def lathe(self, profile, sides, color, wind=lambda y: 0.0, phase=0.0, smooth=True):
        """A solid of revolution about +Y from (radius, y) points, bottom to top; outward winding. `color(k)` per ring.
        Flat rings (equal y) make a cap or a step: the normal there is taken from the profile's neighbours."""
        n = len(profile)
        rings = []
        for k, (r, y) in enumerate(profile):
            # profile tangent -> outward normal in the (radius, y) plane
            r0, y0 = profile[max(0, k - 1)]
            r1, y1 = profile[min(n - 1, k + 1)]
            tr, ty = r1 - r0, y1 - y0
            ln = math.hypot(tr, ty) or 1.0
            nr, ny = ty / ln, -tr / ln  # outward (rotate the tangent by -90)
            ring = []
            for j in range(sides):
                a = phase + 2 * math.pi * j / sides
                ca, sa = math.cos(a), math.sin(a)
                pos = (r * ca, y, r * sa)
                nrm = (nr * ca, ny, nr * sa)
                ring.append(self.vert(pos, nrm, color(k), wind_alpha(False, wind(y))))
            rings.append(ring)
        for k in range(n - 1):
            for j in range(sides):
                j2 = (j + 1) % sides
                # looking from outside (+X toward the axis, +Y up) the ring goes from +Z toward ... choose CCW outward
                a, b, c, d = rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j]
                self.tri(a, c, b)
                self.tri(a, d, c)
        return rings

    def box(self, centre, size, color, rot_y=0.0, wind_w=0.0):
        """A box with flat normals: centre, full size (x, y, z), colour, turned about Y."""
        cx, cy, cz = centre
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        s, c = math.sin(rot_y), math.cos(rot_y)

        def at(x, y, z):
            return (cx + x * c + z * s, cy + y, cz - x * s + z * c)

        faces = [
            ((1, 0, 0), [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)]),
            ((-1, 0, 0), [(-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz), (-hx, -hy, -hz)]),
            ((0, 1, 0), [(-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz)]),
            ((0, -1, 0), [(-hx, -hy, hz), (-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz)]),
            ((0, 0, 1), [(hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz), (-hx, -hy, hz)]),
            ((0, 0, -1), [(-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz), (hx, -hy, -hz)]),
        ]
        for nrm, corners in faces:
            nx, ny, nz = nrm
            wn = (nx * c + nz * s, ny, -nx * s + nz * c)
            ids = [self.vert(at(*q), wn, color, wind_alpha(False, wind_w)) for q in corners]
            self.tri(ids[0], ids[1], ids[2])
            self.tri(ids[0], ids[2], ids[3])

    def blob(self, centre, radii, subdiv, color, rng, jitter, normal_fn, wind=lambda y: 0.0, leaf=False):
        """A noisy ellipsoid (icosphere): `color(dir, y)` per vertex, `normal_fn(pos, dir)` the shading normal."""
        verts, faces = _ico(subdiv)
        cx, cy, cz = centre
        ids = []
        jit = [1.0 + rng.uniform(-jitter, jitter) for _ in verts]
        for k, d in enumerate(verts):
            pos = Vector((cx + d.x * radii[0] * jit[k], cy + d.y * radii[1] * jit[k], cz + d.z * radii[2] * jit[k]))
            ids.append(self.vert(pos, normal_fn(pos, d), color(d, pos.y), wind_alpha(leaf, wind(pos.y))))
        for a, b, c in faces:
            self.tri(ids[a], ids[b], ids[c])

    def card(self, centre, nrm, roll, size, color, shade_n, wind_w, aspect=1.0):
        """A leaf card: a square facing `nrm`, turned `roll` about it. UV 0..1. DoubleSide in the game."""
        n = norm(nrm)
        ref = Vector((0, 1, 0)) if abs(n.y) < 0.95 else Vector((1, 0, 0))
        r = n.cross(ref).normalized()
        u = r.cross(n).normalized()
        cr, sr = math.cos(roll), math.sin(roll)
        r2 = r * cr + u * sr
        u2 = u * cr - r * sr
        hs = size / 2
        corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
        ids = []
        for sx, sy in corners:
            pos = Vector(centre) + r2 * (sx * hs * aspect) + u2 * (sy * hs)
            ids.append(self.vert(pos, shade_n, color, wind_alpha(True, wind_w), ((sx + 1) / 2, (sy + 1) / 2)))
        # CCW seen from +n: r2 x u2 = n? (r x (n x r)...) fix by checking
        if r2.cross(u2).dot(n) < 0:
            ids = [ids[0], ids[3], ids[2], ids[1]]
        self.tri(ids[0], ids[1], ids[2])
        self.tri(ids[0], ids[2], ids[3])

    # ---- output
    def to_object(self, name, parent=None, material=None):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(to_bl(*p)) for p in self.p], [], [tuple(t) for t in self.t])
        me.update()
        # custom normals first, so the loops exist in their final order
        me.normals_split_custom_set_from_vertices([tuple(to_bl(*n)) for n in self.n])
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        for i, col in enumerate(self.c):
            ca.data[i].color = col
        uvl = me.uv_layers.new(name='UVMap')
        for loop in me.loops:
            uvl.data[loop.index].uv = self.uv[loop.vertex_index]
        if material is not None:
            me.materials.append(material)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob


def _ico(subdiv):
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    verts = [Vector(p).normalized() for p in v]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
             (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    # make sure every face is CCW seen from outside
    fixed = []
    for a, b, c in faces:
        n = (verts[b] - verts[a]).cross(verts[c] - verts[a])
        fixed.append((a, b, c) if n.dot(verts[a] + verts[b] + verts[c]) > 0 else (a, c, b))
    faces = fixed
    for _ in range(subdiv):
        cache = {}

        def mid(i, j):
            k = (min(i, j), max(i, j))
            if k not in cache:
                verts.append(((verts[i] + verts[j]) / 2).normalized())
                cache[k] = len(verts) - 1
            return cache[k]

        nf = []
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf
    return verts, faces
