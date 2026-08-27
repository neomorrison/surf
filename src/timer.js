/* ============================== [TIMER] ==============================
   The run: start gate -> four checkpoints -> finish, with splits, personal
   bests and a fall counter, all in localStorage.

   Falling does not end a run. You are put back on the last checkpoint and
   the clock keeps going — losing your speed is the punishment, and losing
   your speed is the worst thing that can happen to a surfer anyway.

   A personal best also records where you were, sixteen times a second, so
   the next attempt can be raced against it.                               */
import { MAP } from './map.js';

/* Records are per map, so the keys carry the map id. */
const LS_KEY = id => "surf.records.v1:" + id;
const LS_GHOST = id => "surf.ghost.v1:" + id;
const GHOST_HZ = 16;
const GHOST_EVERY = Math.round(128 / GHOST_HZ);      // ticks between samples

const BLANK = { best: null, splits: [], stageBest: [], runs: 0, topSpeed: 0 };

export const RUN = {
  state: "idle",            // idle | running | finished
  time: 0,
  stage: 0,                 // index into MAP.stages
  splits: [],               // seconds at each checkpoint crossing
  falls: 0,
  jumps: 0,
  topSpeed: 0,
  surfTime: 0,              // seconds spent riding a ramp
  respawn: null,            // {x,y,z,yaw} — last checkpoint, or spawn
  lastFinish: null,
  trace: [],                // flat [x,y,z, x,y,z, ...] of this attempt
  traceTick: 0,
};

export const RECORDS = { ...BLANK };

/** The personal-best run, replayed. `null` until one exists. */
export const GHOST = { points: null, hz: GHOST_HZ, time: null };

/** Load the records and ghost for whichever map is currently built. */
export function loadRecords() {
  Object.assign(RECORDS, BLANK, { splits: [], stageBest: [] });
  GHOST.points = null; GHOST.time = null;
  try {
    const raw = localStorage.getItem(LS_KEY(MAP.id));
    if (raw) Object.assign(RECORDS, JSON.parse(raw));
  } catch (e) {}
  try {
    const raw = localStorage.getItem(LS_GHOST(MAP.id));
    if (raw) { const g = JSON.parse(raw); GHOST.points = g.p; GHOST.time = g.t; }
  } catch (e) {}
  return RECORDS;
}

/** Peek at another map's personal best without building it — for the map picker. */
export function readBest(id) {
  try {
    const raw = localStorage.getItem(LS_KEY(id));
    return raw ? JSON.parse(raw).best : null;
  } catch (e) { return null; }
}

function saveRecords() {
  try { localStorage.setItem(LS_KEY(MAP.id), JSON.stringify(RECORDS)); } catch (e) {}
}
function saveGhost() {
  try {
    localStorage.setItem(LS_GHOST(MAP.id), JSON.stringify({ t: GHOST.time, p: GHOST.points }));
  } catch (e) { /* quota — the run still counts, you just cannot race it */ }
}
export function clearRecords() {
  Object.assign(RECORDS, BLANK, { splits: [], stageBest: [] });
  GHOST.points = null; GHOST.time = null;
  saveRecords();
  try { localStorage.removeItem(LS_GHOST(MAP.id)); } catch (e) {}
}

export function formatTime(t) {
  if (t == null) return "--:--.--";
  const neg = t < 0; t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return (neg ? "-" : "") + m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}
export function formatDelta(d) {
  if (d == null) return "";
  return (d >= 0 ? "+" : "-") + Math.abs(d).toFixed(2);
}

/* ---------------- lifecycle ---------------- */

export function resetRun() {
  RUN.state = "idle"; RUN.time = 0; RUN.stage = 0;
  RUN.splits = []; RUN.falls = 0; RUN.jumps = 0; RUN.topSpeed = 0; RUN.surfTime = 0;
  RUN.respawn = { ...MAP.spawn };
  RUN.lastFinish = null;
  RUN.trace = []; RUN.traceTick = 0;
  return RUN.respawn;
}

/** One simulation tick of bookkeeping. `body` is only read. */
export function tickRun(dt, body) {
  if (RUN.state !== "running") return;
  RUN.time += dt;
  if (body && body.surfRamp) RUN.surfTime += dt;
  if (RUN.traceTick++ % GHOST_EVERY === 0 && body) {
    RUN.trace.push(Math.round(body.pos.x * 10) / 10, Math.round(body.pos.y * 10) / 10, Math.round(body.pos.z * 10) / 10);
  }
}

/** Split time for stage `i`, i.e. how long that stage alone took. */
export function stageSplit(i, splits = RUN.splits) {
  const end = splits[i];
  if (end == null) return null;
  return end - (i > 0 ? splits[i - 1] : 0);
}

/* ---------------- events (called by main.js from trigger overlaps) ---------------- */

export function onStartGate() {
  if (RUN.state === "running") return null;
  RUN.state = "running"; RUN.time = 0; RUN.stage = 1;
  RUN.splits = []; RUN.falls = 0; RUN.jumps = 0; RUN.topSpeed = 0; RUN.surfTime = 0;
  RUN.respawn = { ...MAP.spawn };
  RUN.trace = []; RUN.traceTick = 0;
  return { kind: "start" };
}

export function onCheckpoint(index) {
  if (RUN.state !== "running") return null;
  if (RUN.splits[index] != null) return null;                    // already taken
  if (index > 0 && RUN.splits[index - 1] == null) return null;   // no skipping ahead
  RUN.splits[index] = RUN.time;

  const cp = MAP.checkpoints[index];
  RUN.respawn = { x: cp.x, y: cp.y + 2, z: cp.z, yaw: cp.yaw };
  RUN.stage = index + 2;                                         // stages[0] is START

  const split = stageSplit(index);
  const best = RECORDS.stageBest[index];
  const isStageBest = best == null || split < best;
  if (isStageBest) { RECORDS.stageBest[index] = split; saveRecords(); }

  return {
    kind: "checkpoint", index, name: cp.name,
    at: RUN.time, split, stageBest: isStageBest,
    pace: RECORDS.splits[index] != null ? RUN.time - RECORDS.splits[index] : null,
  };
}

export function onFinish() {
  if (RUN.state !== "running") return null;
  // On a checkpointed map you must have taken the last one; a one-shot map has
  // none to take, and crossing the start gate is the only way to be running.
  if (MAP.checkpoints.length && RUN.splits[MAP.checkpoints.length - 1] == null) return null;
  RUN.state = "finished";

  const time = RUN.time;
  const prev = RECORDS.best;
  const pb = prev == null || time < prev;
  if (pb) {
    RECORDS.best = time; RECORDS.splits = RUN.splits.slice();
    GHOST.points = RUN.trace.slice(); GHOST.time = time;
    saveGhost();
  }
  if (RUN.topSpeed > (RECORDS.topSpeed || 0)) RECORDS.topSpeed = RUN.topSpeed;
  RECORDS.runs = (RECORDS.runs || 0) + 1;
  saveRecords();

  RUN.lastFinish = {
    time, splits: RUN.splits.slice(), falls: RUN.falls, jumps: RUN.jumps,
    topSpeed: RUN.topSpeed, surfTime: RUN.surfTime, pb,
    delta: prev == null ? null : time - prev, previous: prev,
  };
  return { kind: "finish", ...RUN.lastFinish };
}

/** Fell off. Back to the last checkpoint, clock still running. */
export function onFall() {
  RUN.falls++;
  return RUN.respawn || { ...MAP.spawn };
}

/**
 * Where the personal-best run was at time `t`, or null.
 * Sampled at 16Hz and interpolated, which is smooth enough for something you
 * are only ever looking at from behind, at speed.
 */
export function ghostAt(t, out) {
  const p = GHOST.points;
  if (!p || p.length < 6) return null;
  const f = t * GHOST_HZ;
  const i = Math.floor(f);
  const last = p.length / 3 - 1;
  if (i >= last) {
    if (out) { out.x = p[last * 3]; out.y = p[last * 3 + 1]; out.z = p[last * 3 + 2]; }
    return t <= (GHOST.time || 0) + 1 ? out : null;
  }
  const a = i * 3, k = f - i;
  if (out) {
    out.x = p[a] + (p[a + 3] - p[a]) * k;
    out.y = p[a + 1] + (p[a + 4] - p[a + 1]) * k;
    out.z = p[a + 2] + (p[a + 5] - p[a + 2]) * k;
  }
  return out;
}
