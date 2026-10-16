"""Atlanta's street and park trees, built from numbers: five species, each with a near model (trunk,
branches, an opaque core and alpha-tested leaf cards) and a mid model (trunk, a few branches and
leaf clumps as low-poly blobs, no alpha). The far level is an impostor the game bakes from the near
model at load time (src/client/render/Trees.ts), so there is nothing to build for it here.

  tree_<name>           empty root, extras: species index, refH, refR, trunk radius, tris
    tree_<name>_lod0    near: bark + branches + core blobs + leaf cards (vertex alpha > 0.5)
    tree_<name>_lod1    mid: bark + blobs

Sizes come from src/shared/data/propDims.json (the same file the sim's trunk collider reads): the
model is built to `refH` tall with a crown of radius `refR`, and its trunk is `r` thick at 1 m.
Colours are linear albedos, muted (GTA IV's Atlanta); the game adds the autumn tint and the sky/sun
shading. See geo.py for the vertex alpha code.
"""
import json
import math
import os
import random

import bpy
from mathutils import Vector

from hoodlib import scene
from . import geo
from .geo import Geo, mix, scale, srgb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DIMS = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'propDims.json')))['trees']

# name, bark, leaf (sRGB), seed
STYLE = {
    'oak': dict(bark=0x716452, leaf=0x58693a, seed=11, cards=17, card=1.0),
    'sweetgum': dict(bark=0x7e766c, leaf=0x4a6130, seed=23, cards=15, card=1.05),
    'pine': dict(bark=0x7d6350, leaf=0x34472f, seed=37, cards=15, card=0.95),
    'myrtle': dict(bark=0xa8927d, leaf=0x66763e, seed=51, cards=14, card=0.95),
    'redoak': dict(bark=0x65594b, leaf=0x536639, seed=67, cards=18, card=1.05),
}
VERTEX_COLOR = 'ACTIVE'  # COLOR_0 carries the albedo and the leaf/wind code
NAMES = ['oak', 'sweetgum', 'pine', 'myrtle', 'redoak']


class Structure:
    def __init__(self, H, R):
        self.H, self.R = H, R
        self.trunk = None  # (path, radii)
        self.branches = []  # (path, radii)
        self.clumps = []  # dict(c=Vector, r=(rx, ry, rz))
        self.crown = Vector((0, H * 0.62, 0))


def _branch(start, az, elev, length, droop=0.0, r0=0.07, pts=3):
    """A curved limb from `start`: azimuth about +Y, elevation above horizontal."""
    d = Vector((math.cos(az) * math.cos(elev), math.sin(elev), math.sin(az) * math.cos(elev)))
    path = []
    for i in range(pts):
        t = i / (pts - 1)
        p = start + d * (length * t)
        p.y -= droop * length * t * t
        path.append(p)
    radii = [r0 * (1 - 0.7 * i / (pts - 1)) for i in range(pts)]
    return path, radii, path[-1]


def _trunk(H, r1m, top, lean, rng, flare=1.3, taper=0.62, n=6):
    """A trunk to `top` (a height): r1m at 1 m (there is always a ring there), flared at the foot, tapered to the top."""
    r_top = r1m * taper
    ys = [0.0, 0.45, 1.0] + [1.0 + (top - 1.0) * (i + 1) / (n - 2) for i in range(n - 2)]
    path, radii = [], []
    for y in ys:
        t = y / top
        off = lean * t * t
        path.append(Vector((off + rng.uniform(-0.04, 0.04) * t, y, rng.uniform(-0.04, 0.04) * t + 0.3 * off)))
        if y < 1.0:
            radii.append(r1m * (1 + (flare - 1) * (1 - y)))
        else:
            radii.append(max(r_top, r1m - (r1m - r_top) * (y - 1.0) / max(top - 1.0, 0.1)))
    return path, radii


def structure(name, d):
    H, R = d['refH'], d['refR']
    rng = random.Random(STYLE[name]['seed'])
    S = Structure(H, R)
    r1 = d['r']
    if name == 'oak':
        top = 0.34 * H
        S.trunk = _trunk(H, r1, 0.94 * H, 0.2, rng, taper=0.3, n=8)
        n = 9
        for i in range(n):
            t = (i + 0.5) / n
            y = (0.34 + 0.46 * t) * H
            az = i * 2.39996 + rng.uniform(-0.3, 0.3)
            L = R * (0.72 - 0.38 * t) + 0.3
            path, radii, end = _branch(Vector((0, y, 0)), az, math.radians(46 - 14 * t), L, 0.1, r1 * (0.55 - 0.25 * t))
            S.branches.append((path, radii))
            k = 1.0 - 0.18 * t
            S.clumps.append(dict(c=end + Vector((0, 0.35, 0)), r=(R * 0.42 * k, R * 0.34 * k, R * 0.42 * k)))
        for f, rr in ((0.58, 0.46), (0.74, 0.42), (0.9, 0.32)):
            S.clumps.append(dict(c=Vector((rng.uniform(-0.3, 0.3), H * f, rng.uniform(-0.3, 0.3))), r=(R * rr, R * rr * 0.8, R * rr)))
        S.crown = Vector((0, H * 0.64, 0))
    elif name == 'sweetgum':
        S.trunk = _trunk(H, r1, 0.9 * H, 0.1, rng, taper=0.28, n=8)
        n = 11
        for i in range(n):
            t = (i + 0.5) / n
            y = (0.3 + 0.55 * t) * H
            az = i * 2.39996 + rng.uniform(-0.25, 0.25)
            L = R * (0.82 - 0.7 * t) + 0.2
            path, radii, end = _branch(Vector((0, y, 0)), az, math.radians(34 + 18 * t), L, 0.05, r1 * (0.45 - 0.25 * t))
            S.branches.append((path, radii))
            k = 1.0 - 0.45 * t
            S.clumps.append(dict(c=end + Vector((0, 0.2, 0)), r=(R * 0.42 * k + 0.3, R * 0.36 * k + 0.3, R * 0.42 * k + 0.3)))
        S.clumps.append(dict(c=Vector((0, H * 0.93, 0)), r=(R * 0.22, R * 0.3, R * 0.22)))
        S.clumps.append(dict(c=Vector((0, H * 0.62, 0)), r=(R * 0.5, R * 0.5, R * 0.5)))
        S.crown = Vector((0, H * 0.6, 0))
    elif name == 'pine':
        S.trunk = _trunk(H, r1, 0.97 * H, 0.35, rng, flare=1.25, taper=0.3, n=9)
        for i in range(10):
            t = i / 9
            y = (0.5 + 0.43 * t) * H
            az = i * 2.39996 + rng.uniform(-0.3, 0.3)
            L = R * (0.95 - 0.7 * t) * 0.5 + 0.3
            path, radii, end = _branch(Vector((0.35 * t * t * 0.35 * H / 4, y, 0)), az, math.radians(18 + 25 * t), L, 0.12, r1 * 0.25, 2)
            S.branches.append((path, radii))
            k = 1.0 - 0.55 * t
            S.clumps.append(dict(c=end + Vector((0, 0.1, 0)), r=(R * 0.62 * k + 0.45, R * 0.34 * k + 0.35, R * 0.62 * k + 0.45)))
        S.clumps.append(dict(c=Vector((0.1, H * 0.97, 0)), r=(R * 0.22, R * 0.34, R * 0.22)))
        S.crown = Vector((0, H * 0.76, 0))
    elif name == 'myrtle':
        # a short multi-stem trunk that opens into a vase of four or five stems
        for i in range(5):
            az = i * 2.39996 + 0.5
            elev = math.radians(70 - 5 * (i % 2))
            L = H * (0.72 + 0.1 * rng.random())
            path, radii, end = _branch(Vector((0.03 * math.cos(az), 1.3, 0.03 * math.sin(az))), az, elev, L, -0.1, r1 * 0.55, 5)
            radii = [r1 * 0.6 * (1 - 0.65 * k / 4) for k in range(5)]
            S.branches.append((path, radii))
            S.clumps.append(dict(c=end + Vector((0, 0.1, 0)), r=(R * 0.5, R * 0.42, R * 0.5)))
            S.clumps.append(dict(c=path[3] + Vector((0.1 * math.cos(az), 0, 0.1 * math.sin(az))), r=(R * 0.42, R * 0.36, R * 0.42)))
        S.trunk = ([Vector((0, 0, 0)), Vector((0, 0.45, 0)), Vector((0, 1.0, 0)), Vector((0, 1.5, 0))], [r1 * 1.2, r1 * 1.08, r1, r1 * 0.85])
        S.crown = Vector((0, H * 0.68, 0))
    elif name == 'redoak':
        S.trunk = _trunk(H, r1, 0.62 * H, 0.15, rng, flare=1.35, taper=0.65, n=7)
        n = 7
        for i in range(n):
            t = i / (n - 1)
            y = (0.3 + 0.28 * t) * H
            az = i * 2.39996 + rng.uniform(-0.2, 0.2)
            L = R * (0.82 - 0.2 * t)
            path, radii, end = _branch(Vector((0, y, 0)), az, math.radians(32 + 12 * t), L, 0.12, r1 * (0.62 - 0.2 * t), 4)
            S.branches.append((path, radii))
            S.clumps.append(dict(c=end + Vector((0, 0.5, 0)), r=(R * 0.4, R * 0.31, R * 0.4)))
            S.clumps.append(dict(c=path[2] + Vector((0, 1.4, 0)), r=(R * 0.4, R * 0.32, R * 0.4)))
        S.clumps.append(dict(c=Vector((0, H * 0.82, 0)), r=(R * 0.5, R * 0.36, R * 0.5)))
        S.clumps.append(dict(c=Vector((0, H * 0.66, 0)), r=(R * 0.55, R * 0.4, R * 0.55)))
        S.crown = Vector((0, H * 0.7, 0))
    fit(S)
    return S


def fit(S):
    """Scales the crown sideways so its widest point (a clump and its cards) is about 1.1 refR from the trunk, and up/down so the
    top is at refH: whatever the limb arithmetic above gave, the model has the size propDims.json says."""
    ext = max(math.hypot(c['c'].x, c['c'].z) + max(c['r'][0], c['r'][2]) * 1.25 for c in S.clumps)
    top = max(c['c'].y + c['r'][1] * 1.25 for c in S.clumps)
    kx = S.R * 1.1 / ext
    ky = S.H / top
    for path, radii in S.branches:
        for p in path:
            p.x *= kx
            p.z *= kx
            p.y = 1.0 + (p.y - 1.0) * ky if p.y > 1.0 else p.y
    for c in S.clumps:
        c['c'].x *= kx
        c['c'].z *= kx
        c['c'].y = 1.0 + (c['c'].y - 1.0) * ky
        c['r'] = (c['r'][0] * kx, c['r'][1] * ky, c['r'][2] * kx)
    tp, tr = S.trunk
    for p in tp:
        p.x *= kx
        p.z *= kx
    S.crown = Vector((S.crown.x * kx, 1.0 + (S.crown.y - 1.0) * ky, S.crown.z * kx))


def _merge_clumps(clumps, target):
    """Greedy: the two nearest clumps become one bigger one, until `target` remain (the mid level)."""
    cl = [dict(c=c['c'].copy(), r=tuple(c['r'])) for c in clumps]
    while len(cl) > target:
        best = None
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                d = (cl[i]['c'] - cl[j]['c']).length
                if best is None or d < best[0]:
                    best = (d, i, j)
        _, i, j = best
        a, b = cl[i], cl[j]
        ca = sum(a['r']) / 3
        cb = sum(b['r']) / 3
        c = (a['c'] * ca + b['c'] * cb) / (ca + cb)
        sep = (a['c'] - b['c']).length / 2
        r = tuple(max(x, y) + sep * 0.55 for x, y in zip(a['r'], b['r']))
        cl[i] = dict(c=c, r=r)
        del cl[j]
    return cl


def build_level(name, S, lod):
    st = STYLE[name]
    H, R = S.H, S.R
    g = Geo()
    rng = random.Random(st['seed'] * 7 + lod)
    bark = srgb(st['bark'])
    leaf = srgb(st['leaf'])
    crown = S.crown
    ext = R * 1.15

    def wind(y):
        return max(0.0, min(1.0, (y / H - 0.15) / 0.85)) ** 1.2

    def ao_at(pos, depth=1.0):
        q = min(1.0, (Vector(pos) - crown).length / ext)
        low = max(0.0, min(1.0, (pos[1] / H - 0.25) / 0.7))
        return (0.5 + 0.5 * q ** 0.8) * (0.7 + 0.3 * low) * (0.65 + 0.35 * depth)

    def shade_n(pos, cc):
        a = (Vector(pos) - cc)
        b = (Vector(pos) - crown)
        return norm_(a) * 0.5 + norm_(b) * 0.4 + Vector((0, 0.35, 0))

    # trunk and limbs
    tpath, trad = S.trunk
    sides_t = 8 if lod == 0 else 6

    def trunk_colour(path):
        def f(i, a):
            y = path[i].y
            dark = 0.55 + 0.45 * (1 - max(0.0, min(1.0, (y / H - 0.2) / 0.6)))
            return scale(bark, dark * (0.9 + 0.12 * math.sin(a * 5.0 + i * 1.7)))
        return f

    g.tube(tpath, trad, sides_t, trunk_colour(tpath), wind=lambda y: 0.15 * wind(y), phase=0.3)
    branches = S.branches
    if lod == 1:
        branches = sorted(branches, key=lambda b: -b[1][0])[: max(3, len(branches) // 2)]
    for path, radii in branches:
        if lod == 1:
            path, radii = [path[0], path[-1]], [radii[0], radii[-1]]
        g.tube(path, radii, 5 if lod == 0 else 4, trunk_colour(path), wind=lambda y: 0.3 * wind(y))

    clumps = S.clumps if lod == 0 else _merge_clumps(S.clumps, {'oak': 8, 'sweetgum': 8, 'pine': 7, 'myrtle': 7, 'redoak': 8}[name])

    def leaf_col(cc, jr, dirv, lighter):
        var = 1.0 + jr.uniform(-0.12, 0.12)
        col = scale(leaf, var)
        col = mix(col, (leaf[0] * 1.5, leaf[1] * 1.45, leaf[2] * 0.8), lighter)
        return col

    big = sorted(range(len(clumps)), key=lambda i: -sum(clumps[i]['r']))[:3]
    for idx, cl in enumerate(clumps):
        cc, rr = cl['c'], cl['r']
        jr = random.Random(st['seed'] * 131 + idx)
        tint = jr.uniform(0.9, 1.1)

        if lod == 1:
            # the three biggest clumps get 80 triangles, the rest 20 (the shader's ragged edge and speckle do the rest)
            sub = 1 if idx in big else 0
            avg = sum(rr) / 3

            def col(d, y, cc=cc, tint=tint):
                lighter = max(0.0, d.y) * 0.45 + 0.1
                q = min(1.0, (Vector((cc.x + d.x * avg, y, cc.z + d.z * avg)) - crown).length / ext)
                ao = (0.45 + 0.55 * q ** 0.8) * (0.62 + 0.38 * max(0.0, min(1.0, y / H)))
                return scale(mix(scale(leaf, tint), (leaf[0] * 1.45, leaf[1] * 1.4, leaf[2] * 0.8), lighter), ao * 1.05)

            g.blob(cc, rr, sub, col, jr, 0.16 if sub else 0.26, lambda pos, d, cc=cc: shade_n(pos, cc), wind=lambda y: wind(y), leaf=False)
        else:
            # an opaque core so the cards never show sky through the middle, then cards on and inside the surface
            core = (rr[0] * 0.66, rr[1] * 0.66, rr[2] * 0.66)

            def ccol(d, y, tint=tint, cc=cc):
                return scale(scale(leaf, tint), ao_at((cc.x, y, cc.z), 0.2) * 0.8)

            g.blob(cc, core, 0, ccol, jr, 0.1, lambda pos, d, cc=cc: shade_n(pos, cc), wind=lambda y: wind(y), leaf=False)
            ncard = st['cards']
            avg = sum(rr) / 3
            for k in range(ncard):
                # a point on a sphere (golden spiral) with a random depth
                zz = 1 - (k + 0.5) * 2 / ncard
                ang = k * 2.39996 + jr.uniform(-0.2, 0.2)
                s = math.sqrt(max(0.0, 1 - zz * zz))
                d = Vector((s * math.cos(ang), zz, s * math.sin(ang)))
                f = jr.uniform(0.62, 1.0)
                pos = Vector((cc.x + d.x * rr[0] * f, cc.y + d.y * rr[1] * f, cc.z + d.z * rr[2] * f))
                size = avg * st['card'] * jr.uniform(0.85, 1.25)
                nrm = (d + Vector((jr.uniform(-0.3, 0.3), jr.uniform(-0.2, 0.3), jr.uniform(-0.3, 0.3)))).normalized()
                lighter = max(0.0, d.y) * 0.4 * f + jr.uniform(0.0, 0.12)
                depth = f
                col = leaf_col(cc, jr, d, lighter)
                col = scale(col, ao_at(pos, depth) * 1.12)
                g.card(pos, nrm, jr.uniform(0, 6.283), size, col, shade_n(pos, cc), wind(pos.y))
    return g


def norm_(v):
    return v.normalized() if v.length > 1e-9 else Vector((0, 1, 0))


def build(asset):
    """Builds every species: tree_<name> with lod0 and lod1. `asset` is the entry name ('trees')."""
    scene.reset()
    mat = bpy.data.materials.new('tree')
    mat.use_nodes = True
    tris = []
    for i, name in enumerate(NAMES):
        d = DIMS[i]
        S = structure(name, d)
        root = scene.empty(f'tree_{name}', props={'species': i, 'refH': d['refH'], 'refR': d['refR'], 'r': d['r']})
        counts = []
        for lod in (0, 1):
            g = build_level(name, S, lod)
            g.to_object(f'tree_{name}_lod{lod}', parent=root, material=mat)
            counts.append(g.tris())
        tris.append(counts)
    return {'asset': asset, 'tris': [t for pair in tris for t in pair], 'species': NAMES, 'perSpecies': tris}
