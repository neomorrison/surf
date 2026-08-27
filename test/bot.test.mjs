/* The bot (test/surfbot.mjs) plays both courses by the rules a human has —
   one strafe key at a time and a mouse limited to 3.8 rad/s — so that if it
   gets round, the course is possible, and if it cannot hold a ramp, neither
   can you. */
import './dom-stub.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { buildMap, MAP, MAPS } from '../src/map.js';
import { MOVE, RULES } from '../src/config.js';
import { triggersAt, makeBody, playerMove } from '../src/physics.js';
import { makeBot, step } from './surfbot.mjs';

const hits = [];

/** True the moment the bot is off the course, by kill volume or stage floor. */
function offCourse(bot) {
  const b = bot.body;
  const here = MAP.stages[MAP.route[Math.min(bot.idx, MAP.route.length - 1)].stage];
  if (b.pos.y < here.floorY) return "floor";
  triggersAt(b.pos, MOVE.radius, b.hullHeight, hits);
  return hits.some(t => t.kind === "kill") ? "kill volume" : null;
}

function atGoal(bot, goal) {
  const b = bot.body;
  return Math.hypot(b.pos.x - goal.x, b.pos.z - goal.z) < 900 && b.pos.y < goal.y + 500;
}

/** Play from a standing start at `from` until `goal`, or until it falls. */
function fly(from, startIdx, goal, limitSeconds) {
  const bot = makeBot(MAP.route, { x: from.x, y: from.y + 4, z: from.z },
    startIdx, from.yaw == null ? 0 : from.yaw);
  for (let n = 0; n < limitSeconds * 128; n++) {
    step(bot);
    const off = offCourse(bot);
    if (off) return { ok: false, why: off, at: { ...bot.body.pos }, t: bot.ticks / 128, peak: bot.peak, bot };
    if (atGoal(bot, goal)) {
      return { ok: true, t: bot.ticks / 128, peak: bot.peak, surf: bot.surfTicks / bot.ticks, maxTurn: bot.maxTurn, bot };
    }
  }
  return { ok: false, why: "timeout", at: { ...bot.body.pos }, t: bot.ticks / 128, peak: bot.peak, bot };
}

const RESULTS = {};

function report(id, rows) {
  console.log(`\n  ${MAP.name}`);
  console.log('  leg             result           time   peak u/s   on-ramp   mouse');
  for (const r of rows) {
    const tag = r.ok ? 'cleared' : (r.why + (r.at ? ` y=${r.at.y.toFixed(0)}` : ''));
    console.log(`  ${r.leg.padEnd(14)} ${tag.padEnd(16)} ${r.t.toFixed(1).padStart(5)}s ${r.peak.toFixed(0).padStart(9)} ` +
      `${(r.surf == null ? '' : (r.surf * 100).toFixed(0) + '%').padStart(9)} ` +
      `${(r.maxTurn == null ? '' : (r.maxTurn / MOVE.tick).toFixed(1) + ' rad/s').padStart(11)}`);
  }
  RESULTS[id] = rows;
}

test('report: the bot plays surf_helix stage by stage', () => {
  buildMap('helix');
  const rows = [];
  for (let i = 1; i < MAP.stages.length - 1; i++) {
    const from = i === 1 ? MAP.spawn : MAP.checkpoints[i - 2];
    const first = MAP.route.findIndex(p => p.stage === i);
    const goal = MAP.checkpoints[i - 1] || MAP.finishPad;
    rows.push({ leg: MAP.stages[i].name, ...fly(from, Math.max(0, first - 1), goal, 90) });
  }
  report('helix', rows);
});

test('report: the bot plays surf_aircontrol, one shot, no respawns', () => {
  buildMap('aircontrol');
  const r = fly(MAP.spawn, 0, MAP.finishPad, 150);
  report('aircontrol', [{ leg: 'START→FINISH', ...r }]);
  if (r.ok) {
    console.log(`  and it never had a checkpoint to fall back to: prespeed ${RULES.prespeedCap}, ` +
      `bunnyhopping ${RULES.bunnyhopping ? 'on' : 'off'}\n`);
  }
});

test('every leg of every course is completable by a legal controller', () => {
  const failed = [];
  for (const [id, rows] of Object.entries(RESULTS)) {
    for (const r of rows) if (!r.ok) failed.push(`${id}/${r.leg}: ${r.why}`);
  }
  assert.deepEqual(failed, [], 'unsurfable legs');
});

test('surf_helix is finishable end to end without a single fall', () => {
  buildMap('helix');
  const r = fly(MAP.spawn, 0, MAP.finishPad, 300);
  console.log(`\n  surf_helix full course: ${r.ok ? 'FINISHED' : r.why} in ${r.t.toFixed(1)}s, ` +
    `peak ${r.peak.toFixed(0)} u/s, ${(r.bot.surfTicks / r.bot.ticks * 100).toFixed(0)}% of it on a ramp\n`);
  assert.ok(r.ok, 'a bot that never falls should be able to reach the finish');
});

/**
 * The prespeed cap, attacked rather than asserted.
 *
 * A cap that only covers the platform is worth nothing — the free air between
 * it and the first ramp is enough for a perfect strafe to put 60 u/s back on.
 * So this plays the exploit: run up to walking speed, then hold a frame-perfect
 * hop and a perfectly perpendicular wish all the way to the first face, and
 * measure what actually arrives.
 */
test('no course can be entered above the prespeed cap, however hard you try', () => {
  const rows = [];
  for (const m of MAPS) {
    buildMap(m.id);
    const first = MAP.route[0];
    const b = makeBody(MAP.spawn.x, MAP.spawn.y + 2, MAP.spawn.z);
    b.onGround = true;
    let yaw = MAP.spawn.yaw, best = 0, arrived = null;
    const t = { x: Math.sin(first.yaw), z: Math.cos(first.yaw) };

    for (let n = 0; n < 128 * 40; n++) {
      const sp = Math.hypot(b.vel.x, b.vel.z);
      let cmd;
      if (sp < MOVE.maxSpeed - 4 && b.onGround) {
        cmd = { forward: 1, side: 0, yaw, jump: false };      // you cannot hop out of a standstill
      } else {
        const vx = b.vel.x / sp, vz = b.vel.z / sp;
        let p = { x: -vz, z: vx };
        if (p.x * t.x + p.z * t.z < 0) p = { x: vz, z: -vx };  // the one that keeps us going forward
        yaw = Math.atan2(-p.z, p.x);
        cmd = { forward: 0, side: 1, yaw, jump: true };         // hold the hop, hold the strafe
      }
      playerMove(b, cmd, MOVE.tick);

      triggersAt(b.pos, MOVE.radius, b.hullHeight, hits);
      for (const z of hits) {
        if (z.kind !== 'prespeed') continue;
        const s = Math.hypot(b.vel.x, b.vel.z);
        if (s > z.cap) { const k = z.cap / s; b.vel.x *= k; b.vel.z *= k; }
      }

      const now = Math.hypot(b.vel.x, b.vel.z);
      best = Math.max(best, now);
      if ((b.pos.x - first.x) * t.x + (b.pos.z - first.z) * t.z >= 0) { arrived = now; break; }
    }
    rows.push({ map: MAP.name, best, arrived });
  }

  console.log('\n  course            best anywhere   at the first face');
  for (const r of rows) {
    console.log(`  ${r.map.padEnd(18)} ${r.best.toFixed(0).padStart(9)} u/s ${(r.arrived == null ? 'never reached' : r.arrived.toFixed(0) + ' u/s').padStart(18)}`);
  }
  console.log('');

  for (const r of rows) {
    assert.ok(r.arrived != null, `${r.map}: the exploit run never reached the first ramp`);
    assert.ok(r.arrived <= RULES.prespeedCap + 0.5,
      `${r.map}: entered the course at ${r.arrived.toFixed(0)} u/s, cap is ${RULES.prespeedCap}`);
  }
});
