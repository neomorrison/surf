/* Just enough DOM for core.js/world.js to construct. */
const ctx2d = () => new Proxy({ measureText: () => ({ width: 0 }) }, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: () => true,
});
const el = () => ({
  style: {}, appendChild(c) { return c; }, addEventListener() {}, getContext: ctx2d,
  width: 0, height: 0, remove() {}, classList: { add() {}, remove() {}, contains: () => false },
});
globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.document = { getElementById: el, querySelector: el, createElement: el, body: el() };
