/* ============================== [MAP EDITS TESTS] ==============================
   A patch has one job: put the volumes back exactly where the editor had them.

   If it does not, the map you fixed in the editor and the map that loads for
   everyone else are different maps, and nothing anywhere says so. That is the
   whole risk in keeping corrections beside a map instead of inside it, so it
   is what these test.                                                        */
import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, volumeKeys, volumeToJson, emptyEdits } from '../src/mapedits.js';

const box = (kind, x, y, z, w = 100, h = 50, d = 100, extra = {}) => ({
  minX: x - w / 2, maxX: x + w / 2,
  minY: y, maxY: y + h,
  minZ: z - d / 2, maxZ: z + d / 2,
  data: { kind, ...extra },
});

const course = () => ({
  triggers: [
    box('start', 0, 0, 0),
    box('finish', 1000, 0, 0),
    box('teleport', 500, -200, 0, 200, 100, 200, { tx: 0, ty: 0, tz: 0, tyaw: 1.5 }),
    box('kill', 700, -400, 0),
  ],
  finishPad: { x: 1000, y: 0, z: 0 },
  prespeed: null,
  stats: { timed: true },
});

test('a volume is named by what it is and where its middle is', () => {
  const keys = volumeKeys(course().triggers);
  assert.deepEqual(keys, ['start@0,25,0', 'finish@1000,25,0', 'teleport@500,-150,0', 'kill@700,-375,0']);
});

test('two volumes with the same middle are told apart', () => {
  const keys = volumeKeys([box('kill', 5, 5, 5), box('kill', 5, 5, 5), box('kill', 9, 9, 9)]);
  assert.deepEqual(keys, ['kill@5,30,5', 'kill@5,30,5#2', 'kill@9,34,9']);
});

test('no patch leaves the course alone, but names every volume', () => {
  const c = course();
  applyEdits(c, null);
  assert.equal(c.triggers.length, 4);
  assert.equal(c.triggers[0].data.origin, 'start@0,25,0');
  assert.equal(c.triggers[3].data.origin, 'kill@700,-375,0');
});

test('a disabled volume is gone', () => {
  const c = course();
  applyEdits(c, { ...emptyEdits('x'), disable: ['teleport@500,-150,0'] });
  assert.equal(c.triggers.length, 3);
  assert.ok(!c.triggers.some(v => v.data.kind === 'teleport'), 'the teleport is not there');
});

test('a replaced volume takes the new box and keeps its name', () => {
  const c = course();
  applyEdits(c, {
    ...emptyEdits('x'),
    replace: { 'kill@700,-375,0': { kind: 'kill', minX: 1, maxX: 2, minY: 3, maxY: 4, minZ: 5, maxZ: 6 } },
  });
  const k = c.triggers.find(v => v.data.kind === 'kill');
  assert.deepEqual([k.minX, k.maxX, k.minY, k.maxY, k.minZ, k.maxZ], [1, 2, 3, 4, 5, 6]);
  assert.equal(k.data.origin, 'kill@700,-375,0', 'it is still the volume it started as');
});

test('a teleport keeps where it sends you when only its box is replaced', () => {
  const c = course();
  applyEdits(c, {
    ...emptyEdits('x'),
    replace: { 'teleport@500,-150,0': { kind: 'teleport', minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 } },
  });
  const t = c.triggers.find(v => v.data.kind === 'teleport');
  assert.equal(t.data.tx, 0);
  assert.equal(t.data.tyaw, 1.5);
});

test('an added zone goes on the end, so the map keeps its firing order', () => {
  const c = course();
  applyEdits(c, {
    ...emptyEdits('x'),
    add: [{ kind: 'start', minX: -10, maxX: 10, minY: 0, maxY: 20, minZ: -10, maxZ: 10 }],
  });
  assert.equal(c.triggers.length, 5);
  assert.equal(c.triggers[4].data.kind, 'start');
  assert.equal(c.triggers[4].data.origin, null, 'an added zone is ours, not the map’s');
});

test('an untimed map becomes timed when a start and a finish are added', () => {
  const c = { triggers: [], finishPad: null, prespeed: null, stats: { timed: false } };
  assert.equal(c.stats.timed, false);
  applyEdits(c, {
    ...emptyEdits('x'),
    add: [
      { kind: 'start', minX: -10, maxX: 10, minY: 0, maxY: 20, minZ: -10, maxZ: 10 },
      { kind: 'finish', minX: 90, maxX: 110, minY: 0, maxY: 20, minZ: -10, maxZ: 10 },
    ],
  });
  assert.equal(c.stats.timed, true);
  assert.deepEqual(c.finishPad, { x: 100, y: 0, z: 0 }, 'the finish effect needs somewhere to play');
  assert.ok(c.prespeed, 'and the start line carries the prespeed cap');
  assert.equal(c.prespeed.minX, -74, 'which reaches 64 units beyond it');
});

test('the prespeed zone follows a start that has moved', () => {
  const c = course();
  applyEdits(c, {
    ...emptyEdits('x'),
    replace: { 'start@0,25,0': { kind: 'start', minX: 500, maxX: 600, minY: 0, maxY: 50, minZ: 0, maxZ: 100 } },
  });
  assert.equal(c.prespeed.minX, 436);
  assert.equal(c.prespeed.maxX, 664);
});

test('a course edited and then patched from its own edits comes back the same', () => {
  /* This is the editor's round trip: take a course, change it the way the
     editor does, derive a patch from the result, apply that patch to a fresh
     copy, and land on the same volumes. */
  const original = course();
  const originalKeys = volumeKeys(original.triggers);

  // what the editor holds after: move the finish, drop the kill, add a start
  const edited = [
    { ...original.triggers[0], data: { ...original.triggers[0].data, origin: originalKeys[0] } },
    { ...original.triggers[1], minX: 1050, maxX: 1150, data: { ...original.triggers[1].data, origin: originalKeys[1] } },
    { ...original.triggers[2], data: { ...original.triggers[2].data, origin: originalKeys[2] } },
    { ...box('start', 400, 10, 400), data: { kind: 'start', origin: null } },
  ];

  // the patch the editor derives from that
  const patch = emptyEdits('x');
  const seen = new Set();
  for (const v of edited) {
    if (v.data.origin) {
      seen.add(v.data.origin);
      const i = originalKeys.indexOf(v.data.origin);
      if (JSON.stringify(volumeToJson(original.triggers[i])) !== JSON.stringify(volumeToJson(v))) {
        patch.replace[v.data.origin] = volumeToJson(v);
      }
    } else {
      patch.add.push(volumeToJson(v));
    }
  }
  for (const k of originalKeys) if (!seen.has(k)) patch.disable.push(k);

  assert.deepEqual(patch.disable, ['kill@700,-375,0']);
  assert.deepEqual(Object.keys(patch.replace), ['finish@1000,25,0']);
  assert.equal(patch.add.length, 1);

  // apply it to a fresh course and compare
  const fresh = course();
  applyEdits(fresh, patch);
  const shape = v => `${v.data.kind}|${v.minX},${v.minY},${v.minZ},${v.maxX},${v.maxY},${v.maxZ}`;
  assert.deepEqual(fresh.triggers.map(shape), edited.map(shape));
});
