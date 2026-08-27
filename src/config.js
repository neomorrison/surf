/* ============================== [CONFIG] ==============================
   Movement CVars and user settings.

   These are the Source-engine movement constants. Two of them are the whole
   game:

     walkableNormalY  a surface steeper than this cannot be stood on. You do
                      not land on a surf ramp — you are permanently airborne
                      and merely have your velocity clipped along it, once
                      per tick, forever. That is what surfing is.

     airWishCap       Source clamps the *target* speed of air acceleration to
                      30 u/s. Holding a direction you are already moving in
                      faster than 30 u/s gives nothing, so speed can only come
                      from a wish vector held sideways of your velocity and
                      rotated with the mouse, tick after tick, by hand.

   There is no auto-strafe, no speed multiplier and no directional assist
   anywhere in this project.                                                */

export const MOVE = {
  /* simulation */
  tick: 1 / 128,           // fixed timestep — air acceleration is a per-tick sum, so the
                           // rate has to be fixed or a 240Hz machine would out-gain a 60Hz one
  maxSubSteps: 24,         // catch-up cap after a stall / tab-out

  /* world */
  gravity: 800,            // sv_gravity
  maxVelocity: 3500,       // sv_maxvelocity — absolute clamp per axis

  /* ground */
  maxSpeed: 250,           // player max ground speed
  stopSpeed: 100,          // sv_stopspeed
  friction: 5.2,           // sv_friction
  accelerate: 6.5,         // sv_accelerate
  walkSpeedMul: 0.52,      // Shift
  duckSpeedMul: 0.34,      // fully ducked

  /* air — every unit of speed on a surf ramp comes through here */
  airAccelerate: 100,      // sv_airaccelerate
  airWishCap: 30,          // THE rule. See the header.

  /* jumping */
  jumpVel: 301.993,        // the CS jump apex of ~57 units at g=800
  bunnyhopFactor: 1.2,     // BUNNYJUMP_MAX_SPEED_FACTOR. With bunnyhopping disabled, Source
                           // scales your velocity back to 1.2 x maxSpeed on the tick you
                           // jump — so 300 u/s, and a hop can never hand you anything.

  /* hull */
  radius: 16,              // half-width of the (square, Source-style) player hull
  standHeight: 72,
  duckHeight: 54,
  eyeStand: 64,
  eyeDuck: 46,
  stepHeight: 18,          // ledges you walk up without jumping
  duckTuck: 16,            // extra ledge reach from tucking your legs mid-air

  /* surfaces */
  walkableNormalY: 0.7,    // cos(45.57 deg). Anything steeper is a surf ramp, not a floor.

  /* solver */
  subStepLen: 7,           // max world units advanced between collision passes
  maxRampPush: 96,         // deeper than this into a ramp and it is treated as a wall,
                           // not as a surface to be lifted onto
};

/* ============================== server rules ==============================
   The settings a surf server actually runs, as opposed to the movement
   constants above. A map declares these and buildMap() applies them, so the
   rulebook in physics.js stays free of any dependency on map data.        */

const DEFAULT_RULES = {
  bunnyhopping: true,      // sv_enablebunnyhopping. false = the 1.2x jump cap above,
                           // which is what every surf timer server runs: on those
                           // servers a hop is a way to move, never a way to gain.
  oneShot: false,          // no checkpoints — a fall ends the run and restarts the clock
};

export const RULES = { ...DEFAULT_RULES };

/** Replace the rule set wholesale. Anything a map does not name goes back to default. */
export function applyRules(o) {
  for (const k in DEFAULT_RULES) RULES[k] = DEFAULT_RULES[k];
  if (o) for (const k in o) if (k in RULES) RULES[k] = o[k];
  return RULES;
}

/* Angle helpers — maps are authored in degrees because that is how a surf
   ramp is actually thought about ("a 55 is rideable, a 70 is not"). */
export const slopeOf = deg => Math.tan(deg * Math.PI / 180);
export const normalYOf = deg => Math.cos(deg * Math.PI / 180);

/* ---------------- user settings (persisted) ---------------- */
const LS_KEY = "surf.settings.v1";

export const SETTINGS = {
  sensitivity: 2.2,        // ~CS 2.2 @ 800dpi feel
  fov: 90,
  autoHop: true,           // hold Space to re-jump on landing (start room only — you
                           // cannot jump while surfing, because you are never grounded)
  showKeys: true,
  showSync: true,
  showGhost: true,         // replay of your personal best
  viewRoll: true,          // camera leans into the strafe you are holding
  sound: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(SETTINGS, JSON.parse(raw));
  } catch (e) { /* private mode / disabled storage — defaults are fine */ }
  return SETTINGS;
}
export function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
}
