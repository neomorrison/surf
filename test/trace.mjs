/* ============================== [TRACE] ==============================
   Fly one stage with the bot and print a tick-by-tick trace of it. This is
   the tool the course was tuned with: when a stage failed, this is what said
   where, at what speed, and how far up the face the bot was when it lost it.

     node --import ./test/register.mjs test/trace.mjs <stage> [everyNTicks]

   Stage 1 is DROP IN, 5 is THE SPINE.                                      */
import './dom-stub.mjs';
import { buildMap, MAP } from '../src/map.js';
import { makeBot, step } from './surfbot.mjs';
import { rampLocal } from '../src/physics.js';
buildMap();
const STAGE = +(process.argv[2] || 1), EVERY = +(process.argv[3] || 32);
const stage = MAP.stages[STAGE];
const from = STAGE === 1 ? MAP.spawn : MAP.checkpoints[STAGE - 2];
const first = MAP.route.findIndex(p => p.stage === STAGE);
console.log('stage', stage.name, 'floor', stage.floorY.toFixed(0), 'from', JSON.stringify(from));
console.log(MAP.route.map((p, i) => `${i}:${p.kind}/${p.stage}`).join(' '));
const bot = makeBot(MAP.route, { x: from.x, y: from.y + 4, z: from.z }, Math.max(0, first - 1), from.yaw || 0);
const goal = MAP.checkpoints[STAGE - 1] || MAP.finishPad;
let floor = stage.floorY;
for (let n = 0; n < 128 * 90; n++) {
  step(bot);
  const b = bot.body;
  floor = Math.min(floor, MAP.stages[MAP.route[Math.min(bot.idx, MAP.route.length - 1)].stage].floorY);
  if (n % EVERY === 0) {
    const r = b.surfRamp;
    const u = r ? rampLocal(r, b.pos.x, b.pos.z).u.toFixed(0) : '-';
    const wp = MAP.route[Math.min(bot.idx, MAP.route.length - 1)];
    console.log(`t=${(n / 128).toFixed(2)} sp=${b.speed.toFixed(0)} y=${b.pos.y.toFixed(0)} x=${b.pos.x.toFixed(0)} z=${b.pos.z.toFixed(0)} ${r ? r.angle.toFixed(0) + 'd@' + u + '/' + r.halfU.toFixed(0) : 'AIR'} g=${b.onGround ? 1 : 0} vy=${b.vel.y.toFixed(0)} wp=${bot.idx}:${wp.kind}`);
  }
  if (b.pos.y < floor) { console.log('FELL t=' + (n / 128).toFixed(2), b.pos.x.toFixed(0), b.pos.y.toFixed(0), b.pos.z.toFixed(0), 'floor', floor.toFixed(0)); break; }
  if (Math.hypot(b.pos.x - goal.x, b.pos.z - goal.z) < 900 && b.pos.y < goal.y + 500) { console.log('CLEARED t=' + (n / 128).toFixed(2), 'peak', bot.peak.toFixed(0)); break; }
}
