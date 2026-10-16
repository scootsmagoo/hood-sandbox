"""Animation: a pose is a rotation per bone (game-frame Euler angles, radians, about +X left, +Y up,
+Z forward, applied as Rx.Ry.Rz in the bone's parent frame carried through the rest pose) and a
translation of the root and pelvis. A clip is a function from the phase u in [0, 1) to a Pose.

Conventions (same as src/client/render/pedPose.ts): rx of a hanging limb is negative to swing it
forward; rx of an upright spine is positive to lean it forward; ry positive turns left (+X); rz of the
left arm is positive to swing it out. `sym` sets the right side as the mirror of the left.

The bones' rest orientations differ (Blender points each along its length), so a pose angle is turned
into the bone's own axes: q_local = R^-1 . d . R with R the bone's rest rotation (see skeleton.py and
the ragdoll mapping in src/client/render/chars/ragBones.ts, which uses the same rule).
"""
import math

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

from hoodlib.mesh import B2G, G2B

from .skeleton import BONE_NAMES, BONES

FPS = 30
G3 = G2B.to_3x3()
G3i = G3.inverted()


MX = Matrix.Diagonal((-1, 1, 1))


def as_mat(v):
    return rotmat(*v) if isinstance(v, tuple) else v


def mirror_mat(m):
    return MX @ as_mat(m) @ MX


def rotmat(rx, ry, rz):
    m = Matrix.Rotation(rx, 3, 'X') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rz, 3, 'Z')
    return m


class Pose:
    def __init__(self):
        self.rot = {}
        self.loc = {}

    def r(self, bone, rx=0.0, ry=0.0, rz=0.0):
        self.rot[bone] = (rx, ry, rz)
        return self

    def add(self, bone, rx=0.0, ry=0.0, rz=0.0):
        a = self.rot.get(bone, (0.0, 0.0, 0.0))
        self.rot[bone] = (a[0] + rx, a[1] + ry, a[2] + rz)
        return self

    def sym(self, base, rx=0.0, ry=0.0, rz=0.0):
        self.rot[f'{base}_L'] = (rx, ry, rz)
        self.rot[f'{base}_R'] = (rx, -ry, -rz)
        return self

    def side(self, base, side, rx=0.0, ry=0.0, rz=0.0):
        if side == 'L':
            self.rot[f'{base}_L'] = (rx, ry, rz)
        else:
            self.rot[f'{base}_R'] = (rx, -ry, -rz)
        return self

    def set_mat(self, bone, m):
        self.rot[bone] = m
        return self

    def move(self, bone, x=0.0, y=0.0, z=0.0):
        a = self.loc.get(bone, (0.0, 0.0, 0.0))
        self.loc[bone] = (a[0] + x, a[1] + y, a[2] + z)
        return self


def sstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a))) if b != a else (1.0 if x >= b else 0.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


def blend_poses(a, b, t):
    """Linear blend of two poses (angles are small enough for this where it is used)."""
    p = Pose()
    for k in set(a.rot) | set(b.rot):
        x = a.rot.get(k, (0, 0, 0))
        y = b.rot.get(k, (0, 0, 0))
        if isinstance(x, tuple) and isinstance(y, tuple):
            p.rot[k] = tuple(mix(x[i], y[i], t) for i in range(3))
        else:
            p.rot[k] = as_mat(x).to_quaternion().slerp(as_mat(y).to_quaternion(), t).to_matrix()
    for k in set(a.loc) | set(b.loc):
        x = a.loc.get(k, (0, 0, 0))
        y = b.loc.get(k, (0, 0, 0))
        p.loc[k] = tuple(mix(x[i], y[i], t) for i in range(3))
    return p


class Clip:
    def __init__(self, name, duration, fn, loop=True, doc=''):
        self.name, self.duration, self.fn, self.loop, self.doc = name, duration, fn, loop, doc

    def frames(self):
        n = max(2, int(round(self.duration * FPS)))
        return n

    def pose_at(self, u):
        return self.fn(u)


CLIPS = {}


def clip(name, duration, loop=True):
    def deco(fn):
        CLIPS[name] = Clip(name, duration, fn, loop, fn.__doc__ or '')
        return fn
    return deco


# ---- applying poses in Blender ----
_REST = {}


def rest_rotations(rig):
    if rig.name not in _REST:
        _REST[rig.name] = {b.name: b.matrix_local.to_3x3() for b in rig.data.bones}
    return _REST[rig.name]


def apply_pose(rig, pose, frame=None, bones=None):
    R = rest_rotations(rig)
    for name in BONE_NAMES:
        pb = rig.pose.bones[name]
        pb.rotation_mode = 'QUATERNION'
        d = G3 @ as_mat(pose.rot.get(name, (0.0, 0.0, 0.0))) @ G3i
        q = (R[name].inverted() @ d @ R[name]).to_quaternion()
        pb.rotation_quaternion = q
        loc = pose.loc.get(name)
        if loc is not None:
            pb.location = R[name].inverted() @ (G3 @ Vector(loc))
        else:
            pb.location = (0, 0, 0)
        if frame is not None and (bones is None or name in bones):
            pb.keyframe_insert('rotation_quaternion', frame=frame)
            if name in ('root', 'pelvis'):
                pb.keyframe_insert('location', frame=frame)


def bake_clip(rig, c):
    """Creates an action for the clip, a key a frame (n + 1 keys; a loop ends where it began)."""
    act = bpy.data.actions.new(c.name)
    rig.animation_data_create()
    rig.animation_data.action = act
    n = c.frames()
    poses = [c.pose_at(min(1.0, i / n)) for i in range(n + 1)]
    used = set()
    for p in poses:
        for k, v in p.rot.items():
            if not isinstance(v, tuple) or any(abs(x) > 1e-5 for x in v):
                used.add(k)
        for k in p.loc:
            used.add(k)
    for i, p in enumerate(poses):
        apply_pose(rig, p, frame=i + 1, bones=used)
    set_interpolation_linear(act)
    return act


def set_interpolation_linear(act):
    # Blender 5: actions are layered/slotted; walk the channelbags
    try:
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        for kp in fc.keyframe_points:
                            kp.interpolation = 'LINEAR'
    except AttributeError:
        pass


def apply_test_pose(spec):
    """`name:u` poses the rig from a clip at phase u (for view.py)."""
    name, _, u = spec.partition(':')
    rig = bpy.data.objects['rig']
    from . import clips  # noqa: F401  (registers the clips)
    apply_pose(rig, CLIPS[name].pose_at(float(u or 0)))
    bpy.context.view_layer.update()


# ---- forward kinematics and two-bone IK in the figure frame ----
def fk(pose):
    """Joint positions (the bone heads) and accumulated rotations of a pose, in the figure frame."""
    out = {}
    for name in BONE_NAMES:
        b = BONES[name]
        p = b['parent']
        head = Vector(b['head'])
        d = as_mat(pose.rot.get(name, (0.0, 0.0, 0.0)))
        loc = Vector(pose.loc.get(name, (0.0, 0.0, 0.0)))
        if p is None:
            out[name] = (head + loc, d)
        else:
            pp, Qp = out[p]
            out[name] = (pp + Qp @ (head - Vector(BONES[p]['head']) + loc), Qp @ d)
    return out


def _dir(name):
    b = BONES[name]
    return (Vector(b['tail']) - Vector(b['head'])).normalized()


def _length(name):
    b = BONES[name]
    return (Vector(b['tail']) - Vector(b['head'])).length


def arc(a, b):
    return a.rotation_difference(b).to_matrix()


def limb_ik(pose, side, kind, target, pole, twist=0.0, mirror=True):
    """Points an arm (kind 'arm': upperarm, forearm; 'leg': thigh, shin) so the end of the second
    bone reaches `target` (figure frame, as written for the left side; mirrored for 'R'). `pole` is
    the direction the middle joint bends toward. The pose's torso must be set first."""
    up, lo, par = ('upperarm', 'forearm', 'clavicle') if kind == 'arm' else ('thigh', 'shin', 'pelvis')
    nu, nl = f'{up}_{side}', f'{lo}_{side}'
    t = Vector(target)
    po = Vector(pole)
    if side == 'R' and mirror:
        t.x = -t.x
        po.x = -po.x
    F = fk(pose)
    S, _ = F[nu]
    Qp = F[f'{par}_{side}' if kind == 'arm' else par][1]
    Lu, Lf = _length(nu), _length(nl)
    v = t - S
    d = max(abs(Lu - Lf) + 1e-3, min(v.length, Lu + Lf - 1e-3))
    u = v.normalized()
    a = (Lu * Lu - Lf * Lf + d * d) / (2 * d)
    h = math.sqrt(max(Lu * Lu - a * a, 0.0))
    n = po - u * po.dot(u)
    n = n.normalized() if n.length > 1e-6 else Vector((0, 0, 1)).cross(u).normalized()
    E = S + u * a + n * h
    du = (E - S).normalized()
    df = (S + u * d - E).normalized()
    d_u = arc(_dir(nu), Qp.inverted() @ du)
    if twist:
        d_u = d_u @ Matrix.Rotation(twist, 3, _dir(nu))
    Qu = Qp @ d_u
    d_l = arc(_dir(nl), Qu.inverted() @ df)
    pose.rot[nu] = d_u
    pose.rot[nl] = d_l
    return pose
