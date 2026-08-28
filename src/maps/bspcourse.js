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
import { scene, setSky, setEnvironment, SKY_DAY } from '../core.js';
import { MAP, beginMap, endMap, mark } from '../mapkit.js';
import { mapGroup, NEON } from '../world.js';
import { brush, trigger, buildBrushGrid, BRUSHES } from '../physics.js';
import { MOVE } from '../config.js';
import { readBsp } from '../bsp.js';

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

  /* ---------------- where you start ---------------- */
  const startEnt = ents.find(e => e.targetname === 'start_trigger');
  const spawns = ents.filter(e => /^info_player_(counter)?terrorist$/.test(e.classname || '') && e.pos);
  const startBox = entityBox(models, startEnt);

  // the spawn nearest the start zone is the one the run actually begins from
  let spawn = spawns[0];
  if (startBox && spawns.length) {
    const c = boxOf(startBox);
    spawn = spawns.reduce((best, s) => {
      const d = (s.pos.x - c.x) ** 2 + (s.pos.y - c.y) ** 2 + (s.pos.z - c.z) ** 2;
      return d < best.d ? { s, d } : best;
    }, { s: spawns[0], d: Infinity }).s;
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

  /* ---------------- what you see ---------------- */
  const surface = bsp.faces();
  addSurface(surface.positions, surface.light);

  /* ---------------- the run ---------------- */
  MAP.stages.push({ i: 0, name: 'START', hint: '', color: NEON.lime, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 1, name: meta.stageName || 'RUN', hint: meta.hint || '', color: NEON.teal, floorY: world.minY - 4000 });
  MAP.stages.push({ i: 2, name: 'FINISH', hint: '', color: NEON.amber, floorY: world.minY - 4000 });

  const zone = (m, data) => trigger(m.minX, m.maxX, m.minY, m.maxY, m.minZ, m.maxZ, data);
  if (startBox) zone(startBox, { kind: 'start' });

  const endEnt = ents.find(e => e.targetname === 'end_trigger');
  const endBox = entityBox(models, endEnt);
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
    faces: surface.faces, skipped: surface.skipped,
    displacements: surface.displacements, unlitFaces: surface.unlit,
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
 * The map's own baked light, tinted by how steep each face is.
 *
 * Two jobs at once. The lightmap says how bright a point is, which is what
 * makes the place look like itself; the tint says whether you can ride it,
 * which is what makes it playable — thirty thousand units of one grey is
 * unreadable at speed. Multiplying keeps both: a dark corner stays dark, and
 * a ramp in it is still recognisably a ramp.
 *
 * Luxels are stored with a shared exponent and run well past 1.0, so they get
 * an exposure and a gamma on the way to a screen colour.
 */
function addSurface(positions, light) {
  const n = positions.length / 9;
  const colors = new Float32Array(positions.length);

  /* Vertex colours are in the renderer's working space and three.js converts
     to sRGB on output, so no gamma is applied here — doing it as well was what
     turned a map whose luxels average 0.20 into a white-out.
     LIFT keeps the darkest 59% of the map off pure black, because a ramp you
     cannot see is a ramp you cannot ride. */
  const EXPOSURE = 1.15, LIFT = 0.05;
  const tone = x => Math.min(1, LIFT + x * EXPOSURE);

  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    const up = ny / L;

    let ar, ag, ab;
    if (up >= MOVE.walkableNormalY) { ar = 0.82; ag = 0.86; ab = 0.95; }        // floor
    else if (up > 0.06) { ar = 0.30; ag = 1.00; ab = 0.90; }                    // a face you can ride
    else if (up > -0.3) { ar = 0.80; ag = 0.82; ab = 0.90; }                    // wall
    else { ar = 0.72; ag = 0.75; ab = 0.86; }                                   // ceiling

    for (let k = 0; k < 3; k++) {
      const c = o + k * 3;
      colors[c] = tone(light[c] * ar);
      colors[c + 1] = tone(light[c + 1] * ag);
      colors[c + 2] = tone(light[c + 2] * ab);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // the light is already in the colours, so the surface must not be lit again
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: true,
  }));
  m.frustumCulled = false;
  mapGroup.add(m);
  return m;
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
