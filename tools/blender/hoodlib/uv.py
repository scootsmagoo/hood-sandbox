"""UVs by box projection: each face takes the plane its normal is closest to. One UV unit is 8 m,
centred on 0.5, so a car's UVs fit in [0, 1] and quantise to 12 bits (2 mm) in the .glb.

Deterministic and needs no operator context. Good enough for tiling grime, decals and noise; a
hero texture would want a real unwrap (bpy.ops.uv.smart_project) instead.
"""
import bmesh

from .frame import from_bl


def box_project(mesh, scale=1.0 / 8.0, offset=0.5):
    bm = mesh.bm
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = from_bl(f.normal)
        ax = max(range(3), key=lambda k: abs(n[k]))
        for loop in f.loops:
            x, y, z = from_bl(loop.vert.co)
            if ax == 0:
                u, v = (z if n[0] > 0 else -z), y
            elif ax == 1:
                u, v = x, (z if n[1] > 0 else -z)
            else:
                u, v = (-x if n[2] > 0 else x), y
            loop[uv].uv = (u * scale + offset, v * scale + offset)
