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
  accelerate: 10,          // sv_accelerate — the value surf servers actually run
  walkSpeedMul: 0.52,      // Shift
  duckSpeedMul: 0.34,      // fully ducked

  /* air — every unit of speed on a surf ramp comes through here */
  airAccelerate: 150,      // sv_airaccelerate. Surf servers run 100-150; anything above
                           // about 16 saturates against the 30 u/s wish cap on every tick,
                           // so the exact number changes nothing. The cap is the game.
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
   The settings a surf server runs, as opposed to the movement constants
   above. These are global: every course in this game plays by the same
   movement rules, the way every map on a given server does.

   They live here, and not in map data, because physics.js deliberately
   imports nothing but this file — the rulebook must not be able to reach
   into a map.                                                             */

export const RULES = {
  /**
   * sv_enablebunnyhopping. With it off — which is what every surf timer
   * server runs — Source scales your velocity back to
   * BUNNYJUMP_MAX_SPEED_FACTOR x m_flMaxspeed on the tick you jump. Hopping
   * is then a way to move, never a way to gain.
   */
  bunnyhopping: false,

  /**
   * The ceiling on your speed inside a start zone, in u/s. This one is not an
   * engine cvar: prespeed limits are a timer-plugin feature and the number is
   * a server's choice, with 300-350 the usual range on surf. It is enforced
   * continuously while you are inside the zone, and every map's zone is built
   * to reach its first ramp face, so it is not possible to touch a ramp
   * faster than this.
   */
  prespeedCap: 350,
};

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
