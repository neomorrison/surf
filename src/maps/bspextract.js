/* ============================== [BSP EXTRACT] ==============================
   Everything a course needs, pulled out of a .bsp and left as plain data.

   This is the half of loading a real map that has no opinion about three.js,
   the collision world or the run: it reads the file and hands back numbers.
   Nothing here touches the scene, so it runs just as well in node as in a
   browser — which is the point. `tools/pack-map.mjs` runs it offline and
   writes the result to a small file, and `coursebuild.js` builds the same
   course from either that file or from a .bsp read here and now.

   Keeping the split honest matters more than it looks. If the packer and the
   live loader each had their own idea of what a map is, a packed map would
   drift from the .bsp it came from and nobody would notice until a run played
   differently. There is one extraction, and both paths go through it.       */
import { brushVertices } from '../physics.js';

/**
 * The largest a texture may be when only props use it.
 *
 * A world surface is what you are looking at while you ride it, and those stay
 * exactly as the author made them. A prop is scenery seen at distance and in
 * bulk — surf_summer places 729 of them from 339 models — and shipping every
 * tree bark at 2048 across costs more than the whole rest of the map. A
 * texture a wall and a tree both use is resolved by the world first and keeps
 * its full size; only one that nothing but props reference is capped.
 */
const PROP_TEXTURE_CAP = 512;

/** Source yaw (degrees, +X at 0, counter-clockwise) -> this game's view yaw. */
export function viewYawFromSource(deg) {
  const t = (deg || 0) * Math.PI / 180;
  return Math.atan2(-Math.cos(t), Math.sin(t));
}

export const boxOf = m => ({
  x: (m.minX + m.maxX) / 2, y: (m.minY + m.maxY) / 2, z: (m.minZ + m.maxZ) / 2,
  w: m.maxX - m.minX, h: m.maxY - m.minY, d: m.maxZ - m.minZ,
});

/**
 * Where a brush entity's volume actually is.
 *
 * A brush entity given an origin has its geometry stored *relative to that
 * origin* — the model comes out neatly symmetric about zero and means nothing
 * on its own. One without an origin is already in world space. Both happen in
 * the same file, so tell them apart by asking whether the box contains the
 * origin it claims: a world-space box does, a relative one does not.
 */
export function entityBox(models, ent) {
  if (!ent || !ent.model || ent.model[0] !== '*') return null;
  const m = models[+ent.model.slice(1)];
  if (!m) return null;
  const p = ent.pos;
  if (!p) return m;
  const inside = p.x >= m.minX && p.x <= m.maxX && p.y >= m.minY && p.y <= m.maxY
    && p.z >= m.minZ && p.z <= m.maxZ;
  if (inside) return m;
  return {
    minX: m.minX + p.x, maxX: m.maxX + p.x,
    minY: m.minY + p.y, maxY: m.maxY + p.y,
    minZ: m.minZ + p.z, maxZ: m.maxZ + p.z,
  };
}

/**
 * The boxes a trigger entity actually occupies, one per brush.
 *
 * Not its bounding box. A boundary trigger built as a shell, or as a scatter
 * of thin slabs, has a box that swallows every bit of open air between them:
 * measured on these maps, 99% of one cyberwave teleport's box and 84% of a
 * summer one was empty space. Using the box teleports a player flying through
 * clear air, which is exactly the reported bug.
 *
 * Brush planes are stored in the entity's own space, so the origin is added on
 * the way out — translating a plane by t moves its distance by n·t.
 */
export function entityVolumes(bsp, ent) {
  if (!ent || !ent.model || ent.model[0] !== '*') return [];
  const p = ent.pos || { x: 0, y: 0, z: 0 };
  const out = [];
  for (const b of bsp.modelBrushes(+ent.model.slice(1))) {
    const planes = b.planes.map(q => ({ x: q.x, y: q.y, z: q.z, d: q.d + q.x * p.x + q.y * p.y + q.z * p.z }));
    const verts = brushVertices(planes);
    if (verts.length < 4) continue;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of verts) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    /* The planes come too, not just the box they imply. A trigger brush is
       diagonal as often as not — a slab across a corner, a wedge along a ramp
       — and its bounding box is then mostly not the trigger. Keeping the
       planes is the difference between firing where the mapper drew and
       firing across the whole corner of the room. */
    out.push({ minX, maxX, minY, maxY, minZ, maxZ, planes });
  }
  return out;
}

/**
 * Is this trigger live for a plain player?
 *
 * Maps switch triggers on and off from their own logic, and filter some to
 * particular activators. Firing all of them at once is not what the map does.
 */
export function triggerIsLive(ent) {
  if (ent.StartDisabled === '1' || ent.startdisabled === '1') return false;
  if (ent.filtername) return false;                    // aimed at something that is not you
  const flags = +(ent.spawnflags || 1);
  return (flags & 1) !== 0 || (flags & 64) !== 0;      // clients, or everything
}

/* ---------------- timer zones ---------------- */

const BONUS = /bonus|^b\d|_b\d/i;

/**
 * Find the start and finish volumes.
 *
 * Scored, not matched. Across six maps the same two zones are called
 * start_trigger, zone_map_start, s1_start_zone and nothing at all, so a name
 * is worth points rather than being a requirement, and geometry decides when
 * names run out: the start is the zone nearest a spawn, and the finish is the
 * one furthest from it.
 */
export function findZones(ents, models) {
  const triggers = ents
    .filter(e => /^trigger_(multiple|once)$/.test(e.classname || '') && e.model && e.model[0] === '*')
    .map(e => ({ ent: e, box: entityBox(models, e), name: (e.targetname || '').toLowerCase() }))
    .filter(t => t.box);

  const score = (name, want) => {
    if (!name) return 0;
    if (BONUS.test(name)) return -50;                 // a bonus route is not the main run
    let n = 0;
    if (new RegExp(want).test(name)) n += 10; else return 0;
    if (/zone|trigger/.test(name)) n += 3;
    if (/map|^s1_|_s1_|main/.test(name)) n += 6;      // the map's own start, not a stage's
    if (/\bs?\d{1,2}\b/.test(name)) n -= 2;           // a numbered stage is probably not it
    return n;
  };

  const best = want => {
    let top = null, topScore = 0;
    for (const t of triggers) {
      const sc = score(t.name, want);
      if (sc > topScore) { topScore = sc; top = t; }
    }
    return top;
  };

  let start = best('start');
  let end = best('end|finish|stop');

  // nothing named usefully: fall back to where things are
  const spawn = ents.find(e => /^info_player_(counter)?terrorist$/.test(e.classname || '') && e.pos);
  if (spawn && triggers.length) {
    const d2 = t => {
      const c = boxOf(t.box);
      return (c.x - spawn.pos.x) ** 2 + (c.y - spawn.pos.y) ** 2 + (c.z - spawn.pos.z) ** 2;
    };
    if (!start) start = triggers.reduce((a, b) => (d2(b) < d2(a) ? b : a));
    if (!end) {
      const far = triggers.filter(t => t !== start);
      if (far.length) end = far.reduce((a, b) => (d2(b) > d2(a) ? b : a));
    }
  }

  return {
    start: start ? start.box : null,
    end: end ? end.box : null,
    startEnt: start ? start.ent : null,
    endEnt: end ? end.ent : null,
    startName: start ? start.name : null,
    endName: end ? end.name : null,
    candidates: triggers.length,
  };
}

/* ============================== extraction ============================== */

/**
 * A whole course, as data.
 *
 * `resolve(name)` turns a material name into `{ width, height, format, data,
 * translucent }` or null — the caller supplies it because finding a texture
 * means reading VMTs and VTFs out of the pakfile, and vtf.js needs three.js
 * for the parts of that job this file has no business importing.
 *
 * Everything that comes back is a number, a string, or an array of them. That
 * is the whole contract: it has to survive being written to a file and read
 * back on another machine a year later.
 */
export function extractCourse(bsp, resolve, readProps) {
  const ents = bsp.entities();
  const models = bsp.models();
  const bounds = bsp.worldBounds();

  /* ---------------- textures ----------------
     Resolved as faces() meets each material, because a face's texture vectors
     are in texels and mean nothing until the texture's size is known. Several
     materials routinely share one .vtf — summer references 478 materials that
     resolve to 110 images — so they are deduplicated by path, and a material
     points at an image rather than owning one. */
  const images = [];
  const byPath = new Map();
  const materials = new Map();                    // material name -> image index or -1

  const sizeOf = (name, cap) => {
    if (!materials.has(name)) {
      const tex = resolve ? resolve(name, cap) : null;
      let at = -1;
      if (tex) {
        at = byPath.get(tex.path);
        if (at === undefined) {
          at = images.length;
          byPath.set(tex.path, at);
          images.push({
            path: tex.path, width: tex.width, height: tex.height,
            format: tex.format, translucent: !!tex.translucent, data: tex.data,
          });
        }
      }
      materials.set(name, at);
    }
    const at = materials.get(name);
    return at >= 0 ? { w: images[at].width, h: images[at].height } : { w: 512, h: 512 };
  };

  /* ---------------- the surface you see and the ground you ride ---------- */
  const surface = bsp.faces(sizeOf);
  const disp = bsp.displacements(sizeOf);

  // Displacement triangles are the collision surface on the maps built out of
  // them, so they are kept as one soup as well as drawn.
  let terrainLen = 0;
  for (const g of disp.groups) terrainLen += g.pos.length;
  const terrain = new Float32Array(terrainLen);
  let at = 0;
  for (const g of disp.groups) { terrain.set(g.pos, at); at += g.pos.length; }

  const groups = [...surface.groups, ...disp.groups].map(g => ({
    material: g.material,
    image: materials.has(g.material) ? materials.get(g.material) : -1,
    pos: g.pos, uv: g.uv, light: g.light,
  }));

  /* ---------------- collision ---------------- */
  const brushes = bsp.brushes().map(b => b.planes);

  /* ---------------- static props ----------------
     A map can put its ride surface in models rather than in brushes, and
     surf_boreas does: nineteen of its ramps are prop_static, ten of them solid.
     Reading models means reading four more binary formats, which is a lot to
     ship to a browser for something that can be done once when the map is
     packed — so, like the compressed pakfile, it arrives as a hook the tools
     supply and the browser does without.

     What comes back is meshes to draw, placements to draw them at, and convex
     hulls for the solid ones. The hulls join the brush list rather than living
     anywhere separate: a prop's collision is a convex volume like any other,
     and the physics never has to learn that props exist. */
  let props = null, propHulls = 0, propStats = null;
  if (readProps) {
    const p = readProps(bsp);
    if (p) {
      /* A prop's materials go through the same table as the world's, so a
         texture a wall and a tree both use is uploaded once. The reader names
         them; resolving a name to an image is this file's job, not its. */
      props = {
        models: p.models.map(m => ({
          meshes: m.meshes.map(mesh => {
            sizeOf(mesh.material, PROP_TEXTURE_CAP);
            return { image: materials.get(mesh.material) ?? -1, positions: mesh.positions, uvs: mesh.uvs };
          }),
        })),
        instances: p.instances,
      };
      for (const planes of p.hulls || []) { brushes.push(planes); propHulls++; }
      propStats = p.stats || null;
    }
  }

  /* ---------------- where you start ----------------
     A map carries dozens of spawns, most for the other team or other stages.
     Ranked by distance to the start zone and kept whole: the nearest is
     usually right, but not always somewhere a player can stand, and the build
     works down the list until one is. */
  const zones = findZones(ents, models);
  const startBox = zones.start, endBox = zones.end;

  const spawnEnts = ents.filter(e => /^info_player_(counter)?terrorist$/.test(e.classname || '') && e.pos);
  if (startBox && spawnEnts.length) {
    const c = boxOf(startBox);
    const d2 = e => (e.pos.x - c.x) ** 2 + (e.pos.y - c.y) ** 2 + (e.pos.z - c.z) ** 2;
    spawnEnts.sort((a, b) => d2(a) - d2(b));
  }
  const spawns = spawnEnts.map(e => ({
    x: e.pos.x, y: e.pos.y, z: e.pos.z,
    yaw: viewYawFromSource(+(e.angles || '0 0 0').trim().split(/\s+/)[1]),
  }));

  /* ---------------- the volumes that mean something ----------------
     Start, finish, and every teleport, each already reduced to the boxes it
     really occupies rather than the box that contains it. */
  const triggers = [];
  const push = (vols, data) => { for (const v of vols) triggers.push({ ...v, data }); };
  // a box that came from model bounds rather than from brushes has no shape
  // beyond the box, and must not pretend otherwise

  let startVols = zones.startEnt ? entityVolumes(bsp, zones.startEnt) : [];
  if (!startVols.length && startBox) startVols = [startBox];
  push(startVols, { kind: 'start' });

  let finishPad = null;
  if (endBox) {
    let endVols = zones.endEnt ? entityVolumes(bsp, zones.endEnt) : [];
    if (!endVols.length) endVols = [endBox];
    push(endVols, { kind: 'finish' });
    const c = boxOf(endBox);
    finishPad = { x: c.x, y: endBox.minY, z: c.z };
  }

  /* A trigger_teleport is not a death. Surf maps use them for two opposite
     jobs: catching you when you come off the ramp and putting you back at the
     stage start, and moving you *forward* between stages. Across these six
     maps 231 of 232 have a real destination, so calling them all falls turned
     every long tunnel descent into a phantom death. */
  const dests = new Map();
  for (const e of ents) {
    if (e.classname === 'info_teleport_destination' && e.targetname && e.pos) {
      dests.set(e.targetname.toLowerCase(), e);
    }
  }
  let tele = 0, pits = 0, dormant = 0, vols = 0;
  for (const e of ents) {
    if (e.classname !== 'trigger_teleport') continue;
    if (!triggerIsLive(e)) { dormant++; continue; }
    let boxes = entityVolumes(bsp, e);
    if (!boxes.length) { const m = entityBox(models, e); if (m) boxes = [m]; }
    if (!boxes.length) continue;
    const d = e.target && dests.get(e.target.toLowerCase());
    push(boxes, d
      ? {
          kind: 'teleport',
          tx: d.pos.x, ty: d.pos.y, tz: d.pos.z,
          tyaw: viewYawFromSource(+(d.angles || '0 0 0').trim().split(/\s+/)[1]),
        }
      : { kind: 'kill' });                             // nowhere to go: it is a pit
    vols += boxes.length;
    if (d) tele++; else pits++;
  }

  /* The prespeed zone is the start zone: that is what it is on a real server.
     The cap itself belongs to the course, not the file, so it is filled in at
     build time from the map's own meta. */
  const prespeed = startBox
    ? {
        minX: startBox.minX - 64, maxX: startBox.maxX + 64,
        minY: startBox.minY - 64, maxY: startBox.maxY + 512,
        minZ: startBox.minZ - 64, maxZ: startBox.maxZ + 64,
      }
    : null;

  /* ---------------- light ----------------
     The map arrives already lit — the lightmap is baked into the vertices
     above. Only the sun is carried, for everything that is not map surface. */
  const { env } = bsp.lights();

  return {
    bounds, spawns, brushes, groups, images, terrain, triggers, prespeed, finishPad, props,
    env: env ? { dir: env.dir, sun: env.sun, ambient: env.ambient } : null,
    stats: {
      faces: surface.faces, drawn: surface.drawn, skipped: surface.skipped,
      displacements: disp.count, unlitFaces: surface.unlit,
      materials: groups.length, images: images.length,
      /* Named by a face and resolved to pixels, against named and not. A
         material that does not resolve is not an error — TOOLS/TOOLSSKIP is
         meant to be invisible, and a stock game texture was never in the map
         — but a map where most of them fail draws flat grey, and that is
         worth seeing in the output rather than in the game. */
      namedMaterials: materials.size,
      resolvedMaterials: [...materials.values()].filter(i => i >= 0).length,
      propModels: props ? props.models.length : 0,
      propInstances: props ? props.instances.length : 0,
      propSolid: propStats ? propStats.solidProps : 0,
      propMissing: propStats ? propStats.missing : 0,
      propHulls,
      displacementTris: terrain.length / 9,
      teleports: tele, pits, dormant, triggerVolumes: vols,
      startZone: zones.startName || (startBox ? 'nearest spawn' : 'none'),
      endZone: zones.endName || (endBox ? 'furthest zone' : 'none'),
      timed: !!(startBox && endBox),
    },
  };
}
