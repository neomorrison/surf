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
  view.pitch = 0;
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

  // The field of view is whatever the player set it to and nothing else. A FOV
  // that widens with speed reads as speed you did not earn, and it moves the
  // ramp edge under your crosshair while you are trying to hold a line.
  if (Math.abs(view.fov - SETTINGS.fov) > 0.01) {
    view.fov = SETTINGS.fov;
    camera.fov = view.fov; camera.updateProjectionMatrix();
  }

  camera.position.set(x, y + view.eye, z);
  // No roll. The camera is level, always: a horizon that tips when you press a
  // key is one more thing moving in a frame where the only thing that should be
  // moving is the ramp.
  camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
  followSun(x, y, z);
}
