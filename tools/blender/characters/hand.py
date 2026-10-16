"""The hand at the highest level of detail: a palm, four fingers and a thumb in a relaxed curl, and the
bones that bend them.

Bones (six a hand, `_L` / `_R` like the rest): `thumb_a` (the base, from the wrist's side), `thumb_b`
(the tip), `index_a` / `index_b` (the first finger: knuckle to the middle joint, then the rest), and
`fingers_a` / `fingers_b` (the middle, ring and little fingers move as one). A finger is modelled
curled a little, as a hanging hand's is; a pose bends the bones further (a grip, a fist) or opens them.
Pose angles are about the figure's Z axis (front to back): negative curls a left hand's fingers toward
the palm (see clips.py `finger_pose`, which mirrors for the right).

Everything is in the hand's own frame: `A` along the hand (wrist to fingertips), `F` forward (the side
the thumb is on, +Z in the figure), `P` toward the palm (the hanging hand's palm faces the body).
"""
import math

from mathutils import Vector

from .skeleton import ARM

# name: (knuckle position along the hand `u` and across it `v` from the wrist, the lengths of the first
# bone and of the two knuckle-to-tip pieces of the second, the radius, and the curl (radians) at the
# first, the second and the last joint)
FINGERS = {
    'index': dict(u=0.101, v=0.031, a=0.040, b1=0.024, b2=0.019, r=0.0090, curl=(0.20, 0.46, 0.28), bone='index'),
    'middle': dict(u=0.106, v=0.011, a=0.044, b1=0.027, b2=0.021, r=0.0094, curl=(0.30, 0.56, 0.30), bone='fingers'),
    'ring': dict(u=0.102, v=-0.010, a=0.041, b1=0.026, b2=0.021, r=0.0090, curl=(0.38, 0.62, 0.32), bone='fingers'),
    'pinky': dict(u=0.094, v=-0.029, a=0.032, b1=0.019, b2=0.017, r=0.0080, curl=(0.46, 0.68, 0.34), bone='fingers'),
}
FINGER_W = 0.003      # how far toward the palm the fingers' centres lie at the knuckles


def frame(side):
    """(wrist, A, F, P) of a hand: the wrist joint and the hand's axes in the figure frame."""
    sh, el, wr, tip = ARM[side]
    wr, tip = Vector(wr), Vector(tip)
    A = (tip - wr).normalized()
    F = Vector((0, 0, 1))
    F = (F - A * F.dot(A)).normalized()
    S = A.cross(F)
    return wr, A, F, S * side


def finger_points(side, name):
    """The centre line of a finger as points: base (inside the palm), knuckle, middle joint, the bend
    before the tip, the tip."""
    f = FINGERS[name]
    wr, A, F, P = frame(side)
    k = wr + A * f['u'] + F * f['v'] + P * FINGER_W
    c1, c2, c3 = f['curl']

    def d(phi):
        return A * math.cos(phi) + P * math.sin(phi)
    p0 = k - A * 0.012
    p2 = k + d(c1) * f['a']
    p3 = p2 + d(c1 + c2) * f['b1']
    p4 = p3 + d(c1 + c2 + c3) * f['b2']
    return [p0, k, p2, p3, p4]


def thumb_points(side):
    """Base, the joint, the tip of the thumb (it hangs along the front of the palm)."""
    wr, A, F, P = frame(side)
    base = wr + A * 0.034 + F * 0.027 + P * 0.004
    d1 = (A + F * 0.60 + P * 0.14).normalized()
    j = base + d1 * 0.046
    d2 = (d1 + P * 0.52 - F * 0.10).normalized()
    tip = j + d2 * 0.038
    return [base, j, tip]


def bones(side):
    """(name, parent, head, tail) for the hand's six bones."""
    nm = 'L' if side == 1 else 'R'
    out = []
    t = thumb_points(side)
    out.append((f'thumb_a_{nm}', f'hand_{nm}', t[0], t[1]))
    out.append((f'thumb_b_{nm}', f'thumb_a_{nm}', t[1], t[2]))
    for bone, ref in (('index', 'index'), ('fingers', 'middle')):
        p = finger_points(side, ref)
        out.append((f'{bone}_a_{nm}', f'hand_{nm}', p[1], p[2]))
        out.append((f'{bone}_b_{nm}', f'{bone}_a_{nm}', p[2], p[4]))
    return out
