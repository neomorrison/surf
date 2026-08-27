/* ============================== [PHYSICS] ==============================
   Collision volumes + a port of Source's PlayerMove, with the ramp solver
   rewritten so that steep surfaces behave the way a surf map needs them to.

   Free of THREE and the DOM, so the whole rulebook can be unit tested
   headlessly (test/*.test.mjs) and so nothing in the renderer can reach in
   and nudge the player.

   Collision world
     SOLIDS   axis-aligned boxes
     RAMPS    yaw-rotated wedges: a footprint rectangle with a top face that
              slopes along the wedge's local X. Steeper than
              MOVE.walkableNormalY and it is not standable — you get clipped
              along it instead, which is the entire game.
     TRIGGERS non-solid volumes the game logic polls (start / checkpoint /
              finish / kill / boost / teleport).

   How surfing falls out of this
     A steep ramp is never returned by findGround, so `onGround` stays false
     while you ride it. Every tick therefore runs air acceleration (wish
     speed capped at 30) and full gravity. Gravity pushes the hull into the
     plane; the solver pushes it back out along the normal and calls
     ClipVelocity, which deletes exactly the component going into the ramp
     and leaves everything along it. The in-plane part of gravity is what
     accelerates you down the slope; the strafe is what you use to climb
     back up it and to convert that fall into forward speed.               */

import { MOVE, RULES } from './config.js';

export const SOLIDS = [];
export const RAMPS = [];
export const TRIGGERS = [];

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

export function clearPhysics() { SOLIDS.length = 0; RAMPS.length = 0; TRIGGERS.length = 0; }

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ---------------- authoring ---------------- */

/** Axis-aligned solid box. */
export function solid(minX, maxX, minY, maxY, minZ, maxZ, tag) {
  const s = { minX, maxX, minY, maxY, minZ, maxZ, tag: tag || "" };
  SOLIDS.push(s); return s;
}

/**
 * A wedge: a rectangular footprint, rotated `yaw` about Y, whose top face
 * slopes along the wedge's local X ("across") and is level along its local Z
 * ("along" — the direction you travel).
 *
 *   cx, cz     centre of the footprint
 *   halfU      half-width across the slope       halfV  half-length along it
 *   yLow/yHigh surface height at local u = -halfU / +halfU
 *   base       bottom of the solid volume
 *
 * A ramp is thus fully described by one plane plus a footprint, which is why
 * the collision below is exact rather than a stack of special cases.
 */
export function rampVolume(o) {
  const { cx, cz, halfU, halfV, yLow, yHigh } = o;
  const yaw = o.yaw || 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const slope = (yHigh - yLow) / (2 * halfU);
  const L = Math.hypot(slope, 1), inv = 1 / L;

  // local normal (-slope, 1, 0)/L rotated into world by yaw
  const n = { x: -slope * inv * cos, y: inv, z: slope * inv * sin };

  const yMid = (yLow + yHigh) / 2;
  const base = o.base == null ? Math.min(yLow, yHigh) - 600 : o.base;

  // world AABB of the footprint, for broadphase
  const ex = Math.abs(halfU * cos) + Math.abs(halfV * sin);
  const ez = Math.abs(halfU * sin) + Math.abs(halfV * cos);

  const r = {
    cx, cz, yaw, cos, sin, halfU, halfV, yLow, yHigh, slope, yMid, base, n,
    walkable: inv >= MOVE.walkableNormalY,
    angle: Math.atan2(Math.abs(slope), 1) * 180 / Math.PI,
    minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez,
    minY: base, maxY: Math.max(yLow, yHigh),
    tag: o.tag || "",
  };
  RAMPS.push(r); return r;
}

/** Non-solid volume. `data` carries the gameplay meaning (see timer.js). */
export function trigger(minX, maxX, minY, maxY, minZ, maxZ, data) {
  const t = { minX, maxX, minY, maxY, minZ, maxZ, ...data };
  TRIGGERS.push(t); return t;
}

/* ---------------- ramp geometry ---------------- */

/** World XZ -> the wedge's own (across, along) coordinates. */
export function rampLocal(r, x, z) {
  const dx = x - r.cx, dz = z - r.cz;
  return { u: dx * r.cos - dz * r.sin, v: dx * r.sin + dz * r.cos };
}
/** The wedge's (across, along) -> world XZ. */
export function rampWorld(r, u, v) {
  return { x: r.cx + u * r.cos + v * r.sin, z: r.cz - u * r.sin + v * r.cos };
}
/** Surface height at a world point, clamped into the footprint. */
export function rampSurfaceY(r, x, z) {
  const { u } = rampLocal(r, x, z);
  return r.yMid + r.slope * clamp(u, -r.halfU, r.halfU);
}
/** Unit vector pointing straight up the slope, in world XZ. */
export function rampUphill(r) {
  const s = r.slope >= 0 ? 1 : -1;
  return { x: s * r.cos, z: -s * r.sin };
}

/**
 * Signed distance from the ramp's plane to the *deepest* corner of the
 * player's hull. The hull is an axis-aligned square of half-width `radius`
 * with its bottom at `feetY`, and the plane normal always points up, so the
 * deepest corner is a bottom one — which makes the offset exact rather than
 * an approximation: radius*(|n.x| + |n.z|).
 */
function rampDist(r, x, feetY, z, radius) {
  const n = r.n;
  const d = n.x * (x - r.cx) + n.y * (feetY - r.yMid) + n.z * (z - r.cz);
  return d - radius * (Math.abs(n.x) + Math.abs(n.z));
}

/** Does the hull's footprint touch the wedge's footprint? */
function rampFootprint(r, x, z, radius) {
  const { u, v } = rampLocal(r, x, z);
  const e = radius * (Math.abs(r.cos) + Math.abs(r.sin));   // world square, seen from local axes
  return Math.abs(u) <= r.halfU + e && Math.abs(v) <= r.halfV + e;
}

function hullOverlapsXZ(b, x, z, radius) {
  return x + radius > b.minX && x - radius < b.maxX && z + radius > b.minZ && z - radius < b.maxZ;
}

/* ---------------- queries ---------------- */

/**
 * Highest *standable* surface under the hull, searched in [lo, hi] of feet
 * height. Steep ramps are deliberately invisible here: that is the one line
 * that turns them from floors into slides.
 */
export function findGround(x, z, lo, hi, radius) {
  let bestY = -Infinity, bestN = UP, bestRamp = null;
  for (const s of SOLIDS) {
    if (!hullOverlapsXZ(s, x, z, radius)) continue;
    if (s.maxY < lo || s.maxY > hi) continue;
    if (s.maxY > bestY) { bestY = s.maxY; bestN = UP; bestRamp = null; }
  }
  for (const r of RAMPS) {
    if (!r.walkable) continue;
    if (!rampFootprint(r, x, z, radius)) continue;
    // you rest on the highest point beneath the hull, i.e. its uphill corner
    const { u, v } = rampLocal(r, x, z);
    const e = radius * (Math.abs(r.cos) + Math.abs(r.sin));
    const uSup = clamp(u + (r.slope >= 0 ? e : -e), -r.halfU, r.halfU);
    if (Math.abs(v) > r.halfV + e) continue;
    const y = r.yMid + r.slope * uSup;
    if (y < lo || y > hi) continue;
    if (y > bestY) { bestY = y; bestN = r.n; bestRamp = r; }
  }
  return bestY > -Infinity ? { y: bestY, n: bestN, ramp: bestRamp } : null;
}

/** True if a standing hull would fit here (used to refuse un-ducking). */
export function hullFits(x, y, z, height, radius) {
  for (const s of SOLIDS) {
    if (!hullOverlapsXZ(s, x, z, radius)) continue;
    if (y + height > s.minY + 0.01 && y < s.maxY - 0.01) return false;
  }
  for (const r of RAMPS) {
    if (!rampFootprint(r, x, z, radius)) continue;
    if (y + height > r.base + 0.01 && y < rampSurfaceY(r, x, z) - 0.01) return false;
  }
  return true;
}

/**
 * The steep ramp the hull is riding (or about to touch), or null.
 * Contact alone is too twitchy to drive a HUD light: a tick where gravity
 * happened not to push the hull through the plane still *is* a ride, so this
 * looks for the nearest steep face within `reach` underneath instead.
 */
export function findSurfRamp(x, y, z, radius, reach = 4) {
  let best = null, bestD = Infinity;
  for (const r of RAMPS) {
    if (r.walkable) continue;
    if (y >= r.maxY + reach || y + MOVE.standHeight <= r.base) continue;
    if (!rampFootprint(r, x, z, radius)) continue;
    const d = rampDist(r, x, y, z, radius);
    if (d < -MOVE.maxRampPush || d > reach) continue;
    if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = r; }
  }
  return best;
}

export function triggersAt(pos, radius, height, out) {
  const hits = out || [];
  hits.length = 0;
  for (const t of TRIGGERS) {
    if (pos.x + radius <= t.minX || pos.x - radius >= t.maxX) continue;
    if (pos.z + radius <= t.minZ || pos.z - radius >= t.maxZ) continue;
    if (pos.y + height <= t.minY || pos.y >= t.maxY) continue;
    hits.push(t);
  }
  return hits;
}

/* ---------------- velocity clipping (Source ClipVelocity) ---------------- */

export function clipVelocity(vel, n, overbounce = 1.0) {
  const backoff = (vel.x * n.x + vel.y * n.y + vel.z * n.z) * overbounce;
  if (backoff >= 0) return false;                    // already separating
  vel.x -= n.x * backoff; vel.y -= n.y * backoff; vel.z -= n.z * backoff;
  return true;
}

/* ---------------- collision resolution ---------------- */

/**
 * Push the hull out of one axis-aligned box along its least-penetrating axis
 * and clip the velocity into that face.
 */
function pushOutBox(s, pos, vel, height, radius, wasOnGround, airborneRising) {
  const ox = Math.min(s.maxX - (pos.x - radius), (pos.x + radius) - s.minX);
  const oz = Math.min(s.maxZ - (pos.z - radius), (pos.z + radius) - s.minZ);
  const oyUp = s.maxY - pos.y;                       // lift out through the top
  const oyDn = (pos.y + height) - s.minY;            // drop out through the bottom
  const oy = Math.min(oyUp, oyDn);

  // A hull rising into a box is never resolved by teleporting it on top:
  // that is what would turn a wall clipped at head height into a free step.
  const allowY = !airborneRising || oyDn < oyUp;

  if (allowY && oy <= ox && oy <= oz) {
    if (oyUp <= oyDn) { pos.y = s.maxY; clipVelocity(vel, UP); }
    else { pos.y = s.minY - height - 0.01; clipVelocity(vel, { x: 0, y: -1, z: 0 }); }
    return;
  }
  if (ox < oz) {
    if (pos.x < (s.minX + s.maxX) * 0.5) { pos.x = s.minX - radius; clipVelocity(vel, { x: -1, y: 0, z: 0 }); }
    else { pos.x = s.maxX + radius; clipVelocity(vel, { x: 1, y: 0, z: 0 }); }
  } else {
    if (pos.z < (s.minZ + s.maxZ) * 0.5) { pos.z = s.minZ - radius; clipVelocity(vel, { x: 0, y: 0, z: -1 }); }
    else { pos.z = s.maxZ + radius; clipVelocity(vel, { x: 0, y: 0, z: 1 }); }
  }
}

/**
 * Resolve every overlap at the hull's current position.
 *
 * Ramps are resolved first and along their true normal — that ordering is
 * what keeps a ride smooth where a ramp meets the box it is bolted to.
 * `out` collects which ramp (if any) is being ridden, for the HUD.
 */
function resolve(pos, vel, height, canStep, radius, out) {
  let hits = 0;
  const rising = vel.y > 0;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;

    for (const r of RAMPS) {
      if (pos.y >= r.maxY - 0.005) continue;               // wholly above the wedge
      if (pos.y + height <= r.base + 0.005) continue;      // wholly below it
      if (!rampFootprint(r, pos.x, pos.z, radius)) continue;
      const d = rampDist(r, pos.x, pos.y, pos.z, radius);
      if (d >= 0) continue;

      // Buried in the body of the wedge rather than skimming its face: this is
      // a wall hit (you ran into the underside or the high side), so resolve it
      // as the box it visually is instead of levitating up the slope.
      if (-d > MOVE.maxRampPush || pos.y + height < rampSurfaceY(r, pos.x, pos.z) - 0.5) {
        pushOutBox(r, pos, vel, height, radius, canStep, rising);
        moved = true; hits++; continue;
      }

      pos.x -= d * r.n.x; pos.y -= d * r.n.y; pos.z -= d * r.n.z;
      clipVelocity(vel, r.n);
      moved = true; hits++;
      if (out && !r.walkable) { out.ramp = r; }
    }

    for (const s of SOLIDS) {
      if (pos.y + height <= s.minY + 0.005 || pos.y >= s.maxY - 0.005) continue;
      if (!(pos.x + radius > s.minX && pos.x - radius < s.maxX)) continue;
      if (!(pos.z + radius > s.minZ && pos.z - radius < s.maxZ)) continue;
      // a grounded player walks over low ledges instead of being stopped by them
      if (canStep && s.maxY - pos.y <= MOVE.stepHeight + 0.01) continue;
      pushOutBox(s, pos, vel, height, radius, canStep, rising);
      moved = true; hits++;
    }

    if (!moved) break;
  }
  return hits;
}

/* ---------------- Source movement primitives ---------------- */

export function applyFriction(vel, dt, surfaceFriction = 1) {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed < 0.1) return;
  const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
  const drop = control * MOVE.friction * surfaceFriction * dt;
  const newSpeed = Math.max(0, speed - drop) / speed;
  vel.x *= newSpeed; vel.y *= newSpeed; vel.z *= newSpeed;
}

/** Ground acceleration — reaches, but never exceeds, wishspeed. */
export function accelerate(vel, wx, wz, wishspeed, accel, dt, surfaceFriction = 1) {
  const currentspeed = vel.x * wx + vel.z * wz;
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return 0;
  let accelspeed = accel * wishspeed * dt * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wx; vel.z += accelspeed * wz;
  return accelspeed;
}

/**
 * Air acceleration. Identical to Accelerate except the *target* speed is
 * clamped to MOVE.airWishCap (30) while the acceleration rate still scales
 * with the full wishspeed.
 *
 * On a surf ramp this runs 128 times a second for the entire length of the
 * ride, and it is the only source of speed you control. Because the target is
 * capped, a wish vector pointing along your velocity contributes nothing once
 * you pass 30 u/s; a wish vector held perpendicular to it adds the full 30 to
 * a sideways component instead, which is why the ceiling per tick works out to
 * sqrt(v^2 + 30^2) - v and why turning the mouse is the whole skill.
 */
export function airAccelerate(vel, wx, wz, wishspeed, accel, dt, surfaceFriction = 1) {
  const wishspd = Math.min(wishspeed, MOVE.airWishCap);
  const currentspeed = vel.x * wx + vel.z * wz;
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return 0;
  let accelspeed = accel * wishspeed * dt * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wx; vel.z += accelspeed * wz;
  return accelspeed;
}

/* ---------------- the tick ---------------- */

/** A fresh physics body. */
export function makeBody(x = 0, y = 0, z = 0) {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    onGround: false, groundNormal: { ...UP }, groundRamp: null,
    surfRamp: null,                       // the steep ramp being ridden this tick, or null
    ducking: false, hullHeight: MOVE.standHeight,
    jumped: false, landed: false, wallHits: 0,
    /* per-tick telemetry the HUD reads (never fed back into movement) */
    gain: 0, wishX: 0, wishZ: 0, speed: 0, prevSpeed: 0, vspeed: 0,
  };
}

const contact = { ramp: null };

/**
 * One fixed simulation tick.
 * `cmd` = { forward:-1..1, side:-1..1, yaw, jump:bool, duck:bool, walk:bool }
 * Every term below comes from cmd or from the body's own state. Nothing here
 * ever substitutes a direction the player did not press.
 */
export function playerMove(body, cmd, dt) {
  const M = MOVE;
  const pos = body.pos, vel = body.vel;
  body.jumped = false; body.landed = false; body.gain = 0;
  body.prevSpeed = Math.hypot(vel.x, vel.z);

  /* --- duck --- */
  const wantDuck = !!cmd.duck;
  if (wantDuck !== body.ducking) {
    if (wantDuck) body.ducking = true;
    else if (hullFits(pos.x, pos.y, pos.z, M.standHeight, M.radius)) body.ducking = false;
  }
  const height = body.ducking ? M.duckHeight : M.standHeight;
  body.hullHeight = height;

  /* --- wish direction: look angles x key state, and nothing else --- */
  const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  let wx = (-sy * cmd.forward) + (cy * cmd.side);
  let wz = (-cy * cmd.forward) + (-sy * cmd.side);
  const wlen = Math.hypot(wx, wz);
  let wishspeed = 0;
  if (wlen > 1e-6) {
    wx /= wlen; wz /= wlen;
    wishspeed = M.maxSpeed * (cmd.walk ? M.walkSpeedMul : 1) * (body.ducking && body.onGround ? M.duckSpeedMul : 1);
  } else { wx = 0; wz = 0; }
  body.wishX = wx; body.wishZ = wz;

  /* --- 1. half gravity --- */
  vel.y -= M.gravity * 0.5 * dt;

  /* --- 2. jump (before friction: that is why a frame-perfect hop keeps speed) --- */
  if (cmd.jump && body.onGround) {
    /* PreventBunnyJumping. With sv_enablebunnyhopping off, Source scales your
       velocity back to BUNNYJUMP_MAX_SPEED_FACTOR (1.2) x m_flMaxspeed on the
       tick you jump — 300 u/s with a knife. Note it uses the *3D* speed and
       scales all three components, and that it runs before the jump impulse is
       added, so the vertical kick you are about to get is not scaled with it.
       On flat ground vy is already ~0, so this reads as a horizontal clamp.

       It is also why this can never touch a surf ramp: it needs onGround, and
       a ramp is never ground. Every unit above 300 in a finishing time came
       off a face. */
    if (!RULES.bunnyhopping) {
      const cap = M.maxSpeed * M.bunnyhopFactor;
      const spd = Math.hypot(vel.x, vel.y, vel.z);
      if (spd > cap) { const k = cap / spd; vel.x *= k; vel.y *= k; vel.z *= k; }
    }
    vel.y = M.jumpVel;
    body.onGround = false; body.groundRamp = null; body.jumped = true;
  }

  /* --- 3. friction (skipped entirely on the tick you jump, and never on a ramp) --- */
  if (body.onGround) { vel.y = 0; applyFriction(vel, dt); }

  /* --- 4. accelerate --- */
  const speedBefore = Math.hypot(vel.x, vel.z);
  if (body.onGround) {
    accelerate(vel, wx, wz, wishspeed, M.accelerate, dt);
    vel.y = 0;
  } else {
    airAccelerate(vel, wx, wz, wishspeed, M.airAccelerate, dt);
  }
  body.gain = Math.hypot(vel.x, vel.z) - speedBefore;

  /* --- clamp --- */
  vel.x = clamp(vel.x, -M.maxVelocity, M.maxVelocity);
  vel.y = clamp(vel.y, -M.maxVelocity, M.maxVelocity);
  vel.z = clamp(vel.z, -M.maxVelocity, M.maxVelocity);

  /* --- 5. move ---
     One integration for all three axes, sub-stepped so that at 1500 u/s the
     hull never skips past a ramp face between collision passes. */
  const wasOnGround = body.onGround;
  const prevY = pos.y;
  const dist = Math.hypot(vel.x, vel.y, vel.z) * dt;
  const sub = Math.max(1, Math.min(16, Math.ceil(dist / M.subStepLen)));
  contact.ramp = null;
  body.wallHits = 0;
  for (let i = 0; i < sub; i++) {
    pos.x += vel.x * dt / sub;
    pos.y += vel.y * dt / sub;
    pos.z += vel.z * dt / sub;
    body.wallHits += resolve(pos, vel, height, wasOnGround, M.radius, contact);
  }
  body.surfRamp = contact.ramp;

  /* --- 6. categorise position --- */
  let grounded = false;
  if (vel.y <= 0.1) {
    // reach up by a step (mounting a ledge), and down by a step only if we were
    // already grounded (walking down stairs instead of launching off them). Mid-air
    // ducking tucks the legs, letting a crouch-jump catch a higher edge.
    const tuck = (body.ducking && !wasOnGround) ? M.duckTuck : 0;
    const hi = pos.y + M.stepHeight + tuck;
    const lo = wasOnGround ? pos.y - M.stepHeight : Math.min(pos.y, prevY) - 0.5;
    const g = findGround(pos.x, pos.z, lo, hi, M.radius);
    if (g) {
      pos.y = g.y; grounded = true;
      body.groundNormal = g.n; body.groundRamp = g.ramp;
      if (!wasOnGround) body.landed = true;
      if (g.n.y > 0.999) vel.y = 0; else clipVelocity(vel, g.n);
    }
  }
  if (!grounded) { body.groundNormal = { ...UP }; body.groundRamp = null; }
  body.onGround = grounded;
  body.surfRamp = grounded ? null : (contact.ramp || findSurfRamp(pos.x, pos.y, pos.z, M.radius));

  /* --- 7. remaining half gravity (cleared next tick if still grounded) --- */
  vel.y -= M.gravity * 0.5 * dt;

  body.speed = Math.hypot(vel.x, vel.z);
  body.vspeed = vel.y;
  return body;
}
