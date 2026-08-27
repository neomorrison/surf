/* ============================== [surf_helix] ==============================
   Five stages spiralling 5,800 units down through the void, each ending on a
   catch pad with a checkpoint. Falling puts you back on the last one with the
   clock still running, which is the only punishment a surfer respects.

   Bunnyhopping is left ON here: the floor at the start of DROP IN is meant to
   be hopped, and the pads between stages are meant to be crossed with speed
   you built on them. surf_aircontrol is the map that runs the strict timer
   rules.                                                                    */
import {
  MAP, DIR, facing, cur, tvec, uvec, beginMap, endMap,
  gap, ramp, trough, pad, enterStage, stage, checkpoint,
} from '../mapkit.js';
import { block, wall, zone, gate, sign, decal, voidGrid, pointGlow, monolith, MATS, NEON } from '../world.js';

export const meta = {
  id: "helix",
  name: "surf_helix",
  blurb: "Five stages, four checkpoints. Bunnyhopping on. Falling costs you the clock, not the run.",
};

export function build() {
  beginMap({
    ...meta,
    spawn: { x: -1750, y: 0, z: 0, yaw: -Math.PI / 2 },   // view yaw -90deg looks down +X
    rules: { bunnyhopping: true, oneShot: false },
  });
  cur.yaw = DIR.xPlus;

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
  /* ---------------- scenery ---------------- */
  const b = endMap().bounds;

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

