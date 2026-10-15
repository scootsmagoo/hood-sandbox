"""Triangle counts and decimation to a budget."""
import bpy

from .mesh import bake_modifiers


def tri_count(obj):
    me = obj.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def tree_tris(root, wheel_copies=None):
    """Triangles of every mesh under `root`. `wheel_copies` maps an object name to how many times
    the game draws it (a car's one wheel is drawn four times)."""
    total = 0
    stack = [root]
    while stack:
        o = stack.pop()
        if o.type == 'MESH':
            total += tri_count(o) * ((wheel_copies or {}).get(o.name, 1))
        stack.extend(o.children)
    return total


def decimate(obj, target):
    """Collapses `obj` toward `target` triangles (a few passes: the ratio is not exact). Material
    boundaries and open edges are kept where the collapse can."""
    for _ in range(4):
        n = tri_count(obj)
        if n <= target * 1.02 or n == 0:
            return n
        mod = obj.modifiers.new('decimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = max(0.05, target / n)
        mod.use_collapse_triangulate = True
        bake_modifiers(obj)
    return tri_count(obj)
