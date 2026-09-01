/* ============================== [VTF] ==============================
   Textures for the GPU, out of a map's own .vtf files.

   The reading is in vtfread.js, which has no three.js in it so that the map
   packer can use it in node. This is the part that needs a renderer: turning
   the blocks that came out of the file into something WebGL will sample.  */
import * as THREE from 'three';

export { parseVmt, parseVtf, resolveTexture } from './vtfread.js';

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
