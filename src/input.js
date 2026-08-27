/* ============================== [INPUT] ==============================
   Keyboard, mouse look and pointer lock.

   Mouse deltas are ACCUMULATED per frame and then handed out one simulation
   tick at a time (see consumeLook). That matters more here than anywhere:
   air acceleration is a per-tick calculation and a surf ramp is thirty
   straight seconds of it, so applying a whole frame's turn before the first
   tick would make a 60Hz machine gain differently from a 240Hz one.        */
import { MOVE, SETTINGS } from './config.js';

export const keys = Object.create(null);
export const mouse = { dx: 0, dy: 0, locked: false };

/* CS mouse maths: 0.022 degrees of yaw per count, scaled by sensitivity. */
const RAD_PER_COUNT = 0.022 * Math.PI / 180;

let jumpEdges = 0;              // fresh jump presses waiting to be consumed
let suspended = false;          // a menu is open — swallow gameplay input

export const bindings = {
  forward: ["KeyW"], back: ["KeyS"], left: ["KeyA"], right: ["KeyD"],
  jump: ["Space"], duck: ["ControlLeft", "KeyC"], walk: ["ShiftLeft"],
};
const down = list => list.some(k => keys[k]);

export function setSuspended(v) {
  suspended = v;
  if (v) { for (const k in keys) keys[k] = false; mouse.dx = mouse.dy = 0; }
}
export function isSuspended() { return suspended; }

/* ---------------- listeners ---------------- */
export function initInput(canvas, hooks = {}) {
  addEventListener('keydown', e => {
    if (e.repeat) { if (!suspended) e.preventDefault(); return; }
    if (hooks.onKey && hooks.onKey(e.code, e) === true) { e.preventDefault(); return; }
    if (suspended) return;
    keys[e.code] = true;
    if (bindings.jump.includes(e.code)) jumpEdges++;
    // Ctrl+W closes the tab and Space scrolls the page — neither is negotiable
    // to swallow in a game that uses both.
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ControlLeft", "Tab"].includes(e.code)) e.preventDefault();
    if (e.ctrlKey) e.preventDefault();
  });
  addEventListener('keyup', e => {
    keys[e.code] = false;
    if (hooks.onKeyUp) hooks.onKeyUp(e.code, e);
  });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  addEventListener('mousemove', e => {
    if (!mouse.locked || suspended) return;
    mouse.dx += e.movementX; mouse.dy += e.movementY;
  });

  // Scroll-jump. Every Source player binds the wheel to +jump, because a wheel
  // notch is a far more precise way to hit the one tick you are on the ground
  // than a key press is. It is timing, never direction — and on a ramp you are
  // never grounded, so it does nothing at all.
  addEventListener('wheel', e => {
    if (!mouse.locked || suspended) return;
    jumpEdges++;
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (suspended || !mouse.locked) return;
    if (e.button === 0 || e.button === 1) jumpEdges++;      // LMB also jumps — one less thing to learn
  });

  document.addEventListener('pointerlockchange', () => {
    mouse.locked = document.pointerLockElement === canvas;
    if (hooks.onLockChange) hooks.onLockChange(mouse.locked);
  });
  canvas.addEventListener('click', () => {
    if (suspended || mouse.locked) return;
    try { canvas.requestPointerLock()?.catch?.(() => {}); } catch (e) {}
  });
  addEventListener('contextmenu', e => e.preventDefault());
}

/* ---------------- per-frame / per-tick ---------------- */

/**
 * Split this frame's mouse movement into `steps` equal turns, so the amount of
 * air acceleration a strafe earns does not depend on the frame rate.
 */
export function consumeLook(view, steps) {
  const k = RAD_PER_COUNT * SETTINGS.sensitivity;
  const yawStep = -(mouse.dx / steps) * k;
  const pitchStep = -(mouse.dy / steps) * k;
  return () => {
    view.yaw += yawStep;
    view.pitch = Math.max(-1.55, Math.min(1.55, view.pitch + pitchStep));
  };
}
export function clearLook() { mouse.dx = 0; mouse.dy = 0; }

/**
 * The command for one tick. `jump` is true when the player is asking to jump
 * NOW: either a fresh press/wheel notch, or — with auto-hop on — Space held.
 * Auto-hop only ever answers "when", never "where", and it cannot help you on
 * a ramp: jumping needs ground, and a surf ramp is never ground.
 */
export function buildCommand(view, tickIndex) {
  const held = down(bindings.jump);
  let jump = false;
  if (SETTINGS.autoHop) jump = held || jumpEdges > 0;
  else if (jumpEdges > 0) { jump = true; }
  if (jump && jumpEdges > 0 && tickIndex === 0) jumpEdges = Math.max(0, jumpEdges - 1);

  return {
    forward: (down(bindings.forward) ? 1 : 0) - (down(bindings.back) ? 1 : 0),
    side: (down(bindings.right) ? 1 : 0) - (down(bindings.left) ? 1 : 0),
    yaw: view.yaw,
    jump,
    duck: down(bindings.duck),
    walk: down(bindings.walk),
  };
}
/** Drop any unconsumed jump edges (called once per frame after the ticks run). */
export function endFrame() { jumpEdges = 0; }

export function keyState() {
  return {
    w: down(bindings.forward), a: down(bindings.left), s: down(bindings.back), d: down(bindings.right),
    jump: down(bindings.jump), duck: down(bindings.duck),
  };
}
