"""Builds the characters: one armature, every archetype at three levels of detail (skinned meshes
`<archetype>_lod<N>`, vertex colour = baked ambient occlusion) and the animation clips as actions.
Run through tools/blender/build_asset.py (module `characters.build`); `build_scene` is also used by
view.py for quick looks."""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from hoodlib import materials, scene
from hoodlib.mesh import Mesh

from . import rig as R
from .skeleton import SLOTS

SKINS = True
ANIMATIONS = True
VERTEX_COLOR = 'ACTIVE'


def build_figure(spec, lod):
    m = Mesh()
    m.bm.verts.layers.deform.verify()
    m.bm.loops.layers.uv.verify()
    from . import figure
    figure.assemble(m, spec, lod)
    from .shapes import smooth_character
    smooth_character(m, 42.0)
    return m


def hemisphere(n):
    """Fixed directions over the +Z hemisphere (a Fibonacci spiral), cosine-weighted by position."""
    out = []
    for i in range(n):
        z = (i + 0.5) / n
        r = math.sqrt(max(0.0, 1 - z * z))
        a = i * 2.399963
        out.append((r * math.cos(a), r * math.sin(a), z))
    return out


HEMI = hemisphere(20)


def bake_ao(bm, dist=0.30):
    """Per-vertex ambient occlusion by ray casts against the figure itself."""
    bm.normal_update()
    bvh = BVHTree.FromBMesh(bm)
    out = {}
    for v in bm.verts:
        n = v.normal.copy()
        if n.length < 1e-6:
            out[v.index] = 1.0
            continue
        n.normalize()
        t = n.cross(Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))).normalized()
        b = n.cross(t)
        o = v.co + n * 0.004
        occ = 0.0
        wsum = 0.0
        for (x, y, z) in HEMI:
            d = (t * x + b * y + n * z)
            hit = bvh.ray_cast(o, d, dist)
            w = z
            wsum += w
            if hit[0] is not None:
                occ += w * (1 - hit[3] / dist)
        out[v.index] = max(0.0, 1.0 - 1.15 * occ / wsum)
    return out


def skin_object(mesh, name, rig_ob):
    bm = mesh.bm
    return R.skin_object(mesh, name, rig_ob, ao=bake_ao)


def build_scene(archs, lods=(0, 1, 2), armature=True):
    from . import outfits
    materials.use(SLOTS)
    rig_ob = R.make_armature('rig')
    objs = []
    for a in archs:
        spec = outfits.ARCHETYPES[a]
        for lod in lods:
            m = build_figure(spec, lod)
            objs.append(R.skin_object(m, f'{a}_lod{lod}', rig_ob, ao=bake_ao))
    return rig_ob, objs


def build(asset):
    from . import anim, clips, outfits
    scene.reset()
    for a in list(bpy.data.armatures):
        bpy.data.armatures.remove(a)
    bpy.context.scene.render.fps = anim.FPS
    rig_ob, objs = build_scene(list(outfits.ARCHETYPES), lods=(0, 1, 2))
    tris = {}
    for o in objs:
        o.data.calc_loop_triangles()
        tris[o.name] = len(o.data.loop_triangles)
    # clips: one action each; leave the rig in the rest pose with no active action
    rig_ob.animation_data_create()
    names = []
    for name, c in anim.CLIPS.items():
        anim.bake_clip(rig_ob, c)
        names.append(name)
    rig_ob.animation_data.action = None
    for pb in rig_ob.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.context.scene.frame_end = 200
    from .skeleton import BONES, BONE_NAMES, SLOT_NAMES
    bones = {n: dict(parent=BONES[n]['parent'], head=[round(x, 4) for x in BONES[n]['head']]) for n in BONE_NAMES}
    rep = dict(asset=asset, tris=tris, bones=bones, regions=SLOT_NAMES, clips={n: dict(duration=anim.CLIPS[n].duration, loop=anim.CLIPS[n].loop) for n in names}, warnings=[])
    return rep
