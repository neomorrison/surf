/* ============================== [MAP] ==============================
   surf_helix — five stages spiralling down through the void.

   The course is generated from a *ride line* rather than from coordinates.
   The cursor tracks where a player is expected to actually be — a point
   part-way up a ramp face, not the ramp's corner — and every piece is
   placed so that line runs through it. `gap()` advances the cursor
   ballistically at an assumed speed, so an air section is authored as
   "600 units at 750 u/s" and the next ramp lands under wherever that
   really puts you.  That is why the drops line up.

   Nothing here steers the player. There are no boosters, no speed floors
   and no auto-aim: a ramp is a plane, and the only thing that decides how
   fast you leave it is how well you strafed along it.                     */
import {
  block, wall, surfRamp, zone, gate, sign, decal,
  voidGrid, pointGlow, monolith, clearWorld, MATS, NEON,
} from './world.js';
import { MOVE, slopeOf } from './config.js';

export const MAP = {
  name: "surf_helix",
  spawn: { x: -1750, y: 0, z: 0, yaw: -Math.PI / 2 },   // view yaw -90deg looks down +X
  checkpoints: [], stages: [], finishPad: null,
  route: [],                                            // ride-line waypoints, for the tests
  bounds: null,
};

/* travel direction for a ramp yaw t is (sin t, cos t) */
export const DIR = { xPlus: Math.PI / 2, zPlus: 0, xMinus: -Math.PI / 2, zMinus: Math.PI };
/** A sign or a spawn facing back down a travel direction. */
const facing = travelYaw => travelYaw + Math.PI;

const G = MOVE.gravity;

/* ============================== the cursor ============================== */

/**
 * `cur` is the expected ride point: a position the player should really be
 * occupying at that moment, not a corner of a brush.
 */
const cur = { x: 0, y: 0, z: 0, yaw: 0 };
let stageIdx = 0, stageFloor = Infinity, stageColor = NEON.teal;

const tvec = yaw => ({ x: Math.sin(yaw), z: Math.cos(yaw) });     // along travel
const uvec = yaw => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });    // to the traveller's left

/** Record a point on the ride line. `at` overrides the cursor for pieces whose
    cursor is a reference line rather than a place a player can actually be. */
function mark(kind, at) {
  const p = at || cur;
  MAP.route.push({ kind, stage: stageIdx, x: p.x, y: p.y, z: p.z, yaw: cur.yaw });
}
function sink(y) { if (y < stageFloor) stageFloor = y; }

/** Advance the ride line through `len` units of air at an assumed speed. */
function gap(len, speed, o = {}) {
  const t = tvec(cur.yaw);
  const flight = len / speed;
  cur.x += t.x * len; cur.z += t.z * len;
  cur.y -= 0.5 * G * flight * flight;
  sink(cur.y);
  if (o.mark !== false) mark("air");
  return { len, speed, drop: 0.5 * G * flight * flight };
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
function ramp(o) {
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
function trough(o) {
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
function pad(o) {
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
function enterStage(p, yaw, o = {}) {
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

function stage(name, hint, color) {
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
function checkpoint(p, name) {
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

/* ============================================================ */

export function buildMap() {
  clearWorld();
  MAP.checkpoints.length = 0; MAP.stages.length = 0; MAP.route.length = 0;
  cur.x = 0; cur.y = 0; cur.z = 0; cur.yaw = DIR.xPlus;
  stageFloor = 0;

  voidGrid(-7200, 40000, 80, 0x2d6f8a, 0x1a3550);

  /* ---------------- start room ---------------- */
  stage("START", "Run through the gate. The clock starts there.", NEON.lime);
  block(-1250, 0, 1700, 900, -70, 70, MATS.start, { edge: NEON.lime });
  wall(-2100, 0, 40, 900, 0, 460);
  wall(-1250, -450, 1700, 40, 0, 460);
  wall(-1250, 450, 1700, 40, 0, 460);

  sign(-820, 620, 0, "SURF_HELIX", { color: NEON.teal, rotY: facing(DIR.xPlus), w: 520 });
  sign(-820, 410, 0, "A + MOUSE LEFT   ·   D + MOUSE RIGHT", {
    color: NEON.cyan, sub: "you never land on a ramp — you fall along it, forever", rotY: facing(DIR.xPlus), w: 620,
  });
  gate(-520, 0, 860, 0, 300, NEON.lime, { kind: "start" }, 40, DIR.xPlus);   // spans the corridor: it cannot be walked around
  sign(-520, 330, 0, "START", { color: NEON.lime, rotY: facing(DIR.xPlus), w: 220 });
  pointGlow(-1400, 340, 0, NEON.lime, 1.0, 1800);

  cur.x = -400; cur.y = 0; cur.z = 0; cur.yaw = DIR.xPlus;

  /* ---------------- 1 : DROP IN ----------------
     A trough with a floor for the first third. Walk it and friction holds you
     at 250 for ever; strafe into either wall and you are surfing. The floor
     runs out long before the stage does. */
  stage("DROP IN", "Strafe into a wall and hold it. The floor runs out at the halfway mark.", NEON.teal);
  sign(600, 560, 0, "1 — DROP IN", { color: NEON.teal, rotY: facing(DIR.xPlus), w: 480 });
  sign(1500, 430, 0, "HOLD  A  AND KEEP TURNING LEFT", {
    color: NEON.teal, sub: "the left wall climbs when you push into it", rotY: facing(DIR.xPlus), w: 640,
  });
  trough({ len: 5200, width: 900, angle: 52, gap: 460, floorLen: 1500 });
  sign(2900, 520, -700, "NO FLOOR PAST HERE", { color: NEON.rose, rotY: facing(DIR.xPlus), w: 520 });
  const pad1 = pad({ len: 2600, wide: 2800, drop: 460, mat: MATS.check, edge: NEON.lime });
  checkpoint(pad1, "DROP IN");

  /* ---------------- 2 : SWITCHBACK ----------------
     Single ramps, void on both sides, alternating which way they lean. Every
     transition is a real flight: you leave one face and land on the next one
     already tilted the other way. */
  enterStage(pad1, DIR.zPlus, { lateral: 260 });
  stage("SWITCHBACK", "One wall at a time, leaning the other way each hop. Flip your strafe in the air.", NEON.cyan);
  sign(cur.x, cur.y + 620, cur.z + 500, "2 — SWITCHBACK", { color: NEON.cyan, rotY: facing(DIR.zPlus), w: 520 });
  let pad2;
  {
    const seq = [
      { high: 'L', len: 3600, gapAfter: 520, speed: 620 },
      { high: 'R', len: 2400, gapAfter: 620, speed: 700 },
      { high: 'L', len: 2400, gapAfter: 700, speed: 760 },
      { high: 'R', len: 2600, gapAfter: 0, speed: 800 },
    ];
    for (const s of seq) {
      ramp({ len: s.len, width: 860, angle: 55, high: s.high, enter: 0.34 });
      if (s.gapAfter) gap(s.gapAfter, s.speed);
    }
    pad2 = pad({ len: 2600, wide: 2800, drop: 520, mat: MATS.check, edge: NEON.lime });
    checkpoint(pad2, "SWITCHBACK");
  }

  /* ---------------- 3 : THE BEND ----------------
     A trough that turns ninety degrees in ten steps. Straight-line strafing
     dies here: the wall keeps rotating out from under your velocity and you
     have to keep turning with it or get spat out the open side. */
  enterStage(pad2, DIR.xMinus, { lateral: 0 });
  stage("THE BEND", "The wall turns under you for ninety degrees. Keep turning with it.", NEON.violet);
  sign(cur.x - 500, cur.y + 620, cur.z, "3 — THE BEND", { color: NEON.violet, rotY: facing(DIR.xMinus), w: 520 });
  let pad3;
  {
    const N = 10;
    for (let i = 0; i < N; i++) {
      trough({ len: 900, width: 820, angle: 54, gap: 520, thick: 240, anchor: 'ride' });
      cur.yaw -= (Math.PI / 2) / N;                     // bend to the traveller's right
    }
    trough({ len: 1200, width: 820, angle: 54, gap: 520, thick: 240, anchor: 'ride' });
    pad3 = pad({ len: 2400, wide: 2600, drop: 480, mat: MATS.check, edge: NEON.lime });
    checkpoint(pad3, "THE BEND");
  }

  /* ---------------- 4 : THE GAP ----------------
     Short, steep faces with real air between them. There is nothing to catch
     you: the only thing that crosses a 1100-unit hole is speed you already
     had when you left the last ramp. */
  enterStage(pad3, DIR.zMinus, { lateral: 300 });
  stage("THE GAP", "Steep and short, with real air between. Leave every ramp faster than you arrived.", NEON.rose);
  sign(cur.x, cur.y + 640, cur.z - 500, "4 — THE GAP", { color: NEON.rose, rotY: facing(DIR.zMinus), w: 520 });
  let pad4;
  {
    const seq = [
      { high: 'L', len: 1700, gapAfter: 800, speed: 780 },
      { high: 'R', len: 1600, gapAfter: 950, speed: 850 },
      { high: 'L', len: 1600, gapAfter: 1050, speed: 900 },
      { high: 'R', len: 1800, gapAfter: 0, speed: 950 },
    ];
    for (const s of seq) {
      ramp({ len: s.len, width: 900, angle: 58, high: s.high, enter: 0.38 });
      if (s.gapAfter) gap(s.gapAfter, s.speed);
    }
    pad4 = pad({ len: 2600, wide: 2800, drop: 540, mat: MATS.check, edge: NEON.lime });
    checkpoint(pad4, "THE GAP");
  }

  /* ---------------- 5 : THE SPINE ----------------
     One face, sixty degrees, seven thousand units long, nothing under it.
     No wall opposite to save a bad line — the whole stage is a single held
     strafe, and the finish is at the end of it. */
  enterStage(pad4, DIR.xPlus, { lateral: 340 });
  stage("THE SPINE", "One face. Sixty degrees. Seven thousand units. Do not touch the low edge.", NEON.amber);
  sign(cur.x + 500, cur.y + 660, cur.z, "5 — THE SPINE", { color: NEON.amber, rotY: facing(DIR.xPlus), w: 520 });
  {
    ramp({ len: 3600, width: 1000, angle: 60, high: 'L', enter: 0.40 });
    gap(700, 900);
    ramp({ len: 3400, width: 1000, angle: 60, high: 'L', enter: 0.34 });
  }

  /* ---------------- finish ---------------- */
  stage("FINISH", "", NEON.amber);
  {
    const p = pad({ len: 2600, wide: 2600, drop: 560, mat: MATS.finish, edge: NEON.amber });
    const t = tvec(cur.yaw);
    zone(p.x, p.z, p.w, p.d, p.y, 2600, { kind: "finish" });
    gate(p.x + t.x * (p.len / 2 - 260), p.z + t.z * (p.len / 2 - 260), 900, p.y, 340, NEON.amber, { kind: "none" }, 60, cur.yaw);
    block(p.x, p.z, 420, 420, p.y, 30, MATS.finish, { edge: NEON.amber });
    sign(p.x, p.y + 560, p.z, "FINISH", { color: NEON.amber, rotY: facing(cur.yaw), w: 600 });
    pointGlow(p.x, p.y + 320, p.z, NEON.amber, 2.0, 2200);
    MAP.finishPad = { x: p.x, y: p.y, z: p.z };
  }
  MAP.stages[MAP.stages.length - 1].floorY = stageFloor - 700;

  /* ---------------- scenery & bounds ---------------- */
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of MAP.route) {
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
    b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
  }
  MAP.bounds = b;

  /* Scenery. The void needs a sense of scale or 1000 u/s feels like 200 — but
     a pillar standing in the middle of a ramp is worse than no pillar at all,
     so anything that lands near the ride line is thrown away and re-rolled. */
  let seed = 90210;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pal = [NEON.violet, NEON.rose, NEON.cyan, NEON.teal];
  const CLEAR = 2400;
  const clearOfRoute = (x, z) => !MAP.route.some(p => Math.hypot(p.x - x, p.z - z) < CLEAR);
  for (let i = 0, tries = 0; i < 24 && tries < 600; tries++) {
    const x = b.minX - 4000 + rnd() * (b.maxX - b.minX + 8000);
    const z = b.minZ - 4000 + rnd() * (b.maxZ - b.minZ + 8000);
    if (!clearOfRoute(x, z)) continue;
    monolith(x, z, 160 + rnd() * 380, b.minY + rnd() * (b.maxY - b.minY), pal[i % pal.length]);
    i++;
  }
  for (const s of MAP.stages) {
    const wp = MAP.route.find(p => p.stage === s.i);
    if (wp) pointGlow(wp.x, wp.y + 500, wp.z, s.color, 1.3, 3600);
  }

  return MAP;
}

/* ---------------- route analysis (used by the tests) ---------------- */

/** Horizontal distance a fall of `drop` covers at `speed`. */
export function airDistance(speed, drop) { return speed * Math.sqrt(Math.max(0, 2 * drop / G)); }

/** Every air section on the ride line, and the speed it was authored for. */
export function airSections() {
  const out = [];
  for (let i = 1; i < MAP.route.length; i++) {
    if (MAP.route[i].kind !== "air") continue;
    const a = MAP.route[i - 1], b = MAP.route[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const drop = a.y - b.y;
    out.push({ stage: b.stage, span, drop, need: drop > 0 ? span / Math.sqrt(2 * drop / G) : Infinity });
  }
  return out;
}
