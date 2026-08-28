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
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, LIGHTING: 8,
  EDGES: 12, SURFEDGES: 13, MODELS: 14, BRUSHES: 18, BRUSHSIDES: 19,
  DISPINFO: 26, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44,
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
    const l = this.lump(LUMP.BRUSHES), n = this.count(LUMP.BRUSHES, 12);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = l.ofs + i * 12;
      const first = this.dv.getInt32(o, true);
      const num = this.dv.getInt32(o + 4, true);
      const contents = this.dv.getInt32(o + 8, true);
      if (!(contents & mask)) continue;
      const ps = [];
      for (let k = 0; k < num; k++) {
        const s = sides[first + k];
        if (s) ps.push(planes[s.planenum]);
      }
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
  faces() {
    const vl = this.lump(LUMP.VERTEXES), el = this.lump(LUMP.EDGES);
    const sl = this.lump(LUMP.SURFEDGES), fl = this.lump(LUMP.FACES);
    const til = this.lump(LUMP.TEXINFO), lml = this.lump(LUMP.LIGHTING);
    const tex = this.textureNames();
    const bytes = new Uint8Array(this.buffer);

    /* Vertices are kept in both frames: Y-up to draw with, and Source to look
       lighting up with, because a face's lightmap vectors are expressed in the
       coordinates the map was compiled in. */
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

    /* A luxel is stored as RGB plus a shared exponent, so the baked range goes
       far above 1.0; the tone map at the end is what brings it back. */
    const sample = (ofs, w, h, s, t) => {
      const si = Math.max(0, Math.min(w - 1, Math.round(s)));
      const ti = Math.max(0, Math.min(h - 1, Math.round(t)));
      const o = lml.ofs + ofs + (ti * w + si) * 4;
      if (ofs < 0 || o + 3 >= lml.ofs + lml.len) return null;
      const e = Math.pow(2, (bytes[o + 3] << 24) >> 24) / 255;
      return { r: bytes[o] * e, g: bytes[o + 1] * e, b: bytes[o + 2] * e };
    };

    const pos = [], col = [];
    const nFaces = this.count(LUMP.FACES, 56);
    let skipped = 0, disp = 0, unlit = 0;
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

      const lw = sizeS + 1, lh = sizeT + 1;
      const to = til.ofs + texinfo * 72;
      const lv = k => this.dv.getFloat32(to + 32 + k * 4, true);   // lightmapVecs
      const hasLight = lightofs >= 0 && lw > 0 && lh > 0;
      if (!hasLight) unlit++;

      const ring = [];
      for (let k = 0; k < numedges; k++) {
        const se = surf[firstedge + k];
        ring.push(se >= 0 ? e0[se] : e1[-se]);
      }
      const litOf = v => {
        if (!hasLight) return { r: 0.35, g: 0.35, b: 0.38 };
        const s = lv(0) * sx[v] + lv(1) * sy[v] + lv(2) * sz[v] + lv(3) - minS;
        const tt = lv(4) * sx[v] + lv(5) * sy[v] + lv(6) * sz[v] + lv(7) - minT;
        return sample(lightofs, lw, lh, s, tt) || { r: 0.35, g: 0.35, b: 0.38 };
      };
      for (let k = 1; k < ring.length - 1; k++) {
        for (const v of [ring[0], ring[k], ring[k + 1]]) {
          pos.push(sx[v], sz[v], -sy[v]);               // to Y-up
          const c = litOf(v);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    return {
      positions: new Float32Array(pos), light: new Float32Array(col),
      faces: nFaces, skipped, displacements: disp, unlit,
    };
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
