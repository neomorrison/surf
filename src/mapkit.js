/* ============================== [MAPKIT] ==============================
   The authoring language every course in this game is written in.

   A surf map is not really a set of coordinates — it is a *ride line*, the
   path a player is actually expected to occupy, with geometry hung off it.
   So that is what the cursor tracks: a point part-way up a ramp face, never
   a corner of a brush. `gap()` advances the line ballistically at an assumed
   speed, so an air section is authored as "1300 units at 800 u/s" and the
   next ramp gets placed under wherever that really puts you. That is why the
   drops line up instead of needing to be nudged by hand.

   Nothing in here steers the player. There are no boosters, no speed floors
   and no auto-aim: a ramp is a plane, and the only thing that decides how
   fast you leave it is how well you strafed along it.                      */
import {
  block, wall, surfRamp, zone, gate, sign, decal,
  voidGrid, pointGlow, monolith, clearWorld, MATS, NEON,
} from './world.js';
import { trigger } from './physics.js';
import { MOVE, RULES, slopeOf } from './config.js';
import { setSky, setEnvironment, SKY_VOID } from './core.js';

/**
 * The one live map. `buildMap()` repopulates this object in place rather than
 * replacing it, so every module can import it once and keep the binding.
 */
export const MAP = {
  id: "", name: "", blurb: "", prespeed: null,
  oneShot: false,                                       // course format, not a movement rule
  onFrame: null,                                        // a loaded map lights itself
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
  checkpoints: [], stages: [], finishPad: null,
  route: [],                                            // ride-line waypoints, for the tests
  bounds: null,
};

/* travel direction for a ramp yaw t is (sin t, cos t) */
export const DIR = { xPlus: Math.PI / 2, zPlus: 0, xMinus: -Math.PI / 2, zMinus: Math.PI };
/** A sign or a spawn facing back down a travel direction. */
export const facing = travelYaw => travelYaw + Math.PI;

const G = MOVE.gravity;

/* ============================== the cursor ============================== */

/**
 * `cur` is the expected ride point: a position the player should really be
 * occupying at that moment, not a corner of a brush.
 */
export const cur = { x: 0, y: 0, z: 0, yaw: 0 };
let stageIdx = 0, stageFloor = Infinity, stageColor = NEON.teal;

export const tvec = yaw => ({ x: Math.sin(yaw), z: Math.cos(yaw) });     // along travel
export const uvec = yaw => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });    // to the traveller's left

/** Start a fresh map. Everything below writes into MAP until the next call. */
export function beginMap(o) {
  clearWorld();
  MAP.id = o.id; MAP.name = o.name; MAP.blurb = o.blurb || "";
  MAP.spawn = { ...o.spawn };
  MAP.checkpoints.length = 0; MAP.stages.length = 0; MAP.route.length = 0;
  MAP.finishPad = null; MAP.bounds = null;
  MAP.oneShot = !!o.oneShot;
  MAP.onFrame = null;
  /* Belongs to whichever course set it, and a course that does not set it must
     not inherit the last one's — the editor keys its patch off this, and a
     stale one names the wrong map. */
  MAP.editable = null;
  MAP.stats = null; MAP.spawnNote = null;
  /* Whatever the last course did to the sky and the sun, put them back. */
  setSky({ ...SKY_VOID, radius: 18000 });
  setEnvironment({
    dir: { x: 1500, y: -2400, z: -1000 },
    sunColor: { r: 1, g: 0.94, b: 0.85 }, sunIntensity: 1.05,
    ambientColor: { r: 0.62, g: 0.85, b: 1 }, ambientGround: 0x141033,
    ambientIntensity: 0.85, shadows: true, shadowSpan: 2600,
  });
  MAP.prespeed = RULES.prespeedCap;
  cur.x = 0; cur.y = 0; cur.z = 0; cur.yaw = 0;
  stageIdx = 0; stageFloor = 0; stageColor = NEON.teal;
}

/**
 * Hang a kill volume under every segment of the ride line.
 *
 * A single kill height per stage is fine for a course that ends each stage on
 * a pad, but useless for one long descent: the floor of the whole stage sits
 * thousands of units below its first ramp, so an early fall would take ten
 * seconds to register. This tracks the line down instead — one slab per
 * segment, at its own depth, which is what a real map does with trigger_hurt.
 */
export function killUnderRoute(allowance = 620, halfWidth = 2600) {
  const R = MAP.route;
  for (let i = 1; i < R.length; i++) {
    const a = R[i - 1], b = R[i];
    // Pad across the direction of travel, never along it: a slab that reaches
    // far down the corridor sits at its own segment's depth and would swallow
    // the ride line further on, where the course has already descended past it.
    const t = tvec(a.yaw);
    const alongX = Math.abs(t.x) > 0.7;
    const padX = alongX ? 140 : halfWidth, padZ = alongX ? halfWidth : 140;
    zone((a.x + b.x) / 2, (a.z + b.z) / 2,
      Math.abs(b.x - a.x) + padX * 2, Math.abs(b.z - a.z) + padZ * 2,
      Math.min(a.y, b.y) - allowance - 900, 900, { kind: "kill" });
  }
}

/**
 * The start zone, sized so it cannot leak.
 *
 * A prespeed cap that stops at the edge of the platform is worth nothing: the
 * gap between there and the first ramp is free air, and a perfect strafe turns
 * 170 units of it into another 60 u/s. So this is built from the geometry
 * rather than typed in — it spans from the spawn to the first thing on the
 * ride line and a little past it, which means the clamp is still in force at
 * the moment you touch the face.
 *
 * Call it after the first ramp exists.
 */
export function prespeedZone(o = {}) {
  const first = MAP.route[0];
  if (!first) return null;

  /* Pad across the direction of travel, never along it. Padding along travel
     is the same mistake that put the kill slabs over the ride line: 900 units
     of it here reached a thousand units *up the first ramp*, so the clamp was
     still holding you at 350 while you were already surfing. Along travel this
     reaches well back behind the spawn and only just past the first face —
     far enough that the clamp is still on at the moment you touch it, and no
     further. */
  const back = o.back == null ? 1400 : o.back;          // behind the spawn
  const past = o.past == null ? 48 : o.past;            // beyond the first face
  const wide = o.wide == null ? 900 : o.wide;           // either side of the line

  const t = tvec(first.yaw);
  const alongX = Math.abs(t.x) > 0.7;
  let minX, maxX, minZ, maxZ;
  if (alongX) {
    const dir = Math.sign(t.x);
    const a = MAP.spawn.x - dir * back, b = first.x + dir * past;
    minX = Math.min(a, b); maxX = Math.max(a, b);
    minZ = Math.min(MAP.spawn.z, first.z) - wide;
    maxZ = Math.max(MAP.spawn.z, first.z) + wide;
  } else {
    const dir = Math.sign(t.z);
    const a = MAP.spawn.z - dir * back, b = first.z + dir * past;
    minZ = Math.min(a, b); maxZ = Math.max(a, b);
    minX = Math.min(MAP.spawn.x, first.x) - wide;
    maxX = Math.max(MAP.spawn.x, first.x) + wide;
  }
  const minY = Math.min(MAP.spawn.y, first.y) - 400;
  const maxY = Math.max(MAP.spawn.y, first.y) + 900;

  return trigger(minX, maxX, minY, maxY, minZ, maxZ, { kind: "prespeed", cap: RULES.prespeedCap });
}

/** Close the last stage's kill floor and work out the map's extent. */
export function endMap() {
  if (MAP.stages.length) MAP.stages[MAP.stages.length - 1].floorY = stageFloor - 700;
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of MAP.route) {
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
    b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
  }
  MAP.bounds = b;
  return MAP;
}

/** Record a point on the ride line. `at` overrides the cursor for pieces whose
    cursor is a reference line rather than a place a player can actually be. */
export function mark(kind, at) {
  const p = at || cur;
  MAP.route.push({ kind, stage: stageIdx, x: p.x, y: p.y, z: p.z, yaw: cur.yaw });
}
export function sink(y) { if (y < stageFloor) stageFloor = y; }

/**
 * Advance the ride line through `len` units of air at an assumed speed.
 *
 * `lateral` displaces the landing sideways, which is the whole point of an
 * air-control course: a flight that only goes forwards is a wait, but one
 * that also goes 700 units left has to be *steered*, and steering in the air
 * is the same 30 u/s wish cap doing a different job.
 */
export function gap(len, speed, o = {}) {
  const t = tvec(cur.yaw), u = uvec(cur.yaw);
  const lat = o.lateral || 0;
  // Time in the air is set by the *ground* the flight has to cover, and a
  // sideways flight covers more of it than its forward length suggests.
  const flight = Math.hypot(len, lat) / speed;
  const drop = 0.5 * G * flight * flight;

  if (o.gate) {
    // Half-way along, a quarter of the way down: a parabola falls slowly first.
    airGate({
      x: cur.x + t.x * len * 0.5 + u.x * lat * 0.5,
      y: cur.y - drop * 0.25,
      z: cur.z + t.z * len * 0.5 + u.z * lat * 0.5,
      yaw: cur.yaw, ...o.gate,
    });
  }

  cur.x += t.x * len + u.x * lat;
  cur.z += t.z * len + u.z * lat;
  cur.y -= drop;
  sink(cur.y);
  if (o.mark !== false) mark("air");
  return { len, speed, lateral: lat, drop };
}

/**
 * A frame standing across the direction of travel, marking where the ride line
 * passes through the middle of a flight.
 *
 * It is deliberately NOT solid. A wall you have to thread is the obvious way to
 * test air control, but the honest punishment for a bad line is already built
 * in: you arrive at the next ramp off to one side and slide off it. Adding an
 * instant death on top of that — in a map with no checkpoints, at a position
 * this generator can only estimate, because it does not know how early you
 * will start your turn — would be punishing you for its arithmetic rather than
 * for your flying. So the frame is what it should be: something to aim at.
 */
export function airGate(o) {
  const alongX = Math.abs(Math.sin(o.yaw)) > 0.7;       // travelling on the X axis
  const w = o.w || 800, h = o.h || 880, bar = o.bar || 22;
  const color = o.color == null ? NEON.rose : o.color;
  const piece = (offAcross, sw, offY, sh) => {
    const cx = o.x + (alongX ? 0 : offAcross), cz = o.z + (alongX ? offAcross : 0);
    block(cx, cz, alongX ? bar : sw, alongX ? sw : bar, o.y + offY - sh / 2, sh,
      MATS.beam, { solid: false, shadow: false, edge: color, edgeAlpha: 0.9 });
  };
  piece(-(w + bar) / 2, bar, 0, h);                     // left post
  piece((w + bar) / 2, bar, 0, h);                      // right post
  piece(0, w + bar * 2, (h + bar) / 2, bar);            // lintel
  piece(0, w + bar * 2, -(h + bar) / 2, bar);           // sill
  mark("gate", { x: o.x, y: o.y, z: o.z });
}

/**
 * Place a ramp under the cursor.
 *   len    length along travel        width  span of the face
 *   angle  degrees from horizontal    high   'L' or 'R' — the uphill side
 *   enter  where up the face the ride line sits, 0 = low edge, 1 = high edge
 * The cursor comes out at the far end of the ramp, at the same height: a ramp
 * is level along its length, and every unit of height you keep is one you
 * strafed for.
 */
export function ramp(o) {
  const enter = o.enter == null ? 0.34 : o.enter;
  const halfU = o.width / 2, halfV = o.len / 2;
  const s = (o.high || 'L') === 'L' ? 1 : -1;
  const across = enter * o.width;                       // distance up the face from the low edge
  const uRide = s * (across - halfU);
  const yLow = cur.y - across * slopeOf(o.angle);

  const u = uvec(cur.yaw), t = tvec(cur.yaw);
  const cx = cur.x - uRide * u.x + halfV * t.x;
  const cz = cur.z - uRide * u.z + halfV * t.z;

  const r = surfRamp({
    x: cx, z: cz, yaw: cur.yaw, len: o.len, width: o.width, yLow, angle: o.angle,
    high: o.high || 'L', base: yLow - (o.thick || 260),
    color: o.color == null ? stageColor : o.color, tag: String(stageIdx),
  });
  sink(yLow);
  mark("ramp");
  cur.x += t.x * o.len; cur.z += t.z * o.len;
  mark("rampEnd");
  return r;
}

/**
 * A trough: two ramps facing each other across a channel, with the ride line
 * running down the middle. Falling off one face drops you toward the other,
 * so this is the shape a stage uses when it wants to be survivable.
 */
export function trough(o) {
  const halfGap = (o.gap || 440) / 2;
  const rideOut = halfGap + 0.45 * o.width;
  const rideUp = 0.45 * o.width * slopeOf(o.angle);
  const u = uvec(cur.yaw), t = tvec(cur.yaw);
  const halfV = o.len / 2, halfU = o.width / 2;

  /* Two ways to hang a trough off the cursor. `floor` puts the cursor in the
     channel, which is what a stage entered on foot wants; `ride` puts it on
     the line you are actually surfing, which is what a stage entered by
     stepping off a ledge wants — the face has to be under the ledge, not
     five hundred units above it. */
  const onRide = o.anchor === 'ride';
  const ox = onRide ? cur.x - u.x * rideOut : cur.x;
  const oz = onRide ? cur.z - u.z * rideOut : cur.z;
  const yLow = onRide ? cur.y - rideUp : cur.y;

  for (const s of [1, -1]) {                            // left wall, then right wall
    const uCentre = s * (halfGap + halfU);
    surfRamp({
      x: ox + uCentre * u.x + halfV * t.x, z: oz + uCentre * u.z + halfV * t.z,
      yaw: cur.yaw, len: o.len, width: o.width, yLow, angle: o.angle,
      high: s > 0 ? 'L' : 'R', base: yLow - (o.thick || 300),
      color: o.color == null ? stageColor : o.color, tag: String(stageIdx),
    });
  }
  sink(yLow);

  if (o.floorLen) {                                     // a safe run-in at the bottom
    const fl = o.floorLen;
    block(ox + t.x * fl / 2, oz + t.z * fl / 2,
      Math.abs(t.x) * fl + Math.abs(t.z) * (halfGap * 2 - 12),
      Math.abs(t.z) * fl + Math.abs(t.x) * (halfGap * 2 - 12),
      yLow - 26, 26, MATS.deck, { edge: stageColor, edgeAlpha: 0.5 });
    mark("troughIn", { x: ox, y: yLow, z: oz });        // only a real place to be if there is a floor
  }

  /* Nobody rides the middle of a trough. The line that matters is part-way up
     one of the two faces, and you are only on it once you have had a moment
     to climb. */
  const climbIn = Math.min(o.len * 0.3, 1300);
  const ride = v => ({
    x: ox + u.x * rideOut + t.x * v, y: yLow + rideUp, z: oz + u.z * rideOut + t.z * v,
  });
  mark("trough", ride(climbIn));

  cur.x += t.x * o.len; cur.z += t.z * o.len;
  mark("troughEnd", ride(o.len));
}

/**
 * A catch platform. Big on purpose: it has to collect a player who left the
 * last ramp anywhere between the floor and a thousand units up.
 */
export function pad(o) {
  const t = tvec(cur.yaw), u = uvec(cur.yaw);
  const y = cur.y - (o.drop == null ? 420 : o.drop);
  const cxx = cur.x + t.x * o.len / 2, czz = cur.z + t.z * o.len / 2;
  const w = Math.abs(t.x) * o.len + Math.abs(u.x) * o.wide;
  const d = Math.abs(t.z) * o.len + Math.abs(u.z) * o.wide;
  block(cxx, czz, w, d, y - 64, 64, o.mat || MATS.deck, { edge: o.edge || stageColor, edgeAlpha: 0.7 });
  sink(y);
  cur.y = y;
  cur.x = cxx; cur.z = czz;
  mark("pad");                                // the middle of the pad: somewhere you can stand
  return { x: cxx, y, z: czz, w, d, len: o.len, wide: o.wide };
}

/**
 * Step off a catch pad into the next stage. The cursor is put on the pad's
 * downstream edge, turned to the new heading, and then *flown* off it: the
 * drop is computed from a walking pace, so the next ramp is placed exactly
 * where a player who simply runs off the edge will actually be.
 */
export function enterStage(p, yaw, o = {}) {
  const t = tvec(yaw), u = uvec(yaw);
  const halfAlong = (Math.abs(t.x) * p.w + Math.abs(t.z) * p.d) / 2;
  const lat = o.lateral || 0;
  cur.yaw = yaw;
  cur.x = p.x + t.x * halfAlong + u.x * lat;
  cur.z = p.z + t.z * halfAlong + u.z * lat;
  cur.y = p.y;
  gap(o.run == null ? 200 : o.run, o.speed == null ? 320 : o.speed, { mark: false });
}

/* ============================== stages ============================== */

export function stage(name, hint, color) {
  if (MAP.stages.length) MAP.stages[MAP.stages.length - 1].floorY = stageFloor - 700;
  MAP.stages.push({ i: MAP.stages.length, name, hint, color, floorY: -Infinity });
  stageIdx = MAP.stages.length - 1;
  stageColor = color || NEON.teal;
  stageFloor = cur.y;
}

/**
 * A checkpoint occupying a whole catch pad. The arch is there to be read; the
 * trigger is a slab as tall as the drop, because a player arriving at 1100
 * u/s and 900 units up must not be able to miss it.
 */
export function checkpoint(p, name) {
  const i = MAP.checkpoints.length;
  const t = tvec(cur.yaw), u = uvec(cur.yaw);
  const gx = p.x + t.x * (p.len / 2 - 220), gz = p.z + t.z * (p.len / 2 - 220);
  zone(p.x, p.z, p.w, p.d, p.y, 2200, { kind: "checkpoint", index: i });
  gate(gx, gz, Math.min(p.wide, 900), p.y, 300, NEON.lime, { kind: "none" }, 40, cur.yaw);
  sign(gx, p.y + 430, gz, name, { color: NEON.lime, sub: "CHECKPOINT " + (i + 1), rotY: facing(cur.yaw), w: 500 });
  pointGlow(p.x, p.y + 260, p.z, NEON.lime, 1.1, 1600);
  decal(p.x, p.z, p.w * 0.9, p.d * 0.9, p.y, NEON.lime, 0.10);
  MAP.checkpoints.push({ i, name, x: p.x, y: p.y + 2, z: p.z, yaw: facing(cur.yaw) });
}

