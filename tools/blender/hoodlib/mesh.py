"""A bmesh builder in game coordinates (+X left, +Y up, +Z forward).

The shapes cars (and later props) are made of:
  loft        rings of points along a path (body sections from profile curves), with optional caps
  sweep       a 2D profile along a 3D path (bumpers, trim strips, tubes, lamp strips)
  lathe       a profile turned about the X axis (tyres, rims, lamp housings)
  box         a bevelled box, scaled, rotated and placed
  inset       frames round a set of faces (window surrounds, recessed grilles)
  split_off   moves a set of faces into a new mesh (a door or a bonnet cut from the body)
Every face gets a material slot by name (materials.py).
"""
import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from . import materials
from .frame import from_bl, to_bl

# Game frame to Blender frame: a +90 degree turn about X.
G2B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
B2G = G2B.inverted()


def uniq(items):
    """Distinct items in first-seen order. (A set of bmesh elements iterates in memory order, which
    changes from run to run and would make the export differ: never hand one to an operator.)"""
    seen = set()
    out = []
    for i in items:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def game_matrix(pos=(0, 0, 0), size=(1, 1, 1), rot=(0, 0, 0)):
    """A Blender-space matrix for an object placed in the game frame: scale, then rotate (game XYZ
    Euler, radians), then translate."""
    m = Matrix.Translation(Vector(pos)) @ Euler(rot, 'XYZ').to_matrix().to_4x4() @ Matrix.Diagonal((*size, 1))
    return G2B @ m @ B2G


class Mesh:
    def __init__(self):
        self.bm = bmesh.new()

    # ---- basics
    def v(self, x, y, z):
        return self.bm.verts.new(to_bl(x, y, z))

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = materials.slot(mat)
        return f

    def faces_where(self, pred):
        """Faces whose (centre, normal), in game coordinates, pass `pred(c, n, face)`."""
        self.bm.normal_update()
        out = []
        for f in self.bm.faces:
            c = from_bl(f.calc_center_median())
            n = from_bl(f.normal)
            if pred(c, n, f):
                out.append(f)
        return out

    def set_mat(self, faces, mat):
        i = materials.slot(mat)
        for f in faces:
            f.material_index = i

    def mat_of(self, f):
        return materials.NAMES[f.material_index]

    def tris(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)

    def merge(self, other):
        """Appends another Mesh's geometry (the other is freed)."""
        me = bpy.data.meshes.new('_tmp_merge')
        other.bm.to_mesh(me)
        other.bm.free()
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        return self

    def transform(self, pos=(0, 0, 0), rot=(0, 0, 0), size=(1, 1, 1), verts=None):
        bmesh.ops.transform(self.bm, matrix=game_matrix(pos, size, rot), verts=list(verts if verts is not None else self.bm.verts))

    def mirror_x(self):
        """Mirrors every vertex to -X in place (flipping the faces so they still face out)."""
        for v in self.bm.verts:
            v.co.x = -v.co.x
        bmesh.ops.reverse_faces(self.bm, faces=list(self.bm.faces))

    def clean(self, dist=0.0005):
        bmesh.ops.remove_doubles(self.bm, verts=list(self.bm.verts), dist=dist)
        bmesh.ops.dissolve_degenerate(self.bm, edges=list(self.bm.edges), dist=dist * 0.5)
        # faces left with fewer than three distinct corners
        bad = [f for f in self.bm.faces if f.calc_area() < 1e-9]
        if bad:
            bmesh.ops.delete(self.bm, geom=bad, context='FACES')

    def orient_from(self, faces, centre_of):
        """Turns each face to face away from `centre_of(face_centre_game) -> point`."""
        self.bm.normal_update()
        flip = []
        for f in faces:
            if not f.is_valid:
                continue
            c = Vector(from_bl(f.calc_center_median()))
            o = Vector(centre_of(tuple(c)))
            n = Vector(from_bl(f.normal))
            if n.dot(c - o) < 0:
                flip.append(f)
        if flip:
            bmesh.ops.reverse_faces(self.bm, faces=flip)

    # ---- shapes
    def loft(self, rings, mat, cap_start=None, cap_end=None, closed=True, centre=None):
        """Quads between consecutive rings (lists of game points, all the same length). `mat` is a
        name or `mat(i, j)` for the quad from ring i, point j. Caps close the first and last rings
        (a material name, or None for open). `centre(c)` gives the point a face must face away from
        (default: the ring's centroid at that station)."""
        vs = [[self.v(*p) for p in ring] for ring in rings]
        n = len(rings[0])
        faces = []
        grid = []
        for i in range(len(rings) - 1):
            row = []
            for j in range(n if closed else n - 1):
                j2 = (j + 1) % n
                quad = [vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]]
                m = mat(i, j) if callable(mat) else mat
                try:
                    f = self.face(quad, m)
                except ValueError:
                    f = None
                row.append(f)
                if f:
                    faces.append(f)
            grid.append(row)
        caps = []
        for ring_verts, cap in ((vs[0], cap_start), (vs[-1], cap_end)):
            if cap:
                try:
                    caps.append(self.face(list(ring_verts), cap))
                except ValueError:
                    pass
        if centre is None:
            cents = [Vector(tuple(sum(p[k] for p in ring) / len(ring) for k in range(3))) for ring in rings]

            def centre(c):
                # the centroid of the nearest station
                best = min(cents, key=lambda q: abs(q.z - c[2]))
                return (best.x, best.y, best.z)

        self.orient_from(faces, centre)
        # caps face along the loft's axis
        if caps:
            first = Vector(tuple(sum(p[k] for p in rings[0]) / n for k in range(3)))
            last = Vector(tuple(sum(p[k] for p in rings[-1]) / n for k in range(3)))
            axis = (last - first).normalized()
            flip = []
            for f, sign in zip(caps, ([-1, 1] if cap_start and cap_end else ([-1] if cap_start else [1]))):
                if Vector(from_bl(f.normal)).dot(axis) * sign < 0:
                    flip.append(f)
            if flip:
                bmesh.ops.reverse_faces(self.bm, faces=flip)
        return faces, caps, grid

    def lathe(self, profile, segments, mat, centre=(0, 0, 0), start=0.0, end=2 * math.pi, side=1):
        """Turns a profile of (radius, x) points about the game X axis through `centre`. Walk the
        profile so the outside of the shape is on its left as it goes (inner bead, round the tread,
        to the outer bead, then the rim face inward): the faces then face out. `mat` may be
        `mat(k)` per profile segment. `side` -1 mirrors the profile's x (a right-hand wheel)."""
        cx, cy, cz = centre
        full = abs(end - start - 2 * math.pi) < 1e-6
        steps = segments if full else segments + 1
        rows = []
        for (r, x) in profile:
            row = []
            for i in range(steps):
                a = start + (end - start) * i / segments
                row.append(self.v(cx + x * side, cy + r * math.cos(a), cz + r * math.sin(a)))
            rows.append(row)
        faces = []
        for k in range(len(profile) - 1):
            m = mat(k) if callable(mat) else mat
            for i in range(segments):
                i2 = (i + 1) % steps if full else i + 1
                quad = [rows[k][i], rows[k][i2], rows[k + 1][i2], rows[k + 1][i]]
                if side < 0:
                    quad.reverse()
                try:
                    faces.append(self.face(quad, m))
                except ValueError:
                    pass
        return faces

    def sweep(self, path, profile, mat, up=(0, 1, 0), closed_profile=True, caps=True, flip_side=False, ups=None, outward=None):
        """Sweeps a 2D profile of (out, up) points along a path of game points. `out` is the
        horizontal side of the path (up x tangent, or its opposite with `flip_side`); with
        `outward` (a game point) it is the side away from that point at every step. `ups` gives a
        per-point up vector. Faces are turned outward from the path."""
        frames = []
        n = len(path)
        P = [Vector(p) for p in path]
        for i in range(n):
            t = (P[min(n - 1, i + 1)] - P[max(0, i - 1)]).normalized()
            u = Vector(ups[i] if ups else up)
            side = u.cross(t)
            if side.length < 1e-6:
                side = Vector((1, 0, 0))
            side.normalize()
            if flip_side:
                side = -side
            if outward is not None and side.dot(P[i] - Vector(outward)) < 0:
                side = -side
            u2 = t.cross(side)
            u2.normalize()
            if u2.dot(u) < 0:
                u2 = -u2
            frames.append((P[i], side, u2, t))
        rings = []
        for (p, side, u2, t) in frames:
            rings.append([self.v(*(p + side * a + u2 * b)) for (a, b) in profile])
        m = len(profile)
        faces = []
        for i in range(n - 1):
            for j in range(m if closed_profile else m - 1):
                j2 = (j + 1) % m
                quad = [rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]]
                mm = mat(i, j) if callable(mat) else mat
                try:
                    faces.append(self.face(quad, mm))
                except ValueError:
                    pass

        # out from the path, in the plane of the profile
        def centre(c):
            cv = Vector(c)
            best = min(range(n), key=lambda i: (P[i] - cv).length)
            return tuple(P[best])

        self.orient_from(faces, centre)
        capf = []
        if caps and closed_profile:
            for ring, (p, side, u2, t), sign in ((rings[0], frames[0], -1), (rings[-1], frames[-1], 1)):
                try:
                    f = self.face(list(ring), mat(0, 0) if callable(mat) else mat)
                except ValueError:
                    continue
                if Vector(from_bl(f.normal)).dot(t) * sign < 0:
                    bmesh.ops.reverse_faces(self.bm, faces=[f])
                capf.append(f)
        return faces + capf

    def box(self, pos, size, mat, bevel=0.0, segments=1, rot=(0, 0, 0)):
        """A box of full `size` (x, y, z) at `pos`, its edges bevelled by `bevel` metres."""
        ret = bmesh.ops.create_cube(self.bm, size=1.0)
        verts = ret['verts']
        bmesh.ops.transform(self.bm, matrix=game_matrix((0, 0, 0), size), verts=verts)
        faces = uniq(f for v in verts for f in v.link_faces)
        for f in faces:
            f.material_index = materials.slot(mat)
        if bevel > 0:
            edges = uniq(e for v in verts for e in v.link_edges)
            r = bmesh.ops.bevel(self.bm, geom=verts + edges, offset=min(bevel, min(size) * 0.49), offset_type='OFFSET',
                                segments=segments, profile=0.5, affect='EDGES', clamp_overlap=True)
            for f in r.get('faces', []):
                f.material_index = materials.slot(mat)
            verts = uniq(v for f in faces + r.get('faces', []) if f.is_valid for v in f.verts)
        bmesh.ops.transform(self.bm, matrix=game_matrix(pos, (1, 1, 1), rot), verts=verts)
        return uniq(f for v in verts for f in v.link_faces)

    def cylinder(self, centre, radius, length, segments, mat, axis='x', cap=True, cap_mat=None):
        """A closed cylinder along a game axis."""
        prof = [(0.0, -length / 2), (radius, -length / 2), (radius, length / 2), (0.0, length / 2)] if cap else [(radius, -length / 2), (radius, length / 2)]
        mats = (lambda k: (cap_mat or mat) if (cap and k != 1) else mat)
        tmp = Mesh()
        tmp.lathe(prof, segments, mats)
        tmp.clean()
        rot = {'x': (0, 0, 0), 'y': (0, 0, math.pi / 2), 'z': (0, -math.pi / 2, 0)}[axis]
        tmp.transform(centre, rot)
        self.merge(tmp)

    def inset(self, faces, thickness, depth=0.0, border_mat=None):
        """Insets a region of faces: a frame `thickness` wide round it, the region pushed in by
        `depth`. The frame's faces take `border_mat` (default: the region's own)."""
        faces = [f for f in faces if f.is_valid]
        if not faces:
            return []
        r = bmesh.ops.inset_region(self.bm, faces=faces, thickness=thickness, depth=-depth, use_even_offset=True, use_boundary=True)
        border = r['faces']
        if border_mat:
            self.set_mat(border, border_mat)
        return border

    def split_off(self, faces):
        """Removes `faces` from this mesh and returns them as a new Mesh."""
        keep = {f.index for f in faces if f.is_valid}
        self.bm.faces.ensure_lookup_table()
        for i, f in enumerate(self.bm.faces):
            f.index = i
        keep = {f.index for f in faces if f.is_valid}
        other = Mesh()
        other.bm.free()
        other.bm = self.bm.copy()
        other.bm.faces.ensure_lookup_table()
        drop = [f for f in other.bm.faces if f.index not in keep]
        bmesh.ops.delete(other.bm, geom=drop, context='FACES')
        bmesh.ops.delete(self.bm, geom=[f for f in faces if f.is_valid], context='FACES')
        return other

    def thicken(self, thickness, inner_mat, rim_mat=None):
        """Gives an open shell a back: every face copied `thickness` inward (against its normal),
        facing in, with a rim joining the two along the open edges."""
        bm = self.bm
        bm.normal_update()
        faces = list(bm.faces)
        boundary = [e for e in bm.edges if len(e.link_faces) == 1]
        bm.verts.ensure_lookup_table()
        normals = {v: v.normal.copy() for v in bm.verts}
        twin = {}
        for v in list(bm.verts):
            twin[v] = bm.verts.new(v.co - normals[v] * thickness)
        for f in faces:
            nf = bm.faces.new([twin[v] for v in reversed(f.verts)])
            nf.material_index = materials.slot(inner_mat)
        for e in boundary:
            a, b = e.verts
            f0 = e.link_faces[0]
            # keep the rim's winding consistent with the outer face
            loops = [l for l in f0.loops if l.edge == e]
            if loops and loops[0].vert == a:
                quad = [b, a, twin[a], twin[b]]
            else:
                quad = [a, b, twin[b], twin[a]]
            try:
                rf = bm.faces.new(quad)
                rf.material_index = materials.slot(rim_mat or inner_mat)
            except ValueError:
                pass

    # ---- finishing
    def smooth(self, angle_deg=35.0):
        """Smooth shading with sharp edges where faces meet at more than `angle_deg`, on open edges,
        and where the material changes."""
        thr = math.radians(angle_deg)
        for f in self.bm.faces:
            f.smooth = True
        for e in self.bm.edges:
            if len(e.link_faces) != 2:
                e.smooth = False
                continue
            fa, fb = e.link_faces
            if fa.material_index != fb.material_index:
                e.smooth = False
                continue
            try:
                e.smooth = e.calc_face_angle() < thr
            except ValueError:
                e.smooth = False


def _key(co):
    return (round(co.x, 4), round(co.y, 4), round(co.z, 4))


def canonical_order(bm):
    """Puts faces and vertices in an order that depends only on the geometry. Some bmesh operators
    (bevel, inset) emit elements in memory order, which differs between runs."""
    def by(seq, key):
        ranked = sorted(seq, key=key)
        rank = {e: i for i, e in enumerate(ranked)}
        seq.sort(key=lambda e: rank[e])
        seq.index_update()

    by(bm.faces, lambda f: (f.material_index, sorted(_key(v.co) for v in f.verts)))
    by(bm.verts, lambda v: (_key(v.co), min((f.index for f in v.link_faces), default=-1)))
    by(bm.edges, lambda e: sorted(v.index for v in e.verts))


def to_object(mesh, name, parent=None, origin=None, collection=None, triangulate=True):
    """Writes a Mesh to a new object. With `origin` (a game point) the object's origin is moved
    there (the geometry stays put): pivots for doors, bonnets and wheels."""
    me = bpy.data.meshes.new(name)
    # Triangulate here, single-threaded: the exporter's own triangulation of n-gons can come out in
    # a different order from run to run, and the build must be byte-for-byte reproducible.
    if triangulate:
        bmesh.ops.triangulate(mesh.bm, faces=list(mesh.bm.faces), quad_method='BEAUTY', ngon_method='BEAUTY')
    canonical_order(mesh.bm)
    if origin is not None:
        bmesh.ops.translate(mesh.bm, verts=list(mesh.bm.verts), vec=-to_bl(*origin))
    mesh.bm.normal_update()
    mesh.bm.to_mesh(me)
    mesh.bm.free()
    for m in materials.ensure():
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(obj)
    if parent is not None:
        obj.parent = parent
    if origin is not None:
        obj.location = to_bl(*origin)
    return obj


def bake_modifiers(obj):
    """Applies an object's modifiers without operators (works headless): the evaluated mesh
    replaces the object's own."""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    name = old.name
    obj.modifiers.clear()
    obj.data = me
    me.materials.clear()
    for m in materials.ensure():
        me.materials.append(m)
    bpy.data.meshes.remove(old)
    me.name = name
    return obj


def boolean(obj, cutter_mesh, op='DIFFERENCE'):
    """Cuts (or joins) a closed Mesh from an object. The cutter's faces keep their material slots."""
    cutter = to_object(cutter_mesh, f'{obj.name}_cutter', triangulate=False)
    mod = obj.modifiers.new('bool', 'BOOLEAN')
    mod.operation = op
    mod.solver = 'EXACT'
    mod.material_mode = 'INDEX'
    mod.object = cutter
    bake_modifiers(obj)
    me = cutter.data
    bpy.data.objects.remove(cutter)
    bpy.data.meshes.remove(me)
    return obj


def load(obj):
    """An object's mesh as a Mesh to keep editing (the object keeps its data until `store`)."""
    m = Mesh()
    m.bm.from_mesh(obj.data)
    return m


def store(mesh, obj):
    mesh.bm.normal_update()
    mesh.bm.to_mesh(obj.data)
    mesh.bm.free()
    obj.data.update()
