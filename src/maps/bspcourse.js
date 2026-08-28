/* ============================== [BSP COURSE] ==============================
   Builds a playable course out of a real Source map.

   This is the generic half — it knows about the .bsp format, not about any
   particular map. Point it at a file and it wires that map's brushes into the
   collision world, its faces into the scene, and its entities into the run:
   `start_trigger` starts the clock, `end_trigger` stops it, and every
   trigger_teleport becomes a fall.

   The faces are drawn untextured and coloured by how steep they are, which is
   not a stylistic choice — a thirty-thousand-unit map in one flat grey is
   unreadable, and the one thing you need to see from a long way off is which
   surfaces you can ride.                                                    */
import * as THREE from 'three';
import { scene, renderer, setSky, setEnvironment, SKY_DAY } from '../core.js';
import { MAP, beginMap, endMap, mark } from '../mapkit.js';
import { mapGroup, NEON } from '../world.js';
import {
  brush, brushVertices, trigger, triggersAt, hullFits, findGround,
  buildBrushGrid, setTriangles, BRUSHES,
} from '../physics.js';
import { MOVE } from '../config.js';
import { readBsp } from '../bsp.js';
import { resolveTexture, parseVtf, makeTexture } from '../vtf.js';

/** Source yaw (degrees, +X at 0, counter-clockwise) -> this game's view yaw. */
function viewYawFromSource(deg) {
  const t = (deg || 0) * Math.PI / 180;
  return Math.atan2(-Math.cos(t), Math.sin(t));
}

const boxOf = m => ({
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
function entityBox(models, ent) {
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

/** Fetch and parse a .bsp. Kept separate so a caller can cache it. */
export async function fetchBsp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return readBsp(await res.arrayBuffer());
}

/**
 * Turn a parsed .bsp into the live course.
 * `meta` supplies the id/name/blurb the picker shows.
 */
export function buildFromBsp(bsp, meta) {
  const ents = bsp.entities();
  const models = bsp.models();
  const world = bsp.worldBounds();

  /* ---------------- where you start and finish ----------------
     Every timer community names its zones differently — start_trigger,
     zone_map_start, s1_start_zone — and some maps name nothing at all. So
     candidates are scored rather than matched, and a map with no zones is
     still playable, just untimed. */
  const zones = findZones(ents, models);
  const startBox = zones.start, endBox = zones.end;

  /* A map carries dozens of spawns, most for the other team or other stages.
     Rank them by distance to the start zone and keep the whole list: the
     nearest is usually right, but not always somewhere a player can stand, and
     settleSpawn() works down the list until one is. */
  const spawns = ents.filter(e => /^info_player_(counter)?terrorist$/.test(e.classname || '') && e.pos);
  if (startBox && spawns.length) {
    const c = boxOf(startBox);
    const d2 = e => (e.pos.x - c.x) ** 2 + (e.pos.y - c.y) ** 2 + (e.pos.z - c.z) ** 2;
    spawns.sort((a, b) => d2(a) - d2(b));
  }
  const spawn = spawns[0];
  const yaw = viewYawFromSource(spawn ? +(spawn.angles || '0 0 0').split(/\s+/)[1] : 0);

  beginMap({
    ...meta,
    /* An info_player_* origin is the player's FEET, not their centre. Placing
       the hull half a height lower buried it in the floor on four of six maps
       -- and a hull inside the floor gets pushed out along whichever axis is
       shallowest, which is often sideways, through a wall and into the void.
       That was "you spawn out of the map". */
    spawn: spawn
      ? { x: spawn.pos.x, y: spawn.pos.y, z: spawn.pos.z, yaw }
      : { x: 0, y: 0, z: 0, yaw: 0 },
    oneShot: true,
  });

  /* ---------------- collision ---------------- */
  let solid = 0, dropped = 0;
  for (const b of bsp.brushes()) {
    if (brush(b.planes)) solid++; else dropped++;
  }
  const cells = buildBrushGrid(512);

  /* ---------------- what you see ----------------
     Materials resolve lazily: faces() asks for a texture's dimensions as it
     meets each one, which is also when it is worth loading. */
  const lib = materialLibrary(bsp);
  const surface = bsp.faces(name => lib.size(name));
  let textured = 0;
  for (const g of surface.groups) if (addGroup(g, lib)) textured++;

  /* Displacement terrain. On the maps built out of it this is the surface you
     ride, so it goes into the collision world as well as the scene — as a
     triangle soup, because a displacement is not convex and never will be. */
  const disp = bsp.displacements(name => lib.size(name));
  let terrainTris = 0;
  if (disp.count) {
    const soup = new Float32Array(disp.groups.reduce((a, g) => a + g.pos.length, 0));
    let at = 0;
    for (const g of disp.groups) {
      if (addGroup(g, lib)) textured++;
      soup.set(g.pos, at); at += g.pos.length;
    }
    terrainTris = soup.length / 9;
    setTriangles(soup, 256);
  }

  /* ---------------- the run ---------------- */
  MAP.stages.push({ i: 0, name: 'START', hint: '', color: NEON.lime, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 1, name: meta.stageName || 'RUN', hint: meta.hint || '', color: NEON.teal, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 2, name: 'FINISH', hint: '', color: NEON.amber, floorY: world.minY - 4000 });

  const zone = (m, data) => trigger(m.minX, m.maxX, m.minY, m.maxY, m.minZ, m.maxZ, data);
  const startEnt = zones.startEnt;
  let startVols = startEnt ? entityVolumes(bsp, startEnt) : [];
  if (!startVols.length && startBox) startVols = [startBox];
  for (const v of startVols) zone(v, { kind: 'start' });

  if (endBox) {
    let endVols = zones.endEnt ? entityVolumes(bsp, zones.endEnt) : [];
    if (!endVols.length) endVols = [endBox];
    for (const v of endVols) zone(v, { kind: 'finish' });
    const c = boxOf(endBox);
    MAP.finishPad = { x: c.x, y: endBox.minY, z: c.z };
  }

  /* A trigger_teleport is not a death, and treating it as one was wrong.
     Surf maps use them for two opposite jobs: catching you when you come off
     the ramp and putting you back at the stage start, and moving you *forward*
     between stages. Across these six maps 231 of 232 have a real destination
     and eleven of them send you downward, so calling them all falls turned
     every long tunnel descent into a phantom death. Now they teleport, which
     is what they say they do, and the map's own logic decides what that means. */
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
    const data = d
      ? {
          kind: 'teleport',
          tx: d.pos.x, ty: d.pos.y, tz: d.pos.z,
          tyaw: viewYawFromSource(+(d.angles || '0 0 0').trim().split(/\s+/)[1]),
        }
      : { kind: 'kill' };                              // nowhere to go: it is a pit
    for (const b of boxes) zone(b, data);
    vols += boxes.length;
    if (d) tele++; else pits++;
  }

  /* The prespeed zone is the start zone: that is what it is on a real server. */
  if (startBox) {
    trigger(startBox.minX - 64, startBox.maxX + 64, startBox.minY - 64, startBox.maxY + 512,
      startBox.minZ - 64, startBox.maxZ + 64, { kind: 'prespeed', cap: MAP.prespeed });
  }

  /* Now that the volumes exist, make sure the spawn is somewhere legal. */
  settleSpawn(spawns);

  /* The ride line the tests and the bot follow: start, then finish. A real map
     does not hand you one, and inferring a racing line from geometry is a
     different project. */
  MAP.route.push({ kind: 'ramp', stage: 1, x: MAP.spawn.x, y: MAP.spawn.y, z: MAP.spawn.z, yaw: 0 });
  if (MAP.finishPad) {
    MAP.route.push({ kind: 'pad', stage: 1, ...MAP.finishPad, yaw: 0 });
  }

  endMap();
  MAP.bounds = world;
  MAP.stats = {
    brushes: solid, dropped, cells, teleports: tele, pits, dormant, triggerVolumes: vols,
    spawn: MAP.spawnNote,
    startZone: zones.startName || (startBox ? 'nearest spawn' : 'none'),
    endZone: zones.endName || (endBox ? 'furthest zone' : 'none'),
    timed: !!(startBox && endBox),
    faces: surface.faces, drawn: surface.drawn, skipped: surface.skipped,
    displacements: disp.count, unlitFaces: surface.unlit,
    materials: surface.groups.length + disp.groups.length, textured,
    displacementTris: terrainTris,
  };

  /* ---------------- light it ----------------
     The map arrives already lit: three megabytes of lightmap baked by the
     author's own compiler, from the author's own 151 lamps. Re-deriving that
     at runtime means fighting a problem that is already solved, and WebGL
     will not shade a scene with 151 lights anyway. So the samples are read
     straight out of the file and baked into the mesh, which is what the
     engine it was made for does too. The sun still gets pointed the right way
     for everything that is not the map surface. */
  const { env } = bsp.lights();
  if (env) {
    setEnvironment({
      dir: env.dir,
      sunColor: env.sun, sunIntensity: Math.min(2.2, env.sun.i / 500),
      ambientColor: env.ambient, ambientGround: 0x2f3646,
      ambientIntensity: Math.min(0.9, env.ambient.i / 270),
      shadows: false,                                 // no shadow map covers 30k units usefully
    });
  }

  // a map this size needs its sky, fog and draw distance opened right up
  const span = Math.max(world.maxX - world.minX, world.maxZ - world.minZ);
  const diag = Math.hypot(world.maxX - world.minX, world.maxY - world.minY, world.maxZ - world.minZ);
  setSky({ ...SKY_DAY, radius: diag * 0.9 });
  scene.fog.near = span * 0.22;
  scene.fog.far = span * 1.5;

  return MAP;
}

/* ---------------- surface mesh ---------------- */

/**
 * Make sure the spawn is somewhere a player can actually be.
 *
 * Two things go wrong otherwise. A hull that starts inside geometry is pushed
 * out along its shallowest axis, which is as likely to be sideways through a
 * wall as upward. And a spawn sitting inside a teleport fires it on the first
 * tick, so the run begins by being thrown somewhere before you have touched
 * anything — following the teleport here instead starts you where the map
 * meant to put you, without the lurch.
 */
function settleSpawn(candidates = []) {
  const sp = MAP.spawn;
  const hits = [];
  /* Slightly shrunken: hullFits() demands zero contact, which is right when
     asking whether you may un-duck but far too strict for "can a player stand
     here" -- a spawn in a clip-sealed room touches something by construction.
     Shrinking by a unit tolerates touching without tolerating embedding. */
  const free = (x, y, z) => hullFits(x, y + 1, z, MOVE.standHeight - 2, MOVE.radius - 1);
  let note = 'as placed';

  /* Step out of any teleport the spawn stands in -- but only if the far end is
     somewhere a player can be. Destinations are not always clear: summer's own
     teleports carry CheckDestIfClearForPlayer, and following one blindly put
     the spawn inside a wall with no headroom for four thousand units. */
  for (let hop = 0; hop < 4; hop++) {
    triggersAt({ x: sp.x, y: sp.y, z: sp.z }, MOVE.radius, MOVE.standHeight, hits);
    const tp = hits.find(t => t.kind === 'teleport');
    if (!tp) break;
    let ty = null;
    for (let up = 0; up <= 128; up += 8) {
      if (free(tp.tx, tp.ty + up, tp.tz)) { ty = tp.ty + up; break; }
    }
    if (ty == null) { note = 'left in place; its teleport leads into geometry'; break; }
    sp.x = tp.tx; sp.y = ty; sp.z = tp.tz;
    if (tp.tyaw != null && Number.isFinite(tp.tyaw)) sp.yaw = tp.tyaw;
    note = 'followed a teleport';
  }

  if (free(sp.x, sp.y, sp.z)) { MAP.spawnNote = note; return; }

  // lift straight up out of whatever it is embedded in
  for (let up = 4; up <= 256; up += 4) {
    if (free(sp.x, sp.y + up, sp.z)) {
      sp.y += up;
      MAP.spawnNote = note + ', lifted ' + up + 'u clear';
      return;
    }
  }

  // still stuck: stand on the nearest surface underneath instead
  const g = findGround(sp.x, sp.z, sp.y - 2048, sp.y + 256, MOVE.radius);
  if (g && free(sp.x, g.y + 2, sp.z)) {
    sp.y = g.y + 2;
    MAP.spawnNote = note + ', dropped to the floor below';
    return;
  }

  // or the nearest free spot on a small ring, before giving up
  for (const r of [64, 160, 320]) {
    for (let a = 0; a < 8; a++) {
      const th = a * Math.PI / 4;
      const x = sp.x + Math.cos(th) * r, z = sp.z + Math.sin(th) * r;
      for (let up = 0; up <= 128; up += 16) {
        if (free(x, sp.y + up, z)) {
          sp.x = x; sp.z = z; sp.y += up;
          MAP.spawnNote = note + `, moved ${r}u aside`;
          return;
        }
      }
    }
  }
  /* This spawn point is unusable; a map has dozens, so work down the list. Each
     is tried with a small lift as well as where it sits, because a spawn resting
     on a floor touches it and a bare fit test would reject every legal one. */
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    for (let up = 0; up <= 64; up += 8) {
      if (!free(c.pos.x, c.pos.y + up, c.pos.z)) continue;
      sp.x = c.pos.x; sp.y = c.pos.y + up; sp.z = c.pos.z;
      sp.yaw = viewYawFromSource(+(c.angles || '0 0 0').trim().split(/\s+/)[1]);
      MAP.spawnNote = `spawn ${i + 1} of ${candidates.length}; the nearer ones were inside geometry`;
      return;
    }
  }
  MAP.spawnNote = note + ', STILL EMBEDDED';
}

/* ---------------- materials ---------------- */

/**
 * Materials, resolved out of the map's own pakfile and cached.
 *
 * A well-packed map carries every texture it uses, which is why it runs on a
 * server that has never seen it — and why this needs no game install. Each
 * name is followed through its patch/include chain to a .vtf, which is handed
 * to the GPU as DXT blocks without being decoded.
 */
function materialLibrary(bsp) {
  const pak = bsp.pakfile();
  const s3tc = !!(renderer.extensions && renderer.extensions.has('WEBGL_compressed_texture_s3tc'));
  const cache = new Map();

  function load(name) {
    if (cache.has(name)) return cache.get(name);
    let entry = { texture: null, color: null, size: { w: 512, h: 512 }, translucent: false };
    const res = resolveTexture(pak, name);
    if (res) {
      const raw = pak.get(res.path);
      const vtf = raw && parseVtf(raw);
      if (vtf) {
        const { texture, color } = makeTexture(vtf, s3tc);
        entry = { texture, color, size: { w: vtf.width, h: vtf.height }, translucent: res.translucent };
      }
    }
    cache.set(name, entry);
    return entry;
  }

  return { load, size: name => load(name).size, s3tc };
}

/* ---------------- surface mesh ---------------- */

/**
 * One mesh per material: texture times the map's own baked light.
 *
 * The lightmap goes in as vertex colour, which three multiplies against the
 * texture — the same thing Source does, and the reason a dark corner stays
 * dark under a bright texture. Vertex colours are in the renderer's working
 * space and it converts to sRGB on output, so no gamma is applied here;
 * doing it as well was what turned a map averaging 0.2 into a white-out.
 *
 * Surfable faces keep a slight lift so they still read at speed, but it is a
 * tint on the real surface now rather than a colour instead of one.
 */
const EXPOSURE = 1.25, LIFT = 0.06;

function addGroup(g, lib) {
  const count = g.pos.length / 3;
  if (!count) return false;
  const mat = lib.load(g.material);

  const positions = new Float32Array(g.pos);
  const colors = new Float32Array(g.pos.length);
  const uvs = new Float32Array(g.uv);

  for (let t = 0; t < count / 3; t++) {
    const o = t * 9;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const up = ny / (Math.hypot(nx, ny, nz) || 1);
    const ride = up > 0.06 && up < MOVE.walkableNormalY;

    for (let k = 0; k < 3; k++) {
      const c = o + k * 3;
      const lift = mat.texture ? 1 : 1.15;             // untextured faces need a little help
      let r = LIFT + g.light[c] * EXPOSURE * lift;
      let gg = LIFT + g.light[c + 1] * EXPOSURE * lift;
      let b = LIFT + g.light[c + 2] * EXPOSURE * lift;
      if (ride) { r *= 0.72; gg *= 1.18; b *= 1.10; }  // a surfable face, still readable at speed
      if (!mat.texture && mat.color) { r *= mat.color.r; gg *= mat.color.g; b *= mat.color.b; }
      colors[c] = Math.min(1, r); colors[c + 1] = Math.min(1, gg); colors[c + 2] = Math.min(1, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (mat.texture) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: mat.texture || null, vertexColors: true, side: THREE.DoubleSide, fog: true,
    transparent: !!mat.translucent, alphaTest: mat.translucent ? 0.5 : 0,
  }));
  m.frustumCulled = false;
  mapGroup.add(m);
  return !!mat.texture;
}

/**
 * The volumes a brush entity really occupies, one box per brush.
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
function entityVolumes(bsp, ent) {
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
    out.push({ minX, maxX, minY, maxY, minZ, maxZ });
  }
  return out;
}

/**
 * Is this trigger live for a plain player?
 *
 * Maps switch triggers on and off from their own logic, and filter some to
 * particular activators. Firing all of them at once is not what the map does.
 */
function triggerIsLive(ent) {
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
