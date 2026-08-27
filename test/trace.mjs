/* ============================== [TRACE] ==============================
   Fly a course with the bot and print a tick-by-tick trace of it. This is the
   tool both maps were tuned with: when a leg failed, this is what said where,
   at what speed, and how far up the face the bot was when it lost it.

     node --import ./test/register.mjs test/trace.mjs <map> [stage] [everyN]

   `map` is a map id (aircontrol, helix). `stage` is a stage index — 1 is the
   first real stage — or 0 to fly the whole course from spawn.               */
import './dom-stub.mjs';
import { buildMap, MAP } from '../src/map.js';
import { MOVE } from '../src/config.js';
import { triggersAt, rampLocal } from '../src/physics.js';
import { makeBot, step } from './surfbot.mjs';

const MAP_ID = process.argv[2] || 'aircontrol';
const STAGE = +(process.argv[3] || 0);
const EVERY = +(process.argv[4] || 32);

buildMap(MAP_ID);

const whole = STAGE === 0 || !MAP.checkpoints.length;
const from = whole || STAGE === 1 ? MAP.spawn : MAP.checkpoints[STAGE - 2];
const first = whole ? 0 : Math.max(0, MAP.route.findIndex(p => p.stage === STAGE) - 1);
const goal = whole ? MAP.finishPad : (MAP.checkpoints[STAGE - 1] || MAP.finishPad);

console.log(`${MAP.name} — ${whole ? 'whole course' : MAP.stages[STAGE].name}`);
console.log(MAP.route.map((p, i) => `${i}:${p.kind}`).join(' '));

const bot = makeBot(MAP.route, { x: from.x, y: from.y + 4, z: from.z }, first, from.yaw || 0);
const hits = [];
for (let n = 0; n < 128 * 200; n++) {
  step(bot);
  const b = bot.body;
  const stage = MAP.stages[MAP.route[Math.min(bot.idx, MAP.route.length - 1)].stage];
  if (n % EVERY === 0) {
    const r = b.surfRamp;
    const u = r ? rampLocal(r, b.pos.x, b.pos.z).u.toFixed(0) : '-';
    const wp = MAP.route[Math.min(bot.idx, MAP.route.length - 1)];
    console.log(`t=${(n / 128).toFixed(2)} sp=${b.speed.toFixed(0)} y=${b.pos.y.toFixed(0)} x=${b.pos.x.toFixed(0)} z=${b.pos.z.toFixed(0)} ` +
      `${r ? r.angle.toFixed(0) + 'd@' + u + '/' + r.halfU.toFixed(0) : 'AIR'} g=${b.onGround ? 1 : 0} vy=${b.vel.y.toFixed(0)} wp=${bot.idx}:${wp.kind}`);
  }
  triggersAt(b.pos, MOVE.radius, b.hullHeight, hits);
  if (hits.some(t => t.kind === 'kill')) {
    console.log(`KILL VOLUME t=${(n / 128).toFixed(2)} at ${b.pos.x.toFixed(0)},${b.pos.y.toFixed(0)},${b.pos.z.toFixed(0)} wp=${bot.idx}`);
    break;
  }
  if (b.pos.y < stage.floorY) { console.log(`FELL through the stage floor t=${(n / 128).toFixed(2)}`); break; }
  if (Math.hypot(b.pos.x - goal.x, b.pos.z - goal.z) < 900 && b.pos.y < goal.y + 500) {
    console.log(`CLEARED t=${(n / 128).toFixed(2)} peak ${bot.peak.toFixed(0)}`);
    break;
  }
}
