/* ============================== [SMAP] ==============================
   A packed course: everything the game needs from a map, and nothing else.

   A .bsp is a compiler's output. It carries the visibility tree, the lightmap,
   the node hierarchy, the entity text, the packed materials and every face the
   compiler ever considered — because the engine that reads it needs all of
   that. This game does not. It needs the brush planes it collides with, the
   triangles it draws, the images those triangles wear, and the handful of
   volumes that run the clock. That is between a tenth and a twentieth of the
   file, which is the difference between a map you can put on a web server and
   one you cannot.

   surf_summer is 289 MB as a .bsp and 20 MB as one of these, with the same
   geometry, the same textures at the same resolution and the same lighting.
   Nothing is thrown away that the game would have used.

   Layout:
     "SMAP"                    magic, 4 bytes
     version                   u32
     header length             u32
     header                    JSON, utf-8 — the map, minus the bulk arrays
     sections                  the bulk arrays, back to back, most gzipped

   The header names every section by byte offset into the tail, so reading one
   is a slice and a decompress. Geometry gzips to about a third; the images do
   not gzip at all, being DXT blocks already, so they are stored as they are. */

export const VERSION = 1;

const MAGIC = [0x53, 0x4d, 0x41, 0x50];        // "SMAP"

/* CompressionStream and DecompressionStream are in both browsers and node,
   so the format has exactly one implementation rather than one per side. */
async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ============================== writing ============================== */

/**
 * Pack an extracted course.
 *
 * The vertex arrays arrive as one triangle per three vertices, with every
 * shared corner repeated — which is what the renderer wants and what a file
 * should never hold. They go in deduplicated, with an index per corner, and
 * come back out expanded to exactly the sequence that went in. On these maps
 * that removes about three fifths of the vertices.
 */
export async function encodeSmap(course) {
  const pos = [], uv = [], light = [], index = [];
  const groups = [];

  for (const g of course.groups) {
    const n = g.pos.length / 3;
    if (!n) continue;
    const seen = new Map();
    const vertOff = pos.length / 3, idxOff = index.length;
    for (let i = 0; i < n; i++) {
      const px = g.pos[i * 3], py = g.pos[i * 3 + 1], pz = g.pos[i * 3 + 2];
      const u = g.uv[i * 2], v = g.uv[i * 2 + 1];
      const lr = g.light[i * 3], lg = g.light[i * 3 + 1], lb = g.light[i * 3 + 2];
      const key = `${px},${py},${pz},${u},${v},${lr},${lg},${lb}`;
      let at = seen.get(key);
      if (at === undefined) {
        at = seen.size;
        seen.set(key, at);
        pos.push(px, py, pz);
        uv.push(u, v);
        light.push(lr, lg, lb);
      }
      index.push(at);
    }
    groups.push({
      material: g.material, image: g.image,
      vertOff, vertCount: seen.size, idxOff, idxCount: n,
    });
  }

  /* Brush planes as one array, with a count per brush. A brush is four planes
     at the least and a few dozen at the most, so a u16 count is roomy. */
  const counts = new Uint16Array(course.brushes.length);
  let planeTotal = 0;
  for (let i = 0; i < course.brushes.length; i++) {
    counts[i] = course.brushes[i].length;
    planeTotal += course.brushes[i].length;
  }
  /* float64, not float32. A plane read straight from the file has a float32
     distance, but a brush belonging to an entity with an origin has been
     translated — d + n·t — and that result is not a float32. Rounding it costs
     about a thousandth of a unit, which changes nothing you could ever feel,
     and costs the word "identical" in verify-maps, which is worth more. */
  const planes = new Float64Array(planeTotal * 4);
  let p = 0;
  for (const b of course.brushes) {
    for (const q of b) { planes[p++] = q.x; planes[p++] = q.y; planes[p++] = q.z; planes[p++] = q.d; }
  }

  const parts = [];
  let offset = 0;
  const section = async (bytes, compress) => {
    const raw = bytes.byteLength;
    const body = compress && raw ? await gzip(bytes) : bytes;
    const s = { off: offset, len: body.byteLength, raw, gz: !!(compress && raw) };
    parts.push(body);
    offset += body.byteLength;
    return s;
  };

  const bytesOf = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  /* A volume's shape, when it has one beyond its box. Kept in a section
     rather than in the header: as JSON these run to a few hundred kilobytes
     of "0.7071067690849304" on the bigger maps, and as float32 they gzip. */
  const triggerCounts = new Uint16Array(course.triggers.length);
  let triggerPlaneTotal = 0;
  for (let i = 0; i < course.triggers.length; i++) {
    const n = course.triggers[i].planes ? course.triggers[i].planes.length : 0;
    triggerCounts[i] = n;
    triggerPlaneTotal += n;
  }
  const triggerPlanes = new Float64Array(triggerPlaneTotal * 4);
  let tp = 0;
  for (const v of course.triggers) {
    for (const q of (v.planes || [])) {
      triggerPlanes[tp++] = q.x; triggerPlanes[tp++] = q.y; triggerPlanes[tp++] = q.z; triggerPlanes[tp++] = q.d;
    }
  }

  const sections = {
    pos: await section(bytesOf(new Float32Array(pos)), true),
    uv: await section(bytesOf(new Float32Array(uv)), true),
    light: await section(bytesOf(new Float32Array(light)), true),
    index: await section(bytesOf(new Uint32Array(index)), true),
    planes: await section(bytesOf(planes), true),
    brushCounts: await section(bytesOf(counts), true),
    terrain: await section(bytesOf(course.terrain || new Float32Array(0)), true),
    triggerPlanes: await section(bytesOf(triggerPlanes), true),
    triggerPlaneCounts: await section(bytesOf(triggerCounts), true),
  };

  /* The images last, uncompressed: they are DXT blocks, which gzip cannot
     improve on and only slows the load down by pretending it can. */
  const images = [];
  for (const img of course.images) {
    const s = await section(img.data, false);
    images.push({
      path: img.path, width: img.width, height: img.height,
      format: img.format, translucent: !!img.translucent,
      off: s.off, len: s.len,
    });
  }

  const header = {
    version: VERSION,
    bounds: course.bounds,
    spawns: course.spawns,
    triggers: course.triggers.map(v => ({
      minX: v.minX, maxX: v.maxX, minY: v.minY, maxY: v.maxY, minZ: v.minZ, maxZ: v.maxZ, data: v.data,
    })),
    prespeed: course.prespeed,
    finishPad: course.finishPad,
    env: course.env,
    stats: course.stats,
    groups, images, sections,
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(12 + headerBytes.byteLength);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, VERSION, true);
  new DataView(head.buffer).setUint32(8, headerBytes.byteLength, true);
  head.set(headerBytes, 12);

  const total = head.byteLength + offset;
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.byteLength;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/* ============================== reading ============================== */

/** The header alone — enough to know what a packed map is without its bulk. */
export function readSmapHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new Error('not a packed map: too short');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('not a packed map');
  }
  const dv = new DataView(buffer);
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new Error(`packed map version ${version}, expected ${VERSION}`);
  const len = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len)));
  return { header, bodyAt: 12 + len };
}

/**
 * Unpack a course, back into exactly what `extractCourse` produced.
 *
 * The vertex arrays are expanded from their indices here rather than being
 * handed to the GPU indexed, because a vertex shared between a surfable face
 * and a wall is two different colours — the shading is per triangle, so the
 * triangles have to stay separate. The index is a way to make the file
 * smaller, not a way to draw.
 */
export async function decodeSmap(buffer) {
  const { header, bodyAt } = readSmapHeader(buffer);
  const body = new Uint8Array(buffer, bodyAt);

  const read = async (s) => {
    if (!s || !s.len) return new Uint8Array(0);
    const slice = body.subarray(s.off, s.off + s.len);
    return s.gz ? await gunzip(slice) : slice;
  };
  const floats = async s => {
    const b = await read(s);
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  };
  const doubles = async s => {
    const b = await read(s);
    return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
  };

  const sec = header.sections;
  const pos = await floats(sec.pos);
  const uv = await floats(sec.uv);
  const light = await floats(sec.light);
  const idxBytes = await read(sec.index);
  const index = new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength / 4);
  const planeData = await doubles(sec.planes);
  const countBytes = await read(sec.brushCounts);
  const counts = new Uint16Array(countBytes.buffer, countBytes.byteOffset, countBytes.byteLength / 2);
  const terrain = await floats(sec.terrain);

  const groups = header.groups.map(g => {
    const n = g.idxCount;
    /* addGroup walks these three at a time and reads nine floats per triangle.
       A count that is not a multiple of three runs it off the end of the array,
       which three.js draws as an invisible mesh and reports nowhere. */
    if (n % 3) throw new Error(`packed map: mesh "${g.material}" has ${n} vertices, not a whole number of triangles`);
    const gp = new Float32Array(n * 3), gu = new Float32Array(n * 2), gl = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = g.vertOff + index[g.idxOff + i];
      gp[i * 3] = pos[v * 3]; gp[i * 3 + 1] = pos[v * 3 + 1]; gp[i * 3 + 2] = pos[v * 3 + 2];
      gu[i * 2] = uv[v * 2]; gu[i * 2 + 1] = uv[v * 2 + 1];
      gl[i * 3] = light[v * 3]; gl[i * 3 + 1] = light[v * 3 + 1]; gl[i * 3 + 2] = light[v * 3 + 2];
    }
    return { material: g.material, image: g.image, pos: gp, uv: gu, light: gl };
  });

  /* Reattach each volume's shape. A count of zero means the volume really is
     a box — a start zone taken from model bounds, say — and stays one. */
  const tpData = await doubles(sec.triggerPlanes);
  const tcBytes = await read(sec.triggerPlaneCounts);
  const tCounts = new Uint16Array(tcBytes.buffer, tcBytes.byteOffset, tcBytes.byteLength / 2);
  let tpAt = 0;
  const triggers = header.triggers.map((v, i) => {
    const n = tCounts[i] || 0;
    if (!n) return v;
    const planes = [];
    for (let k = 0; k < n; k++, tpAt += 4) {
      planes.push({ x: tpData[tpAt], y: tpData[tpAt + 1], z: tpData[tpAt + 2], d: tpData[tpAt + 3] });
    }
    return { ...v, planes };
  });

  const brushes = [];
  let at = 0;
  for (const c of counts) {
    const ps = [];
    for (let k = 0; k < c; k++, at += 4) {
      ps.push({ x: planeData[at], y: planeData[at + 1], z: planeData[at + 2], d: planeData[at + 3] });
    }
    brushes.push(ps);
  }

  const images = header.images.map(img => ({
    path: img.path, width: img.width, height: img.height,
    format: img.format, translucent: img.translucent,
    data: body.subarray(img.off, img.off + img.len),
  }));

  return {
    bounds: header.bounds, spawns: header.spawns, triggers,
    prespeed: header.prespeed, finishPad: header.finishPad, env: header.env,
    stats: header.stats, brushes, groups, images, terrain,
  };
}
