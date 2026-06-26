/* Helpers for the ShinyDex Link hunt-progress endpoints (sync + fetch).
 *
 * A hunt is identified by `species|form` — the SAME key the mod builds in
 * HuntState.makeKey(): lowercase + trimmed, with a blank form left empty. We do
 * NOT strip underscores/punctuation here (species ids like `mr_mime` must survive),
 * so this deliberately differs from species.js's aggressive `norm`.
 */

function lc(v) {
  return v == null ? "" : String(v).toLowerCase().trim();
}

// `${species}|${form}` — form blank for an any-form hunt. Matches the mod's key.
function huntKey(species, form) {
  return `${lc(species)}|${lc(form)}`;
}

function intOf(v, def = 0) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : def;
}

// Default-aware boolean: the mod sends real booleans, but tolerate strings/0/1 and
// fall back to `def` when the field is absent (so countEncounters defaults true).
function boolOf(v, def) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["true", "1", "yes"].includes(t)) return true;
    if (["false", "0", "no"].includes(t)) return false;
  }
  return def;
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/* Normalize one hunt entry from the mod into the stored/returned shape, or null if
 * it has no species. `total` is recomputed (never negative) so a client can't push
 * an inconsistent total. */
function sanitizeHunt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const species = lc(raw.species);
  if (!species) return null;
  const form = lc(raw.form);
  const encounters = Math.max(0, intOf(raw.encounters));
  const eggs = Math.max(0, intOf(raw.eggs));
  const manual = intOf(raw.manual);
  const total = Math.max(0, encounters + eggs + manual);
  const displayName = strOrNull(raw.displayName) || (species.charAt(0).toUpperCase() + species.slice(1));
  return {
    species,
    form: form || null,
    displayName,
    encounters,
    eggs,
    manual,
    total,
    countEncounters: boolOf(raw.countEncounters, true),
    countEggs: boolOf(raw.countEggs, true),
    startedAt: strOrNull(raw.startedAt),
    updatedAt: strOrNull(raw.updatedAt),
  };
}

module.exports = { lc, huntKey, sanitizeHunt };
