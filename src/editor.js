/* ============================== [EDITOR] ==============================
   A 3D editor for a map's volumes.

   A real surf map's timing zones and teleports are whatever its author put in
   the .bsp, and on a map read by something that is not the engine it was built
   for, some of them are wrong: a start zone that was never named as one, a
   teleport that covers a corridor you are supposed to fly through, a death
   volume sitting across the route. You cannot fix those by reading numbers.
   You have to go and look at them.

   So: fly the map with no collision, see every volume as a coloured box drawn
   through the walls, point at one and move it, resize it, delete it, or drop a
   new start or finish where you are standing. The change is live — the volumes
   you are editing are the same objects the game is firing — and what comes out
   is a patch for maps/edits.json, which is the only thing that persists. The
   packed map is never touched.

   Nothing here runs unless the editor is open.                              */
import * as THREE from 'three';
import { scene, camera } from './core.js';
import { MAP } from './mapkit.js';
import { TRIGGERS, trigger, BRUSHES, findGround } from './physics.js';
import { view } from './player.js';
import { mouse, consumeLook, clearLook, endFrame } from './input.js';
import { MOVE } from './config.js';
import { volumeKeys, volumeToJson, emptyEdits, withEdits, setEdits } from './mapedits.js';

/* What each kind of volume is, and what colour it is drawn in. Start is green
   and finish is red because those are the two you are looking for. */
export const KINDS = {
  start:    { color: 0x33ff88, label: 'START' },
  finish:   { color: 0xff3355, label: 'FINISH' },
  teleport: { color: 0x49c8ff, label: 'TELEPORT' },
  kill:     { color: 0xff9d3f, label: 'DEATH' },
  prespeed: { color: 0xa88bff, label: 'PRESPEED' },
};
const OTHER = { color: 0x8b98bd, label: 'OTHER' };
const kindOf = k => KINDS[k] || OTHER;

const DEFAULT_ZONE = { w: 320, h: 192, d: 320 };       // a new start/finish, in units

let on = false;
let cursor = false;                                     // pointer released, panel clickable
let group = null;
let items = [];                                         // one per live volume
let sel = -1;
let speed = 900;
let showBrushes = false;
let brushGroup = null;
let status = '';
const held = new Set();

/* Scratch, so the frame loop allocates nothing. */
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
const ray = new THREE.Ray();
const box3 = new THREE.Box3();
const hit = new THREE.Vector3();

export const isEditing = () => on;
export const inCursorMode = () => cursor;

/* ---------------- drawing ---------------- */

const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const boxSolid = new THREE.BoxGeometry(1, 1, 1);

/**
 * One volume's wireframe.
 *
 * depthTest is off on purpose: the whole point is to see a volume that is
 * buried inside the map, which is where the troublesome ones always are.
 */
function makeLines(color, opacity, width) {
  const m = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false,
  }));
  m.renderOrder = 900 + (width || 0);
  m.frustumCulled = false;
  return m;
}

function place(mesh, t) {
  mesh.position.set((t.minX + t.maxX) / 2, (t.minY + t.maxY) / 2, (t.minZ + t.maxZ) / 2);
  mesh.scale.set(
    Math.max(1, t.maxX - t.minX),
    Math.max(1, t.maxY - t.minY),
    Math.max(1, t.maxZ - t.minZ),
  );
}

/** A line from a teleport to wherever it sends you, and a marker at that end. */
function destMarker(t, color) {
  if (t.kind !== 'teleport' || t.tx == null) return null;
  const g = new THREE.Group();
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3((t.minX + t.maxX) / 2, (t.minY + t.maxY) / 2, (t.minZ + t.maxZ) / 2),
    new THREE.Vector3(t.tx, t.ty, t.tz),
  ]);
  g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, fog: false,
  })));
  const m = makeLines(color, 0.9);
  m.position.set(t.tx, t.ty + 36, t.tz);
  m.scale.set(64, 72, 64);
  g.add(m);
  g.renderOrder = 900;
  return g;
}

/** Rebuild every box from the live trigger list. */
export function editorRefresh() {
  if (group) { scene.remove(group); disposeGroup(group); }
  group = new THREE.Group();
  group.renderOrder = 900;
  items = [];
  for (const t of TRIGGERS) {
    const k = kindOf(t.kind);
    const line = makeLines(k.color, t.kind === 'prespeed' ? 0.25 : 0.75);
    place(line, t);
    group.add(line);
    const dest = destMarker(t, k.color);
    if (dest) group.add(dest);
    items.push({ t, line, dest, fill: null });
  }
  scene.add(group);
  if (sel >= items.length) sel = items.length - 1;
  applySelection();
  render();                    // the list is the boxes; it cannot be left behind
}

function disposeGroup(g) {
  g.traverse(n => {
    if (n.geometry && n.geometry !== boxEdges && n.geometry !== boxSolid) n.geometry.dispose?.();
    if (n.material) n.material.dispose?.();
  });
}

/** The selected volume gets a filled ghost so it reads at a glance. */
function applySelection() {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const k = kindOf(it.t.kind);
    const chosen = i === sel;
    /* A selected volume keeps its own colour — the whole point of green and
       red is that you can find them — and is picked out by being solid-bright
       with a filled ghost inside it instead. */
    it.line.material.opacity = chosen ? 1 : (it.t.kind === 'prespeed' ? 0.25 : 0.55);
    if (chosen && !it.fill) {
      it.fill = new THREE.Mesh(boxSolid, new THREE.MeshBasicMaterial({
        color: k.color, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }));
      it.fill.renderOrder = 899;
      it.fill.frustumCulled = false;
      place(it.fill, it.t);
      group.add(it.fill);
    } else if (!chosen && it.fill) {
      group.remove(it.fill); it.fill.material.dispose(); it.fill = null;
    }
  }
}

/** After a volume's numbers change, move its boxes to match. */
function reshape(i) {
  const it = items[i];
  place(it.line, it.t);
  if (it.fill) place(it.fill, it.t);
  if (it.dest) {
    group.remove(it.dest); disposeGroup(it.dest);
    it.dest = destMarker(it.t, kindOf(it.t.kind).color);
    if (it.dest) group.add(it.dest);
  }
}

/* ---------------- collision, when you need to see it ----------------
   "I cannot get past here" is as often a brush as a volume, so the brushes
   near you can be drawn too. Near you only: a map has four thousand. */
function rebuildBrushes() {
  if (brushGroup) { scene.remove(brushGroup); disposeGroup(brushGroup); brushGroup = null; }
  if (!showBrushes) return;
  brushGroup = new THREE.Group();
  const p = view.body.pos, R = 1600;
  let n = 0;
  for (const b of BRUSHES) {
    if (b.maxX < p.x - R || b.minX > p.x + R) continue;
    if (b.maxY < p.y - R || b.minY > p.y + R) continue;
    if (b.maxZ < p.z - R || b.minZ > p.z + R) continue;
    const m = makeLines(b.walkable ? 0x35e0c8 : 0xff5d8f, 0.35);
    m.material.depthTest = true;
    place(m, { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ });
    brushGroup.add(m);
    if (++n > 400) break;
  }
  scene.add(brushGroup);
  status = `${n} brushes within ${R}u`;
}

/* ---------------- selection ---------------- */

/** The volume the crosshair is on, nearest first. */
function pick() {
  euler.set(view.pitch, view.yaw, 0, 'YXZ');
  fwd.set(0, 0, -1).applyEuler(euler);
  ray.origin.set(view.body.pos.x, view.body.pos.y + view.eye, view.body.pos.z);
  ray.direction.copy(fwd);

  let best = -1, bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    const t = items[i].t;
    /* The prespeed zone wraps the start zone and is bigger, so aiming at a
       start would always hit it first — and it is derived anyway, so there is
       nothing to edit. It stays visible, and stays selectable from the list. */
    if (t.kind === 'prespeed') continue;
    box3.min.set(t.minX, t.minY, t.minZ);
    box3.max.set(t.maxX, t.maxY, t.maxZ);
    // standing inside a volume counts as pointing at it
    if (box3.containsPoint(ray.origin)) { if (0 < bestD) { bestD = 0; best = i; } continue; }
    if (!ray.intersectBox(box3, hit)) continue;
    const d = ray.origin.distanceToSquared(hit);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function selectIndex(i) {
  sel = i >= 0 && i < items.length ? i : -1;
  applySelection();
  render();
}

/** Fly to the selected volume, far enough back to see all of it. */
function gotoSelected() {
  if (sel < 0) return;
  const t = items[sel].t;
  const cx = (t.minX + t.maxX) / 2, cy = (t.minY + t.maxY) / 2, cz = (t.minZ + t.maxZ) / 2;
  const back = Math.max(320, Math.hypot(t.maxX - t.minX, t.maxY - t.minY, t.maxZ - t.minZ));
  euler.set(view.pitch, view.yaw, 0, 'YXZ');
  fwd.set(0, 0, -1).applyEuler(euler);
  view.body.pos.x = cx - fwd.x * back;
  view.body.pos.y = cy - fwd.y * back;
  view.body.pos.z = cz - fwd.z * back;
  view.prev = { ...view.body.pos };
  status = 'flew to the selection';
}

/* ---------------- edits ---------------- */

const AXES = [['minX', 'maxX'], ['minY', 'maxY'], ['minZ', 'maxZ']];

/**
 * Whole units.
 *
 * An edits file stores integers — map coordinates are integers in Hammer, and
 * a patch full of 12511.990234375 is a patch nobody can read. Snapping the
 * live volume the moment it is touched means what you see on screen is exactly
 * what comes back when the file is loaded again, rather than half a unit off.
 */
function snapBox(t) {
  t.minX = Math.round(t.minX); t.maxX = Math.round(t.maxX);
  t.minY = Math.round(t.minY); t.maxY = Math.round(t.maxY);
  t.minZ = Math.round(t.minZ); t.maxZ = Math.round(t.maxZ);
}

/** Move the whole box along an axis. */
function move(axis, d) {
  if (sel < 0) return;
  const t = items[sel].t;
  const [lo, hi] = AXES[axis];
  snapBox(t);
  t[lo] += d; t[hi] += d;
  reshape(sel);
}

/** Grow or shrink about the middle, never through itself. */
function resize(axis, d) {
  if (sel < 0) return;
  const t = items[sel].t;
  const [lo, hi] = AXES[axis];
  if (d < 0 && t[hi] - t[lo] <= 16) return;
  snapBox(t);
  t[lo] -= d; t[hi] += d;
  reshape(sel);
}

/** Drop a new zone on the floor in front of you. */
export function addZone(kind) {
  euler.set(view.pitch, view.yaw, 0, 'YXZ');
  fwd.set(0, 0, -1).applyEuler(euler);
  const ahead = 200;
  let x = view.body.pos.x + fwd.x * ahead;
  let y = view.body.pos.y + fwd.y * ahead;
  let z = view.body.pos.z + fwd.z * ahead;
  // sit it on whatever is underneath, if anything is
  const g = findGround(x, z, y - 1024, y + 256, MOVE.radius);
  if (g) y = g.y;

  x = Math.round(x); y = Math.round(y); z = Math.round(z);
  const t = trigger(
    x - DEFAULT_ZONE.w / 2, x + DEFAULT_ZONE.w / 2,
    y, y + DEFAULT_ZONE.h,
    z - DEFAULT_ZONE.d / 2, z + DEFAULT_ZONE.d / 2,
    { kind, origin: null },
  );
  syncPrespeed();
  editorRefresh();
  selectIndex(items.length - 1);
  status = `new ${kindOf(kind).label.toLowerCase()} zone — nudge it into place`;
  return t;
}

/**
 * The prespeed cap belongs to the start line, so it is rebuilt from it.
 *
 * It is derived, never authored and never exported — but it is also the thing
 * that holds a run to 350 u/s off the line, so losing it while editing would
 * quietly change the rules of the map you are looking at.
 */
function syncPrespeed() {
  for (let i = TRIGGERS.length - 1; i >= 0; i--) {
    if (TRIGGERS[i].kind === 'prespeed') TRIGGERS.splice(i, 1);
  }
  const s = TRIGGERS.find(t => t.kind === 'start');
  if (!s) return;
  trigger(s.minX - 64, s.maxX + 64, s.minY - 64, s.maxY + 512, s.minZ - 64, s.maxZ + 64,
    { kind: 'prespeed', cap: MAP.prespeed, origin: null });
}

/** Take the selected volume out of the map. */
export function removeSelected() {
  if (sel < 0) return;
  const t = items[sel].t;
  const at = TRIGGERS.indexOf(t);
  if (at >= 0) TRIGGERS.splice(at, 1);
  const was = kindOf(t.kind).label.toLowerCase();
  syncPrespeed();
  editorRefresh();
  selectIndex(Math.min(sel, items.length - 1));
  status = `${was} removed`;
}

/** Put every one of the map's own volumes back, dropping the patch. */
export function revertAll() {
  const orig = MAP.editable && MAP.editable.original;
  if (!orig) return;
  TRIGGERS.length = 0;
  const keys = volumeKeys(orig);
  for (let i = 0; i < orig.length; i++) {
    const v = orig[i];
    trigger(v.minX, v.maxX, v.minY, v.maxY, v.minZ, v.maxZ, { ...v.data, origin: keys[i] });
  }
  syncPrespeed();
  editorRefresh();
  selectIndex(-1);
  status = 'back to the map as extracted';
}

/**
 * The patch, derived from what is on screen.
 *
 * Rebuilt from scratch every time rather than kept up to date edit by edit:
 * the live volumes are the truth, and a patch computed from them cannot drift
 * out of step with what you are looking at.
 */
export function currentPatch() {
  if (!MAP.editable) return emptyEdits(MAP.id);
  const id = MAP.editable.id;
  const orig = MAP.editable.original || [];
  const keys = volumeKeys(orig);
  const byKey = new Map();
  for (let i = 0; i < orig.length; i++) byKey.set(keys[i], orig[i]);

  const patch = emptyEdits(id);
  const seen = new Set();
  for (const it of items) {
    const t = it.t;
    if (t.kind === 'prespeed') continue;               // derived from the start zone
    const json = volumeToJson(asVolume(t));
    if (t.origin) {
      seen.add(t.origin);
      const before = byKey.get(t.origin);
      if (!before || JSON.stringify(volumeToJson(before)) !== JSON.stringify(json)) {
        patch.replace[t.origin] = json;
      }
    } else {
      patch.add.push(json);
    }
  }
  for (const k of keys) if (!seen.has(k)) patch.disable.push(k);
  return patch;
}

/** A live trigger record, back in the shape an edits file uses. */
const asVolume = t => ({
  minX: t.minX, maxX: t.maxX, minY: t.minY, maxY: t.maxY, minZ: t.minZ, maxZ: t.maxZ,
  data: { kind: t.kind, tx: t.tx, ty: t.ty, tz: t.tz, tyaw: t.tyaw },
});

/** The whole edits file, this map's entry brought up to date. */
export async function exportJson() {
  /* Only a course built from a file can be patched. The two built-in ones are
     written in code, and their volumes live in src/maps/, so exporting a patch
     for one would produce a file that silently does nothing. */
  if (!MAP.editable) return null;
  const id = MAP.editable.id;
  const patch = currentPatch();
  setEdits(id, patch.disable.length || Object.keys(patch.replace).length || patch.add.length ? patch : null);
  const all = await withEdits(id, patch);
  return JSON.stringify(all, null, 2) + '\n';
}

/* ---------------- the frame ---------------- */

/** Fly. No collision, no gravity: this is the point of the mode. */
export function editorFrame(dt) {
  if (mouse.locked) { const applyLook = consumeLook(view, 1); applyLook(); clearLook(); }
  endFrame();

  euler.set(view.pitch, view.yaw, 0, 'YXZ');
  fwd.set(0, 0, -1).applyEuler(euler);
  right.set(1, 0, 0).applyEuler(euler);

  let s = speed * dt;
  if (held.has('ShiftLeft') || held.has('ShiftRight')) s *= 4;
  if (held.has('AltLeft') || held.has('AltRight')) s *= 0.2;

  const p = view.body.pos;
  if (held.has('KeyW')) { p.x += fwd.x * s; p.y += fwd.y * s; p.z += fwd.z * s; }
  if (held.has('KeyS')) { p.x -= fwd.x * s; p.y -= fwd.y * s; p.z -= fwd.z * s; }
  if (held.has('KeyD')) { p.x += right.x * s; p.z += right.z * s; }
  if (held.has('KeyA')) { p.x -= right.x * s; p.z -= right.z * s; }
  if (held.has('Space')) p.y += s;
  if (held.has('ControlLeft') || held.has('ControlRight')) p.y -= s;

  // held nudges, so a box can be dragged rather than tapped into place
  const step = (held.has('ShiftLeft') ? 64 : 8);
  if (sel >= 0) {
    if (held.has('ArrowLeft')) move(0, -step);
    if (held.has('ArrowRight')) move(0, step);
    if (held.has('ArrowDown')) move(2, step);
    if (held.has('ArrowUp')) move(2, -step);
    if (held.has('PageUp')) move(1, step);
    if (held.has('PageDown')) move(1, -step);
  }

  const b = view.body;
  b.vel.x = b.vel.y = b.vel.z = 0;
  b.onGround = false; b.surfRamp = null; b.speed = 0;
  view.prev.x = p.x; view.prev.y = p.y; view.prev.z = p.z;

  if (showBrushes) rebuildBrushes();
  render();
}

/* ---------------- keys ---------------- */

function onDown(e) {
  if (!on) return;
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  held.add(e.code);
}
function onUp(e) { held.delete(e.code); }
function onBlur() { held.clear(); }

/** Returns true if the editor took the key. */
export function editorKey(code) {
  if (!on) return false;
  switch (code) {
    case 'KeyF': selectIndex(pick()); status = sel < 0 ? 'nothing under the crosshair' : 'selected'; return true;
    case 'KeyN': selectIndex(items.length ? (sel + 1) % items.length : -1); return true;
    case 'KeyB': selectIndex(items.length ? (sel - 1 + items.length) % items.length : -1); return true;
    case 'KeyG': gotoSelected(); render(); return true;
    case 'Digit1': addZone('start'); return true;
    case 'Digit2': addZone('finish'); return true;
    case 'KeyX': case 'Delete': removeSelected(); return true;
    case 'KeyC': showBrushes = !showBrushes; rebuildBrushes(); render(); return true;
    case 'BracketLeft': resize(0, -16); resize(1, -16); resize(2, -16); return true;
    case 'BracketRight': resize(0, 16); resize(1, 16); resize(2, 16); return true;
    case 'Tab': setCursor(!cursor); return true;
    case 'KeyZ': revertAll(); render(); return true;
    default: return false;
  }
}

/* ---------------- mode ---------------- */

let dom = null;
export function setEditorDom(d) { dom = d; }

export function setEditing(next, grab) {
  on = next;
  held.clear();
  if (on) {
    editorRefresh();
    setCursor(false, grab);
    status = 'flying — F to select, 1 start, 2 finish, Tab for the panel';
  } else {
    if (group) { scene.remove(group); disposeGroup(group); group = null; }
    if (brushGroup) { scene.remove(brushGroup); disposeGroup(brushGroup); brushGroup = null; }
    items = []; sel = -1; cursor = false; showBrushes = false;
  }
  render();
}

let grabber = null;
export function setGrabber(fn) { grabber = fn; }

export function setCursor(next) {
  cursor = next;
  if (dom && dom.root) dom.root.classList.toggle('cursor', cursor);
  if (cursor) document.exitPointerLock();
  else if (grabber) grabber();
  render();
}

/**
 * The pointer was locked or released; follow it.
 *
 * The browser releases the pointer on its own — Escape, or the window losing
 * focus — so the flag cannot be owned by setCursor alone or the panel ends up
 * saying one thing while the mouse does another.
 */
export function noteLock(locked) {
  cursor = !locked;
  if (dom && dom.root) dom.root.classList.toggle('cursor', cursor);
  status = cursor ? 'cursor free — click the map to fly again' : 'flying';
  render();
}

/* ---------------- the panel ---------------- */

const num = n => (Math.round(n * 10) / 10).toString();

function render() {
  if (!dom || !on) return;
  const counts = {};
  for (const it of items) counts[it.t.kind] = (counts[it.t.kind] || 0) + 1;
  const chips = Object.keys(KINDS)
    .filter(k => counts[k])
    .map(k => `<span style="color:#${kindOf(k).color.toString(16).padStart(6, '0')}">${counts[k]} ${kindOf(k).label.toLowerCase()}</span>`)
    .join(' · ');

  const t = sel >= 0 ? items[sel].t : null;
  const patch = MAP.editable ? currentPatch() : null;
  const changes = patch ? patch.disable.length + Object.keys(patch.replace).length + patch.add.length : 0;

  dom.head.textContent = MAP.name + (MAP.editable ? '' : ' — built-in course, edits are not saved for these');
  dom.counts.innerHTML = chips || 'no volumes';
  dom.status.textContent = status;
  dom.changes.textContent = changes ? `${changes} change${changes === 1 ? '' : 's'} to export` : 'no changes yet';
  dom.changes.classList.toggle('on', changes > 0);

  if (!t) {
    dom.sel.innerHTML = '<i>nothing selected — look at a box and press F</i>';
  } else {
    const k = kindOf(t.kind);
    const row = (label, a, b) =>
      `<label>${label}</label><input data-f="${a}" value="${num(t[a])}"><input data-f="${b}" value="${num(t[b])}">`;
    dom.sel.innerHTML =
      `<b style="color:#${k.color.toString(16).padStart(6, '0')}">${k.label}</b>` +
      `<span class="origin">${t.kind === 'prespeed'
        ? 'derived: rebuilt from the start zone, never saved'
        : (t.origin || 'added here')}</span>` +
      `<div class="grid">${row('X', 'minX', 'maxX')}${row('Y', 'minY', 'maxY')}${row('Z', 'minZ', 'maxZ')}</div>` +
      (t.kind === 'teleport' && t.tx != null
        ? `<div class="dest">sends you to ${num(t.tx)}, ${num(t.ty)}, ${num(t.tz)}</div>` : '');
    for (const input of dom.sel.querySelectorAll('input')) {
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) { snapBox(t); t[input.dataset.f] = Math.round(v); reshape(sel); render(); }
      });
    }
  }
  dom.list.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    const k = kindOf(it.t.kind);
    b.className = 'vrow' + (i === sel ? ' on' : '');
    b.innerHTML = `<i style="background:#${k.color.toString(16).padStart(6, '0')}"></i>` +
      `${k.label.toLowerCase()} <span>${num((it.t.minX + it.t.maxX) / 2)}, ${num((it.t.minY + it.t.maxY) / 2)}, ${num((it.t.minZ + it.t.maxZ) / 2)}</span>`;
    b.addEventListener('click', () => { selectIndex(i); gotoSelected(); render(); });
    dom.list.appendChild(b);
  });
}

export function editorStatus(s) { status = s; render(); }

addEventListener('keydown', onDown);
addEventListener('keyup', onUp);
addEventListener('blur', onBlur);
