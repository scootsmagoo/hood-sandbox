"""Lofted tubes with clothing layers, skin weights from the skeleton, and a few small helpers.

Everything is in the game frame (+X left, +Y up, +Z forward). A `Tube` is rings of superellipse
sections along an axis (a limb, the torso, a shoe); a station's section is set by its half-widths
(`rx` across, `rz` front to back), an offset of its centre and an exponent. Clothing is a list of
`Layer`s on the tube: a span, a material and a thickness, with a zero-length step (a hem) at each
end. Skin weights come from the distance to the bone segments the tube may use (`Weighter`).
"""
import math

import bmesh
from mathutils import Vector

from hoodlib import materials
from hoodlib.frame import to_bl

from .skeleton import BONES, BONE_NAMES

BONE_INDEX = {n: i for i, n in enumerate(BONE_NAMES)}


def sstep(a, b, x):
    if b == a:
        return 1.0 if x >= b else 0.0
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def spow(x, p):
    """Signed power: sign(x) |x|^p."""
    return math.copysign(abs(x) ** p, x)


class Curve:
    """Piecewise cubic (Catmull-Rom, clamped) through (t, v...) rows: smooth radii along a limb."""

    def __init__(self, rows):
        self.rows = sorted(rows, key=lambda r: r[0])
        self.n = len(self.rows[0]) - 1

    def __call__(self, t):
        r = self.rows
        if t <= r[0][0]:
            return tuple(r[0][1:])
        if t >= r[-1][0]:
            return tuple(r[-1][1:])
        lo, hi = 0, len(r) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if r[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t0, t1 = r[lo][0], r[hi][0]
        u = (t - t0) / (t1 - t0)
        out = []
        for k in range(1, self.n + 1):
            p1, p2 = r[lo][k], r[hi][k]
            p0 = r[lo - 1][k] if lo > 0 else p1 - (p2 - p1)
            p3 = r[hi + 1][k] if hi + 1 < len(r) else p2 + (p2 - p1)
            u2, u3 = u * u, u * u * u
            v = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
            # no overshoot beyond the neighbours
            out.append(min(max(v, min(p1, p2) - abs(p2 - p1) * 0.25), max(p1, p2) + abs(p2 - p1) * 0.25))
        return tuple(out)


def seg_dist(p, a, b):
    ab = b - a
    L2 = ab.length_squared
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (p - (a + ab * t)).length


class Weighter:
    """Skin weights from the distance to the bones a vertex may follow."""

    def __init__(self, bones, power=2.6, soft=0.022, scale=None):
        self.segs = []
        for n in bones:
            b = BONES[n]
            self.segs.append((BONE_INDEX[n], Vector(b['head']), Vector(b['tail']), (scale or {}).get(n, 1.0)))
        self.power = power
        self.soft = soft

    def __call__(self, p):
        p = Vector(p)
        ws = []
        for idx, a, b, k in self.segs:
            ws.append((idx, k / (seg_dist(p, a, b) + self.soft) ** self.power))
        ws.sort(key=lambda x: -x[1])
        ws = ws[:4]
        s = sum(w for _, w in ws)
        ws = [(i, w / s) for i, w in ws if w / s > 0.02]
        s = sum(w for _, w in ws)
        return {i: w / s for i, w in ws}


class Layer:
    """A garment on a tube between `t0` and `t1` (in the tube's own t, either order), `thick` metres
    thick (a number, or a function of t returning a number or an (extra rx, extra rz) pair)."""

    def __init__(self, t0, t1, mat, thick=0.01, hem0=True, hem1=True):
        self.t0, self.t1 = min(t0, t1), max(t0, t1)
        self.mat = mat
        self.thick = thick
        self.hem0, self.hem1 = hem0, hem1

    def at(self, t):
        v = self.thick(t) if callable(self.thick) else self.thick
        return v if isinstance(v, tuple) else (v, v)


def set_weights(mesh, vert, w):
    layer = mesh.bm.verts.layers.deform.verify()
    d = vert[layer]
    d.clear()
    for i, x in w.items():
        d[i] = x


def mkvert(mesh, p, weighter=None):
    v = mesh.bm.verts.new(to_bl(*p))
    if weighter:
        set_weights(mesh, v, weighter(p))
    return v


def quad(mesh, vs, mat):
    uniq = []
    for v in vs:
        if not uniq or uniq[-1] is not v:
            uniq.append(v)
    if len(uniq) > 1 and uniq[0] is uniq[-1]:
        uniq.pop()
    if len(uniq) < 3 or len({id(v) for v in uniq}) < len(uniq):
        return None
    try:
        f = mesh.bm.faces.new(uniq)
    except ValueError:
        return None
    f.material_index = materials.slot(mat)
    return f


class Tube:
    """Rings of sections along `axis` from `origin`. Ring angle 0 faces `fwd`; angles increase toward
    axis x fwd. `side` is +1 for a left-hand limb and -1 for a right one (the section's lateral offset
    and the masks are mirrored)."""

    def __init__(self, mesh, origin, axis, fwd, prof, ts, n, base='skin', layers=(), weighter=None, side=1, masks=(), deform=None, thetas=None, merge_pole=1e-6):
        self.mesh = mesh
        self.O = Vector(origin)
        self.A = Vector(axis).normalized()
        f = Vector(fwd)
        f = (f - self.A * f.dot(self.A)).normalized()
        self.F = f
        self.S = self.A.cross(f)
        self.side = side
        self.n = n
        self.prof = prof
        self.thetas = thetas or [2 * math.pi * (j + 0.5) / n for j in range(n)]
        self.layers = [l for l in layers]
        self.base = base
        self.weighter = weighter
        self.masks = masks
        self.deform = deform
        self.stations = self._stations(sorted(set(round(t, 5) for t in ts)))
        self.rings = []
        self.build()

    def _layer_at(self, t, eps=1e-6):
        for l in self.layers:
            if l.t0 - eps <= t <= l.t1 + eps:
                return l
        return None

    def _stations(self, ts):
        """(t, layer or None) in order, with a skin ring and a cloth ring at a hem, or the two cloth
        rings where one garment ends where another starts."""
        eps = 1e-5
        times = list(ts)
        for l in self.layers:
            for t in (l.t0, l.t1):
                if all(abs(t - u) > eps for u in times):
                    times.append(t)
        times.sort()
        out = []
        for t in times:
            inner = [l for l in self.layers if l.t0 + eps < t < l.t1 - eps]
            if inner:
                out.append((t, inner[0]))
                continue
            ending = [l for l in self.layers if abs(l.t1 - t) < eps]
            starting = [l for l in self.layers if abs(l.t0 - t) < eps]
            e_hem = [l for l in ending if l.hem1]
            s_hem = [l for l in starting if l.hem0]
            if e_hem and s_hem:
                out.append((t, e_hem[0]))
                out.append((t, s_hem[0]))
            elif e_hem:
                out.append((t, e_hem[0]))
                if not starting:
                    out.append((t, None))
                else:
                    out.append((t, starting[0]))
            elif s_hem:
                if not ending:
                    out.append((t, None))
                else:
                    out.append((t, ending[0]))
                out.append((t, s_hem[0]))
            elif ending or starting:
                out.append((t, (ending or starting)[0]))
            else:
                out.append((t, None))
        return out

    def section(self, t, layer):
        rx, rz, ox, oz, e = self.prof(t)
        if layer is not None:
            dx, dz = layer.at(t)
            rx += dx
            rz += dz
        return rx, rz, ox, oz, e

    def point(self, t, theta, layer=None, inset=0.0):
        rx, rz, ox, oz, e = self.section(t, layer)
        rx = max(0.0, rx - inset)
        rz = max(0.0, rz - inset)
        p = self.O + self.A * t + self.S * (ox * self.side) + self.F * oz
        k = 2.0 / e
        p = p + self.S * (rx * spow(math.sin(theta), k)) + self.F * (rz * spow(math.cos(theta), k))
        if self.deform:
            p = self.deform(t, theta * 1.0, p, layer)
        return p

    def build(self):
        m = self.mesh
        for t, layer in self.stations:
            pts = [self.point(t, th, layer) for th in self.thetas]
            # a ring that has collapsed to one point shares one vertex
            collapsed = all((pts[0] - p).length < 1e-6 for p in pts)
            if collapsed:
                v = mkvert(m, pts[0], self.weighter)
                self.rings.append([v] * self.n)
            else:
                self.rings.append([mkvert(m, p, self.weighter) for p in pts])
        n = self.n
        self.faces = []
        for i in range(len(self.stations) - 1):
            (ta, la), (tb, lb) = self.stations[i], self.stations[i + 1]
            if la is None and lb is None:
                mat = self.base
            elif la is None or lb is None or la is lb:
                mat = (la or lb).mat
            else:
                tm0 = 0.5 * (ta + tb)
                mat = la.mat if sum(la.at(tm0)) >= sum(lb.at(tm0)) else lb.mat
            for j in range(n):
                j2 = (j + 1) % n
                vs = [self.rings[i][j], self.rings[i][j2], self.rings[i + 1][j2], self.rings[i + 1][j]]
                mm = mat
                if self.masks:
                    tm = 0.5 * (ta + tb)
                    th = 0.5 * (self.thetas[j] + (self.thetas[j2] if j2 else 2 * math.pi + self.thetas[0]))
                    th = (th + math.pi) % (2 * math.pi) - math.pi
                    for mk in self.masks:
                        r = mk(tm, th * self.side, mat, la or lb)
                        if r:
                            mm = r
                f = quad(m, vs, mm)
                if f:
                    self.faces.append(f)

    def seal(self, mat=None, end=0):
        """Closes the first (`end` 0) or last ring with a fan to its centre."""
        ring = self.rings[0 if end == 0 else -1]
        if len({id(v) for v in ring}) < 3:
            return
        c = sum((v.co for v in ring), Vector()) / len(ring)
        cv = self.mesh.bm.verts.new(c)
        if self.weighter:
            set_weights(self.mesh, cv, self.weighter((c.x, c.z, -c.y)))
        mt = mat or self.base
        for j in range(self.n):
            quad(self.mesh, [ring[j], ring[(j + 1) % self.n], cv] if end == 1 else [ring[(j + 1) % self.n], ring[j], cv], mt)


FACE = {'skin', 'lip', 'eye', 'sclera', 'hair', 'stubble', 'face'}


def smooth_character(mesh, angle_deg=42.0):
    """Smooth shading, sharp past `angle_deg` and where the cloth changes; the skin, lips, eyes, brows,
    hair and stubble of the head are one surface, so no seam shows between them."""
    thr = math.radians(angle_deg)
    from hoodlib import materials
    names = materials.NAMES
    for f in mesh.bm.faces:
        f.smooth = True
    for e in mesh.bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        fa, fb = e.link_faces
        if fa.material_index != fb.material_index and not (names[fa.material_index] in FACE and names[fb.material_index] in FACE):
            e.smooth = False
            continue
        try:
            e.smooth = e.calc_face_angle() < thr
        except ValueError:
            e.smooth = False


def finish(mesh, smooth_deg=40.0):
    """Recalculates normals outward over the whole mesh and smooths."""
    mesh.smooth(smooth_deg)


def add_weighted(mesh, weighter, fn):
    """Runs `fn` (which adds geometry to the mesh) and gives every new vertex skin weights."""
    from hoodlib.frame import from_bl
    before = len(mesh.bm.verts)
    out = fn()
    mesh.bm.verts.ensure_lookup_table()
    for v in mesh.bm.verts[before:]:
        set_weights(mesh, v, weighter(from_bl(v.co)))
    return out


def lathe_ring(mesh, centre, axis, rows, n, mat, weighter, fwd=(0, 0, 1)):
    """A tube from (t, rx, rz, ox, oz) rows (exponent 2): for straps, bands, tails."""
    prof = Curve([(r[0], r[1], r[2], r[3], r[4], 2.0) for r in rows])
    return Tube(mesh, centre, axis, fwd, prof, [r[0] for r in rows], n, mat, (), weighter)
