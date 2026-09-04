/* ============================== [PROP GEOM] ==============================
   A map's static props, as geometry the game can use.

   Three readers feed this: props.mjs says what is placed where, mdl.mjs says
   what each model looks like, and phy.mjs says what the solid ones collide as.
   This is the part that puts them in the same coordinate system and hands the
   result to the extractor.

   It matters because a map can put its ride surface in models rather than in
   brushes. surf_boreas does: nineteen of its ramps are prop_static, ten of
   them solid, and without this the map is a landscape with nothing to surf on.

   None of it ships to the browser. Like the compressed pakfile, this runs when
   a map is packed and what reaches the game is the result.                  */
import { readStaticProps } from './props.mjs';
import { readPhy } from './phy.mjs';
import { readModel, modelFiles } from './mdl.mjs';

const D2R = Math.PI / 180;
const SOLID_NONE = 0;

/**
 * Source's own AngleMatrix, for a QAngle of pitch, yaw and roll.
 *
 * Returned as nine numbers in row-major order, in Source's Z-up frame. This is
 * the one piece of this file that cannot be guessed at: get the order or a
 * sign wrong and every prop is subtly rotated, which reads as the map being
 * built wrong rather than as a bug here.
 */
function angleMatrix({ pitch, yaw, roll }) {
  const sp = Math.sin(pitch * D2R), cp = Math.cos(pitch * D2R);
  const sy = Math.sin(yaw * D2R), cy = Math.cos(yaw * D2R);
  const sr = Math.sin(roll * D2R), cr = Math.cos(roll * D2R);
  return [
    cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy,
    cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy,
    -sp, sr * cp, cr * cp,
  ];
}

/**
 * The same rotation, expressed for a mesh that is already in the game's frame.
 *
 * Source is Z-up and this game is Y-up, converted by (x, y, z) -> (x, z, -y).
 * Call that S. A prop's rotation M is written in Source's frame, so rotating a
 * mesh that has already been converted means S·M·S⁻¹ — convert back, rotate,
 * convert forward. Doing it this way rather than converting every vertex of
 * every placement keeps the mesh in the file once and the placement to twelve
 * numbers.
 */
function toGameFrame(m) {
  // S = [1 0 0; 0 0 1; 0 -1 0], S⁻¹ = [1 0 0; 0 0 -1; 0 1 0]
  const [a, b, c, d, e, f, g, h, i] = m;
  // S·M
  const sm = [a, b, c, g, h, i, -d, -e, -f];
  // (S·M)·S⁻¹ — column 1 becomes column 2 negated, column 2 becomes column 1
  return [
    sm[0], sm[2], -sm[1],
    sm[3], sm[5], -sm[4],
    sm[6], sm[8], -sm[7],
  ];
}

/** Source (x, y, z) -> the game's (x, z, -y). */
const toY = (x, y, z) => [x, z, -y];

/**
 * A convex hull's outward planes.
 *
 * One per distinct face. The winding of an IVP triangle is not worth trusting,
 * so every plane is pointed away from the hull's own middle instead, which is
 * correct for anything convex and needs nothing to be assumed about the file.
 */
function hullPlanes(verts) {
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v[0]; cy += v[1]; cz += v[2]; }
  cx /= verts.length; cy /= verts.length; cz /= verts.length;
  return { cx, cy, cz };
}

function planesOf(verts, tris) {
  const { cx, cy, cz } = hullPlanes(verts);
  const out = [];
  for (const [i, j, k] of tris) {
    const a = verts[i], b = verts[j], c = verts[k];
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue;                          // degenerate sliver
    nx /= L; ny /= L; nz /= L;
    let d = nx * a[0] + ny * a[1] + nz * a[2];
    if (nx * cx + ny * cy + nz * cz > d) { nx = -nx; ny = -ny; nz = -nz; d = -d; }
    // faces of a box arrive four times over; one plane each is enough
    if (out.some(p => Math.abs(p.x - nx) < 1e-4 && Math.abs(p.y - ny) < 1e-4
      && Math.abs(p.z - nz) < 1e-4 && Math.abs(p.d - d) < 0.05)) continue;
    out.push({ x: nx, y: ny, z: nz, d });
  }
  return out;
}

/**
 * Everything the extractor wants to know about a map's props.
 *
 * `pak` is the map's own pakfile, already decompressed. A model that is not in
 * it is skipped rather than guessed at: a prop referring to content the map
 * did not pack is a prop the map's own server could not have drawn either.
 */
export function readProps(bsp, pak) {
  const placed = readStaticProps(bsp);
  if (!placed.props.length) return null;

  const models = [];
  const byName = new Map();                          // model path -> index into models
  const hullsByName = new Map();                     // model path -> hulls in model space
  const missing = new Set();

  const load = raw => {
    /* boreas names one of its models "project_tendies//icicles/icicle_01.mdl",
       with the slash doubled, and 84 props point at it. The map's own engine
       shrugs that off; a Map lookup does not. */
    const path = raw.replace(/\/{2,}/g, '/');
    if (byName.has(path)) return byName.get(path);
    if (missing.has(path)) return -1;
    const files = modelFiles(pak, path);
    if (!files || !files.mdl || !files.vvd || !files.vtx) { missing.add(path); return -1; }
    let model;
    try { model = readModel(files); } catch (e) { missing.add(path); return -1; }
    if (!model || !model.meshes.length) { missing.add(path); return -1; }

    const meshes = [];
    for (const mesh of model.meshes) {
      const n = mesh.indices.length;
      if (!n) continue;
      /* Expanded to a triangle soup here rather than kept indexed: the world's
         own geometry is a soup for the same reason, and it is the packer's job
         to make the file small, not this one's. */
      const positions = new Float32Array(n * 3);
      const uvs = new Float32Array(n * 2);
      for (let t = 0; t < n; t++) {
        const v = mesh.indices[t];
        const p = toY(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
        positions[t * 3] = p[0]; positions[t * 3 + 1] = p[1]; positions[t * 3 + 2] = p[2];
        uvs[t * 2] = mesh.uvs[v * 2];
        uvs[t * 2 + 1] = mesh.uvs[v * 2 + 1];
      }
      meshes.push({ material: mesh.material, positions, uvs });
    }
    if (!meshes.length) { missing.add(path); return -1; }

    const at = models.length;
    models.push({ name: path, meshes });
    byName.set(path, at);

    // its collision, if it has any, kept in model space to be placed per prop
    const phy = pak.get(path.replace(/\.mdl$/i, '.phy'));
    if (phy) {
      const hulls = [];
      try {
        for (const solid of readPhy(phy).solids) {
          for (const h of solid.hulls) {
            if (h.verts.length >= 4 && h.tris.length >= 4) hulls.push(h);
          }
        }
      } catch (e) { /* a model with unreadable collision is drawn, not ridden */ }
      if (hulls.length) hullsByName.set(path, hulls);
    }
    return at;
  };

  const instances = [];
  const hulls = [];
  let solidProps = 0;

  for (const prop of placed.props) {
    const mi = load(prop.model);
    if (mi < 0) continue;

    const M = angleMatrix(prop.angles);
    const R = toGameFrame(M);
    const o = toY(prop.origin.x, prop.origin.y, prop.origin.z);
    instances.push({ model: mi, m: [...R, o[0], o[1], o[2]] });

    /* Collision only for the props that claim it. A prop_static with solid
       NONE is scenery — surf_boreas's nine ramp_s1 are exactly that, visual
       ramps laid over terrain you actually ride — and making it solid would
       put walls through a map that plays without them. */
    if (prop.solid === SOLID_NONE) continue;
    const modelHulls = hullsByName.get(prop.model.replace(/\/{2,}/g, '/'));
    if (!modelHulls) continue;
    solidProps++;
    for (const h of modelHulls) {
      const verts = h.verts.map(v => {
        // rotate in Source's frame, translate, then convert once
        const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + prop.origin.x;
        const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2] + prop.origin.y;
        const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2] + prop.origin.z;
        return toY(x, y, z);
      });
      const planes = planesOf(verts, h.tris);
      if (planes.length >= 4) hulls.push(planes);
    }
  }

  return {
    models: models.map(m => ({ meshes: m.meshes })),
    instances, hulls,
    stats: {
      placed: placed.props.length, drawn: instances.length,
      models: models.length, missing: missing.size, solidProps,
    },
  };
}
