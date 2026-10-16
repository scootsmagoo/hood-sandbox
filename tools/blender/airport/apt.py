"""What every Hartsfield-Jackson hero script shares (tools/blender/airport/): the real outlines and gates it is built to
(airport.json, written by footprints.ts from the pipeline cache), the jet bridges, hull helpers for walls with doorways, and
the report build.mjs turns into the `<id>.json` sidecar the bake reads from public/assets/airport/.

The models use the landmark kit (`landmarks.lm`: `Lod`, `ring_walls`, `prism`, `box`, `beam`, `tube`, ..., `emit`) and its
materials, plus the interior ones (`lm_interior`, `lm_floor`, `lm_window`, `lm_screen`; see the lm.py header).

Frame: the model's origin is its anchor (airport.json `heroes[id].anchor`, a game point) at the FLOOR: y = 0 is the floor the
bake levels the ground to (`elevation`, metres above sea level, the same in every tile the model touches). +X east, +Y up,
+Z south, not rotated (yaw 0): the outlines are drawn where they are.

The sidecar (docs/contracts/m1-tile-format.md, "Hero landmarks", and its airport fields):

    elevation   metres above sea level of the model's y = 0 (the bake's datum for the model, its hull and its floor)
    flatten     [{ring, margin}]: model-frame rings the bake levels the ground inside to y = 0, blending back over `margin` m
    interior    the walk-in part, model frame, y above the floor:
                  walk: {nodes: [[x, y, z]], edges: [[a, b, width]], doors: [node index]}  the walk network inside; a door node
                        is joined to the street's walk network (the nearest outside node within 30 m, a straight clear line)
                  scenarios: [{type, x, y, z, yaw, cap}]  where people stand about: 'seat' (sit on a seat the model draws),
                        'corner' (wait, on the phone), 'shopfront' (browse), 'eatery' (queue, chat), 'plaza' (chat, photograph)
                  places: [{name, x, z, r}]  names the street-name label shows inside (Security Checkpoint, Gate T5 ...)
                  zones: [{ring, ceiling}]  where someone is indoors (the client dims the sky light there)
    hooks       {transitStation: {...}}: rooms left open for other layers (the MARTA platform in the Domestic Terminal)
    hull        collision prisms as for any landmark (ring, height above the floor): for a walk-in hall the WALLS (thin prisms,
                gaps where the doors are), the counters, carousels, seat rows, planters and columns, never the hall's floor
"""
import json
import math
import os

from hoodlib import scene
from landmarks import lm

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
_DATA = None
_AC = None


def data():
    global _DATA
    if _DATA is None:
        _DATA = json.load(open(os.path.join(HERE, 'airport.json')))
    return _DATA


def aircraft():
    """src/shared/data/aircraft.json: the classes' dimensions (door sill heights for the jet bridges)."""
    global _AC
    if _AC is None:
        _AC = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'aircraft.json')))
    return _AC


def hero(hid):
    return data()['heroes'][hid]


def local(hid, p):
    """A game (x, z) point in the model frame of `hid`."""
    a = hero(hid)['anchor']
    return (p[0] - a['x'], p[1] - a['z'])


def gates(hid):
    """The gates of a hero in its model frame: ref, gate (x, z) on the wall, root (x, z) of the jet bridge, stand (x, z), yaw of
    the parked aircraft (nose (sin, cos)), size class, tip (x, y, z) of the jet bridge at the L1 door, the lead-in line."""
    out = []
    for g in data()['gates']:
        if g['hero'] != hid:
            continue
        t = g['tip']
        out.append({
            'ref': g['ref'], 'size': g['size'], 'yaw': g['yaw'],
            'gate': local(hid, g['gate']), 'root': local(hid, g['root']), 'stand': local(hid, g['stand']),
            'tip': (local(hid, (t[0], t[2]))[0], t[1], local(hid, (t[0], t[2]))[1]),
            'leadIn': [local(hid, p) for p in g['leadIn']],
        })
    return out


def start():
    scene.reset()


def _r(v, d=2):
    return round(v, d)


def ring_out(ring):
    return [[_r(p[0]), _r(p[1])] for p in ring]


def report(asset, hid, lods, hull, lod_from, cutout=None, flatten=None, interior=None, hooks=None, extra=None, clear=None, overlap=0.4):
    """The sidecar of a hero (see the module header). `hull`: [(ring, height)]; `flatten`: [(ring, margin)]."""
    h = hero(hid)
    counts = lm.emit(lods, asset)
    lo, hi = [1e9] * 3, [-1e9] * 3
    for part in lods[0].all_parts():
        for p in part.p:
            for k in range(3):
                lo[k] = min(lo[k], p[k])
                hi[k] = max(hi[k], p[k])
    r = max(abs(lo[0]), abs(hi[0]), abs(lo[2]), abs(hi[2]))
    side = {
        'id': hid,
        'anchor': h['anchor'],
        'yaw': 0,
        'elevation': h['elevation'],
        'height': _r(hi[1], 1),
        'bounds': {'min': [_r(v, 1) for v in lo], 'max': [_r(v, 1) for v in hi]},
        'radius': _r(r, 1),
        'lods': [{'tris': c, 'from': lod_from[i]} for i, c in enumerate(counts)],
        'hull': [{'ring': ring_out(ring), 'height': _r(ht, 1)} for ring, ht in hull if abs(lm.area2(ring)) >= 0.5],
        'cutout': ring_out(cutout if cutout is not None else h['rings'][0]),
        'replaces': {'osm': h['osm'], 'overlap': overlap},
    }
    if flatten:
        side['flatten'] = [{'ring': ring_out(ring), 'margin': _r(m, 1)} for ring, m in flatten]
    if interior:
        side['interior'] = interior
    if hooks:
        side['hooks'] = hooks
    if clear:
        side['clear'] = [ring_out(c) for c in clear]
    if extra:
        side.update(extra)
    return {'asset': asset, 'tris': counts, 'sidecar': side}


# ---------------------------------------------------------------------------------------------- hull helpers
def seg_prism(a, b, thick):
    """A thin prism ring along the segment a-b (x, z), `thick` metres across."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz) or 1.0
    nx, nz = -dz / ln * thick / 2, dx / ln * thick / 2
    return [(a[0] + nx, a[1] + nz), (b[0] + nx, b[1] + nz), (b[0] - nx, b[1] - nz), (a[0] - nx, a[1] - nz)]


def wall_hull(path, height, thick=0.5, gaps=(), closed=False):
    """Hull prisms of a wall along a polyline, leaving out the gaps: `gaps` = [(s0, s1)] in metres along the path (doorways).
    Returns [(ring, height)]."""
    pts = list(path) + ([path[0]] if closed else [])
    out = []
    s = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        if ln < 1e-6:
            continue
        # the pieces of [s, s + ln] outside every gap
        cuts = sorted((max(g0, s), min(g1, s + ln)) for g0, g1 in gaps if g1 > s and g0 < s + ln)
        t0 = s
        spans = []
        for c0, c1 in cuts:
            if c0 > t0:
                spans.append((t0, c0))
            t0 = max(t0, c1)
        if t0 < s + ln:
            spans.append((t0, s + ln))
        for u0, u1 in spans:
            if u1 - u0 < 0.3:
                continue
            f0, f1 = (u0 - s) / ln, (u1 - s) / ln
            p0 = (a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0)
            p1 = (a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1)
            out.append((seg_prism(p0, p1, thick), height))
        s += ln
    return out


def rect_ring(cx, cz, w, d, rot=0.0):
    """A w x d rectangle (x, z) about (cx, cz), turned by `rot` radians, counter-clockwise."""
    c, s = math.cos(rot), math.sin(rot)
    pts = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    return [(cx + x * c - z * s, cz + x * s + z * c) for x, z in pts]


# ---------------------------------------------------------------------------------------------- jet bridges
BRIDGE_W = 2.7      # outer width of the tunnel
BRIDGE_H = 2.9      # outer height
ROOT_Y = 3.4        # the tunnel's floor at the concourse wall (the gate level)


def jet_bridge(lod, g, col_body, col_glass, col_dark, root_y=ROOT_Y, wall_out=0.0):
    """Draws the jet bridge of gate `g` (from `gates()`): a fixed link from the wall to a rotunda on a column, a telescoping
    tunnel down (or up) to the cab at the parked aircraft's L1 door, on a wheeled drive leg. Returns the hull prisms of the
    legs (the tunnel itself floats: one can walk and drive under it)."""
    rx, rz = g['root']
    tx, ty, tz = g['tip']
    # the rotunda stands a few metres out from the wall, towards the tip
    dx, dz = tx - rx, tz - rz
    ln = math.hypot(dx, dz) or 1.0
    ux, uz = dx / ln, dz / ln
    rot = (rx + ux * (4.0 + wall_out), rz + uz * (4.0 + wall_out))
    detail = lod.index == 0
    # the fixed link: wall to rotunda, level at the gate floor
    lod.beam('lm_metal', (rx, root_y + BRIDGE_H / 2, rz), (rot[0], root_y + BRIDGE_H / 2, rot[1]), BRIDGE_W, BRIDGE_H, col_body)
    # the rotunda and its column
    lod.box('lm_metal', (rot[0], root_y + 1.6, rot[1]), (3.6, 3.4, 3.6), col_body, y_is_base=False)
    hull = [(rect_ring(rot[0], rot[1], 1.1, 1.1), root_y)]
    lod.box('lm_stone', (rot[0], root_y / 2, rot[1]), (0.9, root_y, 0.9), col_dark, y_is_base=False)
    # the telescoping tunnel: two sections, the outer a little bigger; the cab square to the aircraft
    yaw = math.atan2(ux, uz)
    cab = (tx - ux * 2.2, tz - uz * 2.2)
    mid = (rot[0] + (cab[0] - rot[0]) * 0.55, rot[1] + (cab[1] - rot[1]) * 0.55)
    ym = root_y + (ty - root_y) * 0.55
    lod.beam('lm_metal', (rot[0] + ux * 1.8, root_y + BRIDGE_H / 2, rot[1] + uz * 1.8), (mid[0], ym + BRIDGE_H / 2, mid[1]), BRIDGE_W, BRIDGE_H, col_body)
    lod.beam('lm_metal', (mid[0] - ux * 0.5, ym + BRIDGE_H / 2 - 0.05, mid[1] - uz * 0.5), (cab[0], ty + BRIDGE_H / 2 - 0.05, cab[1]), BRIDGE_W - 0.2, BRIDGE_H - 0.15, col_body)
    if detail:
        # a window strip down each side of the tunnel
        for side in (-1, 1):
            ox, oz = -uz * side * (BRIDGE_W / 2 + 0.01), ux * side * (BRIDGE_W / 2 + 0.01)
            lod.beam('lm_glass', (rot[0] + ux * 2.5 + ox, root_y + 1.75, rot[1] + uz * 2.5 + oz), (cab[0] + ox, ty + 1.75, cab[1] + oz), 0.02, 0.7, col_glass)
    # the cab at the door, and the canopy (bellows) closing on the fuselage
    lod.box('lm_metal', (cab[0] + ux * 1.0, ty + BRIDGE_H / 2, cab[1] + uz * 1.0), (3.4, BRIDGE_H + 0.2, 3.0), col_body, rot=yaw)
    lod.box('lm_dark', (tx - ux * 0.45, ty + 1.15, tz - uz * 0.45), (2.6, 2.3, 0.9), col_dark, rot=yaw)
    # the drive leg: two posts on a wheeled bogie under the outer tunnel
    leg = (rot[0] + (cab[0] - rot[0]) * 0.72, rot[1] + (cab[1] - rot[1]) * 0.72)
    yl = root_y + (ty - root_y) * 0.72
    for side in (-1, 1):
        px, pz = leg[0] - uz * side * 0.9, leg[1] + ux * side * 0.9
        lod.box('lm_metal', (px, yl / 2, pz), (0.35, yl, 0.35), col_dark, y_is_base=False)
    lod.box('lm_dark', (leg[0], 0.45, leg[1]), (2.6, 0.9, 1.2), col_dark, rot=yaw, y_is_base=False)
    hull.append((rect_ring(leg[0], leg[1], 2.6, 1.2, -yaw), 0.9))
    return hull


# ---------------------------------------------------------------------------------------------- outline helpers
def inside(ring, x, z):
    """Even-odd point-in-ring test, (x, z)."""
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        a, b = ring[i], ring[j]
        if (a[1] > z) != (b[1] > z) and x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
        j = i
    return c


def seg_cross(a, b, ring):
    """Parameters t in [0, 1] along a-b where it crosses an edge of the ring, sorted."""
    out = []
    d1 = (b[0] - a[0], b[1] - a[1])
    for i in range(len(ring)):
        p, q = ring[i], ring[(i + 1) % len(ring)]
        d2 = (q[0] - p[0], q[1] - p[1])
        den = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(den) < 1e-12:
            continue
        t = ((p[0] - a[0]) * d2[1] - (p[1] - a[1]) * d2[0]) / den
        s = ((p[0] - a[0]) * d1[1] - (p[1] - a[1]) * d1[0]) / den
        if 0.0 <= t <= 1.0 and 0.0 <= s <= 1.0:
            out.append(t)
    return sorted(out)


def snap_root(g, rings, embed=0.4):
    """A copy of gate `g` whose jet bridge root is where the line from the tip through the root first meets a wall of `rings`
    (seen from the aircraft), `embed` metres inside it: a bridge then always starts at the facade, never in front of it or
    behind a wall it would pass through (OSM's jet_bridge ways end up to a metre either side of the outline, and a few run over
    a bay of the wall before they reach it)."""
    tx, _, tz = g['tip']
    rx, rz = g['root']
    ln = math.hypot(rx - tx, rz - tz)
    if ln < 1e-6 or any(inside(r, tx, tz) for r in rings):
        return dict(g)
    ux, uz = (rx - tx) / ln, (rz - tz) / ln
    far = (rx + ux * 40.0, rz + uz * 40.0)
    best = None
    for r in rings:
        for t in seg_cross((tx, tz), far, r):
            s = t * (ln + 40.0)
            if s > 1.0 and (best is None or s < best):
                best = s
    out = dict(g)
    if best is not None:
        out['root'] = (tx + ux * (best + embed), tz + uz * (best + embed))
    return out


def self_intersects(ring):
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            c, d = ring[j], ring[(j + 1) % n]
            d1 = (b[0] - a[0], b[1] - a[1])
            d2 = (d[0] - c[0], d[1] - c[1])
            den = d1[0] * d2[1] - d1[1] * d2[0]
            if abs(den) < 1e-12:
                continue
            t = ((c[0] - a[0]) * d2[1] - (c[1] - a[1]) * d2[0]) / den
            s = ((c[0] - a[0]) * d1[1] - (c[1] - a[1]) * d1[0]) / den
            if 1e-9 < t < 1 - 1e-9 and 1e-9 < s < 1 - 1e-9:
                return True
    return False


def offset(ring, d, tol=0.6):
    """The ring grown by d metres (shrunk for d < 0) without self-intersections: the ring is simplified (Douglas-Peucker, `tol`
    metres, more if needed) so the miter offset of short jogs does not fold over; the ring itself if nothing works."""
    from landmarks import parts
    for k in range(6):
        t = tol * (1.8 ** k)
        r = parts.simplify(ring, t, keep=4) if len(ring) > 4 else list(ring)
        if lm.area2(r) < 0:
            r = r[::-1]
        o = lm.inset_ring(r, -d)
        if not self_intersects(o) and (lm.area2(o) > 0):
            return o
    return list(ring)


def trapezoids(rings, angle=0.0, breaks=()):
    """An exact trapezoidal decomposition of the area inside `rings` (even-odd: holes allowed), in strips across the axis
    u = x cos(angle) + z sin(angle). Returns [((u0, va0, vb0), (u1, va1, vb1))]: each a trapezoid between two edges, from u0 to
    u1, v = -x sin + z cos. The strips break at every vertex and at the extra `breaks` (u values), so a roof whose height is
    linear in u between breaks is planar over each piece."""
    c, s = math.cos(angle), math.sin(angle)
    uvr = [[(p[0] * c + p[1] * s, -p[0] * s + p[1] * c) for p in r] for r in rings]
    us = sorted(set([round(p[0], 4) for r in uvr for p in r] + [round(b, 4) for b in breaks]))
    lo = min(p[0] for r in uvr for p in r)
    hi = max(p[0] for r in uvr for p in r)
    us = [u for u in us if lo - 1e-6 <= u <= hi + 1e-6]
    edges = [(r[i], r[(i + 1) % len(r)]) for r in uvr for i in range(len(r))]
    out = []
    for k in range(len(us) - 1):
        u0, u1 = us[k], us[k + 1]
        if u1 - u0 < 1e-3:
            continue
        um = (u0 + u1) / 2
        cross = []
        for p, q in edges:
            if (p[0] < um) != (q[0] < um):
                def v_at(u, p=p, q=q):
                    return p[1] + (q[1] - p[1]) * (u - p[0]) / (q[0] - p[0])
                cross.append((v_at(um), v_at(u0), v_at(u1)))
        cross.sort()
        for j in range(0, len(cross) - 1, 2):
            a, b = cross[j], cross[j + 1]
            out.append(((u0, a[1], b[1]), (u1, a[2], b[2])))
    return out


def uv_to_xz(u, v, angle=0.0):
    c, s = math.cos(angle), math.sin(angle)
    return (u * c - v * s, u * s + v * c)
