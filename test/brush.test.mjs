/* ============================== [BRUSH] ==============================
   Convex brushes are the representation a real Source map has to be loaded
   into: arbitrary planes, arbitrary angles, no axis to lean on.

   The first test is the one that matters. The wedge path in physics.js has
   been validated by everything else in this suite, so the way to trust the
   general path is to build the *same ramp* out of raw planes and show that
   riding it produces the same numbers. After that, the brush is asked to do
   things the wedge cannot express at all.                                  */
import test from 'node:test';
import assert from 'node:assert';
import { MOVE, slopeOf } from '../src/config.js';
import {
  makeBody, playerMove, clearPhysics, rampVolume, brush, plane, brushVertices,
  brushContact, findGround, BRUSHES,
  setTriangles, triangleContact, trianglesNear, TRIS,
} from '../src/physics.js';

const TICK = MOVE.tick;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
const near_ = near;

/** The same wedge the other tests use, but written out as six planes. */
function rampAsBrush(angleDeg, halfU = 500, halfV = 6000, base = -900) {
  const rise = slopeOf(angleDeg) * halfU * 2;
  const slope = rise / (2 * halfU), yMid = rise / 2;
  const L = Math.hypot(slope, 1);
  const top = plane(-slope / L, 1 / L, 0, (1 / L) * yMid);   // through (0, yMid, 0)
  return brush([
    top,
    plane(0, -1, 0, -base),
    plane(1, 0, 0, halfU), plane(-1, 0, 0, halfU),
    plane(0, 0, 1, halfV), plane(0, 0, -1, halfV),
  ]);
}

/**
 * Ride whatever face the body is touching, holding a line part-way up it.
 * Driven by the contact normal alone, so it works on a wedge or a brush.
 */
function ride(startX, startY, ticks) {
  const b = makeBody(startX, startY, -5000);
  b.vel.z = 300;
  for (let i = 0; i < ticks; i++) {
    const n = b.surfNormal;
    const sp = Math.hypot(b.vel.x, b.vel.z) || 1;
    let cmd = { forward: 1, side: 0, yaw: Math.PI, jump: false };
    if (n) {
      // steepest ascent on the plane, projected flat
      const ul = Math.hypot(n.x, n.z) || 1;
      const up = { x: -n.x / ul, z: -n.z / ul };
      const vx = b.vel.x / sp, vz = b.vel.z / sp;
      const p = { x: -vz, z: vx };
      const climbRate = b.vel.x * up.x + b.vel.z * up.z;
      const climb = (-climbRate) >= 0 ? 1 : -1;         // hold height, do not chase it
      const w = (p.x * up.x + p.z * up.z) * climb >= 0 ? p : { x: -p.x, z: -p.z };
      cmd = { forward: 0, side: 1, yaw: Math.atan2(-w.z, w.x), jump: false };
    }
    playerMove(b, cmd, TICK);
  }
  return b;
}

test('a ramp built from raw planes rides exactly like the wedge it copies', () => {
  const ANGLE = 55, u0 = 120;
  const rise = slopeOf(ANGLE) * 1000;
  const startY = rise / 2 + slopeOf(ANGLE) * u0 + 2;

  clearPhysics();
  rampVolume({ cx: 0, cz: 0, halfU: 500, halfV: 6000, yLow: 0, yHigh: rise, base: -900 });
  const wedge = ride(u0, startY, 128 * 6);

  clearPhysics();
  rampAsBrush(ANGLE);
  const raw = ride(u0, startY, 128 * 6);

  near(raw.speed, wedge.speed, 1.0, 'speed after six seconds');
  near(raw.pos.x, wedge.pos.x, 2.0, 'x');
  near(raw.pos.y, wedge.pos.y, 2.0, 'height held');
  near(raw.pos.z, wedge.pos.z, 2.0, 'distance travelled');
  assert.ok(raw.speed > 600, 'and it is a real ride, not two identical failures: ' + raw.speed.toFixed(0));
  assert.ok(!raw.onGround, 'a 55 is never ground, however it is expressed');
});

test('a brush ramp that is yawed AND pitched — which the wedge cannot express', () => {
  clearPhysics();
  // a face tilted 52 degrees across and dropping 8 degrees along its length,
  // rotated 30 degrees in plan. No axis, no symmetry, no special case.
  const yaw = 30 * Math.PI / 180, across = 52 * Math.PI / 180, along = -8 * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const u = { x: cy, z: -sy }, v = { x: sy, z: cy };
  const n = {
    x: -Math.sin(across) * u.x - Math.sin(along) * v.x,
    y: Math.cos(across) * Math.cos(along),
    z: -Math.sin(across) * u.z - Math.sin(along) * v.z,
  };
  const top = plane(n.x, n.y, n.z, 0);                 // through the origin
  const b = brush([
    top, plane(0, -1, 0, 1200),
    plane(u.x, 0, u.z, 600), plane(-u.x, 0, -u.z, 600),
    plane(v.x, 0, v.z, 7000), plane(-v.x, 0, -v.z, 7000),
  ]);
  assert.ok(b, 'the brush is bounded');
  assert.ok(!b.walkable, 'a 52 across is not standable: ' + top.y.toFixed(3));

  const body = makeBody(0, 4, 0);
  body.vel.x = v.x * 320; body.vel.z = v.z * 320;
  for (let i = 0; i < 128 * 5; i++) {
    const nn = body.surfNormal;
    let cmd = { forward: 0, side: 0, yaw: 0, jump: false };
    if (nn) {
      const sp = Math.hypot(body.vel.x, body.vel.z) || 1;
      const ul = Math.hypot(nn.x, nn.z) || 1;
      const up = { x: -nn.x / ul, z: -nn.z / ul };
      const p = { x: -body.vel.z / sp, z: body.vel.x / sp };
      const climb = -(body.vel.x * up.x + body.vel.z * up.z) >= 0 ? 1 : -1;
      const w = (p.x * up.x + p.z * up.z) * climb >= 0 ? p : { x: -p.x, z: -p.z };
      cmd = { forward: 0, side: 1, yaw: Math.atan2(-w.z, w.x), jump: false };
    }
    playerMove(body, cmd, TICK);
  }
  assert.ok(body.speed > 550, 'five seconds on an arbitrary face: ' + body.speed.toFixed(0));
  assert.ok(body.surfNormal, 'and it knows it is still on one');
  near(body.surfAngle, 52, 6, 'the reported face angle');
});

test('a brush box is a floor, and reports the ground you stand on', () => {
  clearPhysics();
  brush([
    plane(0, 1, 0, 0), plane(0, -1, 0, 200),
    plane(1, 0, 0, 900), plane(-1, 0, 0, 900),
    plane(0, 0, 1, 900), plane(0, 0, -1, 900),
  ]);
  const g = findGround(0, 0, -20, 40, MOVE.radius);
  assert.ok(g, 'no ground found on top of a box');
  near(g.y, 0, 0.01, 'the top face');
  near(g.n.y, 1, 1e-6, 'pointing up');

  const b = makeBody(0, 60, 0);
  for (let i = 0; i < 128; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  assert.ok(b.onGround, 'you should land on it');
  near(b.pos.y, 0, 0.05, 'and rest exactly on the surface');
});

test('brush geometry: corners, bounds and contact', () => {
  clearPhysics();
  const b = brush([
    plane(0, 1, 0, 100), plane(0, -1, 0, 0),
    plane(1, 0, 0, 50), plane(-1, 0, 0, 50),
    plane(0, 0, 1, 50), plane(0, 0, -1, 50),
  ]);
  assert.equal(brushVertices(b.planes).length, 8, 'a box has eight corners');
  near(b.minY, 0, 1e-6, 'minY'); near(b.maxY, 100, 1e-6, 'maxY');
  near(b.maxX, 50, 1e-6, 'maxX');
  assert.ok(brushContact(b, 0, 50, 0, MOVE.radius, MOVE.standHeight), 'a hull inside it is in contact');
  assert.equal(brushContact(b, 400, 50, 0, MOVE.radius, MOVE.standHeight), null, 'and one far away is not');
});

test('a degenerate or unbounded brush is dropped, not crashed on', () => {
  clearPhysics();
  assert.equal(brush([plane(0, 1, 0, 0), plane(0, -1, 0, 0)]), null, 'two planes bound nothing');
  assert.equal(BRUSHES.length, 0, 'and nothing was added to the world');
});

/* ---------------- displacement terrain ---------------- */

/** A flat grid of triangles at height `y`, spanning ±`half`. */
function flatTerrain(y, half = 600, step = 200) {
  const t = [];
  for (let x = -half; x < half; x += step) {
    for (let z = -half; z < half; z += step) {
      // wound so the normal points up; the collider is right to ignore terrain
      // that faces away, so a fixture that gets this wrong tests nothing
      t.push(x, y, z, x, y, z + step, x + step, y, z);
      t.push(x + step, y, z, x, y, z + step, x + step, y, z + step);
    }
  }
  return new Float32Array(t);
}

test('a box resting on terrain is pushed out along the surface, not sideways', () => {
  clearPhysics();
  setTriangles(flatTerrain(0));
  const r = MOVE.radius, h = MOVE.standHeight;
  const near = [];
  trianglesNear(-r, -20, -r, r, h, r, near);
  assert.ok(near.length > 0, 'the broadphase should find the ground under the hull');

  // a hull sunk 6 units into flat ground
  let found = null;
  for (const t of near) {
    const c = triangleContact(t, 0, -6 + h / 2, 0, r, h / 2, r);
    if (c && (!found || c.depth > found.depth)) found = { depth: c.depth, y: c.y };
  }
  assert.ok(found, 'contact with the ground');
  near_(found.y, 1, 0.001, 'pushed straight up');
  near_(found.depth, 6, 0.01, 'by exactly how far it had sunk');
});

test('terrain is ground when flat and a ride when steep', () => {
  clearPhysics();
  setTriangles(flatTerrain(0));
  const g = findGround(0, 0, -20, 40, MOVE.radius);
  assert.ok(g, 'flat terrain is ground');
  near_(g.y, 0, 0.001, 'at its own height');
  near_(g.n.y, 1, 1e-6, 'pointing up');

  // the same grid tilted past the standable threshold
  clearPhysics();
  const flat = flatTerrain(0);
  const tilt = Math.tan(58 * Math.PI / 180);
  for (let i = 0; i < flat.length; i += 3) flat[i + 1] = flat[i] * tilt;
  setTriangles(flat);
  assert.equal(findGround(0, 0, -40, 40, MOVE.radius), null, 'a 58 is not ground');
  const b = makeBody(0, 30, 0);
  b.vel.z = 300;
  for (let i = 0; i < 40; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  assert.ok(!b.onGround, 'and you never stand on it');
  assert.ok(b.surfNormal, 'it reports as a face you are riding');
});

test('a player falls onto terrain and stops there', () => {
  clearPhysics();
  setTriangles(flatTerrain(0));
  const b = makeBody(0, 400, 0);
  for (let i = 0; i < 128 * 2; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  assert.ok(b.onGround, 'landed');
  near_(b.pos.y, 0, 0.05, 'resting on the surface, not in it');
});

test('terrain is cleared with the rest of the world', () => {
  setTriangles(flatTerrain(0));
  assert.ok(TRIS.count > 0);
  clearPhysics();
  assert.equal(TRIS.count, 0, 'a rebuild must not inherit the last map terrain');
});
