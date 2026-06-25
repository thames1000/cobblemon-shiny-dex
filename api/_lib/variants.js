/* Resolve a Variants-tab entry from a catch payload's Cobblemon aspects (or its
 * form name). Mirrors the client-side buildVariantLookup()/spawnVariant() in
 * js/app.js so the mod sync and the in-page UI agree on what an aspect maps to.
 * Static require so Vercel bundles the JSON with the function. */
const VARIANTS = require("../../js/data/variants.json");

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function allVariantObjs() {
  return [
    ...Object.values(VARIANTS.regional || {}).flat(),
    ...(VARIANTS.cosmetic || []),
    ...(VARIANTS.unown || []),
    ...(VARIANTS.cobblemon || []),
  ];
}

// dex + "|" + normalized(name or aspect) -> variant. First writer wins, matching
// the client so an aspect shared by two forms resolves the same way both places.
const BY_DEXFORM = {};
for (const v of allVariantObjs()) {
  for (const t of new Set([norm(v.name), ...(v.aspects || []).map(norm)])) {
    if (!t) continue;
    const k = v.dex + "|" + t;
    if (!(k in BY_DEXFORM)) BY_DEXFORM[k] = v;
  }
}

/* Resolve a variant for a known national dex number from the catch body.
 * Tries each aspect, then the form name (and the first half of a compound
 * "A / B" form). Returns the variant object or null. */
function resolveVariant(dex, body) {
  if (!Number.isFinite(dex) || !body) return null;
  const tokens = [];
  if (Array.isArray(body.aspects)) tokens.push(...body.aspects);
  if (body.form) { tokens.push(body.form); tokens.push(String(body.form).split(" / ")[0]); }
  for (const t of tokens) {
    const v = BY_DEXFORM[dex + "|" + norm(t)];
    if (v) return v;
  }
  return null;
}

module.exports = { resolveVariant };
