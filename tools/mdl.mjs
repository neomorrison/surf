/* ============================== [MDL] ==============================
   Source studio models: the triangles a prop is drawn as.

   tools/props.mjs says where every prop_static on a map stands and which
   model it wears. This turns one of those models into something a renderer
   can hold. Between them they are what makes surf_boreas a map rather than a
   hole in the sky: nineteen of its props are the ramps you ride, and the
   other 1568 are the trees, rocks and icicles you ride past.

   A model is three files, and none of them is any use alone:

     .mdl   the parts list -- materials, and which mesh wears which
     .vvd   the vertices, once, for every level of detail at the same time
     .vtx   the triangles, per level of detail and per renderer

   That split is the whole difficulty. The .vtx holds indices into a mesh's
   own little vertex table; that table holds indices into the model's slice of
   the .vvd; and the .vvd's own vertex order is not the order the .mdl thinks
   it is unless the fixup table has been applied. Get any one of those three
   hops wrong and the model still parses, still produces triangles, and is
   scrambled -- which is why the checksum the three files share is checked up
   front rather than trusted.

   Only LOD 0 is read. A static prop has no bones worth honouring either: they
   exist, but a prop_static is baked into world space by its own origin and
   angles, so the bone transform is the identity and applying it would be
   arithmetic that changes nothing.

   Positions come out in Source's own frame and Source's own units, like the
   props do, and for the same reason -- half a conversion here and half at the
   caller is how a map ends up mirrored. Triangles keep the file's own
   winding, which is Source's: front faces run clockwise, the opposite of the
   rule WebGL applies. That is the caller's to flip, once, along with the
   frame -- and worth knowing before concluding a prop failed to load, because
   a model drawn with its back faces culled is invisible, not wrong-looking.

   Texture coordinates come out untouched as well. A .vvd already stores them
   normalised, with V running down the image the same way a .vtf stores its
   rows, so there is nothing here to divide by or flip.                     */

const IDST = 0x54534449;                // 'IDST', those bytes read little-endian
const IDSV = 0x56534449;                // 'IDSV', the same way

const VERTEX = 48;                      // mstudiovertex_t: weights 16, pos 12, normal 12, uv 8
const BODYPART = 16, MODEL = 148, MESH = 116, TEXTURE = 64;

/* A studio version of 49 (CS:GO) widened two .vtx structs by a pair of
   topology fields. Nothing else about the layout moved, and the .vtx file
   version stayed 7, so the .mdl is the only thing that says which shape the
   .vtx is in. */
const STRIPGROUP = 25, STRIP = 27, TOPOLOGY = 8;

const STRIP_TRILIST = 1;

const latin1 = new TextDecoder('latin1');

/** A NUL-terminated string at a byte offset. */
function cstr(bytes, off) {
  let end = off;
  while (end < bytes.length && bytes[end]) end++;
  return latin1.decode(bytes.subarray(off, end));
}

/**
 * The materials the model asks for, in the form a .vmt lookup wants.
 *
 * A studio texture carries only a bare name -- 'ramp_wood01' -- and the
 * directory it lives in is held separately, because one model's meshes all
 * share it. Joining them is what produces the key src/vtfread.js resolveTexture
 * looks the .vmt up by: relative to materials/, lowercased, forward slashes.
 *
 * A model may list several directories, and the engine tries each until one
 * of them holds the file. Nothing here can do that -- this reads a model, not
 * a game install -- so the first is used, which is the only one every model on
 * surf_boreas has.
 */
function materials(bytes, dv) {
  const numTextures = dv.getInt32(204, true), textureIndex = dv.getInt32(208, true);
  const numCd = dv.getInt32(212, true), cdIndex = dv.getInt32(216, true);

  let dir = '';
  if (numCd > 0) {
    dir = cstr(bytes, dv.getInt32(cdIndex, true)).replace(/\\/g, '/').replace(/\/+$/, '');
  }
  const out = [];
  for (let i = 0; i < numTextures; i++) {
    const o = textureIndex + i * TEXTURE;
    const name = cstr(bytes, o + dv.getInt32(o, true)).replace(/\\/g, '/');
    out.push(((dir ? dir + '/' : '') + name).toLowerCase());
  }
  return out;
}

/**
 * Skin family 0, as a lookup from a mesh's material field to a texture.
 *
 * A mesh does not point at a texture directly. It points into a row of the
 * skin table, so that a prop with `skin 1` can wear a different set of
 * materials without a second copy of the mesh. Family 0 is what a prop with
 * no skin set draws, and on this map every family 0 is the identity -- but a
 * model that reskins is ordinary enough that reading the row is cheaper than
 * assuming it away.
 */
function skinRow(dv) {
  const refs = dv.getInt32(220, true), families = dv.getInt32(224, true);
  const index = dv.getInt32(228, true);
  if (refs <= 0 || families <= 0) return null;
  const row = new Array(refs);
  for (let i = 0; i < refs; i++) row[i] = dv.getInt16(index + i * 2, true);
  return row;
}

/**
 * The .mdl's own mesh list, flattened.
 *
 * bodypart -> model -> mesh is three levels deep because a bodypart is a
 * choice (a head, of which a character wears one) and a model is one of those
 * choices. A prop is a single bodypart holding a single model, so flattening
 * loses nothing here, and the .vtx has to be walked to the same depth in the
 * same order regardless.
 *
 * `vertexbase` is where this model's vertices start in the .vvd. It is named
 * vertexindex and it is a byte offset, not an index, which is a trap worth
 * stepping around out loud.
 */
function studioMeshes(dv) {
  const numParts = dv.getInt32(232, true), partIndex = dv.getInt32(236, true);
  const parts = [];
  for (let b = 0; b < numParts; b++) {
    const bo = partIndex + b * BODYPART;
    const numModels = dv.getInt32(bo + 4, true), modelIndex = dv.getInt32(bo + 12, true);
    const models = [];
    for (let i = 0; i < numModels; i++) {
      const mo = bo + modelIndex + i * MODEL;
      const numMeshes = dv.getInt32(mo + 72, true), meshIndex = dv.getInt32(mo + 76, true);
      const meshes = [];
      for (let k = 0; k < numMeshes; k++) {
        const so = mo + meshIndex + k * MESH;
        meshes.push({
          material: dv.getInt32(so, true),
          vertexoffset: dv.getInt32(so + 12, true),
        });
      }
      models.push({ vertexbase: dv.getInt32(mo + 84, true) / VERTEX, meshes });
    }
    parts.push(models);
  }
  return parts;
}

/**
 * The .vvd's LOD 0 vertices: position and texcoord, in file order.
 *
 * One .vvd holds every LOD's vertices in one array, sorted so that the
 * coarsest LOD's vertices come first and each finer one adds to them. That
 * ordering is not the one the .mdl's meshes index by, so the file also
 * carries a fixup table: a list of runs to copy out, in order, to rebuild the
 * array a given LOD expects. A run belongs to every LOD at least as fine as
 * the one it names, so LOD 0 takes all of them.
 *
 * Skipping this does not fail loudly. With no fixups applied the vertex count
 * still comes out right and every index still lands in range -- the triangles
 * are simply wired to the wrong corners, and the model arrives as a knot.
 */
function readVvd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== IDSV) throw new Error('not a .vvd file');

  const lod0 = dv.getInt32(16, true);
  const numFixups = dv.getInt32(48, true);
  const fixupStart = dv.getInt32(52, true);
  const dataStart = dv.getInt32(56, true);

  const pos = new Float32Array(lod0 * 3), uv = new Float32Array(lod0 * 2);
  let n = 0;
  const copy = (from, count) => {
    for (let i = 0; i < count && n < lod0; i++, n++) {
      const o = dataStart + (from + i) * VERTEX;
      pos[n * 3] = dv.getFloat32(o + 16, true);
      pos[n * 3 + 1] = dv.getFloat32(o + 20, true);
      pos[n * 3 + 2] = dv.getFloat32(o + 24, true);
      uv[n * 2] = dv.getFloat32(o + 40, true);
      uv[n * 2 + 1] = dv.getFloat32(o + 44, true);
    }
  };

  if (numFixups <= 0) copy(0, lod0);
  else {
    for (let i = 0; i < numFixups; i++) {
      const o = fixupStart + i * 12;
      if (dv.getInt32(o, true) < 0) continue;            // -1: belongs to no LOD at all
      copy(dv.getInt32(o + 4, true), dv.getInt32(o + 8, true));
    }
  }
  if (n !== lod0) throw new Error(`.vvd fixups rebuilt ${n} of ${lod0} LOD 0 vertices`);
  return { pos, uv };
}

/**
 * The .vtx's LOD 0 index buffers, one per .mdl mesh, in the same walk order.
 *
 * Each entry is a list of { table, indices } -- one per strip group, because
 * a mesh split across strip groups has a separate vertex table per group and
 * its indices only mean anything against its own.
 */
function readVtx(bytes, studioVersion) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = studioVersion >= 49 ? TOPOLOGY : 0;
  const groupSize = STRIPGROUP + wide, stripSize = STRIP + wide;

  const numParts = dv.getInt32(28, true), partOffset = dv.getInt32(32, true);
  const parts = [];
  for (let b = 0; b < numParts; b++) {
    const bo = partOffset + b * 8;
    const numModels = dv.getInt32(bo, true), modelOffset = dv.getInt32(bo + 4, true);
    const models = [];
    for (let i = 0; i < numModels; i++) {
      const mo = bo + modelOffset + i * 8;
      const numLods = dv.getInt32(mo, true), lodOffset = dv.getInt32(mo + 4, true);
      if (numLods < 1) { models.push([]); continue; }

      const lo = mo + lodOffset;                          // LOD 0 is the first
      const numMeshes = dv.getInt32(lo, true), meshOffset = dv.getInt32(lo + 4, true);
      const meshes = [];
      for (let k = 0; k < numMeshes; k++) {
        /* MeshHeader_t is nine bytes and genuinely unaligned -- the trailing
           flags byte is not padded out -- so the stride is 9, not 12. */
        const so = lo + meshOffset + k * 9;
        const numGroups = dv.getInt32(so, true), groupOffset = dv.getInt32(so + 4, true);
        const groups = [];
        for (let g = 0; g < numGroups; g++) {
          const go = so + groupOffset + g * groupSize;
          const numVerts = dv.getInt32(go, true), vertOffset = dv.getInt32(go + 4, true);
          const indexOffset = dv.getInt32(go + 12, true);
          const numStrips = dv.getInt32(go + 16, true), stripOffset = dv.getInt32(go + 20, true);

          /* A strip group vertex is nine bytes of bone plumbing wrapped
             around the one field that matters: which of the mesh's own
             vertices it stands for. */
          const table = new Uint16Array(numVerts);
          for (let v = 0; v < numVerts; v++) table[v] = dv.getUint16(go + vertOffset + v * 9 + 4, true);

          const indices = [];
          for (let s = 0; s < numStrips; s++) {
            const po = go + stripOffset + s * stripSize;
            const count = dv.getInt32(po, true), first = dv.getInt32(po + 4, true);
            const flags = dv.getUint8(po + 18);
            /* Studiomdl emits triangle lists and has for a very long time,
               but a strip says which it is and a strip that says otherwise
               would silently produce a mesh of thin slivers, so ask. */
            if (flags & STRIP_TRILIST) {
              for (let t = 0; t + 2 < count; t += 3) {
                indices.push(
                  dv.getUint16(go + indexOffset + (first + t) * 2, true),
                  dv.getUint16(go + indexOffset + (first + t + 1) * 2, true),
                  dv.getUint16(go + indexOffset + (first + t + 2) * 2, true),
                );
              }
            } else {
              // a strip: every index after the first two closes a triangle,
              // and the winding alternates so the surface stays consistent
              for (let t = 2; t < count; t++) {
                const a = dv.getUint16(go + indexOffset + (first + t - 2) * 2, true);
                const b2 = dv.getUint16(go + indexOffset + (first + t - 1) * 2, true);
                const c = dv.getUint16(go + indexOffset + (first + t) * 2, true);
                if (a === b2 || b2 === c || a === c) continue;      // a degenerate joint
                if (t & 1) indices.push(b2, a, c); else indices.push(a, b2, c);
              }
            }
          }
          groups.push({ table, indices });
        }
        meshes.push(groups);
      }
      models.push(meshes);
    }
    parts.push(models);
  }
  return parts;
}

/**
 * One model's LOD 0 mesh, from its three files.
 *
 * Comes back as one entry per studio mesh, each with its own compacted
 * vertices: a mesh is a material's worth of surface, which is the unit a
 * renderer draws in, and handing back the whole model's vertex array with
 * each mesh's indices scattered through it would make every draw call pull
 * the whole model through the cache.
 *
 * `bbox` is measured from the positions that came out, not copied from the
 * header. The header's hull is what the compiler recorded and is what to
 * check against; the box around the triangles is what will actually be on
 * screen, and the two disagreeing is how you find out the walk went wrong.
 * The header's own is returned as `hull` so that check stays possible.
 */
export function readModel({ mdl, vvd, vtx }) {
  const dv = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
  if (dv.getUint32(0, true) !== IDST) throw new Error('not an .mdl file');
  const version = dv.getInt32(4, true);

  /* All three files record the checksum of the model they were compiled from.
     A mismatched trio is the one failure that produces no error and no clue:
     the indices land in range and the model comes out as a knot. */
  const vvdDv = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength);
  const vtxDv = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
  const sum = dv.getInt32(8, true);
  if (vvdDv.getInt32(8, true) !== sum || vtxDv.getInt32(16, true) !== sum) {
    throw new Error('.mdl, .vvd and .vtx are from different builds of this model');
  }

  const names = materials(mdl, dv);
  const skin = skinRow(dv);
  const parts = studioMeshes(dv);
  const verts = readVvd(vvd);
  const strips = readVtx(vtx, version);

  const meshes = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let b = 0; b < parts.length; b++) {
    for (let i = 0; i < parts[b].length; i++) {
      const model = parts[b][i];
      const vtxMeshes = strips[b] && strips[b][i];
      if (!vtxMeshes) continue;

      for (let k = 0; k < model.meshes.length; k++) {
        const mesh = model.meshes[k];
        const groups = vtxMeshes[k];
        if (!groups) continue;

        /* Three hops from a strip group index to a .vvd vertex: the group's
           own table gives the mesh's vertex, the mesh's offset places that
           inside the model, and the model's base places that in the file. */
        const base = model.vertexbase + mesh.vertexoffset;

        const remap = new Map();                    // .vvd index -> index in this mesh
        const pos = [], uv = [], indices = [];

        for (const group of groups) {
          for (const local of group.indices) {
            const v = base + group.table[local];
            let out = remap.get(v);
            if (out === undefined) {
              out = pos.length / 3;
              remap.set(v, out);
              const x = verts.pos[v * 3], y = verts.pos[v * 3 + 1], z = verts.pos[v * 3 + 2];
              pos.push(x, y, z);
              uv.push(verts.uv[v * 2], verts.uv[v * 2 + 1]);
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            indices.push(out);
          }
        }
        if (!indices.length) continue;

        const ref = skin && mesh.material < skin.length ? skin[mesh.material] : mesh.material;
        meshes.push({
          material: names[ref] || '',
          positions: new Float32Array(pos),
          uvs: new Float32Array(uv),
          indices: new Uint32Array(indices),
        });
      }
    }
  }

  return {
    meshes,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    hull: {
      min: [dv.getFloat32(104, true), dv.getFloat32(108, true), dv.getFloat32(112, true)],
      max: [dv.getFloat32(116, true), dv.getFloat32(120, true), dv.getFloat32(124, true)],
    },
  };
}

/**
 * A model's three files out of a map's pakfile, given its .mdl path.
 *
 * The .vtx comes in one flavour per renderer the map was compiled for. They
 * hold the same triangles -- dx80 differs from dx90 in how many bones a strip
 * may use, which a static prop does not care about -- so this takes whichever
 * is there, preferring the one the engine itself would.
 *
 * Null rather than throwing, for the same reason tools/pakdecode.mjs returns
 * null: a map that references a model it did not pack should lose that prop,
 * not fail to load.
 *
 * Repeated slashes are collapsed, which is not tidiness. 84 of surf_boreas's
 * icicles name their model 'project_tendies//icicles/icicle_01.mdl' while the
 * pakfile stores it with one slash, so an exact lookup loses all 84. This is
 * the right place to forgive that: tools/props.mjs reports the map's own data
 * untouched, and a lookup is allowed to be more generous than a reader.
 */
export function modelFiles(pak, path) {
  const stem = path.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\.mdl$/, '');
  const mdl = pak.get(stem + '.mdl'), vvd = pak.get(stem + '.vvd');
  if (!mdl || !vvd) return null;
  for (const ext of ['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx']) {
    const vtx = pak.get(stem + ext);
    if (vtx) return { mdl, vvd, vtx };
  }
  return null;
}
