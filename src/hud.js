/* ============================== [HUD] ==============================
   Everything on screen that is not the world.

   Two readouts do the real work. The speedometer is the scoreboard — in a
   surf game the number at the bottom of the screen is the entire feedback
   loop. The ramp gauge next to it is the other half: on a face you cannot
   see the horizon, so it shows how much slope is still underneath you and
   how fast that is running out.                                          */
import { MOVE, RULES, SETTINGS } from './config.js';
import { MAP } from './map.js';
import { rampLocal } from './physics.js';
import { RUN, RECORDS, GHOST, formatTime, formatDelta, stageSplit } from './timer.js';

const $ = s => document.querySelector(s);

let el = {};
export function buildHUD() {
  el = {
    speed: $("#speedVal"), speedBar: $("#speedFill"), gain: $("#speedGain"), peak: $("#speedPeak"),
    timer: $("#runTime"), stage: $("#runStage"), pace: $("#runPace"),
    keys: $("#keysOverlay"), sync: $("#syncFill"), syncVal: $("#syncVal"), syncBox: $("#syncBox"),
    ramp: $("#rampBox"), rampFill: $("#rampFill"), rampAngle: $("#rampAngle"),
    pb: $("#pbVal"), splits: $("#splitList"), stats: $("#runStats"),
    center: $("#centerMsg"), feed: $("#splitFeed"), cross: $("#crosshair"),
  };
  buildCrosshair();
  buildKeys();
  refreshPB();
}

function buildCrosshair() {
  const c = el.cross; if (!c) return;
  c.innerHTML = "";
  const mk = css => { const d = document.createElement("div"); d.className = "ch"; d.style.cssText = css; c.appendChild(d); };
  mk("width:2px;height:7px;left:-1px;top:-13px");
  mk("width:2px;height:7px;left:-1px;top:6px");
  mk("width:7px;height:2px;left:-13px;top:-1px");
  mk("width:7px;height:2px;left:6px;top:-1px");
  mk("width:2px;height:2px;left:-1px;top:-1px;opacity:.9");
}

const KEYCELLS = [["", "w", ""], ["a", "s", "d"]];
let keyEls = {};
function buildKeys() {
  const k = el.keys; if (!k) return;
  k.innerHTML = ""; keyEls = {};
  for (const row of KEYCELLS) {
    const r = document.createElement("div"); r.className = "krow";
    for (const name of row) {
      const c = document.createElement("div");
      c.className = "kcell" + (name ? "" : " kblank");
      c.textContent = name.toUpperCase();
      if (name) keyEls[name] = c;
      r.appendChild(c);
    }
    k.appendChild(r);
  }
  const r = document.createElement("div"); r.className = "krow";
  const sp = document.createElement("div"); sp.className = "kcell kwide"; sp.textContent = "SPACE";
  keyEls.jump = sp; r.appendChild(sp);
  const du = document.createElement("div"); du.className = "kcell"; du.textContent = "CTRL";
  keyEls.duck = du; r.appendChild(du);
  k.appendChild(r);
}

/* ---------------- per-frame ---------------- */

const SPEED_TIERS = [
  [MOVE.maxSpeed + 10, "#7d8aa6"],       // nothing earned yet
  [450, "#49c8ff"],
  [650, "#35e0c8"],
  [850, "#9dff64"],
  [1050, "#ffc23f"],
  [1300, "#ff5d8f"],
  [Infinity, "#ffffff"],
];
function speedColor(v) { for (const [lim, c] of SPEED_TIERS) if (v < lim) return c; return "#fff"; }

let gainSmooth = 0;
export function updateHUD(view, dt) {
  const b = view.body;
  const spd = b.speed;

  /* speedometer — the bar tops out at 1250, which is a very good run */
  el.speed.textContent = Math.round(spd);
  const col = speedColor(spd);
  el.speed.style.color = col;
  el.speedBar.style.width = Math.min(100, (spd / 1250) * 100) + "%";
  el.speedBar.style.background = col;
  el.peak.textContent = Math.round(RUN.topSpeed);

  gainSmooth += ((view.gainPerSec || 0) - gainSmooth) * Math.min(1, dt * 9);
  if (b.onGround) {
    el.gain.textContent = "GROUNDED";
    el.gain.style.color = "#7d8aa6";
  } else if (gainSmooth > 4) {
    el.gain.textContent = "+" + Math.round(gainSmooth) + " u/s";
    el.gain.style.color = "#9dff64";
  } else if (gainSmooth < -4) {
    el.gain.textContent = Math.round(gainSmooth) + " u/s";
    el.gain.style.color = "#ff5d8f";
  } else {
    el.gain.textContent = b.surfRamp ? "holding" : "no gain";
    el.gain.style.color = "#7d8aa6";
  }

  /* ramp gauge: 0% is the low edge you are about to slide off */
  const r = b.surfRamp;
  if (r) {
    const { u } = rampLocal(r, b.pos.x, b.pos.z);
    const s = r.slope >= 0 ? 1 : -1;
    const frac = Math.max(0, Math.min(1, (s * u + r.halfU) / (2 * r.halfU)));
    el.ramp.style.opacity = 1;
    el.rampFill.style.height = (frac * 100).toFixed(1) + "%";
    el.rampFill.style.background = frac < 0.12 ? "#ff5d8f" : frac < 0.3 ? "#ffc23f" : "#35e0c8";
    el.rampAngle.textContent = Math.round(r.angle) + "°";
  } else {
    el.ramp.style.opacity = 0;
  }

  /* run clock */
  el.timer.textContent = formatTime(RUN.time);
  el.timer.style.color = RUN.state === "running" ? "#fff" : RUN.state === "finished" ? "#ffc23f" : "#7d8aa6";
  const st = MAP.stages[RUN.stage];
  const nStages = MAP.stages.length - 2;                 // START and FINISH are not stages
  const counter = RUN.stage > 0 && nStages > 1 ? RUN.stage + " / " + nStages + "  ·  " : "";
  el.stage.textContent = st ? counter + st.name : "";

  const pace = liveDelta();
  if (pace == null) { el.pace.textContent = RECORDS.best == null ? "no PB yet" : ""; el.pace.style.color = "#7d8aa6"; }
  else { el.pace.textContent = formatDelta(pace); el.pace.style.color = pace <= 0 ? "#9dff64" : "#ff5d8f"; }

  /* key overlay */
  el.keys.style.display = SETTINGS.showKeys ? "" : "none";
  if (SETTINGS.showKeys && view.keys) {
    const k = view.keys;
    for (const [name, node] of Object.entries(keyEls)) {
      if (!node) continue;
      node.classList.toggle("on", !!k[name]);
    }
    // a strafe key held with no turn is the classic beginner mistake — mark it
    keyEls.a && keyEls.a.classList.toggle("dead", k.a && !b.onGround && (view.turnRate || 0) >= -0.4);
    keyEls.d && keyEls.d.classList.toggle("dead", k.d && !b.onGround && (view.turnRate || 0) <= 0.4);
  }

  /* sync */
  el.syncBox.style.display = SETTINGS.showSync ? "" : "none";
  if (SETTINGS.showSync) {
    const s = Math.round((view.sync || 0) * 100);
    el.sync.style.width = s + "%";
    el.sync.style.background = s > 75 ? "#9dff64" : s > 45 ? "#ffc23f" : "#ff5d8f";
    el.syncVal.textContent = s + "%";
  }

  const onFace = `${RUN.surfTime.toFixed(0)}s on the face`;
  el.stats.textContent = RULES.oneShot
    ? `one shot · no bhop gain · ${onFace}`
    : `${RUN.falls} falls · ${onFace}`;
}

function liveDelta() {
  if (RUN.state !== "running" || RECORDS.best == null || !RECORDS.splits.length) return null;
  const i = RUN.splits.length - 1;
  if (i < 0 || RECORDS.splits[i] == null) return null;
  return RUN.splits[i] - RECORDS.splits[i];
}

/* ---------------- messages ---------------- */

let centerT = 0;
export function centerMessage(main, sub = "", secs = 2.2, color = "#fff") {
  el.center.querySelector(".m").textContent = main;
  el.center.querySelector(".s").textContent = sub;
  el.center.querySelector(".m").style.color = color;
  el.center.style.opacity = 1;
  centerT = secs;
}
export function tickMessages(dt) {
  if (centerT > 0) { centerT -= dt; if (centerT <= 0) el.center.style.opacity = 0; }
}

export function splitPopup(title, detail, color = "#9dff64") {
  const d = document.createElement("div");
  d.className = "split";
  const b = document.createElement("b"); b.style.color = color; b.textContent = title;
  const s = document.createElement("span"); s.innerHTML = detail;
  d.append(b, s);
  el.feed.appendChild(d);
  setTimeout(() => d.remove(), 4200);
  while (el.feed.children.length > 5) el.feed.firstChild.remove();
}

export function refreshPB() {
  if (!el.pb) return;
  fillRecordsPanel();
  el.pb.textContent = RECORDS.best == null ? "--:--.--" : formatTime(RECORDS.best);
  el.splits.innerHTML = "";
  const row = (label, value) => {
    const d = document.createElement("div");
    d.className = "srow";
    d.innerHTML = `<span class="sn"></span><span class="sv"></span>`;
    d.firstChild.textContent = label;
    d.lastChild.textContent = value;
    el.splits.appendChild(d);
  };
  if (MAP.checkpoints.length) {
    MAP.checkpoints.forEach((cp, i) => {
      const best = RECORDS.stageBest[i];
      row(`${i + 1} ${cp.name}`, best == null ? "--" : best.toFixed(2));
    });
  } else {
    // A one-shot map has no splits to show, so the panel shows the things it
    // does have: how many finishes, and how fast you have ever been on it.
    row("finishes", String(RECORDS.runs || 0));
    row("fastest ever", RECORDS.topSpeed ? Math.round(RECORDS.topSpeed) + " u/s" : "--");
  }
}

function fillRecordsPanel() {
  const body = document.querySelector("#recordsBody");
  if (!body) return;
  const title = document.querySelector("#recordsTitle");
  if (title) title.textContent = MAP.name + " — records";

  const table = MAP.checkpoints.length ? `
    <table class="rtable"><thead><tr><th></th><th>stage</th><th class="num">best split</th><th class="num">pb at</th></tr></thead>
    <tbody>${MAP.checkpoints.map((cp, i) => {
      const best = RECORDS.stageBest[i], at = RECORDS.splits[i];
      return `<tr><td>${i + 1}</td><td>${cp.name}</td><td class="num">${best == null ? "--" : best.toFixed(2)}</td><td class="num">${at == null ? "--" : formatTime(at)}</td></tr>`;
    }).join("")}</tbody></table>` : `
    <div class="muted" style="margin-top:10px;line-height:1.7">
      One shot, no checkpoints — there are no splits to keep.<br>
      Bunnyhopping is capped at ${Math.round(MOVE.maxSpeed * MOVE.bunnyhopFactor)} u/s and the start zone at 350,
      so every unit above that in a finishing time came off a ramp face.
    </div>`;

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
      <span style="letter-spacing:2px;font-size:11px">PERSONAL BEST</span>
      <span style="font-size:26px;font-weight:bold;color:#ffc23f;font-family:Consolas,monospace">${formatTime(RECORDS.best)}</span>
    </div>${table}
    <div style="margin-top:12px;font-size:12px;color:#6d7ba0">
      ${RECORDS.runs || 0} finished run${(RECORDS.runs || 0) === 1 ? "" : "s"}
      &nbsp;·&nbsp; fastest ever ${Math.round(RECORDS.topSpeed || 0)} u/s
      &nbsp;·&nbsp; ghost ${GHOST.points ? "recorded" : "none yet"}
      &nbsp;·&nbsp; Tab to close
    </div>`;
}

/* ---------------- panels ---------------- */

export function showPanel(id) { const p = document.getElementById(id); if (p) p.classList.add("show"); }
export function hidePanel(id) { const p = document.getElementById(id); if (p) p.classList.remove("show"); }
export function panelOpen() { return !!document.querySelector(".panel.show"); }

export function showResults(f) {
  const body = $("#resultsBody");
  const rows = MAP.checkpoints.length ? MAP.checkpoints.map((cp, i) => {
    const sp = stageSplit(i, f.splits);
    const best = RECORDS.stageBest[i];
    const isBest = sp != null && best != null && Math.abs(sp - best) < 1e-9;
    return `<tr><td>${i + 1}</td><td>${cp.name}</td><td class="num">${sp == null ? "--" : sp.toFixed(2)}</td>
            <td class="num">${f.splits[i] == null ? "--" : formatTime(f.splits[i])}</td>
            <td class="num ${isBest ? "good" : ""}">${isBest ? "BEST" : ""}</td></tr>`;
  }).join("") : "";
  $("#resultsTitle").textContent = f.pb ? "NEW PERSONAL BEST" : "RUN COMPLETE";
  $("#resultsTitle").style.color = f.pb ? "#9dff64" : "#ffc23f";
  $("#resultsTime").textContent = formatTime(f.time);
  $("#resultsDelta").textContent = f.delta == null ? "first finish" : formatDelta(f.delta) + " vs previous best";
  $("#resultsDelta").style.color = f.delta == null ? "#7d8aa6" : f.delta <= 0 ? "#9dff64" : "#ff5d8f";
  const table = rows
    ? `<table class="rtable"><thead><tr><th></th><th>stage</th><th class="num">split</th><th class="num">at</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="muted" style="margin-top:14px">${MAP.name} · one shot, start to finish</div>`;
  const falls = MAP.checkpoints.length ? ` &nbsp;·&nbsp; <b>${f.falls}</b> falls` : "";
  body.innerHTML = `${table}
    <div class="rmeta">top speed <b>${Math.round(f.topSpeed)}</b> u/s &nbsp;·&nbsp; <b>${(f.surfTime / f.time * 100).toFixed(0)}%</b> of it on a ramp${falls}</div>`;
  showPanel("resultsPanel");
}

/** The practice list in the pause menu. `onPick(i)` gets the stage index. */
export function buildStageButtons(onPick) {
  const box = $("#stageBtns");
  if (!box) return;
  box.innerHTML = "";
  const mk = (label, i) => {
    const b = document.createElement("button");
    b.className = "btn ghost"; b.textContent = label;
    b.addEventListener("click", () => onPick(i));
    box.appendChild(b);
  };
  mk("START", -1);
  MAP.checkpoints.forEach((cp, i) => mk(`${i + 1} ${cp.name}`, i));
}
