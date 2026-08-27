/* The rulebook, measured. Every number here is a claim the game makes about
   Source movement; if one of them drifts, the feel drifts with it. */
import test from 'node:test';
import assert from 'node:assert';
import { MOVE, RULES, slopeOf } from '../src/config.js';

/* The rules are global, so a test that changes one puts it back. */
const withRule = (k, v, fn) => { const was = RULES[k]; RULES[k] = v; try { fn(); } finally { RULES[k] = was; } };
import {
  makeBody, playerMove, clearPhysics, solid, rampVolume, clipVelocity,
  findGround, rampLocal, rampUphill, findSurfRamp,
} from '../src/physics.js';

const TICK = MOVE.tick;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

function floorWorld() {
  clearPhysics();
  solid(-100000, 100000, -100, 0, -100000, 100000);
}

/** A ramp running along +Z, climbing toward +X. */
function rampWorld(angleDeg, halfU = 500, halfV = 6000) {
  clearPhysics();
  const rise = slopeOf(angleDeg) * halfU * 2;
  return rampVolume({ cx: 0, cz: 0, halfU, halfV, yLow: 0, yHigh: rise, base: -900 });
}

/* ---------------- the air wish cap ---------------- */

test('holding forward in the air does nothing once you pass 30 u/s', () => {
  floorWorld();
  const b = makeBody(0, 400, 0);
  b.vel.z = -500;                                     // travelling toward -Z
  const before = b.speed = Math.hypot(b.vel.x, b.vel.z);
  for (let i = 0; i < 128; i++) playerMove(b, { forward: 1, side: 0, yaw: 0, jump: false }, TICK);
  near(Math.hypot(b.vel.x, b.vel.z), 500, 0.001, 'a second of held W added something');
});

test('a perpendicular wish adds exactly the per-tick ceiling', () => {
  floorWorld();
  const b = makeBody(0, 4000, 0);
  b.vel.z = -600;                                     // forward = -Z, so +X is perpendicular
  const v0 = Math.hypot(b.vel.x, b.vel.z);
  // yaw 0 with side=+1 gives wish (cos0, -sin0) = +X
  playerMove(b, { forward: 0, side: 1, yaw: 0, jump: false }, TICK);
  const v1 = Math.hypot(b.vel.x, b.vel.z);
  near(v1, Math.sqrt(v0 * v0 + MOVE.airWishCap ** 2), 0.01, 'perpendicular tick gain');
});

test('the ceiling shrinks as you speed up — a run is a grind, not a switch', () => {
  const gainAt = v => Math.sqrt(v * v + MOVE.airWishCap ** 2) - v;
  assert.ok(gainAt(300) > gainAt(900));
  near(gainAt(300) * 128, 191.5, 0.5, 'u/s per second at 300');
  near(gainAt(900) * 128, 64.0, 0.5, 'u/s per second at 900');
});

/* ---------------- ground ---------------- */

test('ground speed is capped at 250 however long you hold W', () => {
  floorWorld();
  const b = makeBody(0, 0, 0);
  b.onGround = true;
  for (let i = 0; i < 128 * 4; i++) playerMove(b, { forward: 1, side: 0, yaw: 0, jump: false }, TICK);
  near(b.speed, MOVE.maxSpeed, 0.5, 'ground top speed');
});

test('friction bleeds speed at sv_friction, and jumping skips it', () => {
  floorWorld();
  const b = makeBody(0, 0, 0);
  b.onGround = true; b.vel.z = -800;
  playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  const dropped = 800 - Math.hypot(b.vel.x, b.vel.z);
  near(dropped, 800 * MOVE.friction * TICK, 0.01, 'one tick of friction');

  withRule('bunnyhopping', true, () => {
    const j = makeBody(0, 0, 0);
    j.onGround = true; j.vel.z = -800;
    playerMove(j, { forward: 0, side: 0, yaw: 0, jump: true }, TICK);
    near(Math.hypot(j.vel.x, j.vel.z), 800, 0.001, 'a frame-perfect hop keeps every unit');
    assert.ok(j.jumped && j.vel.y > 290, 'and leaves the ground: ' + j.vel.y.toFixed(1));
  });
});

/* ---------------- surf-server rules ---------------- */

test('bunnyhopping is off, so a hop can never hand you speed', () => {
  assert.equal(RULES.bunnyhopping, false, 'every course runs sv_enablebunnyhopping 0');
  floorWorld();
  const cap = MOVE.maxSpeed * MOVE.bunnyhopFactor;
  near(cap, 300, 1e-9, 'BUNNYJUMP_MAX_SPEED_FACTOR x 250');
  for (const start of [260, 400, 900, 1600]) {
    const b = makeBody(0, 0, 0);
    b.onGround = true; b.vel.z = -start;
    playerMove(b, { forward: 0, side: 0, yaw: 0, jump: true }, TICK);
    assert.ok(b.jumped, 'the hop still happens');
    near(Math.hypot(b.vel.x, b.vel.z), Math.min(start, cap), 0.01, `hop from ${start}`);
  }
});

test('PreventBunnyJumping scales the 3D velocity, as the engine does', () => {
  floorWorld();
  // Source uses mv->m_vecVelocity.Length() and scales all three components.
  // On flat ground vy is ~0, so this only shows up if you contrive it.
  const b = makeBody(0, 0, 0);
  b.onGround = true; b.vel.x = 400; b.vel.y = -300; b.vel.z = 0;
  // half of a tick's gravity lands before the jump check, so that is the
  // velocity the clamp actually sees
  const vyAtJump = -300 - MOVE.gravity * 0.5 * TICK;
  const before = Math.hypot(400, vyAtJump, 0);
  playerMove(b, { forward: 0, side: 0, yaw: 0, jump: true }, TICK);
  const k = (MOVE.maxSpeed * MOVE.bunnyhopFactor) / before;
  near(b.vel.x, 400 * k, 0.01, 'x scaled by the 3D fraction, not the 2D one');
  assert.ok(Math.abs(400 * k - 400 * 300 / 500) > 0.5, 'and the 3D fraction is measurably different here');
});

test('with bunnyhopping on, a frame-perfect hop keeps everything', () => {
  withRule('bunnyhopping', true, () => {
    floorWorld();
    const b = makeBody(0, 0, 0);
    b.onGround = true; b.vel.z = -900;
    playerMove(b, { forward: 0, side: 0, yaw: 0, jump: true }, TICK);
    near(Math.hypot(b.vel.x, b.vel.z), 900, 0.001, 'nothing taken');
  });
});

test('the bunnyhop cap never touches a ramp, because a ramp is never ground', () => {
  const r = rampWorld(55);
  const b = surf(r, 128 * 4);
  // holding jump the whole way down changes nothing: onGround is false throughout
  const b2 = surf(r, 128 * 4, { jump: true });
  assert.ok(!b.onGround && !b2.onGround);
  near(b2.speed, b.speed, 0.001, 'jump held vs not held');
  assert.ok(b.speed > 500, 'and it is still a real ride: ' + b.speed.toFixed(0));
});

/* ---------------- surfaces ---------------- */

test('45.6 degrees is the line between a floor and a slide', () => {
  const shallow = rampWorld(40);
  assert.ok(shallow.walkable, 'a 40 should be walkable');
  const steep = rampWorld(55);
  assert.ok(!steep.walkable, 'a 55 must not be');
  near(Math.acos(MOVE.walkableNormalY) * 180 / Math.PI, 45.57, 0.02, 'the threshold angle');
});

test('a surf ramp never appears as ground, at any point on its face', () => {
  const r = rampWorld(55);
  for (let u = -400; u <= 400; u += 100) {
    const y = r.yMid + r.slope * u;
    assert.equal(findGround(u, 0, y - 40, y + 40, MOVE.radius), null, `ground found at u=${u}`);
  }
});

test('ClipVelocity removes the component into a plane and nothing else', () => {
  const n = { x: 0, y: 1, z: 0 };
  const v = { x: 300, y: -200, z: 0 };
  clipVelocity(v, n);
  assert.deepEqual(v, { x: 300, y: 0, z: 0 });
  const v2 = { x: 300, y: 200, z: 0 };
  assert.equal(clipVelocity(v2, n), false, 'already separating: untouched');
});

/* ---------------- surfing ---------------- */

/** Ride a ramp for `ticks`, aiming the wish vector perpendicular to velocity. */
function surf(r, ticks, opts = {}) {
  const u0 = opts.u == null ? 0 : opts.u;
  const b = makeBody(u0, r.yMid + r.slope * u0 + 2, -5000);
  b.vel.z = opts.speed == null ? 300 : opts.speed;
  const up = rampUphill(r);
  for (let i = 0; i < ticks; i++) {
    const sp = Math.hypot(b.vel.x, b.vel.z) || 1;
    const p = { x: -b.vel.z / sp, z: b.vel.x / sp };
    const { u } = rampLocal(r, b.pos.x, b.pos.z);
    const climbRate = b.vel.x * up.x + b.vel.z * up.z;
    const climb = (1.1 * (0 - u) * Math.sign(r.slope) - climbRate) >= 0 ? 1 : -1;
    const w = (p.x * up.x + p.z * up.z) * climb >= 0 ? p : { x: -p.x, z: -p.z };
    playerMove(b, { forward: 0, side: 1, yaw: Math.atan2(-w.z, w.x), jump: !!opts.jump }, TICK);
  }
  return b;
}

test('a held strafe on a ramp turns a fall into speed', () => {
  const r = rampWorld(55);
  const b = surf(r, 128 * 6);
  assert.ok(b.speed > 600, 'six seconds of clean strafing: ' + b.speed.toFixed(0));
  assert.ok(!b.onGround, 'you are airborne the whole way down a surf ramp');
  assert.ok(b.surfRamp === r, 'and the game knows which face you are on');
});

test('doing nothing on a ramp just drops you off it', () => {
  const r = rampWorld(55);
  const b = makeBody(0, r.yMid + 2, -5000);
  b.vel.z = 300;
  for (let i = 0; i < 128 * 3; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  const { u } = rampLocal(r, b.pos.x, b.pos.z);
  assert.ok(u < -r.halfU || b.pos.y < r.yLow, 'a passenger ends up off the low edge, at ' + u.toFixed(0));
  assert.ok(b.speed < 700, 'and gets there without earning much: ' + b.speed.toFixed(0));
});

test('the hull rests on the plane, not inside it and not hovering', () => {
  const r = rampWorld(58);
  const b = surf(r, 128 * 3);
  const n = r.n;
  const d = n.x * (b.pos.x - r.cx) + n.y * (b.pos.y - r.yMid) + n.z * (b.pos.z - r.cz)
    - MOVE.radius * (Math.abs(n.x) + Math.abs(n.z));
  assert.ok(d > -0.6 && d < 2.5, 'distance from the face: ' + d.toFixed(3));
  assert.ok(findSurfRamp(b.pos.x, b.pos.y, b.pos.z, MOVE.radius) === r);
});

test('holding a line, a shallow face pays more per tick than a steep one', () => {
  // The wish vector is horizontal; only its in-plane part survives the clip, and
  // that part is cos(angle) of it. So a rider who refuses to give up any height
  // gains fastest on the *shallowest* ramp. Steep ramps are not fast because of
  // the angle — they are fast because of the height they let you spend.
  const a = surf(rampWorld(50), 128 * 5).speed;
  const c = surf(rampWorld(62), 128 * 5).speed;
  assert.ok(a > c, `50deg ${a.toFixed(0)} should beat 62deg ${c.toFixed(0)} at a constant height`);
});

test('a ramp is frictionless: a passenger trades height for speed and loses nothing', () => {
  const r = rampWorld(55, 700, 9000);
  const b = makeBody(300, r.yMid + r.slope * 300 + 1, -8000);
  b.vel.z = 200;
  // settle onto the plane before measuring, so the first contact clip is not counted
  for (let i = 0; i < 12; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  const e0 = 0.5 * (b.vel.x ** 2 + b.vel.y ** 2 + b.vel.z ** 2) + MOVE.gravity * b.pos.y;
  for (let i = 0; i < 128 * 2; i++) playerMove(b, { forward: 0, side: 0, yaw: 0, jump: false }, TICK);
  const e1 = 0.5 * (b.vel.x ** 2 + b.vel.y ** 2 + b.vel.z ** 2) + MOVE.gravity * b.pos.y;
  assert.ok(Math.abs(e1 - e0) / Math.abs(e0) < 0.02, `energy drifted ${((e1 - e0) / e0 * 100).toFixed(2)}%`);
});

test('report: what five seconds on a ramp is worth', () => {
  console.log('\n  angle   speed after 1s   3s     5s     8s');
  for (const deg of [50, 54, 58, 62]) {
    const row = [1, 3, 5, 8].map(sec => surf(rampWorld(deg), 128 * sec).speed.toFixed(0).padStart(6));
    console.log(`  ${String(deg).padStart(3)}deg ${row.join(' ')}`);
  }
  console.log('');
});

/* ---------------- determinism ---------------- */

test('the tick is the unit of gain, so the sim is frame-rate blind', () => {
  const run = () => {
    floorWorld();
    const b = makeBody(0, 9000, 0);
    b.vel.z = -400;
    let yaw = 0;
    for (let i = 0; i < 256; i++) { yaw -= 0.004; playerMove(b, { forward: 0, side: 1, yaw, jump: false }, TICK); }
    return b.speed;
  };
  near(run(), run(), 1e-9, 'the same inputs must give the same speed twice');
});
