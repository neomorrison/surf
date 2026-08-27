/* ============================== [BOT] ==============================
   A headless surfer. It is not an AI: it is the smallest controller that
   plays by exactly the rules a human has — one strafe key at a time and a
   mouse that can only turn so fast — so that if it gets round the course,
   the course is possible, and if it cannot hold a ramp, neither can you.

   The whole controller is two rules:
     on a ramp   aim the wish vector perpendicular to your velocity, on
                 whichever side pushes you toward 45% up the face
     in the air  aim it perpendicular to your velocity, on whichever side
                 rotates you toward where you have to land
   Perpendicular is provably the best you can do (any forward component eats
   into the 30 u/s wish cap), so this bot's speed is close to the ceiling and
   its failures are the course's, not its own.                             */
import './dom-stub.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { buildMap, MAP } from '../src/map.js';
import { MOVE } from '../src/config.js';
import { makeBot, step, MAX_TURN } from './surfbot.mjs';

const TICK = MOVE.tick;
buildMap();

/**
 * Play one stage the way a player has to: from a standing start on the
 * checkpoint you would respawn at, with no speed handed to you.
 */
function runStage(i, limitSeconds = 90) {
  const stage = MAP.stages[i];
  const from = i === 1 ? MAP.spawn : MAP.checkpoints[i - 2];
  const first = MAP.route.findIndex(p => p.stage === i);
  const bot = makeBot(MAP.route, { x: from.x, y: from.y + 4, z: from.z },
    Math.max(0, first - 1), from.yaw == null ? 0 : from.yaw);

  const goal = MAP.checkpoints[i - 1] || MAP.finishPad;
  const limit = limitSeconds * 128;
  let floor = stage.floorY;

  for (let n = 0; n < limit; n++) {
    step(bot);
    const here = MAP.stages[MAP.route[Math.min(bot.idx, MAP.route.length - 1)].stage];
    floor = Math.min(floor, here.floorY);
    if (bot.body.pos.y < floor) {
      return { ok: false, why: 'fell', stage: stage.name, at: { ...bot.body.pos }, t: bot.ticks / 128, peak: bot.peak };
    }
    if (Math.hypot(bot.body.pos.x - goal.x, bot.body.pos.z - goal.z) < 900 && bot.body.pos.y < goal.y + 500) {
      return {
        ok: true, stage: stage.name, t: bot.ticks / 128, peak: bot.peak,
        surf: bot.surfTicks / bot.ticks, maxTurn: bot.maxTurn,
      };
    }
  }
  return { ok: false, why: 'timeout', stage: stage.name, at: { ...bot.body.pos }, t: bot.ticks / 128, peak: bot.peak };
}

test('report: a bot surfs each stage', () => {
  console.log('\n  stage           result      time   peak u/s   on-ramp   mouse');
  const results = [];
  for (let i = 1; i < MAP.stages.length - 1; i++) {
    const r = runStage(i);
    results.push(r);
    const tag = r.ok ? 'cleared' : (r.why + (r.at ? ` y=${r.at.y.toFixed(0)}` : ''));
    console.log(`  ${r.stage.padEnd(14)} ${tag.padEnd(11)} ${r.t.toFixed(1).padStart(5)}s ${r.peak.toFixed(0).padStart(9)} ` +
      `${r.surf == null ? '' : (r.surf * 100).toFixed(0) + '%'}`.padStart(10) +
      `${r.maxTurn == null ? '' : (r.maxTurn / TICK).toFixed(1) + ' rad/s'}`.padStart(13));
  }
  console.log('');
  globalThis.__botResults = results;
});

test('every stage is completable by a legal controller', () => {
  const results = globalThis.__botResults || [];
  const failed = results.filter(r => !r.ok);
  assert.deepEqual(failed.map(f => `${f.stage}: ${f.why}`), [], 'unsurfable stages');
});

test('report: one bot run of the whole course, no respawns', () => {
  const bot = makeBot(MAP.route, { x: MAP.spawn.x, y: MAP.spawn.y + 4, z: MAP.spawn.z }, 0, MAP.spawn.yaw);
  const fin = MAP.finishPad;
  let falls = 0, cleared = false, t = 0;
  for (let n = 0; n < 128 * 300; n++) {
    step(bot);
    t = bot.ticks / 128;
    const here = MAP.stages[MAP.route[Math.min(bot.idx, MAP.route.length - 1)].stage];
    if (bot.body.pos.y < here.floorY) { falls++; break; }
    if (Math.hypot(bot.body.pos.x - fin.x, bot.body.pos.z - fin.z) < 900 && bot.body.pos.y < fin.y + 500) { cleared = true; break; }
  }
  console.log(`\n  full course: ${cleared ? 'FINISHED' : 'fell'} in ${t.toFixed(1)}s, peak ${bot.peak.toFixed(0)} u/s, ` +
    `${(bot.surfTicks / bot.ticks * 100).toFixed(0)}% of it on a ramp\n`);
  assert.ok(cleared, 'a bot that never falls should be able to reach the finish');
});
