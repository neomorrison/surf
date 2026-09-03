/* ============================== [PAK DECODE] ==============================
   Reading a map's packed materials when they are compressed.

   src/bsp.js reads stored zip entries and nothing else, on purpose: it is the
   reader the game loads maps through in a browser, and a decompressor is a lot
   of code to ship to everyone for a case that can be handled once, offline.
   So it takes an optional decoder, and this is the one the tools pass.

   Two methods turn up in the wild. 8 is deflate, which node does. 14 is LZMA,
   which it does not — surf_boreas packs all 1929 of its entries that way, its
   117 textures included, and without this the map draws flat grey.           */
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

/**
 * One compressed pakfile entry, or null if it cannot be read.
 *
 * Null rather than throwing: a map with one unreadable material should lose
 * that material, not fail to load. The count that matters — how many of a
 * map's materials resolved — is reported by the packer either way.
 */
export function unpackEntry(body, method, size) {
  try {
    if (method === 8) return inflateRawSync(body);
    if (method === 14) {
      /* A zip LZMA entry opens with an SDK version and a property length, then
         the properties — which are the first five bytes of an lzma-alone
         header once the uncompressed size is appended. */
      const propsLen = body[2] | (body[3] << 8);
      const alone = Buffer.alloc(13 + (body.length - 4 - propsLen));
      Buffer.from(body.subarray(4, 4 + propsLen)).copy(alone, 0, 0, 5);
      alone.writeUInt32LE(size, 5);
      alone.writeUInt32LE(0, 9);
      Buffer.from(body.subarray(4 + propsLen)).copy(alone, 13);
      const out = execFileSync('xz', ['--format=lzma', '--decompress', '--stdout'],
        { input: alone, maxBuffer: 1 << 30 });
      return out.length === size ? out : null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

/** Is xz on PATH? Without it, LZMA-packed materials cannot be read. */
export function haveXz() {
  try { execFileSync('xz', ['--version'], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
