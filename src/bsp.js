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
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7,
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
    const tex = this.textureNames();

    const nVerts = this.count(LUMP.VERTEXES, 12);
    const vx = new Float32Array(nVerts), vy = new Float32Array(nVerts), vz = new Float32Array(nVerts);
    for (let i = 0; i < nVerts; i++) {
      const o = vl.ofs + i * 12;
      const x = this.dv.getFloat32(o, true);
      const y = this.dv.getFloat32(o + 4, true);
      const z = this.dv.getFloat32(o + 8, true);
      vx[i] = x; vy[i] = z; vz[i] = -y;                 // to Y-up
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

    const pos = [];
    const nFaces = this.count(LUMP.FACES, 56);
    let skipped = 0, disp = 0;
    for (let i = 0; i < nFaces; i++) {
      const o = fl.ofs + i * 56;
      const firstedge = this.dv.getInt32(o + 4, true);
      const numedges = this.dv.getInt16(o + 8, true);
      const texinfo = this.dv.getInt16(o + 10, true);
      const dispinfo = this.dv.getInt16(o + 12, true);
      if (dispinfo >= 0) disp++;
      const t = tex[texinfo];
      if (!t || (t.flags & INVISIBLE)) { skipped++; continue; }
      if (numedges < 3) continue;

      const ring = [];
      for (let k = 0; k < numedges; k++) {
        const se = surf[firstedge + k];
        ring.push(se >= 0 ? e0[se] : e1[-se]);
      }
      for (let k = 1; k < ring.length - 1; k++) {
        for (const v of [ring[0], ring[k], ring[k + 1]]) {
          pos.push(vx[v], vy[v], vz[v]);
        }
      }
    }
    return { positions: new Float32Array(pos), faces: nFaces, skipped, displacements: disp };
  }

  /**
   * Every model's bounding box, in Y-up. Model 0 is the world; the rest are
   * brush entities, and a trigger's box is how you find out where its volume
   * is without walking the BSP tree for it.
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
