/* ============================== [SMAP TESTS] ==============================
   The packed map format, and the packed maps this repository ships.

   The round trip is the whole correctness claim: a course that goes into a
   packed file has to come back out of it unchanged, or a map plays differently
   from the .bsp it was made from and nothing says so. It is checked here on a
   synthetic course, so the test needs no .bsp and no network — the real maps
   are checked against their .bsp by tools/verify-maps.mjs, which needs both. */
import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { encodeSmap, decodeSmap, readSmapHeader, VERSION } from '../src/maps/smap.js';
import { maps as packedMaps } from '../src/maps/packed.js';

/** A course with one of everything, including a shared vertex and a repeat. */
function sampleCourse() {
  // two triangles sharing an edge: six corners, four distinct vertices
  const pos = [
    0, 0, 0, 100, 0, 0, 0, 0, 100,
    100, 0, 0, 100, 0, 100, 0, 0, 100,
  ];
  const uv = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];
  // a value above 1: Source luxels carry a shared exponent and routinely exceed it
  const light = [
    0.5, 0.5, 0.5, 3.25, 1, 0.125, 0.5, 0.5, 0.5,
    3.25, 1, 0.125, 0.75, 0.75, 0.75, 0.5, 0.5, 0.5,
  ];
  return {
    bounds: { minX: -1, maxX: 101, minY: -2, maxY: 3, minZ: -1, maxZ: 101 },
    spawns: [{ x: 1, y: 2, z: 3, yaw: -1.5707963267948966 }, { x: 4, y: 5, z: 6, yaw: 0 }],
    brushes: [
      [{ x: 1, y: 0, z: 0, d: 64 }, { x: -1, y: 0, z: 0, d: 64 }, { x: 0, y: 1, z: 0, d: 8 }, { x: 0, y: -1, z: 0, d: 8 }],
      [{ x: 0, y: 0, z: 1, d: 32 }, { x: 0, y: 0, z: -1, d: 32 }, { x: 0, y: 1, z: 0, d: 4 }, { x: 0, y: -1, z: 0, d: 4 }, { x: 1, y: 0, z: 0, d: 9 }],
    ],
    groups: [{ material: 'concrete/wall01', image: 0, pos, uv, light }],
    images: [{
      path: 'materials/concrete/wall01.vtf', width: 4, height: 4,
      format: 'DXT1', translucent: false, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    }],
    terrain: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    triggers: [
      { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1, data: { kind: 'start' } },
      { minX: 9, maxX: 10, minY: 0, maxY: 1, minZ: 0, maxZ: 1, data: { kind: 'teleport', tx: 5, ty: 6, tz: 7, tyaw: 1.25 } },
    ],
    prespeed: { minX: -64, maxX: 65, minY: -64, maxY: 513, minZ: -64, maxZ: 65 },
    finishPad: { x: 9.5, y: 0, z: 0.5 },
    env: { dir: { x: 0.1, y: -0.9, z: 0.2 }, sun: { r: 1, g: 0.9, b: 0.8, i: 400 }, ambient: { r: 0.2, g: 0.2, b: 0.3, i: 120 } },
    stats: { faces: 12, drawn: 10, timed: true, startZone: 'start_trigger', endZone: 'end_trigger' },
  };
}

test('a packed course comes back out exactly as it went in', async () => {
  const a = sampleCourse();
  const bytes = await encodeSmap(a);
  const b = await decodeSmap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  assert.deepEqual(b.bounds, a.bounds);
  assert.deepEqual(b.spawns, a.spawns);
  assert.deepEqual(b.triggers, a.triggers);
  assert.deepEqual(b.prespeed, a.prespeed);
  assert.deepEqual(b.finishPad, a.finishPad);
  assert.deepEqual(b.env, a.env);
  assert.deepEqual(b.stats, a.stats);

  assert.equal(b.brushes.length, a.brushes.length);
  for (let i = 0; i < a.brushes.length; i++) assert.deepEqual(b.brushes[i], a.brushes[i]);

  assert.equal(b.groups.length, 1);
  assert.equal(b.groups[0].material, 'concrete/wall01');
  assert.equal(b.groups[0].image, 0);
  assert.deepEqual([...b.groups[0].pos], a.groups[0].pos);
  assert.deepEqual([...b.groups[0].uv], a.groups[0].uv);
  assert.deepEqual([...b.groups[0].terrain || []], []);
  assert.deepEqual([...b.terrain], [...a.terrain]);

  const img = b.images[0];
  assert.equal(img.path, a.images[0].path);
  assert.equal(img.width, 4);
  assert.equal(img.format, 'DXT1');
  assert.deepEqual([...img.data], [...a.images[0].data]);
});

test('a light value above 1 survives — Source luxels are not clamped to it', async () => {
  const a = sampleCourse();
  const bytes = await encodeSmap(a);
  const b = await decodeSmap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.deepEqual([...b.groups[0].light], a.groups[0].light);
  assert.ok(Math.max(...b.groups[0].light) > 3, 'the 3.25 luxel is still 3.25');
});

test('shared vertices are stored once and drawn twice', async () => {
  const a = sampleCourse();
  const bytes = await encodeSmap(a);
  const { header } = readSmapHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const g = header.groups[0];
  assert.equal(g.idxCount, 6, 'six corners went in');
  assert.equal(g.vertCount, 4, 'two of them were the same vertex twice');
});

test('a file that is not a packed map is refused rather than misread', () => {
  const junk = new Uint8Array(64);
  assert.throws(() => readSmapHeader(junk.buffer), /not a packed map/);
  assert.throws(() => readSmapHeader(new Uint8Array(4).buffer), /too short/);
});

test('every packed map this repository ships is readable and the right size', () => {
  for (const m of packedMaps) {
    const path = m.url;
    const size = statSync(path).size;
    assert.equal(size, m.bytes, `${m.id}: packed.js says ${m.bytes} bytes, ${path} is ${size}`);

    const raw = readFileSync(path);
    const { header } = readSmapHeader(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    assert.equal(header.version, VERSION);
    assert.ok(header.groups.length > 0, `${m.id} has no meshes`);
    assert.ok(header.spawns.length > 0, `${m.id} has nowhere to spawn`);
    assert.ok(header.bounds && header.bounds.maxX > header.bounds.minX, `${m.id} has no bounds`);
    for (const g of header.groups) {
      assert.equal(g.idxCount % 3, 0, `${m.id}: mesh ${g.material} is not whole triangles`);
    }
  }
});
