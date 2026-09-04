/* ============================== [PROPS] ==============================
   prop_static, read out of a .bsp's game lump.

   A map's brushes are its shape, but on plenty of community maps they are not
   all of the shape you touch. surf_boreas is ridden on nineteen prop_static
   ramps, with the brushwork around them as scenery — so a reader that stops at
   brushes sees that map as a hole in the sky with some rocks in it.

   Props do not get a lump of their own. They live inside game lump 35, which
   is a directory of sub-lumps, under the tag 'sprp'. That sub-lump carries its
   own version, independent of the .bsp's: 4 through 11 are all in the wild and
   every one of them grew the per-prop record by a few bytes. So the record
   size is measured from the lump rather than written down here, and only the
   leading fields are read — those have not moved since v4.

   Coordinates come out in Source's frame, not converted the way src/bsp.js
   converts everything on the way in. A prop is a position and a rotation that
   only mean anything once its model has been loaded and placed, and rotating
   half of that here and the other half wherever the model is read is exactly
   how a map ends up mirrored on one axis. The caller converts, once.       */
import { unpackEntry } from './pakdecode.mjs';

const GAME_LUMP = 35;
const SPRP = 0x73707270;                // 'sprp', as those four bytes read little-endian
const LZMA_ID = 0x414d5a4c;             // 'LZMA', the same way
const NAME_LEN = 128;                   // model paths are fixed-width and NUL-padded

/** One sub-lump of the game lump, by tag. */
function subLump(bsp, id) {
  const l = bsp.lump(GAME_LUMP);
  if (!l.len) return null;
  const dv = bsp.dv;
  const count = dv.getInt32(l.ofs, true);
  for (let i = 0; i < count; i++) {
    const e = l.ofs + 4 + i * 16;
    if (e + 16 > l.ofs + l.len) break;
    if (dv.getInt32(e, true) !== id) continue;
    /* The offset is into the file, not into the game lump, and the payload is
       routinely nowhere near it — boreas keeps a 36 KB game lump and a 123 KB
       prop sub-lump in different parts of the file. */
    const ofs = dv.getInt32(e + 8, true);
    const len = dv.getInt32(e + 12, true);
    if (ofs <= 0 || len <= 0 || ofs + len > bsp.buffer.byteLength) return null;
    return { ofs, len, version: dv.getUint16(e + 6, true) };
  }
  return null;
}

/**
 * The sub-lump's bytes, decompressed if it is compressed.
 *
 * A sub-lump can be packed on its own even in a .bsp whose lumps are all
 * plain — tools/unlzma-bsp.mjs deliberately relocates these without touching
 * them, because unpacking one would contradict the size the game lump's own
 * directory records. What it is packed as is Valve's lzma_header_t: 'LZMA',
 * the two sizes, five property bytes, then raw LZMA1.
 *
 * That is the same stream a zip method-14 entry carries, differing only in the
 * few bytes ahead of the properties. So rather than reach for xz a third way,
 * the header is restacked into the shape unpackEntry already reads. One
 * decoder means one place for the decode to be wrong.
 */
function payload(bsp, sub) {
  const bytes = new Uint8Array(bsp.buffer, sub.ofs, sub.len);
  if (sub.len < 17 || bsp.dv.getUint32(sub.ofs, true) !== LZMA_ID) return bytes;

  const actual = bsp.dv.getUint32(sub.ofs + 4, true);
  const lzmaSize = bsp.dv.getUint32(sub.ofs + 8, true);
  const zip = Buffer.alloc(9 + lzmaSize);
  zip.writeUInt16LE(0, 0);              // zip's LZMA SDK version, which nothing reads
  zip.writeUInt16LE(5, 2);              // property length: always the five that follow
  Buffer.from(bytes.subarray(12, 17)).copy(zip, 4);
  Buffer.from(bytes.subarray(17, 17 + lzmaSize)).copy(zip, 9);

  const out = unpackEntry(zip, 14, actual);
  if (!out) throw new Error('the static prop lump is LZMA-compressed and would not decode; is xz on PATH?');
  return out;
}

/**
 * Every prop_static in the map, and the model each one wears.
 *
 * `models` is the lump's own dictionary and `prop.model` is an entry from it,
 * lowercased with forward slashes so it can be looked up straight in the map's
 * pakfile, which src/bsp.js keys the same way. Nothing else about the path is
 * touched: boreas has one entry with a doubled slash in it, and correcting a
 * map's own data here would only hide it from whoever has to deal with it.
 *
 * `solid` is SOLID_NONE (0), SOLID_BSP (2) or, for most props that collide,
 * SOLID_VPHYSICS (6) — a prop the player passes through and a prop that is a
 * ramp are told apart by this and by nothing else.
 */
export function readStaticProps(bsp) {
  const sub = subLump(bsp, SPRP);
  if (!sub) return { models: [], props: [] };

  const buf = payload(bsp, sub);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder('latin1');
  let p = 0;

  const dictEntries = dv.getInt32(p, true); p += 4;
  const models = [];
  for (let i = 0; i < dictEntries; i++) {
    const raw = buf.subarray(p, p + NAME_LEN);
    let end = 0;
    while (end < NAME_LEN && raw[end]) end++;
    models.push(dec.decode(raw.subarray(0, end)).toLowerCase().replace(/\\/g, '/'));
    p += NAME_LEN;
  }

  /* The leaf table says which visleaves each prop shows up in. That is the
     renderer's problem, not this one's, so it is stepped over — but it has to
     be stepped over exactly, because the prop count sits on the far side. */
  const leafEntries = dv.getInt32(p, true); p += 4;
  p += leafEntries * 2;

  const propCount = dv.getInt32(p, true); p += 4;
  if (propCount <= 0) return { models, props: [] };

  /* Every version from 4 to 11 has a different record size, and a map can be
     compiled by any tool that claims one of them, so trusting a table of sizes
     is trusting the compiler to have agreed with it. The lump ends where the
     last prop ends, so the size is simply what is left divided by how many
     there are — and if that does not come out whole, the layout is not what
     this thinks it is and reading on would produce plausible nonsense. */
  const rest = buf.length - p;
  if (rest % propCount) {
    throw new Error(`static prop lump v${sub.version}: ${rest} bytes will not divide into ${propCount} props`);
  }
  const stride = rest / propCount;
  if (stride < 36) throw new Error(`static prop record of ${stride} bytes is too short to read`);

  /* Uniform scale arrived in v11 and sits past everything v10 had. Older maps
     do not have it and their props are all built at their model's own size. */
  const scaleAt = sub.version >= 11 && stride >= 76 ? 72 : -1;

  const props = new Array(propCount);
  for (let i = 0; i < propCount; i++) {
    const o = p + i * stride;
    const type = dv.getUint16(o + 24, true);
    props[i] = {
      model: type < models.length ? models[type] : '',
      origin: {
        x: dv.getFloat32(o, true),
        y: dv.getFloat32(o + 4, true),
        z: dv.getFloat32(o + 8, true),
      },
      // a QAngle, in degrees, and in that order
      angles: {
        pitch: dv.getFloat32(o + 12, true),
        yaw: dv.getFloat32(o + 16, true),
        roll: dv.getFloat32(o + 20, true),
      },
      solid: buf[o + 30],
      skin: dv.getInt32(o + 32, true),
      scale: scaleAt >= 0 ? dv.getFloat32(o + scaleAt, true) : 1,
    };
  }

  return { models, props };
}
