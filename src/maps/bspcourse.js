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
import { scene } from '../core.js';
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
  const { positions, faces, skipped, displacements } = bsp.faces();
  addSurface(positions);

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
  MAP.stats = { brushes: solid, dropped, faces, skipped, displacements, cells, teleports: tele };

  // a map this size needs its fog and draw distance opened right up
  const span = Math.max(world.maxX - world.minX, world.maxZ - world.minZ);
  scene.fog.near = span * 0.10;
  scene.fog.far = span * 1.15;

  return MAP;
}

/* ---------------- surface mesh ---------------- */

/** Colour a face by how steep it is: ride-able, standable, or wall. */
function addSurface(positions) {
  const n = positions.length / 9;
  const colors = new Float32Array(positions.length);
  const c = new THREE.Color();
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    ny /= L;

    if (ny >= MOVE.walkableNormalY) c.setHex(0x2f3a5c);              // floor: you can stand here
    else if (ny > 0.06) c.setHex(0x35e0c8);                          // a face you can ride
    else if (ny > -0.3) c.setHex(0x141a30);                          // wall
    else c.setHex(0x0d1124);                                         // ceiling
    for (let k = 0; k < 3; k++) {
      colors[o + k * 3] = c.r; colors[o + k * 3 + 1] = c.g; colors[o + k * 3 + 2] = c.b;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide,
  }));
  m.frustumCulled = false;
  m.receiveShadow = true;
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
