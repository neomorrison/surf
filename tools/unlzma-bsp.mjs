#!/usr/bin/env node
/* ============================== [UNLZMA BSP] ==============================
   Rewrite a .bsp with its lumps uncompressed.

     node tools/unlzma-bsp.mjs boreas.bsp local/maps/surf_boreas.bsp

   Source can store any lump LZMA-compressed, and plenty of maps in the wild
   are shipped that way — bspzip does it, and so do most of the tools people
   repack maps with. src/bsp.js does not decompress: it is the reader the game
   loads maps through, in a browser, and an LZMA decoder is a lot of code to
   ship to everyone for a case that can be dealt with once, here, offline.

   A compressed lump is Valve's lzma_header_t — 'LZMA', the uncompressed size,
   the compressed size, then five property bytes — followed by raw LZMA1. Those
   five bytes are exactly the first five of an lzma-alone header, so adding the
   eight-byte size that format wants makes a stream `xz` will read, and xz is
   the one dependency here. There is no LZMA in node.

   What comes out is a plain .bsp: same lumps, same contents, no compression.  */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HEADER = 1036;                    // ident + version + 64 lumps + revision
const LZMA_ID = 0x414d5a4c;             // 'LZMA', little-endian
const GAME_LUMP = 35;

const MB = n => (n / 1048576).toFixed(2) + ' MB';

function haveXz() {
  try { execFileSync('xz', ['--version'], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

/** One Valve-compressed lump, as bytes. */
function inflateLump(raw, ofs) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(ofs, true) !== LZMA_ID) {
    throw new Error(`lump at ${ofs} is marked compressed but has no LZMA header`);
  }
  const actual = dv.getUint32(ofs + 4, true);
  const lzmaSize = dv.getUint32(ofs + 8, true);

  // lzma-alone: 5 property bytes, then the uncompressed size as 64-bit LE
  const alone = Buffer.alloc(13 + lzmaSize);
  raw.copy(alone, 0, ofs + 12, ofs + 17);
  alone.writeUInt32LE(actual, 5);
  alone.writeUInt32LE(0, 9);
  raw.copy(alone, 13, ofs + 17, ofs + 17 + lzmaSize);

  const out = execFileSync('xz', ['--format=lzma', '--decompress', '--stdout'], {
    input: alone, maxBuffer: 1 << 30,
  });
  if (out.length !== actual) {
    throw new Error(`lump at ${ofs}: header says ${actual} bytes, got ${out.length}`);
  }
  return out;
}

export function decompressBsp(raw) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0, true) !== 0x50534256) throw new Error('not a VBSP file');

  const lumps = [];
  for (let i = 0; i < 64; i++) {
    const o = 8 + i * 16;
    lumps.push({
      ofs: dv.getInt32(o, true), len: dv.getInt32(o + 4, true),
      version: dv.getInt32(o + 8, true), fourCC: dv.getInt32(o + 12, true),
    });
  }

  let compressed = 0;
  const bodies = lumps.map(l => {
    if (!l.len) return null;
    if (l.fourCC === 0) return raw.subarray(l.ofs, l.ofs + l.len);
    compressed++;
    return inflateLump(raw, l.ofs);
  });

  // lay them out in lump order, four-byte aligned, the way the compiler does
  let at = HEADER;
  const placed = bodies.map(b => {
    if (!b) return { ofs: 0, len: 0 };
    at = (at + 3) & ~3;
    const p = { ofs: at, len: b.length };
    at += b.length;
    return p;
  });

  const out = Buffer.alloc(at);
  raw.copy(out, 0, 0, HEADER);
  const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < 64; i++) {
    const o = 8 + i * 16;
    odv.setInt32(o, placed[i].ofs, true);
    odv.setInt32(o + 4, placed[i].len, true);
    odv.setInt32(o + 8, lumps[i].version, true);
    odv.setInt32(o + 12, 0, true);                  // no longer compressed
    if (bodies[i]) Buffer.from(bodies[i]).copy(out, placed[i].ofs);
  }

  /* The game lump holds absolute file offsets to its own sub-lumps, and those
     payloads are not necessarily inside it: surf_boreas's game lump is 36 KB
     and its static prop sub-lump alone is 123 KB, sitting elsewhere in the
     file entirely. So they cannot be fixed up by shifting them along with the
     game lump — that was the first thing tried here and it silently produced
     a file whose prop lump pointed at nothing. They are relocated the same way
     every other lump is: copied to the end, and pointed at.

     They are copied as they are, compressed or not. A sub-lump can be LZMA
     too, and unpacking one would change the size the game lump's directory
     records — this pass makes a file readable, not a different file. */
  const g = placed[GAME_LUMP];
  if (g.len >= 4 && bodies[GAME_LUMP]) {
    const count = odv.getInt32(g.ofs, true);
    const tail = [];
    let end = out.length;
    for (let i = 0; i < count; i++) {
      const e = g.ofs + 4 + i * 16;
      if (e + 16 > g.ofs + g.len) break;
      const sofs = odv.getInt32(e + 8, true), slen = odv.getInt32(e + 12, true);
      if (slen <= 0 || sofs <= 0 || sofs + slen > raw.length) continue;
      end = (end + 3) & ~3;
      tail.push({ e, at: end, bytes: raw.subarray(sofs, sofs + slen) });
      end += slen;
    }
    if (tail.length) {
      const grown = Buffer.alloc(end);
      out.copy(grown, 0);
      const gdv = new DataView(grown.buffer, grown.byteOffset, grown.byteLength);
      for (const t of tail) {
        Buffer.from(t.bytes).copy(grown, t.at);
        gdv.setInt32(t.e + 8, t.at, true);
      }
      return { out: grown, compressed };
    }
  }

  return { out, compressed };
}

/* ---------------- run it ---------------- */

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node tools/unlzma-bsp.mjs <in.bsp> <out.bsp>');
  process.exit(2);
}
if (!haveXz()) {
  console.error('this needs xz on PATH, and there is no LZMA in node.\n' +
    '  macOS:  brew install xz\n' +
    '  debian: apt install xz-utils');
  process.exit(1);
}

const raw = readFileSync(src);
const { out, compressed } = decompressBsp(raw);
writeFileSync(dst, out);
console.log(`${src} -> ${dst}`);
console.log(`  ${compressed} compressed lumps, ${MB(statSync(src).size)} -> ${MB(out.length)}`);
