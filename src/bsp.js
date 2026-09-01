/* ============================== [BSP] ==============================
   A reader for Source engine .bsp files (v19/20/21, uncompressed lumps).

   This exists so the game can load a real map instead of an impression of
   one. It reads two things: the *brushes*, which are the convex volumes the
   player actually collides with, and the *faces*, which are what you see.

   Nothing here is specific to any one map, and no map data lives in this
   repository — a .bsp goes in local/, which is gitignored. This is a reader
   for a file format; the maps stay on the machine that owns them.

   Coordinates: Source is Z-up and right-handed, three.js is Y-up. The whole
   file is converted on the way in by (x, y, z) -> (x, z, -y), which is a
   rotation, so plane distances survive it untouched.                       */

const HEADER = 1036;                    // ident + version + 64 lumps + revision

export const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, NODES: 5, TEXINFO: 6, FACES: 7, LIGHTING: 8,
  LEAFS: 10, LEAFBRUSHES: 17,
  EDGES: 12, SURFEDGES: 13, MODELS: 14, BRUSHES: 18, BRUSHSIDES: 19,
  DISPINFO: 26, DISP_VERTS: 33, PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44,
};

/* brush contents */
export const CONTENTS = {
  SOLID: 0x1, WINDOW: 0x2, GRATE: 0x8, WATER: 0x20,
  PLAYERCLIP: 0x10000, MONSTERCLIP: 0x20000, DETAIL: 0x8000000,
};

/* texinfo flags — the faces that exist for the compiler, not for the eye */
const SURF_SKY = 0x4, SURF_TRIGGER = 0x40, SURF_NODRAW = 0x80;
const SURF_HINT = 0x100, SURF_SKIP = 0x200, SURF_SKY2D = 0x2;
const INVISIBLE = SURF_SKY | SURF_SKY2D | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP;

/** Source (x, y, z) -> three.js (x, z, -y). */
export const toY = (x, y, z) => ({ x, y: z, z: -y });

export function readBsp(buffer) {
  const dv = new DataView(buffer);
  const ident = dv.getUint32(0, true);
  if (ident !== 0x50534256) throw new Error('not a VBSP file');
  const version = dv.getInt32(4, true);
  if (version < 19 || version > 21) throw new Error('unsupported BSP version ' + version);

  const lumps = [];
  for (let i = 0; i < 64; i++) {
    const o = 8 + i * 16;
    lumps.push({
      ofs: dv.getInt32(o, true), len: dv.getInt32(o + 4, true),
      version: dv.getInt32(o + 8, true), fourCC: dv.getInt32(o + 12, true),
    });
  }
  for (const l of lumps) {
    if (l.fourCC !== 0 && l.len) {
      throw new Error('this .bsp has LZMA-compressed lumps; repack it uncompressed');
    }
  }
  return new Bsp(dv, buffer, lumps, version);
}

class Bsp {
  constructor(dv, buffer, lumps, version) {
    this.dv = dv; this.buffer = buffer; this.lumps = lumps; this.version = version;
  }
  lump(i) { return this.lumps[i]; }
  count(i, stride) { return Math.floor(this.lumps[i].len / stride); }

  /* ---------------- entities ---------------- */

  /** The entity lump, parsed into plain objects. Origins are converted. */
  entities() {
    const l = this.lump(LUMP.ENTITIES);
    const text = new TextDecoder('latin1').decode(new Uint8Array(this.buffer, l.ofs, l.len));
    const out = [];
    for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
      const kv = {};
      for (const p of m[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)) kv[p[1]] = p[2];
      if (kv.origin) {
        const [x, y, z] = kv.origin.trim().split(/\s+/).map(Number);
        kv.pos = toY(x, y, z);
      }
      out.push(kv);
    }
    return out;
  }

  /**
   * The map's own lighting, straight out of the entity lump.
   *
   * A surf map is lit by its author, and guessing where to put lamps in
   * thirty thousand units of geometry is a losing game when the file already
   * says. Source angles are (pitch, yaw, roll) with pitch measured downward,
   * and light_environment's own `pitch` key overrides the one in `angles`.
   */
  lights() {
    const rgbi = (str, fallback = 200) => {
      const p = (str || '').trim().split(/\s+/).map(Number);
      const i = p.length > 3 && Number.isFinite(p[3]) ? p[3] : fallback;
      return { r: (p[0] || 0) / 255, g: (p[1] || 0) / 255, b: (p[2] || 0) / 255, i };
    };
    const points = [];
    let env = null;
    for (const e of this.entities()) {
      if (e.classname === 'light' && e.pos) {
        const c = rgbi(e._light);
        points.push({
          pos: e.pos, r: c.r, g: c.g, b: c.b, i: c.i,
          constant: +(e._constant_attn || 0), linear: +(e._linear_attn || 0),
          quadratic: +(e._quadratic_attn || 0),
        });
      } else if (e.classname === 'light_environment') {
        const sun = rgbi(e._light, 300), amb = rgbi(e._ambient, 100);
        const a = (e.angles || '0 0 0').trim().split(/\s+/).map(Number);
        const pitch = (e.pitch != null ? +e.pitch : a[0]) * Math.PI / 180;
        const yaw = a[1] * Math.PI / 180;
        // Source direction, then rotated into Y-up. This is the way the light
        // travels, so the sun itself sits opposite it.
        const cp = Math.cos(pitch);
        env = {
          dir: toY(Math.cos(yaw) * cp, Math.sin(yaw) * cp, Math.sin(pitch)),
          sun, ambient: amb,
        };
      }
    }
    return { points, env };
  }

  /**
   * The embedded pakfile, as name -> bytes.
   *
   * A .bsp carries a zip of everything the map needs that the game does not
   * already have. On a well-packed map that is all of it, which is why the
   * map works on a server that has never seen it — and why it can be textured
   * here with no game install at all. Entries in a bsp pakfile are stored,
   * not deflated, so this only has to walk the central directory and slice.
   */
  pakfile() {
    const l = this.lump(LUMP.PAKFILE);
    const files = new Map();
    if (!l.len) return files;
    const bytes = new Uint8Array(this.buffer, l.ofs, l.len);
    const dv = new DataView(this.buffer, l.ofs, l.len);

    // end of central directory, searched from the back past any comment
    let eocd = -1;
    for (let i = l.len - 22; i >= 0 && i > l.len - 22 - 65536; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return files;

    let p = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    const dec = new TextDecoder('latin1');
    for (let i = 0; i < count && p + 46 <= l.len; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (method !== 0) continue;                     // stored only; nothing here is deflated
      const lnLen = dv.getUint16(local + 26, true);
      const leLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnLen + leLen;
      files.set(name.toLowerCase().replace(/\\/g, '/'), bytes.subarray(start, start + size));
    }
    return files;
  }

  /**
   * Where each model's geometry actually belongs.
   *
   * Model 0 is the world and sits at the origin. Every other model is a brush
   * entity whose geometry -- bounds, faces and brushes alike -- is stored
   * relative to its `origin` keyvalue, so all three need the same translation
   * on the way out. Without it a map's doors, platforms, glass and decorative
   * brushwork are all drawn and collided in a heap at the world centre, and
   * missing from where they belong.
   *
   * Returns offsets in Y-up, plus the models belonging to entities that are
   * not solid and should never reach the collision world.
   */
  modelPlacement() {
    const n = this.count(LUMP.MODELS, 48);
    const offset = new Array(n).fill(null);
    const nonSolid = new Set();
    const NEVER_SOLID = /^(func_illusionary|func_dustmotes|func_smokevolume|func_precipitation|env_bubbles|func_occluder|trigger_)/;
    for (const e of this.entities()) {
      if (!e.model || e.model[0] !== '*') continue;
      const i = +e.model.slice(1);
      if (!(i >= 0 && i < n)) continue;
      if (e.pos && (e.pos.x || e.pos.y || e.pos.z)) offset[i] = e.pos;
      if (NEVER_SOLID.test(e.classname || '')) nonSolid.add(i);
    }
    return { offset, nonSolid };
  }

  /** Which model owns each face, from the models' face ranges. */
  faceModels() {
    const md = this.lump(LUMP.MODELS), n = this.count(LUMP.MODELS, 48);
    const owner = new Int16Array(this.count(LUMP.FACES, 56));
    for (let m = 0; m < n; m++) {
      const o = md.ofs + m * 48;
      const first = this.dv.getInt32(o + 40, true);
      const num = this.dv.getInt32(o + 44, true);
      for (let f = first; f < first + num && f < owner.length; f++) owner[f] = m;
    }
    return owner;
  }

  /* ---------------- geometry ---------------- */

  planes() {
    const l = this.lump(LUMP.PLANES), n = this.count(LUMP.PLANES, 20), out = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = l.ofs + i * 20;
      const nx = this.dv.getFloat32(o, true);
      const ny = this.dv.getFloat32(o + 4, true);
      const nz = this.dv.getFloat32(o + 8, true);
      out[i] = { x: nx, y: nz, z: -ny, d: this.dv.getFloat32(o + 12, true) };
    }
    return out;
  }

  brushSides() {
    const l = this.lump(LUMP.BRUSHSIDES), n = this.count(LUMP.BRUSHSIDES, 8), out = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = l.ofs + i * 8;
      out[i] = {
        planenum: this.dv.getUint16(o, true),
        texinfo: this.dv.getInt16(o + 2, true),
        dispinfo: this.dv.getInt16(o + 4, true),
        bevel: this.dv.getInt16(o + 6, true),
      };
    }
    return out;
  }

  /**
   * Every brush, as a list of outward planes.
   *
   * Bevel sides are kept on purpose. The compiler adds them precisely so that
   * an axis-aligned hull can be collided by offsetting each plane along its
   * own normal — which is exactly how physics.js tests a brush — and without
   * them a box slips through near edges and corners.
   */
  brushes(mask = CONTENTS.SOLID | CONTENTS.PLAYERCLIP) {
    const planes = this.planes(), sides = this.brushSides();
    const tex = this.textureNames();
    const l = this.lump(LUMP.BRUSHES), n = this.count(LUMP.BRUSHES, 12);
    const { offset, nonSolid } = this.modelPlacement();

    /* Attribute brushes to their model so brush entities can be translated
       and the non-solid ones dropped. Model 0's brushes need neither. */
    const owner = new Map();
    for (let m = 1; m < offset.length; m++) {
      if (!offset[m] && !nonSolid.has(m)) continue;
      for (const bi of this.modelBrushIndices(m)) owner.set(bi, m);
    }

    const out = [];
    for (let i = 0; i < n; i++) {
      const o = l.ofs + i * 12;
      const first = this.dv.getInt32(o, true);
      const num = this.dv.getInt32(o + 4, true);
      const contents = this.dv.getInt32(o + 8, true);
      if (!(contents & mask)) continue;
      const m = owner.get(i);
      if (m != null && nonSolid.has(m)) continue;          // decorative, not collidable
      const t = m != null ? offset[m] : null;
      const ps = [];
      /* A trigger volume is textured TOOLS/TOOLSTRIGGER on every side and is
         carried as CONTENTS_SOLID, so the contents mask lets it through. Most
         are caught by their entity model being non-solid, but a brush the
         model walk does not reach falls back to the world and stays in
         collision — and a trigger the size of a start room is then a solid
         block you spawn inside. The texture flags say plainly what it is, so
         ask them. Bevel sides carry no texture and do not vote. */
      let trigger = 0, surface = 0;
      for (let k = 0; k < num; k++) {
        const s = sides[first + k];
        if (!s) continue;
        if (!s.bevel) {
          const face = tex[s.texinfo];
          if (face && (face.flags & SURF_TRIGGER)) trigger++; else surface++;
        }
        const p = planes[s.planenum];
        ps.push(t ? { x: p.x, y: p.y, z: p.z, d: p.d + p.x * t.x + p.y * t.y + p.z * t.z } : p);
      }
      if (trigger && !surface) continue;
      if (ps.length >= 4) out.push({ planes: ps, contents });
    }
    return out;
  }

  /** Texture name per texinfo index, for identifying tool brushes. */
  textureNames() {
    const ti = this.lump(LUMP.TEXINFO), td = this.lump(LUMP.TEXDATA);
    const tsd = this.lump(LUMP.TEXDATA_STRING_DATA), tst = this.lump(LUMP.TEXDATA_STRING_TABLE);
    const bytes = new Uint8Array(this.buffer);
    const table = [];
    for (let i = 0; i < tst.len / 4; i++) table.push(this.dv.getInt32(tst.ofs + i * 4, true));
    const readStr = off => {
      let e = off; while (e < bytes.length && bytes[e] !== 0) e++;
      return new TextDecoder('latin1').decode(bytes.subarray(off, e));
    };
    const texdata = [];
    for (let i = 0; i < td.len / 32; i++) texdata.push(this.dv.getInt32(td.ofs + i * 32 + 12, true));
    const out = [];
    for (let i = 0; i < ti.len / 72; i++) {
      const flags = this.dv.getInt32(ti.ofs + i * 72 + 64, true);
      const tdi = this.dv.getInt32(ti.ofs + i * 72 + 68, true);
      const name = (tdi >= 0 && tdi < texdata.length) ? readStr(tsd.ofs + table[texdata[tdi]]) : '';
      out.push({ flags, name });
    }
    return out;
  }

  /**
   * The visible surface, as one triangle soup.
   *
   * Faces are stored as a ring of edges rather than as triangles, and the
   * edge indices are signed: the sign says which way round to read the edge,
   * which is how a face knows its own winding.
   */
  /**
   * The visible surface, grouped by material.
   *
   * Faces are stored as a ring of edges, not triangles, and the edge indices
   * are signed: the sign says which way round to read the edge, which is how a
   * face knows its winding. Each vertex comes out with three things — where it
   * is, how bright it is, and where it sits on its texture.
   *
   * `sizeOf(material)` supplies texture dimensions, because a face's texture
   * vectors are in texels and mean nothing without them.
   */
  faces(sizeOf) {
    const vl = this.lump(LUMP.VERTEXES), el = this.lump(LUMP.EDGES);
    const sl = this.lump(LUMP.SURFEDGES), fl = this.lump(LUMP.FACES);
    const til = this.lump(LUMP.TEXINFO), lml = this.lump(LUMP.LIGHTING);
    const tex = this.textureNames();
    const bytes = new Uint8Array(this.buffer);
    /* A brush entity's faces are stored relative to its origin, exactly like
       its bounds, so they need the same translation or the map's doors,
       platforms and glass all end up heaped at the world centre. */
    const owner = this.faceModels();
    const { offset } = this.modelPlacement();

    /* Vertices are kept in both frames: Y-up to draw with, and Source to look
       lighting and texturing up with, because a face's lightmap and texture
       vectors are in the coordinates the map was compiled in. */
    const nVerts = this.count(LUMP.VERTEXES, 12);
    const sx = new Float32Array(nVerts), sy = new Float32Array(nVerts), sz = new Float32Array(nVerts);
    for (let i = 0; i < nVerts; i++) {
      const o = vl.ofs + i * 12;
      sx[i] = this.dv.getFloat32(o, true);
      sy[i] = this.dv.getFloat32(o + 4, true);
      sz[i] = this.dv.getFloat32(o + 8, true);
    }
    const nEdges = this.count(LUMP.EDGES, 4);
    const e0 = new Uint16Array(nEdges), e1 = new Uint16Array(nEdges);
    for (let i = 0; i < nEdges; i++) {
      e0[i] = this.dv.getUint16(el.ofs + i * 4, true);
      e1[i] = this.dv.getUint16(el.ofs + i * 4 + 2, true);
    }
    const nSurf = this.count(LUMP.SURFEDGES, 4);
    const surf = new Int32Array(nSurf);
    for (let i = 0; i < nSurf; i++) surf[i] = this.dv.getInt32(sl.ofs + i * 4, true);

    /* A luxel is RGB plus a shared exponent, so baked light runs past 1.0. */
    const sample = (ofs, w, h, s, t) => {
      const si = Math.max(0, Math.min(w - 1, Math.round(s)));
      const ti = Math.max(0, Math.min(h - 1, Math.round(t)));
      const o = lml.ofs + ofs + (ti * w + si) * 4;
      if (ofs < 0 || o + 3 >= lml.ofs + lml.len) return null;
      const e = Math.pow(2, (bytes[o + 3] << 24) >> 24) / 255;
      return { r: bytes[o] * e, g: bytes[o + 1] * e, b: bytes[o + 2] * e };
    };

    const groups = new Map();
    const nFaces = this.count(LUMP.FACES, 56);
    let skipped = 0, disp = 0, unlit = 0, drawn = 0;

    for (let i = 0; i < nFaces; i++) {
      const o = fl.ofs + i * 56;
      const firstedge = this.dv.getInt32(o + 4, true);
      const numedges = this.dv.getInt16(o + 8, true);
      const texinfo = this.dv.getInt16(o + 10, true);
      const dispinfo = this.dv.getInt16(o + 12, true);
      const lightofs = this.dv.getInt32(o + 20, true);
      const minS = this.dv.getInt32(o + 28, true), minT = this.dv.getInt32(o + 32, true);
      const sizeS = this.dv.getInt32(o + 36, true), sizeT = this.dv.getInt32(o + 40, true);
      if (dispinfo >= 0) disp++;
      const t = tex[texinfo];
      if (!t || (t.flags & INVISIBLE)) { skipped++; continue; }
      if (numedges < 3) continue;
      drawn++;

      const to = til.ofs + texinfo * 72;
      const tv = k => this.dv.getFloat32(to + k * 4, true);            // textureVecs
      const lv = k => this.dv.getFloat32(to + 32 + k * 4, true);       // lightmapVecs
      const lw = sizeS + 1, lh = sizeT + 1;
      const hasLight = lightofs >= 0 && lw > 0 && lh > 0;
      if (!hasLight) unlit++;
      const dim = (sizeOf && sizeOf(t.name)) || { w: 512, h: 512 };

      let g = groups.get(t.name);
      if (!g) groups.set(t.name, g = { material: t.name, pos: [], light: [], uv: [] });

      const off = offset[owner[i]] || null;             // Y-up translation, if any

      const ring = [];
      for (let k = 0; k < numedges; k++) {
        const se = surf[firstedge + k];
        ring.push(se >= 0 ? e0[se] : e1[-se]);
      }
      const emit = v => {
        if (off) g.pos.push(sx[v] + off.x, sz[v] + off.y, -sy[v] + off.z);
        else g.pos.push(sx[v], sz[v], -sy[v]);                        // to Y-up
        const c = hasLight
          ? (sample(lightofs, lw, lh,
              lv(0) * sx[v] + lv(1) * sy[v] + lv(2) * sz[v] + lv(3) - minS,
              lv(4) * sx[v] + lv(5) * sy[v] + lv(6) * sz[v] + lv(7) - minT)
             || { r: 0.35, g: 0.35, b: 0.38 })
          : { r: 0.35, g: 0.35, b: 0.38 };
        g.light.push(c.r, c.g, c.b);
        g.uv.push(
          (tv(0) * sx[v] + tv(1) * sy[v] + tv(2) * sz[v] + tv(3)) / dim.w,
          -(tv(4) * sx[v] + tv(5) * sy[v] + tv(6) * sz[v] + tv(7)) / dim.h,
        );
      };
      for (let k = 1; k < ring.length - 1; k++) {
        emit(ring[0]); emit(ring[k]); emit(ring[k + 1]);
      }
    }

    return { groups: [...groups.values()], faces: nFaces, drawn, skipped, displacements: disp, unlit };
  }

  /**
   * Displacement surfaces, as triangles grouped by material.
   *
   * A displacement is a quad face subdivided into a (2^power + 1) grid, with
   * every grid point pushed along its own stored vector. It is how a mapper
   * makes terrain, and on maps built that way it is not decoration — it is the
   * surface you ride, so it has to exist for collision as much as for the eye.
   * The base face contributes its corners, texture vectors and lightmap; the
   * DISP_VERTS lump contributes the displacement of each point.
   */
  displacements(sizeOf) {
    const dl = this.lump(LUMP.DISPINFO), vlump = this.lump(LUMP.DISP_VERTS);
    const n = this.count(LUMP.DISPINFO, 176);
    if (!n) return { groups: [], count: 0, triangles: 0 };

    const fl = this.lump(LUMP.FACES), til = this.lump(LUMP.TEXINFO);
    const vl = this.lump(LUMP.VERTEXES), el = this.lump(LUMP.EDGES), sl = this.lump(LUMP.SURFEDGES);
    const lml = this.lump(LUMP.LIGHTING), pl = this.lump(LUMP.PLANES);
    const tex = this.textureNames();
    const bytes = new Uint8Array(this.buffer);
    const owner = this.faceModels();
    const { offset } = this.modelPlacement();

    const nVerts = this.count(LUMP.VERTEXES, 12);
    const sx = new Float32Array(nVerts), sy = new Float32Array(nVerts), sz = new Float32Array(nVerts);
    for (let i = 0; i < nVerts; i++) {
      const o = vl.ofs + i * 12;
      sx[i] = this.dv.getFloat32(o, true);
      sy[i] = this.dv.getFloat32(o + 4, true);
      sz[i] = this.dv.getFloat32(o + 8, true);
    }
    const nEdges = this.count(LUMP.EDGES, 4);
    const e0 = new Uint16Array(nEdges), e1 = new Uint16Array(nEdges);
    for (let i = 0; i < nEdges; i++) {
      e0[i] = this.dv.getUint16(el.ofs + i * 4, true);
      e1[i] = this.dv.getUint16(el.ofs + i * 4 + 2, true);
    }
    const nSurf = this.count(LUMP.SURFEDGES, 4);
    const surf = new Int32Array(nSurf);
    for (let i = 0; i < nSurf; i++) surf[i] = this.dv.getInt32(sl.ofs + i * 4, true);

    const luxel = (ofs, w, h, s, t) => {
      const si = Math.max(0, Math.min(w - 1, Math.round(s)));
      const ti = Math.max(0, Math.min(h - 1, Math.round(t)));
      const o = lml.ofs + ofs + (ti * w + si) * 4;
      if (ofs < 0 || o + 3 >= lml.ofs + lml.len) return null;
      const e = Math.pow(2, (bytes[o + 3] << 24) >> 24) / 255;
      return { r: bytes[o] * e, g: bytes[o + 1] * e, b: bytes[o + 2] * e };
    };

    const groups = new Map();
    let triangles = 0, built = 0;

    for (let d = 0; d < n; d++) {
      const o = dl.ofs + d * 176;
      const startX = this.dv.getFloat32(o, true);
      const startY = this.dv.getFloat32(o + 4, true);
      const startZ = this.dv.getFloat32(o + 8, true);
      const vertStart = this.dv.getInt32(o + 12, true);
      const power = this.dv.getInt32(o + 20, true);
      const mapFace = this.dv.getUint16(o + 36, true);

      const fo = fl.ofs + mapFace * 56;
      const firstedge = this.dv.getInt32(fo + 4, true);
      const numedges = this.dv.getInt16(fo + 8, true);
      const texinfo = this.dv.getInt16(fo + 10, true);
      const lightofs = this.dv.getInt32(fo + 20, true);
      const minS = this.dv.getInt32(fo + 28, true), minT = this.dv.getInt32(fo + 32, true);
      const sizeS = this.dv.getInt32(fo + 36, true), sizeT = this.dv.getInt32(fo + 40, true);
      const planenum = this.dv.getUint16(fo, true);
      const faceSide = bytes[fo + 2];
      if (numedges !== 4) continue;                    // a displacement is always a quad

      const t = tex[texinfo];
      if (!t) continue;

      // the face's own corners, in order
      const c = [];
      for (let k = 0; k < 4; k++) {
        const se = surf[firstedge + k];
        const v = se >= 0 ? e0[se] : e1[-se];
        c.push({ x: sx[v], y: sy[v], z: sz[v] });
      }
      // corner 0 is whichever is nearest startPosition; the grid is built from it
      let best = 0, bestD = Infinity;
      for (let k = 0; k < 4; k++) {
        const dd = (c[k].x - startX) ** 2 + (c[k].y - startY) ** 2 + (c[k].z - startZ) ** 2;
        if (dd < bestD) { bestD = dd; best = k; }
      }
      const q = [c[best], c[(best + 1) % 4], c[(best + 2) % 4], c[(best + 3) % 4]];

      const side = (1 << power) + 1;
      const gx = new Float32Array(side * side), gy = new Float32Array(side * side), gz = new Float32Array(side * side);
      for (let i = 0; i < side; i++) {
        const fi = i / (side - 1);
        const lx = q[0].x + (q[1].x - q[0].x) * fi, ly = q[0].y + (q[1].y - q[0].y) * fi, lz = q[0].z + (q[1].z - q[0].z) * fi;
        const rx = q[3].x + (q[2].x - q[3].x) * fi, ry = q[3].y + (q[2].y - q[3].y) * fi, rz = q[3].z + (q[2].z - q[3].z) * fi;
        for (let j = 0; j < side; j++) {
          const fj = j / (side - 1);
          const idx = i * side + j;
          const vo = vlump.ofs + (vertStart + idx) * 20;
          const dvx = this.dv.getFloat32(vo, true);
          const dvy = this.dv.getFloat32(vo + 4, true);
          const dvz = this.dv.getFloat32(vo + 8, true);
          const dist = this.dv.getFloat32(vo + 12, true);
          gx[idx] = lx + (rx - lx) * fj + dvx * dist;
          gy[idx] = ly + (ry - ly) * fj + dvy * dist;
          gz[idx] = lz + (rz - lz) * fj + dvz * dist;
        }
      }

      // which way the base face points, so triangles can be wound to match
      const po = pl.ofs + planenum * 20;
      let pnx = this.dv.getFloat32(po, true), pny = this.dv.getFloat32(po + 4, true), pnz = this.dv.getFloat32(po + 8, true);
      if (faceSide) { pnx = -pnx; pny = -pny; pnz = -pnz; }

      const to = til.ofs + texinfo * 72;
      const tv = k => this.dv.getFloat32(to + k * 4, true);
      const dim = (sizeOf && sizeOf(t.name)) || { w: 512, h: 512 };
      const lw = sizeS + 1, lh = sizeT + 1;
      const hasLight = lightofs >= 0 && lw > 0 && lh > 0;

      let g = groups.get(t.name);
      if (!g) groups.set(t.name, g = { material: t.name, pos: [], light: [], uv: [] });

      const off = offset[owner[mapFace]] || null;
      const emit = idx => {
        const X = gx[idx], Y = gy[idx], Z = gz[idx];
        if (off) g.pos.push(X + off.x, Z + off.y, -Y + off.z);
        else g.pos.push(X, Z, -Y);                     // to Y-up
        const i = Math.floor(idx / side), j = idx % side;
        const c2 = hasLight
          ? (luxel(lightofs, lw, lh, j / (side - 1) * (lw - 1), i / (side - 1) * (lh - 1)) || { r: 0.35, g: 0.35, b: 0.38 })
          : { r: 0.35, g: 0.35, b: 0.38 };
        g.light.push(c2.r, c2.g, c2.b);
        g.uv.push(
          (tv(0) * X + tv(1) * Y + tv(2) * Z + tv(3)) / dim.w,
          -(tv(4) * X + tv(5) * Y + tv(6) * Z + tv(7)) / dim.h,
        );
      };

      for (let i = 0; i < side - 1; i++) {
        for (let j = 0; j < side - 1; j++) {
          const a = i * side + j, b = a + 1, cc = a + side, e = cc + 1;
          for (const tri of [[a, b, e], [a, e, cc]]) {
            // wind so the surface normal agrees with the face it came from
            const [i0, i1, i2] = tri;
            const ux = gx[i1] - gx[i0], uy = gy[i1] - gy[i0], uz = gz[i1] - gz[i0];
            const vx = gx[i2] - gx[i0], vy = gy[i2] - gy[i0], vz = gz[i2] - gz[i0];
            const nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
            const facing = nx2 * pnx + ny2 * pny + nz2 * pnz >= 0;
            if (facing) { emit(i0); emit(i1); emit(i2); }
            else { emit(i0); emit(i2); emit(i1); }
            triangles++;
          }
        }
      }
      built++;
    }
    return { groups: [...groups.values()], count: built, triangles };
  }

  /**
   * The brushes a brush entity is actually made of.
   *
   * A trigger's bounding box is not the trigger. A boundary volume built as a
   * shell, or as a scatter of thin slabs, has a box that swallows all the open
   * air between them -- and treating that box as the volume teleports a player
   * flying through clear space. So the model's BSP tree is walked down to its
   * leaves and the real brushes collected.
   *
   * Planes come back in the model's own space; add the entity origin to place
   * them. Translating a plane by t moves its distance by n.t.
   */
  modelBrushes(modelIndex) {
    const planes = this.planes(), sides = this.brushSides();
    const br = this.lump(LUMP.BRUSHES);
    const out = [];
    for (const bi of this.modelBrushIndices(modelIndex)) {
      const o = br.ofs + bi * 12;
      const first = this.dv.getInt32(o, true);
      const num = this.dv.getInt32(o + 4, true);
      const contents = this.dv.getInt32(o + 8, true);
      const ps = [];
      for (let k = 0; k < num; k++) {
        const sd = sides[first + k];
        if (sd) ps.push(planes[sd.planenum]);
      }
      if (ps.length >= 4) out.push({ planes: ps, contents });
    }
    return out;
  }

  /** The brush indices a model's BSP tree reaches. */
  modelBrushIndices(modelIndex) {
    const md = this.lump(LUMP.MODELS), nd = this.lump(LUMP.NODES);
    const lf = this.lump(LUMP.LEAFS), lb = this.lump(LUMP.LEAFBRUSHES);
    const leafStride = lf.version === 0 ? 56 : 32;      // v0 carries a light cube
    const nLeaf = Math.floor(lf.len / leafStride);

    const found = new Set();
    const stack = [this.dv.getInt32(md.ofs + modelIndex * 48 + 36, true)];
    let guard = 0;
    while (stack.length && guard++ < 200000) {
      const node = stack.pop();
      if (node < 0) {
        const li = -1 - node;
        if (li >= nLeaf) continue;
        const o = lf.ofs + li * leafStride;
        const first = this.dv.getUint16(o + 24, true);
        const num = this.dv.getUint16(o + 26, true);
        for (let k = 0; k < num; k++) found.add(this.dv.getUint16(lb.ofs + (first + k) * 2, true));
        continue;
      }
      const o = nd.ofs + node * 32;
      stack.push(this.dv.getInt32(o + 4, true), this.dv.getInt32(o + 8, true));
    }

    return found;
  }

  /**
   * Every model's bounding box, in Y-up. Model 0 is the world; the rest are
   * brush entities, and a trigger's box is how you find where its volume is
   * without walking the BSP tree for it.
   */
  models() {
    const l = this.lump(LUMP.MODELS), n = this.count(LUMP.MODELS, 48), out = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = l.ofs + i * 48;
      const g = k => this.dv.getFloat32(o + k * 4, true);
      const a = toY(g(0), g(1), g(2)), b = toY(g(3), g(4), g(5));
      out[i] = {
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
        minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
      };
    }
    return out;
  }

  /** Bounds of the world model, already in Y-up. */
  worldBounds() {
    const l = this.lump(LUMP.MODELS);
    const g = i => this.dv.getFloat32(l.ofs + i * 4, true);
    const a = toY(g(0), g(1), g(2)), b = toY(g(3), g(4), g(5));
    return {
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
    };
  }
}
