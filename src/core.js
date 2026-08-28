/* ============================== [CORE] ==============================
   Renderer, scene, camera, sky and lighting. Imported once; every other
   module adds meshes to `scene` and renders through `camera`/`renderer`.

   A surf map is mostly one enormous tilted plane seen edge-on at 900 u/s,
   so the lighting brief is narrow and specific: the ramp face has to stay
   readable against the void, and the horizon has to stay findable when the
   camera is rolled 30 degrees and falling.                                 */
import * as THREE from 'three';
import { SETTINGS } from './config.js';

export const app = document.getElementById('app');

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x060a1e, 3000, 14000);

export const camera = new THREE.PerspectiveCamera(SETTINGS.fov, innerWidth / innerHeight, 1, 40000);
scene.add(camera);

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------- sky ----------------
   A gradient shell rather than a flat clear colour. The bright band sits a
   little *below* the horizon so that the line between sky and void reads as
   an edge even when the camera is rolled. */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: {
    top:     { value: new THREE.Color(0x04061a) },
    mid:     { value: new THREE.Color(0x123a6e) },
    horizon: { value: new THREE.Color(0x35e0c8) },
    bottom:  { value: new THREE.Color(0x04030c) },
  },
  vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform vec3 top, mid, horizon, bottom; varying vec3 vP;
    void main(){
      float h = normalize(vP).y;
      vec3 c;
      if (h > 0.0) c = mix(mix(horizon, mid, smoothstep(0.0, 0.16, h)), top, smoothstep(0.14, 0.68, h));
      else         c = mix(horizon, bottom, smoothstep(0.0, 0.24, -h));
      gl_FragColor = vec4(c, 1.0);
    }`,
});
export const sky = new THREE.Mesh(new THREE.SphereGeometry(18000, 32, 20), skyMat);
sky.frustumCulled = false;
scene.add(sky);

/** Repaint the sky. Colours are hex; anything omitted is left alone. */
export function setSky(o = {}) {
  for (const k of ['top', 'mid', 'horizon', 'bottom']) {
    if (o[k] != null) skyMat.uniforms[k].value.setHex(o[k]);
  }
  if (o.fog != null) scene.fog.color.setHex(o.fog);
  if (o.radius != null) {
    sky.geometry.dispose();
    sky.geometry = new THREE.SphereGeometry(o.radius, 32, 20);
    camera.far = Math.max(camera.far, o.radius * 2.2);
    camera.updateProjectionMatrix();
  }
}

/** A daylight sky, for a map that expects one. */
export const SKY_DAY = { top: 0x1d4fa8, mid: 0x4a8fd6, horizon: 0xbcd8f0, bottom: 0x16233a, fog: 0x9dc0dd };
/** The void this game's own courses hang in. */
export const SKY_VOID = { top: 0x04061a, mid: 0x123a6e, horizon: 0x35e0c8, bottom: 0x04030c, fog: 0x060a1e };

/* A slow starfield gives the void a parallax that a flat gradient cannot. */
{
  const N = 900, pos = new Float32Array(N * 3);
  let seed = 20260827;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < N; i++) {
    const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 1.4 - 0.4), R = 15000;
    pos[i * 3] = R * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = R * Math.cos(ph);
    pos[i * 3 + 2] = R * Math.sin(ph) * Math.sin(th);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfe4ff, size: 34, sizeAttenuation: true, transparent: true, opacity: 0.75, fog: false }));
  stars.frustumCulled = false;
  scene.add(stars);
}

/* ---------------- lighting ---------------- */
export const hemi = new THREE.HemisphereLight(0x9fd8ff, 0x141033, 0.85); scene.add(hemi);

export const sun = new THREE.DirectionalLight(0xfff0d8, 1.05);
sun.position.set(-1800, 2800, 1200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100; sun.shadow.camera.far = 9000;
sun.shadow.camera.left = -2600; sun.shadow.camera.right = 2600;
sun.shadow.camera.top = 2600; sun.shadow.camera.bottom = -2600;
sun.shadow.bias = -0.0016;
scene.add(sun); scene.add(sun.target);

/* Where the sun sits relative to the player, and how far the ambient reaches.
   A loaded map overrides both from its own light_environment. */
const sunOffset = { x: -1500, y: 2400, z: 1000 };

/** Keep the shadow frustum around the player — a course is far too long to cover at once. */
export function followSun(x, y, z) {
  sun.target.position.set(x, y, z);
  sun.position.set(x + sunOffset.x, y + sunOffset.y, z + sunOffset.z);
  sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
}

/**
 * Point the sun and set the ambient, from a map's own light_environment.
 * `dir` is the direction the light travels, so the sun goes the other way.
 */
export function setEnvironment(o = {}) {
  if (o.dir) {
    const L = Math.hypot(o.dir.x, o.dir.y, o.dir.z) || 1;
    const d = 3000;
    sunOffset.x = -o.dir.x / L * d;
    sunOffset.y = -o.dir.y / L * d;
    sunOffset.z = -o.dir.z / L * d;
    if (sunOffset.y < 600) sunOffset.y = 600;         // never light from underneath
  }
  if (o.sunColor != null) sun.color.setRGB(o.sunColor.r, o.sunColor.g, o.sunColor.b);
  if (o.sunIntensity != null) sun.intensity = o.sunIntensity;
  if (o.ambientColor != null) hemi.color.setRGB(o.ambientColor.r, o.ambientColor.g, o.ambientColor.b);
  if (o.ambientGround != null) hemi.groundColor.setHex(o.ambientGround);
  if (o.ambientIntensity != null) hemi.intensity = o.ambientIntensity;
  if (o.shadows != null) sun.castShadow = o.shadows;
  if (o.shadowSpan != null) {
    const s = o.shadowSpan;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = s * 4;
    sun.shadow.camera.updateProjectionMatrix();
  }
}

export function setFov(deg) { camera.fov = deg; camera.updateProjectionMatrix(); }
