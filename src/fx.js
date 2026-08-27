/* ============================== [FX] ==============================
   Transient visuals. All of it is feedback about motion — at 1100 u/s a
   still frame looks exactly like one at 250, so the game has to say so.   */
import * as THREE from 'three';
import { scene } from './core.js';
import { NEON } from './world.js';

const live = [];
const RING = new THREE.RingGeometry(0.7, 1, 24);

function ring(x, y, z, color, r0, r1, life, flat = true) {
  const m = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.position.set(x, y, z);
  if (flat) m.rotation.x = -Math.PI / 2;
  m.scale.setScalar(r0);
  scene.add(m);
  live.push({ m, t: 0, life, r0, r1, delay: 0 });
  return m;
}

export function fxLand(x, y, z, impact) {
  ring(x, y + 2, z, impact > 0.6 ? NEON.rose : NEON.cyan, 12, 46 + impact * 80, 0.34);
}
export function fxJump(x, y, z) { ring(x, y + 3, z, NEON.lime, 10, 40, 0.24); }
export function fxCheckpoint(x, y, z) {
  for (let i = 0; i < 3; i++) {
    ring(x, y + 8 + i * 70, z, NEON.lime, 30, 340, 0.75);
    live[live.length - 1].delay = i * 0.09;
  }
}
export function fxFinish(x, y, z) {
  for (let i = 0; i < 6; i++) {
    ring(x, y + 10 + i * 50, z, i % 2 ? NEON.amber : NEON.rose, 20, 560, 1.3);
    live[live.length - 1].delay = i * 0.08;
  }
}
export function fxFall(x, y, z) { ring(x, y, z, NEON.rose, 20, 220, 0.5); }

export function updateFx(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const f = live[i];
    if (f.delay > 0) { f.delay -= dt; f.m.visible = f.delay <= 0; continue; }
    f.m.visible = true;
    f.t += dt;
    const k = f.t / f.life;
    f.m.scale.setScalar(f.r0 + (f.r1 - f.r0) * (1 - (1 - k) * (1 - k)));
    f.m.material.opacity = Math.max(0, 0.9 * (1 - k));
    if (f.t >= f.life) { scene.remove(f.m); f.m.material.dispose(); live.splice(i, 1); }
  }
  updateTrail(dt);
}

/* ---------------- ramp trail ----------------
   A dot dropped on the face a few times a second while you are riding it.
   The line it leaves behind is your own racing line — the single most useful
   thing you can look at on a second attempt down the same ramp. */
const TRAIL = 220;
let trail = null, trailAge = null, trailPos = null, trailN = 0, trailClock = 0;

export function initTrail() {
  trailPos = new Float32Array(TRAIL * 3);
  trailAge = new Float32Array(TRAIL).fill(99);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trail = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x8ff6ff, size: 11, sizeAttenuation: true, transparent: true, opacity: 0.55,
    depthWrite: false, fog: true,
  }));
  trail.frustumCulled = false;
  scene.add(trail);
}

export function dropTrail(x, y, z, dt) {
  trailClock += dt;
  if (!trail || trailClock < 0.045) return;
  trailClock = 0;
  const i = trailN % TRAIL;
  trailPos[i * 3] = x; trailPos[i * 3 + 1] = y + 3; trailPos[i * 3 + 2] = z;
  trailAge[i] = 0;
  trailN++;
  trail.geometry.attributes.position.needsUpdate = true;
}

function updateTrail(dt) {
  if (!trail) return;
  let alive = 0;
  for (let i = 0; i < TRAIL; i++) {
    if (trailAge[i] < 3) { trailAge[i] += dt; if (trailAge[i] < 3) alive++; }
    else if (trailPos[i * 3 + 1] !== -99999) {
      trailPos[i * 3 + 1] = -99999;                 // park expired dots below the world
      trail.geometry.attributes.position.needsUpdate = true;
    }
  }
  trail.visible = alive > 0;
}

/* ---------------- the personal-best ghost ---------------- */
let ghostMesh = null;
export function initGhost() {
  const g = new THREE.BoxGeometry(32, 72, 32);
  ghostMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color: 0xffc23f, transparent: true, opacity: 0.20, depthWrite: false, fog: true,
  }));
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g),
    new THREE.LineBasicMaterial({ color: 0xffc23f, transparent: true, opacity: 0.75, fog: true }));
  ghostMesh.add(edge);
  ghostMesh.visible = false;
  scene.add(ghostMesh);
}
export function setGhost(p) {
  if (!ghostMesh) return;
  if (!p) { ghostMesh.visible = false; return; }
  ghostMesh.visible = true;
  ghostMesh.position.set(p.x, p.y + 36, p.z);
}
