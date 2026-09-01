/* ============================== [BSP COURSE] ==============================
   A playable course from a real Source map, read here and now.

   This is the thin end of the .bsp path: fetch the file, hand it to the
   extractor, hand what comes back to the builder. It knows about the .bsp
   format, not about any particular map — point it at a file and that map's
   brushes go into the collision world, its faces into the scene, and its
   entities into the run.

   The two halves it calls are shared with the packed maps in maps/, which is
   deliberate: a map played from its .bsp and the same map played from its
   packed file go through the same extraction and the same build, so they
   cannot drift apart.                                                       */
import { readBsp } from '../bsp.js';
import { resolveTexture, parseVtf } from '../vtf.js';
import { extractCourse } from './bspextract.js';
import { buildCourse } from './coursebuild.js';

export { findZones } from './bspextract.js';

/**
 * Look a material up in the map's own pakfile.
 *
 * A .bsp carries a zip of everything the map needs that the game does not
 * already have. On a well-packed map that is all of it, which is why the map
 * works on a server that has never seen it — and why it can be textured here
 * with no game install at all. A name is followed through its patch/include
 * chain to a .vtf, whose largest mip comes back as DXT blocks, undecoded.
 */
function pakResolver(bsp) {
  const pak = bsp.pakfile();
  return name => {
    const res = resolveTexture(pak, name);
    if (!res) return null;
    const raw = pak.get(res.path);
    const vtf = raw && parseVtf(raw);
    if (!vtf) return null;
    return {
      path: res.path, width: vtf.width, height: vtf.height,
      format: vtf.format, data: vtf.data, translucent: res.translucent,
    };
  };
}

/** Fetch and parse a .bsp. Kept separate so a caller can cache it. */
export async function fetchBsp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return readBsp(await res.arrayBuffer());
}

/** Everything a course is, taken out of a parsed .bsp. */
export function extractFromBsp(bsp) {
  return extractCourse(bsp, pakResolver(bsp));
}

/**
 * Turn a parsed .bsp into the live course.
 * `meta` supplies the id/name/blurb the picker shows.
 */
export function buildFromBsp(bsp, meta) {
  return buildCourse(extractFromBsp(bsp), meta);
}

/** A registry entry for a .bsp sitting in local/maps/. */
export function bspCourse(meta) {
  let cached = null;
  return {
    ...meta,
    local: true,
    async build() {
      if (!cached) cached = await fetchBsp(meta.url);
      return buildFromBsp(cached, meta);
    },
  };
}
