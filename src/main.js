/* ============================== [MAIN] ==============================
   Boot, the fixed-timestep loop, trigger dispatch and the menus.

   The loop runs the movement at a hard 128Hz no matter what the display is
   doing, and hands each tick an equal slice of the frame's mouse movement.
   Air acceleration is a per-tick sum and a surf ramp is twenty unbroken
   seconds of it, so this is the difference between a 60Hz machine and a
   240Hz one gaining the same speed and not.                               */
import { scene, camera, renderer, setFov } from './core.js';
import { MOVE, SETTINGS, loadSettings, saveSettings } from './config.js';
import { playerMove, triggersAt } from './physics.js';
import { buildMap, MAP } from './map.js';
import { worldStats } from './world.js';
import { view, spawnAt, resetPlayer, beginTick, updateCamera } from './player.js';
import { initInput, buildCommand, consumeLook, clearLook, endFrame, keyState, setSuspended, mouse } from './input.js';
import {
  RUN, RECORDS, GHOST, loadRecords, clearRecords, resetRun, tickRun, ghostAt,
  onStartGate, onCheckpoint, onFinish, onFall, formatTime, formatDelta,
} from './timer.js';
import {
  buildHUD, updateHUD, tickMessages, centerMessage, splitPopup,
  refreshPB, showPanel, hidePanel, panelOpen, showResults, buildStageButtons,
} from './hud.js';
import {
  fxLand, fxJump, fxCheckpoint, fxFinish, fxFall, updateFx,
  initSpeedLines, updateSpeedLines, initTrail, dropTrail, initGhost, setGhost,
} from './fx.js';
import { unlockAudio, updateAudio, sfxJump, sfxLand, sfxCheckpoint, sfxFinish, sfxPB, sfxFall, sfxPad, sfxUi, sfxRamp } from './audio.js';

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
function handleTriggers() {
  const b = view.body;
  triggersAt(b.pos, MOVE.radius, b.hullHeight, hits);
  const now = new Set(hits);
  for (const t of hits) if (!inside.has(t)) fire(t);      // enter-edge only
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

  if (b.pos.y < killY()) {
    const p = onFall();
    fxFall(b.pos.x, b.pos.y, b.pos.z);
    sfxFall();
    spawnAt(p);
    inside.clear();
    centerMessage("FELL", RUN.state === "running"
      ? "back to the checkpoint — the clock is still running"
      : "back to the checkpoint", 1.8, "#ff5d8f");
  }

  tickRun(TICK, b);
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

  if (booted && !paused && !frozen) simulate(dt);

  const b = view.body;
  updateCamera(booted ? acc / TICK : 0, dt);
  if (booted && !paused && !frozen && b.surfRamp) dropTrail(b.pos.x, b.pos.y, b.pos.z, dt);
  updateFx(dt);
  updateSpeedLines(b.speed, dt, SETTINGS.speedLines);

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

/** Practice: drop in at a checkpoint with the clock stopped. */
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
    case "KeyQ": RUN.falls++; restartRun(false); return true;
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
  set("#optRoll", "checked", SETTINGS.viewRoll);
  set("#optLines", "checked", SETTINGS.speedLines);
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
  toggle("#optRoll", "viewRoll");
  toggle("#optLines", "speedLines");
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

/* ============================== boot ============================== */

function start() {
  if (!booted) {
    buildMap();
    buildHUD();
    buildStageButtons(gotoStage);
    initSpeedLines(); initTrail(); initGhost();
    booted = true;
    $("#hud").style.display = "";
  }
  hidePanel("startPanel");
  frozen = false;
  resetRun();
  resetPlayer();
  inside.clear(); reached = 0;
  acc = 0; last = performance.now();
  setSuspended(false);
  unlockAudio();
  grabMouse();
  centerMessage("SURF_HELIX", "run through the green gate to start the clock", 3.2, "#9dff64");
}

function boot() {
  loadSettings(); loadRecords();
  setFov(SETTINGS.fov);
  wireSettings(); syncSettingsUI();

  initInput(renderer.domElement, {
    onKey,
    onLockChange: locked => { if (!locked && booted && !paused && !panelOpen()) pause(true); },
  });

  // A hidden tab gets no animation frames. Pause rather than banking wall clock
  // we would then have to burn through in one go on the way back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && booted && !paused) pause(true);
    else if (!document.hidden) { acc = 0; last = performance.now(); }
  });

  $("#playBtn").addEventListener("click", start);
  $("#playBtn").disabled = false;
  $("#playBtn").textContent = "PLAY";
  const pb = $("#startPB");
  if (pb) pb.textContent = RECORDS.best == null ? "no personal best yet" : "personal best  " + formatTime(RECORDS.best);
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
