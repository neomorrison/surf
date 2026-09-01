/* ============================== [PACKED COURSE] ==============================
   A course from a packed map in maps/, fetched when you ask for it.

   These are the maps this site actually ships. A .bsp is too big to serve —
   surf_summer alone is 289 MB — so each one is packed ahead of time into the
   tenth of itself the game reads. What arrives here is a few megabytes, and
   the course it builds is the same course the .bsp builds, because the same
   extraction produced both. See src/maps/smap.js.

   Nothing is downloaded until the map is chosen. The picker knows each map's
   size from the registry, so it can say what it is about to fetch before it
   fetches it, and report the bytes as they come in — a twenty megabyte map on
   a slow line is a long silence otherwise.                                  */
import { decodeSmap } from './smap.js';
import { buildCourse } from './coursebuild.js';
import { loadEdits } from '../mapedits.js';

/**
 * Fetch a packed map, reporting bytes as they arrive.
 *
 * The body is read in chunks rather than in one `arrayBuffer()` call purely
 * so there is something to report. Content-Length is what the progress is
 * measured against; a server that does not send one (or that is sending this
 * gzipped, where the header describes the compressed length) leaves `total`
 * null, and the caller shows a count rather than a bar.
 */
async function fetchPacked(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);

  const len = +res.headers.get('content-length');
  const total = Number.isFinite(len) && len > 0 ? len : null;
  if (!res.body || !onProgress) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

/**
 * A registry entry for a packed map.
 *
 * `meta.url` is the file, `meta.bytes` what it weighs. Nothing is cached
 * between builds: the decoded course for a large map is tens of megabytes of
 * typed arrays, and holding six of those because someone browsed the picker
 * is a worse trade than fetching again — which the browser's own cache makes
 * cheap anyway.
 */
export function packedCourse(meta) {
  return {
    ...meta,
    packed: true,
    async build(onProgress) {
      const buffer = await fetchPacked(meta.url, onProgress);
      if (onProgress) onProgress(meta.bytes || 0, meta.bytes || 0, 'building');
      const course = await decodeSmap(buffer);
      return buildCourse(course, meta, await loadEdits(meta.id));
    },
  };
}
