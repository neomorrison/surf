/* ============================== [MAP EDITS] ==============================
   Corrections to a map's volumes, kept beside the map rather than in it.

   A packed map in maps/ is an exact extraction of its .bsp — that is checked,
   and it is the reason a packed map can be trusted to play like the original.
   So nothing edits it. What a map needs instead is a small patch: this zone is
   the start, that teleport covers a corridor you are supposed to fly through,
   this one has no business being here at all.

   Those live in maps/edits.json, keyed by map id, a few lines each. It is
   text, so it diffs; it is separate from the packed map, so re-packing a .bsp
   never loses it; and a map with no entry simply loads as extracted. One file
   rather than one per map because the normal case is no edits at all, and six
   404s on the public site is a worse answer than one empty object.

   A volume is named by what it is and where its middle is — "teleport@-1234,
   56,789" — rather than by its position in a list, so a patch survives the map
   being packed again. Two volumes that round to the same middle get #2, #3
   after it, in the order the map lists them.                                */

const round = n => Math.round(n);

/** What a volume is called in an edits file. */
export function volumeKey(v) {
  const cx = round((v.minX + v.maxX) / 2);
  const cy = round((v.minY + v.maxY) / 2);
  const cz = round((v.minZ + v.maxZ) / 2);
  return `${v.data.kind}@${cx},${cy},${cz}`;
}

/**
 * Every volume's key, disambiguated.
 *
 * Returned as an array parallel to `triggers`, because the caller needs to go
 * from a volume to its name and back again and the names have to agree with
 * the ones already written in a file.
 */
export function volumeKeys(triggers) {
  const seen = new Map();
  return triggers.map(v => {
    const base = volumeKey(v);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

const BOX = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'];
const TELE = ['tx', 'ty', 'tz', 'tyaw'];

/**
 * A volume as it goes into a file: the box, the kind, a teleport's target, and
 * the shape if it has one.
 *
 * Six numbers is the normal case and the readable one. `planes` only appears
 * when a volume the map drew diagonally has been moved rather than reshaped —
 * without it, nudging a wedge four units sideways would flatten it into its
 * bounding box, which is the very thing the shape is there to avoid.
 */
export function volumeToJson(v) {
  const out = { kind: v.data.kind };
  for (const k of BOX) out[k] = round(v[k]);
  if (v.data.kind === 'teleport') for (const k of TELE) if (v.data[k] != null) out[k] = v.data[k];
  if (v.planes && v.planes.length) out.planes = v.planes.map(p => [p.x, p.y, p.z, p.d]);
  return out;
}

/** And back again. */
export function jsonToVolume(o) {
  const data = { kind: o.kind };
  if (o.kind === 'teleport') for (const k of TELE) if (o[k] != null) data[k] = o[k];
  const v = { data };
  for (const k of BOX) v[k] = +o[k];
  if (o.planes && o.planes.length) {
    v.planes = o.planes.map(p => ({ x: +p[0], y: +p[1], z: +p[2], d: +p[3] }));
  }
  return v;
}

/** An empty patch for a map. */
export const emptyEdits = id => ({ map: id, version: 1, note: '', disable: [], replace: {}, add: [] });

/**
 * Apply a patch to an extracted course, in place.
 *
 * Order matters and is the obvious one: a volume is dropped, or replaced, and
 * then whatever the file adds goes on the end. Added volumes go last so the
 * map's own ones keep their firing order — main.js fires triggers in list
 * order and stops at a teleport, so moving them around changes behaviour.
 */
export function applyEdits(course, edits) {
  const patch = edits || {};
  const disable = new Set(patch.disable || []);
  const replace = patch.replace || {};
  const keys = volumeKeys(course.triggers);

  /* Every volume carries where it came from. The editor needs it: once a patch
     has been applied, a replaced volume's middle has moved, so its key can no
     longer be recomputed from where it now is — it has to be remembered. */
  const kept = [];
  for (let i = 0; i < course.triggers.length; i++) {
    const key = keys[i];
    if (disable.has(key)) continue;
    const over = replace[key];
    /* An untouched volume keeps the shape it was drawn with. A replaced one
       does not: the file stores six numbers, so a volume you moved in the
       editor is the box you left it as, and nothing pretends otherwise. */
    const v = over
      ? jsonToVolume({ ...volumeToJson(course.triggers[i]), ...over })
      : { ...course.triggers[i], data: { ...course.triggers[i].data } };
    v.data.origin = key;
    kept.push(v);
  }
  for (let i = 0; i < (patch.add || []).length; i++) {
    const v = jsonToVolume(patch.add[i]);
    v.data.origin = null;                              // this one is ours, not the map's
    kept.push(v);
  }
  course.triggers = kept;

  /* A map with no finish in its file has no finish pad either, and the pad is
     what the finish effect plays on and what the ride line ends at. An added
     finish supplies one from the middle of its own floor. */
  const finish = kept.find(v => v.data.kind === 'finish');
  if (finish && !course.finishPad) {
    course.finishPad = { x: (finish.minX + finish.maxX) / 2, y: finish.minY, z: (finish.minZ + finish.maxZ) / 2 };
  }
  if (!finish) course.finishPad = course.finishPad || null;

  /* The prespeed cap belongs to the start line, so a start that has moved
     takes it along. Rebuilt rather than edited: it is derived, not authored. */
  const start = kept.find(v => v.data.kind === 'start');
  course.prespeed = start
    ? {
        minX: start.minX - 64, maxX: start.maxX + 64,
        minY: start.minY - 64, maxY: start.maxY + 512,
        minZ: start.minZ - 64, maxZ: start.maxZ + 64,
      }
    : null;

  course.stats = { ...course.stats, timed: !!(start && finish), edited: true };
  return course;
}

/**
 * Every map's patch, from the one file that holds them all.
 *
 * One file rather than one per map, and committed even when it is empty:
 * most maps need no edits, and a fetch per map would 404 five times over on
 * the public site for the normal case. Read once and kept.
 */
let cache = null;

export async function loadAllEdits(url = 'maps/edits.json') {
  if (cache) return cache;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    cache = res.ok ? await res.json() : {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

/** The patch for one map, or null. Absence is the normal case, not an error. */
export async function loadEdits(id) {
  const all = await loadAllEdits();
  return all[id] || null;
}

/** What the editor holds and exports: every map's patch, this one replaced. */
export async function withEdits(id, patch) {
  const all = { ...(await loadAllEdits()) };
  const empty = !patch || (!patch.disable?.length && !Object.keys(patch.replace || {}).length && !patch.add?.length && !patch.note);
  if (empty) delete all[id]; else all[id] = patch;
  return all;
}

/** Replace what is held in memory, so a live edit takes effect on rebuild. */
export function setEdits(id, patch) {
  if (!cache) cache = {};
  if (patch) cache[id] = patch; else delete cache[id];
}
