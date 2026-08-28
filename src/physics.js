/* ============================== [PHYSICS] ==============================
   Collision volumes + a port of Source's PlayerMove, with the ramp solver
   rewritten so that steep surfaces behave the way a surf map needs them to.

   Free of THREE and the DOM, so the whole rulebook can be unit tested
   headlessly (test/*.test.mjs) and so nothing in the renderer can reach in
   and nudge the player.

   Collision world
     SOLIDS   axis-aligned boxes
     RAMPS    yaw-rotated wedges: a footprint rectangle with a top face that
              slopes along the wedge's local X. Steeper than
              MOVE.walkableNormalY and it is not standable — you get clipped
              along it instead, which is the entire game.
     TRIGGERS non-solid volumes the game logic polls (start / checkpoint /
              finish / kill / boost / teleport).

   How surfing falls out of this
     A steep ramp is never returned by findGround, so `onGround` stays false
     while you ride it. Every tick therefore runs air acceleration (wish
     speed capped at 30) and full gravity. Gravity pushes the hull into the
     plane; the solver pushes it back out along the normal and calls
     ClipVelocity, which deletes exactly the component going into the ramp
     and leaves everything along it. The in-plane part of gravity is what
     accelerates you down the slope; the strafe is what you use to climb
     back up it and to convert that fall into forward speed.               */

import { MOVE, RULES } from './config.js';

export const SOLIDS = [];
export const RAMPS = [];
export const BRUSHES = [];
/** Displacement terrain: a flat triangle soup, indexed by the same grid. */
export const TRIS = { xyz: null, count: 0, cells: null, cell: 0, stamp: null };
export const TRIGGERS = [];

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

export function clearPhysics() {
  SOLIDS.length = 0; RAMPS.length = 0; BRUSHES.length = 0; TRIGGERS.length = 0;
  GRID.cells = null;
  TRIS.xyz = null; TRIS.count = 0; TRIS.cells = null; TRIS.stamp = null;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ---------------- authoring ---------------- */

/** Axis-aligned solid box. */
export function solid(minX, maxX, minY, maxY, minZ, maxZ, tag) {
  const s = { minX, maxX, minY, maxY, minZ, maxZ, tag: tag || "" };
  SOLIDS.push(s); return s;
}

/**
 * A wedge: a rectangular footprint, rotated `yaw` about Y, whose top face
 * slopes along the wedge's local X ("across") and is level along its local Z
 * ("along" — the direction you travel).
 *
 *   cx, cz     centre of the footprint
 *   halfU      half-width across the slope       halfV  half-length along it
 *   yLow/yHigh surface height at local u = -halfU / +halfU
 *   base       bottom of the solid volume
 *
 * A ramp is thus fully described by one plane plus a footprint, which is why
 * the collision below is exact rather than a stack of special cases.
 */
export function rampVolume(o) {
  const { cx, cz, halfU, halfV, yLow, yHigh } = o;
  const yaw = o.yaw || 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const slope = (yHigh - yLow) / (2 * halfU);
  const L = Math.hypot(slope, 1), inv = 1 / L;

  // local normal (-slope, 1, 0)/L rotated into world by yaw
  const n = { x: -slope * inv * cos, y: inv, z: slope * inv * sin };

  const yMid = (yLow + yHigh) / 2;
  const base = o.base == null ? Math.min(yLow, yHigh) - 600 : o.base;

  // world AABB of the footprint, for broadphase
  const ex = Math.abs(halfU * cos) + Math.abs(halfV * sin);
  const ez = Math.abs(halfU * sin) + Math.abs(halfV * cos);

  const r = {
    cx, cz, yaw, cos, sin, halfU, halfV, yLow, yHigh, slope, yMid, base, n,
    walkable: inv >= MOVE.walkableNormalY,
    angle: Math.atan2(Math.abs(slope), 1) * 180 / Math.PI,
    minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez,
    minY: base, maxY: Math.max(yLow, yHigh),
    tag: o.tag || "",
  };
  RAMPS.push(r); return r;
}

/* ============================== convex brushes ==============================
   `solid()` and `rampVolume()` are convenient shapes for hand-authored maps,
   but they are shapes — an axis-aligned box, and a wedge with one sloped top
   face at a yaw. A real Source map is not made of those. It is made of convex
   brushes: arbitrary sets of planes, at arbitrary angles, with no axis or
   symmetry to lean on. A ramp in a real surf map is routinely both yawed *and*
   pitched, which the wedge cannot express at all.

   So this is the general case, and it is the representation any real map has
   to be loaded into. The collision is the classic one: expand each of the
   brush's planes outward by the hull's extent along that plane's normal, and
   the swept box becomes a single point tested against a slightly fatter convex
   volume. Push out along the least-penetrating plane.                        */

/** Plane through `p` with unit normal `n`, stored as n·x = d, n pointing OUT. */
export function plane(nx, ny, nz, d) {
  const L = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / L, y: ny / L, z: nz / L, d: d / L };
}

/**
 * Every corner of a convex brush: intersect each triple of planes and keep the
 * points that lie inside all of them. Slow in principle and irrelevant in
 * practice — a brush has a handful of planes and this runs once, at load.
 */
export function brushVertices(planes, eps = 0.06) {
  const out = [];
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const v = triplePoint(planes[i], planes[j], planes[k]);
        if (!v) continue;
        let inside = true;
        for (const p of planes) {
          if (p.x * v.x + p.y * v.y + p.z * v.z - p.d > eps) { inside = false; break; }
        }
        if (!inside) continue;
        if (!out.some(o => Math.abs(o.x - v.x) < 0.05 && Math.abs(o.y - v.y) < 0.05 && Math.abs(o.z - v.z) < 0.05)) {
          out.push(v);
        }
      }
    }
  }
  return out;
}

function triplePoint(a, b, c) {
  const det =
    a.x * (b.y * c.z - b.z * c.y) -
    a.y * (b.x * c.z - b.z * c.x) +
    a.z * (b.x * c.y - b.y * c.x);
  if (Math.abs(det) < 1e-9) return null;              // parallel or coincident
  const inv = 1 / det;
  return {
    x: inv * (a.d * (b.y * c.z - b.z * c.y) - a.y * (b.d * c.z - b.z * c.d) + a.z * (b.d * c.y - b.y * c.d)),
    y: inv * (a.x * (b.d * c.z - b.z * c.d) - a.d * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.d - b.d * c.x)),
    z: inv * (a.x * (b.y * c.d - b.d * c.y) - a.y * (b.x * c.d - b.d * c.x) + a.d * (b.x * c.y - b.y * c.x)),
  };
}

/**
 * A solid convex brush. `planes` are outward-facing; a point is inside when
 * n·p <= d for every one of them.
 */
export function brush(planes, tag) {
  const ps = planes.map(p => (p.d === undefined ? plane(p[0], p[1], p[2], p[3]) : p));
  const verts = brushVertices(ps);
  const b = {
    planes: ps, verts, tag: tag || "",
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity,
    /* the flattest upward face, which is what decides whether it is a floor */
    walkable: ps.some(p => p.y >= MOVE.walkableNormalY),
  };
  for (const v of verts) {
    b.minX = Math.min(b.minX, v.x); b.maxX = Math.max(b.maxX, v.x);
    b.minY = Math.min(b.minY, v.y); b.maxY = Math.max(b.maxY, v.y);
    b.minZ = Math.min(b.minZ, v.z); b.maxZ = Math.max(b.maxZ, v.z);
  }
  if (!verts.length) return null;                     // degenerate / unbounded: ignore it
  BRUSHES.push(b);
  return b;
}

/* ---------------- broadphase ----------------
   A hand-authored course has a few dozen brushes and a linear scan is free.
   A real map has over a thousand, and the scan runs four times per collision
   pass, up to sixteen passes a tick, a hundred and twenty-eight ticks a
   second. So brushes go in a uniform grid and only the cells the hull sits in
   are ever looked at. `stamp` is a visit marker: a brush spanning many cells
   is returned once, without allocating a set per query. */

const GRID = { cell: 0, cells: null };
let visitStamp = 0;

const key = (x, y, z) => `${x},${y},${z}`;

/** Index every brush by cell. Call once, after the world is built. */
export function buildBrushGrid(cell = 512) {
  GRID.cell = cell;
  GRID.cells = new Map();
  for (const b of BRUSHES) {
    b.stamp = 0;
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) {
      for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) {
        for (let z = Math.floor(b.minZ / cell); z <= Math.floor(b.maxZ / cell); z++) {
          const k = key(x, y, z);
          let list = GRID.cells.get(k);
          if (!list) GRID.cells.set(k, list = []);
          list.push(b);
        }
      }
    }
  }
  return GRID.cells.size;
}

/** Brushes whose cells the given box touches. Falls back to all of them. */
export function brushesNear(minX, minY, minZ, maxX, maxY, maxZ, out) {
  if (!GRID.cells) return BRUSHES;
  out.length = 0;
  const c = GRID.cell, s = ++visitStamp;
  for (let x = Math.floor(minX / c); x <= Math.floor(maxX / c); x++) {
    for (let y = Math.floor(minY / c); y <= Math.floor(maxY / c); y++) {
      for (let z = Math.floor(minZ / c); z <= Math.floor(maxZ / c); z++) {
        const list = GRID.cells.get(key(x, y, z));
        if (!list) continue;
        for (const b of list) if (b.stamp !== s) { b.stamp = s; out.push(b); }
      }
    }
  }
  return out;
}

/* ============================== displacement terrain ==============================
   A displacement is not convex and cannot be a brush, so terrain is kept as a
   plain triangle soup and collided directly. On a map built out of
   displacements this is the surface you ride, not scenery, so it has to be
   here rather than be an approximation of itself.

   Box against triangle is done by separating axes: if any of the thirteen
   candidate axes shows a gap, they are apart; otherwise the smallest overlap
   found is the shortest way out, which is exactly the push and the normal that
   ClipVelocity wants.                                                        */

/** Install the terrain and index it. `xyz` is 9 floats per triangle. */
export function setTriangles(xyz, cell = 256) {
  TRIS.xyz = xyz;
  TRIS.count = xyz ? xyz.length / 9 : 0;
  TRIS.cell = cell;
  TRIS.cells = new Map();
  TRIS.stamp = new Int32Array(TRIS.count);
  for (let t = 0; t < TRIS.count; t++) {
    const o = t * 9;
    let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity, hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = xyz[o + k * 3], y = xyz[o + k * 3 + 1], z = xyz[o + k * 3 + 2];
      if (x < lo0) lo0 = x; if (x > hi0) hi0 = x;
      if (y < lo1) lo1 = y; if (y > hi1) hi1 = y;
      if (z < lo2) lo2 = z; if (z > hi2) hi2 = z;
    }
    for (let x = Math.floor(lo0 / cell); x <= Math.floor(hi0 / cell); x++) {
      for (let y = Math.floor(lo1 / cell); y <= Math.floor(hi1 / cell); y++) {
        for (let z = Math.floor(lo2 / cell); z <= Math.floor(hi2 / cell); z++) {
          const k = `${x},${y},${z}`;
          let list = TRIS.cells.get(k);
          if (!list) TRIS.cells.set(k, list = []);
          list.push(t);
        }
      }
    }
  }
  return TRIS.cells.size;
}

let triStamp = 0;

/** Triangle indices whose cells the given box touches. */
export function trianglesNear(minX, minY, minZ, maxX, maxY, maxZ, out) {
  out.length = 0;
  if (!TRIS.cells) return out;
  const c = TRIS.cell, s = ++triStamp;
  for (let x = Math.floor(minX / c); x <= Math.floor(maxX / c); x++) {
    for (let y = Math.floor(minY / c); y <= Math.floor(maxY / c); y++) {
      for (let z = Math.floor(minZ / c); z <= Math.floor(maxZ / c); z++) {
        const list = TRIS.cells.get(`${x},${y},${z}`);
        if (!list) continue;
        for (const t of list) if (TRIS.stamp[t] !== s) { TRIS.stamp[t] = s; out.push(t); }
      }
    }
  }
  return out;
}

/* scratch, so the hot path allocates nothing */
const _ax = new Float64Array(3), _ay = new Float64Array(3), _az = new Float64Array(3);
const _hit = { depth: 0, x: 0, y: 0, z: 0 };

/**
 * Box against one triangle. Returns the shortest way out, or null if apart.
 * `px,py,pz` is the box centre and `ex,ey,ez` its half-extents.
 */
export function triangleContact(t, px, py, pz, ex, ey, ez) {
  const xyz = TRIS.xyz, o = t * 9;
  for (let k = 0; k < 3; k++) {
    _ax[k] = xyz[o + k * 3] - px;
    _ay[k] = xyz[o + k * 3 + 1] - py;
    _az[k] = xyz[o + k * 3 + 2] - pz;
  }
  let bestDepth = Infinity, bx = 0, by = 0, bz = 0;

  const axis = (nx, ny, nz) => {
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) return true;                      // degenerate; carries no information
    nx /= len; ny /= len; nz /= len;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const d = _ax[k] * nx + _ay[k] * ny + _az[k] * nz;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const r = ex * Math.abs(nx) + ey * Math.abs(ny) + ez * Math.abs(nz);
    if (lo > r || hi < -r) return false;               // a gap: they are apart
    // push the box off whichever end is nearer
    const outPos = hi + r, outNeg = r - lo;
    const depth = outNeg < outPos ? outNeg : outPos;
    if (depth < bestDepth) {
      bestDepth = depth;
      const sgn = outNeg < outPos ? -1 : 1;
      bx = nx * sgn; by = ny * sgn; bz = nz * sgn;
    }
    return true;
  };

  // the triangle's own plane first: on terrain it is almost always the answer
  const ux = _ax[1] - _ax[0], uy = _ay[1] - _ay[0], uz = _az[1] - _az[0];
  const vx = _ax[2] - _ax[0], vy = _ay[2] - _ay[0], vz = _az[2] - _az[0];
  if (!axis(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)) return null;
  if (!axis(1, 0, 0) || !axis(0, 1, 0) || !axis(0, 0, 1)) return null;

  const ex0 = [ux, _ax[2] - _ax[1], _ax[0] - _ax[2]];
  const ey0 = [uy, _ay[2] - _ay[1], _ay[0] - _ay[2]];
  const ez0 = [uz, _az[2] - _az[1], _az[0] - _az[2]];
  for (let i = 0; i < 3; i++) {
    if (!axis(0, -ez0[i], ey0[i])) return null;
    if (!axis(ez0[i], 0, -ex0[i])) return null;
    if (!axis(-ey0[i], ex0[i], 0)) return null;
  }

  _hit.depth = bestDepth; _hit.x = bx; _hit.y = by; _hit.z = bz;
  return _hit;
}

/** Upward normal of a triangle, for deciding whether it is a floor or a ride. */
function triNormalY(t) {
  const xyz = TRIS.xyz, o = t * 9;
  const ux = xyz[o + 3] - xyz[o], uy = xyz[o + 4] - xyz[o + 1], uz = xyz[o + 5] - xyz[o + 2];
  const vx = xyz[o + 6] - xyz[o], vy = xyz[o + 7] - xyz[o + 1], vz = xyz[o + 8] - xyz[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / L, y: ny / L, z: nz / L };
}

/** Height of a triangle's surface directly under a point, or null if outside it. */
function triHeightAt(t, x, z) {
  const xyz = TRIS.xyz, o = t * 9;
  const x0 = xyz[o], y0 = xyz[o + 1], z0 = xyz[o + 2];
  const x1 = xyz[o + 3], y1 = xyz[o + 4], z1 = xyz[o + 5];
  const x2 = xyz[o + 6], y2 = xyz[o + 7], z2 = xyz[o + 8];
  const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
  if (Math.abs(d) < 1e-9) return null;                 // edge-on from above
  const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
  const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
  const c = 1 - a - b;
  const e = -0.001;
  if (a < e || b < e || c < e) return null;
  return a * y0 + b * y1 + c * y2;
}

/** How far a plane must move along its own normal to clear the hull. */
function hullOffset(p, radius, height) {
  return radius * Math.abs(p.x) + (height / 2) * Math.abs(p.y) + radius * Math.abs(p.z);
}

/**
 * Penetration of the hull into a brush, or null if they are apart.
 * Returns the least-penetrating plane, which is the one to push out along.
 */
export function brushContact(b, x, feetY, z, radius, height) {
  const cy = feetY + height / 2;
  let best = Infinity, bn = null;
  for (const p of b.planes) {
    const dist = p.x * x + p.y * cy + p.z * z - (p.d + hullOffset(p, radius, height));
    if (dist > 0) return null;                        // this plane separates them
    const depth = -dist;
    if (depth < best) { best = depth; bn = p; }
  }
  return bn ? { depth: best, n: bn } : null;
}

/** Non-solid volume. `data` carries the gameplay meaning (see timer.js). */
export function trigger(minX, maxX, minY, maxY, minZ, maxZ, data) {
  const t = { minX, maxX, minY, maxY, minZ, maxZ, ...data };
  TRIGGERS.push(t); return t;
}

/* ---------------- ramp geometry ---------------- */

/** World XZ -> the wedge's own (across, along) coordinates. */
export function rampLocal(r, x, z) {
  const dx = x - r.cx, dz = z - r.cz;
  return { u: dx * r.cos - dz * r.sin, v: dx * r.sin + dz * r.cos };
}
/** The wedge's (across, along) -> world XZ. */
export function rampWorld(r, u, v) {
  return { x: r.cx + u * r.cos + v * r.sin, z: r.cz - u * r.sin + v * r.cos };
}
/** Surface height at a world point, clamped into the footprint. */
export function rampSurfaceY(r, x, z) {
  const { u } = rampLocal(r, x, z);
  return r.yMid + r.slope * clamp(u, -r.halfU, r.halfU);
}
/** Unit vector pointing straight up the slope, in world XZ. */
export function rampUphill(r) {
  const s = r.slope >= 0 ? 1 : -1;
  return { x: s * r.cos, z: -s * r.sin };
}

/**
 * Signed distance from the ramp's plane to the *deepest* corner of the
 * player's hull. The hull is an axis-aligned square of half-width `radius`
 * with its bottom at `feetY`, and the plane normal always points up, so the
 * deepest corner is a bottom one — which makes the offset exact rather than
 * an approximation: radius*(|n.x| + |n.z|).
 */
function rampDist(r, x, feetY, z, radius) {
  const n = r.n;
  const d = n.x * (x - r.cx) + n.y * (feetY - r.yMid) + n.z * (z - r.cz);
  return d - radius * (Math.abs(n.x) + Math.abs(n.z));
}

/** Does the hull's footprint touch the wedge's footprint? */
function rampFootprint(r, x, z, radius) {
  const { u, v } = rampLocal(r, x, z);
  const e = radius * (Math.abs(r.cos) + Math.abs(r.sin));   // world square, seen from local axes
  return Math.abs(u) <= r.halfU + e && Math.abs(v) <= r.halfV + e;
}

function hullOverlapsXZ(b, x, z, radius) {
  return x + radius > b.minX && x - radius < b.maxX && z + radius > b.minZ && z - radius < b.maxZ;
}

/* ---------------- queries ---------------- */

/**
 * Highest *standable* surface under the hull, searched in [lo, hi] of feet
 * height. Steep ramps are deliberately invisible here: that is the one line
 * that turns them from floors into slides.
 */
export function findGround(x, z, lo, hi, radius) {
  let bestY = -Infinity, bestN = UP, bestRamp = null;
  for (const s of SOLIDS) {
    if (!hullOverlapsXZ(s, x, z, radius)) continue;
    if (s.maxY < lo || s.maxY > hi) continue;
    if (s.maxY > bestY) { bestY = s.maxY; bestN = UP; bestRamp = null; }
  }
  for (const r of RAMPS) {
    if (!r.walkable) continue;
    if (!rampFootprint(r, x, z, radius)) continue;
    // you rest on the highest point beneath the hull, i.e. its uphill corner
    const { u, v } = rampLocal(r, x, z);
    const e = radius * (Math.abs(r.cos) + Math.abs(r.sin));
    const uSup = clamp(u + (r.slope >= 0 ? e : -e), -r.halfU, r.halfU);
    if (Math.abs(v) > r.halfV + e) continue;
    const y = r.yMid + r.slope * uSup;
    if (y < lo || y > hi) continue;
    if (y > bestY) { bestY = y; bestN = r.n; bestRamp = r; }
  }
  for (const b of brushesNear(x - radius, lo - 2, z - radius,
                              x + radius, hi + MOVE.standHeight, z + radius, nearby)) {
    if (!b.walkable) continue;
    if (b.maxY < lo - 1 || b.minY > hi + MOVE.standHeight) continue;
    if (x + radius <= b.minX || x - radius >= b.maxX) continue;
    if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;
    for (const p of b.planes) {
      if (p.y < MOVE.walkableNormalY) continue;
      // the feet height at which the hull rests exactly on this face
      const off = radius * Math.abs(p.x) + radius * Math.abs(p.z);
      const halfH = MOVE.standHeight / 2;               // offset in y is handled by the -halfH below
      const y = (p.d + off + halfH * Math.abs(p.y) - p.x * x - p.z * z) / p.y - halfH;
      if (y < lo || y > hi || y <= bestY) continue;
      // ...but only if that point is genuinely on this brush, not past its edge
      const cy = y + halfH;
      let on = true;
      for (const q of b.planes) {
        if (q === p) continue;
        const off2 = radius * Math.abs(q.x) + halfH * Math.abs(q.y) + radius * Math.abs(q.z);
        if (q.x * x + q.y * cy + q.z * z - (q.d + off2) > 0.05) { on = false; break; }
      }
      if (on) { bestY = y; bestN = p; bestRamp = null; }
    }
  }
  if (TRIS.count) {
    for (const t of trianglesNear(x - radius, lo - 2, z - radius,
                                  x + radius, hi + 2, z + radius, nearTris)) {
      const n = triNormalY(t);
      if (n.y < MOVE.walkableNormalY) continue;
      const y = triHeightAt(t, x, z);
      if (y == null || y < lo || y > hi || y <= bestY) continue;
      bestY = y; bestN = n; bestRamp = null;
    }
  }
  return bestY > -Infinity ? { y: bestY, n: bestN, ramp: bestRamp } : null;
}

/** True if a standing hull would fit here (used to refuse un-ducking). */
export function hullFits(x, y, z, height, radius) {
  for (const s of SOLIDS) {
    if (!hullOverlapsXZ(s, x, z, radius)) continue;
    if (y + height > s.minY + 0.01 && y < s.maxY - 0.01) return false;
  }
  for (const r of RAMPS) {
    if (!rampFootprint(r, x, z, radius)) continue;
    if (y + height > r.base + 0.01 && y < rampSurfaceY(r, x, z) - 0.01) return false;
  }
  for (const b of brushesNear(x - radius, y, z - radius, x + radius, y + height, z + radius, nearby)) {
    if (brushContact(b, x, y, z, radius, height)) return false;
  }
  if (TRIS.count) {
    const ex = radius, ey = height / 2, cy = y + ey;
    for (const t of trianglesNear(x - ex, y, z - ex, x + ex, y + height, z + ex, nearTris)) {
      const c = triangleContact(t, x, cy, z, ex, ey, ex);
      if (c && c.depth > 0.01) return false;
    }
  }
  return true;
}

/**
 * The steep face the hull is riding (or about to touch).
 *
 * Contact alone is too twitchy to drive anything: a tick where gravity did not
 * happen to push the hull all the way through the plane still *is* a ride, and
 * treating it as airborne makes a controller — human or bot — throw away that
 * tick. So this looks for the nearest steep face within `reach` underneath
 * instead, over both wedges and brushes.
 *
 * Returns { ramp, n } where `ramp` is the wedge if it was one, else null.
 */
export function findSurfContact(x, y, z, radius, height = MOVE.standHeight, reach = 4) {
  let bestD = Infinity, found = null;

  for (const r of RAMPS) {
    if (r.walkable) continue;
    if (y >= r.maxY + reach || y + height <= r.base) continue;
    if (!rampFootprint(r, x, z, radius)) continue;
    const d = rampDist(r, x, y, z, radius);
    if (d < -MOVE.maxRampPush || d > reach) continue;
    if (Math.abs(d) < bestD) { bestD = Math.abs(d); found = { ramp: r, n: r.n }; }
  }

  const cy = y + height / 2;
  for (const b of brushesNear(x - radius, y - reach, z - radius,
                              x + radius, y + height + reach, z + radius, nearby)) {
    if (y >= b.maxY + reach || y + height <= b.minY) continue;
    if (x + radius <= b.minX || x - radius >= b.maxX) continue;
    if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;
    for (const p of b.planes) {
      if (p.y <= 0.01 || p.y >= MOVE.walkableNormalY) continue;    // not a face you ride
      const d = p.x * x + p.y * cy + p.z * z - (p.d + hullOffset(p, radius, height));
      if (d < -MOVE.maxRampPush || d > reach) continue;
      // and the hull has to actually be over this face, not past its edge
      let on = true;
      for (const q of b.planes) {
        if (q === p) continue;
        if (p.x * q.x + p.y * q.y + p.z * q.z > 0.999) continue;
        const dq = q.x * x + q.y * cy + q.z * z - (q.d + hullOffset(q, radius, height));
        if (dq > reach + 0.5) { on = false; break; }
      }
      if (on && Math.abs(d) < bestD) { bestD = Math.abs(d); found = { ramp: null, n: p }; }
    }
  }

  if (TRIS.count) {
    const ex = radius, ey = height / 2, cyy = y + ey;
    for (const t of trianglesNear(x - ex, cyy - ey - reach, z - ex,
                                  x + ex, cyy + ey + reach, z + ex, nearTris)) {
      const n = triNormalY(t);
      if (n.y <= 0.01 || n.y >= MOVE.walkableNormalY) continue;
      const c = triangleContact(t, x, cyy, z, ex, ey + reach, ex);
      if (!c) continue;
      const gap = Math.max(0, reach - c.depth);
      if (gap < bestD) { bestD = gap; found = { ramp: null, n }; }
    }
  }
  return found;
}

/** Back-compatible: just the wedge, for the HUD's ramp gauge. */
export function findSurfRamp(x, y, z, radius, reach = 4) {
  const c = findSurfContact(x, y, z, radius, MOVE.standHeight, reach);
  return c && c.ramp ? c.ramp : null;
}

export function triggersAt(pos, radius, height, out) {
  const hits = out || [];
  hits.length = 0;
  for (const t of TRIGGERS) {
    if (pos.x + radius <= t.minX || pos.x - radius >= t.maxX) continue;
    if (pos.z + radius <= t.minZ || pos.z - radius >= t.maxZ) continue;
    if (pos.y + height <= t.minY || pos.y >= t.maxY) continue;
    hits.push(t);
  }
  return hits;
}

/* ---------------- velocity clipping (Source ClipVelocity) ---------------- */

export function clipVelocity(vel, n, overbounce = 1.0) {
  const backoff = (vel.x * n.x + vel.y * n.y + vel.z * n.z) * overbounce;
  if (backoff >= 0) return false;                    // already separating
  vel.x -= n.x * backoff; vel.y -= n.y * backoff; vel.z -= n.z * backoff;
  return true;
}

/* ---------------- collision resolution ---------------- */

/**
 * Push the hull out of one axis-aligned box along its least-penetrating axis
 * and clip the velocity into that face.
 */
function pushOutBox(s, pos, vel, height, radius, wasOnGround, airborneRising) {
  const ox = Math.min(s.maxX - (pos.x - radius), (pos.x + radius) - s.minX);
  const oz = Math.min(s.maxZ - (pos.z - radius), (pos.z + radius) - s.minZ);
  const oyUp = s.maxY - pos.y;                       // lift out through the top
  const oyDn = (pos.y + height) - s.minY;            // drop out through the bottom
  const oy = Math.min(oyUp, oyDn);

  // A hull rising into a box is never resolved by teleporting it on top:
  // that is what would turn a wall clipped at head height into a free step.
  const allowY = !airborneRising || oyDn < oyUp;

  if (allowY && oy <= ox && oy <= oz) {
    if (oyUp <= oyDn) { pos.y = s.maxY; clipVelocity(vel, UP); }
    else { pos.y = s.minY - height - 0.01; clipVelocity(vel, { x: 0, y: -1, z: 0 }); }
    return;
  }
  if (ox < oz) {
    if (pos.x < (s.minX + s.maxX) * 0.5) { pos.x = s.minX - radius; clipVelocity(vel, { x: -1, y: 0, z: 0 }); }
    else { pos.x = s.maxX + radius; clipVelocity(vel, { x: 1, y: 0, z: 0 }); }
  } else {
    if (pos.z < (s.minZ + s.maxZ) * 0.5) { pos.z = s.minZ - radius; clipVelocity(vel, { x: 0, y: 0, z: -1 }); }
    else { pos.z = s.maxZ + radius; clipVelocity(vel, { x: 0, y: 0, z: 1 }); }
  }
}

/**
 * Resolve every overlap at the hull's current position.
 *
 * Ramps are resolved first and along their true normal — that ordering is
 * what keeps a ride smooth where a ramp meets the box it is bolted to.
 * `out` collects which ramp (if any) is being ridden, for the HUD.
 */
function resolve(pos, vel, height, canStep, radius, out) {
  let hits = 0;
  const rising = vel.y > 0;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;

    for (const r of RAMPS) {
      if (pos.y >= r.maxY - 0.005) continue;               // wholly above the wedge
      if (pos.y + height <= r.base + 0.005) continue;      // wholly below it
      if (!rampFootprint(r, pos.x, pos.z, radius)) continue;
      const d = rampDist(r, pos.x, pos.y, pos.z, radius);
      if (d >= 0) continue;

      // Buried in the body of the wedge rather than skimming its face: this is
      // a wall hit (you ran into the underside or the high side), so resolve it
      // as the box it visually is instead of levitating up the slope.
      if (-d > MOVE.maxRampPush || pos.y + height < rampSurfaceY(r, pos.x, pos.z) - 0.5) {
        pushOutBox(r, pos, vel, height, radius, canStep, rising);
        moved = true; hits++; continue;
      }

      pos.x -= d * r.n.x; pos.y -= d * r.n.y; pos.z -= d * r.n.z;
      clipVelocity(vel, r.n);
      moved = true; hits++;
      if (out && !r.walkable) { out.ramp = r; }
    }

    for (const b of brushesNear(pos.x - radius, pos.y, pos.z - radius,
                                pos.x + radius, pos.y + height, pos.z + radius, nearby)) {
      if (pos.y >= b.maxY - 0.005 || pos.y + height <= b.minY + 0.005) continue;
      if (pos.x + radius <= b.minX || pos.x - radius >= b.maxX) continue;
      if (pos.z + radius <= b.minZ || pos.z - radius >= b.maxZ) continue;
      const c = brushContact(b, pos.x, pos.y, pos.z, radius, height);
      if (!c) continue;
      // a grounded player steps over a low lip rather than being stopped by it
      if (canStep && c.n.y >= MOVE.walkableNormalY && c.depth <= MOVE.stepHeight + 0.01) continue;
      pos.x += c.n.x * c.depth; pos.y += c.n.y * c.depth; pos.z += c.n.z * c.depth;
      clipVelocity(vel, c.n);
      moved = true; hits++;
      if (out && c.n.y > 0.01 && c.n.y < MOVE.walkableNormalY) out.normal = c.n;
    }

    if (TRIS.count) {
      const ex = radius, ey = height / 2, cy = pos.y + ey;
      for (const t of trianglesNear(pos.x - ex, cy - ey, pos.z - ex,
                                    pos.x + ex, cy + ey, pos.z + ex, nearTris)) {
        const c = triangleContact(t, pos.x, cy, pos.z, ex, ey, ex);
        if (!c || c.depth <= 0) continue;
        const n = triNormalY(t);
        // a grounded player walks over a low lip rather than being stopped
        if (canStep && n.y >= MOVE.walkableNormalY && c.depth <= MOVE.stepHeight + 0.01) continue;
        pos.x += c.x * c.depth; pos.y += c.y * c.depth; pos.z += c.z * c.depth;
        clipVelocity(vel, { x: c.x, y: c.y, z: c.z });
        moved = true; hits++;
        if (out && n.y > 0.01 && n.y < MOVE.walkableNormalY) out.normal = n;
      }
    }

    for (const s of SOLIDS) {
      if (pos.y + height <= s.minY + 0.005 || pos.y >= s.maxY - 0.005) continue;
      if (!(pos.x + radius > s.minX && pos.x - radius < s.maxX)) continue;
      if (!(pos.z + radius > s.minZ && pos.z - radius < s.maxZ)) continue;
      // a grounded player walks over low ledges instead of being stopped by them
      if (canStep && s.maxY - pos.y <= MOVE.stepHeight + 0.01) continue;
      pushOutBox(s, pos, vel, height, radius, canStep, rising);
      moved = true; hits++;
    }

    if (!moved) break;
  }
  return hits;
}

/* ---------------- Source movement primitives ---------------- */

export function applyFriction(vel, dt, surfaceFriction = 1) {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed < 0.1) return;
  const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
  const drop = control * MOVE.friction * surfaceFriction * dt;
  const newSpeed = Math.max(0, speed - drop) / speed;
  vel.x *= newSpeed; vel.y *= newSpeed; vel.z *= newSpeed;
}

/** Ground acceleration — reaches, but never exceeds, wishspeed. */
export function accelerate(vel, wx, wz, wishspeed, accel, dt, surfaceFriction = 1) {
  const currentspeed = vel.x * wx + vel.z * wz;
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return 0;
  let accelspeed = accel * wishspeed * dt * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wx; vel.z += accelspeed * wz;
  return accelspeed;
}

/**
 * Air acceleration. Identical to Accelerate except the *target* speed is
 * clamped to MOVE.airWishCap (30) while the acceleration rate still scales
 * with the full wishspeed.
 *
 * On a surf ramp this runs 128 times a second for the entire length of the
 * ride, and it is the only source of speed you control. Because the target is
 * capped, a wish vector pointing along your velocity contributes nothing once
 * you pass 30 u/s; a wish vector held perpendicular to it adds the full 30 to
 * a sideways component instead, which is why the ceiling per tick works out to
 * sqrt(v^2 + 30^2) - v and why turning the mouse is the whole skill.
 */
export function airAccelerate(vel, wx, wz, wishspeed, accel, dt, surfaceFriction = 1) {
  const wishspd = Math.min(wishspeed, MOVE.airWishCap);
  const currentspeed = vel.x * wx + vel.z * wz;
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return 0;
  let accelspeed = accel * wishspeed * dt * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wx; vel.z += accelspeed * wz;
  return accelspeed;
}

/* ---------------- the tick ---------------- */

/** A fresh physics body. */
export function makeBody(x = 0, y = 0, z = 0) {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    onGround: false, groundNormal: { ...UP }, groundRamp: null,
    surfRamp: null,                       // the steep wedge being ridden this tick, or null
    surfNormal: null,                     // ...or the bare face normal, for brush geometry
    ducking: false, hullHeight: MOVE.standHeight,
    jumped: false, landed: false, wallHits: 0,
    /* per-tick telemetry the HUD reads (never fed back into movement) */
    gain: 0, wishX: 0, wishZ: 0, speed: 0, prevSpeed: 0, vspeed: 0,
  };
}

const contact = { ramp: null, normal: null };
const nearby = [];          // scratch lists for broadphase queries
const nearTris = [];

/**
 * One fixed simulation tick.
 * `cmd` = { forward:-1..1, side:-1..1, yaw, jump:bool, duck:bool, walk:bool }
 * Every term below comes from cmd or from the body's own state. Nothing here
 * ever substitutes a direction the player did not press.
 */
export function playerMove(body, cmd, dt) {
  const M = MOVE;
  const pos = body.pos, vel = body.vel;
  body.jumped = false; body.landed = false; body.gain = 0;
  body.prevSpeed = Math.hypot(vel.x, vel.z);

  /* --- duck --- */
  const wantDuck = !!cmd.duck;
  if (wantDuck !== body.ducking) {
    if (wantDuck) body.ducking = true;
    else if (hullFits(pos.x, pos.y, pos.z, M.standHeight, M.radius)) body.ducking = false;
  }
  const height = body.ducking ? M.duckHeight : M.standHeight;
  body.hullHeight = height;

  /* --- wish direction: look angles x key state, and nothing else --- */
  const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  let wx = (-sy * cmd.forward) + (cy * cmd.side);
  let wz = (-cy * cmd.forward) + (-sy * cmd.side);
  const wlen = Math.hypot(wx, wz);
  let wishspeed = 0;
  if (wlen > 1e-6) {
    wx /= wlen; wz /= wlen;
    wishspeed = M.maxSpeed * (cmd.walk ? M.walkSpeedMul : 1) * (body.ducking && body.onGround ? M.duckSpeedMul : 1);
  } else { wx = 0; wz = 0; }
  body.wishX = wx; body.wishZ = wz;

  /* --- 1. half gravity --- */
  vel.y -= M.gravity * 0.5 * dt;

  /* --- 2. jump (before friction: that is why a frame-perfect hop keeps speed) --- */
  if (cmd.jump && body.onGround) {
    /* PreventBunnyJumping. With sv_enablebunnyhopping off, Source scales your
       velocity back to BUNNYJUMP_MAX_SPEED_FACTOR (1.2) x m_flMaxspeed on the
       tick you jump — 300 u/s with a knife. Note it uses the *3D* speed and
       scales all three components, and that it runs before the jump impulse is
       added, so the vertical kick you are about to get is not scaled with it.
       On flat ground vy is already ~0, so this reads as a horizontal clamp.

       It is also why this can never touch a surf ramp: it needs onGround, and
       a ramp is never ground. Every unit above 300 in a finishing time came
       off a face. */
    if (!RULES.bunnyhopping) {
      const cap = M.maxSpeed * M.bunnyhopFactor;
      const spd = Math.hypot(vel.x, vel.y, vel.z);
      if (spd > cap) { const k = cap / spd; vel.x *= k; vel.y *= k; vel.z *= k; }
    }
    vel.y = M.jumpVel;
    body.onGround = false; body.groundRamp = null; body.jumped = true;
  }

  /* --- 3. friction (skipped entirely on the tick you jump, and never on a ramp) --- */
  if (body.onGround) { vel.y = 0; applyFriction(vel, dt); }

  /* --- 4. accelerate --- */
  const speedBefore = Math.hypot(vel.x, vel.z);
  if (body.onGround) {
    accelerate(vel, wx, wz, wishspeed, M.accelerate, dt);
    vel.y = 0;
  } else {
    airAccelerate(vel, wx, wz, wishspeed, M.airAccelerate, dt);
  }
  body.gain = Math.hypot(vel.x, vel.z) - speedBefore;

  /* --- clamp --- */
  vel.x = clamp(vel.x, -M.maxVelocity, M.maxVelocity);
  vel.y = clamp(vel.y, -M.maxVelocity, M.maxVelocity);
  vel.z = clamp(vel.z, -M.maxVelocity, M.maxVelocity);

  /* --- 5. move ---
     One integration for all three axes, sub-stepped so that at 1500 u/s the
     hull never skips past a ramp face between collision passes. */
  const wasOnGround = body.onGround;
  const prevY = pos.y;
  const dist = Math.hypot(vel.x, vel.y, vel.z) * dt;
  const sub = Math.max(1, Math.min(16, Math.ceil(dist / M.subStepLen)));
  contact.ramp = null; contact.normal = null;
  body.wallHits = 0;
  for (let i = 0; i < sub; i++) {
    pos.x += vel.x * dt / sub;
    pos.y += vel.y * dt / sub;
    pos.z += vel.z * dt / sub;
    body.wallHits += resolve(pos, vel, height, wasOnGround, M.radius, contact);
  }
  body.surfRamp = contact.ramp;
  body.surfNormal = contact.normal;

  /* --- 6. categorise position --- */
  let grounded = false;
  if (vel.y <= 0.1) {
    // reach up by a step (mounting a ledge), and down by a step only if we were
    // already grounded (walking down stairs instead of launching off them). Mid-air
    // ducking tucks the legs, letting a crouch-jump catch a higher edge.
    const tuck = (body.ducking && !wasOnGround) ? M.duckTuck : 0;
    const hi = pos.y + M.stepHeight + tuck;
    const lo = wasOnGround ? pos.y - M.stepHeight : Math.min(pos.y, prevY) - 0.5;
    const g = findGround(pos.x, pos.z, lo, hi, M.radius);
    if (g) {
      pos.y = g.y; grounded = true;
      body.groundNormal = g.n; body.groundRamp = g.ramp;
      if (!wasOnGround) body.landed = true;
      if (g.n.y > 0.999) vel.y = 0; else clipVelocity(vel, g.n);
    }
  }
  if (!grounded) { body.groundNormal = { ...UP }; body.groundRamp = null; }
  body.onGround = grounded;
  if (grounded) { body.surfRamp = null; body.surfNormal = null; }
  else if (contact.ramp || contact.normal) {
    body.surfRamp = contact.ramp;
    body.surfNormal = contact.normal || (contact.ramp ? contact.ramp.n : null);
  } else {
    const c = findSurfContact(pos.x, pos.y, pos.z, M.radius, height);
    body.surfRamp = c ? c.ramp : null;
    body.surfNormal = c ? c.n : null;
  }
  body.surfAngle = body.surfNormal ? Math.acos(Math.min(1, body.surfNormal.y)) * 180 / Math.PI : 0;

  /* --- 7. remaining half gravity (cleared next tick if still grounded) --- */
  vel.y -= M.gravity * 0.5 * dt;

  body.speed = Math.hypot(vel.x, vel.z);
  body.vspeed = vel.y;
  return body;
}
