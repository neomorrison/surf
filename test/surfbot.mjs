/* ============================== [SURFBOT] ==============================
   A headless surfer that plays by exactly the rules a human has: one strafe
   key at a time, and a mouse that can only turn so fast.

   It exists so the course can be *proved* runnable rather than asserted.
   Two rules run the whole thing:

     on a ramp   aim the wish vector perpendicular to your velocity, on
                 whichever side moves you toward a target line up the face —
                 damped by how fast you are already climbing, so it holds a
                 line instead of bouncing off
     in the air  aim it perpendicular to your velocity, on whichever side
                 rotates you toward where you have to land

   Perpendicular is provably optimal: any component along your velocity eats
   into the 30 u/s wish cap and buys nothing. So this bot is close to the
   speed ceiling, and where it fails, the course is at fault.              */
import { MOVE } from '../src/config.js';
import { makeBody, playerMove, rampLocal, rampUphill } from '../src/physics.js';

const TICK = MOVE.tick;
export const MAX_TURN = 0.030;              // radians per tick — about 3.8 rad/s of mouse
const CLIMB_GAIN = 1.1;                     // u/s of climb wanted per unit below the line
const RIDE_HEIGHT = 0.45;                   // where up the face the bot tries to sit

export function makeBot(route, start, idx, yaw = 0) {
  return {
    route, body: makeBody(start.x, start.y, start.z),
    yaw, side: 1, hold: 1, idx, ticks: 0, peak: 0, maxTurn: 0, surfTicks: 0, airTicks: 0,
  };
}

/** The next ride-line point the bot still has to reach. */
export function target(bot) {
  const R = bot.route;
  while (bot.idx < R.length - 1) {
    const w = R[bot.idx];
    const t = { x: Math.sin(w.yaw), z: Math.cos(w.yaw) };
    if ((bot.body.pos.x - w.x) * t.x + (bot.body.pos.z - w.z) * t.z > -120) { bot.idx++; continue; }
    return w;
  }
  return R[R.length - 1];
}

export function step(bot) {
  const b = bot.body, v = b.vel;
  const sp = Math.hypot(v.x, v.z);
  const wp = target(bot);
  let cmd;

  if (b.onGround || sp < 30) {
    // on a pad: run at the next waypoint and hop. No cleverness required.
    const yaw = Math.atan2(-(wp.x - b.pos.x), -(wp.z - b.pos.z));   // forward = (-sin, -cos)
    bot.yaw = yaw;
    cmd = { forward: 1, side: 0, yaw, jump: b.onGround, duck: false, walk: false };
  } else {
    const vx = v.x / sp, vz = v.z / sp;
    const p = { x: -vz, z: vx };                    // one of the two perpendiculars
    let want;
    const r = b.surfRamp;
    if (r) {
      const { u } = rampLocal(r, b.pos.x, b.pos.z);
      const s = r.slope >= 0 ? 1 : -1;
      const uTarget = s * (RIDE_HEIGHT * 2 - 1) * r.halfU;
      const up = rampUphill(r);
      const climbRate = v.x * up.x + v.z * up.z;    // how fast we are already going up the face
      // Sliding-mode: chase a climb rate, not a position. Without the damping
      // term this chatters, throws the hull off the plane, and every re-contact
      // clips speed away — which is exactly what a panicking human does too.
      const err = CLIMB_GAIN * (uTarget - u) * s - climbRate;
      const climb = err >= 0 ? 1 : -1;
      want = (p.x * up.x + p.z * up.z) * climb >= 0 ? 1 : -1;
      bot.surfTicks++;
    } else {
      const dx = wp.x - b.pos.x, dz = wp.z - b.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      const cross = vx * (dz / dl) - vz * (dx / dl);
      want = (p.x * (dx / dl) + p.z * (dz / dl)) >= 0 ? 1 : -1;
      if (Math.abs(cross) < 0.02) want = bot.hold;  // already aimed: keep gaining, do not wobble
      bot.airTicks++;
    }
    bot.hold = want;
    const w = want > 0 ? p : { x: -p.x, z: -p.z };
    // The two perpendiculars are 180 degrees apart, which is a key flip, not a
    // mouse flick: yaw stays continuous and only the strafe key changes.
    let d = Math.atan2(-w.z, w.x) - bot.yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    let flip = false;
    if (Math.abs(d) > Math.PI / 2) { d += d > 0 ? -Math.PI : Math.PI; flip = true; }
    const turn = Math.max(-MAX_TURN, Math.min(MAX_TURN, d));
    bot.maxTurn = Math.max(bot.maxTurn, Math.abs(turn));
    bot.yaw += turn;
    cmd = { forward: 0, side: flip ? -1 : 1, yaw: bot.yaw, jump: false, duck: false, walk: false };
    bot.side = cmd.side;
  }

  playerMove(b, cmd, TICK);
  bot.ticks++;
  if (b.speed > bot.peak) bot.peak = b.speed;
  return cmd;
}
