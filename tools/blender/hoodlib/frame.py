"""Game frame (+X left, +Y up, +Z forward) to Blender's (+Z up, -Y forward) and back.

Blender's glTF exporter maps Blender (x, y, z) to glTF (x, z, -y). For a game point (x, y, z) to
land in the .glb as (x, y, z), Blender must hold it as (x, -z, y).
"""
from mathutils import Vector


def to_bl(x, y, z):
    return Vector((x, -z, y))


def from_bl(v):
    return (v[0], v[2], -v[1])
