/* ============================== [PLAYER] ==============================
   The physics body plus everything the camera needs: view angles, eye
   smoothing, the lean and the speed-driven FOV.

   Note what is NOT here — the camera reads the body, it never writes to it.
   No view-based steering, no assisted turning. The lean in particular is
   cosmetic: it tells you which key you are holding and which way the ramp
   under you is tilted, and it never touches a single unit of velocity.    */
import { camera, followSun } from './core.js';
import { MOVE, SETTINGS } from './config.js';
import { makeBody } from './physics.js';
import { MAP } from './map.js';

export const view = {
  body: makeBody(),
  yaw: 0, pitch: 0,
  prev: { x: 0, y: 0, z: 0 },       // position at the previous tick, for render interpolation
  eye: MOVE.eyeStand,
  roll: 0,
  fov: SETTINGS.fov,
  keys: {}, sync: 0, gainPerSec: 0, turnRate: 0,
  sideInput: 0,
};

export function spawnAt(p) {
  const b = view.body;
  b.pos.x = p.x; b.pos.y = p.y; b.pos.z = p.z;
  b.vel.x = b.vel.y = b.vel.z = 0;
  b.onGround = false; b.ducking = false; b.hullHeight = MOVE.standHeight;
  b.speed = 0; b.gain = 0; b.surfRamp = null;
  view.prev = { ...b.pos };
  if (p.yaw != null) view.yaw = p.yaw;
  view.pitch = 0; view.roll = 0;
  view.eye = MOVE.eyeStand;
  view.sync = 0; view.gainPerSec = 0;
}

export function resetPlayer() { spawnAt(MAP.spawn); }

/** Called right before each physics tick so interpolation has both endpoints. */
export function beginTick() {
  view.prev.x = view.body.pos.x; view.prev.y = view.body.pos.y; view.prev.z = view.body.pos.z;
}

/**
 * Place the camera. `alpha` is the fraction of a tick left over this frame,
 * so the view is smooth at any frame rate above or below the 128Hz sim.
 */
export function updateCamera(alpha, dt) {
  const b = view.body;
  const x = view.prev.x + (b.pos.x - view.prev.x) * alpha;
  const y = view.prev.y + (b.pos.y - view.prev.y) * alpha;
  const z = view.prev.z + (b.pos.z - view.prev.z) * alpha;

  // eye height eases when you duck so a crouch does not snap the world
  const targetEye = b.ducking ? MOVE.eyeDuck : MOVE.eyeStand;
  view.eye += (targetEye - view.eye) * Math.min(1, dt * 16);

  /* Lean. Two sources: the strafe key you are holding, and the tilt of the
     ramp under you. The second is the useful one — on a face you cannot see
     the horizon, and the roll is what tells you which way "up the slope" is. */
  let targetRoll = 0;
  if (SETTINGS.viewRoll) {
    targetRoll = -view.sideInput * (b.onGround ? 0.020 : 0.040);
    const r = b.surfRamp;
    if (r) {
      // sign of the ramp's tilt as seen from where you are looking
      const lean = r.n.x * Math.cos(view.yaw) - r.n.z * Math.sin(view.yaw);
      targetRoll += Math.max(-0.16, Math.min(0.16, lean * 0.28));
    }
  }
  view.roll += (targetRoll - view.roll) * Math.min(1, dt * 8);

  // FOV opens up with speed. It starts at the free 250, so any widening at all
  // is speed you strafed for.
  const kick = Math.max(0, Math.min(26, (b.speed - MOVE.maxSpeed) / 30));
  const targetFov = SETTINGS.fov + kick;
  if (Math.abs(view.fov - targetFov) > 0.02) {
    view.fov += (targetFov - view.fov) * Math.min(1, dt * 5);
    camera.fov = view.fov; camera.updateProjectionMatrix();
  }

  camera.position.set(x, y + view.eye, z);
  camera.rotation.set(view.pitch, view.yaw, view.roll, 'YXZ');
  followSun(x, y, z);
}
