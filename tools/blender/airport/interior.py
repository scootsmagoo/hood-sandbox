"""The walk-in kit of the airport's halls (the Domestic Terminal, Concourse T): what the interior scripts share on top of the landmark
kit (`landmarks.lm`) and the airport one (`apt`).

`Plan` collects what is not geometry: the collision hull (prisms), the walk network, the scenario points, the place names and the
indoor zones, and checks them (every edge and scenario point 0.5 m clear of every prism, one connected network, each node
reachable from a door). `Plan.interior()` is the sidecar's `interior` block (apt.py's header documents it).

The drawing helpers put furniture into a `Lod` and, where it is solid, its prism into the plan: walls with doorways (`wall`), boxes
(`solid`), seat rows (`seat_row`), counters, screens, planters and trees, stanchion lines, columns, a carousel, light strips.
Everything is deterministic (no sets, no randomness) and in the model frame (+X east, +Y up, +Z south, y = 0 the floor).
"""
import math

from landmarks import lm
from landmarks.lm import mix, shade, srgb

from . import apt

FLOOR_Y = 0.02      # the drawn floor, a hair over the levelled ground
NODE_Y = 0.1        # the walk network's height
CLEAR = 0.5         # an edge or a scenario point keeps this far from every prism

# interior colours (linear)
WALL = srgb(0xe4e0d8)
WALL_D = srgb(0xbdb8ae)
CEIL = srgb(0xeeece6)
TERRAZZO = srgb(0xcdc6ba)
TERRAZZO_D = srgb(0x9a9388)
TERRAZZO_L = srgb(0xe2ddd3)
CARPET = srgb(0x55606c)
STEEL = srgb(0xa9afb5)
STEEL_D = srgb(0x5f656b)
BLACK = srgb(0x26282b)
COUNTER = srgb(0xd9d5cd)
COUNTER_F = srgb(0x5d6772)
SEAT = srgb(0x2f3d52)
SEAT_B = srgb(0x3c4c63)
WOOD = srgb(0x8a6a4a)
GREEN = srgb(0x3f6b34)
GREEN_D = srgb(0x2c5226)
SOIL = srgb(0x4a3a2c)
LIGHT = srgb(0xf6f7ff)
BOARD = srgb(0x203a6e)
GLASS_W = srgb(0x9fb8c4)

# parody airline and shop colours (sign panels are blank colour; the names live only in data)
BRANDS = [srgb(0xe8834e), srgb(0xa3242c), srgb(0x2f6fd0), srgb(0x2e7d4f), srgb(0x1e2f6b), srgb(0xd8b23a), srgb(0x7a3f8f), srgb(0x18908f)]


def yaw_of(dx, dz):
    """A ped's yaw (facing (sin, cos)) from a direction."""
    return round(math.atan2(dx, dz), 4)


# ---------------------------------------------------------------------------------------------- geometry of 2D tests
def _pt_seg(p, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dz * dz
    t = 0.0 if l2 < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2))
    return math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t)


def _seg_x(a, b, c, d):
    def o(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def seg_ring_dist(a, b, ring):
    """Distance from the segment a-b to a polygon (0 when it touches or enters it)."""
    if apt.inside(ring, a[0], a[1]) or apt.inside(ring, b[0], b[1]):
        return 0.0
    best = 1e9
    n = len(ring)
    for i in range(n):
        c, d = ring[i], ring[(i + 1) % n]
        if _seg_x(a, b, c, d):
            return 0.0
        best = min(best, _pt_seg(c, a, b), _pt_seg(d, a, b), _pt_seg(a, c, d), _pt_seg(b, c, d))
    return best


def bbox(ring):
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    return (min(xs), min(zs), max(xs), max(zs))


# ---------------------------------------------------------------------------------------------- the plan
class Plan:
    def __init__(self):
        self.hull = []          # [(ring, height)]
        self.nodes = []         # [(x, z)]
        self.edges = []         # [(a, b, w)]
        self._ek = {}
        self._nk = {}
        self.doors = []
        self.scen = []
        self.places = []
        self.zones = []
        self._grid = None
        self.dropped = []

    # ---- hull
    def add(self, ring, h):
        ring = [(float(p[0]), float(p[1])) for p in ring]
        if abs(lm.area2(ring)) < 0.5:
            # too small to be kept by the report (it drops rings under 0.5 m^2): say so
            self.dropped.append(ring)
            return
        self.hull.append((ring, h))
        self._grid = None

    def add_many(self, prisms):
        for r, h in prisms:
            self.add(r, h)

    def _index(self):
        if self._grid is None:
            g = {}
            for k, (r, _) in enumerate(self.hull):
                x0, z0, x1, z1 = bbox(r)
                for i in range(int(math.floor((x0 - 1) / 8)), int(math.floor((x1 + 1) / 8)) + 1):
                    for j in range(int(math.floor((z0 - 1) / 8)), int(math.floor((z1 + 1) / 8)) + 1):
                        g.setdefault((i, j), []).append(k)
            self._grid = g
        return self._grid

    def _near(self, x0, z0, x1, z1):
        g = self._index()
        out = []
        seen = {}
        for i in range(int(math.floor(x0 / 8)), int(math.floor(x1 / 8)) + 1):
            for j in range(int(math.floor(z0 / 8)), int(math.floor(z1 / 8)) + 1):
                for k in g.get((i, j), ()):
                    if k not in seen:
                        seen[k] = True
                        out.append(k)
        return sorted(out)

    def clearance(self, a, b=None, reach=1.0):
        """The distance from a point or a segment to the nearest prism within `reach` metres (else 9)."""
        b = b or a
        x0, x1 = min(a[0], b[0]) - reach, max(a[0], b[0]) + reach
        z0, z1 = min(a[1], b[1]) - reach, max(a[1], b[1]) + reach
        best = 9.0
        for k in self._near(x0, z0, x1, z1):
            r = self.hull[k][0]
            bx = bbox(r)
            if bx[0] > x1 or bx[2] < x0 or bx[1] > z1 or bx[3] < z0:
                continue
            best = min(best, seg_ring_dist(a, b, r))
            if best <= 0:
                return 0.0
        return best

    def clear(self, a, b=None, c=CLEAR):
        return self.clearance(a, b) >= c

    # ---- walk network
    def node(self, x, z):
        k = (round(x * 5), round(z * 5))
        i = self._nk.get(k)
        if i is None:
            i = len(self.nodes)
            self._nk[k] = i
            self.nodes.append((round(x, 2), round(z, 2)))
        return i

    def edge(self, a, b, w=3.0):
        if a == b:
            return
        k = (min(a, b), max(a, b))
        if k in self._ek:
            return
        self._ek[k] = len(self.edges)
        self.edges.append((k[0], k[1], w))

    def path(self, pts, w=3.0, step=7.0, closed=False):
        """A lane through points (x, z), cut into steps of at most `step` metres; returns the node indices."""
        pts = list(pts) + ([pts[0]] if closed else [])
        ids = [self.node(*pts[0])]
        for a, b in zip(pts, pts[1:]):
            n = max(1, int(math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / step - 1e-6)))
            for k in range(1, n + 1):
                t = k / n
                j = self.node(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                self.edge(ids[-1], j, w)
                ids.append(j)
        return ids

    def nearest(self, x, z, maxd=14.0, k=1, skip=(), clear=True):
        """The k nearest nodes with a clear straight line to (x, z)."""
        c = sorted(((math.hypot(n[0] - x, n[1] - z), i) for i, n in enumerate(self.nodes) if i not in skip), key=lambda t: (round(t[0], 4), t[1]))
        out = []
        for d, i in c:
            if d > maxd:
                break
            if d < 0.05:
                continue
            if not clear or self.clear((x, z), self.nodes[i]):
                out.append(i)
                if len(out) >= k:
                    break
        return out

    def spur(self, x, z, w=2.0, maxd=14.0, k=1):
        """A node at (x, z) joined to its nearest clear node(s); returns its index."""
        others = list(range(len(self.nodes)))
        i = self.node(x, z)
        for j in self.nearest(x, z, maxd, k, skip=(i,)):
            self.edge(i, j, w)
        return i

    def door(self, i):
        if i not in self.doors:
            self.doors.append(i)

    # ---- people and names
    def scenario(self, typ, x, z, yaw, cap=1):
        self.scen.append({'type': typ, 'x': round(x, 2), 'y': NODE_Y, 'z': round(z, 2), 'yaw': round(yaw, 3), 'cap': cap})

    def place(self, name, x, z, r):
        self.places.append({'name': name, 'x': round(x, 1), 'z': round(z, 1), 'r': round(r, 1)})

    def zone(self, ring, ceiling):
        self.zones.append({'ring': apt.ring_out(ring), 'ceiling': round(ceiling, 1)})

    # ---- checks
    def check(self, tag=''):
        bad_e = [(a, b) for a, b, _ in self.edges if not self.clear(self.nodes[a], self.nodes[b])]
        bad_s = [s for s in self.scen if not self.clear((s['x'], s['z']))]
        # components
        adj = [[] for _ in self.nodes]
        for a, b, _ in self.edges:
            adj[a].append(b)
            adj[b].append(a)
        comp = [-1] * len(self.nodes)
        nc = 0
        for s in range(len(self.nodes)):
            if comp[s] >= 0:
                continue
            stack = [s]
            comp[s] = nc
            while stack:
                u = stack.pop()
                for v in adj[u]:
                    if comp[v] < 0:
                        comp[v] = nc
                        stack.append(v)
            nc += 1
        sizes = [comp.count(c) for c in range(nc)]
        door_comps = sorted(set(comp[d] for d in self.doors)) if self.doors else []
        unreached = [i for i in range(len(self.nodes)) if comp[i] not in door_comps]
        print(f'INTERIOR_CHECK {tag} nodes {len(self.nodes)} edges {len(self.edges)} doors {len(self.doors)} scen {len(self.scen)} prisms {len(self.hull)} '
              f'components {nc} sizes {sorted(sizes, reverse=True)[:6]} bad_edges {len(bad_e)} bad_scen {len(bad_s)} unreached {len(unreached)} dropped_prisms {len(self.dropped)}')
        for r in self.dropped[:20]:
            print('  DROPPED', [(round(p[0], 2), round(p[1], 2)) for p in r])
        for a, b in bad_e[:40]:
            print('  BAD_EDGE', self.nodes[a], self.nodes[b], round(self.clearance(self.nodes[a], self.nodes[b]), 2))
        for s in bad_s[:40]:
            print('  BAD_SCEN', s['type'], s['x'], s['z'], round(self.clearance((s['x'], s['z'])), 2))
        return bad_e, bad_s

    def prune(self):
        """Drops the edges and scenario points that are not clear (after a check reported them), and nodes left alone."""
        keep = [(a, b, w) for a, b, w in self.edges if self.clear(self.nodes[a], self.nodes[b])]
        self.scen = [s for s in self.scen if self.clear((s['x'], s['z']))]
        used = [False] * len(self.nodes)
        for a, b, _ in keep:
            used[a] = used[b] = True
        for d in self.doors:
            used[d] = True
        remap = {}
        nodes = []
        for i, n in enumerate(self.nodes):
            if used[i]:
                remap[i] = len(nodes)
                nodes.append(n)
        self.nodes = nodes
        self.edges = [(remap[a], remap[b], w) for a, b, w in keep]
        self.doors = [remap[d] for d in self.doors]
        self._nk = {(round(n[0] * 5), round(n[1] * 5)): i for i, n in enumerate(self.nodes)}
        self._ek = {(a, b): i for i, (a, b, _) in enumerate(self.edges)}

    def interior(self):
        return {
            'walk': {'nodes': [[n[0], NODE_Y, n[1]] for n in self.nodes], 'edges': [[a, b, round(w, 1)] for a, b, w in self.edges], 'doors': list(self.doors)},
            'scenarios': self.scen,
            'places': self.places,
            'zones': self.zones,
        }


# ---------------------------------------------------------------------------------------------- drawing helpers
def vquad(l, mat, a, b, y0, y1, col, normal, ao=None):
    """A vertical quad from (x, z) a to b, y0..y1, facing `normal` (x, z)."""
    l.quad(mat, (a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), col, hint=(normal[0], 0.0, normal[1]), ao=ao)


def hquad(l, mat, x0, z0, x1, z1, y, col, up=True, ao=None):
    l.quad(mat, (x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1), col, hint=(0, 1 if up else -1, 0), ao=ao)


def solid(l, plan, mat, cx, cz, w, d, y0, y1, col, rot=0.0, hull=True, hull_h=None, skip=('-y',), grow=0.0):
    """A box on the floor (base y0, top y1), w along x and d along z before the turn `rot` (radians, about +Y as lm.box). Its
    prism goes into the plan (unless `hull` is False)."""
    l.box(mat, (cx, (y0 + y1) / 2, cz), (w, y1 - y0, d), col, rot=rot, skip=skip)
    if hull and plan is not None:
        plan.add(lm.rect(cx, cz, w + grow, d + grow, rot), hull_h if hull_h is not None else y1)


def wall(l, plan, a, b, h, thick=0.6, gaps=(), sides=None, top=None, hull_h=None, y0=0.0, ends=True, ao=None):
    """A straight wall centred on a-b (x, z) from y0 to h. `gaps`: [(s0, s1, head)] metres from a (head: top of the opening, None for
    a full-height gap). `sides`: {+1: (mat, col), -1: (mat, col)}: +1 is the side to the left walking a -> b (normal (-dz, dx))... the
    faces drawn. `top`: (mat, col) of the top face. The solid spans go into the hull."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz)
    if ln < 1e-6:
        return
    ux, uz = dx / ln, dz / ln
    nl = (uz, -ux)       # +1 side
    sides = sides if sides is not None else {1: ('lm_interior', WALL), -1: ('lm_interior', WALL)}

    def at(s, side, off=None):
        o = thick / 2 if off is None else off
        n = nl if side > 0 else (-nl[0], -nl[1])
        return (a[0] + ux * s + n[0] * o, a[1] + uz * s + n[1] * o)

    gs = sorted((max(0.0, g0), min(ln, g1), hd) for g0, g1, hd in gaps if g1 > 0 and g0 < ln)
    spans = []
    t = 0.0
    for g0, g1, _ in gs:
        if g0 > t + 1e-6:
            spans.append((t, g0))
        t = max(t, g1)
    if t < ln - 1e-6:
        spans.append((t, ln))
    for s0, s1 in spans:
        for side, mc in sides.items():
            if mc is None:
                continue
            n = nl if side > 0 else (-nl[0], -nl[1])
            vquad(l, mc[0], at(s0, side), at(s1, side), y0, h, mc[1], n, ao=ao)
        if top is not None:
            p = [at(s0, 1), at(s1, 1), at(s1, -1), at(s0, -1)]
            l.poly(top[0], [(q[0], h, q[1]) for q in p], top[1], hint=(0, 1, 0))
        if ends:
            mc = sides.get(1) or sides.get(-1)
            for s, sg in ((s0, -1), (s1, 1)):
                if (s < 1e-6 or s > ln - 1e-6) and ends != 'all':
                    continue
                vquad(l, mc[0], at(s, 1), at(s, -1), y0, h, shade(mc[1], 0.92), (ux * sg, uz * sg))
        if plan is not None:
            plan.add(apt.seg_prism((a[0] + ux * s0, a[1] + uz * s0), (a[0] + ux * s1, a[1] + uz * s1), thick), hull_h if hull_h is not None else h)
    # lintels over the openings
    for g0, g1, hd in gs:
        if hd is None or hd >= h:
            continue
        for side, mc in sides.items():
            if mc is None:
                continue
            n = nl if side > 0 else (-nl[0], -nl[1])
            vquad(l, mc[0], at(g0, side), at(g1, side), hd, h, mc[1], n)
        mc = sides.get(1) or sides.get(-1)
        p = [at(g0, 1), at(g1, 1), at(g1, -1), at(g0, -1)]
        l.poly(mc[0], [(q[0], hd, q[1]) for q in p], shade(mc[1], 0.85), hint=(0, -1, 0))
    return spans


def seat_row(l, plan, a, b, facing, n, pair=False, col=SEAT, frame=STEEL_D, hull=True):
    """A beam of `n` airport seats from a to b (x, z), facing `facing` (x, z) (the other way too when `pair`: back to back). The
    backrest line is a-b. Returns the seat front points [(x, z, yaw)] (the front edge, facing away from the backrest)."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz)
    ux, uz = dx / ln, dz / ln
    fl = math.hypot(*facing)
    fx, fz = facing[0] / fl, facing[1] / fl
    rot = math.atan2(-uz, ux)    # lm.box: local +x along the row
    cx, cz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    out = []
    for sgn in ((1, -1) if pair else (1,)):
        gx, gz = fx * sgn, fz * sgn
        # the seat pan: one long cushion strip, its top cut per seat (alternate shades)
        o0, o1 = 0.1, 0.62
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            p0 = (a[0] + dx * t0 + gx * o0, a[1] + dz * t0 + gz * o0)
            p1 = (a[0] + dx * t1 + gx * o0, a[1] + dz * t1 + gz * o0)
            p2 = (a[0] + dx * t1 + gx * o1, a[1] + dz * t1 + gz * o1)
            p3 = (a[0] + dx * t0 + gx * o1, a[1] + dz * t0 + gz * o1)
            c = col if k % 2 == 0 else shade(col, 1.12)
            l.poly('lm_interior', [(p[0], 0.47, p[1]) for p in (p0, p1, p2, p3)], c, hint=(0, 1, 0))
            # the backrest face of this seat
            q0 = (a[0] + dx * t0 + gx * 0.08, a[1] + dz * t0 + gz * 0.08)
            q1 = (a[0] + dx * t1 + gx * 0.08, a[1] + dz * t1 + gz * 0.08)
            vquad(l, 'lm_interior', q0, q1, 0.5, 0.98, shade(c, 0.94), (gx, gz))
            if k % 2 == 0 and k + 2 <= n:
                # the seat's middle: where one sits
                tm = (k + 0.5) / n
                out.append((a[0] + dx * tm + gx * 0.66, a[1] + dz * tm + gz * 0.66, yaw_of(gx, gz)))
            elif k % 2 == 1:
                tm = (k + 0.5) / n
                out.append((a[0] + dx * tm + gx * 0.66, a[1] + dz * tm + gz * 0.66, yaw_of(gx, gz)))
        # the cushion's front face
        f0 = (a[0] + gx * o1, a[1] + gz * o1)
        f1 = (b[0] + gx * o1, b[1] + gz * o1)
        vquad(l, 'lm_interior', f0, f1, 0.38, 0.47, shade(col, 0.7), (gx, gz))
        # armrests between pairs of seats
        for k in range(0, n + 1, 2):
            t = k / n
            p = (a[0] + dx * t + gx * 0.35, a[1] + dz * t + gz * 0.35)
            l.box('lm_metal', (p[0], 0.62, p[1]), (0.05, 0.3, 0.55), frame, rot=rot, skip=('-y', '-x', '+x') if 0 < k < n else ('-y',))
    # the beam, the shared back and the legs
    l.box('lm_metal', (cx, 0.36, cz), (ln, 0.08, 0.12 if not pair else 0.3), frame, rot=rot, skip=('-y', '-x', '+x'))
    l.box('lm_interior', (cx, 0.74, cz), (ln, 0.48, 0.12), shade(col, 0.8), rot=rot, skip=('-y',))
    nl = max(2, int(round(ln / 3.0)) + 1)
    for k in range(nl):
        t = 0.04 + 0.92 * k / (nl - 1)
        l.box('lm_metal', (a[0] + dx * t, 0.17, a[1] + dz * t), (0.08, 0.34, 0.5 if not pair else 1.0), frame, rot=rot, skip=('-y', '+y'))
    if hull and plan is not None:
        plan.add(apt.seg_prism(a, b, 0.3), 1.0)
    return out


def screen(l, x, y, z, w, h, facing, col=BOARD, frame=BLACK, depth=0.12, rows=0):
    """An emissive panel (a departures board, a sign) centred at (x, y, z), w wide, h high, facing (x, z), in a dark frame.
    `rows` > 0 draws lighter line bands across the panel (a board's lines, without text)."""
    fl = math.hypot(*facing)
    fx, fz = facing[0] / fl, facing[1] / fl
    rot = math.atan2(fx, fz)   # lm.box: local +z to the facing
    l.box('lm_dark', (x, y, z), (w + 0.16, h + 0.16, depth), frame, rot=rot)
    px, pz = x + fx * (depth / 2 + 0.01), z + fz * (depth / 2 + 0.01)
    ax, az = fz, -fx   # along the panel (to the viewer's left)... either way
    a = (px - ax * w / 2, pz - az * w / 2)
    b = (px + ax * w / 2, pz + az * w / 2)
    if rows <= 0:
        vquad(l, 'lm_screen', a, b, y - h / 2, y + h / 2, col, (fx, fz))
        return
    band = h / rows
    for r in range(rows):
        y0 = y - h / 2 + r * band
        c = col if r % 2 == 0 else shade(col, 1.35)
        vquad(l, 'lm_screen', a, b, y0, y0 + band, c, (fx, fz))


def light_strip(l, x0, z0, x1, z1, y, col=LIGHT):
    """A linear light on a ceiling (a downward emissive quad)."""
    hquad(l, 'lm_screen', x0, z0, x1, z1, y, col, up=False)


def column(l, plan, x, z, r, h, col=WALL, n=10, mat='lm_interior', hull=True, base=None):
    pts = [(r * 1.18, 0.0), (r * 1.18, 0.35), (r, 0.45), (r, h)]
    l.lathe(mat, pts, n, col, cx=x, cz=z, smooth=False)
    if hull and plan is not None:
        plan.add(lm.circle(r * 1.2, 8, x, z, phase=math.pi / 8), h)


def tree(l, x, z, h, r, y0=0.6, sides=7, seed=0):
    """An indoor tree (a ficus): a trunk and three or four foliage blobs, deterministic from `seed`."""
    l.lathe('lm_stone', [(0.16, y0), (0.12, y0 + h * 0.55), (0.06, y0 + h * 0.8)], 5, srgb(0x6b5440), cx=x, cz=z, smooth=False)
    blobs = [(0.0, 0.72, 0.0, 1.0), (0.45, 0.6, 0.3, 0.7), (-0.4, 0.62, -0.35, 0.72), (0.1, 0.88, -0.2, 0.62)]
    for k, (bx, by, bz, s) in enumerate(blobs[: 3 + (seed % 2)]):
        rr = r * s
        cy = y0 + h * by
        prof = [(0.001, cy - rr * 0.75), (rr * 0.85, cy - rr * 0.4), (rr, cy + rr * 0.1), (rr * 0.7, cy + rr * 0.6), (0.001, cy + rr * 0.85)]
        c = GREEN if (k + seed) % 2 == 0 else GREEN_D
        l.lathe('lm_stone', prof, sides, lambda i, c=c: shade(c, 0.8 + 0.12 * i), cx=x + bx * r, cz=z + bz * r, smooth=False, phase=0.4 * (k + seed))


def planter(l, plan, cx, cz, w, d, h=0.65, trees=1, col=srgb(0x8f8a80), tree_h=6.0, seed=0, rot=0.0):
    """A planter box with soil and tree(s); its prism goes into the hull."""
    l.box('lm_stone', (cx, h / 2, cz), (w, h, d), col, rot=rot, skip=('-y',))
    l.box('lm_stone', (cx, h + 0.01, cz), (w - 0.25, 0.02, d - 0.25), SOIL, rot=rot, skip=('-y', '-x', '+x', '-z', '+z'))
    if plan is not None:
        plan.add(lm.rect(cx, cz, w, d, rot), h)
    for k in range(trees):
        t = (k + 0.5) / trees - 0.5
        c, s = math.cos(rot), math.sin(rot)
        tx, tz = cx + t * w * c, cz - t * w * s
        tree(l, tx, tz, tree_h, min(2.4, tree_h * 0.33), y0=h, seed=seed + k)


def stanchions(l, pts, col=STEEL, tape=srgb(0x1f2a44), h=0.95):
    """Queue posts at `pts` (x, z) joined by belts in order (visual only: no hull)."""
    for p in pts:
        l.box('lm_metal', (p[0], h / 2, p[1]), (0.07, h, 0.07), col, skip=('-y',))
        l.box('lm_metal', (p[0], 0.02, p[1]), (0.34, 0.04, 0.34), col, skip=('-y', '-x', '+x', '-z', '+z'))
    for a, b in zip(pts, pts[1:]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz)
        if ln < 0.1:
            continue
        n = (dz / ln, -dx / ln)
        vquad(l, 'lm_dark', a, b, h - 0.12, h - 0.06, tape, n)
        vquad(l, 'lm_dark', a, b, h - 0.12, h - 0.06, tape, (-n[0], -n[1]))


def maze(l, x0, x1, z0, z1, rows, entry_side=-1):
    """A queue maze of stanchion lines across z between x0 and x1 (rows lanes), the gaps at alternate ends. Visual only."""
    out = []
    for r in range(rows + 1):
        z = z0 + (z1 - z0) * r / rows
        if r == 0 or r == rows:
            xs = (x0, x1)
        elif r % 2 == 1:
            xs = (x0, x1 - 1.4)
        else:
            xs = (x0 + 1.4, x1)
        n = max(2, int(round((xs[1] - xs[0]) / 2.2)) + 1)
        pts = [(xs[0] + (xs[1] - xs[0]) * k / (n - 1), z) for k in range(n)]
        stanchions(l, pts)
        out.append(pts)
    return out


def stadium_ring(cx, cz, length, width, n_end=8, along_x=True):
    """The outline of an oval carousel (two half circles joined by straights), CCW."""
    r = width / 2
    s = length / 2 - r
    pts = []
    for k in range(n_end + 1):
        a = -math.pi / 2 + math.pi * k / n_end
        pts.append((s + r * math.cos(a), r * math.sin(a)))
    for k in range(n_end + 1):
        a = math.pi / 2 + math.pi * k / n_end
        pts.append((-s + r * math.cos(a), r * math.sin(a)))
    if along_x:
        return [(cx + p[0], cz + p[1]) for p in pts]
    return [(cx + p[1], cz + p[0]) for p in pts]


def carousel(l, plan, cx, cz, length, width, along_x=True, n_end=8):
    """An oval baggage carousel: a steel skirt, the inclined slat ring, the central island and a bumper rail. Hull 0.9 m."""
    outer = stadium_ring(cx, cz, length, width, n_end, along_x)
    mid = stadium_ring(cx, cz, length - 2.2, width - 2.2, n_end, along_x)
    inner = stadium_ring(cx, cz, length - 2.6, width - 2.6, n_end, along_x)
    m = len(outer)
    cen = (cx, cz)

    def ring3(r, y):
        return [(p[0], y, p[1]) for p in r]
    # skirt (outward faces)
    for i in range(m):
        a, b = outer[i], outer[(i + 1) % m]
        mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
        vquad(l, 'lm_metal', a, b, 0.0, 0.42, STEEL, (mx, mz))
    # bumper rail
    l.skin('lm_metal', [ring3(outer, 0.42), ring3(lm.inset_ring(outer, -0.06), 0.47), ring3(outer, 0.52)], STEEL_D, inside=(cx, 0.47, cz))
    # slats: from the rim up to the island
    rings = [ring3(outer, 0.52), ring3(mid, 0.72)]
    for i in range(m):
        a0, b0 = rings[0][i], rings[0][(i + 1) % m]
        a1, b1 = rings[1][i], rings[1][(i + 1) % m]
        c = BLACK if i % 2 == 0 else shade(BLACK, 1.25)
        l.quad('lm_dark', a0, b0, b1, a1, c, hint=(0, 1, 0))
    # the island's lip and top
    for i in range(m):
        a, b = mid[i], mid[(i + 1) % m]
        mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
        vquad(l, 'lm_metal', a, b, 0.72, 0.9, STEEL, (mx, mz))
    l.poly('lm_metal', [(p[0], 0.9, p[1]) for p in mid], shade(STEEL, 0.9), hint=(0, 1, 0))
    if plan is not None:
        simp = stadium_ring(cx, cz, length, width, 4, along_x)
        plan.add(simp, 0.9)
    return outer


def escalator(l, x0, z0, x1, z1, y0, y1, w=1.2):
    """An escalator from (x0, y0, z0) to (x1, y1, z1): a stepped tread band, two glass balustrades and handrails, a steel truss side."""
    dx, dz = x1 - x0, z1 - z0
    ln = math.hypot(dx, dz)
    ux, uz = dx / ln, dz / ln
    nx, nz = -uz, ux
    steps = 18
    for k in range(steps):
        t0, t1 = k / steps, (k + 1) / steps
        ya, yb = y0 + (y1 - y0) * t0, y0 + (y1 - y0) * t1
        p0 = (x0 + dx * t0, z0 + dz * t0)
        p1 = (x0 + dx * t1, z0 + dz * t1)
        c = STEEL_D if k % 2 == 0 else BLACK
        # riser then tread
        l.quad('lm_metal', (p0[0] - nx * w / 2, ya, p0[1] - nz * w / 2), (p0[0] + nx * w / 2, ya, p0[1] + nz * w / 2),
               (p0[0] + nx * w / 2, yb, p0[1] + nz * w / 2), (p0[0] - nx * w / 2, yb, p0[1] - nz * w / 2), c, hint=(-ux, 0.5, -uz))
        l.quad('lm_metal', (p0[0] - nx * w / 2, yb, p0[1] - nz * w / 2), (p0[0] + nx * w / 2, yb, p0[1] + nz * w / 2),
               (p1[0] + nx * w / 2, yb, p1[1] + nz * w / 2), (p1[0] - nx * w / 2, yb, p1[1] - nz * w / 2), c, hint=(0, 1, 0))
    for s in (-1, 1):
        ox, oz = nx * s * (w / 2 + 0.06), nz * s * (w / 2 + 0.06)
        a = (x0 + ox, y0, z0 + oz)
        b = (x1 + ox, y1, z1 + oz)
        l.quad('lm_window', a, b, (b[0], b[1] + 1.0, b[2]), (a[0], a[1] + 1.0, a[2]), GLASS_W, hint=(nx * s, 0, nz * s))
        l.beam('lm_dark', (a[0], a[1] + 1.02, a[2]), (b[0], b[1] + 1.02, b[2]), 0.08, 0.08, BLACK, caps=False)
        # the truss side below the balustrade
        l.quad('lm_metal', (a[0], a[1] - 0.9, a[2]), (b[0], b[1] - 0.9, b[2]), (b[0], b[1], b[2]), (a[0], a[1], a[2]), STEEL, hint=(nx * s, 0, nz * s))


def mullion_run(l, a, b, y0, y1, step, out, col=STEEL_D, w=0.09, d=0.16, inset=0.0, transoms=()):
    """Vertical mullions (inside faces) every `step` along a-b, and horizontal transoms at the heights `transoms`, on a window wall
    whose outside is `out` (x, z); drawn on the inside (offset `inset` metres in)."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz)
    if ln < 0.2:
        return
    ux, uz = dx / ln, dz / ln
    ix, iz = -out[0], -out[1]
    n = max(1, int(round(ln / step)))
    rot = math.atan2(-uz, ux)
    for k in range(n + 1):
        t = k / n
        px, pz = a[0] + dx * t + ix * (inset + d / 2), a[1] + dz * t + iz * (inset + d / 2)
        l.box('lm_metal', (px, (y0 + y1) / 2, pz), (w, y1 - y0, d), col, rot=rot, skip=('-y', '+y'))
    for y in transoms:
        pa = (a[0] + ix * (inset + 0.05), a[1] + iz * (inset + 0.05))
        pb = (b[0] + ix * (inset + 0.05), b[1] + iz * (inset + 0.05))
        l.beam('lm_metal', (pa[0], y, pa[1]), (pb[0], y, pb[1]), 0.1, 0.07, col, caps=False)


def window_wall(l, a, b, y0, y1, out, u0, kind=lm.K_CIVIC, floors=1, step=1.8, glass_out=True, mull=True, transoms=(), fid=0, ext_col=None, inset=0.12):
    """A floor-to-ceiling window from a to b (x, z), y0..y1, its outside `out` (x, z): an lm_window pane (see-through, facing out) at
    the wall line, mullions inside, and (glass_out) the bld_glass facade quad just outside it for the exterior's look. Returns the
    run's length (for the facade's `u`)."""
    ln = math.hypot(b[0] - a[0], b[1] - a[1])
    vquad(l, 'lm_window', a, b, y0, y1, GLASS_W, out)
    if glass_out:
        o = 0.03
        pa = (a[0] + out[0] * o, a[1] + out[1] * o)
        pb = (b[0] + out[0] * o, b[1] + out[1] * o)
        l.facade_quad('bld_glass', (pa[0], y0, pa[1]), (pb[0], y0, pb[1]), (pb[0], y1, pb[1]), (pa[0], y1, pa[1]), ext_col or srgb(0x45606f), u0, kind, floors, 0, 4, fid, True, hint=(out[0], 0, out[1]))
    if mull:
        mullion_run(l, a, b, y0, y1, step, out, transoms=transoms, inset=inset * 0 + 0.02)
    return ln


def outward(a, b, ring_ccw_sign):
    """The outward normal (x, z) of an edge a-b of a ring whose signed area has the sign `ring_ccw_sign`."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz) or 1.0
    s = ring_ccw_sign
    return (dz / ln * s, -dx / ln * s)


def rect_xz(x0, z0, x1, z1):
    """A rectangle ring from its corners (CCW in the x-z plane's sense of lm.area2)."""
    return [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]


def clean(lod):
    """Drops repeated triangles (the same three vertices: a face drawn twice) and degenerate ones from every part of a level, so
    Blender's mesh is valid. Order is kept (deterministic). Returns the number dropped."""
    dropped = 0
    for part in lod.all_parts():
        seen = {}
        out = []
        for t in part.t:
            k = tuple(sorted(t))
            if k in seen:
                dropped += 1
                continue
            a, b, c = part.p[t[0]], part.p[t[1]], part.p[t[2]]
            u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
            cr = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            if cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2] < 1e-10:
                dropped += 1
                continue
            seen[k] = True
            out.append(t)
        part.t = out
    return dropped
