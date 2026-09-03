#!/usr/bin/env node
/* ============================== [PACK MAP] ==============================
   Turn a .bsp into the packed course the web build ships.

     node tools/pack-map.mjs local/maps/surf_summer.bsp maps/
     node tools/pack-map.mjs local/maps/*.bsp maps/

   The .bsp itself never leaves the machine it is on. What comes out is the
   tenth of it the game actually reads — brush planes, triangles, the images
   those triangles wear, and the volumes that run the clock — which is small
   enough to serve off a static host. See src/maps/smap.js for the format.

   This runs the same `extractCourse` the browser runs when it opens a .bsp
   directly, so a packed map is not a second version of the map: it is the
   same extraction, done once, ahead of time.                                */
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { readBsp } from '../src/bsp.js';
import { resolveTexture, parseVtf } from '../src/vtfread.js';
import { extractCourse } from '../src/maps/bspextract.js';
import { encodeSmap } from '../src/maps/smap.js';
import { unpackEntry } from './pakdecode.mjs';

const MB = n => (n / 1048576).toFixed(2) + ' MB';

/** A material name, followed through its patch/include chain to its pixels. */
function pakResolver(bsp) {
  const pak = bsp.pakfile(unpackEntry);
  return name => {
    const res = resolveTexture(pak, name);
    if (!res) return null;
    const raw = pak.get(res.path);
    const vtf = raw && parseVtf(raw);
    if (!vtf) return null;
    return {
      path: res.path, width: vtf.width, height: vtf.height,
      format: vtf.format, data: vtf.data, translucent: res.translucent,
    };
  };
}

async function pack(bspPath, outDir) {
  const raw = readFileSync(bspPath);
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const bsp = readBsp(buffer);

  const course = extractCourse(bsp, pakResolver(bsp));
  const packed = await encodeSmap(course);

  const name = basename(bspPath, extname(bspPath));
  const out = join(outDir, name + '.smap');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, packed);

  const before = statSync(bspPath).size;
  const s = course.stats;
  console.log(`${name}`);
  console.log(`  ${MB(before)} -> ${MB(packed.length)}  (${(packed.length / before * 100).toFixed(1)}%)`);
  console.log(`  ${course.brushes.length} brushes, ${course.groups.length} meshes, ` +
    `${course.images.length} images, ${s.displacementTris} terrain tris`);
  console.log(`  ${s.resolvedMaterials}/${s.namedMaterials} materials resolved to a texture` +
    (s.resolvedMaterials < s.namedMaterials / 2 ? '  — this map will draw mostly untextured' : ''));
  console.log(`  ${course.spawns.length} spawns, ${course.triggers.length} volumes, ` +
    `${s.teleports} teleports, ${s.pits} pits` + (s.timed ? '' : ', NOT TIMED'));
  if (!s.timed) console.log(`  ! no start/finish zone found — this map will play untimed`);
  return { name, before, after: packed.length };
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node tools/pack-map.mjs <map.bsp> [more.bsp ...] <outdir>');
  process.exit(2);
}
const outDir = args.pop();
const done = [];
for (const p of args) done.push(await pack(p, outDir));

if (done.length > 1) {
  const before = done.reduce((a, d) => a + d.before, 0);
  const after = done.reduce((a, d) => a + d.after, 0);
  console.log(`\n${done.length} maps: ${MB(before)} -> ${MB(after)}  (${(after / before * 100).toFixed(1)}%)`);
}
