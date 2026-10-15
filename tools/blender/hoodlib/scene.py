"""A clean scene, empties (groups and anchor points) and parenting, in game coordinates."""
import bpy

from .frame import to_bl


def reset():
    """Empties the factory scene (cube, camera, light) and every orphan datablock."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.images):
        for d in list(coll):
            coll.remove(d)


def empty(name, pos=(0, 0, 0), parent=None, props=None):
    """An empty at a game point: a group node, or an anchor the game reads by name. `props` go
    into the glTF node's extras."""
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = 0.1
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
    o.location = to_bl(*pos)
    for k, v in (props or {}).items():
        o[k] = v
    return o


def world_pos(o):
    """An object's origin in game coordinates (through its parents)."""
    from .frame import from_bl
    return from_bl(o.matrix_world.translation)
