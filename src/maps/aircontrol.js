/* ============================== [surf_aircontrol] ==============================
   An air-control course, in the tradition of the KSF-timer air_control maps: a
   single unbroken run down one corridor, where the ramps are generous and the
   *flights between them* are the difficulty. Every gap lands you hundreds of
   units to one side of where you were pointing, so the skill being asked for
   is not holding a face — it is steering while you are not touching anything.

   This is an original course built to that shape. It is not a port of any
   existing community map and shares no geometry with one; what it borrows is
   the format.

   It runs the rules a surf timer server runs, and they change the game:

     bunnyhopping OFF   the tick you jump, Source scales your horizontal speed
                        back to 1.2 x maxSpeed. Hopping is a way to move around
                        the start platform and nothing else.
     prespeed 350       a zone over the spawn clamps you before the gate, so
                        nobody arrives at ramp one with speed they did not earn
                        on a ramp.
     one shot           there are no checkpoints. Fall off and the run is over.

   Together those mean every unit above 300 u/s in a finishing time came off a
   ramp face, which is the entire claim a surf time makes.                    */
import {
  MAP, DIR, facing, cur, beginMap, endMap, killUnderRoute,
  gap, ramp, pad, stage, mark,
} from '../mapkit.js';
import { block, wall, zone, gate, sign, decal, voidGrid, pointGlow, monolith, MATS, NEON } from '../world.js';

export const meta = {
  id: "aircontrol",
  name: "surf_aircontrol",
  blurb: "One shot, six ramps, no checkpoints. Timer-server rules: no bhop gain, 350 prespeed.",
};

const PRESPEED = 350;

export function build() {
  beginMap({
    ...meta,
    spawn: { x: -760, y: 0, z: 0, yaw: -Math.PI / 2 },   // view yaw -90deg looks down +X
    rules: { bunnyhopping: false, oneShot: true },
    prespeed: PRESPEED,
  });

  voidGrid(-11000, 46000, 90, 0x2d6f8a, 0x1a3550);

  /* ---------------- start ----------------
     Nine hundred units of platform, and then the first face. There is no
     run-up worth having and there is not meant to be: you leave here at a
     walk whatever you do, and everything after this you take off a ramp. */
  stage("START", "Walk off the edge. The face is right there.", NEON.lime);
  block(-450, 0, 900, 900, -70, 70, MATS.start, { edge: NEON.lime });
  wall(-900, 0, 40, 900, 0, 420);
  wall(-450, -450, 900, 40, 0, 420);
  wall(-450, 450, 900, 40, 0, 420);

  /* The prespeed zone. Real timer servers clamp you inside the start area so a
     run cannot begin with speed carried in from outside it; here there is
     nowhere to carry speed in from, but the rule is the rule. */
  zone(-450, 0, 900, 900, -80, 700, { kind: "prespeed", cap: PRESPEED });

  sign(-160, 560, 0, "SURF_AIRCONTROL", { color: NEON.cyan, rotY: facing(DIR.xPlus), w: 540 });
  sign(-160, 370, 0, "ONE SHOT   ·   NO CHECKPOINTS", {
    color: NEON.rose, sub: "fall off anywhere and the run is over", rotY: facing(DIR.xPlus), w: 620,
  });
  gate(-70, 0, 860, 0, 300, NEON.lime, { kind: "start" }, 40, DIR.xPlus);
  sign(-70, 340, 0, "START", { color: NEON.lime, rotY: facing(DIR.xPlus), w: 220 });
  pointGlow(-560, 300, 0, NEON.lime, 1.0, 1600);

  /* ---------------- the run ---------------- */
  cur.x = 0; cur.y = 0; cur.z = 0; cur.yaw = DIR.xPlus;
  stage("AIR CONTROL", "Six faces. The flights between them are the map.", NEON.cyan);

  // 170 units past the lip and 171 below it: you step off and you are on it.
  gap(170, 260, { mark: false });

  /* Each flight asks for more speed than the last and moves you further
     sideways than the last: 700 u/s and 420 across, up to 1150 and 900. The
     drop follows from the time in the air, so the flights are kept short in
     *time* on purpose — a long hang would turn the map into a drop tower and
     hand you speed that gravity earned instead of you. */
  const RUN = [
    { len: 3800, width: 1150, angle: 48, high: 'L', enter: 0.42, color: NEON.teal,
      after: { len: 800, speed: 700, lateral: 420 } },
    { len: 2600, width: 1100, angle: 51, high: 'R', enter: 0.40, color: NEON.cyan,
      after: { len: 950, speed: 820, lateral: -560, gate: { w: 820, h: 900, color: NEON.cyan } } },
    { len: 2400, width: 1050, angle: 53, high: 'L', enter: 0.40, color: NEON.cyan,
      after: { len: 1100, speed: 920, lateral: 680 } },
    { len: 2300, width: 1000, angle: 55, high: 'R', enter: 0.38, color: NEON.violet,
      after: { len: 1250, speed: 1000, lateral: -800, gate: { w: 780, h: 860, color: NEON.violet } } },
    { len: 2200, width: 1000, angle: 56, high: 'L', enter: 0.38, color: NEON.violet,
      after: { len: 1400, speed: 1080, lateral: 900 } },
    { len: 2600, width: 1000, angle: 57, high: 'R', enter: 0.36, color: NEON.rose,
      after: { len: 1200, speed: 1150, lateral: 0 } },
  ];

  RUN.forEach((seg, i) => {
    ramp({ len: seg.len, width: seg.width, angle: seg.angle, high: seg.high, enter: seg.enter, color: seg.color, thick: 300 });
    if (i === 0) {
      sign(cur.x - seg.len * 0.55, cur.y + 620, cur.z, "1 — THE LONG ONE", {
        color: NEON.teal, sub: "eight seconds of face. Take everything it will give you.",
        rotY: facing(DIR.xPlus), w: 640,
      });
    }
    if (seg.after) gap(seg.after.len, seg.after.speed, seg.after);
  });

  /* ---------------- finish ---------------- */
  stage("FINISH", "", NEON.amber);
  {
    const p = pad({ len: 2800, wide: 3000, drop: 640, mat: MATS.finish, edge: NEON.amber });
    zone(p.x, p.z, p.w, p.d, p.y, 2800, { kind: "finish" });
    gate(p.x + p.len / 2 - 280, p.z, 1000, p.y, 360, NEON.amber, { kind: "none" }, 60, DIR.xPlus);
    block(p.x, p.z, 440, 440, p.y, 30, MATS.finish, { edge: NEON.amber });
    sign(p.x, p.y + 580, p.z, "FINISH", { color: NEON.amber, rotY: facing(DIR.xPlus), w: 620 });
    pointGlow(p.x, p.y + 340, p.z, NEON.amber, 2.0, 2400);
    decal(p.x, p.z, p.w * 0.9, p.d * 0.9, p.y, NEON.amber, 0.08);
    MAP.finishPad = { x: p.x, y: p.y, z: p.z };
  }

  const b = endMap().bounds;

  /* One slab under each segment of the ride line, at that segment's own depth.
     A single kill height would sit eight thousand units below ramp one. */
  killUnderRoute(700, 3000);

  /* ---------------- scenery ---------------- */
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pal = [NEON.violet, NEON.cyan, NEON.teal, NEON.rose];
  const CLEAR = 3000;
  const clearOfRoute = (x, z) => !MAP.route.some(p => Math.hypot(p.x - x, p.z - z) < CLEAR);
  for (let i = 0, tries = 0; i < 26 && tries < 800; tries++) {
    const x = b.minX - 4000 + rnd() * (b.maxX - b.minX + 8000);
    const z = b.minZ - 5000 + rnd() * (b.maxZ - b.minZ + 10000);
    if (!clearOfRoute(x, z)) continue;
    monolith(x, z, 180 + rnd() * 420, b.minY + rnd() * (b.maxY - b.minY), pal[i % pal.length]);
    i++;
  }
  for (const p of MAP.route) {
    if (p.kind === "ramp") pointGlow(p.x, p.y + 420, p.z, NEON.cyan, 0.9, 2600);
  }

  return MAP;
}
