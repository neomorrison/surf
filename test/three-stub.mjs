/* Minimal THREE stand-in: enough for core.js / world.js / map.js to build the
   collision world headlessly. Geometry is not simulated — the map test only
   cares about the physics volumes and the ROUTE those builders emit. */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V3(this.x, this.y, this.z); }
}
class Euler extends V3 { }
class Color { constructor(c) { this.c = c >>> 0; } getHexString() { return (this.c >>> 0).toString(16).padStart(6, '0'); } }
class Obj3D {
  constructor() { this.position = new V3(); this.rotation = new Euler(); this.scale = new V3(1, 1, 1); this.children = []; this.visible = true; }
  add(...o) { for (const c of o) if (c) this.children.push(c); return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse ? c.traverse(fn) : fn(c); }
  updateMatrixWorld() {}
  lookAt() {}
}
const attr = () => ({ count: 0, getX: () => 0, getY: () => 0, getZ: () => 0, setX: () => {}, setY: () => {}, setZ: () => {}, needsUpdate: false });
class Geometry {
  constructor() { this.attributes = { position: attr(), uv: attr() }; }
  setAttribute(name, a) { this.attributes[name] = a; return this; }
  toNonIndexed() { return this; }
  computeVertexNormals() {}
  dispose() {}
}
class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; this.needsUpdate = false; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setX(i, v) { this.array[i * this.itemSize] = v; }
  setY(i, v) { this.array[i * this.itemSize + 1] = v; }
  setZ(i, v) { this.array[i * this.itemSize + 2] = v; }
}
class Material { constructor(o = {}) { Object.assign(this, o); } dispose() {} }
class Light extends Obj3D { constructor(...a) { super(); this.args = a; this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0 }; this.target = new Obj3D(); } }

const three = {
  Scene: class extends Obj3D { }, Group: class extends Obj3D { }, Mesh: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  LineSegments: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Line: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Points: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  GridHelper: class extends Obj3D { constructor() { super(); this.material = new Material({ transparent: false }); } },
  PerspectiveCamera: class extends Obj3D { constructor(f) { super(); this.fov = f; } updateProjectionMatrix() {} },
  WebGLRenderer: class { constructor() { this.domElement = { addEventListener() {}, requestPointerLock() {}, style: {} }; this.shadowMap = {}; } setSize() {} setPixelRatio() {} render() {} },
  BoxGeometry: Geometry, SphereGeometry: Geometry, PlaneGeometry: Geometry, EdgesGeometry: Geometry, BufferGeometry: Geometry,
  CylinderGeometry: Geometry, CapsuleGeometry: Geometry,
  MeshStandardMaterial: Material, MeshBasicMaterial: Material, LineBasicMaterial: Material, ShaderMaterial: Material,
  PointsMaterial: Material, BufferAttribute,
  CanvasTexture: class { constructor() { this.needsUpdate = false; this.wrapS = 0; this.wrapT = 0; this.anisotropy = 1; } },
  RepeatWrapping: 1000,
  HemisphereLight: Light, DirectionalLight: Light, PointLight: Light,
  Vector3: V3, Color, Fog: class { constructor(c, n, f) { Object.assign(this, { c, n, f }); } },
  DoubleSide: 2, BackSide: 1, FrontSide: 0, PCFSoftShadowMap: 2,
  MathUtils: { clamp: (v, a, b) => v < a ? a : v > b ? b : v },
};
export default three;
export const {
  Scene, Group, Mesh, LineSegments, Line, Points, GridHelper, PerspectiveCamera, WebGLRenderer,
  BoxGeometry, SphereGeometry, PlaneGeometry, EdgesGeometry, BufferGeometry, CylinderGeometry,
  MeshStandardMaterial, MeshBasicMaterial, LineBasicMaterial, ShaderMaterial, PointsMaterial,
  CanvasTexture, HemisphereLight, DirectionalLight, PointLight, Fog, RepeatWrapping,
  DoubleSide, BackSide, FrontSide, PCFSoftShadowMap, MathUtils,
} = three;
export { BufferAttribute };
export { V3 as Vector3, Color };
