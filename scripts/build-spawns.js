/* Build js/data/spawns.json from a Cobblemon `spawn_pool_world` directory.
 *
 * This pack is tuned for COBBLEVERSE, whose spawn rules live in its bundled
 * datapack (not base Cobblemon). Cobbleverse retunes nearly every species and,
 * crucially, adds spawns for legendaries / mythicals / paradox mons — almost all
 * of which have NO natural spawn in base Cobblemon. Point this script at the
 * datapack's spawn_pool_world to regenerate the data:
 *
 *   # From your Cobbleverse instance (CurseForge/Modrinth), the spawns live in:
 *   #   datapacks/COBBLEVERSE-DP-v<N>-CF.zip  ->  data/cobblemon/spawn_pool_world
 *   unzip -oq COBBLEVERSE-DP-v19-CF.zip "data/cobblemon/spawn_pool_world/**" -d /tmp/cv
 *   node scripts/build-spawns.js /tmp/cv/data/cobblemon/spawn_pool_world
 *
 * Falls back to a base-Cobblemon sparse clone if no path is given:
 *   git clone --filter=blob:none --no-checkout --depth 1 \
 *     https://gitlab.com/cable-mc/cobblemon.git /tmp/cobblemon-spawns
 *   cd /tmp/cobblemon-spawns && git sparse-checkout init --cone
 *   git sparse-checkout set common/src/main/resources/data/cobblemon/spawn_pool_world
 *   git checkout
 *
 * Output shape (compact): { "<dex>": [ { b:[biomes], r:rarity, lv:level, w:weight,
 *   pos:positionType, t:timeRange|null, wx:[weather]|null, sky:canSeeSky|null,
 *   px:[presetContext]|null, st:[structures/sites]|null, bo:[boostNotes]|null } ] }
 *
 *   b  = real overworld biomes (chips + reverse biome lookup)
 *   st = named structures / custom spawn sites (how most legendaries are found:
 *        e.g. "articuno tower", "whirl island", "sky pillar", "dyna tree")
 *   bo = weather/moon weight boosts worth hunting around (e.g. "⚡×4 thunder")
 */
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] ||
  "/tmp/cobblemon-spawns/common/src/main/resources/data/cobblemon/spawn_pool_world";

// Presets that describe a meaningful spawn *context* worth showing the player.
const CONTEXT_PRESETS = new Set([
  "ancient_city", "desert_pyramid", "jungle_pyramid", "end_city", "ocean_monument",
  "ocean_ruins", "pillager_outpost", "ruined_portal", "stronghold", "trail_ruins",
  "nether_fossil", "mansion", "lava", "water", "webs", "treetop", "urban",
  "redstone", "salt", "saccharine_tree", "derelict",
]);

function cleanBiome(tag) {
  // Strip leading '#', any 'namespace:' prefix, and an 'is_' tag marker.
  return String(tag)
    .replace(/^#/, "")
    .replace(/^[a-z0-9_.-]+:/, "")
    .replace(/^is_/, "")
    .replace(/_/g, " ")
    .trim();
}
// A named structure ("#minecraft:village") or Cobbleverse custom spawn site
// ("cobbleverse:custom_spawn/articuno_tower") -> a short readable label.
function cleanStructure(tag) {
  const s = String(tag)
    .replace(/^#/, "")
    .replace(/^[a-z0-9_.-]+:/, "")     // drop namespace
    .replace(/^custom_spawn\/?/, "")   // drop the custom_spawn marker
    .replace(/[\/_]/g, " ")
    .trim();
  return s || "special site";
}
function weatherOf(cond) {
  const w = [];
  if (cond.isThundering === true) w.push("thunder");
  else if (cond.isRaining === true) w.push("rain");
  if (cond.isRaining === false) w.push("clear");
  return w.length ? w : null;
}
// Weather / moon-phase weight multipliers are real hunting hints (e.g. a
// legendary that only meaningfully appears during a thunderstorm). Lure-level
// (fishing rod) and time/biome multipliers are skipped as noise.
function boostsOf(sp) {
  const mults = [].concat(
    Array.isArray(sp.weightMultipliers) ? sp.weightMultipliers : [],
    sp.weightMultiplier ? [sp.weightMultiplier] : [],
  );
  const out = [];
  for (const m of mults) {
    const c = m.condition || {};
    const x = m.multiplier;
    if (x == null) continue;
    if (c.isThundering === true) out.push(`⚡×${x} thunder`);
    else if (c.isRaining === true) out.push(`🌧×${x} rain`);
    if (c.moonPhase !== undefined) {
      const ph = Array.isArray(c.moonPhase) ? c.moonPhase.join("/") : c.moonPhase;
      out.push(`🌙×${x} moon ${ph}`);
    }
  }
  return out.length ? [...new Set(out)] : null;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source dir not found: ${SRC}\nSee header comment for how to get the spawn_pool_world.`);
    process.exit(1);
  }
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".json"));
  const out = {};
  let entryCount = 0;

  for (const file of files) {
    const m = file.match(/^(\d+)_/);
    if (!m) continue;
    const dex = Number(m[1]);
    if (dex < 1 || dex > 1025) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8")); }
    catch (_) { continue; }
    if (!data.enabled || !Array.isArray(data.spawns)) continue;

    const rows = [];
    for (const sp of data.spawns) {
      if (sp.type && sp.type !== "pokemon") continue;
      const c = sp.condition || {};

      // Split biome conditions into real biomes vs. named custom spawn sites.
      const biomes = [];
      const sites = [];
      for (const tag of (c.biomes || [])) {
        if (/custom_spawn/.test(tag)) sites.push(cleanStructure(tag));
        else biomes.push(cleanBiome(tag));
      }
      for (const tag of (c.structures || [])) sites.push(cleanStructure(tag));

      const presets = (sp.presets || []).filter((p) => CONTEXT_PRESETS.has(p));
      const row = {
        b: biomes,
        r: sp.bucket || "common",
        lv: sp.level || null,
        w: sp.weight != null ? sp.weight : null,
        pos: sp.spawnablePositionType || null,
        t: c.timeRange || null,
        wx: weatherOf(c),
        sky: c.canSeeSky === undefined ? null : c.canSeeSky,
        px: presets.length ? presets : null,
        st: sites.length ? [...new Set(sites)] : null,
        bo: boostsOf(sp),
      };
      rows.push(row);
      entryCount++;
    }
    if (rows.length) out[dex] = rows;
  }

  const dest = path.join(__dirname, "..", "js", "data", "spawns.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote spawns for ${Object.keys(out).length} species, ${entryCount} entries -> ${dest}`);
}
main();
