"""
Hood Sandbox asset library for headless Blender scripts.

Everything here works in the GAME's frame (the sim's): +X left, +Y up, +Z forward, metres, with the
car's body origin at (0, 0, 0). The helpers convert to Blender's Z-up frame when they create
vertices, and the glTF exporter's +Y-up conversion turns that back into the game's frame, so a point
written here as (x, y, z) arrives in the .glb, and in three.js, as (x, y, z).

Modules:
  frame      game <-> Blender coordinates
  curves     smooth 1D profiles (monotone cubic) for lofting
  materials  the material slots, by name, shared by every object (so booleans keep their indices)
  mesh       a bmesh builder: lofts, sweeps, lathes, bevelled boxes, insets, splits, booleans
  uv         box-projection UVs
  lod        triangle counts and decimation to a target
  scene      a clean scene, empties, parenting
  export     glTF binary export
  handling   reads src/shared/data/handling.json and ports doors.ts (seat and door anchors)
"""
