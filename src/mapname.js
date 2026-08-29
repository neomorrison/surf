/* ============================== [MAP NAME] ==============================
   Display names.

   A map's real name is its file's — surf_aircontrol_ksf. That is what a
   server calls it, what the .bsp on disk is called, and what a personal best
   is filed under, so ids, urls and the store all keep it exactly. The picker
   is the one place that does not need it: a card wants a name you can read at
   a glance, so this is where "surf_aircontrol_ksf" becomes "Surf AirCtrl".

   Nothing here changes what a map *is*. It only changes what it is called
   on screen.                                                              */

/** Words a raw name spells out in full, and the short form we show instead. */
const SHORT = {
  aircontrol: "AirCtrl",
  airaccelerate: "AirAccel",
  beginner: "Beginner",
  cyberwave: "Cyberwave",
  utopia: "Utopia",
  kitsune: "Kitsune",
  rooftops: "Rooftops",
  nightmare: "Nightmare",
  skyworld: "Skyworld",
};

/** Read as letters, not as a word: surf_utopia_njv is "utopia en-jay-vee". */
const ACRONYMS = new Set(["ksf", "njv", "sk", "fc", "hsw", "xc", "wl", "og"]);

/**
 * Tags that belong to the file rather than to the map: who made it, which
 * revision it is, which game it was cut for. Dropped from the display name —
 * `mapTag` hands them back when two maps need telling apart.
 */
const TAGS = new Set([
  "ksf", "njv", "sk", "fc", "hsw", "xc", "wl", "og",
  "fix", "fixed", "final", "beta", "rc", "go", "csgo", "css", "cs2", "reboot", "remake",
]);

const words = raw => String(raw)
  .replace(/\.bsp$/i, "")
  .split(/[_\-.\s]+/)
  .filter(Boolean);

const cap = w => w.charAt(0).toUpperCase() + w.slice(1);

/** One word of a raw name, as it should read on a card. */
function word(w) {
  const k = w.toLowerCase();
  if (SHORT[k]) return SHORT[k];
  if (ACRONYMS.has(k)) return k.toUpperCase();
  if (/^\d+$/.test(k)) return k;                      // a revision number stays a number
  if (/^v\d+$/i.test(k)) return k.toUpperCase();      // v2 -> V2
  return cap(k);
}

/**
 * The name a map goes by on screen.
 *
 * Takes anything a raw name arrives as — a meta name, a dropped file name,
 * a store key — and drops the parts that are file-keeping rather than map:
 * the .bsp, the underscores, the author tag on the end.
 */
export function prettyMapName(raw) {
  const parts = words(raw);
  if (!parts.length) return String(raw || "");
  // Trailing tags only: surf_mesa_fixed is "Surf Mesa", but surf_fix_arena
  // keeps its "fix" because the map is called that.
  while (parts.length > 1 && TAGS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts.map(word).join(" ");
}

/** The tag `prettyMapName` dropped, if there was one — "KSF", or "". */
export function mapTag(raw) {
  const parts = words(raw);
  const out = [];
  while (parts.length > 1 && TAGS.has(parts[parts.length - 1].toLowerCase())) out.unshift(word(parts.pop()));
  return out.join(" ");
}

/**
 * A display name no other map in `taken` is already using.
 *
 * Two maps can shorten to the same thing — the built-in surf_aircontrol and
 * SnoopSh's surf_aircontrol_ksf both want to be "Surf AirCtrl". The one whose
 * raw name carries a tag gives it back, since it is the only one of the two
 * with anything left to tell them apart with.
 */
export function uniqueMapName(raw, taken = []) {
  const used = new Set(taken);
  const base = prettyMapName(raw);
  if (!used.has(base)) return base;
  const tag = mapTag(raw);
  if (tag && !used.has(`${base} ${tag}`)) return `${base} ${tag}`;
  for (let i = 2; ; i++) if (!used.has(`${base} (${i})`)) return `${base} (${i})`;
}
