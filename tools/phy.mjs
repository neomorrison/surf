/* ============================== [PHY] ==============================
   The collision shape of a model, read out of the .phy packed beside it.

   A prop_static is drawn from its .mdl and collided against its .phy, and on
   surf_boreas that is not a detail: the ride surface of the whole map is
   nineteen prop_static ramps. Without this the map is a set of ramps you fall
   straight through.

   A .phy is barely a Valve format. Past a sixteen-byte wrapper it is an Ipion
   (later Havok) compact surface, written to be memory-mapped by a collision
   solver rather than read by anything, and what it holds is a *tree* of convex
   pieces. Only the leaves of that tree are the model. Every interior node also
   carries a hull enclosing its children, because that is what makes the
   broadphase cheap, and one more ledge sits in the file holding the whole
   model as a single concave triangle soup. So a reader that hunts through a
   .phy for ledges rather than walking its tree collects those too, and turns a
   surf ramp into the block that contains it. ramp_c1 is sixteen convex wedges
   and that seventeenth ledge; the wedges are the ones you ride.

   Each leaf is one convex piece, which is exactly what the caller wants: a
   convex brush is what physics.js already collides against.

   This runs offline in node, in the packer. Nothing here reaches the browser. */

const VPHY = 0x59485056;               // 'VPHY', read as a little-endian word
const NODE = 28;                       // one ledgetree node
const LEDGE = 16;                      // a compact ledge, before its triangles
const TRI = 16;                        // one compact triangle: a header word and three edges

/* IVP works in metres. The constant usually quoted for the way back is 39.37,
   but vphysics' own is 1/0.0254 — the inch, exactly — and the two differ by
   two parts per million, which sounds like nothing and is measurable. Every
   .phy carries the volume vphysics itself computed, in its trailing text; the
   volumes of the pieces this reader returns land within 3e-7 of it with the
   inch, and a systematic 6.1e-6 under it with 39.37 — three times that
   constant's own error, which is what a volume does with one. So the file
   says which constant made it, and it is this one.                         */
const SCALE = 1 / 0.0254;

/* IVP's axes are Source's turned a quarter turn about X: Source x is IVP x,
   Source y is IVP z, Source z is IVP -y.

   That is worth stating flatly because the conversion normally written down
   for this — y = -ivp.z, z = ivp.y — is the same rotation the other way, a
   half turn from this one, and both are proper rotations, so a shape read the
   wrong way is not visibly broken. It is upside down. Checked against the
   models' own render meshes, this reading puts tree_pine04's trunk at z 0 to
   585 where the mesh is 0 to 587, and the other reading buries it at -585 to
   1; of the forty-eight signed axis permutations it is the only one that lands
   more than half of the eight test models' bounding-box faces on the mesh's. */
const swizzle = (ivpX, ivpY, ivpZ) => [ivpX * SCALE, ivpZ * SCALE, -ivpY * SCALE];

/**
 * The convex pieces of a .phy, in Source units and Source coordinates.
 *
 * `bytes` is the file exactly as packed — a Uint8Array straight out of the
 * pakfile. Returns `{ solids: [{ hulls: [{ verts, tris }] }] }`, one entry per
 * solid the file declares, each hull a single convex piece with `verts` as
 * [x, y, z] triples and `tris` indexing into them. Triangles wind so their
 * normals face out of the piece.
 *
 * A model with no collision is not an error — ramp_s1 is SOLID_NONE and ships
 * no .phy at all — and neither is one this cannot make sense of. Losing a
 * prop's collision should cost the caller that prop, not the map, so anything
 * unreadable comes back as an empty list rather than throwing.
 */
export function readPhy(bytes) {
  const solids = [];
  if (!bytes || bytes.byteLength < 16) return { solids };

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  const i32 = o => dv.getInt32(o, true);
  const u32 = o => dv.getUint32(o, true);
  const i16 = o => dv.getInt16(o, true);
  const f32 = o => dv.getFloat32(o, true);

  /**
   * One convex piece, from the compact ledge at `g`.
   *
   * A triangle does not store its three corners. It stores three compactedge_t,
   * and a corner is the start_point_index in the low half of each — an edge
   * ring is what the solver wants to walk, and a triangle is what we want.
   *
   * The indices are into a point array the ledge names by its own offset, and
   * every ledge in a solid names the same one, so the points are renumbered
   * per piece and only the ones this piece uses are carried. That is what
   * makes each hull standalone, which is what a brush has to be.
   */
  const readLedge = g => {
    if (g < 0 || g + LEDGE > end) return null;
    const n = i16(g + 12);
    if (n <= 0 || g + LEDGE + n * TRI > end) return null;
    const points = g + i32(g);
    const seen = new Map();
    const verts = [], tris = [];
    for (let t = 0; t < n; t++) {
      const o = g + LEDGE + t * TRI;
      const tri = [];
      for (let e = 0; e < 3; e++) {
        const p = u32(o + 4 + e * 4) & 0xffff;
        let k = seen.get(p);
        if (k === undefined) {
          const v = points + p * 16;          // float[4]: xyz, then a pad word
          if (v < 0 || v + 12 > end) return null;
          k = verts.length;
          seen.set(p, k);
          verts.push(swizzle(f32(v), f32(v + 4), f32(v + 8)));
        }
        tri.push(k);
      }
      tris.push(tri);
    }
    return { verts, tris };
  };

  /**
   * Every leaf of one solid's ledge tree.
   *
   * A node is terminal when it has no right child, and its left child is
   * simply the next node along. Both of a node's offsets are measured from the
   * node itself, while the root's is measured from the start of the surface
   * header, so the two are never mixed. The visited set is against a malformed
   * offset pointing back up the tree, which would otherwise never terminate.
   *
   * A ledge is told from a node by the is_compact_flag in bits 2 and 3 of its
   * +8, and it is tempting to test the root with that, since a solid holding a
   * single convex piece could reasonably point straight at the ledge. It is
   * not safe: a node has the float centre of its bounding sphere at +8, and
   * ramp_c1's root is one whose bits happen to read as the flag. Every root in
   * every .phy on this map is a node, so it is taken as one.
   */
  const readTree = (surf, limit) => {
    const hulls = [];
    const visited = new Set();
    const stack = [surf + i32(surf + 32)];        // offset_ledgetree_root
    while (stack.length) {
      const n = stack.pop();
      if (n < surf || n + NODE > limit || visited.has(n)) continue;
      visited.add(n);
      const right = i32(n);
      if (right === 0) {
        const hull = readLedge(n + i32(n + 4));
        if (hull) hulls.push(hull);
        continue;
      }
      stack.push(n + right, n + NODE);            // left last, so pieces come out in order
    }
    return hulls;
  };

  /* phyheader_t is size, id, solidCount, checksum, and its own `size` is where
     the first solid begins. A solid then opens with a length and that length
     is the first field of its compactsurfaceheader_t, not a separate word in
     front of it — so 'VPHY' four bytes in is what confirms where a solid
     starts, and stepping past `size` plus its own four bytes is what finds the
     next. compactsurfaceheader_t is 32 bytes, and the legacy surface header
     the ledge tree hangs off follows it. */
  const count = i32(8);
  let p = Math.max(16, i32(0));
  for (let s = 0; s < count && p + 32 <= end; s++) {
    if (u32(p + 4) !== VPHY) break;
    const size = i32(p);
    const next = p + 4 + size;
    if (size <= 0 || next > end) break;
    /* modelType 0 is the IVP compact surface. Anything else is a collision
       model this does not read, and guessing at one would be worse for the
       player than the prop having no collision at all. */
    if (i16(p + 10) === 0) {
      const hulls = readTree(p + 32, next);
      if (hulls.length) solids.push({ hulls });
    }
    p = next;
  }
  return { solids };
}
