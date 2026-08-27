/* ============================== [WORLD] ==============================
   Materials and the builders that create a piece of level. Each builder
   emits the THREE mesh AND the matching physics volume, so what you see is
   exactly what you collide with. Map *layouts* live in map.js.

   The ramp builder is the important one. A surf ramp is authored the way a
   surfer describes one — "a 55, high side on your left, 3000 long" — and
   the wedge, its collision plane, its edge lines and its motion stripes all
   fall out of that.                                                       */
import * as THREE from 'three';
import { scene } from './core.js';
import { solid, rampVolume, brush, brushVertices, trigger, clearPhysics, rampWorld, SOLIDS, RAMPS, BRUSHES, TRIGGERS } from './physics.js';
import { slopeOf } from './config.js';

/* Everything a map builds lives under mapGroup so a rebuild can wipe it clean. */
export const mapGroup = new THREE.Group(); scene.add(mapGroup);

/* ---------------- material palette ---------------- */
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.05, ...o });

export const NEON = {
  teal:   0x35e0c8,
  cyan:   0x49c8ff,
  lime:   0x9dff64,
  amber:  0xffc23f,
  rose:   0xff5d8f,
  violet: 0xa88bff,
  white:  0xdfe8ff,
};

export const MATS = {
  deck:    std(0x1a2140, { roughness: 0.74 }),
  deckAlt: std(0x211a44, { roughness: 0.74 }),
  start:   std(0x12352f, { roughness: 0.7, emissive: 0x0a2a22, emissiveIntensity: 0.55 }),
  finish:  std(0x3a2a10, { roughness: 0.6, emissive: 0x3a2600, emissiveIntensity: 0.65 }),
  check:   std(0x14304a, { roughness: 0.7, emissive: 0x0d2038, emissiveIntensity: 0.55 }),
  wall:    std(0x11142a, { roughness: 0.95 }),
  beam:    std(0x141a34, { roughness: 0.6, metalness: 0.2 }),
  pad:     std(0x0d3a46, { roughness: 0.35, emissive: 0x0c5464, emissiveIntensity: 1.0 }),
};

/* Shared unit geometry — every block is one scaled box, which keeps a few
   hundred brushes cheap to upload. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/* ---------------- ramp surface texture ----------------
   Rungs across the face every 256 units of travel, and three lines running
   along it. Standing still they are decoration; at 1100 u/s the rungs are
   the only thing in the frame moving fast enough to tell you how fast you
   are going, and the lanes are the only way to judge how far you have slid
   down a face that fills the whole screen.

   This is an emissiveMap, so what matters is the *brightness* painted here,
   not the alpha: a dark base with bright marks, never a transparent one. */
let rungTex = null;
function rungTexture() {
  if (rungTex) return rungTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, 64, 128);            // the face's own dim glow
  g.fillStyle = '#3a3a3a';
  for (const x of [16, 32, 48]) g.fillRect(x - 1, 0, 2, 128);    // lanes, along the travel
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 5);              // the rung
  g.fillStyle = '#555555'; g.fillRect(0, 63, 64, 2);             // half-way tick
  rungTex = new THREE.CanvasTexture(c);
  rungTex.wrapS = THREE.RepeatWrapping; rungTex.wrapT = THREE.RepeatWrapping;
  if (THREE.SRGBColorSpace) rungTex.colorSpace = THREE.SRGBColorSpace;
  rungTex.anisotropy = 8;
  return rungTex;
}

/* Materials that outlive a map rebuild — clearWorld must never dispose these. */
const SHARED_MATS = new Set(Object.values(MATS));

const rampMatCache = new Map();
function rampMaterial(color) {
  const key = color >>> 0;
  if (rampMatCache.has(key)) return rampMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0x232c52, roughness: 0.44, metalness: 0.20,
    emissive: color, emissiveIntensity: 1.0, emissiveMap: rungTexture(),
  });
  rampMatCache.set(key, m); SHARED_MATS.add(m);
  return m;
}


/* ---------------- primitives ---------------- */

function edgeLines(geom, color, opacity, pos, rotY, scale) {
  const e = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 20),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, fog: true })
  );
  if (pos) e.position.copy(pos);
  if (rotY) e.rotation.y = rotY;
  if (scale) e.scale.copy(scale);
  e.renderOrder = 2;
  mapGroup.add(e);
  return e;
}

/**
 * A solid block. x/z are the CENTRE, y is the BOTTOM.
 * `o.edge` draws a neon wireframe (this is what makes a landing readable at
 * 900 u/s), `o.strip` lays a glowing line down the middle of the top face.
 */
export function block(x, z, w, d, y, h, mat = MATS.deck, o = {}) {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = o.shadow !== false; m.receiveShadow = true;
  mapGroup.add(m);
  if (o.edge !== null) edgeLines(UNIT_BOX, o.edge === undefined ? NEON.cyan : o.edge, o.edgeAlpha == null ? 0.8 : o.edgeAlpha, m.position, 0, m.scale);
  if (o.strip) topStrip(x, z, w, d, y + h, o.strip, o.stripW);
  if (o.solid !== false) solid(x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2, o.tag);
  return m;
}

/** Flat glowing decal on top of a block — a landing marker you can read mid-air. */
export function topStrip(x, z, w, d, y, color = NEON.cyan, sw) {
  const along = w >= d;
  const g = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, fog: true }));
  g.scale.set(along ? w * 0.86 : (sw || 8), 1.2, along ? (sw || 8) : d * 0.86);
  g.position.set(x, y + 0.7, z);
  mapGroup.add(g);
  return g;
}

/** Non-solid glowing plate. */
export function decal(x, z, w, d, y, color, opacity = 0.5, rotY = 0) {
  const g = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, fog: true }));
  g.scale.set(w, 1.2, d); g.position.set(x, y + 0.8, z); g.rotation.y = rotY;
  mapGroup.add(g); return g;
}

/** Vertical wall (bounds, guard rails, scenery you can bounce off). */
export function wall(x, z, w, d, y, h, mat = MATS.wall, o = {}) {
  return block(x, z, w, d, y, h, mat, { edge: NEON.violet, edgeAlpha: 0.3, ...o });
}

/* ---------------- the surf ramp ---------------- */

/**
 * A surf ramp, described the way a surfer would describe one.
 *
 *   x, z    centre of the footprint          yaw    travel direction, radians
 *   len     length along travel              width  horizontal span of the face
 *   yLow    surface height at the LOW edge   angle  degrees from horizontal
 *   high    'L' or 'R' — which side of the direction of travel is uphill
 *   base    bottom of the wedge (defaults to well below the low edge)
 *
 * Travel direction for yaw t is (sin t, cos t): yaw 0 runs along +Z, yaw
 * PI/2 along +X. The uphill direction is the traveller's left for high:'L'.
 *
 * Returns the physics record plus the world endpoints of the ramp's low
 * edge, which is what map.js actually needs to line the next piece up.
 */
export function surfRamp(o) {
  const { x, z, len, width, yLow, angle } = o;
  const yaw = o.yaw || 0;
  const halfU = width / 2, halfV = len / 2;
  const rise = slopeOf(angle) * width;
  const left = (o.high || 'L') === 'L';                 // +u is the traveller's left
  // high:'L' means the face climbs toward +u, so its low edge sits at u = -halfU
  const yAtMinU = left ? yLow : yLow + rise;            // surface at u = -halfU
  const yAtMaxU = left ? yLow + rise : yLow;
  const base = o.base == null ? yLow - 900 : o.base;

  const r = rampVolume({ cx: x, cz: z, yaw, halfU, halfV, yLow: yAtMinU, yHigh: yAtMaxU, base, tag: o.tag });

  /* mesh: a box in the wedge's own frame, top verts pulled onto the plane */
  const yMid = (yAtMinU + yAtMaxU) / 2;
  const g = new THREE.BoxGeometry(width, 1, len).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const lu = p.getX(i), ly = p.getY(i);
    const t = (lu + halfU) / width;
    const surf = yAtMinU + (yAtMaxU - yAtMinU) * Math.min(1, Math.max(0, t));
    p.setY(i, (ly > 0 ? surf : base) - yMid);
  }
  g.computeVertexNormals(); p.needsUpdate = true;
  // stretch the rungs so one lands every 256 units of travel whatever the length
  if (g.attributes.uv) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * (len / 256));
    uv.needsUpdate = true;
  }

  const color = o.color == null ? NEON.teal : o.color;
  const m = new THREE.Mesh(g, rampMaterial(color));
  m.position.set(x, yMid, z);
  m.rotation.y = yaw;
  m.castShadow = o.shadow !== false; m.receiveShadow = true;
  mapGroup.add(m);
  edgeLines(g, color, 0.28, m.position, yaw);

  /* The low edge is where you fall off, so it gets a line of its own. */
  const lowU = left ? -halfU : halfU;
  const a = rampWorld(r, lowU, -halfV), b = rampWorld(r, lowU, halfV);
  lineStrip([[a.x, yLow + 2, a.z], [b.x, yLow + 2, b.z]], color, 0.95);

  return {
    ramp: r, mesh: m, yaw, len, width, angle, rise,
    lowY: yLow, highY: yLow + rise,
    /** World point on the ramp surface at (across, along) in wedge coordinates. */
    at(u, v) { const w = rampWorld(r, u, v); return { x: w.x, z: w.z, y: r.yMid + r.slope * u }; },
    /** Centre of the far end of the ramp, on the low edge. */
    end() { return this.at(lowU, halfV); },
    start() { return this.at(lowU, -halfV); },
  };
}

/* ---------------- convex brushes ----------------
   A brush arrives as a set of planes with no faces attached, so the mesh has
   to be recovered: take the corners lying on each plane, order them around
   that face, and fan them. This is the same reconstruction a map decompiler
   does, and it is what lets arbitrary geometry — anything not expressible as a
   box or a wedge — be both collided with and seen. */

/** Build the visible mesh for a convex brush and add it to the world. */
export function brushSolid(planes, o = {}) {
  const b = brush(planes, o.tag);
  if (!b) return null;

  const tri = [];
  for (const p of b.planes) {
    const face = b.verts.filter(v => Math.abs(p.x * v.x + p.y * v.y + p.z * v.z - p.d) < 0.08);
    if (face.length < 3) continue;

    // an orthonormal basis in the plane, to sort the corners around it
    const up = Math.abs(p.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let ax = { x: up.y * p.z - up.z * p.y, y: up.z * p.x - up.x * p.z, z: up.x * p.y - up.y * p.x };
    const al = Math.hypot(ax.x, ax.y, ax.z) || 1;
    ax = { x: ax.x / al, y: ax.y / al, z: ax.z / al };
    const ay = { x: p.y * ax.z - p.z * ax.y, y: p.z * ax.x - p.x * ax.z, z: p.x * ax.y - p.y * ax.x };

    const c = face.reduce((a, v) => ({ x: a.x + v.x / face.length, y: a.y + v.y / face.length, z: a.z + v.z / face.length }), { x: 0, y: 0, z: 0 });
    const ordered = face.slice().sort((u, v) => {
      const au = Math.atan2((u.x - c.x) * ay.x + (u.y - c.y) * ay.y + (u.z - c.z) * ay.z,
                            (u.x - c.x) * ax.x + (u.y - c.y) * ax.y + (u.z - c.z) * ax.z);
      const av = Math.atan2((v.x - c.x) * ay.x + (v.y - c.y) * ay.y + (v.z - c.z) * ay.z,
                            (v.x - c.x) * ax.x + (v.y - c.y) * ax.y + (v.z - c.z) * ax.z);
      return au - av;
    });
    // wind so the face points along its own outward normal
    for (let i = 1; i < ordered.length - 1; i++) {
      tri.push(ordered[0], ordered[i + 1], ordered[i]);
    }
  }
  if (!tri.length) return b;

  const pos = new Float32Array(tri.length * 3);
  tri.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();

  const color = o.color == null ? NEON.teal : o.color;
  const m = new THREE.Mesh(g, o.mat || rampMaterial(color));
  m.castShadow = o.shadow !== false; m.receiveShadow = true;
  mapGroup.add(m);
  if (o.edge !== null) edgeLines(g, o.edge === undefined ? color : o.edge, o.edgeAlpha == null ? 0.4 : o.edgeAlpha);
  return b;
}

/** A polyline in world space (ramp edges, route hints). */
export function lineStrip(points, color, opacity = 0.8) {
  const pos = new Float32Array(points.length * 3);
  points.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, fog: true }));
  l.renderOrder = 2;
  mapGroup.add(l);
  return l;
}

/* ---------------- triggers ---------------- */

/** Invisible gameplay volume. x/z centre, y bottom. `data` reaches main.js. */
export function zone(x, z, w, d, y, h, data) {
  return trigger(x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2, data);
}

/**
 * A trigger you can see: a glowing arch you run through, turned to face
 * `rotY`. The trigger itself stays axis-aligned, so its box is the arch's
 * own bounding box rather than a guess based on which way it points.
 */
export function gate(x, z, w, y, h, color, data, depth = 40, rotY = 0) {
  const tx = Math.abs(Math.sin(rotY)), tz = Math.abs(Math.cos(rotY));
  const t = zone(x, z, tz * w + tx * depth, tx * w + tz * depth, y, h, data);
  const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = rotY; mapGroup.add(grp);
  const barMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, fog: true });
  const post = (px, ph, pw, pd) => {
    const m = new THREE.Mesh(UNIT_BOX, barMat);
    m.scale.set(pw, ph, pd); m.position.set(px, y + ph / 2, 0); grp.add(m); return m;
  };
  post(-w / 2, h, 8, 8); post(w / 2, h, 8, 8);
  const top = new THREE.Mesh(UNIT_BOX, barMat);
  top.scale.set(w + 8, 8, 8); top.position.set(0, y + h, 0); grp.add(top);
  const pane = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, side: THREE.DoubleSide, fog: true }));
  pane.scale.set(w, h, 1.5); pane.position.set(0, y + h / 2, 0); grp.add(pane);
  return t;
}

/* ---------------- signage ---------------- */

const signCache = new Map();
function textTexture(text, color, sub) {
  const key = text + "|" + color + "|" + (sub || "");
  if (signCache.has(key)) return signCache.get(key);
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.textAlign = 'center'; g.textBaseline = 'middle';

  // shrink to fit rather than letting a long line run off the edge of the canvas
  const fit = (str, start, weight, max) => {
    let px = start;
    do {
      g.font = `${weight}${px}px "Trebuchet MS", "Segoe UI", sans-serif`;
      if (g.measureText(str).width <= max) break;
      px -= 4;
    } while (px > 14);
    return px;
  };

  fit(text, 118, 'bold ', 950);
  g.shadowColor = color; g.shadowBlur = 34;
  g.fillStyle = '#ffffff';
  g.fillText(text, 512, sub ? 100 : 128);
  if (sub) {
    fit(sub, 52, '', 960);
    g.shadowBlur = 14; g.fillStyle = color;
    g.fillText(sub, 512, 196);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4; t.needsUpdate = true;
  signCache.set(key, t);
  return t;
}

/** Floating banner. `rotY` faces it; default faces -Z. */
export function sign(x, y, z, text, o = {}) {
  const colorHex = '#' + new THREE.Color(o.color == null ? NEON.teal : o.color).getHexString();
  const w = o.w || 440, h = w / 4;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: textTexture(text, colorHex, o.sub), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true })
  );
  m.position.set(x, y, z);
  m.rotation.y = o.rotY || 0;
  m.renderOrder = 3;
  mapGroup.add(m);
  return m;
}

/* ---------------- ambience ---------------- */

/** The endless grid far below — the only thing that gives the void a floor. */
export function voidGrid(y, size, div, c1, c2) {
  const g = new THREE.GridHelper(size, div, c1, c2);
  g.position.y = y;
  g.material.transparent = true; g.material.opacity = 0.2; g.material.fog = true;
  mapGroup.add(g);
  return g;
}

export function pointGlow(x, y, z, color, intensity = 1.2, dist = 1200) {
  const l = new THREE.PointLight(color, intensity, dist, 1.7);
  l.position.set(x, y, z); mapGroup.add(l); return l;
}

/** Non-solid scenery — the void needs a sense of scale or 900 u/s feels like 200. */
export function monolith(x, z, w, yTop, color) {
  block(x, z, w, w, -9000, yTop + 9000, MATS.beam, { solid: false, edge: color, edgeAlpha: 0.12, shadow: false });
}

/* ---------------- lifecycle ---------------- */

export function clearWorld() {
  for (const o of [...mapGroup.children]) {
    mapGroup.remove(o);
    o.traverse?.(n => {
      if (n.geometry && n.geometry !== UNIT_BOX) n.geometry.dispose?.();
      if (n.material && !SHARED_MATS.has(n.material)) n.material.dispose?.();
    });
  }
  clearPhysics();
}

export const worldStats = () => ({
  solids: SOLIDS.length, ramps: RAMPS.length, brushes: BRUSHES.length,
  triggers: TRIGGERS.length, meshes: mapGroup.children.length,
});
