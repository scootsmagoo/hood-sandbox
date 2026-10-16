"""
The parametric car: one function builds any of the cars at any level of detail from a spec (a
dict of profile curves and feature positions, see sedan.py for a commented one) and the car's
physics numbers (hoodlib.handling.Car), so the body sits on the physics hull and the wheels sit
where the sim puts them.

What a level of detail is made of (objects under `lod<N>`, named `lod<N>_<part>`):
  body           the shell: a lofted lower body with wheel arches cut by booleans, a lofted
                 greenhouse with framed windows, grille, bezels, mirrors, handles, an interior
                 silhouette (seats, dash, wheel) behind the tinted glass. Materials by slot name.
  door           the driver's door (left, +X), its origin on the hinge (LOD0 and LOD1)
  hood           the bonnet, its origin on its rear hinge (LOD0 and LOD1)
  bumper_F/_R    the bumpers, separate so they can sag and fall off (LOD0 and LOD1)
  light_head, light_tail, light_reverse   the lamps, one object per kind, so they light separately
  wheel          ONE wheel, the front left, its origin on the hub; the game draws it four times
                 (turned half round for the right side)
Anchors (empties under `anchors`) hold the seat, door, hinges, wheels and engine for the game.
"""
import math

from hoodlib import materials, uv
from hoodlib.curves import Profile, round_corner, stations
from hoodlib.mesh import Mesh, boolean, load, store, to_object

# Ring detail and loft spacing per level of detail.
RES = {
    0: dict(step=0.2, end_step=0.06, gh_step=0.15, arch_segs=24, wheel_segs=20, details=True),
    1: dict(step=0.42, end_step=0.12, gh_step=0.34, arch_segs=12, wheel_segs=10, details=False),
    2: dict(step=1.1, end_step=0.5, gh_step=0.9, arch_segs=6, wheel_segs=6, details=False),
}


class Body:
    """The spec's curves, evaluated."""

    def __init__(self, spec, car):
        self.s = spec
        self.car = car
        self.zf = spec['z_front']
        self.zr = spec['z_rear']
        self.half = spec['half_width']
        self.y_bot = Profile(spec['y_bottom'])
        self.y_top = Profile(spec['y_top'])
        self.crown = spec.get('crown', 0.02)
        self.bulge = spec.get('bulge')  # [(z_centre, half_length, extra)] haunches
        g = spec['greenhouse']
        self.g = g
        self.roof = Profile(g['top'])
        self.belt_inset = g.get('belt_inset', 0.075)
        self.tumble = g.get('tumble', 0.28)

    def w(self, z):
        """Plan half-width at z (corners rounded, haunches added)."""
        s = self.s
        w = self.half
        w = min(w, round_corner(z, self.zf, s['corner_front'], self.half, 1))
        w = min(w, round_corner(z, self.zr, s['corner_rear'], self.half, -1))
        if self.bulge:
            for zc, hl, extra in self.bulge:
                d = (z - zc) / hl
                if abs(d) < 1:
                    w += extra * (0.5 + 0.5 * math.cos(math.pi * d))
        return w

    def bands(self, z):
        yb, yt = self.y_bot(z), self.y_top(z)
        h = yt - yb
        yr = yb + min(0.1, 0.28 * h)
        ys = yt - min(0.075, 0.25 * h)
        mid = (yr + ys) / 2
        b0 = mid - min(0.08, 0.18 * h)
        b1 = mid + min(0.08, 0.18 * h)
        return yb, yr, b0, b1, ys, yt

    def half_ring(self, z, lod):
        w = self.w(z)
        yb, yr, b0, b1, ys, yt = self.bands(z)
        cr = self.crown
        if lod == 0:
            pts = [
                (0.0, yb), (w * 0.6, yb), (w - 0.06, yb), (w - 0.024, yb + 0.02), (w - 0.012, yr),
                (w - 0.003, b0), (w, b1), (w - 0.006, ys), (w - 0.03, yt - 0.012), (w - 0.09, yt + cr * 0.35),
                (w * 0.55, yt + cr * 0.85), (0.0, yt + cr),
            ]
        elif lod == 1:
            pts = [(0.0, yb), (w - 0.05, yb), (w - 0.012, yr), (w - 0.003, b0), (w, b1), (w - 0.008, ys), (w - 0.07, yt), (w * 0.5, yt + cr * 0.8), (0.0, yt + cr)]
        else:
            pts = [(0.0, yb), (w - 0.03, yb + 0.02), (w, (b0 + b1) / 2), (w - 0.03, ys), (w - 0.1, yt), (0.0, yt + cr)]
        # never fold over at the thin nose and tail
        out = []
        for x, y in pts:
            x = max(0.0, x)
            if out and y < out[-1][1]:
                y = out[-1][1]
            out.append((x, y))
        return out

    def ring(self, z, lod):
        h = self.half_ring(z, lod)
        left = [(x, y, z) for x, y in h]
        right = [(-x, y, z) for x, y in reversed(h[1:-1])]
        return left + right

    # ---- greenhouse
    def belt(self, z):
        return self.y_top(z) - 0.004

    def gh_ring(self, z, lod):
        """The greenhouse section (left half): belt, top of the side glass, roof edge, roof."""
        g = self.g
        xb = self.w(z) - self.belt_inset
        yb = self.belt(z)
        top = max(yb, self.roof(z))
        h = top - yb
        rail = min(g.get('rail', 0.055), h)
        y1 = yb + max(0.0, h - rail)
        x1 = xb - self.tumble * (y1 - yb)
        x2 = xb - self.tumble * h - 0.025
        cr = g.get('crown', 0.025)
        if lod == 0:
            half = [(xb, yb), (x1, y1), (x1 - 0.012, y1 + rail * 0.55), (x2, top), (x2 - 0.07, top + cr * 0.5), (x2 * 0.5, top + cr * 0.9), (0.0, top + cr)]
        elif lod == 1:
            half = [(xb, yb), (x1, y1), (x2, top), (x2 * 0.55, top + cr * 0.8), (0.0, top + cr)]
        else:
            half = [(xb, yb), (x1, y1), (x2, top), (0.0, top + cr)]
        left = [(x, y, z) for x, y in half]
        right = [(-x, y, z) for x, y in reversed(half[:-1])]
        return left + right


def body_stations(b, lod, extra):
    r = RES[lod]
    s = b.s
    dense = [
        (b.zf - s['corner_front'] - 0.05, b.zf, r['end_step']),
        (b.zr, b.zr + s['corner_rear'] + 0.05, r['end_step']),
    ]
    return stations(b.zr, b.zf, r['step'], extra=extra if lod < 2 else (), dense=dense)


def lower_body(b, lod):
    s = b.s
    feats = [s['hood_z'], s['greenhouse']['ws_base'], s['greenhouse']['rw_base']]
    for d in s['doors']:
        feats += list(d)
    feats += s.get('extra_stations', [])
    zs = body_stations(b, lod, feats)
    m = Mesh()
    rings = [b.ring(z, lod) for z in zs]
    m.loft(rings, 'paint', cap_start='paint', cap_end='paint', centre=lambda c: (0.0, (b.y_bot(c[2]) + b.y_top(c[2])) / 2, c[2]))
    m.clean()
    return m


def greenhouse(b, lod):
    g = b.g
    r = RES[lod]
    zs = stations(g['rw_base'], g['ws_base'], r['gh_step'],
                  extra=[g['roof_front'], g['roof_rear'], g['c_z']] + list(g.get('b_pillar') or []) + [d[0] for d in b.s['doors']] if lod < 2 else [g['roof_front'], g['roof_rear']],
                  dense=[(g['roof_front'], g['ws_base'], r['gh_step'] * 0.6), (g['rw_base'], g['roof_rear'], r['gh_step'] * 0.6)] if lod == 0 else ())
    rings = [b.gh_ring(z, lod) for z in zs]
    m = Mesh()
    m.loft(rings, 'paint', closed=False, centre=lambda c: (0.0, b.belt(c[2]) + 0.05, c[2]))
    m.clean()
    classify_greenhouse(m, b)
    return m


def classify_greenhouse(m, b):
    g = b.g
    bp = g.get('b_pillar')

    def pick(c, n, f):
        x, y, z = c
        if abs(n[0]) > 0.62:  # the sides
            top = b.roof(z)
            if y > top - g.get('rail', 0.055) * 0.6:
                return 'paint'
            if z < g['c_z']:
                return 'paint'
            if bp and bp[0] < z < bp[1]:
                return 'trim'
            return 'glass'
        # the top: windscreen, roof, rear window
        if z > g['roof_front'] + 0.01 or z < g['roof_rear'] - 0.01:
            # the edges of the top at the pillars stay paint
            xb = b.w(z) - b.belt_inset - b.tumble * max(0.0, b.roof(z) - b.belt(z)) - 0.02
            return 'glass' if abs(x) < xb - 0.035 else 'paint'
        return 'paint'

    for f in m.bm.faces:
        from hoodlib.frame import from_bl
        f.material_index = materials.slot(pick(from_bl(f.calc_center_median()), from_bl(f.normal), f))


def arch_cutter(b, lod):
    car = b.car
    s = b.s
    m = Mesh()
    segs = RES[lod]['arch_segs']
    for front in (True, False):
        z = car.front_z if front else car.rear_z
        r = car.radius + s.get('arch_gap', 0.06)
        for side in (1, -1):
            inner = s.get('well_inner', 0.4)
            length = b.half + 0.35 - inner
            cx = side * (inner + length / 2)
            m.cylinder((cx, car.wheel_y + s.get('arch_lift', 0.02), z), r, length, segs, 'trim', axis='x')
    return m


def faces_in(m, zmin, zmax, pred=None):
    return m.faces_where(lambda c, n, f: zmin <= c[2] <= zmax and (pred is None or pred(c, n, f)))


# ---------------------------------------------------------------------------------------------
# Small parts


def outline_path(b, y, z_from, side, end, n_corner, x_in=0.0, offset=0.0, front=True, side_offset=None):
    """Points along the plan outline of the nose (front) or tail at height y, from the side panel
    at `z_from` round the corner to x = side * x_in on the end face, `offset` metres outside the
    skin. `side` +1 the left."""
    zf = b.zf if front else b.zr
    sign = 1 if front else -1
    rc = b.s['corner_front'] if front else b.s['corner_rear']
    pts = []
    so = offset if side_offset is None else side_offset
    # down the side panel to the start of the corner
    z_corner = zf - sign * rc
    if (z_corner - z_from) * sign > 0.01:
        pts.append((side * (b.half + so), y, z_from))
    for i in range(n_corner + 1):
        a = (math.pi / 2) * i / n_corner
        off = so + (offset - so) * math.sin(a)
        x = (b.half - rc) + (rc + off) * math.cos(a)
        z = z_corner + sign * (rc + off) * math.sin(a)
        pts.append((side * x, y, z))
    xe = (b.half - rc)
    if xe > x_in + 0.02:
        steps = max(1, round((xe - x_in) / 0.3))
        for i in range(1, steps + 1):
            x = xe - (xe - x_in) * i / steps
            pts.append((side * x, y, zf + sign * offset))
    if end is not None:
        pts = [p for p in pts if (p[2] - end) * sign >= -1e-6 or abs(p[0]) < b.half - rc]
    return pts


def arc_path(b, y, side, a0, a1, n, front=True, offset=0.0):
    """Points on the corner arc from angle a0 to a1 (0 = on the end face, 90 deg = the side)."""
    zf = b.zf if front else b.zr
    sign = 1 if front else -1
    rc = b.s['corner_front'] if front else b.s['corner_rear']
    pts = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        x = (b.half - rc) + (rc + offset) * math.sin(a)
        z = (zf - sign * rc) + sign * (rc + offset) * math.cos(a)
        pts.append((side * x, y, z))
    return pts


def lamp_path(b, y, side, x_in, wrap_deg, n_wrap, front):
    """Along the end face from x_in to the corner, then round it by wrap_deg."""
    rc = b.s['corner_front'] if front else b.s['corner_rear']
    zf = b.zf if front else b.zr
    xe = b.half - rc
    pts = []
    if xe > x_in + 0.01:
        pts.append((side * x_in, y, zf))
        pts.append((side * (x_in + xe) / 2, y, zf))
    pts += arc_path(b, y, side, 0, wrap_deg, max(1, n_wrap), front=front)
    return pts


def rect_profile(h, out0, out1, r=0.0):
    """A closed (out, up) rectangle, its corners cut by r."""
    if r <= 0:
        return [(out0, -h / 2), (out1, -h / 2), (out1, h / 2), (out0, h / 2)]
    return [(out0, -h / 2), (out1 - r, -h / 2), (out1, -h / 2 + r), (out1, h / 2 - r), (out1 - r, h / 2), (out0, h / 2)]


def bumper(b, lod, front, spec):
    """A wrap-round bumper along the plan outline, with a black rub strip (LOD0)."""
    car = b.car
    m = Mesh()
    yc = spec['y']
    h = spec['h']
    off = spec.get('offset', 0.035)
    wrap = spec.get('wrap', 0.45)
    zf = b.zf if front else b.zr
    sign = 1 if front else -1
    z_from = zf - sign * wrap
    nc = 4 if lod == 0 else 2
    left = outline_path(b, yc, z_from, 1, None, nc, x_in=0.0, offset=off, front=front, side_offset=spec.get('side_offset', -0.025))
    path = left + [(-x, y, z) for (x, y, z) in reversed(left[:-1])]
    d = spec.get('depth', 0.1)
    if lod == 0:
        prof = [(-d * 0.7, -h / 2), (0.01, -h / 2), (0.04, -h / 2 + 0.04), (0.042, h / 2 - 0.04), (0.01, h / 2), (-d * 0.7, h / 2)]
    else:
        prof = [(-d * 0.7, -h / 2), (0.03, -h / 2), (0.03, h / 2), (-d * 0.7, h / 2)]
    out_ref = (0.0, yc, zf - sign * 1.5)
    m.sweep(path, prof, spec.get('mat', 'paint'), outward=out_ref)
    if lod == 0 and spec.get('strip', True):
        sp = rect_profile(spec.get('strip_h', 0.05), 0.025, 0.05)
        path2 = [(x, y + spec.get('strip_y', 0.0), z) for (x, y, z) in path]
        m.sweep(path2, sp, spec.get('strip_mat', 'trim'), outward=out_ref)
    if spec.get('valance', True) and lod == 0:
        # a dark lip under the bumper
        pv = [(x * 0.97, y - h / 2 - 0.02, z - sign * 0.02) for (x, y, z) in path]
        m.sweep(pv, rect_profile(0.04, -0.06, 0.0), 'trim', outward=out_ref)
    m.clean()
    return m


def head_and_tail(b, lod, spec, front):
    """The lamps of one end: a lamp strip on each side following the body round the corner, and a
    chrome bezel behind it. Returns {material: Mesh} and the bezel Mesh."""
    lamps = {}
    bezel = Mesh()
    L = spec['head'] if front else spec['tail']
    y0, y1 = L['y']
    yc = (y0 + y1) / 2
    hh = y1 - y0
    nw = 4 if lod == 0 else 2
    if lod == 2:
        # far away a lamp is a lit quad on the end face; the reverse lamps are left out
        zf = b.zf if front else b.zr
        sgn = 1 if front else -1
        xo = b.half - (b.s['corner_front'] if front else b.s['corner_rear']) + 0.02
        mat = 'light_head' if front else 'light_tail'
        m = lamps.setdefault(mat, Mesh())
        for side in (1, -1):
            z = zf + sgn * 0.01
            vs = [m.v(side * L['x_in'], y0, z), m.v(side * xo, y0, z), m.v(side * xo, y1, z), m.v(side * L['x_in'], y1, z)]
            f = m.face(vs, mat)
            m.orient_from([f], lambda c: (0.0, yc, zf - sgn))
        return lamps, bezel
    for side in (1, -1):
        path = lamp_path(b, yc, side, L['x_in'], L['wrap'], nw, front)
        prof = rect_profile(hh, -0.02, 0.008)
        zf = b.zf if front else b.zr
        ref = (0.0, yc, zf - (1.5 if front else -1.5))
        if front or not L.get('reverse'):
            mat = 'light_head' if front else 'light_tail'
            lamps.setdefault(mat, Mesh()).sweep(path, prof, mat, outward=ref)
        else:
            # the inner end of the tail strip is the reverse lamp
            xr = L['x_in'] + L['reverse']
            inner = [(side * L['x_in'], yc, b.zr), (side * xr, yc, b.zr)]
            outer = [(side * xr, yc, b.zr)] + [p for p in path if abs(p[0]) > xr + 0.01]
            lamps.setdefault('light_reverse', Mesh()).sweep(inner, prof, 'light_reverse', outward=ref)
            lamps.setdefault('light_tail', Mesh()).sweep(outer, prof, 'light_tail', outward=ref)
        if lod == 0:
            bp = rect_profile(hh + 0.03, -0.03, 0.003)
            bezel.sweep(path, bp, L.get('bezel', 'chrome'), outward=ref)
    for m in lamps.values():
        m.clean()
    bezel.clean()
    return lamps, bezel


def grille(b, lod, spec):
    G = spec['grille']
    m = Mesh()
    zf = b.zf
    y0, y1 = G['y']
    hw = G['half_width']
    yc = (y0 + y1) / 2
    depth = 0.012
    m.box((0, yc, zf + 0.002), (hw * 2, y1 - y0, 0.02), 'trim', bevel=0.01 if lod == 0 else 0)
    if lod == 0:
        # a chrome surround: one tube round the opening
        t = G.get('frame', 0.022)
        loop = []
        rr = min(0.04, (y1 - y0) * 0.3)
        for cx, cy, a0 in ((hw - rr, y1 - rr, 0), (-hw + rr, y1 - rr, 90), (-hw + rr, y0 + rr, 180), (hw - rr, y0 + rr, 270)):
            for k in range(3):
                a = math.radians(a0 + 45 * k)
                loop.append((cx + rr * math.cos(a), cy + rr * math.sin(a), zf + 0.012))
        loop.append(loop[0])
        m.sweep(loop, [(-t / 2, -0.015), (t / 2, -0.015), (t / 2, 0.015), (-t / 2, 0.015)], G.get('frame_mat', 'chrome'), up=(0, 0, 1), caps=False)
        n = G.get('bars', 3)
        for i in range(n):
            y = y0 + (y1 - y0) * (i + 1) / (n + 1)
            m.box((0, y, zf + 0.01), (hw * 2 - 0.01, G.get('bar_h', 0.012), 0.012), G.get('bar_mat', 'chrome'))
        for i in range(G.get('vbars', 0)):
            x = -hw + 2 * hw * (i + 1) / (G['vbars'] + 1)
            m.box((x, yc, zf + 0.01), (0.012, y1 - y0 - 0.01, 0.012), G.get('bar_mat', 'chrome'))
        if G.get('badge', True):
            # a plain oval: no maker's badge
            m.box((0, yc, zf + 0.022), (0.11, 0.05, 0.012), 'chrome', bevel=0.02, segments=1)
    elif lod == 1:
        m.box((0, y1, zf + 0.01), (hw * 2, 0.02, 0.02), 'chrome')
    m.clean()
    return m


def mirror(b, side, lod, spec):
    M = spec['mirror']
    m = Mesh()
    z = M['z']
    y = M['y']
    w = b.w(z) - b.belt_inset + 0.02
    if lod == 0:
        m.box((side * (w + 0.05), y - 0.01, z + 0.02), (0.1, 0.035, 0.05), 'trim', bevel=0.01)
        m.box((side * (w + 0.13), y + 0.03, z), (0.1, 0.11, 0.16), M.get('mat', 'paint'), bevel=0.025, segments=2, rot=(0, side * 0.12, 0))
        m.box((side * (w + 0.135), y + 0.03, z - 0.075), (0.085, 0.09, 0.012), 'chrome', rot=(0, side * 0.12, 0))
    else:
        m.box((side * (w + 0.1), y + 0.03, z), (0.12, 0.1, 0.12), M.get('mat', 'paint'))
    m.clean()
    return m


def handles(b, zs, side, spec):
    m = Mesh()
    y = spec.get('handle_y', b.bands(0)[4] - 0.07)
    for z in zs:
        w = b.w(z)
        m.box((side * (w + 0.008), y, z), (0.02, 0.03, 0.13), 'chrome')
    return m


def interior(b, lod, car):
    """A simple cabin: a tub (floor, sides, firewall, parcel shelf) facing in, a headliner, seats,
    a dashboard and a wheel, so the tinted glass has something behind it."""
    g = b.g
    m = Mesh()
    doors = car.doors()
    sx, sy, sz = doors['seat']
    belt = b.belt(sz)
    roof = b.roof(sz)
    wi = b.w(sz) - 0.13
    floor = b.y_bot(sz) + 0.12
    z0 = g['rw_base'] + 0.12
    z1 = g['ws_base'] - 0.1
    if lod == 0:
        tub = Mesh()
        tub.box((0, (floor + belt) / 2, (z0 + z1) / 2), (wi * 2, belt - floor, z1 - z0), 'interior')
        # face inward
        import bmesh as _bm
        _bm.ops.reverse_faces(tub.bm, faces=list(tub.bm.faces))
        m.merge(tub)
        m.box((0, roof - 0.03, (g['roof_front'] + g['roof_rear']) / 2), ((b.w(sz) - b.belt_inset - b.tumble * (roof - belt) - 0.06) * 2, 0.01, g['roof_front'] - g['roof_rear'] + 0.2), 'interior')
    seat_top = sy - 0.06
    for x in (sx, -sx):
        if lod == 0:
            m.box((x, (floor + seat_top) / 2, sz + 0.02), (0.5, seat_top - floor, 0.5), 'interior', bevel=0.04, segments=1)
            m.box((x, seat_top + 0.3, sz - 0.27), (0.48, 0.62, 0.13), 'interior', bevel=0.04, segments=1, rot=(-0.22, 0, 0))
            m.box((x, seat_top + 0.68, sz - 0.36), (0.26, 0.16, 0.1), 'interior', bevel=0.03, segments=1, rot=(-0.22, 0, 0))
        else:
            m.box((x, seat_top + 0.2, sz - 0.2), (0.48, 0.6, 0.35), 'interior')
    if lod == 0 and g.get('rear_seat', True):
        zr = sz - 0.8
        m.box((0, (floor + seat_top) / 2, zr), (wi * 2 - 0.1, seat_top - floor, 0.5), 'interior', bevel=0.04, segments=1)
        m.box((0, seat_top + 0.28, zr - 0.27), (wi * 2 - 0.1, 0.56, 0.12), 'interior', bevel=0.04, segments=1, rot=(-0.3, 0, 0))
    dash_z = min(z1, sz + 0.75)
    if lod == 0:
        m.box((0, belt - 0.06, dash_z), (wi * 2, 0.2, 0.36), 'interior', bevel=0.05, segments=1)
        # the steering wheel: a ring of six short bars, each along the rim (the hands of the driver clips sit at 3 and 9 o'clock)
        cx, cy, cz = sx, belt + 0.02, dash_z - 0.24
        r = 0.18
        for i in range(6):
            a = 2 * math.pi * i / 6
            m.box((cx + r * math.cos(a), cy + r * math.sin(a) * 0.9, cz - r * math.sin(a) * 0.35), (0.03, 0.19, 0.03), 'trim', rot=(0.35, 0, a))
        m.box((cx, cy - 0.06, cz + 0.12), (0.06, 0.06, 0.25), 'trim', rot=(0.35, 0, 0))
    else:
        m.box((0, belt - 0.06, dash_z), (wi * 2, 0.2, 0.3), 'interior')
    m.clean()
    return m


# ---------------------------------------------------------------------------------------------
# Wheels


def wheel(car, lod, style):
    """One wheel at the origin, its outer face toward +X (the left side)."""
    R = car.radius
    W = car.width
    w2 = W / 2
    rr = R * style.get('rim', 0.6)
    segs = RES[lod]['wheel_segs']
    m = Mesh()
    face = style.get('face', 'chrome')
    dish = style.get('dish', 'chrome')
    if lod == 0:
        tyre = [(rr + 0.004, -w2 + 0.016), (R - 0.05, -w2), (R - 0.008, -w2 + 0.03), (R, w2 * 0.2), (R - 0.008, w2 - 0.03), (R - 0.05, w2), (rr + 0.012, w2 - 0.01)]
        m.lathe(tyre, segs, 'tyre')
        rim = [(rr + 0.012, w2 - 0.01), (rr, w2 - 0.004), (rr * 0.9, w2 - 0.04), (rr * 0.42, w2 - 0.06), (rr * 0.2, w2 - 0.025), (0.0, w2 - 0.01)]
        mats = ['chrome', face, dish, face, 'chrome']
        m.lathe(rim, segs, lambda k: mats[k])
        # the inner barrel, so the rim does not look paper thin through the spokes
        m.lathe([(rr * 0.9, w2 - 0.042), (rr * 0.95, -w2 + 0.03)], max(8, segs // 2), 'trim')
        n = style.get('spokes', 0)
        for i in range(n):
            a = 2 * math.pi * (i + 0.5) / n
            rm = rr * 0.6
            m.box((w2 - 0.045, rm * math.cos(a), rm * math.sin(a)), (0.03, rr * 0.62, style.get('spoke_w', 0.04)), style.get('spoke_mat', 'chrome'), rot=(a, 0, 0))
        slots = style.get('slots', 0)
        for i in range(slots):
            a = 2 * math.pi * i / slots
            rm = rr * 0.62
            m.box((w2 - 0.05, rm * math.cos(a), rm * math.sin(a)), (0.012, rr * 0.3, 0.025), 'trim', rot=(a, 0, 0))
        lugs = style.get('lugs', 5)
        for i in range(lugs):
            a = 2 * math.pi * i / lugs
            m.box((w2 - 0.022, rr * 0.25 * math.cos(a), rr * 0.25 * math.sin(a)), (0.018, 0.02, 0.02), 'chrome')
    elif lod == 1:
        tyre = [(rr, -w2), (R, -w2 + 0.03), (R, w2 - 0.03), (rr, w2)]
        m.lathe(tyre, segs, 'tyre')
        m.lathe([(rr, w2), (rr * 0.6, w2 - 0.04), (0.0, w2 - 0.02)], segs, lambda k: face if k == 0 else dish)
    else:
        m.lathe([(0.0, -w2), (R, -w2), (R, w2), (0.0, w2)], segs, 'tyre')
    m.clean()
    return m


# ---------------------------------------------------------------------------------------------
# The car


def build_lod(spec, car, lod, parent, extras=None):
    """Builds one level of detail under `parent`. `extras(b, lod, parts)` adds a variant's parts
    (the police kit) to the dict of Meshes before they become objects. Returns the objects."""
    b = Body(spec, car)
    name = parent.name
    s = spec
    det = RES[lod]['details']

    lb = lower_body(b, lod)
    gh = greenhouse(b, lod)

    # ---- wheel arches
    lb_obj = to_object(lb, f'{name}_tmp_lb', triangulate=False)
    boolean(lb_obj, arch_cutter(b, lod))
    for cut in s.get('cuts', []):
        if lod in cut.get('lods', (0, 1, 2)):
            cm = Mesh()
            cm.box(cut['pos'], cut['size'], cut.get('mat', 'trim'))
            boolean(lb_obj, cm)
    lb = load(lb_obj)
    import bpy
    me = lb_obj.data
    bpy.data.objects.remove(lb_obj)
    bpy.data.meshes.remove(me)

    parts = {}

    # ---- panel seams (LOD0): thin dark strips on the side at the door edges
    if lod == 0:
        seam_edges = []
        for zs in s.get('seams', []):
            for e in lb.bm.edges:
                from hoodlib.frame import from_bl
                a = from_bl(e.verts[0].co)
                c = from_bl(e.verts[1].co)
                if abs(a[2] - zs) < 0.002 and abs(c[2] - zs) < 0.002:
                    ymin = b.bands(zs)[1] - 0.06
                    ymax = b.bands(zs)[4] + 0.01
                    if min(abs(a[0]), abs(c[0])) > b.w(zs) - 0.05 and ymin < min(a[1], c[1]) and max(a[1], c[1]) < ymax:
                        seam_edges.append(e)
        if seam_edges:
            import bmesh
            r = bmesh.ops.bevel(lb.bm, geom=seam_edges, offset=0.004, segments=1, affect='EDGES', clamp_overlap=True)
            lb.set_mat(r['faces'], 'trim')

    # ---- livery band (police): faces on the sides between the band heights
    if s.get('livery') and lod < 2:
        lv = s['livery']

        def band(c, n, f):
            yb, yr, b0, b1, ys, yt = b.bands(c[2])
            return abs(n[0]) > 0.6 and b0 - 0.005 < c[1] < b1 + 0.005 and lv['z'][0] < c[2] < lv['z'][1]

        lb.set_mat(lb.faces_where(band), 'livery')

    # ---- hood
    hood = None
    if lod < 2:
        hz0 = s['hood_z']

        def on_hood(c, n, f):
            return hz0 < c[2] < b.zf - s.get('hood_front_margin', 0.1) and n[1] > 0.5 and c[1] > b.y_top(c[2]) - 0.08 and lb.mat_of(f) == 'paint'

        hood = lb.split_off(lb.faces_where(on_hood))
        if lod == 0:
            hood.thicken(0.018, 'trim')
            if s.get('scoop'):
                sc = s['scoop']
                hood.box(sc['pos'], sc['size'], 'paint', bevel=0.03, segments=2)
                hood.box((sc['pos'][0], sc['pos'][1] + 0.01, sc['pos'][2] + sc['size'][2] / 2 + 0.002), (sc['size'][0] * 0.8, sc['size'][1] * 0.6, 0.01), 'trim')
        # what shows when the bonnet is up
        lb.box((0, b.y_top(hz0) - 0.16, (hz0 + b.zf) / 2 - 0.05), (b.half * 1.7, 0.18, b.zf - hz0 - 0.25), 'trim')

    # ---- the driver's door (left, +X)
    door = None
    dz0, dz1 = s['doors'][0]
    if lod < 2:
        def on_door(c, n, f):
            yb, yr, b0, b1, ys, yt = b.bands(c[2])
            return c[0] > 0.3 and n[0] > 0.3 and dz0 < c[2] < dz1 and yb + 0.02 < c[1] < ys + 0.04 and lb.mat_of(f) in ('paint', 'livery')

        door = lb.split_off(lb.faces_where(on_door))
        if lod == 0:
            door.thicken(0.05, 'interior', 'trim')
        g = b.g

        def on_door_glass(c, n, f):
            return c[0] > 0.25 and n[0] > 0.5 and dz0 < c[2] < min(g['ws_base'] - 0.02, dz1 + 0.01) and gh.mat_of(f) in ('glass',) and c[1] < b.roof(c[2]) - 0.02

        dg = gh.split_off(gh.faces_where(on_door_glass))
        if det:
            dg.inset(list(dg.bm.faces), 0.028, 0.012, 'trim')
        door.merge(dg)
        door.merge(mirror(b, 1, lod, s))
        if det:
            door.merge(handles(b, [dz0 + 0.12], 1, s))
        door.clean()

    # ---- body-side moulding: a black strip along the flanks, the driver's door's share on the door
    if lod == 0 and s.get('moulding'):
        mo = s['moulding']
        car_ = b.car
        r_arch = car_.radius + s.get('arch_gap', 0.06)
        z_a = car_.front_z - r_arch - 0.04
        z_b = car_.rear_z + r_arch + 0.04
        cuts = sorted({z for d in s['doors'] for z in d if z_b < z < z_a})
        edges = [z_b] + cuts + [z_a]
        prof = rect_profile(mo.get('h', 0.045), -0.004, mo.get('out', 0.012))
        for side in (1, -1):
            for za, zb in zip(edges[:-1], edges[1:]):
                za2, zb2 = za + 0.006, zb - 0.006
                path = [(side * b.w(z), mo['y'], z) for z in (za2, (za2 + zb2) / 2, zb2)]
                strip = Mesh()
                strip.sweep(path, prof, mo.get('mat', 'trim'), outward=(0.0, mo['y'], (za2 + zb2) / 2))
                if side > 0 and door is not None and abs(za - dz0) < 1e-6 and abs(zb - dz1) < 1e-6:
                    door.merge(strip)
                else:
                    lb.merge(strip)

    # ---- windows: black frames round the glass, the glass set in
    if det:
        gh.inset([f for f in gh.bm.faces if gh.mat_of(f) == 'glass'], 0.028, 0.012, 'trim')
    lb.merge(gh)

    # ---- small parts on the body
    lb.merge(grille(b, lod, s))
    if det or lod == 1:
        lb.merge(mirror(b, -1, lod, s))
    if det:
        hz = [dz0 + 0.12] + [d[0] + 0.12 for d in s['doors'][1:]]
        lb.merge(handles(b, hz, -1, s))
        lb.merge(handles(b, [d[0] + 0.12 for d in s['doors'][1:]], 1, s))
        if s.get('plate_rear'):
            p = s['plate_rear']
            lb.box((0, p['y'], b.zr - 0.012), (0.31, 0.155, 0.02), 'chrome', bevel=0.006)
        for ex in s.get('exhaust', []):
            lb.cylinder(ex, 0.035, 0.12, 10, 'chrome', axis='z', cap=True, cap_mat='trim')
        # wipers
        g = b.g
        for x in (0.32, -0.08):
            z = g['ws_base'] - 0.06
            lb.box((x, b.belt(z) + 0.035, z + 0.03), (0.5, 0.012, 0.02), 'trim', rot=(0.0, 0.18, 0.0))
    lamps_f, bez_f = head_and_tail(b, lod, s, True)
    lamps_r, bez_r = head_and_tail(b, lod, s, False)
    lb.merge(bez_f)
    lb.merge(bez_r)
    if lod < 2:
        lb.merge(interior(b, lod, car))
    for fn in s.get('extra_parts', []):
        fn(b, lod, lb)

    parts['body'] = lb
    if door:
        parts['door'] = door
    if hood:
        parts['hood'] = hood
    if lod < 2:
        parts['bumper_F'] = bumper(b, lod, True, s['bumper_front'])
        parts['bumper_R'] = bumper(b, lod, False, s['bumper_rear'])
    else:
        for bs, z in ((s['bumper_front'], b.zf), (s['bumper_rear'], b.zr)):
            lb.box((0, bs['y'], z), (b.half * 2 - 0.1, bs['h'], 0.12), bs.get('mat', 'paint'))
    lamps = {}
    for d in (lamps_f, lamps_r):
        for k, m in d.items():
            if k in lamps:
                lamps[k].merge(m)
            else:
                lamps[k] = m
    for k, m in lamps.items():
        parts[k] = m
    parts['wheel'] = wheel(car, lod, s['wheel'])
    if extras:
        extras(b, lod, parts)

    # ---- objects, with pivots
    objs = {}
    pivots = {
        'door': s.get('door_hinge') or (b.w(dz1) + 0.0, b.bands(dz1)[2], dz1),
        'hood': (0.0, b.y_top(s['hood_z']), s['hood_z']),
        'wheel': car.wheel_anchor(0),
        'bumper_F': (0.0, s['bumper_front']['y'], b.zf),
        'bumper_R': (0.0, s['bumper_rear']['y'], b.zr),
    }
    for key, m in parts.items():
        if key == 'wheel':
            # built at the origin: move it onto the front-left hub
            m.transform(car.wheel_anchor(0))
        m.smooth(s.get('smooth_angle', 38))
        uv.box_project(m)
        objs[key] = to_object(m, f'{name}_{key}', parent=parent, origin=pivots.get(key))
    return objs, b


# ---------------------------------------------------------------------------------------------
# A whole asset: three levels of detail and the anchors


# Triangle budgets per level of detail (the wheel counted four times): docs in tools/blender/README.md
BUDGET = {0: (6000, 9000), 1: (1200, 2200), 2: (250, 550)}


def assemble(asset, spec, car, extras=None):
    """Builds `asset` (an id like 'sedan-police') from a spec: a root `car` with `lod0..2` groups
    and `anchors`. Returns a report: triangles per level of detail."""
    from hoodlib import lod as lodlib
    from hoodlib import scene

    scene.reset()
    materials.ensure()
    root = scene.empty('car', props={'asset': asset, 'type': car.h['id']})
    report = {'asset': asset, 'tris': []}
    for level in (0, 1, 2):
        grp = scene.empty(f'lod{level}', parent=root)
        objs, b = build_lod(spec, car, level, grp, extras)
        copies = {objs['wheel'].name: 4}
        tris = lodlib.tree_tris(grp, copies)
        lo, hi = BUDGET[level]
        # Over budget is reported, not decimated away: a collapse across the lofted panels loses the
        # window and lamp outlines (try hoodlib.lod.decimate on a copy and look at the preview first).
        if not lo * 0.5 <= tris <= hi:
            report.setdefault('warnings', []).append(f'lod{level}: {tris} triangles, budget {lo}..{hi}')
        report['tris'].append(tris)
    anchors = scene.empty('anchors', parent=root)
    d = car.doors()
    b = Body(spec, car)
    sx, sy, sz = d['seat']
    scene.empty('anchor_seat', (sx, sy, sz), anchors)
    scene.empty('anchor_door', (d['door'][0], 0.0, d['door'][1]), anchors)
    scene.empty('anchor_stand', (d['stand'][0], 0.0, d['stand'][1]), anchors)
    dz1 = spec['doors'][0][1]
    scene.empty('anchor_hinge_door', spec.get('door_hinge') or (b.w(dz1), b.bands(dz1)[2], dz1), anchors)
    scene.empty('anchor_hinge_hood', (0.0, b.y_top(spec['hood_z']), spec['hood_z']), anchors)
    for i, n in enumerate(('FL', 'FR', 'RL', 'RR')):
        scene.empty(f'anchor_wheel_{n}', car.wheel_anchor(i), anchors)
    scene.empty('anchor_engine', (0.0, b.y_top((spec['hood_z'] + b.zf) / 2) - 0.1, (spec['hood_z'] + b.zf) / 2), anchors)
    scene.empty('anchor_bumper_F', (0.0, spec['bumper_front']['y'], b.zf), anchors)
    scene.empty('anchor_bumper_R', (0.0, spec['bumper_rear']['y'], b.zr), anchors)
    scene.empty('anchor_ground', (0.0, car.ground_y, 0.0), anchors)
    root['lod_tris'] = report['tris']
    return report
