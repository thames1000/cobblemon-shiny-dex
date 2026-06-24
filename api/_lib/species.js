/* Resolve a national-dex number from a catch payload, by explicit number or by
 * Cobblemon species name. Static require so Vercel bundles the JSON with the fn. */
const SPECIES = require("../../js/data/species.json");

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

const NAME_TO_DEX = {};
for (const s of SPECIES) NAME_TO_DEX[norm(s.name)] = s.dex;
const VALID_DEX = new Set(SPECIES.map((s) => s.dex));

function resolveDex(body) {
  const direct = Number(body && (body.dex != null ? body.dex : body.dexNumber));
  if (Number.isFinite(direct) && VALID_DEX.has(direct)) return direct;
  const key = norm(body && (body.species || body.displayName));
  const dex = key ? NAME_TO_DEX[key] : undefined;
  return Number.isFinite(dex) ? dex : undefined;
}

module.exports = { resolveDex, norm };
