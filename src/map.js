/* ============================== [MAP] ==============================
   The map registry. Courses live in src/maps/ and are written in the
   authoring language in mapkit.js; this file only decides which one is
   currently built.

   `MAP` is repopulated in place rather than replaced, so every other module
   can import it once and keep the binding across a map change.            */
import { MAP, DIR } from './mapkit.js';
import { MOVE } from './config.js';
import * as aircontrol from './maps/aircontrol.js';
import * as helix from './maps/helix.js';

export { MAP, DIR };

export const MAPS = [aircontrol, helix].map(m => ({ ...m.meta, build: m.build }));

/**
 * Courses from `local/`, which is gitignored and never deployed.
 *
 * This is where a map you own goes. Content you did not make stays on your own
 * machine: it cannot end up in the public repository or on the Pages build,
 * because the directory it lives in is not in the repository at all. The
 * import is dynamic and its absence is normal — the game runs without it.
 */
export async function loadLocalMaps() {
  try {
    const mod = await import('../local/index.js');
    const extra = (mod.maps || []).filter(m => m && m.id && m.build);
    for (const m of extra) if (!MAPS.some(e => e.id === m.id)) MAPS.push({ local: true, ...m });
    return extra.length;
  } catch (e) {
    return 0;                                         // no local/index.js: expected
  }
}

export const DEFAULT_MAP = "aircontrol";

/** Build a course by id. Falls back to the default rather than throwing. */
export function buildMap(id = DEFAULT_MAP) {
  const entry = MAPS.find(m => m.id === id) || MAPS.find(m => m.id === DEFAULT_MAP) || MAPS[0];
  entry.build();
  return MAP;
}

/* ---------------- route analysis (used by the tests) ---------------- */

/** Horizontal distance a fall of `drop` covers at `speed`. */
export function airDistance(speed, drop) {
  return speed * Math.sqrt(Math.max(0, 2 * drop / MOVE.gravity));
}

/** Every air section on the ride line, and the speed it was authored for. */
export function airSections() {
  const out = [];
  for (let i = 1; i < MAP.route.length; i++) {
    if (MAP.route[i].kind !== "air") continue;
    // Skip back over the aim-frame a flight may drop at its midpoint: the
    // section being measured is ramp-exit to landing, not half of it.
    let j = i - 1;
    while (j > 0 && MAP.route[j].kind === "gate") j--;
    const a = MAP.route[j], b = MAP.route[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const lateral = Math.abs((b.x - a.x) * Math.cos(a.yaw) - (b.z - a.z) * Math.sin(a.yaw));
    const drop = a.y - b.y;
    out.push({
      stage: b.stage, span, lateral, drop,
      need: drop > 0 ? span / Math.sqrt(2 * drop / MOVE.gravity) : Infinity,
    });
  }
  return out;
}
