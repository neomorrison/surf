/* The course, measured. Prints what each stage actually demands so the
   numbers in map.js can be argued with instead of guessed at. */
import './dom-stub.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { buildMap, MAP, airSections } from '../src/map.js';
import { RAMPS, SOLIDS, TRIGGERS } from '../src/physics.js';
import { MOVE } from '../src/config.js';

buildMap();

test('the map builds a coherent world', () => {
  assert.ok(RAMPS.length > 20, 'ramps: ' + RAMPS.length);
  assert.ok(SOLIDS.length > 5, 'solids: ' + SOLIDS.length);
  assert.equal(MAP.checkpoints.length, 4);
  assert.ok(MAP.finishPad);
  assert.ok(TRIGGERS.some(t => t.kind === 'start'));
  assert.ok(TRIGGERS.some(t => t.kind === 'finish'));
});

test('every surf ramp is genuinely un-standable', () => {
  const surf = RAMPS.filter(r => !r.walkable);
  assert.equal(surf.length, RAMPS.length, 'a walkable ramp would be a floor, not a slide');
  for (const r of surf) {
    assert.ok(r.n.y < MOVE.walkableNormalY, `ramp normal.y ${r.n.y}`);
    assert.ok(r.angle >= 46 && r.angle <= 72, `ramp angle ${r.angle}`);
  }
});

test('each stage has a kill floor below everything in it', () => {
  for (const s of MAP.stages) {
    if (s.name === 'FINISH') continue;
    assert.ok(Number.isFinite(s.floorY), s.name + ' has no floor');
  }
  for (const p of MAP.route) {
    const s = MAP.stages[p.stage];
    assert.ok(p.y > s.floorY, `${s.name}: ride point ${p.y.toFixed(0)} is under its own kill floor ${s.floorY.toFixed(0)}`);
  }
});

test('report: the course', () => {
  const b = MAP.bounds;
  console.log(`\n  ${MAP.name} — ${RAMPS.length} ramps, ${SOLIDS.length} solids, ${TRIGGERS.length} triggers`);
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
  console.log('\n  air section    stage             span     drop     needs');
  for (const a of airSections()) {
    console.log(`  ${''.padEnd(13)}  ${MAP.stages[a.stage].name.padEnd(12)} ${a.span.toFixed(0).padStart(7)} ` +
      `${a.drop.toFixed(0).padStart(8)} ${a.need.toFixed(0).padStart(8)} u/s`);
  }
  console.log('');
});
