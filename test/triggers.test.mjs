/* ============================== [TRIGGER TESTS] ==============================
   A trigger brush is a brush, and brushes are diagonal.

   A trigger_teleport in a real surf map is routinely a thin slab laid across a
   corner or a wedge following a ramp. Reduced to its bounding box it becomes a
   solid lump of the room — measured across the six maps in maps/, between 28%
   and 87% of the space inside a teleport's box is not inside the teleport —
   and every bit of that lump throws the player back to the start.

   So a volume keeps its planes, and the box is only the broadphase. These
   check that the shape is what decides.                                     */
import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS, trigger, triggersAt, plane } from '../src/physics.js';
import { MOVE } from '../src/config.js';

const R = MOVE.radius, H = MOVE.standHeight;
const clear = () => { TRIGGERS.length = 0; };
const at = (x, y, z) => triggersAt({ x, y, z }, R, H, []);

/**
 * A slab through the origin, tilted 45 degrees in the XZ plane.
 *
 * Its bounding box is the whole square it is drawn across; the slab itself is
 * a thin diagonal band through the middle of it. The two corners of that box
 * either side of the band are the false-teleport bug.
 */
function diagonalSlab(half = 40, extent = 1000, y0 = -100, y1 = 100) {
  const k = Math.SQRT1_2;
  return [
    plane(k, 0, k, half),        // the two faces of the band
    plane(-k, 0, -k, half),
    plane(1, 0, -1, extent),     // and the ends, so it is bounded
    plane(-1, 0, 1, extent),
    plane(0, 1, 0, y1),
    plane(0, -1, 0, -y0),
  ];
}

test('a volume with no planes is its box, exactly as before', () => {
  clear();
  trigger(-100, 100, 0, 100, -100, 100, { kind: 'kill' });
  assert.equal(at(0, 10, 0).length, 1);
  assert.equal(at(400, 10, 0).length, 0);
});

test('the box still rules out anything far away', () => {
  clear();
  trigger(-1000, 1000, -100, 100, -1000, 1000, { kind: 'teleport', planes: diagonalSlab() });
  assert.equal(at(5000, 0, 5000).length, 0, 'nowhere near it');
});

test('a diagonal slab does not fire in the corners of its own bounding box', () => {
  clear();
  const planes = diagonalSlab();
  trigger(-1000, 1000, -100, 100, -1000, 1000, { kind: 'teleport', planes });

  // on the band: this is the teleport, and it must still work
  assert.equal(at(0, 0, 0).length, 1, 'the middle of the slab');
  assert.equal(at(300, 0, -300).length, 1, 'further along the same band');
  assert.equal(at(-300, 0, 300).length, 1, 'and the other way');

  // the two corners the box swallows and the slab does not touch
  assert.equal(at(600, 0, 600).length, 0, 'the corner past one face');
  assert.equal(at(-600, 0, -600).length, 0, 'the corner past the other');
});

test('without its planes the same volume fires in both of those corners', () => {
  /* The bug, stated as a test: this is what shipped when a volume was only
     ever its bounding box, and it is why flying down a clear corridor threw
     you back to the start. */
  clear();
  trigger(-1000, 1000, -100, 100, -1000, 1000, { kind: 'teleport' });
  assert.equal(at(600, 0, 600).length, 1);
  assert.equal(at(-600, 0, -600).length, 1);
});

test('the hull has width, so it touches the slab from beside it', () => {
  /* Not a point test. A player is 32 units across, and brushing past a
     trigger by a hair is a hit — which is what Source does too, and what the
     solid-brush collision in this engine already does. */
  clear();
  trigger(-1000, 1000, -100, 100, -1000, 1000, { kind: 'teleport', planes: diagonalSlab(40) });
  const off = 40 + R * Math.SQRT2 - 4;              // just inside the hull's reach
  assert.equal(at(off * Math.SQRT1_2, 0, off * Math.SQRT1_2).length, 1, 'the hull still reaches it');
  const far = 40 + R * Math.SQRT2 + 40;             // and clearly past it
  assert.equal(at(far * Math.SQRT1_2, 0, far * Math.SQRT1_2).length, 0, 'this one does not');
});

test('height is tested against the hull, not the feet', () => {
  clear();
  trigger(-100, 100, 0, 200, -100, 100, { kind: 'kill' });
  assert.equal(at(0, -H + 10, 0).length, 1, 'standing under it, head inside');
  assert.equal(at(0, -H - 40, 0).length, 0, 'standing under it, clear of it');
});

test('several volumes still come back in list order', () => {
  /* main.js fires them in order and stops at a teleport, so the order the
     narrow phase preserves is behaviour, not bookkeeping. */
  clear();
  trigger(-100, 100, 0, 100, -100, 100, { kind: 'start' });
  trigger(-100, 100, 0, 100, -100, 100, { kind: 'teleport', planes: diagonalSlab(200) });
  trigger(-100, 100, 0, 100, -100, 100, { kind: 'finish' });
  assert.deepEqual(at(0, 10, 0).map(t => t.kind), ['start', 'teleport', 'finish']);
});
