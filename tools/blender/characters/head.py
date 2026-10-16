"""The head: one grid of vertices (rows of heights, columns of angles from the front centre), shaped
by side and front profiles and gaussian bumps for the nose, brows, lips and chin. Hair, a beard,
eyes, brows and lips are materials on the same quads (hair also pushes its vertices out), so the
whole thing is one watertight skin. Ears, hats and tied-back hair are separate shells.
"""
import math

from mathutils import Vector

from hoodlib import materials

from .body import gauss
from .shapes import BONE_INDEX, Curve, Tube, Weighter, lerp, mkvert, quad, spow, sstep

ROWS = {
    0: [1.500, 1.508, 1.516, 1.526, 1.537, 1.548, 1.556, 1.563, 1.570, 1.578, 1.586, 1.595, 1.605, 1.616, 1.627, 1.637, 1.646, 1.655, 1.664, 1.676, 1.690, 1.704, 1.717, 1.728, 1.736, 1.742],
    1: [1.500, 1.520, 1.550, 1.580, 1.620, 1.655, 1.690, 1.722, 1.742],
    2: [1.500, 1.55, 1.62, 1.69, 1.742],
}
THETAS = {
    0: [0.1, 0.2, 0.3, 0.4, 0.5, 0.62, 0.85, 1.15, 1.5, 1.9, 2.35, 2.8],
    1: [0.6, 1.4, 2.2],
    2: [1.0, 2.2],
}

# y: (half width, front z, back z)
PROFILE = Curve([
    (1.500, 0.047, 0.040, 0.048, 0, 0, 0),
    (1.508, 0.054, 0.058, 0.050, 0, 0, 0),
    (1.520, 0.058, 0.082, 0.052, 0, 0, 0),
    (1.535, 0.062, 0.088, 0.056, 0, 0, 0),
    (1.550, 0.066, 0.086, 0.063, 0, 0, 0),
    (1.566, 0.070, 0.085, 0.071, 0, 0, 0),
    (1.580, 0.072, 0.086, 0.080, 0, 0, 0),
    (1.598, 0.074, 0.087, 0.088, 0, 0, 0),
    (1.612, 0.0755, 0.087, 0.094, 0, 0, 0),
    (1.626, 0.0765, 0.086, 0.098, 0, 0, 0),
    (1.640, 0.077, 0.085, 0.100, 0, 0, 0),
    (1.655, 0.077, 0.088, 0.101, 0, 0, 0),
    (1.670, 0.077, 0.087, 0.101, 0, 0, 0),
    (1.688, 0.076, 0.081, 0.099, 0, 0, 0),
    (1.705, 0.073, 0.072, 0.093, 0, 0, 0),
    (1.720, 0.066, 0.059, 0.083, 0, 0, 0),
    (1.731, 0.052, 0.043, 0.065, 0, 0, 0),
    (1.738, 0.034, 0.026, 0.041, 0, 0, 0),
    (1.742, 0.0, 0.0, 0.0, 0, 0, 0),
])
HEAD_C = Vector((0.0, 1.63, 0.0))

HAIRLINE = Curve([(0.0, 1.694), (0.375, 1.691), (0.55, 1.686), (0.85, 1.672), (1.2, 1.658), (1.6, 1.645), (2.05, 1.618), (2.55, 1.590), (3.1416, 1.566)])


def face_bumps(x, y, z):
    """Extra forward push (m) at a front-facing point."""
    ax = abs(x)
    a = 0.0
    # nose: bridge, tip, wings
    a += 0.015 * gauss(x, 0.012) * sstep(1.585, 1.632, y) * (1 - sstep(1.648, 1.668, y))
    a += 0.026 * gauss(x, 0.013) * gauss(y - 1.593, 0.011)
    a += 0.013 * gauss(ax - 0.021, 0.008) * gauss(y - 1.589, 0.009)
    a -= 0.006 * gauss(ax - 0.012, 0.006) * gauss(y - 1.584, 0.004)
    # brow ridge, eye sockets
    a += 0.007 * gauss(y - 1.659, 0.0075) * sstep(0.0, 0.015, ax) * (1 - sstep(0.05, 0.075, ax))
    a -= 0.008 * gauss(ax - 0.034, 0.016) * gauss(y - 1.642, 0.010)
    # cheekbones
    a += 0.006 * gauss(ax - 0.052, 0.018) * gauss(y - 1.616, 0.016)
    # lips and the line between
    a += 0.0055 * gauss(x, 0.024) * gauss(y - 1.576, 0.0055)
    a += 0.0065 * gauss(x, 0.024) * gauss(y - 1.558, 0.0065)
    a -= 0.0045 * gauss(x, 0.03) * gauss(y - 1.567, 0.0035)
    # chin
    a += 0.007 * gauss(x, 0.02) * gauss(y - 1.528, 0.012)
    return a


class HeadSpec:
    def __init__(self, hair='none', hair_th=0.012, hair_fade=0.0, beard=0.0, beard_zone='full', brow=True, crown=0.0, width=1.0, jaw=1.0, nose=1.0, hat=None, extras=(), skin_mat='skin'):
        self.hair = hair
        self.hair_th = hair_th
        self.hair_fade = hair_fade   # sides and back thinner by this fraction
        self.beard = beard           # thickness; 0 none
        self.beard_zone = beard_zone
        self.brow = brow
        self.crown = crown           # extra height of the hair on top (afro, curls)
        self.width = width
        self.jaw = jaw
        self.nose = nose
        self.hat = hat
        self.extras = extras


def head_shape(spec: HeadSpec, theta, y):
    w, zf, zb = PROFILE(y)[:3]
    jaw = 1 + (spec.jaw - 1) * (1 - sstep(1.52, 1.62, y))
    w = w * spec.width * jaw
    s, c = math.sin(theta), math.cos(theta)
    x = w * spow(s, 2 / 2.25)
    z = (zf * spow(c, 2 / 2.2)) if c >= 0 else (zb * spow(c, 2 / 2.2))
    return x, z


def beard_mask(spec, theta, y):
    if not spec.beard:
        return 0.0
    at = abs(theta)
    z = spec.beard_zone
    lower = 1 - sstep(1.582, 1.600, y)
    # keep the mouth clear in the front, grow on jaw and chin and the upper lip
    if y < 1.505:
        return 0.0
    chin = 1 if at < 0.6 else 0
    jaw = sstep(0.4, 0.9, at) * (1 - sstep(1.9, 2.3, at))
    if z == 'goatee':
        return lower * (1 if at < 0.5 and y < 1.56 else 0)
    if z == 'chinstrap':
        return lower * (1 if 0.5 < at < 2.0 and y < 1.57 else 0) + (1 if at < 0.5 and y < 1.545 else 0)
    return lower * (chin + jaw > 0.2) * (1.0 if at < 2.2 else 0.0)


def hair_thickness(spec, theta, y):
    if spec.hair == 'none':
        return 0.0
    at = abs(theta)
    hl = HAIRLINE(at)[0]
    if spec.hair in ('afro', 'curls'):
        hl -= 0.004
    k = sstep(0.0, 0.016, y - hl)
    if k <= 0:
        return 0.0
    th = spec.hair_th
    # sides and back are cut closer
    top = sstep(1.690, 1.725, y)
    th = th * (1 - spec.hair_fade * (1 - top))
    th += spec.crown * sstep(1.66, 1.74, y)
    return th * k


class Head:
    def __init__(self, mesh, spec: HeadSpec, lod, yscale=1.0):
        self.mesh = mesh
        self.spec = spec
        self.lod = lod
        self.rows = ROWS[lod]
        pos = THETAS[lod]
        self.thetas = [0.0] + pos + [math.pi] + [-t for t in reversed(pos)]
        self.n = len(self.thetas)
        self.w = Weighter(['neck', 'head'], power=3.0, soft=0.015)
        self.build()

    def point(self, y, theta):
        spec = self.spec
        x, z = head_shape(spec, theta, y)
        fw = sstep(0.01, 0.06, z)
        z = z + face_bumps(x, y, z) * fw * (spec.nose if abs(x) < 0.03 else 1.0)
        p = Vector((x, y, z))
        # hair and beard push outward from the head's middle
        th = hair_thickness(spec, theta, y)
        bm = beard_mask(spec, theta, y)
        off = max(th, spec.beard * bm)
        if off > 0:
            d = (p - HEAD_C)
            d.normalize()
            p = p + d * off
        return p

    def coverage(self, y, theta):
        """(hair, beard) cover of a point: 0 to 1, beard negative when it is thick enough to be hair-coloured."""
        spec = self.spec
        h = 0.0
        if spec.hair != 'none':
            hl = HAIRLINE(abs(theta))[0] - (0.004 if spec.hair in ('afro', 'curls') else 0.0)
            h = sstep(0.0, 0.016, y - hl)
        bd = beard_mask(spec, theta, y) if spec.beard else 0.0
        if spec.beard > 0.0085:
            bd = -bd
        return h, bd

    def build(self):
        m = self.mesh
        rows, n = self.rows, self.n
        self.grid = []
        self.cov = {}
        for y in rows:
            pts = [self.point(y, th) for th in self.thetas]
            if all((pts[0] - p).length < 1e-7 for p in pts):
                v = mkvert(m, pts[0], self.w)
                self.grid.append([v] * n)
            else:
                self.grid.append([mkvert(m, p, self.w) for p in pts])
            for v, th in zip(self.grid[-1], self.thetas):
                self.cov[v] = self.coverage(y, th)
        self.faces = []
        for i in range(len(rows) - 1):
            for j in range(n):
                j2 = (j + 1) % n
                f = quad(m, [self.grid[i][j], self.grid[i][j2], self.grid[i + 1][j2], self.grid[i + 1][j]], 'face')
                if f:
                    self.faces.append(f)
        # the cover goes in the first UV set: hair, beard
        uv = m.bm.loops.layers.uv.verify()
        for f in self.faces:
            for loop in f.loops:
                loop[uv].uv = self.cov.get(loop.vert, (0.0, 0.0))


def make_ears(mesh, spec, lod, skin_w=None):
    if lod > 0:
        return
    w = Weighter(['head'], soft=0.02)
    prof = Curve([(-0.034, 0.0, 0.0, 0, 0, 2.0), (-0.028, 0.006, 0.012, 0, 0, 2.0), (-0.012, 0.0095, 0.0175, 0, 0, 2.0), (0.012, 0.0095, 0.0175, 0, -0.002, 2.0), (0.026, 0.006, 0.012, 0, -0.003, 2.0), (0.032, 0.0, 0.0, 0, -0.003, 2.0)])
    for side in (1, -1):
        O = Vector((side * 0.0775 * spec.width, 1.623, -0.012))
        A = Vector((side * 0.10, 1.0, 0.0)).normalized()
        Tube(mesh, O, A, (0, 0, 1), prof, [-0.034, -0.028, -0.012, 0.012, 0.026, 0.032], 6, 'skin', (), w, side)


# ---------------------------------------------------------------- hats, hair that hangs
def skull_point(spec, y, theta, off=0.0):
    """A point on the bare head (no hair or beard) pushed out `off` metres from the head's middle."""
    x, z = head_shape(spec, theta, y)
    fw = sstep(0.01, 0.06, z)
    z = z + face_bumps(x, y, z) * fw * (spec.nose if abs(x) < 0.03 else 1.0)
    p = Vector((x, y, z))
    if off:
        d = p - HEAD_C
        d.normalize()
        p = p + d * off
    return p


def hat_shell(mesh, spec, lod, edge, mat='hat', thick=0.022, rim=0.004, band=None, brim=None, rings=None):
    """A hat over the head: `edge(theta)` is the height of its lower edge; the shell is `thick` off
    the skull, thinning to `rim` at the edge, with a hem step so the edge has a thickness. `band` is
    an optional (height, material) for a band round the edge. `brim` is an optional dict(kind, reach,
    droop, arc) for a peak (kind 'peak', over the front) or a ring (kind 'ring', all round)."""
    w = Weighter(['head'], soft=0.02)
    cols = {0: 20, 1: 12, 2: 8}[lod]
    thetas = [2 * math.pi * (j + 0.5) / cols - math.pi for j in range(cols)]
    # rows from the edge to the crown, as a fraction of the way up
    fr = rings or ([0.0, 0.09, 0.22, 0.4, 0.58, 0.74, 0.88, 1.0] if lod == 0 else [0.0, 0.2, 0.55, 0.85, 1.0] if lod == 1 else [0.0, 0.5, 1.0])
    top = 1.742
    grid = []
    for k, f in enumerate(fr):
        ring_hem = []
        row = []
        for th in thetas:
            ye = edge(th)
            y = ye + (top - ye) * f
            # thickness grows quickly off the edge
            t = rim + (thick - rim) * sstep(0.0, 0.3, f) if f > 0 else rim
            row.append(skull_point(spec, y, th, t))
        grid.append(row)
    # the hem: the same edge ring on the skin
    hem = [skull_point(spec, edge(th), th, 0.0) for th in thetas]
    n = cols
    vs = [[mkvert(mesh, p, w) for p in r] for r in [hem] + grid]
    # last ring collapses to the crown point
    crown = vs[-1][0]
    for r_i in range(len(vs) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            quad(mesh, [vs[r_i][j], vs[r_i][j2], vs[r_i + 1][j2], vs[r_i + 1][j]], mat)
    if band:
        pass
    if brim:
        _brim(mesh, spec, thetas, edge, brim, mat, w)


def _brim(mesh, spec, thetas, edge, brim, mat, w):
    kind = brim.get('kind', 'peak')
    reach = brim.get('reach', 0.07)
    droop = brim.get('droop', 0.15)
    arc = brim.get('arc', 1.15)
    steps = 3
    sel = [th for th in thetas if kind == 'ring' or abs(th) <= arc]
    if kind == 'peak':
        sel = sorted(sel)
        # add the exact ends so the peak is symmetric
    cols = []
    for th in sel:
        ye = edge(th)
        base = skull_point(spec, ye, th, 0.014)
        d = Vector((math.sin(th), 0.0, math.cos(th)))
        rr = reach * (1.0 if kind == 'ring' else (0.45 + 0.55 * math.cos(th * (math.pi / 2) / arc)))
        col = []
        for k in range(steps + 1):
            r = rr * k / steps
            col.append(base + d * r + Vector((0, -droop * r, 0)))
        cols.append(col)
    verts = [[mkvert(mesh, p, w) for p in col] for col in cols]
    nsel = len(cols)
    rngj = range(nsel) if kind == 'ring' else range(nsel - 1)
    for j in rngj:
        j2 = (j + 1) % nsel
        for k in range(steps):
            # top face and underside (reversed), so the sheet shows from both sides
            quad(mesh, [verts[j][k], verts[j2][k], verts[j2][k + 1], verts[j][k + 1]], mat)
            quad(mesh, [verts[j][k + 1], verts[j2][k + 1], verts[j2][k], verts[j][k]], mat)


def hair_curtain(mesh, spec, lod, y_end, spread=1.0, thick=0.014, side_span=2.35, front_y=None, mat='hair', sway=0.0):
    """Hair hanging from the back and sides of the head down to `y_end`, a two-sided sheet."""
    w = Weighter(['head', 'neck', 'chest'], soft=0.03, scale={'chest': 0.5})
    cols = {0: 11, 1: 7, 2: 5}[lod]
    rows = {0: 9, 1: 5, 2: 3}[lod]
    y0 = 1.69
    pts = []
    for i in range(rows + 1):
        y = y0 + (y_end - y0) * i / rows
        v = i / rows
        row = []
        for j in range(cols):
            # angle from the back centre, spanning the back half
            a = math.pi + (j / (cols - 1) - 0.5) * 2 * side_span
            if y > 1.55:
                x, z = head_shape(spec, a, min(y, 1.70))
                rx, rz = abs(x) + 0.0, abs(z)
                p = Vector((math.sin(a) * (0.082 + 0.03 * v) * spread, y, math.cos(a) * (0.1 + 0.02 * v) * spread - 0.0))
            else:
                p = Vector((math.sin(a) * (0.088 + 0.07 * sstep(1.55, y_end, y) ) * spread, y, math.cos(a) * (0.108 + 0.03 * sstep(1.55, y_end, y)) * spread))
            p.x *= 1.0 - 0.10 * v
            p.z -= 0.012
            p.x += sway * v
            row.append(p)
        pts.append(row)
    outer = [[mkvert(mesh, p, w) for p in r] for r in pts]
    for i in range(rows):
        for j in range(cols - 1):
            quad(mesh, [outer[i][j], outer[i][j + 1], outer[i + 1][j + 1], outer[i + 1][j]], mat)
    # the inner face, a hair's width in
    inner = []
    for r in pts:
        inner.append([mkvert(mesh, Vector((p.x * 0.9, p.y, p.z * 0.92 + 0.008)), w) for p in r])
    for i in range(rows):
        for j in range(cols - 1):
            quad(mesh, [inner[i][j + 1], inner[i][j], inner[i + 1][j], inner[i + 1][j + 1]], mat)
    # close the lower edge
    for j in range(cols - 1):
        quad(mesh, [outer[rows][j], outer[rows][j + 1], inner[rows][j + 1], inner[rows][j]], mat)
