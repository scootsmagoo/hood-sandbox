"""The geometry of a hand's fingers and thumb (layout and bones in hand.py): rings of small ellipses
along each centre line, skinned to the hand's finger bones."""
import math

from mathutils import Vector

from . import hand as H
from .shapes import BONE_INDEX, mkvert, quad, set_weights


def _ring(c, T, N1, rl, rn, n):
    """n points round a section: `rl` along N1, `rn` along N2 = T x N1 (the same turning sense as shapes.Tube)."""
    N2 = T.cross(N1)
    return [c + N1 * (rl * math.cos(2 * math.pi * (j + 0.5) / n)) + N2 * (rn * math.sin(2 * math.pi * (j + 0.5) / n)) for j in range(n)]


def polytube(mesh, pts, radii, ref, n, mat, weights, cap=True):
    """A tube through `pts` (a ring at each), radii (lateral, thickness) per point, `ref` the lateral axis,
    weights a {bone index: weight} dict per ring. The last ring is closed with a fan (to the tip)."""
    if callable(weights):
        weights = [weights(p) for p in pts]
    rings = []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        T = (b - a).normalized()
        N1 = (ref - T * ref.dot(T)).normalized()
        rl, rn = radii[i]
        vs = []
        for q in _ring(p, T, N1, rl, rn, n):
            v = mesh.bm.verts.new(_bl(q))
            set_weights(mesh, v, weights[i])
            vs.append(v)
        rings.append(vs)
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            f = quad(mesh, [rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]], mat)
            if f:
                faces.append(f)
    if cap:
        last = rings[-1]
        T = (pts[-1] - pts[-2]).normalized()
        tip = pts[-1] + T * radii[-1][0] * 0.55
        tv = mesh.bm.verts.new(_bl(tip))
        set_weights(mesh, tv, weights[-1])
        for j in range(n):
            quad(mesh, [last[j], last[(j + 1) % n], tv], mat)
    return rings


def _bl(p):
    from hoodlib.frame import to_bl
    return to_bl(p.x, p.y, p.z)


def build_fingers(mesh, side, mat='skin'):
    """The four fingers and the thumb of one hand (the palm is the hand tube, body.make_hand)."""
    nm = 'L' if side == 1 else 'R'
    wr, A, F, P = H.frame(side)
    idx = lambda s: BONE_INDEX[f'{s}_{nm}']
    hand = idx('hand')
    for name, f in H.FINGERS.items():
        pts = H.finger_points(side, name)
        a, b = idx(f"{f['bone']}_a"), idx(f"{f['bone']}_b")
        r = f['r']
        # base, knuckle, middle joint, the bend before the tip, the tip
        radii = [(r * 1.12, r * 1.05), (r * 1.05, r * 1.02), (r * 0.96, r * 0.94), (r * 0.86, r * 0.84), (r * 0.62, r * 0.6)]
        weights = [{hand: 1.0}, {hand: 0.5, a: 0.5}, {a: 0.5, b: 0.5}, {b: 1.0}, {b: 1.0}]
        polytube(mesh, pts, radii, F, 5, mat, weights)
    t = H.thumb_points(side)
    ta, tb = idx('thumb_a'), idx('thumb_b')
    d1 = (t[1] - t[0]).normalized()
    d2 = (t[2] - t[1]).normalized()
    mid = t[0] + (t[1] - t[0]) * 0.5
    tip2 = t[1] + (t[2] - t[1]) * 0.5
    pts = [t[0], mid, t[1], tip2, t[2]]
    radii = [(0.0135, 0.0125), (0.0125, 0.0115), (0.0112, 0.0105), (0.0100, 0.0092), (0.0078, 0.0072)]
    weights = [{hand: 0.6, ta: 0.4}, {ta: 1.0}, {ta: 0.5, tb: 0.5}, {tb: 1.0}, {tb: 1.0}]
    polytube(mesh, pts, radii, P, 6, mat, weights)
