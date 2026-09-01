/* ============================== [MAIN] ==============================
   Boot, the fixed-timestep loop, trigger dispatch and the menus.

   The loop runs the movement at a hard 128Hz no matter what the display is
   doing, and hands each tick an equal slice of the frame's mouse movement.
   Air acceleration is a per-tick sum and a surf ramp is twenty unbroken
   seconds of it, so this is the difference between a 60Hz machine and a
   240Hz one gaining the same speed and not.                               */
import { scene, camera, renderer, setFov } from './core.js';
import { MOVE, RULES, SETTINGS, loadSettings, saveSettings } from './config.js';
import { playerMove, triggersAt } from './physics.js';
import { buildMap, MAP, MAPS, DEFAULT_MAP, loadLocalMaps } from './map.js';
import { worldStats } from './world.js';
import { view, spawnAt, resetPlayer, beginTick, updateCamera } from './player.js';
import { initInput, buildCommand, consumeLook, clearLook, endFrame, keyState, setSuspended, mouse } from './input.js';
import {
  RUN, RECORDS, GHOST, loadRecords, clearRecords, resetRun, tickRun, ghostAt, readBest,
  onStartGate, onCheckpoint, onFinish, onFall, formatTime, formatDelta,
} from './timer.js';
import {
  buildHUD, updateHUD, tickMessages, centerMessage, splitPopup,
  refreshPB, showPanel, hidePanel, panelOpen, showResults, buildStageButtons,
} from './hud.js';
import {
  fxLand, fxJump, fxCheckpoint, fxFinish, fxFall, updateFx,
  initTrail, dropTrail, initGhost, setGhost,
} from './fx.js';
import { unlockAudio, updateAudio, sfxJump, sfxLand, sfxCheckpoint, sfxFinish, sfxPB, sfxFall, sfxPad, sfxUi, sfxRamp } from './audio.js';
import {
  isEditing, inCursorMode, setEditing, setCursor, setEditorDom, setGrabber,
  editorFrame, editorKey, editorRefresh, editorStatus, exportJson, noteLock,
  addZone, removeSelected, revertAll,
} from './editor.js';

const $ = s => document.querySelector(s);
const TICK = MOVE.tick;

let booted = false, paused = false, frozen = false;
let acc = 0, last = performance.now();
const inside = new Set();          // triggers we are currently overlapping
let reached = 0;                   // deepest stage entered, run or not — used for the kill floor
let prevYaw = 0, wasSurfing = false;
const ghostPos = { x: 0, y: 0, z: 0 };

/* ============================== triggers ============================== */

const hits = [];
let teleported = false;

function handleTriggers() {
  const b = view.body;
  triggersAt(b.pos, MOVE.radius, b.hullHeight, hits);
  const now = new Set(hits);
  teleported = false;
  for (const t of hits) {
    if (inside.has(t)) continue;                         // enter-edge only
    fire(t);
    if (teleported) return;                              // we are somewhere else now
  }
  for (const t of [...inside]) if (!now.has(t)) inside.delete(t);
  for (const t of hits) inside.add(t);
}

function fire(t) {
  const b = view.body;
  switch (t.kind) {
    case "start": {
      if (onStartGate()) {
        reached = 1;
        centerMessage("GO", MAP.stages[1].hint, 2.4, "#9dff64");
        sfxUi(); refreshPB();
      }
      break;
    }
    case "checkpoint": {
      reached = Math.max(reached, t.index + 2);
      const r = onCheckpoint(t.index);
      if (!r) break;
      const cp = MAP.checkpoints[t.index];
      fxCheckpoint(cp.x, cp.y, cp.z);
      sfxCheckpoint();
      const pace = r.pace == null ? "" :
        `<span style="color:${r.pace <= 0 ? "#9dff64" : "#ff5d8f"}">${formatDelta(r.pace)}</span> `;
      splitPopup(r.name, `${pace}${r.split.toFixed(2)}s${r.stageBest ? "  &#9733; stage best" : ""}`,
        r.stageBest ? "#9dff64" : "#35e0c8");
      const nxt = MAP.stages[RUN.stage];
      centerMessage(formatTime(r.at), nxt ? nxt.name + " — " + nxt.hint : "", 2.8, r.stageBest ? "#9dff64" : "#fff");
      break;
    }
    case "finish": {
      reached = MAP.stages.length - 1;
      const f = onFinish();
      if (!f) break;
      fxFinish(MAP.finishPad.x, MAP.finishPad.y, MAP.finishPad.z);
      f.pb ? sfxPB() : sfxFinish();
      refreshPB();
      showResults(f);
      document.exitPointerLock();
      setSuspended(true);
      frozen = true;            // the run is over: stop simulating behind the panel
      break;
    }
    case "teleport": {
      /* The map's own answer to coming off a ramp, and to finishing a stage.
         Velocity is dropped because that is what a surf map's reset expects;
         the clock keeps running, which is what a timer does. */
      spawnAt({ x: t.tx, y: t.ty, z: t.tz, yaw: t.tyaw });
      inside.clear();
      fxFall(b.pos.x, b.pos.y, b.pos.z);
      sfxPad();
      centerMessage("TELEPORT", "", 1.0, "#49c8ff");
      teleported = true;
      break;
    }
    case "jumppad": {
      if (b.vel.y < t.up) b.vel.y = t.up;
      b.onGround = false;
      fxJump(b.pos.x, b.pos.y, b.pos.z);
      sfxPad();
      break;
    }
  }
}

/* ============================== per-tick bookkeeping ============================== */

const AIR_CAP2 = MOVE.airWishCap * MOVE.airWishCap;

/** The height below which this part of the course counts as a fall. */
function killY() {
  const s = MAP.stages[Math.min(MAP.stages.length - 1, Math.max(RUN.stage, reached))];
  return s ? s.floorY : -20000;
}

function postTick() {
  const b = view.body;

  if (b.jumped) { RUN.jumps++; fxJump(b.pos.x, b.pos.y, b.pos.z); sfxJump(); }
  if (b.landed) {
    const impact = Math.min(1, Math.abs(b.vel.y) / 800 + b.speed / 1500);
    fxLand(b.pos.x, b.pos.y, b.pos.z, impact);
    sfxLand(impact);
  }
  const surfing = !!b.surfRamp;
  if (surfing && !wasSurfing) sfxRamp();
  wasSurfing = surfing;
  if (b.speed > RUN.topSpeed && RUN.state === "running") RUN.topSpeed = b.speed;

  /* Strafe efficiency: this tick's gain against the theoretical per-tick
     ceiling, sqrt(v^2 + 30^2) - v, which is what a perfect 90-degree wish
     vector would have given. It is a readout, never an input. */
  if (!b.onGround) {
    const v = b.prevSpeed;
    const ceiling = Math.sqrt(v * v + AIR_CAP2) - v;
    const eff = ceiling > 1e-6 ? Math.max(0, Math.min(1, b.gain / ceiling)) : 0;
    view.sync += (eff - view.sync) * 0.045;
    view.gainPerSec += (b.gain / TICK - view.gainPerSec) * 0.09;
  } else {
    view.sync += (0 - view.sync) * 0.02;
    view.gainPerSec += (0 - view.gainPerSec) * 0.12;
  }

  handleTriggers();

  /* The prespeed zone. A surf server clamps you inside the start area so no run
     can begin with speed carried in from outside it. */
  for (const t of hits) {
    if (t.kind !== "prespeed") continue;
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (sp > t.cap) { const k = t.cap / sp; b.vel.x *= k; b.vel.z *= k; b.speed = t.cap; }
  }

  // A kill volume under the ride line, or the stage floor as a backstop.
  if (b.pos.y < killY() || hits.some(t => t.kind === "kill")) fell();

  tickRun(TICK, b);
}

/** Off the course. On a one-shot map that is the whole run. */
function fell() {
  const b = view.body;
  fxFall(b.pos.x, b.pos.y, b.pos.z);
  sfxFall();
  if (MAP.oneShot && RUN.state === "running") {
    restartRun(true);
    centerMessage("RUN OVER", "one shot, no checkpoints — back to the start", 2.8, "#ff5d8f");
    return;
  }
  spawnAt(onFall());
  inside.clear();
  centerMessage("FELL", RUN.state === "running"
    ? "back to the checkpoint — the clock is still running"
    : "back to the checkpoint", 1.8, "#ff5d8f");
}

/* ============================== loop ============================== */

/**
 * Advance the simulation by `dt` seconds of wall clock, in whole 128Hz ticks.
 * Split out of the render loop so the exact input -> movement -> trigger path
 * can be driven headlessly (window.SURF.simulate) instead of only by rAF.
 */
export function simulate(dt) {
  acc += dt;
  let steps = Math.floor(acc / TICK);
  if (steps > MOVE.maxSubSteps) { steps = MOVE.maxSubSteps; acc = steps * TICK; }

  if (steps > 0) {
    const applyLook = consumeLook(view, steps);
    for (let i = 0; i < steps; i++) {
      prevYaw = view.yaw;
      applyLook();
      view.turnRate = (view.yaw - prevYaw) / TICK;
      beginTick();
      const cmd = buildCommand(view, i);
      view.sideInput = cmd.side;
      playerMove(view.body, cmd, TICK);
      postTick();
      acc -= TICK;
    }
    clearLook();
  } else if (mouse.locked) {
    // frame rate above the sim rate: keep aiming instant, the ticks catch up
    const applyLook = consumeLook(view, 1); applyLook(); clearLook();
  }
  endFrame();
  view.keys = keyState();
  return steps;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000); last = now;

  // In the editor there is no physics: the camera flies and the map holds still,
  // which also means the clock stops, because the clock only ticks inside simulate().
  if (isEditing()) { if (!paused) editorFrame(dt); }
  else if (booted && !paused && !frozen) simulate(dt);

  const b = view.body;
  updateCamera(booted ? acc / TICK : 0, dt);
  // a loaded map lights itself, from its own lamps
  if (MAP.onFrame) MAP.onFrame(b.pos, dt);
  if (booted && !paused && !frozen && b.surfRamp) dropTrail(b.pos.x, b.pos.y, b.pos.z, dt);
  updateFx(dt);

  if (booted) {
    updateHUD(view, dt);
    tickMessages(dt);
    updateAudio(b.speed, !b.onGround, !!b.surfRamp);
    setGhost(SETTINGS.showGhost && RUN.state === "running" && GHOST.points
      ? ghostAt(RUN.time, ghostPos) : null);
  }
  renderer.render(scene, camera);
}

/* ============================== menus & keys ============================== */

/** Pointer lock is refused in some embeds; the game still has to run. */
function grabMouse() {
  try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch (e) {}
}

function pause(on) {
  paused = on;
  setSuspended(on);
  if (on) { acc = 0; showPanel("pausePanel"); document.exitPointerLock(); }
  else { hidePanel("pausePanel"); grabMouse(); }
}

function restartRun(full = true) {
  frozen = false;
  const p = full ? resetRun() : (RUN.respawn || MAP.spawn);
  if (full) { inside.clear(); RUN.state = "idle"; reached = 0; }
  spawnAt(p);
  hidePanel("resultsPanel");
  centerMessage(full ? "RESTART" : "CHECKPOINT", "", 1.0, "#35e0c8");
}

/** Practice: drop in at a checkpoint with the clock stopped. Checkpointed maps only. */
function gotoStage(i) {
  frozen = false;
  resetRun();
  inside.clear();
  if (i < 0) { spawnAt(MAP.spawn); reached = 0; }
  else {
    const cp = MAP.checkpoints[i];
    RUN.respawn = { x: cp.x, y: cp.y, z: cp.z, yaw: cp.yaw };
    RUN.stage = i + 2; reached = i + 2;
    spawnAt(RUN.respawn);
  }
  RUN.state = "idle";
  pause(false);
  centerMessage(i < 0 ? "START" : MAP.stages[i + 2].name,
    "practice — run through the start gate for a timed attempt", 2.6, "#35e0c8");
}

function onKey(code) {
  if (code === "F4") { toggleEditor(); return true; }
  if (isEditing()) {
    if (code === "Escape") {
      if (inCursorMode()) { setCursor(false); return true; }
      toggleEditor(); return true;
    }
    if (editorKey(code)) return true;
    return true;                       // the editor owns the keyboard while it is open
  }
  if (code === "Escape") {
    if ($("#resultsPanel").classList.contains("show")) {
      hidePanel("resultsPanel"); restartRun(true); setSuspended(false);
      grabMouse(); return true;
    }
    if (booted) { pause(!paused); return true; }
    return false;
  }
  if (!booted || paused) return false;
  switch (code) {
    case "KeyR": restartRun(true); return true;
    case "KeyQ": if (MAP.oneShot) { restartRun(true); } else { RUN.falls++; restartRun(false); } return true;
    case "Tab": $("#recordsPanel").classList.toggle("show"); return true;
    case "F1": SETTINGS.autoHop = !SETTINGS.autoHop; saveSettings(); syncSettingsUI();
      centerMessage("AUTO-HOP " + (SETTINGS.autoHop ? "ON" : "OFF"),
        "timing only, and only on flat ground", 2.2, "#35e0c8"); return true;
    case "F2": SETTINGS.showKeys = !SETTINGS.showKeys; saveSettings(); syncSettingsUI(); return true;
    case "F3": SETTINGS.showSync = !SETTINGS.showSync; saveSettings(); syncSettingsUI(); return true;
    case "KeyM": SETTINGS.sound = !SETTINGS.sound; saveSettings(); syncSettingsUI(); return true;
  }
  return false;
}

function syncSettingsUI() {
  const set = (id, prop, v) => { const e = $(id); if (e) e[prop] = v; };
  set("#optSens", "value", SETTINGS.sensitivity); set("#optSensVal", "textContent", SETTINGS.sensitivity.toFixed(2));
  set("#optFov", "value", SETTINGS.fov); set("#optFovVal", "textContent", SETTINGS.fov + "°");
  set("#optAutohop", "checked", SETTINGS.autoHop);
  set("#optGhost", "checked", SETTINGS.showGhost);
  set("#optKeys", "checked", SETTINGS.showKeys);
  set("#optSync", "checked", SETTINGS.showSync);
  set("#optSound", "checked", SETTINGS.sound);
}

function wireSettings() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
  const toggle = (id, key) => on(id, "change", e => { SETTINGS[key] = e.target.checked; saveSettings(); });
  on("#optSens", "input", e => { SETTINGS.sensitivity = +e.target.value; $("#optSensVal").textContent = SETTINGS.sensitivity.toFixed(2); saveSettings(); });
  on("#optFov", "input", e => { SETTINGS.fov = +e.target.value; $("#optFovVal").textContent = SETTINGS.fov + "°"; setFov(SETTINGS.fov); saveSettings(); });
  toggle("#optAutohop", "autoHop");
  toggle("#optGhost", "showGhost");
  toggle("#optKeys", "showKeys");
  toggle("#optSync", "showSync");
  toggle("#optSound", "sound");
  on("#btnResume", "click", () => pause(false));
  on("#btnRestart", "click", () => { pause(false); restartRun(true); });
  on("#btnWipe", "click", () => {
    if (confirm("Erase your personal best, every stage record and the ghost?")) { clearRecords(); refreshPB(); }
  });
  const again = () => { hidePanel("resultsPanel"); setSuspended(false); restartRun(true); grabMouse(); };
  on("#btnAgain", "click", again);
  on("#btnCloseResults", "click", again);
}

/* ============================== maps ============================== */

const LS_MAP = "surf.map.v1";
let mapId = DEFAULT_MAP;
let loadingId = null;                  // the map being fetched, if any

function loadMapChoice() {
  try { return localStorage.getItem(LS_MAP) || DEFAULT_MAP; } catch (e) { return DEFAULT_MAP; }
}

const MB = n => (n / 1048576).toFixed(1);

/** What the card being loaded says while it is loading. */
function loadNote(card, text, bad) {
  if (!card) return;
  let e = card.querySelector("u");
  if (!e) { e = document.createElement("u"); card.appendChild(e); }
  e.textContent = text;
  e.classList.toggle("bad", !!bad);
}

/**
 * Build a course and hand the rest of the game its records. MAP is repopulated
 * in place, so nothing else needs to be told the map changed — but the HUD's
 * split rows and the practice list are per-course and do get rebuilt.
 *
 * A packed map is a download, so this can take a while and can fail. Only one
 * runs at a time: two builds racing both call beginMap(), which empties the
 * world in place, and the loser would finish last and win. And `mapId` only
 * moves once the build has succeeded, so a failed download leaves the picker
 * describing the map you are actually still on.
 */
async function selectMap(id, card) {
  if (loadingId) return;
  const want = MAPS.some(m => m.id === id) ? id : DEFAULT_MAP;
  const entry = MAPS.find(m => m.id === want);
  loadingId = want;
  setPlayEnabled(false);
  const picker = $("#mapPicker");
  if (picker) picker.classList.add("busy");
  if (entry && entry.bytes) loadNote(card, `fetching ${MB(entry.bytes)} MB`);

  try {
    await buildMap(want, (got, total, phase) => {
      if (phase === 'building') return loadNote(card, "building the map");
      loadNote(card, total ? `${MB(got)} of ${MB(total)} MB` : `${MB(got)} MB`);
    });
  } catch (e) {
    console.error(e);
    loadNote(card, e && e.message ? e.message : "could not load that map", true);
    if (card) card.classList.remove("loading");
    if (picker) picker.classList.remove("busy");
    loadingId = null;
    setPlayEnabled(true);
    return;
  }

  mapId = want;
  try { localStorage.setItem(LS_MAP, mapId); } catch (e) {}
  loadingId = null;
  if (picker) picker.classList.remove("busy");
  loadRecords();
  resetRun();
  resetPlayer();
  inside.clear(); reached = 0; frozen = false;
  buildHUD();
  buildStageButtons(gotoStage);
  refreshPB();
  renderMapPicker();
  setPlayEnabled(true);
  if (isEditing()) editorRefresh();          // a new map, a new set of volumes
  $("#practiceBox").style.display = MAP.checkpoints.length ? "" : "none";
}

/** PLAY is a lie while a map is still arriving: there is no world behind it. */
function setPlayEnabled(on) {
  const b = $("#playBtn");
  if (!b) return;
  b.disabled = !on;
  b.textContent = on ? "PLAY" : "LOADING";
}

/** The picker on the start panel: name, what it asks of you, and your best. */
function renderMapPicker() {
  const box = $("#mapPicker");
  if (!box) return;
  box.innerHTML = "";
  for (const m of MAPS) {
    const best = m.id === mapId ? RECORDS.best : readBest(m.id);
    const card = document.createElement("button");
    card.className = "mapcard btn" + (m.id === mapId ? " on" : "");
    card.type = "button";
    const name = document.createElement("b"); name.textContent = m.name;
    const blurb = document.createElement("span"); blurb.textContent = m.blurb;
    const pb = document.createElement("i");
    pb.textContent = best == null ? "no personal best" : "best " + formatTime(best);
    if (m.bytes && m.id !== mapId) {
      const size = document.createElement("i");
      size.className = "size";
      size.textContent = MB(m.bytes) + " MB download";
      card.append(name, blurb, pb, size);
    } else {
      card.append(name, blurb, pb);
    }
    card.addEventListener("click", () => {
      if (loadingId) return;
      sfxUi();
      card.classList.add("loading");
      selectMap(m.id, card);
    });
    box.appendChild(card);
  }
  const pb = $("#startPB");
  if (pb) pb.textContent = RECORDS.best == null
    ? "no personal best on this map yet"
    : "personal best  " + formatTime(RECORDS.best);

  // "Surf AirCtrl" reads as one word plain and the rest in accent, the way
  // "surf" + "_helix" used to. A map whose name is a single word takes it all.
  const kind = $("#startMapKind"), title = $("#startMapName");
  const [head, ...rest] = MAP.name.split(" ");
  if (kind) kind.textContent = rest.length ? head : "";
  if (title) title.textContent = rest.length ? " " + rest.join(" ") : head;
  document.title = MAP.name + " — CS surf in the browser";

  /* What this course actually asks of you, in the terms a surf server would
     put it. These are the differences between the two maps that matter. */
  const rules = $("#mapRules");
  if (rules) {
    rules.innerHTML = "";
    const chip = (text, hard) => {
      const e = document.createElement("span");
      if (hard) e.className = "hard";
      e.textContent = text;
      rules.appendChild(e);
    };
    chip(MAP.oneShot ? "one shot — a fall ends the run" : `${MAP.checkpoints.length} checkpoints — a fall costs the clock`, MAP.oneShot);
    chip(RULES.bunnyhopping
      ? "bunnyhopping on"
      : `no bhop gain — jumps capped at ${Math.round(MOVE.maxSpeed * MOVE.bunnyhopFactor)} u/s`, !RULES.bunnyhopping);
    if (MAP.prespeed) chip(`start speed capped at ${MAP.prespeed} u/s`, true);
  }
}

/* ============================== the editor ============================== */

/**
 * Open or close the volume editor.
 *
 * It needs a map on screen, so it is only reachable once you have pressed
 * PLAY. Coming out, you keep the position you flew to — the whole reason to
 * fly somewhere is usually to try it — but the run starts over, because you
 * have just walked through the start zone from the wrong side.
 */
function toggleEditor() {
  if (!booted) {
    centerMessage("PRESS PLAY FIRST", "the editor needs a map on screen", 2.4, "#ffc23f");
    return;
  }
  const next = !isEditing();
  setEditing(next);
  $("#editor").classList.toggle("show", next);
  $("#hud").style.display = next ? "none" : "";
  hidePanel("edOut");
  if (next) {
    grabMouse();
  } else {
    const b = view.body;
    b.vel.x = b.vel.y = b.vel.z = 0;
    inside.clear(); reached = 0; frozen = false;
    resetRun(); refreshPB();
    grabMouse();
  }
}

function wireEditor() {
  setEditorDom({
    root: $("#editor"), head: $("#edHead"), counts: $("#edCounts"), status: $("#edStatus"),
    changes: $("#edChanges"), sel: $("#edSel"), list: $("#edList"),
  });
  setGrabber(grabMouse);

  $("#edNewStart").addEventListener("click", () => addZone("start"));
  $("#edNewFinish").addEventListener("click", () => addZone("finish"));
  $("#edDelete").addEventListener("click", () => removeSelected());
  $("#edRevert").addEventListener("click", () => revertAll());
  $("#edExport").addEventListener("click", async () => {
    const json = await exportJson();
    if (!json) {
      editorStatus("this course is written in code — edit src/maps/ instead");
      return;
    }
    $("#edOutText").value = json;
    $("#edOut").classList.add("show");
  });
  $("#edOutClose").addEventListener("click", () => $("#edOut").classList.remove("show"));
  $("#edCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#edOutText").value); editorStatus("copied"); }
    catch (e) { $("#edOutText").select(); editorStatus("select and copy by hand"); }
  });
  $("#edDownload").addEventListener("click", () => {
    const blob = new Blob([$("#edOutText").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "edits.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

/* ============================== boot ============================== */

function start() {
  hidePanel("startPanel");
  frozen = false;
  resetRun();
  resetPlayer();
  inside.clear(); reached = 0;
  acc = 0; last = performance.now();
  booted = true;
  $("#hud").style.display = "";
  setSuspended(false);
  unlockAudio();
  grabMouse();
  const bhop = RULES.bunnyhopping ? "" : "  ·  no bhop gain";
  centerMessage(MAP.name,
    "run through the green gate to start the clock" + bhop, 3.2, "#9dff64");
}

function boot() {
  loadSettings();
  setFov(SETTINGS.fov);
  wireSettings(); syncSettingsUI();
  wireEditor();
  initTrail(); initGhost();
  // Courses from local/ (gitignored, offline only) join the picker if present.
  loadLocalMaps()
    .then(() => selectMap(loadMapChoice()))
    .catch(e => { console.error(e); selectMap(DEFAULT_MAP); });

  initInput(renderer.domElement, {
    onKey,
    onLockChange: locked => {
      // In the editor, losing the pointer is how you reach the panel, not a pause.
      if (isEditing()) return noteLock(locked);
      if (!locked && booted && !paused && !panelOpen()) pause(true);
    },
  });

  // A hidden tab gets no animation frames. Pause rather than banking wall clock
  // we would then have to burn through in one go on the way back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && booted && !paused) pause(true);
    else if (!document.hidden) { acc = 0; last = performance.now(); }
  });

  $("#playBtn").addEventListener("click", start);
  $("#btnChangeMap").addEventListener("click", () => {
    pause(false); booted = false; frozen = true;
    resetRun(); resetPlayer();
    $("#hud").style.display = "none";
    renderMapPicker();
    showPanel("startPanel");
  });
  $("#hud").style.display = "none";
}

boot();
requestAnimationFrame(frame);

/* debug surface */
window.SURF = {
  get view() { return view; }, get RUN() { return RUN; }, get RECORDS() { return RECORDS; },
  MOVE, SETTINGS, MAP, scene, camera, renderer, worldStats,
  simulate, get paused() { return paused; }, get booted() { return booted; },
  tp(x, y, z) { spawnAt({ x, y, z }); return view.body.pos; },
  toStage(i) { gotoStage(i); },
  /**
   * Drive the player through the real tick — movement, triggers, timer and
   * all — from a function instead of from a keyboard. `cmdFn(view, i)` returns
   * a command exactly as input.js would build one. Used to replay recorded
   * inputs and to let the test harness' bot play the shipped game.
   */
  drive(cmdFn, ticks = 128) {
    for (let i = 0; i < ticks; i++) {
      beginTick();
      const cmd = cmdFn(view, i);
      view.sideInput = cmd.side || 0;
      view.yaw = cmd.yaw;
      playerMove(view.body, cmd, TICK);
      postTick();
    }
    return { speed: view.body.speed, pos: { ...view.body.pos }, onRamp: !!view.body.surfRamp };
  },
  /** N ticks of a held strafe with a steady turn — the shape of a real one. */
  simStrafe(ticks = 128, turnRatePerSec = 3, side = 1) {
    let yaw = view.yaw;
    return this.drive(() => {
      yaw -= turnRatePerSec * TICK * side;
      return { forward: 0, side, yaw, jump: false, duck: false, walk: false };
    }, ticks);
  },
};
