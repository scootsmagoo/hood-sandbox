"""The armature, in Blender's frame (hoodlib.frame), and a skinned object for a built Mesh."""
import bpy
from mathutils import Vector

from hoodlib import materials
from hoodlib.frame import to_bl
from hoodlib.mesh import canonical_order

from .skeleton import BONE_NAMES, BONES


def make_armature(name='rig'):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for n in BONE_NAMES:
        b = BONES[n]
        e = arm.edit_bones.new(n)
        e.head = to_bl(*b['head'])
        e.tail = to_bl(*b['tail'])
        e.roll = 0.0
        eb[n] = e
    for n in BONE_NAMES:
        p = BONES[n]['parent']
        if p:
            eb[n].parent = eb[p]
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.display_type = 'STICK'
    return ob


def skin_object(mesh, name, rig, collection=None, ao=None):
    """Turns a Mesh (with deform-layer weights) into an object skinned to `rig`."""
    import bmesh
    bm = mesh.bm
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='BEAUTY', ngon_method='BEAUTY')
    canonical_order(bm)
    bm.normal_update()
    shade = ao(bm) if ao else None
    cover = {}
    uvl = bm.loops.layers.uv.active
    if uvl is not None:
        for f in bm.faces:
            for loop in f.loops:
                cover[loop.vert.index] = tuple(loop[uvl].uv)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    if shade is not None:
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        for i in range(len(me.vertices)):
            k = shade[i]
            hc, bc = cover.get(i, (0.0, 0.0))
            # red: occlusion; green: hair cover; blue: beard cover; alpha: 1 for a beard thick enough to be hair-coloured
            ca.data[i].color = (k, max(0.0, min(1.0, hc)), min(1.0, abs(bc)), 1.0 if bc < 0 else 0.0)
    bm.free()
    for m in materials.ensure():
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    for n in BONE_NAMES:
        ob.vertex_groups.new(name=n)
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    ob.parent = rig
    return ob
