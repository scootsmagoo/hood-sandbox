"""The skeleton every character shares, in the game frame (+X the figure's left, +Y up, +Z forward,
feet at y = 0, 1.74 m tall), and the slot list the characters' faces use.

It matches the sim's ragdoll (src/shared/ragdoll.ts): the pelvis bone sits at the ragdoll pelvis
centre (y = 1.0), the thighs hang from y = 0.91 (ragdoll 0.9), the knees are at 0.49 (0.48), the
shoulders at 1.45 (1.47), the head joint at 1.52 (1.5). The eleven ragdoll bodies drive the bones
`pelvis`, `spine` (the torso), `head`, `upperarm_*`, `forearm_*`, `thigh_*` and `shin_*`; the rest
(`chest`, `neck`, the clavicles, hands, feet and toes) follow their parents.

Bone names carry no dots (three.js reads a dot in a track name as a property path): `_L` is the
figure's left (+X), `_R` its right.

The bind pose is a relaxed A-pose: arms hang 12 degrees out from the sides, the elbows and hands
bent a little forward, the knees straight.
"""
import math

# Material slots of a character, in order. The game maps each to a region of its palette
# (src/client/render/chars/regions.ts).
SLOTS = [
    ('skin', (0.42, 0.26, 0.18, 1), 0.0, 0.7),
    ('lip', (0.3, 0.15, 0.12, 1), 0.0, 0.6),
    ('eye', (0.03, 0.02, 0.02, 1), 0.0, 0.3),
    ('sclera', (0.85, 0.83, 0.8, 1), 0.0, 0.4),
    ('hair', (0.03, 0.025, 0.02, 1), 0.0, 0.8),
    ('top', (0.2, 0.3, 0.2, 1), 0.0, 0.9),
    ('top2', (0.7, 0.7, 0.65, 1), 0.0, 0.9),
    ('bottom', (0.12, 0.17, 0.28, 1), 0.0, 0.9),
    ('shoe', (0.1, 0.08, 0.06, 1), 0.0, 0.7),
    ('sole', (0.55, 0.55, 0.5, 1), 0.0, 0.8),
    ('belt', (0.04, 0.035, 0.03, 1), 0.0, 0.6),
    ('hat', (0.5, 0.1, 0.08, 1), 0.0, 0.9),
    ('gear', (0.1, 0.1, 0.12, 1), 0.0, 0.9),
    ('trim', (0.8, 0.85, 0.2, 1), 0.0, 0.5),
    ('stubble', (0.2, 0.14, 0.1, 1), 0.0, 0.8),
    ('face', (0.42, 0.26, 0.18, 1), 0.0, 0.62),
]
SLOT_NAMES = [s[0] for s in SLOTS]


def _v(*a):
    return tuple(float(x) for x in a)


# Joints: name -> (parent, head, tail). Tails are where the next bone's head sits (or a short stub).
A = math.radians(12.0)  # arm abduction in the bind pose
_sa, _ca = math.sin(A), math.cos(A)


def _arm(side):
    sh = _v(side * 0.2, 1.45, 0.0)
    elbow = _v(sh[0] + side * 0.28 * _sa, sh[1] - 0.28 * _ca, 0.012)
    wrist = _v(elbow[0] + side * 0.255 * _sa, elbow[1] - 0.255 * _ca, 0.045)
    tip = _v(wrist[0] + side * 0.19 * _sa * 0.8, wrist[1] - 0.19 * _ca, 0.075)
    return sh, elbow, wrist, tip


def _leg(side):
    hip = _v(side * 0.095, 0.91, 0.0)
    knee = _v(side * 0.092, 0.49, 0.012)
    ankle = _v(side * 0.09, 0.085, -0.004)
    ball = _v(side * 0.09, 0.03, 0.14)
    toe = _v(side * 0.09, 0.02, 0.235)
    return hip, knee, ankle, ball, toe


BONES = {}  # name -> dict(parent, head, tail), in creation order (parents first)


def _add(name, parent, head, tail):
    BONES[name] = {'parent': parent, 'head': head, 'tail': tail}


_add('root', None, _v(0, 0, 0), _v(0, 0.12, 0))
_add('pelvis', 'root', _v(0, 1.0, 0), _v(0, 1.09, 0))
_add('spine', 'pelvis', _v(0, 1.09, 0), _v(0, 1.25, 0))
_add('chest', 'spine', _v(0, 1.25, 0), _v(0, 1.44, 0))
_add('neck', 'chest', _v(0, 1.44, 0), _v(0, 1.52, 0.006))
_add('head', 'neck', _v(0, 1.52, 0.006), _v(0, 1.74, 0.012))
for _n, _s in (('L', 1), ('R', -1)):
    _sh, _el, _wr, _tp = _arm(_s)
    _add(f'clavicle_{_n}', 'chest', _v(_s * 0.02, 1.425, 0.0), _sh)
    _add(f'upperarm_{_n}', f'clavicle_{_n}', _sh, _el)
    _add(f'forearm_{_n}', f'upperarm_{_n}', _el, _wr)
    _add(f'hand_{_n}', f'forearm_{_n}', _wr, _tp)
for _n, _s in (('L', 1), ('R', -1)):
    _hp, _kn, _an, _bl, _to = _leg(_s)
    _add(f'thigh_{_n}', 'pelvis', _hp, _kn)
    _add(f'shin_{_n}', f'thigh_{_n}', _kn, _an)
    _add(f'foot_{_n}', f'shin_{_n}', _an, _bl)
    _add(f'toe_{_n}', f'foot_{_n}', _bl, _to)

BONE_NAMES = list(BONES)

# The ragdoll bodies (RagPart order) and the bone each drives.
RAG_BONES = ['pelvis', 'spine', 'head', 'upperarm_L', 'forearm_L', 'upperarm_R', 'forearm_R', 'thigh_L', 'shin_L', 'thigh_R', 'shin_R']

ARM = {1: _arm(1), -1: _arm(-1)}
LEG = {1: _leg(1), -1: _leg(-1)}
