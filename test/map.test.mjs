/* Both courses, measured. Prints what each one actually demands so the
   numbers in src/maps/ can be argued with instead of guessed at. */
import './dom-stub.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { buildMap, MAP, MAPS, airSections } from '../src/map.js';
import { RAMPS, SOLIDS, TRIGGERS } from '../src/physics.js';
import { MOVE, RULES } from '../src/config.js';

const IDS = MAPS.map(m => m.id);

test('every course builds a coherent world', () => {
  for (const id of IDS) {
    buildMap(id);
    assert.ok(RAMPS.length >= 6, `${id}: ramps ${RAMPS.length}`);
    assert.ok(SOLIDS.length > 5, `${id}: solids ${SOLIDS.length}`);
    assert.ok(MAP.finishPad, id + ': no finish pad');
    assert.ok(TRIGGERS.some(t => t.kind === 'start'), id + ': no start gate');
    assert.ok(TRIGGERS.some(t => t.kind === 'finish'), id + ': no finish zone');
    assert.ok(MAP.stages.length >= 3, id + ': needs START, a stage and FINISH');
  }
});

test('every surf ramp on every course is genuinely un-standable', () => {
  for (const id of IDS) {
    buildMap(id);
    for (const r of RAMPS) {
      assert.ok(!r.walkable, `${id}: a walkable ramp would be a floor, not a slide`);
      assert.ok(r.n.y < MOVE.walkableNormalY, `${id}: ramp normal.y ${r.n.y}`);
      assert.ok(r.angle >= 46 && r.angle <= 72, `${id}: ramp angle ${r.angle}`);
    }
  }
});

test('nothing on the ride line sits under its own kill height', () => {
  for (const id of IDS) {
    buildMap(id);
    const slabs = TRIGGERS.filter(t => t.kind === 'kill');
    for (const p of MAP.route) {
      const s = MAP.stages[p.stage];
      assert.ok(Number.isFinite(s.floorY), `${id}/${s.name}: no floor`);
      assert.ok(p.y > s.floorY, `${id}/${s.name}: ride point ${p.y.toFixed(0)} under floor ${s.floorY.toFixed(0)}`);
      for (const k of slabs) {
        const inside = p.x > k.minX && p.x < k.maxX && p.z > k.minZ && p.z < k.maxZ
          && p.y > k.minY && p.y < k.maxY;
        assert.ok(!inside, `${id}: a kill slab swallows a ride point at y=${p.y.toFixed(0)}`);
      }
    }
  }
});

test('every course plays by the same movement rules', () => {
  assert.equal(RULES.bunnyhopping, false, 'sv_enablebunnyhopping 0 everywhere');
  assert.equal(RULES.prespeedCap, 350);
  for (const id of IDS) {
    buildMap(id);
    assert.equal(MAP.prespeed, RULES.prespeedCap, id + ': prespeed is not the global cap');
  }
});

test("every course's prespeed zone reaches its first ramp — it cannot leak", () => {
  for (const id of IDS) {
    buildMap(id);
    const pre = TRIGGERS.filter(t => t.kind === 'prespeed');
    assert.equal(pre.length, 1, id + ': exactly one prespeed zone');
    const z = pre[0];
    assert.equal(z.cap, RULES.prespeedCap);

    const inside = (x, y, zz) => x > z.minX && x < z.maxX && zz > z.minZ && zz < z.maxZ
      && y >= z.minY && y < z.maxY;
    assert.ok(inside(MAP.spawn.x, MAP.spawn.y, MAP.spawn.z), id + ': the spawn is not in the zone');

    // A cap that stops short of the first face is worth nothing — the gap
    // between is free air, and a perfect strafe turns it back into speed.
    const first = MAP.route[0];
    assert.ok(inside(first.x, first.y, first.z),
      `${id}: the zone stops before the first ride point at ${first.x.toFixed(0)},${first.y.toFixed(0)}`);

    const gate = TRIGGERS.find(t => t.kind === 'start');
    assert.ok(z.minX <= gate.minX && z.maxX >= gate.maxX, id + ': the zone does not span the start gate');
  }
});

test('surf_aircontrol is one shot, with kill volumes instead of checkpoints', () => {
  buildMap('aircontrol');
  assert.equal(MAP.oneShot, true);
  assert.equal(MAP.checkpoints.length, 0);
  assert.ok(TRIGGERS.some(t => t.kind === 'kill'), 'a one-shot map needs kill volumes');
});

test('surf_aircontrol starts you right next to the first ramp', () => {
  buildMap('aircontrol');
  const first = MAP.route.find(p => p.kind === 'ramp');
  const gate = TRIGGERS.find(t => t.kind === 'start');
  const along = first.x - gate.maxX;
  const below = -first.y;
  assert.ok(along > 0 && along < 400, `the face is ${along.toFixed(0)} units past the gate`);
  assert.ok(below > 0 && below < 400, `and ${below.toFixed(0)} units below the lip`);
});

test('surf_helix keeps its checkpoints', () => {
  buildMap('helix');
  assert.equal(MAP.checkpoints.length, 4);
  assert.equal(MAP.oneShot, false);
});

test('report: the courses', () => {
  for (const id of IDS) {
    buildMap(id);
    const b = MAP.bounds;
    console.log(`\n  ${MAP.name} — ${RAMPS.length} ramps, ${SOLIDS.length} solids, ` +
      `${TRIGGERS.length} triggers, ${MAP.checkpoints.length} checkpoints`);
    console.log(`  ${MAP.blurb}`);
    console.log(`  bounds  X ${b.minX.toFixed(0)}..${b.maxX.toFixed(0)}   Z ${b.minZ.toFixed(0)}..${b.maxZ.toFixed(0)}   Y ${b.minY.toFixed(0)}..${b.maxY.toFixed(0)}`);
    console.log('\n  stage          ramps   angles      enters at   leaves at   kill floor');
    for (const s of MAP.stages) {
      const pts = MAP.route.filter(p => p.stage === s.i);
      if (!pts.length) continue;
      const mine = RAMPS.filter(r => r.tag === String(s.i));
      const angles = [...new Set(mine.map(r => Math.round(r.angle)))].sort((x, y) => x - y).join('/');
      console.log(`  ${s.name.padEnd(13)} ${String(mine.length).padStart(5)}   ${(angles || '-').padEnd(9)} ` +
        `${pts[0].y.toFixed(0).padStart(9)} ${pts[pts.length - 1].y.toFixed(0).padStart(11)} ${s.floorY.toFixed(0).padStart(12)}`);
    }
    const air = airSections();
    if (air.length) {
      console.log('\n  flight    span   sideways    drop    needs');
      for (const a of air) {
        console.log(`  ${''.padEnd(6)} ${a.span.toFixed(0).padStart(6)} ${a.lateral.toFixed(0).padStart(10)} ` +
          `${a.drop.toFixed(0).padStart(7)} ${a.need.toFixed(0).padStart(8)} u/s`);
      }
    }
    console.log('');
  }
});
