/* ============================== [AUDIO] ==============================
   Synthesised in the browser — no sample files, nothing to download.
   The wind bed is the point: on a ramp there is nothing in the frame that
   changes when you speed up, so the loudest feedback channel you have at
   1000 u/s is your ears.                                                  */
import { SETTINGS } from './config.js';

let ctx = null, master = null, windGain = null, windFilter = null;

export function unlockAudio() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);

  // wind: a filtered noise bed whose brightness follows your speed
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  windFilter = ctx.createBiquadFilter(); windFilter.type = "bandpass";
  windFilter.frequency.value = 400; windFilter.Q.value = 0.7;
  windGain = ctx.createGain(); windGain.gain.value = 0;
  src.connect(windFilter); windFilter.connect(windGain); windGain.connect(master);
  src.start();
}

function blip(freq, dur, type = "square", vol = 0.16, slideTo = null) {
  if (!ctx || !SETTINGS.sound) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}
function chord(freqs, dur, type = "triangle", vol = 0.13, stagger = 0.07) {
  freqs.forEach((f, i) => setTimeout(() => blip(f, dur, type, vol), i * stagger * 1000));
}

export const sfxJump = () => blip(430, 0.07, "square", 0.07, 620);
export const sfxLand = impact => blip(150 - impact * 45, 0.10, "sine", 0.09 + impact * 0.09, 70);
export const sfxCheckpoint = () => chord([523, 784, 1046], 0.30, "triangle", 0.15, 0.055);
export const sfxFinish = () => chord([523, 659, 784, 1046, 1318], 0.55, "triangle", 0.16, 0.085);
export const sfxPB = () => chord([784, 988, 1174, 1568], 0.7, "sawtooth", 0.11, 0.1);
export const sfxFall = () => blip(220, 0.45, "sawtooth", 0.13, 55);
export const sfxPad = () => blip(300, 0.22, "square", 0.14, 1200);
export const sfxRamp = () => blip(180, 0.13, "sawtooth", 0.05, 460);      // face caught
export const sfxUi = () => blip(660, 0.045, "square", 0.06);

/** Wind bed follows speed, and opens right up while you are riding a face. */
export function updateAudio(speed, airborne, surfing) {
  if (!ctx || !windGain) return;
  const on = SETTINGS.sound ? 1 : 0;
  const k = Math.max(0, Math.min(1, (speed - 240) / 800));
  const target = on * k * k * 0.24 * (airborne ? 1 : 0.5) * (surfing ? 1.25 : 1);
  windGain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
  windFilter.frequency.setTargetAtTime(320 + k * 1700, ctx.currentTime, 0.1);
  windFilter.Q.setTargetAtTime(surfing ? 1.6 : 0.7, ctx.currentTime, 0.2);
}
export function setMuted(m) { SETTINGS.sound = !m; if (master) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.05); }
