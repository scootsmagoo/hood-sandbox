"""glTF binary export: +Y up (the exporter's conversion undoes frame.to_bl), transforms applied to
the geometry except each object's own origin (pivots), names and extras kept. Compression
(meshopt) happens afterwards in Node (tools/blender/build.mjs) with glTF-Transform, as the tile
pipeline does."""
import os

import bpy


def glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_vertex_color='NONE',
        export_attributes=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        use_selection=False,
        export_draco_mesh_compression_enable=False,
    )
