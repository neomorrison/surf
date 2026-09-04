#!/usr/bin/env node
/* ============================== [VERIFY MAPS] ==============================
   Prove a packed map is the map.

     npm run verify-maps

   For every packed map in maps/ that still has its .bsp in local/maps/, this
   builds the course twice — once from the .bsp, once from the packed file —
   and compares the live result: the settled spawn, the stages, the route, the
   trigger volumes and their order, the brush count, the bounds, the stats.
   Anything the packer dropped or reordered shows up here as a difference.

   It needs the .bsp files, so it only runs on a machine that has them; that
   is why it is a tool and not a test. The format's own round trip is covered
   by test/smap.test.mjs, which needs nothing.

   Run it with the headless harness, which resolves three.js to the test stub:

     node --import ./test/register.mjs tools/verify-maps.mjs                  */
import '../test/dom-stub.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { readBsp } from '../src/bsp.js';
import { extractCourse } from '../src/maps/bspextract.js';
import { resolveTexture, parseVtf } from '../src/vtfread.js';
import { decodeSmap } from '../src/maps/smap.js';
import { buildCourse } from '../src/maps/coursebuild.js';
import { maps as packedMaps } from '../src/maps/packed.js';
import { unpackEntry } from './pakdecode.mjs';
import { readProps } from './propgeom.mjs';
import { MAP } from '../src/mapkit.js';
import { BRUSHES, TRIGGERS, TRIS } from '../src/physics.js';

const meta = { id: 'verify', name: 'Verify', blurb: '', stageName: 'RUN', hint: 'Start to finish.' };

/** Everything about a built course that a packed file has to reproduce. */
const snapshot = () => ({
  spawn: { ...MAP.spawn },
  spawnNote: MAP.spawnNote,
  bounds: { ...MAP.bounds },
  finishPad: MAP.finishPad ? { ...MAP.finishPad } : null,
  prespeed: MAP.prespeed,
  oneShot: MAP.oneShot,
  stages: MAP.stages.map(s => ({ i: s.i, name: s.name, floorY: s.floorY })),
  route: MAP.route.map(r => ({ ...r })),
  stats: { ...MAP.stats },
  brushes: BRUSHES.length,
  brushPlanes: BRUSHES.reduce((a, b) => a + b.planes.length, 0),
  walkable: BRUSHES.filter(b => b.walkable).length,
  triangles: TRIS && TRIS.xyz ? TRIS.xyz.length : 0,
  /* The whole box AND the shape inside it. A volume's planes are what decide
     whether it fires, so comparing only the corner it starts at would let a
     packed map differ from its .bsp in the one field that matters most. */
  triggers: TRIGGERS.map(t =>
    `${t.kind}@${t.minX},${t.minY},${t.minZ},${t.maxX},${t.maxY},${t.maxZ}` +
    `|${(t.planes || []).map(p => `${p.x},${p.y},${p.z},${p.d}`).join(';')}`),
  triggerPlanes: TRIGGERS.reduce((a, t) => a + (t.planes ? t.planes.length : 0), 0),
});

const arg = process.argv.slice(2);
const wanted = arg.length ? packedMaps.filter(m => arg.some(a => m.id === a || m.url.includes(a))) : packedMaps;

let checked = 0, failed = 0, skipped = 0;
for (const m of wanted) {
  const file = m.url.replace(/^maps\//, '').replace(/\.smap$/, '');
  const bspPath = `local/maps/${file}.bsp`;
  if (!existsSync(bspPath)) {
    console.log(`${file}: no .bsp here — skipped`);
    skipped++;
    continue;
  }

  const raw = readFileSync(bspPath);
  const bsp = readBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  /* The same reader the packer used, compressed materials and all. Reading the
     .bsp any other way compares the packed map against a different map. */
  const pak = bsp.pakfile(unpackEntry);
  const resolve = (name, cap) => {
    const res = resolveTexture(pak, name);
    if (!res) return null;
    const raw2 = pak.get(res.path);
    const vtf = raw2 && parseVtf(raw2, cap);
    if (!vtf) return null;
    return { path: res.path, width: vtf.width, height: vtf.height,
             format: vtf.format, data: vtf.data, translucent: res.translucent };
  };
  buildCourse(extractCourse(bsp, resolve, b => readProps(b, pak)), meta);
  const fromBsp = snapshot();

  const packed = readFileSync(m.url);
  buildCourse(await decodeSmap(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)), meta);
  const fromPacked = snapshot();

  const diffs = [];
  for (const k of Object.keys(fromBsp)) {
    if (JSON.stringify(fromBsp[k]) !== JSON.stringify(fromPacked[k])) diffs.push(k);
  }

  checked++;
  if (diffs.length) {
    failed++;
    console.log(`${file}: DIFFERS in ${diffs.join(', ')}`);
    for (const k of diffs) {
      console.log(`    .bsp    ${JSON.stringify(fromBsp[k]).slice(0, 200)}`);
      console.log(`    packed  ${JSON.stringify(fromPacked[k]).slice(0, 200)}`);
    }
  } else {
    console.log(`${file}: identical — ${fromBsp.brushes} brushes, ${fromBsp.triggers.length} volumes, ` +
      `spawn ${fromBsp.spawnNote}${fromBsp.stats.timed ? '' : ', UNTIMED'}`);
  }
}

console.log(`\n${checked} checked, ${failed} differing, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
