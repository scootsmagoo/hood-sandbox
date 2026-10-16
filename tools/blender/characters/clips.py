"""The clips. Each is a function of the phase u in [0, 1): see anim.py for the pose conventions."""
import math

from .anim import Pose, blend_poses, clip, mix, sstep

L1, L2 = 0.42, 0.405      # thigh and shin
HIP_H = 0.91              # hip joint height standing
ANKLE_H = 0.085
TAU = 2 * math.pi


def leg_ik(dz, dy):
    """Angles for an ankle `dz` in front of and `dy` below the hip joint: (thigh forward, knee flex, shin forward)."""
    d = min(math.hypot(dz, dy), L1 + L2 - 1e-4)
    d = max(d, 0.15)
    a = math.atan2(dz, dy)
    alpha = math.acos(max(-1.0, min(1.0, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))))
    k = math.pi - math.acos(max(-1.0, min(1.0, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))))
    at = a + alpha
    return at, k, at - k


def put_leg(p, side, dz, dy, foot_pitch=0.0, pelvis_rx=0.0, yaw=0.0, abd=0.0, toe=0.0):
    """Leg to reach an ankle target. Angles are in the pelvis' frame."""
    at, k, a_s = leg_ik(dz, dy)
    p.side('thigh', side, -at - pelvis_rx, yaw, abd)
    p.side('shin', side, k, 0.0, 0.0)
    p.side('foot', side, a_s - foot_pitch, 0.0, -abd * 0.5)
    p.side('toe', side, toe, 0.0, 0.0)


def foot_cycle(u, s, reach, lift):
    """Ankle offset (z forward, y up) and pitch (toes up positive) of one foot over a gait cycle; u = 0 at heel strike."""
    u = u % 1.0
    if u < s:
        k = u / s
        z = reach * (1 - 2 * k)
        heel = max(0.0, (k - 0.62) / 0.38)
        y = 0.075 * heel ** 1.6
        land = max(0.0, 1 - k / 0.2)
        pitch = 0.28 * land - 0.75 * heel
        if k < 0.2:
            y += 0.015 * land
        toe = 0.55 * heel
    else:
        k = (u - s) / (1 - s)
        e = k * k * (3 - 2 * k)
        z = -reach + 2 * reach * mix(e, k, 0.35)
        y = lift * math.sin(math.pi * min(1.0, k * 1.08)) ** 0.9 + 0.075 * max(0.0, 1 - k * 2.2) ** 1.6
        pitch = mix(-0.75, 0.3, sstep(0.0, 0.95, k))
        toe = 0.55 * max(0.0, 1 - k * 2.5)
    return z, y, pitch, toe


def gait(u, s=0.62, reach=0.33, lift=0.07, c0=0.03, bob=0.03, arm=0.5, elbow0=0.25, elbow1=0.3, lean=0.05, twist=0.12, roll=0.04, shoulder_abd=0.05, head_look=0.0, arm_pump=0.0, hip_sway=0.0):
    p = Pose()
    dy_p = -(c0 + bob * (1 + math.cos(2 * TAU * u)) / 2)
    hip_y = HIP_H + dy_p
    psi = -twist * math.cos(TAU * u)             # pelvis yaw (left hip forward at u = 0)
    prx = lean * 0.2
    p.r('pelvis', prx, psi, roll * math.sin(TAU * u + 0.2))
    p.move('pelvis', hip_sway * math.sin(TAU * u + math.pi / 2), dy_p, 0.0)
    p.r('spine', lean * 0.45, -1.0 * psi, -roll * 0.8 * math.sin(TAU * u + 0.2))
    p.r('chest', lean * 0.35, -0.8 * psi, 0.0)
    p.r('neck', -lean * 0.3, 0.4 * psi + head_look, 0.0)
    p.r('head', -lean * 0.5, 0.4 * psi, 0.0)
    for side, uo, sgn in (('L', 0.0, 1), ('R', 0.5, -1)):
        uu = u + uo
        z, y, pitch, toe = foot_cycle(uu, s, reach, lift)
        put_leg(p, side, z, hip_y - ANKLE_H - y, pitch, prx, -psi, 0.0, toe)
        # arm: opposite to the same-side leg
        swing = -arm * math.cos(TAU * uu)           # forward positive
        flex = elbow0 + elbow1 * (swing + arm) / max(2 * arm, 1e-3) + arm_pump * (swing + arm)
        p.side('clavicle', side, 0.0, 0.0, 0.0)
        p.side('upperarm', side, -swing, 0.0, shoulder_abd)
        p.side('forearm', side, -flex, 0.0, 0.0)
        p.side('hand', side, 0.0, 0.0, 0.0)
    return p


@clip('walk', 1.1)
def walk(u):
    """Walking, 1.5 m/s at the clip's own speed."""
    return gait(u, s=0.62, reach=0.34, lift=0.07, c0=0.025, bob=0.028, arm=0.42, elbow0=0.22, elbow1=0.22, lean=0.04, twist=0.13, roll=0.035)


@clip('jog', 0.76)
def jog(u):
    """A run, 3.3 m/s."""
    return gait(u, s=0.42, reach=0.40, lift=0.17, c0=0.07, bob=0.05, arm=0.62, elbow0=1.05, elbow1=0.25, lean=0.14, twist=0.2, roll=0.04, shoulder_abd=0.1)


@clip('sprint', 0.58)
def sprint(u):
    """A flat-out sprint, 5.5 m/s."""
    return gait(u, s=0.32, reach=0.48, lift=0.25, c0=0.09, bob=0.065, arm=0.85, elbow0=1.25, elbow1=0.2, lean=0.26, twist=0.26, roll=0.04, shoulder_abd=0.1)


# ---------------------------------------------------------------- helpers for the rest of the set
from mathutils import Matrix, Vector  # noqa: E402

from .anim import _dir, arc, fk, limb_ik  # noqa: E402


def arm_rest(p, side, upper=0.05, abd=0.05, fore=0.2, hand=0.0):
    p.side('upperarm', side, -upper, 0.0, abd)
    p.side('forearm', side, -fore, 0.0, 0.0)
    p.side('hand', side, -hand, 0.0, 0.0)


def stand_legs(p, dy=0.0, spread=0.0, fwdL=0.0, fwdR=0.0, bendL=0.0, bendR=0.0, pelvis_rx=0.0):
    """Both feet flat on the ground under hips lowered by `dy` (negative)."""
    hip = HIP_H + dy
    for side, fz, bend in (('L', fwdL, bendL), ('R', fwdR, bendR)):
        put_leg(p, side, fz, hip - ANKLE_H - bend, 0.0, pelvis_rx, 0.0, spread)


def head_pos(p):
    return fk(p)['head'][0]


def reach(p, side, target, pole=None, mirror=False, hand=None):
    """Arm IK to a figure-frame wrist target (actual coordinates unless `mirror`)."""
    if pole is None:
        pole = (-0.4 if side == 'R' else 0.4, -1.0, -0.15)
    limb_ik(p, side, 'arm', target, pole, mirror=mirror)
    if hand is not None:
        p.side('hand', side, *hand)


def point_hand(p, side, direction):
    """Turns a hand to point along `direction` (figure frame), whatever the forearm does: a gun's barrel runs along the hand."""
    Qf = fk(p)[f'forearm_{side}'][1]
    h0 = _dir(f'hand_{side}')
    d = Vector(direction).normalized()
    p.rot[f'hand_{side}'] = Qf.inverted() @ arc(h0, d)


def wob(u, k, ph=0.0):
    return math.sin(TAU * (u * k + ph))


# ---------------------------------------------------------------- stillness
@clip('idle', 4.0)
def idle(u):
    """Standing, weight on the left leg: breathing, a slow sway, a glance."""
    p = Pose()
    b = wob(u, 1)
    sway = wob(u, 1, 0.1)
    p.move('pelvis', 0.012 * sway, -0.002, 0.0)
    p.r('pelvis', 0.01, 0.03 * wob(u, 1, 0.3), 0.025 * sway)
    p.r('spine', 0.015 + 0.008 * b, -0.02 * wob(u, 1, 0.3), -0.02 * sway)
    p.r('chest', 0.012 + 0.012 * b, -0.015 * wob(u, 1, 0.3), 0.0)
    p.r('neck', -0.02, 0.1 * wob(u, 1, 0.5), 0.0)
    p.r('head', -0.03 - 0.02 * wob(u, 2, 0.2), 0.12 * wob(u, 1, 0.5), 0.02 * sway)
    hip = HIP_H - 0.002
    put_leg(p, 'L', 0.0, hip - ANKLE_H, 0.0, 0.01)
    put_leg(p, 'R', 0.05, hip - ANKLE_H - 0.014, 0.0, 0.01, 0.0, 0.04)
    p.sym('clavicle', 0.0, 0.0, 0.01 * b)
    arm_rest(p, 'L', 0.04 + 0.01 * b, 0.06, 0.22)
    arm_rest(p, 'R', 0.06 - 0.01 * b, 0.05, 0.2)
    return p


def turn_gait(u, lean):
    p = gait(u, s=0.5, reach=0.1, lift=0.06, c0=0.02, bob=0.012, arm=0.12, elbow0=0.2, elbow1=0.05, lean=0.03, twist=0.2, roll=0.05, hip_sway=0.0)
    p.add('spine', 0, 0, lean)
    p.add('chest', 0, 0, lean * 0.8)
    return p


@clip('turn_l', 0.9)
def turn_l(u):
    """Stepping round to the left on the spot."""
    return turn_gait(u, -0.05)


@clip('turn_r', 0.9)
def turn_r(u):
    """Stepping round to the right on the spot."""
    return turn_gait(u, 0.05)


@clip('flee', 0.6)
def flee(u):
    """A panicked run: head back, elbows high, arms pumping wide."""
    p = gait(u, s=0.38, reach=0.46, lift=0.22, c0=0.08, bob=0.06, arm=0.8, elbow0=1.35, elbow1=0.1, lean=0.2, twist=0.22, roll=0.05, shoulder_abd=0.5)
    p.add('neck', -0.12)
    p.add('head', -0.1, 0.0, 0.04 * wob(u, 2))
    return p


# ---------------------------------------------------------------- what people do when they stand about
def sit_legs(p, drop=0.43, knee_out=0.0, fwd=0.43, feet_back=0.0):
    hip = HIP_H - drop
    for side, f in (('L', 0.0), ('R', 0.0)):
        put_leg(p, side, fwd - feet_back, hip - ANKLE_H - 0.03, 0.0, 0.0, 0.0, knee_out if side == 'L' else knee_out)
        # a seated foot rests flat: the shin is nearly vertical, the foot level
    return p


@clip('sit', 6.0)
def sit(u):
    """Sitting on a bench, hands in the lap, now and then a look about."""
    p = Pose()
    b = wob(u, 1)
    drop = 0.44
    p.move('pelvis', 0.0, -drop, -0.05)
    p.r('pelvis', -0.12, 0.0, 0.0)
    p.r('spine', 0.1 + 0.01 * b, 0.0, 0.0)
    p.r('chest', 0.06 + 0.01 * b, 0.05 * wob(u, 1, 0.25), 0.0)
    p.r('neck', 0.04, 0.2 * wob(u, 1, 0.55) * 1.0, 0.0)
    p.r('head', 0.0, 0.3 * wob(u, 1, 0.55) * 0.8, 0.0)
    hip = HIP_H - drop
    for side in ('L', 'R'):
        put_leg(p, side, 0.4 + 0.0, hip - ANKLE_H + 0.0, 0.0, -0.12, 0.0, 0.07)
    p.sym('clavicle', 0.0, 0.0, 0.0)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.13, 0.64, 0.32), pole=(s * 0.7, -0.6, -0.3), hand=(-0.1, 0.0, 0.0))
    return p


@clip('phone', 5.0)
def phone(u):
    """Standing with a phone at the right ear, weight shifting from foot to foot."""
    p = idle(u)
    p.r('head', -0.03, -0.06 + 0.12 * wob(u, 1, 0.3), -0.12)
    p.r('neck', -0.02, 0.0, -0.06)
    hp = head_pos(p)
    reach(p, 'R', (hp.x - 0.075, hp.y - 0.055, hp.z + 0.01), pole=(-0.6, -0.9, -0.7), hand=(-0.55 + 0.05 * wob(u, 1, 0.1), 0.0, 0.5))
    return p


@clip('film', 4.0)
def film(u):
    """Holding a phone up in both hands, filming."""
    p = idle(u)
    p.r('spine', 0.0 - 0.02, 0.0, 0.0)
    p.r('chest', -0.03, 0.0, 0.0)
    p.r('head', -0.02, 0.05 * wob(u, 1), 0.0)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.085, 1.42 + 0.01 * wob(u, 2), 0.36), pole=(s * 0.8, -0.7, -0.2), hand=(-0.7, 0.0, 0.0))
    return p


@clip('cower', 1.2)
def cower(u):
    """Down on their heels, hunched, arms over the head, trembling."""
    p = Pose()
    sh = 0.012 * wob(u, 6)
    drop = 0.4
    p.move('pelvis', sh, -drop, -0.1)
    p.r('pelvis', -0.2, 0.0, 0.0)
    p.r('spine', 0.55, 0.0, 0.0)
    p.r('chest', 0.45, 0.0, 0.0)
    p.r('neck', 0.5, 0.0, 0.0)
    p.r('head', 0.35, 0.0, 0.0)
    hip = HIP_H - drop
    for side in ('L', 'R'):
        put_leg(p, side, 0.18, hip - ANKLE_H, 0.0, -0.2, 0.0, 0.1)
    hp = head_pos(p)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.09, hp.y + 0.1, hp.z + 0.04), pole=(s * 0.9, 0.2, -0.3), hand=(-0.5, 0.0, 0.0))
    return p


@clip('chat', 5.0)
def chat(u):
    """Talking with the hands."""
    p = idle(u)
    p.r('chest', 0.03, 0.2 * wob(u, 1, 0.1) + 0.05 * wob(u, 3), 0.0)
    p.r('head', -0.04, 0.1 * wob(u, 2, 0.3), 0.04 * wob(u, 3))
    reach(p, 'R', (-0.19 + 0.09 * wob(u, 3), 1.2 + 0.1 * wob(u, 2, 0.2), 0.34 + 0.08 * wob(u, 3, 0.25)), pole=(-0.8, -0.9, -0.2), hand=(-0.3, 0.0, 0.0))
    reach(p, 'L', (0.17 + 0.06 * wob(u, 2, 0.4), 1.12 + 0.08 * wob(u, 3, 0.1), 0.25 + 0.06 * wob(u, 2)), pole=(0.8, -0.9, -0.2), hand=(-0.2, 0.0, 0.0))
    return p


@clip('atm', 4.0)
def atm(u):
    """Leaning in to a cash machine, one hand at the keys."""
    p = idle(u)
    p.add('spine', 0.14)
    p.add('chest', 0.06)
    p.r('head', -0.1, 0.0, 0.0)
    reach(p, 'R', (-0.1, 1.2 + 0.02 * wob(u, 3), 0.36 + 0.02 * wob(u, 2)), pole=(-0.7, -0.9, -0.3), hand=(-0.2, 0.0, 0.0))
    return p


@clip('browse', 6.0)
def browse(u):
    """Leaning toward a shop window, hands behind the back."""
    p = idle(u)
    p.add('spine', 0.12)
    p.add('chest', 0.06)
    p.r('head', -0.08, 0.35 * wob(u, 1, 0.4), 0.0)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.07, 0.96, -0.2), pole=(s * 0.7, -0.4, -0.9), hand=(0.2, 0.0, 0.0))
    return p


# ---------------------------------------------------------------- fighting and guns
def guard_stance(p, yaw=0.45, lean=0.1, fwd=0.2, back=0.2, bend=0.04):
    """A boxer's stance: left foot forward, knees soft, body turned to the right."""
    hip = HIP_H - 0.07
    p.move('pelvis', 0.0, -0.07, 0.0)
    p.r('pelvis', 0.0, -yaw * 0.4, 0.0)
    p.r('spine', lean * 0.5, -yaw * 0.3, 0.0)
    p.r('chest', lean * 0.4, -yaw * 0.3, 0.0)
    p.r('neck', -0.08, yaw * 0.8, 0.0)
    p.r('head', 0.0, 0.0, 0.0)
    put_leg(p, 'L', fwd, hip - ANKLE_H - bend, 0.0, 0.0, yaw * 0.4)
    put_leg(p, 'R', -back, hip - ANKLE_H - 0.0, 0.0, 0.0, yaw * 0.4, 0.0, 0.0)
    p.side('foot', 'R', 0.0, 0.0, 0.0)
    return p


@clip('fight', 1.2)
def fight(u):
    """Squared up: guard high, bouncing a little."""
    p = guard_stance(Pose(), yaw=0.5)
    bounce = 0.012 * wob(u, 2)
    p.move('pelvis', 0.0, bounce, 0.0)
    reach(p, 'L', (0.08, 1.42 + bounce, 0.30), pole=(0.5, -1.0, -0.2), hand=(-0.4, 0.0, 0.0))
    reach(p, 'R', (-0.1, 1.38 + bounce, 0.18), pole=(-0.6, -1.0, -0.2), hand=(-0.4, 0.0, 0.0))
    return p


@clip('punch', 0.7, loop=False)
def punch(u):
    """A right cross: u = 0 is the guard, it winds back, then drives through to full reach at u = 1."""
    wind = sstep(0.0, 0.35, u)
    strike = sstep(0.35, 1.0, u)
    p = guard_stance(Pose(), yaw=0.5 - 0.5 * wind + 0.95 * strike, lean=0.1 + 0.12 * strike, fwd=0.2 + 0.15 * strike, back=0.2 - 0.05 * strike)
    reach(p, 'L', (0.1 + 0.02 * strike, 1.42, 0.28 - 0.1 * strike), pole=(0.5, -1.0, -0.2), hand=(-0.4, 0.0, 0.0))
    z = mix(0.18, -0.02, wind)
    z = mix(z, 0.62, strike)
    x = mix(-0.1, -0.16, wind)
    x = mix(x, 0.0, strike)
    reach(p, 'R', (x, 1.40 + 0.04 * strike, z), pole=(-0.8, -0.9, -0.1), hand=(-0.3, 0.0, 0.0))
    return p


def hold_gun_pose(p, long_gun=False, aim_stance=True):
    """Both hands on a gun held out in front. The right hand grips; the barrel runs along the forearm."""
    hip = HIP_H - 0.02
    yaw = 0.3 if long_gun else 0.18
    p.move('pelvis', 0.0, -0.02, 0.0)
    p.r('pelvis', 0.0, -yaw * 0.5, 0.0)
    p.r('spine', 0.05, -yaw * 0.3, 0.0)
    p.r('chest', 0.03, -yaw * 0.2, 0.0)
    p.r('neck', -0.05, yaw * 0.5, 0.0)
    p.r('head', -0.04, 0.0, 0.0)
    put_leg(p, 'L', 0.11, hip - ANKLE_H - 0.012, 0.0, 0.0, yaw * 0.5)
    put_leg(p, 'R', -0.12, hip - ANKLE_H - 0.0, 0.0, 0.0, yaw * 0.5)
    if long_gun:
        reach(p, 'R', (-0.115, 1.36, 0.28), pole=(-1.0, -0.6, -0.4))
        reach(p, 'L', (0.04, 1.44, 0.66), pole=(0.7, -1.0, -0.2))
        point_hand(p, 'R', (0.0, 0.0, 1.0))
        point_hand(p, 'L', (-0.05, 0.0, 1.0))
    else:
        reach(p, 'R', (-0.055, 1.455, 0.53), pole=(-0.8, -1.0, -0.2))
        reach(p, 'L', (0.035, 1.445, 0.52), pole=(0.8, -1.0, -0.2))
        point_hand(p, 'R', (0.0, 0.0, 1.0))
        point_hand(p, 'L', (-0.1, 0.0, 1.0))
    return p


@clip('aim_pistol', 1.0)
def aim_pistol(u):
    """Pistol raised in both hands. The game pitches the torso with the aim."""
    p = hold_gun_pose(Pose())
    p.add('chest', 0.004 * wob(u, 1))
    return p


@clip('aim_rifle', 1.0)
def aim_rifle(u):
    """A rifle or shotgun to the shoulder."""
    p = hold_gun_pose(Pose(), long_gun=True)
    p.add('chest', 0.004 * wob(u, 1))
    return p


@clip('aim_crouch', 1.0)
def aim_crouch(u):
    """Down on one knee behind low cover, gun up."""
    p = Pose()
    drop = 0.38 + 0.004 * wob(u, 1)
    hip = HIP_H - drop
    p.move('pelvis', 0.0, -drop, 0.05)
    p.r('pelvis', 0.1, -0.2, 0.0)
    p.r('spine', 0.1, -0.1, 0.0)
    p.r('chest', 0.05, -0.1, 0.0)
    p.r('neck', -0.1, 0.25, 0.0)
    put_leg(p, 'L', 0.34, hip - ANKLE_H + 0.0, 0.0, 0.1, 0.1, 0.05)
    put_leg(p, 'R', -0.06, hip - ANKLE_H - 0.34, 0.0, 0.1, 0.1, 0.0)
    p.side('foot', 'R', 0.9, 0.0, 0.0)
    reach(p, 'R', (-0.055, 1.12, 0.52), pole=(-0.8, -1.0, -0.2))
    reach(p, 'L', (0.035, 1.11, 0.52), pole=(0.8, -1.0, -0.2))
    point_hand(p, 'R', (0.0, 0.0, 1.0))
    point_hand(p, 'L', (-0.1, 0.0, 1.0))
    return p


@clip('cover', 2.0)
def cover(u):
    """Back to a wall, gun held up by the chest."""
    p = idle(u)
    p.r('pelvis', 0.0, 0.0, 0.0)
    p.r('spine', -0.03, 0.0, 0.0)
    p.r('chest', -0.03, 0.0, 0.0)
    p.r('head', -0.02, 0.35, 0.0)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.07, 1.32, 0.22), pole=(s * 0.8, -1.0, -0.3), hand=(-1.1, 0.0, 0.0))
    return p


@clip('cover_low', 2.0)
def cover_low(u):
    """Crouched behind low cover, gun held at the chest."""
    p = Pose()
    drop = 0.42
    hip = HIP_H - drop
    p.move('pelvis', 0.0, -drop, -0.02)
    p.r('pelvis', -0.1, 0.0, 0.0)
    p.r('spine', 0.25, 0.0, 0.0)
    p.r('chest', 0.15, 0.0, 0.0)
    p.r('neck', -0.2, 0.3 * wob(u, 1), 0.0)
    for side in ('L', 'R'):
        put_leg(p, side, 0.23, hip - ANKLE_H, 0.0, -0.1, 0.0, 0.08)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        reach(p, side, (s * 0.07, 1.0, 0.36), pole=(s * 0.8, -1.0, -0.3), hand=(-0.7, 0.0, 0.0))
    return p


@clip('reload', 1.2)
def reload(u):
    """Gun drawn in to the chest, the other hand working the magazine."""
    p = hold_gun_pose(Pose())
    k = sstep(0.0, 0.2, u) * (1 - sstep(0.8, 1.0, u))
    reach(p, 'R', (-0.07, mix(1.455, 1.3, k), mix(0.53, 0.3, k)), pole=(-0.8, -1.0, -0.2))
    reach(p, 'L', (0.0 + 0.02 * wob(u, 3), mix(1.445, 1.17 + 0.05 * wob(u, 3), k), mix(0.52, 0.28, k)), pole=(0.8, -1.0, -0.2))
    point_hand(p, 'R', (0.0, mix(0.0, 0.5, k), 1.0))
    point_hand(p, 'L', (-0.1, mix(0.0, -0.4, k), 1.0))
    return p


# ---------------------------------------------------------------- in and around cars
WHEEL_Y = 0.36        # wheel centre above the hip joint, and ahead of it (figure frame)
WHEEL_Z = 0.55


def drive_pose(u, steer=0.0):
    p = Pose()
    p.move('pelvis', 0.0, 0.0, -0.02)
    p.r('pelvis', -0.28, 0.0, 0.0)
    p.r('spine', 0.18 + 0.01 * wob(u, 1), 0.0, 0.0)
    p.r('chest', 0.08, 0.0, 0.0)
    p.r('neck', 0.05, 0.0, 0.0)
    p.r('head', -0.0, 0.05 * wob(u, 1, 0.3), 0.0)
    # thighs run forward and a little down, shins drop to the pedals
    put_leg(p, 'L', 0.64, 0.38, 0.35, -0.28, 0.0, 0.0)
    put_leg(p, 'R', 0.62, 0.40, 0.4, -0.28, 0.0, 0.0)
    for side in ('L', 'R'):
        s = 1 if side == 'L' else -1
        a = steer
        reach(p, side, (s * 0.17 * math.cos(a), 1.0 + WHEEL_Y + s * 0.17 * math.sin(a), WHEEL_Z - 0.01), pole=(s * 0.8, -1.0, -0.3), hand=(-0.3, 0.0, 0.0), mirror=False)
    return p


@clip('drive', 3.0)
def drive(u):
    """At the wheel, hands at ten and two, a little movement."""
    return drive_pose(u, 0.04 * wob(u, 1))


@clip('enter_car', 0.7, loop=False)
def enter_car(u):
    """Folding in at the door: the head ducks under the frame and the hips drop into the seat."""
    k = sstep(0.0, 1.0, u)
    a = Pose()
    a.move('pelvis', 0.0, -0.05, 0.12)
    a.r('pelvis', 0.15, 0.3, 0.0)
    a.r('spine', 0.45, 0.0, 0.0)
    a.r('chest', 0.3, 0.0, 0.0)
    a.r('neck', 0.3, 0.2, 0.0)
    put_leg(a, 'L', 0.2, HIP_H - 0.05 - ANKLE_H - 0.12, 0.0, 0.1)
    put_leg(a, 'R', -0.12, HIP_H - 0.05 - ANKLE_H, 0.0, 0.1)
    a.side('upperarm', 'L', -0.7, 0.0, 0.2)
    a.side('forearm', 'L', -1.1, 0.0, 0.0)
    a.side('upperarm', 'R', 0.2, 0.0, 0.1)
    a.side('forearm', 'R', -0.4, 0.0, 0.0)
    return blend_poses(a, drive_pose(0.0), k)


@clip('exit_car', 0.7, loop=False)
def exit_car(u):
    """Out of the seat: forward and up, a hand on the frame."""
    k = sstep(0.0, 1.0, u)
    return blend_poses(drive_pose(0.0), idle(0.0), k)


@clip('dragged', 0.6)
def dragged(u):
    """Hauled out of a car by the collar: heels dragging, arms thrown up."""
    p = Pose()
    p.move('pelvis', 0.0, -0.1, -0.1)
    p.r('pelvis', -0.15, 0.1 * wob(u, 1), 0.08 * wob(u, 2))
    p.r('spine', -0.2, 0.0, 0.0)
    p.r('chest', -0.15, 0.0, 0.0)
    p.r('neck', -0.2, 0.0, 0.0)
    p.r('head', -0.25, 0.2 * wob(u, 1), 0.0)
    hip = HIP_H - 0.1
    put_leg(p, 'L', 0.38 + 0.12 * wob(u, 1), hip - ANKLE_H - 0.1, -0.4, -0.15)
    put_leg(p, 'R', 0.2 - 0.12 * wob(u, 1), hip - ANKLE_H - 0.05, -0.4, -0.15)
    p.side('upperarm', 'L', -2.5 + 0.3 * wob(u, 2), 0.0, 0.7)
    p.side('forearm', 'L', -0.4, 0.0, 0.0)
    p.side('upperarm', 'R', -2.7 - 0.3 * wob(u, 2), 0.0, 0.8)
    p.side('forearm', 'R', -0.3, 0.0, 0.0)
    return p


@clip('stumble', 0.7)
def stumble(u):
    """Catching their balance: arms thrown out, one foot stepping out."""
    p = Pose()
    w = wob(u, 2)
    p.move('pelvis', 0.0, -0.04, -0.03)
    p.r('pelvis', -0.1, 0.1 * w, 0.1 * wob(u, 1))
    p.r('spine', -0.25, 0.3 * w, 0.0)
    p.r('chest', -0.12, -0.2 * w, 0.0)
    p.r('head', 0.1, 0.0, 0.0)
    hip = HIP_H - 0.04
    put_leg(p, 'L', 0.32, hip - ANKLE_H - 0.05, 0.1, -0.1, 0.0, 0.1)
    put_leg(p, 'R', -0.18, hip - ANKLE_H + 0.0, -0.1, -0.1, 0.0, -0.1)
    p.side('upperarm', 'L', -1.0 + 0.2 * w, 0.0, 1.0)
    p.side('forearm', 'L', -0.5, 0.0, 0.0)
    p.side('upperarm', 'R', -0.7 - 0.2 * w, 0.0, 0.9)
    p.side('forearm', 'R', -0.6, 0.0, 0.0)
    return p


@clip('flinch', 0.4, loop=False)
def flinch(u):
    """Hit: the torso snaps round and the arms come up."""
    k = math.sin(math.pi * min(1.0, u * 1.0)) ** 0.8
    p = Pose()
    p.r('spine', 0.3 * k, 0.3 * k, 0.0)
    p.r('chest', 0.2 * k, 0.1 * k, 0.0)
    p.r('neck', 0.1 * k)
    p.side('upperarm', 'L', -0.9 * k, 0.0, 0.3 * k)
    p.side('forearm', 'L', -0.8 * k, 0.0, 0.0)
    p.side('upperarm', 'R', -0.5 * k, 0.0, 0.2 * k)
    p.side('forearm', 'R', -0.6 * k, 0.0, 0.0)
    return p


@clip('fall', 0.8)
def fall(u):
    """Off the ground: arms up, legs trailing."""
    p = Pose()
    w = wob(u, 1)
    p.move('pelvis', 0.0, -0.05, 0.0)
    p.r('spine', 0.05, 0.0, 0.0)
    put_leg(p, 'L', 0.2 + 0.03 * w, HIP_H - 0.05 - ANKLE_H - 0.2, 0.0)
    put_leg(p, 'R', -0.15 - 0.03 * w, HIP_H - 0.05 - ANKLE_H - 0.12, 0.0)
    p.side('upperarm', 'L', -2.1 + 0.1 * w, 0.0, 0.5)
    p.side('forearm', 'L', -0.4, 0.0, 0.0)
    p.side('upperarm', 'R', -1.9 - 0.1 * w, 0.0, 0.5)
    p.side('forearm', 'R', -0.4, 0.0, 0.0)
    return p


def lying(p, face_down=False):
    sgn = -1.0 if not face_down else 1.0
    p.r('pelvis', sgn * math.pi / 2, 0.0, 0.0)
    p.move('pelvis', 0.0, -0.84, 0.0)
    return p


def _getup(back):
    def fn(u):
        down = lying(Pose(), not back)
        down.r('head', 0.0)
        p = Pose()
        # keys: lying, rolled to sit/prone support, crouch, stand
        crouch = Pose()
        crouch.move('pelvis', 0.0, -0.4, -0.05)
        crouch.r('spine', 0.5)
        crouch.r('chest', 0.3)
        for side in ('L', 'R'):
            put_leg(crouch, side, 0.22, HIP_H - 0.4 - ANKLE_H, 0.0, 0.0, 0.0, 0.1)
            crouch.side('upperarm', side, -0.8, 0.0, 0.2)
            crouch.side('forearm', side, -0.7, 0.0, 0.0)
        mid = Pose()
        mid.move('pelvis', 0.0, -0.55, -0.1)
        mid.r('pelvis', (-0.7 if back else 0.5), 0.0, 0.0)
        mid.r('spine', (0.6 if back else -0.2))
        for side in ('L', 'R'):
            put_leg(mid, side, 0.25, HIP_H - 0.55 - ANKLE_H, 0.0, 0.0, 0.0, 0.2)
            mid.side('upperarm', side, 0.5, 0.0, 0.4)
        stand = idle(0.0)
        if u < 0.4:
            return blend_poses(down, mid, sstep(0.0, 0.4, u))
        if u < 0.7:
            return blend_poses(mid, crouch, sstep(0.4, 0.7, u))
        return blend_poses(crouch, stand, sstep(0.7, 1.0, u))
    return fn


clip('getup_back', 1.6, loop=False)(_getup(True))
clip('getup_front', 1.6, loop=False)(_getup(False))
