/* Merge the "Legendary Encounters" datapack's wild legendary spawns into
 * js/data/spawns.json, tagged dp:"legendary-encounters" so the site can show a
 * "datapack required" caveat. Idempotent: re-running replaces the previously
 * merged datapack entries.
 *
 * The datapack is a Cobblemon spawn_pool_world pack (files named by species, one
 * ultra-rare biome spawn each). Point this at its spawn_pool_world dir:
 *
 *   unzip -oq ~/Downloads/LegendaryEncounters.zip -d /tmp/legenc
 *   node scripts/build-legendary-encounters.js /tmp/legenc/data/cobblemon/spawn_pool_world
 */
const fs = require("fs");
const path = require("path");

const DP = "legendary-encounters";
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error("Pass the datapack's spawn_pool_world dir. See header."); process.exit(1); }

const CONTEXT_PRESETS = new Set([
  "ancient_city", "desert_pyramid", "jungle_pyramid", "end_city", "ocean_monument",
  "ocean_ruins", "pillager_outpost", "ruined_portal", "stronghold", "trail_ruins",
  "nether_fossil", "mansion", "lava", "water", "webs", "treetop", "urban",
  "redstone", "salt", "saccharine_tree", "derelict",
]);
const cleanBiome = (t) => String(t).replace(/^#/, "").replace(/^[a-z0-9_.-]+:/, "").replace(/^is_/, "").replace(/_/g, " ").trim();

const ROOT = path.join(__dirname, "..");
const species = JSON.parse(fs.readFileSync(path.join(ROOT, "js/data/species.json"), "utf8"));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const dexByNorm = {};
const dexByBase = {}; // first name segment (before "-") -> dex, for form-suffixed names
for (const sp of species) {
  dexByNorm[norm(sp.name)] = sp.dex;
  const base = norm(String(sp.name).split("-")[0]);
  if (!(base in dexByBase)) dexByBase[base] = sp.dex;
}

const spawns = JSON.parse(fs.readFileSync(path.join(ROOT, "js/data/spawns.json"), "utf8"));
// Drop any previously-merged datapack rows so this is idempotent.
let removed = 0;
for (const dex of Object.keys(spawns)) {
  const kept = spawns[dex].filter((e) => e.dp !== DP);
  removed += spawns[dex].length - kept.length;
  if (kept.length) spawns[dex] = kept; else delete spawns[dex];
}

let added = 0, unmatched = [];
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".json"))) {
  let data; try { data = JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8")); } catch (_) { continue; }
  if (!data.enabled || !Array.isArray(data.spawns)) continue;
  for (const sp of data.spawns) {
    if (sp.type && sp.type !== "pokemon") continue;
    const name = String(sp.pokemon || "").replace(/^[a-z0-9_.-]+:/, "").split(/[ _]/).join("");
    const dex = dexByNorm[norm(name)] || dexByBase[norm(name)];
    if (!dex) { unmatched.push(sp.pokemon); continue; }
    const c = sp.condition || {};
    const biomes = (c.biomes || []).filter((t) => !/not[_\s-]?spawn/i.test(t)).map(cleanBiome).filter(Boolean);
    const presets = (sp.presets || []).filter((p) => CONTEXT_PRESETS.has(p));
    if (!biomes.length && !presets.length) continue;
    const row = {
      b: biomes,
      r: sp.bucket || "ultra-rare",
      lv: sp.level || null,
      w: sp.weight != null ? sp.weight : null,
      pos: sp.context && sp.context !== "grounded" ? sp.context : null,
      t: c.timeRange || null,
      wx: c.weather ? [c.weather] : null,
      sky: c.canSeeSky === undefined ? null : c.canSeeSky,
      px: presets.length ? presets : null,
      st: null,
      bo: null,
      dp: DP,
    };
    (spawns[dex] = spawns[dex] || []).push(row);
    added++;
  }
}

fs.writeFileSync(path.join(ROOT, "js/data/spawns.json"), JSON.stringify(spawns));
console.log(`Removed ${removed} old datapack rows; added ${added} legendary spawns.`);
if (unmatched.length) console.log("UNMATCHED species:", unmatched);
