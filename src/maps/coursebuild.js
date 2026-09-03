/* ============================== [COURSE BUILD] ==============================
   The other half of loading a real map: data in, playable course out.

   Whatever produced the data — a .bsp parsed a moment ago, or a packed map
   fetched off the server — this is the only code that turns it into brushes
   in the collision world, meshes in the scene and volumes on the clock. Both
   paths end here, so both play identically. That is the whole reason it is
   its own file.                                                             */
import * as THREE from 'three';
import { scene, renderer, setSky, setEnvironment, SKY_DAY } from '../core.js';
import { MAP, beginMap, endMap } from '../mapkit.js';
import { mapGroup, NEON } from '../world.js';
import {
  brush, trigger, triggersAt, hullFits, findGround, buildBrushGrid, setTriangles,
} from '../physics.js';
import { MOVE } from '../config.js';
import { makeTexture } from '../vtf.js';
import { applyEdits } from '../mapedits.js';

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
      if (!free(c.x, c.y + up, c.z)) continue;
      sp.x = c.x; sp.y = c.y + up; sp.z = c.z;
      sp.yaw = c.yaw;
      MAP.spawnNote = `spawn ${i + 1} of ${candidates.length}; the nearer ones were inside geometry`;
      return;
    }
  }
  MAP.spawnNote = note + ', STILL EMBEDDED';
}

/* ---------------- materials ---------------- */

/**
 * The map's own images, uploaded once each.
 *
 * A well-packed map carries every texture it uses, which is why it runs on a
 * server that has never seen it — and why this needs no game install. The
 * pixels arrive as DXT blocks and are handed to the GPU that way where the
 * card takes them, which is most of them.
 */
function imageLibrary(images) {
  const cache = new Map();
  const s3tc = !!(renderer.extensions && renderer.extensions.has('WEBGL_compressed_texture_s3tc'));
  const none = { texture: null, color: null, translucent: false };
  return {
    load(i) {
      if (i == null || i < 0 || !images[i]) return none;
      if (cache.has(i)) return cache.get(i);
      const img = images[i];
      const { texture, color } = makeTexture(img, s3tc);
      const entry = { texture, color, translucent: !!img.translucent };
      cache.set(i, entry);
      return entry;
    },
  };
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
  const mat = lib.load(g.image);

  const positions = g.pos instanceof Float32Array ? g.pos : new Float32Array(g.pos);
  const uvs = g.uv instanceof Float32Array ? g.uv : new Float32Array(g.uv);
  const colors = new Float32Array(positions.length);

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

/* ============================== the build ============================== */

/**
 * Build the live course from an extracted one.
 *
 * `course` is whatever `extractCourse` produced, or the identical thing read
 * back out of a packed file. `meta` is the id, name and blurb the picker
 * shows, plus the rules the course is played under.
 */
export function buildCourse(course, meta, edits) {
  /* The volumes a map ships with are what its .bsp said. What it should have
     said is in maps/edits.json, and this is where the two meet. The originals
     are kept so the editor can name a volume by where it started rather than
     by where it has been dragged to. */
  const original = course.triggers.map(v => ({ ...v, data: { ...v.data } }));
  applyEdits(course, edits);

  const world = course.bounds;
  const first = course.spawns[0];

  beginMap({
    ...meta,
    /* An info_player_* origin is the player's FEET, not their centre. Placing
       the hull half a height lower buried it in the floor on four of six maps
       -- and a hull inside the floor gets pushed out along whichever axis is
       shallowest, which is often sideways, through a wall and into the void.
       That was "you spawn out of the map". */
    spawn: first ? { x: first.x, y: first.y, z: first.z, yaw: first.yaw } : { x: 0, y: 0, z: 0, yaw: 0 },
    oneShot: true,
  });

  /* ---------------- collision ---------------- */
  let solid = 0, dropped = 0;
  for (const planes of course.brushes) {
    if (brush(planes)) solid++; else dropped++;
  }
  const cells = buildBrushGrid(512);

  /* Displacement terrain. On the maps built out of it this is the surface you
     ride, so it goes into the collision world as well as the scene — as a
     triangle soup, because a displacement is not convex and never will be. */
  if (course.terrain && course.terrain.length) setTriangles(course.terrain, 256);

  /* ---------------- what you see ---------------- */
  const lib = imageLibrary(course.images);
  let textured = 0;
  for (const g of course.groups) if (addGroup(g, lib)) textured++;

  /* ---------------- the run ---------------- */
  MAP.stages.push({ i: 0, name: 'START', hint: '', color: NEON.lime, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 1, name: meta.stageName || 'RUN', hint: meta.hint || '', color: NEON.teal, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 2, name: 'FINISH', hint: '', color: NEON.amber, floorY: world.minY - 4000 });

  for (const v of course.triggers) {
    // the planes ride along in `data`, which trigger() spreads onto the record
    trigger(v.minX, v.maxX, v.minY, v.maxY, v.minZ, v.maxZ,
      v.planes ? { ...v.data, planes: v.planes } : v.data);
  }
  if (course.prespeed) {
    const p = course.prespeed;
    trigger(p.minX, p.maxX, p.minY, p.maxY, p.minZ, p.maxZ, { kind: 'prespeed', cap: MAP.prespeed });
  }
  if (course.finishPad) MAP.finishPad = { ...course.finishPad };

  /* Now that the volumes exist, make sure the spawn is somewhere legal. */
  settleSpawn(course.spawns);

  /* The ride line the tests and the bot follow: start, then finish. A real map
     does not hand you one, and inferring a racing line from geometry is a
     different project. */
  MAP.route.push({ kind: 'ramp', stage: 1, x: MAP.spawn.x, y: MAP.spawn.y, z: MAP.spawn.z, yaw: 0 });
  if (MAP.finishPad) MAP.route.push({ kind: 'pad', stage: 1, ...MAP.finishPad, yaw: 0 });

  endMap();
  MAP.bounds = world;
  MAP.stats = { ...course.stats, brushes: solid, dropped, cells, textured, spawn: MAP.spawnNote };
  /* What the editor works from: the map as extracted, and the patch in force. */
  MAP.editable = { id: meta.id, original, edits: edits || null };

  /* ---------------- light it ----------------
     The map arrives already lit: three megabytes of lightmap baked by the
     author's own compiler, from the author's own 151 lamps. Re-deriving that
     at runtime means fighting a problem that is already solved, and WebGL
     will not shade a scene with 151 lights anyway. So the samples were read
     straight out of the file and baked into the mesh, which is what the
     engine it was made for does too. The sun still gets pointed the right way
     for everything that is not the map surface. */
  if (course.env) {
    const env = course.env;
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
