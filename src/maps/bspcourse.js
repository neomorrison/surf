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
import { brush, trigger, buildBrushGrid, setTriangles, BRUSHES } from '../physics.js';
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

  /* The spawn nearest the start zone is the one a run actually begins from:
     a map carries dozens of them, most for the other team or other stages. */
  const spawns = ents.filter(e => /^info_player_(counter)?terrorist$/.test(e.classname || '') && e.pos);
  let spawn = spawns[0];
  if (startBox && spawns.length) {
    const c = boxOf(startBox);
    let bestD = Infinity;
    for (const sp of spawns) {
      const d = (sp.pos.x - c.x) ** 2 + (sp.pos.y - c.y) ** 2 + (sp.pos.z - c.z) ** 2;
      if (d < bestD) { bestD = d; spawn = sp; }
    }
  }
  const yaw = viewYawFromSource(spawn ? +(spawn.angles || '0 0 0').split(/\s+/)[1] : 0);

  beginMap({
    ...meta,
    spawn: spawn
      ? { x: spawn.pos.x, y: spawn.pos.y - MOVE.standHeight / 2, z: spawn.pos.z, yaw }
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
  if (startBox) zone(startBox, { kind: 'start' });

  if (endBox) {
    zone(endBox, { kind: 'finish' });
    const c = boxOf(endBox);
    MAP.finishPad = { x: c.x, y: endBox.minY, z: c.z };
  }

  /* Every teleport in a surf map is there to catch you when you come off. The
     map's own answer is to put you back at the stage start; this game's is a
     fall, which on a one-shot course is the same sentence. */
  let tele = 0;
  for (const e of ents) {
    if (e.classname !== 'trigger_teleport') continue;
    const m = entityBox(models, e);
    if (!m) continue;
    zone(m, { kind: 'kill' });
    tele++;
  }

  /* The prespeed zone is the start zone: that is what it is on a real server. */
  if (startBox) {
    trigger(startBox.minX - 64, startBox.maxX + 64, startBox.minY - 64, startBox.maxY + 512,
      startBox.minZ - 64, startBox.maxZ + 64, { kind: 'prespeed', cap: MAP.prespeed });
  }

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
    brushes: solid, dropped, cells, teleports: tele,
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
