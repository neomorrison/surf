/* ============================== [VTF READ] ==============================
   Source material and texture files, as found inside a map's pakfile — the
   half of the job that is just reading bytes.

   A .vmt is a small text material; the one a face names is usually a `patch`
   the compiler generated to add a cubemap, which `include`s the real material,
   so resolving a face to its texture means following that chain.

   A .vtf is the texture. Every one in a normal map is DXT-compressed, and DXT
   is exactly what the GPU wants, so nothing is decoded here — the block data
   comes out as it went in. Mips are stored smallest-first, so the full-size
   image is the last thing in the file.

   Nothing here imports three.js, which is what lets `tools/pack-map.mjs` read
   a map's textures in node without a renderer anywhere in sight.            */

/* image formats, of the many Source defines, that actually turn up */
const FORMAT = {
  0: { name: 'RGBA8888', bytes: 4 },
  2: { name: 'RGB888', bytes: 3 },
  3: { name: 'BGR888', bytes: 3 },
  12: { name: 'BGRA8888', bytes: 4 },
  13: { name: 'DXT1', block: 8 },
  14: { name: 'DXT3', block: 16 },
  15: { name: 'DXT5', block: 16 },
  24: { name: 'DXT1_A1', block: 8 },
};
const ENVMAP = 0x4000;

/** Parse the handful of .vmt keys that matter. Quotes are optional in VMT. */
/**
 * Parse the handful of .vmt keys that matter.
 *
 * Line-oriented rather than one big pattern: VMT quoting is inconsistent, and
 * a regex built by interpolation is one backslash away from silently matching
 * nothing at all — which is exactly what it did here, and the symptom was a
 * fully textured map rendering with no textures and no error.
 */
export function parseVmt(text) {
  const out = { include: null, basetexture: null, translucent: false };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*"?([$%\w]+)"?\s+"?([^"\r\n]*?)"?\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/\\/g, '/');
    if (key === 'include') out.include = val;
    else if (key === '$basetexture') out.basetexture = val;
    else if ((key === '$translucent' || key === '$alphatest') && val === '1') out.translucent = true;
  }
  return out;
}

/**
 * Follow a material name through any patch/include chain to its base texture.
 * Returns a pakfile key, or null if the chain leads outside the map.
 */
export function resolveTexture(pak, material, depth = 0) {
  if (depth > 4) return null;
  const key = ('materials/' + material + '.vmt').toLowerCase().replace(/\\/g, '/');
  const raw = pak.get(key);
  if (!raw) return null;
  const vmt = parseVmt(new TextDecoder('latin1').decode(raw));
  if (vmt.include) {
    return resolveTexture(pak, vmt.include.replace(/^materials\//i, '').replace(/\.vmt$/i, ''), depth + 1);
  }
  if (!vmt.basetexture) return null;
  return { path: ('materials/' + vmt.basetexture + '.vtf').toLowerCase(), translucent: vmt.translucent };
}

/**
 * Read a .vtf down to its largest mip.
 *
 * The mip chain runs smallest to largest, so rather than parse the resource
 * table that arrived in version 7.3 and walk forwards, this measures the
 * full-size image and takes it off the end — which is version-proof.
 */
/**
 * Read a .vtf down to a chosen mip.
 *
 * `maxDim` caps the largest side. Mips are stored smallest first, so the
 * full-size image is the last thing in the file and each smaller one sits
 * immediately before it — walking back from the end is version-proof and needs
 * nothing parsed that the header does not already say.
 */
export function parseVtf(bytes, maxDim) {
  if (bytes.length < 64) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x00465456) return null;              // "VTF\0"

  const width = dv.getUint16(16, true), height = dv.getUint16(18, true);
  const flags = dv.getUint32(20, true);
  const frames = dv.getUint16(24, true);
  const fmt = FORMAT[dv.getUint32(52, true)];
  if (!fmt || !width || !height) return null;
  // a cubemap has six faces and an animated texture many frames; the
  // take-it-off-the-end trick only holds for a single plain image
  if ((flags & ENVMAP) || frames > 1) return null;

  const sizeOf = (w, h) => (fmt.block
    ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * fmt.block
    : w * h * fmt.bytes);

  /* Walk down the chain from the full-size image, stopping at the first mip
     that fits — or at the smallest one there is, if none of them does. */
  let w = width, h = height, from = bytes.length;
  for (;;) {
    const size = sizeOf(w, h);
    if (from - size < 0) return null;
    from -= size;
    if (!maxDim || Math.max(w, h) <= maxDim) break;
    if (w <= 4 && h <= 4) break;                     // nothing smaller worth taking
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    if (from - sizeOf(nw, nh) < 0) break;            // the file does not carry it
    w = nw; h = nh;
  }

  return { width: w, height: h, format: fmt.name, data: bytes.subarray(from, from + sizeOf(w, h)), translucentFormat: fmt.name === 'DXT5' };
}
