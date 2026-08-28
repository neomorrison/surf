/* ============================== [VTF / VMT] ==============================
   Source material and texture files, as found inside a map's pakfile.

   A .vmt is a small text material; the one a face names is usually a `patch`
   the compiler generated to add a cubemap, which `include`s the real material,
   so resolving a face to its texture means following that chain.

   A .vtf is the texture. Every one in a normal map is DXT-compressed, and DXT
   is exactly what the GPU wants, so nothing is decoded here — the block data
   is handed to WebGL as-is. Mips are stored smallest-first, so the full-size
   image is the last thing in the file.                                      */
import * as THREE from 'three';

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
export function parseVtf(bytes) {
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

  const size = fmt.block
    ? Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * fmt.block
    : width * height * fmt.bytes;
  const start = bytes.length - size;
  if (start < 0) return null;

  return { width, height, format: fmt.name, data: bytes.subarray(start), translucentFormat: fmt.name === 'DXT5' };
}

/** Average colour, for when a texture cannot be uploaded. */
function averageOf(vtf) {
  // DXT blocks begin with two RGB565 endpoints; averaging those across the
  // image is a cheap, close-enough tint without decoding anything.
  if (!vtf.format.startsWith('DXT')) return new THREE.Color(0.6, 0.6, 0.62);
  const step = vtf.format === 'DXT1' || vtf.format === 'DXT1_A1' ? 8 : 16;
  const off = step === 8 ? 0 : 8;
  const d = vtf.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = off; i + 4 <= d.length; i += step * 16) {
    for (const k of [0, 2]) {
      const c = d[i + k] | (d[i + k + 1] << 8);
      r += ((c >> 11) & 31) / 31; g += ((c >> 5) & 63) / 63; b += (c & 31) / 31;
      n++;
    }
  }
  return n ? new THREE.Color(r / n, g / n, b / n) : new THREE.Color(0.6, 0.6, 0.62);
}

const S3TC = {
  DXT1: THREE.RGB_S3TC_DXT1_Format,
  DXT1_A1: THREE.RGBA_S3TC_DXT1_Format,
  DXT3: THREE.RGBA_S3TC_DXT3_Format,
  DXT5: THREE.RGBA_S3TC_DXT5_Format,
};

/**
 * A THREE texture for a parsed .vtf, or null with an average colour to fall
 * back to. `s3tc` says whether the GPU takes DXT blocks directly.
 */
export function makeTexture(vtf, s3tc) {
  if (!vtf) return { texture: null, color: new THREE.Color(0.6, 0.6, 0.62) };
  const color = averageOf(vtf);
  const compressed = S3TC[vtf.format];

  if (compressed && s3tc) {
    const t = new THREE.CompressedTexture(
      [{ data: vtf.data, width: vtf.width, height: vtf.height }],
      vtf.width, vtf.height, compressed);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearFilter;                  // only the top mip is uploaded
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return { texture: t, color };
  }

  if (vtf.format === 'BGR888' || vtf.format === 'RGB888' || vtf.format === 'BGRA8888' || vtf.format === 'RGBA8888') {
    const px = vtf.width * vtf.height;
    const src = vtf.data, out = new Uint8Array(px * 4);
    const n = vtf.format.startsWith('BGR') ? 1 : 0;    // swap red and blue for BGR
    const stride = vtf.format.length > 7 ? 4 : 3;
    for (let i = 0; i < px; i++) {
      const s = i * stride, d = i * 4;
      out[d] = n ? src[s + 2] : src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = n ? src[s] : src[s + 2];
      out[d + 3] = stride === 4 ? src[s + 3] : 255;
    }
    const t = new THREE.DataTexture(out, vtf.width, vtf.height, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return { texture: t, color };
  }

  return { texture: null, color };
}
